import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "venv",
  "__pycache__",
]);

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000; // skip anything bigger when reading contents

export interface WalkedFile {
  absPath: string;
  relPath: string;
}

/** Bounded recursive walk -- caps file count so a huge or malicious repo can't hang the scanner. */
export function walk(root: string): WalkedFile[] {
  const results: WalkedFile[] = [];
  const stack: string[] = [root];

  while (stack.length > 0 && results.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const absPath = path.join(dir, entry.name);
        results.push({ absPath, relPath: path.relative(root, absPath) });
      }
    }
  }
  return results;
}

export function readFileSafe(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

export function exists(root: string, relPath: string): boolean {
  return fs.existsSync(path.join(root, relPath));
}

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".rs",
  ".cs",
  ".ex",
]);

export function isSourceFile(relPath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(relPath));
}
