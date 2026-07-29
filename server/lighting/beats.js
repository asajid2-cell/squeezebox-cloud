// Real beat grid for a track, from the harmonizer librosa analyzer (/api/beatgrid).
// Background worker: sequential + throttled so we never hammer the analyzer, and
// cached (light JSON) so a song is only ever downloaded + analyzed once.

import { getAnalysis, setAnalysis, trackKey } from "./cache.js";

const HARMONIZER_URL = (process.env.HARMONIZER_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const SPOTIFY_RE = /track[:/]([A-Za-z0-9]+)/;

const queue = [];
let working = false;

async function fetchBeatgrid(track) {
  const m = SPOTIFY_RE.exec(String(track.uri || track.id || ""));
  if (!m) return null;                       // only Spotify tracks are analyzable via spotdl
  const body = { spotifyUrl: `spotify:track:${m[1]}`, title: track.title, artist: track.artist };
  const res = await fetch(`${HARMONIZER_URL}/api/beatgrid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)       // first analysis includes a download
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j.ok || !Array.isArray(j.beats) || j.beats.length === 0) return null;
  return { tempo: j.tempo || 0, duration: j.duration || 0, beats: j.beats, sections: Array.isArray(j.sections) ? j.sections : [] };
}

/**
 * Request the beat grid for a track. Calls cb(grid) once — immediately if cached,
 * else after the background analysis completes. No-op for non-Spotify tracks.
 */
export function requestBeats(track, cb) {
  const key = trackKey(track);
  if (!key || !SPOTIFY_RE.test(String(track.uri || track.id || ""))) return;
  const cached = getAnalysis(key);
  if (cached) { try { cb(cached); } catch { /* ignore */ } return; }
  if (queue.some((j) => j.key === key)) return;   // already queued
  queue.push({ track, key, cb });
  pump();
}

async function pump() {
  if (working) return;
  const job = queue.shift();
  if (!job) return;
  working = true;
  try {
    const grid = await fetchBeatgrid(job.track);
    if (grid) {
      setAnalysis(job.key, grid);
      try { job.cb(grid); } catch { /* ignore */ }
    }
  } catch { /* analyzer offline / failed — stay on the tempo-estimate pulse */ }
  finally {
    working = false;
    if (queue.length) setTimeout(pump, 1500);   // throttle between analyses
  }
}
