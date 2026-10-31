"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

const EXAMPLES = [
  "Increase the server's disk to 25 GB",
  "Keep CloudWatch logs for 14 days instead of 7",
  "Add a DynamoDB table named sessions for the backend",
];

/**
 * Sec. 5 change requests: describe a change to the live deployment in plain
 * words. Gemini edits the live Terraform, the full validation runs against
 * the real infrastructure, and nothing changes until the plan is approved.
 */
export function ChangeRequest({
  deploymentId,
  disabled,
  prefill,
  onStarted,
}: {
  deploymentId: string;
  disabled: boolean;
  /** Set by "Request this change" on a failure explanation. */
  prefill?: string | null;
  onStarted: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (prefill) setPrompt(prefill);
  }, [prefill]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/changes`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setPrompt("");
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not start the change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
      <h2 className="text-base font-semibold">Request a change</h2>
      <p className="text-slate-400">
        Describe what you want changed. AutoInfra edits the live setup, checks it (security, Free
        Tier, and a plan against what&apos;s running), and shows you the exact changes before
        anything happens. Your site keeps running meanwhile.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={EXAMPLES[0]}
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
        />
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt(ex)}
              className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200"
            >
              {ex}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={disabled || busy || prompt.trim().length < 5}
          className="self-start rounded bg-indigo-500 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Starting..." : "Prepare this change"}
        </button>
      </form>
      {error && <p className="text-red-400">{error}</p>}
    </section>
  );
}
