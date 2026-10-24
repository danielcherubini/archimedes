---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 79
done-when: On Windows a `bash` command containing an embedded double quote reaches `cmd.exe` byte-for-byte — `tasklist /FI "IMAGENAME eq x.exe"`, `findstr /n /i "a b c" f`, `node -e "…"` and `start /B "" cmd /c "…"` behave as written instead of arriving as `\"…\"`, so the misleading errors, the silent exit-0 no-ops and the modal "Windows cannot find '\'" dialog go away — and the `bash` tool description tells the model which shell it is actually on.
---

# Task 8 — Windows `bash`: the command line goes to `cmd.exe` unmodified, and the tool description stops lying (issue #79)

**Goal:** Stop Rust's `Command::arg` from escaping the model's command line before `cmd.exe` sees it, and make the `bash` tool description truthful per platform (it currently promises `sh -c; NOT re-parsed` on the one platform where that is false twice over).

**Architecture:** Two files, one seam. `agent/childproc.rs` — the module that already owns every Windows extension on a child `Command` (`CREATE_NO_WINDOW`, ADR 0060) — gains the `cmd.exe` command-line tail: a pure `cmd_c_tail(command) -> String` that formats `/d /s /c "<command>"`, plus `append_cmd_c(&mut Command, &str)` which appends that tail with `raw_arg` (no quoting, no escaping). `exec_bash`'s `#[cfg(not(unix))]` arm stops passing `/C` as an `arg` and hands the command string to that seam instead of `cmd.arg(&command)`. `harness/tool_specs.rs` turns the single `bash` description literal into a `#[cfg(unix)] / #[cfg(not(unix))]` const pair keyed on the SAME predicate `exec_bash` branches on. The census in `childproc.rs` gains a fifth invariant so `.raw_arg(` cannot escape the module either.

**Tech Stack:** Rust 1.99.0 (pinned in `src-tauri/rust-toolchain.toml`), `std::os::windows::process::CommandExt::raw_arg` (stable since 1.62 — verified present in the pinned std), `tokio::process::Command::raw_arg` (inherent, `tokio-1.53.1/src/process/mod.rs:420`, inside `cfg_windows!`), no new dependency.

---

## Parallelisation

**Verdict:** SERIAL — one task of the issue-triage backlog, and the parent roadmap already fixes it to the serial column ("owns `tool_specs.rs`; T9 edits it next"). The reason is measured, not assumed: `archimedes` is **one compilation unit**, so any sibling's half-finished `.rs` edit makes this task's `cargo test` fail to compile (planted-error experiment, `docs/roadmap/issue-triage-backlog-status.md` §"Why the waves collapsed to serial"). T9 needs this task landed in `tool_specs.rs`.

Consequence for the executor: **run the FULL gate**, not a scoped run — a scoped `cargo test --lib <filter>` compiles the whole crate here anyway, so scoping buys nothing.

---

## Files

- Modify: `src-tauri/src/agent/childproc.rs` (the seam + the module doc + census invariant E + the pure tail test)
- Modify: `src-tauri/src/agent/tools/exec/bash.rs` (the `#[cfg(not(unix))]` arm and the command hand-off)
- Modify: `src-tauri/src/agent/harness/tool_specs.rs` (the `BASH_DESCRIPTION` const pair + two description tests)
- Test: `src-tauri/src/agent/tools/exec/tests/bash.rs` (two `#[cfg(windows)]` behavioural tests + the `exit_status_of` / `a_death_with_no_exit_code` helpers + four un-gated decision tests)
- Modify: `docs/decisions/0060-child-console-policy-owned-by-a-constructor.md` (one appended `## Amendment` section)

No file is created. No frontend file, no `Cargo.toml`, no CI workflow, no lockfile. `docs/research/windows-child-console-window.md` is deliberately NOT touched here (see *Recorded, not fixed here*).

---

## Context — why this exists, and what was verified against the tree

Issue #79: on Windows, six different commands failed in one session with errors that all pointed away from the cause, two of them were **false successes** (a launch that never happened reported `exitCode: 0`, and the agent told the user a build was "running in the background"), and one raised a **modal `Windows cannot find '\'` dialog on the user's desktop** from a background tool call.

### Verified starting facts (all re-read against this tree, not from the issue)

- `src-tauri/src/agent/tools/exec/bash.rs` has exactly the two arms the issue describes: `#[cfg(unix)]` → `childproc::command("sh")` + `arg("-c")` + `process_group(0)` (lines 97-103), `#[cfg(not(unix))]` → `childproc::command("cmd")` + `arg("/C")` (lines 104-109). Both arms bind one `cmd`; `closed_stdin` is called once for both (line 120); **line 121 is `cmd.arg(&command);`** — the model's whole command string into std's Windows command-line builder.
- The escaping is real and is std's, not a shell's. `append_arg` in `library/std/src/sys/args/windows.rs:173` (pinned toolchain's vendored std) is `Quote::Auto` for a regular arg: `arg_bytes.iter().any(|c| *c == b' ' || *c == b'\t')` wraps the WHOLE string in an outer quote pair, and for every embedded `"` it emits `2n+1` backslashes (`cmd.extend((0..=backslashes).map(|_| '\\'))`). `make_command_line` (`sys/process/windows.rs:880`) joins argv0 (always quoted) and the args with single spaces. `cmd /s`'s documented rule then strips the leading quote and the last quote, so the `\"` sequences **stay in the text `cmd` parses**. `raw_arg` is `Arg::Raw` → `Quote::Never` → `escape = false`: nothing is touched.
- **`raw_arg` is stable and reachable; `force_quotes` is not.** `std/src/os/windows/process.rs:258` `#[stable(feature = "windows_process_extensions_raw_arg", since = "1.62.0")] fn raw_arg<S: AsRef<OsStr>>(…)`; `process.rs:198` marks `force_quotes` `#[unstable(feature = "windows_process_extensions_force_quotes", issue = "82227")]`. `tokio::process::Command::raw_arg` exists at `tokio-1.53.1/src/process/mod.rs:420` (inside `cfg_windows!`, which expands to `#[cfg(any(all(doc, docsrs), windows))]`) and forwards to `self.std.raw_arg`. `Cargo.lock` pins `tokio 1.53.1`.
  **Compile-checked on this host** (isolated `rustc --edition 2021 --target x86_64-pc-windows-gnu --crate-type lib` probe in `/tmp`, so it took no lock on the project's `target/`): a `raw_arg` call through `std::os::windows::process::CommandExt` for `tokio`-style usage compiles clean for the gnu target.
- `agent/childproc.rs` is the crate's only owner of Windows `Command` extensions. Its census (`production_source_has_exactly_one_child_constructor`) enforces **A** (no `Command::new(` outside `SELF = "agent/childproc.rs"`), **B** (no `.creation_flags(` outside `SELF`), **C** (every `childproc::command(` under `agent/tools/exec*` reaches `closed_stdin` before its next `spawn()`/`output()`; exactly **4** constructors and ≥ 3 `closed_stdin` in that prefix; no Runtime-child file mentions `closed_stdin`), plus a separate **D** (`production_crashlog_never_resolves_a_data_dir`). It scans `src/**/*.rs`, drops comment lines (`is_comment`), and stops at each file's first non-comment `#[cfg(test)]`. **There is no invariant on `.raw_arg(` today** — that is the hole this task closes.
- The census reads **source text**, not compiled code, so a `#[cfg(not(unix))]` call site is visible to it on Linux, macOS and Windows alike. Every new invariant in this task depends on that and is therefore platform-independent.
- `harness/tool_specs.rs` has **no `cfg` outside its `mod tests`** (only `#[cfg(test)]` at line 334). The `bash` description is the single literal at lines 13-15: `"Run a shell command (sh -c; NOT re-parsed), capturing interleaved stdout+stderr."` It is the only occurrence of that sentence in the repo (grepped: Rust, `src/`, `scripts/`, ADRs) — **no frontend mirror of any tool description exists**, and the `list_tools` IPC command (`src/commands/settings.rs:83`) returns NAMES only, so `pnpm test` cannot see this change.
- **ADR 0017's invariant holds across a `cfg`'d literal.** `AgentLoop::model_request` (`loop.rs:907`, `tools: Self::advertised_tool_specs(…)` at 911) and `AgentLoop::advertised_specs` (`loop.rs:926`) both call the SAME `advertised_tool_specs` → `tool_specs()`; `agent/worker/core.rs:361` renders `loop_.advertised_specs()` into `build_main_prompt`, whose `<tools>` body is `- {name}: {description}` (`prompt.rs:54-63`). One process, one function, one target OS ⇒ byte-identical within a process, which is exactly what ADR 0017 requires. A Supervisor and its Worker are the same binary on the same machine (`env!("CARGO_BIN_EXE_archimedes")`), so no cross-platform skew is even constructible. A resume replays the **stored** seq-0 system message verbatim (`loop/emit.rs:100`), so an already-running session keeps its old sentence — already true of every description edit, and correct.
- **No test pins the `bash` description today.** `tool_specs.rs`'s own tests pin the advertised **parameter keys** only; `loop/tests/tools_enabled.rs` pins exact descriptions for `list_agents`, `list_skills` and `read_skill` — not `bash`. `commands/settings.rs::list_tools_returns_a_sorted_list_of_the_native_harness_tools` asserts names only.
- **⚠ But one test constrains it, and it is a landmine.** `src-tauri/tests/worker_e2e.rs:591` (inside `full_turn_real_worker_canned_provider`, which is **not** `cfg`-gated, so it runs on the Windows CI leg) asserts, over the rendered `<tools>` section with only `bash` enabled: `!tools_section.contains("read") && !tools_section.contains("subagent")`. So the new Windows description **must not contain the substring `read` or the substring `subagent`** — which rules out `already`, `thread`, `reading`, `reads`, `spread`, `credential`-adjacent wording, anything. This is a hard requirement below (section 4), and section 6 turns it into a guard that runs on Linux too.
- `src-tauri/src/agent/tools/exec/tests/bash.rs` holds **exactly 13 `#[cfg(unix)]` gates** (lines 333, 405, 456, 506, 564, 572, 586, 598, 610, 630, 668, 708, 759 — counted on this tree), with comments conceding the cause: `bash_nonzero_exit_is_error` "exits 0, so `is_error` was false on the Windows runner"; `bash_backgrounded_grandchild_killed_with_group` "Under `cmd /C` the command line does not even parse as written".
- The Windows arm's `#[cfg(not(unix))]` predicate is what the description must key on. The app ships Windows / macOS / Linux only, so `not(unix)` **is** Windows for every artifact `release.yml` builds — that equivalence is why the new behavioural tests are `#[cfg(windows)]` (they spawn `cmd.exe`, which exists nowhere else) while the product arm stays `not(unix)`.

### Two reported symptoms this task deliberately does NOT fix (the issue says so)

Record these in the commit body; do not "improve" them away:

1. **`timeout /t 20 /nobreak >nul` → `ERROR: Input redirection is not supported`** contains no quotes, so nothing was escaped. Its cause is the deliberate Tool-child stdin policy (`childproc::closed_stdin` → `Stdio::null()`, plus `CREATE_NO_WINDOW`) meeting `timeout`'s need for console input. Changing that policy is out of scope and would be a worse bug (see `childproc`'s module docs). **What IS in scope is the honesty half** the issue names ("the fixable part is only that the failure is indistinguishable from a real error"): the new Windows description says plainly that `timeout /t` cannot run here and gives the `ping -n 20 127.0.0.1 > NUL` shape. That is the whole fix for this symptom, and it belongs in a tool description, not in the spawn path.
2. **`start /B prog.bat` → "The process cannot access the file because it is being used by another process"** has no embedded quotes either, is **unexplained**, and the issue states it "should not be closed by fixing quoting". Leave the code alone. The new description does publish the two `start` facts that are independently known (its first quoted token is a window title; a background launch is verified by the log file appearing, not by the launcher's exit code) because those are mitigations for the *observed false success*, not a claim to have explained the sharing error.

---

## What to implement

### 1. `src-tauri/src/agent/childproc.rs` — the seam (this is the load-bearing part)

Add two public items after `closed_stdin`, and update the module doc.

```rust
/// The `cmd.exe` tail that runs `command` exactly as written: `/d /s /c "<command>"`.
///
/// PURE and cross-platform on purpose — it is a `format!`, so the exact bytes
/// are asserted on Linux and macOS too (`the_cmd_c_tail_escapes_nothing`). That
/// is the only honest local proof this fix has: std renders the command line
/// inside `CreateProcess` and exposes no getter (the same introspection hole as
/// `creation_flags`, rust-lang/rust#96794), so nothing runnable can read back
/// what `cmd.exe` was actually handed.
///
/// * `/d` suppresses the `HKCU\Software\Microsoft\Command Processor\AutoRun`
///   command, so a machine-wide AutoRun cannot splice itself in front of every
///   agent command.
/// * `/s` makes `cmd.exe` follow its documented rule for the quotes around the
///   rest of the line: if the first character is a quote, strip it and remove
///   the last quote. Our outer pair is therefore consumed and EVERY INNER QUOTE
///   SURVIVES — which is the entire point of building the tail by hand.
pub fn cmd_c_tail(command: &str) -> String {
    format!("/d /s /c \"{command}\"")
}

/// Appends [`cmd_c_tail`] to a Tool child's `Command` with NO quoting and NO
/// escaping (`raw_arg`). Windows-only in effect; the call is unconditional so a
/// non-Windows build has one code path.
///
/// Why not `arg`: `Command::arg` escapes for a program that follows
/// `CommandLineToArgvW`, and `cmd.exe` does not. `append_arg`
/// (`library/std/src/sys/args/windows.rs:173`) wraps any string containing a
/// space in an outer quote pair and turns every embedded `"` into `\"`; `cmd /s`
/// consumes only the OUTER pair, so the `\"` stay in the text `cmd` parses.
/// `tasklist /FI "IMAGENAME eq x.exe"` therefore arrives as
/// `/FI \"IMAGENAME eq x.exe\"` — and `start`'s title-slot rule turns that
/// wreckage into a modal `Windows cannot find '\'` dialog on the user's desktop
/// (issue #79, CVE-2024-24576 / CVE-2024-43402 are the same contract failure).
///
/// It lives HERE rather than at the call site for the same reason the
/// `CREATE_NO_WINDOW` flag does: `raw_arg` sits on the same
/// `std::os::windows::process::CommandExt` trait as `creation_flags`, and the
/// census keeps that trait's call forms inside this module (invariant E — see
/// the census's docs and ADR 0060's amendment). A call site that could reach
/// `raw_arg` can reach `creation_flags` by the same one-line `use`.
pub fn append_cmd_c(_cmd: &mut tokio::process::Command, _command: &str) {
    #[cfg(windows)]
    {
        // Resolves to tokio's INHERENT `raw_arg` (tokio-1.53.1/src/process/mod.rs:420),
        // which forwards to std's. No second `use` — the module-level
        // `CommandExt as _` above is what `hide` needs and stays as it is.
        _cmd.raw_arg(cmd_c_tail(_command));
    }
}
```

- The `_cmd` / `_command` naming is the **existing idiom in this file**: `hide(_cmd: &mut std::process::Command)` calls `_cmd.creation_flags(…)` under `#[cfg(windows)]` and `cargo clippy --all-targets -- -D warnings` is green on both Linux and Windows CI today, so a used underscore binding is proven safe here (`clippy::used_underscore_binding` is pedantic and not enabled). Do NOT "clean up" the underscores — dropping them makes the non-Windows build fail with an unused binding.
- Update the module doc's paragraph that begins `//! What this module deliberately does NOT own:`. It currently lists the environment, stdout/stderr and any `STARTUPINFO`/`DETACHED_PROCESS` route. Add, in the same voice, that the module now DOES also own **the Windows shape of a Tool child's command line** (`cmd_c_tail` / `append_cmd_c`), with the one-sentence reason (same `CommandExt` trait as `creation_flags`; census invariant E), and keep the rest of the sentence true — it still does not own the env (`hostenv`), stdout/stderr, or the Unix `sh -c` convention.
- Do NOT touch `CREATE_NO_WINDOW`, `hide`, `hide_tokio`, `command`, `command_std`, `closed_stdin`, `is_comment`, `production_region`, `rust_files`, the existing census test, or invariant D.

### 2. `src-tauri/src/agent/childproc.rs` — census invariant E

Add a NEW `#[test]` in the existing `mod tests` (do not extend the existing census fn — its name and failure messages are about the constructor, and a fresh fn keeps each failure message about one thing). It reuses the module-private `rust_files`, `production_region`, `is_comment` and `SELF` helpers.

```rust
/// Invariant E — only `childproc` may append a raw command line to a child.
#[test]
fn production_code_never_appends_a_raw_command_line_itself() { /* see the rules below */ }
```

Rules the test must implement, in this order:

1. Resolve `src_root` = `env!("CARGO_MANIFEST_DIR")/src`, walk with `rust_files`, sort the paths, and build each file's `relative()` path exactly as the existing census does (`strip_prefix(&src_root)`, `to_string_lossy().replace('\\', "/")` — the `\` normalisation is what keeps this test honest on the Windows leg, where `strip_prefix` yields backslashes).
2. **Vacuity guard FIRST, in the census's own style** (a scanner that sees nothing must fail loudly, not report a clean bill): count lines containing `childproc::append_cmd_c(` across every production region EXCEPT `SELF`, and `assert_eq!(count, 1, …)`. Exactly one, in `exec/bash.rs` (`crate::agent::childproc::append_cmd_c(…)` contains that substring). This does double duty: it proves the scanner can see the API it polices, AND it pins that the `bash` child's command line still goes through the owner. `SELF` is excluded and would score 0 anyway — inside `childproc` the tail is reached as a bare `cmd_c_tail(`, and the definition line reads `pub fn append_cmd_c(`, which does not contain `childproc::append_cmd_c(`. Say so in the comment. That `1` is meant to be brittle: a second site wanting a `cmd.exe` tail must have this conversation, not quietly widen the surface. (Comment lines mentioning `childproc::append_cmd_c` are filtered by `is_comment` before any match, so prose about the seam cannot inflate the count.)
3. **The invariant itself:** no production line outside `SELF` contains `.raw_arg(` — anchored on the CALL form, exactly as invariant B anchors `.creation_flags(`, so prose naming `raw_arg` (this module's own docs, the `CommandExt` comment) cannot false-positive; `is_comment` filters those anyway. Collect violations as `"{rel}:{line}"` and `assert!(violations.is_empty(), …)`.
4. The failure message must say WHY, in the census's voice: `raw_arg` is on the same `CommandExt` trait as `creation_flags`, so a call site that reaches one has one `use` away from the other, and `creation_flags` REPLACES rather than ORs — which is the whole reason ADR 0060 put the trait in this module. Point at `childproc::append_cmd_c` as the route.
5. State the inherited blind spot in the doc comment, as invariants A/B/D do: this is text matching, so a string literal containing `.raw_arg(` would also trip it (a false alarm costing one rename, the safe direction), and `is_comment`'s `*`-prefix rule still drops any line whose trimmed text starts with `*`. Also inherit and STATE the census's existing scope rule: `production_region` returns an empty `Vec` for `**/tests.rs` and anything under `/tests/`, so test fixtures are outside E just as they are outside A and B — a fixture may build a raw `Command` or append raw text on purpose, and a fixture that wants the policy opts in explicitly. E therefore guards production code, not the outside view.

**Why this invariant is needed at all, and what it does NOT prove** (write this into the test's doc comment — the census's existing header demands this honesty from every invariant): the seam is technically reachable from `exec/bash.rs` without breaking invariants A/B/C, because `raw_arg` appends an argument rather than constructing a `Command` or setting a flag. Without E, the next contributor adds `raw_arg` at a call site, and the `use std::os::windows::process::CommandExt` that brings it in is the same one that makes a stray `creation_flags(...)` compile — silently un-hiding every child and re-opening a console window per command, which is the bug ADR 0060 exists to prevent. E is a LINT: it keeps the trait's call forms in one file; it does NOT prove `cmd.exe` received the right bytes.

### 3. `src-tauri/src/agent/tools/exec/bash.rs` — use the seam

- Line 68 doc: `` /// Execute a shell command (`sh -c` on Unix, `cmd /C` on Windows) inside `` → say `cmd /d /s /c`. Keep the rest of the doc paragraph (the `CREATE_NO_WINDOW` / Landlock sentences) intact.
- Replace the Windows arm (lines 104-109) with ONE constructor call on ONE line — **keep both `cfg` arms and keep exactly two `childproc::command(` calls in this file**. Invariant C asserts `agent/tools/exec*` holds **exactly 4** constructors (2 here + 2 in `search.rs`) and the census's own vacuity guard asserts ≥ 8 `childproc::command*` calls tree-wide across ≥ 4 files, so collapsing the two `cfg` arms into one constructor reddens both:

  ```rust
  #[cfg(not(unix))]
  // No `/C` here: the whole `/d /s /c "<command>"` tail is appended as ONE raw
  // argument below, by the module that owns the Windows shape of a child's
  // command line. `arg("/C")` + `arg(command)` is exactly what issue #79 is
  // about — see `childproc::append_cmd_c`.
  let mut cmd = crate::agent::childproc::command("cmd");
  ```

- Leave the `#[cfg(unix)]` arm (lines 97-103) and `crate::agent::childproc::closed_stdin(&mut cmd);` (line 120) EXACTLY as they are, and keep `closed_stdin` **before** the command hand-off. Invariant C's window runs from each `childproc::command(` line forward to the next line containing `spawn()` or `output()` and demands a `closed_stdin` inside it; both arms' windows close at the same `cmd.spawn()` (line 182), so the rule is satisfied from either arm. (Comments are dropped by `is_comment` before any of that matching, so the new prose cannot move a window boundary — but keep the order anyway, because the ordering is the policy, not the lint.)
- Replace line 121 `cmd.arg(&command);` with the platform pair, and put the reason in a comment above it:

  ```rust
  // The command string reaches the shell UNMODIFIED on both platforms — that is
  // this tool's whole contract. Unix: `sh -c` takes it verbatim. Windows: `arg`
  // would wrap it in an outer quote pair and escape every embedded `"` as `\"`,
  // and `cmd /s` strips only the OUTER pair, so the escapes stay visible to
  // command parsing — inline quoting becomes unusable and `start`'s title-slot
  // rule turns the wreckage into a modal dialog on the user's desktop (issue #79).
  // Hence the raw tail, appended inside `childproc` (census invariant E).
  #[cfg(unix)]
  cmd.arg(&command);
  #[cfg(not(unix))]
  crate::agent::childproc::append_cmd_c(&mut cmd, &command);
  ```

- Everything after that (`current_dir`, stdio, `kill_on_drop`, the confined tier, `hostenv::for_child().apply`, the read loop, `bash_exit_report`, `kill_bash_process_group`) is **untouched**. In particular do NOT add backslash-escaping logic to `cmd_c_tail` (a command ending in `\` or a `\"` tail is the known `raw_arg` hazard; pnpm, Zed and VS Code's `copilot_shim` all pass the string through and this task does too — inventing a cmd-escaping ruleset is how CVE-2024-24576 happened) and do NOT translate POSIX-isms (`>nul`, `2>/dev/null`): the issue lists that as the alternative to fixing quoting, not in addition to it.

**Blast radius, so a reviewer can bound it.** For a command containing **no** embedded `"`, the rendered line is unchanged in effect: `append_arg` wrapped it and `cmd`'s outer-quote strip unwrapped it, so the child saw the same text. The behaviour that changes is precisely (a) commands containing `"`, and (b) commands ending in a backslash (old: `dir C:\` rendered `"dir C:\\"` because trailing backslashes are doubled before the closing quote; new: `dir C:\`). Nothing else moves.

### 4. `src-tauri/src/agent/harness/tool_specs.rs` — a truthful description per platform

Add a module-level const pair above `tool_specs()` (the file gains its first `cfg` outside `mod tests`; nothing else in the crate reads these literals, and the census does not scan for `cfg`):

```rust
#[cfg(unix)]
const BASH_DESCRIPTION: &str = "…";
#[cfg(not(unix))]
const BASH_DESCRIPTION: &str = "…";
```

and use `description: BASH_DESCRIPTION.into(),` in the `bash` `ToolSpec`.

- **The `cfg` predicate must be `unix` / `not(unix)` — the SAME predicate `exec_bash` branches on — not `windows`.** Keying the sentence and the executor to one predicate is what makes them unable to disagree.
- **The Unix literal must be BYTE-IDENTICAL to today's string**: `Run a shell command (sh -c; NOT re-parsed), capturing interleaved stdout+stderr.` Keep it as a single-line literal (do not re-flow it with a `\` continuation — a stray space in a `\`-continued literal is invisible in a diff and this string is printed into every session prompt).
- The Windows literal is exactly:

  ```rust
  #[cfg(not(unix))]
  const BASH_DESCRIPTION: &str = "Run a shell command (cmd.exe /d /s /c; the string reaches \
      cmd.exe EXACTLY as written, so write quoting the way cmd.exe expects it), capturing \
      interleaved stdout+stderr. Two traps: `start` takes its FIRST quoted token as a window \
      title, so never pass `\"\"` there, and a background launch is verified by the log file \
      appearing — never by the launcher's exit code; `timeout /t` cannot run here (this child \
      has no console input) — wait with `ping -n 20 127.0.0.1 > NUL`.";
  ```

  **HARD REQUIREMENT: the expanded string must contain neither the substring `read` nor the substring `subagent`** (case-sensitive), because `src-tauri/tests/worker_e2e.rs:591` asserts `!tools_section.contains("read") && !tools_section.contains("subagent")` on the rendered `<tools>` section with only `bash` enabled, and that test runs on the Windows CI leg. That forbids `already`, `reads`, `reading`, `thread`, `spread`, and any mention of other tool names. The wording above is written around it (`takes`, not `reads`) — if you reword it, re-check both substrings before committing, and note the check is also a test (section 6) so a future rewording reddens on Linux rather than only on Windows.
  Proportionality: the issue lists five workarounds. Publish **three** clauses, not five — `start`'s title slot, verify-a-background-launch-by-its-log-file, and `timeout /t`'s real reason. A tool description is token budget spent on every call of every session; the rest (`.bat`/`.ps1` for complex quoting, script files over `node -e`) is inferable from "the string reaches cmd.exe exactly as written".
- Add the reason to the const's doc comment: `exec_bash` picks `sh -c` on Unix and `cmd.exe /d /s /c` on Windows, so one unconditional sentence is a lie on one of them, and the lie is what made #79 expensive (six detours, because the model — and the reader — trusted `NOT re-parsed`).
- Add the ADR 0017 verdict to that same doc comment, in one or two sentences: the `cfg` does not break "the `<tools>` section is byte-identical to the `tools[]` API param", because `model_request` (`loop.rs:911`) and `advertised_specs` (`loop.rs:926`) call the same `advertised_tool_specs` in one process, `worker/core.rs` renders that same value into the prompt, and one process has one target OS. A resume replays the STORED prompt, so an in-flight session keeps its old sentence.
- Do not touch any other spec, `exec_param_keys`, or the two existing tests.

### 5. `src-tauri/src/agent/childproc.rs` — one pure test for the tail (the local proof)

In the existing `mod tests`, in that module's `/// Claim:` style, **not `cfg`-gated** (it must run on Linux — this is the strongest local proof available). One `#[test]`, several assertions:

- `the_cmd_c_tail_is_the_documented_form_and_escapes_nothing`
  - `assert_eq!(cmd_c_tail("echo hi"), "/d /s /c \"echo hi\"");` — the documented `/d /s /c "<cmd>"` shape, outer quotes present, nothing else added.
  - The issue's own reported command, verbatim. Write BOTH sides as raw strings — an escaped-quote expectation here is easy to mistype, and a mistyped expectation is a false RED:
    `let q = r#"tasklist /FI "IMAGENAME eq x.exe""#;` then `assert_eq!(cmd_c_tail(q), r#"/d /s /c "tasklist /FI "IMAGENAME eq x.exe"""#);` — that is, the expected value is `/d /s /c "` + the command unchanged + `"`: ONE outer pair of quotes and nothing else.
  - **The regression assertion, and the reason the test exists:** `assert!(!cmd_c_tail(q).contains("\\\""), …)` — no `\"` sequence anywhere. `Command::arg` would have produced one for every quote in the string; `raw_arg` produces none. Name `Command::arg`/`append_arg` and issue #79 in the message so a reader knows what a green means.
  - `assert!(cmd_c_tail(q).contains(q));` — the command survives **byte-for-byte** inside the tail. Also pin the empty command: `assert_eq!(cmd_c_tail(""), "/d /s /c \"\"");` (`cmd` with an empty tail is a no-op, and it used to be rendered `""` by `arg` too, so nothing moves).
  - Say in the doc comment what this does NOT prove: it pins the string we hand to `raw_arg`; it cannot show what `cmd.exe` did with it (no command-line getter exists on a `Command`, the same hole as `creation_flags`), which is why the two `cmd.exe` tests in section 7 exist on the Windows leg.

### 6. `src-tauri/src/agent/harness/tool_specs.rs` — description tests

In that module's `mod tests`, two new `#[test]`s that run on **every** platform:

- `the_bash_description_names_the_shell_this_platform_actually_runs`
  - Read the description out of `tool_specs()` (find `bash`), not the const — the test's value is that the advertised spec is honest, not that a const equals itself.
  - `#[cfg(unix)] { assert_eq!(d, "Run a shell command (sh -c; NOT re-parsed), capturing interleaved stdout+stderr."); assert!(!d.contains("cmd.exe"), …); }` — the exact-equality arm is also the guard that the move to a const did not disturb a single byte of the Unix sentence.
  - `#[cfg(not(unix))] { assert!(d.contains("cmd.exe") && d.contains("/d /s /c"), …); assert!(!d.contains("sh -c"), "…"); }`
  - Say in the doc comment that this is the #79 lie-as-regression: the sentence must name the shell the executor actually picks, and must not name the other one.
- `the_bash_description_never_names_another_advertised_tool`
  - `assert!(!d.contains("read"), …)` and `assert!(!d.contains("subagent"), …)` on the `bash` description, ungated.
  - Name `src-tauri/tests/worker_e2e.rs` (`full_turn_real_worker_canned_provider`, the `!tools_section.contains("read")` assertion) in the message as the reason: the `<tools>` section is rendered from the advertised specs, so a `bash` description that merely contains the word `read` reddens a Worker e2e on the Windows leg only — the worst place to discover it. This test moves that constraint to a Linux-visible failure.

### 7. `src-tauri/src/agent/tools/exec/tests/bash.rs` — the behavioural proof (Windows-only, by necessity)

Two new tests, **`#[cfg(windows)]`** (they spawn `cmd.exe`; `not(unix)` is Windows on every artifact this app ships, so they are equivalent here — say that in the comment). Both go through `execute_tool(.., "bash", ..)` like every other test in the file (`use super::support::*;` already provides `temp_cwd` / `ctx` / `text_of`).

- `bash_passes_inline_double_quotes_through_to_cmd_verbatim`
  - `execute_tool(&ctx(&cwd), "bash", &json!({ "command": "echo \"a b\"" }))`
  - `assert!(!r.is_error, …)`, `assert_eq!(r.details.as_ref().unwrap()["exitCode"], 0, …)`, and the discriminator `assert_eq!(text_of(&r).trim_end(), "\"a b\"", "the quotes survive: {:?}", text_of(&r));`
  - Why this discriminates: `cmd`'s `echo` prints its operand verbatim, **quotes included**, so the quotes in the OUTPUT are the evidence that the string arrived with its own quoting intact. Under `Command::arg` the child received `echo \"a b\"` and printed `\"a b\"`. Say exactly that in the doc comment.
- `bash_an_inline_quoted_path_still_takes_the_branch`
  - `let cmd = r#"if exist "%SystemRoot%\System32\cmd.exe" (echo FOUND)"#;` — a quoted operand inside a `cmd` BUILTIN conditional, so the test needs no third-party executable and cannot depend on a runner's tooling.
  - `assert!(text_of(&r).contains("FOUND"), "…: {:?}", text_of(&r));`
  - Why this is the important one: under escaping the line becomes `if exist \"%SystemRoot%\System32\cmd.exe" (echo FOUND)`, the literal path starts with a backslash, the condition is false, **and `cmd` still exits 0**. That is the issue's false-success shape (its `start /B "" cmd /c "…"` printed `Access is denied.` after the marker and still reported `exitCode: 0`, and the agent reported a build as "running in the background") reproduced with a builtin. The assertion is on the OUTPUT, not the exit code, precisely because the exit code is the thing that lies.
  - `%SystemRoot%\System32\cmd.exe` exists on every Windows including the CI runners; `cmd` expands env vars inside quotes.
  - **State the RED as a prediction, not a measurement.** This host cannot run `cmd.exe`, so the pre-fix behaviour above is derived from `append_arg`'s rules plus `cmd`'s documented quote handling — the same derivation the issue made and had confirmed by its own `echo` reproduction. The commit body must say "predicted RED on Windows, confirmed on the `windows-latest` leg", never "observed RED here". If CI's first run of this test comes back RED **after** the fix, check first whether that runner expands `%SystemRoot%` inside a quoted operand; if it does not, replace the variable with a literal path in the fixture — do NOT weaken the assertion to the exit code, which is the thing that lies.
- Comment on both: ⚠ these are the fix's ONLY behavioural proof and they run **only on CI's `windows-latest` leg**. Locally they are COMPILE-verified by `cargo check --target x86_64-pc-windows-gnu --all-targets`. **Do not re-gate them to `#[cfg(unix)]`, and do not add a `return`-style skip** — a test that silently does not run on the platform it guards is the exact blind spot #79 was filed about (13 `#[cfg(unix)]` gates in this file today; section 8 takes four of them back, and these two must never join the remainder).
- Do NOT write a test that asserts `cmd.as_std().get_args()` to "prove" the quoting. `get_args()` returns the stored `Arg`s, and std stores `Arg::Regular` and `Arg::Raw` such that both yield the identical `OsStr` — so such a test passes with `arg` and with `raw_arg` alike. It looks like proof and is not; invariant E plus the two tests above are the real pair. Put this in the commit body or a comment so nobody writes it later.

### 8. `src-tauri/src/agent/tools/exec/tests/bash.rs` — widen the Windows leg of the exit-status decision

The issue's complaint is not only that tests are gated, but that **the Windows leg passes while the behaviour is untested**. Several of the 13 gates are not about POSIX syntax at all — `bash_exit_report_*` is a PURE decision table and is `#[cfg(unix)]` solely because its helper `wait_status` uses `ExitStatusExt::from_raw(i32)`, which is unix-only. `std::os::windows::process::ExitStatusExt::from_raw(u32)` exists (stable since 1.12), so the decision table has a Windows analogue and should run there.

- Replace the unix-only helper with a platform pair, and rename it to say what it builds:

  ```rust
  /// A `wait` status for a child that EXITED with `code` (never a signal death).
  /// Unix encodes an exit as `code << 8` in the `waitpid` value; Windows stores
  /// the exit code itself. `exit_signal` returns `None` on Windows, so a signal
  /// row has no Windows analogue and stays unix-only.
  #[cfg(unix)]
  fn exit_status_of(code: i32) -> std::process::ExitStatus { /* ExitStatusExt::from_raw(code << 8) */ }
  #[cfg(not(unix))]
  fn exit_status_of(code: i32) -> std::process::ExitStatus { /* use std::os::windows::process::ExitStatusExt; from_raw(code as u32) */ }
  ```

  **Keep the existing unix-only `wait_status(raw: i32)` helper exactly as it is** (the raw-`waitpid` form); it is what a real signal death is built from.
- Add a THIRD platform-paired helper for the one row that needs "a death with no exit code":

  ```rust
  /// A status the report can give NO code to. On unix that is a real signal
  /// death (`waitpid` value 9 → SIGKILL). Windows has no signal deaths and
  /// `exit_signal` is `None` for every status there, so `bash_exit_report`'s
  /// `(_, Some(sig))` arm is UNREACHABLE on Windows; the nearest thing the
  /// platform offers is the code a crash returns, which the report still
  /// refuses to call a success. The asymmetry is the point — do not "unify" it.
  #[cfg(unix)]
  fn a_death_with_no_exit_code() -> std::process::ExitStatus { wait_status(9) }
  #[cfg(not(unix))]
  fn a_death_with_no_exit_code() -> std::process::ExitStatus {
      // STATUS_ACCESS_VIOLATION, built directly rather than through
      // `exit_status_of` (which takes an `i32` exit code, and this value is
      // only meaningful as a `u32` NTSTATUS).
      use std::os::windows::process::ExitStatusExt as _;
      std::process::ExitStatus::from_raw(0xC000_0005)
  }
  ```

- **Un-gate** these four (they become cross-platform, so they run on the Windows leg for the first time): `bash_exit_report_success_is_not_an_error`, `bash_exit_report_nonzero_exit_is_an_error_with_its_real_code`, `bash_exit_report_timeout_is_an_error_that_says_timed_out`, `bash_exit_report_success_is_the_only_non_error_row`. At their call sites, `wait_status(0 << 8)` / `wait_status(3 << 8)` become `exit_status_of(0)` / `exit_status_of(3)`, and `bash_exit_report_success_is_the_only_non_error_row`'s third row `wait_status(9)` becomes `a_death_with_no_exit_code()`. Its comment gains one line: on unix that row is a SIGKILL death, on Windows a crash code — the table's claim is that **exactly one row is a success**, and `ok == vec![0]` holds on each platform for its own reason.
- **Leave `#[cfg(unix)]` on the two rows that consume a signal death**: `bash_exit_report_signal_death_names_the_signal`, and `bash_exit_report_cancelled_is_always_an_error` (its status list contains `wait_status(9)` and asserts `code.is_none() || code == Some(0)` — a signal death has no code, and there is no Windows status that is a signal death, so the row cannot port). Extend both comments to say why: `exit_signal` is `#[cfg(not(unix))] → None` by design (`bash.rs:381`), so on Windows there is no signal to name and no codeless status. That is a real platform limit, not a dodge — say so, so the next reader does not "helpfully" un-gate them into a tautology or, worse, into a Linux RED.
- **Leave all six POSIX-fixture behaviour gates exactly as they are** (`bash_nonzero_exit_is_error`, `bash_backgrounded_grandchild_killed_with_group`, `bash_timeout_kills_a_child_that_closed_its_pipes`, `bash_cancel_kills_a_child_that_closed_its_pipes`, `bash_success_after_closing_its_pipes_is_not_an_error`, `bash_nonzero_exit_after_closing_its_pipes_reports_its_real_code`). Their fixtures are POSIX syntax — `1>&2`, `;` sequencing, `( … ) &`, `exec >&- 2>&-`, a fractional `sleep` — none of which has a `cmd` equivalent, and Windows has no process-group kill at all (`bash.rs:473` is an explicit no-op arm). #79 does not change any of that; claiming otherwise would be the same dishonesty this task is fixing. Add ONE sentence to the file's existing gate comments **only** if it is true: the quoting fix does not make these fixtures runnable on `cmd`, because they are gated on POSIX syntax, not on quoting.
- After the change: **4 fewer** decision-test gates (13 `#[cfg(unix)]` attributes → 9 for the tests) and the two new platform-paired helpers add 2 more unix attributes, so `grep -c '#\[cfg(unix)\]' src/agent/tools/exec/tests/bash.rs` reads **11**, not 13 — 6 POSIX behaviour fixtures + `wait_status` + the 2 signal-consuming rows + the 2 new helper arms. Quote the exact before/after in the commit body (the issue names 13, so a reviewer will look for it) and state which four gates came off and which two the helpers added. Do NOT report "13 → 9" without that breakdown; it is the sort of number that reads well and is wrong.

### 9. `docs/decisions/0060-child-console-policy-owned-by-a-constructor.md` — an Amendment

Append a `## Amendment (2026-10-23) — the seam also owns the `cmd.exe` command-line tail (#79)` section, in the ADR's own voice, 1-2 paragraphs. It must record: the module's remit widened from "the creation flags" to "**every Windows-specific extension on a child `Command`**", because `raw_arg` arrives on the same `std::os::windows::process::CommandExt` trait as `creation_flags`; that the census gained **invariant E** (no `.raw_arg(` outside the module, with a one-caller vacuity guard on `childproc::append_cmd_c(`) for exactly that reason; and that the ADR's central honesty claim is unchanged — the census is still a LINT and the "no window appears / the bytes arrive correctly" half is still owed one manual run of the packaged Windows build. Do not renumber, do not edit the existing sections, do not touch the `superseded-by:` front-matter.

---

## Steps

- [ ] Read, in this order: `src-tauri/src/agent/childproc.rs` (module docs, the two constructors, `closed_stdin`, and the whole census including `is_comment` / `production_region` / `rust_files` / `SELF`), `src-tauri/src/agent/tools/exec/bash.rs` (lines 60-200), `src-tauri/src/agent/tools/exec/tests/bash.rs` (all 13 `#[cfg(unix)]` gates and their comments), `src-tauri/src/agent/harness/tool_specs.rs` (the `bash` spec and its `mod tests`), `src-tauri/tests/worker_e2e.rs:570-595`, `docs/decisions/0060-…md`, `docs/research/windows-child-console-window.md` (§"Related, deliberately filed separately" and §"Follow-ups deliberately left out of PR #36"), and `docs/decisions/0017-native-session-system-prompt.md`.
- [ ] Re-derive the escaping yourself so the claim is yours: read `append_arg` in `$(rustc --print sysroot)/lib/rustlib/src/rust/library/std/src/sys/args/windows.rs` (the `Quote::Auto` branch and the `2n+1` backslash loop) and `raw_arg`'s `#[stable]` attribute in `…/library/std/src/os/windows/process.rs`. Confirm `force_quotes` is `#[unstable]` on the pinned toolchain — if a future toolchain stabilises it, this plan's shape does not change, but record the fact in the commit body.
- [ ] Write the failing pure test (section 5) FIRST, in `childproc.rs`'s `mod tests`. Run `cargo test --lib agent::childproc` — it must fail to COMPILE (`no function cmd_c_tail`). That is the RED; a compile failure is legitimate RED for a new seam, and must be described honestly in the commit body, not dressed up as an assertion failure.
- [ ] Implement `cmd_c_tail` + `append_cmd_c` + the module-doc paragraph. Run `cargo test --lib agent::childproc` — the new test and all pre-existing census tests pass.
- [ ] Write invariant E (section 2) and run `cargo test --lib childproc` — it must pass while `exec/bash.rs` still uses `cmd.arg(&command)`, because the guard counts `childproc::append_cmd_c(` calls and there are none yet. **So make it fail on purpose first, once, with plants that COMPILE on Linux** (the census reads text, but `cargo test` still compiles the crate, so a literal `.raw_arg("x");` call would be a compile error here rather than a census RED): (a) drop `let _probe: &str = ".raw_arg(";` on a production line of `exec/bash.rs` — a string literal is the documented false-positive direction and the correct plant for a text lint, and the report must name `agent/tools/exec/bash.rs:<line>`; (b) add a second `crate::agent::childproc::append_cmd_c(&mut cmd, "probe");` immediately after the existing one — that is a real cross-platform no-op call, so it compiles, and the vacuity guard must fire with `left: 2, right: 1`. Read both failures, then delete both plants and re-run. A census invariant that has never been observed RED is a census invariant nobody trusts — this is the same "plant a violation" discipline the existing census records in `docs/research/windows-child-console-window.md`.
- [ ] Implement `exec/bash.rs` (section 3). Run `cargo test --lib childproc` again — invariant C must still see exactly **4** `childproc::command(` (2 in `bash.rs`, 2 in `search.rs`) and ≥ 3 `closed_stdin`, and E must now report `childproc::append_cmd_c(` exactly once. If C fires, you collapsed the two `cfg` arms into one constructor; put the Windows arm back.
- [ ] Run `cargo test --lib agent::tools::exec::tests::bash` on Linux. Every pre-existing test must stay green — the Unix arm is byte-identical, so a new failure here means you touched the Unix path.
- [ ] Implement `tool_specs.rs` (section 4) and its two tests (section 6). Before committing, expand the Windows literal in a scratch test or a `println!` and **grep the expanded string for `read` and `subagent`** — a `\`-continued literal hides a mid-word space, and `worker_e2e.rs:591` is only green-by-accident if you skip this.
- [ ] Write the two `#[cfg(windows)]` behavioural tests (section 7). On Linux they do not exist, so `cargo test` neither runs nor fails them — that is expected, and is exactly why the next step is not optional.
- [ ] Do section 8 (widen the exit-status decision table). Run `cargo test --lib agent::tools::exec::tests::bash` — the Linux count is UNCHANGED (un-gating adds tests to Windows, not to Linux), and every decision test still passes with the `exit_status_of` helper. If a decision test newly reddens on Linux, the helper encodes the wrong thing for unix: `from_raw(code << 8)`.
- [ ] **The Windows-arm type-check (this is the local half of the proof, and it is allowed):** `cargo check --target x86_64-pc-windows-gnu --all-targets` from `src-tauri/`. It must exit 0 — that compiles the `#[cfg(not(unix))]` arm, `append_cmd_c`'s Windows body (so `raw_arg` is genuinely resolved against tokio 1.53.1 on the pinned compiler) and both `#[cfg(windows)]` tests. Note in the commit body that it took a lock on `target/`; run it while nothing else is editing the tree (it is a serial task, so nothing is). There is no `wine` on this host and the `msvc` target needs `lib.exe`, so **Windows tests cannot be RUN here** — do not claim otherwise.
- [ ] `cargo fmt` then `cargo fmt --all -- --check` from `src-tauri/`.
- [ ] `cargo clippy --all-targets -- -D warnings` — 0 warnings. Watch for: an unused-variable / unused-binding on `append_cmd_c`'s parameters on the non-Windows build (the `_`-prefix idiom is the fix, exactly as `hide` does it), and an unused-import if you add any `use` inside `append_cmd_c` rather than resolving tokio's inherent `raw_arg`.
- [ ] Run the FULL gate: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check` from `src-tauri/`; `pnpm test`, `pnpm build` from the repo root.
  - Baseline not to regress: `cargo test` **1363 passed / 0 failed / 4 ignored**, `pnpm test` **3051 tests / 149 files**, clippy 0 warnings, fmt clean. (`docs/roadmap/issue-triage-backlog-status.md` still prints 1360 — it is one task stale, T4's +3; use 1363 and let the orchestrator refresh the doc.)
  - Expect **1367** on Linux (+2 `childproc`, +2 `tool_specs`; the two `cmd.exe` tests and the four newly un-gated decision tests are Windows-only additions, so they add nothing here). `pnpm` must be byte-identical — no frontend file changes.
- [ ] Commit with message: `fix(windows): the bash tool passes the command line to cmd.exe unmodified (#79)`. In the body: the `append_arg` mechanism in one line, the two out-of-scope symptoms named as out-of-scope (`timeout /t` = the stdin policy, mitigated in the description only; `start /B prog.bat` = unexplained, explicitly NOT closed), and the honest verification split — locally 1367 green + `cargo check --target x86_64-pc-windows-gnu --all-targets` clean, behaviour proven on CI's `windows-latest` leg.

---

## Acceptance criteria

- [ ] `cmd_c_tail(command)` returns `/d /s /c "<command>"` with the command inside byte-for-byte and **no `\"` sequence**, asserted by a test that RUNS on Linux (`the_cmd_c_tail_is_the_documented_form_and_escapes_nothing`).
- [ ] `exec_bash`'s Windows arm passes the command through `childproc::append_cmd_c` (i.e. `raw_arg`); `cmd.arg(&command)` is gone from `bash.rs`, and no file outside `agent/childproc.rs` contains `.raw_arg(` — enforced by census invariant E, whose own eyesight is guarded by requiring exactly one `childproc::append_cmd_c(` caller. Invariants A, B, C and D are unchanged and green (4 constructors, ≥3 `closed_stdin`, no raw `Command`, no external `creation_flags`, crashlog clean).
- [ ] The Unix path is byte-identical: `sh -c` + `arg(&command)` + `process_group(0)`, and the Unix `bash` description string is unchanged to the byte.
- [ ] The advertised `bash` description names the shell this platform actually runs and never names the other one; the Windows one contains neither `read` nor `subagent`; both are asserted by ungated tests.
- [ ] The ADR 0017 invariant is stated as preserved (one process, one `tool_specs()`, one target OS) in the const's doc comment, and `pnpm test` is unchanged at 3051/149 — the frontend never sees a tool description.
- [ ] Two `#[cfg(windows)]` behavioural tests exist and go through `execute_tool(.., "bash", ..)`: the `echo "a b"` quote-survival test and the `if exist "<quoted path>" (echo FOUND)` branch test. Neither is `#[cfg(unix)]`-gated, neither self-skips, and both are named in the commit body as CI-only proof.
- [ ] The four portable `bash_exit_report_*` decision tests run on the Windows leg (ungated), with a documented platform-correct `exit_status_of` helper; the two signal-consuming rows stay unix-only **with the reason** (`exit_signal` is `None` off unix by design); the six POSIX-fixture behaviour gates stay unix-only and unchanged, and `grep -c '#\[cfg(unix)\]'` on the file drops from 13 to 11 (four decision gates removed, two added by the new helper arms — state the breakdown, never a bare count).
- [ ] `cargo check --target x86_64-pc-windows-gnu --all-targets` exits 0 on this host (the Windows arm and its tests type-check). No Windows test was RUN locally, and the plan/commit says so.
- [ ] `cargo test` 1367 / 0 failed / 4 ignored on Linux, clippy 0 warnings, `cargo fmt --all -- --check` exit 0, `pnpm test` 3051/149, `pnpm build` exit 0.
- [ ] CI's `windows-latest` leg (`cargo test`, ungated) goes green with the two `cmd.exe` tests and the four newly un-gated decision tests actually executing — that is the acceptance event this host cannot produce; the orchestrator records the Windows test count when it lands.
- [ ] ADR 0060 carries the Amendment recording the widened remit and invariant E, and still describes the census as a LINT.

---

## Locally provable vs CI-only — say this in the commit body, not in a footnote

| Claim | Where it is proven |
|---|---|
| `cmd_c_tail` produces the documented `/d /s /c "<cmd>"` form with zero escaping | **Here**, on Linux (pure function, ungated test) |
| The seam compiles for Windows on the pinned 1.99.0 toolchain + tokio 1.53.1 | **Here**, `cargo check --target x86_64-pc-windows-gnu --all-targets` (also confirmed out-of-tree with an isolated `rustc` probe, so it cost no `target/` lock) |
| No production code outside `childproc` reaches `raw_arg` | **Here**, on every platform (the census reads source TEXT, so `#[cfg(not(unix))]` call sites are visible from Linux) |
| The advertised description is honest for the platform it was built for, and never names another tool | **Here** (ungated tests, both `cfg` arms covered by their own assertions) |
| `cmd.exe` actually receives the bytes unmodified; `echo "a b"` prints `"a b"`; `if exist "<path>"` takes its branch | **CI `windows-latest` only.** No `wine` here; `msvc` needs `lib.exe`; and std renders the command line inside `CreateProcess` with no getter, so nothing runnable can read it back |
| `tasklist /FI "…"`, `findstr /n /i "a b c"`, `node -e "…"` and `start /B "" cmd /c "…"` work as written, and the modal `Windows cannot find '\'` dialog is gone | **Not proven by any test.** The two `cmd.exe` tests stand in for the shape (an inline quote survives; a builtin conditional with a quoted operand takes its branch). The issue's own reproduced `echo` output is the observed RED on real Windows; a human confirming the reporter's six commands is the closing evidence, same as ADR 0060's "one manual run of the packaged build" for the window half |

There is **no local RED** for the `raw_arg` path itself: `append_cmd_c` is a no-op off Windows, so nothing on this host can observe the difference between the fix and the bug. The REDs this task can honestly show are (a) the compile failure before `cmd_c_tail` exists, (b) invariant E reddening on the two plants described in the Steps (a `.raw_arg(` string literal outside the module, and a second `childproc::append_cmd_c(` caller), and (c) the issue's own recorded Windows output. Do not manufacture a fourth.

---

## Recorded, not fixed here

- **`timeout /t 20 /nobreak >nul` → "Input redirection is not supported".** Not escaping (no quotes in it). The cause is the deliberate Tool-child stdin policy (`childproc::closed_stdin` + `CREATE_NO_WINDOW`) against a program that needs console input. Only the *observability* half is addressed, in the Windows tool description. Changing the stdin policy would re-open the hang `closed_stdin` was added for (issue #35, and the `bash_without_stdin_reaches_eof_instead_of_the_deadline` test is its proof).
- **`start /B prog.bat` → "being used by another process".** **Unexplained by #79 and explicitly not closed by this fix** — no embedded quotes, so nothing was escaped. Recorded as unresolved; if a user reports it against a build containing this commit it is a NEW finding, not a regression.
- **The six POSIX-fixture `#[cfg(unix)]` behaviour tests stay gated.** They are gated on POSIX syntax (`1>&2`, `;`, `( … ) &`, `exec >&- 2>&-`, fractional `sleep`) and on the absence of a Windows process-group kill (`bash.rs`'s `#[cfg(not(unix))]` kill arm is an explicit no-op), not on quoting. Un-gating them needs a Windows process-group story that is its own issue (already recorded in `docs/research/windows-child-console-window.md` §"Follow-ups").
- **`raw_arg`'s trailing-backslash hazard is accepted, not patched.** A command ending in `\` immediately before our closing quote is the known sharp edge of feeding `cmd.exe` a raw line; every industry implementation (pnpm, Zed, VS Code's `copilot_shim`) accepts it. Inventing a `cmd` escaping ruleset is the class of thing that produced CVE-2024-24576. Now fixed as a side effect, worth knowing: a command ending in a backslash used to be rendered `dir C:\\` by `append_arg`'s trailing-backslash doubling; it now arrives as written.
- **`docs/research/windows-child-console-window.md` now has a stale paragraph.** Both §"Related, deliberately filed separately" and the first bullet of §"Follow-ups deliberately left out of PR #36" describe the `cmd /C` quoting bug as still open. **Do not fold the correction into this commit** (the T6 precedent: a stale-doc correction goes to the orchestrator as a one-line hand-off, not into a behaviour commit). Hand it back with the report: the two paragraphs should read "CLOSED by `fix(windows): … (#79)` — `raw_arg` + `/d /s /c` threaded through `childproc`, census invariant E", and the follow-ups list still legitimately holds `sudo_exec` on Windows, the missing Windows process-group kill, and the non-Linux relaunch outside the seam.
- **A multi-line `command` is still not portable, and this fix neither causes nor cures it.** `sh -c` takes embedded newlines; `cmd.exe` parses line by line, so a model that sends a multi-line command gets a `cmd` parse error on Windows before and after this change. It is NOT this issue (no quotes are involved in the simplest repro) and it is NOT fixable by the command-line builder — `cmd` would need a script file or `&&`-joining, which is a different decision. Recorded so the next reader does not mistake it for a regression introduced here.
- **`sudo_exec` is still offered on Windows** (it spawns a literal `sudo`), and **Windows still has no process-group kill** for `bash` children. Both are separate lines in the research doc's follow-up list; neither is quoting, neither is touched here.
