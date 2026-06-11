import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createListenerTasteStore } from "../server/listenerTaste.js";

describe("listener taste store", () => {
  it("persists play, skip, complete, and replay events with profile aggregates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-taste-"));
    const file = path.join(root, "taste.json");
    const store = createListenerTasteStore(file);
    const track = {
      id: "spotify:track:test",
      title: "Signal Song",
      artist: "Signal Artist",
      album: "Signal Album",
      source: "Spotify",
      uri: "spotify:track:test",
      duration: 100,
      elapsed: 0,
      requestedBy: "alex"
    };

    store.observePlayback({
      status: { mode: "play" },
      track,
      context: { seed: "Signal Artist", playbackMode: "smartQueue" }
    });
    store.observePlayback({
      status: { mode: "play" },
      track: { ...track, elapsed: 20 },
      context: { seed: "Signal Artist", playbackMode: "smartQueue" }
    });
    store.recordSkip({ ...track, elapsed: 20 }, { reason: "transport.next" });
    store.recordReplay({ ...track, elapsed: 30 }, { reason: "transport.previous.restart" });
    store.observePlayback({
      status: { mode: "play" },
      track: { ...track, elapsed: 99 },
      context: { seed: "Signal Artist", playbackMode: "smartQueue" }
    });

    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.events.map((event: { type: string }) => event.type)).toEqual([
      "play",
      "skip",
      "replay",
      "play",
      "complete"
    ]);
    expect(persisted.listeners.alex.totals).toMatchObject({
      events: 5,
      plays: 2,
      skips: 1,
      completes: 1,
      replays: 1
    });
    expect(persisted.listeners.alex.artists["signal artist"].score).toBeGreaterThan(0);
  });

  it("does not duplicate a completion while polling the same finished track", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-taste-"));
    const file = path.join(root, "taste.json");
    const store = createListenerTasteStore(file);
    const track = {
      id: "spotify:track:tail",
      title: "Tail Song",
      artist: "Tail Artist",
      source: "Spotify",
      uri: "spotify:track:tail",
      duration: 100,
      requestedBy: "alex"
    };

    store.observePlayback({ status: { mode: "play" }, track: { ...track, elapsed: 0 } });
    store.observePlayback({ status: { mode: "play" }, track: { ...track, elapsed: 96 } });
    store.observePlayback({ status: { mode: "play" }, track: { ...track, elapsed: 99 } });

    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.events.map((event: { type: string }) => event.type)).toEqual(["play", "complete"]);
  });
});
