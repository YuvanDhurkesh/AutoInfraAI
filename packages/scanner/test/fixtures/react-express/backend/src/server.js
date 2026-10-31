const express = require("express");
const app = express();

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", require("./routes"));

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`listening on ${port}`));
