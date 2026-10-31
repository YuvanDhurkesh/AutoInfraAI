"use client";

import { useState } from "react";
import type { FreeTierReport, GateResult, PlanSummary, TerraformFile } from "@autoinfra/shared";
import { FreeTierBadge } from "./free-tier-badge";

const GATE_LABELS: Record<string, string> = {
  static: "Static safety checks",
  fmt: "terraform fmt",
  init: "terraform init",
  validate: "terraform validate",
  tflint: "tflint",
  trivy: "trivy security scan",
  plan: "terraform plan",
  security_policy: "Security policy",
  free_tier_policy: "Free Tier policy",
};

const STATUS_ICON: Record<string, string> = { passed: "✅", failed: "❌", skipped: "⏭️" };

export function TerraformReview({
  bundle,
  planSummary,
  report,
  freeTierMode,
}: {
  bundle: {
    files: TerraformFile[];
    attempts: Array<{ number: number; gates: GateResult[] }>;
    passed: boolean;
  };
  planSummary: PlanSummary | null;
  report: FreeTierReport | null;
  freeTierMode: "strict" | "flexible";
}) {
  const [selected, setSelected] = useState(bundle.files[0]?.path ?? "");
  const lastAttempt = bundle.attempts.at(-1);
  const file = bundle.files.find((f) => f.path === selected);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Terraform plan</h2>
        {planSummary && report && <FreeTierBadge fit={report.fit} />}
      </div>

      {lastAttempt && (
        <div className="text-sm">
          <p className="text-slate-400">
            Validation {bundle.passed ? "passed" : "did not pass"}
            {bundle.attempts.length > 1
              ? ` after ${bundle.attempts.length} attempts (the AI fixed the errors in between)`
              : " on the first attempt"}
            .
          </p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-3">
            {lastAttempt.gates.map((g) => (
              <li key={g.gate} title={[...g.errors, ...g.notes].join("\n")}>
                {STATUS_ICON[g.status]} {GATE_LABELS[g.gate] ?? g.gate}
              </li>
            ))}
          </ul>
        </div>
      )}

      {planSummary && (
        <div className="rounded border border-slate-700 p-4 text-sm">
          <p>
            <span className="text-emerald-300">+{planSummary.adds} to create</span> &middot;{" "}
            <span className="text-amber-300">~{planSummary.changes} to change</span> &middot;{" "}
            <span className="text-red-300">-{planSummary.destroys} to destroy</span>
            {planSummary.replaces > 0 && (
              <span className="text-red-300"> &middot; ±{planSummary.replaces} to replace</span>
            )}
          </p>
          {planSummary.dataBearingDestroys.length > 0 && (
            <p className="mt-2 text-red-300">
              ⚠️ Data loss: {planSummary.dataBearingDestroys.join(", ")} will be destroyed or
              replaced.
            </p>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-slate-400">All resources</summary>
            <ul className="mt-2 grid gap-0.5 font-mono text-xs sm:grid-cols-2">
              {planSummary.resources.map((r) => (
                <li key={r.address}>
                  {r.action === "create"
                    ? "+"
                    : r.action === "delete"
                      ? "-"
                      : r.action === "replace"
                        ? "±"
                        : "~"}{" "}
                  {r.address}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {report && report.denyListViolations.length > 0 && (
        <div className="rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
          <p className="font-medium">
            {freeTierMode === "flexible"
              ? "Paid resources -- you'll have to confirm these costs explicitly before anything is applied"
              : "Not Free-Tier-compliant"}
          </p>
          <ul className="mt-2 list-disc pl-5">
            {report.denyListViolations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {bundle.files.map((f) => (
            <button
              key={f.path}
              onClick={() => setSelected(f.path)}
              className={`rounded px-2 py-1 font-mono text-xs ${
                f.path === selected
                  ? "bg-slate-700 text-white"
                  : "bg-slate-900 text-slate-400 hover:text-slate-200"
              }`}
            >
              {f.path}
            </button>
          ))}
        </div>
        {file && (
          <pre className="max-h-[32rem] overflow-auto rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300">
            {file.content}
          </pre>
        )}
      </div>
    </section>
  );
}
