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
import { ListMusic, Music2, Pause, Play, SkipBack, SkipForward, Trash2, Volume2, X } from "lucide-react";
import type { Track } from "../types";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export function localStreamId(track: Track | null | undefined): string | null {
  const raw = String(track?.uri || track?.id || "");
  const m = raw.match(/track:([A-Za-z0-9]+)/);
  return m ? m[1] : null;
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
  playNow: (track: Track) => void;
  playTracks: (tracks: Track[], startAt?: number) => void;
  addToQueue: (track: Track) => void;
  playNext: (track: Track) => void;
  removeAt: (i: number) => void;
  jumpTo: (i: number) => void;
  clear: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (s: number) => void;
  setVolume: (v: number) => void;
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

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const indexRef = useRef(index);
  indexRef.current = index;

  const playAt = useCallback((i: number) => {
    const q = queueRef.current;
    const audio = audioRef.current;
    if (!audio || i < 0 || i >= q.length) return;
    const sid = localStreamId(q[i]);
    if (!sid) return;
    setIndex(i);
    indexRef.current = i;
    setElapsed(0);
    setLoading(true);
    audio.src = `${apiBase}/local-stream/${sid}`;
    audio.play().catch(() => {});
  }, []);

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
    const onEnded = () => {
      const nextI = indexRef.current + 1;
      if (nextI < queueRef.current.length) playAt(nextI);
      else setIsPlaying(false);
    };
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
  }, [playAt]);

  const setQueueBoth = useCallback((q: Track[]) => {
    queueRef.current = q;
    setQueue(q);
  }, []);

  const playTracks = useCallback((tracks: Track[], startAt = 0) => {
    const playable = tracks.filter((t) => localStreamId(t));
    if (!playable.length) return;
    setQueueBoth(playable);
    playAt(Math.min(Math.max(0, startAt), playable.length - 1));
  }, [playAt, setQueueBoth]);

  const playNow = useCallback((track: Track) => {
    if (!localStreamId(track)) return;
    const at = indexRef.current + 1;
    const q = [...queueRef.current];
    q.splice(at, 0, track);
    setQueueBoth(q);
    playAt(at);
  }, [playAt, setQueueBoth]);

  const addToQueue = useCallback((track: Track) => {
    if (!localStreamId(track)) return;
    const q = [...queueRef.current, track];
    setQueueBoth(q);
    if (indexRef.current < 0) playAt(0);
  }, [playAt, setQueueBoth]);

  const playNext = useCallback((track: Track) => {
    if (!localStreamId(track)) return;
    const q = [...queueRef.current];
    q.splice(indexRef.current + 1, 0, track);
    setQueueBoth(q);
    if (indexRef.current < 0) playAt(0);
  }, [playAt, setQueueBoth]);

  const removeAt = useCallback((i: number) => {
    const q = [...queueRef.current];
    if (i < 0 || i >= q.length) return;
    q.splice(i, 1);
    setQueueBoth(q);
    if (i < indexRef.current) {
      setIndex(indexRef.current - 1);
      indexRef.current -= 1;
    }
  }, [setQueueBoth]);

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

  const next = useCallback(() => {
    const i = indexRef.current + 1;
    if (i < queueRef.current.length) playAt(i);
  }, [playAt]);

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
    queue, index, current, isPlaying, loading, elapsed, duration, volume,
    playNow, playTracks, addToQueue, playNext, removeAt, jumpTo, clear,
    toggle, next, previous, seek, setVolume
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
      <button className={mode === "squeezebox" ? "active" : ""} onClick={() => setMode("squeezebox")}>
        Squeezebox
      </button>
      <button className={mode === "local" ? "active" : ""} onClick={() => setMode("local")}>
        This device
      </button>
    </div>
  );
}

export function LocalNowPlayingPanel() {
  const p = useLocalPlayerContext();
  const has = Boolean(p.current);
  return (
    <section className="panel now-playing" aria-label="Now playing (local)">
      <h2>Now playing · This device</h2>
      <div className="playing-layout">
        <div className="mini-art local-art">
          {p.current?.art ? <img src={p.current.art} alt="" /> : <Music2 size={28} />}
        </div>
        <div className="track-core">
          <h3>{p.current?.title || "Nothing playing here"}</h3>
          <p>{p.current?.artist || "Pick a song to play in this browser"}</p>
          <span className="source-chip">{p.loading ? "Buffering…" : "Local · this device"}</span>
          <div className="local-progress">
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
          <div className="transport">
            <button aria-label="Previous" disabled={!has} onClick={p.previous}><SkipBack size={20} /></button>
            <button className="play-button" aria-label={p.isPlaying ? "Pause" : "Play"} disabled={!has} onClick={p.toggle}>
              {p.isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>
            <button aria-label="Next" disabled={!has || p.index >= p.queue.length - 1} onClick={p.next}><SkipForward size={20} /></button>
          </div>
          <div className="local-volume">
            <Volume2 size={18} />
            <input
              type="range" min={0} max={1} step={0.01} value={p.volume}
              onChange={(e) => p.setVolume(Number(e.currentTarget.value))}
              aria-label="Volume"
            />
          </div>
          {!has && <p className="empty-copy">This plays in your browser, separate from the Squeezebox. Add songs from search.</p>}
        </div>
      </div>
    </section>
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

void Trash2;
