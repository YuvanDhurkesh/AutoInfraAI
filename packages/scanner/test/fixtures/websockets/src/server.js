const express = require("express");
const { WebSocketServer } = require("ws");
const server = express().listen(5000);
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => ws.send("hi"));
