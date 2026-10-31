import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { SESSION_COOKIE, getSessionUser } from "../lib/auth/session.js";
import { CSRF_COOKIE, CSRF_HEADER, csrfTokensMatch } from "../lib/auth/csrf.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Attaches request.user from the session cookie, and enforces the double-submit
 * CSRF cookie/header pair on mutating requests. Routes opt into requiring a user
 * via the requireAuth preHandler (see middleware/require-auth.ts).
 */
export function registerAuthContext(app: FastifyInstance, prisma: PrismaClient) {
  app.addHook("preHandler", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) {
      const unsigned = request.unsignCookie(sessionId);
      if (unsigned.valid && unsigned.value) {
        const user = await getSessionUser(prisma, unsigned.value);
        if (user) {
          request.user = { id: user.id, email: user.email };
        }
      }
    }

    if (
      MUTATING_METHODS.has(request.method) &&
      !request.url.startsWith("/auth/login") &&
      !request.url.startsWith("/auth/signup")
    ) {
      const cookieToken = request.cookies[CSRF_COOKIE];
      const headerToken = request.headers[CSRF_HEADER] as string | undefined;
      if (!csrfTokensMatch(cookieToken, headerToken)) {
        return reply.code(403).send({ error: "csrf_token_invalid" });
      }
    }
  });
}
