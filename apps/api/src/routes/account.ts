import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { FreeTierMode, SignupInput } from "@autoinfra/shared";
import { requireAuth } from "../middleware/require-auth.js";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import { SESSION_COOKIE } from "../lib/auth/session.js";
import { CSRF_COOKIE } from "../lib/auth/csrf.js";
import { isPlaceholderEmail } from "../lib/auth/placeholder-email.js";
import type { Limits } from "../lib/rate-limit.js";

const SettingsInput = z.object({ freeTierModeDefault: FreeTierMode });

const AuditQuery = z.object({
  /** The last event id of the previous page. */
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const PasswordInput = z.object({
  /** Required when the account already has a password. */
  currentPassword: z.string().max(256).optional(),
  newPassword: SignupInput.shape.password,
  /** Required when adding a password to a GitHub-only account (it has no usable email). */
  email: z.string().trim().email().optional(),
});

/** Account settings, password, sessions, and the owner's own audit trail. */
export function registerAccountRoutes(app: FastifyInstance, prisma: PrismaClient, limits: Limits) {
  function currentSessionId(request: FastifyRequest): string | undefined {
    const raw = request.cookies[SESSION_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    return unsigned?.valid ? (unsigned.value ?? undefined) : undefined;
  }

  app.get("/account/settings", { preHandler: requireAuth }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.id },
      select: {
        email: true,
        freeTierModeDefault: true,
        passwordHash: true,
        githubConnection: { select: { githubLogin: true } },
      },
    });
    const activeSessions = await prisma.session.count({
      where: { userId: request.user!.id, expiresAt: { gt: new Date() } },
    });
    return {
      email: user.email,
      freeTierModeDefault: user.freeTierModeDefault,
      hasPassword: !!user.passwordHash,
      emailIsPlaceholder: isPlaceholderEmail(user.email),
      githubLogin: user.githubConnection?.githubLogin ?? null,
      activeSessions,
    };
  });

  /**
   * Change the password, or add one to a GitHub-only account (with a real
   * email to sign in with) so losing GitHub access doesn't lock them out.
   * Every other session is signed out afterwards.
   */
  app.post(
    "/account/password",
    { preHandler: [requireAuth, limits.passwordChange] },
    async (request, reply) => {
      const parsed = PasswordInput.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_input",
          message: "The new password needs at least 12 characters.",
        });
      }
      const { currentPassword, newPassword, email } = parsed.data;
      const userId = request.user!.id;
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

      if (user.passwordHash) {
        if (!currentPassword || !(await verifyPassword(user.passwordHash, currentPassword))) {
          await prisma.auditEvent.create({
            data: {
              userId,
              action: "password_change_failed",
              targetType: "user",
              targetId: userId,
              metadata: { ip: request.ip },
            },
          });
          return reply
            .code(400)
            .send({ error: "wrong_password", message: "Your current password is not right." });
        }
      }

      let newEmail: string | undefined;
      if (isPlaceholderEmail(user.email)) {
        if (!email || isPlaceholderEmail(email)) {
          return reply.code(400).send({
            error: "email_required",
            message: "Add the email address you'll sign in with.",
          });
        }
        if (await prisma.user.findUnique({ where: { email } })) {
          return reply
            .code(409)
            .send({ error: "email_taken", message: "Another account already uses that email." });
        }
        newEmail = email;
      }

      const updated = await prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: await hashPassword(newPassword),
          ...(newEmail ? { email: newEmail } : {}),
        },
      });
      const keep = currentSessionId(request);
      const { count: signedOut } = await prisma.session.deleteMany({
        where: { userId, ...(keep ? { id: { not: keep } } : {}) },
      });
      await prisma.auditEvent.create({
        data: {
          userId,
          action: user.passwordHash ? "password_changed" : "password_added",
          targetType: "user",
          targetId: userId,
          metadata: {
            ip: request.ip,
            otherSessionsSignedOut: signedOut,
            ...(newEmail ? { email: newEmail } : {}),
          },
        },
      });
      return { email: updated.email, hasPassword: true, otherSessionsSignedOut: signedOut };
    },
  );

  /** "Sign out everywhere": ends every session of this account, this one included. */
  app.post("/account/sessions/revoke", { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.user!.id;
    const { count } = await prisma.session.deleteMany({ where: { userId } });
    await prisma.auditEvent.create({
      data: {
        userId,
        action: "signed_out_everywhere",
        targetType: "user",
        targetId: userId,
        metadata: { ip: request.ip, sessions: count },
      },
    });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { sessionsEnded: count };
  });

  app.put("/account/settings", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = SettingsInput.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_input",
        message: 'freeTierModeDefault must be "strict" or "flexible".',
      });
    }
    const userId = request.user!.id;
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { freeTierModeDefault: true },
    });
    const user = await prisma.user.update({
      where: { id: userId },
      data: { freeTierModeDefault: parsed.data.freeTierModeDefault },
      select: { email: true, freeTierModeDefault: true },
    });
    if (before.freeTierModeDefault !== user.freeTierModeDefault) {
      await prisma.auditEvent.create({
        data: {
          userId,
          action: "settings_changed",
          targetType: "user",
          targetId: userId,
          metadata: {
            freeTierModeDefault: { from: before.freeTierModeDefault, to: user.freeTierModeDefault },
          },
        },
      });
    }
    return user;
  });

  app.get("/account/audit", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = AuditQuery.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const { after, limit } = parsed.data;
    const userId = request.user!.id;
    const events = await prisma.auditEvent.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    const page = events.slice(0, limit);

    // Name deployment targets by repo -- only the owner's own (a deleted or
    // foreign id just stays unnamed).
    const deploymentIds = [
      ...new Set(
        page.filter((e) => e.targetType === "deployment" && e.targetId).map((e) => e.targetId!),
      ),
    ];
    const deployments = deploymentIds.length
      ? await prisma.deployment.findMany({
          where: { id: { in: deploymentIds }, ownerId: userId },
          select: { id: true, repoUrl: true, branch: true },
        })
      : [];
    // No branch yet: the repo's default branch, named by the first analyze.
    const names = new Map(
      deployments.map((d) => [
        d.id,
        `${d.repoUrl.replace("https://github.com/", "")}${d.branch ? `@${d.branch}` : ""}`,
      ]),
    );

    return {
      events: page.map((e) => ({
        id: e.id,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        targetName: e.targetId ? (names.get(e.targetId) ?? null) : null,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
      nextAfter: events.length > limit ? page.at(-1)!.id : null,
    };
  });
}
