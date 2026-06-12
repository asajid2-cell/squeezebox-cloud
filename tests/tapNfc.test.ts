import { describe, it, expect, vi, afterEach } from "vitest";
import { writeTapTag, isNfcWriteSupported } from "../src/tap/nfc";

// Mock the Web NFC writer the phone exposes. Reading a tag at tap-time needs no
// code (the OS opens the URL); we only WRITE, so we only mock the writer.
class MockNDEFReader {
  static lastWrite: unknown = null;
  async write(message: unknown) {
    MockNDEFReader.lastWrite = message;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  MockNDEFReader.lastWrite = null;
});

describe("Tap NFC writer", () => {
  it("reports unsupported when NDEFReader is absent (e.g. desktop / iOS)", () => {
    expect(isNfcWriteSupported()).toBe(false);
  });

  it("writes the tap URL as a 'url' NDEF record via NDEFReader", async () => {
    vi.stubGlobal("NDEFReader", MockNDEFReader);
    expect(isNfcWriteSupported()).toBe(true);

    const url = "https://harmonizerlabs.cc/tap/t/abc123#k=tok";
    const res = await writeTapTag(url);

    expect(res.ok).toBe(true);
    expect(MockNDEFReader.lastWrite).toEqual({ records: [{ recordType: "url", data: url }] });
  });

  it("the written URL is exactly what a phone opens on tap (token in the fragment)", async () => {
    vi.stubGlobal("NDEFReader", MockNDEFReader);
    const url = "https://harmonizerlabs.cc/tap/t/abc123#k=tok";
    await writeTapTag(url);

    // Simulate the OS read path: the stored URL is what the phone navigates to.
    const opened = (MockNDEFReader.lastWrite as { records: { data: string }[] }).records[0].data;
    const parsed = new URL(opened);
    expect(parsed.pathname).toBe("/tap/t/abc123");
    expect(parsed.hash).toBe("#k=tok"); // fragment, never the query string
    expect(parsed.search).toBe("");
  });

  it("returns a clean failure (not a throw) for an empty URL", async () => {
    vi.stubGlobal("NDEFReader", MockNDEFReader);
    expect((await writeTapTag("")).ok).toBe(false);
  });

  it("surfaces a write error (e.g. user cancelled) instead of throwing", async () => {
    class FailingReader {
      async write() {
        throw new Error("user cancelled the tag write");
      }
    }
    vi.stubGlobal("NDEFReader", FailingReader);
    const res = await writeTapTag("https://x/tap/t/a#k=b");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cancel/i);
  });

  it("reports unsupported (clean failure) when NDEFReader is missing at write time", async () => {
    const res = await writeTapTag("https://x/tap/t/a#k=b");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unsupported");
  });
});
