const express = require("express");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI);

const app = express();
app.use(express.json());
app.get("/api/chat", (req, res) => res.json([]));
app.post("/api/chat", (req, res) => res.status(201).json(req.body));
app.use("/uploads", express.static("uploads"));

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT);
const io = require("socket.io")(server, { cors: { origin: "http://localhost:3000" } });
io.on("connection", (socket) => socket.on("message", (m) => io.emit("message", m)));
