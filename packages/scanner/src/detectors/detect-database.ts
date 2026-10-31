import path from "node:path";
import { readFileSafe } from "../fs-utils.js";
import { hasDep, readPackageJson } from "../package-json.js";

export type DatabaseKind =
  "postgres" | "mysql" | "mongo" | "redis" | "sqlite" | "dynamodb" | "none";

const NODE_DEP_MAP: Array<[DatabaseKind, string[]]> = [
  ["postgres", ["pg", "postgres", "@prisma/client"]],
  ["mysql", ["mysql", "mysql2"]],
  ["mongo", ["mongodb", "mongoose"]],
  ["redis", ["redis", "ioredis"]],
  ["sqlite", ["sqlite3", "better-sqlite3"]],
  ["dynamodb", ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"]],
];

const PYTHON_PACKAGE_MAP: Array<[DatabaseKind, string[]]> = [
  ["postgres", ["psycopg", "asyncpg", "pg8000"]],
  // "mysql-connector" also covers mysql-connector-python (Oracle's driver).
  ["mysql", ["pymysql", "mysqlclient", "mysql-connector", "aiomysql"]],
  ["mongo", ["pymongo"]],
  ["redis", ["redis"]],
  ["sqlite", ["sqlite3"]],
  ["dynamodb", ["boto3"]],
];

/**
 * First match wins, in priority order above -- a repo using both Postgres
 * and Redis (common: primary DB + cache) is reported by its primary store.
 * Gemini (Milestone 5) gets the full RepoProfile and can note the cache
 * separately; this field answers "what's the main datastore for pattern
 * selection," not "every data technology present."
 */
const PRISMA_PROVIDERS: Record<string, DatabaseKind> = {
  postgresql: "postgres",
  postgres: "postgres",
  cockroachdb: "postgres",
  mysql: "mysql",
  mongodb: "mongo",
  sqlite: "sqlite",
};

/** Prisma's schema names the real database; @prisma/client alone says nothing. */
function prismaProvider(root: string): DatabaseKind | undefined {
  for (const file of ["prisma/schema.prisma", "schema.prisma"]) {
    const schema = readFileSafe(path.join(root, file));
    const provider = schema?.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/)?.[1];
    if (provider) return PRISMA_PROVIDERS[provider];
  }
  return undefined;
}

export function detectDatabase(root: string): DatabaseKind {
  const pkg = readPackageJson(root);
  if (pkg) {
    const prisma = hasDep(pkg, "@prisma/client", "prisma") ? prismaProvider(root) : undefined;
    if (prisma) return prisma;
    for (const [kind, deps] of NODE_DEP_MAP) {
      if (hasDep(pkg, ...deps)) return kind;
    }
    return "none";
  }

  const requirements = (readFileSafe(path.join(root, "requirements.txt")) ?? "").toLowerCase();
  const pyproject = (readFileSafe(path.join(root, "pyproject.toml")) ?? "").toLowerCase();
  const combined = `${requirements}\n${pyproject}`;
  for (const [kind, names] of PYTHON_PACKAGE_MAP) {
    if (names.some((n) => combined.includes(n))) return kind;
  }

  // Other languages, by their manifest's driver dependencies.
  const manifests = MANIFEST_FILES.map((f) => readFileSafe(path.join(root, f)) ?? "")
    .join("\n")
    .toLowerCase();
  for (const [kind, pattern] of MANIFEST_DRIVERS) {
    if (pattern.test(manifests)) return kind;
  }
  // Laravel picks its database in .env.example (DB_CONNECTION=pgsql).
  const connection = readFileSafe(path.join(root, ".env.example"))?.match(
    /^DB_CONNECTION=(\w+)/m,
  )?.[1];
  if (connection && /^(mysql|mariadb)$/.test(connection)) return "mysql";
  if (connection === "pgsql") return "postgres";
  return "none";
}

/** Node packages that need a Redis server: clients, queues, session stores, adapters. */
const NODE_REDIS = [
  "redis",
  "ioredis",
  "bull",
  "bullmq",
  "connect-redis",
  "@socket.io/redis-adapter",
  "rate-limit-redis",
];

/**
 * Whether the app also talks to Redis (a cache, sessions, job queues), next
 * to whatever detectDatabase reports as its main store.
 */
export function usesRedis(root: string): boolean {
  const pkg = readPackageJson(root);
  if (pkg) return hasDep(pkg, ...NODE_REDIS);
  const python = `${readFileSafe(path.join(root, "requirements.txt")) ?? ""}\n${readFileSafe(path.join(root, "pyproject.toml")) ?? ""}`;
  if (/^\s*["']?(?:redis|rq|django-redis|celery\[redis\])\b/im.test(python)) return true;
  const manifests = MANIFEST_FILES.map((f) => readFileSafe(path.join(root, f)) ?? "").join("\n");
  return MANIFEST_DRIVERS.find(([kind]) => kind === "redis")![1].test(manifests.toLowerCase());
}

const MANIFEST_FILES = [
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Cargo.toml",
];

/** Driver names in go.mod, pom.xml/build.gradle, Gemfile, composer.json, Cargo.toml. */
const MANIFEST_DRIVERS: Array<[DatabaseKind, RegExp]> = [
  [
    "postgres",
    /jackc\/pgx|lib\/pq|org\.postgresql|gem ["']pg["']|\bsqlx\b.*postgres|^\s*(tokio-)?postgres\s*=/m,
  ],
  ["mysql", /go-sql-driver\/mysql|mysql-connector|gem ["']mysql2["']|mariadb-java-client/],
  [
    "mongo",
    /mongo-driver|mongodb-driver|spring-boot-starter-data-mongodb|gem ["']mongoid["']|^\s*mongodb\s*=/m,
  ],
  ["redis", /go-redis|spring-boot-starter-data-redis|jedis|gem ["']redis["']|^\s*redis\s*=/m],
  ["sqlite", /mattn\/go-sqlite3|sqlite-jdbc|gem ["']sqlite3["']|rusqlite/],
];
