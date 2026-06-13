import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TapNow } from "../src/tap/TapNow";

type PlayFn = typeof import("../src/tap/api").playTap;
const fakePlay = (status: number, body: unknown): PlayFn => (async () => ({ status, body })) as unknown as PlayFn;

describe("Tap landing (TapNow)", () => {
  it("shows the now-playing card on a successful tap", async () => {
    const play = fakePlay(200, {
      ok: true,
      played: true,
      tag: { display: { title: "Punisher", artist: "Phoebe Bridgers" }, tapCount: 3 },
      nowPlaying: { name: "the Boom" }
    });
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
    expect(screen.getByText("Phoebe Bridgers")).toBeInTheDocument();
    expect(screen.getByText(/Playing on the Boom/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skip/i })).toBeInTheDocument();
  });

  it("renders the 'already playing' (debounced) state", async () => {
    const play = fakePlay(200, { ok: true, debounced: true, tag: { display: { title: "Kyoto", artist: "PB" } }, nowPlaying: { name: "the Boom" } });
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText(/already playing/i)).toBeInTheDocument());
  });

  it("shows the unbound state with a console link", async () => {
    const play = fakePlay(404, { ok: false, reason: "unbound" });
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText(/isn't set up yet/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Tap console/i })).toHaveAttribute("href", "/tap/link");
  });

  it("shows a clean speaker-offline message (not a crash)", async () => {
    const play = fakePlay(503, { ok: false, reason: "speaker_offline" });
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText(/speaker's offline/i)).toBeInTheDocument());
  });

  it("shows bad-token when verification fails", async () => {
    const play = fakePlay(401, { ok: false, reason: "bad-token" });
    render(<TapNow tagId="abc" token="bad" play={play} />);
    await waitFor(() => expect(screen.getByText(/couldn't verify/i)).toBeInTheDocument());
  });

  it("survives a network error with a retry-friendly message", async () => {
    const play = (async () => { throw new Error("network down"); }) as unknown as PlayFn;
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument());
  });

  it("does not crash on a missing cover image (falls back)", async () => {
    const play = fakePlay(200, { ok: true, played: true, tag: { display: { title: "No Art Album", artist: "X", art: null } }, nowPlaying: { name: "the Boom" } });
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText("No Art Album")).toBeInTheDocument());
  });
});
