const express = require("express");
const mysql = require("mysql2/promise");
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const app = express();
const allowed = process.env.CLIENT_URL;
const production = process.env.NODE_ENV === "production";
app.get("/api/tasks", async (req, res) => res.json((await pool.query("SELECT 1"))[0]));
app.post("/api/tasks", (req, res) => res.status(201).json({ allowed, production }));
app.listen(process.env.PORT || 5000);
