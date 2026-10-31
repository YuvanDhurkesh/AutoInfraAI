import { readFileSafe, walk } from "../fs-utils.js";
import { hostedDomain } from "./detect-hosted-database.js";

/** A file that talks to a database (Node and Python drivers and ORMs). */
const DB_DRIVER =
  /\b(?:mysql2?|pg|postgres|sequelize|knex|mongoose|mongodb|ioredis|redis|psycopg2?|pymysql|mysql\.connector|MySQLdb|sqlalchemy|asyncpg|motor)\b/;
/** host: 'localhost', host="127.0.0.1", 'host': 'db.example.rds.amazonaws.com' (JS, Python kwargs and dicts). */
const HOST_LITERAL = /['"]?\b(?:host|hostname)['"]?\s*[:=]\s*(['"])([^'"\s]+)\1/i;
/** "mongodb://localhost:27017/app", 'mysql+pymysql://root:pw@db.neon.tech/db'. */
const URL_LITERAL =
  /(['"`])((?:mongodb(?:\+srv)?|postgres(?:ql)?(?:\+\w+)?|mysql(?:\+\w+)?|mariadb(?:\+\w+)?|rediss?):\/\/[^'"`\s]+)\1/;
/** The line takes the value from the environment; the literal is only its fallback. */
const READS_ENV = /process\.env|os\.environ|getenv|System\.getenv/;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;
/** Tests, seeds and helper scripts run on a developer's machine, not in the deployment. */
const NOT_THE_APP =
  /(^|\/)(__tests__|tests?|spec|e2e|seeds?|seeders|fixtures|scripts|examples?|docs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$/;

/** A host the app can't mean to share with AutoInfra's database: this machine, or a hosted database service. */
function fixedDatabaseHost(host: string): boolean {
  return /^(?:localhost|127\.0\.0\.1)$/i.test(host) || Boolean(hostedDomain(host));
}

/**
 * Where the backend's code connects to a database whose address is written
 * in (localhost, or a hosted service such as RDS or Atlas). On AutoInfra the
 * database is another container (F2) or a service reached through the env
 * vars AutoInfra fills in -- such a connection either fails once deployed or
 * quietly uses some other database. Credentials in a URL are masked.
 */
export function detectHardcodedDatabaseHosts(root: string): string[] {
  const found: string[] = [];
  for (const file of walk(root)) {
    const rel = file.relPath.split("\\").join("/");
    if (!CODE_FILE.test(rel) || NOT_THE_APP.test(rel)) continue;
    const content = readFileSafe(file.absPath);
    if (!content || !DB_DRIVER.test(content)) continue;
    // Per-environment config (knexfile, Sequelize's config.js): the literal is
    // for development; the production entry reads env vars.
    if (/\bproduction\b/.test(content) && READS_ENV.test(content)) continue;
    content.split(/\r?\n/).forEach((line, i) => {
      if (READS_ENV.test(line)) return;
      const host = line.match(HOST_LITERAL);
      if (host && fixedDatabaseHost(host[2]!)) {
        found.push(`${rel}:${i + 1}: ${host[0]}`);
        return;
      }
      const url = line.match(URL_LITERAL);
      if (url) {
        const hostPart = url[2]!.match(/^[^:]+:\/\/(?:[^@/]*@)?([^:/?,]+)/)?.[1] ?? "";
        if (fixedDatabaseHost(hostPart))
          found.push(`${rel}:${i + 1}: ${url[0].replace(/\/\/[^@/\s'"`]*@/, "//***@")}`);
      }
    });
    if (found.length >= 5) break;
  }
  return found.sort().slice(0, 5);
}
