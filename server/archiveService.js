/**
 * archiveService.js
 *
 * On-demand archival of the currently-playing track.
 *
 * Capture model (why it works this way):
 *   - LMS plays Spotify through a single spotty→flac transcode. We tee that
 *     transcode to a TRANSIENT buffer file ($ARCHIVE_DIR/_current.flac) that is
 *     overwritten at the start of every track. Nothing in that buffer is ever
 *     kept unless the user explicitly asks for it.
 *   - We do NOT open a second Spotify stream to capture, because Spotify allows
 *     only one active stream per account — a second one would interrupt the
 *     user's playback. Teeing the existing stream avoids that entirely.
 *
 * On-demand archive (requestArchive):
 *   - Copies whatever the buffer holds for the current track, then tails the
 *     buffer's growth into the destination until the track ends (track change
 *     detected via the LMS CLI, buffer truncation, or growth going idle).
 *   - The finished file is named "Artist - Title.flac" and tagged.
 *
 * A lightweight LMS CLI subscription tracks only the current track id per
 * player, so a finalize can stop exactly when the track changes. It does NOT
 * archive anything on its own.
 */

import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";

const ARCHIVE_DIR = resolveArchiveDir();
const PLAYER_MAC = (process.env.ARCHIVE_PLAYER_MAC || "").toLowerCase().trim();
const BUFFER_FILE = "_current.flac";

function resolveArchiveDir() {
  const raw = process.env.ARCHIVE_DIR || "./archive";
  return raw
    .replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "")
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "")
    .replace(/\$HOME/g, process.env.HOME || process.env.USERPROFILE || "");
}

// ---------------------------------------------------------------------------
// Current-track tracking (read-only; never archives on its own)
// ---------------------------------------------------------------------------

const currentTrackByPlayer = new Map(); // playerId -> last seen track token
let reconnectTimer = null;

/** Start the CLI subscription used only to know when a track changes. */
export function startArchiveService(lms) {
  if (!PLAYER_MAC) {
    console.log("[archive] ARCHIVE_PLAYER_MAC not set — on-demand archive service idle.");
    return;
  }
  fs.mkdir(ARCHIVE_DIR, { recursive: true }).catch((err) =>
    console.error("[archive] Could not create ARCHIVE_DIR:", err.message)
  );
  connectAndTrack(lms);
}

function connectAndTrack(lms) {
  const host = lms.host || "127.0.0.1";
  const port = lms.port || 9090;
  const socket = net.createConnection({ host, port });
  let buffer = "";

  socket.setEncoding("utf8");
  socket.on("connect", () => {
    console.log(`[archive] Tracking current track via LMS CLI ${host}:${port}.`);
    socket.write("listen 1\n");
    socket.write("subscribe playlist\n");
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) trackLine(line.trim());
  });
  socket.on("error", (err) => console.error("[archive] CLI socket error:", err.message));
  socket.on("close", () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectAndTrack(lms);
    }, 10000);
    reconnectTimer.unref?.();
  });
}

function trackLine(line) {
  if (!line) return;
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx < 0) return;
  let playerId;
  try {
    playerId = decodeURIComponent(line.slice(0, spaceIdx)).toLowerCase().trim();
  } catch {
    return;
  }
  const rest = line.slice(spaceIdx + 1);
  // "playlist newsong <title> <index>" — the index/token marks a track change.
  if (rest.startsWith("playlist newsong")) {
    currentTrackByPlayer.set(playerId, rest);
  }
}

// ---------------------------------------------------------------------------
// On-demand archive
// ---------------------------------------------------------------------------

let activeJob = null; // { trackKey, dest, status } — one at a time

export function getArchiveStatus() {
  return activeJob
    ? { archiving: true, track: activeJob.label, state: activeJob.state }
    : { archiving: false };
}

/**
 * Promote the currently-playing track from the transient buffer to a permanent
 * archive file. Resolves when archiving has STARTED (finalize continues async).
 */
export async function requestArchive(lms, playerIdArg) {
  const playerId = (playerIdArg || PLAYER_MAC).toLowerCase().trim();
  if (!PLAYER_MAC) throw new Error("Archiving is not configured (ARCHIVE_PLAYER_MAC unset).");
  if (activeJob) return { archiving: true, track: activeJob.label, already: true };

  const track = await lms.nowPlaying(playerId).catch(() => null);
  if (!track || track.id === "idle") throw new Error("Nothing is playing to archive.");

  const bufferPath = path.join(ARCHIVE_DIR, BUFFER_FILE);
  try {
    await fs.access(bufferPath);
  } catch {
    throw new Error("No capture buffer yet — give the track a moment to start, then try again.");
  }

  const artist = sanitize(track.artist || "Unknown Artist");
  const title = sanitize(track.title || "Unknown Title");
  const destName = `${artist} - ${title}.flac`;
  const destPath = path.join(ARCHIVE_DIR, destName);
  const trackKey = currentTrackByPlayer.get(playerId) || track.id;

  activeJob = { trackKey, label: `${track.artist} – ${track.title}`, state: "capturing" };
  // Run the copy/tail/finalize loop without blocking the HTTP response.
  finalizeArchive({ lms, playerId, bufferPath, destPath, destName, trackKey, track }).catch((err) => {
    console.error("[archive] finalize error:", err.message);
    activeJob = null;
  });

  return { archiving: true, track: activeJob.label, filename: destName };
}

/**
 * Copy the buffer to the destination, then keep appending the buffer's growth
 * until the track ends. Track-end is detected by: CLI track-change, buffer
 * truncation (next song reset the file), or growth going idle for IDLE_MS.
 */
async function finalizeArchive({ lms, playerId, bufferPath, destPath, destName, trackKey, track }) {
  const POLL_MS = 1000;
  const IDLE_MS = 5000; // buffer stopped growing this long => track fully captured

  let copied = 0;
  let lastGrowth = Date.now();
  const out = await fs.open(destPath, "w");

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let size = 0;
      try {
        size = (await fs.stat(bufferPath)).size;
      } catch {
        break; // buffer vanished
      }

      if (size < copied) break; // truncation => next song started; we have the full track

      if (size > copied) {
        const fh = await fs.open(bufferPath, "r");
        try {
          const len = size - copied;
          const buf = Buffer.allocUnsafe(len);
          await fh.read(buf, 0, len, copied);
          await out.write(buf);
        } finally {
          await fh.close();
        }
        copied = size;
        lastGrowth = Date.now();
      }

      const trackChanged = (currentTrackByPlayer.get(playerId) || track.id) !== trackKey;
      const idle = Date.now() - lastGrowth > IDLE_MS;
      if (trackChanged || idle) break;

      await delay(POLL_MS);
    }
  } finally {
    await out.close();
  }

  // No post-processing: the copied bytes are exactly the FLAC stream the player
  // decoded, so the file is valid by construction. Artist/title live in the
  // filename (the API parses them back out). Embedded tagging was removed
  // because hand-editing FLAC metadata blocks risked corrupting the stream;
  // it can be re-added later via a real FLAC/ffmpeg dependency if wanted.
  console.log(`[archive] Saved on demand: ${destName} (${copied} bytes)`);
  activeJob = null;
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
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
