// Squeezebox Tap — frontend API client (public tapper + admin console).

export type TapDisplay = { title?: string; artist?: string; art?: string | null; kind?: string };
export type TapTag = {
  tagId: string;
  enabled?: boolean;
  display?: TapDisplay;
  label?: string;
  tapCount?: number;
  lastTappedAt?: string | null;
  playSpec?: { kind?: string; source?: string };
  policy?: { playMode?: "replace" | "queue"; volume?: number | null };
  token?: string;
};
export type TapPlayResult = {
  ok: boolean;
  played?: boolean;
  debounced?: boolean;
  reason?: string;
  message?: string;
  tag?: { tagId: string; display?: TapDisplay; tapCount?: number; kind?: string };
  nowPlaying?: { title?: string; artist?: string; art?: string | null; name?: string };
};

async function asJson(res: Response) {
  return res.json().catch(() => ({}));
}

// ---- public tapper ----
export type TapAuth = { ctr?: string | number | null; cmac?: string | null; password?: string };

export async function playTap(tagId: string, token: string, auth: TapAuth = {}): Promise<{ status: number; body: TapPlayResult }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth.password) headers["x-tap-password"] = auth.password;
  const body: Record<string, unknown> = { token };
  // NTAG 424 SUN tags carry a fresh counter + CMAC in the URL query — forward
  // them so the secure resolver path can verify the tap.
  if (auth.ctr !== undefined && auth.ctr !== null && auth.ctr !== "") body.ctr = Number(auth.ctr);
  if (auth.cmac) body.cmac = auth.cmac;
  const res = await fetch(`/api/tap/${encodeURIComponent(tagId)}/play`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return { status: res.status, body: (await asJson(res)) as TapPlayResult };
}

export const pausePlayer = () => fetch("/api/player/pause", { method: "POST" });
export const nextTrack = () => fetch("/api/player/next", { method: "POST" });

// ---- admin console ----
function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

export async function adminLogin(password: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  const body = await asJson(res);
  return res.ok ? { ok: true, token: body.token } : { ok: false, error: body.error || "Login failed" };
}

export type SearchItem = {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  source?: string;
  kind?: "track" | "album" | "artist" | "playlist";
  uri?: string;
  browseId?: string;
  art?: string | null;
  path?: string;
  lmsTrackId?: string | number;
};
export type SearchGroups = { tracks: SearchItem[]; artists: SearchItem[]; albums: SearchItem[]; playlists: SearchItem[] };

export async function searchLibrary(query: string): Promise<SearchItem[]> {
  const res = await fetch(`/api/library/search?q=${encodeURIComponent(query)}&limit=25&source=all`);
  const body = await asJson(res);
  return (body.results || body.tracks || []) as SearchItem[];
}

export async function spotifySearch(query: string): Promise<{ results: SearchItem[]; groups?: SearchGroups }> {
  const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(query)}&limit=20`);
  return (await asJson(res)) as { results: SearchItem[]; groups?: SearchGroups };
}

// An album's tracks IN ORDER — used to bind album-from-track (the chosen track's
// index in this list is the startIndex).
export async function albumTracks(album: SearchItem): Promise<SearchItem[]> {
  const qs = new URLSearchParams();
  if (album.browseId) qs.set("browseId", album.browseId);
  if (album.uri) qs.set("uri", album.uri);
  qs.set("kind", "album");
  if (album.title) qs.set("title", album.title);
  const res = await fetch(`/api/spotify/children?${qs.toString()}`);
  const body = await asJson(res);
  return (body.results || body.children || []) as SearchItem[];
}

export async function listTags(token: string): Promise<TapTag[]> {
  const res = await fetch("/api/tap", { headers: authHeaders(token) });
  const body = await asJson(res);
  return (body.tags || []) as TapTag[];
}

export type TapAnalytics = {
  totalTaps: number;
  totalTags: number;
  windowTaps: number;
  series: { date: string; count: number }[];
  mostTapped: { tagId: string; display?: TapDisplay; tapCount: number; kind?: string; lastTappedAt?: string | null }[];
};

export async function getAnalytics(token: string): Promise<TapAnalytics> {
  const res = await fetch("/api/tap/analytics", { headers: authHeaders(token) });
  return (await asJson(res)) as TapAnalytics;
}

export type TapSettings = { debounceMs: number; partyMode: "open" | "closed"; requirePassword: boolean; hasPassword: boolean };

export async function getSettings(token: string): Promise<TapSettings> {
  const res = await fetch("/api/tap/settings", { headers: authHeaders(token) });
  return (await asJson(res)) as TapSettings;
}

export async function saveSettings(token: string, patch: Record<string, unknown>): Promise<TapSettings> {
  const res = await fetch("/api/tap/settings", { method: "POST", headers: authHeaders(token), body: JSON.stringify(patch) });
  return (await asJson(res)) as TapSettings;
}

export async function exportBackup(token: string): Promise<unknown> {
  const res = await fetch("/api/tap/export", { headers: authHeaders(token) });
  return asJson(res);
}

export async function importBackup(token: string, data: unknown): Promise<{ imported: number; skipped: number; total: number }> {
  const res = await fetch("/api/tap/import", { method: "POST", headers: authHeaders(token), body: JSON.stringify(data) });
  return (await asJson(res)) as { imported: number; skipped: number; total: number };
}

export async function createTag(token: string, payload: Record<string, unknown>) {
  const res = await fetch("/api/tap", { method: "POST", headers: authHeaders(token), body: JSON.stringify(payload) });
  return { status: res.status, body: await asJson(res) };
}

export async function updateTag(token: string, tagId: string, patch: Record<string, unknown>) {
  const res = await fetch(`/api/tap/${encodeURIComponent(tagId)}`, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(patch) });
  return { status: res.status, body: await asJson(res) };
}

export async function deleteTag(token: string, tagId: string) {
  const res = await fetch(`/api/tap/${encodeURIComponent(tagId)}`, { method: "DELETE", headers: authHeaders(token) });
  return res.ok;
}

// Read the signed token from the tag URL fragment (#k=...), never the query string.
export function tokenFromHash(hash: string = window.location.hash): string {
  const m = String(hash || "").match(/[#&]k=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
