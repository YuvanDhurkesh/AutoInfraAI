import type { ExecResult } from "./exec.js";

/**
 * A failure to reach the network (the Terraform registry, S3, an AWS API):
 * nothing in the files is wrong, so it is retried -- and never handed to the
 * model as something to fix.
 */
const NETWORK_ERROR =
  /could not connect to registry|failed to request discovery document|context deadline exceeded|Client\.Timeout exceeded|TLS handshake timeout|i\/o timeout|connection reset by peer|connection refused|no such host|network is unreachable|send request failed|dial tcp/i;

export function isNetworkError(output: string): boolean {
  return NETWORK_ERROR.test(output);
}

/** Waits between init attempts: a dropped connection or a registry blip usually passes in a minute. */
export const INIT_RETRY_DELAYS_MS = [15_000, 45_000];

export interface InitResult extends ExecResult {
  /** The last attempt failed for a network reason: retry later, nothing to repair. */
  networkError: boolean;
  attempts: number;
}

/**
 * `terraform init`, retried when it fails for a network reason. A timeout
 * (a provider download slower than five minutes) counts as a network
 * failure but isn't retried: two more would take a quarter of an hour.
 */
export async function initWithRetry(
  init: () => Promise<ExecResult>,
  opts: {
    delaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, waitMs: number) => unknown;
  } = {},
): Promise<InitResult> {
  const delays = opts.delaysMs ?? INIT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const result = await init();
    const networkError = result.code !== 0 && (result.timedOut || isNetworkError(result.stderr));
    if (result.code === 0 || !networkError || result.timedOut || attempt > delays.length)
      return { ...result, networkError, attempts: attempt };
    const wait = delays[attempt - 1]!;
    await opts.onRetry?.(attempt, wait);
    await sleep(wait);
  }
}

/** What to tell the owner when init never reached the network. */
export function networkFailureMessage(result: InitResult): string {
  const first = result.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^(Error:|Initializing)/.test(l));
  return result.timedOut
    ? "terraform init timed out after 5 minutes downloading providers -- the network of the machine running the worker is too slow or down. Nothing is wrong with the Terraform; retry once the connection is better."
    : `terraform init couldn't reach the network after ${result.attempts} attempts${first ? ` (${first})` : ""} -- a connection problem on the machine running the worker (the Terraform registry or AWS was unreachable), not a problem in the Terraform. Check its internet connection and retry.`;
}
