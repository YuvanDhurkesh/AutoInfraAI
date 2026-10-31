import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One git command may take this long by default (a large repo or LFS objects on a slow link). */
const GIT_TIMEOUT_MS = 10 * 60_000;

export interface CloneRepoInput {
  repoUrl: string;
  /** Left out: the repository's own default branch (main, master, trunk...). */
  branch?: string;
  /** Pin to an exact commit instead of a branch tip. */
  commitSha?: string;
  /** GitHub token for private repos -- injected into the URL for this clone
   * only, never logged or persisted (Sec. 5: "user's GitHub token for
   * private repos"). */
  githubToken?: string;
  /** Limit for each git command (default 10 minutes); an API request passes less. */
  timeoutMs?: number;
}

export interface ClonedRepo {
  localPath: string;
  commitSha: string;
  /** The branch cloned: the one asked for, or the repository's default. */
  branch?: string;
  cleanup: () => Promise<void>;
}

function withToken(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

const GIT_COMMANDS = new Set([
  "ls-remote",
  "init",
  "remote",
  "fetch",
  "checkout",
  "clone",
  "submodule",
  "lfs",
  "rev-parse",
]);

/** Removes the token (and any user:password@ in a URL) from git's output. */
export function scrubSecrets(text: string, token?: string): string {
  let out = text.replace(/(https?:\/\/)[^/\s@]+@/g, "$1***@");
  if (token) out = out.split(token).join("***");
  return out;
}

/**
 * Files exactly as the repository stores them: Git for Windows checks text
 * files out with CRLF by default, and a Dockerfile heredoc or a shell script
 * with \r breaks on the Linux build ("apt-get update\r"). And on Windows,
 * long paths: a repo with paths over 260 characters (deep monorepos, long
 * sample names) otherwise clones but fails to check out.
 */
const CHECKOUT_CONFIG = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
];

/**
 * Runs git without ever prompting (a private repo without a token must fail,
 * not wait for a password) and with a time limit. A failure is rethrown
 * with the token scrubbed: execFile's own message contains the command
 * line, which holds the tokenized URL.
 */
async function git(args: string[], token?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...CHECKOUT_CONFIG, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message?: string };
    const command = args.find((a) => GIT_COMMANDS.has(a)) ?? "";
    const reason = e.killed
      ? `timed out after ${Math.round(timeoutMs / 1000)} seconds`
      : (e.stderr || e.message || String(err)).trim();
    throw new Error(scrubSecrets(`git ${command} failed: ${reason}`, token));
  }
}

/**
 * Submodules on GitHub, cloned with the same token; SSH URLs
 * (git@github.com:owner/repo) go over HTTPS, since the worker has no SSH key.
 */
function githubUrlRewrites(token?: string): string[] {
  const https = token ? `https://x-access-token:${token}@github.com/` : "https://github.com/";
  return [
    "-c",
    `url.${https}.insteadOf=git@github.com:`,
    "-c",
    `url.${https}.insteadOf=ssh://git@github.com/`,
    ...(token ? ["-c", `url.${https}.insteadOf=https://github.com/`] : []),
  ];
}

function usesLfs(localPath: string): boolean {
  try {
    return /filter=lfs\b/.test(fs.readFileSync(path.join(localPath, ".gitattributes"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Shallow clone to a temp dir, pinned to an exact commit (Sec. 5: "Pin the
 * commit SHA per revision"). Fetching a specific commitSha requires the
 * server to support fetching by SHA (GitHub does); falling back to a full
 * branch fetch if that's rejected. Submodules and Git LFS files are fetched
 * too, so the build sees the same tree a developer's checkout has.
 */
export async function cloneRepo(input: CloneRepoInput): Promise<ClonedRepo> {
  const localPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autoinfra-repo-"));
  const token = input.githubToken;
  const authedUrl = withToken(input.repoUrl, token);
  const branch = input.branch || undefined;
  const timeout = input.timeoutMs;

  try {
    if (input.commitSha) {
      await git(["init", "--quiet", localPath], token, timeout);
      await git(["-C", localPath, "remote", "add", "origin", authedUrl], token, timeout);
      try {
        await git(
          ["-C", localPath, "fetch", "--depth", "1", "origin", input.commitSha],
          token,
          timeout,
        );
      } catch {
        // Some servers reject fetching an arbitrary SHA directly -- fall
        // back to fetching the branch and hoping the commit is its tip or
        // reachable within the shallow history.
        await git(
          ["-C", localPath, "fetch", "--depth", "50", "origin", branch ?? "HEAD"],
          token,
          timeout,
        );
      }
      await git(["-C", localPath, "checkout", "--quiet", input.commitSha], token, timeout);
    } else {
      // No branch: git clones the repository's default branch.
      await git(
        [
          "clone",
          "--quiet",
          "--depth",
          "1",
          ...(branch ? ["--branch", branch] : []),
          authedUrl,
          localPath,
        ],
        token,
        timeout,
      );
    }

    if (fs.existsSync(path.join(localPath, ".gitmodules"))) {
      const update = [
        ...githubUrlRewrites(token),
        "-C",
        localPath,
        "submodule",
        "update",
        "--init",
        "--recursive",
      ];
      try {
        await git([...update, "--depth", "1"], token, timeout);
      } catch {
        // A submodule pinned to a commit that isn't its branch tip may not be
        // fetchable shallowly.
        await git(update, token, timeout);
      }
    }

    if (usesLfs(localPath)) {
      try {
        await git(["lfs", "version"], token, timeout);
      } catch {
        throw new Error(
          "The repository stores files with Git LFS, but git-lfs isn't installed where AutoInfra runs.",
        );
      }
      await git(["-C", localPath, "lfs", "pull"], token, timeout);
    }

    const commitSha = (await git(["-C", localPath, "rev-parse", "HEAD"], token, timeout)).trim();
    // A pinned commit is checked out detached; otherwise HEAD names the branch cloned.
    const cloned = input.commitSha
      ? branch
      : (branch ??
        ((
          await git(["-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"], token, timeout)
        ).trim() ||
          undefined));
    return {
      localPath,
      commitSha,
      branch: cloned,
      cleanup: () => fs.promises.rm(localPath, { recursive: true, force: true }),
    };
  } catch (err) {
    await fs.promises.rm(localPath, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err), token));
  }
}

/**
 * The repository's default branch ("master" for many older repos), asked of
 * the server without cloning -- so a clone of a branch that doesn't exist
 * can say which one does. Undefined when the server can't be asked.
 */
export async function remoteDefaultBranch(input: {
  repoUrl: string;
  githubToken?: string;
}): Promise<string | undefined> {
  try {
    const out = await git(
      ["ls-remote", "--symref", withToken(input.repoUrl, input.githubToken), "HEAD"],
      input.githubToken,
      30_000,
    );
    return out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  } catch {
    return undefined;
  }
}
