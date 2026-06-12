import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __archiveServiceTestHooks, ensureStreamFile } from "../server/archiveService.js";

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
