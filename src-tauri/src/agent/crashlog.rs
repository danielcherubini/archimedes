//! The crash-logging panic hook (ADR 0025 Task 2 — the shared hook,
//! reused by the Supervisor in Task 6): a Worker panic stays in the
//! Worker (the release profile is `panic = "unwind"` — a Worker
//! process dies, the app lives), and the crash is LOGGED to
//! `<dir>/crash-<ts>-<tag>-<pid>.log`.
//!
//! The `-<pid>` is this process's own (`std::process::id()`, stamped at
//! write time): two **Worker** processes crashing in the same millisecond
//! otherwise collide on one filename, and a name with no owner is why the
//! Stalled banner's crash attribution could only guess by recency. A
//! pre-amendment **pid-less** `crash-<ts>-<tag>.log` is still matched by
//! the attribution matcher (`router.rs`'s `is_worker_crash_log_name`),
//! because logs already on disk keep their names. Attribution reads the
//! pid back out of the name: the **Stalled** banner picks the log named for
//! the child the Supervisor just reaped (`router.rs`'s
//! `find_crash_log_for_pid`), and falls back to the pid-less shape only when
//! no pid was captured.
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
//! `Start`; the file name carries the timestamp and the pid — the
//! Supervisor's crash attribution reads the pid back out of it: the
//! **Stalled** banner selects the log named for the child it just reaped,
//! see `session::router`'s `find_crash_log_for_pid`); the Supervisor's:
//! `"supervisor"`.
//!
//! NOTE (toolchain): the panic info is only reachable from INSIDE a
//! panic hook (this std has no `unwrap_panic_hook_info`), so the writer
//! takes the live `PanicHookInfo` (`write_crash_log_from_info`) and the
//! hook closure is the production entry.

/// How long a crash log is kept (30 days), and how many are kept (50).
///
/// `debuglog` bounds its own file by BYTES (`MAX_LOG_BYTES` /
/// `MAX_LINE_BYTES`); crash logs are one file per crash rather than an
/// append-only stream, so the unit here is FILES, paired with an age
/// bound. Both bounds are needed: the cap alone lets one ancient
/// directory sit at the limit forever, the age alone lets a crash loop
/// write thousands of files in an afternoon.
pub const MAX_CRASH_LOG_AGE_DAYS: u64 = 30;
/// See [`MAX_CRASH_LOG_AGE_DAYS`].
pub const MAX_CRASH_LOG_FILES: usize = 50;

/// The writer's testable core: writes `<dir>/crash-<ts>-<tag>-<pid>.log`
/// (`<pid>` = `std::process::id()` — the writing process stamps itself).
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
    let path = dir.join(format!("crash-{ts}-{tag}-{}.log", std::process::id()));
    // `force_capture`: plain `Backtrace::capture()` is empty unless
    // `RUST_BACKTRACE` is set — `force_capture` gets the frames
    // regardless (raw frames survive `strip`).
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let content = format!("panic: {payload}\nlocation: {location}\n\nbacktrace:\n{backtrace}\n");
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&path, content).ok()?;
    // AFTER the write, never before: a write that failed has spent
    // nothing, and on a full disk this crash is worth more than the
    // history. `a_failing_write_prunes_nothing_even_though_it_could`
    // watches this position — it goes red (60 files become 50) if the
    // call moves above the `fs::write`.
    //
    // `path` goes in as the PROTECTED file: it is already sitting in the
    // directory, so without it the prune would be free to delete the log it
    // is supposed to be keeping (`a_full_directory_of_future_dated_logs_never_eats_the_new_crash`,
    // `equal_mtimes_never_decide_which_crash_survives`).
    prune_crash_logs(dir, &path);
    Some(path)
}

/// Best-effort retention: deletes crash logs older than
/// [`MAX_CRASH_LOG_AGE_DAYS`] and then trims what is left so that `dir`
/// holds at most [`MAX_CRASH_LOG_FILES`].
///
/// Runs AFTER the write, never before it: on a full disk (or a directory
/// that refuses anything) the crash log that just happened is worth more
/// than the history, so a failing write must not have spent a file to get
/// there.
///
/// # `keep` is never a candidate
///
/// The log that was just written is passed in as `keep` and is excluded from
/// BOTH passes — it is not deletable and it still COUNTS toward the cap, so
/// at most `MAX_CRASH_LOG_FILES - 1` older logs survive alongside it. That
/// exclusion is the whole reason the parameter exists. `prune_crash_logs`
/// runs after `fs::write` succeeded, so the new file is already in the
/// directory and would otherwise be a candidate like any other, and the
/// cap pass deletes from the FRONT of an mtime-sorted list: the new file is
/// exactly the file most likely to sit at the front, because after a clock
/// rollback its stamp is the only one in the PAST (every retained log looks
/// newer), and when the retained logs share one mtime — a crash loop writing
/// 50 logs inside a single mtime tick, or any coarse filesystem —
/// `sort_by_key` is stable and cannot rank them, so `read_dir`'s arbitrary
/// order picks the victim instead. Either way `write_crash` would return
/// `Some(path)` for a path that no longer exists, and the **Stalled** banner
/// hands that path to External Open: **a returned path that does not exist is
/// the one outcome worse than an unbounded directory**, because the user
/// clicks it and gets nothing while the crash leaves no trace.
///
/// Best-effort BY CONSTRUCTION — every fallible call is swallowed
/// (`read_dir`, `metadata`, `modified`, `remove_file`). This runs inside a
/// panic hook, where a second panic would replace the crash we are trying
/// to record with a deadlock-on-a-poisoned-lock story about itself. A
/// missing or unreadable directory returns early; a `remove_file` that
/// fails (read-only dir, a race with another process) is simply not
/// deleted this round.
///
/// The name pattern is deliberately WIDER than attribution's matcher: the
/// real names are `crash-<ts>-<tag>-<pid>.log` and the attribution matcher
/// (`router.rs`) has to recognise the older `crash-<ts>-<tag>.log` too, so
/// a prune matching the narrow shape would spare exactly the files worth
/// deleting. It must still NOT match `debuglog`'s `supervisor.log` /
/// `supervisor.log.old`, which live in the same directory.
///
/// # The two passes, and what each one is allowed to delete
///
/// mtime is the only clock here — the same clock attribution trusts, and
/// the only one that survives a process that died mid-write.
///
/// The AGE pass deletes only what it can PROVE is old. An age that cannot be
/// computed (no metadata, no mtime, or an mtime in the FUTURE — clock skew,
/// a restored backup) means KEEP: an unmeasurable age must never delete
/// history, so a future-dated file is untouchable HERE.
///
/// The CAP pass is deliberately NOT bound by that rule. When the directory is
/// genuinely over the limit it trims by mtime regardless of direction, so it
/// CAN delete a future-dated file — and that is intended, not a violation of
/// the clock-skew rule above: on a full disk this crash is worth more than
/// the history, and the newest crash outranks it. The one file the cap pass
/// may never touch is `keep`.
///
/// # The protection is per-process; the directory is not
///
/// `keep` names ONE file — the calling process's own log — and it is
/// per-process BY CONSTRUCTION: there is nothing else it could name. The
/// directory is not per-process. Both install sites hand the hook
/// `base.join("archimedes")` over the same `dirs` base (`lib.rs`, tag
/// `"supervisor"`; `agent/worker/mod.rs`, tag `"worker"`) — the same directory
/// `setup` resolves for the app data dir — so the **Supervisor and every
/// Worker prune one shared directory**, and `keep` cannot see another
/// process's just-written log sitting in it. So this process's cap pass can
/// still delete a log some other process wrote moments ago. That is a
/// DIFFERENT defect from the one the parameter exists to close: `keep` stops a
/// writer eating its OWN log; nothing here stops a writer eating someone
/// else's.
///
/// Three things must hold at once for that to cost anything:
///
/// - the directory is genuinely OVER the cap, so the cap pass fires at all.
///   [`MAX_CRASH_LOG_FILES`] is 50 and `keep` occupies a slot, so the pass only
///   runs once 50 files survive the age pass beside it — which means at least
///   51 crash-named files in the directory, counting the one just written (a
///   file the age pass deleted, or whose mtime could not be read, is never a
///   survivor and never counts toward the trigger). At or below the limit the
///   cap pass deletes nothing and this hazard does not exist — that is what
///   bounds it: this needs a crash storm, not a crash;
/// - two processes crash close enough together that one is pruning while the
///   other's file is still in the survivor list. Write-then-prune is a few
///   syscalls, so the window is narrow, but nothing closes it;
/// - that fresh file sorts FIRST — which needs a clock skew or an mtime tie,
///   because `sort_by_key` is stable and with equal mtimes has nothing to rank
///   them with, so `read_dir`'s arbitrary order picks the victim. Under an
///   ordinary forward clock a fresh log sorts LAST and outlives the trim.
///
/// If all three land, the other process returns `Some(path)` for a file that no
/// longer exists, and the **Stalled** banner links a log that is not there.
///
/// Accepted, not fixed — deliberately. No code reads these files: the banner
/// hands the path to External Open and nothing parses the contents, so the loss
/// is one unread log inside a storm that has already produced 50 others, which
/// is the least likely place in the app for a single missing file to be
/// noticed. Closing it properly means coordinating across processes, and both
/// routes cost more than the file they would protect: a grace window in which
/// nothing is prunable makes the cap SOFT — a crash loop then transiently
/// exceeds 50, which is a policy decision with its own tests — and a lock or
/// rename-before-prune adds a failure mode (a lock held by a process that died
/// mid-panic) to the one code path that must not gain one.
///
/// Tracked in issue #42, which carries this reasoning and both candidate
/// remedies; the grace window is the one to reach for if it ever bites.
fn prune_crash_logs(dir: &std::path::Path, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let max_age = std::time::Duration::from_secs(MAX_CRASH_LOG_AGE_DAYS * 24 * 3600);
    let mut survivors: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name.starts_with("crash-") && name.ends_with(".log")) {
            continue;
        }
        let path = entry.path();
        // The log this write just produced: not a candidate for either pass.
        if path == keep {
            continue;
        }
        let Ok(mtime) = path.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        // `Err` = an mtime in the future (clock skew) — keep the file.
        if matches!(now.duration_since(mtime), Ok(age) if age > max_age) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        survivors.push((mtime, path));
    }
    // `keep` occupies one slot of the cap, so the history gets the rest.
    let budget = MAX_CRASH_LOG_FILES.saturating_sub(1);
    if survivors.len() > budget {
        survivors.sort_by_key(|(mtime, _)| *mtime);
        let excess = survivors.len() - budget;
        for (_, path) in survivors.into_iter().take(excess) {
            let _ = std::fs::remove_file(&path);
        }
    }
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
    use super::{
        hook_closure, install_panic_hook, write_crash, write_crash_log_from_info,
        MAX_CRASH_LOG_AGE_DAYS, MAX_CRASH_LOG_FILES,
    };
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

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

    /// A temp dir for the crash logs (unique per test), OWNED (#96 task 08) —
    /// removed when the guard drops. It is a body local in every caller, so it
    /// drops at the end of the body, after every assertion and after the
    /// `set_hook(previous)` teardown.
    ///
    /// HONEST SIZING: all 14 mints already ran a `remove_dir_all` on the green
    /// path, so this file's census delta is 0 BEFORE and 0 AFTER — the win is
    /// the panic path (14 dirs that survive a failed assertion today).
    fn temp_dir() -> crate::test_support::ScratchDir {
        crate::test_support::ScratchDir::in_env_temp("crashlog-test-", "dir")
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
        let dir_hook = dir.to_path_buf();
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
        // foreign crash log (another test's panic) is read and REJECTED
        // here by its CONTENT marker, never by its name — so the name
        // filter below is deliberately the loose `crash-` prefix only:
        // matching a NAME shape here would silently stop matching the
        // moment the name changes (this test used to require
        // `ends_with("worker.log")`, which the pid-stamped
        // `crash-<ts>-worker-<pid>.log` does not satisfy).
        let mut path = None;
        for _ in 0..100 {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("crash-") {
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
        std::panic::set_hook(Box::new(hook_closure(
            "worker-capture".into(),
            dir.to_path_buf(),
        )));
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
            Some(dir.path()),
            "the hook wrote into the directory it was handed, not somewhere it resolved itself"
        );
        let content = std::fs::read_to_string(&path).expect("the crash log is readable");
        assert!(
            content.contains(&marker),
            "the panic message is in the log:\n{content}"
        );
        // The tag reaches the FILE NAME (not the content) — it is what
        // says which binary wrote the log. It sits between the timestamp
        // and the writer's pid: `crash-<ts>-<tag>-<pid>.log`.
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            name.ends_with(&format!("-worker-capture-{}.log", std::process::id())),
            "the tag given to `hook_closure` is in the file name: {name}"
        );
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
        assert_eq!(path.parent(), Some(dir.path()));
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            name.starts_with("crash-") && name.contains("-worker-"),
            "the file name is crash-<ts>-<tag>-<pid>.log \
             (`the_crash_log_name_carries_the_writing_pid` pins the pid \
             suffix exactly): {name}"
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
    }

    /// The name carries the WRITING process's pid:
    /// `crash-<ts>-<tag>-<pid>.log`. Two **Worker** processes crashing in
    /// the same millisecond otherwise collide on one filename (the
    /// timestamp is milliseconds and they share a millisecond boundary
    /// often enough to matter), and a name with no owner is why the
    /// Stalled banner's attribution can only guess by recency.
    ///
    /// Exact suffix, not a regex: `-{pid}.log` is the whole contract, and
    /// the pid is this process's — the writer stamps itself.
    #[test]
    fn the_crash_log_name_carries_the_writing_pid() {
        let dir = temp_dir();
        let path = write_crash(&dir, "worker", "marker", "f:1:1").expect("the write succeeds");
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            name.ends_with(&format!("-{}.log", std::process::id())),
            "the file name ends with the writing process's pid: {name}"
        );
        assert!(
            name.starts_with("crash-"),
            "the file name still starts with `crash-` (the prune and the \
             attribution matcher both key on it): {name}"
        );
        assert!(
            name.contains("-worker-"),
            "the tag survives the rename, pinned between the two `-`s: {name}"
        );
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
        install_panic_hook("worker", dir.to_path_buf());
        install_panic_hook("worker", dir.to_path_buf());
        // Put the slot back as it was found: the `Once` above installed
        // our hook over it, and leaving that in place would write a crash
        // log for every panic in the REST of the test process (into the
        // injected temp dir — but still a hook no later test opted into).
        let installed = std::panic::take_hook();
        drop(installed);
        std::panic::set_hook(previous);
    }

    // ------------------------------------------------------------------
    // Retention (Task 3): 30 days and 50 files, pruned AFTER the write.
    //
    // Every test below drives the prune through `write_crash` — never
    // through a hook, never through `write_crash_log_from_info`: a
    // `PanicHookInfo` is unconstructible outside std (`E0451`), so the
    // writer seam is the only reachable door, and it needs neither the
    // hook slot nor the `HOOK` mutex.
    // ------------------------------------------------------------------

    /// One minute and one day, for fixtures whose mtimes are stated in
    /// the unit the retention bounds are stated in.
    const MINUTES: u64 = 60;
    const DAYS: u64 = 24 * 3600;

    /// A crash-log-shaped file with a BACKDATED mtime (`secs_ago` seconds
    /// before now) — the prune reads mtime as its only clock, so this is
    /// how a fixture gets an age. `File::set_modified` is stable since
    /// 1.75; no `filetime` dependency.
    ///
    /// Note the direction: `secs_ago` GROWS with the index in every
    /// fixture below, so the HIGHEST index is the OLDEST file.
    fn aged(dir: &Path, name: &str, secs_ago: u64) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "x").unwrap();
        let old = SystemTime::now() - Duration::from_secs(secs_ago);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(old)
            .unwrap();
        p
    }

    /// The names prune-eligible by pattern, sorted — what the tests count.
    fn crash_log_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("the directory is readable")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("crash-") && n.ends_with(".log"))
            .collect();
        names.sort();
        names
    }

    /// More logs than the cap: the newest `MAX_CRASH_LOG_FILES` survive
    /// (the just-written one included) and the OLDEST are the ones that
    /// die. The fixture spaces mtimes a full minute apart so "oldest" is
    /// defined even on a filesystem with coarse mtime granularity.
    #[test]
    fn prune_caps_at_the_file_limit() {
        let dir = temp_dir();
        for n in 0..MAX_CRASH_LOG_FILES + 1 {
            aged(
                &dir,
                &format!("crash-cap-{n}.log"),
                (n as u64 + 2) * MINUTES,
            );
        }
        let written =
            write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
        let names = crash_log_names(&dir);
        assert_eq!(
            names.len(),
            MAX_CRASH_LOG_FILES,
            "the directory is capped at {MAX_CRASH_LOG_FILES} crash logs, found {names:?}"
        );
        let written_name = written
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            names.contains(&written_name),
            "the log that was just written is never the one the prune deletes: {names:?}"
        );
        let oldest = format!("crash-cap-{}.log", MAX_CRASH_LOG_FILES);
        assert!(
            !names.contains(&oldest),
            "the OLDEST file (the largest index is the oldest) is gone: {names:?}"
        );
        assert!(
            names.contains(&"crash-cap-0.log".to_string()),
            "the newest of the seeded files survives: {names:?}"
        );
    }

    /// Both sides of the age bound: a 31-day-old log dies, a 29-day-old
    /// one lives. Asserting only the dying side would let an off-by-a-day
    /// comparison (or pruning on the file cap alone) pass undetected.
    #[test]
    fn prune_deletes_what_is_older_than_the_age_bound() {
        let dir = temp_dir();
        let ancient = aged(&dir, "crash-ancient.log", 31 * DAYS);
        let recent = aged(&dir, "crash-recent.log", 29 * DAYS);
        for n in 0..3 {
            aged(&dir, &format!("crash-fresh-{n}.log"), n as u64 * MINUTES);
        }
        write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
        assert!(
            !ancient.exists(),
            "a log older than {MAX_CRASH_LOG_AGE_DAYS} days is deleted"
        );
        assert!(
            recent.exists(),
            "a log younger than {MAX_CRASH_LOG_AGE_DAYS} days is kept"
        );
        assert_eq!(
            crash_log_names(&dir).len(),
            5,
            "nothing else was touched (the 29-day file, the 3 fresh ones and the new log)"
        );
    }

    /// The prune spares everything it was never asked about: `debuglog`'s
    /// `supervisor.log` / `supervisor.log.old` land in the SAME directory,
    /// and an unrelated file or a name that only LOOKS like a crash log
    /// (`crash-notalog`, no extension) is not ours either.
    #[test]
    fn prune_spares_files_it_was_never_asked_about() {
        let dir = temp_dir();
        let spared = [
            "supervisor.log",
            "supervisor.log.old",
            "notes.txt",
            "crash-notalog",
        ];
        for name in spared {
            aged(&dir, name, 90 * DAYS);
        }
        write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
        for name in spared {
            assert!(
                dir.join(name).exists(),
                "`{name}` is not a crash log: it survives"
            );
        }
    }

    /// A directory that cannot be created is a `None` and a dir that is
    /// untouched: `create_dir_all` fails with `ENOTDIR` (the same on
    /// Windows) when a path component is an existing regular file.
    ///
    /// This test proves the FAILURE path only. It CANNOT detect prune
    /// ordering: the prune only ever touches `dir`, and `read_dir` on this
    /// non-existent target fails whether it ran before or after the write.
    /// The ordering pin is `a_failing_write_prunes_nothing_even_though_it_could`.
    #[test]
    fn a_failed_create_returns_none_and_touches_nothing() {
        let base = temp_dir();
        let parent = base.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&parent).unwrap();
        aged(&parent, "crash-one.log", MINUTES);
        aged(&parent, "crash-two.log", 2 * MINUTES);
        let blocker = parent.join("blocker");
        std::fs::write(&blocker, "i am a file, not a directory").unwrap();
        let target = blocker.join("nested");

        assert_eq!(
            write_crash(&target, "worker", "marker", "file:1:1"),
            None,
            "a `create_dir_all` failure is a `None`, not a panic"
        );
        assert!(
            !target.exists(),
            "the un-creatable nested path was not half-created"
        );
        assert!(parent.join("crash-one.log").exists());
        assert!(parent.join("crash-two.log").exists());
    }

    /// THE ORDERING PIN. The prune runs AFTER a successful write, never
    /// before, so a crash log is never paid for with the history: a write
    /// that FAILS must delete nothing.
    ///
    /// Deliberately NOT a read-only directory: deleting a file needs write
    /// permission on the DIRECTORY, so with `set_permissions(0o500)` the
    /// prune would delete nothing there either and this test would stay
    /// green with the bug present. The failure is instead provoked by a
    /// `tag` long enough that the composed name exceeds the filesystem's
    /// name limit: `create_dir_all(dir)` succeeds (it creates only the
    /// directory) and `fs::write` fails (`ENAMETOOLONG` on Linux/macOS,
    /// `ERROR_INVALID_NAME` on Windows) in a directory prune COULD have
    /// written to. The errno is not asserted — it is platform-specific.
    ///
    /// Measured: with the prune moved BEFORE the write this test goes RED
    /// (60 files become 50); with it after, green.
    #[test]
    fn a_failing_write_prunes_nothing_even_though_it_could() {
        let dir = temp_dir();
        // A writable dir (`temp_dir()` on every OS) with MORE than the cap
        // of aged files, so an early prune has something it would delete.
        for n in 0..MAX_CRASH_LOG_FILES + 10 {
            aged(
                &dir,
                &format!("crash-many-{n}.log"),
                (n as u64 + 2) * MINUTES,
            );
        }
        let before = crash_log_names(&dir);
        assert_eq!(before.len(), MAX_CRASH_LOG_FILES + 10);

        let long_tag = "t".repeat(400);
        assert_eq!(
            write_crash(&dir, &long_tag, "marker", "file:1:1"),
            None,
            "a name over the filesystem's limit is a `None`, not a panic"
        );
        assert_eq!(
            crash_log_names(&dir),
            before,
            "a write that failed deleted no crash log — the prune runs only after success"
        );
    }

    /// The prune pattern is deliberately WIDER than the attribution
    /// matcher: the real names carry a `-<pid>` suffix (Task 5), which the
    /// old `ends_with("-worker.log")` attribution shape does NOT match —
    /// and exactly the newest, most deletable files are the ones it would
    /// spare. Hand-written names here; Task 5 lands the real format.
    #[test]
    fn prune_matches_the_pid_stamped_name() {
        let dir = temp_dir();
        let pid = std::process::id();
        for n in 0..MAX_CRASH_LOG_FILES + 10 {
            aged(
                &dir,
                &format!("crash-{n}-worker-{pid}.log"),
                (n as u64 + 2) * MINUTES,
            );
        }
        let written =
            write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
        let names = crash_log_names(&dir);
        assert_eq!(
            names.len(),
            MAX_CRASH_LOG_FILES,
            "pid-stamped names are pruned too, found {names:?}"
        );
        assert!(written.exists(), "the just-written log survives");
    }

    /// A file whose mtime is in the FUTURE (clock skew, a restored backup)
    /// has an UNMEASURABLE age, and an unmeasurable age means KEEP. This
    /// is the `now.duration_since(mtime)` `Err` arm: without it, "we never
    /// delete what we cannot date" is an untested claim.
    #[test]
    fn a_future_mtime_is_never_deleted() {
        let dir = temp_dir();
        let ancient = aged(&dir, "crash-ancient.log", 31 * DAYS);
        let future = dir.join("crash-future.log");
        std::fs::write(&future, "x").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&future)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(DAYS))
            .unwrap();

        write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
        assert!(
            future.exists(),
            "a future-dated mtime is clock skew, not freshness — it is never deleted"
        );
        assert!(!ancient.exists(), "the genuinely old file is still deleted");
    }

    /// A future-dated crash-log-shaped file, one that is
    /// `mins_behind_the_hour` minutes UNDER an hour from now: every file
    /// made by this helper is future-dated (so the AGE pass must spare it),
    /// while the seeds stay MUTUALLY ORDERED — "oldest of the lot" keeps a
    /// defined answer, which the CAP pass needs. A fixture whose futures were
    /// all identical would make the deletion order `read_dir`'s choice rather
    /// than the code's, and this helper is deliberately not that.
    fn future_aged(dir: &Path, name: &str, mins_behind_the_hour: u64) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "x").unwrap();
        let ahead = SystemTime::now() + Duration::from_secs(DAYS)
            - Duration::from_secs(mins_behind_the_hour * MINUTES);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(ahead)
            .unwrap();
        p
    }

    /// THE PROTECTED-FILE RULE, case 1 (the reviewer's case): a directory
    /// already AT the cap whose every file is future-dated. The AGE pass
    /// spares all of them (a future mtime is clock skew, never age), so the
    /// CAP pass is the only thing with work to do — and the newest crash
    /// outranks history, so it trims ONE of the seeds and keeps the log it
    /// just wrote.
    ///
    /// Before the fix the just-written file was itself a candidate: its mtime
    /// is the only PAST-dated one in the directory, so `sort_by_key(mtime)`
    /// put it at the FRONT and `take(excess)` deleted it. `write_crash` then
    /// returned `Some(path)` for a path that no longer exists — the Stalled
    /// banner links that path to External Open, so the user gets a dead link
    /// and the crash is gone. Clock rollback is how you meet this in the wild;
    /// a restored backup or a guest VM with a drifting clock does it too.
    #[test]
    fn a_full_directory_of_future_dated_logs_never_eats_the_new_crash() {
        let dir = temp_dir();
        for n in 0..MAX_CRASH_LOG_FILES {
            future_aged(&dir, &format!("crash-future-{n}.log"), n as u64);
        }
        assert_eq!(crash_log_names(&dir).len(), MAX_CRASH_LOG_FILES);

        let written =
            write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
        assert!(
            written.exists(),
            "write_crash returned {} but the prune deleted it — a returned path \
             that does not exist is the one outcome worse than an unbounded \
             directory, because the Stalled banner links it (found {:#?})",
            written.display(),
            crash_log_names(&dir)
        );
        let names = crash_log_names(&dir);
        assert_eq!(
            names.len(),
            MAX_CRASH_LOG_FILES,
            "the just-written log COUNTS toward the cap — the directory holds \
             {MAX_CRASH_LOG_FILES} logs, one of them the new one"
        );
        let written_name = written
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            names.contains(&written_name),
            "the new log is one of the {MAX_CRASH_LOG_FILES}: {names:?}"
        );
        // The cap trimmed exactly one of the FUTURES, and it picked the oldest
        // of them (the largest offset below the hour), never the newest.
        assert!(
            !names.contains(&format!("crash-future-{}.log", MAX_CRASH_LOG_FILES - 1)),
            "the OLDEST of the future-dated files is the one the cap trimmed: {names:?}"
        );
        assert!(
            names.contains(&"crash-future-0.log".to_string()),
            "the newest of the future-dated files is spared: {names:?}"
        );
    }

    /// THE PROTECTED-FILE RULE, case 2 (the likelier one): the whole full
    /// directory shares ONE mtime, which is what a crash loop actually
    /// looks like — 50 logs written inside one mtime tick, or any coarse
    /// filesystem (FAT/exFAT/NFS stamp in milliseconds or seconds, not
    /// nanoseconds). With every seed tied, `sort_by_key(mtime)` has NOTHING
    /// to rank them with: `sort_by_key` is stable, so the order the cap pass
    /// deletes in is `read_dir`'s order — the directory's accident, not a
    /// decision. The one file the pass can still rank is the just-written
    /// log, and it ranks LOWEST (its stamp is the only one in the past), so
    /// the accident lands on it. No clock jump is needed for this shape.
    ///
    /// ⚠ What this test CAN and CANNOT reproduce on this machine, stated
    /// plainly: the pure 51-way tie (the new file's own stamp tied with the
    /// seeds') needs a filesystem whose stamp quantum is wider than the ~5 ms
    /// `write_crash` spends capturing a backtrace. Measured here: tmpfs stamps
    /// in ~200 µs–1 ms quanta, so the new file always lands a few ticks LATE
    /// and the tie among the 51 never forms locally. The tie among the 50
    /// seeds is exact and deterministic, and it is the tie that removes the
    /// prune's ability to choose — which is the hazard. The bug it drives is
    /// the same one, and it fires 20 times in 20 runs against the unfixed
    /// code, so this test cannot pass by accident.
    #[test]
    fn equal_mtimes_never_decide_which_crash_survives() {
        let dir = temp_dir();
        // ONE read of the clock for ALL the seeds — a per-file
        // `SystemTime::now()` would give 50 different stamps and the tie
        // (the whole point) would silently not exist. Future-dated so the AGE
        // pass is provably innocent and only the CAP pass can delete anything.
        let shared = SystemTime::now() + Duration::from_secs(MINUTES);
        for round in 0..3 {
            for n in 0..MAX_CRASH_LOG_FILES {
                let p = dir.join(format!("crash-tie-{round}-{n}.log"));
                std::fs::write(&p, "x").unwrap();
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&p)
                    .unwrap()
                    .set_modified(shared)
                    .unwrap();
            }
            assert_eq!(crash_log_names(&dir).len(), MAX_CRASH_LOG_FILES);

            let written =
                write_crash(&dir, "worker", "marker", "file:1:1").expect("the write succeeds");
            assert!(
                written.exists(),
                "round {round}: write_crash returned {} but the prune deleted it. \
                 Every other file in the directory shares ONE mtime, so \
                 `sort_by_key(mtime)` cannot rank them and `read_dir` order picks \
                 the victim — the log that just happened must never be in that \
                 draw. Directory now holds {:#?}",
                written.display(),
                crash_log_names(&dir)
            );
            let names = crash_log_names(&dir);
            assert_eq!(
                names.len(),
                MAX_CRASH_LOG_FILES,
                "round {round}: the tied seeds are trimmed to make room — the new \
                 log counts toward the cap instead of overflowing it: {names:?}"
            );
            // The trim came out of the tied group (49 seeds + the new log),
            // so the cap held WITHOUT spending the log that just happened.
            let written_name = written
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            assert!(
                names.contains(&written_name),
                "round {round}: the new log is one of the {MAX_CRASH_LOG_FILES} \
                 survivors, not the file that paid for itself: {names:?}"
            );
            let seeds_left = names
                .iter()
                .filter(|n| n.starts_with(&format!("crash-tie-{round}-")))
                .count();
            assert_eq!(
                seeds_left,
                MAX_CRASH_LOG_FILES - 1,
                "round {round}: exactly ONE tied seed paid for the new log: {names:?}"
            );
            let _ = std::fs::remove_file(&written);
            for name in crash_log_names(&dir) {
                let _ = std::fs::remove_file(dir.join(name));
            }
        }
    }
}
