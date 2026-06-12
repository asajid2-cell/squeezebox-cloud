/**
 * archiveService.js — queue-based, playback-independent Spotify archival.
 *
 * Each track is downloaded on its own via a separate `spotty --single-track`
 * fetch (verified ~8x faster than realtime and does NOT interrupt the active
 * Spotify session), piped through ffmpeg to a lossless FLAC. A strictly
 * SEQUENTIAL worker drains the queue with a cooldown between tracks and a
 * daily cap, so the account is paced gently — this is for archiving, not
 * mass downloading.
 *
 * Independence: because each download is its own fetch (not a tap on the live
 * playback stream), skipping/stopping the current song cannot corrupt it, and
 * you can queue many tracks (or a whole playlist) and walk away.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ARCHIVE_DIR = resolveArchiveDir();
const QUEUE_FILE = path.join(ARCHIVE_DIR, "queue.json");
const CACHE_DIR = path.join(ARCHIVE_DIR, ".spotty-cache");
const CONFIG_DIR = process.env.LMS_CONFIG_DIR || "/config";

// Rate limits — conservative by design. Override via env if ever needed.
const COOLDOWN_MS = Number(process.env.ARCHIVE_COOLDOWN_MS) || 45000; // gap between downloads
const DAILY_CAP = Number(process.env.ARCHIVE_DAILY_CAP) || 50;        // max tracks/day
const RETRY_PAUSE_MS = 60 * 60 * 1000;                                // re-check hourly when capped

let queue = [];
let dailyCount = { date: "", count: 0 };
let workerRunning = false;
let currentId = null;

function resolveArchiveDir() {
  const raw = process.env.ARCHIVE_DIR || "./archive";
  return raw
    .replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "")
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "")
    .replace(/\$HOME/g, process.env.HOME || process.env.USERPROFILE || "");
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export async function startArchiveService() {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true }).catch(() => {});
  await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
  await loadQueue();
  // Recover from a crash: any job left "downloading" goes back to "queued".
  let changed = false;
  for (const job of queue) {
    if (job.status === "downloading") { job.status = "queued"; changed = true; }
  }
  if (changed) await saveQueue();

  const credsOk = await prepareCredentials();
  if (!credsOk) {
    console.warn("[archive] Spotty credentials not found — downloads will fail until Spotty is authed.");
  }
  console.log(`[archive] queue service ready (${queue.filter(j => j.status === "queued").length} queued, cooldown ${COOLDOWN_MS}ms, cap ${DAILY_CAP}/day).`);
  kickWorker();
}

// ---------------------------------------------------------------------------
// Public API (used by routes)
// ---------------------------------------------------------------------------

/** Enqueue an explicit track. {uri, artist, title} */
export function enqueueTrack({ uri, artist, title } = {}) {
  const normalized = normalizeUri(uri);
  if (!normalized) throw new Error("No archivable Spotify track was provided.");

  // Already downloaded? Already queued/downloading? Skip.
  if (isAlreadyArchived(artist, title)) return { queued: false, reason: "already archived" };
  if (queue.some((j) => normalizeUri(j.uri) === normalized && j.status !== "failed")) {
    return { queued: false, reason: "already in queue" };
  }

  const job = {
    id: crypto.randomUUID(),
    uri: normalized,
    artist: (artist || "Unknown Artist").trim(),
    title: (title || "Unknown Title").trim(),
    status: "queued",
    queuedAt: new Date().toISOString(),
    error: null
  };
  queue.push(job);
  saveQueue();
  kickWorker();
  return { queued: true, job: publicJob(job) };
}

/** Enqueue the track currently playing on the archive player. */
export async function enqueueNowPlaying(lms, playerId) {
  const pid = (playerId || process.env.ARCHIVE_PLAYER_MAC || "").trim();
  const track = await lms.nowPlaying(pid).catch(() => null);
  if (!track || track.id === "idle") throw new Error("Nothing is playing to archive.");
  const uri = track.uri || track.id;
  return enqueueTrack({ uri, artist: track.artist, title: track.title });
}

export function getQueueStatus() {
  return {
    cooldownMs: COOLDOWN_MS,
    dailyCap: DAILY_CAP,
    downloadedToday: dailyCount.date === today() ? dailyCount.count : 0,
    current: currentId,
    jobs: queue.map(publicJob)
  };
}

/** Remove a job that hasn't started (or a finished/failed one) from the queue. */
export function removeJob(id) {
  if (id === currentId) return { removed: false, reason: "in progress" };
  const before = queue.length;
  queue = queue.filter((j) => j.id !== id);
  if (queue.length !== before) saveQueue();
  return { removed: queue.length !== before };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function kickWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const job = queue.find((j) => j.status === "queued");
      if (!job) break;
      if (!withinDailyCap()) break; // paused until the cap resets

      job.status = "downloading";
      currentId = job.id;
      await saveQueue();

      try {
        await downloadOne(job);
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        bumpDailyCount();
        console.log(`[archive] saved: ${job.artist} - ${job.title}`);
      } catch (err) {
        job.status = "failed";
        job.error = String(err && err.message ? err.message : err).slice(0, 300);
        console.error(`[archive] failed: ${job.artist} - ${job.title}: ${job.error}`);
      }
      currentId = null;
      await saveQueue();

      // Pace the next download.
      if (queue.some((j) => j.status === "queued") && withinDailyCap()) {
        await delay(COOLDOWN_MS);
      }
    }
  } finally {
    workerRunning = false;
  }

  // If we stopped only because of the daily cap, re-check later.
  if (queue.some((j) => j.status === "queued") && !withinDailyCap()) {
    const t = setTimeout(kickWorker, RETRY_PAUSE_MS);
    t.unref?.();
  }
}

/**
 * Reusable fetch primitive: spotty --single-track (S16LE PCM) | ffmpeg, encoded
 * per `encodeArgs`, written to `outPath`. Shared by archive (FLAC) and the local
 * browser stream cache (MP3).
 */
function fetchAndEncode(uri, outPath, encodeArgs, label = "Worker", { timeoutMs = 0 } = {}) {
  const bin = locateSpottyBin();
  if (!bin || !existsSync(bin)) {
    return Promise.reject(new Error("spotty helper binary not found"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let spottyClosed = false;
    let ffClosed = false;
    let spottyCode = null;
    let spottySignal = null;
    let ffCode = null;
    let ffSignal = null;
    let timeout = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
    };
    const fail = async (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { spotty.kill("SIGTERM"); } catch {}
      try { ff.kill("SIGTERM"); } catch {}
      await fs.unlink(outPath).catch(() => {});
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    const spotty = spawn(bin, [
      "-n", label,
      "-c", CACHE_DIR,
      "--single-track", uri,
      "--bitrate", "320",
      "--disable-discovery",
      "--disable-audio-cache"
    ]);
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", "44100", "-ac", "2",
      "-i", "pipe:0",
      ...encodeArgs,
      "-y", outPath
    ]);

    let errOut = "";
    const appendErr = (d) => {
      errOut = `${errOut}${d.toString()}`.slice(-4000);
    };
    const exitText = (name, code, signal) => `${name} exit ${code ?? "signal"}${signal ? ` (${signal})` : ""}`;
    const maybeFinish = async () => {
      if (settled || !spottyClosed || !ffClosed) return;
      settled = true;
      cleanup();
      if (spottyCode === 0 && ffCode === 0 && existsSync(outPath)) {
        try {
          await assertNonEmptyFile(outPath, "encode produced no audio");
          resolve(outPath);
        } catch (error) {
          await fs.unlink(outPath).catch(() => {});
          reject(error);
        }
        return;
      }
      await fs.unlink(outPath).catch(() => {});
      const detail = [
        spottyCode === 0 ? "" : exitText("spotty", spottyCode, spottySignal),
        ffCode === 0 ? "" : exitText("ffmpeg", ffCode, ffSignal),
        errOut.trim()
      ].filter(Boolean).join("; ");
      reject(new Error(detail || "encode failed"));
    };
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        fail(new Error(`encode timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
    }

    spotty.stderr.on("data", appendErr);
    ff.stderr.on("data", appendErr);

    spotty.on("error", fail);
    ff.on("error", fail);
    // Swallow pipe errors (e.g. EPIPE when one side closes first); the close
    // handlers below decide success/failure.
    spotty.stdout.on("error", () => {});
    ff.stdin.on("error", () => {});
    spotty.stdout.pipe(ff.stdin);
    spotty.on("close", (code, signal) => {
      spottyClosed = true;
      spottyCode = code;
      spottySignal = signal;
      try { ff.stdin.end(); } catch {}
      maybeFinish();
    });

    ff.on("close", (code, signal) => {
      ffClosed = true;
      ffCode = code;
      ffSignal = signal;
      maybeFinish();
    });
  });
}

/** Archive job: fetch + encode to a permanent FLAC. */
async function downloadOne(job) {
  const dest = path.join(ARCHIVE_DIR, `${sanitize(job.artist)} - ${sanitize(job.title)}.flac`);
  const part = `${dest}.part`;
  const raw = `${dest}.raw`;
  await fetchAndEncode(job.uri, raw, ["-c:a", "flac", "-f", "flac"], "ArchiveWorker");
  // The streaming encode (pipe input) leaves total_samples unset, so LMS and
  // browsers can't read the real duration / seek over HTTP. Re-encode from the
  // now-complete file to stamp the correct sample count, then swap in.
  await reencodeFlac(raw, part);
  await fs.unlink(raw).catch(() => {});
  await fs.rename(part, dest);
  return dest;
}

/** Re-encode a complete FLAC so its STREAMINFO carries the real sample count. */
function reencodeFlac(src, dst) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", src, "-c:a", "flac", "-f", "flac", "-y", dst]);
    let err = "";
    ff.stderr.on("data", (d) => { err += d.toString().slice(0, 200); });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0 && existsSync(dst)) resolve(dst);
      else { fs.unlink(dst).catch(() => {}); reject(new Error(err.trim() || `flac re-encode failed (exit ${code})`)); }
    });
  });
}

// ---------------------------------------------------------------------------
// Local browser stream cache (MP3, temporary, LRU) — for "play here" / local DJ
// ---------------------------------------------------------------------------

const STREAM_DIR = path.join(ARCHIVE_DIR, ".stream-cache");
const DEFAULT_STREAM_CACHE_MAX = 60;
const DEFAULT_STREAM_MP3_BITRATE = "256k";
const DEFAULT_STREAM_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
let streamDir = STREAM_DIR;
let streamCacheMax = parsePositiveInteger(
  process.env.STREAM_CACHE_MAX_FILES ?? process.env.STREAM_CACHE_MAX,
  DEFAULT_STREAM_CACHE_MAX
);
let streamMp3Bitrate = String(process.env.STREAM_MP3_BITRATE || DEFAULT_STREAM_MP3_BITRATE).trim() || DEFAULT_STREAM_MP3_BITRATE;
let streamFetchTimeoutMs = parsePositiveInteger(process.env.STREAM_FETCH_TIMEOUT_MS, DEFAULT_STREAM_FETCH_TIMEOUT_MS);
const streamInflight = new Map();
let fetchAndEncodeImpl = fetchAndEncode;

/**
 * Ensure a browser-playable MP3 for the given track id/uri exists in the temp
 * cache, fetching it on demand. Returns the file path. Same-track requests are
 * de-duplicated. This is user-initiated (a "play here" click), so it runs
 * immediately rather than through the rate-limited archive queue.
 */
export async function ensureStreamFile(uriOrId) {
  const raw = String(uriOrId || "");
  const norm = normalizeUri(raw.toLowerCase().includes("track:") ? raw : `spotify://track:${raw}`);
  const m = norm.match(/track:([A-Za-z0-9]+)/);
  if (!m) throw new Error("Invalid track for streaming");
  const id = m[1];
  const dest = path.join(streamDir, `${id}.mp3`);
  if (existsSync(dest)) {
    const now = new Date();
    fs.utimes(dest, now, now).catch(() => {});
    return dest;
  }
  if (streamInflight.has(id)) return streamInflight.get(id);
  const job = (async () => {
    await fs.mkdir(streamDir, { recursive: true });
    const part = `${dest}.part`;
    try {
      await fs.unlink(part).catch(() => {});
      await fetchAndEncodeImpl(
        norm,
        part,
        ["-c:a", "libmp3lame", "-b:a", streamMp3Bitrate, "-f", "mp3"],
        "LocalStream",
        { timeoutMs: streamFetchTimeoutMs }
      );
      await assertNonEmptyFile(part, "stream encode produced no audio");
      await fs.rename(part, dest);
      const now = new Date();
      await fs.utimes(dest, now, now).catch(() => {});
      await pruneStreamCache({ keepIds: new Set([id]) });
    } catch (error) {
      await fs.unlink(part).catch(() => {});
      throw error;
    }
    return dest;
  })().finally(() => streamInflight.delete(id));
  streamInflight.set(id, job);
  return job;
}

async function pruneStreamCache({ keepIds = new Set() } = {}) {
  const files = (await fs.readdir(streamDir).catch(() => [])).filter((f) => f.endsWith(".mp3"));
  if (files.length <= streamCacheMax) return;
  const keep = new Set([...keepIds].map((id) => `${id}.mp3`));
  const stats = await Promise.all(
    files
      .filter((f) => !keep.has(f))
      .map(async (f) => ({ f, t: (await fs.stat(path.join(streamDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
  );
  stats.sort((a, b) => a.t - b.t); // oldest first
  for (const { f } of stats.slice(0, files.length - streamCacheMax)) {
    await fs.unlink(path.join(streamDir, f)).catch(() => {});
  }
}

export const __archiveServiceTestHooks = {
  setStreamCacheDir(dir) {
    streamDir = dir;
  },
  setStreamCacheMax(max) {
    streamCacheMax = max;
  },
  setStreamMp3Bitrate(bitrate) {
    streamMp3Bitrate = bitrate;
  },
  setStreamFetchTimeoutMs(timeoutMs) {
    streamFetchTimeoutMs = timeoutMs;
  },
  setFetchAndEncode(fn) {
    fetchAndEncodeImpl = fn;
  },
  resetStreamCacheForTests() {
    streamDir = STREAM_DIR;
    streamCacheMax = parsePositiveInteger(
      process.env.STREAM_CACHE_MAX_FILES ?? process.env.STREAM_CACHE_MAX,
      DEFAULT_STREAM_CACHE_MAX
    );
    streamMp3Bitrate = String(process.env.STREAM_MP3_BITRATE || DEFAULT_STREAM_MP3_BITRATE).trim() || DEFAULT_STREAM_MP3_BITRATE;
    streamFetchTimeoutMs = parsePositiveInteger(process.env.STREAM_FETCH_TIMEOUT_MS, DEFAULT_STREAM_FETCH_TIMEOUT_MS);
    fetchAndEncodeImpl = fetchAndEncode;
    streamInflight.clear();
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function locateSpottyBin() {
  if (process.env.ARCHIVE_SPOTTY_BIN) return process.env.ARCHIVE_SPOTTY_BIN;
  const base = path.join(CONFIG_DIR, "cache/InstalledPlugins/Plugins/Spotty/Bin");
  try {
    for (const dir of readdirSync(base)) {
      const p = path.join(base, dir, "spotty-x86_64");
      if (existsSync(p)) return p;
    }
  } catch {}
  return path.join(base, "i386-linux/spotty-x86_64");
}

async function prepareCredentials() {
  const base = path.join(CONFIG_DIR, "cache/spotty");
  try {
    for (const dir of await fs.readdir(base)) {
      const src = path.join(base, dir, "credentials.json");
      if (existsSync(src)) {
        await fs.copyFile(src, path.join(CACHE_DIR, "credentials.json"));
        return true;
      }
    }
  } catch {}
  return false;
}

function normalizeUri(u) {
  const s = String(u || "").trim();
  const m = s.match(/spotify:(?:\/\/)?track:([A-Za-z0-9]+)/i);
  return m ? `spotify://track:${m[1]}` : "";
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

async function assertNonEmptyFile(filePath, message) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) {
    throw new Error(message);
  }
}

function isAlreadyArchived(artist, title) {
  const name = `${sanitize(artist || "Unknown Artist")} - ${sanitize(title || "Unknown Title")}.flac`;
  return existsSync(path.join(ARCHIVE_DIR, name));
}

function sanitize(value) {
  return (
    String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "Unknown"
  );
}

function publicJob(j) {
  return { id: j.id, artist: j.artist, title: j.title, status: j.status, error: j.error, queuedAt: j.queuedAt };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function withinDailyCap() {
  if (dailyCount.date !== today()) return true;
  return dailyCount.count < DAILY_CAP;
}
function bumpDailyCount() {
  const d = today();
  if (dailyCount.date !== d) dailyCount = { date: d, count: 0 };
  dailyCount.count += 1;
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function loadQueue() {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf8");
    const data = JSON.parse(raw);
    queue = Array.isArray(data.queue) ? data.queue : [];
    dailyCount = data.dailyCount && typeof data.dailyCount === "object" ? data.dailyCount : { date: "", count: 0 };
  } catch {
    queue = [];
  }
}

let saveTimer = null;
function saveQueue() {
  // Debounce writes; keep only a bounded history of finished jobs.
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const done = queue.filter((j) => j.status === "done" || j.status === "failed");
    const active = queue.filter((j) => j.status === "queued" || j.status === "downloading");
    queue = [...active, ...done.slice(-200)];
    await fs.writeFile(QUEUE_FILE, JSON.stringify({ queue, dailyCount }, null, 2)).catch(() => {});
  }, 200);
  saveTimer.unref?.();
}
