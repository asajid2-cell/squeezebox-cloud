# TANDEM Findings

Date: 2026-06-11

Scope: empirical Spotty/LMS capability inventory against the live LMS at `192.168.1.142`, plus algorithm-agnostic listening-event and taste-profile substrate work in this repo.

## Live Spotty/LMS Inventory

### Connectivity Verified

LMS HTTP JSON-RPC is reachable at `http://192.168.1.142:9000/jsonrpc.js`.

LMS CLI is reachable at `192.168.1.142:9090`.

Raw CLI protocol strings verified:

```text
player count ?
player id 0 ?
serverstatus 0 20
00%3A04%3A20%3A1f%3A2c%3A56 status - 1 tags%3AKcuoal
```

Observed player:

```text
00:04:20:1f:2c:56
Squeezebox Boom
```

Observed LMS version from `serverstatus`: `9.1.1`.

### Now-Playing Metadata

Command:

```text
00%3A04%3A20%3A1f%3A2c%3A56 status - 1 tags%3AKcuoal
```

Verified now-playing Spotty track fields:

```text
id
title
artwork_url
coverid
url: spotify://track:0qWoOHqTirzo59FQ9eoECH
type: Ogg Vorbis (Spotify)
artist
album
```

Verified status/player fields useful for implicit feedback:

```text
mode
time
duration
can_seek
playlist_cur_index
playlist_timestamp
```

Not present in this status surface:

```text
energy
danceability
valence
tempo
acousticness
genre
popularity
related artists
recommendations
```

### Spotty Browse Root

JSON-RPC payload shape used:

```json
{
  "id": 1,
  "method": "slim.request",
  "params": [
    "00:04:20:1f:2c:56",
    ["spotty", "items", 0, 30, "menu:spotty", "item_id:0"]
  ]
}
```

Verified response title/count:

```text
title: Home
count: 50
```

Verified row fields:

```text
type
text
params.item_id
icon
presetParams.favorites_title
presetParams.favorites_type
presetParams.favorites_url
```

The root included personalized Spotify/Spotty entries such as `Daily Mix 1` through `Daily Mix 6`, represented as playlists with Spotify playlist URIs.

### Global Search

Payload:

```json
{
  "id": 1,
  "method": "slim.request",
  "params": [
    "00:04:20:1f:2c:56",
    ["spotty", "items", 0, 80, "menu:spotty", "item_id:1.0", "search:beabadoobee", "cachesearch:1"]
  ]
}
```

Verified response:

```text
title: New Search
count: 56
```

The first buckets were categories:

```text
Artists
Albums
Playlists
Podcasts
Podcast Episodes
Users
```

Track rows came after the buckets. Verified playable row fields:

```text
text
style: itemplay
goAction: play
params.isContextMenu
params.item_id
params.touchToPlay
presetParams.favorites_title
presetParams.favorites_type: audio
presetParams.icon
presetParams.favorites_url: spotify:track:...
```

Observed example track URI:

```text
spotify:track:0qWoOHqTirzo59FQ9eoECH
```

Not present on search track rows:

```text
duration
genre
popularity
audio features
recommendation score
```

### Artist Detail, Artist Radio, Related Artists

Search artist bucket payload:

```json
{
  "id": 1,
  "method": "slim.request",
  "params": [
    "00:04:20:1f:2c:56",
    ["spotty", "items", 0, 10, "menu:spotty", "item_id:1.0_beabadoobee.0"]
  ]
}
```

Verified artist rows expose:

```text
text: artist name plus followers
params.item_id
presetParams.favorites_url: spotify:artist:...
icon
```

Not present on artist rows:

```text
genre
popularity
external Spotify href
```

Artist detail payload:

```json
{
  "id": 1,
  "method": "slim.request",
  "params": [
    "00:04:20:1f:2c:56",
    ["spotty", "items", 0, 12, "menu:spotty", "item_id:1.0_beabadoobee.0.0"]
  ]
}
```

Verified artist detail menu for `beabadoobee`:

```text
Albums
Singles & EPs
Compilations
Top Tracks
Artist Radio
Related Artists
Follow artist
```

Verified `Artist Radio`:

```json
{
  "id": 1,
  "method": "slim.request",
  "params": [
    "00:04:20:1f:2c:56",
    ["spotty", "items", 0, 20, "menu:spotty", "item_id:1.0_beabadoobee.0.0.4"]
  ]
}
```

Response:

```text
title: Artist Radio
count: 200
```

Rows are playable tracks with the same basic fields as search rows: `text`, `style:itemplay`, `goAction:play`, `params.item_id`, `params.touchToPlay`, `icon`, `presetParams.favorites_url`, `presetParams.favorites_title`, `presetParams.favorites_type`, `presetParams.icon`.

Verified `Related Artists`:

```json
{
  "id": 1,
  "method": "slim.request",
  "params": [
    "00:04:20:1f:2c:56",
    ["spotty", "items", 0, 20, "menu:spotty", "item_id:1.0_beabadoobee.0.0.5"]
  ]
}
```

Response:

```text
title: Related Artists
count: 20
```

Rows are artist rows with `text`, `params.item_id`, `presetParams.favorites_url:spotify:artist:...`, and artwork. Browsing a related artist row opens the same artist detail menu, including that related artist's `Top Tracks`, `Artist Radio`, and `Related Artists`.

### Top Tracks, Albums, Playlists

Verified `Top Tracks` from artist detail:

```text
item_id: 1.0_beabadoobee.0.0.3
title: Top Tracks
count: 10
```

Verified album browse and playlist browse return playable track rows with the same basic Spotty fields.

Observed playlist/mix candidate source from search:

```text
beabadoobee Mix
count: 50
```

### Track Radio / Similar / Recommendations

Track detail was probed using a search result item id such as:

```text
item_id: 1.0_beabadoobee.6
```

It returned only a playable audio row with the track URI and basic preset params. I did not find a track-radio or track-similar submenu.

Ad hoc CLI command probes did not expose usable endpoints:

```text
00%3A04%3A20%3A1f%3A2c%3A56 spotty related 0 20 spotify:artist:35l9BRT7MXmM8bv2WDQiyB
00%3A04%3A20%3A1f%3A2c%3A56 spotty recommendations 0 20 spotify:track:0qWoOHqTirzo59FQ9eoECH
00%3A04%3A20%3A1f%3A2c%3A56 spotty audiofeatures spotify:track:0qWoOHqTirzo59FQ9eoECH
00%3A04%3A20%3A1f%3A2c%3A56 spotty token ?
00%3A04%3A20%3A1f%3A2c%3A56 spotty oauth ?
```

These did not return discoverable result data through the LMS CLI.

Searches for terms like `beabadoobee radio`, `beabadoobee mix`, and `All I Did Was Dream of You radio` behaved as normal global searches. They did not reveal a track-radio endpoint.

### Audio Features

No verified Spotty/LMS browse or status response exposed Spotify audio features:

```text
energy
danceability
valence
tempo
acousticness
instrumentalness
liveness
speechiness
```

The reachable surfaces expose basic metadata and Spotify URIs, not feature vectors.

### Access Token / Credentials

The live container source and credentials could not be inspected because SSH auth to `harmonizer@192.168.1.142` rejected password auth:

```text
No supported authentication methods available (server sent: publickey)
```

The local fixture at `cloud-squeeze-vps/tests/fixtures/lms-config/prefs/plugin/spotty.prefs` contains only account metadata:

```yaml
---
accounts:
  - name: Ahmed Sajid
    premium: 1
    import: 1
```

No access token was found there. No usable token was exposed through the probed LMS CLI commands. Treat direct Spotify Web API access as unavailable unless separate OAuth credentials are provisioned or SSH/container access is fixed and a legitimate token source is confirmed.

I also found `../spotty-live.db`, but it is a Spotty cache database, not source or a preferences file:

```text
CREATE TABLE cache (k INTEGER PRIMARY KEY, v BLOB, t INTEGER);
CREATE INDEX expiry ON cache (t);
```

I did not dump arbitrary cached blobs, and I would not build against that cache format.

## Candidate Source Conclusion

The best cheap candidate source that actually exists today is artist-seeded Spotty browsing:

1. Run a Spotty global search for the seed artist.
2. Open the `Artists` bucket.
3. Pick the best matching artist row.
4. Browse `Artist Radio`, which returned 200 playable candidate tracks.
5. Optionally browse `Related Artists`, then each related artist's `Top Tracks` and/or `Artist Radio`.
6. Fallback to playlist search results such as `<artist> Mix` and then global track search rows.

For a track seed, Spotty did not expose track radio in the verified surfaces. The practical route is to use the track's artist metadata, then candidate-generate from that artist's `Artist Radio`, `Top Tracks`, and `Related Artists`.

Given the verified limits, we can do materially better than the current global random search, but not by using audio-feature similarity or direct Spotify recommendation endpoints through Spotty. The improvement should come from using Spotty's browse graph as the candidate generator, then ranking/filtering locally from implicit feedback.

## Event Capture and Taste Profile Substrate

Implemented files:

```text
server/listenerTaste.js
tests/listenerTaste.test.ts
server/app.js
```

The taste store defaults to:

```text
%MUSIC_SOURCE_DIR%/cloud-squeeze/listener-taste.json
```

It can be overridden with:

```text
CLOUD_SQUEEZE_TASTE_FILE
```

### Event Schema

Each event is stored as:

```json
{
  "id": "evt-...",
  "at": "ISO timestamp",
  "type": "play | skip | complete | replay",
  "listenerId": "guest/requester/ambient",
  "trackKey": "spotify:track:...",
  "track": {
    "id": "...",
    "title": "...",
    "artist": "...",
    "album": "...",
    "source": "...",
    "uri": "...",
    "path": "...",
    "lmsTrackId": "...",
    "duration": 0,
    "kind": "...",
    "requestedBy": "...",
    "browseId": "..."
  },
  "duration": 0,
  "elapsed": 0,
  "playedSeconds": 0,
  "percentPlayed": 0,
  "startedAt": "ISO timestamp",
  "context": {
    "listenerId": "...",
    "requestedBy": "...",
    "playbackMode": "direct | appManaged | shuffle | manualShuffle | smartQueue",
    "smartShuffleSource": "...",
    "seed": "...",
    "generated": false,
    "queueLength": 0,
    "reason": "...",
    "source": "..."
  }
}
```

### Profile Schema

The store persists:

```json
{
  "version": 1,
  "revision": 0,
  "updatedAt": "ISO timestamp",
  "listeners": {
    "listener-id": {
      "id": "listener-id",
      "createdAt": "ISO timestamp",
      "updatedAt": "ISO timestamp",
      "totals": {
        "events": 0,
        "plays": 0,
        "skips": 0,
        "completes": 0,
        "replays": 0,
        "playedSeconds": 0
      },
      "tracks": {},
      "artists": {},
      "albums": {},
      "sources": {},
      "seeds": {},
      "recentEventIds": []
    }
  },
  "events": []
}
```

Profiles maintain bounded aggregate maps for tracks, artists, albums, sources, and seeds. Each aggregate tracks `plays`, `skips`, `completes`, `replays`, `playedSeconds`, `score`, `firstAt`, and `lastAt`.

Current scoring is deliberately simple and replaceable:

```text
play: +0.25
complete: +2
replay: +1.5
skip: -1.5 * (1 - percentPlayed)
```

Completion is inferred when a poll sees at least 85 percent of the track played or the playhead is within 8 seconds of the end. A closed-session guard prevents duplicate completes/skips from repeated polls of the same finalized track.

### App Hooks Added

`refreshLms` now accepts an optional `taste` store and calls:

```text
observeListeningPlayback(taste, status, track, "poll")
```

Transport hooks:

```text
/api/player/stop      -> record skip, reason transport.stop
/api/player/next      -> record skip, reason transport.next
/api/player/previous  -> record replay on restart, reason transport.previous.restart
/api/player/previous  -> record skip when stepping away from current, reason transport.previous
```

This is intentionally not wired into queue generation/ranking yet.

## Verification

Focused tests pass:

```text
npm test -- --run tests/listenerTaste.test.ts
# 2 passed

npm test -- --run tests/api.test.ts
# 215 passed
```

Broader LMS client test still has an existing unrelated mismatch around short fake Spotify URIs:

```text
npm test -- --run tests/lmsClient.test.ts
# 59 passed, 2 failed
```

The two failures are in tests that use unresolved short Spotify URI fixtures such as `spotify:track:abc123`; they are not from the taste-store changes.

---

## DIVERGENCE → resolved by ground-truth (Claude reconciliation, 2026-06-11)

**TANDEM (partner: codex) → DIVERGED, resolved in Codex's favor.**

- **Claude (source-read via docker exec):** `API.pm` `relatedArtists` calls `artists/{id}/related-artists` and `recommendations` calls `recommendations` — both Spotify Web-API endpoints deprecated 2024-11-27 — and `DontStopTheMusic.pm` is built on `$spotty->recommendations(...)`. I concluded Artist Radio / Related Artists / DSTM are **dead**, and that **search** is the only working candidate source.
- **Codex (live JSON-RPC on :9000, no SSH needed):** the Spotty **browse menu** returns **Artist Radio = 200 playable tracks** and **Related Artists = 20 artists**, each drillable to Top Tracks / Artist Radio / Related Artists.
- **Resolution (Claude re-verified live):** replayed the navigation against `127.0.0.1:9000`. Artist Radio for beabadoobee returned **real, current, on-taste tracks** (Steve Lacy "Bad Habit", Ricky Montgomery "Mr. Loverman", Liana Flores, TV Girl, …), 200 available, real `spotify:track:` URIs. **Codex's ground-truth wins.** The browse-menu "Artist Radio" reaches a still-working radio mechanism distinct from the deprecated raw Web-API functions in the source (likely librespot/internal path). My source-read inference was wrong.

**Design impact:** candidate generation's PRIMARY source is the **Spotty browse graph** —
`search → Artists bucket → artist → Artist Radio (200) and Related Artists (20) → their Top Tracks /
Artist Radio` — seeded from the listener's taste profile (top artists) and the now-playing track's
artist. The listener's own history/co-listening (`listenerTaste.js`) and global search are
secondary/fallback. We do NOT need the deprecated Web-API recommendations/related-artists, and we do
NOT need a Spotify token. This is a much richer candidate generator than the "search expansion only"
that my source-read had concluded.

### Remaining nuance to verify in build
- Artist Radio is **artist-seeded**, not track-seeded (no track-radio submenu found). For a track
  seed, expand from the track's artist. Confirm whether Artist Radio results are stable/personalized
  vs. random per call (affects exploration accounting).
- The browse `item_id` paths (e.g. `1.0_beabadoobee.0.0.4`) are navigation-state dependent; the
  implementation must navigate the menu (search → bucket → artist → radio) rather than hardcode ids,
  or find the artist-URI-addressable form.

---

## Build Note: Shared Recommender Implementation

Date: 2026-06-11

Implemented three pieces:

1. `server/lmsClient.js` now has `spotifyRecommendationCandidates(playerId, seedArtists, options)`. It dynamically walks the verified Spotty browse graph: `search -> Artists bucket -> best matching artist -> Artist Radio + Related Artists -> related artist Top Tracks / Artist Radio`. It follows labels and item IDs returned by Spotty at runtime rather than hardcoding navigation-state IDs, dedupes by Spotify URI/title+artist, and falls back to global search when the graph returns too little.

2. `server/recommender.js` now builds a shared household taste profile from all listeners in `listenerTaste.js` and ranks candidate pools. Formula: `score = affinity + exploration - repetition`, where affinity is `0.55*artist + 0.30*track + 0.15*album` using `tanh(aggregate.score/scale)` with confidence from event counts; exploration gives unseen tracks/artists/albums up to `+0.60`; repetition penalizes recent track plays, recent artist exposure, shuffle history, same-artist satiation, and hard skip history. I made skip penalty stronger than the initial draft so repeated skips do not outrank merely recent repeats.

3. `server/app.js` now uses the recommender in generated shuffle/smartQueue paths only. Manual playlist-scoped play remains untouched. If the browse-graph recommender is unavailable or empty, the old global-search candidate path remains the fallback.

Live evidence against LMS JSON-RPC at `192.168.1.142:9000`:

```text
Seed: beabadoobee
Candidate count: 35
Sources observed: artist-radio, related-artist-top-tracks, related-artist-radio
Sample tracks:
  From The Start | Laufey
  better (with you) | Crying City
  She Won't Go Away | Faye Webster
  Pretty Boy | TV Girl
```

Synthetic taste ranking smoke test:

```text
Taste: Faye Webster positive, TV Girl negative
Top ranked live candidate: She Won't Go Away | Faye Webster
```

Verification:

```text
npm test -- --run tests/recommender.test.ts tests/listenerTaste.test.ts
# 4 passed

npm test -- --run tests/api.test.ts
# 216 passed

npm test -- --run
# 326 passed, 2 failed
```

The two remaining failures are the pre-existing short fake Spotify URI playback fixtures in `tests/lmsClient.test.ts`. The previously mentioned flaky batch failure did not reproduce in this run.

---

## Sync design review

Date: 2026-06-11

Scope: no-code design review of `docs/multiroom-plan.md`, checked against Cloud Squeeze's current
stream/player code plus upstream Beatsync and Snapcast source. Verdict: Phase 1 is directionally
sound only if it is treated as a new Web-Audio sync player, not a small extension of the current local
`<audio>` player. The plan's core clock-offset sign is right, but several Beatsync details are
load-bearing and the current transport contract is narrower than the plan says.

### Highest-priority risks / corrections

1. **Current Cloud Squeeze local playback cannot do sample-accurate sync.**

   `src/lib/localPlayer.tsx` is explicitly an `<audio>` implementation: the file header says local
   playback "plays Spotify tracks in the browser via an `<audio>` element" (`src/lib/localPlayer.tsx:1-5`),
   creates `new Audio()` (`src/lib/localPlayer.tsx:174-177`), starts tracks with `audio.src = url;
   audio.play()` (`src/lib/localPlayer.tsx:142-154`), and seeks by assigning `audio.currentTime`
   (`src/lib/localPlayer.tsx:267-275`). There is no `AudioContext`, `AudioBuffer`, or
   `AudioBufferSourceNode.start()` in the current app sources; a targeted search of `server/` and
   `src/` found no WebSocket or Web Audio sync implementation.

   Build consequence: Phase 1 needs a separate synced Web-Audio engine or a substantial replacement
   inside `localPlayer.tsx`. A `MediaElementAudioSourceNode` does not fix scheduling; it lets Web
   Audio process an `<audio>` element, but the element's `play()` timing is still not sample-accurate.

2. **The output-latency formula in the plan is subtly wrong as written.**

   The plan says:

   ```js
   const waitMs  = Math.max(0, T - (epochNow() + clockOffset));
   const waitSec = waitMs/1000 - filteredOutputLatencySec();
   sourceNode.start(audioCtx.currentTime + waitSec, trackOffsetSeconds);
   ```

   Upstream Beatsync computes the same server-time wait, but clamps *after* subtracting output
   latency:

   - `calculateWaitTimeMilliseconds` estimates server time as `epochNow() + clockOffset` and returns
     `Math.max(0, targetServerTime - estimatedCurrentServerTime)` (`.research/beatsync/apps/client/src/utils/ntp.ts:182-185`).
   - `getWaitTimeSeconds` then does `Math.max(0, (waitTimeMilliseconds - outputLatencyMs) / 1000)`
     (`.research/beatsync/apps/client/src/store/global.tsx:343-348`).
   - Beatsync also schedules with enough server-side headroom for max client RTT and max local
     compensation (`.research/beatsync/apps/server/src/managers/RoomManager.ts:624-638`).

   If Cloud Squeeze clamps before subtraction, a near-future start with 20-80ms trusted output latency
   can produce a negative `when` and either throw or start immediately in a device-dependent way. The
   server must schedule far enough ahead, and the client must clamp after local compensation.

3. **The NTP math is right, but the plan omits Beatsync's coded-probe filtering.**

   Beatsync uses the standard four timestamp formula exactly as the plan states:

   ```ts
   const clockOffset = (t1 - t0 + (t2 - t3)) / 2;
   const roundTripDelay = t3 - t0 - (t2 - t1);
   ```

   (`.research/beatsync/apps/client/src/utils/ntp.ts:192-198`). `epochNow()` is high-precision epoch ms
   (`.research/beatsync/packages/shared/utils.ts:1-2`), so the units are milliseconds. Min-RTT offset
   selection is also real: Beatsync returns the offset from the lowest-RTT sample, despite naming it
   `averageOffset` (`.research/beatsync/apps/client/src/utils/ntp.ts:159-180`).

   But Beatsync does more than "16 samples, min RTT": it sends coded probe pairs with a known gap
   (`.research/beatsync/apps/client/src/utils/ntp.ts:40-89`), rejects pairs whose server inter-arrival gap
   does not match the client inter-departure gap (`.research/beatsync/apps/client/src/utils/ntp.ts:126-146`),
   then picks the lower-RTT measurement inside the pure pair (`.research/beatsync/apps/client/src/utils/ntp.ts:148-154`).
   That filters TCP/WebSocket head-of-line delay, GC pauses, and queued samples. For LAN sync this is
   worth copying, not simplifying away.

4. **"All browsers fetch the same existing audio URL" is not a sufficient transport contract.**

   Existing routes are heterogeneous:

   - Spotify local playback uses `/api/local-stream/:id`, which calls `ensureStreamFile(...)` and
     returns a cached MP3 with range support (`server/app.js:1760-1768`). `ensureStreamFile` creates
     a temporary 256k MP3, de-duplicates same-track inflight requests, and stores it as
     `.stream-cache/<trackId>.mp3` (`server/archiveService.js:262-295`). This is the safest current
     source for whole-file fetch/decode.
   - Local-library `/api/stream/:encodedPath` serves the original file and supports byte ranges
     (`server/app.js:1177-1211`). Browser `decodeAudioData` compatibility depends on that file's codec.
   - Archive `/api/archive/file/:name` only accepts `.flac` and serves it via `res.download`
     (`server/app.js:1778-1795`). FLAC Web Audio decode is not portable enough to be the baseline.

   Build consequence: the sync player should define one browser-sync audio URL contract, preferably a
   whole-file browser-decodable MP3/AAC endpoint for Phase 1. Treat `/api/local-stream/:id` as the
   first implementation; do not assume archived FLACs and arbitrary local files are cross-browser
   decodable until a transcoded sync endpoint exists.

5. **Readiness coordination is mandatory, especially on Spotify cache miss.**

   Beatsync does not broadcast play immediately in normal mode. `handlePlay` initiates audio loading
   and only executes play after all clients load or a timeout (`.research/beatsync/apps/server/src/websocket/handlers/play.ts:6-17`).
   RoomManager broadcasts `LOAD_AUDIO_SOURCE`, tracks loaded clients, times out after 3000ms, then
   schedules play (`.research/beatsync/apps/server/src/managers/RoomManager.ts:97-98,168-209,229-274`).

   Cloud Squeeze's first request to `/api/local-stream/:id` can invoke Spotty plus ffmpeg before the
   MP3 exists (`server/archiveService.js:272-295`). A synchronized start must therefore be a two-step
   protocol: load/decode/report-ready, then schedule a future start. A fixed 1s LAN buffer is not
   enough on cache misses.

6. **Pause/resume and mid-track join are underspecified.**

   `AudioBufferSourceNode` is one-shot: pause/resume/seek means stop the old source and create a new
   source with a fresh offset. Beatsync models this explicitly with room playback state
   `{ type, audioSource, serverTimeToExecute, trackPositionSeconds }`
   (`.research/beatsync/apps/server/src/managers/RoomManager.ts:42-47`) and computes a late joiner's
   future execution time and future track offset before unicasting PLAY
   (`.research/beatsync/apps/server/src/managers/RoomManager.ts:915-960`). The Cloud Squeeze plan has the
   fields, but not the required lifecycle.

   Required behavior: a device joining mid-track must fetch/decode, then be scheduled at a future
   server time with `trackOffset = originalOffset + (futureServerTime - originalStartServerTime)`.
   If the offset is near track end or decode cannot complete in time, defer to the next track.

7. **Autoplay, suspended AudioContext, background tabs, and wake behavior need first-class handling.**

   Beatsync's client has an `AudioContextManager` that creates a singleton `AudioContext`
   (`.research/beatsync/apps/client/src/lib/audioContextManager.ts:62-70`), resumes it on a user gesture
   (`.research/beatsync/apps/client/src/store/global.tsx:667-687`), handles iOS interrupted/suspended
   states (`.research/beatsync/apps/client/src/lib/audioContextManager.ts:85-106,235-255`), registers raw
   gesture listeners for an iOS silent-audio bypass (`.research/beatsync/apps/client/src/lib/audioContextManager.ts:108-168`),
   and requests a screen wake lock because WiFi power-save can add 100-300ms packet buffering
   (`.research/beatsync/apps/client/src/lib/audioContextManager.ts:178-210`).

   Phase 1 needs an explicit "join audio" gesture before a client is considered ready. Hidden or
   backgrounded tabs should be marked degraded or forced to rejoin/resync when visible.

8. **WebSocket server infrastructure does not exist in Cloud Squeeze yet.**

   `server/index.js` creates the Express app and calls `app.listen(config.port, ...)`
   (`server/index.js:9-24`). `package.json` has Express but no `ws`/Socket.IO dependency. A targeted
   source search found no existing WebSocket implementation in `server/` or `src/`.

   Build consequence: if sync lives on the same port, `server/index.js` should be refactored to
   create an HTTP server, attach Express and a `ws` server, and keep tests able to call `createApp`.
   A second port is possible but adds proxy/LAN setup friction.

9. **Bluetooth/output-latency handling is best-effort, not tight sync.**

   Beatsync filters `outputLatency` above 100ms and tells Bluetooth users to use manual nudge
   (`.research/beatsync/apps/client/src/store/global.tsx:328-341`). That avoids bad browser-reported
   values, but it does not make Bluetooth tight: codec buffers and OS routing delay can be large and
   variable. Label Bluetooth/remote-output devices as manual-calibration/best-effort.

10. **Snapcast is a higher bar than this browser MVP.**

   Snapcast clients continuously time-sync, decode timestamped chunks, play them through low-level
   audio APIs, and correct deviations by removing/duplicating samples; the README claims typical
   deviation below 0.2ms (`.research/snapcast/README.md:39-43`) and says clients use low-level audio APIs
   for precise timing (`.research/snapcast/README.md:112-114`). The controller performs initial rapid time
   sync (`.research/snapcast/client/controller.cpp:343-366,530-531`). Browsers cannot do that sample
   insertion/removal cleanly, so Cloud Squeeze should not promise Snapcast-grade indefinite lock.

### Design divergence

I would keep the Beatsync-style browser tier, but narrow and harden it:

- Phase 1 should use `fetch(url) -> arrayBuffer -> decodeAudioData -> AudioBufferSourceNode.start(...)`
  against a known browser-decodable sync URL. Do not build on the existing `<audio>` element.
- Start with Spotify `/api/local-stream/:id` MP3s as the supported source. Add a later
  `/api/sync-stream/...` endpoint that transcodes archive/local-library sources to the same
  browser-decodable format if needed.
- Copy Beatsync's readiness flow: `LOAD_AUDIO_SOURCE`, client decodes and reports ready, server
  schedules play with enough headroom for max RTT and max compensation.
- Copy Beatsync's coded probe pair validation and min-RTT estimator. The basic formula is right, but
  the filtering is where the LAN robustness comes from.
- Treat mid-track join, resume, seek, and reconnect as "schedule a new one-shot source at a computed
  future offset", not as operations on the existing source.
- Keep manual per-device nudge, but present Bluetooth/backgrounded devices as degraded.

Clear verdict: Phase 1 is not sound as-is if read literally. It becomes sound after these changes:
fix output-latency clamping/headroom, define a browser-decodable sync audio contract, add a real
WebSocket coordinator, implement a Web-Audio sync engine instead of reusing `<audio>`, and include
readiness/mid-track/reconnect lifecycle from Beatsync.

---

## Phase 1 chunk 2: browser sync client

Built the browser-side Web Audio sync layer in `src/lib/syncEngine.ts` plus a compact join/session panel wired into `App.tsx`, kept separate from the existing `<audio>` local player. The engine joins `/sync`, sends coded probe pairs, selects the min-RTT clock sample, reports RTT/output latency, fetches and decodes `LOAD_AUDIO_SOURCE`, sends `CLIENT_READY`, and schedules `AudioBufferSourceNode.start()` with clamp-after-output-latency plus per-device nudge. Added math tests for clock/wait/min-RTT/output-latency filtering. Verification: `npm run build` passes; `npm test -- --run tests/syncEngine.test.ts` passes 4 tests; full `npm test -- --run` reports 336 passed and the 2 pre-existing `tests/lmsClient.test.ts` short-URI failures. Protocol gap flagged: chunk-1 server sends the joining client a full device list, but does not broadcast roster updates to already-connected clients on `JOIN`/`LEAVE`, so the host UI may not see new guests until another session message updates state.

---

## Streamfile debug (tandem, 2026-06-11) — CONVERGED

**TANDEM (partner: codex) → CONVERGED on the root cause from two vantages.**

- **Claude (live ground-truth, SSH/docker):** a single fetch of a cold track persists fine
  (`.part` grows → rename → `.mp3` stays), but the cache non-persistence reproduced under
  **concurrent fetches** — exactly the sync scenario (host + worker fetch the same `/api/local-stream`
  at once). Warm re-fetch is instant (~0.03s), so the cache itself works; the bug was a
  generate/evict race.
- **Codex (code analysis):** found two real defects in `server/archiveService.js`:
  1. `fetchAndEncode` resolved on **ffmpeg**'s close alone, ignoring spotty's exit — a track where
     spotty errored but ffmpeg emitted partial bytes would resolve, rename, and serve a bad file.
  2. `pruneStreamCache()` ran immediately after each generation and could **evict the file just
     created** (it had no protection for the new id) — the non-persistence under concurrency.
- **Fix (Codex, verified by Claude live):** wait for BOTH processes + check BOTH exit codes +
  `assertNonEmptyFile`; `pruneStreamCache({ keepIds })` protects the just-generated track; clean up
  partial `.part` on error/timeout; 2-min encode timeout; configurable cache size/bitrate; test hooks
  + `tests/archiveService.test.ts` (2 pass).
- **Verified live:** 2 concurrent cold fetches → both 200 (~7.7s), file **persists**, warm re-fetch
  **0.034s**.

Separately (Claude): the readiness gate now waits up to 30s for ALL devices to buffer before the host
starts (`READY_TIMEOUT_MS` 3s→30s) so a cold/slow device still joins in sync, with a
"waiting for the group" UI state. Pre-warm generates the now-playing stream while a session is active.
