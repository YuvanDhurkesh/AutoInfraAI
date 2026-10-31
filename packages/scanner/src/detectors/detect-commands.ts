import fs from "node:fs";
import path from "node:path";
import { exists, readFileSafe, walk } from "../fs-utils.js";
import type { PackageJson } from "../package-json.js";

/**
 * How to install a Node app's dependencies, from its lockfile. Each command
 * falls back to a plain install: a lockfile out of sync with package.json,
 * or peer-dependency conflicts (ERESOLVE), are the most common reasons a
 * repo that works on its author's machine fails a clean CI install.
 */
/**
 * pnpm through Corepack (it honours the repo's "packageManager" pin); when
 * Corepack can't start that version -- Node's bundled Corepack can't run
 * pnpm 12 -- npm's pnpm, which then switches to the pinned version itself.
 */
export const PNPM_READY =
  "(corepack enable && pnpm --version > /dev/null 2>&1 || (corepack disable pnpm; npm install -g pnpm))";

export function nodeInstallCommand(dir: string, repoRoot: string): string {
  const has = (name: string) => exists(dir, name) || (dir !== repoRoot && exists(repoRoot, name));
  if (exists(dir, "pnpm-lock.yaml") || (!exists(dir, "package-lock.json") && has("pnpm-lock.yaml")))
    return `${PNPM_READY} && (pnpm install --frozen-lockfile || pnpm install)`;
  if (exists(dir, "yarn.lock") || (!exists(dir, "package-lock.json") && has("yarn.lock")))
    return "corepack enable && (yarn install --frozen-lockfile || yarn install)";
  if (exists(dir, "package-lock.json") || exists(dir, "npm-shrinkwrap.json"))
    return "(npm ci || npm install --legacy-peer-deps)";
  return "npm install --legacy-peer-deps";
}

/** The `web:` process of a Procfile (Heroku/Elastic Beanstalk convention). */
export function procfileWebCommand(dir: string): string | undefined {
  const procfile = readFileSafe(path.join(dir, "Procfile"));
  const match = procfile?.match(/^web:\s*(.+)$/m);
  return match?.[1]?.trim() || undefined;
}

const NODE_ENTRY_CANDIDATES = [
  "server.js",
  "index.js",
  "app.js",
  "main.js",
  "src/server.js",
  "src/index.js",
  "src/app.js",
  "src/main.js",
];

/**
 * A command that starts a Node backend in production *without npm* (the
 * Lambda runtime has only `node`): the start script when it is a plain
 * `node ...` (nodemon swapped for node), else the Procfile, package.json
 * "main", or a conventional entry file. Undefined when none applies.
 */
export function nodeRunCommand(dir: string, pkg: PackageJson): string | undefined {
  const fromScript = (script: string | undefined) => {
    if (!script) return undefined;
    const cmd = script.replace(/\bnodemon\b/g, "node").trim();
    // Leading VAR=value assignments are fine in a shell; the program must be node.
    return /^(\w+=\S+\s+)*node\s+\S+/.test(cmd) ? cmd : undefined;
  };
  const procfile = procfileWebCommand(dir);
  const candidates = [
    fromScript(pkg.scripts?.start),
    fromScript(procfile),
    fromScript(pkg.scripts?.prod ?? pkg.scripts?.production ?? pkg.scripts?.serve),
  ];
  const found = candidates.find(Boolean);
  if (found) return found;
  const main = (pkg as { main?: string }).main;
  if (main && exists(dir, main)) return `node ${main}`;
  const entry = NODE_ENTRY_CANDIDATES.find((f) => exists(dir, f));
  return entry ? `node ${entry}` : undefined;
}

/** "app/main.py" -> "app.main". */
function moduleOf(relPath: string): string {
  return relPath.split(/[\\/]/).join(".").replace(/\.py$/, "");
}

function findPython(
  dir: string,
  pattern: RegExp,
): { module: string; match: RegExpMatchArray } | null {
  const files = walk(dir)
    .filter(
      (f) =>
        f.relPath.endsWith(".py") &&
        !/(^|[\\/])(tests?|venv|\.venv|migrations)[\\/]/.test(f.relPath),
    )
    // Shallow files first: main.py beats some/deep/helper.py.
    .sort((a, b) => a.relPath.split(/[\\/]/).length - b.relPath.split(/[\\/]/).length);
  for (const f of files) {
    const content = readFileSafe(f.absPath);
    const match = content?.match(pattern);
    if (match) return { module: moduleOf(f.relPath), match };
  }
  return null;
}

/**
 * The production command for a Python web app, listening on $PORT:
 * FastAPI -> uvicorn, Flask and Django -> gunicorn. The Procfile wins when
 * there is one. Also returns the server package the command needs, so the
 * image can install it when requirements.txt doesn't list it.
 */
export function pythonRunCommand(
  dir: string,
  framework: string | undefined,
): { command: string; needs?: string } | undefined {
  const procfile = procfileWebCommand(dir);
  if (procfile) {
    const needs = /^gunicorn\b/.test(procfile)
      ? "gunicorn"
      : /^uvicorn\b/.test(procfile)
        ? "uvicorn"
        : undefined;
    return { command: procfile, needs };
  }
  if (framework === "fastapi") {
    const found = findPython(dir, /^(\w+)\s*=\s*FastAPI\(/m);
    if (found)
      return {
        command: `uvicorn ${found.module}:${found.match[1]} --host 0.0.0.0 --port $PORT`,
        needs: "uvicorn",
      };
  }
  if (framework === "flask") {
    const app = findPython(dir, /^(\w+)\s*=\s*Flask\(/m);
    if (app)
      return {
        command: `gunicorn --bind 0.0.0.0:$PORT ${app.module}:${app.match[1]}`,
        needs: "gunicorn",
      };
    const factory = findPython(dir, /^def (create_app)\(/m);
    if (factory)
      return {
        command: `gunicorn --bind 0.0.0.0:$PORT '${factory.module}:create_app()'`,
        needs: "gunicorn",
      };
  }
  if (framework === "django") {
    const wsgi = walk(dir).find((f) => /(^|[\\/])wsgi\.py$/.test(f.relPath));
    if (wsgi)
      return {
        command: `gunicorn --bind 0.0.0.0:$PORT ${moduleOf(wsgi.relPath)}:application`,
        needs: "gunicorn",
      };
  }
  return undefined;
}

export function pythonInstallCommand(dir: string): string | undefined {
  if (exists(dir, "requirements.txt")) return "pip install --no-cache-dir -r requirements.txt";
  if (exists(dir, "pyproject.toml")) return "pip install --no-cache-dir .";
  return undefined;
}

/** True when the directory has a file (not a folder) of that name. */
export function isFile(dir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}
