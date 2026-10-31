import fs from "node:fs";
import path from "node:path";
import type { RepoProfile } from "@autoinfra/shared";
import { exists, readFileSafe } from "./fs-utils.js";
import {
  COMPOSE_FILES,
  composeBuildTarget,
  dockerBuildTarget,
} from "./detectors/detect-compose-target.js";
import { readPackageJson, allDeps } from "./package-json.js";
import { detectFrontend } from "./detectors/detect-frontend.js";
import { detectBackend } from "./detectors/detect-backend.js";
import { detectDatabase, usesRedis } from "./detectors/detect-database.js";
import { detectEnvVars } from "./detectors/detect-env-vars.js";
import { detectSecrets } from "./detectors/detect-secrets.js";
import {
  computeRecommendedPattern,
  computeUnsupportedReasons,
  isDatabaseExternal,
} from "./pattern.js";
import { detectInitDatabaseName, detectInitScripts } from "./detectors/detect-init-scripts.js";
import { detectDatabaseSetup } from "./detectors/detect-db-setup.js";
import { detectHostedDatabase } from "./detectors/detect-hosted-database.js";

export interface ScanRepoInput {
  repoUrl: string;
  commitSha: string;
  branch: string;
  subdir?: string;
  /** The owner said the database is hosted outside AWS (see RepoProfile.databaseExternal). */
  externalDatabase?: boolean;
}

const COMMON_FRONTEND_DIRS = ["frontend", "client", "web", "app", "ui", "www", "site"];
const COMMON_BACKEND_DIRS = ["backend", "server", "api", "service"];
const NEVER_APP_DIRS = new Set([
  "node_modules",
  "docs",
  "doc",
  "test",
  "tests",
  "scripts",
  "examples",
  "public",
  "assets",
  "migrations",
  "database",
  "db",
]);

function listSubdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Detects frontend + backend at `effectiveRoot`, and looks for whichever
 * side is missing in its subfolders -- conventional names first
 * (frontend/client/web..., backend/server/api...), then any other folder
 * (e.g. "farmer-web"). A pinned subdir that is itself a frontend or a
 * backend is taken as-is (subdir "backend" means the backend alone); one
 * holding neither is an app folder, searched like a repo root
 * ("apps/shop" with frontend/ and backend/ inside). Scanner tests cover
 * this via the "monorepo" fixture.
 */
function detectApp(effectiveRoot: string, explicitSubdir: boolean, repoRoot: string) {
  let backendPath: string | undefined = effectiveRoot;
  let backend = detectBackend(effectiveRoot, repoRoot);
  let frontendPath: string | undefined = effectiveRoot;
  let frontend = detectFrontend(effectiveRoot, repoRoot, backend?.port);

  const searchSubfolders = explicitSubdir ? !frontend && !backend : !frontend || !backend;
  if (searchSubfolders) {
    const subdirs = listSubdirs(effectiveRoot).filter((d) => !NEVER_APP_DIRS.has(d.toLowerCase()));
    const ordered = (preferred: string[]) => [
      ...subdirs.filter((d) => preferred.includes(d.toLowerCase())),
      ...subdirs.filter((d) => !preferred.includes(d.toLowerCase())),
    ];
    if (!backend) {
      backendPath = undefined;
      for (const dir of ordered(COMMON_BACKEND_DIRS)) {
        const found = detectBackend(path.join(effectiveRoot, dir), repoRoot);
        if (found) {
          backend = found;
          backendPath = path.join(effectiveRoot, dir);
          break;
        }
      }
    }
    if (!frontend) {
      frontendPath = undefined;
      for (const dir of ordered(COMMON_FRONTEND_DIRS)) {
        const full = path.join(effectiveRoot, dir);
        if (full === backendPath) continue;
        const found = detectFrontend(full, repoRoot, backend?.port);
        // A bare index.html in some folder isn't a frontend unless the folder says so.
        if (
          found &&
          (found.framework !== "static" || COMMON_FRONTEND_DIRS.includes(dir.toLowerCase()))
        ) {
          frontend = found;
          frontendPath = full;
          break;
        }
      }
    }
  }
  if (!backend) backendPath = undefined;
  if (!frontend) frontendPath = undefined;
  return {
    frontend,
    backend,
    // Env vars and dependencies come from the app folders only (a root walk
    // would also pick up scripts/ and tests/).
    dirsScanned:
      frontendPath || backendPath
        ? [...new Set([frontendPath, backendPath])].filter((d): d is string => Boolean(d))
        : [effectiveRoot],
    frontendPath,
    backendPath,
  };
}

/** The stage of the backend's own Dockerfile to build, when not Docker's default (the last). */
function buildTargetFor(backendDir: string, composeDirs: string[]): string | undefined {
  const dockerfile = readFileSafe(path.join(backendDir, "Dockerfile")) ?? "";
  return dockerBuildTarget(dockerfile, composeBuildTarget(composeDirs, backendDir, dockerfile));
}

/** Repo-root-relative POSIX path ("." for the root itself). */
function relativeDir(repoRoot: string, dir: string): string {
  return path.relative(repoRoot, dir).split(path.sep).join("/") || ".";
}

export function scanRepo(localPath: string, input: ScanRepoInput): RepoProfile {
  const effectiveRoot = input.subdir ? path.join(localPath, input.subdir) : localPath;
  const { frontend, backend, dirsScanned, frontendPath, backendPath } = detectApp(
    effectiveRoot,
    Boolean(input.subdir),
    localPath,
  );

  // Dependency names are merged across both detected app roots (they can
  // differ in a monorepo) for the ML/GPU unsupported-workload check.
  const dependencyNames = dirsScanned.flatMap((dir) => {
    const pkg = readPackageJson(dir);
    return pkg ? Object.keys(allDeps(pkg)) : [];
  });

  const database = dirsScanned.map(detectDatabase).find((d) => d !== "none") ?? "none";
  // Redis next to another main store (Postgres + a Redis cache or queue).
  const cache =
    database !== "redis" && dirsScanned.some(usesRedis) ? ("redis" as const) : undefined;
  // An env template pointing at Neon/Atlas/Supabase...: the data lives there,
  // so a fresh, empty database on the instance would be the wrong one.
  const databaseHostedAt = detectHostedDatabase(
    [...new Set([...dirsScanned, localPath])],
    database,
  );
  const databaseExternal = isDatabaseExternal(
    database,
    Boolean(input.externalDatabase) || Boolean(databaseHostedAt),
  );
  // An external database already has its schema; AutoInfra never runs scripts against it.
  const initScripts =
    ["postgres", "mysql"].includes(database) && !databaseExternal
      ? detectInitScripts(effectiveRoot, localPath)
      : [];
  const envVars = [...new Map(dirsScanned.flatMap(detectEnvVars).map((v) => [v.name, v])).values()];
  // Setup belongs to whatever runs the server code: the backend, or a
  // Next.js server with its own API routes.
  const serverPath = backendPath ?? (frontend?.isSSR ? frontendPath : undefined);
  const setup =
    serverPath && database !== "none"
      ? detectDatabaseSetup(serverPath, localPath, backend?.framework)
      : { steps: [], seeds: [] };
  // Secrets can leak anywhere in the checkout, not just the app subdir.
  const secretsDetected = detectSecrets(localPath);

  // The app folders, the chosen subdir (a samples repo keeps compose.yaml
  // beside backend/ and frontend/), and the repo root.
  const appDirs = [...new Set([...dirsScanned, effectiveRoot, localPath])];
  const hasDockerfile = appDirs.some((dir) => exists(dir, "Dockerfile"));
  const hasComposeFile = appDirs.some((dir) => COMPOSE_FILES.some((name) => exists(dir, name)));

  const frontendProfile: RepoProfile["frontend"] = frontend
    ? {
        framework: frontend.framework,
        rootDir: relativeDir(localPath, frontendPath ?? effectiveRoot),
        buildCommand: frontend.buildCommand,
        buildScript: frontend.buildScript,
        outputDir: frontend.outputDir,
        ...(frontend.staticSpa !== undefined && { staticSpa: frontend.staticSpa }),
        isSSR: frontend.isSSR,
        apiBaseUrlEnvVar: frontend.apiBaseUrlEnvVar,
        apiBaseUrlAppendsApi: frontend.apiBaseUrlAppendsApi,
        hardcodedLocalhostUrls: frontend.hardcodedLocalhostUrls,
        localhostApiOrigins: frontend.localhostApiOrigins,
        devProxyPaths: frontend.devProxyPaths,
        apiBaseUrlForSocket: frontend.apiBaseUrlForSocket,
        pageRoutes: frontend.pageRoutes,
        installCommand: frontend.installCommand,
      }
    : undefined;

  const backendProfile: RepoProfile["backend"] = backend
    ? {
        language: backend.language,
        framework: backend.framework,
        rootDir: relativeDir(localPath, backendPath ?? effectiveRoot),
        dockerfile: exists(backendPath ?? effectiveRoot, "Dockerfile")
          ? relativeDir(localPath, path.join(backendPath ?? effectiveRoot, "Dockerfile"))
          : undefined,
        dockerTarget: buildTargetFor(backendPath ?? effectiveRoot, [effectiveRoot, localPath]),
        startCommand: backend.startCommand,
        buildCommand: backend.buildCommand,
        installCommand: backend.installCommand,
        runCommand: backend.runCommand,
        runtimeNeeds: backend.runtimeNeeds,
        usesPrisma:
          exists(backendPath ?? effectiveRoot, "prisma/schema.prisma") ||
          exists(backendPath ?? effectiveRoot, "schema.prisma"),
        goMainPackage: backend.goMainPackage,
        javaBuildTool: backend.javaBuildTool,
        port: backend.port,
        healthEndpoint: backend.healthEndpoint,
        apiRoutePrefix: backend.apiRoutePrefix,
        routePrefixes: backend.routePrefixes,
        isStatelessHttp: backend.isStatelessHttp,
        usesWebSockets: backend.usesWebSockets,
        socketIoPath: backend.socketIoPath,
        webSocketPaths: backend.webSocketPaths,
        localhostOrigins: backend.localhostOrigins,
        hardcodedDatabaseHosts: backend.hardcodedDatabaseHosts,
        hasLocalDiskPersistence: backend.hasLocalDiskPersistence,
        lambdaCompatible: backend.lambdaCompatible,
        hasMutatingRoutes: backend.hasMutatingRoutes,
      }
    : undefined;

  return {
    repoUrl: input.repoUrl,
    commitSha: input.commitSha,
    branch: input.branch,
    subdir: input.subdir,
    frontend: frontendProfile,
    backend: backendProfile,
    envVars,
    database,
    ...(cache ? { cache } : {}),
    databaseExternal,
    ...(databaseExternal && databaseHostedAt ? { databaseHostedAt } : {}),
    // Relative to the repository root: that's the build's working directory.
    databaseInitScripts: initScripts,
    databaseName: detectInitDatabaseName(localPath, initScripts),
    databaseSetup: setup.steps,
    seedScripts: setup.seeds,
    hasDockerfile,
    hasComposeFile,
    // A database hosted elsewhere needs no server here, so it doesn't force F2.
    recommendedPattern: computeRecommendedPattern(
      frontend,
      backend,
      databaseExternal ? "none" : database,
    ),
    unsupportedReasons: computeUnsupportedReasons(frontend, backend, database, dependencyNames),
    secretsDetected,
  };
}
