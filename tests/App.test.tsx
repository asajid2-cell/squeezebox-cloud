import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

beforeEach(() => {
  window.history.pushState({}, "", "/");
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          nowPlaying: {
            id: "t1",
            title: "Midnight City",
            artist: "M83",
            album: "Hurry Up",
            source: "Spotify",
            duration: 243,
            elapsed: 151,
            canSeek: true,
            art: "api/artwork/test-cover"
          },
          queue: [{ id: "q1", title: "Awake", artist: "Tycho", source: "Spotify", requestedBy: "alex", etaMinutes: 7 }],
          recentPicks: [{ title: "Midnight City", artist: "M83", status: "Now playing" }],
          schedule: {
            current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false },
            next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true }
          },
          rules: [{ title: "Be respectful", detail: "No hate speech" }],
          services: {
            spotify: { configured: true, reachable: true, detail: "ok" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
            musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
          },
          trackInfo: {
            artistBio: "Artist biography text",
            albumReview: "Album review text",
            lyrics: "Lyrics text"
          },
          curation: { hidden: [], saved: [], pinned: [], revision: 0 },
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      if (url.includes("/api/library/search")) {
        return jsonResponse({ results: [{ id: "s1", title: "Local Test", artist: "Downloads", source: "Local library", path: "/music/local.mp3" }] });
      }
      if (url.includes("/api/spotify/search")) {
        const track = { id: "sp1", title: "Headlines", artist: "Drake", album: "Take Care", source: "Spotify", uri: "spotify:track:abc123", kind: "track" };
        const artist = { id: "spotify:artist:drake", title: "Drake Artist", artist: "Spotify", source: "Spotify artist", uri: "spotify:artist:drake", kind: "artist" };
        return jsonResponse({
          results: [track, artist],
          groups: { tracks: [track], artists: [artist], albums: [], playlists: [] }
        });
      }
      if (url.includes("/api/library/collections")) {
        return jsonResponse({
          collections: [{ collection: "2025 Comp / Leaks", folder: "Goodbye ERA", count: 2, sample: ["First Leak", "Second Leak"] }]
        });
      }
      if (url.includes("/api/library/collection")) {
        if (String(url).includes("limit=200")) {
          return jsonResponse({
            results: [
              { id: "local-playlist-1", title: "First Leak", artist: "Juice WRLD", source: "Local library", path: "/music/first.mp3" },
              { id: "local-playlist-2", title: "Second Leak", artist: "Juice WRLD", source: "Local library", path: "/music/second.mp3" }
            ]
          });
        }
        return jsonResponse({
          results: [{ id: "local-playlist-1", title: "First Leak", artist: "Juice WRLD", source: "Local library", path: "/music/first.mp3" }]
        });
      }
      if (url.includes("/api/spotify/library")) {
        return jsonResponse({
          results: String(url).includes("type=tracks")
            ? [{ id: "spotify:track:saved", title: "Saved Track", artist: "Drake", source: "Spotify", uri: "spotify:track:saved", kind: "track" }]
            : [{ id: "spotify:playlist:1", title: "Drake Mix", artist: "Spotify", source: "Spotify playlist", uri: "spotify:playlist:1", kind: "playlist", browseId: "8.1" }]
        });
      }
      if (url.includes("/api/spotify/children")) {
        return jsonResponse({
          results: [{ id: "spotify:track:child", title: "Playlist Child", artist: "Drake", source: "Spotify", uri: "spotify:track:child", kind: "track" }]
        });
      }
      if (url.match(/\/api\/playlists\/[^/]+$/) && (!options || options.method === "GET")) {
        return jsonResponse({ playlist: { id: "pl-1", name: "Late Nights", description: "", createdBy: "guest", createdAt: "", updatedAt: "", trackCount: 1, art: null, sample: ["First Leak"], tracks: [{ id: "spotify:track:child", title: "First Leak", artist: "Juice WRLD", source: "Spotify", uri: "spotify:track:child", kind: "track" }] } });
      }
      if (url.includes("/api/playlists") && options?.method === "POST") {
        return jsonResponse({ playlist: { id: "pl-1", name: "Late Nights", description: "", createdBy: "guest", createdAt: "", updatedAt: "", trackCount: 0, art: null, sample: [], tracks: [] } });
      }
      if (url.includes("/api/playlists")) {
        return jsonResponse({ playlists: [{ id: "pl-1", name: "Late Nights", description: "Chill set", createdBy: "guest", createdAt: "", updatedAt: "", trackCount: 1, art: null, sample: ["First Leak"] }] });
      }
      if (url.includes("/api/player/tracks") && options?.method === "POST") {
        return jsonResponse({ ok: true, accepted: 1, rejected: 1, queued: [], queue: [] });
      }
      if (url.includes("/api/player/track") && options?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/player/seek") && options?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/admin/settings") && options?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/admin/login") && options?.method === "POST") {
        return jsonResponse({ token: "test-token" });
      }
      if (url.includes("/api/curation") && options?.method === "POST") {
        return jsonResponse({ ok: true, curation: { hidden: [{ key: "uri:spotify:track:abc123", track: { title: "Headlines" }, updatedAt: "" }], saved: [], pinned: [], revision: 1 } });
      }
      if (url.includes("/api/speaker/connect-guide")) {
        return jsonResponse({
          serverHost: "23.17.17.81",
          lanServerHost: "192.168.1.142",
          lmsWebUrl: "http://23.17.17.81:9000",
          ports: [{ port: 9000, label: "LMS web and player HTTP" }],
          lmsWeb: { reachable: true, status: 200, url: "http://lms:9000" },
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          steps: ["Connect Wi-Fi", "Add New Library"]
        });
      }
      return jsonResponse({ ok: true });
    })
  );
});

describe("Cloud Squeeze UI", () => {
  it("renders public speaker controls and connection status", async () => {
    render(<App />);
    expect(await screen.findByText("Squeezebox Cloud")).toBeInTheDocument();
    expect(screen.getByLabelText("Now playing")).toBeInTheDocument();
    expect(screen.getByText("Speaker online")).toBeInTheDocument();
    expect(screen.getAllByText("Midnight City").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Track information")).toBeInTheDocument();
    expect(screen.getByAltText("Hurry Up cover")).toBeInTheDocument();
    expect(screen.getByLabelText("Seek position")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("sends seek requests from the progress slider", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    const slider = await screen.findByLabelText("Seek position");
    fireEvent.change(slider, { target: { value: "60" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => {
      const seekCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/player/seek"));
      expect(seekCall).toBeTruthy();
      expect(seekCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
      expect(JSON.parse(String(seekCall?.[1]?.body)).seconds).toEqual(expect.any(Number));
    });
  });

  it("resets local progress when the now-playing track changes with the same elapsed value", async () => {
    let secondTrack = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/state")) {
          return jsonResponse({
            player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: secondTrack ? "pause" : "play", volume: 68 },
            nowPlaying: {
              id: secondTrack ? "track-b" : "track-a",
              title: secondTrack ? "Track B" : "Track A",
              artist: "Tester",
              album: "",
              source: "Spotify",
              duration: 100,
              elapsed: 0,
              canSeek: true,
              art: null
            },
            queue: [],
            recentPicks: [],
            schedule: {
              current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false },
              next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true }
            },
            rules: [],
            services: {
              spotify: { configured: true, reachable: true, detail: "ok" },
              localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
              musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
            },
            trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
            playback: { shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed" },
            curation: { hidden: [], saved: [], pinned: [], revision: 0 },
            admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
          });
        }
        return jsonResponse({ ok: true });
      })
    );

    render(<App />);
    const slider = await screen.findByLabelText("Seek position");
    await waitFor(() => expect(Number((slider as HTMLInputElement).value)).toBeGreaterThan(0), { timeout: 1500 });

    secondTrack = true;
    await waitFor(() => expect(screen.getByText("Track B")).toBeInTheDocument(), { timeout: 1500 });
    expect((screen.getByLabelText("Seek position") as HTMLInputElement).value).toBe("0");
  });

  it("coalesces rapid volume slider changes", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    const slider = await screen.findByLabelText("Volume");

    fireEvent.change(slider, { target: { value: "69" } });
    fireEvent.change(slider, { target: { value: "70" } });
    fireEvent.change(slider, { target: { value: "79" } });

    await waitFor(() => {
      const volumeCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/player/volume"));
      expect(volumeCalls).toHaveLength(1);
    });

    const volumeCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/player/volume"));
    expect(JSON.parse(String(volumeCall?.[1]?.body))).toEqual({ volume: 79 });
  });

  it("surfaces failed transport controls", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await screen.findByRole("button", { name: "Pause" });
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/player/pause")) return jsonResponse({ error: "LMS control failed" }, 502);
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("LMS control failed");
  });

  it("sends stop requests from the transport controls", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => {
      const stopCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/player/stop"));
      expect(stopCall).toBeTruthy();
      expect(stopCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    });
  });

  it("surfaces failed queue actions", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "VPS library" }));
    await userEvent.type(await screen.findByLabelText("Search music"), "local");
    await waitFor(() => expect(screen.getByText("Local Test")).toBeInTheDocument());
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/player/track") && options?.method === "POST") {
        return jsonResponse({ error: "That song is already in the queue" }, 409);
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    const row = screen.getByText("Local Test").closest(".result-row");
    expect(row).toBeTruthy();
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /More actions/ }));
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Add to queue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That song is already in the queue");
  });

  it("does not send requester ownership when editing queue metadata", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    // Editing is only offered for LOCAL queue items (you don't own a Spotify track's
    // metadata) — so seed an editable local item rather than the default Spotify one.
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          nowPlaying: { id: "t1", title: "Midnight City", artist: "M83", album: "Hurry Up", source: "Spotify", duration: 243, elapsed: 151, canSeek: true },
          queue: [{ id: "q1", title: "Awake", artist: "Tycho", source: "Local library", path: "/music/Awake.mp3", requestedBy: "alex", etaMinutes: 7 }],
          recentPicks: [],
          schedule: { current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false }, next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true } },
          rules: [],
          services: {
            spotify: { configured: true, reachable: true, detail: "ok" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
            musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
          },
          trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    const row = (await screen.findByText("Awake")).closest(".queue-row") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /More queue actions/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Edit details" }));

    expect(screen.queryByLabelText("Requested by")).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Queue title"));
    await userEvent.type(screen.getByLabelText("Queue title"), "Edited Awake");
    await userEvent.clear(screen.getByLabelText("Queue artist"));
    await userEvent.type(screen.getByLabelText("Queue artist"), "Edited Tycho");
    await userEvent.click(within(row).getByRole("button", { name: /More queue actions/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Save edits" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, options]) => String(url).includes("/api/queue/") && options?.method === "PATCH");
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ title: "Edited Awake", artist: "Edited Tycho" });
    });
  });

  it("does not offer metadata editing for Spotify queue rows", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          nowPlaying: { id: "t1", title: "Midnight City", artist: "M83", album: "Hurry Up", source: "Spotify", duration: 243, elapsed: 151, canSeek: true },
          queue: [{ id: "q1", title: "Awake", artist: "Tycho", source: "Spotify", uri: "spotify:track:awake", requestedBy: "alex", etaMinutes: 7 }],
          recentPicks: [],
          schedule: { current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false }, next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true } },
          rules: [],
          services: {
            spotify: { configured: true, reachable: true, detail: "ok" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
            musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
          },
          trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));

    const row = (await screen.findByText("Awake")).closest(".queue-row") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /More queue actions/ }));
    expect(within(row).queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("disables public track actions when requests are paused", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          nowPlaying: { id: "t1", title: "Midnight City", artist: "M83", album: "Hurry Up", source: "Spotify", duration: 243, elapsed: 151, canSeek: true },
          queue: [],
          recentPicks: [],
          schedule: { current: { name: "Closed", until: "10:00 PM", requestsPaused: false }, next: { name: "Open", time: "10:00 PM - 8:00 AM", requestsPaused: false } },
          rules: [],
          services: {
            spotify: { configured: true, reachable: true, detail: "ok" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2, uploadedCount: 1 },
            musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
          },
          trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
          admin: { publicRequests: false, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      if (url.includes("/api/library/search")) {
        return jsonResponse({ results: [{ id: "upload-1", title: "Shabang", artist: "Drake", source: "Uploaded", path: "/music/uploads/Drake - Shabang.mp3" }] });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Uploaded" }));
    await userEvent.type(screen.getByLabelText("Search music"), "shabang");

    expect(await screen.findByText("Shabang")).toBeInTheDocument();
    const row = screen.getByText("Shabang").closest(".result-row") as HTMLElement;
    expect(within(row).getByRole("button", { name: /^Play( here)?$/ })).toBeDisabled();
    await userEvent.click(within(row).getByRole("button", { name: /More actions/ }));
    expect(within(row).getByRole("button", { name: "Play next" })).toBeDisabled();
    const queueButton = within(row).getByRole("button", { name: "Add to queue" });
    expect(queueButton).toBeDisabled();
    await userEvent.click(queueButton);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/player/track"))).toBe(false);
  });

  it("turns manual queue shuffle off instead of cycling into smart shuffle", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          nowPlaying: { id: "t1", title: "Midnight City", artist: "M83", album: "Hurry Up", source: "Spotify", duration: 243, elapsed: 151, canSeek: true },
          queue: [{ id: "q1", title: "Awake", artist: "Tycho", source: "Spotify", requestedBy: "alex", etaMinutes: 7 }],
          recentPicks: [],
          schedule: { current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false }, next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true } },
          rules: [],
          services: {
            spotify: { configured: true, reachable: true, detail: "ok" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
            musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
          },
          trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
          playback: { shuffle: true, smartQueue: false, repeat: "off", smartShuffleSource: "spotify" },
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Shuffle on" }));

    await waitFor(() => {
      const playbackCall = fetchMock.mock.calls.find(([url, options]) => String(url).includes("/api/player/playback") && options?.method === "POST");
      expect(playbackCall).toBeTruthy();
      expect(JSON.parse(String(playbackCall?.[1]?.body))).toEqual({ shuffle: false, smartQueue: false });
    });
  });

  it("renders shuffled queue from playback response before the next poll", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "stop", volume: 68 },
          nowPlaying: { id: "", title: "", artist: "", album: "", source: "LMS", duration: 0, elapsed: 0, canSeek: false },
          queue: [
            { id: "q1", title: "Shabang", artist: "Drake", source: "Uploaded", requestedBy: "guest", etaMinutes: 7 },
            { id: "q2", title: "Sleep Paralysis", artist: "Jackson Ivy", source: "Uploaded", requestedBy: "guest", etaMinutes: 14 }
          ],
          recentPicks: [],
          schedule: { current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false }, next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true } },
          rules: [],
          services: {
            spotify: { configured: true, reachable: true, detail: "ok" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
            musicInfo: { configured: true, reachable: true, detail: "Plugin ready" }
          },
          trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
          playback: { shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed" },
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      if (url.includes("/api/player/playback") && options?.method === "POST") {
        return jsonResponse({
          ok: true,
          playback: { shuffle: true, manualShuffle: true, smartQueue: false, repeat: "off", smartShuffleSource: "mixed" },
          queue: [
            { id: "q2", title: "Sleep Paralysis", artist: "Jackson Ivy", source: "Uploaded", requestedBy: "guest", etaMinutes: 7 },
            { id: "q1", title: "Shabang", artist: "Drake", source: "Uploaded", requestedBy: "guest", etaMinutes: 14 }
          ]
        });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Shuffle" }));

    await waitFor(() => {
      const rows = screen.getAllByText(/Shabang|Sleep Paralysis/).map((node) => node.textContent);
      expect(rows.indexOf("Sleep Paralysis")).toBeLessThan(rows.indexOf("Shabang"));
    });
  });

  it("navigates public sections from the sidebar", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Queue" }));
    expect(await screen.findByLabelText("Up next")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Playlists" }));
    expect(await screen.findByLabelText("Playlists")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Schedule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Room/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request song/i })).not.toBeInTheDocument();
  });

  it("requires admin login on the admin route", async () => {
    window.history.pushState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Admin login" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Admin password"), "admin");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Service providers")).toBeInTheDocument();
    expect(screen.getByText("Connect speaker")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("192.168.1.142")).toBeInTheDocument();
  });

  it("searches local library results", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "VPS library" }));
    await userEvent.type(await screen.findByLabelText("Search music"), "local");
    await waitFor(() => expect(screen.getByText("Local Test")).toBeInTheDocument());
    const row = screen.getByText("Local Test").closest(".result-row") as HTMLElement;
    expect(within(row).getByRole("button", { name: /^Play( here)?$/ })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: /More actions/ }));
    expect(within(row).getByRole("button", { name: "Play next" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Add to queue" })).toBeInTheDocument();
  });

  it("shows a real time when a duration is known and a blank (never --:--) when it isn't", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/library/search")) {
        return jsonResponse({ results: [
          { id: "d1", title: "Timed Track", artist: "Tester", source: "Local library", path: "/music/timed.mp3", duration: 213 },
          { id: "d2", title: "Untimed Track", artist: "Tester", source: "Local library", path: "/music/untimed.mp3", duration: null }
        ] });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "VPS library" }));
    await userEvent.type(await screen.findByLabelText("Search music"), "track");
    await waitFor(() => expect(screen.getByText("Timed Track")).toBeInTheDocument());

    const timedRow = screen.getByText("Timed Track").closest(".result-row") as HTMLElement;
    expect(within(timedRow).getByText("3:33")).toBeInTheDocument();

    const untimedRow = screen.getByText("Untimed Track").closest(".result-row") as HTMLElement;
    expect(within(untimedRow).queryByText("--:--")).not.toBeInTheDocument();
    expect(within(untimedRow).queryByText("3:33")).not.toBeInTheDocument();
  });

  it("re-runs a Spotify search automatically once Spotify finishes initializing (the cold-boot fix)", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    let stateCalls = 0;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/state")) {
        stateCalls += 1;
        const ready = stateCalls > 1; // first poll: "Not checked yet"; later polls: ready
        return jsonResponse({
          player: { id: "p1", name: "Test Speaker", connected: true, online: true, mode: "play", volume: 68 },
          nowPlaying: { id: "t1", title: "X", artist: "Y", album: "", source: "Spotify", duration: 100, elapsed: 0, canSeek: true },
          queue: [], recentPicks: [],
          schedule: { current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false }, next: { name: "Quiet", time: "", requestsPaused: false } },
          rules: [],
          services: {
            spotify: { configured: ready, reachable: ready, detail: ready ? "ok" : "Not checked yet" },
            localLibrary: { root: "Downloads", reachable: true, trackCount: 2 },
            musicInfo: { configured: false, reachable: false, detail: "" }
          },
          trackInfo: { artistBio: "", albumReview: "", lyrics: "" },
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      if (url.includes("/api/spotify/search")) {
        const track = { id: "s-cold", title: "Cold Start Hit", artist: "Tester", source: "Spotify", uri: "spotify:track:0123456789abcdefghijAB", kind: "track" };
        return jsonResponse({ results: [track], groups: { tracks: [track], artists: [], albums: [], playlists: [] } });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });
    // The default source IS Spotify, so on a cold load the app is searching Spotify
    // while it's still initializing — exactly the bug. Type a query in that window.
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Search music"), "hit");
    // The first state poll reports Spotify not-yet-ready, so the search returns nothing.
    // A later poll flips it ready; the search effect depends on that readiness, so it
    // re-runs on its own and the result appears WITHOUT the user retyping or refreshing.
    expect(await screen.findByText("Cold Start Hit", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("surfaces failed library searches instead of rendering empty results", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/library/search")) return jsonResponse({ error: "Library search failed hard" }, 502);
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "VPS library" }));
    await userEvent.type(await screen.findByLabelText("Search music"), "local");

    expect(await screen.findByRole("alert")).toHaveTextContent("Library search failed hard");
  });

  it("clears stale search errors after a later successful search", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    let failSearch = true;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/library/search")) {
        if (failSearch) return jsonResponse({ error: "Library search failed hard" }, 502);
        return jsonResponse({ results: [{ id: "s2", title: "Recovered Result", artist: "Downloads", source: "Local library", path: "/music/recovered.mp3" }] });
      }
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "VPS library" }));
    await userEvent.type(await screen.findByLabelText("Search music"), "bad");
    expect(await screen.findByRole("alert")).toHaveTextContent("Library search failed hard");

    failSearch = false;
    await userEvent.clear(screen.getByLabelText("Search music"));
    await userEvent.type(screen.getByLabelText("Search music"), "good");

    expect(await screen.findByText("Recovered Result")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("uses compact local search limits for default and typed searches", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "VPS library" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/library/search") && String(url).includes("limit=60"))).toBe(true);
    });

    await userEvent.type(screen.getByLabelText("Search music"), "local");

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/library/search") && String(url).includes("q=local") && String(url).includes("limit=50"))).toBe(true);
    });
  });

  it("searches Spotify when the Spotify source is selected", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Search music"), "drake");
    await waitFor(() => expect(screen.getByText("Headlines")).toBeInTheDocument());
    expect(screen.getByText(/Drake - Take Care/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/spotify/search") && String(url).includes("q=drake") && String(url).includes("limit=20"))).toBe(true);
  });

  it("does not show playback actions for Spotify search containers", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.type(screen.getByLabelText("Search music"), "drake");
    await waitFor(() => expect(screen.getByText("Drake Artist")).toBeInTheDocument());

    const artistRow = screen.getByText("Drake Artist").closest(".result-row");
    expect(artistRow).toBeTruthy();
    expect(within(artistRow as HTMLElement).queryByRole("button", { name: "Play now" })).not.toBeInTheDocument();
    expect(within(artistRow as HTMLElement).queryByRole("button", { name: "Queue" })).not.toBeInTheDocument();
  });

  it("opens local and Spotify playlists before queueing individual tracks", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Playlists" }));
    await userEvent.click(await screen.findByRole("button", { name: "Local" }));
    await userEvent.click(await screen.findByText("Goodbye ERA"));
    expect(await screen.findByText("First Leak")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue all" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/library/collection") && String(url).includes("limit=50"))).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.click(await screen.findByText("Drake Mix"));
    expect(await screen.findByText("Playlist Child")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/spotify/children") && String(url).includes("limit=50"))).toBe(true);
  });

  it("opens saved Spotify tracks without queueing them until an explicit action", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Playlists" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.click(screen.getByRole("button", { name: "tracks" }));
    await userEvent.click(await screen.findByText("Saved Track"));

    expect(await screen.findByLabelText("Saved Track tracks")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/spotify/children"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes("/api/player/track") && options?.method === "POST")).toBe(false);

    const row = screen.getAllByText("Saved Track").find((element) => element.closest(".result-row"))?.closest(".result-row");
    expect(row).toBeTruthy();
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /More actions/ }));
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Add to queue" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes("/api/player/track") && options?.method === "POST")).toBe(true);
    });
  });

  it("surfaces partial playlist batch queue acceptance", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Playlists" }));
    await userEvent.click(await screen.findByRole("button", { name: "Local" }));
    await userEvent.click(await screen.findByText("Goodbye ERA"));
    await userEvent.click(await screen.findByRole("button", { name: "Queue all" }));

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/library/collection") && String(url).includes("limit=200"))).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("Queued 1 of 2 tracks; 1 skipped because of the queue limit or duplicates.");
  });

  it("shows app playlists under My Playlists and opens their tracks", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Playlists" }));
    await userEvent.click(await screen.findByRole("button", { name: "My Playlists" }));
    await userEvent.click(await screen.findByText("Late Nights"));
    expect(await screen.findByText("First Leak")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue all" })).toBeInTheDocument();
  });

  it("can add a Spotify track to a playlist from search", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.type(screen.getByLabelText("Search music"), "drake");
    await waitFor(() => expect(screen.getByText("Headlines")).toBeInTheDocument());
    const row = screen.getByText("Headlines").closest(".result-row");
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /More actions/ }));
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /Save/ }));
    await userEvent.click(await screen.findByText("Late Nights"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, options]) => /\/api\/playlists\/pl-1\/tracks$/.test(String(url)) && options?.method === "POST")).toBe(true);
    });
  });

  it("shows admin curation actions for search rows", async () => {
    const fetchMock = vi.mocked(fetch);
    window.localStorage.setItem("cloud-squeeze-admin-token", "test-token");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.type(screen.getByLabelText("Search music"), "drake");
    await waitFor(() => expect(screen.getByText("Headlines")).toBeInTheDocument());

    const row = screen.getByText("Headlines").closest(".result-row");
    expect(row).toBeTruthy();
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /More actions/ }));
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Hide" }));

    await waitFor(() => {
      const curationCall = fetchMock.mock.calls.find(([url, options]) => String(url).includes("/api/curation") && options?.method === "POST");
      expect(curationCall).toBeTruthy();
      expect(curationCall?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer test-token" }));
      expect(curationCall?.[1]?.body).toContain("\"action\":\"hide\"");
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as Response);
}
