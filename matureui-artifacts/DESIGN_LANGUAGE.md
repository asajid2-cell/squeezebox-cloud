# DESIGN_LANGUAGE.md — Squeezebox Cloud (locked identity)

The identity is a **fixed input**. It is the "Tap" design system (`src/tap/tap.css`), already
adopted by the main app. This rebuild keeps it instantly recognizable; only the *implementation*
(layout, composition, component construction, states) changes. Values below may be refined
(contrast, formalized ramps) but the accent hue, the near-black world, and the type voice are locked.

## Personality (three adjectives)
**Nocturnal · precise · quietly premium.** A late-night listening room, not a neon club. The
product is a jukebox control surface — dark, calm, one warm signal cutting through.

## Color world
Dark-only (`color-scheme: dark`). Near-black surfaces, one rose accent, one green "live" signal.

| Role | Token | Value | Use |
|---|---|---|---|
| App background | `--bg` | `#000000` | the void behind everything |
| Raised surface | `--bg-soft` | `#050507` | recessed fields, sunken wells |
| Panel | `--panel` | `#0b0c11` | cards / panels |
| Panel raised | `--panel-2` | `#11121a` | thumbs, popovers, nested surfaces |
| Hairline | `--line` | `#20212a` | borders on surfaces |
| Hairline soft | `--line-soft` | `#181922` | row dividers, quiet borders |
| Text | `--text` | `#f8f8fb` | primary text |
| Muted | `--muted` | `#a7a8b2` | secondary text |
| Faint | `--faint` | `#767886` | tertiary / meta |

## Accent + semantics
- **Rose `--rose #ff5f83`** (hover `--rose-strong #ff4772`, wash `--rose-soft rgba(255,95,131,.14)`,
  ink-on-rose `#1a0309`). The ONE accent. Meaning: *the live signal, the primary action, the
  current selection.* Used sparingly — a filled rose control is THE action on a surface; the
  active nav item is a rose wash, not a rose block; section eyebrows are rose uppercase.
- **Green `--green #42d884`** — "online / live / playing" status only.
- **Amber `--amber #f4b740`** — "reconnecting / transitional" status only.
- **Danger `--danger #ff6b6b`** / text `--danger-text #ffb4b4` — destructive actions, errors.
- **Spotify green `--spotify #1ed760`** — Spotify-source affordance only (kept from original).

Changing the accent hue, adding a second decorative hue, or introducing gradients/glass = failure.

## Type
- **Inter** (system fallback), the app's existing voice. Two weights carry everything: **500–600**
  body/label, **700** emphasis/headings. No display serif, no monospace eyebrow labels.
- Fluid clamp ramp (locked from tap): `--step-0`…`--step-4`. Section titles ≤ `--step-2` (≈24px).
- **Eyebrow section labels**: rose, uppercase, `.04em` tracking, ~12–13px, weight 700 — the
  signature "NOW PLAYING / UP NEXT / LIBRARY" label. This is identity; keep it (but only where a
  section genuinely needs a label — not stamped on every sub-block).
- Numerics (times, %, counts): `font-variant-numeric: tabular-nums`.

## Shape
- **Two radii only**: `--r-control 12px` (buttons, fields, rows, chips-as-rects), `--r-card 16px`
  (panels, dialogs, art). Pills (`999px`) are a *third, deliberate* shape reserved for
  tabs/toggles/status — one shape per control role, never mixed within a role.
- Hairline borders (`1px var(--line)`) define surfaces; shadows are used sparingly and only for
  genuine elevation (popovers, dialogs, the player bar lift, album-art bloom). No 1px-border +
  giant-blur combos as decoration.

## Spacing
One 4/8 scale (`--s1 4 … --s8 64`). More space between groups, less within. Every margin/pad/gap
lands on the scale.

## Motion
Restrained: 120–160ms ease on color/border/opacity. The green live dot pulses; a buffering art
pulses; reduced-motion disables both. No decorative animation.

## Brand marks
- Wordmark: **cloud glyph (rose) + "Squeezebox Cloud"** (weight 800). Keep.
- Live signal: a small green pulsing dot = "playing / online". Keep.

## What is explicitly BANNED (model default costume)
Display serifs · monospace uppercase eyebrows beyond the existing rose label · amber/gold editorial
styling · glassmorphism / backdrop-filter decoration · gradient veils or gradient text · any new
accent hue · centered marketing-hero composition inside this operational tool.
