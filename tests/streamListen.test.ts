import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The archive client is mocked at the module boundary, so these tests are about
// WHAT the poll path reports and WHEN; the HTTP shape itself is covered by
// archiveStream.test.ts. streamIngestConfigured is forced true because the real
// one reads its key once at module load (no key in a test environment).
vi.mock("../server/archiveStream.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, streamIngestConfigured: () => true, reportStreamListen: vi.fn(async () => ({ ok: true })) };
});

import { refreshLmsForTests, resetRefreshStateForTests } from "../server/app.js";
import { appState } from "../server/state.js";
import { createListenerTasteStore } from "../server/listenerTaste.js";
import { reportStreamListen } from "../server/archiveStream.js";

const TRACK_URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
const mockReport = () => reportStreamListen as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };

function spotifyLms(elapsed: { value: number }) {
  return {
    async status() {
      return { id: "player-1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 40, detail: "test player connected" };
    },
    async nowPlaying() {
      return {
        id: TRACK_URI,
        title: "Streamed Song",
        artist: "Tester",
        album: "",
        source: "Spotify",
        uri: TRACK_URI,
        duration: 100,
        elapsed: elapsed.value,
        canSeek: true,
        art: null
      };
    },
    async control() { return "ok"; },
    async spotifySearch() { return []; },
    async spotifyLibrary() { return []; },
    async spotifyStatus() { return { configured: true, reachable: true, detail: "Spotty detected" }; },
    async musicInfoStatus() { return { configured: false, reachable: true, detail: "Plugin not enabled" }; }
  };
}

async function tasteStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-stream-"));
  return createListenerTasteStore(path.join(root, "taste.json"));
}

describe("poll-driven stream-listen reporting", () => {
  beforeEach(() => {
    resetRefreshStateForTests();
    appState.queue.splice(0, appState.queue.length);
    mockReport().mockClear();
  });

  it("reports a Spotify track once, only after it has been heard through", async () => {
    const taste = await tasteStore();
    const elapsed = { value: 20 };
    const lms = spotifyLms(elapsed);
    const poll = () => refreshLmsForTests(lms, { force: true, skipTrackInfo: true, taste });

    await poll();
    expect(mockReport().mock.calls).toHaveLength(0);

    elapsed.value = 50;
    await poll();
    expect(mockReport().mock.calls).toHaveLength(0);

    elapsed.value = 99;
    await poll();
    expect(mockReport().mock.calls).toHaveLength(1);
    expect(mockReport().mock.calls[0][0]).toMatchObject({ uri: TRACK_URI });

    await poll();
    expect(mockReport().mock.calls).toHaveLength(1);
  });

  it("does not report a track that is only part-heard", async () => {
    const taste = await tasteStore();
    const elapsed = { value: 10 };
    const lms = spotifyLms(elapsed);

    await refreshLmsForTests(lms, { force: true, skipTrackInfo: true, taste });
    elapsed.value = 30;
    await refreshLmsForTests(lms, { force: true, skipTrackInfo: true, taste });

    expect(mockReport().mock.calls).toHaveLength(0);
  });
});
