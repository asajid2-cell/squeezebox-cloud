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
import { getCollections, getCollectionTracks, saveUploadedTrack, scanLibrary, searchLibrary } from "./library.js";
import { enrichTrackInfo } from "./trackInfo.js";

const queueSchema = z.object({
  title: z.string().min(1),
  artist: z.string().optional(),
  album: z.string().optional(),
  source: z.string().optional(),
  path: z.string().optional(),
  requestedBy: z.string().optional()
});

const queueUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  artist: z.string().min(1).optional(),
  album: z.string().optional(),
  requestedBy: z.string().min(1).optional()
});

const loginSchema = z.object({
  password: z.string().min(1)
});

const adminPassword = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin";
const adminToken = process.env.CLOUD_SQUEEZE_ADMIN_TOKEN || "cloud-squeeze-admin";
const serviceRefreshMs = 60000;
const trackInfoRefreshMs = 30000;
const refreshState = { promise: null, updatedAt: 0, servicesAt: 0, trackInfoAt: 0, trackKey: "" };

export function createApp({ lms = new LmsClient() } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  const shuffleMonitor = setInterval(() => {
    if (appState.playback.smartQueue || appState.queue.length > 0) refreshLms(lms, { maintainPlayback: true }).catch(() => null);
  }, 8000);
  shuffleMonitor.unref?.();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "cloud-squeeze" });
  });

  app.get("/api/state", async (_req, res) => {
    await refreshLms(lms, { minAgeMs: appState.player.mode === "play" ? 650 : 1600 });
    res.json(getPublicState());
  });

  app.get("/api/speaker/status", async (_req, res) => {
    const status = await refreshLms(lms);
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
    const duplicate = appState.queue.some((item) => item.title.toLowerCase() === parsed.data.title.toLowerCase());
    if (duplicate) {
      res.status(409).json({ error: "That song is already in the queue" });
      return;
    }
    res.status(201).json(addQueueItem(parsed.data));
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
    if (!item) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    res.json({ ok: true, item, queue: appState.queue });
  });

  app.post("/api/player/track", async (req, res) => {
    const action = String(req.body?.action || "add-queue");
    const track = req.body?.track || {};
    if (!track.path && !track.uri && !track.lmsTrackId) {
      res.status(400).json({ error: "Playable local path, LMS track id, or Spotify URI is required" });
      return;
    }
    try {
      const playerId = await hotPlayerId(lms);
      let queued = null;
      if (action === "add-queue") {
        queued = addQueueItem({ ...track, requestedBy: "guest" });
        runPlaybackCommand(lms, playerId, queued, "add-queue");
      } else if (action === "play-next") {
        queued = addQueueItemNext({ ...track, requestedBy: "guest" });
        runPlaybackCommand(lms, playerId, queued, "play-next");
      } else {
        setMode("play");
        updateNowPlaying(optimisticTrack(track));
        runPlaybackCommand(lms, playerId, track, "play-now");
      }
      res.json({ ok: true, action, queued, queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.get("/api/library/search", async (req, res) => {
    res.json({ results: await searchLibrary(String(req.query.q || ""), undefined, req.query.limit || 100, String(req.query.source || "all")) });
  });

  app.get("/api/spotify/search", async (req, res) => {
    try {
      const playerId = await hotPlayerId(lms);
      if (!appState.services.spotify.configured) {
        res.json({ results: [] });
        return;
      }
      res.json({ results: await lms.spotifySearch(playerId, String(req.query.q || ""), req.query.limit || 20) });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [] });
    }
  });

  app.get("/api/spotify/library", async (req, res) => {
    try {
      const playerId = await hotPlayerId(lms);
      if (!appState.services.spotify.configured) {
        res.json({ results: [] });
        return;
      }
      res.json({
        results: await lms.spotifyLibrary(
          playerId,
          String(req.query.type || "playlists"),
          req.query.limit || 50,
          req.query.offset || 0
        )
      });
    } catch (error) {
      res.status(502).json({ error: error.message, results: [] });
    }
  });

  app.get("/api/spotify/children", async (req, res) => {
    try {
      const playerId = await hotPlayerId(lms);
      if (!appState.services.spotify.configured) {
        res.json({ results: [] });
        return;
      }
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
    res.json({ collections: await getCollections(undefined, String(_req.query.source || "all")) });
  });

  app.get("/api/library/collection", async (req, res) => {
    res.json({
      results: await getCollectionTracks({
        collection: String(req.query.collection || ""),
        folder: String(req.query.folder || ""),
        source: String(req.query.source || "all"),
        limit: req.query.limit || 1000
      })
    });
  });

  app.post("/api/library/rescan", async (_req, res) => {
    const tracks = await scanLibrary(undefined, 5000, "all");
    res.json({ trackCount: tracks.length, sample: tracks.slice(0, 5), status: appState.services.localLibrary });
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
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
          res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
          return;
        }
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
      const status = await refreshLms(lms);
      const played = await playNextVisibleQueueItem(lms, status.id);
      if (!played) await control(lms, "next");
      refreshLms(lms, { force: true }).catch(() => null);
      res.json({ ok: true, action: played ? "visible-queue-next" : "next", queue: appState.queue, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message, player: appState.player, nowPlaying: appState.nowPlaying });
    }
  });

  app.post("/api/player/previous", async (_req, res) => {
    try {
      const status = await refreshLms(lms);
      const elapsed = Number(appState.nowPlaying.elapsed || 0);
      const canSeek = Boolean(appState.nowPlaying.canSeek);
      const action = canSeek && elapsed > 6 ? "restart" : "previous";
      if (action === "restart") {
        await lms.control(status.id, "seek", 0);
      } else {
        await control(lms, "previous");
      }
      refreshLms(lms, { force: true }).catch(() => null);
      res.json({ ok: true, action, mode: appState.player.mode, player: appState.player, nowPlaying: appState.nowPlaying });
    } catch (error) {
      res.status(502).json({ error: error.message, player: appState.player, nowPlaying: appState.nowPlaying });
    }
  });

  app.post("/api/player/volume", async (req, res) => {
    const volume = setVolume(req.body?.volume);
    await control(lms, "volume", volume);
    res.json({ ok: true, volume });
  });

  app.post("/api/player/seek", async (req, res) => {
    const seconds = Math.max(0, Number(req.body?.seconds) || 0);
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
      const playerId = await hotPlayerId(lms);
      const sourceChanged =
        ["mixed", "spotify", "local"].includes(req.body?.smartShuffleSource) &&
        req.body.smartShuffleSource !== appState.playback.smartShuffleSource;
      if (typeof req.body?.shuffle === "boolean") {
        next.shuffle = req.body.shuffle;
        if (req.body.shuffle) next.smartQueue = false;
      }
      if (typeof req.body?.smartQueue === "boolean") {
        next.smartQueue = req.body.smartQueue;
        if (req.body.smartQueue) next.shuffle = false;
      }
      if (["off", "one", "all"].includes(req.body?.repeat)) {
        next.repeat = req.body.repeat;
        lms.control(playerId, "repeat", req.body.repeat).catch(() => null);
      }
      if (["mixed", "spotify", "local"].includes(req.body?.smartShuffleSource)) {
        next.smartShuffleSource = req.body.smartShuffleSource;
      }
      if (sourceChanged || next.smartQueue === false || next.shuffle === true) {
        removeSmartQueueItems();
      }
      updatePlayback(next);
      lms.control(playerId, "shuffle", Boolean(appState.playback.shuffle && !appState.playback.smartQueue)).catch(() => null);
      const queued = appState.playback.smartQueue
        ? await activateSmartQueue(lms, playerId, { mode: appState.playback.smartShuffleSource })
        : [];
      res.json({ ok: true, playback: appState.playback, queued, queue: appState.queue });
    } catch (error) {
      res.status(502).json({ error: error.message, playback: appState.playback });
    }
  });

  app.post("/api/player/smart-shuffle", async (req, res) => {
    try {
      const status = await refreshLms(lms);
      const mode = ["mixed", "spotify", "local"].includes(req.body?.source) ? req.body.source : appState.playback.smartShuffleSource;
      const count = Math.max(1, Math.min(8, Number(req.body?.count) || 5));
      const seed = String(req.body?.seed || appState.nowPlaying.artist || appState.nowPlaying.title || "").trim();
      const queued = await activateSmartQueue(lms, status.id, { mode, count, seed });
      await refreshLms(lms);
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
    .then(() => refreshLms(lms, { force: true }).catch(() => null))
    .catch((error) => updatePlayerStatus({ ...appState.player, detail: `Playback command failed: ${error.message}` }));
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

async function checkUrl(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return { reachable: response.ok || response.status < 500, status: response.status, url };
  } catch (error) {
    return { reachable: false, status: 0, url, detail: error.message };
  }
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

async function refreshLms(lms, { maintainPlayback = false, minAgeMs = 0, force = false, skipTrackInfo = false } = {}) {
  const now = Date.now();
  if (!force && refreshState.promise) return refreshState.promise;
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
          track &&
          (key !== refreshState.trackKey || Date.now() - refreshState.trackInfoAt > trackInfoRefreshMs);
        if (shouldRefreshTrackInfo) {
          const info = await enrichTrackInfo(track);
          updateNowPlaying(track?.art || !info.art ? track : { ...track, art: info.art });
          updateTrackInfo(info);
          refreshState.trackInfoAt = Date.now();
          refreshState.trackKey = key;
        } else {
          updateNowPlaying(track);
        }
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
  return refreshState.promise;
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

async function activateSmartQueue(lms, playerId, { mode = appState.playback.smartShuffleSource, count = 5, seed } = {}) {
  if (!playerId) return [];
  removeSmartQueueItems();
  const queueSeed = String(seed || appState.nowPlaying.artist || appState.nowPlaying.title || appState.playback.lastShuffleSeed || "drake").trim();
  updatePlayback({
    shuffle: false,
    smartQueue: true,
    smartShuffleSource: mode,
    lastShuffleRefillAt: 0,
    lastShuffleSeed: queueSeed,
    lastSmartQueueBase: trackKey(appState.nowPlaying)
  });
  await lms.control(playerId, "shuffle", false).catch(() => null);
  const queued = await buildSmartShuffle(lms, playerId, queueSeed, mode, count);
  updatePlayback({ lastShuffleRefillAt: Date.now() });
  return queued;
}

async function buildSmartShuffle(lms, playerId, seed, mode, count) {
  const normalizedSeed = seed || "drake";
  const exclude = shuffleExclusionSet();
  const hardExclude = currentAndQueueExclusionSet();
  const [spotify, localFocused, localWide] = await Promise.all([
    mode !== "local" ? spotifyShuffleCandidates(lms, playerId, normalizedSeed, count).catch(() => []) : [],
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
    const item = addSmartQueueItem(track, mode);
    if (item) {
      queued.push(item);
      rememberShuffleTrack(track);
    }
  }
  return queued;
}

async function spotifyShuffleCandidates(lms, playerId, seed, count = 5) {
  const terms = shuffle([
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
  ])
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
    await playNextVisibleQueueItem(lms, status.id);
  }
}

async function maintainVisiblePlaybackQueue(lms, status, track) {
  if (!status?.id) return;
  await regenerateSmartQueueForTrack(lms, status.id, track);
  syncVisibleQueueWithCurrentTrack(track);
  const needsPlaybackNudge = shouldNudgePlayback(status, track);
  if (needsPlaybackNudge && appState.queue.length > 0) await playNextVisibleQueueItem(lms, status.id);
}

async function ensureSmartShuffleQueue(lms, playerId, { force = false } = {}) {
  if (!appState.playback.smartQueue || !playerId) return [];
  const now = Date.now();
  const smartQueued = appState.queue.filter((item) => item.requestedBy === "smart shuffle").length;
  if (!force && smartQueued >= 4) return [];
  if (!force && now - Number(appState.playback.lastShuffleRefillAt || 0) < 12000) return [];
  const desired = force ? Math.max(3, 5 - smartQueued) : Math.max(1, 5 - smartQueued);
  const seed = String(appState.nowPlaying.artist || appState.nowPlaying.title || appState.playback.lastShuffleSeed || "drake").trim();
  const queued = await buildSmartShuffle(lms, playerId, seed, appState.playback.smartShuffleSource, desired);
  updatePlayback({ lastShuffleRefillAt: now, lastShuffleSeed: seed });
  return queued;
}

async function regenerateSmartQueueForTrack(lms, playerId, track) {
  if (!appState.playback.smartQueue || !playerId || !track) return [];
  const base = trackKey(track);
  if (!base || base === appState.playback.lastSmartQueueBase) return [];
  removeSmartQueueItems();
  updatePlayback({
    lastSmartQueueBase: base,
    lastShuffleSeed: String(track.artist || track.title || appState.playback.lastShuffleSeed || "drake").trim(),
    lastShuffleRefillAt: 0
  });
  return ensureSmartShuffleQueue(lms, playerId, { force: true });
}

function addSmartQueueItem(track, mode = appState.playback.smartShuffleSource) {
  if (!track?.title || queuedTrackExists(track)) return null;
  if (!trackMatchesShuffleSource(track, mode)) return null;
  return addQueueItem({ ...track, requestedBy: "smart shuffle" });
}

async function playNextVisibleQueueItem(lms, playerId) {
  const next = appState.queue[0];
  if (!next) {
    await ensureSmartShuffleQueue(lms, playerId, { force: true });
    const refilled = appState.queue[0];
    if (!refilled) return null;
    return playQueuedItem(lms, playerId, refilled);
  }
  return playQueuedItem(lms, playerId, next);
}

async function playQueuedItem(lms, playerId, item) {
  removeQueueItem(item.id);
  rememberShuffleTrack(item);
  await lms.playTrack(playerId, item, "play-now");
  return item;
}

function removeSmartQueueItems() {
  for (const item of [...appState.queue]) {
    if (item.requestedBy === "smart shuffle") removeQueueItem(item.id);
  }
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

function shouldNudgePlayback(status, track) {
  if (status.mode === "stop" || status.mode === "stopped") return true;
  if (status.mode === "pause") return false;
  const duration = Number(track?.duration || 0);
  const elapsed = Number(track?.elapsed || 0);
  return duration > 0 && elapsed >= duration - 2;
}

function trackKey(track) {
  return String(track?.uri || track?.path || track?.lmsTrackId || track?.id || `${track?.title || ""}:${track?.artist || ""}`).toLowerCase();
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
