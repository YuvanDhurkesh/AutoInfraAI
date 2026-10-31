import { describe, expect, it } from "vitest";
import { evaluateFreeTier } from "@autoinfra/free-tier-policy";
import { checkStaticTerraform } from "./static-checks.js";
import { checkPlanSecurity } from "./plan-checks.js";
import { planToResources } from "./to-resources.js";
import { summarizePlan } from "./summary.js";
import type { PlanJson, ResourceChange } from "./plan-json.js";

const ctx = {
  region: "ap-south-1",
  tags: {
    "autoinfra:deployment-id": "dep-1",
    "autoinfra:owner": "user-1",
    "autoinfra:managed-by": "autoinfra",
    "autoinfra:free-tier": "true",
  },
};

function rc(
  type: string,
  name: string,
  after: Record<string, unknown>,
  extra: Partial<ResourceChange> = {},
): ResourceChange {
  return {
    address: `${type}.${name}`,
    mode: "managed",
    type,
    name,
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions: ["create"], before: null, after: { tags_all: ctx.tags, ...after } },
    ...extra,
  };
}

function plan(resources: ResourceChange[], overrides: Partial<PlanJson> = {}): PlanJson {
  return {
    variables: { region: { value: "ap-south-1" } },
    configuration: {
      provider_config: {
        aws: { name: "aws", expressions: { region: { references: ["var.region"] } } },
      },
    },
    resource_changes: resources,
    ...overrides,
  };
}

const lockedBucket = [
  rc("aws_s3_bucket", "site", {}),
  rc("aws_s3_bucket_public_access_block", "site", {
    block_public_acls: true,
    block_public_policy: true,
    ignore_public_acls: true,
    restrict_public_buckets: true,
  }),
];

describe("static pre-flight checks", () => {
  const tf = (content: string) => [{ path: "main.tf", content }];

  it("passes ordinary resources", () => {
    expect(
      checkStaticTerraform(
        tf(
          `terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.69" }\n  }\n}\nresource "aws_lambda_function" "api" {\n  filename = "\${path.module}/bootstrap/placeholder.zip"\n  source_code_hash = filebase64sha256("\${path.module}/bootstrap/placeholder.zip")\n}`,
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'resource "aws_instance" "x" {\n  provisioner "local-exec" { command = "curl evil" }\n}',
      "provisioner",
    ],
    ['data "external" "x" { program = ["sh"] }', "external"],
    ['data "http" "x" { url = "http://169.254.169.254" }', "http"],
    ['resource "null_resource" "x" {}', "null_resource"],
    ['module "vpc" { source = "terraform-aws-modules/vpc/aws" }', "module"],
    ['terraform {\n  backend "local" {}\n}', "backend"],
    ['locals { x = file("/etc/passwd") }', "file()"],
    ['locals { x = file("${path.module}/../../.env") }', "file()"],
    [
      'terraform {\n  required_providers {\n    evil = { source = "someone/evil" }\n  }\n}',
      "someone/evil",
    ],
  ])("rejects %s", (content, expected) => {
    const errors = checkStaticTerraform(tf(content));
    expect(errors.some((e) => e.includes(expected))).toBe(true);
  });

  it("ignores banned words inside comments", () => {
    expect(
      checkStaticTerraform(
        tf('# do not use provisioner "local-exec" here\nresource "aws_s3_bucket" "b" {}'),
      ),
    ).toEqual([]);
  });
});

describe("plan security policy", () => {
  it("passes a compliant plan", () => {
    expect(checkPlanSecurity(plan(lockedBucket), ctx).errors).toEqual([]);
  });

  it("rejects wildcard IAM", () => {
    const p = plan([
      rc("aws_iam_role_policy", "p", {
        policy: JSON.stringify({ Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] }),
      }),
    ]);
    expect(checkPlanSecurity(p, ctx).errors.join()).toContain('Action "*"');
  });

  it("rejects a service-wide wildcard on all resources but allows a scoped one", () => {
    const wide = plan([
      rc("aws_iam_role_policy", "p", {
        policy: JSON.stringify({
          Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: "*" }],
        }),
      }),
    ]);
    const scoped = plan([
      rc("aws_iam_role_policy", "p", {
        policy: JSON.stringify({
          Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::b/*" }],
        }),
      }),
    ]);
    expect(checkPlanSecurity(wide, ctx).errors.length).toBe(1);
    expect(checkPlanSecurity(scoped, ctx).errors).toEqual([]);
  });

  it("rejects IAM users, access keys, and AdministratorAccess", () => {
    const p = plan([
      rc("aws_iam_user", "u", {}),
      rc("aws_iam_access_key", "k", {}),
      rc("aws_iam_role_policy_attachment", "a", {
        policy_arn: "arn:aws:iam::aws:policy/AdministratorAccess",
      }),
    ]);
    expect(checkPlanSecurity(p, ctx).errors).toHaveLength(3);
  });

  it("rejects a public bucket: missing access block, public ACL, public policy", () => {
    const p = plan([
      rc("aws_s3_bucket", "b", {}),
      rc("aws_s3_bucket_acl", "b", { acl: "public-read" }),
      rc("aws_s3_bucket_policy", "b", {
        policy: JSON.stringify({
          Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }],
        }),
      }),
    ]);
    const errors = checkPlanSecurity(p, ctx).errors.join("\n");
    expect(errors).toContain("public access block");
    expect(errors).toContain("public-read");
    expect(errors).toContain("public principal");
  });

  it("allows a CloudFront OAC bucket policy (service principal with a SourceArn condition)", () => {
    const p = plan([
      ...lockedBucket,
      rc("aws_s3_bucket_policy", "site", {
        policy: JSON.stringify({
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Condition: {
                StringEquals: { "AWS:SourceArn": "arn:aws:cloudfront::1:distribution/X" },
              },
            },
          ],
        }),
      }),
    ]);
    expect(checkPlanSecurity(p, ctx).errors).toEqual([]);
  });

  it("rejects ingress open to 0.0.0.0/0", () => {
    const p = plan([
      rc("aws_security_group", "sg", {
        ingress: [{ from_port: 22, to_port: 22, cidr_blocks: ["0.0.0.0/0"] }],
      }),
      rc("aws_vpc_security_group_ingress_rule", "r", { cidr_ipv4: "0.0.0.0/0" }),
    ]);
    expect(checkPlanSecurity(p, ctx).errors).toHaveLength(2);
  });

  it("rejects missing required tags, wrong region, other providers, and aliases", () => {
    const p = plan([rc("aws_s3_bucket", "b", { tags_all: { Name: "x" } }), lockedBucket[1]!], {
      variables: { region: { value: "us-east-1" } },
      configuration: {
        provider_config: {
          aws: { name: "aws", expressions: { region: { references: ["var.region"] } } },
          "aws.east": {
            name: "aws",
            alias: "east",
            expressions: { region: { constant_value: "us-east-1" } },
          },
        },
      },
    });
    p.resource_changes!.push({
      ...rc("google_storage_bucket", "g", {}),
      provider_name: "registry.terraform.io/hashicorp/google",
    });
    const errors = checkPlanSecurity(p, ctx).errors.join("\n");
    expect(errors).toContain("autoinfra:deployment-id");
    expect(errors).toContain("region must be ap-south-1");
    expect(errors).toContain("aliased");
    expect(errors).toContain("hashicorp/google");
  });
});

describe("plan security policy: per-resource region and Function URL auth", () => {
  it("rejects a resource that overrides its region", () => {
    const p = plan([...lockedBucket, rc("aws_dynamodb_table", "t", { region: "us-east-1" })]);
    expect(checkPlanSecurity(p, ctx).errors.join()).toContain("region us-east-1");
  });

  it("enforces the platform-decided Function URL auth type", () => {
    const p = plan([rc("aws_lambda_function_url", "api", { authorization_type: "NONE" })]);
    expect(checkPlanSecurity(p, { ...ctx, functionUrlAuth: "AWS_IAM" }).errors.join()).toContain(
      "AWS_IAM",
    );
    expect(checkPlanSecurity(p, { ...ctx, functionUrlAuth: "NONE" }).errors).toEqual([]);
  });
});

describe("plan -> Free Tier evaluator", () => {
  it("treats an EIP whose instance is unknown at plan time as attached", () => {
    const p = plan([
      {
        ...rc("aws_eip", "ip", {}),
        change: {
          actions: ["create"],
          before: null,
          after: { tags_all: ctx.tags },
          after_unknown: { instance: true },
        },
      },
    ]);
    const report = evaluateFreeTier({
      plan: { resources: planToResources(p) },
      freeTierMode: "strict",
    });
    expect(report.denyListViolations).toEqual([]);
  });

  it("unwraps root_block_device so oversized root volumes are caught", () => {
    const p = plan([
      rc("aws_instance", "app", {
        instance_type: "t3.micro",
        root_block_device: [{ volume_size: 100 }],
      }),
    ]);
    const report = evaluateFreeTier({
      plan: { resources: planToResources(p) },
      freeTierMode: "strict",
      eligibleInstanceTypes: ["t3.micro"],
    });
    expect(report.denyListViolations.join()).toContain("ebs_total_exceeds_limit");
  });

  it("summarizes actions and flags data-bearing replacements", () => {
    const p = plan([
      rc("aws_s3_bucket", "site", {}),
      {
        ...rc("aws_db_instance", "db", {}),
        change: { actions: ["delete", "create"], before: {}, after: {} },
      },
    ]);
    const summary = summarizePlan(p);
    expect(summary.adds).toBe(1);
    expect(summary.replaces).toBe(1);
    expect(summary.dataBearingDestroys).toEqual(["aws_db_instance.db"]);
  });
});
