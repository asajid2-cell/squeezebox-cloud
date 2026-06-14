// Squeezebox Tap — frontend API client (public tapper + admin console).

export type TapDisplay = { title?: string; artist?: string; art?: string | null; kind?: string };
export type TapTag = {
  tagId: string;
  enabled?: boolean;
  display?: TapDisplay;
  label?: string;
  tapCount?: number;
  lastTappedAt?: string | null;
  playSpec?: { kind?: string; source?: string; albumUri?: string; playlistUri?: string; startIndex?: number; seed?: string };
  policy?: { playMode?: "replace" | "queue"; volume?: number | null; resume?: boolean };
  resumeState?: { index: number; seconds: number; savedAt?: string } | null;
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

// ---- admin console — auth is the hl-auth session cookie, sent automatically
// on same-origin requests; no bearer tokens. The console gates on getSession().
const JSON_HEADERS = { "Content-Type": "application/json" };

export type TapSession = {
  authed: boolean;
  user: { username: string; isMaster?: boolean; local?: boolean } | null;
  loginUrl?: string;
  logoutUrl?: string;
};

export async function getSession(): Promise<TapSession> {
  const res = await fetch("/api/tap/session", { credentials: "same-origin" });
  return (await asJson(res)) as TapSession;
}

export type ApiLoginResult = {
  ok: boolean;
  user?: { username: string; isMaster?: boolean; isOwner?: boolean; isAdmin?: boolean };
  error?: string;
};

// Sign in against hl-auth WITHOUT leaving the Tap console. POSTs credentials to
// the same-origin hl-auth JSON login endpoint, which sets the shared host
// session cookie; the caller then re-reads getSession(). The endpoint is
// origin-gated server-side, so this only works same-origin (which is the point).
// Derives the API url from the session's loginUrl (e.g. /auth/login -> /auth/api/login).
export async function apiLogin(username: string, password: string, loginUrl = "/auth/login"): Promise<ApiLoginResult> {
  const url = loginUrl.replace(/\/login(\?.*)?$/, "") + "/api/login";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify({ username, password })
    });
    return (await asJson(res)) as ApiLoginResult;
  } catch {
    return { ok: false, error: "Couldn't reach the sign-in service. Try again." };
  }
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
export async function spotifySearchCategories(query: string): Promise<Omit<SearchGroups, "tracks">> {
  const res = await fetch(`/api/spotify/search/categories?q=${encodeURIComponent(query)}&limit=8`);
  const body = await asJson(res);
  return {
    artists: (body.artists || []) as SearchItem[],
    albums: (body.albums || []) as SearchItem[],
    playlists: (body.playlists || []) as SearchItem[]
  };
}

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

export async function listTags(): Promise<TapTag[]> {
  const res = await fetch("/api/tap", { credentials: "same-origin" });
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

export async function getAnalytics(): Promise<TapAnalytics> {
  const res = await fetch("/api/tap/analytics", { credentials: "same-origin" });
  return (await asJson(res)) as TapAnalytics;
}

export type TapSettings = { debounceMs: number; partyMode: "open" | "closed"; requirePassword: boolean; hasPassword: boolean; partyQueue?: boolean };

// The Squeezebox's current now-playing, used to bind "what's playing right now"
// straight onto a tag.
export type NowPlaying = {
  title?: string;
  artist?: string;
  album?: string;
  art?: string | null;
  uri?: string;
  id?: string | number;
  source?: string;
  connected?: boolean;
};

// Read the live now-playing from the lightweight public endpoint — used by the
// tapper's post-play "what's on" screen and the console's "bind what's playing".
export async function nowPlayingNow(): Promise<NowPlaying | null> {
  const res = await fetch("/api/tap/now");
  const body = await asJson(res);
  const np = body?.nowPlaying || null;
  if (!np || !(np.title || np.uri || np.id)) return null;
  return {
    title: np.title,
    artist: np.artist,
    album: np.album,
    art: np.art ?? null,
    uri: np.uri,
    id: np.id,
    source: np.source,
    connected: body?.connected
  };
}

export async function getSettings(): Promise<TapSettings> {
  const res = await fetch("/api/tap/settings", { credentials: "same-origin" });
  return (await asJson(res)) as TapSettings;
}

export async function saveSettings(patch: Record<string, unknown>): Promise<TapSettings> {
  const res = await fetch("/api/tap/settings", { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", body: JSON.stringify(patch) });
  return (await asJson(res)) as TapSettings;
}

export async function exportBackup(): Promise<unknown> {
  const res = await fetch("/api/tap/export", { credentials: "same-origin" });
  return asJson(res);
}

export async function importBackup(data: unknown): Promise<{ imported: number; skipped: number; total: number }> {
  const res = await fetch("/api/tap/import", { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", body: JSON.stringify(data) });
  return (await asJson(res)) as { imported: number; skipped: number; total: number };
}

export async function createTag(payload: Record<string, unknown>) {
  const res = await fetch("/api/tap", { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", body: JSON.stringify(payload) });
  return { status: res.status, body: await asJson(res) };
}

export async function updateTag(tagId: string, patch: Record<string, unknown>) {
  const res = await fetch(`/api/tap/${encodeURIComponent(tagId)}`, { method: "PUT", headers: JSON_HEADERS, credentials: "same-origin", body: JSON.stringify(patch) });
  return { status: res.status, body: await asJson(res) };
}

export async function deleteTag(tagId: string) {
  const res = await fetch(`/api/tap/${encodeURIComponent(tagId)}`, { method: "DELETE", credentials: "same-origin" });
  return res.ok;
}

// Read the signed token from the tag URL fragment (#k=...), never the query string.
export function tokenFromHash(hash: string = window.location.hash): string {
  const m = String(hash || "").match(/[#&]k=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

// Cover-art URLs from the API are stored RELATIVE (e.g. "api/image-proxy?...").
// On the tapper page (/cloud-squeeze/tap/t/:id) a relative <img src> resolves
// against the page path (wrong → broken cover). Prefix relative api/ paths with
// the mount base so they resolve to /cloud-squeeze/api/... like the fetch shim.
export function artSrc(art?: string | null): string | undefined {
  if (!art) return undefined;
  if (/^(https?:|data:|blob:)/i.test(art)) return art;
  const base = String(import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base}${art.startsWith("/") ? "" : "/"}${art}`;
}
