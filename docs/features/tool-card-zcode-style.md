# ZCode-style tool cards

Shipped 2026-09-26 (PR #6). Frontend-only — the `tool-call` `Message` already
carried `rawInput` / `rawOutput` (see `tool-call-output.md`); this feature only
changes how they are presented.

## Behavior

A tool-call card in the transcript (and in subagent streams) renders in the
ZCode style, in two places:

- **Header line** (single `h-8` row): a static per-tool **icon** (lucide,
  per-tool map in `toolOutput.ts`; `WrenchIcon` fallback) + a **past-tense
  verb** (`Ran` / `Read` / `Wrote` / `Edited` / `Searched` / …; present tense
  with the `animated-gradient-text` shimmer while `pending`) + the **primary
  text** (a file chip — language icon + basename — for read/write/edit, the
  command in `font-sans` for shell tools, the `summarizeToolCall` summary
  otherwise) + a `+N -M` **change stat** (edit only, summed over `edits[]`,
  green/red, each number flip-animating on change via `FlipMetricValue`) + a
  red `Failed` word with a dotted-underline **tooltip** (the failure reason —
  `details.error`, else the first non-empty text item, else a bare string — plus
  a copy button) when the call failed + a hover chevron.
- **Expanded body**: a `rounded-xl border bg-panel` panel — a `$` prompt + the
  command in mono for shell tools, the file chip (+ `L5–54` line range for a
  `read` with `offset`/`limit`, + the change stat) for file tools — then the
  normalized `rawOutput` (the `normalizeToolOutput` rules from
  `tool-call-output.md`: 20k cap + truncation note, deferred until expanded) or
  a muted `No output.` A `content`-derived diff keeps priority when present.

**Changes grouping** — a maximal run of ≥2 **consecutive** `write`/`edit`
tool-call messages folds into one `Changes` card: `N files` + a responsive
file-chip list with `+N` overflow (chips measured against the row's right
boundary minus the actual trailing-content width via a `ResizeObserver`;
hidden chips stay mounted, CSS-hidden) + total change stats + a red `XCircle`
failure cue when any member failed; while any member is pending, the chip list
is replaced by the latest member's chip. Expanded: the per-file cards indented
under a left border.

**Auto behaviors**:

- **Nothing opens itself.** Every tool card starts collapsed, whatever its tool
  or status, and the `Changes` group is a `N files` row until clicked. (A single
  `write`/`edit` card used to auto-open ONCE on the `pending → finished` edge —
  ZCode's one-shot `autoOpen` — and the group mirrored it, starting open when
  any member was already finished. A turn touching several files therefore
  dumped several diffs into the transcript unasked and pushed everything below
  them down. The header row already carries the same facts at a glance — verb +
  path + `+N -M` — and the body is one click away, so the removal takes away
  the surprise and not the information. `ToolCallCard` and `ChangesGroupCard`
  now hold `open` as plain `useState(false)` mutated only by the header toggle,
  which is why no one-shot `hasAutoOpenedRef` guard is needed any more: there
  is no auto-open to outrun a manual click.)
- A `SubagentSection` starts **open while running**, auto-collapses once on the
  `running → terminal` edge, starts collapsed when already finished, and
  re-opens on header click/Enter/Space (the header is `role="button"` +
  `tabIndex={0}` + `aria-expanded`; the `onKeyDown` handler is guarded with
  `event.target === event.currentTarget` so the nested dismiss `X` button
  activates natively and keyboard users can dismiss).

## Design decisions

- **The verb is the status signal** (ZCode's deliberate choice): no spinner
  while running, no check icon when done — the present/past tense + the red
  `Failed` word carry the state. `failed` takes the past tense too.
- **Grouping is a pure render concern**: `groupConsecutiveFileWrites`
  (`src/lib/toolGroups.ts`) folds the message array per render into `single` /
  `changes-group` units at both render sites (`ChatStream`, `SubagentPanel`).
  The store is untouched, so live streaming (a write joins the run mid-turn)
  and reloads are consistent. Only `write`/`edit` group — `ask` anchoring in
  `ChatStream` is unaffected (an `ask` tool call can never be in a group).
- **Change stats are `edit`-only** (ZCode's `getChangeStat` semantics): a naive
  line count of `newText` / `oldText` summed over the `edits[]` — no diff
  parsing, no stats for write/bash.
- **File chips are non-clickable in v1** (the desktop has no code-viewer action
  wired to the side pane yet); the chip's `title` attribute carries the full
  path. Language coloring follows ZCode's `FileDisplayIcon` extension map
  (`src/lib/fileIcons.ts`: ts/tsx → brand, js/jsx → warning, html → destructive,
  images → subtle, …, neutral default).
- **The shimmer reuses the existing `animated-gradient-text` class** from
  `index.css` (already used by `Reasoning`), so no new CSS was needed for it;
  only the `flip-in` keyframes (with a `prefers-reduced-motion` guard) were
  added.

## Out of scope (follow-ups)

Clickable file chips → side-pane code viewer, real diff previews (the `+N -M`
stat is a line count, not a parsed diff), collapse animations,
`QueuedSummaryContent` rolling of live summaries.
