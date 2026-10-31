"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface Table {
  name: string;
  rows: number;
  estimated?: boolean;
}

interface Page {
  table: string;
  columns: string[];
  rows: Record<string, string | null>[];
  total: number;
  offset: number;
  limit: number;
}

const KIND_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongo: "MongoDB",
};

/** Columns whose values stay hidden until asked: passwords, tokens, keys. */
const SECRET_COLUMN = /pass(word)?|secret|token|hash|salt|otp|api_?key|private/i;

/**
 * The deployment's own database (the db container on its F2 instance):
 * tables with row counts and a page of rows at a time. Read-only; values
 * past 200 characters are cut.
 */
export function DatabaseViewer({ deploymentId, kind }: { deploymentId: string; kind: string }) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);

  async function run<T>(what: string, fn: () => Promise<T>) {
    setLoading(what);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not read the database");
      return undefined;
    } finally {
      setLoading(null);
    }
  }

  async function loadTables() {
    const res = await run("tables", () => apiFetch(`/deployments/${deploymentId}/database`));
    if (res) setTables((res as { tables: Table[] }).tables);
  }

  async function openTable(table: string, offset = 0) {
    const res = await run(table, () =>
      apiFetch(
        `/deployments/${deploymentId}/database/rows?table=${encodeURIComponent(table)}&offset=${offset}&limit=25`,
      ),
    );
    if (res) setPage(res as Page);
  }

  const hiddenColumns = page ? page.columns.filter((c) => SECRET_COLUMN.test(c)) : [];
  const last = page ? page.offset + page.rows.length : 0;

  return (
    <section className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Database</h2>
        <span className="text-slate-400">{KIND_LABELS[kind] ?? kind}</span>
        <button
          onClick={() => void loadTables()}
          disabled={loading !== null}
          className="rounded border border-slate-600 px-3 py-1 disabled:opacity-50"
        >
          {loading === "tables" ? "Reading..." : tables ? "Reload tables" : "Show tables"}
        </button>
        <span className="text-xs text-slate-500">read-only, read when you ask</span>
      </div>
      {error && <p className="text-red-400">{error}</p>}
      {tables &&
        (tables.length ? (
          <div className="flex flex-wrap gap-2">
            {tables.map((t) => (
              <button
                key={t.name}
                onClick={() => void openTable(t.name)}
                disabled={loading !== null}
                className={`rounded border px-2 py-1 font-mono text-xs disabled:opacity-50 ${
                  page?.table === t.name
                    ? "border-sky-500 text-sky-300"
                    : "border-slate-600 text-slate-300"
                }`}
              >
                {loading === t.name ? "Reading..." : t.name}{" "}
                <span className="text-slate-500">
                  ({t.estimated ? "~" : ""}
                  {t.rows.toLocaleString()})
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-slate-400">
            No tables yet -- the app creates them when it first starts or saves something.
          </p>
        ))}
      {page && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span className="font-mono text-slate-200">{page.table}</span>
            <span>
              {page.rows.length
                ? `rows ${page.offset + 1}-${last} of ${page.total.toLocaleString()}`
                : `no rows here (${page.total.toLocaleString()} in all)`}
            </span>
            <button
              onClick={() => void openTable(page.table, Math.max(page.offset - page.limit, 0))}
              disabled={loading !== null || page.offset === 0}
              className="rounded border border-slate-600 px-2 py-0.5 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => void openTable(page.table, page.offset + page.limit)}
              disabled={loading !== null || last >= page.total}
              className="rounded border border-slate-600 px-2 py-0.5 disabled:opacity-40"
            >
              Next
            </button>
            {hiddenColumns.length > 0 && (
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={showSecrets}
                  onChange={(e) => setShowSecrets(e.target.checked)}
                />
                show {hiddenColumns.join(", ")}
              </label>
            )}
          </div>
          {page.columns.length > 0 && page.rows.length > 0 && (
            <div className="max-h-[32rem] overflow-auto rounded border border-slate-800">
              <table className="min-w-full border-collapse font-mono text-xs">
                <thead className="sticky top-0 bg-slate-900">
                  <tr>
                    {page.columns.map((c) => (
                      <th
                        key={c}
                        className="border-b border-slate-700 px-2 py-1 text-left font-semibold text-slate-300"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => (
                    <tr key={i} className="odd:bg-slate-950">
                      {page.columns.map((c) => {
                        const v = row[c];
                        const hidden = SECRET_COLUMN.test(c) && !showSecrets;
                        return (
                          <td
                            key={c}
                            className="max-w-xs truncate border-b border-slate-800 px-2 py-1 align-top text-slate-300"
                            title={hidden ? undefined : (v ?? undefined)}
                          >
                            {/* A field this Mongo document doesn't have: blank. */}
                            {v === undefined ? null : v === null ? (
                              <span className="italic text-slate-600">null</span>
                            ) : hidden ? (
                              <span className="text-slate-500">hidden</span>
                            ) : (
                              v
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
