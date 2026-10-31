import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  FreeTierReport,
  GateName,
  GateResult,
  PlanSummary,
  RepoProfile,
  TerraformBundle,
  TerraformFile,
} from "@autoinfra/shared";
import { EXTERNAL_DATABASE_PORTS, platformProvidedEnv } from "@autoinfra/shared";
import {
  checkPlanSecurity,
  checkStaticTerraform,
  planToResources,
  summarizePlan,
  type PlanJson,
  type SecurityPolicyContext,
} from "@autoinfra/terraform-policy";
import { evaluateFreeTier } from "@autoinfra/free-tier-policy";
import { loadPlatformFiles, PLATFORM_FILE_PATHS } from "@autoinfra/terraform-reference";
import { run, toolEnv, type AwsCredentials } from "./exec.js";
import { initWithRetry, isNetworkError, networkFailureMessage } from "./init.js";
import { resolveTool } from "./tools.js";
import { buildPlaceholderLambdaZip } from "./placeholder-zip.js";

export interface TfVars {
  region: string;
  deployment_id: string;
  owner: string;
  short_id: string;
  api_path_prefix: string;
  app_port: number;
  health_check_path: string;
  function_url_auth_type: "AWS_IAM" | "NONE";
  lambda_adapter_layer_arn: string;
  instance_type: string;
  instance_architecture: "x86_64" | "arm64";
}

export interface GauntletContext {
  bundle: TerraformBundle;
  pattern: "F1" | "F2" | "F3";
  tfvars: TfVars;
  freeTierMode: "strict" | "flexible";
  eligibleInstanceTypes: string[];
  existingAlwaysOnEc2Count: number;
  /** The scan, for checks against the repo's real layout. */
  profile?: RepoProfile;
  /**
   * The deployment's real Terraform state, once anything has been applied:
   * the pre-approval plan then shows changes against what exists (an
   * update in place), not a from-scratch create, so apply can match it.
   */
  stateBackend?: S3BackendConfig;
  /** Short-lived deploy-role credentials. Null skips plan + plan policies. */
  credentials: AwsCredentials | null;
  pluginCacheDir?: string;
  /** Waits between terraform init attempts after a network failure (default INIT_RETRY_DELAYS_MS). */
  initRetryDelaysMs?: number[];
  /** Called after each gate, for live progress/logging. */
  onGate?: (result: GateResult) => void | Promise<void>;
}

/**
 * The build has to run where the code actually is: a buildspec that never
 * touches the repo's frontend/backend folders builds nothing (or the wrong
 * thing) and only fails minutes into a real deploy.
 */
export function checkBuildspecLayout(
  buildspec: string,
  profile: RepoProfile | undefined,
  pattern: "F1" | "F2" | "F3",
): string[] {
  const errors: string[] = [];
  const mentions = (dir: string) =>
    new RegExp(
      `(^|[\\s"'=(/])${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|[\\s"';)]|$)`,
      "m",
    ).test(buildspec);
  const fe = profile?.frontend;
  if (fe && fe.rootDir !== "." && !mentions(fe.rootDir)) {
    errors.push(
      `buildspec.yml never uses the frontend folder "${fe.rootDir}": build it there (cd ${fe.rootDir} && npm ci && npm run build) and upload ${fe.rootDir}/${fe.outputDir ?? "dist"}`,
    );
  }
  const be = profile?.backend;
  if (be && pattern !== "F3" && be.rootDir !== "." && !mentions(be.rootDir)) {
    errors.push(
      `buildspec.yml never uses the backend folder "${be.rootDir}"${pattern === "F2" ? `: build the image with docker build -f ${be.dockerfile ?? ".autoinfra/Dockerfile"} ${be.rootDir}` : ""}`,
    );
  }
  return errors;
}

/**
 * The schema scripts create a specific database; a compose file that names a
 * different one leaves the app talking to an empty database.
 */
export function checkComposeDatabaseName(
  compose: string,
  profile: RepoProfile | undefined,
): string[] {
  const expected = profile?.databaseName;
  if (!expected) return [];
  const names = [
    ...compose.matchAll(
      /^\s*-?\s*(MYSQL_DATABASE|POSTGRES_DB|DB_NAME|DATABASE_NAME|DB_DATABASE)\s*[:=]\s*["']?([\w$]+)/gm,
    ),
  ];
  return names
    .filter(([, , value]) => value !== expected && !value!.startsWith("$"))
    .map(
      ([, key, value]) =>
        `app/docker-compose.yml sets ${key}=${value}, but the repo's schema scripts create the database "${expected}" -- use "${expected}"`,
    );
}

/**
 * deploy.sh copies the whole deploy/ prefix ("aws s3 cp --recursive" / "aws s3
 * sync"), which lists the bucket: the instance role needs s3:ListBucket, not
 * just s3:GetObject, or every rollout fails with AccessDenied.
 */
export function checkInstanceCanListArtifacts(files: ReadonlyArray<TerraformFile>): string[] {
  const bootstrap = files.find((f) => f.path === "app/bootstrap.sh")?.content ?? "";
  const listsBucket = /aws\s+s3\s+(cp\s[^\n]*--recursive|sync)\b/.test(bootstrap);
  const hcl = files
    .filter((f) => f.path.endsWith(".tf"))
    .map((f) => f.content)
    .join("\n");
  if (!listsBucket || /s3:ListBucket/.test(hcl)) return [];
  return [
    'app/bootstrap.sh copies the deploy/ folder recursively, so the instance role needs "s3:ListBucket" on the artifacts bucket (Condition StringLike s3:prefix = ["deploy/*"]) in addition to s3:GetObject on deploy/*',
  ];
}

/**
 * Env vars AutoInfra fills in (the live URL for CORS, NODE_ENV) reach the
 * container through .env; a literal in compose's environment: overrides
 * them (a real deploy shipped CLIENT_URL: "*" and every browser write failed
 * CORS).
 */
export function checkComposeKeepsPlatformEnv(
  compose: string,
  profile: RepoProfile | undefined,
  pattern: "F1" | "F2" | "F3",
): string[] {
  if (!profile) return [];
  const errors: string[] = [];
  for (const [name, how] of platformProvidedEnv(profile, pattern)) {
    // The frontend's API path is a build setting; database and Redis settings belong in compose.
    if (how === "api_path" || how === "database" || how === "cache") continue;
    const match = compose.match(new RegExp(`^\\s*-?\\s*${name}\\s*[:=]\\s*(.*)$`, "m"));
    if (match && !match[1]!.includes(`\${${name}}`)) {
      errors.push(
        `app/docker-compose.yml sets ${name} to ${match[1]!.trim()}; remove it -- AutoInfra sets ${name}${how === "live_url" ? " to the deployment's live URL" : ""} through .env, and a value here overrides it`,
      );
    }
  }
  return errors;
}

/**
 * Database settings a container image applies only on the FIRST start of an
 * empty volume (user, password, volume) must never vary between generations:
 * a renamed volume silently starts an empty database, and a new MYSQL_USER is
 * never created on an existing one (the app then can't log in). AutoInfra
 * fixes them: MySQL's root user, Postgres user "app", volume "dbdata".
 */
export function checkComposeDatabaseStability(
  compose: string,
  profile: RepoProfile | undefined,
): string[] {
  const db = profile?.database;
  if ((db !== "mysql" && db !== "postgres") || profile?.databaseExternal) return [];
  const errors: string[] = [];
  const dataDir = db === "mysql" ? "/var/lib/mysql" : "/var/lib/postgresql/data";
  if (!new RegExp(`dbdata:${dataDir.replace(/\//g, "\\/")}`).test(compose)) {
    errors.push(
      `the database container must keep its data in the named volume "dbdata" (- dbdata:${dataDir}); any other name starts an empty database on the next deploy`,
    );
  }
  const user = db === "mysql" ? "root" : "app";
  if (db === "mysql" && /^\s*MYSQL_USER\s*:/m.test(compose)) {
    errors.push(
      'remove MYSQL_USER/MYSQL_PASSWORD: MySQL creates that user only on an empty volume, so on an existing database the app could not log in -- the app connects as "root" with ${AUTOINFRA_DB_PASSWORD}',
    );
  }
  if (db === "postgres" && !/^\s*POSTGRES_USER\s*:\s*["']?app["']?\s*$/m.test(compose)) {
    errors.push("set POSTGRES_USER: app (fixed by AutoInfra so it never changes between deploys)");
  }
  for (const [, key, value] of compose.matchAll(
    /^\s*(DB_USER|DB_USERNAME|DATABASE_USER|MYSQL_USER|PGUSER)\s*:\s*["']?([\w$]+)/gm,
  )) {
    if (key !== "MYSQL_USER" && value !== user) {
      errors.push(`${key} must be "${user}" (the database user AutoInfra creates), not "${value}"`);
    }
  }
  return errors;
}

/**
 * A database hosted outside AWS: without an egress rule that covers the
 * database's port (or all traffic) the app can't connect; and a database
 * container would be an empty second copy the app might be pointed at
 * instead.
 */
export function checkExternalDatabaseAccess(
  files: ReadonlyArray<TerraformFile>,
  profile: RepoProfile | undefined,
  pattern: "F1" | "F2" | "F3",
): string[] {
  if (pattern !== "F2" || !profile?.databaseExternal) return [];
  const errors: string[] = [];
  const port = EXTERNAL_DATABASE_PORTS[profile.database];
  const hcl = files
    .filter((f) => f.path.endsWith(".tf"))
    .map((f) => f.content)
    .join("\n");
  const egressRules = [
    ...hcl.matchAll(/resource\s+"aws_vpc_security_group_egress_rule"\s+"[^"]+"\s*\{([^}]*)\}/g),
  ].map((m) => m[1]!);
  const opensPort = (body: string) => {
    if (/ip_protocol\s*=\s*"(-1|all)"/.test(body)) return true;
    const from = Number(body.match(/from_port\s*=\s*(\d+)/)?.[1]);
    const to = Number(body.match(/to_port\s*=\s*(\d+)/)?.[1]);
    return from <= port! && port! <= to;
  };
  if (port && !egressRules.some(opensPort)) {
    errors.push(
      `the app's ${profile.database} database is hosted outside AWS (port ${port}, or its provider's own): allow the instance out to it -- resource "aws_vpc_security_group_egress_rule" "all" (security_group_id = aws_security_group.app.id, cidr_ipv4 = "0.0.0.0/0", ip_protocol = "-1")`,
    );
  }
  const compose = files.find((f) => f.path === "app/docker-compose.yml")?.content ?? "";
  const dbImage = compose.match(/^\s*image:\s*["']?(mongo|postgres|mysql|mariadb|redis)[:"'\s]/m);
  if (dbImage) {
    errors.push(
      `app/docker-compose.yml runs a ${dbImage[1]} container, but the app's database is hosted outside AWS: remove it (and its volume); the app connects with the connection settings the owner entered`,
    );
  }
  return errors;
}

/**
 * A server-rendered frontend (Next.js SSR, middleware) has no index.html: its
 * build folder uploaded to S3 serves nothing (a real generation did exactly
 * that). On F2 it runs as the "web" container from AutoInfra's
 * Dockerfile.web, and CloudFront's default behavior goes to the instance.
 */
export function checkServerRenderedFrontend(
  files: ReadonlyArray<TerraformFile>,
  profile: RepoProfile | undefined,
  pattern: "F1" | "F2" | "F3",
): string[] {
  if (pattern !== "F2" || !profile?.frontend?.isSSR) return [];
  const errors: string[] = [];
  const content = (p: string) => files.find((f) => f.path === p)?.content ?? "";
  const buildspec = content("buildspec.yml");
  const hcl = files
    .filter((f) => f.path.endsWith(".tf"))
    .map((f) => f.content)
    .join("\n");

  if (!buildspec.includes(".autoinfra/Dockerfile.web") || !/WEB_IMAGE=/.test(buildspec)) {
    errors.push(
      `buildspec.yml must build the server-rendered frontend as an image with AutoInfra's .autoinfra/Dockerfile.web (docker build -f .autoinfra/Dockerfile.web ... ${profile.frontend.rootDir}), push it, and write WEB_IMAGE=... to image.env`,
    );
  }
  // Dockerfile.web defaults to Next.js; any other framework must say which.
  const framework = profile.frontend.framework;
  if (
    framework !== "next" &&
    buildspec.includes(".autoinfra/Dockerfile.web") &&
    !buildspec.includes(`AUTOINFRA_WEB_FRAMEWORK=${framework}`)
  ) {
    errors.push(
      `buildspec.yml must pass --build-arg AUTOINFRA_WEB_FRAMEWORK=${framework} to the Dockerfile.web build, or it is built and started as Next.js`,
    );
  }
  const s3Upload = buildspec
    .split(/\r?\n/)
    .find((l) => /aws\s+s3\s+(sync|cp)\b/.test(l) && /FRONTEND_BUCKET|\.next\b|\/out\b/.test(l));
  if (s3Upload) {
    errors.push(
      `buildspec.yml uploads the frontend to S3 (${s3Upload.trim()}), but a server-rendered frontend has no static site to upload -- remove it; the "web" container serves every page`,
    );
  }
  if (!content("app/docker-compose.yml").includes("${WEB_IMAGE}")) {
    errors.push(
      'app/docker-compose.yml needs a "web" service running image ${WEB_IMAGE} (the server-rendered frontend, PORT 3000)',
    );
  }
  if (!/reverse_proxy\s+web:3000\b/.test(content("app/Caddyfile"))) {
    errors.push(
      "app/Caddyfile must send every non-API path to the frontend: handle { reverse_proxy web:3000 } after the API handle",
    );
  }

  // Origins served from S3, then the default behavior's target and functions.
  const s3Origins = new Set<string>();
  const originStarts = [...hcl.matchAll(/\borigin\s*\{/g)].map((m) => m.index!);
  for (const [i, start] of originStarts.entries()) {
    const body = hcl.slice(start, originStarts[i + 1] ?? hcl.length);
    const id = body.match(/origin_id\s*=\s*"([^"]+)"/)?.[1];
    if (id && /bucket_regional_domain_name|\.s3\./.test(body.split(/default_cache_behavior/)[0]!)) {
      s3Origins.add(id);
    }
  }
  const defaultStart = hcl.search(/default_cache_behavior\s*\{/);
  if (defaultStart >= 0) {
    const rest = hcl.slice(defaultStart);
    const end = rest.search(/\n\s*(ordered_cache_behavior|restrictions|viewer_certificate)\s*\{/);
    const block = end > 0 ? rest.slice(0, end) : rest;
    const target = block.match(/target_origin_id\s*=\s*"([^"]+)"/)?.[1];
    if (target && s3Origins.has(target)) {
      errors.push(
        `cdn.tf: default_cache_behavior targets the S3 origin "${target}", but a server-rendered frontend lives on the instance -- target the EC2 origin with all seven methods, Managed-CachingDisabled and Managed-AllViewer`,
      );
    }
    if (/function_association/.test(block)) {
      errors.push(
        "cdn.tf: remove the function_association from default_cache_behavior -- there is no index.html to rewrite to; the Next.js server renders every path",
      );
    }
  }
  return errors;
}

/**
 * The CodeBuild role can write objects into the artifacts bucket but not
 * list it; "aws s3 sync" / "cp --recursive" into it fails with AccessDenied.
 */
export function checkBuildspecArtifactUploads(buildspec: string): string[] {
  const bad = buildspec
    .split(/\r?\n/)
    .filter(
      (l) => /\$\{?ARTIFACTS_BUCKET/.test(l) && /aws\s+s3\s+(sync\b|cp\b.*--recursive)/.test(l),
    );
  return bad.length
    ? [
        `buildspec.yml uploads to the artifacts bucket with "aws s3 sync"/"--recursive", which needs s3:ListBucket the build role doesn't have; upload each file with "aws s3 cp <file> s3://$ARTIFACTS_BUCKET/deploy/..." instead (${bad[0]!.trim()})`,
      ]
    : [];
}

export interface GauntletResult {
  passed: boolean;
  gates: GateResult[];
  planSummary?: PlanSummary;
  freeTierReport?: FreeTierReport;
}

const COMMON_OUTPUTS = [
  "cloudfront_domain_name",
  "distribution_id",
  "frontend_bucket",
  "artifacts_bucket",
  "codebuild_project",
];
export const REQUIRED_OUTPUTS: Record<"F1" | "F2" | "F3", string[]> = {
  F1: [...COMMON_OUTPUTS, "function_name"],
  F2: [...COMMON_OUTPUTS, "instance_id", "ecr_repository_url"],
  F3: COMMON_OUTPUTS,
};

const MAX_ERRORS_PER_GATE = 25;
const MAX_ERROR_LENGTH = 600;

/**
 * Trivy findings that contradict the Free Tier constraints the platform is
 * built around (WAF, access logging buckets, customer-managed KMS keys,
 * X-Ray tracing all cost money) -- each one would otherwise send the model
 * into a loop of adding a deny-listed or paid resource. Everything else at
 * HIGH/CRITICAL fails the gate.
 */
export const TRIVY_FREE_TIER_EXCEPTIONS: Record<string, string> = {
  "AVD-AWS-0011": "WAF is deny-listed: not Free-Tier-eligible",
  "AVD-AWS-0132": "customer-managed KMS keys are deny-listed (monthly cost); AES256 SSE is used",
  "AVD-AWS-0104":
    "F2 has no NAT Gateway or VPC interface endpoints (not Free-Tier-eligible), so the instance needs internet egress for ECR/SSM/packages",
};

function clip(errors: string[]): string[] {
  return errors
    .slice(0, MAX_ERRORS_PER_GATE)
    .map((e) => (e.length > MAX_ERROR_LENGTH ? `${e.slice(0, MAX_ERROR_LENGTH)}...` : e));
}

export interface S3BackendConfig {
  bucket: string;
  key: string;
  region: string;
}

/**
 * Without `backend`, validation and the pre-approval plan use local state in
 * a throwaway dir. With it, apply uses the real S3 state (Sec. 3.3:
 * versioned, encrypted, S3-native lockfile -- no DynamoDB table), passed to
 * `terraform init -backend-config=backend.hcl`.
 */
export function writeWorkdir(
  dir: string,
  ctx: Pick<GauntletContext, "bundle" | "pattern" | "tfvars"> & { backend?: S3BackendConfig },
) {
  const backendFile: TerraformFile = ctx.backend
    ? {
        path: "backend.hcl",
        content: [
          `bucket       = ${JSON.stringify(ctx.backend.bucket)}`,
          `key          = ${JSON.stringify(ctx.backend.key)}`,
          `region       = ${JSON.stringify(ctx.backend.region)}`,
          `encrypt      = true`,
          `use_lockfile = true`,
          "",
        ].join("\n"),
      }
    : {
        path: "zz_autoinfra_backend_override.tf",
        content: 'terraform {\n  backend "local" {}\n}\n',
      };
  const files: TerraformFile[] = [
    ...ctx.bundle.files.filter((f) => !PLATFORM_FILE_PATHS.has(f.path)),
    ...loadPlatformFiles(),
    backendFile,
    { path: "autoinfra.auto.tfvars.json", content: JSON.stringify(ctx.tfvars, null, 2) },
  ];
  for (const file of files) {
    const target = path.join(dir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // LF only: generated scripts run on Linux; a CRLF run.sh breaks bash.
    fs.writeFileSync(target, file.content.replaceAll("\r\n", "\n"));
  }
  if (ctx.pattern === "F1") {
    fs.mkdirSync(path.join(dir, "bootstrap"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bootstrap", "placeholder.zip"), buildPlaceholderLambdaZip());
  }
}

interface ValidateDiagnostic {
  severity: string;
  summary: string;
  detail?: string;
  range?: { filename: string; start: { line: number } };
}

function formatDiagnostic(d: ValidateDiagnostic): string {
  const where = d.range ? `${d.range.filename}:${d.range.start.line}: ` : "";
  return `${where}${d.summary}${d.detail ? ` -- ${d.detail}` : ""}`;
}

export async function runGauntlet(ctx: GauntletContext): Promise<GauntletResult> {
  const gates: GateResult[] = [];
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autoinfra-tf-"));
  const baseEnv = toolEnv({ pluginCacheDir: ctx.pluginCacheDir, region: ctx.tfvars.region });
  // Reading the real state needs credentials; without them, plan is skipped anyway.
  const stateBackend = ctx.credentials ? ctx.stateBackend : undefined;
  const initEnv = stateBackend
    ? toolEnv({
        pluginCacheDir: ctx.pluginCacheDir,
        region: ctx.tfvars.region,
        credentials: ctx.credentials,
      })
    : baseEnv;

  async function gate(
    name: GateName,
    fn: () => Promise<{
      errors: string[];
      notes?: string[];
      skipped?: boolean;
      /** false: the network or a tool failed, not the files -- the model isn't asked. */
      repairable?: boolean;
    }>,
  ): Promise<boolean> {
    const started = Date.now();
    const { errors, notes = [], skipped, repairable } = await fn();
    const result: GateResult = {
      gate: name,
      status: skipped ? "skipped" : errors.length ? "failed" : "passed",
      errors: clip(errors),
      notes: clip(notes),
      durationMs: Date.now() - started,
      ...(repairable === false && errors.length ? { repairable: false } : {}),
    };
    gates.push(result);
    await ctx.onGate?.(result);
    return result.status !== "failed";
  }

  const tf = (args: string[], timeoutMs: number, env = baseEnv) =>
    run("terraform", [...args, "-no-color"], { cwd: dir, env, timeoutMs });

  let planSummary: PlanSummary | undefined;
  let freeTierReport: FreeTierReport | undefined;

  try {
    // 1. Static pre-flight: nothing unsafe reaches a terraform command.
    const staticOk = await gate("static", async () => {
      const errors = checkStaticTerraform(ctx.bundle.files);
      const buildspec = ctx.bundle.files.find((f) => f.path === "buildspec.yml");
      if (!buildspec) errors.push("buildspec.yml is missing");
      else {
        errors.push(...checkBuildspecLayout(buildspec.content, ctx.profile, ctx.pattern));
        errors.push(...checkBuildspecArtifactUploads(buildspec.content));
      }
      const compose = ctx.bundle.files.find((f) => f.path === "app/docker-compose.yml");
      if (compose) {
        errors.push(...checkComposeDatabaseName(compose.content, ctx.profile));
        errors.push(...checkComposeKeepsPlatformEnv(compose.content, ctx.profile, ctx.pattern));
        errors.push(...checkComposeDatabaseStability(compose.content, ctx.profile));
      }
      if (ctx.pattern === "F2") errors.push(...checkInstanceCanListArtifacts(ctx.bundle.files));
      errors.push(...checkExternalDatabaseAccess(ctx.bundle.files, ctx.profile, ctx.pattern));
      errors.push(...checkServerRenderedFrontend(ctx.bundle.files, ctx.profile, ctx.pattern));
      if (ctx.pattern === "F1" && !ctx.bundle.files.some((f) => f.path === "app/run.sh")) {
        errors.push("app/run.sh is missing (the Lambda Web Adapter entrypoint)");
      }
      // The deploy step reads these outputs; catch a missing one here, where
      // the model can still fix it, not after an apply.
      const hcl = ctx.bundle.files
        .filter((f) => f.path.endsWith(".tf"))
        .map((f) => f.content)
        .join("\n");
      for (const name of REQUIRED_OUTPUTS[ctx.pattern]) {
        if (!new RegExp(`output\\s+"${name}"`).test(hcl))
          errors.push(`missing required output "${name}"`);
      }
      return { errors };
    });
    if (!staticOk) return { passed: false, gates };

    writeWorkdir(dir, { ...ctx, backend: stateBackend });

    // 2. fmt: formatting is auto-fixed, not worth a repair round-trip; only
    // a parse error fails.
    const fmtOk = await gate("fmt", async () => {
      const result = await tf(["fmt", "-recursive", "-list=true"], 60_000);
      if (result.code !== 0) return { errors: [result.stderr.trim() || "terraform fmt failed"] };
      const changed = result.stdout.split(/\r?\n/).filter(Boolean);
      return { errors: [], notes: changed.length ? [`auto-formatted: ${changed.join(", ")}`] : [] };
    });
    if (!fmtOk) return { passed: false, gates };

    const initOk = await gate("init", async () => {
      const result = await initWithRetry(
        () =>
          tf(
            stateBackend
              ? ["init", "-input=false", "-backend-config=backend.hcl"]
              : ["init", "-input=false"],
            300_000,
            initEnv,
          ),
        { delaysMs: ctx.initRetryDelaysMs },
      );
      if (result.code === 0)
        return {
          errors: [],
          notes: result.attempts > 1 ? [`after ${result.attempts} attempts`] : [],
        };
      if (result.networkError)
        return { errors: [networkFailureMessage(result)], repairable: false };
      return { errors: [result.stderr.trim()] };
    });
    if (!initOk) return { passed: false, gates };

    const validateOk = await gate("validate", async () => {
      const result = await tf(["validate", "-json"], 120_000);
      try {
        const parsed = JSON.parse(result.stdout) as { diagnostics?: ValidateDiagnostic[] };
        const diags = parsed.diagnostics ?? [];
        return {
          errors: diags.filter((d) => d.severity === "error").map(formatDiagnostic),
          notes: diags.filter((d) => d.severity === "warning").map(formatDiagnostic),
        };
      } catch {
        return { errors: [result.stderr.trim() || "terraform validate failed"] };
      }
    });
    if (!validateOk) return { passed: false, gates };

    // 3. Linters. Missing tools are reported as skipped, never as passed.
    await gate("tflint", async () => {
      const tool = await resolveTool("tflint");
      if (!tool)
        return {
          errors: [],
          skipped: true,
          notes: ["tflint not installed and Docker unavailable"],
        };
      const { command, args } = tool.command(dir, ["--format=json", "--no-color"]);
      const result = await run(command, args, { cwd: dir, env: baseEnv, timeoutMs: 180_000 });
      try {
        const parsed = JSON.parse(result.stdout) as {
          issues?: Array<{
            rule: { name: string; severity: string };
            message: string;
            range?: { filename: string; start: { line: number } };
          }>;
          errors?: Array<{ message: string }>;
        };
        const fmt = (i: NonNullable<typeof parsed.issues>[number]) =>
          `${i.range ? `${i.range.filename}:${i.range.start.line}: ` : ""}${i.message} [${i.rule.name}]`;
        return {
          errors: [
            ...(parsed.issues ?? []).filter((i) => i.rule.severity === "error").map(fmt),
            ...(parsed.errors ?? []).map((e) => e.message),
          ],
          notes: [
            `via ${tool.via}`,
            ...(parsed.issues ?? []).filter((i) => i.rule.severity !== "error").map(fmt),
          ],
        };
      } catch {
        // No JSON report: the tool itself failed (a Docker pull, a crash), not the files.
        return {
          errors: [`tflint failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`],
          repairable: false,
        };
      }
    });

    await gate("trivy", async () => {
      const tool = await resolveTool("trivy");
      if (!tool)
        return { errors: [], skipped: true, notes: ["trivy not installed and Docker unavailable"] };
      const { command, args } = tool.command(dir, [
        "config",
        "--format",
        "json",
        "--severity",
        "HIGH,CRITICAL",
        "--exit-code",
        "0",
        "--quiet",
        "--skip-dirs",
        ".terraform",
        ".",
      ]);
      const result = await run(command, args, { cwd: dir, env: baseEnv, timeoutMs: 300_000 });
      try {
        const parsed = JSON.parse(result.stdout) as {
          Results?: Array<{
            Target: string;
            Misconfigurations?: Array<{
              ID: string;
              AVDID?: string;
              Title: string;
              Message: string;
              Severity: string;
              CauseMetadata?: { StartLine?: number };
            }>;
          }>;
        };
        const errors: string[] = [];
        const notes: string[] = [`via ${tool.via}`];
        for (const r of parsed.Results ?? []) {
          for (const m of r.Misconfigurations ?? []) {
            const id = m.AVDID ?? m.ID;
            const line = `${r.Target}:${m.CauseMetadata?.StartLine ?? "?"}: ${m.Title} -- ${m.Message} [${id}]`;
            const exception = TRIVY_FREE_TIER_EXCEPTIONS[id] ?? TRIVY_FREE_TIER_EXCEPTIONS[m.ID];
            if (exception) notes.push(`ignored (${exception}): ${line}`);
            else errors.push(line);
          }
        }
        return { errors, notes };
      } catch {
        // No JSON report: the tool itself failed (a Docker pull, a crash), not the files.
        return {
          errors: [`trivy failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`],
          repairable: false,
        };
      }
    });

    // 4. Plan + policies on the real plan JSON.
    if (!ctx.credentials) {
      for (const name of ["plan", "security_policy", "free_tier_policy"] as const) {
        await gate(name, async () => ({
          errors: [],
          skipped: true,
          notes: [
            "No AWS credentials (deploy role not reachable) -- planning requires the role in the user's account.",
          ],
        }));
      }
      return { passed: false, gates };
    }

    let planJson: PlanJson | undefined;
    const planEnv = toolEnv({
      pluginCacheDir: ctx.pluginCacheDir,
      region: ctx.tfvars.region,
      credentials: ctx.credentials,
    });
    const planOk = await gate("plan", async () => {
      const result = await tf(
        ["plan", "-input=false", "-lock=false", "-out=tfplan"],
        600_000,
        planEnv,
      );
      if (result.code !== 0) {
        // AWS unreachable mid-plan: retrying later helps, editing the files doesn't.
        const network = result.timedOut || isNetworkError(result.stderr);
        return {
          errors: [
            result.timedOut
              ? "terraform plan timed out"
              : result.stderr.trim() || "terraform plan failed",
          ],
          ...(network ? { repairable: false } : {}),
        };
      }
      const shown = await tf(["show", "-json", "tfplan"], 120_000, planEnv);
      planJson = JSON.parse(shown.stdout) as PlanJson;
      planSummary = summarizePlan(planJson);
      return {
        errors: [],
        notes: [
          `+${planSummary.adds} ~${planSummary.changes} -${planSummary.destroys} ±${planSummary.replaces}`,
        ],
      };
    });
    if (!planOk || !planJson) return { passed: false, gates, planSummary };

    const policyCtx: SecurityPolicyContext = {
      region: ctx.tfvars.region,
      tags: {
        "autoinfra:deployment-id": ctx.tfvars.deployment_id,
        "autoinfra:owner": ctx.tfvars.owner,
        "autoinfra:managed-by": "autoinfra",
        "autoinfra:free-tier": "true",
      },
      functionUrlAuth: ctx.pattern === "F1" ? ctx.tfvars.function_url_auth_type : undefined,
    };
    await gate("security_policy", async () => checkPlanSecurity(planJson!, policyCtx));

    await gate("free_tier_policy", async () => {
      freeTierReport = evaluateFreeTier({
        plan: { resources: planToResources(planJson!) },
        freeTierMode: ctx.freeTierMode,
        eligibleInstanceTypes: ctx.eligibleInstanceTypes.length
          ? ctx.eligibleInstanceTypes
          : undefined,
        existingAlwaysOnEc2Count: ctx.existingAlwaysOnEc2Count,
      });
      // Flexible mode: violations don't fail the gate; the approval screen
      // requires an explicit cost-labelled confirmation instead (Sec. 2).
      return ctx.freeTierMode === "strict"
        ? { errors: freeTierReport.denyListViolations }
        : {
            errors: [],
            notes: freeTierReport.denyListViolations.map(
              (v) => `requires paid-resource confirmation: ${v}`,
            ),
          };
    });

    return {
      passed: gates.every((g) => g.status === "passed"),
      gates,
      planSummary,
      freeTierReport,
    };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The errors from failed gates, formatted for the model's repair prompt. */
export function repairErrors(gates: GateResult[]): string[] {
  return gates
    .filter((g) => g.status === "failed" && g.repairable !== false)
    .flatMap((g) => g.errors.map((e) => `[${g.gate}] ${e}`));
}

/** Why validation ended without a verdict: a failure no edit can fix, or a gate that couldn't run. */
export function unfinishedReason(gates: GateResult[]): string {
  const reasons = [
    ...gates
      .filter((g) => g.status === "failed" && g.repairable === false)
      .map((g) => `${g.gate}: ${g.errors[0] ?? "failed"}`),
    ...gates
      .filter((g) => g.status === "skipped")
      .map((g) => `${g.gate} (${g.notes[0] ?? "skipped"})`),
  ];
  return `Validation could not finish: ${reasons.join("; ")}`;
}
