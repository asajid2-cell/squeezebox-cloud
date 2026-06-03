import express from "express";
import cors from "cors";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { LmsClient } from "./lmsClient.js";
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
import { enrichTrackInfo } from "./trackInfo.js";

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
  (value) => Boolean(value.path || value.lmsTrackId || value.uri),
  { message: "Playable local path, LMS track id, or Spotify URI is required" }
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

const volumeSchema = z.object({
  volume: z.number().finite().min(0).max(100)
}).strict();

const seekSchema = z.object({
  seconds: z.number().finite()
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

const loginSchema = z.object({
  password: z.string().min(1)
});

const adminSettingsSchema = z.object({
  publicRequests: z.boolean().optional(),
  maxQueuePerUser: z.number().int().min(1).max(25).optional(),
  moderation: z.enum(["off", "basic", "strict"]).optional(),
  scheduleEnabled: z.boolean().optional()
}).strict();

const adminPassword = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin";
const adminToken = process.env.CLOUD_SQUEEZE_ADMIN_TOKEN || "cloud-squeeze-admin";
const imageProxyMaxBytes = Number(process.env.IMAGE_PROXY_MAX_BYTES || 8 * 1024 * 1024);
const serviceRefreshMs = 60000;
const trackInfoRefreshMs = 30000;
const trackInfoBudgetMs = Number(process.env.TRACK_INFO_BUDGET_MS || 1800);
const localArtworkBudgetMs = Number(process.env.LOCAL_ARTWORK_BUDGET_MS || 700);
const localArtworkLimit = Number(process.env.LOCAL_ARTWORK_LIMIT || 40);
const spotifySearchPrewarmTerms = ["drake", "juice wrld", "the weeknd", "travis scott"];
const transportActionPaths = new Set([
  "/api/player/play",
  "/api/player/pause",
  "/api/player/stop",
  "/api/player/next",
  "/api/player/previous"
]);
const refreshState = {
  promise: null,
  updatedAt: 0,
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
  pendingSeekWasPlaying: false
};
const prewarmState = { key: "", at: 0 };
const spotifyLibraryPrewarmState = { playerId: "", at: 0 };
const libraryRescanState = { promise: null };
const transportLockState = { tail: Promise.resolve() };
const queueMutationLockState = { tail: Promise.resolve() };
const knownSpotifyTracks = new Map();
const knownSpotifyTrackTtlMs = 30 * 60 * 1000;
const knownSpotifyTrackLimit = 1500;
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

export function createApp({ lms = new LmsClient() } = {}) {
  const app = express();
  app.use(cors());
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
      if (appState.playback.smartQueue || appState.queue.length > 0) refreshLms(lms, { maintainPlayback: true }).catch(() => null);
    }, 8000);
    shuffleMonitor.unref?.();
    const startupRefresh = setTimeout(() => {
      refreshLms(lms, { force: true, skipTrackInfo: true }).catch(() => null);
    }, 250);
    startupRefresh.unref?.();
    const startupLibraryScan = setTimeout(() => {
      scanLibrary(undefined, 5000, "all").catch(() => null);
    }, 500);
    startupLibraryScan.unref?.();
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
      waitForFresh: !refreshState.updatedAt || !appState.player.connected
    });
    res.json(getPublicState());
  });

  app.get("/api/speaker/status", async (_req, res) => {
    const status = await refreshLms(lms, {
      minAgeMs: 1600,
      waitForFresh: !refreshState.updatedAt || !appState.player.connected
    });
    res.json(status);
  });

  app.get("/api/speaker/connect-guide", async (_req, res) => {
    const player = await refreshLms(lms);
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

  app.post("/api/queue", async (req, res) => withQueueMutationLock(async () => {
    const parsed = queueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue item", issues: parsed.error.issues });
      return;
    }
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue });
      return;
    }
    if (!canQueueMoreGuestTracks(1)) {
      res.status(429).json({ error: queueLimitMessage(), queue: appState.queue });
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
    if (!(await trackInputsExistOnDisk([parsed.data]))) {
      res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
      return;
    }
    if (queuedTrackInputExists(parsed.data)) {
      res.status(409).json({ error: "That song is already in the queue" });
      return;
    }
    res.status(201).json(addQueueItem({ ...parsed.data, requestedBy: "guest" }));
  }));

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

  app.delete("/api/queue", (_req, res) => withQueueMutationLock(async () => {
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue, playback: appState.playback });
      return;
    }
    const removed = [];
    for (const item of [...appState.queue]) {
      const removedItem = removeQueueItem(item.id);
      if (removedItem) removed.push(removedItem);
    }
    stopGeneratedPlayback();
    logEvent("queue.clear", { count: removed.length, playback: appState.playback });
    res.json({ ok: true, removed, queue: appState.queue, playback: appState.playback });
  }));

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

  app.post("/api/player/track", async (req, res) => withQueueMutationLock(async () => {
    const parsed = playbackTrackSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Track playback supports add-queue, play-next, or play-now", issues: parsed.error.issues, queue: appState.queue, playback: appState.playback });
      return;
    }
    const { action, track } = parsed.data;
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
    try {
      logEvent("track.request", { action, track: trackSummary(track), playerId: appState.player.id });
      let queued = null;
      if (action === "add-queue") {
        if (queuedTrackInputExists(track)) {
          res.status(409).json({ error: "That song is already in the queue", queue: appState.queue });
          return;
        }
        if (!canQueueMoreGuestTracks(1)) {
          res.status(429).json({ error: queueLimitMessage(), queue: appState.queue });
          return;
        }
        if (!(await trackInputsExistOnDisk([track]))) {
          res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
          return;
        }
        queued = addQueueItem({ ...track, requestedBy: "guest" });
        logEvent("queue.add", { action, queued: trackSummary(queued), queue: queueSummary() });
      } else if (action === "play-next") {
        if (queuedTrackInputExists(track)) {
          res.status(409).json({ error: "That song is already in the queue", queue: appState.queue });
          return;
        }
        if (!canQueueMoreGuestTracks(1)) {
          res.status(429).json({ error: queueLimitMessage(), queue: appState.queue });
          return;
        }
        if (!(await trackInputsExistOnDisk([track]))) {
          res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
          return;
        }
        queued = addQueueItemNext({ ...track, requestedBy: "guest" });
        logEvent("queue.add-next", { action, queued: trackSummary(queued), queue: queueSummary() });
      } else {
        if (!(await trackInputsExistOnDisk([track]))) {
          res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
          return;
        }
        const playerId = await hotPlayerId(lms);
        await lms.playTrack(playerId, track, "play-now");
        stopGeneratedPlayback();
        setMode("play");
        rememberPreviousTrack(appState.nowPlaying);
        updatePlayback({ appManagedPlayback: true });
        markPendingPlayback(track);
        const optimistic = optimisticTrack(track);
        updateNowPlaying(optimistic);
        await refreshPlayedTrackMetadata(lms, playerId, track);
        logEvent("track.play-now", { track: trackSummary(track), queue: queueSummary() });
        refreshLms(lms, { force: true }).catch(() => null);
      }
      res.json({ ok: true, action, queued, queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  }));

  app.post("/api/player/tracks", async (req, res) => withQueueMutationLock(async () => {
    const parsed = playbackTracksSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "At least one track is required" });
      return;
    }
    const { action, tracks } = parsed.data;
    if (!publicRequestsOpen()) {
      res.status(403).json({ error: publicRequestsClosedMessage(), queue: appState.queue });
      return;
    }

    const playable = tracks.filter(isPlayableTrackInput);
    if (playable.length === 0) {
      res.status(400).json({ error: "No playable tracks were provided" });
      return;
    }
    const uniquePlayable = uniquePlayableInputs(playable);
    if (uniquePlayable.length === 0) {
      res.status(409).json({ error: "Those songs are already in the queue", queue: appState.queue, accepted: 0, rejected: playable.length });
      return;
    }
    const availableSlots = Math.max(0, guestQueueLimit() - guestQueueCount());
    if (availableSlots <= 0) {
      res.status(429).json({ error: queueLimitMessage(), queue: appState.queue, accepted: 0, rejected: playable.length });
      return;
    }
    const acceptedPlayable = uniquePlayable.slice(0, availableSlots);
    if (!spotifyTracksAreKnown(acceptedPlayable)) {
      res.status(400).json({ error: "Spotify tracks must come from Cloud Squeeze search, playlist, or library results" });
      return;
    }
    if (!(await trackInputsExistOnDisk(acceptedPlayable))) {
      res.status(400).json({ error: "Local tracks must come from the Cloud Squeeze library or uploads" });
      return;
    }

    const queued = [];
    const ordered = action === "play-next" ? [...acceptedPlayable].reverse() : acceptedPlayable;
    for (const track of ordered) {
      const item = action === "play-next"
        ? addQueueItemNext({ ...track, requestedBy: "guest" })
        : addQueueItem({ ...track, requestedBy: "guest" });
      queued.push(item);
    }
    if (action === "play-next") queued.reverse();
    const rejected = Math.max(0, playable.length - queued.length);
    logEvent("queue.batch", { action, count: queued.length, requested: playable.length, deduped: uniquePlayable.length, rejected, queued: queued.map(trackSummary), queue: queueSummary() });
    res.json({ ok: true, action, queued, queue: appState.queue, accepted: queued.length, rejected });
  }));

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
    const results = await searchLibrary(String(req.query.q || ""), undefined, limit, source);
    res.json({ results: await enrichLibraryArtwork(lms, results) });
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
      const playerId = await hotPlayerId(lms);
      const results = await lms.spotifySearch(playerId, query, limit);
      rememberKnownSpotifyTracks(results);
      res.json({ results });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [] });
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
        results
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
      res.json({ results });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [] });
    }
  });

  app.get("/api/library/collections", async (_req, res) => {
    const source = parseLibrarySource(_req.query.source);
    if (!source) {
      res.status(400).json({ error: "Library source must be all, local, or uploaded" });
      return;
    }
    res.json({ collections: await getCollections(undefined, source) });
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
    const results = await getCollectionTracks({
      collection,
      folder,
      source,
      limit
    });
    res.json({ results: await enrichLibraryArtwork(lms, results) });
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
    if (!/^https?:\/\/(i\.scdn\.co|mosaic\.scdn\.co|image-cdn-[a-z]+\.spotifycdn\.com|pickasso\.spotifycdn\.com|is\d+-ssl\.mzstatic\.com|coverartarchive\.org)\//i.test(url)) {
      res.status(400).json({ error: "Unsupported image host" });
      return;
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) {
        res.status(response.status).json({ error: "Image unavailable" });
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
      res.type(contentType);
      res.set("Cache-Control", "public, max-age=86400");
      res.send(bytes);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post("/api/admin/login", (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.password !== adminPassword) {
      res.status(401).json({ error: "Invalid admin password" });
      return;
    }
    res.json({ token: adminToken });
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
        updatePlayback({ appManagedPlayback: false });
      }
      refreshLms(lms, { force: true }).catch(() => null);
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
      clearPendingPlayback();
      clearPendingSeek();
      updatePlayback({ appManagedPlayback: false });
      updateNowPlaying(idleNowPlaying);
      updateTrackInfo(idleTrackInfo);
      res.json({ ok: true, mode: appState.player.mode, player: appState.player });
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
      if (!played && !stoppedWithEmptyManualQueue && !emptyAppManagedQueue) {
        rememberPreviousTrack(appState.nowPlaying);
        await control(lms, "next");
      }
      if (!stoppedWithEmptyManualQueue && !emptyAppManagedQueue) refreshLms(lms, { force: true }).catch(() => null);
      const resultAction = played ? "visible-queue-next" : (stoppedWithEmptyManualQueue || emptyAppManagedQueue) ? "noop" : "next";
      logEvent("transport.next.result", { action: played ? "visible-queue-next" : (stoppedWithEmptyManualQueue || emptyAppManagedQueue) ? "noop" : "lms-next", played: trackSummary(played), queue: queueSummary(), playback: appState.playback });
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
      const previous = peekPreviousTrack();
      if (previous) {
        await lms.playTrack(playerId, previous, "play-now");
        popPreviousTrack();
        rememberPreviousTrack(appState.nowPlaying);
        updatePlayback({ appManagedPlayback: true });
        setMode("play");
        markPendingPlayback(previous);
        updateNowPlaying(optimisticTrack(previous));
      } else if (appState.player.mode === "stop" || appState.player.mode === "stopped") {
        logEvent("transport.previous.noop", { reason: "stopped", queue: queueSummary(), nowPlaying: trackSummary(appState.nowPlaying) });
      } else {
        logEvent("transport.previous.noop", { reason: "empty-app-history", queue: queueSummary(), nowPlaying: trackSummary(appState.nowPlaying) });
      }
      if (previous) refreshLms(lms, { force: true }).catch(() => null);
      const resultAction = previous ? "app-previous" : "noop";
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
      refreshLms(lms, { force: true }).catch(() => null);
      res.json({ ok: true, seconds, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message, seconds, seekApplied: false, player: appState.player, nowPlaying: appState.nowPlaying });
    }
  });

  app.post("/api/player/playback", async (req, res) => withQueueMutationLock(async () => {
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
      }
      if (typeof body.smartQueue === "boolean") {
        next.smartQueue = body.smartQueue;
        if (body.smartQueue) next.shuffle = false;
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
      if ((shuffleChanged || smartQueueChanged) && !finalShuffle && !finalSmartQueue) {
        next.lastShuffleRefillAt = 0;
        next.lastShuffleSeed = "";
        next.lastSmartQueueBase = "";
      }
      const requestedSource = next.smartShuffleSource || appState.playback.smartShuffleSource;
      const needsGeneratedQueue = finalSmartQueue || (finalShuffle && manualQueueCount() === 0);
      const spotifyGeneratedRequested =
        requestedSource === "spotify" &&
        needsGeneratedQueue &&
        (finalSmartQueue || finalShuffle);
      if (spotifyGeneratedRequested && !spotifyBrowsingAvailable()) {
        res.status(503).json({ error: spotifyUnavailableMessage(), playback: appState.playback, queue: appState.queue });
        return;
      }
      const queueModeChanged = sourceChanged || shuffleChanged || smartQueueChanged;
      if (body.repeat) {
        await lms.control(playerId, "repeat", body.repeat);
      }
      if (queueModeChanged) {
        await lms.control(playerId, "shuffle", false);
      }
      if (queueModeChanged && finalSmartQueue) {
        await lms.control(playerId, "repeat", "off");
      }
      if (queueModeChanged && (next.smartQueue === false || next.shuffle === false || next.shuffle === true || sourceChanged)) {
        removeGeneratedQueueItems();
      }
      updatePlayback(next);
      let queued = [];
      if (queueModeChanged && appState.playback.smartQueue) {
        queued = await activateGeneratedQueue(lms, playerId, { smart: true, mode: appState.playback.smartShuffleSource, controlsReady: true });
      } else if (queueModeChanged && appState.playback.shuffle) {
        if (manualQueueCount() > 0) {
          shuffleVisibleQueue();
        } else {
          queued = await activateGeneratedQueue(lms, playerId, { shuffle: true, mode: appState.playback.smartShuffleSource, controlsReady: true });
        }
      }
      logEvent("playback.result", { after: appState.playback, queued: queued.map(trackSummary), queue: queueSummary() });
      res.json({ ok: true, playback: appState.playback, queued, queue: appState.queue });
    } catch (error) {
      res.status(502).json({ error: error.message, playback: appState.playback });
    }
  }));

  app.post("/api/player/smart-shuffle", async (req, res) => withQueueMutationLock(async () => {
    try {
      const parsed = smartShuffleSchema.safeParse(req.body || {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid smart shuffle request", issues: parsed.error.issues, queued: [], playback: appState.playback });
        return;
      }
      if (!publicRequestsOpen()) {
        res.status(403).json({ error: publicRequestsClosedMessage(), queued: [], playback: appState.playback });
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
      const status = await refreshLms(lms);
      const body = parsed.data;
      const mode = body.source || appState.playback.smartShuffleSource;
      if (mode === "spotify" && !spotifyBrowsingAvailable()) {
        res.status(503).json({ error: spotifyUnavailableMessage(), queued: [], playback: appState.playback });
        return;
      }
      const count = body.count || 5;
      const seed = String(body.seed || appState.nowPlaying.artist || appState.nowPlaying.title || "").trim();
      logEvent("smart-shuffle.request", { mode, count, seed, queue: queueSummary() });
      const queued = await activateGeneratedQueue(lms, status.id, { smart: true, mode, count, seed });
      await refreshLms(lms);
      logEvent("smart-shuffle.result", { queued: queued.map(trackSummary), queue: queueSummary(), playback: appState.playback });
      res.json({ ok: true, mode, seed, queued, queue: appState.queue, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, queued: [] });
    }
  }));

  app.post("/api/admin/settings", requireAdmin, (req, res) => {
    const parsed = adminSettingsSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid admin settings", issues: parsed.error.issues });
      return;
    }
    appState.admin = sanitizeAdminSettings({ ...appState.admin, ...parsed.data });
    res.json(appState.admin);
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  return app;
}

async function hotPlayerId(lms) {
  if (appState.player.connected && appState.player.id && appState.player.id !== "mock-player") return appState.player.id;
  await refreshLms(lms, { force: true, skipTrackInfo: true });
  if (!appState.player.id || appState.player.id === "mock-player") throw new Error("No LMS player connected");
  return appState.player.id;
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

async function rescanLibraryOnce() {
  if (!libraryRescanState.promise) {
    libraryRescanState.promise = (async () => {
      clearLibraryCaches();
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
    path: track.path
  };
}

function isPlayableTrackInput(track) {
  if (!track || typeof track !== "object") return false;
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
    if (key) knownSpotifyTracks.set(key, expiresAt);
  }
  if (knownSpotifyTracks.size > knownSpotifyTrackLimit) {
    for (const [key, expiry] of knownSpotifyTracks) {
      if (expiry <= Date.now() || knownSpotifyTracks.size > knownSpotifyTrackLimit) knownSpotifyTracks.delete(key);
    }
  }
}

function isKnownSpotifyTrack(uri) {
  const key = normalizedSpotifyTrackUri(uri);
  if (!key) return false;
  const expiresAt = knownSpotifyTracks.get(key);
  if (!expiresAt || expiresAt <= Date.now()) {
    knownSpotifyTracks.delete(key);
    return false;
  }
  return true;
}

function spotifyTracksAreKnown(tracks = []) {
  return (tracks || []).every((track) => !isSpotifyTrackInput(track) || isKnownSpotifyTrack(track.uri));
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
  return String(track.uri || track.path || track.lmsTrackId || "").trim().toLowerCase();
}

function publicRequestsOpen() {
  if (appState.admin.publicRequests === false) return false;
  if (appState.admin.scheduleEnabled && appState.schedule.current?.requestsPaused) return false;
  return true;
}

function publicRequestsClosedMessage() {
  return appState.admin.publicRequests === false
    ? "Public requests are paused"
    : "Public requests are paused for the current schedule";
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
  const token = header.replace(/^Bearer\s+/i, "");
  if (token !== adminToken) {
    res.status(401).json({ error: "Admin login required" });
    return;
  }
  next();
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

async function enrichLibraryArtwork(lms, tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0 || typeof lms.enrichLocalArtwork !== "function") return tracks;
  return withTimeout(lms.enrichLocalArtwork(tracks, { limit: localArtworkLimit }), localArtworkBudgetMs, tracks);
}

async function refreshLms(lms, { maintainPlayback = false, minAgeMs = 0, force = false, skipTrackInfo = false, waitForFresh = true } = {}) {
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
        const track = applyPendingSeek(await lms.nowPlaying(status.id));
        const key = trackKey(track);
        const shouldRefreshTrackInfo =
          !skipTrackInfo &&
          isTrackInfoCandidate(track) &&
          (key !== refreshState.trackKey || Date.now() - refreshState.trackInfoAt > trackInfoRefreshMs);
        rememberObservedTrackTransition(track);
        updateNowPlaying(track);
        if (!isTrackInfoCandidate(track)) {
          updatePlayback({ previousTracks: [], appManagedPlayback: false });
          updateTrackInfo(idleTrackInfo);
        }
        if (shouldRefreshTrackInfo) {
          refreshTrackInfoInBackground(track, key);
        }
        prewarmShuffleCandidates(lms, status.id, track);
        prewarmSpotifyLibrary(lms, status.id);
        if (maintainPlayback) await maintainVisiblePlaybackQueue(lms, status, track);
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

function updateStablePlayerStatus(status) {
  const lastUpdate = Date.parse(appState.player.updatedAt || "");
  const wasRecentlyConnected = appState.player.connected && Number.isFinite(lastUpdate) && Date.now() - lastUpdate < 20000;
  if (!status.connected && wasRecentlyConnected) {
    updatePlayerStatus({
      ...appState.player,
      online: true,
      connected: true,
      detail: `Last LMS poll missed the player; holding connection briefly. ${status.detail || ""}`.trim()
    });
    return;
  }
  updatePlayerStatus(status);
}

async function control(lms, action, value) {
  const modeMap = { play: "play", pause: "pause", stop: "stop", next: "play", previous: "play" };
  await lms.control(appState.player.id, action, value);
  if (modeMap[action]) setMode(modeMap[action]);
}

async function activateGeneratedQueue(lms, playerId, { smart = false, shuffle: shuffleOn = false, mode = appState.playback.smartShuffleSource, count = 5, seed, controlsReady = false } = {}) {
  if (!playerId || (!smart && !shuffleOn)) return [];
  const currentSeed = isTrackInfoCandidate(appState.nowPlaying)
    ? (appState.nowPlaying.artist || appState.nowPlaying.title)
    : "";
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
    smartShuffleSource: mode,
    lastShuffleRefillAt: 0,
    lastShuffleSeed: queueSeed,
    lastSmartQueueBase: trackKey(appState.nowPlaying),
    history
  });
  const queued = await buildGeneratedQueue(lms, playerId, queueSeed, mode, count, requestType);
  updatePlayback(smart ? { lastShuffleRefillAt: Date.now(), repeat: "off" } : { lastShuffleRefillAt: Date.now() });
  logEvent("queue.activate-generated", { type: smart ? "smart shuffle" : "shuffle", mode, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

async function buildGeneratedQueue(lms, playerId, seed, mode, count, requestedBy) {
  const normalizedSeed = seed || "drake";
  const exclude = shuffleExclusionSet();
  const hardExclude = currentAndQueueExclusionSet();
  const [spotify, localFocused, localWide] = await Promise.all([
    mode !== "local" && spotifyBrowsingAvailable() ? spotifyShuffleCandidates(lms, playerId, normalizedSeed, count).catch(() => []) : [],
    mode !== "spotify" ? searchLibrary(normalizedSeed, undefined, 120).catch(() => []) : [],
    mode !== "spotify" ? searchLibrary("", undefined, 500).catch(() => []) : []
  ]);
  const spotifyTracks = uniqueTracks(spotify).filter(isPlayableSpotifyTrack);
  const localCandidates = mode === "local" ? [...localFocused, ...shuffle(localWide).slice(0, 180)] : localFocused;
  const localTracks = uniqueTracks(localCandidates).filter((track) => track.path);
  const spotifyPool = shuffle(preferFreshTracks(spotifyTracks, exclude, hardExclude));
  const localPool = shuffle(preferFreshTracks(localTracks, exclude, hardExclude));
  const picks = [];
  for (let index = 0; picks.length < count && (spotifyPool.length || localPool.length); index += 1) {
    const wantLocal = mode === "local" || (mode === "mixed" && Math.random() < 0.4);
    const pool = wantLocal ? localPool : spotifyPool;
    const fallbackPool = wantLocal ? spotifyPool : localPool;
    const pick = pool.shift() || fallbackPool.shift();
    if (pick && !picks.some((item) => trackKey(item) === trackKey(pick) || sameTitleArtist(item, pick))) picks.push(pick);
  }
  const queued = [];
  for (const track of picks) {
    const item = addGeneratedQueueItem(track, mode, requestedBy);
    if (item) {
      queued.push(item);
      rememberShuffleTrack(track);
    }
  }
  return queued;
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

async function maintainSmartShuffle(lms, status, track) {
  if (!appState.playback.shuffle || !status?.id) return;
  syncVisibleQueueWithCurrentTrack(track);
  const needsPlaybackNudge = shouldNudgePlayback(status, track);
  const queued = await ensureSmartShuffleQueue(lms, status.id, { force: needsPlaybackNudge });
  if (needsPlaybackNudge && queued.length > 0) {
    await playNextVisibleQueueItem(lms, status.id, { generatedOnly: true });
  }
}

async function maintainVisiblePlaybackQueue(lms, status, track) {
  if (!status?.id) return;
  syncVisibleQueueWithCurrentTrack(track);
  if (appState.playback.smartQueue || appState.playback.shuffle) {
    try {
      await lms.control(status.id, "shuffle", false);
    } catch (error) {
      logEvent("queue.maintain-skip", { reason: "shuffle-control-failed", error: error.message, playback: appState.playback, queue: queueSummary() });
      return;
    }
  }
  await topOffGeneratedQueue(lms, status.id);
  const needsPlaybackNudge = shouldNudgePlayback(status, track);
  const missedEndedTrack =
    (status.mode === "stop" || status.mode === "stopped") &&
    appState.playback.appManagedPlayback &&
    appState.queue.length > 0;
  if (needsPlaybackNudge && appState.queue.length > 0) {
    logEvent("queue.auto-advance", { reason: "near-track-end", queue: queueSummary(), nowPlaying: trackSummary(track) });
    await playNextVisibleQueueItem(lms, status.id, { generatedOnly: appState.playback.smartQueue });
  } else if (missedEndedTrack) {
    logEvent("queue.auto-advance", { reason: "stopped-with-visible-queue", queue: queueSummary(), nowPlaying: trackSummary(track) });
    await playNextVisibleQueueItem(lms, status.id, { generatedOnly: appState.playback.smartQueue });
  }
}

export async function maintainVisiblePlaybackQueueForTests(lms, status, track) {
  return maintainVisiblePlaybackQueue(lms, status, track);
}

async function ensureSmartShuffleQueue(lms, playerId, { force = false } = {}) {
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
  const seed = String(currentSeed || appState.playback.lastShuffleSeed || "drake").trim();
  const queued = await buildGeneratedQueue(lms, playerId, seed, appState.playback.smartShuffleSource, desired, requestType);
  updatePlayback({ lastShuffleRefillAt: now, lastShuffleSeed: seed });
  if (queued.length > 0) logEvent("queue.refill", { requestType, desired, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

async function topOffGeneratedQueue(lms, playerId) {
  if ((!appState.playback.smartQueue && !appState.playback.shuffle) || !playerId) return [];
  const requestType = appState.playback.smartQueue ? "smart shuffle" : "shuffle";
  if (requestType === "shuffle" && manualQueueCount() > 0) return [];
  const generatedCount = appState.queue.filter((item) => item.requestedBy === requestType).length;
  if (generatedCount >= 4) return [];
  updatePlayback({ lastShuffleRefillAt: 0 });
  logEvent("queue.top-off.request", { requestType, generatedCount, queue: queueSummary() });
  if (appState.playback.smartQueue) return ensureSmartShuffleQueue(lms, playerId, { force: true });
  const desired = Math.max(1, 5 - generatedCount);
  const seed = String(appState.nowPlaying?.artist || appState.nowPlaying?.title || appState.playback.lastShuffleSeed || "drake").trim();
  const queued = await buildGeneratedQueue(lms, playerId, seed, appState.playback.smartShuffleSource, desired, requestType);
  updatePlayback({ lastShuffleRefillAt: Date.now(), lastShuffleSeed: seed });
  if (queued.length > 0) logEvent("queue.refill", { requestType, desired, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

function addGeneratedQueueItem(track, mode = appState.playback.smartShuffleSource, requestedBy = "shuffle") {
  if (!track?.title || queuedTrackExists(track)) return null;
  if (!trackMatchesShuffleSource(track, mode)) return null;
  return addQueueItem({ ...track, requestedBy });
}

async function playNextVisibleQueueItem(lms, playerId, { generatedOnly = false } = {}) {
  if (appState.playback.smartQueue || appState.playback.shuffle) {
    await lms.control(playerId, "shuffle", false);
  }
  const next = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (next) {
    const played = await playQueuedItem(lms, playerId, next);
    scheduleGeneratedTopOff(lms, playerId, played);
    return played;
  }
  await topOffGeneratedQueue(lms, playerId);
  const refilled = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (refilled) {
    return playQueuedItem(lms, playerId, refilled);
  }
  await ensureSmartShuffleQueue(lms, playerId, { force: true });
  const ensured = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (!ensured) {
    logEvent("queue.next-empty", { playback: appState.playback, queue: queueSummary() });
    return null;
  }
  return playQueuedItem(lms, playerId, ensured);
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
  if (!isTrackInfoCandidate(track)) return;
  const previousKey = trackKey(appState.nowPlaying);
  const nextKey = trackKey(track);
  if (!previousKey || !nextKey || previousKey === nextKey) return;
  const pendingKey = refreshState.pendingPlaybackKey;
  if (pendingKey && Date.now() - refreshState.pendingPlaybackAt > 8000) {
    clearPendingPlayback();
  } else if (pendingKey && nextKey === pendingKey) {
    clearPendingPlayback();
  } else if (pendingKey && previousKey === pendingKey) {
    return;
  }
  rememberPreviousTrack(appState.nowPlaying);
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
  await lms.playTrack(playerId, item, "play-now");
  rememberPreviousTrack(appState.nowPlaying);
  rememberShuffleTrack(item);
  markPendingPlayback(item);
  removeQueueItem(item.id);
  setMode("play");
  updatePlayback({ appManagedPlayback: true });
  updateNowPlaying(optimisticTrack(item));
  await refreshPlayedTrackMetadata(lms, playerId, item);
  logEvent("queue.play-item", { item: trackSummary(item), queueAfterRemove: queueSummary(), playback: appState.playback });
  return item;
}

async function refreshPlayedTrackMetadata(lms, playerId, requestedTrack) {
  try {
    const fresh = await lms.nowPlaying(playerId);
    if (!fresh || !isTrackInfoCandidate(fresh)) return;
    if (trackKey(fresh) !== trackKey(requestedTrack) && !sameTitleArtist(fresh, requestedTrack)) return;
    updateNowPlaying(fresh);
  } catch {
    // Keep the optimistic selected track; the normal background refresh will try again.
  }
}

function removeGeneratedQueueItems() {
  for (const item of [...appState.queue]) {
    if (isGeneratedQueueItem(item)) removeQueueItem(item.id);
  }
}

function isGeneratedQueueItem(item) {
  return item?.requestedBy === "smart shuffle" || item?.requestedBy === "shuffle";
}

function stopGeneratedPlayback() {
  if (!appState.playback.shuffle && !appState.playback.smartQueue) return;
  removeGeneratedQueueItems();
  updatePlayback({ shuffle: false, smartQueue: false, lastShuffleRefillAt: 0, lastShuffleSeed: "", lastSmartQueueBase: "" });
}

function shuffleVisibleQueue() {
  const manual = appState.queue.filter((item) => item.requestedBy !== "smart shuffle" && item.requestedBy !== "shuffle");
  const shuffled = shuffle(manual);
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

export function syncVisibleQueueWithCurrentTrack(track) {
  if (!track) return;
  rememberShuffleTrack(track);
  for (const item of [...appState.queue]) {
    if (trackKey(item) === trackKey(track) || sameTitleArtist(item, track)) {
      removeQueueItem(item.id);
      return;
    }
  }
}

export function shouldNudgePlayback(status, track, playback = appState.playback) {
  if (playback.repeat === "one") return false;
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
  clearPendingPlayback();
  clearPendingSeek();
}

function trackKey(track) {
  return normalizeTrackKey(track?.uri || track?.path || track?.lmsTrackId || track?.id || `${track?.title || ""}:${track?.artist || ""}`);
}

function normalizeTrackKey(value) {
  return String(value || "")
    .replace(/^spotify:\/\/(track|episode):/i, "spotify:$1:")
    .toLowerCase();
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
    restorableTrack(track),
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

function isRestorablePreviousTrack(track) {
  return Boolean(track?.title && track.id !== "idle" && (track.path || track.uri || track.lmsTrackId));
}

function restorableTrack(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    source: track.source,
    duration: track.duration,
    art: track.art,
    uri: track.uri,
    path: track.path,
    lmsTrackId: track.lmsTrackId,
    kind: track.kind,
    uploaded: track.uploaded
  };
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
