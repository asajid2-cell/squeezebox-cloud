# Cloud Squeeze — Casting & Multi-Room Sync — Build Plan

Synchronized multi-device playback. Scope (confirmed with the user): **two tiers** — tight sync on
the home LAN, best-effort sync for remote devices over the internet; endpoints = **web browsers
(join-via-link), Chromecast/Cast, and the Squeezebox Boom + smart speakers**; model = **buffered
start** (accept a 1–3s startup delay, buffer everyone to the slowest link, then lock to a shared
timeline — the Snapcast/AirPlay-2 approach).

Backed by deep-research (`tasks/w71cd06rz` — Snapcast, AirPlay 2/NQPTP, Web Audio 1.1 spec, Beatsync,
SyncTune, LMS SlimProto; 21/25 claims confirmed). Sources cited inline.

---

## 1. The core architectural truth (this shapes everything)

**You cannot sample-lock heterogeneous endpoints to one timeline from our server.** Every native
ecosystem (LMS squeezeboxes, AirPlay 2, Sonos, Chromecast) uses its *own* internal clock and cannot
be locked to a foreign timeline. So the design is **three independent synchronized domains**, each
tight *within itself*, aligned *across* domains only by a coarse per-domain delay offset:

```
                 ┌──────────────── Sync Coordinator (Node/Express + WS) ─────────────────┐
                 │  authoritative server clock · session = {track, startAtServerTime T}   │
                 │  per-domain delay offset (coarse cross-domain alignment, by ear)        │
                 └───────┬───────────────────────┬───────────────────────────┬───────────┘
                         │ TIGHT (we control)     │ native group (free)       │ native group (best-effort)
                         ▼                        ▼                           ▼
                ┌─────────────────┐      ┌──────────────────┐        ┌────────────────────┐
                │  BROWSER GROUP  │      │  LMS / SQUEEZEBOX │        │  CAST / AIRPLAY     │
                │  Web Audio API  │      │  Boom + others    │        │  Chromecast groups  │
                │  NTP clock +    │      │  LMS native sync  │        │  Cast/PTP native    │
                │  buffered start │      │  (sample-accurate │        │  (proprietary; NOT  │
                │  ← THE MVP      │      │   among squeezebx)│        │  server-lockable)   │
                └─────────────────┘      └──────────────────┘        └────────────────────┘
```

- **Browser group** is the one tier *we* build to near-sample accuracy. It's the MVP and the bulk of
  the work.
- **LMS group** already syncs squeezeboxes among themselves for free; we only align its *start* to
  the browser timeline approximately.
- **Cast/AirPlay** sync within their own groups; we align by a per-group delay offset, not a lock.

### What is NOT achievable (state plainly, don't over-promise)
- Sample-accurate sync to a **stock Chromecast** from our server — Cast exposes no public clock-sync
  hook for a custom receiver to lock to a foreign timeline. [Cast docs; the "only the slider" claim
  was refuted as overstated, but the no-server-lock conclusion stands — medium confidence.]
- Sample-accurate **cross-domain** lock (browser ↔ squeezebox ↔ Cast). Only coarse per-domain offset.
- **Microsecond internet sync** — asymmetric routing caps it; a 168µs one-way shift → 84µs
  unrecoverable error even on a managed WAN. Internet tier is *tens of ms*, best-effort, by design.
- **Indefinite browser drift-lock without re-sync** — browsers can't insert/drop samples like native
  clients; they re-sync periodically + offer a manual nudge.

---

## 2. The browser group — the buildable core (Beatsync-proven recipe)

This is Phase 1. It IS the join-via-link multi-room feature. All proven in Beatsync's live source
(verified at HEAD ~2026-06-11; re-check before copying — it's fast-moving).

### 2a. Clock sync — NTP-style 4-timestamp over WebSocket
Client and server exchange `t0` (client send), `t1` (server recv), `t2` (server send), `t3` (client
recv):
```
clockOffset    = (t1 - t0 + (t2 - t3)) / 2
roundTripDelay = (t3 - t0) - (t2 - t1)
```
Collect ~16 samples at 50ms, **select the offset from the minimum-RTT sample** (RFC 5905 §10 — queuing
only adds to RTT, so min-RTT is closest to true propagation delay; better than averaging on noisy
links). Re-probe every ~2500ms. → sub-ms on LAN, tens-of-ms over internet.
[Snapcast binary_protocol.md; Beatsync; timesync.]

### 2b. Buffered-start scheduling — the Web Audio primitive
Server tells every client: "play track from `trackOffsetSeconds`, at server time `T`." Each browser:
```js
const waitMs  = T - (epochNow() + clockOffset);                        // server-time wait (ms)
const waitSec = Math.max(0, (waitMs - filteredOutputLatencyMs)) / 1000;// CLAMP AFTER latency subtraction
sourceNode.start(audioCtx.currentTime + waitSec, trackOffsetSeconds);  // sample-accurate within this context
```
**Correction (tandem review):** clamp `Math.max(0, …)` AFTER subtracting output latency, not before
(the original draft clamped first — a near-future start minus 20–80ms latency then yields a negative
`when` that throws or fires immediately, device-dependent). The **server must schedule `T` with
headroom = max client RTT + max output-latency compensation** so `waitMs` never goes negative for any
client. [Beatsync `ntp.ts:182-185`, `global.tsx:343-348`, `RoomManager.ts:624-638`.]
- `AudioBufferSourceNode.start(when, offset)` is sample-accurate **within one AudioContext** (W3C
  Web Audio 1.1). `currentTime` advances in ~128-frame render quanta (~2.7ms granularity).
- **Filter `outputLatency`**: trust wired (~24ms), **ignore > 100ms** (Bluetooth reports ~648ms
  garbage) and fall back to the manual nudge for those devices.
- Use `getOutputTimestamp()` (`contextTime` = frame hitting the speakers *now*, `performanceTime` =
  when) to measure *true* drift; low-pass-filter it (Chrome's values are noisy).
[W3C Web Audio 1.1; MDN; Beatsync.]

### 2c. Drift correction (browser = the weakest link — be pragmatic)
Browsers cannot resample/insert samples natively. Proven shipping choice (Beatsync): **periodic NTP
re-sync** (re-issue corrected schedules) **+ a per-device manual nudge offset** (persisted server-side,
restored on reconnect). Continuous `playbackRate` nudging (0.999–1.001) is *experimental* — no
verified production system relies on it; treat as a later optional refinement. [Beatsync; Snapcast.]

### 2d. Transport for the browser group
**Raw-ish: all browsers fetch the SAME audio URL** (our existing `/api/local-stream/:id` for Spotify,
`/api/archive/file` for archives, `/api/stream` for uploads), decode to an `AudioBuffer`, and schedule
a synced `start` — Beatsync's file-sync model. This reuses what we already serve; no new PCM streaming
needed for v1. (Snapcast-style timestamped PCM over WebSocket is the alternative for live/line-in
sources — heavier, defer.) LL-HLS/Icecast = seconds of latency, only viable for the loosest tier.
[Snapcast; SyncTune; transport finding.]

### 2e. Per-tier buffer
LAN tight tier: **~1s** startup buffer (Snapcast default `bufferMs=1000`, <0.2ms LAN deviation).
Internet best-effort tier: **2–3s+** (absorb jitter). Exact sizes need on-device tuning (open Q).

---

## 2.5 Tandem review corrections (MUST apply — Phase 1 is NOT sound without these)

Codex stress-tested this against our real code + the Beatsync/Snapcast source (`TANDEM.md` →
"Sync design review"). Converged with Claude's assessment on the big risks; caught three more:

- **Build a new Web-Audio engine — do NOT extend the current `<audio>` player.** `src/lib/localPlayer.tsx`
  is a plain `new Audio()` + `audio.play()` + `audio.currentTime` element (`:1-5,142-154,174-177,267-275`)
  — no `AudioContext` anywhere, and `MediaElementAudioSourceNode` does NOT add sample-accurate
  scheduling. Phase 1 = a separate Web-Audio sync engine: `fetch(url) → arrayBuffer → decodeAudioData
  → AudioBufferSourceNode.start(when, offset)`.
- **Readiness handshake is mandatory (Spotify cache-miss will break a fixed buffer).** First hit to
  `/api/local-stream/:id` runs Spotty+ffmpeg *before* the MP3 exists (`server/archiveService.js:262-295`),
  which can take seconds — a fixed 1s buffer underruns. Use Beatsync's flow: server broadcasts
  `LOAD_AUDIO_SOURCE` → each client fetches/decodes and reports **ready** → server schedules the future
  start once all ready (or a ~3s timeout). [Beatsync `play.ts:6-17`, `RoomManager.ts:168-274`.]
- **Define one browser-decodable sync-audio contract.** Existing routes are heterogeneous:
  `/api/local-stream/:id` = cached 256k MP3 with ranges (safe, **use first**); `/api/stream/:path` =
  original file (codec-dependent decode); `/api/archive/file` = **FLAC via `res.download`**
  (`decodeAudioData` FLAC support is NOT portable — don't use as the baseline). Phase 1 source =
  `/api/local-stream`; add a later `/api/sync-stream` that transcodes archive/library to the same
  MP3/AAC for sync.
- **Copy Beatsync's coded-probe filtering, not just "16 samples / min-RTT."** It sends probe *pairs*
  with a known client gap and rejects pairs whose server inter-arrival gap ≠ client inter-departure
  gap (`ntp.ts:40-89,126-154`) — this filters TCP head-of-line / GC-pause delay and is where LAN
  robustness actually comes from.
- **Transport/server refactor:** no WebSocket infra exists. `server/index.js:9-24` just does
  `app.listen`; `package.json` has no `ws`. Refactor `index.js` to create an `http.Server`, attach
  Express + a `ws` server on the same port, and keep `createApp` callable for tests.
- **Lifecycle = always "schedule a new one-shot source at a computed future offset."**
  `AudioBufferSourceNode` is one-shot; pause/resume/seek/mid-track-join/reconnect all mean stop the
  old node and start a fresh one. A late joiner gets `trackOffset = originalOffset + (futureStart −
  originalStart)`; if that's near track end or it can't decode in time, defer to the next track.
- **Autoplay + degraded devices:** require a "join audio" user gesture (AudioContext starts
  `suspended`); request a screen wake-lock (WiFi power-save adds 100–300ms); mark backgrounded tabs
  and Bluetooth outputs (`outputLatency > 100ms`, e.g. ~648ms) as **manual-nudge / best-effort**, not
  tight.

**Verdict (Codex, converged with Claude):** Phase 1 is sound *after* these changes — fix the latency
clamp/headroom, add the Web-Audio engine, the WS coordinator, the browser-decodable audio contract,
and the readiness/mid-track/reconnect lifecycle. It is NOT a small extension of the current player.

## 3. Data model (server state)

```
SyncSession {
  id, name, shareToken            // join-via-link
  hostId                          // who controls transport
  track { uri/id, source, durationMs }
  state: "playing" | "paused"
  startAtServerTime               // epoch ms: when trackOffset=0 plays
  trackOffsetMs                   // position the timeline maps to startAtServerTime
  domains: {
    browser: { devices: [DeviceState], bufferMs }
    lms:     { groupId, delayOffsetMs }      // coarse align to browser timeline
    cast:    { groupId, delayOffsetMs }
  }
}
DeviceState { id, label, clockOffsetMs, rttMs, outputLatencyMs, nudgeMs, volume, lastSeen }
```
Transport events over WebSocket: `JOIN`, `CLOCK_PING/PONG`, `SET_TRACK {uri, startAtServerTime,
trackOffsetMs}`, `PAUSE/RESUME {atServerTime}`, `SEEK`, `NUDGE {deviceId, ms}`, `LEAVE`.

---

## 4. Build order (phased; tightest, most-controllable tier first)

- **Phase 1 — Browser group, LAN tight (MVP).** WS sync coordinator + NTP clock sync + Web Audio
  buffered-start over the existing audio URLs + per-device nudge. Two phones/laptops on the LAN play
  a track in tight sync. Join-via-link creates/joins a `SyncSession`. *This is the headline feature.*
- **Phase 2 — Internet best-effort tier.** Same mechanism, larger buffer (2–3s), looser tolerance,
  surface the manual nudge prominently. Remote friend opens the link, hears it ~together.
- **Phase 3 — Bridge the LMS/Boom group.** Treat squeezeboxes as one LMS-synced group; align its
  *start* to the browser timeline via a `delayOffsetMs` (by ear). Investigate open Q: does LMS
  CLI/JSON-RPC expose its playhead so we can align programmatically? [LMS SlimProto/Synchronization
  wiki found but no verified claim — spike it.]
- **Phase 4 — Cast group.** Custom CAF receiver, best-effort aligned via per-group delay offset.
  Lowest priority, weakest sync, most uncertain (Cast internals proprietary).

---

## 5. Control & UX decisions
- **Control model (decided):** the session **host drives transport** (play/pause/skip/seek for
  everyone); **guests request/vote** (add to queue, vote on next) — mirrors Cloud Squeeze's existing
  jukebox request model. `SyncSession.hostId` holds transport rights; guest actions go through the
  existing queue/request path, gated by `publicRequestsOpen()`. A public share link = guest role by
  default; host role is the session creator.
- Group management UI: create session → QR/link → devices appear with per-device volume + nudge.
- Relationship to the existing **PlaybackMode** (Squeezebox vs Local): a sync session is a new mode
  layered on the local-player engine (`localPlayer.tsx`) — the synced group is "local players that
  share a timeline."

## 6. Open questions the research flagged (resolve during build)
1. Cast: any private CAF hook to align a custom receiver to an external timeline, or is per-group
   delay the only lever? (Mechanism unverified — strongest claim was refuted.)
2. LMS: does its CLI/JSON-RPC expose the server-side playhead / per-player timing so we can align the
   browser timeline to the squeezebox group? (No verified source — spike it.)
3. Browser drift: does subtle `playbackRate` nudging hold sub-perceptible drift over 10+ min, or is
   periodic NTP re-sync + manual nudge the ceiling? (Beatsync deliberately avoids resampling.)
4. Concrete per-tier buffer sizes (LAN ~1s vs internet 2–3s+) — tune on real devices.

## 7. Sources (primary unless noted)
Snapcast binary protocol — https://github.com/snapcast/snapcast/blob/master/doc/binary_protocol.md ·
Beatsync — https://github.com/freeman-jiang/beatsync · SyncTune — https://github.com/synctune/synctune ·
timesync — https://github.com/enmasseio/timesync · Web Audio 1.1 — https://www.w3.org/TR/webaudio-1.1/ ·
AudioBufferSourceNode.start — https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start ·
getOutputTimestamp — https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp ·
Shairport-Sync AirPlay2 — https://github.com/mikebrady/shairport-sync/blob/master/AIRPLAY2.md ·
NQPTP — https://github.com/mikebrady/nqptp · Cast PlayerManager — https://developers.google.com/cast/docs/reference/web_receiver/cast.framework.PlayerManager ·
LMS SlimProto — https://wiki.lyrion.org/index.php/SlimProto_TCP_protocol.html · Endace PTP/WAN — https://www.endace.com/ptp-timing-whitepaper
