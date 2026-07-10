# mature-ui ledger — cloud-squeeze (Squeezebox Cloud)

Mode: **Full redesign** (whole-app "make it production-grade" ask). The composition shell
(sidebar nav + content + right rail; list-detail for playlists) is already the mature
archetype for this app, so the redesign recedes chrome and re-composes the primary screen
rather than replacing the shell — structural deltas are listed below.

Archetype: **hybrid Search/retrieval + Queue/ops** — a control surface, not a landing page.
Primary jobs: (1) run playback (now-playing + queue), (2) search/browse the library and
queue songs, (3) admin the speaker connection. Density target: high.

## Strengths preserved (law 2)
1. Global sidebar search + Ctrl+K — known-item lookup jump from any screen.
2. Row overflow menu (RowMenu) — keeps play-next / add-to-queue / add-to-playlist / archive
   reachable without a wall of per-row buttons.
3. Squeezebox / This-device playback-mode toggle — one control routes a request to the
   speaker vs the local browser; core to the multi-user jukebox job.
4. Live speaker status card + connecting pulse — at-a-glance "will my request reach the
   speaker?".
5. Empty states that name the next action (e.g. "Queue is empty — requests appear here…").

## Directions considered (mandatory)
- **A — Operator console (CHOSEN).** Recede all chrome: neutral section labels (kill rose
  headings), compact circular transport cluster, borderless dense lists with hover-reveal
  actions, tighter radii, accent = signal only. Fixes container sprawl, repeated controls,
  metadata noise, accent-as-wallpaper, oversized transport. Risk: could read too plain —
  mitigated by keeping album-art, live-dot, and one rose accent.
- B — Split reader retrieval (two-pane list/detail replacing placeholder rail). Rejected as
  primary: now-playing already IS the detail; two readers compete + larger rewrite. Borrowed
  one idea: collapse the placeholder rail when there's no real track info.
- C — Player-first bottom bar (Spotify-style persistent transport). Rejected: erases the rich
  album-art / lyrics now-playing workflow (law 2 violation) for cosmetic radicalism.

## Structural deltas a thumbnail shows
- Now-playing: 4 full-width stretched button rows → compact left-aligned circular transport
  cluster (chrome weight ↓, kills dead bands).
- Lists: bordered rounded card-rows (collections) → borderless dense rows w/ hairline
  separators + hover shading.
- Headers: rose uppercase on every panel → neutral muted labels; rose reserved for active
  nav / primary action / live status.
- Right rail: two always-on placeholder panels → collapses to one slim hint when no track.

## Baseline audit (BEFORE) — see AUDIT.md for AFTER side-by-side
Failing metrics found: container styles (>3), list density (results truncated to 3;
collections as padded cards), repeated controls (per-row Play+menu always visible),
metadata noise ("Local library" on every collection row), type sizes (Admin title ~38px),
radius (>8px on chrome/rows, >2 values), names-per-concept (Library/VPS library/Local
library/Local), dead bands (stretched transport).
Accent hue: rose #ff5f83 — kept, established Harmonizer brand (one-line override).
