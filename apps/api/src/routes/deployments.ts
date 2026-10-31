import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma, type JobKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  ArchitecturePlan,
  CreateDeploymentInput,
  ENV_NAME,
  FreeTierReport,
  PlanSummary,
  RESERVED_ENV_NAME as RESERVED_ENV,
  RepoProfile,
  platformProvidedEnv,
  type ProvidedHow,
} from "@autoinfra/shared";
import {
  decryptSecret,
  JobConflictError,
  shortIdFor,
  startJobRow,
  toConnectionSummary,
  UserJobLimitError,
  type JobPayload,
} from "@autoinfra/pipeline";
import { BROWSABLE_DATABASES, INSTANCE_SERVICES, isBrowsableTableName } from "@autoinfra/aws";
import { scanRepo } from "@autoinfra/scanner";
import { diagnoseFailure, LlmUnavailableError } from "@autoinfra/llm";
import { requireAuth } from "../middleware/require-auth.js";
import type { Env } from "../env.js";
import type { Limits } from "../lib/rate-limit.js";
import type { AppDeps } from "../app.js";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Every query is scoped by ownerId (multi-tenant isolation; see
 * isolation.integration.test.ts). Analyze and design run inline in the
 * request for now -- Milestone 7 moves them onto the BullMQ worker.
 */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  env: Env,
  deps: AppDeps,
  limits: Limits,
) {
  async function findOwned(ownerId: string, id: string) {
    return prisma.deployment.findFirst({ where: { id, ownerId } });
  }

  /**
   * Sec. 10: at most one running job per deployment, and at most
   * MAX_RUNNING_JOBS_PER_USER across one owner's deployments. Destroy is
   * exempt from the per-owner cap: it stops costs and must never be queued
   * behind other work.
   */
  async function startJob(deploymentId: string, kind: JobKind, revisionId?: string) {
    return startJobRow(prisma, {
      deploymentId,
      kind,
      revisionId,
      ownerCap: kind === "destroy" ? undefined : env.MAX_RUNNING_JOBS_PER_USER,
    });
  }

  async function finishJob(jobId: string, error?: string) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: error ? "failed" : "succeeded", finishedAt: new Date(), error },
    });
  }

  async function failDeployment(id: string, reason: string) {
    await prisma.deployment.update({
      where: { id },
      data: { status: "failed", failureReason: reason },
    });
  }

  function conflict(reply: FastifyReply, err?: unknown) {
    if (err instanceof UserJobLimitError) {
      return reply.code(429).send({
        error: "too_many_running_jobs",
        message: `You already have ${env.MAX_RUNNING_JOBS_PER_USER} steps running across your deployments. Wait for one to finish.`,
      });
    }
    return reply.code(409).send({
      error: "job_in_progress",
      message: "Another step is already running for this deployment.",
    });
  }

  /**
   * Hands a job to the worker. If the queue is unreachable the job fails
   * right away instead of sitting "running" with nothing to run it.
   */
  async function enqueueJob(payload: JobPayload): Promise<boolean> {
    try {
      await deps.enqueue(payload);
      return true;
    } catch (err) {
      app.log.error({ err }, "enqueue failed");
      const reason = queueDown.message;
      await failDeployment(payload.deploymentId, reason);
      await finishJob(payload.jobId, reason);
      return false;
    }
  }

  const queueDown = {
    error: "queue_unavailable",
    message: "Could not queue this step (is Redis running?). Try again.",
  };

  app.get("/deployments", { preHandler: requireAuth }, async (request) => {
    const ownerId = request.user!.id;
    return prisma.deployment.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } });
  });

  app.post(
    "/deployments",
    { preHandler: [requireAuth, limits.createDeployment] },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const parsed = CreateDeploymentInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input", details: parsed.error.issues });
      }
      const input = parsed.data;

      const connection = await prisma.awsConnection.findFirst({
        where: { id: input.awsConnectionId, userId: ownerId },
      });
      if (!connection) return reply.code(404).send({ error: "aws_connection_not_found" });
      if (!connection.verifiedAt || !connection.accountRegime) {
        return reply.code(400).send({
          error: "aws_connection_not_ready",
          message:
            "Finish verifying this AWS connection (including the account plan question) first.",
        });
      }

      const freeTierMode =
        input.freeTierMode ??
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: ownerId },
            select: { freeTierModeDefault: true },
          })
        ).freeTierModeDefault;
      const deployment = await prisma.deployment.create({
        data: {
          ownerId,
          awsConnectionId: connection.id,
          repoUrl: input.repoUrl.replace(/\/$/, "").replace(/\.git$/, ""),
          // "": the default branch, whose name the first analyze records.
          branch: input.branch ?? "",
          subdir: input.subdir,
          freeTierMode,
          allowRds: input.allowRds,
          externalDatabase: input.externalDatabase,
          region: connection.region,
        },
      });
      await prisma.auditEvent.create({
        data: {
          userId: ownerId,
          action: "deployment_created",
          targetType: "deployment",
          targetId: deployment.id,
        },
      });
      return reply.code(201).send(deployment);
    },
  );

  app.get("/deployments/:id", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await prisma.deployment.findFirst({
      where: { id, ownerId },
      include: {
        revisions: { where: { discardedAt: null }, orderBy: { number: "desc" }, take: 1 },
        jobs: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const { revisions, ...rest } = deployment;
    const currentRow = deployment.currentRevisionId
      ? await prisma.revision.findUnique({
          where: { id: deployment.currentRevisionId },
          select: { number: true, commitSha: true, outputs: true },
        })
      : null;
    // From the outputs only: the F2 instance's public IP (the address an
    // outside database's network access list must allow), and what the app's
    // startup log said was wrong while it still came up.
    const currentOutputs = currentRow?.outputs as Record<string, unknown> | null | undefined;
    const current = currentRow
      ? {
          number: currentRow.number,
          commitSha: currentRow.commitSha,
          outboundIp: currentOutputs?.public_ip?.toString() ?? null,
          startupWarning: currentOutputs?.startup_warning?.toString() ?? null,
        }
      : null;
    const connection = await prisma.awsConnection.findUnique({
      where: { id: deployment.awsConnectionId },
    });
    return {
      ...rest,
      latestRevision: revisions[0] ?? null,
      currentRevision: current,
      connection: connection
        ? {
            id: connection.id,
            needsPermissionUpdate: toConnectionSummary(connection).needsPermissionUpdate,
          }
        : null,
    };
  });

  // --- Analyze + design (Sec. 5 Steps 1-2) run on the worker's prep queue.
  // `then` chains the following steps server-side, so the paste-a-link flow
  // reaches the review screen even if the tab is closed.

  const AnalyzeInput = z.object({
    then: z
      .array(z.enum(["design", "generate"]))
      .default([])
      .refine((t) => ["", "design", "design,generate"].includes(t.join(","))),
  });
  const DesignInput = z.object({ then: z.array(z.literal("generate")).max(1).default([]) });

  app.post(
    "/deployments/:id/analyze",
    { preHandler: [requireAuth, limits.llm] },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const { id } = request.params as { id: string };
      const deployment = await findOwned(ownerId, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const parsed = AnalyzeInput.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_input",
          message: 'then must be [], ["design"] or ["design", "generate"].',
        });
      }
      const { then } = parsed.data;
      if (then.length && !deps.llm) {
        return reply
          .code(503)
          .send({ error: "llm_not_configured", message: "Set GEMINI_API_KEY and GEMINI_MODEL." });
      }
      // Generating plans against the account: fail now, before any tokens are spent.
      if (then.includes("generate") && !(await assumeFor(deployment, "check"))) {
        return reply.code(400).send(roleErrorFor(deployment));
      }

      let job;
      try {
        job = await startJob(id, "analyze");
      } catch (err) {
        if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
          return conflict(reply, err);
        throw err;
      }
      await prisma.deployment.update({
        where: { id },
        data: { status: "analyzing", failureReason: null },
      });
      if (!(await enqueueJob({ kind: "analyze", jobId: job.id, deploymentId: id, then })))
        return reply.code(503).send(queueDown);
      return reply.code(202).send({ jobId: job.id });
    },
  );

  app.post(
    "/deployments/:id/design",
    { preHandler: [requireAuth, limits.llm] },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const { id } = request.params as { id: string };
      const deployment = await findOwned(ownerId, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      if (!deps.llm) {
        return reply
          .code(503)
          .send({ error: "llm_not_configured", message: "Set GEMINI_API_KEY and GEMINI_MODEL." });
      }
      const parsed = DesignInput.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_input", message: 'then must be [] or ["generate"].' });
      }
      const { then } = parsed.data;

      const revision = await prisma.revision.findFirst({
        where: { deploymentId: id, discardedAt: null },
        orderBy: { number: "desc" },
      });
      if (
        !revision ||
        !RepoProfile.safeParse(revision.repoProfile).success ||
        revision.status === "failed"
      ) {
        return reply
          .code(400)
          .send({ error: "not_analyzed", message: "Analyze the repository first." });
      }
      // The live revision's plan is part of what's deployed; never redesign it in place.
      if (revision.id === deployment.currentRevisionId) {
        return reply.code(400).send({
          error: "nothing_to_design",
          message: "Re-analyze to prepare a new revision, or request a change.",
        });
      }
      if (then.includes("generate") && !(await assumeFor(deployment, "check"))) {
        return reply.code(400).send(roleErrorFor(deployment));
      }

      let job;
      try {
        job = await startJob(id, "design", revision.id);
      } catch (err) {
        if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
          return conflict(reply, err);
        throw err;
      }
      await prisma.deployment.update({
        where: { id },
        data: { status: "designing", failureReason: null },
      });
      if (!(await enqueueJob({ kind: "design", jobId: job.id, deploymentId: id, then })))
        return reply.code(503).send(queueDown);
      return reply.code(202).send({ jobId: job.id });
    },
  );

  async function assumeFor(
    deployment: { awsConnectionId: string; region: string; id: string },
    phase: string,
  ) {
    const connection = await prisma.awsConnection.findUnique({
      where: { id: deployment.awsConnectionId },
    });
    if (!connection?.roleArn || !connection.verifiedAt) return null;
    try {
      const credentials = await deps.assumeDeployRole({
        roleArn: connection.roleArn,
        externalId: connection.externalId,
        region: connection.region,
        // STS allows only [\w+=,.@-] here (no spaces), up to 64 characters.
        sessionName: `autoinfra-${phase}-${deployment.id.slice(0, 8)}`
          .replace(/[^\w+=,.@-]/g, "-")
          .slice(0, 64),
        durationSeconds: 900,
      });
      roleFailures.delete(deployment.id);
      return credentials;
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      app.log.warn(
        { deploymentId: deployment.id, phase, reason },
        "could not assume the deploy role",
      );
      roleFailures.set(deployment.id, reason);
      return null;
    }
  }

  /** Why assuming a deployment's role last failed, until its error is sent. */
  const roleFailures = new Map<string, string>();
  const roleError = {
    error: "assume_role_failed",
    message:
      "Could not assume the AutoInfraDeployRole in your AWS account. Re-verify the AWS connection.",
  };
  /**
   * AWS out of reach for a moment (the request timed out) is not a role that
   * stopped working: "re-verify" would send the owner to fix nothing.
   */
  const UNREACHABLE =
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|TimeoutError|NetworkingError/i;
  function roleErrorFor(deployment: { id: string }) {
    const reason = roleFailures.get(deployment.id) ?? "";
    roleFailures.delete(deployment.id);
    return UNREACHABLE.test(reason)
      ? {
          error: "aws_unreachable",
          message:
            "AutoInfra couldn't reach AWS just now (the request timed out). Nothing was changed -- try again in a minute.",
        }
      : roleError;
  }

  /**
   * Sec. 5 Step 4. Runs on the worker (BullMQ); progress streams to job_logs
   * and /jobs/:id/logs/stream. Fails fast here, before spending Gemini
   * tokens, if the deploy role can't be assumed (planning needs it).
   */
  app.post(
    "/deployments/:id/generate",
    { preHandler: [requireAuth, limits.llm] },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const { id } = request.params as { id: string };
      const deployment = await findOwned(ownerId, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      if (!deps.llm) {
        return reply
          .code(503)
          .send({ error: "llm_not_configured", message: "Set GEMINI_API_KEY and GEMINI_MODEL." });
      }
      const revision = await prisma.revision.findFirst({
        where: { deploymentId: id },
        orderBy: { number: "desc" },
      });
      if (
        !revision ||
        !RepoProfile.safeParse(revision.repoProfile).success ||
        !ArchitecturePlan.safeParse(revision.architecturePlan).success
      ) {
        return reply
          .code(400)
          .send({ error: "not_designed", message: "Design the architecture first." });
      }
      // The live revision's Terraform is what's applied; never regenerate it in place.
      if (revision.discardedAt || revision.id === deployment.currentRevisionId) {
        return reply.code(400).send({
          error: "nothing_to_generate",
          message: "Request a change or re-analyze to prepare a new revision.",
        });
      }
      if (!(await assumeFor(deployment, "check")))
        return reply.code(400).send(roleErrorFor(deployment));

      let job;
      try {
        job = await startJob(id, "generate");
      } catch (err) {
        if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
          return conflict(reply, err);
        throw err;
      }
      await prisma.job.update({ where: { id: job.id }, data: { revisionId: revision.id } });
      await prisma.deployment.update({
        where: { id },
        data: { status: "generating", failureReason: null },
      });
      await prisma.revision.update({ where: { id: revision.id }, data: { status: "generating" } });
      if (!(await enqueueJob({ kind: "generate", jobId: job.id, deploymentId: id })))
        return reply.code(503).send(queueDown);
      return reply.code(202).send({ jobId: job.id });
    },
  );

  // --- The running app's own logs: an F2 container's (read over SSM) or the
  // F1 Lambda's (CloudWatch). Read-only, from the latest revision that reached AWS.

  /** The live revision, else the latest that reached AWS: its outputs and profile. */
  async function runningRevision(deployment: { id: string; currentRevisionId: string | null }) {
    const revision = await prisma.revision.findFirst({
      where: {
        deploymentId: deployment.id,
        ...(deployment.currentRevisionId ? { id: deployment.currentRevisionId } : {}),
        outputs: { not: Prisma.DbNull },
      },
      orderBy: { number: "desc" },
      select: { outputs: true, repoProfile: true },
    });
    return {
      outputs: (revision?.outputs ?? {}) as Record<string, unknown>,
      profile: RepoProfile.safeParse(revision?.repoProfile).data,
    };
  }

  const LogsQuery = z.object({
    service: z.enum(INSTANCE_SERVICES).default("app"),
    lines: z.coerce.number().int().min(1).max(500).default(200),
  });
  app.get(
    "/deployments/:id/logs",
    { preHandler: [requireAuth, limits.appLogs] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await findOwned(request.user!.id, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const query = LogsQuery.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({
          error: "invalid_input",
          message: `service must be one of ${INSTANCE_SERVICES.join(", ")}; lines 1 to 500.`,
        });
      }
      const { outputs } = await runningRevision(deployment);
      const instanceId = typeof outputs.instance_id === "string" ? outputs.instance_id : null;
      const functionName = typeof outputs.function_name === "string" ? outputs.function_name : null;
      if (deployment.status === "destroyed" || (!instanceId && !functionName)) {
        return reply.code(409).send({
          error: "no_logs",
          message:
            "There is no running app to read logs from: a static site has none, and neither has a deployment that never reached AWS or was destroyed.",
        });
      }
      const credentials = await assumeFor(deployment, "logs");
      if (!credentials) return reply.code(400).send(roleErrorFor(deployment));
      try {
        const lines = instanceId
          ? await deps.instanceLogs({
              credentials,
              region: deployment.region,
              instanceId,
              service: query.data.service,
              lines: query.data.lines,
            })
          : await deps.recentLogLines(
              credentials,
              deployment.region,
              `/aws/lambda/${functionName}`,
              query.data.lines,
            );
        return {
          source: instanceId ? "instance" : "lambda",
          service: instanceId ? query.data.service : "lambda",
          lines,
        };
      } catch (err) {
        request.log.warn({ err, deploymentId: id }, "reading app logs failed");
        return reply.code(502).send({
          error: "logs_unavailable",
          message: `Couldn't read the logs just now (${err instanceof Error ? err.message : String(err)}). The instance may still be starting -- try again in a minute.`,
        });
      }
    },
  );

  // --- The database viewer: the tables in the F2 instance's db container and a
  // page of one table's rows. Fixed read-only queries only (packages/aws
  // db-browse); the rows pass through to the owner and are never stored.

  /** The deployment's browsable database, or why there's none to browse. */
  async function browsableDatabase(deployment: {
    id: string;
    status: string;
    currentRevisionId: string | null;
  }) {
    const { outputs, profile } = await runningRevision(deployment);
    const instanceId = typeof outputs.instance_id === "string" ? outputs.instance_id : null;
    const kind = BROWSABLE_DATABASES.find((k) => k === profile?.database);
    if (profile?.databaseExternal && profile.database !== "none")
      return {
        error: `Your database is hosted outside AWS${profile.databaseHostedAt ? ` (at ${profile.databaseHostedAt})` : ""}, so AutoInfra doesn't run it -- open it in that provider's own console (Atlas Data Explorer, Neon's tables view...).`,
      };
    if (!kind)
      return {
        error:
          "This deployment has no database AutoInfra runs for it (a PostgreSQL, MySQL or MongoDB container on its server) to show.",
      };
    if (deployment.status === "destroyed" || !instanceId)
      return {
        error:
          "The database isn't running: the deployment hasn't reached AWS yet, or it was destroyed.",
      };
    return { kind, instanceId };
  }

  app.get(
    "/deployments/:id/database",
    { preHandler: [requireAuth, limits.dbView] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await findOwned(request.user!.id, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const db = await browsableDatabase(deployment);
      if (db.error !== undefined)
        return reply.code(409).send({ error: "no_database", message: db.error });
      const credentials = await assumeFor(deployment, "db-viewer");
      if (!credentials) return reply.code(400).send(roleErrorFor(deployment));
      try {
        const tables = await deps.listDatabaseTables({
          credentials,
          region: deployment.region,
          instanceId: db.instanceId,
          kind: db.kind,
        });
        return { kind: db.kind, tables };
      } catch (err) {
        request.log.warn({ err, deploymentId: id }, "listing database tables failed");
        return reply.code(502).send(databaseUnavailable(err));
      }
    },
  );

  const RowsQuery = z.object({
    table: z.string().min(1).max(200),
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  });
  app.get(
    "/deployments/:id/database/rows",
    { preHandler: [requireAuth, limits.dbView] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await findOwned(request.user!.id, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const query = RowsQuery.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({
          error: "invalid_input",
          message: "table is required; offset 0 or more; limit 1 to 50.",
        });
      }
      const db = await browsableDatabase(deployment);
      if (db.error !== undefined)
        return reply.code(409).send({ error: "no_database", message: db.error });
      if (!isBrowsableTableName(db.kind, query.data.table)) {
        return reply.code(400).send({
          error: "invalid_input",
          message: `The viewer can't open a table named ${JSON.stringify(query.data.table)} (only letters, digits, _, $ and -).`,
        });
      }
      const credentials = await assumeFor(deployment, "db-viewer");
      if (!credentials) return reply.code(400).send(roleErrorFor(deployment));
      try {
        const page = await deps.readDatabaseTable({
          credentials,
          region: deployment.region,
          instanceId: db.instanceId,
          kind: db.kind,
          ...query.data,
        });
        if (!page)
          return reply.code(404).send({
            error: "table_not_found",
            message: `There's no table ${query.data.table} (any more) -- reload the list.`,
          });
        return { kind: db.kind, table: query.data.table, ...page };
      } catch (err) {
        request.log.warn({ err, deploymentId: id }, "reading database rows failed");
        return reply.code(502).send(databaseUnavailable(err));
      }
    },
  );

  function databaseUnavailable(err: unknown) {
    return {
      error: "database_unavailable",
      message: `Couldn't read the database just now (${err instanceof Error ? err.message : String(err)}). If the app was just deployed, try again in a minute.`,
    };
  }

  // --- Env vars (Sec. 5 Step 3): values go straight to SSM in the user's account.

  /** Env vars from the repo that still need a value from the user. */
  function unfilledEnv(
    profile: RepoProfile | undefined,
    pattern: string | null | undefined,
    saved: Set<string>,
  ) {
    const provided = profile
      ? platformProvidedEnv(profile, pattern)
      : new Map<string, ProvidedHow>();
    const missing = (profile?.envVars ?? []).filter(
      (v) => !saved.has(v.name) && !RESERVED_ENV.test(v.name) && !provided.has(v.name),
    );
    return { missing, provided };
  }
  const EnvInput = z.object({
    vars: z
      .array(
        z.object({
          name: z
            .string()
            .trim()
            .max(128)
            .regex(
              ENV_NAME,
              "isn't a valid name: use letters, digits and _ only (no spaces or =), not starting with a digit",
            )
            .refine(
              (n) => !RESERVED_ENV.test(n),
              "is set by AutoInfra or the runtime itself (PORT, AWS_*, AUTOINFRA_*...) -- leave it out",
            ),
          // A password copied with a trailing space or line break would fail
          // to log in; dotenv trims unquoted values the same way.
          value: z.string().trim().min(1, "is empty").max(4096),
          isSecret: z.boolean(),
        }),
      )
      .min(1)
      .max(100),
  });

  app.get("/deployments/:id/env", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const saved = await prisma.envVar.findMany({
      where: { deploymentId: id },
      orderBy: { name: "asc" },
    });
    const revision = await prisma.revision.findFirst({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const savedNames = new Set(saved.map((v) => v.name));
    const { missing, provided } = unfilledEnv(
      RepoProfile.safeParse(revision?.repoProfile).data,
      ArchitecturePlan.safeParse(revision?.architecturePlan).data?.pattern ?? deployment.pattern,
      savedNames,
    );
    return {
      vars: saved.map((v) => ({ name: v.name, isSecret: v.isSecret, set: true })),
      // Names found in the repo that have no value yet.
      missing,
      // Names AutoInfra fills in itself (the user can override them, except
      // database and Redis settings: those always point at its containers).
      provided: [...provided]
        .filter(([name]) => !savedNames.has(name))
        .map(([name, how]) => ({ name, how })),
    };
  });

  app.put("/deployments/:id/env", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const parsed = EnvInput.safeParse(request.body);
    if (!parsed.success) {
      // Say which row and why: the form shows `message`, not the details.
      const rows = (request.body as { vars?: Array<{ name?: unknown }> } | null)?.vars;
      const reasons = parsed.error.issues.map((issue) => {
        const row = typeof issue.path[1] === "number" ? rows?.[issue.path[1]] : undefined;
        const name = typeof row?.name === "string" && row.name ? `"${row.name}" ` : "";
        return `${name}${issue.message}`;
      });
      return reply.code(400).send({
        error: "invalid_input",
        message: [...new Set(reasons)].join("; "),
        details: parsed.error.issues,
      });
    }

    // Database and Redis settings point at the containers AutoInfra runs:
    // docker-compose sets them, and that beats .env -- a value saved here
    // would never be used (a pasted env template's 127.0.0.1 included).
    const latest = await prisma.revision.findFirst({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const { provided } = unfilledEnv(
      RepoProfile.safeParse(latest?.repoProfile).data,
      ArchitecturePlan.safeParse(latest?.architecturePlan).data?.pattern ?? deployment.pattern,
      new Set(),
    );
    const wired = parsed.data.vars
      .map((v) => v.name)
      .filter((name) => ["database", "cache"].includes(provided.get(name) ?? ""));
    if (wired.length)
      return reply.code(400).send({
        error: "set_by_autoinfra",
        message: `AutoInfra connects ${wired.join(", ")} to the database it runs for this app, so a value here would never be used -- leave ${wired.length === 1 ? "it" : "them"} out. To use a database of your own instead, create the deployment with "Database hosted outside AWS".`,
      });

    const credentials = await assumeFor(deployment, "env");
    if (!credentials) return reply.code(400).send(roleErrorFor(deployment));
    const shortId = shortIdFor(id);
    for (const v of parsed.data.vars) {
      const ssmPath = await deps.putAppParameter({
        credentials,
        region: deployment.region,
        shortId,
        deploymentId: id,
        name: v.name,
        value: v.value,
        isSecret: v.isSecret,
      });
      await prisma.envVar.upsert({
        where: { deploymentId_name: { deploymentId: id, name: v.name } },
        create: { deploymentId: id, name: v.name, isSecret: v.isSecret, ssmPath },
        update: { isSecret: v.isSecret, ssmPath },
      });
    }
    await prisma.auditEvent.create({
      data: {
        userId: ownerId,
        action: "env_vars_set",
        targetType: "deployment",
        targetId: id,
        // Names only -- values never touch AutoInfra's database or logs.
        metadata: { names: parsed.data.vars.map((v) => v.name) },
      },
    });
    return { saved: parsed.data.vars.map((v) => v.name) };
  });

  app.delete("/deployments/:id/env/:name", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id, name } = request.params as { id: string; name: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const existing = await prisma.envVar.findUnique({
      where: { deploymentId_name: { deploymentId: id, name } },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const credentials = await assumeFor(deployment, "env");
    if (!credentials) return reply.code(400).send(roleErrorFor(deployment));
    if (existing.ssmPath)
      await deps.deleteAppParameter(credentials, deployment.region, existing.ssmPath);
    await prisma.envVar.delete({ where: { id: existing.id } });
    await prisma.auditEvent.create({
      data: {
        userId: ownerId,
        action: "env_var_deleted",
        targetType: "deployment",
        targetId: id,
        metadata: { name },
      },
    });
    return reply.code(204).send();
  });

  // --- Approve (Sec. 5 Step 5): the only path to changing AWS resources.

  const ApproveInput = z.object({
    confirmPaidResources: z.boolean().default(false),
    acceptMissingEnv: z.boolean().default(false),
    /** Required when the plan destroys or replaces a data-bearing resource. */
    confirmDataLoss: z.boolean().default(false),
  });

  app.post("/deployments/:id/approve", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const input = ApproveInput.parse(request.body ?? {});

    const revision = await prisma.revision.findFirst({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const bundle = revision?.terraformBundle as { passed?: boolean } | null;
    // A failed apply/deploy can be retried with the same validated bundle;
    // the apply step re-plans and only proceeds within what was approved.
    const retryAfterDeployFailure = deployment.status === "failed" && bundle?.passed === true;
    if (
      !revision ||
      revision.discardedAt ||
      !bundle?.passed ||
      !revision.planSummary ||
      !(deployment.status === "awaiting_approval" || retryAfterDeployFailure)
    ) {
      return reply
        .code(400)
        .send({ error: "not_ready", message: "Generate and validate the Terraform first." });
    }

    const dataLoss = PlanSummary.safeParse(revision.planSummary).data?.dataBearingDestroys ?? [];
    if (dataLoss.length && !input.confirmDataLoss) {
      return reply.code(409).send({
        error: "data_loss_needs_confirmation",
        message: `This change destroys or replaces resources that hold data: ${dataLoss.join(", ")}. Their contents will be lost. Confirm to continue.`,
        resources: dataLoss,
      });
    }

    const report = FreeTierReport.safeParse(revision.freeTierReport).data;
    if (report && report.denyListViolations.length > 0) {
      if (deployment.freeTierMode === "strict") {
        return reply
          .code(400)
          .send({ error: "exceeds_free_tier", message: "This plan is not Free-Tier-compliant." });
      }
      if (!input.confirmPaidResources) {
        return reply.code(409).send({
          error: "paid_resources_need_confirmation",
          message:
            "This plan includes resources outside the Free Tier. Confirm the costs to continue.",
          violations: report.denyListViolations,
        });
      }
    }

    const saved = new Set(
      (await prisma.envVar.findMany({ where: { deploymentId: id } })).map((v) => v.name),
    );
    const missing = unfilledEnv(
      RepoProfile.safeParse(revision.repoProfile).data,
      ArchitecturePlan.safeParse(revision.architecturePlan).data?.pattern ?? deployment.pattern,
      saved,
    ).missing.map((v) => v.name);
    if (missing.length && !input.acceptMissingEnv) {
      return reply.code(409).send({
        error: "env_vars_missing",
        message: `These env vars from your repo have no value yet: ${missing.join(", ")}`,
        missing,
      });
    }
    if (!(await assumeFor(deployment, "check")))
      return reply.code(400).send(roleErrorFor(deployment));

    let job;
    try {
      job = await startJob(id, "apply");
    } catch (err) {
      if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
        return conflict(reply, err);
      throw err;
    }
    await prisma.job.update({ where: { id: job.id }, data: { revisionId: revision.id } });
    await prisma.deployment.update({
      where: { id },
      data: { status: "applying", failureReason: null },
    });
    await prisma.auditEvent.create({
      data: {
        userId: ownerId,
        action: "deployment_approved",
        targetType: "deployment",
        targetId: id,
        metadata: {
          revision: revision.number,
          confirmPaidResources: input.confirmPaidResources,
          acceptMissingEnv: input.acceptMissingEnv,
          confirmDataLoss: input.confirmDataLoss,
          changePrompt: revision.changePrompt,
          rollbackOf: revision.rollbackOf,
        },
      },
    });
    if (!(await enqueueJob({ kind: "apply", jobId: job.id, deploymentId: id })))
      return reply.code(503).send(queueDown);
    return reply.code(202).send({ jobId: job.id });
  });

  // --- Redeploy (Sec. 8): ship the branch's newest commit on the live
  // infrastructure. Its approved plan is "no changes", so the apply step's
  // drift check refuses to touch infrastructure -- that needs a redesign.

  const RedeployInput = z.object({ acceptMissingEnv: z.boolean().default(false) });
  const NO_CHANGES = {
    adds: 0,
    changes: 0,
    destroys: 0,
    replaces: 0,
    resources: [],
    dataBearingDestroys: [],
  };

  app.post("/deployments/:id/redeploy", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const input = RedeployInput.parse(request.body ?? {});

    const current = deployment.currentRevisionId
      ? await prisma.revision.findUnique({ where: { id: deployment.currentRevisionId } })
      : null;
    const currentBundle = current?.terraformBundle as { passed?: boolean; tfvars?: unknown } | null;
    if (!current || !currentBundle?.passed || !currentBundle.tfvars) {
      return reply.code(400).send({
        error: "nothing_to_redeploy",
        message: "Redeploy needs a deployment that has been live at least once.",
      });
    }
    if (!["live", "failed"].includes(deployment.status)) {
      return reply.code(409).send({
        error: "deployment_busy",
        message: "Wait for the current step to finish before redeploying.",
      });
    }
    if (!(await assumeFor(deployment, "check")))
      return reply.code(400).send(roleErrorFor(deployment));

    const github = await prisma.githubConnection.findUnique({ where: { userId: ownerId } });
    let clone;
    try {
      clone = await deps.cloneRepo({
        repoUrl: deployment.repoUrl,
        branch: deployment.branch,
        githubToken: github
          ? decryptSecret(github.accessTokenEncrypted, env.ENCRYPTION_KEY)
          : undefined,
        // Inside an HTTP request: fail in minutes, not after the worker's limit.
        timeoutMs: 2 * 60_000,
      });
    } catch (err) {
      request.log.warn({ err }, "clone failed");
      return reply.code(422).send({
        error: "clone_failed",
        message: `Could not fetch the latest commit of ${deployment.repoUrl} (branch "${deployment.branch}").`,
      });
    }

    let profile;
    try {
      profile = scanRepo(clone.localPath, {
        repoUrl: deployment.repoUrl,
        commitSha: clone.commitSha,
        branch: deployment.branch,
        subdir: deployment.subdir ?? undefined,
        externalDatabase: deployment.externalDatabase,
      });
    } finally {
      await clone.cleanup().catch(() => undefined);
    }
    if (profile.unsupportedReasons.length) {
      return reply
        .code(422)
        .send({ error: "unsupported_repository", message: profile.unsupportedReasons.join(" ") });
    }
    // Compare scan to scan: the live pattern was Gemini's pick and can
    // legitimately differ from the scanner's hint (an app with an external
    // database may run on F2 although the hint says F1).
    const liveHint = RepoProfile.safeParse(current.repoProfile).data?.recommendedPattern;
    if (deployment.pattern && profile.recommendedPattern !== (liveHint ?? deployment.pattern)) {
      return reply.code(409).send({
        error: "app_shape_changed",
        message: `The latest commit looks like a ${profile.recommendedPattern} app, but this deployment runs ${deployment.pattern}. Use "Re-analyze & redesign" to review the new architecture.`,
      });
    }

    const saved = new Set(
      (await prisma.envVar.findMany({ where: { deploymentId: id } })).map((v) => v.name),
    );
    const missing = unfilledEnv(profile, deployment.pattern, saved).missing.map((v) => v.name);
    if (missing.length && !input.acceptMissingEnv) {
      return reply.code(409).send({
        error: "env_vars_missing",
        message: `These env vars from your repo have no value yet: ${missing.join(", ")}`,
        missing,
      });
    }

    let job;
    try {
      job = await startJob(id, "apply");
    } catch (err) {
      if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
        return conflict(reply, err);
      throw err;
    }
    const latest = await prisma.revision.findFirst({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const revision = await prisma.revision.create({
      data: {
        deploymentId: id,
        number: (latest?.number ?? 0) + 1,
        commitSha: profile.commitSha,
        repoProfile: json(profile),
        architecturePlan: current.architecturePlan ?? Prisma.JsonNull,
        freeTierReport: current.freeTierReport ?? Prisma.JsonNull,
        terraformBundle: current.terraformBundle ?? Prisma.JsonNull,
        planSummary: json(NO_CHANGES),
        status: "applying",
        action: "redeploy",
      },
    });
    await prisma.job.update({ where: { id: job.id }, data: { revisionId: revision.id } });
    await prisma.deployment.update({
      where: { id },
      data: { status: "applying", failureReason: null },
    });
    await prisma.auditEvent.create({
      data: {
        userId: ownerId,
        action: "deployment_redeployed",
        targetType: "deployment",
        targetId: id,
        metadata: {
          revision: revision.number,
          fromCommit: current.commitSha,
          toCommit: profile.commitSha,
        },
      },
    });
    if (!(await enqueueJob({ kind: "apply", jobId: job.id, deploymentId: id })))
      return reply.code(503).send(queueDown);
    return reply.code(202).send({
      jobId: job.id,
      revision: revision.number,
      commitSha: profile.commitSha,
      unchanged: profile.commitSha === current.commitSha,
    });
  });

  // --- Change requests (Sec. 5): the owner describes a change to a live
  // deployment; Gemini edits the live Terraform, the full gauntlet validates
  // it against the real state, and nothing is applied until it's approved.

  const ChangeInput = z.object({ prompt: z.string().trim().min(5).max(1000) });

  app.post(
    "/deployments/:id/changes",
    { preHandler: [requireAuth, limits.llm] },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const { id } = request.params as { id: string };
      const deployment = await findOwned(ownerId, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const parsed = ChangeInput.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_input",
          message: "Describe the change in 5 to 1000 characters.",
        });
      }
      if (!deps.llm) {
        return reply
          .code(503)
          .send({ error: "llm_not_configured", message: "Set GEMINI_API_KEY and GEMINI_MODEL." });
      }
      const current = deployment.currentRevisionId
        ? await prisma.revision.findUnique({ where: { id: deployment.currentRevisionId } })
        : null;
      if (!current?.terraformBundle || !["live", "failed"].includes(deployment.status)) {
        return reply.code(400).send({
          error: "not_live",
          message: "Change requests apply to a deployment that is live.",
        });
      }
      if (!(await assumeFor(deployment, "check")))
        return reply.code(400).send(roleErrorFor(deployment));

      let job;
      try {
        job = await startJob(id, "generate");
      } catch (err) {
        if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
          return conflict(reply, err);
        throw err;
      }
      const latest = await prisma.revision.findFirst({
        where: { deploymentId: id },
        orderBy: { number: "desc" },
      });
      const revision = await prisma.revision.create({
        data: {
          deploymentId: id,
          number: (latest?.number ?? 0) + 1,
          commitSha: current.commitSha,
          repoProfile: current.repoProfile ?? Prisma.JsonNull,
          architecturePlan: current.architecturePlan ?? Prisma.JsonNull,
          freeTierReport: current.freeTierReport ?? Prisma.JsonNull,
          changePrompt: parsed.data.prompt,
          status: "generating",
          action: "change",
        },
      });
      await prisma.job.update({ where: { id: job.id }, data: { revisionId: revision.id } });
      await prisma.deployment.update({
        where: { id },
        data: { status: "generating", failureReason: null },
      });
      await prisma.auditEvent.create({
        data: {
          userId: ownerId,
          action: "change_requested",
          targetType: "deployment",
          targetId: id,
          metadata: { revision: revision.number, prompt: parsed.data.prompt },
        },
      });
      if (!(await enqueueJob({ kind: "generate", jobId: job.id, deploymentId: id })))
        return reply.code(503).send(queueDown);
      return reply.code(202).send({ jobId: job.id, revision: revision.number });
    },
  );

  /**
   * Drop a pending change (awaiting approval, or failed validation) and go
   * back to the revision that is live. Only while nothing from it has been
   * applied -- after that, AWS may already differ from the live revision.
   */
  app.post(
    "/deployments/:id/changes/discard",
    { preHandler: requireAuth },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const { id } = request.params as { id: string };
      const deployment = await findOwned(ownerId, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const latest = await prisma.revision.findFirst({
        where: { deploymentId: id },
        orderBy: { number: "desc" },
      });
      const pending =
        latest &&
        deployment.currentRevisionId &&
        latest.id !== deployment.currentRevisionId &&
        !latest.discardedAt &&
        ["awaiting_approval", "failed"].includes(deployment.status);
      if (!pending) {
        return reply
          .code(400)
          .send({ error: "nothing_to_discard", message: "There is no pending change." });
      }
      const touchedAws = await prisma.job.count({
        where: { revisionId: latest.id, kind: { in: ["apply", "destroy"] } },
      });
      if (touchedAws) {
        return reply.code(409).send({
          error: "already_applied",
          message:
            "This change was already partly applied to AWS. Retry it, or request another change.",
        });
      }
      if (await prisma.job.count({ where: { deploymentId: id, status: "running" } })) {
        return conflict(reply);
      }
      await prisma.revision.update({
        where: { id: latest.id },
        data: { discardedAt: new Date() },
      });
      // A re-design may have switched the pattern; go back to what's live.
      const live = await prisma.revision.findUnique({
        where: { id: deployment.currentRevisionId! },
        select: { architecturePlan: true },
      });
      await prisma.deployment.update({
        where: { id },
        data: {
          status: "live",
          failureReason: null,
          pattern:
            ArchitecturePlan.safeParse(live?.architecturePlan).data?.pattern ?? deployment.pattern,
        },
      });
      await prisma.auditEvent.create({
        data: {
          userId: ownerId,
          action: "change_discarded",
          targetType: "deployment",
          targetId: id,
          metadata: { revision: latest.number },
        },
      });
      return { discarded: latest.number };
    },
  );

  // --- Rollback (Sec. 5): restore an earlier live revision's infrastructure
  // and commit. Its Terraform is re-validated against what's running now (no
  // model call), so the review shows exactly what changes back; nothing is
  // applied until that plan is approved.

  const RollbackInput = z.object({ toRevision: z.number().int().positive() });

  app.post("/deployments/:id/rollback", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const parsed = RollbackInput.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_input", message: "Say which revision to roll back to." });
    }
    if (!deployment.currentRevisionId || !["live", "failed"].includes(deployment.status)) {
      return reply.code(409).send({
        error: "deployment_busy",
        message: "Rollback needs a live deployment with no step in progress.",
      });
    }
    const [current, target] = await Promise.all([
      prisma.revision.findUnique({ where: { id: deployment.currentRevisionId } }),
      prisma.revision.findUnique({
        where: { deploymentId_number: { deploymentId: id, number: parsed.data.toRevision } },
      }),
    ]);
    const targetBundle = target?.terraformBundle as { files?: unknown; passed?: boolean } | null;
    // Rows keep status "live" after they're superseded: "live" = was live once.
    if (!target || target.status !== "live" || !targetBundle?.passed) {
      return reply.code(400).send({
        error: "not_a_live_revision",
        message: "You can only roll back to a revision that was live.",
      });
    }
    if (target.id === current?.id) {
      return reply
        .code(400)
        .send({ error: "already_live", message: `Revision ${target.number} is already live.` });
    }
    const targetPattern = ArchitecturePlan.safeParse(target.architecturePlan).data?.pattern;
    const livePattern = ArchitecturePlan.safeParse(current?.architecturePlan).data?.pattern;
    if (!targetPattern || targetPattern !== livePattern) {
      return reply.code(409).send({
        error: "pattern_changed",
        message: `Revision ${target.number} ran a different architecture (${targetPattern ?? "unknown"}, now ${livePattern ?? "unknown"}). Rolling back across architectures would rebuild everything; destroy and deploy that version instead.`,
      });
    }
    if (!(await assumeFor(deployment, "check")))
      return reply.code(400).send(roleErrorFor(deployment));

    let job;
    try {
      job = await startJob(id, "generate");
    } catch (err) {
      if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
        return conflict(reply, err);
      throw err;
    }
    const latest = await prisma.revision.findFirst({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const revision = await prisma.revision.create({
      data: {
        deploymentId: id,
        number: (latest?.number ?? 0) + 1,
        commitSha: target.commitSha,
        repoProfile: target.repoProfile ?? Prisma.JsonNull,
        architecturePlan: target.architecturePlan ?? Prisma.JsonNull,
        freeTierReport: target.freeTierReport ?? Prisma.JsonNull,
        // Files only: it isn't validated until the gauntlet passes again.
        terraformBundle: json({ files: targetBundle.files, passed: false }),
        rollbackOf: target.number,
        status: "generating",
        action: "rollback",
      },
    });
    await prisma.job.update({ where: { id: job.id }, data: { revisionId: revision.id } });
    await prisma.deployment.update({
      where: { id },
      data: { status: "generating", failureReason: null, pattern: targetPattern },
    });
    await prisma.auditEvent.create({
      data: {
        userId: ownerId,
        action: "rollback_requested",
        targetType: "deployment",
        targetId: id,
        metadata: { revision: revision.number, rollbackOf: target.number, from: current?.number },
      },
    });
    if (!(await enqueueJob({ kind: "generate", jobId: job.id, deploymentId: id })))
      return reply.code(503).send(queueDown);
    return reply.code(202).send({ jobId: job.id, revision: revision.number });
  });

  // --- Destroy (Sec. 5): remove everything the deployment created, then
  // check nothing tagged with it is left. Irreversible, so the user types the
  // repository name to confirm.

  const DestroyInput = z.object({ confirm: z.string() });

  app.post("/deployments/:id/destroy", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const deployment = await findOwned(ownerId, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });
    const repoName = deployment.repoUrl.replace(/^https:\/\/github\.com\//, "");
    const parsed = DestroyInput.safeParse(request.body ?? {});
    if (!parsed.success || parsed.data.confirm.trim() !== repoName) {
      return reply.code(400).send({
        error: "confirmation_mismatch",
        message: `Type "${repoName}" to confirm.`,
      });
    }
    if (deployment.status === "destroyed") {
      return reply.code(409).send({ error: "already_destroyed", message: "Already destroyed." });
    }

    const everApplied = await prisma.job.count({ where: { deploymentId: id, kind: "apply" } });
    if (everApplied) {
      const connection = await prisma.awsConnection.findUnique({
        where: { id: deployment.awsConnectionId },
      });
      if (connection && toConnectionSummary(connection).needsPermissionUpdate) {
        return reply.code(409).send({
          error: "permissions_outdated",
          message:
            "Your AWS role needs updated permissions before AutoInfra can remove everything (for example, emptying versioned buckets). Update it first -- see the notice on this page.",
        });
      }
      if (!(await assumeFor(deployment, "check")))
        return reply.code(400).send(roleErrorFor(deployment));
    }

    let job;
    try {
      job = await startJob(id, "destroy");
    } catch (err) {
      if (err instanceof JobConflictError || err instanceof Prisma.PrismaClientKnownRequestError)
        return conflict(reply, err);
      throw err;
    }
    await prisma.deployment.update({
      where: { id },
      data: { status: "destroying", failureReason: null },
    });
    await prisma.auditEvent.create({
      data: {
        userId: ownerId,
        action: "deployment_destroy_requested",
        targetType: "deployment",
        targetId: id,
      },
    });
    if (!(await enqueueJob({ kind: "destroy", jobId: job.id, deploymentId: id })))
      return reply.code(503).send(queueDown);
    return reply.code(202).send({ jobId: job.id });
  });

  // --- Live job logs over SSE: DB backlog, then Redis pub/sub.

  // Each live stream holds a Redis subscription; cap them per owner (per API process).
  const openStreams = new Map<string, number>();
  const MAX_STREAMS_PER_USER = 10;

  app.get("/jobs/:id/logs/stream", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const job = await prisma.job.findFirst({ where: { id, deployment: { ownerId } } });
    if (!job) return reply.code(404).send({ error: "not_found" });
    if (job.status === "running" && (openStreams.get(ownerId) ?? 0) >= MAX_STREAMS_PER_USER) {
      return reply.code(429).send({
        error: "too_many_streams",
        message: "Too many live logs open at once. Close some tabs and reload.",
      });
    }

    const lastEventId = Number(
      request.headers["last-event-id"] ?? (request.query as { after?: string }).after ?? 0,
    );
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": env.WEB_ORIGIN,
      "access-control-allow-credentials": "true",
    });
    let lastSeq = Number.isInteger(lastEventId) ? lastEventId : 0;
    const send = (event: string, data: unknown, seq?: number) => {
      res.write(`${seq ? `id: ${seq}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const backlog = await prisma.jobLog.findMany({
      where: { jobId: id, seq: { gt: lastSeq } },
      orderBy: { seq: "asc" },
      select: { seq: true, line: true, stream: true },
    });
    for (const l of backlog) {
      send("log", l, l.seq);
      lastSeq = l.seq;
    }
    if (job.status !== "running") {
      send("end", { status: job.status, error: job.error });
      res.end();
      return;
    }

    openStreams.set(ownerId, (openStreams.get(ownerId) ?? 0) + 1);
    const release = () => {
      const left = (openStreams.get(ownerId) ?? 1) - 1;
      if (left > 0) openStreams.set(ownerId, left);
      else openStreams.delete(ownerId);
    };
    let closed = false;
    const unsubscribe = await deps
      .subscribeJobLogs(id, (message) => {
        if (closed) return;
        const msg = JSON.parse(message) as {
          type: string;
          seq?: number;
          line?: string;
          stream?: string;
          status?: string;
        };
        if (msg.type === "log" && msg.seq && msg.seq > lastSeq) {
          lastSeq = msg.seq;
          send("log", { seq: msg.seq, line: msg.line, stream: msg.stream }, msg.seq);
        } else if (msg.type === "end") {
          send("end", { status: msg.status });
          cleanup();
        }
      })
      .catch(() => null);
    if (!unsubscribe) {
      // Redis is unavailable: end the response; EventSource reconnects by itself.
      release();
      res.end();
      return;
    }
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      release();
      void unsubscribe!();
      res.end();
    }
    request.raw.on("close", cleanup);

    // The job may have logged or finished between the backlog read and the
    // subscription; catch up so the stream can't miss its "end".
    const [missed, now] = await Promise.all([
      prisma.jobLog.findMany({
        where: { jobId: id, seq: { gt: lastSeq } },
        orderBy: { seq: "asc" },
        select: { seq: true, line: true, stream: true },
      }),
      prisma.job.findUnique({ where: { id }, select: { status: true, error: true } }),
    ]);
    for (const l of missed) {
      if (closed || l.seq <= lastSeq) continue;
      send("log", l, l.seq);
      lastSeq = l.seq;
    }
    if (!closed && now && now.status !== "running") {
      send("end", { status: now.status, error: now.error });
      cleanup();
    }
  });

  /**
   * "Explain this failure": Gemini reads the redacted tail of a failed job's
   * log. Generated once and cached on the job.
   */
  app.post(
    "/jobs/:id/diagnose",
    { preHandler: [requireAuth, limits.llm] },
    async (request, reply) => {
      const ownerId = request.user!.id;
      const { id } = request.params as { id: string };
      const job = await prisma.job.findFirst({
        where: { id, deployment: { ownerId } },
        include: { deployment: true, revision: true },
      });
      if (!job) return reply.code(404).send({ error: "not_found" });
      if (job.status !== "failed") {
        return reply
          .code(400)
          .send({ error: "not_failed", message: "Only failed steps can be explained." });
      }
      if (job.diagnosis) return job.diagnosis;
      if (!deps.llm) {
        return reply
          .code(503)
          .send({ error: "llm_not_configured", message: "Set GEMINI_API_KEY and GEMINI_MODEL." });
      }
      const tail = await prisma.jobLog.findMany({
        where: { jobId: id },
        orderBy: { seq: "desc" },
        take: 150,
        select: { line: true },
      });
      try {
        const diagnosis = await diagnoseFailure(deps.llm, {
          jobKind: job.kind,
          failureReason: job.error ?? job.deployment.failureReason ?? "unknown",
          logLines: tail.reverse().map((l) => l.line),
          pattern: job.deployment.pattern,
          changePrompt: job.revision?.changePrompt,
        });
        await prisma.job.update({ where: { id }, data: { diagnosis: json(diagnosis) } });
        return diagnosis;
      } catch (err) {
        request.log.warn({ err }, "diagnosis failed");
        return reply.code(502).send({
          error: "diagnosis_failed",
          message:
            err instanceof LlmUnavailableError
              ? err.message
              : "Gemini couldn't explain this failure right now.",
        });
      }
    },
  );

  app.get("/jobs/:id/logs", { preHandler: requireAuth }, async (request, reply) => {
    const ownerId = request.user!.id;
    const { id } = request.params as { id: string };
    const { after } = request.query as { after?: string };
    const job = await prisma.job.findFirst({ where: { id, deployment: { ownerId } } });
    if (!job) return reply.code(404).send({ error: "not_found" });
    const afterSeq = Number(after);
    const logs = await prisma.jobLog.findMany({
      where: {
        jobId: id,
        ...(Number.isInteger(afterSeq) && afterSeq > 0 ? { seq: { gt: afterSeq } } : {}),
      },
      orderBy: { seq: "asc" },
      take: 500,
      select: { seq: true, line: true, stream: true, createdAt: true },
    });
    return { status: job.status, error: job.error, logs };
  });
}
