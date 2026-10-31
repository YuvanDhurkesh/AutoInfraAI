import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import { PrismaClient } from "@prisma/client";
import { GeminiClient } from "@autoinfra/llm";
import { cloneRepo, remoteDefaultBranch } from "@autoinfra/scanner";
import {
  assumeDeployRole,
  getCallerIdentity,
  ensureStateBucket,
  uploadObject,
  runCodeBuild,
  recentLogLines,
  putAppParameter,
  deleteParametersByPath,
  findTaggedResources,
  getPlatformAccountId,
  ensurePlatformResources,
  receiveRegistrations,
  deleteRegistration,
  getAccountPlanState,
  getFreeTierUsage,
  listFreeTierEligibleInstanceTypes,
} from "@autoinfra/aws";
import { applyBundle, destroyBundle, generateAndValidate } from "@autoinfra/terraform-runner";
import {
  decryptSecret,
  handleRegistration,
  JOB_QUEUE,
  jobOptions,
  PREP_QUEUE,
  queueFor,
  runJob,
  type JobPayload,
  type PipelineDeps,
} from "@autoinfra/pipeline";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const ENCRYPTION_KEY = requireEnv("ENCRYPTION_KEY");
requireEnv("DATABASE_URL");

// Shared Terraform provider cache (the AWS provider is ~700 MB). Docker sets
// TF_PLUGIN_CACHE_DIR; a locally run worker gets one in the home directory.
const TF_PLUGIN_CACHE_DIR =
  process.env.TF_PLUGIN_CACHE_DIR || path.join(os.homedir(), ".autoinfra", "tf-plugin-cache");
fs.mkdirSync(TF_PLUGIN_CACHE_DIR, { recursive: true });

async function main() {
  const prisma = new PrismaClient();
  const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new Redis(REDIS_URL);
  const queue = new Queue(JOB_QUEUE, { connection });
  const prepQueue = new Queue(PREP_QUEUE, { connection });
  const queueOf = (kind: JobPayload["kind"]) => (queueFor(kind) === PREP_QUEUE ? prepQueue : queue);

  const llm =
    process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL
      ? new GeminiClient({
          apiKey: process.env.GEMINI_API_KEY,
          model: process.env.GEMINI_MODEL,
          logger: async (record) => {
            await prisma.llmCall.create({ data: record }).catch(() => undefined);
          },
        })
      : null;

  const deps: PipelineDeps = {
    prisma,
    llm,
    assumeDeployRole,
    getCallerIdentity,
    ensureStateBucket,
    uploadObject,
    runCodeBuild,
    recentLogLines,
    putAppParameter,
    deleteParametersByPath,
    findTaggedResources,
    destroyBundle,
    cloneRepo,
    defaultBranch: remoteDefaultBranch,
    generateAndValidate,
    applyBundle,
    githubToken: async (ownerId) => {
      const github = await prisma.githubConnection.findUnique({ where: { userId: ownerId } });
      return github ? decryptSecret(github.accessTokenEncrypted, ENCRYPTION_KEY) : undefined;
    },
    // A finished analyze/design step starts the next one in its chain.
    enqueue: async (payload) => {
      await queueOf(payload.kind).add(payload.kind, payload, jobOptions(payload));
    },
    publish: (channel, message) => publisher.publish(channel, message),
    fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    terraformPluginCacheDir: TF_PLUGIN_CACHE_DIR,
  };

  async function markInterrupted(jobId: string, reason: string) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.status !== "running") return;
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "failed", finishedAt: new Date(), error: reason },
    });
    await prisma.deployment.update({
      where: { id: job.deploymentId },
      data: { status: "failed", failureReason: reason },
    });
    await prisma.jobLog
      .create({ data: { jobId, line: reason, stream: "stderr" } })
      .catch(() => undefined);
  }

  // Recover jobs left "running" by a previous worker that died. A job still
  // waiting in its queue is fine; one that was active died with that worker.
  const running = await prisma.job.findMany({ where: { status: "running" } });
  for (const job of running) {
    const kind = job.kind as JobPayload["kind"];
    const queued = await queueOf(kind).getJob(job.id);
    const state = queued ? await queued.getState() : "missing";
    if (state === "missing" || state === "completed" || state === "failed" || state === "active") {
      await markInterrupted(
        job.id,
        "The worker stopped while this step was running. Retry it from the deployment page.",
      );
      if (queued && state === "active")
        await queued.moveToFailed(new Error("worker restarted"), "0", true).catch(() => undefined);
    }
  }

  // Infrastructure jobs are never retried blindly: a stalled job fails (and
  // is marked interrupted) instead of running again.
  const workerOptions = { connection, maxStalledCount: 0, lockDuration: 120_000 };
  const workers = [
    new Worker<JobPayload>(JOB_QUEUE, async (job) => runJob(deps, job.data), {
      ...workerOptions,
      concurrency: 2,
    }),
    // Analyze/design: short, mostly waiting on git and Gemini.
    new Worker<JobPayload>(PREP_QUEUE, async (job) => runJob(deps, job.data), {
      ...workerOptions,
      concurrency: 4,
    }),
  ];
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      if (job)
        void markInterrupted(job.data.jobId, `The step stopped unexpectedly: ${err.message}`);
    });
    worker.on("error", (err) => console.error("worker error", err));
  }

  // One-click "Connect AWS": answer the deploy-role stack's callback.
  let polling = true;
  const region = process.env.AWS_REGION ?? "us-east-1";
  void (async () => {
    let platform;
    try {
      platform = await ensurePlatformResources(region, await getPlatformAccountId(region));
    } catch (err) {
      console.warn(
        "one-click connect disabled (could not set up platform SNS/SQS):",
        (err as Error).message,
      );
      return;
    }
    console.log(`listening for AWS connections on ${platform.queueUrl}`);
    const aws = {
      assumeDeployRole,
      getCallerIdentity,
      getAccountPlanState,
      getFreeTierUsage,
      listFreeTierEligibleInstanceTypes,
    };
    while (polling) {
      try {
        for (const message of await receiveRegistrations(region, platform.queueUrl)) {
          const result = await handleRegistration({ prisma, aws, fetch }, message.body);
          console.log(`registration: ${result.status} -- ${result.reason}`);
          // Answered (or ignorable): don't process it again. A thrown error
          // leaves it on the queue to be retried after the visibility timeout.
          await deleteRegistration(region, platform.queueUrl, message.receiptHandle);
        }
      } catch (err) {
        console.error("registration poll error", err);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  })();

  const shutdown = async () => {
    polling = false;
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([queue.close(), prepQueue.close()]);
    await publisher.quit();
    await connection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `autoinfra worker listening on "${JOB_QUEUE}" and "${PREP_QUEUE}" (checked ${running.length} running job(s) on startup)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
