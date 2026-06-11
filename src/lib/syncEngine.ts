export const MAX_NTP_MEASUREMENTS = 16;
export const NTP_INITIAL_INTERVAL_MS = 50;
export const NTP_STEADY_INTERVAL_MS = 2500;
export const PROBE_GAP_MS = 25;
export const MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS = 100;

export type SyncRole = "host" | "guest";

export type SyncDevice = {
  id: string;
  label: string;
  role: SyncRole;
  clockOffsetMs: number;
  rttMs: number;
  outputLatencyMs: number;
  nudgeMs: number;
  volume: number;
  lastSeen: number;
};

export type SyncSession = {
  id: string;
  shareToken: string;
  hostId: string;
  track: { uri?: string; id?: string; source?: string; durationMs?: number; title?: string; artist?: string } | null;
  state: "playing" | "paused";
  startAtServerTime: number;
  trackOffsetMs: number;
  devices: SyncDevice[];
};

export type SyncEngineState = {
  connected: boolean;
  joined: boolean;
  audioUnlocked: boolean;
  loading: boolean;
  playing: boolean;
  error: string;
  shareToken: string;
  deviceId: string;
  role: SyncRole;
  session: SyncSession | null;
  clockOffsetMs: number;
  rttMs: number;
  nudgeMs: number;
  volume: number;
  currentUrl: string;
  currentOffsetMs: number;
};

type ClockMeasurement = {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
  clockOffsetMs: number;
  rttMs: number;
};

type SyncEngineOptions = {
  shareToken: string;
  deviceId?: string;
  label?: string;
  wsUrl?: string;
};

export function epochNow() {
  if (typeof performance !== "undefined" && performance.timeOrigin) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

export function computeClockMeasurement({ t0, t1, t2, t3 }: { t0: number; t1: number; t2: number; t3: number }) {
  return {
    clockOffsetMs: (t1 - t0 + (t2 - t3)) / 2,
    rttMs: t3 - t0 - (t2 - t1)
  };
}

export function selectMinRttMeasurement(measurements: Array<{ clockOffsetMs: number; rttMs: number }>) {
  return measurements.reduce<{ clockOffsetMs: number; rttMs: number } | null>((best, item) => {
    if (!best || item.rttMs < best.rttMs) return item;
    return best;
  }, null);
}

export function filterOutputLatencyMs(rawMs: number | null | undefined) {
  const ms = Math.max(0, Number(rawMs) || 0);
  return ms > MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS ? 0 : ms;
}

export function computeScheduleWaitSeconds({
  startAtServerTime,
  epochNowMs,
  clockOffsetMs,
  outputLatencyMs,
  nudgeMs = 0
}: {
  startAtServerTime: number;
  epochNowMs: number;
  clockOffsetMs: number;
  outputLatencyMs: number;
  nudgeMs?: number;
}) {
  const effectiveOffset = clockOffsetMs + nudgeMs;
  const waitMs = startAtServerTime - (epochNowMs + effectiveOffset);
  return Math.max(0, waitMs - filterOutputLatencyMs(outputLatencyMs)) / 1000;
}

class SyncAudioContextManager {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private wakeLock: any = null;

  getContext() {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      const nav = navigator as any;
      if (nav.audioSession) nav.audioSession.type = "playback";
    }
    return this.context;
  }

  getGain() {
    if (!this.gain) this.getContext();
    return this.gain!;
  }

  async resume() {
    const ctx = this.getContext();
    if (ctx.state === "suspended" || ctx.state === "interrupted") {
      await ctx.resume();
    }
    await this.requestWakeLock();
  }

  setVolume(volume: number) {
    this.getGain().gain.value = Math.max(0, Math.min(1, Number(volume) || 0));
  }

  outputLatencyMs() {
    return filterOutputLatencyMs(((this.getContext() as any).outputLatency || 0) * 1000);
  }

  async decode(arrayBuffer: ArrayBuffer) {
    return await this.getContext().decodeAudioData(arrayBuffer.slice(0));
  }

  createSource(buffer: AudioBuffer) {
    const source = this.getContext().createBufferSource();
    source.buffer = buffer;
    source.connect(this.getGain());
    return source;
  }

  private async requestWakeLock() {
    try {
      const nav = navigator as any;
      if (!this.wakeLock && nav.wakeLock) {
        this.wakeLock = await nav.wakeLock.request("screen");
        this.wakeLock.addEventListener?.("release", () => {
          this.wakeLock = null;
        });
      }
    } catch {
      this.wakeLock = null;
    }
  }
}

export class SyncEngine {
  private ws: WebSocket | null = null;
  private audio = new SyncAudioContextManager();
  private buffers = new Map<string, AudioBuffer>();
  private measurements: ClockMeasurement[] = [];
  private pendingProbeResponses = new Map<number, ClockMeasurement>();
  private probeCounter = 0;
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private source: AudioBufferSourceNode | null = null;
  private currentSchedule: any = null;
  private listeners = new Set<(state: SyncEngineState) => void>();
  private state: SyncEngineState;
  private options: Required<SyncEngineOptions>;

  constructor(options: SyncEngineOptions) {
    const deviceId = options.deviceId || getOrCreateDeviceId();
    this.options = {
      shareToken: options.shareToken,
      deviceId,
      label: options.label || defaultDeviceLabel(),
      wsUrl: options.wsUrl || defaultSyncWsUrl()
    };
    this.state = {
      connected: false,
      joined: false,
      audioUnlocked: false,
      loading: false,
      playing: false,
      error: "",
      shareToken: this.options.shareToken,
      deviceId,
      role: "guest",
      session: null,
      clockOffsetMs: 0,
      rttMs: 0,
      nudgeMs: 0,
      volume: 1,
      currentUrl: "",
      currentOffsetMs: 0
    };
  }

  subscribe(listener: (state: SyncEngineState) => void) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState() {
    return { ...this.state, session: this.state.session ? { ...this.state.session, devices: [...this.state.session.devices] } : null };
  }

  connect() {
    this.disconnect(false);
    const ws = new WebSocket(this.options.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.patch({ connected: true, error: "" });
      this.send({
        type: "JOIN",
        shareToken: this.options.shareToken,
        deviceId: this.options.deviceId,
        label: this.options.label,
        outputLatencyMs: this.audio.outputLatencyMs()
      });
      this.startHeartbeat();
    };
    ws.onmessage = (event) => this.handleMessage(JSON.parse(String(event.data)));
    ws.onerror = () => this.patch({ error: "Sync connection failed" });
    ws.onclose = () => {
      this.patch({ connected: false, joined: false });
      this.stopHeartbeat();
      this.scheduleReconnect();
    };
  }

  disconnect(reconnect = false) {
    this.stopHeartbeat();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN) this.send({ type: "LEAVE" });
      this.ws.close();
    }
    this.ws = null;
    if (!reconnect) this.patch({ connected: false, joined: false });
  }

  async unlockAudio() {
    await this.audio.resume();
    this.audio.setVolume(this.state.volume);
    this.patch({ audioUnlocked: true });
    this.reportClock();
    // Recover any play that arrived while audio was still locked — start it now at
    // the current position so a late-unlocking device joins the song in progress.
    if (this.currentSchedule && !this.state.playing) {
      this.handleSchedulePlay(this.currentSchedule).catch(() => {});
    }
  }

  loadAudioSource(url: string, trackOffsetMs = 0, track?: any) {
    this.send({ type: "LOAD_AUDIO_SOURCE", url, trackOffsetMs, track });
  }

  pause() {
    this.send({ type: "PAUSE" });
  }

  resume() {
    this.send({ type: "RESUME" });
  }

  seek(trackOffsetMs: number) {
    this.send({ type: "SEEK", trackOffsetMs });
  }

  nudge(deviceId: string, ms: number) {
    this.send({ type: "NUDGE", targetDeviceId: deviceId, ms });
  }

  setVolume(deviceId: string, volume: number) {
    this.send({ type: "SET_VOLUME", targetDeviceId: deviceId, volume });
    if (deviceId === this.state.deviceId) {
      this.audio.setVolume(volume);
      this.patch({ volume });
    }
  }

  private async handleMessage(message: any) {
    if (message.type === "JOINED") {
      this.patch({
        joined: true,
        session: message.session,
        role: message.device?.role || "guest",
        nudgeMs: message.device?.nudgeMs || 0,
        volume: message.device?.volume ?? this.state.volume
      });
      if (message.lateJoin?.message) await this.handleSchedulePlay(message.lateJoin.message);
      return;
    }
    if (message.type === "CLOCK_RESPONSE") {
      this.handleClockResponse(message);
      return;
    }
    if (message.type === "CLOCK_UPDATED") {
      if (message.device) this.mergeDevice(message.device);
      return;
    }
    if (message.type === "LOAD_AUDIO_SOURCE") {
      await this.handleLoadAudioSource(message);
      return;
    }
    if (message.type === "SCHEDULE_PLAY") {
      await this.handleSchedulePlay(message);
      return;
    }
    if (message.type === "PAUSE") {
      this.stopSource();
      this.currentSchedule = null;
      this.patch({ playing: false, currentOffsetMs: message.trackOffsetMs || this.state.currentOffsetMs });
      return;
    }
    if (message.type === "SEEK") {
      if (this.state.playing && this.state.currentUrl) {
        await this.handleSchedulePlay({
          type: "SCHEDULE_PLAY",
          url: this.state.currentUrl,
          startAtServerTime: message.startAtServerTime,
          trackOffsetMs: message.trackOffsetMs
        });
      } else {
        this.patch({ currentOffsetMs: message.trackOffsetMs || 0 });
      }
      return;
    }
    if (message.type === "NUDGE" && message.deviceId === this.state.deviceId) {
      this.updateSessionDevice(message.deviceId, { nudgeMs: Number(message.ms) || 0 });
      this.patch({ nudgeMs: Number(message.ms) || 0 });
      this.reportClock();
      return;
    }
    if (message.type === "NUDGE") {
      this.updateSessionDevice(message.deviceId, { nudgeMs: Number(message.ms) || 0 });
      return;
    }
    if (message.type === "SET_VOLUME" && message.deviceId === this.state.deviceId) {
      const volume = Math.max(0, Math.min(1, Number(message.volume) || 0));
      this.updateSessionDevice(message.deviceId, { volume });
      this.audio.setVolume(volume);
      this.patch({ volume });
      return;
    }
    if (message.type === "SET_VOLUME") {
      this.updateSessionDevice(message.deviceId, { volume: Math.max(0, Math.min(1, Number(message.volume) || 0)) });
      return;
    }
    if (message.type === "ERROR") {
      this.patch({ error: message.error || "Sync error" });
    }
  }

  private handleClockResponse(message: any) {
    const t3 = epochNow();
    const measurement = {
      t0: Number(message.t0),
      t1: Number(message.t1),
      t2: Number(message.t2),
      t3,
      ...computeClockMeasurement({ t0: Number(message.t0), t1: Number(message.t1), t2: Number(message.t2), t3 })
    };
    if (!Number.isFinite(measurement.rttMs)) return;
    const groupId = Number(message.probeGroupId);
    const groupIndex = Number(message.probeGroupIndex);
    if (Number.isFinite(groupId) && groupIndex === 0) {
      this.pendingProbeResponses.set(groupId, measurement);
      return;
    }
    if (Number.isFinite(groupId) && groupIndex === 1) {
      const first = this.pendingProbeResponses.get(groupId);
      this.pendingProbeResponses.delete(groupId);
      if (message.accepted === false || !first) return;
      this.addMeasurement(first.rttMs <= measurement.rttMs ? first : measurement);
      return;
    }
    this.addMeasurement(measurement);
  }

  private addMeasurement(measurement: ClockMeasurement) {
    this.measurements = [...this.measurements.slice(-(MAX_NTP_MEASUREMENTS - 1)), measurement];
    const best = selectMinRttMeasurement(this.measurements);
    if (!best) return;
    this.patch({ clockOffsetMs: best.clockOffsetMs, rttMs: best.rttMs });
    this.reportClock();
  }

  private async handleLoadAudioSource(message: any) {
    this.patch({ loading: true, error: "" });
    try {
      await this.loadBuffer(message.url);
      this.patch({ loading: false, currentUrl: message.url, currentOffsetMs: message.trackOffsetMs || 0 });
      this.send({ type: "CLIENT_READY" });
    } catch (error) {
      this.patch({ loading: false, error: error instanceof Error ? error.message : "Audio load failed" });
    }
  }

  private async handleSchedulePlay(message: any) {
    // Remember the play intent so we can recover it if/when audio is unlocked later
    // (browsers require a user gesture; a guest who hasn't tapped "join audio" yet,
    // or unlocks after the host hit play, must still start — at the CURRENT position).
    this.currentSchedule = message;
    const buffer = await this.loadBuffer(message.url);
    if (!this.state.audioUnlocked) return;
    const ctx = this.audio.getContext();
    if (ctx.state !== "running") await this.audio.resume();
    this.stopSource();
    const source = this.audio.createSource(buffer);
    const startAtServerTime = Number(message.startAtServerTime);
    const baseOffsetMs = Number(message.trackOffsetMs || 0);
    const serverNowMs = epochNow() + this.state.clockOffsetMs + this.state.nudgeMs;
    const elapsedMs = serverNowMs - startAtServerTime;
    let waitSec: number;
    let offsetSec: number;
    if (elapsedMs >= 0) {
      // Start instant already passed (late join / late unlock): begin now at the
      // advanced position so we land in sync rather than restarting the track.
      waitSec = 0;
      offsetSec = Math.max(0, (baseOffsetMs + elapsedMs) / 1000);
    } else {
      waitSec = computeScheduleWaitSeconds({
        startAtServerTime,
        epochNowMs: epochNow(),
        clockOffsetMs: this.state.clockOffsetMs,
        outputLatencyMs: this.audio.outputLatencyMs(),
        nudgeMs: this.state.nudgeMs
      });
      offsetSec = Math.max(0, baseOffsetMs / 1000);
    }
    source.start(ctx.currentTime + waitSec, offsetSec);
    this.source = source;
    this.patch({ playing: true, currentUrl: message.url, currentOffsetMs: baseOffsetMs });
  }

  private async loadBuffer(url: string) {
    const cached = this.buffers.get(url);
    if (cached) return cached;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Audio fetch failed");
    const buffer = await this.audio.decode(await response.arrayBuffer());
    this.buffers.set(url, buffer);
    return buffer;
  }

  private stopSource() {
    if (!this.source) return;
    try {
      this.source.onended = null;
      this.source.disconnect();
      this.source.stop();
    } catch {}
    this.source = null;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    const tick = () => {
      this.sendProbePair();
      const interval = this.measurements.length < MAX_NTP_MEASUREMENTS ? NTP_INITIAL_INTERVAL_MS : NTP_STEADY_INTERVAL_MS;
      this.heartbeat = window.setTimeout(tick, interval);
    };
    tick();
  }

  private stopHeartbeat() {
    if (this.heartbeat) window.clearTimeout(this.heartbeat);
    this.heartbeat = null;
  }

  private sendProbePair() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.state.joined) return;
    const probeGroupId = this.probeCounter++;
    this.send({ type: "CLOCK_PROBE", t0: epochNow(), probeGroupId, probeGroupIndex: 0 });
    window.setTimeout(() => {
      this.send({ type: "CLOCK_PROBE", t0: epochNow(), probeGroupId, probeGroupIndex: 1 });
    }, PROBE_GAP_MS);
  }

  private reportClock() {
    this.send({
      type: "CLOCK_RESPONSE",
      clockOffsetMs: this.state.clockOffsetMs,
      rttMs: this.state.rttMs,
      outputLatencyMs: this.audio.outputLatencyMs(),
      nudgeMs: this.state.nudgeMs
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private mergeDevice(device: SyncDevice) {
    const session = this.state.session;
    if (!session) return;
    this.patch({
      session: { ...session, devices: session.devices.map((candidate) => candidate.id === device.id ? device : candidate) }
    });
  }

  private updateSessionDevice(deviceId: string, patch: Partial<SyncDevice>) {
    const session = this.state.session;
    if (!session) return;
    this.patch({
      session: {
        ...session,
        devices: session.devices.map((device) => device.id === deviceId ? { ...device, ...patch } : device)
      }
    });
  }

  private send(message: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ shareToken: this.options.shareToken, deviceId: this.options.deviceId, ...message }));
  }

  private patch(partial: Partial<SyncEngineState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.getState());
  }
}

function defaultSyncWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Mirror apiBase: the app is mounted under import.meta.env.BASE_URL (e.g. /cloud-squeeze/),
  // and nginx strips that prefix before proxying to the container's /sync path.
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${protocol}//${window.location.host}${base}/sync`;
}

function defaultDeviceLabel() {
  return navigator.userAgent.includes("Mobile") ? "Mobile browser" : "Browser";
}

function getOrCreateDeviceId() {
  const key = "cloud-squeeze-sync-device-id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.localStorage.setItem(key, id);
  return id;
}
