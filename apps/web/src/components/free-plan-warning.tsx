"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { AwsConnectionSummary } from "@/components/connect-aws";

const DAY = 24 * 60 * 60 * 1000;

/**
 * AWS's new-model Free plan closes the account when the plan ends (6 months
 * or when credits run out) unless the owner upgrades it. AutoInfra never
 * upgrades for them, so it has to say so loudly and early.
 */
export function FreePlanWarning() {
  const [connections, setConnections] = useState<AwsConnectionSummary[]>([]);

  useEffect(() => {
    apiFetch("/aws/connections")
      .then((rows: AwsConnectionSummary[]) => setConnections(rows))
      .catch(() => undefined);
  }, []);

  const onFreePlan = connections.filter((c) => c.verifiedAt && c.accountRegime === "free_plan");
  if (onFreePlan.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {onFreePlan.map((c) => {
        const plan = c.freePlan;
        const expires = plan?.expiresAt ? new Date(plan.expiresAt) : null;
        const daysLeft = expires ? Math.ceil((expires.getTime() - Date.now()) / DAY) : null;
        const urgent = daysLeft !== null && daysLeft <= 30;
        return (
          <div
            key={c.id}
            className={`rounded border p-4 text-sm ${
              urgent
                ? "border-red-800 bg-red-950/60 text-red-200"
                : "border-amber-800 bg-amber-950/40 text-amber-100"
            }`}
          >
            <p className="font-medium">
              Your AWS account ({c.region}) is on AWS&apos;s Free plan
              {daysLeft !== null &&
                (daysLeft > 0
                  ? `, which ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
                  : ", which has ended")}
              .
            </p>
            <p className="mt-1">
              When the plan ends{expires ? ` (${expires.toLocaleDateString()})` : ""} or its credits
              run out, AWS closes the account unless you upgrade it to a paid plan, and everything
              deployed there stops. AutoInfra never upgrades your account for you.
              {plan?.remainingCredits &&
                ` Credits left: ${plan.remainingCredits.amount.toFixed(2)} ${plan.remainingCredits.unit}.`}
            </p>
            {plan?.checkedAt && (
              <p className="mt-1 text-xs opacity-70">
                As reported by AWS on {new Date(plan.checkedAt).toLocaleDateString()}.
              </p>
            )}
            {!plan?.expiresAt && (
              <p className="mt-1 text-xs opacity-70">
                AWS didn&apos;t report the end date; check it in the AWS Billing console.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
