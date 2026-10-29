# Grounding report — `windows-exec`: the Windows child-process/command-line path of the bash tool

Branch: `feature/backlog-79-122-124-28` (dirty allowed; read-only session — no checkout/stash/restore/clean/commit).
Commit HEAD was `f5ba339` (`chore(release): bump version to 0.9.0`) when this was researched.
Scope (the task's Owns set): `childproc.rs`, `exec/tools/bash.rs`, `exec/tests/bash.rs`, `exec/tests/policy.rs`.

This file is a **grounding report** (no `status:` key in front-matter — it is not an executable plan).

---

## 0. One-paragraph summary of the area

`agent::childproc.rs` is the crate's single owner of every Windows-specific extension on a child `Command`
(`creation_flags(CREATE_NO_WINDOW)` and, since issue #79's PR #83, the raw `cmd.exe` command-line tail). The bash
tool (`agent/tools/exec/bash.rs`) builds its child exclusively through `childproc`, nulls the child's stdin
(`closed_stdin`), pipes stdout/stderr, sets `kill_on_drop(true)` and `current_dir(ctx.cwd)`, applies
`hostenv::for_child()` and (on Linux) the Landlock sandbox, then runs the read loop with a clamped deadline and
decides the report in the pure `bash_exit_report`. The tool description is per-platform in
`agent/harness/tool_specs.rs` (NOT in `bash.rs`). The two residual issue-#79 symptoms — `timeout /t` console-input
failure (diagnosability, not the defect) and `start /B`'s unexplained file-lock — are both **deliberately still
open**; the maintainer's status comment says the quoting bug itself is fixed and shipped.

---

## 1. `src-tauri/src/agent/childproc.rs` — every function that builds or mutates a Windows command line

The module doc declares two invariants and one wider remit (all verbatim from the `//!` header):

> `* **One owner for the creation flags.** creation_flags REPLACES rather than ORs … any future
> CREATE_SUSPENDED or CREATE_NEW_PROCESS_GROUP belongs **in this module** and nowhere else …
> [`command`] / [`command_std`] are therefore the only two constructors, and [`hide`] / [`hide_tokio`] stay private.`
>
> `* **`closed_stdin` is opt-in, never part of the constructor.** Nulling stdin is right for a **Tool child** …
> and wrong for every **Runtime child** …`

and, for the #79 seam:

> `What it DOES also own since #79: **the Windows shape of a Tool child's
> command line** — [`cmd_c_tail`] / [`append_cmd_c`]. Same reason as the
> creation flags: `raw_arg` arrives on the same
> `std::os::windows::process::CommandExt` trait as `creation_flags`, so a call
> site given one has a one-line `use` away from the other, and census
> invariant E keeps both call forms in this module.`

### 1.1 The constant and the flag-application functions

```rust
/// `CREATE_NO_WINDOW` — "The process is a console application that is being
/// run without a console window" (Process Creation Flags, Win32). A bare
/// `u32`, so this needs no `windows`/`windows-sys`/`winapi` dependency.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Blanket import: the std arm needs the trait; the tokio arm resolves to
// tokio's own INHERENT `creation_flags` (tokio-1.53.1/src/process/mod.rs:675).
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

fn hide(_cmd: &mut std::process::Command) {
    #[cfg(windows)]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}

fn hide_tokio(_cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}
```

### 1.2 The two constructors (only `Command::new` sites in production `src/`)

```rust
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    hide_tokio(&mut cmd);
    cmd
}

pub fn command_std<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    hide(&mut cmd);
    cmd
}
```

### 1.3 `closed_stdin` — the Tool-child stdin policy (the whole `timeout /t` premise)

```rust
/// Tool children only. Cross-platform — no `cfg`.
pub fn closed_stdin(cmd: &mut tokio::process::Command) {
    cmd.stdin(std::process::Stdio::null());
}
```

Note the deliberate asymmetry: **this is the only `Stdio::` write inside `childproc`** and it is stdin-only
(`Stdio::null()`), cross-platform, deliberately NOT in the constructors. stdout/stderr are chosen by each site
(`bash.rs` pipes them). Module doc: `stdout/stderr (each site chooses those)`.

### 1.4 `cmd_c_tail` and `append_cmd_c` — the #79 fix, verbatim

```rust
pub fn cmd_c_tail(command: &str) -> String {
    format!("/d /s /c \"{command}\"")
}
```

`cmd_c_tail` is **PURE and cross-platform** (`format!`), so its exact bytes are asserted on Linux/macOS too (see §1.5).

```rust
pub fn append_cmd_c(_cmd: &mut tokio::process::Command, _command: &str) {
    #[cfg(windows)]
    {
        // Resolves to tokio's INHERENT `raw_arg`
        // (tokio-1.53.1/src/process/mod.rs:420, inside `cfg_windows!`), which
        // forwards to std's. No second `use` — the module-level
        // `CommandExt as _` above is what `hide` needs and stays as it is.
        _cmd.raw_arg(cmd_c_tail(_command));
    }
}
```

- `append_cmd_c` takes `tokio::process::Command` (a `&mut` — it APPENDS via `raw_arg`, as its doc stresses).
- The `#[cfg(windows)]` block is the ONLY Windows-only code in the module body; the call itself is unconditional so
  a non-Windows build has one code path (the same trick `hide`/`hide_tokio` use with `_cmd` params).
- **Callers of `append_cmd_c`: exactly one in production** — `exec_bash`'s `#[cfg(not(unix))]` arm in
  `bash.rs` (details in §2.1). Invariant E's vacuity guard pins that count == 1.
- `raw_arg` use: ONE call, inside the `#[cfg(windows)]` block, on tokio's inherent `raw_arg` — never on std's
  trait at a call site. Tokio's inherent `creation_flags`/`raw_arg` resolve inside `CommandExt`-free code; the
  module's `use std::os::windows::process::CommandExt as _;` is what `hide` needs and is blanket-imported.

### 1.5 What stdio/creation-flag/console behaviour exists for the spawned child — full inventory

- **Creation flags:** only `CREATE_NO_WINDOW = 0x0800_0000`, set via `_cmd.creation_flags(CREATE_NO_WINDOW)` in
  `hide`/`hide_tokio` (both `#[cfg(windows)]`-gated), applied by the two constructors. No
  `CREATE_NEW_PROCESS_GROUP`, no `CREATE_SUSPENDED`, no `DETACHED_PROCESS`, no `STARTUPINFO`/`SW_HIDE` anywhere
  in the crate — module doc explicitly rules those out (`DETACHED_PROCESS` is documented to make
  `CREATE_NO_WINDOW` *ignored* and leaves the child free to `AllocConsole`).
- **stdin:** `cmd.stdin(std::process::Stdio::null())` — only via `closed_stdin`, only for Tool children.
- **Console subsystem of the parent:** `src/main.rs:2` — `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`.
- **No stdio is inherited in `bash.rs`:** stdout/stderr are piped there (see §2.1).

### 1.6 The census (tests in this module) — ADR 0060

- `create_no_window_is_the_documented_value` — `assert_eq!(CREATE_NO_WINDOW, 0x0800_0000_u32, …)`.
- `tool_child_reads_eof_on_closed_stdin` — builds `command("sh")` + `closed_stdin` + `-c cat`, asserts
  `out.status.success() && out.stdout.is_empty()`; documented caveat: on CI /dev/null stdin it passes regardless
  (a shape pin, not the effect — the effect is `bash_without_stdin_reaches_eof_instead_of_the_deadline`).
- `production_source_has_exactly_one_child_constructor` — invariants A (no `Command::new(` outside `SELF`), B (no
  `.creation_flags(` outside), C (every `childproc::command(` under `agent/tools/exec*` reaches `closed_stdin`
  before `spawn()`/`output()`; exactly 4 constructors with >= 3 `closed_stdin` because exec_bash's two cfg arms
  share one `spawn()`; and the Runtime-child files `agent/mcp/stdio.rs`, `agent/worker/client.rs`,
  `agent/interactive/sudo_exec.rs`, `commands/update.rs` contain NO `closed_stdin`), plus the vacuity guard
  (>= 8 `childproc::command*` calls in >= 4 files with >= 1 `command_std`).
- `production_crashlog_never_resolves_a_data_dir` — invariant D (unrelated to this area; ownership note only).
- `production_code_never_appends_a_raw_command_line_itself` — invariant E (the #79 half): no production line
  outside `SELF` contains `.raw_arg(`; vacuity guard asserts exactly 1 production line calls
  `childproc::append_cmd_c(` (and names `exec/bash.rs` as the expected owner).
- Census scope rule: scans `src/**/*.rs` production regions only; `tests/*.rs` and `/tests/` fixtures are
  deliberately outside — fixtures build raw `Command`s on purpose.

---

## 2. `src-tauri/src/agent/tools/exec/bash.rs` — text, invocation, timeout

### 2.1 How it invokes `cmd` vs `sh`

The two spawn branches share one later `closed_stdin`/`spawn()` — this is why census invariant C allows 4
constructors with >= 3 `closed_stdin` calls:

```rust
    #[cfg(unix)]
    let mut cmd = {
        let mut c = crate::agent::childproc::command("sh");
        c.arg("-c");
        c.process_group(0);
        c
    };
    #[cfg(not(unix))]
    // No `/C` here: the whole `/d /s /c "<command>"` tail is appended as ONE raw
    // argument below, by the module that owns the Windows shape of a child's
    // command line. `arg("/C")` + `arg(command)` is exactly what issue #79 is
    // about — see `childproc::append_cmd_c`.
    let mut cmd = crate::agent::childproc::command("cmd");
    // Tool child, so stdin is NULL, not inherited. …
    crate::agent::childproc::closed_stdin(&mut cmd);
    // …
    #[cfg(unix)]
    cmd.arg(&command);
    #[cfg(not(unix))]
    crate::agent::childproc::append_cmd_c(&mut cmd, &command);
    cmd.current_dir(&ctx.cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
```

So the Windows child is `cmd /d /s /c "<command>"` via `append_cmd_c`'s `raw_arg` — never `arg("/C")`. The full
set of child-affecting calls in `exec_bash`: `closed_stdin` → `append_cmd_c` or `arg` → `current_dir` →
`Stdio::piped()` twice → `kill_on_drop(true)` → (Linux) `Sandbox::create`/`install` → `hostenv::for_child().apply`.

### 2.2 Timeout / deadline handling

```rust
pub(crate) const DEFAULT_BASH_TIMEOUT: Duration = Duration::from_secs(300);
pub(crate) const MAX_BASH_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub(crate) fn clamp_timeout_ms(ms: u64) -> Duration {
    Duration::from_millis(ms).min(MAX_BASH_TIMEOUT)
}
```

- `exec_bash` computes `let timeout = params.get("timeout_ms").and_then(|v| v.as_u64()).map(clamp_timeout_ms);`
  and arms `let deadline = std::time::Instant::now() + timeout.unwrap_or(DEFAULT_BASH_TIMEOUT);`.
- The `tokio::select!` read loop has 5 arms: stdout read, stderr read, `child.wait()` (retired after the first
  status), `ctx.cancel.cancelled()`, and `tokio::time::sleep_until(deadline.into())` — which sets `timed_out = true`
  and breaks. Re-armed per iteration (`Sleep` is not `Unpin`).
- After the loop: `pipes_held` is LATCHED before the kill; `kill_bash_process_group(group_pid, &mut child)` when
  any pipe is open or status is unknown; a bounded `DRAIN_GRACE` (2 s) drain; one bounded post-loop `child.wait()`
  if status is still unknown; then the report via `bash_exit_report(cancelled, timed_out, status, pipes_held)`.

### 2.3 What happens to a child that blocks on stdin — the shipped policy

It can't block: `closed_stdin` is applied unconditionally (both cfg arms bind the same `cmd`), so stdin reads hit
EOF at once. The comment in the code:

> `Tool child, so stdin is NULL, not inherited. Nothing can ever feed this
> child: the Worker owns the only pipe a stdin could be (`worker/client.rs`
> holds the `BufWriter<ChildStdin>` for its whole life) and `tokio`'s
> `output()`/`spawn()` pipe stdout/stderr but never stdin — so an inherited
> handle is a live, silent pipe, and `cat` / `python -` / a `git credential`
> helper / an `ssh` password prompt blocks on it until the
> [`DEFAULT_BASH_TIMEOUT`] 300 s deadline. EOF is always the better answer.`

So `timeout /t` failing with "Input redirection is not supported" is the documented, intended consequence of the
Tool-child stdin policy — the issue's fixable ask is only the **diagnosability** of that error.

### 2.4 The exit-status report (`bash_exit_report`) — message inventory (relevant symbols)

Result tuple `(exit_code: Option<i32>, is_error: bool, note: Option<String>)`. Constants/messages a planner must
not collide with:

- `UNKNOWN`: `"The command's exit status is unknown (the process was never reaped): it may have SUCCEEDED, and its side effects may already have landed — inspect the resulting state before re-running this command."`
- `DEADLINE`: `"The command timed out and was killed at its deadline."` — asserted by fixtures via
  `contains("timed out")`, documented "BYTE-IDENTICAL to the pre-#94 note".
- `PIPE_HELD_SUCCESS` — two cfg'd consts (`#[cfg(unix)]` names the SIGKILL group kill; the `#[cfg(not(unix))]` twin
  drops the process-group sentence because Windows has no process-group kill).
- Cancel note: `"The command was cancelled before it finished; it may have completed part of its work."`
- Signal-death note: `"The command died on signal {sig} rather than exiting with a code."` — signal arm effectively
  unreachable on Windows (`exit_signal` is `#[cfg(not(unix))]` → always `None`).
- R2 note (pipes held, non-zero observed): `"The command FAILED with exit code {n} … not a deadline …"`.

`kill_bash_process_group`: `#[cfg(unix)]` negative-pid `libc::kill(-(pid as i32), libc::SIGKILL)` **plus** direct
`child.kill()`; `#[cfg(not(unix))]` is an explicit no-op arm (`let _ = pid;` + `child.kill().await`) — on Windows
only the direct child is killed, grandchildren survive.

### 2.5 The tool description string — `agent/harness/tool_specs.rs` (NOT in `bash.rs`)

`bash.rs` has no description literal; the description lives in `tool_specs.rs` as two cfg'd consts keyed on the
same predicate `exec_bash` branches on. Unix (byte-identical to the pre-#79 single literal):

```rust
#[cfg(unix)]
const BASH_DESCRIPTION: &str =
    "Run a shell command (sh -c; NOT re-parsed), capturing interleaved stdout+stderr.";
```

Windows:

```rust
#[cfg(not(unix))]
const BASH_DESCRIPTION: &str = "Run a shell command (cmd.exe /d /s /c; the string reaches \
    cmd.exe EXACTLY as written, so write quoting the way cmd.exe expects it), capturing \
    interleaved stdout+stderr. Two traps: `start` takes its FIRST quoted token as a window \
    title, so never pass `\"\"` there, and a background launch is verified by the log file \
    appearing — never by the launcher's exit code; `timeout /t` cannot run here (this child \
    has no console input) — wait with `ping -n 20 127.0.0.1 > NUL`.";
```

Both are consumed only via `tool_specs()` (the `"bash"` `ToolSpec`'s `description: BASH_DESCRIPTION.into()`), which
is the single source for `model_request` (`harness/loop.rs:911`), `advertised_specs` (`harness/loop.rs:926`), and
`worker/core.rs`'s prompt render (ADR 0017 byte-identity). **The Windows const is already the "mitigated in the
description only" half of the `timeout /t` symptom**, and already contains the `start` title-slot warning. Hard
wording constraint pinned by tests: must contain NEITHER `read` NOR `subagent` (worker_e2e asserts `!contains`, and
that e2e runs on the Windows CI leg).

---

## 3. The two test files — Windows assertions, convention

### 3.1 `agent/tools/exec/tests/bash.rs` — all `#[test]`/`#[tokio::test]` names

Cross-platform (ungated): `tool_result_serializes_is_error_camel_case`, `bash_happy_path_serializes_camel_case`
(asserts `text_of(r).trim_end() == "hi"` — trimmed because Windows `cmd` writes `hi\r\n`), the stdin re-exec pair
`bash_without_stdin_reaches_eof_instead_of_the_deadline` + `live_stdin_child_half` (re-exec's itself with fd 0 wired
to an open-and-silent `std::io::pipe`; child half asserts `cat` with `timeout_ms: 2000` finishes `exitCode: 0`,
`text == ""`, `!is_error`), `a_sandboxed_shell_runs_confined_or_fails_closed_visibly`, `a_sandboxed_shell_does_not_touch_the_path_tools`,
`bash_cancel_kills_child` (Windows-capable: fixture is `sleep 5`), `bash_timeout_kills_child` (Windows-capable), the
14 pure truth-table rows of `bash_exit_report_*` (all portable except the three unix-gated), `bash_output_capped_at_max`,
`bash_default_deadline_is_300s`, `bash_timeout_ms_is_clamped_to_the_max`.

`#[cfg(unix)]`-gated (15 occurrences of the gate in the file): `bash_nonzero_exit_is_error`, `bash_backgrounded_grandchild_killed_with_group`,
`bash_timeout_kills_a_child_that_closed_its_pipes`, `bash_cancel_kills_a_child_that_closed_its_pipes`,
`bash_success_after_closing_its_pipes_is_not_an_error`, `bash_nonzero_exit_after_closing_its_pipes_reports_its_real_code`,
`bash_pipe_held_completion_is_reported_as_success_not_a_timeout`, `bash_issue_94_repro_is_reported_as_success_not_a_timeout`,
plus `wait_status`/`exit_status_of` helpers and the three unix-only truth-table rows (`bash_exit_report_signal_death_names_the_signal`,
`bash_exit_report_cancelled_is_always_an_error`, `bash_exit_report_pipe_held_signal_death_is_still_a_signal_death`).
`#[cfg(target_os = "linux")]`: `CpuLoad`, `pin_to_cpu0`, `bash_success_survives_a_saturated_machine`.

**Windows-specific tests — `#[cfg(windows)]` (3 gate occurrences at lines 560/594/631; only 2 are test fns):**

```rust
#[cfg(windows)]
#[tokio::test]
async fn bash_passes_inline_double_quotes_through_to_cmd_verbatim() {
    let cwd = temp_cwd("bash-cmd-quotes");
    let r = execute_tool(&ctx(&cwd), "bash", &json!({ "command": "echo \"a b\"" })).await;
    assert!(!r.is_error, "the run succeeded: {:?}", text_of(&r));
    assert_eq!(r.details.as_ref().unwrap()["exitCode"], 0);
    assert_eq!(
        text_of(&r).trim_end(),
        "\"a b\"",
        "the quotes survive: {:?}",
        text_of(&r)
    );
}
```

```rust
#[cfg(windows)]
#[tokio::test]
async fn bash_an_inline_quoted_path_still_takes_the_branch() {
    let cwd = temp_cwd("bash-cmd-if-exist");
    let cmd = r#"if exist "%SystemRoot%\System32\cmd.exe" (echo FOUND)"#;
    let r = execute_tool(&ctx(&cwd), "bash", &json!({ "command": cmd })).await;
    assert!(
        text_of(&r).contains("FOUND"),
        "the quoted operand must reach `cmd` un-escaped or the branch is silently \
         skipped WHILE STILL EXITING 0 — issue #79's false success: {:?}",
        text_of(&r)
    );
}
```

Key surrounding comment (lines ~560+): `#[cfg(windows)]` rather than `#[cfg(not(unix))]` is deliberate — these spawn
`cmd.exe` which exists on no other platform and the app ships Windows/macOS/Linux only; **`not(unix)` IS Windows**.
Also: "These two tests are the fix's ONLY behavioural proof, and they run ONLY on CI's `windows-latest` leg. Locally
they are COMPILE-verified by `cargo check --target x86_64-pc-windows-gnu --all-targets`. Do NOT re-gate them behind a
unix gate and do NOT add a `return`-style skip …" and "Do NOT 'improve' them into an assertion on
`cmd.as_std().get_args()`" (std stores `Arg::Regular`/`Arg::Raw` yielding identical `OsStr`, so it passes with `arg`
and `raw_arg` alike).

**Test-convention answer for this repo's `#[cfg(windows)]` tests:** the two behavioural Windows tests are
`#[cfg(windows)]`-gated (not `not(unix)` — the comment explains why), they RUN only on CI's `windows-latest` leg,
and they are compile-proofed locally by the `--target x86_64-pc-windows-gnu --all-targets` check. The `#[cfg(unix)]`
counterparts follow an inconsistent naming pattern (some use `#[cfg(unix)]`, the load test uses
`#[cfg(target_os = "linux")]`), and their docs carry the "gate is POSIX SYNTAX, not quoting" line — the *decision*
tests were un-gated by the #79 fix.
A third `#[cfg(windows)]` occurrence at line 560 is the section comment itself. A `#[cfg(windows)]` count of `0` in
`tests/policy.rs`.

### 3.2 `agent/tools/exec/tests/policy.rs` — Windows-relevant content

**Zero `#[cfg(windows)]` gates.** Windows-relevant items are all portable assertions:

- `a_deny_rule_never_narrows_bash_because_rules_do_not_apply_to_the_shell` — spans Windows in the deny-all path
  construction: `NOT the literal "/"` because on Windows a lone `/` is not a component prefix of the verbatim
  `\\?\C:\…` canonical spelling; uses `crate::test_support::filesystem_root(cwd.path())`.
- `a_raw_protected_entry_still_refuses_a_canonical_path_under_it` — `#[cfg(not(unix))]` arm: no symlink privileges,
  relies on Windows' own raw-vs-canonical spelling (`canonicalize` returns `\\?\C:\…`).
- `a_raw_argument_still_refuses_against_canonical_protected_entries` — `#[cfg(unix)]`-gated, doc quotes the Windows
  `\\?\C:\…` mismatch as evidence.
- `bash_ignores_the_file_boundary`, the tier tests, the T03 rule pins (e.g. `a_recreated_protected_dir_is_refused_by_the_executor_with_the_protected_wording`,
  `a_write_into_a_protected_dirs_parent_stays_allowed`) — all portable.

### 3.3 Sibling test files (context, not in the Owns set)

- `tests/support.rs` — the hermetic `ctx`/`ctx_policy`/`temp_cwd`/`text_of`/`can_confine` fixtures the Windows tests
  build on.
- `tests/bash_hostenv.rs` — entirely `#[cfg(target_os = "linux")]` (the AppImage env-scrub call sites).

---

## 4. Exact verification commands

Toolchain: `rust-toolchain.toml` at repo root pins `channel = "1.99.0"` with `components = ["clippy", "rustfmt"]`.
Installed targets on this box include `x86_64-pc-windows-gnu` (cache present, 4.2G) and `x86_64-pc-windows-msvc`.

- **Local Windows compile proof (the documented one):**
  `cd src-tauri && cargo check --target x86_64-pc-windows-gnu --all-targets`
  Verified this session: **exit 0, 27.70 s warm** (`cargo check` on `--target` still compiles the host for
  proc-macros/build-scripts, so don't expect instant). `--all-targets` is required — it is what pulls in the
  `#[cfg(test)]`/`#[cfg(windows)]` test modules that `cargo check` alone skips.
- **Why msvc can't substitute:** the msvc target needs `lib.exe` (no Visual Studio toolchain here), and there is no
  wine — so `#[cfg(windows)]` code can only RUN on CI's `windows-latest` leg (ci.yml matrix is
  `[ubuntu-latest, windows-latest, macos-latest]`, Windows builds **debug**). release.yml includes
  `- os: windows-latest`.
- Scoped test runs (host):
  `cd src-tauri && cargo test --lib agent::tools::exec` — one-shot module-wide scoped run. Slower but complete:
  `cargo test --lib agent::tools::exec::tests::bash::`, plus the unit module `cargo test --lib agent::childproc`.
  (The Owns tests live in `src/`, so `--lib`; the crate is `[lib]`-only — see Cargo.toml line 15.)
- The behavioural Windows proof is the CI leg: the two `#[cfg(windows)]` tests above
  (`bash_passes_inline_double_quotes_through_to_cmd_verbatim`, `bash_an_inline_quoted_path_still_takes_the_branch`)
  run only on `windows-latest`.

---

## 5. Already-implemented overlap with the two residual symptoms — DO NOT RE-PLAN

The maintainer's status comment (issue #79, comment 6383608959, 2026-10-24) is the authoritative inventory:

> "Status after #83: **the quoting bug is fixed; this stays open for the symptom you said must not be closed by it.**"

### 5.1 Symptom (a) — `timeout /t N` console input (misleading failure)

Status in the comment: **"not a defect: `timeout` needs console input and Tool children get stdin forced to NULL +
`CREATE_NO_WINDOW`, the documented policy. Mitigated in the description only. Fixing the *diagnosability* (this
reads like a real error) remains a fair ask if anyone wants it."**

Already shipped, overlapping:
- `childproc::closed_stdin` → `cmd.stdin(std::process::Stdio::null())` — the stdin suppression itself (§1.3).
- `CREATE_NO_WINDOW` — the other half of the premise (§1.1).
- The Windows tool description already contains the mitigation sentence: `` `timeout /t` cannot run here (this child
  has no console input) — wait with `ping -n 20 127.0.0.1 > NUL` `` (§2.5).
- The stall-on-stdin failure mode itself has a shipped proof: `bash_without_stdin_reaches_eof_instead_of_the_deadline`
  asserts `cat` reaches EOF instead of the 2 s deadline (§3.1).
- What is NOT shipped: any special-casing of `timeout`'s `"ERROR: Input redirection is not supported"` text — no
  symbol anywhere maps that string to a diagnostic; the stream separator/`Stderr` is not classified per-line, so the
  sentence arrives at the model byte-for-byte from `cmd`.

### 5.2 Symptom (b) — `start /B`'s file-lock

Status in the comment: **"unexplained, no embedded quotes, and not closed by the above. This is the reason this
issue stays open."** No code touches `start`'s lock semantics anywhere. The only shipped artifact is the
description's warning: `` `start` takes its FIRST quoted token as a window title, so never pass `\"\"` there, and a
background launch is verified by the log file appearing — never by the launcher's exit code `` (§2.5), which
mitigates the title-slot confusion and the false-success verification, not the unexplained lock.

### 5.3 Fully shipped (do NOT re-plan) #79 work

- `childproc::cmd_c_tail` (`/d /s /c "{command}"`) + `append_cmd_c` (`raw_arg`) + census invariant E (ADR 0060
  amendment) — §1.4, §1.6.
- Per-platform `BASH_DESCRIPTION` in `tool_specs.rs` + its pins `the_bash_description_names_the_shell_this_platform_actually_runs`
  and `the_bash_description_never_names_another_advertised_tool`.
- The `#[cfg(unix)]` gates were removed from the decision-test groups gated because of the bug (per the comment).

---

## 6. Integration points OUTSIDE the Owns set — must stay compatible, must not be touched

1. **`$TOOLCHAIN`/CI:** `ci.yml` (`.github/workflows/ci.yml`) runs the three-OS matrix and is the only place the
   `#[cfg(windows)]` tests execute; `windows-latest` builds debug. `release.yml` ships Windows release (nsis) on
   `windows-latest`.
2. **Census invariants and ADR 0060 (`docs/decisions/0060-child-console-policy-owned-by-a-constructor.md`, incl. its
   #79 amendment):** any new Windows extension on a child `Command` (e.g. `CREATE_NEW_PROCESS_GROUP`, a
   console/input handle) must land inside `agent/childproc.rs` — a call site has no other `Command` to set it on,
   and invariants A/B/E scan for `.creation_flags(`, `.raw_arg(`, `Command::new(` and the `append_cmd_c` caller
   count (== 1).
3. **`harness/tool_specs.rs` owns the model-facing description:** `model_request` (`harness/loop.rs:911`),
   `AgentLoop::advertised_specs()` (`harness/loop.rs:926`) and `worker/core.rs`'s prompt render must keep ADR 0017's
   byte-identity; a resume replays the STORED seq-0 prompt, so description edits only reach new sessions. The
   `!contains("read") && !contains("subagent")` constraint is asserted by `src-tauri/tests/worker_e2e.rs`'s
   `full_turn_real_worker_canned_provider` on the Windows leg, and made Linux-visible by the tool_specs pin.
4. **`agent/worker/client.rs`, `agent/mcp/stdio.rs`, `agent/interactive/sudo_exec.rs`, `commands/update.rs`** — the
   Runtime children that spawn through `childproc::command(_std)` but must NEVER call `closed_stdin` (census
   invariant C's negative list; their stdins are pipes we write).
5. **`agent/tools/exec.rs`** — `execute_tool` dispatches `"bash" => bash::exec_bash`; the test-only re-exports
   (`bash_exit_report`, `kill_bash_process_group`, `DEFAULT_BASH_TIMEOUT`, `MAX_BASH_TIMEOUT`, `MAX_OUTPUT_BYTES`,
   `clamp_timeout_ms`, `DRAIN_GRACE`) are what the test files import.
6. **`agent/tools/exec/search.rs`** — second `closed_stdin` consumer (fd/rg fast paths: `command("fd")`,
   `command("rg")`), same Tool-child policy; keeps invariant C's exec count/closed count totals correct.
7. **`agent/hostenv::for_child().apply(&mut cmd)`** — applied in `exec_bash` after the sandbox; empty off Linux;
   must stay byte-identical for non-mount runs.
8. **`agent/policy` + `agent/tools/sandbox.rs`** — `ctx.file_policy.shell == Sandboxed` → Landlock install +
   fail-closed arms in `exec_bash` (`Sandboxed shell is unavailable on this platform/…`); sandbox unavailable off
   `target_os = "linux"`.
9. **`agent/interactive/mod.rs`** — `TOOL_EXEC_BASH_DEFAULT_TIMEOUT: Duration = Duration::from_secs(300)`; the
   native `DEFAULT_BASH_TIMEOUT` is documented as matching it (no outer timeout on the native `dispatch_tool`).
10. **`src/main.rs:2`** — `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`: the GUI-subsystem
    premise behind `CREATE_NO_WINDOW`'s relevance.
11. **Docs that state the current state and would drift if re-planned:** `docs/research/windows-child-console-window.md`
    (quotes both residual symptoms in the "Related, deliberately filed separately" / "Follow-ups deliberately left out
    of PR #36" sections, marked CLOSED for the quoting fix), and `docs/decisions/0060-…`. Check them before writing
    anything that claims a symptom is unaddressed.

---

## 7. Findings — the state of the code, as it is

- The #79 fix is fully merged-and-shipped in this tree (PR #83): `cmd_c_tail`/`append_cmd_c` with `raw_arg`, census
  invariant E, per-platform description, un-gated decision tests. The issue stays OPEN deliberately for exactly two
  residuals, both confirmed open in the maintainer's comment and in the research doc.
- Both residuals are **diagnostic/explanation gaps, not new code paths**: (a) `timeout /t`'s "Input redirection is
  not supported" has no translator; the stdin-NULL + `CREATE_NO_WINDOW` premise is documented and tested; (b)
  `start /B`'s file-lock has no owner at all — nothing in the tree references it beyond the description's two
  warnings and the open-issue text.
- Constraint surface is unusually dense for anyone touching this area: one owner module (`childproc`) for every
  Windows extension on a child `Command`, a text-scanning census enforcing it, a byte-frozen description with
  substring-bans that cross into a Worker e2e, POSIX-syntax-gated fixtures that must not be "fixed" by re-gating the
  wrong predicate, and CI-only behavioural tests for Windows.

### Sources

- `gh issue view 79 --repo danielcherubini/archimedes --json body,comments` — issue body + maintainer status
  comment (IC_kwDOUl7Qls8AAAABfH4kfw, 2026-10-24).
- `src-tauri/src/agent/childproc.rs` — full module (constants, constructors, `closed_stdin`, `cmd_c_tail`,
  `append_cmd_c`, 5 census tests).
- `src-tauri/src/agent/tools/exec/bash.rs` — `exec_bash`, `bash_exit_report`, `kill_bash_process_group`, unit tests.
- `src-tauri/src/agent/tools/exec/tests/bash.rs` — all fixture names/gates/assertions quoted above.
- `src-tauri/src/agent/tools/exec/tests/policy.rs` — portable policy pins incl. the Windows `\\?\C:\…` arms.
- `src-tauri/src/agent/tools/exec.rs` — `execute_tool` dispatch + test-only re-export list.
- `src-tauri/src/agent/tools/exec/tests/{mod,support}.rs` — module seams and hermetic fixtures.
- `src-tauri/src/agent/harness/tool_specs.rs` — both `BASH_DESCRIPTION` consts, `tool_specs()`, description pins.
- `src-tauri/src/agent/worker/client.rs`, `agent/mcp/stdio.rs`, `agent/interactive/sudo_exec.rs`,
  `agent/tools/exec/search.rs`, `agent/tools/exec/tests/bash_hostenv.rs` — integration points and sibling patterns.
- `docs/decisions/0060-child-console-policy-owned-by-a-constructor.md` (incl. #79 amendment) and
  `docs/research/windows-child-console-window.md`.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src-tauri/Cargo.toml` (`[lib]` only),
  `rust-toolchain.toml`, `src-tauri/src/main.rs:2`.
- Verified live: `cargo check --target x86_64-pc-windows-gnu --all-targets` → exit 0, 27.70 s warm.
