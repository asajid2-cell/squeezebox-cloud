import { createApp, prewarmLibraryCaches, prewarmSpotifySearchCaches } from "./app.js";
import { LmsClient } from "./lmsClient.js";
import { startArchiveService, startArchiveWatcher, startTapCache } from "./archiveService.js";
import { defaultTapStore } from "./tapStore.js";
import { defaultPlaylistStore } from "./playlists.js";
import { config } from "./state.js";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCastUpgrade, hasSession as hasCastSession, serveCast, handleCanonPlay } from "./boomRelay.js";

const lms = new LmsClient();
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
    // Raw-level routes bypass Express, so the app-level edge check never sees them. This one is a
    // control route (it triggers playback) and only ever arrives from the browser via nginx, so it
    // carries the edge key. Enforce it here too, or the cage has a hole the audit cannot see.
    const edgeKey = process.env.EDGE_KEY || "";
    const svc = process.env.AUTH_SERVICE_KEY || "";
    const okEdge = !edgeKey || req.headers["x-edge-key"] === edgeKey
      || (svc && req.headers["x-hl-service-key"] === svc);
    if (!okEdge) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "direct_access_denied" }));
      return;
    }
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
    // Same proof-of-edge check as the rest of the app. The upgrade handler runs on the raw server, so
    // the Express middleware never sees it -- and unauthenticated it would let any on-box or
    // docker-bridge caller spawn an ffmpeg child per connection and register a session name that LMS
    // may then pull. nginx injects X-Edge-Key on proxied upgrades, so the browser path is unaffected.
    const edgeKey = process.env.EDGE_KEY || "";
    const svc = process.env.AUTH_SERVICE_KEY || "";
    const ok = !edgeKey || req.headers["x-edge-key"] === edgeKey
      || (svc && req.headers["x-hl-service-key"] === svc);
    if (!ok) { socket.destroy(); return; }
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
  // Warm the library caches in the BACKGROUND. This used to be an `await` before
  // listen(), which made the whole app unreachable for several seconds after every
  // restart/deploy while a full multi-thousand-file scan ran — it looked like the
  // server had "disconnected". Now we listen immediately and warm behind it; the
  // first library view still triggers (and caches) the scan on demand.
  prewarmLibraryCaches(lms).catch(() => null);
  startArchiveService();
  // Auto-archiver: watch Spotify playlists named "archive*" and pull in new tracks.
  startArchiveWatcher(lms);
  // Instant-tap cache: keep each tag's first song local so taps play immediately.
  startTapCache(lms, () => defaultTapStore.list(), defaultPlaylistStore);
  prewarmSpotifySearchCaches(lms).catch(() => null);
  for (const delayMs of [5000, 20000]) {
    const timer = setTimeout(() => {
      prewarmSpotifySearchCaches(lms).catch(() => null);
    }, delayMs);
    timer.unref?.();
  }
});
