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
Wave 1: A1, A2                (owned file sets disjoint — the only genuinely parallel pair in the block)
Wave 2: B1                    (A2's shared fixture module makes the test split cheap; B1 moves attachment tests)
Wave 3: C1                    (needs B1's useChatAttachments boundary — send/flushHead consume the attachment contract)
Wave 4: D1                    (needs B1 + C1's hooks to exist; reduces the orchestrator and the residual test file)
```

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
- **Waves 2–4 (width 1): run in the PRIMARY tree, unisolated.** There is no planning overlap to buy, because the
  next wave's planner must read `ChatStream.tsx` — the very file the running child is editing. Paying a cold
  dependency install per wave to enable an overlap I must then refuse is the wrong trade. Consequence: no
  pipelining on W2–W4; plan wave N+1 only after wave N's gate is green.

## Grounding reports

One per code AREA, written once, read by every planner for that area. Re-ground only if the tree moved inside
the area.

| Area | Report | Grounded at |
|---|---|---|
| `chatstream-body` — the whole `ChatStream.tsx` body: hook-ordering/early-return constraint, selectors, refs, effects, the nine seams, `send()`'s ordered flow, governing ADRs | `docs/roadmap/chatstream-decomposition-ground-chatstream-body.md` | `b0071544` |
| `chat-test-scaffolding` — `ChatStream.test.tsx`'s module-level block, the tauri mock shape, store-reset discipline, per-describe ownership map, the removed source-reading pin | `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md` | `b0071544` |
| `attachment-lib` — `lib/chatAttachments` + `lib/chatAttachmentMetadata` APIs, the five handlers, WebKitGTK paste fallback, failed-send restore, URL lifetime contract, hook house style | `docs/roadmap/chatstream-decomposition-ground-attachment-lib.md` | `b0071544` |
| `prompt-queue-stores` — `store/queuedPrompts`, turn lifecycle in `store/sessions`, `useSessionIdleEdge`, `lib/composerCommands`, mention expansion, the IPC surface, the double-send invariant | `docs/roadmap/chatstream-decomposition-ground-prompt-queue-stores.md` | `b0071544` |

Re-ground with `git log --oneline <commit>..HEAD -- <area paths>`, not a feeling.

## Tasks

| # | Task | Area | Plan file | Wave | Owns (file set — disjointness evidence) | Status |
|---|------|------|-----------|------|------------------------------------------|--------|
| A1 | Pure session derivations → `lib/chatSessionDerivations.ts` + `hooks/useChatSessionDerivations.ts` | `chatstream-body` | `docs/roadmap/chatstream-decomposition-task01-session-derivations.md` | 1 | `src/lib/chatSessionDerivations.ts`, `src/lib/chatSessionDerivations.test.ts`, `src/hooks/useChatSessionDerivations.ts`, `src/hooks/useChatSessionDerivations.test.ts`, `src/components/ChatStream.tsx` | `todo` |
| A2 | Extract `ChatStream.test.tsx`'s module-level scaffolding → `src/test/chatStreamFixtures.ts` | `chat-test-scaffolding` | `docs/roadmap/chatstream-decomposition-task02-test-fixtures.md` | 1 | `src/test/chatStreamFixtures.ts`, `src/test/chatStreamFixtures.test.ts`, `src/components/ChatStream.test.tsx` | `todo` |
| B1 | `useChatAttachments` — stageFiles / handlePaste / handleDrop / handleAttachClick / removeAttachment + move its tests | `attachment-lib` | `docs/roadmap/chatstream-decomposition-task03-chat-attachments-hook.md` | 2 | `src/hooks/useChatAttachments.ts`, `src/hooks/useChatAttachments.test.ts`, `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx` | `todo` |
| C1 | `useChatPromptDispatch` + `usePromptQueueFlusher` — sendText / send / flushHead / resume + move their tests | `prompt-queue-stores` | `docs/roadmap/chatstream-decomposition-task04-prompt-dispatch-flush.md` | 3 | `src/hooks/useChatPromptDispatch.ts`, `src/hooks/useChatPromptDispatch.test.ts`, `src/hooks/usePromptQueueFlusher.ts`, `src/hooks/usePromptQueueFlusher.test.ts`, `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx` | `todo` |
| D1 | Orchestrator final form + reduce the test file to integration wiring + measure the acceptance criteria | `chatstream-body` | `docs/roadmap/chatstream-decomposition-task05-orchestrator-final-form.md` | 4 | `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`, plus any residual `src/components/chat/*` test file the split leaves | `todo` |

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

## Decisions log

- **2026-11-01** — `<feature>` = `chatstream-decomposition`, taken from the branch topic `feature/chatstream-decomposition` (issue id deliberately NOT in the name, so the branch topic and the `finish` deletion family agree).
- **2026-11-01** — `draft` stays owned by the orchestrator; extracted hooks take it as an argument. Evidence: `stageFiles` and `removeAttachment` write it (marker insert / renumber) and `send` writes it (wipe / catch-shift), so no single hook can own it. House precedent already exists: `useMentionPicker`'s own comment says the hook never owns the draft.
- **2026-11-01** — Merged dispatch core + queue flush + resume into one task (C1) on the operator's instruction, over the 6-task cut originally presented. Recorded cost accepted: one implementer moves ~480 source + ~850 test lines; ceiling is 6 files / ~5 steps / one test tree, and C1 sits at it. Split trigger: if C1's implementer compacts mid-task, split at the `useChatPromptDispatch` / `usePromptQueueFlusher` boundary and re-dispatch two halves — do not re-run the same oversized dispatch.
- **2026-11-01** — Grounded all four areas up front rather than pipelining per wave; see the reason in the waves section. The pipelining win is unavailable on a chain whose every wave edits the file the next planner reads.
- **2026-11-01** — Width-1 waves (2–4) run unisolated in the primary tree; Wave 1 isolates both members. Costs recorded beside the waves.
- **2026-11-01** — The issue's §1/§2/§3/§4 read as four parallel extractions and are not: `ChatStream.tsx` is hot for all four. Decomposing by the issue's sections would have produced a chain of serial waves with a plan+implement round-trip each. Cutting by owned file set instead yields one real parallel pair (A1/A2) and a 3-deep chain, 5 dispatches total.
- **2026-11-01** — Behaviour is MOVED, not improved. Any deliberate behaviour change found necessary during implementation gets its own commit and is recorded here with its evidence before it lands.

## Changelog

One line per task: hash, what shipped, gate numbers at that moment.
