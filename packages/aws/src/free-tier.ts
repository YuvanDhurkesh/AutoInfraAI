import {
  FreeTierClient,
  GetAccountPlanStateCommand,
  GetFreeTierUsageCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-freetier";
import type { AwsCredentialIdentity } from "@smithy/types";
import type { AccountRegime } from "@autoinfra/shared";

export interface AccountPlanStateResult {
  /**
   * null means the API call didn't give us a confident answer (access
   * denied, throttled, etc.) -- the caller must fall back to asking the
   * user, per Sec. 2.1. Never guessed client-side.
   */
  regime: AccountRegime | null;
  raw: unknown;
  source: "freetier-api" | "unavailable";
}

/**
 * Sec. 2.1: try the AWS Free Tier API first. `GetAccountPlanState` only
 * exists for accounts on the new (July 2025+) credit-based plan model --
 * a ResourceNotFoundException for *this specific call* means the account
 * has no account-plan resource at all, which is a reliable signal for a
 * legacy (pre-July-2025, 12-month free tier) account, not a guess.
 * AccessDenied/anything else means "we don't know", not "assume legacy".
 */
export async function getAccountPlanState(
  credentials: AwsCredentialIdentity,
  region: string,
): Promise<AccountPlanStateResult> {
  const client = new FreeTierClient({ region, credentials });

  try {
    const result = await client.send(new GetAccountPlanStateCommand({}));
    const regime: AccountRegime = result.accountPlanType === "FREE" ? "free_plan" : "paid_plan";
    return { regime, raw: result, source: "freetier-api" };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return {
        regime: "legacy_12mo",
        raw: { reason: "no_account_plan_resource" },
        source: "freetier-api",
      };
    }
    return {
      regime: null,
      raw: { error: err instanceof Error ? err.message : String(err) },
      source: "unavailable",
    };
  }
}

export async function getFreeTierUsage(credentials: AwsCredentialIdentity, region: string) {
  const client = new FreeTierClient({ region, credentials });
  try {
    const result = await client.send(new GetFreeTierUsageCommand({ maxResults: 100 }));
    return { usages: result.freeTierUsages ?? [], available: true as const };
  } catch (err) {
    return {
      usages: [],
      available: false as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
