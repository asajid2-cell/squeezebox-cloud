# Cloud-squeeze flagship punch-list — execute EXACTLY, [STRUCTURAL] items first

A harsh cross-model judge scored the current UI 4/10 vs the Linear/Stripe/Spotify 1% benchmark.
Two prior full rebuilds only fixed empty states and skipped every invasive structural item. Your
job is NOT to "mature the UI" (that framing keeps producing the safe subset) — it is to execute
this exact list. Do EVERY [STRUCTURAL] item before ANY [polish] item. The design language is
LOCKED: near-black world (#000 / #0b0c11), single rose accent, Inter, cloud wordmark. Do not
change colors/fonts/identity. Full spec + judge evidence: matureui-artifacts/LUNA_VERDICT_AND_FLAGSHIP_SPEC.md
and matureui-artifacts/CLAUDE_REJUDGE_4of10.md (read both first).

## [STRUCTURAL] — mandatory, do these FIRST, none may be silently skipped
1. Remove the `Play` button stamped on every list row (Library AND Queue). The row itself is the
   primary action: whole row clickable → play/open. Secondary actions (the kebab) reveal on
   hover/focus; on touch stay visible. This is the #1 offender across all runs.
2. Kill the dead header band + floating lone `Admin` button on every non-admin screen. Replace
   with a real 56px content toolbar per screen: page title (proper size, NOT the tiny rose
   eyebrow), context (counts/search/sort where the screen needs it), and actions right-aligned.
   Admin lives in that toolbar or the nav, never floating in a void.
3. Build a real type hierarchy. Right now NOW PLAYING / TRACK INFORMATION / LIBRARY / ARCHIVE /
   PLAYLISTS are all identical rose uppercase eyebrows. Page titles must be a distinct larger
   tier (20-24px, not uppercase-rose); rose eyebrows become subordinate section labels used
   sparingly — rose must carry semantic weight, not decorate every heading.
4. Differentiate surfaces. Every card is currently the same dark fill + 1px border + 16px radius.
   Establish real layering: primary work surface vs secondary rail vs elevated element should
   read differently via background value, border presence, and elevation — not one template.
5. Kill the enclosing "second giant card": Up Next (Queue/Now Playing) and the Library list must
   NOT be wrapped in a big bordered card floating in space. The list IS the page region.
6. Library: add a real catalog toolbar (heading, item count, in-list search, sort) and a sticky
   column/section header; 56px rows; row-as-action (see #1). "View all 60 results" dumped at the
   bottom becomes proper pagination/count in the toolbar.
7. Queue: header row with `Queue · N songs · ~M min` + `Add from library` + `Clear`; 64px rows
   with a drag handle for reorder; kebab groups reorder actions with a divider before the
   destructive "Remove from queue" (colored destructive).
8. Replace the dotted-square + music-note placeholder art tile (a banned pattern) with a real
   matte album-art fallback treatment (rose signal mark on a proper surface).
9. Fix sparse-not-empty voids: a Playlists/Library page with 1 item must not leave ~550px of
   empty card below. The list region flex-fills; short content sits in a composed layout, not a
   void. (The zero-item empty states are already good — keep them.)

## [polish] — only after every [STRUCTURAL] item above is done or killed-in-writing
- Unify the Now Playing control-row button language (ghost pills vs segmented group).
- Narrow: 56px header, 80-96px player dock with expand; not stacked desktop.
- Any remaining micro-copy/alignment nits.

## Process (from the mature-ui skill — follow it)
- Read the mature-ui skill (C:\...\.claude\skills\mature-ui\SKILL.md) and follow its adversarial
  partner loop: after each screen, capture to the CANONICAL matureui-artifacts/current/ dir
  (regenerate in place; never a new folder), delegate a harsh review via the tandem bridge to a
  cross-model judge (gpt reset — TANDEM_PARTNER=codex TANDEM_MODEL=gpt-5.6-luna TANDEM_EFFORT=xhigh;
  if codex is quota-locked, TANDEM_PARTNER=claude), scoring against THIS punch-list. A screen may
  not pass while any [STRUCTURAL] item for it is unaddressed. Report each item done/partial/ignored
  every round.
- Verify: npm run build clean; npx vitest run --pool=forks --maxWorkers=1 green.
- Server: kill stale listeners on 4177/5177; bash `set -a; source .env; set +a; npm run dev`.
- Commit to branch matureui-live-test-v3. Report: punch-list status (every item), per-round harsh
  scores, final judge verdict, remaining nits.
