import path from "node:path";
import { exists, isSourceFile, readFileSafe, walk } from "../fs-utils.js";
import { hasDep, readPackageJson, type PackageJson } from "../package-json.js";
import { nodeInstallCommand } from "./detect-commands.js";
import { detectApiVarForSocket, detectDevProxyPaths, detectPageRoutes } from "./detect-routing.js";

export interface DetectedFrontend {
  framework: string;
  buildCommand?: string;
  buildScript: string;
  outputDir?: string;
  /** A static Nuxt/SvelteKit site that serves every page from one fallback file. */
  staticSpa?: boolean;
  isSSR: boolean;
  apiBaseUrlEnvVar?: string;
  /**
   * True when the code adds "/api" itself after the API variable
   * (`${VITE_API_URL}/api/users`): the variable is then an origin, so the
   * deployed value is "" (same origin), not "/api".
   */
  apiBaseUrlAppendsApi: boolean;
  hardcodedLocalhostUrls: string[];
  /**
   * Origins like "http://localhost:5000" the production code calls -- the
   * backend in local development. AutoInfra rewrites them to same-origin
   * relative URLs in the build (never in the repo).
   */
  localhostApiOrigins: string[];
  devProxyPaths: string[];
  apiBaseUrlForSocket: boolean;
  pageRoutes: string[];
  installCommand?: string;
}

const API_ENV_VAR_PATTERNS: Array<{ regex: RegExp; convention: string }> = [
  { regex: /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g, convention: "VITE_API_URL" },
  { regex: /process\.env\.(VUE_APP_[A-Z0-9_]+)/g, convention: "VUE_APP_API_URL" },
  { regex: /process\.env\.(REACT_APP_[A-Z0-9_]+)/g, convention: "REACT_APP_API_URL" },
  { regex: /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g, convention: "NEXT_PUBLIC_API_URL" },
];

function detectFramework(pkg: PackageJson | null, root: string): string | null {
  if (!pkg) return exists(root, "index.html") ? "static" : null;
  if (hasDep(pkg, "next")) return "next";
  if (hasDep(pkg, "nuxt")) return "nuxt";
  if (hasDep(pkg, "@sveltejs/kit")) return "sveltekit";
  if (hasDep(pkg, "@angular/core")) return "angular";
  if (hasDep(pkg, "vue")) return "vue";
  if (hasDep(pkg, "svelte") && hasDep(pkg, "vite")) return "svelte-vite";
  if (hasDep(pkg, "react")) {
    if (hasDep(pkg, "vite")) return "react-vite";
    if (hasDep(pkg, "react-scripts")) return "cra";
    return "react";
  }
  if (exists(root, "index.html")) return "static";
  return null;
}

function readConfig(root: string, base: string): string {
  for (const ext of ["ts", "js", "mjs", "cjs"]) {
    const content = readFileSafe(path.join(root, `${base}.${ext}`));
    if (content) return content;
  }
  return "";
}

/**
 * How a Nuxt or SvelteKit app is built when it's a static site, or null
 * when it needs its server. Nuxt is static when its build runs `nuxt
 * generate`, or it turns SSR off and has a generate script; SvelteKit when
 * it uses adapter-static (pages in its `pages` folder, "build" by default).
 */
function staticBuild(
  framework: string,
  root: string,
  pkg: PackageJson | null,
): { script: string; outputDir: string; spa: boolean } | null {
  if (framework === "nuxt") {
    const scripts = pkg?.scripts ?? {};
    if (/\bnux[ti]\s+generate\b/.test(scripts.build ?? ""))
      return { script: "build", outputDir: ".output/public", spa: false };
    const config = readConfig(root, "nuxt.config");
    const noSsr = /\bssr\s*:\s*false\b/.test(config);
    if (noSsr && /\bnux[ti]\s+generate\b/.test(scripts.generate ?? ""))
      return { script: "generate", outputDir: ".output/public", spa: true };
    return null;
  }
  if (framework === "sveltekit") {
    const config = readConfig(root, "svelte.config");
    if (!/@sveltejs\/adapter-static/.test(config)) return null;
    const pages = config.match(/\bpages\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    return {
      script: "build",
      outputDir: (pages ?? "build").replace(/^\.\//, ""),
      spa: /\bfallback\s*:\s*["'`]/.test(config),
    };
  }
  return null;
}

function defaultOutputDir(framework: string, isSSR: boolean): string | undefined {
  switch (framework) {
    case "react-vite":
    case "vue":
    case "svelte-vite":
    case "react":
      return "dist";
    case "cra":
      return "build";
    case "next":
      return isSSR ? ".next" : "out";
    case "angular":
      return "dist";
    default:
      return undefined;
  }
}

function detectIsSSR(framework: string, root: string, pkg: PackageJson | null): boolean {
  if (framework === "nuxt" || framework === "sveltekit") return !staticBuild(framework, root, pkg);
  if (framework !== "next") return false;
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    const content = readFileSafe(path.join(root, name));
    if (content && /output\s*:\s*["']export["']/.test(content)) return false;
  }
  return true;
}

/** Public build-time variables that hold the backend's address. */
const API_VAR_NAME = /(API|BACKEND|SERVER)(_BASE)?(_URL|_URI|_HOST|_ORIGIN|_ENDPOINT)?$|BASE_URL$/;

function detectApiBaseUrlEnvVar(root: string, framework: string): string | undefined {
  const files = walk(root).filter((f) => isSourceFile(f.relPath));
  for (const file of files) {
    const content = readFileSafe(file.absPath);
    if (!content) continue;
    for (const { regex } of API_ENV_VAR_PATTERNS) {
      // Only names that look like the backend address: VITE_FIREBASE_KEY is
      // a public variable too, and must never be overwritten with "/api".
      for (const match of content.matchAll(regex)) {
        if (API_VAR_NAME.test(match[1]!)) return match[1];
      }
    }
  }
  const fallback: Record<string, string> = {
    "react-vite": "VITE_API_URL",
    "svelte-vite": "VITE_API_URL",
    vue: "VITE_API_URL",
    cra: "REACT_APP_API_URL",
    next: "NEXT_PUBLIC_API_URL",
  };
  return fallback[framework];
}

/** Dev-server and test config: localhost there never reaches the production build. */
const DEV_ONLY_FILE =
  /(^|\/)(vite|vitest|webpack\.dev|jest|playwright|cypress)\.config\.[cm]?[jt]s$|(^|\/)setupProxy\.js$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?|e2e)\//;

export function detectHardcodedLocalhostUrls(root: string): string[] {
  // ws:// too: a WebSocket client (new WebSocket("ws://localhost:5000")).
  const pattern = /(?:https?|wss?):\/\/(localhost|127\.0\.0\.1)(:\d+)?/g;
  const matches = new Set<string>();
  // .html too: a plain static site calls its backend from inline scripts.
  const files = walk(root).filter(
    (f) =>
      (isSourceFile(f.relPath) || f.relPath.endsWith(".html")) &&
      !DEV_ONLY_FILE.test(f.relPath.split("\\").join("/")),
  );
  for (const file of files) {
    const content = readFileSafe(file.absPath);
    if (!content) continue;
    for (const m of content.matchAll(pattern)) {
      matches.add(`${file.relPath}: ${m[0]}`);
    }
  }
  return [...matches];
}

/** Dev-server ports of the frontend tools themselves -- never the backend. */
const FRONTEND_DEV_PORTS = new Set(["3000", "4200", "5173", "5174", "4173", "8080"]);

/** "src/api.js: http://localhost:5000" -> "http://localhost:5000" for backend-looking ports. */
export function localhostApiOriginsFrom(urls: string[], backendPort?: number): string[] {
  const origins = new Set<string>();
  for (const entry of urls) {
    const url = entry.slice(entry.lastIndexOf(": ") + 2);
    const port = url.match(/:(\d+)$/)?.[1];
    if (!port) continue;
    if (backendPort ? port === String(backendPort) : !FRONTEND_DEV_PORTS.has(port))
      origins.add(url);
  }
  return [...origins].sort();
}

function detectAppendsApi(root: string, envVar: string | undefined): boolean {
  // Env var names are [A-Z0-9_] only: safe to splice into a pattern as-is.
  if (!envVar || !/^\w+$/.test(envVar)) return false;
  // `${import.meta.env.VITE_API_URL}/api/...` or VITE_API_URL + "/api" (not a `|| "/api"` fallback)
  const direct = new RegExp(envVar + String.raw`(?:\}|\s*\+\s*["'${"`"}])/api`);
  // const API = import.meta.env.VITE_API_URL || "..."; ... `${API}/api/...`
  const viaConst = new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*[^\n;]*` + envVar);
  for (const file of walk(root).filter((f) => isSourceFile(f.relPath))) {
    const content = readFileSafe(file.absPath);
    if (!content || !content.includes(envVar)) continue;
    if (direct.test(content)) return true;
    const name = content.match(viaConst)?.[1];
    if (
      name &&
      new RegExp(
        String.raw`\$\{` +
          name +
          String.raw`\}/api\b|\b` +
          name +
          String.raw`\s*\+\s*["'${"`"}]/api\b`,
      ).test(content)
    )
      return true;
  }
  return false;
}

export function detectFrontend(
  root: string,
  repoRoot: string = root,
  backendPort?: number,
): DetectedFrontend | null {
  const pkg = readPackageJson(root);
  const framework = detectFramework(pkg, root);
  if (!framework) return null;

  const isSSR = detectIsSSR(framework, root, pkg);
  const staticSite = isSSR ? null : staticBuild(framework, root, pkg);
  const apiBaseUrlEnvVar = detectApiBaseUrlEnvVar(root, framework);
  const hardcodedLocalhostUrls = detectHardcodedLocalhostUrls(root);
  const buildScript = staticSite?.script ?? "build";
  return {
    framework,
    buildCommand: pkg?.scripts?.[buildScript],
    buildScript,
    outputDir: staticSite?.outputDir ?? defaultOutputDir(framework, isSSR),
    staticSpa: staticSite?.spa,
    isSSR,
    apiBaseUrlEnvVar,
    apiBaseUrlAppendsApi: detectAppendsApi(root, apiBaseUrlEnvVar),
    hardcodedLocalhostUrls,
    localhostApiOrigins: localhostApiOriginsFrom(hardcodedLocalhostUrls, backendPort),
    devProxyPaths: detectDevProxyPaths(root, pkg),
    apiBaseUrlForSocket: detectApiVarForSocket(root, apiBaseUrlEnvVar),
    pageRoutes: detectPageRoutes(root, framework),
    installCommand: pkg ? nodeInstallCommand(root, repoRoot) : undefined,
  };
}
