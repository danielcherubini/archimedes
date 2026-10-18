---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/37
done-when: From `src-tauri/`, `cargo test`, `cargo clippy --all-targets -- -D warnings` (0 warnings) and `cargo fmt --all -- --check` are green on ubuntu / windows / macos. `bash scripts/check-test-data-dir.test.sh` is green and the `scripts` CI job runs it. On Linux and macOS, with the data dir redirected (`XDG_DATA_HOME` / `HOME`) and `ARCHIMEDES_TEST_DATA_DIR` naming it, a full `cargo test` leaves **zero** `crash-*.log` in that directory and the redirect-verification test is live — this is the observable form of what was reported. Windows runs no redirect-dependent step (`dirs` cannot be redirected there — see Task 7) and is guarded by the census invariant alone. A **real panic** in a Worker produces `crash-<ts>-worker-<pid>.log` (proved by the `crashlog` unit tests — a SIGKILL writes nothing, see Task 6's ⚠), and a SIGKILLed Worker's **Stalled** banner names exactly the pid-matching log seeded for it. No frontend **behaviour** change (one stale doc-comment line in `src/lib/tauri.ts` is corrected); `pnpm test` / `pnpm build` are in the bar because AGENTS.md's bar is unconditional.
---

# Harden the crash log — Plan

**Goal:** make it impossible for a test panic to write into the user's data dir, bound how many crash logs accumulate, and make the **Stalled** banner name the log belonging to the **Worker** that actually died.

**Architecture:** one module owns the crash-log contract — `src-tauri/src/agent/crashlog.rs`. It stops resolving its own destination: the directory is captured at hook-install time by the two production sites that know it, and the resolver that used to run *during the panic* is deleted. A best-effort prune runs after each write. Attribution moves from recency to identity — the writer's pid enters the filename, `WorkerHandle` carries the child's pid as a field captured at spawn, and `agent/session/router.rs` selects the log by that pid. Two guards keep the leak from returning: a source-level census invariant (in the `childproc` idiom) and a CI step that runs the suite against a redirected data dir and requires it to stay empty.

**Tech Stack:** Rust 2021, toolchain pinned by `src-tauri/rust-toolchain.toml` (**1.99.0** — do not float it, AGENTS.md), `std::panic::{set_hook,take_hook}`, `std::backtrace::Backtrace::force_capture`, `std::process::id`, `std::fs::File::set_modified` (stable since 1.75 — verified working on this pinned toolchain; the retention tests need **no** `filetime` dependency), `tokio::process::Child::id`, `dirs` **6.0.0** (`Cargo.toml:38`, `dirs-sys` 0.5.0), `serde` camelCase for `StalledInfo`. **No new dependencies.**

**Conventions for every task:** use plain `cargo test`, never `cargo test --workspace` — the latter silently re-runs stored binaries and has reported a 1,097-test run against a tree with 1,117 (a phantom regression that exists only in the report). All Rust commands run from `src-tauri/` — where the pinned toolchain resolves (AGENTS.md). Merge bar: `cargo test`, `cargo clippy --all-targets -- -D warnings` (0 warnings; `--all-targets` lints test code too), `cargo fmt --all -- --check`; `pnpm test` + `pnpm build` stay green. CI runs the Rust bar on ubuntu / windows / macos (`.github/workflows/ci.yml:29`), so **every change must compile on all three** — the retention and attribution code is platform-neutral (mtimes only, never `stat`). Branch off `main` per `gitflow-branching`; squash-merge at the end. **Write the failing test first and confirm it fails** (AGENTS.md). **Tasks 1→6 are strictly ordered** — Task 2 is green-on-arrival only after 1; Task 3 uses 1's seam; Task 5 renames what 1 writes; Task 6 consumes 4's accessor and 5's predicate. Task 7 (the CI guard) and Task 8 (docs) may follow in any order once 6 lands. Delete this doc on ship — the durable content is in the ADR 0025 amendment.

**⚠ Working-tree warning before you start:** all line numbers below were re-pinned against `main` at `7914bb2`. `src-tauri/src/lib.rs` is a busy file — on the in-flight ADR-0061 branch its `install_panic_hook` call sits at `:372`, not `:316` — so if you branch from anything other than `main`, re-verify before trusting a `lib.rs` number. **Re-locate every cited symbol by name (`grep -n`) before editing**; a stale line number points you at the wrong code, which is the exact failure this repo's own roadmap doc once had.

**Evidence this plan stands on** — every claim below was re-verified against this tree, the vendored crates, the pinned compiler and measured runs. The executing agent must NOT re-litigate them; the ⚠ items were each independently reproduced and are the ones a naive reading gets wrong. ⚠ marks a trap.

- **The report was never a crash.** The pasted text is the *content* of `~/.local/share/archimedes/crash-1791290755196-worker.log`, in our own `panic:`/`location:`/`backtrace:` format: frame 1 is `write_crash_log` (`crashlog.rs:59` — the production resolver) and frame 9 is `crashlog::tests::the_panic_hook_writes_a_crash_log…`. Measured: **862** `crash-*.log` files, 11 MB, **all 862** contain `tests::` in the backtrace, **0** are real Worker crashes. Deleted as a one-off on 2026-10-18; app code owns only *future* files.
- **⚠ The mechanism is the hook slot, not the test's logic.** `std::panic` has ONE process-global hook slot and the `--lib` suite runs as threads of one process. `install_panic_hook_is_idempotent` (`crashlog.rs:196`) must `take_hook` + install the production entry to prove its `Once`, so for the duration of that test's body the production writer is live for **every** thread — a panic on any other test's thread in that window writes to `dirs::data_dir()/archimedes`.
- **⚠ `std::panic::PanicHookInfo` is unconstructible outside std, so no test can call `write_crash_log_from_info` directly.** Verified on the pinned 1.99.0: `error[E0451]: fields payload, location, can_unwind and force_no_backtrace of struct PanicHookInfo are private` (std `panic.rs:42-47`; the only constructor `PanicHookInfo::new` is `pub(crate)`, `panic.rs:51`). A `&PanicHookInfo` exists only inside a live panic hook. **That is why every test in this plan goes through a `PanicHookInfo`-free writer seam (Task 1) rather than the hook** — and it is why Tasks 3 and 5 must NOT be written the obvious way.
- **⚠ `static ONCE` in `install_panic_hook` (now `crashlog.rs:120`) is process-global and single-use.** Restoring the hook does not reset it. If two tests call `install_panic_hook`, whichever runs second is a **silent no-op** — one test fails depending on test order, and the idempotency test passes having proven nothing. Hence Task 1's non-`Once` inner closure, so **exactly one test ever consumes the `Once`**.
- **⚠ Widening `on_crash` to three args trips `clippy::type_complexity`, which is a build failure under `-D warnings`.** Measured with this pinned `clippy 0.1.99`: the 2-tuple lints nothing, the 3-tuple warns at both the field (`manager.rs:445`) and the ctor param (`:498`). The file already carries the remedy as idiom — `type CwdRegistrar` (`:475`) and `type SinkLookup` (`:481`), the latter existing precisely for this lint.
- **⚠ `WorkerHandle`'s `Clone` is a hand-written `impl Clone` listing all six fields (`client.rs:179-190`) — there is no `#[derive(Clone)]`.** Adding a field without adding it there is `error[E0063]: missing field 'pid' in initializer`.
- **⚠ Do NOT read the pid at crash time.** `tokio::process::Child::id()` returns `None` once the child is `Done`/reaped (`tokio-1.53.x/src/process/mod.rs:1222-1227`) — exactly the state a crash leaves. The existing `if let Some(pid) = guard.id()` at `client.rs:701` is already written null-tolerantly for this reason. Capture at spawn: `spawn()` (`client.rs:283`) is **sync**, `cmd.spawn()` lands at `:310`, and `child` stays `&mut` until the `Arc` wrap at `:324` — the pid is available in that window.
- **⚠ `router.rs:394` already parses the crash-log name** (`name.starts_with("crash-") && name.ends_with("-worker.log")`), so **renaming the file without widening that matcher in the same commit silently drops the banner's crash-log link**, and no test catches it (`tests/ipc.rs:495-509` asserts only that `at` is a number; nothing asserts `crashLog` is non-null). Task 5 therefore lands the name and a both-shapes matcher together.
- **`write_crash_log` (pre-Task-1 `crashlog.rs:59-62`) had exactly one caller** — the hook closure at `:75`. (Task 1 deleted it; the citation is the pre-change state it was measured against.) `install_panic_hook` has exactly two: `lib.rs:316` (tag `"supervisor"`) and `agent/worker/mod.rs:46` (tag `"worker"`). No test asserts hook installation.
- **Install happens before any other thread runs app code** in both binaries: `lib.rs:316` is the first statement of `run()`, before `debuglog::init_from_env()` (`:317`). In the Worker, `run_worker()` (`lib.rs:298-303`) builds a **multi-thread** tokio runtime before `block_on`, so worker threads *exist* by the time `run_worker_inner`'s install runs — the safety argument is "none of them is running our code yet", not "no threads exist". Say it that way in the comment; a reader who counts threads will otherwise find the claim false.
- **⚠ A `None` data dir is not a supported state.** `setup()` already hard-fails on it (`lib.rs:416-420`, `"could not resolve the platform data dir"`), so Task 1's "skip the install when `None`" is belt-and-braces, not a supported mode. Say so at the call site.
- **⚠ `dirs` 6.0.0 resolves the Windows data dir with `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`** (`dirs-sys-0.5.0/src/lib.rs:150-178`; `dirs-6.0.0/src/win.rs:10`), which **ignores `%APPDATA%`**. Linux honours `XDG_DATA_HOME` (`lin.rs:11`); macOS is `$HOME/Library/Application Support` (`mac.rs:7,12`), so only `HOME` redirects it. The CI redirect is therefore **impossible on Windows** — see Task 7.
- **⚠ The CI check is vacuous without the redirect.** A runner's real data dir was never written to, so an unredirected "no crash logs there" passes for the wrong reason — the trap recorded at `agent/tools/exec.rs:1780-1791` (the first version of the stdin test passed with `closed_stdin` deleted, because CI's fd 0 was already `/dev/null`).
- **⚠ A SIGKILL never fires the panic hook, so it writes NO crash log** — the repo already records this verbatim at `tests/worker_e2e.rs:851-855` ("a SIGKILL never fires the panic hook (the process is killed, not panicked), so no `crash-*.log` is written on THIS path — the crash log's content contract … is covered by the `crashlog` unit test"), and `src/bin/fake_worker.rs:584` implements its `__crash__` as `std::process::exit(137)`, which also writes nothing. So the manual SIGKILL check in Task 6 proves the **pid plumbing** (attribution against a seeded file), never the log's content — and its correct post-fix observation for an *unseeded* dir is `crashLog: null`, not a path. An agent told otherwise hunts a phantom.
- **⚠ Getting the child into the reaped state (where `Child::id()` is `None`): use `send_close()` + `exited().await`.** tokio's `Child::kill()` IS `start_kill()` + `wait()` (`tokio-1.53.1/src/process/mod.rs:1325-1329`), so `handle.kill().await` does reap — but it publishes exit code **`None`** for a signal death, and `exited()` blocks on `wait_for(|v| v.is_some())` (`client.rs:682`), so `kill()` followed by `exited().await` **hangs forever**. The graceful path is deterministic: `send_close()` (sync, `client.rs:571`) → `fake_worker` answers `Inbound::Close` with `std::process::exit(0)` (`src/bin/fake_worker.rs:917`) → stdout EOF → the read task takes the child lock, `wait()`s and publishes `Some(0)` (`client.rs:443-450`) → `exited()` returns and `Child::id()` is now `None` (`FusedChild::Done`, `tokio-1.53.1:1222-1227`). It also avoids racing the read task over the child lock.
- **⚠ The redirect has only been measured on the `--lib` suite on Linux.** The CI step it changes is plain `cargo test` (all targets), and the integration binaries spawn the **real** binary (`tests/worker_smoke.rs:15`, `tests/worker_stdin.rs:55`, `tests/worker_e2e.rs:46`), so the redirect × integration-spawn combination is first exercised on CI's macOS arm unless Task 7 runs the full redirected suite locally. Treat a macOS-arm surprise as expected-to-be-investigated, not as a mystery.
- **The measured `HOME` redirect breaks no test.** `HOME=/tmp/hometest cargo test --lib` → **1104 passed, 0 failed** — the count at plan-writing time, before Tasks 1-7 added tests (it is 1124 now; what matters is 0 failed) (Linux; `XDG_DATA_HOME` unset there, so this is the harsher macOS-shaped redirect). Verified non-issues, so you do not re-litigate them: `mcp::oauth::auth_file_path()` is never called from a test; the two `$HOME`-reading tests documented safe-by-construction (`harness/launch.rs:614-621`, `harness/loop.rs:6939-6946`) stay safe because `boundary::push_roots` (`boundary.rs:104-112`) drops non-existent roots; `debuglog::init_from_env_reads_the_var_once` (`debuglog.rs:217-231`) re-points its dir before writing, so it creates nothing in the data dir. Two **behaviour-neutral but visible** effects to expect, not flakes: `tools::sandbox::private_dir_outside_the_read_allow_list` (`tools/sandbox.rs:760-786`) filters candidates under `/tmp`, so a `HOME=/tmp/…` run changes what `sandbox_coverage_is_reported` prints and may take the designed `SKIP-SANDBOX` path (`:1416-1437`, print-only); and the integration tests spawn the **real binary** (`tests/worker_smoke.rs:15`, `tests/worker_stdin.rs:55`, `tests/worker_e2e.rs:46` via `CARGO_BIN_EXE_archimedes`), whose children inherit the redirect — which is what the guard wants.
- **⚠ No test may call `set_var` on `HOME`/`XDG_DATA_HOME`/`APPDATA`.** `commands/files.rs:1101-1119` refused exactly that: the lib binary reads env globally **without** holding `test_support::ENV_LOCK` (`tools::sandbox`'s `$HOME/.gitconfig` read decides every Landlock ruleset, plus `mcp::oauth`, `session::router`, `commands::mcp`). `ARCHIMEDES_TEST_DATA_DIR` is read-only in tests; the isolation lives in CI plus a shell script. `test_support` is already `pub mod` (`lib.rs:11`) with `ENV_LOCK`/`env_lock()` and its own `#[cfg(test)] mod tests` — reuse it, add no second lock.
- **The census idiom to copy is `agent/childproc.rs`'s**: `SourceLine` (`:190`), `SELF: &str = "agent/childproc.rs"` (`:198`, `/`-normalised relative to `src/` so it holds on Windows), `is_comment` (`:217`), `production_region` = code lines up to the first non-comment `#[cfg(test)]`, panicking rather than skipping (`:231`), hand-rolled recursive `rust_files` (`:255`, "a census test does not get to add a dependency"), `src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src")` (`:300`). All are module-level items of `mod tests`, so a **sibling `#[test]` can call them**. `is_comment`'s documented blind spot (lines starting with `*` are dropped, `:211-216`) applies to your new invariant too — name it rather than implying the region is exact.
- **`on_crash` is `Arc<dyn Fn(String, Option<i32>) + Send + Sync>`** (`manager.rs:445`, ctor param `:498`), fired **once** at `:968` inside the `Exited` arm after `let crashed = unexpected_exit(&state, &session_id);` (`:952`). The pump receives the handle (`start_pump` at `:818`, called at `:549-555` and for subagents at `:1318-1324`) and currently does **not** move it into the spawned future, so capture the pid **before** `tokio::spawn` rather than extending the future's captures.
- **`find_newest_crash_log` (`router.rs:388-402`) has TWO callers and the second is a bug:** `:169` freezes it into the `stalled` registry, `:202` **re-globs** it for the `session-stalled` emit — a second Worker crash between them makes the pushed event and the pulled `stalled_info` name different files for one crash.
- **`StalledInfo.crash_log` keeps its type and meaning** (`Option<PathBuf>`, `None` = none found — `session/mod.rs:236-246`), so there is **no frontend behaviour change**: `SessionStalledBanner.tsx:42-50` renders the string and is already null-safe, and the path only reaches `externalOpen` (ADR 0051). **No code reads a crash log's contents anywhere** — grep finds only the writer and this glob.
- **⚠ The prune pattern must be WIDER than the attribution pattern.** The real names become `crash-<ts>-worker-<pid>.log`, which `ends_with("-worker.log")` does **not** match. Prune on `starts_with("crash-") && ends_with(".log")`; only attribution matches the pid suffix. And the guard must ignore `supervisor.log`/`supervisor.log.old` (`debuglog.rs:82,88`), which land in **the same** redirected dir — widening the pattern would make the CI check permanently red.

---

### Task 1: the hook is handed its directory, and a `PanicHookInfo`-free writer seam exists

**Context:** the hook resolves `dirs::data_dir()` *during* the panic, so whichever closure occupies the process-global hook slot decides where the file goes — and one test must put the production entry in that slot to prove its `Once`. That is how 862 test panics reached the user's directory. The fix is to make the hook unable to resolve anything: both production sites hand it a directory at install time and the resolver is deleted, making the reported failure signature unconstructible rather than unlikely.

This task also introduces the **writer seam** every later test needs. `PanicHookInfo` is unconstructible outside std (Evidence), so a test that wants to exercise the writer must not go through `write_crash_log_from_info`. Extracting `write_crash(dir, tag, payload, location)` now keeps Task 3 and Task 5 testable without a hook, without the `HOOK` mutex, and without the "a foreign panic lands in my temp dir" hazard documented at `crashlog.rs:112-116`. It also extracts `hook_closure`, so the `Once` stays single-use but is consumed by exactly one test.

**Files:**
- Modify: `src-tauri/src/agent/crashlog.rs` — new `fn write_crash`, `write_crash_log_from_info` (`:29-55`) reduced to an adapter, delete `write_crash_log` (`:56-62` incl. doc), new `fn hook_closure`, `install_panic_hook` (`:67-80`), module doc (`:1-19`), both tests (`:117-210`)
- Modify: `src-tauri/src/lib.rs:316`
- Modify: `src-tauri/src/agent/worker/mod.rs:46`
- Test: `src-tauri/src/agent/crashlog.rs`, `mod tests`

**What to implement:**
- `fn write_crash(dir: &std::path::Path, tag: &str, payload: &str, location: &str) -> Option<std::path::PathBuf>` — the whole current body of `write_crash_log_from_info` (timestamp, `dir.join(format!("crash-{ts}-{tag}.log"))`, `force_capture`, the `format!` content, `create_dir_all(dir).ok()?`, `fs::write(&path, content).ok()?`, `Some(path)`). Private; doc comment states it is the testable core and **why** (`PanicHookInfo::new` is `pub(crate)`, the fields are private — `E0451` — so no test can build the hook's argument).
- `pub fn write_crash_log_from_info(dir, tag, info)` becomes a thin adapter: decode `info.payload_as_str().unwrap_or("<non-string payload>")` and `info.location()` → `file:line:col`, delegate to `write_crash`, return its `Option`. Public signature unchanged.
- `fn hook_closure(tag: String, dir: std::path::PathBuf) -> impl Fn(&std::panic::PanicHookInfo) + Send + Sync + 'static` — the closure body (`write_crash_log_from_info(&dir, &tag, info)`, result discarded). **No `Once` inside it.**
- `pub fn install_panic_hook(tag: &str, dir: std::path::PathBuf)` keeps the `Once` and **keeps owning the chain to the previous hook** (this std has no `default_hook`; the current code calls `previous(info)` at `:76`, and `hook_closure` is deliberately chaining-free, so `install_panic_hook` is the only place the chain can live). Spell it out rather than composing closures — `hook_closure` takes the hook by value, so a `take_hook()`-then-wrap composition hits `E0596`:

  ```rust
  let previous = std::panic::take_hook();
  let inner = hook_closure(tag.to_string(), dir);
  std::panic::set_hook(Box::new(move |info| {
      inner(info);        // the crash log first
      previous(info);     // then whatever was installed before
  }));
  ```

  Dropping `previous(info)` would silently stop panics reaching the default hook (no stderr panic output), and the Worker's stderr drain (`client.rs:328-330`) would forward nothing for panics — weakening the contract `tests/worker_stderr.rs:1-13` states. It no longer names `dirs`.
- Delete `write_crash_log` outright — it is the only `dirs::data_dir()` call in the panic path.
- Both production sites resolve their own dir and **skip the install when `None`**:
  ```rust
  // A `None` data dir is not a supported state — `setup()` hard-fails on it
  // (`lib.rs:416`), so skipping the hook here is belt-and-braces, not a mode.
  if let Some(base) = dirs::data_dir() {
      crashlog::install_panic_hook("supervisor", base.join("archimedes"));
  }
  ```
  In `lib.rs` keep it the first statement of `run()`, **before** `debuglog::init_from_env()`. In `worker/mod.rs` keep it the first statement of `run_worker_inner`.
- Module doc: the directory comes from the caller; add one line pointing at Task 2's guard ("invariant: `childproc`'s census forbids a data-dir resolver in this file's production region") so the rule is discoverable from here; and state the capture argument as "before any other thread runs app code", not "before any thread exists" (Evidence).
- **Also fix `write_crash_log_from_info`'s own doc line** (`:20-22`), which still reads "(a `None` base = no-op, never panics)" — a stale remnant of the old resolver-based signature that is wrong today and wronger after this task. Say what it actually is: an adapter that decodes the `PanicHookInfo` and delegates to `write_crash`.
- **What NOT to change:** the log's content format (payload + location + `force_capture` backtrace), the `HOOK` mutex (it still orders the two hook tests), `install_panic_hook`'s idempotency semantics, and `debuglog`.

**Steps:**
- [ ] Write the failing test `the_hook_writes_to_the_directory_it_was_given` in `mod tests`: take the `HOOK` mutex (it must still serialise against the hook tests); `std::panic::set_hook(Box::new(hook_closure("worker-capture".into(), temp_dir())))` — **the closure, never `install_panic_hook`**, so the `Once` stays untouched for the idempotency test; panic on a spawned thread with a `format!("injected-dir {}", uuid::Uuid::new_v4())` payload, reusing the existing `mpsc::channel` "signalled before panicking" idiom and the bounded 100×50 ms content-matching retry loop; assert the marker's file exists **in that temp dir**; restore the previous hook before asserting, exactly as the existing test does.
- [ ] Run `cargo test --lib agent::crashlog` — did it fail to **compile** with `hook_closure` undeclared (and `write_crash` undeclared)? If it passed, stop and investigate — you are not testing the injection. (The two `install_panic_hook` call sites still take one argument at this point; updating them is the next step, so their arity error is *not* part of this red.)
- [ ] Implement the seam, `hook_closure`, the signature change, delete `write_crash_log`, fix the two call sites.
- [ ] Rewrite `install_panic_hook_is_idempotent` to pass `temp_dir()`, and correct its doc comment: the mutex orders the two tests and the **injected dir** is what keeps the user's path unnamed in this binary — today's comment credits the mutex alone, which is no longer the whole story. Also record that it is the **only** test permitted to consume the `Once`, because a second consumer would silently no-op depending on test order.
- [ ] Run `cargo test --lib agent::crashlog` — green?
- [ ] Run `cargo test` — the whole lib + integration suites green?
- [ ] Run `cargo clippy --all-targets -- -D warnings` — 0 warnings (test code included)?
- [ ] Run `cargo fmt --all -- --check` — clean?
- [ ] Commit: `fix(crashlog): the panic hook is handed its directory — write_crash_log deleted`

**Acceptance criteria:**
- [ ] `grep -n "dirs::data_dir" src/agent/crashlog.rs` → no hits outside comments.
- [ ] `grep -rn "write_crash_log\b" src/ tests/` → **no hits** (only `write_crash_log_from_info`).
- [ ] Exactly one test in the crate calls `install_panic_hook`.
- [ ] `write_crash(dir, tag, payload, location)` is callable from a test with no `PanicHookInfo`, no hook and no mutex — this is the door Tasks 3 and 5 walk through.
- [ ] A test panic can no longer reach the real data dir, because the real path is never named in this binary.

---

### Task 2: the census invariant — `crashlog.rs` may not resolve a data dir

**Context:** Task 1 removes the resolver, but nothing stops a later edit from putting back the reasonable-looking `let dir = dirs::data_dir()`. This makes that red at test time, in the exact idiom `agent/childproc.rs` already ships. The guard must be **seen** red: a guard nobody has watched fail is a guess (`exec.rs:1780-1791`).

**Files:**
- Modify: `src-tauri/src/agent/childproc.rs` — a sibling `#[test]` in the existing census `mod tests`, calling the module-level helpers

**What to implement:**
- `#[test] fn production_crashlog_never_resolves_a_data_dir()`: `let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");` (the `:300` idiom) then `production_region(&src_root.join("agent/crashlog.rs"))` and assert no line `.text.contains("dirs::data_dir()")`. **Call `production_region` directly — do not re-walk the tree**, and do not try to reuse `regions`: that is a local `let` inside `production_source_has_exactly_one_child_constructor` (`:318-321`), not a helper, so it is not reachable from another test. One file is the whole scope of this invariant; a walk adds nothing but a second way to fail.
- **Scope: that file only.** A whole-tree rule would be red on arrival — `lib.rs`, `session/router.rs`, `mcp/oauth.rs` and `commands/mcp.rs` legitimately resolve directories outside a panic path.
- Vacuity guard in the census's own style — and note the existing one (`:350-359`) proves the scanner's *eyesight* by asserting it found known tokens, not by counting files. Do the same: assert the region contains the known production token `pub fn write_crash_log_from_info`, which proves both that you read the right file **and** that the region was not truncated to nothing. A bare "non-empty and smaller than the file" guard proves only truncation. (For scale, measured after Task 3: the region yields ~92 entries against ~231 non-comment non-blank lines file-wide — the two are computed differently, since the region KEEPS blank lines and the second count excludes them. Do **not** hard-code either number in the test: the guard asserts on a token, not a count.)
- Assertion message names the file, the offending `rel:line` pairs, and *why* it matters (a resolver in the panic path means the hook slot decides where the user's crash logs go).
- Doc comment must state: comments are filtered by `is_comment`, and `crashlog.rs` contains the string **three** times — twice in the module `//!` doc, which sits INSIDE the scanned region (so `is_comment` is what saves them), and once in a `///` comment inside `mod tests` (excluded by the region boundary) — so a naive "file contains" rule is a permanent false positive, and a naive "everything above `mod tests`" rule would scan the module-doc prose and trip on it too; the region stops at the first non-comment `#[cfg(test)]`; and `is_comment`'s documented `*` blind spot (documented on `is_comment` itself) is inherited by this invariant. ⚠ **Quote no line numbers into the comment, and no roadmap/task filenames either** — `crashlog.rs` shifts with every edit (Task 3 alone invalidated both cited numbers the moment it landed), and a drifted number misleads worse than none: write "locate them with `grep -n`" instead. Repo rule for comments: name the invariant, never a plan document.

**Steps:**
- [ ] Write the test and run `cargo test --lib agent::childproc` — **green immediately** (Task 1 already removed the resolver). That is expected here; the red is proven in the next step.
- [ ] **Prove it red cheaply and honestly:** temporarily add `let _ = dirs::data_dir();` as a real code line inside `write_crash`'s body (production region), re-run, and require a **failure naming `agent/crashlog.rs` and its line number**; also confirm it does **not** fire on the same string added inside a `//` comment or inside `mod tests`. Then remove the line and re-run green. Record both observations in the commit message. (Do **not** use `git worktree add` + `cargo test` for this: it triggers a cold 563–715-crate build and leaves `target/` behind, which then makes `git worktree remove` fail. The re-add above proves the same thing in seconds.)
- [ ] Break the vacuity guard too, once: point the region at a file with no `write_crash_log_from_info` and confirm the guard fails loudly. Revert.
- [ ] Run `cargo test --lib agent::childproc` — the pre-existing `production_source_has_exactly_one_child_constructor` and all siblings still green?
- [ ] Run `cargo clippy --all-targets -- -D warnings` (0) and `cargo fmt --all -- --check`.
- [ ] Commit: `test(crashlog): census invariant — the crash-log module may not resolve a data dir`

**Acceptance criteria:**
- [ ] The invariant fails when a `dirs::data_dir()` sits in `crashlog.rs`'s production region, and does not fire on the same string in a comment or in `mod tests`.
- [ ] Its vacuity guard fails loudly if the region is empty, truncated, or is the wrong file.
- [ ] Scope is one file; the pre-existing census invariants are unchanged and still green.
- [ ] The commit message records the observed red.

---

### Task 3: retention — 30 days and 50 files, pruned after the write

**Context:** nothing ever deleted a crash log; the directory reached 862 files / 11 MB. `debuglog` rotates at 5 MB (`MAX_LOG_BYTES`, `MAX_LINE_BYTES` at `debuglog.rs:21,24`), so a size discipline exists — but crash logs are one file per crash, not append-only, so the unit is *files*, paired with an age bound. Pruning runs inside a panic hook, so it must never panic and never lose the log it just wrote.

**Files:**
- Modify: `src-tauri/src/agent/crashlog.rs` — two `pub const`s, `fn prune_crash_logs(dir: &std::path::Path)`, one call site in `write_crash` between the successful `fs::write` (`:67`) and `Some(path)` (`:68`)

**What to implement:**
- `pub const MAX_CRASH_LOG_AGE_DAYS: u64 = 30;` and `pub const MAX_CRASH_LOG_FILES: usize = 50;` beside the writer, next to `debuglog`'s pair conceptually.
- `fn prune_crash_logs(dir: &std::path::Path)` — **private** (the tests drive it through `write_crash`): one `read_dir`; collect `(mtime, path)` for names matching `starts_with("crash-") && ends_with(".log")`; delete every entry whose age exceeds `MAX_CRASH_LOG_AGE_DAYS`; then while `remaining.len() > MAX_CRASH_LOG_FILES` (`usize` comparison) delete oldest-by-mtime first.
- **Every** fallible call `.ok()` / `if let Ok(_)`: `read_dir`, `metadata`, `modified`, `remove_file`. Age is computed as `now.duration_since(mtime)`: `Ok(age)` deletes when `age > MAX_CRASH_LOG_AGE_DAYS`; **`Err` (an mtime in the future) keeps the entry**, as does an unreadable mtime — clock skew must never delete history. A missing or unreadable dir returns early. `remove_file` errors are swallowed (read-only dir, a race with another process). The scratch implementation this section was validated against:

  ```rust
  fn prune_crash_logs(dir: &std::path::Path) {
      let Ok(entries) = std::fs::read_dir(dir) else { return };
      let now = std::time::SystemTime::now();
      let max_age = std::time::Duration::from_secs(MAX_CRASH_LOG_AGE_DAYS * 24 * 3600);
      let mut survivors: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
      for entry in entries.flatten() {
          let name = entry.file_name().to_string_lossy().to_string();
          if !(name.starts_with("crash-") && name.ends_with(".log")) { continue; }
          let path = entry.path();
          let Ok(mtime) = path.metadata().and_then(|m| m.modified()) else { continue };
          if matches!(now.duration_since(mtime), Ok(age) if age > max_age) {
              let _ = std::fs::remove_file(&path);
              continue;
          }
          survivors.push((mtime, path));
      }
      if survivors.len() > MAX_CRASH_LOG_FILES {
          survivors.sort_by_key(|(mtime, _)| *mtime);
          let excess = survivors.len() - MAX_CRASH_LOG_FILES;
          for (_, path) in survivors.into_iter().take(excess) {
              let _ = std::fs::remove_file(&path);
          }
      }
  }
  ```
- Called **only after** `fs::write` returned `Ok`, never before: on a full disk the crash log is worth more than the history.
- Doc comment: runs after the write; best-effort by construction; **the pattern is deliberately wider than the attribution matcher** (the `-<pid>` suffix would otherwise spare exactly the files worth deleting); mtime is the only clock — the same clock attribution trusts; and it must not match `supervisor.log*`.
- **What NOT to change:** the content format, `create_dir_all` semantics, `hook_closure`/`install_panic_hook`, `debuglog`'s rotation (different file, different policy).

**Steps:**
- [ ] Write the failing tests, each over its own `temp_dir()`, calling `write_crash(&dir, "worker", "marker", "file:1:1")` — **never the hook, never `write_crash_log_from_info`** (Evidence: `PanicHookInfo` is unconstructible):
  All seven recipes below were **executed** against a scratch implementation of exactly this shape (7 passed with correct ordering; 3 go red with the prune moved before the write). Use their fixture helper (its `secs_ago` **grows** with the index, so the highest index is the OLDEST file — the mistake that makes the cap assertion read backwards):
  ```rust
  const MINUTES: u64 = 60;
  const DAYS: u64 = 24 * 3600;
  fn aged(dir: &Path, name: &str, secs_ago: u64) -> PathBuf {
      let p = dir.join(name);
      std::fs::write(&p, "x").unwrap();
      let old = SystemTime::now() - Duration::from_secs(secs_ago);
      std::fs::OpenOptions::new().write(true).open(&p).unwrap().set_modified(old).unwrap();
      p
  }
  ```
  ⚠ The helper needs imports `crashlog.rs`'s `mod tests` does not currently have — add `use std::path::{Path, PathBuf};` and `use std::time::{Duration, SystemTime};` inside it (the module imports `Duration` alone, at `:136`). Then run `cargo fmt --all` once after pasting: neither this helper nor the `prune_crash_logs` listing above is rustfmt-clean as printed, so the task's `cargo fmt --check` step would redden on a verbatim paste.
  1. `prune_caps_at_the_file_limit` — seed `MAX_CRASH_LOG_FILES + 1` files via `aged(&dir, &format!("crash-cap-{n}.log"), (n + 2) * MINUTES)` so the mtimes are **60 seconds apart** (far above any filesystem's mtime granularity; a coarse-mtime filesystem otherwise makes "the oldest" undefined and the test flakes), write one crash, then assert: exactly `MAX_CRASH_LOG_FILES` remain; the just-written file is among them; `crash-cap-<last>.log` (the **largest** index = oldest) is gone; `crash-cap-0.log` survives.
  2. `prune_deletes_what_is_older_than_the_age_bound` — one file at **31 days**, one at **29 days**, plus 3 fresh; write one crash; assert the 31-day file is gone **and the 29-day file survives** (both sides of the boundary, or an off-by-a-day comparison passes undetected). ⚠ The surviving set is **5**, not 4: the 29-day file + 3 fresh + the crash log this test itself writes.
  3. `prune_spares_files_it_was_never_asked_about` — `supervisor.log`, `supervisor.log.old`, `notes.txt` and a file named `crash-notalog` (no extension) all survive.
  4. `a_failed_create_returns_none_and_touches_nothing` — point `write_crash` at `<uuid>/blocker/nested` where `blocker` is an existing **regular file** (`create_dir_all` fails `ENOTDIR`; the same on Windows); assert `None`, that the nested path was not created, and that the parent's two crash logs survive. Name it for what it proves — **this test cannot detect prune ordering** (the prune only ever touches `dir`, and `read_dir` on the non-existent target fails either way), and must not be described as if it can.
  5. `a_failing_write_prunes_nothing_even_though_it_could` — **the ordering pin, and ⚠ not with a read-only dir.** Seed `MAX_CRASH_LOG_FILES + 10` aged files in a plain **writable** dir (`temp_dir()` already is, on all three OSes — ⚠ do **not** call `set_permissions`/`Permissions::from_mode`: `PermissionsExt` is `#[cfg(unix)]`-only and unguarded use reddens the Windows `clippy --all-targets -D warnings` job), call `write_crash` with a `tag` of `"t".repeat(400)` so the composed name exceeds the filesystem name limit — `create_dir_all(dir)` succeeds (it creates only the directory) and `fs::write` fails (`ENAMETOOLONG` on Linux/macOS; on Windows `ERROR_INVALID_NAME`, and the path also exceeds `MAX_PATH`) — then assert the **outcome** only: `None`, and the directory contents unchanged — compare the full sorted name vector, not just the count (free, and it additionally catches a delete-one/create-one swap). Do not assert the errno; it is platform-specific. ⚠ The obvious design — `set_permissions(0o500)` so the write fails with `EACCES` — **does not work**: deleting a file needs write permission on the directory, so prune-before-write deletes nothing there either and the test passes with the bug present (verified: the 0o500 variant stayed green with prune moved before the write; this ENAMETOOLONG variant goes red).
  6. `prune_matches_the_pid_stamped_name` — `MAX_CRASH_LOG_FILES + 10` files named `crash-<n>-worker-<pid>.log` (hand-written names; Task 5 lands the real format), write one crash, assert the count drops to the cap. This catches a prune pattern too narrow for the new names.
  7. `a_future_mtime_is_never_deleted` — one file at 31 days plus one stamped `now + 1 day`; write one crash; assert the future-dated file survives and the 31-day one is deleted. This is the `now.duration_since(mtime)` Err arm (clock skew) — without it, "unmeasurable age ⇒ keep" is an untested claim.
- [ ] Run `cargo test --lib agent::crashlog` — it first fails to **compile** (the constants and `prune_crash_logs` do not exist). Then, with the constants in place and an **empty** `prune_crash_logs` body: tests 1, 2, 6, 7 fail on behaviour; **tests 3, 4, 5 pass by design** — they are sparing/ordering pins and there is nothing yet for them to catch (measured 4 fail / 3 pass). Do NOT bend 3/4/5 to make the red count seven; a red not attributable to the missing behaviour guards nothing.
- [ ] **Prove test 5 bites** before implementing for real: implement `write_crash` with the prune call placed **before** `fs::write`, run the suite, and require exactly three retention tests to fail — `a_failing_write_prunes_nothing_even_though_it_could`, `prune_caps_at_the_file_limit`, `prune_matches_the_pid_stamped_name`; then move the prune after the write and require all seven green. ⚠ "3 red / 7 green" counts **retention tests only** — the module reports 11 passed because Task 1's four ride along. Record both in the commit message.
- [ ] Implement the constants, `prune_crash_logs` and the single call site.
- [ ] Run `cargo test --lib agent::crashlog` — green?
- [ ] Run `cargo test` — green (no other test counts files in that dir)?
- [ ] Run `cargo clippy --all-targets -- -D warnings` and `cargo fmt --all -- --check`.
- [ ] Commit: `feat(crashlog): retain the newest 30 days / 50 crash logs`

**Acceptance criteria:**
- [ ] 51+ logs are capped to `MAX_CRASH_LOG_FILES`, oldest first; a 31-day-old log dies and a 29-day-old one lives.
- [ ] `supervisor.log*` and non-`crash-*` files are never touched; pid-stamped names **are** pruned.
- [ ] A failed write leaves the file count and the surviving entries unchanged (tests 4 and 5 — no test compares contents, so do not read this as byte-identity), and pruning provably runs only after a successful write (test 5).
- [ ] `prune_crash_logs` cannot panic on a missing/unreadable dir or an unreadable/future mtime. ⚠ Honest coverage split: only the **future-mtime** arm is tested (test 7). The `read_dir` and `metadata`/`modified` arms are unreachable from a test while the prune is private and its one call site runs only after a successful `create_dir_all` + `fs::write` — by then the dir exists. They guard against the dir vanishing *between* write and prune and are provable by inspection only; say so in the doc comment rather than implying coverage.
- [x] ⚠ **Post-review correction (Greptile `PRRT_kwDOUl7Qls6tq_rP`): the signature is `prune_crash_logs(dir, keep)`, not `(dir)`.** The prune runs *after* `fs::write`, so the new log is itself a candidate, and the cap pass deletes from the FRONT of an mtime-sorted list — where the new log sorts after a clock rollback, and where `read_dir`'s arbitrary order can put it when the retained logs share one mtime (a crash loop inside one mtime tick, a coarse filesystem). `write_crash` then returned `Some(path)` for a path it had just deleted — the banner links that path. `keep` is excluded from both passes and still counts toward the cap (`MAX - 1` older logs survive). The AGE pass still never deletes a future mtime; the CAP pass may still trim one when the directory is genuinely over the limit — this crash outranks the history.

---

### Task 4: `WorkerHandle` carries the child's pid

**Context:** attribution by identity needs the **Supervisor** to know which process just died, and at crash time `Child::id()` is already `None` (Evidence) — so the pid must be captured at spawn and carried. This task lands only the accessor and its field: no filename change, no attribution, nothing observable. Task 5 consumes it.

**Files:**
- Modify: `src-tauri/src/agent/worker/client.rs` — the struct (`:148-177`), the **manual** `impl Clone` (`:179-190`), `spawn()` (`:283-330`), a new accessor
- Test: `client.rs`'s `mod tests` (its tests already rely on `target/debug/fake_worker` — see the `:922-923` convention; `spawn_fixture()` at `:881` and `fixture_path()` at `:833` are `pub` but **inside that private `mod tests`**, so they are not reachable from other modules' tests)

**What to implement:**
- Field `pid: Option<u32>` with a doc comment naming the reason: `Child::id()` goes `None` once the child is reaped, which is the state a crash leaves, so the last known value is kept.
- In `spawn()`, capture `let pid = child.id();` after `cmd.spawn()` succeeds (`:310`) and **before** the stdio `take`s and the `Arc` wrap (`:324`), and store it in the returned struct.
- **Add `pid: self.pid,` to the hand-written `impl Clone` initializer at `:179-190`.** There is **no** `#[derive(Clone)]` on this struct — omitting the field is `error[E0063]: missing field 'pid' in initializer`. Extend the `Clone` doc comment (`:142-147`) with the copied pid.
- `pub fn pid(&self) -> Option<u32>` returning the field.
- **What NOT to change:** no filename change (Task 5 owns it — renaming here would silently break `router.rs:394`'s matcher for a whole commit), no IPC protocol change (the child's own `std::process::id()` equals the Supervisor's view of it, so no nonce travels), no `StalledInfo` change, no `handle.pid()` call site yet.

**Steps:**
- [ ] Write the failing test `the_handle_reports_the_child_pid_and_keeps_it_after_the_reap` as `#[tokio::test]`: `let handle = spawn_fixture().expect("the fixture binary exists (cargo test built it)")` (house style, `client.rs:923`; `spawn_fixture` is `pub` inside this file's private `mod tests` at `:791`, defined at `:881`); assert `handle.pid()` is `Some` and `!= std::process::id()` (it is a child, not us); then `handle.send_close().expect("close encodes")` (house style, `client.rs:929`) and `handle.exited().await`; then assert `pid()` is **still `Some`**.
  - ⚠ Reach the reaped state with **`send_close()` + `exited().await`**, not `kill()` + `exited().await`: tokio's `Child::kill()` DOES reap (`start_kill()` then `wait()`, `tokio-1.53.1/src/process/mod.rs:1325-1329`) but publishes exit code `None` for a signal death, and `exited()` blocks on `wait_for(|v| v.is_some())` (`client.rs:682`) — so that order **hangs forever**. `fake_worker` answers `Inbound::Close` with `std::process::exit(0)` (`src/bin/fake_worker.rs:917`), so the close path publishes `Some(0)` and `exited()` returns; and because the read task publishes only *after* `wait()` returns, `exited()` returning is the proof the child is reaped.
  - Why the reap matters: after it, `Child::id()` is `None` (tokio `FusedChild::Done`), so only a value captured at spawn can still answer `Some`. Without the reap, a naive `Child::id()`-backed accessor passes this test (Evidence).
- [ ] Run `cargo test --lib agent::worker` — fails to compile (`no method named 'pid'`)? That is the red. (⚠ This step comes BEFORE the mutation probe below: a probe that reimplements `pid()` cannot run before `pid()` exists — an earlier revision of this plan listed them inverted.)
- [ ] Implement the field, the capture, the `Clone` line and the accessor, and get the test green.
- [ ] **Prove the assertion is not vacuous:** temporarily reimplement `pid()` as a lock-based read (`self.child.try_lock().ok().and_then(|g| g.id())` **is** usable inside a `#[tokio::test]`; `self.child.blocking_lock()` is **not** — it calls `block_on` and panics with "Cannot block the current thread from within a runtime" (`tokio-1.53.1/src/sync/mutex.rs:520-522`). ⚠ A panic *looks* like the required failure but is not one: the mutant must fail on the **post-reap `Some` assertion**, not by panicking.), run the test, and require it to **fail the assertion** on the post-reap `Some` while still passing the pre-death assert. Then restore the field-backed accessor and require green. Record both observations in the commit message.
- [ ] Run `cargo test --lib agent::worker` — green?
- [ ] Run `cargo test` — green (the `Clone` change touches every handle clone path, including `tests/worker_e2e.rs` and `tests/worker_smoke.rs`)?
- [ ] Run `cargo clippy --all-targets -- -D warnings` and `cargo fmt --all -- --check`.
- [ ] Commit: `feat(worker): WorkerHandle carries the child's pid (captured at spawn)`

**Acceptance criteria:**
- [ ] `pid()` is `Some` for a live fixture child, differs from our own pid, and is **still `Some` after the reap** (`send_close()` + `exited().await`) — the state in which `Child::id()` is `None`, which is what makes the assertion non-vacuous.
- [ ] The hand-written `Clone` copies the field; every existing clone site still compiles.
- [ ] No filename, protocol or `StalledInfo` change; no behaviour change of any kind observable from outside.

---

### Task 5: the pid-stamped name, and a matcher that accepts both shapes

**Context:** two **Worker** processes crashing in the same millisecond collide on `crash-<ts>-worker.log`, and a name with no owner is why attribution can only guess. The pid makes the name unique per process.

This task lands the rename **together with** a matcher that accepts both the old and new shapes, because `router.rs:394`'s `ends_with("-worker.log")` stops matching the moment the suffix appears: (line numbers as of `main`/`7914bb2`). A rename without a matching predicate silently drops the banner's crash-log link for a whole commit, and **no test catches it** (`tests/ipc.rs:495-509` asserts only `at`). There is a SECOND instance of the same trap inside `crashlog.rs:147` (the hook test's candidate filter), which the rename also reddens — both are in this task's file list. One commit, no regressed interval. Actual selection by pid is Task 6.

**Files:**
- Modify: `src-tauri/src/agent/crashlog.rs` — the name in `write_crash` (`:72`), module doc, the name filter inside the existing hook test, **and the two assertions that hard-code the old exact name** (`the tag given to hook_closure…` and `write_crash_writes_without_a_panic_hook_info`). ⚠ Four places in this file read the name, not two: grep `worker.log` / `-worker-` before you start.
- Modify: `src-tauri/src/agent/session/router.rs` — extract `fn is_worker_crash_log_name(name: &str) -> bool` (both shapes), used by `find_newest_crash_log` (`:394`)
- Modify: `src-tauri/src/agent/session/mod.rs` — the `StalledInfo.crash_log` doc (`:241-244`)
- Test: `crashlog.rs`'s `mod tests`, plus a direct unit test of `is_worker_crash_log_name` in `router.rs`'s tests

**What to implement:**
- `let path = dir.join(format!("crash-{ts}-{tag}-{}.log", std::process::id()));`
- ⚠ **`crashlog.rs:286` is a second name matcher, and the rename reddens it.** The existing hook test filters candidates with `name.starts_with("crash-") && name.ends_with("worker.log")` — and `crash-1-worker-4242.log` does **not** end with `worker.log` (measured `false`), so `cargo test --lib agent::crashlog` goes red inside this task on an unlisted line. Relax it to `name.starts_with("crash-")`: the file is already identified by its **content** marker a few lines below (`:150`, `c.contains(&marker)`), never by its name — which is exactly what the NOTE at `:112-116` says. This is the trap the Evidence warns about for `router.rs:394`; its sibling lived two lines above the test Task 1 rewrote.
- **Extract the router predicate as a function** — `fn is_worker_crash_log_name(name: &str) -> bool` — rather than editing the inline condition. It is the only way the rule is testable: `find_newest_crash_log` takes no arguments and resolves `dirs::data_dir()` itself (`:438`), so a temp-dir test of it is impossible until Task 6's injection exists. The predicate: `name.starts_with("crash-")` **and** (ends with `-worker.log` **or** ends with `-worker-<digits>.log`). Keep the `starts_with("crash-")` half (today's `:394` has both). Keep the check **suffix-anchored**: strip the two fixed ends (`.log`, then the last `-`) and require the remainder to be a non-empty ASCII-digit run, with the head still ending `-worker`. ⚠ My earlier wording here said "pure suffix check, never a split-on-`-` parser" while also requiring `crash-1-worker-.log` and `crash-1-worker-abc.log` to be **rejected** — those two negatives cannot be decided by `ends_with` at all, so the contradiction resolves in favour of the peel. What the prohibition really means: anchor at the end, do not split the whole name into fields (that is what drifts from the writer's format). Say the safe-suffix reasoning in the comment (`worker-` pins where the digit run starts, `.` ends it; brute-forced over pid/other pairs in 1..3000 — zero false positives). Task 6 reuses this function for its pid-less fallback arm.
- Update `crashlog.rs`'s module doc and `StalledInfo.crash_log`'s doc to `crash-<ts>-<tag>-<pid>.log`, mentioning that a pre-amendment pid-less log is still matched until Task 6 replaces the selection rule.
- **What NOT to change:** `find_newest_crash_log`'s *selection rule* (still newest-by-mtime — Task 6 replaces it; only its predicate is extracted here), `on_crash`, `StalledInfo`'s fields/serde naming, any `.tsx`, and `src/lib/tauri.ts:219`'s comment — **that one goes stale in Task 6**, where the frontend touch is allowed, not here.

**Steps:**
- [ ] Write the failing tests. (a) `the_crash_log_name_carries_the_writing_pid` — `write_crash(&dir, "worker", "marker", "f:1:1")`, take the returned path, assert the file name `ends_with(&format!("-{}.log", std::process::id()))`, `starts_with("crash-")` and contains `-worker-`. Exact suffix, not a regex. (b) `is_worker_crash_log_name_accepts_both_shapes` — accepts `crash-1-worker.log`, `crash-1-worker-4242.log`; rejects `crash-1-supervisor.log`, `crash-1-worker-.log`, `crash-1-worker-abc.log`, `crash-1-worker-4242.txt`, `notes-worker-1.log`. Pure string test, no filesystem.
- [ ] Run `cargo test --lib agent::crashlog` and `cargo test --lib agent::session` — (a) fails (no pid yet); (b) fails to compile (`is_worker_crash_log_name` absent). Both red for the right reason?
- [ ] Implement the name, the extracted predicate, the `:286` relaxation and the doc updates.
- [ ] Run both — green? **If the pre-existing hook test goes red at `:286`, that is the trap above — relax the filter by name and rely on the content marker at `:289`.**
- [ ] Run `cargo test` — green, **including** `tests/ipc.rs` (its crash case asserts `at` only, and points `app_data_dir` at a temp dir, so it stays green here)?
- [ ] Run `cargo clippy --all-targets -- -D warnings` and `cargo fmt --all -- --check`.
- [ ] Commit: `feat(crashlog): stamp the crash log with the writing process's pid`

**Acceptance criteria:**
- [ ] A crash log written by this process is `crash-<ts>-<tag>-<own pid>.log`; both tags still appear.
- [ ] `is_worker_crash_log_name` accepts **both** name shapes and rejects every listed negative, tested directly as a pure function — no commit in this branch has a Stalled banner with a dead link.
- [ ] The pre-existing hook test still passes, its candidate filter relaxed to `crash-` with identification left to the content marker.
- [ ] No selection-rule change yet; no `on_crash` change; no `.tsx` change.

---

### Task 6: attribution by pid, and one frozen path per crash

**Context:** `find_newest_crash_log` picks the newest `crash-*-worker.log` by mtime, so with N concurrent **Subagent** **Workers** the banner can name a *different* Worker's crash; and its second call site (`:202`) re-globs, so the pushed `session-stalled` event and the pulled `stalled_info` can name different files for one crash. With the pid in the name and on the handle (Tasks 4-5), the **Supervisor** selects by identity — it knows the pid of the child it just reaped.

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs` — **new `type OnCrash`** (clippy, see below), field `:445`, ctor param `:498`, fire site `:968`, pid captured before `tokio::spawn` (near `start_pump`, `:818`/`:549-555`/`:1318-1324`), module doc `:18-21`
- Modify — the **two crash collectors' element types**: `manager.rs:1876` `type CrashLog = Arc<StdMutex<Vec<(String, Option<i32>)>>>` → 3-tuple; `:1982` `.push((id, code))`; assertion closures destructuring `(id, code)` at `:2412`, `:2425`, `:2438`; `tests/worker_e2e.rs:135` `crashes: mpsc::UnboundedReceiver<(String, Option<i32>)>`, `:158` `crash_tx.send((sid, code))`, `:943` `let (sid, code) = …recv()`
- Modify: `src-tauri/src/agent/session/router.rs` — `find_newest_crash_log` (fn at `:437`, the `dirs::data_dir()` at `:438`) → `find_crash_log_for_pid(&Path, Option<u32>)`, `handle_crash` (`:167`, first glob `:169`), the second glob in the emit at `:202` (line numbers below are Task-5-post `router.rs`: `handle_crash` `:167`, glob `:169`, emit `:202`, `stalled_info` `:211`), and **remove `dirs` from this file**
- Modify: `src-tauri/src/agent/session/mod.rs` — new `crash_log_dir: Arc<OnceLock<PathBuf>>` beside the late-wire `OnceLock`s (`worker_manager` `:454`, `subagent_manager` `:459`, `sink` `:462`, initialised in the ctor near `:513-521`) + `pub fn set_crash_log_dir(&self, dir: PathBuf)` (⚠ NOT shaped like `set_sink` `:566` / `set_catalog` `:579` — see the setter-shape bullet); the `on_crash` closure at `:2092`
- Modify: `src/lib.rs` — the `on_crash` closure at `:118`; call `set_crash_log_dir(app_data_dir.clone())` inside `setup_dirs_with_factory` **after** `let manager = Arc::new(manager);` (`:110`) — `app_data_dir` is a fn parameter (in scope from `:64`) and the `&self` setter shape is what makes the call legal on the `Arc`
- Modify — the remaining 11 `on_crash` fixture callbacks: `src/agent/subagent.rs:448`, `:801`, `:818`, `:854`; `src/agent/harness/loop.rs:6623`; `src/agent/harness/dispatch.rs:438`; `src/agent/worker/manager.rs:1978`, `:2093`; `tests/session_native.rs:125`; `tests/harness_dispatch_native.rs:81`; `tests/harness_subagent_dispatch.rs:89`
- Modify — `handle_crash` callers: `src/agent/session/naming.rs:2095` and `:2120`, both become `h.manager.handle_crash(id, Some(1), None)` (they are **currently** 2-arg — write the 3-arg target, don't copy the current text)
- Modify: `src-tauri/src/lib.rs` — besides the `on_crash` closure, the comment at `:319` (drifted from `:311`) still says a `crash-<ts>-supervisor.log` "now exists"; the name carries a pid since Task 5
- Modify: `src/lib/tauri.ts` — the `crashLog` doc comment only (comment `:218`, field `:219`): "the newest `crash-<ts>-worker*.log`" → the pid-attributed path. No behaviour change, no `.tsx`.

**What to implement:**
- **`type OnCrash = Arc<dyn Fn(String, Option<i32>, Option<u32>) + Send + Sync>;`** placed beside `SinkLookup` (`:481`), doc-commented as existing for `clippy::type_complexity` exactly as `SinkLookup`'s does (its doc is at `:477-480`; `:471-474` is `CwdRegistrar`'s). Use the alias at `:445` and `:498`. **Do not `#[allow]` the lint** — it is a build failure under `-D warnings`, and the alias is this file's established remedy.
- At the fire site: `let pid = handle.pid();` **before** the `tokio::spawn` (the pump currently does not move `handle` into the future — capture only the pid so you don't extend the future's captures), then `(state.on_crash)(session_id.clone(), code, pid);` inside `if crashed` at `:968`.
- `pub fn handle_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>)`: compute `let crash_log = self.crash_log_dir.get().and_then(|d| find_crash_log_for_pid(d, pid));` **once**, insert it into the `stalled` registry, and **reuse that value** in the `session-stalled` emit — delete the second glob at `:202`.
- **The injectable dir is a `SessionManager` `OnceLock`, not a mutable global and not a test-only variant.** `crash_log_dir: Arc<OnceLock<PathBuf>>` + `set_crash_log_dir`, matching the file's existing late-wire fields (`sink`, `persister`). ⚠ **Copy the `&self` setter shape from `attach_app_handle` (`session/mod.rs:526`) / `attach_worker_manager` (`:543`)** — `pub fn x(&self, v: T) { let _ = self.field.set(v); }` — **not** from `set_sink` (`:566`)/`set_catalog` (`:579`), which are `&mut self` and cannot be called on an `Arc<SessionManager>`; the `OnceLock` fields themselves are the right model, the `&mut self` setters are not. `setup_dirs_with_factory` wires `app_data_dir`, which production already computes as `dirs::data_dir().join("archimedes")` (`lib.rs:416`) — **byte-identical** to `router.rs:438`, so production behaviour is unchanged and `dirs` disappears from `router.rs` entirely. `handle_crash` stays 3-arg. (A mutable global was rejected in ADR 0025 and collides with the no-env-mutation rule and the parallel harness; a `#[doc(hidden)]` variant is not executable verbatim.)
- `fn find_crash_log_for_pid(dir: &std::path::Path, pid: Option<u32>) -> Option<PathBuf>`: with `Some(pid)`, an entry whose name starts with `crash-` and ends with `worker-{pid}.log`; with `None`, the newest entry satisfying `is_worker_crash_log_name` **and** carrying no `-{digits}.log` pid suffix. ⚠ That suffix clause is **load-bearing, not defensive**: `is_worker_crash_log_name` deliberately accepts *both* name shapes (Task 5 needs that to keep old logs visible), so `crash-1-worker-4242.log` satisfies the predicate and this clause is the only thing keeping a pid-stamped log out of a pid-less answer. Symmetrically the predicate is load-bearing in the `Some(pid)` arm too — the pid tail alone would let `notes-worker-1.log` answer a query for pid 1. Both arms need both halves, and each half needs its own test. Return `None` when nothing matches — **never** "some log is better than none".
- **Behaviour change to state in the commit body:** `Some(pid)` with no matching file now yields `None` where the old code returned an unrelated log. `StalledInfo.crash_log` is `Option` and the banner already renders `None`, so the result is a banner with no link rather than a **wrong** link. Also expect `tests/ipc.rs`'s crash case to see `crashLog: null` (its `TestDirs` at `:98-122` points `app_data_dir` at an empty temp dir) — that is correct, not a regression.
- Widen both crash collectors to `(String, Option<i32>, Option<u32>)` and use the `manager.rs` one to add the assertion the plan previously had nowhere to live: the `on_crash` pid equals the spawned handle's pid.

**Steps:**
- [ ] Write the failing attribution tests (temp dirs, `find_crash_log_for_pid` takes the dir directly):
  1. `the_pid_named_log_wins_over_a_newer_foreign_one` — `crash-1000-worker-4242.log` plus a **newer** `crash-2000-worker-9999.log`; `Some(4242)` → the 4242 path. Red today (recency wins).
  2. `a_pid_less_log_is_still_found_when_the_pid_is_unknown` — only `crash-1000-worker.log`; `None` → it. ⚠ **Green on arrival** (a sparing pin — nothing existed yet to catch it), like Task 3's tests 3/4/5; do not bend it to manufacture a red.
  2b. `a_pid_less_query_never_names_a_pid_stamped_log` — seed `crash-1-worker-4242.log` only, ask with `None`, expect `None`. Deleting the `has_pid_suffix` clause turns this red, which is what proves the clause is behaviour and not decoration.
  3. `an_unmatched_pid_returns_no_log_rather_than_guessing` — only `crash-2000-worker-9999.log`; `Some(1)` → `None`.
  4. Router, `#[tokio::test]` in `session/mod.rs`'s test module. Use the module's own `FixtureFactory` (`:2054`)/`fixture_path()` (`:2064`) — `client.rs`'s `spawn_fixture` is private to its own `mod tests` and unreachable here to get a real child pid; `send_close()` + `exited().await` to let it go (tokio's `kill_on_drop` defaults to **false** and `build_command` never sets it, so the child is NOT Drop-killed — close it explicitly or it lingers until its stdin EOF, and the `worker_smoke` EOF/exit pins are sensitive to a stray child). Call `set_crash_log_dir(temp_config_dir())` on the manager built by `build_worker_manager` (`:2076`) — `temp_config_dir()` (`:1891`) is the module's existing temp-dir helper; there is no `temp_dir` here; seed the temp dir with one log named for that pid **plus a newer unrelated `crash-7-worker.log`**; then `manager.handle_crash(id, Some(1), Some(pid))` and assert `stalled_info(id).unwrap().crash_log` **equals** the `crashLog` captured in the `session-stalled` payload from the test sink (`TestSink` at `:1879`; `stalled_info` is at `router.rs:211` — there is **no** forwarding wrapper: `router.rs` is a child module whose `impl SessionManager` block *is* the type, so `manager.stalled_info(id)` is the direct call (`commands/sessions.rs:194` does the same)). Two assertions, and ⚠ only the first is a today-red: **(a) identity** — `crash_log` equals the pid-named file (red today: recency picks the seeded newer file). **(b) frozen equality** — the registry's `crash_log` equals the `crashLog` in the emitted `session-stalled` payload; this **cannot** go red before pid selection exists (both call sites today resolve the same newest file within one synchronous call over an unchanging dir), so it is the pin that stops the `:202` glob being re-added (a re-added glob would return the seeded NEWER file and break it). Name the test for both halves so nobody hunts a today-red in the wrong assertion. `handle_crash` has **no** early return — it always marks stalled and emits; its `live`-map helpers (`cleanup_pending_modals`, `resolve_turn_forced` — re-grep in `router.rs`) no-op for an unknown id, so no Worker needs to be running.
  5. `manager.rs`: the widened `CrashLog` records the pid — assert the collected pid equals the handle's.
- [ ] Run `cargo test --lib agent::session` / `--lib agent::worker` — red for the stated reasons (a compile error across the 14 callbacks is expected too, but each behavioural test must be attributable to missing behaviour, not to fallout)?
- [ ] Implement the alias, the widening (14 callbacks + 2 `handle_crash` callers + both collectors), the `crash_log_dir` seam and wiring, the selector, the single frozen path.
- [ ] Run `cargo test` — green across the integration suites (`worker_e2e.rs`, `worker_smoke.rs`, `session_native.rs`, `harness_dispatch_native.rs`, `harness_subagent_dispatch.rs`, `ipc.rs`)?
- [ ] Run `cargo clippy --all-targets -- -D warnings` (0 — this is the step the alias exists for) and `cargo fmt --all -- --check`.
- [ ] **End-to-end pid plumbing — extend the existing real-crash test.** ⚠ This replaces the GUI check below, which the orchestrator runs separately and which no agent can automate. `tests/worker_e2e.rs`'s `crash_path_on_crash_fires_and_rows_stay_intact` (`:857`) already SIGKILLs a real Worker and receives on the widened crash channel (`:943`). Read `handle.pid()` off the live handle **before** `kill()`, then assert the received triple: the session id, a non-zero code, and **`pid == Some(spawned_pid)`** — real spawn → real death → the Supervisor's `on_crash` carrying the pid of the process that actually died. Stronger than a unit test and needs no GUI. It does not claim a crash log exists (a SIGKILL never fires the hook), so it proves the attribution **key**; the seeded-file selection stays the unit tests' job.
- [ ] *(Optional — orchestrator runs this by hand, not the implementer.)* **Manual check — what a real crash looks like.** `make dev` (`pnpm tauri dev`, Makefile:196) — a bare `cargo run` will not render, because `tauri.conf.json`'s `build.devUrl` is `http://localhost:1420`. Start a session, note the Worker's pid (`ps` for `archimedes --worker`), and **seed a crash log for that pid** (`touch "<data dir>/crash-<now_ms>-worker-<pid>.log"`) before `kill -9`ing the Worker.
  - ⚠ **A SIGKILL writes no crash log** — the repo already says so at `tests/worker_e2e.rs:851-855`: "a SIGKILL never fires the panic hook (the process is killed, not panicked), so no `crash-*.log` is written on THIS path"; `src/bin/fake_worker.rs:584` likewise exits rather than panics. So do **not** expect a log to appear; an unseeded dir correctly yields `crashLog: null`. This check exercises the **pid plumbing** (the banner selects the log seeded for the pid that just died), which is exactly what the Rust unit tests cannot see end-to-end. The log's content/format is covered by the `crashlog` unit tests.
  - Require: the banner names exactly the seeded path and the `session-stalled` payload's `crashLog` equals it; and with the seed file **renamed to a foreign pid**, the banner shows **no** link (not the wrong one). Record both observations in the commit message.
- [ ] Commit: `fix(session): attribute the crash log by pid, and emit the path the registry froze`

**Acceptance criteria:**
- [ ] A pid-matching log wins over a newer foreign one; a pid-less pre-amendment log is still found when the pid is unknown; an unmatched pid yields `None`.
- [ ] The `session-stalled` payload's `crashLog` and `stalled_info`'s `crash_log` are always the same path.
- [ ] `router.rs` contains no `dirs::` call; production wiring is identical in effect to the old `dirs::data_dir()?.join("archimedes")`.
- [ ] `cargo clippy --all-targets -- -D warnings` is clean **without** an `#[allow]` on `type_complexity`.
- [ ] No frontend behaviour change (one comment line in `src/lib/tauri.ts` corrected).
- [ ] The manual seeded-pid check ran and both observations are in the commit message.

---

### Task 7: the CI leak guard — run the suite against a redirected data dir and require it to stay empty

**Context:** Task 2's census is a source-level claim about one file — it cannot see a `dirs::data_dir()` reached from elsewhere, and it cannot see what the suite actually *does*. This guard runs the real suite with its data dir pointed at a throwaway path and requires zero `crash-*.log` there. **The redirect is load-bearing:** a runner's real data dir was never written to, so an unredirected check passes for the wrong reason — the trap recorded at `agent/tools/exec.rs:1780-1791`.

⚠ **Linux + macOS only.** `dirs` 6.0.0 resolves the Windows data dir with `SHGetKnownFolderPath` (`dirs-sys-0.5.0/src/lib.rs:150-178`; `dirs-6.0.0/src/win.rs:10`), which **ignores `%APPDATA%`** — so a Windows `APPDATA` redirect would change nothing and the check would pass for exactly the wrong reason. Windows keeps Task 2's census as its only guard. That is a recorded gap, not an oversight, and Task 8 writes it into the ADR.

**Files:**
- Create: `scripts/check-test-data-dir.sh`, `scripts/check-test-data-dir.test.sh` (`chmod +x`, mode 755, matching the other `scripts/*.sh`)
- Modify: `.github/workflows/ci.yml` — env on the `cargo test` step (`:129-131`), a new step in the `scripts` job (`:145-169`)
- Modify: `src-tauri/src/test_support.rs` — the redirect-verification test

**What to implement:**
- `scripts/check-test-data-dir.sh <dir>`: `set -euo pipefail`; **recursively** find `crash-*.log` under `<dir>` (recursive is mandatory: macOS nests `archimedes` under `<HOME>/Library/Application Support`, so a non-recursive check there is **vacuously green**); print each hit; exit 1 if any, else 0; exit 0 if `<dir>` does not exist (nothing ran). Matches only `crash-*.log` — `supervisor.log*` lives in the same dir and is legitimately written. Header explains **why the caller must redirect**, citing `exec.rs:1780-1792` (the passage ends one line later than earlier drafts said).
- `the_ci_data_dir_redirect_took_effect` in `test_support.rs`: read `ARCHIMEDES_TEST_DATA_DIR`; **unset → return immediately** (local runs unaffected — say so in the comment so nobody reads the inert arm as dead code). **Set →** `dirs::data_dir()` must be `Some` and `.starts_with(Path::new(&var))` — **`Path::starts_with`, not string prefix**, so `/tmp/adh` cannot spuriously prefix `/tmp/adhome`. A prefix (not equality) because on Linux the two are equal while on macOS `data_dir()` is `<HOME>/Library/Application Support`. Say which assertion holds per platform.
- CI: ⚠ **the suite runs in THREE mutually-exclusive, exhaustive `cargo test` steps** — `if: runner.os == 'linux'` (sets `XDG_DATA_HOME`), `== 'macos'` (sets `HOME`), `== 'windows'` (sets nothing). Two gated steps would **silently drop Windows from the Rust bar entirely** — it would match neither gate and run no suite, and nothing downstream would notice. The third step exists to keep Windows compiling and testing, unredirected. (gates are lowercase throughout, matching `ci.yml:105`; GitHub's string `==` is case-insensitive, so a second spelling would be a false distinction). A **new** step `Check the test suite wrote no crash log` runs `bash scripts/check-test-data-dir.sh "$ARCHIMEDES_TEST_DATA_DIR"` re-exporting the same value on **that step** (env does not leak between steps), gated `if: runner.os != 'Windows'`. Add a comment naming `dirs-sys-0.5.0/src/lib.rs:150-178` so nobody adds a fake `APPDATA` line for Windows. The `scripts` job gains `bash scripts/check-test-data-dir.test.sh` beside `check-versions.test.sh`.
- **Scope this test honestly:** it catches Linux/macOS redirect drift and a future `dirs` change. It does **not** cover Windows (the step is gated off and the var unset there), so Windows has **no** behavioural guard — census only. Task 8 records that.
- State the two residual holes in `ci.yml`'s comment rather than implying total coverage: (a) the path literal is repeated on each step because step `env` cannot be shared, so renaming it on ONE step leaves the check scanning a different dir from the one the suite wrote to — and a non-existent dir exits 0, so that is **green on the wrong directory**; `the_ci_data_dir_redirect_took_effect` covers the opposite direction (var set but `dirs` ignoring it), not this one. (b) On Linux the redirected dir ends up with **zero files** — this suite writes nothing to the data dir there — so the Linux green rests on the premise test, not on an observably-live directory.
- **What NOT to change:** the `cargo fmt`/`cargo clippy` steps (no redirect needed), `pnpm test`/`pnpm build`, `release.yml`, and no `set_var` in any Rust test. Do not move the redirect to JOB env either — a job-wide `HOME` moves pnpm's cache.

**Steps:**
- [ ] Write the failing harness `scripts/check-test-data-dir.test.sh` in the exact house style of `scripts/check-versions.test.sh` (`set -euo pipefail`; a `FATAL: … does not exist — implement it before running these tests` early exit; one `mktemp -d` root with `trap 'rm -rf "$tmp_root"' EXIT` — and keep it a plain variable, since `roots+=("$(mktemp -d)")` records into the subshell and the trap would clean nothing; a `failures` counter; the `run_check` + `|| status=$?` idiom for exit-code assertions; a final `all checks passed`). ⚠ Add `assert_nonzero` — the house helpers are `assert_eq`/`assert_contains` and "non-zero" has no fixed value. Cases: (1) dir with `crash-123-worker-9.log` → **non-zero** + the path printed; (2) dir with only `supervisor.log` + `archimedes.db` → 0; (3) nonexistent dir → 0; (4) **nested** `archimedes/crash-1-worker-2.log` → non-zero (the macOS shape); (5) `crash-notes.txt` → 0; (6) an **existing but empty** dir → 0 (Linux's actual green shape); (7) no argument at all → usage error, non-zero; (8) an **empty-string** argument → non-zero. ⚠ Case 8 is anti-vacuity, not tidiness: the CI call site is `"$ARCHIMEDES_TEST_DATA_DIR"`, so a lost `env:` arrives as one empty string — and a non-existent dir exits 0 by design, so without this case a deleted `env:` would scan nothing and PASS.
- [ ] Run `bash scripts/check-test-data-dir.test.sh` — the `FATAL:` red?
- [ ] Implement `check-test-data-dir.sh` and the `test_support` verification test; wire `ci.yml`.
- [ ] Run `bash scripts/check-test-data-dir.test.sh` — all cases pass? `bash -n` both clean?
- [ ] **Prove the guard red — by SEEDING, not by panicking.** ⚠ Do not try to make the suite produce a crash log: after Task 1 that is impossible by construction (Task 1's own acceptance criterion is "a test panic can no longer reach the real data dir"), so "run the suite and require a crash log to appear" is an **unsatisfiable** step, and the way an agent "fixes" that stall is to re-introduce the leak. Seed instead: `mkdir -p /tmp/guardred/archimedes && : > /tmp/guardred/archimedes/crash-1791000000000-worker-1.log`, run `bash scripts/check-test-data-dir.sh /tmp/guardred`, require **exit 1 with that path printed**; then delete the file and require **exit 0**. Record both observations in the commit message. (The nested `archimedes/` level is deliberate — it is the macOS shape and it proves the recursion.)
- [ ] **Prove the redirect-verification test bites:** run `XDG_DATA_HOME=/tmp/guardred ARCHIMEDES_TEST_DATA_DIR=/tmp/guardred cargo test --lib test_support::` — ⚠ **both** vars (with only `ARCHIMEDES_TEST_DATA_DIR` set, Linux `data_dir()` falls back to `$HOME/.local/share` per `dirs-6.0.0/src/lin.rs:11`, and the test fails for the wrong reason); and ⚠ the filter must name the module the test lives in — `test_support::tests::the_ci_data_dir_redirect_took_effect`. `agent::` matches nothing there, so the step would "pass" having observed no test at all: the exact vacuity this task exists to prevent. Then point `ARCHIMEDES_TEST_DATA_DIR` at a path that is **not** a prefix of `data_dir()` and require the test to fail. For the `Path::starts_with` vs string-prefix distinction: the false-pass direction needs `data_dir()` to be the LONGER path — `data_dir()=/tmp/adhome/…` against `var=/tmp/adh`, where a string `starts_with` says true and `Path::starts_with` says false (this is exactly the macOS nesting shape). Run **both** orderings; on Linux the paths are equal, so Linux cannot discriminate and the point is only demonstrable in the nested direction.
- [ ] `rm -rf /tmp/guardred /tmp/guardgreen` when done — **and note for local runs:** a redirected `HOME` makes rustup auto-install the pinned toolchain into the fake home (measured: **1.5 GB, 12.8 s**, when `RUSTUP_HOME` is unset). In CI this is instant (`RUSTUP_HOME`/`CARGO_HOME` are runner env vars). Prefer `XDG_DATA_HOME` locally, or set `RUSTUP_HOME`.
- [ ] **Then run the FULL suite under the redirect** — `XDG_DATA_HOME=/tmp/guardgreen ARCHIMEDES_TEST_DATA_DIR=/tmp/guardgreen cargo test` (both vars, no `--lib`), and require green **plus** `bash scripts/check-test-data-dir.sh /tmp/guardgreen` → exit 0. ⚠ The Evidence measurement was `--lib` only; the integration binaries spawn the real binary (`worker_smoke.rs:15`, `worker_stdin.rs:55`, `worker_e2e.rs:46`), and that combination is otherwise first exercised on CI's macOS arm, which is unmeasured. A macOS-arm red on the first CI run is expected-to-be-investigated, not a mystery.
- [ ] Run `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --all -- --check` — the verification test is Rust, so it is linted and formatted like the rest.
- [ ] Commit: `ci(crashlog): assert the test suite leaves its own data dir crash-log-free`

**Acceptance criteria:**
- [ ] The harness passes and includes the nested-`archimedes/` case (the macOS shape).
- [ ] The guard has been **observed red against a seeded crash log** and green on the real suite, both recorded in the commit message.
- [ ] The redirect-verification test is live on Linux and macOS and has been seen to fail when the prefix does not hold.
- [ ] The full suite has been run under the redirect locally before pushing.
- [ ] Windows runs no redirect-dependent step, and `ci.yml` says why in a comment.
- [ ] No Rust test mutates an environment variable.



---

### Task 8: docs — the ADR 0025 amendment and the glossary entry

**Context:** the durable decisions are drafted in `docs/decisions/0025-sessions-in-worker-processes.md` as `## Amendment (2026-10-18)` (committed in `f69ba33`), with the resolved term **Crash log** in `CONTEXT.md`. ADR 0025 originally said the hooks write `~/.local/share/archimedes/crash-<ts>-*.log` — now wrong twice over (the directory is injected, the name carries a pid), and its amendment's guard paragraph currently overclaims (see step 2). A reader of the ADR alone must not be misled.

**Files:**
- Modify: `docs/decisions/0025-sessions-in-worker-processes.md` — the amendment, plus **the correction at `:59`**
- Modify: `CONTEXT.md` — the **Crash log** entry
- Delete: `docs/roadmap/crash-log-hardening.md` — on ship, per AGENTS.md

**What to implement:**
- Reconcile every symbol and number in the amendment with the merged code: `install_panic_hook(tag, dir)`, `write_crash`/`write_crash_log_from_info` as the sole writers, `hook_closure`, `find_crash_log_for_pid`, `MAX_CRASH_LOG_AGE_DAYS`/`MAX_CRASH_LOG_FILES`, `type OnCrash`, `WorkerHandle::pid()`, `crash-<ts>-<tag>-<pid>.log`, `set_crash_log_dir`. Symbols and numbers only — the reasoning is settled.
- **Correct `:59`**, which currently claims the behavioural guard runs "in CI on **all three OSes** against a redirected data dir (`XDG_DATA_HOME` / `APPDATA` / `HOME`)". Task 7 excludes Windows and explicitly refuses `APPDATA`. Rewrite it to: Linux + macOS only, and **why** — `dirs-sys-0.5.0/src/lib.rs:150-178` resolves the Windows data dir via `SHGetKnownFolderPath`, which ignores `%APPDATA%`, so a Windows redirect would make the check pass for the wrong reason; Windows is guarded by the census invariant alone.
- Keep this repo's ADR format: `## Amendment (YYYY-MM-DD)` section, a pointer from the summary paragraph, an explicit "This ADR is NOT superseded".
- `CONTEXT.md`: confirm the **Crash log** entry's name shape and retention numbers match the code, and that its `_Avoid_` line still names the terms people reach for.

**Steps:**
- [ ] `grep -n "MAX_CRASH_LOG_FILES\|install_panic_hook\|find_crash_log_for_pid\|OnCrash\|set_crash_log_dir" docs/decisions/0025-*.md CONTEXT.md` and compare each against `src/agent/crashlog.rs`, `src/agent/worker/manager.rs`, `src/agent/worker/client.rs`, `src/agent/session/router.rs`, `src/agent/session/mod.rs` — fix every drift.
- [ ] Fix `:59`'s three-OS / `APPDATA` claim.
- [ ] Review every remaining `write_crash_log` mention in `docs/` (ADR `:36`, `:40`, `:51`) and confirm each reads as past-tense "was deleted" prose, not as live API. **A "no hits" grep is not the criterion here** — the ADR names the function precisely because it is the thing that was removed.
- [ ] Confirm the amendment records the Windows guard gap, its `dirs-sys` cause, and the `PanicHookInfo`/`type_complexity` constraints that shaped the seams (a future reader will otherwise try to delete them).
- [ ] Commit: `docs: the crash-log contract (ADR 0025 amendment + glossary)`

**Acceptance criteria:**
- [ ] Every symbol and number in the amendment and glossary exists verbatim in the code.
- [ ] No doc claims the hook resolves its own directory, and no doc claims the CI guard covers Windows.
- [ ] Every `write_crash_log` mention in `docs/` is past-tense prose about the deletion.
