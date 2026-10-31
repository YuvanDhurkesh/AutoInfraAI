import { Prisma } from "@prisma/client";
import type { PipelineDeps } from "./deps.js";

export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Sec. 2.4: EC2 free hours are shared across the whole AWS account -- every
 * connection to it (one per region, or per person), not only this one. These
 * are the other F2 deployments whose instance is up: every active one, and a
 * failed one whose apply got as far as the instance (its outputs name it),
 * which keeps running until it is destroyed. One being destroyed is gone
 * within minutes, so destroying and deploying again straight away works.
 */
export async function alwaysOnEc2Holders(
  deps: Pick<PipelineDeps, "prisma">,
  awsConnectionId: string,
  deploymentId: string,
) {
  const { roleArn } = await deps.prisma.awsConnection.findUniqueOrThrow({
    where: { id: awsConnectionId },
    select: { roleArn: true },
  });
  const account = roleArn?.match(/^arn:aws[\w-]*:iam::(\d{12}):/)?.[1];
  return deps.prisma.deployment.findMany({
    where: {
      id: { not: deploymentId },
      pattern: "F2",
      ...(account
        ? { awsConnection: { is: { roleArn: { contains: `:iam::${account}:` } } } }
        : { awsConnectionId }),
      OR: [
        { status: { notIn: ["destroyed", "destroying", "failed"] } },
        {
          status: "failed",
          revisions: {
            some: { outputs: { path: ["instance_id"], string_starts_with: "i-" } },
          },
        },
      ],
    },
    select: { ownerId: true, repoUrl: true, subdir: true, status: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function otherAlwaysOnEc2(
  deps: Pick<PipelineDeps, "prisma">,
  awsConnectionId: string,
  deploymentId: string,
) {
  return (await alwaysOnEc2Holders(deps, awsConnectionId, deploymentId)).length;
}

export function eligibleTypesOf(planStateJson: unknown): string[] {
  return (
    (planStateJson as { eligibleInstanceTypes?: string[] } | null)?.eligibleInstanceTypes ?? []
  );
}
