import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./state.js";

const MAX_PLAYLISTS = 200;
const MAX_TRACKS_PER_PLAYLIST = 500;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;

const TRACK_KEYS = [
  "id",
  "title",
  "artist",
  "album",
  "source",
  "uri",
  "path",
  "lmsTrackId",
  "art",
  "duration",
  "kind",
  "uploaded",
  "browseId"
];

export function defaultPlaylistsFile() {
  if (process.env.CLOUD_SQUEEZE_PLAYLISTS_FILE) return process.env.CLOUD_SQUEEZE_PLAYLISTS_FILE;
  return path.join(config.musicSourceDir, "cloud-squeeze", "playlists.json");
}

// File-backed playlist store. A single default instance is shared by the app;
// tests inject their own instance bound to a temp file via createApp({ playlists }).
export function createPlaylistStore(file = defaultPlaylistsFile()) {
  let playlists = null;

  function load() {
    if (playlists) return playlists;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      playlists = Array.isArray(parsed?.playlists) ? parsed.playlists.map(normalizePlaylist).filter(Boolean) : [];
    } catch {
      playlists = [];
    }
    return playlists;
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, JSON.stringify({ playlists }, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      // Persistence is best-effort: keep serving from memory if disk write fails.
      logPersistError(error);
    }
  }

  function list() {
    return load().map(toSummary);
  }

  function get(id) {
    const playlist = load().find((item) => item.id === id);
    return playlist ? structuredClone(playlist) : null;
  }

  function create({ name, description = "", createdBy = "guest" } = {}) {
    const cleanName = cleanText(name, MAX_NAME_LENGTH);
    if (!cleanName) throw new PlaylistError(400, "A playlist name is required");
    load();
    if (playlists.length >= MAX_PLAYLISTS) throw new PlaylistError(409, "Playlist limit reached");
    const now = new Date().toISOString();
    const playlist = {
      id: `pl-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      name: cleanName,
      description: cleanText(description, MAX_DESCRIPTION_LENGTH),
      createdBy: cleanText(createdBy, 60) || "guest",
      createdAt: now,
      updatedAt: now,
      tracks: []
    };
    playlists.unshift(playlist);
    persist();
    return structuredClone(playlist);
  }

  function rename(id, { name, description } = {}) {
    const playlist = find(id);
    if (typeof name === "string") {
      const cleanName = cleanText(name, MAX_NAME_LENGTH);
      if (!cleanName) throw new PlaylistError(400, "A playlist name is required");
      playlist.name = cleanName;
    }
    if (typeof description === "string") {
      playlist.description = cleanText(description, MAX_DESCRIPTION_LENGTH);
    }
    touch(playlist);
    persist();
    return structuredClone(playlist);
  }

  function remove(id) {
    load();
    const index = playlists.findIndex((item) => item.id === id);
    if (index < 0) throw new PlaylistError(404, "Playlist not found");
    const [removed] = playlists.splice(index, 1);
    persist();
    return structuredClone(removed);
  }

  function addTracks(id, inputTracks = []) {
    const playlist = find(id);
    const incoming = (Array.isArray(inputTracks) ? inputTracks : [])
      .map(sanitizeTrack)
      .filter(Boolean);
    if (incoming.length === 0) throw new PlaylistError(400, "No valid tracks to add");
    const existing = new Set(playlist.tracks.map(trackKey));
    let added = 0;
    for (const track of incoming) {
      if (playlist.tracks.length >= MAX_TRACKS_PER_PLAYLIST) break;
      const key = trackKey(track);
      if (existing.has(key)) continue;
      existing.add(key);
      playlist.tracks.push(track);
      added += 1;
    }
    touch(playlist);
    persist();
    return { playlist: structuredClone(playlist), added };
  }

  function removeTrack(id, key) {
    const playlist = find(id);
    const index = playlist.tracks.findIndex((track) => trackKey(track) === key);
    if (index < 0) throw new PlaylistError(404, "Track not found in playlist");
    playlist.tracks.splice(index, 1);
    touch(playlist);
    persist();
    return structuredClone(playlist);
  }

  function moveTrack(id, { key, from, to, direction } = {}) {
    const playlist = find(id);
    const index = key != null
      ? playlist.tracks.findIndex((track) => trackKey(track) === key)
      : Number(from);
    if (!Number.isInteger(index) || index < 0 || index >= playlist.tracks.length) {
      throw new PlaylistError(404, "Track not found in playlist");
    }
    let target = direction === "up" ? index - 1 : direction === "down" ? index + 1 : Number(to);
    if (!Number.isInteger(target)) throw new PlaylistError(400, "A valid target position is required");
    target = Math.max(0, Math.min(playlist.tracks.length - 1, target));
    const [track] = playlist.tracks.splice(index, 1);
    playlist.tracks.splice(target, 0, track);
    touch(playlist);
    persist();
    return structuredClone(playlist);
  }

  function find(id) {
    const playlist = load().find((item) => item.id === id);
    if (!playlist) throw new PlaylistError(404, "Playlist not found");
    return playlist;
  }

  return { list, get, create, rename, remove, addTracks, removeTrack, moveTrack, file };
}

export class PlaylistError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function playlistTrackKey(track) {
  return trackKey(track);
}

let warnedPersistError = false;
function logPersistError(error) {
  if (warnedPersistError) return;
  warnedPersistError = true;
  console.warn(`[playlists] persistence disabled: ${error?.message || error}`);
}

function toSummary(playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    createdBy: playlist.createdBy,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    trackCount: playlist.tracks.length,
    art: playlist.tracks.find((track) => track.art)?.art || null,
    sample: playlist.tracks.slice(0, 3).map((track) => track.title).filter(Boolean)
  };
}

function normalizePlaylist(playlist) {
  if (!playlist || typeof playlist !== "object" || !playlist.id || !playlist.name) return null;
  return {
    id: String(playlist.id),
    name: cleanText(playlist.name, MAX_NAME_LENGTH) || "Untitled",
    description: cleanText(playlist.description, MAX_DESCRIPTION_LENGTH),
    createdBy: cleanText(playlist.createdBy, 60) || "guest",
    createdAt: playlist.createdAt || new Date().toISOString(),
    updatedAt: playlist.updatedAt || playlist.createdAt || new Date().toISOString(),
    tracks: Array.isArray(playlist.tracks) ? playlist.tracks.map(sanitizeTrack).filter(Boolean) : []
  };
}

function sanitizeTrack(track) {
  if (!track || typeof track !== "object") return null;
  const playable = Boolean(track.path || track.lmsTrackId || (track.uri && String(track.uri).includes(":track:")));
  const kind = String(track.kind || "").toLowerCase();
  // Only individual, playable tracks belong in a playlist (not albums/artists/playlist refs).
  if (!playable) return null;
  if (kind && kind !== "track") return null;
  const cleaned = {};
  for (const key of TRACK_KEYS) {
    if (track[key] === undefined || track[key] === null) continue;
    cleaned[key] = typeof track[key] === "string" ? track[key].slice(0, 1000) : track[key];
  }
  if (!cleaned.title) cleaned.title = "Untitled track";
  cleaned.kind = "track";
  return cleaned;
}

function trackKey(track) {
  return String(track.uri || track.path || track.lmsTrackId || track.id || track.title || "").toLowerCase();
}

function touch(playlist) {
  playlist.updatedAt = new Date().toISOString();
}

function cleanText(value, max) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export const defaultPlaylistStore = createPlaylistStore();
