import express from "express";
import cors from "cors";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LmsClient } from "./lmsClient.js";
import { enqueueNowPlaying, enqueueTrack, getQueueStatus, removeJob, ensureStreamFile, scanWatchedPlaylists, scanWatchedPlaylistsWebApi, spotifyWebConfigured, groupArchiveFiles, getWatchStatus, hasArchiveCover, archiveCoverFile, backfillArchiveCovers, tapCachePlan, tapCacheFilePath, cacheTapTag, dropTapCache } from "./archiveService.js";
import {
  addQueueItem,
  addQueueItemNext,
  appState,
  config,
  getPublicState,
  moveQueueItem,
  removeQueueItem,
  setMode,
  setVolume,
  updateQueueItem,
  updateNowPlaying,
  updatePlayerStatus,
  updateTrackInfo,
  updateSpotifyStatus,
  updateMusicInfoStatus,
  updatePlayback
} from "./state.js";
import { clearLibraryCaches, getCollections, getCollectionTracks, saveUploadedTrack, scanLibrary, searchLibrary } from "./library.js";
import { enrichTrackArtwork, enrichTrackInfo } from "./trackInfo.js";
import { defaultPlaylistStore, PlaylistError } from "./playlists.js";
import { defaultCurationStore, CurationError } from "./curation.js";
import { defaultListenerTasteStore } from "./listenerTaste.js";
import { rankRecommendationCandidates, recommendationSeedArtists } from "./recommender.js";
import { defaultTapStore } from "./tapStore.js";
import { onTrack as lightingOnTrack, onIdle as lightingOnIdle } from "./lighting/director.js";
import { buildPlaySpec } from "./tapPlaySpec.js";
import { playTapTarget } from "./tapPlayback.js";
import { verifySun } from "./tapSun.js";
import { playVideo as playScreenVideo, stopVideo as stopScreenVideo, pauseVideo as pauseScreenVideo, resumeVideo as resumeScreenVideo } from "./screenClient.js";
import { checkAccess } from "./requireAccess.js";

// Squeezebox Tap is its OWN app (a sister of the jukebox), so it gates on its OWN
// hl-auth page — `squeezebox-tap`, NOT the jukebox's `cloud-squeeze` page. Tap
// admin requires a logged-in Harmonizer account allowed on that page; anonymous
// "public" access is never enough. Returns JSON 401 (not a redirect) so the
// console SPA can show our sign-in card. The hl-auth local-bypass still lets a
// direct on-box request through (never locked out).
const TAP_AUTH_PAGE = "squeezebox-tap";

function tapAuthState(r) {
  // The master/owner is root and is allowed even if the `squeezebox-tap` page
  // hasn't been registered/granted in hl-auth yet (authenticated → 403 here).
  const masterOverride = !r.ok && r.status === 403 && Boolean(r.user && (r.user.isMaster || r.user.master));
  const allowed = Boolean(r.ok && r.user && !r.user.public);
  const authed = allowed || masterOverride;
  const u = r.user || {};
  return {
    authed,
    user: authed ? { username: u.username || "you", isMaster: Boolean(u.isMaster || u.master), local: Boolean(u.local), service: Boolean(u.service) } : null
  };
}
const AUTH_LOGIN_URL = `${(process.env.AUTH_PUBLIC_BASE || "/auth").replace(/\/$/, "")}/login`;

async function requireTapAccess(req, res, next) {
  let r;
  try {
    r = await checkAccess(req, TAP_AUTH_PAGE);
  } catch {
    res.status(503).json({ error: "Sign-in service is unavailable right now." });
    return;
  }
  const { authed, user } = tapAuthState(r);
  if (authed) {
    req.hlUser = user;
    next();
    return;
  }
  if (r.status === 403) {
    res.status(403).json({ error: "Your account can't manage Tap." });
    return;
  }
  res.status(401).json({ error: "Sign in with your Harmonizer account to manage Tap.", loginUrl: AUTH_LOGIN_URL });
}

// Squeezebox Tap — per-tag debounce so a rapid double-tap doesn't restart the
// album from 0:00 (NFC fires readily; people tap twice).
const tapPlayState = new Map();
const TAP_DEBOUNCE_MS = Number(process.env.TAP_DEBOUNCE_MS || 3000);
// The resume-enabled tag whose content is (as far as Tap knows) on the speaker
// right now. When a DIFFERENT tag is tapped we bookmark this one's position
// first, so it can be picked up later — the "vinyl bookmark" behavior.
let activeResumeTagId = null;
// "Visual" mode: a tapped visual tag flips this ON/OFF. While ON, a background
// watcher follows the Boom — re-syncing the screen to each new song and
// mirroring play/pause. All runtime-only (the panel idles on restart).
let visualOn = false;
let visualTimer = null;     // the watcher's poll interval
let visualSyncing = false;  // guard so a slow re-sync tick can't overlap the next
let visualTrackKey = "";    // last-synced "title|artist" — detects track changes
let visualMode = "";        // last-seen play/pause mode — mirrors it without reloading
const VISUAL_POLL_MS = Number(process.env.VISUAL_POLL_MS) || 5000;

const requiredText = z.string().trim().min(1);
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional()
);

const queueSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number()]).optional(),
  title: requiredText,
  artist: optionalText,
  album: optionalText,
  source: optionalText,
  path: optionalText,
  uri: optionalText,
  kind: optionalText,
  lmsTrackId: z.union([z.string().trim().min(1), z.number()]).optional(),
  art: optionalText.nullable(),
  uploaded: z.boolean().optional(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  elapsed: z.number().finite().nonnegative().optional(),
  canSeek: z.boolean().optional(),
  browseId: optionalText,
  collection: optionalText,
  folder: optionalText,
  requestedBy: optionalText
}).strict();

const playbackTrackInputSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number()]).optional(),
  title: requiredText.optional(),
  artist: optionalText,
  album: optionalText,
  source: optionalText,
  path: optionalText,
  uri: optionalText,
  kind: optionalText,
  lmsTrackId: z.union([z.string().trim().min(1), z.number()]).optional(),
  art: optionalText.nullable(),
  uploaded: z.boolean().optional(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  elapsed: z.number().finite().nonnegative().optional(),
  canSeek: z.boolean().optional(),
  browseId: optionalText,
  collection: optionalText,
  folder: optionalText
}).strict().refine(
  (value) => Boolean(value.path || value.lmsTrackId || value.uri || String(value.id || "").startsWith("archive:")),
  { message: "Playable local path, LMS track id, Spotify URI, or archive id is required" }
);

const queueUpdateSchema = z.object({
  title: requiredText.optional(),
  artist: requiredText.optional(),
  album: optionalText,
  requestedBy: optionalText
}).strict();

const queueMoveSchema = z.object({
  direction: z.union([z.enum(["up", "down"]), z.number().int().min(0)]).optional(),
  index: z.number().int().min(0).optional()
}).strict().refine(
  (value) => value.direction !== undefined || value.index !== undefined,
  { message: "Queue move direction or index is required" }
);

const playbackTrackSchema = z.object({
  action: z.enum(["add-queue", "play-next", "play-now"]).optional().default("add-queue"),
  track: playbackTrackInputSchema
}).strict();

const playbackTracksSchema = z.object({
  action: z.enum(["add-queue", "play-next"]).optional().default("add-queue"),
  tracks: z.array(playbackTrackInputSchema).min(1).max(300)
}).strict();

// Play one track from a playlist and scope the queue to that playlist (the rest
// of its tracks, in order or shuffled per the shuffle toggle).
const playlistPlaySchema = z.object({
  startIndex: z.number().int().min(0).optional().default(0),
  tracks: z.array(playbackTrackInputSchema).min(1).max(500)
}).strict();

const volumeSchema = z.object({
  volume: z.number().finite().min(0).max(100)
}).strict();

const seekSchema = z.object({
  seconds: z.number().finite().min(0)
}).strict();

const playbackSchema = z.object({
  shuffle: z.boolean().optional(),
  smartQueue: z.boolean().optional(),
  repeat: z.enum(["off", "one", "all"]).optional(),
  smartShuffleSource: z.enum(["mixed", "spotify", "local"]).optional()
}).strict().refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: "At least one playback setting is required" }
).refine(
  (value) => !(value.shuffle === true && value.smartQueue === true),
  { message: "Shuffle and smart shuffle cannot both be enabled" }
);

const smartShuffleSchema = z.object({
  source: z.enum(["mixed", "spotify", "local"]).optional(),
  count: z.number().int().min(1).max(8).optional(),
  seed: optionalText
}).strict();

const curationTrackSchema = z.object({
  id: z.union([z.string().trim().min(1), z.number()]).optional(),
  title: requiredText.optional(),
  artist: optionalText,
  album: optionalText,
  source: optionalText,
  path: optionalText,
  uri: optionalText,
  kind: optionalText,
  lmsTrackId: z.union([z.string().trim().min(1), z.number()]).optional(),
  art: optionalText.nullable(),
  artwork: optionalText.nullable(),
  uploaded: z.boolean().optional(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  browseId: optionalText,
  collection: optionalText,
  folder: optionalText
}).strict().refine(
  (value) => Boolean(value.title || value.path || value.uri || value.lmsTrackId || value.collection || value.folder),
  { message: "A title, path, URI, LMS id, collection, or folder is required" }
);

const curationSchema = z.object({
  action: z.enum(["hide", "unhide", "favorite", "unfavorite", "pin", "unpin"]),
  track: curationTrackSchema
}).strict();

const loginSchema = z.object({
  password: z.string().min(1)
});

const playlistCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  createdBy: z.string().max(60).optional()
});

const adminSettingsSchema = z.object({
  publicRequests: z.boolean().optional(),
  maxQueuePerUser: z.number().int().min(1).max(25).optional(),
  moderation: z.enum(["off", "basic", "strict"]).optional(),
  scheduleEnabled: z.boolean().optional()
}).strict();

function requireEnvSecret(name, legacyName) {
  const value = process.env[name] || (legacyName ? process.env[legacyName] : "");
  if (!value || isPlaceholderSecret(value)) {
    throw new Error(`${name}${legacyName ? ` or ${legacyName}` : ""} must be set to a non-default value`);
  }
  return value;
}

function isPlaceholderSecret(value) {
  const normalized = String(value || "").toLowerCase();
  return normalized === "change-me" || normalized.startsWith("replace-with-") || normalized.startsWith("replace_with_");
}

function getAdminAuthConfig() {
  const sessionTtlMs = Number(process.env.CLOUD_SQUEEZE_ADMIN_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < 60000) {
    throw new Error("CLOUD_SQUEEZE_ADMIN_SESSION_TTL_MS must be at least 60000 milliseconds");
  }
  return {
    passwordVerifier: getAdminPasswordVerifier(),
    sessionTtlMs
  };
}

function getAdminPasswordVerifier() {
  const hash = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH || process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD_SHA256 || "";
  if (hash) return parseAdminPasswordHash(hash);
  const password = requireEnvSecret("CLOUD_SQUEEZE_ADMIN_PASSWORD", "ADMIN_PASSWORD");
  return { type: "sha256", hash: hashHex(password) };
}

function parseAdminPasswordHash(value) {
  if (!value || isPlaceholderSecret(value)) {
    throw new Error("CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH must be set to a non-default value");
  }
  const parts = value.split(":");
  if (parts.length === 5 && parts[0] === "pbkdf2") {
    const [, digest, iterationsRaw, salt, hash] = parts;
    const iterations = Number(iterationsRaw);
    if (!["sha256", "sha512"].includes(digest) || !Number.isInteger(iterations) || iterations < 100000 || !salt || !isHex(hash)) {
      throw new Error("CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH must use pbkdf2:sha256:<iterations>:<salt>:<hex-hash>");
    }
    return { type: "pbkdf2", digest, iterations, salt, hash: hash.toLowerCase() };
  }
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH must be a SHA-256 hex digest or pbkdf2 verifier");
  }
  return { type: "sha256", hash: value.toLowerCase() };
}

function isHex(value) {
  return /^[a-f0-9]+$/i.test(value) && value.length % 2 === 0;
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timingSafeHexEqual(leftHex, rightHex) {
  if (!isHex(leftHex) || !isHex(rightHex)) return false;
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyAdminPassword(password, verifier) {
  if (verifier.type === "pbkdf2") {
    const expected = Buffer.from(verifier.hash, "hex");
    const actual = crypto.pbkdf2Sync(password, verifier.salt, verifier.iterations, expected.length, verifier.digest);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  return timingSafeHexEqual(hashHex(password), verifier.hash);
}

const allowedCorsOrigins = new Set(
  (process.env.CLOUD_SQUEEZE_ALLOWED_ORIGINS || "https://harmonizerlabs.cc")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
if (process.env.NODE_ENV !== "production") {
  allowedCorsOrigins.add("http://127.0.0.1:5173");
  allowedCorsOrigins.add("http://localhost:5173");
  allowedCorsOrigins.add("http://127.0.0.1:4177");
  allowedCorsOrigins.add("http://localhost:4177");
}

const adminLoginAttempts = new Map();
const adminSessions = new Map();
const adminLoginWindowMs = Number(process.env.CLOUD_SQUEEZE_ADMIN_LOGIN_WINDOW_MS || 60000);
const adminLoginMaxAttempts = Number(process.env.CLOUD_SQUEEZE_ADMIN_LOGIN_MAX_ATTEMPTS || 8);
const securityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: http: https:",
  "connect-src 'self' http: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");
const imageProxyMaxBytes = Number(process.env.IMAGE_PROXY_MAX_BYTES || 8 * 1024 * 1024);
const imageProxyCacheTtlMs = Number(process.env.IMAGE_PROXY_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const imageProxyCacheLimit = Number(process.env.IMAGE_PROXY_CACHE_LIMIT || 200);
const serviceRefreshMs = 60000;
const trackInfoRefreshMs = 30000;
const trackInfoBudgetMs = Number(process.env.TRACK_INFO_BUDGET_MS || 1800);
const localArtworkBudgetMs = Number(process.env.LOCAL_ARTWORK_BUDGET_MS || 300);
const localArtworkLimit = Number(process.env.LOCAL_ARTWORK_LIMIT || 60);
const localFallbackArtworkBudgetMs = Number(process.env.LOCAL_FALLBACK_ARTWORK_BUDGET_MS || 900);
const localSearchFallbackArtworkBudgetMs = Number(process.env.LOCAL_SEARCH_FALLBACK_ARTWORK_BUDGET_MS || 350);
const localFallbackArtworkLimit = Number(process.env.LOCAL_FALLBACK_ARTWORK_LIMIT || 24);
const uploadedArtworkBudgetMs = Number(process.env.UPLOADED_ARTWORK_BUDGET_MS || 900);
const uploadedArtworkLimit = Number(process.env.UPLOADED_ARTWORK_LIMIT || 8);
const spotifySearchPrewarmTerms = ["drake", "juice wrld", "the weeknd", "travis scott"];
const transportActionPaths = new Set([
  "/api/player/play",
  "/api/player/pause",
  "/api/player/stop",
  "/api/player/next",
  "/api/player/previous"
]);
// How long we keep showing a brief "reconnecting" hold after the LAST genuine
// connection before reporting the player as truly offline, and how stale a cached
// connected status may be before an action forces a fresh check (auto-wake).
const playerReconnectGraceMs = Number(process.env.PLAYER_RECONNECT_GRACE_MS || 20000);
const playerStatusMaxAgeMs = Number(process.env.PLAYER_STATUS_MAX_AGE_MS || 6000);
// The LMS<->player link is normally rock-steady; a status poll that comes back
// "not connected" is almost always a transient slow/timed-out CLI call during
// playback, not a real drop. Hold the last-known CONNECTED state through this
// many consecutive failed polls before degrading the UI, so transport controls
// never flicker off on a single blip.
const playerStatusFailureThreshold = Number(process.env.PLAYER_STATUS_FAILURE_THRESHOLD || 3);

const refreshState = {
  promise: null,
  updatedAt: 0,
  lastConnectedAt: 0,
  statusFailures: 0,
  servicesAt: 0,
  trackInfoAt: 0,
  trackKey: "",
  trackInfoPromise: null,
  trackInfoPendingKey: "",
  pendingPlaybackKey: "",
  pendingPlaybackAt: 0,
  pendingSeekKey: "",
  pendingSeekSeconds: 0,
  pendingSeekAt: 0,
  pendingSeekWasPlaying: false,
  elapsedTrackKey: "",
  elapsedAt: 0,
  elapsedEstimate: 0,
  elapsedObserved: 0
};
const prewarmState = { key: "", at: 0 };
const spotifyLibraryPrewarmState = { playerId: "", at: 0 };
const libraryRescanState = { promise: null };
const transportLockState = { tail: Promise.resolve() };
const queueMutationLockState = { tail: Promise.resolve() };
const visibleQueueCancelState = { epoch: 0 };
const queueClearState = { epoch: 0 };
const knownSpotifyTracks = new Map();
const knownSpotifyTrackTtlMs = 30 * 60 * 1000;
const knownSpotifyTrackLimit = 1500;
const recentPlaybackMetadata = new Map();
const recentPlaybackMetadataTtlMs = 5 * 60 * 1000;
const recentPlaybackMetadataLimit = 100;
const imageProxyCache = new Map();
const enrichedLibraryResponseCache = new Map();
const enrichedLibraryResponseCacheTtlMs = Number(process.env.ENRICHED_LIBRARY_RESPONSE_CACHE_TTL_MS || 15000);
const enrichedLibraryResponseCacheLimit = 80;
const debugLog = [];
const debugLogLimit = 500;
const debugLogPath = process.env.CLOUD_SQUEEZE_LOG_PATH || "/tmp/cloud-squeeze-events.jsonl";
const idleTrackInfo = {
  artistBio: "Connect a Squeezebox player, start a track, then enable the LMS Music and Artist Information plugin for live biographies, album reviews, and lyrics.",
  albumReview: "No album review is available until a real track is playing.",
  lyrics: "Lyrics will appear here when the LMS plugin exposes them.",
  art: null
};
const idleNowPlaying = {
  id: "idle",
  title: "No track playing",
  artist: "Connect a player or request a song",
  album: "",
  source: "LMS",
  duration: 0,
  elapsed: 0,
  canSeek: false,
  art: null
};

export function createApp({ lms = new LmsClient(), playlists = defaultPlaylistStore, curation = defaultCurationStore, taste = defaultListenerTasteStore, tapStore = defaultTapStore } = {}) {
  const app = express();
  const adminAuth = getAdminAuthConfig();
  appState.curation = curation.getState();
  app.disable("x-powered-by");
  app.use(applySecurityHeaders);
  app.use(forceHttpsRedirect);
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedCorsOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    }
  }));
  const transportTextParser = express.text({ type: "*/*", limit: "2kb" });
  app.use((req, res, next) => {
    if (transportActionPaths.has(req.path)) return transportTextParser(req, res, next);
    return next();
  });
  app.use(express.json());
  app.use((error, _req, res, next) => {
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON request body" });
      return;
    }
    next(error);
  });
  if (process.env.NODE_ENV !== "test") {
    const shuffleMonitor = setInterval(() => {
      const manage = appState.playback.smartQueue || appState.queue.length > 0;
      // Also poll while Surprise songs are queued-but-unsaved, so each lands in
      // the Library the moment it starts playing (without app-managing the queue).
      if (manage || pendingDiscoverSaves.size > 0) refreshLms(lms, { maintainPlayback: manage, taste }).catch(() => null);
    }, 8000);
    shuffleMonitor.unref?.();
    const startupRefresh = setTimeout(() => {
      refreshLms(lms, { force: true, skipTrackInfo: true, taste }).catch(() => null);
    }, 250);
    startupRefresh.unref?.();
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "cloud-squeeze" });
  });

  app.get("/api/debug/logs", requireAdmin, (req, res) => {
    const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 120, min: 1, max: 500 });
    if (limit === null) {
      res.status(400).json({ error: "Debug log limit must be a positive integer up to 500", events: [] });
      return;
    }
    res.json({ events: debugLog.slice(-limit) });
  });

  app.get("/api/state", async (_req, res) => {
    await refreshLms(lms, {
      minAgeMs: appState.player.mode === "play" ? 650 : 1600,
      waitForFresh: !refreshState.updatedAt || !appState.player.connected,
      maintainPlayback: shouldMaintainQueueOnPoll(),
      taste
    });
    res.json(getPublicState());
  });

  app.get("/api/speaker/status", async (_req, res) => {
    const status = await refreshLms(lms, {
      minAgeMs: 1600,
      waitForFresh: !refreshState.updatedAt || !appState.player.connected,
      taste
    });
    res.json(status);
  });

  // Fresh live playback position for cross-device sync (bypasses the cached snapshot).
  app.get("/api/player/position", async (_req, res) => {
    try {
      const playerId = await hotPlayerId(lms);
      const pos = await lms.livePosition(playerId);
      res.json({ ...pos, atMs: Date.now() });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.get("/api/speaker/connect-guide", async (_req, res) => {
    const player = await refreshLms(lms, { taste });
    const lmsWeb = await checkUrl(config.lmsHttpUrl);
    res.json({
      serverHost: config.publicLmsHost,
      lanServerHost: config.lanLmsHost,
      lmsWebUrl: config.publicLmsHttpUrl,
      ports: [
        { port: 9000, label: "LMS web and player HTTP" },
        { port: 3483, label: "Squeezebox discovery and streaming" }
      ],
      lmsWeb,
      player,
      steps: [
        "Connect the Squeezebox to your Wi-Fi or Ethernet.",
        "Open the Squeezebox Server option.",
        "If the box is on the same network, enter the local IP address. If it is remote, enter the public IP after port forwarding is enabled.",
        "Connect to that library, then return here and press Check connection."
      ]
    });
  });

  app.post("/api/queue", async (req, res) => {
    const clearEpochAtRequest = queueClearState.epoch;
    return withQueueMutationLock(async () => {
    const parsed = queueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue item", issues: parsed.error.issues });
      return;
    }
    if (!publicRequestsOpen()) {
      res.status(403).json(queueErrorPayload(publicRequestsClosedMessage()));
      return;
    }
    if (!canQueueMoreGuestTracks(1)) {
      res.status(429).json(queueErrorPayload(queueLimitMessage()));
      return;
    }
    if (!isPlayableTrackInput(parsed.data)) {
      res.status(400).json({ error: "Playable local path, LMS track id, or Spotify URI is required" });
      return;
    }
    if (!spotifyTracksAreKnown([parsed.data])) {
      res.status(400).json({ error: "Spotify tracks must come from Cloud Squeeze search, playlist, or library results" });
      return;
    }
    const canonicalTrack = canonicalizeSpotifyTrack(parsed.data);
    if (!(await trackInputsExistOnDisk([canonicalTrack]))) {
      res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
      return;
    }
    if (queuedTrackInputExists(canonicalTrack)) {
      res.status(409).json(queueErrorPayload("That song is already in the queue"));
      return;
    }
    if (queueAddStaleAfterClear(clearEpochAtRequest)) {
      res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue });
      return;
    }
    if (generatedShufflePlaybackActive()) stopGeneratedPlayback();
    await turnRepeatOffForVisibleQueue(lms);
    if (queueAddStaleAfterClear(clearEpochAtRequest)) {
      res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue });
      return;
    }
    const queued = addQueueItem({ ...canonicalTrack, requestedBy: "guest" });
    markQueueManagedPlayback();
    res.status(201).json(queued);
    });
  });

  app.patch("/api/queue/:id", (req, res) => withQueueMutationLock(async () => {
    const parsed = queueUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue update", issues: parsed.error.issues });
      return;
    }
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue });
      return;
    }
    const existing = appState.queue.find((item) => item.id === req.params.id);
    if (existing && parsed.data.requestedBy !== undefined && parsed.data.requestedBy !== existing.requestedBy) {
      res.status(400).json({ error: "Queue request ownership cannot be edited" });
      return;
    }
    if (existing && isSpotifyQueueItem(existing) && hasQueueMetadataChange(existing, parsed.data)) {
      res.status(400).json({ error: "Spotify queue item metadata cannot be edited" });
      return;
    }
    const item = updateQueueItem(req.params.id, parsed.data);
    if (!item) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    res.json({ ok: true, item, queue: appState.queue });
  }));

  app.delete("/api/queue/:id", (req, res) => withQueueMutationLock(async () => {
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue });
      return;
    }
    const item = removeQueueItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    res.json({ ok: true, removed: item, queue: appState.queue });
  }));

  app.delete("/api/queue", (_req, res) => {
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue, playback: appState.playback });
      return;
    }
    cancelPendingVisibleQueueAdvance();
    markQueueCleared();
    return withQueueMutationLock(async () => {
      const removed = [];
      for (const item of [...appState.queue]) {
        const removedItem = removeQueueItem(item.id);
        if (removedItem) removed.push(removedItem);
      }
      stopGeneratedPlayback();
      logEvent("queue.clear", { count: removed.length, playback: appState.playback });
      res.json({ ok: true, removed, queue: appState.queue, playback: appState.playback });
    });
  });

  app.post("/api/queue/:id/move", (req, res) => withQueueMutationLock(async () => {
    const parsed = queueMoveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue move", issues: parsed.error.issues, queue: appState.queue });
      return;
    }
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue });
      return;
    }
    const direction = parsed.data.direction ?? parsed.data.index;
    const item = moveQueueItem(req.params.id, direction);
    if (item === null) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    if (item === undefined) {
      res.status(400).json({ error: "Invalid queue move" });
      return;
    }
    res.json({ ok: true, item, queue: appState.queue });
  }));

  app.post("/api/player/track", async (req, res) => {
    const clearEpochAtRequest = queueClearState.epoch;
    return withQueueMutationLock(async () => {
    const parsed = playbackTrackSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Track playback supports add-queue, play-next, or play-now", issues: parsed.error.issues, queue: appState.queue, playback: appState.playback });
      return;
    }
    const { action } = parsed.data;
    let { track } = parsed.data;
    if (!isPlayableTrackInput(track)) {
      res.status(400).json({ error: "Playable local path, LMS track id, or Spotify URI is required" });
      return;
    }
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue, playback: appState.playback });
      return;
    }
    if (!spotifyTracksAreKnown([track])) {
      res.status(400).json({ error: "Spotify tracks must come from Cloud Squeeze search, playlist, or library results" });
      return;
    }
    track = canonicalizeSpotifyTrack(track);
    try {
      logEvent("track.request", { action, track: trackSummary(track), playerId: appState.player.id });
      let queued = null;
      if (action === "add-queue") {
        if (queuedTrackInputExists(track)) {
          res.status(409).json(queueErrorPayload("That song is already in the queue"));
          return;
        }
        if (!canQueueMoreGuestTracks(1)) {
          res.status(429).json(queueErrorPayload(queueLimitMessage()));
          return;
        }
        if (!(await trackInputsExistOnDisk([track]))) {
          res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
          return;
        }
        if (queueAddStaleAfterClear(clearEpochAtRequest)) {
          res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue, playback: appState.playback });
          return;
        }
        if (generatedShufflePlaybackActive()) stopGeneratedPlayback();
        await turnRepeatOffForVisibleQueue(lms);
        if (queueAddStaleAfterClear(clearEpochAtRequest)) {
          res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue, playback: appState.playback });
          return;
        }
        queued = addQueueItem({ ...track, requestedBy: "guest" });
        markQueueManagedPlayback();
        logEvent("queue.add", { action, queued: trackSummary(queued), queue: queueSummary() });
      } else if (action === "play-next") {
        if (queuedTrackInputExists(track)) {
          res.status(409).json(queueErrorPayload("That song is already in the queue"));
          return;
        }
        if (!canQueueMoreGuestTracks(1)) {
          res.status(429).json(queueErrorPayload(queueLimitMessage()));
          return;
        }
        if (!(await trackInputsExistOnDisk([track]))) {
          res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
          return;
        }
        if (queueAddStaleAfterClear(clearEpochAtRequest)) {
          res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue, playback: appState.playback });
          return;
        }
        if (generatedShufflePlaybackActive()) stopGeneratedPlayback();
        await turnRepeatOffForVisibleQueue(lms);
        if (queueAddStaleAfterClear(clearEpochAtRequest)) {
          res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue, playback: appState.playback });
          return;
        }
        queued = addQueueItemNext({ ...track, requestedBy: "guest" });
        markQueueManagedPlayback();
        logEvent("queue.add-next", { action, queued: trackSummary(queued), queue: queueSummary() });
      } else {
        if (!(await trackInputsExistOnDisk([track]))) {
          res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
          return;
        }
        const playerId = await hotPlayerId(lms);
        const previousTrack = appState.nowPlaying;
        rememberPlaybackMetadata(track);
        await lms.playTrack(playerId, track, "play-now");
        // If this track was sitting in the visible "Up next" queue (e.g. the user hit
        // Play on a queue row), consume it so it isn't played again on auto-advance.
        removeQueuedPlaybackMatch(track);
        stopGeneratedPlayback();
        setMode("play");
        rememberPreviousTrack(previousTrack);
        updatePlayback({ appManagedPlayback: true });
        markPendingPlayback(track);
        const optimistic = optimisticTrack(track);
        updateNowPlaying(optimistic);
        await refreshPlayedTrackMetadata(lms, playerId, track);
        logEvent("track.play-now", { track: trackSummary(track), queue: queueSummary() });
        refreshLms(lms, { force: true, taste }).catch(() => null);
      }
      res.json({ ok: true, action, queued, queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
    });
  });

  // Play a track from a playlist and make the queue ONLY that playlist: clear the
  // current queue, play the chosen track now, and load the rest as a manual queue
  // (so the global shuffle/radio engine doesn't override it). Order vs shuffle
  // follows the server's shuffle toggle.
  app.post("/api/player/playlist", async (req, res) => {
    return withQueueMutationLock(async () => {
      const parsed = playlistPlaySchema.safeParse(req.body || {});
      if (!parsed.success) {
        res.status(400).json({ error: "A track list (and optional startIndex) is required", issues: parsed.error.issues });
        return;
      }
      if (!publicRequestsOpen()) {
        res.status(403).json(queueErrorPayload(publicRequestsClosedMessage()));
        return;
      }
      const playable = parsed.data.tracks.filter(isPlayableTrackInput);
      if (!playable.length) {
        res.status(400).json({ error: "No playable tracks were provided" });
        return;
      }
      if (!spotifyTracksAreKnown(playable)) {
        res.status(400).json({ error: "Spotify tracks must come from Cloud Squeeze search, playlist, or library results" });
        return;
      }
      // Use the server's canonical metadata for known Spotify tracks, not the
      // caller-supplied objects — otherwise a valid URI can carry spoofed
      // title/artist/art into LMS + the queue, and compact posts lose real artwork.
      const canonicalPlayable = canonicalizeSpotifyTracks(playable);
      if (!(await trackInputsExistOnDisk(canonicalPlayable))) {
        res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
        return;
      }
      const start = Math.min(Math.max(0, parsed.data.startIndex || 0), canonicalPlayable.length - 1);
      const startTrack = canonicalPlayable[start];
      const wantShuffle = Boolean(appState.playback.shuffle);
      let rest = [...canonicalPlayable.slice(start + 1), ...canonicalPlayable.slice(0, start)];
      if (wantShuffle) rest = shuffleArray(rest);
      try {
        const playerId = await hotPlayerId(lms);
        // Replace the current queue with this playlist.
        cancelPendingVisibleQueueAdvance();
        markQueueCleared();
        for (const item of [...appState.queue]) removeQueueItem(item.id);
        stopGeneratedPlayback();
        await turnRepeatOffForVisibleQueue(lms);
        // Play the chosen track now.
        const previousTrack = appState.nowPlaying;
        rememberPlaybackMetadata(startTrack);
        await lms.playTrack(playerId, startTrack, "play-now");
        setMode("play");
        rememberPreviousTrack(previousTrack);
        // Preserve the user's shuffle toggle (stopGeneratedPlayback clears it).
        updatePlayback({ appManagedPlayback: true, shuffle: wantShuffle });
        markPendingPlayback(startTrack);
        updateNowPlaying(optimisticTrack(startTrack));
        // Queue the rest of the playlist as a manual queue.
        const limited = rest.slice(0, 300);
        for (const t of limited) addQueueItem({ ...t, requestedBy: "playlist" });
        markQueueManagedPlayback();
        await refreshPlayedTrackMetadata(lms, playerId, startTrack);
        refreshLms(lms, { force: true, taste }).catch(() => null);
        logEvent("playlist.play", { start: trackSummary(startTrack), count: limited.length, shuffle: wantShuffle });
        res.json({ ok: true, queued: limited.length, shuffle: wantShuffle, queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying, playback: appState.playback });
      } catch (error) {
        res.status(502).json({ error: error.message });
      }
    });
  });

  app.post("/api/player/tracks", async (req, res) => {
    const clearEpochAtRequest = queueClearState.epoch;
    return withQueueMutationLock(async () => {
    const parsed = playbackTracksSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "At least one track is required" });
      return;
    }
    const { action, tracks } = parsed.data;
    if (!publicRequestsOpen()) {
      res.status(403).json(queueErrorPayload(publicRequestsClosedMessage(), { accepted: 0, rejected: tracks.length }));
      return;
    }

    const playable = tracks.filter(isPlayableTrackInput);
    if (playable.length === 0) {
      res.status(400).json({ error: "No playable tracks were provided" });
      return;
    }
    const uniquePlayable = uniquePlayableInputs(playable);
    if (uniquePlayable.length === 0) {
      res.status(409).json(queueErrorPayload("Those songs are already in the queue", { accepted: 0, rejected: playable.length }));
      return;
    }
    const availableSlots = Math.max(0, guestQueueLimit() - guestQueueCount());
    if (availableSlots <= 0) {
      res.status(429).json(queueErrorPayload(queueLimitMessage(), { accepted: 0, rejected: playable.length }));
      return;
    }
    const acceptedPlayable = uniquePlayable.slice(0, availableSlots);
    if (!spotifyTracksAreKnown(acceptedPlayable)) {
      res.status(400).json({ error: "Spotify tracks must come from Cloud Squeeze search, playlist, or library results" });
      return;
    }
    const canonicalAccepted = canonicalizeSpotifyTracks(acceptedPlayable);
    if (!(await trackInputsExistOnDisk(canonicalAccepted))) {
      res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
      return;
    }
    if (queueAddStaleAfterClear(clearEpochAtRequest)) {
      res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue, playback: appState.playback, accepted: 0, rejected: playable.length });
      return;
    }

    if (generatedShufflePlaybackActive()) stopGeneratedPlayback();
    await turnRepeatOffForVisibleQueue(lms);
    if (queueAddStaleAfterClear(clearEpochAtRequest)) {
      res.status(409).json({ error: "Queue was cleared while this request was pending", queue: appState.queue, playback: appState.playback, accepted: 0, rejected: playable.length });
      return;
    }
    const queued = [];
    const ordered = action === "play-next" ? [...canonicalAccepted].reverse() : canonicalAccepted;
    for (const track of ordered) {
      const item = action === "play-next"
        ? addQueueItemNext({ ...track, requestedBy: "guest" })
        : addQueueItem({ ...track, requestedBy: "guest" });
      queued.push(item);
    }
    if (queued.length > 0) markQueueManagedPlayback();
    if (action === "play-next") queued.reverse();
    const rejected = Math.max(0, tracks.length - queued.length);
    logEvent("queue.batch", { action, count: queued.length, requested: tracks.length, playable: playable.length, deduped: uniquePlayable.length, rejected, queued: queued.map(trackSummary), queue: queueSummary() });
    res.json({ ok: true, action, queued, queue: appState.queue, playback: appState.playback, accepted: queued.length, rejected });
    });
  });

  app.get("/api/library/search", async (req, res) => {
    const source = parseLibrarySource(req.query.source);
    if (!source) {
      res.status(400).json({ error: "Library source must be all, local, or uploaded" });
      return;
    }
    const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 100, min: 1, max: 2000 });
    if (limit === null) {
      res.status(400).json({ error: "Library search limit must be a positive integer up to 2000" });
      return;
    }
    const query = String(req.query.q || "");
    const cacheKey = enrichedLibraryResponseCacheKey("search", { query, limit, source });
    const results = await cachedEnrichedLibraryResults(cacheKey, async () => {
      const libraryResults = await searchLibrary(query, undefined, limit, source);
      return enrichLibraryArtwork(lms, libraryResults, { fallbackBudgetMs: localSearchFallbackArtworkBudgetMs });
    });
    res.json({ results: filterHiddenResults(results, curation) });
  });

  app.get("/api/spotify/search", async (req, res) => {
    try {
      if (!spotifyBrowsingAvailable()) {
        res.json({ results: [], spotify: appState.services.spotify });
        return;
      }
      const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 20, min: 1, max: 50 });
      if (limit === null) {
        res.status(400).json({ error: "Spotify search limit must be a positive integer up to 50", results: [] });
        return;
      }
      const query = String(req.query.q || "").trim();
      if (!query) {
        res.json({ results: [] });
        return;
      }
      const results = await withLmsRetry(lms, async () => {
        const playerId = await hotPlayerId(lms);
        return lms.spotifySearch(playerId, query, limit);
      });
      rememberKnownSpotifyTracks(results);
      const visible = filterHiddenResults(results, curation);
      res.json({ results: visible, groups: groupSpotifyResults(visible) });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [], groups: groupSpotifyResults([]) });
    }
  });

  app.get("/api/spotify/search/categories", async (req, res) => {
    const empty = { artists: [], albums: [], playlists: [] };
    try {
      if (!spotifyBrowsingAvailable()) {
        res.json(empty);
        return;
      }
      const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 8, min: 1, max: 20 });
      if (limit === null) {
        res.status(400).json({ error: "Spotify category limit must be a positive integer up to 20", ...empty });
        return;
      }
      const query = String(req.query.q || "").trim();
      if (!query) {
        res.json(empty);
        return;
      }
      const playerId = await hotPlayerId(lms);
      const categories = await lms.spotifySearchCategories(playerId, query, limit);
      rememberKnownSpotifyTracks([...categories.artists, ...categories.albums, ...categories.playlists]);
      res.json({
        artists: filterHiddenResults(categories.artists, curation),
        albums: filterHiddenResults(categories.albums, curation),
        playlists: filterHiddenResults(categories.playlists, curation)
      });
    } catch (error) {
      res.status(502).json({ error: error.message, ...empty });
    }
  });

  app.get("/api/spotify/library", async (req, res) => {
    try {
      if (!spotifyBrowsingAvailable()) {
        res.json({ results: [], spotify: appState.services.spotify });
        return;
      }
      const type = String(req.query.type || "playlists");
      if (!["playlists", "albums", "artists", "tracks", "home"].includes(type)) {
        res.status(400).json({ error: "Spotify library type must be playlists, albums, artists, tracks, or home", results: [] });
        return;
      }
      const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 50, min: 1, max: 100 });
      const offset = parseBoundedIntegerParam(req.query.offset, { defaultValue: 0, min: 0, max: 10000 });
      if (limit === null) {
        res.status(400).json({ error: "Spotify library limit must be a positive integer up to 100", results: [] });
        return;
      }
      if (offset === null) {
        res.status(400).json({ error: "Spotify library offset must be a non-negative integer", results: [] });
        return;
      }
      const playerId = await hotPlayerId(lms);
      const results = await lms.spotifyLibrary(playerId, type, limit, offset);
      rememberKnownSpotifyTracks(results);
      res.json({
        results: filterHiddenResults(results, curation)
      });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [] });
    }
  });

  app.get("/api/spotify/children", async (req, res) => {
    try {
      if (!spotifyBrowsingAvailable()) {
        res.json({ results: [], spotify: appState.services.spotify });
        return;
      }
      const kind = String(req.query.kind || "playlist");
      const browseId = String(req.query.browseId || "");
      const uri = String(req.query.uri || "");
      const title = String(req.query.title || "");
      if (!["playlist", "album", "artist", "track"].includes(kind)) {
        res.status(400).json({ error: "Spotify child kind must be playlist, album, artist, or track", results: [] });
        return;
      }
      if (!browseId && !uri) {
        res.status(400).json({ error: "Spotify browse id or URI is required", results: [] });
        return;
      }
      if (uri && !isSpotifyChildUriForKind(kind, uri)) {
        res.status(400).json({ error: "Spotify child URI must match the requested kind", results: [] });
        return;
      }
      const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 200, min: 1, max: 300 });
      const offset = parseBoundedIntegerParam(req.query.offset, { defaultValue: 0, min: 0, max: 10000 });
      if (limit === null) {
        res.status(400).json({ error: "Spotify child limit must be a positive integer up to 300", results: [] });
        return;
      }
      if (offset === null) {
        res.status(400).json({ error: "Spotify child offset must be a non-negative integer", results: [] });
        return;
      }
      const playerId = await hotPlayerId(lms);
      const results = await lms.spotifyChildren(
        playerId,
        { browseId, uri, kind, title },
        limit,
        offset
      );
      rememberKnownSpotifyTracks(results);
      res.json({ results: filterHiddenResults(results, curation) });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [] });
    }
  });

  app.get("/api/playlists", (_req, res) => {
    res.json({ playlists: playlists.list() });
  });

  app.get("/api/playlists/:id", (req, res) => {
    const playlist = playlists.get(req.params.id);
    if (!playlist) {
      res.status(404).json({ error: "Playlist not found" });
      return;
    }
    // Spotify tracks are validated against an in-memory cache that expires (TTL /
    // restart). Re-remember this persisted playlist's tracks when it's opened so
    // playing/queueing from a saved playlist keeps passing the "known track" check.
    rememberKnownSpotifyTracks(playlist.tracks);
    res.json({ playlist });
  });

  app.post("/api/playlists", (req, res) => {
    const parsed = playlistCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A playlist name is required" });
      return;
    }
    runPlaylistAction(res, () => {
      const playlist = playlists.create({
        name: parsed.data.name,
        description: parsed.data.description,
        createdBy: parsed.data.createdBy || "guest"
      });
      logEvent("playlist.create", { id: playlist.id, name: playlist.name, createdBy: playlist.createdBy });
      res.status(201).json({ playlist });
    });
  });

  app.post("/api/playlists/:id/tracks", (req, res) => {
    const tracks = Array.isArray(req.body?.tracks)
      ? req.body.tracks
      : req.body?.track
        ? [req.body.track]
        : [];
    if (tracks.length === 0) {
      res.status(400).json({ error: "At least one track is required" });
      return;
    }
    runPlaylistAction(res, () => {
      const { playlist, added } = playlists.addTracks(req.params.id, tracks.slice(0, 100));
      logEvent("playlist.add-tracks", { id: playlist.id, added });
      res.json({ playlist, added });
    });
  });

  app.patch("/api/playlists/:id", requireAdmin, (req, res) => {
    runPlaylistAction(res, () => {
      const playlist = playlists.rename(req.params.id, { name: req.body?.name, description: req.body?.description });
      logEvent("playlist.rename", { id: playlist.id, name: playlist.name });
      res.json({ playlist });
    });
  });

  app.delete("/api/playlists/:id", requireAdmin, (req, res) => {
    runPlaylistAction(res, () => {
      const playlist = playlists.remove(req.params.id);
      logEvent("playlist.delete", { id: playlist.id });
      res.json({ ok: true, id: playlist.id });
    });
  });

  app.delete("/api/playlists/:id/tracks/:trackKey", requireAdmin, (req, res) => {
    runPlaylistAction(res, () => {
      // Express already decoded the param; decoding again throws on a literal '%'
      // (e.g. a track titled "100%"). Just normalize to the lowercased match key.
      const key = String(req.params.trackKey || "").toLowerCase();
      const playlist = playlists.removeTrack(req.params.id, key);
      res.json({ playlist });
    });
  });

  app.post("/api/playlists/:id/tracks/move", requireAdmin, (req, res) => {
    runPlaylistAction(res, () => {
      const playlist = playlists.moveTrack(req.params.id, {
        key: typeof req.body?.key === "string" ? req.body.key.toLowerCase() : undefined,
        from: req.body?.from,
        to: req.body?.to,
        direction: req.body?.direction
      });
      res.json({ playlist });
    });
  });

  app.post("/api/curation", requireAdmin, (req, res) => {
    const parsed = curationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid curation item", issues: parsed.error.issues, curation: appState.curation });
      return;
    }
    runCurationAction(res, () => {
      const result = curation.update(parsed.data.action, parsed.data.track);
      appState.curation = result.curation;
      clearEnrichedLibraryResponseCache();
      logEvent("curation.update", { action: parsed.data.action, key: result.item.key });
      res.json({ ok: true, action: parsed.data.action, item: result.item, curation: result.curation });
    });
  });

  app.get("/api/library/collections", async (req, res) => {
    const source = parseLibrarySource(req.query.source);
    if (!source) {
      res.status(400).json({ error: "Library source must be all, local, or uploaded" });
      return;
    }
    const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 1000, min: 1, max: 2000 });
    if (limit === null) {
      res.status(400).json({ error: "Library collections limit must be a positive integer up to 2000" });
      return;
    }
    const offset = parseBoundedIntegerParam(req.query.offset, { defaultValue: 0, min: 0, max: 10000 });
    if (offset === null) {
      res.status(400).json({ error: "Library collections offset must be a non-negative integer" });
      return;
    }
    const collections = await getCollections(undefined, source);
    const page = collections.slice(offset, offset + limit);
    const cacheKey = enrichedLibraryResponseCacheKey("collections", { source, limit, offset });
    const enriched = await cachedEnrichedLibraryResults(cacheKey, () => enrichCollectionCovers(lms, page));
    res.json({ collections: enriched });
  });

  app.get("/api/library/collection", async (req, res) => {
    const source = parseLibrarySource(req.query.source);
    if (!source) {
      res.status(400).json({ error: "Library source must be all, local, or uploaded" });
      return;
    }
    const collection = String(req.query.collection || "");
    const folder = String(req.query.folder || "");
    if (!collection.trim() && !folder.trim()) {
      res.status(400).json({ error: "Collection or folder is required" });
      return;
    }
    const limit = parseBoundedIntegerParam(req.query.limit, { defaultValue: 1000, min: 1, max: 2000 });
    if (limit === null) {
      res.status(400).json({ error: "Library collection limit must be a positive integer up to 2000" });
      return;
    }
    const offset = parseBoundedIntegerParam(req.query.offset, { defaultValue: 0, min: 0, max: 10000 });
    if (offset === null) {
      res.status(400).json({ error: "Library collection offset must be a non-negative integer" });
      return;
    }
    const cacheKey = enrichedLibraryResponseCacheKey("collection", { collection, folder, source, limit, offset });
    const results = await cachedEnrichedLibraryResults(cacheKey, async () => {
      const collectionResults = await getCollectionTracks({
        collection,
        folder,
        source,
        limit,
        offset
      });
      return enrichLibraryArtwork(lms, collectionResults);
    });
    res.json({ results: filterHiddenResults(results, curation) });
  });

  app.post("/api/library/rescan", requireAdmin, async (_req, res) => {
    const result = await rescanLibraryOnce();
    res.json(result);
  });

  app.post("/api/library/upload", express.raw({ type: "application/octet-stream", limit: "80mb" }), async (req, res) => {
    try {
      if (!req.is("application/octet-stream")) {
        res.status(415).json({ error: "Upload content type must be application/octet-stream" });
        return;
      }
      if (!publicRequestsOpen()) {
        res.status(403).json({ error: publicRequestsClosedMessage() });
        return;
      }
      const originalName = String(req.query.filename || req.get("x-upload-filename") || "");
      const track = await saveUploadedTrack({ originalName, bytes: req.body });
      clearEnrichedLibraryResponseCache();
      const tracks = await scanLibrary(undefined, 5000, "all");
      const lmsRescan = await lms.rescanLibrary?.().then(() => true).catch(() => false);
      res.status(201).json({ ok: true, track, trackCount: tracks.length, status: appState.services.localLibrary, lmsRescan });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  const streamHandler = async (req, res) => {
    try {
      const trackPath = Buffer.from(String(req.params.encodedPath || ""), "base64url").toString("utf8");
      const resolved = await safeMusicPath(trackPath);
      if (!resolved) {
        res.status(404).json({ error: "Track not found" });
        return;
      }
      const stat = await fs.promises.stat(resolved);
      const range = req.headers.range;
      const contentType = audioContentType(resolved);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=0, no-store");
      if (range) {
        const parsedRange = parseByteRange(range, stat.size);
        if (!parsedRange) {
          res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
          return;
        }
        const { start, end } = parsedRange;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.setHeader("Content-Length", end - start + 1);
        fs.createReadStream(resolved, { start, end }).pipe(res);
        return;
      }
      res.setHeader("Content-Length", stat.size);
      fs.createReadStream(resolved).pipe(res);
    } catch (error) {
      res.status(404).json({ error: "Track not found" });
    }
  };
  app.get("/api/stream/:encodedPath", streamHandler);
  app.get("/api/stream/:encodedPath/:name", streamHandler);

  app.get("/api/spotify/status", async (_req, res) => {
    const status = await lms.spotifyStatus();
    updateSpotifyStatus(status);
    res.json(status);
  });

  app.get("/api/spotify/connect", (_req, res) => {
    const lanUrl = `http://${config.lanLmsHost}:9000/settings/index.html`;
    res.json({
      setupUrl: lanUrl,
      fallbackUrl: config.publicLmsHttpUrl,
      steps: [
        "Open LMS settings.",
        "Go to Plugins and install or enable Spotty.",
        "Restart LMS if prompted.",
        "Open Spotty settings and authorize Spotify.",
        "Return to Squeezebox Cloud and press Check."
      ]
    });
  });

  app.get("/api/music-info/status", async (_req, res) => {
    const status = await lms.musicInfoStatus();
    updateMusicInfoStatus(status);
    res.json(status);
  });

  app.get("/api/artwork/:coverId", async (req, res) => {
    try {
      const artwork = await lms.artwork(req.params.coverId);
      if (!artwork) {
        res.status(404).json({ error: "Artwork not found" });
        return;
      }
      res.type(artwork.contentType);
      res.set("Cache-Control", "public, max-age=3600");
      res.send(artwork.bytes);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.get("/api/image-proxy", async (req, res) => {
    const url = String(req.query.url || "");
    if (!/^https?:\/\/(i\.scdn\.co|mosaic\.scdn\.co|image-cdn-[a-z]+\.spotifycdn\.com|pickasso\.spotifycdn\.com|blend-playlist-covers\.spotifycdn\.com|seed-mix-image\.spotifycdn\.com|is\d+-ssl\.mzstatic\.com|coverartarchive\.org)\//i.test(url)) {
      res.status(400).json({ error: "Unsupported image host" });
      return;
    }
    const cached = getCachedProxyImage(url);
    if (cached) {
      res.type(cached.contentType);
      res.set("Cache-Control", "public, max-age=86400, immutable");
      res.send(cached.bytes);
      return;
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) {
        res.status(204).set("Cache-Control", "public, max-age=3600").end();
        return;
      }
      const contentType = response.headers.get("content-type") || "image/jpeg";
      if (!contentType.toLowerCase().startsWith("image/")) {
        res.status(415).json({ error: "Proxied content is not an image" });
        return;
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > imageProxyMaxBytes) {
        res.status(413).json({ error: "Image is too large" });
        return;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > imageProxyMaxBytes) {
        res.status(413).json({ error: "Image is too large" });
        return;
      }
      setCachedProxyImage(url, contentType, bytes);
      res.type(contentType);
      res.set("Cache-Control", "public, max-age=86400, immutable");
      res.send(bytes);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post("/api/admin/login", (req, res) => {
    if (isAdminLoginRateLimited(req)) {
      logEvent("admin.login.rate-limited", { key: adminLoginKey(req) });
      res.status(429).json({ error: "Too many admin login attempts" });
      return;
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success || !verifyAdminPassword(parsed.data.password, adminAuth.passwordVerifier)) {
      recordAdminLoginFailure(req);
      logEvent("admin.login.failed", { key: adminLoginKey(req) });
      res.status(401).json({ error: "Invalid admin password" });
      return;
    }
    clearAdminLoginFailures(req);
    logEvent("admin.login.success", { key: adminLoginKey(req) });
    res.json(issueAdminSession(adminAuth.sessionTtlMs));
  });

  app.post("/api/player/play", async (req, res) => {
    if (rejectUnexpectedTransportBody(req, res, "Use /api/player/track to play a specific song")) return;
    return withTransportLock(res, async () => {
    try {
      const playerId = await hotPlayerId(lms);
      const shouldPlayVisibleQueue =
        (appState.player.mode === "stop" || appState.player.mode === "stopped") &&
        appState.queue.length > 0;
      const played = shouldPlayVisibleQueue ? await playNextVisibleQueueItem(lms, playerId) : null;
      if (!played) {
        await control(lms, "play");
        updatePlayback({ appManagedPlayback: Boolean(appState.playback.appManagedPlayback && appState.queue.length > 0) });
      }
      refreshLms(lms, { force: true, taste }).catch(() => null);
      res.json({ ok: true, action: played ? "visible-queue-play" : "play", mode: appState.player.mode, player: appState.player, nowPlaying: appState.nowPlaying, queue: appState.queue, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, mode: appState.player.mode, player: appState.player, nowPlaying: appState.nowPlaying, queue: appState.queue });
    }
    });
  });

  app.post("/api/player/pause", async (req, res) => {
    if (rejectUnexpectedTransportBody(req, res)) return;
    return withTransportLock(res, async () => {
    try {
      await control(lms, "pause");
      res.json({ ok: true, mode: appState.player.mode, player: appState.player });
    } catch (error) {
      res.status(502).json({ error: error.message, mode: appState.player.mode, player: appState.player });
    }
    });
  });

  app.post("/api/player/stop", async (req, res) => {
    if (rejectUnexpectedTransportBody(req, res)) return;
    return withTransportLock(res, async () => {
    try {
      await control(lms, "stop");
      recordListeningSkip(taste, appState.nowPlaying, "transport.stop");
      cancelPendingVisibleQueueAdvance();
      markQueueCleared();
      for (const item of [...appState.queue]) {
        removeQueueItem(item.id);
      }
      clearPendingPlayback();
      clearPendingSeek();
      updatePlayback({
        shuffle: false,
        manualShuffle: false,
        smartQueue: false,
        repeat: "off",
        lastShuffleRefillAt: 0,
        lastShuffleSeed: "",
        lastSmartQueueBase: "",
        history: [],
        previousTracks: [],
        appManagedPlayback: false
      });
      updateNowPlaying(idleNowPlaying);
      updateTrackInfo(idleTrackInfo);
      res.json({ ok: true, mode: appState.player.mode, player: appState.player, nowPlaying: appState.nowPlaying, queue: appState.queue, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, mode: appState.player.mode, player: appState.player });
    }
    });
  });

  app.post("/api/player/next", async (req, res) => {
    if (rejectUnexpectedTransportBody(req, res)) return;
    return withTransportLock(res, async () => {
    try {
      const playerId = await hotPlayerId(lms);
      logEvent("transport.next.request", { queue: queueSummary(), playback: appState.playback, nowPlaying: trackSummary(appState.nowPlaying) });
      const currentBeforeNextRequest = appState.nowPlaying;
      recordListeningSkip(taste, currentBeforeNextRequest, "transport.next");
      const played = await playNextVisibleQueueItem(lms, playerId);
      const emptyAppManagedQueue =
        !played &&
        appState.queue.length === 0 &&
        (appState.playback.shuffle || appState.playback.smartQueue || appState.playback.appManagedPlayback);
      const stoppedWithEmptyManualQueue =
        !played &&
        appState.queue.length === 0 &&
        !appState.playback.shuffle &&
        !appState.playback.smartQueue &&
        (appState.player.mode === "stop" || appState.player.mode === "stopped");
      const stoppedEmptyAppManagedQueue = emptyAppManagedQueue && appState.player.mode !== "stop" && appState.player.mode !== "stopped";
      if (stoppedEmptyAppManagedQueue) {
        await control(lms, "stop");
        setMode("stop");
        updatePlayback({ appManagedPlayback: false, previousTracks: [] });
        updateNowPlaying(idleNowPlaying);
        updateTrackInfo(idleTrackInfo);
      }
      if (!played && !stoppedWithEmptyManualQueue && !emptyAppManagedQueue) {
        const currentBeforeNext = appState.nowPlaying;
        await control(lms, "next");
        rememberPreviousTrack(currentBeforeNext);
      }
      if (!stoppedWithEmptyManualQueue && !emptyAppManagedQueue) refreshLms(lms, { force: true, taste }).catch(() => null);
      const resultAction = played ? "visible-queue-next" : stoppedEmptyAppManagedQueue ? "stop-empty-queue" : (stoppedWithEmptyManualQueue || emptyAppManagedQueue) ? "noop" : "next";
      logEvent("transport.next.result", { action: played ? "visible-queue-next" : stoppedEmptyAppManagedQueue ? "stop-empty-queue" : (stoppedWithEmptyManualQueue || emptyAppManagedQueue) ? "noop" : "lms-next", played: trackSummary(played), queue: queueSummary(), playback: appState.playback });
      res.json({ ok: true, action: resultAction, queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, player: appState.player, nowPlaying: appState.nowPlaying });
    }
    });
  });

  app.post("/api/player/previous", async (req, res) => {
    if (rejectUnexpectedTransportBody(req, res)) return;
    return withTransportLock(res, async () => {
    try {
      const playerId = await hotPlayerId(lms);
      logEvent("transport.previous.request", { queue: queueSummary(), playback: appState.playback, nowPlaying: trackSummary(appState.nowPlaying) });
      const current = appState.nowPlaying;
      const hasRealTrack = Boolean(current && current.id !== "idle");
      const isPlaying = appState.player.mode === "play";
      const elapsed = Number(current?.elapsed) || 0;
      const previous = peekPreviousTrackForCurrent(current);
      // "Back" behaviour: if there's a previous track in history, step to it
      // (existing behaviour). Otherwise — a fresh track with nothing before it —
      // restart the current track from 0 instead of doing nothing.
      void elapsed;
      const shouldRestart = hasRealTrack && isPlaying && !previous;
      let resultAction = "noop";

      if (shouldRestart) {
        recordListeningReplay(taste, current, "transport.previous.restart");
        await lms.control(playerId, "seek", 0);
        updateNowPlaying({ elapsed: 0 });
        markPendingSeek(0, true);
        setMode("play");
        pruneStalePreviousSelfEntries(current);
        resultAction = "restart";
      } else if (previous) {
        const currentBeforePrevious = appState.nowPlaying;
        recordListeningSkip(taste, currentBeforePrevious, "transport.previous");
        await lms.playTrack(playerId, previous, "play-now");
        popPreviousTrackForCurrent(currentBeforePrevious);
        removeQueuedPlaybackMatch(previous);
        restoreCurrentTrackAfterPrevious(currentBeforePrevious);
        updatePlayback({ appManagedPlayback: true });
        setMode("play");
        markPendingPlayback(previous);
        updateNowPlaying(optimisticTrack(previous));
        resultAction = "app-previous";
      } else {
        pruneStalePreviousSelfEntries(appState.nowPlaying);
        logEvent("transport.previous.noop", { reason: appState.player.mode === "stop" ? "stopped" : "empty-app-history", queue: queueSummary(), nowPlaying: trackSummary(appState.nowPlaying) });
      }
      if (resultAction !== "noop" && !process.env.VITEST) {
        const refreshTimer = setTimeout(() => {
          refreshLms(lms, { force: true, taste }).catch(() => null);
        }, 0);
        refreshTimer.unref?.();
      }
      logEvent("transport.previous.result", { action: resultAction, previous: trackSummary(previous), queue: queueSummary(), playback: appState.playback, nowPlaying: trackSummary(appState.nowPlaying) });
      res.json({ ok: true, action: resultAction, mode: appState.player.mode, player: appState.player, nowPlaying: appState.nowPlaying, queue: appState.queue, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, player: appState.player, nowPlaying: appState.nowPlaying });
    }
    });
  });

  app.post("/api/player/volume", async (req, res) => {
    const parsed = volumeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid volume", issues: parsed.error.issues });
      return;
    }
    const previousVolume = appState.player.volume;
    const volume = setVolume(parsed.data.volume);
    try {
      await control(lms, "volume", volume);
      res.json({ ok: true, volume });
    } catch (error) {
      setVolume(previousVolume);
      res.status(502).json({ error: error.message, volume: previousVolume });
    }
  });

  app.post("/api/player/seek", async (req, res) => {
    const parsed = seekSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid seek position", issues: parsed.error.issues });
      return;
    }
    if (!appState.nowPlaying?.canSeek || appState.nowPlaying?.id === "idle") {
      res.status(409).json({ error: "No seekable track is playing", player: appState.player, nowPlaying: appState.nowPlaying });
      return;
    }
    const duration = Number(appState.nowPlaying.duration || 0);
    const seconds = Math.max(0, duration > 0 ? Math.min(parsed.data.seconds, duration) : parsed.data.seconds);
    const wasPlaying = appState.player.mode === "play";
    try {
      await control(lms, "seek", seconds);
      updateNowPlaying({ elapsed: seconds });
      markPendingSeek(seconds, wasPlaying);
      if (wasPlaying && appState.player.id) {
        try {
          await control(lms, "play");
        } catch (error) {
          res.status(502).json({ error: error.message, seconds, seekApplied: true, player: appState.player, nowPlaying: appState.nowPlaying });
          return;
        }
        setMode("play");
      }
      refreshLms(lms, { force: true, maintainPlayback: false, taste }).catch(() => null);
      res.json({ ok: true, seconds, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message, seconds, seekApplied: false, player: appState.player, nowPlaying: appState.nowPlaying });
    }
  });

  app.post("/api/player/playback", async (req, res) => {
    const clearEpochAtRequest = queueClearState.epoch;
    return withQueueMutationLock(async () => {
    const next = {};
    try {
      const parsed = playbackSchema.safeParse(req.body || {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid playback settings", issues: parsed.error.issues });
        return;
      }
      if (!publicRequestsOpen()) {
        res.status(403).json({ error: publicRequestsClosedMessage(), playback: appState.playback, queue: appState.queue });
        return;
      }
      const body = parsed.data;
      const playerId = await hotPlayerId(lms);
      logEvent("playback.request", { body, before: appState.playback, queue: queueSummary() });
      const sourceChanged =
        body.smartShuffleSource &&
        body.smartShuffleSource !== appState.playback.smartShuffleSource;
      const shuffleChanged = typeof body.shuffle === "boolean" && body.shuffle !== appState.playback.shuffle;
      const smartQueueChanged = typeof body.smartQueue === "boolean" && body.smartQueue !== appState.playback.smartQueue;
      if (typeof body.shuffle === "boolean") {
        next.shuffle = body.shuffle;
        if (body.shuffle) next.smartQueue = false;
        if (!body.shuffle) next.manualShuffle = false;
      }
      if (typeof body.smartQueue === "boolean") {
        next.smartQueue = body.smartQueue;
        if (body.smartQueue) {
          next.shuffle = false;
          next.manualShuffle = false;
        }
      }
      if (body.repeat) {
        next.repeat = body.repeat;
      }
      if (body.smartShuffleSource) {
        next.smartShuffleSource = body.smartShuffleSource;
      }
      if (smartQueueChanged && body.smartQueue === true && manualQueueCount() > 0) {
        res.status(409).json({
          error: "Smart shuffle is disabled while requested songs are queued. Clear the queue before starting generated smart shuffle.",
          playback: appState.playback,
          queue: appState.queue
        });
        return;
      }
      const finalShuffle = typeof next.shuffle === "boolean" ? next.shuffle : appState.playback.shuffle;
      const finalSmartQueue = typeof next.smartQueue === "boolean" ? next.smartQueue : appState.playback.smartQueue;
      const manualQueuePresent = manualQueueCount() > 0;
      const finalManualShuffle = finalShuffle && !finalSmartQueue && (
        (shuffleChanged || smartQueueChanged)
          ? manualQueuePresent
          : Boolean(next.manualShuffle ?? appState.playback.manualShuffle)
      );
      const sourceChangesGeneratedQueue = Boolean(sourceChanged && (finalSmartQueue || (finalShuffle && !finalManualShuffle)));
      const queueModeChanged = shuffleChanged || smartQueueChanged || sourceChangesGeneratedQueue;
      const queueModeForcesRepeatOff = (finalShuffle || finalSmartQueue) && (queueModeChanged || Boolean(body.repeat));
      if (queueModeForcesRepeatOff) {
        next.repeat = "off";
      }
      if ((shuffleChanged || smartQueueChanged) && !finalShuffle && !finalSmartQueue) {
        next.lastShuffleRefillAt = 0;
        next.lastShuffleSeed = "";
        next.lastSmartQueueBase = "";
        next.history = [];
      }
      if (sourceChangesGeneratedQueue) {
        next.lastShuffleRefillAt = 0;
        next.lastSmartQueueBase = "";
        next.history = [];
      }
      const requestedSource = next.smartShuffleSource || appState.playback.smartShuffleSource;
      if (finalManualShuffle) next.manualShuffle = true;
      if (!finalShuffle || finalSmartQueue) next.manualShuffle = false;
      const needsGeneratedQueue = finalSmartQueue || (finalShuffle && !finalManualShuffle && !manualQueuePresent);
      const spotifyGeneratedRequested =
        requestedSource === "spotify" &&
        needsGeneratedQueue &&
        (finalSmartQueue || finalShuffle);
      if (spotifyGeneratedRequested && !spotifyBrowsingAvailable()) {
        res.status(503).json({ error: spotifyUnavailableMessage(), playback: appState.playback, queue: appState.queue });
        return;
      }
      if (body.repeat && !queueModeForcesRepeatOff) {
        await lms.control(playerId, "repeat", body.repeat);
      }
      if (queueModeChanged) {
        await lms.control(playerId, "shuffle", false);
      }
      if (queueModeForcesRepeatOff) {
        await lms.control(playerId, "repeat", "off");
      }
      const generatedQueueRollback = sourceChanged && finalSmartQueue && appState.playback.smartQueue && generatedQueueCount() > 0
        ? { queue: appState.queue.map((item) => ({ ...item })), playback: { ...appState.playback } }
        : null;
      if (queueModeChanged && (next.smartQueue === false || next.shuffle === false || next.shuffle === true || sourceChanged)) {
        removeGeneratedQueueItems();
      }
      if (queueAddStaleAfterClear(clearEpochAtRequest)) {
        res.status(409).json({ error: "Queue was cleared while playback settings were pending", playback: appState.playback, queue: appState.queue, queued: [] });
        return;
      }
      updatePlayback(next);
      let queued = [];
      if (queueModeChanged && appState.playback.smartQueue) {
        queued = await activateGeneratedQueue(lms, playerId, { smart: true, mode: appState.playback.smartShuffleSource, controlsReady: true, taste });
        if (generatedQueueRollback && queued.length === 0) {
          appState.queue.splice(0, appState.queue.length, ...generatedQueueRollback.queue);
          updatePlayback(generatedQueueRollback.playback);
          res.status(409).json({
            error: `No ${requestedSource} smart shuffle tracks were found. Keeping the current generated queue.`,
            playback: appState.playback,
            queued: [],
            queue: appState.queue
          });
          return;
        }
      } else if (queueModeChanged && appState.playback.shuffle) {
        if (manualQueueCount() > 0) {
          shuffleVisibleQueue();
          updatePlayback({ manualShuffle: true });
          queued = [...appState.queue];
        } else if (!appState.playback.manualShuffle) {
          queued = await activateGeneratedQueue(lms, playerId, { shuffle: true, mode: appState.playback.smartShuffleSource, controlsReady: true, taste });
        }
      }
      if (queueAddStaleAfterClear(clearEpochAtRequest)) {
        stopGeneratedPlayback();
        res.status(409).json({ error: "Queue was cleared while playback settings were pending", playback: appState.playback, queue: appState.queue, queued: [] });
        return;
      }
      logEvent("playback.result", { after: appState.playback, queued: queued.map(trackSummary), queue: queueSummary() });
      res.json({ ok: true, playback: appState.playback, queued, queue: appState.queue });
    } catch (error) {
      res.status(502).json({ error: error.message, playback: appState.playback });
    }
    });
  });

  app.post("/api/player/smart-shuffle", async (req, res) => withQueueMutationLock(async () => {
    try {
      const parsed = smartShuffleSchema.safeParse(req.body || {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid smart shuffle request", issues: parsed.error.issues, queued: [], playback: appState.playback, queue: compactQueuePayload(appState.queue) });
        return;
      }
      if (!publicRequestsOpen()) {
        res.status(403).json({ error: publicRequestsClosedMessage(), queued: [], playback: appState.playback, queue: compactQueuePayload(appState.queue) });
        return;
      }
      if (manualQueueCount() > 0) {
        res.status(409).json({
          error: "Smart shuffle is disabled while requested songs are queued. Clear the queue before starting generated smart shuffle.",
          queued: [],
          playback: appState.playback,
          queue: appState.queue
        });
        return;
      }
      const status = await refreshLms(lms, { taste });
      const body = parsed.data;
      const mode = body.source || appState.playback.smartShuffleSource;
      if (mode === "spotify" && !spotifyBrowsingAvailable()) {
        res.status(503).json({ error: spotifyUnavailableMessage(), queued: [], playback: appState.playback, queue: compactQueuePayload(appState.queue) });
        return;
      }
      const count = body.count || 5;
      const seed = String(body.seed || appState.nowPlaying.artist || appState.nowPlaying.title || "").trim();
      logEvent("smart-shuffle.request", { mode, count, seed, queue: queueSummary() });
      const queued = await activateGeneratedQueue(lms, status.id, { smart: true, mode, count, seed, taste });
      await refreshLms(lms, { taste });
      logEvent("smart-shuffle.result", { queued: queued.map(trackSummary), queue: queueSummary(), playback: appState.playback });
      res.json({ ok: true, mode, seed, queued, queue: appState.queue, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, queued: [] });
    }
  }));

  // Lightweight session probe so the UI can detect an expired/restarted in-memory
  // admin session and return to the login screen instead of showing dead controls.
  app.get("/api/admin/session", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/admin/settings", requireAdmin, (req, res) => {
    const parsed = adminSettingsSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid admin settings", issues: parsed.error.issues });
      return;
    }
    appState.admin = sanitizeAdminSettings({ ...appState.admin, ...parsed.data });
    res.json(appState.admin);
  });

  // Queue the currently-playing track for background archival (independent of
  // playback — see archiveService.js).
  app.post("/api/archive", async (_req, res) => {
    try {
      const result = await enqueueNowPlaying(lms);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Queue an explicit track (e.g. from search results / a playlist).
  app.post("/api/archive/track", (req, res) => {
    try {
      const { uri, artist, title, album, art } = req.body || {};
      res.json(enqueueTrack({ uri, artist, title, album, art }));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Queue many tracks at once (whole playlist/album).
  app.post("/api/archive/tracks", (req, res) => {
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
    let queued = 0, skipped = 0;
    for (const t of tracks) {
      try {
        const r = enqueueTrack({ uri: t.uri, artist: t.artist, title: t.title, album: t.album, art: t.art });
        r.queued ? queued++ : skipped++;
      } catch { skipped++; }
    }
    res.json({ queued, skipped, total: tracks.length });
  });

  app.get("/api/archive/status", (_req, res) => {
    res.json(getQueueStatus());
  });

  // Local browser playback of a Spotify track: fetch (or reuse) a browser-playable
  // MP3 and serve it with range support so an <audio> element can play and seek it.
  // Independent of the Squeezebox/LMS path. (Distinct from /api/stream/:encodedPath,
  // which serves local library files.)
  app.get("/api/local-stream/:id", async (req, res) => {
    try {
      const file = await ensureStreamFile(String(req.query.uri || req.params.id));
      // dotfiles:"allow" — the cache lives under .stream-cache, which send() would
      // otherwise 404 as a dotfile path.
      res.sendFile(file, { dotfiles: "allow", headers: { "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" } });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.delete("/api/archive/queue/:id", (req, res) => {
    res.json(removeJob(String(req.params.id || "")));
  });

  app.get("/api/archive/file/:name", async (req, res) => {
    try {
      const archiveDir = resolveArchiveDir();
      // Resolve and confirm the requested file stays inside the archive dir
      // (reject path traversal like ../../etc/passwd or absolute paths).
      const requested = path.basename(String(req.params.name || ""));
      if (!requested.endsWith(".flac") || requested === "_current.flac") {
        res.status(400).json({ error: "Invalid file" });
        return;
      }
      // Resolve both sides to absolute so the containment check works regardless of
      // whether ARCHIVE_DIR is relative (the default "./archive") or absolute.
      const archiveRoot = path.resolve(archiveDir);
      const filePath = path.resolve(archiveRoot, requested);
      if (path.dirname(filePath) !== archiveRoot) {
        res.status(400).json({ error: "Invalid file" });
        return;
      }
      await fs.promises.access(filePath);
      res.download(filePath, requested);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  app.get("/api/archive", async (_req, res) => {
    try {
      const archiveDir = resolveArchiveDir();
      await fs.promises.mkdir(archiveDir, { recursive: true });
      const entries = await fs.promises.readdir(archiveDir);
      const files = await Promise.all(
        entries
          .filter((name) => name.endsWith(".flac") && name !== "_current.flac")
          .map(async (name) => {
            const filePath = path.join(archiveDir, name);
            const stat = await fs.promises.stat(filePath).catch(() => null);
            const { artist, title } = parseArchiveFilename(name);
            const stem = name.replace(/\.flac$/i, "");
            return {
              filename: name,
              artist,
              title,
              size: stat ? stat.size : null,
              addedAt: stat ? stat.mtime.toISOString() : null,
              art: hasArchiveCover(stem) ? `api/archive/cover/${encodeURIComponent(stem)}` : null
            };
          })
      );
      // Most-recently-added first.
      files.sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
      // `files` stays flat for back-compat; `groups` splits them by source
      // (Manual + each watched "archive*" playlist) for the grouped view.
      res.json({ files, groups: groupArchiveFiles(files), scan: getWatchStatus() });
    } catch (error) {
      res.status(500).json({ error: error.message, files: [] });
    }
  });

  // Trigger an immediate scan of the watched "archive*" playlists (the auto-archiver
  // also runs this on a timer). Returns how many new tracks were queued.
  app.post("/api/archive/scan", async (_req, res) => {
    try {
      const result = spotifyWebConfigured() ? await scanWatchedPlaylistsWebApi(lms) : await scanWatchedPlaylists(lms);
      res.json({ ok: true, ...result, scan: getWatchStatus() });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  // Serve a saved cover thumbnail for an archived track (by filename stem).
  // Read + send rather than res.sendFile — the covers live in a DOTFILE dir
  // (.covers), which sendFile 404s by default (same trap as .stream-cache).
  app.get("/api/archive/cover/:name", async (req, res) => {
    try {
      const buf = await fs.promises.readFile(archiveCoverFile(String(req.params.name || "")));
      res.type("image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(buf);
    } catch {
      res.status(404).json({ error: "No cover" });
    }
  });

  // Serve a tag's cached first song so the LMS can play it instantly over LAN HTTP.
  app.get("/api/tap-cache/file/:name", async (req, res) => {
    try {
      const file = tapCacheFilePath(String(req.params.name || ""));
      if (!file.endsWith(".flac")) { res.status(400).json({ error: "Invalid file" }); return; }
      await fs.promises.access(file);
      res.download(file, path.basename(file));
    } catch {
      res.status(404).json({ error: "Not cached" });
    }
  });

  // Fetch covers (via Spotify lookup) for archived files that don't have one yet.
  app.post("/api/archive/covers/backfill", async (_req, res) => {
    try {
      res.json({ ok: true, ...(await backfillArchiveCovers(lms)) });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  // --- Squeezebox Tap: admin binding API (gated) ---
  function tapUrlFor(req, tagId, token) {
    const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    const host = req.get("x-forwarded-host") || req.get("host") || "";
    const base = process.env.TAP_BASE_URL || (host ? `${proto}://${host}` : "");
    return `${base}/tap/t/${tagId}#k=${token}`;
  }

  app.post("/api/tap", requireTapAccess, (req, res) => {
    try {
      const body = req.body || {};
      const playSpec = buildPlaySpec(body);
      // A discover tag gets a dedicated auto-save playlist so every surprise it
      // surfaces lands in the Library. Caller may opt out with saveToLibrary:false.
      let savePlaylistId;
      if (playSpec.kind === "discover" && body.saveToLibrary !== false) {
        const base = body.display?.title || body.label || "Surprise";
        try { savePlaylistId = playlists.create({ name: `${base} — discoveries`, description: "Auto-saved from a Surprise tag.", createdBy: req.hlUser?.username || "tap" }).id; }
        catch { /* hit the playlist cap — bind the tag anyway, just without auto-save */ }
      }
      const tag = tapStore.create({ playSpec, display: body.display || {}, label: body.label || "", policy: body.policy, savePlaylistId });
      const token = tapStore.tokenFor(tag.tagId);
      logEvent("tap.bind", { tagId: tag.tagId, kind: playSpec.kind, source: playSpec.source });
      // Warm the instant-tap cache for this binding in the background.
      cacheTapTag(lms, tag, playlists).catch(() => {});
      res.json({ tag, token, tapUrl: tapUrlFor(req, tag.tagId, token), tapPath: `/tap/t/${tag.tagId}` });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/tap", requireTapAccess, (_req, res) => {
    const tags = tapStore.list().map((tag) => ({ ...tag, token: tapStore.tokenFor(tag.tagId) }));
    res.json({ tags });
  });

  // Ungated auth probe the Tap console calls on load to decide whether to show
  // the console or our hl-auth sign-in card. NOT a gate — it just reports state.
  app.get("/api/tap/session", async (req, res) => {
    let state = { authed: false, user: null };
    try {
      state = tapAuthState(await checkAccess(req, TAP_AUTH_PAGE));
    } catch {
      // auth service down → report not-authed; the console shows "sign in".
    }
    res.json({ ...state, loginUrl: AUTH_LOGIN_URL, logoutUrl: `${(process.env.AUTH_PUBLIC_BASE || "/auth").replace(/\/$/, "")}/logout` });
  });

  // Public, lightweight now-playing for the tapper's post-play "what's on" screen
  // and the console's "bind what's playing" — just the current track, no auth, no
  // heavy /api/state payload. Registered before /api/tap/:id so "now" isn't an id.
  app.get("/api/tap/now", async (_req, res) => {
    // Pull a FRESH now-playing (throttled): a tap plays directly on the LMS without
    // the app's poll, so appState.nowPlaying would otherwise stay on the previous
    // song and the tapper would show stale title/album/art.
    await refreshLms(lms, { minAgeMs: 1500, skipTrackInfo: true }).catch(() => {});
    const np = appState.nowPlaying || {};
    res.json({
      nowPlaying: {
        title: np.title, artist: np.artist, album: np.album, art: np.art ?? null,
        id: np.id, uri: np.uri, source: np.source, duration: np.duration, elapsed: np.elapsed
      },
      connected: Boolean(appState.player?.connected),
      name: appState.player?.name || "",
      volume: Number.isFinite(Number(appState.player?.volume)) ? Math.round(Number(appState.player.volume)) : null
    });
  });

  // --- Tap Library: app-managed playlists, SHARED with the main jukebox
  // (same playlists.json), but gated by the Tap's hl-auth so the console can
  // create/edit/link them. Registered before /api/tap/:id so "playlists" isn't an id.
  const playlistFail = (res, error) => res.status(error?.status || 400).json({ error: error?.message || "Playlist error" });

  app.get("/api/tap/playlists", requireTapAccess, (_req, res) => {
    res.json({ playlists: playlists.list() });
  });

  app.post("/api/tap/playlists", requireTapAccess, (req, res) => {
    try {
      const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
      const created = playlists.create({ name: req.body?.name, description: req.body?.description, createdBy: req.hlUser?.username || "tap" });
      // Optionally seed it with tracks in one shot (e.g. "save what's playing").
      if (tracks.length) { try { playlists.addTracks(created.id, tracks); } catch { /* skip bad seed */ } }
      res.json({ playlist: playlists.get(created.id) });
    } catch (error) { playlistFail(res, error); }
  });

  app.get("/api/tap/playlists/:id", requireTapAccess, (req, res) => {
    const pl = playlists.get(req.params.id);
    if (!pl) { res.status(404).json({ error: "Playlist not found" }); return; }
    res.json({ playlist: pl });
  });

  app.patch("/api/tap/playlists/:id", requireTapAccess, (req, res) => {
    try { res.json({ playlist: playlists.rename(req.params.id, { name: req.body?.name, description: req.body?.description }) }); }
    catch (error) { playlistFail(res, error); }
  });

  app.delete("/api/tap/playlists/:id", requireTapAccess, (req, res) => {
    try { playlists.remove(req.params.id); res.json({ ok: true }); }
    catch (error) { playlistFail(res, error); }
  });

  app.post("/api/tap/playlists/:id/tracks", requireTapAccess, (req, res) => {
    try {
      const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : req.body?.track ? [req.body.track] : [];
      res.json(playlists.addTracks(req.params.id, tracks));
    } catch (error) { playlistFail(res, error); }
  });

  app.delete("/api/tap/playlists/:id/tracks/:key", requireTapAccess, (req, res) => {
    // Express already decoded the param; re-decoding throws on a literal '%'. Lowercase
    // to match trackKey()'s normalized comparison.
    try { res.json({ playlist: playlists.removeTrack(req.params.id, String(req.params.key || "").toLowerCase()) }); }
    catch (error) { playlistFail(res, error); }
  });

  app.post("/api/tap/playlists/:id/tracks/move", requireTapAccess, (req, res) => {
    try { res.json({ playlist: playlists.moveTrack(req.params.id, req.body || {}) }); }
    catch (error) { playlistFail(res, error); }
  });

  // Registered BEFORE /api/tap/:id so "analytics"/"settings" aren't matched as ids.
  app.get("/api/tap/analytics", requireTapAccess, (_req, res) => {
    res.json(tapStore.analytics());
  });

  app.get("/api/tap/settings", requireTapAccess, (_req, res) => {
    res.json(tapStore.publicSettings());
  });

  app.post("/api/tap/settings", requireTapAccess, (req, res) => {
    res.json(tapStore.setSettings(req.body || {}));
  });

  app.get("/api/tap/export", requireTapAccess, (_req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="squeezebox-tap-backup.json"');
    res.json(tapStore.exportData());
  });

  app.post("/api/tap/import", requireTapAccess, (req, res) => {
    const body = req.body || {};
    res.json(tapStore.importData(body, { replace: body.replace === true }));
  });

  app.get("/api/tap/:id", requireTapAccess, (req, res) => {
    const tag = tapStore.get(req.params.id);
    if (!tag) {
      res.status(404).json({ error: "Tag not found" });
      return;
    }
    res.json({ tag, token: tapStore.tokenFor(tag.tagId), tapPath: `/tap/t/${tag.tagId}` });
  });

  app.put("/api/tap/:id", requireTapAccess, (req, res) => {
    if (!tapStore.get(req.params.id)) {
      res.status(404).json({ error: "Tag not found" });
      return;
    }
    try {
      const body = req.body || {};
      const patch = {};
      if (body.intent !== undefined) patch.playSpec = buildPlaySpec(body);
      if (body.display !== undefined) patch.display = body.display;
      if (body.label !== undefined) patch.label = body.label;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.policy !== undefined) patch.policy = body.policy;
      if (body.sun !== undefined) patch.sun = body.sun;
      if (body.savePlaylistId !== undefined) patch.savePlaylistId = body.savePlaylistId;
      const tag = tapStore.update(req.params.id, patch);
      logEvent("tap.repoint", { tagId: tag.tagId, kind: tag.playSpec?.kind });
      // If the target changed, drop the stale cached first song and re-warm.
      if (body.intent !== undefined) {
        dropTapCache(tag.tagId).then(() => cacheTapTag(lms, tag, playlists)).catch(() => {});
      }
      res.json({ tag, token: tapStore.tokenFor(tag.tagId) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/tap/:id", requireTapAccess, (req, res) => {
    if (!tapStore.remove(req.params.id)) {
      res.status(404).json({ error: "Tag not found" });
      return;
    }
    dropTapCache(req.params.id).catch(() => {});
    res.json({ ok: true });
  });

  // --- Squeezebox Tap: public resolver (open jukebox + signed-token handshake) ---
  function publicTapTag(tag) {
    return { tagId: tag.tagId, display: tag.display, tapCount: tag.tapCount, kind: tag.playSpec?.kind };
  }

  app.post("/api/tap/:id/play", async (req, res) => {
    const tagId = req.params.id;
    const token = (req.body && req.body.token) || req.get("x-tap-token") || "";
    const tag = tapStore.get(tagId);

    if (!tag) {
      logEvent("tap.play.fail", { tagId, reason: "unbound" });
      res.status(404).json({ ok: false, reason: "unbound", message: "This tag isn't set up yet." });
      return;
    }
    if (!tag.enabled) {
      res.status(409).json({ ok: false, reason: "disabled", message: "This tag is turned off." });
      return;
    }

    // Global gates (party-mode, optional password) are checked BEFORE the
    // per-tag auth so a missing password never burns a secure tag's one-time
    // SUN counter.
    const settings = tapStore.settings();
    if (settings.partyMode === "closed") {
      res.status(423).json({ ok: false, reason: "closed", message: "Tap is paused right now." });
      return;
    }
    // Optional password (off by default) — the one guard that also stops a
    // forwarded full URL from playing remotely. Configured in Tap settings;
    // falls back to the TAP_PASSWORD env if set and no runtime password is on.
    const requiredPassword = settings.requirePassword ? settings.password : process.env.TAP_PASSWORD || "";
    if (requiredPassword && req.get("x-tap-password") !== requiredPassword) {
      res.status(401).json({ ok: false, reason: "password", message: "A password is required to play this." });
      return;
    }

    // Auth: SECURE tags (NTAG 424 DNA SUN) verify a fresh per-tap CMAC + a
    // strictly-increasing counter — this is the only path that rejects a
    // forwarded/replayed URL. Other tags use the static signed token.
    if (tag.sun?.key) {
      const ctr = Number(req.body?.ctr ?? req.query?.ctr);
      const cmac = String(req.body?.cmac ?? req.query?.cmac ?? "");
      if (!Number.isInteger(ctr) || ctr <= (Number(tag.sun.lastCtr) || 0)) {
        logEvent("tap.play.fail", { tagId, reason: "replay" });
        res.status(409).json({ ok: false, reason: "replay", message: "This tap was already used — tap the tag again." });
        return;
      }
      if (!verifySun({ keyHex: tag.sun.key, tagId, ctr, cmacHex: cmac })) {
        logEvent("tap.play.fail", { tagId, reason: "bad_cmac" });
        res.status(401).json({ ok: false, reason: "bad-cmac", message: "This tap couldn't be verified." });
        return;
      }
      tapStore.bumpSunCounter(tagId, ctr);
    } else if (!tapStore.verify(tagId, token)) {
      logEvent("tap.play.fail", { tagId, reason: "bad_token" });
      res.status(401).json({ ok: false, reason: "bad-token", message: "This tap couldn't be verified." });
      return;
    }

    const debounceMs = Number.isFinite(settings.debounceMs) ? settings.debounceMs : TAP_DEBOUNCE_MS;
    const prior = tapPlayState.get(tagId);
    if (prior && Date.now() - prior.lastPlayedAt < debounceMs) {
      logEvent("tap.play.debounced", { tagId });
      res.json({ ok: true, debounced: true, tag: publicTapTag(tag), nowPlaying: appState.nowPlaying });
      return;
    }

    let playerId;
    try {
      playerId = await hotPlayerId(lms);
    } catch {
      logEvent("tap.play.fail", { tagId, reason: "speaker_offline" });
      res.status(503).json({ ok: false, reason: "speaker_offline", message: "The speaker's offline right now." });
      return;
    }

    try {
      // VISUAL TOGGLE TAG: never touches the Boom. It flips the VPS screen
      // between mirroring what's playing (synced + looped, length-matched) and
      // off — so it short-circuits before any of the audio/volume/cache logic.
      if (tag.playSpec?.kind === "visual") {
        const visual = await toggleVisualMode(lms, playerId);
        tapPlayState.set(tagId, { lastPlayedAt: Date.now() });
        const updated = tapStore.recordTap(tagId);
        logEvent("tap.play.ok", { tagId, kind: "visual", visualOn: visual.on });
        res.json({ ok: true, played: true, visual, tag: publicTapTag(updated) });
        return;
      }

      const policy = tag.policy || {};
      // Normalize loudness: a tag's own volume wins; otherwise fall back to the
      // global tap volume (default 75%) so taps don't blast or whisper at whatever
      // the speaker was left at. settings.tapVolume === null disables normalizing.
      const tapVolume = policy.volume !== null && policy.volume !== undefined
        ? policy.volume
        : settings.tapVolume;
      if (tapVolume !== null && tapVolume !== undefined) {
        await lms.control(playerId, "volume", tapVolume).catch(() => {});
      }

      // Smart resume — BOOKMARK the tag that was playing before this tap. If a
      // different resume-enabled tag held the speaker, save where it left off so
      // it can pick back up; switching away is exactly when "where I left off"
      // gets defined. Best-effort: a failed read must not block the new tap.
      if (activeResumeTagId && activeResumeTagId !== tagId) {
        const prevTag = tapStore.get(activeResumeTagId);
        if (prevTag?.policy?.resume) {
          try {
            const pos = await lms.playlistPosition(playerId);
            if (pos) tapStore.setResume(activeResumeTagId, pos);
          } catch { /* couldn't read position — leave the old bookmark */ }
        }
      }

      // Party queue (global): when on, every tap appends instead of replacing —
      // overrides each tag's own playMode. Resume-from-bookmark only applies when
      // we're actually taking over the speaker (replace), never when appending.
      const partyQueue = Boolean(settings.partyQueue);
      const isAlbum = tag.playSpec?.kind === "album-from-top" || tag.playSpec?.kind === "album-from-track";
      const resumeTo = !partyQueue && policy.resume && isAlbum && tag.resumeState ? tag.resumeState : null;
      const behavior = { ...policy, playMode: partyQueue ? "queue" : policy.playMode, resumeTo };

      // A tap is a DIRECT, forceful act on the speaker. Disengage the app's
      // smart-radio first so it stops managing (and overriding) the LMS playlist
      // — otherwise tap-queue/discover "defer to the squeezebox" and do nothing.
      stopGeneratedPlayback();

      // INSTANT TAP: if this tag's first song is cached locally, play it NOW from
      // disk (no librespot buffer) and stream the rest of the album behind it.
      // Replace-mode, non-resume, non-discover only. Falls through otherwise.
      const cachePlan = (!partyQueue && !resumeTo && tag.playSpec?.kind !== "discover") ? tapCachePlan(tagId) : null;
      if (cachePlan) {
        await lms.playTrack(playerId, { id: cachePlan.id, title: cachePlan.title, artist: cachePlan.artist }, "play-now");
        if (cachePlan.restUris.length) {
          // Append the rest in the background so the tap responds instantly; they
          // buffer while the local first track plays.
          (async () => { for (const uri of cachePlan.restUris) await lms.playTrack(playerId, { uri }, "add-queue").catch(() => {}); })();
        }
      } else if (tag.playSpec?.kind === "discover") {
        // Lazily give an older Surprise tag (bound before auto-save existed) its
        // dedicated playlist on first tap, so it starts collecting discoveries too.
        let savePlaylistId = tag.savePlaylistId;
        if (!savePlaylistId && playlists) {
          try {
            const base = tag.display?.title || tag.label || "Surprise";
            savePlaylistId = playlists.create({ name: `${base} — discoveries`, description: "Auto-saved from a Surprise tag.", createdBy: "tap" }).id;
            tapStore.update(tagId, { savePlaylistId });
          } catch { /* playlist cap — play without saving */ }
        }
        await playDiscoverTag(lms, playerId, tag.playSpec, { taste, queue: behavior.playMode === "queue", playlists, savePlaylistId });
      } else if (tag.playSpec?.kind === "library") {
        await playLibraryTag(lms, playerId, tag.playSpec, { playlists, queue: behavior.playMode === "queue" });
      } else {
        await playTapTarget(lms, playerId, tag.playSpec, behavior);
        // First tap of an uncached tag: warm the cache so next time is instant.
        if (!partyQueue && !resumeTo) cacheTapTag(lms, tag, playlists).catch(() => {});
      }

      // Screen video (optional, fire-and-forget): when the global switch is on,
      // also play a video on the VPS panel via screend — the tag's own URL if
      // set, else auto-find "<artist> <title> official video". The Boom owns
      // audio; the panel is muted. Never blocks or fails the tap.
      maybePlayTapVideo(tag, settings);

      // Track the resume "owner" of the speaker. A non-resume tag (or a queued
      // append, which doesn't take over) clears ownership.
      activeResumeTagId = !partyQueue && policy.resume && isAlbum ? tagId : null;

      // Refresh now-playing in the background so the tapper's poll reflects the NEW
      // song (the tap played directly on the LMS, bypassing the app's poll). A short
      // delay lets the LMS settle on the new track before we read it.
      setTimeout(() => { refreshLms(lms, { force: true, skipTrackInfo: true }).catch(() => {}); }, 600).unref?.();

      tapPlayState.set(tagId, { lastPlayedAt: Date.now() });
      const updated = tapStore.recordTap(tagId);
      logEvent("tap.play.ok", { tagId, kind: tag.playSpec?.kind });

      // Keep the Surprise pool warm in the background (only if a discover tag
      // exists) so the first Surprise tap of a session isn't the slow ~13s build.
      try {
        const tastePool = discoverPoolFor("");
        if (tag.playSpec?.kind !== "discover"
          && tastePool.tracks.length < 5 && !tastePool.building
          && (Date.now() - tastePool.at) > DISCOVER_POOL_TTL_MS
          && spotifyBrowsingAvailable()
          && tapStore.list().some((t) => t.playSpec?.kind === "discover")) {
          refillDiscoverPool(lms, playerId, "", taste);
        }
      } catch { /* pre-warm is best-effort */ }

      res.json({ ok: true, played: true, tag: publicTapTag(updated), nowPlaying: appState.nowPlaying });
    } catch (error) {
      // Log the internal detail server-side only — never echo LMS/socket/path
      // internals to a public tag caller.
      logEvent("tap.play.fail", { tagId, reason: "lms_error", error: error?.message });
      res.status(502).json({ ok: false, reason: "lms_error", message: "Couldn't start playback." });
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  return app;
}

async function hotPlayerId(lms) {
  // Only trust the cached id when it came from a genuinely-connected status that
  // is still fresh. Otherwise force a refresh first so a player that has been
  // idle/reconnecting gets re-checked (auto-wake) instead of failing on a stale flag.
  const fresh =
    appState.player.connected &&
    appState.player.id &&
    appState.player.id !== "mock-player" &&
    Date.now() - (refreshState.lastConnectedAt || 0) < playerStatusMaxAgeMs;
  if (fresh) return appState.player.id;
  await refreshLms(lms, { force: true, skipTrackInfo: true });
  if (!appState.player.connected || !appState.player.id || appState.player.id === "mock-player") {
    throw new Error("No LMS player connected");
  }
  return appState.player.id;
}

// Run an LMS-backed operation; on failure, force one reconnect refresh and retry
// once. Lets a transient hiccup (player just woke) self-heal instead of erroring.
async function withLmsRetry(lms, operation) {
  try {
    return await operation();
  } catch (error) {
    await refreshLms(lms, { force: true, skipTrackInfo: true }).catch(() => null);
    return await operation();
  }
}

async function withTransportLock(res, handler) {
  const previous = transportLockState.tail.catch(() => null);
  let release;
  transportLockState.tail = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    if (!res.headersSent) await withQueueMutationLock(handler);
  } finally {
    release();
  }
}

async function withQueueMutationLock(handler) {
  const previous = queueMutationLockState.tail.catch(() => null);
  let release;
  queueMutationLockState.tail = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await handler();
  } finally {
    release();
  }
}

function rejectUnexpectedTransportBody(req, res, detail = "Transport controls do not accept request body fields") {
  if (!hasUnexpectedBodyFields(req.body)) return false;
  res.status(400).json({ error: "Unexpected transport control body", detail });
  return true;
}

function hasUnexpectedBodyFields(body) {
  if (body === undefined || body === null) return false;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return false;
    try {
      return hasUnexpectedBodyFields(JSON.parse(trimmed));
    } catch {
      return true;
    }
  }
  if (typeof body !== "object" || Array.isArray(body)) return true;
  return Object.keys(body).length > 0;
}

function runPlaybackCommand(lms, playerId, track, action) {
  markPendingPlayback(track);
  lms.playTrack(playerId, track, action)
    .then(() => {
      logEvent("lms.playTrack.ok", { action, track: trackSummary(track), queue: queueSummary() });
      return refreshLms(lms, { force: true }).catch(() => null);
    })
    .catch((error) => {
      logEvent("lms.playTrack.error", { action, track: trackSummary(track), error: error.message });
      updatePlayerStatus({ ...appState.player, detail: `Playback command failed: ${error.message}` });
    });
}

function logEvent(type, data = {}) {
  const event = {
    at: new Date().toISOString(),
    type,
    data
  };
  debugLog.push(event);
  if (debugLog.length > debugLogLimit) debugLog.splice(0, debugLog.length - debugLogLimit);
  fs.promises.appendFile(debugLogPath, `${JSON.stringify(event)}\n`).catch(() => null);
}

function queueSummary() {
  return appState.queue.map((item, index) => ({
    index,
    id: item.id,
    title: item.title,
    artist: item.artist,
    requestedBy: item.requestedBy,
    uri: item.uri,
    path: item.path,
    etaMinutes: item.etaMinutes
  }));
}

function queueErrorPayload(error, extra = {}) {
  return {
    error,
    queue: compactQueuePayload(appState.queue),
    playback: appState.playback,
    ...extra
  };
}

function compactQueuePayload(queue = []) {
  return queue.map((item) => ({
    id: item.id,
    title: item.title,
    artist: item.artist,
    source: item.source,
    uri: item.uri,
    path: item.path,
    kind: item.kind,
    art: item.art,
    requestedBy: item.requestedBy,
    etaMinutes: item.etaMinutes
  }));
}

function trackSummary(track) {
  if (!track) return null;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    requestedBy: track.requestedBy,
    source: track.source,
    uri: track.uri,
    path: track.path,
    lmsTrackId: track.lmsTrackId
  };
}

function listeningCaptureContext(track, reason) {
  const playbackMode = appState.playback.smartQueue
    ? "smartQueue"
    : appState.playback.shuffle
      ? appState.playback.manualShuffle ? "manualShuffle" : "shuffle"
      : appState.playback.appManagedPlayback ? "appManaged" : "direct";
  return {
    listenerId: track?.requestedBy,
    requestedBy: track?.requestedBy,
    playbackMode,
    smartShuffleSource: appState.playback.smartShuffleSource,
    seed: appState.playback.lastShuffleSeed,
    generated: isGeneratedQueueItem(track),
    queueLength: appState.queue.length,
    reason,
    source: track?.source
  };
}

function observeListeningPlayback(taste, status, track, reason) {
  try {
    taste?.observePlayback?.({
      status,
      track,
      context: listeningCaptureContext(track, reason)
    });
  } catch (error) {
    logEvent("listening.capture-error", { reason, error: error.message, track: trackSummary(track) });
  }
}

function recordListeningSkip(taste, track, reason) {
  try {
    taste?.recordSkip?.(track, { reason, context: listeningCaptureContext(track, reason) });
  } catch (error) {
    logEvent("listening.capture-error", { reason, error: error.message, track: trackSummary(track) });
  }
}

function recordListeningReplay(taste, track, reason) {
  try {
    taste?.recordReplay?.(track, { reason, context: listeningCaptureContext(track, reason) });
  } catch (error) {
    logEvent("listening.capture-error", { reason, error: error.message, track: trackSummary(track) });
  }
}

async function rescanLibraryOnce() {
  if (!libraryRescanState.promise) {
    libraryRescanState.promise = (async () => {
      clearLibraryCaches();
      clearEnrichedLibraryResponseCache();
      const tracks = await scanLibrary(undefined, 5000, "all");
      return { trackCount: tracks.length, sample: tracks.slice(0, 5), status: appState.services.localLibrary };
    })().finally(() => {
      libraryRescanState.promise = null;
    });
  }
  return libraryRescanState.promise;
}

function optimisticTrack(track) {
  return {
    id: track.uri || track.path || track.lmsTrackId || track.id || `optimistic:${track.title}`,
    title: track.title || "Loading track",
    artist: track.artist || "Unknown artist",
    album: track.album || "",
    source: track.source || (track.uri ? "Spotify" : "LMS"),
    duration: Number(track.duration) || 0,
    elapsed: 0,
    canSeek: false,
    art: track.art || null,
    uri: track.uri,
    path: track.path,
    requestedBy: track.requestedBy,
    kind: track.kind,
    uploaded: track.uploaded,
    lmsTrackId: track.lmsTrackId
  };
}

function isPlayableTrackInput(track) {
  if (!track || typeof track !== "object") return false;
  if (String(track.id || "").startsWith("archive:")) return true;
  if (track.path || track.lmsTrackId) return true;
  if (!track.uri) return false;
  const kind = String(track.kind || "").toLowerCase();
  if (kind && kind !== "track") return false;
  return isValidSpotifyTrackUri(track.uri);
}

function isSpotifyTrackInput(track) {
  return Boolean(track?.uri && isValidSpotifyTrackUri(track.uri));
}

function isSpotifyQueueItem(track) {
  return Boolean(track?.uri && String(track.uri).toLowerCase().startsWith("spotify:"));
}

function hasQueueMetadataChange(existing, updates) {
  return ["title", "artist", "album"].some((key) => {
    if (updates[key] === undefined) return false;
    return String(updates[key] || "").trim() !== String(existing?.[key] || "").trim();
  });
}

function isValidSpotifyTrackUri(uri) {
  return /^(spotify:track:|spotify:\/\/track:)[A-Za-z0-9]{22}$/i.test(String(uri || ""));
}

function isSpotifyChildUriForKind(kind, uri) {
  const requestedKind = String(kind || "").toLowerCase();
  const value = String(uri || "").trim();
  if (requestedKind === "track") return isValidSpotifyTrackUri(value);
  if (!["playlist", "album", "artist"].includes(requestedKind)) return false;
  return new RegExp(`^spotify(?::|://)${requestedKind}:[A-Za-z0-9]+$`, "i").test(value);
}

function rememberKnownSpotifyTracks(tracks = []) {
  const expiresAt = Date.now() + knownSpotifyTrackTtlMs;
  for (const track of tracks || []) {
    const key = normalizedSpotifyTrackUri(track?.uri);
    if (key) knownSpotifyTracks.set(key, { track: canonicalSpotifyTrack(track), expiresAt });
  }
  if (knownSpotifyTracks.size > knownSpotifyTrackLimit) {
    for (const [key, entry] of knownSpotifyTracks) {
      if (entry.expiresAt <= Date.now() || knownSpotifyTracks.size > knownSpotifyTrackLimit) knownSpotifyTracks.delete(key);
    }
  }
}

function knownSpotifyTrack(uri) {
  const key = normalizedSpotifyTrackUri(uri);
  if (!key) return null;
  const entry = knownSpotifyTracks.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    knownSpotifyTracks.delete(key);
    return null;
  }
  return entry.track;
}

function isKnownSpotifyTrack(uri) {
  return Boolean(knownSpotifyTrack(uri));
}

function spotifyTracksAreKnown(tracks = []) {
  return (tracks || []).every((track) => !isSpotifyTrackInput(track) || isKnownSpotifyTrack(track.uri));
}

function canonicalizeSpotifyTracks(tracks = []) {
  return (tracks || []).map(canonicalizeSpotifyTrack);
}

function canonicalizeSpotifyTrack(track) {
  if (!isSpotifyTrackInput(track)) return track;
  const known = knownSpotifyTrack(track.uri);
  return known ? { ...known } : track;
}

function canonicalSpotifyTrack(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    source: track.source || "Spotify",
    uri: canonicalSpotifyUri(track.uri) || track.uri,
    art: track.art,
    kind: "track",
    duration: track.duration
  };
}

async function trackInputsExistOnDisk(tracks = []) {
  if (!strictPublicTrackValidation()) return true;
  for (const track of tracks || []) {
    if (!track?.path) continue;
    if (!(await safeMusicPath(track.path))) return false;
  }
  return true;
}

function strictPublicTrackValidation() {
  return process.env.STRICT_PUBLIC_TRACK_VALIDATION === "1" || process.env.NODE_ENV !== "test";
}

function normalizedSpotifyTrackUri(uri) {
  if (!isValidSpotifyTrackUri(uri)) return "";
  return String(uri).replace(/^spotify:\/\/track:/i, "spotify:track:").toLowerCase();
}

function canonicalSpotifyUri(uri) {
  if (!isValidSpotifyTrackUri(uri)) return "";
  return String(uri).replace(/^spotify:\/\/track:/i, "spotify:track:");
}

function queuedTrackInputExists(track) {
  const key = playableTrackInputKey(track);
  if (!key) return false;
  return appState.queue.some((item) => playableTrackInputKey(item) === key);
}

function uniquePlayableInputs(tracks) {
  const seen = new Set(appState.queue.map(playableTrackInputKey).filter(Boolean));
  const unique = [];
  for (const track of tracks) {
    const key = playableTrackInputKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
  }
  return unique;
}

function playableTrackInputKey(track) {
  if (!track || typeof track !== "object") return "";
  // Archived tracks are playable by id ("archive:<file>") with no uri/path, so key
  // them by that id — otherwise batch queueing drops them as keyless (de-dup miss).
  const id = String(track.id || "");
  const archiveKey = id.startsWith("archive:") ? id : "";
  return String(track.uri || track.path || track.lmsTrackId || archiveKey || "").trim().toLowerCase();
}

function publicRequestsOpen() {
  if (appState.admin.publicRequests === false) return false;
  if (appState.admin.scheduleEnabled && appState.schedule.current?.requestsPaused) return false;
  return true;
}

function shouldMaintainQueueOnPoll() {
  if (appState.playback.smartQueue) return true;
  if (appState.playback.shuffle && appState.queue.length > 0) return true;
  return Boolean(appState.playback.appManagedPlayback && appState.queue.length > 0);
}

function publicRequestsClosedMessage() {
  return appState.admin.publicRequests === false
    ? "Public requests are paused"
    : "Public requests are paused for the current schedule";
}

function markQueueManagedPlayback() {
  if (!isTrackInfoCandidate(appState.nowPlaying)) return;
  updatePlayback({ appManagedPlayback: true });
}

async function turnRepeatOffForVisibleQueue(lms, playerId = "") {
  if (appState.playback.repeat === "off") return;
  const targetPlayerId = playerId || await hotPlayerId(lms);
  await lms.control(targetPlayerId, "repeat", "off");
  updatePlayback({ repeat: "off" });
}

function restoreCurrentTrackAfterPrevious(track) {
  if (!appState.playback.appManagedPlayback) return null;
  if (!isRestorablePreviousTrack(track)) return null;
  const item = richRestorableTrack(track);
  if (queuedTrackInputExists(item)) return null;
  return addQueueItemNext({ ...item, requestedBy: item.requestedBy || "guest" });
}

function removeQueuedPlaybackMatch(track) {
  const item = appState.queue.find((candidate) => tracksSharePlaybackIdentity(candidate, track) || playableTrackInputKey(candidate) === playableTrackInputKey(track));
  if (!item) return null;
  return removeQueueItem(item.id);
}

function guestQueueLimit() {
  return guestQueueLimitFromValue(appState.admin.maxQueuePerUser);
}

function sanitizeAdminSettings(settings = appState.admin) {
  return {
    publicRequests: settings.publicRequests !== false,
    maxQueuePerUser: guestQueueLimitFromValue(settings.maxQueuePerUser),
    moderation: ["off", "basic", "strict"].includes(settings.moderation) ? settings.moderation : "basic",
    scheduleEnabled: settings.scheduleEnabled !== false
  };
}

function guestQueueLimitFromValue(value) {
  const limit = Number(value);
  const fallback = Number(config.publicQueueMaxPerUser);
  const resolved = Number.isFinite(limit) && limit > 0 ? limit : fallback;
  return Math.max(1, Math.min(25, Math.floor(resolved)));
}

function guestQueueCount() {
  return appState.queue.filter((item) => item.requestedBy === "guest").length;
}

function manualQueueCount() {
  return appState.queue.filter((item) => !isGeneratedQueueItem(item)).length;
}

function generatedQueueCount() {
  return appState.queue.filter(isGeneratedQueueItem).length;
}

function canQueueMoreGuestTracks(count = 1) {
  return guestQueueCount() + Math.max(1, Number(count) || 1) <= guestQueueLimit();
}

function queueLimitMessage() {
  return `Queue limit reached: max ${guestQueueLimit()} guest songs`;
}

function spotifyBrowsingAvailable() {
  return Boolean(appState.services.spotify.configured) && appState.services.spotify.reachable !== false;
}

function spotifyUnavailableMessage() {
  return appState.services.spotify.detail || "Spotify browsing is unavailable";
}

async function checkUrl(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return { reachable: response.ok || response.status < 500, status: response.status, url };
  } catch (error) {
    return { reachable: false, status: 0, url, detail: error.message };
  }
}

function parseLibrarySource(value) {
  const source = String(value || "all").toLowerCase();
  return ["all", "local", "uploaded"].includes(source) ? source : null;
}

function parseBoundedIntegerParam(value, { defaultValue, min, max }) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function parseByteRange(value, size) {
  const match = String(value || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!match || !Number.isFinite(size) || size <= 0) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    const length = Math.min(suffixLength, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

function requireAdmin(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Admin login required" });
    return;
  }
  if (!isValidAdminSession(match[1])) {
    res.status(403).json({ error: "Invalid admin token" });
    return;
  }
  next();
}

function applySecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", securityPolicy);
  if (isHttpsRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

function forceHttpsRedirect(req, res, next) {
  // Audio-fetch routes that LMS pulls over plain HTTP on the LAN must NOT be
  // redirected to https — LMS can't follow the TLS hop to this self-hosted port.
  // Browsers still reach these over https via the nginx proxy (x-forwarded-proto).
  if (
    req.path.startsWith("/api/archive/file/") ||
    req.path.startsWith("/api/tap-cache/file/") ||
    req.path.startsWith("/api/local-stream/") ||
    req.path.startsWith("/api/stream/")
  ) {
    next();
    return;
  }
  if (process.env.CLOUD_SQUEEZE_FORCE_HTTPS !== "1" || isHttpsRequest(req) || !["GET", "HEAD"].includes(req.method)) {
    next();
    return;
  }
  const host = req.get("host");
  if (!host) {
    next();
    return;
  }
  res.redirect(308, `https://${host}${req.originalUrl}`);
}

function isHttpsRequest(req) {
  return req.secure || String(req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase() === "https";
}

function adminLoginKey(req) {
  return req.ip || req.get("x-forwarded-for") || "unknown";
}

function isAdminLoginRateLimited(req) {
  const attempt = adminLoginAttempts.get(adminLoginKey(req));
  if (!attempt) return false;
  if (Date.now() - attempt.firstAt > adminLoginWindowMs) {
    adminLoginAttempts.delete(adminLoginKey(req));
    return false;
  }
  return attempt.count >= adminLoginMaxAttempts;
}

function recordAdminLoginFailure(req) {
  const key = adminLoginKey(req);
  const now = Date.now();
  const attempt = adminLoginAttempts.get(key);
  if (!attempt || now - attempt.firstAt > adminLoginWindowMs) {
    adminLoginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  attempt.count += 1;
}

function clearAdminLoginFailures(req) {
  adminLoginAttempts.delete(adminLoginKey(req));
}

function issueAdminSession(sessionTtlMs) {
  cleanupAdminSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + sessionTtlMs;
  adminSessions.set(hashHex(token), expiresAtMs);
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [tokenHash, expiresAtMs] of adminSessions) {
    if (expiresAtMs <= now) adminSessions.delete(tokenHash);
  }
}

function isValidAdminSession(token) {
  if (!token) return false;
  cleanupAdminSessions();
  const expiresAtMs = adminSessions.get(hashHex(token));
  return Boolean(expiresAtMs && expiresAtMs > Date.now());
}

function runPlaylistAction(res, action) {
  try {
    action();
  } catch (error) {
    if (error instanceof PlaylistError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Playlist operation failed" });
  }
}

function runCurationAction(res, action) {
  try {
    action();
  } catch (error) {
    if (error instanceof CurationError) {
      res.status(error.status).json({ error: error.message, curation: appState.curation });
      return;
    }
    res.status(500).json({ error: "Curation operation failed", curation: appState.curation });
  }
}

function filterHiddenResults(results, curation) {
  if (!Array.isArray(results) || results.length === 0) return [];
  return results.filter((track) => !curation.isHidden(track));
}

function groupSpotifyResults(results) {
  const groups = { tracks: [], artists: [], albums: [], playlists: [] };
  for (const item of Array.isArray(results) ? results : []) {
    const kind = String(item?.kind || "track").toLowerCase();
    if (kind === "artist") groups.artists.push(item);
    else if (kind === "album") groups.albums.push(item);
    else if (kind === "playlist") groups.playlists.push(item);
    else groups.tracks.push(item);
  }
  return groups;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function enrichLibraryArtwork(lms, tracks, { fallbackBudgetMs = localFallbackArtworkBudgetMs } = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks;
  const localEnriched = typeof lms.enrichLocalArtwork === "function"
    ? await withTimeout(lms.enrichLocalArtwork(tracks, { limit: localArtworkLimit, deadlineMs: Math.max(100, localArtworkBudgetMs - 50) }), localArtworkBudgetMs, tracks)
    : tracks;
  const grouped = inheritGroupedLocalArtwork(localEnriched);
  const localFallbackEnriched = await enrichMissingLocalArtwork(lms, grouped, { budgetMs: fallbackBudgetMs });
  return enrichUploadedArtwork(lms, inheritGroupedLocalArtwork(localFallbackEnriched));
}

async function enrichCollectionCovers(lms, collections) {
  if (!Array.isArray(collections) || collections.length === 0) return [];
  const coverTracks = collections.map((collection) => collection.coverTrack).filter(Boolean);
  const enriched = await enrichLibraryArtwork(lms, coverTracks);
  const coverArtByPath = new Map(enriched.map((track) => [track?.path, track?.art || track?.artwork || null]).filter(([path, art]) => path && art));
  return collections.map(({ coverTrack, ...collection }) => {
    const art = coverTrack?.art || coverTrack?.artwork || coverArtByPath.get(coverTrack?.path) || null;
    return art ? { ...collection, art } : collection;
  });
}

async function cachedEnrichedLibraryResults(key, loader) {
  const now = Date.now();
  const cached = enrichedLibraryResponseCache.get(key);
  if (cached?.results && cached.expiresAt > now) return structuredClone(cached.results);
  if (cached?.promise) return structuredClone(await cached.promise);
  const promise = Promise.resolve()
    .then(loader)
    .then((results) => {
      const safeResults = Array.isArray(results) ? results : [];
      enrichedLibraryResponseCache.set(key, {
        results: safeResults,
        expiresAt: Date.now() + enrichedLibraryResponseCacheTtlMs
      });
      pruneEnrichedLibraryResponseCache();
      return safeResults;
    })
    .catch((error) => {
      enrichedLibraryResponseCache.delete(key);
      throw error;
    });
  enrichedLibraryResponseCache.set(key, { promise, expiresAt: now + enrichedLibraryResponseCacheTtlMs });
  return structuredClone(await promise);
}

function enrichedLibraryResponseCacheKey(type, params = {}) {
  const stableParams = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
  return [
    type,
    config.musicSourceDir,
    config.uploadDir,
    stableParams
  ].join("|");
}

function clearEnrichedLibraryResponseCache() {
  enrichedLibraryResponseCache.clear();
}

function pruneEnrichedLibraryResponseCache() {
  if (enrichedLibraryResponseCache.size <= enrichedLibraryResponseCacheLimit) return;
  const now = Date.now();
  for (const [key, value] of enrichedLibraryResponseCache) {
    if (value.expiresAt <= now || enrichedLibraryResponseCache.size > enrichedLibraryResponseCacheLimit) {
      enrichedLibraryResponseCache.delete(key);
    }
    if (enrichedLibraryResponseCache.size <= enrichedLibraryResponseCacheLimit) break;
  }
}

export async function prewarmLibraryCaches(lms) {
  await scanLibrary(undefined, 5000, "all");
  const [compact, typedLocal] = await Promise.all([
    searchLibrary("", undefined, 20, "all"),
    searchLibrary("the", undefined, 200, "local")
  ]);
  await Promise.all([
    enrichLibraryArtwork(lms, compact).catch(() => null),
    enrichLibraryArtwork(lms, typedLocal).catch(() => null)
  ]);
}

export async function prewarmSpotifySearchCaches(lms) {
  const spotifyStatus = await lms.spotifyStatus().catch((error) => ({ configured: false, reachable: false, detail: error.message }));
  updateSpotifyStatus(spotifyStatus);
  if (!spotifyBrowsingAvailable()) return [];
  const playerId = await hotPlayerId(lms);
  if (!playerId) return [];
  return Promise.all(spotifySearchPrewarmTerms.map((term) => lms.spotifySearch(playerId, term, 50).catch(() => [])));
}

function inheritGroupedLocalArtwork(tracks) {
  const artByGroup = new Map();
  for (const track of tracks) {
    const key = localArtworkGroupKey(track);
    if (key && track?.art && !artByGroup.has(key)) artByGroup.set(key, track.art);
  }
  if (artByGroup.size === 0) return tracks;
  return tracks.map((track) => {
    if (track?.art || track?.uri) return track;
    const art = artByGroup.get(localArtworkGroupKey(track));
    return art ? { ...track, art } : track;
  });
}

function localArtworkGroupKey(track) {
  if (!track?.path || track?.uri) return "";
  const collection = String(track.collection || "").trim().toLowerCase();
  const folder = String(track.folder || "").trim().toLowerCase();
  const album = String(track.album || "").trim().toLowerCase();
  const artist = String(track.artist || "").trim().toLowerCase();
  const group = [collection, folder || album].filter(Boolean).join("|");
  if (group) return `group:${group}`;
  if (artist && album) return `album:${artist}|${album}`;
  return "";
}

async function enrichUploadedArtwork(lms, tracks) {
  const results = tracks.slice();
  const candidates = results
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track?.path && !track?.uri && !track?.art && (track.uploaded || track.source === "Uploaded"))
    .slice(0, Math.max(0, Number(uploadedArtworkLimit) || 0));
  if (candidates.length === 0) return results;

  return withTimeout(Promise.all(candidates.map(async ({ track, index }) => {
    const art = await fallbackArtworkForTrack(lms, track);
    if (art) results[index] = { ...track, art };
  })).then(() => results), uploadedArtworkBudgetMs, results);
}

async function enrichMissingLocalArtwork(lms, tracks, { budgetMs = localFallbackArtworkBudgetMs } = {}) {
  const results = tracks.slice();
  const candidates = results
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track?.path && !track?.uri && !track?.art && !(track.uploaded || track.source === "Uploaded"))
    .slice(0, Math.max(0, Number(localFallbackArtworkLimit) || 0));
  if (candidates.length === 0) return results;

  return withTimeout(Promise.all(candidates.map(async ({ track, index }) => {
    const art = await fallbackArtworkForTrack(lms, track);
    if (art) results[index] = { ...track, art };
  })).then(() => results), budgetMs, results);
}

async function fallbackArtworkForTrack(lms, track) {
  return firstResolvedArtwork([
    spotifyArtworkForTrack(lms, track),
    enrichTrackArtwork(track)
  ]);
}

function firstResolvedArtwork(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (pending === 0) {
      resolve(null);
      return;
    }
    for (const promise of promises) {
      Promise.resolve(promise)
        .then((art) => {
          if (art) resolve(art);
        })
        .catch(() => null)
        .finally(() => {
          pending -= 1;
          if (pending === 0) resolve(null);
        });
    }
  });
}

async function spotifyArtworkForTrack(lms, track) {
  if (!spotifyBrowsingAvailable() || typeof lms.spotifySearch !== "function") return null;
  const playerId = appState.player.id;
  if (!playerId || playerId === "mock-player") return null;
  const query = [track.artist, track.title].filter(Boolean).join(" ").trim();
  if (!query) return null;
  const matches = await lms.spotifySearch(playerId, query, 8);
  const exact = (matches || []).find((candidate) => candidate?.art && sameTitleArtist(candidate, track));
  return exact?.art || null;
}

async function refreshLms(lms, { maintainPlayback = false, minAgeMs = 0, force = false, skipTrackInfo = false, waitForFresh = true, queueAdvanceEpoch = visibleQueueCancelState.epoch, taste = null } = {}) {
  const now = Date.now();
  if (!force && refreshState.promise) return waitForFresh ? refreshState.promise : appState.player;
  if (!force && minAgeMs > 0 && now - refreshState.updatedAt < minAgeMs) return appState.player;
  refreshState.promise = (async () => {
    try {
      const shouldRefreshServices = force || now - refreshState.servicesAt > serviceRefreshMs;
      const [status, spotifyStatus] = await Promise.all([
        lms.status(),
        shouldRefreshServices
          ? lms.spotifyStatus().catch((error) => ({ configured: false, reachable: false, detail: error.message }))
          : Promise.resolve(null)
      ]);
      if (spotifyStatus) {
        updateSpotifyStatus(spotifyStatus);
        refreshState.servicesAt = Date.now();
      }
      updateStablePlayerStatus(status);
      if (status.connected) {
        const track = estimateContinuousElapsed(applyPendingSeek(await lms.nowPlaying(status.id)), status);
        observeListeningPlayback(taste, status, track, "poll");
        // A queued Surprise song that just started playing gets saved to its
        // Library playlist now (idempotent — addTracks dedups).
        flushDiscoverSaveForTrack(track);
        const key = trackKey(track);
        const trackInfoCandidate = isTrackInfoCandidate(track);
        const shouldRefreshTrackInfo =
          !skipTrackInfo &&
          trackInfoCandidate &&
          (key !== refreshState.trackKey || Date.now() - refreshState.trackInfoAt > trackInfoRefreshMs);
        const observedTrackChanged = rememberObservedTrackTransition(track);
        updateNowPlaying(preserveKnownNowPlayingMetadata(track));
        if (shouldRefreshTrackInfo) {
          refreshTrackInfoInBackground(track, key);
        }
        if (trackInfoCandidate) {
          prewarmShuffleCandidates(lms, status.id, track);
          prewarmSpotifyLibrary(lms, status.id);
        }
        if (maintainPlayback) await maintainVisiblePlaybackQueue(lms, status, track, { observedTrackChanged, queueAdvanceEpoch, taste });
        const waitingForVisibleQueueAdvance = appState.queue.length > 0;
        if (!trackInfoCandidate && appState.nowPlaying?.id === "idle" && !waitingForVisibleQueueAdvance) {
          const idlePlayback = { history: [], previousTracks: [], appManagedPlayback: false };
          if (appState.playback.manualShuffle) {
            idlePlayback.shuffle = false;
            idlePlayback.manualShuffle = false;
          }
          updatePlayback(idlePlayback);
          updateTrackInfo(idleTrackInfo);
        }
      }
      refreshState.updatedAt = Date.now();
      return appState.player;
    } catch (error) {
      updateStablePlayerStatus({ connected: false, online: false, detail: error.message });
      return appState.player;
    } finally {
      refreshState.promise = null;
    }
  })();
  return waitForFresh ? refreshState.promise : appState.player;
}

export async function refreshLmsForTests(lms, options) {
  return refreshLms(lms, options);
}

function refreshTrackInfoInBackground(track, key) {
  if (!key || refreshState.trackInfoPendingKey === key) return;
  refreshState.trackInfoAt = Date.now();
  refreshState.trackKey = key;
  refreshState.trackInfoPendingKey = key;
  refreshState.trackInfoPromise = withTimeout(enrichTrackInfo(track), trackInfoBudgetMs, null)
    .then((info) => {
      if (!info) return;
      if (info.art && trackKey(appState.nowPlaying) === key && !appState.nowPlaying.art) {
        updateNowPlaying({ art: info.art });
      }
      updateTrackInfo(info);
    })
    .finally(() => {
      if (refreshState.trackInfoPendingKey === key) refreshState.trackInfoPendingKey = "";
      refreshState.trackInfoPromise = null;
    });
}

function prewarmShuffleCandidates(lms, playerId, track) {
  if (!playerId || !spotifyBrowsingAvailable() || !track) return;
  if (!isTrackInfoCandidate(track)) return;
  const seed = String(track.artist || track.title || "").trim();
  const key = `${playerId}:${seed.toLowerCase()}`;
  if (!seed || (prewarmState.key === key && Date.now() - prewarmState.at < 45000)) return;
  prewarmState.key = key;
  prewarmState.at = Date.now();
  spotifyShuffleCandidates(lms, playerId, seed, 5).catch(() => null);
}

function prewarmSpotifyLibrary(lms, playerId) {
  if (!playerId || !spotifyBrowsingAvailable()) return;
  if (spotifyLibraryPrewarmState.playerId === playerId && Date.now() - spotifyLibraryPrewarmState.at < 90000) return;
  spotifyLibraryPrewarmState.playerId = playerId;
  spotifyLibraryPrewarmState.at = Date.now();
  (async () => {
    const [playlists, home, artists] = await Promise.all([
      lms.spotifyLibrary(playerId, "playlists", 80, 0).catch(() => []),
      lms.spotifyLibrary(playerId, "home", 80, 0).catch(() => []),
      lms.spotifyLibrary(playerId, "artists", 80, 0).catch(() => []),
      lms.spotifyLibrary(playerId, "tracks", 80, 0).catch(() => [])
    ]);
    const seenPlaylists = new Set();
    const playlistContainers = [...playlists, ...home]
      .filter((item) => item?.uri && item.kind === "playlist")
      .filter((item) => {
        const key = trackKey(item);
        if (!key || seenPlaylists.has(key)) return false;
        seenPlaylists.add(key);
        return true;
      })
      .slice(0, 3);
    const seenArtists = new Set();
    const artistContainers = artists
      .filter((item) => item?.uri && item.kind === "artist")
      .filter((item) => {
        const key = trackKey(item);
        if (!key || seenArtists.has(key)) return false;
        seenArtists.add(key);
        return true;
      })
      .slice(0, 3);
    await Promise.all([
      ...playlistContainers.map((item) => lms.spotifyChildren(
        playerId,
        { browseId: item.browseId, uri: item.uri, kind: "playlist", title: item.title },
        50,
        0
      ).catch(() => [])),
      ...artistContainers.map((item) => lms.spotifyChildren(
        playerId,
        { browseId: item.browseId, uri: item.uri, kind: "artist", title: item.title },
        20,
        0
      ).catch(() => [])),
      ...spotifySearchPrewarmTerms.map((term) => lms.spotifySearch(playerId, term, 50).catch(() => []))
    ]);
  })();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function updateStablePlayerStatus(status) {
  if (status.connected) {
    refreshState.lastConnectedAt = Date.now();
    refreshState.statusFailures = 0;
    updatePlayerStatus({ ...status, reconnecting: false });
    return;
  }
  // This poll came back "not connected". Because the link is normally steady,
  // treat the first few consecutive failures as a transient blip and HOLD the
  // last-known connected state — controls stay live instead of flickering off.
  refreshState.statusFailures = (refreshState.statusFailures || 0) + 1;
  const sinceConnected = Date.now() - (refreshState.lastConnectedAt || 0);
  const wasUsable = appState.player.connected && !appState.player.reconnecting;

  if (wasUsable && refreshState.statusFailures < playerStatusFailureThreshold && sinceConnected < playerReconnectGraceMs) {
    // Hold: leave appState.player untouched (still "connected") for the UI.
    return;
  }
  // Sustained loss but still within the grace window -> honest "reconnecting".
  if (refreshState.lastConnectedAt && sinceConnected < playerReconnectGraceMs) {
    updatePlayerStatus({
      ...appState.player,
      online: false,
      connected: false,
      reconnecting: true,
      detail: status.detail || "Reconnecting to the player..."
    });
    return;
  }
  // Grace elapsed -> genuinely offline.
  updatePlayerStatus({ ...status, reconnecting: false });
}

async function control(lms, action, value) {
  const modeMap = { play: "play", pause: "pause", stop: "stop", next: "play", previous: "play" };
  // Resolve a verified, awake player id first so transport controls (pause/stop/
  // volume/seek) don't silently fail against a stale id after the player has been idle.
  const playerId = await hotPlayerId(lms);
  await lms.control(playerId, action, value);
  if (modeMap[action]) setMode(modeMap[action]);
}

async function activateGeneratedQueue(lms, playerId, { smart = false, shuffle: shuffleOn = false, mode = appState.playback.smartShuffleSource, count = 5, seed, controlsReady = false, taste = defaultListenerTasteStore } = {}) {
  if (!playerId || (!smart && !shuffleOn)) return [];
  const currentSeed = isTrackInfoCandidate(appState.nowPlaying)
    ? (appState.nowPlaying.artist || appState.nowPlaying.title)
    : "";
  const hasFocusedSeed = Boolean(String(seed || currentSeed || appState.playback.lastShuffleSeed || "").trim());
  const queueSeed = String(seed || currentSeed || appState.playback.lastShuffleSeed || "drake").trim();
  const requestType = smart ? "smart shuffle" : "shuffle";
  const previousRequestType = appState.playback.smartQueue ? "smart shuffle" : appState.playback.shuffle ? "shuffle" : "";
  const history = previousRequestType === requestType && appState.playback.smartShuffleSource === mode && appState.playback.lastShuffleSeed === queueSeed
    ? appState.playback.history
    : [];
  if (!controlsReady) {
    await lms.control(playerId, "shuffle", false);
    await lms.control(playerId, "repeat", "off");
  }
  removeGeneratedQueueItems();
  updatePlayback({
    smartQueue: Boolean(smart),
    shuffle: Boolean(shuffleOn && !smart),
    manualShuffle: false,
    smartShuffleSource: mode,
    lastShuffleRefillAt: 0,
    lastShuffleSeed: queueSeed,
    lastSmartQueueBase: trackKey(appState.nowPlaying),
    history
  });
  const queued = await buildGeneratedQueue(lms, playerId, queueSeed, mode, count, requestType, { allowLocalWideFallback: !hasFocusedSeed, taste });
  updatePlayback(smart ? { lastShuffleRefillAt: Date.now(), repeat: "off" } : { lastShuffleRefillAt: Date.now() });
  logEvent("queue.activate-generated", { type: smart ? "smart shuffle" : "shuffle", mode, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

// The recommender (Spotty browse graph) takes ~10s+, so a cold discover tap used
// to hang. We keep a WARM pool per seed: serve a fresh slice instantly, then
// refill in the background so the next tap is also instant.
const discoverPools = new Map(); // seed -> { tracks: [], at: ms, building: bool }
const DISCOVER_POOL_TTL_MS = 15 * 60 * 1000;
const DISCOVER_POOL_TARGET = 15;

function discoverPoolFor(seed) {
  const key = seed || "__taste__";
  let pool = discoverPools.get(key);
  if (!pool) { pool = { tracks: [], at: 0, building: false }; discoverPools.set(key, pool); }
  return pool;
}

// Rebuild a seed's pool from the recommender (slow). Fire-and-forget friendly:
// guarded so only one build runs at a time; keeps the old pool on failure.
async function refillDiscoverPool(lms, playerId, seed, taste) {
  const pool = discoverPoolFor(seed);
  if (pool.building) return;
  pool.building = true;
  try {
    const candidates = await spotifyRecommenderCandidates(lms, playerId, seed, DISCOVER_POOL_TARGET, taste);
    const playable = (Array.isArray(candidates) ? candidates : []).filter(isPlayableSpotifyTrack);
    if (playable.length) { pool.tracks = playable; pool.at = Date.now(); }
  } catch { /* keep the existing pool */ }
  finally { pool.building = false; }
}

// Songs a Surprise tap QUEUED but that haven't played yet. A song is only added
// to the auto-save playlist once it actually STARTS playing (the user hears it),
// never just for being queued. Keyed by Spotify track id; bounded + best-effort.
const pendingDiscoverSaves = new Map(); // trackId -> { track, playlists, playlistId, at }
const PENDING_SAVE_TTL_MS = 60 * 60 * 1000;
const PENDING_SAVE_MAX = 80;

// The stable base62 Spotify id from either a track's uri (spotify:track:X) or its
// id (spotify://track:X), so a queued pick matches the same track when it plays.
function discoverTrackKey(track) {
  const m = String(track?.uri || track?.id || "").match(/track[:/]+([A-Za-z0-9]+)/i);
  return m ? m[1].toLowerCase() : "";
}

// Register songs to be saved WHEN they play (queued, not yet heard).
function queueDiscoverSaves(tracks, playlists, playlistId) {
  if (!playlists || !playlistId) return;
  const now = Date.now();
  for (const track of tracks) {
    const id = discoverTrackKey(track);
    if (id) pendingDiscoverSaves.set(id, { track, playlists, playlistId, at: now });
  }
  while (pendingDiscoverSaves.size > PENDING_SAVE_MAX) {
    pendingDiscoverSaves.delete(pendingDiscoverSaves.keys().next().value);
  }
}

// Called each poll with the now-playing track: if it's a pending save, it just
// started playing → add it to its playlist and stop tracking it. Prunes expired.
function flushDiscoverSaveForTrack(track) {
  if (pendingDiscoverSaves.size === 0) return;
  const now = Date.now();
  for (const [id, entry] of pendingDiscoverSaves) {
    if (now - entry.at > PENDING_SAVE_TTL_MS) pendingDiscoverSaves.delete(id);
  }
  const id = discoverTrackKey(track);
  if (!id) return;
  const entry = pendingDiscoverSaves.get(id);
  if (!entry) return;
  pendingDiscoverSaves.delete(id);
  try { entry.playlists.addTracks(entry.playlistId, [entry.track]); } catch { /* playlist gone */ }
}

// Resolve + play a "discover" tag: force a FRESH taste-seeded set straight onto
// the speaker — first track plays now, the rest are appended so the surprise
// keeps going. Serves from a warm pool for instant taps. It deliberately does
// NOT engage the app's smart-radio (that "defers" and overrides later taps).
async function playDiscoverTag(lms, playerId, playSpec, { taste = defaultListenerTasteStore, queue = false, playlists = null, savePlaylistId = "" } = {}) {
  if (!spotifyBrowsingAvailable()) {
    throw new Error("Spotify browsing is unavailable for discovery right now");
  }
  const seed = String(playSpec?.seed || "").trim();
  const pool = discoverPoolFor(seed);
  const warm = pool.tracks.length >= 2 && (Date.now() - pool.at) < DISCOVER_POOL_TTL_MS;
  if (!warm) {
    // Cold/stale: build now (the only slow tap; subsequent taps serve from pool).
    await refillDiscoverPool(lms, playerId, seed, taste);
  }
  if (pool.tracks.length === 0) {
    throw new Error("No discovery tracks were found");
  }
  // Pick a fresh shuffled slice and consume it so the next tap differs.
  const picks = shuffle([...pool.tracks]).slice(0, 5);
  const pickedKeys = new Set(picks.map(trackKey));
  pool.tracks = pool.tracks.filter((t) => !pickedKeys.has(trackKey(t)));
  // First pick: replace (force play now) unless party-queue is on (append).
  await lms.playTrack(playerId, picks[0], queue ? "add-queue" : "play-now");
  for (const track of picks.slice(1)) {
    await lms.playTrack(playerId, track, "add-queue").catch(() => {});
  }
  // Auto-save as songs PLAY, not when queued. In replace mode the first pick is
  // playing now → save it immediately; the rest are pending until they start. In
  // party-queue mode nothing plays now, so all picks are pending. They land in the
  // Library the moment each actually starts (see flushDiscoverSaveForTrack).
  if (playlists && savePlaylistId) {
    if (queue) {
      queueDiscoverSaves(picks, playlists, savePlaylistId);
    } else {
      try { playlists.addTracks(savePlaylistId, [picks[0]]); } catch { /* playlist gone */ }
      queueDiscoverSaves(picks.slice(1), playlists, savePlaylistId);
    }
  }
  // Refill in the background (don't await) so the next tap stays instant.
  if (pool.tracks.length < 5) refillDiscoverPool(lms, playerId, seed, taste);
  return { kind: "discover", queued: picks.length };
}

// Resolve + play a "library" tag: force the saved playlist's tracks onto the
// speaker (first plays now, the rest queue), directly — no app-radio deferral.
async function playLibraryTag(lms, playerId, playSpec, { playlists, queue = false } = {}) {
  const playlist = playlists?.get?.(playSpec?.playlistId);
  if (!playlist) throw new Error("That playlist no longer exists");
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (tracks.length === 0) throw new Error("That playlist is empty");
  await lms.playTrack(playerId, tracks[0], queue ? "add-queue" : "play-now");
  for (const track of tracks.slice(1)) {
    await lms.playTrack(playerId, track, "add-queue").catch(() => {});
  }
  return { kind: "library", queued: tracks.length };
}

async function buildGeneratedQueue(lms, playerId, seed, mode, count, requestedBy, { allowLocalWideFallback = true, taste = defaultListenerTasteStore } = {}) {
  if (!generatedRequestActive(requestedBy)) return [];
  const normalizedSeed = seed || "drake";
  const exclude = shuffleExclusionSet();
  const hardExclude = currentAndQueueExclusionSet();
  const [spotify, localFocused, localWide] = await Promise.all([
    mode !== "local" && spotifyBrowsingAvailable() ? spotifyRecommenderCandidates(lms, playerId, normalizedSeed, count, taste).catch(() => []) : [],
    mode !== "spotify" ? searchLibrary(normalizedSeed, undefined, 120).catch(() => []) : [],
    mode !== "spotify" ? searchLibrary("", undefined, 500).catch(() => []) : []
  ]);
  const spotifyTracks = uniqueTracks(spotify).filter(isPlayableSpotifyTrack);
  const localCandidates = mode === "local" && allowLocalWideFallback
    ? [...localFocused, ...shuffle(localWide).slice(0, 180)]
    : localFocused;
  const localTracks = uniqueTracks(localCandidates).filter((track) => track.path);
  const spotifyPool = preferFreshTracks(spotifyTracks, exclude, hardExclude);
  const localPool = shuffle(preferFreshTracks(localTracks, exclude, hardExclude));
  const picks = [];
  for (let index = 0; picks.length < count && (spotifyPool.length || localPool.length); index += 1) {
    const wantLocal = mode === "local" || (mode === "mixed" && Math.random() < 0.4);
    const pool = wantLocal ? localPool : spotifyPool;
    const fallbackPool = wantLocal ? spotifyPool : localPool;
    const pick = pool.shift() || fallbackPool.shift();
    if (pick && !picks.some((item) => trackKey(item) === trackKey(pick) || sameTitleArtist(item, pick))) picks.push(pick);
  }
  const enrichedPicks = await enrichGeneratedQueuePicks(lms, picks);
  const queued = [];
  for (const track of enrichedPicks) {
    if (!generatedRequestActive(requestedBy)) break;
    const item = addGeneratedQueueItem(track, mode, requestedBy);
    if (item) {
      queued.push(item);
      rememberShuffleTrack(track);
    }
  }
  return queued;
}

async function enrichGeneratedQueuePicks(lms, tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return tracks;
  const localIndexes = tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track?.path && !track?.uri && !track?.art);
  if (localIndexes.length === 0) return tracks;
  const enrichedLocal = await enrichLibraryArtwork(lms, localIndexes.map(({ track }) => track));
  const next = tracks.slice();
  localIndexes.forEach(({ index }, enrichedIndex) => {
    next[index] = enrichedLocal[enrichedIndex] || next[index];
  });
  return next;
}

async function spotifyShuffleCandidates(lms, playerId, seed, count = 5) {
  const currentTrackTerms = isTrackInfoCandidate(appState.nowPlaying)
    ? [appState.nowPlaying.artist, appState.nowPlaying.title]
    : [];
  const primaryTerms = [
    seed,
    ...currentTrackTerms,
    appState.playback.lastShuffleSeed
  ];
  const fallbackTerms = [
    "daily mix",
    "discover weekly",
    "radio",
    "drake",
    "juice wrld",
    "the weeknd",
    "travis scott",
    "phoebe bridgers"
  ];
  const primary = primaryTerms
    .map((term) => String(term || "").trim())
    .filter(Boolean);
  const terms = (primary.length > 0 ? primary : fallbackTerms)
    .map((term) => String(term || "").trim())
    .filter(Boolean);
  const selected = [...new Set(terms)].slice(0, 2);
  const batches = await Promise.all(selected.map((term) => lms.spotifySearch(playerId, term, Math.max(12, count * 4)).catch(() => [])));
  return batches.flat();
}

async function spotifyRecommenderCandidates(lms, playerId, seed, count = 5, taste = defaultListenerTasteStore) {
  const tasteState = taste?.getState?.() || {};
  const seedArtists = recommendationSeedArtists(tasteState, appState.nowPlaying, seed, 6);
  const candidateLimit = Math.max(40, count * 24);
  const graphCandidates = typeof lms.spotifyRecommendationCandidates === "function"
    ? await lms.spotifyRecommendationCandidates(playerId, seedArtists, {
      limit: candidateLimit,
      relatedArtistsPerSeed: 3,
      relatedTracksPerArtist: Math.max(12, count * 4),
      fallbackLimit: Math.max(20, count * 8)
    }).catch(() => [])
    : [];
  const fallbackCandidates = graphCandidates.length > 0
    ? []
    : await spotifyShuffleCandidates(lms, playerId, seed, Math.max(count, 8)).catch(() => []);
  const ranked = rankRecommendationCandidates(
    graphCandidates.length > 0 ? graphCandidates : fallbackCandidates,
    {
      tasteState,
      nowPlaying: appState.nowPlaying,
      queue: appState.queue,
      history: appState.playback.history,
      limit: Math.max(count * 4, 12)
    }
  );
  return ranked.length > 0 ? ranked : fallbackCandidates;
}

async function maintainSmartShuffle(lms, status, track, { observedTrackChanged = false, taste = defaultListenerTasteStore } = {}) {
  if (!appState.playback.shuffle || !status?.id) return;
  syncVisibleQueueWithCurrentTrack(track, { includeManual: observedTrackChanged });
  const needsPlaybackNudge = shouldNudgePlayback(status, track);
  const queued = await ensureSmartShuffleQueue(lms, status.id, { force: needsPlaybackNudge, taste });
  if (needsPlaybackNudge && queued.length > 0) {
    await playNextVisibleQueueItem(lms, status.id, { generatedOnly: true });
  }
}

async function maintainVisiblePlaybackQueue(lms, status, track, { observedTrackChanged = false, queueAdvanceEpoch = visibleQueueCancelState.epoch, taste = defaultListenerTasteStore } = {}) {
  if (!status?.id) return;
  syncVisibleQueueWithCurrentTrack(track, { includeManual: observedTrackChanged });
  if (appState.playback.smartQueue || appState.playback.shuffle) {
    try {
      await lms.control(status.id, "shuffle", false);
    } catch (error) {
      logEvent("queue.maintain-skip", { reason: "shuffle-control-failed", error: error.message, playback: appState.playback, queue: queueSummary() });
      return;
    }
  }
  clearManualShuffleWhenQueueExhausted();
  await topOffGeneratedQueue(lms, status.id, { taste });
  const needsPlaybackNudge = shouldNudgePlayback(status, track);
  const missedEndedTrack =
    (status.mode === "stop" || status.mode === "stopped") &&
    appState.playback.appManagedPlayback &&
    appState.queue.length > 0;
  if (needsPlaybackNudge && appState.queue.length > 0) {
    logEvent("queue.auto-advance", { reason: "near-track-end", queue: queueSummary(), nowPlaying: trackSummary(track) });
    await withQueueMutationLock(() => playNextVisibleQueueItem(lms, status.id, { generatedOnly: appState.playback.smartQueue, queueAdvanceEpoch }));
  } else if (missedEndedTrack) {
    logEvent("queue.auto-advance", { reason: "stopped-with-visible-queue", queue: queueSummary(), nowPlaying: trackSummary(track) });
    await withQueueMutationLock(() => playNextVisibleQueueItem(lms, status.id, { generatedOnly: appState.playback.smartQueue, queueAdvanceEpoch }));
  }
}

export async function maintainVisiblePlaybackQueueForTests(lms, status, track, options) {
  return maintainVisiblePlaybackQueue(lms, status, track, options);
}

async function ensureSmartShuffleQueue(lms, playerId, { force = false, taste = defaultListenerTasteStore } = {}) {
  if (!appState.playback.smartQueue || !playerId) return [];
  const now = Date.now();
  const requestType = "smart shuffle";
  const smartQueued = appState.queue.filter((item) => item.requestedBy === requestType).length;
  if (!force && smartQueued >= 4) return [];
  if (!force && now - Number(appState.playback.lastShuffleRefillAt || 0) < 12000) return [];
  const desired = force ? Math.max(3, 5 - smartQueued) : Math.max(1, 5 - smartQueued);
  const currentSeed = isTrackInfoCandidate(appState.nowPlaying)
    ? (appState.nowPlaying.artist || appState.nowPlaying.title)
    : "";
  const hasFocusedSeed = Boolean(String(currentSeed || appState.playback.lastShuffleSeed || "").trim());
  const seed = String(currentSeed || appState.playback.lastShuffleSeed || "drake").trim();
  const queued = await buildGeneratedQueue(lms, playerId, seed, appState.playback.smartShuffleSource, desired, requestType, { allowLocalWideFallback: !hasFocusedSeed, taste });
  if (!generatedRequestActive(requestType)) return queued;
  updatePlayback({ lastShuffleRefillAt: now, lastShuffleSeed: seed });
  if (queued.length > 0) logEvent("queue.refill", { requestType, desired, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

async function topOffGeneratedQueue(lms, playerId, { taste = defaultListenerTasteStore } = {}) {
  if ((!appState.playback.smartQueue && !appState.playback.shuffle) || !playerId) return [];
  const requestType = appState.playback.smartQueue ? "smart shuffle" : "shuffle";
  if (requestType === "shuffle" && appState.playback.manualShuffle) return [];
  if (requestType === "shuffle" && manualQueueCount() > 0) return [];
  const generatedCount = appState.queue.filter((item) => item.requestedBy === requestType).length;
  if (generatedCount >= 4) return [];
  updatePlayback({ lastShuffleRefillAt: 0 });
  logEvent("queue.top-off.request", { requestType, generatedCount, queue: queueSummary() });
  if (appState.playback.smartQueue) return ensureSmartShuffleQueue(lms, playerId, { force: true, taste });
  const desired = Math.max(1, 5 - generatedCount);
  const topOffSeed = appState.nowPlaying?.artist || appState.nowPlaying?.title || appState.playback.lastShuffleSeed;
  const hasFocusedSeed = Boolean(String(topOffSeed || "").trim());
  const seed = String(topOffSeed || "drake").trim();
  const queued = await buildGeneratedQueue(lms, playerId, seed, appState.playback.smartShuffleSource, desired, requestType, { allowLocalWideFallback: !hasFocusedSeed, taste });
  if (!generatedRequestActive(requestType)) return queued;
  updatePlayback({ lastShuffleRefillAt: Date.now(), lastShuffleSeed: seed });
  if (queued.length > 0) logEvent("queue.refill", { requestType, desired, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

function addGeneratedQueueItem(track, mode = appState.playback.smartShuffleSource, requestedBy = "shuffle") {
  if (!generatedRequestActive(requestedBy)) return null;
  if (!track?.title || queuedTrackExists(track)) return null;
  if (!trackMatchesShuffleSource(track, mode)) return null;
  return addQueueItem({ ...track, requestedBy });
}

function generatedRequestActive(requestedBy) {
  if (requestedBy === "smart shuffle") return Boolean(appState.playback.smartQueue);
  if (requestedBy === "shuffle") return Boolean(appState.playback.shuffle && !appState.playback.manualShuffle);
  return true;
}

async function playNextVisibleQueueItem(lms, playerId, { generatedOnly = false, queueAdvanceEpoch = null } = {}) {
  if (appState.playback.smartQueue || appState.playback.shuffle) {
    await lms.control(playerId, "shuffle", false);
  }
  const next = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (next) {
    if (visibleQueueAdvanceCanceled(queueAdvanceEpoch)) {
      logEvent("queue.next-canceled", { reason: "queue-changed", item: trackSummary(next), queue: queueSummary() });
      return null;
    }
    await turnRepeatOffForVisibleQueue(lms, playerId);
    if (visibleQueueAdvanceCanceled(queueAdvanceEpoch)) {
      logEvent("queue.next-canceled", { reason: "queue-changed-after-repeat", item: trackSummary(next), queue: queueSummary() });
      return null;
    }
    const played = await playQueuedItem(lms, playerId, next);
    scheduleGeneratedTopOff(lms, playerId, played);
    return played;
  }
  await topOffGeneratedQueue(lms, playerId);
  const refilled = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (refilled) {
    if (visibleQueueAdvanceCanceled(queueAdvanceEpoch)) {
      logEvent("queue.next-canceled", { reason: "queue-changed-after-refill", item: trackSummary(refilled), queue: queueSummary() });
      return null;
    }
    await turnRepeatOffForVisibleQueue(lms, playerId);
    if (visibleQueueAdvanceCanceled(queueAdvanceEpoch)) {
      logEvent("queue.next-canceled", { reason: "queue-changed-after-refill-repeat", item: trackSummary(refilled), queue: queueSummary() });
      return null;
    }
    return playQueuedItem(lms, playerId, refilled);
  }
  await ensureSmartShuffleQueue(lms, playerId, { force: true });
  const ensured = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (!ensured) {
    logEvent("queue.next-empty", { playback: appState.playback, queue: queueSummary() });
    return null;
  }
  if (visibleQueueAdvanceCanceled(queueAdvanceEpoch)) {
    logEvent("queue.next-canceled", { reason: "queue-changed-after-ensure", item: trackSummary(ensured), queue: queueSummary() });
    return null;
  }
  await turnRepeatOffForVisibleQueue(lms, playerId);
  if (visibleQueueAdvanceCanceled(queueAdvanceEpoch)) {
    logEvent("queue.next-canceled", { reason: "queue-changed-after-ensure-repeat", item: trackSummary(ensured), queue: queueSummary() });
    return null;
  }
  return playQueuedItem(lms, playerId, ensured);
}

function cancelPendingVisibleQueueAdvance() {
  visibleQueueCancelState.epoch += 1;
}

function markQueueCleared() {
  queueClearState.epoch += 1;
}

function queueAddStaleAfterClear(clearEpochAtRequest) {
  return queueClearState.epoch !== clearEpochAtRequest;
}

function visibleQueueAdvanceCanceled(queueAdvanceEpoch) {
  return queueAdvanceEpoch !== null && queueAdvanceEpoch !== visibleQueueCancelState.epoch;
}

function scheduleGeneratedTopOff(lms, playerId, played) {
  if (!isGeneratedQueueItem(played)) return;
  if (process.env.VITEST) return;
  const timer = setTimeout(() => {
    topOffGeneratedQueue(lms, playerId).catch(() => null);
  }, 0);
  timer.unref?.();
}

function isTrackInfoCandidate(track) {
  return Boolean(track?.title && track.id !== "idle" && track.title !== "No track playing");
}

function rememberObservedTrackTransition(track) {
  if (!isTrackInfoCandidate(track)) return false;
  const previousTrack = appState.nowPlaying;
  const previousKey = trackKey(previousTrack);
  const nextKey = trackKey(track);
  if (!previousKey || !nextKey || previousKey === nextKey) return false;
  if (sameContinuingPlayback(previousTrack, track)) return false;
  const pendingKey = refreshState.pendingPlaybackKey;
  if (pendingKey && Date.now() - refreshState.pendingPlaybackAt > 8000) {
    clearPendingPlayback();
  } else if (pendingKey && nextKey === pendingKey) {
    clearPendingPlayback();
  } else if (pendingKey && previousKey === pendingKey) {
    return false;
  }
  rememberPreviousTrack(appState.nowPlaying);
  return true;
}

export function sameContinuingPlayback(previousTrack, nextTrack) {
  if (!isTrackInfoCandidate(previousTrack) || !isTrackInfoCandidate(nextTrack)) return false;
  if (!sameTitleArtist(previousTrack, nextTrack)) return false;
  const previousElapsed = Number(previousTrack.elapsed);
  const nextElapsed = Number(nextTrack.elapsed);
  if (!Number.isFinite(previousElapsed) || !Number.isFinite(nextElapsed)) return true;
  return nextElapsed >= previousElapsed - 2;
}

function markPendingPlayback(track) {
  const key = trackKey(track);
  if (!key) return;
  refreshState.pendingPlaybackKey = key;
  refreshState.pendingPlaybackAt = Date.now();
}

function markPendingSeek(seconds, wasPlaying) {
  const key = trackKey(appState.nowPlaying);
  if (!key) return;
  refreshState.pendingSeekKey = key;
  refreshState.pendingSeekSeconds = seconds;
  refreshState.pendingSeekAt = Date.now();
  refreshState.pendingSeekWasPlaying = Boolean(wasPlaying);
}

function applyPendingSeek(track) {
  const pendingKey = refreshState.pendingSeekKey;
  if (!pendingKey) return track;
  const ageMs = Date.now() - refreshState.pendingSeekAt;
  const key = trackKey(track);
  if (ageMs > 2500 || key !== pendingKey) {
    clearPendingSeek();
    return track;
  }
  const expectedElapsed = refreshState.pendingSeekSeconds + (refreshState.pendingSeekWasPlaying ? ageMs / 1000 : 0);
  const observedElapsed = Number(track?.elapsed);
  if (Number.isFinite(observedElapsed) && Math.abs(observedElapsed - expectedElapsed) <= 1) {
    clearPendingSeek();
    return track;
  }
  return { ...track, elapsed: Math.max(0, expectedElapsed) };
}

function estimateContinuousElapsed(track, status) {
  const key = trackKey(track);
  const observedElapsed = Number(track?.elapsed);
  const duration = Number(track?.duration);
  const now = Date.now();
  if (status?.mode !== "play" || !key || !isTrackInfoCandidate(track) || !Number.isFinite(observedElapsed)) {
    clearElapsedEstimate();
    return track;
  }
  let elapsed = Math.max(0, observedElapsed);
  const ageMs = now - refreshState.elapsedAt;
  const hasObservedProgress = observedElapsed > 0 || (key === refreshState.elapsedTrackKey && refreshState.elapsedObserved > 0);
  if (
    hasObservedProgress &&
    key === refreshState.elapsedTrackKey &&
    refreshState.elapsedAt > 0 &&
    ageMs >= 500 &&
    elapsed <= refreshState.elapsedObserved + 0.35
  ) {
    const base = Math.max(refreshState.elapsedEstimate, elapsed);
    elapsed = base + Math.max(0, ageMs / 1000);
  }
  if (Number.isFinite(duration) && duration > 0) {
    elapsed = Math.min(duration, elapsed);
  }
  refreshState.elapsedTrackKey = key;
  refreshState.elapsedAt = now;
  refreshState.elapsedEstimate = elapsed;
  refreshState.elapsedObserved = Math.max(refreshState.elapsedObserved, Math.max(0, observedElapsed));
  return elapsed === observedElapsed ? track : { ...track, elapsed };
}

function clearElapsedEstimate() {
  refreshState.elapsedTrackKey = "";
  refreshState.elapsedAt = 0;
  refreshState.elapsedEstimate = 0;
  refreshState.elapsedObserved = 0;
}

function clearPendingSeek() {
  refreshState.pendingSeekKey = "";
  refreshState.pendingSeekSeconds = 0;
  refreshState.pendingSeekAt = 0;
  refreshState.pendingSeekWasPlaying = false;
}

function clearPendingPlayback() {
  refreshState.pendingPlaybackKey = "";
  refreshState.pendingPlaybackAt = 0;
}

export function nextQueueItemForPlayback(queue = appState.queue, { generatedOnly = false } = {}) {
  if (!generatedOnly) return queue[0] || null;
  return queue.find(isGeneratedQueueItem) || null;
}

async function playQueuedItem(lms, playerId, item) {
  const previousTrack = appState.nowPlaying;
  rememberPlaybackMetadata(item);
  await lms.playTrack(playerId, item, "play-now");
  rememberPreviousTrack(previousTrack);
  if (isGeneratedQueueItem(item)) rememberShuffleTrack(item);
  markPendingPlayback(item);
  removeQueueItem(item.id);
  clearManualShuffleWhenQueueExhausted();
  setMode("play");
  updatePlayback({ appManagedPlayback: true });
  updateNowPlaying(optimisticTrack(item));
  refreshPlayedTrackMetadataInBackground(lms, playerId, item);
  logEvent("queue.play-item", { item: trackSummary(item), queueAfterRemove: queueSummary(), playback: appState.playback });
  return item;
}

function clearManualShuffleWhenQueueExhausted() {
  if (!appState.playback.manualShuffle) return;
  if (manualQueueCount() > 0) return;
  updatePlayback({
    shuffle: false,
    manualShuffle: false,
    smartQueue: false,
    lastShuffleRefillAt: 0,
    lastShuffleSeed: "",
    lastSmartQueueBase: "",
    history: []
  });
}

function refreshPlayedTrackMetadataInBackground(lms, playerId, requestedTrack) {
  if (process.env.VITEST) return;
  const timer = setTimeout(() => {
    refreshPlayedTrackMetadata(lms, playerId, requestedTrack).catch(() => null);
  }, 0);
  timer.unref?.();
}

async function refreshPlayedTrackMetadata(lms, playerId, requestedTrack) {
  try {
    const fresh = await lms.nowPlaying(playerId);
    if (!fresh || !isTrackInfoCandidate(fresh)) return;
    if (trackKey(fresh) !== trackKey(requestedTrack) && !sameTitleArtist(fresh, requestedTrack)) return;
    updateNowPlaying(preserveKnownNowPlayingMetadata(fresh, requestedTrack));
  } catch {
    // Keep the optimistic selected track; the normal background refresh will try again.
  }
}

function preserveKnownNowPlayingMetadata(fresh, requestedTrack = null) {
  if (!fresh) return fresh;
  if (requestedTrack) rememberPlaybackMetadata(requestedTrack);
  const current = appState.nowPlaying;
  const known = requestedTrack || (tracksSharePlaybackIdentity(fresh, current) ? current : null) || lookupRecentPlaybackMetadata(fresh);
  if (!known || !tracksSharePlaybackIdentity(fresh, known)) return fresh;
  const art = fresh.art || known.art || null;
  if (!shouldPreserveKnownTrackMetadata(fresh, known, requestedTrack)) return preserveKnownPlaybackFields({ ...fresh, art }, known);
  const preserved = {
    ...fresh,
    title: known.title || fresh.title,
    artist: known.artist || fresh.artist,
    album: known.album || fresh.album,
    source: known.source || fresh.source,
    path: fresh.path || known.path,
    art
  };
  const enriched = preserveKnownPlaybackFields(preserved, known);
  rememberPlaybackMetadata(enriched);
  return enriched;
}

function preserveKnownPlaybackFields(track, known) {
  if (!known) return track;
  return {
    ...track,
    uri: track.uri || known.uri,
    path: track.path || known.path,
    lmsTrackId: track.lmsTrackId || known.lmsTrackId,
    kind: track.kind || known.kind,
    uploaded: track.uploaded ?? known.uploaded,
    requestedBy: track.requestedBy || known.requestedBy
  };
}

function shouldPreserveKnownTrackMetadata(fresh, known, requestedTrack = null) {
  if (tracksShareLocalFilePlaybackIdentity(fresh, known)) return true;
  if (requestedTrack && isPlayableSpotifyTrack(known)) return true;
  if (isPlayableSpotifyTrack(fresh) && isPlayableSpotifyTrack(known)) return true;
  return false;
}

function tracksShareLocalFilePlaybackIdentity(fresh, known) {
  const freshLocalKeys = new Set(playbackMetadataKeys(fresh).filter(isLocalFileTrackPath));
  return playbackMetadataKeys(known).filter(isLocalFileTrackPath).some((key) => freshLocalKeys.has(key));
}

function isLocalFileTrackPath(value) {
  const normalized = normalizeTrackKey(value);
  return Boolean(normalized && (normalized.includes("/music/") || normalized.startsWith("file:") || /^[a-z]:[\\/]/.test(normalized)));
}

function isUploadedTrackPath(value) {
  return normalizeTrackKey(value).includes("/music/uploads/");
}

function rememberPlaybackMetadata(track) {
  if (!isTrackInfoCandidate(track)) return;
  const keys = playbackMetadataKeys(track);
  if (keys.length === 0) return;
  const nextTrack = restorableTrack(track);
  const entry = { track: nextTrack, expiresAt: Date.now() + recentPlaybackMetadataTtlMs };
  for (const key of keys) {
    const existing = recentPlaybackMetadata.get(key);
    const trackToStore = existing && metadataQualityScore(existing.track) > metadataQualityScore(nextTrack)
      ? existing.track
      : nextTrack;
    recentPlaybackMetadata.set(key, { track: trackToStore, expiresAt: entry.expiresAt });
  }
  if (recentPlaybackMetadata.size > recentPlaybackMetadataLimit) {
    for (const [key, value] of recentPlaybackMetadata) {
      if (value.expiresAt <= Date.now() || recentPlaybackMetadata.size > recentPlaybackMetadataLimit) {
        recentPlaybackMetadata.delete(key);
      }
    }
  }
}

function lookupRecentPlaybackMetadata(track) {
  for (const key of playbackMetadataKeys(track)) {
    const entry = recentPlaybackMetadata.get(key);
    if (!entry) continue;
    if (entry.expiresAt <= Date.now()) {
      recentPlaybackMetadata.delete(key);
      continue;
    }
    return entry.track;
  }
  return null;
}

function getCachedProxyImage(url) {
  const entry = imageProxyCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    imageProxyCache.delete(url);
    return null;
  }
  return entry;
}

function setCachedProxyImage(url, contentType, bytes) {
  if (!url || !bytes?.length) return;
  imageProxyCache.set(url, { contentType, bytes, expiresAt: Date.now() + imageProxyCacheTtlMs });
  if (imageProxyCache.size <= imageProxyCacheLimit) return;
  for (const [key, value] of imageProxyCache) {
    if (value.expiresAt <= Date.now() || imageProxyCache.size > imageProxyCacheLimit) imageProxyCache.delete(key);
    if (imageProxyCache.size <= imageProxyCacheLimit) break;
  }
}

function tracksSharePlaybackIdentity(left, right) {
  if (!left || !right) return false;
  const leftKeys = new Set(playbackMetadataKeys(left));
  return playbackMetadataKeys(right).some((key) => leftKeys.has(key));
}

function playbackMetadataKeys(track) {
  return [
    track?.uri,
    track?.path,
    track?.lmsTrackId,
    track?.id
  ].map(normalizeTrackKey).filter(Boolean);
}

function metadataQualityScore(track) {
  if (!track) return 0;
  let score = 0;
  const title = String(track.title || "").trim();
  const artist = String(track.artist || "").trim();
  const album = String(track.album || "").trim();
  if (title) score += 4;
  if (artist && !/^uploaded$/i.test(artist)) score += 6;
  if (album && !/^uploads$/i.test(album)) score += 3;
  if (track.art) score += 8;
  if (track.duration) score += 1;
  if (isUploadedTrackPath(track.path) && title && artist && !/^uploaded$/i.test(artist)) score += 4;
  return score;
}

function removeGeneratedQueueItems() {
  for (const item of [...appState.queue]) {
    if (isGeneratedQueueItem(item)) removeQueueItem(item.id);
  }
}

function isGeneratedQueueItem(item) {
  return item?.requestedBy === "smart shuffle" || item?.requestedBy === "shuffle";
}

// Screen video for a tap (best-effort, via the host screend daemon). Only acts
// when the global screenVideo switch is on. A tag's policy.video can be a
// specific URL, "off" to opt out, or empty to auto-find the official video for
// its artist+title. Album/track tags carry both; generic tags (discover,
// playlist) have no good auto-query and are skipped unless given a URL.
// ---- Room LED strip follows the music (Tap lighting) ----
// On each track change the director resolves an AI routine for the song and pushes
// it to the device-hub → phone → BLE strip. A tapped tag may override the look
// (policy.lighting); the global on/off + brightness live in settings.lighting.
// Best-effort throughout — lighting must never disturb playback.
let activeTagLighting = null;
function maybePlayTapLighting(tag) {
  // Remember the tapped tag's lighting override; the post-tap refresh pushes it on
  // the resulting track change. { enabled:false } rests the strip for this tag.
  activeTagLighting = tag?.policy?.lighting || null;
}
function maybeLightingFollow(track) {
  try {
    const lighting = tapStore.settings()?.lighting;
    if (!lighting?.enabled) return;                                  // master off
    if (!track || track.id === "idle" || !track.title) { lightingOnIdle(lighting).catch(() => {}); return; }
    const policy = activeTagLighting;
    if (policy && policy.enabled === false) { lightingOnIdle(lighting).catch(() => {}); return; }  // tag opts out
    const t = { title: track.title, artist: track.artist, album: track.album, year: track.year, uri: track.url || track.id, id: track.id };
    const posMs = Math.max(0, Math.round((Number(track.elapsed) || 0) * 1000));
    lightingOnTrack(t, { posMs, settings: lighting, policy }).catch(() => {});
  } catch { /* lighting is best-effort */ }
}

function maybePlayTapVideo(tag, settings) {
  try {
    if (visualOn) return;            // visual watcher owns the screen — let it follow
    if (!settings?.screenVideo) return;
    const video = tag?.policy?.video;
    if (video === "off") return;
    if (typeof video === "string" && /^https?:\/\//i.test(video)) {
      playScreenVideo({ url: video }).catch(() => {});
      return;
    }
    const artist = tag?.display?.artist;
    const title = tag?.display?.title;
    if (artist && title) playScreenVideo({ query: `${artist} ${title} official video` }).catch(() => {});
  } catch { /* the screen is best-effort — never let it disturb a tap */ }
}

const visualTrackKeyOf = (np) => `${np?.title || ""}|${np?.artist || ""}`.trim().toLowerCase();

// One follow step. Reads what's on the Boom and keeps the screen matched to it:
//   - track changed (or forced)  -> load a fresh length-matched video, seeked to
//                                    the song's position, looping
//   - same track, play/pause flip -> mirror it (no reload)
//   - nothing playing             -> idle the panel but stay armed
// Best-effort throughout; returns a small summary for the tap response.
async function syncVisualNow(lms, { force = false } = {}) {
  if (!visualOn) return { mirroring: false };
  let playerId;
  try { playerId = await hotPlayerId(lms); } catch { return { mirroring: false, note: "no speaker" }; }
  let np = {};
  try { await refreshLms(lms, { force, minAgeMs: force ? 0 : 2000, skipTrackInfo: true }); np = appState.nowPlaying || {}; } catch { /* read what we can */ }
  let pos = null;
  try { pos = await lms.livePosition(playerId); } catch { /* couldn't read position */ }
  const mode = pos?.mode || "stop";
  const key = visualTrackKeyOf(np);

  // Same track still on — just keep play/pause in step, don't reload the video.
  if (!force && key && key === visualTrackKey) {
    if (mode !== visualMode) {
      visualMode = mode;
      if (mode === "pause") await pauseScreenVideo().catch(() => {});
      else if (mode === "play") await resumeScreenVideo().catch(() => {});
    }
    return { mirroring: true, title: np.title, artist: np.artist };
  }

  // Nothing meaningful to mirror — idle the panel but keep the watcher armed.
  // (Includes non-music audio like alarm tones, whose "title" is a bare URL.)
  const titleIsUrl = /^https?:\/\//i.test(np.title || "");
  if (!np.title || titleIsUrl || mode === "stop") {
    visualTrackKey = "";
    visualMode = mode;
    await stopScreenVideo().catch(() => {});
    return { mirroring: false, note: "nothing to mirror" };
  }

  // New song (or first sync) — match a fresh video to it and sync to its point.
  visualTrackKey = key;
  visualMode = mode;
  const seek = pos ? Math.max(0, Math.floor((pos.positionMs || 0) / 1000)) : 0;
  const duration = pos && pos.durationMs ? Math.round(pos.durationMs / 1000) : (Number(np.duration) || 0);
  const query = `${[np.artist, np.title].filter(Boolean).join(" ")} official video`;
  if (!visualOn) return { mirroring: false }; // turned off while we were resolving — don't load
  console.log(`[visual] following -> ${np.artist || "?"} - ${np.title} @${seek}s (${duration || "?"}s)`);
  await playScreenVideo({ query, matchDuration: duration || undefined, seek, loop: true }).catch(() => {});
  return { mirroring: true, title: np.title, artist: np.artist, seek, duration };
}

function startVisualWatcher(lms) {
  if (visualTimer) return;
  visualTimer = setInterval(() => {
    if (visualSyncing || !visualOn) return; // skip if a slow re-sync is still running
    visualSyncing = true;
    Promise.resolve(syncVisualNow(lms)).catch(() => {}).finally(() => { visualSyncing = false; });
  }, VISUAL_POLL_MS);
  visualTimer.unref?.();
}

function stopVisualWatcher() {
  if (visualTimer) { clearInterval(visualTimer); visualTimer = null; }
  visualTrackKey = "";
  visualMode = "";
}

// Visual toggle tag: an ON/OFF switch for the "mirror what's playing" mode. ON
// syncs the screen now and starts a watcher that follows every song change (and
// play/pause) until it's turned OFF. Plays NO audio — the Boom keeps the sound.
async function toggleVisualMode(lms, playerId) {
  visualOn = !visualOn;
  if (!visualOn) {
    stopVisualWatcher();
    await stopScreenVideo().catch(() => {});
    return { on: false };
  }
  const synced = await syncVisualNow(lms, { force: true }).catch(() => ({ mirroring: false }));
  startVisualWatcher(lms);
  return { on: true, ...synced };
}

function stopGeneratedPlayback() {
  if (!appState.playback.shuffle && !appState.playback.smartQueue) return;
  removeGeneratedQueueItems();
  updatePlayback({ shuffle: false, manualShuffle: false, smartQueue: false, lastShuffleRefillAt: 0, lastShuffleSeed: "", lastSmartQueueBase: "", history: [] });
}

function generatedShufflePlaybackActive() {
  return Boolean(appState.playback.smartQueue || (appState.playback.shuffle && !appState.playback.manualShuffle));
}

function shuffleVisibleQueue() {
  const manual = appState.queue.filter((item) => item.requestedBy !== "smart shuffle" && item.requestedBy !== "shuffle");
  const shuffled = shuffleChangedOrder(manual);
  appState.queue.splice(0, appState.queue.length, ...shuffled);
  appState.queue.forEach((item, index) => {
    item.etaMinutes = (index + 1) * 7;
  });
}

function trackMatchesShuffleSource(track, mode) {
  if (mode === "mixed") return true;
  if (mode === "spotify") return isPlayableSpotifyTrack(track);
  if (mode === "local") return Boolean(track?.path) && !track?.uri;
  return true;
}

function queuedTrackExists(track) {
  const key = trackKey(track);
  return appState.queue.some((item) => trackKey(item) === key);
}

export function syncVisibleQueueWithCurrentTrack(track, { includeManual = true } = {}) {
  if (!track) return;
  if (generatedShufflePlaybackActive()) rememberShuffleTrack(track);
  for (const item of [...appState.queue]) {
    if (!includeManual && !isGeneratedQueueItem(item)) continue;
    if (trackKey(item) === trackKey(track) || sameTitleArtist(item, track)) {
      removeQueueItem(item.id);
      return;
    }
  }
}

export function shouldNudgePlayback(status, track, playback = appState.playback) {
  if (playback.repeat === "one" && appState.queue.length === 0) return false;
  if (status.mode === "stop" || status.mode === "stopped") return false;
  if (status.mode === "pause") return false;
  const duration = Number(track?.duration || 0);
  const elapsed = Number(track?.elapsed || 0);
  return duration > 0 && elapsed >= duration - 2;
}

export function resetRefreshStateForTests() {
  refreshState.promise = null;
  refreshState.updatedAt = 0;
  refreshState.servicesAt = 0;
  refreshState.trackInfoAt = 0;
  refreshState.trackKey = "";
  refreshState.trackInfoPromise = null;
  refreshState.trackInfoPendingKey = "";
  prewarmState.key = "";
  prewarmState.at = 0;
  spotifyLibraryPrewarmState.playerId = "";
  spotifyLibraryPrewarmState.at = 0;
  recentPlaybackMetadata.clear();
  clearPendingPlayback();
  clearPendingSeek();
  clearElapsedEstimate();
}

function trackKey(track) {
  return normalizeTrackKey(track?.uri || track?.path || track?.lmsTrackId || track?.id || `${track?.title || ""}:${track?.artist || ""}`);
}

function normalizeTrackKey(value) {
  const raw = String(value || "");
  const localPath = decodedLocalTrackIdPath(raw);
  const filePath = decodedFileUriPath(raw);
  return (localPath || filePath || raw)
    .replace(/^spotify:\/\/(track|episode):/i, "spotify:$1:")
    .toLowerCase();
}

function decodedFileUriPath(value) {
  const raw = String(value || "");
  if (!/^file:\/\//i.test(raw)) return "";
  try {
    const url = new URL(raw);
    return decodeURIComponent(url.pathname || "");
  } catch {
    return "";
  }
}

function decodedLocalTrackIdPath(value) {
  const match = String(value || "").match(/^local:([A-Za-z0-9_-]+)$/);
  if (!match) return "";
  try {
    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function isPlayableSpotifyTrack(track) {
  return track?.uri && (!track.kind || track.kind === "track") && String(track.uri).includes(":track:");
}

function uniqueTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    const key = trackKey(track);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shuffleExclusionSet() {
  return new Set([
    trackKey(appState.nowPlaying),
    ...appState.queue.map(trackKey),
    ...(appState.playback.history || [])
  ].filter(Boolean));
}

function currentAndQueueExclusionSet() {
  return new Set([trackKey(appState.nowPlaying), ...appState.queue.map(trackKey)].filter(Boolean));
}

function preferFreshTracks(tracks, exclude, hardExclude) {
  const fresh = tracks.filter((track) => !exclude.has(trackKey(track)));
  if (fresh.length > 0) return fresh;
  return tracks.filter((track) => !hardExclude.has(trackKey(track)));
}

function rememberShuffleTrack(track) {
  if (!isTrackInfoCandidate(track)) return;
  const key = trackKey(track);
  if (!key) return;
  const history = [key, ...(appState.playback.history || []).filter((item) => item !== key)].slice(0, 80);
  updatePlayback({ history });
}

function rememberPreviousTrack(track) {
  if (!isRestorablePreviousTrack(track)) return;
  const key = trackKey(track);
  const previousTracks = [
    richRestorableTrack(track),
    ...(appState.playback.previousTracks || []).filter((item) => trackKey(item) !== key)
  ].slice(0, 20);
  updatePlayback({ previousTracks });
}

function popPreviousTrack() {
  const previousTracks = appState.playback.previousTracks || [];
  const [track, ...rest] = previousTracks;
  updatePlayback({ previousTracks: rest });
  return track || null;
}

function peekPreviousTrack() {
  return (appState.playback.previousTracks || [])[0] || null;
}

function peekPreviousTrackForCurrent(currentTrack = appState.nowPlaying) {
  return previousTrackIndexForCurrent(currentTrack).track;
}

function popPreviousTrackForCurrent(currentTrack = appState.nowPlaying) {
  const { index: nextIndex, staleIndexes } = previousTrackIndexForCurrent(currentTrack);
  const previousTracks = appState.playback.previousTracks || [];
  if (nextIndex < 0) return null;
  const previous = previousTracks[nextIndex];
  const staleSet = new Set(staleIndexes);
  const rest = previousTracks.filter((_, index) => index !== nextIndex && !staleSet.has(index));
  updatePlayback({ previousTracks: rest });
  return previous;
}

function pruneStalePreviousSelfEntries(currentTrack = appState.nowPlaying) {
  const { staleIndexes } = previousTrackIndexForCurrent(currentTrack);
  if (staleIndexes.length === 0) return;
  const staleSet = new Set(staleIndexes);
  updatePlayback({ previousTracks: (appState.playback.previousTracks || []).filter((_, index) => !staleSet.has(index)) });
}

function previousTrackIndexForCurrent(currentTrack = appState.nowPlaying) {
  const previousTracks = appState.playback.previousTracks || [];
  const currentKey = trackKey(currentTrack);
  const staleIndexes = [];
  const index = previousTracks.findIndex((track, trackIndex) => {
    const previousKey = trackKey(track);
    const sameCurrent =
      currentKey &&
      previousKey &&
      (previousKey === currentKey || tracksSharePlaybackIdentity(track, currentTrack));
    if (sameCurrent) {
      staleIndexes.push(trackIndex);
      return false;
    }
    return true;
  });
  return { index, track: index >= 0 ? previousTracks[index] : null, staleIndexes };
}

function isRestorablePreviousTrack(track) {
  return Boolean(track?.title && track.id !== "idle" && (track.path || decodedLocalTrackIdPath(track.id) || track.uri || track.lmsTrackId || spotifyTrackId(track)));
}

function restorableTrack(track) {
  const uri = track.uri || spotifyTrackId(track);
  const decodedPath = track.path || decodedLocalTrackIdPath(track.id);
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    source: track.source,
    duration: track.duration,
    art: track.art,
    uri,
    path: decodedPath,
    lmsTrackId: track.lmsTrackId,
    kind: track.kind,
    uploaded: track.uploaded,
    requestedBy: track.requestedBy
  };
}

function richRestorableTrack(track) {
  const restorable = restorableTrack(track);
  const known = lookupRecentPlaybackMetadata(restorable);
  if (!known || !tracksSharePlaybackIdentity(restorable, known)) return restorable;
  if (tracksHaveDifferentLocalFileIdentities(restorable, known)) return restorable;
  if (metadataQualityScore(known) < metadataQualityScore(restorable)) return restorable;
  return {
    ...restorable,
    ...known,
    duration: restorable.duration || known.duration,
    elapsed: restorable.elapsed,
    canSeek: restorable.canSeek
  };
}

function tracksHaveDifferentLocalFileIdentities(left, right) {
  const leftLocalKeys = playbackMetadataKeys(left).filter(isLocalFileTrackPath);
  const rightLocalKeys = playbackMetadataKeys(right).filter(isLocalFileTrackPath);
  if (leftLocalKeys.length === 0 || rightLocalKeys.length === 0) return false;
  const rightSet = new Set(rightLocalKeys);
  return !leftLocalKeys.some((key) => rightSet.has(key));
}

function spotifyTrackId(track) {
  const id = String(track?.id || "");
  const normalized = id.replace(/^spotify:\/\/track:/i, "spotify:track:");
  return /^spotify:track:[a-z0-9]+$/i.test(normalized) ? normalized : "";
}

function sameTitleArtist(left, right) {
  return (
    String(left?.title || "").trim().toLowerCase() === String(right?.title || "").trim().toLowerCase() &&
    String(left?.artist || "").trim().toLowerCase() === String(right?.artist || "").trim().toLowerCase()
  );
}

async function safeMusicPath(inputPath) {
  const resolved = path.resolve(String(inputPath || ""));
  if (!isStreamableAudio(resolved)) return null;
  const [target, roots] = await Promise.all([
    fs.promises.realpath(resolved).catch(() => null),
    Promise.all([config.musicSourceDir, config.uploadDir].map((root) => fs.promises.realpath(path.resolve(root)).catch(() => null)))
  ]);
  if (!target || !isStreamableAudio(target)) return null;
  const allowedRoot = roots
    .filter(Boolean)
    .some((root) => target === root || target.startsWith(`${root}${path.sep}`));
  if (!allowedRoot) return null;
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat?.isFile()) return null;
  return target;
}

function isStreamableAudio(filePath) {
  return [".mp3", ".flac", ".m4a", ".wav", ".ogg", ".aac"].includes(path.extname(filePath).toLowerCase());
}

function audioContentType(filePath) {
  const types = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac"
  };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function shuffleChangedOrder(items) {
  const shuffled = shuffle(items);
  if (items.length < 2) return shuffled;
  const changed = shuffled.some((item, index) => item !== items[index]);
  if (changed) return shuffled;
  return [shuffled.at(-1), ...shuffled.slice(0, -1)];
}

// ---------------------------------------------------------------------------
// Archive helpers (used by GET /api/archive)
// ---------------------------------------------------------------------------

function resolveArchiveDir() {
  const raw = process.env.ARCHIVE_DIR || "./archive";
  return raw
    .replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "")
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "")
    .replace(/\$HOME/g, process.env.HOME || process.env.USERPROFILE || "");
}

/**
 * Parses "Artist - Title.flac" into { artist, title }.
 * Falls back gracefully when the separator is absent.
 */
function parseArchiveFilename(name) {
  const base = name.replace(/\.flac$/i, "");
  const sepIdx = base.indexOf(" - ");
  if (sepIdx >= 0) {
    return { artist: base.slice(0, sepIdx).trim(), title: base.slice(sepIdx + 3).trim() };
  }
  return { artist: "", title: base.trim() };
}
