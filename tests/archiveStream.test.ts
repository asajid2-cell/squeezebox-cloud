import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// archiveStream is a thin, fail-soft wrapper over the archive service's ingest
// API. It reads its config once at module load, so each test re-imports it under
// the env it wants. global fetch is mocked to assert what it sends and that a
// report can never throw (a listen report must never affect playback).

const calls: { url: string; init: any }[] = [];

function mockFetch(impl: (url: string, init: any) => any) {
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return impl(url, init);
  });
}
const okJson = (body: any = { ok: true }) => ({ ok: true, json: async () => body });
const TRACK = { uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" };

async function loadClient(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  delete process.env.ARCHIVE_STREAM_INGEST_KEY;
  delete process.env.ARCHIVE_STREAM_URL;
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  return import("../server/archiveStream.js");
}

const CONFIGURED = { ARCHIVE_STREAM_INGEST_KEY: "test-ingest-key" };

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ARCHIVE_STREAM_INGEST_KEY;
  delete process.env.ARCHIVE_STREAM_URL;
});

describe("archiveStream", () => {
  it("POSTs the track uri to /internal/stream-listen with the ingest key", async () => {
    mockFetch(() => okJson({ trackId: "4uLU6hMCjMI75M1A2tKUQC", status: "queued", state: "needed" }));
    const { reportStreamListen } = await loadClient({ ...CONFIGURED, ARCHIVE_STREAM_URL: "http://archive:4230/" });
    const res: any = await reportStreamListen(TRACK);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("queued");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://archive:4230/internal/stream-listen");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["x-ingest-key"]).toBe("test-ingest-key");
    expect(JSON.parse(calls[0].init.body)).toEqual({ uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" });
  });

  it("defaults to the archive service name on the shared network", async () => {
    mockFetch(() => okJson());
    const { reportStreamListen } = await loadClient(CONFIGURED);
    await reportStreamListen(TRACK);
    expect(calls[0].url).toBe("http://archive:4230/internal/stream-listen");
  });

  it("normalizes a spotify:// uri", async () => {
    mockFetch(() => okJson());
    const { reportStreamListen } = await loadClient(CONFIGURED);
    await reportStreamListen({ uri: "spotify://track:4uLU6hMCjMI75M1A2tKUQC" });
    expect(JSON.parse(calls[0].init.body)).toEqual({ uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" });
  });

  it("skips a non-Spotify track without calling the archive", async () => {
    mockFetch(() => okJson());
    const { reportStreamListen } = await loadClient(CONFIGURED);
    const res: any = await reportStreamListen({ uri: "archive:tapcache/x.flac", path: "/music/x.flac" });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(calls).toHaveLength(0);
  });

  it("skips when no ingest key is configured", async () => {
    mockFetch(() => okJson());
    const { reportStreamListen, streamIngestConfigured } = await loadClient({});
    expect(streamIngestConfigured()).toBe(false);
    const res: any = await reportStreamListen(TRACK);
    expect(res).toEqual({ ok: false, skipped: true });
    expect(calls).toHaveLength(0);
  });

  it("fails soft (never throws) when the archive is unreachable", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { reportStreamListen } = await loadClient(CONFIGURED);
    const res: any = await reportStreamListen(TRACK);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it("reports ok:false on a non-2xx archive response", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }));
    const { reportStreamListen } = await loadClient(CONFIGURED);
    const res: any = await reportStreamListen(TRACK);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });
});
