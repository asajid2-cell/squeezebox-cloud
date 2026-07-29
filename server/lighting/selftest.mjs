// Dev harness: read the live LMS now-playing, design a routine, push it to the strip.
// Run on the VPS:  DEEPSEEK_API_KEY=... node server/lighting/selftest.mjs
// Proves the lighting module end-to-end without rebuilding the container.

import { onTrack } from "./director.js";

const LMS = process.env.LMS_HTTP_URL || "http://127.0.0.1:9000";
const PLAYER = process.env.ARCHIVE_PLAYER_MAC || "00:04:20:1f:2c:56";

async function nowPlaying() {
  const body = JSON.stringify({ id: 1, method: "slim.request",
    params: [PLAYER, ["status", "-", 1, "tags:aAlKdyuxNcJ"]] });
  const res = await fetch(`${LMS}/jsonrpc.js`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const r = (await res.json()).result;
  const t = (r.playlist_loop || [])[0] || {};
  return {
    track: {
      title: t.title, artist: t.artist, album: t.album, year: t.year,
      uri: t.url || t.id, id: t.id
    },
    posMs: Math.round((Number(r.time) || 0) * 1000),
    mode: r.mode
  };
}

const np = await nowPlaying();
console.log(`NOW PLAYING: "${np.track.title}" — ${np.track.artist} / ${np.track.album} (${np.track.year})  @${np.posMs}ms  [${np.mode}]`);
const res = await onTrack(np.track, { posMs: np.posMs, settings: { enabled: true, brightness: 210 }, force: true });
console.log("RESULT:", JSON.stringify(res, null, 2));
