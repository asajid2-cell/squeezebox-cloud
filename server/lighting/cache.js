// Tiny persistent JSON cache for lighting data, keyed by track. Holds the DeepSeek
// routine and (later) the beat analysis — both small, so repeat plays are instant
// and we never re-hit DeepSeek / re-analyze the same song.

import fs from "node:fs";
import path from "node:path";

const FILE = process.env.LIGHTING_CACHE_FILE
  || path.join(process.env.MUSIC_SOURCE_DIR || ".", "cloud-squeeze", "lighting-cache.json");

let store = { routines: {}, analysis: {} };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store.routines ||= {};
    store.analysis ||= {};
  } catch { /* fresh */ }
}

let writeTimer = null;
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(store));
    } catch { /* best effort */ }
  }, 500);
  if (writeTimer.unref) writeTimer.unref();
}

export function getRoutine(key) { load(); return store.routines[key] || null; }
export function setRoutine(key, spec) { load(); store.routines[key] = spec; persist(); }

export function getAnalysis(key) { load(); return store.analysis[key] || null; }
export function setAnalysis(key, data) { load(); store.analysis[key] = data; persist(); }

export function trackKey(track) {
  if (!track) return "";
  const uri = track.uri || track.id || "";
  if (uri) return String(uri);
  return `${track.artist || ""}|${track.title || ""}`.toLowerCase();
}
