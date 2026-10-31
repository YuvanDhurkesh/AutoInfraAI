"use client";

import { useCallback, useEffect, useState } from "react";
import type { FileDiff } from "@autoinfra/shared";
import { apiFetch } from "@/lib/api-client";

interface RevisionRow {
  number: number;
  action: "initial" | "change" | "rollback" | "redeploy";
  status: string;
  isCurrent: boolean;
  commitSha: string;
  changePrompt: string | null;
  rollbackOf: number | null;
  pattern: string | null;
  validated: boolean;
  plan: { adds: number; changes: number; destroys: number; replaces: number } | null;
  createdAt: string;
}

interface RevisionDiff {
  from: { number: number; commitSha: string } | null;
  to: { number: number; commitSha: string };
  commitChanged: boolean;
  compareUrl: string | null;
  pattern: { from: string | null; to: string | null };
  components: {
    added: string[];
    removed: string[];
    changed: Array<{ name: string; before: string; after: string }>;
  };
  files: FileDiff[];
}

const ACTION_LABELS: Record<RevisionRow["action"], string> = {
  initial: "First deploy",
  change: "Change",
  rollback: "Rollback",
  redeploy: "Redeploy",
};

const STATUS_STYLES: Record<string, string> = {
  live: "border-emerald-700 text-emerald-300",
  failed: "border-red-800 text-red-300",
  superseded: "border-slate-700 text-slate-400",
  abandoned: "border-slate-800 text-slate-500",
  discarded: "border-slate-800 text-slate-500",
};

/** Sec. 8: every revision of a deployment, and what changed between them. */
export function RevisionHistory({
  deploymentId,
  refreshKey,
  canRollback,
  onRollbackStarted,
}: {
  deploymentId: string;
  refreshKey: string;
  /** Live, with nothing in progress. */
  canRollback: boolean;
  onRollbackStarted: () => void;
}) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  async function rollback(number: number) {
    setRollingBack(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/rollback`, {
        method: "POST",
        body: JSON.stringify({ toRevision: number }),
      });
      setConfirming(null);
      onRollbackStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not start the rollback");
    } finally {
      setRollingBack(false);
    }
  }

  useEffect(() => {
    apiFetch(`/deployments/${deploymentId}/revisions`)
      .then(setRows)
      .catch((err) => setError(err.message));
  }, [deploymentId, refreshKey]);

  const toggle = useCallback(
    async (number: number) => {
      if (open === number) {
        setOpen(null);
        return;
      }
      setOpen(number);
      setDiff(null);
      try {
        setDiff(await apiFetch(`/deployments/${deploymentId}/revisions/${number}/diff`));
      } catch (err) {
        setError(err instanceof Error ? err.message : "could not load the diff");
      }
    },
    [deploymentId, open],
  );

  if (!rows || rows.length === 0) return null;
  const livePattern = rows.find((r) => r.isCurrent)?.pattern;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">History</h2>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <ol className="flex flex-col divide-y divide-slate-800 rounded border border-slate-700">
        {rows.map((r) => (
          <li key={r.number} className="flex flex-col gap-2 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-slate-400">#{r.number}</span>
              <span className="font-medium">{ACTION_LABELS[r.action]}</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[r.status] ?? "border-indigo-700 text-indigo-300"}`}
              >
                {r.isCurrent ? "live now" : r.status.replace("_", " ")}
              </span>
              <span className="font-mono text-xs text-slate-400">{r.commitSha.slice(0, 7)}</span>
              {r.pattern && <span className="text-xs text-slate-500">{r.pattern}</span>}
              {r.plan && r.action !== "redeploy" && (
                <span className="text-xs text-slate-500">
                  +{r.plan.adds} ~{r.plan.changes} -{r.plan.destroys}
                  {r.plan.replaces ? ` ±${r.plan.replaces}` : ""}
                </span>
              )}
              <span className="ml-auto text-xs text-slate-500">
                {new Date(r.createdAt).toLocaleString()}
              </span>
              {r.number > 1 && (
                <button onClick={() => toggle(r.number)} className="text-xs text-indigo-300">
                  {open === r.number ? "Hide changes" : "View changes"}
                </button>
              )}
            </div>
            {r.changePrompt && <p className="text-slate-400">&ldquo;{r.changePrompt}&rdquo;</p>}
            {r.rollbackOf && <p className="text-slate-400">Restores #{r.rollbackOf}</p>}
            {canRollback &&
              r.status === "superseded" &&
              r.validated &&
              r.pattern === livePattern &&
              (confirming === r.number ? (
                <div className="flex flex-wrap items-center gap-2 text-slate-300">
                  <span>
                    Restore #{r.number}&apos;s infrastructure and commit{" "}
                    <code>{r.commitSha.slice(0, 7)}</code>? AutoInfra re-checks it and shows you the
                    plan first.
                  </span>
                  <button
                    onClick={() => rollback(r.number)}
                    disabled={rollingBack}
                    className="rounded bg-indigo-500 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {rollingBack ? "Starting..." : "Prepare rollback"}
                  </button>
                  <button onClick={() => setConfirming(null)} className="text-xs text-slate-400">
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(r.number)}
                  className="self-start text-xs text-amber-300"
                >
                  Roll back to this
                </button>
              ))}
            {open === r.number &&
              (diff ? <DiffView diff={diff} /> : <p className="text-slate-500">Loading...</p>)}
          </li>
        ))}
      </ol>
    </section>
  );
}

function DiffView({ diff }: { diff: RevisionDiff }) {
  const { components } = diff;
  const noInfraChange =
    diff.files.length === 0 &&
    !components.added.length &&
    !components.removed.length &&
    !components.changed.length;
  return (
    <div className="flex flex-col gap-3 rounded border border-slate-800 bg-slate-950 p-3">
      <p className="text-slate-300">
        Compared with #{diff.from?.number ?? "-"}:{" "}
        {diff.commitChanged ? (
          <>
            code moved from <code>{diff.from!.commitSha.slice(0, 7)}</code> to{" "}
            <code>{diff.to.commitSha.slice(0, 7)}</code>
            {diff.compareUrl && (
              <>
                {" "}
                (
                <a
                  href={diff.compareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-300 underline"
                >
                  see commits on GitHub
                </a>
                )
              </>
            )}
            .
          </>
        ) : (
          "same code."
        )}{" "}
        {noInfraChange && "Infrastructure unchanged."}
        {diff.pattern.from && diff.pattern.to && diff.pattern.from !== diff.pattern.to && (
          <span className="text-amber-300">
            {" "}
            Architecture changes from {diff.pattern.from} to {diff.pattern.to}.
          </span>
        )}
      </p>

      {(components.added.length > 0 ||
        components.removed.length > 0 ||
        components.changed.length > 0) && (
        <ul className="font-mono text-xs">
          {components.added.map((c) => (
            <li key={`a-${c}`} className="text-emerald-300">
              + {c}
            </li>
          ))}
          {components.removed.map((c) => (
            <li key={`r-${c}`} className="text-red-300">
              - {c}
            </li>
          ))}
          {components.changed.map((c) => (
            <li key={`c-${c.name}`} className="text-amber-200">
              ~ {c.name}: {c.before} &rarr; {c.after}
            </li>
          ))}
        </ul>
      )}

      {diff.files.map((file) => (
        <details key={file.path} open={diff.files.length <= 3}>
          <summary className="cursor-pointer font-mono text-xs text-slate-300">
            {file.path}{" "}
            <span className="text-slate-500">
              ({file.status}
              {file.additions ? `, +${file.additions}` : ""}
              {file.deletions ? `, -${file.deletions}` : ""})
            </span>
          </summary>
          <div className="mt-1 overflow-x-auto rounded bg-black/40 font-mono text-xs">
            {file.hunks.map((hunk, h) => (
              <div key={h} className="border-t border-slate-800 first:border-t-0">
                <div className="px-2 py-0.5 text-slate-500">
                  @@ -{hunk.oldStart} +{hunk.newStart} @@
                </div>
                {hunk.lines.map((line, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre px-2 ${
                      line.kind === "add"
                        ? "bg-emerald-950/60 text-emerald-200"
                        : line.kind === "del"
                          ? "bg-red-950/60 text-red-200"
                          : "text-slate-400"
                    }`}
                  >
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} {line.text}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
