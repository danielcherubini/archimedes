//! The updater IPC seam (ADR 0053): three commands, ONE event, no capability entry.
//!
//! The renderer never holds updater or restart rights. It gets `check_update`,
//! `install_update`, `relaunch_app` and the `update://progress` event, and the
//! plugin behind them is registered in Rust and called from Rust — the same
//! arrangement as `tauri_plugin_notification` (see its `Cargo.toml` comment): the
//! ACL gates the webview→Rust boundary only, so a Rust-side `check()` needs no
//! permission entry, and `AppHandle::restart()` is on Tauri itself, so
//! `tauri-plugin-process` — and `allow-restart` with it — never enters the graph.
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

/// Restart into the freshly installed build.
///
/// Synchronous, and it does not return: `AppHandle::restart()` is `-> !`
/// (Tauri 2.12.2, `app.rs:606`), which is precisely why `tauri-plugin-process` and
/// its `allow-restart` entry are absent from this repo. The renderer is responsible
/// for delaying the call by a beat so the "restarting" paint actually lands before
/// the process goes — nothing here can help with that, and nothing here should.
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::{map_check_error, ProgressThrottle};
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
    // is the two pieces of logic that do not need an `AppHandle` to be wrong: which
    // string each failure becomes, and how many frames a flood becomes.
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
}
