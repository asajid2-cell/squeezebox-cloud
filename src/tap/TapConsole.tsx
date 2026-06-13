import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  getSession,
  apiLogin,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  searchLibrary,
  spotifySearch,
  spotifySearchCategories,
  albumTracks,
  getAnalytics,
  getSettings,
  saveSettings,
  exportBackup,
  importBackup,
  artSrc,
  nowPlayingNow,
  type TapTag,
  type SearchItem,
  type TapAnalytics,
  type TapSettings,
  type TapSession
} from "./api";
import { writeTapTag, isNfcWriteSupported } from "./nfc";

// Build a tag's public URL exactly as the server does (token in the #fragment),
// derived from where this console is served so copy/QR match the written tag.
function tapUrlFor(tagId: string, token: string): string {
  const base = window.location.pathname.replace(/\/tap\/link.*$/, "");
  return `${window.location.origin}${base}/tap/t/${tagId}#k=${token}`;
}

// The phone-facing WRITE page (what the console QR points to): scanning it opens
// the writer (Web NFC), it never plays.
function writeUrlFor(tagId: string, token: string, title?: string): string {
  const base = window.location.pathname.replace(/\/tap\/link.*$/, "");
  const t = title ? `?t=${encodeURIComponent(title)}` : "";
  return `${window.location.origin}${base}/tap/write/${tagId}${t}#k=${token}`;
}

function Wordmark() {
  return <span className="tap-wordmark"><span className="tap-wordmark__dot" aria-hidden="true" />Tap</span>;
}

function Art({ src, alt, size = 56 }: { src?: string | null; alt: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const resolved = artSrc(src);
  return (
    <div className="tap-card__art" style={{ width: size, height: size }}>
      {resolved && !broken ? (
        <img src={resolved} alt={alt} onError={() => setBroken(true)} />
      ) : (
        <div className="tap-art__fallback" aria-hidden="true">
          <svg width={size * 0.45} height={size * 0.45} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="19" cy="16" r="3" /></svg>
        </div>
      )}
    </div>
  );
}

function searchKey(item: SearchItem): string {
  return String(item.uri || item.id || `${item.kind || ""}|${item.title || ""}|${item.artist || ""}`).toLowerCase();
}

function mergeSearchItems(first: SearchItem[] = [], second: SearchItem[] = []): SearchItem[] {
  const seen = new Set<string>();
  const merged: SearchItem[] = [];
  for (const item of [...first, ...second]) {
    const key = searchKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// ---------- sign-in card (our UI; auth is hl-auth SSO, signed in inline) ----------
function SignInCard({ session, onSignedIn }: { session: TapSession | null; onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError("");
    const r = await apiLogin(username.trim(), password, session?.loginUrl || "/auth/login");
    if (r.ok) {
      setPassword("");
      onSignedIn();            // re-read the session → the console takes over
    } else {
      setError(r.error || "Sign-in failed. Check your username and password.");
      setBusy(false);
    }
  };

  // Full Harmonizer sign-in page — for invite claims, password reset, and account
  // actions that don't belong inline. Carries ?next back to this console.
  const fullLoginHref = (() => {
    const base = session?.loginUrl || "/auth/login";
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    return `${base}${base.includes("?") ? "&" : "?"}next=${next}`;
  })();

  return (
    <div className="tap-state">
      <form className="tap-state__card tap-signin" onSubmit={submit} aria-label="Sign in">
        <Wordmark />
        <h1 className="tap-state__title">Tap console</h1>
        <p className="tap-state__body">Sign in with your Harmonizer account to bind tags, write them, and manage your collection.</p>

        <label className="tap-signin__field">
          <span className="tap-signin__label">Username</span>
          <div className="tap-field">
            <input
              name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off"
              spellCheck={false} autoFocus value={username}
              onChange={(e) => setUsername(e.target.value)} aria-label="Username"
            />
          </div>
        </label>

        <label className="tap-signin__field">
          <span className="tap-signin__label">Password</span>
          <div className="tap-field">
            <input
              name="password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password"
            />
          </div>
        </label>

        {error ? <p className="tap-signin__error" role="alert">{error}</p> : null}

        <button className="tap-btn tap-btn--primary tap-signin__submit" type="submit" disabled={busy}>
          {busy ? <><span className="tap-spinner" aria-hidden="true" /> Signing in…</> : "Sign in"}
        </button>

        <a className="tap-signin__alt" href={fullLoginHref}>Invite, password reset, or trouble signing in →</a>
      </form>
    </div>
  );
}

// ---------- write flow ----------
function WriteView({ onCreated, rebind, onDone }: { onCreated: () => void; rebind?: { tagId: string; title?: string } | null; onDone?: () => void }) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"spotify" | "library">("spotify");
  const [albums, setAlbums] = useState<SearchItem[]>([]);
  const [tracks, setTracks] = useState<SearchItem[]>([]);
  const [artists, setArtists] = useState<SearchItem[]>([]);
  const [playlists, setPlaylists] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState(false);
  const [picked, setPicked] = useState<SearchItem | null>(null);
  const [browseTracks, setBrowseTracks] = useState<SearchItem[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [created, setCreated] = useState<{ tagId: string; token: string; url: string; display: SearchItem } | null>(null);
  // When re-pointing an existing tag, success is just a confirmation — the
  // physical sticker (id + token) is unchanged, so there's nothing to re-write.
  const [rebound, setRebound] = useState<SearchItem | null>(null);
  const [writeState, setWriteState] = useState<{ ok?: boolean; msg: string } | null>(null);
  const [error, setError] = useState("");
  const searchRun = useRef(0);

  const runSearch = async (e?: React.FormEvent, overrideQuery?: string) => {
    e?.preventDefault();
    const term = (overrideQuery ?? query).trim();
    if (!term) return;
    if (overrideQuery !== undefined) setQuery(overrideQuery);
    const run = searchRun.current + 1;
    searchRun.current = run;
    setSearching(true);
    setCategoryLoading(source === "spotify");
    setCategoryError(false);
    setError("");
    setPicked(null);
    setCreated(null);
    setAlbums([]);
    setTracks([]);
    setArtists([]);
    setPlaylists([]);
    try {
      if (source === "spotify") {
        const categories = spotifySearchCategories(term)
          .then((next) => {
            if (searchRun.current !== run) return;
            setAlbums((current) => mergeSearchItems(current, next.albums || []));
            setArtists(next.artists || []);
            setPlaylists(next.playlists || []);
          })
          .catch(() => {
            if (searchRun.current === run) setCategoryError(true);
          })
          .finally(() => {
            if (searchRun.current === run) setCategoryLoading(false);
          });
        const { groups, results } = await spotifySearch(term);
        if (searchRun.current !== run) return;
        setAlbums((current) => mergeSearchItems(current, groups?.albums || []));
        setTracks(groups?.tracks || results || []);
        setArtists((current) => current.length ? current : groups?.artists || []);
        setPlaylists((current) => current.length ? current : groups?.playlists || []);
        void categories;
      } else {
        const results = await searchLibrary(term);
        if (searchRun.current !== run) return;
        setAlbums([]);
        setTracks(results);
      }
    } catch {
      setError("Search failed — try again.");
    } finally {
      if (searchRun.current === run) setSearching(false);
      if (source !== "spotify" && searchRun.current === run) setCategoryLoading(false);
    }
  };

  const displayOf = (item: SearchItem, kind: string): SearchItem => ({ title: item.title, artist: item.artist, art: item.art ?? null, kind: kind as SearchItem["kind"] });

  const create = async (payload: Record<string, unknown>, display: SearchItem) => {
    setError("");
    // Re-point mode: PUT the new target onto the EXISTING tag (same id + token),
    // so the physical sticker keeps working and plays the new thing.
    if (rebind) {
      const res = await updateTag(rebind.tagId, payload);
      if (res.status >= 200 && res.status < 300 && res.body?.tag) {
        setRebound(display);
        onCreated();
      } else {
        setError(res.body?.error || "Couldn't re-point the tag.");
      }
      return;
    }
    const res = await createTag(payload);
    if (res.status >= 200 && res.status < 300 && res.body?.tag) {
      const tg = res.body.tag;
      const tok = res.body.token;
      setCreated({ tagId: tg.tagId, token: tok, url: tapUrlFor(tg.tagId, tok), display });
      setWriteState(null);
      onCreated();
    } else {
      setError(res.body?.error || "Couldn't create the binding.");
    }
  };

  // Bind the song currently on the Squeezebox straight onto a (new) tag — no
  // search needed. Spotify now-playing ids arrive as spotify://track: ; normalize
  // to the colon form the binder/search use.
  const bindNowPlaying = async () => {
    setError("");
    const np = await nowPlayingNow();
    const rawRef = String(np?.uri || np?.id || "");
    if (!np || !rawRef) { setError("Nothing is playing on the Squeezebox right now."); return; }
    const track: SearchItem = { title: np.title, artist: np.artist, album: np.album, art: np.art ?? null, source: np.source, kind: "track" };
    if (/^spotify/i.test(rawRef)) track.uri = rawRef.replace(/^spotify:\/\//i, "spotify:");
    else track.uri = rawRef; // local file uri/path — the server validates playability
    await create({ intent: "track", track, display: displayOf(track, "track"), label: np.title || "" }, track);
  };

  const bindAlbumTop = (album: SearchItem) =>
    create({ intent: "album-from-top", source: "spotify", albumUri: album.uri, display: displayOf(album, "album"), label: album.title || "" }, album);

  const bindTrack = (track: SearchItem) =>
    create({ intent: "track", track, display: displayOf(track, "track"), label: track.title || "" }, track);

  const bindAlbumFromTrack = (album: SearchItem, track: SearchItem, index: number) =>
    create(
      { intent: "album-from-track", source: "spotify", albumUri: album.uri, startIndex: index, display: { title: track.title, artist: track.artist, art: track.art ?? album.art ?? null, kind: "album-from-track" }, label: `${track.title} — ${album.title}` },
      { ...track, art: track.art ?? album.art }
    );

  const bindPlaylist = (playlist: SearchItem) =>
    create({ intent: "playlist", source: "spotify", playlistUri: playlist.uri, display: displayOf(playlist, "playlist"), label: playlist.title || "" }, playlist);

  // A "surprise me" tag — no fixed target; every tap pulls a fresh taste-seeded
  // pick at play time. The search box, if filled, themes it (e.g. "lo-fi").
  const bindDiscover = () => {
    const seed = query.trim();
    const title = seed ? `Surprise · ${seed}` : "Surprise me";
    create(
      { intent: "discover", source: "spotify", seed: seed || undefined, display: { title, artist: "Fresh picks each tap", art: null, kind: "discover" }, label: title },
      { title, artist: "Fresh picks each tap", art: null } as SearchItem
    );
  };

  const openAlbumBrowse = async (album: SearchItem) => {
    setPicked(album);
    setBrowseTracks(null);
    setBrowsing(true);
    try {
      setBrowseTracks(await albumTracks(album));
    } catch {
      setBrowseTracks([]);
    } finally {
      setBrowsing(false);
    }
  };

  const doWrite = async () => {
    if (!created) return;
    setWriteState({ msg: "Hold a tag to your phone…" });
    const res = await writeTapTag(created.url);
    setWriteState(res.ok ? { ok: true, msg: "Tag written. Tap it to play." } : { ok: false, msg: res.reason === "unsupported" ? "This device can't write tags — use the QR or copy below from an Android phone." : `Couldn't write: ${res.reason}` });
  };

  if (rebound) {
    return (
      <section className="tap-main" aria-label="Re-pointed">
        <header className="tap-head">
          <span className="tap-head__eyebrow">Re-pointed</span>
          <h1 className="tap-head__title">Tag now plays {rebound.title}</h1>
          <p className="tap-head__sub">The sticker is unchanged — same tag, new music. Tap it and it'll play <strong>{rebound.title}</strong>.</p>
        </header>
        <div className="tap-card" style={{ maxWidth: "36rem" }}>
          <div className="tap-card__row">
            <Art src={rebound.art} alt={rebound.title || "cover"} />
            <div className="tap-card__text">
              <span className="tap-card__title">{rebound.title}</span>
              <span className="tap-card__sub">{rebound.artist}</span>
            </div>
          </div>
          <div className="tap-card__actions">
            <button className="tap-btn tap-btn--primary" onClick={() => onDone?.()}>Done</button>
          </div>
        </div>
      </section>
    );
  }

  if (created) {
    return (
      <section className="tap-main" aria-label="Write tag">
        <header className="tap-head">
          <span className="tap-head__eyebrow">Step 3 · Write</span>
          <h1 className="tap-head__title">Burn it onto a tag</h1>
          <p className="tap-head__sub">Write it once and future taps play <strong>{created.display.title}</strong>. On an Android phone, tap “Write to NFC tag” below. On a computer, scan the QR to open the writer on your phone.</p>
        </header>
        <div className="tap-card" style={{ maxWidth: "36rem" }}>
          <div className="tap-card__row">
            <Art src={created.display.art} alt={created.display.title || "cover"} />
            <div className="tap-card__text">
              <span className="tap-card__title">{created.display.title}</span>
              <span className="tap-card__sub">{created.display.artist}</span>
            </div>
          </div>
          <div className="tap-card__actions">
            <button className="tap-btn tap-btn--primary" onClick={doWrite} disabled={!isNfcWriteSupported()}>Write to NFC tag</button>
            <button className="tap-btn" onClick={() => navigator.clipboard?.writeText(created.url).then(() => setWriteState({ ok: true, msg: "Link copied." }), () => {})}>Copy link</button>
            <button className="tap-btn tap-btn--ghost" onClick={() => setCreated(null)}>Bind another</button>
          </div>
          {!isNfcWriteSupported() ? <div className="tap-alert tap-alert--err">NFC writing needs Chrome on Android. Use the QR code or copy the link to write from a phone that supports it.</div> : null}
          {writeState ? <div className={`tap-alert ${writeState.ok ? "tap-alert--ok" : "tap-alert--err"}`} role="status">{writeState.msg}</div> : null}
          <div style={{ display: "grid", gap: "8px", justifyItems: "center", padding: "8px 0" }}>
            <div style={{ background: "#fff", padding: 12, borderRadius: 12 }}><QRCodeSVG value={writeUrlFor(created.tagId, created.token, created.display.title)} size={148} /></div>
            <small>On your phone? Scan to open the writer and burn the tag there — it won't play.</small>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="tap-main" aria-label={rebind ? "Re-point a tag" : "Write a tag"}>
      <header className="tap-head">
        <span className="tap-head__eyebrow">{rebind ? "Re-point" : "Step 1 · Find the music"}</span>
        <h1 className="tap-head__title">{rebind ? `Re-point ${rebind.title || "this tag"}` : "Write a tag"}</h1>
        <p className="tap-head__sub">{rebind ? "Pick the new album, song, playlist, or surprise this tag should play — the sticker stays the same." : "Search for an album or song, choose how it plays, then write it to a tag."}</p>
        <div className="tap-head__actions" style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="tap-btn" onClick={bindNowPlaying}>{rebind ? "Use what's playing now" : "Bind what's playing now"}</button>
          {rebind ? <button type="button" className="tap-btn tap-btn--ghost" onClick={() => onDone?.()}>Cancel</button> : null}
        </div>
      </header>

      <form className="tap-search" onSubmit={runSearch} role="search">
        <div className="tap-field">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search albums & songs…" aria-label="Search music" />
        </div>
        <div className="tap-search__row">
          <div className="tap-toggle" role="group" aria-label="Source">
            <button type="button" aria-pressed={source === "spotify"} onClick={() => setSource("spotify")}>Spotify</button>
            <button type="button" aria-pressed={source === "library"} onClick={() => setSource("library")}>Library</button>
          </div>
          <button className="tap-btn tap-btn--primary" type="submit" disabled={searching || !query.trim()}>{searching ? "Searching…" : "Search"}</button>
        </div>
      </form>

      {error ? <div className="tap-alert tap-alert--err" role="alert">{error}</div> : null}

      <div className="tap-card tap-card--surprise" style={{ maxWidth: "44rem" }}>
        <div className="tap-card__row">
          <div className="tap-art tap-art--surprise" aria-hidden="true" style={{ width: 56, height: 56, display: "grid", placeItems: "center", fontSize: 26 }}>✨</div>
          <div className="tap-card__text">
            <span className="tap-card__title">Surprise tag</span>
            <span className="tap-card__sub">Plays something fresh every tap, from your taste{query.trim() ? ` · seeded by “${query.trim()}”` : ""}.</span>
          </div>
          <button className="tap-btn tap-btn--primary" style={{ marginLeft: "auto" }} onClick={bindDiscover}>Create</button>
        </div>
      </div>

      {categoryLoading ? <div className="tap-card__meta"><span className="tap-spinner" aria-hidden="true" /> Loading Spotify albumsâ€¦</div> : null}
      {categoryError ? <div className="tap-alert tap-alert--err" role="status">Songs loaded, but Spotify albums did not. Try the search again.</div> : null}

      {picked && picked.kind === "album" ? (
        <div className="tap-card" style={{ maxWidth: "44rem" }}>
          <div className="tap-card__row">
            <Art src={picked.art} alt={picked.title || "album"} />
            <div className="tap-card__text"><span className="tap-card__title">{picked.title}</span><span className="tap-card__sub">{picked.artist} · pick the song to start from</span></div>
            <button className="tap-btn tap-btn--ghost" style={{ marginLeft: "auto" }} onClick={() => { setPicked(null); setBrowseTracks(null); }}>Back</button>
          </div>
          {browsing ? <div className="tap-card__meta"><span className="tap-spinner" aria-hidden="true" /> Loading album…</div> : null}
          {browseTracks && browseTracks.length === 0 ? <div className="tap-alert tap-alert--err">Couldn't load this album's tracks.</div> : null}
          {browseTracks && browseTracks.length > 0 ? (
            <ol style={{ display: "grid", gap: "4px", margin: 0, padding: 0, listStyle: "none" }}>
              {browseTracks.map((t, i) => (
                <li key={`${t.uri || t.id || i}`}>
                  <button className="tap-btn tap-btn--ghost" style={{ width: "100%", justifyContent: "flex-start", gap: 12 }} onClick={() => bindAlbumFromTrack(picked, t, i)}>
                    <span style={{ color: "var(--faint)", minWidth: 24 }}>{i + 1}</span>
                    <span style={{ overflowWrap: "anywhere", textAlign: "left" }}>{t.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}

      {!picked && albums.length > 0 ? (
        <div>
          <h2 className="tap-head__eyebrow" style={{ marginBottom: 12 }}>Albums</h2>
          <div className="tap-grid">
            {albums.map((a, i) => (
              <div className="tap-card" key={`al-${a.uri || a.id || i}`}>
                <div className="tap-card__row">
                  <Art src={a.art} alt={a.title || "album"} />
                  <div className="tap-card__text"><span className="tap-card__title">{a.title}</span><span className="tap-card__sub">{a.artist}</span></div>
                </div>
                <div className="tap-card__actions">
                  <button className="tap-btn tap-btn--primary" onClick={() => bindAlbumTop(a)}>Whole album</button>
                  <button className="tap-btn" onClick={() => openAlbumBrowse(a)}>Start at a song…</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!picked && tracks.length > 0 ? (
        <div>
          <h2 className="tap-head__eyebrow" style={{ marginBottom: 12 }}>Songs</h2>
          <div className="tap-grid">
            {tracks.map((t, i) => (
              <div className="tap-card" key={`tr-${t.uri || t.id || i}`}>
                <div className="tap-card__row">
                  <Art src={t.art} alt={t.title || "song"} />
                  <div className="tap-card__text"><span className="tap-card__title">{t.title}</span><span className="tap-card__sub">{t.artist}{t.album ? ` · ${t.album}` : ""}</span></div>
                </div>
                <div className="tap-card__actions"><button className="tap-btn tap-btn--primary" onClick={() => bindTrack(t)}>Just this song</button></div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!picked && source === "spotify" && artists.length > 0 ? (
        <div>
          <h2 className="tap-head__eyebrow" style={{ marginBottom: 12 }}>Artists</h2>
          <div className="tap-grid">
            {artists.map((a, i) => (
              <div className="tap-card" key={`ar-${a.uri || a.id || i}`}>
                <div className="tap-card__row">
                  <Art src={a.art} alt={a.title || "artist"} />
                  <div className="tap-card__text"><span className="tap-card__title">{a.title}</span><span className="tap-card__sub">Artist</span></div>
                </div>
                <div className="tap-card__actions"><button className="tap-btn" onClick={() => a.title && runSearch(undefined, a.title)}>Search albums</button></div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!picked && source === "spotify" && playlists.length > 0 ? (
        <div>
          <h2 className="tap-head__eyebrow" style={{ marginBottom: 12 }}>Playlists</h2>
          <div className="tap-grid">
            {playlists.map((p, i) => (
              <div className="tap-card" key={`pl-${p.uri || p.id || i}`}>
                <div className="tap-card__row">
                  <Art src={p.art} alt={p.title || "playlist"} />
                  <div className="tap-card__text"><span className="tap-card__title">{p.title}</span><span className="tap-card__sub">{p.artist || "Playlist"}</span></div>
                </div>
                <div className="tap-card__actions"><button className="tap-btn tap-btn--primary" onClick={() => bindPlaylist(p)}>Whole playlist</button></div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!searching && !categoryLoading && !picked && albums.length === 0 && tracks.length === 0 && artists.length === 0 && playlists.length === 0 && query ? (
        <div className="tap-empty"><strong>No matches.</strong><span>Try another album or song name.</span></div>
      ) : null}
    </section>
  );
}

// Inline editor for a tag's shown title/artist, your private label, and a cover
// override — handy when Spotify's art is wrong or you want a friendlier name.
function TagEditForm({ tag, onSaved, onCancel }: { tag: TapTag; onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(tag.display?.title || "");
  const [artist, setArtist] = useState(tag.display?.artist || "");
  const [label, setLabel] = useState(tag.label || "");
  const [art, setArt] = useState(tag.display?.art || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    await updateTag(tag.tagId, { display: { ...tag.display, title: title.trim(), artist: artist.trim(), art: art.trim() || null }, label: label.trim() });
    setBusy(false);
    onSaved();
  };

  const field = (lbl: string, value: string, set: (v: string) => void, placeholder?: string) => (
    <label className="tap-signin__field">
      <span className="tap-signin__label">{lbl}</span>
      <div className="tap-field"><input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} aria-label={`${tag.display?.title || "tag"} ${lbl}`} /></div>
    </label>
  );

  return (
    <div className="tap-edit" style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {field("Title", title, setTitle)}
      {field("Artist", artist, setArtist)}
      {field("Label (your note)", label, setLabel)}
      {field("Cover image URL", art, setArt, "https://… (blank = icon)")}
      <div className="tap-card__actions">
        <button className="tap-btn tap-btn--primary" onClick={save} disabled={busy}>Save</button>
        <button className="tap-btn tap-btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

// ---------- tags manager ----------
function TagsView({ refreshKey, onRebind }: { refreshKey: number; onRebind: (t: TapTag) => void }) {
  const [tags, setTags] = useState<TapTag[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");

  const load = useCallback(async () => {
    setTags(await listTags());
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tags || []).filter((t) => !f || `${t.display?.title} ${t.display?.artist} ${t.label}`.toLowerCase().includes(f));
  }, [tags, filter]);

  const toggle = async (t: TapTag) => { setBusyId(t.tagId); await updateTag(t.tagId, { enabled: !t.enabled }); await load(); setBusyId(""); };
  const remove = async (t: TapTag) => { if (!confirm(`Delete the tag for "${t.display?.title || t.tagId}"?`)) return; setBusyId(t.tagId); await deleteTag(t.tagId); await load(); setBusyId(""); };
  const copy = (t: TapTag) => { if (t.token) navigator.clipboard?.writeText(tapUrlFor(t.tagId, t.token)).catch(() => {}); };
  const setPolicy = async (t: TapTag, patch: { playMode?: "replace" | "queue"; volume?: number | null; resume?: boolean }) => {
    setBusyId(t.tagId);
    await updateTag(t.tagId, { policy: { playMode: t.policy?.playMode || "replace", volume: t.policy?.volume ?? null, resume: t.policy?.resume ?? false, ...patch } });
    await load();
    setBusyId("");
  };

  return (
    <section className="tap-main" aria-label="Tags">
      <header className="tap-head">
        <span className="tap-head__eyebrow">Your tags</span>
        <h1 className="tap-head__title">Tag collection</h1>
        <p className="tap-head__sub">Re-point, pause, or remove any tag — the sticker never changes, only what it means here.</p>
      </header>

      {tags && tags.length > 0 ? (
        <div className="tap-field" style={{ maxWidth: "30rem" }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tags…" aria-label="Filter tags" />
        </div>
      ) : null}

      {tags === null ? <div className="tap-card__meta"><span className="tap-spinner" aria-hidden="true" /> Loading tags…</div> : null}

      {tags && tags.length === 0 ? (
        <div className="tap-empty"><strong>No tags yet.</strong><span>Head to “Write a tag” to bind your first album.</span></div>
      ) : null}

      {shown.length > 0 ? (
        <div className="tap-grid">
          {shown.map((t) => (
            <div className="tap-card" key={t.tagId} style={{ opacity: t.enabled ? 1 : 0.6 }}>
              <div className="tap-card__row">
                <Art src={t.display?.art} alt={t.display?.title || "tag"} />
                <div className="tap-card__text">
                  <span className="tap-card__title">{t.display?.title || "Untitled tag"}</span>
                  <span className="tap-card__sub">{t.display?.artist}</span>
                </div>
              </div>
              <div className="tap-card__meta">
                <span>{t.playSpec?.kind === "album-from-track" ? "Album from a song"
                  : t.playSpec?.kind === "album-from-top" ? "Whole album"
                  : t.playSpec?.kind === "playlist" ? "Playlist"
                  : t.playSpec?.kind === "discover" ? "Surprise"
                  : "Single song"}</span>
                <span>Tapped {t.tapCount ?? 0}×</span>
                {!t.enabled ? <span style={{ color: "var(--amber)" }}>Off</span> : null}
              </div>
              <div className="tap-card__behavior">
                {t.playSpec?.kind === "track" ? (
                  <div className="tap-toggle" role="group" aria-label="Play mode">
                    <button type="button" aria-pressed={(t.policy?.playMode || "replace") === "replace"} onClick={() => setPolicy(t, { playMode: "replace" })} disabled={busyId === t.tagId}>Play</button>
                    <button type="button" aria-pressed={t.policy?.playMode === "queue"} onClick={() => setPolicy(t, { playMode: "queue" })} disabled={busyId === t.tagId}>Queue</button>
                  </div>
                ) : null}
                {t.playSpec?.kind === "album-from-top" || t.playSpec?.kind === "album-from-track" ? (
                  <label className="tap-vol">Resume
                    <div className="tap-toggle" role="group" aria-label="Smart resume" style={{ marginLeft: 6 }}>
                      <button type="button" aria-pressed={!t.policy?.resume} onClick={() => setPolicy(t, { resume: false })} disabled={busyId === t.tagId}>Off</button>
                      <button type="button" aria-pressed={!!t.policy?.resume} onClick={() => setPolicy(t, { resume: true })} disabled={busyId === t.tagId}>On</button>
                    </div>
                  </label>
                ) : null}
                <label className="tap-vol">Vol
                  <select value={t.policy?.volume ?? ""} aria-label={`Volume for ${t.display?.title || "tag"}`} disabled={busyId === t.tagId}
                    onChange={(e) => setPolicy(t, { volume: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">Default</option>
                    {[20, 40, 60, 80, 100].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              </div>
              <div className="tap-card__actions">
                <button className="tap-btn" onClick={() => onRebind(t)}>Re-bind</button>
                <button className="tap-btn" onClick={() => setEditingId(editingId === t.tagId ? "" : t.tagId)} aria-pressed={editingId === t.tagId}>Edit</button>
                <button className="tap-btn" onClick={() => toggle(t)} disabled={busyId === t.tagId}>{t.enabled ? "Pause" : "Enable"}</button>
                <button className="tap-btn" onClick={() => copy(t)}>Copy link</button>
                <button className="tap-btn tap-btn--ghost" onClick={() => remove(t)} disabled={busyId === t.tagId}>Delete</button>
              </div>
              {editingId === t.tagId ? (
                <TagEditForm tag={t} onSaved={async () => { setEditingId(""); await load(); }} onCancel={() => setEditingId("")} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------- analytics ----------
function BarChart({ series }: { series: { date: string; count: number }[] }) {
  const max = Math.max(1, ...series.map((s) => s.count));
  const n = series.length || 1;
  const gap = 1.4;
  const bw = (100 - gap * (n - 1)) / n;
  return (
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label="Taps over time" className="tap-chart">
      {series.map((s, i) => {
        const h = (s.count / max) * 38;
        return <rect key={s.date} x={i * (bw + gap)} y={42 - Math.max(h, 0.6)} width={bw} height={Math.max(h, 0.6)} rx={0.5} fill="var(--rose)" opacity={s.count ? 1 : 0.22} />;
      })}
    </svg>
  );
}

function AnalyticsView() {
  const [data, setData] = useState<TapAnalytics | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getAnalytics().then((d) => { if (alive) setData(d); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  return (
    <section className="tap-main" aria-label="Analytics">
      <header className="tap-head">
        <span className="tap-head__eyebrow">Analytics</span>
        <h1 className="tap-head__title">How your tags get tapped</h1>
        <p className="tap-head__sub">Taps over the last two weeks, and which albums get reached for most.</p>
      </header>

      {failed ? <div className="tap-alert tap-alert--err">Couldn't load analytics.</div> : null}
      {!data && !failed ? <div className="tap-card__meta"><span className="tap-spinner" aria-hidden="true" /> Loading…</div> : null}

      {data ? (
        <>
          <div className="tap-stats">
            <div className="tap-stat"><span className="tap-stat__n">{data.totalTaps}</span><span className="tap-stat__l">total taps</span></div>
            <div className="tap-stat"><span className="tap-stat__n">{data.windowTaps}</span><span className="tap-stat__l">last 14 days</span></div>
            <div className="tap-stat"><span className="tap-stat__n">{data.totalTags}</span><span className="tap-stat__l">tags</span></div>
          </div>

          <div className="tap-card" style={{ maxWidth: "52rem" }}>
            <div className="tap-card__row"><span className="tap-card__title">Taps over time</span></div>
            <BarChart series={data.series} />
            <div className="tap-chart__axis"><span>{data.series[0]?.date}</span><span>{data.series[data.series.length - 1]?.date}</span></div>
          </div>

          <div>
            <h2 className="tap-head__eyebrow" style={{ marginBottom: 12 }}>Most tapped</h2>
            {data.mostTapped.length === 0 ? (
              <div className="tap-empty"><strong>No taps yet.</strong><span>Tap a tag and it'll show up here.</span></div>
            ) : (
              <div className="tap-grid">
                {data.mostTapped.map((t, i) => (
                  <div className="tap-card" key={t.tagId}>
                    <div className="tap-card__row">
                      <span className="tap-rank" aria-hidden="true">{i + 1}</span>
                      <Art src={t.display?.art} alt={t.display?.title || "tag"} />
                      <div className="tap-card__text">
                        <span className="tap-card__title">{t.display?.title || "Untitled tag"}</span>
                        <span className="tap-card__sub">{t.display?.artist}</span>
                      </div>
                    </div>
                    <div className="tap-card__meta"><span>Tapped {t.tapCount}×</span></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---------- printable labels ----------
function PrintLabelsView() {
  const [tags, setTags] = useState<TapTag[] | null>(null);
  useEffect(() => { listTags().then(setTags, () => setTags([])); }, []);
  const printable = (tags || []).filter((t) => t.token);

  return (
    <section className="tap-main tap-print" aria-label="Printable labels">
      <header className="tap-head tap-print__bar">
        <span className="tap-head__eyebrow">Labels</span>
        <h1 className="tap-head__title">Printable tag labels</h1>
        <p className="tap-head__sub">A QR + title card per tag — print on sticker paper and stick one beside each tag for shelves or parties.</p>
        <div><button className="tap-btn tap-btn--primary" onClick={() => window.print()} disabled={!printable.length}>Print sheet</button></div>
      </header>

      {tags === null ? <div className="tap-card__meta tap-print__bar"><span className="tap-spinner" aria-hidden="true" /> Loading…</div> : null}
      {tags && printable.length === 0 ? <div className="tap-empty tap-print__bar"><strong>No tags to print yet.</strong><span>Bind a tag first, then come back to print its label.</span></div> : null}

      {printable.length > 0 ? (
        <div className="tap-labels">
          {printable.map((t) => (
            <div className="tap-label" key={t.tagId}>
              <div className="tap-label__qr"><QRCodeSVG value={tapUrlFor(t.tagId, t.token!)} size={120} /></div>
              <div className="tap-label__text">
                <strong>{t.display?.title || "Squeezebox Tap"}</strong>
                <span>{t.display?.artist}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------- settings ----------
function SettingsView() {
  const [s, setS] = useState<TapSettings | null>(null);
  const [pwd, setPwd] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { getSettings().then(setS, () => setS({ debounceMs: 3000, partyMode: "open", requirePassword: false, hasPassword: false, partyQueue: false })); }, []);

  const save = async (patch: Record<string, unknown>) => {
    setSaved(false);
    const next = await saveSettings(patch);
    setS(next);
    setSaved(true);
    if (typeof patch.password === "string") setPwd("");
  };

  if (!s) return <section className="tap-main" aria-label="Settings"><div className="tap-card__meta"><span className="tap-spinner" aria-hidden="true" /> Loading…</div></section>;

  return (
    <section className="tap-main" aria-label="Settings">
      <header className="tap-head">
        <span className="tap-head__eyebrow">Settings</span>
        <h1 className="tap-head__title">How taps behave</h1>
        <p className="tap-head__sub">Pause the whole jukebox, tune the double-tap window, or require a password to play.</p>
      </header>

      <div className="tap-card" style={{ maxWidth: "40rem" }}>
        <div className="tap-setting">
          <div className="tap-setting__text"><strong>Jukebox</strong><span>When closed, taps are politely turned away.</span></div>
          <div className="tap-toggle" role="group" aria-label="Party mode">
            <button type="button" aria-pressed={s.partyMode === "open"} onClick={() => save({ partyMode: "open" })}>Open</button>
            <button type="button" aria-pressed={s.partyMode === "closed"} onClick={() => save({ partyMode: "closed" })}>Closed</button>
          </div>
        </div>

        <div className="tap-setting">
          <div className="tap-setting__text"><strong>Party queue</strong><span>{s.partyQueue ? "Taps add to the queue — nobody gets cut off." : "Taps replace whatever's playing."}</span></div>
          <div className="tap-toggle" role="group" aria-label="Party queue">
            <button type="button" aria-pressed={!s.partyQueue} onClick={() => save({ partyQueue: false })}>Replace</button>
            <button type="button" aria-pressed={!!s.partyQueue} onClick={() => save({ partyQueue: true })}>Queue</button>
          </div>
        </div>

        <div className="tap-setting">
          <div className="tap-setting__text"><strong>Double-tap window</strong><span>Ignore a repeat tap of the same tag within this time.</span></div>
          <label className="tap-vol">
            <select aria-label="Double-tap window" value={s.debounceMs} onChange={(e) => save({ debounceMs: Number(e.target.value) })}>
              {[0, 1000, 2000, 3000, 5000, 10000].map((ms) => <option key={ms} value={ms}>{ms === 0 ? "Off" : `${ms / 1000}s`}</option>)}
            </select>
          </label>
        </div>

        <div className="tap-setting">
          <div className="tap-setting__text"><strong>Require a password</strong><span>{s.hasPassword ? "A password is set." : "Taps play without a password."}</span></div>
          <div className="tap-toggle" role="group" aria-label="Require password">
            <button type="button" aria-pressed={!s.requirePassword} onClick={() => save({ requirePassword: false })}>Off</button>
            <button type="button" aria-pressed={s.requirePassword} onClick={() => save({ requirePassword: true })}>On</button>
          </div>
        </div>

        {s.requirePassword ? (
          <div className="tap-setting">
            <div className="tap-field" style={{ flex: 1 }}>
              <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={s.hasPassword ? "Change password…" : "Set a password…"} aria-label="Tap password" />
            </div>
            <button className="tap-btn tap-btn--primary" disabled={!pwd} onClick={() => save({ password: pwd })}>Save password</button>
          </div>
        ) : null}

        {saved ? <div className="tap-alert tap-alert--ok" role="status">Saved.</div> : null}
      </div>

      <BackupSection />
    </section>
  );
}

function BackupSection() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const doExport = async () => {
    const data = await exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "squeezebox-tap-backup.json";
    a.click();
    URL.revokeObjectURL(url);
    setMsg({ ok: true, text: "Backup downloaded." });
  };

  const doImport = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const res = await importBackup(data);
      setMsg({ ok: true, text: `Imported ${res.imported} tag${res.imported === 1 ? "" : "s"}${res.skipped ? `, skipped ${res.skipped}` : ""}.` });
    } catch {
      setMsg({ ok: false, text: "That file wasn't a valid Tap backup." });
    }
  };

  return (
    <div className="tap-card" style={{ maxWidth: "40rem" }}>
      <div className="tap-card__row"><span className="tap-card__title">Backup</span></div>
      <p className="tap-card__sub">Export all your tags + settings to a file, or restore them on another instance.</p>
      <div className="tap-card__actions">
        <button className="tap-btn" onClick={doExport}>Export backup</button>
        <button className="tap-btn" onClick={() => inputRef.current?.click()}>Import backup…</button>
        <input ref={inputRef} type="file" accept="application/json,.json" style={{ display: "none" }} aria-label="Import backup file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ""; }} />
      </div>
      {msg ? <div className={`tap-alert ${msg.ok ? "tap-alert--ok" : "tap-alert--err"}`} role="status">{msg.text}</div> : null}
    </div>
  );
}

// ---------- shell ----------
export function TapConsole() {
  const [session, setSession] = useState<TapSession | "loading">("loading");
  const [view, setView] = useState<"tags" | "write" | "analytics" | "print" | "settings">("tags");
  const [refreshKey, setRefreshKey] = useState(0);
  // When set, the Write view operates in re-point mode against this tag.
  const [rebindTarget, setRebindTarget] = useState<{ tagId: string; title?: string } | null>(null);

  const refreshSession = useCallback(() => {
    getSession().then(setSession, () => setSession({ authed: false, user: null }));
  }, []);

  useEffect(() => { refreshSession(); }, [refreshSession]);

  if (session === "loading") {
    return <div className="tap-state"><span className="tap-spinner" aria-label="Loading" /></div>;
  }
  if (!session.authed) {
    return <SignInCard session={session} onSignedIn={refreshSession} />;
  }

  const signOut = () => {
    // hl-auth logout is a POST — submit a form so the browser navigates + the
    // session cookie is cleared by the auth service.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = session.logoutUrl || "/auth/logout";
    document.body.appendChild(form);
    form.submit();
  };
  // Navigating the nav always clears any in-progress re-point so "Write a tag"
  // starts a fresh binding, not a re-point of the last tag.
  const navItem = (key: "tags" | "write" | "analytics" | "print" | "settings", label: string) => (
    <a className="tap-nav__item" href={`#${key}`} aria-current={view === key ? "page" : undefined} onClick={(e) => { e.preventDefault(); setRebindTarget(null); setView(key); }}>{label}</a>
  );

  return (
    <div className="tap-shell">
      <nav className="tap-nav" aria-label="Tap console">
        <div className="tap-nav__brand"><Wordmark /></div>
        {navItem("tags", "Tags")}
        {navItem("write", "Write a tag")}
        {navItem("analytics", "Analytics")}
        {navItem("print", "Print labels")}
        {navItem("settings", "Settings")}
        <a className="tap-nav__item" aria-disabled="true" href="#stations">Reader stations<span className="tap-nav__soon">soon</span></a>
        {session.user?.username ? <div className="tap-nav__who" title="Signed in">{session.user.username}</div> : null}
        <button className="tap-btn tap-btn--ghost" style={{ marginTop: session.user?.username ? undefined : "auto" }} onClick={signOut}>Sign out</button>
      </nav>
      {view === "tags" ? <TagsView refreshKey={refreshKey} onRebind={(tag) => { setRebindTarget({ tagId: tag.tagId, title: tag.display?.title }); setView("write"); }} />
        : view === "analytics" ? <AnalyticsView />
        : view === "print" ? <PrintLabelsView />
        : view === "settings" ? <SettingsView />
        : <WriteView rebind={rebindTarget} onDone={() => { setRebindTarget(null); setView("tags"); setRefreshKey((k) => k + 1); }} onCreated={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}
