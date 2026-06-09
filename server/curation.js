import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./state.js";

const MAX_ITEMS_PER_LIST = 500;
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
  "artwork",
  "duration",
  "kind",
  "uploaded",
  "browseId",
  "collection",
  "folder"
];

export function defaultCurationFile() {
  if (process.env.CLOUD_SQUEEZE_CURATION_FILE) return process.env.CLOUD_SQUEEZE_CURATION_FILE;
  return path.join(config.musicSourceDir, "cloud-squeeze", "curation.json");
}

export function createCurationStore(file = defaultCurationFile()) {
  let state = null;

  function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      state = normalizeState(parsed?.curation || parsed);
    } catch {
      state = emptyState();
    }
    return state;
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, JSON.stringify({ curation: load() }, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      logPersistError(error);
    }
  }

  function getState() {
    return structuredClone(load());
  }

  function isHidden(track) {
    const key = curationItemKey(track);
    return load().hidden.some((item) => item.key === key);
  }

  function update(action, track) {
    const normalizedAction = String(action || "").toLowerCase();
    const key = curationItemKey(track);
    const item = { key, track: compactTrack(track), updatedAt: new Date().toISOString() };
    const current = load();

    if (normalizedAction === "hide") {
      removeFrom(current.saved, key);
      removeFrom(current.pinned, key);
      upsert(current.hidden, item);
    } else if (normalizedAction === "favorite") {
      removeFrom(current.hidden, key);
      upsert(current.saved, item);
    } else if (normalizedAction === "pin") {
      removeFrom(current.hidden, key);
      upsert(current.pinned, item);
    } else if (normalizedAction === "unhide") {
      removeFrom(current.hidden, key);
    } else if (normalizedAction === "unfavorite") {
      removeFrom(current.saved, key);
    } else if (normalizedAction === "unpin") {
      removeFrom(current.pinned, key);
    } else {
      throw new CurationError(400, "Unsupported curation action");
    }

    current.revision += 1;
    persist();
    return { item: structuredClone(item), curation: getState() };
  }

  return { getState, isHidden, update, file };
}

export class CurationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function curationItemKey(input = {}) {
  const uri = cleanText(input.uri);
  if (uri) return `uri:${normalizeIdentityText(uri).replace(/^spotify:\/\//, "spotify:")}`;
  const pathValue = cleanText(input.path);
  if (pathValue) return `path:${normalizeIdentityText(pathValue).replace(/\\/g, "/")}`;
  const lmsTrackId = cleanText(input.lmsTrackId);
  if (lmsTrackId) return `lms:${normalizeIdentityText(lmsTrackId)}`;
  const kind = normalizeIdentityText(input.kind || (input.collection || input.folder ? "collection" : "track"));
  const title = normalizeIdentityText(input.title);
  const artist = normalizeIdentityText(input.artist);
  const album = normalizeIdentityText(input.album);
  const source = normalizeIdentityText(input.source || input.collection || input.folder);
  return `meta:${kind}:${title}:${artist}:${album}:${source}`;
}

function normalizeState(input = {}) {
  return {
    hidden: normalizeItems(input.hidden),
    saved: normalizeItems(input.saved),
    pinned: normalizeItems(input.pinned),
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const track = compactTrack(item.track || item);
    const key = cleanText(item.key) || curationItemKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      key,
      track,
      updatedAt: validIsoDate(item.updatedAt) || new Date().toISOString()
    });
    if (normalized.length >= MAX_ITEMS_PER_LIST) break;
  }
  return normalized;
}

function emptyState() {
  return { hidden: [], saved: [], pinned: [], revision: 0 };
}

function upsert(list, item) {
  removeFrom(list, item.key);
  list.unshift(item);
  list.splice(MAX_ITEMS_PER_LIST);
}

function removeFrom(list, key) {
  const index = list.findIndex((item) => item.key === key);
  if (index >= 0) list.splice(index, 1);
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

function validIsoDate(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return Number.isNaN(Date.parse(value)) ? "" : value;
}

function normalizeIdentityText(value) {
  return cleanText(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanText(value) {
  return String(value ?? "").trim();
}

let warnedPersistError = false;
function logPersistError(error) {
  if (warnedPersistError) return;
  warnedPersistError = true;
  console.warn(`[curation] persistence disabled: ${error?.message || error}`);
}

export const defaultCurationStore = createCurationStore();
