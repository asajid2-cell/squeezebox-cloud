import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./state.js";

const MAX_EVENTS = 5000;
const MAX_RECENT_EVENT_IDS = 200;
const MAX_TRACKS_PER_LISTENER = 1000;
const MAX_ARTISTS_PER_LISTENER = 500;
const COMPLETE_PERCENT = 0.85;
const COMPLETE_TAIL_SECONDS = 8;
const TRACK_KEYS = [
  "id",
  "title",
  "artist",
  "album",
  "source",
  "uri",
  "path",
  "lmsTrackId",
  "duration",
  "kind",
  "requestedBy",
  "browseId"
];

export function defaultListenerTasteFile() {
  if (process.env.CLOUD_SQUEEZE_TASTE_FILE) return process.env.CLOUD_SQUEEZE_TASTE_FILE;
  return path.join(config.musicSourceDir, "cloud-squeeze", "listener-taste.json");
}

export function createListenerTasteStore(file = defaultListenerTasteFile()) {
  let state = null;
  let active = null;
  let closed = null;

  function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      state = normalizeState(parsed);
    } catch {
      state = emptyState();
    }
    return state;
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      logPersistError(error);
    }
  }

  function getState() {
    return structuredClone(load());
  }

  // onFinalize, when given, is called with every session this store closes
  // (complete OR skip). The return value can only carry the live session — the
  // session is gone by the time a finalize happens — so a caller that must react
  // to a finalized event gets it through here instead.
  function observePlayback({ track, status = {}, context = {}, onFinalize } = {}) {
    if (!isPlayableTrack(track) || isStopped(status)) {
      if (active && shouldFinalizeInactive(active)) return finalizeActive("complete", { reason: "poll-inactive", context, onFinalize });
      active = null;
      return null;
    }

    const now = new Date().toISOString();
    const key = listenerTrackKey(track);
    const elapsed = boundedNumber(track.elapsed);
    const duration = boundedNumber(track.duration);
    const listenerId = listenerIdForTrack(track, context);
    const nextContext = compactContext(track, context);

    if (!active || active.trackKey !== key) {
      if (active) finalizeActive(classifyActive(active), { reason: "observed-transition", context: nextContext, onFinalize });
      if (!active && shouldSuppressClosedSession(key, elapsed)) return null;
      if (closed?.trackKey !== key || elapsed < Math.max(5, closed.elapsed - 5)) closed = null;
      active = createActiveSession(track, listenerId, nextContext, now);
      recordEvent("play", track, {
        listenerId,
        startedAt: active.startedAt,
        elapsed,
        duration,
        playedSeconds: 0,
        percentPlayed: 0,
        context: nextContext
      });
      if (isCompleteProgress(active)) {
        finalizeActive("complete", { reason: "near-track-end", context: nextContext, onFinalize });
      }
      return active;
    }

    active.lastSeenAt = now;
    active.maxElapsed = Math.max(active.maxElapsed, elapsed);
    active.duration = duration || active.duration;
    active.context = { ...active.context, ...nextContext };
    if (!active.completedAt && isCompleteProgress(active)) {
      finalizeActive("complete", { reason: "near-track-end", context: active.context, onFinalize });
    }
    return active;
  }

  function recordSkip(track, { reason = "skip", context = {} } = {}) {
    if (!isPlayableTrack(track)) return null;
    const key = listenerTrackKey(track);
    if (active?.trackKey === key) {
      return finalizeActive("skip", { reason, context: compactContext(track, context) });
    }
    return recordEvent("skip", track, {
      listenerId: listenerIdForTrack(track, context),
      elapsed: boundedNumber(track.elapsed),
      duration: boundedNumber(track.duration),
      context: compactContext(track, { ...context, reason })
    });
  }

  function recordComplete(track, { reason = "complete", context = {} } = {}) {
    if (!isPlayableTrack(track)) return null;
    const key = listenerTrackKey(track);
    if (active?.trackKey === key) {
      return finalizeActive("complete", { reason, context: compactContext(track, context) });
    }
    return recordEvent("complete", track, {
      listenerId: listenerIdForTrack(track, context),
      elapsed: boundedNumber(track.elapsed || track.duration),
      duration: boundedNumber(track.duration),
      context: compactContext(track, { ...context, reason })
    });
  }

  function recordReplay(track, { reason = "replay", context = {} } = {}) {
    if (!isPlayableTrack(track)) return null;
    if (closed?.trackKey === listenerTrackKey(track)) closed = null;
    const event = recordEvent("replay", track, {
      listenerId: listenerIdForTrack(track, context),
      elapsed: boundedNumber(track.elapsed),
      duration: boundedNumber(track.duration),
      context: compactContext(track, { ...context, reason })
    });
    if (active?.trackKey === listenerTrackKey(track)) {
      active.startedAt = new Date().toISOString();
      active.maxElapsed = 0;
      active.completedAt = "";
    }
    return event;
  }

  function resetSession() {
    active = null;
  }

  function finalizeActive(type, { reason, context = {}, onFinalize } = {}) {
    if (!active || active.finalized) return null;
    const track = active.track;
    const elapsed = Math.max(active.maxElapsed, boundedNumber(track.elapsed));
    const duration = active.duration || boundedNumber(track.duration);
    active.finalized = true;
    if (type === "complete") active.completedAt = new Date().toISOString();
    const event = recordEvent(type, track, {
      listenerId: active.listenerId,
      startedAt: active.startedAt,
      elapsed,
      duration,
      playedSeconds: elapsed,
      percentPlayed: playPercent(elapsed, duration),
      context: compactContext(track, { ...active.context, ...context, reason })
    });
    closed = { trackKey: active.trackKey, type, elapsed, at: event.at };
    active = null;
    notifyFinalize(onFinalize, event);
    return event;
  }

  function shouldSuppressClosedSession(trackKey, elapsed) {
    if (!closed || closed.trackKey !== trackKey) return false;
    return elapsed >= Math.max(0, closed.elapsed - 1);
  }

  function recordEvent(type, track, details = {}) {
    const current = load();
    const at = new Date().toISOString();
    const duration = boundedNumber(details.duration ?? track.duration);
    const elapsed = boundedNumber(details.elapsed ?? track.elapsed);
    const playedSeconds = boundedNumber(details.playedSeconds ?? elapsed);
    const percentPlayed = boundedNumber(details.percentPlayed ?? playPercent(playedSeconds, duration));
    const listenerId = normalizeListenerId(details.listenerId || listenerIdForTrack(track, details.context));
    const event = {
      id: `evt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      at,
      type,
      listenerId,
      trackKey: listenerTrackKey(track),
      track: compactTrack(track),
      duration,
      elapsed,
      playedSeconds,
      percentPlayed,
      startedAt: validIsoDate(details.startedAt) || "",
      context: compactContext(track, details.context)
    };
    current.events.push(event);
    if (current.events.length > MAX_EVENTS) current.events.splice(0, current.events.length - MAX_EVENTS);
    updateListenerProfile(current, event);
    current.revision += 1;
    current.updatedAt = at;
    persist();
    return structuredClone(event);
  }

  return { getState, observePlayback, recordSkip, recordComplete, recordReplay, resetSession, file };
}

export function listenerTrackKey(track = {}) {
  const raw = track.uri || track.path || track.lmsTrackId || track.id || `${track.title || ""}:${track.artist || ""}`;
  return normalizeIdentityText(String(raw || "").replace(/^spotify:\/\//i, "spotify:"));
}

function updateListenerProfile(current, event) {
  const listener = current.listeners[event.listenerId] || createListener(event.listenerId, event.at);
  listener.updatedAt = event.at;
  listener.recentEventIds.unshift(event.id);
  listener.recentEventIds = listener.recentEventIds.slice(0, MAX_RECENT_EVENT_IDS);
  increment(listener.totals, event.type);
  listener.totals.events += 1;
  listener.totals.playedSeconds += event.playedSeconds;
  updateTrackAggregate(listener.tracks, event);
  updateNamedAggregate(listener.artists, event.track.artist, event, MAX_ARTISTS_PER_LISTENER);
  updateNamedAggregate(listener.albums, event.track.album, event, MAX_ARTISTS_PER_LISTENER);
  updateNamedAggregate(listener.sources, event.track.source, event, 50);
  updateNamedAggregate(listener.seeds, event.context.seed, event, 200);
  pruneObjectMap(listener.tracks, MAX_TRACKS_PER_LISTENER);
  current.listeners[event.listenerId] = listener;
}

function updateTrackAggregate(tracks, event) {
  const key = event.trackKey || listenerTrackKey(event.track);
  if (!key) return;
  const item = tracks[key] || {
    key,
    track: event.track,
    plays: 0,
    skips: 0,
    completes: 0,
    replays: 0,
    playedSeconds: 0,
    score: 0,
    firstAt: event.at,
    lastAt: event.at
  };
  item.track = { ...item.track, ...event.track };
  increment(item, event.type);
  item.playedSeconds += event.playedSeconds;
  item.score += eventWeight(event);
  item.lastAt = event.at;
  tracks[key] = item;
}

function updateNamedAggregate(map, value, event, limit) {
  const name = cleanText(value).slice(0, 200);
  if (!name) return;
  const key = normalizeIdentityText(name);
  if (!key) return;
  const item = map[key] || { key, name, plays: 0, skips: 0, completes: 0, replays: 0, playedSeconds: 0, score: 0, firstAt: event.at, lastAt: event.at };
  increment(item, event.type);
  item.playedSeconds += event.playedSeconds;
  item.score += eventWeight(event);
  item.lastAt = event.at;
  map[key] = item;
  pruneObjectMap(map, limit);
}

function increment(target, type) {
  if (type === "play") target.plays += 1;
  else if (type === "skip") target.skips += 1;
  else if (type === "complete") target.completes += 1;
  else if (type === "replay") target.replays += 1;
}

function eventWeight(event) {
  if (event.type === "complete") return 2;
  if (event.type === "replay") return 1.5;
  if (event.type === "skip") return -1.5 * (1 - Math.min(1, event.percentPlayed || 0));
  return 0.25;
}

function createActiveSession(track, listenerId, context, now) {
  const elapsed = boundedNumber(track.elapsed);
  return {
    trackKey: listenerTrackKey(track),
    track: compactTrack(track),
    listenerId,
    startedAt: now,
    lastSeenAt: now,
    maxElapsed: elapsed,
    duration: boundedNumber(track.duration),
    context,
    finalized: false,
    completedAt: ""
  };
}

function classifyActive(session) {
  return isCompleteProgress(session) ? "complete" : "skip";
}

function isCompleteProgress(session) {
  const duration = boundedNumber(session.duration);
  const elapsed = boundedNumber(session.maxElapsed);
  if (duration <= 0) return false;
  return elapsed >= duration * COMPLETE_PERCENT || duration - elapsed <= COMPLETE_TAIL_SECONDS;
}

function shouldFinalizeInactive(session) {
  return isCompleteProgress(session);
}

function isStopped(status) {
  const mode = String(status?.mode || "").toLowerCase();
  return mode === "stop" || mode === "stopped";
}

function isPlayableTrack(track) {
  return Boolean(track?.title && track.id !== "idle" && track.title !== "No track playing");
}

function listenerIdForTrack(track = {}, context = {}) {
  return normalizeListenerId(context.listenerId || track.requestedBy || context.requestedBy || "ambient");
}

function normalizeListenerId(value) {
  const cleaned = cleanText(value).toLowerCase().replace(/[^a-z0-9_.@-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "ambient";
}

function compactContext(track = {}, context = {}) {
  return {
    listenerId: cleanText(context.listenerId || track.requestedBy),
    requestedBy: cleanText(context.requestedBy || track.requestedBy),
    playbackMode: cleanText(context.playbackMode),
    smartShuffleSource: cleanText(context.smartShuffleSource),
    seed: cleanText(context.seed),
    generated: Boolean(context.generated),
    queueLength: boundedNumber(context.queueLength),
    reason: cleanText(context.reason),
    source: cleanText(context.source || track.source)
  };
}

function compactTrack(track = {}) {
  const compact = {};
  for (const key of TRACK_KEYS) {
    const value = track[key];
    if (value === undefined || value === null || value === "") continue;
    compact[key] = typeof value === "string" ? value.slice(0, 1000) : value;
  }
  if (!compact.title) compact.title = "Untitled";
  return compact;
}

function normalizeState(input = {}) {
  const listeners = {};
  for (const [id, listener] of Object.entries(input.listeners || {})) {
    const normalizedId = normalizeListenerId(id);
    listeners[normalizedId] = normalizeListener(listener, normalizedId);
  }
  return {
    version: 1,
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    updatedAt: validIsoDate(input.updatedAt) || new Date().toISOString(),
    listeners,
    events: Array.isArray(input.events) ? input.events.map(normalizeEvent).filter(Boolean).slice(-MAX_EVENTS) : []
  };
}

function normalizeListener(listener = {}, id) {
  return {
    id,
    createdAt: validIsoDate(listener.createdAt) || new Date().toISOString(),
    updatedAt: validIsoDate(listener.updatedAt) || new Date().toISOString(),
    totals: normalizeCounters(listener.totals),
    tracks: normalizeMap(listener.tracks, MAX_TRACKS_PER_LISTENER),
    artists: normalizeMap(listener.artists, MAX_ARTISTS_PER_LISTENER),
    albums: normalizeMap(listener.albums, MAX_ARTISTS_PER_LISTENER),
    sources: normalizeMap(listener.sources, 50),
    seeds: normalizeMap(listener.seeds, 200),
    recentEventIds: Array.isArray(listener.recentEventIds) ? listener.recentEventIds.map(cleanText).filter(Boolean).slice(0, MAX_RECENT_EVENT_IDS) : []
  };
}

function normalizeEvent(event = {}) {
  if (!event || typeof event !== "object" || !event.type || !event.track) return null;
  const track = compactTrack(event.track);
  return {
    id: cleanText(event.id) || `evt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    at: validIsoDate(event.at) || new Date().toISOString(),
    type: cleanText(event.type),
    listenerId: normalizeListenerId(event.listenerId),
    trackKey: cleanText(event.trackKey) || listenerTrackKey(track),
    track,
    duration: boundedNumber(event.duration),
    elapsed: boundedNumber(event.elapsed),
    playedSeconds: boundedNumber(event.playedSeconds),
    percentPlayed: boundedNumber(event.percentPlayed),
    startedAt: validIsoDate(event.startedAt) || "",
    context: compactContext(track, event.context || {})
  };
}

function createListener(id, now) {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    totals: normalizeCounters(),
    tracks: {},
    artists: {},
    albums: {},
    sources: {},
    seeds: {},
    recentEventIds: []
  };
}

function emptyState() {
  return { version: 1, revision: 0, updatedAt: new Date().toISOString(), listeners: {}, events: [] };
}

function normalizeCounters(input = {}) {
  return {
    events: boundedNumber(input.events),
    plays: boundedNumber(input.plays),
    skips: boundedNumber(input.skips),
    completes: boundedNumber(input.completes),
    replays: boundedNumber(input.replays),
    playedSeconds: boundedNumber(input.playedSeconds)
  };
}

function normalizeMap(input = {}, limit) {
  const output = {};
  for (const [key, value] of Object.entries(input || {}).slice(0, limit)) {
    if (!value || typeof value !== "object") continue;
    output[key] = { ...value };
  }
  return output;
}

function pruneObjectMap(map, limit) {
  const entries = Object.entries(map);
  if (entries.length <= limit) return;
  entries
    .sort(([, left], [, right]) => String(right.lastAt || "").localeCompare(String(left.lastAt || "")))
    .slice(limit)
    .forEach(([key]) => delete map[key]);
}

function playPercent(elapsed, duration) {
  const safeDuration = boundedNumber(duration);
  if (safeDuration <= 0) return 0;
  return Math.max(0, Math.min(1, boundedNumber(elapsed) / safeDuration));
}

function validIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return Number.isNaN(Date.parse(value)) ? "" : value;
}

function cleanText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeIdentityText(value) {
  return cleanText(value).toLowerCase();
}

function boundedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

// An onFinalize observer is caller code: a throw inside it must never break
// capture, and must never touch playback.
function notifyFinalize(onFinalize, event) {
  if (typeof onFinalize !== "function") return;
  try {
    onFinalize(event);
  } catch (error) {
    console.warn(`[listenerTaste] onFinalize handler failed: ${error?.message || error}`);
  }
}

let warnedPersistError = false;
function logPersistError(error) {
  if (warnedPersistError) return;
  warnedPersistError = true;
  console.warn(`[listenerTaste] persistence disabled: ${error?.message || error}`);
}

export const defaultListenerTasteStore = createListenerTasteStore();
