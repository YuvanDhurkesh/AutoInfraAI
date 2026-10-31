"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { afterAuthPath, apiFetch } from "@/lib/api-client";
import { GithubSignIn } from "@/components/github-sign-in";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
      router.push(afterAuthPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : "signup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-24">
      <h1 className="text-2xl font-semibold">Sign up</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
        />
        <input
          type="password"
          required
          minLength={12}
          placeholder="Password (min 12 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-indigo-500 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Creating account..." : "Create account"}
        </button>
      </form>
      <GithubSignIn />
      <button
        onClick={() => router.push(`/login${window.location.search}`)}
        className="self-start text-sm text-indigo-300"
      >
        Already have an account? Log in
      </button>
    </main>
  );
}
