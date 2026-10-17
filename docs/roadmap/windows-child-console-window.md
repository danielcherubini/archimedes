---
status: committed
done-when: No `Command::new(` exists anywhere in `src-tauri/src` outside `agent/childproc.rs` and a file's test region; a Linux CI test enforces that and is proven able to fail; a Tool child reaches stdin EOF immediately instead of hanging; `cargo test` / `cargo clippy --all-targets` (0 warnings) / `cargo fmt --check` and `pnpm test` / `pnpm build` are all green. The final confirmation — a shell command opens no window in the packaged Windows `release` build — is a manual run recorded in the PR.
issue: https://github.com/danielcherubini/archimedes/issues/35
---

# No window per shell command on Windows: one owner for the child-process policy — Plan

**Goal:** stop every agent shell command from opening a blank CMD window on Windows, and stop stdin-reading commands from hanging on an inherited pipe.

**Architecture:** a new `crate::agent::childproc` module becomes the **only** place in the crate that constructs a `tokio::process::Command` / `std::process::Command`; it sets Win32 `CREATE_NO_WINDOW` inside the constructor, so the flag cannot be forgotten. A separate opt-in `closed_stdin` applies to **Tool children** only. Because no runtime test can observe window suppression (ADR 0058: `cargo test` is itself a console-subsystem process, and neither std nor tokio can read creation flags back), the policy is guarded by a **source-census test** that greps our own `src/` and runs on Linux CI.

**Tech Stack:** Rust (edition per `src-tauri/rust-toolchain.toml`), `tokio::process`, `std::os::windows::process::CommandExt` (Windows-gated), `windows-sys` NOT added (the flag is a bare `u32` constant).

**Read first:** `docs/research/windows-child-console-window.md` (mechanism + citations), `docs/decisions/0058-child-console-policy-owned-by-a-constructor.md` (why a constructor, why a census test, what was rejected), issue #35 including the correction comment.

**Terms (in `CONTEXT.md`):** a **Tool child** is an OS process a tool executor spawns on the Agent's behalf (`sh`/`cmd`, `fd`, `rg`) — it gets closed stdin. A **Runtime child** runs *itself* rather than the Agent's command (the `--worker` self-exec, an MCP stdio server, the `sudo_exec` helper, the updater relaunch) — its stdin is a pipe we write to and must never be nulled.

**Ground rules for every task:**
- Run all Rust commands from `src-tauri/`. Do not change the pinned toolchain or add a dependency (the flag is a plain `u32`, so `windows-sys`/`windows` must NOT be added).
- Do not touch: `cmd /C` argv construction, `cmd.args(...)`, `current_dir`, `hostenv::for_child().apply` ordering, `kill_on_drop`, the Linux `sandbox` block, or stdout/stderr `Stdio` choices. This change adds two policy calls and changes how a `Command` is obtained — nothing else. Those exclusions are deliberate and each has its own follow-up (see End of plan).
- The `#[cfg(unix)]` / `#[cfg(not(unix))]` branch pair in `exec.rs` stays a pair; both arms get the constructor.

---

### Task 1: the `childproc` module

**Context:**
On Windows the shipped app is a GUI-subsystem process (`src-tauri/src/main.rs:2`), so it has no console for a console-subsystem child (`cmd.exe`, `fd`, `rg`, an `npx.cmd` shim) to inherit; Windows allocates a console per child and creating a console creates a window. `CREATE_NO_WINDOW` (0x0800_0000) prevents the window. The reason to put it in a constructor rather than at each call site is that `creation_flags` **replaces** rather than ORs (rust-lang/rust#96794) — a second caller silently un-hides the child — so the flag needs exactly one owner, and the only way to guarantee that is to make the module the only source of `Command` values.

**Files:**
- Create: `src-tauri/src/agent/childproc.rs`
- Modify: `src-tauri/src/agent/mod.rs` — add `pub mod childproc;` to the sorted module list. The list is alphabetical (`boundary`, `crashlog`, `debuglog`, …), and `childproc` sorts between `boundary` and `crashlog` (`chi` < ` cra` because `h` < `r`), so insert it directly after `pub mod boundary;`.
- Test: unit tests inside `src-tauri/src/agent/childproc.rs` (the module's own `#[cfg(test)] mod tests`)

**What to implement:**

```rust
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The ONLY Command constructors in the crate.
pub fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command;
pub fn command_std<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command;

/// Tool children only: `Stdio::null()`.
pub fn closed_stdin(cmd: &mut tokio::process::Command);
```

- `command` builds `tokio::process::Command::new(program)` and, on Windows only, calls the private `hide` helper. `command_std` does the same for `std::process::Command` (the updater relaunch is a std spawn — mirror the existing `hostenv::apply` / `apply_std` split, `src/agent/hostenv.rs`, which exists for the identical two-types reason).
- The `creation_flags` call must be the **only** one in the crate and must be `#[cfg(windows)]`-gated. Use `std::os::windows::process::CommandExt` via a `#[cfg(windows)] use`. Do not gate the public functions themselves — they are plain passthroughs on non-Windows, so no call site needs a `cfg`.
- `closed_stdin` sets `cmd.stdin(std::process::Stdio::null())` — cross-platform, no `cfg`.
- Keep `hide` **private** (`fn hide`), not `pub`, so no site can apply it inconsistently and no site can call `creation_flags` at all.
- Module doc comment must state, in prose: the mechanism (one line + a pointer to the research doc), that `creation_flags` REPLACES so any future `CREATE_SUSPENDED` / `CREATE_NEW_PROCESS_GROUP` belongs **in this module**, that `CREATE_NO_WINDOW` is documented-ignored for GUI-subsystem children which is why the two GUI sites (worker self-exec, relaunch) still route through here — in a *debug* build the exe is console-subsystem and the flag is live — and that the census test in Task 2 is what enforces all of this.
- **What NOT to add:** no `STARTUPINFO`/`SW_HIDE` (nightly-only on stable Rust), no `DETACHED_PROCESS` (documented to suppress `CREATE_NO_WINDOW`), no new dependency, no `env` handling (that is `hostenv`'s job), no stdout/stderr defaults (each site owns those).

**Steps:**
- [ ] Write the failing test `create_no_window_is_the_documented_value` asserting `CREATE_NO_WINDOW == 0x0800_0000` as a literal, in `childproc.rs`'s test module.
- [ ] Run `cargo test --lib agent::childproc`
  - Expected: compile error (module missing). If it compiles and passes already, stop — you have created the module before the test and cannot claim a failing test.
- [ ] Create `childproc.rs` with the constant, the two constructors, `closed_stdin`, the private `hide`, and the module doc comment. Register `pub mod childproc;` in `src/agent/mod.rs`.
- [ ] Run `cargo test --lib agent::childproc` → green.
- [ ] Add `tool_child_reads_eof_on_closed_stdin`: use `command("sh")` + `closed_stdin` + `Stdio::piped()` stdout, args `["-c", "cat"]`, wait with `tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())`, assert `!status.success() || output.stdout.is_empty()` **and** that the future did not time out. Then add a doc comment stating honestly: on a machine where `cargo test`'s own stdin is already `/dev/null` this test passes WITHOUT `closed_stdin`, so it is a **regression pin, not the proof** — the proof that the policy is applied lives in the census test (Task 3). Say so in the comment; do not let a future reader think this test can fail on every host.
- [ ] Run `cargo test --lib agent::childproc` → green (this test passes on Linux now; that is expected and documented).
- [ ] Run `cargo clippy --all-targets -- -D warnings` → 0 warnings. Two specific things to watch: the `#[cfg(windows)] use std::os::windows::process::CommandExt` must not surface as `unused_imports` on Linux (that is why it is `#[cfg(windows)]`-gated too), and nothing here should trip `dead_code` — all three items are `pub` in a `pub mod` of the lib crate, so they are reachable without an in-crate caller. If `dead_code` does fire, the item is not actually `pub` — fix the visibility rather than adding an `#[allow]`.
- [ ] Run `cargo fmt` then `cargo fmt --check` → clean.
- [ ] Commit: `feat(spawn): childproc owns the Windows child-console policy (#35)`

**Acceptance criteria:**
- `childproc` compiles on Linux with `clippy -D warnings` clean, no new dependency in `Cargo.toml` or `Cargo.lock`.
- `grep -n creation_flags src-tauri/src/agent/childproc.rs` shows exactly one call site, `#[cfg(windows)]`-gated.
- The constant test would fail if the literal were wrong (it compares against a number written in the test, not against the constant).

---

### Task 2: route every production spawn through `childproc`

**Context:**
Eight production sites build a `Command` today, none sets a creation flag, and the bug has shipped in every Windows release (v0.1.0–v0.3.0). Converting all eight in one commit is deliberate: the census test in Task 3 asserts a crate-wide invariant, so a partially-converted tree cannot satisfy it, and the conversion is mechanical. Four sites are **Runtime children** (`mcp/stdio.rs`, `worker/client.rs`, `interactive/sudo_exec.rs`, `commands/update.rs`) and get **no** stdin change; four are **Tool children** (`exec.rs` × 4) and get `closed_stdin` in Task 3 — do not add it here.

**Files (exact current lines, verified at `8cb499c` + the docs commit):**
- Modify: `src-tauri/src/agent/tools/exec.rs:374` (`Command::new("sh")`), `:381` (`Command::new("cmd")`), `:1048` (`Command::new("fd")`), `:1243` (`Command::new("rg")`)
- Modify: `src-tauri/src/agent/mcp/stdio.rs:319` (`Command::new(&def.command)` inside `build_command_with`)
- Modify: `src-tauri/src/agent/worker/client.rs:258` (`Command::new(exe)` inside `build_command_with`)
- Modify: `src-tauri/src/agent/interactive/sudo_exec.rs:79` (`Command::new(cmd0)` inside `build_command_with`)
- Modify: `src-tauri/src/commands/update.rs:596` (`std::process::Command::new(path)` → `command_std`)
- Test: `src-tauri/src/agent/childproc.rs` (a census test is added in Task 3 — nothing here yet)

**What to implement:**
- At each of the 7 tokio sites, replace `tokio::process::Command::new(X)` (or `Command::new(X)` where `Command` is the imported alias — `mcp/stdio.rs` and others `use tokio::process::Command`) with `crate::agent::childproc::command(X)`. Keep the binding name `cmd`/`c` and every subsequent line **byte-identical**: `.arg`/`.args`, `.current_dir`, `.stdout`/`.stderr`/`.stdin`, `kill_on_drop`, `hostenv::apply`, the `#[cfg(target_os = "linux")]` sandbox block, and the `unsafe { cmd.pre_exec(...) }` blocks.
- `update.rs:596`: `std::process::Command::new(path)` → `crate::agent::childproc::command_std(path)`. Leave `cmd.args(args)` and `patch.apply_std(&mut cmd)` untouched and in that order.
- `exec.rs:374`/`:381` are the two arms of one `#[cfg(unix)]`/`#[cfg(not(unix))]` pair; both become `childproc::command(...)`, both keep their `c.arg("-c")` / `c.arg("/C")`.
- `src-tauri/src/agent/mcp/stdio.rs` is the only site that reaches the constructor through an import (`use tokio::process::Command;` at `:21`). **Keep that import** — `Command` is still the *return type* of `build_command`/`build_command_with` at `:307` and `:318`; deleting it is a compile error, and removing it "because the constructor moved" is the likeliest mistake at this site. The other three tokio sites spell the path inline and need no import change. `exec.rs`, `worker/client.rs`, `sudo_exec.rs` and `update.rs` add no `use` at all (call the constructor by its full `crate::agent::childproc::…` path, matching how those files already spell `crate::agent::hostenv::for_child()`).
- Do **not** change the doc comment at `update.rs:625` which *mentions* `Command::new(path)` while describing what Tauri does — it is prose about upstream code, and Task 3's scanner is written to ignore comments precisely because of it. (`update.rs:959` and `:1024` mention it too and are below `#[cfg(test)]`, so they are out of region anyway.)
- Update each site's nearest doc comment by one sentence naming `childproc` as the owner of the window policy, in the style of the existing `hostenv` pointers at those same sites. Do not rewrite the surrounding prose — those comments carry evidence a future editor must not lose.

**Steps:**
- [ ] First prove the invariant is currently violated, so the eventual test has something to bite: `grep -rn "Command::new(" src --include=*.rs` and confirm the 8 production hits listed above (plus `childproc.rs` itself, plus hits below `#[cfg(test)]`).
- [ ] Convert `exec.rs` (4 sites). Run `cargo test --lib agent::tools::exec` → the existing exec tests must pass unchanged (none of them reads stdin).
- [ ] Convert `mcp/stdio.rs`, `worker/client.rs`, `interactive/sudo_exec.rs`. Run `cargo test --lib` → green. These three are the seam-built `Command`s: `mcp/stdio.rs`'s `an_mcp_server_env_wins_over_the_scrub` and the two other `build_command_with` tests must still pass, which is the check that the conversion did not disturb env ordering.
- [ ] Convert `update.rs:596`. Run `cargo test --lib commands::update` → green.
- [ ] Run `cargo test` (all targets, incl. `tests/worker_smoke.rs`, `tests/worker_stdin.rs`, `tests/worker_stderr.rs`, `tests/ipc.rs`) → green. **These four are the real safety net for the Worker self-exec conversion — if any hangs, you have altered the Worker's stdin, which this task must not do.**
- [ ] `grep -rn "Command::new(" src --include=*.rs` → now only `childproc.rs` (its own two constructors) and test-region hits.
- [ ] Run `cargo clippy --all-targets -- -D warnings` → 0 warnings. Run `cargo fmt` then `cargo fmt --check`.
- [ ] Commit: `fix(spawn): route every child process through childproc, no console window per command (#35)`

**Acceptance criteria:**
- Every production spawn comes from `childproc`.
- `git diff` for this task shows **no** change to any `.arg`/`.args`/`.env`/`Stdio`/`kill_on_drop`/`pre_exec`/`current_dir` line and no change inside the Linux `sandbox` block.
- All `cargo test` targets green, including the four Worker integration tests.

---

### Task 3: close Tool-child stdin, and add the census test that holds all of it

**Context:**
Two reasons this task exists. (1) `worker/client.rs:281` pipes the Worker's stdin and the writer task never closes it, and `exec.rs` never sets its child's stdin — so a Tool child inherits a live, silent pipe handle and `cat` / `python -` / `git credential` / an `ssh` password prompt hangs until the tool timeout **on every OS**. Once the window disappears (Task 2) that hang becomes invisible, so it must be fixed in the same PR; `tokio`'s `output()` does not help because it pipes stdout/stderr only (`tokio-1.53.1/src/process/mod.rs:1065-1072`). (2) No runtime test can observe window suppression — `cargo test` is a console-subsystem process so a child inherits *its* console regardless, and neither std nor tokio exposes a creation-flag getter (rust-lang/rust#96794). Windows CI also builds **debug** only, so CI cannot see the shipped subsystem at all. The remaining honest check is a census of our own source, in the same spirit as `hostenv::configured_env`, documented as "the only honest introspection available". ADR 0058 records this and the rejected alternatives.

**Files:**
- Modify: `src-tauri/src/agent/tools/exec.rs` — add `crate::agent::childproc::closed_stdin(&mut cmd);` at all four Tool-child sites (`sh` ~`:374`, `cmd` ~`:381`, `fd` ~`:1048`, `rg` ~`:1243`)
- Modify: `src-tauri/src/agent/childproc.rs` — add `#[cfg(test)] mod census` (or extend the existing test module) with the source-scanning tests

**What to implement:**

*Call sites.* In `exec_bash`, place `closed_stdin(&mut cmd)` immediately after the `cfg` branch pair closes and before `cmd.arg(&command)`. In `exec_find`/`exec_grep`, place it immediately after `childproc::command(...)` and before `cmd.args([...])`. Add one sentence at each site saying why EOF beats inheritance (nothing can feed the pipe; the inherited handle hangs the child), and that this is deliberately NOT applied to Runtime children.

*The census test.* Scan `src/**/*.rs`, resolving the root with `env!("CARGO_MANIFEST_DIR")` (the mechanism already used in 12 places for sibling fixtures). Rules, all of them load-bearing:

1. **Region:** for each file, consider only the text **before the first line containing `#[cfg(test)]`** — the boundary `hostenv`/`sandbox` already rely on. `tests/*.rs` is not scanned (fixtures build raw `Command`s on purpose); say so in the comment.
2. **Ignore comments:** skip any line whose trimmed content starts with `//`, `///`, `//!`, `/*`, `*` or `*/`. This is required: `src/commands/update.rs:625` contains the literal text `Command::new(path)` in a doc comment describing what Tauri upstream does, and a line-grep that does not skip it fails for the wrong reason.
3. **Invariant A:** no line in that region, in any file other than `childproc.rs`, contains the substring `Command::new(`.
4. **Invariant B:** the substring `creation_flags` appears in no file in that region except `childproc.rs`.
5. **Invariant C (stdin):** for each of the four Tool-child files/functions, the region text between `childproc::command(` and the next `spawn()`/`output()` contains `closed_stdin`; and for each of the four Runtime-child sites (`agent/mcp/stdio.rs`, `agent/worker/client.rs`, `agent/interactive/sudo_exec.rs`, `commands/update.rs`) the whole production region contains **no** `closed_stdin` — because silently nulling the Worker's IPC stdin, an MCP JSON-RPC stdin, or `sudo_exec`'s password feed is a worse bug than the one being fixed.
6. **Capable of failing (mandatory, mirrors `hostenv::tainted_patch` at `src/agent/hostenv.rs:1049`):** the scanner first asserts it found ≥ 8 `childproc::command`/`command_std` call sites in the scanned region, and that it scanned ≥ 5 files. A scanner that matches nothing must fail loudly rather than pass vacuously.
7. **Honesty comment:** the doc comment states what the test does NOT prove — that the flag actually suppresses a window; that half is verified by one manual run of the packaged Windows release build, recorded in the PR.

**Steps:**
- [ ] Write the census test **before** adding any `closed_stdin` call, with invariant C included.
- [ ] Run `cargo test --lib agent::childproc`
  - Expected: **FAIL** on invariant C (the four Tool-child sites lack `closed_stdin`), while A and B pass (Task 2 already satisfied them). If C passes already, your scanner is broken — fix the scanner, do not proceed.
- [ ] Prove capability the other way: temporarily add a raw `let mut c = tokio::process::Command::new("true");` inside a production function (e.g. at the top of `exec_find`), run `cargo test --lib agent::childproc`, confirm **invariant A fails and the failure message names `tools/exec.rs` and the line number**, then remove it. Record the observed message in the commit body — it is the evidence that the guard works.
- [ ] Add the four `closed_stdin` calls. Run `cargo test --lib agent::childproc` → green.
- [ ] Run `cargo test` → green. **If an existing exec test now fails, that is a finding, not noise**: it means the test relied on inherited stdin. Investigate and report it rather than editing the assertion to match.
- [ ] Run `cargo clippy --all-targets -- -D warnings` → 0 warnings; `cargo fmt` + `cargo fmt --check`.
- [ ] Commit: `fix(spawn): Tool children start at EOF; census test owns the child policy (#35)`

**Acceptance criteria:**
- Invariants A, B, C pass on Linux CI and the failure mode was demonstrated with a named file:line.
- `cat` as a shell command returns immediately (no timeout) — `exec_bash` driven with `{"command":"cat"}` in a test, or the Task 1 pin.
- The four Runtime-child sites still pipe stdin exactly as before (`git diff` shows no `stdin` change in `mcp/stdio.rs`, `worker/client.rs`, `interactive/sudo_exec.rs`, `update.rs`).

---

### Task 4: record verification and close out the report

**Context:**
The bug reached three releases partly because nothing we run can see it, so the verification story has to be written down where the next reader will look, and issue #35 needs the outcome for the reporter who filed it. AGENTS.md is explicit that this repo's validation bar is a fixed set of commands; this task is where the whole bar is run and the results are recorded honestly, including the one check that cannot be automated.

**Files:**
- Modify: `docs/decisions/0058-child-console-policy-owned-by-a-constructor.md` — no content change expected; verify it exists and is `status: accepted`. Do not edit a merged ADR body.
- Modify: `docs/research/windows-child-console-window.md` — update `last-verified` and add one line under Gaps stating which gaps this PR closed (the GUI-vs-console rule for the two GUI sites, the stdin hang) and which remain (the manual Windows run, if it has not happened).
- No code change.

**Steps:**
- [ ] Run the full bar from the right roots: from `src-tauri/` — `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`; from the repo root — `pnpm test`, `pnpm build`.
  - All must be green. Any failure: fix it in this task or stop and report — do not proceed with a red bar.
- [ ] If a Windows machine is available: build the release bundle (`pnpm tauri build` or the documented equivalent), run `target\release\Archimedes.exe`, issue one shell command and confirm **no window appears**, then run `cat` and confirm it returns immediately. Record the exact observations in the PR body. If no Windows machine is available, say so explicitly in the PR body — do not imply the check passed.
- [ ] Update the research doc's `last-verified` to today and the closed-gaps line. Run `cargo fmt --check` again if you touched any Rust (you should not have).
- [ ] Commit: `docs: record verification for the Windows child-console fix (#35)`
- [ ] Push and open the PR against `main` (squash-merge per AGENTS.md). PR body must contain: the two root causes, the census test's demonstrated failure output, the full command bar with results, the Windows verification status (done or explicitly not done), and `Closes #35`.
- [ ] Comment on #35 with the PR link, the verification status, and which version the fix ships in — the reporter asked because the app was unusable for them, so the comment must say when they can expect it.

**Acceptance criteria:**
- Every command in the AGENTS.md bar has been run and is green, with output quoted in the PR.
- The PR states plainly whether the Windows manual check ran.
- #35 has a comment telling the reporter what changed and when they get it.

---

## Out of scope — each is a separate issue, do not fix here

- **`cmd /C` quoting/escaping.** `exec.rs:381` passes the model's whole command string as one `.arg()`; our own tests concede it "does not even parse as written" (`exec.rs:1873-1879`; four test groups are `#[cfg(unix)]`-gated for it). `Command::arg`'s "not evaluated by a shell" contract is false for `cmd.exe` (CVE-2024-24576). Industry uses `/D /S /C` + `raw_arg`. Correctness/injection, same line of code.
- **`sudo_exec` on Windows** spawns a literal `sudo` that cannot exist there (`sudo_argv.rs:117`) and is not gated out of the Windows tool registry.
- **No process-group kill on Windows** (`exec.rs:758` is an explicit no-op arm), so a grandchild is unreapable — look here first if a reporter's windows *linger* rather than flash.
- **`worker/client.rs` sets no `kill_on_drop(true)`**, so a dropped `WorkerHandle` leaks the Worker.
