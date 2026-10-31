import { run, toolEnv } from "./exec.js";

/** Same pins as apps/worker/Dockerfile. */
export const TFLINT_IMAGE = "ghcr.io/terraform-linters/tflint:v0.54.0";
export const TRIVY_IMAGE = "aquasec/trivy:0.58.1";

export interface ResolvedTool {
  /** Builds the full command line for running this tool against `dir`. */
  command: (dir: string, args: string[]) => { command: string; args: string[] };
  via: "native" | "docker";
}

async function works(command: string, args: string[]): Promise<boolean> {
  const result = await run(command, args, {
    cwd: process.cwd(),
    env: toolEnv({}),
    timeoutMs: 30_000,
  });
  return result.code === 0;
}

/**
 * Native binary first (the worker image has them pinned); on a dev machine
 * without them, the same pinned version via Docker; otherwise null and the
 * gate is reported as skipped -- never silently passed.
 */
export async function resolveTool(name: "tflint" | "trivy"): Promise<ResolvedTool | null> {
  if (await works(name, ["--version"])) {
    return { via: "native", command: (_dir, args) => ({ command: name, args }) };
  }
  if (await works("docker", ["version", "--format", "{{.Server.Version}}"])) {
    const image = name === "tflint" ? TFLINT_IMAGE : TRIVY_IMAGE;
    return {
      via: "docker",
      command: (dir, args) => ({
        command: "docker",
        args: [
          "run",
          "--rm",
          "--network",
          name === "trivy" ? "bridge" : "none",
          "-v",
          `${dir}:/src`,
          "-w",
          "/src",
          image,
          ...args,
        ],
      }),
    };
  }
  return null;
}
