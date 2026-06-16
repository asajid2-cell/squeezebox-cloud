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
export function enqueueTrack({ uri, artist, title, album, art, emailTo } = {}) {
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
    album: (album || "").trim() || undefined,
    art: String(art || "").trim() || undefined,
    status: "queued",
    queuedAt: new Date().toISOString(),
    error: null
  };
  // If this came from a watched playlist whose title carries an email, mail a
  // compressed copy once it finishes downloading.
  if (emailTo) job.emailTo = emailTo;
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
  return enqueueTrack({ uri, artist: track.artist, title: track.title, album: track.album, art: track.art });
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
        const flacPath = await downloadOne(job);
        job.status = "done";
        job.finishedAt = new Date().toISOString();
        bumpDailyCount();
        console.log(`[archive] saved: ${job.artist} - ${job.title}`);
        // Save the cover thumbnail + (if tagged) fire-and-forget the email so
        // neither a slow fetch nor a mail hiccup stalls the queue.
        saveCover(`${sanitize(job.artist)} - ${sanitize(job.title)}`, job.art).catch(() => {});
        if (job.emailTo) emailArchivedTrack(job, flacPath).catch(() => {});
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
  // now-complete file to stamp the correct sample count + embed tags, then swap in.
  await reencodeFlac(raw, part, { title: job.title, artist: job.artist, album: job.album });
  await fs.unlink(raw).catch(() => {});
  await fs.rename(part, dest);
  return dest;
}

/**
 * Re-encode a complete FLAC so its STREAMINFO carries the real sample count, and
 * embed Vorbis tags (title/artist/album) while we're at it — the raw spotty pipe
 * leaves the file untagged, so without this the metadata only lives in the filename.
 */
function reencodeFlac(src, dst, meta = {}) {
  const metaArgs = [];
  for (const [key, value] of Object.entries(meta)) {
    const v = String(value || "").trim();
    if (v) metaArgs.push("-metadata", `${key}=${v}`);
  }
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", src, "-map_metadata", "-1", "-c:a", "flac", ...metaArgs, "-f", "flac", "-y", dst]);
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
// Cover art: a saved thumbnail per archived track, served self-hosted so the
// archive list shows real covers (and doesn't depend on Spotify URLs staying up).
// ---------------------------------------------------------------------------

const COVERS_DIR = path.join(ARCHIVE_DIR, ".covers");
const COVER_MAX_BYTES = 6 * 1024 * 1024;

function coverFile(stem) { return path.join(COVERS_DIR, `${sanitize2(stem)}.jpg`); }
// stems already come from sanitize()d filenames; keep them filesystem-safe anyway.
function sanitize2(stem) { return String(stem).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 200); }

export function hasArchiveCover(stem) { return existsSync(coverFile(stem)); }
export function archiveCoverFile(stem) { return coverFile(stem); }

// A track's art field can be an image-proxy URL (api/image-proxy?url=<enc>) or a
// direct https URL; pull out something actually fetchable.
function imageUrlFromArt(art) {
  const s = String(art || "");
  const m = s.match(/[?&]url=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return ""; } }
  return /^https?:\/\//i.test(s) ? s : "";
}

// Fetch + save a cover thumbnail for a stem (idempotent: skips if present or if
// there's no fetchable url). Returns true if a cover now exists.
async function saveCover(stem, art) {
  if (!stem) return false;
  if (existsSync(coverFile(stem))) return true;
  const url = imageUrlFromArt(art);
  if (!url) return false;
  try {
    await fs.mkdir(COVERS_DIR, { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > COVER_MAX_BYTES) return false;
    const tmp = `${coverFile(stem)}.tmp-${crypto.randomBytes(3).toString("hex")}`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, coverFile(stem));
    return true;
  } catch { return false; }
}

// Backfill covers for already-archived files that don't have one yet, by looking
// the track up on Spotify (artist + title) for its art. Read-only on the FLACs.
export async function backfillArchiveCovers(lms, playerId) {
  const pid = (playerId || process.env.ARCHIVE_PLAYER_MAC || "").trim() || (await lms.status().catch(() => null))?.id;
  if (!pid) return { saved: 0, reason: "no player" };
  let saved = 0;
  const files = readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".flac") && f !== "_current.flac");
  for (const file of files) {
    const stem = file.replace(/\.flac$/i, "");
    if (existsSync(coverFile(stem))) continue;
    const idx = stem.indexOf(" - ");
    const artist = idx >= 0 ? stem.slice(0, idx) : "";
    const title = idx >= 0 ? stem.slice(idx + 3) : stem;
    const results = await lms.spotifySearch(pid, `${title} ${artist}`.trim(), 5).catch(() => []);
    const hit = (Array.isArray(results) ? results : []).find((r) => imageUrlFromArt(r?.art));
    if (hit && await saveCover(stem, hit.art)) saved += 1;
  }
  return { saved, scanned: files.length };
}

// ---------------------------------------------------------------------------
// Email-on-archive: if a watched playlist's TITLE carries an email address
// (e.g. "Archive me@email.com"), mail a compressed MP3 of each newly-archived
// track there — drop your email in the playlist name and the songs land in your
// inbox. Sent via Resend (RESEND_API_KEY); silently skipped if not configured.
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Squeezebox Archive <archive@harmonizerlabs.cc>";
const EMAIL_BITRATE = process.env.ARCHIVE_EMAIL_BITRATE || "320k";
const EMAIL_MAX_BYTES = (Number(process.env.ARCHIVE_EMAIL_MAX_MB) || 35) * 1024 * 1024;

// EASW convention: a playlist titled "EASW<email>" (e.g. "EASWme@email.com")
// emails each newly-archived track to <email>. The "EASW" marker is stripped and
// the remainder must be exactly the address — ONLY these playlists are emailed.
const EASW_RE = /^easw[\s:_-]*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*$/i;

/** The destination email for an EASW playlist title, or "" if it isn't one. */
export function emailFromTitle(title) {
  const m = String(title || "").trim().match(EASW_RE);
  return m ? m[1] : "";
}

/** Transcode the archived FLAC to a smaller MP3 for emailing. */
function transcodeForEmail(flacPath, mp3Path) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", flacPath, "-c:a", "libmp3lame", "-b:a", EMAIL_BITRATE, "-y", mp3Path]);
    let err = "";
    ff.stderr.on("data", (d) => { err += d.toString().slice(0, 200); });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0 && existsSync(mp3Path)) resolve(mp3Path);
      else { fs.unlink(mp3Path).catch(() => {}); reject(new Error(err.trim() || `mp3 transcode failed (exit ${code})`)); }
    });
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Email a freshly-archived track (compressed) to the playlist-title address. */
async function emailArchivedTrack(job, flacPath) {
  const to = job?.emailTo;
  if (!to) return;
  if (!RESEND_API_KEY) { console.warn(`[archive] email skipped (set RESEND_API_KEY): ${job.artist} - ${job.title}`); return; }
  const mp3Path = path.join(ARCHIVE_DIR, `.email-${job.id}.mp3`);
  try {
    await transcodeForEmail(flacPath, mp3Path);
    const buf = await fs.readFile(mp3Path);
    if (buf.length > EMAIL_MAX_BYTES) {
      console.warn(`[archive] email skipped (${Math.round(buf.length / 1e6)}MB > cap): ${job.title}`);
      return;
    }
    const stem = `${sanitize(job.artist)} - ${sanitize(job.title)}`;
    const filename = `${stem}.mp3`;
    const base = (process.env.ARCHIVE_PUBLIC_BASE || "https://harmonizerlabs.cc/cloud-squeeze").replace(/\/$/, "");
    const flacUrl = `${base}/api/archive/file/${encodeURIComponent(`${stem}.flac`)}`;
    const subject = `${job.title} — ${job.artist} (archived)`;
    // A real plain-text part + legit structure + a link to your own domain are
    // the deliverability levers we control; the rest is domain reputation (warms
    // up as you mark "not spam" and keep sending).
    const text =
      `"${job.title}" by ${job.artist} was just archived from your Spotify playlist and saved to your Squeezebox library.\n\n` +
      `A ${EMAIL_BITRATE} MP3 is attached. The lossless FLAC: ${flacUrl}\n\n` +
      `You're receiving this because you tagged that playlist with your email (EASW…). Reply to this message to stop.`;
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:540px;color:#1a1a1a">` +
      `<h2 style="margin:0 0 2px;font-size:18px">${escapeHtml(job.title)}</h2>` +
      `<p style="margin:0 0 14px;color:#666">${escapeHtml(job.artist)}</p>` +
      `<p style="margin:0 0 14px;line-height:1.5">Just archived from your Spotify playlist and saved to your Squeezebox library. A ${EMAIL_BITRATE} MP3 is attached — the lossless FLAC is here:</p>` +
      `<p style="margin:0 0 18px"><a href="${flacUrl}" style="background:#1a1a1a;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-size:14px">Download FLAC</a></p>` +
      `<p style="margin:0;color:#999;font-size:12px;line-height:1.5">You're receiving this because you tagged that playlist with your email. Reply to stop.</p>` +
      `</div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        reply_to: to,
        subject,
        html,
        text,
        attachments: [{ filename, content: buf.toString("base64") }],
        headers: { "List-Unsubscribe": `<mailto:archive@harmonizerlabs.cc?subject=unsubscribe%20${encodeURIComponent(to)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      })
    });
    if (res.ok) console.log(`[archive] emailed "${job.title}" to ${to}`);
    else console.warn(`[archive] email failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  } catch (e) {
    console.warn(`[archive] email error for "${job.title}": ${e?.message || e}`);
  } finally {
    await fs.unlink(mp3Path).catch(() => {});
  }
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

// ---------------------------------------------------------------------------
// Auto-archiver: watch Spotify playlists named "archive*" and archive new tracks
// as they're added. Each watched playlist becomes a GROUP in the archive view;
// everything else is "Manual". Dedup is handled by enqueueTrack.
// ---------------------------------------------------------------------------

// Playlists to auto-archive: names starting with any of these (case-insensitive).
// "archive" → archive-only; "easw" → the EASW<email> convention (archive + email).
const WATCH_PREFIXES = (process.env.ARCHIVE_WATCH_PREFIX || "archive,easw").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const SCAN_INTERVAL_MS = Number(process.env.ARCHIVE_SCAN_INTERVAL_MS) || 30 * 1000;

function isWatchedTitle(title) {
  const t = String(title || "").trim().toLowerCase();
  return WATCH_PREFIXES.some((p) => t.startsWith(p));
}
const SNAPSHOT_FILE = path.join(ARCHIVE_DIR, "watch-snapshot.json");

// In-memory snapshot of each watched playlist's current track keys, so the
// archive list can be grouped by source WITHOUT re-fetching playlists per load.
let watchedPlaylists = []; // [{ name, uri, browseId, trackCount, updatedAt, keys: string[] }]
let lastScanAt = null;
let scanning = false;

// A track's archive filename stem ("Artist - Title") — must match
// parseArchiveFilename so grouping lines up exactly with the saved FLAC files.
function trackStem(artist, title) {
  return `${sanitize(artist || "Unknown Artist")} - ${sanitize(title || "Unknown Title")}`;
}

export function getWatchStatus() {
  return {
    watching: watchedPlaylists.map((p) => ({ name: p.name, trackCount: p.trackCount, updatedAt: p.updatedAt, email: Boolean(p.email) })),
    lastScanAt,
    scanning,
    intervalMs: SCAN_INTERVAL_MS
  };
}

// Group archive files by source playlist. A file belongs to the FIRST watched
// playlist that contains it; everything else is "Manual" (always shown first).
export function groupArchiveFiles(files = [], snapshot = watchedPlaylists) {
  const buckets = new Map([["Manual", []], ...snapshot.map((p) => [p.name, []])]);
  const sets = snapshot.map((p) => ({ name: p.name, keys: new Set(p.keys) }));
  for (const file of files) {
    const stem = String(file.filename || "").replace(/\.flac$/i, "");
    let group = "Manual";
    for (const p of sets) { if (p.keys.has(stem)) { group = p.name; break; } }
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(file);
  }
  return [...buckets.entries()].map(([name, groupFiles]) => ({ name, manual: name === "Manual", count: groupFiles.length, files: groupFiles }));
}

async function resolveArchivePlayer(lms, playerId) {
  const pid = (playerId || process.env.ARCHIVE_PLAYER_MAC || "").trim();
  if (pid) return pid;
  const status = await lms.status().catch(() => null);
  return status?.id || "";
}

// Find every Spotify playlist named "archive*", enqueue any new tracks (dedup is
// built into enqueueTrack), and refresh the grouping snapshot.
export async function scanWatchedPlaylists(lms, playerId) {
  if (scanning) return { scanning: true, queued: 0, playlists: watchedPlaylists.length };
  scanning = true;
  let queued = 0;
  try {
    const pid = await resolveArchivePlayer(lms, playerId);
    if (!pid) return { scanning: false, queued: 0, playlists: 0, reason: "no player" };
    const all = await lms.spotifyLibrary(pid, "playlists", 200).catch(() => []);
    const watched = (Array.isArray(all) ? all : []).filter((p) => isWatchedTitle(p.title));
    // Spotty returns an empty library when the player just dropped or its cache
    // is cold. If we had watched playlists a moment ago, treat empty as a transient
    // blip — KEEP the snapshot (don't wipe groups / forget what we watch) and bail.
    if (watched.length === 0 && watchedPlaylists.length > 0) {
      return { scanning: false, queued: 0, playlists: watchedPlaylists.length, reason: "transient-empty" };
    }
    const next = [];
    for (const pl of watched) {
      // An EASW<email> playlist mails each new song to <email>; its group is
      // labelled by that address. Plain archive* playlists keep their name.
      const emailTo = emailFromTitle(pl.title);
      const name = emailTo || String(pl.title || "").trim();
      const tracks = await lms.spotifyChildren(pid, { uri: pl.uri, browseId: pl.browseId, kind: "playlist", title: pl.title }, 400).catch(() => []);
      const keys = [];
      for (const t of tracks) {
        const uri = t.uri || t.id;
        if (!uri || !/track[:/]/i.test(String(uri))) continue;
        const stem = trackStem(t.artist, t.title);
        keys.push(stem);
        try { if (enqueueTrack({ uri, artist: t.artist, title: t.title, album: t.album, art: t.art, emailTo }).queued) queued += 1; }
        catch { /* unarchivable track — skip */ }
        // Backfill the cover for an already-archived track in this playlist.
        if (isAlreadyArchived(t.artist, t.title)) await saveCover(stem, t.art);
      }
      next.push({ name, uri: pl.uri, browseId: pl.browseId, trackCount: keys.length, updatedAt: new Date().toISOString(), keys, email: emailTo ? true : undefined });
    }
    watchedPlaylists = next;
    lastScanAt = new Date().toISOString();
    await saveWatchSnapshot();
    console.log(`[archive] scanned ${watched.length} watched playlist(s), queued ${queued} new track(s).`);
    return { scanning: false, queued, playlists: watched.length, lastScanAt };
  } finally {
    scanning = false;
  }
}

async function loadWatchSnapshot() {
  try {
    const data = JSON.parse(await fs.readFile(SNAPSHOT_FILE, "utf8"));
    if (Array.isArray(data.watchedPlaylists)) watchedPlaylists = data.watchedPlaylists;
    lastScanAt = data.lastScanAt || null;
  } catch { /* no snapshot yet */ }
}

async function saveWatchSnapshot() {
  await fs.writeFile(SNAPSHOT_FILE, JSON.stringify({ watchedPlaylists, lastScanAt }, null, 2)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Spotify Web-API watcher (the accurate, lightweight path). Lists the user's
// archive*/easw* playlists via the Web API (no Spotty stale cache → deletes/adds
// are instant) and uses each playlist's `snapshot_id` to skip unchanged ones
// (cheap: most cycles are a single /me/playlists call, no track reads). Falls
// back to the Spotty scanner when SPOTIFY_REFRESH_TOKEN isn't configured. The
// DOWNLOAD still goes through spotty --single-track — only discovery + reading
// moves to the Web API.
// ---------------------------------------------------------------------------

let spotifyToken = { value: "", exp: 0 };

export function spotifyWebConfigured() {
  return Boolean(process.env.SPOTIFY_REFRESH_TOKEN && process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

async function spotifyAccessToken() {
  if (!spotifyWebConfigured()) return "";
  if (spotifyToken.value && spotifyToken.exp > Date.now()) return spotifyToken.value;
  const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.SPOTIFY_REFRESH_TOKEN })
  });
  if (!res.ok) throw new Error(`spotify token refresh ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  const j = await res.json();
  spotifyToken = { value: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  return spotifyToken.value;
}

async function spotifyGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) { await delay((Number(res.headers.get("retry-after")) || 2) * 1000); return spotifyGet(url, token); }
  if (!res.ok) throw new Error(`spotify GET ${res.status} ${url}`);
  return res.json();
}

// All of the user's playlists (paginated), with id/name/snapshot_id/uri.
async function spotifyMyPlaylists(token) {
  const out = [];
  let url = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (url) { const j = await spotifyGet(url, token); out.push(...(j.items || [])); url = j.next; }
  return out;
}

// A playlist's tracks via the Web API, normalized to the archive track shape.
// NOTE: the dedicated /playlists/{id}/tracks endpoint is 403 for new apps, but the
// playlist OBJECT returns the first 100 tracks inline (200) — plenty for these
// small archive playlists. (Pagination past 100 would need the forbidden endpoint.)
// Web-API scan: the Web API gives the AUTHORITATIVE archive*/easw* list +
// snapshot_id (instant deletes/adds, cheap change-detection), but it can't read
// playlist CONTENTS (the new-app restriction). So Spotty does the track read —
// and ONLY for playlists whose snapshot_id changed. Most cycles = one /me/playlists
// call, zero Spotty calls.
export async function scanWatchedPlaylistsWebApi(lms) {
  if (scanning) return { scanning: true, queued: 0, playlists: watchedPlaylists.length };
  scanning = true;
  let queued = 0;
  try {
    const token = await spotifyAccessToken();
    if (!token) return { scanning: false, queued: 0, playlists: 0, reason: "no-token" };
    const all = await spotifyMyPlaylists(token);
    const watched = all.filter((p) => isWatchedTitle(p.name));

    // Which playlists changed (new or snapshot_id moved)? Only those need a read.
    const needsRead = watched.filter((pl) => {
      const prior = watchedPlaylists.find((w) => w.id === pl.id);
      return !prior || !prior.snapshotId || prior.snapshotId !== pl.snapshot_id;
    });
    // Map playlist uri -> Spotty browseId, but only bother if something changed.
    const browseByUri = new Map();
    let pid = "";
    if (needsRead.length && lms) {
      pid = await resolveArchivePlayer(lms);
      if (pid) {
        const lib = await lms.spotifyLibrary(pid, "playlists", 200).catch(() => []);
        for (const s of (Array.isArray(lib) ? lib : [])) if (s?.uri) browseByUri.set(s.uri, s.browseId);
      }
    }

    const next = [];
    for (const pl of watched) {
      const emailTo = emailFromTitle(pl.name);
      const name = emailTo || String(pl.name || "").trim();
      const prior = watchedPlaylists.find((w) => w.id === pl.id);
      let keys = prior?.keys || [];
      let snapId = prior?.snapshotId || "";
      const changed = !prior || prior.snapshotId !== pl.snapshot_id;
      if (changed) {
        const browseId = browseByUri.get(pl.uri);
        if (browseId !== undefined && pid && lms) {
          // Spotty knows this playlist → read its tracks and accept the new snapshot.
          const tracks = await lms.spotifyChildren(pid, { uri: pl.uri, browseId, kind: "playlist", title: pl.name }, 400).catch(() => []);
          keys = [];
          for (const t of (Array.isArray(tracks) ? tracks : [])) {
            const uri = t.uri || t.id;
            if (!uri || !/track[:/]/i.test(String(uri))) continue;
            const stem = trackStem(t.artist, t.title);
            keys.push(stem);
            try { if (enqueueTrack({ uri, artist: t.artist, title: t.title, album: t.album, art: t.art, emailTo }).queued) queued += 1; }
            catch { /* unarchivable — skip */ }
            if (isAlreadyArchived(t.artist, t.title)) await saveCover(stem, t.art);
          }
          snapId = pl.snapshot_id;
        }
        // else: Spotty doesn't list it yet (cache lag) → keep prior keys + OLD
        // snapshot id, so we retry the read on the next cycle.
      }
      next.push({ id: pl.id, name, uri: pl.uri, trackCount: keys.length, updatedAt: new Date().toISOString(), keys, email: emailTo ? true : undefined, snapshotId: snapId });
    }
    // The Web API list is authoritative — playlists not in it are genuinely gone.
    watchedPlaylists = next;
    lastScanAt = new Date().toISOString();
    await saveWatchSnapshot();
    if (queued) console.log(`[archive] web-scan: ${watched.length} watched, ${needsRead.length} changed, queued ${queued}.`);
    return { scanning: false, queued, playlists: watched.length, changed: needsRead.length, lastScanAt, via: "web" };
  } finally {
    scanning = false;
  }
}

// Start the periodic auto-archiver: restore the last snapshot for instant
// grouping, scan shortly after boot, then on an interval. Prefers the Web-API
// watcher (accurate + cheap) and falls back to the Spotty scanner.
export function startArchiveWatcher(lms) {
  loadWatchSnapshot();
  const web = spotifyWebConfigured();
  const kick = () => (web ? scanWatchedPlaylistsWebApi(lms) : scanWatchedPlaylists(lms))
    .catch((e) => console.warn(`[archive] scan failed: ${e?.message || e}`));
  console.log(`[archive] watcher using ${web ? "Spotify Web API" : "Spotty browse"} (interval ${SCAN_INTERVAL_MS}ms).`);
  const first = setTimeout(kick, web ? 5000 : 20000);
  first.unref?.();
  const timer = setInterval(kick, SCAN_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
