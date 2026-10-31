import type { PrismaClient } from "@prisma/client";
import type { LlmClient } from "@autoinfra/llm";
import type {
  assumeDeployRole,
  getCallerIdentity,
  ensureStateBucket,
  uploadObject,
  runCodeBuild,
  recentLogLines,
  putAppParameter,
  deleteParametersByPath,
  findTaggedResources,
} from "@autoinfra/aws";
import type { cloneRepo, remoteDefaultBranch } from "@autoinfra/scanner";
import type { applyBundle, destroyBundle, generateAndValidate } from "@autoinfra/terraform-runner";

export const JOB_QUEUE = "deployment-jobs";
/**
 * Analyze and design take seconds to a minute; they get their own queue so
 * they never wait behind a long apply or destroy.
 */
export const PREP_QUEUE = "deployment-prep";

export type JobPayloadKind = "analyze" | "design" | "generate" | "apply" | "destroy";
/** Steps that can follow a preparation step without another request. */
export type ChainedStep = "design" | "generate";

export function queueFor(kind: JobPayloadKind): string {
  return kind === "analyze" || kind === "design" ? PREP_QUEUE : JOB_QUEUE;
}

/** attempts: 1 -- applying infrastructure must never be retried blindly. */
export function jobOptions(payload: JobPayload) {
  return { jobId: payload.jobId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 };
}

/** Never carries credentials or secrets -- the worker assumes the role itself. */
export interface JobPayload {
  kind: JobPayloadKind;
  jobId: string;
  deploymentId: string;
  /** Run these next, in order, if this step succeeds (e.g. analyze -> design -> generate). */
  then?: ChainedStep[];
}

export const jobLogChannel = (jobId: string) => `autoinfra:job-logs:${jobId}`;

/** Everything a job touches from the outside world, injectable for tests. */
export interface PipelineDeps {
  prisma: PrismaClient;
  llm: LlmClient | null;
  assumeDeployRole: typeof assumeDeployRole;
  getCallerIdentity: typeof getCallerIdentity;
  ensureStateBucket: typeof ensureStateBucket;
  uploadObject: typeof uploadObject;
  runCodeBuild: typeof runCodeBuild;
  recentLogLines: typeof recentLogLines;
  /** Writes an app env var to SSM in the user's account. */
  putAppParameter: typeof putAppParameter;
  deleteParametersByPath: typeof deleteParametersByPath;
  findTaggedResources: typeof findTaggedResources;
  destroyBundle: typeof destroyBundle;
  cloneRepo: typeof cloneRepo;
  /** The repository's default branch, for a clearer error when the asked-for branch doesn't exist. */
  defaultBranch?: typeof remoteDefaultBranch;
  generateAndValidate: typeof generateAndValidate;
  applyBundle: typeof applyBundle;
  /** Decrypted GitHub token for private repos, if the owner connected GitHub. */
  githubToken: (ownerId: string) => Promise<string | undefined>;
  /** Queues a job (BullMQ in production): how a chained step starts the next one. */
  enqueue: (payload: JobPayload) => Promise<void>;
  /** Live log fan-out (Redis pub/sub in production). */
  publish?: (channel: string, message: string) => Promise<unknown> | void;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  terraformPluginCacheDir?: string;
}
