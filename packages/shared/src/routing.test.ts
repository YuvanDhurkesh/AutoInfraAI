import { describe, expect, it } from "vitest";
import type { RepoProfile } from "./repo-profile.js";
import { backendRouting, MAX_BACKEND_PATHS, normalizeRoutePath } from "./routing.js";

type Fe = NonNullable<RepoProfile["frontend"]>;
type Be = NonNullable<RepoProfile["backend"]>;

const fe = (extra: Partial<Fe> = {}): Fe => ({
  framework: "react-vite",
  rootDir: "frontend",
  isSSR: false,
  apiBaseUrlEnvVar: "VITE_API_URL",
  apiBaseUrlAppendsApi: false,
  hardcodedLocalhostUrls: [],
  localhostApiOrigins: [],
  devProxyPaths: [],
  apiBaseUrlForSocket: false,
  pageRoutes: [],
  ...extra,
});
const be = (extra: Partial<Be> = {}): Be => ({
  language: "node",
  framework: "express",
  rootDir: "backend",
  usesPrisma: false,
  routePrefixes: [],
  isStatelessHttp: true,
  usesWebSockets: false,
  webSocketPaths: [],
  localhostOrigins: [],
  hasLocalDiskPersistence: false,
  lambdaCompatible: true,
  hasMutatingRoutes: true,
  ...extra,
});

describe("backendRouting", () => {
  it("routes under /api: nothing stripped, localhost URLs keep their path", () => {
    const r = backendRouting(
      { frontend: fe(), backend: be({ apiRoutePrefix: "/api", routePrefixes: ["/api"] }) },
      "/api",
    );
    expect(r).toMatchObject({ stripPrefix: false, backendPaths: [], localhostSuffix: "" });
    expect(r.apiVarSuffix).toBe("/api");
  });

  it("routes without /api: localhost URLs gain the prefix that CloudFront strips again", () => {
    const r = backendRouting(
      { frontend: fe(), backend: be({ routePrefixes: ["/todos"] }) },
      "/api",
    );
    expect(r.stripPrefix).toBe(true);
    expect(r.localhostSuffix).toBe("/api");
    // The backend's own routes are reachable directly too.
    expect(r.backendPaths).toEqual(["/todos"]);
  });

  it("files the backend serves outside /api (uploads) and socket.io reach it", () => {
    const r = backendRouting(
      {
        frontend: fe({ localhostApiOrigins: ["http://localhost:5000"] }),
        backend: be({
          apiRoutePrefix: "/api",
          routePrefixes: ["/api", "/uploads"],
          socketIoPath: "/socket.io",
        }),
      },
      "/api",
    );
    expect(r.backendPaths).toEqual(["/socket.io", "/uploads"]);
    expect(r.localhostSuffix).toBe("");
  });

  it("socket.io + routes without /api: one origin serves io() and fetch(), so it stays bare", () => {
    const r = backendRouting(
      {
        frontend: fe({ localhostApiOrigins: ["http://localhost:5000"] }),
        backend: be({ routePrefixes: ["/messages"], socketIoPath: "/socket.io" }),
      },
      "/api",
    );
    expect(r.localhostSuffix).toBe("");
    expect(r.backendPaths).toEqual(["/socket.io", "/messages"]);
  });

  it("an API variable handed to io() holds the bare origin", () => {
    const r = backendRouting(
      { frontend: fe({ apiBaseUrlForSocket: true }), backend: be({ socketIoPath: "/socket.io" }) },
      "/api",
    );
    expect(r.apiVarSuffix).toBe("");
  });

  it("dev-proxy paths are routed; a page of the same name beats a route found in code", () => {
    const r = backendRouting(
      {
        frontend: fe({ devProxyPaths: ["/auth/*", "/api"], pageRoutes: ["/login", "/users"] }),
        backend: be({ apiRoutePrefix: "/api", routePrefixes: ["/api", "/users", "/assets"] }),
      },
      "/api",
    );
    expect(r.backendPaths).toEqual(["/auth"]);
    expect(r.pageConflicts).toEqual(["/users"]);
  });

  it("a WebSocket endpoint outside /api is routed and the ws:// URL keeps its path", () => {
    const withPath = backendRouting(
      { frontend: fe(), backend: be({ apiRoutePrefix: "/api", webSocketPaths: ["/ws"] }) },
      "/api",
    );
    expect(withPath.backendPaths).toEqual(["/ws"]);
    expect(withPath.webSocketSuffix).toBe("");
    // A server without a path accepts any: reach it through /api.
    const anyPath = backendRouting(
      { frontend: fe(), backend: be({ usesWebSockets: true }) },
      "/api",
    );
    expect(anyPath.webSocketSuffix).toBe("/api");
  });

  it("an API-only app needs nothing extra; too many paths are reported, not routed", () => {
    expect(backendRouting({ backend: be({ routePrefixes: ["/a"] }) }, "/api").backendPaths).toEqual(
      [],
    );
    const many = Array.from({ length: MAX_BACKEND_PATHS + 2 }, (_, i) => `/r${i}`);
    const r = backendRouting({ frontend: fe(), backend: be({ routePrefixes: many }) }, "/api");
    expect(r.backendPaths).toHaveLength(MAX_BACKEND_PATHS);
    expect(r.droppedPaths).toHaveLength(2);
  });

  it("normalizes proxy keys and globs", () => {
    expect(normalizeRoutePath("/auth/*")).toBe("/auth");
    expect(normalizeRoutePath("socket.io/")).toBe("/socket.io");
    expect(normalizeRoutePath("/files/**")).toBe("/files");
  });
});
