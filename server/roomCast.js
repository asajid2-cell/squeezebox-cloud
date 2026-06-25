// roomCast — bridges a Watch Together room onto the VPS screen (screend).
//
// The screen joins the room as a WebSocket client (the same protocol the
// browsers use) and FOLLOWS the host: every play / pause / seek / source change
// the host triggers is broadcast to all room clients, including us, and we drive
// mpv to match. This is real sync controlled from the host — not a one-shot cast.
//
// Gating: we only ever join the ONE room code the tag is configured for, so we
// can never grab a stranger's stream. Between control events both sides play in
// real time; a drift timer re-seeks mpv if it falls out of step (buffering).

import { WebSocket } from "ws";
import { playVideo, stopVideo, pauseVideo, resumeVideo, seekVideo, screenStatus } from "./screenClient.js";

const WT_WS = process.env.WT_WS_URL || "ws://127.0.0.1:4190/ws";
const WT_BASE = (process.env.WT_BASE_URL || "http://127.0.0.1:4190").replace(/\/+$/, "");
const DRIFT_TOLERANCE_S = Number(process.env.ROOMCAST_DRIFT_S) || 2.5;
const DRIFT_POLL_MS = Number(process.env.ROOMCAST_POLL_MS) || 6000;
const RECONNECT_MS = 1500;

let active = null; // the one in-flight cast, or null

// A room source is { url, streamType, contentId }. youtube/absolute URLs play
// directly; the WT HLS proxy gives a relative path served by the local WT app.
function resolveSourceUrl(source) {
  const u = source && source.url ? String(source.url) : "";
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  return WT_BASE + (u.startsWith("/") ? u : `/${u}`);
}

// The room's authoritative position extrapolated to "now" (PLAYING advances from
// serverTs; PAUSED holds). Mirrors how the WT browser clients stay in sync.
function livePosition(state) {
  if (!state) return 0;
  const base = Number(state.position) || 0;
  if (state.status !== "PLAYING") return Math.max(0, base);
  const elapsed = (Date.now() - (Number(state.serverTs) || Date.now())) / 1000;
  return Math.max(0, base + elapsed * (Number(state.rate) || 1));
}

async function applyState(a, state, { reload = false } = {}) {
  if (!a || a.closed || !state) return;
  a.lastState = state;
  const url = resolveSourceUrl(state.source);
  const pos = livePosition(state);

  // Load (or reload) the video when the source changes.
  if (reload || a.loadedUrl !== url) {
    if (!url) { a.loadedUrl = null; await stopVideo().catch(() => {}); return; }
    a.loadedUrl = url;
    await playVideo({ url, seek: pos }).catch(() => {}); // a stream — not looping
    if (state.status !== "PLAYING") await pauseVideo().catch(() => {});
    return;
  }

  // Same source — match the transport (play/pause) + position.
  if (state.status === "PLAYING") {
    await resumeVideo().catch(() => {});
    await seekVideo(pos).catch(() => {});
  } else {
    await pauseVideo().catch(() => {});
    await seekVideo(pos).catch(() => {});
  }
}

async function driftCheck(a) {
  if (!a || a.closed || !a.loadedUrl) return;
  const st = a.lastState;
  if (!st || st.status !== "PLAYING") return;
  const status = await screenStatus().catch(() => null);
  if (!status || typeof status.position !== "number") return;
  const expected = livePosition(st);
  if (Math.abs(status.position - expected) > DRIFT_TOLERANCE_S) {
    await seekVideo(expected).catch(() => {});
  }
}

export function startRoomCast(code) {
  stopRoomCast();
  const a = { code: String(code), ws: null, lastState: null, loadedUrl: null, closed: false, driftTimer: null };
  active = a;

  const connect = () => {
    if (a.closed) return;
    let ws;
    try { ws = new WebSocket(WT_WS); } catch { setTimeout(connect, RECONNECT_MS); return; }
    a.ws = ws;
    ws.on("open", () => { try { ws.send(JSON.stringify({ type: "join", room: a.code })); } catch { /* */ } });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      // welcome (on join) + source (new pick) carry full state and need a (re)load;
      // sync (play/pause/seek/rate) just adjusts transport on the same source.
      if (m.type === "welcome") applyState(a, m.state, { reload: true });
      else if (m.type === "source") applyState(a, m.state, { reload: true });
      else if (m.type === "sync") applyState(a, m.state);
    });
    ws.on("close", () => { if (!a.closed) setTimeout(connect, RECONNECT_MS); });
    ws.on("error", () => { try { ws.close(); } catch { /* */ } });
  };
  connect();

  a.driftTimer = setInterval(() => { driftCheck(a).catch(() => {}); }, DRIFT_POLL_MS);
  a.driftTimer.unref?.();
  return a;
}

export function stopRoomCast() {
  const a = active;
  active = null;
  if (!a) return;
  a.closed = true;
  if (a.driftTimer) clearInterval(a.driftTimer);
  try { a.ws?.close(); } catch { /* */ }
  stopVideo().catch(() => {});
}

export function roomCastInfo() {
  return active ? { code: active.code, loaded: Boolean(active.loadedUrl), status: active.lastState?.status || null } : null;
}
