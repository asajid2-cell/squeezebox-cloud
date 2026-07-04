import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Cloud,
  Check,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Download,
  HardDriveDownload,
  ListMusic,
  ListPlus,
  LockKeyhole,
  MoreHorizontal,
  Music2,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Radio,
  Repeat,
  Repeat1,
  Search,
  ShieldCheck,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Speaker,
  Square,
  Trash2,
  Volume2,
  XCircle
} from "lucide-react";
import {
  addTracksToPlaylist,
  checkMusicInfo,
  checkSpeaker,
  checkSpotify,
  createPlaylist,
  curateLibraryItem,
  deletePlaylist,
  fetchArchive,
  scanArchive,
  archiveDownloadUrl,
  archiveTrack,
  fetchArchiveStatus,
  fetchCollectionTracks,
  clearAdminSession,
  fetchCollections,
  fetchConnectionGuide,
  fetchPlaylist,
  fetchPlaylists,
  fetchSpotifyChildren,
  fetchSpotifyLibrary,
  fetchState,
  getSpotifyConnect,
  hasAdminSession,
  validateAdminSession,
  loginAdmin,
  movePlaylistTrack,
  moveQueueItem,
  playerAction,
  playlistTrackKey,
  playTrack,
  playTracks,
  playPlaylistFrom,
  removePlaylistTrack,
  removeQueueItem,
  renamePlaylist,
  rescanLibrary,
  saveAdminSettings,
  savePlayback,
  searchLibrary,
  searchSpotifyCategories,
  searchSpotifyGrouped,
  seekPlayer,
  setPlayerVolume,
  updateQueueItem,
  uploadTrack,
} from "./lib/api";
import type { ArchiveFile, ArchiveJob, ArchiveGroup, ArchiveScan } from "./lib/api";
import {
  PlaybackModeToggle,
  LocalNowPlayingPanel,
  LocalQueuePanel,
  usePlaybackMode,
  useLocalPlayerContext,
  localStreamUrl,
  PlaybackModeProvider,
  LocalPlayerProvider
} from "./lib/localPlayer";
import type { AppState, ConnectionGuide, LibraryCollection, Playlist, PlaylistSummary, SpotifySearchGroups, Track } from "./types";
import "./styles.css";

const spotifyRecommendationQuery = "drake";
const spotifySuggestionTerms = ["drake", "juice wrld", "the weeknd", "travis scott"];
const emptySpotifyGroups: SpotifySearchGroups = { tracks: [], artists: [], albums: [], playlists: [] };

const playlistListeners = new Set<() => void>();
function notifyPlaylistsChanged() {
  playlistListeners.forEach((listener) => listener());
}

function usePlaylists() {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const reload = useCallback(() => fetchPlaylists().then(setPlaylists), []);
  useEffect(() => {
    reload();
    playlistListeners.add(reload);
    return () => {
      playlistListeners.delete(reload);
    };
  }, [reload]);
  return { playlists, reload };
}

function Dialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  confirmDisabled,
  busy,
  busyLabel = "Saving..."
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: (event: FormEvent) => void | Promise<void>;
  onClose: () => void;
  confirmDisabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = dialogRef.current?.querySelector<HTMLElement>("input, button:not(:disabled), [href], textarea, select, [tabindex]:not([tabindex='-1'])");
    first?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { onCloseRef.current(); return; }
      if (event.key === "Tab") {
        const f = dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled), [href], textarea, select, [tabindex]:not([tabindex='-1'])");
        if (!f || f.length === 0) return;
        const first = f[0], last = f[f.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => { void onConfirm(event); }}
      >
        <h3 id={titleId} className="dialog__title">{title}</h3>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">
          <button type="button" className="ghost-add" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-small" disabled={busy || confirmDisabled}>{busy ? busyLabel : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

const starterLibraryLimit = 60;
const typedLibrarySearchLimit = 50;
const typedSpotifySearchLimit = 20;

const navItems = [
  { label: "Now Playing", icon: Music2 },
  { label: "Queue", icon: ListMusic },
  { label: "Playlists", icon: Music2 },
  { label: "Library", icon: Search },
  { label: "Archive", icon: HardDriveDownload }
];

type PublicScreenName = (typeof navItems)[number]["label"];
type ActionRunner = <T>(action: () => Promise<T>) => Promise<T | undefined>;

function mergeStateFromAction(previous: AppState | null, result: unknown): AppState | null {
  if (!previous || !result || typeof result !== "object") return previous;
  const payload = result as Partial<AppState> & { mode?: AppState["player"]["mode"] };
  let changed = false;
  const next = { ...previous };

  if (payload.player && typeof payload.player === "object") {
    next.player = { ...previous.player, ...payload.player };
    changed = true;
  } else if (payload.mode) {
    next.player = { ...previous.player, mode: payload.mode };
    changed = true;
  }
  if (payload.nowPlaying && typeof payload.nowPlaying === "object") {
    next.nowPlaying = { ...previous.nowPlaying, ...payload.nowPlaying };
    changed = true;
  }
  if (Array.isArray(payload.queue)) {
    next.queue = payload.queue;
    changed = true;
  }
  if (payload.playback && typeof payload.playback === "object") {
    next.playback = { ...previous.playback, ...payload.playback };
    changed = true;
  }
  if (payload.curation && typeof payload.curation === "object") {
    next.curation = payload.curation;
    changed = true;
  }

  return changed ? next : previous;
}

export default function App() {
  // Providers live here (not just in main.tsx) so anything rendering <App/>
  // directly — including tests — has the playback-mode and local-player contexts.
  return (
    <PlaybackModeProvider>
      <LocalPlayerProvider>
        <AppShell />
      </LocalPlayerProvider>
    </PlaybackModeProvider>
  );
}

function AppShell() {
  const [state, setState] = useState<AppState | null>(null);
  const [activeScreen, setActiveScreen] = useState<PublicScreenName>("Now Playing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [spotifyGroups, setSpotifyGroups] = useState<SpotifySearchGroups>(emptySpotifyGroups);
  const [sourceFilter, setSourceFilter] = useState<"local" | "uploaded" | "spotify" | "playlists" | "archived">("spotify");
  const [actionError, setActionError] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const actionPendingCount = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const isAdminRoute = window.location.pathname.replace(/\/$/, "").endsWith("/admin");

  // Wire the advertised Ctrl/Cmd+K affordance to focus the search field.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActiveScreen("Library");
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const refresh = useCallback(async () => {
    setState(await fetchState());
  }, []);

  const runAction = useCallback(async <T,>(action: () => Promise<T>) => {
    actionPendingCount.current += 1;
    setActionPending(true);
    setActionError("");
    try {
      const result = await action();
      setState((previous) => mergeStateFromAction(previous, result));
      return result;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Action failed");
      // Re-sync connection state promptly so the UI recovers (or honestly shows
      // reconnecting) right after a failed action instead of waiting for the poll.
      fetchState().then(setState).catch(() => {});
      return undefined;
    } finally {
      actionPendingCount.current = Math.max(0, actionPendingCount.current - 1);
      setActionPending(actionPendingCount.current > 0);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!state) return;
    const intervalMs = state.player.mode === "play" ? 900 : 2500;
    const timer = window.setInterval(refresh, intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, state?.player.mode, state?.nowPlaying.id]);

  useEffect(() => {
    let cancelled = false;
    setResults([]);
    setSpotifyGroups(emptySpotifyGroups);
    const timer = window.setTimeout(async () => {
      try {
        if (sourceFilter === "spotify" && state?.services?.spotify?.configured) {
          const term = query.trim() || spotifyRecommendationQuery;
          // Tracks return fast; artist/album/playlist buckets are slower, so load
          // them in parallel and merge in when ready instead of blocking the list.
          const groupsPromise = searchSpotifyGrouped(term, typedSpotifySearchLimit);
          searchSpotifyCategories(term).then((categories) => {
            if (!cancelled) setSpotifyGroups((current) => ({ ...current, ...categories }));
          }).catch(() => {});
          const groups = await groupsPromise;
          if (!cancelled) {
            setSpotifyGroups((current) => ({ ...groups, artists: current.artists.length ? current.artists : groups.artists, albums: current.albums.length ? current.albums : groups.albums, playlists: current.playlists.length ? current.playlists : groups.playlists }));
            setActionError("");
          }
        } else if (sourceFilter === "archived") {
          const { files } = await fetchArchive().catch(() => ({ files: [] as ArchiveFile[] }));
          const q = query.trim().toLowerCase();
          const mapped: Track[] = files
            .filter((f) => !q || `${f.title} ${f.artist}`.toLowerCase().includes(q))
            .map((f) => ({ id: `archive:${f.filename}`, title: f.title || f.filename, artist: f.artist, album: "", source: "Archived", kind: "track" as const, duration: null }));
          if (!cancelled) {
            setResults(mapped);
            setActionError("");
          }
        } else {
          const localLimit = query.trim() ? typedLibrarySearchLimit : starterLibraryLimit;
          const nextResults = sourceFilter === "local" || sourceFilter === "uploaded" ? await searchLibrary(query, localLimit, sourceFilter) : [];
          if (!cancelled) {
            setResults(nextResults);
            setActionError("");
          }
        }
      } catch (error) {
        if (!cancelled) setActionError(error instanceof Error ? error.message : "Search failed");
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Re-run when Spotify finishes initializing, not just on query/source change.
    // On a cold boot the service status is "Not checked yet" (configured:false) for
    // a few seconds, during which a Spotify search returns empty. Without these deps
    // the effect never re-fires once Spotify becomes ready, so the user is stuck on
    // the empty cold result until they retype or refresh the page — the long-standing
    // "I have to refresh before search works" bug. Depending on readiness fixes it.
  }, [query, sourceFilter, state?.curation?.revision, state?.services?.spotify?.configured, state?.services?.spotify?.reachable]);

  if (!state) return <div className="boot">Squeezebox Cloud</div>;

  const reconnecting = Boolean(state.player.reconnecting);
  const speakerOnline = state.player.connected && state.player.online && !reconnecting;

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <div className="brand">
          <Cloud size={18} fill="currentColor" />
          <span>Squeezebox Cloud</span>
        </div>
        <div className="sidebar-search">
          <Search size={18} />
          <input
            ref={searchRef}
            aria-label="Search music"
            placeholder="Search..."
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActiveScreen("Library");
            }}
            onFocus={() => setActiveScreen("Library")}
          />
          <kbd>Ctrl+K</kbd>
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              className={activeScreen === item.label ? "active" : ""}
              aria-current={activeScreen === item.label ? "page" : undefined}
              key={item.label}
              onClick={() => setActiveScreen(item.label)}
            >
              <item.icon size={20} />
              {item.label}
            </button>
          ))}
        </nav>
        <RecentPicks picks={state.recentPicks} />
        <PlaybackModeToggle />
        <div className="speaker-card">
          <span className={speakerOnline ? "status-dot online" : reconnecting ? "status-dot connecting" : "status-dot offline"} />
          <div>
            <strong>{speakerOnline ? "Speaker online" : reconnecting ? "Reconnecting…" : "Speaker offline"}</strong>
            <small>{speakerOnline ? state.player.name : state.player.detail || "LMS player not connected"}</small>
          </div>
          <Radio size={22} />
        </div>
      </aside>
      <main className="main">
        <header className="hero-row">
          {isAdminRoute ? <h1>Admin Console</h1> : <h1 className="sr-only">Squeezebox Cloud</h1>}
          <div className="top-actions">
            <a className="top-link" href={isAdminRoute ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}admin`}>
              <ShieldCheck size={18} />
              {isAdminRoute ? "Public site" : "Admin"}
            </a>
          </div>
        </header>
        {actionError && <div className="action-error" role="alert">{actionError}</div>}
        {isAdminRoute ? (
          <AdminPage state={state} onSave={refresh} />
        ) : (
          <PublicScreen
            state={state}
            activeScreen={activeScreen}
            query={query}
            results={results}
            spotifyGroups={spotifyGroups}
            setQuery={setQuery}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
            onRefresh={refresh}
            onAction={runAction}
            actionPending={actionPending}
            onPlayerAction={playerAction}
          />
        )}
      </main>
    </div>
  );
}

function PublicScreen({
  state,
  activeScreen,
  query,
  results,
  spotifyGroups,
  setQuery,
  sourceFilter,
  setSourceFilter,
  onRefresh,
  onAction,
  actionPending,
  onPlayerAction
}: {
  state: AppState;
  activeScreen: PublicScreenName;
  query: string;
  results: Track[];
  spotifyGroups: SpotifySearchGroups;
  setQuery: (value: string) => void;
  sourceFilter: "local" | "uploaded" | "spotify" | "playlists" | "archived";
  setSourceFilter: (value: "local" | "uploaded" | "spotify" | "playlists" | "archived") => void;
  onRefresh: () => void;
  onAction: ActionRunner;
  actionPending: boolean;
  onPlayerAction: (action: "play" | "pause" | "stop" | "next" | "previous") => Promise<unknown>;
}) {
  const { mode } = usePlaybackMode();
  const commonSearch = (
    <SearchPanel
      query={query}
      setQuery={setQuery}
      results={results}
      spotifyGroups={spotifyGroups}
      state={state}
      sourceFilter={sourceFilter}
      setSourceFilter={setSourceFilter}
      onRefresh={onRefresh}
      onAction={onAction}
    />
  );

  if (activeScreen === "Queue") {
    return (
      <div className="content-grid focus-grid">
        {mode === "local" ? <LocalQueuePanel /> : <QueuePanel queue={state.queue} requestsOpen={publicRequestsOpen(state)} onRefresh={onRefresh} onAction={onAction} />}
        <RightRail state={state} />
      </div>
    );
  }

  if (activeScreen === "Library") {
    return (
      <div className="content-grid focus-grid">
        {commonSearch}
        <RightRail state={state} />
      </div>
    );
  }

  if (activeScreen === "Playlists") {
    return (
      <div className="content-grid focus-grid">
        <PlaylistsPanel requestsOpen={publicRequestsOpen(state)} onRefresh={onRefresh} onAction={onAction} />
        <RightRail state={state} />
      </div>
    );
  }

  if (activeScreen === "Archive") {
    return (
      <div className="archive-screen">
        <ArchivePanel />
      </div>
    );
  }

  // A real track is one with a non-idle identity — don't require a known duration,
  // or live streams / duration-unknown tracks falsely read as "no track".
  const hasTrack = state.nowPlaying.id !== "idle";
  const controlsDisabled = !state.player.connected || !state.player.online || Boolean(state.player.reconnecting) || actionPending;
  if (mode === "local") {
    return (
      <div className="content-grid">
        <LocalNowPlayingPanel />
        <LocalQueuePanel />
        <RightRail state={state} />
      </div>
    );
  }
  return (
    <div className="content-grid">
      <NowPlayingPanel state={state} hasTrack={hasTrack} controlsDisabled={controlsDisabled} onRefresh={onRefresh} onAction={onAction} onPlayerAction={onPlayerAction} />

      <QueuePanel queue={state.queue} requestsOpen={publicRequestsOpen(state)} onRefresh={onRefresh} onAction={onAction} />

      <RightRail state={state} />
    </div>
  );
}

function NowPlayingPanel({
  state,
  hasTrack,
  controlsDisabled,
  onRefresh,
  onAction,
  onPlayerAction
}: {
  state: AppState;
  hasTrack: boolean;
  controlsDisabled: boolean;
  onRefresh: () => void;
  onAction: ActionRunner;
  onPlayerAction: (action: "play" | "pause" | "stop" | "next" | "previous") => Promise<unknown>;
}) {
  return (
    <section className="panel now-playing" aria-label="Now playing">
        <h2>Now playing</h2>
        <div className="playing-layout">
          <AlbumArt track={state.nowPlaying} />
          <div className="track-core">
            <h3>{state.nowPlaying.title}</h3>
            <p>{state.nowPlaying.artist}</p>
            <span className="source-chip">{state.nowPlaying.source}</span>
            <Progress
              key={`${state.nowPlaying.id}:${state.nowPlaying.duration || 0}`}
              trackId={state.nowPlaying.id}
              elapsed={state.nowPlaying.elapsed || 0}
              duration={state.nowPlaying.duration || 0}
              canSeek={Boolean(state.nowPlaying.canSeek)}
              mode={state.player.mode}
              onSeek={(seconds) => onAction(async () => { await seekPlayer(seconds); await onRefresh(); })}
              onEnded={onRefresh}
            />
            <div className="transport">
              <button aria-label="Previous" disabled={controlsDisabled} onClick={() => onAction(async () => { await onPlayerAction("previous"); await onRefresh(); })}>
                <SkipBack size={20} />
              </button>
              <button className="play-button" aria-label={state.player.mode === "play" ? "Pause" : "Play"} disabled={controlsDisabled} onClick={() => onAction(async () => { await onPlayerAction(state.player.mode === "play" ? "pause" : "play"); await onRefresh(); })}>
                {state.player.mode === "play" ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
              </button>
              <button aria-label="Stop" disabled={controlsDisabled || state.player.mode === "stop"} onClick={() => onAction(async () => { await onPlayerAction("stop"); await onRefresh(); })}>
                <Square size={18} fill="currentColor" />
              </button>
              <button aria-label="Next" disabled={controlsDisabled} onClick={() => onAction(async () => { await onPlayerAction("next"); await onRefresh(); })}>
                <SkipForward size={20} />
              </button>
            </div>
            <PlaybackOptions state={state} disabled={controlsDisabled || !publicRequestsOpen(state)} onRefresh={onRefresh} onAction={onAction} />
            <VolumeControl volume={state.player.volume} onChange={(volume) => onAction(async () => { await setPlayerVolume(volume); await onRefresh(); })} />
            <ArchiveButton track={hasTrack ? state.nowPlaying : null} />
            {!hasTrack && <p className="empty-copy">No live track yet. Connect the Squeezebox or add a local-library song.</p>}
          </div>
        </div>
      </section>
  );
}

function ArchiveButton({ track }: { track: AppState["nowPlaying"] | null }) {
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  // Archiving only accepts Spotify tracks; for local/uploaded/LMS playback the
  // request would deterministically fail, so don't offer the action then.
  if (!track || !String(track.uri || track.id || "").includes("spotify:")) return null;

  async function onArchive() {
    setStatus("saving");
    setMessage("");
    try {
      // Archive the exact track shown in the UI, not whatever the (possibly
      // unset / different) ARCHIVE_PLAYER_MAC player is currently playing.
      const result = await archiveTrack(track);
      setStatus("done");
      setMessage(result.queued ? "Added to archive queue" : result.reason || "Already archived");
      window.setTimeout(() => setStatus("idle"), 5000);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Could not queue archive");
    }
  }

  return (
    <div className="archive-action">
      <button className="archive-button" disabled={status === "saving"} onClick={onArchive}>
        <HardDriveDownload size={18} />
        {status === "saving" ? "Queueing…" : "Archive this song"}
      </button>
      {message && <span className={status === "error" ? "archive-msg error" : "archive-msg"}>{message}</span>}
    </div>
  );
}

function ArchiveTrackButton({ track }: { track: Track }) {
  const [state, setState] = useState<"idle" | "queued" | "error">("idle");
  async function onClick() {
    try {
      const r = await archiveTrack(track);
      setState("queued");
      window.setTimeout(() => setState("idle"), 4000);
      if (!r.queued && r.reason) setState("queued");
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 4000);
    }
  }
  return (
    <button
      className="ghost-add"
      data-tooltip="Archive"
      disabled={state === "queued"}
      onClick={onClick}
      aria-label={`Archive ${track.title}`}
    >
      {state === "queued" ? <Check size={15} /> : <HardDriveDownload size={15} />}
    </button>
  );
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const ARCHIVE_STATUS_LABEL: Record<ArchiveJob["status"], string> = {
  queued: "Queued",
  downloading: "Downloading…",
  done: "Saved",
  failed: "Failed"
};

function ArchiveFileRow({ file }: { file: ArchiveFile }) {
  return (
    <li className="archive-row">
      <div className="archive-thumb">{usableArt(file.art) ? <img src={usableArt(file.art)} alt="" /> : <Music2 size={18} />}</div>
      <div className="archive-meta">
        <strong>{file.title || file.filename}</strong>
        <span>{file.artist}</span>
      </div>
      <div className="archive-aux">
        <span className="archive-size">{formatBytes(file.size)}</span>
        <a
          className="icon-button"
          href={archiveDownloadUrl(file.filename)}
          download={file.filename}
          aria-label={`Download ${file.title || file.filename}`}
        >
          <Download size={18} />
        </a>
      </div>
    </li>
  );
}

function ArchivePanel() {
  const [groups, setGroups] = useState<ArchiveGroup[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [jobs, setJobs] = useState<ArchiveJob[]>([]);
  const [scan, setScan] = useState<ArchiveScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    Promise.all([fetchArchive(), fetchArchiveStatus().catch(() => null)])
      .then(([list, status]) => {
        setGroups(list.groups);
        setTotalFiles(list.files.length);
        setScan(list.scan);
        setJobs(status?.jobs || []);
        setError("");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load archive"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    // Poll so queue progress + newly-finished downloads appear live.
    const timer = window.setInterval(reload, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try { await scanArchive(); await reload(); } catch { /* surfaced on next reload */ }
    finally { setScanning(false); }
  }, [reload]);

  const pending = jobs.filter((j) => j.status === "queued" || j.status === "downloading");
  const failed = jobs.filter((j) => j.status === "failed");
  const watchCount = scan?.watching.length || 0;
  const emailCount = scan?.watching.filter((w) => w.email).length || 0;
  const shownGroups = groups.filter((g) => g.count > 0);

  return (
    <section className="panel archive-panel" aria-label="Archive">
      <div className="panel-head-row">
        <h2>Archive</h2>
        <div className="archive-head-actions">
          <button className="ghost-button" onClick={runScan} disabled={scanning} aria-label="Scan watched playlists now">{scanning ? "Scanning…" : "Scan now"}</button>
          <button className="ghost-button" onClick={reload} aria-label="Refresh archive">Refresh</button>
        </div>
      </div>
      <p className="panel-subtitle">Lossless FLAC copies, downloaded in the background. Queue songs from search or the player — or just add them to a Spotify playlist named <strong>archive</strong> and they get pulled in automatically.</p>
      {watchCount > 0 && (
        <p className="archive-watch-note">Auto-archiving {watchCount} playlist{watchCount > 1 ? "s" : ""}{emailCount > 0 ? ` · emailing new songs from ${emailCount}` : ""}{scan?.lastScanAt ? ` · last checked ${archiveRelativeTime(scan.lastScanAt)}` : ""}.</p>
      )}
      {error && <div className="action-error" role="alert">{error}</div>}

      {pending.length > 0 && (
        <div className="archive-queue">
          <h3 className="archive-section-title">In progress</h3>
          <ul className="archive-list">
            {pending.map((job) => (
              <li key={job.id} className="archive-row">
                <div className="archive-meta">
                  <strong>{job.title}</strong>
                  <span>{job.artist}</span>
                </div>
                <span className={`archive-badge ${job.status}`}>{ARCHIVE_STATUS_LABEL[job.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && totalFiles === 0 ? (
        <p className="empty-copy">Loading…</p>
      ) : totalFiles === 0 ? (
        <p className="empty-copy">Nothing saved yet. Click the archive icon on any song to queue it, or add songs to a Spotify playlist named “archive”.</p>
      ) : (
        shownGroups.map((group) => (
          <div key={group.name} className="archive-group">
            <h3 className="archive-section-title">{group.manual ? "Manual" : group.name} · {group.count}</h3>
            <ul className="archive-list">
              {group.files.map((file) => <ArchiveFileRow key={file.filename} file={file} />)}
            </ul>
          </div>
        ))
      )}

      {failed.length > 0 && (
        <p className="archive-failed-note">{failed.length} download{failed.length > 1 ? "s" : ""} failed — re-queue to retry.</p>
      )}
    </section>
  );
}

// Short, dependency-free "x ago" for the last-scan note.
function archiveRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  return `${Math.round(hrs / 24)} day${Math.round(hrs / 24) > 1 ? "s" : ""} ago`;
}

function PlaybackOptions({ state, disabled, onRefresh, onAction }: { state: AppState; disabled: boolean; onRefresh: () => void; onAction: ActionRunner }) {
  const playback = state.playback || { shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed" as const };
  const repeatIcon = playback.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />;
  const shuffleLabel = playback.smartQueue ? "Smart shuffle" : playback.shuffle ? "Shuffle on" : "Shuffle";
  const hasManualQueue = state.queue.some((item) => item.requestedBy !== "shuffle" && item.requestedBy !== "smart shuffle");

  async function setRepeat() {
    const next = playback.repeat === "off" ? "all" : playback.repeat === "all" ? "one" : "off";
    await onAction(async () => {
      const result = await savePlayback({ repeat: next });
      await onRefresh();
      return result;
    });
  }

  async function cycleShuffle() {
    const next =
      playback.smartQueue
        ? { shuffle: false, smartQueue: false }
        : playback.shuffle
          ? hasManualQueue
            ? { shuffle: false, smartQueue: false }
            : { shuffle: false, smartQueue: true }
          : { shuffle: true, smartQueue: false };
    await onAction(async () => {
      const result = await savePlayback(next);
      await onRefresh();
      return result;
    });
  }

  async function setSource(source: AppState["playback"]["smartShuffleSource"]) {
    await onAction(async () => {
      const result = await savePlayback({ smartShuffleSource: source });
      await onRefresh();
      return result;
    });
  }

  return (
    <div className="playback-options" aria-label="Playback options">
      <button
        aria-pressed={playback.shuffle || playback.smartQueue} className={playback.shuffle || playback.smartQueue ? "active-option" : ""}
        disabled={disabled}
        title="Cycles between shuffle, smart shuffle, and off"
        onClick={cycleShuffle}
      >
        <Shuffle size={17} />
        {shuffleLabel}
      </button>
      <button aria-pressed={playback.repeat !== "off"} className={playback.repeat !== "off" ? "active-option" : ""} disabled={disabled} title="Repeat off, all, or one" onClick={setRepeat}>
        {repeatIcon}
        {playback.repeat === "off" ? "Repeat" : playback.repeat === "one" ? "Repeat 1" : "Repeat all"}
      </button>
      <div className="shuffle-source" aria-label="Smart shuffle source">
        {(["mixed", "spotify", "local"] as const).map((source) => (
          <button key={source} aria-pressed={playback.smartShuffleSource === source} className={playback.smartShuffleSource === source ? "active-option" : ""} disabled={disabled} onClick={() => setSource(source)}>
            {source}
          </button>
        ))}
      </div>
    </div>
  );
}

function AlbumArt({ track }: { track: Track }) {
  const empty = track.id === "idle";
  const art = track.art || track.artwork;
  return (
    <div className={`album-art ${empty ? "is-empty" : ""}`}>
      {art ? (
        <img src={art} alt={`${track.album || track.title} cover`} />
      ) : (
        <>
          <div className="album-noise" />
          <strong>{empty ? "CS." : `${track.artist.split(" ")[0]}.`}</strong>
          <span>{track.album || "No Album"}</span>
        </>
      )}
    </div>
  );
}

function Progress({
  trackId,
  elapsed,
  duration,
  canSeek,
  mode,
  onSeek,
  onEnded
}: {
  trackId: string;
  elapsed: number;
  duration: number;
  canSeek: boolean;
  mode: string;
  onSeek: (seconds: number) => void;
  onEnded: () => void;
}) {
  const [draft, setDraft] = useState(elapsed);
  const [dragging, setDragging] = useState(false);
  const [liveElapsed, setLiveElapsed] = useState(elapsed);
  const endRefreshTrack = useRef<string | null>(null);
  const value = dragging ? draft : liveElapsed;
  const percent = duration > 0 ? Math.max(0, Math.min(100, (value / duration) * 100)) : 0;
  const disabled = !canSeek || duration <= 0;

  useEffect(() => {
    if (!dragging) {
      setDraft(elapsed);
      setLiveElapsed(elapsed);
    }
  }, [elapsed, dragging, trackId, duration]);

  useEffect(() => {
    endRefreshTrack.current = null;
  }, [trackId]);

  useEffect(() => {
    if (mode !== "play" || dragging || disabled) return;
    const timer = window.setInterval(() => {
      setLiveElapsed((current) => {
        const next = Math.min(duration, current + 0.25);
        if (duration > 0 && next >= duration - 0.35 && endRefreshTrack.current !== trackId) {
          endRefreshTrack.current = trackId;
          window.setTimeout(onEnded, 0);
        }
        return next;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [mode, dragging, disabled, duration, trackId, onEnded]);

  function commit(seconds = draft) {
    if (!disabled) onSeek(Math.max(0, Math.min(duration, seconds)));
    setDragging(false);
  }

  return (
    <div className="progress-block">
      <div className={`bar ${disabled ? "is-disabled" : ""}`}>
        <span style={{ width: `${percent}%` }} />
        <input
          aria-label="Seek position"
          type="range"
          min="0"
          max={Math.max(0, Math.round(duration))}
          step="0.1"
          value={Number(value.toFixed(1))}
          disabled={disabled}
          onChange={(event) => {
            setDragging(true);
            setDraft(Number(event.currentTarget.value));
          }}
          onPointerUp={(event) => commit(Number(event.currentTarget.value))}
          onBlur={() => dragging && commit()}
          onKeyUp={(event) => {
            if (event.key === "Enter" || event.key === " ") commit(Number(event.currentTarget.value));
          }}
        />
      </div>
      <div className="progress-times">
        <span>{formatTime(value)}</span>
        <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
      </div>
    </div>
  );
}

function VolumeControl({ volume, onChange }: { volume: number; onChange: (volume: number) => void }) {
  const [draftVolume, setDraftVolume] = useState(volume);

  useEffect(() => {
    setDraftVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (draftVolume === volume) return;
    const timer = window.setTimeout(() => onChange(draftVolume), 180);
    return () => window.clearTimeout(timer);
  }, [draftVolume, onChange, volume]);

  return (
    <div className="volume-row">
      <Volume2 size={20} />
      <input
        aria-label="Volume"
        type="range"
        min="0"
        max="100"
        value={draftVolume}
        onChange={(event) => setDraftVolume(Number(event.currentTarget.value))}
      />
      <span>{draftVolume}%</span>
    </div>
  );
}

function QueuePanel({ queue, requestsOpen, onRefresh, onAction }: { queue: AppState["queue"]; requestsOpen: boolean; onRefresh: () => void; onAction: ActionRunner }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", artist: "" });
  const [showAll, setShowAll] = useState(false);
  const visibleQueue = showAll ? queue : queue.slice(0, 12);

  function beginEdit(item: AppState["queue"][number]) {
    setEditingId(item.id);
    setDraft({ title: item.title, artist: item.artist });
  }

  async function saveEdit(id: string) {
    await onAction(async () => {
      await updateQueueItem(id, draft);
      setEditingId(null);
      await onRefresh();
    });
  }

  return (
    <section className="panel queue-panel" aria-label="Up next">
      <div className="section-head">
        <h2>Up next</h2>
        <span>Requested by</span>
        <span>ETA</span>
      </div>
      <div className="queue-list">
        {queue.length === 0 && <EmptyState title="Queue is empty" detail="Requests will appear here after someone adds a real local or Spotify track." />}
        {visibleQueue.map((item, index) => (
          <QueueRow key={item.id} item={item} index={index} queueLength={queue.length} requestsOpen={requestsOpen} editingId={editingId} draft={draft} setDraft={setDraft} beginEdit={beginEdit} saveEdit={saveEdit} cancelEdit={() => setEditingId(null)} onRefresh={onRefresh} onAction={onAction} />
        ))}
        {queue.length > 12 && (
          <button className="ghost-add queue-show-all" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show less" : `Show all ${queue.length}`}
          </button>
        )}
      </div>
      <p className="quiet-note">{queue.length} songs - ~{queue.at(-1)?.etaMinutes || 0} min total</p>
    </section>
  );
}

function QueueRow({
  item,
  index,
  queueLength,
  requestsOpen,
  editingId,
  draft,
  setDraft,
  beginEdit,
  saveEdit,
  cancelEdit,
  onRefresh,
  onAction
}: {
  item: AppState["queue"][number];
  index: number;
  queueLength: number;
  requestsOpen: boolean;
  editingId: string | null;
  draft: { title: string; artist: string };
  setDraft: (draft: { title: string; artist: string }) => void;
  beginEdit: (item: AppState["queue"][number]) => void;
  saveEdit: (id: string) => void;
  cancelEdit: () => void;
  onRefresh: () => void;
  onAction: ActionRunner;
}) {
  const isEditing = editingId === item.id;
  // External tracks carry their identity in uri OR in id (spotify:/archive:), and
  // Spotify rows aren't locally editable — only auto-queued shuffle rows are excluded too.
  const isExternal = Boolean(item.uri) || /^(spotify|archive):/.test(item.id) || item.source === "Spotify";
  const editable = !isExternal && item.requestedBy !== "shuffle" && item.requestedBy !== "smart shuffle";

  return (
    <div className={`queue-row ${isEditing ? "is-editing" : ""}`}>
      <div className="mini-art">
        {item.art || item.artwork ? <img src={item.art || item.artwork || ""} alt="" /> : <Music2 size={18} />}
      </div>
      {isEditing ? (
        <div className="queue-edit-fields">
          <small>Editing queue item</small>
          <input aria-label="Queue title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
          <input aria-label="Queue artist" value={draft.artist} onChange={(event) => setDraft({ ...draft, artist: event.currentTarget.value })} />
        </div>
      ) : (
        <div>
          <strong>{item.title}</strong>
          <small>{item.artist}</small>
        </div>
      )}
      <span>{item.requestedBy}</span>
      <span>~{item.etaMinutes} min</span>
      <div className="queue-actions">
        <button className="primary-small row-play" disabled={!requestsOpen} onClick={() => onAction(async () => { await playTrack("play-now", item); await onRefresh(); })}>
          <Play size={14} />Play
        </button>
        <RowMenu label={`More queue actions for ${item.title}`}>
          <button className="row-menu__item" disabled={index === 0 || !requestsOpen} onClick={() => onAction(async () => { await moveQueueItem(item.id, "up"); await onRefresh(); })}>
            <ChevronUp size={15} /> Move earlier
          </button>
          <button className="row-menu__item" disabled={index === queueLength - 1 || !requestsOpen} onClick={() => onAction(async () => { await moveQueueItem(item.id, "down"); await onRefresh(); })}>
            <ChevronDown size={15} /> Move later
          </button>
          {isEditing ? (
            <button className="row-menu__item" disabled={!requestsOpen} onClick={() => saveEdit(item.id)}>
              <Check size={15} /> Save edits
            </button>
          ) : editable ? (
            <button className="row-menu__item" disabled={!requestsOpen} onClick={() => beginEdit(item)}>
              <SlidersHorizontal size={15} /> Edit details
            </button>
          ) : null}
          {isEditing && (
            <button className="row-menu__item" onClick={cancelEdit}>
              <XCircle size={15} /> Cancel editing
            </button>
          )}
          <button className="row-menu__item danger" disabled={!requestsOpen} onClick={() => onAction(async () => { await removeQueueItem(item.id); await onRefresh(); })}>
            <XCircle size={15} /> Remove
          </button>
        </RowMenu>
      </div>
    </div>
  );
}

function SearchPanel({
  query,
  setQuery,
  results,
  spotifyGroups,
  state,
  sourceFilter,
  setSourceFilter,
  onRefresh,
  onAction
}: {
  query: string;
  setQuery: (value: string) => void;
  results: Track[];
  spotifyGroups: SpotifySearchGroups;
  state: AppState;
  sourceFilter: "local" | "uploaded" | "spotify" | "playlists" | "archived";
  setSourceFilter: (value: "local" | "uploaded" | "spotify" | "playlists" | "archived") => void;
  onRefresh: () => void;
  onAction: ActionRunner;
}) {
  const [showAllResults, setShowAllResults] = useState(false);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [detail, setDetail] = useState<{ track: Track; tracks: Track[]; loading: boolean } | null>(null);
  const spotifyAvailable = state.services.spotify.configured;
  const requestsOpen = publicRequestsOpen(state);
  const visibleResults = showAllResults ? results : results.slice(0, 3);
  const filteredCollections = collections.filter((item) =>
    `${item.collection} ${item.folder} ${item.sample.join(" ")}`.toLowerCase().includes(query.toLowerCase())
  );
  const spotifyEmpty =
    spotifyGroups.tracks.length === 0 &&
    spotifyGroups.artists.length === 0 &&
    spotifyGroups.albums.length === 0 &&
    spotifyGroups.playlists.length === 0;

  useEffect(() => {
    fetchCollections().then(setCollections);
  }, []);

  useEffect(() => {
    setShowAllResults(false);
  }, [query, sourceFilter]);

  useEffect(() => {
    setDetail(null);
  }, [query, sourceFilter]);

  async function openSpotifyDetail(track: Track) {
    setDetail({ track, tracks: [], loading: true });
    const tracks = (await onAction(() => fetchSpotifyChildren(track, 250))) || [];
    setDetail({ track, tracks, loading: false });
  }

  return (
    <section className="panel search-panel" aria-label="Library">
      <h2>Library</h2>
      <div className="source-tabs">
        <button disabled={!spotifyAvailable} aria-pressed={sourceFilter === "spotify"} className={sourceFilter === "spotify" ? "primary-small" : ""} onClick={() => setSourceFilter("spotify")}>
          Spotify{spotifyAvailable ? "" : " not linked"}
        </button>
        <button aria-pressed={sourceFilter === "local"} className={sourceFilter === "local" ? "primary-small" : ""} onClick={() => setSourceFilter("local")}>
          VPS library
        </button>
        <button aria-pressed={sourceFilter === "uploaded"} className={sourceFilter === "uploaded" ? "primary-small" : ""} onClick={() => setSourceFilter("uploaded")}>
          Uploaded
        </button>
        <button aria-pressed={sourceFilter === "archived"} className={sourceFilter === "archived" ? "primary-small" : ""} onClick={() => setSourceFilter("archived")}>
          Archived
        </button>
        <button aria-pressed={sourceFilter === "playlists"} className={sourceFilter === "playlists" ? "primary-small" : ""} onClick={() => setSourceFilter("playlists")}>
          Playlists
        </button>
      </div>
      {sourceFilter === "archived" && (
        <div className="upload-box">
          <div>
            <strong>Archived songs</strong>
            <small>Lossless FLAC copies saved by the background archiver. Play them on this device, or queue them.</small>
          </div>
        </div>
      )}
      {sourceFilter === "uploaded" && (
        <div className="upload-box">
          <div>
            <strong>Uploaded songs</strong>
            <small>{state.services.localLibrary.uploadedCount || 0} uploaded tracks. Audio files only: MP3, FLAC, M4A, WAV, OGG, AAC.</small>
          </div>
          <label className="upload-button">
            {uploading ? "Uploading" : !requestsOpen ? "Paused" : "Upload"}
            <input
              type="file"
              accept=".mp3,.flac,.m4a,.wav,.ogg,.aac,audio/mpeg,audio/flac,audio/mp4,audio/wav,audio/ogg,audio/aac"
              disabled={uploading || !requestsOpen}
              onChange={async (event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                setUploadError("");
                setUploading(true);
                try {
                  const uploaded = await uploadTrack(file);
                  setQuery(uploaded.track.title);
                  await onRefresh();
                } catch (error) {
                  setUploadError(error instanceof Error ? error.message : "Upload failed");
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
          {uploadError && <small className="form-error">{uploadError}</small>}
        </div>
      )}
      {sourceFilter === "spotify" && spotifyAvailable && !detail && (
        <div className="suggestion-row" aria-label="Spotify recommendations">
          {spotifySuggestionTerms.map((term) => (
            <button key={term} onClick={() => setQuery(term)} aria-pressed={query.toLowerCase() === term} className={query.toLowerCase() === term ? "is-selected" : ""}>
              {term}
            </button>
          ))}
        </div>
      )}

      {sourceFilter === "spotify" && spotifyAvailable && detail && (
        <SpotifyDetail
          detail={detail}
          requestsOpen={requestsOpen}
          onBack={() => setDetail(null)}
          onRefresh={onRefresh}
          onAction={onAction}
        />
      )}

      {sourceFilter === "spotify" && spotifyAvailable && !detail && (
        <>
          {query.trim() === "" && (
            <div className="recommendation-head">
              <strong>Recommended from Spotify</strong>
              <small>Showing a starter set. Type anything to search Spotty directly.</small>
            </div>
          )}
          {spotifyEmpty && query.trim() !== "" && (
            <EmptyState title="No Spotify results" detail="Try another Spotify search term." />
          )}
          <SpotifyGroupSection title="Songs" kind="track" items={spotifyGroups.tracks} requestsOpen={requestsOpen} onRefresh={onRefresh} onAction={onAction} />
          <SpotifyGroupSection title="Artists" kind="artist" items={spotifyGroups.artists} onOpen={openSpotifyDetail} />
          <SpotifyGroupSection title="Albums" kind="album" items={spotifyGroups.albums} onOpen={openSpotifyDetail} />
          <SpotifyGroupSection title="Playlists" kind="playlist" items={spotifyGroups.playlists} onOpen={openSpotifyDetail} />
        </>
      )}

      {sourceFilter === "spotify" && !spotifyAvailable && (
        <div className="result-list">
          <EmptyState title="Spotify is not linked" detail="Connect Spotty in LMS before public Spotify search is enabled." />
        </div>
      )}

      {sourceFilter !== "spotify" && (
        <>
          <div className="result-list">
            {sourceFilter === "playlists" && filteredCollections.length === 0 && (
              <EmptyState title="No playlist collections" detail="Try another collection, era, folder, or track name." />
            )}
            {sourceFilter === "playlists" &&
              filteredCollections.map((item) => (
                <div className="collection-inline" key={`${item.collection}-${item.folder}`}>
                  <div>
                    <strong>{item.folder}</strong>
                    <small>{item.collection}</small>
                    <small>{item.sample.join(", ")}</small>
                  </div>
                  <span>{item.count} tracks</span>
                </div>
              ))}
            {(sourceFilter === "local" || sourceFilter === "uploaded" || sourceFilter === "archived") && results.length === 0 && (
              <EmptyState
                title={sourceFilter === "uploaded" ? "No uploaded songs" : sourceFilter === "archived" ? "Nothing archived yet" : "No local results"}
                detail={sourceFilter === "uploaded" ? "Upload a supported music file to add it here." : sourceFilter === "archived" ? "Use the archive icon on a song to save a lossless copy here." : "Add music to the configured LMS music folder or search another title."}
              />
            )}
            {(sourceFilter === "local" || sourceFilter === "uploaded" || sourceFilter === "archived") &&
              visibleResults.map((track) => (
                <SearchResultRow key={track.id} track={track} requestsOpen={requestsOpen} onRefresh={onRefresh} onAction={onAction} />
              ))}
          </div>
          {(sourceFilter === "local" || sourceFilter === "uploaded" || sourceFilter === "archived") && results.length > 3 && (
            <button className="link-button" onClick={() => setShowAllResults(!showAllResults)}>
              {showAllResults ? "Show fewer" : `View all ${results.length} results`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function SpotifyGroupSection({
  title,
  kind,
  items,
  requestsOpen,
  onRefresh,
  onAction,
  onOpen
}: {
  title: string;
  kind: "track" | "artist" | "album" | "playlist";
  items: Track[];
  requestsOpen?: boolean;
  onRefresh?: () => void;
  onAction?: ActionRunner;
  onOpen?: (track: Track) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const limit = kind === "track" ? 6 : 4;
  const visible = expanded ? items : items.slice(0, limit);
  return (
    <div className="spotify-group">
      <h3 className="spotify-group-title">{title}</h3>
      <div className="result-list">
        {visible.map((track) =>
          kind === "track" ? (
            <SearchResultRow
              key={track.id}
              track={track}
              requestsOpen={Boolean(requestsOpen)}
              onRefresh={onRefresh || (() => {})}
              onAction={onAction || (async (action) => action())}
            />
          ) : (
            <SpotifyBrowseRow key={track.id} track={track} onOpen={() => onOpen?.(track)} />
          )
        )}
      </div>
      {items.length > limit && (
        <button className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `View all ${items.length} ${title.toLowerCase()}`}
        </button>
      )}
    </div>
  );
}

function usableArt(art?: string | null): string | undefined {
  // Only URLs the browser can actually load: http(s) or our proxied "api/..." paths.
  // Spotty hands back relative LMS placeholder paths (e.g. "plugins/Spotty/...") for
  // items with no cover — those 404 against this origin, so treat them as no art.
  if (!art) return undefined;
  return /^(https?:|api\/|\/)/.test(art) ? art : undefined;
}

function FallbackArt({ kind }: { kind?: string }) {
  const Icon = kind === "playlist" ? ListMusic : kind === "artist" ? Radio : Music2;
  return <Icon size={18} className="art-fallback-icon" />;
}

function SpotifyBrowseRow({ track, onOpen }: { track: Track; onOpen: () => void }) {
  const art = usableArt(track.art || track.artwork);
  return (
    <button className="result-row browse-row" onClick={onOpen}>
      <div className="cover-thumb">{art ? <img src={art} alt="" /> : <FallbackArt kind={track.kind} />}</div>
      <div>
        <strong>{track.title}</strong>
        <small>{track.artist || track.album || track.source}</small>
      </div>
      <span className="kind-chip">{track.kind}</span>
      <ChevronRight size={16} />
    </button>
  );
}

function SpotifyDetail({
  detail,
  requestsOpen,
  onBack,
  onRefresh,
  onAction
}: {
  detail: { track: Track; tracks: Track[]; loading: boolean };
  requestsOpen: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onAction: ActionRunner;
}) {
  return (
    <div className="search-detail">
      <div className="playlist-title-row">
        <div>
          <h3>{detail.track.title}</h3>
          <small>{detail.track.artist || detail.track.source} - {detail.track.kind}</small>
        </div>
        <button className="ghost-add" onClick={onBack}>Back</button>
      </div>
      <PlaylistTracks
        title={detail.track.title}
        tracks={detail.tracks}
        loading={detail.loading}
        hasMore={false}
        onLoadMore={() => {}}
        getQueueTracks={async () => detail.tracks}
        requestsOpen={requestsOpen}
        onRefresh={onRefresh}
        onAction={onAction}
      />
    </div>
  );
}

// Overflow menu for a row's secondary actions — keeps the row to one prominent
// primary action + a "More" button, instead of a wall of buttons (esp. on mobile).
function RowMenu({ children, label }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="row-menu" ref={ref}>
      <button ref={triggerRef} className="icon-button" aria-label={label || "More actions"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="row-menu__pop" onClick={(e) => { if ((e.target as HTMLElement).closest(".row-menu__item")) { setOpen(false); triggerRef.current?.focus(); } }}>
          {children}
        </div>
      )}
    </div>
  );
}

function SearchResultRow({ track, requestsOpen, onRefresh, onAction, siblingTracks, getQueueTracks }: { track: Track; requestsOpen: boolean; onRefresh: () => void; onAction: ActionRunner; siblingTracks?: Track[]; getQueueTracks?: () => Promise<Track[] | undefined> }) {
  const { mode } = usePlaybackMode();
  const local = useLocalPlayerContext();
  const isLocal = mode === "local";
  const streamable = Boolean(localStreamUrl(track));
  // Local mode plays anything with a browser stream URL (Spotify, uploaded/VPS
  // files, archived FLACs). Squeezebox mode plays Spotify, LMS-library files,
  // and archived FLACs (the backend streams those to LMS over HTTP).
  const isArchived = String(track.id || "").startsWith("archive:");
  const playable = isLocal ? streamable : (isArchived || !track.kind || track.kind === "track" || Boolean(track.path || track.lmsTrackId));
  const art = usableArt(track.art || track.artwork);
  // Inside a playlist, "play now" scopes the queue to that whole playlist
  // (in order, or shuffled per the shuffle toggle).
  const playlist = siblingTracks && siblingTracks.length > 1 ? siblingTracks : null;

  function run(kind: "play-now" | "play-next" | "add-queue") {
    if (kind === "play-now" && playlist) {
      // Scope playback to the WHOLE collection, not just the loaded page — detail
      // views paginate (50 at a time), so resolve the full queueable list first.
      const sameTrack = (t: Track) => (t.uri && track.uri ? t.uri === track.uri : t.id === track.id);
      const playFull = async () => {
        const full = (getQueueTracks ? await getQueueTracks() : undefined) || playlist;
        const at = Math.max(0, full.findIndex(sameTrack));
        if (isLocal) local.playTracks(full, at);
        else { await playPlaylistFrom(full, at); await onRefresh(); }
      };
      if (isLocal) playFull();
      else onAction(playFull);
      return;
    }
    if (isLocal) {
      if (kind === "play-now") local.playNow(track);
      else if (kind === "play-next") local.playNext(track);
      else local.addToQueue(track);
      return;
    }
    onAction(async () => { await playTrack(kind, track); await onRefresh(); });
  }
  const disabled = isLocal ? false : !requestsOpen;

  return (
    <div className="result-row">
      <div className="cover-thumb">{art ? <img src={art} alt="" /> : <FallbackArt kind={track.kind} />}</div>
      <div>
        <strong>{track.title}</strong>
        <small>
          {track.artist} - {track.album || track.source}
          {track.folder ? ` / ${track.folder}` : ""}
        </small>
      </div>
      <span>{trackDurationLabel(track)}</span>
      <div className="track-actions">
        {playable && <button className="primary-small row-play" disabled={disabled} onClick={() => run("play-now")}><Play size={14} />{isLocal ? "Play here" : "Play"}</button>}
        <RowMenu label={`More actions for ${track.title}`}>
          {playable && <button className="row-menu__item" disabled={disabled} onClick={() => run("play-next")}><ListPlus size={15} /> Play next</button>}
          {playable && <button className="row-menu__item" disabled={disabled} onClick={() => run("add-queue")}><ListMusic size={15} /> Add to queue</button>}
          {playable && <AddToPlaylistButton track={track} />}
          {(!track.kind || track.kind === "track") && (track.uri || track.id)?.toString().includes("spotify:") && <ArchiveTrackButton track={track} />}
          <CurationButtons track={track} onAction={onAction} />
        </RowMenu>
      </div>
    </div>
  );
}

function CurationButtons({ track, onAction }: { track: Track; onAction: ActionRunner }) {
  const [status, setStatus] = useState("");
  if (!hasAdminSession()) return null;

  async function curate(action: "favorite" | "pin" | "hide") {
    const label = action === "favorite" ? "Favorited" : action === "pin" ? "Pinned" : "Hidden";
    await onAction(async () => {
      const curation = await curateLibraryItem(action, track);
      setStatus(label);
      window.setTimeout(() => setStatus(""), 1200);
      return { curation };
    });
  }

  return (
    <>
      <button className="ghost-add icon-text" title="Favorite" onClick={() => curate("favorite")}>
        <Check size={14} /> Favorite
      </button>
      <button className="ghost-add icon-text" title="Pin" onClick={() => curate("pin")}>
        <Pin size={14} /> Pin
      </button>
      <button className="ghost-add icon-text danger-text" title="Hide from library" onClick={() => curate("hide")}>
        <EyeOff size={14} /> Hide
      </button>
      {status && <small className="inline-status">{status}</small>}
    </>
  );
}

function AddToPlaylistButton({ track }: { track: Track }) {
  const [open, setOpen] = useState(false);
  const { playlists, reload } = usePlaylists();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [status, setStatus] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function closeSoon() {
    window.setTimeout(() => {
      setOpen(false);
      setStatus("");
      setCreating(false);
      triggerRef.current?.focus();
    }, 1100);
  }

  async function addTo(id: string) {
    try {
      const result = await addTracksToPlaylist(id, [track]);
      setStatus(result.added > 0 ? "Added" : "Already added");
      notifyPlaylistsChanged();
      closeSoon();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed");
    }
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    try {
      const playlist = await createPlaylist({ name: newName.trim() });
      await addTracksToPlaylist(playlist.id, [track]);
      setNewName("");
      setStatus("Created and added");
      notifyPlaylistsChanged();
      reload();
      closeSoon();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed");
    }
  }

  return (
    <div className="add-to-playlist" ref={ref}>
      <button ref={triggerRef} className="ghost-add" title="Add to playlist" aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => setOpen((value) => !value)}>
        <ListPlus size={14} /> Save
      </button>
      {open && (
        <div className="playlist-popover" id={popId}>
          <div className="playlist-popover-head">
            <strong>Add to playlist</strong>
            {status && <small>{status}</small>}
          </div>
          <div className="playlist-popover-list">
            {playlists.length === 0 && <small className="muted">No playlists yet</small>}
            {playlists.map((playlist) => (
              <button key={playlist.id} className="playlist-popover-item" onClick={() => addTo(playlist.id)}>
                <span>{playlist.name}</span>
                <small>{playlist.trackCount}</small>
              </button>
            ))}
          </div>
          {creating ? (
            <form className="playlist-popover-create" onSubmit={createAndAdd}>
              <input
                autoFocus
                placeholder="New playlist name"
                value={newName}
                maxLength={80}
                onChange={(event) => setNewName(event.currentTarget.value)}
              />
              <button type="submit" className="primary-small">Create</button>
            </form>
          ) : (
            <button className="playlist-popover-new" onClick={() => setCreating(true)}>
              <Plus size={14} /> New playlist
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PlaylistsPanel({ requestsOpen, onRefresh, onAction }: { requestsOpen: boolean; onRefresh: () => void; onAction: ActionRunner }) {
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [source, setSource] = useState<"mine" | "local" | "spotify">("mine");
  const [spotifyType, setSpotifyType] = useState<"playlists" | "albums" | "artists" | "tracks" | "home">("playlists");
  const [spotifyItems, setSpotifyItems] = useState<Track[]>([]);
  const [selectedLocal, setSelectedLocal] = useState<LibraryCollection | null>(null);
  const [selectedSpotify, setSelectedSpotify] = useState<Track | null>(null);
  const [detailTracks, setDetailTracks] = useState<Track[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [hasMoreDetail, setHasMoreDetail] = useState(false);
  const detailPageSize = 50;

  useEffect(() => {
    onAction(async () => {
      setCollections(await fetchCollections());
    });
  }, [onAction]);

  useEffect(() => {
    if (source === "spotify") {
      onAction(async () => {
        setSpotifyItems(await fetchSpotifyLibrary(spotifyType, 80));
      });
    }
  }, [source, spotifyType, onAction]);

  async function openLocal(collection: LibraryCollection) {
    setSelectedSpotify(null);
    setSelectedLocal(collection);
    setDetailTracks([]);
    setHasMoreDetail(false);
    setLoadingDetail(true);
    try {
      const tracks = await onAction(() => fetchCollectionTracks(collection.collection, collection.folder, "all", detailPageSize, 0));
      if (tracks) {
        setDetailTracks(tracks);
        setHasMoreDetail(tracks.length === detailPageSize && tracks.length < collection.count);
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  async function openSpotify(track: Track) {
    if (track.kind === "track") {
      setSelectedLocal(null);
      setSelectedSpotify(track);
      setDetailTracks([track]);
      setHasMoreDetail(false);
      setLoadingDetail(false);
      return;
    }
    setSelectedLocal(null);
    setSelectedSpotify(track);
    setDetailTracks([]);
    setHasMoreDetail(false);
    setLoadingDetail(true);
    try {
      const tracks = await onAction(() => fetchSpotifyChildren(track, detailPageSize, 0));
      if (tracks) {
        setDetailTracks(tracks);
        setHasMoreDetail(tracks.length === detailPageSize);
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  async function loadMoreDetail() {
    if (!selectedLocal && !selectedSpotify) return;
    setLoadingDetail(true);
    try {
      const offset = detailTracks.length;
      const tracks = selectedLocal
        ? await onAction(() => fetchCollectionTracks(selectedLocal.collection, selectedLocal.folder, "all", detailPageSize, offset))
        : await onAction(() => fetchSpotifyChildren(selectedSpotify || {}, detailPageSize, offset));
      if (tracks) {
        setDetailTracks((current) => [...current, ...tracks]);
        const totalLoaded = offset + tracks.length;
        setHasMoreDetail(tracks.length === detailPageSize && (!selectedLocal || totalLoaded < selectedLocal.count));
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  async function queueableDetailTracks() {
    const queueLimit = 200;
    if (selectedLocal) {
      return fetchCollectionTracks(selectedLocal.collection, selectedLocal.folder, "all", queueLimit, 0);
    }
    if (selectedSpotify && selectedSpotify.kind !== "track") {
      return fetchSpotifyChildren(selectedSpotify, queueLimit, 0);
    }
    return detailTracks;
  }

  const selectedTitle = selectedLocal?.folder || selectedSpotify?.title || "";
  const selectedSubtitle = selectedLocal?.collection || selectedSpotify?.artist || selectedSpotify?.source || "";

  return (
    <section className="panel playlist-panel" aria-label="Playlists">
      {source !== "mine" && (
        <div className="playlist-title-row">
          <div>
            <h2>{selectedTitle ? selectedTitle : "Collections"}</h2>
            {selectedTitle && <small>{selectedSubtitle}</small>}
          </div>
          {selectedTitle && (
            <button
              className="ghost-add"
              onClick={() => {
                setSelectedLocal(null);
                setSelectedSpotify(null);
                setDetailTracks([]);
                setHasMoreDetail(false);
              }}
            >
              Back
            </button>
          )}
        </div>
      )}
      <div className="source-tabs">
        <button className={source === "mine" ? "primary-small" : ""} aria-pressed={source === "mine"} onClick={() => { setSource("mine"); setSelectedLocal(null); setSelectedSpotify(null); setDetailTracks([]); }}>
          My Playlists
        </button>
        <button className={source === "local" ? "primary-small" : ""} aria-pressed={source === "local"} onClick={() => { setSource("local"); setSelectedSpotify(null); setDetailTracks([]); }}>
          Local
        </button>
        <button className={source === "spotify" ? "primary-small" : ""} aria-pressed={source === "spotify"} onClick={() => { setSource("spotify"); setSelectedLocal(null); setDetailTracks([]); }}>
          Spotify
        </button>
      </div>
      {source === "mine" && <AppPlaylistsView requestsOpen={requestsOpen} onRefresh={onRefresh} onAction={onAction} />}
      {source === "spotify" && !selectedTitle && (
        <div className="suggestion-row" aria-label="Spotify playlist filters">
          {(["playlists", "albums", "artists", "tracks", "home"] as const).map((type) => (
            <button key={type} className={spotifyType === type ? "is-selected" : ""} aria-pressed={spotifyType === type} onClick={() => setSpotifyType(type)}>
              {type}
            </button>
          ))}
        </div>
      )}
      {selectedTitle && (
        <PlaylistTracks
          title={selectedTitle}
          tracks={detailTracks}
          loading={loadingDetail}
          hasMore={hasMoreDetail}
          onLoadMore={loadMoreDetail}
          getQueueTracks={queueableDetailTracks}
          requestsOpen={requestsOpen}
          onRefresh={onRefresh}
          onAction={onAction}
        />
      )}
      {!selectedTitle && source === "local" && collections.length === 0 && (
        <EmptyState title="No collections found" detail="Import music folders or rescan the LMS library." />
      )}
      {!selectedTitle && source === "spotify" && spotifyItems.length === 0 && (
        <EmptyState title="No Spotify items found" detail="Spotty did not return items for this library section yet." />
      )}
      {!selectedTitle && source === "local" && <div className="collection-list">
        {collections.map((item) => (
          <button className="collection-row" key={`${item.collection}-${item.folder}`} onClick={() => openLocal(item)}>
            <div className="cover-thumb">{item.art && <img src={item.art} alt="" />}</div>
            <div>
              <strong>{item.folder}</strong>
              <small>{item.collection}</small>
              <small>{item.sample.join(", ")}</small>
            </div>
            <span>{item.count} tracks</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>}
      {!selectedTitle && source === "spotify" && <div className="collection-list">
        {spotifyItems.map((track) => (
          <button className="collection-row spotify-collection" key={track.id} onClick={() => openSpotify(track)}>
            <div className="cover-thumb">{track.art && <img src={track.art} alt="" />}</div>
            <div>
              <strong>{track.title}</strong>
              <small>{track.artist || track.album || track.source}</small>
            </div>
            <span>{track.kind || "spotify"}</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>}
    </section>
  );
}

function AppPlaylistsView({ requestsOpen, onRefresh, onAction }: { requestsOpen: boolean; onRefresh: () => void; onAction: ActionRunner }) {
  const { playlists, reload } = usePlaylists();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const isAdmin = hasAdminSession();

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setLoading(true);
    try {
      setDetail(await fetchPlaylist(id));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const listener = () => {
      fetchPlaylist(selectedId).then((playlist) => {
        if (playlist) setDetail(playlist);
      });
    };
    playlistListeners.add(listener);
    return () => {
      playlistListeners.delete(listener);
    };
  }, [selectedId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    setError("");
    try {
      const playlist = await createPlaylist({ name: newName.trim() });
      setNewName("");
      setCreating(false);
      notifyPlaylistsChanged();
      reload();
      openDetail(playlist.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create playlist");
    }
  }

  if (selectedId) {
    return (
      <AppPlaylistDetail
        playlist={detail}
        loading={loading}
        isAdmin={isAdmin}
        requestsOpen={requestsOpen}
        onBack={() => {
          setSelectedId(null);
          setDetail(null);
        }}
        onRefresh={onRefresh}
        onAction={onAction}
        onChanged={(playlist) => {
          setDetail(playlist);
          notifyPlaylistsChanged();
        }}
        onDeleted={() => {
          setSelectedId(null);
          setDetail(null);
          notifyPlaylistsChanged();
          reload();
        }}
      />
    );
  }

  return (
    <div className="app-playlists">
      <div className="playlist-create-row">
        <button className="primary-small" onClick={() => setCreating(true)}>
          <Plus size={16} /> New playlist
        </button>
      </div>
      {creating && (
        <Dialog
          title="New playlist"
          confirmLabel="Create"
          confirmDisabled={!newName.trim()}
          onConfirm={create}
          onClose={() => { setCreating(false); setNewName(""); setError(""); }}
        >
          <label>
            <span>Playlist name</span>
            <input
              className="dialog-field"
              placeholder="Playlist name"
              maxLength={80}
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
          </label>
          {error && <small className="form-error">{error}</small>}
        </Dialog>
      )}
      {error && <small className="form-error">{error}</small>}
      {playlists.length === 0 && (
        <EmptyState title="No playlists yet" detail="Create a playlist, then add songs from search or Spotify with the Save button." />
      )}
      <div className="collection-list">
        {playlists.map((playlist) => (
          <button className="collection-row" key={playlist.id} onClick={() => openDetail(playlist.id)}>
            <div className="cover-thumb">{playlist.art && <img src={playlist.art} alt="" />}</div>
            <div>
              <strong>{playlist.name}</strong>
              <small>{playlist.description || playlist.sample.join(", ") || "Empty playlist"}</small>
            </div>
            <span>{playlist.trackCount} tracks</span>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

function AppPlaylistDetail({
  playlist,
  loading,
  isAdmin,
  requestsOpen,
  onBack,
  onRefresh,
  onAction,
  onChanged,
  onDeleted
}: {
  playlist: Playlist | null;
  loading: boolean;
  isAdmin: boolean;
  requestsOpen: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onAction: ActionRunner;
  onChanged: (playlist: Playlist) => void;
  onDeleted: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { mode } = usePlaybackMode();
  const local = useLocalPlayerContext();
  const isLocal = mode === "local";

  useEffect(() => {
    setName(playlist?.name || "");
  }, [playlist?.id]);

  if (loading || !playlist) {
    return (
      <div className="app-playlist-detail">
        <div className="playlist-title-row">
          <h3>Opening playlist</h3>
          <button className="ghost-add" onClick={onBack}>Back</button>
        </div>
        <EmptyState title="Opening playlist" detail="Loading songs." />
      </div>
    );
  }

  const current = playlist;
  const isEmpty = current.tracks.length === 0;
  const hasLocalPlayable = current.tracks.some((track) => localStreamUrl(track));

  async function queueAll(action: "add-queue" | "play-next") {
    if (isLocal) {
      // Browser playback: enqueue the streamable tracks directly. Reverse the
      // play-next list so it lands in order right after the current track.
      const playable = current.tracks.slice(0, 200).filter((track) => localStreamUrl(track));
      if (action === "play-next") {
        // With an empty queue, playNext auto-plays the first inserted item, so a
        // reversed loop would start the last track. Seed the queue in order instead.
        if (local.index < 0) local.playTracks(playable, 0);
        else [...playable].reverse().forEach((track) => local.playNext(track));
      } else playable.forEach((track) => local.addToQueue(track));
      return;
    }
    await onAction(async () => {
      const playableTracks = current.tracks.slice(0, 200);
      const result = await playTracks(action, playableTracks);
      await onRefresh();
      if (result?.rejected > 0) {
        const skipped = result.rejected;
        const total = Number(result.accepted || 0) + skipped || playableTracks.length;
        throw new Error(`Queued ${result.accepted} of ${total} tracks; ${skipped} skipped because of the queue limit or duplicates.`);
      }
    });
  }

  function playRow(track: Track, index: number) {
    if (isLocal) { local.playTracks(current.tracks, index); return; }
    // Scope the Squeezebox queue to the whole playlist starting here (not a lone track).
    onAction(async () => { await playPlaylistFrom(current.tracks, index); await onRefresh(); });
  }

  function queueRow(track: Track) {
    if (isLocal) { local.addToQueue(track); return; }
    onAction(async () => { await playTrack("add-queue", track); await onRefresh(); });
  }

  async function doRename(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onChanged(await renamePlaylist(current.id, { name: name.trim() }));
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(event: FormEvent) {
    event.preventDefault();
    setDeleting(true);
    setError("");
    try {
      await deletePlaylist(current.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setDeleting(false);
    }
  }

  async function remove(track: Track) {
    try {
      onChanged(await removePlaylistTrack(current.id, playlistTrackKey(track)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove track");
    }
  }

  async function move(track: Track, direction: "up" | "down") {
    try {
      onChanged(await movePlaylistTrack(current.id, playlistTrackKey(track), direction));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reorder");
    }
  }

  return (
    <div className="app-playlist-detail">
      <div className="playlist-title-row">
        <div>
          <h3>{current.name}</h3>
          <small>{current.tracks.length} tracks{current.description ? ` - ${current.description}` : ""}</small>
        </div>
        <button className="ghost-add" onClick={onBack}>Back</button>
      </div>
      <div className="playlist-detail-actions">
        <button className="ghost-add" disabled={isLocal ? !hasLocalPlayable : (!requestsOpen || isEmpty)} onClick={() => queueAll("play-next")}>Play next</button>
        <button className="ghost-add" disabled={isLocal ? !hasLocalPlayable : (!requestsOpen || isEmpty)} onClick={() => queueAll("add-queue")}>Queue all</button>
        {isAdmin && (
          <button className="ghost-add" onClick={() => setRenaming(true)}>
            <Pencil size={14} /> Rename
          </button>
        )}
        {isAdmin && (
          <button className="ghost-add danger" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>
      {renaming && (
        <Dialog
          title="Rename playlist"
          confirmLabel="Save"
          busy={busy}
          confirmDisabled={!name.trim()}
          onConfirm={doRename}
          onClose={() => { setRenaming(false); setName(current.name); setError(""); }}
        >
          <label>
            <span>Playlist name</span>
            <input
              className="dialog-field"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {error && <small className="form-error">{error}</small>}
        </Dialog>
      )}
      {deleteOpen && (
        <Dialog
          title="Delete playlist"
          confirmLabel="Delete"
          busy={deleting}
          busyLabel="Deleting..."
          onConfirm={doDelete}
          onClose={() => { setDeleteOpen(false); setError(""); }}
        >
          <p>Delete "{current.name}"? This removes the playlist, but not the songs in your library.</p>
          {error && <small className="form-error">{error}</small>}
        </Dialog>
      )}
      {error && <small className="form-error">{error}</small>}
      {isEmpty && <EmptyState title="Empty playlist" detail="Add songs from search or Spotify using the Save button." />}
      <div className="result-list">
        {current.tracks.map((track, index) => (
          <div className="result-row" key={playlistTrackKey(track) || index}>
            <div className="cover-thumb">{(track.art || track.artwork) && <img src={track.art || track.artwork || ""} alt="" />}</div>
            <div>
              <strong>{track.title}</strong>
              <small>{track.artist} - {track.album || track.source}</small>
            </div>
            <span>{trackDurationLabel(track)}</span>
            <div className="track-actions">
              <button className="primary-small row-play" disabled={isLocal ? !localStreamUrl(track) : !requestsOpen} onClick={() => playRow(track, index)}><Play size={14} />{isLocal ? "Play here" : "Play"}</button>
              <RowMenu label={`More actions for ${track.title}`}>
                <button className="row-menu__item" disabled={isLocal ? !localStreamUrl(track) : !requestsOpen} onClick={() => queueRow(track)}>
                  <ListMusic size={15} /> Add to queue
                </button>
                {isAdmin && (
                  <button className="row-menu__item" disabled={index === 0} onClick={() => move(track, "up")}>
                    <ChevronUp size={15} /> Move up
                  </button>
                )}
                {isAdmin && (
                  <button className="row-menu__item" disabled={index === current.tracks.length - 1} onClick={() => move(track, "down")}>
                    <ChevronDown size={15} /> Move down
                  </button>
                )}
                {isAdmin && (
                  <button className="row-menu__item danger" onClick={() => remove(track)}>
                    <XCircle size={15} /> Remove
                  </button>
                )}
              </RowMenu>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaylistTracks({
  title,
  tracks,
  loading,
  hasMore,
  onLoadMore,
  getQueueTracks,
  requestsOpen,
  onRefresh,
  onAction
}: {
  title: string;
  tracks: Track[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  getQueueTracks: () => Promise<Track[] | undefined>;
  requestsOpen: boolean;
  onRefresh: () => void;
  onAction: ActionRunner;
}) {
  const { mode } = usePlaybackMode();
  const local = useLocalPlayerContext();
  const isLocal = mode === "local";
  const hasLocalPlayable = tracks.some((track) => localStreamUrl(track));

  async function queueAll(action: "add-queue" | "play-next") {
    if (isLocal) {
      await onAction(async () => {
        const queueTracks = await getQueueTracks();
        const playable = (queueTracks || tracks).filter((item) => localStreamUrl(item)).slice(0, 200);
        if (action === "play-next") {
          // Empty queue: playNext would auto-play the (reversed) last item first.
          if (local.index < 0) local.playTracks(playable, 0);
          else [...playable].reverse().forEach((track) => local.playNext(track));
        } else playable.forEach((track) => local.addToQueue(track));
      });
      return;
    }
    await onAction(async () => {
      const queueTracks = await getQueueTracks();
      const playableTracks = (queueTracks || tracks).filter((item) => !item.kind || item.kind === "track").slice(0, 200);
      const result = await playTracks(action, playableTracks);
      await onRefresh();
      if (result?.rejected > 0) {
        const skipped = result.rejected;
        const total = Number(result.accepted || 0) + skipped || playableTracks.length;
        throw new Error(`Queued ${result.accepted} of ${total} tracks; ${skipped} skipped because of the queue limit or duplicates.`);
      }
    });
  }

  return (
    <div className="playlist-detail" aria-label={`${title} tracks`}>
      <div className="playlist-detail-actions">
        <span>{loading ? "Loading tracks" : `${tracks.length} tracks`}</span>
        <button className="ghost-add" disabled={isLocal ? !hasLocalPlayable : (!requestsOpen || tracks.length === 0)} onClick={() => queueAll("play-next")}>Play next</button>
        <button className="ghost-add" disabled={isLocal ? !hasLocalPlayable : (!requestsOpen || tracks.length === 0)} onClick={() => queueAll("add-queue")}>Queue all</button>
      </div>
      {loading && <EmptyState title="Opening playlist" detail="Loading songs from the selected collection." />}
      {!loading && tracks.length === 0 && <EmptyState title="No songs found" detail="This playlist did not expose tracks yet." />}
      <div className="result-list">
        {tracks.map((track) => (
          <SearchResultRow key={track.id} track={track} requestsOpen={requestsOpen} onRefresh={onRefresh} onAction={onAction} siblingTracks={tracks} getQueueTracks={getQueueTracks} />
        ))}
      </div>
      {hasMore && (
        <button className="ghost-add load-more" disabled={loading} onClick={onLoadMore}>
          Load more
        </button>
      )}
    </div>
  );
}

function RightRail({ state }: { state: AppState }) {
  const musicInfo = state.services.musicInfo || {
    configured: false,
    detail: "Enable the Music and Artist Information plugin in LMS for artist bios, album reviews, and lyrics."
  };
  const trackInfo = state.trackInfo || {
    artistBio: "Connect a player and enable the LMS Music and Artist Information plugin.",
    albumReview: "No album review available yet.",
    lyrics: "Lyrics will appear when available."
  };
  const hasAutoInfo = Boolean(trackInfo.artistBio || trackInfo.albumReview || trackInfo.lyrics);
  return (
    <aside className="right-rail">
      <section className="panel schedule-card" aria-label="Track information">
        <h2>Track information</h2>
        <small>MusicBrainz, lyrics lookup, LMS plugin</small>
        <h3>{musicInfo.configured ? "LMS plugin ready" : hasAutoInfo ? "Auto track info active" : "Track info pending"}</h3>
        <p>
          {musicInfo.configured
            ? musicInfo.detail
            : "The LMS plugin is not reporting as enabled, so this site is using automatic artist and lyrics lookup from the current track title."}
        </p>
        <div className="soft-divider" />
        <small>Artist bio</small>
        <p>{trackInfo.artistBio}</p>
      </section>
      <section className="panel rules-card" aria-label="Album and lyrics">
        <h2>Album and lyrics</h2>
        {trackInfo.art && <img className="info-artwork" src={trackInfo.art} alt="" />}
        <div className="info-block">
          <strong>Album review</strong>
          <small>{trackInfo.albumReview}</small>
        </div>
        <div className="info-block">
          <strong>Lyrics</strong>
          <small>{trackInfo.lyrics}</small>
        </div>
      </section>
    </aside>
  );
}

function RecentPicks({ picks }: { picks: AppState["recentPicks"] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? picks : picks.slice(0, 6);
  return (
    <section className="recent-picks">
      <div>
        <span>Recent picks</span>
        <button disabled={picks.length <= 6} aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show less" : "View all"}
        </button>
      </div>
      {picks.length === 0 && <p className="empty-sidebar">No recent picks yet.</p>}
      {visible.map((pick) => (
        <div className="recent-row" key={`${pick.title}-${pick.status}`}>
          <Music2 size={17} />
          <div>
            <strong>{pick.title}</strong>
            <small>{pick.artist}</small>
          </div>
          <span>{pick.status}</span>
        </div>
      ))}
    </section>
  );
}

function AdminPage({ state, onSave }: { state: AppState; onSave: () => void }) {
  const [authenticated, setAuthenticated] = useState(hasAdminSession);

  // A stored token can outlive the server's in-memory session (TTL / restart);
  // verify it on mount and drop back to login instead of showing dead controls.
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    validateAdminSession().then((ok) => { if (!ok && !cancelled) setAuthenticated(false); });
    return () => { cancelled = true; };
  }, [authenticated]);

  if (!authenticated) {
    return <AdminLogin onLogin={() => setAuthenticated(true)} />;
  }

  return <AdminConsole state={state} onSave={onSave} onLogout={() => setAuthenticated(false)} />;
}

function AdminLogin({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await loginAdmin(password);
      onLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed");
    }
  }

  return (
    <form className="panel login-panel" onSubmit={submit}>
      <LockKeyhole size={28} />
      <h2>Admin login</h2>
      <p>Use the Squeezebox Cloud admin password to manage providers, library scans, and public controls.</p>
      <label>
        <span>Password</span>
        <input
          aria-label="Admin password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          autoComplete="current-password"
        />
      </label>
      {error && <small className="form-error">{error}</small>}
      <button className="primary" type="submit">
        <LockKeyhole size={18} />
        Log in
      </button>
    </form>
  );
}

function AdminConsole({ state, onSave, onLogout }: { state: AppState; onSave: () => void; onLogout: () => void }) {
  const [settings, setSettings] = useState(state.admin);
  const [connectionGuide, setConnectionGuide] = useState<ConnectionGuide | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [saveError, setSaveError] = useState("");

  async function handleSaveSettings() {
    setSaveError("");
    try {
      await saveAdminSettings(settings);
      onSave();
    } catch (err) {
      // A failed save is usually an expired/restarted admin session — verify and
      // bounce to login if it's gone, otherwise surface the real error.
      if (!(await validateAdminSession())) { onLogout(); return; }
      setSaveError(err instanceof Error ? err.message : "Could not save settings");
    }
  }
  const musicInfo = state.services.musicInfo || { configured: false, detail: "Not checked yet" };
  const serviceRows = useMemo(
    () => [
      { label: "Speaker", ok: state.player.connected, detail: state.player.detail || state.player.name, action: checkSpeaker },
      { label: "Spotify", ok: state.services.spotify.configured && state.services.spotify.reachable !== false, detail: state.services.spotify.detail, action: setupSpotify },
      { label: "Music info", ok: musicInfo.configured, detail: musicInfo.detail, action: checkMusicInfo },
      {
        label: "Local library",
        ok: state.services.localLibrary.reachable,
        detail: `${state.services.localLibrary.trackCount} tracks from ${state.services.localLibrary.root}`,
        action: rescanLibrary
      }
    ],
    [state, musicInfo]
  );

  async function setupSpotify() {
    const setup = await getSpotifyConnect();
    window.open(setup.setupUrl, "_blank", "noopener,noreferrer");
    return checkSpotify();
  }

  async function checkConnection() {
    setCheckingConnection(true);
    try {
      setConnectionGuide(await fetchConnectionGuide());
      await onSave();
    } finally {
      setCheckingConnection(false);
    }
  }

  return (
    <div className="admin-grid">
      <ConnectionPipeline
        guide={connectionGuide}
        player={state.player}
        checking={checkingConnection}
        onCheck={checkConnection}
      />
      <section className="panel admin-panel">
        <h2>Service providers</h2>
        {serviceRows.map((row) => (
          <div className="admin-row" key={row.label}>
            {row.ok ? <CheckCircle2 className="ok" size={20} /> : <XCircle className="bad" size={20} />}
            <div>
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </div>
            <button onClick={() => row.action().then(onSave)}>{row.label === "Spotify" ? "Open setup" : "Check"}</button>
          </div>
        ))}
        <div className="admin-help">
          <strong>Spotify setup</strong>
          <small>Enable the LMS Spotty plugin, authorize Spotify there, then return here and check again.</small>
        </div>
      </section>
      <section className="panel admin-panel">
        <div className="panel-title-row">
          <h2>Public controls</h2>
          <button
            onClick={() => {
              clearAdminSession();
              onLogout();
              window.location.assign(import.meta.env.BASE_URL);
            }}
          >
            Log out
          </button>
        </div>
        <label className="setting-row">
          <span>Public requests</span>
          <input
            type="checkbox"
            checked={settings.publicRequests}
            onChange={(event) => setSettings({ ...settings, publicRequests: event.currentTarget.checked })}
          />
        </label>
        <label className="setting-row">
          <span>Max queue per user</span>
          <input
            type="number"
            min="1"
            max="25"
            value={settings.maxQueuePerUser}
            onChange={(event) => setSettings({ ...settings, maxQueuePerUser: Math.min(25, Math.max(1, Number(event.currentTarget.value) || 1)) })}
          />
        </label>
        <button className="primary" onClick={handleSaveSettings}>
          <SlidersHorizontal size={18} />
          Save settings
        </button>
        {saveError && <small className="form-error">{saveError}</small>}
      </section>
    </div>
  );
}

function ConnectionPipeline({
  guide,
  player,
  checking,
  onCheck
}: {
  guide: ConnectionGuide | null;
  player: AppState["player"];
  checking: boolean;
  onCheck: () => void;
}) {
  const serverHost = guide?.serverHost || "23.17.17.81";
  const lanServerHost = guide?.lanServerHost || "192.168.1.142";
  const connected = guide?.player.connected ?? player.connected;
  const lmsReachable = guide?.lmsWeb.reachable ?? player.online;

  return (
    <section className="panel admin-panel wide connection-panel">
      <div className="panel-title-row">
        <div>
          <h2>Connect speaker</h2>
          <p>Point the Squeezebox at the VPS library, then verify that LMS sees it.</p>
        </div>
        <button className="primary" onClick={onCheck} disabled={checking}>
          <Radio size={18} />
          {checking ? "Checking" : "Check connection"}
        </button>
      </div>

      <div className="connect-grid">
        <div className="server-card">
          <small>Use this IP on same Wi-Fi</small>
          <strong>{lanServerHost}</strong>
          <span>Squeezebox Server IP address</span>
        </div>
        <div className="server-card">
          <small>Use this IP remotely</small>
          <strong>{serverHost}</strong>
          <span>{guide?.lmsWebUrl || "http://23.17.17.81:9000"}</span>
        </div>
        <div className="connect-status">
          <StatusPill ok={lmsReachable} label={lmsReachable ? "LMS reachable" : "LMS not reachable"} />
          <StatusPill ok={connected} label={connected ? "Speaker connected" : "No speaker yet"} />
        </div>
      </div>

      <ol className="connect-steps">
        {(guide?.steps || [
          "Connect the Squeezebox to Wi-Fi or Ethernet.",
          "Open the Squeezebox Server option.",
          "Enter the local IP if the box is on the same network, or the public IP after port forwarding is enabled.",
          "Connect to that library, then press Check connection here."
        ]).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="port-row">
        {(guide?.ports || [
          { port: 9000, label: "LMS web and player HTTP" },
          { port: 3483, label: "Squeezebox discovery and streaming" }
        ]).map((port) => (
          <div key={port.port}>
            <strong>{port.port}</strong>
            <small>{port.label}</small>
          </div>
        ))}
      </div>
      <p className="quiet-note">
        The Squeezebox field accepts only the IP address. Do not include http:// or :9000.
      </p>
    </section>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status-pill ${ok ? "is-ok" : "is-bad"}`}>
      {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      {label}
    </span>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

// What to show in a track row's trailing cell. Non-track rows (album/playlist/artist)
// show their kind. A known duration shows the time. A genuinely-unknown duration
// (e.g. a Spotify search result LMS hasn't cached a length for) shows nothing rather
// than a broken "--:--" — honest and far less ugly in a long list.
function trackDurationLabel(track: Track): string {
  if (track.kind && track.kind !== "track") return track.kind;
  if (track.duration && track.duration > 0) return formatTime(track.duration);
  return "";
}

function publicRequestsOpen(state: AppState) {
  // Mirror the server (server/app.js publicRequestsOpen): a paused schedule window
  // only closes requests while scheduling is actually enabled.
  return (
    state.admin.publicRequests !== false &&
    !(state.admin.scheduleEnabled && state.schedule.current?.requestsPaused)
  );
}
