---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/37
done-when: From `src-tauri/`, `cargo test`, `cargo clippy --all-targets -- -D warnings` (0 warnings) and `cargo fmt --all -- --check` are green on ubuntu/windows/macos; `bash scripts/check-test-data-dir.test.sh` is green and the `scripts` CI job runs it; and with the data dir REDIRECTED (`XDG_DATA_HOME` on Linux, `APPDATA` on Windows, `HOME` on macOS) a full `cargo test` leaves **zero** `crash-*.log` in it — the observable form of what was reported. A real Worker crash still produces exactly one `crash-<ts>-worker-<pid>.log`, and the Stalled banner's path is that file (verified locally by SIGKILLing a session's Worker, as `worker_e2e.rs` does). No frontend file changes, so `pnpm test` / `pnpm build` are in the bar only because AGENTS.md's bar is unconditional.
---

# Harden the crash log — injected directory, retention, and pid-stamped attribution

**Goal:** stop a test panic from ever reaching the user's data dir, bound how many crash logs accumulate, and make the Stalled banner name the log belonging to the Worker that actually died.

**Architecture:** one module owns the whole contract — `src-tauri/src/agent/crashlog.rs`. It stops resolving its own destination (the directory is captured at hook-install time by the two production sites that know it) and gains a best-effort prune after each write. Attribution moves from *recency* to *identity*: the writer's pid enters the filename, `WorkerHandle` starts carrying the child's pid as a field captured at spawn, and the router selects the log by that pid. `agent/session/router.rs`'s `find_newest_crash_log` becomes `find_crash_log_for_pid`; `worker/manager.rs`'s `on_crash` gains a pid argument. Two guards keep the leak from returning: a source-level census invariant in the `childproc` idiom, and a CI step that runs the suite against a redirected data dir and requires it to stay empty.

**Tech Stack:** Rust 2021 pinned by `src-tauri/rust-toolchain.toml` (**1.99.0** — do not float it, AGENTS.md), `std::panic::set_hook`/`take_hook`, `std::backtrace::Backtrace::force_capture`, `std::process::id`, `std::fs::File::set_modified` (stable since 1.75, so the retention tests need no `filetime` dependency), `tokio::process::Child::id`, `dirs::data_dir()`, `serde` camelCase for `StalledInfo`. No new dependencies.

**Conventions for every task:** all Rust commands run from `src-tauri/` (where the pinned toolchain resolves). Merge bar per AGENTS.md: `cargo test`, `cargo clippy --all-targets -- -D warnings` (0 warnings, and `--all-targets` lints test code too), `cargo fmt --all -- --check`; frontend `pnpm test` + `pnpm build` stay green (untouched here). CI runs the Rust bar on ubuntu/windows/macos (`ci.yml:24`) — **every change must compile on all three**, and the retention/attribution code is platform-neutral (mtimes, not `stat`). Branch off `main` per `gitflow-branching`; squash-merge at the end. **Write the failing test first and confirm it fails** (AGENTS.md). Delete this doc on ship; the durable content is already in the ADR 0025 amendment.

**Evidence this plan stands on** — every claim below was re-verified against this tree during the design dialogue; the executing agent must NOT re-litigate them. ⚠ marks a trap a naive reading falls into.

- **The report was never a crash.** The pasted text is the *content* of `~/.local/share/archimedes/crash-1791290755196-worker.log`: our own `panic:`/`location:`/`backtrace:` format, frame 1 = `write_crash_log` (`crashlog.rs:61`, the production resolver), frame 9 = `crashlog::tests::the_panic_hook_writes_a_crash_log…`. **862** `crash-*.log` existed, 11 MB, **all 862** contain `tests::` in the backtrace, **0** are real Worker crashes. They were deleted as a one-off on 2026-10-18 (`rm ~/.local/share/archimedes/crash-*.log`) — app code owns only *future* files.
- **⚠ The mechanism is the hook slot, not the test's logic.** `std::panic` has ONE process-global hook slot and the `--lib` suite runs as threads of one process. `install_panic_hook_is_idempotent` must `take_hook` + install the production entry to prove the `Once`, so during its body the production writer is live for **every** thread. A panic anywhere in the lib binary in that window writes to `dirs::data_dir()/archimedes`.
- **The leak is already fixed for the observed case; this spec fixes the class.** `9035d9d` (2026-10-06 16:34) added the `HOOK` mutex + the per-run uuid marker; the newest leaked file is 14:45 the same day. Measured since: **12 consecutive `cargo test --lib` runs with `XDG_DATA_HOME` redirected → 1104 passed each, 0 files written.** At HEAD the paste's `location:` (`crashlog.rs:120:13`) does not even match — the `panic!` is at `135:16`, line 120 is `let dir = temp_dir();`. Several leaked files also name `crashlog::tests::poison_detached_task_panics_with_a_foreign_marker`, which exists in **no commit** (`grep -rn "FOREIGN POISON"` → nothing; 24 `panic: FOREIGN POISON MARKER` logs survive from an uncommitted local state). So: do not expect a red test at HEAD for the *original* symptom. The failing tests in Tasks 1–5 are for the *remaining* hazards.
- **`write_crash_log` (`crashlog.rs:59-62`) has exactly two callers, both in this file** (`sed -n` shows the hook closure at `:75` and the deleted-by-Task-1 test path). `install_panic_hook` has two callers: `lib.rs:316` (`"supervisor"`) and `agent/worker/mod.rs:46` (`"worker"`, inside `run_worker_inner`). Deleting it is therefore a 2-site change, not a hunt.
- **Install happens before any other thread exists** in both binaries: `lib.rs:316` is the first statement of `run()` (before `tauri::Builder`), and `run_worker_inner` (`worker/mod.rs:45`) is the first statement of the Worker's `block_on` (`lib.rs:298-303`). Capturing the dir in the closure has no unseeded state to fall back from — which is why it was chosen over a `debuglog`-shaped mutable global.
- **⚠ Do NOT read the pid at crash time.** `tokio::process::Child::id()` returns `None` once the child has been reaped — exactly the state a crash leaves behind (`kill`'s existing `if let Some(pid) = guard.id()` at `client.rs:701` is already written null-tolerantly for this reason). Capture it in `spawn()` (`client.rs:283`, a **sync** fn, so the pid is known immediately after `cmd.spawn()` at `:312`) into a field, and `pid()` reads the field.
- **`find_newest_crash_log` has TWO callers, and the second one is a bug.** `router.rs:169` (freeze into the `stalled` registry) and `router.rs:202` (the `session-stalled` emit re-globs). With a second Worker crash between the two, the pushed event and the pulled `stalled_info` name different files for one crash. Task 5 makes the emit reuse the frozen value.
- **`StalledInfo.crash_log`'s meaning and type are unchanged** (`Option<PathBuf>`, `None` = none found — `session/mod.rs:241-244`), so **no frontend change**: `SessionStalledBanner.tsx:42-50` renders the string and already null-checks it, and the path only reaches `externalOpen` (ADR 0051). `src/lib/tauri.ts:216-222` needs no edit. No code anywhere *reads* a crash log's contents — grep finds only the writer and this glob.
- **`on_crash`'s type is `Arc<dyn Fn(String, Option<i32>) + Send + Sync>`** (`manager.rs:445`, param at `:498`), fired once at `manager.rs:968` inside the `Exited` arm where `crashed = unexpected_exit(…)` was computed first. Production wiring is 2 closures (`lib.rs:118`, `session/mod.rs:2089`, both thin `move |s, c| m.handle_crash(&s, c)`); 11 further `WorkerManager::new` call sites are test fixtures (`manager.rs:1978` is the only closure of the 3-arg shape; the rest bind `_`). The pump already holds the `WorkerHandle` (`start_pump(…, handle.clone())`, `manager.rs:546-552`), so passing `handle.pid()` needs no new plumbing.
- **The prune pattern must be wider than the attribution pattern.** After Task 4 the real names are `crash-<ts>-worker-<pid>.log`, which `ends_with("-worker.log")` does NOT match. Prune on `starts_with("crash-") && ends_with(".log")`; attribution matches the pid suffix explicitly and falls back to the pid-less shape.
- **Retention runs AFTER a successful write only.** `write_crash_log_from_info` currently ends `create_dir_all(dir).ok()?; fs::write(&path, content).ok()?; Some(path)` — prune goes between the `ok()?` and `Some(path)`, so a full disk still loses history rather than the crash log, and a failed write mutates nothing. Every fallible call in the prune is `.ok()`/`if let Ok` — it must never panic (it runs inside a panic hook) nor lose the just-written log.
- **The census idiom is the one `childproc.rs` already ships**: `SELF: &str = "agent/childproc.rs"` (`:198`), `is_comment` (`:217`), `production_region` = code lines before the first non-comment `#[cfg(test)]` (`:231`), hand-rolled recursive `rust_files` because "a census test does not get to add a dependency" (`:255`), and it **panics rather than skipping** an unreadable file. Reuse the same posture; do not add `walkdir`.
- **⚠ The CI check is vacuous without the redirect.** A runner's real data dir was never written to, so "no crash logs there" passes for the wrong reason — the exact failure mode recorded at `exec.rs:1780-1791` (the first version of the stdin test passed with `closed_stdin` deleted, because CI's fd 0 was already `/dev/null`). So Task 6 sets the env var on the `cargo test` step AND names it for the check step. One variable per OS: `dirs::data_dir()` honours `XDG_DATA_HOME` (Linux), `APPDATA` (Windows), `HOME` (macOS).
- **`test_support` is already `pub mod` (`lib.rs:11`) with `ENV_LOCK`/`env_lock()`** — reuse it; do not add a second env lock. ⚠ Do NOT have any test call `set_var` on those variables: `commands/files.rs:1101-1112` refused precisely that, because the lib binary reads env globally without holding `ENV_LOCK` (`tools::sandbox`'s `$HOME/.gitconfig` read decides every Landlock ruleset, plus `mcp::oauth`, `session::router`, `commands::mcp`). The suite's own data-dir var stays **read-only** in tests; the isolation lives in CI + a shell script.

---

## Task 1 — `install_panic_hook` takes the directory; `write_crash_log` is deleted

**Files:**
- Modify: `src-tauri/src/agent/crashlog.rs` (signature, closure body, delete `write_crash_log:59-62`, module doc `1-19`, both tests)
- Modify: `src-tauri/src/lib.rs:316` — `crashlog::install_panic_hook("supervisor", dir)` with `dir = dirs::data_dir().map(|d| d.join("archimedes"))`; when `None`, skip installing (same no-op posture as today) and `debuglog::init_from_env()` still runs.
- Modify: `src-tauri/src/agent/worker/mod.rs:46` — the same shape with tag `"worker"`.
- Test: inside `crashlog.rs`'s `mod tests`.

**Steps:**

- [ ] **Write the failing test.** In `mod tests`, assert the production hook writes where it was *told*: `install_panic_hook("worker-capture", temp_dir())`, force a panic carrying a fresh uuid marker on a spawned thread (reuse the existing channel-signals-before-panicking idiom), then assert the marker's file exists **in that temp dir**. Run: `cargo test --lib agent::crashlog` → expect **compile error** (the fn takes one argument). That is the red.
- [ ] **Implement.** `pub fn install_panic_hook(tag: &str, dir: std::path::PathBuf)` — the `Once` stays, `take_hook`/chain stays, the closure calls `write_crash_log_from_info(&dir, &tag, info)`. Delete `write_crash_log`. Fix the two call sites to resolve `dirs::data_dir().map(|d| d.join("archimedes"))` and skip the install on `None`.
- [ ] **Rewrite `install_panic_hook_is_idempotent`** to pass a temp dir. Keep the `HOOK` mutex and the capture/restore dance (it still orders the two tests and still restores the slot) — but the production dir is now never named in this binary. Note in the doc comment that the mutex orders the tests and that the injected dir is what makes the real path unreachable; the current comment claims only the mutex does.
- [ ] **Verify:** `cargo test --lib agent::crashlog` green; `cargo test` green; `grep -n "dirs::data_dir" src/agent/crashlog.rs` → **no hits outside comments**; `grep -rn "write_crash_log\b" src/ tests/` → no hits (only `write_crash_log_from_info`); `cargo clippy --all-targets -- -D warnings`; `cargo fmt --all -- --check`.
- [ ] **Commit:** `fix(crashlog): the panic hook is handed its directory — write_crash_log deleted`

## Task 2 — the census invariant: `crashlog.rs` never resolves a data dir

**Files:**
- Test: `src-tauri/src/agent/childproc.rs` (extend the existing census with invariant D, reusing `production_region`/`is_comment`/`rust_files`)

**Steps:**

- [ ] **Write the failing test first, before Task 1 lands if worked in parallel** — the honest red for this invariant is the *pre*-Task-1 file. Add invariant **D** to `production_source_has_exactly_one_child_constructor` (or a sibling test sharing its helpers): no production line of `agent/crashlog.rs` contains `dirs::data_dir()`, with `SELF` widened to cover that file (it is a different module, so name the file the invariant is about in the assertion message). Prove the guard is not vacuous the way `childproc` does: assert the region scan of `crashlog.rs` is non-empty (it must actually have read the file) and that `production_region` stops at `#[cfg(test)]` — otherwise a `dirs::data_dir()` living only in tests would sail through and the invariant would guard nothing.
- [ ] **Confirm the red two ways:** on a scratch checkout of the parent commit it must fail on `crashlog.rs:60`; with Task 1 applied it must pass. Record both in the commit message (the `exec.rs` lesson: a guard that cannot go red is not a guard).
- [ ] **Verify:** `cargo test --lib agent::childproc`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`.
- [ ] **Commit:** `test(crashlog): census invariant — the crash-log module may not resolve a data dir`

## Task 3 — retention: 30 days and 50 files, pruned after the write

**Files:**
- Modify: `src-tauri/src/agent/crashlog.rs` — `pub const MAX_CRASH_LOG_AGE_DAYS: u64 = 30; pub const MAX_CRASH_LOG_FILES: usize = 50;` (beside `debuglog`'s `MAX_LOG_BYTES`/`MAX_LINE_BYTES` for discoverability), `fn prune_crash_logs(dir: &Path)`, called from `write_crash_log_from_info` after `fs::write` succeeds.

**Steps:**

- [ ] **Write the failing tests** (each over its own `temp_dir()`, using `write_crash_log_from_info` directly so the hook mutex is not needed):
  1. **Count:** create 51 `crash-<n>-worker.log` files, write one crash, assert exactly 50 remain and the oldest-by-mtime is gone.
  2. **Age:** create one file with mtime 31 days ago plus 3 fresh ones, write one crash, assert the old one is deleted and the 3 fresh survive. (Set mtimes with `std::fs::OpenOptions::new().write(true).open(p)?.set_modified(…)` — std, no `filetime`.)
  3. **It spares what it must not touch:** a `supervisor.log`, a `notes.txt` and a `crash-notalog` (no `.log`) all survive a prune.
  4. **No partial state on a failed write:** point `write_crash_log_from_info` at a path whose `create_dir_all` fails (e.g. `temp/<uuid>/afile/afile/nested`, an existing *file* as a path component), assert the return is `None` and that nothing in the readable parent was deleted.
  5. **The pid shape is pruned** (write with Task 4's name if these land together, else create names by hand): a dir of 60 `crash-*-worker-<pid>.log` prunes to 50 — this is the test that catches a prune pattern narrow enough to spare the new names.
  Run `cargo test --lib agent::crashlog` → all five **fail** (no prune exists).
- [ ] **Implement.** One `read_dir`, collect `(mtime, path)` for names matching `starts_with("crash-") && ends_with(".log")`; delete every entry older than `MAX_CRASH_LOG_AGE_DAYS`; then if `remaining > MAX_CRASH_LOG_FILES` delete oldest-first until it is not. No sorting dependency beyond `sort_by_key` on mtime. Every fallible call swallowed. Doc comment states: runs **after** the write, best-effort, pattern deliberately wider than the attribution matcher, mtime is the only clock (the same one `find_crash_log_for_pid` trusts).
- [ ] **Verify:** `cargo test --lib agent::crashlog` green; `cargo test`; `cargo clippy --all-targets -- -D warnings`; `cargo fmt --all -- --check`.
- [ ] **Commit:** `feat(crashlog): retain the newest 30 days / 50 crash logs`

## Task 4 — the pid in the filename, and `WorkerHandle::pid()`

**Files:**
- Modify: `src-tauri/src/agent/crashlog.rs` — the name becomes `crash-{ts}-{tag}-{pid}.log` with `std::process::id()`.
- Modify: `src-tauri/src/agent/worker/client.rs` — `WorkerHandle` gains `pid: Option<u32>` captured from `child.id()` inside `spawn()` (right after `cmd.spawn()` at `:312`, before the stdio `take`s) + `pub fn pid(&self) -> Option<u32>`.
- Test: `client.rs` tests (or the existing worker test module) for a live fixture child.

**Steps:**

- [ ] **Write the failing tests.** (a) `write_crash_log_from_info` into a temp dir produces a name matching `crash-<ts>-<tag>-<own pid>.log` — assert `name.ends_with(&format!("-{}.log", std::process::id()))`, which is exact rather than a regex. (b) `WorkerHandle::spawn_fixture()?.pid()` is `Some` and equals a pid obtainable while the child is alive; assert it is still `Some` after `kill()` (the pin that a *field*, not `Child::id()`, is what backs it — this is the test that fails if someone "simplifies" it to the lock-based read).
- [ ] **Implement** both. Update the module doc's filename description and the `StalledInfo.crash_log` doc in `session/mod.rs:241-244` to the new shape.
- [ ] **Verify:** `cargo test --lib agent::crashlog`, `cargo test --lib agent::worker`, `cargo test` (this redden-tests nothing else because the name is only parsed in Task 5), `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`.
- [ ] **Commit:** `feat(crashlog): stamp the crash log with the writing process's pid`

## Task 5 — attribution by pid, and one frozen path per crash

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs` — `on_crash: Arc<dyn Fn(String, Option<i32>, Option<u32>) + Send + Sync>` (`:445`, `:498`), fire `(state.on_crash)(session_id.clone(), code, handle.pid())` at `:968`, module doc `18-21`.
- Modify: `src-tauri/src/agent/session/router.rs` — `find_crash_log_for_pid(Option<u32>) -> Option<PathBuf>`; `handle_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>)`; the `:202` emit reuses the frozen `crash_log`.
- Modify: `src-tauri/src/lib.rs:118` and `src-tauri/src/agent/session/mod.rs:2089` (3-arg closures); test fixtures that build a `WorkerManager` (`manager.rs:1978`, `subagent.rs:446/799/816/852`, `harness/loop.rs:6621`, `harness/dispatch.rs:436`, `tests/worker_e2e.rs:155`, `tests/session_native.rs:123`, `tests/harness_dispatch_native.rs:79`, `tests/harness_subagent_dispatch.rs:87`) and `handle_crash` callers (`naming.rs:2095`, `:2120`).

**Steps:**

- [ ] **Write the failing tests.**
  1. `find_crash_log_for_pid(Some(4242))` in a temp dir holding `crash-<older>-worker-4242.log` and a **newer** `crash-<newer>-worker-9999.log` returns the 4242 file. (Fails today — recency wins.)
  2. `find_crash_log_for_pid(None)` still returns the newest pid-less `crash-*-worker.log` (a pre-amendment log stays attributable).
  3. `find_crash_log_for_pid(Some(1))` with only unrelated logs present returns `None` rather than guessing — the exactness claim. (This is a **behaviour change**: today a foreign log would be returned. Say so in the commit body.)
  4. Router: `handle_crash(id, Some(1), Some(pid))` where a temp data dir holds one pid-matching log → the registry's `StalledInfo.crash_log` and the `session-stalled` payload's `crashLog` are the **same** path. Today's `router.rs:202` re-glob makes these differ when a second log is newer — seed exactly that. ⚠ These two need the data dir injectable: `find_crash_log_for_pid` takes the dir as a parameter (exactly Task 1's principle), the router resolves `dirs::data_dir()` at its own call site, and the tests pass a temp dir.
- [ ] **Implement** the widening; keep the matcher's fallback explicit in code, not implied: match `crash-*-{tag}-{pid}.log` first, else newest pid-less `crash-*-worker.log` **only when `pid` is `None`**. Doc comment on the fn replaces the "globbed and FROZEN … best-effort" wording with the identity rule.
- [ ] **Verify:** `cargo test --lib agent::session`, `cargo test --lib agent::worker`, `cargo test` (the integration suites — `worker_e2e.rs`, `session_native.rs` — compile with the widened callback), `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`.
- [ ] **Manual check (the report's real-world counterpart):** `cargo run` a debug build, start a session, `kill -9` its Worker child, confirm exactly one `crash-<ts>-worker-<pid>.log` appears, the banner names **that** file, and `crashLog` is non-null in the `session-stalled` event. Record the observed path in the commit message.
- [ ] **Commit:** `fix(session): attribute the crash log by pid, and emit the path the registry froze`

## Task 6 — the CI leak guard

**Files:**
- Create: `scripts/check-test-data-dir.sh`, `scripts/check-test-data-dir.test.sh`
- Modify: `.github/workflows/ci.yml` — env on the `cargo test` step (`:129-131`), a step in the `scripts` job (beside `check-versions.test.sh`, `:146-170`)

**Steps:**

- [ ] **Write the failing harness first:** `check-test-data-dir.test.sh` in the house style (the sibling scripts pair a script with a `.test.sh` harness that runs it against fixtures in a scratch dir): (1) a data dir containing `crash-123-worker-9.log` → **exit non-zero** and the offending path is printed; (2) a data dir containing only `supervisor.log` + `archimedes.db` → **exit 0**; (3) the dir does not exist at all → **exit 0** (nothing ran); (4) a nested `<dir>/archimedes/crash-1-worker-2.log` is found, so a platform whose `data_dir()` nests `archimedes` cannot pass vacuously. Run `bash scripts/check-test-data-dir.test.sh` → fails (no script yet).
- [ ] **Implement** `check-test-data-dir.sh <dir>`: `find "$dir" -name 'crash-*.log'` (or a portable `walkdir`-free loop), print hits, exit 1 if any. Accept the OS difference by taking the path as an argument — the workflow computes it. Document in the header **why the caller must redirect** and that an unredirected path makes the check vacuous (cite `exec.rs:1780-1791`).
- [ ] **Wire CI:** on the `cargo test` step set `XDG_DATA_HOME: ${{ runner.temp }}/adh` (Linux), `APPDATA: …` (Windows), `HOME: …` (macOS) via an `include`-style per-OS mapping or a `if: runner.os == …` pair of env blocks; then a `Check the test suite wrote no crash log` step running `bash scripts/check-test-data-dir.sh "$RUNNER_TEMP/adh"` with the same value exported (a step's env must name it explicitly — env does not leak between steps).
- [ ] **Prove the guard can go red:** locally, `XDG_DATA_HOME=/tmp/guardred cargo test --lib` after temporarily reverting Task 1's `install_panic_hook_is_idempotent` temp-dir change, then run the script on `/tmp/guardred` and require exit 1 with the leaked path printed. Record the observed red in the commit message; a guard nobody has seen red is a guess.
- [ ] **Verify:** `bash scripts/check-test-data-dir.test.sh` green; `bash -n` both scripts; `cargo test` unaffected; `pnpm test`/`pnpm build` untouched.
- [ ] **Commit:** `ci(crashlog): assert the test suite leaves its own data dir crash-log-free`

## Task 7 — docs

**Files:**
- Modify: `docs/decisions/0025-sessions-in-worker-processes.md` — **already drafted** during the design dialogue (the `## Amendment (2026-10-18)` section plus the summary pointer). Verify the final code matches its wording (the amendment names `install_panic_hook(tag, dir)`, `find_crash_log_for_pid`, `MAX_CRASH_LOG_AGE_DAYS`/`MAX_CRASH_LOG_FILES`, the 3-arg `on_crash`) and correct any drift; commit it with this branch if it has not landed on `main` already.
- Modify: `CONTEXT.md` — the **Crash log** glossary entry (drafted) — confirm the name and the retention numbers match what shipped.
- Delete: this file, on ship.

**Steps:**

- [ ] Diff the drafted amendment and glossary entry against the merged code; fix drift in symbols/numbers only (the ADR's *reasoning* is settled).
- [ ] **Verify:** `grep -n "MAX_CRASH_LOG_FILES" docs/decisions/0025-*.md CONTEXT.md` agrees with `crashlog.rs`; `grep -rn "write_crash_log\b" docs/` finds no stale claim.
- [ ] **Commit:** `docs: the crash-log contract (ADR 0025 amendment + glossary)`
