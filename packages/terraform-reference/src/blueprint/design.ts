import {
  backendRouting,
  cacheOnInstance,
  type ArchitectureComponent,
  type ArchitecturePlan,
  type RepoProfile,
} from "@autoinfra/shared";

type Pattern = "F1" | "F2" | "F3";

export interface BlueprintDesignOptions {
  pattern: Pattern;
  instanceType: string;
  /** Normalized, e.g. "/api". */
  apiPathPrefix: string;
}

const FRAMEWORK_NAMES: Record<string, string> = {
  "react-vite": "React (Vite)",
  cra: "React (Create React App)",
  react: "React",
  vue: "Vue",
  angular: "Angular",
  "svelte-vite": "Svelte",
  next: "Next.js",
  nuxt: "Nuxt",
  sveltekit: "SvelteKit",
  static: "static HTML",
  express: "Express",
  fastify: "Fastify",
  nestjs: "NestJS",
  koa: "Koa",
  hapi: "hapi",
  hono: "Hono",
  restify: "Restify",
  "node-http": "Node.js",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
};

const DB_NAMES: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongo: "MongoDB",
  redis: "Redis",
  dynamodb: "DynamoDB",
  sqlite: "SQLite",
};

const name = (key: string | undefined) => (key ? (FRAMEWORK_NAMES[key] ?? key) : "");

function component(
  service: string,
  componentName: string,
  purpose: string,
  extra: Partial<ArchitectureComponent> = {},
): ArchitectureComponent {
  return { service, name: componentName, purpose, ...extra };
}

/**
 * The architecture for a repo the blueprints deploy, stated the same way a
 * Gemini design is (the review screen and the Free Tier evaluator read
 * either), but derived only from the scan and the template that will be
 * used -- the components listed are exactly what the Terraform creates.
 */
export function designBlueprint(
  profile: RepoProfile,
  opts: BlueprintDesignOptions,
): ArchitecturePlan {
  const fe = profile.frontend;
  const be = profile.backend;
  const { pattern } = opts;
  const db = profile.database;
  const dbOnInstance =
    pattern === "F2" &&
    !profile.databaseExternal &&
    ["postgres", "mysql", "mongo", "redis"].includes(db);
  const ssr = Boolean(fe?.isSSR);

  const components: ArchitectureComponent[] = [
    component(
      "aws_cloudfront_distribution",
      "cdn",
      ssr || !fe
        ? "HTTPS entry point; every request goes to the app"
        : `HTTPS entry point; serves the frontend from S3${be ? ` and routes ${opts.apiPathPrefix}/* to the backend` : ""}`,
    ),
    component(
      "aws_s3_bucket",
      "frontend",
      ssr || !fe
        ? "private bucket (kept for the frontend_bucket output)"
        : "private bucket holding the built frontend (CloudFront OAC only)",
    ),
    component("aws_s3_bucket", "artifacts", "build source and deploy files (7-day expiry)"),
    component("aws_codebuild_project", "build", "builds and deploys each commit"),
    component("aws_cloudwatch_log_group", "build_logs", "build logs", { logRetentionDays: 7 }),
    component("aws_iam_role", "codebuild", "least-privilege build role"),
  ];
  if (pattern === "F1") {
    components.push(
      component(
        "aws_lambda_function",
        "api",
        `${name(be?.framework)} backend, unchanged, behind the Lambda Web Adapter`,
      ),
      component("aws_lambda_function_url", "api_url", "CloudFront origin for the API"),
      component("aws_cloudwatch_log_group", "api_logs", "backend logs", { logRetentionDays: 7 }),
      component("aws_iam_role", "lambda", "reads only this deployment's env vars in SSM"),
    );
    if (db === "dynamodb")
      components.push(
        component("aws_dynamodb_table", "data", "on-demand table (pk/sk), name in TABLE_NAME"),
      );
  }
  if (pattern === "F2") {
    const containers = [
      be && `${name(be.framework) || be.language} backend`,
      ssr && `${name(fe?.framework)} server`,
      dbOnInstance && DB_NAMES[db],
      cacheOnInstance(profile, pattern) && "Redis (cache, sessions, queues)",
    ].filter(Boolean);
    components.push(
      component("aws_vpc", "vpc", "small dedicated network, public subnet only (no NAT Gateway)"),
      component("aws_subnet", "public", "the instance's subnet"),
      component("aws_internet_gateway", "igw", "internet access without a NAT Gateway"),
      component(
        "aws_security_group",
        "app",
        "allows only CloudFront's origin-facing addresses in; no SSH",
      ),
      component("aws_instance", "app", `Docker Compose: Caddy + ${containers.join(" + ")}`, {
        instanceType: opts.instanceType,
        storageGb: 20,
      }),
      component("aws_eip", "app", "stable origin address, always attached"),
      component("aws_ecr_repository", "app", "private images, last deploys kept"),
      component(
        "aws_iam_role",
        "app",
        "SSM access instead of SSH; reads this deployment's env vars",
      ),
      component(
        "aws_ssm_parameter",
        "origin_secret",
        "secret header that proves a request came through CloudFront",
      ),
    );
    if (dbOnInstance)
      components.push(
        component("aws_ssm_parameter", "db_password", `generated ${DB_NAMES[db]} password`),
      );
  }

  const parts: string[] = [];
  if (fe)
    parts.push(
      ssr
        ? `${name(fe.framework)} server-rendered on the instance`
        : `${name(fe.framework)} frontend on S3 + CloudFront`,
    );
  if (be)
    parts.push(
      pattern === "F1"
        ? `${name(be.framework)} API on AWS Lambda`
        : `${name(be.framework) || be.language} API in Docker on one ${opts.instanceType} EC2 instance`,
    );
  if (db !== "none") {
    parts.push(
      profile.databaseExternal
        ? `${DB_NAMES[db] ?? db} hosted outside AWS (your connection settings)`
        : dbOnInstance
          ? `${DB_NAMES[db]} in a container on the same instance`
          : `${DB_NAMES[db] ?? db}`,
    );
  }
  const summary = `${parts.join("; ")}. Same-origin routing through one CloudFront distribution${be && fe ? ` (${opts.apiPathPrefix}/* goes to the backend)` : ""}.`;

  const risks: string[] = [];
  if (pattern === "F1") {
    risks.push("Cold starts: the first request after a few idle minutes takes 1-3 s longer.");
    risks.push("Requests must finish within about 30 s (CloudFront's limit for Lambda).");
    if (be?.hasMutatingRoutes)
      risks.push(
        "The Lambda Function URL is public behind CloudFront (needed for browser POST/PUT); the app's own auth protects it.",
      );
  }
  if (pattern === "F2") {
    risks.push(
      "One t3.micro-class instance (1 GB RAM + 1 GB swap) runs everything; heavy traffic or memory-hungry apps can slow it down.",
    );
    risks.push("Single instance: no automatic failover if it stops.");
    if (dbOnInstance)
      risks.push(
        `${DB_NAMES[db]} runs on the instance's disk: it is backed up to the artifacts bucket daily and before each deploy (kept 7 days), but restoring a backup is manual.`,
      );
  }
  if (profile.databaseExternal)
    risks.push(
      `The ${DB_NAMES[db] ?? db} provider must accept connections from anywhere; AWS gives the app no fixed outbound IP.`,
    );
  if (be?.hasLocalDiskPersistence)
    risks.push(
      "The backend writes local files (uploads, SQLite); they are lost when the app is redeployed.",
    );
  if (profile.secretsDetected.length)
    risks.push(
      `${profile.secretsDetected.length} possible secret(s) are committed to the repository; rotate them.`,
    );
  if (fe?.localhostApiOrigins.length)
    risks.push(
      `The frontend calls ${fe.localhostApiOrigins.join(", ")}; AutoInfra rewrites it to this deployment's URL in the build (your repo is unchanged).`,
    );

  const assumptions: string[] = [];
  if (be) {
    assumptions.push(
      `The backend in "${be.rootDir}" listens on ${be.port ? `port ${be.port}` : "$PORT"}; AutoInfra sets PORT to match.`,
    );
    if (be.runCommand) assumptions.push(`It starts with: ${be.runCommand}`);
    else if (be.dockerfile) assumptions.push(`It starts as its own ${be.dockerfile} defines.`);
    else if (be.language === "go")
      assumptions.push(
        `AutoInfra builds ${be.goMainPackage ?? "."} with go build into a small image.`,
      );
    else if (be.language === "java")
      assumptions.push(
        `AutoInfra builds the jar with ${be.javaBuildTool === "maven" ? "Maven" : "Gradle"} and runs it on Java 21 (SERVER_PORT is set to match).`,
      );
    else assumptions.push("It starts with: npm start");
    assumptions.push(
      be.apiRoutePrefix
        ? `Its routes start with ${be.apiRoutePrefix}.`
        : fe
          ? `Its routes don't start with ${opts.apiPathPrefix}, so ${opts.apiPathPrefix} is removed before requests reach it.`
          : "It receives request paths unchanged.",
    );
  }
  if (fe && be && fe.apiBaseUrlEnvVar)
    assumptions.push(
      `The frontend reads the API address from ${fe.apiBaseUrlEnvVar}; AutoInfra sets it to this deployment's URL at build time.`,
    );
  const routing = backendRouting(profile, opts.apiPathPrefix);
  if (routing.backendPaths.length)
    assumptions.push(
      `The backend also answers ${routing.backendPaths.join(", ")} (outside ${opts.apiPathPrefix}); those paths go to it unchanged.`,
    );
  if (routing.pageConflicts.length)
    risks.push(
      `The backend has routes at ${routing.pageConflicts.join(", ")}, but the frontend has pages there too; the pages win. The frontend reaches those backend routes only through ${opts.apiPathPrefix}${routing.stripPrefix ? "" : " (if they are mounted there)"}.`,
    );
  if (routing.droppedPaths.length)
    risks.push(
      `Only ${routing.backendPaths.length} backend paths outside ${opts.apiPathPrefix} can be routed (CloudFront's limit); ${routing.droppedPaths.join(", ")} would reach the frontend instead.`,
    );
  if (db === "dynamodb")
    assumptions.push("The app reads its table name from TABLE_NAME and uses string keys pk/sk.");
  if (profile.databaseHostedAt)
    assumptions.push(
      `The repo's env template points the ${DB_NAMES[db] ?? db} database at ${profile.databaseHostedAt}, so the app keeps using it there: AutoInfra creates no database and asks for its connection settings.`,
    );
  if (profile.databaseInitScripts.length && dbOnInstance)
    assumptions.push(
      `A new database is created from ${profile.databaseInitScripts.join(", ")} (only when it is empty).`,
    );
  if (profile.databaseSetup.length) {
    const steps = profile.databaseSetup.map((s) =>
      s.kind === "sql" ? s.path : `${s.command}${s.once ? "" : " (every deploy)"}`,
    );
    if (pattern === "F2")
      assumptions.push(
        `Before each deploy starts the app, AutoInfra runs: ${steps.join("; ")}. One-time steps are remembered.`,
      );
    else
      risks.push(
        `The app's database setup (${steps.join("; ")}) isn't run on Lambda; run it against your database yourself.`,
      );
  }
  if (profile.seedScripts.length)
    assumptions.push(
      `Sample-data scripts (${profile.seedScripts.join(", ")}) are not run: they would add test users and data.`,
    );

  const n = (id: string, label: string) => `${id}["${label.replace(/"/g, "'")}"]`;
  const lines = ["flowchart LR", `  ${n("U", "Browser")} --> ${n("CF", "CloudFront (HTTPS)")}`];
  if (fe && !ssr) lines.push(`  CF -->|"pages"| ${n("S3", `S3: ${name(fe.framework)} build`)}`);
  const apiPaths = [`${opts.apiPathPrefix}/*`, ...routing.backendPaths].join(", ");
  if (pattern === "F1")
    lines.push(`  CF -->|"${apiPaths}"| ${n("L", `Lambda: ${name(be?.framework)}`)}`);
  if (pattern === "F2") {
    lines.push(`  CF -->|"${ssr || !fe ? "all paths" : apiPaths}"| ${n("C", "EC2: Caddy")}`);
    if (be) lines.push(`  C --> ${n("A", `${name(be.framework) || be.language} API`)}`);
    if (ssr) lines.push(`  C --> ${n("W", `${name(fe?.framework)} server`)}`);
    if (dbOnInstance) lines.push(`  ${be ? "A" : "W"} --> ${n("D", DB_NAMES[db]!)}`);
  }
  if (profile.databaseExternal)
    lines.push(
      `  ${pattern === "F1" ? "L" : "A"} --> ${n("X", `${DB_NAMES[db] ?? db} (outside AWS)`)}`,
    );
  if (pattern === "F1" && db === "dynamodb") lines.push(`  L --> ${n("D", "DynamoDB")}`);
  lines.push(`  ${n("B", "CodeBuild")} -.->|"deploys"| CF`);

  return {
    pattern,
    summary,
    components,
    routing: { apiPathPrefix: opts.apiPathPrefix },
    envMapping: profile.envVars.map((v) => ({ name: v.name, isSecret: v.isSecret })),
    risks,
    assumptions,
    mermaidDiagram: lines.join("\n"),
    draftFreeTierAssessment:
      pattern === "F2"
        ? "Uses one Free-Tier-eligible instance (750 hours/month covers one always-on instance per account), one attached Elastic IP, and storage within the 30 GB EBS allowance. AutoInfra re-checks the real plan before you approve."
        : "Uses only always-free or Free-Tier services (CloudFront, S3, CodeBuild minutes" +
          (pattern === "F1" ? ", Lambda requests" : "") +
          "). AutoInfra re-checks the real plan before you approve.",
  };
}
