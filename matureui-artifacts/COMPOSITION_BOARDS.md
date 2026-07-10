# Composition studio — Squeezebox Cloud

Product one-liner: a live, WebSocket-synced web control surface for a VPS-hosted Squeezebox/LMS —
guests browse a library and queue songs from their phones; the owner runs playback; an NFC tap
plays an album. Identity is LOCKED (see DESIGN_LANGUAGE.md). Only structure differs across boards.

## Jobs (enumerated from the running app — the contract)
- **J1 Control playback** — play/pause/stop/next/prev, seek, volume, shuffle/repeat/source.
- **J2 Manage the queue** — view "up next", reorder, edit local rows, remove, play-now.
- **J3 Find & add music** — source tabs (Spotify / VPS library / Uploaded / Archived / Playlists),
  search, per-row play / play-next / add-queue / save-to-playlist / archive, browse artist/album/
  playlist detail.
- **J4 Manage playlists** — My / Local / Spotify; create / rename / delete; add / remove / reorder.
- **J5 Archive** — see lossless FLAC copies grouped, scan, download, watch queue progress.
- **J6 Read track context** — artist bio, album review, lyrics for the *current* track.
- **J7 Switch playback target** — Squeezebox vs "this device" (browser) local player.
- **J8 Admin / connect** — connection pipeline, service providers, public request controls.

Current build's core failures: the 3-column content grid **collapses to a single left-hugging
column below 1500px** (so 1366/1440 laptops see giant empty bands), **playback control is trapped
on the Now Playing screen** (navigate away and you cannot pause), transport is **four oversized
boxy buttons**, and the **track-info rail renders on Library/Playlists** where it is meaningless.

---

## Board A — "Console + persistent player bar"  ★ WINNER
Thesis: it's a music player — the transport should live in a persistent bottom **player bar**
(Spotify/Apple-Music signature), freeing every screen to be the list/detail it wants to be and
making J1 reachable from *everywhere* (strictly faster than today).
Structure: full-height left **nav rail** (brand, ⌘K search, sections, recent picks, mode toggle,
speaker status) · a **content stage** that IS the active section (Now Playing = art+meta+options
detail with a context inspector; every list screen fills the width with dense rows) · a
**persistent player bar** docked to the bottom of the content column, aligned to content, always
visible, mode-aware (Squeezebox or this-device). The bar is a real grid row, not an overlay, so it
reserves its own space by construction.
Execution signature: the **always-on player bar** — mini art, title/artist, centered transport,
one seek line, volume, source chip — WebSocket-synced. Owner map: nav owns speaker status; bar owns
transport; Now Playing owns track detail + context. No region duplicates another's signal.
Quarry list: everything — AlbumArt, PlaybackOptions, ArchiveButton, all row/menu/popover workflows,
the admin connection pipeline. All come back restyled; none of the jobs move except J1, which gets
faster.
Risk: the bar must never cover content (solved: grid row, not fixed overlay) and must degrade to a
compact two-line bar on phones.

## Board B — "Split library / two-pane browser"
Thesis: for a jukebox the dominant act is *browse + queue*, so make a master list the whole page
and dock a slim now-playing + queue inspector on the right that persists across sections.
Structure: nav rail · center master pane (search results / playlist tracks / queue as dense rows) ·
right inspector pane (compact now-playing card at top with transport, queue peek below, track info
under that). No bottom bar.
Execution signature: the right **inspector** that stays put while you browse — control without
leaving the list.
Quarry list: same components; now-playing shrinks to a card.
Risk: on a 1366 laptop, master + inspector + nav is three columns — the inspector starves or the
list does; on phones the inspector must drop below the list, burying transport. Transport ends up
*less* reachable than Board A. Rejected for J1 reachability + narrow-width fragility.

## Board C — "Stage + context rail (rebuilt original)"
Thesis: keep the shape closest to today — a main stage plus a right rail — but make the rail
context-aware and hold a real 2-column at all widths instead of collapsing.
Structure: nav rail · main stage (now-playing hero / active screen) · right rail that shows
now-playing transport + queue peek on the Now Playing screen and *hides* elsewhere.
Execution signature: a rail that earns its space only when relevant.
Quarry list: same.
Risk: transport still lives only on the Now Playing surface (rail hides elsewhere) → J1 not
reachable while browsing, the original's worst trait survives. Also thumbnail composition is
closest to the original (nav + stage + right rail) — disqualified by the "must differ from the
original's thumbnail" rule.

---

## Decision: **Board A**, with the context inspector idea from Board C grafted onto the Now
Playing screen only (track info shows *there*, hidden on list screens).

Why A wins: (1) it's the only board that makes **J1 reachable from every screen** — a strict job
improvement, never a regression; (2) the persistent bar is the genuine flagship execution move for
a player and reads unmistakably as "a music app a real team built"; (3) a bar-as-grid-row uses the
full content width at every viewport, killing the original's collapse-to-empty-bands failure;
(4) it lets each list screen become a dense full-width page (J2/J3/J4/J5 get more room, not less);
(5) it cleanly assigns one owner per signal (nav=speaker, bar=transport, NowPlaying=track detail),
resolving the duplicate/irrelevant-rail defects. Identity is byte-identical to boards B and C —
only the skeleton differs.
