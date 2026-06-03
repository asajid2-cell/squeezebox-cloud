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
          admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
        });
      }
      if (url.includes("/api/library/search")) {
        return jsonResponse({ results: [{ id: "s1", title: "Local Test", artist: "Downloads", source: "Local library", path: "/music/local.mp3" }] });
      }
      if (url.includes("/api/spotify/search")) {
        return jsonResponse({
          results: [
            { id: "sp1", title: "Headlines", artist: "Drake", album: "Take Care", source: "Spotify", uri: "spotify:track:abc123", kind: "track" },
            { id: "spotify:artist:drake", title: "Drake Artist", artist: "Spotify", source: "Spotify artist", uri: "spotify:artist:drake", kind: "artist" }
          ]
        });
      }
      if (url.includes("/api/library/collections")) {
        return jsonResponse({
          collections: [{ collection: "2025 Comp / Leaks", folder: "Goodbye ERA", count: 2, sample: ["First Leak", "Second Leak"] }]
        });
      }
      if (url.includes("/api/library/collection")) {
        return jsonResponse({
          results: [{ id: "local-playlist-1", title: "First Leak", artist: "Juice WRLD", source: "Local library", path: "/music/first.mp3" }]
        });
      }
      if (url.includes("/api/spotify/library")) {
        return jsonResponse({
          results: [{ id: "spotify:playlist:1", title: "Drake Mix", artist: "Spotify", source: "Spotify playlist", uri: "spotify:playlist:1", kind: "playlist", browseId: "8.1" }]
        });
      }
      if (url.includes("/api/spotify/children")) {
        return jsonResponse({
          results: [{ id: "spotify:track:child", title: "Playlist Child", artist: "Drake", source: "Spotify", uri: "spotify:track:child", kind: "track" }]
        });
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
    await userEvent.type(await screen.findByLabelText("Search music"), "local");
    await waitFor(() => expect(screen.getByText("Local Test")).toBeInTheDocument());
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "That song is already in the queue" }, 409));

    const row = screen.getByText("Local Test").closest(".result-row");
    expect(row).toBeTruthy();
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Queue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That song is already in the queue");
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
    expect(screen.getByText("Screen audit")).toBeInTheDocument();
  });

  it("searches local library results", async () => {
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Search music"), "local");
    await waitFor(() => expect(screen.getByText("Local Test")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Play now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play next" })).toBeInTheDocument();
  });

  it("surfaces failed library searches instead of rendering empty results", async () => {
    const fetchMock = vi.mocked(fetch);
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/api/library/search")) return jsonResponse({ error: "Library search failed hard" }, 502);
      return defaultFetch?.(url, options) ?? jsonResponse({ ok: true });
    });

    render(<App />);
    await userEvent.type(await screen.findByLabelText("Search music"), "local");

    expect(await screen.findByRole("alert")).toHaveTextContent("Library search failed hard");
  });

  it("uses a compact default local search and full limit for typed searches", async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/library/search") && String(url).includes("limit=60"))).toBe(true);
    });

    await userEvent.type(screen.getByLabelText("Search music"), "local");

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/library/search") && String(url).includes("q=local") && String(url).includes("limit=2000"))).toBe(true);
    });
  });

  it("searches Spotify when the Spotify source is selected", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.type(screen.getByLabelText("Search music"), "drake");
    await waitFor(() => expect(screen.getByText("Headlines")).toBeInTheDocument());
    expect(screen.getByText(/Drake - Take Care/)).toBeInTheDocument();
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
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Playlists" }));
    await userEvent.click(await screen.findByText("Goodbye ERA"));
    expect(await screen.findByText("First Leak")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue all" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Spotify" }));
    await userEvent.click(await screen.findByText("Drake Mix"));
    expect(await screen.findByText("Playlist Child")).toBeInTheDocument();
  });

  it("surfaces partial playlist batch queue acceptance", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Playlists" }));
    await userEvent.click(await screen.findByText("Goodbye ERA"));
    await userEvent.click(await screen.findByRole("button", { name: "Queue all" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Queued 1 of 2 tracks; 1 skipped because of the queue limit or duplicates.");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as Response);
}
