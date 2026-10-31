"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

/**
 * Irreversible: removes every AWS resource the deployment created (including
 * its database volume and uploaded files), then checks nothing tagged with it
 * remains. The user types the repository name to confirm.
 */
export function DestroyPanel({
  deploymentId,
  repoName,
  disabled,
  onStarted,
}: {
  deploymentId: string;
  repoName: string;
  disabled: boolean;
  onStarted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function destroy() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/destroy`, {
        method: "POST",
        body: JSON.stringify({ confirm }),
      });
      setOpen(false);
      setConfirm("");
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "destroy failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-red-900 p-4 text-sm">
      <h2 className="font-semibold text-red-300">Danger zone</h2>
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-slate-400">
            Remove everything this deployment created in your AWS account.
          </p>
          <button
            onClick={() => setOpen(true)}
            disabled={disabled}
            className="rounded border border-red-700 px-3 py-1.5 font-medium text-red-300 disabled:opacity-50"
          >
            Destroy deployment
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-red-200">
            This permanently deletes the site, the server, its database and all uploaded files. It
            can&apos;t be undone. Your GitHub repository is not touched.
          </p>
          <label className="flex flex-col gap-1 text-slate-300">
            Type <code className="text-red-200">{repoName}</code> to confirm
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoFocus
              className="rounded border border-red-900 bg-slate-900 px-3 py-2"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={destroy}
              disabled={busy || confirm.trim() !== repoName}
              className="rounded bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {busy ? "Starting..." : "Destroy everything"}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setConfirm("");
              }}
              className="rounded border border-slate-600 px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-red-400">{error}</p>}
    </section>
  );
}
