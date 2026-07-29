// boomRelay.js — decoupled, silence-filling, wall-clock-paced LMS relay (loop L1).
//
// The LMS-facing mp3 stream is ENDLESS and never EOFs. A wall-clock-paced feeder
// writes real-time PCM to a persistent ffmpeg, drawing from a small jitter/ring
// buffer when a source is present and SILENCE when it isn't. Source ingest (browser
// PCM over WS now; RTSP-decoded later) only ever FILLS the ring — it never controls
// ffmpeg's lifetime. So a source drop / reconnect / setting-change graph-rebuild can
// no longer stop the Boom. Over-buffering drops oldest audio to stay live (bounded
// latency); under-run inserts silence (no EOF, no choppiness from starvation).
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const SANITIZE = /[^A-Za-z0-9+_-]/g;
const FRAME_MS = 20;               // feeder granularity
const JITTER_MS = 240;             // ring depth before we drop-oldest (stay live)
const IDLE_REAP_MS = 30000;        // close only when no source AND nobody pulling
const sessions = new Map();

class BoomSession {
  constructor(session, sampleRate, channels) {
    this.session = session;
    this.sr = Math.max(8000, Math.min(96000, Math.round(sampleRate) || 48000));
    this.ch = channels === 1 ? 1 : 2;
    const frameSamples = Math.round((this.sr * FRAME_MS) / 1000);
    this.frameBytes = frameSamples * 2 * this.ch;        // s16le
    this.maxRingBytes = this.frameBytes * Math.ceil(JITTER_MS / FRAME_MS);
    this.silence = Buffer.alloc(this.frameBytes);
    this.ring = [];
    this.ringBytes = 0;
    this.subscribers = new Set();
    this.alive = true;
    this.lastSourceAt = Date.now();

    this.ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(this.sr), "-ac", String(this.ch), "-i", "pipe:0",
      "-c:a", "libmp3lame", "-b:a", "192k",
      "-write_xing", "0", "-id3v2_version", "0", "-flush_packets", "1",
      "-f", "mp3", "pipe:1"
    ]);
    this.ff.stdin.on("error", () => {});
    this.ff.stderr.on("data", () => {});
    // Always drain stdout (flowing mode) so ffmpeg never blocks even with no puller;
    // forward to whoever is pulling.
    this.ff.stdout.on("data", (chunk) => {
      for (const res of this.subscribers) {
        try { res.write(chunk); } catch { this.subscribers.delete(res); }
      }
    });
    this.ff.on("close", () => this.close());
    this.ff.on("error", () => this.close());

    this.startTime = Date.now();
    this.framesWritten = 0;
    this.timer = setInterval(() => this._tick(), FRAME_MS);
  }

  _tick() {
    if (!this.alive) return;
    // Drift-compensated: deliver exactly enough frames to match wall-clock since start,
    // so the encoded stream stays real-time regardless of timer jitter.
    const due = Math.floor((Date.now() - this.startTime) / FRAME_MS);
    let toWrite = due - this.framesWritten;
    if (toWrite <= 0) return;
    if (toWrite > 10) toWrite = 10;                       // cap catch-up burst
    for (let i = 0; i < toWrite; i++) {
      try { this.ff.stdin.write(this._nextFrame()); } catch {}
      this.framesWritten++;
    }
  }

  _nextFrame() {
    if (this.ringBytes < this.frameBytes) return this.silence;   // under-run → silence
    let need = this.frameBytes;
    const parts = [];
    while (need > 0 && this.ring.length) {
      const head = this.ring[0];
      if (head.length <= need) { parts.push(head); need -= head.length; this.ringBytes -= head.length; this.ring.shift(); }
      else { parts.push(head.subarray(0, need)); this.ring[0] = head.subarray(need); this.ringBytes -= need; need = 0; }
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  pushPcm(buf) {
    if (!this.alive || !buf || !buf.length) return;
    this.lastSourceAt = Date.now();
    this.ring.push(buf);
    this.ringBytes += buf.length;
    while (this.ringBytes > this.maxRingBytes && this.ring.length) {   // drop oldest → stay live
      const old = this.ring.shift();
      this.ringBytes -= old.length;
    }
  }

  subscribe(res) { this.subscribers.add(res); }
  unsubscribe(res) { this.subscribers.delete(res); }

  close() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.timer);
    sessions.delete(this.session);
    try { this.ff.stdin.end(); } catch {}
    try { this.ff.kill("SIGKILL"); } catch {}
    for (const res of this.subscribers) { try { res.end(); } catch {} }
    this.subscribers.clear();
  }
}

export function ensureSession(session, sr, ch) {
  let s = sessions.get(session);
  if (!s) { s = new BoomSession(session, sr, ch); sessions.set(session, s); }
  return s;
}
export function hasSession(session) { return sessions.has(session); }
export function stopSession(session) { const s = sessions.get(session); if (s) s.close(); }

// Serve the endless mp3 to a puller (LMS). Returns false if no such session.
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

// WebSocket PCM ingest. The session lifetime is DECOUPLED from this socket: when the
// source drops, the session keeps playing silence (the whole point of L1).
const castWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
castWss.on("connection", (socket, _req, session, sr, ch) => {
  const s = ensureSession(session, sr, ch);
  socket.on("message", (data, isBinary) => {
    if (isBinary && s.alive) s.pushPcm(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  socket.on("close", () => { /* decoupled — do NOT close the session */ });
  socket.on("error", () => {});
});

export function handleCastUpgrade(req, socket, head) {
  let u;
  try { u = new URL(req.url, "http://x"); } catch { try { socket.destroy(); } catch {} return; }
  const session = u.pathname.slice("/api/cast-ingest/".length).replace(SANITIZE, "");
  if (!session) { try { socket.destroy(); } catch {} return; }
  const sr = Number(u.searchParams.get("sr")) || 48000;
  const ch = Number(u.searchParams.get("ch")) || 2;
  castWss.handleUpgrade(req, socket, head, (ws) => castWss.emit("connection", ws, req, session, sr, ch));
}

// Play trigger (raw-server level, bypasses Express). Service-key authed. Hands LMS a
// synthetic canon:<session> that resolvePlayableTarget turns into the canon-stream URL.
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
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.subscribers.size === 0 && now - s.lastSourceAt > IDLE_REAP_MS) s.close();
  }
}, 10000).unref?.();
