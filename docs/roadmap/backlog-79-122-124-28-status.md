---
status: done
mode: autonomous
updated: 2026-10-29
---

# backlog-79-122-124-28 — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Close the entire open backlog of `danielcherubini/archimedes` — the four issues
`#79`, `#122`, `#124`, `#28` — as one branch → one PR. The source of the work is the
`check-issue` triage run of 2026-10-29 plus each issue's own body on the tracker
(`gh issue view <n> --repo danielcherubini/archimedes`); there is no spec doc and no
`issue:` key on a doc, because the entry was the triage backlog, not `discuss`.
"Finished" means: all four tasks merged on `feature/backlog-79-122-124-28` with the
full five-command AGENTS.md gate green on the integrated tree.

## Operating mode

The whole wave moves at once — planning fans out, it is not one task at a time.

**On every resume, before dispatching anything:** run `git status --porcelain` **and
`git worktree list`.** A wave child's edits land in its own worktree, so a clean primary
tree proves nothing — an `*-taskNN` worktree left over from a dead iteration means that
task died **mid-implementation**: check `git -C <worktree> status --porcelain` for each
one. Such a task is `implemented`, not `todo`, and its siblings may be half-written.
Commit or set aside those edits — in that worktree, on that task's branch; never dispatch
a new wave on a dirty tree. Then re-derive every task's state from the table's Status
tests (plan file? changelog? commit?) — the tree outranks whatever value is written, so
correct the column before acting on it. Then rebuild the **session list**
(`manage_todo_list`) from the corrected column — one entry per task row, `W<wave> · <task
id>`, replacing whatever entries are there, including an empty list. Map each row's Status
to a list state — `todo`/`planned`/`vetted` → pending, `implemented` → in-progress,
`done` → complete.

Loop protocol, per WAVE, repeat until `status: done`:
1. Read this file. Take the FIRST wave containing a task whose Status is not `done`. Do
   not pick, reorder, or skip. Re-entering a half-finished wave resumes at the first
   incomplete step — never re-dispatch a step whose output already exists (area already
   in the Grounding reports table → skip grounding it; plan file already present → skip
   planning it).
2. Verify each task in the wave against the tree. Trust the tree over the task text.
   Re-check the Owns sets are still disjoint — the tree outranks this table.
3. Ground: one `researcher` per area not yet grounded, all in one response, each WRITING
   `docs/roadmap/<feature>-ground-<area>.md`. Never ground per task.
4. Plan: dispatch consumed `specify` to `researcher` for every todo task in the wave with
   NO plan file yet, all in one response — marker `SPECIFY CONSUMED MODE`, the task text,
   its Owns set, the grounding FILE PATH (not its contents), and
   `target: docs/roadmap/<feature>-taskNN-<slug>.md`. Not capped at 4.
5. Vet: one `reviewer` per plan file in one response (max 3 rounds each), told to OPEN the
   files the plan names; findings → re-dispatch consumed specify to refine the SAME target.
6. Commit the plan docs yourself, by pathspec.
7. Implement the wave per implement's wave protocol (children commit on their own branch
   in their own worktree; orchestrator integrates; ≤4 implementers). **Wave 1 is width 4,
   which forces one worktree + one branch per task — no width-1 decision to make here.**
   There is no Wave 2, so there is nothing to pipeline over this wave.
8. Integrate the task branches in plan order, then run the gate (full suite once per wave,
   on the integrated tree). Green → mark `done` here → one Changelog line. Red →
   re-dispatch; never fix by hand in the orchestrator. Remove the task worktrees, then
   delete the task branches (git refuses the reverse order).
9. Update THIS FILE **and the session list** before starting the next wave. Then loop.

## Gate — establish before task 1, re-run after every wave

Frontend from the repo root, Rust from `src-tauri/`:

    pnpm test                      # repo root
    pnpm build                     # repo root  (tsc && vite build)
    cargo test                     # src-tauri/
    cargo clippy --all-targets     # src-tauri/  (must be 0 warnings; CI adds -D warnings)
    cargo fmt --check              # src-tauri/

**Baseline measured at `f5ba339` (main, 2026-10-29): ALL GREEN.**
Current figures, stated once here and labelled current: `pnpm test` 154 files / 3260
tests passed, 0 failed · `pnpm build` clean · `cargo test` 1698 passed, 0 failed ·
`cargo clippy --all-targets` 0 warnings · `cargo fmt --check` clean. Toolchain is pinned
by `src-tauri/rust-toolchain.toml` (1.99.0) — do not float it.

## Dependency graph / waves

    Wave 1: A1, A2, A3, A4   (all four owned file sets pairwise disjoint — verified below)
    (no Wave 2)

The cut came out width 4 with zero edges: no task consumes a symbol another creates, and
no two Owns sets share a path. The one collision worth naming was checked rather than
assumed — #124's announcement is guarded on the tool being `bash`, so it could have
reached into the bash tool A1 owns. It does not: the `UnsupportedUnvalidatedMatcher`
`notes.push` lives only in `src/agent/definition_permission.rs`, and
`grep -n "Unsupported\|matcher\|permission" src/agent/tools/exec/bash.rs` returns
nothing. `agents.rs` and `harness/loop/*` are named by A3 alone.

**Isolation decision, recorded so the next iteration does not flip it silently:** Wave 1
is width 4, so every task gets its own worktree + branch (siblings force isolation — no
judgement available). Worktrees are seeded by btrfs reflink copy of `src-tauri/target`
(see Decisions 2026-10-29) because a cold Rust build per worktree would cost more than
the wave.

### Verified disjointness evidence (checked at `f5ba339`)

| Task | Files that carry the subject matter (grep-verified owner) |
|---|---|
| A1 | `src/agent/childproc.rs`, `src/agent/tools/exec/bash.rs`, `src/agent/tools/exec/tests/bash.rs`, `src/agent/tools/exec/tests/policy.rs`, `src/agent/harness/tool_specs.rs` |
| A2 | `src/agent/harness/loop/turn.rs`, `src/agent/harness/provider/openai.rs`, `src/agent/worker/core.rs`, `src/agent/worker/client.rs`, `src/agent/worker/manager/subagent_flow.rs`, `src/agent/worker/manager/tests/mod.rs`, `src/agent/harness/loop/tests/turn_lifecycle.rs` |
| A3 | `src/agent/definition_permission.rs`, `src/agent/harness/loop/gate.rs`, `src/agent/harness/loop/tests/policy_gate.rs`, `src/agent/agents.rs` |
| A4 | `LICENSE` (new), `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`, `docs/decisions/0085-*.md` (new) |

**Shared-barrel hazard, resolved by construction:** A2 and A3 both add tests under
`src/agent/harness/loop/tests/`, whose barrel `tests/mod.rs` is a shared mutable file.
Neither may edit it — `turn_lifecycle.rs` (A2) and `policy_gate.rs` (A3) are ALREADY
declared there (`mod turn_lifecycle;` / `mod policy_gate;`), so both add tests to files
they already own and the barrel is never touched. If either finds it must edit
`harness/loop/tests/mod.rs`, that is a wave-breaking collision → report it, do not edit.

## Grounding reports

One per code AREA, written once, read by every planner for that area. Re-ground only if
the tree moved inside the area since the recorded commit —
`git log --oneline <commit>..HEAD -- <area paths>`, not a feeling.

| Area | Report | Grounded at |
|---|---|---|
| windows-exec | `docs/roadmap/backlog-79-122-124-28-ground-windows-exec.md` | not yet |
| worker-wire | `docs/roadmap/backlog-79-122-124-28-ground-worker-wire.md` | not yet |
| permission-guard | `docs/roadmap/backlog-79-122-124-28-ground-permission-guard.md` | not yet |
| packaging-licence | `docs/roadmap/backlog-79-122-124-28-ground-packaging-licence.md` | not yet |

## Tasks

| # | Task | Area | Plan file | Wave | Owns (file set — disjointness evidence) | Status |
|---|------|------|-----------|------|------------------------------------------|--------|
| A1 | #79 Windows bash residual carve-outs: make `timeout /t`'s console-input need diagnosable instead of a modal, and settle the `start /B` file-lock symptom | windows-exec | `docs/roadmap/backlog-79-122-124-28-task01-windows-bash-residual.md` | 1 | `src-tauri/src/agent/childproc.rs`, `src-tauri/src/agent/tools/exec/bash.rs`, `src-tauri/src/agent/tools/exec/tests/bash.rs`, `src-tauri/src/agent/tools/exec/tests/policy.rs`, `src-tauri/src/agent/harness/tool_specs.rs` (the tool description + its byte-freeze tests live HERE, not in bash.rs) | `done` `dda2356` |
| A2 | #122 Silence the `[System: Empty message content sanitised to satisfy protocol]` notice and guard empty message content on the wire | worker-wire | `docs/roadmap/backlog-79-122-124-28-task02-empty-message-content.md` | 1 | `src-tauri/src/agent/harness/loop/turn.rs` (inbound placeholder filter), `src-tauri/src/agent/harness/provider/openai.rs` (+ its inline `mod tests`), `src-tauri/src/agent/worker/core.rs`, `src-tauri/src/agent/worker/client.rs`, `src-tauri/src/agent/worker/manager/subagent_flow.rs`, `src-tauri/src/agent/worker/manager/tests/mod.rs`, `src-tauri/src/agent/harness/loop/tests/turn_lifecycle.rs` | `done` `5207fac` |
| A3 | #124 Announce an unenforced path-tool `permission:` pattern map instead of staying silent (drop the bash-only guard) | permission-guard | `docs/roadmap/backlog-79-122-124-28-task03-path-pattern-announce.md` | 1 | `src-tauri/src/agent/definition_permission.rs`, `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/agents.rs` | `done` `3ce1319` |
| A4 | #28 Adopt MIT and wire the SPDX id through every packaging surface so the rpm `License` tag is non-empty | packaging-licence | `docs/roadmap/backlog-79-122-124-28-task04-mit-licence.md` | 1 | `LICENSE`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`, `docs/decisions/0085-*.md` | `done` `c284ecb` |

**Status is exactly one of:** `todo` (no plan file at the Plan path) · `planned` (plan
file exists) · `vetted` (plan file exists **and** a Changelog line records the vet round)
· `implemented` (edits uncommitted in its worktree, or committed on its task branch but
not merged into the feature branch) · `done <hash>` (gate green **and** the task's branch
merged into the feature branch; `<hash>` is the child's own commit, verify with
`git merge-base --is-ancestor <hash> HEAD`).

## Blockers / open questions

None open. Two **proof ceilings** are not blockers but bound what this branch can claim:

- **A1 cannot be behaviourally verified here.** `#[cfg(windows)]` code type-checks locally
  and only RUNS on CI's `windows-latest` leg (no wine, no msvc `lib.exe`). The local
  Windows proof is `cargo check --target x86_64-pc-windows-gnu --all-targets` (the mingw
  target IS installed). Never describe A1's Windows behaviour as verified from this
  machine — see ADR-adjacent note in AGENTS.md "Working in this repo".
- **A4 cannot be proven on a real rpm here.** `rpmbuild` is absent locally (only `rpm` is
  present), so the issue's "prove it on a real build" checklist item lands on the release
  leg, not on this branch. Record that honestly in the task's acceptance note rather than
  claiming the header was checked.
- **A4's last checklist item is void.** It tells us to update
  `docs/roadmap/multi-platform-build-and-release.md:140-143` from "Flagged, not fixed" —
  that file no longer exists (deleted when its own roadmap shipped). The outcome is
  recorded in the new ADR instead.

## Decisions log

- **2026-10-29 — Licence chosen: MIT.** Owner's explicit choice at the Step 0 gate (the
  one question this run could not decide: a legal stance). SPDX form `MIT`, per the
  issue's own requirement that rpmlint validates the string against its licence list.
- **2026-10-29 — #124 resolved as ANNOUNCE, not ENFORCE.** Owner's explicit choice.
  Matches the existing `bash` precedent and ADR 0084's standing refusal to add a second
  matcher; no root-set decision needed because nothing new is judged. The issue's
  minimum bar still holds: a test that reddens if the silence comes back.
- **2026-10-29 — Wave 1 runs in 4 seeded worktrees, seeded by btrfs reflink, not cold.**
  Measured, not assumed: `src-tauri/target/debug` is 166G and `/home` was 93% full with
  17G free, so a naive `git worktree add` + cold build per child was the actual hazard of
  this run. Probes in a throwaway worktree: `git worktree add` writes only the 15M tracked
  tree; `cp -a --reflink=always` of `target/debug` (minus `incremental/`) costs **0 real
  disk** (btrfs shares extents — `df` unchanged at 17G for a 129G apparent tree) and
  yields a **warm** build: `cargo build --all-targets` 1m43s, `cargo test` 1698 passed in
  1m49s. `pnpm install --frozen-lockfile` is 4s (store hardlinks). So: seed by reflink,
  never by cold install.
- **2026-10-29 — One `cargo test` in a seeded worktree costs ~2G real disk** (measured:
  13G → 11G). Four concurrent children ≈ 8G plus ~2G for the orchestrator's own
  post-fan-in gate against 11G free — too tight on a btrfs volume where a full disk
  mid-run is unrecoverable. Mitigation taken: deleted `src-tauri/target/debug/incremental`
  (40G of pure rebuildable cache) → **39G free, 84%**. Re-check `df -h /home` before every
  wave; `CARGO_INCREMENTAL=0` is the fallback if it ever gets tight again (the gate was
  measured to run green with it off, at the same speed).
- **2026-10-29 — No issue-tracker mirror.** The entry is the triage backlog, not `discuss`,
  so there is no spec doc and no `issue:` key to comment on. Stated once here per Step 0.3.

## Changelog

One line per task: hash, what shipped, gate numbers at that moment. Figures below are
historical — what they were at that moment.

- `dda2356` A1 (#79) — `cmd_input_redirection_diagnostic` translates cmd's "Input redirection
  is not supported" into a first-line no-console-input diagnostic; Windows `BASH_DESCRIPTION`
  records the `start /B` file-lock as a known limitation (symptom only, no invented
  mechanism). Child's tree: cargo 1700 passed / 0 failed; windows-gnu `--all-targets` exit 0.
- `5207fac` A2 (#122) — outbound `request_body` omits `content` for an empty-text
  assistant-with-tool-calls row; inbound SSE prefix-hold filter + `consume_stream` bolt; a
  settled-with-no-output subagent is now `Failed`/`Other`, not `Completed`/empty. Child's tree:
  cargo 1583 passed / 0 failed (scoped), pnpm 3260.
- `3ce1319` A3 (#124) — new `UnsupportedReason::PathPatternRules`; guard widened to an
  exhaustive `match tool` whose `Unrecognized(_) => None` arm keeps T6 green; anti-silence test
  `a_path_tool_pattern_map_announces_itself_unsupported` RED→GREEN; 13/13 predicted break sites,
  zero missed. `gate.rs` change is doc-comment-only (verified: every diff line starts `///`).
- `c284ecb` A4 (#28) — MIT: `LICENSE` at root, SPDX `MIT` in `Cargo.toml` + `package.json` +
  `bundle.license`, and `bundle.linux.rpm.files` shipping the text to
  `/usr/share/licenses/archimedes/LICENSE`; ADR 0085 records the decision. ajv schema-validated
  with four negative controls; `check-versions.sh` still `versions match: 0.9.0`.

**Wave 1 integrated gate (measured on the merged tree, all five commands):** `pnpm test`
154 files / 3260 passed · `pnpm build` clean · `cargo test` **1718 passed, 0 failed, 4
ignored** (baseline 1698 + 20 new tests) · `cargo clippy --all-targets -- -D warnings` 0
warnings · `cargo fmt --check` clean · bonus local Windows proof `cargo check --target
x86_64-pc-windows-gnu --all-targets` exit 0.

## Review loop (Step 5) — 2 iterations, 5 findings, all closed

Iteration 1 (deep, two focused reviewers after a broad one stalled twice):
- 🔴 `bundle.linux.rpm.files` was keyed backwards. tauri-bundler `rpm.rs:215` destructures
  `for (rpm_path, src_path) in files.iter()` — key is the IN-PACKAGE DESTINATION, value the
  on-disk source. The shipped pair was reversed, so `is_file()` fails, `WalkDir` errors and
  `tauri build --bundles rpm` fails at RELEASE time. No local gate and no CI step opens an
  rpm, and the schema is string→string so it validates either way — ADR 0085's own honesty
  section named this exact trap and recorded having hand-checked it. Fixed + ADR corrected.
  Verified against upstream source fetched at the pinned tag, twice, independently.
- 🔴 `docs/features/permissions-model.md` asserted the opposite of what #124 shipped.
  Rewritten; the still-true unenforcement half kept, ADR 0084's refusal cited.
- 🟡 `AgentUnsupportedReason` in `src/lib/tauri/types.ts` missed `"pathPatternRules"`;
  `describeNote` gained an arm and a render-level pin. No parity test exists between the
  Rust enum and that union — recorded as follow-up.
- 🟡 the Windows tool description shipped "(tracked in issue #79)" into model-facing prompt
  text. Removed; Unix literal re-confirmed byte-identical to `main`.
- 🟡 ADR 0084's Consequences carried the same stale announcement-scope claim. Amended with a
  dated amendment; its refusal of a second matcher is untouched.
- #122's streaming filter was stress-tested and PASSED: every flush path releases held text,
  no legitimate delta is swallowed, the exact/whitespace predicate split is applied at the
  right sites, and a tool-activity child cannot be misclassified as silent (the announce
  rides both the event and sink seams).

Iteration 2: all findings CLOSED, no new defects. Gate re-measured green after the fixes.

## Implementation deviations worth keeping (tree outranks the plan)

Recorded so a later reader does not "restore" the plan's version:

- **A1** wired the diagnostic with `format!("{diagnostic}\n{text}")`, not the plan's
  `insert_str(0, …) + push('\n')` — the plan's shape glued the diagnostic onto cmd's sentence,
  so the "one clear diagnostic line" was not a line. A host-side test the child added proves the
  wiring on Linux instead of leaving it CI-only.
- **A2** moved the shared placeholder vocabulary into `openai.rs` and imports it back into
  `turn.rs`: the plan's `pub(super)` in `turn.rs` is structurally unreachable from `openai.rs`
  without widening `harness/loop.rs`, outside the owned set.
- **A2** split the predicate: the plan's single `content_is_effectively_empty` also matches
  whitespace, so at the streaming sites it would drop legitimate `" "`/`"\n"` deltas and weld
  words together. Now `content_is_the_sanitise_placeholder` (exact, streaming sites) vs
  `content_is_effectively_empty` (whole-value sites), each pinned.
- **A2**'s §5.4 as written reddened two existing ADR-0055 pins — a child that ran a tool or
  answered a gate and then settled silently is a legitimate `Completed`. The guard now also
  requires no tool activity (`SubagentCapture::saw_tool_activity()`).
