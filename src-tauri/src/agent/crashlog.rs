//! The crash-logging panic hook (ADR 0025 Task 2 — the shared hook,
//! reused by the Supervisor in Task 6): a Worker panic stays in the
//! Worker (the release profile is `panic = "unwind"` — a Worker
//! process dies, the app lives), and the crash is LOGGED to
//! `<dir>/crash-<ts>-<tag>.log`.
//!
//! The `dir` comes from the CALLER — never from this module. That is
//! load-bearing, not convenience: a hook that resolves its own
//! destination decides that destination *during the panic*, and since
//! `std::panic` has ONE process-global hook slot, whatever closure
//! happens to occupy it then decides where every thread's crash log
//! goes. Both production sites therefore resolve the directory
//! themselves (`dirs::data_dir().join("archimedes")` — the same
//! resolution as `lib.rs`'s setup) and hand it over at install time —
//! which happens before any other thread runs app code (in the Worker a
//! multi-thread runtime already exists by then, but no thread of it is
//! running our code yet).
//!
//! invariant: `childproc`'s census forbids a data-dir resolver in this
//! file's production region (crash-log-hardening Task 2), so a
//! reasonable-looking `let dir = dirs::data_dir()` cannot grow back here.
//!
//! The tags: the Worker's `"worker"` (the session id is unknown before
//! `Start`; the file name carries the timestamp — the Supervisor's
//! crash attribution uses the exit + the `session-stalled`
//! bookkeeping, NOT the file name); the Supervisor's (Task 6):
//! `"supervisor"`.
//!
//! NOTE (toolchain): the panic info is only reachable from INSIDE a
//! panic hook (this std has no `unwrap_panic_hook_info`), so the writer
//! takes the live `PanicHookInfo` (`write_crash_log_from_info`) and the
//! hook closure is the production entry.

/// The writer's testable core: writes `<dir>/crash-<ts>-<tag>.log`.
/// Content: the panic message + location + a captured backtrace.
///
/// It takes the payload and the location as PLAIN STRINGS on purpose:
/// `PanicHookInfo` is unconstructible outside std (`PanicHookInfo::new`
/// is `pub(crate)`, and its fields `payload`, `location`, `can_unwind`
/// and `force_no_backtrace` are private — `error[E0451]`), so no test
/// can build the hook's argument and nothing downstream of the hook is
/// testable through it. This seam is how the writer's contract gets
/// tested — without a hook, without the process-global hook slot, and
/// without any chance of a foreign panic landing in the test's dir.
///
/// The capture uses `std::backtrace::Backtrace::force_capture()`: plain
/// `Backtrace::capture()` is EMPTY unless `RUST_BACKTRACE` is set, but
/// `force_capture` gets the frames regardless (raw frames survive
/// `strip`; the message + location always resolve).
fn write_crash(
    dir: &std::path::Path,
    tag: &str,
    payload: &str,
    location: &str,
) -> Option<std::path::PathBuf> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("crash-{ts}-{tag}.log"));
    // `force_capture`: plain `Backtrace::capture()` is empty unless
    // `RUST_BACKTRACE` is set — `force_capture` gets the frames
    // regardless (raw frames survive `strip`).
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let content = format!("panic: {payload}\nlocation: {location}\n\nbacktrace:\n{backtrace}\n");
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&path, content).ok()?;
    Some(path)
}

/// Adapter from a live `PanicHookInfo` to `write_crash`: decodes the
/// payload (`unwrap_or` a placeholder) and the location (`file:line:col`)
/// and delegates; a `None` return means the write failed. `dir` is the
/// caller's directory — this function resolves nothing.
///
/// Because the argument is only ever constructible inside std, this is
/// reachable ONLY from a live panic hook; tests go through `write_crash`.
pub fn write_crash_log_from_info(
    dir: &std::path::Path,
    tag: &str,
    info: &std::panic::PanicHookInfo,
) -> Option<std::path::PathBuf> {
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_default();
    write_crash(
        dir,
        tag,
        info.payload_as_str().unwrap_or("<non-string payload>"),
        &location,
    )
}

/// The hook's body (no `Once`, no `take_hook`, no chaining — the chain
/// belongs to [`install_panic_hook`], the only place it can live, since
/// this std has no `default_hook`). Split out so a test can install a
/// crash-writing hook WITHOUT consuming `install_panic_hook`'s
/// process-global single-use `Once`.
fn hook_closure(
    tag: String,
    dir: std::path::PathBuf,
) -> impl Fn(&std::panic::PanicHookInfo) + Send + Sync + 'static {
    move |info: &std::panic::PanicHookInfo| {
        let _ = write_crash_log_from_info(&dir, &tag, info);
    }
}

/// Install the hook (idempotent — `std::panic::set_hook`): writes the
/// log to `dir`, then calls the previous hook (captured via `take_hook`
/// — this std has no `default_hook`). Chaining is load-bearing: dropping
/// it would silence panics on stderr and starve the Worker's stderr
/// drain (`client.rs`).
///
/// `dir` is the caller's — the hook resolves NOTHING at panic time.
/// Captured here, it is fixed before any other thread runs app code (in
/// the Worker a multi-thread runtime exists by now, but none of those
/// threads is running our code yet).
pub fn install_panic_hook(tag: &str, dir: std::path::PathBuf) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Take the currently installed hook (the default on the first
        // install) so it is called AFTER the crash log is written.
        let previous = std::panic::take_hook();
        let inner = hook_closure(tag.to_string(), dir);
        std::panic::set_hook(Box::new(move |info| {
            inner(info);
            previous(info);
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::{hook_closure, install_panic_hook, write_crash, write_crash_log_from_info};
    use std::time::Duration;

    /// The panic hook is ONE process-global slot and `install_panic_hook`
    /// is a `Once` that `take_hook`s whatever is installed, so the two
    /// HOOK-INSTALLING tests may never interleave: if the idempotency
    /// test runs while the crash-log test's hook is installed, it STEALS
    /// that hook and puts the production one in the slot, the crash-log
    /// test's own panic then bypasses its hook entirely and writes
    /// somewhere else — and the crash-log test's cleanup restores the
    /// production hook it accidentally captured, so every later panic in
    /// the process is handled by a hook this test installed. Held for the
    /// whole body of each test. A poisoned guard is REUSED (the crate
    /// convention): a `PoisonError` here would fail every test after the
    /// first one that panicked while holding it.
    ///
    /// `write_crash_writes_without_a_panic_hook_info` deliberately does
    /// NOT take this mutex — the whole point of the seam is that the
    /// writer is reachable without touching the hook slot.
    static HOOK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A temp dir for the crash logs (unique per test).
    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crashlog-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A panic (the hook installed, writing to a temp dir) writes a
    /// crash log containing the panic message + location, with a
    /// NON-EMPTY backtrace section (the `force_capture` behavior —
    /// frames even without `RUST_BACKTRACE`).
    ///
    /// NOTE: the panic hook is process-global and the `--lib` suite runs
    /// in parallel, so another test's panic — including one in a
    /// detached task that fails nothing — lands in THIS test's temp
    /// dir; the log is therefore identified by its payload marker, never
    /// by its file name.
    #[test]
    fn the_panic_hook_writes_a_crash_log_with_location_and_a_nonempty_backtrace() {
        let _hook = HOOK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = temp_dir();
        // The marker is unique per run: it is what proves a candidate
        // file is THIS panic's log (see the NOTE above).
        let marker = format!("test crash payload {}", uuid::Uuid::new_v4());
        let previous = std::panic::take_hook();
        let dir_hook = dir.clone();
        std::panic::set_hook(Box::new(move |info| {
            let _ = write_crash_log_from_info(&dir_hook, "worker", info);
            // The log is the primary output — the previous hook is NOT
            // called here to keep the test output clean.
        }));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let panic_payload = marker.clone();
        std::thread::spawn(move || {
            let _ = tx.send(());
            panic!("{panic_payload}");
        });
        rx.recv().expect("the thread signalled before panicking");
        // The hook runs (synchronously) at the panic's start — the file
        // appears once the hook's write lands (a bounded retry). A
        // foreign `crash-*-worker.log` (another test's panic) is read
        // and REJECTED here by its content, not skipped by its name.
        let mut path = None;
        for _ in 0..100 {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("crash-") && name.ends_with("worker.log") {
                        let candidate = entry.path();
                        let owned =
                            std::fs::read_to_string(&candidate).is_ok_and(|c| c.contains(&marker));
                        if owned {
                            path = Some(candidate);
                            break;
                        }
                    }
                }
            }
            if path.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Restore the previous hook (the hook is process-global).
        std::panic::set_hook(previous);
        let path = path.expect("the crash log file appears");
        let content = std::fs::read_to_string(&path).expect("the crash log is readable");
        assert!(
            content.contains(&marker),
            "the panic message is in the log:\n{content}"
        );
        assert!(
            content.contains("location:"),
            "the panic location is in the log:\n{content}"
        );
        assert!(
            content.contains(".rs:"),
            "the location is a real file:line:column:\n{content}"
        );
        // The backtrace section is NON-EMPTY (the `force_capture`
        // behavior — a plain `capture()` would be empty without
        // `RUST_BACKTRACE`).
        let backtrace = content
            .split("backtrace:\n")
            .nth(1)
            .expect("the backtrace section is present");
        assert!(
            !backtrace.trim().is_empty(),
            "force_capture produces frames even without RUST_BACKTRACE"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The hook writes to the directory IT WAS HANDED at install time —
    /// it resolves nothing itself. This is the regression guard for the
    /// real bug: the hook used to call `dirs::data_dir()` DURING the
    /// panic, so whichever closure occupied the single process-global
    /// hook slot decided where the file went, and 862 test panics landed
    /// in the user's `~/.local/share/archimedes/`.
    ///
    /// It installs `hook_closure` DIRECTLY (never `install_panic_hook`):
    /// the `Once` inside `install_panic_hook` is process-global and
    /// single-use, and `install_panic_hook_is_idempotent` is the one
    /// test entitled to consume it. A second consumer would silently
    /// no-op depending on test order.
    #[test]
    fn the_hook_writes_to_the_directory_it_was_given() {
        let _hook = HOOK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = temp_dir();
        // Unique per run: it is what proves a candidate file is THIS
        // panic's log (see the NOTE on the other hook test).
        let marker = format!("injected-dir {}", uuid::Uuid::new_v4());
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(hook_closure("worker-capture".into(), dir.clone())));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let panic_payload = marker.clone();
        std::thread::spawn(move || {
            let _ = tx.send(());
            panic!("{panic_payload}");
        });
        rx.recv().expect("the thread signalled before panicking");
        // Bounded retry (the hook writes synchronously at the panic's
        // start; the file appears once that write lands). Candidates are
        // matched by CONTENT, so a foreign panic's log is rejected rather
        // than mistaken for ours.
        let mut found = None;
        for _ in 0..100 {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let candidate = entry.path();
                    let name = candidate
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    if !name.starts_with("crash-") || !name.ends_with(".log") {
                        continue;
                    }
                    if std::fs::read_to_string(&candidate).is_ok_and(|c| c.contains(&marker)) {
                        found = Some(candidate);
                        break;
                    }
                }
            }
            if found.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Restore the previous hook BEFORE asserting (the hook is
        // process-global — a failing assertion must not leave this test's
        // hook installed for the rest of the process).
        std::panic::set_hook(previous);
        let path = found.expect("the crash log lands in the injected directory");
        assert_eq!(
            path.parent(),
            Some(dir.as_path()),
            "the hook wrote into the directory it was handed, not somewhere it resolved itself"
        );
        let content = std::fs::read_to_string(&path).expect("the crash log is readable");
        assert!(
            content.contains(&marker),
            "the panic message is in the log:\n{content}"
        );
        // The tag reaches the FILE NAME (not the content) — it is what
        // says which binary wrote the log.
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            name.ends_with("-worker-capture.log"),
            "the tag given to `hook_closure` is in the file name: {name}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The writer seam: `write_crash` is callable with NO `PanicHookInfo`
    /// (unconstructible outside std — `E0451`), no installed hook and no
    /// `HOOK` mutex, so a later task can exercise the writer's contract
    /// without occupying the process-global hook slot.
    #[test]
    fn write_crash_writes_without_a_panic_hook_info() {
        let dir = temp_dir();
        let marker = format!("seam payload {}", uuid::Uuid::new_v4());
        let path = write_crash(&dir, "worker", &marker, "src/agent/crashlog.rs:1:2")
            .expect("the write succeeds");
        assert_eq!(path.parent(), Some(dir.as_path()));
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            name.starts_with("crash-") && name.ends_with("-worker.log"),
            "the file name is crash-<ts>-<tag>.log: {name}"
        );
        let content = std::fs::read_to_string(&path).expect("the crash log is readable");
        assert!(content.contains(&marker), "payload: {content}");
        assert!(
            content.contains("location: src/agent/crashlog.rs:1:2"),
            "location: {content}"
        );
        let backtrace = content
            .split("backtrace:\n")
            .nth(1)
            .expect("the backtrace section is present");
        assert!(
            !backtrace.trim().is_empty(),
            "force_capture produces frames even without RUST_BACKTRACE"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `install_panic_hook` is idempotent (a double install is safe —
    /// the `Once` guard; the second call is a no-op).
    ///
    /// Two separate things keep this test off the user's disk, and the
    /// old comment credited only the first: the `HOOK` mutex orders it
    /// against the other hook tests, and the INJECTED `dir` is what makes
    /// the user's path unreachable — this binary never names it, so a
    /// panic that lands in the installed hook can only write into the
    /// temp dir.
    ///
    /// This is the ONLY test permitted to consume `install_panic_hook`'s
    /// `Once`: it is process-global and single-use, and restoring the
    /// hook does NOT reset it, so any second caller would silently no-op
    /// depending on test order — the guard here would then pass having
    /// proven nothing. Everything else installs `hook_closure` directly.
    #[test]
    fn install_panic_hook_is_idempotent() {
        let _hook = HOOK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = temp_dir();
        let previous = std::panic::take_hook();
        install_panic_hook("worker", dir.clone());
        install_panic_hook("worker", dir.clone());
        // Put the slot back as it was found: the `Once` above installed
        // our hook over it, and leaving that in place would write a crash
        // log for every panic in the REST of the test process (into the
        // injected temp dir — but still a hook no later test opted into).
        let installed = std::panic::take_hook();
        drop(installed);
        std::panic::set_hook(previous);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
