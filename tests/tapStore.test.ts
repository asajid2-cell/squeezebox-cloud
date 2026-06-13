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
  it("refuses the public dev secret in production (no forgeable tokens)", () => {
    const orig = process.env.NODE_ENV;
    const s = process.env.TAP_TOKEN_SECRET;
    const h = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH;
    delete process.env.TAP_TOKEN_SECRET;
    delete process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH;
    process.env.NODE_ENV = "production";
    try {
      expect(() => signTag("x")).toThrow(/production/i);
    } finally {
      process.env.NODE_ENV = orig;
      if (s) process.env.TAP_TOKEN_SECRET = s;
      if (h) process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD_HASH = h;
    }
  });

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

  it("defaults the policy and normalizes/clamps it on create + update", () => {
    const store = createTapStore({ file, persist: false });
    const a = store.create({ playSpec: spec(), display });
    expect(a.policy).toEqual({ playMode: "replace", volume: null });

    const b = store.create({ playSpec: spec(), display, policy: { playMode: "queue", volume: 250 } });
    expect(b.policy).toEqual({ playMode: "queue", volume: 100 }); // clamped to 100

    const updated = store.update(b.tagId, { policy: { playMode: "replace", volume: -5 } });
    expect(updated.policy).toEqual({ playMode: "replace", volume: 0 }); // clamped to 0
  });

  it("aggregates analytics: totals, most-tapped, and a per-day series", () => {
    const store = createTapStore({ file, persist: false });
    const a = store.create({ playSpec: spec(), display: { title: "A" } });
    const b = store.create({ playSpec: spec(), display: { title: "B" } });
    const now = new Date("2026-06-12T12:00:00Z");
    const day = (offset: number) => new Date(now.getTime() - offset * 86400000).toISOString();
    store.recordTap(a.tagId, day(0));
    store.recordTap(a.tagId, day(0));
    store.recordTap(a.tagId, day(1));
    store.recordTap(b.tagId, day(2));

    const an = store.analytics({ now, days: 7 });
    expect(an.totalTaps).toBe(4);
    expect(an.windowTaps).toBe(4);
    expect(an.mostTapped[0]).toMatchObject({ tagId: a.tagId, tapCount: 3 });
    expect(an.series).toHaveLength(7);
    expect(an.series.at(-1)).toMatchObject({ date: "2026-06-12", count: 2 });
    expect(an.series.at(-2)).toMatchObject({ date: "2026-06-11", count: 1 });
  });

  it("manages runtime settings (defaults, clamp, password kept hidden + preserved)", () => {
    const store = createTapStore({ file, persist: false });
    expect(store.publicSettings()).toEqual({ debounceMs: 3000, partyMode: "open", requirePassword: false, hasPassword: false });

    const pub = store.setSettings({ debounceMs: 99999, partyMode: "closed", requirePassword: true, password: "sesame" });
    expect(pub).toEqual({ debounceMs: 60000, partyMode: "closed", requirePassword: true, hasPassword: true }); // clamped
    expect(pub).not.toHaveProperty("password");
    expect(store.settings().password).toBe("sesame");

    // Toggling another setting must NOT wipe the password.
    store.setSettings({ partyMode: "open" });
    expect(store.settings().password).toBe("sesame");
  });

  it("exports + re-imports bindings (round-trip), skipping invalid playSpecs", () => {
    const store = createTapStore({ file, persist: false });
    const a = store.create({ playSpec: spec(), display: { title: "A" }, policy: { playMode: "queue", volume: 40 } });
    store.setSettings({ partyMode: "closed" });
    const dump = store.exportData();
    expect(dump.tags).toHaveLength(1);
    expect(dump.settings.partyMode).toBe("closed");

    const fresh = createTapStore({ file: `${file}.2`, persist: false });
    const result = fresh.importData({ ...dump, tags: [...dump.tags, { tagId: "bad", playSpec: { kind: "nope" } }] });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(fresh.get(a.tagId)?.policy).toEqual({ playMode: "queue", volume: 40 });
    expect(fresh.publicSettings().partyMode).toBe("closed");
  });

  it("replace import wipes existing tags first", () => {
    const store = createTapStore({ file, persist: false });
    store.create({ playSpec: spec(), display });
    store.importData({ tags: [{ tagId: "abcdef", playSpec: spec() }] }, { replace: true });
    expect(store.list()).toHaveLength(1);
    expect(store.get("abcdef")).toBeTruthy();
  });

  it("import preserves SUN security material (secure tag stays secure)", () => {
    const store = createTapStore({ file, persist: false });
    store.importData({ tags: [{ tagId: "secure01", playSpec: spec(), sun: { key: "00112233445566778899aabbccddeeff", lastCtr: 7 } }] });
    expect(store.get("secure01")?.sun).toEqual({ key: "00112233445566778899aabbccddeeff", lastCtr: 7 });
  });

  it("import rejects reserved route names, slashes, and absurd ids", () => {
    const store = createTapStore({ file, persist: false });
    const res = store.importData({ tags: [
      { tagId: "analytics", playSpec: spec() },
      { tagId: "settings", playSpec: spec() },
      { tagId: "a/b/c", playSpec: spec() },
      { tagId: "x".repeat(200), playSpec: spec() },
      { tagId: "goodid01", playSpec: spec() }
    ] });
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(4);
    expect(store.get("goodid01")).toBeTruthy();
    expect(store.get("analytics")).toBeNull();
  });
});
