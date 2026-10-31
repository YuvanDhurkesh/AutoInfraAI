const express = require("express");

const app = express();
app.use(express.json());

// In-memory on purpose: this sample shows request/response on Lambda, not
// persistence. Notes reset whenever Lambda starts a fresh instance.
const startedAt = new Date().toISOString();
const notes = [{ id: 1, text: "Deployed by AutoInfra", createdAt: startedAt }];

app.get("/api/health", (req, res) => {
  res.json({ ok: true, startedAt, runtime: process.env.AWS_EXECUTION_ENV || "local" });
});

const api = express.Router();

api.get("/notes", (req, res) => {
  res.json(notes);
});

api.post("/notes", (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > 280) {
    return res.status(400).json({ error: "text must be 1-280 characters" });
  }
  const note = { id: notes.length + 1, text, createdAt: new Date().toISOString() };
  notes.push(note);
  res.status(201).json(note);
});

app.use("/api", api);

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`notes api listening on ${port}`));
