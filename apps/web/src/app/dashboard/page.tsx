"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { API_BASE_URL, apiFetch } from "@/lib/api-client";
import { FreePlanWarning } from "@/components/free-plan-warning";

interface DeploymentRow {
  id: string;
  repoUrl: string;
  branch: string;
  pattern: string | null;
  status: string;
  region: string;
  liveUrl: string | null;
  createdAt: string;
}

/** Where the API's GitHub callback sends the browser back (?connected=github / ?github_error=...). */
const GITHUB_NOTICES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "GitHub connected: private repositories can be deployed now." },
  in_use: {
    ok: false,
    text: "That GitHub account is already connected to another AutoInfra account. Log in to that account, or use a different GitHub account.",
  },
  oauth_failed: { ok: false, text: "Connecting GitHub didn't complete. Please try again." },
  not_configured: {
    ok: false,
    text: "GitHub isn't set up on this AutoInfra yet (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env).",
  },
};

export default function DashboardPage() {
  const [deployments, setDeployments] = useState<DeploymentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubAvailable, setGithubAvailable] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    apiFetch("/deployments")
      .then(setDeployments)
      .catch((err) => setError(err.message));
    apiFetch("/auth/providers")
      .then((p: { github: boolean }) => setGithubAvailable(p.github))
      .catch(() => setGithubAvailable(false));
    apiFetch("/account/settings")
      .then((s: { githubLogin: string | null }) => setGithubLogin(s.githubLogin))
      .catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    const code = params.get("connected") === "github" ? "connected" : params.get("github_error");
    if (code && GITHUB_NOTICES[code]) {
      setGithubNotice(GITHUB_NOTICES[code]);
      // A reload shouldn't show the message again.
      window.history.replaceState(null, "", "/dashboard");
    }
  }, []);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Deployments</h1>
        <div className="flex gap-3">
          {githubLogin ? (
            <span className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300">
              GitHub: @{githubLogin}
            </span>
          ) : (
            githubAvailable && (
              <a
                href={`${API_BASE_URL}/auth/github`}
                className="rounded border border-slate-600 px-3 py-1.5 text-sm font-medium"
              >
                Connect GitHub
              </a>
            )
          )}
          <Link
            href="/aws/connect"
            className="rounded border border-slate-600 px-3 py-1.5 text-sm font-medium"
          >
            AWS connection
          </Link>
          <Link
            href="/settings"
            className="rounded border border-slate-600 px-3 py-1.5 text-sm font-medium"
          >
            Settings
          </Link>
          <Link
            href="/deployments/new"
            className="rounded bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white"
          >
            New deployment
          </Link>
        </div>
      </div>

      <FreePlanWarning />

      {githubNotice && (
        <p className={`text-sm ${githubNotice.ok ? "text-emerald-400" : "text-red-400"}`}>
          {githubNotice.text}
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {!deployments && !error && <p className="text-slate-400">Loading...</p>}
      {deployments?.length === 0 && (
        <p className="text-slate-400">
          No deployments yet. Connect AWS, then paste a GitHub repo URL to get started.
        </p>
      )}

      {deployments && deployments.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 pr-4 font-medium">Repository</th>
              <th className="py-2 pr-4 font-medium">Pattern</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Region</th>
              <th className="py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} className="border-t border-slate-800">
                <td className="py-2 pr-4">
                  <Link href={`/deployments/${d.id}`} className="text-indigo-300 hover:underline">
                    {d.repoUrl.replace("https://github.com/", "")}
                  </Link>
                  <span className="text-slate-500"> @ {d.branch || "default branch"}</span>
                </td>
                <td className="py-2 pr-4">{d.pattern ?? "--"}</td>
                <td className="py-2 pr-4">{d.status.replace(/_/g, " ")}</td>
                <td className="py-2 pr-4">{d.region}</td>
                <td className="py-2 text-slate-400">
                  {new Date(d.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
