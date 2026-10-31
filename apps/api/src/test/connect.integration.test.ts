import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  handleRegistration,
  isCloudFormationResponseUrl,
  type ConnectionAws,
} from "@autoinfra/pipeline";
import { loadEnv } from "../env.js";
import { buildApp } from "../app.js";

/** One-click "Connect AWS": quick-create link + the stack's custom-resource callback. */
describe("one-click AWS connect", () => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  afterAll(async () => {
    for (const app of apps) await app.close();
    await prisma.$disconnect();
  });

  const creds = { accessKeyId: "AKIAFAKE", secretAccessKey: "s", sessionToken: "t" };
  function fakeAws(opts: { assumeFails?: boolean } = {}): ConnectionAws {
    return {
      assumeDeployRole: async () => {
        if (opts.assumeFails)
          throw new Error("AccessDenied: not authorized to perform sts:AssumeRole");
        return creds;
      },
      getCallerIdentity: async () => ({ accountId: "222222222222", arn: "arn", userId: "u" }),
      getAccountPlanState: async () => ({
        regime: "free_plan",
        raw: { accountPlanType: "FREE" },
        source: "freetier-api",
      }),
      getFreeTierUsage: async () => ({ usages: [], available: true }),
      listFreeTierEligibleInstanceTypes: async () => ["t3.micro"],
    };
  }

  function recordingFetch() {
    const calls: Array<{ url: string; body: Record<string, string>; contentType: string | null }> =
      [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body)),
        contentType: new Headers(init?.headers).get("content-type"),
      });
      return new Response("", { status: 200 });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  async function pendingConnection() {
    const user = await prisma.user.create({
      data: { email: `conn-${Date.now()}-${Math.random()}@example.com` },
    });
    return prisma.awsConnection.create({
      data: { userId: user.id, externalId: "ext-123456", region: "ap-south-1" },
    });
  }

  function message(type: "Create" | "Delete", props: Record<string, string>) {
    return JSON.stringify({
      Type: "Notification",
      Message: JSON.stringify({
        RequestType: type,
        ResponseURL: "https://cloudformation-custom-resource-response.s3.amazonaws.com/presigned",
        StackId: "arn:aws:cloudformation:ap-south-1:222222222222:stack/AutoInfra-x/abc",
        RequestId: "req-1",
        LogicalResourceId: "AutoInfraRegistration",
        ResourceProperties: props,
      }),
    });
  }

  it("returns a quick-create link when starting a connection", async () => {
    const seen: string[] = [];
    const app = await buildApp(env, prisma, {
      prepareConnect: async (c) => {
        seen.push(c.id);
        return `https://ap-south-1.console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?param_ConnectionId=${c.id}`;
      },
    });
    await app.ready();
    apps.push(app);
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `qc-${Date.now()}@example.com`, password: "correct horse battery staple" },
    });
    const c = Object.fromEntries(signup.cookies.map((k) => [k.name, k.value]));
    const res = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: {
        cookie: `ai_session=${c.ai_session}; ai_csrf=${c.ai_csrf}`,
        "x-csrf-token": c.ai_csrf!,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().quickCreateUrl).toContain(`param_ConnectionId=${res.json().id}`);
    expect(seen).toEqual([res.json().id]);
  });

  it("verifies the role and answers SUCCESS when the stack's callback matches a pending connection", async () => {
    const conn = await pendingConnection();
    const { calls, fetch } = recordingFetch();
    const result = await handleRegistration(
      { prisma, aws: fakeAws(), fetch, sleep: async () => undefined },
      message("Create", {
        ConnectionId: conn.id,
        ExternalId: "ext-123456",
        RoleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole-x",
      }),
    );
    expect(result.status).toBe("SUCCESS");
    expect(calls[0]!.body.Status).toBe("SUCCESS");
    expect(calls[0]!.body.RequestId).toBe("req-1");
    expect(calls[0]!.contentType).toBe("");
    const after = await prisma.awsConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.roleArn).toBe("arn:aws:iam::222222222222:role/AutoInfraDeployRole-x");
    expect(after.verifiedAt).not.toBeNull();
    expect(after.accountRegime).toBe("free_plan");
  });

  it("refuses a callback whose ExternalId doesn't match (the topic is publicly publishable)", async () => {
    const conn = await pendingConnection();
    const { calls, fetch } = recordingFetch();
    const result = await handleRegistration(
      { prisma, aws: fakeAws(), fetch, sleep: async () => undefined },
      message("Create", {
        ConnectionId: conn.id,
        ExternalId: "attacker-guess",
        RoleArn: "arn:aws:iam::999999999999:role/evil",
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(calls[0]!.body.Status).toBe("FAILED");
    const after = await prisma.awsConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.roleArn).toBeNull();
    expect(after.verifiedAt).toBeNull();
  });

  it("rolls the stack back (FAILED) when the role can't be assumed, after retrying", async () => {
    const conn = await pendingConnection();
    const { calls, fetch } = recordingFetch();
    let sleeps = 0;
    const result = await handleRegistration(
      { prisma, aws: fakeAws({ assumeFails: true }), fetch, sleep: async () => void sleeps++ },
      message("Create", {
        ConnectionId: conn.id,
        ExternalId: "ext-123456",
        RoleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole-x",
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(sleeps).toBe(7); // 8 attempts for IAM propagation
    expect(calls[0]!.body.Reason).toContain("could not use the new role");
    expect(
      (await prisma.awsConnection.findUniqueOrThrow({ where: { id: conn.id } })).roleArn,
    ).toBeNull();
  });

  it("forgets the role when the user deletes the stack, and never blocks the delete", async () => {
    const conn = await pendingConnection();
    await prisma.awsConnection.update({
      where: { id: conn.id },
      data: {
        roleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole-x",
        verifiedAt: new Date(),
      },
    });
    const { calls, fetch } = recordingFetch();
    const result = await handleRegistration(
      { prisma, aws: fakeAws(), fetch },
      message("Delete", {
        ConnectionId: conn.id,
        ExternalId: "ext-123456",
        RoleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole-x",
      }),
    );
    expect(result.status).toBe("SUCCESS");
    expect(calls[0]!.body.Status).toBe("SUCCESS");
    const after = await prisma.awsConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.roleArn).toBeNull();
    expect(after.verifiedAt).toBeNull();
  });

  it("ignores messages that aren't CloudFormation requests", async () => {
    const { calls, fetch } = recordingFetch();
    expect((await handleRegistration({ prisma, aws: fakeAws(), fetch }, "not json")).status).toBe(
      "FAILED",
    );
    expect(
      (
        await handleRegistration(
          { prisma, aws: fakeAws(), fetch },
          JSON.stringify({ Message: "{}" }),
        )
      ).status,
    ).toBe("FAILED");
    expect(calls).toHaveLength(0);
  });

  it("never sends the response anywhere but CloudFormation's own S3 response buckets", async () => {
    expect(
      isCloudFormationResponseUrl(
        "https://cloudformation-custom-resource-response-apsouth1.s3.ap-south-1.amazonaws.com/x?sig=1",
      ),
    ).toBe(true);
    expect(
      isCloudFormationResponseUrl(
        "https://cloudformation-custom-resource-response-useast1.s3.amazonaws.com/x",
      ),
    ).toBe(true);
    for (const bad of [
      "http://169.254.169.254/latest/meta-data/",
      "http://cloudformation-custom-resource-response.s3.amazonaws.com/x",
      "https://cloudformation-custom-resource-response.s3.amazonaws.com.evil.com/x",
      "https://evil.com/cloudformation-custom-resource-response.s3.amazonaws.com",
      "https://cloudformation-custom-resource-response.s3.amazonaws.com:8443/x",
      "https://user:pw@cloudformation-custom-resource-response.s3.amazonaws.com/x",
      "http://redis:6379/",
    ]) {
      expect(isCloudFormationResponseUrl(bad), bad).toBe(false);
    }

    // A forged message pointing at the metadata service: nothing is fetched or changed.
    const conn = await pendingConnection();
    const { calls, fetch } = recordingFetch();
    const forged = JSON.parse(
      message("Create", {
        ConnectionId: conn.id,
        ExternalId: "ext-123456",
        RoleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole-x",
      }),
    );
    forged.Message = JSON.stringify({
      ...JSON.parse(forged.Message),
      ResponseURL: "http://169.254.169.254/latest/meta-data/iam/",
    });
    const result = await handleRegistration(
      { prisma, aws: fakeAws(), fetch, sleep: async () => undefined },
      JSON.stringify(forged),
    );
    expect(result.status).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect((await prisma.awsConnection.findUniqueOrThrow({ where: { id: conn.id } })).roleArn).toBe(
      null,
    );
  });
});
