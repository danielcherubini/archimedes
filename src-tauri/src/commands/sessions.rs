//! Tauri commands for the native session lifecycle.
//!
//! State is `tauri::State<'_, Arc<SessionManager>>`: the manager is
//! `Sync` — its mutable state is `Arc<Mutex<…>>` internally, so each
//! method locks only its own map, briefly.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::agent::{
    debuglog, EventSink, ImagePayload, PermissionOutcome, SessionInfo, SessionManager, StalledInfo,
    StopReason,
};

/// `EventSink` backed by `AppHandle::emit`.
///
/// Managed as Tauri state so commands (and the mock-runtime IPC test) can
/// obtain it without an `AppHandle` parameter.
#[derive(Clone)]
pub struct TauriSink<R: tauri::Runtime = tauri::Wry>(pub AppHandle<R>);

impl<R: tauri::Runtime> EventSink for TauriSink<R> {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// The log line for a rejected command (PURE — no global state).
///
/// `{err}` is the error's `Display`, i.e. the SAME sentence the frontend
/// renders (Tasks 1-2 made `SessionError` always carry it as `message`), so a
/// support log and the user's screenshot agree word for word. The command's
/// NAME is the part a person greps for.
///
/// Deliberately NOT the arguments: `send_prompt` carries the user's prompt
/// TEXT, and this task adds no user content to the log beyond what the error's
/// own message already says.
fn logged_line(command: &str, err: &crate::agent::SessionError) -> String {
    format!("ipc {command} FAILED: {err}")
}

/// Log a rejected session command to the `ARCHIMEDES_DEBUG` log (a no-op when off).
///
/// The command layer is the right place, not `SessionManager`: the manager is
/// used by the Worker and by tests, and the rejection the user sees is formed
/// HERE, at the IPC boundary. The cost is stated honestly — a user reporting a
/// bug must have set `ARCHIMEDES_DEBUG=1` BEFORE reproducing, which is exactly
/// the step that hid the report this exists for; what it buys is a diagnostic
/// surface that stays ONE switch, the log's existing 5 MB rotation, and nothing
/// written to disk on a normal run (`debuglog::log` is a cached atomic read
/// when disabled and creates no file — `agent/debuglog.rs:27`, `:60-67` — so
/// wrapping every command costs nothing with the variable unset).
///
/// NO enablement check of its own, on purpose: `debuglog::log` owns the flag
/// (pinned by its own `log_is_a_noop_when_disabled`), so there is no second
/// flag to drift out of sync. The result is returned unchanged, unconditionally
/// — this wrapper cannot alter control flow.
fn logged<T>(
    command: &str,
    result: Result<T, crate::agent::SessionError>,
) -> Result<T, crate::agent::SessionError> {
    if let Err(e) = &result {
        debuglog::log(&logged_line(command, e));
    }
    result
}

#[tauri::command]
pub async fn start_session(
    sink: State<'_, Arc<dyn EventSink>>,
    state: State<'_, Arc<SessionManager>>,
    cwd: String,
) -> Result<SessionInfo, crate::agent::SessionError> {
    logged(
        "start_session",
        state.start_session(PathBuf::from(cwd), sink.inner()).await,
    )
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    text: String,
    images: Option<Vec<ImagePayload>>,
) -> Result<StopReason, crate::agent::SessionError> {
    // The manager owns the whole user-turn flow: image validation, the
    // user-row persistence (a single write — the command adds NONE), the
    // `prompt` command, and the turn's resolution.
    let images = images.unwrap_or_default();
    logged(
        "send_prompt",
        state
            .send_prompt_with_images(&session_id, text, images)
            .await,
    )
}

#[tauri::command]
pub async fn close_session(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), crate::agent::SessionError> {
    logged("close_session", state.close_session(&session_id).await)
}

/// Deliver the user's decision on a pending permission prompt to the agent.
///
/// `request_id` is the `id` of the agent's `extension_ui_request` dialog
/// (the one carried in the `permission-request` event). If the prompt is
/// no longer pending, this is a no-op.
///
/// The ADR 0025 Task 5 re-plumb: a SINGLE `state` (the `SessionManager`
/// routes through the `WorkerManager`'s `handle_for` — a MAIN session's
/// handle is in the `workers` map, a SUBAGENT session's handle in the
/// `drives` map — the `SubagentSessionManager`'s `respond_*` methods are
/// deleted: the child's pending maps live in its Worker).
#[tauri::command]
pub async fn respond_permission(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    request_id: String,
    outcome: PermissionOutcome,
) -> Result<(), crate::agent::SessionError> {
    let hit = logged(
        "respond_permission",
        state
            .respond_permission(&session_id, &request_id, outcome)
            .await,
    )?;
    if !hit {
        eprintln!(
            "respond_permission: no pending entry for session {session_id} request {request_id}"
        );
    }
    Ok(())
}

/// Deliver the user's answer to a pending interactive request to the agent.
///
/// `request_id` is the interactive request's `id` (the one carried in the
/// `interactive-request` event). `result` is the response `result` `Value`
/// VERBATIM (no wrapper — for `ask`, the `AskResponsePayload`; for
/// `confirm`, `{confirmed}`; for `password`, `{password}`); the desktop
/// writes `{v:1, type:"response", id, result}`. If the request is no longer
/// pending, this is a no-op.
///
/// The ADR 0025 Task 5 re-plumb: a SINGLE `state` (the `SessionManager`
/// routes through the `WorkerManager`'s `handle_for` — main AND subagent
/// sessions both resolve; the `SubagentSessionManager`'s `respond_*`
/// methods are deleted: the child's pending maps live in its Worker).
#[tauri::command]
pub async fn respond_interactive_request(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    request_id: String,
    result: Value,
) -> Result<(), crate::agent::SessionError> {
    let hit = logged(
        "respond_interactive_request",
        state
            .respond_interactive_request(&session_id, &request_id, result)
            .await,
    )?;
    if !hit {
        eprintln!("respond_interactive_request: no pending entry for session {session_id} request {request_id}");
    }
    Ok(())
}

/// Resume a stored session: a fresh `AgentLoop` + `SessionStore::load_messages`
/// (resume from the `native_messages` table; the stored row's `model` /
/// `thinkingLevel` override the resolution chains).
///
/// Returns [`crate::agent::SessionError::NotResumable`] when the stored
/// row is missing — the UI then shows the history-only banner instead.
#[tauri::command]
pub async fn resume_session(
    sink: State<'_, Arc<dyn EventSink>>,
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    cwd: String,
) -> Result<SessionInfo, crate::agent::SessionError> {
    logged(
        "resume_session",
        state
            .resume_session(&session_id, PathBuf::from(cwd), sink.inner())
            .await,
    )
}

/// Set a session config option (model / thinking level) on a live
/// session; returns the re-synthesized config options.
#[tauri::command]
pub async fn set_session_config_option(
    sink: State<'_, Arc<dyn EventSink>>,
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Vec<Value>, crate::agent::SessionError> {
    logged(
        "set_session_config_option",
        state
            .set_config_option(&session_id, &config_id, &value, sink.inner())
            .await,
    )
}

/// Cancel the session's in-flight prompt turn (the user pressed Esc).
/// Sets the session's `cancel_requested` flag, then cancels the session's
/// current TURN token (`handle.cancel()` — the turn stops, the session
/// STAYS ALIVE). The loop settles the turn `Cancelled` (the flag maps the
/// settle to `Cancelled`, not `EndTurn`), which completes the in-flight
/// `send_prompt` with `Cancelled` and unlocks the composer.
#[tauri::command]
pub async fn cancel_session(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), crate::agent::SessionError> {
    logged("cancel_session", state.cancel_session(&session_id).await)
}

/// Compact a session NOW (the `/compact` Composer command — ADR 0044). The
/// command is intercepted by the Client and NEVER reaches the Agent, so this is
/// its only route in. `Ok(false)` = nothing ran: a session that is not live (a
/// stored one) is a NO-OP, not an error. `instructions` are the user's extra
/// summary instructions (`/compact <args>`).
#[tauri::command]
pub async fn compact_session(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    instructions: Option<String>,
) -> Result<bool, crate::agent::SessionError> {
    logged(
        "compact_session",
        state.compact_session(&session_id, instructions).await,
    )
}

/// The stalled-session query (the frontend's banner query — ADR 0025):
/// a Worker crash marks the session STALLED (the Supervisor's `stalled`
/// registry); the `session-stalled` event is the PUSH, this is the PULL
/// (the frontend reads the state from the event + this query). `Ok(None)`
/// when the session is not stalled (a query miss is a success — the
/// frontend's banner simply has nothing to show).
#[tauri::command]
pub async fn get_stalled_info(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<Option<StalledInfo>, String> {
    Ok(state.stalled_info(&session_id))
}

#[cfg(test)]
mod tests {
    use super::{logged, logged_line};
    use crate::agent::{debuglog, SessionError};

    /// A unique scratch dir, OWNED (#96 task 07) — the `debuglog.rs` test helper's
    /// shape, kept local so this module owns no cross-module coupling. NOT
    /// `Clone`: `to_path_buf()` is what `debuglog::init`'s `Option<PathBuf>` takes.
    fn temp_dir() -> crate::test_support::ScratchDir {
        crate::test_support::ScratchDir::in_env_temp("sessions-log-test-", "log")
    }

    /// Restores the global debug log to DISABLED on scope exit — INCLUDING on
    /// a panicking assertion, which the plain "call `init(false, None)` last"
    /// shape does not (a panic would hand the next sibling test a global still
    /// pointing at this test's now-deleted temp dir). `debuglog::init(false,
    /// None)` clears BOTH `ENABLED` and `DIR` (`agent/debuglog.rs:33-36`), so
    /// one call is the whole cleanup.
    struct DisableDebuglogOnExit;
    impl Drop for DisableDebuglogOnExit {
        fn drop(&mut self) {
            debuglog::init(false, None);
        }
    }

    // ── Seam 1: the PURE format string (the real assertions — no global
    // state, so no ordering constraint and no shared file to race).

    /// The log line names the command (the string a person greps for), carries
    /// the `ipc` / `FAILED` frame, and ends with the error's `Display` — the
    /// SAME sentence the frontend renders after Tasks 1-2, so a support log and
    /// the user's screenshot agree.
    #[test]
    fn logged_line_names_the_command_and_carries_the_error_display() {
        let line = logged_line(
            "start_session",
            &SessionError::FolderMissing {
                path: "/nope".into(),
            },
        );
        for needle in ["ipc", "start_session", "FAILED", "folder not found: /nope"] {
            assert!(
                line.contains(needle),
                "`{needle}` is missing from the log line: {line}"
            );
        }
        // The exact frame (the plan's `format!("ipc {command} FAILED: {err}")`),
        // pinned once so a reword cannot silently drop the `ipc` prefix that
        // makes these lines greppable apart from the Worker's `→`/`←` IPC lines.
        assert_eq!(
            line, "ipc start_session FAILED: folder not found: /nope",
            "the log line is the documented frame"
        );

        // A per-test UNIQUE marker shows the WHOLE error message reaches the
        // line (not a truncation or a re-derived text), and is what makes the
        // file assertions below race-tolerant.
        let marker = uuid::Uuid::new_v4().to_string();
        let line = logged_line("send_prompt", &SessionError::Io(marker.clone()));
        assert_eq!(
            line,
            format!("ipc send_prompt FAILED: i/o error: {marker}"),
            "the error's own message is the tail of the line"
        );
    }

    // ── Seam 2: the wiring (`logged` → `debuglog::log`).
    //
    // WHY the assertions are split this way: `debuglog`'s `ENABLED` / `DIR` are
    // PROCESS-GLOBAL, and the Worker tests call `debuglog::log` WITHOUT holding
    // the env lock (`agent/worker/manager.rs:556`, `:981`,
    // `agent/worker/client.rs:330`, `:344`). A sibling test's `init` can
    // therefore re-point the global mid-test, and a sibling's `log` can append
    // an unrelated line to OUR file. So: the LOAD-BEARING assertion is the
    // returned value (global-free), and anything read from `supervisor.log` is
    // `contains` on a per-test UNIQUE marker — never equality, never "the file
    // has exactly one line". That is the same shape `debuglog.rs`'s own
    // `log_delegates_to_append_to_when_enabled` documents.

    /// The wrapper's whole contract: a rejection comes back UNCHANGED (same
    /// variant, same payload — the wrapper cannot alter control flow or the
    /// message the user sees) and lands in the debug log as `ipc <name> FAILED`.
    #[test]
    fn logged_hands_back_the_rejection_unchanged_and_writes_the_line() {
        // The shared lock serializes the `init` → assert → restore span against
        // the other global-touching tests (`test_support::env_lock` — NOT
        // `debuglog`'s own private test `lock()`, which lives inside that
        // module's `#[cfg(test)] mod tests` and is unreachable from here).
        let _lock = crate::test_support::env_lock();
        // #96 task 07: the guard is declared BEFORE the global-clearing marker so
        // that it drops AFTER it (locals drop in reverse) — `debuglog::init(false,
        // None)` must clear the process-global `DIR` before this dir is removed,
        // or the global is left naming a path that no longer exists. The lock is
        // declared FIRST so it outlives both.
        let dir = temp_dir();
        let _disable = DisableDebuglogOnExit;
        debuglog::init(true, Some(dir.to_path_buf()));

        // A unique path = the marker: no sibling line can contain it.
        let err = SessionError::FolderMissing {
            path: format!("/tmp/sessions-{}", uuid::Uuid::new_v4()),
        };
        let marker = err.to_string();
        let got = logged("start_session", Err::<(), _>(err.clone()));

        assert_eq!(
            got.unwrap_err(),
            err,
            "`logged` must hand the `Err` back unchanged (same variant + payload)"
        );

        let written = std::fs::read_to_string(dir.join("supervisor.log"))
            .expect("an enabled debug log writes the rejection");
        assert!(
            written.contains(&marker),
            "the error's message is in `supervisor.log`:\n{written}"
        );
        assert!(
            written.contains("ipc start_session FAILED:"),
            "the line is framed with the command name:\n{written}"
        );
    }

    /// An ACCEPTED command passes through unchanged and writes NOTHING — the
    /// wrapper logs on rejection only, so a normal run leaves no trace.
    ///
    /// The negative assertion is marker-scoped for the reason stated above: the
    /// label carries a per-test unique uuid, so a concurrent Worker test's line
    /// can never contain it and a sibling's write cannot turn this red.
    #[test]
    fn logged_passes_an_ok_through_without_writing_a_line() {
        let _lock = crate::test_support::env_lock();
        // #96 task 07: same ordering as the sibling above — guard BEFORE the
        // marker (so it drops AFTER it: the process-global `DIR` is cleared
        // before the log dir is removed) and the lock FIRST (it outlives both).
        let dir = temp_dir();
        let _disable = DisableDebuglogOnExit;
        debuglog::init(true, Some(dir.to_path_buf()));

        let label = format!("close_session_{}", uuid::Uuid::new_v4());
        assert_eq!(
            logged(&label, Ok(41)),
            Ok(41),
            "`logged` must hand the `Ok` back unchanged"
        );

        let written = std::fs::read_to_string(dir.join("supervisor.log")).unwrap_or_default();
        assert!(
            !written.contains(&label),
            "an accepted command must NOT be logged:\n{written}"
        );
    }

    /// #96 task 07: `temp_dir()` must OWN what it creates. It handed back a bare
    /// `PathBuf` and the only cleanup was a trailing `remove_dir_all` STATEMENT,
    /// so an assertion failing before that line left the log dir behind. This
    /// module's green delta is 0 (the two mints were already 1:1 with their two
    /// removals) — so this is a RED about OWNERSHIP, not about a green leak: it
    /// pins that the helper now owns its dir, which is exactly what makes the
    /// panic path free.
    ///
    /// Takes NO `env_lock()` and calls NO `debuglog::init` — it exercises
    /// ownership only, so it touches neither the process-global nor the env, and
    /// stays order-independent against the other tests in these three modules.
    #[test]
    fn the_temp_dir_fixture_removes_its_dir_when_its_owner_is_dropped() {
        let dir = temp_dir();
        let captured = dir.to_path_buf();
        assert!(captured.is_dir(), "the fixture created its scratch dir");
        drop(dir);
        assert!(
            !captured.exists(),
            "the fixture's scratch goes with its owner: {captured:?}"
        );
    }

    /// The panic path for the sessions log dir: the guard is MOVED INTO the
    /// panicking scope, so it is the unwind that runs the removal (the
    /// `test_support` precedent). Today's trailing `remove_dir_all` is a
    /// statement AFTER the assertions, so a failing one of those skips it. The
    /// escaped-panic case (a failing test whose guard is a plain local) is
    /// deliberately NOT pinned here — Rust makes no portable guarantee and
    /// status-doc D10 gives it to task 09's census.
    #[test]
    fn a_panicking_assertion_still_removes_the_sessions_log_dir() {
        let captured = {
            let dir = temp_dir();
            let path = dir.to_path_buf();
            assert!(path.is_dir(), "the fixture created its scratch dir");
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _held = dir;
                assert_eq!(
                    1, 2,
                    "an assertion fails while the fixture owns its log dir"
                );
            }));
            assert!(r.is_err(), "the assertion failed as arranged");
            path
        };
        assert!(
            !captured.exists(),
            "the unwind ran the removal: {captured:?}"
        );
    }
}
