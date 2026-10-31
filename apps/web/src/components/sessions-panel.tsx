"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

/** "Sign out everywhere": for a lost laptop or a shared computer. */
export function SessionsPanel({ activeSessions }: { activeSessions: number }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOutEverywhere() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/account/sessions/revoke", { method: "POST" });
      window.location.assign("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not sign out");
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
      <h2 className="text-base font-semibold">Sessions</h2>
      <p className="text-slate-400">
        You&apos;re signed in on {activeSessions} {activeSessions === 1 ? "device" : "devices"}{" "}
        (sessions last 7 days).
      </p>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>Sign out on every device, including this one?</span>
          <button
            onClick={signOutEverywhere}
            disabled={busy}
            className="rounded bg-red-600 px-3 py-1 font-medium text-white disabled:opacity-50"
          >
            {busy ? "Signing out..." : "Sign out everywhere"}
          </button>
          <button onClick={() => setConfirming(false)} className="text-slate-400">
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="self-start rounded border border-slate-600 px-3 py-1"
        >
          Sign out everywhere
        </button>
      )}
      {error && <p className="text-red-400">{error}</p>}
    </section>
  );
}
