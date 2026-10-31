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
| A1 | Extend the Darwin temp-dir exclusion to a second shape that cannot match an Archimedes minter prefix, re-pin the self-test's no-dot invariant case (18c) to cover it, and correct §9a (option (b) is already implemented; add the second `betaenrollmentagent` occurrence) — #139 | temp-dir-census | `docs/roadmap/macos-ci-flakes-task01-census-darwin-shape.md` | 1 | `scripts/check-temp-dir-census.sh`, `scripts/check-temp-dir-census.test.sh`, `docs/features/issue-96-temp-dir-known-gaps.md` | `done` `c419e1f` |
| A2 | Route the un-pollled child-transcript row-count read in `subagent_dispatch_end_to_end_real_workers` through the file's existing `wait_for_rows` helper, keeping the exact-count assert so a genuinely missing row still fails on timeout — #138 | worker-e2e | `docs/roadmap/macos-ci-flakes-task02-poll-child-transcript-read.md` | 1 | `src-tauri/tests/worker_e2e.rs` | `done` `570b465` |

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

### Wave 1 gate and task rows

**Wave 1 gate, integrated tree at `90cce0d`** (fan-in of `c419e1f` + `570b465`; disjoint ownership confirmed by
`comm -12` on the two `git diff --name-only` lists → zero overlap, `merge-tree --write-tree` exit 0):
census self-test `all checks passed` · script `--self-test` `all cases behaved (the guard has teeth)` ·
`bash -n` both scripts clean · `ci.yml` byte-identical to `60470d2` · `cargo build --all-targets` ok ·
`cargo test` **1652 passed / 0 failed / 1 ignored** (lib) and **`worker_e2e` 7 passed / 0 failed** (was 6 —
the guard is a new test, named in output) · `cargo clippy --all-targets` 0 warnings **and** the CI form
`-- -D warnings` exit 0 · `cargo fmt --check` and `--all` clean · `pnpm test` **157 files / 3318 passed /
1 skipped** (identical to baseline) · `pnpm build` ok.

- **A1 `done` `c419e1f`** — `dash_free_name()` (`[[ "$1" != *-* ]]`) added beside `dotted_name()`, Darwin-only,
  message token `dotted-name` → `shape-mismatched` across all five pins, new cases **18d** (plants
  `betaenrollmentagent` on injected Darwin → exit 0 + `excluded: 1 shape-mismatched dir(s)`) and **19**
  (the guard's teeth: an injected dash-free literal in a synthetic corpus must trip FAIL), **18c** re-expressed
  pipe-safe and **18c(2)** added as the no-dash twin. Tolerance table untouched (still the one
  `harness-subagent-<TAB>1` row). Gate at that moment: `all checks passed` / `all cases behaved`.
- **A2 `done` `570b465`** — the child read is now `wait_for_rows(&h.db, &child_id, 3).await` with the exact-count
  assert kept verbatim, plus guard `direct_native_transcript_reads_are_capped_at_three_sites`. Child measured the
  guard RED at 4 hits before the conversion and GREEN at 3 after, and proved the count is measured not assumed by
  temporarily expecting 99 and reading back `left: 3`. Gate at that moment: 7 passed in the target, 0 clippy
  warnings, fmt clean.

### Vet rounds (a `vetted` row requires its line)

- **A1 vet round 1 → FINDINGS (3 blockers, 3 majors, 3 minors).** Blockers: the invariant pipelines could not go red (pipe-tail `grep -q .` under the harness's own `set -o pipefail` — `grep -q` exits 0 on the first match, SIGPIPEs `sort -u`, and pipefail folds the 141 into the `if` condition, so an injected dash-free prefix silently GREENED the guard); Step 3's token rename reded five fixture pins that no step edited; C1 claimed a dot-free+dash-free Darwin exclusion that no case planted. Planner refined the same file.
- **A1 vet round 2 → APPROVE.** The reviewer measured the closure rather than reading it: broken idiom FALSE GREEN 5/5 vs fixed idiom RED 5/5 on a 620 KB corpus; `grep -rn 'dotted-name dir(s)'` returns exactly five pins (`.test.sh:446`, `.test.sh:462`, `.sh:1183`, `.sh:1193`, doc `:194`) — no sixth; and the planned 18d fixture run against the UNMODIFIED script exits 1 naming `betaenrollmentagent` UNATTRIBUTED, exactly the red Step 1 predicts.
- **A2 vet round 1 → APPROVE.** The proposed call is not novel — `let child_rows = wait_for_rows(&h.db, &child_id, 2).await;` already exists in the converted sibling test, so `&h.db` → `&Db` and `&child_id` → `&str` are proven coercions. Guard occurrence count grep-verified 4 → 3; the split needle defeats self-matching; `env!("CARGO_MANIFEST_DIR")` is compile-time, so the path is CWD-independent. Two nits: `use …Db` is at line 32 not 27, and the hand-copied `1652` baseline is not in the grounding — re-derive at run time, do not treat it as a contract. (A third nit raised there — "helper closes at 290 not 292" — was itself WRONG: the implementer checked, 292 is correct and 290 is the `sleep` line. Do not repeat it.)

### Findings the children raised, and how the orchestrator adjudicated them

- **A1 child reported "`docs/roadmap/` is NOT gitignored" — WRONG, and the reason is worth keeping.** It ran
  `git check-ignore` and got exit 1. Plain `git check-ignore` reports *nothing* for a path already in the index,
  which reads as "not ignored"; `git check-ignore --no-index -v` prints `.gitignore:31:docs/roadmap/` correctly.
  The directory is ignored, and files enter it only via `git add -f` — which is what this run did, matching every
  prior roadmap run in `git log`. **`AGENTS.md`'s "never `rm -rf docs/roadmap/`" bullet stays true.**
- **Its companion finding is true and accepted:** force-adding the plan means the issue's run ids
  (`41188776833`, `124501049035`) and `excluded: 5` ARE grep-able in the repo — inside the plan file only. Outside
  `docs/roadmap/` the vet's "zero hits" holds, and the durable §9a text attributes them to #139 as unmeasured.
  The plan is deleted on ship, so the residue is not permanent.
- **A2 child corrected the vet's nit — the vet was wrong.** `wait_for_rows`'s closing brace is at **292**, not 290
  (290 is the `sleep` line); the plan's own "281–292" was right. Cosmetic; the implementer had already anchored on
  landmark text.
- **A2 child found two real plan defects, both gate-breaking:** the plan's "insert verbatim" guard snippet produced
  **6 × `clippy::doc_lazy_continuation`** warnings (a prose paragraph after a `/// 1./2./3.` doc list) — and CI runs
  `-D warnings`, so the plan as literally specified would have reddened CI — and was not rustfmt-clean
  (`cargo fmt --check` failed on the `concat!(env!(…), …)` block). Fixed with tool-suggested formatting only: a
  blank `///` line, and rustfmt's own collapse. No change to semantics, needle, or counted occurrences.
  **Lesson for the next wave: a plan that quotes insertable Rust has to be clippy-and-fmt clean itself; a vet that
  reads the snippet rather than compiling it cannot catch this.**
- **A1 child flagged an environmental flake, not a regression:** `.test.sh` case 13 (`--self-test leaves the real
  census base unchanged`) intermittently reddens here because this box's `/tmp` churns (686→683, 697→694) while
  nothing runs. Present at baseline too; it passed 3/3 and on the wave gate. CI's `/tmp` should not churn. Recorded
  so a future reader does not blame `c419e1f`.
- **A1 child found Step 2's red list under-stated:** the token rename also reds case 13's `--self-test exits 0`,
  because case 13 runs the script's own self-test and Case 14's red propagates. Deterministic, closed at Step 3.

### Nits handed to the implementers (from the vets, non-blocking)

- **A1**: the plan cites `test_support.rs:211` / `:533` for the `{prefix}{tag}-{uuid}` contract and its re-pinning test — the real lines are **212** and **537** (`:207` doc comment is correct). Landmark names in the plan are greppable, so cite the fn name `the_guard_names_the_dir_after_the_prefix_and_tag_it_is_given` rather than the digits. Also: `grep -rn 'dotted-name'` hits the printf producer at `.sh:697` and the 18c message lines at `.test.sh:472/476` in addition to the five pins — Step 6's final-grep expectation already accounts for those, do not treat them as missed pins.
- **A2**: keep the assert message verbatim; anchor on landmark text, not the plan's line numbers.
