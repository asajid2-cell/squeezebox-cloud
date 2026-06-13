// Reverse bridge -- LIVE cast.
//
// Relays the Harmonizer browser's ACTUAL Web Audio output to the Squeezebox so
// the box plays the exact same canon/jukebox the user hears (same jumps, same
// voices), and live setting changes (add a voice, switch mode) flow through.
//
// The browser taps its master mix, converts to Int16 PCM, and streams it over a
// WebSocket to /api/cast-ingest/<session>. We pipe that PCM through ffmpeg into a
// continuous mp3 stream and fan it out to whoever pulls /api/canon-stream/<session>
// (LMS, once the play trigger points it here). Pure passthrough -- nothing is
// re-derived, so it is identical to native by construction.
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const SANITIZE = /[^A-Za-z0-9+_-]/g;
const IDLE_MS = 30000; // reap a session that stops receiving PCM
const sessions = new Map(); // session -> CastSession

class CastSession {
  constructor(session, sampleRate, channels) {
    this.session = session;
    this.subscribers = new Set(); // res objects (LMS pulls)
    this.alive = true;
    this.lastData = Date.now();
    const sr = String(Math.max(8000, Math.min(96000, Math.round(sampleRate) || 48000)));
    const ch = String(channels === 1 ? 1 : 2);
    // s16le PCM in -> continuous mp3 out. No ID3/Xing header so a late LMS pull
    // can join the frame stream mid-flight (mp3 frames are self-syncing).
    this.ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", sr, "-ac", ch, "-i", "pipe:0",
      "-c:a", "libmp3lame", "-b:a", "192k",
      "-write_xing", "0", "-id3v2_version", "0",
      "-flush_packets", "1",
      "-f", "mp3", "pipe:1"
    ]);
    this.ff.stdin.on("error", () => {});      // swallow EPIPE on teardown
    this.ff.stderr.on("data", () => {});
    this.ff.stdout.on("data", (chunk) => {
      for (const res of this.subscribers) {
        try { res.write(chunk); } catch { this.subscribers.delete(res); }
      }
    });
    this.ff.on("close", () => this.close());
    this.ff.on("error", () => this.close());
  }

  writePcm(buf) {
    this.lastData = Date.now();
    if (this.alive && this.ff.stdin.writable) {
      try { this.ff.stdin.write(buf); } catch { /* closing */ }
    }
  }

  subscribe(res) { this.subscribers.add(res); }
  unsubscribe(res) { this.subscribers.delete(res); }

  close() {
    if (!this.alive) return;
    this.alive = false;
    sessions.delete(this.session);
    try { this.ff.stdin.end(); } catch {}
    try { this.ff.kill("SIGKILL"); } catch {}
    for (const res of this.subscribers) { try { res.end(); } catch {} }
    this.subscribers.clear();
  }
}

export function hasCastSession(session) {
  return sessions.has(session);
}

// Serve the live mp3 to a puller (LMS). Returns false if no such live session.
export function serveCast(session, req, res) {
  const s = sessions.get(session);
  if (!s) return false;
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-cache, no-store");
  s.subscribe(res);
  const cleanup = () => s.unsubscribe(res);
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
  return true;
}

const castWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

castWss.on("connection", (socket, _req, session, sampleRate, channels) => {
  let relay = sessions.get(session);
  if (!relay) { relay = new CastSession(session, sampleRate, channels); sessions.set(session, relay); }
  socket.on("message", (data, isBinary) => {
    if (!isBinary || !relay.alive) return;
    relay.writePcm(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  socket.on("close", () => relay.close());
  socket.on("error", () => {});
});

// The play trigger, handled at the raw-server level (bypasses Express + its https
// redirect). Hands LMS a synthetic canon:<session> track that resolvePlayableTarget
// turns into our /api/canon-stream/<session> URL. Service-key authed (Harmonizer calls it).
export function handleCanonPlay(req, res, lms) {
  const key = process.env.AUTH_SERVICE_KEY || "";
  if (!key || req.headers["x-hl-service-key"] !== key) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Service key required" }));
    return;
  }
  let body = "";
  let aborted = false;
  req.on("data", (c) => { body += c; if (body.length > 100000) { aborted = true; req.destroy(); } });
  req.on("end", async () => {
    if (aborted) return;
    let p = {};
    try { p = JSON.parse(body || "{}"); } catch {}
    const session = String(p.trackId || p.session || "").replace(SANITIZE, "");
    if (!session) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session" }));
      return;
    }
    const mode = ["canon", "eternal", "jukebox"].includes(String(p.mode || "").toLowerCase())
      ? String(p.mode).toLowerCase() : "canon";
    const track = {
      id: `canon:${session}`,
      title: String(p.title || "Harmonizer (live)").slice(0, 200),
      artist: String(p.artist || "Harmonizer").slice(0, 200),
      canonMode: mode,
      canonVoices: Math.max(1, Math.min(8, Number(p.voiceCount) || 2))
    };
    try {
      const status = await lms.status();
      if (!status || !status.connected || !status.id) throw new Error("No LMS player connected");
      await lms.playTrack(status.id, track, "play-now");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode, player: status.name || "Squeezebox" }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
  });
}

// Route a WebSocket upgrade for /api/cast-ingest/<session>?sr=&ch= (called by index.js).
export function handleCastUpgrade(req, socket, head) {
  let u;
  try { u = new URL(req.url, "http://x"); } catch { try { socket.destroy(); } catch {} return; }
  const session = u.pathname.slice("/api/cast-ingest/".length).replace(SANITIZE, "");
  if (!session) { try { socket.destroy(); } catch {} return; }
  const sr = Number(u.searchParams.get("sr")) || 48000;
  const ch = Number(u.searchParams.get("ch")) || 2;
  castWss.handleUpgrade(req, socket, head, (ws) => castWss.emit("connection", ws, req, session, sr, ch));
}

setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastData > IDLE_MS) s.close();
  }
}, 10000).unref?.();
