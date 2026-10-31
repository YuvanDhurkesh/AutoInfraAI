import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { RepoProfile, type ArchitecturePlan } from "@autoinfra/shared";
import { scanRepo } from "@autoinfra/scanner";
import { designArchitecture, DesignFailedError, LlmUnavailableError } from "@autoinfra/llm";
import { architectureToResources, evaluateFreeTier } from "@autoinfra/free-tier-policy";
import { blueprintFor, designBlueprint } from "@autoinfra/terraform-reference";
import type { JobPayload, PipelineDeps } from "./deps.js";
import { failDeployment, finishJob, jobLogger, type JobLogger } from "./job-log.js";
import { alwaysOnEc2Holders, eligibleTypesOf, json } from "./common.js";
import { startJobRow } from "./job-rows.js";
import { pickInstanceType } from "./tfvars.js";

/** A failure whose message is written for the user. */
class StepFailed extends Error {}

/** Sec. 5 Step 1: clone the branch head and scan it. No model call. */
export async function runAnalyzeJob(deps: PipelineDeps, payload: JobPayload): Promise<void> {
  const { jobId, deploymentId: id } = payload;
  const log = jobLogger(deps, jobId);
  const deployment = await deps.prisma.deployment.findUniqueOrThrow({ where: { id } });
  let revisionId: string | undefined;

  try {
    // No branch given: the repository's own default (main, master, trunk...).
    await log.info(
      `Cloning ${deployment.repoUrl} (${deployment.branch ? `branch ${deployment.branch}` : "its default branch"})`,
    );
    const githubToken = await deps.githubToken(deployment.ownerId);
    let clone;
    try {
      clone = await deps.cloneRepo({
        repoUrl: deployment.repoUrl,
        branch: deployment.branch || undefined,
        githubToken,
      });
    } catch {
      // Never echo git's raw error: it can contain the tokenized URL. A
      // branch that doesn't exist (main in a master repo) is said plainly.
      const defaultBranch = deployment.branch
        ? await deps.defaultBranch?.({ repoUrl: deployment.repoUrl, githubToken })
        : undefined;
      throw new StepFailed(
        defaultBranch && defaultBranch !== deployment.branch
          ? `This repository has no branch "${deployment.branch}": its default branch is "${defaultBranch}". Create the deployment again with Branch "${defaultBranch}", or leave Branch empty to use the default branch.`
          : `Could not clone ${deployment.repoUrl} at ${deployment.branch ? `branch "${deployment.branch}"` : "its default branch"}. Check the URL${deployment.branch ? " and branch" : ""}${githubToken ? "" : ", and connect GitHub if the repository is private"}.`,
      );
    }
    // Record the branch found, so redeploys fetch that branch's newest commit.
    const branch = deployment.branch || clone.branch || "";
    if (!deployment.branch && branch) {
      await deps.prisma.deployment.update({ where: { id }, data: { branch } });
      await log.info(`Default branch: ${branch}`);
    }

    let profile: RepoProfile;
    try {
      if (deployment.subdir && !fs.existsSync(path.join(clone.localPath, deployment.subdir))) {
        throw new StepFailed(
          `Subdirectory "${deployment.subdir}" does not exist in the repository.`,
        );
      }
      await log.info(`Scanning commit ${clone.commitSha.slice(0, 7)}`);
      profile = scanRepo(clone.localPath, {
        repoUrl: deployment.repoUrl,
        commitSha: clone.commitSha,
        branch,
        subdir: deployment.subdir ?? undefined,
        externalDatabase: deployment.externalDatabase,
      });
    } finally {
      await clone.cleanup().catch(() => undefined);
    }

    // Re-analyzing a draft that never reached the apply step replaces it
    // instead of piling up revisions; anything that was applied (or was a
    // redeploy) stays in history.
    const latest = await deps.prisma.revision.findFirst({
      where: { deploymentId: id },
      orderBy: { number: "desc" },
    });
    const everApplied = latest
      ? await deps.prisma.job.count({ where: { revisionId: latest.id, kind: "apply" } })
      : 0;
    const reusable =
      latest &&
      latest.action !== "redeploy" &&
      !latest.discardedAt &&
      latest.id !== deployment.currentRevisionId &&
      !everApplied &&
      ["analyzing", "designing", "failed"].includes(latest.status);
    const revision = reusable
      ? await deps.prisma.revision.update({
          where: { id: latest.id },
          data: {
            commitSha: profile.commitSha,
            repoProfile: json(profile),
            architecturePlan: Prisma.JsonNull,
            freeTierReport: Prisma.JsonNull,
            status: "analyzing",
          },
        })
      : await deps.prisma.revision.create({
          data: {
            deploymentId: id,
            number: (latest?.number ?? 0) + 1,
            commitSha: profile.commitSha,
            repoProfile: json(profile),
            status: "analyzing",
            action: deployment.currentRevisionId ? "change" : "initial",
          },
        });
    revisionId = revision.id;
    await deps.prisma.job.update({ where: { id: jobId }, data: { revisionId } });
    for (const line of describeProfile(profile)) await log.info(line);

    if (profile.unsupportedReasons.length > 0) {
      throw new StepFailed(profile.unsupportedReasons.join(" "));
    }

    await deps.prisma.revision.update({ where: { id: revisionId }, data: { status: "designing" } });
    await deps.prisma.deployment.update({ where: { id }, data: { status: "designing" } });
    await complete(deps, payload, log, revisionId);
  } catch (err) {
    const reason =
      err instanceof StepFailed ? err.message : "Repository analysis failed unexpectedly.";
    if (!(err instanceof StepFailed)) console.error("analyze failed", err);
    await fail(deps, payload, log, reason, revisionId);
  }
}

/**
 * Sec. 5 Step 2: the architecture. Repos AutoInfra's blueprints cover get the
 * blueprint's design (no model call); anything else is designed by Gemini.
 * Either way AutoInfra computes the Free Tier report itself.
 */
export async function runDesignJob(deps: PipelineDeps, payload: JobPayload): Promise<void> {
  const { jobId, deploymentId: id } = payload;
  const log = jobLogger(deps, jobId);
  const deployment = await deps.prisma.deployment.findUniqueOrThrow({ where: { id } });
  const revision = await deps.prisma.revision.findFirst({
    where: { deploymentId: id },
    orderBy: { number: "desc" },
  });

  try {
    const parsed = RepoProfile.safeParse(revision?.repoProfile);
    if (!revision || !parsed.success || revision.status === "failed") {
      throw new StepFailed("Analyze the repository first.");
    }
    const profile = parsed.data;
    const connection = await deps.prisma.awsConnection.findUniqueOrThrow({
      where: { id: deployment.awsConnectionId },
    });
    const eligibleInstanceTypes = eligibleTypesOf(connection.planStateJson);
    const holders = await alwaysOnEc2Holders(deps, deployment.awsConnectionId, id);
    const existingAlwaysOnEc2Count = holders.length;

    const blueprint = blueprintFor(profile);
    let plan: ArchitecturePlan;
    if (blueprint.supported) {
      await log.info(
        `Using AutoInfra's tested ${blueprint.pattern} blueprint for this repo -- no AI request needed (${deployment.freeTierMode} Free Tier mode; ${deployment.region})`,
      );
      plan = designBlueprint(profile, {
        pattern: blueprint.pattern,
        instanceType: pickInstanceType(eligibleInstanceTypes),
        apiPathPrefix: "/api",
      });
    } else {
      if (!deps.llm)
        throw new StepFailed(
          `AutoInfra has no blueprint for this repository (${blueprint.reason}), and Gemini is not configured on the worker to design one.`,
        );
      await log.info(
        `No blueprint fits this repository (${blueprint.reason}); asking Gemini for an architecture (the scan suggests ${profile.recommendedPattern ?? "no pattern"}; ${deployment.freeTierMode} Free Tier mode; ${deployment.region})`,
      );
      plan = await designArchitecture(deps.llm, profile, {
        region: deployment.region,
        freeTierMode: deployment.freeTierMode,
        allowRds: deployment.allowRds,
        eligibleInstanceTypes,
        existingAlwaysOnEc2Count,
      });
    }
    // The authoritative report -- computed here, never taken from the model.
    const freeTierReport = evaluateFreeTier({
      plan: { resources: architectureToResources(plan) },
      freeTierMode: deployment.freeTierMode,
      eligibleInstanceTypes: eligibleInstanceTypes.length ? eligibleInstanceTypes : undefined,
      existingAlwaysOnEc2Count,
    });
    // Gemini's designs are already held to strict mode while it designs; a
    // blueprint is fixed, so say plainly what stands in the way.
    if (
      blueprint.supported &&
      deployment.freeTierMode === "strict" &&
      freeTierReport.denyListViolations.length
    ) {
      // Another person's deployment on the same AWS account is not named.
      const takenBy = holders.map((h) =>
        h.ownerId === deployment.ownerId
          ? `${h.repoUrl.replace("https://github.com/", "")}${h.subdir ? ` (${h.subdir})` : ""}, ${h.status.replaceAll("_", " ")}`
          : "another AutoInfra user's deployment",
      );
      throw new StepFailed(
        `This app needs ${plan.pattern === "F2" ? "an always-on EC2 instance" : "resources"} that strict Free Tier mode doesn't allow here: ${freeTierReport.denyListViolations.join("; ")}. ${
          plan.pattern === "F2" && takenBy.length
            ? `This AWS account's free instance is used by ${takenBy.join("; ")}: destroy that deployment, then retry this one -- or use flexible mode.`
            : "Use flexible mode to deploy it anyway."
        }`,
      );
    }

    await deps.prisma.revision.update({
      where: { id: revision.id },
      data: {
        architecturePlan: json(plan),
        freeTierReport: json(freeTierReport),
        status: "designing",
      },
    });
    await deps.prisma.deployment.update({ where: { id }, data: { pattern: plan.pattern } });
    await log.info(`Design: ${plan.pattern} -- ${plan.summary}`);
    await log.info(
      `Free Tier check (computed by AutoInfra, not the model): ${freeTierReport.fit.replace("_", " ")}${
        freeTierReport.denyListViolations.length
          ? ` -- ${freeTierReport.denyListViolations.join("; ")}`
          : ""
      }`,
    );
    await complete(deps, payload, log, revision.id);
  } catch (err) {
    const reason =
      err instanceof StepFailed || err instanceof LlmUnavailableError
        ? err.message
        : err instanceof DesignFailedError
          ? `${err.message} Last validation errors: ${(err.attempts.at(-1) ?? []).slice(0, 5).join("; ")}`
          : "Architecture design failed (Gemini request error).";
    if (!(err instanceof StepFailed)) console.error("design failed", err);
    await fail(deps, payload, log, reason);
  }
}

/**
 * Finish this step and, if the request chained more, start the next one in
 * the same transaction -- so the page never sees the deployment idle mid-way,
 * and nothing else can slip in between.
 */
async function complete(
  deps: PipelineDeps,
  payload: JobPayload,
  log: JobLogger,
  revisionId: string,
): Promise<void> {
  const { jobId, deploymentId: id } = payload;
  const [next, ...rest] = payload.then ?? [];
  if (!next) {
    await finishJob(deps, jobId);
    await log.end("succeeded");
    return;
  }

  let job;
  try {
    job = await startJobRow(deps.prisma, {
      deploymentId: id,
      kind: next,
      revisionId,
      handoffFrom: jobId,
    });
  } catch {
    await finishJob(deps, jobId);
    await log.info(`Stopped here: another step started before ${next} could.`);
    await log.end("succeeded");
    return;
  }
  await deps.prisma.deployment.update({
    where: { id },
    data: { status: next === "design" ? "designing" : "generating", failureReason: null },
  });
  if (next === "generate") {
    await deps.prisma.revision.update({
      where: { id: revisionId },
      data: { status: "generating" },
    });
  }
  await log.info(
    next === "design"
      ? "Next: designing the architecture"
      : "Next: generating and validating Terraform",
  );
  try {
    await deps.enqueue({ kind: next, jobId: job.id, deploymentId: id, then: rest });
  } catch {
    const reason = `Could not start the ${next} step. Run it again from the deployment page.`;
    await failDeployment(deps, id, reason);
    await finishJob(deps, job.id, reason);
  }
  await log.end("succeeded");
}

async function fail(
  deps: PipelineDeps,
  payload: JobPayload,
  log: JobLogger,
  reason: string,
  revisionId?: string,
): Promise<void> {
  await log.error(reason);
  if (revisionId) {
    await deps.prisma.revision
      .update({ where: { id: revisionId }, data: { status: "failed" } })
      .catch(() => undefined);
  }
  // The deployment shows the failure before the job stops counting as running.
  await failDeployment(deps, payload.deploymentId, reason);
  await finishJob(deps, payload.jobId, reason);
  await log.end("failed");
}

/** What the scan found, as log lines. */
function describeProfile(profile: RepoProfile): string[] {
  const lines = [
    `Frontend: ${
      profile.frontend
        ? `${profile.frontend.framework}${profile.frontend.isSSR ? " (SSR)" : ""} in ${profile.frontend.rootDir}`
        : "none"
    }`,
    `Backend: ${
      profile.backend
        ? `${profile.backend.framework ?? profile.backend.language} in ${profile.backend.rootDir}${
            profile.backend.port ? `, port ${profile.backend.port}` : ""
          }`
        : "none"
    }`,
    `Database: ${profile.database}`,
    `Env vars found: ${profile.envVars.length ? profile.envVars.map((v) => v.name).join(", ") : "none"}`,
  ];
  if (profile.secretsDetected.length) {
    lines.push(
      `${profile.secretsDetected.length} possible secret(s) committed to the repo -- they are not sent to the AI`,
    );
  }
  if (profile.recommendedPattern) lines.push(`Suggested pattern: ${profile.recommendedPattern}`);
  return lines;
}
