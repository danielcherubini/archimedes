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

#[cfg(test)]
mod tests {
    use super::is_incarnation_stamp;

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
}
