import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/tap/nfc", () => ({
  writeTapTag: vi.fn(async () => ({ ok: true })),
  isNfcWriteSupported: vi.fn(() => true)
}));

import { TapWrite } from "../src/tap/TapWrite";
import * as nfc from "../src/tap/nfc";

const mocked = nfc as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  (mocked.isNfcWriteSupported as ReturnType<typeof vi.fn>).mockReturnValue(true);
  window.history.pushState({}, "", "/tap/write/abc123?t=Punisher#k=tok9");
});

describe("Tap write page", () => {
  it("writes the tag's tap URL (id + token) and never plays", async () => {
    render(<TapWrite tagId="abc123" />);
    expect(screen.getByText(/Write this tag/i)).toBeInTheDocument();
    expect(screen.getByText(/Punisher/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /write to nfc tag/i }));
    await waitFor(() => expect(mocked.writeTapTag).toHaveBeenCalled());
    expect(mocked.writeTapTag.mock.calls[0][0]).toMatch(/\/tap\/t\/abc123#k=tok9$/);
    await waitFor(() => expect(screen.getByText(/Tag written/i)).toBeInTheDocument());
  });

  it("shows a missing-code message when the write link has no token", () => {
    window.history.pushState({}, "", "/tap/write/abc123");
    render(<TapWrite tagId="abc123" />);
    expect(screen.getByText(/Missing tag code/i)).toBeInTheDocument();
  });

  it("disables writing on a device without Web NFC", () => {
    (mocked.isNfcWriteSupported as ReturnType<typeof vi.fn>).mockReturnValue(false);
    render(<TapWrite tagId="abc123" token="tok9" />);
    expect(screen.getByRole("button", { name: /write to nfc tag/i })).toBeDisabled();
    expect(screen.getByText(/needs Chrome on Android/i)).toBeInTheDocument();
  });
});
