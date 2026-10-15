//! The Supervisor-side Worker registry (ADR 0025 Task 3): the
//! `WorkerManager` (the registry of live Workers — session-keyed, the
//! `on_crash` / `on_event` callbacks threaded with the `is_subagent`
//! flag) + the Supervisor-side subagent-dispatch flow (a
//! main-session Worker's `subagent` tool → its `IpcDispatcher` →
//! `Outbound::SubagentDispatch` → here: the model-key resolution
//! (the ADR 0020/0023 resolution moved Supervisor-side), the
//! three-way `enabled_tools` rule, the child `StartEnv`, the
//! `SubagentCapture`, the `settle_timeout`, and the
//! `subagent-session-started` / `subagent-closed` UI lifecycle
//! events).
//!
//! The read-loop plumbing: each attached Worker's `events()` is
//! consumed by a pump task that (a) calls `on_event(session_id,
//! is_subagent, evt)` for EVERY variant (the Task-4 router splits UI
//! vs persistence — the `is_subagent` flag is known per attached
//! Worker: main `false`, subagent `true`), (b) on `SubagentDispatch`
//! runs `dispatch_subagent`, and (c) on `Exited` (unexpected — no
//! `detach` / `reap_all` in flight) calls `on_crash(session_id,
//! code); an EXPECTED `Exited` (a `detach` / `reap_all` was in
//! flight) fires NO `on_crash` (the Task-4 router's
//! `session-closed` handling, Task 4 step 1).
//!
//! The state is `Arc`-backed (`ManagerState`): the pump / drive tasks
//! are `tokio::spawn`ed (`'static`), so they own clones of the `Arc`
//! — the `&self` methods delegate to the `Arc`-backed free functions.

/// The default subagent settle bound (30 min: a hung / slow subagent
/// turn is torn down at the bound).
pub const DEFAULT_SUBAGENT_SETTLE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30 * 60);

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::watch;

use crate::agent::debuglog;
use crate::agent::events::EventSink;
use crate::agent::events::RpcEvent;
use crate::agent::harness::prompt::build_child_system_message;
use crate::agent::harness::r#loop::tool_specs;
use crate::agent::harness::{ModelKey, ModelRef};
use crate::agent::is_bookkeeping_message_id;
use crate::agent::session::resolve_composed_model;
use crate::agent::subagent::{SubagentFailureReason, SubagentMetrics, SubagentOutcome};
use crate::agent::types::mint_session_id;
use crate::agent::worker::client::{WorkerError, WorkerHandle, WorkerInboundEvent};
use crate::agent::worker::protocol::{Inbound, StartEnv, StartMode, SubagentDispatchWire};

/// The Worker spawn seam (the test injection point): production is
/// `WorkerHandle::spawn(std::env::current_exe().as_path())`; tests are
/// the `fake_worker` binary (the manifest-dir path convention).
pub trait WorkerFactory: Send + Sync {
    fn spawn(&self) -> Result<WorkerHandle, WorkerError>;
}

/// The `SubagentOutcome` delivery target (the `dispatch_subagent` flow's
/// two callers): the REQUESTING (main-session) Worker (the
/// `IpcDispatcher` waiter resolves — the `SubagentResult` frame) or the
/// in-process `dispatch_native`'s oneshot (the `SubagentSessionManager`
/// re-plumb — ADR 0025 Task 5; there is no requesting Worker — the
/// outcome resolves the oneshot directly).
enum SubagentOutcomeSink {
    /// The requesting (main-session) Worker (the `SubagentResult` frame
    /// — the `IpcDispatcher` waiter resolves; a dropped waiter is a
    /// no-op).
    Requester,
    /// The in-process `dispatch_native`'s oneshot (an `Arc`'d sender —
    /// `deliver` is a shared-reference method, so the `send`'s move is
    /// of the `Arc`, not the sender; a dropped receiver is a no-op).
    Oneshot(
        std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<SubagentOutcome>>>>,
    ),
}

impl SubagentOutcomeSink {
    /// Deliver the outcome (the `Requester` sends the `SubagentResult`
    /// frame to the requesting Worker; the `Oneshot` resolves the
    /// sender). A miss (a dead Worker / a dropped receiver) is a no-op.
    fn deliver(
        &self,
        state: &ManagerState,
        parent_session_id: &str,
        wire: &SubagentDispatchWire,
        outcome: SubagentOutcome,
    ) {
        match self {
            SubagentOutcomeSink::Requester => {
                let _ = send_subagent_result(state, parent_session_id, wire, outcome);
            }
            SubagentOutcomeSink::Oneshot(slot) => {
                if let Some(tx) = slot.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(outcome);
                }
            }
        }
    }
}

/// The `SubagentCapture` (reviewer-corrected: capture from the subagent's
/// `SinkFrame` `session-update` stream — the enveloped `agent_message_chunk`
/// frames — the last-`messageId`-with-non-empty-text rule; NOT from the
/// `message_end` `RpcEvent`s, which are a different shape and carry no text
/// for tool-call messages). The `message_update` `usage` fields feed the
/// metrics' token fields (the `SubagentMetrics` accumulation).
pub struct SubagentCapture {
    /// `messageId` → accumulated text (a `HashMap` has no insertion
    /// order — the LAST id is tracked separately).
    text: StdMutex<HashMap<String, String>>,
    /// The LAST `messageId` with a non-empty capture (updated on every
    /// non-empty capture of a chunk that is NOT harness bookkeeping — the
    /// final-output source; the bookkeeping chunks (`normalize::
    /// is_bookkeeping_message_id`: the shared one-liner key and the
    /// `retract:N` discard line, EITHER stamped — `{stamp}:system` /
    /// `{stamp}:retract:N`, the shape production emits (ADR 0049) — OR bare,
    /// which is the pre-stamp id shape: the test fixtures that hand-write these
    /// ids and `TurnState::default()`'s empty stamp) are NEVER captured: a
    /// failed child turn must not settle with a one-liner as its output, and a
    /// parent must never read a discard line as its child's answer). NOTE the
    /// scope: `observe_sink_frame` reads LIVE frames off the Worker's stdout and
    /// never touches the `messages` table, so the bare shape is accepted for an
    /// id with NO stamp — not because any stored database is re-read here.
    last_message_id: StdMutex<Option<String>>,
    /// The `message_update` `usage` accumulation (the `inputTokens` /
    /// `outputTokens` fields — the MAX across the frames: a turn's
    /// usage is cumulative per message, the last is the largest).
    usage: StdMutex<(u64, u64)>,
}

impl Default for SubagentCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl SubagentCapture {
    pub fn new() -> Self {
        Self {
            text: StdMutex::new(HashMap::new()),
            last_message_id: StdMutex::new(None),
            usage: StdMutex::new((0, 0)),
        }
    }

    /// Observe one `SinkFrame` (the `session-update`
    /// `agent_message_chunk` frames — the ENVELOPED shape:
    /// `{ sessionId, update }`; the `update`'s `sessionUpdate`
    /// discriminator is `agent_message_chunk`). A `session-update`
    /// `message_retracted` frame (ADR 0048) ERASES the Abandoned
    /// attempt's text for the `messageId` it names.
    pub fn observe_sink_frame(&self, event: &str, payload: &Value) {
        if event != "session-update" {
            return;
        }
        let update = payload.get("update");
        // (ADR 0048) A Retraction discards the abandoned attempt's text HERE too.
        // This map is what `captured_text()` hands the PARENT as the subagent tool
        // result, so a retried child would otherwise feed the parent `partdone`.
        if update
            .and_then(|u| u.get("sessionUpdate"))
            .and_then(Value::as_str)
            == Some("message_retracted")
        {
            if let Some(id) = update
                .and_then(|u| u.get("messageId"))
                .and_then(Value::as_str)
            {
                self.text
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(id);
                let mut last = self
                    .last_message_id
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if last.as_deref() == Some(id) {
                    *last = None;
                }
            }
            return;
        }
        if update
            .and_then(|u| u.get("sessionUpdate"))
            .and_then(Value::as_str)
            != Some("agent_message_chunk")
        {
            return;
        }
        let mid = update
            .and_then(|u| u.get("messageId"))
            .and_then(Value::as_str);
        let delta = update
            .and_then(|u| u.get("content"))
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str);
        if let (Some(mid), Some(delta)) = (mid, delta) {
            if !delta.is_empty() && !is_bookkeeping_message_id(mid) {
                let mut text = self.text.lock().unwrap_or_else(|p| p.into_inner());
                text.entry(mid.to_string()).or_default().push_str(delta);
                *self
                    .last_message_id
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(mid.to_string());
            }
        }
    }

    /// Observe one `RpcEvent` (the `message_update` `usage` field —
    /// the metrics' token fields; the other events are ignored).
    pub fn observe_event(&self, event: &RpcEvent) {
        if let RpcEvent::message_update { usage, .. } = event {
            let input = usage
                .get("inputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("outputTokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let mut u = self.usage.lock().unwrap_or_else(|p| p.into_inner());
            u.0 = u.0.max(input);
            u.1 = u.1.max(output);
        }
    }

    /// The last-`messageId`-with-non-empty-text ("" when no chunk
    /// arrived — a tool-using turn does NOT concatenate every
    /// intermediate message).
    pub fn captured_text(&self) -> String {
        let last = self
            .last_message_id
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        last.and_then(|id| {
            self.text
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&id)
                .cloned()
        })
        .unwrap_or_default()
    }

    /// The accumulated usage (the metrics' token fields — the MAX
    /// across the `message_update` frames).
    pub fn usage(&self) -> (u64, u64) {
        *self.usage.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn input_tokens(&self) -> u64 {
        self.usage().0
    }

    pub fn output_tokens(&self) -> u64 {
        self.usage().1
    }
}

/// The subagent's liveness signal (ADR 0055): `seq` bumps on EVERY frame the
/// pump sees for this child, and `in_flight` holds the `tool_call_id`s that
/// have been ANNOUNCED (`tool_execution_start`) and not yet closed
/// (`tool_execution_end`) — NOT "currently executing" (a batch announces every
/// call before running any of them, so the set is deliberately generous).
/// The skew is one-directional: it can only keep a child alive longer, never
/// cut it sooner.
///
/// A `HashSet` and NOT a counter, deliberately: ADR 0048 has the cancel and
/// turn-abandoned paths emit `tool_execution_end` for calls that were announced
/// but never dispatched, so an `end` without a `start` is LEGAL. A counter would
/// go negative and un-block a child that is still working; a set's removal is
/// idempotent.
#[derive(Debug, Default)]
pub struct SubagentLiveness {
    pub seq: u64,
    pub in_flight: std::collections::HashSet<String>,
    /// The subset of `in_flight` whose tool opened a **gate** the user has not
    /// answered (`PermissionRequest` / `InteractiveRequest` seen, tool not yet
    /// closed). Drained at teardown to close the child's own cards (ADR 0055) —
    /// on `SubagentLiveness`, NOT a second `SubagentDrive` field, so the pump
    /// reaches it through the one `feed_capture` borrow; two overlapping sets on
    /// the drive would drift.
    pub open_gates: std::collections::HashSet<String>,
}

/// Bump the liveness clock for ONE frame the pump saw (ADR 0055). A
/// `SinkFrame` — the child's `session-update` text stream — is NOT an
/// `RpcEvent` and carries no tool boundary at all, so the frame count is a
/// SEPARATE fact from the outstanding-call set: a child that only streams
/// tokens is an **Active Subagent** and must register as such.
fn note_liveness_frame(liveness: &mut SubagentLiveness) {
    liveness.seq += 1;
}

/// Bump the liveness clock for one `RpcEvent` AND maintain the outstanding
/// `tool_call_id` set (ADR 0055): the set means "ANNOUNCED and not yet closed",
/// so `tool_execution_start` adds the id (the announce fires while the Provider
/// still streams the `toolCall` — before the batch executes anything) and
/// `tool_execution_end` removes it. The removal is idempotent on purpose: an
/// `end` whose call was never announced is a LEGAL frame (ADR 0048's cancel /
/// turn-abandoned paths close announced-but-never-dispatched calls), and a
/// child parked on a **gate** holds its id open for the whole wait.
///
/// Everything else leaves the set alone — the clock still advances.
fn note_liveness_event(liveness: &mut SubagentLiveness, event: &RpcEvent) {
    liveness.seq += 1;
    match event {
        RpcEvent::tool_execution_start { tool_call_id, .. } => {
            liveness.in_flight.insert(tool_call_id.clone());
        }
        RpcEvent::tool_execution_end { tool_call_id, .. } => {
            liveness.in_flight.remove(tool_call_id);
            // A gate the user ANSWERED closes its own tool call, so the same
            // id removes it here — which is exactly why an answered gate is
            // ABSENT at teardown and needs no separate drain (ADR 0055).
            liveness.open_gates.remove(tool_call_id);
        }
        _ => {}
    }
}

/// Record one unanswered **gate** (ADR 0055): the child's
/// `PermissionRequest` / `InteractiveRequest` frame announces a gate the user
/// has not answered, and its id IS the `tool_call_id` of the tool the child is
/// parked inside (`gate_tool` passes `&tc.id` to `native_permission_gate`; the
/// `ask` flow's interactive `requestId` is the `toolCallId` too) — ONE id space,
/// which is what lets `tool_execution_end` clear it.
///
/// The sudo sub-prompts are the exception: their `requestId`s are the DERIVED
/// `"{request_id}:confirm"` / `":password"` forms, so the suffix is stripped
/// here and the set holds tool-call ids only (both sub-prompts of one sudo tool
/// are therefore ONE gate — correct, since the tool is one call).
///
/// Touches ONLY `open_gates`: the gate's tool call was already announced, so
/// `in_flight` covers it, and the frame-count contract stays owned by the
/// pump's `SinkFrame` / `Event` arms.
fn note_liveness_gate(liveness: &mut SubagentLiveness, request_id: &str) {
    let tool_call_id = request_id
        .strip_suffix(":confirm")
        .or_else(|| request_id.strip_suffix(":password"))
        .unwrap_or(request_id);
    liveness.open_gates.insert(tool_call_id.to_string());
}

/// The in-flight subagent dispatch's bookkeeping (the `drives` map
/// value — the pump reads it on the subagent's `agent_settled` /
/// `Exited`; the drive task removes it on the UNCONDITIONAL teardown):
/// the settle watch (the pump flips it on `agent_settled`), the cancel
/// watch (the `SubagentCancel` flow — `cancel_subagent` flips it), the
/// `SubagentCapture` (the pump feeds it; the drive task reads the
/// final text on settle), the handle (the `cancel_subagent`'s
/// `send_abort`), and the `reaping` flag (the drive task's teardown
/// sets it — the `Exited` is EXPECTED: NO `on_crash`).
struct SubagentDrive {
    /// The PARENT session id (the subagent's UI belongs to the
    /// parent's scope — the pump delivers the subagent's frames
    /// under this id + the `is_subagent` flag; the `on_event`
    /// router uses it for the UI delivery, the flag for the
    /// subagent-specific handling).
    parent_session_id: String,
    /// The DISPATCH id (the `SubagentDispatchWire`'s `id` — what the
    /// requesting Worker's `IpcDispatcher` cancel watcher names in its
    /// `SubagentCancel` frame; the `drives` map is keyed by the CHILD
    /// session id, so the frame's id is matched through this field).
    dispatch_id: String,
    settle_tx: watch::Sender<bool>,
    cancel_tx: watch::Sender<bool>,
    /// The child's liveness signal (ADR 0055 — the `SubagentLiveness`
    /// doc): the pump bumps it on EVERY frame it sees for this child
    /// and maintains the outstanding `tool_call_id` set. The drive
    /// task's receiver half is threaded through `drive_subagent`.
    liveness_tx: watch::Sender<SubagentLiveness>,
    capture: Arc<SubagentCapture>,
    handle: Option<WorkerHandle>,
    reaping: bool,
}

/// One live Worker (the `attach`-time `StartEnv` + the `reaping`
/// flag — an `Exited` while reaping is EXPECTED: no `on_crash`).
struct WorkerEntry {
    handle: WorkerHandle,
    env: StartEnv,
    reaping: bool,
}

/// The `WorkerManager`'s `Arc`-backed state (the pump / drive tasks
/// own clones of the `Arc` — the `&self` methods delegate to the
/// `Arc`-backed free functions; the `StdMutex` fields are NOT
/// `Clone`, so the `Arc` wrap is the `'static` move).
struct ManagerState {
    /// session_id → the live Worker (the `attach`-time `StartEnv` —
    /// the `dispatch_subagent` reads the parent's effective `catalog`
    /// / `config_dir` / `trusted` from it — the Supervisor owns them).
    workers: StdMutex<HashMap<String, WorkerEntry>>,
    /// The test seam (production: `current_exe()`; tests: the
    /// `fake_worker` binary).
    factory: Arc<dyn WorkerFactory>,
    /// (session_id, exit code) — the Task-4 stalled-session callback
    /// (an UNEXPECTED exit — no `detach` / `reap_all` in flight).
    on_crash: Arc<dyn Fn(String, Option<i32>) + Send + Sync>,
    /// (session_id, is_subagent, evt) — the Task-4 router (UI +
    /// persistence; the `is_subagent` flag is known per attached
    /// Worker: main `false`, subagent `true`).
    on_event: Arc<dyn Fn(String, bool, WorkerInboundEvent) + Send + Sync>,
    /// The parent-scope sink lookup (session_id → the session's
    /// `TauriSink` — the `subagent-session-started` /
    /// `subagent-closed` UI lifecycle events are delivered on the
    /// PARENT session's sink; `None` = no UI delivery).
    sink_for: SinkLookup,
    /// The in-flight subagent dispatchs (session_id → the drive —
    /// the pump flips the settle watch on `agent_settled`, checks the
    /// `reaping` flag on `Exited`, and the `cancel_subagent` flips
    /// the cancel watch).
    drives: StdMutex<HashMap<String, SubagentDrive>>,
    /// The child-cwd registrar (the `TranscriptPersister`'s `set_cwd` —
    /// the `dispatch_subagent` flow registers the child's `cwd` (the
    /// parent's Space) so the persister's `ensure_session_row` creates
    /// the ephemeral `sessions` row with the right `cwd` — the
    /// `StoreFrame` carries no `cwd`). Set once via `set_cwd_registrar`
    /// (the `lib.rs` late-wire — the persister lives in the
    /// `SessionManager`, which the `WorkerManager` cannot see at
    /// construction).
    cwd_registrar: std::sync::OnceLock<CwdRegistrar>,
}

/// The child-cwd registrar signature (the `TranscriptPersister`'s
/// `set_cwd` — `(session_id, cwd)`; a type alias to keep the
/// `OnceLock<Arc<dyn Fn>>` out of the field's type — the clippy
/// `type_complexity` lint).
type CwdRegistrar = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// The parent-scope sink lookup (session_id → the session's
/// `TauriSink` — the `subagent-session-started` /
/// `subagent-closed` UI lifecycle events are delivered on the
/// PARENT session's sink; `None` = no UI delivery).
type SinkLookup = Arc<dyn Fn(&str) -> Option<Arc<dyn EventSink>> + Send + Sync>;

/// A registry of live Workers (session-keyed) + the Supervisor-side
/// subagent-dispatch flow. The `settle_timeout` is OUTSIDE the `Arc`
/// (the `with_settle_timeout` test variant swaps it without rebuilding
/// the `Arc`-backed state — the `StdMutex` maps are not `Clone`).
pub struct WorkerManager {
    state: Arc<ManagerState>,
    /// The subagent settle bound (default 30 min; tests shorten it via
    /// `with_settle_timeout`).
    settle_timeout: Duration,
}

impl WorkerManager {
    pub fn new(
        factory: Arc<dyn WorkerFactory>,
        on_crash: Arc<dyn Fn(String, Option<i32>) + Send + Sync>,
        on_event: Arc<dyn Fn(String, bool, WorkerInboundEvent) + Send + Sync>,
        sink_for: SinkLookup,
    ) -> Self {
        Self {
            state: Arc::new(ManagerState {
                workers: StdMutex::new(HashMap::new()),
                factory,
                on_crash,
                on_event,
                sink_for,
                drives: StdMutex::new(HashMap::new()),
                cwd_registrar: std::sync::OnceLock::new(),
            }),
            settle_timeout: DEFAULT_SUBAGENT_SETTLE_TIMEOUT,
        }
    }

    /// A test variant with a shortened settle bound (the `__slow__`
    /// settle-timeout tests — the fixture's 10 s settle is longer than
    /// the bound). The `settle_timeout` is outside the `Arc`, so the
    /// swap is a field assignment (the `Arc`-backed state is shared).
    pub fn with_settle_timeout(self, timeout: Duration) -> Self {
        Self {
            state: self.state,
            settle_timeout: timeout,
        }
    }

    /// The production seam for the ADR 0055 **Dead bound** (the `settings.json`
    /// `subagentDeadBoundSecs` key, applied at the one `lib.rs` construction
    /// site): SECONDS of unexplained silence after which a **Subagent session**
    /// is reaped as Dead. Tests inject their bound in `Duration`s via
    /// [`Self::with_settle_timeout`]; the unit here is seconds because that is
    /// the unit the setting is written in.
    pub fn with_dead_bound_secs(self, secs: u64) -> Self {
        self.with_settle_timeout(Duration::from_secs(secs))
    }

    /// Spawn a Worker for `session_id` + the `ready` handshake (5 s
    /// bound) + the `start` envelope. The read-loop pump is spawned
    /// (the `on_event` / `on_crash` routing — `is_subagent: false`).
    pub async fn attach(&self, session_id: &str, env: &StartEnv) -> Result<(), WorkerError> {
        let handle = (self.state.factory).spawn()?;
        handle.wait_ready(Duration::from_secs(5)).await?;
        // The lifecycle transition (the `ARCHIMEDES_DEBUG` log — a
        // no-op when the var is unset).
        debuglog::log(&format!("worker ready: {session_id}"));
        // The read-loop pump (the `on_event` / `on_crash` routing —
        // `is_subagent: false`; subscribed BEFORE `send_start` so the
        // `Start` frame — the advertised `enabledTools` — is seen).
        start_pump(
            self.state.clone(),
            self.settle_timeout,
            session_id.to_string(),
            false,
            handle.clone(),
        );
        handle.send_start(env)?;
        self.state
            .workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                session_id.to_string(),
                WorkerEntry {
                    handle: handle.clone(),
                    env: env.clone(),
                    reaping: false,
                },
            );
        Ok(())
    }

    /// Detach a session's Worker (the `workers` map bookkeeping — the
    /// `reaping` flag is set so the `Exited` is EXPECTED: NO
    /// `on_crash`; the graceful `close` + 2 s grace + `kill` runs in
    /// the background). Returns the detached handle.
    /// Detach a session's Worker (the `workers` map bookkeeping — the
    /// entry is REMOVED (the `Exited` is EXPECTED: NO `on_crash`);
    /// the graceful `close` + 2 s grace + `kill` runs in the
    /// background). Returns the detached handle.
    pub fn detach(&self, session_id: &str) -> Option<WorkerHandle> {
        let mut map = self.state.workers.lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.remove(session_id)?;
        // The background reap (the graceful `close` + 2 s grace +
        // `kill` — the `Exited` is EXPECTED: the entry is gone from
        // the `workers` map, so the pump's `unexpected_exit` lookup
        // misses — NO `on_crash`).
        let reap_handle = entry.handle.clone();
        tokio::spawn(async move {
            reap_worker(reap_handle).await;
        });
        Some(entry.handle)
    }

    /// Reap ALL attached Workers (a `close` + grace (2 s) + `kill` —
    /// called on app exit; the `reaping` flags make the `Exited`s
    /// EXPECTED — NO `on_crash`).
    pub async fn reap_all(&self) {
        let handles: Vec<WorkerHandle> = {
            let mut map = self.state.workers.lock().unwrap_or_else(|p| p.into_inner());
            for entry in map.values_mut() {
                entry.reaping = true;
            }
            map.values().map(|e| e.handle.clone()).collect()
        };
        for handle in handles {
            reap_worker(handle).await;
        }
    }

    /// The Supervisor-side subagent-dispatch flow (a main-session
    /// Worker's `subagent` tool → its `IpcDispatcher` →
    /// `Outbound::SubagentDispatch` → here): resolve the `model_key`
    /// against the effective catalog (the ADR 0020/0023 resolution —
    /// the `subagentModels` override is already folded into
    /// `launch.model` by the Worker's `resolve_launch`, soft-degraded),
    /// build the child `StartEnv` (the resolved `Model` with its
    /// provider config, the catalog, `cwd` = `parent_cwd`, `trusted` =
    /// the parent Space's trust — the Supervisor owns the `spaces`
    /// table, `system_prompt` =
    /// `build_child_system_message(launch.system_prompt,
    /// has_todo_tool)`, `enabled_tools` = the FULL three-way rule
    /// VERBATIM, `subagent_enabled: false` — the recursion guard),
    /// spawn the subagent Worker (a fresh ephemeral session —
    /// `mint_session_id`), `wait_ready` + `send_start` + the initial
    /// `prompt` (the `task`), then the drive task (`agent_settled` →
    /// the `SubagentCapture`'s final text → `Completed`; an unexpected
    /// `Exited` → `Failed { reason: Crashed, error: "subagent worker exited
    /// unexpectedly (code N)" }`; the **Dead bound** → `Failed { reason:
    /// Unresponsive, error: "timed out" }`; a `SubagentCancel` →
    /// `send_abort` + reap → `Failed { reason: Cancelled }`). EVERY `Failed`
    /// carries the `SubagentCapture`'s partial text + the real usage (ADR 0055
    /// — a **Dead Subagent** is never `Completed`, but its work is not thrown
    /// away). The `Inbound::SubagentResult { id, outcome }` is sent to
    /// the REQUESTING (main-session) Worker. The
    /// `subagent-session-started` / `subagent-closed` UI lifecycle
    /// events fire on the PARENT session's sink (the `subagent.rs:635`
    /// / `721/743` payload shapes — the `metrics` captured from the
    /// subagent's event stream + the wall clock).
    pub fn dispatch_subagent(&self, parent_session_id: &str, wire: SubagentDispatchWire) {
        dispatch_subagent(
            self.state.clone(),
            self.settle_timeout,
            parent_session_id.to_string(),
            wire,
            SubagentOutcomeSink::Requester,
            None,
        );
    }

    /// The in-process `dispatch_native` variant (ADR 0025 Task 5 — the
    /// `SubagentSessionManager` re-plumb): the outcome RESOLVES the
    /// oneshot (NOT delivered to a requesting Worker — there is none),
    /// and the child session id is PRE-MINTED (the caller's
    /// `SubagentCancel` targets it via `cancel_subagent`).
    pub fn dispatch_subagent_to(
        &self,
        parent_session_id: &str,
        wire: SubagentDispatchWire,
        child_session_id: String,
        outcome: tokio::sync::oneshot::Sender<SubagentOutcome>,
    ) {
        dispatch_subagent(
            self.state.clone(),
            self.settle_timeout,
            parent_session_id.to_string(),
            wire,
            SubagentOutcomeSink::Oneshot(std::sync::Arc::new(std::sync::Mutex::new(Some(outcome)))),
            Some(child_session_id),
        );
    }

    /// Set the child-cwd registrar (set-once — a second call is a
    /// NO-OP; the `lib.rs` late-wire — the persister lives in the
    /// `SessionManager`, which the `WorkerManager` cannot see at
    /// construction).
    pub fn set_cwd_registrar(&self, registrar: CwdRegistrar) {
        let _ = self.state.cwd_registrar.set(registrar);
    }

    /// Cancel an in-flight subagent dispatch (a parent turn abort —
    /// the `SubagentCancel` flow: `send_abort` + the drive task's
    /// `cancel` flag → the `Cancelled` outcome + the reap).
    pub fn cancel_subagent(&self, session_id: &str) {
        cancel_subagent_by_child_id(&self.state, session_id);
    }

    // ── Test support (the registry view) ────────────────────────────

    /// Whether a session's `Exited` is EXPECTED (a `detach` / `reap_all` was in
    /// flight — the `SessionManager`'s router `Exited` handling uses this to decide
    /// the `session-closed` cleanup vs. the `on_crash` path): `true` when the
    /// session is NOT in the `workers` map (already `detach`ed) OR is reaping
    /// (`reap_all` set the flag); `false` when it is in the map and NOT reaping
    /// (a crash — the `on_crash` fires).
    pub fn is_exit_expected(&self, session_id: &str) -> bool {
        let map = self.state.workers.lock().unwrap_or_else(|p| p.into_inner());
        match map.get(session_id) {
            Some(e) => e.reaping,
            None => true,
        }
    }

    /// The registry view (the `test_support`-exposed accessor — the
    /// session count). NOT `#[cfg(test)]`-gated: the headless IPC test
    /// (an integration target — the lib's `cfg(test)` is not compiled
    /// there) asserts through the `test_support` accessor.
    pub fn test_session_count(&self) -> usize {
        self.state
            .workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }

    /// The in-flight SUBAGENT view (how many `drives` entries exist — a
    /// subagent Worker is NOT in `workers`, so `test_session_count` never
    /// sees it: the count here is the leak check for a dispatch that was
    /// cancelled / settled but never torn down). NOT `#[cfg(test)]`-gated
    /// (see `test_session_count`).
    pub fn test_drive_count(&self) -> usize {
        self.state
            .drives
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }

    /// The registry view (is the session attached?). NOT `#[cfg(test)]`-gated
    /// (the headless IPC test asserts through it — see `test_session_count`).
    pub fn test_is_attached(&self, session_id: &str) -> bool {
        self.state
            .workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(session_id)
    }

    /// The registry view (are ALL sessions reaping?). NOT `#[cfg(test)]`-gated
    /// (the headless IPC test asserts through it — see `test_session_count`).
    pub fn test_all_reaping(&self) -> bool {
        let map = self.state.workers.lock().unwrap_or_else(|p| p.into_inner());
        map.values().all(|e| e.reaping)
    }

    /// Send a `Config { trusted }` frame to every RUNNING Worker in the
    /// `cwd` Space (the `set_space_trusted` mid-session trust toggle —
    /// the Worker's `StaticTrustSource` flip + the `ControlCmd` queue;
    /// the `trust-space` permission-outcome path is the separate
    /// `respond_permission` `db` write + flip). Returns the number of
    /// Workers the frame was DELIVERED to (a failed send — the Worker
    /// died / the pipe closed — is not counted; a mid-session toggle
    /// for a dead Worker is a no-op, not an error).
    pub fn send_config_to_space(&self, cwd: &str, trusted: bool) -> usize {
        let map = self.state.workers.lock().unwrap_or_else(|p| p.into_inner());
        let mut delivered = 0;
        for entry in map.values() {
            if entry.env.cwd == cwd && entry.handle.send_config(None, None, Some(trusted)).is_ok() {
                delivered += 1;
            }
        }
        delivered
    }

    /// The session's `WorkerHandle` (a clone) — `None` when the session is not
    /// attached (or was already reaped). The `SessionManager` uses this to relay
    /// frames (prompt / config / abort / responses) to the session's Worker.
    /// The `drives` fallback (ADR 0025 Task 5 — the `dispatch_native` re-plumb):
    /// a SUBAGENT session's handle is in the `drives` map (the in-flight
    /// dispatchs — the subagent's pending maps live in its Worker; the
    /// `respond_*` commands route through this lookup — main AND subagent
    /// sessions both resolve).
    pub fn handle_for(&self, session_id: &str) -> Option<WorkerHandle> {
        let state = &self.state;
        {
            let map = state.workers.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(e) = map.get(session_id) {
                return Some(e.handle.clone());
            }
        }
        state
            .drives
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_id)
            .and_then(|d| d.handle.clone())
    }
}

// ── The `Arc`-backed free functions (the `&self`-free logic) ────────

/// The read-loop pump (the `events()` consumer — the `on_event` /
/// `on_crash` routing; the `is_subagent` flag threaded; the
/// `settle_timeout` for the `SubagentDispatch` it runs).
fn start_pump(
    state: Arc<ManagerState>,
    settle_timeout: Duration,
    session_id: String,
    is_subagent: bool,
    handle: WorkerHandle,
) {
    // The pump owns the sole ACTIVE receiver (a clone — the handle's
    // stored receiver is idle, so every frame routes to the polled
    // clone).
    let mut rx = handle.events();
    tokio::spawn(async move {
        loop {
            let result = rx.recv().await;
            let Ok(evt) = result else {
                // `Lagged` — the ring rotated past the cursor (a
                // stalled consumer; the frames are lost — the loop
                // continues); `Closed` — the read task is gone (the
                // process is reaped — the loop ends).
                match result {
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    // The `Ok` variant is excluded by the `let-else`
                    // above (unreachable — the pattern is exhaustive
                    // for the linter).
                    Ok(_) => unreachable!("the `let-else` excluded `Ok`"),
                }
            };
            // (a) The router sees EVERY variant (including `Exited`).
            // A subagent's frames are delivered under the PARENT
            // session's id (the subagent's UI belongs to the parent's
            // scope — the `SubagentDrive` entry holds the parent id
            // until the teardown; a missing entry — the frame is
            // after the teardown — falls back to the child id).
            let delivery_id = if is_subagent {
                state
                    .drives
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&session_id)
                    .map(|d| d.parent_session_id.clone())
                    .unwrap_or_else(|| session_id.clone())
            } else {
                session_id.clone()
            };
            (state.on_event)(delivery_id, is_subagent, evt.clone());
            match evt {
                // The `SubagentCapture` feed (the subagent's
                // `SinkFrame` `session-update` stream — the final-text
                // source; the `message_update` `usage` — the metrics'
                // token fields) + the settle signal (the drive task
                // races it against the `settle_timeout` / the process
                // exit / the cancel) + the liveness signal (ADR 0055:
                // EVERY frame — a `SinkFrame` included — bumps the
                // drive's `seq`, so a child that only STREAMS still
                // reads as an Active Subagent).
                WorkerInboundEvent::SinkFrame { event, payload } if is_subagent => {
                    feed_capture(&state, &session_id, |c, liveness| {
                        note_liveness_frame(liveness);
                        c.observe_sink_frame(&event, &payload);
                        false
                    });
                }
                WorkerInboundEvent::Event(e) if is_subagent => {
                    feed_capture(&state, &session_id, |c, liveness| {
                        // The boundary bookkeeping runs BEFORE the capture
                        // feed (ADR 0055): the announced-and-not-yet-closed
                        // `tool_call_id` set is what tells a legitimately
                        // silent **Active Subagent** (inside a tool, parked
                        // on a gate, awaiting a nested delegation) from a
                        // **Dead** one.
                        note_liveness_event(liveness, &e);
                        c.observe_event(&e);
                        matches!(e, RpcEvent::agent_settled)
                    });
                }
                // (a2) A child's **gate** (ADR 0055): record the unanswered gate
                // so `finish_subagent` can close the child's own card at
                // teardown. This arm REPLACES nothing — the router already
                // received this exact frame VERBATIM through the
                // `(state.on_event)(delivery_id, is_subagent, evt)` call above
                // (which is where the `permission-request` /
                // `interactive-request` re-emission happens), and it still
                // does: recording runs ALONGSIDE, never instead. These two
                // variants used to fall through to the permissive `_` arm.
                WorkerInboundEvent::PermissionRequest { id, .. }
                | WorkerInboundEvent::InteractiveRequest { id, .. }
                    if is_subagent =>
                {
                    feed_capture(&state, &session_id, |_c, liveness| {
                        note_liveness_gate(liveness, &id);
                        false
                    });
                }
                // (b) The Supervisor-side subagent-dispatch flow (the
                // `on_event` above already delivered the frame to the
                // router).
                WorkerInboundEvent::SubagentDispatch(wire) => {
                    dispatch_subagent(
                        state.clone(),
                        settle_timeout,
                        session_id.clone(),
                        wire,
                        SubagentOutcomeSink::Requester,
                        None,
                    );
                }
                // (b2) The parent's turn abort (the `IpcDispatcher`'s
                // cancel watcher): the frame names the DISPATCH id, so the
                // drive is found by it. This frame used to fall through to
                // the permissive `_` arm and vanish — a Stop then did NOT
                // stop the subagent (it ran its whole turn, mutating files
                // the user had just asked to leave alone) and its Worker
                // process stayed alive until the 30-minute settle bound.
                WorkerInboundEvent::SubagentCancel { id } => {
                    cancel_subagent_by_dispatch_id(&state, &id);
                }
                // (c) Crash detection: an UNEXPECTED `Exited` (no
                // `detach` / `reap_all` / drive-task teardown in
                // flight) fires `on_crash` exactly once (the
                // `Exited` frame is terminal — the pump loop ends);
                // an EXPECTED `Exited` (a `detach` / `reap_all` was in
                // flight) fires NO `on_crash`.
                WorkerInboundEvent::Exited(code) => {
                    // The lifecycle transition (the `ARCHIMEDES_DEBUG` log —
                    // a CRASH when the `Exited` is unexpected, a clean
                    // `exit` otherwise; the code + the session id).
                    let crashed = unexpected_exit(&state, &session_id);
                    debuglog::log(&format!(
                        "worker {}: {session_id} (code {code:?})",
                        if crashed { "crash" } else { "exit" }
                    ));
                    if crashed {
                        (state.on_crash)(session_id.clone(), code);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Feed the subagent's `SubagentCapture` AND its `SubagentLiveness` (the
/// `drives` map entry — `None` when the dispatch is gone); the closure
/// returns `true` when the settle watch should be flipped (the
/// `agent_settled` event).
///
/// The capture borrow stays IMMUTABLE on purpose (`observe_sink_frame` /
/// `observe_event` take `&self` — they mutate through their internal
/// `StdMutex`es), and the liveness value is mutated in place through the
/// drive's `watch` sender (`send_modify` takes `&self`, so the two field
/// borrows stay disjoint).
fn feed_capture(
    state: &ManagerState,
    session_id: &str,
    f: impl FnOnce(&SubagentCapture, &mut SubagentLiveness) -> bool,
) {
    let mut drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
    let Some(drive) = drives.get_mut(session_id) else {
        return;
    };
    // The disjoint-field borrows made explicit (the capture is read through
    // the `Arc`, the liveness value is written through the `watch`).
    let SubagentDrive {
        capture,
        liveness_tx,
        settle_tx,
        ..
    } = drive;
    let mut settle = false;
    liveness_tx.send_modify(|liveness| {
        settle = f(capture, liveness);
    });
    if settle {
        let _ = settle_tx.send(true);
    }
}

/// Fire one in-flight dispatch's cancel (the `SubagentCancel` flow's two
/// actions): the child's `send_abort` (its turn token cancels — the
/// session stays alive until the reap) + the drive task's `cancel` flag
/// (the `Cancelled` outcome — the UNCONDITIONAL teardown reaps the child).
fn cancel_drive(drive: &SubagentDrive) {
    if let Some(handle) = &drive.handle {
        let _ = handle.send_abort();
    }
    let _ = drive.cancel_tx.send(true);
}

/// Cancel by the CHILD session id (the in-process `dispatch_native`'s
/// `SubagentCancel` targets the pre-minted id). A gone drive is a NO-OP
/// (the dispatch already settled — the cancel is idempotent).
fn cancel_subagent_by_child_id(state: &ManagerState, child_id: &str) {
    let drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(drive) = drives.get(child_id) {
        cancel_drive(drive);
    }
}

/// Cancel by the DISPATCH id (the Worker's `IpcDispatcher` cancel watcher
/// — the `SubagentCancel { id }` frame carries the dispatch id, NOT a
/// session id). A dispatch that already settled is a NO-OP.
fn cancel_subagent_by_dispatch_id(state: &ManagerState, dispatch_id: &str) {
    let drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(drive) = drives.values().find(|d| d.dispatch_id == dispatch_id) {
        cancel_drive(drive);
    }
}

/// An UNEXPECTED `Exited` (the `on_crash` fires): the session is still
/// registered (the `workers` map for main sessions, the `drives` map
/// for subagents) AND not reaping. An already-detached / torn-down
/// session (absent from both) is EXPECTED — no `on_crash`.
fn unexpected_exit(state: &ManagerState, session_id: &str) -> bool {
    {
        let workers = state.workers.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = workers.get(session_id) {
            return !entry.reaping;
        }
    }
    let drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
    match drives.get(session_id) {
        Some(drive) => !drive.reaping,
        None => false,
    }
}

/// The `dispatch_subagent` flow (the `Arc`-backed form — the `&self`
/// method delegates here; the pump task calls it with its `Arc`
/// clone). `sink` is the `SubagentOutcome` delivery target (the
/// `Requester` Worker / the in-process `dispatch_native`'s oneshot);
/// `pre_minted` is the PRE-MINTED child session id (the in-process
/// `dispatch_native`'s `SubagentCancel` targets it — `None` → the flow
/// mints its own, the `Requester` path).
#[allow(clippy::too_many_arguments)]
fn dispatch_subagent(
    state: Arc<ManagerState>,
    settle_timeout: Duration,
    parent_session_id: String,
    wire: SubagentDispatchWire,
    sink: SubagentOutcomeSink,
    pre_minted: Option<String>,
) {
    // The parent's `attach`-time start envelope (the effective
    // `catalog` / `config_dir` / `trusted` — the Supervisor owns
    // them). The parent is gone (detached / reaped) → the
    // dispatch is dropped (the requester's `IpcDispatcher` waiter
    // is never resolved — its `SubagentWait` select sees the
    // dropped oneshot as `Cancelled` — parity with the current
    // driver's "worker task vanished" behavior).
    let Some(parent_env) = state
        .workers
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&parent_session_id)
        .map(|e| e.env.clone())
    else {
        return;
    };
    // 1. The child `Model` (the `launch.model` override — a
    // trailing `:<level>` suffix is stripped FIRST — the REAL
    // `resolve_composed_model` splits `provider/id` only; the
    // suffix is a candidate thinking level (step 2, when
    // `launch.thinking` is `None`)); `None` → the `model_key`
    // (the loop's pre-flight resolved it against the Worker's
    // catalog). An unresolvable key is `Failed` (the current
    // driver's "unknown model" — NO fallback).
    // NOTE: ADR 0023 chain — see `resolve_model_ref` (not yet
    // unified). The last-`:` strip is `ModelRef::parse`; a ref
    // whose BARE part is not a valid key (no `/`) parses to
    // `None` — the old code used the WHOLE string as the bare key
    // (a `"a:b"` key: old message `unknown model: a`, new
    // `unknown model: a:b`). Both are unresolvable (a key without
    // `/` can never be in the catalog) — same `Failed` outcome;
    // only the error MESSAGE on a pathological input differs.
    let (model, level_suffix) = match &wire.launch.model {
        Some(key) => {
            let (bare, level) = match ModelRef::parse(key) {
                Some(ref_) => (ref_.key.to_string(), ref_.level),
                None => (key.clone(), None),
            };
            match resolve_composed_model(&parent_env.catalog, &bare) {
                Some(m) => (m, level),
                None => {
                    sink.deliver(
                        &state,
                        &parent_session_id,
                        &wire,
                        preflight_failed(format!("unknown model: {bare}")),
                    );
                    return;
                }
            }
        }
        None => match resolve_composed_model(&parent_env.catalog, &wire.model_key) {
            Some(m) => (m, None),
            None => {
                sink.deliver(
                    &state,
                    &parent_session_id,
                    &wire,
                    preflight_failed(format!("unknown model: {}", wire.model_key)),
                );
                return;
            }
        },
    };
    // 2. The child thinking level: explicit > the `:<level>` suffix
    // of the resolved model key > the frontmatter's `thinking` (the
    // doc-correct order — the frontmatter's `thinking` is the LAST
    // rung). Validate against `model.thinking_levels` (when
    // non-empty — an empty set soft-passes) — a mismatch is
    // DROPPED (never sent upstream as a bogus `reasoning_effort`).
    let mut thinking = wire
        .launch
        .thinking
        .clone()
        .or(level_suffix)
        .or(wire.launch.frontmatter_thinking.clone());
    if let Some(level) = &thinking {
        if !model.supports_thinking_level(level) {
            thinking = None;
        }
    }
    // 3. The child tool set (the FULL three-way rule — the current
    // driver's step 7, moved verbatim): `launch.tools` `Some` →
    // VERBATIM minus `subagent`/`list_agents` (a non-empty set that
    // empties out yields NO tools — NOT re-expanded);
    // `launch.tools` `None` → the parent's list minus the guard;
    // the `[]` (empty parent list) case → ALL tools minus the
    // guard (the "empty = all" expansion applies ONLY to the
    // inherited-parent case — the `parent_enabled_tools` `[]` is
    // the documented harness convention).
    let child_tools: Vec<String> = match &wire.launch.tools {
        Some(tools) => tools
            .iter()
            .filter(|t| !matches!(t.as_str(), "subagent" | "list_agents"))
            .cloned()
            .collect(),
        None => {
            if wire.parent_enabled_tools.is_empty() {
                tool_specs()
                    .into_iter()
                    .map(|t| t.name)
                    .filter(|t| !matches!(t.as_str(), "subagent" | "list_agents"))
                    .collect()
            } else {
                wire.parent_enabled_tools
                    .iter()
                    .filter(|t| !matches!(t.as_str(), "subagent" | "list_agents"))
                    .cloned()
                    .collect()
            }
        }
    };
    // 4. The child system message (the `harness/prompt` function —
    // `has_todo_tool` from the resolved child tool list; `None` →
    // no system message — the child's seq-0 row is absent).
    let has_todo_tool = child_tools.iter().any(|t| t == "manage_todo_list");
    let system_prompt =
        build_child_system_message(wire.launch.system_prompt.as_deref(), has_todo_tool);
    // 5. The child `StartEnv` (a FRESH ephemeral session —
    // `mint_session_id` (or the PRE-MINTED id — the in-process
    // `dispatch_native`'s `SubagentCancel` targets it); `enabled_tools`
    // = `Some(child_tools)` VERBATIM — an empty `child_tools` = NO tools,
    // NOT re-expanded; `subagent_enabled: false` — the recursion
    // guard).
    let child_id = pre_minted.unwrap_or_else(mint_session_id);
    // The child's `cwd` (the persister's `ensure_session_row` — the
    // ephemeral `sessions` row; the `StoreFrame` carries no `cwd`).
    if let Some(reg) = &state.cwd_registrar.get() {
        reg(&child_id, &wire.parent_cwd);
    }
    let env = StartEnv::from_parts(
        child_id.clone(),
        wire.parent_cwd.clone(),
        StartMode::Fresh,
        None,
        model.clone(),
        parent_env.catalog.clone(),
        thinking.clone(),
        parent_env.trusted,
        Some(child_tools.clone()),
        parent_env.config_dir.clone(),
        false,
        system_prompt,
    );
    // 6. The `subagent-session-started` UI lifecycle event (the
    // current driver's step 9 — the PARENT session's sink: the
    // `model` in the COMPOSED `provider/id` form, the
    // `thinkingLevel` the step-2 RESOLVED value, the
    // `enabledTools` the child's resolved set).
    if let Some(sink) = (state.sink_for)(&parent_session_id) {
        sink.emit(
            "subagent-session-started",
            json!({
                "sessionId": child_id,
                "parentSessionId": parent_session_id,
                "agentName": wire.agent_name,
                "task": wire.task,
                "model": ModelKey::from(&model).to_string(),
                "thinkingLevel": thinking.as_deref(),
                "enabledTools": child_tools,
            }),
        );
    }
    // 7. The in-flight dispatch bookkeeping (the `settle` watch —
    // the pump flips it on `agent_settled`; the `cancel` watch —
    // the `SubagentCancel` flow; the `SubagentCapture` — the pump
    // feeds it, the drive task reads the final text on settle; the
    // `liveness` watch — the ADR 0055 signal the pump bumps on every
    // frame it sees for this child).
    let (settle_tx, settle_rx) = watch::channel(false);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (liveness_tx, liveness_rx) = watch::channel(SubagentLiveness {
        seq: 0,
        in_flight: Default::default(),
        open_gates: Default::default(),
    });
    let capture = Arc::new(SubagentCapture::new());
    {
        let mut drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
        drives.insert(
            child_id.clone(),
            SubagentDrive {
                parent_session_id: parent_session_id.clone(),
                dispatch_id: wire.id.clone(),
                settle_tx: settle_tx.clone(),
                cancel_tx: cancel_tx.clone(),
                liveness_tx,
                capture: capture.clone(),
                handle: None,
                reaping: false,
            },
        );
    }
    // 8. The drive task (the spawn + `wait_ready` + `send_start` +
    // the initial `prompt` (the `task`) + the settle vs
    // `settle_timeout` vs the process exit vs the cancel race +
    // the UNCONDITIONAL teardown + the `SubagentResult` delivery).
    tokio::spawn(async move {
        let start = std::time::Instant::now();
        let outcome = match (state.factory).spawn() {
            Ok(handle) => {
                // The `cancel_subagent`'s `send_abort` target (the
                // drive owns the handle for the race; the `cancel`
                // reads it from the `drives` map — set it NOW).
                {
                    let mut drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(d) = drives.get_mut(&child_id) {
                        d.handle = Some(handle.clone());
                    }
                }
                // The subagent's read-loop pump (the `is_subagent`
                // flag threaded — `true`; subscribed BEFORE
                // `send_start` so the `Start` frame — the advertised
                // `enabledTools` — is seen; the `agent_settled`
                // flips the settle watch; the `SubagentCapture` is
                // fed from the `SinkFrame` / `message_update`
                // frames).
                start_pump(
                    state.clone(),
                    settle_timeout,
                    child_id.clone(),
                    true,
                    handle.clone(),
                );
                drive_subagent(
                    &state,
                    handle,
                    env,
                    &parent_session_id,
                    &wire,
                    start,
                    settle_rx,
                    cancel_rx,
                    // The ADR 0055 liveness receiver (the drive's future
                    // silence bound reads it — this task only threads it,
                    // the race still runs on `settle_timeout`).
                    liveness_rx,
                    &capture,
                    settle_timeout,
                    &sink,
                )
                .await
            }
            Err(e) => {
                sink.deliver(
                    &state,
                    &parent_session_id,
                    &wire,
                    preflight_failed(format!("spawn the subagent worker: {e}")),
                );
                None
            }
        };
        // The UNCONDITIONAL teardown (settle / timeout / cancel /
        // crash / spawn failure): the `reaping` flag is set FIRST
        // (the `Exited` is EXPECTED: NO `on_crash`), the `drives`
        // entry is removed (the pump's `Exited` lookup misses — no
        // `on_crash`), the `SubagentResult` is delivered (the
        // `drive_subagent` already sent it on the early-failure
        // paths — this is the settle / timeout / cancel / crash
        // delivery).
        if let Some(outcome) = outcome {
            finish_subagent(&state, &child_id, &parent_session_id, &wire, outcome, &sink).await;
        } else {
            // The early-failure path (the `SubagentResult` was
            // already sent — the teardown is the `drives` removal).
            let mut drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
            drives.remove(&child_id);
        }
    });
}

/// The drive task (the settle vs `settle_timeout` vs the process exit
/// vs the cancel race — the `drive_subagent` core): the `wait_ready`,
/// `send_start`, and the initial `prompt` (the `task`) preflight, then
/// the race. Returns the `SubagentOutcome` (`None` on a preflight
/// failure — the `SubagentResult` was already sent).
#[allow(clippy::too_many_arguments)]
async fn drive_subagent(
    state: &ManagerState,
    handle: WorkerHandle,
    env: StartEnv,
    parent_session_id: &str,
    wire: &SubagentDispatchWire,
    start: std::time::Instant,
    mut settle_rx: watch::Receiver<bool>,
    mut cancel_rx: watch::Receiver<bool>,
    // The child's liveness signal (ADR 0055) — the drive's half of the
    // `watch` the pump feeds. Every frame bumps its `seq` (activity);
    // `in_flight` holds the `tool_call_id`s announced and not yet closed.
    // This is what the self-rearming silence clock below reads.
    mut liveness_rx: watch::Receiver<SubagentLiveness>,
    capture: &Arc<SubagentCapture>,
    settle_timeout: Duration,
    sink: &SubagentOutcomeSink,
) -> Option<SubagentOutcome> {
    // The preflight (a `wait_ready` failure / a `send_start` error
    // means the child is gone before the turn started → `Failed` —
    // the `SubagentResult` is sent here, the teardown is the
    // `drives` removal).
    if handle.wait_ready(Duration::from_secs(5)).await.is_err() || handle.send_start(&env).is_err()
    {
        sink.deliver(
            state,
            parent_session_id,
            wire,
            preflight_failed("the subagent worker failed to start".to_string()),
        );
        return None;
    }
    // The initial `prompt` (the `task` — a `SendError` means the
    // child died before the turn started → `Failed`).
    if handle.send_prompt(&wire.task, &[]).is_err() {
        sink.deliver(
            state,
            parent_session_id,
            wire,
            preflight_failed("send the subagent task".to_string()),
        );
        return None;
    }
    // The race: the child's settle (the pump's `agent_settled` flips
    // it) vs the SILENCE bound (ADR 0055 — NOT a bound on the delegation's
    // duration) vs the process exit (an UNEXPECTED exit — a crash; a
    // settle-then-exit is the teardown below) vs the `SubagentCancel` (a
    // parent turn abort — `cancel_subagent` flips it).
    //
    // The bound is a SELF-REARMING silence clock: `settle_timeout` is the
    // child's maximum run of UNEXPLAINED SILENCE, so it is recomputed on
    // every pass of the loop below — a pass is only ever entered because
    // something CHANGED. There is no ceiling on how long a delegation may
    // run, and while a `tool_call_id` is outstanding the bound does not run
    // at all (the arm is disabled, not merely lengthened).
    // The declared-outside binding is only a scope (the value is meaningless
    // before the loop's first pass, which is exactly where it is computed).
    let mut deadline;
    let race = loop {
        // EVERY pass of this loop was entered because something changed (the
        // first pass, or the `changed()` arm) — so the deadline is recomputed
        // UNCONDITIONALLY here. That IS the activity reset: a frame bumps
        // `seq`, `changed()` fires, we come round, the clock restarts. Do NOT
        // guard this recompute on `in_flight` — a guarded recompute leaves
        // the deadline at its ORIGINAL arm time for an unblocked quiet child,
        // which silently restores the absolute wall-clock bound this change
        // removes.
        deadline = std::time::Instant::now() + settle_timeout;
        let in_flight = {
            // The borrow is scoped so the `RefMut` CANNOT be held across the
            // `select!` — held across an await point it makes the future
            // non-`Send` and the spawn fails to compile.
            //
            // `borrow_and_update` and NOT `borrow`: it marks the value seen
            // at borrow time, so a frame that lands BETWEEN this borrow and
            // the `select!` still leaves `changed()` ready (no missed
            // wakeup). A plain `borrow()` would leave it unseen, making
            // `changed()` return immediately on every pass — a hot spin that
            // starves the other arms.
            liveness_rx
                .borrow_and_update()
                .in_flight
                .iter()
                .next()
                .is_some()
        };
        // One fresh `sleep_until` per pass (each pass IS the reset, so this
        // is never skipped — a child streaming at ~30 fps re-arms ~30
        // times/sec, which is negligible next to the frame it just processed).
        let mut sleep = Box::pin(tokio::time::sleep_until(tokio::time::Instant::from_std(
            deadline,
        )));
        tokio::select! {
            _ = settle_rx.wait_for(|v| *v) => break Race::Settled,
            code = handle.exited() => break Race::Exited(code),
            _ = cancel_rx.changed() => break Race::Cancelled,
            // Activity (ADR 0055): any frame from the child — a streamed
            // token, a tool boundary, a control-plane reply — re-arms the
            // clock instead of letting it expire.
            _ = liveness_rx.changed() => continue,
            // The guard DISABLES the arm entirely while a tool call is
            // outstanding — a child inside a tool, parked on a gate, or
            // awaiting its own nested Subagent is Active and has NO timeout.
            // In that state the bound is not "longer"; it does not run.
            _ = &mut sleep, if !in_flight => break Race::TimedOut,
        }
    };
    // The outcome (the `SubagentCapture`'s final text — the
    // `SinkFrame` `agent_message_chunk` source; the `usage` from the
    // `message_update` frames; the wall clock).
    let duration_ms = start.elapsed().as_millis() as u64;
    let outcome = match race {
        Race::Settled => {
            let (input_tokens, output_tokens) = capture.usage();
            let output = capture.captured_text();
            let metrics = SubagentMetrics {
                output: output.clone(),
                input_tokens,
                output_tokens,
                cost: 0.0,
                duration_ms,
            };
            SubagentOutcome::Completed { output, metrics }
        }
        Race::TimedOut => failed_with_salvage(
            SubagentFailureReason::Unresponsive,
            "timed out".to_string(),
            capture,
            duration_ms,
        ),
        Race::Cancelled => failed_with_salvage(
            SubagentFailureReason::Cancelled,
            "cancelled".to_string(),
            capture,
            duration_ms,
        ),
        Race::Exited(code) => {
            let code_str = code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            failed_with_salvage(
                SubagentFailureReason::Crashed,
                format!("subagent worker exited unexpectedly (code {code_str})"),
                capture,
                duration_ms,
            )
        }
    };
    Some(outcome)
}

/// A **Dead Subagent**'s outcome (ADR 0055): `failed` in STATUS, but the
/// SALVAGE rides with it — whatever the `SubagentCapture` had accumulated when
/// the child stopped making progress, plus its REAL usage and wall clock.
///
/// This is the fix for the discarding bug: the drive holds its own `Arc` clone
/// of the capture, so the text and the tokens are readable on every crash /
/// reap / cancel path even though the pump has already dropped the `drives`
/// entry. A dead child is NEVER reported as `Completed` — it never decided it
/// was finished — but its 29 minutes of findings must not be thrown away.
fn failed_with_salvage(
    reason: SubagentFailureReason,
    error: String,
    capture: &Arc<SubagentCapture>,
    duration_ms: u64,
) -> SubagentOutcome {
    let (input_tokens, output_tokens) = capture.usage();
    let output = capture.captured_text();
    SubagentOutcome::Failed {
        reason,
        error,
        output: output.clone(),
        metrics: SubagentMetrics {
            output,
            input_tokens,
            output_tokens,
            cost: 0.0,
            duration_ms,
        },
    }
}

/// A PREFLIGHT failure (ADR 0055): the child never started, so the empty
/// `output` and the default `metrics` are DELIBERATE — there is nothing to
/// salvage and nothing was ever spent. `reason: Other` (no **Dead bound**, no
/// crash, no cancel — the dispatch simply never got off the ground).
fn preflight_failed(error: String) -> SubagentOutcome {
    SubagentOutcome::Failed {
        reason: SubagentFailureReason::Other,
        error,
        output: String::new(),
        metrics: SubagentMetrics::default(),
    }
}

/// The UNCONDITIONAL teardown (settle / timeout / cancel / crash): the
/// `subagent-closed` UI lifecycle event (EVERY exit path — the
/// `subagent.rs:721/743` payload shapes: `status` / `reason` / `error` /
/// `metrics`), the `reaping` flag (the `Exited` is EXPECTED: NO
/// `on_crash`), the graceful `close` + 2 s grace + `kill`, the
/// `drives` entry removal, and the `SubagentResult` delivery (the
/// REQUESTING (main-session) Worker).
async fn finish_subagent(
    state: &ManagerState,
    child_id: &str,
    parent_session_id: &str,
    wire: &SubagentDispatchWire,
    outcome: SubagentOutcome,
    sink: &SubagentOutcomeSink,
) {
    // The child's own UNANSWERED gates (ADR 0055): drained BEFORE the
    // `subagent-closed` emission, from the `drives` entry — which is still
    // valid here, because the removal below happens AFTER the emissions. A
    // gate the user ANSWERED is already gone (`tool_execution_end` cleared it
    // through the shared tool-call-id space), so only parked gates are closed.
    //
    // Read here and NOT snapshotted in `drive_subagent`: a gate can open
    // between that snapshot and this teardown, and this is the path that must
    // be exact.
    let open_gates: Vec<String> = {
        let drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
        match drives.get(child_id) {
            Some(drive) => {
                let mut ids: Vec<String> = drive
                    .liveness_tx
                    .borrow()
                    .open_gates
                    .iter()
                    .cloned()
                    .collect();
                // Sorted for a deterministic emission order (a `HashSet`'s
                // iteration order is unstable, and the emission order is
                // observable on the wire).
                ids.sort();
                ids
            }
            // The drive is already gone (an early-failure teardown) → nothing
            // was ever recorded.
            None => Vec::new(),
        }
    };
    // The guards are DROPPED before the emissions (a sink emission must never
    // run under the `drives` lock, and the borrow above is the only one).
    if let Some(sink) = (state.sink_for)(parent_session_id) {
        for request_id in open_gates {
            // ADR 0055: keyed to the CHILD id — the Client stored the gate under
            // `payload.sessionId` (the child) in App.tsx's `interactive-request`
            // listener, so a close keyed to the parent is a no-op on the child's
            // slice and the card would live forever.
            sink.emit(
                "interactive-request-close",
                json!({ "sessionId": child_id, "requestId": request_id }),
            );
        }
    }
    // The `subagent-closed` UI lifecycle event (the PARENT session's
    // sink — the `subagent.rs:721/743` payload shapes).
    if let Some(sink) = (state.sink_for)(parent_session_id) {
        match &outcome {
            SubagentOutcome::Completed { metrics, .. } => {
                sink.emit(
                    "subagent-closed",
                    json!({
                        "sessionId": child_id,
                        "status": "completed",
                        "metrics": metrics_json(metrics),
                    }),
                );
            }
            SubagentOutcome::Failed {
                reason,
                error,
                metrics,
                ..
            } => {
                // The REAL metrics (the outcome's — the salvage): a dead
                // child's usage reaches the Client through THIS payload and
                // nothing else, so reporting `default()` here made 29 minutes
                // of real work look free. `reason` is the machine-readable
                // why (ADR 0055) — the card's short line reads it instead of
                // string-matching `error`. The `output` deliberately does NOT
                // ride: the child's transcript is already persisted, and a
                // 29-minute blob does not belong in a lifecycle event.
                sink.emit(
                    "subagent-closed",
                    json!({
                        "sessionId": child_id,
                        "status": "failed",
                        "reason": reason,
                        "error": error,
                        "metrics": metrics_json(metrics),
                    }),
                );
            }
        }
    }
    // The `reaping` flag is set FIRST (the `Exited` is EXPECTED: NO
    // `on_crash`).
    {
        let mut drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(d) = drives.get_mut(child_id) {
            d.reaping = true;
        }
    }
    // The graceful `close` + 2 s grace + `kill` (the `drives` entry's
    // handle — the drive task's handle clone is the same process).
    {
        let handle = state
            .drives
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(child_id)
            .and_then(|d| d.handle.clone());
        if let Some(handle) = handle {
            reap_worker(handle).await;
        }
    }
    // The `drives` entry removal (the pump's `Exited` lookup misses —
    // no `on_crash`).
    {
        let mut drives = state.drives.lock().unwrap_or_else(|p| p.into_inner());
        drives.remove(child_id);
    }
    // The `SubagentResult` delivery (the REQUESTING (main-session)
    // Worker — or the in-process `dispatch_native`'s oneshot, the
    // `sink` target).
    sink.deliver(state, parent_session_id, wire, outcome);
}

/// Send `Inbound::SubagentResult { id, outcome }` to the REQUESTING
/// (main-session) Worker (the `IpcDispatcher` waiter resolves — the
/// loop's `SubagentWait` select sees it). The parent is gone → the
/// delivery is a no-op (the waiter is dropped — `Cancelled`).
fn send_subagent_result(
    state: &ManagerState,
    parent_session_id: &str,
    wire: &SubagentDispatchWire,
    outcome: SubagentOutcome,
) -> bool {
    let handle = state
        .workers
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(parent_session_id)
        .map(|e| e.handle.clone());
    let Some(handle) = handle else {
        return false;
    };
    handle
        .send_inbound_frame(Inbound::SubagentResult {
            id: wire.id.clone(),
            outcome,
        })
        .is_ok()
}

/// The `metrics` object shape (the wire contract: `output` /
/// `inputTokens` / `outputTokens` / `cost` / `durationMs` — the
/// `subagent.rs` `metrics_json` moved verbatim).
fn metrics_json(m: &SubagentMetrics) -> Value {
    json!({
        "output": m.output,
        "inputTokens": m.input_tokens,
        "outputTokens": m.output_tokens,
        "cost": m.cost,
        "durationMs": m.duration_ms,
    })
}

/// The graceful reap (the `close` + grace (2 s) + `kill` — the
/// `reaping` flag is set by the caller BEFORE this runs, so the
/// `Exited` is EXPECTED: NO `on_crash`).
async fn reap_worker(handle: WorkerHandle) {
    let _ = handle.send_close();
    let _ = tokio::time::timeout(Duration::from_secs(2), handle.exited()).await;
    let _ = handle.kill().await;
}

/// The subagent drive's outcome (the settle vs `settle_timeout` vs the
/// process exit vs the `SubagentCancel`).
enum Race {
    /// The child settled (the pump's `agent_settled` flipped the
    /// settle watch).
    Settled,
    /// The process exited (an UNEXPECTED exit — a crash; a
    /// settle-then-exit is the teardown below).
    Exited(Option<i32>),
    /// The `settle_timeout` won (a hung / slow turn — the child is
    /// torn down unconditionally).
    TimedOut,
    /// The `SubagentCancel` handle fired (a user / caller cancel —
    /// `cancel_subagent` flipped it).
    Cancelled,
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    use serde_json::Value;
    use tokio::sync::watch;

    use crate::agent::events::EventSink;
    use crate::agent::harness::catalog::{Model, ModelCatalog};
    use crate::agent::subagent::{LaunchConfig, SubagentFailureReason, SubagentOutcome};
    use crate::agent::worker::client::{WorkerError, WorkerHandle, WorkerInboundEvent};
    use crate::agent::worker::manager::{
        feed_capture, note_liveness_event, note_liveness_frame, note_liveness_gate,
        SubagentCapture, SubagentDrive, SubagentLiveness, WorkerFactory, WorkerManager,
    };
    use crate::agent::worker::protocol::{StartEnv, StartMode, SubagentDispatchWire};

    /// The test logging type aliases (the `clippy::type_complexity`
    /// bound — the `Arc<StdMutex<...>>` shapes are repeated across
    /// the test helpers).
    type CrashLog = Arc<StdMutex<Vec<(String, Option<i32>)>>>;
    type EventLog = Arc<StdMutex<Vec<(String, bool, WorkerInboundEvent)>>>;
    type SinkMap = Arc<StdMutex<HashMap<String, Arc<CollectorSink>>>>;
    type SinkEvents = Arc<StdMutex<Vec<(String, Value)>>>;

    /// The `fake_worker` fixture (the `fake_mcp_stdio` convention — the
    /// `CARGO_MANIFEST_DIR`/`target/debug` path; `cargo test` builds the
    /// bin targets).
    fn fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_worker"
        ))
    }

    /// The test factory (the `WorkerFactory` seam — the `fake_worker`
    /// binary; production is `WorkerHandle::spawn(std::env::
    /// current_exe().as_path())`).
    struct FakeWorkerFactory;

    impl WorkerFactory for FakeWorkerFactory {
        fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
            WorkerHandle::spawn(&fixture_path())
        }
    }

    /// A UI sink collector (the parent-scope `TauriSink` test double).
    #[derive(Clone)]
    struct CollectorSink {
        events: Arc<StdMutex<Vec<(String, Value)>>>,
    }

    impl CollectorSink {
        fn new() -> (Self, SinkEvents) {
            let events = Arc::new(StdMutex::new(Vec::new()));
            (
                Self {
                    events: events.clone(),
                },
                events,
            )
        }
    }

    impl EventSink for CollectorSink {
        fn emit(&self, event: &str, payload: Value) {
            self.events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push((event.to_string(), payload));
        }
    }

    /// A test `StartEnv` (a fake model the fixture's `SubagentDispatch`
    /// `model_key` — `fake/m1` — resolves against).
    fn test_env(session_id: &str, enabled_tools: Option<Vec<String>>) -> StartEnv {
        fn model(id: &str) -> Model {
            Model {
                id: id.to_string(),
                provider: "fake".to_string(),
                base_url: "http://fake/v1".to_string(),
                api_key: "k".to_string(),
                context_window: 100_000,
                cost_per_mtok_in: 0.0,
                cost_per_mtok_out: 0.0,
                supports_tools: true,
                supports_thinking: false,
                thinking_levels: Vec::new(),
                api: Some("openai-completions".to_string()),
            }
        }
        StartEnv::from_parts(
            session_id.to_string(),
            "/tmp/space".to_string(),
            StartMode::Fresh,
            None,
            model("m1"),
            ModelCatalog {
                models: vec![model("m1")],
                ..Default::default()
            },
            None,
            true,
            enabled_tools,
            "/tmp/config".to_string(),
            true,
            None,
        )
    }

    /// A `WorkerManager` on the `fake_worker` factory + the collectors
    /// (`on_crash` / `on_event` / the parent-scope sink lookup).
    fn make_manager(
        settle_timeout: Option<Duration>,
    ) -> (WorkerManager, CrashLog, EventLog, SinkMap) {
        let crashes = Arc::new(StdMutex::new(Vec::new()));
        let events = Arc::new(StdMutex::new(Vec::new()));
        let sinks: SinkMap = Arc::new(StdMutex::new(HashMap::new()));
        let factory: Arc<dyn WorkerFactory> = Arc::new(FakeWorkerFactory);
        let crashes_c = crashes.clone();
        let events_c = events.clone();
        let sinks_c = sinks.clone();
        let manager = WorkerManager::new(
            factory,
            Arc::new(move |id: String, code: Option<i32>| {
                crashes_c
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push((id, code));
            }),
            Arc::new(
                move |id: String, is_subagent: bool, evt: WorkerInboundEvent| {
                    events_c
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push((id, is_subagent, evt));
                },
            ),
            Arc::new(move |id: &str| {
                sinks_c
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .cloned()
                    .map(|s| s as Arc<dyn EventSink>)
            }),
        );
        let manager = match settle_timeout {
            Some(t) => manager.with_settle_timeout(t),
            None => manager,
        };
        (manager, crashes, events, sinks)
    }

    /// A parent-scope sink (registered under `session_id`).
    fn register_sink(sinks: &SinkMap, session_id: &str) -> SinkEvents {
        let (sink, events) = CollectorSink::new();
        sinks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_id.to_string(), Arc::new(sink));
        events
    }

    /// Collect the `on_event` deliveries for `session_id` (no waiting —
    /// the callers bounded-wait first).
    fn collect_now(events: &EventLog, session_id: &str) -> Vec<(bool, WorkerInboundEvent)> {
        events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(id, _, _)| id == session_id)
            .map(|(_, is_sub, evt)| (*is_sub, evt.clone()))
            .collect()
    }

    /// Bounded-wait until the `on_event` deliveries for `session_id`
    /// contain a frame matching `pred` (a deadline, so a missing frame
    /// is a test failure, not a hang).
    async fn wait_for_event(
        events: &EventLog,
        session_id: &str,
        pred: impl Fn(&WorkerInboundEvent) -> bool,
    ) -> Vec<(bool, WorkerInboundEvent)> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let got = collect_now(events, session_id);
            if got.iter().any(|(_, e)| pred(e)) || tokio::time::Instant::now() >= deadline {
                return got;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The `SubagentResult` the supervisor sent to the requester (the
    /// fixture's `subagent-result` INBOUND frame → the fixture's
    /// `subagent-result-ack` `SinkFrame` — the round-trip observation
    /// point; the `outcome` rides verbatim).
    fn subagent_result_outcome(events: &EventLog, session_id: &str) -> Option<SubagentOutcome> {
        events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(id, _, _)| id == session_id)
            .find_map(|(_, _, e)| match e {
                WorkerInboundEvent::SinkFrame { event, payload }
                    if event == "subagent-result-ack" =>
                {
                    serde_json::from_value::<SubagentOutcome>(payload["outcome"].clone()).ok()
                }
                _ => None,
            })
    }

    /// Dispatch a child directly with `task` (the ADR 0055 regression
    /// harness — the same `dispatch_subagent` entry point the parent's
    /// `SubagentDispatch` frame reaches through the pump, so the ONLY thing
    /// a test supplies is the child's task; the wire shape mirrors
    /// `subagent.rs`'s). The outcome reaches the parent Worker exactly as in
    /// the frame-driven tests, so `subagent_result_outcome` stays the
    /// observation point.
    fn dispatch_child_task(manager: &WorkerManager, parent_session_id: &str, task: &str) {
        dispatch_child_task_with_id(manager, parent_session_id, task, "live-stream");
    }

    /// The same, with an explicit DISPATCH id. The `__cancel__` fixture emits
    /// `SubagentCancel { id: "sub1" }`, so a cancel-driven test must dispatch
    /// under `sub1` for that frame to name its drive (the cancel is routed by
    /// DISPATCH id, not by child session id — `dispatch_child_task`'s
    /// generated ids are unroutable from the fixture).
    fn dispatch_child_task_with_id(
        manager: &WorkerManager,
        parent_session_id: &str,
        task: &str,
        dispatch_id: &str,
    ) {
        manager.dispatch_subagent(
            parent_session_id,
            SubagentDispatchWire {
                id: dispatch_id.to_string(),
                parent_session_id: parent_session_id.to_string(),
                parent_cwd: "/tmp/space".to_string(),
                parent_enabled_tools: vec!["bash".to_string(), "read".to_string()],
                agent_name: "tester".to_string(),
                launch: LaunchConfig::default(),
                task: task.to_string(),
                // The RESOLVED `provider/id` key (what `subagent.rs` composes —
                // it resolves against `test_env`'s `fake/m1` catalog entry).
                model_key: "fake/m1".to_string(),
            },
        );
    }

    /// Bounded-wait for the child's `subagent-result-ack`, then read the
    /// `SubagentOutcome` that rode it (the ack-first order is what lets a
    /// caller cancel BEFORE the outcome exists).
    async fn subagent_result_outcome_after_ack(
        events: &EventLog,
        session_id: &str,
    ) -> SubagentOutcome {
        let got = wait_for_event(events, session_id, |e| {
            matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
        })
        .await;
        subagent_result_outcome(events, session_id)
            .unwrap_or_else(|| panic!("the outcome rides the ack verbatim: {got:?}"))
    }

    /// Bounded-wait for the `subagent-closed` payload on the parent's sink
    /// (`finish_subagent` emits it on EVERY exit path; the `SinkEvents`
    /// collector is already registered per parent session).
    async fn wait_for_closed(sink_events: &SinkEvents) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let got: Vec<(String, Value)> = sink_events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if let Some((_, payload)) = got.iter().find(|(e, _)| e == "subagent-closed") {
                return payload.clone();
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("the `subagent-closed` event never fired");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Every payload the parent's sink received under `name`, in emission
    /// order (the observation point for the frames `finish_subagent` emits
    /// BESIDES `subagent-closed` — the ADR 0055 `interactive-request-close`).
    fn emitted(sink_events: &SinkEvents, name: &str) -> Vec<Value> {
        sink_events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(e, _)| e == name)
            .map(|(_, p)| p.clone())
            .collect()
    }

    /// The CHILD session id (the `subagent-session-started` payload — the
    /// only frame that names the child before the teardown; a dispatch whose
    /// child id the test cannot guess still gets an exact assertion).
    async fn wait_for_child_id(sink_events: &SinkEvents) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(p) = emitted(sink_events, "subagent-session-started").first() {
                return p["sessionId"]
                    .as_str()
                    .expect("the started payload carries the child sessionId")
                    .to_string();
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("the `subagent-session-started` event never fired");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The drive's CURRENT unanswered-gate set (sorted) — the same value
    /// `finish_subagent` drains at teardown, read through the pump's `watch`.
    fn open_gates_view(manager: &WorkerManager, child_id: &str) -> Vec<String> {
        let drives = manager
            .state
            .drives
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut ids: Vec<String> = drives
            .get(child_id)
            .expect("the drive is in flight")
            .liveness_tx
            .borrow()
            .open_gates
            .iter()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// Bounded-wait until the drive has RECORDED `id` as an unanswered gate
    /// (the pump records the frame in its own `match`, which runs AFTER the
    /// router delivery a test would otherwise wait on — without this the
    /// cancel could win the race against the recording and the test would be
    /// flaky rather than false).
    async fn wait_for_open_gate(manager: &WorkerManager, child_id: &str, id: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if open_gates_view(manager, child_id).iter().any(|g| g == id) {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("the pump never recorded `{id}` as an open gate");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// `attach` + `detach` bookkeeping (the `workers` map — the
    /// `test_support`-exposed registry view): `attach` inserts the
    /// session (the `ready` handshake + the `start` envelope); `detach`
    /// removes it + the process exits (a `close` → exit 0 — the
    /// EXPECTED exit fires NO `on_crash`).
    #[tokio::test]
    async fn attach_and_detach_bookkeeping() {
        let (manager, crashes, _events, _sinks) = make_manager(None);
        manager
            .attach("s1", &test_env("s1", Some(vec!["bash".to_string()])))
            .await
            .expect("the attach completes (the ready handshake)");
        assert!(
            manager.test_is_attached("s1"),
            "the attach inserted the session"
        );
        assert_eq!(manager.test_session_count(), 1);
        let handle = manager.detach("s1").expect("the detach returns the handle");
        assert!(
            !manager.test_is_attached("s1"),
            "the detach removed the session"
        );
        // The `close` → the Worker self-exits 0 (the EXPECTED exit —
        // NO `on_crash`).
        let code = handle.exited().await;
        assert_eq!(code, Some(0), "the detached worker exited 0");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            crashes.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "an expected detach-then-exit fires NO `on_crash`"
        );
    }

    /// `reap_all` kills all attached Workers (the `close` + grace +
    /// `kill` — the app-exit path; the processes exited, the registry
    /// is marked reaping, NO `on_crash`).
    #[tokio::test]
    async fn reap_all_kills_all_attached_workers() {
        let (manager, crashes, _events, _sinks) = make_manager(None);
        let _ = manager.attach("b1", &test_env("b1", None)).await;
        let _ = manager.attach("b2", &test_env("b2", None)).await;
        assert_eq!(manager.test_session_count(), 2);
        manager.reap_all().await;
        // The processes exited (the `close` → the fixture self-exits
        // 0; the `kill` is the belt-and-braces).
        assert!(
            manager.test_all_reaping(),
            "the reap marked every session reaping"
        );
        assert!(
            crashes.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "a `reap_all` is an EXPECTED exit — NO `on_crash`"
        );
    }

    /// A crashed Worker fires `on_crash` exactly ONCE with the right
    /// code (an unexpected `Exited` — no `detach` was called; the
    /// `Exited` frame is terminal, so the pump fires it exactly once).
    #[tokio::test]
    async fn a_crashed_worker_fires_on_crash_exactly_once() {
        let (manager, crashes, events, _sinks) = make_manager(None);
        manager
            .attach("c1", &test_env("c1", None))
            .await
            .expect("the attach completes");
        manager
            .handle_for("c1")
            .expect("the handle is reachable")
            .send_prompt("__crash__", &[])
            .expect("the prompt encodes");
        // The `Exited` frame reaches the router (the `on_event` — the
        // Task-4 router's `session-closed` handling).
        let got = wait_for_event(&events, "c1", |e| {
            matches!(e, WorkerInboundEvent::Exited(_))
        })
        .await;
        assert!(
            got.iter()
                .any(|(_, e)| { matches!(e, WorkerInboundEvent::Exited(Some(137))) }),
            "the `Exited` frame reached the router: {got:?}"
        );
        // The `on_crash` fires (the crash detection — the process exit
        // 137).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let c = crashes.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if c.iter().any(|(id, code)| id == "c1" && *code == Some(137))
                || tokio::time::Instant::now() >= deadline
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // A settle (the `on_crash` is fired exactly ONCE — the
        // `Exited` frame is terminal, the pump loop ends).
        tokio::time::sleep(Duration::from_millis(500)).await;
        let c = crashes.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let hits: Vec<_> = c
            .iter()
            .filter(|(id, code)| id == "c1" && *code == Some(137))
            .collect();
        assert_eq!(
            hits.len(),
            1,
            "the crash fired `on_crash` exactly once: {c:?}"
        );
        // A LATER `detach` (the cleanup) is an expected exit — no
        // second `on_crash`.
        manager.detach("c1");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let c = crashes.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert_eq!(
            c.iter().filter(|(id, _)| id == "c1").count(),
            1,
            "the `on_crash` is not re-fired by the cleanup detach: {c:?}"
        );
    }

    /// The `dispatch_subagent` flow: a `SubagentDispatch` from a
    /// main-session `fake_worker` (the `__subagent__` prompt) spawns a
    /// subagent `fake_worker` (a fresh ephemeral session — the canned
    /// settle) and delivers `SubagentResult` to the REQUESTING Worker
    /// (two `fake_worker`s — the outcome rides the wire back; the
    /// fixture's `subagent-result-ack` is the round-trip observation
    /// point).
    #[tokio::test]
    async fn dispatch_subagent_spawns_a_subagent_and_delivers_the_result() {
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
        manager
            .attach("p1", &test_env("p1", Some(vec!["bash".to_string()])))
            .await
            .expect("the parent attach completes");
        manager
            .handle_for("p1")
            .expect("the parent handle is reachable")
            .send_prompt("__subagent__", &[])
            .expect("the prompt encodes");
        // The `SubagentResult` frame arrives at the REQUESTING Worker
        // (the supervisor sent `Inbound::SubagentResult` to it — the
        // fixture's `subagent-result-ack` is the round-trip
        // observation point).
        let got = wait_for_event(&events, "p1", |e| {
            matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
        })
        .await;
        assert!(
            got.iter().any(|(_, e)| {
                matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
            }),
            "the `SubagentResult` frame reached the requester: {got:?}"
        );
        // The outcome is `Completed` (the `SubagentCapture`'s final
        // text — the fixture's canned `agent_message_chunk` stream).
        let outcome =
            subagent_result_outcome(&events, "p1").expect("the outcome rides the ack verbatim");
        match outcome {
            SubagentOutcome::Completed { output, metrics } => {
                assert_eq!(
                    output, "canned answer",
                    "the `SubagentCapture`'s final text"
                );
                assert!(metrics.duration_ms >= 1, "the wall clock (ms)");
            }
            other => panic!("expected `Completed`, got {other:?}"),
        }
        // The subagent Worker ran (a fresh ephemeral session — its
        // `agent_settled` reached the router with `is_subagent: true`).
        // The `cloned` (OWNED) — the `Vec` must not borrow the guard
        // (the guard is dropped at the block's end).
        let sub_events: Vec<(String, bool, WorkerInboundEvent)> = {
            let guard = events.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .iter()
                .filter(|(_, is_sub, _)| *is_sub)
                .cloned()
                .collect()
        };
        assert!(
            !sub_events.is_empty(),
            "a subagent Worker's events reached the router with the flag"
        );
        assert!(
            sub_events
                .iter()
                .any(|(_, is_sub, e)| { *is_sub && e.is_agent_settled() }),
            "the subagent settled (the canned settle): {sub_events:?}"
        );
        // The subagent session is gone (the drive task's UNCONDITIONAL
        // teardown — the `drives` entry is removed).
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            manager.test_session_count(),
            1,
            "only the parent remains (the subagent was reaped)"
        );
    }

    /// The `SubagentCapture`: capture from the subagent's `SinkFrame`
    /// `session-update` stream — the enveloped `agent_message_chunk`
    /// frames — the last-`messageId`-with-non-empty-text rule (a tool-using
    /// turn does NOT concatenate every intermediate message; the
    /// `messageId: "system"` bookkeeping chunks are NEVER captured). NOTE the
    /// id shape: the bare `"system"` below is FIXTURE INPUT — a frame written
    /// by hand into `observe_sink_frame`. What production puts on the wire is
    /// the stamped `{stamp}:system` (ADR 0049); the predicate accepts both.
    #[test]
    fn the_subagent_capture_captures_the_final_text_from_the_sink_frames() {
        let capture = SubagentCapture::new();
        // A first message (a tool-using turn — an intermediate
        // message).
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "m1",
                    "content": { "type": "text", "text": "intermediate " }
                }
            }),
        );
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "m1",
                    "content": { "type": "text", "text": "text" }
                }
            }),
        );
        // The `system` bookkeeping chunk (NEVER captured — a failed
        // child turn must not settle with a one-liner as its output).
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "system",
                    "content": { "type": "text", "text": "Retry failed" }
                }
            }),
        );
        // The LAST message (the final output — a tool-using turn does
        // NOT concatenate every intermediate message).
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "m2",
                    "content": { "type": "text", "text": "final " }
                }
            }),
        );
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "m2",
                    "content": { "type": "text", "text": "answer" }
                }
            }),
        );
        assert_eq!(
            capture.captured_text(),
            "final answer",
            "the last-`messageId`-with-non-empty-text rule"
        );
        // The usage accumulation (the `message_update` `usage` field —
        // the metrics' token fields).
        capture.observe_event(&crate::agent::events::RpcEvent::message_update {
            usage: serde_json::json!({ "inputTokens": 10, "outputTokens": 5 }),
            assistant_message_event: serde_json::json!({}),
        });
        assert_eq!(capture.input_tokens(), 10);
        assert_eq!(capture.output_tokens(), 5);
    }

    /// (ADR 0048) The capture is what the PARENT reads. A child that retried
    /// must hand back the retry's text alone, never `part` + `done`.
    #[test]
    fn a_retraction_clears_the_captured_child_text() {
        let capture = SubagentCapture::new();
        let chunk = |id: &str, t: &str| {
            serde_json::json!({ "sessionId": "s", "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": t }, "messageId": id } })
        };
        capture.observe_sink_frame("session-update", &chunk("m1", "part"));
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({ "sessionId": "s", "update": {
                "sessionUpdate": "message_retracted", "messageId": "m1" } }),
        );
        capture.observe_sink_frame("session-update", &chunk("m1", "done"));
        assert_eq!(capture.captured_text(), "done");
    }

    /// The discard line is harness bookkeeping, not the child's output (ADR 0048
    /// gives it a unique id precisely so it can be told apart).
    #[test]
    fn a_discard_line_is_not_captured_as_child_output() {
        let capture = SubagentCapture::new();
        capture.observe_sink_frame(
            "session-update",
            &serde_json::json!({ "sessionId": "s", "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Discarded an incomplete reply" },
                "messageId": "retract:1" } }),
        );
        assert_eq!(capture.captured_text(), "");
    }

    // ── The `SubagentLiveness` signal (ADR 0055) ──────────────────────

    /// Seed a real `SubagentDrive` in the real `drives` map under
    /// `child_id` (the map the pump feeds through `feed_capture` — the
    /// SAME entry production inserts in `dispatch_subagent`; the
    /// `handle` is `None` because these tests never talk to a Worker
    /// process, they hand the pump's feed the frames).
    fn seed_drive(manager: &WorkerManager, child_id: &str) {
        manager
            .state
            .drives
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                child_id.to_string(),
                SubagentDrive {
                    parent_session_id: "live-parent".to_string(),
                    dispatch_id: "live-dispatch".to_string(),
                    settle_tx: watch::channel(false).0,
                    cancel_tx: watch::channel(false).0,
                    liveness_tx: watch::channel(SubagentLiveness {
                        seq: 0,
                        in_flight: Default::default(),
                        open_gates: Default::default(),
                    })
                    .0,
                    capture: Arc::new(SubagentCapture::new()),
                    handle: None,
                    reaping: false,
                },
            );
    }

    /// The drive's CURRENT liveness signal read through the pump's own
    /// `watch` — the observation point is the SAME value the drive task's
    /// receiver reads (Task 2's silence bound), NOT a copy the test
    /// mutated. `(seq, the sorted in-flight ids)`.
    fn liveness_view(manager: &WorkerManager, child_id: &str) -> (u64, Vec<String>) {
        let drives = manager
            .state
            .drives
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let drive = drives.get(child_id).expect("the drive is seeded");
        let liveness = drive.liveness_tx.borrow();
        let mut ids: Vec<String> = liveness.in_flight.iter().cloned().collect();
        ids.sort();
        (liveness.seq, ids)
    }

    /// A canned `tool_execution_start` (the ANNOUNCE frame the pump sees while
    /// the Provider still streams the `toolCall`).
    fn tool_start(tool_call_id: &str) -> crate::agent::events::RpcEvent {
        crate::agent::events::RpcEvent::tool_execution_start {
            tool_call_id: tool_call_id.to_string(),
            tool_name: "bash".to_string(),
            args: serde_json::json!({ "command": "ls" }),
        }
    }

    /// A canned `tool_execution_end` (the close of one announced call).
    fn tool_end(tool_call_id: &str) -> crate::agent::events::RpcEvent {
        crate::agent::events::RpcEvent::tool_execution_end {
            tool_call_id: tool_call_id.to_string(),
            tool_name: "bash".to_string(),
            result: serde_json::json!({ "content": [], "isError": false }),
            is_error: false,
        }
    }

    /// (ADR 0055 — configuration) The **Dead bound** production seam:
    /// `with_dead_bound_secs` (applied at the ONE `lib.rs` construction site,
    /// reading `settings.json`'s `subagentDeadBoundSecs`) sets the same bound
    /// the test seam `with_settle_timeout` sets — the seconds are converted
    /// once, at the boundary, and nowhere else.
    #[test]
    fn the_dead_bound_secs_seam_sets_the_bound() {
        let (defaulted, _c, _e, _s) = make_manager(None);
        assert_eq!(
            defaulted.settle_timeout,
            super::DEFAULT_SUBAGENT_SETTLE_TIMEOUT,
            "`new` alone keeps the built-in default"
        );
        let (configured, _c, _e, _s) = make_manager(None);
        let configured = configured.with_dead_bound_secs(45);
        assert_eq!(
            configured.settle_timeout,
            Duration::from_secs(45),
            "the setting's SECONDS become the bound verbatim"
        );
    }

    /// (ADR 0055) The liveness set is "ANNOUNCED and not yet closed": a
    /// `tool_execution_start` puts the `tool_call_id` in and the matching
    /// `tool_execution_end` takes it out — so an ADR 0055 silence bound can
    /// tell a legitimately-silent **Active Subagent** (inside a tool, parked on
    /// a **gate**, or awaiting a nested **Subagent session**) from a **Dead
    /// Subagent**. The second half is the set-vs-counter guard: ADR 0048 has
    /// the cancel / turn-abandoned paths close calls that were announced but
    /// never dispatched, so an `end` with NO `start` is a LEGAL frame — on a
    /// FRESH drive it must leave the set EMPTY and still count as a frame
    /// (`seq` advances). A counter would go negative here and un-block a child
    /// that is still working; a set's removal is idempotent.
    #[test]
    fn the_liveness_set_tracks_announced_and_closed_tool_calls() {
        let (manager, _crashes, _events, _sinks) = make_manager(None);
        seed_drive(&manager, "live1");

        // The announce (the pump's `Event` arm: the boundary bookkeeping runs
        // BEFORE the capture feed).
        let start = tool_start("t1");
        feed_capture(&manager.state, "live1", |capture, liveness| {
            note_liveness_event(liveness, &start);
            capture.observe_event(&start);
            false
        });
        assert_eq!(
            liveness_view(&manager, "live1"),
            (1, vec!["t1".to_string()]),
            "an ANNOUNCED tool call is outstanding"
        );

        // The close.
        let end = tool_end("t1");
        feed_capture(&manager.state, "live1", |capture, liveness| {
            note_liveness_event(liveness, &end);
            capture.observe_event(&end);
            false
        });
        assert_eq!(
            liveness_view(&manager, "live1"),
            (2, Vec::new()),
            "the matching `tool_execution_end` closes it"
        );

        // A DRIVING turn emits plenty of frames that are neither boundary —
        // they advance the liveness clock and leave the set alone.
        let turn = crate::agent::events::RpcEvent::turn_start;
        feed_capture(&manager.state, "live1", |capture, liveness| {
            note_liveness_event(liveness, &turn);
            capture.observe_event(&turn);
            false
        });
        assert_eq!(
            liveness_view(&manager, "live1"),
            (3, Vec::new()),
            "a non-boundary event bumps `seq` and leaves the set alone"
        );

        // A FRESH drive + a lone `tool_execution_end` (ADR 0048: the cancel /
        // turn-abandoned paths close calls that were only ever announced — no
        // `start` ever arrived for `ghost`).
        seed_drive(&manager, "live2");
        let ghost = tool_end("ghost");
        feed_capture(&manager.state, "live2", |capture, liveness| {
            note_liveness_event(liveness, &ghost);
            capture.observe_event(&ghost);
            false
        });
        assert_eq!(
            liveness_view(&manager, "live2"),
            (1, Vec::new()),
            "an `end` without a `start` leaves the set EMPTY (no panic, no \
             underflow) and still counts as a frame"
        );
    }

    /// (ADR 0055 — a torn-down child closes its own cards) The pump records
    /// an unanswered **gate** as an outstanding gate, and the ANSWER of a gate
    /// clears it through the tool boundary that the answer closes.
    ///
    /// The second half is the id-space invariant the whole feature rests on:
    /// `gate_tool` passes `&tc.id` to `native_permission_gate` and the `ask`
    /// flow's interactive `requestId` is the `toolCallId` too, so the gate's id
    /// and the `tool_execution_end`'s `tool_call_id` are the SAME string —
    /// which is why an answered gate is absent at teardown with no drain logic.
    /// The sudo sub-prompts are the exception: they are the DERIVED
    /// `"{request_id}:confirm"` / `":password"` forms, so the suffix is stripped
    /// before recording and the set holds tool-call ids only.
    #[test]
    fn an_unanswered_gate_is_recorded_and_an_answered_one_is_cleared() {
        let (manager, _crashes, _events, _sinks) = make_manager(None);
        seed_drive(&manager, "gate1");

        // The gate frame (the pump's own `PermissionRequest` /
        // `InteractiveRequest` arms — NOT an `RpcEvent`, so NOT
        // `note_liveness_event`).
        feed_capture(&manager.state, "gate1", |_capture, liveness| {
            note_liveness_gate(liveness, "tc1");
            false
        });
        assert_eq!(
            open_gates_view(&manager, "gate1"),
            vec!["tc1".to_string()],
            "an unanswered gate is outstanding"
        );

        // The user answers → the tool call closes (`tool_execution_end` with
        // the SAME id — the one-id-space invariant).
        let end = tool_end("tc1");
        feed_capture(&manager.state, "gate1", |capture, liveness| {
            note_liveness_event(liveness, &end);
            capture.observe_event(&end);
            false
        });
        assert_eq!(
            open_gates_view(&manager, "gate1"),
            Vec::<String>::new(),
            "an ANSWERED gate is absent at teardown (the tool close clears it)"
        );

        // A sudo sub-prompt records the BARE tool-call id.
        feed_capture(&manager.state, "gate1", |_capture, liveness| {
            note_liveness_gate(liveness, "tc2:confirm");
            note_liveness_gate(liveness, "tc2:password");
            false
        });
        assert_eq!(
            open_gates_view(&manager, "gate1"),
            vec!["tc2".to_string()],
            "the derived `:confirm` / `:password` suffixes are stripped, so the \
             set holds tool-call ids only (both sub-prompts of one tool are ONE gate)"
        );
    }

    /// (ADR 0055) EVERY frame the pump sees bumps `seq` — including a
    /// `SinkFrame`, which is NOT an `RpcEvent`: the child's text stream rides
    /// the `session-update` `agent_message_chunk` `SinkFrame`s, so a child that
    /// ONLY streams tokens must still register as live or the silence bound of
    /// ADR 0055 would reap it mid-answer.
    #[test]
    fn every_frame_bumps_the_liveness_seq() {
        let (manager, _crashes, _events, _sinks) = make_manager(None);
        seed_drive(&manager, "stream1");
        let chunk = |text: &str| {
            serde_json::json!({ "sessionId": "stream1", "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text },
                "messageId": "m1" } })
        };
        // The pump's `SinkFrame` arm (a `SinkFrame` bumps the liveness clock
        // AND still feeds the capture).
        feed_capture(&manager.state, "stream1", |capture, liveness| {
            note_liveness_frame(liveness);
            capture.observe_sink_frame("session-update", &chunk("a"));
            false
        });
        assert_eq!(
            liveness_view(&manager, "stream1").0,
            1,
            "a `SinkFrame` (NOT an `RpcEvent`) counts as liveness"
        );
        feed_capture(&manager.state, "stream1", |capture, liveness| {
            note_liveness_frame(liveness);
            capture.observe_sink_frame("session-update", &chunk("b"));
            false
        });
        assert_eq!(
            liveness_view(&manager, "stream1").0,
            2,
            "every frame bumps `seq` again"
        );
        assert_eq!(
            manager
                .state
                .drives
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get("stream1")
                .expect("the drive is seeded")
                .capture
                .captured_text(),
            "ab",
            "the SAME call still feeds the capture (the pump's existing \
             contract is untouched)"
        );
    }

    /// A `"__slow__"` subagent (a 10 s settle) is SILENT with NOTHING in
    /// flight, so the **Dead bound** reaps it (the surviving safety net —
    /// ADR 0055 pins the *predicate*, not the duration: an unexplained run
    /// of silence still ends the dispatch `Failed { error: "timed out" }`,
    /// and the subagent is torn down unconditionally).
    #[tokio::test]
    async fn a_silent_child_with_nothing_in_flight_hits_the_dead_bound() {
        // The settle bound is SHORTER than the fixture's 10 s sleep.
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(1)));
        manager
            .attach("t1", &test_env("t1", None))
            .await
            .expect("the parent attach completes");
        manager
            .handle_for("t1")
            .expect("the parent handle is reachable")
            .send_prompt("__slow_subagent__", &[])
            .expect("the prompt encodes");
        // The `SubagentResult` frame (the **Dead bound** won — the
        // fixture's 10 s settle never arrives in time; the
        // `subagent-result-ack` is the round-trip observation point).
        let got = wait_for_event(&events, "t1", |e| {
            matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
        })
        .await;
        assert!(
            got.iter().any(|(_, e)| {
                matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
            }),
            "the `SubagentResult` frame reached the requester: {got:?}"
        );
        let outcome =
            subagent_result_outcome(&events, "t1").expect("the outcome rides the ack verbatim");
        match outcome {
            SubagentOutcome::Failed { error, .. } => {
                assert_eq!(error, "timed out", "the current timeout outcome");
            }
            other => panic!("expected `Failed {{ timed out }}`, got {other:?}"),
        }
        // The subagent is torn down (the UNCONDITIONAL teardown — the
        // `drives` entry is removed; the parent's Worker is untouched).
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the timed-out subagent is torn down"
        );
        assert_eq!(manager.test_session_count(), 1, "the parent survives");
    }

    /// (ADR 0055 — the reported bug) A child that keeps PRODUCING outlives
    /// the bound. The fixture streams 15 `agent_message_chunk` `SinkFrame`s
    /// ~100 ms apart (~1.7 s of continuous production — 5× the bound
    /// injected here) and only then settles, so a drive that bounds the
    /// child's DELEGATION DURATION cuts it off mid-answer. The bound must be
    /// a SILENCE bound: every frame rearms it, so a streaming child is an
    /// Active Subagent and completes normally.
    ///
    /// RED against the single never-rearmed `sleep(settle_timeout)`: the
    /// sleep fires at 300 ms while the child is still streaming →
    /// `Failed { error: "timed out" }` (the reaping IS the bug). The
    /// fixture's total turn is ~1.8 s, so the bound is not merely short — it
    /// is exceeded 5× by pure production.
    #[tokio::test]
    async fn a_streaming_subagent_outlives_the_dead_bound() {
        // The bound is 300 ms; the child streams for ~1.7 s.
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_millis(300)));
        manager
            .attach("l1", &test_env("l1", None))
            .await
            .expect("the parent attach completes");
        dispatch_child_task(&manager, "l1", "__long_stream__");
        // The `SubagentResult` frame (the round-trip observation point — the
        // fixture's `subagent-result-ack` echoes the outcome verbatim).
        let got = wait_for_event(&events, "l1", |e| {
            matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
        })
        .await;
        let outcome = subagent_result_outcome(&events, "l1")
            .unwrap_or_else(|| panic!("the streaming child must resolve the dispatch: {got:?}"));
        match outcome {
            SubagentOutcome::Completed { output, metrics } => {
                assert_eq!(output, "canned answer", "the captured child text");
                // The child genuinely ran PAST the bound — the proof that
                // this is the liveness case, not a race the fixture won.
                assert!(
                    metrics.duration_ms >= 600,
                    "the child must have run well past the 300 ms bound \
                     (it streamed for ~1.7 s), got {metrics:?}"
                );
            }
            other => panic!(
                "a streaming child is an Active Subagent and must COMPLETE, got {other:?} \
                 (a `Failed {{ timed out }}` here is the bug: the drive bounded the \
                 delegation's DURATION instead of the child's SILENCE)"
            ),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the settled subagent is torn down"
        );
        assert_eq!(manager.test_session_count(), 1, "the parent survives");
    }

    /// (ADR 0055) A child INSIDE a tool call is never reaped. The fixture
    /// announces a `tool_execution_start`, produces NOTHING for ~1.5 s (the
    /// tool is running — the child is silent BY CONSTRUCTION and legitimately
    /// blocked), then closes the call and settles. An outstanding
    /// `tool_call_id` is precisely the state in which silence means NOTHING,
    /// so the bound must not run at all here — not "be longer".
    ///
    /// RED against the single never-rearmed `sleep(settle_timeout)`: the
    /// 300 ms sleep expires during the silent tool window →
    /// `Failed { error: "timed out" }` while `in_flight` holds `t1`.
    #[tokio::test]
    async fn a_child_inside_a_tool_call_is_never_reaped() {
        // The bound is 300 ms; the tool call stays open for ~1.5 s.
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_millis(300)));
        manager
            .attach("i1", &test_env("i1", None))
            .await
            .expect("the parent attach completes");
        dispatch_child_task(&manager, "i1", "__in_tool__");
        let got = wait_for_event(&events, "i1", |e| {
            matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
        })
        .await;
        let outcome = subagent_result_outcome(&events, "i1")
            .unwrap_or_else(|| panic!("the in-tool child must resolve the dispatch: {got:?}"));
        match outcome {
            SubagentOutcome::Completed { metrics, .. } => {
                assert!(
                    metrics.duration_ms >= 1000,
                    "the child must have been held by the OPEN tool call well past \
                     the 300 ms bound, got {metrics:?}"
                );
            }
            other => panic!(
                "a child with an outstanding `tool_call_id` must NEVER be reaped, got \
                 {other:?} (a `Failed {{ timed out }}` here is the bug: the bound ran \
                 while the child was blocked inside its tool)",
            ),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the settled subagent is torn down"
        );
        assert_eq!(manager.test_session_count(), 1, "the parent survives");
    }

    /// (ADR 0055 — the salvage) EVERY non-`Settled` drive path carries what
    /// the child ACTUALLY produced: the `SubagentCapture`'s partial text, the
    /// REAL accumulated usage, and a machine-readable `reason`. Before this,
    /// `Failed { error }` held ONLY a string — 29 minutes of findings were
    /// thrown away and `finish_subagent` reported `SubagentMetrics::default()`
    /// (0 tokens for work that really cost money) on the one channel by which
    /// a child's usage reaches the Client.
    ///
    /// Three paths, all at the DRIVE layer (never via `SubagentWait`):
    /// - **dead** (`__stream_then_silence__` + a short bound) → `Unresponsive`
    /// - **crash** (`__stream_then_crash__`) → `Crashed`
    /// - **cancel** (`__stream_then_silence__` + a cancel mid-silence) → `Cancelled`
    #[tokio::test]
    async fn every_failure_path_carries_the_partial_output_and_real_usage() {
        // ── 1. The Dead bound wins (`Unresponsive`) ────────────────────
        // The bound is well inside the fixture's 10 s silence, and the
        // chunks are NOT inside a tool call, so the silence clock runs.
        let (manager, _crashes, events, sinks) = make_manager(Some(Duration::from_millis(400)));
        let sink_events = register_sink(&sinks, "d1");
        manager
            .attach("d1", &test_env("d1", None))
            .await
            .expect("the parent attach completes");
        dispatch_child_task(&manager, "d1", "__stream_then_silence__");
        let outcome = subagent_result_outcome_after_ack(&events, "d1").await;
        match outcome {
            SubagentOutcome::Failed {
                reason,
                error,
                output,
                metrics,
            } => {
                assert_eq!(
                    error, "timed out",
                    "the timeout text is unchanged (Task 5 renames it)"
                );
                assert_eq!(
                    reason,
                    SubagentFailureReason::Unresponsive,
                    "the **Dead bound** firing is DATA, not something to \
                     string-match out of `error`"
                );
                assert_eq!(
                    output, "Finding one. Finding two. Finding three.",
                    "the **Dead Subagent**'s partial work reaches the parent"
                );
                assert_eq!(
                    (metrics.input_tokens, metrics.output_tokens),
                    (120, 34),
                    "REAL usage — the fixture's `message_update` `usage` frame \
                     (the bug reported 0/0 for work that cost money)"
                );
                assert!(
                    metrics.duration_ms >= 1,
                    "the wall clock to the failure, got {metrics:?}"
                );
            }
            other => panic!("expected a salvaged `Failed`, got {other:?}"),
        }
        // The `subagent-closed` payload carries the REAL metrics + the
        // `reason` (the sole channel by which a child's usage reaches the
        // Client), but NOT the `output` (the transcript is already persisted).
        let closed = wait_for_closed(&sink_events).await;
        assert_eq!(closed["status"], "failed");
        assert_eq!(closed["reason"], "unresponsive");
        assert_eq!(closed["metrics"]["inputTokens"], 120);
        assert_eq!(closed["metrics"]["outputTokens"], 34);
        assert!(
            closed.get("output").is_none(),
            "the child's transcript does NOT ride a lifecycle event: {closed}"
        );
        assert_eq!(manager.test_drive_count(), 0, "the dead child is torn down");
        drop(sink_events);
        manager.detach("d1");

        // ── 2. The process crashed (`Crashed`) ─────────────────────────
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
        manager
            .attach("s1", &test_env("s1", None))
            .await
            .expect("the parent attach completes");
        dispatch_child_task(&manager, "s1", "__stream_then_crash__");
        let outcome = subagent_result_outcome_after_ack(&events, "s1").await;
        match outcome {
            SubagentOutcome::Failed {
                reason,
                error,
                output,
                metrics,
            } => {
                assert_eq!(
                    error, "subagent worker exited unexpectedly (code 137)",
                    "the crash still carries the exit code"
                );
                assert_eq!(reason, SubagentFailureReason::Crashed);
                assert_eq!(
                    output, "Finding one. Finding two. Finding three.",
                    "a crashed child's partial work is not thrown away"
                );
                assert_eq!((metrics.input_tokens, metrics.output_tokens), (120, 34));
            }
            other => panic!("expected a salvaged `Failed` (crash), got {other:?}"),
        }
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the crashed child is torn down"
        );
        manager.detach("s1");

        // ── 3. A cancel mid-silence (`Cancelled`) ──────────────────────
        // A bound far longer than the test: ONLY the cancel may end this one.
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
        manager
            .attach("k1", &test_env("k1", None))
            .await
            .expect("the parent attach completes");
        // The `sub1` DISPATCH id — the `__cancel__` frame names that id.
        dispatch_child_task_with_id(&manager, "k1", "__stream_then_silence__", "sub1");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while manager.test_drive_count() < 1 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(manager.test_drive_count(), 1, "the child is in flight");
        // Let the partial chunks land in the capture, then cancel (the
        // fixture's `SubagentCancel { id: "sub1" }` frame).
        tokio::time::sleep(Duration::from_millis(300)).await;
        manager
            .handle_for("k1")
            .expect("the parent handle is reachable")
            .send_prompt("__cancel__", &[])
            .expect("the cancel prompt encodes");
        let outcome = subagent_result_outcome_after_ack(&events, "k1").await;
        match outcome {
            SubagentOutcome::Failed {
                reason,
                error,
                output,
                metrics,
            } => {
                assert_eq!(error, "cancelled", "the cancel text is unchanged");
                assert_eq!(reason, SubagentFailureReason::Cancelled);
                assert_eq!(
                    output, "Finding one. Finding two. Finding three.",
                    "a cancelled child's partial work is not thrown away"
                );
                assert_eq!((metrics.input_tokens, metrics.output_tokens), (120, 34));
            }
            other => panic!("expected a salvaged `Failed` (cancel), got {other:?}"),
        }
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the cancelled child is torn down"
        );
        manager.detach("k1");
    }

    /// A parent's `SubagentCancel` frame (the `IpcDispatcher`'s
    /// cancel watcher — a parent turn abort) reaches the DRIVE it names:
    /// the child is `send_abort`ed, the outcome is the `Cancelled` one,
    /// and the child Worker is REAPED. Pre-fix the pump's `match` had no
    /// arm for the frame at all — it was dropped — so the drive raced on
    /// to the `settle_timeout`: a Stop did not stop the subagent (it kept
    /// working after the user asked it to), and its Worker process
    /// lingered until the 30-minute bound.
    #[tokio::test]
    async fn a_parent_subagent_cancel_frame_cancels_and_reaps_the_child() {
        // A bound far longer than the test: ONLY the cancel may end this
        // dispatch (a `TimedOut` outcome is the bug's signature).
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
        manager
            .attach("c1", &test_env("c1", None))
            .await
            .expect("the parent attach completes");
        let handle = manager
            .handle_for("c1")
            .expect("the parent handle is reachable");
        // The parent dispatches a SLOW subagent (the fixture's `sub1`
        // dispatch id — the `__cancel__` frame names the same id).
        handle
            .send_prompt("__slow_subagent__", &[])
            .expect("the dispatch prompt encodes");
        // The child is in flight (its `drives` entry has arrived).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while manager.test_drive_count() < 1 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            manager.test_drive_count(),
            1,
            "the subagent dispatch is in flight"
        );
        // The parent aborts the turn (the fixture's `__cancel__` emits the
        // `SubagentCancel { id: "sub1" }` frame).
        handle
            .send_prompt("__cancel__", &[])
            .expect("the cancel prompt encodes");

        let got = wait_for_event(&events, "c1", |e| {
            matches!(e, WorkerInboundEvent::SinkFrame { event, .. } if event == "subagent-result-ack")
        })
        .await;
        let outcome = subagent_result_outcome(&events, "c1")
            .unwrap_or_else(|| panic!("the cancel must resolve the dispatch: {got:?}"));
        match outcome {
            SubagentOutcome::Failed { error, .. } => assert_eq!(
                error, "cancelled",
                "the cancel outcome — `timed out` means the frame was dropped"
            ),
            other => panic!("expected `Failed {{ cancelled }}`, got {other:?}"),
        }
        // The UNCONDITIONAL teardown reaps the child (the `drives` entry
        // is gone — no Worker left behind).
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the cancelled subagent is torn down (no Worker left behind)"
        );
        assert_eq!(manager.test_session_count(), 1, "the parent survives");
    }

    /// (ADR 0055 — the hole ADR 0040 recorded) A child torn down with an
    /// ANSWERED gate leaves a card on screen forever: the child Worker emits NO
    /// close frame for a gate it is merely parked on, `router.rs`'s
    /// pending-modal cleanup never runs for a child (its `Exited` arm is gated
    /// `!is_subagent`, and `cleanup_pending_modals` returns without a `live`
    /// entry), and the gate was tracked under the PARENT's delivery id anyway.
    /// So `finish_subagent` is the emitter, and the close MUST be keyed to the
    /// CHILD id — the Client stored the gate under `payload.sessionId`, which is
    /// the child's, so a parent-keyed close is a no-op on the child's slice.
    ///
    /// The teardown here is the CANCEL (a short bound cannot fire: the gate's
    /// tool call is outstanding, so the ADR 0055 silence clock is DISARMED).
    #[tokio::test]
    async fn a_torn_down_child_closes_its_own_outstanding_gates() {
        // A bound far longer than the test — only the cancel may end this.
        let (manager, _crashes, events, sinks) = make_manager(Some(Duration::from_secs(30)));
        let sink_events = register_sink(&sinks, "g1");
        manager
            .attach("g1", &test_env("g1", None))
            .await
            .expect("the parent attach completes");
        // The `sub1` DISPATCH id — the `__cancel__` frame names that id (the
        // cancel is routed by DISPATCH id, so a generated one is unroutable).
        dispatch_child_task_with_id(&manager, "g1", "__permission__", "sub1");
        let child_id = wait_for_child_id(&sink_events).await;

        // The gate is parked (the fixture blocks until it is answered) and the
        // pump has RECORDED it — the router also still sees the frame VERBATIM
        // under the parent's delivery id (the recording is alongside, never
        // instead).
        wait_for_open_gate(&manager, &child_id, "p1").await;
        let delivered = collect_now(&events, "g1");
        let frame = delivered
            .iter()
            .find_map(|(is_sub, e)| match e {
                WorkerInboundEvent::PermissionRequest { id, payload } if *is_sub => {
                    Some((id.clone(), payload.clone()))
                }
                _ => None,
            })
            .expect("the router still receives the child's `PermissionRequest`");
        assert_eq!(frame.0, "p1");
        assert_eq!(
            frame.1["sessionId"], child_id,
            "the payload carries the CHILD sessionId (that is the key the \
             Client stored the gate under)"
        );

        // The parent aborts the turn → the child is cancelled and torn down.
        manager
            .handle_for("g1")
            .expect("the parent handle is reachable")
            .send_prompt("__cancel__", &[])
            .expect("the cancel prompt encodes");
        let closed = wait_for_closed(&sink_events).await;
        assert_eq!(closed["status"], "failed");
        assert_eq!(
            closed["reason"], "cancelled",
            "the machine-readable why rides the close payload (the card's \
             short line reads it, never `error`): {closed}"
        );

        let all = sink_events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let gates: Vec<Value> = emitted(&sink_events, "interactive-request-close");
        assert_eq!(
            gates.len(),
            1,
            "the child's one unanswered gate is closed exactly once: {all:?}"
        );
        assert_eq!(
            gates[0]["sessionId"], child_id,
            "keyed to the CHILD id — a parent-keyed close is a no-op on the \
             child's slice and the card lives forever"
        );
        assert_eq!(gates[0]["requestId"], "p1");
        // The gate closes precede `subagent-closed` (the teardown drains the
        // gates FIRST). Both are read from one snapshot of the collector.
        let idx = |name: &str| {
            all.iter()
                .position(|(e, _)| e == name)
                .unwrap_or_else(|| panic!("no `{name}` event: {all:?}"))
        };
        assert!(
            idx("interactive-request-close") < idx("subagent-closed"),
            "the gate closes precede the close frame: {all:?}"
        );
        // The `drives` removal runs AFTER the emissions in `finish_subagent`.
        // Poll (rather than sleep a fixed 500 ms like the cancel test above):
        // a child parked on a GATE swallows the reap's `Close` frame in its
        // gate-response read loop, so its reap needs the full 2 s grace +
        // `kill` — a child that is merely slow exits on the first frame.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while manager.test_drive_count() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            manager.test_drive_count(),
            0,
            "the cancelled child is torn down"
        );
        manager.detach("g1");
    }

    /// The NEGATIVE half: a child that ANSWERED its gate emits NO
    /// `interactive-request-close` at teardown. The answer closes the tool call
    /// (`tool_execution_end` carrying the SAME id — `gate_tool` passes
    /// `&tc.id`), and that removal is what makes the gate absent, so a
    /// completed child's card — which the user already answered — is never
    /// retracted.
    #[tokio::test]
    async fn a_child_that_answered_its_gate_emits_no_close() {
        let (manager, _crashes, _events, sinks) = make_manager(Some(Duration::from_secs(30)));
        let sink_events = register_sink(&sinks, "g2");
        manager
            .attach("g2", &test_env("g2", None))
            .await
            .expect("the parent attach completes");
        dispatch_child_task_with_id(&manager, "g2", "__permission__", "sub1");
        let child_id = wait_for_child_id(&sink_events).await;
        wait_for_open_gate(&manager, &child_id, "p1").await;

        // The user ANSWERS (the response routes to the CHILD's handle —
        // `handle_for` resolves the `drives` map's entry).
        manager
            .handle_for(&child_id)
            .expect("the child handle is reachable")
            .send_permission_response(
                "p1",
                &crate::agent::permission::PermissionOutcome::Selected {
                    option_id: "allow".to_string(),
                },
            )
            .expect("the permission response encodes");

        // The child then closes the tool call and settles → `Completed`.
        let closed = wait_for_closed(&sink_events).await;
        assert_eq!(
            closed["status"], "completed",
            "the answered child settles: {closed}"
        );
        assert!(
            closed.get("reason").is_none(),
            "a `Completed` payload carries NO failure reason: {closed}"
        );
        assert_eq!(
            emitted(&sink_events, "interactive-request-close"),
            Vec::<Value>::new(),
            "an ANSWERED gate is absent at teardown — nothing may retract a \
             card the user already answered"
        );
        manager.detach("g2");
    }

    /// The `subagent-session-started` + `subagent-closed` UI lifecycle
    /// events fire on the PARENT session's sink (the `subagent.rs:635`
    /// / `721/743` payload shapes — the `metrics` populated from the
    /// subagent's event stream + the wall clock; `subagent-closed` on
    /// EVERY exit path).
    #[tokio::test]
    async fn the_subagent_ui_lifecycle_events_fire_on_the_parent_sink() {
        let (manager, _crashes, _events, sinks) = make_manager(Some(Duration::from_secs(30)));
        let sink_events = register_sink(&sinks, "u1");
        manager
            .attach("u1", &test_env("u1", Some(vec!["bash".to_string()])))
            .await
            .expect("the parent attach completes");
        manager
            .handle_for("u1")
            .expect("the parent handle is reachable")
            .send_prompt("__subagent__", &[])
            .expect("the prompt encodes");
        // Wait for the `subagent-closed` (every exit path emits it).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let got: Vec<(String, Value)> = sink_events
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if got.iter().any(|(e, _)| e == "subagent-closed")
                || tokio::time::Instant::now() >= deadline
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let got: Vec<(String, Value)> = sink_events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let started = got
            .iter()
            .find(|(e, _)| e == "subagent-session-started")
            .map(|(_, p)| p.clone())
            .expect("the `subagent-session-started` fired on the parent's sink");
        // The `subagent.rs:635` payload shape (`model` / `thinkingLevel`
        // / `enabledTools` / `agentName` / `task` + the session ids).
        assert_eq!(started["parentSessionId"], "u1");
        assert!(started["sessionId"].is_string(), "the child session id");
        assert_eq!(started["agentName"], "tester");
        assert_eq!(started["task"], "the task");
        assert_eq!(
            started["model"], "fake/m1",
            "the COMPOSED `provider/id` form"
        );
        assert!(
            started["enabledTools"].is_array(),
            "the child's resolved `enabledTools`"
        );
        let closed = got
            .iter()
            .find(|(e, _)| e == "subagent-closed")
            .map(|(_, p)| p.clone())
            .expect("the `subagent-closed` fired on the parent's sink");
        // The `subagent.rs:721/743` payload shape (`status` / `error`?
        // / `metrics`).
        assert_eq!(closed["status"], "completed");
        assert_eq!(closed["sessionId"], started["sessionId"], "the same child");
        let metrics = &closed["metrics"];
        assert!(metrics["durationMs"].is_u64(), "the wall clock (ms)");
        assert!(
            metrics["durationMs"].as_u64() >= Some(1),
            "the duration is a real elapsed time: {metrics:?}"
        );
        assert!(metrics["output"].is_string(), "the captured final text");
        assert!(metrics["inputTokens"].is_u64());
        assert!(metrics["outputTokens"].is_u64());
        assert!(metrics["cost"].is_number());
    }

    /// The `enabled_tools` wire convention (reviewer-corrected — the
    /// round-3 fix): a `StartEnv` with `enabled_tools:
    /// Some(vec!["subagent"])` (a `launch.tools` that empties out after
    /// the guard minus) → the child Worker's advertised tool set is
    /// EMPTY (the `Some(vec![])` = NO tools semantics preserved — NOT
    /// re-expanded to all); `enabled_tools: None` → all tools (the
    /// settings convention mapped at construction — the `[]` (empty
    /// parent list) case expands to ALL tools minus the guard).
    #[tokio::test]
    async fn the_enabled_tools_wire_convention_is_applied_verbatim() {
        // Case 1: `Some(vec!["subagent"])` — a `launch.tools` that
        // empties out after the guard minus → the child advertises NO
        // tools (NOT re-expanded). The fixture's `__subagent_tools__`
        // prompt emits a `SubagentDispatch` with `launch.tools:
        // Some(["subagent"])` (the `Some`-case trigger).
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
        manager
            .attach("w1", &test_env("w1", Some(vec!["subagent".to_string()])))
            .await
            .expect("the parent attach completes");
        manager
            .handle_for("w1")
            .expect("the parent handle is reachable")
            .send_prompt("__subagent_tools__", &[])
            .expect("the prompt encodes");
        // The child's advertised tool set (the `Start` → the fixture's
        // `session-update` `enabledTools` frame — the `is_subagent`
        // events).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut child_enabled: Option<Value>;
        loop {
            let got: Vec<(String, bool, WorkerInboundEvent)> =
                events.lock().unwrap_or_else(|p| p.into_inner()).clone();
            child_enabled =
                got.iter()
                    .filter(|(id, _, _)| id == "w1")
                    .find_map(|(_, is_sub, e)| {
                        if !is_sub {
                            return None;
                        }
                        match e {
                            WorkerInboundEvent::SinkFrame { event, payload }
                                if event == "session-update" =>
                            {
                                payload
                                    .get("update")
                                    .and_then(|u| u.get("enabledTools"))
                                    .cloned()
                            }
                            _ => None,
                        }
                    });
            if child_enabled.is_some() || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let child_enabled = child_enabled.expect("the child advertised its tool set");
        assert_eq!(
            child_enabled,
            Value::Array(Vec::new()),
            "a `launch.tools` that empties out yields NO tools — NOT re-expanded: {child_enabled:?}"
        );
        // Case 2: `launch.tools: None` (the `__subagent__` trigger —
        // the inherited-parent branch) → the child advertises the
        // parent's list minus the guard (`subagent` / `list_agents`
        // excluded; the fixture's `parent_enabled_tools` is
        // `["bash", "read"]` — no guard names, so VERBATIM).
        let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
        manager
            .attach("w2", &test_env("w2", None))
            .await
            .expect("the parent attach completes");
        manager
            .handle_for("w2")
            .expect("the parent handle is reachable")
            .send_prompt("__subagent__", &[])
            .expect("the prompt encodes");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut child_enabled: Option<Value>;
        loop {
            let got: Vec<(String, bool, WorkerInboundEvent)> =
                events.lock().unwrap_or_else(|p| p.into_inner()).clone();
            child_enabled =
                got.iter()
                    .filter(|(id, _, _)| id == "w2")
                    .find_map(|(_, is_sub, e)| {
                        if !is_sub {
                            return None;
                        }
                        match e {
                            WorkerInboundEvent::SinkFrame { event, payload }
                                if event == "session-update" =>
                            {
                                payload
                                    .get("update")
                                    .and_then(|u| u.get("enabledTools"))
                                    .cloned()
                            }
                            _ => None,
                        }
                    });
            if child_enabled.is_some() || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let child_enabled = child_enabled.expect("the child advertised its tool set");
        let tools = child_enabled
            .as_array()
            .expect("the advertised tool set is an array");
        assert!(
            !tools.is_empty(),
            "the inherited parent list is advertised (minus the guard): {child_enabled:?}"
        );
        assert!(
            !tools.iter().any(|t| t == "subagent"),
            "the guard excludes `subagent`: {child_enabled:?}"
        );
        assert!(
            !tools.iter().any(|t| t == "list_agents"),
            "the guard excludes `list_agents`: {child_enabled:?}"
        );
    }
}
