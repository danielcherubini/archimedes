---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 81
done-when: A `grep` call with a `glob` containing a `/` (e.g. `sub/*.txt`) finds files inside the Space instead of silently returning 0 matches, `find`/`grep` children start in the Space cwd with byte-identical output to today, and a bundled run says out loud (once per process, on the debug channel) whether the AppImage env scrub removed anything and from which variables.
---

# Task 6 — `find`/`grep` start in the Space cwd, and the env scrub reports what it removed (issue #81)

**Goal:** Two residuals of the AppImage child-env fix (PR #30, `src-tauri/src/agent/hostenv.rs`): the `fd`/`rg` spawn sites pass no `current_dir`, and `EnvPatch` reports nothing, so "the scrub did not fire" and "the scrub fired and found nothing" are the same observable.

**Architecture:** Residual 1 is two `cmd.current_dir(&ctx.cwd)` calls — one per spawn site in `src-tauri/src/agent/tools/exec/search.rs` — reached through a small `build_*_command` seam so the cwd and the argument list can be asserted on a `Command` that was never spawned (the exact pattern `agent/mcp/stdio.rs` and `agent/worker/client.rs` already use for the same reason). No flag changes, no post-processing changes: both tools are already handed an ABSOLUTE search root, so neither output shape moves (measured — see below). Residual 2 is one `pub fn EnvPatch::describe(&self) -> String` plus one `eprintln!` inside `hostenv::for_child()`'s `OnceLock` initializer — one line per process, on the channel the Worker already has.

**Tech Stack:** Rust 2021, `tokio::process::Command` (via `std::process::Command::get_current_dir` / `get_args` for introspection), the existing `ARCHIMEDES_DEBUG` / Worker-stderr channel, `fd` and `ripgrep` as external binaries.

---

## Parallelisation

**Verdict:** SERIAL — this is one task of the issue-triage backlog, and every file it touches is a Rust source in `archimedes`, which is **one compilation unit**: the parent roadmap measured (planted-error experiment, see `docs/roadmap/issue-triage-backlog-status.md` §"Why the waves collapsed to serial") that any sibling's half-finished `.rs` edit makes an unrelated scoped `cargo test` fail to compile, which destroys gate 4. The parent already lists T6 in the serial column, and T7/T8 land after it.

Consequence for the executor: **run the FULL gate**, not a scoped test run — a scoped `cargo test --lib <filter>` compiles the whole crate here anyway, so scoping buys nothing.

---

## Context — why this exists, and what was verified against the tree

Issue #81 files the two residuals left by the child-env scrub. Read these before starting:
`src-tauri/src/agent/hostenv.rs` (the module, its `fixtures` submodule and its `for_child()` doc),
`docs/research/appimage-child-process-env-leak.md` (§5's site table, §7's fix),
and the `KNOWN GAP` comment in `src-tauri/src/agent/tools/exec/search.rs` (there are TWO of them — one above the `fd` arm, one above the `rg` arm).

### Verified starting facts

- `exec_bash` (`src-tauri/src/agent/tools/exec/bash.rs`) calls `cmd.current_dir(&ctx.cwd)`. Grepping `search.rs` for `current_dir` finds **only prose** — the two `KNOWN GAP` comments — and no call. Confirmed.
- Both spawn sites in `search.rs` are `crate::agent::childproc::command("fd")` / `("rg")` + `childproc::closed_stdin(&mut cmd)` + `hostenv::for_child().apply(&mut cmd)` + `cmd.output().await`.
- Both pass an **absolute** search root: `read_backend(ctx).validate(Path::new(&dir))` → `FsBackend::resolve`, which canonicalizes (relative paths are joined to `ctx.cwd` first, absolute paths are used as-is) and returns a canonical absolute `PathBuf`. **No relative path ever reaches `fd`/`rg`.** This is the fact the whole task turns on.
- The two `cmd.args([...])` blocks, verbatim in shape today:
  - `fd`: `--max-results <max> -g <pattern> -- <resolved absolute path>`
  - `rg`: [`-i`] [`--glob <g>`] `-m <max>` `--` `<pattern>` `<resolved absolute path>`
  `--max-results` **is** a real `fd` flag (verified against `fd` 10.4.2's `cli.rs` and by running it); the research doc's "Gaps (b)" claim that it is not is stale — see *Recorded, not fixed here*.
- The Worker's sink emits `session-update`, `interactive-event`, `interactive-request`, `interactive-request-close`, `permission-request` (`agent/worker/sink.rs`), and the Supervisor's `EventSink` additionally carries `session-closed`, `session-stalled`, `session-titled`, `subagent-session-started`, `subagent-closed` (`agent/session/router.rs`, `agent/session/mod.rs`, `agent/session/naming.rs`, `agent/worker/manager/subagent_flow.rs`). The frontend's owner of those names is `src/lib/ipc/events.ts`, whose header states that every value is a byte-for-byte wire contract pinned by `events.test.ts`. **There is no "notice" channel** — the issue's note is correct, and the list in the issue text is incomplete (five of ten), which only strengthens it.
- The debug log: `crate::agent::debuglog` — `ARCHIMEDES_DEBUG=1` → `<data_dir>/archimedes/supervisor.log`, `log()` a cached-atomic no-op when unset. **`debuglog::init_from_env()` is called ONLY from `lib.rs::run()` (the Supervisor).** `run_worker` → `agent::worker::run_worker_inner()` never inits it, so `debuglog::log` called from inside a Worker — where `exec_bash` / `exec_find` / `exec_grep` / `for_child()` all run — is a **silent no-op today**. What the Worker DOES have: `WorkerHandle::spawn` pipes stderr and `spawn_pipe_reader` forwards every line to `debuglog::log_truncated("worker-stderr:", …)` on the Supervisor side. `src-tauri/tests/worker_stderr.rs` proves end-to-end that a Worker `eprintln!` reaches `supervisor.log`. `agent/worker/mod.rs` already uses bare `eprintln!` for its own diagnostics for exactly this reason.

### Residual 1 — what ACTUALLY breaks, measured (the gap comment's model of `fd` is wrong)

The `KNOWN GAP` comment says: *"`fd` prints paths relative to ITS cwd, and the code strips the canonical prefix it passed in, so changing the cwd changes what those two functions post-process."* That is **not what `fd` does**, and the measurement is in `fd`'s own source: `output.rs` prints `entry.stripped_path(config)`, and `stripped_path` only calls `filesystem::strip_current_dir`, which is `path.strip_prefix(".")`. `fd` echoes the search path **as it was given**. So with an absolute search path the output is absolute at every cwd, and the existing `strip_prefix(format!("{resolved}/"))` fires identically. Reproduced on this box (`fd` 10.4.2 at `~/.pi/agent/bin/fd`):

```
for cwd in / /tmp/fdtest /tmp/fdtest/space /tmp/fdtest/space/sub; do
  (cd $cwd && fd -g '**/c.txt' -- /tmp/fdtest/space); done
# → /tmp/fdtest/space/other/c.txt and /tmp/fdtest/space/sub/c.txt at EVERY cwd
```

`rg` is the same on output: with an absolute search root it prints absolute paths at every cwd (verified with `ripgrep 15.2.0`, `/usr/bin/rg`). `exec_grep` does no path post-processing at all — it counts non-empty lines and truncates to `max` — so nothing there can move either.

**What the missing `current_dir` really costs is `rg`'s `--glob` matching, and it fails SILENTLY.** `rg` matches a `-g` glob that contains a `/` against the candidate path **relative to rg's own cwd**; a basename-only glob (no `/`) is cwd-independent. Measured (`rg` 15.2.0, Space `/tmp/k/space` holding `space/sub/x.txt`):

```
cd /tmp/k/space && rg -g 'sub/*'  -- needle /tmp/k/space   → /tmp/k/space/sub/x.txt:needle   (exit 0)
cd /tmp/k/else  && rg -g 'sub/*'  -- needle /tmp/k/space   → (no output)                     (exit 1)
cd /tmp/k/else  && rg -g '**/sub/*' -- needle /tmp/k/space → /tmp/k/space/sub/x.txt:needle   (exit 0)
cd /tmp/k/else  && rg -g '*.txt'  -- needle /tmp/k/space   → /tmp/k/space/sub/x.txt:needle   (exit 0)
```

Under an AppImage the child's cwd is `$APPDIR/usr` (`AppRun.c`'s `chdir("$APPDIR/usr")`), i.e. inside the mount, so **every `grep` whose `glob` names a directory returns zero matches and reports success** — a false negative the model reads as "the code doesn't reference that". A negated glob is inverted the same way (`-g '!sub/*'` excludes nothing when the cwd is elsewhere, and excludes everything when it is the Space). This is the user-visible half of residual 1 and it is the RED→GREEN test (test 3 below).

Ignore-file discovery was also checked and is **not** cwd-dependent in these versions: an ignore file in a parent of the search root is honoured from any cwd (`--no-ignore-parent` is what moves it, not the cwd), and an ignore file in a directory that is a cwd ancestor but not a search-root ancestor is honoured by neither tool from any cwd. So adding `current_dir` changes no ignore semantics. Verified with `.ignore`/`.gitignore` at four positions × three cwds × both tools.

**Consequences for the change, stated once so nobody "fixes" a non-bug:**

- `fd` needs **no new flag**. Do NOT add `-a`/`--absolute-path` (its output is already absolute because the search path is) and do NOT add `-C`/`--base-directory` (that is fd-only; `current_dir` is what `exec_bash` uses and it serves both tools). Do NOT add `--path-separator` to either tool — it only rewrites separators, and `/` is already the separator on Unix and the fallback's own `to_string_lossy()` shape on Windows.
- `rg` needs **no new flag** either, and no post-processing. Its output keeps the absolute root prefix; the existing tests assert substrings (`text_of(&r).contains("a.txt")`) and stay green.
- The prefix strip in `exec_find` stays exactly as written. It is pinned by test 2 (the argument list must not grow) and test 4 (the strip still fires for an absolute `path` argument).
- **Behaviour change to record, not to fix:** with a `current_dir` that does not exist, `spawn` fails. `exec_find` degrades (the `if let Ok(out) = fd` arm falls through to the `walkdir` fallback, which is cwd-independent), and `exec_grep` returns its existing `"grep: ripgrep (rg) is not available: {e}"` error — a misleading message for that specific cause. This is accepted because `exec_bash` has had exactly this property since it was written (a non-existent `ctx.cwd` makes it fail to start), `validate` refuses a non-existent `ctx.cwd` for the default `path: "."` before any spawn, and the three tool children now agree. Do not add a `ctx.cwd.is_dir()` guard.

### Residual 2 — the decision: option (a), a one-line-per-process stderr verdict

**DECISION: (a) — a debug-channel line, emitted once per process from `hostenv::for_child()`. Not (b), not (c).**

Why not **(b), a surfaced per-session notice** — three reasons, the first of which is decisive on its own:

1. **The scope is wrong, and a session notice would misreport it.** `for_child()` is a `OnceLock<EnvPatch>` over `APPDIR` + `current_exe()`: a **process-lifetime constant**. It is not per-session, and it has no `sessionId` to put in a payload. A "one-per-session notice" would say "this session's scrub" about a fact that belongs to the whole process, and would re-announce the same unchanged verdict for every session.
2. **It is a new wire contract, not a new call into an old one.** Verified above: no notice channel exists. A new name means `src/lib/ipc/events.ts` (whose header declares every value a byte-for-byte contract pinned by `events.test.ts`), a Rust emitter, a store, a component, and `pnpm`-side coverage — for a machine-health line the user cannot act on. The Worker sink's existing names are all transcript/modal/UI contracts; this is not one.
3. The tools' own diagnostics already have a proven route to disk (`worker-stderr:` → `supervisor.log`, pinned by `src-tauri/tests/worker_stderr.rs`). Building a second one for one line is the expensive complete answer to a cheap question.

Why not **(c), defer** — the fix is ~15 lines, adds no surface, and the question it answers ("did the scrub fire?") is precisely the one that made this issue exist. Deferring would silently pay the cost of the next duplicate report. Per the roadmap's rule — *prefer the cheap, correct-per-enough fix plus an honest recorded limitation over the expensive complete one, and record the cost rather than pay it silently* — the recorded limitation is: **the verdict distinguishes "changed something" from "changed nothing", but NOT "the gate was closed" from "the gate was open and the env was already clean."** Both produce `EnvPatch::default()`, and separating them means plumbing the Linux-only `appimage_mount_root` decision out of `scrub`; the empty-case wording therefore names both possibilities instead of inventing a third state.

Why the line lives in `for_child()` and not in `EnvPatch::apply`: `apply` runs once per **child**, so instrumenting it would print on every `bash`/`find`/`grep`/MCP spawn into a 5 MB rotating log, and it would mean changing `apply`'s return type at six call sites. The patch is a process-lifetime constant, so "what the scrub did" is a per-process fact; the `OnceLock` initializer is the one place that knows it, it cannot be forgotten at a call site, and it cannot fire twice.

`commands/update.rs`'s `relaunch_patch` calls `scrub` DIRECTLY (not through `for_child()`) and therefore stays silent. That is deliberate and must be stated in the code comment: it is called from tests, its result is already asserted end-to-end by `update.rs`'s own tests, and the relaunch is a once-per-restart event whose outcome is visible in the child's env. Recorded limitation, not an oversight.

---

## Files

- Modify: `src-tauri/src/agent/tools/exec/search.rs`
- Modify: `src-tauri/src/agent/hostenv.rs` (the impl and its `#[cfg(test)] mod tests`)
- Test: `src-tauri/src/agent/tools/exec/tests/search.rs`
- Test: `src-tauri/src/agent/tools/exec/tests/bash_hostenv.rs`

Do NOT touch: `agent/childproc.rs` (its census test constrains what `search.rs` may look like — see the census rule below), `agent/tools/exec/bash.rs`, `agent/mcp/stdio.rs`, `agent/worker/client.rs`, `agent/interactive/sudo_exec.rs`, `commands/update.rs`, `agent/debuglog.rs`, anything under `src/` (the frontend), `Cargo.toml`, `docs/research/appimage-child-process-env-leak.md`.

---

## What to implement

### 1. `search.rs` — the cwd, behind a build seam

For each of the two tools, extract the `Command` construction into two module-level functions, mirroring `mcp/stdio.rs`'s `build_command` / `build_command_with` pair (production wrapper passes `for_child()`; the `_with` form takes the patch, because `for_child()` is EMPTY under `cargo test` — its own doc says so — and a test driven through the wrapper could not fail):

```rust
pub(crate) fn build_fd_command(
    pattern: &str,
    resolved: &Path,
    max: u32,
    cwd: &Path,
) -> tokio::process::Command {
    build_fd_command_with(pattern, resolved, max, cwd, crate::agent::hostenv::for_child())
}

pub(crate) fn build_fd_command_with(
    pattern: &str,
    resolved: &Path,
    max: u32,
    cwd: &Path,
    patch: &crate::agent::hostenv::EnvPatch,
) -> tokio::process::Command { /* childproc::command("fd") → closed_stdin → args → patch.apply → current_dir */ }
```

and the same pair for `rg` (`build_rg_command` / `build_rg_command_with(pattern, glob: Option<&str>, resolved: &Path, max: u32, ignore_case: bool, cwd: &Path, patch: &EnvPatch)`). Seven parameters is at the limit, not over it: `clippy::too_many_arguments` fires above 7, measured on this toolchain (`clippy 0.1.95`) with a 7-parameter free function — so keep the plain signature. Only if a later edit pushes it to 8 does the group-or-`&Value` choice come up; do not pre-emptively add a struct.)

Rules the builders must satisfy:

- `cmd.current_dir(cwd)` is called with the value the caller passes — `exec_find`/`exec_grep` pass `&ctx.cwd`, exactly as `exec_bash` does. Do NOT canonicalize it and do NOT use `resolved`: the cwd is the **Space**, not the (possibly deeper) search dir.
- **The argument list is unchanged, byte for byte.** Move the existing `cmd.args([...])` / `args: Vec<String>` construction verbatim.
- `childproc::closed_stdin(&mut cmd)` stays, immediately after the constructor **inside the `_with` builder**.
- `patch.apply(&mut cmd)` keeps its position relative to the args (it is order-insensitive w.r.t. args; keep it before `current_dir` for symmetry with `exec_bash`).
- **The census in `agent/childproc.rs` must stay green — read `production_source_has_exactly_one_child_constructor` before editing.** Its Invariant C asserts `agent/tools/exec*` holds **exactly 4** `childproc::command(` calls (measured today: 2 in `bash.rs` for the two `cfg` arms, 2 in `search.rs`) and ≥ 3 `closed_stdin` mentions, and that every constructor is followed by `closed_stdin` before the next line containing `spawn()` or `output()` **in file order** (the window search starts AT the constructor line and runs forward, so an earlier function's `output()` can never cut a later constructor's window short). Keep exactly ONE `childproc::command(` per `_with` builder — the production wrappers must NOT construct, they delegate — and keep `closed_stdin` on the line immediately after the constructor, which satisfies the window rule at any file position. Do not add a third constructor to `search.rs`: four is the asserted total and a fifth reddens the census.
- Replace BOTH `KNOWN GAP` comments. Do not delete them silently and do not leave them lying. The replacement must say, in this file's own voice: the env half and the cwd half are both fixed now; the reason the cwd mattered is `rg`'s cwd-relative `-g` globs (with the measured example), NOT `fd`'s output shape; `fd` echoes the absolute search path it was given, so the prefix strip is cwd-independent — and cite `fd`'s `stripped_path` / `strip_current_dir` so the next reader does not re-derive it. Keep the sentence that says a relative path in a `find`/`grep` result is relative to the **search dir**, not to the Space, because that is unchanged and still surprising.

`exec_find`'s body becomes: build via `build_fd_command(&pattern, &resolved, max, &ctx.cwd)`, then `let fd = cmd.output().await;` and the existing `if let Ok(out) = fd { … }` + `walkdir` fallback **unchanged**. `exec_grep` likewise. The `glob_match` helper, the fallback, `DEFAULT_MAX_RESULTS` and `ToolResult` shapes are untouched.

### 2. `hostenv.rs` — `EnvPatch::describe` + one line in `for_child()`

Add to `impl EnvPatch` (public, like `is_empty`, so the wording is testable from this module's tests without exposing `set`/`remove`):

```rust
/// The one-line verdict of this patch, for the process's stderr.
pub fn describe(&self) -> String
```

- Empty patch → a single line containing the stable marker `changed nothing`, and naming BOTH reasons so it never claims a state it cannot tell: `hostenv: the child env scrub changed nothing (not running from an AppImage mount, or a mount whose env needed no change)`.
- Non-empty → a line starting with the stable marker `hostenv: scrubbed`, naming the count and then every variable with its action, `NAME=set` or `NAME=removed`, **in `TAINTED_VARS` order** (which the const's doc already declares to be "the order the patch reports"). Walk `TAINTED_VARS` and look each name up in `set` / `remove` rather than iterating the two vectors — they are separate, so iterating them would report all the `set`s before all the `remove`s, which is not the documented order. E.g. `hostenv: scrubbed the AppImage's own paths out of every child env (4 variables): PATH=set, LD_LIBRARY_PATH=set, PYTHONHOME=removed, GI_TYPELIB_PATH=removed`.
- `describe` is **not** `cfg`-gated: off Linux the patch is always empty, so it returns the no-op line there, which is exactly what test 5 asserts. Walking `TAINTED_VARS` from a non-Linux target also means the const's existing `#[cfg_attr(not(target_os = "linux"), allow(dead_code))]` stays correct — an `allow` on an item that turns out to be used is harmless, so do not "tidy" that attribute away.
- Never print a variable's VALUE (a `PATH` is user data, and the log is a shared file). Names and actions only. `Debug` on the patch stays as it is for test failures.

In `for_child()`'s `OnceLock` initializer, log the verdict once, immediately after the `scrub(...)` call, and return the patch:

```rust
PATCH.get_or_init(|| {
    let exe = /* unchanged */;
    let patch = scrub(/* unchanged */);
    eprintln!("{}", patch.describe());
    patch
})
```

The doc comment on `for_child()` gains a paragraph: **why stderr and not `debuglog::log`** — the tools run in the Worker, and `debuglog::init_from_env()` is only ever called from `lib.rs::run()`, so a `debuglog::log` call from here would be a silent no-op in exactly the process where it matters (the same class of bug this task exists to kill). The Worker's stderr is piped and drained by the Supervisor into `supervisor.log` under the `worker-stderr:` prefix (`worker/client.rs`, proven by `tests/worker_stderr.rs`), which is the Worker's only log channel and the idiom `worker/mod.rs` already uses. In the Supervisor the line goes to the inherited stderr, which is where a `cargo run` developer sees it. Also state the two recorded limitations: the updater relaunch site (`commands/update.rs::relaunch_patch`) is deliberately silent, and an empty patch is reported as "changed nothing" without distinguishing a closed gate from a clean mount.

No change to `apply`, `apply_std`, `is_empty`, `scrub`, or the fixtures.

---

## Steps

- [ ] Read `src-tauri/src/agent/hostenv.rs` (module docs, `for_child`, `EnvPatch`, the `fixtures` submodule), `src-tauri/src/agent/tools/exec/search.rs` (both `KNOWN GAP` comments and both `cmd.args` blocks), `src-tauri/src/agent/tools/exec/tests/bash_hostenv.rs`, `src-tauri/src/agent/childproc.rs`'s census, and `docs/research/appimage-child-process-env-leak.md` §5 + §7.
- [ ] Re-run the two measurements above on this box so the plan's claims are yours, not the plan's. `rg` is at `/usr/bin/rg` (15.2.0); **`fd` is NOT on `PATH` here** — `find` on this machine takes the `walkdir` fallback, so nothing you write may assume `fd` exists.
- [ ] Write the failing tests in `src-tauri/src/agent/tools/exec/tests/search.rs` (they will not compile yet — that is the RED; it is a compile failure because `build_fd_command_with` does not exist, and that is fine, note it in the commit body rather than pretending it was an assertion failure). The file already has `use super::support::*;` (which brings `temp_cwd`, `ctx`, `text_of`) and `use crate::agent::tools::exec::{execute_tool, glob_match};`; add `use crate::agent::hostenv::EnvPatch;` and reach the builders as `crate::agent::tools::exec::search::{build_fd_command_with, build_rg_command_with}` (they are `pub(crate)`, and this module is inside the crate):

  1. **`the_search_children_start_in_the_space_cwd`** — cross-platform, no binaries needed. `build_fd_command_with("a.txt", &space, 100, &space, &EnvPatch::default())` and the `rg` equivalent, then assert `cmd.as_std().get_current_dir() == Some(&space)`. `EnvPatch::default()` is the right patch here (this test pins the cwd, not the env — the env is pinned by `bash_hostenv.rs`), and `std::process::Command::get_current_dir` is the honest introspection, exactly as `fixtures::configured_env` uses `as_std().get_envs()` for the same reason.
  2. **`the_search_argument_lists_are_unchanged`** — the trap-pin. Assert `cmd.as_std().get_args()` is EXACTLY `["--max-results", "100", "-g", "a.txt", "--", "<space>"]` for `fd`, and `["-m", "100", "--", "needle", "<space>"]` for `rg`, plus one `rg` case with `-i` + `--glob` proving `["-i", "--glob", "*.rs", "-m", "5", "--", "needle", "<space>"]` order. This is what reddens anyone who later reaches for `-a/--absolute-path`, `-C/--base-directory` or `--path-separator` and silently un-makes the prefix strip.
  3. **`a_slash_glob_matches_from_the_space_cwd`** — the bug itself. Guard on the file's existing `rg_available()` with the same early-`return` style as `grep_matches_fixture`. Build a Space with `sub/needle.txt` containing `needle`; call `execute_tool(&ctx(&cwd), "grep", …)` twice: first with NO `glob` (the control — must report `matches: 1`, proving the file and pattern are right so the glob is the only variable), then with `"glob": "sub/*.txt"` and assert `matches == 1`. Before the fix the second call returns `matches: 0`: `cargo test` runs with cwd = `src-tauri/`, never the Space. Also assert the returned line still carries the absolute root, pinning that `rg`'s output shape did not move — but compare against `std::fs::canonicalize(&cwd).unwrap().display().to_string()`, NOT the raw `cwd`: `validate` hands `rg` a CANONICAL root, and on macOS the temp dir is `/var/…` behind a `/private/var` symlink, so a raw-path `contains` is a false failure on macOS CI (the exact trap `exec/tests/support.rs` and `access.rs`'s "the comparison is CANONICAL on both sides" doc record).
  4. **`an_absolute_path_argument_still_reports_paths_relative_to_it`** — cross-platform, no `fd` needed (both arms produce the same answer). Space with `sub/c.txt`; call `find` with `"path": "<space>/sub"` (absolute — `validate` accepts it, it is inside the boundary) and `"pattern": "c.txt"`; assert `text_of(&r) == "c.txt"`. This pins the strip firing from a child whose cwd is the Space while the search dir is deeper.
  - Do NOT duplicate `find_matches_fixture` / `grep_matches_fixture` / `find_max_results_truncates` / `find_escape_rejected` / `grep_output_bounded_by_max_results` / `grep_option_like_pattern_is_matched_literally`. Verified against the tree: **none of them observes the child's cwd** — every one passes `.` or an absolute `path` that `validate` resolves before the spawn — which is exactly why the suite could neither catch this bug nor notice the fix, and why tests 1–4 are the coverage.
- [ ] Run `cargo test --lib agent::tools::exec::tests::search` from `src-tauri/`. It must fail to compile (missing builders). If it compiles and passes, stop — you implemented something before writing it, or you wrote a test that cannot fail.
- [ ] Implement `search.rs` (section 1). Run `cargo test --lib agent::tools::exec::tests::search` — all green, including the six pre-existing tests in the file.
- [ ] Run `cargo test --lib childproc` — the census must still pass (4 constructors, ≥3 `closed_stdin`, no constructor whose window closes before its `closed_stdin`). If Invariant C fires, the builders are in the wrong file order or a wrapper is constructing a `Command`.
- [ ] Write the failing `hostenv` tests, in `hostenv.rs`'s own `mod tests`, in that module's established style (a `/// Claim:` doc on each):
  5. **`an_empty_patch_reports_that_nothing_was_removed`** — **NOT `#[cfg]`-gated.** `assert!(EnvPatch::default().is_empty())` and `EnvPatch::default().describe().contains("changed nothing")`. This is the cross-platform NO-OP assertion the task demands (off Linux `scrub` is *defined* to return the empty patch, so the no-op IS the behaviour to pin and the test must RUN, not skip). Assert too that it does not contain `scrubbed ` as a verb-of-thing-done — the two verdicts must not be confusable.
  6. **`the_summary_names_every_variable_and_its_action`** — `#[cfg(target_os = "linux")]`, built on `super::fixtures::tainted_patch()` (the fabricated-host injection — never `for_child()`, which is empty under `cargo test` and would make the test assert nothing; the fixtures module already asserts its own patch is non-empty for exactly that reason). Assert it contains `hostenv: scrubbed`, `PATH=set`, `LD_LIBRARY_PATH=set`, `PYTHONHOME=removed`, and does NOT contain `changed nothing`. That is the discrimination issue #81 asks for: `PYTHONHOME` is the removed half, `LD_LIBRARY_PATH` the set half, and neither may be reported as "nothing to do".
- [ ] Implement `hostenv.rs` (section 2). Run `cargo test --lib hostenv` — expect **16** on Linux and **7** elsewhere: the module's own doc records a 14/6 split, test 5 is ungated (+1 on every target) and test 6 is Linux-only (+1 on Linux). If the counts do not move that way, one of the two was gated wrongly.
- [ ] Extend the fabricated-mount coverage in `src-tauri/src/agent/tools/exec/tests/bash_hostenv.rs` — this is the ONLY place a non-empty patch exists in a real process, so it is the only honest proof the line fires where it matters. In `a_bash_child_under_a_fabricated_appimage_mount_sees_a_scrubbed_env`, after the existing `CHILD_RAN` / `COVERAGE_FULL` assertions on the combined `log`, add two assertions on the same string:
  - `log.matches("hostenv: scrubbed").count() == 1` — the child runs three tests that together spawn a `bash`, an `fd` and an `rg` child, so "exactly one line" is the once-per-process pin. If this ever reads 2, the initializer is not the right place and you must find out why, not relax the count.
  - `log.contains("PYTHONHOME=removed")` — inside a fabricated mount the verdict must be the SCRUBBED one (`PYTHONHOME=$APPDIR/usr` is in the child's env and is `env_remove`d), never the `changed nothing` one.
  - Add nothing to `fabricated_child_half` itself: the parent already captures the child's piped stderr, and the parent's own `for_child()` verdict goes to the parent's stderr, which is not in `log` — so the count cannot be inflated by the parent.
- [ ] Run `cargo test --lib agent::tools::exec::tests::bash_hostenv` (this re-execs the test binary from a hard-linked fabricated AppDir; it is the slow one, ~seconds, and it already has a 180 s guard).
- [ ] Run `cargo fmt` from `src-tauri/`, then `cargo fmt --check`.
- [ ] Run `cargo clippy --all-targets` from `src-tauri/` — **0 warnings**. Watch for `too_many_arguments` on `build_rg_command_with` (see section 1) and for `unused` on anything left behind by the extraction.
- [ ] Run the FULL gate: `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/`; `pnpm test`, `pnpm build` from the repo root.
  - Baseline not to regress: `cargo test` **1360 passed / 0 failed / 4 ignored**, `pnpm test` **3051 tests / 149 files**, clippy 0 warnings, fmt clean. Expect the Rust count to rise by the new tests (5 in-crate + the two `bash_hostenv` assertions are not new tests, only new assertions). `pnpm` must be byte-identical — this task touches no frontend file.
  - If a Worker test complains about an unexpected `hostenv:` line, the cause is real and must be understood, not silenced: nothing in the tree asserts that a Worker's stderr is EMPTY (checked: `worker_smoke.rs` nulls stderr, `worker_stdin.rs` only prints it on failure, `worker_stderr.rs` asserts `contains`), so a fresh failure means something new.
- [ ] Commit with message: `fix(tools): find and grep start in the Space cwd, and the env scrub reports what it removed (#81)`

---

## Acceptance criteria

- [ ] `grep` with a `glob` containing a `/` returns the matches (`a_slash_glob_matches_from_the_space_cwd` green, and RED before the fix); the same call before the fix reported `matches: 0` with `is_error: false`.
- [ ] `exec_find` and `exec_grep` spawn with `current_dir(&ctx.cwd)`; `exec_bash` is untouched; the three tool children now agree on where a child starts.
- [ ] The `fd` and `rg` argument lists are byte-identical to before the change (`the_search_argument_lists_are_unchanged`), and no `fd`/`rg` flag was added.
- [ ] `find` output is still relative to the search dir (both the `fd` arm and the `walkdir` fallback) and `grep` output still carries the absolute root — the existing search tests plus tests 3 and 4 prove it.
- [ ] Both `KNOWN GAP` comments are gone, replaced by text that states the measured reason (`rg`'s cwd-relative `-g` globs) and the measured non-reason (`fd` echoes the absolute path).
- [ ] Exactly one `hostenv:` verdict line per process, on the Worker's stderr route, naming each scrubbed variable and its action when the scrub fired; proven once-and-only-once from inside the fabricated AppImage mount.
- [ ] `EnvPatch::describe`'s no-op verdict is asserted by a test that RUNS on macOS and Windows (not skipped, not `cfg`'d out), and the fired verdict by a Linux-only test built on `hostenv::fixtures` — never on `for_child()`.
- [ ] `cargo test` ≥ baseline with 0 failed / 4 ignored, `cargo clippy --all-targets` 0 warnings, `cargo fmt --check` clean, `pnpm test` 3051/149 unchanged, `pnpm build` exit 0.

---

## Recorded, not fixed here

- **`docs/research/appimage-child-process-env-leak.md` "Gaps (b)" is stale.** It claims `exec.rs`'s `--max-results` "is not an `fd` flag, so that fast path likely always errors and silently falls through". Measured false: `--max-results` is a documented `fd` option (present in `fd` 10.4.2's `cli.rs`, and `fd --max-results 10 -g a.txt -- <dir>` exits 0 with results). The `fd` fast path runs. Out of this task's file list — hand it to the orchestrator as a one-line doc correction, do not fold it into this commit.
- **The third scrub state** (gate closed vs gate open on a clean mount) is not distinguished — see Residual 2's recorded limitation. It is in `for_child()`'s doc comment now.
- **`relaunch_patch` stays silent** — deliberate, stated in the code comment.
- **`exec_grep`'s "ripgrep (rg) is not available" message** is misleading when the real cause is an un-openable `current_dir`. Accepted for consistency with `exec_bash`; no guard added.
