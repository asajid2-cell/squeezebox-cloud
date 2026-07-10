/**
 * Local (this-device) playback — plays Spotify tracks in the browser via an
 * <audio> element fed by /api/local-stream/:id, fully independent of the
 * Squeezebox. The app can toggle between "squeezebox" and "local" modes; each
 * mode has its own now-playing + queue.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  Check, HardDriveDownload, ListMusic, Music2, Pause, Play, Repeat, Repeat1,
  Shuffle, SkipBack, SkipForward, Square, Volume2, X
} from "lucide-react";
import type { Track } from "../types";
import { archiveTrack } from "./api";

export type LocalRepeat = "off" | "all" | "one";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export function localStreamId(track: Track | null | undefined): string | null {
  const raw = String(track?.uri || track?.id || "");
  const m = raw.match(/track:([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Browser-playable URL for a track, or null if it can't play locally:
 *  - Spotify track  -> /api/local-stream/:id (fetched via spotty)
 *  - Archived FLAC  -> /api/archive/file/:name  (id encoded as "archive:<filename>")
 *  - Local file     -> /api/stream/<base64url(path)> (uploaded / VPS library)
 */
export function localStreamUrl(track: Track | null | undefined): string | null {
  const raw = String(track?.uri || track?.id || "");
  const m = raw.match(/track:([A-Za-z0-9]+)/);
  if (m) return `${apiBase}/local-stream/${m[1]}`;
  if (raw.startsWith("archive:")) return `${apiBase}/archive/file/${encodeURIComponent(raw.slice("archive:".length))}`;
  if (track?.path) return `${apiBase}/stream/${b64url(track.path)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Playback mode (squeezebox | local)
// ---------------------------------------------------------------------------

export type PlaybackMode = "squeezebox" | "local";
const MODE_KEY = "cloud-squeeze-playback-mode";

const PlaybackModeContext = createContext<{ mode: PlaybackMode; setMode: (m: PlaybackMode) => void } | null>(null);
export function usePlaybackMode() {
  const ctx = useContext(PlaybackModeContext);
  if (!ctx) throw new Error("PlaybackModeProvider missing");
  return ctx;
}

export function PlaybackModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<PlaybackMode>(() => {
    const stored = window.localStorage.getItem(MODE_KEY);
    return stored === "local" ? "local" : "squeezebox";
  });
  const setMode = useCallback((m: PlaybackMode) => {
    setModeState(m);
    window.localStorage.setItem(MODE_KEY, m);
  }, []);
  return <PlaybackModeContext.Provider value={{ mode, setMode }}>{children}</PlaybackModeContext.Provider>;
}

// ---------------------------------------------------------------------------
// Local player engine
// ---------------------------------------------------------------------------

export interface LocalPlayerApi {
  queue: Track[];
  index: number;
  current: Track | null;
  isPlaying: boolean;
  loading: boolean;
  elapsed: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: LocalRepeat;
  playNow: (track: Track) => void;
  playTracks: (tracks: Track[], startAt?: number) => void;
  addToQueue: (track: Track) => void;
  playNext: (track: Track) => void;
  removeAt: (i: number) => void;
  jumpTo: (i: number) => void;
  clear: () => void;
  toggle: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  seek: (s: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
}

const LocalPlayerContext = createContext<LocalPlayerApi | null>(null);
export function useLocalPlayerContext() {
  const ctx = useContext(LocalPlayerContext);
  if (!ctx) throw new Error("LocalPlayerProvider missing");
  return ctx;
}

export function LocalPlayerProvider({ children }: { children: ReactNode }) {
  return <LocalPlayerContext.Provider value={useLocalPlayerEngine()}>{children}</LocalPlayerContext.Provider>;
}

function useLocalPlayerEngine(): LocalPlayerApi {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<LocalRepeat>("off");

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const indexRef = useRef(index);
  indexRef.current = index;
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;

  const playAt = useCallback((i: number) => {
    const q = queueRef.current;
    const audio = audioRef.current;
    if (!audio || i < 0 || i >= q.length) return;
    const url = localStreamUrl(q[i]);
    if (!url) return;
    setIndex(i);
    indexRef.current = i;
    setElapsed(0);
    setLoading(true);
    audio.src = url;
    audio.play().catch(() => {});
  }, []);

  // Advance honoring shuffle + repeat. fromEnded=true when a track finished.
  const advance = useCallback((fromEnded: boolean) => {
    const q = queueRef.current;
    const i = indexRef.current;
    if (!q.length) return;
    if (fromEnded && repeatRef.current === "one") { playAt(i); return; }
    if (shuffleRef.current && q.length > 1) {
      let r = i;
      while (r === i) r = Math.floor(Math.random() * q.length);
      playAt(r);
      return;
    }
    const nextI = i + 1;
    if (nextI < q.length) playAt(nextI);
    else if (repeatRef.current === "all") playAt(0);
    else {
      // End of queue, repeat off: actually halt the audio element, not just the UI
      // flag — otherwise the current track keeps playing while the UI shows stopped.
      audioRef.current?.pause();
      setIsPlaying(false);
    }
  }, [playAt]);

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    audio.preload = "auto";
    const onTime = () => setElapsed(audio.currentTime || 0);
    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => { setIsPlaying(true); setLoading(false); };
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onEnded = () => advance(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.pause();
      audio.src = "";
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
    };
  }, [playAt, advance]);

  const setQueueBoth = useCallback((q: Track[]) => {
    queueRef.current = q;
    setQueue(q);
  }, []);

  const playTracks = useCallback((tracks: Track[], startAt = 0) => {
    // Resolve the chosen track BEFORE filtering, then find it again in the
    // streamable subset — otherwise dropping earlier unplayable tracks shifts
    // the index and we'd start on the wrong song.
    const chosen = tracks[Math.min(Math.max(0, startAt), tracks.length - 1)];
    const playable = tracks.filter((t) => localStreamUrl(t));
    if (!playable.length) return;
    setQueueBoth(playable);
    const idx = chosen ? playable.findIndex((t) => t.id === chosen.id) : -1;
    playAt(idx >= 0 ? idx : 0);
  }, [playAt, setQueueBoth]);

  const playNow = useCallback((track: Track) => {
    if (!localStreamUrl(track)) return;
    const at = indexRef.current + 1;
    const q = [...queueRef.current];
    q.splice(at, 0, track);
    setQueueBoth(q);
    playAt(at);
  }, [playAt, setQueueBoth]);

  const addToQueue = useCallback((track: Track) => {
    if (!localStreamUrl(track)) return;
    const q = [...queueRef.current, track];
    setQueueBoth(q);
    if (indexRef.current < 0) playAt(0);
  }, [playAt, setQueueBoth]);

  const playNext = useCallback((track: Track) => {
    if (!localStreamUrl(track)) return;
    const q = [...queueRef.current];
    q.splice(indexRef.current + 1, 0, track);
    setQueueBoth(q);
    if (indexRef.current < 0) playAt(0);
  }, [playAt, setQueueBoth]);

  const removeAt = useCallback((i: number) => {
    const q = [...queueRef.current];
    if (i < 0 || i >= q.length) return;
    const cur = indexRef.current;
    q.splice(i, 1);
    setQueueBoth(q);
    const stop = () => {
      const audio = audioRef.current;
      if (audio) { audio.pause(); audio.src = ""; }
      setIndex(-1);
      indexRef.current = -1;
      setIsPlaying(false);
      setElapsed(0);
      setDuration(0);
    };
    if (q.length === 0) { stop(); return; }
    if (i < cur) {
      // a track before the current one went away — shift the pointer to stay on it
      setIndex(cur - 1);
      indexRef.current = cur - 1;
    } else if (i === cur) {
      // the playing track was removed: play whatever shifted into its slot (the
      // former next track), or stop if it was the last item in the queue.
      if (i >= q.length) stop();
      else playAt(i);
    }
    // i > cur: the current track is unaffected, keep playing.
  }, [playAt, setQueueBoth]);

  const jumpTo = useCallback((i: number) => playAt(i), [playAt]);

  const clear = useCallback(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.src = ""; }
    setQueueBoth([]);
    setIndex(-1);
    indexRef.current = -1;
    setIsPlaying(false);
    setElapsed(0);
    setDuration(0);
  }, [setQueueBoth]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (!audio.src && queueRef.current.length) playAt(Math.max(0, indexRef.current));
      else audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [playAt]);

  const next = useCallback(() => advance(false), [advance]);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setElapsed(0);
    setIsPlaying(false);
  }, []);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === "off" ? "all" : r === "all" ? "one" : "off")),
    []
  );

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Smart back: restart current if >3s in or nothing before it; else go back.
    if (audio.currentTime > 3 || indexRef.current <= 0) audio.currentTime = 0;
    else playAt(indexRef.current - 1);
  }, [playAt]);

  const seek = useCallback((s: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = s;
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    if (audioRef.current) audioRef.current.volume = v;
  }, []);

  const current = index >= 0 && index < queue.length ? queue[index] : null;
  return {
    queue, index, current, isPlaying, loading, elapsed, duration, volume, shuffle, repeat,
    playNow, playTracks, addToQueue, playNext, removeAt, jumpTo, clear,
    toggle, stop, next, previous, seek, setVolume, toggleShuffle, cycleRepeat
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PlaybackModeToggle() {
  const { mode, setMode } = usePlaybackMode();
  return (
    <div className="mode-toggle" role="group" aria-label="Playback target">
      <button className={mode === "squeezebox" ? "active" : ""} aria-pressed={mode === "squeezebox"} onClick={() => setMode("squeezebox")}>
        Squeezebox
      </button>
      <button className={mode === "local" ? "active" : ""} aria-pressed={mode === "local"} onClick={() => setMode("local")}>
        This device
      </button>
    </div>
  );
}

function LocalArchiveButton({ track }: { track: Track | null }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  if (!track) return null;
  // The archive endpoint only accepts Spotify tracks; uploaded/VPS or already-archived
  // files would reliably fail, so don't offer the action for them.
  if (!(track.uri || track.id || "").toString().includes("spotify:")) return null;
  async function onClick() {
    try {
      await archiveTrack(track as Track);
      setState("done");
    } catch {
      setState("error");
    }
    window.setTimeout(() => setState("idle"), 4000);
  }
  return (
    <div className="archive-action">
      <button className="archive-button" onClick={onClick}>
        {state === "done" ? <Check size={18} /> : <HardDriveDownload size={18} />}
        {state === "done" ? "Added to archive queue" : state === "error" ? "Could not archive" : "Archive this song"}
      </button>
    </div>
  );
}

export function LocalNowPlayingPanel() {
  const p = useLocalPlayerContext();
  const has = Boolean(p.current);
  const art = p.current?.art || p.current?.artwork;
  const repeatLabel = p.repeat === "one" ? "Repeat one" : p.repeat === "all" ? "Repeat all" : "Repeat";
  return (
    <section className="panel now-playing" aria-label="Now playing (local)">
      <h2>Now playing · This device</h2>
      <div className="playing-layout">
        <div className={`album-art ${has ? "" : "is-empty"}`}>
          {art ? <img src={art} alt={`${p.current?.album || p.current?.title} cover`} /> : (
            <div className="album-art__fallback">
              <div className="album-noise" />
              <Music2 size={48} strokeWidth={1.5} />
            </div>
          )}
        </div>
        <div className="track-core">
          <h3>{p.current?.title || "Nothing playing here"}</h3>
          <p>{p.current?.artist || "Pick a song to play in this browser"}</p>
          <span className="source-chip">
            {has && p.isPlaying && <span className="live-dot" />}
            {p.loading ? "Buffering…" : "This device"}
          </span>
          <div className="playback-options">
            <button className={p.shuffle ? "active-option" : ""} aria-pressed={p.shuffle} onClick={p.toggleShuffle}>
              <Shuffle size={16} /> {p.shuffle ? "Shuffle on" : "Shuffle"}
            </button>
            <button className={p.repeat !== "off" ? "active-option" : ""} aria-pressed={p.repeat !== "off"} onClick={p.cycleRepeat}>
              {p.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />} {repeatLabel}
            </button>
          </div>
          <LocalArchiveButton track={p.current} />
          {!has && <p className="empty-copy">Plays in this browser, separate from the Squeezebox — use “Play here” on any song.</p>}
        </div>
      </div>
    </section>
  );
}

// Persistent player bar for the in-browser player (mirrors the Squeezebox PlayerBar
// so transport is reachable from every screen in "this device" mode too).
export function LocalPlayerBar() {
  const p = useLocalPlayerContext();
  const has = Boolean(p.current);
  const art = p.current?.art || p.current?.artwork;
  return (
    <footer className="player-bar" aria-label="Player">
      <div className="player-bar__meta">
        <div className="player-bar__art">{art ? <img src={art} alt="" /> : <ListMusic size={20} />}</div>
        <div className="player-bar__text">
          <strong>{has ? p.current?.title : "Nothing playing"}</strong>
          <small>{has ? p.current?.artist : "Use “Play here” on a song"}</small>
          <span className="player-bar__source">
            {has && p.isPlaying && <span className="live-dot" />}
            {p.loading ? "Buffering… · this device" : "This device"}
          </span>
        </div>
      </div>
      <div className="player-bar__center">
        <div className="player-bar__transport">
          <button aria-label="Previous" disabled={!has} onClick={p.previous}><SkipBack size={18} /></button>
          <button className="play-button" aria-label={p.isPlaying ? "Pause" : "Play"} disabled={!has} onClick={p.toggle}>
            {p.isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button aria-label="Stop" disabled={!has} onClick={p.stop}><Square size={16} fill="currentColor" /></button>
          <button aria-label="Next" disabled={!has} onClick={p.next}><SkipForward size={18} /></button>
        </div>
        <div className="player-bar__seek local-progress">
          <input
            type="range"
            min={0}
            max={Math.max(1, p.duration)}
            value={Math.min(p.elapsed, p.duration || 0)}
            disabled={!has}
            onChange={(e) => p.seek(Number(e.currentTarget.value))}
            aria-label="Seek"
          />
          <div className="local-times">
            <span>{fmt(p.elapsed)}</span>
            <span>{fmt(p.duration)}</span>
          </div>
        </div>
      </div>
      <div className="player-bar__volume">
        <VolumeRow volume={Math.round(p.volume * 100)} onChange={(v) => p.setVolume(v / 100)} />
      </div>
    </footer>
  );
}

function VolumeRow({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  return (
    <div className="volume-row">
      <Volume2 size={20} />
      <input aria-label="Volume" type="range" min={0} max={100} value={volume} onChange={(e) => onChange(Number(e.currentTarget.value))} />
      <span>{volume}%</span>
    </div>
  );
}

export function LocalQueuePanel() {
  const p = useLocalPlayerContext();
  return (
    <section className="panel queue-panel" aria-label="Local queue">
      <div className="panel-head-row">
        <h2>Up next · This device</h2>
        {p.queue.length > 0 && <button className="ghost-button" onClick={p.clear}>Clear</button>}
      </div>
      {p.queue.length === 0 ? (
        <p className="empty-copy">Local queue is empty. Use “Play here” on a song.</p>
      ) : (
        <ul className="archive-list">
          {p.queue.map((track, i) => (
            <li key={`${track.id}-${i}`} className={`archive-row ${i === p.index ? "is-current" : ""}`}>
              <button className="archive-thumb" onClick={() => p.jumpTo(i)} aria-label={`Play ${track.title}`}>
                {i === p.index && p.isPlaying ? <Volume2 size={16} /> : <ListMusic size={16} />}
              </button>
              <div className="archive-meta">
                <strong>{track.title}</strong>
                <span>{track.artist}</span>
              </div>
              <button className="icon-button" onClick={() => p.removeAt(i)} aria-label="Remove">
                <X size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
