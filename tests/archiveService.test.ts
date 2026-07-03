import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __archiveServiceTestHooks, ensureStreamFile, scanWatchedPlaylistsWebApi } from "../server/archiveService.js";

const spotifyEnvKeys = ["SPOTIFY_REFRESH_TOKEN", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_WEB_TIMEOUT_MS", "SPOTIFY_WEB_MAX_RETRIES"] as const;
const originalSpotifyEnv = Object.fromEntries(spotifyEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of spotifyEnvKeys) {
    const original = originalSpotifyEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  __archiveServiceTestHooks.resetSpotifyWebForTests();
});

describe("archive stream cache", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    __archiveServiceTestHooks.resetStreamCacheForTests();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  async function makeStreamCache() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-stream-cache-"));
    tempDirs.push(dir);
    __archiveServiceTestHooks.setStreamCacheDir(dir);
    return dir;
  }

  it("deduplicates bare ids and Spotify URIs to the same generated file", async () => {
    const dir = await makeStreamCache();
    let releaseFetch: (() => void) | null = null;
    let fetchStarted: (() => void) | null = null;
    let fetches = 0;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    __archiveServiceTestHooks.setFetchAndEncode(async (_uri, outPath) => {
      fetches += 1;
      fetchStarted?.();
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      await fs.writeFile(outPath, Buffer.from("mp3"));
      return outPath;
    });

    const first = ensureStreamFile("abc123");
    const second = ensureStreamFile("spotify:track:abc123");
    await started;
    releaseFetch?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      path.join(dir, "abc123.mp3"),
      path.join(dir, "abc123.mp3")
    ]);
    expect(fetches).toBe(1);
  });

  it("does not prune the file generated for the request that triggered pruning", async () => {
    const dir = await makeStreamCache();
    __archiveServiceTestHooks.setStreamCacheMax(1);
    __archiveServiceTestHooks.setFetchAndEncode(async (_uri, outPath) => {
      await fs.writeFile(outPath, Buffer.from("mp3"));
      return outPath;
    });

    const existing = path.join(dir, "existing.mp3");
    await fs.writeFile(existing, Buffer.from("cached"));
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(existing, future, future);

    const generated = await ensureStreamFile("generated");

    await expect(fs.stat(generated)).resolves.toMatchObject({ size: 3 });
    await expect(fs.stat(existing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

import { groupArchiveFiles } from "../server/archiveService.js";

describe("archive grouping (watched playlists)", () => {
  const snapshot = [
    { name: "Archive", keys: ["Drake - Something To Prove", "Gunna - Sold Out Dates"] },
    { name: "archive-rap", keys: ["21 Savage - Kamaal"] }
  ];

  it("buckets each file under the first watched playlist that contains it, else Manual", () => {
    const files = [
      { filename: "Drake - Something To Prove.flac", artist: "Drake", title: "Something To Prove" },
      { filename: "21 Savage - Kamaal.flac", artist: "21 Savage", title: "Kamaal" },
      { filename: "Some Artist - A Manual Song.flac", artist: "Some Artist", title: "A Manual Song" }
    ];
    const groups = groupArchiveFiles(files, snapshot);
    const byName = Object.fromEntries(groups.map((g) => [g.name, g.files.map((f: { title: string }) => f.title)]));
    expect(byName["Archive"]).toEqual(["Something To Prove"]);
    expect(byName["archive-rap"]).toEqual(["Kamaal"]);
    expect(byName["Manual"]).toEqual(["A Manual Song"]);
  });

  it("always includes Manual first and marks it", () => {
    const groups = groupArchiveFiles([], snapshot);
    expect(groups[0].name).toBe("Manual");
    expect(groups[0].manual).toBe(true);
    expect(groups.map((g) => g.name)).toEqual(["Manual", "Archive", "archive-rap"]);
  });

  it("puts everything in Manual when nothing is watched", () => {
    const files = [{ filename: "A - B.flac", artist: "A", title: "B" }];
    const groups = groupArchiveFiles(files, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Manual");
    expect(groups[0].count).toBe(1);
  });
});

describe("Spotify Web archive scanning", () => {
  it("times out hung Web API requests so the caller can fall back", async () => {
    process.env.SPOTIFY_REFRESH_TOKEN = "refresh-token";
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    __archiveServiceTestHooks.setSpotifyWebTimeoutMs(5);

    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(scanWatchedPlaylistsWebApi({} as any)).rejects.toThrow(/spotify web fetch timeout after 5ms/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry Spotify 429s forever", async () => {
    process.env.SPOTIFY_REFRESH_TOKEN = "refresh-token";
    process.env.SPOTIFY_CLIENT_ID = "client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "client-secret";
    __archiveServiceTestHooks.setSpotifyWebMaxRetries(0);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "access-token", expires_in: 3600 })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => "30" },
        json: async () => ({ error: "rate limited" }),
        text: async () => "Too many requests"
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(scanWatchedPlaylistsWebApi({} as any)).rejects.toThrow(
      "spotify GET 429 https://api.spotify.com/v1/me/playlists?limit=50"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(scanWatchedPlaylistsWebApi({} as any)).rejects.toThrow(/spotify web backoff active/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { emailFromTitle } from "../server/archiveService.js";

describe("EASW email-convention parsing", () => {
  it("returns the address only for an EASW<email> title", () => {
    expect(emailFromTitle("EASWme@email.com")).toBe("me@email.com");
    expect(emailFromTitle("EASW dj.x+tag@sub.domain.co")).toBe("dj.x+tag@sub.domain.co");
    expect(emailFromTitle("easwheltershop@harmonizerlabs.cc")).toBe("heltershop@harmonizerlabs.cc");
  });
  it("does NOT email plain archive* playlists or non-EASW titles", () => {
    expect(emailFromTitle("Archive me@email.com")).toBe("");
    expect(emailFromTitle("Archive")).toBe("");
    expect(emailFromTitle("EASW not-an-email")).toBe("");
    expect(emailFromTitle("")).toBe("");
  });
});
