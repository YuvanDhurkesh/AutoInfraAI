import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "../env.js";
import { encryptSecret } from "@autoinfra/pipeline";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubUser,
} from "../lib/auth/github-oauth.js";
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from "../lib/auth/session.js";
import { CSRF_COOKIE, generateCsrfToken } from "../lib/auth/csrf.js";
import { placeholderEmail } from "../lib/auth/placeholder-email.js";

const OAUTH_STATE_COOKIE = "ai_oauth_state";

/**
 * One OAuth app serves two flows on the same callback, disambiguated by
 * whether the browser already carries a session cookie when /auth/github is
 * hit: "log in with GitHub" (no session -- find-or-create a User) vs.
 * "connect GitHub" (existing session -- link GithubConnection to request.user).
 */
export function registerGithubRoutes(app: FastifyInstance, prisma: PrismaClient, env: Env) {
  const configured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  // The web app shows "Log in with GitHub" / "Connect GitHub" only when this is true.
  app.get("/auth/providers", async () => ({ github: configured }));

  /** Back to where the flow started: the dashboard when signed in ("connect"), else the login page. */
  const backTo = (request: FastifyRequest, error: string) => {
    const raw = request.cookies[SESSION_COOKIE];
    const signedIn = raw ? request.unsignCookie(raw).valid : false;
    return signedIn
      ? `${env.WEB_ORIGIN}/dashboard?github_error=${error}`
      : `${env.WEB_ORIGIN}/login?error=github_${error}`;
  };

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    app.log.warn("GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not set -- GitHub sign-in is off");
    // A stale link or bookmark gets a readable message, not a bare 404.
    app.get("/auth/github", async (request, reply) =>
      reply.redirect(backTo(request, "not_configured")),
    );
    return;
  }
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const isProd = env.NODE_ENV === "production";
  const redirectUri = `${env.API_BASE_URL}/auth/github/callback`;

  app.get("/auth/github", async (request, reply) => {
    const state = crypto.randomBytes(24).toString("hex");
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      signed: true,
      maxAge: 600,
    });
    // Carries the caller's own session cookie (if any) through the redirect
    // automatically via the browser -- no extra plumbing needed to tell
    // apart login vs. connect in the callback.
    return reply.redirect(buildGithubAuthorizeUrl({ clientId, redirectUri, state }));
  });

  app.get("/auth/github/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const failureRedirect = backTo(request, "oauth_failed");

    const cookieState = request.cookies[OAUTH_STATE_COOKIE];
    const unsignedState = cookieState ? request.unsignCookie(cookieState) : undefined;
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

    if (
      !query.code ||
      !query.state ||
      !unsignedState?.valid ||
      unsignedState.value !== query.state
    ) {
      return reply.redirect(failureRedirect);
    }

    try {
      const accessToken = await exchangeGithubCode({
        clientId,
        clientSecret,
        code: query.code,
        redirectUri,
      });
      const githubUser = await fetchGithubUser(accessToken);
      const accessTokenEncrypted = encryptSecret(accessToken, env.ENCRYPTION_KEY);

      let userId: string;

      const existingSessionId = request.cookies[SESSION_COOKIE];
      const existingSession = existingSessionId
        ? request.unsignCookie(existingSessionId)
        : undefined;
      const currentUser =
        existingSession?.valid && existingSession.value
          ? await prisma.session
              .findUnique({ where: { id: existingSession.value }, include: { user: true } })
              .then((s) => (s && s.expiresAt.getTime() > Date.now() ? s.user : null))
          : null;

      if (currentUser) {
        // "Connect GitHub" for an already-authenticated user.
        userId = currentUser.id;
        // One GitHub account, one AutoInfra account: otherwise "Log in with
        // GitHub" couldn't tell which of the two to sign in to.
        const linkedElsewhere = await prisma.githubConnection.findFirst({
          where: { githubUserId: String(githubUser.id), NOT: { userId } },
        });
        if (linkedElsewhere) return reply.redirect(backTo(request, "in_use"));
        await prisma.githubConnection.upsert({
          where: { userId },
          create: {
            userId,
            githubUserId: String(githubUser.id),
            githubLogin: githubUser.login,
            accessTokenEncrypted,
            scopes: "read:user repo",
          },
          update: {
            githubUserId: String(githubUser.id),
            githubLogin: githubUser.login,
            accessTokenEncrypted,
          },
        });
      } else {
        // "Log in with GitHub" -- find the user this GitHub account already
        // links to, or create a new passwordless account for it.
        const existingConnection = await prisma.githubConnection.findFirst({
          where: { githubUserId: String(githubUser.id) },
        });

        if (existingConnection) {
          userId = existingConnection.userId;
          await prisma.githubConnection.update({
            where: { userId },
            data: { githubLogin: githubUser.login, accessTokenEncrypted },
          });
        } else {
          const user = await prisma.user.create({
            data: {
              // GitHub login doesn't grant email access; see placeholder-email.ts.
              email: placeholderEmail(githubUser.id),
              githubConnection: {
                create: {
                  githubUserId: String(githubUser.id),
                  githubLogin: githubUser.login,
                  accessTokenEncrypted,
                  scopes: "read:user repo",
                },
              },
            },
          });
          userId = user.id;
        }

        const session = await createSession(prisma, userId);
        reply.setCookie(SESSION_COOKIE, session.id, {
          httpOnly: true,
          secure: isProd,
          sameSite: "lax",
          signed: true,
          path: "/",
          maxAge: SESSION_TTL_MS / 1000,
        });
        reply.setCookie(CSRF_COOKIE, generateCsrfToken(), {
          httpOnly: false,
          secure: isProd,
          sameSite: "lax",
          path: "/",
          maxAge: SESSION_TTL_MS / 1000,
        });
      }

      await prisma.auditEvent.create({
        data: { userId, action: "github_connected", targetType: "user", targetId: userId },
      });

      return reply.redirect(`${env.WEB_ORIGIN}/dashboard?connected=github`);
    } catch (err) {
      request.log.error({ err }, "github oauth callback failed");
      return reply.redirect(failureRedirect);
    }
  });
}
