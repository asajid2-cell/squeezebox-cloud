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
(pending — verdict recorded verbatim below when returned)
