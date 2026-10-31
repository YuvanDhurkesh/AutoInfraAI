// Manual end-to-end check: real Gemini design + Terraform generation + full
// gauntlet + read-only plan. Not part of the test suite (costs tokens, needs
// AWS credentials). Usage (from packages/terraform-runner, after building):
//   SMOKE_CREDS='{"accessKeyId":...,"secretAccessKey":...,"sessionToken":...}' \
//   PATTERN_PROFILE=f1|f2 GEMINI_API_KEY=... GEMINI_MODEL=... node scripts/e2e-generate.mjs
// The plan is read-only: it creates nothing in the AWS account.
import { GeminiClient, designArchitecture } from "@autoinfra/llm";
import { lambdaAdapterLayerArn } from "@autoinfra/terraform-reference";
import { generateAndValidate } from "../dist/index.js";

const calls = [];
const llm = new GeminiClient({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL,
  logger: (r) => calls.push(r),
});

const profiles = {
  f1: {
    repoUrl: "https://github.com/example/todo-app",
    commitSha: "abc",
    branch: "main",
    frontend: {
      framework: "react-vite",
      isSSR: false,
      buildCommand: "vite build",
      outputDir: "dist",
      apiBaseUrlEnvVar: "VITE_API_URL",
      hardcodedLocalhostUrls: [],
    },
    backend: {
      language: "node",
      framework: "express",
      startCommand: "node src/server.js",
      port: 4000,
      healthEndpoint: "/api/health",
      apiRoutePrefix: "/api",
      isStatelessHttp: true,
      usesWebSockets: false,
      hasLocalDiskPersistence: false,
      lambdaCompatible: true,
      hasMutatingRoutes: true,
    },
    envVars: [
      { name: "JWT_SECRET", isSecret: true },
      { name: "TABLE_NAME", isSecret: false },
    ],
    database: "dynamodb",
    hasDockerfile: false,
    hasComposeFile: false,
    recommendedPattern: "F1",
    unsupportedReasons: [],
    secretsDetected: [],
  },
  f2: {
    repoUrl: "https://github.com/example/chat-app",
    commitSha: "abc",
    branch: "main",
    frontend: {
      framework: "react-vite",
      isSSR: false,
      buildCommand: "vite build",
      outputDir: "dist",
      apiBaseUrlEnvVar: "VITE_API_URL",
      hardcodedLocalhostUrls: [],
    },
    backend: {
      language: "node",
      framework: "express",
      startCommand: "node src/server.js",
      port: 5000,
      healthEndpoint: "/api/health",
      apiRoutePrefix: "/api",
      isStatelessHttp: true,
      usesWebSockets: true,
      hasLocalDiskPersistence: false,
      lambdaCompatible: false,
      hasMutatingRoutes: true,
    },
    envVars: [{ name: "DATABASE_URL", isSecret: true }],
    database: "postgres",
    hasDockerfile: false,
    hasComposeFile: false,
    recommendedPattern: "F2",
    unsupportedReasons: [],
    secretsDetected: [],
  },
};
const profile = profiles[process.env.PATTERN_PROFILE ?? "f1"];

const plan = await designArchitecture(llm, profile, {
  region: "ap-south-1",
  freeTierMode: "strict",
  allowRds: false,
  eligibleInstanceTypes: ["t3.micro"],
});
console.log(`DESIGN: ${plan.pattern} -- ${plan.components.map((c) => c.service).join(", ")}`);

const result = await generateAndValidate(llm, {
  plan,
  profile,
  freeTierMode: "strict",
  eligibleInstanceTypes: ["t3.micro"],
  existingAlwaysOnEc2Count: 0,
  credentials: JSON.parse(process.env.SMOKE_CREDS),
  pluginCacheDir: process.env.LOCALAPPDATA + "/autoinfra/tf-plugin-cache",
  tfvars: {
    region: "ap-south-1",
    deployment_id: "dep-e2e",
    owner: "user-e2e",
    short_id: "e2e00001",
    api_path_prefix: "/api",
    app_port: profile.backend.port,
    health_check_path: "/api/health",
    function_url_auth_type: "NONE",
    lambda_adapter_layer_arn: lambdaAdapterLayerArn("ap-south-1"),
    instance_type: "t3.micro",
    instance_architecture: "x86_64",
  },
  onGate: (n, g) => {
    console.log(`  attempt ${n} · ${g.gate}: ${g.status}`);
    for (const e of g.errors.slice(0, 6)) console.log(`      ${e.slice(0, 220)}`);
  },
});

console.log(
  `\nRESULT: ${result.passed ? "PASSED" : "FAILED"} after ${result.attempts.length} attempt(s)`,
);
if (result.failureReason) console.log(`REASON: ${result.failureReason}`);
if (result.planSummary)
  console.log(
    `PLAN: +${result.planSummary.adds} ~${result.planSummary.changes} -${result.planSummary.destroys}`,
  );
if (result.freeTierReport) console.log(`FREE TIER: ${result.freeTierReport.fit}`);
console.log(`FILES: ${result.bundle?.files.map((f) => f.path).join(", ")}`);
console.log(
  `LLM CALLS: ${calls.length}, prompt tokens ${calls.reduce((s, c) => s + (c.promptTokens ?? 0), 0)}, output tokens ${calls.reduce((s, c) => s + (c.outputTokens ?? 0), 0)}`,
);
