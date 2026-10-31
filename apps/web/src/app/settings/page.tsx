"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-client";
import { PasswordForm } from "@/components/password-form";
import { SessionsPanel } from "@/components/sessions-panel";

interface Settings {
  email: string;
  freeTierModeDefault: "strict" | "flexible";
  hasPassword: boolean;
  emailIsPlaceholder: boolean;
  activeSessions: number;
}

interface AuditEvent {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  signup: "Account created",
  login: "Signed in",
  login_failed: "Failed sign-in attempt",
  logout: "Signed out",
  password_changed: "Password changed",
  password_added: "Password added",
  password_change_failed: "Wrong current password entered",
  signed_out_everywhere: "Signed out everywhere",
  settings_changed: "Settings changed",
  github_connected: "GitHub connected",
  aws_connection_created: "AWS connection started",
  aws_connection_verified: "AWS connection verified",
  aws_regime_set: "AWS account plan set",
  aws_connection_removed: "AWS connection removed",
  deployment_created: "Deployment created",
  deployment_approved: "Deploy approved",
  deployment_applied: "Infrastructure applied",
  deployment_redeployed: "Redeployed",
  change_requested: "Change requested",
  change_discarded: "Change discarded",
  rollback_requested: "Rollback requested",
  env_vars_set: "Env vars set",
  env_var_deleted: "Env var deleted",
  deployment_destroy_requested: "Destroy requested",
  deployment_destroyed: "Destroyed",
};

/** What's worth showing from an event's metadata, in words. */
function detail(e: AuditEvent): string | null {
  const m = e.metadata ?? {};
  if (typeof m.prompt === "string") return `"${m.prompt}"`;
  if (typeof m.changePrompt === "string") return `"${m.changePrompt}"`;
  if (typeof m.rollbackOf === "number") return `to revision ${m.rollbackOf}`;
  if (Array.isArray(m.names)) return (m.names as string[]).join(", ");
  if (typeof m.name === "string") return m.name;
  if (typeof m.otherSessionsSignedOut === "number" && m.otherSessionsSignedOut > 0)
    return `signed out ${m.otherSessionsSignedOut} other session(s)`;
  if (typeof m.sessions === "number") return `${m.sessions} session(s) ended`;
  if (typeof m.ip === "string") return `from ${m.ip}`;
  if (typeof m.regime === "string") return m.regime;
  const mode = m.freeTierModeDefault as { to?: string } | undefined;
  if (mode?.to) return `default Free Tier mode: ${mode.to}`;
  return null;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async (after?: string) => {
    try {
      const page = (await apiFetch(
        `/account/audit${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      )) as { events: AuditEvent[]; nextAfter: string | null };
      setEvents((prev) => (after ? [...prev, ...page.events] : page.events));
      setNextAfter(page.nextAfter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load activity");
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await apiFetch("/account/settings"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load settings");
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadEvents();
  }, [loadSettings, loadEvents]);

  async function setMode(mode: Settings["freeTierModeDefault"]) {
    const previous = settings?.freeTierModeDefault;
    setSaved(false);
    setError(null);
    // Show the choice right away; put it back if saving fails.
    setSettings((prev) => (prev ? { ...prev, freeTierModeDefault: mode } : prev));
    try {
      const updated = (await apiFetch("/account/settings", {
        method: "PUT",
        body: JSON.stringify({ freeTierModeDefault: mode }),
      })) as Pick<Settings, "freeTierModeDefault">;
      setSettings((prev) => (prev ? { ...prev, ...updated } : prev));
      setSaved(true);
      void loadEvents();
    } catch (err) {
      if (previous)
        setSettings((prev) => (prev ? { ...prev, freeTierModeDefault: previous } : prev));
      setError(err instanceof Error ? err.message : "could not save");
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <Link href="/dashboard" className="text-sm text-indigo-300">
          Back to deployments
        </Link>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {settings && (
        <section className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
          <p className="text-slate-400">Signed in as {settings.email}</p>
          <h2 className="text-base font-semibold">Default Free Tier mode</h2>
          <p className="text-slate-400">
            Used for new deployments; you can still change it per deployment.
          </p>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              checked={settings.freeTierModeDefault === "strict"}
              onChange={() => setMode("strict")}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Strict</span>: refuse anything outside the AWS Free
              Tier.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              checked={settings.freeTierModeDefault === "flexible"}
              onChange={() => setMode("flexible")}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Flexible</span>: allow paid resources after you confirm
              their cost, each time.
            </span>
          </label>
          {saved && <p className="text-emerald-400">Saved.</p>}
        </section>
      )}

      {settings && (
        <PasswordForm
          hasPassword={settings.hasPassword}
          emailIsPlaceholder={settings.emailIsPlaceholder}
          onSaved={() => {
            void loadSettings();
            void loadEvents();
          }}
        />
      )}
      {settings && <SessionsPanel activeSessions={settings.activeSessions} />}

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Activity</h2>
        <p className="text-sm text-slate-400">
          Everything done with your account: sign-ins, approvals, changes and destroys.
        </p>
        <ol className="flex flex-col divide-y divide-slate-800 rounded border border-slate-700 text-sm">
          {events.map((e) => {
            const d = detail(e);
            return (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
                <span
                  className={
                    e.action === "login_failed" ? "font-medium text-amber-300" : "font-medium"
                  }
                >
                  {ACTION_LABELS[e.action] ?? e.action.replaceAll("_", " ")}
                </span>
                {e.targetType === "deployment" && e.targetId && (
                  <Link href={`/deployments/${e.targetId}`} className="text-indigo-300">
                    {e.targetName ?? "a deleted deployment"}
                  </Link>
                )}
                {d && <span className="text-slate-400">{d}</span>}
                <span className="ml-auto text-xs text-slate-500">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </li>
            );
          })}
          {events.length === 0 && <li className="p-3 text-slate-500">No activity yet.</li>}
        </ol>
        {nextAfter && (
          <button
            onClick={() => loadEvents(nextAfter)}
            className="self-start rounded border border-slate-600 px-3 py-1 text-sm"
          >
            Load older
          </button>
        )}
      </section>
    </main>
  );
}
