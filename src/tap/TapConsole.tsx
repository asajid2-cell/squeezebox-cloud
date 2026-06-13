import React, { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  adminLogin,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  searchLibrary,
  spotifySearch,
  albumTracks,
  getAnalytics,
  getSettings,
  saveSettings,
  exportBackup,
  importBackup,
  type TapTag,
  type SearchItem,
  type TapAnalytics,
  type TapSettings
} from "./api";
import { writeTapTag, isNfcWriteSupported } from "./nfc";

const TOKEN_KEY = "tap.adminToken";

// Build a tag's public URL exactly as the server does (token in the #fragment),
// derived from where this console is served so copy/QR match the written tag.
function tapUrlFor(tagId: string, token: string): string {
  const base = window.location.pathname.replace(/\/tap\/link.*$/, "");
  return `${window.location.origin}${base}/tap/t/${tagId}#k=${token}`;
}

function Wordmark() {
  return <span className="tap-wordmark"><span className="tap-wordmark__dot" aria-hidden="true" />Tap</span>;
}

function Art({ src, alt, size = 56 }: { src?: string | null; alt: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="tap-card__art" style={{ width: size, height: size }}>
      {src && !broken ? (
        <img src={src} alt={alt} onError={() => setBroken(true)} />
      ) : (
        <div className="tap-art__fallback" aria-hidden="true">
          <svg width={size * 0.45} height={size * 0.45} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M9 18V6l10-2v12" /><circle cx="6" cy="18" r="3" /><circle cx="19" cy="16" r="3" /></svg>
        </div>
      )}
    </div>
  );
}

// ---------- login gate ----------
function LoginGate({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await adminLogin(password);
    setBusy(false);
    if (res.ok && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token);
      onAuthed(res.token);
    } else setError(res.error || "Login failed");
  };
  return (
    <div className="tap-state">
      <form className="tap-state__card" onSubmit={submit}>
        <Wordmark />
        <h1 className="tap-state__title">Tap console</h1>
        <p className="tap-state__body">Sign in to bind tags, write them, and manage your collection.</p>
        <div className="tap-field" style={{ width: "100%" }}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" aria-label="Admin password" autoFocus />
        </div>
        {error ? <div className="tap-alert tap-alert--err" role="alert" style={{ width: "100%" }}>{error}</div> : null}
        <button className="tap-btn tap-btn--primary" type="submit" disabled={busy || !password} style={{ width: "100%" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

// ---------- write flow ----------
function WriteView({ token, onCreated }: { token: string; onCreated: () => void }) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"spotify" | "library">("spotify");
  const [albums, setAlbums] = useState<SearchItem[]>([]);
  const [tracks, setTracks] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<SearchItem | null>(null);
  const [browseTracks, setBrowseTracks] = useState<SearchItem[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [created, setCreated] = useState<{ tagId: string; token: string; url: string; display: SearchItem } | null>(null);
  const [writeState, setWriteState] = useState<{ ok?: boolean; msg: string } | null>(null);
  const [error, setError] = useState("");

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    setPicked(null);
    setCreated(null);
    try {
      if (source === "spotify") {
        const { groups, results } = await spotifySearch(query);
        setAlbums(groups?.albums || []);
        setTracks(groups?.tracks || results || []);
      } else {
        const results = await searchLibrary(query);
        setAlbums([]);
        setTracks(results);
      }
    } catch {
      setError("Search failed — try again.");
    } finally {
      setSearching(false);
    }
  };

  const displayOf = (item: SearchItem, kind: string): SearchItem => ({ title: item.title, artist: item.artist, art: item.art ?? null, kind: kind as SearchItem["kind"] });

  const create = async (payload: Record<string, unknown>, display: SearchItem) => {
    setError("");
    const res = await createTag(token, payload);
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

  const bindAlbumTop = (album: SearchItem) =>
    create({ intent: "album-from-top", source: "spotify", albumUri: album.uri, display: displayOf(album, "album"), label: album.title || "" }, album);

  const bindTrack = (track: SearchItem) =>
    create({ intent: "track", track, display: displayOf(track, "track"), label: track.title || "" }, track);

  const bindAlbumFromTrack = (album: SearchItem, track: SearchItem, index: number) =>
    create(
      { intent: "album-from-track", source: "spotify", albumUri: album.uri, startIndex: index, display: { title: track.title, artist: track.artist, art: track.art ?? album.art ?? null, kind: "album-from-track" }, label: `${track.title} — ${album.title}` },
      { ...track, art: track.art ?? album.art }
    );

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

  if (created) {
    return (
      <section className="tap-main" aria-label="Write tag">
        <header className="tap-head">
          <span className="tap-head__eyebrow">Step 3 · Write</span>
          <h1 className="tap-head__title">Burn it onto a tag</h1>
          <p className="tap-head__sub">Hold a blank NFC tag to your phone and write it once. Future taps play <strong>{created.display.title}</strong>.</p>
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
            <div style={{ background: "#fff", padding: 12, borderRadius: 12 }}><QRCodeSVG value={created.url} size={148} /></div>
            <small>Scan to open this tag's page (or write the tag from that phone).</small>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="tap-main" aria-label="Write a tag">
      <header className="tap-head">
        <span className="tap-head__eyebrow">Step 1 · Find the music</span>
        <h1 className="tap-head__title">Write a tag</h1>
        <p className="tap-head__sub">Search for an album or song, choose how it plays, then write it to a tag.</p>
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

      {!searching && !picked && albums.length === 0 && tracks.length === 0 && query ? (
        <div className="tap-empty"><strong>No matches.</strong><span>Try another album or song name.</span></div>
      ) : null}
    </section>
  );
}

// ---------- tags manager ----------
function TagsView({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [tags, setTags] = useState<TapTag[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setTags(await listTags(token));
  }, [token]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tags || []).filter((t) => !f || `${t.display?.title} ${t.display?.artist} ${t.label}`.toLowerCase().includes(f));
  }, [tags, filter]);

  const toggle = async (t: TapTag) => { setBusyId(t.tagId); await updateTag(token, t.tagId, { enabled: !t.enabled }); await load(); setBusyId(""); };
  const remove = async (t: TapTag) => { if (!confirm(`Delete the tag for "${t.display?.title || t.tagId}"?`)) return; setBusyId(t.tagId); await deleteTag(token, t.tagId); await load(); setBusyId(""); };
  const copy = (t: TapTag) => { if (t.token) navigator.clipboard?.writeText(tapUrlFor(t.tagId, t.token)).catch(() => {}); };
  const setPolicy = async (t: TapTag, patch: { playMode?: "replace" | "queue"; volume?: number | null }) => {
    setBusyId(t.tagId);
    await updateTag(token, t.tagId, { policy: { playMode: t.policy?.playMode || "replace", volume: t.policy?.volume ?? null, ...patch } });
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
                <span>{t.playSpec?.kind === "album-from-track" ? "Album from a song" : t.playSpec?.kind === "album-from-top" ? "Whole album" : "Single song"}</span>
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
                <label className="tap-vol">Vol
                  <select value={t.policy?.volume ?? ""} aria-label={`Volume for ${t.display?.title || "tag"}`} disabled={busyId === t.tagId}
                    onChange={(e) => setPolicy(t, { volume: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">Default</option>
                    {[20, 40, 60, 80, 100].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              </div>
              <div className="tap-card__actions">
                <button className="tap-btn" onClick={() => toggle(t)} disabled={busyId === t.tagId}>{t.enabled ? "Pause" : "Enable"}</button>
                <button className="tap-btn" onClick={() => copy(t)}>Copy link</button>
                <button className="tap-btn tap-btn--ghost" onClick={() => remove(t)} disabled={busyId === t.tagId}>Delete</button>
              </div>
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

function AnalyticsView({ token }: { token: string }) {
  const [data, setData] = useState<TapAnalytics | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getAnalytics(token).then((d) => { if (alive) setData(d); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [token]);

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
function PrintLabelsView({ token }: { token: string }) {
  const [tags, setTags] = useState<TapTag[] | null>(null);
  useEffect(() => { listTags(token).then(setTags, () => setTags([])); }, [token]);
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
function SettingsView({ token }: { token: string }) {
  const [s, setS] = useState<TapSettings | null>(null);
  const [pwd, setPwd] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { getSettings(token).then(setS, () => setS({ debounceMs: 3000, partyMode: "open", requirePassword: false, hasPassword: false })); }, [token]);

  const save = async (patch: Record<string, unknown>) => {
    setSaved(false);
    const next = await saveSettings(token, patch);
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

      <BackupSection token={token} />
    </section>
  );
}

function BackupSection({ token }: { token: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const doExport = async () => {
    const data = await exportBackup(token);
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
      const res = await importBackup(token, data);
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
  const [token, setToken] = useState<string | null>(() => (typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null));
  const [view, setView] = useState<"tags" | "write" | "analytics" | "print" | "settings">("tags");
  const [refreshKey, setRefreshKey] = useState(0);

  if (!token) return <LoginGate onAuthed={setToken} />;

  const signOut = () => { localStorage.removeItem(TOKEN_KEY); setToken(null); };
  const navItem = (key: "tags" | "write" | "analytics" | "print" | "settings", label: string) => (
    <a className="tap-nav__item" href={`#${key}`} aria-current={view === key ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView(key); }}>{label}</a>
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
        <button className="tap-btn tap-btn--ghost" style={{ marginTop: "auto" }} onClick={signOut}>Sign out</button>
      </nav>
      {view === "tags" ? <TagsView token={token} refreshKey={refreshKey} />
        : view === "analytics" ? <AnalyticsView token={token} />
        : view === "print" ? <PrintLabelsView token={token} />
        : view === "settings" ? <SettingsView token={token} />
        : <WriteView token={token} onCreated={() => setRefreshKey((k) => k + 1)} />}
    </div>
  );
}
