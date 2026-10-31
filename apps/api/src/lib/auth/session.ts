import type { PrismaClient } from "@prisma/client";

export const SESSION_COOKIE = "ai_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createSession(prisma: PrismaClient, userId: string) {
  return prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
}

export async function getSessionUser(prisma: PrismaClient, sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return session.user;
}

export async function destroySession(prisma: PrismaClient, sessionId: string) {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}
