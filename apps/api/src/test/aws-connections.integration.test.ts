import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Mocks @autoinfra/aws so this suite runs in CI without real AWS credentials
 * (the live wiring -- real sts:GetCallerIdentity / sts:AssumeRole against the
 * developer's own AWS account -- was manually smoke-tested separately; see
 * PROGRESS.md). Only the HTTP-layer behavior (validation, persistence,
 * ownership, the "ask the user" fallback) is asserted here.
 */
vi.mock("@autoinfra/aws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@autoinfra/aws")>()),
  getPlatformAccountId: vi.fn().mockResolvedValue("111111111111"),
  assumeDeployRole: vi.fn().mockResolvedValue({
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "fake",
    sessionToken: "fake",
  }),
  getCallerIdentity: vi
    .fn()
    .mockResolvedValue({ accountId: "222222222222", arn: "arn:aws:iam::222222222222:root" }),
  getAccountPlanState: vi.fn(),
  getFreeTierUsage: vi.fn().mockResolvedValue({ usages: [], available: true }),
  listFreeTierEligibleInstanceTypes: vi.fn().mockResolvedValue(["t3.micro", "t4g.micro"]),
}));

const { getAccountPlanState } = await import("@autoinfra/aws");
const { loadEnv } = await import("../env.js");
const { buildApp } = await import("../app.js");

describe("AWS connect wizard", () => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    // One-click connect needs real platform resources; these tests cover the
    // manual flow, so make it unavailable rather than reaching AWS.
    app = await buildApp(env, prisma, {
      prepareConnect: async () => {
        throw new Error("one-click connect not configured in tests");
      },
      registrationTopicArn: async () => {
        throw new Error("not configured");
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function signedInUser() {
    const email = `aws-${Date.now()}-${Math.random()}@example.com`;
    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "correct horse battery staple" },
    });
    const cookies = signupRes.cookies.reduce<Record<string, string>>((acc, c) => {
      acc[c.name] = c.value;
      return acc;
    }, {});
    return {
      userId: signupRes.json().id as string,
      cookie: `ai_session=${cookies.ai_session}; ai_csrf=${cookies.ai_csrf}`,
      csrfHeader: cookies.ai_csrf,
    };
  }

  it("rejects a malformed role ARN", async () => {
    const { cookie, csrfHeader } = await signedInUser();
    const created = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    const patched = await app.inject({
      method: "PATCH",
      url: `/aws/connections/${id}/role`,
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: { roleArn: "not-an-arn" },
    });
    expect(patched.statusCode).toBe(400);
  });

  it("embeds the live platform account id and the connection's externalId in the template", async () => {
    const { cookie, csrfHeader } = await signedInUser();
    const created = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: {},
    });
    const { id, externalId } = created.json();

    const templateRes = await app.inject({
      method: "GET",
      url: `/aws/connections/${id}/template`,
      headers: { cookie },
    });
    expect(templateRes.statusCode).toBe(200);
    expect(templateRes.body).toContain("arn:aws:iam::111111111111:root");
    expect(templateRes.body).toContain(externalId);
  });

  it("marks accountRegime from the Free Tier API when it resolves confidently", async () => {
    vi.mocked(getAccountPlanState).mockResolvedValueOnce({
      regime: "free_plan",
      raw: { accountPlanType: "FREE" },
      source: "freetier-api",
    });
    const { cookie, csrfHeader } = await signedInUser();
    const created = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: {},
    });
    const { id } = created.json();
    await app.inject({
      method: "PATCH",
      url: `/aws/connections/${id}/role`,
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: { roleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole" },
    });

    const verifyRes = await app.inject({
      method: "POST",
      url: `/aws/connections/${id}/verify`,
      headers: { cookie, "x-csrf-token": csrfHeader },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.needsManualRegime).toBe(false);
    expect(body.accountRegime).toBe("free_plan");
    expect(body.regimeSource).toBe("freetier-api");
  });

  it("asks the user to confirm the regime when the Free Tier API is unavailable, then accepts their answer", async () => {
    vi.mocked(getAccountPlanState).mockResolvedValueOnce({
      regime: null,
      raw: { error: "AccessDenied" },
      source: "unavailable",
    });
    const { cookie, csrfHeader } = await signedInUser();
    const created = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: {},
    });
    const { id } = created.json();
    await app.inject({
      method: "PATCH",
      url: `/aws/connections/${id}/role`,
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: { roleArn: "arn:aws:iam::222222222222:role/AutoInfraDeployRole" },
    });

    const verifyRes = await app.inject({
      method: "POST",
      url: `/aws/connections/${id}/verify`,
      headers: { cookie, "x-csrf-token": csrfHeader },
    });
    expect(verifyRes.json().needsManualRegime).toBe(true);
    expect(verifyRes.json().accountRegime).toBeNull();

    const regimeRes = await app.inject({
      method: "POST",
      url: `/aws/connections/${id}/regime`,
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: { regime: "legacy_12mo" },
    });
    expect(regimeRes.statusCode).toBe(200);
    expect(regimeRes.json().accountRegime).toBe("legacy_12mo");
    expect(regimeRes.json().regimeSource).toBe("user");
  });

  it("refuses to disconnect while an active deployment references the connection", async () => {
    const { userId, cookie, csrfHeader } = await signedInUser();
    const created = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: {},
    });
    const { id: awsConnectionId } = created.json();

    await prisma.deployment.create({
      data: {
        ownerId: userId,
        awsConnectionId,
        repoUrl: "https://github.com/example/repo",
        branch: "main",
        region: "us-east-1",
        status: "live",
      },
    });

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/aws/connections/${awsConnectionId}`,
      headers: { cookie, "x-csrf-token": csrfHeader },
    });
    expect(deleteRes.statusCode).toBe(409);
  });

  it("allows disconnecting when no active deployments reference the connection", async () => {
    const { cookie, csrfHeader } = await signedInUser();
    const created = await app.inject({
      method: "POST",
      url: "/aws/connections",
      headers: { cookie, "x-csrf-token": csrfHeader },
      payload: {},
    });
    const { id } = created.json();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/aws/connections/${id}`,
      headers: { cookie, "x-csrf-token": csrfHeader },
    });
    expect(deleteRes.statusCode).toBe(204);
  });
});
