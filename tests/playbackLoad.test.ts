import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, resetRefreshStateForTests } from "../server/app.js";
import { appState } from "../server/state.js";

// This lives in its own file on purpose: the play-now path mutates the shared
// module state (player, playback, the mutation-lock chain), so keeping it out of
// api.test.ts keeps that file's ordering/timing untouched.

const mockLms = {
  async status() {
    return { id: "player-1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 44, detail: "test player connected" };
  },
  async nowPlaying() {
    return { id: "track-1", title: "Test Song", artist: "Test Artist", album: "Test Album", duration: 100, elapsed: 20, canSeek: true, art: null, source: "LMS" };
  },
  async control() {
    return "ok";
  },
  async playTrack() {
    return "ok";
  },
  async spotifySearch() {
    return [];
  },
  async spotifyLibrary() {
    return [];
  },
  async spotifyChildren() {
    return [];
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

describe("playback fail-fast under load", () => {
  it("kills a queued play-now fast with an explicit load error and logs it", async () => {
    resetRefreshStateForTests();
    appState.queue.splice(0, appState.queue.length);
    appState.player = { ...appState.player, id: "player-1", connected: true, online: true, mode: "stop" };

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let playTrackStarted = false;
    const lms = {
      ...mockLms,
      async playTrack() {
        playTrackStarted = true;
        await firstGate; // hold the mutation lock while the first play-now is in flight
        return "ok";
      }
    };
    const app = createApp({ lms });
    const login = await request(app).post("/api/admin/login").send({ password: "admin" }).expect(200);
    const track = { title: "Held Track", artist: "Tester", path: "/music/test/held.mp3" };

    const firstRun = request(app)
      .post("/api/player/track")
      .send({ action: "play-now", track })
      .then((response) => response);

    try {
      for (let i = 0; i < 400 && !playTrackStarted; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(playTrackStarted).toBe(true);

      const started = Date.now();
      const second = await request(app)
        .post("/api/player/track")
        .send({ action: "play-now", track: { ...track, title: "Blocked Track" } });
      const elapsed = Date.now() - started;

      // A queued play-now is killed fast with an explicit load error: never an
      // optimistic 200, and never the 40-250s hang the box used to show.
      expect(second.status).toBe(503);
      expect(second.body.code).toBe("server_load");
      expect(second.body.error).toMatch(/server load/i);
      expect(elapsed).toBeLessThan(6000);

      const logs = await request(app)
        .get("/api/debug/logs?limit=20")
        .set("Authorization", `Bearer ${login.body.token}`)
        .expect(200);
      expect(logs.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "track.load-failure", data: expect.objectContaining({ stage: "lock" }) })
        ])
      );
    } finally {
      releaseFirst();
    }

    const firstResponse = await firstRun;
    expect(firstResponse.status).toBe(200);
  }, 20000);
});
