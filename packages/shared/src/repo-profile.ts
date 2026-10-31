import { z } from "zod";

/**
 * Output of the deterministic repo scanner (packages/scanner), built in Milestone 4.
 * Defined here now so downstream packages (llm, api) can type against it early.
 */
export const RepoProfile = z.object({
  repoUrl: z.string().url(),
  commitSha: z.string(),
  branch: z.string(),
  subdir: z.string().optional(),
  frontend: z
    .object({
      framework: z.string(), // e.g. "react-vite", "next", "vue", "angular", "static"
      /** Folder holding the frontend's package.json, from the repo root ("." = root). */
      rootDir: z.string().default("."),
      buildCommand: z.string().optional(),
      /** The package.json script that builds it ("generate" for a static Nuxt site); "build" if unset. */
      buildScript: z.string().optional(),
      outputDir: z.string().optional(),
      /** A static Nuxt/SvelteKit site that serves every page from one fallback file. */
      staticSpa: z.boolean().optional(),
      isSSR: z.boolean().default(false),
      apiBaseUrlEnvVar: z.string().optional(), // e.g. VITE_API_URL, NEXT_PUBLIC_API_URL
      /** The code appends "/api" after that variable, so it holds an origin ("" when deployed). */
      apiBaseUrlAppendsApi: z.boolean().default(false),
      hardcodedLocalhostUrls: z.array(z.string()).default([]),
      /** Backend origins the production code calls (http://localhost:5000), rewritten at build time. */
      localhostApiOrigins: z.array(z.string()).default([]),
      /**
       * Paths the dev server proxies to the backend (Vite/Vue/Angular proxy
       * keys, setupProxy.js): in production they must reach the backend too.
       * "/" means everything (CRA's "proxy" field).
       */
      devProxyPaths: z.array(z.string()).default([]),
      /** The API variable is also handed to socket.io's io(): it must be a bare origin. */
      apiBaseUrlForSocket: z.boolean().default(false),
      /** First path segments of the frontend's own pages ("/login"): never sent to the backend. */
      pageRoutes: z.array(z.string()).default([]),
      installCommand: z.string().optional(),
    })
    .optional(),
  backend: z
    .object({
      language: z.string(), // "node", "python", "go", "java"
      framework: z.string().optional(), // "express", "fastify", "fastapi", ...
      /** Folder holding the backend, from the repo root ("." = root). */
      rootDir: z.string().default("."),
      /** The backend's own Dockerfile, from the repo root, if it has one. */
      dockerfile: z.string().optional(),
      /** Its stage the repo's compose file builds (target: development); else the last stage. */
      dockerTarget: z.string().optional(),
      startCommand: z.string().optional(),
      buildCommand: z.string().optional(),
      /** Lockfile-aware dependency install, run in rootDir. */
      installCommand: z.string().optional(),
      /** Production start without npm (Lambda has only node/python), using $PORT. */
      runCommand: z.string().optional(),
      /** gunicorn/uvicorn when the run command needs it and requirements may not list it. */
      runtimeNeeds: z.string().optional(),
      /** Has a Prisma schema: the client must be generated in the image. */
      usesPrisma: z.boolean().default(false),
      /** Go: the main package to build ("." or "./cmd/server"). */
      goMainPackage: z.string().optional(),
      /** Java: how the app builds its jar. */
      javaBuildTool: z.enum(["maven", "gradle"]).optional(),
      port: z.number().int().optional(),
      healthEndpoint: z.string().optional(),
      apiRoutePrefix: z.string().optional(),
      /** First path segments of the app's routes ("/users", "/auth"), outside any /api prefix. */
      routePrefixes: z.array(z.string()).default([]),
      isStatelessHttp: z.boolean(),
      usesWebSockets: z.boolean().default(false),
      /** socket.io's endpoint ("/socket.io" unless the server sets its own path). */
      socketIoPath: z.string().optional(),
      /** Paths plain WebSocket servers listen on ({ path: "/ws" }, @app.websocket("/ws")). */
      webSocketPaths: z.array(z.string()).default([]),
      /**
       * localhost origins in the backend's code: its own port (links to
       * itself) and frontend dev servers' (CORS allow-lists, redirects after
       * login). Rewritten to the live URL at build time.
       */
      localhostOrigins: z.array(z.string()).default([]),
      /**
       * Database connections written into the code with a localhost host
       * ("config/db.js:5: host: 'localhost'"). A deployed app can't reach its
       * database that way -- AutoInfra wires it through env vars only.
       */
      hardcodedDatabaseHosts: z.array(z.string()).optional(),
      hasLocalDiskPersistence: z.boolean().default(false),
      lambdaCompatible: z.boolean(),
      // Defaults to true for profiles stored before this field existed.
      hasMutatingRoutes: z.boolean().default(true),
    })
    .optional(),
  envVars: z
    .array(
      z.object({
        name: z.string(),
        isSecret: z.boolean(),
        /** The repo's example value when it's a local URL (http://localhost:5000/auth/callback). */
        localhostDefault: z.string().optional(),
        /** The repo's default when it's a listen address (127.0.0.1:8000, localhost, :8080). */
        bindDefault: z.string().optional(),
      }),
    )
    .default([]),
  database: z
    .enum(["postgres", "mysql", "mongo", "redis", "sqlite", "dynamodb", "none"])
    .default("none"),
  /**
   * Redis used next to the main database (sessions, a cache, job queues).
   * On F2 it runs as a second container; `database` stays the main store.
   */
  cache: z.enum(["redis"]).optional(),
  /**
   * The database runs outside AWS (MongoDB Atlas, Neon, Supabase, Upstash...):
   * the app reaches it with connection settings the user enters as env vars,
   * and AutoInfra creates no database for it. Set from the deployment's
   * option; always true for MongoDB, which AutoInfra can't host.
   */
  databaseExternal: z.boolean().default(false),
  /**
   * The hosted provider the repo's env template points the database at
   * (e.g. "neon.tech"): the app's data lives there, so the database counts
   * as external even when the owner didn't say so.
   */
  databaseHostedAt: z.string().optional(),
  /** SQL files that create the schema (database/init.sql, compose initdb mounts), repo-root-relative. */
  databaseInitScripts: z.array(z.string()).default([]),
  /** The database those scripts create or switch to (e.g. "todo_db"). */
  databaseName: z.string().optional(),
  /**
   * The app's own database setup, run on the server before each deploy
   * starts the app: migration tools every time (idempotent), SQL migration
   * files and migrate*.js scripts once each.
   */
  databaseSetup: z
    .array(
      z.object({
        kind: z.enum(["sql", "command"]),
        /** sql: repo-root-relative file. command: a stable name for tracking. */
        path: z.string(),
        command: z.string().optional(),
        once: z.boolean(),
      }),
    )
    .default([]),
  /** Seed/sample-data scripts found -- never run automatically. */
  seedScripts: z.array(z.string()).default([]),
  hasDockerfile: z.boolean().default(false),
  hasComposeFile: z.boolean().default(false),
  recommendedPattern: z.enum(["F1", "F2", "F3"]).optional(),
  unsupportedReasons: z.array(z.string()).default([]),
  secretsDetected: z.array(z.string()).default([]),
});
export type RepoProfile = z.infer<typeof RepoProfile>;
