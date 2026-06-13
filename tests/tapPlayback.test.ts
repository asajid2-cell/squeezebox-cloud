import { describe, it, expect } from "vitest";
import { playTapTarget } from "../server/tapPlayback.js";

// A fake LMS client that records the calls the Tap play engine makes, so we can
// assert the engine dispatches each PlaySpec to the right native primitive and
// NEVER consults the guest "known Spotify track" gate (trusted-by-construction).
function fakeLms() {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    loadAlbum: async (...args: unknown[]) => {
      calls.push({ method: "loadAlbum", args });
      return { ok: true };
    },
    playTrack: async (...args: unknown[]) => {
      calls.push({ method: "playTrack", args });
      return { ok: true };
    }
  };
}

describe("Tap play engine (trusted replay)", () => {
  it("album-from-top (Spotify) loads the whole album", async () => {
    const lms = fakeLms();
    await playTapTarget(lms, "player-1", {
      kind: "album-from-top",
      source: "spotify",
      albumUri: "spotify:album:xyz789"
    });
    expect(lms.calls).toEqual([
      { method: "loadAlbum", args: ["player-1", { source: "spotify", albumUri: "spotify:album:xyz789", albumId: undefined, startIndex: undefined }] }
    ]);
  });

  it("album-from-top (local) loads the whole album by album_id", async () => {
    const lms = fakeLms();
    await playTapTarget(lms, "player-1", { kind: "album-from-top", source: "local", albumId: "42" });
    expect(lms.calls[0].method).toBe("loadAlbum");
    expect(lms.calls[0].args[1]).toMatchObject({ source: "local", albumId: "42" });
  });

  it("album-from-track passes the startIndex through to loadAlbum", async () => {
    const lms = fakeLms();
    await playTapTarget(lms, "player-1", {
      kind: "album-from-track",
      source: "local",
      albumId: "42",
      startIndex: 3
    });
    expect(lms.calls[0].method).toBe("loadAlbum");
    expect(lms.calls[0].args[1]).toMatchObject({ source: "local", albumId: "42", startIndex: 3 });
  });

  it("track plays a single track play-now — even an UNKNOWN Spotify track (no guest gate)", async () => {
    const lms = fakeLms();
    const unknownSpotifyTrack = { uri: "spotify:track:0123456789abcdefghijAB", title: "Some Song", source: "Spotify" };
    await playTapTarget(lms, "player-1", { kind: "track", track: unknownSpotifyTrack });
    expect(lms.calls).toEqual([
      { method: "playTrack", args: ["player-1", unknownSpotifyTrack, "play-now"] }
    ]);
  });

  it("rejects an unknown PlaySpec kind instead of silently doing nothing", async () => {
    const lms = fakeLms();
    await expect(playTapTarget(lms, "player-1", { kind: "bogus" } as never)).rejects.toThrow(/kind/i);
    expect(lms.calls).toEqual([]);
  });

  it("throws when there is no active player", async () => {
    const lms = fakeLms();
    await expect(
      playTapTarget(lms, "", { kind: "album-from-top", source: "local", albumId: "1" })
    ).rejects.toThrow(/player/i);
  });

  it("queue policy adds a track to the queue instead of replacing playback", async () => {
    const lms = fakeLms();
    await playTapTarget(lms, "player-1", { kind: "track", track: { uri: "spotify:track:0123456789abcdefghijAB" } }, { playMode: "queue" });
    expect(lms.calls[0].method).toBe("playTrack");
    expect(lms.calls[0].args[2]).toBe("add-queue");
  });

  it("replace policy (default) plays a track now", async () => {
    const lms = fakeLms();
    await playTapTarget(lms, "player-1", { kind: "track", track: { uri: "spotify:track:0123456789abcdefghijAB" } }, { playMode: "replace" });
    expect(lms.calls[0].args[2]).toBe("play-now");
  });
});
