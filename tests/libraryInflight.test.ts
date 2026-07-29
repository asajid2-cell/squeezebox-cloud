import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const { fgMock } = vi.hoisted(() => ({ fgMock: vi.fn() }));

vi.mock("fast-glob", () => ({ default: fgMock }));

const { clearLibraryCaches, searchLibrary } = await import("../server/library.js");

describe("library scan in-flight cache", () => {
  afterEach(() => {
    clearLibraryCaches();
    fgMock.mockReset();
  });

  it("shares one cold filesystem scan across concurrent searches", async () => {
    const root = "Z:/music";
    let releaseScan: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    fgMock.mockImplementation(async () => {
      await scanGate;
      return [
        path.join(root, "Artist - First Song.mp3"),
        path.join(root, "Artist - Second Song.mp3")
      ];
    });

    const first = searchLibrary("", root, 10, "local");
    const second = searchLibrary("second", root, 10, "local");
    await Promise.resolve();
    releaseScan();

    const [all, filtered] = await Promise.all([first, second]);

    expect(fgMock).toHaveBeenCalledTimes(1);
    expect(all.map((track) => track.title)).toEqual(["First Song", "Second Song"]);
    expect(filtered.map((track) => track.title)).toEqual(["Second Song"]);
  });
});
