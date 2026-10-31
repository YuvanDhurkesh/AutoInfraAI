"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { ConnectAws, type AwsConnectionSummary } from "@/components/connect-aws";

/**
 * Paste a GitHub URL -> (connect AWS once) -> AutoInfra analyzes, designs and
 * validates by itself -> review -> deploy. Everything else is optional.
 */
export default function NewDeploymentPage() {
  const router = useRouter();
  const [repoUrl, setRepoUrl] = useState("");
  const [connection, setConnection] = useState<AwsConnectionSummary | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  // Empty: the repository's own default branch (main, master...).
  const [branch, setBranch] = useState("");
  const [subdir, setSubdir] = useState("");
  const [freeTierMode, setFreeTierMode] = useState<"strict" | "flexible">("strict");
  const [allowRds, setAllowRds] = useState(false);
  const [externalDatabase, setExternalDatabase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Start from the owner's default (Settings); changing it here is per deployment.
  useEffect(() => {
    apiFetch("/account/settings")
      .then((s: { freeTierModeDefault: "strict" | "flexible" }) =>
        setFreeTierMode(s.freeTierModeDefault),
      )
      .catch(() => undefined);
  }, []);

  async function deploy(e?: React.FormEvent) {
    e?.preventDefault();
    if (!connection) return;
    setSubmitting(true);
    setError(null);
    try {
      const deployment = await apiFetch("/deployments", {
        method: "POST",
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          branch: branch.trim() || undefined,
          subdir: subdir.trim() || undefined,
          awsConnectionId: connection.id,
          freeTierMode,
          allowRds,
          externalDatabase,
        }),
      });
      router.push(`/deployments/${deployment.id}?start=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create deployment");
      setSubmitting(false);
    }
  }

  const validUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(
    repoUrl.trim().replace(/\.git$/, ""),
  );

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-24">
      <h1 className="text-2xl font-semibold">Deploy a repository</h1>

      <form onSubmit={deploy} className="flex flex-col gap-3">
        <input
          required
          autoFocus
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="rounded border border-slate-700 bg-slate-900 px-4 py-3 text-lg"
        />

        {validUrl && <ConnectAws onConnected={setConnection} />}

        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="self-start text-sm text-slate-400 hover:text-slate-200"
        >
          {showOptions ? "Hide options" : "Options (branch, monorepo folder, Free Tier mode)"}
        </button>
        {showOptions && (
          <div className="flex flex-col gap-3 rounded border border-slate-800 p-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                Branch
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="the repo's default branch"
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1">
                Subfolder (monorepos)
                <input
                  value={subdir}
                  onChange={(e) => setSubdir(e.target.value)}
                  placeholder="apps/web"
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                />
              </label>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={freeTierMode === "strict"}
                onChange={() => setFreeTierMode("strict")}
              />
              Strict Free Tier (recommended)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={freeTierMode === "flexible"}
                onChange={() => setFreeTierMode("flexible")}
              />
              Flexible -- paid resources allowed after a cost-labelled confirmation
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allowRds}
                onChange={(e) => setAllowRds(e.target.checked)}
              />
              Allow a single-AZ RDS micro database (single-EC2 apps only)
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={externalDatabase}
                onChange={(e) => setExternalDatabase(e.target.checked)}
              />
              <span>
                My database is hosted outside AWS (Neon, Supabase, PlanetScale, Upstash...) -- I'll
                enter its connection settings. MongoDB is always treated this way (e.g. MongoDB
                Atlas).
              </span>
            </label>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !validUrl || !connection}
          className="rounded bg-indigo-500 px-4 py-3 text-lg font-medium text-white disabled:opacity-50"
        >
          {submitting
            ? "Starting..."
            : !connection && validUrl
              ? "Connect AWS to continue"
              : "Analyze & prepare deployment"}
        </button>
        <p className="text-xs text-slate-500">
          AutoInfra analyzes the repo, designs a Free-Tier architecture, and validates the Terraform
          by itself. Nothing is created in your AWS account until you approve it on the review
          screen.
        </p>
      </form>
    </main>
  );
}
