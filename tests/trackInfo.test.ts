import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichTrackInfo } from "../server/trackInfo.js";

describe("track information enrichment", () => {
  afterEach(() => {
    delete process.env.TRACK_INFO_ALLOW_NETWORK_IN_TESTS;
    vi.unstubAllGlobals();
  });

  it("skips Wikipedia disambiguation summaries for ambiguous artist names", async () => {
    process.env.TRACK_INFO_ALLOW_NETWORK_IN_TESTS = "1";
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("musicbrainz.org")) return jsonResponse({ recordings: [] });
      if (url.includes("lrclib.net")) return jsonResponse([]);
      if (url.includes("lyrics.ovh")) return jsonResponse({}, 404);
      if (url.includes("itunes.apple.com")) {
        return jsonResponse({ results: [{ collectionName: "$ome $exy $ongs 4 U", releaseDate: "2025-02-14T00:00:00Z" }] });
      }
      if (url.endsWith("/Drake")) {
        return jsonResponse({ extract: "Drake may refer to: a type of bird, a person, or several other topics." });
      }
      if (url.endsWith("/Drake%20(musician)")) {
        return jsonResponse({ extract: "Aubrey Drake Graham is a Canadian rapper, singer, and actor." });
      }
      return jsonResponse({}, 404);
    }));

    const info = await enrichTrackInfo({ title: "NOKIA", artist: "Drake" });

    expect(info.artistBio).toBe("Aubrey Drake Graham is a Canadian rapper, singer, and actor.");
    expect(info.artistBio).not.toContain("may refer to");
    expect(requestedUrls.some((url) => url.endsWith("/Drake"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/Drake%20(musician)"))).toBe(true);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as Response);
}
