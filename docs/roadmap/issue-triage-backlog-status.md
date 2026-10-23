---
status: running
mode: autonomous
updated: 2026-10-23
---

# issue-triage-backlog — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Land the fixes for the GitHub issues triaged on 2026-10-23 (the triage record lives in the issue
comments themselves — #74/#75/#27/#47/#42 were closed with evidence; #81 was filed). "Finished" means
the 12 tasks below are `done`, each as its own commit on `feature/issue-triage-backlog`, with the
AGENTS.md gate green at every step. There is no separate spec doc: the issues are the source documents,
and each task names its issue number so the commit references it.

## Operating mode

Loop protocol (repeat until `status: done`):
1. Read this file. Take the FIRST task whose Status is `todo`. Do not pick, reorder, or skip.
2. Verify the task against the tree before doing it. Trust the tree over the task text — several of
   these issues were written against older heads, and the triage already found one (#27) fully fixed.
3. Expand it with `specify` in CONSUMED MODE (marker `SPECIFY CONSUMED MODE`, plus the task text and
   `target: docs/roadmap/issue-triage-backlog-taskNN-<slug>.md`).
4. Dispatch per the wave rules below. **The Rust tasks are SERIAL** — see the compile-unit note.
5. Run the gate. Green -> commit by pathspec -> mark `done` here -> one Changelog line.
   Red -> re-dispatch; never fix by hand in the orchestrator.
6. Update THIS FILE before starting the next task. Then loop.

## Gate — measured at `a6e3f02`, re-run after every task

From the repo root:

    pnpm test      # 149 files / 3049 tests
    pnpm build     # exit 0

From `src-tauri/`:

    cargo test                     # 1355 passed, 0 failed, 4 ignored
    cargo clippy --all-targets     # 0 warnings (AGENTS.md bar)
    cargo fmt --check              # exit 0

Windows-arm check (only T8 needs it; see the T8 note):

    cargo check --target x86_64-pc-windows-gnu --all-targets

Baseline measured at `a6e3f02` (branch `main`, v0.6.0): ALL FIVE GREEN — 3049 FE tests / 149 files,
1355 Rust tests, clippy 0 warnings, fmt clean. Nothing was red before this work started.

## Why the waves collapsed to serial — DO NOT "fix" this by re-parallelising

The original decomposition declared 5 waves. **Wave 1a is the only surviving wave.** Measured, not
guessed: a deliberate syntax error planted in `src/skills.rs` broke `cargo test --lib palette` — a
scoped run of an unrelated test. `archimedes` is ONE compilation unit, so any sibling's half-finished
`.rs` edit makes every other Rust task's verification fail to compile. That breaks gate 4 (scoped
verification is enough) and destroys the loop's only signal.

Consequences, all deliberate:
- **Two Rust tasks never share a wave.** T1, T4, T5, T6, T7, T8, T9, T10, T11, T12 are serial.
- **T2 + T3 do wave together**: Vitest transpiles per file and T3 runs `scripts/*.test.sh`; neither
  compiles the Rust crate, so neither can be broken by the other's mid-edit.
- **`specify` dispatches fan out freely** (batches of 4): they are read-only against the tree and each
  writes a NEW disjoint doc. Planning parallelism is where the wall-clock win is; implementation
  parallelism is unavailable here.
- Full suite runs after EVERY task, not once per wave, because each task is its own wave.

## Dependency graph / waves

    Wave 1a: T2, T3          (disjoint; neither compiles Rust — the only valid wave)
    Serial:  T1              (skills.rs — crate compile unit)
    Serial:  T4              (#46 must precede T7: it is the root cause of NeedsAuth never clearing)
    Serial:  T5
    Serial:  T6
    Serial:  T7              (needs T4 landed in manager.rs)
    Serial:  T8              (owns tool_specs.rs; T9 edits it next)
    Serial:  T9              (needs T8 landed in tool_specs.rs)
    Serial:  T10             (worker/protocol.rs + subagent_flow.rs)
    Serial:  T11             (needs T10's start-signal shape; shares protocol.rs)
    Serial:  T12             (shares manager/tests/mod.rs with T10/T11)

## Tasks

| # | Task | Issue | Wave | Seam (disjointness evidence) | Status |
|---|------|-------|------|------------------------------|--------|
| T1 | `parse_value` strips trailing `#` comments, mirroring pi | #11 | serial | `src-tauri/src/skills.rs`, `src-tauri/tests/skills.rs` | `todo` |
| T2 | SkillsDialog stops inserting a dead `$name` token | #10 | 1a | `src/components/SkillsDialog.tsx` + `.test.tsx` | `todo` |
| T3 | Inverse sig-completeness check; composer fails on an unsigned target | #41(d) | 1a | `scripts/compose-updater-manifest.sh`, `.test.sh`, `.github/workflows/release.yml`, `AGENTS.md` | `todo` |
| T4 | MCP callback HTTP response + clear `NeedsAuth` after auth | #46 | serial | `src-tauri/src/agent/mcp/callback.rs`, `agent/mcp/manager.rs` | `todo` |
| T5 | Protected-dir refusal names a sanctioned route | #33 | serial | `agent/tools/exec/access.rs`, `agent/tools/exec/tests/policy.rs`, `agent/harness/loop/tests/policy_gate.rs` | `todo` |
| T6 | `find`/`grep` get the Space cwd; make the scrub observable | #81 | serial | `agent/tools/exec/search.rs`, `agent/tools/exec/tests/search.rs`, `agent/hostenv.rs` | `todo` |
| T7 | MCP bare-call false success + token expiry/refresh | #68 | serial | `agent/mcp/tool.rs`, `agent/mcp/oauth.rs`, `agent/mcp/manager.rs` (after T4) | `todo` |
| T8 | Windows `cmd /C` via `raw_arg` + truthful bash tool description | #79 | serial | `agent/childproc.rs`, `agent/tools/exec/bash.rs`, `agent/tools/exec/tests/bash.rs`, `agent/harness/tool_specs.rs` | `todo` |
| T9 | `unknown_param_warning` + `SUBAGENT_GUIDANCE` + advertise `thinking` | #78 | serial | `agent/harness/tool_specs.rs`, `agent/harness/prompt.rs`, `agent/harness/loop/turn.rs`, `agent/harness/loop/tests/*` | `todo` |
| T10 | A child start signal that never reaches the main-prompt arm | #9 | serial | `agent/worker/protocol.rs`, `agent/worker/core.rs`, `agent/worker/manager/subagent_flow.rs`, `agent/worker/manager/tests/mod.rs` | `todo` |
| T11 | A resolve miss is observable on `subagent-session-started` | #47 → #78 | serial | `agent/harness/launch.rs`, `agent/worker/protocol.rs`, `agent/worker/manager/subagent_flow.rs`, `src/store/subagents.ts`, `src/components/SubagentDelegatingCard.tsx` | `todo` |
| T12 | Streaming-subagent test margin + honest panic text + doc wording | #34 | serial | `agent/worker/manager/tests/mod.rs`, `src/bin/fake_worker.rs`, `agent/worker/manager/mod.rs` | `todo` |

## Blockers / open questions

None. See `docs/roadmap/issue-triage-backlog-follow-ups.md` (written before the last commit) for what
was deliberately NOT done, including the two items needing a human decision.

## Decisions log

- 2026-10-23 — **Waves re-derived to serial after measuring the crate-compile coupling** (planted-error
  experiment). Original 5-wave plan is superseded by the table above; gate 4 cannot hold for two Rust
  tasks in one tree.
- 2026-10-23 — **T8 is locally CHECKABLE but not locally RUNNABLE.** `cargo check --target
  x86_64-pc-windows-gnu --all-targets` passes on this host (mingw present); the msvc target needs
  `lib.exe` and there is no `wine`. So T8's `cfg(not(unix))` arm and its tests get type-checked here and
  behaviourally proven on CI's `windows-latest` leg. Do not claim local behavioural verification of T8.
- 2026-10-23 — **#28 (licence) excluded**: needs a human SPDX decision. **The `~/.agents` migration of
  21 `agent:` call sites is a separate repo**, out of this branch's reach. **#78's frontmatter
  (`skills:`, `systemPromptMode:`, `model_kwargs`) stays out** — it wants its own ADR.
- 2026-10-23 — Entry was the triage itself (no `discuss` spec, no `issue:` key) → nothing to mirror the
  plan comment to. The issue tracker already carries the triage record; commits reference issue numbers.

## Changelog

Nothing landed yet.
