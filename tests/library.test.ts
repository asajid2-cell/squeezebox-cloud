import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearLibraryCaches, fileToTrack, searchLibrary } from "../server/library.js";

describe("library scanner helpers", () => {
  it("turns local audio paths into searchable tracks", () => {
    const track = fileToTrack("C:/Users/Ahmed/Downloads/M83 - Midnight City.mp3");
    expect(track.title).toBe("Midnight City");
    expect(track.artist).toBe("M83");
    expect(track.source).toBe("Local library");
    expect(track.id).toContain("local:");
  });

  it("keeps leading numeric local titles and bracket versions intact", () => {
    const numbered = fileToTrack("/music/collections/Juice/27 Club.mp3");
    const versioned = fileToTrack("/music/collections/Juice/734 [v1].mp3");

    expect(numbered.title).toBe("27 Club");
    expect(versioned.title).toBe("734 [v1]");
  });

  it("prefers embedded tags for uploaded track display metadata", () => {
    const track = fileToTrack("/music/uploads/Sleep Paralysis-Jackson Ivy.mp3", {
      title: "Sleep Paralysis",
      artist: "Jackson Ivy",
      album: "Haha - Single"
    });

    expect(track).toMatchObject({
      title: "Sleep Paralysis",
      artist: "Jackson Ivy",
      album: "Haha - Single",
      source: "Uploaded"
    });
  });

  it("excludes nested uploads from local-only scans", async () => {
    clearLibraryCaches();
    const previousMusicDir = process.env.MUSIC_SOURCE_DIR;
    const previousUploadDir = process.env.UPLOAD_DIR;
    const { config } = await import("../server/state.js");
    const oldMusicDir = config.musicSourceDir;
    const oldUploadDir = config.uploadDir;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-nested-upload-"));
    const uploadRoot = path.join(root, "uploads");
    try {
      config.musicSourceDir = root;
      config.uploadDir = uploadRoot;
      await fs.mkdir(uploadRoot, { recursive: true });
      await fs.writeFile(path.join(root, "Local Artist - Local Song.mp3"), "ID3");
      await fs.writeFile(path.join(uploadRoot, "Upload Artist - Upload Song.mp3"), "ID3");

      const local = await searchLibrary("", undefined, 10, "local");
      const uploaded = await searchLibrary("", undefined, 10, "uploaded");
      const all = await searchLibrary("", undefined, 10, "all");

      expect(local.map((track) => track.title)).toEqual(["Local Song"]);
      expect(uploaded.map((track) => track.title)).toEqual(["Upload Song"]);
      expect(all.map((track) => track.title).sort()).toEqual(["Local Song", "Upload Song"]);
    } finally {
      config.musicSourceDir = oldMusicDir;
      config.uploadDir = oldUploadDir;
      if (previousMusicDir === undefined) delete process.env.MUSIC_SOURCE_DIR;
      else process.env.MUSIC_SOURCE_DIR = previousMusicDir;
      if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
      else process.env.UPLOAD_DIR = previousUploadDir;
      clearLibraryCaches();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("caches search results until library caches are cleared", async () => {
    clearLibraryCaches();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-library-cache-"));
    try {
      await fs.writeFile(path.join(root, "Artist - First Song.mp3"), "fake");
      const first = await searchLibrary("song", root, 10, "local");
      await fs.writeFile(path.join(root, "Artist - Second Song.mp3"), "fake");
      const cached = await searchLibrary("song", root, 10, "local");
      clearLibraryCaches();
      const refreshed = await searchLibrary("song", root, 10, "local");

      expect(first.map((track) => track.title)).toEqual(["First Song"]);
      expect(cached.map((track) => track.title)).toEqual(["First Song"]);
      expect(refreshed.map((track) => track.title)).toEqual(["First Song", "Second Song"]);
    } finally {
      clearLibraryCaches();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors full typed-search limits above the compact default", async () => {
    clearLibraryCaches();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-squeeze-library-full-limit-"));
    try {
      await Promise.all(
        Array.from({ length: 650 }, (_, index) =>
          fs.writeFile(path.join(root, `Artist - Match ${String(index).padStart(3, "0")}.mp3`), "fake")
        )
      );

      const compact = await searchLibrary("match", root, 500, "local");
      const full = await searchLibrary("match", root, 2000, "local");

      expect(compact).toHaveLength(500);
      expect(full).toHaveLength(650);
    } finally {
      clearLibraryCaches();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
