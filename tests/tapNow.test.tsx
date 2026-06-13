import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("forwards SUN ctr/cmac from the URL query to the resolver", async () => {
    window.history.pushState({}, "", "/tap/t/abc?ctr=42&cmac=deadbeef");
    const play = vi.fn(async () => ({ status: 200, body: { ok: true, played: true, tag: { display: { title: "Punisher" } }, nowPlaying: { name: "the Boom" } } })) as unknown as PlayFn;
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText("Punisher")).toBeInTheDocument());
    expect(play).toHaveBeenCalledWith("abc", "t", expect.objectContaining({ ctr: "42", cmac: "deadbeef" }));
    window.history.pushState({}, "", "/");
  });

  it("prompts for a password when required, then retries with it", async () => {
    const play = vi.fn()
      .mockResolvedValueOnce({ status: 401, body: { ok: false, reason: "password" } })
      .mockResolvedValueOnce({ status: 200, body: { ok: true, played: true, tag: { display: { title: "Kyoto" } }, nowPlaying: { name: "the Boom" } } }) as unknown as PlayFn;
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText(/Password required/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Tap password"), "sesame");
    await userEvent.click(screen.getByRole("button", { name: /^play$/i }));
    await waitFor(() => expect(screen.getByText("Kyoto")).toBeInTheDocument());
    expect(play).toHaveBeenLastCalledWith("abc", "t", expect.objectContaining({ password: "sesame" }));
  });

  it("does not crash on a missing cover image (falls back)", async () => {
    const play = fakePlay(200, { ok: true, played: true, tag: { display: { title: "No Art Album", artist: "X", art: null } }, nowPlaying: { name: "the Boom" } });
    render(<TapNow tagId="abc" token="t" play={play} />);
    await waitFor(() => expect(screen.getByText("No Art Album")).toBeInTheDocument());
  });
});
