import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCollectionTracks, fetchCollections, fetchSpotifyChildren, fetchSpotifyLibrary, fetchState, playTrack, playTracks, playerAction, postQueue, rescanLibrary, resetApiClientStateForTests, savePlayback, searchLibrary, searchSpotify, seekPlayer, setPlayerVolume } from "../src/lib/api";

function mockJsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("API client mutating requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
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
    expect(fetchMock).toHaveBeenCalledWith("/api/player/stop", expect.objectContaining({ method: "POST" }));
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

  it("sends compact playback track payloads", async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await playTrack("add-queue", {
      id: "local:one",
      title: "One",
      artist: "Tester",
      album: "Album",
      source: "Local library",
      path: "/music/one.mp3",
      duration: 120,
      art: "api/artwork/large-cover",
      artwork: "https://example.test/cover.jpg",
      elapsed: 10,
      canSeek: true
    });
    await playTracks("add-queue", [
      {
        id: "local:two",
        title: "Two",
        artist: "Tester",
        source: "Local library",
        path: "/music/two.mp3",
        collection: "Collection",
        folder: "Folder",
        art: "api/artwork/another-large-cover",
        artwork: "https://example.test/another.jpg"
      }
    ]);

    const singleBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const batchBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(singleBody.track).toEqual({
      id: "local:one",
      title: "One",
      artist: "Tester",
      album: "Album",
      source: "Local library",
      path: "/music/one.mp3",
      duration: 120
    });
    expect(batchBody.tracks[0]).toEqual({
      id: "local:two",
      title: "Two",
      artist: "Tester",
      source: "Local library",
      path: "/music/two.mp3"
    });
  });

  it("skips Spotify search requests for blank queries", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchSpotify("   ")).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws backend errors for failed browse and search requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(502, { error: "Provider failed" })));

    await expect(searchLibrary("bad")).rejects.toThrow("Provider failed");
    await expect(searchSpotify("drake")).rejects.toThrow("Provider failed");
    await expect(fetchSpotifyLibrary("playlists")).rejects.toThrow("Provider failed");
    await expect(fetchSpotifyChildren({ title: "Mix", uri: "spotify:playlist:1", kind: "playlist" })).rejects.toThrow("Provider failed");
    await expect(fetchCollections()).rejects.toThrow("Provider failed");
    await expect(fetchCollectionTracks("Collection", "Folder")).rejects.toThrow("Provider failed");
  });

  it("sends offsets for paged playlist detail requests", async () => {
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchSpotifyChildren({ title: "Mix", uri: "spotify:playlist:1", kind: "playlist" }, 100, 200);
    await fetchCollectionTracks("Collection", "Folder", "all", 100, 300);

    expect(fetchMock.mock.calls[0][0]).toContain("limit=100");
    expect(fetchMock.mock.calls[0][0]).toContain("offset=200");
    expect(fetchMock.mock.calls[1][0]).toContain("limit=100");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=300");
  });

  it("throws backend errors for failed volume and seek controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(502, { error: "LMS refused control" })));

    await expect(setPlayerVolume(30)).rejects.toThrow("LMS refused control");
    await expect(seekPlayer(42)).rejects.toThrow("LMS refused control");
  });

  it("sends admin auth when rescanning the local library", async () => {
    window.localStorage.setItem("cloud-squeeze-admin-token", "test-token");
    const fetchMock = vi.fn(async () => mockJsonResponse(200, { ok: true, trackCount: 12 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rescanLibrary()).resolves.toMatchObject({ ok: true, trackCount: 12 });

    expect(fetchMock).toHaveBeenCalledWith("/api/library/rescan", {
      method: "POST",
      headers: { Authorization: "Bearer test-token" }
    });
  });
});
