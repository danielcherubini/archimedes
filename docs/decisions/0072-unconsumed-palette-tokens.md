---
status: accepted
date: 2026-10-22
superseded-by:
---

# The unconsumed palette tokens stay, and the count that describes them is method-dependent

`src/styles/theme.css`'s `@theme` block declares **174 `--color-*` tokens**. A static
scan of `src/` finds **88** of them with no consumer — spread across **22 families**
(terminal, usage, git, context-breakdown, the `*-node` role chips, tab, workflow, and a
tail of singletons). They cost payroll in three files at once: each is restated in
`theme.css`, re-derived in `dracula.css`, and enumerated in the completeness gate
`paletteCompleteness.test.ts`. Task A6 (the dead-code deletion) reached them and
**deleted none of them**. This ADR records why, classifies each family, and — the part
that actually matters for anyone who re-counts them later — states why **the number
itself is a function of the method**, so no future audit should quote a bare figure.

## The count is method-dependent, and a naive scan wildly over-reports

Four defensible scans of the same tree give four answers, all measured today:

| Method | "Unconsumed" | Why it is wrong |
|---|---|---|
| Grep each token's **name** (`--color-git-added`) through `src/`, comments kept | **138** | A Tailwind colour token is consumed as a **utility class** (`bg-git-added`, `text-file-ts`), never by its `--color-*` name. This is the scan behind the plan's "~137 of 174" (give or take a token, depending on exactly which files are swept) — and it is wrong by ~50. |
| Same name-grep, comments **stripped** | **163** | Worse, and instructive: doc-comments that *quote* a class (`fileIconContrast.test.ts` writes `--color-file-ts` in prose) get counted as consumers, so stripping them makes the scan over-report further. |
| Utility-aware: also match `(bg\|text\|border\|…)-<name>`, comments stripped | **91** | Catches the class consumers, but still reads tokens consumed **by CSS aliasing** (`--color-icon-blue: var(--color-terminal-bright-blue)`) as dead. |
| Utility-aware **minus** tokens another CSS token reads via `var()` | **88** | The figure this ADR uses. |

The earlier audits disagreed (~87 vs 137) precisely because they were different rows of
this table, and neither stated its method. **The lesson is not which number is right — it
is that a static scan is the wrong instrument for a token consumed indirectly, and it
over-reports by design.**

`--color-file-*` is the proof case. A name-grep calls **all 28** of them dead. In truth
**25 are consumed** — through the `fileIcons.ts` language table, which maps each extension
to a `className` **string composed at render time** (`{ ts: { className: "text-file-ts" }
… }`, read by `FileChip` and the `MessageBubble` code-block header and spread onto an
`<Icon className={…}>`). The literal token name `--color-file-ts` appears in **no**
component, so grep finds nothing; the *class* `text-file-ts` is what actually renders, and
it is assembled from the table at runtime. `fileIconContrast.test.ts` polices exactly this
family's contrast on every surface it can land on — a token under an active contrast gate
is consumed **by construction**, and deleting it would fail that gate by name. Only the
three `file-node*` **role chips** (not descriptors) are genuinely unconsumed.

**Rule for every future re-count:** before calling a family unconsumed, look for a
table/record that maps to it (`fileIcons.ts` for `file-*`, any `cva` variant map, any
`Record<kind, className>`) and for a CSS token that aliases it via `var()`. A name-grep
result is a hypothesis, never a verdict.

## Classification: reserved vs delete-when-decided

The 88 split on one question — **is there a named, planned surface that will consume this
family?** If yes it is *reserved* and its values are not a guess (a spec or a design
record fixes them). If no, it is *delete-when-that-surface-is-decided* — kept only because
removing it now is churn orthogonal to the extraction program, not because anything wants it.

**Reserved for a named unbuilt surface** (values fixed by an external spec, so the palette
cost of keeping them is near-zero and deleting them would force a re-derivation):

- **`terminal-*` ×21 of the 22 declared** — forward declarations for a terminal surface the app **does not
  have and never has had** (verified: no terminal component, no `xterm`/`@xterm/*`/
  `node-pty`/`portable-pty`/`alacritty`/`vt100` in either manifest, zero `bg-terminal-*`
  /`text-terminal-*` classes). They are kept because the values are the **published
  16-colour ANSI table** — copying it is free and leaves no half-owned palette, whereas
  a future terminal that inherits `.dark`'s generic UI greys would have to be re-tuned
  from scratch. `.theme-dracula` already owns all 22 (`TERMINAL_ANSI`) for this reason.
  The 22nd — the one not on the unconsumed list — is read today, by CSS:
  `--color-icon-blue: var(--color-terminal-bright-blue)`.

**Delete when that surface is decided** (no consumer, no spec, no committed surface — kept
only to keep this change scoped to deletions that `tsc` can police):

- **Data-scale families** — `usage-chart-*` ×6 + `usage-heatmap-*` ×5 (the usage panel is
  unbuilt), `context-breakdown-*` ×7 (the context-breakdown ring is unbuilt). Ordinal
  scales whose *steps* are the signal; a future owner should re-derive the ramps against
  the real chart, not inherit six hand-picked sky steps.
- **`git-*` ×8** — git-status hues. No component renders a git status mark today
  (`DiffBlock`/`FileSummaryCard` paint `diff-added`/`diff-removed`, not `git-*`). The
  status vocabulary belongs to whatever change adds porcelain-aware rows.
- **Role chips** — `*-node`/`*-node-foreground`/`*-node-hover` for `file`/`skill`/
  `command`/`session`/`subagent`/`plugin` (×3 each, 18 total) + `plugin-paid-plan-badge*`
  ×2. (The audit's "role-chip families ×18" is **wrong as named**: zero `--color-role-*`
  tokens exist in either stylesheet — the 18 are these `*-node` triplets, re-derived here
  rather than transcribed.) These are "what kind of row is this" identity colours for
  surfaces (a plugin/skill/
  command/session graph) that do not exist yet. `fileIconContrast.test.ts` names the
  `file-node*` three as role chips with **zero JSX consumers** and excludes them from the
  contrast gate on that basis — the exclusion is only honest while they stay unconsumed.
- **Singletons and small families** — `tab`/`tab-active`/`tab-border` ×3 (`SpaceTabs` paints
  with `bg-surface`/`bg-surface-hover`, not these), `workflow-*` ×3 (the causality-graph
  axis is unbuilt — the `@theme` comment instruments it, “工作流因果图”, no component reads
  it), `find-highlight*`
  ×2 (no find-in-page bar), `idle-task*` ×2, `diff-added-foreground`/`diff-removed-foreground`
  ×2 (`DiffBlock` uses `text-foreground` on the added/removed fills), `popover-foreground`
  /`popover-header` ×2, `tooltip-tag*` ×2, `header`, `toast`, `card-selected`, `success-foreground`,
  `feedback-privacy-hint`. Several are read only inside `dracula.css` **prose** (a doc-comment
  explains a step by naming `bg-toast`/`bg-header`/`bg-card-selected`) — a comment is not a
  consumer, and `paletteCompleteness`/`themeTokens` strip comments before parsing precisely
  so prose cannot masquerade as usage.

## The completeness tests keep enforcing them meanwhile

None of this is a licence to let the palettes drift. `paletteCompleteness.test.ts` asserts
set-equality **in both directions** across `.theme-zai-dark` and `.theme-dracula`, so a
token silently dropped from one palette fails by name; the 54-token `INHERITED` list is the
existing, already-enforced record of which of these are **intentionally** inherited rather
than restated. `themeTokens.test.ts` grades the per-layer table the same way. So an
unconsumed token is not *unguarded* — it is guarded against accidental loss while it waits
for a consumer. That is the state this ADR freezes: **kept, policed, and labelled by
whether a real surface is coming**, so the next reader decides from the classification and
not from a headline count.

## Considered Options

- **Delete all 88 now (rejected).** ~90 tokens is a real diff across `theme.css`,
  `dracula.css`, and the completeness/contrast tests, for a gain no user sees, and it
  would delete the ANSI-table forward declarations that are genuinely free to keep. A6 is
  scoped to deletions `tsc` can police; CSS tokens are not one of them.
- **Report a single "N unconsumed tokens" number (rejected).** The audit (~87) and a naive
  scan (137/163) already disagree, and both are defensible under their own method. Quoting
  one without its method re-starts the disagreement; the method table is the finding.
- **Call `--color-file-*` dead and delete the descriptors (rejected, and the trap).** A
  name-grep says all 28 are unused; 25 are rendered through the `fileIcons.ts` table and
  graded by `fileIconContrast.test.ts`. This is the concrete cost of trusting a static scan
  on runtime-composed class names.

## Consequences

- **Any future dead-token audit states its method** (name-grep / utility-aware / minus-CSS-
  aliasing) and checks for a composed-class consumer (`fileIcons.ts`, a `cva` map) and a
  `var()` alias before deleting. A bare count is not evidence.
- **The "delete when decided" families are pre-labelled**, so the change that builds a
  usage panel / git-status rows / a graph surface adopts the right family instead of
  minting a parallel one — and the change that *never* builds one can delete its family
  against this list rather than re-deriving the census.
- **The `*-node` role chips stay excluded from `fileIconContrast.test.ts`** only while they
  are unconsumed. The first real `bg-*-node` render site must be added to that file's
  contrast rows — the exclusion list is "role chips by contract", not "these are safe on any
  surface".
- **The terminal family is not evidence of a terminal.** `paletteCompleteness.test.ts`
  already retracted a comment that claimed the app "has a terminal now"; this ADR repeats
  the measurement (no component, no dependency, no class) so the forward-declaration
  framing is not mistaken for a shipping feature.
