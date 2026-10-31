const fastify = require("fastify")();

fastify.get("/health", async () => ({ status: "ok" }));
fastify.post("/api/items", async (req) => ({ created: req.body }));

fastify.listen({ port: 3001 });
