// Squeezebox Tap — bindings store.
//
// Persists tag -> { playSpec, display, ... } mappings as JSON, atomically (same
// tmp+rename pattern as server/playlists.js). The tag itself is a dumb opaque
// handle; all meaning (what plays, the cover shown, enabled state) lives here and
// is editable, so re-pointing a tag is a server edit, never a physical re-write.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./state.js";
import { validatePlaySpec } from "./tapPlaySpec.js";
import { signTag, verifyTag } from "./tapToken.js";

function defaultFile() {
  if (process.env.CLOUD_SQUEEZE_TAP_TAGS_FILE) return process.env.CLOUD_SQUEEZE_TAP_TAGS_FILE;
  return path.join(config.musicSourceDir, "cloud-squeeze", "tapTags.json");
}

function newTagId() {
  return crypto.randomBytes(8).toString("base64url"); // ~11 url-safe chars, opaque + unguessable
}

// Per-tag behavior: how it plays (separate from what plays). Clamped + defaulted.
function normalizePolicy(policy = {}) {
  const playMode = policy?.playMode === "queue" ? "queue" : "replace";
  let volume = null;
  if (policy?.volume !== null && policy?.volume !== undefined && policy?.volume !== "") {
    const v = Math.round(Number(policy.volume));
    if (Number.isFinite(v)) volume = Math.max(0, Math.min(100, v));
  }
  // Smart resume (opt-in per tag): an album tag remembers where it left off and
  // picks back up there on the next tap, instead of always restarting from top.
  const resume = Boolean(policy?.resume);
  // Screen video (per tag, only acts when the global screenVideo switch is on):
  //   undefined/"" -> auto-find "<artist> <title> official video" (default)
  //   a URL string -> play that exact video
  //   "off"        -> this tag never touches the screen
  let video;
  if (typeof policy?.video === "string") {
    const v = policy.video.trim();
    if (v) video = v;
  }
  const out = { playMode, volume, resume };
  if (video !== undefined) out.video = video;
  return out;
}

// A saved playback bookmark for a resume-enabled tag. Clamped to sane values.
function normalizeResumeState(state) {
  if (!state) return null;
  const index = Math.round(Number(state.index));
  if (!Number.isFinite(index) || index < 0) return null;
  const seconds = Math.max(0, Math.round(Number(state.seconds) || 0));
  return { index, seconds, savedAt: state.savedAt || new Date().toISOString() };
}

const MAX_EVENTS = 5000; // bounded tap-history log for analytics

// Tag ids registered as fixed sub-routes before /api/tap/:id — an imported tag
// must never be allowed to claim one (or use slashes / absurd length).
const RESERVED_TAG_IDS = new Set(["analytics", "settings", "export", "import", "session", "whoami", "now", "playlists"]);
function isImportableTagId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id) && !RESERVED_TAG_IDS.has(id);
}

const DEFAULT_SETTINGS = { debounceMs: 3000, partyMode: "open", requirePassword: false, password: "", partyQueue: false, tapVolume: 75, screenVideo: false };

// Runtime Tap settings (clamped + defaulted). The password is never echoed back
// in plain form by the API — callers expose only `hasPassword`.
function normalizeSettings(s = {}) {
  const debounceRaw = Number(s?.debounceMs);
  const debounceMs = Number.isFinite(debounceRaw) ? Math.max(0, Math.min(60000, Math.round(debounceRaw))) : DEFAULT_SETTINGS.debounceMs;
  // Default loudness a tap normalizes to (0-100). A tag's own policy.volume
  // overrides it; "off" (null) means don't touch the speaker's current volume.
  let tapVolume = DEFAULT_SETTINGS.tapVolume;
  if (s?.tapVolume === null) tapVolume = null;
  else if (s?.tapVolume !== undefined && s?.tapVolume !== "") {
    const v = Math.round(Number(s.tapVolume));
    if (Number.isFinite(v)) tapVolume = Math.max(0, Math.min(100, v));
  }
  return {
    debounceMs,
    partyMode: s?.partyMode === "closed" ? "closed" : "open",
    requirePassword: Boolean(s?.requirePassword),
    password: typeof s?.password === "string" ? s.password : "",
    // Party queue: when on, every tap ADDS to the queue instead of replacing
    // playback — so a room full of people can stack records without cutting
    // each other off. A global flip, independent of each tag's own playMode.
    partyQueue: Boolean(s?.partyQueue),
    tapVolume,
    // Screen video master switch: when on, taps also play a video on the VPS
    // panel (per-tag URL, else auto-find). Off = taps never touch the screen.
    screenVideo: Boolean(s?.screenVideo)
  };
}

export function createTapStore({ file = defaultFile(), persist: persistEnabled = true } = {}) {
  const tags = new Map();
  let events = []; // [{ tagId, at }] — newest last
  let settings = { ...DEFAULT_SETTINGS };
  let persistDisabled = !persistEnabled;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed?.tags) ? parsed.tags : Object.values(parsed?.tags || {});
      for (const tag of list) {
        if (tag?.tagId) tags.set(tag.tagId, tag);
      }
      if (Array.isArray(parsed?.events)) events = parsed.events.slice(-MAX_EVENTS);
      if (parsed?.settings) settings = normalizeSettings(parsed.settings);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`[tap] could not read ${file}: ${error?.message || error} (starting empty)`);
      }
    }
  }

  function persist() {
    if (persistDisabled) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, JSON.stringify({ tags: [...tags.values()], events, settings }, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      persistDisabled = true;
      console.warn(`[tap] persistence disabled: ${error?.message || error}`);
    }
  }

  const clone = (tag) => (tag ? JSON.parse(JSON.stringify(tag)) : tag);

  load();

  return {
    create({ playSpec, display = {}, label = "", policy, savePlaylistId }) {
      const validated = validatePlaySpec(playSpec);
      if (!validated.ok) throw new Error("Invalid PlaySpec for tag");
      let tagId = newTagId();
      while (tags.has(tagId)) tagId = newTagId();
      const tag = {
        tagId,
        enabled: true,
        playSpec,
        display,
        label,
        policy: normalizePolicy(policy),
        createdAt: new Date().toISOString(),
        tapCount: 0,
        lastTappedAt: null
      };
      // A discover tag's dedicated auto-save playlist (songs it surfaces are saved
      // there → a growing discovery library).
      if (savePlaylistId) tag.savePlaylistId = String(savePlaylistId);
      tags.set(tagId, tag);
      persist();
      return clone(tag);
    },

    get(tagId) {
      return tags.has(tagId) ? clone(tags.get(tagId)) : null;
    },

    list() {
      return [...tags.values()].map(clone);
    },

    update(tagId, patch = {}) {
      const tag = tags.get(tagId);
      if (!tag) throw new Error("Unknown tag");
      if (patch.playSpec !== undefined) {
        const validated = validatePlaySpec(patch.playSpec);
        if (!validated.ok) throw new Error("Invalid PlaySpec for tag");
        tag.playSpec = patch.playSpec;
        // Re-pointing a tag invalidates any saved resume bookmark — it pointed
        // at the OLD album, so picking up "where you left off" would be wrong.
        delete tag.resumeState;
      }
      if (patch.display !== undefined) tag.display = patch.display;
      if (patch.label !== undefined) tag.label = patch.label;
      if (patch.enabled !== undefined) tag.enabled = Boolean(patch.enabled);
      if (patch.policy !== undefined) tag.policy = normalizePolicy(patch.policy);
      if (patch.savePlaylistId !== undefined) {
        if (patch.savePlaylistId) tag.savePlaylistId = String(patch.savePlaylistId);
        else delete tag.savePlaylistId;
      }
      if (patch.sun !== undefined) {
        // Opt a tag into the NTAG 424 SUN tier by giving it a 16-byte hex AES key;
        // clearing the key reverts it to the static-token path.
        const key = patch.sun && typeof patch.sun.key === "string" ? patch.sun.key.trim() : "";
        if (key) tag.sun = { key, lastCtr: Number(tag.sun?.lastCtr) || 0 };
        else delete tag.sun;
      }
      persist();
      return clone(tag);
    },

    // Advance a secure tag's last-seen SUN counter (after a verified tap).
    bumpSunCounter(tagId, ctr) {
      const tag = tags.get(tagId);
      if (!tag || !tag.sun) return;
      tag.sun.lastCtr = Math.max(Number(tag.sun.lastCtr) || 0, Number(ctr) || 0);
      persist();
    },

    // Save (or, with null, clear) a resume-enabled tag's playback bookmark.
    // Returns the updated tag, or null if the tag is gone.
    setResume(tagId, state) {
      const tag = tags.get(tagId);
      if (!tag) return null;
      const next = normalizeResumeState(state);
      if (next) tag.resumeState = next;
      else delete tag.resumeState;
      persist();
      return clone(tag);
    },

    remove(tagId) {
      const existed = tags.delete(tagId);
      if (existed) persist();
      return existed;
    },

    recordTap(tagId, at = new Date().toISOString()) {
      const tag = tags.get(tagId);
      if (!tag) throw new Error("Unknown tag");
      tag.tapCount = (tag.tapCount || 0) + 1;
      tag.lastTappedAt = at;
      events.push({ tagId, at });
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      persist();
      return clone(tag);
    },

    // Aggregate analytics for the console: totals, most-tapped tags, and a
    // per-day taps series over the trailing `days` window (oldest-first).
    analytics({ now = new Date(), days = 14, topN = 8 } = {}) {
      const today = new Date(now);
      const dayKey = (d) => d.toISOString().slice(0, 10);
      const series = [];
      const counts = new Map();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        const key = dayKey(d);
        counts.set(key, 0);
        series.push({ date: key, count: 0 });
      }
      for (const ev of events) {
        const key = String(ev?.at || "").slice(0, 10);
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      }
      for (const point of series) point.count = counts.get(point.date) || 0;

      const mostTapped = [...tags.values()]
        .filter((t) => (t.tapCount || 0) > 0)
        .sort((a, b) => (b.tapCount || 0) - (a.tapCount || 0))
        .slice(0, topN)
        .map((t) => ({ tagId: t.tagId, display: t.display, tapCount: t.tapCount || 0, kind: t.playSpec?.kind, lastTappedAt: t.lastTappedAt }));

      return {
        totalTaps: [...tags.values()].reduce((s, t) => s + (t.tapCount || 0), 0),
        totalTags: tags.size,
        windowTaps: series.reduce((s, p) => s + p.count, 0),
        series,
        mostTapped
      };
    },

    // Raw settings incl. password — internal use (resolver).
    settings() {
      return { ...settings };
    },

    // Safe settings for the admin API — never echoes the password back.
    publicSettings() {
      return { debounceMs: settings.debounceMs, partyMode: settings.partyMode, requirePassword: settings.requirePassword, hasPassword: Boolean(settings.password), partyQueue: settings.partyQueue, tapVolume: settings.tapVolume, screenVideo: settings.screenVideo };
    },

    setSettings(patch = {}) {
      // Keep the existing password if the patch omits it (so toggling other
      // settings doesn't wipe it); only change it when a string is provided.
      const next = { ...settings, ...patch };
      if (typeof patch.password !== "string") next.password = settings.password;
      settings = normalizeSettings(next);
      persist();
      return this.publicSettings();
    },

    // Full backup of the bindings + settings (tap-history is NOT exported — it's
    // runtime telemetry, not config). Importable on another instance.
    exportData() {
      return { version: 1, exportedAt: new Date().toISOString(), tags: [...tags.values()].map(clone), settings: { ...settings } };
    },

    // Import a backup. Each tag's playSpec is re-validated; invalid tags are
    // skipped (not silently kept). `replace` wipes existing tags first.
    importData(data = {}, { replace = false } = {}) {
      const incoming = Array.isArray(data?.tags) ? data.tags : [];
      if (replace) tags.clear();
      let imported = 0;
      let skipped = 0;
      for (const raw of incoming) {
        // Reject ids that aren't safe/addressable (route collisions, slashes,
        // control chars, absurd length) or carry an invalid PlaySpec.
        if (!isImportableTagId(raw?.tagId) || !validatePlaySpec(raw.playSpec).ok) { skipped++; continue; }
        const tag = {
          tagId: raw.tagId,
          enabled: raw.enabled !== false,
          playSpec: raw.playSpec,
          display: raw.display || {},
          label: raw.label || "",
          policy: normalizePolicy(raw.policy),
          createdAt: raw.createdAt || new Date().toISOString(),
          tapCount: Number(raw.tapCount) || 0,
          lastTappedAt: raw.lastTappedAt || null
        };
        // Preserve the NTAG 424 SUN security material so secure tags restore as
        // secure (not silently downgraded to static-token).
        if (raw.sun && typeof raw.sun.key === "string" && raw.sun.key.trim()) {
          tag.sun = { key: raw.sun.key.trim(), lastCtr: Number(raw.sun.lastCtr) || 0 };
        }
        tags.set(raw.tagId, tag);
        imported++;
      }
      if (data?.settings) settings = normalizeSettings(data.settings);
      persist();
      return { imported, skipped, total: tags.size };
    },

    tokenFor(tagId) {
      return signTag(tagId);
    },

    verify(tagId, token) {
      return verifyTag(tagId, token);
    }
  };
}

// Default process-wide store (persists to config.musicSourceDir/cloud-squeeze/tapTags.json,
// overridable via CLOUD_SQUEEZE_TAP_TAGS_FILE). Tests inject their own store.
export const defaultTapStore = createTapStore();
