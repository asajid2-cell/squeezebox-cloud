# Jobs map, quarry record, and judge verdicts

## Job list → where each job lives in the rebuild

| Job | Before | After | Δ |
|---|---|---|---|
| J1 Control playback (transport/seek/volume/shuffle/repeat/source) | Only on the Now Playing screen; navigate away and you cannot pause | **Persistent player bar** on every screen (both Squeezebox and this-device modes); shuffle/repeat/source chips on the Now Playing detail | Faster everywhere |
| J2 Manage queue (reorder/edit/remove/play-now) | Queue panel (2nd column on Now Playing + Queue screen) | Up Next beside Now Playing detail + full-width Queue screen; per-row Play + always-visible overflow menu | Same or faster |
| J3 Find & add music (5 sources, per-row actions) | Search panel with 3 visible rows + "view all" | Full-width Library page, 25-row fold, pill source tabs, per-row Play + kebab (play-next / queue / save / archive / curation) | Faster (density) |
| J4 Manage playlists | Playlists panel | Full-width Playlists page (My/Local/Spotify), portaled dialogs for create/rename/delete | Same |
| J5 Archive | Archive panel | Archive page, grouped lists, scan/refresh, progress badges | Same |
| J6 Track context (bio/review/lyrics) | Right rail on EVERY screen (irrelevant on Library/Playlists) | Context inspector on Now Playing only | Same speed, correctly scoped |
| J7 Switch playback target | Sidebar toggle | Sidebar toggle (unchanged); player bar is mode-aware | Same |
| J8 Admin / connect | Admin route | Admin route, same pipeline, tightened composition | Same |

## Quarried back from the original (restyled)
- The queue-row inline edit workflow (title/artist, local rows only) and its guard rails.
- The add-to-playlist popover flow (create-and-add included) — now an inline submenu inside the row menu.
- The admin connection pipeline (IP cards, numbered steps, port cards, status pills).
- The archive watch/scan notes, grouped lists, and progress badges.
- The Ctrl/Cmd+K search affordance, recent-picks sidebar module, Spotify suggestion chips.
- The `aria-` labelling scheme and all API/behavioural contracts (all 483 unit tests + contract).

## Held-out judge — Round 1 (binding)
- (a) Identity: **PASS** — "unmistakably the same product… Nothing on the banned list appears."
- (b) Build quality: **PASS with reservations** — "genuine recomposition, not a restyle… clears 'dramatically better built' on desktop"; narrow viewport flagged.
- (c) Sloppiest: bar slicing rows in full-page capture (sticky-capture artifact + scroll-under-dock); ragged narrow queue rows (headerless guest/eta debris); empty-tab void + hero how-to paragraph.
- (d) Job losses: mobile speaker volume LOST (bar hid it on phones); row action kebab invisible in non-hover captures; queue management affordances invisible for same reason.

### Round 1 fixes shipped (commit 6935a57)
1. Volume row restored in the player bar at all widths (it is remote speaker volume).
2. Row overflow menus always visible at 60% resting opacity (full on hover/focus).
3. Mobile queue rows drop the headerless requested-by/ETA lines.
4. Empty-hero copy cut to one actionable line; Spotify-not-linked empty state names the tabs that work meanwhile.

## Held-out judge — Round 2
- (a) Identity: **PASS**. (b) Build quality: **PASS** on desktop; narrow viewport reservations.
- Remaining findings addressed by Codex commit ee9d1c8: queue-specific kebab actions,
  mobile requested-by/ETA meta, viewport-filling short pages (Queue + Library got `stage--fill`).

## Held-out judge — Round 3 (final, this session)
Ran on a FRESH recapture of the after/ set (prior set predated ee9d1c8).
- (a) Identity: **PASS** — "unmistakably the same product… no new hue, glass, gradient, serif."
- (b) Build quality: **PASS** — "a re-architecture, not a reskin… dramatically better built."
- (c) Sloppiest: (1) desktop dock seek reads as a centered ~490px stub vs full-width mobile
  seek — flagged REAL by judge; (2) NIT: Now-Playing shuffle/repeat row unbalanced, source
  segment orphaned to the right; (3) NIT: dock shows bare "LMS" text vs the panel's bordered
  chip, and the empty state is phrased two ways ("No track playing" vs "Nothing playing").
- (d) No job lost/slower. Only J7 (playback-target toggle) is demoted from top-of-sidebar to
  bottom — "demoted, not buried" (still on-screen without scrolling; near top on mobile).

### Round-3 fixes shipped (commit 5e4997e, before this verdict)
1. `stage--fill` applied to Archive + Playlists (the round-1 void, still present on those two
   pages because ee9d1c8 only filled Queue + Library). Both now fill the viewport.
2. `.row-menu__pop button.danger` given the spec `--danger-text` color; the queue/playlist
   "Remove" item carried an inert `danger` class and rendered neutral white.

### Builder assessment of the round-3 (c)(1) "seek stub"
Judged NOT a defect: the desktop dock uses a 3-column grid (meta · center · volume); the seek
lives in the center column (`.player-bar__seek { width:100%; max-width:640px }`) directly beneath
the transport — the Spotify/YouTube-Music desktop pattern. Mobile collapses to one column, so the
same seek goes full-width; that is correct responsive behavior, not a disagreement. Left as-is
within the locked design language. A human may widen the desktop seek if preferred (taste, not bug).
Items (c)(2), (c)(3), and the J7 demotion are cosmetic nits carried as known risks.

---

## v3 finishing session (this pass) — corrected record + finish pass

### The stale-before discovery (why the "Luna 3/10" verdict was invalid)
The freshest prior artifact (`LUNA_VERDICT_AND_FLAGSHIP_SPEC.md`, commit `7ccd35e`) scored the build
**3/10**, claiming "only ~1.9% of pixels changed… not a substantive redesign." That verdict was run
against the wrong inputs: `matureui-artifacts/before/` is **not** the true pre-rebuild UI — it is the
*already-rebuilt* Board A build with only the old top-packed empty states. Comparing an already-rebuilt
`before/` to an already-rebuilt `after/` naturally yields a ~2% pixel delta, so the "nothing changed"
premise was an artifact of a mislabeled baseline, not the build. Verified two ways: (1) the current
source implements Board A (`.player-bar`, `.sidebar`, `.stage--split`, `.right-rail`); (2) checking out
the genuine pre-rebuild commit (`26ba7e9`, parent of the first mature-ui commit `dfd68b8`) and capturing
it (`matureui-artifacts/before-true/`) shows the real original: **four oversized boxy transport buttons
trapped on Now Playing (no player bar anywhere), a "CS." text monogram in the album-art slot (a BANNED
pattern), and the irrelevant Track-Info + Album/Lyrics rails stacked below the Library screen.** The
rebuild demolished all three. `before-true/` is the correct baseline for the judge; `before/` is retained
only as a historical mid-rebuild snapshot.

### Changes shipped this session (finish pass on real remaining gaps)
1. **Empty states → composed centered intent panels.** Queue, Library, Archive, and Now Playing's
   UP NEXT were top-packed text bands that left large dead voids inside the full-height `stage--fill`
   panels. Rebuilt as centered panels — rose mark tile + heading + one guidance line + a real next
   action (`Browse library` / `Browse VPS library`, wired through a new window-event `navigateTo()` so a
   deep child can steer the top-level screen without prop-threading). Removed the legacy dashed "alert
   box" so the state reads as designed calm, not a bordered void. (commit `1c52db8`)
2. **Player-bar seek always shows its time codes** (`0:00` / `--:--`, muted when idle) on desktop and
   narrow — restores the scrubber legibility the pre-rebuild UI had and resolves the held-out judge's
   only real content regression. (commit `d34a113`)
3. **Narrow Admin action** now pairs with the wordmark as a top bar (the sidebar stacks above the main
   header on narrow, so the desktop top-right Admin link was floating orphaned); desktop keeps the
   top-right placement. (commit `d34a113`)
4. **Playlists page header** — added the rose `PLAYLISTS` eyebrow that every other list page carries;
   it was missing on the default "My Playlists" tab, breaking header consistency.
5. **Now Playing control-row unification** — Shuffle/Repeat toggles now wear the pill shape (matching the
   Mixed/Spotify/Local segment and the spec's "pills = toggles" rule), so the whole control row shares one
   shape language. This was the specific lever the judge named to move past 9.

### Held-out judge — v3 (fresh context, vision, binding), true-before vs current
- **Round 1:** (a) Identity **PASS** — same near-black world, single rose accent, Inter, rose eyebrows,
  no banned element (AND the after *removed* the before's "CS." monogram violation). (b) Build quality
  **8/10 PASS** — "a legitimate recomposition, not a restyle": persistent global transport bar, right-rail
  context scoped to Now Playing, flagship empty states. (c) sloppiest: seek lost time labels; fractured/
  mixed-language transport row; oversized empty cards + orphaned narrow Admin pill. (d) No job lost; seek
  labels the one regression; J7 slightly demoted (placement, not loss).
- **Round 2 (after fixes 1-3):** (a) **PASS**. (b) **8→9/10** — "clears ≥8 and reaches ≥9… Shippable."
  Remaining = nits only (defensible transport split; a narrow source-segment cosmetic). "PASS / PASS."

### Verification
- Full unit suite: **483 passed / 20 files** (`vitest run --pool=forks --maxWorkers=1`; the default thread
  pool fails to spawn workers under load in this environment — a harness issue, not a code failure).
- All screens recaptured live from the running app into `matureui-artifacts/current/` (the honest "after").

### Remaining risks / known nits (carried)
- Transport is split by design (global bar owns play/seek/volume; Now Playing card owns shuffle/repeat/
  source) — the judge accepted this as the Spotify pattern; a future pass could consolidate.
- J7 (Squeezebox / This device toggle) sits below nav rather than at the very top of the sidebar —
  on-screen without scrolling, near the top on mobile; demoted, not buried.
- Sparse-but-nonempty list pages (e.g. Playlists with one item) top-align rows inside a full-height panel
  — standard list behavior, but the enclosing border makes the empty tail slightly prominent.
