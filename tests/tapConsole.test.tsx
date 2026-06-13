import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/tap/api", () => ({
  getSession: vi.fn(),
  listTags: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  searchLibrary: vi.fn(),
  spotifySearch: vi.fn(),
  spotifySearchCategories: vi.fn(),
  albumTracks: vi.fn(),
  getAnalytics: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  exportBackup: vi.fn(),
  importBackup: vi.fn(),
  // Plain fn (not vi.fn) so resetAllMocks() leaves it intact — it's a pure
  // URL helper the Art component calls during render, not a behavior under test.
  artSrc: (art?: string | null) => (art ? art : undefined)
}));
vi.mock("../src/tap/nfc", () => ({
  writeTapTag: vi.fn(async () => ({ ok: true })),
  isNfcWriteSupported: vi.fn(() => true)
}));

import { TapConsole } from "../src/tap/TapConsole";
import * as api from "../src/tap/api";

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.resetAllMocks();
  // Authenticated hl-auth session by default; the "signed out" test overrides it.
  mocked.getSession.mockResolvedValue({ authed: true, user: { username: "owner", isMaster: true }, loginUrl: "/auth/login", logoutUrl: "/auth/logout" });
  mocked.listTags.mockResolvedValue([]);
  mocked.spotifySearchCategories.mockResolvedValue({ artists: [], albums: [], playlists: [] });
});

// Wait for the console shell (post-session) before interacting.
async function go(view?: RegExp) {
  render(<TapConsole />);
  await screen.findByRole("link", { name: /^tags$/i });
  if (view) await userEvent.click(screen.getByRole("link", { name: view }));
}

describe("Tap console — hl-auth", () => {
  it("shows the 'Sign in with Harmonizer' card when not signed in", async () => {
    mocked.getSession.mockResolvedValue({ authed: false, user: null, loginUrl: "/auth/login" });
    render(<TapConsole />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument());
    expect(screen.getByText(/Sign in with your Harmonizer account/i)).toBeInTheDocument();
    expect(screen.queryByText("Tag collection")).not.toBeInTheDocument();
  });

  it("renders the console (and the signed-in username) when authed", async () => {
    await go();
    expect(screen.getByText("Tag collection")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});

describe("Tap console — tag manager", () => {
  it("lists tags and pauses one", async () => {
    mocked.listTags.mockResolvedValue([
      { tagId: "a1", enabled: true, display: { title: "Punisher", artist: "Phoebe Bridgers" }, tapCount: 3, playSpec: { kind: "album-from-top" }, token: "sig" }
    ]);
    mocked.updateTag.mockResolvedValue({});
    await go();

    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
    expect(screen.getByText(/Tapped 3×/)).toBeInTheDocument();
    expect(screen.getByText(/Whole album/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(mocked.updateTag).toHaveBeenCalledWith("a1", { enabled: false });
  });

  it("sets a per-tag volume and queue play-mode from the card", async () => {
    mocked.listTags.mockResolvedValue([
      { tagId: "a1", enabled: true, display: { title: "Kyoto", artist: "PB" }, tapCount: 0, playSpec: { kind: "track" }, policy: { playMode: "replace", volume: null }, token: "sig" }
    ]);
    mocked.updateTag.mockResolvedValue({});
    await go();
    await waitFor(() => expect(screen.getByText("Kyoto")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText(/Volume for Kyoto/i), "60");
    expect(mocked.updateTag).toHaveBeenCalledWith("a1", { policy: { playMode: "replace", volume: 60 } });

    await userEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(mocked.updateTag).toHaveBeenCalledWith("a1", expect.objectContaining({ policy: expect.objectContaining({ playMode: "queue" }) }));
  });
});

describe("Tap console — bind & write", () => {
  it("searches, binds a whole album, and reaches the write step with a QR + write button", async () => {
    mocked.spotifySearch.mockResolvedValue({
      results: [],
      groups: { albums: [], tracks: [], artists: [], playlists: [] }
    });
    mocked.spotifySearchCategories.mockResolvedValue({ artists: [], albums: [{ title: "Punisher", artist: "Phoebe Bridgers", uri: "spotify:album:xyz789", kind: "album", art: null }], playlists: [] });
    mocked.createTag.mockResolvedValue({ status: 200, body: { tag: { tagId: "a1" }, token: "sig" } });
    await go(/write a tag/i);

    await userEvent.type(screen.getByLabelText("Search music"), "punisher");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getByText("Albums")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /whole album/i }));

    expect(mocked.createTag).toHaveBeenCalledWith(expect.objectContaining({ intent: "album-from-top", albumUri: "spotify:album:xyz789" }));
    expect(mocked.spotifySearchCategories).toHaveBeenCalledWith("punisher");
    await waitFor(() => expect(screen.getByText(/Burn it onto a tag/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Write to NFC tag/i })).toBeInTheDocument();
  });

  it("binds album-from-track by picking a song from the album's track list (carries the index)", async () => {
    mocked.spotifySearch.mockResolvedValue({
      results: [],
      groups: { albums: [], tracks: [], artists: [], playlists: [] }
    });
    mocked.spotifySearchCategories.mockResolvedValue({ artists: [], albums: [{ title: "Punisher", artist: "PB", uri: "spotify:album:xyz789", kind: "album" }], playlists: [] });
    mocked.albumTracks.mockResolvedValue([{ title: "DVD Menu" }, { title: "Garden Song" }, { title: "Kyoto" }]);
    mocked.createTag.mockResolvedValue({ status: 200, body: { tag: { tagId: "a2" }, token: "sig" } });
    await go(/write a tag/i);

    await userEvent.type(screen.getByLabelText("Search music"), "punisher");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getByText("Albums")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /start at a song/i }));

    await waitFor(() => expect(screen.getByText("Kyoto")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Kyoto/ }));

    expect(mocked.createTag).toHaveBeenCalledWith(expect.objectContaining({ intent: "album-from-track", albumUri: "spotify:album:xyz789", startIndex: 2 }));
  });

  it("shows Spotify artists from the category endpoint and can search albums from one", async () => {
    mocked.spotifySearch.mockResolvedValueOnce({
      results: [{ title: "Kyoto", artist: "Phoebe Bridgers", uri: "spotify:track:0123456789abcdefghijAB", kind: "track" }],
      groups: { albums: [], tracks: [{ title: "Kyoto", artist: "Phoebe Bridgers", uri: "spotify:track:0123456789abcdefghijAB", kind: "track" }], artists: [], playlists: [] }
    });
    mocked.spotifySearch.mockResolvedValueOnce({ results: [], groups: { albums: [], tracks: [], artists: [], playlists: [] } });
    mocked.spotifySearchCategories.mockResolvedValueOnce({
      artists: [{ title: "Phoebe Bridgers", uri: "spotify:artist:abc", kind: "artist" }],
      albums: [],
      playlists: [{ title: "Phoebe Essentials", uri: "spotify:playlist:def", kind: "playlist" }]
    });
    mocked.spotifySearchCategories.mockResolvedValueOnce({
      artists: [],
      albums: [{ title: "Punisher", artist: "Phoebe Bridgers", uri: "spotify:album:xyz789", kind: "album" }],
      playlists: []
    });
    await go(/write a tag/i);

    await userEvent.type(screen.getByLabelText("Search music"), "phoebe");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getByText("Artists")).toBeInTheDocument());
    expect(screen.getAllByText("Phoebe Bridgers").length).toBeGreaterThan(0);
    expect(screen.getByText("Playlist tags are not enabled yet.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /search albums/i }));
    await waitFor(() => expect(mocked.spotifySearchCategories).toHaveBeenLastCalledWith("Phoebe Bridgers"));
    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
  });

  it("renders the Analytics view with totals, chart, and most-tapped", async () => {
    mocked.getAnalytics.mockResolvedValue({
      totalTaps: 42,
      totalTags: 5,
      windowTaps: 18,
      series: [{ date: "2026-06-01", count: 3 }, { date: "2026-06-02", count: 7 }],
      mostTapped: [{ tagId: "a1", display: { title: "Punisher", artist: "PB" }, tapCount: 12, kind: "album-from-top" }]
    });
    await go(/analytics/i);
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
    expect(screen.getByText(/total taps/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /taps over time/i })).toBeInTheDocument();
    expect(screen.getByText("Punisher")).toBeInTheDocument();
    expect(screen.getByText(/Tapped 12×/)).toBeInTheDocument();
  });

  it("renders printable QR label cards for tags", async () => {
    mocked.listTags.mockResolvedValue([
      { tagId: "a1", display: { title: "Punisher", artist: "PB" }, token: "sig1", enabled: true },
      { tagId: "a2", display: { title: "Kyoto", artist: "PB" }, token: "sig2", enabled: true }
    ]);
    await go(/print labels/i);
    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
    expect(screen.getByText("Kyoto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /print sheet/i })).toBeEnabled();
  });

  it("loads settings and closes the jukebox (party mode)", async () => {
    mocked.getSettings.mockResolvedValue({ debounceMs: 3000, partyMode: "open", requirePassword: false, hasPassword: false });
    mocked.saveSettings.mockResolvedValue({ debounceMs: 3000, partyMode: "closed", requirePassword: false, hasPassword: false });
    await go(/settings/i);
    await waitFor(() => expect(screen.getByText(/How taps behave/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(mocked.saveSettings).toHaveBeenCalledWith({ partyMode: "closed" });
  });

  it("exports a backup from the Settings view", async () => {
    mocked.getSettings.mockResolvedValue({ debounceMs: 3000, partyMode: "open", requirePassword: false, hasPassword: false });
    mocked.exportBackup.mockResolvedValue({ version: 1, tags: [], settings: {} });
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await go(/settings/i);
    await waitFor(() => expect(screen.getByText("Backup")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /export backup/i }));
    await waitFor(() => expect(mocked.exportBackup).toHaveBeenCalled());
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows the empty 'no matches' state", async () => {
    mocked.spotifySearch.mockResolvedValue({ results: [], groups: { albums: [], tracks: [], artists: [], playlists: [] } });
    await go(/write a tag/i);
    await userEvent.type(screen.getByLabelText("Search music"), "zzz");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText(/No matches/i)).toBeInTheDocument());
  });
});
