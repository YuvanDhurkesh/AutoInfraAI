import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { MockLlmClient } from "@autoinfra/llm";
import { runJob, type PipelineDeps } from "@autoinfra/pipeline";
import type { cloneRepo } from "@autoinfra/scanner";
import { loadEnv } from "../env.js";
import { buildApp, type AppDeps } from "../app.js";

const FIXTURES = path.resolve(
  fileURLToPath(new URL("../../../../packages/scanner/test/fixtures", import.meta.url)),
);

/** Stands in for a real git clone: copies a scanner fixture into a temp dir. */
function fakeClone(fixture: string | ((dir: string) => void)): typeof cloneRepo {
  return async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-test-"));
    if (typeof fixture === "string")
      fs.cpSync(path.join(FIXTURES, fixture), localPath, { recursive: true });
    else fixture(localPath);
    return {
      localPath,
      commitSha: "1111111111111111111111111111111111111111",
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
    { service: "aws_lambda_function", name: "api", purpose: "Express via Lambda Web Adapter" },
    { service: "aws_lambda_function_url", name: "api_url", purpose: "origin" },
    { service: "aws_cloudwatch_log_group", name: "logs", purpose: "logs", logRetentionDays: 7 },
  ],
  routing: { apiPathPrefix: "/api" },
  envMapping: [],
  risks: ["Cold starts"],
  assumptions: [],
  mermaidDiagram: 'flowchart LR\n  U["User"] --> CF["CloudFront"]',
  draftFreeTierAssessment: "Within Always Free limits.",
};

describe("deployment analyze + design", () => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  /**
   * The app, with queued jobs run in-process the way the worker runs them
   * (analyze and design only need the database, the model and a clone).
   */
  async function makeApp(
    deps: Pick<AppDeps, "llm" | "cloneRepo"> &
      Partial<AppDeps> & { defaultBranch?: PipelineDeps["defaultBranch"] },
  ) {
    const pipelineDeps = {
      prisma,
      llm: deps.llm,
      cloneRepo: deps.cloneRepo,
      defaultBranch: deps.defaultBranch,
      githubToken: async () => undefined,
      enqueue: async (payload) => {
        void runJob(pipelineDeps, payload);
      },
    } as Partial<PipelineDeps> as PipelineDeps;
    const app = await buildApp(env, prisma, { enqueue: pipelineDeps.enqueue, ...deps });
    await app.ready();
    apps.push(app);
    return app;
  }

  /** Waits until nothing runs for the deployment (chained steps hand off without a gap). */
  async function settle(deploymentId: string) {
    for (let i = 0; i < 200; i++) {
      if (!(await prisma.job.count({ where: { deploymentId, status: "running" } }))) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("jobs did not settle");
  }

  async function logsOf(jobId: string) {
    const rows = await prisma.jobLog.findMany({ where: { jobId }, orderBy: { seq: "asc" } });
    return rows.map((r) => r.line).join("\n");
  }

  async function user(app: Awaited<ReturnType<typeof makeApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email: `dep-${Date.now()}-${Math.random()}@example.com`,
        password: "correct horse battery staple",
      },
    });
    const c = Object.fromEntries(res.cookies.map((k) => [k.name, k.value]));
    const userId = res.json().id as string;
    const connection = await prisma.awsConnection.create({
      data: {
        userId,
        // An AWS account of its own: the one free EC2 instance is per account.
        roleArn: `arn:aws:iam::${String(Math.random()).slice(2, 14).padEnd(12, "7")}:role/AutoInfraDeployRole`,
        externalId: "x",
        region: "ap-south-1",
        verifiedAt: new Date(),
        accountRegime: "free_plan",
        planStateJson: { eligibleInstanceTypes: ["t3.micro"] },
      },
    });
    return {
      userId,
      awsConnectionId: connection.id,
      headers: {
        cookie: `ai_session=${c.ai_session}; ai_csrf=${c.ai_csrf}`,
        "x-csrf-token": c.ai_csrf!,
      },
    };
  }

  async function create(
    app: Awaited<ReturnType<typeof makeApp>>,
    u: Awaited<ReturnType<typeof user>>,
    extra = {},
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/deployments",
      headers: u.headers,
      payload: {
        repoUrl: "https://github.com/example/app",
        awsConnectionId: u.awsConnectionId,
        ...extra,
      },
    });
    return res;
  }

  afterAll(async () => {
    for (const app of apps) await app.close();
    await prisma.$disconnect();
  });

  it("rejects non-GitHub URLs and path-traversal subdirs", async () => {
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: fakeClone("react-express"),
    });
    const u = await user(app);
    expect((await create(app, u, { repoUrl: "https://evil.example.com/a/b" })).statusCode).toBe(
      400,
    );
    expect((await create(app, u, { repoUrl: "http://169.254.169.254/latest" })).statusCode).toBe(
      400,
    );
    expect((await create(app, u, { subdir: "../../etc" })).statusCode).toBe(400);
    expect((await create(app, u, { subdir: "/etc" })).statusCode).toBe(400);
  });

  it("refuses an AWS connection that isn't fully verified", async () => {
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: fakeClone("react-express"),
    });
    const u = await user(app);
    await prisma.awsConnection.update({
      where: { id: u.awsConnectionId },
      data: { accountRegime: null },
    });
    expect((await create(app, u)).statusCode).toBe(400);
  });

  it("analyze and design run on the worker; the Free Tier report is computed by AutoInfra", async () => {
    const llm = new MockLlmClient({ design: [validF1] });
    const app = await makeApp({ llm, cloneRepo: fakeClone("react-express") });
    const u = await user(app);
    const { id } = (await create(app, u)).json();
    const post = (step: string, payload?: object) =>
      app.inject({
        method: "POST",
        url: `/deployments/${id}/${step}`,
        headers: u.headers,
        payload,
      });

    expect((await post("analyze", { then: ["generate"] })).json().error).toBe("invalid_input");
    const analyze = await post("analyze");
    expect(analyze.statusCode).toBe(202);
    await settle(id);
    let detail = (
      await app.inject({ method: "GET", url: `/deployments/${id}`, headers: u.headers })
    ).json();
    expect(detail.status).toBe("designing");
    expect(detail.latestRevision.repoProfile.recommendedPattern).toBe("F1");
    expect(detail.latestRevision.commitSha).toBe("1111111111111111111111111111111111111111");
    expect(await logsOf(analyze.json().jobId)).toContain("Suggested pattern: F1");
    expect(llm.requests).toHaveLength(0); // analyze alone never calls the model

    const design = await post("design");
    expect(design.statusCode).toBe(202);
    await settle(id);
    detail = (
      await app.inject({ method: "GET", url: `/deployments/${id}`, headers: u.headers })
    ).json();
    expect(detail.pattern).toBe("F1");
    expect(detail.latestRevision.architecturePlan.pattern).toBe("F1");
    expect(detail.latestRevision.freeTierReport.fit).toBe("within_limits");
    expect(detail.jobs.map((j: { kind: string; status: string }) => [j.kind, j.status])).toEqual([
      ["design", "succeeded"],
      ["analyze", "succeeded"],
    ]);
    expect(await logsOf(design.json().jobId)).toContain("Free Tier check");
    // A shape the blueprints cover is designed from them, without the model.
    expect(await logsOf(design.json().jobId)).toContain("no AI request needed");
    expect(llm.requests).toHaveLength(0);

    // The live revision's design is part of what's deployed: never redone in place.
    await prisma.deployment.update({
      where: { id },
      data: {
        currentRevisionId: (await prisma.revision.findFirstOrThrow({ where: { deploymentId: id } }))
          .id,
      },
    });
    expect((await post("design")).json().error).toBe("nothing_to_design");
  });

  it("databases hosted outside AWS: MongoDB designs, and its connection settings are the user's to enter", async () => {
    const llm = new MockLlmClient({ design: [validF1] });
    const app = await makeApp({ llm, cloneRepo: fakeClone("express-mongo") });
    const u = await user(app);
    const designed = async (
      target: Awaited<ReturnType<typeof makeApp>>,
      extra: Record<string, unknown> = {},
    ) => {
      const { id } = (await create(target, u, extra)).json();
      const analyze = await target.inject({
        method: "POST",
        url: `/deployments/${id}/analyze`,
        headers: u.headers,
        payload: { then: ["design"] },
      });
      expect(analyze.statusCode).toBe(202);
      await settle(id);
      const detail = (
        await target.inject({ method: "GET", url: `/deployments/${id}`, headers: u.headers })
      ).json();
      expect(detail.failureReason).toBeNull();
      return { id, detail };
    };

    // Owner says it's hosted elsewhere: no container, Lambda is enough.
    const { id, detail } = await designed(app, { externalDatabase: true });
    expect(detail.latestRevision.repoProfile.databaseExternal).toBe(true);
    expect(detail.latestRevision.architecturePlan.pattern).toBe("F1");
    const env = (
      await app.inject({ method: "GET", url: `/deployments/${id}/env`, headers: u.headers })
    ).json();
    expect(env.missing).toContainEqual({ name: "MONGODB_URI", isSecret: true });

    // Not said, but the repo's env template points at Atlas: still hosted there.
    const atlasApp = await makeApp({
      llm,
      cloneRepo: fakeClone((dir) => {
        fs.cpSync(path.join(FIXTURES, "express-mongo"), dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, ".env.example"),
          "MONGODB_URI=mongodb+srv://user:pass@cluster0.abcde.mongodb.net/careers\n",
        );
      }),
    });
    const atlas = (await designed(atlasApp)).detail.latestRevision.repoProfile;
    expect(atlas).toMatchObject({ databaseExternal: true, databaseHostedAt: "mongodb.net" });

    // Neither: MongoDB runs in a container next to the app.
    const localRun = await designed(app);
    const local = localRun.detail;
    expect(local.latestRevision.repoProfile.databaseExternal).toBe(false);
    expect(local.latestRevision.architecturePlan.pattern).toBe("F2");
    // Its settings point at that container: a pasted env template's value
    // would be saved but never used, so it's refused with the reason.
    const pasted = await app.inject({
      method: "PUT",
      url: `/deployments/${localRun.id}/env`,
      headers: u.headers,
      payload: {
        vars: [{ name: "MONGODB_URI", value: "mongodb://127.0.0.1:27017/app", isSecret: true }],
      },
    });
    expect(pasted.statusCode).toBe(400);
    expect(pasted.json()).toMatchObject({ error: "set_by_autoinfra" });
    expect(pasted.json().message).toContain("MONGODB_URI");
    expect(llm.requests).toHaveLength(0); // all three are blueprint shapes

    // A SQL database the owner hosts elsewhere: its settings aren't wired to a container.
    const validF2 = {
      ...validF1,
      pattern: "F2",
      components: [
        { service: "aws_s3_bucket", name: "frontend", purpose: "static assets" },
        { service: "aws_cloudfront_distribution", name: "cdn", purpose: "routing" },
        { service: "aws_instance", name: "app", purpose: "API", instanceType: "t3.micro" },
      ],
    };
    const mysqlApp = await makeApp({
      llm: new MockLlmClient({ design: [validF2] }),
      cloneRepo: fakeClone("express-mysql"),
    });
    const created = await create(mysqlApp, u, { externalDatabase: true });
    expect(created.json().externalDatabase).toBe(true);
    const mysqlId = created.json().id;
    await mysqlApp.inject({
      method: "POST",
      url: `/deployments/${mysqlId}/analyze`,
      headers: u.headers,
      payload: { then: ["design"] },
    });
    await settle(mysqlId);
    // No database to host here: the blueprint puts the API on Lambda.
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: mysqlId } })).pattern).toBe(
      "F1",
    );
    const mysqlEnv = (
      await mysqlApp.inject({
        method: "GET",
        url: `/deployments/${mysqlId}/env`,
        headers: u.headers,
      })
    ).json();
    expect(mysqlEnv.missing.map((v: { name: string }) => v.name)).toEqual(
      expect.arrayContaining(["DB_HOST", "DB_USER", "DB_PASSWORD"]),
    );
    // Four full analyze -> design chains: more than 5 s on a busy machine.
  }, 20_000);

  it("no branch given: the first analyze records the repository's default branch", async () => {
    const clone = fakeClone("static-only");
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: async (input) => ({ ...(await clone(input)), branch: input.branch ?? "master" }),
    });
    const u = await user(app);
    const { id } = (await create(app, u)).json();
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id } })).branch).toBe("");
    await app.inject({
      method: "POST",
      url: `/deployments/${id}/analyze`,
      headers: u.headers,
      payload: {},
    });
    await settle(id);
    const after = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    expect(after.branch).toBe("master");
    const job = await prisma.job.findFirstOrThrow({ where: { deploymentId: id, kind: "analyze" } });
    expect(await logsOf(job.id)).toContain("its default branch");
  });

  it("a branch the repository doesn't have: says which one it does have", async () => {
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: async () => {
        throw new Error("git clone failed: Remote branch main not found in upstream origin");
      },
      defaultBranch: async () => "master",
    });
    const u = await user(app);
    const { id } = (await create(app, u, { branch: "main" })).json();
    await app.inject({
      method: "POST",
      url: `/deployments/${id}/analyze`,
      headers: u.headers,
      payload: {},
    });
    await settle(id);
    const failed = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toContain(
      'This repository has no branch "main": its default branch is "master"',
    );
  });

  it("an unsupported repo fails the chain at analyze, clearly, without calling the model", async () => {
    const llm = new MockLlmClient({});
    const app = await makeApp({
      llm,
      cloneRepo: fakeClone((dir) =>
        fs.writeFileSync(
          path.join(dir, "package.json"),
          JSON.stringify({ dependencies: { express: "4", "@tensorflow/tfjs-node-gpu": "4" } }),
        ),
      ),
    });
    const u = await user(app);
    const { id } = (await create(app, u)).json();
    const analyze = await app.inject({
      method: "POST",
      url: `/deployments/${id}/analyze`,
      headers: u.headers,
      payload: { then: ["design"] },
    });
    expect(analyze.statusCode).toBe(202);
    await settle(id);
    const row = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain("GPU/ML workload");
    const jobs = await prisma.job.findMany({ where: { deploymentId: id } });
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([["analyze", "failed"]]);
    const design = await app.inject({
      method: "POST",
      url: `/deployments/${id}/design`,
      headers: u.headers,
    });
    expect(design.statusCode).toBe(400);
    expect(llm.requests).toHaveLength(0);
  });

  it("does not leak the clone URL (which may carry a token) in errors or logs", async () => {
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: async () => {
        throw new Error(
          "fatal: https://x-access-token:SUPERSECRET@github.com/example/app not found",
        );
      },
    });
    const u = await user(app);
    const { id } = (await create(app, u)).json();
    const res = await app.inject({
      method: "POST",
      url: `/deployments/${id}/analyze`,
      headers: u.headers,
    });
    expect(res.statusCode).toBe(202);
    await settle(id);
    const row = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain("Could not clone");
    expect(row.failureReason).not.toContain("SUPERSECRET");
    const job = await prisma.job.findFirstOrThrow({ where: { deploymentId: id } });
    expect(job.error).not.toContain("SUPERSECRET");
    expect(await logsOf(job.id)).not.toContain("SUPERSECRET");
  });

  it("allows only one running job per deployment", async () => {
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: fakeClone("react-express"),
    });
    const u = await user(app);
    const { id } = (await create(app, u)).json();
    await prisma.job.create({ data: { deploymentId: id, kind: "analyze", status: "running" } });
    const res = await app.inject({
      method: "POST",
      url: `/deployments/${id}/analyze`,
      headers: u.headers,
    });
    expect(res.statusCode).toBe(409);
  });

  it("does not let another user analyze or design someone else's deployment", async () => {
    const app = await makeApp({
      llm: new MockLlmClient({}),
      cloneRepo: fakeClone("react-express"),
    });
    const owner = await user(app);
    const other = await user(app);
    const { id } = (await create(app, owner)).json();
    for (const step of ["analyze", "design"]) {
      const res = await app.inject({
        method: "POST",
        url: `/deployments/${id}/${step}`,
        headers: other.headers,
      });
      expect(res.statusCode).toBe(404);
    }
    expect((await create(app, other, { awsConnectionId: owner.awsConnectionId })).statusCode).toBe(
      404,
    );
  });
});
