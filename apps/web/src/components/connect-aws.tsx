"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL, apiFetch } from "@/lib/api-client";
import { PermissionUpdate } from "./permission-update";

export interface AwsConnectionSummary {
  id: string;
  region: string;
  roleArn: string | null;
  accountRegime: "legacy_12mo" | "free_plan" | "paid_plan" | null;
  regimeSource: "freetier-api" | "user" | null;
  verifiedAt: string | null;
  quickCreateUrl?: string | null;
  connectError?: string | null;
  needsPermissionUpdate?: boolean;
  freePlan?: {
    status: string | null;
    expiresAt: string | null;
    remainingCredits: { amount: number; unit: string } | null;
    checkedAt: string | null;
  } | null;
}

const REGIME_LABELS: Record<string, string> = {
  legacy_12mo: "Legacy 12-month Free Tier",
  free_plan: "Free plan (credit-based)",
  paid_plan: "Paid plan",
};

/**
 * One-click connect: opens the AWS console with a pre-filled CloudFormation
 * stack. When the user clicks "Create stack", the stack reports back to
 * AutoInfra by itself, so this component just waits -- no ARN to paste.
 */
export function ConnectAws({ onConnected }: { onConnected?: (c: AwsConnectionSummary) => void }) {
  const [connection, setConnection] = useState<AwsConnectionSummary | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regime, setRegime] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const notified = useRef(false);

  const ready = !!connection?.verifiedAt && !!connection.accountRegime;

  useEffect(() => {
    apiFetch("/aws/connections")
      .then(async (list: AwsConnectionSummary[]) => {
        const existing = list[0];
        if (existing) {
          setConnection(existing);
          if (!existing.verifiedAt) {
            const l = (await apiFetch(
              `/aws/connections/${existing.id}/connect-link`,
            )) as AwsConnectionSummary;
            setLink(l.quickCreateUrl ?? null);
            setLinkError(l.connectError ?? null);
          }
        } else {
          const created = (await apiFetch("/aws/connections", {
            method: "POST",
            body: "{}",
          })) as AwsConnectionSummary;
          setConnection(created);
          setLink(created.quickCreateUrl ?? null);
          setLinkError(created.connectError ?? null);
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  // Wait for the stack's callback to verify the role.
  useEffect(() => {
    if (!connection || connection.verifiedAt) return;
    const timer = setInterval(async () => {
      try {
        setConnection(
          (await apiFetch(`/aws/connections/${connection.id}`)) as AwsConnectionSummary,
        );
      } catch {
        // keep polling
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [connection]);

  useEffect(() => {
    if (ready && connection && !notified.current) {
      notified.current = true;
      onConnected?.(connection);
    }
  }, [ready, connection, onConnected]);

  const submitRegime = useCallback(async () => {
    if (!connection || !regime) return;
    try {
      setConnection(
        (await apiFetch(`/aws/connections/${connection.id}/regime`, {
          method: "POST",
          body: JSON.stringify({ regime }),
        })) as AwsConnectionSummary,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save");
    }
  }, [connection, regime]);

  async function manualConnect() {
    if (!connection) return;
    setError(null);
    try {
      await apiFetch(`/aws/connections/${connection.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ roleArn }),
      });
      setConnection(
        (await apiFetch(`/aws/connections/${connection.id}/verify`, {
          method: "POST",
        })) as AwsConnectionSummary,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "verification failed");
    }
  }

  if (!connection) {
    return <p className="text-sm text-slate-400">{error ?? "Preparing your AWS connection..."}</p>;
  }

  if (ready) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded border border-emerald-700 bg-emerald-950/30 p-4 text-sm">
          <p className="font-medium text-emerald-300">AWS connected</p>
          <p className="mt-1 text-slate-300">
            {REGIME_LABELS[connection.accountRegime!]} &middot; deploying to {connection.region}
          </p>
        </div>
        {connection.needsPermissionUpdate && <PermissionUpdate connectionId={connection.id} />}
      </div>
    );
  }

  if (connection.verifiedAt && !connection.accountRegime) {
    return (
      <div className="flex flex-col gap-2 rounded border border-amber-700 bg-amber-950/40 p-4 text-sm">
        <p className="text-slate-200">
          Connected. AWS didn&apos;t tell us your Free Tier plan -- was this account created before
          July 15, 2025?
        </p>
        <select
          value={regime}
          onChange={(e) => setRegime(e.target.value)}
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
        >
          <option value="">Select...</option>
          <option value="legacy_12mo">Yes -- created before July 15, 2025</option>
          <option value="free_plan">No -- new account, on the Free plan (credits)</option>
          <option value="paid_plan">No -- new account, upgraded to Paid</option>
        </select>
        <button
          onClick={submitRegime}
          className="self-start rounded bg-indigo-500 px-4 py-2 font-medium text-white"
        >
          Save
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-slate-700 p-4 text-sm">
      <p className="text-slate-300">
        AutoInfra deploys into your own AWS account through a role you approve once. No access keys,
        nothing to copy.
      </p>
      {link ? (
        <>
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpened(true)}
            className="self-start rounded bg-indigo-500 px-4 py-2 font-medium text-white"
          >
            Connect AWS
          </a>
          <p className="text-slate-400">
            In the AWS tab: tick{" "}
            <em>
              &quot;I acknowledge that AWS CloudFormation might create IAM resources with custom
              names&quot;
            </em>
            , then click <strong>Create stack</strong>.
          </p>
          {opened && (
            <p className="animate-pulse text-indigo-300">
              Waiting for AWS to confirm... (usually under a minute after you click Create stack)
            </p>
          )}
        </>
      ) : (
        linkError && <p className="text-amber-300">{linkError}</p>
      )}

      <details className="text-slate-400">
        <summary className="cursor-pointer">Do it manually instead</summary>
        <div className="mt-2 flex flex-col gap-2">
          <a
            href={`${API_BASE_URL}/aws/connections/${connection.id}/template`}
            className="self-start rounded border border-slate-600 px-3 py-1.5 text-slate-200"
          >
            Download template
          </a>
          <p>Create a stack from it in CloudFormation, then paste the RoleArn output:</p>
          <div className="flex gap-2">
            <input
              value={roleArn}
              onChange={(e) => setRoleArn(e.target.value)}
              placeholder="arn:aws:iam::123456789012:role/AutoInfraDeployRole"
              className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2"
            />
            <button
              onClick={manualConnect}
              className="rounded border border-slate-600 px-3 py-2 text-slate-200"
            >
              Verify
            </button>
          </div>
        </div>
      </details>
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}
