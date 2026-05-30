import { createApp } from "./app.js";
import { config } from "./state.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = createApp();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

if (process.env.NODE_ENV === "production") {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.listen(config.port, () => {
  console.log(`Squeezebox Cloud API listening on http://127.0.0.1:${config.port}`);
});
