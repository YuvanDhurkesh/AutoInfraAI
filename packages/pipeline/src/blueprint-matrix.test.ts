import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ArchitecturePlan } from "@autoinfra/shared";
import { scanRepo } from "@autoinfra/scanner";
import { architectureToResources, evaluateFreeTier } from "@autoinfra/free-tier-policy";
import { blueprintFor, designBlueprint, renderBlueprint } from "@autoinfra/terraform-reference";
import { runGauntlet } from "@autoinfra/terraform-runner";
import { buildTfVars } from "./tfvars.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixture = (name: string) => path.join(REPO_ROOT, "packages/scanner/test/fixtures", name);
const example = (name: string) => path.join(REPO_ROOT, "examples", name);

/**
 * Every repo shape the blueprints claim, end to end without AWS: scan ->
 * blueprint design (Free Tier clean in strict mode) -> render -> the same
 * gauntlet the worker runs (static checks, fmt, init, validate, tflint,
 * trivy, AutoInfra's layout/compose/SSR/database checks). Real terraform.
 * The regression corpus: a shape that stops passing here would have failed
 * for a real user.
 */
const CASES: Array<{
  name: string;
  dir: string;
  pattern: "F1" | "F2" | "F3";
  externalDatabase?: boolean;
  /** Text a rendered file must contain, e.g. the routes that reach the backend. */
  expectInFiles?: Record<string, string[]>;
}> = [
  { name: "plain static site", dir: fixture("static-only"), pattern: "F3" },
  { name: "React (CRA) + Express API", dir: fixture("react-express"), pattern: "F1" },
  { name: "Vite + Fastify", dir: fixture("vite-fastify"), pattern: "F1" },
  { name: "DynamoDB monorepo", dir: fixture("monorepo"), pattern: "F1" },
  { name: "Flask API (Python on Lambda)", dir: fixture("flask-api"), pattern: "F1" },
  { name: "Express + MySQL with schema scripts", dir: fixture("express-mysql"), pattern: "F2" },
  {
    name: "Express + MySQL hosted outside AWS",
    dir: fixture("express-mysql"),
    pattern: "F1",
    externalDatabase: true,
  },
  { name: "Express + MongoDB", dir: fixture("express-mongo"), pattern: "F2" },
  { name: "Next.js SSR + Express", dir: fixture("nextjs-ssr-express"), pattern: "F2" },
  { name: "Next.js SSR with Postgres", dir: fixture("nextjs-ssr-postgres"), pattern: "F2" },
  { name: "Nuxt server", dir: fixture("nuxt-ssr"), pattern: "F2" },
  { name: "Nuxt static (nuxt generate)", dir: fixture("nuxt-static"), pattern: "F3" },
  { name: "SvelteKit server (adapter-auto)", dir: fixture("sveltekit-ssr"), pattern: "F2" },
  { name: "SvelteKit static (adapter-static)", dir: fixture("sveltekit-static"), pattern: "F3" },
  { name: "FastAPI + Postgres", dir: fixture("fastapi-postgres"), pattern: "F2" },
  { name: "WebSockets", dir: fixture("websockets"), pattern: "F2" },
  {
    name: "sample: React + Express on Lambda",
    dir: example("react-express-lambda"),
    pattern: "F1",
  },
  {
    name: "sample: React + Node + Postgres + WS",
    dir: example("react-node-postgres-ws"),
    pattern: "F2",
  },
  {
    name: "MERN chat: socket.io, /uploads, CRA proxy",
    dir: fixture("mern-socketio"),
    pattern: "F2",
    expectInFiles: {
      "cdn.tf": ['dynamic "ordered_cache_behavior"', '["/socket.io","/uploads"]'],
    },
  },
  {
    name: "Vite proxy + Express routes without /api (Lambda)",
    dir: fixture("vite-proxy-routes"),
    pattern: "F1",
    expectInFiles: {
      "cdn.tf": ['["/todos","/auth","/health"]', "aws_cloudfront_function.api_prefix.arn"],
      "buildspec.yml": ['AUTOINFRA_LOCALHOST_SUFFIX: "/api"', "package-lambda.sh"],
    },
  },
  {
    name: "Go API + Vite (generated Dockerfile)",
    dir: fixture("go-api"),
    pattern: "F2",
    expectInFiles: { "app/Dockerfile": ["go build -trimpath -o /out/server ./cmd/server"] },
  },
  {
    name: "Spring Boot, Maven (generated Dockerfile)",
    dir: fixture("spring-boot"),
    pattern: "F2",
    expectInFiles: { "app/Dockerfile": ["mvn -q -B -DskipTests package", "SERVER_PORT=8081"] },
  },
  {
    name: "Ruby app with its own Dockerfile",
    dir: fixture("rails-docker"),
    pattern: "F2",
    expectInFiles: { "buildspec.yml": ['-f Dockerfile "$AUTOINFRA_BE_DIR"'] },
  },
];

describe("blueprint matrix (real terraform)", () => {
  it.each(CASES)(
    "$name -> $pattern",
    async ({ dir, pattern, externalDatabase, expectInFiles = {} }) => {
      const profile = scanRepo(dir, {
        repoUrl: "https://github.com/example/app",
        commitSha: "0".repeat(40),
        branch: "main",
        externalDatabase,
      });
      const decision = blueprintFor(profile);
      expect(decision).toEqual({ supported: true, pattern });

      const plan = ArchitecturePlan.parse(
        designBlueprint(profile, { pattern, instanceType: "t3.micro", apiPathPrefix: "/api" }),
      );
      const report = evaluateFreeTier({
        plan: { resources: architectureToResources(plan) },
        freeTierMode: "strict",
        eligibleInstanceTypes: ["t3.micro"],
        existingAlwaysOnEc2Count: 0,
      });
      expect(report.denyListViolations).toEqual([]);

      const tfvars = buildTfVars({
        deploymentId: "11111111-2222-4333-8444-555555555555",
        ownerId: "owner",
        region: "ap-south-1",
        plan,
        profile,
        eligibleInstanceTypes: ["t3.micro"],
      });
      const files = renderBlueprint({
        profile,
        pattern,
        apiPathPrefix: tfvars.api_path_prefix,
        appPort: tfvars.app_port,
      });
      for (const [file, needles] of Object.entries(expectInFiles)) {
        const content = files.find((f) => f.path === file)?.content ?? "";
        for (const needle of needles) expect(content, file).toContain(needle);
      }
      const result = await runGauntlet({
        bundle: { files },
        pattern,
        tfvars,
        profile,
        freeTierMode: "strict",
        eligibleInstanceTypes: ["t3.micro"],
        existingAlwaysOnEc2Count: 0,
        credentials: null,
        pluginCacheDir: process.env.TF_PLUGIN_CACHE_DIR,
      });
      const failures = result.gates
        .filter((g) => g.status === "failed")
        .flatMap((g) => g.errors.map((e) => `[${g.gate}] ${e}`));
      expect(failures).toEqual([]);
      const statuses = Object.fromEntries(result.gates.map((g) => [g.gate, g.status]));
      expect(statuses).toMatchObject({
        static: "passed",
        fmt: "passed",
        init: "passed",
        validate: "passed",
        plan: "skipped", // needs AWS credentials
      });
      expect(["passed", "skipped"]).toContain(statuses.tflint);
      expect(["passed", "skipped"]).toContain(statuses.trivy);
    },
    600_000,
  );
});
