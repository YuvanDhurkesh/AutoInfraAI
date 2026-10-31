import { spawn } from "node:child_process";
import os from "node:os";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const PASSTHROUGH = [
  "PATH",
  "Path",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ComSpec",
  "PATHEXT",
  // A proxy (and its CA) is how a company or campus network reaches the
  // Terraform registry and AWS; without these, every init fails there.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Environment for child tools (terraform, tflint, trivy, docker). Built from
 * an allowlist so platform secrets in process.env (DATABASE_URL,
 * GEMINI_API_KEY, COOKIE_SECRET, ...) never reach LLM-generated code. Shared
 * AWS config files and instance metadata are disabled so Terraform can only
 * use the short-lived credentials passed in -- never the platform's own.
 */
export function toolEnv(opts: {
  credentials?: AwsCredentials | null;
  region?: string;
  pluginCacheDir?: string;
}) {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const devNull = os.platform() === "win32" ? "NUL" : "/dev/null";
  Object.assign(env, {
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
    AWS_SHARED_CREDENTIALS_FILE: devNull,
    AWS_CONFIG_FILE: devNull,
    AWS_EC2_METADATA_DISABLED: "true",
  });
  if (opts.pluginCacheDir) {
    env.TF_PLUGIN_CACHE_DIR = opts.pluginCacheDir;
    // Every run starts in a fresh dir with no lock file; without this,
    // Terraform >= 1.4 ignores the cache and re-downloads the AWS provider
    // (~3 minutes) on every validation attempt.
    env.TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE = "1";
  }
  if (opts.region) env.AWS_REGION = opts.region;
  if (opts.credentials) {
    env.AWS_ACCESS_KEY_ID = opts.credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = opts.credentials.secretAccessKey;
    if (opts.credentials.sessionToken) env.AWS_SESSION_TOKEN = opts.credentials.sessionToken;
  }
  return env;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Like run(), but delivers stdout line by line as it arrives (for -json streams). */
export function runStreaming(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    onLine: (line: string) => void;
  },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let buffer = "";
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(ANSI, "").trimEnd();
        buffer = buffer.slice(idx + 1);
        if (line) opts.onLine(line);
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) opts.onLine(buffer.trim());
      resolve({ code: code ?? 1, stdout, stderr: stderr.replace(ANSI, ""), timedOut });
    });
  });
}

export function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: stdout.replace(ANSI, ""),
        stderr: stderr.replace(ANSI, ""),
        timedOut,
      });
    });
  });
}
