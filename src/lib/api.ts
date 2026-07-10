import type { AppState, ConnectionGuide, LibraryCollection, Playlist, PlaylistSummary, SpotifySearchGroups, Track } from "../types";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
let stateRequest: Promise<AppState> | null = null;

async function responseJson<T = any>(response: Response, fallbackMessage: string): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || fallbackMessage);
  }
  return data as T;
}

// Bounded fetch so a hung LMS call (player asleep) can't freeze the UI controls.
// On timeout the request aborts and the caller throws, clearing the pending state.
async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The player did not respond in time. Reconnecting…");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const fallbackState: AppState = {
  player: { id: "fallback", name: "Squeezebox Cloud Room", connected: false, online: false, mode: "stopped", volume: 68 },
  nowPlaying: {
    id: "idle",
    title: "No track playing",
    artist: "Connect a player or request a song",
    album: "",
    source: "LMS",
    duration: 0,
    elapsed: 0,
    canSeek: false,
    art: null
  },
  queue: [],
  recentPicks: [],
  schedule: {
    current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false },
    next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true }
  },
  rules: [
    { title: "Be respectful", detail: "No hate speech or harassment" },
    { title: "No spam", detail: "Do not add duplicates or floods" },
    { title: "Keep it clean", detail: "No explicit or offensive content" },
    { title: "Max 25 in queue", detail: "Per person at a time" }
  ],
  services: {
    spotify: { configured: false, reachable: false, detail: "Not checked yet" },
    localLibrary: { root: "Downloads", reachable: false, trackCount: 0, uploadedCount: 0 },
    musicInfo: { configured: false, reachable: false, detail: "Not checked yet" }
  },
  trackInfo: {
    artistBio: "Connect a player and enable the LMS Music and Artist Information plugin.",
    albumReview: "No album review available yet.",
    lyrics: "Lyrics will appear when available."
  },
  playback: { shuffle: false, manualShuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed", lastShuffleRefillAt: 0, lastShuffleSeed: "", lastSmartQueueBase: "", history: [], previousTracks: [] },
  curation: { hidden: [], saved: [], pinned: [], revision: 0 },
  admin: { publicRequests: true, maxQueuePerUser: 25, moderation: "basic", scheduleEnabled: true }
};

export async function fetchState(): Promise<AppState> {
  if (stateRequest) return stateRequest;
  stateRequest = (async () => {
    try {
      const response = await fetch(`${apiBase}/state`);
      if (!response.ok) throw new Error("State request failed");
      return response.json();
    } catch {
      return fallbackState;
    } finally {
      stateRequest = null;
    }
  })();
  return stateRequest;
}

export function resetApiClientStateForTests() {
  stateRequest = null;
}

export async function searchLibrary(query: string, limit = 100, source = "all"): Promise<Track[]> {
  const response = await fetch(`${apiBase}/library/search?q=${encodeURIComponent(query)}&limit=${limit}&source=${encodeURIComponent(source)}`);
  const data = await responseJson<{ results?: Track[] }>(response, "Library search failed");
  return data.results || [];
}

export async function searchSpotify(query: string, limit = 50): Promise<Track[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await fetch(`${apiBase}/spotify/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`);
  const data = await responseJson<{ results?: Track[] }>(response, "Spotify search failed");
  return data.results || [];
}

const emptyGroups: SpotifySearchGroups = { tracks: [], artists: [], albums: [], playlists: [] };

export async function searchSpotifyGrouped(query: string, limit = 50): Promise<SpotifySearchGroups> {
  const trimmed = query.trim();
  if (!trimmed) return emptyGroups;
  const response = await fetch(`${apiBase}/spotify/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`);
  const data = await responseJson<{ groups?: Partial<SpotifySearchGroups> }>(response, "Spotify search failed");
  return { ...emptyGroups, ...(data.groups || {}) };
}

export async function searchSpotifyCategories(query: string, limit = 8): Promise<Pick<SpotifySearchGroups, "artists" | "albums" | "playlists">> {
  const trimmed = query.trim();
  const empty = { artists: [], albums: [], playlists: [] };
  if (!trimmed) return empty;
  const response = await fetch(`${apiBase}/spotify/search/categories?q=${encodeURIComponent(trimmed)}&limit=${limit}`);
  if (!response.ok) return empty;
  const data = await response.json().catch(() => empty);
  return {
    artists: data.artists || [],
    albums: data.albums || [],
    playlists: data.playlists || []
  };
}

export async function fetchPlaylists(): Promise<PlaylistSummary[]> {
  const response = await fetch(`${apiBase}/playlists`);
  const data = await responseJson<{ playlists?: PlaylistSummary[] }>(response, "Playlists failed");
  return data.playlists || [];
}

export async function fetchPlaylist(id: string): Promise<Playlist | null> {
  const response = await fetch(`${apiBase}/playlists/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const data = await response.json();
  return data.playlist || null;
}

export async function createPlaylist(input: { name: string; description?: string; createdBy?: string }): Promise<Playlist> {
  const response = await fetch(`${apiBase}/playlists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const data = await responseJson<{ playlist: Playlist }>(response, "Could not create playlist");
  return data.playlist;
}

export async function addTracksToPlaylist(id: string, tracks: Partial<Track>[]): Promise<{ playlist: Playlist; added: number }> {
  const response = await fetch(`${apiBase}/playlists/${encodeURIComponent(id)}/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: tracks.map(compactPlaylistTrack) })
  });
  return responseJson<{ playlist: Playlist; added: number }>(response, "Could not add tracks");
}

export async function renamePlaylist(id: string, updates: { name?: string; description?: string }): Promise<Playlist> {
  const response = await fetch(`${apiBase}/playlists/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...adminAuthHeader() },
    body: JSON.stringify(updates)
  });
  const data = await responseJson<{ playlist: Playlist }>(response, "Could not update playlist");
  return data.playlist;
}

export async function deletePlaylist(id: string): Promise<void> {
  const response = await fetch(`${apiBase}/playlists/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...adminAuthHeader() }
  });
  await responseJson(response, "Could not delete playlist");
}

export async function removePlaylistTrack(id: string, key: string): Promise<Playlist> {
  const response = await fetch(`${apiBase}/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { ...adminAuthHeader() }
  });
  const data = await responseJson<{ playlist: Playlist }>(response, "Could not remove track");
  return data.playlist;
}

export async function movePlaylistTrack(id: string, key: string, direction: "up" | "down"): Promise<Playlist> {
  const response = await fetch(`${apiBase}/playlists/${encodeURIComponent(id)}/tracks/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminAuthHeader() },
    body: JSON.stringify({ key, direction })
  });
  const data = await responseJson<{ playlist: Playlist }>(response, "Could not reorder track");
  return data.playlist;
}

export function playlistTrackKey(track: Partial<Track>): string {
  return String(track.uri || track.path || track.lmsTrackId || track.id || track.title || "").toLowerCase();
}

export async function curateLibraryItem(action: "hide" | "unhide" | "favorite" | "unfavorite" | "pin" | "unpin", track: Partial<Track>): Promise<AppState["curation"]> {
  const response = await fetch(`${apiBase}/curation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminAuthHeader() },
    body: JSON.stringify({ action, track: compactPlaylistTrack(track) })
  });
  const data = await responseJson<{ curation: AppState["curation"] }>(response, "Could not update library curation");
  return data.curation;
}

function compactPlaylistTrack(track: Partial<Track>) {
  const compact: Partial<Track> = {};
  for (const key of ["id", "title", "artist", "album", "source", "path", "uri", "kind", "lmsTrackId", "uploaded", "duration", "art", "browseId"] as const) {
    const value = track[key];
    if (value !== undefined && value !== null && value !== "") compact[key] = value as never;
  }
  return compact;
}

export async function fetchSpotifyLibrary(type: "playlists" | "albums" | "artists" | "tracks" | "home", limit = 50): Promise<Track[]> {
  const response = await fetch(`${apiBase}/spotify/library?type=${encodeURIComponent(type)}&limit=${limit}`);
  const data = await responseJson<{ results?: Track[] }>(response, "Spotify library failed");
  return data.results || [];
}

export async function fetchSpotifyChildren(track: Partial<Track>, limit = 200, offset = 0): Promise<Track[]> {
  const params = new URLSearchParams();
  if (track.browseId) params.set("browseId", String(track.browseId));
  if (track.uri) params.set("uri", String(track.uri));
  if (track.kind) params.set("kind", String(track.kind));
  if (track.title) params.set("title", String(track.title));
  params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));
  const response = await fetch(`${apiBase}/spotify/children?${params.toString()}`);
  const data = await responseJson<{ results?: Track[] }>(response, "Spotify playlist failed");
  return data.results || [];
}

export async function fetchCollections(source = "all"): Promise<LibraryCollection[]> {
  const response = await fetch(`${apiBase}/library/collections?source=${encodeURIComponent(source)}`);
  const data = await responseJson<{ collections?: LibraryCollection[] }>(response, "Library collections failed");
  return data.collections || [];
}

export async function fetchCollectionTracks(collection: string, folder: string, source = "all", limit = 1000, offset = 0): Promise<Track[]> {
  const params = new URLSearchParams({ collection, folder, source, limit: String(limit) });
  if (offset > 0) params.set("offset", String(offset));
  const response = await fetch(`${apiBase}/library/collection?${params.toString()}`);
  const data = await responseJson<{ results?: Track[] }>(response, "Library collection failed");
  return data.results || [];
}

export async function uploadTrack(file: File) {
  const response = await fetch(`${apiBase}/library/upload?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Upload-Filename": file.name },
    body: await file.arrayBuffer()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Upload failed");
  return data as { ok: boolean; track: Track; trackCount: number };
}

export async function postQueue(track: Partial<Track> & { requestedBy?: string }) {
  const response = await fetch(`${apiBase}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(track)
  });
  return responseJson(response, "Queue request failed");
}

export async function updateQueueItem(id: string, updates: { title?: string; artist?: string; album?: string }) {
  const response = await fetch(`${apiBase}/queue/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  return responseJson(response, "Queue update failed");
}

export async function removeQueueItem(id: string) {
  const response = await fetch(`${apiBase}/queue/${encodeURIComponent(id)}`, { method: "DELETE" });
  return responseJson(response, "Queue removal failed");
}

export async function moveQueueItem(id: string, direction: "up" | "down" | number) {
  const response = await fetch(`${apiBase}/queue/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(typeof direction === "number" ? { index: direction } : { direction })
  });
  return responseJson(response, "Queue move failed");
}

export async function playTrack(action: "play-now" | "play-next" | "add-queue", track: Partial<Track>) {
  const response = await fetchWithTimeout(`${apiBase}/player/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, track: compactPlayableTrack(track) })
  });
  return responseJson(response, "Track playback failed");
}

export async function playTracks(action: "play-next" | "add-queue", tracks: Partial<Track>[]) {
  const response = await fetchWithTimeout(`${apiBase}/player/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, tracks: tracks.map(compactPlayableTrack) })
  });
  return responseJson(response, "Batch playback failed");
}

/** Play one track from a playlist and scope the Squeezebox queue to that playlist. */
export async function playPlaylistFrom(tracks: Partial<Track>[], startIndex: number) {
  const response = await fetchWithTimeout(`${apiBase}/player/playlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startIndex, tracks: tracks.map(compactPlayableTrack) })
  });
  return responseJson(response, "Playlist playback failed");
}

function compactPlayableTrack(track: Partial<Track>) {
  const compact: Partial<Track> = {};
  // `id` carries archive:/spotify: ids the backend needs to resolve playback.
  for (const key of ["id", "title", "artist", "album", "source", "path", "uri", "kind", "lmsTrackId", "uploaded", "duration"] as const) {
    const value = track[key];
    if (value !== undefined && value !== null && value !== "") compact[key] = value as never;
  }
  return compact;
}

export async function playerAction(action: "play" | "pause" | "stop" | "next" | "previous") {
  const response = await fetchWithTimeout(`${apiBase}/player/${action}`, { method: "POST" });
  return responseJson(response, "Player control failed");
}

export async function savePlayback(settings: Partial<AppState["playback"]>) {
  const response = await fetch(`${apiBase}/player/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
  return responseJson(response, "Playback settings failed");
}

export async function smartShuffle(source: AppState["playback"]["smartShuffleSource"], count = 5) {
  const response = await fetch(`${apiBase}/player/smart-shuffle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, count })
  });
  return responseJson(response, "Smart shuffle failed");
}

export async function setPlayerVolume(volume: number) {
  const response = await fetchWithTimeout(`${apiBase}/player/volume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ volume })
  });
  return responseJson(response, "Volume control failed");
}

export async function seekPlayer(seconds: number) {
  const response = await fetchWithTimeout(`${apiBase}/player/seek`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds })
  });
  return responseJson(response, "Seek failed");
}

export async function saveAdminSettings(settings: Partial<AppState["admin"]>) {
  const response = await fetch(`${apiBase}/admin/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminAuthHeader() },
    body: JSON.stringify(settings)
  });
  return responseJson(response, "Admin settings failed");
}

export async function loginAdmin(password: string) {
  const response = await fetch(`${apiBase}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!response.ok) {
    // Surface the server's actual reason (e.g. 429 "Too many admin login attempts")
    // instead of always claiming a bad password.
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || "Invalid admin password");
  }
  const data = await response.json();
  window.localStorage.setItem("cloud-squeeze-admin-token", data.token);
  return data.token as string;
}

export function hasAdminSession() {
  return Boolean(window.localStorage.getItem("cloud-squeeze-admin-token"));
}

export function clearAdminSession() {
  window.localStorage.removeItem("cloud-squeeze-admin-token");
}

/** Confirm the stored admin token is still a live server session (they're in-memory
 * and expire / reset on restart). Clears the token if the server rejects it. */
export async function validateAdminSession(): Promise<boolean> {
  if (!hasAdminSession()) return false;
  try {
    const response = await fetch(`${apiBase}/admin/session`, { headers: adminAuthHeader() });
    if (response.status === 401 || response.status === 403) {
      clearAdminSession();
      return false;
    }
    return response.ok;
  } catch {
    return false;
  }
}

function adminAuthHeader(): Record<string, string> {
  const token = window.localStorage.getItem("cloud-squeeze-admin-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function checkSpeaker() {
  const response = await fetch(`${apiBase}/speaker/status`);
  return response.json();
}

export async function fetchConnectionGuide(): Promise<ConnectionGuide> {
  const response = await fetch(`${apiBase}/speaker/connect-guide`);
  if (!response.ok) throw new Error("Connection guide unavailable");
  return response.json();
}

export async function checkSpotify() {
  const response = await fetch(`${apiBase}/spotify/status`);
  return response.json();
}

export interface ArchiveFile {
  filename: string;
  artist: string;
  title: string;
  size: number | null;
  addedAt: string | null;
  art?: string | null;
}

export interface ArchiveGroup {
  name: string;
  manual: boolean;
  count: number;
  files: ArchiveFile[];
}

export interface ArchiveScan {
  watching: { name: string; trackCount: number; updatedAt?: string; email?: boolean }[];
  lastScanAt: string | null;
  scanning: boolean;
  intervalMs: number;
}

export interface ArchiveList {
  files: ArchiveFile[];
  groups: ArchiveGroup[];
  scan: ArchiveScan;
}

export async function fetchArchive(): Promise<ArchiveList> {
  const response = await fetch(`${apiBase}/archive`);
  const data = await responseJson<Partial<ArchiveList>>(response, "Could not load archive");
  return {
    files: data.files || [],
    groups: data.groups || [],
    scan: data.scan || { watching: [], lastScanAt: null, scanning: false, intervalMs: 0 }
  };
}

/** Trigger an immediate scan of the watched "archive*" playlists. */
export async function scanArchive(): Promise<{ ok: boolean; queued?: number; playlists?: number; scan?: ArchiveScan }> {
  const response = await fetch(`${apiBase}/archive/scan`, { method: "POST" });
  return responseJson(response, "Could not scan playlists");
}

export function archiveDownloadUrl(filename: string): string {
  return `${apiBase}/archive/file/${encodeURIComponent(filename)}`;
}

export interface ArchiveJob {
  id: string;
  artist: string;
  title: string;
  status: "queued" | "downloading" | "done" | "failed";
  error: string | null;
  queuedAt: string;
}

export interface ArchiveQueueStatus {
  cooldownMs: number;
  dailyCap: number;
  downloadedToday: number;
  current: string | null;
  jobs: ArchiveJob[];
}

/** Queue the currently-playing track for background archival. */
export async function archiveCurrentTrack(): Promise<{ queued: boolean; reason?: string }> {
  const response = await fetch(`${apiBase}/archive`, { method: "POST" });
  return responseJson(response, "Could not queue archive");
}

/** Queue an explicit track (from search results / a playlist). */
export async function archiveTrack(track: { uri?: string; id?: string; artist?: string; title?: string }): Promise<{ queued: boolean; reason?: string }> {
  const response = await fetch(`${apiBase}/archive/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uri: track.uri || track.id, artist: track.artist, title: track.title })
  });
  return responseJson(response, "Could not queue archive");
}

export async function fetchArchiveStatus(): Promise<ArchiveQueueStatus> {
  const response = await fetch(`${apiBase}/archive/status`);
  return response.json();
}

export async function getSpotifyConnect() {
  const response = await fetch(`${apiBase}/spotify/connect`);
  return response.json() as Promise<{ setupUrl: string; fallbackUrl: string; steps: string[] }>;
}

export async function checkMusicInfo() {
  const response = await fetch(`${apiBase}/music-info/status`);
  return response.json();
}

export async function rescanLibrary() {
  const response = await fetch(`${apiBase}/library/rescan`, { method: "POST", headers: adminAuthHeader() });
  return responseJson(response, "Library rescan failed");
}
