import React, { useEffect, useRef, useState } from "react";
import { playTap, pausePlayer, nextTrack, prevTrack, setTapVolume, tapVolume, tokenFromHash, artSrc, nowPlayingNow, type TapDisplay, type TapPlayResult, type NowPlaying } from "./api";

type TapState =
  | { phase: "loading" }
  | { phase: "playing"; debounced: boolean; display: TapDisplay; where: string; tapCount?: number }
  | { phase: "password"; error?: boolean }
  | { phase: "error"; reason: string; title: string; body: string; offerConsole?: boolean };

const ERRORS: Record<string, { title: string; body: string; offerConsole?: boolean }> = {
  unbound: { title: "This tag isn't set up yet", body: "Bind it to an album in the Tap console and it'll play the moment you tap.", offerConsole: true },
  "bad-token": { title: "Couldn't verify this tap", body: "The tag's code didn't match. Hold your phone to the tag again." },
  "bad-cmac": { title: "Couldn't verify this tap", body: "This secure tag's code didn't check out. Hold your phone to the tag again." },
  replay: { title: "This tap was already used", body: "Secure tags only work once per tap — hold your phone to the tag again." },
  disabled: { title: "This tag is switched off", body: "Turn it back on from the Tap console to start playing it again.", offerConsole: true },
  closed: { title: "The jukebox is paused", body: "Tap is closed right now. Open it from the Tap console to play again.", offerConsole: true },
  speaker_offline: { title: "The speaker's offline", body: "Wake the Squeezebox, give it a moment, then tap again." },
  lms_error: { title: "Couldn't start playback", body: "The speaker didn't take the request. Try tapping once more." },
  network: { title: "Something went wrong", body: "Check your connection and tap the tag again." }
};

function mapResult(status: number, body: TapPlayResult, opts: { passwordTried?: boolean } = {}): TapState {
  if (status >= 200 && status < 300 && body.ok) {
    // Visual toggle tag: no song — report the screen state instead.
    if (body.visual) {
      const v = body.visual;
      return {
        phase: "playing",
        debounced: Boolean(body.debounced),
        display: {
          title: v.on ? "Visuals on" : "Visuals off",
          artist: v.on
            ? (v.mirroring ? `Mirroring ${v.title || "what's playing"}` : (v.note || "Play something, then tap again"))
            : "Tap again to turn visuals back on",
          art: null
        },
        where: "the VPS screen",
        tapCount: body.tag?.tapCount
      };
    }
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
  if (body.reason === "password") return { phase: "password", error: opts.passwordTried };
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
  const src = artSrc(display?.art);
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

// Speaker volume slider for the now-playing screen — anyone holding the room's
// phone can nudge it without opening the console. Reads the live volume, sets it
// optimistically, and re-syncs when idle (so another tapper's change shows up).
function VolumeControl() {
  const [vol, setVol] = useState<number | null>(null);
  const touchedAt = useRef(0);
  const lastNonZero = useRef(75);

  useEffect(() => {
    let alive = true;
    const load = () => tapVolume().then((v) => { if (alive && v != null && Date.now() - touchedAt.current > 4000) { setVol(v); if (v > 0) lastNonZero.current = v; } }, () => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const change = (v: number) => { touchedAt.current = Date.now(); setVol(v); if (v > 0) lastNonZero.current = v; setTapVolume(v).catch(() => {}); };
  const v = vol ?? 60;
  const muted = v === 0;

  return (
    <div className="tap-now__volume">
      <button type="button" className="tap-vol-btn" aria-label={muted ? "Unmute" : "Mute"} onClick={() => change(muted ? lastNonZero.current : 0)}>
        {muted ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="m22 9-6 6M16 9l6 6" /></svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" /></svg>
        )}
      </button>
      <input
        type="range" min={0} max={100} step={1} value={v} aria-label="Volume"
        className="tap-now__volume-slider"
        onChange={(e) => change(Number(e.target.value))}
        style={{ ["--vol" as string]: `${v}%` } as React.CSSProperties}
      />
      <span className="tap-now__volume-val">{vol == null ? "—" : `${vol}%`}</span>
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
  const [pwd, setPwd] = useState("");
  const pollRef = useRef<number | null>(null);

  // One tap, one song: after we play, we replaceState the URL to `?np=1` (and drop
  // the #k= token), so a refresh or tab-reopen lands here and shows now-playing
  // instead of replaying. A genuine NFC re-tap opens the tag's `#k=` URL fresh
  // (no np flag), so it still plays. The flag — not sessionStorage — is the
  // signal, precisely so re-tapping the physical tag always works.
  const isRevisit = (() => {
    try { return new URLSearchParams(window.location.search).get("np") === "1"; } catch { return false; }
  })();

  // What to show on the "playing" screen. For a bound song/album/playlist the
  // tag's OWN display is the accurate metadata for what you tapped — use it (the
  // live LMS now-playing lags a tap and, for a locally-cached first song, is
  // thinner). Only Surprise tags (and a revisit with no seed) drive from the live
  // now-playing, since the tag itself has no fixed song.
  const showNowPlaying = (seed?: TapDisplay, where = "your Squeezebox", tapCount?: number, debounced = false, kind = "") => {
    const liveDriven = kind === "discover" || !seed?.title;
    if (!liveDriven) {
      setState({ phase: "playing", debounced, display: { title: seed!.title, artist: seed?.artist || "", art: seed?.art ?? null }, where, tapCount });
      return;
    }
    const render = (np: NowPlaying | null) => setState({
      phase: "playing",
      debounced,
      display: {
        title: np?.title || seed?.title || "Now playing",
        artist: np?.artist || seed?.artist || "",
        art: np?.art ?? seed?.art ?? null
      },
      where,
      tapCount
    });
    nowPlayingNow().then(render, () => render(null));
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => { nowPlayingNow().then((np) => { if (np) render(np); }, () => {}); }, 5000);
  };

  // Forward the static token (#k= fragment) AND, for NTAG 424 SUN tags, the
  // fresh ?ctr=&cmac= from the URL query, plus an optional password.
  const doPlay = (password?: string) => {
    const t = token ?? tokenFromHash();
    const params = new URLSearchParams(window.location.search);
    return play(tagId, t, { ctr: params.get("ctr"), cmac: params.get("cmac"), password })
      .then(({ status, body }) => {
        const mapped = mapResult(status, body, { passwordTried: Boolean(password) });
        if (mapped.phase === "playing") {
          // Mark this open as consumed so a refresh won't replay.
          try { window.history.replaceState(null, "", `${window.location.pathname}?np=1`); } catch { /* ignore */ }
          showNowPlaying(mapped.display, mapped.where, mapped.tapCount, mapped.debounced, body.tag?.kind);
        } else {
          setState(mapped);
        }
      })
      .catch(() => setState({ phase: "error", reason: "network", ...ERRORS.network }));
  };

  useEffect(() => {
    if (demo) return;
    // A revisit (refresh/reopen of the post-play URL) shows what's on — never replays.
    if (isRevisit) showNowPlaying();
    else doPlay();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, token, demo]);

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

  if (state.phase === "password") {
    return (
      <main className="tap-state">
        <form className="tap-state__card" onSubmit={(e) => { e.preventDefault(); setState({ phase: "loading" }); doPlay(pwd); }}>
          <div className="tap-state__icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          </div>
          <h1 className="tap-state__title">Password required</h1>
          <p className="tap-state__body">Enter the Tap password to play this.</p>
          <div className="tap-field" style={{ width: "100%" }}>
            <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Password" aria-label="Tap password" autoFocus />
          </div>
          {state.error ? <div className="tap-alert tap-alert--err" role="alert" style={{ width: "100%" }}>That password didn't work — try again.</div> : null}
          <button className="tap-btn tap-btn--primary" type="submit" disabled={!pwd} style={{ width: "100%" }}>Play</button>
          <Wordmark />
        </form>
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
          <button className="tap-btn tap-btn--icon" aria-label="Previous" onClick={() => { prevTrack().catch(() => {}); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18 5l-9 7 9 7zM8 5H5v14h3z" /></svg>
          </button>
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

        <VolumeControl />
      </section>

      <footer className="tap-now__bottom">
        {typeof state.tapCount === "number" ? <span>Tapped {state.tapCount}×</span> : null}
      </footer>
    </main>
  );
}
