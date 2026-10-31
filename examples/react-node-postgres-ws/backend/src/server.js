const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  // Postgres can take a few seconds to accept connections after a restart.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`waiting for database (${err.code || err.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const app = express();
app.use(express.json());

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "up" });
  } catch {
    res.status(503).json({ ok: false, database: "down" });
  }
});

const api = express.Router();

api.get("/messages", async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, text, created_at AS "createdAt" FROM messages ORDER BY id DESC LIMIT 50',
  );
  res.json(rows.reverse());
});

api.post("/messages", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > 280) {
    return res.status(400).json({ error: "text must be 1-280 characters" });
  }
  const { rows } = await pool.query(
    'INSERT INTO messages (text) VALUES ($1) RETURNING id, text, created_at AS "createdAt"',
    [text],
  );
  broadcast({ type: "message", message: rows[0] });
  res.status(201).json(rows[0]);
});

app.use("/api", api);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/api/ws" });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "online", count: wss.clients.size }));
  broadcast({ type: "online", count: wss.clients.size });
  socket.on("close", () => broadcast({ type: "online", count: wss.clients.size }));
});

const port = process.env.PORT || 4000;
migrate()
  .then(() => server.listen(port, () => console.log(`chat api listening on ${port}`)))
  .catch((err) => {
    console.error("database migration failed", err);
    process.exit(1);
  });
