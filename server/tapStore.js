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
  return { playMode, volume };
}

const MAX_EVENTS = 5000; // bounded tap-history log for analytics

const DEFAULT_SETTINGS = { debounceMs: 3000, partyMode: "open", requirePassword: false, password: "" };

// Runtime Tap settings (clamped + defaulted). The password is never echoed back
// in plain form by the API — callers expose only `hasPassword`.
function normalizeSettings(s = {}) {
  const debounceRaw = Number(s?.debounceMs);
  const debounceMs = Number.isFinite(debounceRaw) ? Math.max(0, Math.min(60000, Math.round(debounceRaw))) : DEFAULT_SETTINGS.debounceMs;
  return {
    debounceMs,
    partyMode: s?.partyMode === "closed" ? "closed" : "open",
    requirePassword: Boolean(s?.requirePassword),
    password: typeof s?.password === "string" ? s.password : ""
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
    create({ playSpec, display = {}, label = "", policy }) {
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
      }
      if (patch.display !== undefined) tag.display = patch.display;
      if (patch.label !== undefined) tag.label = patch.label;
      if (patch.enabled !== undefined) tag.enabled = Boolean(patch.enabled);
      if (patch.policy !== undefined) tag.policy = normalizePolicy(patch.policy);
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
      return { debounceMs: settings.debounceMs, partyMode: settings.partyMode, requirePassword: settings.requirePassword, hasPassword: Boolean(settings.password) };
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
        if (!raw?.tagId || !validatePlaySpec(raw.playSpec).ok) { skipped++; continue; }
        tags.set(raw.tagId, {
          tagId: raw.tagId,
          enabled: raw.enabled !== false,
          playSpec: raw.playSpec,
          display: raw.display || {},
          label: raw.label || "",
          policy: normalizePolicy(raw.policy),
          createdAt: raw.createdAt || new Date().toISOString(),
          tapCount: Number(raw.tapCount) || 0,
          lastTappedAt: raw.lastTappedAt || null
        });
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
