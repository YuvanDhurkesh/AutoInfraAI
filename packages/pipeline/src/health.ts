import type { PipelineDeps } from "./deps.js";

const POLL_INTERVAL_MS = 10_000;

export interface HealthResult {
  ok: boolean;
  detail: string;
}

/**
 * Why an answer to the API path didn't come from the app, or undefined if it
 * did. S3 answering means CloudFront routed the path to the bucket (the SPA
 * fallback even makes that a 200 with index.html); an x-amzn-ErrorType is
 * the Lambda Function URL refusing CloudFront, not the app answering.
 */
export function notFromApp(headers: Headers): string | undefined {
  if (/amazons3/i.test(headers.get("server") ?? ""))
    return "answered by the S3 bucket, not the backend -- the path isn't routed to it";
  const lambdaError = headers.get("x-amzn-errortype");
  if (lambdaError) return `refused by Lambda (${lambdaError.split(":")[0]})`;
  return undefined;
}

async function poll(
  deps: Pick<PipelineDeps, "fetch" | "sleep">,
  url: string,
  accept: (status: number, body: string, headers: Headers) => boolean | string,
  timeoutMs: number,
): Promise<HealthResult> {
  // Bounded by attempts (not wall-clock time) so an injected sleep in tests
  // can't turn this into a busy loop.
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / POLL_INTERVAL_MS));
  let last = "no response";
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await deps.fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.text()).slice(0, 2000);
      const verdict = accept(res.status, body, res.headers);
      if (verdict === true) return { ok: true, detail: `${url} -> ${res.status}` };
      last =
        typeof verdict === "string"
          ? `${res.status} (${verdict})`
          : `${res.status}${body.includes('"deploying"') ? " (placeholder still serving)" : ""}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= maxAttempts) return { ok: false, detail: `${url} -> ${last}` };
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

export function apiHealthPath(apiPathPrefix: string, healthCheckPath: string): string {
  if (healthCheckPath.startsWith(`${apiPathPrefix}/`) || healthCheckPath === apiPathPrefix)
    return healthCheckPath;
  if (healthCheckPath === "/") return `${apiPathPrefix}/`;
  return `${apiPathPrefix}${healthCheckPath}`;
}

/**
 * Sec. 5 Step 6: check the frontend and the backend *through CloudFront*.
 * The API check goes through the same distribution and path prefix the
 * frontend uses, so passing it means the frontend -> backend call works.
 * Any non-5xx answer from the app counts as "the app is running" (a 404
 * from the app itself is still the app); the 503 placeholder, and answers
 * from S3 or a Lambda URL refusing CloudFront, do not.
 */
export async function checkHealth(
  deps: Pick<PipelineDeps, "fetch" | "sleep">,
  opts: {
    baseUrl: string;
    hasBackend: boolean;
    /** False for an API-only app: its "/" may well be a 404, which still means it's up. */
    hasFrontend?: boolean;
    apiPathPrefix: string;
    healthCheckPath: string;
    timeoutMs?: number;
  },
): Promise<{ frontend: HealthResult; api?: HealthResult }> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const frontend = await poll(
    deps,
    `${opts.baseUrl}/`,
    opts.hasFrontend === false
      ? (s, body) => s < 500 && !body.includes('"error":"deploying"')
      : (s) => s === 200,
    timeoutMs,
  );
  if (!opts.hasBackend) return { frontend };
  const api = await poll(
    deps,
    `${opts.baseUrl}${apiHealthPath(opts.apiPathPrefix, opts.healthCheckPath)}`,
    (s, body, headers) => notFromApp(headers) ?? (s < 500 && !body.includes('"error":"deploying"')),
    timeoutMs,
  );
  return { frontend, api };
}
