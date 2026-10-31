// Fake test credential (AWS's documented example key ID) -- not a real secret.
const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
const express = require("express");
express().listen(3000);
module.exports = { accessKeyId };
