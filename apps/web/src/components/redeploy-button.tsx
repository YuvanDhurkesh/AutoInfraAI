"use client";

import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * Ships the branch's newest commit on the current infrastructure. The server
 * refuses if the infrastructure would change, so this needs no review step.
 */
export function RedeployButton({
  deploymentId,
  disabled,
  onStarted,
}: {
  deploymentId: string;
  disabled: boolean;
  onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingEnv, setMissingEnv] = useState<string[] | null>(null);

  async function redeploy(acceptMissingEnv = false) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/redeploy`, {
        method: "POST",
        body: JSON.stringify({ acceptMissingEnv }),
      });
      setMissingEnv(null);
      onStarted();
    } catch (err) {
      if (err instanceof ApiError && err.code === "env_vars_missing") {
        setMissingEnv((err.body.missing as string[]) ?? []);
      } else {
        setError(err instanceof Error ? err.message : "redeploy failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => redeploy()}
        disabled={disabled || busy}
        className="self-start rounded border border-emerald-700 px-3 py-1.5 text-sm text-emerald-200 disabled:opacity-50"
      >
        {busy ? "Fetching latest commit..." : "Redeploy latest commit"}
      </button>
      {missingEnv && (
        <div className="rounded border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">
          <p>The latest commit uses env vars that have no value yet: {missingEnv.join(", ")}.</p>
          <p className="mt-1">Set them in the environment section below, or deploy without them.</p>
          <button
            onClick={() => redeploy(true)}
            className="mt-2 rounded border border-amber-700 px-3 py-1 text-xs"
          >
            Redeploy anyway
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
