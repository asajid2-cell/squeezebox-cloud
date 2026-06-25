import { describe, it, expect } from "vitest";
import { buildPlaySpec, validatePlaySpec } from "../server/tapPlaySpec.js";

describe("Tap PlaySpec construction", () => {
  it("builds a single-track spec from a track selection", () => {
    const track = { uri: "spotify:track:0123456789abcdefghijAB", title: "Song", artist: "Artist", source: "Spotify" };
    const spec = buildPlaySpec({ intent: "track", track });
    expect(spec).toEqual({ kind: "track", track });
  });

  it("builds album-from-top from a Spotify album URI", () => {
    const spec = buildPlaySpec({ intent: "album-from-top", source: "spotify", albumUri: "spotify:album:xyz789" });
    expect(spec).toEqual({ kind: "album-from-top", source: "spotify", albumUri: "spotify:album:xyz789" });
  });

  it("builds album-from-top from a local album_id", () => {
    const spec = buildPlaySpec({ intent: "album-from-top", source: "local", albumId: "42" });
    expect(spec).toEqual({ kind: "album-from-top", source: "local", albumId: "42" });
  });

  it("builds album-from-track with the in-album start index (the representative-song case)", () => {
    const spec = buildPlaySpec({ intent: "album-from-track", source: "spotify", albumUri: "spotify:album:xyz789", startIndex: 4 });
    expect(spec).toEqual({ kind: "album-from-track", source: "spotify", albumUri: "spotify:album:xyz789", startIndex: 4 });
  });

  it("rejects album-from-top with no album reference", () => {
    expect(() => buildPlaySpec({ intent: "album-from-top", source: "spotify" })).toThrow(/album/i);
  });

  it("rejects album-from-track without a start index (can't silently fall back to from-top)", () => {
    expect(() =>
      buildPlaySpec({ intent: "album-from-track", source: "spotify", albumUri: "spotify:album:xyz789" })
    ).toThrow(/index/i);
  });

  it("rejects a malformed Spotify album URI", () => {
    expect(() =>
      buildPlaySpec({ intent: "album-from-top", source: "spotify", albumUri: "not-a-spotify-album" })
    ).toThrow(/spotify:album/i);
  });

  it("rejects a track spec with no playable reference", () => {
    expect(() => buildPlaySpec({ intent: "track", track: { title: "x" } })).toThrow(/playable|uri|path|track/i);
  });

  it("builds a playlist spec from a Spotify playlist URI", () => {
    const spec = buildPlaySpec({ intent: "playlist", source: "spotify", playlistUri: "spotify:playlist:abc123" });
    expect(spec).toEqual({ kind: "playlist", source: "spotify", playlistUri: "spotify:playlist:abc123" });
  });

  it("rejects a malformed Spotify playlist URI", () => {
    expect(() =>
      buildPlaySpec({ intent: "playlist", source: "spotify", playlistUri: "spotify:album:xyz789" })
    ).toThrow(/spotify:playlist/i);
  });

  it("builds a discover spec with no fixed target (pure-taste surprise)", () => {
    const spec = buildPlaySpec({ intent: "discover", source: "spotify" });
    expect(spec).toEqual({ kind: "discover", source: "spotify" });
  });

  it("builds a discover spec carrying an optional theming seed", () => {
    const spec = buildPlaySpec({ intent: "discover", source: "spotify", seed: "phoebe bridgers" });
    expect(spec).toEqual({ kind: "discover", source: "spotify", seed: "phoebe bridgers" });
  });

  it("builds a library-playlist spec from a playlist id", () => {
    const spec = buildPlaySpec({ intent: "library", playlistId: "pl-abc123" });
    expect(spec).toEqual({ kind: "library", playlistId: "pl-abc123" });
  });

  it("rejects a library spec with no playlistId", () => {
    expect(() => buildPlaySpec({ intent: "library" })).toThrow(/playlist/i);
  });

  it("rejects an unknown intent", () => {
    // @ts-expect-error deliberately invalid
    expect(() => buildPlaySpec({ intent: "teleport" })).toThrow(/intent/i);
  });
});

describe("Tap PlaySpec validation (round-trip)", () => {
  it("accepts every spec buildPlaySpec produces", () => {
    const specs = [
      buildPlaySpec({ intent: "track", track: { uri: "spotify:track:0123456789abcdefghijAB" } }),
      buildPlaySpec({ intent: "album-from-top", source: "spotify", albumUri: "spotify:album:xyz789" }),
      buildPlaySpec({ intent: "album-from-top", source: "local", albumId: "42" }),
      buildPlaySpec({ intent: "album-from-track", source: "local", albumId: "42", startIndex: 2 }),
      buildPlaySpec({ intent: "playlist", source: "spotify", playlistUri: "spotify:playlist:abc123" }),
      buildPlaySpec({ intent: "discover", source: "spotify" }),
      buildPlaySpec({ intent: "discover", source: "spotify", seed: "mitski" }),
      buildPlaySpec({ intent: "library", playlistId: "pl-abc123" }),
      buildPlaySpec({ intent: "visual" })
    ];
    for (const spec of specs) {
      expect(validatePlaySpec(spec).ok).toBe(true);
    }
  });

  it("builds visual flows (defaults to mirror) and validates them", () => {
    expect(buildPlaySpec({ intent: "visual" })).toEqual({ kind: "visual", flow: "mirror" });
    expect(buildPlaySpec({ intent: "visual", flow: "mirror" })).toEqual({ kind: "visual", flow: "mirror" });
    expect(buildPlaySpec({ intent: "visual", flow: "fixed", url: "https://youtube.com/watch?v=abc" }))
      .toEqual({ kind: "visual", flow: "fixed", url: "https://youtube.com/watch?v=abc" });
    // bare {kind:visual} (no flow) stays valid for back-compat
    expect(validatePlaySpec({ kind: "visual" }).ok).toBe(true);
    expect(validatePlaySpec({ kind: "visual", flow: "fixed", url: "https://x.test/v" }).ok).toBe(true);
  });

  it("rejects a fixed visual flow without a URL", () => {
    expect(() => buildPlaySpec({ intent: "visual", flow: "fixed" })).toThrow(/url/i);
    expect(validatePlaySpec({ kind: "visual", flow: "fixed" }).ok).toBe(false);
  });

  it("builds a room-cast visual flow from a code string or array", () => {
    expect(buildPlaySpec({ intent: "visual", flow: "room", rooms: "tv" })).toEqual({ kind: "visual", flow: "room", rooms: ["tv"] });
    expect(buildPlaySpec({ intent: "visual", flow: "room", rooms: "tv, lounge bedroom" }).rooms).toEqual(["tv", "lounge", "bedroom"]);
    expect(buildPlaySpec({ intent: "visual", flow: "room", rooms: ["tv"] })).toEqual({ kind: "visual", flow: "room", rooms: ["tv"] });
    expect(validatePlaySpec({ kind: "visual", flow: "room", rooms: ["tv"] }).ok).toBe(true);
  });

  it("rejects a room-cast flow with no room codes", () => {
    expect(() => buildPlaySpec({ intent: "visual", flow: "room", rooms: "" })).toThrow(/room code/i);
    expect(validatePlaySpec({ kind: "visual", flow: "room", rooms: [] }).ok).toBe(false);
    expect(validatePlaySpec({ kind: "visual", flow: "room" }).ok).toBe(false);
  });

  it("rejects garbage that did not come from buildPlaySpec", () => {
    expect(validatePlaySpec({ kind: "album-from-top" }).ok).toBe(false);
    expect(validatePlaySpec({ kind: "nope" }).ok).toBe(false);
    expect(validatePlaySpec(null).ok).toBe(false);
  });
});
