import { describe, expect, it } from "vitest";
import type { RepoProfile } from "./repo-profile.js";
import {
  cacheEnvNames,
  cacheOnInstance,
  databaseEnvNames,
  platformProvidedEnv,
  providedValue,
} from "./platform-env.js";

describe("a Redis cache next to the main database", () => {
  const app = {
    envVars: ["DATABASE_URL", "REDIS_URL", "PROD_REDIS_HOST", "SESSION_SECRET"].map((name) => ({
      name,
      isSecret: false,
    })),
    database: "postgres" as const,
    cache: "redis" as const,
  };

  it("on F2 its settings point at the Redis container, the database's at the database", () => {
    expect(Object.fromEntries(platformProvidedEnv(app, "F2"))).toEqual({
      DATABASE_URL: "database",
      REDIS_URL: "cache",
      PROD_REDIS_HOST: "cache",
    });
    expect(cacheEnvNames(app)).toEqual(["REDIS_URL", "PROD_REDIS_HOST"]);
    expect(cacheOnInstance(app, "F2")).toBe(true);
  });

  it("not on Lambda, and not when the data lives outside AWS: then Redis is the owner's to enter", () => {
    expect(cacheOnInstance(app, "F1")).toBe(false);
    expect(platformProvidedEnv(app, "F1").has("REDIS_URL")).toBe(false);
    const outside = { ...app, databaseExternal: true };
    expect(cacheOnInstance(outside, "F2")).toBe(false);
    expect(platformProvidedEnv(outside, "F2").has("REDIS_URL")).toBe(false);
  });

  it("a Redis-only app keeps its one Redis as the database", () => {
    const redisOnly = { ...app, database: "redis" as const };
    expect(cacheOnInstance(redisOnly, "F2")).toBe(false);
    expect(platformProvidedEnv(redisOnly, "F2").get("REDIS_URL")).toBe("database");
  });
});

// The env vars of a real React + Express + MySQL repo.
const todoApp = {
  envVars: [
    "VITE_API_URL",
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "DB_PORT",
    "PORT",
    "NODE_ENV",
    "CLIENT_URL",
    "STRIPE_KEY",
  ].map((name) => ({ name, isSecret: name.includes("PASSWORD") })),
  database: "mysql" as const,
  frontend: {
    framework: "react-vite",
    rootDir: "frontend",
    apiBaseUrlEnvVar: "VITE_API_URL",
    isSSR: false,
    apiBaseUrlAppendsApi: false,
    hardcodedLocalhostUrls: [],
    localhostApiOrigins: [],
  },
};

describe("platformProvidedEnv", () => {
  it("covers URL, NODE_ENV, the frontend API var and database settings on F2 -- not app secrets", () => {
    expect(Object.fromEntries(platformProvidedEnv(todoApp, "F2"))).toEqual({
      VITE_API_URL: "api_path",
      DB_HOST: "database",
      DB_USER: "database",
      DB_PASSWORD: "database",
      DB_NAME: "database",
      DB_PORT: "database",
      NODE_ENV: "production",
      CLIENT_URL: "live_url",
    });
  });

  it("doesn't claim database settings when no database runs on the instance", () => {
    const provided = platformProvidedEnv(todoApp, "F1");
    expect(provided.has("DB_PASSWORD")).toBe(false);
    expect(provided.get("CLIENT_URL")).toBe("live_url");
  });

  it("leaves an external database's settings to the user", () => {
    const external = { ...todoApp, databaseExternal: true };
    const provided = platformProvidedEnv(external, "F2");
    expect(provided.has("DB_HOST")).toBe(false);
    expect(provided.has("DB_PASSWORD")).toBe(false);
    expect(provided.get("CLIENT_URL")).toBe("live_url");
    expect(databaseEnvNames(external)).toEqual([]);
  });

  it("auth URLs, allowed hosts, the backend's own URL and local example URLs get live values", () => {
    const profile = {
      envVars: [
        { name: "NEXTAUTH_URL", isSecret: false },
        { name: "CSRF_TRUSTED_ORIGINS", isSecret: false },
        { name: "NEXT_PUBLIC_SITE_URL", isSecret: false },
        { name: "VITE_BASE_URL", isSecret: false }, // the API's address, not the site's
        { name: "ALLOWED_HOSTS", isSecret: false },
        { name: "BACKEND_URL", isSecret: false },
        {
          name: "GOOGLE_CALLBACK_URL",
          isSecret: false,
          localhostDefault: "http://localhost:5000/auth/google/callback",
        },
        {
          name: "FRONTEND_REDIRECT",
          isSecret: false,
          localhostDefault: "http://localhost:5173/home",
        },
      ],
      database: "none",
      frontend: { framework: "react-vite", rootDir: "web", apiBaseUrlEnvVar: "VITE_BASE_URL" },
      // Routes without /api: the prefix is stripped, so the backend's own URL includes it.
      backend: { language: "node", rootDir: "api", port: 5000, routePrefixes: ["/auth"] },
    } as unknown as RepoProfile;
    const provided = platformProvidedEnv(profile, "F2");
    expect(Object.fromEntries(provided)).toEqual({
      NEXTAUTH_URL: "live_url",
      CSRF_TRUSTED_ORIGINS: "live_url",
      NEXT_PUBLIC_SITE_URL: "live_url",
      VITE_BASE_URL: "api_path",
      ALLOWED_HOSTS: "live_host",
      BACKEND_URL: "backend_url",
      GOOGLE_CALLBACK_URL: "local_url",
      FRONTEND_REDIRECT: "local_url",
    });
    const value = (name: string, pattern = "F2") =>
      providedValue(provided.get(name)!, name, {
        profile,
        pattern,
        siteUrl: "https://d1.cloudfront.net",
        apiPrefix: "/api",
      });
    expect(value("NEXTAUTH_URL")).toBe("https://d1.cloudfront.net");
    expect(value("ALLOWED_HOSTS")).toBe("d1.cloudfront.net");
    expect(value("ALLOWED_HOSTS", "F1")).toBe("d1.cloudfront.net,.on.aws");
    expect(value("BACKEND_URL")).toBe("https://d1.cloudfront.net/api");
    expect(value("GOOGLE_CALLBACK_URL")).toBe("https://d1.cloudfront.net/api/auth/google/callback");
    expect(value("FRONTEND_REDIRECT")).toBe("https://d1.cloudfront.net/home");
    expect(value("VITE_BASE_URL")).toBeNull(); // set at build time
  });

  it("lists the database vars the compose file must wire", () => {
    expect(databaseEnvNames(todoApp)).toEqual([
      "DB_HOST",
      "DB_USER",
      "DB_PASSWORD",
      "DB_NAME",
      "DB_PORT",
    ]);
    expect(
      databaseEnvNames({
        ...todoApp,
        envVars: [{ name: "DATABASE_URL", isSecret: true }],
        database: "postgres",
      }),
    ).toEqual(["DATABASE_URL"]);
  });

  it("per-environment copies (Sequelize's config.js) all point at the one database", () => {
    // The env template of a real React + Express + Sequelize + Postgres repo.
    const conduit = {
      envVars: [
        "PORT",
        "JWT_KEY",
        ...["DEV", "TEST", "PROD"].flatMap((env) =>
          ["USERNAME", "PASSWORD", "NAME", "HOSTNAME", "DIALECT", "LOGGING"].map(
            (part) => `${env}_DB_${part}`,
          ),
        ),
      ].map((name) => ({ name, isSecret: name.includes("PASSWORD") })),
      database: "postgres" as const,
    };
    const names = databaseEnvNames(conduit);
    expect(names).toEqual(
      expect.arrayContaining([
        "PROD_DB_USERNAME",
        "PROD_DB_PASSWORD",
        "PROD_DB_NAME",
        "PROD_DB_HOSTNAME",
        "PROD_DB_DIALECT",
        "DEV_DB_HOSTNAME",
        "TEST_DB_NAME",
      ]),
    );
    expect(names).toHaveLength(15);
    // Not connection settings: the owner's to decide (or leave empty).
    expect(names).not.toContain("PROD_DB_LOGGING");
    expect(names).not.toContain("JWT_KEY");
    // A prefix alone doesn't make something a database setting.
    expect(
      databaseEnvNames({ ...conduit, envVars: [{ name: "PROD_URL", isSecret: false }] }),
    ).toEqual([]);
  });
});

describe("the server's own port and listen address under the app's names", () => {
  const app = (envVars: RepoProfile["envVars"], database: RepoProfile["database"] = "postgres") =>
    ({
      envVars,
      database,
      backend: { language: "rust", rootDir: "backend", port: 8000 },
    }) as unknown as RepoProfile;
  const valueOf = (profile: RepoProfile, name: string) => {
    const how = platformProvidedEnv(profile, "F2").get(name);
    return how
      ? providedValue(how, name, {
          profile,
          pattern: "F2",
          siteUrl: "https://d1.cloudfront.net",
          apiPrefix: "/api",
          appPort: 8000,
        })
      : undefined;
  };

  it("awesome-compose's Rust backend: ADDRESS (default 127.0.0.1:8000) and PG_DBNAME are AutoInfra's", () => {
    const rust = app([
      { name: "ADDRESS", isSecret: false, bindDefault: "127.0.0.1:8000" },
      { name: "PG_DBNAME", isSecret: false },
      { name: "PG_HOST", isSecret: false },
    ]);
    expect(Object.fromEntries(platformProvidedEnv(rust, "F2"))).toEqual({
      ADDRESS: "listen_address",
      PG_DBNAME: "database",
      PG_HOST: "database",
    });
    // 127.0.0.1 inside the container would be out of Caddy's reach.
    expect(valueOf(rust, "ADDRESS")).toBe("0.0.0.0:8000");
  });

  it("Flask's FLASK_SERVER_PORT, SERVER_PORT: the port CloudFront's traffic arrives on", () => {
    const flask = app([
      { name: "FLASK_SERVER_PORT", isSecret: false },
      { name: "SERVER_PORT", isSecret: false },
    ]);
    expect(valueOf(flask, "FLASK_SERVER_PORT")).toBe("8000");
    expect(valueOf(flask, "SERVER_PORT")).toBe("8000");
  });

  it("HOST counts only when the repo's default is a listen address; BIND/LISTEN names always", () => {
    const hosts = app([
      { name: "HOST", isSecret: false, bindDefault: "localhost" },
      { name: "SERVER_HOST", isSecret: false }, // could be a public host name: the owner's
      { name: "BIND_ADDRESS", isSecret: false },
      { name: "LISTEN_HOST", isSecret: false },
    ]);
    expect(valueOf(hosts, "HOST")).toBe("0.0.0.0");
    expect(valueOf(hosts, "SERVER_HOST")).toBeUndefined();
    expect(valueOf(hosts, "BIND_ADDRESS")).toBe("0.0.0.0:8000");
    expect(valueOf(hosts, "LISTEN_HOST")).toBe("0.0.0.0");
  });

  it("a database's or another service's localhost default is never taken for the listen address", () => {
    const outside = {
      ...app([
        { name: "DB_HOST", isSecret: false, bindDefault: "localhost" },
        { name: "SMTP_HOST", isSecret: false, bindDefault: "localhost" },
      ]),
      databaseExternal: true,
    } as RepoProfile;
    expect(platformProvidedEnv(outside, "F2").size).toBe(0);
  });

  it("DATABASE_DB and *_DBNAME name the database AutoInfra creates", () => {
    expect(databaseEnvNames(app([{ name: "DATABASE_DB", isSecret: false }], "mysql"))).toEqual([
      "DATABASE_DB",
    ]);
    expect(databaseEnvNames(app([{ name: "MONGO_DBNAME", isSecret: false }], "mongo"))).toEqual([
      "MONGO_DBNAME",
    ]);
  });

  it("a static site has no server: nothing to listen on", () => {
    const site = { envVars: [{ name: "SERVER_PORT", isSecret: false }], database: "none" as const };
    const how = platformProvidedEnv(site, "F3").get("SERVER_PORT")!;
    expect(
      providedValue(how, "SERVER_PORT", {
        profile: site as unknown as RepoProfile,
        pattern: "F3",
        siteUrl: "https://d1.cloudfront.net",
        apiPrefix: "/api",
      }),
    ).toBeNull();
  });
});
