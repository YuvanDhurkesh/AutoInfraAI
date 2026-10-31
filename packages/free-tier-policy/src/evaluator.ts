import type { FreeTierReport } from "@autoinfra/shared";
import type { EvaluateFreeTierInput, NormalizedResource } from "./types.js";
import { checkDenyList, type DenyListViolation } from "./deny-list.js";
import { checkStructural } from "./structural-checks.js";
import { projectUsage } from "./usage-projection.js";
import { policy } from "./policy.js";

const SERVICE_BY_RESOURCE_PREFIX: Record<string, string> = {
  aws_instance: "ec2",
  aws_ebs_volume: "ec2",
  aws_eip: "ec2",
  aws_vpc: "vpc",
  aws_subnet: "vpc",
  aws_security_group: "vpc",
  aws_s3_bucket: "s3",
  aws_cloudfront_distribution: "cloudfront",
  aws_lambda_function: "lambda",
  aws_lambda_function_url: "lambda",
  aws_dynamodb_table: "dynamodb",
  aws_db_instance: "rds",
  aws_iam_role: "iam",
  aws_ssm_parameter: "ssm",
  aws_ecr_repository: "ecr",
  aws_codebuild_project: "codebuild",
  aws_cloudwatch_log_group: "cloudwatch-logs",
};

function serviceFor(resourceType: string): string {
  return SERVICE_BY_RESOURCE_PREFIX[resourceType] ?? resourceType.replace(/^aws_/, "");
}

function formatViolation(v: DenyListViolation): string {
  return `${v.resourceType} "${v.resourceName}": ${v.reason} [${v.code}]`;
}

function describeResources(
  resources: NormalizedResource[],
  violations: DenyListViolation[],
): FreeTierReport["resources"] {
  const violatedNames = new Set(violations.map((v) => `${v.resourceType}:${v.resourceName}`));
  return resources.map((r) => {
    const eligible = !violatedNames.has(`${r.type}:${r.name}`);
    const ownViolations = violations.filter(
      (v) => v.resourceType === r.type && v.resourceName === r.name,
    );
    return {
      service: serviceFor(r.type),
      resource: `${r.type}.${r.name}`,
      eligible,
      notes: eligible ? "No Free Tier issues found." : ownViolations.map((v) => v.reason).join(" "),
    };
  });
}

/**
 * Computes the authoritative Free Tier assessment for a set of Terraform
 * resources (Sec. 2.4). This is mode-aware only for the `fit` field's
 * practical meaning, never for what counts as a violation -- `strict` vs
 * `flexible` is about what the *pipeline* does with an "exceeds" result
 * (reject outright vs. show a cost-labelled confirmation), not about
 * changing the facts this function reports. The LLM's own Free Tier
 * assessment is never consulted here; this is the independent check the
 * brief requires.
 */
export function evaluateFreeTier(input: EvaluateFreeTierInput): FreeTierReport {
  const resources = input.plan.resources;
  const denyViolations = checkDenyList(resources);
  const structuralViolations = checkStructural(resources, {
    existingAlwaysOnEc2Count: input.existingAlwaysOnEc2Count,
    eligibleInstanceTypes: input.eligibleInstanceTypes,
  });
  const allViolations = [...denyViolations, ...structuralViolations];

  const usage = projectUsage(resources);
  const warnings: string[] = [];

  if (
    usage.ec2Hours > 0 &&
    usage.ec2Hours + (input.existingAlwaysOnEc2Count ?? 0) * 730 >=
      policy.regimes.legacy_12mo.ec2.hoursPerMonth * policy.limits.maxAlwaysOnEc2PerAwsAccount
  ) {
    warnings.push(
      `Projected EC2 hours (${usage.ec2Hours}/mo) are at or near the shared ${policy.regimes.legacy_12mo.ec2.hoursPerMonth}hr/mo Free Tier allowance for this AWS account.`,
    );
  }
  if (
    usage.ebsGb > policy.limits.ebsMaxTotalGb * 0.8 &&
    usage.ebsGb <= policy.limits.ebsMaxTotalGb
  ) {
    warnings.push(
      `EBS usage (${usage.ebsGb} GB) is close to the ${policy.limits.ebsMaxTotalGb} GB limit.`,
    );
  }
  warnings.push(
    "Traffic-dependent usage (Lambda invocations, S3/CloudFront requests, log volume) can't be projected from the Terraform plan alone and is shown as 0 here -- actual usage is tracked post-deployment via the AWS Free Tier API and the free-tier ledger.",
  );

  const exceeds = allViolations.length > 0;
  const nearLimit =
    !exceeds &&
    (usage.ebsGb > policy.limits.ebsMaxTotalGb * 0.8 ||
      usage.rdsStorageGb > policy.limits.rdsMaxStorageGb * 0.8 ||
      (input.existingAlwaysOnEc2Count ?? 0) >= policy.limits.maxAlwaysOnEc2PerAwsAccount);

  return {
    fit: exceeds ? "exceeds" : nearLimit ? "near_limit" : "within_limits",
    resources: describeResources(resources, allViolations),
    usage,
    warnings,
    denyListViolations: allViolations.map(formatViolation),
    // Cost estimation isn't modeled yet -- a strict-compliant plan is $0 by
    // construction (every allowed resource is Free-Tier-eligible), and a
    // non-compliant plan's actual cost depends on usage this function can't
    // see. Revisit once real billing/Cost Explorer data is available.
    estimatedMonthlyCostUsd: 0,
  };
}
