---
status: running
mode: autonomous
loop: ralph
updated: 2026-10-23
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
  rename `SubagentDelegatingCard`/`SubagentTranscript`/`SubagentModals` — the **`Agents` glossary
  entry in CONTEXT.md** records that they keep their names today. (The plan cited "ADR 0066" for this;
  that citation was wrong — see the 2026-10-23 lesson.)
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

Plan status: **COMPLETE** (A0–A6). See `docs/roadmap/frontend-component-extraction.md` §Phase A.

**Suite size at end of Phase B: 126 files / 2743 tests** (121/2650 at baseline; A0 +1/0, A1 +1/+10,
A2 +1/+27, A3 +1/+7, A4 +0/+3, A5 +0/+2, A6 −1/−4 for the deleted `ids.test.ts`, B4a +1/+25,
B1 +1/+23, B2 +1/+22, B3 +0/0).
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

Plan status: **COMPLETE** (B4a, B1, B2, B3 — order deliberately B4a first: it is the task that makes the others cheap to test). See `docs/roadmap/frontend-component-extraction.md` §Phase B.
**Execution order is B4a → B1 → B2 → B3**, NOT the report's B1→B4: B4a is the task that makes
every other task cheap to test, and B1's new tests want session fixtures that do not exist yet.

| # | Task | Finding | Status |
|---|------|---------|--------|
| B4a | `src/test/fixtures/*` + `resetStores()` (+ `renderWithProviders` **only if need is proven**) | 9 | **`done`** `5131bda` |
| B1 | `src/lib/sessionLookup.ts` → `sessionFieldOf` (plain fn, NOT a hook) | 8 | **`done`** `58c52f9` |
| B2 | `src/lib/ipc/events.ts` — event names (all 12 wrappers) + payload discriminants | 12b | **`done`** `bc77cb8` |
| B3 | `src/lib/sessionTypes.ts` + drop store re-export barrel + `verbatimModuleSyntax` | 13b | **`done`** `bd9701d` |

## Phase C — components and hooks

Plan status: **COMPLETE** — all eight tasks shipped (31 commits), planned as C3 → C2 → C8 → C1 → C5 →
C6 → C4 → C7: cheapest first, the two highest-risk surfaces (`SpacesList` rows, the button sweep) last.

| # | Task | Finding | Status |
|---|------|---------|--------|
| C3 | `IpcErrorLine` with `role="alert"` — **9 sites, one per commit** | 7 | **`done`** `7418e95`→`fd31c7b` (7 commits) |
| C2 | `CHROME_BUTTON` const + `SettingsDataRow` + badge `settings` variant | 6a–6c | **`done`** `45353b5` + `6144b17` |
| C8 | `cn()` everywhere + `MutedCaption`/`EmptyListLine` + guard test | 15 | **`done`** `8fe956e` + `3aa254c` |
| C1 | `useAsyncAction()` + shared catalog cache (on `useCatalogRow`) | 11b, 11c | **`done`** `a49c68f`→`e981c29` (7 commits) |
| C5 | `InlineGateRow` — the card only | 5 | **`done`** `d02dd10`→`4c57551` (3 commits) |
| C6 | `CatalogSearchDialog` shell (excludes `McpDialog`) | 4 | **`done`** `1b78344`→`0da832b` (3 commits) |
| C4 | `SessionListRow` + `RowButton` — highest-risk surface | 3 | **`done`** `cb1aef3`→`204f2a5` (5 commits) |
| C7 | raw `<button>` → `<Button>`, one a11y group per commit | 6d | **`done`** `ec39402`→`861bf55` (+2 doc commits) — 34/37 swept, 3 blocked |

## Phase D — mega-files

Plan status: **COMPLETE except D5, deliberately deferred** (D1→D3→D2→D4 shipped; D5 has no ADR behind it — see its task).

| # | Task | Finding | Status |
|---|------|---------|--------|
| D1 | Split `lib/tauri.ts` by domain, **barrel mandatory** (mock seam: count pinned in `tauriBarrel.test.ts`) | 12a | **`done`** `9fa594e`→`c4c10a0` (12 commits) |
| D3 | Collapse `SubagentDelegatingCard`'s two diverged `??` chains | 14b | **`done`** `0cbe0a1` |
| D2 | `useSettingsDocument()` + `useAgentOverridesWrites` — **both** owners done | 13a | **`done`** `8c89248` + `6351a94` |
| D4 | `ChatStream.tsx` hooks — **scoped to `useMentionPicker` + 2 trivial**; 3 of 4 rejected | 2 | **`done`** `212932a` (1963→1550 L) |
| D5 | ADR-backed renames — **DEFERRED.** No ADR for the renames; 0066 collision now fixed (→0073) | 16b | `deferred` |

---

## Decisions Log

Record every autonomous decision here so a later iteration does not re-litigate it.

- **2026-10-23 — Task "12 of 20" was a stale re-delivery of D1; D1 is DONE and there is nothing to
  resume.** The instruction ("`src/lib/tauri.ts` is 1,259 lines, 10 domains, 4 moved, 6 remain, the rest
  mechanically identical") describes a state that has never existed on this branch: the file is 178
  lines, 11 domain modules exist, 0 remain, and D1 shipped in 12 commits (`9fa594e`→`c4c10a0`). "10
  domains" and "6 remaining" appear in no file in the repo. **The instruction was internally consistent
  and completely false** — which is the failure mode of a loop that reads a task text more readily than
  it reads `git log`. Before starting any task in the morning: `git log --oneline -15` and the guard
  tests, THEN the task text. If they disagree, the tree wins. See the re-entry guard above this log.
- **2026-10-23 — I did NOT manufacture the 6 missing moves, and that was the whole judgement of the
  night.** Six more commits relocating 58 interfaces from `tauri/types.ts` into per-domain files would
  have changed no import (the barrel is the only legal entry point, enforced), no behaviour, and no
  line count anyone reads — at two gate runs apiece. The plan had already rejected that boundary in
  advance: "consider keeping types in ONE module rather than scattering them by subject, since they
  cross-cut." **A task description is not acceptance criteria.** Where they conflict, say so in the
  commit and record the conflict; do not let the diff grow to match the prose.
- **2026-10-23 — "the last two moves took 40 min, most of it the test suite" is FALSE, and it was worth
  measuring before optimising.** Timed at `55d22ec`: `pnpm build` **15 s**, `pnpm test` **103 s**
  (148 files / 3042 tests), the barrel scanner alone **3 s**. The full gate is under two minutes, so it
  cannot have eaten 40. The 40 minutes was the loop's own protocol around each move — plan section,
  subagent dispatch, review round, re-dispatch on truncation — not the gate. **Do not build a faster
  test harness for this program; there is nothing to win.** If a future task is genuinely slow, time
  the two commands first and believe the stopwatch over the memory.
- **2026-10-23 — the mock-seam hazard is LOUDER than this file and `tauri.ts` both claimed, and I
  measured it rather than repeating the claim.** `tauri.ts` says a bypass is "invisible … in a green
  suite". Planted the exact bug — `useSettingsDocument.ts` importing `saveSettings` from
  `tauri/commands/settings.ts` instead of the barrel — and **37 tests failed across
  `useSettingsDocument.test.ts` and `SettingsPage.test.tsx`**. The suite catches it *when an assertion
  depends on the mocked function*. The genuinely silent case is the other one: a hand-rolled
  `invoke("delete_session")` planted in `SpaceTabs.tsx` passed **all 3,047 pre-existing tests** and
  `pnpm build`, because it never touches a mock at all. Three bypass attempts were planted and the
  suite reddened on the two that went through a mocked function (`saveSettings` → 37 failures;
  `shellSandboxAvailable`, which no test asserts on directly, → 1 failure via an indirect render
  dependency) and stayed completely green on the one that bypassed mocking entirely. So the precise
  rule is: **a bypass of a *mocked* function is usually caught by the suite; a hand-rolled IPC call is
  caught by nothing but the scanner** — and the second case is the one a reviewer cannot see in a diff
  either. That is a stronger argument for `tauriBoundary.test.ts` and `tauriBarrel.test.ts` than the
  absolute claim it replaces. Absolute claims about detection are as dangerous as absolute claims about
  counts.
- **2026-10-23 — finding 12's third clause finally has an owner (`5a937a8`).** The report's
  "undocumented parallel IPC modules" (`lib/update.ts`, `lib/version.ts`) was handed by B2 to D1, and
  D1's plan never mentions them, so it sat unowned for 95 commits. Now pinned by
  `src/lib/tauriBoundary.test.ts` (outgoing-edge guard, 6 tests, ~3 s) with the two files named in a
  literal allowlist and the reasons in follow-up item 10. **The boundary had never been enforced by
  anything** — the report's "0 call sites outside it" was a measurement of a commit, copied into two
  documents, and mistaken for a property.
- **2026-10-23 — two bugs I wrote into the new scanner, both caught by habits this program built.**
  (1) `.filter((line) => !/^\s*\/\//)` — a RegExp object is truthy, so negated it drops EVERY line and
  the scanner silently read **0 files**; it took several confused debug rounds to find because the
  helper is character-identical to the working inline chain. It was found at all only because the file
  opens with a vacuity guard (`expect(productionIpcImporters().length).toBeGreaterThan(0)`) — without
  that one line all six tests would have passed while reading nothing. **Every scanner in this repo
  must ship a vacuity guard; it is the only thing that catches a blind scanner.** (2) Matching
  `["']@tauri-apps/api/core["']` bare flags PROSE as a dependency — `tauriBarrel.test.ts` passes that
  string as an argument to its own resolver and was reported as an unmocked IPC import. Match the
  import shape, not the token: the lesson `themeTokens.test.ts` already records. (3) I also wrote
  "30+ files mock `invoke` at that path" — the real figure is **4** — and "the review is the only place
  that number lives", which is false, the plan repeats it too. Both corrected before commit.
- **2026-10-23 — Phase D and all four phases are CLOSED; the only open work is the 10 follow-ups.**
  `status.md` has **zero tasks with Status `todo`**. A loop iteration that finds none must not invent
  scope: the correct end state is to say the plan is finished. What is NOT done is the ship sequence
  (the `review` skill loop, the PR, then deleting `status.md` + the plan per AGENTS.md). **I did not
  open a PR at 4am.** The branch is 95+ commits and pushed; a PR opened unattended cannot be answered
  if review comes back, and deleting the loop's memory files is irreversible. Both are one command for
  a human in the morning.

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
- **2026-10-22 — MEASUREMENT DISCIPLINE, learned the hard way four times today: verify every identifier
  you write down.** A false doc-comment (C5, caught pre-commit), two false `.select-auto` claims I had
  written myself (caught in C7), an invented commit hash `2026019f` for the real `287019f`, and a
  fabricated `Co-authored-by` trailer. Also: an **absolute claim is where I go wrong** — "no lint
  tooling", "34 mock files", "byte-identical class string", "ADR 0066 blesses X". Each was checkable in
  one command. **And a blocking verdict ("this can't be done") needs the same proof as a delivery** — a
  reviewer overturned 2 of my 3 C7 blockages, and my own plan's D5 rested on a citation that does not
  exist.
- **2026-10-22 — Phase D vetting overturned 4 of my own assumptions.** (1) **D5's justifying citation
  is FALSE**: "ADR 0066 blesses SubagentDelegatingCard/SubagentTranscript/SubagentModals" — `0066` is a
  **duplicated ADR number** and neither file mentions those names. D5 is deferred until an ADR exists.
  (2) **D4: 3 of its 4 named hooks cannot be extracted** — `heldForSendRef` is shared by three clusters
  and `ChatStream.test.tsx:2082/:2106` fail as a *leak*, not a crash, if split. (3) **D1's audit
  boundary is wrong** — the catalog fetchers are one domain (Phase C's `useCatalogRow` proves it), and
  the "delete dead exports" half was already done. (4) **D2's scope is half** — `SpacesList.tsx:333,354,
  596,607` own the same settings document, one with its own rollback logic.
- **2026-10-23 — D2/D3/D4 DONE; D5 deferred. Phase D is closed.** `useSettingsDocument` (one owner of
  the settings document — `SettingsPage`'s mirror `useState` gone, `loadSettings` finally has a caller)
  and `useAgentOverridesWrites` (`SpacesList` −242 L, rollback chain moved **byte-identically**, verified
  by diff not assertion). `ChatStream.tsx` 1963→1550 via `useMentionPicker` + 2 zero-coupling effects;
  `send`/`flushHead`/`resume` **stay** — `heldForSendRef` is shared by three clusters and
  `ChatStream.test.tsx:2082/:2106` fail as object-URL *leaks* if split. `SubagentDelegatingCard`'s two
  `??` chains collapsed after demonstrating they diverged (700 vs 900 tokens for one child).
- **2026-10-23 — ADR 0066 was a DUPLICATED number; the history-window ADR is now 0073.** "ADR 0066"
  now resolves uniquely, to the Agent-overrides decision (76 citations vs 8; and 0066/0067/0068 are a
  trilogy cross-referencing by number). **`useAgentOverridesWrites` + `useSettingsDocument` are the
  settings-document seam — go through them, don't re-add a `useState` mirror or a hand-rolled fetch.**
- **2026-10-22 — D1 is DONE. `lib/tauri.ts` is now a PURE RE-EXPORT BARREL (178 L, no `invoke`, no
  `listen`) over 11 domain modules in `src/lib/tauri/`. The one rule: **every consumer imports from
  `@/lib/tauri`, never from a domain module** — `src/lib/tauriBarrel.test.ts` enforces it, because a
  direct import makes a `vi.mock` silently inert while the test still passes against real IPC. If you
  add an IPC function, put it in the domain module and re-export it from the barrel.
  Corrected numbers: **33** mock files (not 34 — `SubagentDetailHost.test.tsx` deliberately has no mock),
  **121** `vi.fn()` overrides (not ~107 — the audit conflated that with the 107 export count), 58 type
  exports (not ~71). The 28 zero-importer exports are NOT dead — 27 are payload types consumed by `listen*`.
- **2026-10-22 — D1's method was the best of the program and is worth reusing:** the child built a
  splitter that **refuses to run unless it reconstructs the source byte-for-byte**, so no doc-comment
  was reflowed; left 12 verified per-module patches; I replayed them as 12 commits and confirmed the
  final `git write-tree` hash equalled the snapshot I had independently validated. **Capture a tree hash
  before reshaping a verified tree** — it makes a history rewrite provably lossless.
- **2026-10-22 — D1's load-bearing constraint: dozens of test files `vi.mock` `@/lib/tauri` BY MODULE
  PATH**, most spreading `importActual`. The barrel is what keeps them working. **The count is pinned by
  `tauriBarrel.test.ts` — read it there.** Every hand-carried copy of it in this file, the plan and two
  doc-comments has gone stale at least once (33 → 34 → 35 as tasks added hook tests), and the
  `vi.fn()`-override figure was wrong in three different places at once.
  **The hazard: a mock on `@/lib/tauri` does not intercept a consumer importing the moved function from
  its new domain module — and the test still passes, hitting real IPC.** So consumers must keep
  importing from the barrel, guarded by a scanner test, and the full suite runs after EVERY module move.
  Useful measured fact: **zero of `tauri.ts`'s 49 exported functions calls another in the same file**,
  so moves cannot break internal callers.
- **2026-10-22 — C7 IS DONE with 3 sites left as raw `<button>`s ON PROOF. Do not "finish" them.**
  `SpaceTabs.tsx`'s ✕ is blocked by `SpaceTabs.test.tsx:345` (`not.toMatch(/opacity-/)` vs the base's
  `disabled:opacity-50` — tailwind-merge cannot strip a variant `className` doesn't name);
  `ToolCallCardHeader.tsx`'s row and `ChangesGroupCard.tsx`'s row are blocked because
  `buttonVariants`' **base carries `bg-clip-padding`** and `transcriptRow.test.tsx:102` requires zero
  `bg-*` tokens — `bg-clip-*` is its own merge group, so no variant or override removes it. **All three
  carry this rationale in a comment at the site.**
- **2026-10-22 — C7's four traps, all now pinned. Any future `<Button>` conversion must check these:**
  (1) `defaultVariants` → a bare `<Button>` paints `bg-primary`; name variant AND size. (2) The base's
  `[&_svg:not([class*='size-'])]:size-4` beats a `size={N}` **prop** — add the matching `size-*` class.
  (3) **`size="default"` contributes `text-ui-base`, and `ChatStream.test.tsx` selects
  `.text-ui-base`** — a site spelling no font-size GAINS one and is picked up by a test that never saw
  it; fix with `text-[length:inherit]`, never by editing the test. (4) **jsdom cannot see layout.** The
  base's `shrink-0` broke tab-label eliding (307px vs 188px, measured in headless Chrome with
  `min-width:0` present) and `inline-flex`+`items-center`+`justify-center` moved a glyph 8px. **A
  class-set diff shows both as clean additions.** For any conversion that changes `display`, `flex-shrink`
  or alignment, probe with `google-chrome --headless --dump-dom` and `getBoundingClientRect()`.
- **2026-10-22 — the DOM-capture evidence method, and its one flaw.** `document.body.innerHTML` per
  test, baseline in a `git worktree` at the base commit, both states run **twice**, then subtract the
  non-determinism set (~97 tests here: random quips, braille spinner frame, async highlighting, one
  async send race). Comparing with `class`/`data-slot`/`data-variant`/`data-size` stripped proves
  structural neutrality; comparing class SETS proves nothing was lost. **It cannot see layout** (above),
  and it needs ~15 min for 4 runs — budget it. Use a worktree, not `git stash`, when siblings share the
  tree; `pnpm exec` fails on a symlinked `node_modules`, so run vitest's binary directly.
- **2026-10-22 — C4: `RowButton` is the ONLY `role="button"` in production `src/`** (plus
  `TodoBoardPanel.tsx:279`, a deliberately different affordance: Enter OR Space + `preventDefault`,
  pinned inert-in-RowButton so it can't be folded in). **Never use `RowButton` for a hover action
  inside a row** — a second `role="button"` makes the **9** `.closest('[role="button"]')` reads in
  `SpacesList.test.tsx` ambiguous (8 call sites plus the `rowOf()` helper; grep returns 10 because one
  hit is a comment at `:1773`). `RowButton` passes `className` **verbatim, never through `cn()`** —
  `ModelPickerDialog`'s disabled row depends on `cn` NOT running there.
- **2026-10-22 — `SpacesList.test.tsx` line numbers are stale.** C4's fixture migration shifted them
  (−98 L). Every `:NNNN` citation to that file in this file or the Phase C plan is off by offset; the
  assertions are byte-identical (233 before / 233 after, diff empty). **Cite that file by assertion
  name, not line.**
- **2026-10-22 — ORCHESTRATOR SELF-NOTE (second one): I wrote a commit message claiming a doc-comment
  was updated, before updating it.** The child's C4 message said C6's cross-reference "is updated here"
  and it wasn't — I found the stale text after committing, fixed the comment and amended so the claim
  became true. **A commit message is a claim about the diff; verify it the same way as code.** Same
  class of error as the fabricated `Co-authored-by` two commits earlier: confident prose about things
  that aren't so.
- **2026-10-22 — C6: `CatalogSearchDialog` owns the DIALOG, never the row.** Its rows are keyed
  `Fragment`s because a `div` in the row list is the extra DOM level the ancestry pins forbid
  (`row.parentElement` → scroller → wrapper). **Any later task adding a wrapper element there breaks
  `SkillsDialog.test.tsx` and `ModelPickerDialog.test.tsx`.** Two slots are load-bearing: `beforeSearch`
  (renders ABOVE the `<Input>`) and `children` (BELOW the rows) — Agents needs both. The scroller
  exposes only `rowGapClassName`, spliced positionally, because `cn()` MOVES a gap override to the end
  of the string, which rewrites the class attribute.
- **2026-10-22 — C6 method worth reusing: capture `document.body.innerHTML` per state, baseline via
  `git stash`, diff.** 20 states, 20/20 byte-identical. For any extraction whose guards are DOM-ancestry
  pins, this is stronger evidence than "tests pass", and it catches the regressions no test covers.
  **C4 should do the same for `SpacesList` rows.**
- **2026-10-22 — C5: the per-row vs per-region Escape asymmetry is NOT a defect to tidy.**
  `TranscriptFooter` stops Escape per-row, `SubagentModals` per-region, and `InlineGateRow` renders a
  **fragment with no handler at all** — deliberately. The attribution chip is a *sibling* of the card,
  and the region's `p-3` padding and `gap-3` inter-card gaps are reachable by a keypress
  (`pointer-events-none` gates pointers, not keys), so a card-level stop would be strictly narrower and
  would silently uncover three paths. **If a later task is tempted to "unify" the two handlers, that
  test is the tripwire.** `SHEET_WIDTH_CLASS` also must stay in `SubagentModals.tsx` —
  `subagentSheetLayout.test.ts` reads that file as source.
- **2026-10-22 — C5: I corrected a false doc-comment the child wrote before committing.** It claimed
  the card root had an `onKeyDown`; the handler belongs to `AskQuestionCard`'s own root (`:315`) and
  `PermissionPrompt` has none (it is `<Button>`-based). **A confident comment describing code that does
  not exist is a defect** — read the claim, don't accept the prose. Worth adding to the child's brief:
  verify your own doc-comments name real code.
- **2026-10-22 — C1: `useAsyncAction`'s guard reads RENDERED state, not a ref — on purpose.** It is a
  faithful copy of `if (busy) return`, so two `run` calls dispatched in one batch both pass. A test
  pins this as a deliberate non-improvement: **upgrading to a ref is a behaviour change and must be its
  own commit**, not folded into a refactor. Related: at `SudoConfirmModal` the `disabled={busy}`
  attribute is the *only* re-entrancy protection — treat it as load-bearing.
- **2026-10-22 — C1: `useCatalogRow.ts` is the single catalog-cache implementation; do NOT add
  `useCatalogCache`.** A test asserts that file does not exist. `useCatalogRow` was lifted to its own
  module rather than exported from `useMentionCatalogs` because that file imports `useSkillCatalog` —
  exporting there re-creates the B3 module cycle. Each catalog keeps its **own** cache Map (logic is
  shared, state is not); a test proves cross-eviction does not happen.
- **2026-10-22 — ORCHESTRATOR SELF-NOTE: I added `Co-authored-by:` trailers to two commits that no
  participant earned, then rewrote them out.** Never add attribution a human did not author. When
  amending, use `git commit --amend` only on HEAD; to fix an older commit use `git reset --soft` +
  path-scoped `git commit -F - -- <paths>`, because `git commit --amend HEAD~1` amends HEAD, not the
  argument.
- **2026-10-22 — C8: `classNameConvention.test.ts` is the guard later tasks must obey.** New files
  (`InlineGateRow`, the picker shell, `SessionListRow`/`RowButton`, C7's sweep) must use `cn()` from
  their first commit. **Do not widen its allowlists** — it asserts set membership both ways, so an
  allowlist entry whose site was converted also fails. Two allowlists exist for real reasons:
  `HAND_ROLLED_COMPOSITION` (**3** sites — verified by counting the list; an earlier note here said 4) where `cn` changes rendering — a same-group conflict drops a
  utility: `transition-transform` at `ChangesGroupCard:239`/`ToolCallCardHeader:157`, `cursor-pointer`
  at `ModelPickerDialog:162`) and `STATIC_TERNARY_SECTIONS` (8 whole-expression ternaries where `cn`
  is provably the identity). **The general rule: `cn` drops the loser of a same-tailwind-group
  conflict. Check for that before converting, and measure rather than assume.**
- **2026-10-22 — C2: finding 6c is CLOSED AS REJECTED, not implemented.** `badgeVariants` is the
  wrong home for `SettingsBadge`; measured with the real `cn()`, the base's `h-5`/`w-fit`/
  `rounded-full`/`overflow-hidden`/`[&>svg]:size-2.5!` survive a `settings` arm and change the box at
  all 20 sites, and parity would need ~15 `!important` negations with **no visual test layer to verify
  against** (`getComputedStyle` appears in 0 component tests). The evidence is executable: a 4-test
  block in `primitives.test.tsx` re-runs the merge and reddens if anyone adds a `settings:` arm without
  re-measuring. **Do not "finish" 6c in a later phase.**
- **2026-10-22 — `badgeVariants({})` / `buttonVariants({})` are NOT their base strings.** Both have
  `defaultVariants {variant:"default"}` folding in `bg-primary text-primary-foreground`. Any task
  passing a `className` override to `<Badge>`/`<Button>` must name `variant` explicitly. This is the
  single most repeatable trap found in this program — C7 depends on it.
- **2026-10-22 — C2 follow-up CLOSED by C8.** `GeneralSection.tsx:424` and `UpdateSection.tsx:400` are
  now `SettingsDataRow`. C8 checked *why* the missing `first:border-t-0` looked like a blocker and found
  it inert: neither row is ever its card's first child, so `:first-child` could never have matched.
- **2026-10-22 — A source-scanner test must use the computed-specifier idiom.** A bare
  `import "node:fs"` fails `tsc` (this app ships no `@types/node`). Use
  `const NODE_FS = "node:" + "fs"; const {readFileSync, readdirSync} = await import(NODE_FS)` as
  `cssSource.ts` / `themeTokens.test.ts` do. **C8's guard test needs this.**
- **2026-10-22 — C3 flagged a test gap; C1 CLOSED it.** `SudoConfirmModal.test.tsx` and
  `SudoPasswordModal.test.tsx` now exist (15 tests each, written as characterisation tests before the
  migration). C3 had had to verify those two sites by DOM capture instead.
- **2026-10-22 — C3: `cn()` reorders conflicting classes; that is not a bug.** `UpdateSection`'s
  `text-ui-base` override renders as `text-destructive text-ui-base` (attribute string reordered,
  utility set identical). Any later task claiming "byte-identical class string" must mean the
  *utility set*, not the attribute order. `IpcErrorLine` is a **named** export — C8 imports it; do
  not create an `ErrorLine`.
- **2026-10-22 — Phase C vetting: 6 parallel subagents, 5 audit/plan claims overturned.** Measured
  numbers now in the plan: **37** raw buttons in 19 files (the audit's 50 counted doc-comment prose);
  `useAgentCatalog.test.ts` **exists** (220 L / 8 tests) so the audit's C1 guard is already satisfied;
  **no lint or format tooling exists anywhere** (no eslint/biome/oxlint/prettier in package.json or
  the lockfile, no config, no CI step) so C8's "lint rule" is a vitest source-scanner, not a new
  dependency; `MessageList.gap.test.tsx:123` filters `/^pt-/` not `mt-`; `SettingsBadge` has a test
  reference (`WebSearchSection.test.tsx:120` asserts `title`), so "0 test references" was wrong.
  **Five of my own plan claims were false and are corrected in place:** `<Button>` has
  `defaultVariants {variant:"default"}` (`button.tsx:40`) so a bare swap repaints all 37 sites
  `bg-primary` — every site must name variant/size/className; `badgeVariants`' base carries `h-5`,
  `rounded-full`, `text-ui-xs` and `[&>svg]:size-2.5!` so a `settings` variant is **not**
  byte-identical; `RowButton` must carry `disabled`/`aria-disabled`/`tabIndex` or it cannot serve
  `ModelPickerDialog.tsx:142`; the C6 shell needs a **`beforeSearch`** slot because AgentsDialog's
  `noSpaceOpen` block renders **above** the `<Input>` and a `header→input→children` shell would
  move it with no test to catch it; and the transcript-row blocker is `Button`'s base
  **`bg-clip-padding`**, not the `h-*`/`px-*` I originally blamed.
  **Standing lesson: my absolute claims are the failure mode. Six parallel read-only surveys cost
  less than one wrong task.**
- **2026-10-22 — B3: `sessionTypes.ts` must have lib consumers, not just the store.** The full
  option was taken deliberately: re-pointing the 9 production `lib/**` importers gives it 13 lib
  consumers. A future task must NOT "simplify" this by having `lib/**` import the types back
  through `store/sessions` — the store's re-export exists for the ~69 **component** call sites only,
  and a comment at `store/sessions.ts` says so. Also: the only remaining `lib → store` import is
  `sessionLifecycle.ts:4`, a **value** import of the store — a different edge, intentionally kept.
- **2026-10-22 — B3: another premise of mine was wrong.** I had written that the `:37-41` barrel had
  "zero importers"; `store/sessions.test.ts` imported three of the five symbols **through the store**,
  so deleting it as written broke the build. The claim was true of external importers only.
  **Pattern across this loop: my absolute claims ("zero", "exactly", "none") are the ones that break.
  Qualify them or verify them at execution time.**
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

## Final review round (2026-10-23) — the code passed, the documentation did not

**Suite size at ship: 148 files / 3042 tests** (`pnpm test`, ~96 s); `pnpm build` clean; `cargo test`
1241 passed; `cargo clippy --all-targets` 0 warnings; `cargo fmt --check` clean. Every "N files / M
tests" figure elsewhere in this file is a HISTORICAL entry for the phase it sits under — none of them is
current, and no per-phase line was ever meant to be read as the live number.

Three parallel reviewers (Phase A+B+C-first-half, Phase C-second-half+D, and a docs-accuracy auditor)
over 95 commits. **No reviewer found a defect in the shipped code.** Every finding was in the record.
That is worth naming, because a program whose whole thesis is "verify before you assert" produced a
record that needed 20+ corrections while its code stood up.

**What was wrong, and the class each belongs to:**

- **A renumber that missed a whole tree (🔴 mine).** The 0066→0073 sweep grepped `docs/` and `src/` and
  assumed the 49 `src-tauri/` hits were uniform. 7 were this decision (paged history, the `todos_json`
  migration, the event-router persistence). *Class: scoping a sweep to the trees you were thinking about.*
- **My "correction" was wrong twice.** I wrote that `TRANSCRIPT_ROW` has four consumers — it has three;
  `themeTokens.test.ts:747` is the authority and `MessageBubble.tsx:265` only names the constant in
  prose. I also wrote "189 `data-testid`s across 24 files" where the truth is 56 across 25. *Class:
  overcorrecting a caught error without re-measuring, which produces a second false claim with the
  authority of a correction.*
- **A citation invented into new production code.** `useSettingsDocument.ts` attributed a "ceiling where
  a hook stops being testable" to `useMentionCatalogs.ts:113`, which is a bare `return { … }`. The plan
  added that the 4-field hook "needed a component test rather than `renderHook`" — its test calls
  `renderHook` 37 times. *Class: citing a claim rather than making an argument.*
- **Stale-by-construction counts.** "33 mock files" lived in two doc-comments and four plan/status lines;
  the true figure is 35 (pinned by the guard). The `vi.fn()`-override count was wrong in three places at
  once. **Resolution: the number now lives only in `tauriBarrel.test.ts`; everything else points there.**
  *Class: duplicating a fact that a test already owns.*
- **Provenance errors.** `badge.tsx` credited ADR 0072, which never mentions it (real source: A6/finding
  17). `status.md` still carried "ADR 0066 blesses those names" in an **active Constraints bullet** after
  the same file had established that citation was false. A changelog line cited `bd7710d`, not a valid
  object. *Class: writing the source of a decision from memory.*
- **Phase A's acceptance criterion (g) was false while recorded COMPLETE** — "no shipped module exports a
  symbol nothing imports". Fixed by code, not by weakening the criterion: deleted `speedToDuration`
  (zero references anywhere, older than this repo's design-system port) and de-exported five
  file-internal symbols (`DOT_BITS`, `BRAILLE_BASE`, `getPrecomputeContext`, `providerDisplayName`,
  `tabStatusOf`), which is exactly A6's own stated rule. `Badge`/`badgeVariants` stay retained by
  recorded decision. `noUnusedLocals: true` makes de-exporting self-checking — tsc fails if a reader
  existed. *Class: declaring a phase complete against an enumerated task list instead of the criterion.*

**The one structural lesson: cite the assertion, not the address.** Measured at ship, not estimated: of
the **159** `file:line` citations in these two docs, **4 are provably dead** (the line is past the file's
end — `tauri.ts:958` and `:282` in a file now 179 lines long, `ChatStream.tsx:1915` in one now 1551).
Weaker but closer to what actually misleads: sampling 30 citations and checking whether the cited line
still contains the symbol the prose attached to it, **11 of the 19 that were checkable failed**. So the
true rate of "stale enough to point somewhere wrong" sits between 2% and ~40% and nobody has measured it
exactly — which is itself the argument. A line number you cannot check is a line number you cannot trust;
an `it(...)` name, a named const or a symbol survives every edit that moves it.

An earlier pass at this lesson claimed "~45% stale" and "the C7 table's were 32/37 dead before C7
started". Neither was reproducible when checked — the C7 section's 22 citations are **0/22 provably dead**
today — and the 45% was a reviewer's estimate I adopted without measuring. Both are gone; the numbers
above are ones I ran.

## 🔴 Task-12 re-entry guard — READ THIS BEFORE TOUCHING `lib/tauri` AGAIN

A later iteration was handed this task text: *"Split `src/lib/tauri.ts` (1,259 lines) by domain
… you've moved 4 of 10 domains, 6 remain, mechanically identical."* **That description is false at
HEAD and was false when it was written.** It is a stale snapshot of a finished task, not a resume
point. Measured at `55d22ec`:

| the task asserts | the tree |
|---|---|
| `src/lib/tauri.ts` is 1,259 lines | **178** lines, zero `invoke`, zero `listen` |
| 4 of 10 domains moved, 6 remain | **11 domain modules exist; 0 remain** |
| work is in progress | D1 shipped `9fa594e`→`c4c10a0`, 12 commits, recorded `done` above |

The "10 domains" and "6 remaining" figures appear **nowhere** in this repo — not in the report, the
plan, this file, or any follow-up. They cannot be resumed from, because they were never true here.
The 1,259-line figure is the report's own **pre-split** measurement of a file that no longer exists
in that shape; `docs/reviews/2026-10-22-codebase-improvement.md` heading 12 still reads
"one 1,259-line seam", and that heading is the only reason the number survives.

**Do not "finish" D1.** If a task description conflicts with `git log` and a green guard test, the
guard test wins. The 1,259 lines went to `tauri/types.ts` (877) + 9 `tauri/commands/*.ts` +
`tauri/events.ts` (138), and `tauriBarrel.test.ts` pins the whole surface at **107 names / 49
runtime values** (measured from the two literal lists in that file — the counts live there, per
follow-up item 9, not here).

**If you are tempted to split `types.ts` by subject to manufacture the missing 6 moves: don't.** The
plan rejected that boundary in advance — "consider keeping types in ONE module rather than scattering
them by subject, since they cross-cut". Six more commits of moving 58 interfaces between files would
change no import, no behaviour and no line count that matters, at ~2 gate runs each. **D1 is done;
take the next task or stop.**

## Blockers / open questions (resolve by deciding, not by asking)

**Nothing blocks the merge.** The open decisions live in
`frontend-component-extraction-follow-ups.md` — nine of them, each with its status and the reason it was
left. That file exists because this one and the plan are **deleted on ship**, and until now every
"deliberately not fixed" note in this file was scheduled to vanish with it. Precedent:
`compaction-recovery-hardening-follow-ups.md`, which has been carrying resolved and accepted items since
2026-10-14 and names the same symbol-not-line citation rule this file's review round arrived at.

Do not restate those nine items here. This file is the loop's working memory and it is already the worst
evidence in the repo of what happens when a fact is written down in six places.

## Changelog

- `2026-10-22` — **C7 done** (6 groups, `ec39402`..`861bf55`, +2 rationale commits). 142 files / 2955
  tests green; build green. **34 of 37 sites swept; 3 blocked on proof.** Verified independently: zero
  structural changes with 97 noise tests subtracted, zero utility classes lost anywhere, 0 assertions
  removed except 6 C2 `toBe(EXACT_STRING)` pins replaced by a **stronger** contract (every original
  token present + additions equal a pinned 22-token literal — mutation-proved: injecting a painting
  utility into `Button`'s base reddens 3). `chromeButton.test.ts` and `classNameConvention.test.ts`
  byte-identical throughout.
  **A reviewer overturned 2 of my 3 "not sweepable" verdicts before I'd written them into the plan** —
  I had blocked 10 sites where only 3 are genuinely blocked. Lesson: a "can't be done" verdict needs the
  same proof as a "done", and a second opinion on a blocking claim is cheap.
- `2026-10-22` — **C4 done** (5 commits, `cb1aef3`..`204f2a5`). 140 files / 2940 tests green; build
  green. The highest-risk surface, and the strongest evidence yet: **all 233 `expect(` lines in
  `SpacesList.test.tsx` byte-identical** (verified by extract+diff, not by eye), 10 `.closest` reads
  byte-identical, `role="button"` node count captured per state (4,4,4,4,5,5) proving the one-ancestor
  rule rather than asserting it, and `TodoBoardPanel.tsx`/`classNameConvention.test.ts` untouched.
  Child corrected my baseline number (2911, not the 2891 I passed it — I'd quoted C5's figure).
- `2026-10-22` — **C6 done** (3 commits, `1b78344`..`0da832b`, Skills → Models → Agents). 138 files /
  2911 tests green; build green. Verified independently: `McpSection.tsx` untouched, five guard files
  byte-identical, `RowButton.tsx` correctly absent (C4's job), `beforeSearch` confirmed rendering above
  `<Input>` in the shell, 0 removed assertions, no scratch harness left.
- `2026-10-22` — **C5 done** (3 commits, `d02dd10`..`4c57551`). 137 files / 2891 tests green; build
  green. Verified independently: all six guard/adjacent test files byte-identical, `SHEET_WIDTH_CLASS`
  still in `SubagentModals.tsx` (4 occurrences), tree clean. Found and fixed one false doc-comment
  (above). Child proved DOM-neutrality by capturing `outerHTML` before/after for 4 trees.
- `2026-10-22` — **C1 done** (7 commits, `a49c68f`..`e981c29`). 136 files / 2878 tests green; build
  green. Verified independently: all three catalog guard test files byte-identical (`git diff --stat`
  empty), no `useCatalogCache.ts`, 0 removed assertions. Child corrected my plan again —
  `useSkillCatalog` **does** have a 231 L / 7-test guard, so the guard was two-sided, not one-sided.
  `SudoConfirmModal` and `SudoPasswordModal` now have tests (30 characterisation tests), closing the
  gap C3 flagged.
- `2026-10-22` — **C8 done** (`8fe956e` components, `3aa254c` conversions + guard). 132 files / 2828
  tests green; build green. Verified independently with my own mutation: reverting `FileChip.tsx:39`
  to a template literal reddens exactly one guard assertion and names the file; restored byte-exact.
  41 of 45 conversions; 4 sites left hand-rolled on measurement with reasons; 8 ternaries exempt as a
  listed set. Child corrected two of my numbers again (scope 45 not 40; `MutedCaption` exact-pair
  duplication 10/7 not 25/10).
- `2026-10-22` — **C2 done** (`45353b5` chrome buttons, `6144b17` settings rows + badge decision).
  129 files / 2804 tests green; build green. Verified independently: `SpaceTabs.tsx` diff is
  **comments only** (16 added, 0 removed), 0 removed assertions, `badge.tsx` changed in comments only.
  Finding 6c closed as REJECTED with executable evidence rather than implemented.
- `2026-10-22` — **C3 done** (7 commits, `7418e95`..`fd31c7b`). 128 files / 2783 tests green; build
  green. Verified independently: 9 `<IpcErrorLine` call sites, zero scope violations against the 8
  out-of-scope files, 0 removed assertions, no scratch files left. First **behaviour-changing** task
  of the program (9 surfaces gain `role="alert"`), deliberately split one-site-per-commit.
- `2026-10-22` — **B3 done** (`bd9701d`). 127 files / 2765 tests green; build green.
  Verified independently: `verbatimModuleSyntax: true` set, 13 `sessionTypes` consumers in `lib/`,
  0 removed assertions, and the sole surviving `lib → store` import is a value import. Net −85 lines.
  **PHASE B COMPLETE.**
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
