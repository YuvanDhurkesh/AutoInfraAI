import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import type { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { GeminiClient, type LlmClient } from "@autoinfra/llm";
import { cloneRepo } from "@autoinfra/scanner";
import {
  assumeDeployRole,
  putAppParameter,
  deleteAppParameter,
  getPlatformAccountId,
  ensurePlatformResources,
  publishTemplate,
  quickCreateUrl,
  instanceLogs,
  recentLogLines,
  listDatabaseTables,
  readDatabaseTable,
  type PlatformResources,
} from "@autoinfra/aws";
import { buildDeployRoleTemplate } from "@autoinfra/terraform-reference";
import {
  jobLogChannel,
  jobOptions,
  queueFor,
  shortIdFor,
  type JobPayload,
} from "@autoinfra/pipeline";
import type { Env } from "./env.js";
import {
  buildLimits,
  memoryRateLimitStore,
  redisRateLimitStore,
  type RateLimitStore,
} from "./lib/rate-limit.js";
import { registerAuthContext } from "./plugins/auth-context.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerAwsRoutes } from "./routes/aws.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerRevisionRoutes } from "./routes/revisions.js";
import { registerAccountRoutes } from "./routes/account.js";

export interface AppDeps {
  /** null when GEMINI_API_KEY/GEMINI_MODEL aren't configured. */
  llm: LlmClient | null;
  cloneRepo: typeof cloneRepo;
  assumeDeployRole: typeof assumeDeployRole;
  putAppParameter: typeof putAppParameter;
  deleteAppParameter: typeof deleteAppParameter;
  /** Hands a job to the worker (BullMQ). */
  enqueue: (payload: JobPayload) => Promise<void>;
  /** Live log lines for the SSE stream; returns an unsubscribe function. */
  subscribeJobLogs: (
    jobId: string,
    onMessage: (message: string) => void,
  ) => Promise<() => Promise<void>>;
  /** CloudFormation quick-create link for a pending connection (one-click connect). */
  prepareConnect: (connection: { id: string; externalId: string }) => Promise<string>;
  /** Platform SNS topic the template reports back to, if one-click connect is set up. */
  registrationTopicArn: () => Promise<string>;
  /** Current role template (with the callback), as a 1-hour presigned S3 URL. */
  roleTemplateUrl: () => Promise<{ templateUrl: string; region: string }>;
  /** Rate-limit counters (Redis, so every API process shares them; memory in tests). */
  rateLimitStore: RateLimitStore;
  /** An F2 container's last log lines, over SSM (read-only on the instance). */
  instanceLogs: typeof instanceLogs;
  /** A Lambda's recent log lines (F1), from CloudWatch. */
  recentLogLines: typeof recentLogLines;
  /** The database viewer: the F2 db container's tables and a page of rows, over SSM (read-only). */
  listDatabaseTables: typeof listDatabaseTables;
  readDatabaseTable: typeof readDatabaseTable;
  close?: () => Promise<void>;
}

function defaultDeps(env: Env, prisma: PrismaClient): AppDeps {
  const llm =
    env.GEMINI_API_KEY && env.GEMINI_MODEL
      ? new GeminiClient({
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL,
          logger: async (record) => {
            await prisma.llmCall.create({ data: record }).catch(() => undefined);
          },
        })
      : null;

  // Platform resources live in the platform's own region. IAM roles are
  // global, so the connect stack can always run there (a custom resource's
  // SNS topic must be in the same region as the stack).
  let platform: Promise<PlatformResources> | undefined;
  const getPlatform = () => {
    platform ??= getPlatformAccountId(env.AWS_REGION).then((accountId) =>
      ensurePlatformResources(env.AWS_REGION, accountId),
    );
    platform.catch(() => (platform = undefined));
    return platform;
  };
  let queueConnection: Redis | undefined;
  const queues = new Map<string, Queue>();
  const subscribers = new Set<Redis>();
  const limitRedis =
    env.NODE_ENV === "test" ? null : new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  return {
    llm,
    rateLimitStore: limitRedis ? redisRateLimitStore(limitRedis) : memoryRateLimitStore(),
    instanceLogs,
    recentLogLines,
    listDatabaseTables,
    readDatabaseTable,
    cloneRepo,
    assumeDeployRole,
    putAppParameter,
    deleteAppParameter,
    registrationTopicArn: async () => (await getPlatform()).topicArn,
    roleTemplateUrl: async () => {
      const p = await getPlatform();
      return {
        region: p.region,
        templateUrl: await publishTemplate(
          p,
          buildDeployRoleTemplate(p.accountId, { registrationTopicArn: p.topicArn }),
        ),
      };
    },
    prepareConnect: async (connection) => {
      const p = await getPlatform();
      const templateUrl = await publishTemplate(
        p,
        buildDeployRoleTemplate(p.accountId, { registrationTopicArn: p.topicArn }),
      );
      const shortId = shortIdFor(connection.id);
      return quickCreateUrl({
        region: p.region,
        templateUrl,
        stackName: `AutoInfra-${shortId}`,
        parameters: {
          ExternalId: connection.externalId,
          ConnectionId: connection.id,
          RoleName: `AutoInfraDeployRole-${shortId}`,
        },
      });
    },
    enqueue: async (payload) => {
      const name = queueFor(payload.kind);
      let queue = queues.get(name);
      if (!queue) {
        queueConnection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
        queue = new Queue(name, { connection: queueConnection });
        queues.set(name, queue);
      }
      await queue.add(payload.kind, payload, jobOptions(payload));
    },
    subscribeJobLogs: async (jobId, onMessage) => {
      const sub = new Redis(env.REDIS_URL);
      subscribers.add(sub);
      const channel = jobLogChannel(jobId);
      sub.on("message", (ch, message) => {
        if (ch === channel) onMessage(message);
      });
      await sub.subscribe(channel);
      return async () => {
        subscribers.delete(sub);
        await sub.quit().catch(() => undefined);
      };
    },
    close: async () => {
      await Promise.all([...queues.values()].map((q) => q.close()));
      await queueConnection?.quit().catch(() => undefined);
      await limitRedis?.quit().catch(() => undefined);
      await Promise.all([...subscribers].map((s) => s.quit().catch(() => undefined)));
    },
  };
}

export async function buildApp(env: Env, prisma: PrismaClient, deps?: Partial<AppDeps>) {
  const app = Fastify({ logger: true });
  const resolved: AppDeps = { ...defaultDeps(env, prisma), ...deps };
  app.addHook("onClose", async () => {
    await resolved.close?.();
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
  });

  const limits = buildLimits(resolved.rateLimitStore);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url !== "/health") return limits.global(request, reply);
  });

  registerAuthContext(app, prisma);
  registerAuthRoutes(app, prisma, env, limits);
  registerGithubRoutes(app, prisma, env);
  registerAwsRoutes(app, prisma, env, resolved, limits);
  registerDeploymentRoutes(app, prisma, env, resolved, limits);
  registerRevisionRoutes(app, prisma);
  registerAccountRoutes(app, prisma, limits);

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
