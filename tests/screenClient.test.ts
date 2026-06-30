import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { playVideo, stopVideo, screenStatus } from "../server/screenClient.js";

// The screend client is a thin, fail-soft wrapper over the host daemon's HTTP
// API. These tests mock global fetch to assert what it sends and that nothing
// it does can throw (a tap must never fail because the screen is unreachable).

const calls: { url: string; init: any }[] = [];
function mockFetch(impl: (url: string, init: any) => any) {
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return impl(url, init);
  });
}
const okJson = (body: any = { ok: true }) => ({ ok: true, json: async () => body });

beforeEach(() => { calls.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

describe("screenClient", () => {
  it("POSTs a { url } body to /play for a specific video", async () => {
    mockFetch(() => okJson({ url: "https://x", resolvedFrom: undefined }));
    const res = await playVideo({ url: "https://youtube.com/watch?v=abc" });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/play$/);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ url: "https://youtube.com/watch?v=abc", audio: false });
  });

  it("POSTs a { query } body to /play for auto-find", async () => {
    mockFetch(() => okJson());
    await playVideo({ query: "Tame Impala official video" });
    expect(JSON.parse(calls[0].init.body)).toEqual({ query: "Tame Impala official video", audio: false });
  });

  it("prefers url over query when both are given", async () => {
    mockFetch(() => okJson());
    await playVideo({ url: "https://u", query: "q" } as any);
    expect(JSON.parse(calls[0].init.body)).toEqual({ url: "https://u", audio: false });
  });

  it("forwards seek/loop/matchDuration (for the visual sync mode)", async () => {
    mockFetch(() => okJson());
    await playVideo({ query: "artist title official video", seek: 45, loop: true, matchDuration: 200 });
    expect(JSON.parse(calls[0].init.body)).toEqual({ query: "artist title official video", seek: 45, loop: true, matchDuration: 200, audio: false });
  });

  it("omits no-op options (seek 0 / loop false) from the body", async () => {
    mockFetch(() => okJson());
    await playVideo({ url: "https://x", seek: 0, loop: false });
    expect(JSON.parse(calls[0].init.body)).toEqual({ url: "https://x", audio: false });
  });

  it("mutes the panel by default (Boom owns audio) and can be told to play audio", async () => {
    mockFetch(() => okJson());
    await playVideo({ url: "https://x" });
    expect(JSON.parse(calls[0].init.body).audio).toBe(false);
    calls.length = 0;
    await playVideo({ url: "https://x", audio: true });
    expect(JSON.parse(calls[0].init.body).audio).toBe(true);
  });

  it("does not call the daemon when there's no target", async () => {
    mockFetch(() => okJson());
    const res = await playVideo({});
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("hits /stop and GET /status", async () => {
    mockFetch(() => okJson({ playing: false }));
    await stopVideo();
    expect(calls[0].url).toMatch(/\/stop$/);
    await screenStatus();
    expect(calls[1].url).toMatch(/\/status$/);
    expect(calls[1].init.method).toBe("GET");
  });

  it("fails soft (never throws) when the daemon is unreachable", async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const res = await playVideo({ url: "https://x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it("reports ok:false on a non-2xx daemon response", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
    const res = await playVideo({ url: "https://x" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});
