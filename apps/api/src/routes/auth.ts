import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { SignupInput, LoginInput } from "@autoinfra/shared";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import {
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../lib/auth/session.js";
import { CSRF_COOKIE, generateCsrfToken } from "../lib/auth/csrf.js";
import { requireAuth } from "../middleware/require-auth.js";
import type { Env } from "../env.js";
import type { Limits } from "../lib/rate-limit.js";

let dummy: Promise<string> | undefined;
/** A real argon2 hash of a random password, for timing-equal failed logins. */
function dummyHash() {
  dummy ??= hashPassword(crypto.randomUUID());
  return dummy;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  env: Env,
  limits: Limits,
) {
  const isProd = env.NODE_ENV === "production";

  function setSessionCookie(reply: import("fastify").FastifyReply, sessionId: string) {
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      signed: true,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  function setCsrfCookie(reply: import("fastify").FastifyReply) {
    const token = generateCsrfToken();
    reply.setCookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return token;
  }

  app.get("/auth/csrf", async (_request, reply) => {
    const token = setCsrfCookie(reply);
    return { csrfToken: token };
  });

  app.post("/auth/signup", { preHandler: limits.signup }, async (request, reply) => {
    const parsed = SignupInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", details: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "email_taken" });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({ data: { email, passwordHash } });
    const session = await createSession(prisma, user.id);
    setSessionCookie(reply, session.id);
    setCsrfCookie(reply);

    await prisma.auditEvent.create({
      data: { userId: user.id, action: "signup", targetType: "user", targetId: user.id },
    });

    return reply.code(201).send({ id: user.id, email: user.email });
  });

  app.post("/auth/login", { preHandler: limits.login }, async (request, reply) => {
    const parsed = LoginInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", details: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    // Always run one argon2 verification so response time doesn't reveal
    // which emails have accounts.
    const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);
    if (!user || !user.passwordHash || !valid) {
      if (user) {
        await prisma.auditEvent.create({
          data: {
            userId: user.id,
            action: "login_failed",
            targetType: "user",
            targetId: user.id,
            metadata: { ip: request.ip },
          },
        });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const session = await createSession(prisma, user.id);
    setSessionCookie(reply, session.id);
    setCsrfCookie(reply);

    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "login",
        targetType: "user",
        targetId: user.id,
        metadata: { ip: request.ip },
      },
    });

    return { id: user.id, email: user.email };
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) {
      const unsigned = request.unsignCookie(sessionId);
      if (unsigned.valid && unsigned.value) {
        await destroySession(prisma, unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    await prisma.auditEvent.create({
      data: {
        userId: request.user!.id,
        action: "logout",
        targetType: "user",
        targetId: request.user!.id,
      },
    });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request) => {
    return request.user;
  });
}
