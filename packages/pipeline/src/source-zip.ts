import fs from "node:fs";
import path from "node:path";
import type { TerraformFile } from "@autoinfra/shared";
import { buildZip, type ZipEntry } from "@autoinfra/terraform-runner";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".terraform",
  ".next",
  ".turbo",
  "__pycache__",
  "venv",
  ".venv",
]);
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

export class SourceTooLargeError extends Error {}

/**
 * The CodeBuild source: the repo at the pinned commit, plus AutoInfra's
 * generated files under .autoinfra/ (never committed to the user's repo).
 * .autoinfra/ rather than app/ because repos often have their own app/.
 */
export function buildSourceZip(
  repoDir: string,
  generated: TerraformFile[],
  platformApp: TerraformFile[],
): Buffer {
  const entries: ZipEntry[] = [];
  let total = 0;

  const stack = [repoDir];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks, sockets, etc.
      const rel = path.relative(repoDir, abs).split(path.sep).join("/");
      if (rel.startsWith(".autoinfra/")) continue; // ours wins
      const data = fs.readFileSync(abs);
      total += data.length;
      if (entries.length >= MAX_FILES || total > MAX_TOTAL_BYTES) {
        throw new SourceTooLargeError(
          "Repository is too large to build (over 20,000 files or 300 MB).",
        );
      }
      const mode =
        process.platform === "win32"
          ? rel.endsWith(".sh")
            ? 0o755
            : 0o644
          : fs.statSync(abs).mode & 0o777;
      entries.push({ name: rel, data, mode, deflate: true });
    }
  }

  const overlay = [
    ...generated
      .filter((f) => f.path.startsWith("app/"))
      .map((f) => ({ ...f, path: f.path.slice("app/".length) })),
    ...platformApp,
  ];
  for (const f of overlay) {
    entries.push({
      name: `.autoinfra/${f.path}`,
      data: Buffer.from(f.content.replaceAll("\r\n", "\n")),
      mode: f.path.endsWith(".sh") ? 0o755 : 0o644,
      deflate: true,
    });
  }
  return buildZip(entries.sort((a, b) => a.name.localeCompare(b.name)));
}
