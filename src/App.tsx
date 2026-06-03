import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Cloud,
  Check,
  ChevronDown,
  ChevronUp,
  ListMusic,
  LockKeyhole,
  Music2,
  Pause,
  Play,
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
  Volume2,
  XCircle
} from "lucide-react";
import {
  checkMusicInfo,
  checkSpeaker,
  checkSpotify,
  fetchCollectionTracks,
  clearAdminSession,
  fetchCollections,
  fetchConnectionGuide,
  fetchSpotifyChildren,
  fetchSpotifyLibrary,
  fetchState,
  getSpotifyConnect,
  hasAdminSession,
  loginAdmin,
  moveQueueItem,
  playerAction,
  playTrack,
  playTracks,
  removeQueueItem,
  rescanLibrary,
  saveAdminSettings,
  savePlayback,
  searchLibrary,
  searchSpotify,
  seekPlayer,
  setPlayerVolume,
  updateQueueItem,
  uploadTrack,
} from "./lib/api";
import type { AppState, ConnectionGuide, LibraryCollection, Track } from "./types";
import "./styles.css";

const spotifyRecommendationQuery = "drake";
const spotifySuggestionTerms = ["drake", "juice wrld", "the weeknd", "travis scott"];

const navItems = [
  { label: "Now Playing", icon: Music2 },
  { label: "Queue", icon: ListMusic },
  { label: "Playlists", icon: Music2 },
  { label: "Library", icon: Search }
];

type PublicScreenName = (typeof navItems)[number]["label"];
type ActionRunner = <T>(action: () => Promise<T>) => Promise<T | undefined>;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [activeScreen, setActiveScreen] = useState<PublicScreenName>("Now Playing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [sourceFilter, setSourceFilter] = useState<"local" | "uploaded" | "spotify" | "playlists">("local");
  const [actionError, setActionError] = useState("");
  const isAdminRoute = window.location.pathname.replace(/\/$/, "").endsWith("/admin");

  const refresh = useCallback(async () => {
    setState(await fetchState());
  }, []);

  const runAction = useCallback(async <T,>(action: () => Promise<T>) => {
    setActionError("");
    try {
      return await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Action failed");
      return undefined;
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
    const timer = window.setTimeout(async () => {
      let nextResults: Track[] = [];
      if (sourceFilter === "spotify") {
        nextResults = await searchSpotify(query.trim() || spotifyRecommendationQuery, 50);
      } else {
        nextResults = sourceFilter === "local" || sourceFilter === "uploaded" ? await searchLibrary(query, 2000, sourceFilter) : [];
      }
      if (!cancelled) setResults(nextResults);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, sourceFilter]);

  if (!state) return <div className="boot">Squeezebox Cloud</div>;

  const speakerOnline = state.player.connected && state.player.online;

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
              key={item.label}
              onClick={() => setActiveScreen(item.label)}
            >
              <item.icon size={20} />
              {item.label}
            </button>
          ))}
        </nav>
        <RecentPicks picks={state.recentPicks} />
        <div className="speaker-card">
          <span className={speakerOnline ? "status-dot online" : "status-dot offline"} />
          <div>
            <strong>{speakerOnline ? "Speaker online" : "Speaker offline"}</strong>
            <small>{speakerOnline ? state.player.name : state.player.detail || "LMS player not connected"}</small>
          </div>
          <Radio size={22} />
        </div>
      </aside>
      <main className="main">
        <header className="hero-row">
          {isAdminRoute ? <h1>Admin Console</h1> : <div />}
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
            setQuery={setQuery}
            sourceFilter={sourceFilter}
            setSourceFilter={setSourceFilter}
            onRefresh={refresh}
            onAction={runAction}
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
  setQuery,
  sourceFilter,
  setSourceFilter,
  onRefresh,
  onAction,
  onPlayerAction
}: {
  state: AppState;
  activeScreen: PublicScreenName;
  query: string;
  results: Track[];
  setQuery: (value: string) => void;
  sourceFilter: "local" | "uploaded" | "spotify" | "playlists";
  setSourceFilter: (value: "local" | "uploaded" | "spotify" | "playlists") => void;
  onRefresh: () => void;
  onAction: ActionRunner;
  onPlayerAction: (action: "play" | "pause" | "stop" | "next" | "previous") => Promise<unknown>;
}) {
  const commonSearch = (
    <SearchPanel
      query={query}
      setQuery={setQuery}
      results={results}
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
        <QueuePanel queue={state.queue} onRefresh={onRefresh} onAction={onAction} />
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
        <PlaylistsPanel onRefresh={onRefresh} onAction={onAction} />
        <RightRail state={state} />
      </div>
    );
  }

  const hasTrack = state.nowPlaying.id !== "idle" && (state.nowPlaying.duration || 0) > 0;
  const controlsDisabled = !state.player.connected;
  return (
    <div className="content-grid">
      <NowPlayingPanel state={state} hasTrack={hasTrack} controlsDisabled={controlsDisabled} onRefresh={onRefresh} onAction={onAction} onPlayerAction={onPlayerAction} />

      <QueuePanel queue={state.queue} onRefresh={onRefresh} onAction={onAction} />

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
            <PlaybackOptions state={state} disabled={controlsDisabled} onRefresh={onRefresh} onAction={onAction} />
            <VolumeControl volume={state.player.volume} onChange={(volume) => onAction(async () => { await setPlayerVolume(volume); await onRefresh(); })} />
            {!hasTrack && <p className="empty-copy">No live track yet. Connect the Squeezebox or add a local-library song.</p>}
          </div>
        </div>
      </section>
  );
}

function PlaybackOptions({ state, disabled, onRefresh, onAction }: { state: AppState; disabled: boolean; onRefresh: () => void; onAction: ActionRunner }) {
  const playback = state.playback || { shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed" as const };
  const repeatIcon = playback.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />;
  const shuffleLabel = playback.smartQueue ? "Smart shuffle" : playback.shuffle ? "Shuffle on" : "Shuffle";

  async function setRepeat() {
    const next = playback.repeat === "off" ? "all" : playback.repeat === "all" ? "one" : "off";
    await onAction(async () => {
      await savePlayback({ repeat: next });
      await onRefresh();
    });
  }

  async function cycleShuffle() {
    const next =
      playback.smartQueue
        ? { shuffle: false, smartQueue: false }
        : playback.shuffle
          ? { shuffle: false, smartQueue: true }
          : { shuffle: true, smartQueue: false };
    await onAction(async () => {
      await savePlayback(next);
      await onRefresh();
    });
  }

  async function setSource(source: AppState["playback"]["smartShuffleSource"]) {
    await onAction(async () => {
      await savePlayback({ smartShuffleSource: source });
      await onRefresh();
    });
  }

  return (
    <div className="playback-options" aria-label="Playback options">
      <button
        className={playback.shuffle || playback.smartQueue ? "active-option" : ""}
        disabled={disabled}
        title="Cycles between shuffle, smart shuffle, and off"
        onClick={cycleShuffle}
      >
        <Shuffle size={17} />
        {shuffleLabel}
      </button>
      <button className={playback.repeat !== "off" ? "active-option" : ""} disabled={disabled} title="Repeat off, all, or one" onClick={setRepeat}>
        {repeatIcon}
        {playback.repeat === "off" ? "Repeat" : playback.repeat === "one" ? "Repeat 1" : "Repeat all"}
      </button>
      <div className="shuffle-source" aria-label="Smart shuffle source">
        {(["mixed", "spotify", "local"] as const).map((source) => (
          <button key={source} className={playback.smartShuffleSource === source ? "active-option" : ""} disabled={disabled} onClick={() => setSource(source)}>
            {source}
          </button>
        ))}
      </div>
    </div>
  );
}

function AlbumArt({ track }: { track: Track }) {
  const empty = track.id === "idle";
  return (
    <div className={`album-art ${empty ? "is-empty" : ""}`}>
      {track.art ? (
        <img src={track.art} alt={`${track.album || track.title} cover`} />
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
  }, [elapsed, dragging]);

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
      <div>
        <span>{formatTime(value)}</span>
        <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
      </div>
    </div>
  );
}

function VolumeControl({ volume, onChange }: { volume: number; onChange: (volume: number) => void }) {
  return (
    <div className="volume-row">
      <Volume2 size={20} />
      <input
        aria-label="Volume"
        type="range"
        min="0"
        max="100"
        value={volume}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span>{volume}%</span>
    </div>
  );
}

function QueuePanel({ queue, onRefresh, onAction }: { queue: AppState["queue"]; onRefresh: () => void; onAction: ActionRunner }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", artist: "", requestedBy: "" });

  function beginEdit(item: AppState["queue"][number]) {
    setEditingId(item.id);
    setDraft({ title: item.title, artist: item.artist, requestedBy: item.requestedBy });
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
        {queue.slice(0, 12).map((item, index) => (
          <div className={`queue-row ${editingId === item.id ? "is-editing" : ""}`} key={item.id}>
            <div className="mini-art">
              {item.art ? <img src={item.art} alt="" /> : <Music2 size={18} />}
            </div>
            {editingId === item.id ? (
              <div className="queue-edit-fields">
                <small>Editing queue item</small>
                <input aria-label="Queue title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
                <input aria-label="Queue artist" value={draft.artist} onChange={(event) => setDraft({ ...draft, artist: event.currentTarget.value })} />
                <input aria-label="Requested by" value={draft.requestedBy} onChange={(event) => setDraft({ ...draft, requestedBy: event.currentTarget.value })} />
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
              <button aria-label={`Move ${item.title} up`} title="Move earlier in queue" data-tooltip="Move earlier" className="icon-button" disabled={index === 0} onClick={() => onAction(async () => { await moveQueueItem(item.id, "up"); await onRefresh(); })}>
                <ChevronUp size={16} />
              </button>
              <button aria-label={`Move ${item.title} down`} title="Move later in queue" data-tooltip="Move later" className="icon-button" disabled={index === queue.length - 1} onClick={() => onAction(async () => { await moveQueueItem(item.id, "down"); await onRefresh(); })}>
                <ChevronDown size={16} />
              </button>
              {editingId === item.id ? (
                <button aria-label={`Save ${item.title}`} title="Save queue edits" data-tooltip="Save edits" className="icon-button" onClick={() => saveEdit(item.id)}>
                  <Check size={16} />
                </button>
              ) : (
                <button aria-label={`Edit ${item.title}`} title="Edit title, artist, and requester" data-tooltip="Edit details" className="icon-button" onClick={() => beginEdit(item)}>
                  <SlidersHorizontal size={16} />
                </button>
              )}
              {editingId === item.id && (
                <button aria-label={`Cancel editing ${item.title}`} title="Cancel editing" data-tooltip="Cancel" className="icon-button" onClick={() => setEditingId(null)}>
                  <XCircle size={16} />
                </button>
              )}
              <button aria-label={`Remove ${item.title}`} title="Remove from queue" data-tooltip="Remove" className="icon-button danger" onClick={() => onAction(async () => { await removeQueueItem(item.id); await onRefresh(); })}>
                <XCircle size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="quiet-note">{queue.length} songs - ~{queue.at(-1)?.etaMinutes || 0} min total</p>
    </section>
  );
}

function SearchPanel({
  query,
  setQuery,
  results,
  state,
  sourceFilter,
  setSourceFilter,
  onRefresh,
  onAction
}: {
  query: string;
  setQuery: (value: string) => void;
  results: Track[];
  state: AppState;
  sourceFilter: "local" | "uploaded" | "spotify" | "playlists";
  setSourceFilter: (value: "local" | "uploaded" | "spotify" | "playlists") => void;
  onRefresh: () => void;
  onAction: ActionRunner;
}) {
  const [showAllResults, setShowAllResults] = useState(false);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const spotifyAvailable = state.services.spotify.configured;
  const visibleResults = showAllResults ? results : results.slice(0, 3);
  const filteredCollections = collections.filter((item) =>
    `${item.collection} ${item.folder} ${item.sample.join(" ")}`.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    fetchCollections().then(setCollections);
  }, []);

  useEffect(() => {
    setShowAllResults(false);
  }, [query, sourceFilter]);
  return (
    <section className="panel search-panel" aria-label="Library">
      <h2>Library</h2>
      <div className="source-tabs">
        <button disabled={!spotifyAvailable} className={sourceFilter === "spotify" ? "primary-small" : ""} onClick={() => setSourceFilter("spotify")}>
          Spotify{spotifyAvailable ? "" : " not linked"}
        </button>
        <button className={sourceFilter === "local" ? "primary-small" : ""} onClick={() => setSourceFilter("local")}>
          VPS library
        </button>
        <button className={sourceFilter === "uploaded" ? "primary-small" : ""} onClick={() => setSourceFilter("uploaded")}>
          Uploaded
        </button>
        <button className={sourceFilter === "playlists" ? "primary-small" : ""} onClick={() => setSourceFilter("playlists")}>
          Playlists
        </button>
      </div>
      {sourceFilter === "uploaded" && (
        <div className="upload-box">
          <div>
            <strong>Uploaded songs</strong>
            <small>{state.services.localLibrary.uploadedCount || 0} uploaded tracks. Audio files only: MP3, FLAC, M4A, WAV, OGG, AAC.</small>
          </div>
          <label className="upload-button">
            {uploading ? "Uploading" : "Upload"}
            <input
              type="file"
              accept=".mp3,.flac,.m4a,.wav,.ogg,.aac,audio/mpeg,audio/flac,audio/mp4,audio/wav,audio/ogg,audio/aac"
              disabled={uploading}
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
      {sourceFilter === "spotify" && spotifyAvailable && (
        <div className="suggestion-row" aria-label="Spotify recommendations">
          {spotifySuggestionTerms.map((term) => (
            <button key={term} onClick={() => setQuery(term)} className={query.toLowerCase() === term ? "is-selected" : ""}>
              {term}
            </button>
          ))}
        </div>
      )}
      <div className="result-list">
        {sourceFilter === "spotify" && !spotifyAvailable && (
          <EmptyState title="Spotify is not linked" detail="Connect Spotty in LMS before public Spotify search is enabled." />
        )}
        {sourceFilter === "spotify" && spotifyAvailable && query.trim() === "" && (
          <div className="recommendation-head">
            <strong>Recommended from Spotify</strong>
            <small>Showing a starter set. Type anything to search Spotty directly.</small>
          </div>
        )}
        {sourceFilter === "spotify" && spotifyAvailable && query.trim() !== "" && results.length === 0 && (
          <EmptyState title="No Spotify results" detail="Try another Spotify search term." />
        )}
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
        {(sourceFilter === "local" || sourceFilter === "uploaded") && results.length === 0 && (
          <EmptyState
            title={sourceFilter === "uploaded" ? "No uploaded songs" : "No local results"}
            detail={sourceFilter === "uploaded" ? "Upload a supported music file to add it here." : "Add music to the configured LMS music folder or search another title."}
          />
        )}
        {visibleResults.map((track) => (
          <SearchResultRow key={track.id} track={track} onRefresh={onRefresh} onAction={onAction} />
        ))}
      </div>
      {(sourceFilter === "local" || sourceFilter === "uploaded" || sourceFilter === "spotify") && results.length > 3 && (
        <button className="link-button" onClick={() => setShowAllResults(!showAllResults)}>
          {showAllResults ? "Show fewer" : `View all ${results.length} results`}
        </button>
      )}
    </section>
  );
}

function SearchResultRow({ track, onRefresh, onAction }: { track: Track; onRefresh: () => void; onAction: ActionRunner }) {
  const playable = !track.kind || track.kind === "track" || Boolean(track.path || track.lmsTrackId);
  return (
    <div className="result-row">
      <div className="cover-thumb">{track.art && <img src={track.art} alt="" />}</div>
      <div>
        <strong>{track.title}</strong>
        <small>
          {track.artist} - {track.album || track.source}
          {track.folder ? ` / ${track.folder}` : ""}
        </small>
      </div>
      <span>{track.kind && track.kind !== "track" ? track.kind : track.duration ? formatTime(track.duration) : "--:--"}</span>
      <div className="track-actions">
        {playable && <button className="ghost-add" onClick={() => onAction(async () => { await playTrack("play-now", track); await onRefresh(); })}>Play now</button>}
        {playable && <button className="ghost-add" onClick={() => onAction(async () => { await playTrack("play-next", track); await onRefresh(); })}>Play next</button>}
        {playable && <button className="ghost-add" onClick={() => onAction(async () => { await playTrack("add-queue", track); await onRefresh(); })}>Queue</button>}
      </div>
    </div>
  );
}

function PlaylistsPanel({ onRefresh, onAction }: { onRefresh: () => void; onAction: ActionRunner }) {
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [source, setSource] = useState<"local" | "spotify">("local");
  const [spotifyType, setSpotifyType] = useState<"playlists" | "albums" | "artists" | "tracks" | "home">("playlists");
  const [spotifyItems, setSpotifyItems] = useState<Track[]>([]);
  const [selectedLocal, setSelectedLocal] = useState<LibraryCollection | null>(null);
  const [selectedSpotify, setSelectedSpotify] = useState<Track | null>(null);
  const [detailTracks, setDetailTracks] = useState<Track[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    fetchCollections().then(setCollections);
  }, []);

  useEffect(() => {
    if (source === "spotify") fetchSpotifyLibrary(spotifyType, 80).then(setSpotifyItems);
  }, [source, spotifyType]);

  async function openLocal(collection: LibraryCollection) {
    setSelectedSpotify(null);
    setSelectedLocal(collection);
    setLoadingDetail(true);
    try {
      setDetailTracks(await fetchCollectionTracks(collection.collection, collection.folder, "all", 1500));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function openSpotify(track: Track) {
    if (track.kind === "track") {
      await onAction(async () => {
        await playTrack("add-queue", track);
        await onRefresh();
      });
      return;
    }
    setSelectedLocal(null);
    setSelectedSpotify(track);
    setLoadingDetail(true);
    try {
      setDetailTracks(await fetchSpotifyChildren(track, 250));
    } finally {
      setLoadingDetail(false);
    }
  }

  const selectedTitle = selectedLocal?.folder || selectedSpotify?.title || "";
  const selectedSubtitle = selectedLocal?.collection || selectedSpotify?.artist || selectedSpotify?.source || "";

  return (
    <section className="panel playlist-panel" aria-label="Playlists">
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
            }}
          >
            Back
          </button>
        )}
      </div>
      <div className="source-tabs">
        <button className={source === "local" ? "primary-small" : ""} onClick={() => { setSource("local"); setSelectedSpotify(null); setDetailTracks([]); }}>
          Local
        </button>
        <button className={source === "spotify" ? "primary-small" : ""} onClick={() => { setSource("spotify"); setSelectedLocal(null); setDetailTracks([]); }}>
          Spotify
        </button>
      </div>
      {source === "spotify" && !selectedTitle && (
        <div className="suggestion-row" aria-label="Spotify playlist filters">
          {(["playlists", "albums", "artists", "tracks", "home"] as const).map((type) => (
            <button key={type} className={spotifyType === type ? "is-selected" : ""} onClick={() => setSpotifyType(type)}>
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

function PlaylistTracks({
  title,
  tracks,
  loading,
  onRefresh,
  onAction
}: {
  title: string;
  tracks: Track[];
  loading: boolean;
  onRefresh: () => void;
  onAction: ActionRunner;
}) {
  async function queueAll(action: "add-queue" | "play-next") {
    await onAction(async () => {
      await playTracks(action, tracks.filter((item) => !item.kind || item.kind === "track").slice(0, 200));
      await onRefresh();
    });
  }

  return (
    <div className="playlist-detail" aria-label={`${title} tracks`}>
      <div className="playlist-detail-actions">
        <span>{loading ? "Loading tracks" : `${tracks.length} tracks`}</span>
        <button className="ghost-add" disabled={tracks.length === 0} onClick={() => queueAll("play-next")}>Play next</button>
        <button className="ghost-add" disabled={tracks.length === 0} onClick={() => queueAll("add-queue")}>Queue all</button>
      </div>
      {loading && <EmptyState title="Opening playlist" detail="Loading songs from the selected collection." />}
      {!loading && tracks.length === 0 && <EmptyState title="No songs found" detail="This playlist did not expose tracks yet." />}
      <div className="result-list">
        {tracks.map((track) => (
          <div className="result-row" key={track.id}>
            <div className="cover-thumb">{track.art && <img src={track.art} alt="" />}</div>
            <div>
              <strong>{track.title}</strong>
              <small>
                {track.artist} - {track.album || track.source}
                {track.folder ? ` / ${track.folder}` : ""}
              </small>
            </div>
            <span>{track.duration ? formatTime(track.duration) : "--:--"}</span>
            <div className="track-actions">
              <button className="ghost-add" onClick={() => onAction(async () => { await playTrack("play-now", track); await onRefresh(); })}>Play now</button>
              <button className="ghost-add" onClick={() => onAction(async () => { await playTrack("play-next", track); await onRefresh(); })}>Play next</button>
              <button className="ghost-add" onClick={() => onAction(async () => { await playTrack("add-queue", track); await onRefresh(); })}>Queue</button>
            </div>
          </div>
        ))}
      </div>
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
  return (
    <section className="recent-picks">
      <div>
        <span>Recent picks</span>
        <button disabled={picks.length === 0}>View all</button>
      </div>
      {picks.length === 0 && <p className="empty-sidebar">No recent picks yet.</p>}
      {picks.slice(0, 6).map((pick) => (
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
  const musicInfo = state.services.musicInfo || { configured: false, detail: "Not checked yet" };
  const serviceRows = useMemo(
    () => [
      { label: "Speaker", ok: state.player.connected, detail: state.player.detail || state.player.name, action: checkSpeaker },
      { label: "Spotify", ok: state.services.spotify.configured, detail: state.services.spotify.detail, action: setupSpotify },
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
            max="10"
            value={settings.maxQueuePerUser}
            onChange={(event) => setSettings({ ...settings, maxQueuePerUser: Number(event.currentTarget.value) })}
          />
        </label>
        <button className="primary" onClick={() => saveAdminSettings(settings).then(onSave)}>
          <SlidersHorizontal size={18} />
          Save settings
        </button>
      </section>
      <section className="panel admin-panel wide">
        <h2>Screen audit</h2>
        <div className="audit-grid">
          {["Public Now Playing", "Queue", "Search", "Track Info", "Album/Lyrics", "Connect Speaker", "Admin Providers", "Admin Moderation"].map(
            (screen) => (
              <div key={screen}>
                <CheckCircle2 size={18} />
                <span>{screen}</span>
              </div>
            )
          )}
        </div>
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
