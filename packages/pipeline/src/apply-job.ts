import {
  PlanSummary,
  RESERVED_ENV_NAME,
  RepoProfile,
  TerraformBundle,
  platformProvidedEnv,
  providedValue,
} from "@autoinfra/shared";
import { shortIdFor } from "./tfvars.js";
import { loadPlatformAppFiles } from "@autoinfra/terraform-reference";
import { ApplyError, type TfVars } from "@autoinfra/terraform-runner";
import type { JobPayload, PipelineDeps } from "./deps.js";
import { failDeployment, finishJob, jobLogger } from "./job-log.js";
import { eligibleTypesOf, json, otherAlwaysOnEc2 } from "./common.js";
import { buildSourceZip } from "./source-zip.js";
import { checkHealth } from "./health.js";
import { buildFailure, INSTANCE_OUTPUT, startupFailure } from "./startup-errors.js";

class DeployError extends Error {}

const REQUIRED_OUTPUTS = ["cloudfront_domain_name", "artifacts_bucket", "codebuild_project"];

/** CodeBuild starting the buildspec's first deploy step: building is over. */
const DEPLOY_STEP =
  /Running command bash \.autoinfra\/(rollout|package-lambda|publish-frontend)\.sh/;

/**
 * Sec. 5 Step 6, after the user approved: bootstrap state -> re-plan and
 * re-check against real state -> apply -> build and deploy the app with
 * CodeBuild -> health-check through CloudFront -> live URL.
 */
export async function runApplyJob(deps: PipelineDeps, payload: JobPayload): Promise<void> {
  const { jobId, deploymentId: id } = payload;
  const log = jobLogger(deps, jobId);
  const setStatus = async (status: "applying" | "building" | "deploying" | "health_checking") => {
    await deps.prisma.deployment.update({ where: { id }, data: { status } });
    await log.info(`== ${status.replace("_", " ")} ==`);
  };

  const deployment = await deps.prisma.deployment.findUniqueOrThrow({ where: { id } });
  const revision = await deps.prisma.revision.findFirstOrThrow({
    where: { deploymentId: id },
    orderBy: { number: "desc" },
  });

  try {
    const bundleRecord = revision.terraformBundle as {
      files?: unknown;
      tfvars?: TfVars;
      passed?: boolean;
    } | null;
    const bundle = TerraformBundle.parse({ files: bundleRecord?.files });
    const tfvars = bundleRecord?.tfvars;
    const approvedPlan = PlanSummary.parse(revision.planSummary);
    if (!tfvars || !bundleRecord?.passed)
      throw new DeployError("This revision has no validated Terraform to apply.");
    const pattern = deployment.pattern ?? "F3";

    const connection = await deps.prisma.awsConnection.findUniqueOrThrow({
      where: { id: deployment.awsConnectionId },
    });
    if (!connection.roleArn) throw new DeployError("The AWS connection has no role.");
    const assume = (phase: string) =>
      deps.assumeDeployRole({
        roleArn: connection.roleArn!,
        externalId: connection.externalId,
        region: deployment.region,
        sessionName: `autoinfra-${phase}-${id.slice(0, 8)}`,
        durationSeconds: 3600,
      });

    // 1. Apply.
    await setStatus("applying");
    await deps.prisma.revision.update({ where: { id: revision.id }, data: { status: "applying" } });
    let credentials = await assume("apply");
    const { accountId } = await deps.getCallerIdentity(credentials, deployment.region);
    if (!accountId) throw new DeployError("Could not resolve the AWS account id.");
    const bucket = await deps.ensureStateBucket(credentials, deployment.region, accountId);
    await log.info(`Terraform state: s3://${bucket}/deployments/${id}/terraform.tfstate`);

    const result = await deps.applyBundle({
      bundle,
      pattern,
      tfvars,
      backend: { bucket, key: `deployments/${id}/terraform.tfstate`, region: deployment.region },
      credentials,
      approvedPlan,
      freeTierMode: deployment.freeTierMode,
      eligibleInstanceTypes: eligibleTypesOf(connection.planStateJson),
      existingAlwaysOnEc2Count: await otherAlwaysOnEc2(deps, deployment.awsConnectionId, id),
      pluginCacheDir: deps.terraformPluginCacheDir,
      onLog: (line, stream) => (stream === "stderr" ? log.error(line) : log.info(line)),
    });
    const outputs = result.outputs as Record<string, string | undefined>;
    await deps.prisma.revision.update({
      where: { id: revision.id },
      data: { outputs: json(outputs) },
    });
    const missing = REQUIRED_OUTPUTS.filter((k) => !outputs[k]);
    if (missing.length)
      throw new DeployError(`Terraform outputs are missing: ${missing.join(", ")}`);
    const baseUrl = `https://${outputs.cloudfront_domain_name}`;

    // Env vars only AutoInfra can know (the public URL for CORS allow-lists,
    // NODE_ENV). Written before the build so the app starts with them; a
    // value the user set themselves always wins.
    const profile = RepoProfile.safeParse(revision.repoProfile).data;
    // Settings the code reads that have no value: often why an app won't start.
    let unsetEnv: string[] = [];
    if (profile) {
      const userSet = new Set(
        (
          await deps.prisma.envVar.findMany({ where: { deploymentId: id }, select: { name: true } })
        ).map((v) => v.name),
      );
      const provided = platformProvidedEnv(profile, pattern);
      unsetEnv = profile.envVars
        .map((v) => v.name)
        .filter((n) => !userSet.has(n) && !provided.has(n) && !RESERVED_ENV_NAME.test(n));
      for (const [name, how] of provided) {
        const value = providedValue(how, name, {
          profile,
          pattern,
          siteUrl: baseUrl,
          apiPrefix: tfvars.api_path_prefix,
          appPort: tfvars.app_port,
        });
        if (!value || userSet.has(name)) continue;
        await deps.putAppParameter({
          credentials,
          region: deployment.region,
          shortId: shortIdFor(id),
          deploymentId: id,
          name,
          value,
          isSecret: false,
        });
        await log.info(`${name}=${value} (set by AutoInfra)`);
      }
    }

    // Sec. 2.4 ledger: what this deployment holds against the account's shared allowances.
    await deps.prisma.freeTierLedgerEntry.deleteMany({ where: { deploymentId: id } });
    if (pattern === "F2") {
      await deps.prisma.freeTierLedgerEntry.create({
        data: {
          awsConnectionId: deployment.awsConnectionId,
          deploymentId: id,
          resourceKind: "ec2_always_on_instance",
          amount: 1,
        },
      });
    }

    // 2. Build + deploy the app (the buildspec handles the S3 sync, Lambda
    // code update or EC2 rollout, and CloudFront invalidation).
    await setStatus("building");
    credentials = await assume("build");
    const githubToken = await deps.githubToken(deployment.ownerId);
    const clone = await deps.cloneRepo({
      repoUrl: deployment.repoUrl,
      branch: deployment.branch,
      commitSha: revision.commitSha,
      githubToken,
    });
    try {
      const zip = buildSourceZip(clone.localPath, bundle.files, loadPlatformAppFiles());
      await log.info(
        `Uploading source at ${revision.commitSha.slice(0, 7)} (${(zip.length / 1024 / 1024).toFixed(1)} MB)`,
      );
      await deps.uploadObject(
        credentials,
        deployment.region,
        outputs.artifacts_bucket!,
        "source/latest.zip",
        zip,
      );
    } finally {
      await clone.cleanup().catch(() => undefined);
    }

    // One CodeBuild run builds and then deploys (rollout on the instance,
    // Lambda update, S3 sync): the status follows it.
    let deploying = false;
    // What the instance printed once the rollout failed (setup's errors, a
    // crashed container's logs): the failure is told from these.
    const instanceLines: string[] = [];
    const lastLines: string[] = [];
    const build = await deps.runCodeBuild({
      credentials,
      region: deployment.region,
      projectName: outputs.codebuild_project!,
      onLog: async (line) => {
        if (!deploying && DEPLOY_STEP.test(line)) {
          deploying = true;
          await setStatus("deploying");
        }
        if ((instanceLines.length || INSTANCE_OUTPUT.test(line)) && instanceLines.length < 400)
          instanceLines.push(line);
        if (lastLines.push(line) > 200) lastLines.shift();
        await log.info(`[build] ${line}`);
      },
    });
    if (build.status !== "SUCCEEDED") {
      const failed = `The CodeBuild build ${build.status.toLowerCase().replace("_", " ")} (${build.buildId})`;
      const reason =
        startupFailure(instanceLines, {
          databaseExternal: Boolean(profile?.databaseExternal),
          unsetEnv,
          failed: true,
        }) ?? buildFailure(lastLines);
      throw new DeployError(
        reason
          ? `${reason} (${failed}; the build log above has the details.)`
          : `${failed}. See the build log above.`,
      );
    }
    // Up, but its startup log says it can't reach something (its database):
    // the health check may still pass, so say it here and on the live page.
    const startupWarning = startupFailure(instanceLines, {
      databaseExternal: Boolean(profile?.databaseExternal),
      unsetEnv,
      next: "Redeploy",
    });
    if (startupWarning)
      await log.error(`The app is up, but its startup log shows a problem: ${startupWarning}`);

    // 3. Health checks through CloudFront.
    await setStatus("health_checking");
    const health = await checkHealth(deps, {
      baseUrl,
      hasBackend: pattern !== "F3",
      hasFrontend: profile ? Boolean(profile.frontend) : undefined,
      apiPathPrefix: tfvars.api_path_prefix,
      healthCheckPath: tfvars.health_check_path,
    });
    await log.info(`frontend: ${health.frontend.detail}`);
    if (health.api) await log.info(`api: ${health.api.detail}`);
    if (!health.frontend.ok || (health.api && !health.api.ok)) {
      if (pattern === "F1" && outputs.function_name) {
        const lines = await deps.recentLogLines(
          credentials,
          deployment.region,
          `/aws/lambda/${outputs.function_name}`,
        );
        if (lines.length) {
          await log.error("Recent Lambda logs:");
          for (const line of lines) await log.error(`  ${line}`);
        }
      }
      throw new DeployError(
        `Deployed, but the health check failed: ${!health.frontend.ok ? health.frontend.detail : health.api!.detail}`,
      );
    }

    await deps.prisma.revision.update({
      where: { id: revision.id },
      data: {
        status: "live",
        ...(startupWarning
          ? { outputs: json({ ...outputs, startup_warning: startupWarning }) }
          : {}),
      },
    });
    await deps.prisma.deployment.update({
      where: { id },
      data: {
        status: "live",
        liveUrl: baseUrl,
        currentRevisionId: revision.id,
        failureReason: null,
      },
    });
    await deps.prisma.auditEvent.create({
      data: {
        userId: deployment.ownerId,
        action: "deployment_applied",
        targetType: "deployment",
        targetId: id,
        metadata: json({
          revision: revision.number,
          commitSha: revision.commitSha,
          plan: result.planSummary,
        }),
      },
    });
    await log.info(`Live at ${baseUrl}`);
    await finishJob(deps, jobId);
    await log.end("succeeded");
  } catch (err) {
    const reason =
      err instanceof ApplyError && err.unapproved && revision.action === "redeploy"
        ? `Redeploy only ships new code, but your infrastructure no longer matches the last deploy (${err.unapproved.slice(0, 8).join(", ")}). Nothing was changed. Use "Re-analyze & redesign" to review an infrastructure update.`
        : err instanceof DeployError || err instanceof ApplyError
          ? err.message
          : `Deployment failed: ${err instanceof Error ? err.message : String(err)}`;
    await log.error(reason);
    await deps.prisma.revision
      .update({ where: { id: revision.id }, data: { status: "failed" } })
      .catch(() => undefined);
    await deps.prisma.auditEvent
      .create({
        data: {
          userId: deployment.ownerId,
          action: "deployment_failed",
          targetType: "deployment",
          targetId: id,
          metadata: json({ reason }),
        },
      })
      .catch(() => undefined);
    await failDeployment(deps, id, reason);
    await finishJob(deps, jobId, reason);
    await log.end("failed");
  }
}
