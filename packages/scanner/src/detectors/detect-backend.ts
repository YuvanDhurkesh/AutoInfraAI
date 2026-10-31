import path from "node:path";
import { exists, isSourceFile, readFileSafe, walk } from "../fs-utils.js";
import { hasDep, readPackageJson, type PackageJson } from "../package-json.js";
import {
  nodeInstallCommand,
  nodeRunCommand,
  pythonInstallCommand,
  pythonRunCommand,
} from "./detect-commands.js";
import { detectRoutePrefixes, detectSocketIoPath, detectWebSocketPaths } from "./detect-routing.js";
import { detectHardcodedLocalhostUrls } from "./detect-frontend.js";
import { detectHardcodedDatabaseHosts } from "./detect-database-hosts.js";

export interface DetectedBackend {
  language: string;
  framework?: string;
  startCommand?: string;
  buildCommand?: string;
  /** Installs dependencies in the backend folder (lockfile-aware, with fallbacks). */
  installCommand?: string;
  /** Starts the app in production without npm, listening on $PORT where the app reads it. */
  runCommand?: string;
  /** A server package the run command needs that the app may not list (gunicorn, uvicorn). */
  runtimeNeeds?: string;
  port?: number;
  healthEndpoint?: string;
  apiRoutePrefix?: string;
  routePrefixes: string[];
  isStatelessHttp: boolean;
  usesWebSockets: boolean;
  socketIoPath?: string;
  webSocketPaths: string[];
  localhostOrigins: string[];
  /** Database connections in the code pointing at localhost (unreachable once deployed). */
  hardcodedDatabaseHosts?: string[];
  hasLocalDiskPersistence: boolean;
  lambdaCompatible: boolean;
  goMainPackage?: string;
  javaBuildTool?: "maven" | "gradle";
  /** POST/PUT/PATCH/DELETE routes. Decides the F1 Function URL auth type:
   * CloudFront OAC to Lambda breaks browser write requests. */
  hasMutatingRoutes: boolean;
}

const MUTATING_ROUTE_PATTERNS = [
  /\.(post|put|patch|delete)\(\s*["'`/]/i, // Express/Fastify/Koa routers
  /@(app|router|api|bp|blueprint)\.(post|put|patch|delete)\(/i, // FastAPI/Flask 2+
  /methods\s*=\s*\[[^\]]*["'](POST|PUT|PATCH|DELETE)["']/i, // Flask/Django
  /@(Post|Put|Patch|Delete)\(/, // NestJS
  /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, // Fastify route()/Hapi
];

/** Unknown counts as "has writes": a broken app is the worse failure. */
function detectMutatingRoutes(
  root: string,
  language: string,
  framework: string | undefined,
): boolean {
  if (language !== "node" && language !== "python") return true;
  if (framework === "django") return true; // views don't declare methods in a greppable way
  return MUTATING_ROUTE_PATTERNS.some((p) => findFirstMatch(root, p) !== null);
}

/** Languages known by their manifest; only a Dockerfile can run the ones without a blueprint. */
const MANIFESTS: Array<[string, string[]]> = [
  ["go", ["go.mod"]],
  ["java", ["pom.xml", "build.gradle", "build.gradle.kts"]],
  ["ruby", ["Gemfile"]],
  ["php", ["composer.json"]],
  ["rust", ["Cargo.toml"]],
  ["elixir", ["mix.exs"]],
];

/** A Dockerfile whose final image only serves files (nginx...) is a static site, not a backend. */
function servesFilesOnly(dockerfile: string): boolean {
  const from = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].pop()?.[1] ?? "";
  return /^(nginx|httpd|caddy|nginxinc\/|bitnami\/nginx|lipanski\/docker-static)/i.test(from);
}

function detectLanguage(root: string): { language: string; pkg: PackageJson | null } | null {
  const pkg = readPackageJson(root);
  if (pkg) return { language: "node", pkg };
  if (exists(root, "requirements.txt") || exists(root, "pyproject.toml"))
    return { language: "python", pkg: null };
  for (const [language, files] of MANIFESTS)
    if (files.some((f) => exists(root, f))) return { language, pkg: null };
  if (walk(root).some((f) => /\.(csproj|fsproj)$/.test(f.relPath)))
    return { language: "dotnet", pkg: null };
  // Any other language: its own Dockerfile says how to run it.
  const dockerfile = readFileSafe(path.join(root, "Dockerfile"));
  if (dockerfile && !servesFilesOnly(dockerfile)) return { language: "container", pkg: null };
  return null;
}

/** Go: the package with func main -- the root, or the one under cmd/ (cmd/server). */
function detectGoMainPackage(root: string): string | undefined {
  const mains = walk(root)
    .filter((f) => f.relPath.endsWith(".go") && !f.relPath.endsWith("_test.go"))
    .filter((f) => /^package\s+main\b/m.test(readFileSafe(f.absPath) ?? ""))
    .map((f) => path.dirname(f.relPath).split(path.sep).join("/"));
  if (mains.includes(".")) return ".";
  const preferred = mains.find((d) => /^cmd\/[^/]+$/.test(d)) ?? mains.sort()[0];
  return preferred ? `./${preferred}` : undefined;
}

/** Spring Boot's server.port, or Go's listen address. */
function detectLanguagePort(root: string, language: string): number | undefined {
  if (language === "java") {
    for (const file of [
      "src/main/resources/application.properties",
      "src/main/resources/application.yml",
      "src/main/resources/application.yaml",
    ]) {
      const content = readFileSafe(path.join(root, file)) ?? "";
      // server.port=8081, server.port=${PORT:8081}, or YAML server:\n  port: 8081
      const match =
        content.match(/^server\.port\s*[=:]\s*(?:\$\{\w+:)?(\d{2,5})/m) ??
        content.match(/^server:\s*\n(?:\s+.*\n)*?\s+port:\s*(?:\$\{\w+:)?(\d{2,5})/m);
      if (match) return Number(match[1]);
    }
    return 8080;
  }
  if (language === "go") {
    const match = findFirstMatch(
      root,
      /(?:ListenAndServe|\.Run|\.Listen|\.Start)\(\s*["'`](?:0\.0\.0\.0)?:(\d{2,5})["'`]/,
    );
    return match ? Number(match[1]) : 8080;
  }
  return undefined;
}

function detectNodeFramework(pkg: PackageJson): string | undefined {
  if (hasDep(pkg, "@nestjs/core")) return "nestjs";
  if (hasDep(pkg, "fastify")) return "fastify";
  if (hasDep(pkg, "express")) return "express";
  if (hasDep(pkg, "koa")) return "koa";
  if (hasDep(pkg, "@hapi/hapi", "hapi")) return "hapi";
  if (hasDep(pkg, "hono")) return "hono";
  if (hasDep(pkg, "restify")) return "restify";
  return undefined;
}

/** Frameworks whose package.json alone marks a frontend, never a backend. */
function isFrontendPackage(pkg: PackageJson): boolean {
  return hasDep(pkg, "react", "vue", "@angular/core", "svelte", "next", "nuxt", "vite");
}

function detectPythonFramework(root: string): string | undefined {
  const requirements = readFileSafe(path.join(root, "requirements.txt")) ?? "";
  const pyproject = readFileSafe(path.join(root, "pyproject.toml")) ?? "";
  const combined = `${requirements}\n${pyproject}`.toLowerCase();
  if (combined.includes("fastapi")) return "fastapi";
  if (combined.includes("flask")) return "flask";
  if (combined.includes("django")) return "django";
  return undefined;
}

function sourceFiles(root: string) {
  return walk(root).filter((f) => isSourceFile(f.relPath));
}

function findFirstMatch(root: string, regex: RegExp): RegExpMatchArray | null {
  for (const file of sourceFiles(root)) {
    const content = readFileSafe(file.absPath);
    if (!content) continue;
    const match = content.match(regex);
    if (match) return match;
  }
  return null;
}

function detectPort(root: string): number | undefined {
  const listenMatch = findFirstMatch(root, /\.listen\(\s*(\d{2,5})\s*[,)]/);
  if (listenMatch) return Number(listenMatch[1]);
  const envDefaultMatch = findFirstMatch(
    root,
    /process\.env\.PORT\s*(?:\|\||\?\?)\s*["']?(\d{2,5})["']?/,
  );
  if (envDefaultMatch) return Number(envDefaultMatch[1]);
  // const PORT = 5000 ... app.listen(PORT)
  const constMatch = findFirstMatch(root, /\b(?:const|let|var)\s+PORT\s*=\s*(\d{2,5})\b/);
  if (constMatch) return Number(constMatch[1]);
  const pythonEnvDefault = findFirstMatch(
    root,
    /(?:os\.environ\.get|os\.getenv)\(\s*["']PORT["']\s*,\s*["']?(\d{2,5})/,
  );
  if (pythonEnvDefault) return Number(pythonEnvDefault[1]);
  const dockerfile = readFileSafe(path.join(root, "Dockerfile"));
  const exposeMatch = dockerfile?.match(/^EXPOSE\s+(\d{2,5})/m);
  if (exposeMatch) return Number(exposeMatch[1]);
  return undefined;
}

/** Frontend dev servers a backend allow-lists (CORS) or redirects to after login. */
const FRONTEND_DEV_PORTS = new Set(["3000", "3001", "4200", "4173", "5173", "5174", "8080"]);

/**
 * localhost origins in the backend's code that mean "the app in production":
 * its own port and frontend dev servers'. Other ports (a second local
 * service) are left alone.
 */
function detectLocalhostOrigins(root: string, port: number | undefined): string[] {
  const origins = new Set<string>();
  for (const entry of detectHardcodedLocalhostUrls(root)) {
    const url = entry.slice(entry.lastIndexOf(": ") + 2);
    const urlPort = url.match(/^https?:\/\/[^/]+:(\d+)$/)?.[1];
    if (urlPort && (urlPort === String(port) || FRONTEND_DEV_PORTS.has(urlPort))) origins.add(url);
  }
  return [...origins].sort();
}

function detectHealthEndpoint(root: string): string | undefined {
  const match = findFirstMatch(root, /\.(?:get|all)\(\s*["'](\/[\w/-]*health[\w/-]*)["']/i);
  return match?.[1];
}

/**
 * Where the app's own routes start, when they live under /api: decides
 * whether CloudFront/Caddy pass /api/... through unchanged or strip the
 * prefix first. Covers Express/Koa/Fastify routers and mounts, FastAPI and
 * Flask prefixes and decorators, NestJS global/controller prefixes, Django
 * URL patterns.
 */
const API_ROUTE_PATTERNS: RegExp[] = [
  /\.(?:use|get|post|put|patch|delete|all|route)\(\s*["'`](\/api(?:\/[\w:.-]*)*)["'`]/,
  /\b(?:prefix|url_prefix)\s*[=:]\s*["'](\/api(?:\/[\w.-]*)*)["']/,
  /setGlobalPrefix\(\s*["']\/?(api(?:\/[\w.-]*)*)["']/,
  /@Controller\(\s*["']\/?(api(?:\/[\w.-]*)*)["']/,
  /\b(?:re_)?path\(\s*r?["']\^?(api\/[\w/.-]*)["']/,
  // Go (net/http, gin, echo, chi, fiber), Spring, Rails.
  /\.(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Group|Route|Get|Post|Put|Delete|Mount)\(\s*"(?:(?:GET|POST|PUT|PATCH|DELETE) )?(\/api(?:\/[\w:.{}-]*)*)"/,
  /@(?:Request|Get|Post|Put|Patch|Delete)Mapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"(\/api(?:\/[\w.{}-]*)*)"/,
  /\bnamespace\s+:(api)\b/,
];

function detectApiRoutePrefix(root: string): string | undefined {
  // Laravel serves routes/api.php under /api.
  if (exists(root, "routes/api.php")) return "/api";
  for (const pattern of API_ROUTE_PATTERNS) {
    const match = findFirstMatch(root, pattern);
    if (match) {
      const prefix = `/${match[1]!.replace(/^\/+/, "")}`;
      // "/api/users" -> "/api"; keep versioned prefixes like "/api/v1".
      const parts = prefix.split("/").filter(Boolean);
      return `/${parts.slice(0, /^v\d+$/.test(parts[1] ?? "") ? 2 : 1).join("/")}`;
    }
  }
  return undefined;
}

function detectUsesWebSockets(root: string, pkg: PackageJson | null): boolean {
  if (pkg && hasDep(pkg, "ws", "socket.io", "@fastify/websocket")) return true;
  return findFirstMatch(root, /\bnew WebSocketServer\(|socket\.io|\.upgrade\(/) !== null;
}

function detectLocalDiskPersistence(root: string, pkg: PackageJson | null): boolean {
  if (pkg && hasDep(pkg, "sqlite3", "better-sqlite3")) return true;
  return (
    findFirstMatch(root, /diskStorage\(|fs\.(writeFileSync|createWriteStream|appendFileSync)\(/) !==
    null
  );
}

export function detectBackend(root: string, repoRoot: string = root): DetectedBackend | null {
  const detected = detectLanguage(root);
  if (!detected) return null;
  const { language, pkg } = detected;

  const framework =
    language === "node" && pkg
      ? detectNodeFramework(pkg)
      : language === "python"
        ? detectPythonFramework(root)
        : undefined;
  // A package.json alone doesn't mean there's a backend here (it could be the
  // frontend's); a plain Node server that calls .listen() still counts. A
  // workspace root's .listen() is its member's (backend/index.js), so the
  // backend is looked for in the members instead.
  const workspaceRoot = Boolean(pkg?.workspaces) || exists(root, "pnpm-workspace.yaml");
  const nodeServer =
    language === "node" &&
    !framework &&
    pkg &&
    !workspaceRoot &&
    !isFrontendPackage(pkg) &&
    findFirstMatch(root, /\b(?:createServer|app)\b[\s\S]{0,200}?\.listen\(/) !== null;
  if (language === "node" && !framework && !nodeServer) return null;

  const pythonDeps =
    language === "python"
      ? `${readFileSafe(path.join(root, "requirements.txt")) ?? ""}\n${readFileSafe(path.join(root, "pyproject.toml")) ?? ""}`
      : "";
  const socketIoPath = detectSocketIoPath(root, pkg, pythonDeps);
  const webSocketPaths = detectWebSocketPaths(root);
  const usesWebSockets =
    detectUsesWebSockets(root, pkg) || Boolean(socketIoPath) || webSocketPaths.length > 0;
  const hasLocalDiskPersistence = detectLocalDiskPersistence(root, pkg);
  const isStatelessHttp = true; // every framework we detect here is a request/response HTTP framework

  const python = language === "python" ? pythonRunCommand(root, framework) : undefined;
  const port =
    (language === "java" ? detectLanguagePort(root, language) : undefined) ??
    detectPort(root) ??
    detectLanguagePort(root, language) ??
    (language === "python" ? 8000 : undefined);
  // Only Node and Python run on Lambda; everything else needs a container.
  const lambdaRuntime = language === "node" || language === "python";
  return {
    language,
    framework: framework ?? (nodeServer ? "node-http" : undefined),
    startCommand: pkg?.scripts?.start ?? pkg?.scripts?.dev,
    buildCommand: pkg?.scripts?.build,
    installCommand:
      language === "node"
        ? nodeInstallCommand(root, repoRoot)
        : language === "python"
          ? pythonInstallCommand(root)
          : undefined,
    runCommand: language === "node" && pkg ? nodeRunCommand(root, pkg) : python?.command,
    runtimeNeeds: python?.needs,
    port,
    healthEndpoint: detectHealthEndpoint(root),
    apiRoutePrefix: detectApiRoutePrefix(root),
    routePrefixes: detectRoutePrefixes(root),
    isStatelessHttp,
    usesWebSockets,
    socketIoPath,
    webSocketPaths,
    localhostOrigins: detectLocalhostOrigins(root, port),
    hardcodedDatabaseHosts: detectHardcodedDatabaseHosts(root),
    hasLocalDiskPersistence,
    lambdaCompatible:
      lambdaRuntime && isStatelessHttp && !usesWebSockets && !hasLocalDiskPersistence,
    goMainPackage: language === "go" ? detectGoMainPackage(root) : undefined,
    javaBuildTool: language === "java" ? (exists(root, "pom.xml") ? "maven" : "gradle") : undefined,
    hasMutatingRoutes: detectMutatingRoutes(root, language, framework),
  };
}
