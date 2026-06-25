// Thin client for the host `screend` daemon — the AIO panel's video endpoint.
//
// cloud-squeeze runs with network_mode: host, so the daemon (which binds
// 127.0.0.1:4195 on the box) is reachable at the same loopback address from
// inside the container. The screen is a nice-to-have peripheral: EVERY call
// here fails soft — a screen that's off, busy, or absent must never make a tap
// fail or hang.
//
// screend itself lives in its own repo (301/screend); this is just a caller.

const SCREEND_URL = (process.env.SCREEND_URL || "http://127.0.0.1:4195").replace(/\/+$/, "");
const SCREEND_TOKEN = process.env.SCREEND_TOKEN || "";

async function call(path, { method = "POST", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${SCREEND_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(SCREEND_TOKEN ? { "x-screend-token": SCREEND_TOKEN } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...data } : { ok: false, status: res.status, ...data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

// Play a video on the panel. Pass { url } for a specific video (any mpv/yt-dlp
// source) or { query } to youtube-search and play the first hit. Options:
//   seek          start the video this many seconds in (sync to a song)
//   loop          repeat the video forever
//   matchDuration with { query }, prefer a result of ~this length (seconds)
export function playVideo({ url, query, seek, loop, matchDuration } = {}) {
  if (!url && !query) return Promise.resolve({ ok: false, error: "no target" });
  const body = url ? { url } : { query };
  if (Number.isFinite(seek) && seek > 0) body.seek = Math.floor(seek);
  if (loop) body.loop = true;
  if (Number.isFinite(matchDuration) && matchDuration > 0) body.matchDuration = Math.round(matchDuration);
  return call("/play", { body });
}

export function stopVideo() {
  return call("/stop", { body: {} });
}

export function pauseVideo() {
  return call("/pause", { body: {} });
}

export function resumeVideo() {
  return call("/resume", { body: {} });
}

export function seekVideo(pos) {
  return call("/seek", { body: { pos } });
}

export function screenStatus() {
  return call("/status", { method: "GET" });
}
