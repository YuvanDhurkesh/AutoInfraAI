import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneRepo, remoteDefaultBranch, scrubSecrets } from "./clone.js";

const TOKEN = "ghp_doNotLeakThisToken123";

function sh(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "init", "--quiet", "--initial-branch=main");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  sh(dir, "add", ".");
  sh(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "init");
}

describe("cloneRepo", () => {
  let root: string;
  const saved = { ...process.env };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-clone-test-"));
    // Submodules over the file protocol are off by default since git 2.38.1.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
  });
  afterAll(() => {
    process.env = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fetches submodules, so the build sees the whole tree", async () => {
    const lib = path.join(root, "lib");
    makeRepo(lib, { "index.js": "export const x = 1;\n" });
    const app = path.join(root, "app");
    makeRepo(app, { "package.json": "{}\n" });
    sh(app, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", lib, "vendor/lib");
    sh(
      app,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "-m",
      "sub",
    );

    const clone = await cloneRepo({
      repoUrl: `file://${app.replaceAll("\\", "/")}`,
      branch: "main",
    });
    try {
      expect(fs.readFileSync(path.join(clone.localPath, "vendor/lib/index.js"), "utf8")).toContain(
        "x = 1",
      );
      expect(clone.commitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await clone.cleanup();
    }
  }, 60_000);

  it("no branch given: clones the repository's default branch and names it (master, trunk...)", async () => {
    const repo = path.join(root, "trunk-repo");
    makeRepo(repo, { "index.js": "export const x = 1;\n" });
    sh(repo, "branch", "-m", "main", "trunk");
    const url = `file://${repo.replaceAll("\\", "/")}`;

    const clone = await cloneRepo({ repoUrl: url });
    try {
      expect(clone.branch).toBe("trunk");
      expect(fs.existsSync(path.join(clone.localPath, "index.js"))).toBe(true);
    } finally {
      await clone.cleanup();
    }
    expect(await remoteDefaultBranch({ repoUrl: url })).toBe("trunk");
    // Asking for a branch that isn't there still fails -- the caller says which one is.
    await expect(cloneRepo({ repoUrl: url, branch: "main" })).rejects.toThrow(/git clone failed/);
    expect(await remoteDefaultBranch({ repoUrl: "file:///nowhere/at/all" })).toBeUndefined();
  }, 60_000);

  it("checks files out exactly as stored (LF), even where git would convert to CRLF", async () => {
    const repo = path.join(root, "lf-repo");
    makeRepo(repo, {
      ".gitattributes": "* text=auto\n",
      Dockerfile: "FROM node:22 AS app\nRUN <<EOF\napt-get update\nEOF\n",
    });
    // Git for Windows' default: CRLF on checkout. The clone must not inherit it.
    const saved = { count: process.env.GIT_CONFIG_COUNT };
    process.env.GIT_CONFIG_COUNT = "3";
    process.env.GIT_CONFIG_KEY_1 = "core.autocrlf";
    process.env.GIT_CONFIG_VALUE_1 = "true";
    process.env.GIT_CONFIG_KEY_2 = "core.eol";
    process.env.GIT_CONFIG_VALUE_2 = "crlf";
    try {
      const clone = await cloneRepo({ repoUrl: `file://${repo.replaceAll("\\", "/")}` });
      try {
        const text = fs.readFileSync(path.join(clone.localPath, "Dockerfile"), "utf8");
        expect(text).toContain("apt-get update\n");
        expect(text).not.toContain("\r");
      } finally {
        await clone.cleanup();
      }
    } finally {
      process.env.GIT_CONFIG_COUNT = saved.count;
      for (const k of ["KEY_1", "VALUE_1", "KEY_2", "VALUE_2"])
        delete process.env[`GIT_CONFIG_${k}`];
    }
  }, 60_000);

  it("checks out paths longer than Windows' 260-character limit", async () => {
    const deep = path.join(root, "deep");
    const longName = `${["a", "b", "c", "d", "e"].map((c) => c.repeat(50)).join("/")}/index.js`;
    fs.mkdirSync(path.dirname(path.join(deep, longName)), { recursive: true });
    fs.writeFileSync(path.join(deep, longName), "export const deep = true;\n");
    const longGit = (...args: string[]) => sh(deep, "-c", "core.longpaths=true", ...args);
    longGit("init", "--quiet", "--initial-branch=main");
    longGit("add", ".");
    longGit("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "x");

    const clone = await cloneRepo({
      repoUrl: `file://${deep.replaceAll("\\", "/")}`,
      branch: "main",
    });
    try {
      expect(path.join(clone.localPath, longName).length).toBeGreaterThan(260);
      expect(fs.readFileSync(path.join(clone.localPath, longName), "utf8")).toContain("deep");
    } finally {
      await clone.cleanup();
    }
  }, 60_000);

  it("never puts the GitHub token in the error of a failed clone", async () => {
    const err = await cloneRepo({
      repoUrl: "https://127.0.0.1:9/owner/private-repo.git",
      branch: "main",
      githubToken: TOKEN,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^git clone failed/);
    expect((err as Error).message).not.toContain(TOKEN);
  }, 60_000);

  it("scrubs tokens and URL credentials from git output", () => {
    expect(
      scrubSecrets(
        `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/a/b/'`,
        TOKEN,
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/a/b/'");
    expect(scrubSecrets(`token ${TOKEN} in text`, TOKEN)).toBe("token *** in text");
  });
});
