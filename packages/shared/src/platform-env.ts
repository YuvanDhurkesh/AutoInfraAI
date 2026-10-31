import type { RepoProfile } from "./repo-profile.js";
import { backendRouting } from "./routing.js";

/**
 * Env vars the user shouldn't have to fill in: AutoInfra knows their values
 * (or wires them itself), so it never asks for them.
 */
export type ProvidedHow =
  /** Set to the deployment's public URL once CloudFront exists (CORS allow-lists, auth callbacks). */
  | "live_url"
  /** Set to "production". */
  | "production"
  /** The frontend build gets the relative API path through this. */
  | "api_path"
  /** Points at the database container on the instance (F2). */
  | "database"
  /** Points at the Redis container next to the database (F2). */
  | "cache"
  /** The public host name alone (Django's ALLOWED_HOSTS). */
  | "live_host"
  /** The backend's own public URL (BACKEND_URL): the live URL, plus the API prefix when it's stripped. */
  | "backend_url"
  /** The repo's example value (http://localhost:5000/auth/google/callback) moved to the live URL. */
  | "local_url"
  /** The app's listen port under another name (FLASK_SERVER_PORT): the port AutoInfra routes to. */
  | "listen_port"
  /** The app's listen address (ADDRESS=127.0.0.1:8000): every interface, so Caddy and Lambda reach it. */
  | "listen_address";

// Framework-prefixed forms (NEXT_PUBLIC_SITE_URL) too, but never *_BASE_URL:
// in a frontend that is usually the API's address.
const URL_VAR =
  /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|VUE_APP_|PUBLIC_)?(CLIENT|FRONTEND|APP|SITE|WEB|WEBSITE|UI)_(URL|ORIGIN)$|^(PUBLIC|BASE)_(URL|ORIGIN)$|^(CORS_ORIGINS?|CORS_ALLOWED_ORIGINS|ALLOWED_ORIGINS?|TRUSTED_ORIGINS|CSRF_TRUSTED_ORIGINS|ORIGIN|NEXTAUTH_URL|AUTH_URL|BETTER_AUTH_URL)$/;
const HOST_VAR = /^(DJANGO_)?ALLOWED_HOSTS$/;
const BACKEND_URL_VAR = /^(BACKEND|SERVER)_(URL|ORIGIN)$/;
const FRONTEND_API_VAR =
  /^(VITE|REACT_APP|NEXT_PUBLIC|VUE_APP|NG_APP)_(API|BACKEND|SERVER)_?(BASE_)?(URL|URI|HOST)$/;
/** The server's own port, named for the app or framework (PORT itself is reserved). */
const LISTEN_PORT_VAR =
  /^(SERVER|APP|HTTP|WEB|API|BACKEND|LISTEN|FLASK_SERVER|FLASK_RUN|UVICORN|GUNICORN)_PORT$/;
/** Always the server's own listen address. */
const LISTEN_ADDRESS_VAR = /^(BIND|LISTEN)(_(ADDRESS|ADDR|HOST|IP))?$|^(FLASK_RUN|UVICORN)_HOST$/;
/**
 * The listen address only when the repo's default is one (HOST=localhost,
 * ADDRESS=127.0.0.1:8000); otherwise HOST may well be a public host name.
 */
const MAYBE_LISTEN_ADDRESS_VAR = /^((SERVER|APP|HTTP|WEB)_)?(HOST|ADDRESS|ADDR|IP)$/;
/**
 * The app's own settings for its database, by kind. Generic names (DB_HOST,
 * DATABASE_URL) belong to whatever database it uses; vendor names only to
 * that vendor -- REDIS_URL in a Postgres app is a second service, not the
 * Postgres container.
 */
const GENERIC_DB_VAR =
  /^(DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|(DB|DATABASE)_?(HOST|HOSTNAME|PORT|USER|USERNAME|PASSWORD|PASS|NAME|DBNAME|DATABASE|DB|DIALECT)|(DB|DATABASE)_?SSL(_?MODE)?)$/;
const VENDOR_DB_VAR: Record<string, RegExp> = {
  postgres:
    /^(POSTGRES|PG|POSTGRESQL)_?(URL|URI|HOST|HOSTNAME|PORT|USER|USERNAME|PASSWORD|PASS|NAME|DBNAME|DATABASE|DB|SSL|SSL_?MODE)$|^PGSSLMODE$/,
  mysql:
    /^MYSQL_?(URL|URI|HOST|HOSTNAME|PORT|USER|USERNAME|PASSWORD|PASS|NAME|DBNAME|DATABASE|DB|SSL)$/,
  mongo:
    /^MONGO(DB)?_?(URL|URI|HOST|HOSTNAME|PORT|USER|USERNAME|PASSWORD|PASS|NAME|DBNAME|DATABASE|DB)$/,
  redis: /^REDIS_?(URL|URI|HOST|HOSTNAME|PORT|PASSWORD)$/,
};
/**
 * Per-environment copies of the same settings (Sequelize's config.js reads
 * PROD_DB_HOSTNAME in production, DEV_DB_NAME in development). They all point
 * at the one database the deployment has.
 */
const ENV_PREFIX = /^(?:PROD|PRODUCTION|STAGING|DEV|DEVELOPMENT|LOCAL|TEST)_/;

export function isDatabaseSetting(name: string, database: string): boolean {
  const base = name.replace(ENV_PREFIX, "");
  return GENERIC_DB_VAR.test(base) || (VENDOR_DB_VAR[database]?.test(base) ?? false);
}

/** REDIS_URL, REDIS_HOST... of an app whose main database is something else. */
function isCacheSetting(name: string): boolean {
  return VENDOR_DB_VAR.redis!.test(name.replace(ENV_PREFIX, ""));
}

const SERVER_DATABASES = new Set(["postgres", "mysql", "redis", "mongo"]);

/**
 * Databases an app can use from outside AWS, with the port the F2 instance
 * must be allowed to reach (its security group only allows 80/443 out
 * otherwise). Lambda (F1) isn't in a VPC, so it reaches them directly.
 */
export const EXTERNAL_DATABASE_PORTS: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mongo: 27017,
  redis: 6379,
};

type EnvProfile = Pick<RepoProfile, "database"> & {
  envVars: Array<{
    name: string;
    isSecret: boolean;
    localhostDefault?: string;
    bindDefault?: string;
  }>;
  frontend?: Pick<NonNullable<RepoProfile["frontend"]>, "apiBaseUrlEnvVar">;
  databaseExternal?: boolean;
  cache?: RepoProfile["cache"];
};

/**
 * Whether the F2 instance runs a Redis next to the main database. Only with
 * a database on the instance: an app whose data lives outside AWS keeps its
 * Redis there too (its settings are the owner's to enter).
 */
export function cacheOnInstance(profile: EnvProfile, pattern: string | null | undefined): boolean {
  return (
    pattern === "F2" &&
    profile.cache === "redis" &&
    profile.database !== "redis" &&
    SERVER_DATABASES.has(profile.database) &&
    !profile.databaseExternal
  );
}

export function platformProvidedEnv(
  profile: EnvProfile,
  pattern: string | null | undefined,
): Map<string, ProvidedHow> {
  const provided = new Map<string, ProvidedHow>();
  // An external database's connection settings are the user's to enter.
  const dbOnInstance =
    pattern === "F2" && SERVER_DATABASES.has(profile.database) && !profile.databaseExternal;
  const cacheHere = cacheOnInstance(profile, pattern);
  for (const { name, localhostDefault, bindDefault } of profile.envVars) {
    if (name === "NODE_ENV") provided.set(name, "production");
    else if (name === profile.frontend?.apiBaseUrlEnvVar || FRONTEND_API_VAR.test(name))
      provided.set(name, "api_path");
    else if (URL_VAR.test(name)) provided.set(name, "live_url");
    else if (HOST_VAR.test(name)) provided.set(name, "live_host");
    else if (BACKEND_URL_VAR.test(name)) provided.set(name, "backend_url");
    else if (dbOnInstance && isDatabaseSetting(name, profile.database))
      provided.set(name, "database");
    else if (cacheHere && isCacheSetting(name)) provided.set(name, "cache");
    else if (LISTEN_PORT_VAR.test(name)) provided.set(name, "listen_port");
    else if (LISTEN_ADDRESS_VAR.test(name) || (bindDefault && MAYBE_LISTEN_ADDRESS_VAR.test(name)))
      provided.set(name, "listen_address");
    else if (localhostDefault) provided.set(name, "local_url");
  }
  return provided;
}

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The value AutoInfra writes for a provided env var once the live URL is
 * known -- null for the ones wired elsewhere (the frontend's API path at
 * build time, database settings in docker-compose).
 */
export function providedValue(
  how: ProvidedHow,
  name: string,
  ctx: {
    profile: RepoProfile;
    pattern: string;
    siteUrl: string;
    apiPrefix: string;
    /** The port CloudFront's traffic reaches the backend on (Caddy, or Lambda's adapter). */
    appPort?: number;
  },
): string | null {
  const { profile, siteUrl, apiPrefix } = ctx;
  const routing = backendRouting(profile, apiPrefix);
  const appPort = profile.backend ? (ctx.appPort ?? profile.backend.port) : undefined;
  switch (how) {
    case "listen_port":
      return appPort ? String(appPort) : null;
    case "listen_address": {
      // Host and port together (ADDRESS=127.0.0.1:8000, Go's ":8080") or the host alone.
      const example = profile.envVars.find((v) => v.name === name)?.bindDefault;
      const withPort = example ? /:\d{2,5}$/.test(example) : !/(HOST|IP)$/.test(name);
      if (!profile.backend || (withPort && !appPort)) return null;
      return withPort ? `0.0.0.0:${appPort}` : "0.0.0.0";
    }
    case "live_url":
      return siteUrl;
    case "production":
      return "production";
    case "live_host": {
      // Lambda sees the Function URL's own host (CloudFront can't forward Host to it).
      const host = new URL(siteUrl).host;
      return ctx.pattern === "F1" ? `${host},.on.aws` : host;
    }
    case "backend_url":
      return siteUrl + (routing.stripPrefix ? apiPrefix : "");
    case "local_url": {
      const value = profile.envVars.find((v) => v.name === name)?.localhostDefault ?? "";
      const match = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/\S*)?$/);
      if (!match) return null;
      const path = match[2] ?? "";
      // The backend's own address (OAuth callbacks): the same path through the API prefix.
      const self = match[1] !== undefined && match[1] === String(profile.backend?.port);
      return siteUrl + (self && !under(path, apiPrefix) ? routing.localhostSuffix : "") + path;
    }
    default:
      return null;
  }
}

/** The env var names the app's container must get pointed at the database (F2). */
export function databaseEnvNames(profile: EnvProfile) {
  return [...platformProvidedEnv(profile, "F2")]
    .filter(([, how]) => how === "database")
    .map(([name]) => name);
}

/** The env var names the app's container must get pointed at the Redis container (F2). */
export function cacheEnvNames(profile: EnvProfile) {
  return [...platformProvidedEnv(profile, "F2")]
    .filter(([, how]) => how === "cache")
    .map(([name]) => name);
}
