# Countable audit — before vs after

Product: Squeezebox Cloud — a public web control surface for a VPS-hosted Squeezebox/LMS
(browse library, queue songs, run playback). Archetype: hybrid Search/retrieval + Queue/ops.
Numbers are for the desktop operational screens (Now Playing, Library, Playlists, Admin) at
1440×900, measured from DOM/computed styles + screenshots.

| Metric | Mature range | BEFORE | AFTER |
|---|---|---|---|
| Container styles / screen | ≤3 | ~6 (panel, now-playing glow, album glow, chip, speaker-card, dashed empty-state, bordered collection card) | 3 (panel, chip, field/inset) |
| Container nesting | ≤2 | 2 | 2 |
| List density (main collection) | ≥12 single-line / ≥6 multi ≤96px | Library **3** (truncated); Collections ~7 padded cards ~85px | Library **10** (+View all); Collections ~13 dense rows ~52px |
| Filled buttons / region | ≤1 region, ≤3 screen | OK (play + CTAs) | OK (play circle; admin CTAs) |
| Repeated per-row buttons | 0 always-visible | **FAIL** — Play + ⋯ on every Library/Queue/playlist row | **PASS** — reveal on hover/focus; visible on coarse pointers |
| Metadata noise | 0 constant fields | **FAIL** — "Local library" on every collection row | **PASS** — removed |
| Dead bands | none >80px w/ 1 control | **FAIL** — 4 full-width stretched transport slabs; 116px admin step cards | **PASS** — compact transport cluster; compact steps |
| Type sizes | ≤3; title 16–24 (≤28) | **FAIL** — Admin title ~38px (--step-3) | **PASS** — title 22px; ≤3 sizes/view |
| Radius values | ≤2; ≤8 chrome/rows | **FAIL** — 10/12/16 + 999; chrome/rows >8 | **PASS** — 8 chrome/rows, 12 cards, 999 pills |
| Pill nav | 0 nav-as-buttons | PASS (tinted rows) | PASS |
| Shell conformance | archetype shell or override | borderline (query strip in sidebar) | override #2 below |
| Names per concept | 1 | **FAIL** — Library / VPS library / Local library / Local | **PASS** — nav "Library" (screen) + "Local" (source), unified |
| Accent hue | not AI purple | rose (brand) but ALSO wallpaper on every h2 | rose reserved as signal; headings neutral (override #1) |

## Overrides (listed verbatim for the judge)
1. **Accent hue = rose #ff5f83.** Not the default AI purple; it is the established Harmonizer
   black-rose brand. After the pass, rose is used only as signal — active nav, primary action,
   selection, focus, live status — not on headings.
2. **Query strip split.** The primary search input stays in the sidebar (a cross-screen
   Ctrl+K known-item jump used from Now Playing / Queue / Playlists, not only Library); the
   per-collection source-tabs sit directly above the results and own scope. Folding search into
   a Library-only strip would delete the global-jump workflow (law 2).
