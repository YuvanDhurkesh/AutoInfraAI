import path from "node:path";
import { exists, isSourceFile, readFileSafe, walk } from "../fs-utils.js";
import { hasDep, type PackageJson } from "../package-json.js";

/**
 * Which paths must reach the backend through the one CloudFront URL besides
 * the API prefix, and which belong to the frontend: dev-server proxies,
 * socket.io and WebSocket endpoints, the backend's top-level routes, and the
 * frontend's own page routes (see backendRouting in @autoinfra/shared).
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?|e2e)\//;

function sources(root: string) {
  return walk(root).filter(
    (f) => isSourceFile(f.relPath) && !TEST_FILE.test(f.relPath.split(path.sep).join("/")),
  );
}

function collect(root: string, patterns: RegExp[]): string[] {
  const found = new Set<string>();
  for (const file of sources(root)) {
    const content = readFileSafe(file.absPath);
    if (!content) continue;
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) found.add(match[1]!);
    }
  }
  return [...found];
}

/** "/users/:id" -> "/users"; null for "/", params and anything not a plain segment. */
function firstSegment(route: string): string | null {
  const segment = route.replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";
  if (!segment || !/^[A-Za-z0-9_.-]+$/.test(segment)) return null;
  return `/${segment}`;
}

const PROXY_CONFIGS = [
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
  "vue.config.js",
  "svelte.config.js",
];

/** "/" when the dev server forwards everything it doesn't serve (CRA's "proxy"). */
export function detectDevProxyPaths(root: string, pkg: PackageJson | null): string[] {
  const paths = new Set<string>();
  if (typeof pkg?.proxy === "string") paths.add("/");

  for (const name of PROXY_CONFIGS) {
    const content = readFileSafe(path.join(root, name));
    if (!content) continue;
    // devServer: { proxy: "http://localhost:5000" } -- everything.
    if (/\bproxy\s*:\s*["'`]https?:/.test(content)) paths.add("/");
    const start = content.search(/\bproxy\s*:\s*\{/);
    if (start < 0) continue;
    // Keys of the proxy object: '/api': {...} or "/auth": "http://...".
    const block = content.slice(start, start + 4000);
    for (const m of block.matchAll(/["'`](\/[\w\-./]*)["'`]\s*:/g)) paths.add(m[1]!);
  }

  for (const name of ["proxy.conf.json", "src/proxy.conf.json"]) {
    const raw = readFileSafe(path.join(root, name));
    if (!raw) continue;
    try {
      for (const key of Object.keys(JSON.parse(raw) as object))
        if (key.startsWith("/")) paths.add(key);
    } catch {
      // not JSON (proxy.conf.js variants) -- nothing to read
    }
  }

  const setup = readFileSafe(path.join(root, "src", "setupProxy.js"));
  if (setup) {
    const args = [
      ...setup.matchAll(/createProxyMiddleware\(\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g),
      ...setup.matchAll(/\.use\(\s*(\[[^\]]*\]|["'`][^"'`]+["'`])\s*,/g),
      ...setup.matchAll(/\b(?:pathFilter|context)\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g),
    ];
    for (const [, arg] of args)
      for (const m of arg!.matchAll(/["'`](\/[^"'`]*)["'`]/g)) paths.add(m[1]!);
  }

  return [...paths].map((p) =>
    p === "/" ? p : p.replace(/\/?\*+$/, "").replace(/\/+$/, "") || "/",
  );
}

/**
 * The frontend's own page routes (React Router, Vue Router, Angular, Next.js
 * pages/app folders): a backend route of the same name must not take them.
 */
export function detectPageRoutes(root: string, framework: string): string[] {
  const routes = new Set<string>();
  for (const route of collect(root, [
    // <Route path="/login" />, { path: "/login", element/component: ... }, Angular { path: 'login' }
    /<Route\b[^>]*\bpath=["'{`]+\/?([A-Za-z0-9_.-]+)/g,
    /\bpath\s*:\s*["'`]\/?([A-Za-z0-9_.-]+)["'`]\s*,\s*(?:element|component|name|loadComponent|loadChildren|redirect|children)\b/g,
  ])) {
    routes.add(`/${route}`);
  }
  // Next.js: every folder (app/) or file (pages/) is a page.
  const pageDirs = framework === "next" ? ["pages", "app", "src/pages", "src/app"] : [];
  for (const dir of pageDirs) {
    if (!exists(root, dir)) continue;
    for (const f of walk(path.join(root, dir))) {
      const name = f.relPath.split(path.sep)[0]!.replace(/\.(t|j)sx?$/, "");
      if (/^[A-Za-z0-9-]+$/.test(name) && name !== "api") routes.add(`/${name}`);
    }
  }
  routes.delete("/index");
  return [...routes].sort();
}

/** socket.io's endpoint when the backend serves it: its own path option, else "/socket.io". */
export function detectSocketIoPath(
  root: string,
  pkg: PackageJson | null,
  pythonDeps: string,
): string | undefined {
  const usesSocketIo =
    (pkg && hasDep(pkg, "socket.io")) || /flask-socketio|python-socketio/i.test(pythonDeps);
  if (!usesSocketIo) return undefined;
  const custom = collect(root, [
    /new\s+(?:Server|SocketIOServer)\([^)]*?\bpath\s*:\s*["'`](\/[^"'`]+)["'`]/g,
    /\bsocket(?:io|IO)?\s*\([^)]*?\bpath\s*:\s*["'`](\/[^"'`]+)["'`]/g,
  ])[0];
  return custom ? custom.replace(/\/+$/, "") : "/socket.io";
}

/** Paths plain WebSocket servers accept connections on. */
export function detectWebSocketPaths(root: string): string[] {
  return collect(root, [
    /new\s+(?:WebSocketServer|WebSocket\.Server|WSServer)\(\s*\{[^}]*?\bpath\s*:\s*["'`](\/[^"'`]*)["'`]/g,
    /@\w+\.websocket\(\s*["'](\/[^"']*)["']/g, // FastAPI
    /\.ws\(\s*["'`](\/[^"'`]*)["'`]/g, // express-ws, Hono
  ]).map((p) => p.replace(/\/+$/, "") || "/");
}

/**
 * First segments of the backend's top-level routes ("/users", "/uploads",
 * "/auth"). Only routes on the app itself and router mount prefixes: a
 * router's own "/profile" may live under "/users", and claiming it would take
 * the path away from a frontend page.
 */
export function detectRoutePrefixes(root: string): string[] {
  const routes = collect(root, [
    // Express/Koa/Fastify/Hono app routes and mounts (incl. express.static).
    /\b(?:app|server|fastify|application)\.(?:use|get|post|put|patch|delete|all|route|head|options|register)\(\s*["'`](\/[^"'`]*)["'`]/g,
    /\bprefix\s*:\s*["'`](\/[^"'`]*)["'`]/g, // fastify.register(routes, { prefix: "/users" })
    // FastAPI/Flask app routes, included routers and blueprints.
    /@app\.(?:get|post|put|patch|delete|route|api_route|websocket)\(\s*["'](\/[^"']*)["']/g,
    /\b(?:include_router|register_blueprint|APIRouter|Blueprint)\([^)]*?\b(?:prefix|url_prefix)\s*=\s*["'](\/[^"']*)["']/g,
  ]);
  // NestJS controllers -- unless a global prefix (setGlobalPrefix("api")) puts them under it.
  if (!collect(root, [/(setGlobalPrefix)\(/g]).length)
    routes.push(...collect(root, [/@Controller\(\s*["'`]\/?([^"'`]+)["'`]/g]));
  const prefixes = new Set<string>();
  for (const route of routes) {
    const segment = firstSegment(route);
    if (segment) prefixes.add(segment);
  }
  return [...prefixes].sort();
}

/** The frontend hands its API variable to io(): it must stay a bare origin. */
export function detectApiVarForSocket(root: string, envVar: string | undefined): boolean {
  if (!envVar || !/^\w+$/.test(envVar)) return false;
  const direct = new RegExp(String.raw`\bio\(\s*(?:import\.meta\.env|process\.env)\.${envVar}\b`);
  const viaConst = new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*[^\n;]*\b${envVar}\b`);
  for (const file of sources(root)) {
    const content = readFileSafe(file.absPath);
    if (!content || !content.includes(envVar)) continue;
    if (direct.test(content)) return true;
    const name = content.match(viaConst)?.[1];
    if (name && new RegExp(String.raw`\bio\(\s*${name}\b`).test(content)) return true;
  }
  return false;
}
