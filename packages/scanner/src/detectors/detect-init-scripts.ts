import fs from "node:fs";
import path from "node:path";
import { readFileSafe } from "../fs-utils.js";

const INIT_DIRS = new Set([
  "database",
  "db",
  "sql",
  "init",
  "initdb",
  "docker-entrypoint-initdb.d",
  "schema",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "migrations",
  "migration",
  "seeds",
  "test",
  "tests",
]);
const MAX_SCRIPTS = 10;
const SQL_KEYWORDS = new Set([
  "if",
  "not",
  "exists",
  "database",
  "schema",
  "table",
  "or",
  "replace",
]);

function sqlFilesIn(dir: string, relativeTo: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".sql"))
      .map((e) => path.relative(relativeTo, path.join(dir, e.name)).split(path.sep).join("/"))
      .sort();
  } catch {
    return [];
  }
}

/** Host paths a compose file mounts into a database image's initdb directory. */
function composeInitMounts(root: string, relativeTo: string): string[] {
  const found: string[] = [];
  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    const compose = readFileSafe(path.join(root, name));
    if (!compose) continue;
    for (const match of compose.matchAll(
      /-\s*["']?(\.{1,2}\/[^:"'\s]+):\/docker-entrypoint-initdb\.d/g,
    )) {
      const host = path.resolve(root, match[1]!);
      if (!host.startsWith(path.resolve(root) + path.sep)) continue; // never outside the checkout
      const stat = fs.statSync(host, { throwIfNoEntry: false });
      if (stat?.isFile() && host.endsWith(".sql")) found.push(path.relative(relativeTo, host));
      else if (stat?.isDirectory()) found.push(...sqlFilesIn(host, relativeTo));
    }
  }
  return found.map((p) => p.split(path.sep).join("/"));
}

/**
 * The database the scripts create/switch to ("CREATE DATABASE todo_db" /
 * "USE todo_db" / "\c todo_db"), so the app is pointed at the same one.
 */
export function detectInitDatabaseName(repoRoot: string, scripts: string[]): string | undefined {
  for (const script of scripts) {
    const raw = readFileSafe(path.join(repoRoot, script));
    if (!raw) continue;
    // Comments first: "-- Create database if it doesn't exist" is prose, not SQL.
    const sql = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|#).*$/gm, " ");
    const candidates = [
      ...sql.matchAll(
        /create\s+(?:database|schema)\s+(?:if\s+not\s+exists\s+)?[`"]?([A-Za-z_][\w$]*)/gi,
      ),
      ...sql.matchAll(/^\s*(?:use|\\c)\s+[`"]?([A-Za-z_][\w$]*)/gim),
    ].map((m) => m[1]!);
    const name = candidates.find((c) => !SQL_KEYWORDS.has(c.toLowerCase()));
    if (name) return name;
  }
  return undefined;
}

/**
 * SQL scripts that create the app's schema on a fresh database: whatever the
 * repo's own compose file mounts into /docker-entrypoint-initdb.d, plus .sql
 * files in conventional folders (database/, db/, sql/, ...). Migration
 * folders are skipped -- the app's migration tool runs those itself.
 */
export function detectInitScripts(root: string, relativeTo: string = root): string[] {
  const scripts = new Set(composeInitMounts(root, relativeTo));
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const full = path.join(dir, e.name);
      if (INIT_DIRS.has(e.name.toLowerCase()))
        sqlFilesIn(full, relativeTo).forEach((s) => scripts.add(s));
      if (depth < 2) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return [...scripts].slice(0, MAX_SCRIPTS);
}
