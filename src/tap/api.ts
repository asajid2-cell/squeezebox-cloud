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
export async function playTap(tagId: string, token: string): Promise<{ status: number; body: TapPlayResult }> {
  const res = await fetch(`/api/tap/${encodeURIComponent(tagId)}/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
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

export async function searchLibrary(query: string): Promise<TapTag[]> {
  const res = await fetch(`/api/library/search?q=${encodeURIComponent(query)}&limit=20`);
  const body = await asJson(res);
  return (body.results || body.tracks || []) as TapTag[];
}

export async function listTags(token: string): Promise<TapTag[]> {
  const res = await fetch("/api/tap", { headers: authHeaders(token) });
  const body = await asJson(res);
  return (body.tags || []) as TapTag[];
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
