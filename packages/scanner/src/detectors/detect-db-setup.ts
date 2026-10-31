import fs from "node:fs";
import path from "node:path";
import { exists, readFileSafe } from "../fs-utils.js";
import { hasDep, readPackageJson } from "../package-json.js";

/**
 * One step of the app's own database setup, run on the server before the
 * app starts (Heroku's "release phase"):
 *  - sql:     a migration file, piped into the database once (tracked)
 *  - command: run in the app's container; `once` ones are tracked by name,
 *             the rest (migration tools) run on every deploy -- they are
 *             idempotent by design.
 */
export interface DatabaseSetupStep {
  kind: "sql" | "command";
  /** sql: repo-root-relative file. command: a stable name for tracking. */
  path: string;
  /** command: run in the backend folder inside the app container. */
  command?: string;
  once: boolean;
}

const MIGRATION_DIRS = [
  "migrations",
  "migration",
  "db/migrations",
  "database/migrations",
  "sql/migrations",
];
const SCRIPT_DIRS = [".", "scripts", "db", "database", "src/scripts"];
const MIGRATE_SCRIPT = /^migrat(e|ion)[\w.-]*\.(c|m)?js$/i;
const SEED_SCRIPT =
  /^(seed|init[-_]?db|populate|fixtures?)[\w.-]*\.(c|m)?(js|ts|py)$|^seed(s|er)?\.(sql)$/i;
const PACKAGE_SCRIPTS = [
  "migrate",
  "db:migrate",
  "migrate:deploy",
  "migration:run",
  "migrations:run",
  "db:push",
];

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

const rel = (repoRoot: string, file: string) =>
  path.relative(repoRoot, file).split(path.sep).join("/");

/**
 * The app's database setup, in the order it must run. A migration tool or a
 * package.json "migrate" script wins; without one, plain SQL migration
 * folders and migrate*.js scripts are run once each.
 */
export function detectDatabaseSetup(
  backendRoot: string,
  repoRoot: string,
  framework: string | undefined,
): { steps: DatabaseSetupStep[]; seeds: string[] } {
  const steps: DatabaseSetupStep[] = [];
  const tool = (name: string, command: string) =>
    steps.push({ kind: "command", path: name, command, once: false });
  const pkg = readPackageJson(backendRoot);
  const run = (script: string) =>
    exists(backendRoot, "yarn.lock")
      ? `yarn ${script}`
      : exists(backendRoot, "pnpm-lock.yaml")
        ? `pnpm run ${script}`
        : `npm run ${script}`;

  // 1. The app says how: a package.json migrate script.
  const script = pkg && PACKAGE_SCRIPTS.find((s) => pkg.scripts?.[s]);
  if (script) {
    tool(`npm:${script}`, run(script));
  } else if (
    pkg &&
    (exists(backendRoot, "prisma/schema.prisma") || exists(backendRoot, "schema.prisma"))
  ) {
    tool(
      "prisma",
      exists(backendRoot, "prisma/migrations")
        ? "npx prisma migrate deploy"
        : "npx prisma db push --skip-generate",
    );
  } else if (pkg && hasDep(pkg, "sequelize-cli")) {
    tool("sequelize", "npx sequelize-cli db:migrate");
  } else if (
    pkg &&
    hasDep(pkg, "knex") &&
    ["knexfile.js", "knexfile.cjs", "knexfile.mjs"].some((f) => exists(backendRoot, f))
  ) {
    tool("knex", "npx knex migrate:latest");
  } else if (
    pkg &&
    hasDep(pkg, "drizzle-kit") &&
    listFiles(backendRoot).some((f) => /^drizzle\.config\./.test(f))
  ) {
    tool(
      "drizzle",
      exists(backendRoot, "drizzle") ? "npx drizzle-kit migrate" : "npx drizzle-kit push",
    );
  } else if (
    pkg &&
    hasDep(pkg, "migrate-mongo") &&
    listFiles(backendRoot).some((f) => /^migrate-mongo-config\./.test(f))
  ) {
    tool("migrate-mongo", "npx migrate-mongo up");
  } else if (framework === "django" && exists(backendRoot, "manage.py")) {
    tool("django", "python manage.py migrate --noinput");
  } else if (exists(backendRoot, "alembic.ini")) {
    tool("alembic", "alembic upgrade head");
  } else if (framework === "flask" && exists(backendRoot, "migrations/alembic.ini")) {
    tool("flask-migrate", "flask db upgrade");
  } else {
    // 2. No tool: plain SQL migration files, then migrate*.js scripts.
    const seenDirs = new Set<string>();
    for (const base of [backendRoot, repoRoot]) {
      for (const dir of MIGRATION_DIRS) {
        const full = path.join(base, dir);
        if (seenDirs.has(full)) continue;
        seenDirs.add(full);
        for (const file of listFiles(full).filter((f) => f.toLowerCase().endsWith(".sql"))) {
          steps.push({ kind: "sql", path: rel(repoRoot, path.join(full, file)), once: true });
        }
      }
    }
    if (pkg) {
      for (const dir of SCRIPT_DIRS) {
        for (const file of listFiles(path.join(backendRoot, dir)).filter((f) =>
          MIGRATE_SCRIPT.test(f),
        )) {
          const inBackend = path.posix.join(dir === "." ? "" : dir, file);
          steps.push({
            kind: "command",
            path: inBackend,
            command: `node ${inBackend}`,
            once: true,
          });
        }
      }
    }
  }

  const seeds: string[] = [];
  for (const dir of SCRIPT_DIRS) {
    for (const file of listFiles(path.join(backendRoot, dir)).filter((f) => SEED_SCRIPT.test(f))) {
      seeds.push(rel(repoRoot, path.join(backendRoot, dir, file)));
    }
  }
  return { steps, seeds };
}

/** True when a setup command needs packages that are usually dev dependencies. */
export function setupNeedsDevDependencies(steps: DatabaseSetupStep[]): boolean {
  return steps.some((s) => /\bnpx\b|npm run|yarn |pnpm run/.test(s.command ?? ""));
}

export function readText(file: string): string | null {
  return readFileSafe(file);
}
