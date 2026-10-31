import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanRepo } from "./scan.js";

const FIXTURES = path.resolve(fileURLToPath(new URL("../test/fixtures", import.meta.url)));

function scan(name: string, subdir?: string, externalDatabase?: boolean) {
  return scanRepo(path.join(FIXTURES, name), {
    repoUrl: `https://github.com/example/${name}`,
    commitSha: "0000000000000000000000000000000000000000",
    branch: "main",
    subdir,
    externalDatabase,
  });
}

describe("scanRepo fixtures (Sec. 12)", () => {
  it("React + Express -> F1", () => {
    const p = scan("react-express");
    expect(p.frontend?.framework).toBe("cra");
    expect(p.backend?.framework).toBe("express");
    expect(p.backend?.port).toBe(4000);
    expect(p.backend?.healthEndpoint).toBe("/api/health");
    expect(p.backend?.apiRoutePrefix).toBe("/api");
    expect(p.backend?.lambdaCompatible).toBe(true);
    expect(p.backend?.hasMutatingRoutes).toBe(false); // GET + app.use only
    expect(p.recommendedPattern).toBe("F1");
  });

  it("Vite + Fastify -> F1, picks up VITE_ env var convention", () => {
    const p = scan("vite-fastify");
    expect(p.frontend?.framework).toBe("react-vite");
    expect(p.frontend?.apiBaseUrlEnvVar).toBe("VITE_API_URL");
    expect(p.backend?.framework).toBe("fastify");
    expect(p.backend?.hasMutatingRoutes).toBe(true);
    expect(p.recommendedPattern).toBe("F1");
  });

  it("Next.js SSR + Postgres -> F2", () => {
    const p = scan("nextjs-ssr-postgres");
    expect(p.frontend?.framework).toBe("next");
    expect(p.frontend?.isSSR).toBe(true);
    expect(p.database).toBe("postgres");
    expect(p.recommendedPattern).toBe("F2");
  });

  it("Next.js SSR frontend + a Lambda-friendly Express API -> F2 (the Next server needs a host)", () => {
    const p = scan("nextjs-ssr-express");
    expect(p.frontend?.isSSR).toBe(true);
    expect(p.backend?.lambdaCompatible).toBe(true);
    expect(p.recommendedPattern).toBe("F2");
  });

  it("Nuxt and SvelteKit: their server goes to F2, a static build to F3", () => {
    const nuxt = scan("nuxt-ssr");
    expect(nuxt.frontend).toMatchObject({ framework: "nuxt", isSSR: true });
    expect(nuxt.recommendedPattern).toBe("F2");

    // ssr: false with a generate script: built with "generate" into .output/public.
    const nuxtStatic = scan("nuxt-static");
    expect(nuxtStatic.frontend).toMatchObject({
      framework: "nuxt",
      isSSR: false,
      buildScript: "generate",
      buildCommand: "nuxt generate",
      outputDir: ".output/public",
      staticSpa: true,
    });
    expect(nuxtStatic.recommendedPattern).toBe("F3");

    const kit = scan("sveltekit-ssr");
    expect(kit.frontend).toMatchObject({ framework: "sveltekit", isSSR: true });
    expect(kit.recommendedPattern).toBe("F2");

    const kitStatic = scan("sveltekit-static");
    expect(kitStatic.frontend).toMatchObject({
      framework: "sveltekit",
      isSSR: false,
      outputDir: "public",
      staticSpa: true,
    });
    expect(kitStatic.recommendedPattern).toBe("F3");
  });

  it("static-only -> F3", () => {
    const p = scan("static-only");
    expect(p.frontend?.framework).toBe("static");
    expect(p.backend).toBeUndefined();
    expect(p.recommendedPattern).toBe("F3");
  });

  it("monorepo: auto-detects both sides, and respects an explicit subdir", () => {
    const whole = scan("monorepo");
    expect(whole.frontend?.framework).toBe("react-vite");
    expect(whole.backend?.framework).toBe("express");
    expect(whole.database).toBe("dynamodb");
    expect(whole.envVars.map((v) => v.name)).toContain("TABLE_NAME");

    expect(whole.frontend?.rootDir).toBe("frontend");
    expect(whole.backend?.rootDir).toBe("backend");

    const backendOnly = scan("monorepo", "backend");
    expect(backendOnly.backend?.rootDir).toBe("backend");
    expect(backendOnly.frontend).toBeUndefined();
    expect(backendOnly.backend?.port).toBe(8080);

    // A subdir holding a whole app (frontend/ + backend/) is searched like a root.
    const appFolder = scanRepo(FIXTURES, {
      repoUrl: "https://github.com/example/apps",
      commitSha: "0000000000000000000000000000000000000000",
      branch: "main",
      subdir: "monorepo",
    });
    expect(appFolder.frontend?.rootDir).toBe("monorepo/frontend");
    expect(appFolder.backend?.rootDir).toBe("monorepo/backend");
    expect(appFolder.database).toBe("dynamodb");
  });

  it("flags hardcoded localhost URLs", () => {
    const p = scan("hardcoded-localhost");
    expect(
      p.frontend?.hardcodedLocalhostUrls.some((u) => u.includes("http://localhost:4000")),
    ).toBe(true);
    // The dev server's proxy target never reaches the production build.
    expect(p.frontend?.hardcodedLocalhostUrls.some((u) => u.includes("vite.config"))).toBe(false);
  });

  it("flags secrets without ever including their values", () => {
    const p = scan("repo-with-secrets");
    expect(p.secretsDetected.some((s) => s.includes("AWS access key"))).toBe(true);
    expect(p.secretsDetected.some((s) => s.includes(".env"))).toBe(true);
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).not.toContain("fixture-not-a-real-password-123");
  });

  it("examples/react-express-lambda (the real end-to-end sample) -> F1 with write routes", () => {
    const root = path.resolve(FIXTURES, "../../../../examples/react-express-lambda");
    const p = scanRepo(root, {
      repoUrl: "https://github.com/example/react-express-lambda",
      commitSha: "0000000000000000000000000000000000000000",
      branch: "main",
    });
    expect(p.frontend?.framework).toBe("react-vite");
    expect(p.backend?.framework).toBe("express");
    expect(p.backend?.port).toBe(8080);
    expect(p.backend?.healthEndpoint).toBe("/api/health");
    expect(p.backend?.apiRoutePrefix).toBe("/api");
    expect(p.backend?.hasMutatingRoutes).toBe(true);
    expect(p.recommendedPattern).toBe("F1");
  });

  it("examples/react-node-postgres-ws (the real end-to-end sample) -> F2 with Postgres", () => {
    const root = path.resolve(FIXTURES, "../../../../examples/react-node-postgres-ws");
    const p = scanRepo(root, {
      repoUrl: "https://github.com/example/react-node-postgres-ws",
      commitSha: "0000000000000000000000000000000000000000",
      branch: "main",
    });
    expect(p.frontend?.framework).toBe("react-vite");
    expect(p.backend?.framework).toBe("express");
    expect(p.backend?.port).toBe(4000);
    expect(p.backend?.usesWebSockets).toBe(true);
    expect(p.database).toBe("postgres");
    expect(p.envVars.map((v) => v.name)).toContain("DATABASE_URL");
    expect(p.recommendedPattern).toBe("F2");
  });

  it("MongoDB runs on the server unless it's hosted elsewhere; its connection string is a secret", () => {
    const p = scan("express-mongo");
    expect(p.database).toBe("mongo");
    expect(p.databaseExternal).toBe(false);
    expect(p.unsupportedReasons).toEqual([]);
    expect(p.recommendedPattern).toBe("F2");
    expect(p.envVars).toContainEqual({ name: "MONGODB_URI", isSecret: true });

    const atlas = scan("express-mongo", undefined, true);
    expect(atlas.databaseExternal).toBe(true);
    // Nothing to run here, so the database doesn't force F2.
    expect(atlas.recommendedPattern).toBe("F1");
  });

  it("knows how to start Python apps and which server they need", () => {
    const fastapi = scan("fastapi-postgres");
    expect(fastapi.backend).toMatchObject({
      framework: "fastapi",
      port: 8000,
      apiRoutePrefix: "/api",
      runCommand: "uvicorn app.main:app --host 0.0.0.0 --port $PORT",
      runtimeNeeds: "uvicorn",
      installCommand: "pip install --no-cache-dir -r requirements.txt",
    });
    expect(fastapi.database).toBe("postgres");
    const flask = scan("flask-api");
    expect(flask.backend?.runCommand).toBe("gunicorn --bind 0.0.0.0:$PORT app:app");
    expect(flask.backend?.apiRoutePrefix).toBeUndefined();
  });

  it("a MySQL app whose database is hosted elsewhere: no schema scripts, no forced F2", () => {
    const p = scan("express-mysql", undefined, true);
    expect(p.database).toBe("mysql");
    expect(p.databaseExternal).toBe(true);
    expect(p.databaseInitScripts).toEqual([]);
    expect(p.recommendedPattern).toBe("F1");
  });

  it("a stateless API that needs MySQL/Postgres -> F2 (Lambda has nowhere to run the database)", () => {
    const p = scan("express-mysql");
    expect(p.backend?.lambdaCompatible).toBe(true);
    expect(p.database).toBe("mysql");
    expect(p.databaseExternal).toBe(false);
    expect(p.recommendedPattern).toBe("F2");
    expect(p.databaseInitScripts).toEqual(["database/init.sql"]);
    expect(p.databaseName).toBe("todo_db");
  });

  it("WebSockets -> not Lambda-compatible -> F2", () => {
    const p = scan("websockets");
    expect(p.backend?.usesWebSockets).toBe(true);
    expect(p.backend?.lambdaCompatible).toBe(false);
    expect(p.recommendedPattern).toBe("F2");
  });
});
