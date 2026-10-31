import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { scanRepo } from "./scan.js";

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a small repo: { "backend/package.json": "...", ... }. Removed after the file's tests. */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-scan-"));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const scan = (root: string) =>
  scanRepo(root, { repoUrl: "https://github.com/x/y", commitSha: "0", branch: "main" });

const FIXTURES = path.resolve(fileURLToPath(new URL("../test/fixtures", import.meta.url)));

const reactVite = JSON.stringify({
  dependencies: { react: "18" },
  devDependencies: { vite: "5" },
  scripts: { build: "vite build" },
});
const express = (deps: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: { express: "4", ...deps }, scripts: { start: "node server.js" } });

describe("routing detection", () => {
  it("MERN chat: socket.io, files served at /uploads, CRA's proxy, a page route", () => {
    const p = scan(path.join(FIXTURES, "mern-socketio"));
    expect(p.frontend).toMatchObject({
      framework: "cra",
      devProxyPaths: ["/"],
      localhostApiOrigins: ["http://localhost:5000"],
      pageRoutes: ["/chats"],
    });
    expect(p.backend).toMatchObject({
      apiRoutePrefix: "/api",
      routePrefixes: ["/api", "/uploads"],
      socketIoPath: "/socket.io",
      lambdaCompatible: false,
    });
  });

  it("Vite proxy keys and app-level routes, never a router's own paths", () => {
    const p = scan(path.join(FIXTURES, "vite-proxy-routes"));
    expect(p.frontend?.devProxyPaths).toEqual(["/todos", "/auth"]);
    expect(p.frontend?.pageRoutes).toEqual(["/settings"]);
    // auth.post("/login") is under /auth: not a top-level route.
    expect(p.backend?.routePrefixes).toEqual(["/auth", "/health", "/todos"]);
    expect(p.backend?.apiRoutePrefix).toBeUndefined();
  });

  it("setupProxy.js and Angular proxy files", () => {
    const cra = scan(
      repo({
        "package.json": JSON.stringify({ dependencies: { react: "18", "react-scripts": "5" } }),
        "src/setupProxy.js":
          'module.exports = (app) => { app.use(["/auth", "/files"], createProxyMiddleware({ target: "http://localhost:5000" })); app.use(createProxyMiddleware("/graphql", {})); };',
        "src/App.js": "export default () => null;",
      }),
    );
    expect(cra.frontend?.devProxyPaths.sort()).toEqual(["/auth", "/files", "/graphql"]);

    const ng = scan(
      repo({
        "package.json": JSON.stringify({ dependencies: { "@angular/core": "18" } }),
        "proxy.conf.json": JSON.stringify({ "/api/*": { target: "x" }, "/hub": { target: "x" } }),
        "src/main.ts": "bootstrap();",
      }),
    );
    expect(ng.frontend?.devProxyPaths).toEqual(["/api", "/hub"]);
  });

  it("WebSocket endpoints: ws path option, FastAPI, Flask-SocketIO", () => {
    const ws = scan(
      repo({
        "package.json": express({ ws: "8" }),
        "server.js":
          'const app = require("express")(); const s = app.listen(3001); new WebSocketServer({ server: s, path: "/live" });',
      }),
    );
    expect(ws.backend?.webSocketPaths).toEqual(["/live"]);
    expect(ws.backend?.lambdaCompatible).toBe(false);

    const fastapi = scan(
      repo({
        "requirements.txt": "fastapi\nuvicorn\n",
        "main.py":
          'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/items")\ndef items(): return []\n@app.websocket("/ws")\nasync def ws(socket): pass\n',
      }),
    );
    expect(fastapi.backend).toMatchObject({
      webSocketPaths: ["/ws"],
      routePrefixes: ["/items", "/ws"],
    });

    const flask = scan(
      repo({
        "requirements.txt": "flask\nflask-socketio\n",
        "app.py":
          'from flask import Flask\napp = Flask(__name__)\n@app.route("/chat")\ndef chat(): pass\n',
      }),
    );
    expect(flask.backend?.socketIoPath).toBe("/socket.io");
  });

  it("NestJS controllers count as routes only without a global prefix", () => {
    const files = (main: string) =>
      repo({
        "package.json": JSON.stringify({
          dependencies: { "@nestjs/core": "10" },
          scripts: { start: "node dist/main.js" },
        }),
        "src/main.ts": main,
        "src/users.controller.ts": "@Controller('users') export class UsersController {}",
      });
    expect(scan(files("app.listen(3000);")).backend?.routePrefixes).toEqual(["/users"]);
    const prefixed = scan(files("app.setGlobalPrefix('api'); app.listen(3000);")).backend;
    expect(prefixed?.routePrefixes).toEqual([]);
    expect(prefixed?.apiRoutePrefix).toBe("/api");
  });

  it("an API variable handed to io(), and localhost URLs in .vue files and inline scripts", () => {
    const vue = scan(
      repo({
        "frontend/package.json": JSON.stringify({
          dependencies: { vue: "3" },
          devDependencies: { vite: "5" },
        }),
        "frontend/src/App.vue":
          '<script setup>\nconst API = import.meta.env.VITE_SERVER_URL;\nconst socket = io(API);\nfetch("http://localhost:8000/api/x");\n</script>',
        "backend/package.json": express({ "socket.io": "4" }),
        "backend/server.js":
          'const app = require("express")(); app.get("/api/x"); app.listen(8000);',
      }),
    );
    expect(vue.frontend).toMatchObject({
      apiBaseUrlEnvVar: "VITE_SERVER_URL",
      apiBaseUrlForSocket: true,
      localhostApiOrigins: ["http://localhost:8000"],
    });

    const plain = scan(
      repo({
        "frontend/index.html":
          '<script>fetch("http://localhost:5000/api/items"); new WebSocket("ws://localhost:5000/feed");</script>',
        "backend/package.json": express(),
        "backend/server.js": 'const app = require("express")(); app.listen(5000);',
      }),
    );
    expect(plain.frontend?.localhostApiOrigins).toEqual([
      "http://localhost:5000",
      "ws://localhost:5000",
    ]);
  });

  it("a database the env template hosts elsewhere stays there; a local one runs on the instance", () => {
    const app = (envExample: string) =>
      scan(
        repo({
          "package.json": express({ pg: "8" }),
          "server.js": 'const app = require("express")(); app.listen(5000);',
          ".env.example": envExample,
        }),
      );
    const neon = app(
      "DATABASE_URL=postgresql://user:pass@ep-cool-1.us-east-2.aws.neon.tech/db?sslmode=require\n",
    );
    expect(neon).toMatchObject({ databaseExternal: true, databaseHostedAt: "neon.tech" });
    expect(neon.recommendedPattern).toBe("F1"); // no database to host: Lambda is enough

    const local = app("DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n");
    expect(local.databaseExternal).toBe(false);
    expect(local.databaseHostedAt).toBeUndefined();

    // A second service (Redis at Upstash) says nothing about the Postgres database.
    const redis = app(
      "DATABASE_URL=postgres://localhost/app\nREDIS_URL=rediss://x.upstash.io:6379\n",
    );
    expect(redis.databaseExternal).toBe(false);

    const host = app('DB_HOST="aws-0-ap-south-1.pooler.supabase.com"\n');
    expect(host.databaseHostedAt).toBe("supabase.com");
  });

  it("example values that are local URLs, and localhost URLs in the backend's code", () => {
    const p = scan(
      repo({
        "backend/package.json": express(),
        "backend/.env.example":
          "GOOGLE_CALLBACK_URL=http://localhost:5000/auth/google/callback\nJWT_SECRET=http://localhost:5000\n",
        "backend/server.js": [
          'const app = require("express")();',
          'app.use(cors({ origin: "http://localhost:5173" }));',
          'const ml = "http://localhost:8001";',
          'console.log("http://localhost:5000");',
          "app.listen(5000);",
        ].join("\n"),
        "frontend/package.json": reactVite,
        "frontend/index.html": "<div id=root></div>",
      }),
    );
    expect(p.envVars).toContainEqual({
      name: "GOOGLE_CALLBACK_URL",
      isSecret: false,
      localhostDefault: "http://localhost:5000/auth/google/callback",
    });
    // A secret's example value is never kept.
    expect(p.envVars.find((v) => v.name === "JWT_SECRET")?.localhostDefault).toBeUndefined();
    // Its own port and the frontend dev server's -- not another local service.
    expect(p.backend?.localhostOrigins).toEqual(["http://localhost:5000", "http://localhost:5173"]);
  });

  it("containers: Go and Spring Boot by manifest, any language with a Dockerfile, never a static nginx", () => {
    const go = scan(path.join(FIXTURES, "go-api"));
    expect(go.backend).toMatchObject({
      language: "go",
      rootDir: "api",
      goMainPackage: "./cmd/server",
      apiRoutePrefix: "/api",
      port: 8080,
      lambdaCompatible: false,
    });
    expect(go.recommendedPattern).toBe("F2");

    const java = scan(path.join(FIXTURES, "spring-boot"));
    expect(java.backend).toMatchObject({ language: "java", javaBuildTool: "maven", port: 8081 });

    const ruby = scan(path.join(FIXTURES, "rails-docker"));
    expect(ruby.backend).toMatchObject({ language: "ruby", dockerfile: "Dockerfile", port: 4567 });
    expect(ruby.envVars.map((v) => v.name)).toContain("PORT"); // ENV.fetch("PORT", ...)

    const elixirish = scan(
      repo({ Dockerfile: "FROM hexpm/elixir:1.17\nEXPOSE 4000\n", "lib/app.ex": "" }),
    );
    expect(elixirish.backend).toMatchObject({ language: "container", port: 4000 });

    const nginx = scan(
      repo({
        Dockerfile: "FROM nginx:alpine\nCOPY . /usr/share/nginx/html\n",
        "index.html": "<h1>hi</h1>",
      }),
    );
    expect(nginx.backend).toBeUndefined();
    expect(nginx.frontend?.framework).toBe("static");
  });

  it("databases of other languages, by their drivers", () => {
    const goPg = scan(
      repo({
        "go.mod": "module x\n\nrequire github.com/jackc/pgx/v5 v5.6.0\n",
        "main.go": 'package main\nfunc main() { http.ListenAndServe(":3000", nil) }\n',
      }),
    );
    expect(goPg).toMatchObject({ database: "postgres", backend: { port: 3000 } });
    const laravel = scan(
      repo({
        "composer.json": '{"require": {"laravel/framework": "^11.0"}}',
        ".env.example": "DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\n",
        "routes/api.php": "<?php",
        Dockerfile: "FROM php:8.3-apache\n",
      }),
    );
    expect(laravel).toMatchObject({ database: "postgres", backend: { apiRoutePrefix: "/api" } });
  });

  it("Next.js pages and app folders are page routes", () => {
    const p = scan(
      repo({
        "package.json": JSON.stringify({ dependencies: { next: "14", react: "18" } }),
        "app/dashboard/page.tsx": "export default () => null;",
        "app/api/hello/route.ts": "export const GET = () => null;",
        "pages/about.tsx": "export default () => null;",
      }),
    );
    expect(p.frontend?.pageRoutes).toEqual(["/about", "/dashboard"]);
  });
});
