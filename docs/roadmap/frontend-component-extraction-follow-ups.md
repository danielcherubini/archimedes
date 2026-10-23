---
status: approved
---

# Frontend component extraction — the things it does not fix

Follow-ups to `frontend-component-extraction.md` (the 95-commit program that shipped as Phase A–D).
Every item below was **found while building or in review of that program and deliberately not fixed by
it**. None is a blocker to the merge; all are recorded so the next reader finds a decision rather than
an oversight. The plan is deleted on ship and `status.md` goes with it, so this file is what survives.

Citations here name **symbols, not line numbers** — `ROW_CONSUMER_FILES`, `useSettingsDocument`'s `patch`,
the `it(...)` names in `ChatStream.test.tsx`. Line numbers re-drift, and a stale one points a reader at
the wrong code.

**Measured rather than asserted.** Of the 159 `file:line` citations in the plan and the loop status file,
**4 (2%) are provably dead** — the cited line is past the file's end (`tauri.ts:958` and `:282` in a file
now 179 lines long, `ChatStream.tsx:1915` in one now 1551, a test citation 29 lines past its file). A
sampled check of 30 citations against the symbol the prose attached to them found **11 of 19 checkable
ones** pointing at a line that no longer contains that symbol — so the honest figure for "stale enough to
mislead" is somewhere between 2% and ~40%, not the "~45%" an earlier review round asserted and this file
repeated until it was measured. The instruction stands on the small provable number, not the large
implied one: **name the symbol, because a line number you cannot check is a line number you cannot trust.**

## 1. A tenth inline error line, undecided on purpose

**Status: recorded, not open work — but it is the one error line with no decision attached.**

`C3` migrated nine hand-spelled error lines onto `IpcErrorLine`, which owns the class string and the
`role="alert"`. `SubagentTranscript` has a tenth `text-destructive` span that renders inside a
`MutedCaption` with no `role="alert"`. It was left alone because the nine that shipped were chosen by
the criterion "a line that reports a failed IPC call", and this one reads as a status field rather than
a failure.

Decide one way and record it here: either it is a status line and stays as it is, or it is an error line
and takes `IpcErrorLine`. Do not "consistify" it without picking which of those it is — that is how it
got left.

## 2. `SessionConfigSelect`'s two floating error lines duplicate `IpcErrorLine`'s class

**Status: deliberately unowned.**

Two `role="alert"` spans in `SessionConfigSelect` spell out `IpcErrorLine`'s class string byte-for-byte.
This is exactly the duplication finding 7 exists to remove, and it survived the program: C1 shipped
without folding them, and C8's change to that file was the `cn()`/edge-constant only. So
`IpcErrorLine`'s own doc-comment points at a task that never owned them, which is how a duplication
becomes permanently invisible.

They are left because they are the **floating** variant — `absolute left-0 top-full` under a picker —
not the inline line `IpcErrorLine` renders, and folding them means deciding whether the component owns
positioning or its caller does. That is a real design question and it is not C3's. If you take it, the
answer is probably a `variant` on `IpcErrorLine`, not a second component.

**If you read this and decide the "deliberately" is a lie, the honest move is to fold them and delete
this section** — not to leave the section standing while the duplication goes unfixed for a third round.

## 3. `useSettingsDocument`'s `patch` reads the rendered document, so a batch can drop a write

**Status: documented, pinned as a deliberate non-improvement, latent — not currently reachable.**

`patch` composes its `Partial<AppSettings>` onto the **rendered** `settings` from its closure rather than
`useSettings.getState().settings`. Two patches delivered inside one React batch therefore both compose
from the same base and the second `saveSettings` drops the first. A `getState()` read would be strictly
better, and it is a two-line change.

It is left because `patch` was extracted from `SettingsPage`'s `update()` **byte-for-byte**, and silently
improving behaviour inside a refactor commit is the thing this program's whole review process exists to
catch. The pair is pinned in `useSettingsDocument.test.ts` with an assertion that says the first write is
dropped — the pin documents the behaviour, it does not endorse it.

**Not currently reachable**: every handler in `SettingsPage` calls the patch function exactly once, and
the other owner (`useAgentOverridesWrites`) is never mounted on the same screen — `App` renders
`SettingsPage` *instead of* `SpacesList`. So this is a trap for the first caller that patches twice, not
a live bug. Do the `getState()` change in its own commit and flip the pin's expectation to "both land".

## 4. `SubagentDelegatingCard` reads a details envelope the backend no longer emits

**Status: kept on purpose; the removal wants its own task.**

The card's whole child-linking chain reads `details.progress` / `details.results` off the tool result.
No current backend path emits either: every `ToolResult` in `src-tauri/src/agent/harness/dispatch.rs`
returns `details: None`, and no Rust source emits a `"progress"` key. The chain is dead against today's
transport.

It stays because `rawOutput` is **persisted**, so a session stored before the change and resumed today
can still carry an envelope — deleting the reader would silently lose the child links on old sessions.
The follow-up is to decide whether that compatibility matters, and the evidence for the decision is the
`dispatch.rs` enumeration above plus whatever the store actually holds.

Related and same shape: `claimedSessionIds` de-duplicates rows via `source.entry?.sessionId` only. In
the case where a store entry has a blank `task` **and** the envelope carries no `details.results`, the
task-keyed row resolves no entry and the task-less entry renders a second row for the same child. The
blank-task case is rejected at dispatch, so this is unreachable in production — which also means the
"one blank task used to hide real delegations" fix this code carries is not falsifiable in production
either. If you touch this file, either claim by `childSessionId` too or say in the comment that the
guard covers the sessionId link only.

## 5. `Badge` / `badgeVariants` are retained with no production consumer

**Status: accepted, recorded, and ADR 0072 is NOT the reason.**

`src/components/ui/badge.tsx` exports a component with zero importers and a variant helper whose only
importer is a test. Task A6 kept it (finding 17) and C2 considered it as the home for the settings badge
and declined. An earlier version of the file's own comment credited **ADR 0072** for the retention,
which is wrong — 0072 is about unconsumed palette *tokens* and never mentions this file. Cite A6/finding
17 if you cite anything.

The same question applies to any primitive A6 left standing for a future consumer: the retention is a
decision, and it is not covered by the ADR that governs the *token* case.

## 6. D5 — the glossary renames, deferred because no ADR authorises them

**Status: deferred. Not deferred for cost — for authority.**

The audit proposed renaming `MessageBubble` → `MessageRow`, `ChatStream` → `MessageList`/`components/chat/`,
`Reasoning` → `ReasoningBlock`, `TodoBoardPanel` → `TodoBoard`, and retiring the bare `rail`, on the
grounds that CONTEXT.md's glossary names them differently. It recorded the change as "backed by ADR
0066", and that citation does not resolve: **ADR 0066 was a duplicated number**, and neither file named
any of those symbols.

The number collision is now fixed — the history-window decision is **ADR 0073**, and 0066 resolves
uniquely to Agent-overrides — but fixing the citation did not create the missing decision. What actually
exists is a constraint running the other way: CONTEXT.md's **`Agents` glossary entry** states that
`SubagentDelegatingCard`, `SubagentTranscript`, `SubagentModals` and `usePendingSubagentRequests` keep
their names today. So the record blesses the *non-renames* and says nothing about the renames.

Cost, measured, if someone writes that ADR: `ChatStream` 779 references across 74 files, `Reasoning`
295/24, `MessageBubble` 147/17, `TodoBoardPanel` 71/8. `Reasoning` and `TodoBoardPanel` are read as
**source** by tests, so their source-grep tests must move in the same commit. Production carries 56
`data-testid`s across 25 files, and the two files the audit worried most about carry **one between
them** — so testid churn was never the real cost and the reference count always was.

## 7. The token-budget logic D3 collapsed still has one long `??` chain, unaudited

**Status: out of scope for D3; the shape is different from what D3 fixed.**

D3 collapsed **two** token-budget chains after demonstrating they disagreed — 700 vs 900 for the same
child, because two separate computations each picked their own source. That was a divergence bug.

What survives in `SubagentDelegatingCard` is **not** four more of those. The token logic is now a single
ordered fallback (`explicitTokens`: progress → interactive cost → result usage → progress summary) plus a
short final chain (`tokens`: explicit-if-positive → estimated from messages). One computation, so the
D3 bug cannot recur inside it.

The unaudited question is narrower and worth one small task: **can two arms of that chain report
different token counts for the same live child, and is the order right if they can?** `progress.tokens`
beats a cost-derived sum, which beats `result.usage`, which beats `progressSummary.tokens` — and nothing
in the file says why that order rather than any other. If the answer is "the later arms are for
resumed/older sessions and never compete", say so in the comment; that sentence is the thing that stops a
future edit from reordering the arms casually.

## 8. `RowButton`'s escape hatches are load-bearing and easy to "clean up" by accident

**Status: pinned; the risk is a future well-intentioned refactor.**

Three components carry deliberate weaknesses, each with a guard test:

- `RowButton` passes `className` through **verbatim, never `cn()`**. `ModelPickerDialog`'s disabled row
  depends on `cn` NOT running there. Wrapping it in `cn()` "for consistency" changes which class wins.
- `InlineGateRow` renders a fragment with no click handler, because the row's button is the ancestor
  `role="button"` that the `.closest('[role="button"]')` reads in `SpacesList.test.tsx` resolve through.
  Adding a handler or a wrapper element makes those reads ambiguous — there are **9** of them (8 call
  sites plus the `rowOf()` helper).
- `CatalogSearchDialog`'s rows are keyed `Fragment`s rather than elements, for the same ancestor reason.

Each has a test that fails if you undo it. The comment at each site is the second line of defence; the
first is that `pnpm test` is quick.

## 9. Test-seam counts must not be duplicated in prose

**Status: process lesson, already partially applied.**

The number of test files that `vi.mock` `@/lib/tauri` by module path is **pinned by an assertion** in
`tauriBarrel.test.ts`. That is the only place it should live. It was also written into two doc-comments,
four lines of the plan and three of the status file, and every copy went stale (33 → 34 → 35) as tasks
added hook test files — the `vi.fn()`-override count was wrong in three places simultaneously. The
guard's own header had already dropped its copy of that figure for exactly this reason and the prose
copies had not been told.

Anything a test already asserts — counts, class strings, export lists — should be cited by pointing at
the test, not restated.

## 10. `lib/update.ts` and `lib/version.ts` stay outside the barrel, on purpose

**Status: decided, pinned by `src/lib/tauriBoundary.test.ts`. Do not "finish" the move without re-reading this.**

Finding 12's third clause — "`lib/update.ts` and `lib/version.ts` are **undocumented parallel IPC
modules**" — is the half D1 never took. B2 handed it on in its own scope note ("organising those is
D1's job"); D1's plan section does not mention either file, so the hand-off landed nowhere. The clause
asked for *documentation*, and it now has it: both files are named with their reason in
`PARALLEL_IPC_MODULES`, which is a literal, so neither can disappear, multiply, or gain a third sibling
without a commit that says so.

**Why they were not moved into `src/lib/tauri/`.** Both already have a working mock seam of their own,
and it is the shape that does not tolerate a second owner: `UpdateSection.test.tsx` and
`SettingsPage.test.tsx` `vi.mock` `@/lib/update` and `@/lib/version` **wholesale, with no
`importActual`** — the one mock shape in this repo where a forgotten name arrives as `undefined`. The
35 barrel mockers do not mock `checkUpdate`/`installUpdate`/`relaunchApp`/`getAppInfo`, so re-pointing
those consumers at `@/lib/tauri` would make every one of them resolve the real updater wrappers. That
is the exact green-and-lying regression `tauriBarrel.test.ts` exists to prevent, built on purpose.
`update.test.ts` and `version.test.ts` also mock `@tauri-apps/api/core` directly to pin their wire
strings as literals, which the 2026-10-22 lesson records as deliberate.

If a later task wants one IPC tree anyway, the prerequisite is mechanical, not stylistic: give the
barrel mocks those four names (or convert the two wholesale factories to spread `importActual`) **in a
commit before the move**, so the move itself stays a pure `git mv` and any lost mock shows up as a
failure rather than as a test that quietly starts calling the real updater.

