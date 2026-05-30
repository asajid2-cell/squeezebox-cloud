import { describe, expect, it } from "vitest";
import { fileToTrack } from "../server/library.js";

describe("library scanner helpers", () => {
  it("turns local audio paths into searchable tracks", () => {
    const track = fileToTrack("C:/Users/Ahmed/Downloads/M83 - Midnight City.mp3");
    expect(track.title).toBe("Midnight City");
    expect(track.artist).toBe("M83");
    expect(track.source).toBe("Local library");
    expect(track.id).toContain("local:");
  });
});

