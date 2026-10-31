import { describe, expect, it } from "vitest";
import { evaluateFreeTier } from "./evaluator.js";
import type { NormalizedResource } from "./types.js";

function plan(resources: NormalizedResource[]) {
  return { resources };
}

function resource(
  type: string,
  name: string,
  attributes: Record<string, unknown> = {},
): NormalizedResource {
  return { type, name, attributes };
}

const ELIGIBLE_TYPES = ["t3.micro", "t4g.micro"];

describe("evaluateFreeTier -- deny-list rejections (Sec. 12 test matrix)", () => {
  it("rejects a NAT Gateway", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_nat_gateway", "nat")]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("nat_gateway"))).toBe(true);
  });

  it("rejects ECS Fargate", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_ecs_service", "svc", { launch_type: "FARGATE" })]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("ecs_fargate"))).toBe(true);
  });

  it("rejects an Application Load Balancer", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_lb", "web", { load_balancer_type: "application" })]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("load_balancer"))).toBe(true);
  });

  it("rejects Multi-AZ RDS", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_db_instance", "db", { multi_az: true, allocated_storage: 20 })]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("rds_multi_az"))).toBe(true);
  });

  it("rejects an oversized/non-eligible instance type", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_instance", "web", { instance_type: "m5.large" })]),
      freeTierMode: "strict",
      eligibleInstanceTypes: ELIGIBLE_TYPES,
    });
    expect(report.fit).toBe("exceeds");
    expect(
      report.denyListViolations.some((v) => v.includes("instance_type_not_free_tier_eligible")),
    ).toBe(true);
  });

  it("rejects a second always-on EC2 instance on the same AWS account", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_instance", "web", { instance_type: "t3.micro" })]),
      freeTierMode: "strict",
      eligibleInstanceTypes: ELIGIBLE_TYPES,
      existingAlwaysOnEc2Count: 1,
    });
    expect(report.fit).toBe("exceeds");
    expect(
      report.denyListViolations.some((v) => v.includes("too_many_always_on_ec2_for_account")),
    ).toBe(true);
  });

  it("rejects 100 GB of EBS", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_ebs_volume", "data", { size: 100 })]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("ebs_total_exceeds_limit"))).toBe(true);
  });

  it("rejects a CloudWatch log group with no retention policy", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_cloudwatch_log_group", "app", {})]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("log_group_missing_retention"))).toBe(
      true,
    );
  });

  it("rejects Secrets Manager", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_secretsmanager_secret", "db-password", {})]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("exceeds");
    expect(report.denyListViolations.some((v) => v.includes("secrets_manager"))).toBe(true);
  });
});

describe("evaluateFreeTier -- compliant plans pass", () => {
  it("accepts a compliant F1 (serverless) plan", () => {
    const report = evaluateFreeTier({
      plan: plan([
        resource("aws_s3_bucket", "frontend"),
        resource("aws_cloudfront_distribution", "cdn"),
        resource("aws_lambda_function", "api", { runtime: "nodejs22.x" }),
        resource("aws_lambda_function_url", "api_url"),
        resource("aws_dynamodb_table", "data", { billing_mode: "PAY_PER_REQUEST" }),
        resource("aws_ssm_parameter", "db_url", { type: "SecureString" }),
        resource("aws_iam_role", "lambda_exec"),
        resource("aws_cloudwatch_log_group", "api_logs", { retention_in_days: 7 }),
      ]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("within_limits");
    expect(report.denyListViolations).toEqual([]);
    expect(report.resources.every((r) => r.eligible)).toBe(true);
  });

  it("accepts a compliant F2 (single EC2) plan", () => {
    const report = evaluateFreeTier({
      plan: plan([
        resource("aws_instance", "app", { instance_type: "t3.micro" }),
        resource("aws_ebs_volume", "data", { size: 20 }),
        resource("aws_security_group", "app_sg"),
        resource("aws_eip", "app_ip", { instance: "placeholder" }),
        resource("aws_s3_bucket", "frontend"),
        resource("aws_cloudfront_distribution", "cdn"),
        resource("aws_iam_role", "instance_role"),
        resource("aws_cloudwatch_log_group", "app_logs", { retention_in_days: 7 }),
      ]),
      freeTierMode: "strict",
      eligibleInstanceTypes: ELIGIBLE_TYPES,
    });
    expect(report.fit).toBe("within_limits");
    expect(report.denyListViolations).toEqual([]);
  });

  it("accepts a compliant F3 (static-only) plan", () => {
    const report = evaluateFreeTier({
      plan: plan([
        resource("aws_s3_bucket", "site"),
        resource("aws_cloudfront_distribution", "cdn"),
      ]),
      freeTierMode: "strict",
    });
    expect(report.fit).toBe("within_limits");
    expect(report.denyListViolations).toEqual([]);
  });

  it("flags near_limit when EC2 usage is close to the shared account cap without exceeding it", () => {
    const report = evaluateFreeTier({
      plan: plan([resource("aws_s3_bucket", "site")]),
      freeTierMode: "strict",
      existingAlwaysOnEc2Count: 1,
    });
    expect(report.fit).toBe("near_limit");
  });
});

describe("evaluateFreeTier -- mode independence", () => {
  it("reports the same violations regardless of freeTierMode (gating is the caller's job)", () => {
    const resources = [resource("aws_nat_gateway", "nat")];
    const strict = evaluateFreeTier({ plan: plan(resources), freeTierMode: "strict" });
    const flexible = evaluateFreeTier({ plan: plan(resources), freeTierMode: "flexible" });
    expect(strict.denyListViolations).toEqual(flexible.denyListViolations);
    expect(strict.fit).toBe(flexible.fit);
  });
});
