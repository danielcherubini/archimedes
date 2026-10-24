---
status: running
mode: autonomous
updated: 2026-10-24
---

# issue-triage-backlog — STATUS

**READ THIS FIRST on every iteration. This file is the loop's only memory.**

## Mission

Land the fixes for the GitHub issues triaged on 2026-10-23 (the triage record lives in the issue
comments themselves — #74/#75/#27/#47/#42 were closed with evidence; #81 and #82 were filed). "Finished"
means the 12 tasks below are `done`, each as its own commit on `feature/issue-triage-backlog`, with the
AGENTS.md gate green at every step. There is no separate spec doc: the issues are the source documents,
and each task's commit references its issue number.

## Operating mode

Loop protocol (repeat until `status: done`):
1. Read this file. Take the FIRST task whose Status is `todo`. Do not pick, reorder, or skip.
2. Verify the task against the tree before doing it. Trust the tree over the task text — several of
   these issues were written against older heads, and the triage already found one (#27) fully fixed.
3. Expand it with `specify` in CONSUMED MODE (marker `SPECIFY CONSUMED MODE`, plus the task text and
   `target: docs/roadmap/<feature>-taskNN-<slug>.md`).
4. Dispatch per the wave rules below. **The Rust tasks are SERIAL** — see the compile-unit note.
5. Run the gate. Green -> commit by pathspec -> mark `done` here -> one Changelog line.
   Red -> re-dispatch; never fix by hand in the orchestrator.
6. Update THIS FILE before starting the next task. Then loop.

## Gate — measured at `a6e3f02`, re-run after every task

From the repo root:

    pnpm test      # baseline 149 files / 3049 tests
    pnpm build     # exit 0

From `src-tauri/`:

    cargo test                     # baseline 1355 passed, 0 failed, 4 ignored
    cargo clippy --all-targets     # 0 warnings (AGENTS.md bar)
    cargo fmt --check              # exit 0

Windows-arm check (T8 needs it; any later Rust task should keep it green):

    cargo check --target x86_64-pc-windows-gnu --all-targets

Baseline measured at `a6e3f02` (branch `main`, v0.6.0): ALL FIVE GREEN — 3049 FE tests / 149 files,
1355 Rust tests, clippy 0 warnings, fmt clean. Nothing was red before this work started.

**CURRENT figures (update on every task):** Rust 1404 / 0 failed / 4 ignored, clippy 0 warnings, fmt
clean, `cargo check --target x86_64-pc-windows-gnu --all-targets` green; FE 3057 tests / 149 files;
build exit 0. The `agent::hostenv` module's test count is platform-split (16 Linux / 7 elsewhere) —
pinned by its own module doc, read it there. **`cargo test --lib` alone does NOT rebuild
`fake_worker`** — `manager::tests` fails with a stale binary until `cargo build --all-targets` runs
(T10 and T11 both hit this; the full `cargo test` is unaffected).

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

ALL TWELVE LANDED — see the Task table; nothing is `todo`.

## Tasks

| # | Task | Issue | Wave | Seam (disjointness evidence) | Status |
|---|------|-------|------|------------------------------|--------|
| T1 | `parse_value` strips trailing `#` comments, mirroring pi | #11 | serial | `src-tauri/src/skills.rs`, `src-tauri/tests/skills.rs`, `src-tauri/src/agents.rs` (doc comment only) | `done` `142ef2f` |
| T2 | SkillsDialog stops inserting a dead `$name` token | #10 | 1a | `src/components/SkillsDialog.tsx` + `.test.tsx` | `done` `863eec6` |
| T3 | Inverse sig-completeness check; composer fails on an unsigned target | #41(d) | 1a | `scripts/compose-updater-manifest.sh`, `.test.sh`, `.github/workflows/release.yml`, `AGENTS.md` | `done` `2a3f8df` |
| T4 | MCP callback HTTP response + clear `NeedsAuth` after auth | #46 | serial | `src-tauri/src/agent/mcp/callback.rs`, `agent/mcp/manager.rs` | `done` `c71bb7b` |
| T5 | Protected-dir refusal names a sanctioned route | #33 | serial | `agent/tools/exec/access.rs`, `agent/tools/exec/tests/policy.rs`, `agent/harness/loop/tests/policy_gate.rs` | `done` `e5ae57e` |
| T6 | `find`/`grep` get the Space cwd; make the scrub observable | #81 | serial | `agent/tools/exec/search.rs`, `agent/tools/exec/tests/search.rs`, `agent/tools/exec/tests/bash_hostenv.rs`, `agent/hostenv.rs` | `done` `f571a0b` |
| T7 | MCP bare-call false success + token expiry/refresh | #68 | serial | `agent/mcp/tool.rs`, `agent/mcp/oauth.rs`, `agent/mcp/manager.rs` (after T4) | `done` `d2cb1fa` |
| T8 | Windows `cmd /C` via `raw_arg` + truthful bash tool description | #79 | serial | `agent/childproc.rs`, `agent/tools/exec/bash.rs`, `agent/tools/exec/tests/bash.rs`, `agent/harness/tool_specs.rs`, ADR 0060 | `done` `70bffe1` |
| T9 | `unknown_param_warning` + `SUBAGENT_GUIDANCE` + advertise `thinking` | #78 | serial | `agent/harness/tool_specs.rs`, `agent/harness/prompt.rs`, `agent/harness/loop/turn.rs`, `agent/harness/loop/tests/subagents.rs`, `src/lib/toolOutput.test.ts` | `done` `a9b2347` |
| T10 | A child start signal that never reaches the main-prompt arm | #9 | serial | `agent/worker/protocol.rs`, `agent/worker/core.rs`, `agent/worker/manager/subagent_flow.rs`, `agent/worker/manager/mod.rs` (doc), `agent/harness/prompt.rs` (doc), `agent/subagent.rs` (doc), `tests/worker_stdin.rs`, `tests/worker_e2e.rs`, ADR 0036 | `done` `fb33e59` |
| T11 | A resolve miss is observable on `subagent-session-started` | #47 → #78 | serial | `agent/subagent.rs`, `agent/mod.rs`, `agent/harness/launch.rs`, `agent/harness/dispatch.rs`, `agent/worker/{dispatch,protocol,client}.rs`, `agent/worker/manager/subagent_flow.rs`, `agent/worker/manager/tests/mod.rs`, `bin/fake_worker.rs` (one line), `commands/agents.rs`, `tests/harness_dispatch_native.rs`, FE: `lib/tauri{.ts,/types.ts}`, `store/subagents.ts`, `App.tsx`, `SubagentDelegatingCard.tsx`, `SubagentDetailHost.tsx` + their tests | `done` `59b2a03` |
| T12 | Streaming-subagent test margin + honest panic text + doc wording | #34 | serial | `agent/worker/manager/tests/mod.rs`, `bin/fake_worker.rs`, `agent/worker/manager/mod.rs` | `done` `45cbb9a` |

## Blockers / open questions

None. Everything deliberately not fixed is in `docs/roadmap/issue-triage-backlog-follow-ups.md`.

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
- 2026-10-23 — **T2 shipped with one recorded deviation**: `manualOnlyTooltip`'s header still closes
  with "These TWO are the only places the rule is enforced for Skills" — now an under-count, but that
  block is pinned byte-unchanged by a test, so the correction was written in `src/lib/skills.ts` and the
  new `UNMENTIONABLE_ROW_REASON` doc instead. ADR 0036's Rust-side doc comments on
  `skills::is_mentionable_name` / `exec_read_skill` under-count the frontend surfaces for the same
  reason: Rust-doc-only, deliberately kept out of a frontend-only task. → follow-ups file.
- 2026-10-23 — **The KNOWN GAP comment in `exec/search.rs` has the wrong model, and #81 understates the
  defect.** The comment claims `fd` prints relative to its cwd so changing cwd changes the post-processing.
  Measured: `fd` echoes the search path as given (its `strip_current_dir` is only a `strip_prefix(".")`),
  and both tools always receive a canonical absolute root — so output is cwd-independent and **no flag is
  needed**. What the missing cwd actually breaks is `rg`'s cwd-relative `-g` globs: reproduced on this
  box, `rg -g 'sub/*' -- needle <abs space>` returns 0 matches with **exit 0** when cwd is not the Space.
  So under `AppRun.c`'s `chdir("$APPDIR/usr")` every directory-scoped `grep` silently reports "nothing
  found" — a false negative, not cosmetic. T6's plan is written against the measurement, not the comment.
- 2026-10-23 — **Wave 1a held.** T2 and T3 committed as two disjoint pathspec commits (`863eec6`,
  `2a3f8df`); full suite run once after the wave, green. Every task from T1 onward is SERIAL.
- 2026-10-23 — **Doc corrections handed back, not folded into task commits** (T6/T8 precedent):
  (a) `docs/research/appimage-child-process-env-leak.md` §Gaps item (b) — `--max-results` IS a real fd
  flag; strike it. (b) `docs/research/windows-child-console-window.md` line ~133 and the first
  follow-ups bullet still describe #79 as open — they now read CLOSED by `70bffe1` (`raw_arg` +
  `/d /s /c` through childproc, invariant E); the follow-ups list legitimately keeps `sudo_exec` on
  Windows, the Windows process-group kill, and the non-Linux relaunch. → follow-ups file.
- 2026-10-23 — **T9's planner found a same-class credibility bug outside this roadmap's scope**:
  `fetch_content`/`get_search_content` advertise params their schemas don't carry (six functional keys,
  e.g. `findText`), and fetch_content's own truncation note tells the model to use `responseId` — the
  identical credibility bug on other tools; handed to the orchestrator as its own task. → follow-ups file.
- 2026-10-23 — **#82 interim folded into T9 by orchestrator decision** (recorded on #82 too): the web
  specs advertise the camelCase keys their handlers read, so the generic checker ships with zero known
  false positives. Option (b) — narrow handlers to one dialect, fix the truncation notice — stays open
  on #82. T9's census found no handler reading an unadvertised TOP-LEVEL key anywhere else; `ask`'s
  nested `recommended` is nested-only, invisible to the top-level rule.
- 2026-10-23 — filed **#82** (web tools' camelCase dialect).
- 2026-10-24 — **T12's mutation probe contradicted its plan, and the plan's STOP rule did not apply.**
  The in-tool test is NOT green under mutation A (a frozen deadline expires during the hold; the
  `!in_flight` guard DELAYS the reaping until `tool_execution_end` lifts it) — measured 7/11 RED. The
  STOP rule fires when a test PASSES under its own mutation; the opposite happened. The doc paragraph
  now states the measured behaviour, and mutation B (deterministic RED) is named as what actually pins
  that test.

## Changelog

- `863eec6` — T2 (#10) Skills dialog inert rows. Gate after: FE 149 files / **3051 tests** (+2), build 0.
- `2a3f8df` — T3 (#41d) inverse sig-completeness gate + composer `--require-payload`. Gate after:
  Rust 1355 / 0 failed / 4 ignored, clippy 0 warnings, fmt clean, FE green, new harness 71 ok,
  composer harness 131 ok. All three mutation probes turned their named cases RED.
- `142ef2f` — T1 (#11) `strip_trailing_comment`, one shared helper for both readers. Gate after:
  Rust **1360** / 0 failed / 4 ignored (+5 tests), clippy 0, fmt clean, FE 3051 / 149 unchanged.
  RED evidence was the issue's own fixture resolving to the name `a # note`.
- `159a124` — plans for T5/T6 (docs only, no gate needed).
- `c71bb7b` — T4 (#46) callback answers as HTTP (200 + framed 400s), `authenticate` takes `close_all`'s
  shape (`client`/`state`/`tools`). Gate after: Rust **1363** / 0 / 4 (+3 tests), clippy 0, fmt clean,
  FE unchanged.
- `e5ae57e` — T5 (#33) refusal names the staging route; floor untouched; no elevated route named.
  Gate after: Rust 1363 / 0 / 4 (no new tests — five existing wording tests moved together), clippy 0,
  fmt clean, FE unchanged.
- `4974868` — plans for T7/T8 (docs only).
- `f571a0b` — T6 (#81) find/grep `current_dir`; one `hostenv:` line per process. Gate after: Rust
  **1369** / 0 / 4 (+6), clippy 0, fmt clean, FE unchanged. Implementer re-measured fd/rg and confirmed
  the plan over the code's old gap comment — and found fd's own `-g` is cwd-independent too, so `find`
  never had the glob bug; only `rg` did.
- `d2cb1fa` — T7 (#68) skipped servers fail the call; expired tokens refresh, persisted; auth-file
  injection closes T4's recorded gap. Gate after: Rust **1381** / 0 / 4 (+12), clippy 0, fmt clean,
  FE unchanged. Corrected its plan's self-contradiction with the `miss_result` helper (healthy path
  byte-identical and still `ok`).
- `70bffe1` — T8 (#79) `append_cmd_c` + census invariant E; per-platform bash description; 4 decision
  tests un-gated from `cfg(unix)`. Gate after (orchestrator-verified): Rust **1385** / 0 / 4, clippy 0,
  fmt clean, gnu `--all-targets` green, FE unchanged. cmd.exe behaviour is CI-windows-only by
  construction; the compile proof was itself proved with planted type errors.
- `a9b2347` — T9 (#78) `unknown_param_warning` above the join_all; guidance + description rewritten;
  `thinking` advertised; #82 interim (web specs advertise exactly what handlers read, census-pinned).
  Gate after: Rust **1393** / 0 / 4 (+8), FE **3052** / 149 (+1), clippy 0, fmt clean, gnu green.
- `fb33e59` — T10 (#9) `StartMode::FreshChild`; `(FreshChild, None)` prepends nothing; test G's RED was
  the issue's own shape (the narrowed child's seq-0 WAS the main prompt). Gate after: Rust **1399** /
  0 / 4 (+6: A,B,C,E,F,G), clippy 0, fmt clean, gnu green, FE unchanged.
- `59b2a03` — T11 (#47) `AgentNameResolution` tri-state resolve_launch → wire → payload
  (`nameResolution`, exactly eight keys pinned at the emitter, no serde(default)); one quiet
  "no matching Agent" caption for `unmatched` only; miss stays non-blocking end-to-end. Gate after:
  Rust **1404** / 0 / 4 (+5), FE **3057** / 149 (+5), clippy 0, fmt clean, gnu green. Four mutation
  probes run; probe-1 over-claim in the plan corrected (the emitter test builds its wire inline).
- `45cbb9a` — T12 (#34) `LIVENESS_DEAD_BOUND` 1500 ms both tests, 30 chunks / 3 s holds, honest panic
  text + OBSERVED wording, ADR 0055 amended append-only. Gate after: Rust **1404** / 0 / 4 (+0 — no new
  tests by design), FE 3057 / 149 unchanged, clippy 0, fmt clean, gnu green. 10/10 green bare and under
  load; both mutation mutations run, one plan prediction corrected by measurement.
- Current gate figures live in the Gate section above; the numbers here are what they were then.
