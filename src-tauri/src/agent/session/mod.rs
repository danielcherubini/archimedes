//! The native session layer: the Supervisor-side session coordinator
//! (ADR 0025) — a session's `AgentLoop` runs in its Worker process (a
//! self-exec `archimedes --worker` child); the `SessionManager` is the
//! Supervisor-side coordinator (spawn/reap via the `WorkerManager`, event
//! routing, persistence via the `TranscriptPersister`, the `respond_*`
//! relays, the stalled state). The in-process native driver is DELETED
//! (no dual-mode fallback — ADR 0025).
//!
//! The `WorkerManager`'s `on_event` callback (wired in `lib.rs`) routes
//! each Worker frame: the store frames → the `TranscriptPersister`
//! (persistence only); the `SinkFrame`s → the `TauriSink` VERBATIM (the
//! UI contract — re-emitted with the same event name + payload); the raw
//! `RpcEvent` stream → internal bookkeeping only (the `agent_settled`
//! settle detection + the `pending_turn` resolution — NEVER the UI, to
//! avoid double-delivering the `session-update` frames); the
//! `PermissionRequest` / `InteractiveRequest` frames → re-emitted on the
//! `TauriSink` with the payload UNCHANGED (the frontend contract preserved
//! by construction).
//!
//! Multiple live sessions COEXIST: `start_session` / `resume_session` do
//! NOT close other live sessions; a session is torn down only by an
//! explicit `close_session` (a `detach` + the Worker's clean exit) or a
//! crash (the `on_crash` callback marks the session STALLED — resumable).
//!
//! **The `session-update` contract is FROZEN** (ADR 0011): the `SinkFrame`
//! re-emit delivers the exact JSON envelopes the frontend consumes
//! (`agent_message_chunk` / `agent_thought_chunk` / `tool_call` /
//! `tool_call_update` / `session_info_update` / `config_option_update`), so
//! the frontend needs no changes.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::agent::errors::SessionError;
use crate::agent::events::EventSink;
use crate::agent::harness::{
    build_provider, discover_models, merge_catalog, Model, ModelCatalog, ModelKey, Provider,
    ProviderDiscovery, SessionStore, WireApi, DEFAULT_CONTEXT_WINDOW,
};
use crate::agent::normalize::normalize_capabilities;
use crate::agent::permission::{self};
use crate::agent::persist::TranscriptPersister;
use crate::agent::tools::ImageRef;
use crate::agent::types::mint_session_id;
use crate::agent::worker::client::WorkerInboundEvent;
use crate::agent::worker::manager::{
    WorkerFactory, WorkerHooks, WorkerManager, DEFAULT_SUBAGENT_DEAD_BOUND,
};
use crate::agent::worker::protocol::{StartEnv, StartMode};
use crate::config::{load_settings, write_settings};
use crate::storage::Db;
use crate::types::{ContextUsage, SessionInfo};

// The session-naming pass (the `agent_end` hook): the primitives AND the
// wiring live in the child module, which sees this module's private items
// (`driver.db`, `sink`, `config_state`, `naming`) with no widening.
mod naming;
mod router;

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosedReason {
    /// The user (or the app) closed the session.
    User,
    /// The agent process exited on its own.
    AgentExited,
    /// The connection failed for an unexpected reason.
    Error,
}

impl ClosedReason {
    /// The string form emitted in the `session-closed` event payload.
    pub fn as_str(self) -> &'static str {
        match self {
            ClosedReason::User => "user",
            ClosedReason::AgentExited => "agent-exited",
            ClosedReason::Error => "error",
        }
    }
}

/// How a live session was (or was about to be) closed. `None` at
/// teardown time means the agent process exited on its own.
///
/// `pub(crate)`: the close reason rides the `SessionManager`'s live map
/// across the module boundary (the `close_session` / `respond_*` paths),
/// so it must be visible to the whole crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseKind {
    /// An explicit user close (`close_session` or a subagent cancel).
    User,
}

/// Why a prompt turn ended.
///
/// A LOCAL enum (the ACP crate type dies with the swap): the strings are
/// exactly what the frontend expects (`end_turn` / `max_tokens` / `refusal`
/// / `max_turn_requests` / `cancelled`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The model finished its turn normally.
    EndTurn,
    /// The model hit its output token limit.
    MaxTokens,
    /// The model (or the provider) refused the prompt.
    Refusal,
    /// The agent hit its max turn-request limit.
    MaxTurnRequests,
    /// The user (or the app) cancelled the turn.
    Cancelled,
}

/// One image attachment over IPC. The frontend sends CAMEL CASE
/// (`mimeType`, `sizeBytes`) — Tauri camel-cases only the TOP-LEVEL command
/// args, so this nested struct renames explicitly.
///
/// (Moved from `agent/prompt.rs`, which died with the ACP swap — the
/// `ImagePayload` / `MAX_IMAGE_BYTES` / validation / `user_message_payload`
/// helpers all live here now.)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
    pub mime_type: String,
    /// base64, WITHOUT a `data:` prefix.
    pub data: String,
    pub name: String,
    pub size_bytes: u64,
}

/// 10 MiB — mirrors the frontend cap (ADR 0008).
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// 8 images per message — mirrors the frontend `MAX_CHAT_ATTACHMENTS` (ADR
/// 0008): re-validated here so hand-rolled IPC cannot bloat the DB
/// out-of-band (worst case 8 × 10 MiB raw ≈ 108 MB of base64 persisted per
/// message — base64 expands each image ~4/3×).
pub const MAX_IMAGE_COUNT: usize = 8;

/// 255 bytes — the OS per-component filename limit: `name` is written verbatim
/// to SQLite, so re-validated here so hand-rolled IPC cannot bloat a row
/// out-of-band. (The frontend's `name` comes from a real OS filename and is
/// already ≤255 bytes on all major OSes.)
pub const MAX_IMAGE_NAME_LEN: usize = 255;

/// Deliberately NARROWER than `image/*`: the destination is LLM vision APIs
/// (png/jpeg/gif/webp only — an SVG would fail the whole turn at the
/// provider). Mirrors the frontend `SUPPORTED_IMAGE_TYPES`.
const SUPPORTED_IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Validate image attachments (guards against hand-rolled IPC): the count ≤
/// `MAX_IMAGE_COUNT`; `name` ≤ `MAX_IMAGE_NAME_LEN` bytes; `mime_type` in
/// `SUPPORTED_IMAGE_TYPES`; `data` with ≤2 trailing `=` padding chars;
/// decoded size (the padding-stripped `len * 3 / 4` estimate — `size_bytes`
/// is NOT trusted) ≤ `MAX_IMAGE_BYTES`.
fn validate_images(images: &[ImagePayload]) -> Result<(), SessionError> {
    if images.len() > MAX_IMAGE_COUNT {
        return Err(SessionError::InvalidPrompt {
            reason: format!("at most {MAX_IMAGE_COUNT} images per message"),
        });
    }
    for img in images {
        if img.name.len() > MAX_IMAGE_NAME_LEN {
            return Err(SessionError::InvalidPrompt {
                reason: "image name exceeds 255 bytes".to_string(),
            });
        }
        if !SUPPORTED_IMAGE_TYPES.contains(&img.mime_type.as_str()) {
            return Err(SessionError::InvalidPrompt {
                reason: format!(
                    "unsupported image type: {} (expected png, jpeg, gif, webp)",
                    img.mime_type
                ),
            });
        }
        let trimmed = img.data.trim_end_matches('=');
        // Legitimate base64 has 0–2 trailing `=` padding. Rejecting >2 keeps
        // the stripped-size estimate a real bound on the persisted data
        // (arbitrary `=` padding would otherwise bypass the size cap).
        let padding = img.data.len() - trimmed.len();
        if padding > 2 {
            return Err(SessionError::InvalidPrompt {
                reason: "malformed base64 image data".to_string(),
            });
        }
        let decoded_bytes = (trimmed.len() as u64) * 3 / 4;
        if decoded_bytes > MAX_IMAGE_BYTES {
            return Err(SessionError::InvalidPrompt {
                reason: "image exceeds the 10 MiB limit".to_string(),
            });
        }
    }
    Ok(())
}

/// The user-message payload persisted in `messages.payload_json` (ADR 0008):
/// `{ "text": ..., "images": [{ name, mimeType, sizeBytes, data }] }` —
/// the `images` key is OMITTED when empty (pre-feature rows stay `{"text"}`).
pub fn user_message_payload(text: &str, images: &[ImagePayload]) -> Value {
    if images.is_empty() {
        json!({ "text": text })
    } else {
        json!({
            "text": text,
            "images": images.iter().map(|img| {
                json!({
                    "name": img.name,
                    "mimeType": img.mime_type,
                    "sizeBytes": img.size_bytes,
                    "data": img.data,
                })
            }).collect::<Vec<_>>(),
        })
    }
}

/// The native session's config state (the `set_config_option` re-synthesizer
/// source — the loop's own `model` / `thinking_level` live INSIDE the spawned
/// task, so the handle mirrors the applied config: `start_native_session`
/// initializes it, `set_config_option` updates it when a change is applied).
#[derive(Clone)]
pub(crate) struct NativeConfigState {
    pub(crate) model: Model,
    pub(crate) thinking_level: Option<String>,
}

/// The Supervisor-side stalled-session bookkeeping (ADR 0025 Task 4 — a
/// Worker crash marks the session STALLED; the frontend reads the state
/// from the `session-stalled` event + the `stalled_info` query). There is
/// no backend `SessionState` enum today (session state lives in the
/// frontend store + ad-hoc flags) — the `stalled` registry is the
/// backend's source of truth for the crash + the crash-log path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StalledInfo {
    /// Unix milliseconds (the crash time).
    pub at: i64,
    /// The crashed Worker's OWN `crash-<ts>-worker-<pid>.log`, selected by
    /// the pid of the child the Supervisor just reaped and FROZEN at crash
    /// time (one lookup per crash — the `session-stalled` push and this
    /// struct's PULL name the same path). Crash logs are diagnostic, not
    /// load-bearing, so the lookup is best-effort: `None` when the crash-log
    /// dir is unwired or holds no log for that pid. A pid with no matching
    /// log is `None` — never another Worker's crash. When no pid was
    /// captured, the pre-amendment pid-less `crash-<ts>-worker.log` is still
    /// matched, because logs already on disk keep their names.
    pub crash_log: Option<PathBuf>,
}

/// A live, Worker-backed session (the Supervisor-side coordinator state —
/// the in-process `NativeHandle` is gone for main sessions). The `AgentLoop`
/// runs in the session's Worker; this struct holds the Supervisor's
/// per-session bookkeeping: the `cwd` (the `respond_permission`
/// `trust-space` write + the `session-closed` reason), the close kind
/// (first-set-wins — `close_session` sets `User`), the in-flight turn's
/// resolver (`send_prompt` stores a sender; the router resolves it on
/// `agent_settled` / `Exited` / crash), the `cancel_requested` flag (a
/// late settle maps to `Cancelled`), and the UNANSWERED request ids (the
/// `PermissionRequest` / `InteractiveRequest` frames relayed MINUS the
/// `*Response`s sent — the pending-modal cleanup on session end: a session
/// ending with an open prompt must NOT leave a stuck modal).
struct LiveWorkerSession {
    cwd: PathBuf,
    close_kind: Arc<StdMutex<Option<CloseKind>>>,
    pending_turn: Arc<StdMutex<Option<oneshot::Sender<StopReason>>>>,
    cancel_requested: Arc<StdMutex<bool>>,
    pending_modal_ids: StdMutex<HashSet<String>>,
}

/// The resume context (the `establish_worker_session` `resume` parameter —
/// the stored `session_id`, the resolved `model`, the stored `thinkingLevel`,
/// the desktop's `archived` flag (ADR 0016), the stored `title` (so a resumed
/// session's label survives the round-trip) and the stored `context_usage`).
struct ResumeCtx {
    session_id: String,
    model: Model,
    stored_level: Option<String>,
    archived: bool,
    /// The stored title (`None` until the naming pass writes one) — carried
    /// so a resumed session's label survives the close/resume round-trip.
    title: Option<String>,
    context_usage: Option<ContextUsage>,
    /// The stored running cost (#105) — the figure the resumed session's
    /// next priced call ADDS to. Carried so the returned `SessionInfo` hands
    /// it back to the Client, which seeds its live accumulator from it
    /// (Trap 3: an unseeded accumulator restarts a resumed session's total at
    /// that one call's cost).
    cost_usd: Option<f64>,
}

/// The shared session-driver state. `SessionManager` (main sessions)
/// owns one.
///
/// Holds the persistence + trust-db handles (the ADR 0022/0025 worker
/// runtime — the in-process pending maps / todo / sudo / settle knobs
/// are GONE with the in-process driver: the pending maps live in the
/// session's Worker, the todo store in the Worker, the sudo flow in the
/// Worker, the settle in the `WorkerManager`'s drive tasks).
pub struct SessionDriver {
    /// Transcript persistence (main only; `None` for subagents —
    /// ephemeral, not stored). The loop's persistence goes through the
    /// `Store` seam (the `SessionStore` built from this db in
    /// `build_native_session`); the trust lookup is `trust_db` (below —
    /// main AND subagent).
    pub(crate) db: Option<Arc<Db>>,
    /// The trust lookup source (ADR 0010): the `space_trusted` lookup the
    /// permission gate uses to auto-confirm a TRUSTED Space's `confirm`.
    /// Independent of `db` — `db` gates TRANSCRIPT PERSISTENCE (main only;
    /// `None` for subagents, which are ephemeral), while `trust_db` is the
    /// trust lookup for BOTH main and subagent Sessions (`None` = fail-
    /// closed: the gate prompts, today's flow).
    pub(crate) trust_db: Option<Arc<Db>>,
}

impl SessionDriver {
    /// Create a driver (no persistence / trust db).
    pub fn new() -> Self {
        Self {
            db: None,
            trust_db: None,
        }
    }
}

/// A factory that builds a `Provider` from a `Model` (the native path's
/// provider seam — `SessionManager::provider_factory`; the production
/// default dispatches on `Model.api` (`build_provider`, ADR 0024), a test
/// sets a mock before `start_session`). `pub` so a test can swap the
/// seam (the native session builds the `Provider` through it; the
/// subagent's Worker builds its own `Provider` from the `StartEnv`
/// catalog).
pub type ProviderFactory = Arc<dyn Fn(&Model) -> Box<dyn Provider> + Send + Sync>;

/// The effective-catalog supplier: the BASE catalog + the user's providers
/// from `settings.json` (a fresh read) + live per-provider discovery (`GET
/// /v1/models`, cached per-provider) — merged via `merge_catalog` (ADR
/// 0014). `resolve` is the extracted core of the old
/// `SessionManager::effective_catalog`: the `SessionManager` keeps a thin
/// wrapper over it, and the subagent's `StartEnv` catalog is built from it
/// so a named agent's `model:` frontmatter resolves against the EFFECTIVE
/// catalog at dispatch time (NOT a startup snapshot — the base catalog is
/// empty after the pi-config seeding removal, and a startup snapshot would
/// never resolve a user-provider model).
#[derive(Clone)]
pub struct EffectiveCatalog {
    pub config_dir: PathBuf,
    pub cache: Arc<tokio::sync::Mutex<HashMap<String, ProviderDiscovery>>>,
    pub base: ModelCatalog,
}

impl EffectiveCatalog {
    /// The effective catalog (the `SessionManager::effective_catalog` core):
    /// the base catalog + the user's providers from `settings.json` (fresh
    /// read via `load_settings`), discovered via `discover_models`
    /// (best-effort; the per-provider `cache` — `force_refresh` bypasses
    /// the cache for provider `force_refresh` when `Some`). A provider whose
    /// discovery fails contributes 0 models but still shadows the base
    /// models for its id (ADR 0014 — via `merge_catalog`'s
    /// `shadowed_provider_ids`).
    pub async fn resolve(&self, force_refresh: Option<&str>) -> ModelCatalog {
        let settings = load_settings(&self.config_dir);
        let mut user_models: Vec<Model> = Vec::new();
        let mut cache = self.cache.lock().await;
        for provider in &settings.providers {
            let entry = cache
                .entry(provider.id.clone())
                .or_insert_with(ProviderDiscovery::default);
            // `force_refresh` (a provider id) bypasses the cache for that
            // provider (the settings page's refresh affordance); a failed
            // re-fetch clears the stale entry (0 models — the provider row
            // shows `unreachable` + refresh, the stale base models stay
            // shadowed).
            let bypass = Some(provider.id.as_str()) == force_refresh;
            // `succeeded` (not just `attempted`) gates the cache: a FAILED
            // attempt is retried on the next read, because caching a negative
            // answer for the process's life means one transient outage (a launch
            // before the network is up) shows `unreachable` + 0 models until a
            // restart. A success — including a legitimately EMPTY one — caches.
            if !entry.succeeded || bypass {
                match discover_models(&provider.base_url, &provider.api_key, &provider.api).await {
                    Ok(models) => {
                        entry.models = models;
                        entry.succeeded = true;
                    }
                    Err(_) => {
                        entry.models.clear();
                        entry.succeeded = false;
                    }
                }
            }
            // A discovered model becomes a `Model`: the provider's
            // `base_url` / `api_key`; `context_window` falls back to
            // `DEFAULT_CONTEXT_WINDOW` (a user model has no static metadata);
            // the thinking fields map straight from the `DiscoveredMeta`
            // (`None` → `vec![]` / `false`); the provider's `api` decides
            // the wire (ADR 0024).
            for (id, meta) in &entry.models {
                user_models.push(Model {
                    id: id.clone(),
                    provider: provider.id.clone(),
                    base_url: provider.base_url.clone(),
                    api_key: provider.api_key.clone(),
                    context_window: meta.context_window.unwrap_or(DEFAULT_CONTEXT_WINDOW),
                    cost_per_mtok_in: 0.0,
                    cost_per_mtok_out: 0.0,
                    supports_tools: true,
                    supports_thinking: meta.supports_thinking.unwrap_or(false),
                    thinking_levels: meta.thinking_levels.clone().unwrap_or_default(),
                    api: Some(provider.api.clone()),
                });
            }
        }
        // EVERY configured provider id shadows (regardless of whether its
        // discovery succeeded — a provider that discovered 0 models still
        // replaces the stale base models for its id, ADR 0014).
        let shadowed: Vec<String> = settings.providers.iter().map(|p| p.id.clone()).collect();
        merge_catalog(&self.base, &user_models, &shadowed)
    }
}

/// Manages all live native sessions (the MAIN sessions).
///
/// Owns a [`SessionDriver`] (db: attached via [`Self::attach_db`],
/// `trust_db`: the same db, attached via [`Self::attach_db`],
/// captures: `None`, subagent: injected via [`Self::set_subagent_manager`])
/// plus the config dir (the `settings.json` home — the settings-driven
/// native session source) + the base model catalog. DB recording and
/// `record_session` stay here; the driver is delegated to. (The one-live
/// policy is LIFTED — sessions coexist; a session is torn down
/// only by an explicit `close_session` or a subagent cancel.)
///
/// `Sync` — the mutable state is `Arc<Mutex<…>>` internally, so the
/// manager is managed directly (no outer lock); each method locks only
/// its own internal maps, briefly.
pub struct SessionManager {
    driver: SessionDriver,
    config_dir: PathBuf,
    /// The BASE model catalog (the desktop is native-only — the catalog is
    /// the base of the effective catalog; a test overrides it via
    /// `set_catalog`). The effective catalog merges the user's providers
    /// (the `settings.json` `providers` list, ADR 0014) + live discovery
    /// over the base (see `effective_catalog` / `EffectiveCatalog`).
    catalog: ModelCatalog,
    /// The provider factory seam (reviewer-corrected Major #21): the native
    /// path builds the `Provider` through it (the production default
    /// dispatches on `Model.api` (`build_provider`, ADR 0024); a test sets
    /// a mock BEFORE `start_session`), so `start_session` never constructs
    /// the provider inline.
    provider_factory: ProviderFactory,
    /// The per-provider live-discovery cache (the `GET /v1/models` result —
    /// the OpenAI endpoint "supplies everything"; the `pi-provider-litellm`
    /// `fetchModels` pattern). At most one fetch per provider (a failed /
    /// unreachable endpoint is not retried every session); a failure /
    /// absent model degrades to the static metadata (an empty base catalog
    /// contributes nothing — the effective catalog IS the providers list).
    discovery_cache: Arc<tokio::sync::Mutex<HashMap<String, ProviderDiscovery>>>,
    // ── The Worker-based bookkeeping (ADR 0025 Task 4) ──────────────
    // The `AgentLoop` runs in the session's Worker; the `SessionManager`
    // is the Supervisor-side coordinator. The late-wire pattern (the
    // `SessionManager` ↔ `WorkerManager` construction cycle — the
    // `WorkerManager`'s `on_event` / `on_crash` callbacks need the
    // `SessionManager`'s router, and the `SessionManager` needs the
    // `WorkerManager` to send prompts): the `OnceLock`s break the cycle
    // (the `WorkerManager` is built with `OnceLock`-backed callbacks, the
    // router is injected after both are built, then the `WorkerManager`
    // is handed to the `SessionManager`).
    /// The `WorkerManager` (the Worker registry) — `attach` / `detach` /
    /// `send_prompt` / `send_config` / `send_abort` go through it.
    worker_manager: Arc<OnceLock<Arc<WorkerManager>>>,
    /// The `SubagentSessionManager` (the `dispatch_native` home — the
    /// ADR 0025 Task 5 re-plumb: the native dispatch runs in a WORKER
    /// via the `WorkerManager`'s `dispatch_subagent` flow; `None` until
    /// `set_subagent_manager`).
    subagent_manager: Arc<OnceLock<Arc<crate::agent::subagent::SubagentSessionManager>>>,
    /// The UI sink (the `TauriSink` — the router re-emits the `SinkFrame`s
    /// on it verbatim). Late-wired (the `setup_dirs` wiring).
    sink: Arc<OnceLock<Arc<dyn EventSink>>>,
    /// The store-frame applier (the Supervisor's sole-writer persistence).
    /// Late-wired in `attach_db` (it needs the `Db`).
    persister: Arc<OnceLock<Arc<TranscriptPersister>>>,
    /// The directory the crash logs land in — the app data dir
    /// (`…/archimedes`), which is exactly what the crash hook was handed at
    /// install time. Late-wired (`set_crash_log_dir`), because a router that
    /// resolved `dirs::data_dir()` itself could neither be tested over a temp
    /// dir nor kept out of the data-dir-resolving business the `crashlog`
    /// census forbids in the panic path. Production wires the value `setup()`
    /// already computes, so the lookup's effect is unchanged.
    crash_log_dir: Arc<OnceLock<PathBuf>>,
    /// The per-session config state (the `set_config_option` re-synthesizer
    /// source — the mirror's home moved from the `NativeHandle` here,
    /// field-for-field: `start` / `resume` initialize it, `set_config_option`
    /// updates it when a change is applied).
    config_state: Arc<StdMutex<HashMap<String, NativeConfigState>>>,
    /// Per-session session-naming state (the naming pass runs on every
    /// `agent_end`, so it needs to know "already running / given up"). The
    /// entry is dropped with the session (`close_session` / the exit cleanup).
    naming: Arc<StdMutex<HashMap<String, naming::NamingState>>>,
    /// The live, Worker-backed sessions (session_id → the coordinator state;
    /// replaces the main-session `LiveSession` / `driver.sessions` ownership).
    live: Arc<StdMutex<HashMap<String, LiveWorkerSession>>>,
    /// The Tauri AppHandle (the Supervisor-side headless renderer uses it to
    /// build hidden WebviewWindows on the platform main loop, Task 7).
    app_handle: Arc<OnceLock<tauri::AppHandle>>,
    /// The stalled sessions (session_id → `StalledInfo` — a Worker crash
    /// marks the session stalled; the frontend reads it via `stalled_info`).
    stalled: Arc<StdMutex<HashMap<String, StalledInfo>>>,
}
impl SessionManager {
    /// The configured config directory (useful for tests and diagnostics).
    pub fn config_dir(&self) -> &PathBuf {
        &self.config_dir
    }
    /// Create a manager (the config dir is the `settings.json` home — the
    /// settings-driven native session source; there is no agent registry
    /// and no pi config seeding: the desktop is native-only).
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            driver: SessionDriver::new(),
            config_dir,
            // The base catalog (empty — the desktop is native-only: the
            // effective catalog is the Settings' providers list + live
            // discovery, merged over the base, ADR 0014). Tests override it
            // via `set_catalog`.
            catalog: ModelCatalog::default(),
            // The provider factory seam (reviewer-corrected Major #21 —
            // the production default dispatches on `Model.api`
            // (`build_provider`, ADR 0024); a test sets a mock via
            // `set_provider_factory` BEFORE `start_session`).
            provider_factory: Arc::new(|m: &Model| build_provider(m)),
            discovery_cache: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            // The Worker-based bookkeeping (ADR 0025 Task 4) — the
            // `OnceLock`s are late-wired in `setup_dirs` (the
            // `SessionManager` ↔ `WorkerManager` cycle); the `StdMutex`
            // maps are fresh.
            worker_manager: Arc::new(OnceLock::new()),
            subagent_manager: Arc::new(OnceLock::new()),
            sink: Arc::new(OnceLock::new()),
            persister: Arc::new(OnceLock::new()),
            crash_log_dir: Arc::new(OnceLock::new()),
            config_state: Arc::new(StdMutex::new(HashMap::new())),
            naming: Arc::new(StdMutex::new(HashMap::new())),
            live: Arc::new(StdMutex::new(HashMap::new())),
            stalled: Arc::new(StdMutex::new(HashMap::new())),
            app_handle: Arc::new(OnceLock::new()),
        }
    }

    /// Attach the Tauri `AppHandle` (used for Supervisor-side web rendering).
    pub fn attach_app_handle(&self, app: tauri::AppHandle) {
        let _ = self.app_handle.set(app);
    }

    /// Inject the crash-log directory (the app data dir — `…/archimedes`;
    /// the late-wire `setup_dirs` wiring). `&self` (the `OnceLock` `set`
    /// needs no exclusive access) so it stays callable on an
    /// `Arc<SessionManager>` — the shape of `attach_app_handle`, NOT of
    /// `set_sink`, which is `&mut self` and cannot run once the manager is
    /// `Arc`-wrapped. Unset = no crash-log lookup (`StalledInfo.crash_log`
    /// is `None`), never a guessed path.
    pub fn set_crash_log_dir(&self, dir: PathBuf) {
        let _ = self.crash_log_dir.set(dir);
    }

    /// Inject the `WorkerManager` (the late-wire — the `setup_dirs` wiring
    /// builds the `WorkerManager` with callbacks pointing at THIS manager's
    /// router, then hands it here). `&self` (the `OnceLock` `set` needs no
    /// exclusive access) so the `Arc<SessionManager>` the `WorkerManager`
    /// callbacks capture can already own the manager. Set BEFORE any
    /// `start_session` / `send_prompt`. The ADR 0025 Task 5 re-plumb ALSO
    /// forwards it to the `SubagentSessionManager` (`set_worker_manager` —
    /// the `dispatch_native` delegation) and registers the child-cwd
    /// registrar (the `dispatch_subagent` flow's `ensure_session_row` —
    /// the ephemeral `sessions` row's `cwd` — the `StoreFrame` carries no
    /// `cwd`). The registrar's closure reads the `persister` `OnceLock`
    /// at CALL time (a dispatch runs after `attach_db`, so the persister
    /// is set by then; an unset persister is a no-op).
    pub fn attach_worker_manager(&self, wm: Arc<WorkerManager>) {
        let _ = self.worker_manager.set(wm.clone());
        if let Some(m) = self.subagent_manager.get() {
            m.set_worker_manager(wm.clone());
        }
        let persister = self.persister.clone();
        wm.set_cwd_registrar(Arc::new(move |session_id: &str, cwd: &str| {
            if let Some(p) = persister.get() {
                p.set_cwd(session_id, cwd);
            }
        }));
    }

    /// The `TranscriptPersister` (the `attach_worker_manager`'s
    /// child-cwd registrar's target — the `dispatch_subagent` flow's
    /// `ensure_session_row` creates the ephemeral `sessions` row with
    /// the child's `cwd`). `None` before `attach_db`.
    pub fn persister(&self) -> Option<Arc<TranscriptPersister>> {
        self.persister.get().cloned()
    }

    /// Inject the UI sink (the `TauriSink` — the router re-emits the
    /// `SinkFrame`s on it verbatim). Set BEFORE any `start_session`.
    pub fn set_sink(&mut self, sink: Arc<dyn EventSink>) {
        let _ = self.sink.set(sink);
    }

    /// Override the BASE model catalog (tests — the production base is
    /// empty; the effective catalog is the Settings' providers list + live
    /// discovery, merged over the base). Set BEFORE `start_session`.
    ///
    /// CAVEAT (tests): a session's `StartEnv` catalog is FIXED at
    /// `attach` time — a LATER `set_catalog` desynchronizes it (the
    /// running session's subagent dispatch keeps the old base; the
    /// subagent's model resolution runs against the PARENT's
    /// `StartEnv` catalog). Call `set_catalog` BEFORE `start_session`.
    pub fn set_catalog(&mut self, catalog: ModelCatalog) {
        self.catalog = catalog;
    }

    /// Inject the provider factory (reviewer-corrected Major #21 — the
    /// native path builds the `Provider` through it; the production default
    /// dispatches on `Model.api` (`build_provider`, ADR 0024)).
    /// Set BEFORE `start_session`.
    pub fn set_provider_factory(
        &mut self,
        f: impl Fn(&Model) -> Box<dyn Provider> + Send + Sync + 'static,
    ) {
        self.provider_factory = Arc::new(f);
    }

    /// Best-effort refresh a `Model`'s metadata (context window, thinking
    /// levels) from the provider's live `GET /v1/models` (the OpenAI
    /// endpoint "supplies everything" — the `pi-provider-litellm`
    /// `fetchModels` pattern). Bounded (a `discover_models` timeout) +
    /// cached per-provider (at most one fetch per provider — a failed /
    /// unreachable endpoint is NOT retried every session). A failure, or a
    /// model absent from the response, degrades to the static
    /// (`models-store.json`) metadata (the `Model` is returned unchanged).
    async fn refresh_model_metadata(&self, model: &Model) -> Model {
        if model.base_url.is_empty() {
            return model.clone();
        }
        let mut cache = self.discovery_cache.lock().await;
        let entry = cache
            .entry(model.provider.clone())
            .or_insert_with(ProviderDiscovery::default);
        if !entry.succeeded {
            // Best-effort: a failure (unreachable endpoint, non-2xx) leaves
            // `models` empty → the static metadata is kept. `succeeded` stays
            // false, so the NEXT session start retries rather than inheriting a
            // permanent `unreachable` from one lost race.
            if let Ok(models) = discover_models(
                &model.base_url,
                &model.api_key,
                model
                    .api
                    .as_deref()
                    .and_then(WireApi::parse)
                    .unwrap_or(WireApi::OpenAiCompletions)
                    .as_str(),
            )
            .await
            {
                entry.models = models;
                entry.succeeded = true;
            }
        }
        let Some(meta) = entry.models.get(&model.id) else {
            return model.clone();
        };
        // Apply the fresh metadata (only the `Some` fields — an absent
        // field keeps the static `models-store.json` value).
        let mut updated = model.clone();
        if let Some(cw) = meta.context_window {
            updated.context_window = cw;
        }
        if let Some(levels) = meta.thinking_levels.clone() {
            updated.thinking_levels = levels;
        }
        if let Some(st) = meta.supports_thinking {
            updated.supports_thinking = st;
        }
        updated
    }

    /// The effective catalog: the base catalog (the desktop is native-only —
    /// the base is the static catalog a test `set_catalog`s; production is
    /// empty) + the user's providers from `settings.json` (fresh read via
    /// `load_settings`), discovered via `discover_models` (best-effort; the
    /// existing per-provider `discovery_cache` — `force_refresh` bypasses
    /// the cache for provider `force_refresh` when `Some`). A provider whose
    /// discovery fails contributes 0 models but still shadows the base
    /// models for its id (ADR 0014 — via `merge_catalog`'s
    /// `shadowed_provider_ids`). Thin wrapper over
    /// [`EffectiveCatalog::resolve`] (the subagent's resolution uses the
    /// parent's `StartEnv` catalog, built from the same core).
    pub async fn effective_catalog(&self, force_refresh: Option<&str>) -> ModelCatalog {
        EffectiveCatalog {
            config_dir: self.config_dir.clone(),
            cache: self.discovery_cache.clone(),
            base: self.catalog.clone(),
        }
        .resolve(force_refresh)
        .await
    }

    /// Attach the persistence database. Sets BOTH `db` (transcript
    /// persistence) and `trust_db` (the ADR 0010 trust lookup) to the same
    /// db — main-session behavior is unchanged (same db, same lookup).
    /// Persistence is a no-op without it.
    pub fn attach_db(&mut self, db: Arc<Db>) {
        self.driver.db = Some(db.clone());
        self.driver.trust_db = Some(db.clone());
        // The store-frame applier (the Supervisor's sole-writer persistence —
        // it needs the `Db`). Late-wired here (the `Db` is attached after
        // `new`), unless already installed (e.g. via `SessionManagerBuilder`).
        if self.persister.get().is_none() {
            let _ = self.persister.set(Arc::new(TranscriptPersister::new(db)));
        }
    }

    /// Inject the subagent manager (main only — sets the driver's
    /// `subagent` handle so the main session's `task` tool can dispatch
    /// through it). The subagent manager needs nothing from the main
    /// manager; only this field points at it (intra-crate type cycles are
    /// fine in Rust).
    ///
    /// ALSO wires the native-harness deps onto the manager (set-once via
    /// `set_native_deps` — a `&self` `OnceLock`, so it's callable through
    /// the `Arc` received here): the `db` is the SIGNAL that native wiring
    /// is present (skipped when `None`); the `catalog` is the EFFECTIVE
    /// catalog supplier (`EffectiveCatalog` — the base catalog + the
    /// settings' providers + live discovery, resolved at dispatch time —
    /// the desktop is native-only, so a named agent's `model:` frontmatter
    /// resolves against the effective catalog, not a startup snapshot).
    /// `trust_db` IS threaded (the SAME db — ADR 0010: a native child in a
    /// trusted Space inherits the parent's trust); it is `Some` whenever
    /// `db` is (both are set together by `attach_db`).
    pub fn set_subagent_manager(&mut self, m: Arc<crate::agent::subagent::SubagentSessionManager>) {
        let _ = self.subagent_manager.set(m);
    }

    /// Provide a UI sink lookup for subagents running under this manager.
    pub fn sink_for_subagent(&self, _parent_session_id: &str) -> Option<Arc<dyn EventSink>> {
        self.sink.get().cloned()
    }

    /// Register a child subagent's cwd in the transcript persister.
    pub fn register_child_cwd(&self, session_id: &str, cwd: &str) {
        if let Some(p) = self.persister.get() {
            p.set_cwd(session_id, cwd);
        }
    }

    /// Dispatch a worker event into the router (alias for `route_event`).
    pub fn on_worker_event(&self, session_id: &str, is_subagent: bool, evt: WorkerInboundEvent) {
        self.route_event(session_id, is_subagent, evt);
    }

    /// Dispatch a worker crash into the crash handler (alias for `handle_crash`).
    pub fn on_worker_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>) {
        self.handle_crash(session_id, code, pid);
    }
}

/// `WorkerHooks` implementation bridging `WorkerManager` callbacks
/// to `SessionManager` via a `Weak<SessionManager>` reference.
struct SessionWorkerHooks {
    manager: std::sync::Weak<SessionManager>,
}

impl WorkerHooks for SessionWorkerHooks {
    fn on_event(&self, session_id: &str, is_subagent: bool, evt: WorkerInboundEvent) {
        if let Some(sm) = self.manager.upgrade() {
            sm.on_worker_event(session_id, is_subagent, evt);
        } else {
            crate::agent::debuglog::log("SessionWorkerHooks::on_event: SessionManager dropped");
        }
    }

    fn on_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>) {
        if let Some(sm) = self.manager.upgrade() {
            sm.on_worker_crash(session_id, code, pid);
        } else {
            crate::agent::debuglog::log("SessionWorkerHooks::on_crash: SessionManager dropped");
        }
    }

    fn sink_for(&self, parent_session_id: &str) -> Option<Arc<dyn EventSink>> {
        let sm = self.manager.upgrade()?;
        sm.sink_for_subagent(parent_session_id)
    }

    fn register_child_cwd(&self, session_id: &str, cwd: &str) {
        if let Some(sm) = self.manager.upgrade() {
            sm.register_child_cwd(session_id, cwd);
        }
    }
}

/// A builder for constructing [`SessionManager`] and [`WorkerManager`] pairs
/// via [`Arc::new_cyclic`] to break strong reference cycles.
pub struct SessionManagerBuilder {
    config_dir: PathBuf,
    db: Arc<Db>,
    catalog: ModelCatalog,
    sink: Arc<dyn EventSink>,
    crash_log_dir: Option<PathBuf>,
    subagent_manager: Option<Arc<crate::agent::subagent::SubagentSessionManager>>,
    app_handle: Option<tauri::AppHandle>,
    worker_factory: Option<Arc<dyn WorkerFactory>>,
    dead_bound: std::time::Duration,
    persister: Arc<TranscriptPersister>,
}

impl SessionManagerBuilder {
    pub fn new(
        config_dir: PathBuf,
        db: Arc<Db>,
        sink: Arc<dyn EventSink>,
        persister: Arc<TranscriptPersister>,
    ) -> Self {
        Self {
            config_dir,
            db,
            catalog: ModelCatalog::default(),
            sink,
            crash_log_dir: None,
            subagent_manager: None,
            app_handle: None,
            worker_factory: None,
            dead_bound: DEFAULT_SUBAGENT_DEAD_BOUND,
            persister,
        }
    }

    pub fn with_catalog(mut self, catalog: ModelCatalog) -> Self {
        self.catalog = catalog;
        self
    }

    pub fn with_crash_log_dir(mut self, dir: PathBuf) -> Self {
        self.crash_log_dir = Some(dir);
        self
    }

    pub fn with_subagent_manager(
        mut self,
        subagent: Arc<crate::agent::subagent::SubagentSessionManager>,
    ) -> Self {
        self.subagent_manager = Some(subagent);
        self
    }

    pub fn with_app_handle(mut self, app_handle: tauri::AppHandle) -> Self {
        self.app_handle = Some(app_handle);
        self
    }

    pub fn with_worker_factory(mut self, factory: Arc<dyn WorkerFactory>) -> Self {
        self.worker_factory = Some(factory);
        self
    }

    pub fn with_dead_bound(mut self, bound: std::time::Duration) -> Self {
        self.dead_bound = bound;
        self
    }

    pub fn with_dead_bound_secs(mut self, secs: u64) -> Self {
        self.dead_bound = std::time::Duration::from_secs(secs);
        self
    }

    pub fn build(self) -> (Arc<SessionManager>, Arc<WorkerManager>) {
        let factory = self
            .worker_factory
            .unwrap_or_else(|| Arc::new(crate::ProductionWorkerFactory));

        let mut wm_holder = None;

        let manager = Arc::new_cyclic(|weak_sm| {
            let hooks = Arc::new(SessionWorkerHooks {
                manager: weak_sm.clone(),
            });

            let wm = Arc::new(
                WorkerManager::with_hooks(factory, hooks).with_dead_bound(self.dead_bound),
            );

            let mut sm = SessionManager::new(self.config_dir);
            let _ = sm.persister.set(self.persister);
            sm.attach_db(self.db);
            sm.set_catalog(self.catalog);
            sm.set_sink(self.sink);

            if let Some(subagent) = self.subagent_manager {
                sm.set_subagent_manager(subagent);
            }
            if let Some(app_handle) = self.app_handle {
                sm.attach_app_handle(app_handle);
            }
            if let Some(dir) = self.crash_log_dir {
                sm.set_crash_log_dir(dir);
            }

            let _ = sm.worker_manager.set(wm.clone());
            if let Some(m) = sm.subagent_manager.get() {
                m.set_worker_manager(wm.clone());
            }

            wm_holder = Some(wm);
            sm
        });

        let wm = wm_holder.expect("WorkerManager was constructed inside cyclic closure");
        (manager, wm)
    }
}

impl SessionManager {
    /// Reset the session's open thinking segment at a prompt boundary. The
    /// frontend's `addUserMessage` starts a new thinking block on a user
    /// `persist_update`-era rule: the normalizer never sees user messages
    /// (they are recorded by the `send_prompt` paths, not the event
    /// normalizer) — so the Rust accumulator must be reset here, not in
    /// `compute_display_rows`.
    pub async fn begin_user_turn(&self, session_id: &str) {
        // (ADR 0025) The `thought_state` accumulator now lives in the
        // Worker's `AgentLoop` (the display rows are computed in the
        // Worker's `emit` and shipped as `DisplayUpsert` frames), so the
        // Supervisor's `thought_state` reset is a no-op — the Worker
        // resets its own accumulator at the prompt boundary. The method
        // stays (the `send_prompt` path is unchanged); it is a no-op.
        let _ = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_id);
    }

    /// Number of live sessions (the Worker-backed `live` map).
    pub async fn session_count(&self) -> usize {
        self.live.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    /// Record a session in the persistence layer (no-op without a database).
    fn record_session(&self, info: &SessionInfo) {
        if let Some(db) = &self.driver.db {
            let _ = db.record_session(info);
            // (settings) A start/resume updates or creates the space row
            // (and `resume` re-touches `last_opened_at`): a space is
            // born/touched when a conversation starts or resumes in it.
            // A NEW row is born `trusted` per the settings'
            // `default_trust_new_spaces` (the sync `load_settings` —
            // `record_session` is sync); the CONFLICT branch never touches
            // an existing row's flag (no retroactive trust).
            let _ = db.upsert_space(
                &info.cwd.display().to_string(),
                load_settings(&self.config_dir).default_trust_new_spaces,
            );
        }
    }

    /// The NATIVE session (Task 7): resolve the model (the harness's
    /// `default_model` → the `ModelCatalog`), build the `Provider` (the
    /// `provider_factory` seam), the `SessionStore` (the `native_messages`
    /// table), and the `AgentLoop` — `tokio::spawn` it (IN-PROCESS; no
    /// subprocess), drive it (the `drive_native_session` driver task —
    /// `pending_turn` / `settle_tx` / `close_kind` populated IDENTICALLY to
    /// the external path), and record the session (the `capabilities_json`
    /// has NO `piSessionFile` — resume is from the `native_messages`
    /// table, so `loadSession` is `true`).
    ///
    /// The `config_options` are SYNTHESIZED from the `ModelCatalog` (the
    /// existing `synthesize_config_options` shape — the frontend is
    /// unchanged; a new `get_models` command driving a native-only picker
    /// would be a UI change, so there is none).
    /// The native session (the desktop is native-only, ADR 0011): resolve
    /// the model (the `Settings.default_model` → the catalog default —
    /// the resolution chain, never a hard error), build the `Provider`
    /// (the `provider_factory` seam), the `SessionStore` (the
    /// `native_messages` table), and the `AgentLoop` — `tokio::spawn` it
    /// (IN-PROCESS; no subprocess), drive it (the `drive_native_session`
    /// driver task — `pending_turn` / `settle_tx` / `close_kind` populated
    /// identically to a subagent dispatch), and record the session (the
    /// `capabilities_json` has NO `piSessionFile` — resume is from the
    /// `native_messages` table, so `loadSession` is `true`).
    ///
    /// The `config_options` are SYNTHESIZED from the `ModelCatalog` (the
    /// `synthesize_catalog_config_options` shape — the frontend is
    /// unchanged).
    /// A FRESH session (ADR 0025): resolve the model (the `Settings.default_model`
    /// → the catalog default — the resolution chain, never a hard error), build the
    /// `StartEnv` (the `AgentLoop` runs in the Worker — Task 2's `build_loop` builds
    /// it; the Supervisor only supplies the envelope), `attach` the Worker (a spawn
    /// failure → the command returns an error — the visible session error, NO
    /// in-process fallback), and record the session (the `capabilities_json` has NO
    /// `piSessionFile` — resume is from the `native_messages` table, so
    /// `loadSession` is `true`). The `config_options` are synthesized from the
    /// `ModelCatalog` (the existing shape — the frontend is unchanged).
    async fn start_native_session(
        &self,
        cwd: PathBuf,
        sink: &Arc<dyn EventSink>,
    ) -> Result<SessionInfo, SessionError> {
        self.establish_worker_session(cwd, None, sink).await
    }

    /// A RESUME (ADR 0025): the `native_messages` re-read (the
    /// `SessionStore::load_messages` path — moved from harness to Supervisor) +
    /// the `StartEnv { mode: Resume, transcript: Some(…) }` + `attach` (a fresh
    /// Worker + re-hydrate — a `stalled` session's resume is this same path). The
    /// model comes from the stored `capabilities.model` (a stale / unknown key
    /// falls back to the resolution chain); the thinking level from the stored
    /// `thinkingLevel` (the resolution chain (remembered → stored → settings)
    /// resolves in `establish_worker_session`, after the model metadata refresh).
    async fn resume_native_session(
        &self,
        session_id: &str,
        cwd: PathBuf,
        sink: &Arc<dyn EventSink>,
    ) -> Result<SessionInfo, SessionError> {
        let db = self.driver.db.clone().ok_or_else(|| {
            SessionError::Io("a native session requires an attached database".to_string())
        })?;
        // The stored row must exist (a native session is recorded at start —
        // `record_session`; a missing row is unresumable). KEEP THE WHOLE ROW:
        // the resume carries the desktop's `archived` flag (ADR 0016) + the
        // stored `title` + the stored `context_usage` + the stored
        // `cost_usd` (#105 — the figure the next priced call adds to).
        let row =
            db.session(session_id)
                .ok()
                .flatten()
                .ok_or_else(|| SessionError::NotResumable {
                    id: session_id.to_string(),
                })?;
        let caps: Value = serde_json::from_str(&row.capabilities_json).unwrap_or(Value::Null);
        let catalog = self.effective_catalog(None).await;
        let settings = load_settings(&self.config_dir);
        let model = caps
            .get("model")
            .and_then(Value::as_str)
            .and_then(|key| resolve_composed_model(&catalog, key))
            .or_else(|| resolve_native_model(&catalog, &settings.default_model).ok())
            .ok_or_else(|| SessionError::Command {
                error: "no models available for the native session".to_string(),
            })?;
        let stored_level = caps
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .map(str::to_string);
        let context_usage = row
            .context_usage_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<ContextUsage>(s).ok());
        self.establish_worker_session(
            cwd,
            Some(ResumeCtx {
                session_id: session_id.to_string(),
                model,
                stored_level,
                archived: row.archived,
                title: row.title,
                context_usage,
                // The stored figure passes straight through — the column is
                // already typed `REAL`, so (unlike `context_usage_json`)
                // there is nothing to parse.
                cost_usd: row.cost_usd,
            }),
            sink,
        )
        .await
    }

    /// Establish one Worker-backed session (shared by `start` / `resume`;
    /// `resume` carries the stored `session_id` + the loaded transcript source —
    /// `start` mints a fresh UUID and starts with an empty transcript). Resolves
    /// the model + thinking level (the ADR 0015 chain), builds the `StartEnv`,
    /// `attach`es the Worker (a spawn failure → an error — NO in-process fallback),
    /// records the session, and stores the per-session coordinator state. The
    /// returned `SessionInfo` carries the stored `title` on a resume (`None` on
    /// a fresh start — nothing has named it yet).
    #[allow(clippy::too_many_arguments)]
    async fn establish_worker_session(
        &self,
        cwd: PathBuf,
        resume: Option<ResumeCtx>,
        sink: &Arc<dyn EventSink>,
    ) -> Result<SessionInfo, SessionError> {
        // The `WorkerManager` (the late-wire — the `setup_dirs` wiring attached it
        // before any `start_session` / `send_prompt`).
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let db = self.driver.db.clone().ok_or_else(|| {
            SessionError::Io("a native session requires an attached database".to_string())
        })?;
        // The EFFECTIVE catalog (the base catalog + the user's providers, a fresh
        // `load_settings` read; the per-provider `discovery_cache` makes the fetch
        // cheap): the model resolution + the `StartEnv`'s `catalog`.
        let catalog = self.effective_catalog(None).await;
        let settings = load_settings(&self.config_dir);
        let is_resume = resume.is_some();
        let (session_id, model, stored_level, archived, title, context_usage, cost_usd) =
            match resume {
                Some(ctx) => (
                    ctx.session_id,
                    ctx.model,
                    ctx.stored_level,
                    ctx.archived,
                    ctx.title,
                    ctx.context_usage,
                    ctx.cost_usd,
                ),
                None => (
                    mint_session_id(),
                    resolve_native_model(&catalog, &settings.default_model)?,
                    None,
                    false,
                    None,
                    None,
                    // A FRESH session has never had a priced call: `None`,
                    // which is NOT `Some(0.0)` (D5 / ADR 0082).
                    None,
                ),
            };
        // (live `/v1/models` discovery) Best-effort refresh the model's metadata
        // (the same as before; a failure degrades to the static metadata).
        let model = self.refresh_model_metadata(&model).await;
        // (ADR 0015) The effective thinking level (the same chain as before —
        // remembered > stored > settings > `None`).
        let thinking_level = remembered_thinking_level(&settings.default_thinking_levels, &model)
            .or_else(|| {
                stored_level
                    .as_ref()
                    .filter(|l| model.supports_thinking_level(l))
                    .cloned()
            })
            .or_else(|| {
                settings
                    .default_thinking_level
                    .as_ref()
                    .filter(|l| model.supports_thinking_level(l))
                    .cloned()
            });
        // The `StartEnv` (the `AgentLoop` runs in the Worker — Task 2's
        // `build_loop` builds it; the Supervisor supplies the envelope). A RESUME
        // carries the `native_messages` re-read (the `SessionStore::load_messages`
        // path — moved from harness to Supervisor); a FRESH session has no
        // transcript (the Worker builds the main system prompt itself, seq 0).
        let transcript = if is_resume {
            let store = Arc::new(SessionStore::new(db.clone()));
            // A corrupt transcript row must NOT silently load as an empty one
            // (store.rs): the next persist would upsert over the stored rows
            // (seq 0 = the system prompt, cascading to seq 1, 2, …), so a load
            // failure fails the session start.
            let messages = store
                .load_messages(&session_id)
                .map_err(|e| SessionError::Io(e.to_string()))?;
            Some(messages)
        } else {
            None
        };
        let env = StartEnv::from_parts(
            session_id.clone(),
            cwd.display().to_string(),
            if is_resume {
                StartMode::Resume
            } else {
                StartMode::Fresh
            },
            transcript,
            model.clone(),
            catalog.clone(),
            thinking_level.clone(),
            db.space_trusted(&cwd).unwrap_or(false),
            if settings.enabled_tools.is_empty() {
                None
            } else {
                Some(settings.enabled_tools.clone())
            },
            self.config_dir.display().to_string(),
            true, // `subagent_enabled` (main session — the Worker's `subagent` tool)
            None, // `system_prompt` (main sessions: the Worker builds the main prompt)
            // (issue #101) A MAIN session has no `AgentDefinition` at all, so
            // there is no per-agent ruleset to carry — `None` here is CORRECT,
            // not a dropped carry (the status file's finding: no main-session
            // path passes a definition). The per-agent layer governs CHILDREN.
            None,
        );
        // SPAWN the Worker (a spawn failure → the command returns an error — the
        // visible session error, NO in-process fallback — ADR 0025).
        wm.attach(&session_id, &env)
            .await
            .map_err(|e| SessionError::Command {
                error: format!("spawn the session's Worker: {e}"),
            })?;
        // The `SessionInfo` (the `capabilities` envelope — the `native_capabilities`
        // shape; the `config_options` synthesized from the EFFECTIVE catalog — the
        // `StartEnv`'s `catalog` is the effective catalog). Block-scoped so the
        // `MutexGuard` (and the `Arc` it borrows through) die BEFORE the `await`
        // below (a `std::sync::MutexGuard` is not `Send`).
        let info = SessionInfo {
            session_id: session_id.clone(),
            cwd: cwd.clone(),
            capabilities: native_capabilities(&env.model, env.thinking.as_deref()),
            config_options: synthesize_catalog_config_options(
                &env.catalog,
                &env.model,
                env.thinking.as_deref(),
            ),
            archived,
            // The stored title on a resume (the label survives the
            // round-trip); `None` on a fresh start (the naming pass has not
            // run yet).
            title,
            context_usage,
            // The stored figure on a resume (`None` on a fresh start) — the
            // Client seeds its live accumulator from this, so a resumed
            // session continues its total instead of restarting it.
            cost_usd,
            is_subagent: false,
        };
        // The `sessions` row (the FK source for the Worker's `native_messages`
        // upserts — the `TranscriptPersister`'s `ensure_session_row` is a no-op
        // for a main session; this records it up front) + the `persister`'s
        // `cwd` map (the `ensure_session_row` source).
        self.record_session(&info);
        if let Some(p) = self.persister.get() {
            p.set_cwd(&session_id, &cwd.display().to_string());
        }
        // The per-session coordinator state (the config-state mirror — the
        // `set_config_option` re-synthesizer source; the `live` entry — the
        // `pending_turn` / `cancel_requested` / `close_kind` / `pending_modal_ids`).
        self.config_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                session_id.clone(),
                NativeConfigState {
                    model: env.model.clone(),
                    thinking_level: env.thinking.clone(),
                },
            );
        let live = LiveWorkerSession {
            cwd: cwd.clone(),
            close_kind: Arc::new(StdMutex::new(None)),
            pending_turn: Arc::new(StdMutex::new(None)),
            cancel_requested: Arc::new(StdMutex::new(false)),
            pending_modal_ids: StdMutex::new(HashSet::new()),
        };
        self.live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_id.clone(), live);
        // The `sink` is threaded for the `config_option_update` re-synthesis
        // (the `set_config_option` path); the router uses `self.sink` (the
        // `setup_dirs` wiring) for the `SinkFrame` re-emit.
        let _ = sink;
        Ok(info)
    }

    /// All stored sessions, in the user's MANUAL ORDER (`Db::list_sessions`),
    /// as `SessionInfo` (the `list_sessions` command's shape): the row's
    /// `capabilities` (the
    /// `normalize_capabilities` camelCase envelope), `config_options`
    /// synthesized from the stored `model` / `thinkingLevel` (the same
    /// resolution as `resume_native_session` — the stored composed key →
    /// the effective catalog; an absent / unresolvable key falls back to
    /// the resolution chain, never a hard error) so a STORED session's
    /// composer selectors are populated (the frontend renders them
    /// disabled — a stored session can't receive `set_config_option`),
    /// `title` read straight from the row (`None` until the naming pass
    /// writes one — the sidebar's label for a CLOSED session, whose live
    /// `SessionInfo` is long gone), and `context_usage` read from the row's
    /// `context_usage_json` (the last known usage — the frontend's store
    /// drops it on close, so the row is the source of truth for the stored
    /// session's context bar), and `cost_usd` read straight from the row's
    /// typed `cost_usd` column (#105 — the same reason: the store drops its
    /// cost entry on close, so the row is the only source a CLOSED session's
    /// figure has).
    pub async fn list_sessions(
        &self,
        include_archived: bool,
    ) -> Result<Vec<SessionInfo>, SessionError> {
        let db = self.driver.db.clone().ok_or_else(|| {
            SessionError::Io("list_sessions requires an attached database".to_string())
        })?;
        let rows = db
            .list_sessions(include_archived)
            .map_err(|e| SessionError::Io(e.to_string()))?;
        let catalog = self.effective_catalog(None).await;
        let settings = load_settings(&self.config_dir);
        Ok(rows
            .into_iter()
            .map(|row| {
                let caps: Value =
                    serde_json::from_str(&row.capabilities_json).unwrap_or(Value::Null);
                // The model: the stored `model` (a composed key → the
                // effective catalog); an absent / unresolvable key falls
                // back to the resolution chain (the settings default →
                // the catalog default → the selectable set — never a
                // hard error). `None` when the chain is empty (no models
                // at all — the options can't be synthesized).
                let model = caps
                    .get("model")
                    .and_then(Value::as_str)
                    .and_then(|key| resolve_composed_model(&catalog, key))
                    .or_else(|| resolve_native_model(&catalog, &settings.default_model).ok());
                let thinking_level = caps
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                SessionInfo {
                    session_id: row.id,
                    cwd: PathBuf::from(row.cwd),
                    capabilities: normalize_capabilities(&row.capabilities_json),
                    config_options: model.as_ref().and_then(|m| {
                        synthesize_catalog_config_options(&catalog, m, thinking_level.as_deref())
                    }),
                    archived: row.archived,
                    // The stored title (the naming pass's label) — the boot
                    // fetch is the only source a CLOSED session's title has,
                    // since the live store dropped it on close.
                    title: row.title,
                    is_subagent: row.is_subagent,
                    // (#85) `used` is a real measurement of this session, so it
                    // is replayed from the snapshot as-is. `window` is NOT: it is
                    // a fact about the MODEL, frozen when the frame was written,
                    // so a corrected provider would leave every closed session
                    // showing a stale window forever.
                    //
                    // The derivation reads the stored `capabilities.model` — the
                    // model this row ACTUALLY RAN — and not the `model` above,
                    // which falls back to the resolution chain for its own
                    // display purpose. That distinction is load-bearing: pairing
                    // `used` (measured against the old model's window) with an
                    // unrelated fallback model's window would report a
                    // confidently wrong percentage. So an unresolvable stored key
                    // keeps its snapshot, which is then the only window known.
                    context_usage: row
                        .context_usage_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<ContextUsage>(s).ok())
                        .map(|usage| {
                            let live_window = caps
                                .get("model")
                                .and_then(Value::as_str)
                                .and_then(|key| resolve_composed_model(&catalog, key))
                                .map(|m| u64::from(m.context_window));
                            ContextUsage {
                                window: live_window.unwrap_or(usage.window),
                                ..usage
                            }
                        }),
                    // (#105) The stored running cost, straight off the typed
                    // column — no parsing, no derivation. `None` stays `None`
                    // (a session that never reported a cost has no figure,
                    // which the renderer spells as no element; `Some(0.0)` is
                    // a real zero and renders `$0.00` — D5 / ADR 0082).
                    cost_usd: row.cost_usd,
                }
            })
            .collect())
    }

    /// Start a native session: canonicalize the cwd, then delegate to
    /// [`Self::start_native_session`] (the desktop is native-only — there
    /// is no external path and no agent id; the model / thinking level /
    /// tools come from the `Settings`).
    ///
    /// Returns the [`SessionInfo`] once the session is established. The
    /// loop is driven by a background task that lives for the session's
    /// lifetime; it is torn down by [`Self::close_session`].
    pub async fn start_session(
        &self,
        cwd: PathBuf,
        sink: &Arc<dyn EventSink>,
    ) -> Result<SessionInfo, SessionError> {
        // Canonicalize BEFORE the space row is touched: the spaces join
        // key is the canonicalized cwd, so a `~/x` / symlink spelling must
        // not produce a different row.
        let cwd = std::fs::canonicalize(&cwd).map_err(|_| SessionError::FolderMissing {
            path: cwd.display().to_string(),
        })?;
        self.start_native_session(cwd, sink).await
    }

    /// Resume a stored session: canonicalize the cwd, then delegate to
    /// [`Self::resume_native_session`] (a fresh `AgentLoop` +
    /// `SessionStore::load_messages` — resume from the `native_messages`
    /// table; the stored row's `model` / `thinkingLevel` override the
    /// resolution chains).
    ///
    /// Returns [`SessionError::NotResumable`] when the stored row is
    /// missing (the UI shows the history-only banner instead).
    pub async fn resume_session(
        &self,
        session_id: &str,
        cwd: PathBuf,
        sink: &Arc<dyn EventSink>,
    ) -> Result<SessionInfo, SessionError> {
        // Canonicalize (same rationale as `start_session`): everything
        // downstream (the loop cwd, `SessionInfo.cwd`, the space join key)
        // uses the canonical path.
        let cwd = std::fs::canonicalize(&cwd).map_err(|_| SessionError::FolderMissing {
            path: cwd.display().to_string(),
        })?;
        self.resume_native_session(session_id, cwd, sink).await
    }

    /// Send a prompt to a live session and wait for the turn to finish.
    ///
    /// Returns the [`StopReason`] the turn resolved to (the frontend needs
    /// the turn-completion signal).
    pub async fn send_prompt(
        &self,
        session_id: &str,
        text: String,
    ) -> Result<StopReason, SessionError> {
        self.send_prompt_with_images(session_id, text, Vec::new())
            .await
    }

    /// Like `send_prompt`, but with image attachments: validates them
    /// (`validate_images`), appends pi `image` content (text first), and
    /// persists `{ "text", "images": [...] }` in the transcript (the
    /// `images` key omitted when empty — ADR 0008).
    ///
    /// The user-row persistence lives SOLELY here (the command delegates to
    /// this method and adds NO persistence of its own — a double write
    /// would show a duplicate user bubble). The turn resolves on
    /// `agent_settled` (the driver's `pending_turn` oneshot): a
    /// `success: false` prompt response maps to `Refusal`, a cancel maps to
    /// `Cancelled` (the `cancel_requested` flag), everything else to
    /// `EndTurn`.
    pub async fn send_prompt_with_images(
        &self,
        session_id: &str,
        text: String,
        images: Vec<ImagePayload>,
    ) -> Result<StopReason, SessionError> {
        // The `WorkerManager` (the late-wire) + the per-session coordinator
        // state (the `LiveWorkerSession` — the `pending_turn` / `cancel_requested`
        // moved from the `NativeHandle` here).
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let (pending_turn, cancel_requested) = {
            let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
            let live = live
                .get(session_id)
                .ok_or_else(|| SessionError::UnknownSession {
                    id: session_id.to_string(),
                })?;
            (live.pending_turn.clone(), live.cancel_requested.clone())
        };

        // Validate the images FIRST: a rejected payload must NOT be written
        // to the transcript and must NOT start a user turn — validating
        // before persisting is what keeps the "cap bounds DB growth"
        // guarantee real.
        validate_images(&images)?;

        // A session is one-turn-at-a-time (the frontend's composer is locked
        // until the turn resolves): a turn ALREADY IN FLIGHT (the `pending_turn`
        // slot is occupied) is REJECTED rather than queued. The check-and-claim
        // is ATOMIC under ONE `pending_turn` lock acquisition (finding 2 — the
        // resolver is claimed BEFORE the user-row write / dispatch, so a settle
        // arriving while the prompt is in flight is never lost on an empty slot).
        let (tx, rx) = oneshot::channel::<StopReason>();
        {
            let mut slot = pending_turn.lock().unwrap_or_else(|p| p.into_inner());
            if slot.is_some() {
                return Err(SessionError::Command {
                    error: "a turn is already in flight".to_string(),
                });
            }
            *slot = Some(tx);
        }
        // Reset the cancel flag (a fresh turn is not a cancel).
        *cancel_requested.lock().unwrap_or_else(|p| p.into_inner()) = false;

        // Record the user's message in the transcript (the client owns history)
        // before the turn begins — the USER DISPLAY ROW write stays Supervisor-side
        // (the Worker persists only the provider-transcript user row via the store
        // frames; the display row + `begin_user_turn` stay in the `send_prompt`
        // path, unchanged).
        self.begin_user_turn(session_id).await;
        if let Some(db) = &self.driver.db {
            let payload = user_message_payload(&text, &images);
            let _ = db.record_message(session_id, "user", None, &payload.to_string());
        }

        // Queue the text + the image attachments on the WORKER's prompt queue
        // (the `Prompt` frame — the `ImagePayload` maps onto the wire `ImageRef`).
        // A `SendError` (the Worker died / the stdin pipe closed) maps to the
        // same error path as a refusal below (resolve the turn `Refusal`).
        let image_refs: Vec<ImageRef> = images
            .iter()
            .map(|img| ImageRef {
                data: img.data.clone(),
                mime_type: img.mime_type.clone(),
            })
            .collect();
        let send_error = match wm.handle_for(session_id) {
            Some(handle) => match handle.send_prompt(&text, &image_refs) {
                Ok(()) => None,
                Err(e) => Some(SessionError::Command {
                    error: format!("send the prompt to the session's Worker: {e}"),
                }),
            },
            None => Some(SessionError::UnknownSession {
                id: session_id.to_string(),
            }),
        };

        // A `success: false` prompt (the Worker died) — resolve the turn
        // `Refusal` without waiting for a settle that never comes.
        if let Some(e) = send_error {
            match e {
                SessionError::Command { error } => {
                    let mut slot = pending_turn.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(tx) = slot.take() {
                        let _ = tx.send(StopReason::Refusal);
                    }
                    return Err(SessionError::Command { error });
                }
                other => return Err(other),
            }
        }

        // Await the turn (unbounded — the turn can block on a user-paced permission
        // prompt). The Worker's `agent_settled` (the `Event(RpcEvent)` bookkeeping)
        // resolves the `pending_turn` (the router); a dropped resolver (replaced by
        // a new prompt, or the session died — the `Exited` / crash path) maps to
        // `Cancelled` (the composer unlocks — it never stays locked forever).
        match rx.await {
            Ok(reason) => Ok(reason),
            Err(_) => Ok(StopReason::Cancelled),
        }
    }

    /// Cancel the session's in-flight prompt turn (the user pressed Esc).
    /// The `cancel_requested` flag is set BEFORE the cancel is sent so a
    /// fast settle maps to `Cancelled`, not `EndTurn`. Fire-and-forget on
    /// the loop side: a no-op if there is no in-flight turn.
    ///
    /// BEHAVIOR (finding 8c): `handle.cancel()` cancels the loop's current
    /// TURN token — the loop settles the turn `Cancelled` and STAYS ALIVE
    /// (a new prompt reuses the session; only a `close_session` —
    /// `handle.close` — tears the session down). Pre-fix the Stop cancelled
    /// the loop's teardown token, which ENDED THE WHOLE SESSION (the driver
    /// tore it down) — a silent asymmetry with the pi `abort`.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), SessionError> {
        // The `WorkerManager` (the late-wire) + the per-session coordinator
        // state (the `cancel_requested` moved from the `NativeHandle` here).
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let cancel_requested = {
            let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
            live.get(session_id)
                .map(|l| l.cancel_requested.clone())
                .ok_or_else(|| SessionError::UnknownSession {
                    id: session_id.to_string(),
                })?
        };
        // The `cancel_requested` flag is set BEFORE the `abort` is sent so a fast
        // settle maps to `Cancelled`, not `EndTurn`. Fire-and-forget on the Worker
        // side: a no-op if there is no in-flight turn. BEHAVIOR (finding 8c): the
        // `abort` cancels the Worker's current TURN token — the loop settles the
        // turn `Cancelled` and STAYS ALIVE (a new prompt reuses the session; only a
        // `close_session` tears the session down).
        *cancel_requested.lock().unwrap_or_else(|p| p.into_inner()) = true;
        if let Some(handle) = wm.handle_for(session_id) {
            let _ = handle.send_abort();
        }
        Ok(())
    }

    /// Compact a session NOW (the `/compact` Composer command — ADR 0044).
    /// The frame goes to the session's Worker, which applies it on the loop's
    /// CONTROL channel when the loop is IDLE (the composer is locked during a
    /// turn, so a hand-triggered compaction is always an idle action).
    ///
    /// The return is "the command was delivered", not "the transcript shrank":
    /// the outcome rides the event stream (`compaction_start` /
    /// `compaction_end`). A session that is NOT live (a stored session) is a
    /// NO-OP returning `Ok(false)` — resuming a session in order to compact it
    /// is a larger flow than the command is worth, and the resume's own
    /// re-estimate is what reveals whether compaction is even needed.
    ///
    /// `cancel_requested` is deliberately NOT touched: `send_prompt` clears it
    /// and the router reads it only while a turn slot is occupied, so an idle
    /// compaction that set it would map the NEXT settle to `Cancelled`.
    pub async fn compact_session(
        &self,
        session_id: &str,
        instructions: Option<String>,
    ) -> Result<bool, SessionError> {
        // The `WorkerManager` (the late-wire) — the frame's only route.
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let is_live = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(session_id);
        if !is_live {
            // A stored (non-live) session: a no-op, never an error.
            return Ok(false);
        }
        let Some(handle) = wm.handle_for(session_id) else {
            // `live` but no Worker (it is gone) — the frame cannot be sent.
            return Err(SessionError::UnknownSession {
                id: session_id.to_string(),
            });
        };
        // The `Ok(true)` means the frame WAS sent (finding 12's precedent, the
        // `set_config_option` mirror-on-success rule): a failed send (the
        // Worker died / the pipe closed) is the caller's error, never a
        // reported success.
        handle
            .send_compact(instructions)
            .map_err(|e| SessionError::Command {
                error: format!("the session's Worker is not running; the compaction could not be requested: {e}"),
            })?;
        Ok(true)
    }

    /// Set a session config option (the model or the thinking level) on a
    /// live session.
    ///
    /// Applies the change through the loop's control channel (`AgentLoop::set_model`
    /// / `set_thinking_level` — applied when the loop is idle), then
    /// re-synthesizes the config options FROM THE `ModelCatalog` (a native
    /// session has no `get_state`) and emits a `config_option_update` (the
    /// agent does not emit one itself — the client owns the frame).
    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
        sink: &Arc<dyn EventSink>,
    ) -> Result<Vec<Value>, SessionError> {
        // The `WorkerManager` (the late-wire) + the per-session config state
        // (the `NativeConfigState` mirror moved from the `NativeHandle` here —
        // the `set_config_option` re-synthesizer source).
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let state = {
            let config_state = self.config_state.lock().unwrap_or_else(|p| p.into_inner());
            config_state
                .get(session_id)
                .cloned()
                .ok_or_else(|| SessionError::UnknownSession {
                    id: session_id.to_string(),
                })?
        };

        // The `Model` lookup + the re-synthesizer run against the EFFECTIVE
        // catalog (the base catalog + the user's providers — a user-provider
        // model can be switched TO mid-session, not just the base ones).
        let catalog = self.effective_catalog(None).await;
        // Apply (the `WorkerManager`'s `send_config` — the `Config` frame → the
        // Worker's `AgentLoop` `set_model` / `set_thinking_level`, applied when
        // the loop is idle) + mirror the change on the config state (the
        // re-synthesizer source). Mirror + emit ONLY when the `send_config`
        // SUCCEEDS (finding 12): a failed send (the Worker died / the pipe
        // closed) means the loop never applies the change — claiming success
        // (a mirrored state + a `config_option_update`) would silently diverge
        // from the model / level the loop is actually running.
        match config_id {
            "model" => {
                let key = ModelKey::parse(value).ok_or_else(|| SessionError::InvalidPrompt {
                    reason: format!("invalid model value: {value} (expected provider/modelId)"),
                })?;
                let model = catalog
                    .models
                    .iter()
                    .find(|m| m.provider == key.provider && m.id == key.id)
                    .cloned()
                    .ok_or_else(|| SessionError::Command {
                        error: format!("unknown model: {value}"),
                    })?;
                self.send_config_to(&wm, session_id, Some(&model), None, None)?;
                self.update_config_state(session_id, |s| s.model = model.clone());
                // (ADR 0015) Minimal-surprise reset: the current level is KEPT across
                // the switch when valid for the new model (its `thinking_levels` are
                // non-empty and contain it — or EMPTY, the status quo); it is replaced
                // (the new model's remembered level, or `None`) only when the new model
                // doesn't support it. The second `send_config` mirrors ONLY on success
                // (finding 12): a failed send leaves the mirror untouched. The arm does
                // NOT write memory.
                let level = self
                    .config_state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(session_id)
                    .and_then(|s| s.thinking_level.clone());
                if let Some(level) = level {
                    let valid = model.supports_thinking_level(&level);
                    if !valid {
                        let reset = remembered_thinking_level(
                            &load_settings(&self.config_dir).default_thinking_levels,
                            &model,
                        );
                        let sent =
                            self.send_config_to(&wm, session_id, None, reset.as_deref(), None);
                        if sent.is_ok() {
                            self.update_config_state(session_id, |s| {
                                s.thinking_level = reset.clone();
                            });
                        }
                    }
                }
            }
            "thought_level" => {
                // (review finding) An empty level is rejected BEFORE the `send_config`
                // is touched (mirroring the model arm's rejection of an unresolvable
                // key — an empty level would flow `reasoning_effort: Some("")` into the
                // provider request body, which some endpoints reject).
                if value.is_empty() {
                    return Err(SessionError::Command {
                        error: "a thinking level must be non-empty".to_string(),
                    });
                }
                self.send_config_to(&wm, session_id, None, Some(value), None)?;
                self.update_config_state(session_id, |s| {
                    s.thinking_level = Some(value.to_string());
                });
                // (ADR 0015) Remember the level for the session's CURRENT model
                // (best-effort: a write failure is logged and does NOT fail the config
                // change — the level is applied in the loop either way; the value is
                // guaranteed non-empty — an empty one is rejected above).
                let key = ModelKey::from(&state.model).to_string();
                let mut settings = load_settings(&self.config_dir);
                settings
                    .default_thinking_levels
                    .insert(key, value.to_string());
                if let Err(e) = write_settings(&self.config_dir, &settings) {
                    eprintln!("remembered thinking level: save failed: {e}");
                }
            }
            other => {
                return Err(SessionError::Command {
                    error: format!("unknown config option: {other}"),
                })
            }
        }
        // Re-synthesize FROM THE `ModelCatalog` (a native session has no `get_state`)
        // + emit (the agent does not emit a `config_option_update` itself — the
        // client owns the frame).
        let state = self
            .config_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_id)
            .cloned()
            .ok_or_else(|| SessionError::UnknownSession {
                id: session_id.to_string(),
            })?;
        let options = synthesize_catalog_config_options(
            &catalog,
            &state.model,
            state.thinking_level.as_deref(),
        )
        .ok_or_else(|| SessionError::Command {
            error: "no config options available".to_string(),
        })?;
        sink.emit(
            "session-update",
            json!({
                "sessionId": session_id,
                "update": { "sessionUpdate": "config_option_update", "configOptions": options },
            }),
        );
        Ok(options)
    }

    /// Send a `Config` frame to the session's Worker (the `send_config` relay —
    /// the `set_config_option` model / thinking changes). A `WorkerError` (the
    /// Worker died / the pipe closed) maps to the "config change could not be
    /// applied" error (finding 12 — a failed send leaves the mirror untouched).
    fn send_config_to(
        &self,
        wm: &WorkerManager,
        session_id: &str,
        model: Option<&Model>,
        thinking: Option<&str>,
        trusted: Option<bool>,
    ) -> Result<(), SessionError> {
        let Some(handle) = wm.handle_for(session_id) else {
            return Err(SessionError::UnknownSession {
                id: session_id.to_string(),
            });
        };
        handle
            .send_config(model, thinking, trusted)
            .map_err(|e| SessionError::Command {
                error: format!("the session's Worker is not running; the config change could not be applied: {e}"),
            })
    }

    /// Push a freshly-discovered `Model` to every LIVE session running it (#85).
    ///
    /// Called after a provider refresh (`list_models(force_refresh)`), because
    /// the context window is copied into the `AgentLoop` at spawn and nothing
    /// else re-reads discovery for a running session. Without this a corrected
    /// window reaches only NEW sessions: the live bar keeps painting the stale
    /// one, and — because the loop's window is also the compaction threshold's
    /// input (ADR 0028's "one number, two consumers") — the session silently
    /// over-compacts at the stale window's percentage.
    ///
    /// Scoping is per MATCHED SESSION, not per provider: a session is pushed the
    /// model only when its current model is the one that changed (same key, and
    /// at least one metadata field differing). That is what keeps this from
    /// being a spurious `set_model` per session per refresh — `set_model`
    /// rebuilds the `Compactor`, re-estimates, emits a `context_usage_update`
    /// AND writes the `sessions` row, so firing it on a no-op refresh would be
    /// N frames and N DB writes for nothing.
    ///
    /// Dispatch goes through the existing `Config { model }` frame → the Worker's
    /// `ControlCmd::SetModel` → `AgentLoop::set_model`, which already does the
    /// whole right thing (rebuild the `Compactor`, re-estimate, emit, persist) and
    /// is pinned by `agent::harness::loop::tests::context_usage`'s
    /// `set_model` test — this method only supplies the trigger.
    ///
    /// Best-effort per session: a dead / closing Worker is skipped, never an
    /// error (a refresh must not fail because one session is mid-teardown).
    /// Returns the number of sessions actually pushed.
    pub async fn refresh_live_models(&self, refreshed: &[Model]) -> usize {
        let Some(wm) = self.worker_manager.get().cloned() else {
            return 0;
        };
        // The candidates: each live session's CURRENT model (the `config_state`
        // mirror — the same source `set_config_option` re-synthesizes from), and
        // whether the refresh moved it. Collected BEFORE any send so the
        // `config_state` lock is never held across one.
        let pushes: Vec<(String, Model)> = {
            let config_state = self.config_state.lock().unwrap_or_else(|p| p.into_inner());
            config_state
                .iter()
                .filter_map(|(session_id, state)| {
                    let fresh = refreshed
                        .iter()
                        .find(|m| m.provider == state.model.provider && m.id == state.model.id)?;
                    // The metadata that matters for the bar and the threshold —
                    // an unchanged window must not produce a frame.
                    (fresh.context_window != state.model.context_window).then(|| {
                        // Keep the session's OWN fields where the refresh is not
                        // the authority (an empty `api_key` / `base_url` on a
                        // discovery-derived model must not wipe a configured one).
                        let mut next = state.model.clone();
                        next.context_window = fresh.context_window;
                        next.supports_thinking = fresh.supports_thinking;
                        next.thinking_levels = fresh.thinking_levels.clone();
                        (session_id.clone(), next)
                    })
                })
                .collect()
        };
        let mut pushed = 0;
        for (session_id, model) in pushes {
            let Some(handle) = wm.handle_for(&session_id) else {
                continue;
            };
            if handle.send_config(Some(&model), None, None).is_ok() {
                // Mirror ONLY on a delivered frame (finding 12's rule — a failed
                // send means the loop never applies it).
                self.update_config_state(&session_id, |s| s.model = model.clone());
                pushed += 1;
            }
        }
        pushed
    }

    /// Update the session's `NativeConfigState` mirror (the `set_config_option`
    /// re-synthesizer source) in place.
    fn update_config_state(&self, session_id: &str, f: impl Fn(&mut NativeConfigState)) {
        let mut config_state = self.config_state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(state) = config_state.get_mut(session_id) {
            f(state);
        }
    }

    /// Deliver the user's answer to a pending permission request.
    ///
    /// Looks up the oneshot sender by the compound key
    /// `"{session_id}/{request_id}"` and sends the outcome through it. If the
    /// entry is gone (the session closed, or the prompt already resolved), this
    /// is a silent no-op. Returns `true` when an entry was resolved (the caller
    /// can then route a miss to the subagent manager).
    /// Deliver the user's answer to a pending permission request.
    ///
    /// The `pending_permissions` map lives in the WORKER now (the main-session
    /// `SessionManager` ownership is gone — ADR 0025): this relays the `outcome`
    /// to the session's Worker (`send_permission_response` — the Worker's
    /// `PermissionResponse` handler resolves its `pending_permissions` oneshot,
    /// or no-ops if the id is unknown). ADDED (Task 1 moved the `trust-space`
    /// write out of the gate): when the outcome is `Selected { option_id:
    /// "trust-space" }`, the Supervisor applies the `spaces` write (it owns the
    /// `spaces` table — the persistence half; the Worker's `StaticTrustSource`
    /// flip is the live-lookup half). Marks the request id as ANSWERED (the
    /// pending-modal cleanup — the `interactive-request-close` diff).
    pub async fn respond_permission(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: permission::PermissionOutcome,
    ) -> Result<bool, SessionError> {
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        // The `cwd` (the `trust-space` write) + the "answered" mark (the
        // pending-modal cleanup — the `interactive-request-close` diff).
        let cwd = {
            let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
            live.get(session_id).map(|l| l.cwd.clone())
        };
        let Some(handle) = wm.handle_for(session_id) else {
            // No live Worker for this session (a main session that was never
            // started, or already closed) — the caller routes a miss to the
            // subagent manager (the subagent's own `pending_*` maps, Task 5).
            return Ok(false);
        };
        match handle.send_permission_response(request_id, &outcome) {
            Ok(()) => {
                // (Task 1) The `trust-space` outcome persists the `spaces` write
                // (the Supervisor owns the `spaces` table — the existing
                // `set_space_trusted` `Db` method). The Worker's `StaticTrustSource`
                // flip (Task 2's `PermissionResponse` handler) is the live-lookup
                // half; this is the persistence half.
                //
                // The `..` this pattern used to carry is GONE (Task 4): the
                // outcome's `value` field is now READ — the `allow-directory`
                // rule write rides it. The trust-space arm below is verbatim
                // (its body and doc unchanged; only the shared destructure lost
                // the `..`).
                if let permission::PermissionOutcome::Selected { option_id, value } = &outcome {
                    if option_id == "trust-space" {
                        if let (Some(db), Some(cwd)) = (&self.driver.db, cwd) {
                            let _ = db.set_space_trusted(&cwd.display().to_string(), true);
                        }
                    }
                    // (Task 4) The `allow-directory` outcome persists ONE `allow`
                    // rule to `settings.json` — the rules store (ADR 0025's
                    // ownership split: the gate asks, the relay persists, because
                    // the Worker has no `config_dir`). `value` is the option's
                    // `path` echoed back verbatim by the frontend; a BLANK path
                    // (the gate's placeholder) persists NOTHING. A SEPARATE `if`,
                    // so neither arm's body can touch the other's.
                    if option_id == "allow-directory" {
                        self.persist_allow_directory_rule(value.as_deref());
                    }
                }
                // Mark the request id as ANSWERED (the pending-modal cleanup — a
                // session ending with an open prompt must NOT leave a stuck modal).
                if let Some(live) = self
                    .live
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get_mut(session_id)
                {
                    live.pending_modal_ids
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(request_id);
                }
                // (ADR 0055 review) The child-side twin: the answer clears the
                // child's OWN outstanding-gate record, so `finish_subagent` does
                // not retract a card the user already answered. A main session has
                // no `drives` entry — a no-op there.
                wm.note_gate_answered(session_id, request_id);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    /// (Task 4) Persist an `allow-directory` answer as EXACTLY ONE `allow`
    /// rule in `settings.json` (the rule store — ADR 0025: the Worker has no
    /// `config_dir`, so the Supervisor relays the write exactly as the
    /// `trust-space` db write does; the gate itself never persists).
    ///
    /// Directives, all pinned by `session_tests`:
    /// - `ReadWrite`, so the rule governs both the write that prompted AND the
    ///   reads / greps into the same dir — one "always allow" answers all five
    ///   path tools (`ReadWrite::covers` is all-direction).
    /// - Appended at the END of the file's `rules` list, which holds ONLY user
    ///   rules (`default_rules()` is runtime-only and never serialized). The
    ///   RUNTIME concat — `default_rules()` FIRST, then these user rules — is
    ///   what makes an appended allow beat a default `deny` on an exact tie:
    ///   that half lives at the harness concat site, and the tie itself is
    ///   pinned by `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`
    ///   in `agent/policy.rs`. Concatenate the other way round and every rule
    ///   written here silently no-ops at the gate.
    /// - A repeat click on the same directory writes nothing (dedupe by
    ///   path + direction + decision — see `config::append_rule`). The compare
    ///   is on the PERSISTED spelling verbatim: `~` and absolute spellings of
    ///   one dir are two rules, because matching canonicalizes at match time.
    /// - A `None` or ALL-WHITESPACE path writes nothing (the gate's `""`
    ///   placeholder until it computes the real nearest-existing ancestor). A
    ///   path that trims to something real is persisted with its ORIGINAL
    ///   spelling — the trim tests blankness ONLY.
    /// - `cwd` / the `Db` are NOT touched: the child path (the `drives`
    ///   fallback) has no `live` entry, so the path from `value` is the only
    ///   input — and it is enough. **Child-safety guarantee (checkable): this
    ///   method reads NO `self.live`, NO `self.driver` and NO `db` —
    ///   `config_dir` is a plain non-`Option` field, so it cannot drift. Any
    ///   future edit that introduces one of those reads into this method is
    ///   VISIBLY breaking against this doc.**
    /// - Best-effort: a write failure is logged and does NOT fail the answer
    ///   (the `trust-space` arm's `let _ =` discipline).
    fn persist_allow_directory_rule(&self, value: Option<&str>) {
        use crate::agent::policy::{AccessRule, RuleDecision, RuleDirection};

        let Some(raw) = value else { return };
        if raw.trim().is_empty() {
            return;
        }
        let path = raw.to_string();
        if let Err(e) = crate::config::load_mutate_write(&self.config_dir, |s| {
            crate::config::append_rule(
                &mut s.file_policy.rules,
                AccessRule {
                    path,
                    direction: RuleDirection::ReadWrite,
                    decision: RuleDecision::Allow,
                },
            )
        }) {
            eprintln!("allow-directory: rule save failed: {e}");
        }
    }

    /// Deliver the user's answer to a pending interactive request.
    ///
    /// The `pending_bridge` / `pending_sudo` maps live in the WORKER now (the
    /// main-session `SessionManager` ownership is gone — ADR 0025): this relays
    /// the `result` `Value` verbatim to the session's Worker (`send_interactive_response`
    /// — the Worker's `InteractiveResponse` handler resolves its
    /// `pending_bridge` / `pending_sudo` oneshot, or no-ops if the id is unknown).
    /// Marks the request id as ANSWERED (the pending-modal cleanup).
    pub async fn respond_interactive_request(
        &self,
        session_id: &str,
        request_id: &str,
        result: serde_json::Value,
    ) -> Result<bool, SessionError> {
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let Some(handle) = wm.handle_for(session_id) else {
            // No live Worker for this session — the caller routes a miss to the
            // subagent manager (the subagent's own `pending_*` maps, Task 5).
            return Ok(false);
        };
        match handle.send_interactive_response(request_id, &result) {
            Ok(()) => {
                // Mark the request id as ANSWERED (the pending-modal cleanup).
                if let Some(live) = self
                    .live
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get_mut(session_id)
                {
                    live.pending_modal_ids
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(request_id);
                }
                // (ADR 0055 review) The child-side twin — THIS is the relay that
                // answers a child's sudo sub-prompt, whose card the Client filed
                // under the DERIVED id (`"{tool_call_id}:confirm"`): the exact id
                // `note_liveness_gate` recorded, so the removal matches.
                wm.note_gate_answered(session_id, request_id);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    /// Close a live session.
    ///
    /// Records the `User` close kind (first-set-wins) + marks the in-flight turn
    /// a cancel, then `detach`es the Worker (the `WorkerManager` removes the
    /// `workers` entry + spawns the background reap — the graceful `close` +
    /// grace + `kill`). The Worker's clean exit (`Exited`) triggers the router's
    /// EXPECTED-exit handling (the `session-closed` emit + the `pending_turn`
    /// `Cancelled` resolution + the pending-modal cleanup + the live-bookkeeping
    /// removal). A `detach` miss (the session is already gone) is a no-op.
    pub async fn close_session(&self, session_id: &str) -> Result<(), SessionError> {
        let wm = self.worker_manager.get().cloned().ok_or_else(|| {
            SessionError::Io("the session's WorkerManager is not attached".to_string())
        })?;
        let (close_kind, cancel_requested) = {
            let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
            let live = live
                .get(session_id)
                .ok_or_else(|| SessionError::UnknownSession {
                    id: session_id.to_string(),
                })?;
            (live.close_kind.clone(), live.cancel_requested.clone())
        };
        // A close KILLS an in-flight turn: mark it a cancel BEFORE the `detach`
        // (the router's `agent_settled` arm may win the race over the `Exited`
        // teardown — the `cancel_requested` flag maps that settle to `Cancelled`,
        // not `EndTurn`, for a turn that was killed, not ended; the `Exited`
        // teardown arm sends `Cancelled` too, so the outcome is `Cancelled` either
        // way, not timing-dependent).
        *cancel_requested.lock().unwrap_or_else(|p| p.into_inner()) = true;
        // Decide the kind BEFORE starting the close. First-set-wins: a kind
        // already present means the close is in progress (another setter won the
        // race) or the reason is already decided.
        if let Ok(mut kind) = close_kind.lock() {
            if kind.is_none() {
                *kind = Some(CloseKind::User);
            }
        }
        // `detach` the Worker (the `WorkerManager` removes the `workers` entry +
        // spawns the background reap — the `Exited` is EXPECTED: NO `on_crash`;
        // the router's EXPECTED-exit handling does the `session-closed` cleanup).
        // A `detach` miss (the session was already torn down) is a no-op — the
        // `UnknownSession` above guards the `live` entry, so a miss here means the
        // Worker was already reaped (idempotent close).
        let _ = wm.detach(session_id);
        Ok(())
    }
}

/// Resolve a composed model key (`"<provider>/<id>"` — the catalog / config
/// option key form) to a `Model` (the first `/` split — model ids themselves
/// contain `/`). `None` when the key is malformed or unknown. `pub(crate)` so
/// the `dispatch_native` driver resolves a `launch.model` override (the
/// `:<level>` suffix is stripped by the caller BEFORE calling this — this
/// function does not split it).
pub(crate) fn resolve_composed_model(catalog: &ModelCatalog, key: &str) -> Option<Model> {
    let key = ModelKey::parse(key)?;
    catalog
        .models
        .iter()
        .find(|m| m.provider == key.provider && m.id == key.id)
        .cloned()
}

/// The remembered thinking level for a model (ADR 0015): the map entry,
/// `Some` only when the model's `thinking_levels` is non-empty AND
/// contains the entry (a stale entry — the provider changed its levels —
/// is ignored; a model with no advertised levels gets nothing — the
/// early return is NOT the `supports_thinking_level` soft-pass).
fn remembered_thinking_level(levels: &HashMap<String, String>, model: &Model) -> Option<String> {
    if model.thinking_levels.is_empty() {
        return None;
    }
    levels
        .get(&ModelKey::from(model).to_string())
        .filter(|l| model.supports_thinking_level(l))
        .cloned()
}

/// Resolve a native session's model (the `Settings.default_model` composed
/// key — a fresh `load_settings` read → the catalog; the catalog's
/// `default_model` → the selectable set). Each rung
/// is tried IN ORDER: an UNRESOLVABLE key at any rung falls through to the
/// NEXT rung (only when both rungs are absent/unresolvable does it fall to
/// the set) — a stale configured default degrades rather than a hard error.
fn resolve_native_model(
    catalog: &ModelCatalog,
    settings_default: &Option<String>,
) -> Result<Model, SessionError> {
    for key in [
        settings_default.as_deref(),
        catalog.default_model.as_deref(),
    ]
    .iter()
    .flatten()
    {
        if let Some(model) = resolve_composed_model(catalog, key) {
            return Ok(model);
        }
    }
    catalog
        .selectable()
        .first()
        .copied()
        .cloned()
        .ok_or_else(|| SessionError::Command {
            error: "no models available for the native session".to_string(),
        })
}

/// The capability envelope for a NATIVE session (the item-1 shape minus the
/// pi keys — there is NO `piSessionFile`: resume is from the
/// `native_messages` table, so `loadSession` is `true` (the frontend's
/// Resume button); `image` is `true` (the native `Prompt` carries image
/// blocks — the provider's `to_wire` sends them as `image_url` parts;
/// `audio` / `embeddedContext` stay fail-closed `false`).
fn native_capabilities(model: &Model, thinking_level: Option<&str>) -> Value {
    let mut caps = json!({
        "native": true,
        "model": ModelKey::from(model).to_string(),
        "loadSession": true,
        "promptCapabilities": { "image": true, "audio": false, "embeddedContext": false },
    });
    if let Some(level) = thinking_level {
        caps["thinkingLevel"] = Value::String(level.to_string());
    }
    caps
}

/// Synthesize a NATIVE session's config options (the model / thinking-level
/// selectors) from the `ModelCatalog` (the existing `synthesize_config_options`
/// shape — the frontend is unchanged; a new `get_models` command driving a
/// native-only picker would be a UI change, so there is none): model options
/// are the `selectable()` ids (`"<provider>/<id>"`); the thinking level
/// is the current model's `thinking_levels` (absent → no selector).
fn synthesize_catalog_config_options(
    catalog: &ModelCatalog,
    current: &Model,
    thinking_level: Option<&str>,
) -> Option<Vec<Value>> {
    let mut out: Vec<Value> = Vec::new();
    let options: Vec<Value> = catalog
        .selectable()
        .iter()
        .map(|m| {
            json!({
                "value": ModelKey::from(*m).to_string(),
                "name": m.id.clone(),
            })
        })
        .collect();
    out.push(json!({
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": ModelKey::from(current).to_string(),
        "options": options,
    }));
    if !current.thinking_levels.is_empty() {
        let options: Vec<Value> = current
            .thinking_levels
            .iter()
            .map(|s| {
                // The display name is the capitalized level
                // (`"medium"` → `"Medium"`).
                let mut name = s.clone();
                if let Some(c0) = name.chars().next() {
                    name = format!("{}{}", c0.to_uppercase(), &name[c0.len_utf8()..]);
                }
                json!({ "value": s, "name": name })
            })
            .collect();
        out.push(json!({
            "id": "thought_level",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": thinking_level.unwrap_or_default(),
            "options": options,
        }));
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::agent::worker::client::{WorkerError, WorkerHandle};
    use crate::agent::worker::manager::WorkerFactory;
    use crate::storage::Db;
    use crate::test_support::ScratchDir;
    use std::path::Path;
    use tokio::sync::mpsc;

    #[test]
    fn mint_session_id_format() {
        let sid = mint_session_id();
        assert!(
            sid.starts_with("arch_"),
            "session id must start with arch_, got {sid}"
        );
        let suffix = &sid["arch_".len()..];
        let parsed = uuid::Uuid::parse_str(suffix).expect("suffix must be valid UUID");
        assert_eq!(parsed.get_version_num(), 4, "suffix must be UUID v4");
    }

    /// A recording `EventSink` (`{"event", "payload"}` per emit). The
    /// sender is `pub(crate)` so a CHILD module's tests (`session::naming`)
    /// can construct one and assert on what it received.
    pub struct TestSink {
        pub(crate) tx: mpsc::UnboundedSender<Value>,
    }

    impl EventSink for TestSink {
        fn emit(&self, event: &str, payload: Value) {
            let _ = self
                .tx
                .send(serde_json::json!({ "event": event, "payload": payload }));
        }
    }

    /// A scratch config dir for ONE test, OWNED (#96 task 04): it is removed
    /// when the caller's binding drops, so a fixture cannot forget — the shape
    /// that leaked 32 dirs per green run (31 minting sites, 18 cleanups).
    ///
    /// NAME CHANGE, recorded deliberately: this used to mint a BARE UUID with
    /// no prefix at all, which #96's census could not attribute to ANY
    /// producer. `ScratchDir` names `{prefix}{tag}-{uuid}`, so a prefix had to
    /// be added — `session-cfg-` makes the issue's largest bucket readable as
    /// well as empty. `create_dir` → `create_dir_all` is `ScratchDir::in_dir`'s
    /// own behaviour and is unobservable here (a UUID-suffixed name never
    /// pre-exists).
    pub fn temp_config_dir() -> ScratchDir {
        ScratchDir::in_env_temp("session-cfg-", "cfg")
    }

    /// A `Db` in the temp dir (shared with `session::naming`'s tests).
    pub(crate) fn open_db(dir: &Path) -> std::sync::Arc<Db> {
        std::sync::Arc::new(Db::open(&dir.join("archimedes.db")).expect("db should open"))
    }

    /// (ADR 0016) The NATIVE resume carries the stored `archived` flag:
    /// a fresh native start is `archived: false`; after
    /// `set_session_archived`, the resumed `SessionInfo` reports the stored
    /// flag and the resume's `record_session` re-record did NOT clear it.
    #[tokio::test]
    async fn native_resume_carries_the_archived_flag() {
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);

        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");
        assert!(!info.archived, "a fresh native start is never archived");
        db.set_session_archived(&info.session_id, true)
            .expect("set_session_archived should succeed");

        let resumed = manager
            .resume_session(&info.session_id, dir.to_path_buf(), &sink)
            .await
            .expect("the native resume succeeded");
        assert_eq!(resumed.session_id, info.session_id);
        assert!(
            resumed.archived,
            "the native resume carries the stored archived flag"
        );
        let row = db
            .session(&info.session_id)
            .expect("session should work")
            .expect("the row exists");
        assert!(
            row.archived,
            "the resume's re-record did not clear the stored flag"
        );

        let _ = manager.close_session(&info.session_id).await;
    }

    /// The title round-trip over IPC: a FRESH start carries `None` (nothing
    /// has named it yet), and a RESUME carries the stored title (the naming
    /// pass wrote it on an earlier turn — the resumed session's label must
    /// survive the close/resume round-trip) while the resume's
    /// `record_session` re-record did NOT clear it.
    #[tokio::test]
    async fn native_resume_carries_the_stored_title() {
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);

        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");
        assert_eq!(
            info.title, None,
            "a fresh session has no title until the naming pass writes one"
        );
        db.set_session_title(&info.session_id, "Fix the login redirect")
            .expect("set_session_title should succeed");

        let resumed = manager
            .resume_session(&info.session_id, dir.to_path_buf(), &sink)
            .await
            .expect("the native resume succeeded");
        assert_eq!(resumed.session_id, info.session_id);
        assert_eq!(
            resumed.title.as_deref(),
            Some("Fix the login redirect"),
            "the native resume carries the stored title"
        );
        let row = db
            .session(&info.session_id)
            .expect("session should work")
            .expect("the row exists");
        assert_eq!(
            row.title.as_deref(),
            Some("Fix the login redirect"),
            "the resume's re-record did not clear the stored title"
        );

        let _ = manager.close_session(&info.session_id).await;
    }

    /// (ADR 0016) `SessionInfo` round-trips the `archived` flag (a
    /// single-word key — the `camelCase` rename leaves it as `archived`).
    #[test]
    fn session_info_round_trips_the_archived_flag_camel_case() {
        let info = SessionInfo {
            session_id: "s1".to_string(),
            cwd: PathBuf::from("/tmp/proj"),
            capabilities: serde_json::json!({ "loadSession": true }),
            config_options: None,
            archived: true,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"archived\":true"), "got: {json}");
        let back: SessionInfo = serde_json::from_str(&json).unwrap();
        assert!(back.archived);
    }

    /// (#105 / D5 / ADR 0082) The `SessionInfo` SERDE boundary for the cost
    /// field: it crosses as `costUsd` (the struct's `camelCase` rename), and
    /// `None` vs `Some(0.0)` stay two different payloads — `null` and `0`.
    /// The renderer prints nothing for the first and `$0.00` for the second,
    /// so a projection or a deserialisation that collapses them is the exact
    /// phantom-`$0.00` defect; this is the same distinction
    /// `a_session_that_never_reported_cost_has_no_cost_field` pins through
    /// the real IPC surface, asserted here at the type so a break in serde
    /// config (not just in the projection) is attributable.
    #[test]
    fn session_info_serialises_the_cost_as_cost_usd_and_keeps_zero_distinct() {
        let base = SessionInfo {
            session_id: "s1".to_string(),
            cwd: PathBuf::from("/tmp/proj"),
            capabilities: serde_json::json!({ "loadSession": true }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            is_subagent: false,
            cost_usd: None,
        };

        let absent = serde_json::to_value(&base).unwrap();
        assert!(
            absent.get("costUsd").is_some(),
            "the key is the camelCase `costUsd`, got: {absent}"
        );
        assert!(
            absent["costUsd"].is_null(),
            "`None` serialises as null — never as a number"
        );

        let zero = SessionInfo {
            cost_usd: Some(0.0),
            ..base.clone()
        };
        let zero_json = serde_json::to_value(&zero).unwrap();
        assert_eq!(
            zero_json["costUsd"],
            serde_json::json!(0.0),
            "a REAL zero serialises as 0 — the two are different payloads"
        );
        assert_ne!(
            absent["costUsd"], zero_json["costUsd"],
            "the wire must keep 'never reported' and 'reported zero' apart"
        );

        // `#[serde(default)]`: a payload written before the field existed
        // still deserialises, as `None`.
        let pre_feature: SessionInfo = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "cwd": "/tmp/proj",
            "capabilities": { "loadSession": true },
            "configOptions": null,
            "archived": false,
            "contextUsage": null,
        }))
        .expect("a pre-cost SessionInfo deserialises");
        assert_eq!(
            pre_feature.cost_usd, None,
            "an absent key reads back as None, not 0"
        );
    }

    /// Write a `settings.json` with the given `defaultModel` (the
    /// camelCase wire shape — `None` = the key present-but-null, which
    /// parses to `default_model: None`).
    fn write_settings_default_model(dir: &Path, default_model: Option<&str>) {
        let settings = serde_json::json!({ "defaultModel": default_model });
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();
    }

    // ── Native-backend tests (the in-process `AgentLoop` — a NATIVE
    // registry entry + a mock `provider_factory` seam; the production
    // default dispatches on `Model.api` (`build_provider`, ADR 0024)) ──

    /// The native test catalog (a single `fake/m1` OpenAI-compatible
    /// model — `set_config_option` + `resolve_native_model` resolve it
    /// from the composed key).
    fn native_test_catalog() -> ModelCatalog {
        ModelCatalog {
            models: vec![Model {
                id: "m1".to_string(),
                provider: "fake".to_string(),
                base_url: "http://fake".to_string(),
                api_key: "k".to_string(),
                context_window: 128000,
                cost_per_mtok_in: 0.0,
                cost_per_mtok_out: 0.0,
                supports_tools: true,
                supports_thinking: false,
                thinking_levels: Vec::new(),
                api: Some("openai-completions".to_string()),
            }],
            default_model: Some("fake/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        }
    }

    /// The `fake_worker` fixture factory (the `WorkerFactory` seam —
    /// `cargo test` builds the bin targets; the fixture answers the
    /// `ready` handshake + the `start` / `prompt` frames; the
    /// `AgentLoop` runs in the fixture process, NOT in-process —
    /// ADR 0025).
    struct FixtureFactory;

    impl WorkerFactory for FixtureFactory {
        fn spawn(&self) -> Result<WorkerHandle, WorkerError> {
            WorkerHandle::spawn(&fixture_path())
        }
    }

    /// The `fake_worker` fixture path (the `CARGO_MANIFEST_DIR`/
    /// `target/debug` convention — `cargo test` builds the bin targets).
    fn fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/debug/fake_worker"
        ))
    }

    /// Build the Worker-mediated manager (the ADR 0025 late-wire — the
    /// `WorkerManager`'s `on_event` / `on_crash` callbacks point at the
    /// `SessionManager`'s router / crash handler; `attach_worker_manager`
    /// hands the `WorkerManager` to the `SessionManager` after both are
    /// built). Returns the manager + the `WorkerManager` + the `Db`.
    fn build_worker_manager(
        dir: &Path,
        catalog: ModelCatalog,
        sink: &Arc<dyn EventSink>,
    ) -> (Arc<SessionManager>, Arc<WorkerManager>, Arc<Db>) {
        let db = open_db(dir);
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_catalog(catalog);
        manager.set_sink(sink.clone());
        let manager = Arc::new(manager);
        let wm = {
            let m = manager.clone();
            let m2 = manager.clone();
            Arc::new(WorkerManager::new(
                Arc::new(FixtureFactory),
                Arc::new(move |s, c, p| m.handle_crash(&s, c, p)),
                Arc::new(move |s, b, e| m2.route_event(&s, b, e)),
                Arc::new(|_s| None),
            ))
        };
        manager.attach_worker_manager(wm.clone());
        (manager, wm, db)
    }

    /// Stamp a seeded crash log's mtime `secs_ago` seconds in the past, so
    /// a test can say which of two logs is the NEWER one without racing the
    /// filesystem's mtime granularity.
    fn stamp_crash_log(path: &Path, secs_ago: u64) {
        let mtime = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("the seeded crash log is re-openable")
            .set_modified(mtime)
            .expect("the seeded crash log's mtime is settable");
    }

    /// The two halves of crash-log attribution, on a REAL child pid:
    ///
    /// **(a) identity** — the `stalled` registry's `crash_log` is the log
    /// named for the pid that just died, NOT the newest log in the dir.
    /// A second, NEWER, pid-less `crash-7-worker.log` is seeded beside it: a
    /// recency rule names that foreign file, so this half is the identity
    /// guarantee itself.
    ///
    /// **(b) frozen equality** — the `session-stalled` payload's
    /// `crashLog` is THE SAME path the registry froze. On its own this half
    /// says nothing about WHICH file wins (a lookup re-run with the same pid
    /// over an unchanged dir returns the same path), so do not expect a
    /// today-red from it — it is the pin against re-globbing at the emit: a
    /// second lookup there is exactly what re-opens the window in which
    /// another Worker's crash moves the banner's link out from under the
    /// registry. Seed-newer-besides-pid-named turns the cheapest regression
    /// (a re-glob that forgets the pid) into a failure here.
    #[tokio::test]
    async fn the_stalled_registry_and_the_stalled_event_agree_on_the_pid_named_log() {
        let dir = temp_config_dir();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);

        // A REAL child, so the pid is one the Supervisor really would hold.
        let handle = WorkerHandle::spawn(&fixture_path())
            .expect("the fixture binary exists (cargo test built it)");
        let pid = handle
            .pid()
            .expect("a live child reports its spawn-time pid");
        // Let it go GRACEFULLY: `kill_on_drop` is false for this child, so a
        // dropped handle leaves the process alive until its stdin EOF, and
        // the `worker_smoke` EOF/exit pins are sensitive to a stray child.
        handle.send_close().expect("the close frame encodes");
        handle.exited().await;

        // The crash-log dir — the late-wire seam (`setup_dirs_with_factory`
        // wires the app data dir here in production).
        let crash_dir = temp_config_dir();
        manager.set_crash_log_dir(crash_dir.to_path_buf());

        // The crashed Worker's own log, and a NEWER one belonging to nobody
        // we care about.
        let mine = crash_dir.join(format!("crash-1000-worker-{pid}.log"));
        std::fs::write(&mine, "mine").expect("the pid-named log is seedable");
        stamp_crash_log(&mine, 120);
        let foreign = crash_dir.join("crash-7-worker.log");
        std::fs::write(&foreign, "foreign").expect("the foreign log is seedable");
        stamp_crash_log(&foreign, 0);

        // `handle_crash` has no early return — it always marks the session
        // stalled and emits — and its `live`-map helpers no-op for an id
        // that was never started, so no Worker needs to be running here.
        let id = "arch_pid_attributed";
        manager.handle_crash(id, Some(1), Some(pid));

        // (a) Identity: the registry holds the pid-named log.
        let frozen = manager
            .stalled_info(id)
            .expect("the crash marks the session stalled")
            .crash_log;
        assert_eq!(
            frozen.as_deref(),
            Some(mine.as_path()),
            "the banner names the log belonging to pid {pid}, not the newer foreign one \
             (`{}`)",
            foreign.display()
        );

        // (b) Frozen equality: the PUSH names exactly what the registry
        // froze — one lookup per crash, never a re-glob.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let payload = loop {
            let got = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .expect("the `session-stalled` event is emitted")
                .expect("the sink is live");
            if got["event"] == "session-stalled" {
                break got["payload"].clone();
            }
        };
        assert_eq!(
            payload["crashLog"],
            serde_json::Value::String(mine.display().to_string()),
            "the `session-stalled` payload's `crashLog` is the path the registry froze \
             (a second glob would name the newer `{}`)",
            foreign.display()
        );
    }

    /// Start a native session with the given catalog (the Worker-mediated
    /// path — the `fake_worker` fixture answers the `ready` handshake;
    /// the Supervisor-side assertions run against the coordinator state).
    async fn start_native_session_with_catalog(
        dir: &Path,
        sink: &Arc<dyn EventSink>,
        catalog: ModelCatalog,
    ) -> (Arc<SessionManager>, SessionInfo) {
        let (manager, _wm, _db) = build_worker_manager(dir, catalog, sink);
        let info = manager
            .start_session(dir.to_path_buf(), sink)
            .await
            .expect("the native session started");
        (manager, info)
    }

    /// Start a native session (the `native_test_catalog` — a single
    /// `fake/m1` model).
    async fn start_native_session(
        dir: &Path,
        sink: &Arc<dyn EventSink>,
    ) -> (Arc<SessionManager>, SessionInfo) {
        start_native_session_with_catalog(dir, sink, native_test_catalog()).await
    }

    /// A full `Model` literal for the `resolve_native_model` chain test
    /// (`base_url` EMPTY so `refresh_model_metadata` is a no-op — no
    /// network; `openai-completions` so the model is selectable).
    fn chain_test_model(provider: &str, id: &str) -> Model {
        Model {
            id: id.to_string(),
            provider: provider.to_string(),
            base_url: String::new(),
            api_key: "k".to_string(),
            context_window: 128000,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: false,
            thinking_levels: Vec::new(),
            api: Some("openai-completions".to_string()),
        }
    }

    /// The NATIVE capability envelope advertises `image: true` (the native
    /// `Prompt` carries image blocks — the frontend's `imageCapable` gate
    /// opens the paste / attach path; `false` was the v1 text-only shape).
    #[test]
    fn native_capabilities_advertises_image() {
        let caps = native_capabilities(&chain_test_model("fake", "m1"), None);
        assert_eq!(caps["native"], true);
        assert_eq!(caps["loadSession"], true);
        assert_eq!(
            caps["promptCapabilities"],
            json!({ "image": true, "audio": false, "embeddedContext": false })
        );
    }

    /// Write a `settings.json` with arbitrary JSON (the camelCase wire
    /// shape — absent keys parse to the defaults).
    pub(crate) fn write_settings_json(dir: &Path, settings: serde_json::Value) {
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();
    }

    /// A `Model` with the given `thinking_levels` (`base_url` EMPTY so
    /// `refresh_model_metadata` is a no-op — no network).
    pub(crate) fn level_test_model(provider: &str, id: &str, levels: &[&str]) -> Model {
        Model {
            id: id.to_string(),
            provider: provider.to_string(),
            base_url: String::new(),
            api_key: "k".to_string(),
            context_window: 128000,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: !levels.is_empty(),
            thinking_levels: levels.iter().map(|s| s.to_string()).collect(),
            api: Some("openai-completions".to_string()),
        }
    }

    /// (ADR 0015) Native start: the remembered level (VALIDATED against the
    /// model's `thinking_levels`) wins over the harness's
    /// `default_thinking_level` seed.
    #[tokio::test]
    async fn a_native_session_starts_with_the_remembered_level_over_the_settings_default() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "medium", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({
                "defaultModel": null,
                "defaultThinkingLevel": "high",
                "defaultThinkingLevels": { "tama/m1": "xhigh" },
            }),
        );
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        assert_eq!(
            info.capabilities["thinkingLevel"], "xhigh",
            "the remembered (validated) level beats the settings default"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// A STALE remembered entry (not a member of the model's
    /// `thinking_levels` — the provider changed its levels) is IGNORED, AND
    /// the `Settings.default_thinking_level` rung is VALIDATED the same way
    /// (the Settings UI offers the UNION of all models' levels — a level one
    /// model advertises may not be a member of THIS model's set): a settings
    /// default that is NOT a member is DROPPED (the session starts with no
    /// thinking level — the model's own default).
    #[tokio::test]
    async fn a_stale_remembered_level_and_an_invalid_settings_default_start_with_no_level() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "medium", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({
                "defaultModel": null,
                "defaultThinkingLevel": "high",
                "defaultThinkingLevels": { "tama/m1": "ultra" },
            }),
        );
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        assert!(
            info.capabilities.get("thinkingLevel").is_none(),
            "the stale entry is ignored AND the settings default (not a member of the model's levels) is dropped — no thinking level, got {:?}",
            info.capabilities
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// The `Settings.default_thinking_level` rung APPLIES when it is a
    /// member of the model's `thinking_levels` (no remembered entry):
    /// the settings default is a validated rung, not a bypass.
    #[tokio::test]
    async fn a_settings_default_level_applies_when_it_is_a_member_of_the_model_levels() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "medium", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({
                "defaultModel": null,
                "defaultThinkingLevel": "xhigh",
            }),
        );
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        assert_eq!(
            info.capabilities["thinkingLevel"], "xhigh",
            "a settings default that IS a member of the model's levels applies"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (the stored rung's lenient rule, mirrored on the settings rung) A
    /// model that advertises NO `thinking_levels` applies the
    /// `Settings.default_thinking_level` AS-IS (no membership check — the
    /// pre-change behavior).
    #[tokio::test]
    async fn a_settings_default_level_applies_as_is_for_a_model_without_levels() {
        let catalog = ModelCatalog {
            models: vec![level_test_model("tama", "m1", &[])],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({
                "defaultModel": null,
                "defaultThinkingLevel": "high",
            }),
        );
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        assert_eq!(
            info.capabilities["thinkingLevel"], "high",
            "a model with no advertised levels applies the settings default as-is"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (ADR 0015) A model that advertises NO `thinking_levels` gets NO
    /// remembered level (the memory is only applied to a member of a
    /// NON-EMPTY level set): the `thinkingLevel` key is ABSENT (the model's
    /// own default — `None`).
    #[tokio::test]
    async fn a_remembered_level_is_ignored_for_a_model_without_levels() {
        let catalog = ModelCatalog {
            models: vec![level_test_model("tama", "m1", &[])],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({ "defaultThinkingLevels": { "tama/m1": "xhigh" } }),
        );
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        assert!(
            info.capabilities.get("thinkingLevel").is_none(),
            "a model with no advertised levels gets no remembered level, got {:?}",
            info.capabilities
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (ADR 0015) An EXPLICIT `thought_level` change (native) persists
    /// `memory[<the session's model key>] = level` to `settings.json`
    /// (best-effort — the change itself is applied regardless).
    #[tokio::test]
    async fn a_native_thought_level_change_remembers_the_level() {
        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, info) = start_native_session(&dir, &sink).await;
        let _ = manager
            .set_config_option(&info.session_id, "thought_level", "medium", &sink)
            .await
            .expect("the level change applies");
        let settings = load_settings(&dir);
        assert_eq!(
            settings.default_thinking_levels.get("fake/m1"),
            Some(&"medium".to_string()),
            "the explicit change writes the memory for the session's model"
        );
        // The file on disk is updated (a fresh read — not just the in-memory map).
        let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(on_disk["defaultThinkingLevels"]["fake/m1"], "medium");
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (review finding) An EMPTY `thought_level` value is rejected BEFORE
    /// the control channel is touched (an empty level would flow
    /// `reasoning_effort: Some("")` into the provider request body — some
    /// endpoints reject it): a `Command` error, the mirror is UNCHANGED,
    /// NO `config_option_update` is emitted (mirroring the model arm's
    /// rejection of an unresolvable key).
    #[tokio::test]
    async fn a_native_empty_thought_level_change_is_rejected() {
        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, info) = start_native_session(&dir, &sink).await;
        // Drain any startup events (the assertion below is about the
        // rejected change only).
        while rx.try_recv().is_ok() {}
        let err = manager
            .set_config_option(&info.session_id, "thought_level", "", &sink)
            .await
            .expect_err("an empty level must be rejected");
        assert!(
            matches!(
                err,
                SessionError::Command {
                    ref error
                } if error == "a thinking level must be non-empty"
            ),
            "the empty level is rejected with a Command error, got {err:?}"
        );
        // The mirror is UNCHANGED (a fresh session has no level — an
        // applied change would have mirrored `Some("")`). The mirror's home
        // moved from the `NativeHandle` to the `SessionManager`'s
        // `config_state` map (the `NativeHandle` is gone for main sessions).
        let state = {
            let config_state = manager
                .config_state
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            config_state
                .get(&info.session_id)
                .expect("the session is live")
                .clone()
        };
        assert_eq!(
            state.thinking_level.as_deref(),
            None,
            "the mirror must be untouched by a rejected change"
        );
        // NO `config_option_update` was emitted (a rejected change
        // re-synthesizes nothing).
        assert!(
            rx.try_recv().is_err(),
            "no event may be emitted for a rejected change"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (ADR 0015) A native model switch is a MINIMAL-SURPRISE reset: the
    /// current level is invalid for the NEW model (its `thinking_levels`
    /// are non-empty and don't contain it) → the level resets to the new
    /// model's remembered level (or `None`).
    #[tokio::test]
    async fn a_native_model_switch_resets_an_invalid_level_to_the_new_model_s_memory() {
        let catalog = ModelCatalog {
            models: vec![
                level_test_model("tama", "a", &["off", "high"]),
                level_test_model("tama", "b", &["off", "low", "medium", "xhigh"]),
            ],
            default_model: Some("tama/a".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({ "defaultThinkingLevels": { "tama/b": "xhigh" } }),
        );
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        // The current level (valid for `a` — also writes `a`'s memory).
        let _ = manager
            .set_config_option(&info.session_id, "thought_level", "high", &sink)
            .await
            .expect("the level change applies");
        // The switch: `"high"` is NOT a member of `b`'s levels → the reset
        // to `b`'s remembered level.
        let updated = manager
            .set_config_option(&info.session_id, "model", "tama/b", &sink)
            .await
            .expect("the model switch applies");
        let thought = updated
            .iter()
            .find(|o| o["id"] == "thought_level")
            .expect("a thought_level selector");
        assert_eq!(
            thought["currentValue"], "xhigh",
            "an invalid level resets to the new model's remembered level"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (ADR 0015) The flip side: a current level that IS a member of the
    /// new model's `thinking_levels` is KEPT across the switch (minimal
    /// surprise — no reset).
    #[tokio::test]
    async fn a_native_model_switch_keeps_a_valid_level() {
        let catalog = ModelCatalog {
            models: vec![
                level_test_model("tama", "a", &["off", "high"]),
                level_test_model("tama", "c", &["off", "high", "medium"]),
            ],
            default_model: Some("tama/a".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(&dir, serde_json::json!({}));
        let (manager, info) = start_native_session_with_catalog(&dir, &sink, catalog).await;
        let _ = manager
            .set_config_option(&info.session_id, "thought_level", "high", &sink)
            .await
            .expect("the level change applies");
        let updated = manager
            .set_config_option(&info.session_id, "model", "tama/c", &sink)
            .await
            .expect("the model switch applies");
        let thought = updated
            .iter()
            .find(|o| o["id"] == "thought_level")
            .expect("a thought_level selector");
        assert_eq!(
            thought["currentValue"], "high",
            "a valid level is kept across the switch"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (ADR 0015) Native resume: the remembered level (VALIDATED) wins over
    /// the STORED `thinkingLevel` (the start-of-session value — stale after
    /// a mid-session change), which wins over the harness seed.
    #[tokio::test]
    async fn a_resume_prefers_the_remembered_level_over_the_stale_stored_value() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "high", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        write_settings_json(
            &dir,
            serde_json::json!({ "defaultThinkingLevels": { "tama/m1": "xhigh" } }),
        );
        let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
        // The stored row: the start-of-session level (`"high"` — valid for
        // the model; a mid-session change to `xhigh` is only in the memory).
        db.record_session(&SessionInfo {
            session_id: "nat-resume-1".to_string(),
            cwd: dir.to_path_buf(),
            capabilities: json!({
                "native": true,
                "model": "tama/m1",
                "thinkingLevel": "high",
                "loadSession": true,
            }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .expect("record_session should succeed");
        let info = manager
            .resume_session("nat-resume-1", dir.to_path_buf(), &sink)
            .await
            .expect("the native resume works");
        assert_eq!(
            info.capabilities["thinkingLevel"], "xhigh",
            "memory wins over the stale stored value"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// `list_sessions` carries the stored session's `config_options`
    /// (synthesized from the stored `model` / `thinkingLevel` — the
    /// frontend's `SessionConfigSelect` renders them in the stored
    /// session's composer, disabled) and `context_usage` (persisted via
    /// `record_session_context_usage` — the frontend's store drops it on
    /// close, so the row is the source of truth for the stored session's
    /// context bar).
    #[tokio::test]
    async fn list_sessions_carries_the_stored_config_options_and_context_usage() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "high", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_catalog(catalog);
        // The stored row: the start-of-session `model` / `thinkingLevel`
        // (the `capabilities` envelope) + a persisted context usage.
        db.record_session(&SessionInfo {
            session_id: "nat-list-1".to_string(),
            cwd: dir.to_path_buf(),
            capabilities: json!({
                "native": true,
                "model": "tama/m1",
                "thinkingLevel": "high",
                "loadSession": true,
            }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .expect("record_session should succeed");
        db.record_session_context_usage("nat-list-1", 53_760, 128_000)
            .expect("record_session_context_usage should succeed");
        let rows = manager
            .list_sessions(true)
            .await
            .expect("list_sessions should work");
        assert_eq!(rows.len(), 1, "the stored row is listed");
        let row = &rows[0];
        // `config_options`: the model selector (current value = the stored
        // composed key) + the thinking-level selector (current value = the
        // stored level).
        let options = row
            .config_options
            .as_ref()
            .expect("config_options are synthesized for the stored session");
        let model = options
            .iter()
            .find(|o| o["id"] == "model")
            .expect("the model option");
        assert_eq!(model["currentValue"], "tama/m1");
        assert!(
            model["options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o["value"] == "tama/m1"),
            "the stored model is in the options list"
        );
        let thinking = options
            .iter()
            .find(|o| o["id"] == "thought_level")
            .expect("the thinking-level option");
        assert_eq!(thinking["currentValue"], "high");
        // `context_usage`: the persisted last-known usage.
        let usage = row
            .context_usage
            .as_ref()
            .expect("context_usage is carried from the row");
        assert_eq!(usage.used, 53_760);
        assert_eq!(usage.window, 128_000);
    }

    /// (#85) A stored session's `context_usage.window` is DERIVED from the model
    /// the row's `capabilities.model` resolves to, not replayed from the
    /// `context_usage_json` snapshot.
    ///
    /// The snapshot's `window` is a fact about the MODEL, frozen when the frame
    /// was written — so after a provider's metadata is corrected it is simply
    /// wrong, and it stays wrong for every closed session. `used` is a genuine
    /// measurement of that session and is replayed as-is.
    ///
    /// The fallback is load-bearing: a row whose model key no longer resolves
    /// (the provider was removed, the model renamed) keeps its snapshot, because
    /// the snapshot is then the only window anyone knows.
    #[tokio::test]
    async fn a_stored_sessions_context_window_follows_the_current_catalog() {
        let catalog = ModelCatalog {
            models: vec![level_test_model("tama", "m1", &[])],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_catalog(catalog);
        // The row ran `tama/m1` when the catalog said 128k, so that is the
        // snapshot written with the usage.
        db.record_session(&SessionInfo {
            session_id: "cu-derive-1".to_string(),
            cwd: dir.to_path_buf(),
            capabilities: json!({
                "native": true,
                "model": "tama/m1",
                "loadSession": true,
            }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .expect("record_session should succeed");
        db.record_session_context_usage("cu-derive-1", 53_760, 128_000)
            .expect("record_session_context_usage should succeed");
        // The provider's metadata is CORRECTED: the model is now 1M.
        manager.set_catalog(ModelCatalog {
            models: vec![Model {
                context_window: 1_000_000,
                ..level_test_model("tama", "m1", &[])
            }],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        });
        let rows = manager
            .list_sessions(true)
            .await
            .expect("list_sessions works");
        let usage = rows[0]
            .context_usage
            .as_ref()
            .expect("context_usage is still carried");
        assert_eq!(
            usage.window, 1_000_000,
            "the window is DERIVED from the resolved model (#85) — a closed \
             session must not keep the stale window its snapshot froze"
        );
        assert_eq!(
            usage.used, 53_760,
            "`used` is a real measurement of the session — replayed, never re-derived"
        );
    }

    /// (#85) The fallback half: a row whose `capabilities.model` no longer
    /// resolves keeps its snapshot window (the only window anyone knows).
    #[tokio::test]
    async fn a_stored_session_with_an_unresolvable_model_keeps_its_snapshot_window() {
        let catalog = ModelCatalog {
            models: vec![level_test_model("tama", "m1", &[])],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_catalog(catalog);
        // A model key the catalog does not know (the provider was removed).
        db.record_session(&SessionInfo {
            session_id: "cu-derive-gone".to_string(),
            cwd: dir.to_path_buf(),
            capabilities: json!({
                "native": true,
                "model": "gone/model",
                "loadSession": true,
            }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .expect("record_session should succeed");
        db.record_session_context_usage("cu-derive-gone", 1_000, 640_000)
            .expect("record_session_context_usage should succeed");
        let rows = manager
            .list_sessions(true)
            .await
            .expect("list_sessions works");
        let usage = rows[0]
            .context_usage
            .as_ref()
            .expect("context_usage is carried");
        assert_eq!(
            usage.window, 640_000,
            "an unresolvable model keeps the snapshot — it is the only window known"
        );
    }

    /// `list_sessions` carries the stored `title` (the naming pass's
    /// generated label — the sidebar renders it), and a session with no
    /// title yet carries `None` (NOT the empty string: the frontend renders
    /// the fallback label from the absence).
    #[tokio::test]
    async fn list_sessions_carries_the_stored_title() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "high", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.attach_db(db.clone());
        manager.set_catalog(catalog);
        for id in ["nat-titled-1", "nat-untitled-2"] {
            db.record_session(&SessionInfo {
                session_id: id.to_string(),
                cwd: dir.to_path_buf(),
                capabilities: json!({
                    "native": true,
                    "model": "tama/m1",
                    "loadSession": true,
                }),
                config_options: None,
                archived: false,
                title: None,
                context_usage: None,
                cost_usd: None,
                is_subagent: false,
            })
            .expect("record_session should succeed");
        }
        // Only ONE of them is titled (the naming pass ran for that session).
        db.set_session_title("nat-titled-1", "Rename the persist seam")
            .expect("set_session_title should succeed");
        let rows = manager
            .list_sessions(true)
            .await
            .expect("list_sessions should work");
        assert_eq!(rows.len(), 2, "both stored rows are listed");
        let by_id: std::collections::HashMap<&str, Option<&str>> = rows
            .iter()
            .map(|r| (r.session_id.as_str(), r.title.as_deref()))
            .collect();
        assert_eq!(
            by_id["nat-titled-1"],
            Some("Rename the persist seam"),
            "the stored title crosses the IPC boundary"
        );
        assert_eq!(
            by_id["nat-untitled-2"], None,
            "an untitled stored row carries None"
        );
    }

    /// A resume carries the stored `context_usage` (the last known before
    /// the close — the `load_transcript` re-estimate's first frame
    /// refreshes it after the resume).
    #[tokio::test]
    async fn a_resume_carries_the_stored_context_usage() {
        let catalog = ModelCatalog {
            models: vec![level_test_model(
                "tama",
                "m1",
                &["off", "low", "high", "xhigh"],
            )],
            default_model: Some("tama/m1".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, db) = build_worker_manager(&dir, catalog, &sink);
        db.record_session(&SessionInfo {
            session_id: "nat-resume-cu-1".to_string(),
            cwd: dir.to_path_buf(),
            capabilities: json!({
                "native": true,
                "model": "tama/m1",
                "loadSession": true,
            }),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            cost_usd: None,
            is_subagent: false,
        })
        .expect("record_session should succeed");
        db.record_session_context_usage("nat-resume-cu-1", 96_000, 128_000)
            .expect("record_session_context_usage should succeed");
        let info = manager
            .resume_session("nat-resume-cu-1", dir.to_path_buf(), &sink)
            .await
            .expect("the native resume works");
        let usage = info
            .context_usage
            .expect("the resume carries the stored context usage");
        assert_eq!(usage.used, 96_000);
        assert_eq!(usage.window, 128_000);
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (settings chain) the native model resolution chain: the
    /// `Settings.default_model` (a fresh `load_settings` read) > the
    /// catalog's `default_model` > the selectable set. An UNRESOLVABLE key
    /// at any rung falls through to the NEXT rung.
    #[tokio::test]
    async fn the_native_model_chain_settings_default_wins_over_the_catalog_default() {
        let catalog = ModelCatalog {
            models: vec![
                chain_test_model("s", "m1"),
                chain_test_model("c", "m2"),
                chain_test_model("h", "m3"),
            ],
            default_model: Some("c/m2".to_string()),
            compaction: crate::agent::harness::catalog::CompactionConfig::default(),
        };
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });

        // Phase 1: settings `s/m1` (in the catalog) → the settings rung
        // wins over the catalog default.
        write_settings_default_model(&dir, Some("s/m1"));
        let (manager, _wm, _db) = build_worker_manager(&dir, catalog.clone(), &sink);
        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");
        assert_eq!(
            info.capabilities["model"], "s/m1",
            "the settings default wins over the catalog default"
        );
        let _ = manager.close_session(&info.session_id).await;

        // Phase 2: settings `gone/m1` (NOT in the catalog) → the
        // unresolvable settings key falls through to the CATALOG DEFAULT
        // rung (not straight to the selectable set).
        write_settings_default_model(&dir, Some("gone/m1"));
        let (manager, _wm, _db) = build_worker_manager(&dir, catalog.clone(), &sink);
        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");
        assert_eq!(
            info.capabilities["model"], "c/m2",
            "an unresolvable settings key degrades to the catalog default"
        );
        let _ = manager.close_session(&info.session_id).await;

        // Phase 3: NO settings default → the catalog default applies.
        write_settings_default_model(&dir, None);
        let (manager, _wm, _db) = build_worker_manager(&dir, catalog.clone(), &sink);
        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");
        assert_eq!(
            info.capabilities["model"], "c/m2",
            "an absent settings default degrades to the catalog default"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// (live `/v1/models` discovery) `refresh_model_metadata` applies the
    /// live metadata (context window, thinking levels) from the provider's
    /// `GET /v1/models`, and degrades to the static metadata when the
    /// endpoint is unreachable (best-effort — a failure never blocks the
    /// session).
    #[tokio::test]
    async fn refresh_model_metadata_applies_live_and_degrades_on_failure() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // A mock server serving `GET /v1/models` with fresh metadata.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
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
                    let body = r#"{"data":[{"id":"m1","max_model_len":4242,
                        "reasoningLevels":["low"],
                        "supportsReasoningEffort":true}]}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                });
            }
        });
        let dir = crate::test_support::ScratchDir::in_env_temp("refresh-", "metadata");
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.set_catalog(ModelCatalog {
            models: vec![Model {
                id: "m1".into(),
                provider: "fake".into(),
                base_url: format!("http://{addr}/v1"),
                api_key: "k".into(),
                context_window: 128000,
                cost_per_mtok_in: 0.0,
                cost_per_mtok_out: 0.0,
                supports_tools: true,
                supports_thinking: false,
                thinking_levels: Vec::new(),
                api: Some("openai-completions".into()),
            }],
            ..Default::default()
        });
        let model = manager.catalog.clone().models[0].clone();
        // First refresh: fetches + applies the live metadata.
        let refreshed = manager.refresh_model_metadata(&model).await;
        assert_eq!(refreshed.context_window, 4242);
        assert_eq!(refreshed.thinking_levels, vec!["low".to_string()]);
        assert!(refreshed.supports_thinking);
        // The `api_key` / `base_url` / `id` are untouched (only the metadata
        // fields are refreshed).
        assert_eq!(refreshed.api_key, "k");
        assert_eq!(refreshed.base_url, model.base_url);
        // A model whose endpoint is UNREACHABLE degrades to the static
        // metadata (the `Model` is returned unchanged — best-effort). A
        // distinct `provider` (a fresh cache entry) so the unreachable
        // endpoint is actually fetched (not the first model's warm cache).
        let unreachable = Model {
            provider: "unreach".to_string(),
            base_url: "http://127.0.0.1:1/v1".to_string(),
            ..model.clone()
        };
        let degraded = manager.refresh_model_metadata(&unreachable).await;
        assert_eq!(degraded.context_window, 128000);
        assert!(!degraded.supports_thinking);
        server.abort();
    }

    /// Write a `settings.json` with a single user provider (the
    /// `effective_catalog` tests — the desktop-owned provider store, ADR
    /// 0014; the camelCase wire shape). `api` is the provider's wire API
    /// (ADR 0024 — a pre-feature fixture omits the field, which parses to
    /// `"openai-completions"` via the serde default).
    fn write_settings_provider_api(dir: &Path, id: &str, base_url: &str, api: &str) {
        let settings = serde_json::json!({
            "providers": [
                { "id": id, "name": id, "baseUrl": base_url, "apiKey": "k", "api": api }
            ]
        });
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();
    }

    /// Write a `settings.json` with a single user provider (the pre-feature
    /// wire shape — NO `api` field; the serde default gives
    /// `"openai-completions"`).
    fn write_settings_provider(dir: &Path, id: &str, base_url: &str) {
        write_settings_provider_api(dir, id, base_url, "openai-completions")
    }

    /// A full `Model` literal (the `provider` / `base_url` are
    /// parameterized — `session.rs` has no `Model` helper of its own).
    fn provider_model(id: &str, provider: &str, base_url: &str) -> Model {
        Model {
            id: id.to_string(),
            provider: provider.to_string(),
            base_url: base_url.to_string(),
            api_key: "k".to_string(),
            context_window: DEFAULT_CONTEXT_WINDOW,
            cost_per_mtok_in: 0.0,
            cost_per_mtok_out: 0.0,
            supports_tools: true,
            supports_thinking: false,
            thinking_levels: Vec::new(),
            api: Some("openai-completions".to_string()),
        }
    }

    /// (ADR 0014) `effective_catalog` discovers a user provider's models
    /// via `GET {base_url}/models` (a fresh `settings.json` read) and
    /// maps them onto `Model` rows (the provider's `base_url` / `api_key`;
    /// `context_window` falls back to `DEFAULT_CONTEXT_WINDOW` when the
    /// response lacks `max_model_len`).
    #[tokio::test]
    async fn effective_catalog_discovers_a_user_provider() {
        let dir = temp_config_dir();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = crate::test_support::raw_json_server(
            listener,
            200,
            r#"{"data":[{"id":"m/1"}]}"#, // no `max_model_len` → the default window
            None,
        )
        .await;
        write_settings_provider(&dir, "tama", &format!("http://{addr}/v1"));
        // A seeded catalog under a DIFFERENT provider id (coexists — no
        // clash).
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.set_catalog(ModelCatalog {
            models: vec![provider_model("s/1", "other", "https://other/v1")],
            ..Default::default()
        });
        let effective = manager.effective_catalog(None).await;
        let user: Vec<&Model> = effective
            .models
            .iter()
            .filter(|m| m.provider == "tama")
            .collect();
        assert_eq!(user.len(), 1, "the discovered model is in the catalog");
        assert_eq!(user[0].id, "m/1");
        assert_eq!(user[0].api.as_deref(), Some("openai-completions"));
        assert_eq!(user[0].api_key, "k");
        assert_eq!(user[0].base_url, format!("http://{addr}/v1"));
        // The response lacks `max_model_len` → the default window.
        assert_eq!(user[0].context_window, DEFAULT_CONTEXT_WINDOW);
        // The seeded model coexists (no id clash).
        assert!(effective.models.iter().any(|m| m.provider == "other"));
        server.abort();
    }

    /// (ADR 0024) A provider with `api: "anthropic-messages"` yields an
    /// effective-catalog model with `api: Some("anthropic-messages")` (the
    /// provider's `api` decides the wire — the `SessionManager`'s default
    /// factory dispatches on it; the pre-feature fixtures default to
    /// `openai-completions` via the serde default, asserted in
    /// `effective_catalog_discovers_a_user_provider`).
    #[tokio::test]
    async fn resolve_uses_the_provider_api() {
        let dir = temp_config_dir();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server =
            crate::test_support::raw_json_server(listener, 200, r#"{"data":[{"id":"m/1"}]}"#, None)
                .await;
        write_settings_provider_api(
            &dir,
            "anthropic",
            &format!("http://{addr}/v1"),
            "anthropic-messages",
        );
        let manager = SessionManager::new(dir.to_path_buf());
        let effective = manager.effective_catalog(None).await;
        let user: Vec<&Model> = effective
            .models
            .iter()
            .filter(|m| m.provider == "anthropic")
            .collect();
        assert_eq!(user.len(), 1, "the discovered model is in the catalog");
        // The provider's `api` decides the wire (NOT a hard-coded
        // `openai-completions`).
        assert_eq!(user[0].api.as_deref(), Some("anthropic-messages"));
        server.abort();
    }

    /// (ADR 0026) A provider with `api: "litellm"` yields an effective-catalog
    /// model with `api: Some("litellm")` (the provider's `api` decides the wire
    /// — and the wire for `litellm` is `openai-completions`, Task 3/ADR 0026).
    #[tokio::test]
    async fn resolve_uses_the_litellm_provider_api() {
        let dir = temp_config_dir();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // The `litellm` discovery arm hits `{base}/model/info` — serve the
        // LiteLLM shape (the test_support `raw_json_server` is the 4-arg
        // `counter: Option<…>` variant; pass `None`).
        let server = crate::test_support::raw_json_server(
            listener,
            200,
            r#"{"data":[{"model_name":"lit/1","model_info":{"max_input_tokens":262144,"reasoning_effort_levels":["none","low"],"supports_reasoning":true}}]}"#,
            None,
        )
        .await;
        write_settings_provider_api(&dir, "llm", &format!("http://{addr}/v1"), "litellm");
        let manager = SessionManager::new(dir.to_path_buf());
        let effective = manager.effective_catalog(None).await;
        let user: Vec<&Model> = effective
            .models
            .iter()
            .filter(|m| m.provider == "llm")
            .collect();
        assert_eq!(user.len(), 1, "the discovered model is in the catalog");
        // The provider's `api` is stamped verbatim (NOT `openai-completions`).
        assert_eq!(user[0].api.as_deref(), Some("litellm"));
        // ... and the metadata mapped (the discovery arm actually ran):
        assert_eq!(user[0].context_window, 262144);
        assert_eq!(
            user[0].thinking_levels,
            vec!["none".to_string(), "low".to_string()]
        );
        server.abort();
    }

    /// (ADR 0014) A provider whose discovery FAILS (unreachable endpoint)
    /// still SHADOWS the seeded models for its id (a transient failure
    /// must not resurrect stale seeded models under the same id).
    #[tokio::test]
    async fn effective_catalog_a_failed_discovery_still_shadows_the_seeded_provider() {
        let dir = temp_config_dir();
        write_settings_provider(&dir, "tama", "http://127.0.0.1:1/v1"); // unreachable
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.set_catalog(ModelCatalog {
            models: vec![
                provider_model("stale/1", "tama", "https://stale/v1"),
                provider_model("q/1", "q", "https://q/v1"),
            ],
            default_model: Some("tama/stale/1".to_string()),
            ..Default::default()
        });
        let effective = manager.effective_catalog(None).await;
        assert!(
            !effective.models.iter().any(|m| m.provider == "tama"),
            "a failed discovery must NOT resurrect the stale seeded models"
        );
        // A non-shadowed provider's seeded models survive.
        assert!(effective.models.iter().any(|m| m.provider == "q"));
        // The seeded default belonged to the shadowed provider → `None`.
        assert_eq!(effective.default_model, None);
    }

    /// (ADR 0014) The discovery is CACHED per provider (a second
    /// `effective_catalog` is not re-fetched), and a `force_refresh` for
    /// the provider BYPASSES the cache (a fresh fetch overwrites the
    /// entry — even a re-pointed `base_url` is honored, the `settings.json`
    /// read is fresh).
    #[tokio::test]
    async fn effective_catalog_caches_and_force_refresh_bypasses_the_cache() {
        let dir = temp_config_dir();
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = crate::test_support::raw_json_server(
            listener,
            200,
            r#"{"data":[{"id":"v1"}]}"#,
            Some(counter.clone()),
        )
        .await;
        write_settings_provider(&dir, "tama", &format!("http://{addr}/v1"));
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.set_catalog(ModelCatalog::default());
        let first = manager.effective_catalog(None).await;
        assert!(first.models.iter().any(|m| m.id == "v1"));
        // Second call: the cache serves it (the server is NOT hit again).
        let second = manager.effective_catalog(None).await;
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "the second call must be cache-served"
        );
        assert!(second.models.iter().any(|m| m.id == "v1"));
        // A `force_refresh` for the provider bypasses the cache (a fresh
        // fetch overwrites the entry — a NEW response body is asserted via
        // the counter-driven flow: re-point the provider at a second
        // listener serving `v2`).
        let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr2 = listener2.local_addr().unwrap();
        let server2 = crate::test_support::raw_json_server(
            listener2,
            200,
            r#"{"data":[{"id":"v2"}]}"#,
            Some(counter.clone()),
        )
        .await;
        write_settings_provider(&dir, "tama", &format!("http://{addr2}/v1"));
        let refreshed = manager.effective_catalog(Some("tama")).await;
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::Relaxed),
            2,
            "the force refresh must re-fetch"
        );
        assert!(refreshed.models.iter().any(|m| m.id == "v2"));
        assert!(!refreshed.models.iter().any(|m| m.id == "v1"));
        server.abort();
        server2.abort();
    }

    /// (#85) A FAILED discovery must not latch for the process's life.
    ///
    /// The cache marks a provider `attempted` before the fetch, and the failure
    /// arm used to leave it that way with `models` cleared — so a provider whose
    /// endpoint was unreachable ONCE (the app launched before the network was up,
    /// a gateway mid-restart) contributed 0 models for the rest of the run. The
    /// provider row showed `unreachable`, the model picker was short its models,
    /// and nothing short of a restart or that provider's own refresh recovered
    /// it. A SUCCESS still caches (the whole point of the cache); only the
    /// failure is retried.
    ///
    /// This is the same defect as #85's stale window one layer down: the cache
    /// holding a wrong answer with no path to correction.
    #[tokio::test]
    async fn a_failed_discovery_does_not_latch_the_negative_result() {
        let dir = temp_config_dir();
        // Port 1 refuses instantly — a deterministic "unreachable" (no timeout
        // to wait out), the same fixture the shadow test uses.
        write_settings_provider(&dir, "tama", "http://127.0.0.1:1/v1");
        let mut manager = SessionManager::new(dir.to_path_buf());
        manager.set_catalog(ModelCatalog::default());
        let failed = manager.effective_catalog(None).await;
        assert!(
            !failed.models.iter().any(|m| m.provider == "tama"),
            "the first attempt genuinely failed"
        );
        // The endpoint comes good (the provider is re-pointed at a live server —
        // the `settings.json` read is fresh, exactly as the force-refresh test
        // relies on).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = crate::test_support::raw_json_server(
            listener,
            200,
            r#"{"data":[{"id":"recovered"}]}"#,
            None,
        )
        .await;
        write_settings_provider(&dir, "tama", &format!("http://{addr}/v1"));
        // NO `force_refresh`: an ordinary read must retry a provider whose last
        // attempt FAILED.
        let retried = manager.effective_catalog(None).await;
        assert!(
            retried.models.iter().any(|m| m.id == "recovered"),
            "a plain read must retry a previously-FAILED provider — a transient \
             failure must not blacklist it for the process's life"
        );
        server.abort();
    }

    /// ADR 0044: `/compact` on a session that is NOT live (a stored session)
    /// is a NO-OP, not an error — resuming a session in order to compact it is
    /// a larger flow than the command is worth. `Ok(false)` = "nothing ran".
    #[tokio::test]
    async fn compact_session_on_a_non_live_session_is_a_no_op() {
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
        assert!(
            !manager
                .compact_session("arch_not_live", None)
                .await
                .expect("a stored session is not an error"),
            "a non-live session compacts nothing (false)"
        );
    }

    /// `/compact` on a LIVE session sends the `compact` frame (`Ok(true)` —
    /// the return is "the frame was sent", not "the transcript shrank": the
    /// Worker emits the frames) and touches NOTHING else: above all it does
    /// NOT set `cancel_requested` (`send_prompt` clears it and the router
    /// reads it only while a turn slot is occupied, so an idle compaction that
    /// set it would map the NEXT settle to `Cancelled`).
    #[tokio::test]
    async fn compact_session_sends_the_frame_and_never_marks_a_cancel() {
        let dir = temp_config_dir();
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");
        assert!(
            manager
                .compact_session(&info.session_id, Some("keep the tests".to_string()))
                .await
                .expect("the live send succeeds"),
            "the frame was sent to the live session"
        );
        let cancel_requested = {
            let live = manager.live.lock().unwrap_or_else(|p| p.into_inner());
            live.get(&info.session_id)
                .map(|l| *l.cancel_requested.lock().unwrap_or_else(|p| p.into_inner()))
        };
        assert_eq!(
            cancel_requested,
            Some(false),
            "an idle compaction does not touch the session's cancel flag"
        );
    }

    #[test]
    fn session_manager_builder_cyclic_weak_reference_drops_cleanly() {
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let persister = Arc::new(TranscriptPersister::new(db.clone()));

        let (manager, wm) = SessionManagerBuilder::new(dir.to_path_buf(), db, sink, persister)
            .with_worker_factory(Arc::new(FixtureFactory))
            .build();

        // WorkerManager's hooks hold a Weak<SessionManager>.
        // Dropping the manager should drop the underlying SessionManager.
        drop(manager);

        // Weak upgrade must fail cleanly
        assert!(wm.hooks().sink_for("any").is_none());
    }

    #[test]
    fn session_manager_builder_preserves_supplied_persister() {
        let dir = temp_config_dir();
        let db = open_db(&dir);
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let persister = Arc::new(TranscriptPersister::new(db.clone()));

        let (manager, _wm) =
            SessionManagerBuilder::new(dir.to_path_buf(), db, sink, persister.clone())
                .with_worker_factory(Arc::new(FixtureFactory))
                .build();

        assert!(
            Arc::ptr_eq(
                &persister,
                &manager.persister().expect("persister should be set")
            ),
            "SessionManager must use the exact persister instance provided to the builder"
        );
    }

    // ── Task 4: the `allow-directory` relay persistence ───────────────────
    //
    // The relay's persistence half of ADR 0025: an "Always allow this
    // directory" answer appends EXACTLY ONE `allow` rule to `settings.json`'s
    // `rules` key — which holds ONLY user rules (`default_rules()` is
    // runtime-only and never serialized), so the file-side half of the
    // ordering contract is "appended AFTER the pre-existing user rules". The
    // RUNTIME half (defaults FIRST, then the user rules, so an appended allow
    // wins an exact tie against a default `deny`) is the harness concat site's
    // half, and the tie itself is pinned in `agent/policy.rs`'s
    // `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny`.
    // Concatenate the other way round and every rule written here silently
    // no-ops at the gate.

    /// The FILE side of the ordering contract: exactly ONE rule appended, at
    /// the END of the pre-existing user rules, nothing else in the document
    /// touched. Seeded with a real user rule (the file has no defaults in it —
    /// a `rules[..default_rules().len()] == default_rules()` assertion would
    /// be false on every machine).
    #[tokio::test]
    async fn an_allow_directory_answer_appends_exactly_one_rule_after_the_existing_user_rules() {
        use crate::agent::policy::{AccessRule, RuleDecision, RuleDirection};
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(
            &dir,
            serde_json::json!({
                "filePolicy": {
                    "reads": "allow", "writes": "allow", "shell": "allow",
                    "rules": [{ "path": "/Users/u/older", "direction": "write", "decision": "deny" }]
                }
            }),
        );
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, info) = start_native_session(&dir, &sink).await;

        manager.persist_allow_directory_rule(Some("/Users/u/skills"));

        let rules = load_settings(dir.path()).file_policy.rules;
        assert_eq!(
            rules.len(),
            2,
            "exactly ONE rule appended to the pre-existing user rules"
        );
        assert_eq!(
            rules[0],
            AccessRule {
                path: "/Users/u/older".to_string(),
                direction: RuleDirection::Write,
                decision: RuleDecision::Deny,
            },
            "the pre-existing user rule is untouched and still FIRST"
        );
        assert_eq!(
            rules[1],
            AccessRule {
                path: "/Users/u/skills".to_string(),
                direction: RuleDirection::ReadWrite,
                decision: RuleDecision::Allow,
            },
            "the new allow lands at the END of the user rules — the file-side half of the CONCATENATION CONTRACT"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// A `None` value, the gate's `""` placeholder, and an all-whitespace path
    /// all persist NOTHING — a rule matching nothing would pollute the file,
    /// the Settings list, and the round-trip. T03 replaces the placeholder;
    /// this pin keeps the seam honest until then.
    #[tokio::test]
    async fn a_blank_or_absent_value_persists_nothing() {
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, info) = start_native_session(&dir, &sink).await;

        manager.persist_allow_directory_rule(None);
        manager.persist_allow_directory_rule(Some(""));
        manager.persist_allow_directory_rule(Some("   "));

        let settings = load_settings(dir.path());
        assert!(
            settings.file_policy.rules.is_empty(),
            "a blank path persists nothing, got {:?}",
            settings.file_policy.rules
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// A repeat click on the same directory is idempotent: dedupe by
    /// path + direction + decision, so the second click writes nothing rather
    /// than a duplicate row that re-orders the file.
    #[tokio::test]
    async fn a_second_click_on_the_same_directory_is_idempotent() {
        use crate::agent::policy::{RuleDecision, RuleDirection};
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, info) = start_native_session(&dir, &sink).await;

        manager.persist_allow_directory_rule(Some("/Users/u/skills"));
        manager.persist_allow_directory_rule(Some("/Users/u/skills"));

        let settings = load_settings(dir.path());
        assert_eq!(
            settings.file_policy.rules.len(),
            1,
            "one rule total, not two"
        );
        assert_eq!(
            settings
                .file_policy
                .rules
                .iter()
                .filter(|r| r.direction == RuleDirection::ReadWrite
                    && r.decision == RuleDecision::Allow)
                .count(),
            1,
            "a repeat click must NOT append a duplicate rule"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// The dedupe is EXACT identity, never a path key: a hand-written `Deny`
    /// for the same path is a DIFFERENT rule, so the allow coexists with it
    /// (and the last-wins tie-break in `rule_for` is what decides).
    #[tokio::test]
    async fn a_differing_rule_for_the_same_path_still_appends() {
        use crate::agent::policy::{RuleDecision, RuleDirection};
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(
            &dir,
            serde_json::json!({
                "filePolicy": {
                    "reads": "allow", "writes": "allow", "shell": "allow",
                    "rules": [{ "path": "/Users/u/skills", "direction": "write", "decision": "deny" }]
                }
            }),
        );
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, info) = start_native_session(&dir, &sink).await;

        manager.persist_allow_directory_rule(Some("/Users/u/skills"));

        let rules = load_settings(dir.path()).file_policy.rules;
        assert_eq!(rules.len(), 2, "a differing rule is NOT deduped away");
        assert!(rules
            .iter()
            .any(|r| r.direction == RuleDirection::Write && r.decision == RuleDecision::Deny));
        assert!(rules
            .iter()
            .any(|r| r.direction == RuleDirection::ReadWrite && r.decision == RuleDecision::Allow));
        let _ = manager.close_session(&info.session_id).await;
    }

    /// The persist arm lives INSIDE `respond_permission`'s send-success arm,
    /// so a `handle_for` miss (`Ok(false)`) reaches neither the trust-space
    /// write nor the rule append.
    #[tokio::test]
    async fn a_missing_worker_routes_the_answer_to_nowhere_and_writes_no_rule() {
        use crate::agent::permission::PermissionOutcome;
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);
        // NO session is started — `handle_for` misses → `Ok(false)` and the
        // `Ok(())` arm (where the persistence lives) is never reached.
        let hit = manager
            .respond_permission(
                "no-such-session",
                "req-1",
                PermissionOutcome::Selected {
                    option_id: "allow-directory".to_string(),
                    value: Some("/Users/u/skills".to_string()),
                },
            )
            .await
            .expect("the miss is Ok(false), not Err");
        assert!(!hit, "a missing worker is a no-op");
        assert!(
            load_settings(dir.path()).file_policy.rules.is_empty(),
            "no session → no write"
        );
    }

    /// The `trust-space` persistence arm is UNCHANGED by the `value`
    /// destructure: an answer still flips the `spaces` row (seeded first —
    /// `set_space_trusted` is an UPDATE) and writes NO rule.
    #[tokio::test]
    async fn the_trust_space_persistence_arm_is_unchanged() {
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        let (manager, _wm, db) = build_worker_manager(&dir, native_test_catalog(), &sink);
        let info = manager
            .start_session(dir.to_path_buf(), &sink)
            .await
            .expect("the native session started");

        let cwd = info.cwd.clone();
        // `set_space_trusted` is an UPDATE — a missing row is a no-op, so the
        // row must exist (INSERT) before the arm can flip it.
        db.upsert_space(&cwd.display().to_string(), false)
            .expect("the space row is seeded");

        manager
            .respond_permission(
                &info.session_id,
                "req-1",
                crate::agent::permission::PermissionOutcome::Selected {
                    option_id: "trust-space".to_string(),
                    value: None,
                },
            )
            .await
            .expect("the answer relays");

        assert!(
            db.space_trusted(&cwd).expect("space_trusted should work"),
            "the trust-space arm still flips the `spaces` row"
        );
        assert!(
            load_settings(dir.path()).file_policy.rules.is_empty(),
            "trust-space writes NO rule"
        );
        let _ = manager.close_session(&info.session_id).await;
    }

    /// The child path (a subagent rides this same relay through `handle_for`'s
    /// `drives` fallback and has NO `live` entry, so `cwd` is `None` for it)
    /// is covered by CONSTRUCTION, not by a fixture: the persistence method
    /// reads `value` and `config_dir` ONLY — no `self.live`, no `self.driver`,
    /// no `db` — which its doc states as a checkable guarantee. Driving a real
    /// child-shaped `respond_permission` is not possible with these fixtures
    /// (`start_native_session` always carries a main-session `live` entry with
    /// a `cwd`, and a manager with no live entry misses `handle_for` — which is
    /// the `Ok(false)` pin above). This test pins the observable half of that
    /// construction claim: the write happens on a manager with NO live session
    /// at all — nothing but the `value` and the config dir is involved.
    #[tokio::test]
    async fn the_persist_write_needs_no_live_session_state() {
        use crate::agent::policy::{RuleDecision, RuleDirection};
        use crate::config::load_settings;

        let dir = temp_config_dir();
        write_settings_json(&dir, serde_json::json!({}));
        let (tx, _rx) = mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(TestSink { tx });
        // NO session started: no `live` entry, no `cwd`, nothing attached
        // beyond the `db` the builder wires. The method still persists —
        // because its ONLY inputs are the `value` and `config_dir`.
        let (manager, _wm, _db) = build_worker_manager(&dir, native_test_catalog(), &sink);

        manager.persist_allow_directory_rule(Some("/Users/u/child-skills"));

        let rules = load_settings(dir.path()).file_policy.rules;
        assert_eq!(rules.len(), 1, "the value-only write needs no session");
        assert_eq!(
            rules[0],
            crate::agent::policy::AccessRule {
                path: "/Users/u/child-skills".to_string(),
                direction: RuleDirection::ReadWrite,
                decision: RuleDecision::Allow,
            },
            "the persisted rule is the `value` verbatim, ReadWrite/Allow"
        );
    }
}
