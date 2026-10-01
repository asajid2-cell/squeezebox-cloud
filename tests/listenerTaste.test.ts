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

  it("reports a finalized complete through onFinalize, once, with the track uri", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-taste-"));
    const store = createListenerTasteStore(path.join(root, "taste.json"));
    const track = {
      id: "spotify:track:hook",
      title: "Hook Song",
      artist: "Hook Artist",
      source: "Spotify",
      uri: "spotify:track:hook",
      duration: 100,
      requestedBy: "alex"
    };
    const finalized: any[] = [];
    const onFinalize = (event: any) => finalized.push(event);
    const poll = (elapsed: number, status: any = { mode: "play" }) =>
      store.observePlayback({ status, track: { ...track, elapsed }, onFinalize });

    // Nothing is reported while the track is still being heard — the archive must
    // only ever learn about a listen once it is heard through, never at play-start.
    poll(0);
    poll(50);
    expect(finalized).toHaveLength(0);

    poll(99);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].type).toBe("complete");
    expect(finalized[0].id).toBeTruthy();
    expect(finalized[0].track.uri).toBe("spotify:track:hook");

    // Polling the same finished track finalizes nothing a second time.
    poll(99);
    expect(finalized).toHaveLength(1);
  });

  it("reports a part-heard track left behind as a skip, so callers can filter it out", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-taste-"));
    const store = createListenerTasteStore(path.join(root, "taste.json"));
    const track = {
      id: "spotify:track:left",
      title: "Left Song",
      artist: "Left Artist",
      source: "Spotify",
      uri: "spotify:track:left",
      duration: 100,
      requestedBy: "alex"
    };
    const finalized: any[] = [];
    const onFinalize = (event: any) => finalized.push(event);

    store.observePlayback({ status: { mode: "play" }, track: { ...track, elapsed: 0 }, onFinalize });
    store.observePlayback({ status: { mode: "play" }, track: { ...track, elapsed: 30 }, onFinalize });
    expect(finalized).toHaveLength(0);

    // The next track starts: the part-heard one closes as a skip, NOT a complete.
    // The archive must only ever be told about completes, so app.js filters on
    // the event type — this locks the type it filters on.
    store.observePlayback({
      status: { mode: "play" },
      track: { id: "spotify:track:next", title: "Next Song", source: "Spotify", uri: "spotify:track:next", duration: 100, elapsed: 0 },
      onFinalize
    });
    expect(finalized.map((event) => event.type)).toEqual(["skip"]);
  });
});
