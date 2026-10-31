---
status: running
mode: autonomous
updated: 2026-10-31
---

# macOS CI flakes (#139, #138) — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Make the two macOS-only `macos-latest` CI flakes stop reddening jobs, each with a test that pins the fix,
and correct the durable doc that misdescribes one of them. Source: GitHub issues
[#139](https://github.com/danielcherubini/archimedes/issues/139) (temp-dir census guard reddened by a
dot-free external daemon dir; §9a's preferred option (b) is already implemented) and
[#138](https://github.com/danielcherubini/archimedes/issues/138) (`subagent_dispatch_end_to_end_real_workers`
reads the child transcript un-pollled). Finished means: both fixes merged on `feature/macos-ci-flakes`,
the full gate green on the integrated tree, `docs/features/issue-96-temp-dir-known-gaps.md` §9a corrected,
and the durable residue folded before `finish` deletes this family.

## Operating mode

Autonomous — the entry confirmation was given 2026-10-31. No questions until the `review` / `finish`
shipping gates.

**On every resume, before dispatching anything:** run `git status --porcelain` **and `git worktree list`.** A wave
child's edits land in its own worktree, so a clean primary tree proves nothing — an `*-taskNN` worktree left over
from a dead iteration means that task died **mid-implementation**: check `git -C <worktree> status --porcelain` for
each one. Such a task is `implemented`, not `todo`, and its siblings may be half-written. Commit or set aside those
edits — in that worktree, on that task's branch; never dispatch a new wave on a dirty tree. Then re-derive every
task's state from the table's Status tests (plan file? changelog? commit?) — the tree outranks whatever value is
written, so correct the column before acting on it. Then rebuild the **session list** (`manage_todo_list`) from the
corrected column — one entry per task row, `W<wave> · <task id>`, replacing whatever entries are there, including an
empty list. Map each row's Status to a list state — `todo`/`planned`/`vetted` → pending, `implemented` →
in-progress, `done` → complete.

Loop protocol, per WAVE, repeat until `status: done`:
1. Read this file. Take the FIRST wave containing a task whose Status is not `done`. Do not pick, reorder, or
   skip. Re-entering a half-finished wave resumes at the first incomplete step below — never re-dispatch a step
   whose output already exists (area already in the Grounding reports table → skip grounding it; plan file already
   present → skip planning it).
2. Verify each task in the wave against the tree. Trust the tree over the task text. Re-check the Owns sets are
   still disjoint.
3. Ground: one `researcher` per area not yet grounded, all in one response, each WRITING
   `docs/roadmap/macos-ci-flakes-ground-<area>.md`.
4. Plan: dispatch `specify` in CONSUMED MODE to `researcher` (`agentName: "researcher"`) for every todo task in the
   wave that has NO plan file yet, all in one response — marker `SPECIFY CONSUMED MODE`, the task text, its Owns
   set, the grounding FILE PATH (not its contents), and `target: docs/roadmap/macos-ci-flakes-taskNN-<slug>.md`.
   Not capped at 4; planning is read-only.
5. Vet: one `reviewer` per plan file in one response (max 3 rounds each), told to OPEN the files the plan names;
   findings → re-dispatch consumed specify to refine the SAME target.
6. Commit the plan docs yourself, by pathspec — the child is forbidden from committing.
7. Implement the wave per implement's wave protocol (children commit on their own branch; you integrate their
   work; ≤4 implementers).
8. Integrate the task branches in plan order, then run the gate (full suite once per wave, on the integrated
   tree). Green → mark `done` → one Changelog line. Red → re-dispatch; never fix by hand in the orchestrator.
   Remove the task worktrees, then delete the task branches.
9. Update THIS FILE **and the session list** before starting the next wave. Then loop.

## Gate — establish before task 1, re-run after every wave

From the repo root:

    pnpm test
    pnpm build
    bash scripts/check-temp-dir-census.test.sh

From `src-tauri/`:

    cargo build --all-targets     # rebuilds fake_worker — a stale binary makes manager::tests lie
    cargo test
    cargo clippy --all-targets    # must be 0 warnings
    cargo fmt --check

Baseline measured at `60470d2` (branch base, == `main` tip, clean tree): **all seven legs green.**
`pnpm test` 157 files / 3318 passed + 1 skipped · `pnpm build` ok · census self-test `all checks passed` ·
`cargo test` 1652 passed / 0 failed / 1 ignored in the lib plus every integration suite green ·
`cargo clippy --all-targets` 0 warnings · `cargo fmt --check` clean. These figures are historical for the
branch tip — re-measure, do not copy.

**Neither flake reproduces locally.** #139 needs a macOS daemon to create `betaenrollmentagent` in the
per-user `TMPDIR`; #138 is a cross-process SQLite visibility race that passed in the sibling job of the same
SHA. Both are proven locally only by the tests each task adds (the census self-test for A1; a compile-level
+ `--ignored`/targeted run for A2) plus the CI legs. Do not describe either as behaviourally verified from
this machine — per `AGENTS.md`, macOS behaviour is unverifiable here.

## Dependency graph / waves

    Wave 1: A1, A2   (owned file sets disjoint — scripts/ + docs/features/ vs src-tauri/tests/;
                      no symbol crosses them)
    Wave 2: none — nothing consumes the other's output.

Width-1/2 isolation decision, recorded so the next iteration does not silently flip it: **Wave 1 has width 2 →
one worktree + one branch per task** (`../archimedes-desktop-feature-macos-ci-flakes-task01` on
`feature/macos-ci-flakes-task01`, `…-task02` on `…-task02`). No pipelining this wave: there is no Wave 2 whose
planners could overlap the implementers.

## Grounding reports

| Area | Report | Grounded at |
|---|---|---|
| temp-dir-census | `docs/roadmap/macos-ci-flakes-ground-temp-dir-census.md` | `60470d2` |
| worker-e2e | `docs/roadmap/macos-ci-flakes-ground-worker-e2e.md` | `60470d2` |

## Tasks

| # | Task | Area | Plan file | Wave | Owns (file set — disjointness evidence) | Status |
|---|------|------|-----------|------|------------------------------------------|--------|
| A1 | Extend the Darwin temp-dir exclusion to a second shape that cannot match an Archimedes minter prefix, re-pin the self-test's no-dot invariant case (18c) to cover it, and correct §9a (option (b) is already implemented; add the second `betaenrollmentagent` occurrence) — #139 | temp-dir-census | `docs/roadmap/macos-ci-flakes-task01-census-darwin-shape.md` | 1 | `scripts/check-temp-dir-census.sh`, `scripts/check-temp-dir-census.test.sh`, `docs/features/issue-96-temp-dir-known-gaps.md` | `todo` |
| A2 | Route the un-pollled child-transcript row-count read in `subagent_dispatch_end_to_end_real_workers` through the file's existing `wait_for_rows` helper, keeping the exact-count assert so a genuinely missing row still fails on timeout — #138 | worker-e2e | `docs/roadmap/macos-ci-flakes-task02-poll-child-transcript-read.md` | 1 | `src-tauri/tests/worker_e2e.rs` | `todo` |

**Constraint on A1 that outranks any plan's preference:** do **not** widen the tolerance table. §9a states the
rule verbatim — tolerances are earned by measurement of *our* leak, and a `betaenrollmentagent*` row would let a
real leak hide behind a system daemon forever. The fix is the exclusion *shape*, not a tolerance row.

## Blockers / open questions

Empty.

## Decisions log

- 2026-10-31 — Entry is `check-issue` triage, not `discuss`/`research`/`codebase-improvement`: there is no spec
  doc and no `issue:` key, so there is **nothing to mirror the task breakdown to** (the issues *are* the work
  items, one per task). No tracker writes of any kind.
- 2026-10-31 — `<feature> = macos-ci-flakes` = the branch topic. Both issues feed one branch → one PR.
- 2026-10-31 — Two tasks, not one-per-finding-plus-doc: #139's code fix and its two §9a doc corrections are one
  task, because the doc and the script change together and splitting them would put `docs/features/…known-gaps.md`
  in a second task with nothing to test.
- 2026-10-31 — Gate measured green at `60470d2` before any task, including the census self-test (the local proof
  A1 must keep green) and `cargo build --all-targets` first, to rebuild `fake_worker`.

## Changelog

(empty — no task has shipped)
