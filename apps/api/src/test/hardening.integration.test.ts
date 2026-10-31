import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../env.js";
import { buildApp } from "../app.js";
import { memoryRateLimitStore, rateLimit } from "../lib/rate-limit.js";

/** Milestone 11: rate limits, the per-owner job cap, settings, the audit trail. */
describe("hardening", () => {
  const env = loadEnv();
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const PASSWORD = "correct horse battery staple";

  beforeAll(async () => {
    app = await buildApp(env, prisma, { enqueue: async () => undefined });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  let n = 0;
  async function signup(prefix: string, ip = "10.0.0.1") {
    const email = `${prefix}-${Date.now()}-${n++}@example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: PASSWORD },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(201);
    const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
    const userId = res.json().id as string;
    const cookie = `ai_session=${cookies.ai_session}; ai_csrf=${cookies.ai_csrf}`;
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
      app.inject({
        method,
        url,
        payload,
        remoteAddress: ip,
        headers: { cookie, "x-csrf-token": cookies.ai_csrf! },
      });
    return { email, userId, cookie, call };
  }

  async function deploymentFor(userId: string) {
    const connection = await prisma.awsConnection.create({
      data: {
        userId,
        roleArn: "arn:aws:iam::123456789012:role/autoinfra-test",
        externalId: "x",
        region: "us-east-1",
        verifiedAt: new Date(),
        accountRegime: "paid_plan",
      },
    });
    return prisma.deployment.create({
      data: {
        ownerId: userId,
        awsConnectionId: connection.id,
        repoUrl: "https://github.com/example/app",
        branch: "main",
        region: "us-east-1",
      },
    });
  }

  it("rate limiter: counts per key and window, answers 429 with Retry-After", async () => {
    let now = 0;
    const store = memoryRateLimitStore(() => now);
    const limiter = rateLimit(store, { name: "t", limit: 2, windowMs: 60_000, by: "ip" });
    const sent: Array<{ code: number; headers: Record<string, string>; body: unknown }> = [];
    const reply = () => {
      const r = { code: 200, headers: {} as Record<string, string>, body: undefined as unknown };
      const api = {
        code: (c: number) => ((r.code = c), api),
        header: (k: string, v: string) => ((r.headers[k] = v), api),
        send: (b: unknown) => ((r.body = b), sent.push(r), api),
      };
      return api as never;
    };
    const req = (ip: string) => ({ ip }) as never;
    await limiter(req("1.1.1.1"), reply());
    await limiter(req("1.1.1.1"), reply());
    await limiter(req("2.2.2.2"), reply());
    expect(sent).toHaveLength(0);
    now = 15_000;
    await limiter(req("1.1.1.1"), reply());
    expect(sent[0]).toMatchObject({ code: 429, headers: { "retry-after": "45" } });
    now = 60_000; // new window
    await limiter(req("1.1.1.1"), reply());
    expect(sent).toHaveLength(1);
  });

  it("login: locks an account after 10 failed attempts, even with the right password", async () => {
    const user = await signup("brute");
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: user.email, password: "wrong password!!" },
        remoteAddress: `10.1.0.${i}`, // spread across IPs: the per-account limit still applies
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: PASSWORD },
      remoteAddress: "10.1.0.99",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.cookies.find((c) => c.name === "ai_session")).toBeUndefined();

    // Failed attempts are in the owner's activity log, with the address.
    const audit = (await user.call("GET", "/account/audit")).json();
    const failed = audit.events.filter((e: { action: string }) => e.action === "login_failed");
    expect(failed).toHaveLength(10);
    expect(failed[0].metadata.ip).toMatch(/^10\.1\.0\./);
    // 11 argon2 verifications: past vitest's 5 s default on a busy machine.
  }, 20_000);

  it("login: an unknown email gets the same answer as a wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `nobody-${Date.now()}@example.com`, password: PASSWORD },
      remoteAddress: "10.2.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("CSRF: a rejected request never reaches the handler", async () => {
    const user = await signup("csrf");
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: user.cookie }, // no x-csrf-token
    });
    expect(res.statusCode).toBe(403);
    expect((await user.call("GET", "/auth/me")).statusCode).toBe(200); // still signed in
  });

  it("job cap: an owner can't run more than MAX_RUNNING_JOBS_PER_USER steps at once; destroy is exempt", async () => {
    const user = await signup("cap");
    const busy = await Promise.all(
      Array.from({ length: env.MAX_RUNNING_JOBS_PER_USER }, () => deploymentFor(user.userId)),
    );
    for (const d of busy) {
      await prisma.job.create({
        data: { deploymentId: d.id, kind: "generate", status: "running" },
      });
    }
    const next = await deploymentFor(user.userId);
    const res = await user.call("POST", `/deployments/${next.id}/analyze`);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("too_many_running_jobs");

    // Destroy still runs: it stops costs and must never wait behind other work.
    const destroy = await user.call("POST", `/deployments/${next.id}/destroy`, {
      confirm: "example/app",
    });
    expect(destroy.statusCode).toBe(202);
  });

  it("settings: the default Free Tier mode applies to new deployments and is audited", async () => {
    const user = await signup("settings");
    expect((await user.call("GET", "/account/settings")).json()).toMatchObject({
      freeTierModeDefault: "strict",
    });
    expect(
      (await user.call("PUT", "/account/settings", { freeTierModeDefault: "maybe" })).statusCode,
    ).toBe(400);
    const put = await user.call("PUT", "/account/settings", { freeTierModeDefault: "flexible" });
    expect(put.json().freeTierModeDefault).toBe("flexible");

    const connection = await prisma.awsConnection.create({
      data: {
        userId: user.userId,
        roleArn: "arn:aws:iam::123456789012:role/autoinfra-test",
        externalId: "x",
        region: "us-east-1",
        verifiedAt: new Date(),
        accountRegime: "paid_plan",
      },
    });
    const created = await user.call("POST", "/deployments", {
      repoUrl: "https://github.com/example/app",
      awsConnectionId: connection.id,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().freeTierMode).toBe("flexible");
    const explicit = await user.call("POST", "/deployments", {
      repoUrl: "https://github.com/example/app",
      awsConnectionId: connection.id,
      freeTierMode: "strict",
    });
    expect(explicit.json().freeTierMode).toBe("strict");

    const audit = (await user.call("GET", "/account/audit")).json();
    const actions = audit.events.map((e: { action: string }) => e.action);
    expect(actions).toContain("settings_changed");
    const createdEvent = audit.events.find(
      (e: { action: string; targetId: string }) =>
        e.action === "deployment_created" && e.targetId === created.json().id,
    );
    // Created without a branch: the default one, which the first analyze names.
    expect(createdEvent.targetName).toBe("example/app");
  });

  it("audit log: only your own events, newest first, paged without gaps", async () => {
    const user = await signup("audit");
    const other = await signup("audit-other");
    await prisma.auditEvent.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        userId: user.userId,
        action: `test_${i}`,
        targetType: "user",
        createdAt: new Date("2030-01-01T00:00:00Z"), // identical timestamps
      })),
    });
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page: { events: Array<{ action: string }>; nextAfter: string | null } = (
        await user.call("GET", `/account/audit?limit=2${after ? `&after=${after}` : ""}`)
      ).json();
      seen.push(...page.events.map((e) => e.action));
      after = page.nextAfter;
    } while (after);
    expect(seen.filter((a) => a.startsWith("test_")).sort()).toEqual([
      "test_0",
      "test_1",
      "test_2",
      "test_3",
      "test_4",
    ]);
    expect(seen.at(-1)).toBe("signup"); // oldest last
    const theirs = (await other.call("GET", "/account/audit")).json();
    expect(theirs.events.map((e: { action: string }) => e.action)).toEqual(["signup"]);
  });

  it("Free plan: the connection summary carries the end date and credits AWS reported", async () => {
    const user = await signup("freeplan");
    await prisma.awsConnection.create({
      data: {
        userId: user.userId,
        roleArn: "arn:aws:iam::123456789012:role/autoinfra-test",
        externalId: "x",
        region: "us-east-1",
        verifiedAt: new Date(),
        accountRegime: "free_plan",
        planStateJson: {
          source: "freetier-api",
          planState: {
            accountPlanType: "FREE",
            accountPlanStatus: "ACTIVE",
            accountPlanExpirationDate: "2027-01-15T00:00:00.000Z",
            accountPlanRemainingCredits: { amount: 87.5, unit: "USD" },
          },
          checkedAt: "2026-10-20T00:00:00.000Z",
        },
      },
    });
    const [summary] = (await user.call("GET", "/aws/connections")).json();
    expect(summary.freePlan).toEqual({
      status: "ACTIVE",
      expiresAt: "2027-01-15T00:00:00.000Z",
      remainingCredits: { amount: 87.5, unit: "USD" },
      checkedAt: "2026-10-20T00:00:00.000Z",
    });
  });

  // --- Account: password, sessions.

  async function login(email: string, password: string, ip = "10.3.0.1") {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
      remoteAddress: ip,
    });
    const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
    return { status: res.statusCode, cookie: `ai_session=${cookies.ai_session}` };
  }

  const me = (cookie: string) =>
    app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });

  it("password change: needs the current password, signs out every other session", async () => {
    const user = await signup("pw");
    const elsewhere = await login(user.email, PASSWORD);
    expect((await me(elsewhere.cookie)).statusCode).toBe(200);

    const wrong = await user.call("POST", "/account/password", {
      currentPassword: "not my password",
      newPassword: "a brand new long password",
    });
    expect(wrong.json().error).toBe("wrong_password");
    expect(
      (
        await user.call("POST", "/account/password", {
          currentPassword: PASSWORD,
          newPassword: "short",
        })
      ).statusCode,
    ).toBe(400);

    const ok = await user.call("POST", "/account/password", {
      currentPassword: PASSWORD,
      newPassword: "a brand new long password",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().otherSessionsSignedOut).toBe(1);
    expect((await me(elsewhere.cookie)).statusCode).toBe(401); // the other device is out
    expect((await user.call("GET", "/auth/me")).statusCode).toBe(200); // this one stays in
    expect((await login(user.email, PASSWORD, "10.3.0.2")).status).toBe(401);
    expect((await login(user.email, "a brand new long password", "10.3.0.3")).status).toBe(200);

    const actions = (await user.call("GET", "/account/audit"))
      .json()
      .events.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["password_change_failed", "password_changed"]));
  });

  it("GitHub-only account: adds an email and password, so losing GitHub doesn't lock it out", async () => {
    const githubOnly = await prisma.user.create({
      data: { email: `github-${Date.now()}@users.autoinfra.invalid` },
    });
    const session = await prisma.session.create({
      data: { userId: githubOnly.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    const headers = {
      cookie: `ai_session=${app.signCookie(session.id)}; ai_csrf=t0ken`,
      "x-csrf-token": "t0ken",
    };
    const post = (payload: object) =>
      app.inject({ method: "POST", url: "/account/password", headers, payload });

    const settings = (
      await app.inject({ method: "GET", url: "/account/settings", headers })
    ).json();
    expect(settings).toMatchObject({ hasPassword: false, emailIsPlaceholder: true });

    expect((await post({ newPassword: "a long enough password" })).json().error).toBe(
      "email_required",
    );
    const taken = await signup("taken");
    expect(
      (await post({ newPassword: "a long enough password", email: taken.email })).json().error,
    ).toBe("email_taken");

    const email = `real-${Date.now()}@example.com`;
    const ok = await post({ newPassword: "a long enough password", email });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().email).toBe(email);
    expect((await login(email, "a long enough password", "10.4.0.1")).status).toBe(200);
  });

  it("sign out everywhere ends every session, this one included", async () => {
    const user = await signup("everywhere");
    const other = await login(user.email, PASSWORD, "10.5.0.1");
    const res = await user.call("POST", "/account/sessions/revoke");
    expect(res.json().sessionsEnded).toBe(2);
    expect((await me(other.cookie)).statusCode).toBe(401);
    expect((await user.call("GET", "/auth/me")).statusCode).toBe(401);
  });
});
