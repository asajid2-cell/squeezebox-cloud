import { createApp, prewarmLibraryCaches, prewarmSpotifySearchCaches } from "./app.js";
import { LmsClient } from "./lmsClient.js";
import { startArchiveService } from "./archiveService.js";
import { config } from "./state.js";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCastUpgrade, hasSession as hasCastSession, serveCast, handleCanonPlay } from "./boomRelay.js";

const lms = new LmsClient();
await prewarmLibraryCaches(lms).catch(() => null);
const app = createApp({ lms });

// Live Squeezebox cast (the reverse bridge): serve the browser's relayed audio to
// LMS, and the play trigger, at the raw-server level so they bypass Express and its
// https redirect. Everything else falls through to the Express app unchanged.
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, "http://x").pathname; } catch { pathname = req.url || ""; }
  if (req.method === "GET" && pathname.startsWith("/api/canon-stream/")) {
    const session = pathname.slice("/api/canon-stream/".length).split("/")[0].replace(/[^A-Za-z0-9+_-]/g, "");
    if (session && hasCastSession(session)) { serveCast(session, req, res); return; }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No live cast for this session" }));
    return;
  }
  if (req.method === "POST" && pathname === "/api/player/canon") {
    handleCanonPlay(req, res, lms);
    return;
  }
  app(req, res);
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

// Upgrade router for the live Squeezebox cast: /api/cast-ingest/<session> (browser
// PCM ingest). boomRelay owns its own WebSocketServer in noServer mode.
server.on("upgrade", (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, "http://x").pathname; } catch { socket.destroy(); return; }
  if (pathname.startsWith("/api/cast-ingest/")) {
    handleCastUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(distDir));
  // Squeezebox Tap is its own entry — serve tap.html for /tap/* paths
  // (/tap/t/:id public tapper, /tap/link admin console).
  app.get(/^\/tap(\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(distDir, "tap.html"));
  });
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

server.listen(config.port, () => {
  console.log(`Squeezebox Cloud API listening on http://127.0.0.1:${config.port}`);
  startArchiveService();
  prewarmSpotifySearchCaches(lms).catch(() => null);
  for (const delayMs of [5000, 20000]) {
    const timer = setTimeout(() => {
      prewarmSpotifySearchCaches(lms).catch(() => null);
    }, delayMs);
    timer.unref?.();
  }
});
