import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../env.js";
import { buildApp } from "../app.js";

/**
 * "Log in with GitHub" and "Connect GitHub": one OAuth app, one callback.
 * GitHub's two endpoints (token exchange, /user) are faked; everything else
 * -- state cookie, sessions, encryption, the database -- is real.
 */
describe("GitHub OAuth", () => {
  const env = {
    ...loadEnv(),
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
  };
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const base = Date.now() % 1_000_000_000;
  let next = 0;
  const githubId = () => base * 100 + next++;

  beforeAll(async () => {
    app = await buildApp(env, prisma, { enqueue: async () => undefined });
    await app.ready();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  /** GitHub answers the code exchange with `token`, and /user with this account. */
  function fakeGithub(account: { id: number; login: string }, token = `gho_${account.id}_secret`) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href === "https://github.com/login/oauth/access_token")
        return new Response(JSON.stringify({ access_token: token }), { status: 200 });
      if (href === "https://api.github.com/user")
        return new Response(JSON.stringify(account), { status: 200 });
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { token, fetchMock };
  }

  /** /auth/github then GitHub's redirect back to the callback, with `cookie` (a session, or none). */
  async function oauthRoundTrip(cookie = "", stateOverride?: string) {
    const start = await app.inject({ method: "GET", url: "/auth/github", headers: { cookie } });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client");
    expect(location.searchParams.get("scope")).toBe("read:user repo");
    const state = location.searchParams.get("state")!;
    const stateCookie = start.cookies.find((c) => c.name === "ai_oauth_state")!.value;
    const callback = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=the-code&state=${stateOverride ?? state}`,
      headers: { cookie: [cookie, `ai_oauth_state=${stateCookie}`].filter(Boolean).join("; ") },
    });
    expect(callback.statusCode).toBe(302);
    return callback;
  }

  let ip = 0;
  async function signup() {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        email: `gh-${base}-${next++}@example.com`,
        password: "correct horse battery staple",
      },
      remoteAddress: `10.77.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    });
    expect(res.statusCode).toBe(201);
    const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
    return {
      userId: res.json().id as string,
      cookie: `ai_session=${cookies.ai_session}; ai_csrf=${cookies.ai_csrf}`,
    };
  }

  it("tells the web app GitHub sign-in is available", async () => {
    expect((await app.inject({ method: "GET", url: "/auth/providers" })).json()).toEqual({
      github: true,
    });
  });

  it("log in with GitHub: creates a passwordless account, signs it in, stores the token encrypted", async () => {
    const account = { id: githubId(), login: `octo-${base}` };
    const { token } = fakeGithub(account);

    const res = await oauthRoundTrip();
    expect(res.headers.location).toBe(`${env.WEB_ORIGIN}/dashboard?connected=github`);
    const session = res.cookies.find((c) => c.name === "ai_session")!.value;
    const csrf = res.cookies.find((c) => c.name === "ai_csrf")!.value;

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `ai_session=${session}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toMatch(/\.invalid$/);

    const connection = await prisma.githubConnection.findFirstOrThrow({
      where: { githubUserId: String(account.id) },
    });
    expect(connection.userId).toBe(me.json().id);
    expect(connection.accessTokenEncrypted).not.toContain(token);

    const settings = await app.inject({
      method: "GET",
      url: "/account/settings",
      headers: { cookie: `ai_session=${session}; ai_csrf=${csrf}` },
    });
    expect(settings.json()).toMatchObject({ githubLogin: account.login, hasPassword: false });

    // Signing in again finds the same account -- no duplicate user.
    fakeGithub(account);
    const again = await oauthRoundTrip();
    const session2 = again.cookies.find((c) => c.name === "ai_session")!.value;
    const me2 = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: `ai_session=${session2}` },
    });
    expect(me2.json().id).toBe(me.json().id);
    expect(
      await prisma.githubConnection.count({ where: { githubUserId: String(account.id) } }),
    ).toBe(1);
  });

  it("connect GitHub: links the account to the signed-in user and audits it", async () => {
    const user = await signup();
    const account = { id: githubId(), login: `dev-${base}` };
    fakeGithub(account);

    const res = await oauthRoundTrip(user.cookie);
    expect(res.headers.location).toBe(`${env.WEB_ORIGIN}/dashboard?connected=github`);
    // The existing session stays; no new one is issued.
    expect(res.cookies.find((c) => c.name === "ai_session")).toBeUndefined();

    const connection = await prisma.githubConnection.findUniqueOrThrow({
      where: { userId: user.userId },
    });
    expect(connection).toMatchObject({
      githubUserId: String(account.id),
      githubLogin: account.login,
    });
    expect(
      await prisma.auditEvent.count({ where: { userId: user.userId, action: "github_connected" } }),
    ).toBe(1);
  });

  it("refuses to connect a GitHub account another AutoInfra account already uses", async () => {
    const first = await signup();
    const account = { id: githubId(), login: `shared-${base}` };
    fakeGithub(account);
    await oauthRoundTrip(first.cookie);

    const second = await signup();
    fakeGithub(account);
    const res = await oauthRoundTrip(second.cookie);
    expect(res.headers.location).toBe(`${env.WEB_ORIGIN}/dashboard?github_error=in_use`);
    expect(
      await prisma.githubConnection.findUnique({ where: { userId: second.userId } }),
    ).toBeNull();
    expect(
      await prisma.githubConnection.count({ where: { githubUserId: String(account.id) } }),
    ).toBe(1);
  });

  it("a forged state or a failed code exchange signs no one in, and says so where the flow began", async () => {
    const account = { id: githubId(), login: `forged-${base}` };
    const { fetchMock } = fakeGithub(account);
    const forged = await oauthRoundTrip("", "not-the-state");
    expect(forged.headers.location).toBe(`${env.WEB_ORIGIN}/login?error=github_oauth_failed`);
    expect(forged.cookies.find((c) => c.name === "ai_session")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled(); // never reached GitHub

    const user = await signup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "bad_verification_code" }))),
    );
    const failed = await oauthRoundTrip(user.cookie);
    expect(failed.headers.location).toBe(`${env.WEB_ORIGIN}/dashboard?github_error=oauth_failed`);
    expect(await prisma.githubConnection.findUnique({ where: { userId: user.userId } })).toBeNull();
  });

  it("without an OAuth app configured: the web app hides GitHub, a stale link explains why", async () => {
    const off = await buildApp(
      { ...env, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined },
      prisma,
      { enqueue: async () => undefined },
    );
    await off.ready();
    try {
      expect((await off.inject({ method: "GET", url: "/auth/providers" })).json()).toEqual({
        github: false,
      });
      const res = await off.inject({ method: "GET", url: "/auth/github" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${env.WEB_ORIGIN}/login?error=github_not_configured`);
    } finally {
      await off.close();
    }
  });
});
