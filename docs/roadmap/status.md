---
status: running
mode: autonomous
loop: ralph
updated: 2026-10-22
---

# Frontend component-extraction program — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Fix every finding in `docs/reviews/2026-10-22-codebase-improvement.md` (18 findings,
all approved by the owner on 2026-10-22), in the order recorded in that report's
`## Decisions — 2026-10-22` section (Phases A → D).

## Operating mode — READ CAREFULLY

**This runs autonomously. Do NOT ask the owner questions.** They approved all 18
findings and explicitly instructed: *"iterate through specify, then implement …
doing this autonomously, without asking questions, and iterating on every single
thing we just agreed on."*

Loop protocol (repeat until `status: done`):

1. Read this file. Take the **first task whose Status is `todo`** in the current
   Phase. Do not pick, reorder, or skip.
2. `specify`: if the current Phase has no plan section yet, write one into
   `docs/roadmap/frontend-component-extraction.md` with exact file paths, exact
   signatures, TDD steps and acceptance criteria. Then have a `reviewer` subagent
   vet it against the real code (max 3 fix rounds). Do not ask whether to proceed.
3. `implement`: dispatch a **`general` subagent** per task (the `implement` skill's
   dispatch guard). The orchestrator does not edit source files itself.
4. **Validate** (see gate below). Green → commit → mark the task `done` here →
   append one line to the Changelog. Red → fix by re-dispatching, not by hand.
5. Update this file **before** starting the next task. Then loop.

Rules that bind every iteration:

- **One task per commit.** Commit messages: `feat(fe): …` / `refactor(fe): …` /
  `test(fe): …` / `fix(fe): …`.
- **TDD.** Failing test first, watch it fail, then implement. No exceptions.
- **Never** ask, confirm, or summarise-to-the-user mid-loop. Decide and record the
  decision in the Decisions Log below.
- Respect the report's **explicit non-goals**: do not split `store/sessions.ts`;
  do not adopt `ui/tabs.tsx`; do not extract single-consumer JSX blocks; do not
  rename `SubagentDelegatingCard`/`SubagentTranscript`/`SubagentModals` (ADR 0066
  blesses those names).
- New components take glossary-consistent names NOW (`CONTEXT.md` `_Avoid_` lists).
  Renaming existing files is Phase D5 only, as one ADR-backed change.
- Anything that changes user-visible behaviour or the a11y tree gets its own commit.

## Validation gate (run after EVERY task; all must pass)

```
pnpm test            # from repo root      (baseline: 121 files / 2650 tests, 69.6 s)
pnpm build           # from repo root      (tsc && vite build; baseline green, ~1.3 s)
```

Baseline verified on `feature/frontend-component-extraction` @ branch start: `pnpm test`
**121 files / 2650 tests passed** (exit 0, 69.59 s); `pnpm build` exit 0. Vitest prints an
advisory about jsdom being created 121 times — that is a suggestion, not a failure; ignore it.

## Subagent dispatch convention (owner instruction — do not deviate)

Dispatch with **`agentName`** (not `agent`, not `model`). **Never pass `model`.** Do not
layer a competing `systemPrompt` on top of a named agent definition — its own definition
already carries the role; put constraints in the `task` text instead. A reviewer call that
returns only tool activity with no report text is **truncated, not failed** — re-dispatch
split into narrower scopes rather than repeating the same broad one.

**Dispatch independent subagents IN PARALLEL — same block, several calls (owner instruction,
2026-10-22).** Anything sequential here is wasted time: the per-task review of an independent
pair of tasks, several read-only verifications, a review running alongside a background test
run. Batch them. The one thing NOT to parallelise is two subagents that edit the same tree —
Phase A is SERIAL by gate 4, so implementation children go one at a time; it is *verification
and review* that parallelises. Evidence: Phase A's single broad review returned nothing but
tool activity; the same scope split three ways and dispatched together returned three full
reports, and a 4th re-review of the corrections found two more blocking errors.

Rust is untouched by this program — `cargo` gates are not required unless a task
says otherwise. A task is not `done` until both commands are green.

## Location

- Branch: `feature/frontend-component-extraction` (from `main` @ `3e355d8`)
- Report (source of truth for scope): `docs/reviews/2026-10-22-codebase-improvement.md`
- Plan: `docs/roadmap/frontend-component-extraction.md`
- On finishing ALL phases: run the `review` skill loop, open a PR, then set
  `status: done` and delete this file + the roadmap doc per AGENTS.md convention
  (roadmap docs are deleted on ship; the report stays).

---

## Phase A — unblock and take the free wins (no structural risk)

Plan status: **Phase A COMPLETE** (A0–A6 done). **Phase B planned and vetted** — B4a, B1, B2, B3 (order deliberately B4a first: it is the task that makes the others cheap to test). See `docs/roadmap/frontend-component-extraction.md` §Phase B.

**Current suite size: 126 files / 2743 tests** (121/2650 at baseline; A0 +1/0, A1 +1/+10,
A2 +1/+27, A3 +1/+7, A4 +0/+3, A5 +0/+2, A6 −1/−4 for the deleted `ids.test.ts`, B4a +1/+25,
B1 +1/+23, B2 +1/+22).
`SubagentDelegatingCard.tsx` is now 424 code lines (was 696).

**There is NO prettier/eslint/biome gate in this repo** — verified `package.json` and
`.github/workflows/ci.yml` name no formatter. The frontend gates are `pnpm test` + `pnpm build`
(`tsc`); the Rust gates are `cargo test` / `clippy` / `fmt`. A child raised `prettier --check`
warnings on A5; they are pre-existing at HEAD and enforced by nothing. Do not reformat files to
satisfy a tool CI does not run — it sweeps unrelated lines into the diff.

| # | Task | Finding | Files (primary) | Status |
|---|------|---------|-----------------|--------|
| A0 | Re-point source-grep gates at the DOM | 1 | `themeTokens.test.ts`, `slabFloatSeparation.test.ts`, `paletteCompleteness.test.ts`, `subagentSheetLayout.test.ts`, + new `SpaceTabs.pill.test.tsx` | **`done`** `22ed787` |
| A1 | `useCopyButton(text)` — 3 sites | 11a | `hooks/useCopyButton.ts` + `MessageBubble.tsx`, `ToolCallCardHeader.tsx` | **`done`** `ea6fe14` |
| A2 | `lib/subagentActivity.ts` — 217 pure lines out | 14 | `lib/subagentActivity.ts` + `SubagentDelegatingCard.tsx` | **`done`** `edc2c33` |
| A3 | `lib/sessionTime.ts` + shared formatters | 10 | `lib/sessionTime.ts`, `SubagentTranscript.tsx` | **`done`** `3886fae` |
| A4 | User-visible copy + `source` label fixes | 16a | as planned | **`done`** `b5d0967` + `ff21d01` |
| A5 | `SpaceTabs` tablist ARIA (2 attributes) | 18 | `src/components/SpaceTabs.tsx` | **`done`** `3b6ffb4` |
| A6 | Dead-code deletion (orphans, dead IPC, tokens) | 17 | as planned | **`done`** `287019f` + `3718ffc` |

## Phase B — the substrate

Plan status: **PLANNED + VETTED** (see `docs/roadmap/frontend-component-extraction.md` §Phase B).
**Execution order is B4a → B1 → B2 → B3**, NOT the report's B1→B4: B4a is the task that makes
every other task cheap to test, and B1's new tests want session fixtures that do not exist yet.

| # | Task | Finding | Status |
|---|------|---------|--------|
| B4a | `src/test/fixtures/*` + `resetStores()` (+ `renderWithProviders` **only if need is proven**) | 9 | **`done`** `5131bda` |
| B1 | `src/lib/sessionLookup.ts` → `sessionFieldOf` (plain fn, NOT a hook) | 8 | **`done`** `58c52f9` |
| B2 | `src/lib/ipc/events.ts` — event names (all 12 wrappers) + payload discriminants | 12b | **`done`** `bc77cb8` |
| B3 | `src/lib/sessionTypes.ts` + drop store re-export barrel + `verbatimModuleSyntax` | 13b | `todo` |

## Phase C — components and hooks

Plan status: **not yet planned**

| # | Task | Finding | Status |
|---|------|---------|--------|
| C1 | `useAsyncAction()` (one site per increment) + `useCatalogCache` | 11b, 11c | `todo` |
| C2 | `CHROME_BUTTON` constant + `SettingsDataRow` + `badgeVariants` settings variant | 6a–6c | `todo` |
| C3 | `IpcErrorLine` with `role="alert"` (behaviour change; one site per commit) | 7 | `todo` |
| C4 | `SessionListRow` + `RowButton` | 3 | `todo` |
| C5 | `InlineGateRow` (card only) | 5 | `todo` |
| C6 | `CatalogSearchDialog` shell — **excludes `McpDialog`** | 4 | `todo` |
| C7 | Full raw-`<button>` → `<Button>` sweep, one a11y group per commit | 6d | `todo` |
| C8 | `cn()` everywhere + `MutedCaption`/`ErrorLine`/`EmptyListLine` + lint rule | 15 | `todo` |

## Phase D — mega-files

Plan status: **not yet planned**

| # | Task | Finding | Status |
|---|------|---------|--------|
| D1 | Split `lib/tauri.ts` by domain behind a re-export barrel | 12a | `todo` |
| D2 | `useSettingsDocument()` — single owner of the settings document | 13a | `todo` |
| D3 | Collapse `SubagentDelegatingCard`'s two row derivations | 14b | `todo` |
| D4 | `ChatStream.tsx` hooks: `useMentionPicker`, `useAttachmentStaging`, `useComposerSend`, `usePromptQueueFlush` | 2 | `todo` |
| D5 | ADR-backed rename PR (glossary identifiers) | 16b | `todo` |

---

## Decisions Log

Record every autonomous decision here so a later iteration does not re-litigate it.

- **2026-10-22 — Plan vetting: 2 rounds, 6 blocking errors found and fixed.** The reviewers
  were right and the plan was wrong about its own citations. Fixed: (1) **A5** — wrapping
  `{spaces.map()}` in a `role="tablist"` div was wrong: the pill holds BOTH the `role="tab"`
  label and the ✕ (`SpaceTabs.test.tsx:268-274` pins it), so a wrapper would own illegal button
  children → `role="tablist"` now goes on the existing `data-testid="space-tabs"` div as a
  2-attribute change. (2) **A6** — "drop from the exports" **fails `tsc`**: `noUnusedLocals`
  emits TS6133 for an unused module-private function (verified empirically). Delete
  declarations; un-export only what is still read internally. (3) **A6** — pruning
  `dropdown-menu.tsx` orphans its `CheckIcon`/`ChevronRightIcon` import. (4) **A2** — importing
  all 8 `toolOutput` formatters into the new module breaks `noUnusedLocals`; only
  `formatDuration` + `summarizeToolCall` are used inside `:68-335`. (5) **A3** — pin arithmetic
  was wrong: `formatDuration(100)` → `"0.1s"`, `(1234)` → `"1s"` (verified by executing it), not
  `"<0.1s"`/`"1.2s"`. (6) **A4** — `AskQuestionCard`'s `isSubagent` is **dead in production**
  (`:131` needs `source.startsWith("subagent:")`; `ask.rs:79` writes `"native"`), so
  substituting `agentName` into that arm changes nothing a user sees while the `"subagent:x"`
  fixture goes green; now keys the label on the resolved name and requires a `source: "native"`
  test. **Lesson for later phases: verify every cited line and every numeric claim before
  writing it into a plan — and treat "un-export it" as a smell, not a fix.**
- **2026-10-22 — Finding 4 scope:** `CatalogSearchDialog` excludes `McpDialog`
  (a `Field`/`TextField` form, not a searchable list). Owner's explicit choice.
- **2026-10-22 — Finding 6 scope:** the **full** 50-button sweep is in scope
  (owner overrode the narrower proposal). Sequenced as C7, split by a11y group,
  one group per commit. Risks to respect: `ui/button.tsx:12` adds
  `disabled:pointer-events-none disabled:opacity-50` + 8 sizes (hit areas and
  focus rings change); `PermissionPrompt.test.tsx:124-126` asserts `bg-primary` /
  `border-border` on specific buttons; the window controls' `data-window-control`
  attention exemption (ADR 0038) must survive per-button — `WindowControls.tsx:19-27`
  warns any control added there inherits it.
- **2026-10-22 — A3 is user-visible:** routing `SubagentTranscript`'s metrics
  through `formatDuration`/`formatCost` changes rendered text (`1234 ms` → `1s`; a zero
  cost stops printing `$0.00`). `SubagentTranscript.test.tsx:72,86,97` pin the raw-ms
  form, so those pins are updated **in the same commit** as the intentional change,
  with a note saying why.
- **2026-10-22 — A5 accepts a documented ARIA limitation:** the ✕ and `New space` buttons
  stay siblings of the tabs inside the tablist — the ARIA tabs pattern has no owned slot for
  a per-tab close button, and this UI is deliberately browser-style closable tabs. A tablist
  with sibling controls beats orphaned `role="tab"`s. Not to be "fixed" later by
  restructuring the pill or adopting Radix Tabs.
- **2026-10-22 — B2: `tauri.test.ts` and `update.test.ts` pin event names as LITERALS ON PURPOSE.
  Do NOT "deduplicate" them onto `IPC_EVENTS` in a later task — reading the constant would make both
  go green on any rename and destroy the only wire guard that exists. Verified: changing a
  constant's value reddens them.
- **2026-10-22 — B2: the plan contradicted itself and a child caught it.** My own ⚠️ correction
  deleted the Rust-parity test but left its acceptance bullet ("The Rust-parity test exists and
  passes") standing, so a later iteration would have "fixed the omission" and re-added the unsound
  test. Bullet now states the corrected criterion. **When you correct a plan, re-read its
  acceptance criteria for leftovers of the thing you removed.**
- **2026-10-22 — B1: acceptance greps must be run TWICE, and one criterion was too strict.**
  `historySessions.find` alone misses any walk written as a local `titleOf(rows)` helper — so the
  criterion is that grep **plus** a `titleOf`-shaped check plus an `archivedSessions` review. Also:
  "only the field declarations remain" for `archivedSessions` is unachievable and wrong — whole-list
  reads (`s.archivedSessions` as an array, feeding the Archived section's rendering) are legitimate
  and are not finding 8's duplication. The criterion is now "no per-id walk", not "no mentions".
- **2026-10-22 — B1: what is NOT a three-list walk (do not fold these later).** The live-only
  liveness tests (`SessionConfigBlock.tsx:83`, `SpacesList.tsx:809`, `useSessionStatus.ts:83`,
  `ChatStream.tsx:110`) read only `sessions`; `ChatStream.tsx:1197` is a post-resume `getState()`
  read of the *fresh live* row and must keep bypassing stored data; `attention.ts:445` takes a
  caller-built `[...sessions, ...historySessions]` snapshot with no archived access and its own
  documented contract. Folding any of these into `sessionFieldOf` would change behaviour.
- **2026-10-22 — B4a: `renderWithProviders` is DEAD ON ARRIVAL, do not build it later.** The child
  disproved the need with evidence (no query/redux/swr/trpc/intl in `package.json`; only two
  contexts in `src/`, one deliberately rendering unmounted, the other owned by the compound
  component under test; the only 3 wrapping tests also assert the no-provider case). Recorded in
  `src/test/fixtures/index.ts`. **A later task must not re-add it.**
- **2026-10-22 — B4a: `vi.stubGlobal` in setup does NOT survive `vi.unstubAllGlobals()`.**
  Probe-verified: after the first call the global stub is gone permanently for that file. Four
  files call it (`EmptyStateFilm.test.tsx`, `lib/theme.test.ts`, `archimedes-film/compositor.test.ts`,
  `lib/settings.test.ts`), so **their per-file stubs stay** — they are the deletion checklist
  documented in `setup.tsx`. Any future "clean up the redundant stubs" sweep must exclude them.
- **2026-10-22 — ROLLING MIGRATION (from B4a, standing instruction for every later task).** When a
  task touches a test file, it also migrates that file to `src/test/fixtures` + `resetStores()` and
  deletes the now-redundant local stubs — except in the four `unstubAllGlobals` files above.
  Remaining backlog: ~22 hand-rolled `vi.mock("../lib/tauri")` factories, 14 `matchMedia`,
  11 `scrollIntoView`, 6 pointer-capture stubs. This is how the 833 lines go away without one
  unreviewable commit.
- **2026-10-22 — Phase B vetting: 2 parallel reviews, 4 more blocking errors in the plan.** All
  verified by the orchestrator against source, not taken on trust:
  (1) **B2's Rust-parity test was unsound** — only `todos_update` has a Rust emitter
  (`interactive/mod.rs:307`); `todos_clear` is consumer-only (`persist.rs:173`), ADR 0046 says
  `cost_update` has no native emitter, and the `COST_UPDATE`/`archimedes:`-strip "mapping rule"
  returns **0 hits** in all of `src-tauri` — it exists only in two frontend comments. Names also
  flow dynamically (`router.rs:44 sink.emit(&event, …)`), so a grep is incomplete by construction.
  Deleted. **The parity test was my own invention and it was the exact mistake
  `skills.test.ts:16-24` records the repo already retired.**
  (2) **B2's `never` default would have turned a silent drop into a runtime throw** inside the
  listener — default is now a logged ignore, keeping compile-time exhaustiveness.
  (3) **B1's generic would not compile**: `sessionConfig.ts:8`'s `SessionRow` is
  `Pick<SessionInfo, "sessionId"|"configOptions"|"contextUsage">` — no `cwd`, no `title`, the two
  fields the walk needs. Widened `Pick` named in the plan. Also found a **sixth** walk
  (`SpacesList.tsx:818-824`'s local `titleOf`) that the acceptance grep cannot see, because it
  never writes `historySessions.find` — the criterion now runs a second grep on `archivedSessions`.
  (4) **B3's barrel drop does not remove the cycle** — the cycle is `store → lib/transcript/reducer`
  (value) vs `reducer.ts:8 → store` (type, erased at runtime); a compatibility re-export leaves 9
  `src/lib/**` modules importing from the store and `sessionTypes.ts` with one consumer. The task
  now either re-points those 9 or ships the flag alone.
  Also corrected: B4a's `vi.hoisted()` is per-file and does not help a `vi.mock` factory (use
  `await import()` — the factories are already async); `resetStores()` cannot clear module-scope
  state (`sessions.ts:598,606,612,620`, `leftPaneState.ts:43`, …) so the name must not promise it;
  4 test files call `vi.unstubAllGlobals()`, which would strip a global stub; `update.ts:77` is a
  12th `listen*` wrapper outside `tauri.ts`; and `renderWithProviders` may be unnecessary — verify
  before building it.
  **Lesson: my own additions are the least-vetted part of a plan. Anything I invent (like that
  parity test) gets verified against source before it ships.**
- **2026-10-22 — A6 accepted child decisions.** `DialogPortal` was not in the plan's table but has
  an internal reader, so it was kept module-private under the same rule as `DialogOverlay`.
  `StalledInfo` (the payload type) stays for D1, but its doc-comments were re-pointed at the Rust
  command name so they no longer reference a deleted TS symbol. `inputVariants`/`InputProps`/
  `ProgressSegment`/`BrailleLoaderProps` all turned out to have internal readers → kept private,
  none deleted. **For the remaining phases: after any deletion, re-grep the touched file for every
  symbol it imports** — orphaned imports are the recurring failure mode of this task type.
- **2026-10-22 — ADR 0072's token figure is 88, and the METHOD is the point.** Static scans of
  `--color-*` consumption return 138 / 163 / 91 / 88 depending on whether JS comments and CSS
  `var()` aliasing are stripped. Any later phase that re-counts must reuse the ADR's method, not
  invent a new grep. Tokens consumed via runtime-composed class names (`fileIcons.ts`) are invisible
  to grep — do not delete a family on a grep verdict alone.
- **2026-10-22 — A5 shipped as 2 attributes, not a wrapper.** Verified in the diff: exactly
  `role="tablist"` + `aria-orientation="horizontal"` are the only non-comment additions. The test
  asserts `tablist === getByTestId("space-tabs")`, so a future wrapper-based "fix" fails it. The
  accepted ARIA limitation (close/`+` buttons stay siblings of the tabs) is recorded in the
  component — see the Decisions Log entry above for why it must not be "fixed".
- **2026-10-22 — A4 accepted child deviation: `||`, not `??`, for the agent-name fallback.**
  The plan said `agentName ?? "Agent question"`. `SubagentEntry.agentName` is a **required** string
  and `dispatch.rs:270-273` builds it with `unwrap_or_default()`, emitted verbatim at
  `worker/manager/subagent_flow.rs:636` — so an omitted `agentName` arrives as `""`, and `??`
  would render an empty label between the accent rules for every config-less dispatch. Verified
  both Rust sites myself. The child also added a test seeded with `agentName: ""`. Accepted.
- **2026-10-22 — A4: negative label lists ACCUMULATE, never swap.** `SpaceTabs.test.tsx` and
  `SpacesList.test.tsx` keep the old "sidebar" labels *alongside* the new ones. Both files say the
  lists exist so a rename cannot quietly re-add a control and leave the test vacuous, and SpaceTabs
  records being bitten by exactly that. Do not "clean up" the old entries in a later phase.
- **2026-10-22 — A4 shipped as TWO commits** (`b5d0967` copy vocabulary, `ff21d01` the
  agent-name behaviour fix), because the second changes what a user sees and the first does not.
- **2026-10-22 — A0 accepted child decisions.** (a) The child applied `stripJsComments` to
  `themeTokens`'s *presence* gate too, beyond the plan: mutation showed `toContain("text-row-verb")`
  passed with the class deleted from markup, because a doc-comment names it — the prose-as-consumer
  hazard that file already documents for its CSS gates. Accepted; it makes the gate non-vacuous.
  (b) `paletteCompleteness`'s "exactly one `data-testid=\"chrome-bar\"`" guard binds to no file, so
  the chrome bar may later move to its own component and stay green. Accepted as correct for a
  file-agnostic gate — noted so a later phase does not read it as a placement pin.
- **2026-10-22 — A6 touches no Rust.** `lib.rs:401,416,417` still register `get_stalled_info`
  and `list_agent_definitions*`; only the TS wrappers go (and the `tauri.ts:958` "kept on
  purpose" comment goes with them). Retiring the commands is a separate change with its own
  `cargo test`/`clippy` gate, and the commit message must not claim an ADR retired a surface.

## Blockers / open questions (resolve by deciding, not by asking)

(none)

## Changelog

- `2026-10-22` — **B2 done** (`bc77cb8`). 127 files / 2765 tests green; build green. Verified
  independently: 0 bare event strings across all 12 `listen*` bodies, `App.tsx`'s default warns and
  returns (no throw), and no test reads Rust source. Child caught a self-contradiction in my plan.
- `2026-10-22` — **B1 done** (`58c52f9`). 126 files / 2743 tests green; build green. Verified
  independently: both greps at 0 hits, `git diff` removes 0 assertions, and `sessionFieldOf` is
  typed to return the field, not the row. Child mutation-tested: dropping archived −5, reordering
  −3, returning the row −16, synthesizing `[]` −3. Six walks folded (incl. the grep-invisible
  `SpacesList.tsx:818`), three near-misses correctly left alone.
- `2026-10-22` — **B4a done** (`5131bda`). 125 files / 2720 tests green; build green. Verified
  independently: `git diff | grep -c '^\-\s*expect('` is **0** (no assertion removed), and
  `resetStores` uses `getInitialState()` + `replace = true` rather than a hand-written shape.
  Three files migrated, −112 lines. `renderWithProviders` correctly refused.
- `2026-10-22` — **Phase B planned and vetted** (2 parallel scoped reviewers — the parallel rule
  paid for itself immediately). 4 blocking plan errors fixed, all verified against source first.
- `2026-10-22` — **A6 done** (`287019f` deletions, `3718ffc` ADR 0072). 124 files / 2695 tests
  green; build green. Net **−472 lines**. Verified independently: `git status` shows **zero** files
  under `src-tauri/` touched, `ui/badge.tsx` survives with its C2 note, and a leftover-symbol sweep
  (`Separator`/`KbdGroup`/`CardHeader`/`DialogTrigger`/`SelectSeparator`/`listAgentDefinitions`/
  `getStalledInfo`) returns 0 consumers each — the single remaining `Tabs` hit is prose in a comment.
  **Phase A is complete.**
- `2026-10-22` — **A5 done** (`3b6ffb4`). 125 files / 2699 tests green; build green. Verified the
  diff is 2 non-comment lines with zero deletions, so no className/drag-region/middle-click change.
- `2026-10-22` — **A4 done** (`b5d0967` copy, `ff21d01` agent-name fix). 125 files / 2697 tests
  green; build green. The plan's AskQuestionCard trap was real: `isSubagent` is dead in production,
  so the naive fix would have gone green while changing nothing — the shipped tests use
  `source: "native"` (verified against `ask.rs:79`) and mutation back to `request.source` reddens 3.
- `2026-10-22` — **A3 done** (`3886fae`). 125 files / 2694 tests green; build green. Verified independently:
  one `relativeTimeFor` in `src/`, no raw-ms/`toFixed` render left in `SubagentTranscript` (only a
  doc-comment mentions it), and `SpacesList`/`SessionsSection` tests byte-identical. **First
  user-visible change of the program** (`1234 ms`→`1s`, zero cost stops printing `$0.00`), called
  out in the commit body as planned.
- `2026-10-22` — **A2 done** (`edc2c33`). 124 files / 2687 tests green; build green. Verified independently:
  the new module imports exactly the 3 sanctioned lines and holds no React/JSX; the card keeps no
  moved symbol; `SubagentDelegatingCard.test.tsx` untouched (the behaviour proof). Card 696→424
  code lines.
- `2026-10-22` — **A1 done** (`ea6fe14`). 123 files / 2660 tests green; build green. Orchestrator
  re-ran both gates independently and re-checked the diff: only JS lines moved — no `aria-label`,
  `title` or `data-testid` line is touched — and `resetRef` is gone from `src/components/`
  (was 12 occurrences). The timer render tests pass byte-identical, which is the real proof.
- `2026-10-22` — **A0 done** (`22ed787`, tests-only). 122 files / 2650 tests green; build green.
  Orchestrator re-ran the gate independently and re-confirmed the new gate bites: mutating
  `h-8`→`h-9` in `SpaceTabs.tsx` reddens 2 pill tests, and the file was restored clean.
  Two child decisions accepted and recorded below.
- `2026-10-22` — Loop started. Branch `feature/frontend-component-extraction` created from
  `main` @ `3e355d8`. Baseline: `pnpm test` **121 files / 2650 tests green** (69.6 s),
  `pnpm build` green. Phase A planned at `docs/roadmap/frontend-component-extraction.md`,
  vetted in 2 reviewer rounds (one broad dispatch truncated → re-run as 3 scoped reviews plus
  a re-review of the corrections). 6 blocking plan errors fixed — see Decisions Log.
