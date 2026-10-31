"use client";

import { useCallback, useEffect, useState } from "react";
import { parseEnvPaste } from "@autoinfra/shared";
import { apiFetch } from "@/lib/api-client";

interface EnvState {
  vars: Array<{ name: string; isSecret: boolean; set: boolean }>;
  missing: Array<{ name: string; isSecret: boolean }>;
  provided?: Array<{ name: string; how: keyof typeof PROVIDED_LABELS }>;
}

const PROVIDED_LABELS = {
  live_url: "your live URL",
  production: '"production"',
  api_path: "the API path",
  database: "the database",
  cache: "the Redis container",
  live_host: "your live host name",
  backend_url: "your backend's live URL",
  local_url: "the live URL (same path as in the repo's example)",
  listen_port: "the port AutoInfra routes to",
  listen_address: "every network interface (0.0.0.0)",
} as const;

interface Draft {
  name: string;
  value: string;
  isSecret: boolean;
}

/**
 * Sec. 5 Step 3. Values are sent once to the API, which writes them straight
 * to SSM Parameter Store in the user's AWS account; they're never shown
 * again and never stored by AutoInfra.
 */
export function EnvForm({ deploymentId, disabled }: { deploymentId: string; disabled: boolean }) {
  const [state, setState] = useState<EnvState | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteNotes, setPasteNotes] = useState<string[]>([]);

  /** A pasted .env becomes rows -- nothing is saved until "Save to AWS". */
  function fillFromPaste() {
    const pasted = parseEnvPaste(pasteText, new Set((state?.provided ?? []).map((p) => p.name)));
    setDrafts((prev) => {
      const next = [...prev];
      for (const row of pasted.rows) {
        const i = next.findIndex((d) => d.name === row.name);
        if (i >= 0)
          next[i] = { ...next[i]!, value: row.value, isSecret: next[i]!.isSecret || row.isSecret };
        else next.push(row);
      }
      return next;
    });
    const names = (reason: string) =>
      pasted.skipped.filter((s) => s.reason === reason).map((s) => s.name);
    const filled = pasted.rows.filter((r) => r.value !== "").map((r) => r.name);
    setPasteNotes(
      [
        filled.length ? `Filled in: ${filled.join(", ")}.` : "",
        pasted.needsOwnValue.length
          ? `Type your own value for ${pasted.needsOwnValue.join(", ")}: the file's value is a placeholder, and anyone who can read the repository knows it.`
          : "",
        names("set_by_autoinfra").length
          ? `Left out, because AutoInfra sets them itself: ${names("set_by_autoinfra").join(", ")}.`
          : "",
        names("reserved").length
          ? `Left out, set by AutoInfra or the runtime: ${names("reserved").join(", ")}.`
          : "",
        names("invalid_name").length
          ? `Not valid names, left out: ${names("invalid_name").join(", ")}.`
          : "",
      ].filter(Boolean),
    );
    // The pasted text can hold secrets: keep it no longer than needed.
    setPasteText("");
    setPasteOpen(false);
  }

  const load = useCallback(async () => {
    const res = (await apiFetch(`/deployments/${deploymentId}/env`)) as EnvState;
    setState(res);
    setDrafts(res.missing.map((m) => ({ name: m.name, value: "", isSecret: m.isSecret })));
  }, [deploymentId]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function save() {
    const vars = drafts.filter((d) => d.name.trim() && d.value !== "");
    if (!vars.length) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/env`, {
        method: "PUT",
        body: JSON.stringify({ vars }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: string) {
    setError(null);
    try {
      await apiFetch(`/deployments/${deploymentId}/env/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not delete");
    }
  }

  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  if (!state) return null;
  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 p-4">
      <div>
        <h2 className="text-lg font-semibold">Environment variables</h2>
        <p className="text-sm text-slate-400">
          Stored in SSM Parameter Store in your AWS account (secrets as SecureString). AutoInfra
          never stores the values and won&apos;t show them again.
        </p>
      </div>

      {state.vars.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {state.vars.map((v) => (
            <li key={v.name} className="flex items-center gap-2">
              <span className="font-mono">{v.name}</span>
              <span className="text-slate-500">{v.isSecret ? "secret · set" : "set"}</span>
              <button
                onClick={() => remove(v.name)}
                disabled={disabled}
                className="ml-auto text-xs text-red-300 hover:underline disabled:opacity-50"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {drafts.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <input
            value={d.name}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder="NAME"
            className="w-48 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono"
          />
          <input
            value={d.value}
            type={d.isSecret ? "password" : "text"}
            autoComplete="off"
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="value"
            className="min-w-48 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1"
          />
          <label className="flex items-center gap-1 text-slate-400">
            <input
              type="checkbox"
              checked={d.isSecret}
              onChange={(e) => update(i, { isSecret: e.target.checked })}
            />
            secret
          </label>
        </div>
      ))}

      <div className="flex gap-2">
        <button
          onClick={() => setDrafts((prev) => [...prev, { name: "", value: "", isSecret: true }])}
          disabled={disabled}
          className="rounded border border-slate-600 px-3 py-1 text-sm disabled:opacity-50"
        >
          + Add variable
        </button>
        <button
          onClick={() => setPasteOpen((open) => !open)}
          disabled={disabled}
          className="rounded border border-slate-600 px-3 py-1 text-sm disabled:opacity-50"
        >
          Paste a .env file
        </button>
        <button
          onClick={save}
          disabled={disabled || saving || !drafts.some((d) => d.name.trim() && d.value !== "")}
          className="rounded bg-slate-700 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save to AWS"}
        </button>
      </div>
      {pasteOpen && (
        <div className="flex flex-col gap-2">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={8}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              "NAME=value lines, as in a .env file\nSTRIPE_KEY=sk_live_...\nAPP_NAME=My shop"
            }
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={fillFromPaste}
              disabled={!pasteText.trim()}
              className="rounded bg-slate-700 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Fill in
            </button>
            <button
              onClick={() => {
                setPasteText("");
                setPasteOpen(false);
              }}
              className="rounded border border-slate-600 px-3 py-1 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {pasteNotes.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-sky-300">
          {pasteNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {state.missing.length > 0 && (
        <p className="text-xs text-amber-300">
          Found in your repo but not set yet: {state.missing.map((m) => m.name).join(", ")}
        </p>
      )}
      {(state.provided?.length ?? 0) > 0 && (
        <p className="text-xs text-slate-400">
          Set automatically by AutoInfra:{" "}
          {state.provided!.map((p) => `${p.name} (${PROVIDED_LABELS[p.how]})`).join(", ")}. Add one
          above to override it -- except database and Redis settings, which always point at the
          containers AutoInfra runs. Don't paste the repo&apos;s example values for them.
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
