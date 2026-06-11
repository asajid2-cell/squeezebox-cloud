import { createApp, prewarmLibraryCaches, prewarmSpotifySearchCaches } from "./app.js";
import { LmsClient } from "./lmsClient.js";
import { startArchiveService } from "./archiveService.js";
import { config } from "./state.js";
import { createSyncCoordinator, READY_TIMEOUT_MS } from "./syncCoordinator.js";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const lms = new LmsClient();
await prewarmLibraryCaches(lms).catch(() => null);
const app = createApp({ lms });
const server = http.createServer(app);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");
const socketsBySession = new Map();
const socketsByDevice = new Map();
const readyTimers = new Map();

const sync = createSyncCoordinator({
  broadcast: (shareToken, message) => {
    const sockets = socketsBySession.get(shareToken);
    if (!sockets) return;
    for (const socket of sockets.values()) sendJson(socket, message);
  },
  unicast: (deviceId, message) => {
    const socket = socketsByDevice.get(deviceId);
    if (socket) sendJson(socket, message);
  }
});

const wss = new WebSocketServer({ server, path: "/sync" });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
      handleSyncMessage(socket, msg);
    } catch (error) {
      sendJson(socket, { type: "ERROR", error: error.message || "Invalid sync message" });
    }
  });
  socket.on("close", () => {
    if (socket.syncShareToken && socket.syncDeviceId) {
      removeSocket(socket.syncShareToken, socket.syncDeviceId);
      try {
        sync.leave({ shareToken: socket.syncShareToken, deviceId: socket.syncDeviceId });
      } catch {}
    }
  });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(distDir));
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

function handleSyncMessage(socket, msg) {
  const type = String(msg?.type || "");
  if (type === "JOIN") {
    const device = {
      id: msg.deviceId || msg.device?.id,
      label: msg.label || msg.device?.label,
      clockOffsetMs: msg.clockOffsetMs,
      rttMs: msg.rttMs,
      outputLatencyMs: msg.outputLatencyMs,
      nudgeMs: msg.nudgeMs,
      volume: msg.volume
    };
    const result = sync.createOrJoinSession({ shareToken: msg.shareToken, device });
    socket.syncShareToken = result.session.shareToken;
    socket.syncDeviceId = result.device.id;
    addSocket(result.session.shareToken, result.device.id, socket);
    sendJson(socket, { type: "JOINED", session: result.session, device: result.device, lateJoin: result.lateJoin || null });
    return;
  }

  const shareToken = msg.shareToken || socket.syncShareToken;
  const deviceId = msg.deviceId || socket.syncDeviceId;
  if (!shareToken || !deviceId) throw new Error("JOIN is required before sync messages");

  if (type === "CLOCK_PROBE") {
    sendJson(socket, sync.handleClockProbe({
      shareToken,
      deviceId,
      t0: msg.t0,
      probeGroupId: msg.probeGroupId,
      probeGroupIndex: msg.probeGroupIndex
    }));
    return;
  }

  if (type === "CLOCK_RESPONSE") {
    sendJson(socket, {
      type: "CLOCK_UPDATED",
      ...sync.handleClockResponse({
        shareToken,
        deviceId,
        clockOffsetMs: msg.clockOffsetMs,
        rttMs: msg.rttMs,
        outputLatencyMs: msg.outputLatencyMs,
        nudgeMs: msg.nudgeMs,
        t0: msg.t0,
        t1: msg.t1,
        t2: msg.t2,
        t3: msg.t3
      })
    });
    return;
  }

  if (type === "LOAD_AUDIO_SOURCE") {
    const result = sync.startLoad({
      shareToken,
      deviceId,
      url: msg.url,
      trackOffsetMs: msg.trackOffsetMs,
      track: msg.track,
      durationMs: msg.durationMs
    });
    resetReadyTimer(shareToken);
    sendJson(socket, { type: "LOAD_STARTED", session: result.session });
    return;
  }

  if (type === "CLIENT_READY") {
    const result = sync.markClientReady({ shareToken, deviceId });
    if (result.scheduled) clearReadyTimer(shareToken);
    sendJson(socket, { type: "READY_ACK", scheduled: result.scheduled });
    return;
  }

  if (type === "PAUSE") {
    sendJson(socket, { type: "PAUSE_ACK", ...sync.pause({ shareToken, deviceId, atServerTime: msg.atServerTime }) });
    return;
  }

  if (type === "RESUME") {
    sendJson(socket, { type: "RESUME_ACK", ...sync.resume({ shareToken, deviceId }) });
    return;
  }

  if (type === "SEEK") {
    sendJson(socket, { type: "SEEK_ACK", ...sync.seek({ shareToken, deviceId, trackOffsetMs: msg.trackOffsetMs }) });
    return;
  }

  if (type === "NUDGE") {
    sendJson(socket, {
      type: "NUDGE_ACK",
      ...sync.nudge({ shareToken, deviceId, targetDeviceId: msg.targetDeviceId || msg.deviceId, ms: msg.ms })
    });
    return;
  }

  if (type === "SET_VOLUME") {
    sendJson(socket, {
      type: "SET_VOLUME_ACK",
      ...sync.setVolume({ shareToken, deviceId, targetDeviceId: msg.targetDeviceId || msg.deviceId, volume: msg.volume })
    });
    return;
  }

  if (type === "LEAVE") {
    removeSocket(shareToken, deviceId);
    sync.leave({ shareToken, deviceId });
    sendJson(socket, { type: "LEFT" });
    socket.close();
    return;
  }

  throw new Error(`Unsupported sync message type: ${type}`);
}

function addSocket(shareToken, deviceId, socket) {
  if (!socketsBySession.has(shareToken)) socketsBySession.set(shareToken, new Map());
  socketsBySession.get(shareToken).set(deviceId, socket);
  socketsByDevice.set(deviceId, socket);
}

function removeSocket(shareToken, deviceId) {
  socketsByDevice.delete(deviceId);
  const sockets = socketsBySession.get(shareToken);
  if (sockets) {
    sockets.delete(deviceId);
    if (!sockets.size) socketsBySession.delete(shareToken);
  }
}

function resetReadyTimer(shareToken) {
  clearReadyTimer(shareToken);
  const timer = setTimeout(() => {
    try {
      sync.expirePendingLoad({ shareToken });
    } catch {}
    readyTimers.delete(shareToken);
  }, READY_TIMEOUT_MS);
  timer.unref?.();
  readyTimers.set(shareToken, timer);
}

function clearReadyTimer(shareToken) {
  const timer = readyTimers.get(shareToken);
  if (timer) clearTimeout(timer);
  readyTimers.delete(shareToken);
}

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
