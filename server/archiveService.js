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
function fetchAndEncode(uri, outPath, encodeArgs, label = "Worker") {
  const bin = locateSpottyBin();
  if (!bin || !existsSync(bin)) {
    return Promise.reject(new Error("spotty helper binary not found"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };

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
    spotty.stderr.on("data", (d) => { errOut += d.toString().slice(0, 200); });
    ff.stderr.on("data", (d) => { errOut += d.toString().slice(0, 200); });

    spotty.on("error", fail);
    ff.on("error", fail);
    // Swallow pipe errors (e.g. EPIPE when one side closes first); the close
    // handlers below decide success/failure.
    spotty.stdout.on("error", () => {});
    ff.stdin.on("error", () => {});
    spotty.stdout.pipe(ff.stdin);
    spotty.on("close", () => { try { ff.stdin.end(); } catch {} });

    ff.on("close", async (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && existsSync(outPath)) {
        resolve(outPath);
      } else {
        await fs.unlink(outPath).catch(() => {});
        reject(new Error(errOut.trim() || `encode failed (ffmpeg exit ${code})`));
      }
    });
  });
}

/** Archive job: fetch + encode to a permanent FLAC. */
async function downloadOne(job) {
  const dest = path.join(ARCHIVE_DIR, `${sanitize(job.artist)} - ${sanitize(job.title)}.flac`);
  const part = `${dest}.part`;
  await fetchAndEncode(job.uri, part, ["-c:a", "flac", "-f", "flac"], "ArchiveWorker");
  await fs.rename(part, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Local browser stream cache (MP3, temporary, LRU) — for "play here" / local DJ
// ---------------------------------------------------------------------------

const STREAM_DIR = path.join(ARCHIVE_DIR, ".stream-cache");
const STREAM_CACHE_MAX = Number(process.env.STREAM_CACHE_MAX_FILES || 60);
const streamInflight = new Map();

/**
 * Ensure a browser-playable MP3 for the given track id/uri exists in the temp
 * cache, fetching it on demand. Returns the file path. Same-track requests are
 * de-duplicated. This is user-initiated (a "play here" click), so it runs
 * immediately rather than through the rate-limited archive queue.
 */
export async function ensureStreamFile(uriOrId) {
  const raw = String(uriOrId || "");
  const norm = normalizeUri(raw.includes("track:") ? raw : `spotify://track:${raw}`);
  const m = norm.match(/track:([A-Za-z0-9]+)/);
  if (!m) throw new Error("Invalid track for streaming");
  const id = m[1];
  const dest = path.join(STREAM_DIR, `${id}.mp3`);
  if (existsSync(dest)) {
    const now = new Date();
    fs.utimes(dest, now, now).catch(() => {});
    return dest;
  }
  if (streamInflight.has(id)) return streamInflight.get(id);
  const job = (async () => {
    await fs.mkdir(STREAM_DIR, { recursive: true });
    const part = `${dest}.part`;
    await fetchAndEncode(norm, part, ["-c:a", "libmp3lame", "-b:a", "256k", "-f", "mp3"], "LocalStream");
    await fs.rename(part, dest);
    pruneStreamCache().catch(() => {});
    return dest;
  })().finally(() => streamInflight.delete(id));
  streamInflight.set(id, job);
  return job;
}

async function pruneStreamCache() {
  const files = (await fs.readdir(STREAM_DIR).catch(() => [])).filter((f) => f.endsWith(".mp3"));
  if (files.length <= STREAM_CACHE_MAX) return;
  const stats = await Promise.all(
    files.map(async (f) => ({ f, t: (await fs.stat(path.join(STREAM_DIR, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
  );
  stats.sort((a, b) => a.t - b.t); // oldest first
  for (const { f } of stats.slice(0, files.length - STREAM_CACHE_MAX)) {
    await fs.unlink(path.join(STREAM_DIR, f)).catch(() => {});
  }
}

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
  const m = s.match(/spotify:(?:\/\/)?track:([A-Za-z0-9]+)/);
  return m ? `spotify://track:${m[1]}` : "";
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
