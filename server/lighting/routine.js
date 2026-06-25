// Resolve a lighting routine for a track: curated theme → cached → DeepSeek → fallback.
// Returns a scene spec the phone's engine understands (no beats yet; Phase 4 adds them).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { designRoutine } from "./deepseekClient.js";
import { getRoutine, setRoutine, trackKey } from "./cache.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Hand-tuned themes for favorites win over everything. Keyed loosely by
// "artist" or "artist - album" or "artist - title" (lowercased substring match).
let curated = {};
try {
  curated = JSON.parse(fs.readFileSync(path.join(__dir, "themes.json"), "utf8"));
} catch { /* none */ }

const FALLBACK = { mode: "drift", palette: ["ff8800", "ffd1a0", "ff5500", "ffb46b"], bpm: 0, speed: 0.4, energy: 0.4, brightness: 190, source: "fallback" };

function curatedMatch(track) {
  const a = (track.artist || "").toLowerCase();
  const al = (track.album || "").toLowerCase();
  const t = (track.title || "").toLowerCase();
  for (const [keyword, spec] of Object.entries(curated)) {
    const k = keyword.toLowerCase();
    if (a.includes(k) || `${a} - ${al}`.includes(k) || `${a} - ${t}`.includes(k) || al.includes(k) || t.includes(k)) {
      return { ...spec, source: "curated" };
    }
  }
  return null;
}

/**
 * @returns {Promise<object>} scene spec { mode, palette, bpm, speed, energy, brightness, source }
 */
export async function resolveRoutine(track, { paletteHint = [], fresh = false } = {}) {
  const key = trackKey(track);

  const curatedSpec = curatedMatch(track);
  if (curatedSpec) return curatedSpec;

  if (!fresh) {
    const cached = key && getRoutine(key);
    if (cached) return { ...cached, source: "cache" };
  }

  const designed = await designRoutine(track, paletteHint);
  if (designed) {
    const spec = { ...designed, source: "deepseek" };
    if (key) setRoutine(key, spec);
    return spec;
  }

  return { ...FALLBACK };
}
