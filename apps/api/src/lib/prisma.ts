import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  prisma ??= new PrismaClient();
  return prisma;
}
