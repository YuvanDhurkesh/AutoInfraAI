import { jobLogChannel, type PipelineDeps } from "./deps.js";

export interface JobLogger {
  info: (line: string) => Promise<void>;
  error: (line: string) => Promise<void>;
  end: (status: "succeeded" | "failed") => Promise<void>;
}

/** Persists each line (job_logs) and fans it out for the live SSE stream. */
export function jobLogger(
  deps: Pick<PipelineDeps, "prisma" | "publish">,
  jobId: string,
): JobLogger {
  async function write(line: string, stream: "stdout" | "stderr") {
    try {
      const row = await deps.prisma.jobLog.create({
        data: { jobId, line, stream },
        select: { seq: true },
      });
      await deps.publish?.(
        jobLogChannel(jobId),
        JSON.stringify({ type: "log", seq: row.seq, line, stream }),
      );
    } catch {
      // Logging must never fail the job itself.
    }
  }
  return {
    info: (line) => write(line, "stdout"),
    error: (line) => write(line, "stderr"),
    end: async (status) => {
      await Promise.resolve(
        deps.publish?.(jobLogChannel(jobId), JSON.stringify({ type: "end", status })),
      ).catch(() => undefined);
    },
  };
}

export async function finishJob(deps: Pick<PipelineDeps, "prisma">, jobId: string, error?: string) {
  await deps.prisma.job.update({
    where: { id: jobId },
    data: { status: error ? "failed" : "succeeded", finishedAt: new Date(), error },
  });
}

export async function failDeployment(
  deps: Pick<PipelineDeps, "prisma">,
  deploymentId: string,
  reason: string,
) {
  await deps.prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "failed", failureReason: reason },
  });
}
