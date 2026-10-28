# Grounding report — Supervisor relay & settings persistence

**Scope:** `src-tauri/src/agent/session/mod.rs`, `src-tauri/src/config.rs`, `src-tauri/src/storage/db.rs`, plus the Worker-side entry points the relay touches (`src-tauri/src/agent/worker/core.rs`, `src-tauri/src/agent/worker/manager/mod.rs`, `src-tauri/src/agent/harness/loop.rs`) and every `settings.json` writer in the crate.

**Spec context:** the relay persists an `allow-directory` rule to `settings.json` (Worker has no `Db`; the relay owns the write), and `PermissionOutcome::Selected` gains an optional `value`. Everything here is what EXISTS today. No recommendations, no proposed patch.

---

## 1. `respond_permission` — the relay's equality of arms, and the missing subagent half

### 1a. Signature (verbatim, `SessionManager::respond_permission`, in `session/mod.rs`)

```rust
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
```

Note the doc-comment body is duplicated (two stacked blocks, the first stale, citing the pre-ADR-0025 "the caller can then route a miss to the subagent manager" and pre-move "`pending_permissions` map lives in the WORKER now"). The code body:

```rust
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
                if let permission::PermissionOutcome::Selected { option_id } = &outcome {
                    if option_id == "trust-space" {
                        if let (Some(db), Some(cwd)) = (&self.driver.db, cwd) {
                            let _ = db.set_space_trusted(&cwd.display().to_string(), true);
                        }
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
```

**The exact `trust-space` persistence pattern the rule-write follows** (quoted immediately above, in `respond_permission`):

```rust
                if let permission::PermissionOutcome::Selected { option_id } = &outcome {
                    if option_id == "trust-space" {
                        if let (Some(db), Some(cwd)) = (&self.driver.db, cwd) {
                            let _ = db.set_space_trusted(&cwd.display().to_string(), true);
                        }
                    }
                }
```

Observed mechanics a planner needs:

- The `cwd` is read from `self.live` (a `LiveWorkerSession { cwd, … }` map — main-session bookkeeping only). `LiveWorkerSession` (in `session/mod.rs`) holds `cwd: PathBuf`, `close_kind`, `pending_turn`, `cancel_requested`, `pending_modal_ids`.
- The persistence is guarded on `(&self.driver.db, cwd)` both being `Some`; the result of `db.set_space_trusted(...)` is `let _ =` (error swallowed). `self.driver` is the `SessionDriver { db: Option<Arc<Db>>, trust_db: Option<Arc<Db>> }` — `db` is transcript persistence + the `spaces` table (main only), `trust_db` is the trust lookup for main AND subagent.
- **No code path in `respond_permission` resolves a subagent session's `cwd` from the child side.** `self.live` has an entry only for main sessions (the `start_native_session` / `resume_native_session` path inserts it; subagent `drives` live in the `WorkerManager`, keyed by child session id, and the child's cwd is recorded in the Supervisor's `TranscriptPersister` `cwd_map` via `set_cwd` — see §1c). The main branch's `trust-space` write therefore would be a no-op for a child (`self.live.get(child_id)` → `None`).

### 1b. The subagent branch — the `pending_*` maps

The relay is a single command path. The **Tauri command** `respond_permission` (`commands/sessions.rs`, quoted verbatim in full):

```rust
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
```

Its doc:

```rust
/// The ADR 0025 Task 5 re-plumb: a SINGLE `state` (the `SessionManager`
/// routes through the `WorkerManager`'s `handle_for` — a MAIN session's
/// handle is in the `workers` map, a SUBAGENT session's handle in the
/// `drives` map — the `SubagentSessionManager`'s `respond_*` methods are
/// deleted: the child's pending maps live in its Worker).
```

**There is no second "subagent branch" inside `SessionManager::respond_permission`.** The routing that reaches a subagent Worker is the `WorkerManager::handle_for` → `ManagerState::get_handle_for` fallback (`worker/manager/registry.rs`, quoted verbatim):

```rust
    pub(crate) fn get_handle_for(&self, session_id: &str) -> Option<WorkerHandle> {
        {
            let map = self.workers.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(e) = map.get(session_id) {
                return Some(e.handle.clone());
            }
        }
        self.drives
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_id)
            .and_then(|d| d.handle.clone())
    }
```

`ManagerState` fields (quoted from `worker/manager/registry.rs`):

```rust
pub(crate) struct ManagerState {
    /// session_id → the live Worker (the `attach`-time `StartEnv` —
    /// the `dispatch_subagent` reads the parent's effective `catalog`
    /// / `config_dir` / `trusted` from it — the Supervisor owns them).
    pub(crate) workers: StdMutex<HashMap<String, WorkerEntry>>,
    ...
    /// The in-flight subagent dispatchs (session_id → the drive — ...)
    pub(crate) drives: StdMutex<HashMap<String, SubagentDrive>>,
```

`WorkerManager::handle_for`'s doc names the maps explicitly:

```rust
    /// The `drives` fallback (ADR 0025 Task 5 — the `dispatch_native` re-plumb):
    /// a SUBAGENT session's handle is in the `drives` map (the in-flight
    /// dispatchs — the subagent's pending maps live in its Worker; the
    /// `respond_*` commands route through this lookup — main AND subagent
    /// sessions both resolve).
    pub fn handle_for(&self, session_id: &str) -> Option<WorkerHandle> {
        self.state.get_handle_for(session_id)
    }
```

The **child's pending maps are per-Worker**, not per-manager: `WorkerCore` (in `agent/worker/core.rs`) owns

```rust
    pub(crate) pending_permissions: PendingPermissions,
    pub(crate) pending_bridge: PendingInteractive,
    pub(crate) pending_sudo: PendingSudo,
```

created at spawn and shared into the loop. So **a subagent's `respond_permission` resolves through the SAME `SessionManager::respond_permission` body as a main session's** — there is no separate subagent persist branch to mirror; the only difference is (i) which map `handle_for` finds the handle in, and (ii) the cwd lookup above misses for subagents. The `respond_interactive_request` relay (`session/mod.rs`) is structurally identical (same `handle_for` lookup, same `pending_modal_ids` removal, same `note_gate_answered`); its spec-relevant piece is the `note_gate_answered` doc:

```rust
    /// The TRUE answer moment for a **gate** (ADR 0055 review): the Supervisor's
    /// `respond_permission` / `respond_interactive_request` relay the user's
    /// answer to the session's Worker, and this clears the child's record of it
    /// so teardown stops re-emitting a close for a card the user already
    /// answered. The `session_id` is the CHILD id for a child gate (the gate
    /// payload is stored child-keyed and the Client answers with that same
    /// `sessionId`).
```

The `WorkerCore::Inbound::PermissionResponse` handler (the Worker-side twin of the relay, `agent/worker/core.rs`, quoted verbatim):

```rust
            Inbound::PermissionResponse { id, outcome } => {
                // Resolve the `pending_permissions` oneshot (the compound
                // key — the wire `id` is the payload's `requestId`, the
                // map key is `"{session_id}/{request_id}"`; the `PermissionOutcome` verbatim — the real 3-option outcome, mirroring the existing `respond_permission` resolution).
                if let Some(sid) = &self.session_id {
                    let key = permission_key(sid, &id);
                    if let Some(tx) = self.pending_permissions.lock().await.remove(&key) {
                        let _ = tx.send(outcome.clone());
                    }
                    // The mid-session trust flip (the very next tool call
                    // auto-approves, matching today's live-lookup behavior;
                    // the Supervisor's `db.set_space_trusted` write — Task
                    // 4 — is the persistence half).
                    if let PermissionOutcome::Selected { option_id } = &outcome {
                        if option_id == "trust-space" {
                            if let Some(s) = &self.trust {
                                s.set(true);
                            }
                        }
                    }
                }
                Vec::new()
            }
```

The child-cwd record the Supervisor would need for a subagent rule-write: `TranscriptPersister` (`agent/persist.rs`) holds `cwd_map: Arc<StdMutex<HashMap<String,String>>>` and

```rust
    /// Record a session's `cwd` (the `ensure_session_row` source — the
    /// `StoreFrame` carries no `cwd`). Called by the `SessionManager`
    /// (main sessions, at `start`/`resume`) and the `WorkerManager`'s
    /// `dispatch_subagent` flow (subagent sessions).
    pub fn set_cwd(&self, session_id: &str, cwd: &str) {
```

wired in `SessionManager::attach_worker_manager` (`session/mod.rs`):

```rust
        let persister = self.persister.clone();
        wm.set_cwd_registrar(Arc::new(move |session_id: &str, cwd: &str| {
            if let Some(p) = persister.get() {
                p.set_cwd(session_id, cwd);
            }
        }));
```

The subagent dispatch registers the child's cwd as the **parent's** cwd (`subagent_flow.rs`): `state.hooks.register_child_cwd(&child_id, &wire.parent_cwd);` and the child's `StartEnv` gets `wire.parent_cwd.clone()` — subagents run in the parent's Space and share its cwd. The spec's claim "the subagent manager's own `pending_*` maps" does not match the tree: the child's pending maps are the child Worker's own maps, and the supervisor-side handle lookup falls back through `drives`.

### 1c. The `PermissionOutcome` type (verbatim, `agent/permission.rs`)

```rust
/// The user's decision on a permission prompt, as chosen via the
/// `respond_permission` Tauri command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    /// The user selected one of the offered options; `option_id` is its id.
    Selected { option_id: String },
    /// The user dismissed the prompt (or the turn / session was cancelled).
    Cancelled,
}
```

Type aliases and helpers:

```rust
pub type PendingPermissions = Arc<Mutex<HashMap<String, oneshot::Sender<PermissionOutcome>>>>;

pub fn permission_key(session_id: &str, request_id: &str) -> String {
    format!("{session_id}/{request_id}")
}
```

`Selected` has **no `value` field today** — it is a bare `option_id: String`. Every construction site in the crate (gate, tests) matches `Selected { option_id }`, so adding `Option<String>` is a destructuring-compatible widening only if sites stop exhaustively naming just `option_id` (Rust requires all fields named unless `..` — every quoted pattern above uses `Selected { option_id }` alone, which **will fail to compile** once a `value` field is added; the spec's "serde-defaulted" covers the wire only).

The gate's option list (`native_permission_gate`, `agent/permission.rs`, verbatim — the comment "always three options" is the exact assumption the spec removes):

```rust
    // (b) Tell the UI to show the prompt (always three options, since a
    // prompt only ever appears for an untrusted Space, so `trust-space`
    // is always actionable).
    sink.emit(
        "permission-request",
        json!({
            "sessionId": session_id,
            "requestId": request_id,
            "request": {
                "sessionId": session_id,
                "toolCall": { "title": title },
                "options": [
                    { "optionId": "allow", "name": "Allow", "kind": "allow" },
                    { "optionId": "reject", "name": "Block", "kind": "reject" },
                    {
                        "optionId": "trust-space",
                        "name": "Don't ask again for this Space",
                        "kind": "allow"
                    },
                ],
            },
        }),
    );
```

The gate's accept set (the loop gate, `agent/harness/loop/gate.rs`):

```rust
    pub(super) async fn gate_tool(&self, tc: &ToolCall, turn: &CancellationToken) -> bool {
        let outcome = native_permission_gate(
            ...
        )
        .await;
        matches!(
            outcome,
            PermissionOutcome::Selected { option_id }
                if option_id == "allow" || option_id == "trust-space"
        )
    }
```

The frontend echo shape (`src/lib/tauri/types.ts`, verbatim — the wire shape `save_settings`/`respond_permission` users rely on):

```ts
export type PermissionOutcome =
  | { selected: { option_id: string } }
  | "cancelled";
```

`PermissionPrompt.tsx` renders `prompt.options.map((option, i) => ...)` and responds `respond({ selected: { option_id: option.optionId } })` — no `value` is echoed anywhere today, and `PermissionOption` is `{ optionId; name; kind?: string }`.

---

## 2. `Settings` and `write_settings` (`config.rs`)

### 2a. The struct (verbatim, `agent::policy::FilePolicy` lives in `agent/policy.rs` — the only two `agent` imports `config.rs` has)

`FilePolicy` (`agent/policy.rs`, verbatim):

```rust
/// The three per-direction policies (the settings' three selects).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilePolicy {
    pub reads: AccessPolicy,
    pub writes: AccessPolicy,
    /// `bash`. Defaults to `Allow` like the others — so this field alone
    /// removes the ADR 0010 untrusted-Space prompt for `bash` unless the
    /// user sets it back to `Ask`. That is the intended product posture
    /// (pi gates nothing), not a bug to "fix" back to `Ask`.
    pub shell: AccessPolicy,
}
```

with

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccessPolicy {
    Sandboxed,
    Ask,
    #[default]
    Allow,
}
```

`Settings` (`config.rs`, quoted verbatim — every field and its serde attribute; the `#[serde(rename_all = "camelCase")]` sits on the struct itself at line 158):

```rust
/// The persisted app settings.
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// `"system" | "dark" | "light"` (default `"dark"`).
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub palette: Option<String>,
    #[serde(default)]
    pub pane_layout: Value,
    /// Whether to trust new Spaces by default.
    #[serde(default)]
    pub default_trust_new_spaces: bool,
    #[serde(default)]
    pub mcp_mentions_enabled: bool,
    /// (ADR 0030) The per-direction file-access policies. `#[serde(default)]`
    /// — a pre-feature file parses to `FilePolicy::default()` (all `Allow`),
    /// so no migration runs. ...
    #[serde(default)]
    pub file_policy: FilePolicy,
    #[serde(default)]
    pub web: WebSettings,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_thinking_level: Option<String>,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub mcp_servers: HashMap<String, Value>,
    #[serde(default)]
    pub font: FontSettings,
    #[serde(default)]
    pub default_thinking_levels: HashMap<String, String>,
    #[serde(default, skip_serializing)]
    pub subagent_models: HashMap<String, String>,
    #[serde(default)]
    pub agent_overrides: HashMap<String, AgentOverrideFields>,
    #[serde(default)]
    pub spinner_style: Option<String>,
    #[serde(default)]
    pub empty_state_animation: Option<String>,
    #[serde(default = "default_true")]
    pub session_naming_enabled: bool,
    #[serde(default)]
    pub session_naming_model: Option<String>,
    #[serde(default)]
    pub session_naming_reasoning: Option<String>,
    #[serde(default = "default_true")]
    pub attention_alerts_enabled: bool,
    #[serde(default = "default_attention_delay_secs")]
    pub attention_alert_delay_secs: u64,
    #[serde(default = "default_subagent_dead_bound_secs")]
    pub subagent_dead_bound_secs: u64,
}
```

`impl Default for Settings` fills every field (`theme: "dark"`, `file_policy: FilePolicy::default()`, session naming / attention ON, etc. — quoted in §7 inventory context; standard `Default` list, `subagent_models = HashMap::new()`).

### 2b. `write_settings` — signature, location, atomicity, locking

```rust
/// Persist the settings (overwrites the file). In-process writers (the
/// `set_config_option` memory writes — ADR 0015) call this directly; the
/// command delegates to it.
pub fn write_settings(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    let path = settings_path(config_dir);
    fs::write(
        &path,
        serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
```

```rust
fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}
```

**File location:** `config_dir.join("settings.json")`, where the config dir is `dirs::config_dir() → join("archimedes")` — `~/.config/archimedes/settings.json` on Linux, `~/Library/Application Support/archimedes` on macOS, `%APPDATA%/archimedes` on Windows (wired in `lib.rs`'s `.setup`, quoted: "The on-disk dirs are named `archimedes` (NOT the bundle identifier …): `~/.config/archimedes` + `~/.local/share/archimedes` (Linux), …". The same `config_dir` is threaded into `SessionManager::new(config_dir)` and, via `StartEnv.config_dir`, into every Worker (see §6).

**Creation:** `load_settings` creates the file on first read when missing (quoted verbatim):

```rust
pub fn load_settings(config_dir: &Path) -> Settings {
    let path = settings_path(config_dir);
    if !path.exists() {
        let settings = Settings::default();
        let json = match serde_json::to_string_pretty(&settings) {
            Ok(json) => json,
            Err(e) => {
                eprintln!("settings: failed to serialize defaults: {e}");
                return settings;
            }
        };
        if let Err(e) = fs::write(&path, json) {
            eprintln!("settings: failed to write defaults to {path:?}: {e}");
        }
        return settings;
    }
    ...
```

so `parent` dirs are **not** created by `write_settings` itself (they already exist by the startup path; `load_settings` likewise does no `create_dir_all` — only `Db::open` does).

**Atomicity: NO.** `write_settings` is a plain `fs::write` straight to the final path — no temp file, no `rename`, no `persist`. Grep for `tempfile`/`rename`/`persist`/`atomic` in `config.rs` finds only the `tempfile::tempdir()` test fixtures. A crash mid-write can truncate/tear the JSON.

**Locking: NONE.** No `flock`, no advisory lock, no mutex around the file (the only locks in the write path are per-`Db`-connection `StdMutex`, which do not cover `settings.json`). There is no serialization between any two writers; concurrent reads interleave with writes. There is also no "settings singleton" alias — the file is read fresh by many callers (each `load_settings` call parses it).

**Hazard visibility for the planner — the concurrent-writer reality the spec's "the desktop side owns that file" claim must square with:**

1. `save_settings` (Settings UI) writes the **whole document** from a frontend-supplied `Settings` (see §5a).
2. `SessionManager::set_config_option`'s "remembered thinking level" writes `load_settings → mutate → write_settings` (`session/mod.rs:1744` region, quoted verbatim in §5c).
3. `useAgentOverridesWrites.ts` (Agents modal) does a **fresh `get_settings` re-read → modify → `save_settings`** specifically *because* "Rust writes settings.json on its own", documented verbatim in §5b — a whole-file replace that can clobber any other field changed between its re-read and its save.
4. `useSettingsDocument.ts` (Settings page) composes from the store and `saveSettings(next)` the **complete document** ("the second save drops the first" for two patches in one batch).
5. `write_settings` is also called by the boot path — every `load_settings` on a missing file writes defaults (so a parallel first-use race can write defaults over a file another thread just created).

No process in the crate holds a lock while writing; nothing serializes 1–4. A relay writing `allow-directory` must fit into this read-modify-write, write-whole-file world (the same shape the remembered-thinking-level write uses), and the UI/Agents-modal writers can overwrite a relay's rule if their snapshot predates it.

---

## 3. The backward-compat pin (config.rs)

The spec's referenced pin "an old `settings.json` parses to the new defaults" is this test (`config.rs`, inline `mod tests`), quoted verbatim:

```rust
    #[test]
    fn a_pre_feature_settings_json_parses_to_the_new_defaults() {
        // A file written before the extended fields existed must parse (all
        // new fields `#[serde(default)]`) rather than be treated as corrupt.
        let settings: Settings =
            serde_json::from_str(r#"{ "theme": "dark", "paneLayout": {} }"#).unwrap();
        assert_eq!(settings.default_thinking_level, None);
        assert!(settings.enabled_tools.is_empty());
        assert!(!settings.default_trust_new_spaces);
        assert_eq!(settings.default_model, None);
        assert!(settings.providers.is_empty());
        assert!(settings.mcp_servers.is_empty());
        assert_eq!(settings.font, FontSettings::default());
        assert!(settings.subagent_models.is_empty());
        assert_eq!(settings.spinner_style, None);
        assert_eq!(settings.palette, None);
        // (ADR 0031 follow-up) `#` ships OFF: a file written before the
        // setting existed must NOT silently enable the one trigger that
        // collides with pasted text.
        assert!(!settings.mcp_mentions_enabled);
        // Session naming is the opposite case: it ships ON, so the same
        // pre-feature file reads as ENABLED with no model/reasoning override
        // (`default = "default_true"` — see
        // `session_naming_settings_default_on_and_round_trip_in_camel_case`).
        assert!(settings.session_naming_enabled);
        assert_eq!(settings.session_naming_model, None);
        assert_eq!(settings.session_naming_reasoning, None);
    }
```

It does **not** currently assert on `file_policy` or `rules` (there is no `rules`). The `rules`-defaults-to-empty pin would be a NEW assertion added to this pattern (or to `file_policy_defaults_to_allow_in_every_direction`, §7). The filePolicy-related existing pins are `file_policy_defaults_to_allow_in_every_direction` and `file_policy_serializes_under_the_camel_case_file_policy_key` (quoted in §7).

---

## 4. `set_space_trusted` and the `trusted` column (`storage/db.rs`)

Signature (verbatim) and body:

```rust
    /// Set (or clear) a space's trust flag, keyed by the canonical path
    /// (raw fallback on canonicalize failure, as in `upsert_space`).
    ///
    /// Returns `true` when a row matched, `false` when nothing matched (a
    /// missing row is a no-op, not an error — but a diagnosable one, not a
    /// silent one).
    pub fn set_space_trusted(&self, path: &str, trusted: bool) -> Result<bool, DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE spaces SET trusted = ?2 WHERE path = ?1",
            params![key, trusted],
        )?;
        Ok(n > 0)
    }
```

The `spaces` table (SCHEMA in `db.rs`, verbatim):

```sql
CREATE TABLE IF NOT EXISTS spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);
```

Migration for pre-existing databases (in `Db::open`, verbatim):

```rust
        // One-time migration for pre-existing databases: add `trusted`
        // (fresh databases already have it from SCHEMA). Gated on a schema
        // pre-check — the ALTER runs only when the column is absent, so a
        // re-open never issues it and no error string is matched (the
        // backfill below, by contrast, is idempotent via DO NOTHING).
        let has_trusted: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('spaces') WHERE name = 'trusted'",
            [],
            |row| row.get(0),
        )?;
        if has_trusted == 0 {
            conn.execute(
                "ALTER TABLE spaces ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
```

The row type (`SpaceRow`) and the fail-closed read:

```rust
/// A row from the `spaces` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRow {
    pub path: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub last_opened_at: i64,
    /// Trusted Space flag (untrusted by default; fail-closed reads).
    pub trusted: bool,
}
```

```rust
    /// The trust flag for the space at `cwd`, keyed by the canonical path
    /// (the single key form, ADR 0010). Fail-closed: a canonicalize failure
    /// or a missing row is `Ok(false)` — untrusted.
    pub fn space_trusted(&self, cwd: &std::path::Path) -> Result<bool, DbError> {
        // Fail-closed on canonicalize failure (unlike the write path's raw
        // fallback): a folder that can't be canonicalized is untrusted.
        let Some(key) = space_key(cwd) else {
            return Ok(false);
        };
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT trusted FROM spaces WHERE path = ?1")?;
        let found = stmt
            .query_map(params![key], |row| row.get::<_, i64>(0))?
            .next()
            .transpose()?;
        Ok(found.map(|t| t != 0).unwrap_or(false))
    }
```

Also relevant as "the relay persists a flag" model — `upsert_space` seeds `trusted` from `default_trusted` **only on INSERT** (quoted doc + SQL):

```rust
    /// `default_trusted` is written ONLY on INSERT (a NEW row is born
    /// `trusted` per the flag — the settings' `default_trust_new_spaces`);
    /// the CONFLICT branch never touches `trusted` (an existing row's flag
    /// is never changed by a re-upsert — no retroactive trust).
    pub fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
             VALUES (?1, ?2, ?2, ?3, COALESCE((SELECT MAX(sort_order) FROM spaces), -1) + 1)
                 ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
            params![key, now_ms(), default_trusted],
        )?;
        Ok(())
    }
```

---

## 5. `save_settings` and every writer of `settings.json`

### 5a. The command (`commands/settings.rs`, verbatim)

```rust
/// Read the settings. Always succeeds (see `load_settings`); the `Result`
/// is kept for command-shape stability but is never `Err`.
#[tauri::command]
pub async fn get_settings(
    state: State<'_, Arc<SessionManager>>,
) -> Result<Settings, SettingsError> {
    Ok(load_settings(state.config_dir()))
}

/// Persist the settings (overwrites the file).
#[tauri::command]
pub async fn save_settings(
    state: State<'_, Arc<SessionManager>>,
    settings: Settings,
) -> Result<(), SettingsError> {
    write_settings(state.config_dir(), &settings).map_err(SettingsError::SaveFailed)
}
```

`save_settings` receives a **complete `Settings` from the frontend** and overwrites the whole file. The `Settings` name is the wire shape itself (serde/camelCase `Settings` — the command's argument is the full document).

### 5b. Every production writer of `settings.json` in the crate

| # | Writer | Shape | Where | Notes |
|---|---|---|---|---|
| 1 | `commands::settings::save_settings` | whole-document `write_settings` | `commands/settings.rs` | The Settings-UI save (frontend-supplied full doc). |
| 2 | `SessionManager::set_config_option` ("remembered thinking level", ADR 0015) | `load_settings` → mutate `default_thinking_levels` → `write_settings` | `agent/session/mod.rs:1744` | Best-effort; a failure is `eprintln!`-logged, not an error. Quoted verbatim in §5c. |
| 3 | `load_settings` boot default-write | `fs::write(path, defaults)` when the file is missing | `config.rs` `load_settings` | Creates the file on first read (quoted in §2b). |
| 4 | Frontend `save_settings` via two hooks | whole-document, but sourced from a FRESH `get_settings` (Agents modal) or the store (Settings page) | `src/hooks/useAgentOverridesWrites.ts`, `src/hooks/useSettingsDocument.ts` | Both route to #1 (the same Tauri command). See §5d. |

Grep hits for `fs::write(…settings.json…)` in production code resolve to **tests only**: `commands/agents.rs:927` is inside `#[cfg(test)] mod tests` (`fs::write(config_dir.join("settings.json"), settings_body)` — a `resolve_launch` parity fixture); `agent/harness/launch.rs:1278` is inside `#[cfg(test)]`; `agent/harness/loop/tests/policy_gate.rs:72` is the test fixture; `config.rs` test-fn writes and session_tests' `write_settings_json` helper (`session/mod.rs:2682`) are test-only. `write_settings` call sites in `agent/web/config.rs` are all test-only (`settings_fill_the_config` etc.).

So the **production** set is exactly: `save_settings` (via command), `set_config_option`'s remembered-level write, and `load_settings`'s missing-file default creation. The spec's "the desktop side owns that file — the Settings UI writes it" is *almost* true (both are desktop-side), but there are **two desktop-side producers of full-document writes on top of the UI** — the in-process remembered-level write and the boot default-write — and the frontend's Agents-modal hook goes out of its way to re-read before writing because of #2. No external process writes it.

### 5c. The in-process writer quoted verbatim (`agent/session/mod.rs`, inside `set_config_option`'s `"thought_level"` arm)

```rust
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
```

### 5d. The two frontend whole-document writers (quoted)

`useSettingsDocument.ts` (Settings page) — the "immediate-save" pattern:

```ts
      // Reads the RENDERED `settings`, exactly as `update()` did — so two patches
      // delivered inside one batch both compose from the SAME document and the
      // second save drops the first. ...
      if (settings === null) return;
      const next = { ...settings, ...changes };
      // The app-wide store (...)
      useSettings.getState().setSettings(next);
      void saveSettings(next); // the complete document
```

`useAgentOverridesWrites.ts` (Agents modal) — the re-read before write, with the load-bearing rationale naming the Rust writer:

```ts
 * A READ-MODIFY-WRITE, never composed from the store. The re-read is load-bearing,
 * not paranoia: the store's copy is seeded at boot and by the Settings page, but
 * the Rust side writes `settings.json` on its own — `agent/session/mod.rs:1678`
 * persists a remembered thinking level through `load_settings` + mutate +
 * `write_settings` — so a modal opened at an arbitrary moment can be holding a
 * stale document, and composing from the store would silently clobber a concurrent
 * change. EVERY Rust writer does load-mutate-write; this has to match or the
 * desktop becomes the one writer that can lose someone else's field.
```

```ts
async function writeAgentOverrides(
  next: AgentOverrides,
  epoch: number,
  epochRef: { current: number },
  onRolledBack: () => void,
): Promise<void> {
  ...
  const fresh = await getSettings();
  freshDocument = { ...fresh, agentOverrides: next };
  await saveSettings(freshDocument);
```

This hook also documents the ONE intra-frontend second writer that can be clobbered (the Provider-rename remap in SettingsPage) and the accepted narrow window. Both hooks' writes go through command #1.

---

## 6. Worker notification of a settings change — it isn't pushed; it is re-read

The spec's "effective next turn" claim is exactly what the tree shows. **The Supervisor never pushes a `Settings`/`file_policy` frame to the Worker.** The Worker receives only: the `StartEnv` at spawn (whose `config_dir` points at the settings dir), and `Inbound::Config { model, thinking, trusted }`, `Prompt`, `Compact`, `Close`, `PermissionResponse`, `InteractiveResponse`, `SubagentResult`, `FetchRenderResponse`, `Unknown` (the `Inbound` enum in `agent/worker/protocol.rs`, quoted in §1c's neighborhood — **there is no `Settings` variant**). The only `Config` fields are `model` / `thinking` / `trusted` — a Settings round-trip cannot carry `file_policy`.

The loop re-reads settings **once per turn** in `AgentLoop::handle_prompt` (`agent/harness/loop.rs`, quoted verbatim — the exact lines the spec cites as `loop.rs:609`):

```rust
    pub async fn handle_prompt(&mut self, prompt: &PromptTurn) {
        // (ADR 0030 Deviation 4) The policy and web config are
        // re-read from `settings.json` ONCE per turn — the same in-process read
        // `launch.rs` does per dispatch, so a user who flips a select in
        // Settings affects an ALREADY-RUNNING session at its next prompt
        // (no restart, no relaunch). ONE read per turn (not per tool call):
        // every tool call in a turn must agree, or a half-asked batch would
        // be a policy the user never chose. `config_dir: None` → the
        // all-`Allow` default (no settings layer) + env-only web config.
        let settings = self.config_dir.as_deref().map(crate::config::load_settings);
        self.file_policy = settings.as_ref().map(|s| s.file_policy).unwrap_or_default();
        self.web = crate::agent::web::config::WebConfig::from_web_settings(
            settings.as_ref().map(|s| &s.web),
        );
```

The loop's `config_dir` field doc:

```rust
    /// (ADR 0030 Task 3) The file-access policy IN FORCE for the current
    /// turn — refreshed from `settings.json` at the top of every
    /// `handle_prompt` (Deviation 4: one read per turn, so every tool call
    /// in a turn agrees and a mid-turn hand-edit is observed at the NEXT
    /// prompt; the same in-process read `launch.rs` does per dispatch).
    /// `config_dir: None` → all-`Allow` (no settings layer to read).
    /// Handed to every `ToolCtx` so the executor enforces the SAME tier the
    /// gate decided, and read by the gate itself.
    file_policy: FilePolicy,
```

The Worker gets `config_dir` at Start (`agent/worker/core.rs` building the loop): `AgentLoop::new(..., Some(std::path::PathBuf::from(&env.config_dir)), ...)`, with `env.config_dir` supplied by the Supervisor in `establish_worker_session` (`StartEnv::from_parts(..., self.config_dir.display().to_string(), ...)`; subagents inherit `parent_env.config_dir.clone()`).

The pinned proof that a file edit between prompts changes the next turn's gating (no push, no reload): `policy_gate.rs`'s `a_settings_edit_between_prompts_changes_the_next_turns_gating` — it rewrites `settings.json` *between* two prompts and asserts turn 2 gates differently ("the user edits the file BETWEEN the prompts: `ask` → `sandboxed`"; "The loop's own `config_dir` (the fixture's temp dir): re-read between the prompts, exactly as a user editing Settings would."). Described in full in §7.

**Thus the only notification path for a persisted rule is the per-turn `load_settings` re-read; nothing pushes a `settings.json` change to any Worker, live or subagent.**

---

## 7. Test inventory

### 7a. `config.rs` inline `mod tests` (`#[test]` fns, verbatim names)

| Test name | One clause each |
|---|---|
| `default_settings_are_dark_with_empty_layout` | asserts the `Settings::default()` lane (theme dark, empty pane layout, `!default_trust_new_spaces`, naming ON, …). |
| `a_pre_feature_settings_json_parses_to_the_new_defaults` | asserts an old two-key file parses with every new field at its default (covers `file_policy` implicitly — `filePolicy` absent parses to `FilePolicy::default()`). |
| `mcp_mentions_enabled_defaults_off_and_round_trips` | `#`-mention OFF by default, explicit `true` round-trips through camelCase + the real file. |
| `session_naming_settings_default_on_and_round_trip_in_camel_case` | naming ON by default (the one bool whose serde default is not `false`), overrides parse from camelCase. |
| `attention_alert_defaults_survive_a_pre_feature_file` | a pre-feature file reads alerts ON / 15 s, and `subagentDeadBoundSecs` 1800 s. |
| `spinner_style_defaults_to_none_and_round_trips` | absent key parses `None`; value survives write/read. |
| `empty_state_animation_defaults_to_none_and_round_trips` | same for the transcript animation. |
| `palette_defaults_to_none_and_round_trips` | `None` default; `"dracula"` etc. round-trips. |
| `file_policy_defaults_to_allow_in_every_direction` | **the filePolicy defaults pin** — `FilePolicy::default()` and `Settings::default().file_policy` are all-`Allow`, a no-`filePolicy` file and an empty `{}` object and a partial `{reads:"ask"}` all parse per-field (quoted fully below). |
| `file_policy_serializes_under_the_camel_case_file_policy_key` | wire key is `filePolicy` with lowercase direction values; round-trips. |
| `mcp_servers_round_trips_in_camel_case` | `mcpServers` holds pi entry shapes verbatim. |
| `default_thinking_levels_defaults_to_empty_and_round_trips` | empty map default, camelCase. |
| `subagent_models_is_read_from_camel_case_but_never_written` | legacy key still reads, `skip_serializing` keeps it off the wire. |
| `agent_overrides_default_to_an_empty_map_that_still_serializes` | empty map still serializes `{}` (required TS key) even on a pre-feature file's next save. |
| `agent_overrides_round_trip_as_a_flat_camel_case_map` | `agentOverrides` round-trips flat camelCase. |
| `an_unset_field_inside_an_override_entry_is_absent_not_null` | unset entry fields are absent, not `null`. |
| `a_legacy_subagent_models_file_folds_into_agent_overrides_on_load` | legacy `subagentModels` folds into `agentOverrides` at load when the new map is empty. |
| `a_non_empty_agent_overrides_map_wins_over_the_legacy_key_wholesale` | a hand-edited file carrying both keys: new key wins, no merge. |
| `the_legacy_subagent_models_key_never_reaches_the_file_again` | the dead key stays out of the serialized file. |
| `font_settings_default_is_noto_sans_ui_and_fira_code_code` | hand-written `Default` (no derive) gives Noto Sans / Fira Code, size 14. |
| `provider_config_api_defaults_to_openai_completions` | `ProviderConfig::default().api` is `openai-completions`. |
| `provider_config_api_and_key_url_round_trip` | api + key_url round-trip through JSON. |
| `settings_round_trip_with_the_new_fields` | the full `Settings` literal round-trips and the serialized doc enumerates every camelCase key (including `"filePolicy"`), `subagentModels` never serialized. |
| `file_policy_round_trips_through_the_settings_file` | a non-default policy survives `write_settings` → `load_settings`. |
| `load_settings_normalizes_a_blank_default_thinking_level_to_none` | hand-edited `""` level becomes `None`. |
| `load_settings_normalizes_a_blank_session_naming_model_to_none` | all-whitespace naming-model key becomes `None`. |
| `load_settings_on_a_corrupt_file_returns_the_defaults` | unparseable file → defaults, file untouched (no overwrite of the bad doc). |
| `load_settings_on_a_missing_file_writes_the_defaults` | missing file → defaults AND the file appears on disk. |
| `get_settings_never_errors` | the command-level guarantee (`load_settings` never `Err`s). |
| `settings_round_trip_through_json` | serde round-trip. |
| `web_block_defaults_to_empty_when_absent` | absent `web` block → default `WebSettings`. |
| `web_block_round_trips` | `web` block round-trips. |

`file_policy_defaults_to_allow_in_every_direction` (verbatim):

```rust
    #[test]
    fn file_policy_defaults_to_allow_in_every_direction() {
        // (ADR 0030) All three policies default to `Allow` (pi's posture — the
        // UI's "Don't ask me"). This is WIDER than the pre-feature hardcoded
        // behavior (the product decision — ADR 0030 Deviation 2), so what is pinned
        // here is the widening itself — never parity with the old behavior.
        let all_allow = FilePolicy {
            reads: AccessPolicy::Allow,
            writes: AccessPolicy::Allow,
            shell: AccessPolicy::Allow,
        };
        assert_eq!(FilePolicy::default(), all_allow);
        assert_eq!(Settings::default().file_policy, all_allow);
        // A pre-feature file (no `filePolicy` key at all) parses to the same
        // (`#[serde(default)]` — no migration).
        let pre_feature: Settings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(pre_feature.file_policy, all_allow);
        // An EMPTY `filePolicy` object parses to the same too (the
        // container-level `#[serde(default)]` fills the three fields).
        let empty_object: Settings =
            serde_json::from_value(serde_json::json!({ "filePolicy": {} })).unwrap();
        assert_eq!(empty_object.file_policy, all_allow);
        // A PARTIAL object leaves the directions the file omits at `Allow`.
        let partial: Settings =
            serde_json::from_value(serde_json::json!({ "filePolicy": { "reads": "ask" } }))
                .unwrap();
        assert_eq!(partial.file_policy.reads, AccessPolicy::Ask);
        assert_eq!(partial.file_policy.writes, AccessPolicy::Allow);
        assert_eq!(partial.file_policy.shell, AccessPolicy::Allow);
    }
```

(`FilePolicy` derives `PartialEq`, so `rules: Vec<AccessRule>` added to it with an `Eq` member changes this test's "all-Allow" assertions only if `rules` participates in `PartialEq` — it will, as a field. This is the exact test the spec's "pins an old settings.json parses to the new defaults" points at, plus `a_pre_feature_settings_json_parses_to_the_new_defaults`.)

### 7b. `session/mod.rs` — `mod session_tests` (`#[test]`/`#[tokio::test]`, verbatim names)

Helpers first (`mint_session_id_format`, `session_info_round_trips_the_archived_flag_camel_case`, `session_info_serialises_the_cost_as_cost_usd_and_keeps_zero_distinct`, `native_capabilities_advertises_image`, plus fixture helpers): not behavioral pins.

Behavioral tests:

| Test name | One clause each |
|---|---|
| `the_stalled_registry_and_the_stalled_event_agree_on_the_pid_named_log` | the crash log the router writes carries the dead Worker's pid. |
| `a_native_session_starts_with_the_remembered_level_over_the_settings_default` | a remembered (validated) thinking level beats the settings' `defaultThinkingLevel`. |
| `a_stale_remembered_level_and_an_invalid_settings_default_start_with_no_level` | a stale remembered entry and a settings default the model doesn't advertise are ignored/dropped. |
| `a_settings_default_level_applies_when_it_is_a_member_of_the_model_levels` | the settings default wins when the model advertises it. |
| `a_settings_default_level_applies_as_is_for_a_model_without_levels` | a model with no levels gets the settings default as-is. |
| `a_remembered_level_is_ignored_for_a_model_without_levels` | no levels ⇒ no remembered level. |
| `a_native_thought_level_change_remembers_the_level` | **the `write_settings`-in-`set_config_option` pin** — a thought-level change persists into `settings.defaultThinkingLevels`. |
| `a_native_empty_thought_level_change_is_rejected` | an empty level is rejected before the frame is sent. |
| `a_native_model_switch_resets_an_invalid_level_to_the_new_model_s_memory` | switching to a model that lacks the current level resets to the new model's memory. |
| `a_native_model_switch_keeps_a_valid_level` | a level the new model supports is kept across the switch. |
| `a_resume_prefers_the_remembered_level_over_the_stale_stored_value` | resume uses the remembered level over a stale stored one. |
| `list_sessions_carries_the_stored_config_options_and_context_usage` / `…_context_window_follows_the_current_catalog` / `…_keeps_its_snapshot_window` / `…_carries_the_stored_title` / `a_resume_carries_the_stored_context_usage` | the stored-row → `SessionInfo` surface. |
| `the_native_model_chain_settings_default_wins_over_the_catalog_default` | model resolution chain. |
| `refresh_model_metadata_applies_live_and_degrades_on_failure` | metadata refresh live-apply + degradation. |
| `effective_catalog_discovers_a_user_provider` / `resolve_uses_the_provider_api` / `resolve_uses_the_litellm_provider_api` / `effective_catalog_a_failed_discovery_still_shadows_the_seeded_provider` / `effective_catalog_caches_and_force_refresh_bypasses_the_cache` / `a_failed_discovery_does_not_latch_the_negative_result` | provider discovery/cache behavior on the settings file. |
| `compact_session_on_a_non_live_session_is_a_no_op` / `compact_session_sends_the_frame_and_never_marks_a_cancel` | ADR 0044 compaction semantics. |
| `session_manager_builder_cyclic_weak_reference_drops_cleanly` / `session_manager_builder_preserves_supplied_persister` | builder wiring. |

**There is NO `respond_permission` test in `session_tests`** — the relay's answer path is covered on the Worker side: `agent/worker/core.rs` `permission_response_resolves_the_pending_oneshot` (outcome rides verbatim; entry removed) and `permission_response_trust_space_flips_the_trust_source` (the `trust-space` outcome flips the `StaticTrustSource`, the "very next tool call auto-approves" half), plus `config_trusted_flips_the_trust_source`. The `respond_permission` Tauri command's miss path is asserted by its own doc ("the caller can then route a miss") — the `hit` printing lives in `commands/sessions.rs` and is not otherwise pinned. The child-answer relay is pinned by `worker/manager/tests/mod.rs`'s `an_answered_gates_card_is_not_closed_again_at_teardown`, whose comment states: "**The CHILD-side half of the answer relay — what `SessionManager::respond_permission` does next to the relay above.**" — i.e. that test manually replicates `handle_for(child_id).send_permission_response(...)` + `note_gate_answered` against the `drives` map.

### 7c. The re-read pin (`agent/harness/loop/tests/policy_gate.rs`)

`a_settings_edit_between_prompts_changes_the_next_turns_gating` — possessions quoted in §6; its doc:

```rust
/// (ADR 0030 Deviation 4 — "affects an already-running session") the
/// policy is re-read from `settings.json` at the top of EVERY prompt:
/// a settings edit BETWEEN two prompts changes the SECOND prompt's
/// gating, with no restart and no relaunch.
```

Other gate tests in that module that any rules work must keep green: `ask_beyond_the_boundary_prompts_naming_the_path_then_runs`, `sandboxed_beyond_the_boundary_errors_with_no_prompt`, `the_default_policy_reads_and_writes_beyond_the_boundary_in_silence`, `a_sandboxed_shell_dispatches_confined_with_no_prompt`, `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`, `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session` (protected-dir denial with the lenient canonicalizer — the behavior the rules layer replaces), `a_trusted_space_suppresses_the_prompt_the_policy_would_raise` (Trust suppress `Ask` at the decision point), `the_skill_tools_stay_outside_the_policy_gate`.

---

## 8. Exact scoped commands from `src-tauri/`

Per the approved spec (§Verification) and `AGENTS.md`:

- **Full gate:** `cargo test` (from `src-tauri/`) — the crate is ONE compilation unit; this builds the `archimedes` bin, the `archimedes_lib` lib, the `fake_worker` / `fake_mcp_stdio` bin fixtures (needed by the worker/session/manager tests and the integration targets that use `env!("CARGO_BIN_EXE_fake_worker")`), and the `tests/` integration targets (`ipc.rs`, `session_native.rs`, `worker_*.rs`, `harness_*.rs`, `fs_backend.rs`, `storage.rs`, …).
- **Lint (0 warnings):** `cargo clippy --all-targets`
- **Format:** `cargo fmt --check`
- **Windows type-check:** `cargo check --target x86_64-pc-windows-gnu --all-targets`
- **Scoped single-module tests** (the names in §7 live in `archimedes_lib`'s `src/` module tests):
  - `cargo test --lib config::tests::file_policy_defaults_to_allow_in_every_direction`
  - `cargo test --lib config::tests::a_pre_feature_settings_json_parses_to_the_new_defaults`
  - `cargo test --lib config::tests::file_policy_serializes_under_the_camel_case_file_policy_key`
  - `cargo test --lib agent::session::session_tests::a_native_thought_level_change_remembers_the_level` (the `write_settings`-in-`set_config_option` pin)
  - `cargo test --lib agent::worker::core::tests::permission_response_trust_space_flips_the_trust_source`
  - `cargo test --lib agent::worker::core::tests::permission_response_resolves_the_pending_oneshot`
  - `cargo test --lib agent::worker::manager::tests::an_answered_gates_card_is_not_closed_again_at_teardown`
  - `cargo test --lib agent::harness::loop::tests::policy_gate::a_settings_edit_between_prompts_changes_the_next_turns_gating`
  - `cargo test --lib agent::harness::loop::tests::policy_gate::a_gate_denial_of_a_protected_dir_uses_the_protected_wording`
  - `cargo test --lib agent::permission::tests` (the option-list / gate tests — permissions module test suite; includes the "always three options" pins the spec says change)
- **Constraint the spec records:** `cargo test --lib` alone **does not rebuild `fake_worker`** — the worker/manager/session_native tests that spawn the fake binary need `cargo test` (or a prior `cargo build --bins`) so `target/debug/fake_worker` exists.

---

## Risks & divergences the tree shows (facts, not design)

1. **Concurrent whole-file writers (no lock, no atomic write)** — §2b/§5b. The relay's rule-write shares the file with `save_settings`, the remembered-level write, the boot default-write, and two frontend hooks that save the complete document; nothing serializes them and `fs::write` is non-atomic.
2. **`PermissionOutcome::Selected` gains a required-known destructuring** — every handler/gate matches `Selected { option_id }` without `..` (relay `session/mod.rs`, Worker `core.rs`, gate `gate.rs`, numerous tests), so adding a `value` field is a compile error everywhere until each pattern is updated; the serde-default only saves the wire.
3. **The subagent path has no branch in `respond_permission`** — the spec's "the subagent manager's own `pending_*` maps" is not the tree: the maps live per-Worker; subagent answers reach the same single relay via `handle_for`'s `drives` fallback, and the child's cwd record the rule-write would need lives in `TranscriptPersister::cwd_map` (registered as the PARENT's cwd — subagents share the parent Space), not in `self.live`. The main branch's cwd lookup misses for children.
4. **`rules` does not exist yet** — `FilePolicy` is three `Copy` policy enums; adding `Vec<AccessRule>` changes its `PartialEq`/`Default`/`Copy`-ness (it stops being `Copy`), which touches the assertions quoted in §7 and the `..FilePolicy::default()` literals across the executor tests.
5. **`protected_dirs()` is currently consumed as a frozen `Vec<PathBuf>`** in the loop (`loop.rs`: "The write DENY-LIST (`boundary::protected_dirs()` …), frozen with the boundary") and enforced in the tool-exec layer (`agent/tools/exec/access.rs`'s `PROTECTED_WRITE_ROUTE` — see the gate test asserting the refusal text ends with that route) — the spec's plan to turn it into default rules replaces an existing, test-pinned deny path whose wording tests (`a_gate_denial_of_a_protected_dir_uses_the_protected_wording`, `the_skill_tools_stay_outside_the_policy_gate`) assert today's sentences.
6. **There are two stale doc-duplicates** (the doubled `respond_permission` doc block) that already drift from the code.

## Sources

- `src-tauri/src/agent/session/mod.rs` — `respond_permission` (relay, `trust-space` persistence), `respond_interactive_request` (relay twin), `set_config_option` (the remembered-level `write_settings` production writer), `SessionDriver`, `LiveWorkerSession`, `establish_worker_session` (`StartEnv` construction).
- `src-tauri/src/commands/sessions.rs` — the `respond_permission` Tauri command (single-route, `hit` printing).
- `src-tauri/src/commands/settings.rs` — `get_settings` / `save_settings` commands.
- `src-tauri/src/config.rs` — `Settings`, `write_settings`, `load_settings`, `settings_path`, inline tests.
- `src-tauri/src/agent/policy.rs` — `FilePolicy`, `AccessPolicy`, `decision_for`.
- `src-tauri/src/agent/permission.rs` — `PermissionOutcome`, `PendingPermissions`, `permission_key`, `native_permission_gate` (three-option emit).
- `src-tauri/src/agent/worker/core.rs` — `PendingPermissions`/`pending_bridge`/`pending_sudo` maps, `Inbound::PermissionResponse` handler (trust flip), `AgentLoop::new(... Some(config_dir) ...)`, worker tests.
- `src-tauri/src/agent/worker/manager/mod.rs` + `registry.rs` + `tests/mod.rs` — `handle_for` / `get_handle_for` (`workers` → `drives` fallback), `note_gate_answered`, `send_config_to_space`; the child-answer relay test.
- `src-tauri/src/agent/worker/manager/subagent_flow.rs` — child `StartEnv` (cwd = parent's), `register_child_cwd(&child_id, &wire.parent_cwd)`, `SubagentDrive`.
- `src-tauri/src/agent/harness/loop.rs` + `loop/gate.rs` + `loop/tests/policy_gate.rs` — per-turn re-read of `settings.json`, `file_policy` field, `gate_tool` accept set, the Deviation-4 pin and protected-dir pins.
- `src-tauri/src/agent/persist.rs` — `TranscriptPersister::set_cwd` (the child-cwd record).
- `src-tauri/src/storage/db.rs` — `set_space_trusted`, `space_trusted`, `upsert_space`, `spaces` table + `trusted` migration.
- `src-tauri/src/lib.rs` — `setup_dirs` wiring, `settings.json` home dirs, command registration.
- `src-tauri/Cargo.toml` — single-crate layout, `archimedes_lib` lib, autobins fixtures.
- `src/hooks/useSettingsDocument.ts`, `src/hooks/useAgentOverridesWrites.ts`, `src/lib/tauri/commands/settings.ts`, `src/lib/tauri/types.ts`, `src/components/PermissionPrompt.tsx`, `src/hooks/useChildGates.ts`, `src/store/permissions.ts` — the frontend writers and the prompt echo surface.
- `docs/roadmap/permissions-section.md` (the approved spec), `AGENTS.md` (test/lint commands).
