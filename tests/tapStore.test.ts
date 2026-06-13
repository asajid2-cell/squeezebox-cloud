import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createTapStore } from "../server/tapStore.js";
import { signTag, verifyTag } from "../server/tapToken.js";

let file: string;
beforeEach(() => {
  file = path.join(os.tmpdir(), `tap-tags-${crypto.randomBytes(6).toString("hex")}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(file); } catch { /* ignore */ }
});

const display = { title: "Punisher", artist: "Phoebe Bridgers", art: "https://img/x.jpg", kind: "album" };
function spec() {
  return { kind: "album-from-top", source: "spotify", albumUri: "spotify:album:xyz789" };
}

describe("Tap token", () => {
  it("verifies a token it signed and rejects tampering", () => {
    const token = signTag("abc123");
    expect(verifyTag("abc123", token)).toBe(true);
    expect(verifyTag("abc124", token)).toBe(false); // different tag id
    expect(verifyTag("abc123", token + "x")).toBe(false); // tampered token
    expect(verifyTag("abc123", "")).toBe(false);
    expect(verifyTag("", token)).toBe(false);
  });
});

describe("Tap store", () => {
  it("creates a tag with an opaque id, a token, and enabled state", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display, label: "Punisher sleeve" });
    expect(tag.tagId).toMatch(/^[A-Za-z0-9_-]{6,}$/);
    expect(tag.enabled).toBe(true);
    expect(tag.tapCount).toBe(0);
    expect(tag.playSpec).toEqual(spec());
    expect(tag.display).toEqual(display);
    expect(verifyTag(tag.tagId, store.tokenFor(tag.tagId))).toBe(true);
  });

  it("rejects an invalid PlaySpec at create time", () => {
    const store = createTapStore({ file });
    expect(() => store.create({ playSpec: { kind: "album-from-top" }, display })).toThrow(/playspec|invalid/i);
  });

  it("gets a tag and returns null for unknown ids", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display });
    expect(store.get(tag.tagId)?.tagId).toBe(tag.tagId);
    expect(store.get("nope")).toBeNull();
  });

  it("generates unique ids across many creates", () => {
    const store = createTapStore({ file, persist: false }); // in-memory: this checks id uniqueness, not disk
    const ids = new Set(Array.from({ length: 50 }, () => store.create({ playSpec: spec(), display }).tagId));
    expect(ids.size).toBe(50);
  });

  it("re-points a tag (new PlaySpec + refreshed display) without changing the id or token", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display });
    const token = store.tokenFor(tag.tagId);
    const newSpec = { kind: "track", track: { uri: "spotify:track:0123456789abcdefghijAB" } };
    const newDisplay = { title: "Kyoto", artist: "Phoebe Bridgers", kind: "track" };
    const updated = store.update(tag.tagId, { playSpec: newSpec, display: newDisplay });
    expect(updated.tagId).toBe(tag.tagId);
    expect(updated.playSpec).toEqual(newSpec);
    expect(updated.display).toEqual(newDisplay);
    expect(store.tokenFor(tag.tagId)).toBe(token); // token is derived from id, unchanged
  });

  it("disables a tag without deleting it", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display });
    const updated = store.update(tag.tagId, { enabled: false });
    expect(updated.enabled).toBe(false);
    expect(store.get(tag.tagId)?.enabled).toBe(false);
  });

  it("records a tap (increments count + stamps lastTappedAt)", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display });
    const after = store.recordTap(tag.tagId);
    expect(after.tapCount).toBe(1);
    expect(typeof after.lastTappedAt).toBe("string");
    store.recordTap(tag.tagId);
    expect(store.get(tag.tagId)?.tapCount).toBe(2);
  });

  it("persists atomically across store instances", () => {
    const storeA = createTapStore({ file });
    const tag = storeA.create({ playSpec: spec(), display, label: "keep me" });
    const storeB = createTapStore({ file });
    const reloaded = storeB.get(tag.tagId);
    expect(reloaded?.tagId).toBe(tag.tagId);
    expect(reloaded?.label).toBe("keep me");
    expect(reloaded?.playSpec).toEqual(spec());
  });
});

describe("Tap store — QoL: party queue, smart resume", () => {
  it("defaults party queue OFF and round-trips the global toggle", () => {
    const store = createTapStore({ file });
    expect(store.publicSettings().partyQueue).toBe(false);
    expect(store.setSettings({ partyQueue: true }).partyQueue).toBe(true);
    expect(store.settings().partyQueue).toBe(true);
    // Reloads from disk preserve it.
    expect(createTapStore({ file }).publicSettings().partyQueue).toBe(true);
  });

  it("defaults a tag's resume policy OFF and lets it be enabled per tag", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display });
    expect(tag.policy.resume).toBe(false);
    const updated = store.update(tag.tagId, { policy: { resume: true } });
    expect(updated.policy.resume).toBe(true);
  });

  it("saves and clears a resume bookmark, clamping bad input", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display, policy: { resume: true } });
    const saved = store.setResume(tag.tagId, { index: 4, seconds: 92 });
    expect(saved?.resumeState).toMatchObject({ index: 4, seconds: 92 });
    expect(typeof saved?.resumeState.savedAt).toBe("string");
    // Negative/garbage -> treated as "clear".
    expect(store.setResume(tag.tagId, { index: -1 })?.resumeState).toBeUndefined();
    store.setResume(tag.tagId, { index: 2, seconds: 5 });
    expect(store.setResume(tag.tagId, null)?.resumeState).toBeUndefined();
  });

  it("drops the resume bookmark when the tag is re-pointed (it pointed at the old album)", () => {
    const store = createTapStore({ file });
    const tag = store.create({ playSpec: spec(), display, policy: { resume: true } });
    store.setResume(tag.tagId, { index: 3, seconds: 40 });
    const newSpec = { kind: "album-from-top", source: "spotify", albumUri: "spotify:album:NEWalbum1" };
    const updated = store.update(tag.tagId, { playSpec: newSpec });
    expect(updated.resumeState).toBeUndefined();
  });
});
