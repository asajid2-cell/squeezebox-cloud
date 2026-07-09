import fs from "node:fs/promises";
import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 4177),
  lmsHost: process.env.LMS_HOST || "127.0.0.1",
  lmsCliPort: Number(process.env.LMS_CLI_PORT || 9090),
  lmsHttpUrl: process.env.LMS_HTTP_URL || "http://127.0.0.1:9000",
  lmsConfigDir: expandPath(process.env.LMS_CONFIG_DIR || "/config"),
  lanLmsHost: process.env.LAN_LMS_HOST || "192.168.1.142",
  publicLmsHost: process.env.PUBLIC_LMS_HOST || "23.17.17.81",
  publicLmsHttpUrl: process.env.PUBLIC_LMS_HTTP_URL || "http://23.17.17.81:9000",
  musicSourceDir: expandPath(process.env.MUSIC_SOURCE_DIR || "%USERPROFILE%\\Downloads"),
  uploadDir: expandPath(process.env.UPLOAD_DIR || "/music/uploads"),
  publicQueueMaxPerUser: Number(process.env.PUBLIC_QUEUE_MAX_PER_USER || 25)
};

config.discoveryStatePath = expandPath(
  process.env.CLOUD_SQUEEZE_DISCOVERY_STATE_PATH ||
  process.env.DISCOVERY_STATE_PATH ||
  path.join(config.lmsConfigDir, "cloud-squeeze-discovery.json")
);

export const appState = {
  player: {
    id: "mock-player",
    name: "Squeezebox Cloud Room",
    connected: false,
    online: false,
    mode: "stopped",
    volume: 68,
    updatedAt: new Date().toISOString()
  },
  nowPlaying: {
    id: "idle",
    title: "No track playing",
    artist: "Connect a player or request a song",
    album: "",
    source: "LMS",
    duration: 0,
    elapsed: 0,
    canSeek: false,
    art: null
  },
  queue: [],
  recentPicks: [],
  schedule: {
    current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false },
    next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true }
  },
  rules: [
    { title: "Be respectful", detail: "No hate speech or harassment" },
    { title: "No spam", detail: "Do not add duplicates or floods" },
    { title: "Keep it clean", detail: "No explicit or offensive content" },
    { title: "Max 25 in queue", detail: "Per person at a time" }
  ],
  services: {
    spotify: { configured: false, reachable: false, detail: "Not checked yet" },
    localLibrary: { root: config.musicSourceDir, reachable: false, trackCount: 0, uploadedCount: 0 },
    musicInfo: {
      configured: false,
      reachable: false,
      detail: "Enable the Music and Artist Information plugin in LMS for artist bios, album notes, and lyrics."
    }
  },
  trackInfo: {
    artistBio: "Connect a Squeezebox player, start a track, then enable the LMS Music and Artist Information plugin for live biographies, album reviews, and lyrics.",
    albumReview: "No album review is available until a real track is playing.",
    lyrics: "Lyrics will appear here when the LMS plugin exposes them."
  },
  playback: {
    shuffle: false,
    manualShuffle: false,
    smartQueue: false,
    repeat: "off",
    smartShuffleSource: "mixed",
    lastShuffleRefillAt: 0,
    lastShuffleSeed: "",
    lastSmartQueueBase: "",
    history: [],
    previousTracks: [],
    appManagedPlayback: false
  },
  curation: {
    hidden: [],
    saved: [],
    pinned: [],
    revision: 0
  },
  customPlaylists: [],
  admin: {
    publicRequests: true,
    maxQueuePerUser: config.publicQueueMaxPerUser,
    moderation: "basic",
    scheduleEnabled: true
  }
};

let queueIdCounter = 0;
let customPlaylistIdCounter = 0;
let customPlaylistTrackIdCounter = 0;
let discoveryStatePath = config.discoveryStatePath;
let discoveryPersistenceEnabled = process.env.NODE_ENV !== "test";
let discoverySaveTimer = null;
let discoverySavePromise = Promise.resolve();

export function getPublicState() {
  return structuredClone(appState);
}

export async function loadDiscoveryState(filePath = discoveryStatePath) {
  if (!filePath) return false;
  const raw = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!raw) return false;
  const parsed = JSON.parse(raw);
  applyDiscoveryState(parsed);
  return true;
}

export async function saveDiscoveryStateNow(filePath = discoveryStatePath) {
  if (!filePath) return false;
  const payload = `${JSON.stringify(discoveryStatePayload(), null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, filePath);
  return true;
}

export async function flushDiscoveryStateForTests() {
  if (discoverySaveTimer) {
    clearTimeout(discoverySaveTimer);
    discoverySaveTimer = null;
  }
  discoverySavePromise = saveDiscoveryStateNow();
  return discoverySavePromise;
}

export function setDiscoveryStatePathForTests(filePath) {
  if (discoverySaveTimer) {
    clearTimeout(discoverySaveTimer);
    discoverySaveTimer = null;
  }
  discoveryStatePath = filePath;
  discoveryPersistenceEnabled = Boolean(filePath);
  discoverySavePromise = Promise.resolve();
}

export function resetDiscoveryStatePersistenceForTests() {
  if (discoverySaveTimer) {
    clearTimeout(discoverySaveTimer);
    discoverySaveTimer = null;
  }
  discoveryStatePath = config.discoveryStatePath;
  discoveryPersistenceEnabled = process.env.NODE_ENV !== "test";
  discoverySavePromise = Promise.resolve();
}

export function addQueueItem(input) {
  const item = {
    id: nextQueueId(),
    title: cleanText(input.title) || "Untitled track",
    artist: cleanText(input.artist) || "Unknown artist",
    album: cleanText(input.album),
    source: cleanText(input.source) || "Local library",
    path: cleanText(input.path),
    uri: input.uri,
    art: input.art,
    kind: input.kind,
    uploaded: input.uploaded,
    lmsTrackId: input.lmsTrackId,
    requestedBy: cleanText(input.requestedBy) || "guest",
    etaMinutes: nextEta()
  };
  appState.queue.push(item);
  recordRecentPick(item, "Queued");
  return item;
}

export function addQueueItemNext(input) {
  const item = {
    id: nextQueueId(),
    title: cleanText(input.title) || "Untitled track",
    artist: cleanText(input.artist) || "Unknown artist",
    album: cleanText(input.album),
    source: cleanText(input.source) || "Local library",
    path: cleanText(input.path),
    uri: input.uri,
    art: input.art,
    kind: input.kind,
    uploaded: input.uploaded,
    lmsTrackId: input.lmsTrackId,
    requestedBy: cleanText(input.requestedBy) || "guest",
    etaMinutes: 7
  };
  appState.queue.unshift(item);
  recordRecentPick(item, "Play next");
  recalculateQueueEtas();
  return item;
}

export function updateQueueItem(id, input) {
  const index = appState.queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const previous = appState.queue[index];
  appState.queue[index] = {
    ...previous,
    ...["title", "artist", "album"].reduce((updates, key) => {
      if (typeof input[key] === "string" && input[key].trim()) updates[key] = input[key].trim();
      return updates;
    }, {})
  };
  updateRecentPick(previous, appState.queue[index]);
  return appState.queue[index];
}

export function removeQueueItem(id) {
  const index = appState.queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [removed] = appState.queue.splice(index, 1);
  removeRecentPick(removed);
  recalculateQueueEtas();
  return removed;
}

export function moveQueueItem(id, direction) {
  const index = appState.queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const target = direction === "up" ? index - 1 : direction === "down" ? index + 1 : Number(direction);
  if ((direction === "up" && index === 0) || (direction === "down" && index === appState.queue.length - 1)) return appState.queue[index];
  if (!Number.isInteger(target) || target < 0 || target >= appState.queue.length) return undefined;
  const [item] = appState.queue.splice(index, 1);
  appState.queue.splice(target, 0, item);
  recalculateQueueEtas();
  return item;
}

export function setVolume(volume) {
  appState.player.volume = Math.max(0, Math.min(100, Number(volume)));
  appState.player.updatedAt = new Date().toISOString();
  return appState.player.volume;
}

export function setMode(mode) {
  appState.player.mode = mode;
  appState.player.updatedAt = new Date().toISOString();
  return appState.player.mode;
}

export function updatePlayback(settings) {
  appState.playback = { ...appState.playback, ...settings };
  return appState.playback;
}

export function curationItemKey(input = {}) {
  const uri = cleanText(input.uri);
  if (uri) return `uri:${normalizeIdentityText(uri).replace(/^spotify:\/\//, "spotify:")}`;
  const path = cleanText(input.path);
  if (path) return `path:${normalizeIdentityText(path).replace(/\\/g, "/")}`;
  const lmsTrackId = cleanText(String(input.lmsTrackId || ""));
  if (lmsTrackId) return `lms:${normalizeIdentityText(lmsTrackId)}`;
  const kind = normalizeIdentityText(input.kind || (input.collection || input.folder ? "collection" : "track"));
  const title = normalizeIdentityText(input.title);
  const artist = normalizeIdentityText(input.artist);
  const album = normalizeIdentityText(input.album);
  const source = normalizeIdentityText(input.source || input.collection || input.folder);
  return `meta:${kind}:${title}:${artist}:${album}:${source}`;
}

export function isCuratedHidden(track) {
  const key = curationItemKey(track);
  return appState.curation.hidden.some((item) => item.key === key);
}

export function curateItem(action, track) {
  const normalizedAction = String(action || "").toLowerCase();
  const key = curationItemKey(track);
  const item = {
    key,
    track: compactCurationTrack(track),
    updatedAt: new Date().toISOString()
  };

  if (normalizedAction === "hide") {
    removeCuratedItem("saved", key);
    removeCuratedItem("pinned", key);
    upsertCuratedItem("hidden", item);
  } else if (normalizedAction === "save") {
    removeCuratedItem("hidden", key);
    upsertCuratedItem("saved", item);
  } else if (normalizedAction === "pin") {
    removeCuratedItem("hidden", key);
    upsertCuratedItem("pinned", item);
  } else if (normalizedAction === "unhide") {
    removeCuratedItem("hidden", key);
  } else if (normalizedAction === "unsave") {
    removeCuratedItem("saved", key);
  } else if (normalizedAction === "unpin") {
    removeCuratedItem("pinned", key);
  } else {
    throw new Error("Unsupported curation action");
  }

  appState.curation.revision += 1;
  scheduleDiscoveryStateSave();
  return item;
}

export function createCustomPlaylist(input = {}) {
  const now = new Date().toISOString();
  const playlist = {
    id: nextCustomPlaylistId(),
    title: cleanText(input.title) || "Untitled playlist",
    description: cleanText(input.description) || "",
    tracks: [],
    createdAt: now,
    updatedAt: now
  };
  appState.customPlaylists.unshift(playlist);
  scheduleDiscoveryStateSave();
  return playlist;
}

export function updateCustomPlaylist(id, input = {}) {
  const playlist = appState.customPlaylists.find((item) => item.id === id);
  if (!playlist) return null;
  if (typeof input.title === "string" && input.title.trim()) playlist.title = input.title.trim();
  if (typeof input.description === "string") playlist.description = input.description.trim();
  playlist.updatedAt = new Date().toISOString();
  scheduleDiscoveryStateSave();
  return playlist;
}

export function removeCustomPlaylist(id) {
  const index = appState.customPlaylists.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [removed] = appState.customPlaylists.splice(index, 1);
  scheduleDiscoveryStateSave();
  return removed;
}

export function addCustomPlaylistTracks(id, tracks = []) {
  const playlist = appState.customPlaylists.find((item) => item.id === id);
  if (!playlist) return null;
  const existing = new Set(playlist.tracks.map((item) => item.key));
  const added = [];
  for (const track of tracks) {
    const key = curationItemKey(track);
    if (existing.has(key)) continue;
    const item = {
      ...compactCurationTrack(track),
      id: nextCustomPlaylistTrackId(),
      key,
      addedAt: new Date().toISOString()
    };
    playlist.tracks.push(item);
    existing.add(key);
    added.push(item);
  }
  if (added.length > 0) playlist.updatedAt = new Date().toISOString();
  if (added.length > 0) scheduleDiscoveryStateSave();
  return { playlist, added };
}

export function removeCustomPlaylistTrack(playlistId, trackId) {
  const playlist = appState.customPlaylists.find((item) => item.id === playlistId);
  if (!playlist) return null;
  const index = playlist.tracks.findIndex((item) => item.id === trackId);
  if (index < 0) return undefined;
  const [removed] = playlist.tracks.splice(index, 1);
  playlist.updatedAt = new Date().toISOString();
  scheduleDiscoveryStateSave();
  return { playlist, removed };
}

export function moveCustomPlaylistTrack(playlistId, trackId, direction) {
  const playlist = appState.customPlaylists.find((item) => item.id === playlistId);
  if (!playlist) return null;
  const index = playlist.tracks.findIndex((item) => item.id === trackId);
  if (index < 0) return undefined;
  const target = direction === "up" ? index - 1 : direction === "down" ? index + 1 : Number(direction);
  if ((direction === "up" && index === 0) || (direction === "down" && index === playlist.tracks.length - 1)) return { playlist, item: playlist.tracks[index] };
  if (!Number.isInteger(target) || target < 0 || target >= playlist.tracks.length) return false;
  const [item] = playlist.tracks.splice(index, 1);
  playlist.tracks.splice(target, 0, item);
  playlist.updatedAt = new Date().toISOString();
  scheduleDiscoveryStateSave();
  return { playlist, item };
}

function scheduleDiscoveryStateSave() {
  if (!discoveryPersistenceEnabled || !discoveryStatePath) return;
  if (discoverySaveTimer) clearTimeout(discoverySaveTimer);
  discoverySaveTimer = setTimeout(() => {
    discoverySaveTimer = null;
    discoverySavePromise = saveDiscoveryStateNow().catch((error) => {
      console.error(`Could not save Cloud Squeeze discovery state: ${error.message}`);
    });
  }, 120);
  discoverySaveTimer.unref?.();
}

function discoveryStatePayload() {
  return {
    version: 1,
    curation: sanitizeCurationState(appState.curation),
    customPlaylists: sanitizeCustomPlaylists(appState.customPlaylists),
    savedAt: new Date().toISOString()
  };
}

function applyDiscoveryState(input = {}) {
  appState.curation = sanitizeCurationState(input.curation || input);
  appState.customPlaylists = sanitizeCustomPlaylists(input.customPlaylists);
}

function sanitizeCurationState(input = {}) {
  return {
    hidden: sanitizeCuratedItems(input.hidden),
    saved: sanitizeCuratedItems(input.saved),
    pinned: sanitizeCuratedItems(input.pinned),
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0
  };
}

function sanitizeCuratedItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const track = compactCurationTrack(item.track || item);
    const key = cleanText(item.key) || curationItemKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sanitized.push({
      key,
      track,
      updatedAt: validIsoDate(item.updatedAt) || new Date().toISOString()
    });
    if (sanitized.length >= 500) break;
  }
  return sanitized;
}

function sanitizeCustomPlaylists(playlists) {
  if (!Array.isArray(playlists)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const playlist of playlists) {
    if (!playlist || typeof playlist !== "object") continue;
    const id = cleanText(playlist.id) || nextCustomPlaylistId();
    if (seen.has(id)) continue;
    seen.add(id);
    const createdAt = validIsoDate(playlist.createdAt) || new Date().toISOString();
    sanitized.push({
      id,
      title: cleanText(playlist.title) || "Untitled playlist",
      description: cleanText(playlist.description) || "",
      tracks: sanitizeCustomPlaylistTracks(playlist.tracks),
      createdAt,
      updatedAt: validIsoDate(playlist.updatedAt) || createdAt
    });
    if (sanitized.length >= 100) break;
  }
  return sanitized;
}

function sanitizeCustomPlaylistTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const item of tracks) {
    if (!item || typeof item !== "object") continue;
    const track = compactCurationTrack(item.track || item);
    const key = cleanText(item.key) || curationItemKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sanitized.push({
      ...track,
      id: cleanText(item.id) || nextCustomPlaylistTrackId(),
      key,
      addedAt: validIsoDate(item.addedAt) || new Date().toISOString()
    });
    if (sanitized.length >= 500) break;
  }
  return sanitized;
}

function validIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return Number.isNaN(Date.parse(value)) ? "" : value;
}

function upsertCuratedItem(collection, item) {
  const list = appState.curation[collection];
  const existing = list.findIndex((candidate) => candidate.key === item.key);
  if (existing >= 0) list.splice(existing, 1);
  list.unshift(item);
}

function removeCuratedItem(collection, key) {
  const list = appState.curation[collection];
  const index = list.findIndex((item) => item.key === key);
  if (index >= 0) list.splice(index, 1);
}

function compactCurationTrack(track = {}) {
  return Object.fromEntries(
    ["id", "title", "artist", "album", "source", "kind", "uri", "path", "lmsTrackId", "browseId", "collection", "folder", "art", "artwork", "duration"]
      .map((key) => [key, track[key]])
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

export function updatePlayerStatus(status) {
  appState.player = { ...appState.player, ...status, updatedAt: new Date().toISOString() };
}

export function updateNowPlaying(track) {
  if (track) {
    appState.nowPlaying = track.id === "idle" ? { ...track } : { ...appState.nowPlaying, ...track };
  }
}

export function updateLibraryStatus(status) {
  appState.services.localLibrary = { ...appState.services.localLibrary, ...status };
}

export function updateSpotifyStatus(status) {
  appState.services.spotify = { ...appState.services.spotify, ...status };
}

export function updateMusicInfoStatus(status) {
  appState.services.musicInfo = { ...appState.services.musicInfo, ...status };
}

export function updateTrackInfo(info) {
  appState.trackInfo = { ...appState.trackInfo, ...info };
}

function nextEta() {
  const last = appState.queue.at(-1);
  return (last?.etaMinutes || 0) + 7;
}

function recalculateQueueEtas() {
  appState.queue.forEach((item, index) => {
    item.etaMinutes = (index + 1) * 7;
  });
}

function nextQueueId() {
  queueIdCounter += 1;
  return `q-${Date.now()}-${queueIdCounter}`;
}

function nextCustomPlaylistId() {
  customPlaylistIdCounter += 1;
  return `pl-${Date.now()}-${customPlaylistIdCounter}`;
}

function nextCustomPlaylistTrackId() {
  customPlaylistTrackIdCounter += 1;
  return `plt-${Date.now()}-${customPlaylistTrackIdCounter}`;
}

function cleanText(value) {
  if (typeof value !== "string") return value;
  return value.trim() || undefined;
}

function normalizeIdentityText(value) {
  return String(cleanText(value) || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function recordRecentPick(item, status) {
  if (item.requestedBy === "smart shuffle" || item.requestedBy === "shuffle") return;
  appState.recentPicks.unshift({ id: item.id, title: item.title, artist: item.artist, status });
  appState.recentPicks = appState.recentPicks.slice(0, 8);
}

function removeRecentPick(item) {
  const index = appState.recentPicks.findIndex((pick) => pick.id === item.id);
  if (index >= 0) appState.recentPicks.splice(index, 1);
}

function updateRecentPick(previous, next) {
  const index = appState.recentPicks.findIndex((pick) => pick.id === previous.id);
  if (index >= 0) {
    appState.recentPicks[index] = {
      ...appState.recentPicks[index],
      title: next.title,
      artist: next.artist
    };
  }
}

function expandPath(value) {
  return value
    .replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "")
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "")
    .replace(/\$HOME/g, process.env.HOME || process.env.USERPROFILE || "");
}
