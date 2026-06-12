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

export function createTapStore({ file = defaultFile(), persist: persistEnabled = true } = {}) {
  const tags = new Map();
  let persistDisabled = !persistEnabled;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed?.tags) ? parsed.tags : Object.values(parsed?.tags || {});
      for (const tag of list) {
        if (tag?.tagId) tags.set(tag.tagId, tag);
      }
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
      fs.writeFileSync(tmp, JSON.stringify({ tags: [...tags.values()] }, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      persistDisabled = true;
      console.warn(`[tap] persistence disabled: ${error?.message || error}`);
    }
  }

  const clone = (tag) => (tag ? JSON.parse(JSON.stringify(tag)) : tag);

  load();

  return {
    create({ playSpec, display = {}, label = "" }) {
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
      persist();
      return clone(tag);
    },

    remove(tagId) {
      const existed = tags.delete(tagId);
      if (existed) persist();
      return existed;
    },

    recordTap(tagId) {
      const tag = tags.get(tagId);
      if (!tag) throw new Error("Unknown tag");
      tag.tapCount = (tag.tapCount || 0) + 1;
      tag.lastTappedAt = new Date().toISOString();
      persist();
      return clone(tag);
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
