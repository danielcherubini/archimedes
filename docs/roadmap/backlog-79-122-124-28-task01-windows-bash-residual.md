---
status: planned
branch: feature/backlog-79-122-124-28
grounding: docs/roadmap/backlog-79-122-124-28-ground-windows-exec.md
issue: "#79 residuals — owner's status comment (2026-10-24): the quoting fix shipped in PR #83; the issue stays OPEN for exactly two residuals"
commit: f5ba339 (HEAD when grounded)
---

# Task A1 — #79 Windows bash residual carve-outs

## Consumed-mode note

One task from the approved decomposition; the coarse split and the owner's decisions are already
made and are NOT re-litigated here. **The #79 quoting fix is shipped (PR #83: `childproc::cmd_c_tail`
/ `append_cmd_c` via `raw_arg` of `/d /s /c "<exact string>"`, per-platform `BASH_DESCRIPTION`, census
invariant E) and is NOT re-done.** This task is exactly the two residual symptoms the issue is kept
open for, and nothing else:

- **(a)** `timeout /t N` fails with cmd's own `ERROR: Input redirection is not supported` — a
  documented, *intended* consequence of the Tool-child stdin policy (`closed_stdin` → `Stdio::null()`
  + `CREATE_NO_WINDOW`), which today reads like a real error. The residual ask is **diagnosability
  only**: a clear diagnostic in the tool result, not a re-plumbing of the child.
- **(b)** `start /B`'s file-lock behaviour is **unexplained and has NO code owner in the tree today**.
  Per the task decision, the deliverable is an **honest recorded limitation + follow-up — NOT an
  invented fix**. No locking code is written, no root cause is asserted.

## Deliverable in one sentence

When a `bash` run's captured text carries cmd's own `ERROR: Input redirection is not supported`
sentence, the tool result now ALSO carries one clear diagnostic line naming the no-console-input
policy and the `ping` workaround (pure, cross-platform, unit-tested); and the Windows
`BASH_DESCRIPTION` now records the `start /B` file-lock as a known, tracked limitation — while the
deeper record (research doc §Gaps + follow-up issue that lets #79 close per the owner's intent) is
carried as Out-of-set needs for the orchestrator.

## Owned file set (the ONLY files this plan edits)

| File | Role |
|---|---|
| `src-tauri/src/agent/tools/exec/bash.rs` | ADD pure `cmd_input_redirection_diagnostic` + wire it into `exec_bash`'s text building |
| `src-tauri/src/agent/tools/exec/tests/bash.rs` | ADD one pure unit test + one `#[cfg(windows)]` e2e |
| `src-tauri/src/agent/harness/tool_specs.rs` | the Windows `BASH_DESCRIPTION` const gains the lock-limitation sentence; its byte-freeze tests are untouched except the one extended arm (see Step 3) |
| `src-tauri/src/agent/childproc.rs` | NO edit — read-only (its module doc stays the honest owner of the stdin/console policy the diagnostic explains) |
| `src-tauri/src/agent/tools/exec/tests/policy.rs` | NO edit — no policy change (there is no policy change in this task) |
| `src-tauri/src/agent/tools/exec/tests/mod.rs` | NO edit — no new test file is added |

The **Unix `BASH_DESCRIPTION` literal is byte-frozen and is NEVER touched** (a test asserts it is
"byte-frozen (it is printed into every session)"). Only the `#[cfg(not(unix))]` copy changes, and the
changed arm's existing `contains`/`!contains` pins (`the_bash_description_names_the_shell_this_platform_actually_runs`)
stay true.

## Exact signatures (verbatim from the grounding / committed source)

From `src-tauri/src/agent/childproc.rs` (verbatim — the premise my diagnostic quotes; NOT edited):

```rust
pub fn closed_stdin(cmd: &mut tokio::process::Command)        // cmd.stdin(Stdio::null())
pub fn cmd_c_tail(command: &str) -> String                    // "/d /s /c \"{command}\"" — PURE
pub fn append_cmd_c(_cmd: &mut tokio::process::Command, _command: &str)  // raw_arg; #[cfg(windows)] body
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000
```

From `src-tauri/src/agent/tools/exec/bash.rs` (verbatim — untouched neighbours):

```rust
pub(crate) const DEFAULT_BASH_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const MAX_BASH_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub(crate) fn clamp_timeout_ms(ms: u64) -> Duration
pub(crate) fn bash_exit_report(cancelled: bool, timed_out: bool, status: Option<std::process::ExitStatus>, pipes_held: bool) -> (Option<i32>, bool, Option<String>)
```

The **ADDED** function (exact signature this plan specifies):

```rust
pub(crate) fn cmd_input_redirection_diagnostic(text: &str) -> Option<&'static str>
```

PURE and cross-platform (a `contains` over `&str` — no `cfg`, no cmd glossary): returns the one-line
diagnostic when `text` carries cmd's exact error sentence, `None` otherwise. Reachable from
`tests/bash.rs` via `crate::agent::tools::exec::bash::cmd_input_redirection_diagnostic` (the module is
`pub mod bash` in `exec.rs` — NO `exec.rs` edit, NO new `mod` line needed in `tests/mod.rs`).

From `src-tauri/src/agent/tools/exec.rs` (verbatim — read-only for this task; the dispatch point):

```rust
pub async fn execute_tool(ctx: &ToolCtx, tool: &str, params: &Value) -> ToolResult   // "bash" => bash::exec_bash
```

Test fixtures the new tests sit on, from `tests/support.rs` (verbatim — RE-USED, not edited):

```rust
pub(crate) fn temp_cwd(tag: &str) -> crate::test_support::ScratchDir
pub(crate) fn ctx(cwd: &Path) -> ToolCtx                       // shell: Allow, hermetic
pub(crate) fn text_of(r: &ToolResult) -> &str
```

## Scope restrictions that shape every edit

- **No new executable argv, no new spawn-shape, no `childproc` change.** `timeout /t`'s failure is
  the intended policy's *output*; the fix is an explanation of that output. `closed_stdin` and
  `CREATE_NO_WINDOW` stay exactly as shipped (and stay the only stdin/flag facts, so census
  invariants A/B/C/E keep passing: no new `Command`-shaping line is added anywhere).
- **`bash_exit_report`'s signature and truth table do NOT change** — the diagnostic is a text-axis
  change in `exec_bash`, decided by the pure `cmd_input_redirection_diagnostic`, never by re-arguing
  the exit-status decision. `is_error` for a genuinely failed `timeout /t` run is `true`, by the
  report's PLAIN NON-ZERO-EXIT arm: no deadline fires (`timed_out` stays `false`), the child exits
  at once and its status IS observed, so `bash_exit_report(false, false, Some(status), pipes_held)`
  skips the `cancelled`/`timed_out` arms and falls to the final `match (code, signal)` arm
  `(Some(n), None) => (Some(n), true, None)` — "a normal non-zero exit needs no note — the code IS
  the report" (Step 2 writes down the ACTUAL arm and the ACTUAL resulting text); the ask is that
  the TEXT says why.
- **The trigger is byte-stable across `cmd` versions**: the sentence `ERROR: Input redirection is
  not supported` (reported by the issue; the modern `cmd` appends `, exiting the process immediately` —
  the `contains` target deliberately uses the stable prefix only).
- **Wording bans on the DESCRIPTION only** (the tool-RESULT text is not model-prompt text):
  the `#[cfg(not(unix))]` literal must keep containing NEITHER `read` NOR `subagent`
  (`the_bash_description_never_names_another_advertised_tool`, which the `worker_e2e` on the Windows
  leg backstops). The Step-3 sentence is scan-checked against both below.
- **`tool_specs.rs` is the single owner of the model-facing sentence** (ADR 0017 byte-identity):
  `AgentLoop::model_request` (`harness/loop.rs` — sends `tools[]` via
  `AgentLoop::advertised_tool_specs`), `AgentLoop::advertised_specs` (`harness/loop.rs`) and
  `worker/core.rs`'s prompt render (`loop_.advertised_specs()` →
  `build_main_prompt(&PromptContext { tools: &specs, .. })` — `harness/prompt.rs`) all
  consume the one `tool_specs()`; a resume replays the stored seq-0 prompt, so
  description edits only reach NEW sessions (unchanged fact, recorded here). No line numbers —
  the symbols are the citation (repo convention: cite the assertion/symbol, never the line).
- **Windows-only code TYPE-CHECKS locally, RUNS only on CI's `windows-latest` leg.** Local Windows
  proof is exactly `cargo check --target x86_64-pc-windows-gnu --all-targets` (verified exit 0,
  ~27.7 s warm). No `#[cfg(windows)]` body ever executes on a Linux host — see the CI-only verdict.
- **The `start /B` lock sentence asserts the SYMPTOM only** (the exact message the issue recorded),
  marks it as not-yet-understood and tracked — it must NOT assert a mechanism (e.g. that the file
  stays locked until the child exits), because the issue says it is unexplained. Filed follow-up is
  the owner of the mechanism question.

## TDD steps (test first, confirm it fails, then make it pass — per repo convention)

### Step 1 — the pure diagnostic, test-first (RED → GREEN, all platforms)

- **Edit** `src-tauri/src/agent/tools/exec/tests/bash.rs` — ADD this test (before the
  `#[cfg(windows)]` quoting block):

```rust
/// (issue #79 residual (a)) cmd's own `timeout /t` error — "ERROR: Input redirection is not
/// supported" — is a DOCUMENTED consequence of this tool's child policy, not a real defect:
/// `childproc::closed_stdin` forces stdin to NULL and `CREATE_NO_WINDOW` leaves the child with
/// no console input, so `timeout` cannot sleep. The bare sentence reads like a real error; this
/// test pins that a pure translator turns it into a diagnostic naming the policy and the workaround.
#[test]
fn cmd_input_redirection_is_diagnosed_as_the_no_console_input_tool_policy() {
    let cmd_error = "ERROR: Input redirection is not supported, exiting the process immediately";
    let note = crate::agent::tools::exec::bash::cmd_input_redirection_diagnostic(cmd_error);
    let note = note.unwrap_or_else(|| panic!("cmd's own error sentence must be translated"));
    assert!(
        note.contains("no console input"),
        "the cause is named: {note}"
    );
    assert!(
        note.contains("ping -n 20 127.0.0.1 > NUL"),
        "the workaround the description already recommends is restated: {note}"
    );
    // A line without cmd's sentence is untouched (a shape pin, not the effect).
    assert_eq!(
        crate::agent::tools::exec::bash::cmd_input_redirection_diagnostic("echo hi"),
        None
    );
    // The negative is pinned against FAILURE text, not just a success line
    // (reviewer round 2): a NON-ZERO-exit run whose text carries none of the
    // trigger sentences must stay untranslated too — the translator keys on
    // cmd's sentence alone, never on the exit code (that decision belongs to
    // `bash_exit_report`, whose plain `(Some(n), None)` arm keeps the run an
    // `is_error` with no note).
    assert_eq!(
        crate::agent::tools::exec::bash::cmd_input_redirection_diagnostic(
            "grep: cannot open 'missing.txt': No such file or directory"
        ),
        None,
        "a failing run's text with no trigger sentence must not be translated"
    );
}
```

- **Run** `cargo test --lib agent::tools::exec::tests::bash::cmd_input_redirection_is_diagnosed_as_the_no_console_input_tool_policy`
  → **RED** (compile error: the function does not exist yet — the expected failing first step).
- **Edit** `src-tauri/src/agent/tools/exec/bash.rs` — ADD the PURE function:

```rust
/// (issue #79 residual (a)) The one-line diagnostic for cmd's documented "no console input"
/// error, or `None`.
///
/// `timeout /t N` requires console input; a Tool child gets stdin forced to NULL
/// (`childproc::closed_stdin`) plus `CREATE_NO_WINDOW` — so `cmd` prints `ERROR: Input
/// redirection is not supported` and cannot sleep. That is the intended Tool-child policy, not a
/// defect in the tool — but the bare sentence reads like a real error, and the issue's residual
/// ask is precisely that it be DIAGNOSABLE. This function translates it.
///
/// PURE and cross-platform on purpose: the trigger is a byte match on cmd's own sentence (the
/// stable prefix; a modern `cmd` appends `, exiting the process immediately`), so the
/// translation is proven on Linux/macOS by the unit test, and the Windows leg proves the
/// sentence actually appears in a real run
/// (`bash_timeout_t_reports_a_no_console_input_diagnostic`, CI-only).
///
/// Deliberately NOT a child change, NOT a `bash_exit_report` change, NOT a new stdin rule:
/// the child policy is shipped and shipping — this explains its output to the model.
pub(crate) fn cmd_input_redirection_diagnostic(text: &str) -> Option<&'static str> {
    if text.contains("ERROR: Input redirection is not supported") {
        Some(
            "(note) `timeout /t` cannot wait here: this child has no console input (the tool \
             nulls its stdin and sets CREATE_NO_WINDOW), which is the documented Tool-child \
             policy and not a defect. Wait with `ping -n 20 127.0.0.1 > NUL`.",
        )
    } else {
        None
    }
}
```

- **Run again** → **GREEN**.

> **Case fix (reviewer round 2):** the emitted string says `no console input` — LOWERCASE, matching
> the test's `contains("no console input")` and the acceptance-criterion prose verbatim. The
> earlier draft wrote `NO console input` here: `str::contains` is case-sensitive, so the Step-1
> assert could never pass against it (RED→RED, not RED→GREEN). The TEST side is the shipped
> constraint (lowercase, as drafted); the EMITTED side is what changed, choosing lowercase so the
> diagnostic restates the already-shipped Windows `BASH_DESCRIPTION` sentence "this child has no
> console input" word-for-word — the cause phrase a model saw in the description is the cause
> phrase the result carries.

### Step 2 — wire the diagnostic into the tool result; Windows e2e (RED on CI, then GREEN)

- **Edit** `src-tauri/src/agent/tools/exec/bash.rs` — in `exec_bash`, where the captured bytes
  become the model-facing text, insert the diagnostic BEFORE the report-note append (which is
  untouched). The current block, verbatim:

```rust
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if let Some(note) = note {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&note);
        text.push('\n');
    }
```

  becomes: the same block, preceded by

```rust
    // (issue #79 residual (a)) translate cmd's bare "Input redirection is not supported" into
    // the documented no-console-input policy BEFORE the report note: the sentence they see
    // now carries the cause and the workaround. PURE — see the unit test.
    if let Some(diagnostic) = cmd_input_redirection_diagnostic(&text) {
        text.insert_str(0, diagnostic);
        text.push('\n');
    }
```

  (The diagnostic is prefixed so it is the FIRST thing the model reads; the post-loop
  report-note append is untouched — dedupe is impossible by construction, since the report note
  and the diagnostic never overlap in text: the note is the exit-report sentence, the diagnostic
  is the cmd-error translation.)
- **Edit** `src-tauri/src/agent/tools/exec/tests/bash.rs` — ADD the e2e next to the two existing
  `#[cfg(windows)]` tests, keeping their gate doc-comment convention (`#[cfg(windows)]`, not
  `not(unix)`; runs only on the Windows CI leg; locally compile-verified by the `--target` check):

```rust
/// (issue #79 residual (a), end-to-end) The real `timeout /t` run on Windows surfaces cmd's
/// raw error — and the tool result must ALSO carry the diagnostic the pure translator emits
/// (the no-console-input policy + the `ping` workaround). Deterministic on the CI runner:
/// `closed_stdin` + `CREATE_NO_WINDOW` guarantee the "Input redirection is not supported" path
/// (see the childproc module docs); a GREEN here means the diagnostic was attached to a real
/// run, not to a fixture line.
///
/// WHAT `is_error` ACTUALLY IS (reviewer round 2 — traced from `exec_bash`, not assumed):
/// the TIMEOUT command exits AT ONCE with the error (it cannot sleep without console input —
/// confirmed by MS/Broadcom/IBM write-ups), so `timeout_ms` NEVER fires: the read loop breaks on
/// the observed exit, `timed_out` stays `false`, and the report is built as
/// `bash_exit_report(false, false, Some(status), pipes_held)`. `cancelled` is false, the
/// `timed_out` arm is skipped, and the final `match (code, signal)` arm
/// `(Some(n), None) => (Some(n), true, None)` — "a normal non-zero exit needs no note — the
/// code IS the report" — is the ACTUAL arm handling it (the same arm the Linux `exit 3`
/// fixture drills).
///
/// ACTUAL RESULTING TEXT: `is_error: true`; `details.exitCode` = whatever NON-ZERO code this
/// `cmd` build's `timeout.exe` returned (the arm passes the real code through, no fabrication);
/// NO exit-report note (the arm's note is `None`); `cancelled: false`; and the model-facing
/// text is `cmd`'s own sentence followed by the diagnostic line.
///
/// WHY THE ASSERTION INSISTS ONLY ON NON-ZERO: the report's `(Some(n), None)` arm is an
/// ERROR for EVERY non-zero code, and the specific number `timeout` returns on this abort is
/// not pinned by any authoritative source available from Linux (MS's `timeout` docs list no
/// errorlevel for the redirect-abort; community write-ups say only "exits immediately"). A
/// guessed constant would RED on the CI leg the first time it disagreed with some `cmd` build —
/// exactly the blind spot the "match reality" review is guarding against. `is_error` + a
/// non-zero `exitCode` is what the arm ACTUALLY guarantees on every Windows build; if the
/// implementer observes a specific code on the CI leg, the assertion may be STRENGTHENED to it
/// in the implementing PR, citing the observed value.
#[cfg(windows)]
#[tokio::test]
async fn bash_timeout_t_reports_a_no_console_input_diagnostic() {
    let cwd = temp_cwd("bash-timeout-diag");
    let r = execute_tool(&ctx(&cwd), "bash", &json!({ "command": "timeout /t 1" })).await;
    let text = text_of(&r);
    assert!(
        r.is_error,
        "a failed `timeout /t` run is an error — the report's `(Some(n), None)` arm \
         (the wait did not happen): TEXT={text:?}"
    );
    assert_eq!(r.details.as_ref().unwrap()["cancelled"], false);
    let code = &r.details.as_ref().unwrap()["exitCode"];
    assert!(
        code.is_i64() && code.as_i64().unwrap() != 0,
        "the exit code is the child's REAL non-zero code (never fabricated, never 0): \
         DETAILS={:?}",
        r.details
    );
    assert!(
        text.contains("Input redirection is not supported"),
        "the repro itself must appear (cmd's own sentence): {text:?}"
    );
    assert!(
        text.contains("no console input"),
        "the diagnostic must name the no-console-input policy to the model: {text:?}"
    );
    assert!(
        text.contains("ping -n 20 127.0.0.1 > NUL"),
        "the diagnostic must restate the workaround: {text:?}"
    );
}
```

- **Run** locally: `cargo test --lib agent::tools::exec::tests::bash::` (host tests; the new test is
  compiled but not run) + `cargo check --target x86_64-pc-windows-gnu --all-targets` (the compile
  proof, exit 0 expected). On CI's `windows-latest` leg the new test must be observed **RED without
  the Step-2 wiring and GREEN with it** — that is the "failing first" proof for a Windows-only body,
  and the plan states plainly that this RED/GREEN pair is observable only on that leg.

### Step 3 — record the `start /B` file-lock limitation in the Windows description (RED → GREEN)

- **Edit** `src-tauri/src/agent/harness/tool_specs.rs` — extend the `#[cfg(not(unix))]` arm of
  `the_bash_description_names_the_shell_this_platform_actually_runs` with the lock-limitation pin:

```rust
        #[cfg(not(unix))]
        {
            assert!(
                d.contains("cmd.exe") && d.contains("/d /s /c"),
                "the Windows description must name the shell the executor picks — \
                 `exec_bash` runs `cmd.exe /d /s /c` here, got {d:?}"
            );
            assert!(
                !d.contains("sh -c"),
                "the Windows description must not promise `sh -c` (that was #79's \
                 lie: the model trusted a sentence about a shell it never got), got {d:?}"
            );
            assert!(
                d.contains("being used by another process"),
                "the Windows description must RECORD the `start /B` file-lock limitation \
                 (issue #79 residual (b) — unexplained, untracked in code), got {d:?}"
            );
        }
```

- **Run** `cargo test --lib agent::harness::tool_specs` → **RED** (the sentence is not in the const
  yet).
- **Edit** the `#[cfg(not(unix))] const BASH_DESCRIPTION` in the same file — append ONE sentence to
  the existing literal (the "Two traps" sentence stays; this becomes part of it):

```rust
    ... and `start` of a batch file can fail with "The process cannot access the file because
    it is being used by another process" — a known, not-yet-understood limitation (tracked in
    issue #79), not proof the command failed;
```

  (scan-checked: contains NEITHER `read` NOR `subagent` — "batch", "process cannot access the
  file", "not-yet-understood", "tracked" are all clean — so
  `the_bash_description_never_names_another_advertised_tool` and the Windows-leg `worker_e2e` stay
  green. It asserts the SYMPTOM and its unowned status only; it does NOT claim a mechanism.)
- **Run again** `cargo test --lib agent::harness::tool_specs` → **GREEN** (both pins: the shell-naming
  ones and the new lock-record one).

### Step 4 — full-scope verification

- **Run the scoped suite** from `src-tauri/`:

```sh
cargo test --lib agent::tools::exec::tests::bash::      # the fixture shut (incl. Step 1/2 tests)
cargo test --lib agent::harness::tool_specs             # description pins (Step 3)
cargo test --lib agent::childproc                        # untouched — must stay green (census A/B/C/E)
cargo check --target x86_64-pc-windows-gnu --all-targets   # THE local Windows compile proof
```

- **Run the full gate** (all five, per the status file's baseline):
  `pnpm test` and `pnpm build` from the repo root; `cargo test`, `cargo clippy --all-targets` (0
  warnings — the gating mechanism), `cargo fmt --check` from `src-tauri/`.
- The gate's Windows leg (CI) runs the new `#[cfg(windows)]` e2e for real.

## Acceptance criterion (a test that MEASURES true)

- **Primary (a) — `cmd_input_redirection_is_diagnosed_as_the_no_console_input_tool_policy`**
  (Step 1, runs on Linux/macOS/Windows, PURE): the translator is TRUE when cmd's exact sentence
  yields a note naming `no console input` and the `ping -n 20 127.0.0.1 > NUL` workaround, and
  `None` for a non-matching line. This is the diagnosability claim, measured without a Windows
  runner; the CI-only e2e `bash_timeout_t_reports_a_no_console_input_diagnostic` (Step 2)
  corroborates it on a real `timeout /t 1` run.
- **Primary (b) — the extended `the_bash_description_names_the_shell_this_platform_actually_runs`**
  (Step 3): the rendered Windows tool description now CONTAINS the recorded limitation
  ("being used by another process") — the model-facing half of "honest recorded limitation",
  asserted as a `contains` so a future reword can never silently drop the record.

## What remains CI-only (explicit)

- **`bash_timeout_t_reports_a_no_console_input_diagnostic` RUNS only on CI's `windows-latest` leg**
  (no wine, no msvc `lib.exe` toolchain here). Its RED-then-GREEN is observable only there; locally
  it is compile-proofed by `cargo check --target x86_64-pc-windows-gnu --all-targets`. NO Windows
  behaviour — including the claim that a real `timeout /t 1` produces cmd's sentence — is verified
  from Linux.
- The **Step-3 description pins** are Linux-visible (the modified test compiles and runs on every
  host); the `worker_e2e` substring backstop runs on the Windows leg.
- The **`start /B` lock root-cause** is NOT claimed explained or fixed; the mechanism question is
  the filed follow-up's (see Out-of-set needs). This task's in-set record is the symptom sentence;
  the deeper record lives in the research doc via Out-of-set needs.

## Out-of-set needs (for the orchestrator — this task does NOT edit these)

1. **`docs/research/windows-child-console-window.md`** (§Gaps / "Follow-ups deliberately left out of
   PR #36"): update the stale clause "`start /B`'s file-lock is unexplained" → "recorded as a
   known limitation in the Windows tool description (Task A1) and tracked in
   danielcherubini/archimedes issue #<follow-up>"; and mark the `timeout /t` residual as CLOSED by
   Task A1's diagnostic.
2. **File the follow-up issue** (owner: the explain-the-lock question): title-like
   "`start /B` on a batch file: 'the process cannot access the file because it is being used by
   another process' — root cause unowned (issue #79 residual (b))". Once filed, the orchestrator
   closes #79: fixed for (a), recorded-limitation + follow-up for (b), per the owner's status
   comment that (b) "is the reason this issue stays open".
3. **`docs/decisions/0060-…`** — NO change needed (the diagnostic touches text, not a child
   `Command`; invariants A/B/C/E are untouched). If the reviewer wants the "diagnostic text is not
   a CommandExt concern" boundary stated in prose, it lands here.

## Divergence log

- (empty — any deviation from the Steps is appended to THIS section by the orchestrator; the Steps
  themselves are the contract and are never edited in place)
