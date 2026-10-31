import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendRouting,
  cacheOnInstance,
  type RepoProfile,
  type TerraformFile,
} from "@autoinfra/shared";
import { renderTemplate, type TemplateContext } from "./template.js";
import { INSTANCE_DATABASES, renderCompose, type InstanceDatabase } from "./compose.js";

export { renderTemplate } from "./template.js";
export * from "./compose.js";

type Pattern = "F1" | "F2" | "F3";

const BLUEPRINT_ROOT = path.resolve(fileURLToPath(new URL("../../blueprints", import.meta.url)));

function load(rel: string): string {
  return fs.readFileSync(path.join(BLUEPRINT_ROOT, rel), "utf8").replaceAll("\r\n", "\n");
}

/** Frameworks whose build output is a static site the blueprints know how to publish. */
const STATIC_FRAMEWORKS = new Set([
  "react-vite",
  "cra",
  "react",
  "vue",
  "angular",
  "svelte-vite",
  "static",
  // Only without their server (isSSR false): Next.js with output: "export",
  // Nuxt built with `nuxt generate`, SvelteKit with adapter-static.
  "next",
  "nuxt",
  "sveltekit",
]);

/** Frontends whose server .autoinfra/Dockerfile.web knows how to build and start. */
export const SERVER_FRAMEWORKS = new Set(["next", "nuxt", "sveltekit"]);

export type BlueprintDecision =
  { supported: true; pattern: Pattern } | { supported: false; reason: string };

/**
 * Which pattern AutoInfra's own blueprints deploy this repo with -- or why
 * they can't (then Gemini designs it, as before). Only shapes the
 * blueprints were built and tested for are claimed.
 */
export function blueprintFor(profile: RepoProfile): BlueprintDecision {
  const fe = profile.frontend;
  const be = profile.backend;
  if (profile.unsupportedReasons.length)
    return { supported: false, reason: profile.unsupportedReasons.join(" ") };
  if (!fe && !be)
    return { supported: false, reason: "no frontend or backend was recognised in the repository" };

  if (fe) {
    const known = fe.isSSR ? SERVER_FRAMEWORKS : STATIC_FRAMEWORKS;
    if (!known.has(fe.framework))
      return {
        supported: false,
        reason: `the ${fe.framework} frontend${fe.isSSR ? " with server-side rendering" : ""} has no blueprint yet`,
      };
  }

  if (be) {
    // Go and Java (Spring Boot) get a generated Dockerfile; other languages bring their own.
    const generated =
      (be.language === "go" && Boolean(be.goMainPackage)) ||
      (be.language === "java" && Boolean(be.javaBuildTool));
    const runnable =
      Boolean(be.runCommand) ||
      Boolean(be.dockerfile) ||
      generated ||
      (be.language === "node" && Boolean(be.startCommand));
    if (!runnable)
      return {
        supported: false,
        reason:
          be.language === "node" || be.language === "python"
            ? `couldn't work out how to start the ${be.language} backend (no start script, Procfile or Dockerfile)`
            : `a ${be.language === "container" ? "" : `${be.language} `}backend needs its own Dockerfile (add one at ${be.rootDir}/Dockerfile)`,
      };
  }

  // A server-rendered frontend needs a host for its server.
  if (fe?.isSSR) return { supported: true, pattern: "F2" };
  if (!be) return { supported: true, pattern: "F3" };

  const lambdaOk =
    profile.recommendedPattern === "F1" &&
    be.lambdaCompatible &&
    Boolean(be.runCommand) &&
    (be.language === "node" || be.language === "python");
  return { supported: true, pattern: lambdaOk ? "F1" : "F2" };
}

function instanceDatabase(profile: RepoProfile, pattern: Pattern): InstanceDatabase | undefined {
  // The database serves whichever container runs server code: the backend,
  // or a frontend's server with its own API routes.
  if (pattern !== "F2" || profile.databaseExternal) return undefined;
  if (!profile.backend && !profile.frontend?.isSSR) return undefined;
  return (INSTANCE_DATABASES as readonly string[]).includes(profile.database)
    ? (profile.database as InstanceDatabase)
    : undefined;
}

/** How a page path is mapped to a file in the bucket. */
function pagesMode(profile: RepoProfile): "spa" | "html" | "dir" {
  const fw = profile.frontend?.framework;
  if (profile.frontend?.staticSpa) return "spa";
  if (fw === "next" || fw === "sveltekit") return "html"; // prerendered: /about -> about.html
  if (fw === "static" || fw === "nuxt") return "dir"; // /about -> about/index.html
  return "spa"; // client-side routing: every page is index.html
}

/** The package manager's own way to run the build script. */
function runScript(install: string | undefined, script: string): string {
  if (install?.includes("pnpm")) return `pnpm run ${script}`;
  if (install?.includes("yarn")) return `yarn ${script}`;
  return `npm run ${script}`;
}

const yaml = (value: string) => JSON.stringify(value);

export interface BlueprintInput {
  profile: RepoProfile;
  pattern: Pattern;
  /** Normalized, e.g. "/api" (tfvars.api_path_prefix). */
  apiPathPrefix: string;
  /** tfvars.app_port. */
  appPort: number;
}

/** Everything the templates branch on, derived only from the scan. */
export function blueprintContext(input: BlueprintInput): TemplateContext {
  const { profile, pattern, apiPathPrefix } = input;
  const fe = profile.frontend;
  const be = profile.backend;
  const ssr = Boolean(fe?.isSSR);
  const staticFrontend = Boolean(fe) && !ssr;
  const db = instanceDatabase(profile, pattern);
  const routing = backendRouting(profile, apiPathPrefix);
  const strip = routing.stripPrefix;
  const backendPaths = routing.backendPaths;
  const pages = pagesMode(profile);
  const python = be?.language === "python";
  const feBuild =
    fe?.buildCommand && fe.framework !== "static"
      ? runScript(fe.installCommand, fe.buildScript ?? "build")
      : "";
  const beBuild =
    be?.language === "node" && be.buildCommand ? runScript(be.installCommand, "build") : "";

  return {
    F1: pattern === "F1",
    F2: pattern === "F2",
    F3: pattern === "F3",
    HAS_FRONTEND: Boolean(fe),
    STATIC_FRONTEND: staticFrontend,
    SSR_FRONTEND: ssr,
    WEB_FRAMEWORK: ssr ? (fe?.framework ?? "") : "",
    HAS_BACKEND: Boolean(be),
    DEFAULT_S3: staticFrontend,
    PAGES_SPA: pages === "spa",
    PAGES_HTML: pages === "html",
    PAGES_DIR: pages === "dir",
    PAGE_REWRITE_NOTE:
      pages === "spa"
        ? "single-page app, every page is index.html"
        : pages === "html"
          ? "static export, /about is about.html"
          : "static site, /about is about/index.html",
    STRIP_AT_EDGE: strip && pattern === "F1",
    STRIP_IN_CADDY: strip && pattern === "F2",
    API_PREFIX: apiPathPrefix,
    // Backend paths outside the prefix (socket.io, /uploads, /auth...): CloudFront
    // sends them to the app when pages come from S3, Caddy when they come from
    // the Next.js server.
    EDGE_BACKEND_PATHS: staticFrontend && backendPaths.length > 0,
    CADDY_BACKEND_PATHS: ssr && Boolean(be) && backendPaths.length > 0,
    BACKEND_PATHS_HCL: JSON.stringify(backendPaths),
    BACKEND_PATHS_CADDY: backendPaths.map((p) => `${p} ${p}/*`).join(" "),
    BACKEND_PATHS_NOTE: backendPaths.join(", "),
    DB_ON_INSTANCE: Boolean(db),
    DB_KIND: profile.database,
    DYNAMODB: pattern === "F1" && profile.database === "dynamodb",
    PYTHON: python,
    PYTHON_LAMBDA: pattern === "F1" && python,
    LAMBDA_RUNTIME: python ? "python3.12" : "nodejs22.x",
    ECR_KEEP: ssr ? 4 : 2,
    BUILD_TIMEOUT: pattern === "F2" ? 45 : 30,
    PRIVILEGED: pattern === "F2" ? "true # docker build" : "false",
    BE_DOCKERFILE: be?.dockerfile ?? ".autoinfra/Dockerfile",
    // The repo's own Dockerfile: the stage its compose file builds, not the last one.
    BE_DOCKER_TARGET:
      be?.dockerfile && be.dockerTarget && /^[A-Za-z0-9._-]+$/.test(be.dockerTarget)
        ? ` --target ${be.dockerTarget}`
        : "",
    // buildspec env (YAML-quoted)
    FE_DIR_YAML: yaml(fe?.rootDir ?? "."),
    FE_INSTALL_YAML: yaml(fe?.installCommand ?? ""),
    FE_BUILD_YAML: yaml(feBuild),
    FE_OUT_YAML: yaml(fe?.outputDir && !ssr ? fe.outputDir : ""),
    API_VAR_YAML: yaml(fe && be ? (fe.apiBaseUrlEnvVar ?? "") : ""),
    // The variable holds an origin when the code appends /api itself (the
    // edge then strips /api again if the backend's routes lack it) or hands
    // it to socket.io.
    API_SUFFIX_YAML: yaml(routing.apiVarSuffix),
    LOCALHOST_ORIGINS_YAML: yaml(be ? (fe?.localhostApiOrigins ?? []).join(" ") : ""),
    LOCALHOST_SUFFIX_YAML: yaml(routing.localhostSuffix),
    WS_SUFFIX_YAML: yaml(routing.webSocketSuffix),
    PAGES_YAML: yaml(pages),
    BE_DIR_YAML: yaml(be?.rootDir ?? "."),
    BE_PORT_YAML: yaml(String(be?.port ?? "")),
    BE_LOCALHOST: Boolean(be?.localhostOrigins.length),
    BE_LOCALHOST_ORIGINS_YAML: yaml((be?.localhostOrigins ?? []).join(" ")),
    BE_LANG_YAML: yaml(be?.language ?? ""),
    BE_INSTALL_YAML: yaml(be?.installCommand ?? ""),
    BE_BUILD_YAML: yaml(beBuild),
    RUNTIME_NEEDS_YAML: yaml(be?.runtimeNeeds ?? ""),
    INIT_SCRIPT_UPLOADS: db
      ? profile.databaseInitScripts
          .map(
            (script, i) =>
              `      - aws s3 cp ${yaml(script)} "s3://$ARTIFACTS_BUCKET/deploy/initdb/${String(i + 1).padStart(2, "0")}-${path.posix.basename(script)}"`,
          )
          .join("\n")
      : "",
    SETUP_UPLOADS: setupUploads(profile, pattern),
  };
}

/** Migration SQL files are uploaded under this name (order kept, names unique). */
function migrationFileName(index: number, repoPath: string): string {
  return `migrations/${String(index + 1).padStart(3, "0")}-${path.posix.basename(repoPath)}`;
}

function setupUploads(profile: RepoProfile, pattern: Pattern): string {
  if (pattern !== "F2" || !profile.databaseSetup.length) return "";
  const lines = [
    `      - aws s3 cp .autoinfra/setup.sh "s3://$ARTIFACTS_BUCKET/deploy/setup.sh"`,
    `      - aws s3 cp .autoinfra/db-setup.sh "s3://$ARTIFACTS_BUCKET/deploy/db-setup.sh"`,
  ];
  profile.databaseSetup.forEach((step, i) => {
    if (step.kind === "sql")
      lines.push(
        `      - aws s3 cp ${yaml(step.path)} "s3://$ARTIFACTS_BUCKET/deploy/${migrationFileName(i, step.path)}"`,
      );
  });
  return lines.join("\n");
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * setup.sh for the instance: the app's own database setup, in order, before
 * the new version starts (see platform-app/db-setup.sh for the helpers).
 */
function renderSetup(profile: RepoProfile, pattern: Pattern): TerraformFile | null {
  if (pattern !== "F2" || !profile.databaseSetup.length) return null;
  const db = instanceDatabase(profile, pattern);
  const lines = [
    "#!/bin/bash",
    "# Generated by AutoInfra: the app's own database setup, run on the instance",
    "# before each deploy starts the new version. Seed scripts are never run.",
    "set -euo pipefail",
    `DB_KIND=${shellQuote(db ?? "external")}`,
    `DB_NAME=${shellQuote(profile.databaseName ?? "app")}`,
    `APP_SERVICE=${profile.backend ? "app" : "web"}`,
    ". ./db-setup.sh",
    "start_database",
  ];
  profile.databaseSetup.forEach((step, i) => {
    if (step.kind === "sql") {
      lines.push(
        `sql_once ${shellQuote(step.path)} ${shellQuote(migrationFileName(i, step.path))}`,
      );
    } else {
      lines.push(
        `${step.once ? "command_once" : "command_always"} ${shellQuote(step.path)} ${shellQuote(step.command ?? "")}`,
      );
    }
  });
  lines.push('echo "Database setup finished."');
  return { path: "app/setup.sh", content: `${lines.join("\n")}\n` };
}

/** A run command for Lambda/containers: python servers via `python -m`, so console scripts needn't be on PATH. */
function lambdaRunCommand(be: NonNullable<RepoProfile["backend"]>): string {
  const cmd = be.runCommand ?? "node index.js";
  return be.language === "python" ? cmd.replace(/^(uvicorn|gunicorn)\b/, "python3 -m $1") : cmd;
}

function backendDockerfile(profile: RepoProfile, appPort: number): TerraformFile | null {
  const be = profile.backend;
  if (!be || be.dockerfile) return null;
  if (be.language === "go" || be.language === "java") {
    const ctx: TemplateContext = {
      PORT: appPort,
      GO_MAIN_PACKAGE: be.goMainPackage ?? ".",
      MAVEN: be.javaBuildTool === "maven",
    };
    return {
      path: "app/Dockerfile",
      content: renderTemplate(load(`app/Dockerfile.${be.language}`), ctx, "Dockerfile"),
    };
  }
  const python = be.language === "python";
  const npm = !be.installCommand?.includes("yarn") && !be.installCommand?.includes("pnpm");
  const run =
    be.runCommand ??
    // A start script that isn't plain `node x` (e.g. `ts-node src/index.ts`) still works with npm.
    "npm start";
  // Migration tools (prisma, sequelize-cli, knex...) are usually dev
  // dependencies, and they run in this image before each deploy.
  const keepDevDeps =
    /\b(ts-node|tsx|nodemon|babel-node)\b/.test(run) ||
    run === "npm start" ||
    profile.databaseSetup.some((s) => /\bnpx\b|\b(npm|pnpm) run\b|\byarn\b/.test(s.command ?? ""));
  const ctx: TemplateContext = {
    INSTALL_COMMAND:
      be.installCommand ??
      (python ? "pip install --no-cache-dir -r requirements.txt" : "npm install"),
    BUILD_SCRIPT: !python && be.buildCommand ? runScript(be.installCommand, "build") : false,
    PRISMA_GENERATE: !python && be.usesPrisma,
    PRUNE: !python && npm && !keepDevDeps,
    RUNTIME_NEEDS: be.runtimeNeeds ?? false,
    PORT: appPort,
    RUN_COMMAND_JSON: JSON.stringify(python ? lambdaRunCommand(be) : run),
  };
  return {
    path: "app/Dockerfile",
    content: renderTemplate(
      load(`app/Dockerfile.${python ? "python" : "node"}`),
      ctx,
      "Dockerfile",
    ),
  };
}

/**
 * The complete Terraform project + app files for a supported repo, from
 * AutoInfra's tested templates -- no model involved. Same repo, same output.
 */
export function renderBlueprint(input: BlueprintInput): TerraformFile[] {
  const ctx = blueprintContext(input);
  const { profile, pattern } = input;
  const render = (rel: string, out = path.posix.basename(rel)) => ({
    path: out,
    content: renderTemplate(load(rel), ctx, rel),
  });

  const files: TerraformFile[] = [
    render("common/storage.tf"),
    render("common/cdn.tf"),
    render("common/build.tf"),
    render("common/outputs.tf"),
    render("app/buildspec.yml", "buildspec.yml"),
  ];
  if (pattern === "F1") {
    files.push(render("f1/compute.tf"), render("f1/iam.tf"));
    files.push({
      path: "app/run.sh",
      content: renderTemplate(
        load("app/run.sh"),
        { ...ctx, RUN_COMMAND: lambdaRunCommand(profile.backend!) },
        "run.sh",
      ),
    });
  }
  if (pattern === "F2") {
    files.push(render("f2/compute.tf"), render("f2/network.tf"), render("f2/iam.tf"));
    files.push(render("app/bootstrap.sh", "app/bootstrap.sh"));
    files.push(render("app/Caddyfile", "app/Caddyfile"));
    files.push({
      path: "app/docker-compose.yml",
      content: renderCompose({
        profile,
        hasBackend: Boolean(profile.backend),
        ssrFrontend: Boolean(profile.frontend?.isSSR),
        appPort: input.appPort,
        database: instanceDatabase(profile, pattern),
        databaseName: profile.databaseName ?? "app",
        hasInitScripts: profile.databaseInitScripts.length > 0,
        cache: cacheOnInstance(profile, pattern),
      }),
    });
    const dockerfile = backendDockerfile(profile, input.appPort);
    if (dockerfile) files.push(dockerfile);
    const setup = renderSetup(profile, pattern);
    if (setup) files.push(setup);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export { designBlueprint, type BlueprintDesignOptions } from "./design.js";
