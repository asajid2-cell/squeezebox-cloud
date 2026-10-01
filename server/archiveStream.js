// Thin client for the archive service's streaming-listen ingest.
//
// cloud-squeeze shares the `hlnet-cloudsqueeze` docker network with the archive,
// so it is reachable by service name. The archive only keys Spotify tracks, so
// nothing else is reported.
//
// Trigger discipline (agreed with the archive owner): call ONLY on a finalized
// qualifying listen-complete (>=85% played, or within 8s of the end) — never at
// selection or play-start. The archive dedups by track id, so a repeat listen is
// a harmless no-op and no local keyed-status pre-check is needed.
//
// Fail-soft: this is telemetry, not playback. A report must never make a poll, a
// transition, or a tap hang or fail.

const ARCHIVE_STREAM_URL = (process.env.ARCHIVE_STREAM_URL || "http://archive:4230").replace(/\/+$/, "");
const ARCHIVE_STREAM_INGEST_KEY = process.env.ARCHIVE_STREAM_INGEST_KEY || "";
const REPORT_TIMEOUT_MS = 5000;

export function streamIngestConfigured() {
  return Boolean(ARCHIVE_STREAM_INGEST_KEY);
}

// The stable `spotify:track:<id>` uri for a track, or "" when it isn't one.
export function spotifyTrackUri(track = {}) {
  const normalized = String(track?.uri || "").trim().replace(/^spotify:\/\/track:/i, "spotify:track:");
  return /^spotify:track:[A-Za-z0-9]{22}$/.test(normalized) ? normalized : "";
}

// Fire-and-forget POST of a finalized complete listen. Resolves to a small
// result object and never rejects.
export async function reportStreamListen(track = {}) {
  const uri = spotifyTrackUri(track);
  if (!uri || !streamIngestConfigured()) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${ARCHIVE_STREAM_URL}/internal/stream-listen`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-key": ARCHIVE_STREAM_INGEST_KEY },
      body: JSON.stringify({ uri }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, status: res.status, ...data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}
