export * from "./deps.js";
export * from "./job-log.js";
export * from "./tfvars.js";
export * from "./source-zip.js";
export * from "./health.js";
export * from "./job-rows.js";
export * from "./prepare-jobs.js";
export * from "./generate-job.js";
export * from "./apply-job.js";
export * from "./destroy-job.js";

import type { JobPayload, PipelineDeps } from "./deps.js";
import { runAnalyzeJob, runDesignJob } from "./prepare-jobs.js";
import { runGenerateJob } from "./generate-job.js";
import { runApplyJob } from "./apply-job.js";
import { runDestroyJob } from "./destroy-job.js";

export function runJob(deps: PipelineDeps, payload: JobPayload): Promise<void> {
  if (payload.kind === "analyze") return runAnalyzeJob(deps, payload);
  if (payload.kind === "design") return runDesignJob(deps, payload);
  if (payload.kind === "generate") return runGenerateJob(deps, payload);
  if (payload.kind === "destroy") return runDestroyJob(deps, payload);
  return runApplyJob(deps, payload);
}
export * from "./crypto.js";
export * from "./connection.js";
