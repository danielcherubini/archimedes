# Grounding report — Supervisor relay & settings persistence (T04 area, RE-GROUNDING)

**Tree:** `feature/permissions-section` at `4395bed` (`docs: mark permissions-section wave 2 done; record barrel-pin breakage`). Waves 1–2 landed (T01 `AccessRule`/`FilePolicy.rules`/`default_rules`; T02 `Selected { option_id, value }` + per-prompt option lists + the `..` destructure in the relay; T06 the Settings Permissions section + `saveRule`/`removeRule`/`savePolicy`).

**Scope:** `src-tauri/src/agent/session/mod.rs`, `src-tauri/src/config.rs`, `src-tauri/src/storage/db.rs`, plus every `settings.json` writer in the crate and the Worker-side entry points the relay touches. Everything quoted is what EXISTS at `4395bed`. No recommendations, no proposed patch.

---

## 1. `respond_permission` NOW (session/mod.rs)

### 1a. Signature + docs (verbatim)

```rust
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

Body (verbatim, all of it):

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
                //
                // The `..` here is the ONLY thing Task 2 (the outcome's `value`
                // field) changed in this file: `value` is READ nowhere yet — the
                // `allow-directory` rule write rides it, and the relay that
                // persists that rule is Task 4's.
                if let permission::PermissionOutcome::Selected { option_id, .. } = &outcome {
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

### 1b. `..` comment and where an `allow-directory` branch goes

The `..` in the `if let permission::PermissionOutcome::Selected { option_id, .. } = &outcome` is present, with the T02 comment (quoted in 1a): “`value` is READ nowhere yet — the `allow-directory` rule write rides it, and the relay that persists that rule is Task 4's.”

The natural landing spot for a `value`-carrying `allow-directory` branch is the SAME `if let … Selected { option_id, .. }` block, immediately after the `if option_id == "trust-space"` arm — i.e. the current `trust-space` persistence arm is the exact template. Guards that branch would have:

- **`self.driver.db`** — the trust-space arm touches it via `(&self.driver.db, cwd)`; `self.driver` is present (the `driver.db: Option<Arc<Db>>` field is the persistence half's handle). BUT the `settings.json` write path needs NO db — it needs `self.config_dir` (the same field the `cwd` lookup already uses; `config_dir: PathBuf` — `write_settings(&self.config_dir, …)` is already called inside `set_config_option`, see §4). **Caveat: `SessionManager` in `session/mod.rs` has `config_dir`; the Worker does not** — this is precisely why the relay (Supervisor-side) owns the write, per the ADR 0025 split.
- **`cwd`** — the `Option<PathBuf>` local captured before the `handle_for` lookup: `cwd` is `Some` iff the session is in the `live` map (a started main session). It is moved into the `if let (Some(db), Some(cwd))` — a T04 `allow-directory` write that needs `cwd` must capture/borrow before this move or restructure the destructure. (For `allow-directory` the path to persist comes from `outcome.value`, NOT from `cwd`; `cwd` is only relevant if the rule's path should default to the session cwd when `value` is missing.)
- **`wm.handle_for` guard** — already passed (the `else` returns `Ok(false)`); the persistence arms run only on the `Ok(())` send success, exactly like `trust-space`.

### 1c. Subagent routing fact — RE-VERIFIED, still holds after T02

No separate subagent branch exists in `respond_permission`. There is exactly ONE `handle_for` entry — the compound-key lookup — and children ride the same relay.

`handle_for` — `src-tauri/src/agent/worker/manager/mod.rs` (verbatim, doc + body):

```rust
    /// The session's `WorkerHandle` (a clone) — `None` when the session is not
    /// attached (or was already reaped). The `SessionManager` uses this to relay
    /// frames (prompt / config / abort / responses) to the session's Worker.
    /// The `drives` fallback (ADR 0025 Task 5 — the `dispatch_native` re-plumb):
    /// a SUBAGENT session's handle is in the `drives` map (the in-flight
    /// dispatchs — the subagent's pending maps live in its Worker; the
    /// `respond_*` commands route through this lookup — main AND subagent
    /// sessions both resolve).
    pub fn handle_for(&self, session_id: &str) -> Option<WorkerHandle> {
        self.state.get_handle_for(session_id)
    }
```

`get_handle_for` — `src-tauri/src/agent/worker/manager/registry.rs` (verbatim):

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

- Main session → found in the `workers` map; subagent → falls through to the `drives` map. Both resolve through the SAME `respond_permission` body.
- The manager-side proof (`src-tauri/src/agent/worker/manager/tests/mod.rs`, `an_answered_gates_card_is_not_closed_again_at_teardown`): the child's answer routes via `manager.handle_for(&child_id)` + `send_permission_response`, i.e. “the response routes to the CHILD's handle — `handle_for` resolves the `drives` map's entry”.
- **Caveat for the T04 design**: the `cwd` local is looked up from `self.live` (MAIN sessions only — a child never has a `live` entry here). If the relay's `allow-directory` write needs the cwd, it is `None` on the child path; the path from `value` is the only child-safe input. Also `note_gate_answered(session_id, request_id)` runs for BOTH main and child (the child arm is the no-op for main); a T04 persistence branch inside this `Ok(())` arm inherits the same shape.

---

## 2. `config.rs` NOW

### 2a. `Settings` struct — verbatim (the whole struct, `src-tauri/src/config.rs:159`)

```rust
/// The persisted app settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// `"system" | "dark" | "light"` (default `"dark"`).
    #[serde(default = "default_theme")]
    pub theme: String,
    /// (ADR 0027) The color scheme: `"zai" | "dracula"`. `None` = `"zai"` (a
    /// pre-feature file — `#[serde(default)]`, no migration). Orthogonal to
    /// `theme` (the light/dark mode): we ship Dracula's dark variant only (a
    /// scope decision), so `dracula` PINS the app dark and the mode is ignored
    /// — the spec's light reading, Alucard Classic, is deferred, not impossible.
    #[serde(default)]
    pub palette: Option<String>,
    /// Free-form pane layout state (owned by the frontend).
    #[serde(default)]
    pub pane_layout: Value,
    /// Whether to trust new Spaces by default.
    #[serde(default)]
    pub default_trust_new_spaces: bool,
    /// Whether the composer's `#` MCP-server mention is live (ADR 0031's
    /// follow-up). `#[serde(default)]` = `false`, so a pre-feature
    /// `settings.json` ships `#` OFF: `#` is the one mention prefix that
    /// collides with pasted text (`#include`, `#123`, `#hashtag` all match
    /// the token grammar), so it is opt-in while `$` and `@` are always on.
    /// Gates the TRIGGER only — the display side still parses a persisted
    /// `<mcp>` block, and the MCP catalog command stays available.
    #[serde(default)]
    pub mcp_mentions_enabled: bool,
    /// (ADR 0030) The per-direction file-access policies. `#[serde(default)]`
    /// — a pre-feature file parses to `FilePolicy::default()` (all `Allow`),
    /// so no migration runs. NOTE: that default is WIDER than the pre-feature
    /// hardcoded behavior — out of the box a session reads and writes anywhere
    /// and runs `bash` with no prompt, including in an untrusted Space (this
    /// makes ADR 0010's prompt opt-in). Intentional; see ADR 0030 Deviation 2.
    #[serde(default)]
    pub file_policy: FilePolicy,
    /// The web tools' configuration (ADR-less; see `docs/roadmap/web-search-and-fetch.md`).
    /// `#[serde(default)]` — a pre-feature file parses to `WebSettings::default()`
    /// (all empty ⇒ only the keyless `duckduckgo` Search provider is available).
    #[serde(default)]
    pub web: WebSettings,
    /// `"provider/id"`; `None` = system default.
    #[serde(default)]
    pub default_model: Option<String>,
    /// The per-app thinking-level seed (the native session start's last
    /// rung: remembered > stored > this > `None`); `None` = the model's
    /// own default. `#[serde(default)]` — a pre-feature file parses to
    /// `None` (no migration needed).
    #[serde(default)]
    pub default_thinking_level: Option<String>,
    /// The harness-level tool filter: `[]` = all tools enabled (the native
    /// `AgentLoop` maps an empty list to `None` = all). `#[serde(default)]`
    /// — a pre-feature file parses to `[]` (no migration needed).
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    /// User-managed providers (default `[]`).
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    /// (ADR 0019) The user-managed MCP servers: `name → entry` in pi's
    /// `mcpServers` entry shape VERBATIM (an entry copy-pastes between the
    /// two files). Merged into the harness's effective set at global
    /// precedence (project > desktop > pi-global). `#[serde(default)]` —
    /// a pre-feature file parses to `{}` (no migration).
    #[serde(default)]
    pub mcp_servers: HashMap<String, Value>,
    /// Font settings.
    #[serde(default)]
    pub font: FontSettings,
    /// (ADR 0015) The per-model remembered thinking level: the composed
    /// model key (`"<provider>/<id>"`) → the last EXPLICITLY chosen level.
    /// `#[serde(default)]` — a pre-feature file parses to an empty map.
    #[serde(default)]
    pub default_thinking_levels: HashMap<String, String>,
    /// (ADR 0023 — RETIRED by ADR 0066) The per-agent subagent model map:
    /// agent name → model key. READ-ONLY from here on — `load_settings` folds
    /// its values into [`Settings::agent_overrides`] and clears it, and
    /// `skip_serializing` (UNCONDITIONAL, not `skip_serializing_if =
    /// "HashMap::is_empty"`) is what makes the dead key disappear from the
    /// file on the next save, permanently. ...
    #[serde(default, skip_serializing)]
    pub subagent_models: HashMap<String, String>,
    /// (ADR 0066) Global Agent overrides keyed by agent NAME ...
    #[serde(default)]
    pub agent_overrides: HashMap<String, AgentOverrideFields>,
    /// The working-indicator spinner style (the `braille-loader` variant name,
    /// e.g. `"typing"` / `"pendulum"`): the animation the chat's top working
    /// indicator runs while the agent is busy. `None` = the frontend's
    /// `typing` default (a pre-feature file — `#[serde(default)]`, no
    /// migration).
    #[serde(default)]
    pub spinner_style: Option<String>,
    /// The **Transcript**'s empty-state animation: `"off"` / `"static"` /
    /// `"animated"`. `None` = the frontend's `"animated"` default ...
    #[serde(default)]
    pub empty_state_animation: Option<String>,
    /// Session naming (ported from pi-archimedes' `session-name`): the master
    /// switch for the post-first-exchange title request. `#[serde(default =
    /// "default_true")]` — pi ships naming ON ...
    #[serde(default = "default_true")]
    pub session_naming_enabled: bool,
    /// The model used for title generation: the composed key
    /// (`"provider/id"`, or a hand-edited `"provider/id:<level>"`). `None` /
    /// blank = the session's own model (pi's `model` setting).
    #[serde(default)]
    pub session_naming_model: Option<String>,
    /// The thinking level for the title request. ...
    #[serde(default)]
    pub session_naming_reasoning: Option<String>,
    /// Attention alerts (ADR 0038/0039): ...
    #[serde(default = "default_true")]
    pub attention_alerts_enabled: bool,
    /// The delay between an attention trigger and the alert, in SECONDS. ...
    #[serde(default = "default_attention_delay_secs")]
    pub attention_alert_delay_secs: u64,
    /// The ADR 0055 **Dead bound**: SECONDS a **Subagent session** may stay
    /// silent with no tool execution outstanding before it is reaped as Dead. ...
    #[serde(default = "default_subagent_dead_bound_secs")]
    pub subagent_dead_bound_secs: u64,
}
```

(`Settings::default()` — verbatim: `theme: "dark"`, `palette: None`, `pane_layout: Value::Object(Default::default())`, `default_trust_new_spaces: false`, `mcp_mentions_enabled: false`, `file_policy: FilePolicy::default()`, `web: WebSettings::default()`, `default_model: None`, `default_thinking_level: None`, `enabled_tools: Vec::new()`, `providers: Vec::new()`, `mcp_servers: HashMap::new()`, `font: FontSettings::default()`, `default_thinking_levels: HashMap::new()`, `subagent_models: HashMap::new()`, `agent_overrides: HashMap::new()`, `spinner_style: None`, `empty_state_animation: None`, `session_naming_enabled: true`, `session_naming_model: None`, `session_naming_reasoning: None`, `attention_alerts_enabled: true`, `attention_alert_delay_secs: default_attention_delay_secs()`, `subagent_dead_bound_secs: default_subagent_dead_bound_secs()`.)

### 2b. `FilePolicy` (T01 declaration, `src-tauri/src/agent/policy.rs:79` — verbatim)

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilePolicy {
    pub reads: AccessPolicy,
    pub writes: AccessPolicy,
    /// `bash`. Defaults to `Allow` like the others — so this field alone
    /// removes the ADR 0010 untrusted-Space prompt for `bash` unless the
    /// user sets it back to `Ask`. That is the intended product posture
    /// (pi gates nothing), not a bug to "fix" back to `Ask`.
    pub shell: AccessPolicy,
    /// User rules (`path` may lead with `~`). Serde-defaulted: an old
    /// `settings.json` without the key still parses; an EMPTY list is not
    /// serialized, so the three-direction wire shape is byte-identical to
    /// today (keeps `file_policy_serializes_its_three_directions_in_camel_case`
    /// and the config.rs `contains` pins passing unchanged).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<AccessRule>,
}
```

`AccessRule` (policy.rs:66, verbatim):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRule {
    pub path: String,
    pub direction: RuleDirection,
    pub decision: RuleDecision,
}
```

`RuleDirection` (policy.rs:33): `Read`, `Write`, `ReadWrite` — `#[serde(rename_all = "lowercase")]` (`covers` helper: `matches!(self, RuleDirection::ReadWrite) || self == direction`). `RuleDecision` (policy.rs:56): `Allow`, `Deny` — lowercase wire.

### 2c. `write_settings` — verbatim (`config.rs:486`)

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

`settings_path`: `config_dir.join("settings.json")`.

### 2d. The four `FilePolicy` literals T01 touched — CURRENT bodies

All carry `rules: Vec::new()`:

1. `file_policy_defaults_to_allow_in_every_direction` (`config.rs:965`):
```rust
        let all_allow = FilePolicy {
            reads: AccessPolicy::Allow,
            writes: AccessPolicy::Allow,
            shell: AccessPolicy::Allow,
            rules: Vec::new(),
        };
```
2. `file_policy_serializes_under_the_camel_case_file_policy_key` (`config.rs:997`):
```rust
            file_policy: FilePolicy {
                reads: AccessPolicy::Sandboxed,
                writes: AccessPolicy::Ask,
                shell: AccessPolicy::Allow,
                rules: Vec::new(),
            },
```
The pin's assertion now: `json.contains(r#""filePolicy":{"reads":"sandboxed","writes":"ask","shell":"allow"}"#)` — i.e. it still pins the EMPTY-rules wire shape (an empty `rules` list is `skip_serializing_if`'d away, so this exact substring holds).
3. `settings_round_trip_with_the_new_fields` (`config.rs:1409`): same `Sandboxed/Ask/Allow, rules: Vec::new()` literal.
4. `file_policy_round_trips_through_the_settings_file` (`config.rs:1475`):
```rust
            file_policy: FilePolicy {
                reads: AccessPolicy::Sandboxed,
                writes: AccessPolicy::Ask,
                shell: AccessPolicy::Allow,
                rules: Vec::new(),
            },
```
round-trip through a REAL file via `write_settings(dir.path(), &settings)` → `load_settings(dir.path())`.

Also: `agent/tools/exec/tests/policy.rs` (`:141`, `:208`, `:277`, `:471`, `:546`), `agent/tools/sandbox.rs` (`:897`, `:1547`, `:1720`, `:1756`) build `FilePolicy { …, rules: Vec::new() }` literals. And `agent/tools/exec/tests/policy.rs` has a `file_policy: FilePolicy {` at 141 etc.

### 2e. The pre-feature parse pin's CURRENT body — does it need a `rules`-absent leg now?

`a_pre_feature_settings_json_parses_to_the_new_defaults` (`config.rs:686`) — CURRENT body (verbatim):

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
        // (ADR 0031 follow-up) `#` ships OFF: ...
        assert!(!settings.mcp_mentions_enabled);
        // Session naming is the opposite case: it ships ON, ...
        assert!(settings.session_naming_enabled);
        assert_eq!(settings.session_naming_model, None);
        assert_eq!(settings.session_naming_reasoning, None);
    }
```

**It has NO `rules` assertion today** — it does not check `file_policy` at all beyond the odometer of defaults already pinned. The `rules`-absent-leg coverage lives SEPARATELY in `agent/policy.rs` (see §6): `file_policy_without_a_rules_key_parses_with_rules_empty` (partial object AND `{}` → `rules` empty) and `an_empty_rules_list_stays_out_of_the_wire_format` (empty list serializes to the exact 3-direction bytes `{"reads":"allow","writes":"allow","shell":"allow"}`).

**So: no, the pre-feature pin does not strictly NEED a new `rules`-absent leg** — the serde `#[serde(default)]` on `FilePolicy` + the field-level `#[serde(default, skip_serializing_if = "Vec::is_empty")]` already cover the absent-key file through load (and the policy.rs back-compat pins hold that explicitly). It is exactly the same story as every other `#[serde(default)]` field in this file: `{ "theme": "dark", "paneLayout": {} }` parses, `file_policy` absent → `FilePolicy::default()` → `rules` empty. (Whether T04 WANTS to extend the pin to name `rules` is a plan decision, not a correctness gap.)

### 2f. What `load_settings` does when the file lacks `rules`

It parses to `FilePolicy::default()`'s `rules: []` — the container-level `#[serde(rename_all = "camelCase", default)]` on `FilePolicy` fills `reads`/`writes`/`shell` (to `Allow`) and the field-level default fills `rules` (`Vec::new()`). Root cause path: `load_settings` — **missing file → writes defaults + returns them; unreadable/corrupt → `Settings::default()` + `eprintln!`; parseable → `serde_json::from_str::<Settings>(&raw)`** (verbatim). A file carrying `"filePolicy": {}` also parses to the same default (pinned in `file_policy_defaults_to_allow_in_every_direction`: `empty_object`/`partial` legs). So a settings.json WITHOUT `rules` loads fine and a subsequent whole-document save keeps `rules` absent (the `skip_serializing_if`), unless something appends a rule first.

---

## 3. The read-modify-write hazard — precisely, and every `settings.json` writer after waves 1–2

### The hazard, stated narrowly

The relay (T04) must append ONE `allow-directory` rule to `settings.json`. The current write path is `write_settings(config_dir, &Settings)` — a whole-document `fs::write` that OVERWRITES the file, with NO re-read inside it and NO serialization:

- `fs::write` is non-atomic (truncate + write; no temp-file+rename — verified: `grep` for `fs::rename`/`fs::copy`/`atomic`/`tempfile` in `config.rs` has ZERO hits in production code).
- There is NO lock around settings I/O anywhere: no mutex in `config.rs`; `SessionManager` holds many `StdMutex`/`tokio::sync::Mutex` fields but NONE protects `settings.json` (see the field list in §1; `config_state`, `discovery_cache`, `naming`, `live` are for other state).
- The frontend's whole-document `save_settings` writes the file from whatever document the webview holds — a document loaded BEFORE the relay's append, or composed from a stale store, silently clobbers the appended rule on the next Settings-page save.

The ONLY existing guard against this class is a FRONTEND one, and it deliberately does NOT cover the relay: `useAgentOverridesWrites` (`src/hooks/useAgentOverridesWrites.ts`) serializes its own writes with a promise queue + does a fresh `getSettings()` re-read before each `saveSettings` — but that guard exists for the Agents-modal/`agentOverrides` writer only, and its own doc-comment (quoted below) STATES that every Rust writer does load-mutate-write and that the desktop as a whole has no shared lock:

> “A READ-MODIFY-WRITE, never composed from the store. The re-read is load-bearing, not paranoia: the store's copy is seeded at boot and by the Settings page, but the Rust side writes `settings.json` on its own — `agent/session/mod.rs:1678` persists a remembered thinking level through `load_settings` + mutate + `write_settings` — so a modal opened at an arbitrary moment can be holding a stale document, and composing from the store would silently clobber a concurrent change. EVERY Rust writer does load-mutate-write; this has to match or the desktop becomes the one writer that can lose someone else's field.”

So the ANSWER to “what exists to serialize these?” is: **nothing backend-wide; the frontend serializes only its own Agents-modal queue (and `useSettingsDocument.patch` explicitly does NOT — “orders concurrent writes: not at all”, per the hook's contract table).** A relay append therefore follows the established de-facto protocol — read-modify-write with a fresh `load_settings` — and still races a Settings-page whole-document save that was composed from stale state.

### Every current writer of `settings.json` (after waves 1–2; six Rust sites + two frontend paths)

**Rust (production code):**
1. `config.rs::write_settings` — the single serialization point: `fs::write(path, to_string_pretty(settings))`.
2. `config.rs::load_settings` — writes the DEFAULTS on a MISSING file (`fs::write(&path, json)`; logged failure, returns defaults). This is a `settings.json` **creator**, not a rewriter.
3. `commands/settings.rs::save_settings` — verbatim:
```rust
#[tauri::command]
pub async fn save_settings(
    state: State<'_, Arc<SessionManager>>,
    settings: Settings,
) -> Result<(), SettingsError> {
    write_settings(state.config_dir(), &settings).map_err(SettingsError::SaveFailed)
}
```
4. `agent/session/mod.rs::set_config_option` — the remembered-thinking-level write (verbatim):
```rust
                // (ADR 0015) Remember the level for the session's CURRENT model
                // (best-effort: a write failure is logged and does NOT fail the config
                // change — the level is applied in the loop either way; ...
                let key = ModelKey::from(&state.model).to_string();
                let mut settings = load_settings(&self.config_dir);
                settings
                    .default_thinking_levels
                    .insert(key, value.to_string());
                if let Err(e) = write_settings(&self.config_dir, &settings) {
                    eprintln!("remembered thinking level: save failed: {e}");
                }
```
5. `agent/web/config.rs` — 8 test-only `write_settings` calls.
6. Test fixtures: `session/mod.rs` (`write_settings_json`, `write_settings_default_model`, `write_settings_provider_api`), `harness/launch.rs:1278`, `commands/agents.rs:927`, `loop/tests/policy_gate.rs` — all `std::fs::write(config_dir.join("settings.json"), …)` in TESTS, not production writers.

(Hand-written `settings.json` is also an implicit writer for the whole class — “hand-editing `settings.json`” is quoted in `commands/agents.rs:53`.)

**Frontend (T06's new paths — all funnel through `save_settings` → writer #3):**
- `src/components/settings/SettingsPage.tsx::saveRule` (verbatim):
```ts
  const saveRule = (rule: AccessRule, replaces?: AccessRule) => {
    if (settings === null) return;
    const rules = settings.filePolicy?.rules ?? [];
    const index = replaces === undefined ? -1 : rules.indexOf(replaces);
    update({
      filePolicy: {
        ...settings.filePolicy,
        rules:
          index === -1
            ? [...rules, rule]
            : rules.map((r, i) => (i === index ? rule : r)),
      },
    });
    setRulesDialog(null);
  };
```
- `removeRule` (verbatim):
```ts
  const removeRule = (rule: AccessRule) => {
    if (settings === null) return;
    const rules = settings.filePolicy?.rules ?? [];
    update({
      filePolicy: {
        ...settings.filePolicy,
        rules: rules.filter((r) => r !== rule),
      },
    });
  };
```
- `PermissionsSection.tsx::savePolicy` — passes `(value) => savePolicy("reads", value)` etc. through the same `update` whole-document path.
- `update` is `useSettingsDocument`'s `patch` (`src/hooks/useSettingsDocument.ts`, verbatim tail):
```ts
      const next = { ...settings, ...changes };
      useSettings.getState().setSettings(next);
      void saveSettings(next); // the complete document
```
Its doc-comment (quoted in the hook): “composes from the store, writes the whole document, never re-reads, and has no rollback.” The `saveRule` comment itself names the hazard: “Composes over the RENDERED `settings`, not a ref — the two-write interleave pin in `SettingsPage.test.tsx` makes that window observable.”

So a relay append races: the Settings page (whole-document via `save_settings`), the remembered-thinking-level write (`session/mod.rs:1744`), and any other frontend-originated whole-document save. **Nothing serializes them.**

---

## 4. What `value` contains at the wire — the dependency chain gate → option.path → UI echo → relay → rule

### Today's truth: the gate EMITS A `""` PLACEHOLDER, not a real path

`permission_options` (`src-tauri/src/agent/permission.rs:146`) — verbatim, the whole function:

```rust
pub(crate) fn permission_options(boundary: bool) -> Vec<serde_json::Value> {
    if boundary {
        vec![
            json!({ "optionId": "allow", "name": "Allow", "kind": "allow" }),
            json!({ "optionId": "reject", "name": "Block", "kind": "reject" }),
            json!({
                "optionId": "trust-space",
                "name": "Don't ask again for this Space",
                "kind": "allow"
            }),
        ]
    } else {
        vec![
            json!({ "optionId": "allow", "name": "Allow once", "kind": "allow" }),
            // THE guard's distinctive option: `allow-directory` carries the
            // resolved path as `path` (echoed back by the frontend as the
            // outcome's `value`). `""` is a PLACEHOLDER — the real
            // nearest-existing-ancestor path is computed at the guard's call
            // site (Task 3), whose prompt signature carries the target path
            // that `native_permission_gate`'s does not.
            //
            // `trust-space` is DELIBERATELY ABSENT here. ...
            json!({
                "optionId": "allow-directory",
                "name": "Always allow this directory",
                "path": "",
                "kind": "allow"
            }),
            json!({ "optionId": "reject", "name": "Block", "kind": "reject" }),
        ]
    }
}
```

**`permission_options(false)` emits `"path": ""` — a placeholder — today.** The comment names the substitution point: “the real nearest-existing-ancestor path is computed at the guard's call site (Task 3), whose prompt signature carries the target path that `native_permission_gate`'s does not.”

### Who calls it today

- `permission_options(true)` — called by `native_permission_gate` (`permission.rs:254`) and `gate_tool`'s seam (`permission.rs:675`). The boundary gate.
- `permission_options(false)` — **NO caller anywhere in `src-tauri/src` outside `permission.rs` itself** (grep for `permission_options(false)` across the crate: zero hits outside the unit tests `a_guard_prompt_offers_exactly_allow_allow_directory_reject_and_no_trust_space` at `permission.rs`). T03 is the guard's caller that will call it for real.

The test that pins the present shape (`permission.rs:697`, verbatim salient):
```rust
        assert!(
            options[1].get("path").is_some(),
            "`allow-directory` carries the `path` key (the placeholder the \
             guard's call site replaces with the resolved ancestor — Task 3)"
        );
```
and `a_boundary_prompt_emits_the_old_three_options_with_trust_space` asserts the boundary list carries NO `path` key at all: `assert!(options.iter().all(|o| o.get("path").is_none()));`.

### The UI echo (T02's frontend half) — verbatim

`src/components/PermissionPrompt.tsx` (the `respond` builder inside the option buttons):
```tsx
            onClick={() =>
              respond({
                selected: {
                  option_id: option.optionId,
                  // The guard's `allow-directory` option carries `path`; echo it
                  // back as `value`. An option WITHOUT one emits the OLD payload
                  // shape (no `value` key at all) so boundary prompts stay
                  // byte-identical on the wire.
                  ...(option.path !== undefined ? { value: option.path } : {}),
                },
              })
            }
```
Frontend test pin (`PermissionPrompt.test.tsx:104,146-153`): the guard payload echoes the path back as `value` — e.g. `selected: { option_id: "allow-directory", value: "~/.pi/agent" }`.

### The wire model (`PermissionOutcome`, permission.rs:53 — verbatim)

```rust
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    Selected {
        option_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    Cancelled,
}
```
Doc: “`value` is the option's payload (`path` for `allow-directory`)… `None` omits the key on the wire — byte-identical to today's `{"selected":{…}}`”. Round-trip pin: `before_value_selected_still_deserializes` (old shape → `value: None`), `a_selected_without_value_serializes_without_the_key`, and the new shape round-trips with a `value`. The worker-protocol crate-wide pin (`worker/protocol.rs:557-565`) already carries a real `allow-directory` value through the wire: `value: Some("/home/u/.pi/agent/agents".to_string())` in the inbound round-trip fixture.

The Worker's `PermissionResponse` handler echoes the outcome VERBATIM to the gate's oneshot (`core.rs:617-628`): no path transformation — `tx.send(outcome.clone())`. `commands/sessions.rs::respond_permission` passes `outcome` untouched (see §7). So the relay's `value` is EXACTLY what the UI echoed, which is EXACTLY the option's `path` field.

### THE DEPENDENCY CHAIN (precise, for T04)

1. T03 (NOT landed) computes the nearest-existing-ancestor path at the guard call site and replaces the `""` placeholder in the emitted option's `path`.
2. `PermissionPrompt` echoes `option.path` back as `selected.value` (or omits `value` when `path === undefined`).
3. `respond_permission` receives `PermissionOutcome::Selected { option_id: "allow-directory", value: Some(<echoed path>) }`.
4. T04's relay persists ONE rule from `value`.

**THE GAP:** until T03 lands, step 1 produces `""` — so today a user clicking “Always allow this directory” would echo `""` as `value`, and a T04 persistence of that would write `AccessRule { path: "", … }` — garbage (an empty-string rule matches nothing via `rule_for`, but it still pollutes the file and the Settings list). T04 must either (a) refuse to persist when `value` is `None`/empty/blank, or (b) depend explicitly on T03 having landed first. The `permission_options(false)` doc already assigns the path computation to T03; nothing in the current tree computes a real path. **Pinning this in a T04 test requires a synthetic `PermissionOutcome` with a `Some(path)` (the relay cannot currently be driven end-to-end with a real path, because no caller emits `permission_options(false)` yet).**

Also note: the guard's `path` and the default-rule paths are SPELLING-sensitive for the rule's match semantics — `rule_for` canonicalizes leniently at match time and ties go last-wins (`default_rules()` first, user rules appended; §6d). A relay rule with a `~`-leading path is expanded only at match time (policy.rs:66 doc: “Stored as the user wrote it — a leading `~` is expanded to the home dir at MATCH time”).

---

## 5. `db.rs` — the persistence model

`set_space_trusted` (`src-tauri/src/storage/db.rs:1027`) — verbatim (doc + body):

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

Context: `space_key` canonicalizes (falls back to the raw string); the `spaces` table lives in the same `Db` (SQLite, `conn: Mutex<...>` per operation). The other trust-side methods: `upsert_space(path, default_trusted)` (INSERT … `ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at` — the conflict branch never touches `trusted`; used by the Supervisor at session start/resume with `load_settings(&self.config_dir).default_trust_new_spaces`), `space_trusted(cwd)` (SELECT `trusted`, `unwrap_or(false)` fail-closed), `list_spaces`.

The `trust-space` relay arm calls it exactly like the permission.rs tests do: `db.set_space_trusted(&cwd.display().to_string(), true)`.

**Rules-adjacent: nothing.** `grep -i rules` over `storage/db.rs` → zero hits. `AccessRule` / `FilePolicy` / `rule_for` exist only in `agent/policy.rs` + `agent/boundary.rs` (which derives `protected_dirs` from `default_rules()` at boundary.rs:180). Rules are NOT persisted in SQLite anywhere — settings.json is their store (via `FilePolicy.rules`), and the T04 persistence model therefore is `config.write_settings`, NOT a `Db` method. (`Db` has no settings access; the Supervisor reaches it via `self.driver.db`.)

---

## 6. Test inventory

### 6a. `config.rs` inline tests relevant to rules / round-trip (after T01)

- `file_policy_defaults_to_allow_in_every_direction` — default (all `Allow` + `rules: Vec::new()`), pre-feature and empty-object and partial parses.
- `file_policy_serializes_under_the_camel_case_file_policy_key` — the exact `"filePolicy":{"reads":"sandboxed","writes":"ask","shell":"allow"}` substring pin (empty rules omitted).
- `settings_round_trip_with_the_new_fields` — serialized DOCUMENT key set includes `"filePolicy"`; round-trips back.
- `file_policy_round_trips_through_the_settings_file` — `write_settings` → `load_settings` on a REAL temp dir, non-default policy.
- The pre-feature pins (`a_pre_feature_settings_json_parses_to_the_new_defaults`, `attention_alert_defaults_survive_a_pre_feature_file`, `subagent_dead_bound_secs_defaults_to_1800`) — none assert `rules` directly (see §2e).

### 6b. Rule-level tests (T01, in `agent/policy.rs`, NOT config.rs)

- `file_policy_without_a_rules_key_parses_with_rules_empty` — the back-compat half.
- `an_empty_rules_list_stays_out_of_the_wire_format` — exact bytes `{"reads":"allow","writes":"allow","shell":"allow"}`.
- `a_populated_rules_list_serializes_inside_the_file_policy_object` — wire sample `{"reads":"allow","writes":"allow","shell":"allow","rules":[{"path":"~/.pi/agent","direction":"read","decision":"deny"}]}`.
- `rule_for` suite + THE T04-relevant pin `an_exact_tie_goes_to_the_last_rule_so_an_appended_allow_beats_a_default_deny` (defaults-first/append contract, pinned in BOTH orders) + `a_rule_naming_a_directory_that_does_not_exist_yet_matches_leniently` + `an_empty_rule_set_matches_nothing_so_the_posture_select_decides` (in boundary.rs).

### 6c. Worker-side `permission_response_*` tests T02 touched (`agent/worker/core.rs`)

- `permission_response_resolves_the_pending_oneshot` — `Selected { option_id: "allow", value: None }` resolves the oneshot with the outcome VERBATIM and removes the map entry (fixtures: `stub_core()`, `test_env(StartMode::Fresh, None, None)`, seeded `pending_permissions` at `permission_key("s1","r1")`).
- `permission_response_trust_space_flips_the_trust_source` — `Selected { option_id: "trust-space", value: None }` → `core.trust_source().is_trusted(Path::new("/x"))` flips true. **THE closest existing trust-space test shape** (it drives the Worker-side flip half; the Supervisor-side `db` half is what the relay adds).
- `before_value_permission_response_still_decodes` (`worker/protocol.rs:650`) — old `{"selected":{"option_id":"allow"}}` decodes to `value: None`.
- The crate-wide inbound pin in `worker/protocol.rs` now carries `allow-directory` with `value: Some("/home/u/.pi/agent/agents")` (the NEW shape rides the round-trip fixture).
- `config_trusted_flips_the_trust_source` (`core.rs:1340`) — the `Config { trusted }` flip path (the Spaces-UI twin).

### 6d. Where a relay-persists-one-rule test would live + fixtures

**The natural host is `session/mod.rs`'s `session_tests`** — the tests for `SessionManager::respond_permission` already run there; the module has every needed fixture (`mod session_tests` at `session/mod.rs:2205`):

- `temp_config_dir() -> ScratchDir` — `ScratchDir::in_env_temp("session-cfg-", "cfg")` (the settings.json home; dropped on test end).
- `open_db(dir) -> Arc<Db>` — `Db::open(&dir.join("archimedes.db"))`.
- `build_worker_manager(dir, catalog, sink) -> (Arc<SessionManager>, Arc<WorkerManager>, Arc<Db>)` — verbatim:
```rust
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
```
- `start_native_session(dir, sink)` / `start_native_session_with_catalog(dir, sink, catalog)` — real `SessionManager::start_session(dir, sink)` with the `FixtureFactory` WorkerManager (the `FixtureFactory` spawns a fake Worker — a REAL `respond_permission` round-trip through the manager is possible), `TestSink` (recording `EventSink` over an `mpsc::UnboundedSender<Value>`), `native_test_catalog()`, `write_settings_json(dir, serde_json::Value)` (test fixture writer).

**The closest EXISTING trust-space test is NOT in `session_tests`** — it is the worker-side `permission_response_trust_space_flips_the_trust_source` (6c). There is NO current test anywhere that drives `SessionManager::respond_permission` with a `trust-space` outcome and asserts the `db` write (the relay arm added in T01 has no test in the current tree — verification: grep shows no `set_space_trusted` use in any test beside `permission.rs:491` gate tests, `db.rs` tests, `trust.rs` tests, and `policy_gate.rs:783`). A T04 relay test would therefore be NEW, and its fixture shape is `build_worker_manager(temp_config_dir(), …)` → `start_native_session` → seed a `permission-request` (or call `respond_permission` directly with a synthetic outcome, since the gate itself is not required) → assert `load_settings(dir).file_policy.rules` contains exactly one `AccessRule`. (For the write the relay needs `self.config_dir` — which `SessionManager::new(dir.to_path_buf())` sets from the same `dir`.) A `handle_for` miss (no live session) yields `Ok(false)` and NO write — the `cwd: None` + `Ok(false)` arms are the obvious no-write pins.

**Where it must NOT go:** `agent/permission.rs` tests (no `SessionManager`), `worker/core.rs` tests (no `config_dir`, no `Db` — that's the ADR 0025 point), `commands/sessions.rs` tests (thin IPC wrapper).

---

## 7. `commands/sessions.rs::respond_permission` — value flows through untouched

Verbatim:

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

`outcome` is moved verbatim into `SessionManager::respond_permission`; T02 changed nothing here (the Tauri-command `PermissionOutcome` IS the same `agent::permission::PermissionOutcome` — the serde pair rides it transparently). `logged` is `debuglog`-only on `Err`, returns the result unchanged (error display `format!("ipc {command} FAILED: {err}")`). Wire half: `WorkerHandle::send_permission_response(id, &PermissionOutcome)` clones the outcome into `Inbound::PermissionResponse` (client.rs:597-610, “The outcome rides its own serde attrs — no wrapper — so a `None` `value` never reaches the wire”).

---

## 8. Methods + commands used (with `--no-run` for scoped commands)

The scoped command set below is what a T04 check/round-trip run would use; each carries `--no-run` where the plan only needs compile-proof (build fixtures first — `cargo build` once before the first scoped `cargo test`, since a suite can otherwise fail with stale artifacts):

```bash
cd /home/daniel/Coding/AI/archimedes-desktop

# Build fixtures first (one full build; then the scoped runs are incremental).
cargo build --package archimedes-desktop --lib

# The relay's host test module (session_tests) — where a relay-persists test lives.
cargo test --package archimedes-desktop --lib \
  -- agent::session::session_tests --no-run

# The Worker-side permission-response handler (T02 touched).
cargo test --package archimedes-desktop --lib \
  -- agent::worker::core::tests::permission_response --no-run

# Policy / rule model (T01) — the append-contract pins the relay writes against.
cargo test --package archimedes-desktop --lib \
  -- agent::policy::tests::file_policy agent::policy::tests::an_exact_tie --no-run

# config.rs round-trip pins (the file the relay writes).
cargo test --package archimedes-desktop --lib \
  -- config::tests::file_policy --no-run

# The frontend echo (T02) + T06 settings rule paths.
cd src && npx vitest run src/components/PermissionPrompt.test.tsx \
  src/components/settings/SettingsPage.test.tsx src/hooks/useSettingsDocument.test.ts 2>/dev/null \
  || npx vitest run --reporter=dot PermissionPrompt SettingsPage useSettingsDocument
```
(For runs, drop `--no-run`; single-filters keep both surfaces scoped. If the barrel-pin breakage noted in `4395bed`('s message) is still outstanding, the SettingsPage suite may need the mocker pins' updated counts already committed in `c6aba74`.)

---

## Appendix — verbatim reference blocks (sources for every claim above)

- `Settings` struct — `config.rs:159-332` (whole struct quoted in §2a).
- `load_settings` — `config.rs:393-484` (verbatim in §2f summary; the missing-file branch writes defaults, corrupt branch returns `Settings::default()`).
- `write_settings` — `config.rs:486-496` (quoted §2c).
- `FilePolicy`/`AccessRule`/`RuleDecision`/`RuleDirection` — `agent/policy.rs:33-100` (quoted §2b + doc).
- `default_rules` — `agent/policy.rs:296-333` (verbatim; CONCATENATION CONTRACT doc quoted in §1/§6d context): “every consumer that puts rules in front of `rule_for` MUST emit `default_rules()` FIRST and user-written rules SECOND … the Supervisor's ‘always allow this directory’ action appends one `allow` rule AFTER these defaults so it beats a default `deny` on an exact path tie.”
- `rule_for` tie-break — `agent/policy.rs:195-230` (doc) + the two-order pin in §6b.
- `respond_permission` — `session/mod.rs:1909-1972` (quoted §1a).
- `SessionManager` fields — `driver: { db: Option<Arc<Db>>, … }`, `config_dir: PathBuf`, `live: StdMutex<HashMap<String, LiveWorkerSession>>` (`session/mod.rs` `SessionManager` struct def; `config_dir` is set by `SessionManager::new(dir.to_path_buf())` and `write_settings(&self.config_dir, …)` already appears at `:1744`).
- `handle_for` / `get_handle_for` — `worker/manager/mod.rs:413-427` + `worker/manager/registry.rs:78-89` (quoted §1c).
- `send_permission_response` — `worker/client.rs:597-610`.
- Worker `PermissionResponse` handler — `worker/core.rs:617-637` (quoted §4).
- `set_space_trusted` — `storage/db.rs:1027-1035` (quoted §5); `space_key` at `db.rs:1134`.
- `PermissionOutcome` — `agent/permission.rs:53-75` (quoted §4).
- `permission_options` — `agent/permission.rs:146-205` (quoted §4).
- Frontend echo — `src/components/PermissionPrompt.tsx:65-75`.
- Settings writers — `src/hooks/useSettingsDocument.ts:96-100`, `src/components/settings/SettingsPage.tsx:366-394`, `src/hooks/useAgentOverridesWrites.ts:144-179`.
- Frontend rule contract pin — `src/components/settings/SettingsPage.tsx` comment “Composes over the RENDERED `settings`, not a ref — the two-write interleave pin in `SettingsPage.test.tsx` makes that window observable.”