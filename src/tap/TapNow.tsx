import React, { useEffect, useState } from "react";
import { playTap, pausePlayer, nextTrack, tokenFromHash, type TapDisplay, type TapPlayResult } from "./api";

type TapState =
  | { phase: "loading" }
  | { phase: "playing"; debounced: boolean; display: TapDisplay; where: string; tapCount?: number }
  | { phase: "error"; reason: string; title: string; body: string; offerConsole?: boolean };

const ERRORS: Record<string, { title: string; body: string; offerConsole?: boolean }> = {
  unbound: { title: "This tag isn't set up yet", body: "Bind it to an album in the Tap console and it'll play the moment you tap.", offerConsole: true },
  "bad-token": { title: "Couldn't verify this tap", body: "The tag's code didn't match. Hold your phone to the tag again." },
  disabled: { title: "This tag is switched off", body: "Turn it back on from the Tap console to start playing it again.", offerConsole: true },
  speaker_offline: { title: "The speaker's offline", body: "Wake the Squeezebox, give it a moment, then tap again." },
  lms_error: { title: "Couldn't start playback", body: "The speaker didn't take the request. Try tapping once more." },
  network: { title: "Something went wrong", body: "Check your connection and tap the tag again." }
};

function mapResult(status: number, body: TapPlayResult): TapState {
  if (status >= 200 && status < 300 && body.ok) {
    const display = body.tag?.display ?? {};
    return {
      phase: "playing",
      debounced: Boolean(body.debounced),
      display: {
        title: display.title || body.nowPlaying?.title || "Now playing",
        artist: display.artist || body.nowPlaying?.artist || "",
        art: display.art ?? body.nowPlaying?.art ?? null
      },
      where: body.nowPlaying?.name || "your Squeezebox",
      tapCount: body.tag?.tapCount
    };
  }
  const reason = body.reason || "network";
  const e = ERRORS[reason] || ERRORS.network;
  return { phase: "error", reason, ...e };
}

function Wordmark() {
  return (
    <span className="tap-wordmark"><span className="tap-wordmark__dot" aria-hidden="true" />Squeezebox Tap</span>
  );
}

function Art({ display, skeleton }: { display?: TapDisplay; skeleton?: boolean }) {
  const [broken, setBroken] = useState(false);
  const src = display?.art;
  return (
    <div className={`tap-art${skeleton ? " tap-art--skeleton" : ""}`}>
      {src && !broken ? (
        <img src={src} alt={display?.title ? `${display.title} cover` : "Album cover"} onError={() => setBroken(true)} />
      ) : (
        <div className="tap-art__fallback" aria-hidden="true">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="19" cy="16" r="3" /></svg>
        </div>
      )}
    </div>
  );
}

export function TapNow({
  tagId,
  token,
  play = playTap,
  demo
}: {
  tagId: string;
  token?: string;
  play?: typeof playTap;
  demo?: TapState;
}) {
  const [state, setState] = useState<TapState>(demo ?? { phase: "loading" });
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (demo) return;
    let alive = true;
    const t = token ?? tokenFromHash();
    play(tagId, t)
      .then(({ status, body }) => {
        if (alive) setState(mapResult(status, body));
      })
      .catch(() => {
        if (alive) setState({ phase: "error", reason: "network", ...ERRORS.network });
      });
    return () => {
      alive = false;
    };
  }, [tagId, token, play, demo]);

  if (state.phase === "loading") {
    return (
      <main className="tap-now" aria-busy="true">
        <header className="tap-now__top"><Wordmark /><span className="tap-pill"><span className="tap-spinner" aria-hidden="true" />Starting…</span></header>
        <section className="tap-now__stage">
          <Art skeleton />
          <div className="tap-now__meta" aria-hidden="true">
            <span className="tap-now__title" style={{ color: "var(--faint)" }}>Reading your tag…</span>
          </div>
        </section>
        <footer className="tap-now__bottom">Tap to play — bridging your records and your speaker.</footer>
      </main>
    );
  }

  if (state.phase === "error") {
    return (
      <main className="tap-state">
        <div className="tap-state__card">
          <div className="tap-state__icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          </div>
          <h1 className="tap-state__title">{state.title}</h1>
          <p className="tap-state__body">{state.body}</p>
          {state.offerConsole ? <a className="tap-btn tap-btn--primary" href="/tap/link">Open the Tap console</a> : null}
          <Wordmark />
        </div>
      </main>
    );
  }

  // playing
  return (
    <main className="tap-now">
      <header className="tap-now__top">
        <Wordmark />
        <span className="tap-pill tap-pill--live"><span className="tap-pill__beat" aria-hidden="true" />{state.debounced ? "Already playing" : "Now playing"}</span>
      </header>

      <section className="tap-now__stage">
        <Art display={state.display} />
        <div className="tap-now__meta">
          <h1 className="tap-now__title">{state.display.title}</h1>
          {state.display.artist ? <p className="tap-now__artist">{state.display.artist}</p> : null}
          <div className="tap-now__where"><span className="tap-pill">Playing on {state.where}</span></div>
        </div>

        <div className="tap-now__controls">
          <button
            className="tap-btn tap-btn--icon tap-btn--primary"
            aria-label={paused ? "Resume" : "Pause"}
            onClick={() => { setPaused((p) => !p); (paused ? fetch("/api/player/play", { method: "POST" }) : pausePlayer()).catch(() => {}); }}
          >
            {paused ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
            )}
          </button>
          <button className="tap-btn tap-btn--icon" aria-label="Skip to next" onClick={() => { nextTrack().catch(() => {}); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5l9 7-9 7zM16 5h3v14h-3z" /></svg>
          </button>
        </div>
      </section>

      <footer className="tap-now__bottom">
        {typeof state.tapCount === "number" ? <span>Tapped {state.tapCount}×</span> : null}
      </footer>
    </main>
  );
}
