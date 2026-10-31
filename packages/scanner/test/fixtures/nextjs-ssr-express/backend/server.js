const express = require("express");
const app = express();
app.get("/api/listings", (req, res) => res.json([]));
app.post("/api/listings", (req, res) => res.status(201).json({}));
app.listen(process.env.PORT || 5001);
