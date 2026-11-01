---
status: running
mode: autonomous
updated: 2026-11-01
---

# ChatStream decomposition (issue #135) — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Decompose `src/components/ChatStream.tsx` (1,553 lines) into single-responsibility hooks plus a thin
orchestrator, and split its 7,885-line test file along the same seams, with **no behaviour change**. Source
document: GitHub issue #135 (approved block — its own Acceptance Criteria are the ship criteria). The task
breakdown is mirrored as a comment on #135.

Ship means: `ChatStream.tsx` reads as an orchestrator (~150–250 lines), extracted hooks each carry focused
unit tests, image staging / drag-drop / paste fallback / mentions / queue flush / turn completion / composer
commands behave identically, and `pnpm test` + `pnpm build` are green.

## Operating mode

The whole wave moves at once — planning fans out, it is not one task at a time.

**On every resume, before dispatching anything:** run `git status --porcelain` **and `git worktree list`.** A wave
child's edits land in its own worktree, so a clean primary tree proves nothing — an `*-taskNN` worktree left over
from a dead iteration means that task died **mid-implementation**: check `git -C <worktree> status --porcelain` for
each one. Such a task is `implemented`, not `todo`, and its siblings may be half-written. Commit or set aside those
edits — in that worktree, on that task's branch; never dispatch a new wave on a dirty tree. Then re-derive every
task's state from the table's Status tests (plan file? changelog? commit?) — the tree outranks whatever value is
written, so correct the column before acting on it. Then rebuild the **session list** (`manage_todo_list`) from the
corrected column — one entry per task row, `W<wave> · <task id>`, replacing whatever entries are there, including an
empty list. The list is session-scoped and does not survive compaction, so on resume it is always wrong: rebuild it
rather than trusting it. Map each row's Status to a list state — `todo`/`planned`/`vetted` → pending,
`implemented` → in-progress, `done` → complete.

Loop protocol, per WAVE, repeat until `status: done`:
1. Read this file. Take the FIRST wave containing a task whose Status is not `done`. Do not pick, reorder, or
   skip. **Re-entering a half-finished wave resumes at the first incomplete step below — never re-dispatch a step
   whose output already exists** (area already in the Grounding reports table → skip grounding it; plan file
   already present → skip planning it).
2. Verify each task in the wave against the tree. Trust the tree over the task text. Re-check the Owns sets are
   still disjoint — the tree outranks this table.
3. Ground: one `researcher` per area not yet grounded, all in one response, each WRITING
   `docs/roadmap/chatstream-decomposition-ground-<area>.md`. Never ground per task.
4. Plan: dispatch `specify` in CONSUMED MODE to `researcher` (`agentName: "researcher"`) for every todo task in the
   wave that has NO plan file yet, all in one response — marker `SPECIFY CONSUMED MODE`, the task text, its Owns
   set, the grounding FILE PATH (not its contents), and `target: docs/roadmap/chatstream-decomposition-taskNN-<slug>.md`.
   Not capped at 4; planning is read-only.
5. Vet: one `reviewer` per plan file in one response (max 3 rounds each), told to OPEN the files the plan names;
   findings → re-dispatch consumed specify to refine the SAME target.
6. Commit the plan docs yourself, by pathspec — the child is forbidden from committing, so an uncommitted plan gets
   re-planned by the next session. `docs/roadmap/` is gitignored, so this needs `git add -f` with explicit paths.
7. Implement the wave per implement's wave protocol (children commit on their own branch; you integrate their work;
   ≤4 implementers). Width ≥2 forces one worktree + one branch per task; **width 1 is a decision** — see the
   recorded choice beside each wave. In the SAME response, dispatch planning for the NEXT wave's tasks — only for
   areas this wave's implementers do not touch.
8. Integrate the task branches in plan order, then run the gate (full suite once per wave, on the integrated tree).
   Green → mark `done` here → one Changelog line. Red → re-dispatch; never fix by hand in the orchestrator. Remove
   the task worktrees, then delete the task branches (git refuses the reverse order).
9. Update THIS FILE **and the session list** before starting the next wave. Then loop.

## Gate — establish before task 1, re-run after every wave

```
pnpm test          # repo root
pnpm build         # repo root (tsc + vite — this IS the type-check)
```

Baseline measured at `b0071544` (branch base, `main`): `pnpm test` **GREEN** — 157 files, 3318 passed | 1 skipped,
116.9s, exit 0. `pnpm build` **GREEN** — 4.54s, exit 0.

Known flakes on this machine (re-run before investigating, do not "fix" the threshold or the assertion):
`MessageBubble.codeblock.test.tsx`'s `it.each` JSON fence case (shiki async fallback) and
`Reasoning.test.tsx`'s `is O(last line)` wall-clock assertion. Both are load under full-suite pressure.

## Dependency graph / waves

```
Wave 1: A1, A2                (owned file sets disjoint — the only genuinely parallel pair until wave 4)
Wave 2: B1                    (A2's shared fixture module makes the test split cheap; B1 moves attachment tests)
Wave 3: C1                    (needs B1's useChatAttachments boundary — send/flushHead consume the attachment contract)
Wave 4: D1, D2                (DISJOINT by the source/test boundary: D1 owns ChatStream.tsx + the derivations
                               module/hook; D2 owns ChatStream.test.tsx + its new files + the barrel pin)
```

**Wave 4 is width 2 and that was a planning result, not an assumption.** The original D1 owned both hot files, which made wave 4 width 1. Cutting at the source/test boundary made the sets disjoint. Both vets independently verified the two cross-boundary seams: D1 adds no `vi.mock`, so it cannot move the barrel pin D2 edits; D2 moves no source, so D1's rewire cannot break a moved test (the moved blocks drive the component through the DOM and never read `workingOrInTurn`/`composerLocked`/the history slice).

**Wave 4 isolation: both members ISOLATED** — one worktree + branch each, protocol-mandated at width ≥2. Cost measured on this repo: a worktree `pnpm install` is ~7s (pnpm's global store hard-links), so isolation is cheap here — unlike the waves-2–3 case, where the reason to skip it was the *absence of anything to pipeline*, not the install cost.

**Waves 2–4 are width 1 and that is the honest shape of this work — do not re-cut it.** `ChatStream.tsx` is a hot
file for every extraction (no region moves without editing it) and `ChatStream.test.tsx` is hot for every test
move, so any two of B1/C1/D1 sharing a wave would collapse to one member anyway. `draft` is also **jointly owned**
by attachments (marker insert/renumber via `stageFiles`/`removeAttachment`) and dispatch (`send`'s wipe and
catch-shift), so those two domains cannot be disjoint by construction. Recorded at planning time, measured, not
assumed: `send` reads/writes draft AND attachments AND `sendingSessionsRef`/`flushRef`/`heldForSendRef`.

**Merged on purpose (C1):** dispatch core + queue flush + resume are ONE task, not three, on the operator's
instruction. They share `sendingSessionsRef`, `flushRef` and `heldForSendRef`, so they could never have been
siblings; merging costs one `specify` + one implementer instead of three of each. The merged task is at the ceiling
(6 owned files, ~5 steps, one test tree) — do not merge further, and if its implementer compacts mid-task, split it
at the `useChatPromptDispatch` / `usePromptQueueFlusher` file boundary and re-dispatch two halves.

**Grounding was done ALL-UP-FRONT, before any implementation.** All four areas are reported below. This is
deliberate and the reason is recorded so a later iteration does not "optimise" it away: every later wave edits
`ChatStream.tsx`, which is the area every later planner must read, so the usual
"ground the next wave while implementing this one" pipelining is unavailable here — a researcher reading the file
mid-edit would produce a report every later planner then trusts wrongly. Grounding everything first removes the
hazard at zero wave cost.

**Isolation decisions (one per wave, with the cost accepted):**
- **Wave 1 (width 2): isolate both members** — one worktree + one branch each. Protocol-mandated (siblings), cost
  accepted: 2 × `pnpm install` in fresh worktrees.
- **Waves 2–3 (width 1): ran in the PRIMARY tree, unisolated.** There was no planning overlap to buy, because
  the next wave's planner must read `ChatStream.tsx` — the very file the running child was editing. Paying a cold
  dependency install per wave to enable an overlap I must then refuse is the wrong trade. Consequence: no
  pipelining on W2–W3; each wave's planning ran only after the previous wave's gate was green. Both ran this way
  and both gated green.
- **Wave 4 (width 2): isolate both members.** Protocol-mandated (siblings). Measured cost on this repo: a
  worktree `pnpm install` is ~7s because pnpm's global store hard-links, so isolation is nearly free here —
  the waves-2–3 decision rested on "nothing to pipeline", never on install cost.

## Grounding reports

One per code AREA, written once, read by every planner for that area. Re-ground only if the tree moved inside
the area.

| Area | Report | Grounded at |
|---|---|---|
| `chatstream-body` — the whole `ChatStream.tsx` body: hook-ordering/early-return constraint, selectors, refs, effects, the nine seams, `send()`'s ordered flow, governing ADRs | `docs/roadmap/chatstream-decomposition-ground-chatstream-body.md` | `b0071544` |
| `chat-test-scaffolding` — `ChatStream.test.tsx`'s module-level block, the tauri mock shape, store-reset discipline, per-describe ownership map, the removed source-reading pin | `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md` | `b0071544` |
| `attachment-lib` — `lib/chatAttachments` + `lib/chatAttachmentMetadata` APIs, the five handlers, WebKitGTK paste fallback, failed-send restore, URL lifetime contract, hook house style | `docs/roadmap/chatstream-decomposition-ground-attachment-lib.md` | `b0071544` |
| `prompt-queue-stores` — `store/queuedPrompts`, turn lifecycle in `store/sessions`, `useSessionIdleEdge`, `lib/composerCommands`, mention expansion, the IPC surface, the double-send invariant | `docs/roadmap/chatstream-decomposition-ground-prompt-queue-stores.md` | `b0071544` |
| `post-wave1` — DELTA report for waves 2–4: what wave 1 moved out of `ChatStream.tsx`/`ChatStream.test.tsx`, current spans, what stayed byte-identical, the two live traps. Read alongside the area report, not instead of it. | `docs/roadmap/chatstream-decomposition-ground-post-wave1.md` | `27cec040` |
| `post-wave2` — DELTA report for wave 3: the landed `useChatAttachments` boundary (incl. `setError` being an ARGUMENT), the five re-pointed call sites inside `send`, current spans and refs, the one-Set question, `ChatStream.test.tsx`'s 244-test shape and the `sendRelay` harness precedent. | `docs/roadmap/chatstream-decomposition-ground-post-wave2.md` | `0aa99ffb` |

Re-ground with `git log --oneline <commit>..HEAD -- <area paths>`, not a feeling.

## Tasks

| # | Task | Area | Plan file | Wave | Owns (file set — disjointness evidence) | Status |
|---|------|------|-----------|------|------------------------------------------|--------|
| A1 | Pure session derivations → `lib/chatSessionDerivations.ts` + `hooks/useChatSessionDerivations.ts` | `chatstream-body` | `docs/roadmap/chatstream-decomposition-task01-session-derivations.md` | 1 | `src/lib/chatSessionDerivations.ts`, `src/lib/chatSessionDerivations.test.ts`, `src/hooks/useChatSessionDerivations.ts`, `src/hooks/useChatSessionDerivations.test.ts`, `src/components/ChatStream.tsx` | `done` `35d1efaf` |
| A2 | Extract `ChatStream.test.tsx`'s module-level scaffolding → `src/test/chatStreamFixtures.ts` | `chat-test-scaffolding` | `docs/roadmap/chatstream-decomposition-task02-test-fixtures.md` | 1 | `src/test/chatStreamFixtures.ts`, `src/test/chatStreamFixtures.test.ts`, `src/components/ChatStream.test.tsx` | `done` `99166759` |
| B1 | `useChatAttachments` — stageFiles / handlePaste / handleDrop / handleAttachClick / removeAttachment + move its tests | `attachment-lib` | `docs/roadmap/chatstream-decomposition-task03-chat-attachments-hook.md` | 2 | `src/hooks/useChatAttachments.ts`, `src/hooks/useChatAttachments.test.ts`, `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`, `src/lib/tauriBarrel.test.ts` (mock-seam pin update only) | `done` `0aa99ffb` |
| C1 | `useChatPromptDispatch` + `usePromptQueueFlusher` — sendText / send / flushHead / resume + move their tests | `prompt-queue-stores` | `docs/roadmap/chatstream-decomposition-task04-prompt-dispatch-flush.md` | 3 | `src/hooks/useChatPromptDispatch.ts`, `src/hooks/useChatPromptDispatch.test.tsx`, `src/hooks/usePromptQueueFlusher.ts`, `src/hooks/usePromptQueueFlusher.test.tsx`, `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`, `src/lib/tauriBarrel.test.ts` (mock-seam pin update only) | `done` `bab6d68a` |
| D1 | Final derivations — move the `composerLocked` chain + history pagination into the EXISTING pure module/hook | `chatstream-body` | `docs/roadmap/chatstream-decomposition-task05-final-derivations.md` | 4 | `src/components/ChatStream.tsx`, `src/lib/chatSessionDerivations.ts`, `src/lib/chatSessionDerivations.test.ts`, `src/hooks/useChatSessionDerivations.ts`, `src/hooks/useChatSessionDerivations.test.ts` | `vetted` |
| D2 | Split the residual test file by domain (directory completion; child gates) leaving integration wiring | `chat-test-scaffolding` | `docs/roadmap/chatstream-decomposition-task06-split-residual-tests.md` | 4 | `src/components/ChatStream.test.tsx`, `src/components/ChatStreamDirectoryCompletion.test.tsx`, `src/components/ChatStreamChildGates.test.tsx`, `src/lib/tauriBarrel.test.ts` (mock-seam pin update only) | `vetted` |

**Wave 4 was cut in two during planning, and the wave is therefore width 2 — the only reason this run has a second parallel wave.** The original D1 was one task owning `ChatStream.tsx` AND `ChatStream.test.tsx`, which would have made wave 4 width 1. Splitting at the source/test boundary makes the two file sets disjoint: D1 owns the component plus the derivations module/hook, D2 owns the test file plus its new files and the barrel pin. The two vets each independently confirmed the cross-boundary seams are safe: D1 introduces no new `vi.mock`, so it cannot move the barrel pin D2 edits; D2 moves no source, so D1's rewire cannot break a moved test (the moved blocks drive the component through the DOM and never read `workingOrInTurn`/`composerLocked`/the history slice).

**Status is exactly one of these, checkable from the tree without asking anyone:**

| Value | True when |
|---|---|
| `todo` | no plan file at the Plan path |
| `planned` | plan file exists |
| `vetted` | plan file exists **and** a Changelog line records the vet round for it |
| `implemented` | the task's edits exist uncommitted in its worktree, **or** are committed on its task branch but not yet merged into the feature branch |
| `done` `<hash>` | gate green **and** the task's branch is merged into the feature branch — `<hash>` is the **child's own commit**, verify with `git merge-base --is-ancestor <hash> HEAD` |

Write the value only when its test passes — `done` still means the acceptance criterion measured true, not that
steps ran. These are task states, not phase prose: never add a sentence summarising a wave's state, derive it from
the rows.

## Blockers / open questions

Empty.

## Follow-ups to fold into `docs/roadmap/chatstream-decomposition-follow-ups.md` before the final commit

The plan family is DELETED on ship, so anything recorded only in a plan dies. These are the run's known
outstanding items; they are listed here (the surviving file) so `finish` cannot delete them.

1. **Three stale file-name citations created by task06's test split — one micro-commit, prose only.**
   `ChatStream.test.tsx`'s domain blocks move to `ChatStreamDirectoryCompletion.test.tsx` and
   `ChatStreamChildGates.test.tsx`, so every doc that names the OLD file for a moved test becomes a lie.
   Nothing mechanically reads any of them (verified: no test greps these strings), and the mutation-checked
   assertions still run in their new files — so nothing reddens. But a reader following a citation lands on
   the wrong file. The complete set, each verified against the tree:
   - `src/components/ChatStream.tsx`'s picker comment: "Pinned in `ChatStream.test.tsx` at THIS derivation"
     (the `dirPrefix` one-directory-cache pin) → `ChatStreamDirectoryCompletion.test.tsx`.
   - `docs/decisions/0035-out-of-space-completion-is-a-one-directory-peek.md` lines ~30 and ~35: five
     `it(`-title citations, all inside the moved block → same new file.
   - `docs/features/subagent-sessions.md` line ~465: "an Escape INSIDE the inline child card" →
     `ChatStreamChildGates.test.tsx`.
   Why it was deferred rather than done in-wave: `ChatStream.tsx` was owned by task05 and the ADR/features
   files were outside every task's Owns set, so no wave member could legitimately touch them.

## Decisions log

- **2026-11-01** — `<feature>` = `chatstream-decomposition`, taken from the branch topic `feature/chatstream-decomposition` (issue id deliberately NOT in the name, so the branch topic and the `finish` deletion family agree).
- **2026-11-01** — `draft` stays owned by the orchestrator; extracted hooks take it as an argument. Evidence: `stageFiles` and `removeAttachment` write it (marker insert / renumber) and `send` writes it (wipe / catch-shift), so no single hook can own it. House precedent already exists: `useMentionPicker`'s own comment says the hook never owns the draft.
- **2026-11-01** — Merged dispatch core + queue flush + resume into one task (C1) on the operator's instruction, over the 6-task cut originally presented. Recorded cost accepted: one implementer moves ~480 source + ~850 test lines; ceiling is 6 files / ~5 steps / one test tree, and C1 sits at it. Split trigger: if C1's implementer compacts mid-task, split at the `useChatPromptDispatch` / `usePromptQueueFlusher` boundary and re-dispatch two halves — do not re-run the same oversized dispatch.
- **2026-11-01** — Grounded all four areas up front rather than pipelining per wave; see the reason in the waves section. The pipelining win is unavailable on a chain whose every wave edits the file the next planner reads.
- **2026-11-01** — Width-1 waves (2–4) run unisolated in the primary tree; Wave 1 isolates both members. Costs recorded beside the waves.
- **2026-11-01** — The issue's §1/§2/§3/§4 read as four parallel extractions and are not: `ChatStream.tsx` is hot for all four. Decomposing by the issue's sections would have produced a chain of serial waves with a plan+implement round-trip each. Cutting by owned file set instead yields one real parallel pair (A1/A2) and a 3-deep chain, 5 dispatches total.
- **2026-11-01** — Behaviour is MOVED, not improved. Any deliberate behaviour change found necessary during implementation gets its own commit and is recorded here with its evidence before it lands.
- **2026-11-01** — **A2's shape is constrained by measurement, not preference — and the first version of this note was WRONG, so the full probe matrix is recorded.** `vi.mock` hoists per module. Probes on this tree (vitest 5.0.0), all run and kept-then-deleted:

  | Factory location | Helper module | Import order | Result |
  |---|---|---|---|
  | `vi.mock` CALL inside an imported module | — | — | ❌ transform refuses to rewrite it |
  | test file, delegates to helper | helper imports the mocked module directly | helper **after** target | ❌ `Cannot access '__vi_import_N__' before initialization` |
  | test file, delegates to helper | helper reaches it **transitively via a store** | helper after target | ❌ same error — **the store path does not save you** |
  | test file, delegates to helper | helper clean (no path to mocked module) | helper **before** target | ✅ |
  | test file, delegates to helper | helper clean (no path to mocked module) | helper **after** target | ❌ same error |
  | **factory stays INLINE in the test file** (references only `vi`), seeds move to a module that reaches the mocked module via a store | — | target first | ✅ |

  So the general rule is: a `vi.mock` factory may reference only bindings from a module that is BOTH free of any transitive import of the mocked specifier **and** imported before anything that imports it. Two conditions, both silent, both order-fragile, both failing as **0 tests run** rather than a red assertion. **Chosen shape: keep both `vi.mock` calls AND their factory bodies inline in `ChatStream.test.tsx`** — measured reason: the tauri factory body references only `vi.importActual` and no module-scope binding, so moving it buys nothing and costs the ordering constraint above. Move the seeds, interaction helpers and constants; leave the mocks. Recorded because "extract the test scaffolding" naturally reads as "move the mocks too", and that shape fails with no tests running and a message that points at the wrong file.
- **2026-11-01** — Cross-file guards the extraction can trip, found by reading the scanners rather than assuming: `tauriBarrel.test.ts`'s `it("the scanner sees the mock seam it exists to protect")` pins the SET of `.test.ts` files under `src/` that `vi.mock` the tauri barrel by path (and how many spread `importActual`) — the count lives in that assertion, read it there, never copy it here. **Consequence for A2:** keeping the `vi.mock` call in `ChatStream.test.tsx` leaves the set unchanged (and the non-`.test` fixtures module is never counted regardless of its contents, because the filter requires `\.test\.tsx?$`). **Consequence for B1/C1:** every NEW hook test file that mocks the barrel by path grows the set, so that assertion must be updated in the same commit and its provenance comment extended. Also cleared, by reading the source: `classNameConvention.test.ts` and `paletteCompleteness.test.ts` both sweep every `.tsx` under `src/` recursively (the second includes test files on purpose), but `ChatStream.tsx` appears in neither as an allowlist literal — only in prose — so moving code out cannot trip them. `src/test/fixtures/` is a directory barrel (`index.ts`); `src/test/` itself has no barrel, so a new module there registers nothing.
- **2026-11-01** — Vetting caught a false premise in BOTH the plan and the reviewer, which is why the orchestrator re-measures. Task01 originally left `imageCapable` in the component on the grounds that "`activeCapabilities` must stay selected for the `imageCapable` consumers" — circular, since `canResume` (the other consumer) was already being moved; and it cited `send`'s post-resume `hasImages` as a consumer of `activeCapabilities`, which it is not (`send` re-reads a FRESH value via `useSessions.getState().sessions.find(...)`). Measured: `activeCapabilities` has exactly two consumers, both moving, so the selector and its three-list-walk comment leave `ChatStream.tsx` entirely, and `imageCapable` moves with them. Lesson recorded for the remaining waves: **a "this must stay because something else consumes it" argument is only valid if that something else actually stays** — check the consumer list with a grep, not from the prose.
- **2026-11-01** — A refine child corrected two claims in MY OWN dispatch text (`imageCapable` has 6 consumers, not "the queue-row render" — `QueueRows.tsx`/`QueueRow.tsx` read it zero times; and only THREE handlers gate on it, not five). Independent check against the tree agreed. Recorded so the loop does not over-trust orchestrator-supplied evidence in either direction.

## Changelog

One line per task: hash, what shipped, gate numbers at that moment.

### Wave 1 — implemented and gated 2026-11-01

Integrated-tree gate (the measurement that describes what was merged, run after the fan-in at `27cec040`):
`pnpm test` → **160 files, 3353 passed | 1 skipped**, exit 0. `pnpm build` → exit 0. Arithmetic reconciles
exactly: baseline 3318 + task01's 28 + task02's 7 = 3353, so nothing was lost and nothing was silently skipped.
`npx vitest run src/components/ChatStream.test.tsx` on the integrated tree → **278**, unchanged from baseline —
this is the check no child could run, because task01 changed what that file mounts while task02 changed the seeds
it uses.

- **A1 `done` `35d1efaf`** — `lib/chatSessionDerivations.ts` (5 pure fns) + `hooks/useChatSessionDerivations.ts`.
  Acceptance measured on the integrated tree: `grep -c activeCapabilities src/components/ChatStream.tsx` → **0**
  and `grep -c sessionFieldOf` → **0** (both selectors and the now-dead import gone, as the refined plan requires);
  the hook is consumed at the top of the component body, above the early return; `imageCapable` moved.
- **A2 `done` `99166759`** — `src/test/chatStreamFixtures.ts` (14 symbols: 3 constants, 6 seeds, 5 interaction
  helpers) + a 7-test seam file; `ChatStream.test.tsx` −247/+35. Both `vi.mock` calls and both factory bodies
  stayed inline as the probe matrix forced (`createTauriMock`/`createDialogMock` exist nowhere in `src/`); the
  tauriBarrel mock-set pin did **not** move, because the new `.test.ts` files mock nothing.

Two forced deviations from the plans, both recorded by the implementer and accepted:
- task02's seam test used `tauriBarrel.test.ts`'s repo-relative `node:fs` convention instead of
  `fileURLToPath(new URL(…, import.meta.url))` — the latter throws `URL must be of scheme file` under jsdom.
  This was the plan's own named fallback.
- task02 changed 19 `waitForCatalog()` call sites to `waitForCatalog(listSkills)`. The plan claimed "no test-body
  call changes" while mandating `listSkills` as a **required** parameter — an internal contradiction the plan's
  author did not catch; `tsc` reported exactly 19 × `TS2554` and nothing else. The implementer kept the mandated
  signature (an optional param would make `vi.mocked(undefined)` fail at runtime in 19 tests). **Plan-authoring
  lesson for waves 2–4: if a plan moves a function and adds a required parameter, the call sites are in scope by
  definition — say so in the plan instead of promising zero call-site churn.**

Also noted: the wave protocol says the orchestrator commits the plan docs and the child commits its code; task01's
child flagged an apparent conflict with its dispatch text and resolved it correctly (it committed its own code on
its own branch, which is what the wave protocol wants). No correction needed — the dispatch was right, the plan's
"orchestrator commits" line refers to the PLAN DOCS only.

### Wave 2 — implemented and gated 2026-11-01 (width 1, **unisolated in the primary tree**, per the recorded decision)

Gate on the integrated tree (my own re-run at `0aa99ffb`, not the child's numbers): `pnpm test` → **161 files,
3354 passed | 1 skipped**, exit 0. `pnpm build` → exit 0. Matches the plan's corrected count gate exactly.

- **B1 `done` `0aa99ffb`** — `hooks/useChatAttachments.ts` (539 lines, 12-name surface incl. the non-revoking
  `clearStaged()`) + `hooks/useChatAttachments.test.tsx` (35 tests). `ChatStream.tsx` **1488 → 1206** lines;
  `ChatStream.test.tsx` 7673 → 7140. Acceptance measured on the tree: all six WebKitGTK clipboard-fallback pins
  plus the session-straddle test are present in the new test file; the locked-composer fork contains **zero**
  `revokeObjectURL`/`releaseAttachment` calls (ADR 0069's "never revoke here" contract intact); the tauri-barrel
  mock-seam pin moved by exactly one mocker + one spreader and its provenance comment names the new `.tsx`.

Three deviations the implementer forced and I accepted, each verified on the tree:
1. **`setError` added as a hook argument** — the plan's `UseChatAttachmentsArgs` omitted it, but `stageFiles`,
   `handleAttachClick` and the restore path call `setError` (3 sites) while `ChatStream` keeps owning `error`.
   A pinned signature changed because the plan's was unimplementable; recorded here so wave 3's planner reads the
   REAL signature off the file, not the plan's.
2. **`stageFiles` not destructured in `ChatStream`** — its only callers moved with it, so `noUnusedLocals`
   rejected the binding. The hook still returns it; the 12-name surface pin is green.
3. **`grep "setAttachments([])" ChatStream.tsx` → 0**, not the 1 the acceptance criterion asked for — §B3 moved
   the session-switch clear into `clearAll()`, so no direct staged write survives in the component. Stricter than
   required, and the right direction.

Formatting note for later waves: `npx prettier --check` flags files at HEAD (`ChatStream.tsx`,
`useMentionPicker.ts`, `useDragReorder.test.tsx`) — there is no prettier config or format script and prettier is
NOT this repo's gate (AGENTS.md's bar is `pnpm test` + `pnpm build`). Do not reformat verbatim bodies to satisfy it.

### Plan vet round (Wave 3)

- **C1 — vetted 2026-11-01, 1 round, PASS with no BLOCKING findings.** The three findings that could have shipped a live bug were traced rather than accepted: the **one-Set invariant** (exactly one `useRef<Set<string>>` in `src/` today; every `.has`/`.add`/`.delete` in `send` and `flushHead` served by the single instance the component declares and passes down; every post-claim `return` inside the `try` so the `finally` releases — no leak path, and the locked-composer fork's returns are all claim-free because the fork sits before the claim); **`send()`'s order** (12 steps reproduced verbatim, including `/compact` inside the `try` but before the `!isLive` auto-resume); and **`flushRef` across the split** (the ref stays a component declaration, the flusher assigns `.current` at render phase — the house precedent is `attachmentsRef.current = attachments` — and `onIdle: () => flushRef.current()` reads at call time, so no stale window exists). Barrel arithmetic re-derived independently at 39 mockers / 38 spreaders → 41 / 40 after two new `importActual`-spreading mockers. Non-blocking: two line-range tails in §4's table overstate by ~14 lines (symbol anchoring makes it harmless), and §5's "two placements that stay" is accurate but un-itemised.
- **Ceiling, recorded rather than argued away:** C1 is 9 steps / 7 owned files / ~480 source + ~850 test lines — at the ceiling, deliberately merged (the two hooks share the Set and the flusher consumes `sendText`). The vet judged the safer split **layer-wise** (hook code + surface pins, then component rewire + 29-test move + barrel pin) rather than at the hook-file boundary. Trigger to split: if the implementer compacts mid-task, do NOT re-run the same oversized dispatch — split layer-wise and re-dispatch two halves.

### Wave 3 — implemented and gated 2026-11-01 (width 1, **unisolated in the primary tree**, per the recorded decision)

Gate on the integrated tree, measured by the orchestrator at `bab6d68a`: `pnpm test` → **163 files, 3356 passed |
1 skipped**, exit 0. `pnpm build` → exit 0.

**The first full-suite run was RED and the RED was correct to chase.** One failure:
`MessageBubble.codeblock.test.tsx`'s `renders a \`python\` fence genuinely highlighted` — shiki's async
unhighlighted fallback, one of the two flakes AGENTS.md records for this box. Three independent facts settled it
before any code was touched: the file is **not in wave 3's diff** (`git diff --name-only 0aa99ffb..HEAD` has zero
`MessageBubble` hits); the file **passes in isolation** (25/25); and the arithmetic proved nothing was lost —
3355 passed + 1 failed + 1 skipped = **3357 total**, exactly the expected 3356 | 1. Re-ran per the repo rule
("re-run before investigating, do not loosen the assertion"); green. A second recorded flake,
`Reasoning.test.tsx`'s `is O(last line)`, did not fire.

- **C1 `done` `bab6d68a`** — `hooks/useChatPromptDispatch.ts` (595) + `hooks/usePromptQueueFlusher.ts` (205) and
  their `.test.tsx` files (17 + 14 tests). `ChatStream.tsx` **1206 → 704**; `ChatStream.test.tsx` 7140 → 6286.
  All three live-bug traps re-verified by the orchestrator on the tree, not taken from the child's report:
  **one Set** (`grep -rn "useRef<Set<string>>"` across the component + both hooks → exactly one hit, the
  component's); **`send()`'s order** preserved with the claim at the `has`/`add` pair immediately before the
  `try`, the locked fork before it, and `/compact` inside the `try` before the `!isLive` resume; **`flushRef`**
  declared in the component and assigned by the flusher, `onIdle: () => flushRef.current()` still in the
  component. `heldForSendRef` is re-owned by neither file (its one hit in the dispatch hook is a comment).

Four deviations, all compiler-arbitrated and accepted: `import * as chatAttachments` and `within` left
`ChatStream.test.tsx` (their only consumers were inside the moved Flush group — the plan predicted the spy would
stay, and was wrong); the five store-action selector locals left the component (each hook now pulls its own);
`useRef` dropped from the dispatch hook's react import (the Set is an argument).

### Plan vet rounds (Wave 4)

- **D1 (task05) — vetted 2026-11-01, 2 rounds, PASS no BLOCKING.** The `composerLocked` chain was enumerated independently by the vet: all seven consumers served (`useSpinQuip`, the definition, `useChatPromptDispatch`'s arg, `useSessionIdleEdge`'s `busy:`, and three JSX props), and the ordering claim confirmed on the file — the derivations hook's destructure closes at ~81, `useSpinQuip(workingOrInTurn)` is at ~177, the early return at ~553, so a hook-returned value is in scope with no TDZ. The picker/`hasImages`/`units` refusals verified as recorded decisions, not laziness (the `dirPrefix` one is mutation-checked). Round 1's Major was **test over-generation: 16 new tests for two small derivations**, trimmed to 12 with N and every sum updated together (3356 + 12 = 3368), justified against this repo's own "prefer the cheap, correct-enough fix" rule and the "pay any cost to satisfy a criterion exactly" anti-pattern. Its Minor was a **half-recorded refusal**: wave 1's original text named three consumers (`useSpinQuip`, `useSessionIdleEdge`, **and `send`'s queue-fork**), and since D1's whole justification is "that reason has landed", all three legs had to be squared — the third is now C1-internal (`useChatPromptDispatch.ts`'s `if (composerLocked)` arm), an argument read, not a hook return.
- **D2 (task06) — vetted 2026-11-01, 2 rounds, PASS no BLOCKING.** The vet independently confirmed the split's premise: the module scaffold (~140 lines: `beforeAll`, both inline `vi.mock` factories, the module `beforeEach`) **cannot** be shared across files — probe rows 1 and 3 forbid it, and `chatStreamFixtures.ts` is itself the measured row-3 case. So the cost model is real and the 34+16-moved / 13-left ratio judgement is defensible. Both direction-specific helper cross-reference lists came back **empty**, and the order-dependence analysis shows the split REMOVES an in-file order dependence (block 2's persistent catalog leak) rather than introducing one — no silent behaviour change. Barrel arithmetic re-derived 41/40 → 43/42. Round 1's two Majors: a **missing `useInteractive` import** that would have reddened `tsc`, and a **durability gap** — the plan recorded the stale-citation follow-up only in itself, and the plan family is deleted on ship. Round 2 corrected the vet's own count error (the vet conflated §2's directory-completion block, which has ZERO direct store reads, with §3's child-gate blocks, which read `useInteractive` 12× / `useSubagents` 11× / `useSessions` 4× / `usePermissions` 2× — all four re-derived by grep against the tree and matching the file), and surfaced a **second stale citation the vet had missed**: `docs/decisions/0035-…` cites five `it(` titles "in `ChatStream.test.tsx`" and `docs/features/subagent-sessions.md:465` cites one, all inside blocks this plan moves. The orchestrator closed the durability gap by moving the follow-up into the status file's own section, since `finish` deletes the plan.

### Plan vet rounds (Wave 1)

- **A1 — vetted 2026-11-01, 2 rounds.** Round 1 returned "pass with issues" but its central justification was FALSE on the tree: it cleared leaving `imageCapable` in the component by claiming `activeCapabilities` must stay selected for other consumers, while the plan was already moving those consumers. Orchestrator re-measured (`grep -n 'activeCapabilities'` → 3 hits: declaration + `imageCapable` + `canResume`, both consumers moving) and re-dispatched to refine. Round 2 (the refine) additionally caught a dead-import consequence neither the plan nor the vet had: with both `activeCapabilities` and `activeSessionIsKnown` selectors deleted, `sessionFieldOf`'s import becomes dead and `noUnusedLocals` reddens `pnpm build` — orchestrator confirmed independently (`grep -n 'sessionFieldOf'` → import + exactly the two deleted selector bodies). Net scope change: `imageCapable` now MOVES and the `activeCapabilities` selector + its three-list-walk comment leave `ChatStream.tsx` entirely. Open items from the vet are all closed by the orchestrator: prop types confirmed compatible (`MessageList` takes `InteractiveRequestData[]`/`{path,patch}[]`, `ComposerRow` takes `boolean`, `ComposerModals` takes `InteractiveRequestData[]`), `archivedSessions: []` confirmed, `SessionInfo` confirmed in the barrel's pinned API.
- **A2 — FAILED round 1, rewritten, PASS round 2.** Round 1 proved the plan's mechanism (move both `vi.mock` factory bodies to the fixtures module, leave delegating calls in the test file) yields `Cannot access '__vi_import_N__' before initialization` → **0 tests run**. Orchestrator ran its own probe matrix (6 shapes) and found the rule is narrower than the vet stated: the provider module must have NO transitive path to the mocked specifier AND be imported before anything that imports it; a store-mediated path fails identically (`src/store/settings.ts` imports the barrel). Chosen shape: factories stay fully INLINE (measured self-contained — the tauri body's only free identifiers are `vi` and its local `actual`), seeds/helpers/constants move. Round 2 verdict PASS with no Critical/Major: 19 `waitForCatalog` call sites all inside `it` bodies so parameter injection is safe; the 14-name move list is provably complete; byte-identity gate executable (one caveat — `deferred`'s signature opens a brace, so brace-depth counting, not `/^}/`).
