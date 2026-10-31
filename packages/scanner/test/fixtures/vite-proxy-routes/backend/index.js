const express = require("express");

const todos = [];
const auth = express.Router();
auth.post("/login", (req, res) => res.json({ ok: true }));

const app = express();
app.use(express.json());
app.get("/todos", (req, res) => res.json(todos));
app.post("/todos", (req, res) => res.status(201).json(req.body));
app.use("/auth", auth);
app.get("/health", (req, res) => res.send("ok"));
app.listen(process.env.PORT || 4000);
