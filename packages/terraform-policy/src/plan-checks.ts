import {
  ALLOWED_PROVIDERS,
  REQUIRED_TAG_KEYS,
  type PlanJson,
  type ResourceChange,
} from "./plan-json.js";

export interface SecurityPolicyContext {
  region: string;
  tags: Record<(typeof REQUIRED_TAG_KEYS)[number], string>;
  /** F1 only: decided by the platform from the scan, never by the model. */
  functionUrlAuth?: "AWS_IAM" | "NONE";
}

const BANNED_RESOURCE_TYPES: Record<string, string> = {
  aws_iam_user: "IAM users are not allowed",
  aws_iam_access_key: "IAM access keys are not allowed",
  aws_iam_user_policy: "IAM user policies are not allowed",
  aws_iam_user_policy_attachment: "IAM user policies are not allowed",
  aws_iam_user_login_profile: "IAM console logins are not allowed",
  aws_iam_group: "IAM groups are not allowed",
  aws_s3_bucket_website_configuration:
    "S3 website hosting is not allowed; serve the private bucket through CloudFront OAC",
};

const DANGEROUS_MANAGED_POLICIES = /:policy\/(AdministratorAccess|PowerUserAccess|IAMFullAccess)$/;

function isLive(rc: ResourceChange): boolean {
  return (
    rc.mode === "managed" && !(rc.change.actions.length === 1 && rc.change.actions[0] === "delete")
  );
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function checkPolicyDocument(address: string, raw: unknown, errors: string[]) {
  if (typeof raw !== "string" || raw.length === 0) return;
  let doc: { Statement?: unknown };
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  for (const stmt of asArray(
    doc.Statement as Record<string, unknown> | Record<string, unknown>[],
  )) {
    if (stmt.Effect !== "Allow") continue;
    if (stmt.NotAction !== undefined) {
      errors.push(`${address}: IAM "Allow" with NotAction is not allowed`);
      continue;
    }
    const actions = asArray(stmt.Action as string | string[]);
    const resources = asArray(stmt.Resource as string | string[]);
    if (actions.some((a) => a === "*" || a === "*:*")) {
      errors.push(`${address}: IAM policy grants Action "*"`);
    } else if (actions.some((a) => /^[a-z0-9-]+:\*$/i.test(a)) && resources.includes("*")) {
      errors.push(
        `${address}: IAM policy grants a service-wide wildcard (e.g. "s3:*") on Resource "*"`,
      );
    }
  }
}

function principalIsPublic(principal: unknown): boolean {
  if (principal === "*") return true;
  if (principal && typeof principal === "object") {
    const aws = (principal as Record<string, unknown>).AWS;
    return asArray(aws as string | string[]).includes("*");
  }
  return false;
}

/** Sec. 5 Step 4 security policy, applied to `terraform show -json` output. */
export function checkPlanSecurity(
  plan: PlanJson,
  ctx: SecurityPolicyContext,
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const live = (plan.resource_changes ?? []).filter(isLive);

  for (const rc of plan.resource_changes ?? []) {
    if (!ALLOWED_PROVIDERS.includes(rc.provider_name)) {
      errors.push(
        `${rc.address}: provider ${rc.provider_name} is not allowed (only aws and random)`,
      );
    }
    if (rc.mode === "data" && rc.type === "external")
      errors.push(`${rc.address}: external data source is not allowed`);
  }

  const providers = plan.configuration?.provider_config ?? {};
  for (const [key, cfg] of Object.entries(providers)) {
    if (cfg.name !== "aws" && cfg.name !== "random")
      errors.push(`provider "${key}" is not allowed`);
    if (cfg.name === "aws") {
      if (cfg.alias)
        errors.push(`aliased aws provider "${key}" is not allowed (one region per deployment)`);
      const region = cfg.expressions?.region;
      const resolved =
        region?.constant_value ??
        (region?.references?.includes("var.region") ? plan.variables?.region?.value : undefined);
      if (resolved !== ctx.region) {
        errors.push(
          `aws provider region must be ${ctx.region} (set it to var.region); got ${String(resolved ?? "unset")}`,
        );
      }
    }
  }

  let buckets = 0;
  let lockedPublicAccessBlocks = 0;

  for (const rc of live) {
    const after = rc.change.after ?? {};
    const unknown = rc.change.after_unknown ?? {};

    const banned = BANNED_RESOURCE_TYPES[rc.type];
    if (banned) errors.push(`${rc.address}: ${banned}`);

    // AWS provider v6 allows a per-resource `region` override.
    if (typeof after.region === "string" && after.region !== ctx.region) {
      errors.push(
        `${rc.address}: region ${after.region} is not allowed (one region per deployment: ${ctx.region})`,
      );
    }
    if (
      ctx.functionUrlAuth &&
      rc.type === "aws_lambda_function_url" &&
      after.authorization_type !== ctx.functionUrlAuth
    ) {
      errors.push(
        `${rc.address}: authorization_type must be ${ctx.functionUrlAuth} (use var.function_url_auth_type)`,
      );
    }

    // IAM
    if (rc.type === "aws_iam_policy" || rc.type === "aws_iam_role_policy") {
      if (unknown.policy === true)
        notes.push(`${rc.address}: policy document not known until apply; re-checked then`);
      checkPolicyDocument(rc.address, after.policy, errors);
    }
    if (rc.type === "aws_iam_role") {
      for (const inline of asArray(after.inline_policy as Array<{ policy?: string }>)) {
        checkPolicyDocument(rc.address, inline.policy, errors);
      }
    }
    if (rc.type === "aws_iam_role_policy_attachment" && typeof after.policy_arn === "string") {
      if (DANGEROUS_MANAGED_POLICIES.test(after.policy_arn)) {
        errors.push(`${rc.address}: attaching ${after.policy_arn} is not allowed`);
      }
    }

    // S3
    if (rc.type === "aws_s3_bucket") buckets++;
    if (rc.type === "aws_s3_bucket_public_access_block") {
      const locked = [
        "block_public_acls",
        "block_public_policy",
        "ignore_public_acls",
        "restrict_public_buckets",
      ].every((k) => after[k] === true);
      if (locked) lockedPublicAccessBlocks++;
      else errors.push(`${rc.address}: all four public access block settings must be true`);
    }
    if (
      rc.type === "aws_s3_bucket_acl" &&
      typeof after.acl === "string" &&
      after.acl.startsWith("public")
    ) {
      errors.push(`${rc.address}: public bucket ACL "${after.acl}" is not allowed`);
    }
    if (rc.type === "aws_s3_bucket_policy") {
      if (typeof after.policy === "string") {
        try {
          const doc = JSON.parse(after.policy) as { Statement?: unknown };
          for (const stmt of asArray(
            doc.Statement as Record<string, unknown> | Record<string, unknown>[],
          )) {
            if (stmt.Effect === "Allow" && principalIsPublic(stmt.Principal) && !stmt.Condition) {
              errors.push(
                `${rc.address}: bucket policy allows a public principal without a condition`,
              );
            }
          }
        } catch {
          // unparseable policy is caught by terraform validate/apply
        }
      } else if (unknown.policy === true) {
        notes.push(`${rc.address}: bucket policy not known until apply; re-checked then`);
      }
    }

    // Network ingress -- F2 only admits the CloudFront origin-facing prefix list.
    if (rc.type === "aws_security_group") {
      for (const rule of asArray(after.ingress as Array<Record<string, unknown>>)) {
        const cidrs = [
          ...asArray(rule.cidr_blocks as string[]),
          ...asArray(rule.ipv6_cidr_blocks as string[]),
        ];
        if (cidrs.includes("0.0.0.0/0") || cidrs.includes("::/0")) {
          errors.push(
            `${rc.address}: ingress open to the internet; allow only the CloudFront origin-facing prefix list`,
          );
        }
      }
    }
    if (
      rc.type === "aws_vpc_security_group_ingress_rule" ||
      rc.type === "aws_security_group_rule"
    ) {
      const isIngress =
        rc.type === "aws_vpc_security_group_ingress_rule" || after.type === "ingress";
      const cidrs = [
        after.cidr_ipv4,
        after.cidr_ipv6,
        ...asArray(after.cidr_blocks as string[]),
        ...asArray(after.ipv6_cidr_blocks as string[]),
      ];
      if (isIngress && (cidrs.includes("0.0.0.0/0") || cidrs.includes("::/0"))) {
        errors.push(
          `${rc.address}: ingress open to the internet; allow only the CloudFront origin-facing prefix list`,
        );
      }
    }

    // Required tags (via provider default_tags -> tags_all).
    if ("tags_all" in after || unknown.tags_all !== undefined) {
      const tags = (after.tags_all ?? {}) as Record<string, string>;
      for (const key of REQUIRED_TAG_KEYS) {
        if (tags[key] !== ctx.tags[key]) {
          errors.push(
            `${rc.address}: missing or wrong tag ${key} (set it via the provider's default_tags)`,
          );
          break;
        }
      }
    }
  }

  if (lockedPublicAccessBlocks < buckets) {
    errors.push(
      `${buckets} S3 bucket(s) but only ${lockedPublicAccessBlocks} fully-locked public access block(s); every bucket needs an aws_s3_bucket_public_access_block with all four settings true`,
    );
  }

  return { errors, notes };
}
