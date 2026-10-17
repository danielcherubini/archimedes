//! The updater IPC seam (ADR 0053): three commands, ONE event, no capability entry.
//!
//! The renderer never holds updater or restart rights. It gets `check_update`,
//! `install_update`, `relaunch_app` and the `update://progress` event, and the
//! plugin behind them is registered in Rust and called from Rust — the same
//! arrangement as `tauri_plugin_notification` (see its `Cargo.toml` comment): the
//! ACL gates the webview→Rust boundary only, so a Rust-side `check()` needs no
//! permission entry, and `AppHandle::restart()` is on Tauri itself, so
//! `tauri-plugin-process` — and `allow-restart` with it — never enters the graph.
//! The AppImage relaunch keeps that property too: where it owns the spawn it
//! builds a plain `std::process::Command` in Rust, so no `shell:allow-*` and no
//! ACL entry appears anywhere near it.
//! `capabilities/default.json` is not touched by this module and must stay that way.
//!
//! Three decisions that the official `@tauri-apps/plugin-updater` would have made
//! for us now live here, because each is somewhere a naive port is wrong:
//!
//! * **The three-way check result.** [`CheckOutcome::UpToDate`] is an ANSWER
//!   ("the endpoint said there is nothing newer"); a failing check is a typed
//!   `Err` string and is NOT the same state. A 404 on `latest.json` surfaces as
//!   [`tauri_plugin_updater::Error::ReleaseNotFound`], never as `Ok(None)`, and
//!   merging the two is how a broken update endpoint becomes "you are up to date"
//!   for every installed client. Only the 204 — and a manifest announcing nothing
//!   newer — reaches `UpToDate`.
//! * **Coalescing.** The plugin calls `on_chunk` once per TCP chunk with no
//!   rate-limiting, so forwarding it verbatim turns a ~124 MB AppImage into
//!   thousands of IPC events. [`ProgressThrottle`] owns both the running byte
//!   total (the plugin hands per-chunk INCREMENTS, so someone has to sum them) and
//!   the emit decision.
//! * **The error strings.** [`map_check_error`] turns the plugin's
//!   `#[non_exhaustive]` enum into this repo's `kebab-case:detail` codes, so the
//!   renderer branches on a code instead of on English prose.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::Error as UpdaterError;

use crate::agent::hostenv;

// `Manager` is the trait carrying `env()` and `try_state()`, and BOTH are read
// only on the Linux (AppImage) path — `restart()` and `cleanup_before_exit()`
// are inherent methods (`shared_app_impl!`, `app.rs:1251`). Ungated it is
// `unused_imports` on the macOS/Windows CI rows, where `-D warnings` makes that
// an error.
#[cfg(target_os = "linux")]
use tauri::Manager;

/// What `check_update` tells the renderer: current, or here is what is newer.
///
/// `Err` is the third possibility and it is not carried here — "the check could
/// not complete" is an `Err(String)` from [`map_check_error`], which keeps
/// `CheckOutcome` free of a `Failed { … }` arm the renderer could mistake for an
/// answer. Tagged, so the discriminating field is on the wire rather than
/// inferred from which optional fields happen to be filled.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum CheckOutcome {
    /// The endpoint answered and there is nothing newer. Confirmed, not unknown.
    UpToDate,
    /// A newer release exists. `notes` is the release body; `date` is the
    /// publish date rendered for a human — the plugin carries it as
    /// `Option<OffsetDateTime>`, so the `to_string()` happens HERE: the renderer
    /// has no way to format that type and would otherwise get an object.
    Available {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
}

/// The plugin's `Error` as the repo's typed refusal code.
///
/// The arms below name only variants the RESOLVED plugin (2.14) declares; the
/// `_` fallback is mandatory rather than stylistic, because the enum is
/// `#[non_exhaustive]` and this crate is not its crate — it is also what makes a
/// future plugin bump that ADDS a variant fall through to the Display instead of
/// failing to compile here.
///
/// `signature-mismatch` is SECURITY-relevant: it means the signature did not bind
/// the version the endpoint announced (or bound no version at all while
/// `requireSignedVersion` is on) — a tamper or republish signal. It must never be
/// folded into an `install-…` code, because "install failed, try again" is exactly
/// the wrong advice for it.
pub fn map_check_error(e: &UpdaterError) -> String {
    // Every arm names a variant the RESOLVED plugin (2.14) declares; the `_`
    // fallback is load-bearing rather than defensive style because the enum is
    // `#[non_exhaustive]` and this crate is not its crate.
    match e {
        UpdaterError::ReleaseNotFound => "release-not-found".to_string(),
        UpdaterError::EmptyEndpoints => "endpoints-not-configured".to_string(),
        // The status text lives INSIDE the plugin's string (it is formatted from
        // the response status at `updater.rs:868-872`); there is no status-code
        // field on this enum, so the detail is forwarded rather than parsed.
        UpdaterError::Network(s) => format!("network:{s}"),
        UpdaterError::Reqwest(err) => format!("network:{err}"),
        UpdaterError::TargetNotFound(t) => format!("invalid-target:{t}"),
        UpdaterError::TargetsNotFound(v) => format!("invalid-target:{}", v.join(",")),
        // One code for both: the renderer cannot act on the difference, and the
        // plugin's Display enumerates four arch names nobody will match against.
        UpdaterError::UnsupportedOs | UpdaterError::UnsupportedArch => {
            "unsupported-platform".to_string()
        }
        // SECURITY: kept distinct from `install-failed` on purpose — see the doc.
        UpdaterError::SignedVersionMismatch { .. } | UpdaterError::MissingSignedVersion => {
            "signature-mismatch".to_string()
        }
        UpdaterError::InvalidUpdaterFormat => "invalid-update-format".to_string(),
        UpdaterError::AuthenticationFailed => "authentication-failed".to_string(),
        UpdaterError::DebInstallFailed | UpdaterError::PackageInstallFailed => {
            "install-failed".to_string()
        }
        UpdaterError::Io(err) => format!("io:{err}"),
        // The rest of the (open) enum — `Semver`, `Serialization`, `UrlParse`,
        // `Minisign`, `Base64`, `SignatureUtf8`, `Http`, `InvalidHeader*`,
        // `FormatDate`, `InsecureTransportProtocol`, `Tauri`, `Extract`,
        // `TempDir*`, `PreviousAppNotRestored`, `BinaryNotFoundInArchive` — keeps
        // its own Display, prefixed so a reader can still tell which layer the
        // string came from.
        other => format!("update-error:{other}"),
    }
}

/// Rate-limits the plugin's per-chunk callback into a progress bar's worth of
/// events, and owns the running total the bar displays.
///
/// ONE accumulator, on purpose: the plugin reports `chunk.len()` per TCP chunk,
/// which is an increment, and the event payload wants the sum. Splitting that
/// across the caller and the throttle would give two numbers that can disagree, so
/// [`ProgressThrottle::should_emit`] folds the chunk in itself and answers about
/// the state it just updated. It is `#[must_use]` for the same reason — calling it
/// for its side effect alone (or ignoring the answer) silently drops or duplicates
/// frames.
pub struct ProgressThrottle {
    min_interval: Duration,
    min_ratio: f64,
    downloaded: u64,
    emitted_bytes: u64,
    last_emit: Option<Instant>,
}

impl ProgressThrottle {
    /// The defaults the command uses: at most ten frames a second, and never for
    /// less than one percent of a known-length download.
    pub const DEFAULT_MIN_INTERVAL: Duration = Duration::from_millis(100);
    pub const DEFAULT_MIN_RATIO: f64 = 0.01;

    pub fn new(min_interval: Duration, min_ratio: f64) -> Self {
        Self {
            min_interval,
            min_ratio,
            downloaded: 0,
            emitted_bytes: 0,
            last_emit: None,
        }
    }

    /// Folds `chunk_bytes` into the running total and says whether THIS chunk
    /// earns an event.
    ///
    /// Emit rules, in the order they are worth reading: the first frame ever (the
    /// bar must appear immediately, not after 100 ms of nothing); the elapsed time
    /// since the last EMITTED frame has reached `min_interval` (measured from the
    /// frame, not from the previous chunk — otherwise a flood would keep resetting
    /// the clock and emit nothing at all); or the running total has gained at least
    /// `min_ratio` × `content_length` since the last emitted frame's total, so a
    /// slow-but-large download still moves the bar between ticks. With no
    /// `content_length` there is no denominator to compare against, so the ratio
    /// rule cannot fire and the interval is the only gate.
    #[must_use]
    pub fn should_emit(
        &mut self,
        now: Instant,
        chunk_bytes: usize,
        content_length: Option<u64>,
    ) -> bool {
        // One accumulator, folded in here — see the type's doc.
        self.downloaded += chunk_bytes as u64;

        // First frame ever: the bar appears on the first chunk, not 100 ms later.
        let Some(last_emit) = self.last_emit else {
            self.commit(now);
            return true;
        };

        // Measured from the last EMITTED frame, never from the previous chunk — a
        // stream faster than the interval would otherwise reset the clock on every
        // chunk and emit nothing until it slowed down. `checked_duration_since`
        // guards a `now` that predates the last frame (only the tests can fabricate
        // that, by feeding the readings out of order) by reading it as "no time has
        // passed"; the plain `duration_since` panics on that ordering.
        let since_frame = now
            .checked_duration_since(last_emit)
            .unwrap_or(Duration::ZERO)
            .ge(&self.min_interval);

        // The ratio floor needs a denominator; a chunked/gzipped response reports
        // no `Content-Length` at all, so the interval is the only gate there. A
        // threshold that floors to zero (a lying or empty `Content-Length`) is
        // treated as "no floor" rather than "emit per chunk", which is the failure
        // mode this struct exists to prevent.
        let crossed = content_length.is_some_and(|total| {
            let threshold = (total as f64 * self.min_ratio) as u64;
            threshold > 0 && self.downloaded.saturating_sub(self.emitted_bytes) >= threshold
        });

        if since_frame || crossed {
            self.commit(now);
            return true;
        }
        false
    }

    /// Records a frame: its instant (the interval's reference point) and the total
    /// it showed (the ratio's reference point).
    fn commit(&mut self, now: Instant) {
        self.last_emit = Some(now);
        self.emitted_bytes = self.downloaded;
    }

    /// The running total — what the throttle counted, not what it emitted.
    #[must_use]
    pub fn downloaded(&self) -> u64 {
        self.downloaded
    }
}

/// The `update://progress` frame.
///
/// `total` is the download's `Content-Length` when the server reported one and
/// `None` otherwise (a chunked or gzipped response reports nothing) — so the
/// renderer shows a bar when it can and a byte counter when it cannot, rather than
/// being handed a `0` it has to interpret as "unknown".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// The single event name the renderer subscribes to during an install.
pub const PROGRESS_EVENT: &str = "update://progress";

/// The error a second concurrent install gets back — its own code, because the
/// renderer's advice for it is "the other one is still running", not "retry".
const INSTALL_IN_PROGRESS: &str = "install-in-progress";

/// The process-wide "one install at a time" flag, and its RAII claim.
///
/// The claim lives HERE rather than in the renderer because the renderer cannot
/// own it: the Settings section that starts an install UNMOUNTS the moment the
/// user navigates away, and its click-guard goes with it, so a second visit
/// would otherwise happily start a second `download_and_install` — two writers
/// into the same package state, on Linux two `pkexec` transactions. A
/// module-level `AtomicBool` outlives every component and every command future,
/// which makes it the only place this invariant can actually live.
///
/// The release is RAII (`Drop`), never an explicit call, so every early `?` and
/// every `map_err` on the way out gives the slot back. Where that matters
/// differs by platform, and the difference is why the drop is not redundant:
/// * **macOS / Linux** — `download_and_install` RETURNS, so `Drop` fires on the
///   command future's completion (success, or a mapped error) and a later click
///   can retry. A raw `store(true)` with no drop would strand the app in
///   `"install-in-progress"` forever after one failed install.
/// * **Windows** — moot by construction: `install_inner` launches the NSIS
///   installer and calls `std::process::exit(0)` inside the `await` below, so
///   neither the future nor the process reaches the drop. The process dying IS
///   the release; holding the flag until then is exactly the semantics wanted.
///
/// Ordering is the default `SeqCst`: this gates a one-shot expensive operation,
/// not a hot loop, and `compare_exchange`'s failure ordering matters only in
/// that it must not miss a release that happened-before it.
#[derive(Debug)]
pub struct InstallClaim(&'static std::sync::atomic::AtomicBool);

impl InstallClaim {
    /// Claims `flag`, or `None` when someone already holds it.
    ///
    /// Takes the flag rather than reaching for the static, so the guard is
    /// provable WITHOUT a tauri `AppHandle`: the unit test hands it a flag of its
    /// own and still exercises the real `Drop`. The `&'static` is what the `Drop`
    /// needs to write the flag back after the guard has moved and outlived every
    /// borrow — the production caller passes the module's own static.
    #[must_use]
    pub fn try_claim(flag: &'static std::sync::atomic::AtomicBool) -> Option<Self> {
        flag.compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        // `Err(existing)` here can only be `true` — that is the state we compared
        // against and the only one `store` ever writes.
        .ok()
        .map(|_| Self(flag))
    }
}

impl Drop for InstallClaim {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The flag [`InstallClaim`] claims. Private to this module: nothing outside it
/// may set or clear the updater's install slot.
static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Claim the process-wide install slot for as long as the returned guard lives.
///
/// The command calls this before it touches the network; the unit tests exercise
/// [`InstallClaim::try_claim`] against their OWN `AtomicBool` instead, which is
/// what keeps the guard provable without an `AppHandle`.
fn claim_install_slot() -> Option<InstallClaim> {
    InstallClaim::try_claim(&INSTALLING)
}

/// Ask the configured endpoint whether there is anything newer.
///
/// Thin by design: the plugin does the request, the version comparison and the
/// target lookup, and this decides only how each of its three outcomes is spelled
/// on the wire. `Ok(None)` — the 204, or a manifest with nothing newer — is the
/// ONLY path to `UpToDate`; everything the plugin could not complete becomes the
/// typed string from [`map_check_error`], because "couldn't ask" and "was told
/// no" are different things to show a person.
///
/// The `Err` arm is also where a wrong endpoint announces itself: a repository
/// with no release yet 404s `latest.json`, and that arrives as
/// `"release-not-found"` rather than as an empty result.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<CheckOutcome, String> {
    use tauri_plugin_updater::UpdaterExt;

    // `updater()` is where a MISSING `plugins.updater.endpoints` surfaces — the
    // plugin builds fine and `UpdaterBuilder::build` refuses with
    // `EmptyEndpoints`, which is why its error goes through the same mapping
    // rather than being unwrapped.
    match app
        .updater()
        .map_err(|e| map_check_error(&e))?
        .check()
        .await
    {
        Ok(None) => Ok(CheckOutcome::UpToDate),
        Ok(Some(update)) => Ok(CheckOutcome::Available {
            version: update.version,
            notes: update.body,
            // `Option<OffsetDateTime>` → the RFC 3339 string the plugin would
            // otherwise serialize as an object; the renderer has no `time` type.
            date: update.date.map(|d| d.to_string()),
        }),
        Err(e) => Err(map_check_error(&e)),
    }
}

/// Download the newest release and install it, reporting progress as it goes.
///
/// It re-`check`s rather than trusting anything the renderer holds, because ADR
/// 0053 gives the webview no `Update` object to hold: there is nothing to cache,
/// nothing to stale, and no resource for the renderer to forget to `close()`. A
/// re-check that finds nothing is `"no-update-available"` — reachable whenever the
/// user clicks twice, or a `check_update` has aged into a withdrawn release.
///
/// It also claims the process-wide slot from [`InstallClaim`] for as long as the
/// download runs, so a SECOND install — started after the Settings section
/// unmounted and remounted, which is exactly what the "Restart to finish" wait
/// invites — comes back as the typed `"install-in-progress"` instead of racing
/// the first one into the same package state.
///
/// **On Windows this future never resolves.** `install_inner` launches the NSIS
/// installer and calls `std::process::exit(0)` once `ShellExecuteW` succeeds
/// (`updater.rs:1050`), so the `Ok(())`/`Err(…)` arm below is not reached on that
/// platform on the happy path — the terminal `update://progress` frame's only
/// observable consumer is macOS/Linux, where the install returns and the user then
/// has to relaunch. The consequence for the UI is the load-bearing part: it must
/// say "this window is about to close" BEFORE awaiting, never after.
///
/// The throttle lives behind a lock for one reason and not for concurrency:
/// `download_and_install` takes two callbacks and `on_download_finish` is a
/// `FnOnce()` with no arguments, so it cannot reach the accumulator unless the
/// same `ProgressThrottle` is shared — still ONE total, just reachable twice.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    // Claimed BEFORE the re-check, so a second click cannot even start a
    // parallel `check()`; the guard releases on drop (see its doc — on Windows
    // the process exits below and the drop is moot).
    let _install_claim = claim_install_slot().ok_or(INSTALL_IN_PROGRESS.to_string())?;

    let update = app
        .updater()
        .map_err(|e| map_check_error(&e))?
        .check()
        .await
        .map_err(|e| map_check_error(&e))?
        .ok_or("no-update-available")?;

    let throttle = Arc::new(Mutex::new(ProgressThrottle::new(
        ProgressThrottle::DEFAULT_MIN_INTERVAL,
        ProgressThrottle::DEFAULT_MIN_RATIO,
    )));
    let progress_app = app.clone();
    let chunk_throttle = throttle.clone();

    update
        .download_and_install(
            move |chunk_bytes, content_length| {
                let mut throttle = chunk_throttle
                    .lock()
                    .expect("the progress throttle is never poisoned");
                if throttle.should_emit(Instant::now(), chunk_bytes, content_length) {
                    let payload = ProgressPayload {
                        downloaded: throttle.downloaded(),
                        total: content_length,
                    };
                    // A dropped frame is never a failed update: the emit is
                    // presentation, the download is the thing.
                    let _ = progress_app.emit(PROGRESS_EVENT, &payload);
                }
            },
            || {
                // The terminal frame: the bar reads full whether or not the last
                // tick happened to land on the last chunk. `total: Some(..)` rather
                // than the server's, because a bar that showed `x / None` all the
                // way should not suddenly invent a denominator at 100%.
                let downloaded = throttle
                    .lock()
                    .expect("the progress throttle is never poisoned")
                    .downloaded();
                let _ = app.emit(
                    PROGRESS_EVENT,
                    &ProgressPayload {
                        downloaded,
                        total: Some(downloaded),
                    },
                );
            },
        )
        .await
        .map_err(|e| map_check_error(&e))
}

/// What to exec to restart into the current build, and with which args.
///
/// `appimage`: `Manager::env().appimage` (Linux-only `Option<OsString>`).
/// `exe`:      `std::env::current_exe()`.  `args`: `std::env::args_os()`.
///
/// TOTAL — it runs on the relaunch path, where a panic is unrecoverable: the
/// blocking command handler dies, nothing is spawned, and the app quits with no
/// successor. Hence `args.get(1..)` rather than `args[1..]` (which panics on an
/// empty slice) and no `expect` anywhere. `std::env::args_os()` always yields an
/// argv0 in production, but a pure resolver cannot assume it.
///
/// The path is `$APPIMAGE` when there is one: inside a bundle the exe is an
/// unpacked AppDir on a FUSE mount that is unmounted when this process exits,
/// and the runtime + `AppRun` are what set the bundle up. Same answer as
/// `tauri::process::current_binary`, with ONE deliberate difference — Tauri
/// takes any `Some`, so `APPIMAGE=""` makes it spawn `""`, whose failed spawn it
/// merely logs (`process.rs:83-85`) before `exit(0)` (`process.rs:88`): the
/// updater would kill the app and restart nothing. An empty value counts as
/// absent here, so the user gets a running app either way.
///
/// The `allow` is for the macOS/Windows CI rows: its only caller is
/// Linux-only, so the plain `--lib` build there sees an unused function (its
/// tests run on every target, which is why it is not simply `cfg`'d out).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn restart_target(
    appimage: Option<&std::ffi::OsStr>,
    exe: &std::path::Path,
    args: &[std::ffi::OsString],
) -> (std::path::PathBuf, Vec<std::ffi::OsString>) {
    let path = match appimage {
        Some(appimage) if !appimage.is_empty() => std::path::PathBuf::from(appimage),
        _ => exe.to_path_buf(),
    };
    (path, args.get(1..).map(<[_]>::to_vec).unwrap_or_default())
}

/// The env decision for the relaunch: the patch to hand the owned spawn, or
/// EMPTY, which means "hand back to `app.restart()`".
///
/// Calls [`hostenv::scrub`] DIRECTLY rather than going through
/// [`for_child`](crate::agent::hostenv::for_child), and the reason is
/// testability, not taste: `for_child()` reads the PROCESS env and
/// `current_exe()`, so under `cargo test` it returns an empty patch on every
/// host (its gate needs this exe under `$APPDIR`, and under cargo it is
/// `target/debug/deps/<hash>`) — the entire AppImage branch of this file would
/// be untestable through it. Here every input is an argument, so a test can
/// fabricate a bundle (`hostenv::fixtures`) and the gate is genuinely exercised.
///
/// The gate is `scrub`'s own — the one every other spawn site uses — so a
/// `.deb`, an `.rpm` and a `cargo run` host get the empty patch and their
/// restart stays byte-identical to the pre-task behaviour.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn relaunch_patch(
    inherited: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    appdir: Option<&std::path::Path>,
    exe: &std::path::Path,
) -> hostenv::EnvPatch {
    hostenv::scrub(inherited, appdir, exe)
}

/// The owned relaunch — `(exec target, args, patch)` — or `None` to hand back
/// to Tauri.
///
/// Linux-only, and not only for `Env`'s `cfg`'d fields: off Linux there is no
/// bundle to re-enter and [`hostenv::scrub`] is defined to find nothing, so the
/// owned path does not exist there at all.
#[cfg(target_os = "linux")]
fn owned_relaunch(
    app: &AppHandle,
) -> Option<(
    std::path::PathBuf,
    Vec<std::ffi::OsString>,
    hostenv::EnvPatch,
)> {
    // `Env` is managed during `build()` (`app.rs:2569-2570`), so this cannot
    // fail from a command; it is a CLONE, and `args_os` in it is exactly the
    // `std::env::args_os()` that `process::restart` would have used.
    let env = app.env();
    // A failing `current_exe()` means we cannot know whether we are inside a
    // mount, and `/` is the root `scrub`'s gate rejects (no `Component::Normal`)
    // — so the unknown fails toward `app.restart()`, never toward rewriting a
    // user's `PATH`.
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("/"));
    let patch = relaunch_patch(
        std::env::vars_os().collect(),
        env.appdir.as_deref().map(std::path::Path::new),
        &exe,
    );
    if patch.is_empty() {
        return None;
    }
    let (path, args) = restart_target(env.appimage.as_deref(), &exe, &env.args_os);
    Some((path, args, patch))
}

/// The owned spawn, with the teardown `App::run` would have performed. Never
/// returns: `std::process::exit(0)` is the last statement whatever the spawn
/// did, mirroring `tauri::process::restart` (`process.rs:74-89`).
///
/// The spawn uses [`crate::agent::childproc`]`::command_std`, the owner of the
/// Windows child-console window policy (`CREATE_NO_WINDOW`).
///
/// ⚠ Only because this function is Linux-gated: on Windows and macOS the
/// relaunch is the `app.restart()` fallthrough below, whose spawn is Tauri's own
/// unflagged `Command::new(path)…spawn()` (`tauri-2.12.2/src/process.rs:83`) —
/// outside that seam, and outside the census that guards it.
#[cfg(target_os = "linux")]
fn relaunch_through_the_mount(
    app: &AppHandle,
    path: &std::path::Path,
    args: &[std::ffi::OsString],
    patch: &hostenv::EnvPatch,
) -> ! {
    // (1) This app's OWN `RunEvent::Exit` hook (`src/lib.rs:378-389`): reap the
    //     Workers — the graceful `close` + grace + `kill`. Skip it and every
    //     Worker is SIGKILLed on each update-restart instead of reaped. The
    //     fresh current-thread runtime is the same one that hook builds, for the
    //     same reason: this is not a tokio context.
    if let Some(wm) =
        app.try_state::<std::sync::Arc<crate::agent::worker::manager::WorkerManager>>()
    {
        let wm = wm.inner().clone();
        // NOT the `.expect` that hook uses. There a failed runtime costs the
        // teardown; here it would cost the RESTART (a panic in this blocking
        // command kills the handler, nothing is spawned, no successor), so the
        // failure is logged and the relaunch proceeds — the OS reaps the Workers
        // when their pipes close anyway.
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(wm.reap_all()),
            Err(e) => {
                crate::agent::debuglog::log(&format!("relaunch: no runtime to reap workers: {e}"))
            }
        }
    }

    // (2) The `tauri-plugin-window-state` `RunEvent::Exit` handler
    //     (`tauri-plugin-window-state-2.4.0/src/lib.rs:503`): the geometry save.
    //     `StateFlags::all()` is what the plugin is registered with
    //     (`Builder::default()`, `src/lib.rs:280`), so this is the same save and
    //     not a wider one. Its `Result` is ignored on purpose: a state file that
    //     cannot be written costs the user a geometry, and the process is
    //     exiting whatever we do with it here.
    use tauri_plugin_window_state::AppHandleExt as _;
    let _ = app.save_window_state(tauri_plugin_window_state::StateFlags::all());

    // (3) `App::run`'s own step, which it runs AFTER the callback: the tray
    //     icons and the resource tables. Last of the three, and after it no
    //     Tauri API may be used at all (its documented contract) — which is why
    //     what follows is a std `Command` and not anything Tauri-adjacent.
    app.cleanup_before_exit();

    // (4) The spawn Tauri would have done — target, `args_os[1..]`, `spawn()`,
    //     `exit(0)` — plus the env patch Tauri does not apply, which is the
    //     whole point of doing it here.
    let mut cmd = crate::agent::childproc::command_std(path);
    cmd.args(args);
    patch.apply_std(&mut cmd);
    if let Err(e) = cmd.spawn() {
        // The repo's own logger, NOT `log::error!`: `log` is not a dependency of
        // this crate and `tauri` 2.12.2 does not re-export it, so the upstream
        // call is E0433 here — and adding the dep would move `Cargo.lock`, which
        // this task's own acceptance criteria forbid. Same call the sibling
        // spawn site makes (`worker/client.rs`, `debuglog::log("worker spawn…")`).
        crate::agent::debuglog::log(&format!(
            "relaunch: could not spawn {}: {e}",
            path.display()
        ));
    }
    std::process::exit(0)
}

/// Restart into the freshly installed build.
///
/// Synchronous, and it does not return: `AppHandle::restart()` is `-> !`
/// (Tauri 2.12.2, `app.rs:606`), which is precisely why `tauri-plugin-process` and
/// its `allow-restart` entry are absent from this repo. The renderer is responsible
/// for delaying the call by a beat so the "restarting" paint actually lands before
/// the process goes — nothing here can help with that, and nothing here should.
///
/// Outside an AppImage that is all there is to do, and this command does exactly
/// that, unchanged. Inside one it is not enough. `restart()` ends in
/// `tauri::process::restart(&self.env())`, whose spawn target on Linux is
/// `current_binary()` = **`$APPIMAGE`** (`process.rs:48-56`), spawned as
/// `Command::new(path).args(args_os.iter().skip(1)).spawn()` with NO `env_clear`
/// and NO `env_remove` (`process.rs:74-89`). So the child re-enters
/// `runtime → AppRun → AppRun.wrapped`, and `AppRun` **prepends** its mount
/// paths to the env it has just inherited: N restarts ⇒ N+1 stacked generations.
/// (The host this was filed from sat at generation 2: `APPDIR` named
/// `.mount_archimgAAJCI` while `OWD` named the older `.mount_archimPfJcAP`,
/// `/proc/mounts` listed both, and 10 of 25 `PATH` entries were under the older
/// one.) Tasks 1–3 make that stack harmless for CHILDREN; only not inheriting
/// it stops the PARENT from growing.
///
/// So inside a bundle this command owns the spawn
/// ([`relaunch_through_the_mount`]) with the same mount-stripping patch every
/// other spawn site applies — and that leaves exactly ONE generation, not zero:
/// the relaunched bundle's `AppRun` re-adds its own single set, and that one is
/// all the new process and its children carry.
///
/// ⚠ What the owned spawn owes, and why it is three steps rather than one.
/// `relaunch_app` is a BLOCKING command, so Tauri runs it inline in an IPC
/// handler off the main thread, so `restart()` would not spawn anything itself:
/// it sets `restart_on_exit` and requests exit, and the restart happens in
/// `App::run`'s `RuntimeRunEvent::Exit` arm (`app.rs:1448-1454`) — which runs the
/// `RunEvent::Exit` **callback first** and `cleanup_before_exit()` only after.
/// `cleanup_before_exit()` alone (`app.rs:1128-1140`: tray icons + resource
/// tables) is therefore NOT the teardown being bypassed. The owned path replays,
/// in that order: this app's own `RunEvent::Exit` hook (the Worker `reap_all`,
/// `src/lib.rs:378-389`), the window-state plugin's `RunEvent::Exit` save
/// (`tauri-plugin-window-state-2.4.0/src/lib.rs:503`), and then
/// `cleanup_before_exit()`.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    // Non-Linux has no `Env::appimage`/`Env::appdir` to read and nothing for
    // `scrub` to strip, so the owned path is not compiled there at all and this
    // is the one-line command it was.
    #[cfg(target_os = "linux")]
    {
        if let Some((path, args, patch)) = owned_relaunch(&app) {
            relaunch_through_the_mount(&app, &path, &args, &patch);
        }
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::{map_check_error, relaunch_patch, restart_target, InstallClaim, ProgressThrottle};
    use std::ffi::OsString;
    use std::path::Path;
    use std::time::{Duration, Instant};
    use tauri_plugin_updater::Error as UpdaterError;

    // Everything here is PURE. The three commands are deliberately untested at
    // this level, and the reason is not laziness but two hard walls:
    // `tauri::test::mock_builder` builds an app with NO plugins, and the plugin's
    // `UpdaterExt::updater_builder()` reads its state with `Manager::state()` —
    // which PANICS ("state() called before manage()") on an unregistered plugin
    // rather than returning an `Err` a test could assert on; and a real `check()`
    // is a network request to the publisher's own endpoint, which a unit test must
    // not make. So the plugin-backed commands are proven where they can be — the
    // dev smoke of Task 5 (`__TAURI_INTERNALS__.invoke("check_update")` answering
    // in devtools, and once a release exists, the Settings UI) — and `tests/ipc.rs`
    // gains NO updater case for that same mock_builder reason. What IS pinned below
    // is the logic that does not need an `AppHandle` to be wrong: which string each
    // failure becomes, how many frames a flood becomes, and — since the AppImage
    // relaunch — what the relaunched process is exec'd with and which env it gets.
    //
    // No test sleeps. `std::time::Instant` cannot be constructed, only moved, so
    // every clock reading below is `base.checked_sub(ms)` — an `Instant` from
    // before `base` — and the throttle takes it as a parameter. `base` is taken
    // ONCE per test, AFTER `Instant::now()`, so every reading is genuinely in the
    // past and no `checked_sub` can underflow; a `base` grabbed before a long wait
    // would make the *later* readings impossible to fabricate.

    /// A fabricated clock reading `ms` milliseconds BEFORE the test's base.
    fn ago(base: Instant, ms: u64) -> Instant {
        base.checked_sub(Duration::from_millis(ms))
            .expect("fabricated instant is after the base")
    }

    #[test]
    fn the_install_claim_is_exclusive_and_releases_on_drop() {
        // The safety net for the unmounting Settings section: the component that
        // starts an install can be torn down mid-download (navigation), so its
        // click-guard dies with it and a remount would otherwise start a SECOND
        // concurrent `download_and_install`. The Rust-side slot is what makes
        // that impossible, so its three transitions are pinned here — claim,
        // refuse while held, and re-claim once the RAII guard drops.
        //
        // A LOCAL flag, not the module's static: `cargo test` runs these in
        // parallel threads, and the production slot must not be observable from a
        // sibling test. `try_claim` holds on to the flag it claimed precisely so
        // this stays honest — the re-claim below asserts on the SAME flag the
        // guard was taken from, so it really is the guard's `Drop` being
        // exercised, and the production path is the identical call with the
        // module's static.
        use std::sync::atomic::AtomicBool;

        // A leaked flag: `try_claim` needs `&'static` (the `Drop` writes through
        // it after the guard has moved), and a test-local `static` would be
        // shared with the parallel tests above.
        let flag: &'static AtomicBool = Box::leak(Box::new(AtomicBool::new(false)));
        let first = InstallClaim::try_claim(flag).expect("the first claim always wins");
        assert!(
            InstallClaim::try_claim(flag).is_none(),
            "a second claim while the slot is held must be refused"
        );
        drop(first);
        assert!(
            InstallClaim::try_claim(flag).is_some(),
            "the slot must be claimable again after the guard drops \
             (mac/linux: a finished or failed install has to be retryable)"
        );
    }

    #[test]
    fn a_missing_release_maps_to_release_not_found() {
        // The load-bearing row: GitHub 404s `…/releases/latest/download/latest.json`
        // for a repo with no release yet, and the plugin calls that
        // `ReleaseNotFound`. Mapped to anything that reads as "current", every
        // installed client would report itself up to date forever.
        assert_eq!(
            map_check_error(&UpdaterError::ReleaseNotFound),
            "release-not-found"
        );
    }

    #[test]
    fn empty_endpoints_maps_to_endpoints_not_configured() {
        assert_eq!(
            map_check_error(&UpdaterError::EmptyEndpoints),
            "endpoints-not-configured"
        );
    }

    #[test]
    fn a_signed_version_mismatch_maps_to_signature_mismatch_and_keeps_its_own_code() {
        // SECURITY: distinct from every install-flavoured row, and asserted
        // against the install rows below so a future "just collapse these" edit
        // fails here.
        assert_eq!(
            map_check_error(&UpdaterError::SignedVersionMismatch {
                signed: "0.2.0".to_string(),
                announced: "0.1.0".to_string(),
            }),
            "signature-mismatch"
        );
        assert_eq!(
            map_check_error(&UpdaterError::MissingSignedVersion),
            "signature-mismatch"
        );
        assert_ne!(
            map_check_error(&UpdaterError::MissingSignedVersion),
            map_check_error(&UpdaterError::DebInstallFailed)
        );
    }

    #[test]
    fn a_download_failure_maps_to_network_with_the_plugins_own_detail() {
        // `Network`'s ONLY payload is the string the plugin formatted from the
        // status (`Download request failed with status: 403 Forbidden`), so the
        // status text survives as the `:detail` half — there is no status-code
        // field anywhere on the enum to pull out instead.
        assert_eq!(
            map_check_error(&UpdaterError::Network(
                "Download request failed with status: 403 Forbidden".to_string()
            )),
            "network:Download request failed with status: 403 Forbidden"
        );
    }

    #[test]
    fn a_platform_target_miss_maps_to_invalid_target_with_the_name() {
        assert_eq!(
            map_check_error(&UpdaterError::TargetNotFound("linux-x86_64".to_string())),
            "invalid-target:linux-x86_64"
        );
        assert_eq!(
            map_check_error(&UpdaterError::TargetsNotFound(vec![
                "linux-x86_64-appimage".to_string(),
                "linux-x86_64".to_string(),
            ])),
            "invalid-target:linux-x86_64-appimage,linux-x86_64"
        );
    }

    #[test]
    fn an_unsupported_platform_maps_without_the_arch_it_mentioned() {
        // One code for both: the renderer cannot act on the difference, and the
        // plugin's own Display names four arches the user will never match against.
        assert_eq!(
            map_check_error(&UpdaterError::UnsupportedOs),
            "unsupported-platform"
        );
        assert_eq!(
            map_check_error(&UpdaterError::UnsupportedArch),
            "unsupported-platform"
        );
    }

    #[test]
    fn the_install_flavoured_rows_map_to_install_failed() {
        assert_eq!(
            map_check_error(&UpdaterError::DebInstallFailed),
            "install-failed"
        );
        assert_eq!(
            map_check_error(&UpdaterError::PackageInstallFailed),
            "install-failed"
        );
    }

    #[test]
    fn the_two_format_and_auth_rows_keep_their_own_codes() {
        assert_eq!(
            map_check_error(&UpdaterError::InvalidUpdaterFormat),
            "invalid-update-format"
        );
        assert_eq!(
            map_check_error(&UpdaterError::AuthenticationFailed),
            "authentication-failed"
        );
    }

    #[test]
    fn an_io_error_maps_to_io_with_its_display() {
        let err = UpdaterError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ));
        assert_eq!(map_check_error(&err), "io:denied");
    }

    #[test]
    fn a_variant_the_plan_never_named_falls_through_to_update_error_with_its_display() {
        // The `_` arm's SHAPE, pinned on a variant that is not in the arm table at
        // all: `FailedToDetermineExtractPath` is unit and constructible, and its
        // Display is prose the plugin owns, which is exactly what the fallback is
        // supposed to hand through verbatim.
        assert_eq!(
            map_check_error(&UpdaterError::FailedToDetermineExtractPath),
            "update-error:Failed to determine updater package extract path."
        );
    }

    #[test]
    fn the_first_chunk_always_emits_even_with_no_interval_elapsed() {
        let base = Instant::now();
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100), 0.01);
        assert!(throttle.should_emit(ago(base, 0), 4096, Some(1_000_000)));
        // And the frame counted the chunk: one accumulator, not two.
        assert_eq!(throttle.downloaded(), 4096);
    }

    #[test]
    fn two_chunks_10ms_apart_under_one_percent_are_suppressed() {
        let base = Instant::now();
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100), 0.01);
        assert!(throttle.should_emit(ago(base, 20), 4096, Some(1_000_000)));
        // 10 ms since the frame that went out (< 100 ms) and 8 KB of a megabyte
        // (< 1%): neither rule fires, so the second chunk is silent.
        assert!(!throttle.should_emit(ago(base, 10), 4096, Some(1_000_000)));
        assert!(!throttle.should_emit(ago(base, 0), 4096, Some(1_000_000)));
        // Suppressed frames are still COUNTED — the total is the bar's, not the
        // emitted frames' ledger.
        assert_eq!(throttle.downloaded(), 3 * 4096);
    }

    #[test]
    fn crossing_one_percent_emits_even_inside_the_interval() {
        let base = Instant::now();
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100), 0.01);
        assert!(throttle.should_emit(ago(base, 10), 4096, Some(100_000)));
        // 5120 more bytes puts the total at 9216 / 100 000 = 9.2%, and the last
        // EMITTED frame was at 4096 (4.1%), so the crossing happened 5.1 points
        // after the last frame: well past the 1% floor, 10 ms into a 100 ms
        // interval.
        assert!(throttle.should_emit(ago(base, 0), 5120, Some(100_000)));
    }

    #[test]
    fn with_no_content_length_only_the_interval_can_fire() {
        let base = Instant::now();
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100), 0.01);
        assert!(throttle.should_emit(ago(base, 300), 4096, None));
        // A megabyte arrives in one silent chunk: with no denominator the ratio
        // rule has nothing to compare against, so the interval alone decides — and
        // it is not up.
        assert!(!throttle.should_emit(ago(base, 250), 1_048_576, None));
        // 100 ms after the last EMITTED frame, it is.
        assert!(throttle.should_emit(ago(base, 200), 4096, None));
    }

    #[test]
    fn a_chunk_flood_over_a_second_emits_about_ten_frames() {
        // The arithmetic the assertion encodes. 1000 chunks of 4 KB, one per ms of
        // the fabricated clock = 4 MB/s. Against the download this throttle was
        // written for — the ~124 MB AppImage ADR 0053 names — the 1% floor is
        // ~1.24 MB, and a 100 ms window only ever carries 100 chunks = 400 KB, so
        // the ratio rule CANNOT fire inside a window and the 100 ms interval is the
        // binding rule: the first frame plus one per window = ~10 over a second
        // (t = 0, 100, … 900 ms). The unthrottled forward would emit 1000 events
        // for the same second, which is the whole reason this struct sits between
        // the plugin and the event.
        let base = Instant::now();
        let mut throttle = ProgressThrottle::new(Duration::from_millis(100), 0.01);
        let content_length = 124 * 1024 * 1024;
        let mut emits = 0;
        for i in 0..1000u64 {
            if throttle.should_emit(ago(base, 999 - i), 4096, Some(content_length)) {
                emits += 1;
            }
        }
        assert!((9..=12).contains(&emits), "emits: {emits}");
        assert_eq!(throttle.downloaded(), 1000 * 4096);
    }

    // ── the relaunch resolvers ───────────────────────────────────────────
    //
    // `relaunch_app` ITSELF is still not exercised, and the two walls above are
    // why it cannot be: it needs a live `AppHandle` (a `mock_builder` app has no
    // plugins, so `save_window_state` would fail on unregistered state), and it
    // ends in `std::process::exit(0)` — which would take the test harness down
    // with it. So the two DECISIONS the command is built from are pinned here,
    // which is exactly why they are pure functions of their arguments rather
    // than inline code in the command.
    //
    // ⚠ Nothing below touches `hostenv::for_child()`. Under `cargo test`
    // `current_exe()` is `target/debug/deps/<hash>`, never under `$APPDIR`, so
    // its cached patch is EMPTY on every host and any assertion made against it
    // asserts nothing. `relaunch_patch` must therefore call `hostenv::scrub`
    // DIRECTLY — that is the only way its AppImage branch is reachable from a
    // test at all — and every input below is fabricated.

    /// `$APPIMAGE` of a relaunched bundle — what `Manager::env().appimage`
    /// carries inside an AppImage, and what `tauri::process::current_binary`
    /// hands to `Command::new`.
    const APPIMAGE: &str = "/home/user/downloads/archimedes_0.4.0_x86_64.AppImage";
    /// The `current_exe()` / argv0 of a process running FROM a mount. The same
    /// shape as `hostenv::fixtures::EXE_INSIDE_MOUNT`, restated because the
    /// fixtures module is `cfg(all(test, target_os = "linux"))` and the
    /// `restart_target` tests below run on every target.
    const EXE_IN_MOUNT: &str = "/tmp/.mount_archimTEST/usr/bin/archimedes";
    /// The `current_exe()` of a `.deb` / `.rpm` / `cargo run` host.
    const EXE_INSTALLED: &str = "/usr/bin/archimedes";

    fn os(value: &str) -> OsString {
        OsString::from(value)
    }

    #[test]
    fn restart_target_prefers_the_appimage_path() {
        // Inside an AppImage the thing to re-exec is the BUNDLE, not the exe:
        // the mount only holds an unsquashed AppDir, and the runtime + `AppRun`
        // are what set the bundle up. Getting this backwards restarts into a
        // binary whose libraries are resolved by a mount that is unmounted the
        // moment this process exits.
        let args = [os(EXE_IN_MOUNT), os("--worker"), os("/some path/空间")];
        let (path, spawn_args) = restart_target(
            Some(std::ffi::OsStr::new(APPIMAGE)),
            Path::new(EXE_IN_MOUNT),
            &args,
        );
        assert_eq!(
            path,
            std::path::PathBuf::from(APPIMAGE),
            "the relaunch target must be $APPIMAGE, not the exe under the mount"
        );
        // argv0 DROPPED, the rest carried verbatim (including the non-UTF-8-ish
        // and space-bearing argument — `args_os`, never `args`).
        assert_eq!(
            spawn_args,
            args[1..].to_vec(),
            "the args must be exactly argv[1..]: argv0 is the mount path, and the \
             relaunched process' own argv0 comes from the target"
        );
        assert!(
            !spawn_args.iter().any(|arg| arg == &os(EXE_IN_MOUNT)),
            "argv0 must not survive as an argument: the AppImage runtime would read \
             it as ARGV0/the bundle path — {spawn_args:?}"
        );
    }

    #[test]
    fn restart_target_falls_back_to_the_exe_without_an_appimage() {
        // A `.deb`, an `.rpm`, `cargo run`: no `APPIMAGE`, so the target is the
        // exe — the same answer Tauri's `current_binary` gives, which is what
        // keeps the handed-back path (`app.restart()`) and this one in agreement.
        let args = [os(EXE_INSTALLED)];
        let (path, spawn_args) = restart_target(None, Path::new(EXE_INSTALLED), &args);
        assert_eq!(path, std::path::PathBuf::from(EXE_INSTALLED));
        assert!(
            spawn_args.is_empty(),
            "a lone argv0 leaves nothing to pass on: {spawn_args:?}"
        );
    }

    /// `APPIMAGE=""` is a set-but-empty variable, and it is the one input on
    /// which this resolver **deliberately differs from Tauri**. Tauri's
    /// `current_binary` (`tauri-2.12.2/src/process.rs:48-56`) returns
    /// `PathBuf::from($APPIMAGE)` for ANY `Some`, so with an empty value it
    /// spawns `""` — `Command::new("")` fails, `process.rs:83-85` only logs it, and
    /// `exit(0)` follows: the updater would kill the app and restart NOTHING.
    /// Falling back to the exe keeps the user's app alive.
    #[test]
    fn an_empty_appimage_is_not_a_path() {
        let (path, spawn_args) = restart_target(
            Some(std::ffi::OsStr::new("")),
            Path::new(EXE_IN_MOUNT),
            &[os(EXE_IN_MOUNT), os("--flag")],
        );
        assert_eq!(
            path,
            std::path::PathBuf::from(EXE_IN_MOUNT),
            "an empty $APPIMAGE is no executable to spawn — fall back to the exe"
        );
        assert_eq!(spawn_args, vec![os("--flag")], "the args are unaffected");
    }

    /// Totality, pinned. `args[1..]` panics on an empty slice (`range end index
    /// 1 out of range for slice of length 0`), and this resolver runs on the
    /// relaunch path, where a panic is unrecoverable: the command handler dies,
    /// nothing is spawned, and the app quits with no successor. `std::env::args_os()`
    /// always yields an argv0 in production, but the resolver is pure, so a caller
    /// CAN hand it nothing — and it must answer with nothing, not with a panic.
    #[test]
    fn restart_target_tolerates_an_empty_arg_list() {
        let (path, spawn_args) = restart_target(
            Some(std::ffi::OsStr::new(APPIMAGE)),
            Path::new(EXE_IN_MOUNT),
            &[],
        );
        assert!(
            spawn_args.is_empty(),
            "no argv at all means no args, not a panic: {spawn_args:?}"
        );
        assert_eq!(path, std::path::PathBuf::from(APPIMAGE));
    }

    /// The `.deb` guarantee: outside an AppImage the patch is EMPTY, so
    /// `relaunch_app` calls `app.restart()` exactly as it did before this task
    /// and a non-bundle restart stays byte-identical.
    ///
    /// The `inherited` env carries mount paths ON PURPOSE: it is the GATE that
    /// has to close here, not the shape of the values. Give a leaky gate this
    /// env and a `.deb` user's `PATH` gets rewritten by a restart. Each shape is
    /// the one `hostenv::appimage_mount_root` exists to reject — and none of
    /// them is reachable through `for_child()`, which is empty under cargo
    /// whatever the process env says.
    ///
    /// Runs on every target: off Linux `scrub` is defined to return the empty
    /// patch, so the four shapes are not re-testing the gate there, they are
    /// pinning the cross-platform promise that the owned spawn never happens.
    #[test]
    fn relaunch_hands_back_to_tauri_outside_an_appimage() {
        let inherited = vec![
            (
                os("PATH"),
                os("/tmp/.mount_archimTEST/usr/bin:/usr/bin:/bin"),
            ),
            (
                os("LD_LIBRARY_PATH"),
                os("/tmp/.mount_archimTEST/usr/lib/:/usr/lib"),
            ),
        ];
        // (a) `APPDIR` unset: the ordinary `.deb` / `.rpm` / `cargo run` host.
        assert!(
            relaunch_patch(inherited.clone(), None, Path::new(EXE_INSTALLED)).is_empty(),
            "no APPDIR means no patch — the restart must go through app.restart()"
        );
        // (b) `APPDIR` exported by the user's own shell while the exe lives
        //     nowhere near it: their real `PATH` is theirs.
        assert!(
            relaunch_patch(
                inherited.clone(),
                Some(Path::new("/tmp/.mount_archimTEST")),
                Path::new(EXE_INSTALLED),
            )
            .is_empty(),
            "an APPDIR the exe is not under is not a bundle we are running from"
        );
        // (c) `APPDIR` set-but-empty (`export APPDIR=`). `Path::new("")` makes
        //     `starts_with` true for EVERY path and an empty byte-prefix matches
        //     every absolute entry, so this is the shape that would strip a
        //     `.deb` user's `PATH` down to nothing — exit code 0, no error.
        assert!(
            relaunch_patch(
                inherited.clone(),
                Some(Path::new("")),
                Path::new(EXE_IN_MOUNT)
            )
            .is_empty(),
            "an empty APPDIR must gate the scrub OFF, not match every path"
        );
        // (d) `APPDIR="/"`: the same over-match in the other direction — only
        //     `RootDir`, no `Component::Normal`, and a prefix of everything.
        assert!(
            relaunch_patch(inherited, Some(Path::new("/")), Path::new(EXE_IN_MOUNT)).is_empty(),
            "a root APPDIR must gate the scrub OFF too"
        );
    }

    /// The OLDER mount generation — the one `$APPDIR` does NOT name. `AppRun`
    /// prepends and never clears, so after one updater relaunch the parent carries
    /// TWO: measured on the host this task was filed from, `APPDIR` named
    /// `.mount_archimgAAJCI`, `OWD` named `.mount_archimPfJcAP`, `/proc/mounts`
    /// listed both, and 10 of 25 `PATH` entries sat under the older one.
    #[cfg(target_os = "linux")]
    const STALE_MOUNT: &str = "/tmp/.mount_archimPfJcAP";

    /// The env a second-generation relauncher inherits, built on
    /// [`fixtures`](crate::agent::hostenv::fixtures) rather than re-fabricated:
    /// both mounts in the colon lists, one of the user's own entries in each
    /// multi-valued variable (so "the mount is gone" cannot be faked by
    /// "everything is gone"), and a `PYTHONHOME` pointing ONLY at the stale
    /// generation, so the patch has to `env_remove` it rather than re-set it.
    #[cfg(target_os = "linux")]
    fn two_generations_inherited() -> Vec<(OsString, OsString)> {
        use crate::agent::hostenv::fixtures;
        let current = fixtures::MOUNT;
        let stale = STALE_MOUNT;
        vec![
            (
                os("PATH"),
                os(&format!(
                    "{current}/usr/bin:{stale}/bin:{current}/bin:{}",
                    fixtures::USER_BIN
                )),
            ),
            (
                os("LD_LIBRARY_PATH"),
                os(&format!("{current}/usr/lib/:{stale}/usr/lib:/usr/lib")),
            ),
            (os("PYTHONHOME"), os(&format!("{stale}/usr"))),
        ]
    }

    /// What a `std::process::Command` was TOLD to carry. The local copy of
    /// `fixtures::configured_env` exists because that helper is typed for
    /// `tokio::process::Command` and the relaunch spawn is a std one; the
    /// semantics are identical, including the one that matters: `get_envs`
    /// reports an `env_remove` as a `None`-valued entry.
    #[cfg(target_os = "linux")]
    fn configured(
        cmd: &std::process::Command,
    ) -> std::collections::BTreeMap<OsString, Option<OsString>> {
        cmd.get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(|v| v.to_os_string())))
            .collect()
    }

    /// The stacking test, i.e. the reason this task exists: inside a bundle the
    /// patch must be NON-empty (empty means `relaunch_app` hands back to
    /// `app.restart()`, which spawns `$APPIMAGE` with the env untouched and lets
    /// `AppRun` prepend a third generation), and it must strip BOTH generations
    /// — the new `AppRun` re-adds its own single one, so stripping both is what
    /// leaves the relaunched app at exactly one rather than at none.
    #[cfg(target_os = "linux")]
    #[test]
    fn relaunch_strips_the_stale_generation() {
        use crate::agent::hostenv::fixtures;

        let inherited = two_generations_inherited();
        let patch = relaunch_patch(
            inherited.clone(),
            Some(Path::new(fixtures::MOUNT)),
            Path::new(fixtures::EXE_INSIDE_MOUNT),
        );
        assert!(
            !patch.is_empty(),
            "inside a fabricated AppImage the patch must NOT be empty — an empty one \
             means the relaunch goes back through app.restart() and stacks another \
             generation: {patch:?}"
        );

        // The env the relaunched process would ACTUALLY get: the inherited env
        // seeded as std would inherit it, then the same
        // [`EnvPatch::apply_std`](crate::agent::hostenv::EnvPatch::apply_std) the
        // owned spawn runs. Seeding rather than `env_clear` is load-bearing: std
        // drops an `env_remove` issued after a clear, which would hide exactly
        // the half of the patch that removes `PYTHONHOME`.
        let mut cmd = std::process::Command::new(EXE_IN_MOUNT);
        cmd.envs(inherited.clone());
        patch.apply_std(&mut cmd);
        let got = configured(&cmd);

        assert_eq!(
            got.get(&os("PATH")).and_then(|value| value.as_deref()),
            Some(std::ffi::OsStr::new(fixtures::USER_BIN)),
            "both generations' bins are gone and the user's own is all that is left \
             — an absent or empty PATH is a silent regression, not a scrub"
        );
        assert_eq!(
            got.get(&os("LD_LIBRARY_PATH"))
                .and_then(|value| value.as_deref()),
            Some(std::ffi::OsStr::new("/usr/lib")),
            "the stale AND the current mount dir are stripped; the new AppRun adds \
             its own single generation back"
        );
        assert_eq!(
            got.get(&os("PYTHONHOME")),
            Some(&None),
            "PYTHONHOME pointed only at the stale generation, so it is REMOVED — \
             an empty value is not an absent one to CPython"
        );
        // The general rule, restated independently of `scrub`'s own matcher, so
        // a bug in that matcher cannot make this test green: no value the patch
        // hands on names ANY mount, of EITHER generation.
        for (key, value) in &got {
            if let Some(value) = value {
                assert!(
                    !fixtures::lists_a_mount_path(value),
                    "{key:?} still names a mount path after the relaunch patch: {value:?}"
                );
            }
        }
    }
}
