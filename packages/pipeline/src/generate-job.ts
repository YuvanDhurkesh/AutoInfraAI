import { Prisma } from "@prisma/client";
import { ArchitecturePlan, RepoProfile, TerraformBundle } from "@autoinfra/shared";
import { TerraformGenerationError } from "@autoinfra/llm";
import { blueprintFor, renderBlueprint } from "@autoinfra/terraform-reference";
import type { JobPayload, PipelineDeps } from "./deps.js";
import { failDeployment, finishJob, jobLogger } from "./job-log.js";
import { eligibleTypesOf, json, otherAlwaysOnEc2 } from "./common.js";
import { buildTfVars } from "./tfvars.js";

/**
 * Sec. 5 Step 4: Terraform from AutoInfra's blueprint when one fits (Gemini
 * only for repos without one, change requests, or to repair a blueprint that
 * fails a gate); the gauntlet validates it; up to 4 attempts.
 */
export async function runGenerateJob(deps: PipelineDeps, payload: JobPayload): Promise<void> {
  const { jobId, deploymentId: id } = payload;
  const log = jobLogger(deps, jobId);
  const deployment = await deps.prisma.deployment.findUniqueOrThrow({ where: { id } });
  const revision = await deps.prisma.revision.findFirstOrThrow({
    where: { deploymentId: id },
    orderBy: { number: "desc" },
  });

  try {
    // A rollback re-validates the files of the revision it restores; no model call.
    const reuse =
      revision.action === "rollback"
        ? TerraformBundle.parse({
            files: (revision.terraformBundle as { files?: unknown } | null)?.files,
          })
        : undefined;
    const profile = RepoProfile.parse(revision.repoProfile);
    const plan = ArchitecturePlan.parse(revision.architecturePlan);
    const connection = await deps.prisma.awsConnection.findUniqueOrThrow({
      where: { id: deployment.awsConnectionId },
    });
    if (!connection.roleArn) throw new Error("The AWS connection has no role.");

    const assume = () =>
      deps.assumeDeployRole({
        roleArn: connection.roleArn!,
        externalId: connection.externalId,
        region: connection.region,
        sessionName: `autoinfra-generate-${id.slice(0, 8)}`,
        durationSeconds: 3600,
      });
    const credentials = await assume();

    // Once anything was applied, plan against the real state: a retry or
    // change then shows "update X" rather than "create everything", and the
    // apply step's approved-plan check can match it.
    let stateBackend: { bucket: string; key: string; region: string } | undefined;
    if (await deps.prisma.job.count({ where: { deploymentId: id, kind: "apply" } })) {
      const { accountId } = await deps.getCallerIdentity(credentials, deployment.region);
      if (accountId) {
        stateBackend = {
          bucket: await deps.ensureStateBucket(credentials, deployment.region, accountId),
          key: `deployments/${id}/terraform.tfstate`,
          region: deployment.region,
        };
        await log.info("Planning against the deployment's current Terraform state");
      }
    }
    const eligibleInstanceTypes = eligibleTypesOf(connection.planStateJson);
    const existingAlwaysOnEc2Count = await otherAlwaysOnEc2(deps, deployment.awsConnectionId, id);
    const tfvars = buildTfVars({
      deploymentId: id,
      ownerId: deployment.ownerId,
      region: deployment.region,
      plan,
      profile,
      eligibleInstanceTypes,
    });

    // A change request edits the files that are live now.
    let change: { files: Array<{ path: string; content: string }>; request: string } | undefined;
    if (revision.action === "change" && revision.changePrompt && deployment.currentRevisionId) {
      const live = await deps.prisma.revision.findUnique({
        where: { id: deployment.currentRevisionId },
      });
      const files = (live?.terraformBundle as { files?: unknown } | null)?.files;
      if (!Array.isArray(files)) throw new Error("The live revision has no Terraform to change.");
      change = {
        files: files as Array<{ path: string; content: string }>,
        request: revision.changePrompt,
      };
      await log.info(`Change request: "${revision.changePrompt}"`);
    }

    // A fresh generation of a repo the blueprints cover needs no model.
    const blueprint = blueprintFor(profile);
    const initial =
      !reuse && !change && blueprint.supported && blueprint.pattern === plan.pattern
        ? {
            files: renderBlueprint({
              profile,
              pattern: plan.pattern,
              apiPathPrefix: tfvars.api_path_prefix,
              appPort: tfvars.app_port,
            }),
          }
        : undefined;
    if (!deps.llm && !reuse && !initial)
      throw new Error(
        change
          ? "Change requests need Gemini, which is not configured on the worker (GEMINI_API_KEY/GEMINI_MODEL)."
          : "Gemini is not configured on the worker (GEMINI_API_KEY/GEMINI_MODEL), and no blueprint fits this repository.",
      );

    await log.info(
      reuse
        ? `Rolling back to revision ${revision.rollbackOf}: re-checking its Terraform against what's running now`
        : change
          ? `Editing the live Terraform (pattern ${plan.pattern}, ${deployment.region})`
          : initial
            ? `Writing Terraform from AutoInfra's ${plan.pattern} blueprint (${deployment.region}) -- no AI request needed`
            : `Generating Terraform for pattern ${plan.pattern} in ${deployment.region}`,
    );
    let validatingMarked = false;
    const result = await deps.generateAndValidate(deps.llm, {
      plan,
      profile,
      tfvars,
      freeTierMode: deployment.freeTierMode,
      eligibleInstanceTypes,
      existingAlwaysOnEc2Count,
      credentials,
      refreshCredentials: assume,
      stateBackend,
      change,
      reuse,
      initial,
      pluginCacheDir: deps.terraformPluginCacheDir,
      onGate: async (attempt, gate) => {
        if (!validatingMarked) {
          validatingMarked = true;
          await deps.prisma.deployment.update({ where: { id }, data: { status: "validating" } });
        }
        await log.info(
          `attempt ${attempt} · ${gate.gate}: ${gate.status} (${(gate.durationMs / 1000).toFixed(1)}s)`,
        );
        for (const e of gate.errors) await log.error(`  ${e}`);
      },
      onAttempt: async (attempt) => {
        const failed = attempt.gates.filter((g) => g.status === "failed").map((g) => g.gate);
        if (failed.length)
          await log.info(
            `attempt ${attempt.number} failed at: ${failed.join(", ")}${deps.llm ? " -- asking Gemini to fix it" : ""}`,
          );
      },
    });

    await deps.prisma.revision.update({
      where: { id: revision.id },
      data: {
        terraformBundle: json({
          files: result.bundle?.files ?? [],
          attempts: result.attempts,
          passed: result.passed,
          tfvars,
        }),
        planSummary: result.planSummary ? json(result.planSummary) : Prisma.JsonNull,
        ...(result.freeTierReport ? { freeTierReport: json(result.freeTierReport) } : {}),
        status: result.passed ? "awaiting_approval" : "failed",
      },
    });

    if (result.passed) {
      await log.info("All gates passed. Waiting for your approval.");
      await deps.prisma.deployment.update({ where: { id }, data: { status: "awaiting_approval" } });
      await finishJob(deps, jobId);
      await log.end("succeeded");
    } else {
      throw new Error(result.failureReason ?? "Terraform validation failed.");
    }
  } catch (err) {
    const reason =
      err instanceof TerraformGenerationError || err instanceof Error
        ? err.message
        : "Terraform generation failed unexpectedly.";
    await log.error(reason);
    await deps.prisma.revision
      .update({ where: { id: revision.id }, data: { status: "failed" } })
      .catch(() => undefined);
    await failDeployment(deps, id, reason);
    await finishJob(deps, jobId, reason);
    await log.end("failed");
  }
}
