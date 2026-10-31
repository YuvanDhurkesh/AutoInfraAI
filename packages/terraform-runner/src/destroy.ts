import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TerraformBundle } from "@autoinfra/shared";
import { run, runStreaming, toolEnv, type AwsCredentials } from "./exec.js";
import { writeWorkdir, type S3BackendConfig, type TfVars } from "./gauntlet.js";
import { initWithRetry, networkFailureMessage } from "./init.js";
import { jsonLogReader } from "./json-log.js";

/** Destroy logs no per-resource "Destroying..." starts, only outcomes. */
const DESTROY_LOGGED = new Set(["apply_complete", "apply_errored", "change_summary", "diagnostic"]);

export class DestroyError extends Error {}

export interface DestroyInput {
  /** The bundle that was last applied (its resources are what the state holds). */
  bundle: TerraformBundle;
  pattern: "F1" | "F2" | "F3";
  tfvars: TfVars;
  backend: S3BackendConfig;
  credentials: AwsCredentials;
  pluginCacheDir?: string;
  onLog: (line: string, stream?: "stdout" | "stderr") => void | Promise<void>;
}

/**
 * Sec. 5 Destroy: `terraform destroy` against the deployment's real S3 state.
 * Buckets are force_destroy and the ECR repository force_delete in every
 * reference project, so their contents go with them. Returns how many
 * resources the state still holds afterwards (0 on success).
 */
export async function destroyBundle(input: DestroyInput): Promise<{ remaining: string[] }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autoinfra-destroy-"));
  const env = toolEnv({
    pluginCacheDir: input.pluginCacheDir,
    region: input.tfvars.region,
    credentials: input.credentials,
  });
  const tf = (args: string[], timeoutMs: number) =>
    run("terraform", [...args, "-no-color"], { cwd: dir, env, timeoutMs });

  try {
    writeWorkdir(dir, input);
    await input.onLog("terraform init (remote S3 state)");
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
      throw new DestroyError(
        init.networkError
          ? networkFailureMessage(init)
          : `terraform init failed: ${init.stderr.trim().slice(0, 1500)}`,
      );

    const before = await tf(["state", "list"], 120_000);
    const count = before.stdout.split(/\r?\n/).filter(Boolean).length;
    await input.onLog(`Destroying ${count} resources (CloudFront alone can take 5-15 minutes)`);

    const reader = jsonLogReader(input.onLog, DESTROY_LOGGED);
    const destroyed = await runStreaming(
      "terraform",
      ["destroy", "-auto-approve", "-input=false", "-json"],
      {
        cwd: dir,
        env,
        timeoutMs: 60 * 60_000,
        onLine: reader.onLine,
      },
    );

    const after = await tf(["state", "list"], 120_000);
    const remaining = after.stdout.split(/\r?\n/).filter(Boolean);
    if (destroyed.code !== 0) {
      throw new DestroyError(
        destroyed.timedOut
          ? `terraform destroy timed out with ${remaining.length} resources left`
          : `terraform destroy failed with ${remaining.length} resources left: ${reader.errorText(destroyed.stderr)}`,
      );
    }
    return { remaining };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
