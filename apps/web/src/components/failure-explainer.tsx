"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface Diagnosis {
  summary: string;
  likelyCause: string;
  suggestedFix: string;
  whoFixes:
    "retry" | "user_repo" | "user_settings" | "change_request" | "autoinfra" | "aws_account";
  changeRequest?: string;
}

const WHO: Record<Diagnosis["whoFixes"], string> = {
  retry: "Likely temporary -- retrying should work",
  user_repo: "Needs a fix in your repository",
  user_settings: "Needs a settings change (env vars or AWS connection)",
  change_request: "Needs an infrastructure change",
  autoinfra: "Looks like an AutoInfra problem, not yours",
  aws_account: "An AWS account limit or setting",
};

/** "Explain this failure": Gemini reads the redacted log tail (cached per job). */
export function FailureExplainer({
  jobId,
  canRequestChange,
  onUseChange,
}: {
  jobId: string;
  canRequestChange: boolean;
  onUseChange: (request: string) => void;
}) {
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function explain() {
    setBusy(true);
    setError(null);
    try {
      setDiagnosis(await apiFetch(`/jobs/${jobId}/diagnose`, { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not explain this failure");
    } finally {
      setBusy(false);
    }
  }

  if (!diagnosis) {
    return (
      <div className="mt-3 flex flex-col gap-1">
        <button
          onClick={explain}
          disabled={busy}
          className="self-start rounded border border-red-700 px-3 py-1 text-xs text-red-100 disabled:opacity-50"
        >
          {busy ? "Reading the log..." : "Explain this failure"}
        </button>
        {error && <p className="text-xs text-red-300">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded border border-red-900 bg-black/30 p-3 text-slate-200">
      <p className="text-xs uppercase tracking-wide text-red-300">{WHO[diagnosis.whoFixes]}</p>
      <p>{diagnosis.summary}</p>
      <p>
        <span className="text-slate-400">Likely cause: </span>
        {diagnosis.likelyCause}
      </p>
      <p className="whitespace-pre-wrap">
        <span className="text-slate-400">What to do: </span>
        {diagnosis.suggestedFix}
      </p>
      {diagnosis.changeRequest && canRequestChange && (
        <button
          onClick={() => onUseChange(diagnosis.changeRequest!)}
          className="self-start rounded bg-indigo-500 px-3 py-1 text-xs font-medium text-white"
        >
          Request this change: &ldquo;{diagnosis.changeRequest}&rdquo;
        </button>
      )}
      <p className="text-xs text-slate-500">
        AI explanation from the log -- check it before acting on it.
      </p>
    </div>
  );
}
