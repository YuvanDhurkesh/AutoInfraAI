import type { RepoProfile } from "./repo-profile.js";

/**
 * CloudFront allows 25 cache behaviors by default; each backend path takes
 * two ("/auth" and "/auth/*") next to the API prefix's two.
 */
export const MAX_BACKEND_PATHS = 8;

/** Where a built frontend keeps its own files: never sent to the backend. */
const FRONTEND_FILE_PATHS = new Set([
  "/assets",
  "/static",
  "/_next",
  "/index.html",
  "/favicon.ico",
  "/robots.txt",
  "/manifest.json",
]);

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** "/auth/*" -> "/auth", "socket.io/" -> "/socket.io". */
export function normalizeRoutePath(path: string): string {
  const trimmed = path
    .trim()
    .replace(/\/?\*+$/, "")
    .replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface BackendRouting {
  /** The backend's routes don't start with the API prefix, so it is removed first. */
  stripPrefix: boolean;
  /**
   * Paths outside the API prefix that reach the backend unchanged:
   * socket.io, WebSocket endpoints, dev-proxy paths and the app's own
   * top-level routes ("/uploads", "/auth").
   */
  backendPaths: string[];
  /** Backend routes left to the frontend because a page of the same name exists. */
  pageConflicts: string[];
  /** Paths found beyond MAX_BACKEND_PATHS (not routed). */
  droppedPaths: string[];
  /** Appended to the live URL when http://localhost:<backend> is rewritten in the frontend. */
  localhostSuffix: string;
  /** Appended to wss://<live host> when ws://localhost:<backend> is rewritten. */
  webSocketSuffix: string;
  /** Appended to the live URL in the frontend's API variable. */
  apiVarSuffix: string;
}

/**
 * How requests find the backend through the one CloudFront URL: the API
 * prefix (stripped when the app's routes lack it) plus the backend's other
 * paths, and what localhost URLs in the frontend become so they land there.
 */
export function backendRouting(
  profile: Pick<RepoProfile, "frontend" | "backend">,
  apiPrefix: string,
): BackendRouting {
  const fe = profile.frontend;
  const be = profile.backend;
  const routesUnderPrefix = Boolean(be?.apiRoutePrefix && under(be.apiRoutePrefix, apiPrefix));
  // An API-only app gets every path unchanged: nothing to strip or add.
  const stripPrefix = Boolean(be) && Boolean(fe) && !routesUnderPrefix;
  const socketIo = be?.socketIoPath;

  const explicit = [
    socketIo,
    ...(be?.webSocketPaths ?? []),
    ...(fe?.devProxyPaths ?? []).filter((p) => p !== "/"),
  ].filter((p): p is string => Boolean(p));
  const routes = be?.routePrefixes ?? [];
  const pages = new Set((fe?.pageRoutes ?? []).map(normalizeRoutePath));

  const wanted = new Set<string>();
  const pageConflicts: string[] = [];
  if (be && fe) {
    for (const raw of [...explicit, ...routes]) {
      const path = normalizeRoutePath(raw);
      if (path === "/" || under(path, apiPrefix) || FRONTEND_FILE_PATHS.has(path)) continue;
      // A route found in the code loses to a page of the same name; a path
      // the developer proxied or a socket endpoint never does.
      if (!explicit.includes(raw) && pages.has(path)) {
        pageConflicts.push(path);
        continue;
      }
      wanted.add(path);
    }
  }
  const all = [...wanted];
  const backendPaths = all.slice(0, MAX_BACKEND_PATHS);
  const routedWebSocket = (be?.webSocketPaths ?? []).some((p) =>
    backendPaths.includes(normalizeRoutePath(p)),
  );

  return {
    stripPrefix,
    backendPaths,
    pageConflicts: [...new Set(pageConflicts)],
    droppedPaths: all.slice(MAX_BACKEND_PATHS),
    // With socket.io, one constant often serves io() and fetch(): keep it a
    // bare origin and rely on the backend's routes being routed directly.
    localhostSuffix: stripPrefix && !socketIo ? apiPrefix : "",
    webSocketSuffix: routedWebSocket ? "" : apiPrefix,
    apiVarSuffix: fe?.apiBaseUrlAppendsApi || fe?.apiBaseUrlForSocket ? "" : apiPrefix,
  };
}
