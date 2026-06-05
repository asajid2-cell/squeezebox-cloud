import { createApp, prewarmLibraryCaches, prewarmSpotifySearchCaches } from "./app.js";
import { LmsClient } from "./lmsClient.js";
import { config } from "./state.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const lms = new LmsClient();
await prewarmLibraryCaches(lms).catch(() => null);
const app = createApp({ lms });
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
  prewarmSpotifySearchCaches(lms).catch(() => null);
  for (const delayMs of [5000, 20000]) {
    const timer = setTimeout(() => {
      prewarmSpotifySearchCaches(lms).catch(() => null);
    }, delayMs);
    timer.unref?.();
  }
});
