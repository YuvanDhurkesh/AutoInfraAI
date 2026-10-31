import type { FastifyInstance } from "fastify";
import type { PrismaClient, Revision } from "@prisma/client";
import { ArchitecturePlan, PlanSummary, TerraformFile, diffFiles } from "@autoinfra/shared";
import { requireAuth } from "../middleware/require-auth.js";

/** Statuses a revision passes through before it's applied. */
const IN_PROGRESS = new Set([
  "queued",
  "analyzing",
  "designing",
  "generating",
  "validating",
  "awaiting_approval",
]);

function bundleFiles(revision: Revision): TerraformFile[] {
  const files = (revision.terraformBundle as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? TerraformFile.array().catch([]).parse(files) : [];
}

function componentKey(c: { service: string; name: string }) {
  return `${c.service}.${c.name}`;
}

/**
 * Sec. 8 revision history: list, inspect, and diff revisions. Read-only;
 * every query is scoped to the caller's own deployments.
 */
export function registerRevisionRoutes(app: FastifyInstance, prisma: PrismaClient) {
  async function owned(ownerId: string, id: string) {
    return prisma.deployment.findFirst({ where: { id, ownerId } });
  }

  app.get("/deployments/:id/revisions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const deployment = await owned(request.user!.id, id);
    if (!deployment) return reply.code(404).send({ error: "not_found" });

    const revisions = await prisma.revision.findMany({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const latestNumber = revisions[0]?.number;
    return revisions.map((r) => {
      const isCurrent = r.id === deployment.currentRevisionId;
      const plan = PlanSummary.safeParse(r.planSummary).data;
      // A revision row keeps the status it last had; derive what it means now.
      const status = r.discardedAt
        ? "discarded"
        : r.status === "live" && !isCurrent
          ? "superseded"
          : IN_PROGRESS.has(r.status) && r.number !== latestNumber
            ? "abandoned"
            : r.status;
      return {
        number: r.number,
        action: r.action,
        status,
        isCurrent,
        commitSha: r.commitSha,
        changePrompt: r.changePrompt,
        rollbackOf: r.rollbackOf,
        pattern: ArchitecturePlan.safeParse(r.architecturePlan).data?.pattern ?? null,
        validated: (r.terraformBundle as { passed?: boolean } | null)?.passed === true,
        plan: plan
          ? {
              adds: plan.adds,
              changes: plan.changes,
              destroys: plan.destroys,
              replaces: plan.replaces,
            }
          : null,
        createdAt: r.createdAt,
      };
    });
  });

  app.get(
    "/deployments/:id/revisions/:number",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, number } = request.params as { id: string; number: string };
      const deployment = await owned(request.user!.id, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });
      const revision = await prisma.revision.findUnique({
        where: { deploymentId_number: { deploymentId: id, number: Number(number) || 0 } },
      });
      if (!revision) return reply.code(404).send({ error: "not_found" });
      return { ...revision, isCurrent: revision.id === deployment.currentRevisionId };
    },
  );

  /** Diff revision :number against ?against=<n> (default: the one before it). */
  app.get(
    "/deployments/:id/revisions/:number/diff",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, number } = request.params as { id: string; number: string };
      const { against } = request.query as { against?: string };
      const deployment = await owned(request.user!.id, id);
      if (!deployment) return reply.code(404).send({ error: "not_found" });

      const to = await prisma.revision.findUnique({
        where: { deploymentId_number: { deploymentId: id, number: Number(number) || 0 } },
      });
      if (!to) return reply.code(404).send({ error: "not_found" });
      const from = against
        ? await prisma.revision.findUnique({
            where: { deploymentId_number: { deploymentId: id, number: Number(against) || 0 } },
          })
        : await prisma.revision.findFirst({
            where: { deploymentId: id, number: { lt: to.number } },
            orderBy: { number: "desc" },
          });
      if (against && !from) return reply.code(404).send({ error: "not_found" });

      const fromPlan = from ? ArchitecturePlan.safeParse(from.architecturePlan).data : undefined;
      const toPlan = ArchitecturePlan.safeParse(to.architecturePlan).data;
      const fromComponents = new Map((fromPlan?.components ?? []).map((c) => [componentKey(c), c]));
      const toComponents = new Map((toPlan?.components ?? []).map((c) => [componentKey(c), c]));
      const describe = (c: { instanceType?: string; storageGb?: number; purpose: string }) =>
        [c.instanceType, c.storageGb !== undefined ? `${c.storageGb} GB` : undefined, c.purpose]
          .filter(Boolean)
          .join(" · ");

      const commitChanged = !!from && from.commitSha !== to.commitSha;
      return {
        from: from ? { number: from.number, commitSha: from.commitSha } : null,
        to: { number: to.number, commitSha: to.commitSha },
        commitChanged,
        compareUrl:
          commitChanged && deployment.repoUrl.startsWith("https://github.com/")
            ? `${deployment.repoUrl}/compare/${from!.commitSha}...${to.commitSha}`
            : null,
        pattern: { from: fromPlan?.pattern ?? null, to: toPlan?.pattern ?? null },
        components: {
          added: [...toComponents.keys()].filter((k) => !fromComponents.has(k)),
          removed: [...fromComponents.keys()].filter((k) => !toComponents.has(k)),
          changed: [...toComponents.entries()]
            .filter(
              ([k, c]) => fromComponents.has(k) && describe(fromComponents.get(k)!) !== describe(c),
            )
            .map(([k, c]) => ({
              name: k,
              before: describe(fromComponents.get(k)!),
              after: describe(c),
            })),
        },
        files: diffFiles(from ? bundleFiles(from) : [], bundleFiles(to)),
      };
    },
  );
}
