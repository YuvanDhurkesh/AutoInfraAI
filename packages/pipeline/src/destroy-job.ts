import { TerraformBundle } from "@autoinfra/shared";
import { DestroyError, type TfVars } from "@autoinfra/terraform-runner";
import type { JobPayload, PipelineDeps } from "./deps.js";
import { failDeployment, finishJob, jobLogger } from "./job-log.js";
import { json } from "./common.js";
import { shortIdFor } from "./tfvars.js";

/**
 * Sec. 5 Destroy: tear down everything a deployment created, then prove it.
 *  1. terraform destroy against the real S3 state (buckets and the image
 *     repository are force-deleted with their contents)
 *  2. delete what AutoInfra wrote outside Terraform: env vars and the
 *     platform values under /autoinfra/<short_id> in SSM
 *  3. leftover check: anything still tagged with this deployment's id
 * The state file stays (empty) in the state bucket as the audit record.
 */
export async function runDestroyJob(deps: PipelineDeps, payload: JobPayload): Promise<void> {
  const { jobId, deploymentId: id } = payload;
  const log = jobLogger(deps, jobId);
  const deployment = await deps.prisma.deployment.findUniqueOrThrow({ where: { id } });

  try {
    // The resources in the state are the ones the last apply created.
    const lastApply = await deps.prisma.job.findFirst({
      where: { deploymentId: id, kind: "apply", revisionId: { not: null } },
      orderBy: { createdAt: "desc" },
      include: { revision: true },
    });
    const record = lastApply?.revision?.terraformBundle as {
      files?: unknown;
      tfvars?: TfVars;
    } | null;
    const connection = await deps.prisma.awsConnection.findUniqueOrThrow({
      where: { id: deployment.awsConnectionId },
    });
    if (!connection.roleArn) throw new DestroyError("The AWS connection has no role.");
    const credentials = await deps.assumeDeployRole({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      region: deployment.region,
      sessionName: `autoinfra-destroy-${id.slice(0, 8)}`,
      durationSeconds: 3600,
    });

    if (record?.tfvars && record.files) {
      const { accountId } = await deps.getCallerIdentity(credentials, deployment.region);
      if (!accountId) throw new DestroyError("Could not resolve the AWS account id.");
      const bucket = await deps.ensureStateBucket(credentials, deployment.region, accountId);
      await log.info("== destroying infrastructure ==");
      await deps.destroyBundle({
        bundle: TerraformBundle.parse({ files: record.files }),
        pattern: deployment.pattern ?? "F3",
        tfvars: record.tfvars,
        backend: { bucket, key: `deployments/${id}/terraform.tfstate`, region: deployment.region },
        credentials,
        pluginCacheDir: deps.terraformPluginCacheDir,
        onLog: (line, stream) => (stream === "stderr" ? log.error(line) : log.info(line)),
      });
    } else {
      await log.info(
        "Nothing was ever applied for this deployment -- no infrastructure to remove.",
      );
    }

    await log.info("== removing settings AutoInfra stored ==");
    const params = await deps.deleteParametersByPath(
      credentials,
      deployment.region,
      `/autoinfra/${shortIdFor(id)}`,
    );
    await log.info(`Deleted ${params.length} SSM parameter(s) under /autoinfra/${shortIdFor(id)}`);
    await deps.prisma.envVar.deleteMany({ where: { deploymentId: id } });
    await deps.prisma.freeTierLedgerEntry.deleteMany({ where: { deploymentId: id } });

    // Tag listings lag deletions (CloudFront especially): give them a moment.
    await log.info("== checking for leftovers ==");
    let leftovers: string[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      leftovers = await deps.findTaggedResources(
        credentials,
        [deployment.region, "us-east-1"],
        "autoinfra:deployment-id",
        id,
      );
      if (!leftovers.length) break;
      if (attempt < 6) await deps.sleep(20_000);
    }
    if (leftovers.length) {
      await log.error(`Still tagged with this deployment (${leftovers.length}):`);
      for (const arn of leftovers) await log.error(`  ${arn}`);
    } else {
      await log.info("No resources tagged with this deployment remain.");
    }

    await deps.prisma.deployment.update({
      where: { id },
      data: {
        status: "destroyed",
        liveUrl: null,
        currentRevisionId: null,
        failureReason: leftovers.length
          ? `Destroyed, but ${leftovers.length} tagged resource(s) are still listed -- some deletions finish in the background (CloudFront can take up to an hour to disappear from listings). Check: ${leftovers.slice(0, 3).join(", ")}`
          : null,
      },
    });
    await deps.prisma.auditEvent.create({
      data: {
        userId: deployment.ownerId,
        action: "deployment_destroyed",
        targetType: "deployment",
        targetId: id,
        metadata: json({ ssmParameters: params.length, leftovers }),
      },
    });
    await log.info("Destroyed.");
    await finishJob(deps, jobId);
    await log.end("succeeded");
  } catch (err) {
    const reason =
      err instanceof DestroyError
        ? `${err.message} -- run Destroy again to finish; it picks up where it stopped.`
        : `Destroy failed: ${err instanceof Error ? err.message : String(err)}`;
    await log.error(reason);
    await failDeployment(deps, id, reason);
    await finishJob(deps, jobId, reason);
    await log.end("failed");
  }
}
