const express = require("express");
const mongoose = require("mongoose");
mongoose.connect(process.env.MONGODB_URI);
const app = express();
const secret = process.env.JWT_SECRET;
app.get("/api/jobs", async (req, res) => res.json([]));
app.post("/api/jobs", (req, res) => res.status(201).json({ ok: Boolean(secret) }));
app.listen(process.env.PORT || 5000);
