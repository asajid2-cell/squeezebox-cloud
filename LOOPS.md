# LOOPS.md — Squeezebox Tap (NFC tap-to-play)

Loop-driven build ledger. Plan: [docs/squeezebox-tap-plan.md](docs/squeezebox-tap-plan.md).
Branch: `squeezebox-tap`. Co-engineered in tandem with Codex (ledger: `tandem/tandems/squeezebox-tap/TANDEM.md`).

> **State lives here, not in context.** Re-read this file + `git log --oneline -15` at the start of every iteration.

---

## CONTRACT — change-controlled (edit only with a dated reason; goal changes go to the user)

### Grand Goal Contract
A robust, fully-tested Tap feature inside cloud-squeeze. Done = all criteria below verified with evidence.

| # | Observable outcome | Verifier (machine-checkable) |
|---|---|---|
| GG1 | `lmsClient.loadAlbum` plays a whole album from track 1 — local (`album_id`) and Spotify (`spotify:album:`) | `npm test -- lmsClient -t "loadAlbum"` asserts exact LMS commands |
| GG2 | `album-from-track` loads the album and starts at the chosen track (not silently "from top") | `npm test -- lmsClient -t "album-from-track"` asserts start-position command |
| GG3 | A trusted (admin-bound) Spotify target replays without the guest `spotifyTracksAreKnown` gate | `npm test -- api -t "trusted replay"` |
| GG4 | Search/library results expose `albumId`/`albumUri` so the binder can build album specs | `npm test -- -t "album identity"` |
| GG5 | Tap store: create/read/update bindings; opaque `tagId`; signed token; atomic persist | `npm test -- tapStore` |
| GG6 | Admin binding API: `POST/GET/PUT /api/tap`, admin-gated, returns tap URL w/ `#token`, re-point w/o rewrite | `npm test -- api -t "Tap admin binding API"` |
| GG7 | Public resolver `POST /api/tap/:id/play`: token verify; all PlaySpec kinds; bad-token reject; clean unknown/disabled/offline payloads; debounce + rate-limit don't restart | `npm test -- api -t "Tap resolver golden cases"` |
| GG8 | NFC adapter writes via `NDEFReader.write`; mock drives the full write→tap lifecycle headless | `npm test -- tapNfc -t "NFC writer mock"` |
| GG9 | `/tap/t/:id` view: posts token on load; loading/now-playing/error states; Pause/Skip | `npm test -- -t "Tap landing"` + playwright |
| GG10 | `/tap/link` view: admin-only writer; search/select; album toggle; create+write+list+disable+re-point | `npm test -- -t "Tap link"` + playwright |
| GG11 | End-to-end synthesis: full lifecycle green; no regression to existing suite | `npm test && npm run build && npm run test:ui` |

**HUMAN-GATE (no autonomous loop may claim these):**
- Real NTAG write + tap on a physical Android device (mock proves logic, not hardware).
- Real LMS playback on the Boom speaker (CI mocks the LMS socket).
- Final UI taste/polish (ui-craft viewport-battery is machine-checkable; aesthetic judgment is human).

### Loop contracts (ordered by dependency, then risk)

```yaml
loop 1: Album-load primitive
  invariant: "loadAlbum issues NATIVE LMS album-load (not manual per-track queue) for local + Spotify, play-now"
  scope: { in: [server/lmsClient.js, tests/lmsClient.test.ts], out: [routes, frontend] }
  verifier: { cmd: "npm test -- lmsClient -t loadAlbum", proven: "" }
  exit: "verifier green + existing lmsClient tests still green"
  escape: { max_iterations: 5, stop_if: [same failure x2, scope.out touched] }
  status: pending

loop 2: album-from-track start position
  invariant: "loadAlbum(...,{startIndex}|{startTrack}) starts the loaded album AT the chosen track, verified by the issued command/seek — never degrades to from-top"
  scope: { in: [server/lmsClient.js, tests/lmsClient.test.ts], out: [routes, frontend] }
  verifier: { cmd: "npm test -- lmsClient -t 'album-from-track'", proven: "" }
  exit: "verifier green + loop1 green"
  escape: { max_iterations: 5, stop_if: [same failure x2] }
  status: pending
  depends: [1]

loop 3: Trusted Spotify replay path
  invariant: "an internal trusted play path plays a bound Spotify target while spotifyTracksAreKnown would reject the same input from a guest"
  scope: { in: [server/app.js, server/lmsClient.js, tests/api.test.ts], out: [frontend, existing guest routes' behavior] }
  verifier: { cmd: "npm test -- api -t 'trusted replay'", proven: "" }
  exit: "verifier green + existing /api/player/* tests green (regression)"
  escape: { max_iterations: 5, stop_if: [same failure x2, existing player test regresses] }
  status: pending

loop 4: PlaySpec construction + validation  [reshaped by Codex album-identity investigation]
  invariant: "buildPlaySpec(input) maps a binder selection+intent into a canonical, zod-validated PlaySpec (album-from-top | album-from-track | track), Spotify-first; rejects impossible combos (album-from-track without an album+index)"
  note: "Album identity is NOT derivable from an arbitrary Spotify track (Codex). Resolution: album-from-track is built by picking the song from an album's ordered track list (spotifyChildren) -> albumUri + startIndex come free. So loop 4 is a pure mapping/validation unit, not search-shaping. Absorbs the PlaySpec-schema piece formerly in loop 5."
  scope: { in: [server/tapPlaySpec.js, tests/tapPlaySpec.test.ts], out: [frontend, search shaping] }
  verifier: { cmd: "npm test -- tapPlaySpec --pool=forks", proven: "" }
  exit: "verifier green"
  escape: { max_iterations: 5, stop_if: [same failure x2] }
  status: pending

loop 5: Tap bindings store + tagId + signed token + PlaySpec schema
  invariant: "createTag returns opaque tagId + valid HMAC token; get/update work; PlaySpec validated (zod); persisted atomically like playlists.js; tokens verify and reject tampering"
  scope: { in: [server/tapStore.js, server/tapToken.js, tests/tapStore.test.ts], out: [routes, frontend] }
  verifier: { cmd: "npm test -- tapStore", proven: "" }
  exit: "verifier green"
  escape: { max_iterations: 5, stop_if: [same failure x2] }
  status: pending

loop 6: Admin binding API
  invariant: "POST/GET/PUT /api/tap admin-gated; POST returns tap URL with #<token>; PUT re-points + refreshes display; non-admin 401/403"
  scope: { in: [server/app.js, tests/api.test.ts], out: [frontend] }
  verifier: { cmd: "npm test -- api -t 'Tap admin binding API'", proven: "" }
  exit: "verifier green + regression gate (existing api tests)"
  escape: { max_iterations: 6, stop_if: [same failure x2] }
  status: pending
  depends: [5]

loop 7: Public resolver API
  invariant: "POST /api/tap/:id/play verifies token (fragment-delivered), plays each PlaySpec kind via trusted path, rejects invalid token, returns clean payloads for unknown/disabled/offline, debounce + rate-limit do not restart same playing target"
  scope: { in: [server/app.js, tests/api.test.ts], out: [frontend] }
  verifier: { cmd: "npm test -- api -t 'Tap resolver golden cases'", proven: "" }
  exit: "verifier green + regression gate"
  escape: { max_iterations: 6, stop_if: [same failure x2, /api/player/* regresses] }
  status: pending
  depends: [1,2,3,5,6]

loop 8: NFC adapter + CI mock  [Codex catch #2: token in fragment]
  invariant: "src/tap/nfc.ts writes the tap URL (#token) via globalThis.NDEFReader; MockNDEFReader stores last URL; a test 'taps' by driving the public route from that URL — no hardware, no fake scan()"
  scope: { in: [src/tap/nfc.ts, tests/tapNfc.test.tsx], out: [server] }
  verifier: { cmd: "npm test -- tapNfc -t 'NFC writer mock'", proven: "" }
  exit: "verifier green"
  escape: { max_iterations: 5, stop_if: [same failure x2] }
  status: pending
  depends: [6]

loop 9: Tap frontend foundation + public tapper view  [ui-craft]
  scope_decision: "Tap is its own Vite entry (tap.html -> src/tap/main.tsx), NOT bolted into the heavy main SPA — keeps the tapper page fast + the section independently expandable. A small path router handles /tap/t/:id + /tap/link. Express serves /tap/* -> tap.html. Design EXTENDS the existing dark/rose system (src/styles.css tokens), not a new look."
  invariant: "foundation (entry + router + tap design layer + api client) renders; /tap/t/:id reads #k= fragment, POSTs play on load, and renders a polished now-playing card with ALL states (loading/played/debounced/unbound/disabled/offline/lms_error); destruct battery exit 0 across viewports + hostile content"
  scope: { in: [tap.html, src/tap/*, vite.config.ts, server/index.js or app.js (serve /tap/*), tests/tapNow.test.tsx], out: [main src/App.tsx] }
  verifier: { cmd: "npm test -- tapNow --pool=forks  +  node <ui-craft>/scripts/destruct_check.mjs <tap-now built page>", proven: "" }
  exit: "RTL states green + battery exit 0 + telltale audit clean"
  escape: { max_iterations: 8, stop_if: [same failure x2] }
  status: pending
  depends: [7,8]

loop 10: Admin Tap console /tap/link  [ui-craft]
  invariant: "admin console SHELL (expandable nav: Tags | Write | [future: Analytics/Stations]) — admin login; library/Spotify search; album-from-top | album-from-track (pick song from album track list) | track; create binding; Web NFC write (mock-tested); tag manager grid with covers/counts/disable/re-point-without-rewrite; destruct battery exit 0 across viewports + hostile content + empty/loading/error states"
  scope: { in: [src/tap/*, tests/tapConsole.test.tsx], out: [main src/App.tsx, server] }
  verifier: { cmd: "npm test -- tapConsole --pool=forks  +  destruct_check.mjs on /tap/link states", proven: "" }
  exit: "RTL green + battery exit 0 on every state (empty/loading/error/list) + keyboard pass + telltale audit clean"
  escape: { max_iterations: 8, stop_if: [same failure x2] }
  status: pending
  depends: [6,8,9]

loop 11: Full lifecycle synthesis  (mandatory final)
  invariant: "the Grand Goal Contract holds end-to-end as a user experiences it; no regression"
  scope: { in: [whole feature], out: [] }
  verifier: { cmd: "npm test && npm run build && npm run test:ui -g tap", proven: "" }
  exit: "all GG criteria green + Codex adversarial fresh-context review"
  escape: { max_iterations: 4, stop_if: [integration fails after 2 fixes] }
  status: pending
  depends: [1,2,3,4,5,6,7,8,9,10]
```

---

## PROGRESS — append-only evidence

### Baseline (recording)
- Branch `squeezebox-tap` @ `57259df` (+plan edits, uncommitted). `node_modules` present.
- Test cmd: `npm test` (vitest run). Build: `npm run build` (vite). E2E: `npm run test:ui` (playwright).
- `spotifyTracksAreKnown` is relaxed when `NODE_ENV=test` (helps trusted-replay testing).
- **Baseline pass/fail (2026-06-12, exit 0):** `npm test` → **338 passed, 2 failed** (340 total, 12 files). The 2 failures are PRE-EXISTING (not ours), both in `tests/lmsClient.test.ts`:
  - `> inserts Spotify URI tracks as the next LMS item` (line 673) — `Track could not be resolved in LMS`
  - `> loads Spotify tracks through LMS playlist commands for Spotty` (line 686) — same
  These are the known-flaky pair noted in project history. **Any NEW failure beyond these two = a regression we caused.** (Harmless jsdom `HTMLMediaElement.pause()` warnings are not failures.)

### Loop statuses
- **Loop 1 (album-load primitive): DONE** (2026-06-12). Verifier `npx vitest run tests/lmsClient.test.ts -t loadAlbum` seen RED (`client.loadAlbum is not a function`) then GREEN (4/4). Impl: `lmsClient.loadAlbum(playerId, {source, albumId|albumUri, startIndex})` — local→`playlistcontrol cmd:load album_id:`, Spotify→`playlist play spotify://album:`. Regression: full lmsClient suite = 64 passed, only the 2 pre-existing failures remain.
- **Loop 2 (album-from-track start position): DONE** (2026-06-12). **Codex review → DIVERGED, fix adopted:** local album-from-track now uses native atomic `playlistcontrol cmd:load album_id:42 play_index:3` (LMS docs) instead of a follow-up `playlist index` (which can race the playlist build). Verifier updated to assert the combined command, re-proven green (64 passed, only the 2 pre-existing fails). Spotify still uses `playlist play <album>` + `playlist index N` (no documented single-command offset; minor track-0 flicker risk → HUMAN-GATE on real LMS).
- **Loop 3 (trusted play engine): DONE** (2026-06-12). `server/tapPlayback.js` `playTapTarget(lms, playerId, playSpec)` dispatches album-from-top / album-from-track → `lms.loadAlbum`, track → `lms.playTrack(...,"play-now")`; throws on unknown kind / no player. Verifier `tests/tapPlayback.test.ts` red (missing module) → green 6/6. **Scope note:** the gate is in route handlers, not `playTrack`, so the engine is trusted *by construction* (never calls `spotifyTracksAreKnown`); proven here at unit level incl. playing an UNKNOWN Spotify track. The route-level guest-rejects-vs-tap-plays *contrast* (full GG3) is covered in loop 7's golden cases.
- **Loop 4 (PlaySpec construction + validation): DONE** (2026-06-12). `server/tapPlaySpec.js` `buildPlaySpec(input)` + `validatePlaySpec(spec)` (zod). Builds/validates album-from-top, album-from-track (requires explicit albumUri/albumId + startIndex — never silently degrades), track; rejects impossible combos + malformed Spotify album URIs. Verifier red (missing module) → green 11/11. **Codex investigation reshaped this loop:** album identity isn't derivable from an arbitrary Spotify track, so album-from-track is built from an album's ordered track list (binder concern, loop 10).
- **Loop 5 (tap store + tagId + signed token): DONE** (2026-06-12). `server/tapToken.js` (HMAC-SHA256 over tagId, base64url, timing-safe verify, id-derived so re-point keeps the token) + `server/tapStore.js` (`createTapStore({file})` factory: create/get/list/update/remove/recordTap/tokenFor/verify; validates PlaySpec on create+update; atomic tmp+rename persist like playlists.js; opaque 11-char base64url ids). Verifier red → green 9/9 (incl. token tamper-reject, re-point keeps id+token, unique ids, cross-instance persistence).
- **Loop 6 (admin binding API): DONE** (2026-06-12). `createApp` now accepts `tapStore` (defaults to `defaultTapStore`). Routes (all `requireAdmin`): `POST /api/tap` (buildPlaySpec→create, returns tag + token + tapUrl with `#k=` fragment), `GET /api/tap` (list+tokens), `GET /api/tap/:id`, `PUT /api/tap/:id` (re-point/disable, keeps id), `DELETE /api/tap/:id`. Verifier `tests/api.test.ts -t "Tap admin binding API"` red→green 7/7 (401 without auth, fragment token, 400 invalid spec, album-from-track index, re-point, disable, delete, 404).
- **Regression gate (full suite, threads pool): 375 passed, 2 failed** — the 2 are the same pre-existing lmsClient Spotify-URI failures; **+37 Tap tests, zero regressions.** (Note: forks pool shows ~4-6 load-flaky/order-dependent api failures that pass in isolation and fail on clean code too — environmental, not ours. Use `npm test` / threads for the clean full-suite number.)
- **Loop 7 (public resolver route): DONE** (2026-06-12). `POST /api/tap/:id/play` (public, open jukebox): token verify (body `token` or `x-tap-token` header — page reads the `#k=` fragment and POSTs it); clean payloads `unbound`(404)/`bad-token`(401)/`disabled`(409)/`speaker_offline`(503, from hotPlayerId throw)/`lms_error`(502); optional `TAP_PASSWORD` gate (off by default); per-tag debounce (`TAP_DEBOUNCE_MS`=3000) returns `debounced:true` without restart; plays via `playTapTarget`; records tap. Verifier `tests/api.test.ts -t "Tap resolver golden cases"` red→green 7/7 incl. the **guest-rejected-vs-tap-plays trust contrast** (GG3). Fixed 2 order/load-flaky test issues (forced publicRequests open in contrast test; `persist:false` store option for the unique-ids test).
- **Regression gate (full suite, `npx vitest run --pool=forks --no-file-parallelism --test-timeout=20000`): 382 passed, 2 failed** — only the 2 pre-existing lmsClient failures. **+44 Tap tests, zero regressions. Backend complete (loops 1–7).**
- **Loop 8 (NFC adapter + CI mock): DONE** (2026-06-12). `src/tap/nfc.ts` — `isNfcWriteSupported()` + `writeTapTag(url)` via `globalThis.NDEFReader` (write-only; reading is the OS opening the URL). Clean failures (no-url/unsupported/write error) instead of throwing. Verifier `tests/tapNfc.test.ts` green 6/6: stubs `NDEFReader`, asserts the `url` NDEF record, confirms the written URL is exactly what a phone opens (token in `#fragment`, empty query), handles cancel/unsupported.
- **Loop 9 (Tap frontend foundation + public tapper view): DONE** (2026-06-12). Architecture: Tap is its OWN Vite entry (`tap.html` → `src/tap/main.tsx`; build emits tap.js 8KB + tap.css 8.5KB, independent of the 105KB main app). `src/tap/tap.css` design layer extends the app's dark/rose system (fluid clamp type, `min()` shells, `aspect-ratio` art, 44px targets). `src/tap/api.ts` client. `src/tap/TapNow.tsx` public tapper — fires play on load (token from `#k=` fragment), renders loading/playing/debounced + clean unbound/bad-token/disabled/speaker_offline/network states with cover fallback. `src/tap/TapConsole.tsx` = expandable shell stub (nav: Tags | Write | Analytics·soon | Stations·soon) for loop 10. Server serves `/tap/*` → tap.html (prod). **Verifiers: RTL `tests/tapNow.test.tsx` 7/7; ui-craft destruct battery exit 0 across all 8 viewports for playing/loading/debounced/unbound/offline + hostile long-content + console shell; telltale audit clean (rose accent not purple, radius 16px, Inter matches parent app); screenshots reviewed — designed, not slop.** Regression: 395 passed / 2 pre-existing fail.
- Loops 10–11 `pending`. Next: loop 10 (full Tap console — search→bind→Web NFC write + tag manager), loop 11 (synthesis + Codex adversarial review). **Foundation + tapper page live (loops 1–9).**

### Learnings
- lmsClient: `playTrack` (server/lmsClient.js:217) — local→`playlistcontrol cmd:load track_id:`; Spotify→`playlist play <uri>`. No album-load yet. Spotify album likely loads via `playlist play spotify:album:<id>`.
- Gate `spotifyTracksAreKnown` @ app.js:2136; `requireAdmin` @ app.js:2344.
- Persistence pattern: server/playlists.js — atomic tmp+rename JSON write to `config.musicSourceDir/cloud-squeeze/*.json`, env override. Mirror for `tapTags.json`.
- Token delivery: **URL fragment `#k=<hmac>`** (not query) — avoids history/log leak (Codex catch).
- Frontend is one `src/App.tsx`, no router yet; prod serves `dist` with catch-all → index.html. Tap views need a routing decision (lightweight separate entry vs client route) — settle in loop 9.
- **TEST RUNNER:** the default `threads` pool intermittently hangs on Windows (`Failed to start threads worker / Timeout waiting for worker`). Use `npx vitest run <file> --pool=forks` for reliable single-file verification (slower startup ~20s but stable). For the FULL suite on a loaded machine, parallel files cause timing-flaky failures in `App.test.tsx`/`api.test.ts` (timeouts, not logic) — run **`npx vitest run --pool=forks --no-file-parallelism --test-timeout=20000`** for a stable result (~83s, gives 382 pass / 2 pre-existing fail).
