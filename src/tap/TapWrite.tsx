import React, { useState } from "react";
import { writeTapTag, isNfcWriteSupported } from "./nfc";
import { tokenFromHash } from "./api";

// The page a phone lands on after scanning the "write" QR from the console. It
// does NOT play anything — it writes the tag's tap URL onto a blank NFC tag via
// Web NFC (Chrome-on-Android). The tap URL (id + signed token) is reconstructed
// from this page's own path + #k= fragment, so no API/auth call is needed.
function tapUrlFor(tagId: string, token: string): string {
  const base = window.location.pathname.replace(/\/tap\/write.*$/, "");
  return `${window.location.origin}${base}/tap/t/${encodeURIComponent(tagId)}#k=${token}`;
}

function Wordmark() {
  return <span className="tap-wordmark"><span className="tap-wordmark__dot" aria-hidden="true" />Squeezebox Tap</span>;
}

export function TapWrite({ tagId, token }: { tagId: string; token?: string }) {
  const tok = token ?? tokenFromHash();
  const title = new URLSearchParams(window.location.search).get("t") || "this tag";
  const supported = isNfcWriteSupported();
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!tok) {
    return (
      <main className="tap-state">
        <div className="tap-state__card">
          <h1 className="tap-state__title">Missing tag code</h1>
          <p className="tap-state__body">This write link is incomplete. Re-open it from the Tap console.</p>
          <Wordmark />
        </div>
      </main>
    );
  }

  const url = tapUrlFor(tagId, tok);
  const doWrite = async () => {
    setBusy(true);
    setMsg({ text: "Hold a blank NFC tag flat against the back of your phone…" });
    const res = await writeTapTag(url);
    setBusy(false);
    setMsg(res.ok
      ? { ok: true, text: "Tag written! Tap it on your phone to play." }
      : { ok: false, text: res.reason === "unsupported" ? "This phone can't write NFC tags — use Chrome on Android." : `Couldn't write the tag: ${res.reason}. Try again.` });
  };

  return (
    <main className="tap-state">
      <div className="tap-state__card" style={{ maxWidth: "26rem" }}>
        <Wordmark />
        <div className="tap-state__icon" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 8a8 8 0 0 1 0 8M8 6a12 12 0 0 1 0 12M12 12h.01" /><circle cx="12" cy="12" r="9" /></svg>
        </div>
        <h1 className="tap-state__title">Write this tag</h1>
        <p className="tap-state__body">Make a blank NFC tag play <strong>{title}</strong>. Hold the tag to your phone and write it once — future taps just work.</p>
        <button className="tap-btn tap-btn--primary" onClick={doWrite} disabled={!supported || busy} style={{ width: "100%" }}>
          {busy ? "Writing…" : "Write to NFC tag"}
        </button>
        {!supported ? <div className="tap-alert tap-alert--err" style={{ width: "100%" }}>NFC writing needs Chrome on Android. Open this page there, or copy the link and write it from a phone that supports it.</div> : null}
        {msg ? <div className={`tap-alert ${msg.ok ? "tap-alert--ok" : "tap-alert--err"}`} role="status" style={{ width: "100%" }}>{msg.text}</div> : null}
        <button className="tap-btn tap-btn--ghost" onClick={() => navigator.clipboard?.writeText(url).then(() => setMsg({ ok: true, text: "Tap link copied." }), () => {})}>Copy tap link</button>
      </div>
    </main>
  );
}
