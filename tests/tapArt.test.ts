import { describe, it, expect } from "vitest";
import { artSrc } from "../src/tap/api";

// Cover art is stored RELATIVE ("api/image-proxy?...") — on the tapper page it
// must be resolved to an absolute path or the <img> 404s (the "no cover after
// tap" bug). In tests BASE_URL is "/" so the prefix is just a leading slash.
describe("artSrc (cover-art URL resolution)", () => {
  it("prefixes a relative api/ path so it resolves from the site root, not the page path", () => {
    expect(artSrc("api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fx")).toBe("/api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fx");
    expect(artSrc("api/artwork/123")).toBe("/api/artwork/123");
  });
  it("leaves already-absolute URLs untouched", () => {
    expect(artSrc("https://i.scdn.co/image/x")).toBe("https://i.scdn.co/image/x");
    expect(artSrc("/api/artwork/123")).toBe("/api/artwork/123");
    expect(artSrc("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
  });
  it("returns undefined for empty art (falls back to the icon)", () => {
    expect(artSrc(null)).toBeUndefined();
    expect(artSrc(undefined)).toBeUndefined();
    expect(artSrc("")).toBeUndefined();
  });
});
