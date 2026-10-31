import { Prisma, type JobKind, type PrismaClient } from "@prisma/client";

/** Another step is already running for this deployment. */
export class JobConflictError extends Error {}
/** The owner already has the most steps allowed running at once (across deployments). */
export class UserJobLimitError extends JobConflictError {}

/**
 * Sec. 10: at most one running job per deployment, and -- when `ownerCap` is
 * set -- at most that many across one owner's deployments. Serializable, so
 * two requests can't both pass the check.
 *
 * `handoffFrom` finishes that (successful) job in the same transaction: a
 * chained step takes over without the deployment ever looking idle, and
 * nothing else can start in between.
 */
export async function startJobRow(
  prisma: PrismaClient,
  opts: {
    deploymentId: string;
    kind: JobKind;
    revisionId?: string;
    ownerCap?: number;
    handoffFrom?: string;
  },
) {
  return prisma.$transaction(
    async (tx) => {
      if (opts.handoffFrom) {
        await tx.job.update({
          where: { id: opts.handoffFrom },
          data: { status: "succeeded", finishedAt: new Date() },
        });
      }
      const running = await tx.job.count({
        where: { deploymentId: opts.deploymentId, status: "running" },
      });
      if (running > 0) throw new JobConflictError();
      if (opts.ownerCap !== undefined) {
        const { ownerId } = await tx.deployment.findUniqueOrThrow({
          where: { id: opts.deploymentId },
          select: { ownerId: true },
        });
        const ownerRunning = await tx.job.count({
          where: { status: "running", deployment: { ownerId } },
        });
        if (ownerRunning >= opts.ownerCap) throw new UserJobLimitError();
      }
      return tx.job.create({
        data: {
          deploymentId: opts.deploymentId,
          kind: opts.kind,
          revisionId: opts.revisionId,
          status: "running",
          startedAt: new Date(),
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
