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
  title: requiredText,
  artist: optionalText,
  album: optionalText,
  source: optionalText,
  path: optionalText,
  requestedBy: optionalText
});

const queueUpdateSchema = z.object({
  title: requiredText.optional(),
  artist: requiredText.optional(),
  album: optionalText
}).strict();

const volumeSchema = z.object({
  volume: z.coerce.number().finite()
});

const seekSchema = z.object({
  seconds: z.coerce.number().finite()
});

const playbackSchema = z.object({
  shuffle: z.boolean().optional(),
  smartQueue: z.boolean().optional(),
  repeat: z.enum(["off", "one", "all"]).optional(),
  smartShuffleSource: z.enum(["mixed", "spotify", "local"]).optional()
}).strict();

const loginSchema = z.object({
  password: z.string().min(1)
});

const adminPassword = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin";
const adminToken = process.env.CLOUD_SQUEEZE_ADMIN_TOKEN || "cloud-squeeze-admin";
const serviceRefreshMs = 60000;
const trackInfoRefreshMs = 30000;
const trackInfoBudgetMs = Number(process.env.TRACK_INFO_BUDGET_MS || 1800);
const refreshState = { promise: null, updatedAt: 0, servicesAt: 0, trackInfoAt: 0, trackKey: "", trackInfoPromise: null, trackInfoPendingKey: "" };
const prewarmState = { key: "", at: 0 };
const spotifyLibraryPrewarmState = { playerId: "", at: 0 };
const libraryRescanState = { promise: null };
const debugLog = [];
const debugLogLimit = 500;
const debugLogPath = process.env.CLOUD_SQUEEZE_LOG_PATH || "/tmp/cloud-squeeze-events.jsonl";
const idleTrackInfo = {
  artistBio: "Connect a Squeezebox player, start a track, then enable the LMS Music and Artist Information plugin for live biographies, album reviews, and lyrics.",
  albumReview: "No album review is available until a real track is playing.",
  lyrics: "Lyrics will appear here when the LMS plugin exposes them.",
  art: null
};

export function createApp({ lms = new LmsClient() } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((error, _req, res, next) => {
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON request body" });
      return;
    }
    next(error);
  });
  const shuffleMonitor = setInterval(() => {
    if (appState.playback.smartQueue || appState.queue.length > 0) refreshLms(lms, { maintainPlayback: true }).catch(() => null);
  }, 8000);
  shuffleMonitor.unref?.();
  const startupRefresh = setTimeout(() => {
    refreshLms(lms, { force: true, skipTrackInfo: true }).catch(() => null);
  }, 250);
  startupRefresh.unref?.();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "cloud-squeeze" });
  });

  app.get("/api/debug/logs", (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 120));
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

  app.post("/api/queue", (req, res) => {
    const parsed = queueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue item", issues: parsed.error.issues });
      return;
    }
    if (!canQueueMoreGuestTracks(1)) {
      res.status(429).json({ error: queueLimitMessage(), queue: appState.queue });
      return;
    }
    const duplicate = appState.queue.some((item) => item.title.toLowerCase() === parsed.data.title.toLowerCase());
    if (duplicate) {
      res.status(409).json({ error: "That song is already in the queue" });
      return;
    }
    res.status(201).json(addQueueItem({ ...parsed.data, requestedBy: "guest" }));
  });

  app.patch("/api/queue/:id", (req, res) => {
    const parsed = queueUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue update", issues: parsed.error.issues });
      return;
    }
    const item = updateQueueItem(req.params.id, parsed.data);
    if (!item) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    res.json({ ok: true, item, queue: appState.queue });
  });

  app.delete("/api/queue/:id", (req, res) => {
    const item = removeQueueItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    res.json({ ok: true, removed: item, queue: appState.queue });
  });

  app.post("/api/queue/:id/move", (req, res) => {
    const direction = req.body?.direction ?? req.body?.index;
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
  });

  app.post("/api/player/track", async (req, res) => {
    const action = String(req.body?.action || "add-queue");
    const track = req.body?.track || {};
    if (!["add-queue", "play-next", "play-now"].includes(action)) {
      res.status(400).json({ error: "Track playback supports add-queue, play-next, or play-now" });
      return;
    }
    if (!isPlayableTrackInput(track)) {
      res.status(400).json({ error: "Playable local path, LMS track id, or Spotify URI is required" });
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
        queued = addQueueItemNext({ ...track, requestedBy: "guest" });
        logEvent("queue.add-next", { action, queued: trackSummary(queued), queue: queueSummary() });
      } else {
        const playerId = await hotPlayerId(lms);
        stopGeneratedPlayback();
        setMode("play");
        rememberPreviousTrack(appState.nowPlaying);
        const optimistic = optimisticTrack(track);
        updateNowPlaying(optimistic);
        logEvent("track.play-now.optimistic", { track: trackSummary(track), queue: queueSummary() });
        runPlaybackCommand(lms, playerId, track, "play-now");
      }
      res.json({ ok: true, action, queued, queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post("/api/player/tracks", async (req, res) => {
    const action = String(req.body?.action || "add-queue");
    const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks.filter(Boolean).slice(0, 300) : [];
    if (!["add-queue", "play-next"].includes(action)) {
      res.status(400).json({ error: "Batch playback supports add-queue or play-next" });
      return;
    }
    if (tracks.length === 0) {
      res.status(400).json({ error: "At least one track is required" });
      return;
    }

    const playable = tracks.filter(isPlayableTrackInput);
    if (playable.length === 0) {
      res.status(400).json({ error: "No playable tracks were provided" });
      return;
    }

    const uniquePlayable = uniquePlayableInputs(playable);
    if (uniquePlayable.length === 0) {
      res.status(409).json({ error: "Those songs are already in the queue", queue: appState.queue });
      return;
    }
    if (!canQueueMoreGuestTracks(uniquePlayable.length)) {
      res.status(429).json({ error: queueLimitMessage(), queue: appState.queue, accepted: Math.max(0, guestQueueLimit() - guestQueueCount()) });
      return;
    }

    const queued = [];
    const ordered = action === "play-next" ? [...uniquePlayable].reverse() : uniquePlayable;
    for (const track of ordered) {
      const item = action === "play-next"
        ? addQueueItemNext({ ...track, requestedBy: "guest" })
        : addQueueItem({ ...track, requestedBy: "guest" });
      queued.push(item);
    }
    if (action === "play-next") queued.reverse();
    logEvent("queue.batch", { action, count: queued.length, queued: queued.map(trackSummary), queue: queueSummary() });
    res.json({ ok: true, action, queued, queue: appState.queue });
  });

  app.get("/api/library/search", async (req, res) => {
    const source = parseLibrarySource(req.query.source);
    if (!source) {
      res.status(400).json({ error: "Library source must be all, local, or uploaded" });
      return;
    }
    res.json({ results: await searchLibrary(String(req.query.q || ""), undefined, req.query.limit || 100, source) });
  });

  app.get("/api/spotify/search", async (req, res) => {
    try {
      if (!spotifyBrowsingAvailable()) {
        res.json({ results: [], spotify: appState.services.spotify });
        return;
      }
      const playerId = await hotPlayerId(lms);
      res.json({ results: await lms.spotifySearch(playerId, String(req.query.q || ""), req.query.limit || 20) });
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
      const playerId = await hotPlayerId(lms);
      const type = String(req.query.type || "playlists");
      const limit = req.query.limit || 50;
      const offset = req.query.offset || 0;
      const results = await lms.spotifyLibrary(playerId, type, limit, offset);
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
      const playerId = await hotPlayerId(lms);
      res.json({
        results: await lms.spotifyChildren(
          playerId,
          { browseId: String(req.query.browseId || ""), uri: String(req.query.uri || ""), kind: String(req.query.kind || "playlist") },
          req.query.limit || 200,
          req.query.offset || 0
        )
      });
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
    res.json({
      results: await getCollectionTracks({
        collection: String(req.query.collection || ""),
        folder: String(req.query.folder || ""),
        source,
        limit: req.query.limit || 1000
      })
    });
  });

  app.post("/api/library/rescan", async (_req, res) => {
    const result = await rescanLibraryOnce();
    res.json(result);
  });

  app.post("/api/library/upload", express.raw({ type: "application/octet-stream", limit: "80mb" }), async (req, res) => {
    try {
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
      res.type(response.headers.get("content-type") || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      res.send(Buffer.from(await response.arrayBuffer()));
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

  for (const action of ["play", "pause"]) {
    app.post(`/api/player/${action}`, async (_req, res) => {
      await control(lms, action);
      res.json({ ok: true, mode: appState.player.mode, player: appState.player });
    });
  }

  app.post("/api/player/next", async (_req, res) => {
    try {
      const playerId = await hotPlayerId(lms);
      logEvent("transport.next.request", { queue: queueSummary(), playback: appState.playback, nowPlaying: trackSummary(appState.nowPlaying) });
      const played = await playNextVisibleQueueItem(lms, playerId);
      if (!played) await control(lms, "next");
      refreshLms(lms, { force: true }).catch(() => null);
      logEvent("transport.next.result", { action: played ? "visible-queue-next" : "lms-next", played: trackSummary(played), queue: queueSummary(), playback: appState.playback });
      res.json({ ok: true, action: played ? "visible-queue-next" : "next", queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message, player: appState.player, nowPlaying: appState.nowPlaying });
    }
  });

  app.post("/api/player/previous", async (_req, res) => {
    try {
      const playerId = await hotPlayerId(lms);
      logEvent("transport.previous.request", { queue: queueSummary(), playback: appState.playback, nowPlaying: trackSummary(appState.nowPlaying) });
      const previous = popPreviousTrack();
      if (previous) {
        setMode("play");
        updateNowPlaying(optimisticTrack(previous));
        runPlaybackCommand(lms, playerId, previous, "play-now");
      } else {
        await control(lms, "previous");
      }
      refreshLms(lms, { force: true }).catch(() => null);
      logEvent("transport.previous.result", { action: previous ? "app-previous" : "previous", previous: trackSummary(previous), queue: queueSummary(), playback: appState.playback, nowPlaying: trackSummary(appState.nowPlaying) });
      res.json({ ok: true, action: previous ? "app-previous" : "previous", mode: appState.player.mode, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message, player: appState.player, nowPlaying: appState.nowPlaying });
    }
  });

  app.post("/api/player/volume", async (req, res) => {
    const parsed = volumeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid volume", issues: parsed.error.issues });
      return;
    }
    const volume = setVolume(parsed.data.volume);
    await control(lms, "volume", volume);
    res.json({ ok: true, volume });
  });

  app.post("/api/player/seek", async (req, res) => {
    const parsed = seekSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid seek position", issues: parsed.error.issues });
      return;
    }
    const seconds = Math.max(0, parsed.data.seconds);
    const wasPlaying = appState.player.mode === "play";
    await control(lms, "seek", seconds);
    if (wasPlaying && appState.player.id) await lms.control(appState.player.id, "play").catch(() => null);
    updateNowPlaying({ elapsed: seconds });
    if (wasPlaying) setMode("play");
      refreshLms(lms, { force: true }).catch(() => null);
      res.json({ ok: true, seconds, player: appState.player, nowPlaying: appState.nowPlaying });
  });

  app.post("/api/player/playback", async (req, res) => {
    const next = {};
    try {
      const parsed = playbackSchema.safeParse(req.body || {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid playback settings", issues: parsed.error.issues });
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
        lms.control(playerId, "repeat", body.repeat).catch(() => null);
      }
      if (body.smartShuffleSource) {
        next.smartShuffleSource = body.smartShuffleSource;
      }
      const finalShuffle = typeof next.shuffle === "boolean" ? next.shuffle : appState.playback.shuffle;
      const finalSmartQueue = typeof next.smartQueue === "boolean" ? next.smartQueue : appState.playback.smartQueue;
      if ((shuffleChanged || smartQueueChanged) && !finalShuffle && !finalSmartQueue) {
        next.lastShuffleRefillAt = 0;
        next.lastShuffleSeed = "";
        next.lastSmartQueueBase = "";
      }
      const requestedSource = next.smartShuffleSource || appState.playback.smartShuffleSource;
      const spotifyGeneratedRequested =
        requestedSource === "spotify" &&
        (next.smartQueue === true || (sourceChanged && appState.playback.smartQueue && next.smartQueue !== false));
      if (spotifyGeneratedRequested && !spotifyBrowsingAvailable()) {
        res.status(503).json({ error: spotifyUnavailableMessage(), playback: appState.playback, queue: appState.queue });
        return;
      }
      const queueModeChanged = sourceChanged || shuffleChanged || smartQueueChanged;
      if (queueModeChanged && (next.smartQueue === false || next.shuffle === false || next.shuffle === true || sourceChanged)) {
        removeGeneratedQueueItems();
      }
      updatePlayback(next);
      lms.control(playerId, "shuffle", false).catch(() => null);
      let queued = [];
      if (queueModeChanged && appState.playback.smartQueue) {
        queued = await activateGeneratedQueue(lms, playerId, { smart: true, mode: appState.playback.smartShuffleSource });
      } else if (queueModeChanged && appState.playback.shuffle) {
        shuffleVisibleQueue();
      }
      logEvent("playback.result", { after: appState.playback, queued: queued.map(trackSummary), queue: queueSummary() });
      res.json({ ok: true, playback: appState.playback, queued, queue: appState.queue });
    } catch (error) {
      res.status(502).json({ error: error.message, playback: appState.playback });
    }
  });

  app.post("/api/player/smart-shuffle", async (req, res) => {
    try {
      const status = await refreshLms(lms);
      const mode = ["mixed", "spotify", "local"].includes(req.body?.source) ? req.body.source : appState.playback.smartShuffleSource;
      if (mode === "spotify" && !spotifyBrowsingAvailable()) {
        res.status(503).json({ error: spotifyUnavailableMessage(), queued: [], playback: appState.playback });
        return;
      }
      const count = Math.max(1, Math.min(8, Number(req.body?.count) || 5));
      const seed = String(req.body?.seed || appState.nowPlaying.artist || appState.nowPlaying.title || "").trim();
      logEvent("smart-shuffle.request", { mode, count, seed, queue: queueSummary() });
      const queued = await activateGeneratedQueue(lms, status.id, { smart: true, mode, count, seed });
      await refreshLms(lms);
      logEvent("smart-shuffle.result", { queued: queued.map(trackSummary), queue: queueSummary(), playback: appState.playback });
      res.json({ ok: true, mode, seed, queued, playback: appState.playback });
    } catch (error) {
      res.status(502).json({ error: error.message, queued: [] });
    }
  });

  app.post("/api/admin/settings", requireAdmin, (req, res) => {
    appState.admin = { ...appState.admin, ...req.body };
    res.json(appState.admin);
  });

  return app;
}

async function hotPlayerId(lms) {
  if (appState.player.connected && appState.player.id && appState.player.id !== "mock-player") return appState.player.id;
  await refreshLms(lms, { force: true, skipTrackInfo: true });
  if (!appState.player.id || appState.player.id === "mock-player") throw new Error("No LMS player connected");
  return appState.player.id;
}

function runPlaybackCommand(lms, playerId, track, action) {
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
  return String(track.uri).includes(":track:");
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

function guestQueueLimit() {
  const limit = Number(appState.admin.maxQueuePerUser);
  return Number.isFinite(limit) && limit > 0 ? limit : config.publicQueueMaxPerUser;
}

function guestQueueCount() {
  return appState.queue.filter((item) => item.requestedBy === "guest").length;
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
        const track = await lms.nowPlaying(status.id);
        const key = trackKey(track);
        const shouldRefreshTrackInfo =
          !skipTrackInfo &&
          isTrackInfoCandidate(track) &&
          (key !== refreshState.trackKey || Date.now() - refreshState.trackInfoAt > trackInfoRefreshMs);
        updateNowPlaying(track);
        if (!isTrackInfoCandidate(track)) {
          updatePlayback({ previousTracks: [] });
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
    await Promise.all([
      lms.spotifyLibrary(playerId, "playlists", 80, 0).catch(() => []),
      lms.spotifyLibrary(playerId, "home", 80, 0).catch(() => [])
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
  const modeMap = { play: "play", pause: "pause", next: "play", previous: "play" };
  if (modeMap[action]) setMode(modeMap[action]);
  try {
    await lms.control(appState.player.id, action, value);
  } catch {
    // Local UI development keeps working when LMS is not reachable.
  }
}

async function activateGeneratedQueue(lms, playerId, { smart = false, shuffle: shuffleOn = false, mode = appState.playback.smartShuffleSource, count = 5, seed } = {}) {
  if (!playerId || (!smart && !shuffleOn)) return [];
  removeGeneratedQueueItems();
  const queueSeed = String(seed || appState.nowPlaying.artist || appState.nowPlaying.title || appState.playback.lastShuffleSeed || "drake").trim();
  updatePlayback({
    smartQueue: Boolean(smart),
    shuffle: Boolean(shuffleOn && !smart),
    smartShuffleSource: mode,
    lastShuffleRefillAt: 0,
    lastShuffleSeed: queueSeed,
    lastSmartQueueBase: trackKey(appState.nowPlaying)
  });
  await lms.control(playerId, "shuffle", false).catch(() => null);
  await lms.control(playerId, "repeat", "off").catch(() => null);
  const queued = await buildGeneratedQueue(lms, playerId, queueSeed, mode, count, smart ? "smart shuffle" : "shuffle");
  updatePlayback({ lastShuffleRefillAt: Date.now(), repeat: "off" });
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
  const localTracks = uniqueTracks([...localFocused, ...shuffle(localWide).slice(0, 180)]).filter((track) => track.path);
  const spotifyPool = shuffle(preferFreshTracks(spotifyTracks, exclude, hardExclude));
  const localPool = shuffle(preferFreshTracks(localTracks, exclude, hardExclude));
  const picks = [];
  for (let index = 0; picks.length < count && (spotifyPool.length || localPool.length); index += 1) {
    const wantLocal = mode === "local" || (mode === "mixed" && Math.random() < 0.4);
    const pool = wantLocal ? localPool : spotifyPool;
    const fallbackPool = wantLocal ? spotifyPool : localPool;
    const pick = pool.shift() || fallbackPool.shift();
    if (pick && !picks.some((item) => trackKey(item) === trackKey(pick))) picks.push(pick);
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
  const terms = [
    seed,
    appState.nowPlaying.artist,
    appState.nowPlaying.title,
    appState.playback.lastShuffleSeed,
    "daily mix",
    "discover weekly",
    "radio",
    "drake",
    "juice wrld",
    "the weeknd",
    "travis scott",
    "phoebe bridgers"
  ]
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
  await topOffGeneratedQueue(lms, status.id);
  if (appState.playback.smartQueue || appState.playback.shuffle) {
    lms.control(status.id, "shuffle", false).catch(() => null);
  }
  const needsPlaybackNudge = shouldNudgePlayback(status, track);
  if (needsPlaybackNudge && appState.queue.length > 0) {
    logEvent("queue.auto-advance", { reason: "near-track-end", queue: queueSummary(), nowPlaying: trackSummary(track) });
    await playNextVisibleQueueItem(lms, status.id, { generatedOnly: true });
  }
}

async function ensureSmartShuffleQueue(lms, playerId, { force = false } = {}) {
  if ((!appState.playback.smartQueue && !appState.playback.shuffle) || !playerId) return [];
  const now = Date.now();
  const requestType = appState.playback.smartQueue ? "smart shuffle" : "shuffle";
  const smartQueued = appState.queue.filter((item) => item.requestedBy === requestType).length;
  if (!force && smartQueued >= 4) return [];
  if (!force && now - Number(appState.playback.lastShuffleRefillAt || 0) < 12000) return [];
  const desired = force ? Math.max(3, 5 - smartQueued) : Math.max(1, 5 - smartQueued);
  const seed = String(appState.nowPlaying.artist || appState.nowPlaying.title || appState.playback.lastShuffleSeed || "drake").trim();
  const queued = await buildGeneratedQueue(lms, playerId, seed, appState.playback.smartShuffleSource, desired, requestType);
  updatePlayback({ lastShuffleRefillAt: now, lastShuffleSeed: seed });
  if (queued.length > 0) logEvent("queue.refill", { requestType, desired, queued: queued.map(trackSummary), queue: queueSummary() });
  return queued;
}

async function topOffGeneratedQueue(lms, playerId) {
  if (!appState.playback.smartQueue || !playerId) return [];
  const requestType = appState.playback.smartQueue ? "smart shuffle" : "shuffle";
  const generatedCount = appState.queue.filter((item) => item.requestedBy === requestType).length;
  if (generatedCount >= 4) return [];
  updatePlayback({ lastShuffleRefillAt: 0 });
  logEvent("queue.top-off.request", { requestType, generatedCount, queue: queueSummary() });
  return ensureSmartShuffleQueue(lms, playerId, { force: true });
}

function addGeneratedQueueItem(track, mode = appState.playback.smartShuffleSource, requestedBy = "shuffle") {
  if (!track?.title || queuedTrackExists(track)) return null;
  if (!trackMatchesShuffleSource(track, mode)) return null;
  return addQueueItem({ ...track, requestedBy });
}

async function playNextVisibleQueueItem(lms, playerId, { generatedOnly = false } = {}) {
  if (appState.playback.smartQueue || appState.playback.shuffle) {
    lms.control(playerId, "shuffle", false).catch(() => null);
  }
  await topOffGeneratedQueue(lms, playerId);
  const next = nextQueueItemForPlayback(appState.queue, { generatedOnly });
  if (!next) {
    await ensureSmartShuffleQueue(lms, playerId, { force: true });
    const refilled = nextQueueItemForPlayback(appState.queue, { generatedOnly });
    if (!refilled) {
      logEvent("queue.next-empty", { playback: appState.playback, queue: queueSummary() });
      return null;
    }
    return playQueuedItem(lms, playerId, refilled);
  }
  return playQueuedItem(lms, playerId, next);
}

function isTrackInfoCandidate(track) {
  return Boolean(track?.title && track.id !== "idle" && track.title !== "No track playing");
}

export function nextQueueItemForPlayback(queue = appState.queue, { generatedOnly = false } = {}) {
  if (!generatedOnly) return queue[0] || null;
  return queue.find(isGeneratedQueueItem) || null;
}

async function playQueuedItem(lms, playerId, item) {
  rememberPreviousTrack(appState.nowPlaying);
  removeQueueItem(item.id);
  rememberShuffleTrack(item);
  logEvent("queue.play-item", { item: trackSummary(item), queueAfterRemove: queueSummary(), playback: appState.playback });
  await lms.playTrack(playerId, item, "play-now");
  return item;
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

function syncVisibleQueueWithCurrentTrack(track) {
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
  if (status.mode === "stop" || status.mode === "stopped") return playback.smartQueue || playback.shuffle;
  if (status.mode === "pause") return false;
  const duration = Number(track?.duration || 0);
  const elapsed = Number(track?.elapsed || 0);
  return duration > 0 && elapsed >= duration - 2;
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
  const roots = [config.musicSourceDir, config.uploadDir].map((root) => path.resolve(root));
  const allowedRoot = roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowedRoot || !isStreamableAudio(resolved)) return null;
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat?.isFile()) return null;
  return resolved;
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
