"use client";

import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * Sec. 5 Step 5: the explicit approval gate -- the only path that changes
 * anything in the user's AWS account. Missing env vars and (flexible mode)
 * paid resources each need their own explicit confirmation.
 */
export function ApprovePanel({
  deploymentId,
  retry,
  hasPaidResources,
  dataLoss = [],
  changePrompt,
  rollbackOf,
  onStarted,
}: {
  deploymentId: string;
  retry: boolean;
  hasPaidResources: boolean;
  /** Data-bearing resources the plan destroys or replaces. */
  dataLoss?: string[];
  /** Set when this revision is a change request to a live deployment. */
  changePrompt?: string | null;
  /** Set when this revision restores an earlier one. */
  rollbackOf?: number | null;
  onStarted: () => void;
}) {
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [confirmLoss, setConfirmLoss] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(acceptMissingEnv = false) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/approve`, {
        method: "POST",
        body: JSON.stringify({
          confirmPaidResources: confirmPaid,
          confirmDataLoss: confirmLoss,
          acceptMissingEnv,
        }),
      });
      setMissing(null);
      onStarted();
    } catch (err) {
      if (err instanceof ApiError && err.code === "env_vars_missing") {
        setMissing((err.body.missing as string[] | undefined) ?? []);
      } else {
        setError(err instanceof Error ? err.message : "approve failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-indigo-800 bg-indigo-950/30 p-4 text-sm">
      <p className="text-slate-200">
        {retry
          ? "The last deploy failed. Retrying re-plans against the current state and only applies changes you already approved."
          : rollbackOf
            ? `Approving rolls your live deployment back to revision ${rollbackOf}: the infrastructure changes in the plan above, then that revision's commit is rebuilt and redeployed. Nothing has changed yet.`
            : changePrompt
              ? `Approving applies only the changes in the plan above to your live deployment ("${changePrompt}"), then rebuilds and redeploys the app. Nothing has changed yet.`
              : "Approving creates the resources above in your AWS account, builds your app with CodeBuild, and deploys it. Nothing has been created yet."}
      </p>
      {dataLoss.length > 0 && (
        <label className="flex items-start gap-2 rounded border border-red-800 bg-red-950/40 p-3 text-red-200">
          <input
            type="checkbox"
            checked={confirmLoss}
            onChange={(e) => setConfirmLoss(e.target.checked)}
            className="mt-1"
          />
          <span>
            This plan destroys or replaces resources that hold data:{" "}
            <code>{dataLoss.join(", ")}</code>. Their contents will be permanently lost. I
            understand.
          </span>
        </label>
      )}
      {hasPaidResources && (
        <label className="flex items-start gap-2 text-red-200">
          <input
            type="checkbox"
            checked={confirmPaid}
            onChange={(e) => setConfirmPaid(e.target.checked)}
            className="mt-1"
          />
          I understand this plan includes resources outside the AWS Free Tier that will cost money.
        </label>
      )}
      {missing && (
        <div className="rounded border border-amber-800 bg-amber-950/40 p-3 text-amber-200">
          <p>Your repo reads these env vars, but they have no value yet: {missing.join(", ")}</p>
          <p className="mt-1">
            Set them above, or deploy anyway if the app doesn&apos;t need them.
          </p>
          <button
            onClick={() => go(true)}
            disabled={busy}
            className="mt-2 rounded border border-amber-700 px-3 py-1 disabled:opacity-50"
          >
            Deploy anyway
          </button>
        </div>
      )}
      <div>
        <button
          onClick={() => go(false)}
          disabled={
            busy || (hasPaidResources && !confirmPaid) || (dataLoss.length > 0 && !confirmLoss)
          }
          className="rounded bg-indigo-500 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Starting..." : retry ? "Retry deploy" : "Approve & deploy"}
        </button>
      </div>
      {error && <p className="text-red-300">{error}</p>}
    </section>
  );
}
