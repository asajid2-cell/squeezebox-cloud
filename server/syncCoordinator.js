import crypto from "node:crypto";

export const PROBE_GAP_TOLERANCE_MS = 5;
// The host must not start playback until every device has the audio buffered (the
// buffer-to-the-slowest model). Cold Spotify->MP3 generation can take ~15-20s, so the
// readiness gate waits up to this long for all devices to report ready before it
// schedules play (it fires early the instant ALL devices are ready, so a warm/cached
// group still starts in <1s — this cap only bounds the wait on a genuinely slow device).
export const READY_TIMEOUT_MS = 30000;
export const LATE_JOIN_MIN_REMAINING_MS = 3000;

export function computeClockMeasurement({ t0, t1, t2, t3 }) {
  const clockOffsetMs = (t1 - t0 + (t2 - t3)) / 2;
  const rttMs = t3 - t0 - (t2 - t1);
  return { clockOffsetMs, rttMs };
}

export function validateCodedProbePair(first, second, toleranceMs = PROBE_GAP_TOLERANCE_MS) {
  if (!first || !second) return { ok: false, reason: "missing_probe" };
  const clientGapMs = Number(second.t0) - Number(first.t0);
  const serverGapMs = Number(second.t1) - Number(first.t1);
  const driftMs = Math.abs(serverGapMs - clientGapMs);
  return {
    ok: driftMs <= toleranceMs,
    clientGapMs,
    serverGapMs,
    driftMs
  };
}

function defaultClock() {
  return Date.now();
}

function defaultId() {
  return crypto.randomUUID();
}

function normalizeDevice(device = {}, now = defaultClock()) {
  const id = String(device.id || device.deviceId || "").trim();
  if (!id) throw new Error("device id is required");
  return {
    id,
    label: String(device.label || device.name || id),
    role: "guest",
    clockOffsetMs: Number(device.clockOffsetMs) || 0,
    rttMs: Math.max(0, Number(device.rttMs) || 0),
    outputLatencyMs: Math.max(0, Number(device.outputLatencyMs) || 0),
    nudgeMs: Number(device.nudgeMs) || 0,
    volume: Number.isFinite(Number(device.volume)) ? Math.max(0, Math.min(1, Number(device.volume))) : 1,
    lastSeen: now,
    ws: device.ws
  };
}

function publicDevice(device) {
  const { ws, pendingProbes, ...rest } = device;
  return { ...rest };
}

function publicSession(session) {
  return {
    id: session.id,
    shareToken: session.shareToken,
    hostId: session.hostId,
    track: session.track ? { ...session.track } : null,
    state: session.state,
    startAtServerTime: session.startAtServerTime,
    trackOffsetMs: session.trackOffsetMs,
    devices: Array.from(session.devices.values()).map(publicDevice),
    pendingLoad: session.pendingLoad
      ? {
          url: session.pendingLoad.url,
          trackOffsetMs: session.pendingLoad.trackOffsetMs,
          waitingFor: Array.from(session.pendingLoad.waitingFor),
          ready: Array.from(session.pendingLoad.ready),
          startedAt: session.pendingLoad.startedAt
        }
      : null
  };
}

export class SyncCoordinator {
  constructor({ clock = defaultClock, idFactory = defaultId, broadcast = () => {}, unicast = () => {} } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.broadcast = broadcast;
    this.unicast = unicast;
    this.sessions = new Map();
    this.deviceSessions = new Map();
  }

  createOrJoinSession({ shareToken, device }) {
    const token = String(shareToken || "").trim() || this.idFactory();
    let session = this.sessions.get(token);
    const now = this.clock();
    const normalized = normalizeDevice(device, now);

    if (!session) {
      normalized.role = "host";
      session = {
        id: this.idFactory(),
        shareToken: token,
        hostId: normalized.id,
        track: null,
        state: "paused",
        startAtServerTime: 0,
        trackOffsetMs: 0,
        devices: new Map(),
        pendingLoad: null
      };
      this.sessions.set(token, session);
    } else {
      normalized.role = normalized.id === session.hostId ? "host" : "guest";
    }

    const existing = session.devices.get(normalized.id);
    session.devices.set(normalized.id, { ...(existing || {}), ...normalized, pendingProbes: existing?.pendingProbes || new Map() });
    this.deviceSessions.set(normalized.id, token);

    const lateJoin = this.lateJoinSchedule(session, normalized.id);
    if (lateJoin?.message) {
      this.unicast(normalized.id, lateJoin.message);
    }

    return { session: publicSession(session), device: publicDevice(session.devices.get(normalized.id)), lateJoin };
  }

  leave({ shareToken, deviceId }) {
    const session = this.requireSession(shareToken);
    const id = String(deviceId || "");
    session.devices.delete(id);
    this.deviceSessions.delete(id);
    if (session.pendingLoad) {
      session.pendingLoad.waitingFor.delete(id);
      session.pendingLoad.ready.delete(id);
    }
    if (session.hostId === id) {
      const next = session.devices.values().next().value;
      if (next) {
        next.role = "host";
        session.hostId = next.id;
      } else {
        this.sessions.delete(session.shareToken);
      }
    }
    return session.devices.size ? publicSession(session) : null;
  }

  handleClockProbe({ shareToken, deviceId, t0, probeGroupId, probeGroupIndex }) {
    const session = this.requireSession(shareToken);
    const device = this.requireDevice(session, deviceId);
    const t1 = this.clock();
    const t2 = this.clock();
    const response = { type: "CLOCK_RESPONSE", t0, t1, t2, probeGroupId, probeGroupIndex, accepted: true };

    if (probeGroupId !== undefined && probeGroupIndex !== undefined) {
      const key = String(probeGroupId);
      const probe = { t0: Number(t0), t1, t2, probeGroupId, probeGroupIndex };
      device.pendingProbes ||= new Map();
      if (Number(probeGroupIndex) === 0) {
        device.pendingProbes.set(key, probe);
        response.accepted = null;
        response.pendingPair = true;
      } else {
        const first = device.pendingProbes.get(key);
        device.pendingProbes.delete(key);
        const validation = validateCodedProbePair(first, probe);
        response.accepted = validation.ok;
        response.validation = validation;
      }
    }

    return response;
  }

  handleClockResponse({ shareToken, deviceId, clockOffsetMs, rttMs, outputLatencyMs, nudgeMs, t0, t1, t2, t3 }) {
    const session = this.requireSession(shareToken);
    const device = this.requireDevice(session, deviceId);
    let measurement = null;
    if ([t0, t1, t2, t3].every((value) => Number.isFinite(Number(value)))) {
      measurement = computeClockMeasurement({ t0: Number(t0), t1: Number(t1), t2: Number(t2), t3: Number(t3) });
    }
    device.clockOffsetMs = Number.isFinite(Number(clockOffsetMs)) ? Number(clockOffsetMs) : measurement?.clockOffsetMs ?? device.clockOffsetMs;
    device.rttMs = Math.max(0, Number.isFinite(Number(rttMs)) ? Number(rttMs) : measurement?.rttMs ?? device.rttMs);
    if (outputLatencyMs !== undefined) device.outputLatencyMs = Math.max(0, Number(outputLatencyMs) || 0);
    if (nudgeMs !== undefined) device.nudgeMs = Number(nudgeMs) || 0;
    device.lastSeen = this.clock();
    return { device: publicDevice(device), measurement };
  }

  startLoad({ shareToken, deviceId, url, trackOffsetMs = 0, track = null, durationMs = track?.durationMs }) {
    const session = this.requireSession(shareToken);
    this.assertHost(session, deviceId);
    const now = this.clock();
    const normalizedTrack = track
      ? {
          uri: track.uri || track.id || url,
          id: track.id || track.uri || url,
          source: track.source || "sync",
          durationMs: Number(durationMs || track.durationMs || 0) || 0,
          title: track.title,
          artist: track.artist
        }
      : { uri: url, id: url, source: "sync", durationMs: Number(durationMs || 0) || 0 };
    session.track = normalizedTrack;
    session.pendingLoad = {
      url,
      trackOffsetMs: Math.max(0, Number(trackOffsetMs) || 0),
      waitingFor: new Set(session.devices.keys()),
      ready: new Set(),
      startedAt: now
    };
    const message = { type: "LOAD_AUDIO_SOURCE", url, trackOffsetMs: session.pendingLoad.trackOffsetMs, track: { ...normalizedTrack } };
    this.broadcast(session.shareToken, message);
    return { session: publicSession(session), message };
  }

  markClientReady({ shareToken, deviceId }) {
    const session = this.requireSession(shareToken);
    if (!session.pendingLoad) return { scheduled: false, session: publicSession(session) };
    session.pendingLoad.ready.add(String(deviceId));
    if (this.allReady(session)) {
      return this.schedulePendingLoad(session, "ready");
    }
    return { scheduled: false, session: publicSession(session) };
  }

  expirePendingLoad({ shareToken }) {
    const session = this.requireSession(shareToken);
    if (!session.pendingLoad) return { scheduled: false, session: publicSession(session) };
    return this.schedulePendingLoad(session, "timeout");
  }

  pause({ shareToken, deviceId, atServerTime = null }) {
    const session = this.requireSession(shareToken);
    this.assertHost(session, deviceId);
    const when = Number(atServerTime) || this.clock() + this.computeHeadroomMs(session);
    session.trackOffsetMs = this.currentTrackOffsetMs(session, when);
    session.startAtServerTime = when;
    session.state = "paused";
    const message = { type: "PAUSE", atServerTime: when, trackOffsetMs: session.trackOffsetMs };
    this.broadcast(session.shareToken, message);
    return { session: publicSession(session), message };
  }

  resume({ shareToken, deviceId }) {
    const session = this.requireSession(shareToken);
    this.assertHost(session, deviceId);
    if (!session.track) throw new Error("No track is loaded");
    const startAtServerTime = this.clock() + this.computeHeadroomMs(session);
    session.startAtServerTime = startAtServerTime;
    session.state = "playing";
    const message = {
      type: "SCHEDULE_PLAY",
      url: session.pendingLoad?.url || session.track.uri || session.track.id,
      startAtServerTime,
      trackOffsetMs: session.trackOffsetMs,
      track: { ...session.track }
    };
    this.broadcast(session.shareToken, message);
    return { session: publicSession(session), message };
  }

  seek({ shareToken, deviceId, trackOffsetMs }) {
    const session = this.requireSession(shareToken);
    this.assertHost(session, deviceId);
    session.trackOffsetMs = Math.max(0, Number(trackOffsetMs) || 0);
    session.startAtServerTime = this.clock() + this.computeHeadroomMs(session);
    const message = {
      type: "SEEK",
      startAtServerTime: session.startAtServerTime,
      trackOffsetMs: session.trackOffsetMs
    };
    this.broadcast(session.shareToken, message);
    return { session: publicSession(session), message };
  }

  nudge({ shareToken, deviceId, targetDeviceId = deviceId, ms }) {
    const session = this.requireSession(shareToken);
    const actor = this.requireDevice(session, deviceId);
    if (targetDeviceId !== deviceId && actor.role !== "host") throw new Error("Only the host can nudge other devices");
    const device = this.requireDevice(session, targetDeviceId);
    device.nudgeMs = Number(device.nudgeMs || 0) + (Number(ms) || 0);
    const message = { type: "NUDGE", deviceId: device.id, ms: device.nudgeMs };
    this.broadcast(session.shareToken, message);
    return { device: publicDevice(device), message };
  }

  setVolume({ shareToken, deviceId, targetDeviceId = deviceId, volume }) {
    const session = this.requireSession(shareToken);
    const actor = this.requireDevice(session, deviceId);
    if (targetDeviceId !== deviceId && actor.role !== "host") throw new Error("Only the host can set other device volumes");
    const device = this.requireDevice(session, targetDeviceId);
    device.volume = Math.max(0, Math.min(1, Number(volume)));
    const message = { type: "SET_VOLUME", deviceId: device.id, volume: device.volume };
    this.broadcast(session.shareToken, message);
    return { device: publicDevice(device), message };
  }

  lateJoinSchedule(session, deviceId) {
    if (session.state !== "playing" || !session.track || !session.startAtServerTime) return null;
    const futureStart = this.clock() + this.computeHeadroomMs(session);
    const trackOffsetMs = this.currentTrackOffsetMs(session, futureStart);
    if (session.track.durationMs && session.track.durationMs - trackOffsetMs <= LATE_JOIN_MIN_REMAINING_MS) {
      return { deferred: true, reason: "near_track_end", trackOffsetMs, startAtServerTime: futureStart };
    }
    return {
      deferred: false,
      message: {
        type: "SCHEDULE_PLAY",
        url: session.track.uri || session.track.id,
        startAtServerTime: futureStart,
        trackOffsetMs,
        track: { ...session.track }
      }
    };
  }

  computeHeadroomMs(session) {
    let maxRtt = 0;
    let maxOutputLatency = 0;
    for (const device of session.devices.values()) {
      maxRtt = Math.max(maxRtt, Number(device.rttMs) || 0);
      maxOutputLatency = Math.max(maxOutputLatency, Number(device.outputLatencyMs) || 0);
    }
    return maxRtt + maxOutputLatency;
  }

  currentTrackOffsetMs(session, serverTime = this.clock()) {
    if (session.state !== "playing") return Math.max(0, Number(session.trackOffsetMs) || 0);
    return Math.max(0, Number(session.trackOffsetMs) + (Number(serverTime) - Number(session.startAtServerTime)));
  }

  allReady(session) {
    if (!session.pendingLoad) return false;
    for (const id of session.pendingLoad.waitingFor) {
      if (!session.pendingLoad.ready.has(id)) return false;
    }
    return true;
  }

  schedulePendingLoad(session, reason) {
    const pending = session.pendingLoad;
    const startAtServerTime = this.clock() + this.computeHeadroomMs(session);
    session.startAtServerTime = startAtServerTime;
    session.trackOffsetMs = pending.trackOffsetMs;
    session.state = "playing";
    session.pendingLoad = null;
    const message = {
      type: "SCHEDULE_PLAY",
      url: pending.url,
      startAtServerTime,
      trackOffsetMs: pending.trackOffsetMs,
      reason,
      track: session.track ? { ...session.track } : null
    };
    this.broadcast(session.shareToken, message);
    return { scheduled: true, message, session: publicSession(session) };
  }

  requireSession(shareToken) {
    const token = String(shareToken || "").trim();
    const session = this.sessions.get(token);
    if (!session) throw new Error("Sync session not found");
    return session;
  }

  requireDevice(session, deviceId) {
    const device = session.devices.get(String(deviceId || ""));
    if (!device) throw new Error("Sync device not found");
    device.lastSeen = this.clock();
    return device;
  }

  assertHost(session, deviceId) {
    if (String(deviceId || "") !== session.hostId) throw new Error("Only the host can control transport");
  }

  getSession(shareToken) {
    return publicSession(this.requireSession(shareToken));
  }
}

export function createSyncCoordinator(options = {}) {
  return new SyncCoordinator(options);
}
