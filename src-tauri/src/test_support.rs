//! Test support utilities for Archimedes Desktop.
//!
//! Provides helpers for common patterns in integration and unit testing.

/// The shared lock serializing the HOME-mutating tests (the parallel test
/// harness runs all module tests concurrently; a `HOME` read by one test
/// mid-mutation by another would see the wrong value).
pub static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire the env-mutation lock (poison-tolerant — a sibling test
/// panicking while holding it must not turn this test's failure into an
/// opaque `PoisonError` panic; see the `ENV_LOCK` docs).
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    std::sync::Mutex::lock(&ENV_LOCK).unwrap_or_else(|p| p.into_inner())
}

/// (test only) The broadest rule path a test can name — the one root that
/// really does contain every canonical absolute path ON THIS PLATFORM.
///
/// WHY THIS EXISTS: a test that wants "a rule with maximum reach" reaches for
/// the literal `"/"`, and that is a Unix fact, not a platform one. On Windows
/// a lone `/` is only the CURRENT DRIVE'S root in the current working
/// directory's spelling, and it is not a component prefix of the verbatim
/// (`\\?\C:\…`) form that `canonicalize` hands back — so a `"/"` rule matches
/// NOTHING and a test that asserts it refuses something reddens there while
/// staying green on Linux and macOS. This is the same fact
/// `boundary::unrestricted_floor` had to encode to widen the executor on
/// Windows: a lone `/` there is only the current drive, so that function
/// enumerates the mounted drive roots instead.
///
/// `for_path` is a path the test is actually working with (its scratch home or
/// `cwd`); the root is taken from ITS OWN components, so the two land on the
/// same drive AND on the same verbatim spelling that the shared canonicalizer
/// (`agent::fs_backend::canonicalize_lenient`) produces for it — which is the
/// property the caller needs for a component-prefix compare to hold.
///
/// The result is run through `canonicalize()` for the same reason: on Windows
/// the drive root spelled `C:\` has a `Disk` prefix component while the
/// canonicalized target carries a `VerbatimDisk` one (`\\?\C:\…`), and
/// `Path::starts_with` compares components — so the raw spelling would still
/// fail the very compare it exists to satisfy. Canonicalizing lands both sides
/// in the verbatim form. Strict `canonicalize()` (not the shared lenient one)
/// is enough here and is deliberately the only resolver used: a drive root
/// derived from a real path always EXISTS, and it keeps this test helper from
/// reaching into `crate::agent`'s private `fs_backend` module.
#[cfg(test)]
pub(crate) fn filesystem_root(for_path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(not(windows))]
    {
        // On unix the root is the one true `/`, and every canonical absolute
        // path is under it. `for_path` is irrelevant here, but the signature
        // stays uniform so the call sites do not need a `cfg`.
        let _ = for_path;
        std::path::PathBuf::from("/")
    }
    #[cfg(windows)]
    {
        // `Prefix`(e.g. `C:`) then `RootDir`(`\`) is the drive root — the
        // component-wise root, not a string slice, so a UNC path yields its
        // own server/share root rather than a mangled `C:\`.
        let mut root = std::path::PathBuf::new();
        for component in for_path.components() {
            match component {
                std::path::Component::Prefix(prefix) => root.push(prefix.as_os_str()),
                std::path::Component::RootDir => {
                    root.push(component.as_os_str());
                    break;
                }
                // Anything else is below the root: stop.
                _ => break,
            }
        }
        assert!(
            !root.as_os_str().is_empty(),
            "`{for_path:?}` is rooted on a drive — a relative path has no root to name"
        );
        root.canonicalize().unwrap_or(root)
    }
}

/// The app's managed `WorkerManager` (the registry view — the accessor
/// for the headless IPC test: a `start_session` spawns a Worker (assert
/// via `test_is_attached` / `test_session_count`); a `detach` / `reap_all`
/// removes it). `None` when the app did not manage one (the `setup_dirs`
/// seam did not run).
pub fn worker_manager<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
) -> Option<std::sync::Arc<crate::agent::worker::manager::WorkerManager>> {
    use tauri::Manager;
    handle
        .try_state::<std::sync::Arc<crate::agent::worker::manager::WorkerManager>>()
        .map(|s| s.inner().clone())
}

use std::sync::Arc;

use crate::agent::events::EventSink;
use crate::agent::worker::client::WorkerInboundEvent;
use crate::agent::worker::manager::WorkerHooks;

/// A no-op [`WorkerHooks`] implementation for tests.
#[derive(Default, Debug, Clone, Copy)]
pub struct NullHooks;

impl WorkerHooks for NullHooks {
    fn on_event(&self, _session_id: &str, _is_subagent: bool, _evt: WorkerInboundEvent) {}
    fn on_crash(&self, _session_id: &str, _code: Option<i32>, _pid: Option<u32>) {}
    fn sink_for(&self, _parent_session_id: &str) -> Option<Arc<dyn EventSink>> {
        None
    }
    fn register_child_cwd(&self, _session_id: &str, _cwd: &str) {}
}

/// The app's managed `Db` (the accessor for the headless IPC test — the
/// `TranscriptPersister`'s rows are asserted through it). `None` when the
/// app did not manage one.
pub fn db<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
) -> Option<std::sync::Arc<crate::storage::Db>> {
    use tauri::Manager;
    handle
        .try_state::<std::sync::Arc<crate::storage::Db>>()
        .map(|s| s.inner().clone())
}

/// Serve a fixed `GET` response for as many requests as arrive (until
/// the `JoinHandle` is aborted); `counter` (when `Some`) is incremented
/// per request (the cache tests count fetches). `status` + `body` mirror
/// the `catalog.rs` `raw_json_server` (its raw-HTTP-response construction
/// — that private one accepts exactly ONCE and is unreachable from other
/// modules).
pub async fn raw_json_server(
    listener: tokio::net::TcpListener,
    status: u16,
    body: &str,
    counter: Option<std::sync::Arc<std::sync::atomic::AtomicU32>>,
) -> tokio::task::JoinHandle<()> {
    // Owned (the spawned task needs `'static`; the `&str` borrow would
    // otherwise escape the function).
    let body = body.to_string();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let mut data = Vec::new();
            while !data.windows(4).any(|w| w == b"\r\n\r\n") {
                let Ok(n) = stream.read(&mut buf).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                data.extend_from_slice(&buf[..n]);
            }
            if let Some(counter) = counter.clone() {
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            let reason = if status == 200 { "OK" } else { "Unauthorized" };
            let resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        }
    })
}

/// Is `s` EXACTLY SIX LOWERCASE hex chars — the shape
/// `crate::agent::types::mint_incarnation` guarantees for a **Session
/// incarnation** stamp (ADR 0049)?
///
/// The shared pin for the `protocol` unit test and the two-process e2e, because
/// the obvious check is half blind: `len() == 6` + `u32::from_str_radix(s, 16)`
/// also accepts `A3F9C1` (and a radix parse accepts a leading `+`, so it is not
/// even an alphabet check on its own). The BYTE SET is the whole argument: a
/// stamp made only of `[0-9a-f]` is lowercase by construction, which is what
/// makes the `to_lowercase` clause implied rather than load-bearing — it is kept
/// because ADR 0049 names lowercase at the seam, and because it is the clause
/// that fails LOUDEST (`A3F9C1` trips it first) when a stamp source ever grows
/// upper-case letters. Case is not what keeps a stamp from equaling a
/// bookkeeping word, either: `system` and `retract` are already lowercase, and
/// what they are not is hex-spelled (`system` carries `s`/`y`/`t`/`m`, `retract`
/// is seven chars and carries `r`/`t`) — see `normalize::is_bookkeeping_message_id`.
pub fn is_incarnation_stamp(s: &str) -> bool {
    let lower_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    s.len() == 6 && s == s.to_lowercase() && s.bytes().all(lower_hex)
}

/// A scratch dir for ONE test, REMOVED when it is dropped.
///
/// The shared guard behind #96: a fixture that hands back a bare `PathBuf`
/// leaks its directory the moment an assertion panics, and one green run
/// leaked 432 of them into the temp dir until the per-user quota exhausted.
/// Ownership is the fix — a dir the fixture cannot forget to delete. (What a
/// per-test panic can and cannot pin is recorded on the panic test in this
/// module (`the_guard_removes_its_dir_when_the_scope_holding_it_panics`); the
/// run-level proof is task 09's census.)
///
/// The BASE is a parameter, never a guess: [`ScratchDir::in_dir`] (the caller
/// names the base), [`ScratchDir::in_env_temp`] (the ambient temp dir) and
/// [`ScratchDir::in_tmpfs`] (a tmpfs, for fixtures whose PREMISE belongs to the
/// filesystem). `agent/tools/sandbox.rs` deliberately does NOT use either
/// convenience constructor — its fixtures must sit OUTSIDE the sandbox write
/// allow-list, and a fallback to `std::env::temp_dir()` would put them inside
/// it. See its `test_base()`.
///
/// NOT `Clone`, on purpose: a second owner would `remove_dir_all` the same path
/// twice. [`ScratchDir::to_path_buf`] is the escape hatch for a call site that
/// needs an owned path — but the dir still dies with the guard.
///
/// This module is NOT `#[cfg(test)]`-gated (see the module docs): these items
/// are compiled into release builds and into the rlib `tests/*.rs` links
/// against, which is what lets an integration test reach
/// `archimedes_lib::test_support::ScratchDir`. A `Drop` impl in a shipping
/// binary is harmless — it removes a directory this type created — and it is
/// here deliberately, not left behind by accident.
pub struct ScratchDir {
    path: std::path::PathBuf,
}

impl ScratchDir {
    /// A fresh dir directly inside `base`, named `{prefix}{tag}-{uuid}`.
    /// `None` when `base` cannot accept it — the caller decides whether that
    /// means "skip" or "panic" (the sandbox tests skip loudly; they must not
    /// fall back to a base that would make them vacuous).
    pub fn in_dir(base: &std::path::Path, prefix: &str, tag: &str) -> Option<Self> {
        let path = base.join(format!("{prefix}{tag}-{}", uuid::Uuid::new_v4()));
        // `create_dir_all` IS the probe: a present-but-unwritable base must
        // report `None` rather than panic a fixture (the lesson of the prior
        // art, which checked `is_dir()` first and could still fail the write).
        std::fs::create_dir_all(&path).ok()?;
        Some(Self { path })
    }

    /// The ambient temp dir (`std::env::temp_dir()`) — the base the guards in
    /// `boundary`, `loop/tests` and `commands/files` use today. Panics only if
    /// `temp_dir()` itself is unwritable, which every one of those guards has
    /// always assumed.
    pub fn in_env_temp(prefix: &str, tag: &str) -> Self {
        Self::in_dir(&std::env::temp_dir(), prefix, tag).expect(
            "`std::env::temp_dir()` accepts a `create_dir_all` — the guards this \
             replaces already assumed it writable, so this is a carried-over \
             precondition rather than an invariant (`TMPDIR` can name a dir that \
             is not writable; that is the condition #96 describes)",
        )
    }

    /// A tmpfs: the first entry of [`tmpfs_base_candidates`] that accepts a
    /// `create_dir_all`. For fixtures that assert something about the
    /// FILESYSTEM (the `commands/files` cap fixtures need `readdir` to
    /// disagree with sorted order, which only a tmpfs guarantees).
    pub fn in_tmpfs(prefix: &str, tag: &str) -> Self {
        for base in tmpfs_base_candidates() {
            if let Some(dir) = Self::in_dir(&base, prefix, tag) {
                return dir;
            }
        }
        panic!(
            "no tmpfs candidate accepted a scratch dir for `{prefix}{tag}` — the \
             final candidate is `std::env::temp_dir()`, which the guards this \
             replaces already assumed writable (a carried-over precondition, not \
             an invariant: an unwritable `TMPDIR` is exactly #96's hostile case)"
        )
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The dir as a shell-quotable string (the tags are uuid-derived, so no
    /// quoting character can appear) — the sandbox tests' `display()` needs.
    pub fn display(&self) -> String {
        self.path.display().to_string()
    }

    pub fn to_path_buf(&self) -> std::path::PathBuf {
        self.path.clone()
    }
}

/// The tmpfs candidates, best first:
/// - `/dev/shm` when `Path::new("/dev/shm").is_dir()` — tmpfs on Linux, and it
///   satisfies the readdir premise for BOTH cap-fixture layouts (measured on
///   the prior art, `5e3cfc6`). Linux-only, so macOS and Windows get a
///   one-element list.
/// - `std::env::temp_dir()` — always last, always present.
///
/// `/dev/shm` carries the SAME per-user quota as `/tmp`, so landing here is
/// not a licence to leak; the `Drop` below is what keeps the base change from
/// MOVING the leak.
pub fn tmpfs_base_candidates() -> Vec<std::path::PathBuf> {
    let shm = std::path::Path::new("/dev/shm")
        .is_dir()
        .then(|| std::path::PathBuf::from("/dev/shm"));
    shm.into_iter()
        .chain(std::iter::once(std::env::temp_dir()))
        .collect()
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl std::ops::Deref for ScratchDir {
    type Target = std::path::Path;
    fn deref(&self) -> &Self::Target {
        &self.path
    }
}

/// Load-bearing, not decoration: `std::fs::create_dir_all(&guard)` and
/// `std::os::unix::fs::symlink(&guard, …)` FAIL with
/// `` the trait bound `ScratchDir: AsRef<Path>` is not satisfied `` when only
/// `Deref` is present — the blanket `impl AsRef<U> for &T` needs `T: AsRef<U>`,
/// and `Deref` does not supply it. Both spellings occur in
/// `commands/files/tests/` today. `Deref` alone covers the method calls
/// (`root.join(..)`, `root.to_string_lossy()`) and the `Some(&home)` →
/// `Option<&Path>` coercion; `AsRef` alone does not cover those. Both required.
impl AsRef<std::path::Path> for ScratchDir {
    fn as_ref(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::{is_incarnation_stamp, tmpfs_base_candidates, ScratchDir};

    /// Does the CI data-dir redirect actually reach `dirs::data_dir()`?
    ///
    /// This is the PREMISE of `scripts/check-test-data-dir.sh`, and the reason
    /// the guard cannot rest on the script alone. That script asks "is the
    /// redirected data dir free of `crash-*.log`?" — and a CI runner's REAL data
    /// dir was never written to, so unredirected it answers "yes" while checking
    /// nothing. That shape has bitten this repo before and is recorded at
    /// `agent/tools/exec.rs:1780-1791`: the first version of the stdin test
    /// passed with `closed_stdin` deleted, because CI's fd 0 was already
    /// `/dev/null`. So the script asserts the conclusion and THIS test asserts
    /// the premise: if the CI step's `env:` block ever stops taking effect (a
    /// renamed variable, a gate that no longer matches, a `dirs` upgrade that
    /// resolves the dir differently), this test reddens the `cargo test` step
    /// instead of the leak guard quietly becoming decoration.
    ///
    /// **Unset means "a local run" and the test returns immediately** — that arm
    /// is inert, not dead. `ARCHIMEDES_TEST_DATA_DIR` is set only by the CI
    /// steps that redirect; a developer running plain `cargo test` has no
    /// redirect to verify, and demanding one here would turn every local run red
    /// for nothing. Nothing here sets or mutates an environment variable: the
    /// lib binary reads env globally WITHOUT holding `ENV_LOCK` (see the note on
    /// that static), so a `set_var` from any test is forbidden — the isolation
    /// lives in CI plus the shell script, and this test only READS.
    ///
    /// The assertion is a PATH PREFIX, not equality, and it is
    /// `Path::starts_with` rather than a string prefix:
    ///   - Linux: `data_dir()` IS `XDG_DATA_HOME` (`dirs-6.0.0/src/lin.rs:11`),
    ///     so the two paths are EQUAL — which satisfies a prefix trivially.
    ///   - macOS: `data_dir()` is `$HOME/Library/Application Support`
    ///     (`dirs-6.0.0/src/mac.rs:7,12`), so it sits UNDER the redirected
    ///     `HOME`, and equality would fail a correct redirect.
    ///
    /// `starts_with` covers both platforms with one assertion. Its
    /// path-component form is what makes that assertion sound: it compares
    /// COMPONENTS, so a redirect of `/tmp/adh` does NOT match a data dir of
    /// `/tmp/adhome/Library/Application Support` — the macOS shape a plain string
    /// `starts_with` would accept, accepting a run that wrote somewhere else
    /// entirely. (The two spellings only differ once a subdirectory is involved;
    /// on Linux the paths are equal, so neither prefix form discriminates.)
    ///
    /// SCOPE, honestly: this catches Linux/macOS redirect drift and a future
    /// `dirs` change. It covers WINDOWS NOT AT ALL — `dirs` resolves the Windows
    /// data dir with `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`
    /// (`dirs-sys-0.5.0/src/lib.rs:150-178`; `dirs-6.0.0/src/win.rs:10`), which
    /// ignores `%APPDATA%`, so no environment variable redirects it and the CI
    /// steps set nothing on Windows for that reason. Windows is guarded by
    /// Task 2's census alone; that gap is recorded, not closed.
    #[test]
    fn the_ci_data_dir_redirect_took_effect() {
        let Some(var) = std::env::var_os("ARCHIMEDES_TEST_DATA_DIR") else {
            // A local run: no redirect was asked for, so there is nothing to
            // verify (see the doc comment — this arm is inert by design).
            return;
        };

        let expected = std::path::Path::new(&var);
        let actual = dirs::data_dir().expect(
            "the redirect names a data dir, so `dirs::data_dir()` cannot be `None` here — \
             a `None` means the redirect was never read",
        );

        assert!(
            actual.starts_with(expected),
            "the CI data-dir redirect did not take effect: `dirs::data_dir()` is \
             {actual:?}, which is not under `ARCHIMEDES_TEST_DATA_DIR` = {expected:?}. \
             On Linux the redirect is `XDG_DATA_HOME` (so the two are EQUAL); on macOS it \
             is `HOME` (so `data_dir()` is `$HOME/Library/Application Support`, i.e. UNDER \
             it). Without the redirect the crash-log leak guard in \
             `scripts/check-test-data-dir.sh` passes for the wrong reason — see \
             `agent/tools/exec.rs:1780-1791`."
        );
    }

    /// Is the directory `scripts/check-temp-dir-census.sh` counts the directory
    /// this suite actually writes into?
    ///
    /// This is the PREMISE of that census, in the same two-halves shape as
    /// `the_ci_data_dir_redirect_took_effect` above: the script asserts the
    /// conclusion ("no NEW directories appeared"), and this test asserts that the
    /// conclusion was drawn about the right directory. The script cannot ask Rust
    /// what `std::env::temp_dir()` resolves to, and its own resolution rule
    /// (`$TMPDIR` if set, else the platform default —
    /// `library/std/src/sys/paths/unix.rs`) is an imitation of Rust's, however
    /// careful. If the imitation ever diverges — a renamed variable, a runner that
    /// sets `TMPDIR` for the shell step but not for the `cargo test` step, a
    /// platform whose default the script guesses wrong — the census counts a
    /// directory nobody wrote to and prints "census clean" having checked nothing.
    /// That is this repo's most-repeated failure mode (the stdin test that passed
    /// with `closed_stdin` DELETED because CI's fd 0 was already `/dev/null`,
    /// recorded at `agent/tools/exec.rs:1780-1791`), and it is why #96 task 09's
    /// guard ships with this test rather than with the script alone.
    ///
    /// **Both sides are canonicalised, and that is load-bearing on macOS.**
    /// `temp_dir()` returns `TMPDIR` VERBATIM; the script canonicalises with
    /// `cd … && pwd -P` because `find` will not descend a symlinked start point.
    /// macOS's `TMPDIR` is `/var/folders/…/T/` and `/var` is a symlink to
    /// `/private/var`, so a plain string comparison would FAIL A CORRECT SETUP —
    /// the same reason this module's sibling chose `starts_with` over equality for
    /// the macOS `Library/Application Support` nesting.
    ///
    /// **Unset means "a local run" and the test returns immediately** — the arm is
    /// inert, not dead. `ARCHIMEDES_TEST_CENSUS_BASE` is written by the CI snapshot
    /// step into `$GITHUB_ENV`, which exports it to SUBSEQUENT steps only, so it
    /// reaches this test precisely because the snapshot runs BEFORE `cargo test`;
    /// move that step below the suite and this test silently takes the unset arm
    /// (green, having verified nothing) while `verify`'s own base-drift check is
    /// what reddens the run. A developer's plain `cargo test` has no bracket to
    /// verify. Nothing here sets or mutates an environment variable: the lib binary
    /// reads env globally WITHOUT holding `ENV_LOCK` (see the note on that static),
    /// so a `set_var` from any test is forbidden — this test only READS.
    ///
    /// SCOPE, honestly: it proves the shell's resolved base and Rust's agree on the
    /// leg that runs it. It says nothing about WINDOWS, where CI gates the census
    /// off entirely (Rust resolves the temp dir through `GetTempPath2W` over
    /// `TMP`/`TEMP`, not `TMPDIR`) — Windows keeps the `childproc` census invariant
    /// as its only leak guard, a recorded gap and not an oversight.
    #[test]
    fn the_census_base_is_the_temp_dir_the_suite_actually_uses() {
        let Some(var) = std::env::var_os("ARCHIMEDES_TEST_CENSUS_BASE") else {
            // A local run: no bracket was asked for, so there is nothing to
            // verify (see the doc comment — this arm is inert by design).
            return;
        };

        let expected = std::fs::canonicalize(&var).expect(
            "the CI census base exists — the snapshot step resolved it out of the \
             same environment this test runs in, so a failure here means the \
             variable names a path that is not a directory",
        );
        let actual = std::fs::canonicalize(std::env::temp_dir())
            .expect("`std::env::temp_dir()` names a real dir");

        assert_eq!(
            actual, expected,
            "the census in `scripts/check-temp-dir-census.sh` counted {expected:?}, but this \
             test's `std::env::temp_dir()` is {actual:?} — the guard is counting a directory \
             the suite does not write to, so it passes having checked nothing (#96 task 09)"
        );
    }

    /// The negative cases are the point, though only `A3F9C1` is a case the
    /// `len() == 6` + `u32::from_str_radix(_, 16)` check this replaces was
    /// actually BLIND to — the length clause already caught the 7-char, 5-char
    /// and empty ones, and the radix parse already rejected `abcdefg`. The rest
    /// are kept so that a future "simplify it back" that drops EITHER half of
    /// this predicate reddens something here.
    #[test]
    fn the_stamp_shape_rejects_everything_a_radix_parse_admits() {
        for ok in ["a3f9c1", "000000", "ffffff", "dead01"] {
            assert!(is_incarnation_stamp(ok), "{ok} is a stamp");
        }
        for bad in [
            "A3F9C1",  // uppercase hex — parses, wrong case
            "+a3f9c1", // a signed number — parses, not an id
            "a3f9c",   // five chars
            "a3f9c10", // seven chars
            "abcdefg", // not hex (`g`)
            "",        // the EMPTY stamp `TurnState::default()` carries
        ] {
            assert!(!is_incarnation_stamp(bad), "{bad} is NOT a stamp");
        }
    }

    /// The guard removes its dir when its owner is dropped — the whole
    /// mechanism #96 needs (a bare `PathBuf` has no `Drop`, so every panicking
    /// assertion leaked one dir; 432 per green run).
    #[test]
    fn a_scratch_dir_is_gone_when_its_owner_is_dropped() {
        let guard = ScratchDir::in_env_temp("test-support-guard-", "drop");
        assert!(guard.path().is_dir(), "creating the guard made the dir");
        let captured = guard.to_path_buf();
        drop(guard);
        assert!(
            !captured.exists(),
            "the guard's `Drop` removed its dir — {captured:?} is gone"
        );
    }

    /// What this pins: the guard's `Drop` runs during an UNWIND, not only on a
    /// normal `drop()` (the test above). The shape is the repo's own precedent,
    /// `agent/mcp/oauth.rs`'s panic test: the guard is created and MOVED INTO
    /// the panicking closure, so the scope the panic unwinds past is the scope
    /// that owns it. That placement is load-bearing — `catch_unwind` is
    /// `ManuallyDrop` machinery around the `try` intrinsic and nothing in its
    /// contract drops values that OUTLIVED the caught panic, so a guard created
    /// outside the closure would prove only that `catch_unwind` returned.
    ///
    /// What this does NOT pin, and what no per-test Rust test can: #96's
    /// headline case — a test that FAILS with its guard as a plain local, so
    /// the panic ESCAPES the test fn and it is the harness's own unwind that
    /// would have to remove the dir. Rust makes no portable guarantee there
    /// (during an unwind, dropping is treated as fallible — a double panic
    /// aborts), so claiming it from one test would be decoration. That case is
    /// pinned by the CENSUS instead: roadmap task 09's post-run count of the
    /// per-prefix dirs after a run. A failing test that leaks is caught by the
    /// count, not here.
    #[test]
    fn the_guard_removes_its_dir_when_the_scope_holding_it_panics() {
        let captured = {
            let guard = ScratchDir::in_env_temp("test-support-guard-", "unwind");
            let path = guard.to_path_buf();
            assert!(path.is_dir(), "the guard created its dir");
            // The guard MOVES into the panicking scope: that is the value the
            // unwind drops. Created outside the closure, this asserts nothing.
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _held = guard;
                panic!("a fixture blows up while holding its scratch dir");
            }));
            assert!(r.is_err(), "the closure panicked as arranged");
            path
        };
        assert!(
            !captured.exists(),
            "the unwind ran the guard's `Drop` — {captured:?} is gone"
        );
    }

    /// The naming contract the #96 census reads: `{prefix}{tag}-{uuid}`. The
    /// uuid half matters as much as the shape — two tests that ask for the
    /// SAME tag must not share a dir (they would delete each other's fixture).
    #[test]
    fn the_guard_names_the_dir_after_the_prefix_and_tag_it_is_given() {
        let a = ScratchDir::in_env_temp("test-support-guard-", "naming");
        let name = a
            .path()
            .file_name()
            .expect("a scratch dir has a file name")
            .to_string_lossy()
            .into_owned();
        assert!(
            name.starts_with("test-support-guard-naming-"),
            "the name must carry the prefix then the tag: {name}"
        );
        // The uuid segment is non-empty (a name ending in `-` would mean two
        // tests collide on it).
        assert!(
            name.strip_prefix("test-support-guard-naming-")
                .is_some_and(|uuid| !uuid.is_empty()),
            "the uuid segment must be present: {name}"
        );

        let b = ScratchDir::in_env_temp("test-support-guard-", "naming");
        assert_ne!(
            a.path(),
            b.path(),
            "the SAME tag must still mint a DIFFERENT dir"
        );
    }

    /// The fallback chain `in_tmpfs` walks, pinned: non-empty, terminating at
    /// the ambient temp dir (so the constructor can only panic where `tmp_dir`
    /// already assumed writability), and actually honoured by `in_tmpfs`.
    #[test]
    fn the_tmpfs_candidates_end_at_the_ambient_temp_dir() {
        let candidates = tmpfs_base_candidates();
        assert!(
            !candidates.is_empty(),
            "there is always at least one candidate"
        );
        assert_eq!(
            candidates.last().map(|p| p.as_path()),
            Some(std::env::temp_dir().as_path()),
            "the LAST candidate must be the ambient temp dir"
        );

        let d = ScratchDir::in_tmpfs("test-support-guard-", "tmpfs-chain");
        assert!(
            candidates.iter().any(|c| d.path().starts_with(c)),
            "in_tmpfs landed {:?}, which is not under any candidate {candidates:?}",
            d.path()
        );

        #[cfg(target_os = "linux")]
        if std::path::Path::new("/dev/shm").is_dir() {
            assert_eq!(
                candidates.first().map(|p| p.as_path()),
                Some(std::path::Path::new("/dev/shm")),
                "on Linux `/dev/shm` is the FIRST candidate — it is the base the \
                 cap fixtures' readdir premise holds on regardless of `TMPDIR`"
            );
        }
    }
}
