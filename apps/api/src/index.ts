import { loadEnv } from "./env.js";
import { getPrisma } from "./lib/prisma.js";
import { buildApp } from "./app.js";

async function main() {
  const env = loadEnv();
  const prisma = getPrisma();
  const app = await buildApp(env, prisma);

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
