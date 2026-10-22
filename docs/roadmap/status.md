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

Plan status: **IN PROGRESS** — A0 done; A1–A6 remaining. See `docs/roadmap/frontend-component-extraction.md` §Phase A.

**Current suite size: 125 files / 2697 tests** (121/2650 at baseline; A0 +1/0, A1 +1/+10,
A2 +1/+27, A3 +1/+7, A4 +0/+3). `SubagentDelegatingCard.tsx` is now 424 code lines (was 696).

| # | Task | Finding | Files (primary) | Status |
|---|------|---------|-----------------|--------|
| A0 | Re-point source-grep gates at the DOM | 1 | `themeTokens.test.ts`, `slabFloatSeparation.test.ts`, `paletteCompleteness.test.ts`, `subagentSheetLayout.test.ts`, + new `SpaceTabs.pill.test.tsx` | **`done`** `22ed787` |
| A1 | `useCopyButton(text)` — 3 sites | 11a | `hooks/useCopyButton.ts` + `MessageBubble.tsx`, `ToolCallCardHeader.tsx` | **`done`** `ea6fe14` |
| A2 | `lib/subagentActivity.ts` — 217 pure lines out | 14 | `lib/subagentActivity.ts` + `SubagentDelegatingCard.tsx` | **`done`** `edc2c33` |
| A3 | `lib/sessionTime.ts` + shared formatters | 10 | `lib/sessionTime.ts`, `SubagentTranscript.tsx` | **`done`** `3886fae` |
| A4 | User-visible copy + `source` label fixes | 16a | as planned | **`done`** `b5d0967` + `ff21d01` |
| A5 | `SpaceTabs` tablist ARIA (2 attributes) | 18 | `src/components/SpaceTabs.tsx` | `todo` |
| A6 | Dead-code deletion (orphans, dead IPC, tokens) | 17 | `ui/{badge,tabs,separator,dropdown-menu,card,select,dialog,kbd,input,progress,braille-loader}.tsx`, `lib/ids.ts`, `lib/tauri.ts`, + ADR 0072 | `todo` |

## Phase B — the substrate

Plan status: **not yet planned**

| # | Task | Finding | Status |
|---|------|---------|--------|
| B1 | `src/lib/sessionLookup.ts` → `sessionFieldOf` (plain fn, NOT a hook) | 8 | `todo` |
| B2 | `src/lib/ipc/events.ts` — event-name constants + payload discriminants | 12b | `todo` |
| B3 | `src/lib/sessionTypes.ts` + drop store re-export barrel + `verbatimModuleSyntax` | 13b | `todo` |
| B4 | `src/test/fixtures/` + `resetStores()` + `renderWithProviders()` | 9 | `todo` |

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
