import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand,
} from "@aws-sdk/client-codebuild";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { AwsCredentialIdentity } from "@smithy/types";

/**
 * Network errors worth retrying: a flaky connection, a DNS outage, or S3
 * giving up on a stalled upload -- not an AWS rejection.
 */
const NETWORK_ERRORS = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "RequestTimeout",
  "TimeoutError",
]);

/** Each part is retried on its own, so a dropped connection costs one part, not the upload. */
const PART_BYTES = 8 * 1024 * 1024;

/**
 * Retries `send` on network errors for about a minute (2 s, 4 s ... 30 s
 * apart): the SDK's own retries are spent within a second, but a slow or
 * mobile connection can drop for longer.
 */
export async function withNetworkRetry<T>(
  send: () => Promise<T>,
  delaysMs = [2000, 4000, 8000, 16000, 30000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const { code, name } = err as { code?: string; name?: string };
      const network = NETWORK_ERRORS.has(code ?? "") || NETWORK_ERRORS.has(name ?? "");
      if (!network || attempt >= delaysMs.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}

export async function uploadObject(
  credentials: AwsCredentialIdentity,
  region: string,
  bucket: string,
  key: string,
  body: Buffer,
) {
  const s3 = new S3Client({ region, credentials });
  const target = { Bucket: bucket, Key: key };
  if (body.length <= PART_BYTES) {
    await withNetworkRetry(() =>
      s3.send(new PutObjectCommand({ ...target, Body: body, ServerSideEncryption: "AES256" })),
    );
    return;
  }

  const { UploadId } = await withNetworkRetry(() =>
    s3.send(new CreateMultipartUploadCommand({ ...target, ServerSideEncryption: "AES256" })),
  );
  try {
    const parts: Array<{ ETag?: string; PartNumber: number }> = [];
    for (let offset = 0; offset < body.length; offset += PART_BYTES) {
      const PartNumber = parts.length + 1;
      const Body = body.subarray(offset, offset + PART_BYTES);
      const { ETag } = await withNetworkRetry(() =>
        s3.send(new UploadPartCommand({ ...target, UploadId, PartNumber, Body })),
      );
      parts.push({ ETag, PartNumber });
    }
    await withNetworkRetry(() =>
      s3.send(
        new CompleteMultipartUploadCommand({
          ...target,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
    );
  } catch (err) {
    // The artifacts bucket's lifecycle rule also cleans up unfinished uploads
    // (the deploy role may not be allowed to abort).
    await s3.send(new AbortMultipartUploadCommand({ ...target, UploadId })).catch(() => undefined);
    throw err;
  }
}

export type BuildStatus =
  "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "FAULT" | "TIMED_OUT" | "STOPPED";

export interface RunBuildOptions {
  credentials: AwsCredentialIdentity;
  region: string;
  projectName: string;
  /** Called for each new CloudWatch log line from the build. */
  onLog?: (line: string) => void | Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Starts the deployment's CodeBuild project (Sec. 3.2) and follows it to
 * completion, streaming its CloudWatch log lines as they appear.
 */
export async function runCodeBuild(
  opts: RunBuildOptions,
): Promise<{ status: BuildStatus; buildId: string }> {
  const codebuild = new CodeBuildClient({ region: opts.region, credentials: opts.credentials });
  const logs = new CloudWatchLogsClient({ region: opts.region, credentials: opts.credentials });
  const started = await codebuild.send(new StartBuildCommand({ projectName: opts.projectName }));
  const buildId = started.build?.id;
  if (!buildId) throw new Error("CodeBuild did not return a build id");

  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  let nextToken: string | undefined;

  for (;;) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 8000));
    const { builds } = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = builds?.[0];
    const group = build?.logs?.groupName;
    const stream = build?.logs?.streamName;

    if (group && stream) {
      try {
        for (;;) {
          const page = await logs.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName: stream,
              nextToken,
              startFromHead: true,
            }),
          );
          for (const e of page.events ?? []) {
            const line = (e.message ?? "").trimEnd();
            if (line) await opts.onLog?.(line);
          }
          if (!page.nextForwardToken || page.nextForwardToken === nextToken) break;
          nextToken = page.nextForwardToken;
        }
      } catch {
        // The log stream appears a little after the build starts.
      }
    }

    const status = (build?.buildStatus ?? "IN_PROGRESS") as BuildStatus;
    if (status !== "IN_PROGRESS") return { status, buildId };
    if (Date.now() > deadline) return { status: "TIMED_OUT", buildId };
  }
}

/** Last lines of a log group, for failure diagnostics (e.g. a Lambda's logs). */
export async function recentLogLines(
  credentials: AwsCredentialIdentity,
  region: string,
  logGroupName: string,
  limit = 50,
): Promise<string[]> {
  const logs = new CloudWatchLogsClient({ region, credentials });
  try {
    const res = await logs.send(
      new FilterLogEventsCommand({ logGroupName, startTime: Date.now() - 30 * 60_000, limit: 500 }),
    );
    return (res.events ?? []).slice(-limit).map((e) => (e.message ?? "").trimEnd());
  } catch {
    return [];
  }
}
