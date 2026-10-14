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
/// even an alphabet check on its own). LOWERCASE is part of the contract, not a
/// rendering preference — ADR 0049 and `types::mint_incarnation` both state it,
/// and it is part of why a stamp can never equal one of
/// `normalize::is_bookkeeping_message_id`'s bookkeeping words. The byte set is
/// the load-bearing half (it implies lowercase); the `to_lowercase` clause
/// states the ADR's own word at the seam.
pub fn is_incarnation_stamp(s: &str) -> bool {
    let lower_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    s.len() == 6 && s == s.to_lowercase() && s.bytes().all(lower_hex)
}

#[cfg(test)]
mod tests {
    use super::is_incarnation_stamp;

    /// The predicate's NEGATIVE cases are the whole point: each is something
    /// the `len() == 6` + `u32::from_str_radix(_, 16)` check it replaces was
    /// blind to, so a future "simplify it back" reddens here instead of
    /// silently re-opening the shape ADR 0049 pins.
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
