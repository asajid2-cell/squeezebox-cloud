// The lighting director: turns "what's playing" into "what the strip does."
//
// Progressive enhancement:
//   stage 1 (instant)  — resolve a routine (curated/cache/DeepSeek) and push it NOW,
//                        using the LLM's bpm estimate. Zero wait.
//   stage 2 (upgrade)  — [Phase 4] a background worker fetches the real beat grid and
//                        re-pushes the same scene with beats[] for tight beat-sync.
//
// Per-tag overrides (policy.lighting) beat global settings (settings.lighting). Both
// are passed in by the caller (the tap flow / track-change hook) — this module stays
// decoupled from tapStore.

import { resolveRoutine } from "./routine.js";
import { trackKey } from "./cache.js";
import { pushScene, ledOff, deviceOnline } from "./hubClient.js";
import { requestBeats } from "./beats.js";

const state = {
  key: "",          // track currently expressed on the strip
  busy: false,      // a resolve/push is in flight
  lastSpec: null,
  posMs0: 0,        // playback position at the stage-1 push...
  anchorMs: 0       // ...captured at this wall-clock, to extrapolate "now" for stage 2
};

function mergeOverrides(spec, policy, settings) {
  const out = { ...spec };
  if (policy && policy.mode) out.mode = policy.mode;
  if (policy && Array.isArray(policy.palette) && policy.palette.length) {
    out.palette = policy.palette.map((c) => String(c).replace(/^#/, "").toLowerCase());
  }
  const b = (policy && policy.brightness != null) ? policy.brightness
    : (settings && settings.brightness != null) ? settings.brightness
    : out.brightness;
  out.brightness = Math.max(8, Math.min(255, Number(b) || out.brightness));
  return out;
}

function lightingOn(policy, settings) {
  if (policy && policy.enabled === false) return false;       // this tag opts out
  if (settings && settings.enabled === false) return false;   // master off
  return true;
}

/**
 * Express the current track on the strip.
 * @param track     now-playing { title, artist, album, year, uri/id }
 * @param opts      { posMs, policy (tag.policy.lighting), settings (global lighting), force }
 */
export async function onTrack(track, { posMs = 0, policy = null, settings = null, force = false } = {}) {
  if (!track || !track.title) return { ok: false, skipped: "no-track" };
  if (!lightingOn(policy, settings)) return { ok: false, skipped: "disabled" };

  const key = trackKey(track);
  if (!force && key && key === state.key) return { ok: true, skipped: "same-track" };
  if (state.busy) return { ok: false, skipped: "busy" };
  state.busy = true;
  try {
    if (!(await deviceOnline())) return { ok: false, skipped: "device-offline" };
    const base = await resolveRoutine(track);
    const spec = mergeOverrides(base, policy, settings);
    const scene = {
      mode: spec.mode, palette: spec.palette, bpm: spec.bpm,
      speed: spec.speed, energy: spec.energy, brightness: spec.brightness,
      posMs: Math.max(0, Math.round(posMs))
    };
    const res = await pushScene(scene);
    if (res && res.ok) {
      state.key = key; state.lastSpec = spec; state.posMs0 = scene.posMs; state.anchorMs = Date.now();
      // Stage 2: upgrade to phase-locked beat-sync once the real grid is ready.
      const beatSync = !(policy && policy.beatSync === false) && !(settings && settings.beatSync === false);
      if (beatSync) requestBeats(track, (grid) => applyBeats(key, spec, grid));
    }
    return { ok: !!(res && res.ok), source: base.source, mode: spec.mode, palette: spec.palette, res };
  } finally {
    state.busy = false;
  }
}

// Re-push the scene as a phase-locked pulse using the real beat grid. Position is
// extrapolated from the stage-1 anchor so the beats line up with where the song is now.
async function applyBeats(key, spec, grid) {
  if (key !== state.key || !grid || !Array.isArray(grid.beats) || !grid.beats.length) return;
  const posMs = Math.max(0, (state.posMs0 || 0) + (Date.now() - (state.anchorMs || Date.now())));
  await pushScene({
    mode: "pulse",
    palette: spec.palette,
    bpm: Math.round(grid.tempo || spec.bpm || 0),
    speed: spec.speed,
    energy: spec.energy,
    brightness: spec.brightness,
    beats: grid.beats,
    sections: grid.sections || [],
    posMs
  });
}

/** Nothing playing: rest the strip per the global idle setting. */
export async function onIdle(settings = null) {
  state.key = "";
  if (!lightingOn(null, settings)) return;
  const idle = settings && settings.idle;
  if (idle === "ambient") {
    await pushScene({ mode: "breathe", palette: ["ffb46b"], bpm: 0, speed: 0.3,
      brightness: Math.max(8, Math.min(255, (settings && settings.brightness) || 120)), posMs: 0 });
  } else {
    await ledOff();
  }
}

export function currentKey() { return state.key; }

export const director = { onTrack, onIdle, currentKey };
