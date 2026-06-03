import { afterEach, describe, expect, it, vi } from "vitest";
import { playTrack, playerAction, postQueue, savePlayback, seekPlayer, setPlayerVolume } from "../src/lib/api";

function mockJsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("API client mutating requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("throws backend errors for failed volume and seek controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(502, { error: "LMS refused control" })));

    await expect(setPlayerVolume(30)).rejects.toThrow("LMS refused control");
    await expect(seekPlayer(42)).rejects.toThrow("LMS refused control");
  });
});
