import type { EvaluateFreeTierInput, NormalizedResource } from "./types.js";
import type { DenyListViolation } from "./deny-list.js";
import { policy } from "./policy.js";

function num(resource: NormalizedResource, key: string): number | undefined {
  const value = resource.attributes[key];
  return typeof value === "number" ? value : undefined;
}

export function calculateTotalEbsGb(resources: NormalizedResource[]): number {
  return resources.reduce((sum, r) => {
    if (r.type === "aws_ebs_volume") return sum + (num(r, "size") ?? 0);
    if (r.type === "aws_instance") {
      const rootBlock = r.attributes.root_block_device as { volume_size?: number } | undefined;
      return sum + (rootBlock?.volume_size ?? 0);
    }
    return sum;
  }, 0);
}

/**
 * Checks that need more than a single resource's static attributes to
 * evaluate -- aggregate sizes, cross-account state, and lookups against the
 * live Free-Tier-eligible instance type list. Same violation shape as
 * `checkDenyList` so callers can treat both lists uniformly.
 */
export function checkStructural(
  resources: NormalizedResource[],
  input: Pick<EvaluateFreeTierInput, "existingAlwaysOnEc2Count" | "eligibleInstanceTypes">,
): DenyListViolation[] {
  const violations: DenyListViolation[] = [];

  const totalEbsGb = calculateTotalEbsGb(resources);
  if (totalEbsGb > policy.limits.ebsMaxTotalGb) {
    violations.push({
      code: "ebs_total_exceeds_limit",
      resourceType: "aws_ebs_volume",
      resourceName: "(total across plan)",
      reason: `Total EBS size ${totalEbsGb} GB exceeds the ${policy.limits.ebsMaxTotalGb} GB Free Tier limit.`,
    });
  }

  for (const resource of resources.filter((r) => r.type === "aws_db_instance")) {
    const storageGb = num(resource, "allocated_storage") ?? 0;
    if (storageGb > policy.limits.rdsMaxStorageGb) {
      violations.push({
        code: "rds_storage_exceeds_limit",
        resourceType: resource.type,
        resourceName: resource.name,
        reason: `RDS storage ${storageGb} GB exceeds the ${policy.limits.rdsMaxStorageGb} GB Free Tier limit.`,
      });
    }
  }

  for (const resource of resources.filter((r) => r.type === "aws_cloudwatch_log_group")) {
    const retention = resource.attributes.retention_in_days;
    if (retention === undefined || retention === null || retention === 0) {
      violations.push({
        code: "log_group_missing_retention",
        resourceType: resource.type,
        resourceName: resource.name,
        reason: `CloudWatch log group has no retention policy; must set retention_in_days (recommended: ${policy.limits.logRetentionDaysRequired}) to avoid unbounded log storage costs.`,
      });
    }
  }

  if (input.eligibleInstanceTypes) {
    for (const resource of resources.filter((r) => r.type === "aws_instance")) {
      const instanceType = resource.attributes.instance_type;
      if (typeof instanceType === "string" && !input.eligibleInstanceTypes.includes(instanceType)) {
        violations.push({
          code: "instance_type_not_free_tier_eligible",
          resourceType: resource.type,
          resourceName: resource.name,
          reason: `Instance type ${instanceType} is not in this account/region's Free-Tier-eligible list.`,
        });
      }
    }
  }

  const ec2InstanceCount = resources.filter((r) => r.type === "aws_instance").length;
  const totalAlwaysOnEc2 = ec2InstanceCount + (input.existingAlwaysOnEc2Count ?? 0);
  if (totalAlwaysOnEc2 > policy.limits.maxAlwaysOnEc2PerAwsAccount) {
    violations.push({
      code: "too_many_always_on_ec2_for_account",
      resourceType: "aws_instance",
      resourceName: "(across this AWS account)",
      reason: `This plan would bring the AWS account's always-on EC2 count to ${totalAlwaysOnEc2}, exceeding the shared limit of ${policy.limits.maxAlwaysOnEc2PerAwsAccount} (the 750 free hours/month are shared across the whole account, not per deployment).`,
    });
  }

  return violations;
}
