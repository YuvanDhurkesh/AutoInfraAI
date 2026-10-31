import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { MockLlmClient } from "@autoinfra/llm";
import { runJob, type PipelineDeps } from "@autoinfra/pipeline";
import type { cloneRepo } from "@autoinfra/scanner";
import { DEPLOY_ROLE_TEMPLATE_VERSION } from "@autoinfra/terraform-reference";
import type { PlanSummary } from "@autoinfra/shared";
import {
  ApplyError,
  DestroyError,
  type GenerateAndValidateResult,
} from "@autoinfra/terraform-runner";
import { loadEnv } from "../env.js";
import { buildApp, type AppDeps } from "../app.js";

/**
 * The generate -> approve -> apply -> build -> health -> live flow through the
 * real API routes and the real pipeline job code, with every external system
 * (AWS, Terraform, CodeBuild, the deployed app over HTTP) faked. `enqueue`
 * runs the job inline instead of handing it to BullMQ.
 */

const FIXTURES = path.resolve(
  fileURLToPath(new URL("../../../../packages/scanner/test/fixtures", import.meta.url)),
);
const creds = { accessKeyId: "AKIAFAKE", secretAccessKey: "s", sessionToken: "t" };
const FIRST_SHA = "1111111111111111111111111111111111111111";
/** What the fake clone reports as the branch head; tests "push" by changing it. */
let headSha = FIRST_SHA;

function fakeClone(fixture: string): typeof cloneRepo {
  return async (opts) => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-test-"));
    fs.cpSync(path.join(FIXTURES, fixture), localPath, { recursive: true });
    return {
      localPath,
      commitSha: opts.commitSha ?? headSha,
      cleanup: async () => fs.rmSync(localPath, { recursive: true, force: true }),
    };
  };
}

const validF1 = {
  pattern: "F1",
  summary: "Serverless React + Express.",
  components: [
    { service: "aws_s3_bucket", name: "frontend", purpose: "static assets" },
    { service: "aws_cloudfront_distribution", name: "cdn", purpose: "routing" },
    { service: "aws_lambda_function", name: "api", purpose: "Express" },
  ],
  routing: { apiPathPrefix: "/api" },
  envMapping: [],
  risks: [],
  assumptions: [],
  mermaidDiagram: 'flowchart LR\n  U["User"] --> CF["CloudFront"]',
  draftFreeTierAssessment: "ok",
};

const approvedPlan = {
  adds: 2,
  changes: 0,
  destroys: 0,
  replaces: 0,
  resources: [
    {
      address: "aws_s3_bucket.frontend",
      type: "aws_s3_bucket",
      action: "create" as const,
      dataBearing: true,
    },
    {
      address: "aws_lambda_function.api",
      type: "aws_lambda_function",
      action: "create" as const,
      dataBearing: false,
    },
  ],
  dataBearingDestroys: [],
};

function passingGav(report: { violations?: string[] } = {}): PipelineDeps["generateAndValidate"] {
  return async (_llm, input) => {
    const gate = {
      gate: "plan" as const,
      status: "passed" as const,
      errors: [],
      notes: [],
      durationMs: 5,
    };
    await input.onGate?.(1, gate);
    const result: GenerateAndValidateResult = {
      passed: true,
      bundle: {
        files: [
          { path: "main.tf", content: 'resource "aws_s3_bucket" "frontend" {}' },
          { path: "app/run.sh", content: "#!/bin/bash\nexec node src/server.js\n" },
        ],
      },
      attempts: [{ number: 1, gates: [gate] }],
      planSummary: approvedPlan,
      freeTierReport: {
        fit: report.violations?.length ? "exceeds" : "within_limits",
        resources: [],
        usage: {} as never,
        warnings: [],
        denyListViolations: report.violations ?? [],
        estimatedMonthlyCostUsd: 0,
      },
    };
    return result;
  };
}

interface Recorder {
  gavInputs: unknown[];
  applyInputs: Array<Parameters<PipelineDeps["applyBundle"]>[0]>;
  uploads: Array<{ bucket: string; key: string; size: number }>;
  fetched: string[];
  params: Array<{ name: string; value: string; isSecret: boolean; shortId: string }>;
  deletedParams: string[];
  destroyInputs: Array<Parameters<PipelineDeps["destroyBundle"]>[0]>;
  /** App log reads: an instance container ("app"...) or a Lambda log group. */
  logReads: string[];
  /** Database viewer reads: "instance:kind" (tables) or "instance:kind:table:offset:limit". */
  dbReads: string[];
}

describe("pipeline: generate -> approve -> deploy", () => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  async function setup(
    opts: {
      gav?: PipelineDeps["generateAndValidate"];
      build?: "SUCCEEDED" | "FAILED";
      /** More lines the build prints after the rollout starts (the instance's errors). */
      buildOutput?: string[];
      apiHealthy?: boolean;
      freeTierMode?: "strict" | "flexible";
      apiAssume?: AppDeps["assumeDeployRole"];
      /** Changes the fresh plan has outside what was approved. */
      drift?: string[];
      fixture?: string;
      design?: object;
      leftovers?: string[];
      destroyFails?: boolean;
      templateVersion?: number | null;
      diagnosis?: object;
      /** Leave the deployment un-analyzed (the test starts the chain itself). */
      skipPrepare?: boolean;
    } = {},
  ) {
    headSha = FIRST_SHA;
    const rec: Recorder = {
      gavInputs: [],
      applyInputs: [],
      uploads: [],
      fetched: [],
      params: [],
      deletedParams: [],
      destroyInputs: [],
      logReads: [],
      dbReads: [],
    };
    const gav = opts.gav ?? passingGav();
    const pipelineDeps: PipelineDeps = {
      prisma,
      // Design runs on the worker now, so its scripted answer lives here.
      llm: new MockLlmClient({ design: [opts.design ?? validF1] }),
      assumeDeployRole: async () => creds,
      getCallerIdentity: async () => ({ accountId: "222222222222", arn: "arn", userId: "u" }),
      ensureStateBucket: async (_c, region, account) => `autoinfra-tfstate-${account}-${region}`,
      uploadObject: async (_c, _r, bucket, key, body) => {
        rec.uploads.push({ bucket, key, size: body.length });
      },
      runCodeBuild: async (o) => {
        await o.onLog?.("npm run build");
        await o.onLog?.("[Container] Running command bash .autoinfra/rollout.sh");
        for (const line of opts.buildOutput ?? []) await o.onLog?.(line);
        return { status: opts.build ?? "SUCCEEDED", buildId: "build:1" };
      },
      recentLogLines: async () => ["Error: Cannot find module 'express'"],
      putAppParameter: async (o) => {
        rec.params.push({ name: o.name, value: o.value, isSecret: o.isSecret, shortId: o.shortId });
        return `/autoinfra/${o.shortId}/${o.name}`;
      },
      deleteParametersByPath: async (_c, _r, p) => {
        rec.deletedParams.push(p);
        return [`${p}/CLIENT_URL`, `${p}/NODE_ENV`];
      },
      findTaggedResources: async () => opts.leftovers ?? [],
      destroyBundle: async (input) => {
        rec.destroyInputs.push(input);
        if (opts.destroyFails)
          throw new DestroyError("terraform destroy failed with 3 resources left");
        await input.onLog("Destruction complete");
        return { remaining: [] };
      },
      cloneRepo: fakeClone(opts.fixture ?? "react-express"),
      generateAndValidate: async (llm, input) => {
        rec.gavInputs.push(input);
        return gav(llm, input);
      },
      applyBundle: async (input) => {
        rec.applyInputs.push(input);
        if (opts.drift && input.approvedPlan.resources.length === 0) {
          throw new ApplyError("The plan changed since you approved it.", opts.drift);
        }
        await input.onLog("Apply complete! Resources: 2 added");
        return {
          planSummary: approvedPlan,
          outputs: {
            cloudfront_domain_name: "d111.cloudfront.net",
            artifacts_bucket: "autoinfra-x-artifacts",
            codebuild_project: "autoinfra-x-build",
            function_name: "autoinfra-x-api",
          },
        };
      },
      githubToken: async () => undefined,
      // Chained steps (analyze -> design -> generate) queue the next one themselves.
      enqueue: async (payload) => {
        void runJob(pipelineDeps, payload);
      },
      fetch: (async (url: string) => {
        rec.fetched.push(url);
        const isApi = url.includes("/api/");
        const healthy = !isApi || (opts.apiHealthy ?? true);
        return new Response(healthy ? "ok" : JSON.stringify({ error: "deploying" }), {
          status: healthy ? 200 : 503,
        });
      }) as typeof fetch,
      sleep: async () => undefined,
    };
    const app = await buildApp(env, prisma, {
      llm: new MockLlmClient(opts.diagnosis ? { diagnose: [opts.diagnosis] } : {}),
      cloneRepo: fakeClone(opts.fixture ?? "react-express"),
      assumeDeployRole:
        opts.apiAssume ??
        (async (input) => {
          // STS's own check: a session name with a space is refused.
          if (input.sessionName && !/^[\w+=,.@-]{2,64}$/.test(input.sessionName))
            throw new Error(`invalid roleSessionName ${input.sessionName}`);
          return creds;
        }),
      putAppParameter: async (o) => {
        rec.params.push({ name: o.name, value: o.value, isSecret: o.isSecret, shortId: o.shortId });
        return `/autoinfra/${o.shortId}/${o.name}`;
      },
      deleteAppParameter: async (_c, _r, p) => {
        rec.deletedParams.push(p);
      },
      enqueue: async (payload) => {
        void runJob(pipelineDeps, payload);
      },
      subscribeJobLogs: async () => async () => undefined,
      instanceLogs: async (o) => {
        rec.logReads.push(`${o.instanceId}:${o.service}:${o.lines}`);
        return ["app-1  | 2026-10-30T13:31:37Z Server is running on port 5001"];
      },
      recentLogLines: async (_c, _r, group, limit) => {
        rec.logReads.push(`${group}:${limit}`);
        return ["START RequestId: 1", "GET /api/health 200"];
      },
      listDatabaseTables: async (o) => {
        rec.dbReads.push(`${o.instanceId}:${o.kind}`);
        return [{ name: "users", rows: 2 }];
      },
      readDatabaseTable: async (o) => {
        rec.dbReads.push(`${o.instanceId}:${o.kind}:${o.table}:${o.offset}:${o.limit}`);
        if (o.table !== "users") return null;
        return {
          columns: ["id", "email"],
          rows: [{ id: "1", email: "a@x.com" }],
          total: 2,
          offset: o.offset,
          limit: o.limit,
        };
      },
    });
    await app.ready();
    apps.push(app);

    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email: `pipe-${Date.now()}-${Math.random()}@example.com`,
        password: "correct horse battery staple",
      },
    });
    const c = Object.fromEntries(signup.cookies.map((k) => [k.name, k.value]));
    const headers = {
      cookie: `ai_session=${c.ai_session}; ai_csrf=${c.ai_csrf}`,
      "x-csrf-token": c.ai_csrf!,
    };
    const connection = await prisma.awsConnection.create({
      data: {
        userId: signup.json().id,
        // An AWS account of its own: the one free EC2 instance is per account.
        roleArn: `arn:aws:iam::${String(Math.random()).slice(2, 14).padEnd(12, "7")}:role/AutoInfraDeployRole`,
        externalId: "x",
        region: "ap-south-1",
        verifiedAt: new Date(),
        accountRegime: "free_plan",
        planStateJson: { eligibleInstanceTypes: ["t3.micro"] },
        templateVersion:
          opts.templateVersion === undefined ? DEPLOY_ROLE_TEMPLATE_VERSION : opts.templateVersion,
      },
    });
    const { id } = (
      await app.inject({
        method: "POST",
        url: "/deployments",
        headers,
        payload: {
          repoUrl: "https://github.com/example/app",
          awsConnectionId: connection.id,
          freeTierMode: opts.freeTierMode ?? "strict",
        },
      })
    ).json();
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, headers, payload });
    /** Waits until nothing runs for the deployment (a chain hands off without a gap). */
    const settle = async () => {
      for (let i = 0; i < 200; i++) {
        if (!(await prisma.job.count({ where: { deploymentId: id, status: "running" } }))) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("jobs did not settle");
    };
    if (!opts.skipPrepare) {
      const analyzed = await call("POST", `/deployments/${id}/analyze`, { then: ["design"] });
      expect(analyzed.statusCode).toBe(202);
      await settle();
    }

    const waitForJob = async (jobId: string) => {
      for (let i = 0; i < 100; i++) {
        const res = (await call("GET", `/jobs/${jobId}/logs`)).json();
        if (res.status !== "running") return res;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error("job did not finish");
    };
    const generate = async () => {
      const res = await call("POST", `/deployments/${id}/generate`);
      expect(res.statusCode).toBe(202);
      return waitForJob(res.json().jobId);
    };
    return { app, id, headers, rec, call, waitForJob, generate, settle };
  }

  afterAll(async () => {
    for (const app of apps) await app.close();
    await prisma.$disconnect();
  });

  it("paste-a-link: one request runs analyze, design and generate on the worker, stopping at review", async () => {
    const t = await setup({ skipPrepare: true });
    const res = await t.call("POST", `/deployments/${t.id}/analyze`, {
      then: ["design", "generate"],
    });
    expect(res.statusCode).toBe(202);
    await t.settle();

    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("awaiting_approval");
    expect(detail.pattern).toBe("F1");
    expect(detail.latestRevision.architecturePlan.pattern).toBe("F1");
    expect(detail.latestRevision.terraformBundle.passed).toBe(true);
    const jobs = await prisma.job.findMany({
      where: { deploymentId: t.id },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([
      ["analyze", "succeeded"],
      ["design", "succeeded"],
      ["generate", "succeeded"],
    ]);
    // Every step worked on the same revision.
    expect(new Set(jobs.map((j) => j.revisionId)).size).toBe(1);
    expect(t.rec.gavInputs).toHaveLength(1);
    const analyzeLog = (await t.call("GET", `/jobs/${jobs[0]!.id}/logs`)).json();
    expect(analyzeLog.logs.map((l: { line: string }) => l.line)).toEqual(
      expect.arrayContaining(["Suggested pattern: F1", "Next: designing the architecture"]),
    );
    // Three steps end to end: well past 5 s when every suite runs in parallel.
  }, 20_000);

  it("paste-a-link: a chain needing the deploy role refuses up front when it can't be assumed", async () => {
    const t = await setup({
      skipPrepare: true,
      apiAssume: async () => {
        throw new Error("AccessDenied");
      },
    });
    const res = await t.call("POST", `/deployments/${t.id}/analyze`, {
      then: ["design", "generate"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("assume_role_failed");
    expect(await prisma.job.count({ where: { deploymentId: t.id } })).toBe(0);
    // generate can only follow design.
    expect(
      (await t.call("POST", `/deployments/${t.id}/analyze`, { then: ["generate"] })).json().error,
    ).toBe("invalid_input");
  });

  it("generate: fails fast before spending tokens when the role can't be assumed", async () => {
    const t = await setup({
      apiAssume: async () => {
        throw new Error("AccessDenied");
      },
    });
    const res = await t.call("POST", `/deployments/${t.id}/generate`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("assume_role_failed");
    expect(t.rec.gavInputs).toHaveLength(0);
  });

  it("AWS out of reach for a moment is not a broken role: try again, nothing to re-verify", async () => {
    let reachable = false;
    const t = await setup({
      apiAssume: async () => {
        if (!reachable)
          throw Object.assign(new Error("connect ETIMEDOUT 52.95.1.1:443"), {
            name: "TimeoutError",
          });
        return creds;
      },
    });
    const put = (value: string) =>
      t.call("PUT", `/deployments/${t.id}/env`, {
        vars: [{ name: "LOG_LEVEL", value, isSecret: false }],
      });
    const offline = await put("info");
    expect(offline.statusCode).toBe(400);
    expect(offline.json()).toMatchObject({
      error: "aws_unreachable",
      message: expect.stringContaining("try again in a minute"),
    });
    reachable = true;
    expect((await put("info")).statusCode).toBe(200);
  });

  it("generate: runs on the worker path, uses platform-decided tfvars, and reaches awaiting_approval", async () => {
    const t = await setup();
    const job = await t.generate();
    expect(job.status).toBe("succeeded");
    const input = t.rec.gavInputs[0] as {
      tfvars: { function_url_auth_type: string; short_id: string };
      credentials: unknown;
    };
    expect(input.tfvars.function_url_auth_type).toBe("AWS_IAM"); // react-express has no write routes
    expect(input.tfvars.short_id).toBe(t.id.replace(/-/g, "").slice(0, 8));
    expect(input.credentials).toEqual(creds);
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("awaiting_approval");
  });

  it("generate: a failed validation keeps the artifacts and a readable reason", async () => {
    const t = await setup({
      gav: async () => ({
        passed: false,
        bundle: { files: [{ path: "main.tf", content: "broken" }] },
        attempts: [],
        failureReason: "Terraform still failed validation after 4 attempts.",
      }),
    });
    const job = await t.generate();
    expect(job.status).toBe("failed");
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.failureReason).toContain("after 4 attempts");
    expect(detail.latestRevision.terraformBundle.files[0].content).toBe("broken");
  });

  it("env vars: values go to SSM, only names are stored, reserved names are refused", async () => {
    const t = await setup();
    const bad = await t.call("PUT", `/deployments/${t.id}/env`, {
      vars: [{ name: "AWS_SECRET_ACCESS_KEY", value: "x", isSecret: true }],
    });
    expect(bad.statusCode).toBe(400);

    const blank = await t.call("PUT", `/deployments/${t.id}/env`, {
      vars: [{ name: "JWT_SECRET", value: "  \n", isSecret: true }],
    });
    expect(blank.json().message).toBe('"JWT_SECRET" is empty');

    // Copied with a trailing line break and spaces: stored without them.
    const ok = await t.call("PUT", `/deployments/${t.id}/env`, {
      vars: [
        { name: "JWT_SECRET", value: "s3cr3t-value\r\n", isSecret: true },
        { name: " LOG_LEVEL ", value: " info ", isSecret: false },
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(t.rec.params).toEqual([
      {
        name: "JWT_SECRET",
        value: "s3cr3t-value",
        isSecret: true,
        shortId: t.id.replace(/-/g, "").slice(0, 8),
      },
      {
        name: "LOG_LEVEL",
        value: "info",
        isSecret: false,
        shortId: t.id.replace(/-/g, "").slice(0, 8),
      },
    ]);

    const listed = (await t.call("GET", `/deployments/${t.id}/env`)).json();
    expect(listed.vars).toEqual([
      { name: "JWT_SECRET", isSecret: true, set: true },
      { name: "LOG_LEVEL", isSecret: false, set: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain("s3cr3t-value");
    const rows = await prisma.envVar.findMany({ where: { deploymentId: t.id } });
    expect(JSON.stringify(rows)).not.toContain("s3cr3t-value");
    const audit = await prisma.auditEvent.findMany({
      where: { targetId: t.id, action: "env_vars_set" },
    });
    expect(JSON.stringify(audit)).not.toContain("s3cr3t-value");

    const del = await t.call("DELETE", `/deployments/${t.id}/env/LOG_LEVEL`);
    expect(del.statusCode).toBe(204);
    expect(t.rec.deletedParams).toEqual([
      `/autoinfra/${t.id.replace(/-/g, "").slice(0, 8)}/LOG_LEVEL`,
    ]);
  });

  it("logs: the running app's own logs -- Lambda's, an instance container's; nothing before AWS", async () => {
    const t = await setup();
    const before = await t.call("GET", `/deployments/${t.id}/logs`);
    expect(before.statusCode).toBe(409);
    expect(before.json().error).toBe("no_logs");

    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
    // The mocked apply outputs a Lambda (F1): its CloudWatch log group.
    const lambda = (await t.call("GET", `/deployments/${t.id}/logs?lines=50`)).json();
    expect(lambda).toEqual({
      source: "lambda",
      service: "lambda",
      lines: ["START RequestId: 1", "GET /api/health 200"],
    });
    expect(t.rec.logReads).toEqual(["/aws/lambda/autoinfra-x-api:50"]);

    // An F2 deployment: the chosen container on its instance.
    const current = await prisma.deployment.findUniqueOrThrow({ where: { id: t.id } });
    await prisma.revision.update({
      where: { id: current.currentRevisionId! },
      data: { outputs: { instance_id: "i-0abc", cloudfront_domain_name: "d111.cloudfront.net" } },
    });
    const app = (await t.call("GET", `/deployments/${t.id}/logs?service=db`)).json();
    expect(app.source).toBe("instance");
    expect(t.rec.logReads.at(-1)).toBe("i-0abc:db:200");

    const bad = await t.call("GET", `/deployments/${t.id}/logs?service=app;reboot`);
    expect(bad.statusCode).toBe(400);
    expect(t.rec.logReads).toHaveLength(2); // refused before anything ran
  });

  it("database viewer: the F2 db container's tables and rows; nothing for a Lambda, an outside database or a bad name", async () => {
    const t = await setup();
    const before = await t.call("GET", `/deployments/${t.id}/database`);
    expect(before.statusCode).toBe(409);
    expect(before.json().error).toBe("no_database");

    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
    const current = await prisma.deployment.findUniqueOrThrow({ where: { id: t.id } });
    const revision = await prisma.revision.findUniqueOrThrow({
      where: { id: current.currentRevisionId! },
    });
    const profile = revision.repoProfile as Prisma.JsonObject;
    const setRevision = (profileChanges: Prisma.JsonObject, outputs: Prisma.JsonObject) =>
      prisma.revision.update({
        where: { id: revision.id },
        data: { repoProfile: { ...profile, ...profileChanges }, outputs },
      });

    // A Lambda (F1) with no database container: nothing to show.
    await setRevision({ database: "none" }, { function_name: "autoinfra-x-api" });
    expect((await t.call("GET", `/deployments/${t.id}/database`)).statusCode).toBe(409);
    // A database hosted outside AWS: its own console.
    await setRevision(
      { database: "postgres", databaseExternal: true, databaseHostedAt: "neon.tech" },
      { instance_id: "i-0abc" },
    );
    const outside = await t.call("GET", `/deployments/${t.id}/database`);
    expect(outside.statusCode).toBe(409);
    expect(outside.json().message).toContain("neon.tech");
    expect(t.rec.dbReads).toEqual([]);

    // AutoInfra's Postgres container on the instance.
    await setRevision({ database: "postgres", databaseExternal: false }, { instance_id: "i-0abc" });
    const list = await t.call("GET", `/deployments/${t.id}/database`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ kind: "postgres", tables: [{ name: "users", rows: 2 }] });
    const rows = await t.call("GET", `/deployments/${t.id}/database/rows?table=users&offset=25`);
    expect(rows.json()).toMatchObject({
      kind: "postgres",
      table: "users",
      columns: ["id", "email"],
      total: 2,
      offset: 25,
      limit: 25,
    });
    expect(t.rec.dbReads).toEqual(["i-0abc:postgres", "i-0abc:postgres:users:25:25"]);

    // A name that could break out of the query never reaches the instance.
    const bad = await t.call(
      "GET",
      `/deployments/${t.id}/database/rows?table=${encodeURIComponent('users"; DROP TABLE users; --')}`,
    );
    expect(bad.statusCode).toBe(400);
    expect(
      (await t.call("GET", `/deployments/${t.id}/database/rows?table=users&limit=500`)).statusCode,
    ).toBe(400);
    expect(t.rec.dbReads).toHaveLength(2);
    const gone = await t.call("GET", `/deployments/${t.id}/database/rows?table=gone`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("table_not_found");
  });

  it("approve: refuses before validation, asks about missing env vars, then deploys to a live URL", async () => {
    const t = await setup();
    expect((await t.call("POST", `/deployments/${t.id}/approve`, {})).statusCode).toBe(400);
    await t.generate();

    // react-express reads process.env.PORT -- reserved, so nothing is missing.
    const res = await t.call("POST", `/deployments/${t.id}/approve`, {});
    expect(res.statusCode).toBe(202);
    const job = await t.waitForJob(res.json().jobId);
    expect(job.status).toBe("succeeded");
    const lines = job.logs.map((l: { line: string }) => l.line).join("\n");
    expect(lines).toContain("Apply complete!");
    expect(lines).toContain("[build] npm run build");
    expect(lines).toContain("Live at https://d111.cloudfront.net");
    // The status follows CodeBuild: building, then deploying once it rolls out.
    const order = [
      "== building ==",
      "[build] npm run build",
      "== deploying ==",
      "[build] [Container] Running command bash .autoinfra/rollout.sh",
      "== health checking ==",
    ].map((step) => lines.indexOf(step));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);

    const apply = t.rec.applyInputs[0]!;
    expect(apply.backend).toEqual({
      bucket: "autoinfra-tfstate-222222222222-ap-south-1",
      key: `deployments/${t.id}/terraform.tfstate`,
      region: "ap-south-1",
    });
    expect(apply.approvedPlan).toEqual(approvedPlan);
    expect(t.rec.uploads).toEqual([
      { bucket: "autoinfra-x-artifacts", key: "source/latest.zip", size: expect.any(Number) },
    ]);
    expect(t.rec.fetched).toEqual(
      expect.arrayContaining([
        "https://d111.cloudfront.net/",
        "https://d111.cloudfront.net/api/health",
      ]),
    );

    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("live");
    expect(detail.liveUrl).toBe("https://d111.cloudfront.net");
    expect(detail.latestRevision.outputs.codebuild_project).toBe("autoinfra-x-build");
    const audit = await prisma.auditEvent.findMany({ where: { targetId: t.id } });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["deployment_approved", "deployment_applied"]),
    );
  });

  it("approve: lists env vars detected in the repo that have no value", async () => {
    const t = await setup();
    await t.generate();
    const revision = await prisma.revision.findFirstOrThrow({
      where: { deploymentId: t.id },
      orderBy: { number: "desc" },
    });
    const profile = revision.repoProfile as { envVars: Array<{ name: string; isSecret: boolean }> };
    await prisma.revision.update({
      where: { id: revision.id },
      data: {
        repoProfile: {
          ...profile,
          envVars: [...profile.envVars, { name: "STRIPE_KEY", isSecret: true }],
        },
      },
    });
    const res = await t.call("POST", `/deployments/${t.id}/approve`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().missing).toEqual(["STRIPE_KEY"]);
    expect(
      (await t.call("POST", `/deployments/${t.id}/approve`, { acceptMissingEnv: true })).statusCode,
    ).toBe(202);
  });

  it("approve: flexible mode requires an explicit paid-resource confirmation; strict refuses", async () => {
    const flex = await setup({
      freeTierMode: "flexible",
      gav: passingGav({ violations: ["aws_nat_gateway.nat: NAT"] }),
    });
    await flex.generate();
    const noConfirm = await flex.call("POST", `/deployments/${flex.id}/approve`, {});
    expect(noConfirm.statusCode).toBe(409);
    expect(noConfirm.json().error).toBe("paid_resources_need_confirmation");
    expect(
      (await flex.call("POST", `/deployments/${flex.id}/approve`, { confirmPaidResources: true }))
        .statusCode,
    ).toBe(202);

    const strict = await setup({ gav: passingGav({ violations: ["aws_nat_gateway.nat: NAT"] }) });
    await strict.generate();
    expect(
      (
        await strict.call("POST", `/deployments/${strict.id}/approve`, {
          confirmPaidResources: true,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("deploy failure: a failed build fails the deployment with a readable reason, and can be retried", async () => {
    const t = await setup({ build: "FAILED" });
    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("failed");
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("failed");
    expect(detail.failureReason).toContain("CodeBuild build failed");
    // Same validated bundle can be retried.
    expect((await t.call("POST", `/deployments/${t.id}/approve`, {})).statusCode).toBe(202);
  });

  it("live, but its startup log says it can't reach its database: the live page says so", async () => {
    const t = await setup({
      buildOutput: [
        "=== error lines in the app's startup log ===",
        "app-1  | ❌ MongoDB Connection Error: querySrv ENOTFOUND _mongodb._tcp.cluster0.dqbopmt.mongodb.net",
      ],
    });
    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("live");
    expect(detail.currentRevision.startupWarning).toMatch(
      /^The app couldn't find the host "cluster0\.dqbopmt\.mongodb\.net"/,
    );
    const lines = job.logs.map((l: { line: string }) => l.line).join("\n");
    expect(lines).toContain("The app is up, but its startup log shows a problem:");
  });

  it("deploy failure: an app that can't start says why in plain words, not only 'see the log'", async () => {
    const t = await setup({
      build: "FAILED",
      buildOutput: [
        "--- errors from the instance ---",
        "Migration failed: error: password authentication failed for user 'neondb_owner'",
      ],
    });
    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("failed");
    const { failureReason } = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(failureReason).toMatch(
      /^The database refused the app's password for user "neondb_owner"\. /,
    );
    expect(failureReason).toContain("(The CodeBuild build failed (build:1)");
  });

  it("health check failure surfaces the Lambda logs", async () => {
    const t = await setup({ apiHealthy: false });
    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("failed");
    const lines = job.logs.map((l: { line: string }) => l.line).join("\n");
    expect(lines).toContain("Cannot find module 'express'");
    expect(lines).toContain("health check failed");
  });

  it("SSE log stream replays the backlog and ends for a finished job; other users get 404", async () => {
    const t = await setup();
    const job = await t.generate();
    const jobId = (
      await prisma.job.findFirstOrThrow({ where: { deploymentId: t.id, kind: "generate" } })
    ).id;
    expect(job.status).toBe("succeeded");
    const res = await t.call("GET", `/jobs/${jobId}/logs/stream`);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: log");
    expect(res.body).toContain("attempt 1 · plan: passed");
    expect(res.body).toContain("event: end");

    const other = await setup();
    const peek = await other.call("GET", `/jobs/${jobId}/logs/stream`);
    expect(peek.statusCode).toBe(404);
  });

  // --- Milestone 8: history, diffs, redeploy.

  async function goLive(t: Awaited<ReturnType<typeof setup>>) {
    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
  }

  it("redeploy: refused until the deployment has been live", async () => {
    const t = await setup();
    await t.generate();
    const res = await t.call("POST", `/deployments/${t.id}/redeploy`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("nothing_to_redeploy");
  });

  it("redeploy: ships the new commit on unchanged infrastructure and records history", async () => {
    const t = await setup();
    await goLive(t);
    headSha = "2222222222222222222222222222222222222222";

    const res = await t.call("POST", `/deployments/${t.id}/redeploy`, {});
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ revision: 2, commitSha: headSha, unchanged: false });
    expect((await t.waitForJob(res.json().jobId)).status).toBe("succeeded");

    // The apply step re-planned with "no changes" as the approved plan, and
    // the build used the new commit.
    expect(t.rec.applyInputs).toHaveLength(2);
    expect(t.rec.applyInputs[1]!.approvedPlan.resources).toEqual([]);
    expect(t.rec.applyInputs[1]!.bundle).toEqual(t.rec.applyInputs[0]!.bundle);

    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("live");
    expect(detail.currentRevision).toEqual({
      number: 2,
      commitSha: headSha,
      outboundIp: null,
      startupWarning: null,
    });

    const history = (await t.call("GET", `/deployments/${t.id}/revisions`)).json();
    expect(
      history.map((r: { number: number; action: string; status: string; isCurrent: boolean }) => [
        r.number,
        r.action,
        r.status,
        r.isCurrent,
      ]),
    ).toEqual([
      [2, "redeploy", "live", true],
      [1, "initial", "superseded", false],
    ]);

    const diff = (await t.call("GET", `/deployments/${t.id}/revisions/2/diff`)).json();
    expect(diff.from.number).toBe(1);
    expect(diff.commitChanged).toBe(true);
    expect(diff.compareUrl).toBe(
      `https://github.com/example/app/compare/${FIRST_SHA}...${headSha}`,
    );
    expect(diff.files).toEqual([]); // same infrastructure
    expect(diff.components).toEqual({ added: [], removed: [], changed: [] });
  });

  it("redeploy: refuses infrastructure drift, keeps the site on the previous revision", async () => {
    const t = await setup({ drift: ["update aws_cloudfront_distribution.cdn"] });
    await goLive(t);
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/redeploy`, {})).json().jobId,
    );
    expect(job.status).toBe("failed");
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.failureReason).toContain("Redeploy only ships new code");
    expect(detail.failureReason).toContain("update aws_cloudfront_distribution.cdn");
    expect(detail.liveUrl).toBe("https://d111.cloudfront.net");
    expect(detail.currentRevision.number).toBe(1);
    expect(t.rec.uploads).toHaveLength(1); // nothing was built for the refused redeploy
  });

  it("diff: shows changed Terraform files and architecture components between revisions", async () => {
    const t = await setup();
    await goLive(t);
    const first = await prisma.revision.findFirstOrThrow({ where: { deploymentId: t.id } });
    const bundle = first.terraformBundle as { files: Array<{ path: string; content: string }> };
    const plan = first.architecturePlan as typeof validF1;
    await prisma.revision.create({
      data: {
        deploymentId: t.id,
        number: 2,
        commitSha: first.commitSha,
        status: "awaiting_approval",
        action: "change",
        architecturePlan: {
          ...plan,
          components: [
            ...plan.components,
            { service: "aws_dynamodb_table", name: "notes", purpose: "storage" },
          ],
        },
        terraformBundle: {
          ...bundle,
          files: [
            {
              path: "main.tf",
              content: 'resource "aws_s3_bucket" "frontend" {\n  force_destroy = true\n}',
            },
            { path: "app/run.sh", content: bundle.files[1]!.content },
            { path: "storage.tf", content: 'resource "aws_dynamodb_table" "notes" {}' },
          ],
        },
      },
    });

    const diff = (await t.call("GET", `/deployments/${t.id}/revisions/2/diff?against=1`)).json();
    expect(diff.commitChanged).toBe(false);
    expect(diff.compareUrl).toBeNull();
    expect(diff.components.added).toEqual(["aws_dynamodb_table.notes"]);
    expect(diff.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ["main.tf", "modified"],
      ["storage.tf", "added"],
    ]);

    const history = (await t.call("GET", `/deployments/${t.id}/revisions`)).json();
    expect(history[0]).toMatchObject({ number: 2, action: "change", status: "awaiting_approval" });
    expect(history[1]).toMatchObject({ number: 1, status: "live", isCurrent: true });
  });

  it("revision history is private to the deployment's owner", async () => {
    const t = await setup();
    await t.generate();
    const other = await setup();
    for (const url of [
      `/deployments/${t.id}/revisions`,
      `/deployments/${t.id}/revisions/1`,
      `/deployments/${t.id}/revisions/1/diff`,
    ]) {
      expect((await other.call("GET", url)).statusCode).toBe(404);
    }
    expect((await other.call("POST", `/deployments/${t.id}/redeploy`, {})).statusCode).toBe(404);
  });

  it("database app on F2: never asks for DB settings; the live URL and NODE_ENV are set by AutoInfra", async () => {
    const t = await setup({
      fixture: "express-mysql",
      design: {
        ...validF1,
        pattern: "F2",
        components: [
          { service: "aws_s3_bucket", name: "frontend", purpose: "static assets" },
          { service: "aws_cloudfront_distribution", name: "cdn", purpose: "routing" },
          {
            service: "aws_instance",
            name: "app",
            purpose: "API + MySQL",
            instanceType: "t3.micro",
          },
        ],
      },
    });
    await t.generate();

    const env = (await t.call("GET", `/deployments/${t.id}/env`)).json();
    expect(env.missing).toEqual([]);
    expect(env.provided).toEqual(
      expect.arrayContaining([
        { name: "DB_HOST", how: "database" },
        { name: "DB_PASSWORD", how: "database" },
        { name: "CLIENT_URL", how: "live_url" },
        { name: "NODE_ENV", how: "production" },
      ]),
    );

    // No "env vars missing" question: AutoInfra wires all of them.
    const res = await t.call("POST", `/deployments/${t.id}/approve`, {});
    expect(res.statusCode).toBe(202);
    expect((await t.waitForJob(res.json().jobId)).status).toBe("succeeded");
    expect(t.rec.params.map((p) => [p.name, p.value])).toEqual(
      expect.arrayContaining([
        ["CLIENT_URL", "https://d111.cloudfront.net"],
        ["NODE_ENV", "production"],
      ]),
    );
    // Database settings are wired inside the instance, never stored as values.
    expect(t.rec.params.some((p) => p.name.startsWith("DB_"))).toBe(false);
  });

  it("a value the user set themselves wins over AutoInfra's", async () => {
    const t = await setup({
      fixture: "express-mysql",
      design: {
        ...validF1,
        pattern: "F2",
        components: [
          {
            service: "aws_instance",
            name: "app",
            purpose: "API + MySQL",
            instanceType: "t3.micro",
          },
        ],
      },
    });
    await t.generate();
    await t.call("PUT", `/deployments/${t.id}/env`, {
      vars: [{ name: "CLIENT_URL", value: "https://todo.example.com", isSecret: false }],
    });
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
    expect(t.rec.params.filter((p) => p.name === "CLIENT_URL").map((p) => p.value)).toEqual([
      "https://todo.example.com",
    ]);
  });

  // --- Milestone 10: destroy.

  it("destroy: needs the repo name typed, then removes infra + SSM values and checks for leftovers", async () => {
    const t = await setup();
    await goLive(t);
    await t.call("PUT", `/deployments/${t.id}/env`, {
      vars: [{ name: "JWT_SECRET", value: "x", isSecret: true }],
    });

    const wrong = await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "nope" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().message).toContain("example/app");

    const res = await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" });
    expect(res.statusCode).toBe(202);
    const job = await t.waitForJob(res.json().jobId);
    expect(job.status).toBe("succeeded");

    // Destroyed with the bundle that was applied, against the real state key.
    expect(t.rec.destroyInputs).toHaveLength(1);
    expect(t.rec.destroyInputs[0]!.backend.key).toBe(`deployments/${t.id}/terraform.tfstate`);
    expect(t.rec.destroyInputs[0]!.bundle).toEqual(t.rec.applyInputs[0]!.bundle);
    expect(t.rec.deletedParams).toContain(`/autoinfra/${t.id.replace(/-/g, "").slice(0, 8)}`);

    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("destroyed");
    expect(detail.liveUrl).toBeNull();
    expect(detail.failureReason).toBeNull();
    expect((await t.call("GET", `/deployments/${t.id}/env`)).json().vars).toEqual([]);
    const lines = job.logs.map((l: { line: string }) => l.line).join("\n");
    expect(lines).toContain("No resources tagged with this deployment remain.");

    const again = await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" });
    expect(again.json().error).toBe("already_destroyed");
  });

  it("destroy: reports leftovers it can still see", async () => {
    const t = await setup({ leftovers: ["arn:aws:cloudfront::222222222222:distribution/E1"] });
    await goLive(t);
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" })).json()
        .jobId,
    );
    expect(job.status).toBe("succeeded");
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("destroyed");
    expect(detail.failureReason).toContain("distribution/E1");
  });

  it("destroy: a failed terraform destroy can be run again", async () => {
    const t = await setup({ destroyFails: true });
    await goLive(t);
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" })).json()
        .jobId,
    );
    expect(job.status).toBe("failed");
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("failed");
    expect(detail.failureReason).toContain("run Destroy again");
    expect(
      (await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" })).statusCode,
    ).toBe(202);
  });

  it("destroy: refused while the AWS role is on an older permission set", async () => {
    const t = await setup({ templateVersion: null });
    await goLive(t);
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.connection.needsPermissionUpdate).toBe(true);
    const res = await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("permissions_outdated");
    expect(t.rec.destroyInputs).toHaveLength(0);
  });

  it("destroy: a deployment that never deployed is simply marked destroyed", async () => {
    const t = await setup({ templateVersion: null });
    await t.generate();
    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/destroy`, { confirm: "example/app" })).json()
        .jobId,
    );
    expect(job.status).toBe("succeeded");
    expect(t.rec.destroyInputs).toHaveLength(0);
    expect((await t.call("GET", `/deployments/${t.id}`)).json().status).toBe("destroyed");
  });

  // --- Milestone 9: change requests + AI diagnosis.

  /** A gav that records each call and returns a plan with the given resource changes. */
  function changeGav(resources: PlanSummary["resources"], dataBearingDestroys: string[] = []) {
    const base = passingGav();
    let calls = 0;
    return (async (llm, input) => {
      calls++;
      const result = await base(llm, input);
      // The first call is the initial deploy; later ones are change requests.
      if (calls === 1) return result;
      return {
        ...result,
        bundle: {
          files: [
            ...result.bundle!.files,
            { path: "logs.tf", content: 'resource "aws_cloudwatch_log_group" "extra" {}' },
          ],
        },
        planSummary: {
          adds: resources.filter((r) => r.action === "create").length,
          changes: resources.filter((r) => r.action === "update").length,
          destroys: 0,
          replaces: resources.filter((r) => r.action === "replace").length,
          resources,
          dataBearingDestroys,
        },
      };
    }) as PipelineDeps["generateAndValidate"];
  }

  it("change request: Gemini edits the live files, you review the plan, approving applies it", async () => {
    const t = await setup({
      gav: changeGav([
        {
          address: "aws_cloudwatch_log_group.extra",
          type: "aws_cloudwatch_log_group",
          action: "create",
          dataBearing: false,
        },
      ]),
    });
    expect(
      (await t.call("POST", `/deployments/${t.id}/changes`, { prompt: "add a log group" })).json()
        .error,
    ).toBe("not_live");
    await goLive(t);
    expect(
      (await t.call("POST", `/deployments/${t.id}/changes`, { prompt: "hi" })).statusCode,
    ).toBe(400);

    const res = await t.call("POST", `/deployments/${t.id}/changes`, {
      prompt: "Keep logs for 14 days in a new log group",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().revision).toBe(2);
    expect((await t.waitForJob(res.json().jobId)).status).toBe("succeeded");

    // Gemini got the live files and the request, not a blank slate.
    const changeInput = t.rec.gavInputs[1] as {
      change?: { files: Array<{ path: string }>; request: string };
    };
    expect(changeInput.change?.request).toBe("Keep logs for 14 days in a new log group");
    expect(changeInput.change?.files.map((f) => f.path)).toEqual(["main.tf", "app/run.sh"]);

    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("awaiting_approval");
    expect(detail.liveUrl).toBe("https://d111.cloudfront.net"); // still serving revision 1
    expect(detail.latestRevision).toMatchObject({ number: 2, action: "change" });
    expect(detail.latestRevision.changePrompt).toBe("Keep logs for 14 days in a new log group");

    const diff = (await t.call("GET", `/deployments/${t.id}/revisions/2/diff`)).json();
    expect(diff.files.map((f: { path: string; status: string }) => [f.path, f.status])).toEqual([
      ["logs.tf", "added"],
    ]);

    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
    expect(t.rec.applyInputs[1]!.approvedPlan.resources[0]!.address).toBe(
      "aws_cloudwatch_log_group.extra",
    );
    expect((await t.call("GET", `/deployments/${t.id}`)).json().currentRevision.number).toBe(2);
  });

  it("change request: replacing a data-bearing resource needs an explicit confirmation", async () => {
    const t = await setup({
      gav: changeGav(
        [
          {
            address: "aws_s3_bucket.frontend",
            type: "aws_s3_bucket",
            action: "replace",
            dataBearing: true,
          },
        ],
        ["aws_s3_bucket.frontend"],
      ),
    });
    await goLive(t);
    await t.waitForJob(
      (
        await t.call("POST", `/deployments/${t.id}/changes`, {
          prompt: "rename the frontend bucket",
        })
      ).json().jobId,
    );
    const refused = await t.call("POST", `/deployments/${t.id}/approve`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("data_loss_needs_confirmation");
    expect(refused.json().resources).toEqual(["aws_s3_bucket.frontend"]);
    expect(
      (await t.call("POST", `/deployments/${t.id}/approve`, { confirmDataLoss: true })).statusCode,
    ).toBe(202);
  });

  it("change request: a pending change can be discarded until it touches AWS", async () => {
    const t = await setup({
      gav: changeGav([
        {
          address: "aws_cloudwatch_log_group.extra",
          type: "aws_cloudwatch_log_group",
          action: "create",
          dataBearing: false,
        },
      ]),
    });
    await goLive(t);
    expect((await t.call("POST", `/deployments/${t.id}/changes/discard`)).json().error).toBe(
      "nothing_to_discard",
    );
    await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/changes`, { prompt: "add a log group" })).json()
        .jobId,
    );
    const discard = await t.call("POST", `/deployments/${t.id}/changes/discard`);
    expect(discard.json()).toEqual({ discarded: 2 });

    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("live");
    expect(detail.latestRevision.number).toBe(1);
    expect((await t.call("POST", `/deployments/${t.id}/approve`, {})).json().error).toBe(
      "not_ready",
    );
    // Neither the live revision nor a dropped one is regenerated in place.
    expect((await t.call("POST", `/deployments/${t.id}/generate`)).json().error).toBe(
      "nothing_to_generate",
    );
    const history = (await t.call("GET", `/deployments/${t.id}/revisions`)).json();
    expect(history.map((r: { number: number; status: string }) => [r.number, r.status])).toEqual([
      [2, "discarded"],
      [1, "live"],
    ]);
    expect(t.rec.applyInputs).toHaveLength(1);

    // Once a change has been (even partly) applied, it can't be discarded.
    const next = await t.call("POST", `/deployments/${t.id}/changes`, { prompt: "add it again" });
    expect(next.json().revision).toBe(3);
    await t.waitForJob(next.json().jobId);
    await prisma.job.create({
      data: {
        deploymentId: t.id,
        revisionId: (
          await prisma.revision.findFirstOrThrow({ where: { deploymentId: t.id, number: 3 } })
        ).id,
        kind: "apply",
        status: "failed",
      },
    });
    expect((await t.call("POST", `/deployments/${t.id}/changes/discard`)).json().error).toBe(
      "already_applied",
    );
  });

  // --- Milestone 10: rollback.

  it("rollback: re-checks an earlier revision's Terraform without Gemini, then restores it on approval", async () => {
    const changed = changeGav([
      {
        address: "aws_cloudwatch_log_group.extra",
        type: "aws_cloudwatch_log_group",
        action: "create",
        dataBearing: false,
      },
    ]);
    const undo: PlanSummary = {
      adds: 0,
      changes: 0,
      destroys: 1,
      replaces: 0,
      resources: [
        {
          address: "aws_cloudwatch_log_group.extra",
          type: "aws_cloudwatch_log_group",
          action: "delete",
          dataBearing: false,
        },
      ],
      dataBearingDestroys: [],
    };
    const t = await setup({
      gav: async (llm, input) => {
        if (!input.reuse) return changed(llm, input);
        const result = await passingGav()(llm, input);
        return { ...result, bundle: input.reuse, planSummary: undo };
      },
    });
    await goLive(t); // #1
    await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/changes`, { prompt: "add a log group" })).json()
        .jobId,
    );
    await t.waitForJob((await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId); // #2
    headSha = "2222222222222222222222222222222222222222";
    await t.waitForJob((await t.call("POST", `/deployments/${t.id}/redeploy`, {})).json().jobId); // #3
    expect((await t.call("GET", `/deployments/${t.id}`)).json().currentRevision).toEqual({
      number: 3,
      commitSha: headSha,
      outboundIp: null,
      startupWarning: null,
    });

    expect(
      (await t.call("POST", `/deployments/${t.id}/rollback`, { toRevision: 3 })).json().error,
    ).toBe("already_live");
    expect(
      (await t.call("POST", `/deployments/${t.id}/rollback`, { toRevision: 9 })).json().error,
    ).toBe("not_a_live_revision");

    const res = await t.call("POST", `/deployments/${t.id}/rollback`, { toRevision: 1 });
    expect(res.statusCode).toBe(202);
    expect(res.json().revision).toBe(4);
    expect((await t.waitForJob(res.json().jobId)).status).toBe("succeeded");

    // The gauntlet got revision 1's files to re-check; no model call was needed.
    const input = t.rec.gavInputs.at(-1) as { reuse?: { files: Array<{ path: string }> } };
    expect(input.reuse?.files.map((f) => f.path)).toEqual(["main.tf", "app/run.sh"]);
    const detail = (await t.call("GET", `/deployments/${t.id}`)).json();
    expect(detail.status).toBe("awaiting_approval");
    expect(detail.latestRevision).toMatchObject({ number: 4, action: "rollback", rollbackOf: 1 });
    expect(detail.latestRevision.commitSha).toBe(FIRST_SHA);
    expect(detail.currentRevision.number).toBe(3); // still serving #3 until approved
    expect(
      (await t.call("POST", `/deployments/${t.id}/rollback`, { toRevision: 2 })).json().error,
    ).toBe("deployment_busy");

    const job = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(job.status).toBe("succeeded");
    const applied = t.rec.applyInputs.at(-1)!;
    expect(applied.bundle.files.map((f) => f.path)).toEqual(["main.tf", "app/run.sh"]);
    expect(applied.approvedPlan.resources[0]).toMatchObject({ action: "delete" });
    expect((await t.call("GET", `/deployments/${t.id}`)).json().currentRevision).toEqual({
      number: 4,
      commitSha: FIRST_SHA,
      outboundIp: null,
      startupWarning: null,
    });
    const history = (await t.call("GET", `/deployments/${t.id}/revisions`)).json();
    expect(history[0]).toMatchObject({
      number: 4,
      action: "rollback",
      rollbackOf: 1,
      isCurrent: true,
    });
  });

  it("rollback: refused across architectures and for other users", async () => {
    const t = await setup();
    await goLive(t);
    await t.waitForJob((await t.call("POST", `/deployments/${t.id}/redeploy`, {})).json().jobId);
    // Pretend #1 ran a different pattern.
    const first = await prisma.revision.findFirstOrThrow({
      where: { deploymentId: t.id, number: 1 },
    });
    await prisma.revision.update({
      where: { id: first.id },
      data: { architecturePlan: { ...(first.architecturePlan as object), pattern: "F2" } },
    });
    expect(
      (await t.call("POST", `/deployments/${t.id}/rollback`, { toRevision: 1 })).json().error,
    ).toBe("pattern_changed");
    const other = await setup();
    expect(
      (await other.call("POST", `/deployments/${t.id}/rollback`, { toRevision: 1 })).statusCode,
    ).toBe(404);
  });

  it("diagnose: explains a failed step once and caches it; refuses non-failed steps", async () => {
    const t = await setup({
      build: "FAILED",
      diagnosis: {
        summary: "The frontend build failed.",
        likelyCause: "npm ci found no package-lock.json.",
        suggestedFix: "Commit package-lock.json and redeploy.",
        whoFixes: "user_repo",
      },
    });
    await t.generate();
    const generateJob = await prisma.job.findFirstOrThrow({
      where: { deploymentId: t.id, kind: "generate" },
    });
    expect((await t.call("POST", `/jobs/${generateJob.id}/diagnose`)).json().error).toBe(
      "not_failed",
    );

    const applyJob = await t.waitForJob(
      (await t.call("POST", `/deployments/${t.id}/approve`, {})).json().jobId,
    );
    expect(applyJob.status).toBe("failed");
    const failed = await prisma.job.findFirstOrThrow({
      where: { deploymentId: t.id, kind: "apply" },
    });
    const first = await t.call("POST", `/jobs/${failed.id}/diagnose`);
    expect(first.statusCode).toBe(200);
    expect(first.json().whoFixes).toBe("user_repo");
    // Cached: the mock has no second response, so a second model call would fail.
    expect((await t.call("POST", `/jobs/${failed.id}/diagnose`)).json().summary).toBe(
      "The frontend build failed.",
    );

    const other = await setup();
    expect((await other.call("POST", `/jobs/${failed.id}/diagnose`)).statusCode).toBe(404);
  });
});
