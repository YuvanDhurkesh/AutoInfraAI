import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../env.js";
import { buildApp } from "../app.js";

/**
 * Integration test against a real Postgres (DATABASE_URL, migrated). Proves the
 * ownerId-scoped query pattern in routes/deployments.ts actually isolates users:
 * User A must never be able to read User B's deployment through the API.
 *
 * Run: docker compose up -d postgres redis && pnpm --filter api prisma migrate deploy
 *      && pnpm --filter api test
 */
describe("multi-tenant isolation", () => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp(env, prisma);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function signup(email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "correct horse battery staple" },
    });
    expect(res.statusCode).toBe(201);
    const cookies = res.cookies.reduce<Record<string, string>>((acc, c) => {
      acc[c.name] = c.value;
      return acc;
    }, {});
    const userId = res.json().id as string;
    return { cookies, userId };
  }

  it("prevents user A from reading user B's deployment", async () => {
    const userA = await signup(`a-${Date.now()}@example.com`);
    const userB = await signup(`b-${Date.now()}@example.com`);

    const awsConnection = await prisma.awsConnection.create({
      data: {
        userId: userB.userId,
        roleArn: "arn:aws:iam::123456789012:role/autoinfra-test",
        externalId: "test-external-id",
        region: "us-east-1",
      },
    });

    const deployment = await prisma.deployment.create({
      data: {
        ownerId: userB.userId,
        awsConnectionId: awsConnection.id,
        repoUrl: "https://github.com/example/private-repo",
        branch: "main",
        region: "us-east-1",
      },
    });

    const cookieHeader = `ai_session=${userA.cookies.ai_session}`;

    const listRes = await app.inject({
      method: "GET",
      url: "/deployments",
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual([]);

    const getRes = await app.inject({
      method: "GET",
      url: `/deployments/${deployment.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(getRes.statusCode).toBe(404);

    // Nor its app's logs (they run a command on the owner's instance).
    const logsRes = await app.inject({
      method: "GET",
      url: `/deployments/${deployment.id}/logs`,
      headers: { cookie: cookieHeader },
    });
    expect(logsRes.statusCode).toBe(404);

    // Nor its database (the viewer queries the owner's database container).
    for (const url of [
      `/deployments/${deployment.id}/database`,
      `/deployments/${deployment.id}/database/rows?table=users`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: cookieHeader } });
      expect(res.statusCode).toBe(404);
    }
  });

  it("rejects mutating requests without a matching CSRF header", async () => {
    const user = await signup(`csrf-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: `ai_session=${user.cookies.ai_session}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
