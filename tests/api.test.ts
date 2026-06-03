import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp, maintainVisiblePlaybackQueueForTests, nextQueueItemForPlayback, refreshLmsForTests, resetRefreshStateForTests, sameContinuingPlayback, shouldNudgePlayback, syncVisibleQueueWithCurrentTrack } from "../server/app.js";
import { addQueueItem, appState, config, removeQueueItem, updateNowPlaying, updateSpotifyStatus } from "../server/state.js";

const mockLms = {
  async status() {
    return {
      id: "player-1",
      name: "Test Speaker",
      connected: true,
      online: true,
      mode: "play",
      volume: 44,
      detail: "test player connected"
    };
  },
  async nowPlaying() {
    return {
      id: "track-1",
      title: "Test Song",
      artist: "Test Artist",
      album: "Test Album",
      duration: 100,
      elapsed: 20,
      canSeek: true,
      art: "api/artwork/test-cover",
      source: "LMS"
    };
  },
  async control() {
    return "ok";
  },
  async playTrack() {
    return "ok";
  },
  async spotifySearch() {
    return [{ id: "spotify:1", title: "Headlines", artist: "Drake", source: "Spotify", uri: "spotify:track:0000000000000000000101", kind: "track" }];
  },
  async spotifyLibrary() {
    return [{ id: "spotify:playlist:1", title: "Test Playlist", artist: "Spotify", source: "Spotify playlist", uri: "spotify:playlist:1", kind: "playlist" }];
  },
  async spotifyChildren() {
    return [{ id: "spotify:track:0000000000000000000102", title: "Playlist Track", artist: "Spotify", source: "Spotify", uri: "spotify:track:0000000000000000000102", kind: "track" }];
  },
  async artwork() {
    return { contentType: "image/jpeg", bytes: Buffer.from("fake-jpeg") };
  },
  async spotifyStatus() {
    return { configured: true, reachable: true, detail: "Spotty detected" };
  },
  async musicInfoStatus() {
    return { configured: false, reachable: true, detail: "Plugin not enabled" };
  },
  async rescanLibrary() {
    return { result: {} };
  }
};

describe("Cloud Squeeze API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns speaker and now playing state", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/state").expect(200);
    expect(response.body.player.connected).toBe(true);
    expect(response.body.nowPlaying.title).toBe("Test Song");
  });

  it("accepts the full local search limit used by typed library searches", async () => {
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-full-search-"));
    config.musicSourceDir = root;
    try {
      await fs.writeFile(path.join(root, "Artist - Search Match.mp3"), "ID3");
      const response = await request(createApp({ lms: mockLms }))
        .get("/api/library/search?q=match&limit=2000&source=local")
        .expect(200);

      expect(response.body.results).toEqual([expect.objectContaining({ title: "Search Match" })]);
      await request(createApp({ lms: mockLms }))
        .get("/api/library/search?q=match&limit=2001&source=local")
        .expect(400);
    } finally {
      config.musicSourceDir = previousMusicDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns bounded LMS artwork enrichment for local search rows", async () => {
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-art-search-"));
    config.musicSourceDir = root;
    try {
      const trackPath = path.join(root, "Artist - Art Match.mp3");
      await fs.writeFile(trackPath, "ID3");
      const response = await request(createApp({
        lms: {
          ...mockLms,
          async enrichLocalArtwork(tracks: Array<{ title: string; path?: string }>) {
            return tracks.map((track) => ({ ...track, art: "api/artwork/local-cover" }));
          }
        }
      }))
        .get("/api/library/search?q=art&limit=10&source=local")
        .expect(200);

      expect(response.body.results[0]).toMatchObject({ title: "Art Match", art: "api/artwork/local-cover" });
    } finally {
      config.musicSourceDir = previousMusicDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prewarms the Spotify library tabs exposed in the UI during state refresh", async () => {
    resetRefreshStateForTests();
    const calls: string[] = [];
    const childCalls: Array<{ title?: string; uri?: string }> = [];
    const searchCalls: Array<{ query: string; limit: number }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async spotifySearch(_playerId: string, query: string, limit: number) {
          searchCalls.push({ query, limit });
          return [];
        },
        async spotifyLibrary(_playerId: string, type: string) {
          calls.push(type);
          if (type === "playlists") {
            return [
              { title: "First Playlist", uri: "spotify:playlist:first", kind: "playlist", browseId: "8.0" },
              { title: "Second Playlist", uri: "spotify:playlist:second", kind: "playlist", browseId: "8.1" }
            ];
          }
          if (type === "home") {
            return [
              { title: "First Playlist Duplicate", uri: "spotify:playlist:first", kind: "playlist", browseId: "0.0" },
              { title: "Daily Mix", uri: "spotify:playlist:daily", kind: "playlist", browseId: "0.1" }
            ];
          }
          if (type === "artists") {
            return [
              { title: "Ado", uri: "spotify:artist:ado", kind: "artist", browseId: "7.0" },
              { title: "Aimer", uri: "spotify:artist:aimer", kind: "artist", browseId: "7.1" },
              { title: "Ado Duplicate", uri: "spotify:artist:ado", kind: "artist", browseId: "7.2" }
            ];
          }
          return [];
        },
        async spotifyChildren(_playerId: string, item: { title?: string; uri?: string }) {
          childCalls.push(item);
          return [];
        }
      }
    });

    await request(app).get("/api/state").expect(200);
    await vi.waitFor(() => expect(childCalls).toHaveLength(5));
    await vi.waitFor(() => expect(searchCalls).toEqual(expect.arrayContaining([
      { query: "drake", limit: 50 },
      { query: "juice wrld", limit: 50 },
      { query: "the weeknd", limit: 50 },
      { query: "travis scott", limit: 50 }
    ])));

    expect(calls).toEqual(expect.arrayContaining(["playlists", "home", "artists", "tracks"]));
    expect(childCalls.map((item) => item.uri)).toEqual(expect.arrayContaining([
      "spotify:playlist:first",
      "spotify:playlist:second",
      "spotify:playlist:daily",
      "spotify:artist:ado",
      "spotify:artist:aimer"
    ]));
  });

  it("adds queue items and rejects duplicates", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const payload = { title: "Unit Test Track", artist: "Tester", path: "/music/test/unit-test-track.mp3", requestedBy: "vitest" };
    const created = await request(app).post("/api/queue").send(payload).expect(201);
    expect(created.body.title).toBe(payload.title);
    expect(created.body.requestedBy).toBe("guest");
    await request(app).post("/api/queue").send(payload).expect(409);
  });

  it("deduplicates direct queue posts by playable key instead of title", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });

    await request(app)
      .post("/api/queue")
      .send({ title: "Same Title", artist: "Artist A", path: "/music/test/same-title-a.mp3" })
      .expect(201);
    await request(app)
      .post("/api/queue")
      .send({ title: "Same Title", artist: "Artist B", path: "/music/test/same-title-b.mp3" })
      .expect(201);
    await request(app)
      .post("/api/queue")
      .send({ title: "Renamed Same File", artist: "Artist C", path: "/music/test/same-title-a.mp3" })
      .expect(409);

    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Same Title", "Same Title"]);
  });

  it("clears the visible queue and disables generated queue modes", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: true, lastShuffleRefillAt: 123, lastShuffleSeed: "stale", lastSmartQueueBase: "stale" };
    addQueueItem({ title: "Manual Leftover", artist: "Tester", path: "/music/test/manual-leftover.mp3", requestedBy: "guest" });
    addQueueItem({ title: "Generated Leftover", artist: "Tester", uri: "spotify:track:0000000000000000000301", source: "Spotify", requestedBy: "smart shuffle" });

    const response = await request(createApp({ lms: mockLms })).delete("/api/queue").expect(200);

    expect(response.body.removed.map((item: { title: string }) => item.title)).toEqual(["Manual Leftover", "Generated Leftover"]);
    expect(response.body.queue).toEqual([]);
    expect(response.body.playback).toMatchObject({ shuffle: false, smartQueue: false, lastShuffleRefillAt: 0, lastShuffleSeed: "", lastSmartQueueBase: "" });
    expect(appState.queue).toEqual([]);
  });

  it("trims queue text fields and rejects whitespace-only titles", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    await request(app).post("/api/queue").send({ title: "   ", artist: "Tester" }).expect(400);

    const created = await request(app)
      .post("/api/queue")
      .send({ title: "  Trimmed Track  ", artist: "  Trimmed Artist  ", path: "  /music/test/trimmed-track.mp3  ", requestedBy: "  guest  " })
      .expect(201);

    expect(created.body).toMatchObject({ title: "Trimmed Track", artist: "Trimmed Artist", requestedBy: "guest" });
  });

  it("rejects text-only queue rows that transport cannot play", async () => {
    appState.queue.splice(0, appState.queue.length);
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/queue")
      .send({ title: "Text Only", artist: "Tester" })
      .expect(400);

    expect(response.body.error).toBe("Playable local path, LMS track id, or Spotify URI is required");
    expect(appState.queue).toHaveLength(0);
  });

  it("rejects malformed direct queue item fields before mutating queue state", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });

    await request(app).post("/api/queue").send({ title: "Extra Queue", path: "/music/test/extra-queue.mp3", extra: true }).expect(400);
    await request(app).post("/api/queue").send({ title: "Array Path Queue", path: [] }).expect(400);
    await request(app).post("/api/queue").send({ title: "Object Id Queue", lmsTrackId: { x: 1 } }).expect(400);
    await request(app).post("/api/queue").send({ title: "Array Uri Queue", uri: ["spotify:track:0000000000000000000101"], kind: "track", source: "Spotify" }).expect(400);

    expect(appState.queue).toHaveLength(0);
  });

  it("rejects nonexistent local paths when strict public validation is enabled", async () => {
    appState.queue.splice(0, appState.queue.length);
    const previousStrict = process.env.STRICT_PUBLIC_TRACK_VALIDATION;
    const previousMusicDir = config.musicSourceDir;
    const previousUploadDir = config.uploadDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-strict-paths-"));
    const uploads = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-strict-uploads-"));
    const realPath = path.join(root, "real.mp3");
    await fs.writeFile(realPath, Buffer.from("ID3"));
    process.env.STRICT_PUBLIC_TRACK_VALIDATION = "1";
    config.musicSourceDir = root;
    config.uploadDir = uploads;
    try {
      const app = createApp({ lms: mockLms });
      await request(app)
        .post("/api/player/track")
        .send({ action: "add-queue", track: { title: "Missing Local", artist: "Tester", path: path.join(root, "missing.mp3") } })
        .expect(400);

      await request(app)
        .post("/api/player/track")
        .send({ action: "add-queue", track: { title: "Real Local", artist: "Tester", path: realPath } })
        .expect(200);

      expect(appState.queue).toEqual([expect.objectContaining({ title: "Real Local", path: realPath })]);
    } finally {
      if (previousStrict === undefined) delete process.env.STRICT_PUBLIC_TRACK_VALIDATION;
      else process.env.STRICT_PUBLIC_TRACK_VALIDATION = previousStrict;
      config.musicSourceDir = previousMusicDir;
      config.uploadDir = previousUploadDir;
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(uploads, { recursive: true, force: true });
    }
  });

  it("edits reorders and removes queue items", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const first = await request(app).post("/api/queue").send({ title: "First", artist: "Tester", path: "/music/test/first.mp3" }).expect(201);
    const second = await request(app).post("/api/queue").send({ title: "Second", artist: "Tester", path: "/music/test/second.mp3" }).expect(201);

    const edited = await request(app).patch(`/api/queue/${first.body.id}`).send({ title: "Edited First" }).expect(200);
    expect(edited.body.item.title).toBe("Edited First");
    await request(app).patch(`/api/queue/${first.body.id}`).send({ title: "   " }).expect(400);

    const moved = await request(app).post(`/api/queue/${second.body.id}/move`).send({ direction: "up" }).expect(200);
    const movedIds = moved.body.queue.map((item: { id: string }) => item.id);
    expect(movedIds.indexOf(second.body.id)).toBeLessThan(movedIds.indexOf(first.body.id));

    const removed = await request(app).delete(`/api/queue/${second.body.id}`).expect(200);
    expect(removed.body.queue.some((item: { id: string }) => item.id === second.body.id)).toBe(false);
  });

  it("rejects invalid queue move requests", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const item = await request(app).post("/api/queue").send({ title: "Move Me", artist: "Tester", path: "/music/test/move-me.mp3" }).expect(201);

    await request(app).post(`/api/queue/${item.body.id}/move`).send({ direction: "up" }).expect(200);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ direction: "sideways" }).expect(400);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ direction: null }).expect(400);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ direction: [] }).expect(400);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ direction: "0" }).expect(400);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ index: "0" }).expect(400);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ direction: "down", extra: true }).expect(400);
    await request(app).post(`/api/queue/${item.body.id}/move`).send({ index: 99 }).expect(400);
    await request(app).post("/api/queue/not-real/move").send({ direction: "up" }).expect(404);
    expect(appState.queue.map((queued) => queued.id)).toEqual([item.body.id]);
  });

  it("generates unique queue ids for rapid inserts", () => {
    appState.queue.splice(0, appState.queue.length);
    const first = addQueueItem({ title: "Rapid One", artist: "Tester" });
    const second = addQueueItem({ title: "Rapid Two", artist: "Tester" });
    expect(first.id).not.toBe(second.id);
  });

  it("does not record generated shuffle rows as recent user picks", () => {
    appState.queue.splice(0, appState.queue.length);
    appState.recentPicks.splice(0, appState.recentPicks.length);

    addQueueItem({ title: "Generated Pick", artist: "Tester", requestedBy: "smart shuffle", path: "/music/generated.mp3" });
    addQueueItem({ title: "Manual Pick", artist: "Tester", requestedBy: "guest", path: "/music/manual.mp3" });

    expect(appState.recentPicks).toEqual([{ title: "Manual Pick", artist: "Tester", status: "Queued" }]);
  });

  it("removes recent pick entries when queued rows are removed", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.recentPicks.splice(0, appState.recentPicks.length);

    const item = addQueueItem({ title: "Remove Recent", artist: "Tester", requestedBy: "guest", path: "/music/remove.mp3" });
    expect(appState.recentPicks).toEqual([{ title: "Remove Recent", artist: "Tester", status: "Queued" }]);

    await request(createApp({ lms: mockLms }))
      .patch(`/api/queue/${item.id}`)
      .send({ title: "Remove Recent Edited", artist: "Edited Tester" })
      .expect(200);
    expect(appState.recentPicks).toEqual([{ title: "Remove Recent Edited", artist: "Edited Tester", status: "Queued" }]);

    removeQueueItem(item.id);

    expect(appState.recentPicks).toEqual([]);
  });

  it("returns a compact error for malformed JSON bodies", async () => {
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .set("content-type", "application/json")
      .send("{bad-json")
      .expect(400);

    expect(response.body).toEqual({ error: "Invalid JSON request body" });
  });

  it("updates player volume", async () => {
    const response = await request(createApp({ lms: mockLms })).post("/api/player/volume").send({ volume: 33 }).expect(200);
    expect(response.body.volume).toBe(33);
  });

  it("does not mutate volume when LMS volume control fails", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, volume: 44 };
    const lms = {
      ...mockLms,
      async control() {
        throw new Error("LMS volume failed");
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/volume").send({ volume: 33 }).expect(502);

    expect(response.body.error).toContain("LMS volume failed");
    expect(appState.player.volume).toBe(44);
  });

  it("rejects invalid volume values", async () => {
    const app = createApp({ lms: mockLms });

    await request(app).post("/api/player/volume").send({ volume: "loud" }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: null }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: "" }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: false }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: [] }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: -1 }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: 101 }).expect(400);
  });

  it("rejects extra volume command fields before sending LMS controls", async () => {
    const controls: Array<{ action: string; value: unknown }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value: unknown) {
          controls.push({ action, value });
          return "ok";
        }
      }
    });

    await request(app).post("/api/player/volume").send({ volume: 45, extra: true }).expect(400);
    await request(app).post("/api/player/volume").send({ volume: 45, seconds: 10 }).expect(400);

    expect(controls).toEqual([]);
  });

  it("does not mutate player mode when play pause or stop control fails", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    updateNowPlaying({ id: "stale-track", title: "Stale Track", artist: "Tester", source: "LMS" });
    const lms = {
      ...mockLms,
      async control() {
        throw new Error("LMS control failed");
      }
    };

    await request(createApp({ lms })).post("/api/player/play").expect(502);
    expect(appState.player.mode).toBe("stop");

    appState.player = { ...appState.player, mode: "play" };
    await request(createApp({ lms })).post("/api/player/pause").expect(502);
    expect(appState.player.mode).toBe("play");

    await request(createApp({ lms })).post("/api/player/stop").expect(502);
    expect(appState.player.mode).toBe("play");
    expect(appState.nowPlaying.title).toBe("Stale Track");
  });

  it("plays the visible queue when play is pressed while stopped", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    updateNowPlaying({ id: "idle", title: "No track playing", artist: "Connect a player or request a song", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null });
    addQueueItem({ title: "Queued Play", artist: "Tester", path: "/music/test/queued-play.mp3", requestedBy: "guest" });
    const played: Array<{ action: string; title?: string }> = [];
    const controls: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { title?: string }, action: string) {
          played.push({ action, title: track.title });
          return "ok";
        },
        async control(_playerId: string, action: string) {
          controls.push(action);
          return "ok";
        }
      }
    }))
      .post("/api/player/play")
      .expect(200);

    expect(response.body.action).toBe("visible-queue-play");
    expect(response.body.nowPlaying.title).toBe("Queued Play");
    expect(response.body.queue).toHaveLength(0);
    expect(played).toEqual([{ action: "play-now", title: "Queued Play" }]);
    expect(controls).not.toContain("play");
  });

  it("rejects track payloads sent to the transport play endpoint", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    const controls: string[] = [];
    const played: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          controls.push(action);
          return "ok";
        },
        async playTrack() {
          played.push("playTrack");
          return "ok";
        }
      }
    }))
      .post("/api/player/play")
      .send({ action: "play-now", track: { title: "Wrong Route", uri: "spotify:track:0000000000000000000001", kind: "track" } })
      .expect(400);

    expect(response.body.error).toBe("Unexpected transport control body");
    expect(response.body.detail).toContain("/api/player/track");
    expect(controls).toEqual([]);
    expect(played).toEqual([]);
  });

  it("allows empty transport control bodies", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    const controls: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          controls.push(action);
          return "ok";
        }
      }
    }))
      .post("/api/player/pause")
      .send({})
      .expect(200);

    expect(response.body.mode).toBe("pause");
    expect(controls).toEqual(["pause"]);
  });

  it("rejects non-json transport control bodies", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    const controls: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          controls.push(action);
          return "ok";
        }
      }
    }))
      .post("/api/player/play")
      .set("Content-Type", "text/plain")
      .send("not-json")
      .expect(400);

    expect(response.body.error).toBe("Unexpected transport control body");
    expect(controls).toEqual([]);
  });

  it("does not parse playback settings as a transport text body", async () => {
    const app = createApp({ lms: mockLms });
    const response = await request(app)
      .post("/api/player/playback")
      .send({ repeat: "all" })
      .expect(200);

    expect(response.body.playback.repeat).toBe("all");
    await request(app).post("/api/player/playback").send({ repeat: "off" }).expect(200);
  });

  it("stops playback and clears stale now playing after LMS accepts stop", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    updateNowPlaying({ id: "stale-track", title: "Stale Track", artist: "Tester", source: "LMS", duration: 100, elapsed: 12 });
    const controls: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          controls.push(action);
          return "ok";
        }
      }
    }))
      .post("/api/player/stop")
      .expect(200);

    expect(controls).toEqual(["stop"]);
    expect(response.body.mode).toBe("stop");
    expect(appState.player.mode).toBe("stop");
    expect(appState.nowPlaying).toMatchObject({ id: "idle", title: "No track playing", elapsed: 0, canSeek: false });
  });

  it("seeks the current player position", async () => {
    updateNowPlaying({ id: "seek-track", title: "Seek Track", artist: "Tester", source: "LMS", duration: 100, elapsed: 12, canSeek: true });
    const response = await request(createApp({ lms: mockLms })).post("/api/player/seek").send({ seconds: 42 }).expect(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.seconds).toBe(42);
    expect(response.body.nowPlaying.canSeek).toBe(true);
  });

  it("rejects seek requests when no seekable track is playing", async () => {
    const controls: Array<{ action: string; value?: number }> = [];
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    updateNowPlaying({ id: "idle", title: "No track playing", artist: "Connect a player or request a song", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value?: number) {
          controls.push({ action, value });
          return "ok";
        }
      }
    })).post("/api/player/seek").send({ seconds: 999999 }).expect(409);

    expect(response.body.error).toContain("No seekable track");
    expect(appState.nowPlaying.elapsed).toBe(0);
    expect(controls).toEqual([]);
  });

  it("clamps seek requests to the current track duration", async () => {
    const controls: Array<{ action: string; value?: number }> = [];
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "pause" };
    updateNowPlaying({ id: "seek-track", title: "Seek Track", artist: "Tester", source: "LMS", duration: 100, elapsed: 12, canSeek: true });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value?: number) {
          controls.push({ action, value });
          return "ok";
        }
      }
    })).post("/api/player/seek").send({ seconds: 999999 }).expect(200);

    expect(response.body.seconds).toBe(100);
    expect(response.body.nowPlaying.elapsed).toBe(100);
    expect(controls).toEqual([{ action: "seek", value: 100 }]);
  });

  it("keeps public elapsed near the seek target while LMS catches up", async () => {
    resetRefreshStateForTests();
    appState.player = { ...appState.player, id: "player-1", connected: true, online: true, mode: "play" };
    updateNowPlaying({
      id: "track-1",
      title: "Test Song",
      artist: "Test Artist",
      album: "Test Album",
      source: "LMS",
      duration: 100,
      elapsed: 20,
      canSeek: true,
      art: null
    });

    const app = createApp({ lms: mockLms });
    await request(app).post("/api/player/seek").send({ seconds: 42 }).expect(200);
    const state = await request(app).get("/api/state").expect(200);

    expect(state.body.nowPlaying.title).toBe("Test Song");
    expect(state.body.nowPlaying.elapsed).toBeGreaterThan(41.9);
    expect(state.body.nowPlaying.elapsed).toBeLessThan(45);
  });

  it("rejects invalid seek values", async () => {
    const app = createApp({ lms: mockLms });

    await request(app).post("/api/player/seek").send({ seconds: "later" }).expect(400);
    await request(app).post("/api/player/seek").send({ seconds: null }).expect(400);
    await request(app).post("/api/player/seek").send({ seconds: "" }).expect(400);
    await request(app).post("/api/player/seek").send({ seconds: false }).expect(400);
    await request(app).post("/api/player/seek").send({ seconds: [] }).expect(400);
  });

  it("rejects extra seek command fields before checking playback state", async () => {
    const controls: Array<{ action: string; value: unknown }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value: unknown) {
          controls.push({ action, value });
          return "ok";
        }
      }
    });

    await request(app).post("/api/player/seek").send({ seconds: 0, extra: true }).expect(400);
    await request(app).post("/api/player/seek").send({ seconds: 0, volume: 45 }).expect(400);

    expect(controls).toEqual([]);
  });

  it("does not restart the current track when previous has no app history", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.playback = { ...appState.playback, previousTracks: [] };
    const controls: Array<{ action: string; value?: number }> = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string, value?: number) {
        controls.push({ action, value });
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(200);

    expect(response.body.action).toBe("noop");
    expect(controls).toEqual([]);
    expect(controls.some((item) => item.action === "seek")).toBe(false);
  });

  it("does not resume stale LMS playback when previous is pressed after stop", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.playback = { ...appState.playback, previousTracks: [] };
    updateNowPlaying({ id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null });
    const controls: Array<{ action: string }> = [];
    const lms = {
      ...mockLms,
      async status() {
        throw new Error("status should not block stopped previous");
      },
      async control(_playerId: string, action: string) {
        controls.push({ action });
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(200);

    expect(response.body.action).toBe("noop");
    expect(response.body.mode).toBe("stop");
    expect(response.body.nowPlaying.title).toBe("No track playing");
    expect(controls).toEqual([]);
  });

  it("does not call LMS previous when app previous history is empty", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "pause" };
    appState.playback = { ...appState.playback, previousTracks: [] };
    const controls: string[] = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string) {
        controls.push(action);
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(200);

    expect(response.body.action).toBe("noop");
    expect(controls).toEqual([]);
    expect(appState.player.mode).toBe("pause");
  });

  it("plays the previous app track before falling back to LMS previous", async () => {
    const played: Array<{ action: string; track: { title?: string; path?: string } }> = [];
    const controls: Array<{ action: string }> = [];
    appState.nowPlaying = {
      id: "current",
      title: "Current Track",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 10,
      canSeek: true,
      art: null,
      path: "/music/current.mp3"
    };
    appState.playback = {
      ...appState.playback,
      previousTracks: [{ title: "Previous Track", artist: "Tester", path: "/music/previous.mp3", source: "Local library" }]
    };
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string; path?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      },
      async control(_playerId: string, action: string) {
        controls.push({ action });
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(200);

    expect(response.body.action).toBe("app-previous");
    expect(response.body.nowPlaying.title).toBe("Previous Track");
    expect(played).toEqual([{ action: "play-now", track: expect.objectContaining({ title: "Previous Track", path: "/music/previous.mp3" }) }]);
    expect(controls).not.toContainEqual({ action: "previous" });
    expect(appState.playback.previousTracks[0]).toMatchObject({ title: "Current Track", path: "/music/current.mp3" });
  });

  it("does not mutate previous history when app previous playback fails", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = {
      id: "current",
      title: "Current Track",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 10,
      canSeek: true,
      art: null,
      path: "/music/current.mp3"
    };
    const previousTrack = { title: "Previous Track", artist: "Tester", path: "/music/previous.mp3", source: "Local library" };
    appState.playback = { ...appState.playback, previousTracks: [previousTrack] };
    const lms = {
      ...mockLms,
      async playTrack() {
        throw new Error("LMS refused previous playback");
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(502);

    expect(response.body.error).toContain("LMS refused previous playback");
    expect(appState.nowPlaying.title).toBe("Current Track");
    expect(appState.player.mode).toBe("play");
    expect(appState.playback.previousTracks).toEqual([expect.objectContaining(previousTrack)]);
  });

  it("remembers LMS-observed track changes for the previous button", async () => {
    appState.playback = { ...appState.playback, previousTracks: [] };
    appState.nowPlaying = {
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      album: "",
      source: "LMS",
      duration: 0,
      elapsed: 0,
      canSeek: false,
      art: null
    };
    const observedTracks = [
      { id: "track-a", title: "Track A", artist: "Tester", album: "", source: "LMS", path: "/music/a.mp3", duration: 120, elapsed: 10, canSeek: true, art: null },
      { id: "track-b", title: "Track B", artist: "Tester", album: "", source: "LMS", path: "/music/b.mp3", duration: 120, elapsed: 5, canSeek: true, art: null }
    ];
    const played: Array<{ action: string; track: { title?: string; path?: string } }> = [];
    const controls: Array<{ action: string }> = [];
    let nowPlayingIndex = 0;
    const lms = {
      ...mockLms,
      async nowPlaying() {
        return observedTracks[nowPlayingIndex];
      },
      async playTrack(_playerId: string, track: { title?: string; path?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      },
      async control(_playerId: string, action: string) {
        controls.push({ action });
        return "ok";
      }
    };
    const app = createApp({ lms });

    resetRefreshStateForTests();
    await request(app).get("/api/state").expect(200);
    nowPlayingIndex = 1;
    resetRefreshStateForTests();
    const state = await request(app).get("/api/state").expect(200);

    expect(state.body.nowPlaying.title).toBe("Track B");
    expect(appState.playback.previousTracks[0]).toMatchObject({ title: "Track A", path: "/music/a.mp3" });

    const previous = await request(app).post("/api/player/previous").expect(200);

    expect(previous.body.action).toBe("app-previous");
    expect(played).toEqual([{ action: "play-now", track: expect.objectContaining({ title: "Track A", path: "/music/a.mp3" }) }]);
    expect(controls).not.toContainEqual({ action: "previous" });
    expect(appState.playback.previousTracks[0]).toMatchObject({ title: "Track B", path: "/music/b.mp3" });
  });

  it("no-ops previous with the hot player id without waiting on a fresh status call", async () => {
    appState.playback = { ...appState.playback, previousTracks: [] };
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true };
    const controls: Array<{ playerId: string; action: string }> = [];
    const lms = {
      ...mockLms,
      async status() {
        throw new Error("status should not block previous");
      },
      async control(playerId: string, action: string) {
        controls.push({ playerId, action });
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(200);

    expect(response.body.action).toBe("noop");
    expect(controls).toEqual([]);
  });

  it("proxies LMS artwork", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/artwork/test-cover").expect(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.text || response.body.toString()).toContain("fake-jpeg");
  });

  it("limits image proxy responses to real images under the size cap", async () => {
    const imageBytes = Buffer.from("fake-image");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("too-large-header")) {
        return new Response(Buffer.from(""), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(9 * 1024 * 1024) } });
      }
      if (url.includes("too-large-body")) {
        return new Response(Buffer.alloc(9 * 1024 * 1024), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      if (url.includes("not-image")) {
        return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(imageBytes, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(imageBytes.length) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ lms: mockLms });

    const ok = await request(app).get("/api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fok").expect(200);
    await request(app).get("/api/image-proxy?url=https%3A%2F%2Fevil.example%2Fcover.jpg").expect(400);
    await request(app).get("/api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fnot-image").expect(415);
    await request(app).get("/api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Ftoo-large-header").expect(413);
    await request(app).get("/api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Ftoo-large-body").expect(413);

    expect(ok.headers["content-type"]).toContain("image/jpeg");
    expect(ok.body.toString()).toBe("fake-image");
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("evil.example"), expect.anything());
  });

  it("returns speaker connection setup guidance", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/speaker/connect-guide").expect(200);
    expect(response.body.serverHost).toBeTruthy();
    expect(response.body.steps).toContain("Open the Squeezebox Server option.");
    expect(response.body.player.connected).toBe(true);
  });

  it("keeps single-track queue requests out of the hidden LMS playlist", async () => {
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      }
    };
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/track")
      .send({ action: "play-next", track: { title: "Local", artist: "Tester", path: "/music/test/local.mp3" } })
      .expect(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.action).toBe("play-next");
    expect(response.body.queued.title).toBe("Local");
    await request(createApp({ lms }))
      .post("/api/player/track")
      .send({ action: "play-next", track: { title: "Manual Next", artist: "Tester", path: "/music/test/manual.mp3" } })
      .expect(200);
    await request(createApp({ lms }))
      .post("/api/player/track")
      .send({ action: "add-queue", track: { title: "Manual Add", artist: "Tester", path: "/music/test/manual-add.mp3" } })
      .expect(200);
    expect(played).toHaveLength(0);
  });

  it("rejects Spotify containers as direct playback targets", async () => {
    const app = createApp({ lms: mockLms });
    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Drake", uri: "spotify:artist:3TVXtAsR1Inumwj472S9r4", kind: "artist", source: "Spotify artist" } })
      .expect(400);

    expect(response.body.error).toBe("Playable local path, LMS track id, or Spotify URI is required");
  });

  it("rejects malformed Spotify track URIs before they reach LMS", async () => {
    const played: Array<{ action: string; track: { uri?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { uri?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });

    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Bad Spotify ID", uri: "spotify:track:not-a-real-id", kind: "track", source: "Spotify" } })
      .expect(400);

    expect(response.body.error).toBe("Playable local path, LMS track id, or Spotify URI is required");
    expect(played).toEqual([]);
  });

  it("rejects unknown Spotify play-now tracks even when their ids are well formed", async () => {
    const played: Array<{ action: string; track: { uri?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { uri?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });

    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Unknown Spotify", uri: "spotify:track:0000000000000000000199", kind: "track", source: "Spotify" } })
      .expect(400);

    expect(response.body.error).toContain("Cloud Squeeze search");
    expect(played).toEqual([]);
  });

  it("allows Spotify play-now tracks returned by Cloud Squeeze search", async () => {
    const played: Array<{ action: string; track: { uri?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { uri?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });
    const search = await request(app).get("/api/spotify/search?q=drake").expect(200);
    const track = search.body.results[0];

    await request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track })
      .expect(200);

    expect(played).toEqual([{ action: "play-now", track: expect.objectContaining({ uri: "spotify:track:0000000000000000000101" }) }]);
  });

  it("does not mutate now playing when direct play-now fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.nowPlaying = {
      id: "stable-current",
      title: "Stable Current",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 20,
      canSeek: true,
      art: null,
      path: "/music/test/stable-current.mp3"
    };
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: false, history: ["stable-history"], previousTracks: [] };
    addQueueItem({ title: "Generated Keeper", artist: "Tester", requestedBy: "shuffle", path: "/music/test/generated-keeper.mp3" });
    const lms = {
      ...mockLms,
      async playTrack() {
        throw new Error("LMS refused direct playback");
      }
    };

    const response = await request(createApp({ lms }))
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Failed Direct", artist: "Tester", path: "/music/test/failed-direct.mp3", source: "Local library" } })
      .expect(502);

    expect(response.body.error).toContain("LMS refused direct playback");
    expect(appState.nowPlaying.title).toBe("Stable Current");
    expect(appState.player.mode).toBe("stop");
    expect(appState.playback).toMatchObject({ shuffle: true, smartQueue: false, history: ["stable-history"], previousTracks: [] });
    expect(appState.queue).toEqual([expect.objectContaining({ title: "Generated Keeper" })]);
  });

  it("rejects unknown Spotify queue tracks even when their ids are well formed", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });

    await request(app)
      .post("/api/player/track")
      .send({ action: "add-queue", track: { title: "Unknown Spotify", uri: "spotify:track:0000000000000000000200", kind: "track", source: "Spotify" } })
      .expect(400);

    const batch = await request(app)
      .post("/api/player/tracks")
      .send({
        action: "play-next",
        tracks: [{ title: "Unknown Spotify Batch", uri: "spotify:track:0000000000000000000201", kind: "track", source: "Spotify" }]
      })
      .expect(400);

    expect(batch.body.error).toBe("Spotify tracks must come from Cloud Squeeze search, playlist, or library results");
    expect(appState.queue).toHaveLength(0);
  });

  it("allows Spotify queue tracks returned by Cloud Squeeze search", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const search = await request(app).get("/api/spotify/search?q=drake").expect(200);
    const track = search.body.results[0];

    const response = await request(app)
      .post("/api/player/tracks")
      .send({ action: "add-queue", tracks: [track] })
      .expect(200);

    expect(response.body.queued).toHaveLength(1);
    expect(response.body.queued[0].uri).toBe("spotify:track:0000000000000000000101");
  });

  it("does not reject skipped Spotify rows beyond the public queue limit", async () => {
    appState.queue.splice(0, appState.queue.length);
    const previousMaxQueuePerUser = appState.admin.maxQueuePerUser;
    appState.admin = { ...appState.admin, maxQueuePerUser: 2 };
    try {
      addQueueItem({ title: "Existing Guest", artist: "Tester", path: "/music/test/existing-guest.mp3", requestedBy: "guest" });
      const app = createApp({ lms: mockLms });
      const search = await request(app).get("/api/spotify/search?q=drake").expect(200);
      const knownTrack = search.body.results[0];
      const unknownTrack = {
        title: "Skipped Unknown Spotify",
        uri: "spotify:track:0000000000000000000999",
        kind: "track",
        source: "Spotify"
      };

      const response = await request(app)
        .post("/api/player/tracks")
        .send({ action: "add-queue", tracks: [knownTrack, unknownTrack] })
        .expect(200);

      expect(response.body.accepted).toBe(1);
      expect(response.body.rejected).toBe(1);
      expect(response.body.queued).toEqual([expect.objectContaining({ uri: "spotify:track:0000000000000000000101" })]);
      expect(appState.queue).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "spotify:track:0000000000000000000101" })]));
      expect(appState.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ uri: "spotify:track:0000000000000000000999" })]));
    } finally {
      appState.admin = { ...appState.admin, maxQueuePerUser: previousMaxQueuePerUser };
    }
  });

  it("does not reject skipped local rows beyond the public queue limit", async () => {
    appState.queue.splice(0, appState.queue.length);
    const previousMaxQueuePerUser = appState.admin.maxQueuePerUser;
    const previousStrict = process.env.STRICT_PUBLIC_TRACK_VALIDATION;
    const previousMusicDir = config.musicSourceDir;
    const previousUploadDir = config.uploadDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-partial-local-"));
    appState.admin = { ...appState.admin, maxQueuePerUser: 2 };
    process.env.STRICT_PUBLIC_TRACK_VALIDATION = "1";
    config.musicSourceDir = root;
    config.uploadDir = path.join(root, "uploads");
    try {
      await fs.mkdir(config.uploadDir, { recursive: true });
      const existingPath = path.join(root, "Existing Guest.mp3");
      const acceptedPath = path.join(root, "Accepted Local.mp3");
      await fs.writeFile(existingPath, "ID3");
      await fs.writeFile(acceptedPath, "ID3");
      addQueueItem({ title: "Existing Guest", artist: "Tester", path: existingPath, requestedBy: "guest" });
      const missingPath = path.join(root, "Missing Local.mp3");

      const response = await request(createApp({ lms: mockLms }))
        .post("/api/player/tracks")
        .send({
          action: "add-queue",
          tracks: [
            { title: "Accepted Local", artist: "Tester", path: acceptedPath, source: "Local library" },
            { title: "Missing Local", artist: "Tester", path: missingPath, source: "Local library" }
          ]
        })
        .expect(200);

      expect(response.body.accepted).toBe(1);
      expect(response.body.rejected).toBe(1);
      expect(response.body.queued).toEqual([expect.objectContaining({ title: "Accepted Local", path: acceptedPath })]);
      expect(appState.queue).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Accepted Local", path: acceptedPath })]));
      expect(appState.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Missing Local" })]));
    } finally {
      appState.admin = { ...appState.admin, maxQueuePerUser: previousMaxQueuePerUser };
      if (previousStrict === undefined) {
        delete process.env.STRICT_PUBLIC_TRACK_VALIDATION;
      } else {
        process.env.STRICT_PUBLIC_TRACK_VALIDATION = previousStrict;
      }
      config.musicSourceDir = previousMusicDir;
      config.uploadDir = previousUploadDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a cleared Spotify playlist batch isolated when shuffle is enabled", async () => {
    appState.queue.splice(0, appState.queue.length);
    updateSpotifyStatus({ configured: true, reachable: true, detail: "Spotty detected" });
    addQueueItem({ title: "Stale Local", artist: "Tester", path: "/music/test/stale-local.mp3", requestedBy: "guest" });
    const playlistTracks = [
      { id: "spotify:track:0000000000000000000401", title: "Playlist A", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000000401", kind: "track" },
      { id: "spotify:track:0000000000000000000402", title: "Playlist B", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000000402", kind: "track" },
      { id: "spotify:track:0000000000000000000403", title: "Playlist C", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000000403", kind: "track" }
    ];
    const app = createApp({
      lms: {
        ...mockLms,
        async spotifyChildren() {
          return playlistTracks;
        }
      }
    });

    await request(app).get("/api/spotify/children?uri=spotify%3Aplaylist%3A1&kind=playlist").expect(200);
    await request(app).delete("/api/queue").expect(200);
    const queued = await request(app).post("/api/player/tracks").send({ action: "add-queue", tracks: playlistTracks }).expect(200);
    const shuffled = await request(app).post("/api/player/playback").send({ shuffle: true, smartQueue: false }).expect(200);

    const playlistUris = new Set(playlistTracks.map((track) => track.uri));
    expect(queued.body.accepted).toBe(3);
    expect(shuffled.body.queued).toEqual([]);
    expect(shuffled.body.queue).toHaveLength(3);
    expect(shuffled.body.queue.every((item: { uri?: string; requestedBy?: string }) => playlistUris.has(item.uri || "") && item.requestedBy === "guest")).toBe(true);
    expect(shuffled.body.queue.some((item: { title: string }) => item.title === "Stale Local")).toBe(false);
  });

  it("rejects unknown single-track playback actions", async () => {
    appState.queue.splice(0, appState.queue.length);
    const beforeMode = appState.player.mode;
    const beforeTitle = appState.nowPlaying.title;
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { title?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });

    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "bad-action", track: { title: "Should Not Play", artist: "Tester", uri: "spotify:track:bad-action", source: "Spotify", kind: "track" } })
      .expect(400);

    expect(response.body.error).toBe("Track playback supports add-queue, play-next, or play-now");
    expect(played).toHaveLength(0);
    expect(appState.queue).toHaveLength(0);
    expect(appState.player.mode).toBe(beforeMode);
    expect(appState.nowPlaying.title).toBe(beforeTitle);
  });

  it("rejects malformed playback action bodies instead of defaulting to queue actions", async () => {
    appState.queue.splice(0, appState.queue.length);
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { title?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });

    await request(app).post("/api/player/track").send({ action: null, track: { title: "Null Action", path: "/music/test/null-action.mp3" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "", track: { title: "Blank Action", path: "/music/test/blank-action.mp3" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: null }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Extra Body", path: "/music/test/extra-body.mp3" }, extra: true }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Array Path", path: [], source: "Local library" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Object Path", path: { x: 1 }, source: "Local library" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Array Id", lmsTrackId: [], source: "LMS" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Object Id", lmsTrackId: { x: 1 }, source: "LMS" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Array Uri", uri: ["spotify:track:0000000000000000000101"], kind: "track", source: "Spotify" } }).expect(400);
    await request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Extra Track Field", path: "/music/test/extra-track-field.mp3", extra: true } }).expect(400);
    await request(app).post("/api/player/tracks").send({ action: null, tracks: [{ title: "Batch Null", path: "/music/test/batch-null.mp3" }] }).expect(400);
    await request(app).post("/api/player/tracks").send({ action: "add-queue", tracks: [] }).expect(400);
    await request(app).post("/api/player/tracks").send({ action: "add-queue", tracks: [null] }).expect(400);
    await request(app).post("/api/player/tracks").send({ action: "add-queue", tracks: [{ title: "Extra Batch", path: "/music/test/extra-batch.mp3" }], extra: true }).expect(400);
    await request(app).post("/api/player/tracks").send({ action: "add-queue", tracks: [{ title: "Bad Batch Id", lmsTrackId: [] }] }).expect(400);
    await request(app).post("/api/player/tracks").send({ action: "add-queue", tracks: [{ title: "Extra Batch Track Field", path: "/music/test/extra-batch-track-field.mp3", extra: true }] }).expect(400);

    expect(played).toHaveLength(0);
    expect(appState.queue).toHaveLength(0);
  });

  it("filters Spotify containers out of batch playback", async () => {
    appState.queue.splice(0, appState.queue.length);
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/tracks")
      .send({
        action: "add-queue",
        tracks: [
          { title: "Artist Container", uri: "spotify:artist:container", kind: "artist", source: "Spotify artist" },
          { title: "Playable Track", path: "/music/test/playable-track.mp3", source: "Local library" }
        ]
      })
      .expect(200);

    expect(response.body.queued).toHaveLength(1);
    expect(response.body.queued[0].title).toBe("Playable Track");
  });

  it("rejects duplicate direct playback queue requests by playable key", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const track = { title: "Duplicate Local Track", path: "/music/test/duplicate-track.mp3", source: "Local library" };

    await request(app).post("/api/player/track").send({ action: "add-queue", track }).expect(200);
    const duplicate = await request(app).post("/api/player/track").send({ action: "add-queue", track }).expect(409);

    expect(duplicate.body.error).toBe("That song is already in the queue");
    expect(appState.queue.filter((item) => item.path === track.path)).toHaveLength(1);
  });

  it("deduplicates batch playback by playable key", async () => {
    appState.queue.splice(0, appState.queue.length);
    addQueueItem({ title: "Existing", artist: "Tester", path: "/music/test/existing.mp3" });

    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/tracks")
      .send({
        action: "add-queue",
        tracks: [
          { title: "Existing Again", path: "/music/test/existing.mp3", source: "Local library" },
          { title: "New Track", path: "/music/test/new-track.mp3", source: "Local library" },
          { title: "New Track Duplicate", path: "/music/test/new-track.mp3", source: "Local library" }
        ]
      })
      .expect(200);

    expect(response.body.queued).toHaveLength(1);
    expect(response.body.queued[0].title).toBe("New Track");
    expect(response.body.accepted).toBe(1);
    expect(response.body.rejected).toBe(2);
    expect(appState.queue.filter((item) => item.path === "/music/test/new-track.mp3")).toHaveLength(1);
  });

  it("reports all skipped duplicate playable rows in batch responses", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const first = { title: "Duplicate Batch One", path: "/music/test/duplicate-batch-one.mp3", source: "Local library" };
    const second = { title: "Duplicate Batch Two", path: "/music/test/duplicate-batch-two.mp3", source: "Local library" };

    const partial = await request(app)
      .post("/api/player/tracks")
      .send({ action: "add-queue", tracks: [first, first, second] })
      .expect(200);

    expect(partial.body.accepted).toBe(2);
    expect(partial.body.rejected).toBe(1);
    expect(partial.body.queued.map((item: { title: string }) => item.title)).toEqual(["Duplicate Batch One", "Duplicate Batch Two"]);

    const allDuplicate = await request(app)
      .post("/api/player/tracks")
      .send({ action: "add-queue", tracks: [first, first] })
      .expect(409);

    expect(allDuplicate.body.accepted).toBe(0);
    expect(allDuplicate.body.rejected).toBe(2);
  });

  it("enforces the public guest queue limit for single and batch requests", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    addQueueItem({ title: "Limit Existing 1", artist: "Tester", uri: "spotify:track:limit-existing-1", kind: "track", requestedBy: "guest" });
    addQueueItem({ title: "Limit Existing 2", artist: "Tester", uri: "spotify:track:limit-existing-2", kind: "track", requestedBy: "guest" });
    addQueueItem({ title: "Generated Does Not Count", artist: "Tester", uri: "spotify:track:generated-limit", kind: "track", requestedBy: "smart shuffle" });
    const app = createApp({ lms: mockLms });

    const partialBatch = await request(app)
      .post("/api/player/tracks")
      .send({
        action: "add-queue",
        tracks: [
          { title: "Limit New 1", path: "/music/test/limit-new-1.mp3", source: "Local library" },
          { title: "Limit New 2", path: "/music/test/limit-new-2.mp3", source: "Local library" }
        ]
      })
      .expect(200);
    expect(partialBatch.body.accepted).toBe(1);
    expect(partialBatch.body.rejected).toBe(1);
    expect(partialBatch.body.queued).toEqual([expect.objectContaining({ title: "Limit New 1" })]);
    expect(appState.queue.some((item) => item.title === "Limit New 1")).toBe(true);

    const fullBatch = await request(app)
      .post("/api/player/tracks")
      .send({
        action: "add-queue",
        tracks: [
          { title: "Limit Full 1", path: "/music/test/limit-full-1.mp3", source: "Local library" },
          { title: "Limit Full 2", path: "/music/test/limit-full-2.mp3", source: "Local library" }
        ]
      })
      .expect(429);
    expect(fullBatch.body.accepted).toBe(0);
    expect(fullBatch.body.rejected).toBe(2);

    await request(app)
      .post("/api/player/track")
      .send({ action: "play-next", track: { title: "Limit Allowed", path: "/music/test/limit-allowed.mp3", source: "Local library" } })
      .expect(429);

    const tooManySingle = await request(app)
      .post("/api/player/track")
      .send({ action: "add-queue", track: { title: "Limit Rejected", path: "/music/test/limit-rejected.mp3", source: "Local library" } })
      .expect(429);
    expect(tooManySingle.body.error).toContain("max 3");

    const spoofed = await request(app)
      .post("/api/queue")
      .send({ title: "Limit Spoofed", artist: "Tester", requestedBy: "admin" })
      .expect(429);
    expect(spoofed.body.error).toContain("max 3");
    expect(appState.queue.filter((item) => item.requestedBy === "guest")).toHaveLength(3);
  });

  it("does not allow public queue edits to change request ownership", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const created = await request(app)
      .post("/api/queue")
      .send({ title: "Ownership Lock", artist: "Tester", path: "/music/test/ownership-lock.mp3", requestedBy: "admin" })
      .expect(201);

    expect(created.body.requestedBy).toBe("guest");
    await request(app)
      .patch(`/api/queue/${created.body.id}`)
      .send({ requestedBy: "admin" })
      .expect(400);
    expect(appState.queue.find((item) => item.id === created.body.id)?.requestedBy).toBe("guest");
  });

  it("accepts queue edit UI payloads without allowing requester spoofing", async () => {
    appState.queue.splice(0, appState.queue.length);
    const local = addQueueItem({ title: "Local Editable", artist: "Tester", path: "/music/test/local-editable-ui.mp3", requestedBy: "guest" });
    const app = createApp({ lms: mockLms });

    const edited = await request(app)
      .patch(`/api/queue/${local.id}`)
      .send({ title: "Local Edited", artist: "Edited", requestedBy: "guest" })
      .expect(200);
    await request(app)
      .patch(`/api/queue/${local.id}`)
      .send({ title: "Local Edited Again", artist: "Edited", requestedBy: "admin" })
      .expect(400);

    expect(edited.body.item).toMatchObject({ title: "Local Edited", artist: "Edited", requestedBy: "guest" });
    expect(appState.queue.find((item) => item.id === local.id)?.requestedBy).toBe("guest");
  });

  it("rejects changed Spotify queue metadata while allowing unchanged queue edit payloads", async () => {
    appState.queue.splice(0, appState.queue.length);
    const local = addQueueItem({ title: "Local Editable", artist: "Tester", path: "/music/test/local-editable.mp3", requestedBy: "guest" });
    const spotify = addQueueItem({ title: "Spotify Locked", artist: "Tester", uri: "spotify:track:0000000000000000000001", kind: "track", source: "Spotify", requestedBy: "guest" });
    const app = createApp({ lms: mockLms });

    const edited = await request(app)
      .patch(`/api/queue/${local.id}`)
      .send({ title: "Local Edited", artist: "Edited" })
      .expect(200);
    const rejected = await request(app)
      .patch(`/api/queue/${spotify.id}`)
      .send({ title: "Wrong Spotify Title" })
      .expect(400);
    const unchangedSpotify = await request(app)
      .patch(`/api/queue/${spotify.id}`)
      .send({ title: "Spotify Locked", artist: "Tester", requestedBy: "guest" })
      .expect(200);

    expect(edited.body.item).toMatchObject({ title: "Local Edited", artist: "Edited" });
    expect(rejected.body.error).toContain("Spotify queue item metadata");
    expect(unchangedSpotify.body.item).toMatchObject({ title: "Spotify Locked", artist: "Tester", requestedBy: "guest" });
    expect(appState.queue.find((item) => item.id === spotify.id)?.title).toBe("Spotify Locked");
  });

  it("rejects new public song requests when public requests are paused", async () => {
    appState.queue.splice(0, appState.queue.length);
    const previousAdmin = { ...appState.admin };
    const previousSchedule = structuredClone(appState.schedule);
    appState.admin = { ...appState.admin, publicRequests: false, scheduleEnabled: true };
    appState.schedule = { ...appState.schedule, current: { ...appState.schedule.current, requestsPaused: false } };
    try {
      const app = createApp({ lms: mockLms });
      await request(app).post("/api/queue").send({ title: "Paused Queue", artist: "Tester" }).expect(403);
      await request(app)
        .post("/api/player/track")
        .send({ action: "play-now", track: { title: "Paused Play", uri: "spotify:track:0000000000000000000009", kind: "track", source: "Spotify" } })
        .expect(403);
      await request(app)
        .post("/api/player/tracks")
        .send({ action: "add-queue", tracks: [{ title: "Paused Batch", uri: "spotify:track:0000000000000000000010", kind: "track", source: "Spotify" }] })
        .expect(403);
      const first = addQueueItem({ title: "Paused Existing A", artist: "Tester", path: "/music/test/paused-a.mp3", requestedBy: "guest" });
      const second = addQueueItem({ title: "Paused Existing B", artist: "Tester", path: "/music/test/paused-b.mp3", requestedBy: "guest" });
      await request(app).patch(`/api/queue/${first.id}`).send({ title: "Paused Edited" }).expect(403);
      await request(app).post(`/api/queue/${second.id}/move`).send({ direction: "up" }).expect(403);
      await request(app).delete(`/api/queue/${first.id}`).expect(403);
      await request(app).delete("/api/queue").expect(403);
      await request(app).post("/api/player/smart-shuffle").send({ source: "local", count: 1 }).expect(403);
      await request(app)
        .post("/api/library/upload?filename=paused.mp3")
        .set("content-type", "application/octet-stream")
        .send(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32)]))
        .expect(403);
      await request(app).post("/api/player/playback").send({ repeat: "all" }).expect(403);

      expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Paused Existing A", "Paused Existing B"]);
      expect(appState.playback.repeat).toBe("off");
    } finally {
      appState.admin = previousAdmin;
      appState.schedule = previousSchedule;
    }
  });

  it("rejects new public song requests during scheduled pause windows", async () => {
    appState.queue.splice(0, appState.queue.length);
    const previousAdmin = { ...appState.admin };
    const previousSchedule = structuredClone(appState.schedule);
    appState.admin = { ...appState.admin, publicRequests: true, scheduleEnabled: true };
    appState.schedule = { ...appState.schedule, current: { ...appState.schedule.current, requestsPaused: true } };
    try {
      const app = createApp({ lms: mockLms });
      const response = await request(app)
        .post("/api/player/track")
        .send({ action: "add-queue", track: { title: "Scheduled Pause", uri: "spotify:track:0000000000000000000011", kind: "track", source: "Spotify" } })
        .expect(403);

      expect(response.body.error).toContain("schedule");
      expect(appState.queue).toHaveLength(0);
    } finally {
      appState.admin = previousAdmin;
      appState.schedule = previousSchedule;
    }
  });

  it("keeps queued tracks visible until next consumes them", async () => {
    appState.queue.splice(0, appState.queue.length);
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      }
    };
    const app = createApp({ lms });

    await request(app)
      .post("/api/player/track")
      .send({ action: "add-queue", track: { title: "Visible Queue Song", artist: "Tester", path: "/music/test/visible.mp3" } })
      .expect(200);
    expect(appState.queue.map((item) => item.title)).toContain("Visible Queue Song");

    const next = await request(app).post("/api/player/next").expect(200);

    expect(next.body.action).toBe("visible-queue-next");
    expect(played).toEqual([{ action: "play-now", track: expect.objectContaining({ title: "Visible Queue Song" }) }]);
    expect(appState.queue.some((item) => item.title === "Visible Queue Song")).toBe(false);
  });

  it("returns matching LMS artwork metadata after direct play now", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = { id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null };
    const lms = {
      ...mockLms,
      async nowPlaying() {
        return {
          id: "/music/test/art-track.mp3",
          title: "Art Track",
          artist: "Tester",
          album: "Artwork",
          source: "Local library",
          duration: 100,
          elapsed: 0,
          canSeek: true,
          art: "api/artwork/test-cover",
          path: "/music/test/art-track.mp3"
        };
      }
    };

    const response = await request(createApp({ lms }))
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Art Track", artist: "Tester", path: "/music/test/art-track.mp3", source: "Local library" } })
      .expect(200);

    expect(response.body.nowPlaying).toMatchObject({ title: "Art Track", art: "api/artwork/test-cover", canSeek: true });
  });

  it("serializes concurrent play presses so queued rows are not reported twice", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.nowPlaying = { id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false };
    addQueueItem({ title: "First Concurrent", artist: "Tester", path: "/music/test/first-concurrent.mp3", requestedBy: "guest" });
    addQueueItem({ title: "Second Concurrent", artist: "Tester", path: "/music/test/second-concurrent.mp3", requestedBy: "guest" });
    const played: string[] = [];
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string }) {
        played.push(String(track.title || ""));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "ok";
      },
      async control() {
        played.push("control:play");
        return "ok";
      }
    };
    const app = createApp({ lms });

    const [first, second] = await Promise.all([
      request(app).post("/api/player/play").expect(200),
      request(app).post("/api/player/play").expect(200)
    ]);

    expect([first.body.action, second.body.action]).toEqual(["visible-queue-play", "play"]);
    expect(played).toEqual(["First Concurrent", "control:play"]);
    expect(appState.queue.map((item) => item.title)).toEqual(["Second Concurrent"]);
  });

  it("serializes concurrent next presses through visible queue order", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = { id: "current", title: "Current", artist: "Tester", album: "", source: "Local library", duration: 100, elapsed: 5, canSeek: true, art: null, path: "/music/test/current.mp3" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, previousTracks: [] };
    addQueueItem({ title: "Next One", artist: "Tester", path: "/music/test/next-one.mp3", requestedBy: "guest" });
    addQueueItem({ title: "Next Two", artist: "Tester", path: "/music/test/next-two.mp3", requestedBy: "guest" });
    const played: string[] = [];
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string }) {
        played.push(String(track.title || ""));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "ok";
      }
    };
    const app = createApp({ lms });

    const [first, second] = await Promise.all([
      request(app).post("/api/player/next").expect(200),
      request(app).post("/api/player/next").expect(200)
    ]);

    expect([first.body.nowPlaying.title, second.body.nowPlaying.title]).toEqual(["Next One", "Next Two"]);
    expect(played).toEqual(["Next One", "Next Two"]);
    expect(appState.queue).toEqual([]);
  });

  it("records the current song before native LMS next so previous can restore it", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = { id: "current", title: "Current Native", artist: "Tester", album: "", source: "Local library", duration: 100, elapsed: 5, canSeek: true, art: null, path: "/music/test/current-native.mp3" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, previousTracks: [], appManagedPlayback: false };
    const controls: string[] = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string) {
        controls.push(action);
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/next").expect(200);

    expect(response.body.action).toBe("next");
    expect(controls).toEqual(["next"]);
    expect(appState.playback.previousTracks[0]).toMatchObject({ title: "Current Native", path: "/music/test/current-native.mp3" });
  });

  it("serializes stop behind an in-flight visible queue next", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = { id: "current", title: "Current", artist: "Tester", album: "", source: "Local library", duration: 100, elapsed: 5, canSeek: true, art: null, path: "/music/test/current.mp3" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, previousTracks: [] };
    addQueueItem({ title: "Race Next", artist: "Tester", path: "/music/test/race-next.mp3", requestedBy: "guest" });
    const events: string[] = [];
    let releasePlay: () => void = () => {};
    const playGate = new Promise<void>((resolve) => {
      releasePlay = resolve;
    });
    let app: ReturnType<typeof createApp>;
    let stopRequest: Promise<request.Response> | null = null;
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string }) {
        events.push(`play:${track.title}`);
        stopRequest = request(app).post("/api/player/stop").expect(200);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await playGate;
        return "ok";
      },
      async control(_playerId: string, action: string) {
        events.push(`control:${action}`);
        return "ok";
      }
    };
    app = createApp({ lms });

    const nextRequest = request(app).post("/api/player/next").expect(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    releasePlay();
    const next = await nextRequest;
    const stop = await stopRequest;

    expect(next.body.action).toBe("visible-queue-next");
    expect(stop.body.mode).toBe("stop");
    expect(events).toEqual(["play:Race Next", "control:stop"]);
    expect(appState.player.mode).toBe("stop");
    expect(appState.nowPlaying).toMatchObject({ id: "idle", title: "No track playing" });
  });

  it("does not fall through to LMS next after an app-managed queue is exhausted", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = { id: "current", title: "Current", artist: "Tester", album: "", source: "Local library", duration: 100, elapsed: 5, canSeek: true, art: null, path: "/music/test/current.mp3" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, previousTracks: [], appManagedPlayback: false };
    addQueueItem({ title: "Only Visible Next", artist: "Tester", path: "/music/test/only-visible-next.mp3", requestedBy: "guest" });
    const played: string[] = [];
    const controls: string[] = [];
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string }) {
        played.push(String(track.title || ""));
        return "ok";
      },
      async control(_playerId: string, action: string) {
        controls.push(action);
        return "ok";
      }
    };
    const app = createApp({ lms });

    const first = await request(app).post("/api/player/next").expect(200);
    const second = await request(app).post("/api/player/next").expect(200);

    expect(first.body.action).toBe("visible-queue-next");
    expect(first.body.nowPlaying.title).toBe("Only Visible Next");
    expect(second.body.action).toBe("noop");
    expect(played).toEqual(["Only Visible Next"]);
    expect(controls).not.toContain("next");
    expect(appState.queue).toEqual([]);
  });

  it("uses app history for previous after advancing through visible queued Spotify tracks", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.nowPlaying = {
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      album: "",
      source: "LMS",
      duration: 0,
      elapsed: 0,
      canSeek: false,
      art: null
    };
    appState.playback = { ...appState.playback, previousTracks: [], shuffle: false, smartQueue: false };
    addQueueItem({ title: "Playlist One", artist: "Tester", uri: "spotify:track:0000000000000000000001", source: "Spotify", requestedBy: "guest" });
    addQueueItem({ title: "Playlist Two", artist: "Tester", uri: "spotify:track:0000000000000000000002", source: "Spotify", requestedBy: "guest" });
    const played: Array<{ action: string; track: { title?: string; uri?: string } }> = [];
    const controls: Array<{ action: string }> = [];
    const lms = {
      ...mockLms,
      async playTrack(_playerId: string, track: { title?: string; uri?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      },
      async nowPlaying() {
        return appState.nowPlaying;
      },
      async control(_playerId: string, action: string) {
        controls.push({ action });
        return "ok";
      }
    };
    const app = createApp({ lms });

    const first = await request(app).post("/api/player/next").expect(200);
    const second = await request(app).post("/api/player/next").expect(200);
    const previous = await request(app).post("/api/player/previous").expect(200);

    expect(first.body.nowPlaying).toMatchObject({ title: "Playlist One", uri: "spotify:track:0000000000000000000001" });
    expect(second.body.nowPlaying).toMatchObject({ title: "Playlist Two", uri: "spotify:track:0000000000000000000002" });
    expect(previous.body.action).toBe("app-previous");
    expect(previous.body.nowPlaying).toMatchObject({ title: "Playlist One", uri: "spotify:track:0000000000000000000001" });
    expect(played).toEqual([
      { action: "play-now", track: expect.objectContaining({ title: "Playlist One", uri: "spotify:track:0000000000000000000001" }) },
      { action: "play-now", track: expect.objectContaining({ title: "Playlist Two", uri: "spotify:track:0000000000000000000002" }) },
      { action: "play-now", track: expect.objectContaining({ title: "Playlist One", uri: "spotify:track:0000000000000000000001" }) }
    ]);
    expect(controls).not.toContainEqual({ action: "previous" });
  });

  it("does not resume the last LMS track when next is pressed stopped with an empty queue", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.nowPlaying = {
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      album: "",
      source: "LMS",
      duration: 0,
      elapsed: 0,
      canSeek: false,
      art: null
    };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false };
    const controls: string[] = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string) {
        controls.push(action);
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/next").expect(200);

    expect(response.body.action).toBe("noop");
    expect(response.body.nowPlaying).toMatchObject({ id: "idle", title: "No track playing" });
    expect(controls).toEqual([]);
    expect(appState.player.mode).toBe("stop");
  });

  it("keeps queued tracks visible when next playback fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = {
      id: "current",
      title: "Current Failure Track",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 12,
      canSeek: true,
      art: null,
      path: "/music/test/current-failure.mp3"
    };
    appState.playback = { ...appState.playback, history: ["existing-history"], previousTracks: [] };
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true };
    const lms = {
      ...mockLms,
      async playTrack() {
        throw new Error("LMS refused playback");
      }
    };
    const app = createApp({ lms });

    await request(app)
      .post("/api/player/track")
      .send({ action: "add-queue", track: { title: "Retry Queue Song", artist: "Tester", path: "/music/test/retry-visible.mp3" } })
      .expect(200);

    const response = await request(app).post("/api/player/next").expect(502);

    expect(response.body.error).toContain("LMS refused playback");
    expect(appState.queue).toEqual([expect.objectContaining({ title: "Retry Queue Song" })]);
    expect(appState.playback.history).toEqual(["existing-history"]);
    expect(appState.playback.previousTracks).toEqual([]);
  });

  it("uses the hot player id for visible queue next without waiting on a fresh status call", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true };
    addQueueItem({ title: "Hot Queue Song", artist: "Tester", path: "/music/test/hot-next.mp3" });
    const played: Array<{ playerId: string; action: string; title?: string }> = [];
    const lms = {
      ...mockLms,
      async status() {
        throw new Error("status should not block next");
      },
      async playTrack(playerId: string, track: { title?: string }, action: string) {
        played.push({ playerId, action, title: track.title });
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/next").expect(200);

    expect(response.body.action).toBe("visible-queue-next");
    expect(played).toEqual([{ playerId: "hot-player", action: "play-now", title: "Hot Queue Song" }]);
  });

  it("queues playlist batches in order without issuing one LMS command per track", async () => {
    appState.queue.splice(0, appState.queue.length);
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { title?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });

    const response = await request(app)
      .post("/api/player/tracks")
      .send({
        action: "play-next",
        tracks: [
          { title: "Playlist One", artist: "Tester", path: "/music/test/playlist-one.mp3", source: "Local library" },
          { title: "Playlist Two", artist: "Tester", path: "/music/test/playlist-two.mp3", source: "Local library" },
          { title: "Playlist Three", artist: "Tester", path: "/music/test/playlist-three.mp3", source: "Local library" }
        ]
      })
      .expect(200);

    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Playlist One", "Playlist Two", "Playlist Three"]);
    expect(played).toHaveLength(0);
  });

  it("partially accepts play-next batches without reversing playlist order", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    addQueueItem({ title: "Existing Tail", artist: "Tester", path: "/music/test/existing-tail.mp3", requestedBy: "guest" });
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/tracks")
      .send({
        action: "play-next",
        tracks: [
          { title: "Next One", artist: "Tester", path: "/music/test/next-one.mp3", source: "Local library" },
          { title: "Next Two", artist: "Tester", path: "/music/test/next-two.mp3", source: "Local library" },
          { title: "Next Three", artist: "Tester", path: "/music/test/next-three.mp3", source: "Local library" }
        ]
      })
      .expect(200);

    expect(response.body.accepted).toBe(2);
    expect(response.body.rejected).toBe(1);
    expect(response.body.queued.map((item: { title: string }) => item.title)).toEqual(["Next One", "Next Two"]);
    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Next One", "Next Two", "Existing Tail"]);
  });

  it("serializes concurrent batch queue requests to preserve duplicate and limit checks", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    const app = createApp({ lms: mockLms });
    const payload = {
      action: "add-queue",
      tracks: [
        { title: "Concurrent Batch One", path: "/music/test/concurrent-batch-one.mp3", source: "Local library" },
        { title: "Concurrent Batch Two", path: "/music/test/concurrent-batch-two.mp3", source: "Local library" },
        { title: "Concurrent Batch Three", path: "/music/test/concurrent-batch-three.mp3", source: "Local library" }
      ]
    };

    const responses = await Promise.all([
      request(app).post("/api/player/tracks").send(payload),
      request(app).post("/api/player/tracks").send(payload),
      request(app).post("/api/player/tracks").send(payload)
    ]);

    const accepted = responses.filter((response) => response.status === 200);
    const rejected = responses.filter((response) => response.status !== 200);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].body.accepted).toBe(3);
    expect(rejected.map((response) => response.status).sort()).toEqual([409, 409]);
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual([
      "Concurrent Batch One",
      "Concurrent Batch Two",
      "Concurrent Batch Three"
    ]);
  });

  it("serializes mixed queue endpoints against batch requests", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    const app = createApp({ lms: mockLms });
    const tracks = [
      { title: "Mixed Batch One", path: "/music/test/mixed-batch-one.mp3", source: "Local library" },
      { title: "Mixed Batch Two", path: "/music/test/mixed-batch-two.mp3", source: "Local library" },
      { title: "Mixed Batch Three", path: "/music/test/mixed-batch-three.mp3", source: "Local library" }
    ];

    const responses = await Promise.all([
      request(app).post("/api/player/tracks").send({ action: "add-queue", tracks }),
      request(app).post("/api/player/track").send({ action: "add-queue", track: tracks[0] }),
      request(app).post("/api/queue").send(tracks[1])
    ]);

    const acceptedRows = responses.flatMap((response) => {
      if (response.status === 201) return [response.body.title];
      if (response.status === 200 && Array.isArray(response.body.queued)) return response.body.queued.map((item: { title: string }) => item.title);
      if (response.status === 200 && response.body.queued?.title) return [response.body.queued.title];
      return [];
    });

    expect(acceptedRows).toHaveLength(3);
    expect(new Set(appState.queue.map((item: { path: string }) => item.path)).size).toBe(3);
    expect(appState.queue).toHaveLength(3);
  });

  it("serializes queue clear and delete with concurrent queue additions", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    const app = createApp({ lms: mockLms });
    addQueueItem({ title: "Clear Existing", path: "/music/test/clear-existing.mp3", requestedBy: "guest" });
    const tracks = [
      { title: "Clear Race One", path: "/music/test/clear-race-one.mp3", source: "Local library" },
      { title: "Clear Race Two", path: "/music/test/clear-race-two.mp3", source: "Local library" }
    ];

    const [clearResponse, batchResponse] = await Promise.all([
      request(app).delete("/api/queue"),
      request(app).post("/api/player/tracks").send({ action: "add-queue", tracks })
    ]);

    expect([clearResponse.status, batchResponse.status].sort()).toEqual([200, 200]);
    const afterClearRace = appState.queue.map((item: { title: string }) => item.title);
    expect([[], ["Clear Race One", "Clear Race Two"]]).toContainEqual(afterClearRace);
    expect(afterClearRace).not.toContain("Clear Existing");

    appState.queue.splice(0, appState.queue.length);
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    const removable = addQueueItem({ title: "Delete Race", path: "/music/test/delete-race.mp3", requestedBy: "guest" });
    const [deleteResponse, addResponse] = await Promise.all([
      request(app).delete(`/api/queue/${removable.id}`),
      request(app).post("/api/player/track").send({ action: "add-queue", track: { title: "Delete Race", path: "/music/test/delete-race.mp3", source: "Local library" } })
    ]);

    expect(deleteResponse.status).toBe(200);
    expect([200, 409]).toContain(addResponse.status);
    expect(appState.queue.filter((item: { path: string }) => item.path === "/music/test/delete-race.mp3")).toHaveLength(addResponse.status === 200 ? 1 : 0);
  });

  it("serializes generated playback activation with queue clear", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify", history: [] };
    addQueueItem({ title: "Manual Before Clear", path: "/music/test/manual-before-clear.mp3", requestedBy: "guest" });
    const app = createApp({
      lms: {
        ...mockLms,
        async spotifySearch() {
          return [
            { id: "spotify:generated-one", title: "Generated One", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000001001", kind: "track" },
            { id: "spotify:generated-two", title: "Generated Two", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000001002", kind: "track" }
          ];
        }
      }
    });

    const [clearResponse, smartResponse] = await Promise.all([
      request(app).delete("/api/queue"),
      request(app).post("/api/player/smart-shuffle").send({ source: "spotify", seed: "Tester", count: 2 })
    ]);

    expect([clearResponse.status, smartResponse.status].sort()).toEqual([200, 200]);
    expect(appState.queue.some((item: { title: string }) => item.title === "Manual Before Clear")).toBe(false);
    if (appState.queue.length > 0) {
      expect(appState.playback.smartQueue).toBe(true);
      expect(appState.queue.every((item: { requestedBy: string }) => item.requestedBy === "smart shuffle")).toBe(true);
    } else {
      expect(appState.playback.smartQueue).toBe(false);
    }
  });

  it("serializes transport queue consumption with concurrent batch additions", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, repeat: "off", history: [], previousTracks: [] };
    appState.admin = { ...appState.admin, maxQueuePerUser: 3 };
    addQueueItem({ title: "Transport First", path: "/music/test/transport-first.mp3", requestedBy: "guest" });
    addQueueItem({ title: "Transport Second", path: "/music/test/transport-second.mp3", requestedBy: "guest" });
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return "ok";
        }
      }
    });

    const playRequest = request(app).post("/api/player/play");
    await new Promise((resolve) => setTimeout(resolve, 1));
    const batchRequest = request(app).post("/api/player/tracks").send({
        action: "add-queue",
        tracks: [
          { title: "Transport Third", path: "/music/test/transport-third.mp3", source: "Local library" },
          { title: "Transport Fourth", path: "/music/test/transport-fourth.mp3", source: "Local library" }
        ]
      });
    const [playResponse, batchResponse] = await Promise.all([playRequest, batchRequest]);

    expect(playResponse.status).toBe(200);
    expect(batchResponse.status).toBe(200);
    expect(playResponse.body.action).toBe("visible-queue-play");
    expect(playResponse.body.nowPlaying.title).toBe("Transport First");
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Transport Second", "Transport Third", "Transport Fourth"]);
    expect(batchResponse.body.queue.map((item: { title: string }) => item.title)).toEqual(["Transport Second", "Transport Third", "Transport Fourth"]);
    expect(batchResponse.body.queue.map((item: { title: string }) => item.title)).not.toContain("Transport First");
  });

  it("does not advance playback while refreshing public state", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartShuffleSource: "spotify", history: [] };
    addQueueItem({ title: "Should Stay Queued", artist: "Tester", uri: "spotify:track:stay", source: "Spotify", requestedBy: "smart shuffle" });
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const lms = {
      ...mockLms,
      async nowPlaying() {
        return { ...(await mockLms.nowPlaying()), elapsed: 99.5, duration: 100 };
      },
      async playTrack(_playerId: string, track: { title?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      }
    };

    await request(createApp({ lms })).get("/api/state").expect(200);

    expect(played).toHaveLength(0);
    expect(appState.queue.some((item) => item.title === "Should Stay Queued")).toBe(true);
  });

  it("does not treat stopped manual queues as auto-advance-ready", () => {
    const idleTrack = { id: "idle", title: "No track playing", artist: "Connect a player or request a song", source: "LMS", duration: 0, elapsed: 0 };

    expect(shouldNudgePlayback({ mode: "stop" }, idleTrack, { repeat: "off", smartQueue: false, shuffle: false })).toBe(false);
    expect(shouldNudgePlayback({ mode: "stopped" }, idleTrack, { repeat: "off", smartQueue: true, shuffle: false })).toBe(false);
    expect(shouldNudgePlayback({ mode: "pause" }, { duration: 100, elapsed: 99 }, { repeat: "off", smartQueue: false, shuffle: false })).toBe(false);
    expect(shouldNudgePlayback({ mode: "play" }, { duration: 100, elapsed: 99 }, { repeat: "off", smartQueue: false, shuffle: false })).toBe(true);
    expect(shouldNudgePlayback({ mode: "play" }, { duration: 100, elapsed: 99 }, { repeat: "one", smartQueue: true, shuffle: false })).toBe(false);
  });

  it("does not auto-play generated queue rows while stopped", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: true, smartShuffleSource: "spotify", history: [], appManagedPlayback: false };
    const idleTrack = { id: "idle", title: "No track playing", artist: "Connect a player or request a song", source: "LMS", duration: 0, elapsed: 0 };
    addQueueItem({ title: "Generated Keeper", artist: "Tester", requestedBy: "smart shuffle", uri: "spotify:track:keeper", kind: "track" });
    const played: string[] = [];
    const searched: string[] = [];

    await maintainVisiblePlaybackQueueForTests(
      {
        ...mockLms,
        async control() {
          return "ok";
        },
        async playTrack(_playerId: string, track: { title?: string }) {
          played.push(String(track.title || ""));
          return "ok";
        },
        async spotifySearch(_playerId: string, term: string) {
          searched.push(term);
          return [{ id: "spotify:fresh", title: "Fresh Generated", artist: "Tester", source: "Spotify", uri: "spotify:track:fresh", kind: "track" }];
        }
      },
      { id: "player-1", mode: "stop" },
      idleTrack
    );

    expect(played).toEqual([]);
    expect(appState.queue.some((item: { title: string }) => item.title === "Generated Keeper")).toBe(true);
  });

  it("auto-advances an app-managed visible queue after LMS has already stopped", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: false, smartShuffleSource: "mixed", history: [], appManagedPlayback: true };
    addQueueItem({ title: "Queued After End", artist: "Tester", requestedBy: "guest", path: "/music/queued-after-end.mp3" });
    const played: string[] = [];

    await maintainVisiblePlaybackQueueForTests(
      {
        ...mockLms,
        async control() {
          return "ok";
        },
        async playTrack(_playerId: string, track: { title?: string }) {
          played.push(String(track.title || ""));
          return "ok";
        }
      },
      { id: "player-1", mode: "stop" },
      { id: "idle", title: "No track playing", artist: "Connect a player or request a song", source: "LMS", duration: 0, elapsed: 0 }
    );

    expect(played).toEqual(["Queued After End"]);
    expect(appState.queue).toEqual([]);
    expect(appState.playback.appManagedPlayback).toBe(true);
  });

  it("refresh auto-advances a visible queue before clearing idle app-managed state", async () => {
    resetRefreshStateForTests();
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, history: [], previousTracks: [], appManagedPlayback: true };
    appState.nowPlaying = {
      id: "current",
      title: "Ending Track",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 99,
      canSeek: true,
      art: null,
      path: "/music/ending-track.mp3"
    };
    addQueueItem({ title: "Queued After End", artist: "Tester", requestedBy: "guest", path: "/music/queued-after-end.mp3" });
    const played: string[] = [];

    await refreshLmsForTests(
      {
        ...mockLms,
        async status() {
          return { id: "player-1", name: "Test Speaker", connected: true, online: true, mode: "stop", volume: 44, detail: "stopped" };
        },
        async nowPlaying() {
          return { id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null };
        },
        async playTrack(_playerId: string, track: { title?: string }) {
          played.push(String(track.title || ""));
          return "ok";
        }
      },
      { force: true, maintainPlayback: true }
    );

    expect(played).toEqual(["Queued After End"]);
    expect(appState.nowPlaying.title).toBe("Queued After End");
    expect(appState.playback.appManagedPlayback).toBe(true);
    expect(appState.queue).toEqual([]);
  });

  it("keeps app-managed state during idle polling while a visible queue is waiting", async () => {
    resetRefreshStateForTests();
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, history: [], previousTracks: [], appManagedPlayback: true };
    appState.nowPlaying = {
      id: "current",
      title: "Ending Track",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 99,
      canSeek: true,
      art: null,
      path: "/music/ending-track.mp3"
    };
    addQueueItem({ title: "Queued After End", artist: "Tester", requestedBy: "guest", path: "/music/queued-after-end.mp3" });

    await refreshLmsForTests(
      {
        ...mockLms,
        async status() {
          return { id: "player-1", name: "Test Speaker", connected: true, online: true, mode: "stop", volume: 44, detail: "stopped" };
        },
        async nowPlaying() {
          return { id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null };
        }
      },
      { force: true, maintainPlayback: false }
    );

    expect(appState.nowPlaying.id).toBe("idle");
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Queued After End"]);
    expect(appState.playback.appManagedPlayback).toBe(true);
  });

  it("does not record idle metadata in shuffle history", () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, history: [] };

    syncVisibleQueueWithCurrentTrack({ id: "idle", title: "No track playing", artist: "Connect a player or request a song", source: "LMS", duration: 0, elapsed: 0 });

    expect(appState.playback.history).toEqual([]);
  });

  it("does not consume a user-queued duplicate of the current track during stable shuffle refresh", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = {
      id: "current",
      title: "Current Repeat",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 5,
      canSeek: true,
      art: null,
      path: "/music/test/current-repeat.mp3"
    };
    appState.playback = {
      ...appState.playback,
      shuffle: true,
      smartQueue: false,
      repeat: "off",
      appManagedPlayback: true,
      history: []
    };
    addQueueItem({ title: "Current Repeat", artist: "Tester", requestedBy: "guest", path: "/music/test/current-repeat.mp3" });
    addQueueItem({ title: "Queued After", artist: "Tester", requestedBy: "guest", path: "/music/test/queued-after.mp3" });

    await maintainVisiblePlaybackQueueForTests(
      mockLms,
      { id: "player-1", mode: "play" },
      { title: "Current Repeat", artist: "Tester", duration: 100, elapsed: 6, path: "/music/test/current-repeat.mp3" }
    );

    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Current Repeat", "Queued After"]);
    appState.queue.splice(0, appState.queue.length);
  });

  it("treats LMS metadata for the same advancing song as continuing playback", () => {
    expect(sameContinuingPlayback(
      { title: "Current Repeat", artist: "Tester", elapsed: 12, path: "/music/test/current-repeat.mp3" },
      { title: "Current Repeat", artist: "Tester", elapsed: 16, lmsTrackId: "123" }
    )).toBe(true);
    expect(sameContinuingPlayback(
      { title: "Current Repeat", artist: "Tester", elapsed: 12, path: "/music/test/current-repeat.mp3" },
      { title: "Current Repeat", artist: "Tester", elapsed: 0, lmsTrackId: "123" }
    )).toBe(false);
    expect(sameContinuingPlayback(
      { title: "Current Repeat", artist: "Tester", elapsed: 12, path: "/music/test/current-repeat.mp3" },
      { title: "Different Song", artist: "Tester", elapsed: 16, lmsTrackId: "456" }
    )).toBe(false);
  });

  it("still removes a queued row when playback is observed moving to that row", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = {
      id: "current",
      title: "Old Current",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 98,
      canSeek: true,
      art: null,
      path: "/music/test/old-current.mp3"
    };
    appState.playback = {
      ...appState.playback,
      shuffle: true,
      smartQueue: false,
      repeat: "off",
      appManagedPlayback: true,
      history: []
    };
    addQueueItem({ title: "Observed Next", artist: "Tester", requestedBy: "guest", path: "/music/test/observed-next.mp3" });
    addQueueItem({ title: "Queued After", artist: "Tester", requestedBy: "guest", path: "/music/test/queued-after.mp3" });

    await maintainVisiblePlaybackQueueForTests(
      mockLms,
      { id: "player-1", mode: "play" },
      { title: "Observed Next", artist: "Tester", duration: 100, elapsed: 1, path: "/music/test/observed-next.mp3" },
      { observedTrackChanged: true }
    );

    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Queued After"]);
    appState.queue.splice(0, appState.queue.length);
  });

  it("replaces stale now playing fields when LMS is idle", () => {
    appState.nowPlaying = {
      id: "previous",
      title: "Previous Track",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 12,
      canSeek: true,
      art: null,
      path: "/music/previous.mp3"
    };

    updateNowPlaying({ id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null });

    expect(appState.nowPlaying).toEqual({ id: "idle", title: "No track playing", artist: "Connect a player or request a song", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false, art: null });
  });

  it("resumes playback immediately after seeking when already playing", async () => {
    const controls: Array<{ action: string; value?: number }> = [];
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    updateNowPlaying({ id: "seek-current", title: "Seek Current", artist: "Tester", source: "LMS", duration: 100, elapsed: 5, canSeek: true });
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string, value?: number) {
        controls.push({ action, value });
        return "ok";
      }
    };

    await request(createApp({ lms })).post("/api/player/seek").send({ seconds: 42 }).expect(200);

    expect(controls).toContainEqual({ action: "seek", value: 42 });
    expect(controls).toContainEqual({ action: "play", value: undefined });
  });

  it("reports partial seek success when resume after seek fails", async () => {
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = {
      id: "seek-current",
      title: "Seek Current",
      artist: "Tester",
      album: "",
      source: "Local library",
      duration: 100,
      elapsed: 5,
      canSeek: true,
      art: null,
      path: "/music/test/seek-current.mp3"
    };
    const controls: Array<{ action: string; value?: number }> = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string, value?: number) {
        controls.push({ action, value });
        if (action === "play") throw new Error("resume failed");
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/seek").send({ seconds: 42 }).expect(502);

    expect(response.body).toMatchObject({ error: "resume failed", seconds: 42, seekApplied: true });
    expect(appState.nowPlaying.elapsed).toBe(42);
    expect(appState.player.mode).toBe("play");
    expect(controls).toEqual([{ action: "seek", value: 42 }, { action: "play", value: undefined }]);
  });

  it("returns Spotify search results from Spotty", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/spotify/search?q=drake").expect(200);
    expect(response.body.results[0].uri).toBe("spotify:track:0000000000000000000101");
  });

  it("returns Spotify library sections from Spotty", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/spotify/library?type=playlists").expect(200);
    expect(response.body.results[0].kind).toBe("playlist");
  });

  it("rejects invalid Spotify browse parameters before calling Spotty", async () => {
    const calls: string[] = [];
    const lms = {
      ...mockLms,
      async status() {
        calls.push("status");
        throw new Error("status should not run for invalid Spotify params");
      },
      async spotifySearch() {
        calls.push("search");
        return [];
      },
      async spotifyLibrary() {
        calls.push("library");
        return [];
      },
      async spotifyChildren() {
        calls.push("children");
        return [];
      }
    };
    const app = createApp({ lms });

    await request(app).get("/api/spotify/library?type=bad").expect(400);
    await request(app).get("/api/spotify/search?q=drake&limit=0").expect(400);
    await request(app).get("/api/spotify/search?q=drake&limit=51").expect(400);
    await request(app).get("/api/spotify/library?type=playlists&limit=0").expect(400);
    await request(app).get("/api/spotify/library?type=playlists&offset=-1").expect(400);
    await request(app).get("/api/spotify/children?kind=bad&uri=spotify%3Aplaylist%3A1").expect(400);
    await request(app).get("/api/spotify/children?kind=playlist").expect(400);
    await request(app).get("/api/spotify/children?kind=track&uri=spotify%3Aplaylist%3A1").expect(400);
    await request(app).get("/api/spotify/children?kind=playlist&uri=spotify%3Aalbum%3A1").expect(400);
    await request(app).get("/api/spotify/children?kind=album&uri=spotify%3Aplaylist%3A1").expect(400);
    await request(app).get("/api/spotify/children?kind=artist&uri=spotify%3Aplaylist%3A1").expect(400);
    await request(app).get("/api/spotify/children?kind=playlist&uri=notspotify").expect(400);
    await request(app).get("/api/spotify/children?kind=playlist&uri=spotify%3Aplaylist%3A1&limit=0").expect(400);
    await request(app).get("/api/spotify/children?kind=playlist&uri=spotify%3Aplaylist%3A1&offset=-1").expect(400);

    expect(calls).toEqual([]);
  });

  it("accepts spotify slash URI forms for matching child browse kinds", async () => {
    const requests: Array<{ uri?: string; kind?: string }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async spotifyChildren(_playerId: string, input: { uri?: string; kind?: string }) {
          requests.push(input);
          return [];
        }
      }
    });

    await request(app).get("/api/spotify/children?kind=playlist&uri=spotify%3A%2F%2Fplaylist%3Aabc123").expect(200);
    await request(app).get("/api/spotify/children?kind=album&uri=spotify%3A%2F%2Falbum%3Aabc123").expect(200);
    await request(app).get("/api/spotify/children?kind=artist&uri=spotify%3A%2F%2Fartist%3Aabc123").expect(200);
    await request(app).get("/api/spotify/children?kind=album&uri=spotify%3A%2F%2Fplaylist%3Aabc123").expect(400);

    expect(requests.map((item) => `${item.kind}:${item.uri}`)).toEqual([
      "playlist:spotify://playlist:abc123",
      "album:spotify://album:abc123",
      "artist:spotify://artist:abc123"
    ]);
  });

  it("returns empty Spotify search results without touching LMS for blank queries", async () => {
    const calls: string[] = [];
    const lms = {
      ...mockLms,
      async status() {
        calls.push("status");
        throw new Error("status should not run for empty Spotify search");
      },
      async spotifySearch() {
        calls.push("search");
        return [];
      }
    };

    const response = await request(createApp({ lms })).get("/api/spotify/search?q=%20%20&limit=20").expect(200);

    expect(response.body.results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("opens Spotify playlist children instead of queueing playlist containers", async () => {
    const response = await request(createApp({ lms: mockLms }))
      .get("/api/spotify/children?uri=spotify%3Aplaylist%3A1&kind=playlist")
      .expect(200);
    expect(response.body.results[0]).toMatchObject({ title: "Playlist Track", kind: "track" });
  });

  it("passes Spotify child titles through for artist fallback", async () => {
    const calls: unknown[] = [];
    const lms = {
      ...mockLms,
      async spotifyChildren(_playerId: string, target: unknown) {
        calls.push(target);
        return [];
      }
    };

    await request(createApp({ lms }))
      .get("/api/spotify/children?browseId=7.0&uri=spotify%3Aartist%3A1&kind=artist&title=Ado")
      .expect(200);

    expect(calls).toEqual([{ browseId: "7.0", uri: "spotify:artist:1", kind: "artist", title: "Ado" }]);
  });

  it("returns fast empty Spotify results when Spotty is configured but unreachable", async () => {
    const previousSpotify = { ...appState.services.spotify };
    const calls: string[] = [];
    const lms = {
      ...mockLms,
      async spotifySearch() {
        calls.push("search");
        return [];
      },
      async spotifyLibrary() {
        calls.push("library");
        return [];
      },
      async spotifyChildren() {
        calls.push("children");
        return [];
      },
      async spotifyStatus() {
        return { configured: true, reachable: false, detail: "Reauthorize Spotty in LMS" };
      }
    };
    appState.services.spotify = { configured: true, reachable: false, detail: "Reauthorize Spotty in LMS" };
    try {
      const app = createApp({ lms });
      const search = await request(app).get("/api/spotify/search?q=drake").expect(200);
      const library = await request(app).get("/api/spotify/library?type=playlists").expect(200);
      const children = await request(app).get("/api/spotify/children?uri=spotify%3Aplaylist%3A1&kind=playlist").expect(200);

      expect(search.body.results).toEqual([]);
      expect(library.body.results).toEqual([]);
      expect(children.body.results).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      appState.services.spotify = previousSpotify;
    }
  });

  it("rejects Spotify-only generated queues when Spotify browsing is unreachable", async () => {
    const previousSpotify = { ...appState.services.spotify };
    const previousPlayback = { ...appState.playback };
    appState.services.spotify = { configured: true, reachable: false, detail: "Reauthorize Spotty in LMS" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "mixed" };
    try {
      const app = createApp({ lms: mockLms });
      const smartShuffle = await request(app)
        .post("/api/player/smart-shuffle")
        .send({ source: "spotify", count: 2, seed: "drake" })
        .expect(503);
      const playback = await request(app)
        .post("/api/player/playback")
        .send({ smartQueue: true, smartShuffleSource: "spotify" })
        .expect(503);

      expect(smartShuffle.body.error).toContain("Reauthorize Spotty");
      expect(smartShuffle.body.queued).toEqual([]);
      expect(playback.body.error).toContain("Reauthorize Spotty");
      expect(appState.playback.smartQueue).toBe(false);
    } finally {
      appState.services.spotify = previousSpotify;
      appState.playback = previousPlayback;
    }
  });

  it("allows regular visible-queue shuffle when Spotify browsing is unreachable", async () => {
    const previousSpotify = { ...appState.services.spotify };
    const previousPlayback = { ...appState.playback };
    appState.queue.splice(0, appState.queue.length);
    appState.services.spotify = { configured: true, reachable: false, detail: "Reauthorize Spotty in LMS" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify" };
    addQueueItem({ title: "Visible Shuffle One", artist: "Tester", uri: "spotify:track:visible-one", source: "Spotify", requestedBy: "guest" });
    addQueueItem({ title: "Visible Shuffle Two", artist: "Tester", uri: "spotify:track:visible-two", source: "Spotify", requestedBy: "guest" });
    try {
      const response = await request(createApp({ lms: mockLms }))
        .post("/api/player/playback")
        .send({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" })
        .expect(200);

      expect(response.body.playback).toMatchObject({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" });
      expect(response.body.queued).toEqual([]);
      expect(response.body.queue).toHaveLength(2);
      expect(response.body.queue.every((item: { requestedBy: string }) => item.requestedBy === "guest")).toBe(true);
    } finally {
      appState.services.spotify = previousSpotify;
      appState.playback = previousPlayback;
    }
  });

  it("accepts only validated audio uploads", async () => {
    const previousUploadDir = config.uploadDir;
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-upload-"));
    config.musicSourceDir = root;
    config.uploadDir = path.join(root, "uploads");
    const app = createApp({ lms: mockLms });
    try {
      await request(app)
        .post("/api/library/upload?filename=bad.exe")
        .set("content-type", "application/octet-stream")
        .send(Buffer.from("MZ fake executable"))
        .expect(400);
      const wrongType = await request(app)
        .post("/api/library/upload?filename=test.mp3")
        .set("content-type", "text/plain")
        .send(Buffer.from("ID3"))
        .expect(415);
      expect(wrongType.body.error).toContain("application/octet-stream");

      const uploaded = await request(app)
        .post("/api/library/upload?filename=test.mp3")
        .set("content-type", "application/octet-stream")
        .send(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32)]))
        .expect(201);

      expect(uploaded.body.track.source).toBe("Uploaded");
      expect(uploaded.body.track.uploaded).toBe(true);
      expect(uploaded.body.lmsRescan).toBe(true);
      const uploadedSearch = await request(app).get("/api/library/search?source=uploaded").expect(200);
      expect(uploadedSearch.body.results).toHaveLength(1);
      expect(uploadedSearch.body.results[0].source).toBe("Uploaded");
      const stateAfterUploadedSearch = await request(app).get("/api/state").expect(200);
      expect(stateAfterUploadedSearch.body.services.localLibrary.root).toBe(root);
      expect(stateAfterUploadedSearch.body.services.localLibrary.trackCount).toBe(1);
      await request(app).get("/api/library/search?source=bad").expect(400);
      await request(app).get("/api/library/collections?source=bad").expect(400);
      await request(app).get("/api/library/collection?source=bad").expect(400);
      const blankCollection = await request(app).get("/api/library/collection?source=all").expect(400);
      expect(blankCollection.body.error).toContain("Collection or folder");
      await request(app).get("/api/library/search?source=local&limit=0").expect(400);
      await request(app).get("/api/library/search?source=local&limit=-1").expect(400);
      await request(app).get("/api/library/collection?source=local&collection=uploads&limit=0").expect(400);

      const encodedPath = Buffer.from(uploaded.body.track.path).toString("base64url");
      const stream = await request(app).get(`/api/stream/${encodedPath}`).expect(200);
      expect(stream.headers["content-type"]).toContain("audio/mpeg");
      expect(stream.body.length).toBeGreaterThan(0);

      const malformedRange = await request(app).get(`/api/stream/${encodedPath}`).set("range", "bad-range").expect(416);
      expect(malformedRange.headers["content-range"]).toContain("bytes */");
      const suffixRange = await request(app).get(`/api/stream/${encodedPath}`).set("range", "bytes=-4").expect(206);
      expect(suffixRange.headers["content-range"]).toMatch(/bytes \d+-\d+\/\d+/);
      expect(suffixRange.body.length).toBe(4);
    } finally {
      config.uploadDir = previousUploadDir;
      config.musicSourceDir = previousMusicDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns JSON 404s for unknown API routes", async () => {
    const app = createApp({ lms: mockLms });

    const response = await request(app).get("/api/artwork/").expect(404);

    expect(response.body).toEqual({ error: "API route not found" });
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("does not follow library symlinks outside allowed roots", async () => {
    appState.queue.splice(0, appState.queue.length);
    const previousStrict = process.env.STRICT_PUBLIC_TRACK_VALIDATION;
    const previousUploadDir = config.uploadDir;
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-safe-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-outside-root-"));
    config.musicSourceDir = path.join(root, "music");
    config.uploadDir = path.join(root, "uploads");
    process.env.STRICT_PUBLIC_TRACK_VALIDATION = "1";
    const outsideTrack = path.join(outside, "outside.mp3");
    const linkTrack = path.join(config.musicSourceDir, "linked-outside.mp3");
    const app = createApp({ lms: mockLms });
    try {
      await fs.mkdir(config.musicSourceDir, { recursive: true });
      await fs.mkdir(config.uploadDir, { recursive: true });
      await fs.writeFile(outsideTrack, Buffer.from("ID3 outside"));
      await fs.symlink(outsideTrack, linkTrack);

      await request(app)
        .post("/api/player/track")
        .send({ action: "add-queue", track: { title: "Linked Outside", artist: "Tester", path: linkTrack } })
        .expect(400);

      const encoded = Buffer.from(linkTrack).toString("base64url");
      await request(app).get(`/api/stream/${encoded}`).expect(404);
      expect(appState.queue).toHaveLength(0);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    } finally {
      if (previousStrict === undefined) delete process.env.STRICT_PUBLIC_TRACK_VALIDATION;
      else process.env.STRICT_PUBLIC_TRACK_VALIDATION = previousStrict;
      config.uploadDir = previousUploadDir;
      config.musicSourceDir = previousMusicDir;
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent library rescans", async () => {
    const previousMusicDir = config.musicSourceDir;
    const previousUploadDir = config.uploadDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-rescan-"));
    config.musicSourceDir = root;
    config.uploadDir = path.join(root, "uploads");
    const app = createApp({ lms: mockLms });
    try {
      await fs.writeFile(path.join(root, "Artist - One.mp3"), "ID3");
      await request(app).post("/api/library/rescan").expect(401);
      const login = await request(app).post("/api/admin/login").send({ password: "admin" }).expect(200);
      const [first, second] = await Promise.all([
        request(app).post("/api/library/rescan").set("Authorization", `Bearer ${login.body.token}`).expect(200),
        request(app).post("/api/library/rescan").set("Authorization", `Bearer ${login.body.token}`).expect(200)
      ]);

      expect(first.body.trackCount).toBe(second.body.trackCount);
      expect(first.body.sample.map((track: { title: string }) => track.title)).toEqual(second.body.sample.map((track: { title: string }) => track.title));
    } finally {
      config.musicSourceDir = previousMusicDir;
      config.uploadDir = previousUploadDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("updates shuffle and repeat playback settings", async () => {
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-empty-library-"));
    config.musicSourceDir = root;
    try {
      const response = await request(createApp({ lms: mockLms }))
        .post("/api/player/playback")
        .send({ shuffle: true, repeat: "all", smartShuffleSource: "mixed" })
        .expect(200);
      expect(response.body.playback).toMatchObject({ shuffle: true, repeat: "all", smartShuffleSource: "mixed" });
    } finally {
      config.musicSourceDir = previousMusicDir;
    }
  });

  it("does not mutate repeat when LMS repeat control fails", async () => {
    appState.playback = { ...appState.playback, repeat: "off", shuffle: false, smartQueue: false };
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          if (action === "repeat") throw new Error("LMS refused repeat");
          return "ok";
        }
      }
    }))
      .post("/api/player/playback")
      .send({ repeat: "all" })
      .expect(502);

    expect(response.body.error).toContain("LMS refused repeat");
    expect(response.body.playback.repeat).toBe("off");
    expect(appState.playback.repeat).toBe("off");
  });

  it("does not mutate queue mode or generated rows when LMS shuffle disable fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = {
      ...appState.playback,
      shuffle: false,
      smartQueue: false,
      repeat: "off",
      lastShuffleRefillAt: 12345,
      lastShuffleSeed: "stable-seed",
      lastSmartQueueBase: "stable-base"
    };
    addQueueItem({ title: "Generated Existing", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:generated-existing" });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          if (action === "shuffle") throw new Error("LMS refused shuffle");
          return "ok";
        }
      }
    }))
      .post("/api/player/playback")
      .send({ shuffle: true, smartQueue: false })
      .expect(502);

    expect(response.body.error).toContain("LMS refused shuffle");
    expect(response.body.playback).toMatchObject({
      shuffle: false,
      smartQueue: false,
      repeat: "off",
      lastShuffleRefillAt: 12345,
      lastShuffleSeed: "stable-seed",
      lastSmartQueueBase: "stable-base"
    });
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Generated Existing"]);
  });

  it("rejects malformed playback settings instead of silently ignoring them", async () => {
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .send({ repeat: "bad", shuffle: "yes", smartQueue: "no", smartShuffleSource: "bad" })
      .expect(400);

    expect(response.body.error).toBe("Invalid playback settings");
  });

  it("rejects ambiguous playback queue modes", async () => {
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false };
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .send({ shuffle: true, smartQueue: true })
      .expect(400);

    expect(response.body.error).toBe("Invalid playback settings");
    expect(appState.playback).toMatchObject({ shuffle: false, smartQueue: false });
  });

  it("rejects empty playback updates instead of returning a no-op success", async () => {
    await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .send({})
      .expect(400);
    await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .set("content-type", "text/plain")
      .send("shuffle=true")
      .expect(400);
  });

  it("regular shuffle randomizes only the visible queue", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "spotify", history: [] };
    addQueueItem({ title: "Queued A", artist: "Tester", uri: "spotify:track:a", source: "Spotify", requestedBy: "guest" });
    addQueueItem({ title: "Queued B", artist: "Tester", uri: "spotify:track:b", source: "Spotify", requestedBy: "guest" });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async spotifySearch() {
          return [
            { id: "spotify:current", title: "Headlines", artist: "Drake", source: "Spotify", uri: "spotify:track:0000000000000000000103", kind: "track" },
            { id: "spotify:other", title: "Nonstop", artist: "Drake", source: "Spotify", uri: "spotify:track:other", kind: "track" }
          ];
        }
      }
    }))
      .post("/api/player/playback")
      .send({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" })
      .expect(200);

    expect(response.body.playback).toMatchObject({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" });
    expect(response.body.queue.map((item: { requestedBy: string }) => item.requestedBy)).toEqual(["guest", "guest"]);
    expect(response.body.queued).toHaveLength(0);
    expect(response.body.playback.repeat).toBe("off");
  });

  it("regular shuffle generates a visible queue when no manual songs are queued", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "spotify", history: [] };
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async spotifySearch() {
          return [
            { id: "spotify:shuffle-one", title: "Shuffle One", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000000101", kind: "track" },
            { id: "spotify:shuffle-one-alt", title: "Shuffle One", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000000103", kind: "track" },
            { id: "spotify:shuffle-two", title: "Shuffle Two", artist: "Tester", source: "Spotify", uri: "spotify:track:0000000000000000000102", kind: "track" }
          ];
        }
      }
    }))
      .post("/api/player/playback")
      .send({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" })
      .expect(200);

    expect(response.body.playback).toMatchObject({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" });
    expect(response.body.queued).toHaveLength(2);
    expect(response.body.queued.map((item: { title: string }) => item.title).sort()).toEqual(["Shuffle One", "Shuffle Two"]);
    expect(response.body.queue.map((item: { requestedBy: string }) => item.requestedBy)).toEqual(["shuffle", "shuffle"]);
  });

  it("rejects smart-shuffle cycling while manual playlist rows are queued", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = {
      ...appState.playback,
      shuffle: true,
      smartQueue: false,
      repeat: "off",
      smartShuffleSource: "spotify",
      lastShuffleRefillAt: 12345,
      lastShuffleSeed: "playlist",
      lastSmartQueueBase: "playlist-base",
      history: []
    };
    addQueueItem({ title: "Playlist A", artist: "Tester", uri: "spotify:track:playlist-a", source: "Spotify", requestedBy: "guest" });
    addQueueItem({ title: "Playlist B", artist: "Tester", uri: "spotify:track:playlist-b", source: "Spotify", requestedBy: "guest" });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async spotifySearch() {
          return [{ id: "spotify:random", title: "Unrelated Random", artist: "Tester", source: "Spotify", uri: "spotify:track:random", kind: "track" }];
        }
      }
    }))
      .post("/api/player/playback")
      .send({ smartQueue: true, smartShuffleSource: "spotify" })
      .expect(409);

    expect(response.body.error).toContain("Clear the queue");
    expect(response.body.playback).toMatchObject({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" });
    expect(response.body.playback.lastShuffleRefillAt).toBe(12345);
    expect(response.body.playback.lastShuffleSeed).toBe("playlist");
    expect(response.body.playback.lastSmartQueueBase).toBe("playlist-base");
    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Playlist A", "Playlist B"]);
    expect(response.body.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ requestedBy: "smart shuffle" })]));
    expect(appState.playback).toMatchObject({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" });
  });

  it("requires admin access for recent queue and playback debug events", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify", history: [] };
    const app = createApp({ lms: mockLms });

    await request(app).get("/api/debug/logs?limit=10").expect(401);
    const login = await request(app).post("/api/admin/login").send({ password: "admin" }).expect(200);

    await request(app)
      .post("/api/player/playback")
      .send({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" })
      .expect(200);
    await request(app)
      .get("/api/debug/logs?limit=abc")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(400);
    await request(app)
      .get("/api/debug/logs?limit=0")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(400);
    await request(app)
      .get("/api/debug/logs?limit=-1")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(400);
    await request(app)
      .get("/api/debug/logs?limit=1.5")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(400);
    await request(app)
      .get("/api/debug/logs?limit=501")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(400);
    const logs = await request(app)
      .get("/api/debug/logs?limit=10")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(logs.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "playback.request" }),
        expect.objectContaining({ type: "playback.result" })
      ])
    );
  });

  it("repeat changes do not regenerate or remove generated queue rows", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: true, smartShuffleSource: "spotify", history: [] };
    addQueueItem({ title: "Smart Existing", artist: "Tester", requestedBy: "smart shuffle", uri: "spotify:track:existing" });
    addQueueItem({ title: "Manual Existing", artist: "Tester", requestedBy: "guest", path: "/music/manual.mp3" });
    const controls: Array<{ action: string; value: string }> = [];

    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value: string) {
          controls.push({ action, value });
          return "ok";
        }
      }
    }))
      .post("/api/player/playback")
      .send({ repeat: "one" })
      .expect(200);

    expect(response.body.playback.repeat).toBe("one");
    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Smart Existing", "Manual Existing"]);
    expect(controls).toContainEqual({ action: "repeat", value: "one" });
    expect(controls).not.toContainEqual({ action: "repeat", value: "off" });
  });

  it("manual queueing is non destructive while generated shuffle is active", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: false, smartShuffleSource: "spotify", repeat: "off", history: [] };
    addQueueItem({ title: "Generated A", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:generated-a" });
    addQueueItem({ title: "Generated B", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:generated-b" });
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async playTrack(_playerId: string, track: { title?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    });

    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "play-next", track: { title: "Manual Heavy", artist: "Tester", path: "/music/manual-heavy.mp3" } })
      .expect(200);

    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Manual Heavy", "Generated A", "Generated B"]);
    expect(played).toHaveLength(0);
  });

  it("manual next does not disable repeat one", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: false, smartShuffleSource: "spotify", repeat: "one", history: [] };
    addQueueItem({ title: "Generated A", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:generated-a" });
    const controls: Array<{ action: string; value: string }> = [];
    const app = createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value: string) {
          controls.push({ action, value });
          return "ok";
        }
      }
    });

    await request(app).post("/api/player/next").expect(200);

    expect(appState.playback.repeat).toBe("one");
    expect(controls).not.toContainEqual({ action: "repeat", value: "off" });
  });

  it("does not advance generated next when LMS shuffle disable fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: false, smartShuffleSource: "spotify", repeat: "off", history: [] };
    addQueueItem({ title: "Generated A", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:generated-a" });
    const played: Array<{ action: string; track: { title?: string } }> = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string) {
          if (action === "shuffle") throw new Error("LMS refused shuffle");
          return "ok";
        },
        async playTrack(_playerId: string, track: { title?: string }, action: string) {
          played.push({ action, track });
          return "ok";
        }
      }
    }))
      .post("/api/player/next")
      .expect(502);

    expect(response.body.error).toContain("LMS refused shuffle");
    expect(played).toHaveLength(0);
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Generated A"]);
  });

  it("manual play now stops generated shuffle instead of queueing unrelated tracks", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: true, smartQueue: false, smartShuffleSource: "spotify", repeat: "off", history: [] };
    addQueueItem({ title: "Generated A", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:generated-a" });
    const app = createApp({
      lms: {
        ...mockLms,
        async spotifySearch() {
          return [{ id: "spotify:new-seed", title: "New Seed Pick", artist: "New Artist", source: "Spotify", uri: "spotify:track:new-seed", kind: "track" }];
        }
      }
    });

    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Manual Play", artist: "New Artist", path: "/music/manual-play.mp3", source: "Local library" } })
      .expect(200);

    expect(response.body.playback).toMatchObject({ shuffle: false, smartQueue: false });
    expect(response.body.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "New Seed Pick", requestedBy: "shuffle" })]));
    expect(response.body.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Generated A" })]));
  });

  it("queues smart shuffle picks from Spotify and local sources", async () => {
    const played: Array<{ action: string; track: { uri?: string } }> = [];
    const uniqueShuffleLms = {
      ...mockLms,
      async spotifySearch() {
        return [{ id: "spotify:unique-smart", title: "Fresh Shuffle", artist: "Tester", source: "Spotify", uri: "spotify:track:unique-smart" }];
      },
      async playTrack(_playerId: string, track: { uri?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      }
    };
    const response = await request(createApp({ lms: uniqueShuffleLms }))
      .post("/api/player/smart-shuffle")
      .send({ source: "spotify", count: 1 })
      .expect(200);
    expect(response.body.queued[0].source).toBe("Spotify");
    expect(response.body.queue[0].source).toBe("Spotify");
    expect(response.body.playback.smartQueue).toBe(true);
    expect(response.body.playback.smartShuffleSource).toBe("spotify");
    expect(played).toHaveLength(0);
  });

  it("rejects explicit smart shuffle while requested songs are queued", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify", history: [] };
    addQueueItem({ title: "Manual Playlist One", artist: "Tester", uri: "spotify:track:manual-one", source: "Spotify", requestedBy: "guest" });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async status() {
          throw new Error("status should not run for rejected smart shuffle");
        },
        async spotifySearch() {
          return [{ id: "spotify:random", title: "Unrelated Random", artist: "Tester", source: "Spotify", uri: "spotify:track:random", kind: "track" }];
        }
      }
    }))
      .post("/api/player/smart-shuffle")
      .send({ source: "spotify", count: 3 })
      .expect(409);

    expect(response.body.error).toContain("Clear the queue");
    expect(response.body.queued).toEqual([]);
    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Manual Playlist One"]);
    expect(response.body.playback).toMatchObject({ shuffle: false, smartQueue: false, smartShuffleSource: "spotify" });
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Manual Playlist One"]);
    expect(appState.playback).toMatchObject({ shuffle: false, smartQueue: false, smartShuffleSource: "spotify" });
  });

  it("rejects malformed smart shuffle requests before queue generation", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "mixed" };
    const app = createApp({ lms: mockLms });

    await request(app).post("/api/player/smart-shuffle").send({ source: "bad", count: 1 }).expect(400);
    await request(app).post("/api/player/smart-shuffle").send({ source: "local", count: [] }).expect(400);
    await request(app).post("/api/player/smart-shuffle").send({ source: "local", count: "1" }).expect(400);
    await request(app).post("/api/player/smart-shuffle").send({ source: "local", count: 9 }).expect(400);
    await request(app).post("/api/player/smart-shuffle").send({ source: "local", extra: true }).expect(400);

    expect(appState.queue).toHaveLength(0);
    expect(appState.playback.smartQueue).toBe(false);
  });

  it("does not add broad unrelated local rows to mixed smart shuffle when the seed only matches Spotify", async () => {
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-mixed-smart-"));
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "mixed", history: [] };
    config.musicSourceDir = root;
    try {
      await fs.writeFile(path.join(root, "Juice WRLD - Random Local.mp3"), "ID3");
      const response = await request(createApp({
        lms: {
          ...mockLms,
          async spotifySearch(_playerId: string, term: string) {
            return [{ id: `spotify:${term}`, title: `${term} Track`, artist: term, source: "Spotify", uri: `spotify:track:${term}`, kind: "track" }];
          }
        }
      }))
        .post("/api/player/smart-shuffle")
        .send({ source: "mixed", count: 3, seed: "Aimer" })
        .expect(200);

      expect(response.body.queued).toEqual(expect.arrayContaining([expect.objectContaining({ artist: "Aimer", source: "Spotify" })]));
      expect(response.body.queued.every((item: { source: string }) => item.source === "Spotify")).toBe(true);
      expect(response.body.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Random Local" })]));
    } finally {
      config.musicSourceDir = previousMusicDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("clears generated history when smart-shuffle source or seed changes", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = {
      ...appState.playback,
      shuffle: false,
      smartQueue: true,
      smartShuffleSource: "spotify",
      lastShuffleSeed: "Aimer",
      history: ["spotify:track:aimer-one", "spotify:track:aimer-two"]
    };
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async spotifySearch(_playerId: string, term: string) {
          return [
            { id: "spotify:one", title: `${term} One`, artist: term, source: "Spotify", uri: "spotify:track:aimer-one", kind: "track" },
            { id: "spotify:two", title: `${term} Two`, artist: term, source: "Spotify", uri: "spotify:track:aimer-two", kind: "track" }
          ];
        }
      }
    }))
      .post("/api/player/smart-shuffle")
      .send({ source: "mixed", count: 2, seed: "Aimer" })
      .expect(200);

    expect(response.body.queued.map((item: { uri: string }) => item.uri).sort()).toEqual(["spotify:track:aimer-one", "spotify:track:aimer-two"]);
    expect([...response.body.playback.history].sort()).toEqual(["spotify:track:aimer-one", "spotify:track:aimer-two"]);
  });

  it("does not use idle placeholder text as smart-shuffle search terms", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = {
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      album: "",
      source: "LMS",
      duration: 0,
      elapsed: 0,
      canSeek: false,
      art: null
    };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify", lastShuffleSeed: "", history: [] };
    const searched: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async nowPlaying() {
          return {
            id: "idle",
            title: "No track playing",
            artist: "Connect a player or request a song",
            album: "",
            source: "LMS",
            duration: 0,
            elapsed: 0,
            canSeek: false,
            art: null
          };
        },
        async spotifySearch(_playerId: string, term: string) {
          searched.push(term);
          return [{ id: `spotify:${term}`, title: `${term} Track`, artist: term, source: "Spotify", uri: `spotify:track:${term}`, kind: "track" }];
        }
      }
    }))
      .post("/api/player/smart-shuffle")
      .send({ source: "spotify", count: 2, seed: "Aimer" })
      .expect(200);

    expect(searched).toEqual(["Aimer"]);
    expect(response.body.queued.map((item: { artist: string }) => item.artist)).toEqual(["Aimer"]);
  });

  it("does not use idle placeholder text when source switching activates smart queue", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = {
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      album: "",
      source: "LMS",
      duration: 0,
      elapsed: 0,
      canSeek: false,
      art: null
    };
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "stop" };
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify", lastShuffleSeed: "Aimer", history: [] };
    const searched: string[] = [];
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async spotifySearch(_playerId: string, term: string) {
          searched.push(term);
          return [{ id: `spotify:${term}`, title: `${term} Track`, artist: term, source: "Spotify", uri: `spotify:track:${term}`, kind: "track" }];
        }
      }
    }))
      .post("/api/player/playback")
      .send({ smartQueue: true, smartShuffleSource: "spotify" })
      .expect(200);

    expect(searched).toEqual(["Aimer"]);
    expect(response.body.playback.lastShuffleSeed).toBe("Aimer");
    expect(response.body.queued.map((item: { artist: string }) => item.artist)).toEqual(["Aimer"]);
  });

  it("uses the previous smart-shuffle seed for idle background top-off", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.nowPlaying = {
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      album: "",
      source: "LMS",
      duration: 0,
      elapsed: 0,
      canSeek: false,
      art: null
    };
    appState.playback = {
      ...appState.playback,
      shuffle: false,
      smartQueue: true,
      smartShuffleSource: "spotify",
      lastShuffleSeed: "Aimer",
      lastShuffleRefillAt: 0,
      history: []
    };
    const searched: string[] = [];
    await maintainVisiblePlaybackQueueForTests(
      {
        ...mockLms,
        async spotifySearch(_playerId: string, term: string) {
          searched.push(term);
          return [{ id: `spotify:${term}`, title: `${term} Track`, artist: term, source: "Spotify", uri: `spotify:track:${term}`, kind: "track" }];
        }
      },
      { id: "player-1", mode: "stop" },
      appState.nowPlaying
    );

    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((term) => term === "Aimer")).toBe(true);
    expect(appState.queue.every((item: { artist: string }) => item.artist === "Aimer")).toBe(true);
    expect(appState.playback.lastShuffleSeed).toBe("Aimer");
  });

  it("does not mutate smart-shuffle state when LMS repeat-off control fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, repeat: "one", smartShuffleSource: "mixed" };
    addQueueItem({ title: "Generated Existing", artist: "Tester", requestedBy: "smart shuffle", uri: "spotify:track:generated-existing" });
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value: string) {
          if (action === "repeat" && value === "off") throw new Error("LMS refused repeat off");
          return "ok";
        }
      }
    }))
      .post("/api/player/smart-shuffle")
      .send({ source: "local", count: 1 })
      .expect(502);

    expect(response.body.error).toContain("LMS refused repeat off");
    expect(appState.playback).toMatchObject({ shuffle: false, smartQueue: false, repeat: "one", smartShuffleSource: "mixed" });
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Generated Existing"]);
  });

  it("does not enable smart queue through playback when repeat-off control fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, repeat: "one", smartShuffleSource: "local" };
    const response = await request(createApp({
      lms: {
        ...mockLms,
        async control(_playerId: string, action: string, value: string) {
          if (action === "repeat" && value === "off") throw new Error("LMS refused repeat off");
          return "ok";
        }
      }
    }))
      .post("/api/player/playback")
      .send({ smartQueue: true, smartShuffleSource: "local" })
      .expect(502);

    expect(response.body.error).toContain("LMS refused repeat off");
    expect(appState.playback).toMatchObject({ shuffle: false, smartQueue: false, repeat: "one", smartShuffleSource: "local" });
    expect(appState.queue).toHaveLength(0);
  });

  it("regenerates smart queue from the selected source and preserves user queue rows", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: true, smartShuffleSource: "mixed", history: [] };
    addQueueItem({ title: "Guest Pick", artist: "Tester", requestedBy: "guest", path: "/music/guest.mp3" });
    addQueueItem({ title: "Old Local Smart", artist: "Tester", requestedBy: "smart shuffle", path: "/music/local.mp3" });

    const app = createApp({
      lms: {
        ...mockLms,
        async spotifySearch() {
          return [{ id: "spotify:fresh", title: "Fresh Spotify", artist: "Tester", source: "Spotify", uri: "spotify:track:fresh", kind: "track" }];
        }
      }
    });
    const response = await request(app)
      .post("/api/player/playback")
      .send({ smartQueue: true, smartShuffleSource: "spotify" })
      .expect(200);

    expect(response.body.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Guest Pick", requestedBy: "guest" }),
        expect.objectContaining({ title: "Fresh Spotify", requestedBy: "smart shuffle", uri: "spotify:track:fresh" })
      ])
    );
    expect(response.body.queue).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Old Local Smart" })]));
    expect(response.body.queue.filter((item: { requestedBy: string; uri?: string }) => item.requestedBy === "smart shuffle").every((item: { uri?: string }) => item.uri?.startsWith("spotify:track:"))).toBe(true);
  });

  it("turns off smart queue without removing user requested songs", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = {
      ...appState.playback,
      shuffle: false,
      smartQueue: true,
      smartShuffleSource: "mixed",
      lastShuffleRefillAt: 12345,
      lastShuffleSeed: "stale seed",
      lastSmartQueueBase: "stale base",
      history: []
    };
    addQueueItem({ title: "Manual Next", artist: "Tester", requestedBy: "guest", path: "/music/manual.mp3" });
    addQueueItem({ title: "Generated Next", artist: "Tester", requestedBy: "smart shuffle", uri: "spotify:track:generated" });

    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .send({ smartQueue: false, shuffle: false })
      .expect(200);

    expect(response.body.playback.smartQueue).toBe(false);
    expect(response.body.playback.lastShuffleRefillAt).toBe(0);
    expect(response.body.playback.lastShuffleSeed).toBe("");
    expect(response.body.playback.lastSmartQueueBase).toBe("");
    expect(response.body.queue).toEqual([expect.objectContaining({ title: "Manual Next", requestedBy: "guest" })]);
  });

  it("keeps background smart-queue auto-advance off manual rows", () => {
    const manual = { title: "Manual Keeper", requestedBy: "guest", uri: "spotify:track:manual" };
    const generated = { title: "Generated Pick", requestedBy: "smart shuffle", uri: "spotify:track:generated" };

    expect(nextQueueItemForPlayback([manual, generated])).toBe(manual);
    expect(nextQueueItemForPlayback([manual, generated], { generatedOnly: true })).toBe(generated);
    expect(nextQueueItemForPlayback([manual], { generatedOnly: true })).toBeNull();
  });

  it("skips background generated top-off when LMS shuffle disable fails", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = {
      ...appState.playback,
      shuffle: false,
      smartQueue: true,
      smartShuffleSource: "spotify",
      lastShuffleRefillAt: 12345,
      lastShuffleSeed: "stable seed",
      history: []
    };
    addQueueItem({ title: "Manual Keeper", artist: "Tester", requestedBy: "guest", path: "/music/manual.mp3" });
    const searched: string[] = [];
    await maintainVisiblePlaybackQueueForTests(
      {
        ...mockLms,
        async control(_playerId: string, action: string) {
          if (action === "shuffle") throw new Error("LMS refused shuffle");
          return "ok";
        },
        async spotifySearch(_playerId: string, term: string) {
          searched.push(term);
          return [{ id: "spotify:fresh", title: "Fresh Generated", artist: "Tester", source: "Spotify", uri: "spotify:track:fresh", kind: "track" }];
        }
      },
      { id: "player-1", mode: "play" },
      { title: "Current", artist: "Tester", duration: 100, elapsed: 20, uri: "spotify:track:current" }
    );

    expect(searched).toHaveLength(0);
    expect(appState.playback).toMatchObject({ smartQueue: true, lastShuffleRefillAt: 12345, lastShuffleSeed: "stable seed" });
    expect(appState.queue.map((item: { title: string }) => item.title)).toEqual(["Manual Keeper"]);
  });

  it("auto-advances normal shuffle within the visible queue without generated refill", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = {
      ...appState.playback,
      shuffle: true,
      smartQueue: false,
      smartShuffleSource: "spotify",
      lastShuffleRefillAt: 0,
      lastShuffleSeed: "",
      history: []
    };
    addQueueItem({ title: "Playlist Next", artist: "Tester", requestedBy: "guest", uri: "spotify:track:playlist-next", kind: "track" });
    const played: string[] = [];
    const searched: string[] = [];

    await maintainVisiblePlaybackQueueForTests(
      {
        ...mockLms,
        async control() {
          return "ok";
        },
        async playTrack(_playerId: string, track: { title?: string }) {
          played.push(String(track.title || ""));
          return "ok";
        },
        async spotifySearch(_playerId: string, term: string) {
          searched.push(term);
          return [{ title: "Unrelated Generated", artist: "Spotify", uri: "spotify:track:random", kind: "track" }];
        }
      },
      { id: "player-1", mode: "play" },
      { title: "Current", artist: "Tester", duration: 100, elapsed: 99, uri: "spotify:track:current" }
    );

    expect(played).toEqual(["Playlist Next"]);
    expect(searched).toEqual([]);
    expect(appState.queue).toEqual([]);
  });

  it("plays an existing generated queue row before slow shuffle top-off", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.nowPlaying = { id: "current", title: "Current", artist: "Tester", album: "", source: "Spotify", duration: 100, elapsed: 5, canSeek: true, art: null, uri: "spotify:track:current" };
    appState.playback = {
      ...appState.playback,
      shuffle: true,
      smartQueue: false,
      smartShuffleSource: "spotify",
      lastShuffleRefillAt: 0,
      lastShuffleSeed: "Tester",
      history: []
    };
    addQueueItem({ title: "Visible Generated", artist: "Tester", requestedBy: "shuffle", uri: "spotify:track:visible-generated", kind: "track" });
    const played: string[] = [];
    const lms = {
      ...mockLms,
      async control() {
        return "ok";
      },
      async playTrack(_playerId: string, track: { title?: string }) {
        played.push(String(track.title || ""));
        return "ok";
      },
      async spotifySearch() {
        return new Promise(() => {});
      }
    };

    const started = Date.now();
    const response = await request(createApp({ lms })).post("/api/player/next").expect(200);

    expect(Date.now() - started).toBeLessThan(800);
    expect(response.body.action).toBe("visible-queue-next");
    expect(response.body.nowPlaying.title).toBe("Visible Generated");
    expect(played).toEqual(["Visible Generated"]);
  });

  it("refills normal shuffle instead of falling through to LMS next when the visible queue is empty", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "hot-player", connected: true, online: true, mode: "play" };
    appState.playback = {
      ...appState.playback,
      shuffle: true,
      smartQueue: false,
      smartShuffleSource: "spotify",
      lastShuffleRefillAt: 0,
      lastShuffleSeed: "",
      history: []
    };
    const controls: string[] = [];
    const played: Array<{ title?: string; uri?: string }> = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string) {
        controls.push(action);
        return "ok";
      },
      async spotifySearch(_playerId: string, term: string) {
        return [{ title: "Unrelated Generated", artist: "Spotify", uri: "spotify:track:random", kind: "track" }];
      },
      async playTrack(_playerId: string, track: { title?: string; uri?: string }) {
        played.push(track);
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/next").expect(200);

    expect(response.body.action).toBe("visible-queue-next");
    expect(controls).toContain("shuffle");
    expect(controls).not.toContain("next");
    expect(played).toEqual([expect.objectContaining({ title: "Unrelated Generated" })]);
    expect(appState.queue).toEqual([]);
  });

  it("plays the next smart shuffle item from the visible queue", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartShuffleSource: "mixed", history: [] };
    const played: Array<{ action: string; track: { uri?: string; title?: string } }> = [];
    const lms = {
      ...mockLms,
      async spotifySearch() {
        return [{ id: "spotify:visible-next", title: "Visible Next", artist: "Tester", source: "Spotify", uri: "spotify:track:visible-next" }];
      },
      async playTrack(_playerId: string, track: { uri?: string; title?: string }, action: string) {
        played.push({ action, track });
        return "ok";
      }
    };
    const app = createApp({ lms });

    await request(app).post("/api/player/smart-shuffle").send({ source: "spotify", count: 1 }).expect(200);
    const next = await request(app).post("/api/player/next").expect(200);

    expect(next.body.action).toBe("visible-queue-next");
    expect(played).toEqual([{ action: "play-now", track: expect.objectContaining({ uri: "spotify:track:visible-next" }) }]);
  });

  it("only uses playable Spotify tracks for smart shuffle", async () => {
    const spotifyOnlyLms = {
      ...mockLms,
      async spotifySearch() {
        return [
          { id: "spotify:artist:1", title: "Artist Result", artist: "Spotify", source: "Spotify artist", uri: "spotify:artist:1", kind: "artist" },
          { id: "spotify:album:1", title: "Album Result", artist: "Spotify", source: "Spotify album", uri: "spotify:album:1", kind: "album" },
          { id: "spotify:track:1", title: "Track Result", artist: "Spotify", source: "Spotify", uri: "spotify:track:1", kind: "track" }
        ];
      }
    };

    const response = await request(createApp({ lms: spotifyOnlyLms }))
      .post("/api/player/smart-shuffle")
      .send({ source: "spotify", count: 3 })
      .expect(200);

    expect(response.body.queued).toHaveLength(1);
    expect(response.body.queued[0].uri).toBe("spotify:track:1");
  });

  it("requires admin login for settings changes", async () => {
    const app = createApp({ lms: mockLms });
    await request(app).post("/api/admin/settings").send({ publicRequests: false }).expect(401);
    const login = await request(app).post("/api/admin/login").send({ password: "admin" }).expect(200);
    await request(app)
      .post("/api/admin/settings")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ publicRequests: false })
      .expect(200);
  });

  it("validates and sanitizes admin settings", async () => {
    const previousAdmin = { ...appState.admin };
    const app = createApp({ lms: mockLms });
    const login = await request(app).post("/api/admin/login").send({ password: "admin" }).expect(200);
    try {
      await request(app)
        .post("/api/admin/settings")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({ publicRequests: "false", maxQueuePerUser: "zero", scheduleEnabled: "yes", extra: true })
        .expect(400);
      await request(app)
        .post("/api/admin/settings")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({ maxQueuePerUser: "7" })
        .expect(400);

      appState.admin = { ...appState.admin, extra: { bad: true }, maxQueuePerUser: 99 } as typeof appState.admin & { extra: { bad: boolean } };

      const response = await request(app)
        .post("/api/admin/settings")
        .set("Authorization", `Bearer ${login.body.token}`)
        .send({ publicRequests: true, maxQueuePerUser: 25, moderation: "strict", scheduleEnabled: false })
        .expect(200);

      expect(response.body).toEqual({ publicRequests: true, maxQueuePerUser: 25, moderation: "strict", scheduleEnabled: false });
      expect(response.body.extra).toBeUndefined();
      expect(appState.admin).toEqual(response.body);
    } finally {
      appState.admin = previousAdmin;
    }
  });
});
