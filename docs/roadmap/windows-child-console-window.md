---
status: committed
done-when: No `Command::new(` exists anywhere in `src-tauri/src` outside `agent/childproc.rs` and a file's test region — ignoring comment lines — enforced by the census test in `agent/childproc.rs`, which is proven able to fail; a **Tool child** reaches stdin EOF immediately instead of hitting the 300 s bash timeout (asserted through `execute_tool`, on Linux); `cargo test`, `cargo clippy --all-targets -- -D warnings` (0 warnings) and `cargo fmt --all -- --check` are green, as are `pnpm test` / `pnpm build`. The final confirmation — a shell command opens no window in the packaged Windows `release` build — is a manual run recorded in the PR, or explicitly recorded as not run.
issue: https://github.com/danielcherubini/archimedes/issues/35
---

# No window per shell command on Windows: one owner for the child-process policy — Plan

**Goal:** stop every agent shell command from opening a blank CMD window on Windows, and stop stdin-reading commands from hanging on an inherited pipe.

**Architecture:** a new `crate::agent::childproc` module becomes the **only** place in the crate that constructs a `tokio::process::Command` / `std::process::Command`; it sets Win32 `CREATE_NO_WINDOW` inside the constructor, so the flag cannot be forgotten. A separate opt-in `closed_stdin` applies to **Tool children** only. Because no runtime test can observe window suppression (ADR 0060: `cargo test` is itself a console-subsystem process, and neither std nor tokio can read creation flags back), the policy is guarded by a **source-census test** that greps our own `src/` and runs on Linux CI.

**Tech Stack:** Rust (pinned toolchain per `src-tauri/rust-toolchain.toml` — do not float it), `tokio::process` (1.53.1 per `Cargo.lock`), `std::os::windows::process::CommandExt` (Windows-gated). **No new dependency** — the flag is a bare `u32`, so `windows-sys`/`windows` must NOT be added.

**Read first:** `docs/research/windows-child-console-window.md` (mechanism + citations), `docs/decisions/0060-child-console-policy-owned-by-a-constructor.md` (why a constructor, why a census test, what was rejected), issue #35 including its correction comment.

**Terms (in `CONTEXT.md`):** a **Tool child** is an OS process a tool executor spawns on the Agent's behalf (`sh`/`cmd`, `fd`, `rg`) — it gets closed stdin. A **Runtime child** runs *itself* rather than the Agent's command (the `--worker` self-exec, an MCP stdio server, the `sudo_exec` helper, the updater relaunch) — its stdin is a pipe we write to and must never be nulled.

**Ground rules for every task:**
- Run all Rust commands from `src-tauri/`. Do not change the pinned toolchain or add a dependency.
- Do not touch: `cmd /C` argv construction, `cmd.args(...)`, `current_dir`, `hostenv::for_child().apply` ordering, `kill_on_drop`, the Linux `sandbox` block, or stdout/stderr `Stdio` choices. This change adds policy calls and changes how a `Command` is obtained — nothing else. Each exclusion has its own follow-up (End of plan).
- The `#[cfg(unix)]` / `#[cfg(not(unix))]` pair in `exec.rs` stays a pair; both arms get the constructor.

---

### Task 1: the `childproc` module

**Context:**
On Windows the shipped app is a GUI-subsystem process (`src-tauri/src/main.rs:2`), so it has no console for a console-subsystem child (`cmd.exe`, `fd`, `rg`, an `npx.cmd` shim) to inherit; Windows allocates a console per child and creating a console creates a window. `CREATE_NO_WINDOW` (0x0800_0000) prevents the window. It goes in a constructor rather than at each call site because `creation_flags` **replaces** rather than ORs (rust-lang/rust#96794) — a second caller silently un-hides the child — so the flag needs exactly one owner, and the only way to guarantee that is to make the module the only source of `Command` values.

**Files:**
- Create: `src-tauri/src/agent/childproc.rs`
- Modify: `src-tauri/src/agent/mod.rs` — add `pub mod childproc;` to the sorted list. The list is alphabetical (`boundary`, `crashlog`, `debuglog`, …) and `childproc` sorts between them (`chi` < `cra` because `h` < `r`), so insert it directly after `pub mod boundary;`.
- Test: unit tests in `childproc.rs`'s own `#[cfg(test)] mod tests`

**What to implement — use this exact shape.** The obvious version (`#[cfg(windows)]` on the helper's *body* with a plain parameter name) **fails `cargo clippy --all-targets -- -D warnings` on Linux with `unused_variable`**, and gating the *call* instead trades that for `unused_mut`. Both were reproduced against the pinned toolchain with this crate's `crate-type = ["staticlib","cdylib","rlib"]`. This shape is what compiles clean on Linux, Windows and macOS — all three lines matter:

```rust
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Blanket import: the std arm needs the trait; the tokio arm resolves to
/// tokio's own INHERENT `creation_flags` (tokio-1.53.1/src/process/mod.rs:675).
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

fn hide(_cmd: &mut std::process::Command) {          // `_cmd` — NOT `cmd`
    #[cfg(windows)]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}

fn hide_tokio(_cmd: &mut tokio::process::Command) {  // `_cmd` — NOT `cmd`
    #[cfg(windows)]
    _cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);   // `mut` is UNCONDITIONAL
    hide_tokio(&mut cmd);                                  // the CALL is unconditional
    cmd
}

pub fn command_std<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    hide(&mut cmd);
    cmd
}

/// Tool children only. Cross-platform — no `cfg`.
pub fn closed_stdin(cmd: &mut tokio::process::Command) {
    cmd.stdin(std::process::Stdio::null());
}
```

- The three items are `pub` in a `pub mod` reachable from `lib.rs`, so they need no in-crate caller to avoid `dead_code` (verified empirically on all three targets). Do not add `#[allow(dead_code)]`.
- `closed_stdin` takes the **tokio** `Command` only — every Tool child is spawned with tokio.
- Module doc comment must state, in prose: the mechanism (one line + a pointer to the research doc); that `creation_flags` REPLACES so any future `CREATE_SUSPENDED` / `CREATE_NEW_PROCESS_GROUP` belongs **in this module**; that `CREATE_NO_WINDOW` is documented-ignored for GUI-subsystem children, which is why the two GUI sites (worker self-exec, relaunch) still route through here — in a *debug* build the exe is console-subsystem and the flag is live; and that Task 3's census test is what enforces all of it.
- **What NOT to add:** no `STARTUPINFO`/`SW_HIDE` (nightly-only on stable Rust), no `DETACHED_PROCESS` (documented to suppress `CREATE_NO_WINDOW`), no dependency, no `env` handling (that is `hostenv`'s job), no stdout/stderr defaults (each site owns those).

**Steps:**
- [ ] Write the failing test `create_no_window_is_the_documented_value`, asserting `CREATE_NO_WINDOW == 0x0800_0000` with the literal written in the test (so a typo in the constant is caught, not restated).
- [ ] Run `cargo test --lib agent::childproc`
  - Expected: compile error, module missing. If it compiles and passes, you created the module before the test — restart this task.
- [ ] Create `childproc.rs` with the exact shape above + the doc comment. Register `pub mod childproc;` in `src/agent/mod.rs`.
- [ ] Run `cargo test --lib agent::childproc` → green.
- [ ] Add `tool_child_reads_eof_on_closed_stdin`: `command("sh")` + `closed_stdin(&mut c)` + `c.args(["-c", "cat"])`, then `tokio::time::timeout(Duration::from_secs(5), c.output())` and `assert!(out.status.success() && out.stdout.is_empty())` after `.expect("did not time out")`. Use `success()` — `sh -c 'cat'` with a null stdin exits 0 with empty stdout; do NOT write `!status.success() || …`, which would also pass on an unrelated failure.
- [ ] Run `cargo test --lib agent::childproc` → green. **This test passes on Linux with OR without `closed_stdin` on a host where cargo's own stdin is already `/dev/null`** — put that in its doc comment and label it a regression pin, not the proof. The behaviour proof is Task 3's `execute_tool` test; the policy proof is Task 3's census.
- [ ] Run `cargo clippy --all-targets -- -D warnings` → 0 warnings. If you see `unused_variable: cmd` or `unused_mut`, you deviated from the shape above — restore it rather than adding `#[allow]`.
- [ ] Run `cargo fmt --all` then `cargo fmt --all -- --check` (the CI form, `ci.yml:120`).
- [ ] Commit: `feat(spawn): childproc owns the Windows child-console policy (#35)`

**Acceptance criteria:**
- Compiles clean on Linux with `clippy -D warnings`; `Cargo.toml` and `Cargo.lock` unchanged.
- `creation_flags` appears exactly twice in `childproc.rs` (the two private helpers), both `#[cfg(windows)]`.
- The constant test would fail if the literal were wrong.

---

### Task 2: route every production spawn through `childproc`

**Context:**
Eight production sites build a `Command` today, none sets a creation flag, and the bug shipped in every Windows release (v0.1.0–v0.3.0). Converting all eight in one commit is deliberate: Task 3's census asserts a crate-wide invariant, so a partially-converted tree cannot satisfy it, and the conversion is mechanical. Four sites are **Runtime children** (`mcp/stdio.rs`, `worker/client.rs`, `interactive/sudo_exec.rs`, `commands/update.rs`) and get **no** stdin change; four are **Tool children** (`exec.rs`) and get `closed_stdin` in Task 3 — do not add it here.

**Files (all line numbers verified in the current tree):**
- Modify `src-tauri/src/agent/tools/exec.rs`: `:374` `Command::new("sh")`, `:381` `Command::new("cmd")`, `:1048` `Command::new("fd")`, `:1243` `Command::new("rg")`
- Modify `src-tauri/src/agent/mcp/stdio.rs:319` `Command::new(&def.command)` (in `build_command_with`)
- Modify `src-tauri/src/agent/worker/client.rs:258` `tokio::process::Command::new(exe)` (in `build_command_with`)
- Modify `src-tauri/src/agent/interactive/sudo_exec.rs:79` `tokio::process::Command::new(cmd0)` (in `build_command_with`)
- Modify `src-tauri/src/commands/update.rs:596` `std::process::Command::new(path)` → `command_std`

**Known coverage limit, stated so nobody over-claims:** `update.rs:596` sits inside `relaunch_through_the_mount`, which is `#[cfg(target_os = "linux")]` (`:545`), and its only caller is the `#[cfg(target_os = "linux")]` block at `:658-663`. **On Windows the relaunch is `app.restart()` (`:665`) → `tauri-2.12.2/src/process.rs:83`'s own unflagged `Command::new(path)…spawn()`**, which is upstream and permanently outside our census. It is harmless in the shipped build for the reason in the ADR — the relaunch target is our own GUI-subsystem exe, where the flag would be ignored anyway — but "every spawn comes from childproc" is a statement about *our source text*, not about every process the app starts on Windows. Record this in the research doc's Gaps (Task 4). Two consequences: `command_std` has exactly one caller and it is Linux-gated, so **Windows and macOS CI never compile a `command_std` call site** — a signature regression there is invisible on two of three CI rows; and Task 3's census counts one `command_std`, which its vacuity guard must therefore expect.

**What to implement:**
- Replace each constructor with `crate::agent::childproc::command(X)` (or `command_std` for `update.rs`). Keep the binding name (`cmd`/`c`) and every subsequent line **byte-identical**: `.arg`/`.args`, `.current_dir`, `.stdout`/`.stderr`/`.stdin`, `kill_on_drop`, `hostenv::apply`/`apply_std`, the `#[cfg(target_os = "linux")]` sandbox block, and the `unsafe { cmd.pre_exec(…) }` blocks.
- `exec.rs:374`/`:381` are the two arms of one `#[cfg(unix)]`/`#[cfg(not(unix))]` pair; both become `childproc::command(...)`, both keep their `c.arg("-c")` / `c.arg("/C")`.
- **Keep `use tokio::process::Command;` in `mcp/stdio.rs:21`** — `Command` is still the *return type* of `build_command` (`:307`) and `build_command_with` (`:318`). Deleting it because "the constructor moved" is the likeliest mistake at this site and is a compile error. No file needs a new `use`: call the constructor by its full `crate::agent::childproc::…` path, matching how these files already spell `crate::agent::hostenv::for_child()`.
- Do **not** change the doc comment at `update.rs:625`, which mentions `Command::new(path)` while describing what Tauri upstream does. It is prose, it stays, and Task 3's scanner skips comment lines precisely because of it. (`update.rs:959` and `:1024` mention it too and are below `#[cfg(test)]`.)
- Add one sentence to each site's nearest doc comment naming `childproc` as the owner of the window policy, in the style of the existing `hostenv` pointers at those sites. Do not rewrite the surrounding prose — those comments carry evidence a future editor must not lose.

**Steps:**
- [ ] Baseline the invariant you are about to satisfy: `grep -rn "Command::new(" src --include=*.rs` and confirm the 8 production hits above (plus `childproc.rs`'s own constructors, plus test-region hits).
- [ ] Convert `exec.rs` (4 sites). Run `cargo test --lib agent::tools::exec` → existing tests pass unchanged (none reads stdin).
- [ ] Convert `mcp/stdio.rs`, `worker/client.rs`, `interactive/sudo_exec.rs`. Run `cargo test --lib` → green. These three are seam-built `Command`s: `an_mcp_server_env_wins_over_the_scrub` (`stdio.rs:584`) and `an_mcp_server_inherits_a_scrubbed_library_path` (`stdio.rs:633`) are the check that env ordering survived; `client.rs`/`sudo_exec.rs` have equivalent `build_command_with` tests.
- [ ] Convert `update.rs:596`. Run `cargo test --lib commands::update` → green.
- [ ] Run `cargo test` (all targets, incl. `tests/worker_smoke.rs`, `tests/worker_stdin.rs`, `tests/worker_stderr.rs`, `tests/ipc.rs`) → green. **Those four are the real safety net for the Worker self-exec conversion — if any hangs you have altered the Worker's stdin, which this task must not do.**
- [ ] `grep -rn "Command::new(" src --include=*.rs` → only `childproc.rs`'s two constructors plus test-region hits.
- [ ] `cargo clippy --all-targets -- -D warnings` → 0 warnings. `cargo fmt --all` + `cargo fmt --all -- --check`.
- [ ] Commit: `fix(spawn): route every child process through childproc, no console window per command (#35)`

**Acceptance criteria:**
- Every production spawn in our source comes from `childproc`.
- `git diff` shows **no** change to any `.arg`/`.args`/`.env`/`Stdio`/`kill_on_drop`/`pre_exec`/`current_dir` line and nothing inside the Linux `sandbox` block.
- All `cargo test` targets green, including the four Worker integration tests.

---

### Task 3: close Tool-child stdin, and add the census test that holds all of it

**Context:**
Two reasons. (1) `worker/client.rs:281` pipes the Worker's stdin and the writer task (`:340-363`) owns the `BufWriter<ChildStdin>` for the Worker's whole life, and `exec.rs` never sets its child's stdin — so a Tool child inherits a live, silent pipe handle and `cat` / `python -` / `git credential` / an `ssh` password prompt hangs to the **300 s `DEFAULT_BASH_TIMEOUT`** (`exec.rs:49`) **on every OS**. Once the window disappears (Task 2) that hang becomes invisible, so it is fixed in the same PR. `tokio`'s `output()` does not help: it pipes stdout/stderr only (`tokio-1.53.1/src/process/mod.rs:1065-1072`). (2) No runtime test can observe window suppression — `cargo test` is a console-subsystem process so a child inherits *its* console regardless, and neither std nor tokio exposes a creation-flag getter (rust-lang/rust#96794). Windows CI builds **debug** only, so CI cannot see the shipped subsystem at all. The remaining honest check is a census of our own source, in the spirit of `hostenv::configured_env` — "the only honest introspection available". ADR 0060 records this and the rejected alternatives.

**Files:**
- Modify `src-tauri/src/agent/tools/exec.rs` — add `crate::agent::childproc::closed_stdin(&mut cmd);` to the three functions holding the four Tool-child constructors: `exec_bash` (whose `sh`/`cmd` arms at `:374`/`:381` share ONE spawn at `:446`), `exec_find` (`:1048`), `exec_grep` (`:1243`)
- Modify `src-tauri/src/agent/childproc.rs` — add the census tests to its `#[cfg(test)] mod tests`

**What to implement:**

*Call sites.* In `exec_bash`, place `closed_stdin(&mut cmd)` after the `cfg` branch pair closes and before `cmd.arg(&command)` — **one call covers both arms** because both produce the same `cmd` binding. In `exec_find`/`exec_grep`, place it immediately after `childproc::command(...)` and before `cmd.args([...])`. So: **4 constructor calls, 3 `closed_stdin` calls, in 3 functions in 1 file.** Say at each site why EOF beats inheritance (nothing can feed the pipe; the inherited handle hangs the child) and that it is deliberately NOT applied to Runtime children.

*The census test.* Walk `src/**/*.rs` with a hand-rolled `std::fs::read_dir` recursion (no new dependency, and `walkdir` feature-gating questions stay out of it). Resolve the root with `env!("CARGO_MANIFEST_DIR")` (already used in 22 places in `src/`). Then:

1. **Region = production code only.** The boundary is the first line whose **trimmed text starts with** `#[cfg(test)]` (an attribute in item position), and the line must also survive rule 2. This is not cosmetic: `src/agent/worker/manager.rs:704` is a doc comment *containing* `` `#[cfg(test)]` `` — a "line contains" rule would cut the region there and leave lines 704–1852 permanently unscanned. `tests/*.rs` is not scanned (fixtures build raw `Command`s on purpose); say so.
2. **Ignore comment lines** for both the boundary and every match: skip lines whose trimmed text starts with `//`, `///`, `//!`, `/*`, `*`, `*/`. Required — `src/commands/update.rs:625` contains the literal `Command::new(path)` in a `///` comment describing Tauri upstream, and is the only such occurrence in production regions (verified: no trailing-comment, block-comment, `concat!` or macro-body occurrences exist).
3. **Invariant A —** no line in that region, in any file other than `childproc.rs`, contains `Command::new(`.
4. **Invariant B —** `creation_flags` appears in no file in that region except `childproc.rs`.
5. **Invariant C — stdin, stated as an algorithm so it cannot false-fail:** for each function in `exec.rs` containing a `childproc::command(`, the text from that call to the **next** literal `spawn()` or `output()` (comment-filtered) contains `closed_stdin`; **and** `exec.rs` contains `childproc::command(` exactly 4 times and `closed_stdin` at least 3 times; **and** none of the four Runtime-child files (`agent/mcp/stdio.rs`, `agent/worker/client.rs`, `agent/interactive/sudo_exec.rs`, `commands/update.rs`) contains `closed_stdin` anywhere in its production region. Rationale to keep in the comment: `exec_bash`'s two `cfg` arms share one `spawn()` at `:446`, so a naive "each constructor must be followed by its own `closed_stdin`" false-fails on correct code; and `spawn()` occurs only at `:446` and `output()` only at `:1058`/`:1246` in that file's production region, so the terminator search cannot be fooled by prose. Silently nulling a Runtime child's stdin would break Worker IPC, MCP JSON-RPC, or `sudo_exec`'s password feed — a worse bug than the one being fixed.
6. **Vacuity guard (mandatory; mirrors `hostenv::tainted_patch` at `src/agent/hostenv.rs:1043`):** the scanner must assert it found **≥ 8 constructor calls across ≥ 4 distinct files, of which ≥ 1 is `command_std`**. A scanner that resolves the root wrongly and sees only `childproc.rs`, or matches nothing at all, must fail loudly rather than pass vacuously. "Files scanned ≥ 5" is worthless — it visits 112 files either way.
7. **Honesty comment:** state that the test does NOT prove the flag suppresses a window; that half is one manual run of the packaged Windows release build, recorded in the PR.

*The behaviour test (mandatory, not optional).* Drive the real tool through the module's existing test idiom (copy `bash_happy_path_serializes_camel_case` at `exec.rs:1709-1724` for the harness shape):

```rust
#[tokio::test]
async fn bash_without_stdin_reaches_eof_instead_of_the_deadline() {
    let cwd = temp_cwd("bash-eof");
    let r = execute_tool(&ctx(&cwd), "bash", &json!({ "command": "cat", "timeout_ms": 2000 })).await;
    assert_eq!(r.details.as_ref().unwrap()["cancelled"], false);
    assert_eq!(r.details.as_ref().unwrap()["exitCode"], 0);
    assert_eq!(text_of(&r).trim(), "");
    assert!(!r.is_error);
    let _ = std::fs::remove_dir_all(&cwd);
}
```

Today this fails — the child blocks on the inherited handle until the 2 s deadline and reports `cancelled: true` / `is_error: true` — and post-fix it returns in milliseconds, so it fails-first and is observable on Linux. Task 1's `sh`+`closed_stdin` pin does **not** cover this and does not substitute for it.

**Steps:**
- [ ] Write the census test **before** adding any `closed_stdin`, with all three invariants + the vacuity guard.
- [ ] Run `cargo test --lib agent::childproc`
  - Expected: **FAIL on invariant C** (Tool-child sites lack `closed_stdin`) while A and B pass (Task 2 satisfied them). If C passes already, the scanner is broken — fix the scanner, do not proceed.
- [ ] Prove capability the other way: temporarily add `let mut probe = tokio::process::Command::new("true");` at the top of `exec_find`, run the census, confirm **invariant A fails and names `tools/exec.rs` with its line number**, then remove it. Paste that failure text into the commit body — it is the evidence the guard works.
- [ ] Add the 3 `closed_stdin` calls. Run `cargo test --lib agent::childproc` → green.
- [ ] Add the `execute_tool` `cat` test. Run `cargo test --lib agent::tools::exec` — confirm it fails **before** the `closed_stdin` calls are in place (temporarily revert one if you added them first), then green with them.
- [ ] Run `cargo test` → green. **Expected: no existing test breaks.** Every `bash` fixture command in `src` and `tests` was checked and none reads stdin (every `cat` occurrence passes a file argument, e.g. `exec.rs:3155` `cat {sibling}/f.txt`; `head -c 300000 /dev/zero` reads a file), and `tests/worker_stdin.rs`/`worker_smoke.rs`/`worker_stderr.rs`/`ipc.rs` drive the **Worker's own** stdin, which this task does not touch. If one does break, that is a finding — investigate and report; do not edit the assertion to match.
- [ ] `cargo clippy --all-targets -- -D warnings` → 0 warnings; `cargo fmt --all` + `cargo fmt --all -- --check`.
- [ ] Commit: `fix(spawn): Tool children start at EOF; census test owns the child policy (#35)`

**Acceptance criteria:**
- Invariants A, B, C pass on Linux and the failure mode was demonstrated with a named `file:line`.
- `execute_tool` with `{"command":"cat","timeout_ms":2000}` returns immediately, not cancelled, not an error.
- `git diff` shows no `stdin` change in `mcp/stdio.rs`, `worker/client.rs`, `interactive/sudo_exec.rs`, `update.rs`.
- The census test's own vacuity guard has been observed to fire (or its assertions are shown to be non-trivially satisfied).

---

### Task 4: record verification, mirror the outcome, and clean up

**Context:**
The bug reached three releases partly because nothing we run can see it, so the verification story has to be written where the next reader looks, and issue #35 needs the outcome for the reporter who filed it. AGENTS.md defines this repo's validation bar as a fixed set of commands; this task runs the whole bar and records the results honestly, including the one check that cannot be automated.

**Files:**
- Modify: `docs/research/windows-child-console-window.md` — bump `last-verified`; add to Gaps which items this PR closed (the GUI-vs-console rule for the two GUI sites; the stdin hang) and which remain (the manual Windows run, if not done; **and the Windows relaunch gap from Task 2** — on non-Linux the relaunch is Tauri's own unflagged spawn in `tauri-2.12.2/src/process.rs:83`, unreachable by our seam and by the census).
- Delete: `docs/roadmap/windows-child-console-window.md` — AGENTS.md: "in-flight plans live in `docs/roadmap/<feature>.md` and are deleted on ship" (precedent: `d366739`). Do this in the final commit, after the PR is open.
- Do not edit `docs/decisions/0060-…` — the decisions tree is append-only.

**Steps:**
- [ ] Run the full bar from the right roots: from `src-tauri/` — `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`; from the repo root — `pnpm test`, `pnpm build`.
  - All green, or fix in this task or stop and report. Do not proceed with a red bar.
- [ ] If a Windows machine is available: build the release bundle, run `target\release\Archimedes.exe`, issue one shell command and confirm **no window appears**, then run `cat` and confirm it returns immediately. Record the observations verbatim in the PR body. **If none is available, say so explicitly in the PR body** — do not let the PR imply the check ran.
- [ ] Update the research doc (step above). Commit: `docs: record verification for the Windows child-console fix (#35)`
- [ ] Push, open the PR against `main` (squash-merge per AGENTS.md). PR body must contain: both root causes; the census test's demonstrated failure output; the full command bar with results; the Windows verification status (done, or explicitly not run); the Task 2 coverage limit (Windows relaunch is Tauri's own spawn); `Closes #35`.
- [ ] Comment on #35 with the PR link, verification status, and which version ships it — the reporter said the app was unusable for them, so say when they can expect the fix.
- [ ] Final commit deleting `docs/roadmap/windows-child-console-window.md`: `docs: remove the windows child-console roadmap — shipped (#35)`

**Acceptance criteria:**
- Every AGENTS.md bar command has been run and its output quoted in the PR.
- The PR states plainly whether the Windows manual check ran.
- #35 has a comment telling the reporter what changed and when they get it.
- The roadmap doc is deleted; the research doc and ADR 0060 remain.

---

## Out of scope — each is a separate issue, do not fix here

- **The Windows/macOS relaunch bypasses `childproc` by construction.** `update.rs:596` is `#[cfg(target_os = "linux")]`; on Windows the relaunch is `app.restart()` → Tauri's own unflagged `Command::new(...).spawn()` (`tauri-2.12.2/src/process.rs:83`). Harmless today (GUI-subsystem child, flag documented-ignored), but it means "every spawn comes from childproc" is a claim about our source, not about every process the app starts. Fixing it means replacing `app.restart()`, which is a different decision (ADR 0053 owns the relaunch path).
- **`cmd /C` quoting/escaping.** `exec.rs:381` passes the model's whole command string as one `.arg()`; our own tests concede it "does not even parse as written" (`exec.rs:1873-1879`; four test groups are `#[cfg(unix)]`-gated for it). `Command::arg`'s "not evaluated by a shell" contract is false for `cmd.exe` (CVE-2024-24576). Industry uses `/D /S /C` + `raw_arg`. Correctness/injection, same line of code.
- **`sudo_exec` on Windows** spawns a literal `sudo` that cannot exist there (`sudo_argv.rs:117`) and is not gated out of the Windows tool registry.
- **No process-group kill on Windows** (`exec.rs:758` is an explicit no-op arm), so a grandchild is unreapable — look here first if a reporter's windows *linger* rather than flash.
- **`worker/client.rs` sets no `kill_on_drop(true)`**, so a dropped `WorkerHandle` leaks the Worker.
- **ADR numbering:** `feature/web-search-and-fetch` carries `0058-js-rendering-runs-in-the-supervisor-over-ipc.md` while `router.rs:83`, `web/render.rs:5` and `navigation_guard.rs:73` already cite "ADR 0058" on `main` with no file behind them. That branch also collides on 0056. Whoever merges it must renumber — this plan chose 0060 to stay clear of it.
