"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface UpdateSteps {
  stackName: string;
  region: string;
  templateUrl: string;
  consoleUrl: string;
  command: string;
}

/**
 * Shown when the user's AWS role was created from an older AutoInfra
 * template. Updating the stack keeps the role and connection; the stack
 * reports the new version back, and this banner disappears.
 */
export function PermissionUpdate({ connectionId }: { connectionId: string }) {
  const [steps, setSteps] = useState<UpdateSteps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setSteps(await apiFetch(`/aws/connections/${connectionId}/permission-update`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not prepare the update");
    }
  }

  function copy(label: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-amber-700 bg-amber-950/30 p-4 text-sm text-amber-100">
      <p className="font-medium">Your AWS connection needs updated permissions</p>
      <p>
        AutoInfra&apos;s role was created from an older template, so some steps (like Destroy) may
        fail with &quot;AccessDenied&quot;. Updating it keeps your role and connection -- it only
        adds the newer permissions.
      </p>
      {!steps ? (
        <button
          onClick={load}
          className="self-start rounded bg-amber-600 px-3 py-1.5 font-medium text-white"
        >
          Show me how
        </button>
      ) : (
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          <li>
            Open{" "}
            <a href={steps.consoleUrl} target="_blank" rel="noreferrer" className="underline">
              your stack {steps.stackName}
            </a>{" "}
            in CloudFormation ({steps.region}), then <strong>Update</strong> &rarr;{" "}
            <strong>Replace existing template</strong> &rarr; <strong>Amazon S3 URL</strong>.
          </li>
          <li>
            Paste this template URL (valid for 1 hour):{" "}
            <button
              onClick={() => copy("url", steps.templateUrl)}
              className="rounded border border-amber-700 px-2 py-0.5 text-xs"
            >
              {copied === "url" ? "Copied" : "Copy URL"}
            </button>
          </li>
          <li>
            Click <strong>Next</strong> twice (keep every parameter), tick the IAM checkbox, and{" "}
            <strong>Submit</strong>. This message disappears about a minute after the update
            finishes.
          </li>
          <li className="list-none text-amber-200/80">
            Or run it in one command:{" "}
            <button
              onClick={() => copy("cmd", steps.command)}
              className="rounded border border-amber-700 px-2 py-0.5 text-xs"
            >
              {copied === "cmd" ? "Copied" : "Copy AWS CLI command"}
            </button>
          </li>
        </ol>
      )}
      {error && <p className="text-red-300">{error}</p>}
    </section>
  );
}
