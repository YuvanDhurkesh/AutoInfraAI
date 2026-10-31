"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

/**
 * Change the password -- or, for an account created with "Log in with
 * GitHub", add an email and password so losing GitHub access doesn't lock
 * the owner out.
 */
export function PasswordForm({
  hasPassword,
  emailIsPlaceholder,
  onSaved,
}: {
  hasPassword: boolean;
  emailIsPlaceholder: boolean;
  onSaved: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== newPassword;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = (await apiFetch("/account/password", {
        method: "POST",
        body: JSON.stringify({
          ...(hasPassword ? { currentPassword } : {}),
          ...(emailIsPlaceholder ? { email } : {}),
          newPassword,
        }),
      })) as { otherSessionsSignedOut: number };
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      setDone(
        `${hasPassword ? "Password changed" : "Password added"}.${
          res.otherSessionsSignedOut
            ? ` Signed out ${res.otherSessionsSignedOut} other session${res.otherSessionsSignedOut === 1 ? "" : "s"}.`
            : ""
        }`,
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save the password");
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded border border-slate-700 bg-slate-900 px-3 py-2";
  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
      <h2 className="text-base font-semibold">{hasPassword ? "Password" : "Add a password"}</h2>
      {!hasPassword && (
        <p className="text-slate-400">
          You signed in with GitHub. Add an email and password so you can still get in if you lose
          access to your GitHub account.
        </p>
      )}
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-2">
        {hasPassword && (
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            className={input}
          />
        )}
        {emailIsPlaceholder && (
          <input
            type="email"
            autoComplete="email"
            placeholder="Email to sign in with"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={input}
          />
        )}
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password (12+ characters)"
          minLength={12}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          className={input}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Repeat the new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          className={input}
        />
        {mismatch && <p className="text-amber-300">The passwords don&apos;t match.</p>}
        <button
          type="submit"
          disabled={busy || mismatch || newPassword.length < 12}
          className="self-start rounded bg-indigo-500 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Saving..." : hasPassword ? "Change password" : "Add password"}
        </button>
      </form>
      {hasPassword && (
        <p className="text-xs text-slate-500">Changing it signs out your other sessions.</p>
      )}
      {done && <p className="text-emerald-400">{done}</p>}
      {error && <p className="text-red-400">{error}</p>}
    </section>
  );
}
