const express = require("express");
const app = express();
app.get("/health", (req, res) => res.send("ok"));
app.listen(8080);
const table = process.env.TABLE_NAME;
