"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface LogsResponse {
  source: "instance" | "lambda";
  service: string;
  lines: string[];
}

const LABELS: Record<string, string> = {
  app: "Backend (app)",
  web: "Frontend server (web)",
  db: "Database (db)",
  cache: "Redis (cache)",
  caddy: "Web server (caddy)",
};

/**
 * The running app's own logs, read on demand: a container on the F2
 * instance (over SSM) or the F1 Lambda's (CloudWatch). Read-only;
 * passwords in connection URLs are masked on the instance.
 */
export function AppLogs({ deploymentId, services }: { deploymentId: string; services: string[] }) {
  const [service, setService] = useState(services[0] ?? "app");
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(which = service) {
    setLoading(true);
    setError(null);
    try {
      setLogs(
        await apiFetch(
          `/deployments/${deploymentId}/logs?service=${encodeURIComponent(which)}&lines=200`,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not read the logs");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">App logs</h2>
        {services.length > 1 && (
          <select
            value={service}
            onChange={(e) => {
              setService(e.target.value);
              if (logs) void load(e.target.value);
            }}
            className="rounded border border-slate-600 bg-slate-900 px-2 py-1"
          >
            {services.map((s) => (
              <option key={s} value={s}>
                {LABELS[s] ?? s}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded border border-slate-600 px-3 py-1 disabled:opacity-50"
        >
          {loading ? "Reading..." : logs ? "Refresh" : "Show logs"}
        </button>
        <span className="text-xs text-slate-500">last 200 lines, read when you ask</span>
      </div>
      {error && <p className="text-red-400">{error}</p>}
      {logs &&
        (logs.lines.length ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 font-mono text-xs text-slate-300">
            {logs.lines.join("\n")}
          </pre>
        ) : (
          <p className="text-slate-400">No log lines yet.</p>
        ))}
    </section>
  );
}
