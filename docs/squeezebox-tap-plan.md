# Squeezebox Tap — Build Plan

## 1. One-Sentence Definition
Squeezebox Tap lets you stick an NFC tag on a physical album (or any object), bind that tag to a song/album in your existing music library, and have **any phone that taps it instantly start that music on your Squeezebox speaker** — a wireless "tap to play your vinyl" bridge between the physical record and the digital library you already stream.

## 2. Assumptions
These were inferred, not stated. Correct any that are wrong before Phase 1.

- **Tap = a module inside `cloud-squeeze`, not a new service.** The resolver must call `lms.playTrack()` in-process, reuse the LMS client, auth, Docker image, and nginx route. A standalone service would have to re-implement or HTTP-proxy all of that for no benefit.
- **One speaker.** There is a single active LMS player resolved by `hotPlayerId(lms)`. Multi-room / pick-a-speaker-per-tag is out of MVP (see §15).
- **The tag stores an opaque ID, not the target** (confirmed: Option B). URL form: `https://harmonizerlabs.cc/tap/t/<tagId>`. The server maps `tagId → PlaySpec`.
- **Open jukebox** (confirmed): any phone that taps plays immediately, no login — works over wifi/cellular, **not** LAN-IP-locked. Physical access to the tag *is* the authorization. The handshake guard is a **signed token baked into each tag** (HMAC of `tagId`) that `POST /api/tap/:id/play` requires, so the endpoint can't be triggered by guessing/spraying `/t/:id`. Rate-limit + an **optional global password** (HTTP basic over `/tap`) are available but off by default — "don't lock it down, password only if needed."
- **Tag hardware = NTAG21x (NTAG213/215/216)**, the standard cheap NFC sticker. URL-type (NDEF) records, read natively by iOS + Android with no app.
- **Writing tags = Web NFC in Chrome-on-Android** for MVP. iPhones can *read/tap* finished tags fine; they just can't *write* them, which is fine because you write with your Android.
- **Target is captured as a fully-resolved, already-validated playable object at bind time** (local path / LMS id / Spotify URI + display metadata). Because the binding is **admin-created and server-trusted**, the resolver replays it through a **trusted internal play path that bypasses the guest `spotifyTracksAreKnown` gate** (a small, deliberate edit to cloud-squeeze), with live re-search as a fallback if a stored Spotify URI ever goes stale. See §13.
- **Real album playback** is in scope (decided): `album-from-top` loads the entire album and starts at track 1 via a proper LMS album-load — not a "play first track + manually queue the rest" approximation.
- Persistence is a small JSON/SQLite store living beside the existing cloud-squeeze state, not a new database server.

## 3. Users & Jobs-to-Be-Done

**Curator (you / household admin)** — the person who binds tags.
- *Needs:* search the library, pick "this whole album from the top" or "this one representative track," get a tag, and physically write it in under a minute.
- *Success:* a stack of labelled albums, each with a tag that Just Works, re-pointable later without re-writing the sticker.

**Tapper (anyone in the room — you, a friend, a guest)** — the person who taps.
- *Needs:* tap album → music plays on the speaker within ~2 seconds → a glanceable "now playing" confirmation on their phone. Zero setup, no app, no login.
- *Success:* it felt like magic; the physical record "played itself."

Single shared speaker, single shared room. No per-user accounts for tappers by design.

## 4. Core User Flows

### Flow A — Bind & write a tag (Curator, one-time per tag)
The writer lives at its **own dedicated, separated link** — `harmonizerlabs.cc/tap/link` — on the same cloud-squeeze backend but kept clean and distinct from both the tap landing page and the rest of the cloud-squeeze UI. You open it on your Android, do everything for a tag in one place, write, done.
1. Curator opens `harmonizerlabs.cc/tap/link` on Android-Chrome (gated by existing hl-auth admin session).
2. Searches the library (reuses `/api/library/search` + `/api/spotify/search`) and selects an album or track.
3. Chooses target intent: **Whole album from the top** (default) or **Just this track** (the "representative song").
4. Backend creates a binding: generates `tagId`, stores the resolved `PlaySpec` + display metadata (title, artist, cover art id), returns `tagId` and the tap URL.
5. Curator holds a blank NFC tag to the phone and presses **Write tag**. Web NFC (`NDEFReader.write`) burns the URL. Page confirms "Tag written."
6. Optional: print/write a human label for the sleeve.

The same `/tap/link` page also hosts the **tag list** (re-point, disable, tap counts) so the entire curator workflow is one separated link.

### Flow B — Tap to play (Tapper, every time)
1. Tapper holds phone to the tag. **The phone OS reads the URL tag natively and opens the browser** to `https://harmonizerlabs.cc/tap/t/<tagId>`. (No code of ours runs to read the tag.)
2. That page immediately issues `POST /api/tap/:tagId/play`.
3. Resolver: look up binding → debounce double-tap → `playerId = hotPlayerId(lms)` → load the PlaySpec (album from top, or single track) → `play-now`.
4. Server returns now-playing payload; the page renders a **now-playing card** (cover, title, artist, "Playing on <speaker>"), with a small Pause/Skip control.
5. `tapCount++`, `lastTappedAt` updated for analytics.

### Flow C — Re-point a tag (Curator, anytime)
1. The `/tap/link` page lists all tags with cover, title, tap count, last tapped.
2. Curator clicks a tag → "Change target" → search → pick new album/track → save.
3. **No re-writing the sticker.** Next tap plays the new target. (This is the entire payoff of Option B.)

## 5. Mental Model
A **Tag is a permanent dumb handle; the Binding is the meaning, and the meaning lives on the server.** The physical sticker holds nothing but an opaque ID forever. Everything interesting — what plays, the cover shown, whether it's an album or a single track, whether it's even enabled — is a server-side row you can edit freely.

The resolver is a **thin, fast, idempotent translator**: `tagId → PlaySpec → one existing playback call`. It must add *zero* new music logic. If you ever find Tap re-deriving playback behavior that `cloud-squeeze` already does, you've taken a wrong turn — call the existing primitive.

**Invariants:**
- A tap never fails silently. It either plays and shows now-playing, or shows a clear human reason (tag not bound, speaker offline, disabled).
- Writing a sticker happens once; meaning can change infinitely.
- The resolver is read-mostly on the binding and never mutates the PlaySpec.

**What Tap is NOT:** not a music player, not a library manager, not an auth system, not a queue manager. It is a *resolver + a binding UI + a tag writer*. All playback, library, and speaker control already exist in cloud-squeeze and are reused verbatim.

## 6. Data Model

### Entity: `TapTag`
| Field | Type | Notes |
|---|---|---|
| `tagId` | string (8–10 char base32, URL-safe) | Opaque, stable, printed nowhere-decodable. Primary key. |
| `enabled` | bool | Soft on/off without deleting the binding. |
| `playSpec` | object | The resolved, pre-validated playback target. See below. |
| `display` | object | `{ title, artist, coverId, kind }` — frozen snapshot for the now-playing card and admin list; avoids a library round-trip at tap time. |
| `label` | string? | Human note ("Kind of Blue — sleeve"). |
| `createdAt` | ISO ts | |
| `tapCount` | int | Analytics. |
| `lastTappedAt` | ISO ts? | Analytics + double-tap debounce. |

### Value object: `PlaySpec`
A discriminated union mirroring what `lms.playTrack` / album-load already accept:
- `{ kind: "album-from-top", source: "local"|"spotify", albumId? , albumUri? }` → load the whole album, start at track 1.
- `{ kind: "album-from-track", source: "local"|"spotify", albumId?|albumUri?, track: <resolved> }` → **the representative-song case (DECIDED, in MVP):** load the whole album, then start at the chosen track and continue to the end of the album. `track` carries the exact object shape cloud-squeeze validates (local path / LMS track id / Spotify URI + provenance fields).
- `{ kind: "track", track: <fully-resolved playable track object> }` → play only that one track (kept as a primitive; the representative-song binding uses `album-from-track`).
- `{ kind: "playlist", playlistId }` → (v1.0) play a saved playlist.

**State machine (tag lifecycle):** `unbound → bound(enabled) ⇄ bound(disabled) → re-pointed(new PlaySpec, same tagId)`. Deletion is rare and explicit; disabling is the normal "retire" path.

**Storage:** a single JSON file (`server/tapTags.json`) or a one-table SQLite, persisted on the same Docker volume as existing cloud-squeeze state. JSON is fine for the expected tag count (tens to low hundreds); migrate to SQLite only if write contention or count demands it.

## 7. Stack
Reuse cloud-squeeze's stack wholesale — divergence here is pure cost.

- **Backend: Node + Express 5 (existing).** The resolver is three routes added to the running app. *Why:* in-process access to `lms.playTrack`, `hotPlayerId`, the auth middleware, and the deploy. A separate backend would HTTP-hop to all of this for zero gain.
- **Frontend: React 19 + Vite (existing).** Two new views, each on its **own separated route** under `/tap`: the public **tap landing/now-playing** page (`/tap/t/:id`) and the admin **bind + Web NFC writer** page (`/tap/link`). Same backend, deliberately distinct URLs so the writer stays clean and apart from both the tapper experience and the main cloud-squeeze app. *Why:* the library search components, artwork proxy, and player controls already exist as React; reuse them.
- **Tag writing: Web NFC (`NDEFReader`).** *Why:* ~5 lines, no app store, no second codebase, lives in the page you already loaded. *Tradeoff:* Android-Chrome + HTTPS + user-gesture only. Accepted — your writer phone is Android; readers are unaffected.
- **Persistence: JSON file (MVP) on the existing volume.** *Why:* lowest-friction, matches the scale, no new infra. *Tradeoff:* not concurrent-write-safe at scale — guarded by the existing mutation-lock pattern (`withQueueMutationLock`-style) and acceptable for single-curator writes.
- **Storage of opaque IDs: base32, 8–10 chars, server-generated.** *Why:* short, URL-safe, unguessable enough that open-jukebox abuse needs the physical tag, not URL-spraying (paired with rate-limit).
- **No new auth.** Reuse hl-auth admin gate for the bind UI; the tap/play route is intentionally public (open jukebox) behind rate-limit.

## 8. Architecture

```
                 ┌──────────────────────────────────────────┐
   Tap phone     │             cloud-squeeze (Express)        │
  (any, no app)  │                                            │
       │ taps    │   /tap/t/:id        (React: now-playing)   │
       ▼         │   POST /api/tap/:id/play  ── resolver ─────┼──► lms.playTrack()
  URL NFC tag ──►│        │  lookup TapTag                     │     hotPlayerId()
  (opaque id)    │        │  debounce + rate-limit             │        │
                 │        ▼                                    │        ▼
   Android       │   tapTags.json  (bindings store)            │   LMS (CLI/JSON-RPC)
   Chrome (you)  │                                            │        │
       │ binds   │   /tap/link    (React: search + Web NFC)    │        ▼
       └────────►│   POST /api/tap   (create binding)          │   Squeezebox speaker
                 │   PUT  /api/tap/:id (re-point/disable)       │
                 └──────────────────────────────────────────┘
```

- **Sync:** the tap→play path is synchronous and must be fast (target < 2s to audible). The resolver awaits `playTrack` and returns the now-playing snapshot so the page renders truthfully.
- **Async/none:** analytics counters update inline (cheap). No queue, no jobs.
- **Boundary:** Tap owns the bindings store + two views + three routes. It calls *into* the existing LMS client; it never reaches around it to LMS directly.
- **Serving / domain:** path-based on the existing `harmonizer` nginx site → `harmonizerlabs.cc/tap/*`. Reuses the current container (127.0.0.1:PORT), TLS, and the `harmonizerlabs.cc` cookie domain (so the hl-auth admin session already applies). Subdomain `tap.harmonizerlabs.cc` is the alternative — see §20.

## 9. AI / Algorithm / Decision Logic
N/A — there is no model or scoring. The only "logic" is the deterministic resolver and a double-tap debounce:

- **Double-tap debounce:** if `now - lastTappedAt < DEBOUNCE_MS` (default 3000) **and** the speaker is already playing this exact PlaySpec, treat the tap as a no-op (return current now-playing) instead of restarting from the top. Prevents the "tapped twice, song jumps back to 0:00" annoyance.
- **Rate-limit:** per-tag and per-IP token bucket (default 1 play / 2s) to blunt accidental machine-gun taps and URL-spray abuse.

## 10. Design Language
Register: **fast, physical, celebratory — a record dropping on a turntable, not a settings panel.**

- **Two separate links, two registers.** `/tap/t/:id` is the public tapper page (celebratory, zero-chrome). `/tap/link` is the private curator/writer page (dense, efficient). They share a backend but never share a screen — keep them cleanly apart.
- **Tap page:** one job — confirm the magic. Big cover art, title, artist, "Playing on <speaker>" — visible the instant the page loads. The play call fires on load; the card animates in when it confirms. Minimal controls (Pause, Skip). No nav chrome, no menus.
- **Loading truth:** between tap and "playing," show the cover with a subtle pulsing state — never a blank white page (that reads as "broken tag"). If play fails, the same card flips to a plain-language error ("Speaker's offline" / "This tag isn't set up yet").
- **Admin page:** dense and efficient (Curator, repeat use) — search, a result you click, an album/track toggle, a big **Write tag** button, then the tag list with covers + tap counts.
- **The UI must never:** show a raw `tagId` or URL as the primary content; leave the tapper on a dead page with no feedback; require login on the tap path; demand an app install to tap.
- Build the two views with the **ui-craft** skill so they survive viewport/aspect changes and don't read as AI-generated. Reuse existing artwork-proxy + library components.

## 11. Security, Privacy & Compliance
- **Threat model is deliberately light** (open jukebox, single room, home speaker). The asset at risk is "someone makes the speaker play something," not data. It must **work over wifi/cellular normally** — no LAN-IP lock.
- **Bind/writer routes (`/tap/link`):** gated by the existing hl-auth admin session (`requireAdmin`). Writing/re-pointing/deleting tags is admin-only.
- **Tap/play route:** intentionally public, with a **signed-token handshake**. Each tag's URL carries `?k=<hmac>` where `hmac = HMAC(secret, tagId)`. `POST /api/tap/:id/play` rejects any request without a valid token. This stops the real threat — someone hitting/spraying `/api/tap/:id/play` against guessed ids — without burdening the in-room tapper (the token rides on the tag). Plus per-tag + per-IP rate-limit.
- **Optional global password:** an HTTP basic-auth gate over the whole `/tap` surface, **off by default**, flippable via env/admin when you want to fully lock down.
- **Opaque IDs + signed token:** id alone is useless without the token; the token is unforgeable without the server secret; rate-limit defeats brute force.

**Honest limit of static tags, and the real "tap-only" upgrade (optional tier).**
A standard NTAG21x tag is a *passive store*: a tap and a pasted URL deliver byte-identical data, so **no server-side check can distinguish a fresh tap from a forwarded link** with static tags. The static signed token gives anti-forgery + anti-spray, not anti-paste — that's the ceiling, stated plainly.

To *actually* accept plays only from a physically-tapped tag, use **NTAG 424 DNA chips with SUN (Secure Unique NFC)**: on every tap the chip increments an internal counter and emits a fresh `?ctr=<n>&cmac=<AES-CMAC>` over the URL, keyed by an on-chip AES key that is never readable. The resolver shares the key, verifies the CMAC, and requires the counter to be **strictly greater than the last seen** for that tag — so a pasted/forwarded URL carries a stale counter and is rejected as a replay. No phone app: the chip does the crypto, the OS opens the dynamic URL natively. This is the standard anti-clone/anti-replay NFC technology. *Tradeoffs:* 424 DNA tags cost ~$0.50–1.50 each (vs pennies for NTAG213) and need a one-time AES-key provisioning step (NXP TagWriter/TagXplorer or a writer routine). The resolver shape is identical to the signed-token path — swap static-HMAC verification for CMAC+counter verification — so this is a drop-in upgrade tier, not a redesign. See §15/§20.
- **No PII.** Tappers are anonymous; only aggregate tap counts are stored. No tapper identity in logs.
- **Reuse the existing `publicRequestsOpen()` gate** as the master "jukebox open/closed" switch so Tap honors party-mode/quiet-hours consistently with the rest of cloud-squeeze.
- Compliance: N/A — no regulated data, personal/household use.

## 12. Constraints

**Hard:**
- Tap-time reading needs **zero app** — must be a URL/NDEF tag the OS opens natively. (Non-negotiable; it's the whole UX.)
- Web NFC **writing** is Chrome-Android + HTTPS + user-gesture only. iOS cannot write.
- The resolver must call existing cloud-squeeze playback primitives, not reimplement playback.
- Spotify track targets must satisfy cloud-squeeze's `spotifyTracksAreKnown` provenance check — so the PlaySpec must be captured from a real search/library result at bind time, never hand-built.

**Soft:**
- Tap→audible latency target < 2s (LMS + Spotify cold-start can exceed this; surface honest loading state rather than fake speed).
- Single speaker for MVP.
- JSON store is fine to ~hundreds of tags; revisit beyond that.

## 13. Pitfalls
Specific to this system — not generic advice.

1. **"Album from top" is NOT the same call as "play this track" — and we're building the real thing.** `lms.playTrack(..., "play-now")` plays a single track. To play a *whole album from track 1* you must load the album (local: `playlistcontrol cmd:load album_id:<id>`; Spotify: `playlistcontrol cmd:load` with `spotify:album:<id>`), then it plays from index 0. **Add one thin album-load method to `lmsClient.js`** (`loadAlbum(playerId, { source, albumId|albumUri })`) and have the `album-from-top` PlaySpec call it — do not approximate with "first track + manual queue," and do not bake album logic into the Tap module. Capture `album_id` / `spotify:album:` URI at bind time from the search result.
2. **The Spotify "known track" gate must be bypassed for trusted bindings — engineer around it.** `spotifyTracksAreKnown` exists to stop *guests* injecting arbitrary Spotify URIs. A Tap binding is admin-created and already validated, so the resolver must use a **server-trusted play path that skips that guest check** (e.g. an internal `playTrackTrusted` or a `trusted:true` flag threaded into the existing handler — a deliberate edit to cloud-squeeze, which is allowed). Store the exact validated object at bind time; if a stored Spotify URI ever fails to play, fall back to a **live re-search** by title+artist and replay the fresh result. Add a bind-time test play to prove round-trip before the tag is written.
3. **Frozen display metadata can rot.** If you re-point a tag but forget to refresh `display`, the now-playing card shows the old cover. Re-pointing must overwrite `display` from the new target.
4. **Double-tap restarts the song** (NFC fires reads readily; people tap twice). Without the §9 debounce, the second tap reloads from 0:00 — feels broken. Build the debounce in Phase 1, not as a polish item.
5. **Blank-page-on-tap reads as a dead tag.** The tap page must render the cover + a loading state *before* the play call resolves. A white flash while awaiting the resolver will make good tags feel broken.
6. **Web NFC needs a user gesture + HTTPS.** You cannot auto-write a tag on page load; the **Write tag** button press is mandatory. Localhost-over-http will silently lack `NDEFReader`. Test on the real HTTPS domain on a real Android device — desktop Chrome will not expose the API.
7. **Re-pointing must be a server edit, never a re-burn.** If the team ever encodes the target into the tag URL "to save a lookup," Option B's entire value evaporates and every change becomes a physical chore. Keep the tag opaque.
8. **`hotPlayerId` can return no player** (speaker off/disconnected). The resolver must detect this and return the honest "speaker offline" card, not a 500.

## 14. MVP Scope

**In:**
- Opaque-ID bindings store (JSON) with create / re-point / disable / list.
- Three routes: `POST /api/tap` (bind), `PUT /api/tap/:id` (re-point/toggle), `POST /api/tap/:id/play` (resolve+play).
- Writer page on its **own separated link `/tap/link`**: library/Spotify search → pick → album-from-top **or** single-track toggle → **Write tag** (Web NFC) → tag list with covers + tap counts. Distinct route from the tap landing and from the main cloud-squeeze UI.
- Tap landing page: fires play on load, renders now-playing card with loading + error states, Pause/Skip.
- `album-from-top` and `track` PlaySpec kinds working end-to-end on local **and** Spotify sources.
- Guardrails: double-tap debounce + per-tag/IP rate-limit + open/closed master switch.

**Out (MVP):** reader-station hardware; playlist PlaySpec; per-tag speaker selection; native Kotlin writer; iOS writing; analytics dashboards beyond raw counts; tag batch-printing.

**Manual substitutes for unbuilt features:** reader station → just tap your phone; per-tag speaker → single speaker; batch printing → hand-label sleeves.

**Success metric:** stick a tag on a real album, tap it with a phone that has never seen the site, and the correct album plays from the top on the Squeezebox in under 2 seconds, with a now-playing card — and re-pointing that same tag to a different album in the dashboard changes what plays **without** re-writing the sticker.

## 15. Full Scope (v1.0+)
- **Reader station:** Raspberry Pi / ESP32 + PN532 by the speaker; tap the album coaster to *it*, no phone. Same resolver — the station does `POST /api/tap/:id/play` with a station key. (Architecture already supports this; it's a second front-end to the same endpoint.)
- **Per-tag speaker / multi-room:** PlaySpec gains a target player; resolver routes accordingly.
- **Playlist & "shuffle this artist" PlaySpecs.**
- **Native Kotlin writer** (offline batch writing, iOS-readable tags) as the documented fallback to Web NFC.
- **Tag analytics view:** most-tapped albums, taps over time.
- **"Tap to queue" mode:** a tag adds to the queue instead of replacing (party building a set together).
- **Printable label/QR companion** so non-NFC phones can still trigger via camera.

## 16. Testing Strategy
- **Unit:** `tagId` generation (URL-safe, collision check); PlaySpec discriminated-union parse/validate (zod, matching existing patterns); debounce + rate-limit logic with injected clock.
- **Integration (supertest, existing harness):** `POST /api/tap` creates a binding; `POST /api/tap/:id/play` calls a mocked `lms.playTrack`/album-load with the right args for each PlaySpec kind; `PUT /api/tap/:id` re-points and refreshes `display`; disabled tag returns a clean "not active"; unknown tag returns a clean 404-card payload; speaker-offline path returns the honest error not a 500.
- **Golden cases (the resolver is the heart):**
  1. `album-from-top / local` → album-load with correct `album_id`, index 0.
  2. `album-from-top / spotify` → loads `spotify:album:` URI, index 0.
  3. `track / spotify` → replays the stored provenance object and passes `spotifyTracksAreKnown`.
  4. double-tap within debounce while same album playing → no restart.
- **E2E (Playwright, existing config):** admin search→bind flow renders a tag + tap link; tap page fires play on load and shows the now-playing card. (Web NFC write itself can't be automated — manual test checklist on a real Android device.)
- **Manual device checklist:** write a tag on Android-Chrome; tap with a second Android; tap with an iPhone (read path) — all play.
- **Regression target that must never break:** existing cloud-squeeze playback/queue endpoints — Tap adds routes and must not alter `/api/player/*` behavior.

## 17. Observability
Reuse the existing `logEvent` channel.
- `tap.bind` `{ tagId, kind, source, title }`
- `tap.repoint` `{ tagId, fromKind, toKind }`
- `tap.play.request` `{ tagId, kind }`
- `tap.play.ok` `{ tagId, playerId, latencyMs, title }`
- `tap.play.debounced` `{ tagId }`
- `tap.play.rate_limited` `{ tagId, ip }`
- `tap.play.fail` `{ tagId, reason: "unbound"|"disabled"|"speaker_offline"|"spotify_unknown"|"lms_error" }`
- **Metrics that matter:** tap→ok latency (the "instant" promise), fail-reason distribution (drives fixes), taps/tag (which albums get loved).
- **Debug session shape:** a tap didn't play → find `tap.play.request` for that `tagId` → check for `debounced`/`rate_limited`/`fail.reason` → if `lms_error`, cross-reference the existing LMS client logs / `hotPlayerId`. The fail reason should make 90% of incidents self-diagnosing.

## 18. Build Order

**Phase 0 — Build the two enabling primitives in cloud-squeeze (do first).**
- Add `loadAlbum(playerId, {source, albumId|albumUri})` to `lmsClient.js` and prove it plays a whole album from track 1 (local + Spotify) via a script. Gates everything (pitfall #1).
- Add the **trusted replay path** (internal `playTrackTrusted` / `trusted` flag bypassing `spotifyTracksAreKnown`) and prove a bound Spotify target replays without the guest gate (pitfall #2).
Ship nothing else until both round-trip in a script.

**Phase 1 — Resolver + store (backend, no UI).**
- Bindings store (JSON + lock), `tagId` gen, PlaySpec schema.
- `POST /api/tap/:id/play` with debounce + rate-limit + honest error payloads.
- `POST /api/tap` + `PUT /api/tap/:id`. Integration tests + golden cases green.

**Phase 2 — Tap landing page.**
- React view at `/tap/t/:id`: fire play on load, cover + loading + now-playing card + error states, Pause/Skip. Built with ui-craft.

**Phase 3 — Writer page (own separated link `/tap/link`) + Web NFC.**
- Dedicated route, distinct from `/tap/t/:id` and the main app. Reuse search components; album/track toggle; `NDEFReader.write` behind the **Write tag** button; tag list with covers + counts; re-point flow.

**Phase 4 — Guardrails + polish.**
- Home-wifi-only mode wired to source IP; master open/closed switch via `publicRequestsOpen()`; analytics counters; observability events; deploy route in nginx (`/tap`).

**Parallelizable:** Phase 2 (tap page) and Phase 3 (admin page) once Phase 1's routes exist. Phase 0 blocks all.

## 19. Agent Handoff Notes
You are building inside the **`cloud-squeeze`** repo on the VPS (`harmonizer@192.168.1.142:~/cloud-squeeze`) — the canonical copy is the VPS one, not any local fork. Tap is a **module added to the running Express app + React client**, not a new service.

- **Build Phase 0 first.** Do not write a single route until you've proven (a) album-from-top loading and (b) Spotify-track replay in throwaway scripts. These are the only two things that can sink this project; everything else is plumbing.
- **The resolver calls existing primitives.** `playerId = hotPlayerId(lms)`, then album-load or `lms.playTrack(playerId, track, "play-now")`. If you find yourself writing playback logic, stop — it already exists.
- **Preserve the mental model:** tag = dumb opaque handle; meaning lives server-side; re-pointing is a server edit, never a re-burn. If a "store the target in the URL to skip a lookup" optimization is tempting, reject it — it destroys the whole design.
- **Required failure behavior:** a tap never dead-ends. Unbound / disabled / speaker-offline / spotify-unknown each return a specific human-readable card payload, never a 500 or a blank page. The tap page always renders *something* with a reason.
- **Do not touch** `/api/player/*` or `/api/queue/*` behavior. Add alongside; don't modify.
- **Reuse, don't rebuild:** library search, artwork proxy, hl-auth admin gate, `logEvent`, the mutation-lock pattern, the Docker/nginx deploy. New surface = bindings store + 3 routes + 2 React views + the Web NFC writer.
- Test on a **real Android device over the real HTTPS domain** for anything NFC — the API doesn't exist on desktop or over http.

## 20. Open Decisions

**Resolved (locked by the curator):**
- **Auth posture:** open jukebox, works over wifi/cellular (no LAN lock); signed-token handshake on every tap; rate-limit on; optional global password **off** by default.
- **Album-from-top:** real album-load implementation, not first-track-plus-manual-queue.
- **Spotify gate:** engineer around it by editing cloud-squeeze (trusted replay path) + live-search fallback.
- **Repo/separation:** one repo (cloud-squeeze); separation is purely the served endpoint (`/tap/t/:id`, `/tap/link`).
- **Domain shape:** path-based `harmonizerlabs.cc/tap/*` (reuses existing nginx site, TLS, and cookie domain — fewest moving parts).
- **Persistence:** JSON file for MVP behind a small store interface; SQLite later if needed.
- **Representative-song semantics (DECIDED):** a representative song = **`album-from-track`** — start the album *at that song* and keep playing to the end of the album. Pure single-track play stays available as a primitive. Both rely on the real album-load.

**Residual (does not block the build):**

1. **Forwarded-full-URL playback.** The signed token stops API spray, but a friend forwarding a *complete* real tag URL could still trigger a play. The only mitigation is flipping the optional global password on. **Recommendation:** leave password off (matches "don't lock it down"); revisit only if it's actually abused. **Blocks build?** No.
