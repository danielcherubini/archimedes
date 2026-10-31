//! The Worker event router + the crash / stalled / pending-modal cluster
//! (ADR 0025) — a CHILD module of `session`, so it sees the parent's private
//! items (`SessionManager`'s `sessions` map and the `with_session` accessors,
//! the private `LiveWorkerSession` / `CloseKind`) with no visibility widening.

use std::path::PathBuf;

use serde_json::json;

use crate::agent::events::RpcEvent;
use crate::agent::normalize::now_ms;
use crate::agent::worker::client::WorkerInboundEvent;

use super::{CloseKind, ClosedReason, SessionManager, StalledInfo, StopReason};

impl SessionManager {
    // ── The Worker event router (ADR 0025 Task 4) ──────────────────────────
    // The `WorkerManager`'s `on_event` callback (wired in `lib.rs` with the
    // `OnceLock` late-wire). The reviewer-corrected routing: the UI's contract
    // is the `SinkFrame`s (re-emitted verbatim); the store frames drive
    // persistence only; the raw `RpcEvent` stream drives internal bookkeeping
    // only (settle detection + the `pending_turn` resolution — NEVER the UI, to
    // avoid double-delivering the `session-update` frames); the
    // `PermissionRequest` / `InteractiveRequest` frames are re-emitted with the
    // payload UNCHANGED (the frontend contract preserved by construction).
    pub fn route_event(&self, session_id: &str, is_subagent: bool, evt: WorkerInboundEvent) {
        match evt {
            WorkerInboundEvent::Store(frame) => {
                // Persistence ONLY (not the UI — the `TranscriptPersister` applies
                // the store frame to SQLite, the sole writer).
                if let Some(p) = self.persister.get() {
                    p.apply(is_subagent, &frame);
                }
            }
            WorkerInboundEvent::SinkFrame { event, payload } => {
                // The interactive-persistence gate, narrowed PER EVENT (issue
                // #105). `!is_subagent` stays for `todos_update` /
                // `todos_clear`: the todo panel is a MAIN-session surface, so
                // a child's todo frames must never reach the DB (pinned by
                // `sink_frame_interactive_event_todos_update_persists_for_main_not_subagent`).
                // `cost_update` is the one exception — a child's spend is its
                // OWN money and must land on the child's row, or the child's
                // stored figure disagrees with its own card. The discriminator
                // is the payload's inner `event` field, in scope here.
                if event == "interactive-event" {
                    let inner = payload.get("event").and_then(|v| v.as_str());
                    if !is_subagent || inner == Some("cost_update") {
                        // WHICH row owns the money. A subagent's frames are
                        // delivered under the PARENT's delivery id (the pump
                        // re-targets them so the child's UI lives in the
                        // parent's scope — `pump.rs`'s `delivery_id`), but the
                        // ROW belongs to the CHILD. This is the same
                        // distinction `TranscriptPersister::apply` documents
                        // for `StoreFrame`s, and it is load-bearing here:
                        // writing a child's own `cost_update` to the delivery
                        // id would put the child's per-call deltas on the
                        // PARENT's row, and `finish_subagent`'s roll-up would
                        // then add the child's SUM again — the parent's stored
                        // figure double-counting every child. The payload's
                        // `sessionId` is the emitting loop's own id (pinned
                        // loop-side by
                        // `a_priced_call_emits_one_cost_update_frame_carrying_that_calls_cost`),
                        // so it is the child id for a child frame. The
                        // roll-up frame is delivered with `is_subagent: false`
                        // under the parent's id and so takes the `else` branch
                        // — the parent's row, exactly once.
                        //
                        // Inert for `todos_*`: a subagent's todo frames never
                        // reach this branch at all.
                        let target = if is_subagent {
                            payload
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                // ⚠ This fallback is DELIBERATELY UNREACHABLE:
                                // the loop always stamps its own id on the frame
                                // (pinned loop-side by
                                // `a_priced_call_emits_one_cost_update_frame_carrying_that_calls_cost`),
                                // so a child frame never arrives WITHOUT
                                // `sessionId`. Do not read it as a safe default —
                                // it writes the child's money to the PARENT's row,
                                // which is precisely the double-count the branch
                                // above exists to prevent. If the loop ever stops
                                // stamping, this must SKIP the write (a frame with
                                // no owner is unpersistable), NOT fall back.
                                .unwrap_or(session_id)
                        } else {
                            session_id
                        };
                        if let Some(p) = self.persister.get() {
                            p.apply_interactive_event(target, is_subagent, &payload);
                        }
                    }
                }
                // The ENTIRE UI contract — re-emitted VERBATIM (the same event name +
                // payload; the frontend is unchanged).
                if let Some(sink) = self.sink.get() {
                    sink.emit(&event, payload);
                }
            }
            WorkerInboundEvent::Event(e) => {
                // Internal bookkeeping ONLY (NOT the `TauriSink` — forwarding would
                // DOUBLE-DELIVER every `session-update` the loop emits both as an
                // `RpcEvent` and as a `session-update` `SinkFrame`): the
                // `agent_settled` settle detection (the session's "busy" state) + the
                // `pending_turn` resolution. MAIN sessions only: a child subagent's
                // `agent_settled` arrives under the parent's delivery id with
                // `is_subagent: true` and must NEVER settle the parent turn early.
                if !is_subagent && matches!(e, RpcEvent::agent_settled) {
                    self.resolve_turn(session_id);
                }
                // Session naming: `agent_end` is the turn's last frame
                // (`agent_settled` is the settle signal the turn resolver
                // waits on). MAIN sessions only — a subagent's transcript is
                // hidden (`is_subagent` rows are filtered out of
                // `list_sessions`). The hook guards and spawns: the model
                // call never blocks this router.
                if !is_subagent && matches!(e, RpcEvent::agent_end { .. }) {
                    self.maybe_name_session(session_id);
                }
            }
            WorkerInboundEvent::PermissionRequest { id, payload } => {
                // Re-emit as the `permission-request` Tauri event with the payload
                // UNCHANGED (the frontend contract preserved by construction —
                // `PermissionPrompt.tsx` / `store/permissions.ts` consume the
                // payload's `requestId` / `toolTitle` / `options` verbatim).
                if let Some(sink) = self.sink.get() {
                    sink.emit("permission-request", payload);
                }
                self.track_modal(session_id, &id);
            }
            WorkerInboundEvent::InteractiveRequest { id, payload } => {
                // Re-emit as the `interactive-request` Tauri event with the payload
                // UNCHANGED (same reasoning — `store/interactive.ts` consumes
                // `method` + `params`).
                if let Some(sink) = self.sink.get() {
                    sink.emit("interactive-request", payload);
                }
                self.track_modal(session_id, &id);
            }
            WorkerInboundEvent::FetchRenderRequest { id, payload } => {
                // Internal machine call (ADR 0058 Task 7): do NOT call track_modal!
                let session_id = payload
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(session_id)
                    .to_string();
                let wm = self.worker_manager.get().cloned();
                let app = self.app_handle.get().cloned();
                tokio::spawn(async move {
                    let reply_value = match app {
                        Some(app_handle) => {
                            let req = crate::agent::web::render::RenderRequest {
                                session_id: session_id.clone(),
                                request_id: id.clone(),
                                url: payload
                                    .get("url")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                timeout_ms: payload
                                    .get("timeoutMs")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(30_000),
                            };
                            let reply = crate::agent::web::render::render(&app_handle, req).await;
                            if let Some(err) = reply.error {
                                json!({ "error": err })
                            } else {
                                json!({
                                    "html": reply.html.unwrap_or_default(),
                                    "status": reply.status,
                                    "finalUrl": reply.final_url.unwrap_or_default(),
                                })
                            }
                        }
                        None => {
                            json!({ "error": "Supervisor AppHandle not available" })
                        }
                    };
                    if let Some(wm) = wm {
                        if let Some(handle) = wm.handle_for(&session_id) {
                            let _ = handle.send_fetch_render_response(&id, &reply_value);
                        }
                    }
                });
            }
            WorkerInboundEvent::Exited(code) => {
                // EXPECTED (a `detach` / `reap_all` was in flight) → the
                // `session-closed` cleanup. UNEXPECTED (a crash — the `WorkerManager`
                // fired `on_crash`) → `is_exit_expected` is `false` → no-op (the
                // `on_crash` path handles the stalled marking + the same cleanup).
                // MAIN sessions only: a child subagent's exit is managed by the
                // drive task and must never close the parent session.
                if !is_subagent {
                    if let Some(wm) = self.worker_manager.get() {
                        if wm.is_exit_expected(session_id) {
                            self.on_session_exited_expected(session_id);
                        }
                    }
                }
                let _ = code;
            }
            WorkerInboundEvent::Ready { .. }
            | WorkerInboundEvent::WorkerError { .. }
            | WorkerInboundEvent::SubagentDispatch(_)
            | WorkerInboundEvent::SubagentCancel { .. } => {
                // The `WorkerManager`'s pump owns these: the `SubagentDispatch`
                // (the Supervisor-side `dispatch_subagent` flow) and the
                // `SubagentCancel` (a parent turn abort → `cancel_drive` — the
                // frame arrives on the PARENT's pump, which holds the `drives`
                // map). The `Ready` / `WorkerError` frames are bookkeeping.
                // Nothing UI-facing to do here.
            }
        }
    }

    /// The `WorkerManager`'s `on_crash` callback (the UNEXPECTED `Exited` — a Worker
    /// crash): mark the session STALLED (the `stalled` slice of the session's
    /// `SessionState` row + the `session-stalled` event + the `stalled_info`
    /// query), perform the pending-modal
    /// cleanup (the `interactive-request-close` frames — a crashed session's open
    /// permission / interactive modals are dismissed, no stuck modal alongside the
    /// banner), resolve the in-flight `send_prompt` (the crash outcome — the
    /// composer unlocks; it never stays locked forever), and drop the session's
    /// NAMING slice (a resumed session re-uses the same id — see the site).
    ///
    /// `pid` is the DEAD child's pid (the handle's, captured at spawn); `None`
    /// when the Supervisor never saw one. It selects the crash log — see
    /// `find_crash_log_for_pid` (private; the banner's link is `None` when the
    /// pid names no log).
    pub fn handle_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>) {
        let at = now_ms();
        // The crash log for THIS Worker, resolved ONCE and then frozen. A
        // second lookup for the emit below is what let the pushed
        // `session-stalled` event and the pulled `stalled_info` name
        // different files for ONE crash — a second Worker crashing in between
        // moved the banner's link out from under the registry.
        let crash_log = self
            .crash_log_dir
            .get()
            .and_then(|d| find_crash_log_for_pid(d, pid));
        // Mark the session STALLED (the row's `stalled` slice — the frontend
        // reads it via `stalled_info` + the `session-stalled` event) and drop
        // the NAMING slice in the same lock acquisition. The other two slices
        // are LEFT ALONE — that is today's crash-path shape, and it is a
        // contract, not an oversight:
        //
        // - `naming` goes because a crashed-then-resumed session re-uses the
        //   SAME id, so a stale `in_flight` would block naming for ever and a
        //   stale `fails == MAX_FAILURES` would silently kill it;
        // - `live` / `config_state` stay, so a stalled session still passes the
        //   `close_session` / `cancel_session` `live` guards (the frontend's
        //   `store/sessions.ts` documents exactly that: a crash "removes no
        //   `live` entry", so Stop answers `Ok(())` instead of erroring, and the
        //   row stays resumable). Blanking them here would turn those `Ok`s into
        //   `UnknownSession` errors — a behaviour change this merge forbids
        //   ("Repairing that row's liveness bookkeeping is its own decision, not
        //   a tidy-up to fold in here").
        //
        // A crash for an id that was never started CREATES the row holding ONLY
        // the `stalled` slice (the same thing the standalone `stalled` map did
        // today) — which is why the write goes through the entry-or-default
        // helper rather than a `get_mut`.
        self.with_session_entry(session_id, |row| {
            row.stalled = Some(StalledInfo {
                at,
                crash_log: crash_log.clone(),
            });
            row.naming = None;
        });
        // The pending-modal cleanup (the `interactive-request-close` frames — the
        // unanswered-request-id diff: a crashed session's open permission / interactive
        // modals are dismissed, no stuck modal alongside the banner).
        self.cleanup_pending_modals(session_id);
        // Resolve the in-flight `send_prompt` (the crash outcome — the turn is
        // incomplete; `Cancelled` unlocks the composer. The `StopReason` has no error
        // variant — the `session-stalled` event is the frontend's crash signal).
        self.resolve_turn_forced(session_id, StopReason::Cancelled);
        // Emit the `session-stalled` event (the frontend's banner — the `StalledInfo`
        // shape: `at` + `crash_log`). The path is the one the registry just froze —
        // NEVER a second glob (that is what let the push and the pull disagree).
        if let Some(sink) = self.sink.get() {
            sink.emit(
                "session-stalled",
                json!({
                    "sessionId": session_id,
                    "at": at,
                    "crashLog": crash_log,
                }),
            );
        }
        let _ = code;
    }

    /// The `stalled_info` query (the frontend's banner query — the `SessionManager`
    /// exposes it; the `get_stalled_info` command wraps it). The row's `stalled`
    /// slice CLONED out under the one lock, released before this returns.
    pub fn stalled_info(&self, session_id: &str) -> Option<StalledInfo> {
        self.with_session(session_id, |s| s.stalled.clone())
            .flatten()
    }

    /// Resolve the session's in-flight turn (the `pending_turn` oneshot) on an
    /// `agent_settled` (the `cancel_requested` flag maps the settle to `Cancelled`,
    /// else `EndTurn` — the existing settle semantics). A no-op when no turn is in
    /// flight (the slot is empty) or the session is gone.
    fn resolve_turn(&self, session_id: &str) {
        // Copy out the two SHARED `Arc` slots (the `Arc`s are cloned, not the
        // slot contents — resolving through the clone resolves the session's
        // real slot) and act OUTSIDE the `sessions` lock, exactly as the
        // borrowed `live` reference did under the old map lock.
        let slots = self
            .with_session(session_id, |s| {
                s.live
                    .as_ref()
                    .map(|live| (live.cancel_requested.clone(), live.pending_turn.clone()))
            })
            .flatten();
        let Some((cancel_requested, pending_turn)) = slots else {
            return;
        };
        let cancelled_guard = cancel_requested.lock().unwrap_or_else(|p| p.into_inner());
        let cancelled = *cancelled_guard;
        let reason = if cancelled {
            StopReason::Cancelled
        } else {
            StopReason::EndTurn
        };
        drop(cancelled_guard);
        let mut pending_guard = pending_turn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tx) = pending_guard.take() {
            let _ = tx.send(reason);
        }
    }

    /// Resolve the session's in-flight turn with a FORCED reason (the `Exited`
    /// / crash path — the turn is over regardless of the `cancel_requested` flag;
    /// a mid-turn death / a close must not tell `send_prompt` "turn ended normally").
    fn resolve_turn_forced(&self, session_id: &str, reason: StopReason) {
        let pending_turn = self
            .with_session(session_id, |s| {
                s.live.as_ref().map(|live| live.pending_turn.clone())
            })
            .flatten();
        if let Some(pending_turn) = pending_turn {
            let mut pending_guard = pending_turn.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(tx) = pending_guard.take() {
                let _ = tx.send(reason);
            }
        }
    }

    /// The EXPECTED `Exited` handling (a `detach` / `reap_all` was in flight — the
    /// `close_session` / `reap_all` path): emit `session-closed` (the `ClosedReason`
    /// payload — the `close_kind`: `User` for a `close_session`, `AgentExited` for a
    /// clean self-exit), resolve the in-flight `pending_turn` → `Cancelled`, perform
    /// the pending-modal cleanup (the `interactive-request-close` frames), and remove
    /// the live-session bookkeeping.
    ///
    /// `pub(crate)`: the ONE close / clean-self-exit teardown — `close_session`
    /// only marks the close kind and `detach`s, reaching this site through the
    /// Worker's EXPECTED `Exited` — so it is also what a test asserts the
    /// per-session cleanup against.
    pub(crate) fn on_session_exited_expected(&self, session_id: &str) {
        // The `ClosedReason` mapping (the current `session.rs:876` shape): a
        // `close_session` (`CloseKind::User`) → `User`; a clean self-exit
        // (`None` — the Worker exited on its own) → `AgentExited`. Read OUTSIDE
        // the lock below (the `close_kind` `Arc` is copied out under it), so the
        // idempotent early-return for a session with no `live` slice stays
        // exactly where the old `live`-map `get` put it.
        let reason = self
            .with_session(session_id, |s| {
                s.live.as_ref().map(|live| {
                    let kind_guard = live.close_kind.lock().unwrap_or_else(|p| p.into_inner());
                    match *kind_guard {
                        Some(CloseKind::User) => ClosedReason::User,
                        None => ClosedReason::AgentExited,
                    }
                })
            })
            .flatten();
        let Some(reason) = reason else {
            return; // the session is already gone (idempotent).
        };
        // Resolve the in-flight `pending_turn` → `Cancelled` (a close / a clean self-
        // exit kills the turn — the composer unlocks; it never stays locked forever).
        self.resolve_turn_forced(session_id, StopReason::Cancelled);
        // The pending-modal cleanup (the `interactive-request-close` frames — the
        // unanswered-request-id diff: a session ending with an open prompt must NOT
        // leave a stuck modal).
        self.cleanup_pending_modals(session_id);
        // Remove the session's per-session state (`live` / `config_state` /
        // `naming` — a stalled-less row is removed wholesale; the `stalled` slice
        // is deliberately NEVER removed: ADR 0025 makes it the crash-attribution
        // source — the pushed `session-stalled` event and the pulled `stalled_info`
        // both read it, and the frontend banner may still be reading it).
        //
        // This is the ONE place the merge could have erased that attribution, and
        // the prohibition is pinned: a crash marks the session stalled and the
        // user then closes it, so the `detach` removes the `workers` entry first
        // and this teardown runs on a row that HOLDS a `stalled` slice. A
        // blanket "remove the row" here would delete the crash record mid-read,
        // so the stalled-bearing case clears the three slices IN PLACE and leaves
        // the row (grow-only, bounded by DISTINCT crashed sessions); a
        // stalled-less row goes wholesale — for a plain close the two shapes are
        // indistinguishable, and dropping the row keeps the map from holding
        // state for a session that is over.
        //
        // The naming semantics the deleted per-field comment used to explain are
        // preserved by this: an in-flight title request of a closing session
        // finds NO naming slice afterwards (`InFlightClaim::drop`,
        // `note_failure` and `note_success` all treat "missing → do not
        // re-create"), so nothing is resurrected for a session that is over.
        // The two lock acquisitions below are SEQUENTIAL (no guard is held into
        // the second call — the merge's lock discipline), and the invariant
        // survives either interleaving with a concurrent crash: if a crash
        // writes `stalled` BEFORE the read, this clears in place; if it writes
        // AFTER the read and this removes the row, the crash's own write goes
        // through the entry-or-default helper and re-creates the row holding its
        // `stalled` — so the attribution is never the loser.
        let stalled_row = self
            .with_session(session_id, |s| s.stalled.is_some())
            .unwrap_or(false);
        if stalled_row {
            self.with_session_mut(session_id, |row| {
                row.live = None;
                row.config_state = None;
                row.naming = None;
            });
        } else {
            self.remove_session(session_id);
        }
        // Emit the `session-closed` event (the `ClosedReason` payload — the frontend's
        // close handling).
        if let Some(sink) = self.sink.get() {
            sink.emit(
                "session-closed",
                json!({
                    "sessionId": session_id,
                    "reason": reason.as_str(),
                }),
            );
        }
    }

    /// The pending-modal cleanup (the round-3 fix — the Worker's pending maps die with
    /// it, so the Supervisor tracks the cleanup state itself: per session, the
    /// `PermissionRequest` / `InteractiveRequest` frames it relayed MINUS the
    /// `*Response`s it sent = the UNANSWERED request ids — the Supervisor sees both
    /// halves of every round-trip, so the diff is exact). Emits the same
    /// `interactive-request-close` frames the in-process teardown emits for unanswered
    /// prompts (keyed by the unanswered ids; a session ending with an open
    /// permission / interactive prompt must NOT leave a stuck modal).
    fn cleanup_pending_modals(&self, session_id: &str) {
        let unanswered = self
            .with_session(session_id, |s| {
                s.live.as_ref().map(|live| {
                    live.pending_modal_ids
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .clone()
                })
            })
            .flatten();
        let Some(unanswered) = unanswered else {
            return;
        };
        if unanswered.is_empty() {
            return;
        }
        // The EMIT runs OUTSIDE the `sessions` lock (the sink is a re-emitting
        // `TauriSink` — an emit must never re-enter these maps under a guard).
        let Some(sink) = self.sink.get() else {
            return;
        };
        for request_id in unanswered {
            sink.emit(
                "interactive-request-close",
                json!({
                    "sessionId": session_id,
                    "requestId": request_id,
                }),
            );
        }
    }

    /// Track a relayed `PermissionRequest` / `InteractiveRequest` frame (the
    /// `pending_modal_ids` set — the pending-modal cleanup's source). The `id` is the
    /// request's `requestId` (the payload's key — the `interactive-request-close`
    /// frame's `requestId` field).
    ///
    /// A SUBAGENT's gates are NOT closed here: this set is reached only through
    /// `on_session_exited_expected` → `cleanup_pending_modals`, which a child's
    /// `Exited` never reaches (the arm is gated `!is_subagent`) and which returns
    /// without a `live` entry that a child never has. A torn-down child closes
    /// its OWN cards from `finish_subagent` (`worker/manager.rs`, ADR 0055).
    fn track_modal(&self, session_id: &str, id: &str) {
        self.with_session_mut(session_id, |row| {
            if let Some(live) = row.live.as_mut() {
                let mut ids_guard = live
                    .pending_modal_ids
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                ids_guard.insert(id.to_string());
            }
        });
    }
}

/// Is `name` (a bare file name) a **Worker** crash log — in either of the
/// two shapes that exist on disk?
///
/// - `crash-<ts>-worker.log` — the pre-amendment shape, still sitting in
///   users' data dirs from before the writer stamped its pid in.
/// - `crash-<ts>-worker-<pid>.log` — the current shape (`crashlog.rs`'s
///   `write_crash`).
///
/// Both are accepted on purpose: the rename and this matcher landed in ONE
/// commit, so there was never an interval where the **Stalled** banner's
/// crash-log link matches nothing — and no integration test would notice
/// (`tests/ipc.rs`'s crash case asserts only `at`, never `crashLog`).
///
/// The pid arm is a pure SUFFIX check and that is safe: `worker-` pins
/// where the digit run starts and the `.` ends it, so no name can end in
/// `-worker-<digits>.log` while meaning something else (brute-forced over
/// every pid/other pair in `1..3000`: zero false positives). Do NOT
/// "harden" this into a split-on-`-` parser — that only adds a way to
/// drift from the writer's format.
///
/// [`find_crash_log_for_pid`] is the only reader of this rule: it gates
/// BOTH of its arms (the crashed Worker's own pid-stamped log, and the
/// pid-less pre-amendment fallback when no pid was captured).
fn is_worker_crash_log_name(name: &str) -> bool {
    if !name.starts_with("crash-") {
        return false;
    }
    if name.ends_with("-worker.log") {
        return true;
    }
    // `-worker-<digits>.log`: peel the two fixed ends and require that
    // what is left is a NON-EMPTY run of ASCII digits — the pid.
    let Some(stem) = name.strip_suffix(".log") else {
        return false;
    };
    let Some((head, pid_part)) = stem.rsplit_once('-') else {
        return false;
    };
    head.ends_with("-worker")
        && !pid_part.is_empty()
        && pid_part.bytes().all(|b| b.is_ascii_digit())
}

/// Does `name` carry a `-<digits>.log` pid suffix (i.e. is it a
/// pid-STAMPED crash log, `crash-<ts>-<tag>-<pid>.log`)?
///
/// The SAME suffix peel [`is_worker_crash_log_name`] uses — peel `.log`,
/// then the last `-`, then require a non-empty ASCII-digit run. No field
/// splitting: only the end of the name is ever inspected.
fn has_pid_suffix(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".log") else {
        return false;
    };
    let Some((_, tail)) = stem.rsplit_once('-') else {
        return false;
    };
    !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit())
}

/// The crash log belonging to `pid` — the `StalledInfo`'s `crash_log`,
/// globbed ONCE and then FROZEN (crash logs are diagnostic, not load-bearing).
///
/// Attribution is by IDENTITY, not by recency. With N concurrent **Subagent**
/// Workers, the newest log on disk routinely belongs to a *different* Worker,
/// and the recency rule this replaced sent the **Stalled** banner to the wrong
/// post-mortem. The Supervisor knows which child it just reaped — the handle's
/// pid, captured at spawn because `Child::id()` is `None` after the reap — and
/// the writer stamps that pid into the name (`crashlog`'s `write_crash`).
///
/// - `Some(pid)` → the entry named `crash-<…>-worker-<pid>.log`. No match is
///   `None`, deliberately: the old rule returned *some* log whenever the dir
///   held one, so a crash whose own log had been pruned linked the user at an
///   unrelated Worker's crash. A banner with NO link beats a WRONG one, and
///   `StalledInfo.crash_log` is an `Option` the banner already renders.
/// - `None` (the pid was never captured) → the newest PRE-amendment log, i.e.
///   [`is_worker_crash_log_name`] minus anything carrying a pid suffix. Those
///   pid-less names are what sits in users' data dirs from before the writer
///   stamped its pid, and a query that does not know the pid must not blame a
///   log that names a specific process.
///
/// The directory comes from the CALLER (the `SessionManager`'s `crash_log_dir`
/// late-wire), never from a resolver here: a router that resolved the
/// platform data dir itself could not be tested over a temp dir — and a
/// crash-log dir resolved deep in a call chain is the exact shape the
/// [`crate::agent::crashlog`] census forbids in the panic path.
fn find_crash_log_for_pid(dir: &std::path::Path, pid: Option<u32>) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    // The pid-stamped tail this Worker owns, e.g. `worker-4242.log`. Built
    // once, outside the loop.
    let owned = pid.map(|p| format!("worker-{p}.log"));
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_mine = match &owned {
            // The crashed Worker's own log: the shared `crash-`-anchored
            // predicate PLUS the exact pid tail. Both halves carry weight —
            // the tail alone would accept any file that merely ENDS
            // `worker-<pid>.log` (a `notes-worker-1.log` answers a query for
            // pid 1), and the predicate alone is the recency rule this fn
            // replaced. Keeping the predicate shared with the fallback arm
            // also stops the two name readers drifting apart.
            Some(tail) => is_worker_crash_log_name(&name) && name.ends_with(tail.as_str()),
            // No pid: only the pid-less pre-amendment shape is attributable.
            None => is_worker_crash_log_name(&name) && !has_pid_suffix(&name),
        };
        if is_mine {
            if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
                if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                    newest = Some((mtime, entry.path()));
                }
            }
        }
    }
    newest.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::oneshot;

    use super::*;
    use crate::agent::events::RpcEvent;
    use crate::agent::session::LiveWorkerSession;

    #[test]
    fn subagent_agent_settled_does_not_resolve_parent_turn() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // A subagent settles under the parent's delivery id (`is_subagent: true`).
        manager.route_event(
            sid,
            true,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );

        // The parent's turn MUST NOT be resolved!
        assert!(
            rx.try_recv().is_err(),
            "parent turn must still be in flight"
        );

        // When the parent itself settles (`is_subagent: false`), the turn resolves.
        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::Event(RpcEvent::agent_settled),
        );
        assert_eq!(rx.try_recv().unwrap(), StopReason::EndTurn);
    }

    #[test]
    fn subagent_exited_does_not_close_parent_session() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let (tx, mut rx) = oneshot::channel();
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(Some(tx))),
                cancel_requested: Arc::new(StdMutex::new(false)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        // A subagent exits under the parent's delivery id (`is_subagent: true`).
        manager.route_event(sid, true, WorkerInboundEvent::Exited(Some(0)));

        // The parent's session must still be live and pending turn untouched!
        // (The same `contains_key` predicate the `live` map answered — now the
        // row's `live` slice, read through the accessor.)
        assert!(manager
            .with_session(sid, |s| s.live.is_some())
            .unwrap_or(false));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn fetch_render_request_does_not_track_modal() {
        let manager = SessionManager::new(PathBuf::from("/tmp"));
        let sid = "main-session";
        manager.with_session_entry(sid, |row| {
            row.live = Some(LiveWorkerSession {
                cwd: PathBuf::from("/tmp"),
                close_kind: Arc::new(StdMutex::new(None)),
                pending_turn: Arc::new(StdMutex::new(None)),
                cancel_requested: Arc::new(StdMutex::new(false)),
                pending_modal_ids: StdMutex::new(HashSet::new()),
            });
        });

        manager.route_event(
            sid,
            false,
            WorkerInboundEvent::FetchRenderRequest {
                id: "render-1".to_string(),
                payload: serde_json::json!({
                    "sessionId": sid,
                    "requestId": "render-1",
                    "url": "https://example.com",
                    "timeoutMs": 5000,
                }),
            },
        );

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let modals = manager
            .with_session(sid, |s| {
                s.live
                    .as_ref()
                    .map(|session| session.pending_modal_ids.lock().unwrap().clone())
            })
            .flatten()
            .expect("the seeded live session is still there");
        assert!(
            !modals.contains("render-1"),
            "fetch render request must NOT be tracked as a user modal"
        );
    }

    /// The crash-log NAME matcher accepts BOTH shapes — the pre-amendment
    /// `crash-<ts>-worker.log` and the pid-stamped `crash-<ts>-worker-<pid>.log`
    /// — because the rename and the matcher land in one commit: a banner
    /// whose link silently stops matching is invisible to the integration
    /// suite (`tests/ipc.rs`'s crash case asserts only `at`, never
    /// `crashLog`).
    ///
    /// Tested as a PURE function (no filesystem) on purpose: the two shapes
    /// it accepts are a string rule, and the selector that consumes it
    /// ([`find_crash_log_for_pid`]) is tested separately over temp dirs.
    #[test]
    fn is_worker_crash_log_name_accepts_both_shapes() {
        // The pre-amendment shape (still on disk from before the rename)
        // and the pid-stamped shape.
        assert!(
            is_worker_crash_log_name("crash-1-worker.log"),
            "the pid-less pre-amendment name still matches"
        );
        assert!(
            is_worker_crash_log_name("crash-1-worker-4242.log"),
            "the pid-stamped name matches"
        );

        // Every negative: a different tag, an empty pid, a non-numeric
        // pid, the wrong extension, and a name that merely ENDS like ours
        // without the `crash-` prefix.
        for rejected in [
            "crash-1-supervisor.log",
            "crash-1-worker-.log",
            "crash-1-worker-abc.log",
            "crash-1-worker-4242.txt",
            "notes-worker-1.log",
        ] {
            assert!(
                !is_worker_crash_log_name(rejected),
                "`{rejected}` is not a Worker crash log"
            );
        }
    }

    // ── The pid-based crash-log selector ──────────────────────────────────

    /// Seed `<dir>/<name>` with a given age (seconds ago), so a test can
    /// state which of two crash logs is the NEWER one without racing the
    /// filesystem's mtime granularity. `now - secs_ago` — the larger
    /// `secs_ago`, the OLDER the file.
    fn seed_crash_log(dir: &std::path::Path, name: &str, secs_ago: u64) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "x").expect("the seeded crash log is writable");
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("the seeded crash log is re-openable")
            .set_modified(mtime)
            .expect("the seeded crash log's mtime is settable");
        path
    }

    /// A throwaway directory to seed crash logs into (the selector takes
    /// the directory — that is the whole point of Task 6's seam).
    ///
    /// An owning [`ScratchDir`](crate::test_support::ScratchDir) (#96 task 04):
    /// this used to mint a bare `crashsel-{uuid}` and remove nothing, leaking
    /// one dir per test per run. The prefix stays VERBATIM — only the tag is
    /// new — so #96's census keeps attributing it here.
    fn crash_dir() -> crate::test_support::ScratchDir {
        crate::test_support::ScratchDir::in_env_temp("crashsel-", "select")
    }

    /// Attribution is by IDENTITY, not by recency: with N concurrent
    /// **Subagent** Workers, the newest log on disk is routinely a
    /// *different* Worker's crash, and a banner that names it sends the
    /// user to the wrong post-mortem. The pid the Supervisor holds (the
    /// handle's, captured at spawn) picks the owner's log even when some
    /// other Worker died LATER.
    #[test]
    fn the_pid_named_log_wins_over_a_newer_foreign_one() {
        let dir = crash_dir();
        let mine = seed_crash_log(&dir, "crash-1000-worker-4242.log", 120);
        // A FOREIGN Worker's crash, stamped NEWER — recency would pick it.
        seed_crash_log(&dir, "crash-2000-worker-9999.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, Some(4242)).as_deref(),
            Some(mine.as_path()),
            "the log belonging to pid 4242 wins over a newer foreign crash log"
        );
    }

    /// A crash log written before the pid stamping landed sits in the
    /// user's data dir with NO pid in its name, and a crash whose pid the
    /// Supervisor could not capture queries with `None` — that pair must
    /// still resolve, or the amendment silently drops the banner's link
    /// for exactly the users whose old logs are already on disk.
    #[test]
    fn a_pid_less_log_is_still_found_when_the_pid_is_unknown() {
        let dir = crash_dir();
        let old = seed_crash_log(&dir, "crash-1000-worker.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, None).as_deref(),
            Some(old.as_path()),
            "the pre-amendment pid-less log is still attributed when no pid is known"
        );
    }

    /// A pid-less query never blames a log that names a SPECIFIC process.
    ///
    /// ⚠ This is NOT a vacuous clause, which is easy to assume:
    /// [`is_worker_crash_log_name`] accepts BOTH name shapes (so a rename can
    /// never strand the banner), which means a pid-stamped name DOES satisfy
    /// the predicate — only this suffix check keeps it out of a pid-less
    /// answer. Delete it and a query that explicitly does not know a pid
    /// picks a named process's log.
    #[test]
    fn a_pid_less_query_never_names_a_pid_stamped_log() {
        let dir = crash_dir();
        // Only pid-stamped logs — nobody's pid is known, so nothing is
        // attributable to an anonymous query.
        seed_crash_log(&dir, "crash-1000-worker-4242.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, None),
            None,
            "a query with no pid must not answer with a log that names pid 4242"
        );
    }

    /// A pid that matches NOTHING yields `None`, NOT "the newest log I
    /// could find". The old recency rule always returned *a* path, so a
    /// crashed Worker whose log was already pruned pointed the user at an
    /// unrelated crash — a wrong link is worse than no link, and
    /// `StalledInfo.crash_log` is an `Option` the banner already renders.
    #[test]
    fn an_unmatched_pid_returns_no_log_rather_than_guessing() {
        let dir = crash_dir();
        // A perfectly good Worker crash log — belonging to somebody else.
        seed_crash_log(&dir, "crash-2000-worker-9999.log", 0);
        // And a file whose TAIL matches the queried pid but that is no crash
        // log at all: the pid tail alone must not be the whole rule (the
        // shared `crash-`-anchored predicate still has to agree).
        seed_crash_log(&dir, "notes-worker-1.log", 0);

        assert_eq!(
            find_crash_log_for_pid(&dir, Some(1)),
            None,
            "a pid with no matching log must not borrow another Worker's crash, \
             and must not pick a non-crash file that merely ends `worker-1.log`"
        );
    }

    #[test]
    fn sink_frame_interactive_event_todos_update_persists_for_main_not_subagent() {
        let dir = crate::test_support::ScratchDir::in_env_temp("router-todos-", "persist");
        let db = Arc::new(crate::storage::Db::open(&dir.join("t.db")).unwrap());

        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());

        struct LocalTestSink {
            emitted: Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
        }
        impl crate::agent::events::EventSink for LocalTestSink {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.emitted
                    .lock()
                    .unwrap()
                    .push((event.to_string(), payload));
            }
        }
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        manager.set_sink(Arc::new(LocalTestSink {
            emitted: emitted.clone(),
        }));

        let main_sid = "main-session";
        let sub_sid = "sub-session";

        db.record_session(&crate::agent::SessionInfo {
            session_id: main_sid.to_string(),
            cwd: dir.to_path_buf(),
            capabilities: serde_json::Value::Null,
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .unwrap();

        db.record_session(&crate::agent::SessionInfo {
            session_id: sub_sid.to_string(),
            cwd: dir.to_path_buf(),
            capabilities: serde_json::Value::Null,
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: true,
        })
        .unwrap();

        let todos_payload = serde_json::json!({
            "sessionId": main_sid,
            "seq": 0,
            "event": "todos_update",
            "payload": {
                "source": "native",
                "todos": [
                    { "content": "do laundry", "status": "pending" }
                ]
            }
        });

        // (a) Main session (is_subagent: false):
        // receiving SinkFrame writes todos_json in db AND re-emits to sink.
        manager.route_event(
            main_sid,
            false,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: todos_payload.clone(),
            },
        );

        let stored = db
            .session_todos(main_sid)
            .unwrap()
            .expect("main session todos should be stored");
        assert!(stored.contains("do laundry"));
        {
            let frames = emitted.lock().unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].0, "interactive-event");
            assert_eq!(frames[0].1, todos_payload);
        }

        // (b) Subagent session (is_subagent: true):
        // receiving the same frame does NOT touch db.session_todos(sub_sid)
        let sub_payload = serde_json::json!({
            "sessionId": sub_sid,
            "seq": 0,
            "event": "todos_update",
            "payload": {
                "source": "native",
                "todos": [
                    { "content": "subagent work", "status": "pending" }
                ]
            }
        });
        manager.route_event(
            sub_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: sub_payload.clone(),
            },
        );

        assert_eq!(
            db.session_todos(sub_sid).unwrap(),
            None,
            "subagent todos must not be written to db"
        );
        {
            let frames = emitted.lock().unwrap();
            assert_eq!(frames.len(), 2, "sink frame is still re-emitted to UI");
            assert_eq!(frames[1].0, "interactive-event");
            assert_eq!(frames[1].1, sub_payload);
        }
    }

    /// What `manager_with_rows` hands back. The scratch dir comes FIRST so a
    /// caller that destructures it into a `_dir` binding declared first drops
    /// it LAST — the `Db`'s SQLite file lives INSIDE the dir (the same
    /// ordering rule the `persist.rs` `temp_db` doc records; Linux cannot show
    /// the failure, Windows can). Named because a 4-tuple return trips
    /// `clippy::type_complexity` and this crate runs clippy at 0 warnings.
    type Harness = (
        crate::test_support::ScratchDir,
        SessionManager,
        Arc<crate::storage::Db>,
        Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
    );

    /// A harness: a `SessionManager` over a real `Db` + a recording sink (its
    /// `persister` wired by `attach_db`), with EXACTLY the rows `rows` names
    /// pre-recorded (`(session_id, is_subagent)`).
    ///
    /// Which rows exist is the caller's business on purpose: a test that wants
    /// the ROUTER's gate alone pre-seeds both rows (`manager_with_rows`), while
    /// a test that wants the row-ensure in the frame — the shape a cold child
    /// really has — seeds only the parent.
    fn manager_seeded(tag: &str, rows: &[(&str, bool)]) -> Harness {
        let dir = crate::test_support::ScratchDir::in_env_temp(tag, "persist");
        let db = Arc::new(crate::storage::Db::open(&dir.join("t.db")).unwrap());

        struct LocalTestSink {
            emitted: Arc<StdMutex<Vec<(String, serde_json::Value)>>>,
        }
        impl crate::agent::events::EventSink for LocalTestSink {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.emitted
                    .lock()
                    .unwrap()
                    .push((event.to_string(), payload));
            }
        }
        let emitted = Arc::new(StdMutex::new(Vec::new()));

        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_sink(Arc::new(LocalTestSink {
            emitted: emitted.clone(),
        }));

        for (sid, is_subagent) in rows {
            db.record_session(&crate::agent::SessionInfo {
                session_id: sid.to_string(),
                cwd: dir.to_path_buf(),
                capabilities: serde_json::Value::Null,
                config_options: None,
                archived: false,
                title: None,
                context_usage: None,
                cost_usd: None,
                is_subagent: *is_subagent,
            })
            .unwrap();
        }
        (dir, manager, db, emitted)
    }

    /// The both-rows harness: parent AND child rows pre-recorded, so the test
    /// sees the ROUTER's gate and its target extraction with the persister's
    /// row-ensure already out of the way (the row-ensure has its own pin in
    /// `persist.rs`).
    fn manager_with_rows(tag: &str, main_sid: &str, sub_sid: &str) -> Harness {
        manager_seeded(tag, &[(main_sid, false), (sub_sid, true)])
    }

    /// The gate is narrowed PER EVENT, not deleted: a subagent's own
    /// `cost_update` now persists to the CHILD's row (a child's spend is its
    /// own money, and issue #105 needs the child's stored figure to match its
    /// card), while a subagent's `todos_update` STILL does not — the todo
    /// panel is a main-session surface, and that half is pinned unmodified by
    /// `sink_frame_interactive_event_todos_update_persists_for_main_not_subagent`.
    /// Re-emission to the UI is unaffected either way (the sink arm is
    /// unconditional).
    ///
    /// The delivery mirrors the PUMP's real shape, not a convenient one: a
    /// subagent's frames arrive under the PARENT's delivery id (`pump.rs`'s
    /// `delivery_id`) with the CHILD's id only in the payload's `sessionId`.
    /// So this test also pins WHICH row the child's money lands on — the
    /// child's. Getting that wrong is not cosmetic: the child's per-call
    /// deltas would accumulate on the parent's row and `finish_subagent`'s
    /// roll-up would add the child's sum a second time, double-counting every
    /// child in the parent's stored figure.
    #[test]
    fn a_subagent_cost_frame_persists_but_a_subagent_todo_frame_still_does_not() {
        let (main_sid, sub_sid) = ("main-session", "sub-session");
        let (_dir, manager, db, emitted) = manager_with_rows("router-cost", main_sid, sub_sid);

        // Delivered under the PARENT's id (what the pump does), payload keyed
        // to the CHILD (what the emitting loop writes).
        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "cost_update",
                    "payload": { "costUsd": 0.00001243, "source": "main" },
                }),
            },
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            Some(0.00001243),
            "a child's own cost frame writes the CHILD's row"
        );
        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            None,
            "the child's money must NOT land on the delivery id's row — that id \
             is the PARENT's, and the roll-up would add the child's sum again on top"
        );

        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "todos_update",
                    "payload": {
                        "source": "native",
                        "todos": [{ "content": "subagent work", "status": "pending" }],
                    },
                }),
            },
        );
        assert_eq!(
            db.session_todos(sub_sid).unwrap(),
            None,
            "todos persistence stays MAIN-ONLY — the gate must not be widened \
             generically (this is the assertion the pre-existing gate test pins)"
        );
        assert_eq!(
            db.session_todos(main_sid).unwrap(),
            None,
            "and a child's todo frame must not be redirected onto the parent's row either"
        );

        let frames = emitted.lock().unwrap();
        assert_eq!(
            frames.len(),
            2,
            "both frames are still re-emitted to the UI verbatim"
        );
        assert_eq!(frames[0].1["event"], "cost_update");
        assert_eq!(frames[1].1["event"], "todos_update");
    }

    /// A COLD child's first cost frame — the row does not exist yet — still
    /// lands on the CHILD's row, created by the persister's `ensure_session_row`,
    /// under the PARENT's delivery id.
    ///
    /// Why this needs a router-level pin at all: `persist.rs`'s
    /// `a_cost_frame_for_a_session_with_no_row_yet_still_persists` proves the
    /// no-row case by calling `apply_interactive_event` DIRECTLY with the child
    /// id — so the target the router computes is never involved. And the two
    /// sibling router pins pre-record BOTH rows, so the row-ensure is never
    /// involved. Neither half covers the combination, which is exactly what the
    /// real wire delivers: the pump re-targets a child frame's delivery id to
    /// the PARENT (`pump.rs`'s `delivery_id`) while the loop stamps the payload
    /// with the CHILD's `sessionId`, and the child's row is created by THIS
    /// frame.
    ///
    /// The combination is load-bearing in both directions. If the router keyed
    /// the write off the delivery id (`session_id`) instead of extracting the
    /// payload's id, the money would land on the parent's row — and here it
    /// would ALSO create the parent's `cost_usd` before the parent had spent
    /// anything, so `finish_subagent`'s roll-up would add the child's sum a
    /// second time on top. And if the row-ensure were dropped for this path,
    /// `record_session_cost`'s silent no-op on a missing row would discard the
    /// child's first figure without a sound — the child's card would show a
    /// cost its row never had.
    #[test]
    fn a_childs_first_cost_frame_under_the_parents_delivery_id_creates_and_writes_the_childs_row() {
        let (main_sid, sub_sid) = ("parent-cold", "child-cold");
        // ONLY the parent's row exists — the child is COLD (no `StoreFrame` has
        // created its row yet, which is the real ordering for a fast first call).
        let (_dir, manager, db, emitted) =
            manager_seeded("router-cold-child", &[(main_sid, false)]);
        assert!(
            db.session(sub_sid).unwrap().is_none(),
            "precondition: the child has NO row at all"
        );

        // Delivered under the PARENT's id (what the pump does), payload keyed
        // to the CHILD (what the emitting loop writes) — `is_subagent: true`.
        manager.route_event(
            main_sid,
            true,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: serde_json::json!({
                    "sessionId": sub_sid,
                    "seq": 0,
                    "event": "cost_update",
                    "payload": { "costUsd": 0.00001243, "source": "main" },
                }),
            },
        );

        // The row now exists — created by THIS frame — and carries the flag.
        let row = db
            .session(sub_sid)
            .unwrap()
            .expect("the router must reach the persister's ensure_session_row for a no-row child");
        assert!(
            row.is_subagent,
            "the row the router's target created is the ephemeral CHILD row"
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            Some(0.00001243),
            "the child's first figure lands on the CHILD's row, not into the void"
        );
        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            None,
            "the delivery id is the PARENT's: nothing of the child's money may \
             touch its row (that id has no figure yet, and the roll-up would \
             then add the child's sum again on top of it)"
        );

        let frames = emitted.lock().unwrap();
        assert_eq!(
            frames.len(),
            1,
            "re-emission is unaffected — the UI still sees the frame verbatim"
        );
        assert_eq!(frames[0].0, "interactive-event");
        assert_eq!(frames[0].1["sessionId"], sub_sid);
    }

    /// The roll-up's shape, proven where a `Db` is reachable.
    ///
    /// The frame synthesised below IS the envelope `finish_subagent`'s
    /// roll-up now emits: `state.hooks.on_event(parent_session_id, false,
    /// WorkerInboundEvent::SinkFrame { event: "interactive-event", payload })`
    /// with `sessionId` = the PARENT, `seq: 0`, `event: "cost_update"`, and
    /// `payload: { costUsd, source: "subagent" }`. Routing it instead of
    /// emitting it straight to the parent's Tauri sink is what makes the
    /// parent's STORED total agree with the figure under its own title.
    ///
    /// Why the assertion lives here and not in `subagent_flow.rs`'s
    /// `rollup_tests`: `ManagerState` holds only `workers` / `factory` /
    /// `hooks` / `drives` (`registry.rs`) — it has NO `db` field, so the
    /// roll-up unit tests can prove the FRAME (shape, count, parent-keying)
    /// but cannot assert a write at all. This test closes the link: that
    /// frame, through this router, lands on the PARENT's row. The end-to-end
    /// proof through the real IPC surface is `tests/ipc.rs` (Task 3).
    #[test]
    fn a_parent_keyed_cost_frame_from_the_router_writes_the_parents_row() {
        let (main_sid, sub_sid) = ("parent-1", "child-1");
        let (_dir, manager, db, emitted) = manager_with_rows("router-rollup", main_sid, sub_sid);

        let rollup = serde_json::json!({
            "sessionId": main_sid,
            "seq": 0,
            "event": "cost_update",
            "payload": { "costUsd": 0.0000341, "source": "subagent" },
        });
        manager.route_event(
            main_sid,
            false,
            WorkerInboundEvent::SinkFrame {
                event: "interactive-event".to_string(),
                payload: rollup.clone(),
            },
        );

        assert_eq!(
            db.session_cost(main_sid).unwrap(),
            Some(0.0000341),
            "the roll-up writes the PARENT's row — without this the parent's \
             stored figure disagrees with its displayed one"
        );
        assert_eq!(
            db.session_cost(sub_sid).unwrap(),
            None,
            "the roll-up is keyed to the parent: the child's row must stay clean"
        );
        let frames = emitted.lock().unwrap();
        assert_eq!(frames.len(), 1, "the frame still reaches the UI");
        assert_eq!(frames[0].0, "interactive-event");
        assert_eq!(
            frames[0].1, rollup,
            "re-emitted VERBATIM — the frontend contract is unchanged"
        );
    }
}
