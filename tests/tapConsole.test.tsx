import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/tap/api", () => ({
  adminLogin: vi.fn(),
  listTags: vi.fn(),
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTag: vi.fn(),
  searchLibrary: vi.fn(),
  spotifySearch: vi.fn(),
  albumTracks: vi.fn(),
  getAnalytics: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn()
}));
vi.mock("../src/tap/nfc", () => ({
  writeTapTag: vi.fn(async () => ({ ok: true })),
  isNfcWriteSupported: vi.fn(() => true)
}));

import { TapConsole } from "../src/tap/TapConsole";
import * as api from "../src/tap/api";

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocked.listTags.mockResolvedValue([]);
});

describe("Tap console — auth", () => {
  it("gates behind login, then signs in and shows the tag manager", async () => {
    mocked.adminLogin.mockResolvedValue({ ok: true, token: "tok" });
    render(<TapConsole />);
    expect(screen.getByText("Tap console")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Admin password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Tag collection")).toBeInTheDocument());
    expect(screen.getByText(/No tags yet/i)).toBeInTheDocument();
    expect(localStorage.getItem("tap.adminToken")).toBe("tok");
  });

  it("shows an error on a bad password", async () => {
    mocked.adminLogin.mockResolvedValue({ ok: false, error: "Invalid admin password" });
    render(<TapConsole />);
    await userEvent.type(screen.getByLabelText("Admin password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText(/Invalid admin password/i)).toBeInTheDocument());
  });
});

describe("Tap console — tag manager", () => {
  it("lists tags and pauses one", async () => {
    localStorage.setItem("tap.adminToken", "tok");
    mocked.listTags.mockResolvedValue([
      { tagId: "a1", enabled: true, display: { title: "Punisher", artist: "Phoebe Bridgers" }, tapCount: 3, playSpec: { kind: "album-from-top" }, token: "sig" }
    ]);
    mocked.updateTag.mockResolvedValue({});
    render(<TapConsole />);

    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
    expect(screen.getByText(/Tapped 3×/)).toBeInTheDocument();
    expect(screen.getByText(/Whole album/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(mocked.updateTag).toHaveBeenCalledWith("tok", "a1", { enabled: false });
  });

  it("sets a per-tag volume and queue play-mode from the card", async () => {
    localStorage.setItem("tap.adminToken", "tok");
    mocked.listTags.mockResolvedValue([
      { tagId: "a1", enabled: true, display: { title: "Kyoto", artist: "PB" }, tapCount: 0, playSpec: { kind: "track" }, policy: { playMode: "replace", volume: null }, token: "sig" }
    ]);
    mocked.updateTag.mockResolvedValue({});
    render(<TapConsole />);
    await waitFor(() => expect(screen.getByText("Kyoto")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText(/Volume for Kyoto/i), "60");
    expect(mocked.updateTag).toHaveBeenCalledWith("tok", "a1", { policy: { playMode: "replace", volume: 60 } });

    await userEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(mocked.updateTag).toHaveBeenCalledWith("tok", "a1", expect.objectContaining({ policy: expect.objectContaining({ playMode: "queue" }) }));
  });
});

describe("Tap console — bind & write", () => {
  beforeEach(() => {
    localStorage.setItem("tap.adminToken", "tok");
  });

  it("searches, binds a whole album, and reaches the write step with a QR + write button", async () => {
    mocked.spotifySearch.mockResolvedValue({
      results: [],
      groups: { albums: [{ title: "Punisher", artist: "Phoebe Bridgers", uri: "spotify:album:xyz789", kind: "album", art: null }], tracks: [], artists: [], playlists: [] }
    });
    mocked.createTag.mockResolvedValue({ status: 200, body: { tag: { tagId: "a1" }, token: "sig" } });
    render(<TapConsole />);

    await userEvent.click(screen.getByRole("link", { name: /write a tag/i }));
    await userEvent.type(screen.getByLabelText("Search music"), "punisher");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getByText("Albums")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /whole album/i }));

    expect(mocked.createTag).toHaveBeenCalledWith("tok", expect.objectContaining({ intent: "album-from-top", albumUri: "spotify:album:xyz789" }));
    await waitFor(() => expect(screen.getByText(/Burn it onto a tag/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Write to NFC tag/i })).toBeInTheDocument();
  });

  it("binds album-from-track by picking a song from the album's track list (carries the index)", async () => {
    mocked.spotifySearch.mockResolvedValue({
      results: [],
      groups: { albums: [{ title: "Punisher", artist: "PB", uri: "spotify:album:xyz789", kind: "album" }], tracks: [], artists: [], playlists: [] }
    });
    mocked.albumTracks.mockResolvedValue([{ title: "DVD Menu" }, { title: "Garden Song" }, { title: "Kyoto" }]);
    mocked.createTag.mockResolvedValue({ status: 200, body: { tag: { tagId: "a2" }, token: "sig" } });
    render(<TapConsole />);

    await userEvent.click(screen.getByRole("link", { name: /write a tag/i }));
    await userEvent.type(screen.getByLabelText("Search music"), "punisher");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(screen.getByText("Albums")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /start at a song/i }));

    await waitFor(() => expect(screen.getByText("Kyoto")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Kyoto/ }));

    expect(mocked.createTag).toHaveBeenCalledWith("tok", expect.objectContaining({ intent: "album-from-track", albumUri: "spotify:album:xyz789", startIndex: 2 }));
  });

  it("renders the Analytics view with totals, chart, and most-tapped", async () => {
    mocked.getAnalytics.mockResolvedValue({
      totalTaps: 42,
      totalTags: 5,
      windowTaps: 18,
      series: [{ date: "2026-06-01", count: 3 }, { date: "2026-06-02", count: 7 }],
      mostTapped: [{ tagId: "a1", display: { title: "Punisher", artist: "PB" }, tapCount: 12, kind: "album-from-top" }]
    });
    render(<TapConsole />);
    await userEvent.click(screen.getByRole("link", { name: /analytics/i }));
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
    render(<TapConsole />);
    await userEvent.click(screen.getByRole("link", { name: /print labels/i }));
    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
    expect(screen.getByText("Kyoto")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /print sheet/i })).toBeEnabled();
  });

  it("loads settings and closes the jukebox (party mode)", async () => {
    mocked.getSettings.mockResolvedValue({ debounceMs: 3000, partyMode: "open", requirePassword: false, hasPassword: false });
    mocked.saveSettings.mockResolvedValue({ debounceMs: 3000, partyMode: "closed", requirePassword: false, hasPassword: false });
    render(<TapConsole />);
    await userEvent.click(screen.getByRole("link", { name: /settings/i }));
    await waitFor(() => expect(screen.getByText(/How taps behave/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(mocked.saveSettings).toHaveBeenCalledWith("tok", { partyMode: "closed" });
  });

  it("shows the empty 'no matches' state", async () => {
    mocked.spotifySearch.mockResolvedValue({ results: [], groups: { albums: [], tracks: [], artists: [], playlists: [] } });
    render(<TapConsole />);
    await userEvent.click(screen.getByRole("link", { name: /write a tag/i }));
    await userEvent.type(screen.getByLabelText("Search music"), "zzz");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByText(/No matches/i)).toBeInTheDocument());
  });
});
