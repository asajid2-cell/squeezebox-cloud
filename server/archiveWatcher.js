/**
 * archiveWatcher.js
 *
 * Subscribes to the LMS CLI "playlist newsong" notification for the configured
 * player (ARCHIVE_PLAYER_MAC).  When a new song starts:
 *   1. Renames $ARCHIVE_DIR/_current.flac -> "Artist - Title.flac"
 *   2. Writes Vorbis comment FLAC tags (ARTIST / TITLE / ALBUM) into the file.
 *
 * Uses the same raw TCP CLI pattern as lmsClient.js — a single persistent
 * socket with "listen 1" to receive unsolicited server notifications.
 *
 * Exported:
 *   startArchiveWatcher(lms)  — call once from index.js after the app is up.
 */

import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./state.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ARCHIVE_DIR = resolveArchiveDir();
const PLAYER_MAC = (process.env.ARCHIVE_PLAYER_MAC || "").toLowerCase().trim();

function resolveArchiveDir() {
  const raw = process.env.ARCHIVE_DIR || "./archive";
  // Expand leading ~ or %USERPROFILE% the same way state.js does.
  return raw
    .replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "")
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "")
    .replace(/\$HOME/g, process.env.HOME || process.env.USERPROFILE || "");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {import('./lmsClient.js').LmsClient} lms  – existing LmsClient instance
 */
export function startArchiveWatcher(lms) {
  if (!PLAYER_MAC) {
    console.log("[archive] ARCHIVE_PLAYER_MAC not set — archive watcher disabled.");
    return;
  }

  // Ensure the archive directory exists before we start watching.
  fs.mkdir(ARCHIVE_DIR, { recursive: true }).catch((err) => {
    console.error("[archive] Could not create ARCHIVE_DIR:", err.message);
  });

  connectAndListen(lms);
}

// ---------------------------------------------------------------------------
// Persistent CLI subscription
// ---------------------------------------------------------------------------

let reconnectTimer = null;

function connectAndListen(lms) {
  const host = lms.host || config.lmsHost;
  const port = lms.port || config.lmsCliPort;

  const socket = net.createConnection({ host, port });
  let buffer = "";

  socket.setEncoding("utf8");

  socket.on("connect", () => {
    console.log(`[archive] Connected to LMS CLI ${host}:${port} — subscribing to newsong.`);
    // Subscribe to playlist events so LMS pushes unsolicited "newsong" lines.
    socket.write("listen 1\n");
    // Scope subscription to the target player.
    socket.write(`subscribe playlist\n`);
  });

  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last fragment
    for (const line of lines) {
      handleLine(line.trim(), lms);
    }
  });

  socket.on("error", (err) => {
    console.error("[archive] CLI socket error:", err.message);
  });

  socket.on("close", () => {
    console.log("[archive] CLI socket closed — reconnecting in 10 s.");
    scheduleReconnect(lms);
  });
}

function scheduleReconnect(lms) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectAndListen(lms);
  }, 10000);
  reconnectTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Notification handler
// ---------------------------------------------------------------------------

/**
 * LMS CLI pushes lines like:
 *   aa%3Abb%3Acc%3Add%3Aee%3Aff playlist newsong 0
 *
 * We decode the player ID, check it matches the configured MAC, then fetch
 * current track metadata and archive the captured _current.flac.
 */
function handleLine(line, lms) {
  if (!line) return;

  // Decode the percent-encoded player ID from the first token.
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx < 0) return;
  const encodedPlayer = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);

  let playerId;
  try {
    playerId = decodeURIComponent(encodedPlayer).toLowerCase().trim();
  } catch {
    return;
  }

  // Only act on events from the configured player.
  if (playerId !== PLAYER_MAC) return;

  // Match "playlist newsong" events.
  if (!rest.startsWith("playlist newsong")) return;

  console.log(`[archive] newsong event for ${playerId} — archiving current FLAC.`);
  archiveCurrentTrack(lms, playerId).catch((err) => {
    console.error("[archive] archiveCurrentTrack error:", err.message);
  });
}

// ---------------------------------------------------------------------------
// Archive logic
// ---------------------------------------------------------------------------

async function archiveCurrentTrack(lms, playerId) {
  const currentPath = path.join(ARCHIVE_DIR, "_current.flac");

  // Make sure the temp file actually exists before proceeding.
  try {
    await fs.access(currentPath);
  } catch {
    console.log("[archive] _current.flac not found — nothing to archive.");
    return;
  }

  // Fetch metadata via the existing nowPlaying() method on the LmsClient.
  let track = null;
  try {
    track = await lms.nowPlaying(playerId);
  } catch (err) {
    console.error("[archive] nowPlaying() failed:", err.message);
  }

  const artist = sanitizeFilename(track?.artist || "Unknown Artist");
  const title = sanitizeFilename(track?.title || "Unknown Title");
  const album = track?.album || "";

  const destName = `${artist} - ${title}.flac`;
  const destPath = path.join(ARCHIVE_DIR, destName);

  // Write Vorbis comment tags into the copied file, then rename.
  try {
    let bytes = await fs.readFile(currentPath);
    bytes = writeVorbisComments(bytes, { artist: track?.artist || "", title: track?.title || "", album });
    await fs.writeFile(destPath, bytes);
    // Remove the temp file after successful write.
    await fs.unlink(currentPath).catch(() => null);
    console.log(`[archive] Saved: ${destName}`);
  } catch (err) {
    console.error("[archive] Failed to write archive file:", err.message);
    // Fall back to a plain rename if tag writing fails.
    try {
      await fs.rename(currentPath, destPath);
      console.log(`[archive] Renamed (no tags): ${destName}`);
    } catch (renameErr) {
      console.error("[archive] Rename fallback failed:", renameErr.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Filename sanitiser
// ---------------------------------------------------------------------------

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Unknown";
}

// ---------------------------------------------------------------------------
// Minimal FLAC Vorbis comment writer (pure JS, no extra dependency)
//
// FLAC stream layout:
//   4 bytes  : "fLaC" magic
//   4 bytes  : block header  (1 byte type+last-flag, 3 bytes length)
//   variable : STREAMINFO (always block type 0, always first)
//   …more metadata blocks…
//   audio frames
//
// We locate an existing VORBIS_COMMENT block (type 4) and replace it, or
// insert one after STREAMINFO if none exists.
// ---------------------------------------------------------------------------

const FLAC_MAGIC = Buffer.from("fLaC");
const BLOCK_TYPE_STREAMINFO = 0;
const BLOCK_TYPE_VORBIS_COMMENT = 4;

/**
 * Returns a new Buffer with ARTIST / TITLE / ALBUM Vorbis comments written.
 * If the input is not a valid FLAC file the original buffer is returned unchanged.
 *
 * @param {Buffer} buf    – raw FLAC file bytes
 * @param {{ artist: string, title: string, album: string }} tags
 * @returns {Buffer}
 */
function writeVorbisComments(buf, { artist = "", title = "", album = "" } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return buf;
  if (!buf.slice(0, 4).equals(FLAC_MAGIC)) return buf;

  // Build the new VORBIS_COMMENT block payload (little-endian per spec).
  const vendorString = Buffer.from("cloud-squeeze-archive", "utf8");
  const comments = [
    `ARTIST=${artist}`,
    `TITLE=${title}`,
    ...(album ? [`ALBUM=${album}`] : [])
  ].map((s) => Buffer.from(s, "utf8"));

  // vendor_length (4 LE) + vendor_string + user_comment_list_length (4 LE) + comments
  const commentDataLen =
    4 + vendorString.length +
    4 +
    comments.reduce((n, c) => n + 4 + c.length, 0);

  const commentData = Buffer.allocUnsafe(commentDataLen);
  let pos = 0;
  commentData.writeUInt32LE(vendorString.length, pos); pos += 4;
  vendorString.copy(commentData, pos); pos += vendorString.length;
  commentData.writeUInt32LE(comments.length, pos); pos += 4;
  for (const c of comments) {
    commentData.writeUInt32LE(c.length, pos); pos += 4;
    c.copy(commentData, pos); pos += c.length;
  }

  // Walk existing metadata blocks to find existing VORBIS_COMMENT and
  // locate the end of all metadata blocks.
  let offset = 4; // skip "fLaC"
  let vcBlockStart = -1;  // byte offset of an existing VC block header
  let vcBlockTotalLen = 0; // header (4) + data
  let lastBlockHeaderOffset = -1;
  let isLast = false;

  while (offset + 4 <= buf.length && !isLast) {
    const headerByte = buf[offset];
    isLast = Boolean(headerByte & 0x80);
    const blockType = headerByte & 0x7f;
    const blockLen = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    lastBlockHeaderOffset = offset;

    if (blockType === BLOCK_TYPE_VORBIS_COMMENT) {
      vcBlockStart = offset;
      vcBlockTotalLen = 4 + blockLen;
    }

    offset += 4 + blockLen;
  }

  // `offset` now points to the start of audio frames (or EOF if malformed).
  const audioStart = offset;

  // Build the new block header (4 bytes): type=4, last-flag depends on position.
  function makeBlockHeader(type, len, lastFlag) {
    const hdr = Buffer.allocUnsafe(4);
    hdr[0] = (lastFlag ? 0x80 : 0x00) | (type & 0x7f);
    hdr[1] = (len >> 16) & 0xff;
    hdr[2] = (len >> 8) & 0xff;
    hdr[3] = len & 0xff;
    return hdr;
  }

  if (vcBlockStart >= 0) {
    // Replace existing VORBIS_COMMENT block in place.
    const originalIsLast = Boolean(buf[vcBlockStart] & 0x80);
    const newHeader = makeBlockHeader(BLOCK_TYPE_VORBIS_COMMENT, commentDataLen, originalIsLast);
    return Buffer.concat([
      buf.slice(0, vcBlockStart),
      newHeader,
      commentData,
      buf.slice(vcBlockStart + vcBlockTotalLen)
    ]);
  }

  // No existing block — insert after the last metadata block.
  // We need to clear the last-flag on what is currently the last block,
  // and set last-flag on the new VC block.
  if (lastBlockHeaderOffset < 0) return buf; // couldn't parse — return unchanged

  const result = Buffer.from(buf); // copy so we can mutate the last-flag byte
  result[lastBlockHeaderOffset] = result[lastBlockHeaderOffset] & 0x7f; // clear last-flag

  const newHeader = makeBlockHeader(BLOCK_TYPE_VORBIS_COMMENT, commentDataLen, true);
  return Buffer.concat([
    result.slice(0, audioStart),
    newHeader,
    commentData,
    result.slice(audioStart)
  ]);
}
