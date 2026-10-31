/**
 * The subset of a Terraform resource this evaluator needs. Milestone 6 feeds
 * this from real `terraform show -json` plan output; until then, Milestone 3's
 * own tests construct these by hand to exercise the deny-list and usage
 * projection logic in isolation. Keeping this shape stable now means the
 * evaluator doesn't change when real plan parsing lands later.
 */
export interface NormalizedResource {
  /** Terraform resource type, e.g. "aws_instance", "aws_nat_gateway". */
  type: string;
  name: string;
  attributes: Record<string, unknown>;
}

export interface NormalizedPlan {
  resources: NormalizedResource[];
}

export interface EvaluateFreeTierInput {
  plan: NormalizedPlan;
  freeTierMode: "strict" | "flexible";
  /** From the free-tier ledger (Sec. 2.4) -- EC2 hours are shared across the
   * whole AWS account, not per-deployment. Always-on instances already
   * allocated to OTHER deployments on this same AWS connection. Defaults to
   * 0 for standalone evaluation/tests. */
  existingAlwaysOnEc2Count?: number;
  /** Free-Tier-eligible instance types for the target region/account, from
   * `@autoinfra/aws`'s `listFreeTierEligibleInstanceTypes` (never hardcoded
   * here -- eligibility varies by account and region). */
  eligibleInstanceTypes?: string[];
}
