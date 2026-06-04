import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { config, updateLibraryStatus } from "./state.js";

const extensions = ["mp3", "flac", "m4a", "wav", "ogg", "aac"];
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 80 * 1024 * 1024);
const execFileAsync = promisify(execFile);
const scanCache = new Map();
const resultCache = new Map();
const scanCacheMs = Number(process.env.LIBRARY_SCAN_CACHE_MS || 5 * 60 * 1000);
const resultCacheMs = Number(process.env.LIBRARY_RESULT_CACHE_MS || 2 * 60 * 1000);

export async function scanLibrary(root = null, limit = 5000, source = "all", { updateStatus = true } = {}) {
  if (!root) return scanAllLibraries(limit, source, { updateStatus });
  const cacheKey = `${normalizeFsPath(root)}:${source}`;
  const cached = scanCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < scanCacheMs) {
    if (updateStatus) updateLibraryStatus(cached.status);
    return cached.tracks.slice(0, limit);
  }
  const isUploadRoot = normalizeFsPath(root) === normalizeFsPath(config.uploadDir);
  const scanExtensions = isUploadRoot ? ["mp3"] : extensions;
  const patterns = scanExtensions.map((ext) => `**/*.${ext}`);
  try {
    const ignore = nestedUploadIgnore(root, isUploadRoot);
    const files = await fg(patterns, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      suppressErrors: true,
      caseSensitiveMatch: false,
      dot: true,
      deep: 8,
      ignore
    });
    const sortedFiles = files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const tracks = isUploadRoot
      ? await Promise.all(sortedFiles.map(uploadedFileToTrack))
      : sortedFiles.map(fileToTrack);
    const status = { root, reachable: true, trackCount: files.length };
    scanCache.set(cacheKey, { tracks, status, createdAt: Date.now() });
    if (updateStatus) updateLibraryStatus(status);
    return tracks.slice(0, limit);
  } catch (error) {
    if (updateStatus) updateLibraryStatus({ root, reachable: false, trackCount: 0, error: error.message });
    return [];
  }
}

export async function searchLibrary(query, root = undefined, limit = 100, source = "all") {
  const normalized = normalize(query);
  const max = Math.max(1, Math.min(2000, Number(limit) || 100));
  const cacheKey = `search:${normalizeFsPath(root || "all")}:${source}:${normalized}:${max}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;
  const tracks = await scanLibrary(root, 5000, source, { updateStatus: source === "all" && !root });
  let results;
  if (!normalized) {
    results = tracks.slice(0, max);
  } else {
    results = tracks
      .map((track) => ({ track, score: matchScore(track, normalized) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title, undefined, { numeric: true }))
      .map((item) => item.track)
      .slice(0, max);
  }
  setCachedResult(cacheKey, results);
  return results;
}

export async function getCollections(root = undefined, source = "all") {
  const cacheKey = `collections:${normalizeFsPath(root || "all")}:${source}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;
  const tracks = await scanLibrary(root, 5000, source, { updateStatus: source === "all" && !root });
  const groups = new Map();
  for (const track of tracks) {
    const key = `${track.collection || "Local library"}|${track.folder || track.album || "Ungrouped"}`;
    const group = groups.get(key) || {
      collection: track.collection || "Local library",
      folder: track.folder || track.album || "Ungrouped",
      count: 0,
      sample: []
    };
    group.count += 1;
    if (group.sample.length < 3) group.sample.push(track.title);
    groups.set(key, group);
  }
  const results = [...groups.values()].sort((a, b) => `${a.collection} ${a.folder}`.localeCompare(`${b.collection} ${b.folder}`, undefined, { numeric: true }));
  setCachedResult(cacheKey, results);
  return results;
}

export async function getCollectionTracks({ collection = "", folder = "", source = "all", limit = 1000, offset = 0 } = {}) {
  const normalizedCollection = normalize(collection);
  const normalizedFolder = normalize(folder);
  const max = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const start = Math.max(0, Math.min(10000, Number(offset) || 0));
  const cacheKey = `collectionTracks:${source}:${normalizedCollection}:${normalizedFolder}:${max}:${start}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;
  const tracks = await scanLibrary(undefined, 5000, source, { updateStatus: source === "all" });
  const results = tracks
    .filter((track) => {
      const trackCollection = normalize(track.collection || "Local library");
      const trackFolder = normalize(track.folder || track.album || "Ungrouped");
      return (!normalizedCollection || trackCollection === normalizedCollection) && (!normalizedFolder || trackFolder === normalizedFolder);
    })
    .sort((a, b) => String(a.path || a.title).localeCompare(String(b.path || b.title), undefined, { numeric: true }))
    .slice(start, start + max);
  setCachedResult(cacheKey, results);
  return results;
}

export function fileToTrack(filePath, tags = {}) {
  const parsed = path.parse(filePath);
  const meta = pathMeta(filePath);
  const parts = parsed.name.split(/\s+-\s+| - /).filter(Boolean);
  const taggedTitle = cleanTag(tags.title);
  const taggedArtist = cleanTag(tags.artist);
  const taggedAlbum = cleanTag(tags.album);
  const artist = taggedArtist || (parts.length > 1 ? cleanName(parts[0]) : meta.artist || inferArtist(filePath));
  const title = taggedTitle || cleanName(parts.length > 1 ? parts.slice(1).join(" ") : parsed.name);
  return {
    id: `local:${Buffer.from(filePath).toString("base64url")}`,
    title,
    artist,
    album: taggedAlbum || meta.album || cleanName(path.basename(path.dirname(filePath))),
    collection: meta.collection,
    folder: meta.folder,
    source: meta.uploaded ? "Uploaded" : "Local library",
    uploaded: meta.uploaded,
    duration: null,
    path: filePath
  };
}

function nestedUploadIgnore(root, isUploadRoot) {
  if (isUploadRoot) return [];
  const relative = path.relative(path.resolve(root), path.resolve(config.uploadDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return [];
  const normalized = relative.replace(/\\/g, "/").replace(/\/$/, "");
  return [`${normalized}/**`];
}

async function uploadedFileToTrack(filePath) {
  const tags = await readAudioTags(filePath).catch(() => ({}));
  return fileToTrack(filePath, tags);
}

async function readAudioTags(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format_tags=title,artist,album",
    "-of",
    "json",
    filePath
  ], { timeout: 2500, windowsHide: true });
  const parsed = JSON.parse(stdout || "{}");
  return parsed?.format?.tags || {};
}

function pathMeta(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const uploadRoot = config.uploadDir.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith(`${uploadRoot}/`) || normalized === uploadRoot) {
    const folder = cleanName(path.basename(path.dirname(filePath)));
    return {
      artist: "Uploaded",
      album: folder || "Uploads",
      collection: "Uploaded songs",
      folder: folder || "Uploads",
      uploaded: true
    };
  }
  const parts = normalized.split("/").filter(Boolean);
  const collectionsIndex = parts.findIndex((part) => part === "collections");
  if (collectionsIndex >= 0) {
    const collectionRoot = cleanName(parts[collectionsIndex + 1]);
    const category = cleanName(parts[collectionsIndex + 2]);
    const era = cleanName(parts[collectionsIndex + 3]);
    const nestedFolders = parts.slice(collectionsIndex + 4, -1).map(cleanName).filter(Boolean);
    return {
      artist: collectionRoot.toLowerCase().includes("juice wrld") ? "Juice WRLD" : "",
      album: era || category || collectionRoot,
      collection: category ? `${collectionRoot} / ${category}` : collectionRoot,
      folder: [era, ...nestedFolders].filter(Boolean).join(" / ") || category || collectionRoot
    };
  }
  return {};
}

async function scanAllLibraries(limit, source, { updateStatus = true } = {}) {
  const wantsUploaded = source === "all" || source === "uploaded";
  const wantsLocal = source === "all" || source === "local";
  const [local, uploaded] = await Promise.all([
    wantsLocal ? scanLibrary(config.musicSourceDir, limit, "local", { updateStatus: false }) : [],
    wantsUploaded ? scanLibrary(config.uploadDir, limit, "uploaded", { updateStatus: false }) : []
  ]);
  const uploadedPaths = new Set(uploaded.map((track) => track.path));
  const merged = [...uploaded, ...local.filter((track) => !uploadedPaths.has(track.path))];
  if (updateStatus && source === "all") {
    updateLibraryStatus({
      root: config.musicSourceDir,
      reachable: true,
      trackCount: merged.length,
      uploadedCount: uploaded.length
    });
  }
  return merged.slice(0, limit);
}

export async function saveUploadedTrack({ originalName, bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("Upload is empty");
  if (bytes.length > maxUploadBytes) throw new Error("Upload is too large");
  const safe = safeUploadName(originalName);
  assertAudioFile(safe, bytes);
  await fs.mkdir(config.uploadDir, { recursive: true });
  const ext = path.extname(safe).slice(1).toLowerCase();
  const targetName = ext === "mp3" ? safe : `${path.parse(safe).name}.mp3`;
  const target = await uniqueUploadPath(path.join(config.uploadDir, targetName));
  if (ext === "mp3") {
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  } else {
    await transcodeUploadToMp3(safe, bytes, target);
  }
  clearLibraryCaches();
  return fileToTrack(target);
}

function getCachedResult(key) {
  const cached = resultCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    resultCache.delete(key);
    return null;
  }
  return structuredClone(cached.value);
}

function setCachedResult(key, value) {
  if (resultCache.size > 300) resultCache.clear();
  resultCache.set(key, { value: structuredClone(value), expiresAt: Date.now() + resultCacheMs });
}

export function clearLibraryCaches() {
  scanCache.clear();
  resultCache.clear();
}

async function transcodeUploadToMp3(safeName, bytes, target) {
  const tempSource = await uniqueUploadPath(path.join(config.uploadDir, `.incoming-${Date.now()}-${safeName}`));
  await fs.writeFile(tempSource, bytes, { flag: "wx", mode: 0o600 });
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      tempSource,
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "192k",
      target
    ]);
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => null);
    throw new Error(`Upload audio conversion failed: ${error.message}`);
  } finally {
    await fs.rm(tempSource, { force: true }).catch(() => null);
  }
}

function safeUploadName(name) {
  const base = path.basename(String(name || "upload")).normalize("NFKD").replace(/[^\w .()'-]+/g, "_");
  const collapsed = base.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!collapsed || collapsed.startsWith(".")) throw new Error("Invalid upload filename");
  return collapsed;
}

async function uniqueUploadPath(target) {
  const parsed = path.parse(target);
  for (let index = 0; index < 500; index += 1) {
    const candidate = index === 0 ? target : path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Could not allocate upload filename");
}

function assertAudioFile(filename, bytes) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!extensions.includes(ext)) throw new Error("Only music files are allowed");
  if (bytes.subarray(0, 2).toString("hex") === "4d5a") throw new Error("Executable files are not allowed");
  if (bytes.subarray(0, 4).toString("hex") === "7f454c46") throw new Error("Executable files are not allowed");
  if (bytes.includes(Buffer.from("<?php")) || bytes.includes(Buffer.from("<script"))) throw new Error("Text/script payloads are not allowed");
  const head = bytes.subarray(0, 64);
  const valid =
    head.subarray(0, 3).toString("ascii") === "ID3" ||
    head[0] === 0xff ||
    head.subarray(0, 4).toString("ascii") === "fLaC" ||
    head.subarray(0, 4).toString("ascii") === "RIFF" ||
    head.subarray(0, 4).toString("ascii") === "OggS" ||
    head.includes(Buffer.from("ftyp")) ||
    (ext === "aac" && head[0] === 0xff && (head[1] & 0xf0) === 0xf0);
  if (!valid) throw new Error("File content does not look like supported audio");
}

function inferArtist(filePath) {
  const parent = path.basename(path.dirname(filePath));
  return cleanName(parent) || "Local file";
}

function cleanName(value) {
  return String(value || "")
    .replace(/\.(mp3|flac|m4a|wav|ogg|aac)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTag(value) {
  return String(value || "")
    .replace(/\.(mp3|flac|m4a|wav|ogg|aac)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFsPath(value) {
  return path.resolve(String(value || "")).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function matchScore(track, normalizedQuery) {
  const fields = [
    [track.title, 80],
    [track.artist, 65],
    [track.album, 50],
    [track.folder, 36],
    [track.collection, 24]
  ];
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  let score = 0;
  for (const [field, weight] of fields) {
    const normalizedField = normalize(field);
    if (!normalizedField) continue;
    if (normalizedField === normalizedQuery) score += weight * 3;
    if (normalizedField.startsWith(normalizedQuery)) score += weight * 2;
    if (normalizedField.includes(normalizedQuery)) score += weight;
    const tokenHits = tokens.filter((token) => normalizedField.includes(token)).length;
    if (tokenHits) score += tokenHits * Math.max(4, weight / 8);
  }
  return score;
}
