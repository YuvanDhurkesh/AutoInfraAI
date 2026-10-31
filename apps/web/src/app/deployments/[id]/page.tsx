"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type {
  ArchitecturePlan,
  FreeTierReport,
  GateResult,
  PlanSummary,
  RepoProfile,
  TerraformFile,
} from "@autoinfra/shared";
import { apiFetch } from "@/lib/api-client";
import { FreeTierBadge } from "@/components/free-tier-badge";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { TerraformReview } from "@/components/terraform-review";
import { JobConsole } from "@/components/job-console";
import { EnvForm } from "@/components/env-form";
import { ApprovePanel } from "@/components/approve-panel";
import { RedeployButton } from "@/components/redeploy-button";
import { RevisionHistory } from "@/components/revision-history";
import { AppLogs } from "@/components/app-logs";
import { DatabaseViewer } from "@/components/database-viewer";
import { DestroyPanel } from "@/components/destroy-panel";
import { ChangeRequest } from "@/components/change-request";
import { FailureExplainer } from "@/components/failure-explainer";
import { DiscardChange } from "@/components/discard-change";
import { PermissionUpdate } from "@/components/permission-update";

interface DeploymentDetail {
  id: string;
  repoUrl: string;
  branch: string;
  subdir: string | null;
  region: string;
  status: string;
  pattern: string | null;
  freeTierMode: "strict" | "flexible";
  failureReason: string | null;
  liveUrl: string | null;
  connection: { id: string; needsPermissionUpdate: boolean } | null;
  jobs: Array<{ id: string; kind: string; status: string }>;
  currentRevision: {
    number: number;
    commitSha: string;
    outboundIp?: string | null;
    /** What the app's startup log said was wrong although it came up (its database...). */
    startupWarning?: string | null;
  } | null;
  latestRevision: {
    number: number;
    action: string;
    status: string;
    commitSha: string;
    changePrompt: string | null;
    rollbackOf: number | null;
    repoProfile: RepoProfile | null;
    outputs?: Record<string, unknown> | null;
    architecturePlan: ArchitecturePlan | null;
    freeTierReport: FreeTierReport | null;
    planSummary: PlanSummary | null;
    terraformBundle: {
      files: TerraformFile[];
      attempts: Array<{ number: number; gates: GateResult[] }>;
      passed: boolean;
      tfvars?: { function_url_auth_type?: string };
    } | null;
  } | null;
}

const PATTERN_LABELS: Record<string, string> = {
  F1: "F1 -- Serverless (S3 + CloudFront + Lambda)",
  F2: "F2 -- Single EC2 instance",
  F3: "F3 -- Static site (S3 + CloudFront)",
};

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  // A request to start a step is in flight (the step itself then shows up as a running job).
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changePrefill, setChangePrefill] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const load = useCallback(async () => {
    const detail = (await apiFetch(`/deployments/${id}`)) as DeploymentDetail;
    setDeployment(detail);
    return detail;
  }, [id]);

  /**
   * Every step runs on the worker: starting one returns at once, and the job
   * console follows it. Analyze can chain design (and generate) server-side.
   */
  const start = useCallback(
    async (step: "analyze" | "design" | "generate", then?: string[]) => {
      setStarting(true);
      setError(null);
      try {
        await apiFetch(`/deployments/${id}/${step}`, {
          method: "POST",
          ...(then ? { body: JSON.stringify({ then }) } : {}),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : `${step} failed`);
      } finally {
        setStarting(false);
        await load();
      }
    },
    [id, load],
  );

  useEffect(() => {
    load()
      .then((detail) => {
        const auto = new URLSearchParams(window.location.search).get("start") === "1";
        if (auto && !detail.latestRevision && !autoStarted.current) {
          autoStarted.current = true;
          window.history.replaceState(null, "", `/deployments/${id}`);
          // Paste-a-link flow: every preparation step runs by itself (on the
          // server, so closing the tab doesn't stop it) and stops at the
          // review screen, where the user's one decision is Approve.
          void start("analyze", ["design", "generate"]);
        }
      })
      .catch((err) => setError(err.message));
  }, [id, load, start]);

  if (!deployment) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-24">
        <p className="text-slate-400">{error ?? "Loading..."}</p>
      </main>
    );
  }

  const revision = deployment.latestRevision;
  const profile = revision?.repoProfile ?? null;
  // The F2 instance's fixed public address, from the latest apply's outputs.
  const instanceIp =
    typeof revision?.outputs?.public_ip === "string" ? revision.outputs.public_ip : null;
  // An app is running somewhere (instance or Lambda) to read logs from.
  const reachedAws =
    !!deployment.currentRevision ||
    typeof revision?.outputs?.instance_id === "string" ||
    typeof revision?.outputs?.function_name === "string";
  // The containers this deployment's instance runs (F2); a Lambda has one log.
  const logServices =
    deployment.pattern === "F2" && profile
      ? [
          ...(profile.backend ? ["app"] : []),
          ...(profile.frontend?.isSSR ? ["web"] : []),
          ...(["postgres", "mysql", "mongo", "redis"].includes(profile.database) &&
          !profile.databaseExternal
            ? ["db"]
            : []),
          ...(profile.cache ? ["cache"] : []),
          "caddy",
        ]
      : ["app"];
  // The database container AutoInfra runs on the F2 instance, if any (the viewer's).
  const browsableDb =
    profile &&
    !profile.databaseExternal &&
    ["postgres", "mysql", "mongo"].includes(profile.database)
      ? profile.database
      : null;
  const plan = revision?.architecturePlan ?? null;
  const report = revision?.freeTierReport ?? null;
  const jobs = deployment.jobs;
  const destroyed = deployment.status === "destroyed";
  const activeJob = jobs.find((j) => j.status === "running");
  const shownJob = activeJob ?? jobs[0];
  const busy = starting || !!activeJob;
  const deploying = activeJob?.kind === "apply";
  const bundlePassed = revision?.terraformBundle?.passed === true;
  const canApprove =
    bundlePassed &&
    !busy &&
    revision?.action !== "redeploy" && // retried with the Redeploy button instead
    jobs[0]?.kind !== "destroy" && // a failed destroy is retried from the danger zone
    (deployment.status === "awaiting_approval" || deployment.status === "failed");
  const lastApplyFailed = deployment.status === "failed" && jobs[0]?.kind === "apply";
  // Designing and generating edit the latest revision, so only one that was never applied.
  const editable = !!revision && revision.number !== deployment.currentRevision?.number;
  // A revision prepared on top of a live one that hasn't been applied yet.
  const pendingChange =
    !!deployment.currentRevision &&
    !!revision &&
    revision.number !== deployment.currentRevision.number &&
    !busy &&
    !!jobs[0] &&
    !["apply", "destroy"].includes(jobs[0].kind) &&
    (deployment.status === "awaiting_approval" || deployment.status === "failed");
  const publicFunctionUrl =
    plan?.pattern === "F1" &&
    (revision?.terraformBundle?.tfvars?.function_url_auth_type === "NONE" ||
      (!revision?.terraformBundle && profile?.backend?.hasMutatingRoutes !== false));

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-1">
        <Link href="/dashboard" className="text-sm text-slate-400">
          &larr; Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">
          {deployment.repoUrl.replace("https://github.com/", "")}
        </h1>
        <p className="text-sm text-slate-400">
          {deployment.branch || "default branch"}
          {deployment.subdir ? ` / ${deployment.subdir}` : ""} &middot; {deployment.region} &middot;{" "}
          {deployment.freeTierMode} Free Tier mode
          {revision ? ` · ${revision.commitSha.slice(0, 7)}` : ""}
        </p>
      </div>

      <Stepper
        activeKind={activeJob?.kind ?? null}
        status={deployment.status}
        revision={revision}
        generating={activeJob?.kind === "generate"}
        deploying={deploying}
      />

      {deployment.status === "failed" && deployment.failureReason && !busy && (
        <div className="rounded border border-red-800 bg-red-950/60 p-4 text-sm text-red-200">
          <p className="font-medium">This step failed</p>
          <p className="mt-1 whitespace-pre-wrap">{deployment.failureReason}</p>
          {jobs[0]?.status === "failed" && (
            <FailureExplainer
              key={jobs[0].id}
              jobId={jobs[0].id}
              canRequestChange={!!deployment.currentRevision}
              onUseChange={setChangePrefill}
            />
          )}
        </div>
      )}
      {/* Before the first live revision too: a database that only accepts
          listed addresses can be what keeps the app from starting. */}
      {profile?.databaseExternal && !destroyed && !deployment.currentRevision && instanceIp && (
        <p className="text-xs text-slate-400">
          Your database is outside AWS. If it only accepts listed addresses (MongoDB Atlas Network
          Access, an IP allow list), add this instance&apos;s:{" "}
          <span className="font-mono text-slate-200">{instanceIp}</span> -- it stays the same for
          this deployment.
        </p>
      )}
      {/* Failed steps already show failureReason above; this covers errors that
          don't fail the deployment (409 already running, 503 Gemini not configured). */}
      {error && deployment.status !== "failed" && <p className="text-sm text-red-400">{error}</p>}

      {deployment.connection?.needsPermissionUpdate && !destroyed && (
        <PermissionUpdate connectionId={deployment.connection.id} />
      )}

      {destroyed && (
        <div className="rounded border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
          <p className="font-medium">Destroyed</p>
          <p className="mt-1">
            Everything this deployment created in your AWS account has been removed.
            {deployment.failureReason ? ` ${deployment.failureReason}` : ""}
          </p>
        </div>
      )}

      <div className={`flex flex-wrap gap-3 ${destroyed ? "hidden" : ""}`}>
        <button
          onClick={() => start("analyze", ["design"])}
          disabled={busy}
          className="rounded border border-slate-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {profile ? "Re-analyze & redesign" : "Analyze repository"}
        </button>
        {profile && editable && revision.status !== "failed" && (
          <button
            onClick={() => start("design")}
            disabled={busy}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {plan ? "Redesign" : "Design architecture"}
          </button>
        )}
        {plan && editable && (
          <button
            onClick={() => start("generate")}
            disabled={busy}
            className="rounded bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {revision?.terraformBundle ? "Regenerate Terraform" : "Generate & validate Terraform"}
          </button>
        )}
      </div>

      {deployment.liveUrl && deployment.currentRevision && (
        <section className="flex flex-col gap-3 rounded border border-emerald-700 bg-emerald-950/30 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-emerald-300">Live</span>
            <a
              href={deployment.liveUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-lg text-white underline"
            >
              {deployment.liveUrl}
            </a>
            <button
              onClick={() => navigator.clipboard.writeText(deployment.liveUrl!)}
              className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-200"
            >
              Copy
            </button>
            <span className="text-xs text-slate-400">
              revision #{deployment.currentRevision.number} &middot;{" "}
              {deployment.currentRevision.commitSha.slice(0, 7)}
            </span>
          </div>
          {deployment.currentRevision.outboundIp && (
            <p className="text-xs text-slate-400">
              The app connects out from{" "}
              <span className="font-mono text-slate-200">
                {deployment.currentRevision.outboundIp}
              </span>{" "}
              -- allow this address in a hosted database&apos;s network access list.
            </p>
          )}
          {deployment.currentRevision.startupWarning && (
            <p className="rounded border border-amber-700 bg-amber-950/40 p-2 text-sm text-amber-200">
              The app is up, but its startup log shows a problem:{" "}
              {deployment.currentRevision.startupWarning}
            </p>
          )}
          {deployment.status !== "live" && (
            <p className="text-sm text-slate-300">
              {busy
                ? "Your site keeps serving this revision while the new one is prepared."
                : deployment.status === "awaiting_approval"
                  ? "A new revision is waiting for your approval below -- until then your site keeps serving this one."
                  : "The last change didn't go live -- your site is still serving this revision."}
            </p>
          )}
          {/* Redeploying needs nothing else pending: approve or discard that first. */}
          {(deployment.status === "live" || deployment.status === "failed") && (
            <RedeployButton deploymentId={deployment.id} disabled={busy} onStarted={load} />
          )}
        </section>
      )}

      {shownJob && (
        <JobConsole
          key={shownJob.id}
          jobId={shownJob.id}
          kind={shownJob.kind}
          live={shownJob.status === "running"}
          onFinished={load}
        />
      )}

      {revision?.terraformBundle && (
        <TerraformReview
          bundle={revision.terraformBundle}
          planSummary={revision.planSummary}
          report={report}
          freeTierMode={deployment.freeTierMode}
        />
      )}

      {bundlePassed && !destroyed && <EnvForm deploymentId={deployment.id} disabled={busy} />}

      {canApprove && (
        <ApprovePanel
          deploymentId={deployment.id}
          retry={lastApplyFailed}
          hasPaidResources={(report?.denyListViolations.length ?? 0) > 0}
          dataLoss={revision?.planSummary?.dataBearingDestroys ?? []}
          changePrompt={revision?.changePrompt}
          rollbackOf={revision?.rollbackOf}
          onStarted={load}
        />
      )}

      {pendingChange && (
        <DiscardChange deploymentId={deployment.id} revision={revision!.number} onDone={load} />
      )}

      {deployment.currentRevision &&
        !busy &&
        (deployment.status === "live" || deployment.status === "failed") && (
          <ChangeRequest
            deploymentId={deployment.id}
            disabled={busy}
            prefill={changePrefill}
            onStarted={load}
          />
        )}

      <RevisionHistory
        deploymentId={deployment.id}
        refreshKey={`${deployment.status}-${revision?.number ?? 0}-${revision?.status ?? ""}`}
        canRollback={!busy && (deployment.status === "live" || deployment.status === "failed")}
        onRollbackStarted={load}
      />

      {profile && <ScanSummary profile={profile} />}

      {plan && report && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Proposed architecture</h2>
            {!revision?.planSummary && <FreeTierBadge fit={report.fit} />}
          </div>
          <p className="text-sm text-slate-300">
            <span className="font-medium">{PATTERN_LABELS[plan.pattern] ?? plan.pattern}.</span>{" "}
            {plan.summary}
          </p>
          <MermaidDiagram source={plan.mermaidDiagram} />

          {publicFunctionUrl && (
            <div className="rounded border border-amber-800 bg-amber-950/30 p-4 text-sm text-amber-200">
              <p className="font-medium">Your API&apos;s Lambda URL will be publicly reachable</p>
              <p className="mt-1">
                Your backend has write routes (POST/PUT/PATCH/DELETE). CloudFront&apos;s signed
                access to Lambda breaks browser write requests, so the Lambda Function URL is public
                and CloudFront sits in front of it. Anyone who finds the URL can call it directly,
                bypassing CloudFront -- your app&apos;s own authentication is what protects it.
              </p>
            </div>
          )}

          {!revision?.planSummary && report.denyListViolations.length > 0 && (
            <div className="rounded border border-red-800 bg-red-950/40 p-4 text-sm">
              <p className="font-medium text-red-200">Not Free-Tier-compliant</p>
              <ul className="mt-2 list-disc pl-5 text-red-300">
                {report.denyListViolations.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">Resource</th>
                  <th className="py-2 font-medium">Purpose</th>
                </tr>
              </thead>
              <tbody>
                {plan.components.map((c) => (
                  <tr
                    key={`${c.service}.${c.name}`}
                    className="border-t border-slate-800 align-top"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">
                      {c.service}.{c.name}
                      {c.instanceType ? (
                        <div className="text-slate-500">{c.instanceType}</div>
                      ) : null}
                      {c.storageGb !== undefined ? (
                        <div className="text-slate-500">{c.storageGb} GB</div>
                      ) : null}
                    </td>
                    <td className="py-2 text-slate-300">{c.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <ListCard
              title="Risks"
              items={[...plan.risks, ...(revision?.planSummary ? [] : report.warnings)]}
            />
            <ListCard title="Assumptions" items={plan.assumptions} />
          </div>
        </section>
      )}
      {!destroyed && reachedAws && (deployment.pattern === "F1" || deployment.pattern === "F2") && (
        <AppLogs deploymentId={deployment.id} services={logServices} />
      )}
      {!destroyed && reachedAws && deployment.pattern === "F2" && browsableDb && (
        <DatabaseViewer deploymentId={deployment.id} kind={browsableDb} />
      )}
      {!destroyed && (
        <DestroyPanel
          deploymentId={deployment.id}
          repoName={deployment.repoUrl.replace("https://github.com/", "")}
          disabled={busy}
          onStarted={load}
        />
      )}
    </main>
  );
}

function Stepper({
  activeKind,
  status,
  revision,
  generating,
  deploying,
}: {
  activeKind: string | null;
  status: string;
  revision: DeploymentDetail["latestRevision"];
  generating: boolean;
  deploying: boolean;
}) {
  const done = (cond: boolean) => (cond ? "done" : "todo");
  const steps: Array<{ label: string; state: "done" | "running" | "todo" }> = [
    {
      label: "Analyze repo",
      state: activeKind === "analyze" ? "running" : done(!!revision?.repoProfile),
    },
    {
      label: "Design architecture",
      state: activeKind === "design" ? "running" : done(!!revision?.architecturePlan),
    },
    {
      label: "Generate & validate Terraform",
      state: generating
        ? "running"
        : done(
            !!revision?.terraformBundle &&
              revision.status !== "generating" &&
              (revision as { terraformBundle: { passed: boolean } }).terraformBundle.passed,
          ),
    },
    {
      label: "Approve",
      state: status === "awaiting_approval" ? "running" : done(deploying || status === "live"),
    },
    { label: "Deploy", state: deploying ? "running" : done(status === "live") },
  ];
  return (
    <ol className="flex flex-wrap gap-2 text-sm">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={`rounded-full border px-3 py-1 ${
            s.state === "done"
              ? "border-emerald-700 text-emerald-300"
              : s.state === "running"
                ? "animate-pulse border-indigo-500 text-indigo-300"
                : "border-slate-700 text-slate-500"
          }`}
        >
          {i + 1}. {s.label}
          {s.state === "running" && s.label !== "Approve" ? "..." : ""}
        </li>
      ))}
    </ol>
  );
}

function ScanSummary({ profile }: { profile: RepoProfile }) {
  const warnings: string[] = [];
  if (profile.frontend?.hardcodedLocalhostUrls.length) {
    warnings.push(
      `Hardcoded localhost URLs will break in production: ${profile.frontend.hardcodedLocalhostUrls.slice(0, 3).join(", ")}`,
    );
  }
  if (profile.secretsDetected.length) {
    warnings.push(
      `${profile.secretsDetected.length} possible secret(s) committed to the repository: ${profile.secretsDetected.slice(0, 3).join("; ")}. Rotate them -- they were not sent to the AI.`,
    );
  }
  if (profile.backend?.hardcodedDatabaseHosts?.length) {
    warnings.push(
      `The backend's database address is written in its code (${profile.backend.hardcodedDatabaseHosts.slice(0, 2).join("; ")}), so the deployed app won't use the database AutoInfra sets up: localhost isn't where it runs once deployed, and a hosted address means that other server. Change the code to read its settings from env vars (for example DB_HOST, DB_USER, DB_PASSWORD and DB_NAME, or one DATABASE_URL) -- AutoInfra fills those in -- then push and redeploy. If your data really lives on that hosted server, tick "Database hosted outside AWS" instead -- and still move its password out of the code, where anyone who can read the repository can see it.`,
    );
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">What we found</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate-400">Frontend</dt>
        <dd>
          {profile.frontend
            ? `${profile.frontend.framework}${profile.frontend.isSSR ? " (SSR)" : ""}`
            : "none detected"}
        </dd>
        <dt className="text-slate-400">Backend</dt>
        <dd>
          {profile.backend
            ? `${profile.backend.language}${profile.backend.framework ? ` / ${profile.backend.framework}` : ""}${
                profile.backend.port ? `, port ${profile.backend.port}` : ""
              }${profile.backend.usesWebSockets ? ", WebSockets" : ""}`
            : "none detected"}
        </dd>
        <dt className="text-slate-400">Database</dt>
        <dd>
          {profile.database}
          {profile.databaseExternal && profile.database !== "none"
            ? ` (hosted ${profile.databaseHostedAt ? `at ${profile.databaseHostedAt}, per the repo's env template` : "outside AWS"} -- enter its connection settings below)`
            : ""}
        </dd>
        <dt className="text-slate-400">Env vars</dt>
        <dd>{profile.envVars.map((v) => v.name).join(", ") || "none detected"}</dd>
      </dl>
      {warnings.length > 0 && <ListCard title="Warnings" items={warnings} tone="amber" />}
    </section>
  );
}

function ListCard({ title, items, tone }: { title: string; items: string[]; tone?: "amber" }) {
  if (items.length === 0) return null;
  return (
    <div
      className={`rounded border p-4 text-sm ${
        tone === "amber" ? "border-amber-800 bg-amber-950/30 text-amber-200" : "border-slate-700"
      }`}
    >
      <p className="font-medium">{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-300">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
