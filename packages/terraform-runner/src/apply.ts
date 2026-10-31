import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlanSummary, TerraformBundle } from "@autoinfra/shared";
import {
  checkPlanSecurity,
  planToResources,
  summarizePlan,
  type PlanJson,
} from "@autoinfra/terraform-policy";
import { evaluateFreeTier } from "@autoinfra/free-tier-policy";
import { run, runStreaming, toolEnv, type AwsCredentials } from "./exec.js";
import { writeWorkdir, type S3BackendConfig, type TfVars } from "./gauntlet.js";
import { initWithRetry, networkFailureMessage } from "./init.js";
import { jsonLogReader } from "./json-log.js";

export class ApplyError extends Error {
  constructor(
    message: string,
    /** Set when the fresh plan has changes outside what was approved. */
    readonly unapproved?: string[],
  ) {
    super(message);
  }
}

export interface ApplyInput {
  bundle: TerraformBundle;
  pattern: "F1" | "F2" | "F3";
  tfvars: TfVars;
  backend: S3BackendConfig;
  credentials: AwsCredentials;
  /** What the user approved. Anything beyond it stops the apply. */
  approvedPlan: PlanSummary;
  freeTierMode: "strict" | "flexible";
  eligibleInstanceTypes: string[];
  existingAlwaysOnEc2Count: number;
  pluginCacheDir?: string;
  onLog: (line: string, stream?: "stdout" | "stderr") => void | Promise<void>;
}

export interface ApplyResult {
  outputs: Record<string, unknown>;
  planSummary: PlanSummary;
}

/**
 * Every change in the fresh plan must have been approved with the same
 * action. Creates/updates that already happened (e.g. a retry after a
 * partial apply) simply drop out, so a subset is fine -- but a new resource,
 * a new destroy, or a create that became a replace is not.
 */
export function unapprovedChanges(approved: PlanSummary, fresh: PlanSummary): string[] {
  const allowed = new Set(approved.resources.map((r) => `${r.address}|${r.action}`));
  return fresh.resources
    .filter((r) => r.action !== "no-op" && r.action !== "read")
    .filter((r) => !allowed.has(`${r.address}|${r.action}`))
    .map((r) => `${r.action} ${r.address}`);
}

export async function applyBundle(input: ApplyInput): Promise<ApplyResult> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autoinfra-apply-"));
  const env = toolEnv({
    pluginCacheDir: input.pluginCacheDir,
    region: input.tfvars.region,
    credentials: input.credentials,
  });
  const tf = (args: string[], timeoutMs: number) =>
    run("terraform", [...args, "-no-color"], { cwd: dir, env, timeoutMs });

  try {
    writeWorkdir(dir, input);

    await input.onLog("terraform init (remote S3 state, native locking)");
    const init = await initWithRetry(
      () => tf(["init", "-input=false", "-backend-config=backend.hcl"], 300_000),
      {
        onRetry: (attempt, waitMs) =>
          input.onLog(
            `terraform init couldn't reach the network (attempt ${attempt}); retrying in ${waitMs / 1000}s`,
          ),
      },
    );
    if (init.code !== 0)
      throw new ApplyError(
        init.networkError
          ? networkFailureMessage(init)
          : `terraform init failed: ${init.stderr.trim().slice(0, 1500)}`,
      );

    await input.onLog("terraform plan against the current state");
    const plan = await tf(["plan", "-input=false", "-out=tfplan"], 600_000);
    if (plan.code !== 0)
      throw new ApplyError(`terraform plan failed: ${plan.stderr.trim().slice(0, 1500)}`);
    const shown = await tf(["show", "-json", "tfplan"], 120_000);
    const planJson = JSON.parse(shown.stdout) as PlanJson;
    const planSummary = summarizePlan(planJson);

    // Re-check everything on the plan that will actually be applied.
    const security = checkPlanSecurity(planJson, {
      region: input.tfvars.region,
      tags: {
        "autoinfra:deployment-id": input.tfvars.deployment_id,
        "autoinfra:owner": input.tfvars.owner,
        "autoinfra:managed-by": "autoinfra",
        "autoinfra:free-tier": "true",
      },
      functionUrlAuth: input.pattern === "F1" ? input.tfvars.function_url_auth_type : undefined,
    });
    if (security.errors.length) {
      throw new ApplyError(
        `Security policy failed on the apply plan: ${security.errors.slice(0, 5).join("; ")}`,
      );
    }
    const freeTier = evaluateFreeTier({
      plan: { resources: planToResources(planJson) },
      freeTierMode: input.freeTierMode,
      eligibleInstanceTypes: input.eligibleInstanceTypes.length
        ? input.eligibleInstanceTypes
        : undefined,
      existingAlwaysOnEc2Count: input.existingAlwaysOnEc2Count,
    });
    if (input.freeTierMode === "strict" && freeTier.denyListViolations.length) {
      throw new ApplyError(
        `Free Tier policy failed on the apply plan: ${freeTier.denyListViolations.slice(0, 5).join("; ")}`,
      );
    }
    const unapproved = unapprovedChanges(input.approvedPlan, planSummary);
    if (unapproved.length) {
      throw new ApplyError(
        `The plan changed since you approved it (${unapproved.slice(0, 8).join(", ")}). Regenerate and review it again.`,
        unapproved,
      );
    }

    await input.onLog(
      `Applying: +${planSummary.adds} ~${planSummary.changes} -${planSummary.destroys} ±${planSummary.replaces} (CloudFront can take 5-15 minutes)`,
    );
    const reader = jsonLogReader(input.onLog);
    const applied = await runStreaming("terraform", ["apply", "-input=false", "-json", "tfplan"], {
      cwd: dir,
      env,
      timeoutMs: 60 * 60_000,
      onLine: reader.onLine,
    });
    if (applied.code !== 0) {
      throw new ApplyError(
        applied.timedOut
          ? "terraform apply timed out"
          : `terraform apply failed: ${reader.errorText(applied.stderr)}`,
      );
    }

    const out = await tf(["output", "-json"], 120_000);
    const raw = JSON.parse(out.stdout || "{}") as Record<
      string,
      { value: unknown; sensitive?: boolean }
    >;
    const outputs = Object.fromEntries(
      Object.entries(raw)
        .filter(([, v]) => !v.sensitive)
        .map(([k, v]) => [k, v.value]),
    );
    return { outputs, planSummary };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
