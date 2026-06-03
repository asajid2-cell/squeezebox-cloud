import type { AppState, ConnectionGuide, LibraryCollection, Track } from "../types";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
let stateRequest: Promise<AppState> | null = null;

async function responseJson<T = any>(response: Response, fallbackMessage: string): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || fallbackMessage);
  }
  return data as T;
}

const fallbackState: AppState = {
  player: { id: "fallback", name: "Squeezebox Cloud Room", connected: false, online: false, mode: "stopped", volume: 68 },
  nowPlaying: {
    id: "spotify:midnight-city",
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
    { title: "Max 3 in queue", detail: "Per person at a time" }
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
  playback: { shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed", lastShuffleRefillAt: 0, lastShuffleSeed: "", lastSmartQueueBase: "", history: [], previousTracks: [] },
  admin: { publicRequests: true, maxQueuePerUser: 3, moderation: "basic", scheduleEnabled: true }
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
  if (!response.ok) return [];
  const data = await response.json();
  return data.results || [];
}

export async function searchSpotify(query: string, limit = 50): Promise<Track[]> {
  try {
    const response = await fetch(`${apiBase}/spotify/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.results || [];
  } catch {
    return [];
  }
}

export async function fetchSpotifyLibrary(type: "playlists" | "albums" | "artists" | "tracks" | "home", limit = 50): Promise<Track[]> {
  const response = await fetch(`${apiBase}/spotify/library?type=${encodeURIComponent(type)}&limit=${limit}`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.results || [];
}

export async function fetchSpotifyChildren(track: Partial<Track>, limit = 200): Promise<Track[]> {
  const params = new URLSearchParams();
  if (track.browseId) params.set("browseId", String(track.browseId));
  if (track.uri) params.set("uri", String(track.uri));
  if (track.kind) params.set("kind", String(track.kind));
  if (track.title) params.set("title", String(track.title));
  params.set("limit", String(limit));
  const response = await fetch(`${apiBase}/spotify/children?${params.toString()}`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.results || [];
}

export async function fetchCollections(source = "all"): Promise<LibraryCollection[]> {
  const response = await fetch(`${apiBase}/library/collections?source=${encodeURIComponent(source)}`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.collections || [];
}

export async function fetchCollectionTracks(collection: string, folder: string, source = "all", limit = 1000): Promise<Track[]> {
  const params = new URLSearchParams({ collection, folder, source, limit: String(limit) });
  const response = await fetch(`${apiBase}/library/collection?${params.toString()}`);
  if (!response.ok) return [];
  const data = await response.json();
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

export async function updateQueueItem(id: string, updates: { title?: string; artist?: string; album?: string; requestedBy?: string }) {
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

export async function moveQueueItem(id: string, direction: "up" | "down") {
  const response = await fetch(`${apiBase}/queue/${encodeURIComponent(id)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction })
  });
  return responseJson(response, "Queue move failed");
}

export async function playTrack(action: "play-now" | "play-next" | "add-queue", track: Partial<Track>) {
  const response = await fetch(`${apiBase}/player/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, track })
  });
  return responseJson(response, "Track playback failed");
}

export async function playTracks(action: "play-next" | "add-queue", tracks: Partial<Track>[]) {
  const response = await fetch(`${apiBase}/player/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, tracks })
  });
  return responseJson(response, "Batch playback failed");
}

export async function playerAction(action: "play" | "pause" | "stop" | "next" | "previous") {
  const response = await fetch(`${apiBase}/player/${action}`, { method: "POST" });
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
  const response = await fetch(`${apiBase}/player/volume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ volume })
  });
  return responseJson(response, "Volume control failed");
}

export async function seekPlayer(seconds: number) {
  const response = await fetch(`${apiBase}/player/seek`, {
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
  if (!response.ok) throw new Error("Invalid admin password");
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

function adminAuthHeader() {
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

export async function getSpotifyConnect() {
  const response = await fetch(`${apiBase}/spotify/connect`);
  return response.json() as Promise<{ setupUrl: string; fallbackUrl: string; steps: string[] }>;
}

export async function checkMusicInfo() {
  const response = await fetch(`${apiBase}/music-info/status`);
  return response.json();
}

export async function rescanLibrary() {
  const response = await fetch(`${apiBase}/library/rescan`, { method: "POST" });
  return response.json();
}
