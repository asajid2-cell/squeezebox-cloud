import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchState, playTrack, playTracks, playerAction, postQueue, resetApiClientStateForTests, savePlayback, searchSpotify, seekPlayer, setPlayerVolume } from "../src/lib/api";

function mockJsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("API client mutating requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiClientStateForTests();
  });

  it("deduplicates concurrent state fetches", async () => {
    let requests = 0;
    let release: (value?: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests += 1;
      await gate;
      return mockJsonResponse(200, { player: { mode: "stop" }, nowPlaying: { title: "No track playing" }, queue: [] });
    }));

    const first = fetchState();
    const second = fetchState();
    release();
    const [firstState, secondState] = await Promise.all([first, second]);

    expect(firstState).toBe(secondState);
    expect(requests).toBe(1);

    await fetchState();
    expect(requests).toBe(2);
  });

  it("throws backend errors for failed transport controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(502, { error: "LMS control failed" })));

    await expect(playerAction("pause")).rejects.toThrow("LMS control failed");
  });

  it("allows stop as a first-class transport action", async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { ok: true, mode: "stop" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(playerAction("stop")).resolves.toMatchObject({ ok: true, mode: "stop" });
    expect(fetchMock).toHaveBeenCalledWith("/api/player/stop", { method: "POST" });
  });

  it("throws backend errors for failed queue and playback mutations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(409, { error: "That song is already in the queue" })));

    await expect(postQueue({ title: "Duplicate", path: "/music/duplicate.mp3" })).rejects.toThrow("That song is already in the queue");
    await expect(playTrack("add-queue", { title: "Duplicate", path: "/music/duplicate.mp3" })).rejects.toThrow("That song is already in the queue");
    await expect(savePlayback({ repeat: "all" })).rejects.toThrow("That song is already in the queue");
  });

  it("returns partial batch queue acceptance details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(200, { ok: true, accepted: 3, rejected: 9, queued: [], queue: [] })));

    await expect(playTracks("add-queue", [{ title: "One", uri: "spotify:track:one" }])).resolves.toMatchObject({
      accepted: 3,
      rejected: 9
    });
  });

  it("skips Spotify search requests for blank queries", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchSpotify("   ")).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws backend errors for failed volume and seek controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(502, { error: "LMS refused control" })));

    await expect(setPlayerVolume(30)).rejects.toThrow("LMS refused control");
    await expect(seekPlayer(42)).rejects.toThrow("LMS refused control");
  });
});
