"use client";

import { useEffect, useState } from "react";
import { API_BASE_URL, apiFetch } from "@/lib/api-client";

/** The API sends the browser back to /login?error=... when GitHub sign-in fails. */
const ERRORS: Record<string, string> = {
  github_oauth_failed: "GitHub sign-in didn't complete. Please try again.",
  github_not_configured:
    "GitHub sign-in isn't set up on this AutoInfra yet (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env).",
};

/** "Continue with GitHub" when the API has an OAuth app, and why the last attempt failed. */
export function GithubSignIn() {
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/auth/providers")
      .then((p: { github: boolean }) => setAvailable(p.github))
      .catch(() => setAvailable(false));
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(ERRORS[code] ?? null);
  }, []);

  return (
    <>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {available && (
        <a
          href={`${API_BASE_URL}/auth/github`}
          className="rounded border border-slate-600 px-4 py-2 text-center font-medium"
        >
          Continue with GitHub
        </a>
      )}
    </>
  );
}
