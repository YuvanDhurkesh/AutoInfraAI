import {
  cacheEnvNames,
  databaseEnvNames,
  platformProvidedEnv,
  type RepoProfile,
} from "@autoinfra/shared";

// Every image comes from AWS's mirror of Docker Official Images
// (public.ecr.aws/docker/library): Docker Hub rate-limits pulls by address.

/** Databases the F2 blueprint runs as a container on the instance. */
export const INSTANCE_DATABASES = ["postgres", "mysql", "mongo", "redis"] as const;
export type InstanceDatabase = (typeof INSTANCE_DATABASES)[number];

const PORTS: Record<InstanceDatabase, number> = {
  postgres: 5432,
  mysql: 3306,
  mongo: 27017,
  redis: 6379,
};

/** Fixed forever (checkComposeDatabaseStability): a new user is never created on an existing volume. */
const USERS: Record<InstanceDatabase, string> = {
  postgres: "app",
  mysql: "root",
  mongo: "app",
  redis: "",
};

const PASSWORD = "${AUTOINFRA_DB_PASSWORD}";

export function databaseUrl(kind: InstanceDatabase, dbName: string): string {
  switch (kind) {
    case "postgres":
      return `postgresql://app:${PASSWORD}@db:5432/${dbName}`;
    case "mysql":
      return `mysql://root:${PASSWORD}@db:3306/${dbName}`;
    case "mongo":
      return `mongodb://app:${PASSWORD}@db:27017/${dbName}?authSource=admin`;
    case "redis":
      return "redis://db:6379";
  }
}

/**
 * The value AutoInfra gives one of the app's own database settings
 * (DB_HOST, DATABASE_URL, MONGODB_URI, DB_SSL...) so it points at the
 * container. Names come from platformProvidedEnv's "database" class.
 */
export function databaseSetting(name: string, kind: InstanceDatabase, dbName: string): string {
  if (/SSL_?MODE$/.test(name)) return "disable";
  if (/SSL$/.test(name)) return "false";
  if (/(URL|URI)$/.test(name)) {
    return /REDIS/.test(name) && kind !== "redis" ? "redis://db:6379" : databaseUrl(kind, dbName);
  }
  if (/HOST(NAME)?$/.test(name)) return "db";
  if (/PORT$/.test(name)) return String(PORTS[kind]);
  if (/(USER|USERNAME)$/.test(name)) return USERS[kind];
  if (/(PASSWORD|PASS)$/.test(name)) return PASSWORD;
  if (/DIALECT$/.test(name)) return kind; // Sequelize/Knex: "postgres", "mysql"
  return dbName; // *_NAME, *_DATABASE, *_DB
}

/** REDIS_URL, REDIS_HOST... pointed at the "cache" container (no password: a private network). */
export function cacheSetting(name: string): string {
  if (/(URL|URI)$/.test(name)) return "redis://cache:6379";
  if (/HOST(NAME)?$/.test(name)) return "cache";
  if (/PORT$/.test(name)) return "6379";
  return ""; // *_PASSWORD
}

const LOGGING = [
  "    logging:",
  "      driver: json-file",
  "      options:",
  '        max-size: "10m"',
  '        max-file: "3"',
];

function service(name: string, lines: string[]): string[] {
  return [`  ${name}:`, ...lines.map((l) => `    ${l}`), ...LOGGING, ""];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export interface ComposeInput {
  profile: RepoProfile;
  hasBackend: boolean;
  ssrFrontend: boolean;
  appPort: number;
  /** Set when the database runs on the instance. */
  database?: InstanceDatabase;
  databaseName: string;
  hasInitScripts: boolean;
  /** A Redis container next to the database (cacheOnInstance). */
  cache?: boolean;
}

/**
 * docker-compose.yml for F2: Caddy in front, the app, a server-rendered
 * frontend ("web") when there is one, and the database container. Memory
 * limits keep the sum near the instance's 1 GB (+1 GB swap); logs rotate so
 * they never fill the disk.
 */
export function renderCompose(input: ComposeInput): string {
  const { database: db } = input;
  const out: string[] = ["services:"];
  const upstreams = [input.hasBackend && "app", input.ssrFrontend && "web"].filter(
    (s): s is string => Boolean(s),
  );

  out.push(
    ...service("caddy", [
      "image: public.ecr.aws/docker/library/caddy:2.9-alpine",
      "restart: unless-stopped",
      "ports:",
      '  - "80:80"',
      "environment:",
      "  ORIGIN_SECRET: ${ORIGIN_SECRET}",
      `  APP_PORT: "${input.appPort}"`,
      "volumes:",
      "  - ./Caddyfile:/etc/caddy/Caddyfile:ro",
      "mem_limit: 64m",
      "depends_on:",
      ...upstreams.map((s) => `  - ${s}`),
    ]),
  );

  // The app's database settings go to whichever container runs its server
  // code: the backend, or a Next.js server with its own API routes.
  const dbEnv = [
    ...(db
      ? databaseEnvNames(input.profile).map(
          (name) => `  ${name}: ${quote(databaseSetting(name, db, input.databaseName))}`,
        )
      : []),
    ...(input.cache
      ? cacheEnvNames(input.profile).map((name) => `  ${name}: ${quote(cacheSetting(name))}`)
      : []),
  ];
  const dbDependency = [
    ...(db || input.cache ? ["depends_on:"] : []),
    ...(db ? ["  db:", "    condition: service_healthy"] : []),
    ...(input.cache ? ["  cache:", "    condition: service_healthy"] : []),
  ];

  if (input.hasBackend) {
    const env: string[] = [`  PORT: "${input.appPort}"`, ...dbEnv];
    out.push(
      ...service("app", [
        "image: ${APP_IMAGE}",
        "restart: unless-stopped",
        "env_file: .env",
        "environment:",
        ...env,
        `mem_limit: ${input.ssrFrontend ? "256m" : "384m"}`,
        ...dbDependency,
      ]),
    );
  }

  if (input.ssrFrontend) {
    out.push(
      ...service("web", [
        "image: ${WEB_IMAGE}",
        "restart: unless-stopped",
        "env_file: .env",
        "environment:",
        '  PORT: "3000"',
        '  HOSTNAME: "0.0.0.0"',
        // SvelteKit's adapter-node checks form posts against the request's
        // origin; behind Caddy it must read it from the forwarded headers.
        ...(input.profile.frontend?.framework === "sveltekit"
          ? ['  PROTOCOL_HEADER: "x-forwarded-proto"', '  HOST_HEADER: "x-forwarded-host"']
          : []),
        ...(input.hasBackend ? [] : dbEnv),
        "mem_limit: 320m",
        ...(input.hasBackend ? ["depends_on:", "  - app"] : dbDependency),
      ]),
    );
  }

  if (db) {
    out.push(
      ...service("db", [
        ...databaseService(db, input.databaseName, input.hasInitScripts),
        ...networkAliases(HOST_ALIASES[db]),
      ]),
    );
  }
  if (input.cache) out.push(...service("cache", [...cacheService(), ...networkAliases(["redis"])]));

  const volumes = [db && "  dbdata:", input.cache && "  cachedata:"].filter((v): v is string =>
    Boolean(v),
  );
  out.push(...(volumes.length ? ["volumes:", ...volumes, ""] : []));
  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * Host names apps written for docker-compose hard-code for their database
 * (redis://redis:6379, host: "mongo"): they reach AutoInfra's container too.
 */
const HOST_ALIASES: Record<InstanceDatabase, string[]> = {
  postgres: ["postgres", "postgresql", "database"],
  mysql: ["mysql", "mariadb", "database"],
  mongo: ["mongo", "mongodb", "database"],
  redis: ["redis"],
};

function networkAliases(names: string[]): string[] {
  return ["networks:", "  default:", "    aliases:", ...names.map((name) => `      - ${name}`)];
}

/** Redis for sessions, caches and job queues; its own small volume so a restart keeps queued jobs. */
function cacheService(): string[] {
  return [
    "image: public.ecr.aws/docker/library/redis:7-alpine",
    "restart: unless-stopped",
    'command: ["redis-server", "--appendonly", "yes", "--maxmemory", "64mb", "--maxmemory-policy", "allkeys-lru"]',
    "volumes:",
    "  - cachedata:/data",
    "healthcheck:",
    '  test: ["CMD", "redis-cli", "ping"]',
    "  interval: 10s",
    "  timeout: 5s",
    "  retries: 10",
    "mem_limit: 96m",
  ];
}

function databaseService(kind: InstanceDatabase, dbName: string, initScripts: boolean): string[] {
  const initdb = initScripts ? ["  - ./initdb:/docker-entrypoint-initdb.d:ro"] : [];
  const healthcheck = (test: string) => [
    "healthcheck:",
    `  test: ${test}`,
    "  interval: 10s",
    "  timeout: 5s",
    "  retries: 10",
    "  start_period: 30s",
  ];
  switch (kind) {
    case "postgres":
      return [
        "image: public.ecr.aws/docker/library/postgres:16",
        "restart: unless-stopped",
        // SSL with a self-signed certificate made at start: apps written for a
        // hosted Postgres (ssl: { rejectUnauthorized: false }) connect as-is,
        // and plain connections still work.
        "entrypoint:",
        "  - sh",
        "  - -c",
        "  - >-",
        "    openssl req -new -x509 -days 3650 -nodes -subj /CN=db",
        "    -keyout /tmp/server.key -out /tmp/server.crt 2>/dev/null &&",
        "    chown postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key &&",
        "    exec docker-entrypoint.sh postgres -c ssl=on",
        "    -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
        "environment:",
        "  POSTGRES_USER: app",
        "  POSTGRES_PASSWORD: ${AUTOINFRA_DB_PASSWORD}",
        `  POSTGRES_DB: ${quote(dbName)}`,
        "volumes:",
        "  - dbdata:/var/lib/postgresql/data",
        ...initdb,
        // TCP, not the socket: the server only listens on TCP once the image's
        // init scripts (schema.sql) are done, so "healthy" means "ready".
        ...healthcheck(`["CMD-SHELL", "pg_isready -h 127.0.0.1 -U app -d ${dbName}"]`),
        "mem_limit: 256m",
      ];
    case "mysql":
      return [
        "image: public.ecr.aws/docker/library/mysql:8.4",
        "restart: unless-stopped",
        'command: ["--performance-schema=OFF", "--innodb-buffer-pool-size=64M", "--max-connections=50"]',
        "environment:",
        "  MYSQL_ROOT_PASSWORD: ${AUTOINFRA_DB_PASSWORD}",
        `  MYSQL_DATABASE: ${quote(dbName)}`,
        "volumes:",
        "  - dbdata:/var/lib/mysql",
        ...initdb,
        ...healthcheck(
          '["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-u", "root", "-p${AUTOINFRA_DB_PASSWORD}"]',
        ),
        "mem_limit: 320m",
      ];
    case "mongo":
      return [
        "image: public.ecr.aws/docker/library/mongo:7",
        "restart: unless-stopped",
        'command: ["--wiredTigerCacheSizeGB", "0.25"]',
        "environment:",
        "  MONGO_INITDB_ROOT_USERNAME: app",
        "  MONGO_INITDB_ROOT_PASSWORD: ${AUTOINFRA_DB_PASSWORD}",
        `  MONGO_INITDB_DATABASE: ${quote(dbName)}`,
        "volumes:",
        "  - dbdata:/data/db",
        ...initdb,
        ...healthcheck(`["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]`),
        "mem_limit: 320m",
      ];
    case "redis":
      return [
        "image: public.ecr.aws/docker/library/redis:7-alpine",
        "restart: unless-stopped",
        'command: ["redis-server", "--appendonly", "yes", "--maxmemory", "64mb", "--maxmemory-policy", "allkeys-lru"]',
        "volumes:",
        "  - dbdata:/data",
        ...healthcheck('["CMD", "redis-cli", "ping"]'),
        "mem_limit: 96m",
      ];
  }
}

/** The settings AutoInfra wires for the app (for the review screen). */
export function wiredDatabaseSettings(profile: RepoProfile): string[] {
  return [...platformProvidedEnv(profile, "F2")]
    .filter(([, how]) => how === "database")
    .map(([name]) => name);
}
