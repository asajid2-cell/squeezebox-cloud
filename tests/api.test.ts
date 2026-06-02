import request from "supertest";
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { addQueueItem, appState, config } from "../server/state.js";

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
    return [{ id: "spotify:1", title: "Headlines", artist: "Drake", source: "Spotify", uri: "spotify:track:abc123" }];
  },
  async spotifyLibrary() {
    return [{ id: "spotify:playlist:1", title: "Test Playlist", artist: "Spotify", source: "Spotify playlist", uri: "spotify:playlist:1", kind: "playlist" }];
  },
  async spotifyChildren() {
    return [{ id: "spotify:track:child", title: "Playlist Track", artist: "Spotify", source: "Spotify", uri: "spotify:track:child", kind: "track" }];
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
  it("returns speaker and now playing state", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/state").expect(200);
    expect(response.body.player.connected).toBe(true);
    expect(response.body.nowPlaying.title).toBe("Test Song");
  });

  it("adds queue items and rejects duplicates", async () => {
    const app = createApp({ lms: mockLms });
    const payload = { title: "Unit Test Track", artist: "Tester", requestedBy: "vitest" };
    const created = await request(app).post("/api/queue").send(payload).expect(201);
    expect(created.body.title).toBe(payload.title);
    await request(app).post("/api/queue").send(payload).expect(409);
  });

  it("edits reorders and removes queue items", async () => {
    const app = createApp({ lms: mockLms });
    const first = await request(app).post("/api/queue").send({ title: "First", artist: "Tester" }).expect(201);
    const second = await request(app).post("/api/queue").send({ title: "Second", artist: "Tester" }).expect(201);

    const edited = await request(app).patch(`/api/queue/${first.body.id}`).send({ title: "Edited First" }).expect(200);
    expect(edited.body.item.title).toBe("Edited First");

    const moved = await request(app).post(`/api/queue/${second.body.id}/move`).send({ direction: "up" }).expect(200);
    const movedIds = moved.body.queue.map((item: { id: string }) => item.id);
    expect(movedIds.indexOf(second.body.id)).toBeLessThan(movedIds.indexOf(first.body.id));

    const removed = await request(app).delete(`/api/queue/${second.body.id}`).expect(200);
    expect(removed.body.queue.some((item: { id: string }) => item.id === second.body.id)).toBe(false);
  });

  it("generates unique queue ids for rapid inserts", () => {
    appState.queue.splice(0, appState.queue.length);
    const first = addQueueItem({ title: "Rapid One", artist: "Tester" });
    const second = addQueueItem({ title: "Rapid Two", artist: "Tester" });
    expect(first.id).not.toBe(second.id);
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

  it("seeks the current player position", async () => {
    const response = await request(createApp({ lms: mockLms })).post("/api/player/seek").send({ seconds: 42 }).expect(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.seconds).toBe(42);
    expect(response.body.nowPlaying.canSeek).toBe(true);
  });

  it("uses the LMS previous command when previous is pressed", async () => {
    const controls: Array<{ action: string; value?: number }> = [];
    const lms = {
      ...mockLms,
      async control(_playerId: string, action: string, value?: number) {
        controls.push({ action, value });
        return "ok";
      }
    };

    const response = await request(createApp({ lms })).post("/api/player/previous").expect(200);

    expect(response.body.action).toBe("previous");
    expect(controls).toContainEqual({ action: "previous", value: undefined });
    expect(controls.some((item) => item.action === "seek")).toBe(false);
  });

  it("uses the hot player id for previous without waiting on a fresh status call", async () => {
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

    expect(response.body.action).toBe("previous");
    expect(controls).toContainEqual({ playerId: "hot-player", action: "previous" });
  });

  it("proxies LMS artwork", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/artwork/test-cover").expect(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.text || response.body.toString()).toContain("fake-jpeg");
  });

  it("returns speaker connection setup guidance", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/speaker/connect-guide").expect(200);
    expect(response.body.serverHost).toBeTruthy();
    expect(response.body.steps).toContain("Open the Squeezebox Server option.");
    expect(response.body.player.connected).toBe(true);
  });

  it("sends local tracks to LMS playback controls", async () => {
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
    expect(played).toContainEqual({ action: "play-next", track: expect.objectContaining({ title: "Manual Next" }) });
  });

  it("rejects Spotify containers as direct playback targets", async () => {
    const app = createApp({ lms: mockLms });
    const response = await request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track: { title: "Drake", uri: "spotify:artist:3TVXtAsR1Inumwj472S9r4", kind: "artist", source: "Spotify artist" } })
      .expect(400);

    expect(response.body.error).toBe("Playable local path, LMS track id, or Spotify URI is required");
  });

  it("filters Spotify containers out of batch playback", async () => {
    appState.queue.splice(0, appState.queue.length);
    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/tracks")
      .send({
        action: "add-queue",
        tracks: [
          { title: "Artist Container", uri: "spotify:artist:container", kind: "artist", source: "Spotify artist" },
          { title: "Playable Track", uri: "spotify:track:playable", kind: "track", source: "Spotify" }
        ]
      })
      .expect(200);

    expect(response.body.queued).toHaveLength(1);
    expect(response.body.queued[0].title).toBe("Playable Track");
  });

  it("rejects duplicate direct playback queue requests by playable key", async () => {
    appState.queue.splice(0, appState.queue.length);
    const app = createApp({ lms: mockLms });
    const track = { title: "Duplicate Spotify Track", uri: "spotify:track:duplicate", kind: "track", source: "Spotify" };

    await request(app).post("/api/player/track").send({ action: "add-queue", track }).expect(200);
    const duplicate = await request(app).post("/api/player/track").send({ action: "add-queue", track }).expect(409);

    expect(duplicate.body.error).toBe("That song is already in the queue");
    expect(appState.queue.filter((item) => item.uri === track.uri)).toHaveLength(1);
  });

  it("deduplicates batch playback by playable key", async () => {
    appState.queue.splice(0, appState.queue.length);
    addQueueItem({ title: "Existing", artist: "Tester", uri: "spotify:track:existing", kind: "track" });

    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/tracks")
      .send({
        action: "add-queue",
        tracks: [
          { title: "Existing Again", uri: "spotify:track:existing", kind: "track", source: "Spotify" },
          { title: "New Track", uri: "spotify:track:new", kind: "track", source: "Spotify" },
          { title: "New Track Duplicate", uri: "spotify:track:new", kind: "track", source: "Spotify" }
        ]
      })
      .expect(200);

    expect(response.body.queued).toHaveLength(1);
    expect(response.body.queued[0].title).toBe("New Track");
    expect(appState.queue.filter((item) => item.uri === "spotify:track:new")).toHaveLength(1);
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
    expect(played).toContainEqual({ action: "add-queue", track: expect.objectContaining({ title: "Visible Queue Song" }) });
    expect(played).toContainEqual({ action: "play-now", track: expect.objectContaining({ title: "Visible Queue Song" }) });
    expect(appState.queue.some((item) => item.title === "Visible Queue Song")).toBe(false);
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
          { title: "Playlist One", artist: "Tester", uri: "spotify:track:one", source: "Spotify", kind: "track" },
          { title: "Playlist Two", artist: "Tester", uri: "spotify:track:two", source: "Spotify", kind: "track" },
          { title: "Playlist Three", artist: "Tester", uri: "spotify:track:three", source: "Spotify", kind: "track" }
        ]
      })
      .expect(200);

    expect(response.body.queue.map((item: { title: string }) => item.title)).toEqual(["Playlist One", "Playlist Two", "Playlist Three"]);
    expect(played).toHaveLength(0);
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

  it("resumes playback immediately after seeking when already playing", async () => {
    const controls: Array<{ action: string; value?: number }> = [];
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

  it("returns Spotify search results from Spotty", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/spotify/search?q=drake").expect(200);
    expect(response.body.results[0].uri).toBe("spotify:track:abc123");
  });

  it("returns Spotify library sections from Spotty", async () => {
    const response = await request(createApp({ lms: mockLms })).get("/api/spotify/library?type=playlists").expect(200);
    expect(response.body.results[0].kind).toBe("playlist");
  });

  it("opens Spotify playlist children instead of queueing playlist containers", async () => {
    const response = await request(createApp({ lms: mockLms }))
      .get("/api/spotify/children?uri=spotify%3Aplaylist%3A1&kind=playlist")
      .expect(200);
    expect(response.body.results[0]).toMatchObject({ title: "Playlist Track", kind: "track" });
  });

  it("accepts only validated audio uploads", async () => {
    const previousUploadDir = config.uploadDir;
    const previousMusicDir = config.musicSourceDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-upload-"));
    config.musicSourceDir = root;
    config.uploadDir = path.join(root, "uploads");
    const app = createApp({ lms: mockLms });

    await request(app)
      .post("/api/library/upload?filename=bad.exe")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("MZ fake executable"))
      .expect(400);

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

    const encodedPath = Buffer.from(uploaded.body.track.path).toString("base64url");
    const stream = await request(app).get(`/api/stream/${encodedPath}`).expect(200);
    expect(stream.headers["content-type"]).toContain("audio/mpeg");
    expect(stream.body.length).toBeGreaterThan(0);
    config.uploadDir = previousUploadDir;
    config.musicSourceDir = previousMusicDir;
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
            { id: "spotify:current", title: "Headlines", artist: "Drake", source: "Spotify", uri: "spotify:track:abc123", kind: "track" },
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

  it("exposes recent queue and playback debug events", async () => {
    appState.queue.splice(0, appState.queue.length);
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: false, smartShuffleSource: "spotify", history: [] };
    const app = createApp({ lms: mockLms });

    await request(app)
      .post("/api/player/playback")
      .send({ shuffle: true, smartQueue: false, smartShuffleSource: "spotify" })
      .expect(200);
    const logs = await request(app).get("/api/debug/logs?limit=10").expect(200);

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
    expect(played).toContainEqual({ action: "play-next", track: expect.objectContaining({ title: "Manual Heavy" }) });
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
      .send({ action: "play-now", track: { title: "Manual Play", artist: "New Artist", uri: "spotify:track:manual-play", source: "Spotify" } })
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
    expect(response.body.playback.smartQueue).toBe(true);
    expect(response.body.playback.smartShuffleSource).toBe("spotify");
    expect(played).toHaveLength(0);
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
    appState.playback = { ...appState.playback, shuffle: false, smartQueue: true, smartShuffleSource: "mixed", history: [] };
    addQueueItem({ title: "Manual Next", artist: "Tester", requestedBy: "guest", path: "/music/manual.mp3" });
    addQueueItem({ title: "Generated Next", artist: "Tester", requestedBy: "smart shuffle", uri: "spotify:track:generated" });

    const response = await request(createApp({ lms: mockLms }))
      .post("/api/player/playback")
      .send({ smartQueue: false, shuffle: false })
      .expect(200);

    expect(response.body.playback.smartQueue).toBe(false);
    expect(response.body.queue).toEqual([expect.objectContaining({ title: "Manual Next", requestedBy: "guest" })]);
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
});
