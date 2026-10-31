"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

/** Drop a pending change that hasn't touched AWS and go back to what's live. */
export function DiscardChange({
  deploymentId,
  revision,
  onDone,
}: {
  deploymentId: string;
  revision: number;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function discard() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/changes/discard`, { method: "POST" });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not discard the change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
      <span>Revision {revision} hasn&apos;t changed anything in AWS yet.</span>
      <button
        onClick={discard}
        disabled={busy}
        className="rounded border border-slate-600 px-3 py-1 text-slate-200 disabled:opacity-50"
      >
        {busy ? "Discarding..." : "Discard this change"}
      </button>
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}
