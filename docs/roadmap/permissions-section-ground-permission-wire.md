# Grounding report — the permission outcome wire (Rust)

Companion to `docs/roadmap/permissions-section.md` (status: approved). Everything below is
quoted verbatim from the tree at HEAD as of this writing. No design, no recommendations —
what exists today, so a planner never re-reads these files.

The subject of the planned change is `PermissionOutcome::Selected { option_id: String }`
gaining an optional `value`. This report is the full blast radius of that field across the
crate.

Files covered: `src-tauri/src/agent/permission.rs`, `src-tauri/src/agent/harness/loop/gate.rs`
(+ the single `gate_tool` call site in `src-tauri/src/agent/harness/loop/turn.rs`),
`src-tauri/src/agent/worker/{sink.rs, protocol.rs, client.rs, core.rs}`,
`src-tauri/src/agent/worker/manager/{mod.rs, subagent_flow.rs, pump.rs}` +
`src-tauri/src/agent/worker/manager/tests/mod.rs`, `src-tauri/src/bin/fake_worker.rs`,
`src-tauri/src/commands/sessions.rs`, `src-tauri/src/agent/mod.rs`,
`src-tauri/src/agent/session/mod.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`,
`src-tauri/src/agent/subagent.rs` (the serde-default precedent).

Quoting convention: symbols are named, no `file:line` citations. Multi-line quotes are
indented; single-line quotes in the surrounding text are backticked.

---

## 1. `PermissionOutcome`, `permission_key`, `PendingPermissions`, `native_permission_gate` (verbatim)

From `src-tauri/src/agent/permission.rs`:

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

Notes for the planner:

- The enum-level `#[serde(rename_all = "snake_case")]` makes the unit variant serialize as the
  bare string `"cancelled"` and the struct variant as `{"selected": {"option_id": "…"}}`. The
  sibling frontend ground report pins the mirror TypeScript union
  `{ selected: { option_id: string } } | "cancelled"` in `src/lib/tauri/types.ts`.
- `PermissionOutcome` is **not** re-exported from `permission.rs`'s module; it is re-exported
  crate-wide via `src-tauri/src/agent/mod.rs`:
  ```rust
  mod permission;
  // …
  pub use permission::{permission_key, PendingPermissions, PermissionOutcome};
  ```
  `mod permission;` is private; `PermissionOutcome` reaches the world through the
  `crate::agent::permission::PermissionOutcome` path (used in `session/mod.rs`) and the
  `crate::agent::PermissionOutcome` path (used in `commands/sessions.rs`, which imports it in
  the `use crate::agent::{…, PermissionOutcome, …}` list).

`permission_key` (same file):

```rust
/// Build the compound key for a pending permission.
pub fn permission_key(session_id: &str, request_id: &str) -> String {
    format!("{session_id}/{request_id}")
}
```

`PendingPermissions` (same file):

```rust
/// The manager's map of pending permission senders.
///
/// Keyed by `"{session_id}/{request_id}"` so the driver-task cleanup can
/// drain all entries for a closing session at once (dropping the senders
/// cancels the pending gates).
pub type PendingPermissions = Arc<Mutex<HashMap<String, oneshot::Sender<PermissionOutcome>>>>;
```

`native_permission_gate`'s **full signature** (same file; the `#[allow(clippy::too_many_arguments)]`
attribute sits directly above it):

```rust
#[allow(clippy::too_many_arguments)]
pub async fn native_permission_gate(
    session_id: &str,
    request_id: &str,
    title: &str,
    sink: &Arc<dyn EventSink>,
    pending_permissions: &PendingPermissions,
    trust: Option<&dyn TrustSource>,
    cwd: &std::path::Path,
    cancel: &CancellationToken,
) -> PermissionOutcome {
```

---

## 2. Every construction site and every match site of `PermissionOutcome` / `Selected`

### 2.1 `src-tauri/src/agent/permission.rs`

- `native_permission_gate`, the cancel short-circuit:
  ```rust
  if cancel.is_cancelled() {
      return PermissionOutcome::Cancelled;
  }
  ```
- `native_permission_gate`, the trusted auto-approve:
  ```rust
  if trusted {
      return PermissionOutcome::Selected {
          option_id: "allow".to_string(),
      };
  }
  ```
- `native_permission_gate`, the oneshot await:
  ```rust
  let outcome = tokio::select! {
      r = rx => r.unwrap_or(PermissionOutcome::Cancelled),
      _ = cancel.cancelled() => PermissionOutcome::Cancelled,
  };
  ```
- `tests::an_unanswered_permission_prompt_never_settles_on_a_clock` (the late answer + the
  expected return, both constructed):
  ```rust
  .send(PermissionOutcome::Selected {
      option_id: "allow".to_string(),
  })
  ```
  ```rust
  PermissionOutcome::Selected {
      option_id: "allow".to_string()
  }
  ```
- `tests::native_gate_trusted_space_auto_approves` (constructed twice — the sent answer and the
  asserted outcome):
  ```rust
  outcome,
  PermissionOutcome::Selected {
      option_id: "allow".into()
  },
  ```
- `tests::native_gate_untrusted_prompts_and_maps_the_outcome` (constructed twice):
  ```rust
  sender
      .send(PermissionOutcome::Selected {
          option_id: "allow".into(),
      })
  ```
  ```rust
  task.await.unwrap(),
  PermissionOutcome::Selected {
      option_id: "allow".into()
  }
  ```
- `tests::native_gate_trust_space_allows_without_writing_the_flag` (constructed twice with
  `"trust-space"`):
  ```rust
  .send(PermissionOutcome::Selected {
      option_id: "trust-space".into(),
  })
  ```
  ```rust
  task.await.unwrap(),
  PermissionOutcome::Selected {
      option_id: "trust-space".into()
  },
  ```
- `tests::native_gate_cancel_is_a_denial`:
  ```rust
  assert_eq!(
      outcome,
      PermissionOutcome::Cancelled,
      "a cancel is a denial (never an auto-allow)"
  );
  ```

### 2.2 `src-tauri/src/agent/harness/loop/gate.rs` — `gate_tool`, THE match site

```rust
matches!(
    outcome,
    PermissionOutcome::Selected { option_id }
        if option_id == "allow" || option_id == "trust-space"
)
```

This is the **only match site in the native path** that consumes the `Selected` payload.
With the new `value` field the pattern must become `Selected { option_id, .. }`. It is inside
`pub(super) async fn gate_tool(&self, tc: &ToolCall, turn: &CancellationToken) -> bool`.

### 2.3 `src-tauri/src/agent/harness/loop/turn.rs` — the gate_tool call site

`gate_tool` is called from exactly one place, the sequential-tool arm of the turn loop:

```rust
match self.policy_verdict(tc) {
    Some(Decision::Ask) => {
        if self.gate_tool(tc, turn).await {
            self.dispatch_tool(tc, turn).await
        } else {
            ToolResult {
                content: vec![ContentBlock::Text {
                    text: "permission denied".to_string(),
                }],
                details: None,
                is_error: true,
            }
        }
    }
    Some(Decision::Deny) => self.deny_tool_result(tc),
    _ => self.dispatch_tool(tc, turn).await,
}
```

### 2.4 `src-tauri/src/agent/worker/core.rs`

- `WorkerCore::handle`, the `Inbound::PermissionResponse` arm — this is the **Worker-side
  trust-space flip** (see §5), and a `Selected { value }` would need the same treatment here:
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
  Note the non-exhaustive-looking `if let PermissionOutcome::Selected { option_id } = &outcome`
  — in Rust 2021 this is a **warning-free complete match** because `PermissionOutcome` has no
  `#[non_exhaustive]`; it still needs `..` when `value` is added.
- `tests::permission_response_resolves_the_pending_oneshot` (constructed twice):
  ```rust
  outcome: PermissionOutcome::Selected {
      option_id: "allow".to_string(),
  },
  ```
  ```rust
  outcome,
  PermissionOutcome::Selected {
      option_id: "allow".to_string()
  },
  ```
- `tests::permission_response_trust_space_flips_the_trust_source`:
  ```rust
  outcome: PermissionOutcome::Selected {
      option_id: "trust-space".to_string(),
  },
  ```

### 2.5 `src-tauri/src/agent/worker/client.rs`

- `WorkerHandle::send_permission_response` (takes `&PermissionOutcome`, clones it into the
  frame — a new field flows through untouched):
  ```rust
  pub fn send_permission_response(
      &self,
      id: &str,
      outcome: &PermissionOutcome,
  ) -> Result<(), WorkerError> {
      self.send_inbound_frame(Inbound::PermissionResponse {
          id: id.to_string(),
          outcome: outcome.clone(),
      })?;
  ```
- `tests::a_permission_response_round_trip_completes_the_canned_flow`:
  ```rust
  handle
      .send_permission_response(
          "p1",
          &PermissionOutcome::Selected {
              option_id: "trust-space".to_string(),
          },
      )
      .expect("the response encodes");
  ```

### 2.6 `src-tauri/src/agent/worker/protocol.rs`

- The `decode_inbound` **explicit allow-list** (not a match on the type, but the router that
  decides whether a malformed `permission-response` is a hard error or the permissive
  `Unknown`):
  ```rust
  "start"
  | "prompt"
  | "config"
  | "compact"
  | "abort"
  | "close"
  | "permission-response"
  | "interactive-response"
  | "subagent-result"
  | "fetch-render-response" => {
  ```
- `tests::every_inbound_variant_round_trips` (constructed twice):
  ```rust
  Inbound::PermissionResponse {
      id: "r1".to_string(),
      outcome: PermissionOutcome::Selected {
          option_id: "trust-space".to_string(),
      },
  },
  ```
  ```rust
  Inbound::PermissionResponse {
      id: "r2".to_string(),
      outcome: PermissionOutcome::Cancelled,
  },
  ```

### 2.7 `src-tauri/src/agent/worker/manager/tests/mod.rs`

- `an_answered_gates_card_is_not_closed_again_at_teardown`:
  ```rust
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
  ```

### 2.8 `src-tauri/src/agent/session/mod.rs` — `SessionManager::respond_permission`, the Supervisor-side trust-space persist (see §5)

```rust
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
```

### 2.9 `src-tauri/src/commands/sessions.rs` — the Tauri command

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
```

The command is registered in `src/lib.rs`'s `invoke_handler` list:
```rust
commands::sessions::respond_permission,
```

### 2.10 Tests that construct or match it but are NOT in the change's direct path

- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, helper `answer_permission` (the
  mock handle-free waiter — every policy test that answers a prompt goes through this):
  ```rust
  let sender = map.remove(&key).expect("the entry is in the map");
  let _ = sender.send(PermissionOutcome::Selected {
      option_id: option.to_string(),
  });
  ```

No other `PermissionOutcome` construction or `Selected` match exists in the crate. The
`grep -rn "PermissionOutcome"` hits not listed above are all comments/doc-comments.

---

## 3. The prompt payload builders — the `json!` options literals

### 3.1 The one production builder: `native_permission_gate` in `src-tauri/src/agent/permission.rs`

The comment directly above the emission reads (verbatim — this is the "always three options"
assertion the spec's prompt section quotes):

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

The output `Value` is handed straight to `sink.emit` — there is **no Rust struct** for the
prompt payload anywhere; every consumer and every test that echoes it does so through a
`serde_json::Value` / `json!`. The options flow onward verbatim:

- `IpcEventSink::emit` (`worker/sink.rs`) wraps the same `Value` into
  `Outbound::PermissionRequest { id, payload }` with `payload` untouched (see §4 of the
  sibling prompt report; the sink reads only `payload["requestId"]` for the `id`).
- The frontend renders `prompt.options.map(...)` generically (pinned by the sibling report).

### 3.2 The second verbatim copy: `worker/sink.rs`'s frame test

`tests::permission_request_maps_to_the_frame_with_the_payload_verbatim`:

```rust
#[test]
fn permission_request_maps_to_the_frame_with_the_payload_verbatim() {
    let (sink, mut rx) = sink();
    let payload = json!({
        "sessionId": "s1",
        "requestId": "r1",
        "request": {
            "sessionId": "s1",
            "toolCall": { "title": "Allow bash?" },
            "options": [
                { "optionId": "allow", "name": "Allow", "kind": "allow" },
                { "optionId": "reject", "name": "Block", "kind": "reject" },
                { "optionId": "trust-space", "name": "Don't ask again for this Space", "kind": "allow" }
            ]
        }
    });
```

(Full test body asserts the payload rides verbatim and, notably, `back["request"]["options"]
.as_array().unwrap().len() == 3` — a three-option pin.)

### 3.3 Other verbatim copies of the same options list

A planner touching any of these must keep them in step:

- `src-tauri/src/agent/worker/protocol.rs`, `tests::every_outbound_variant_round_trips` — the
  canned `permission_payload` for `Outbound::PermissionRequest` (identical three entries, one
  line each).
- `src-tauri/src/bin/fake_worker.rs`, the `"__permission__"` prompt arm — emits the same
  three options in the canned `PermissionRequest` frame, with the comment
  `// mirroring `permission.rs:135-158`` (the fixture is a separate binary target; see §10).
- `src-tauri/src/agent/worker/client.rs`, `tests::a_permission_response_round_trip_completes_the_canned_flow` —
  asserts on the canned payload it receives from the fixture:
  ```rust
  assert_eq!(req.1["request"]["options"][0]["optionId"], "allow");
  assert_eq!(req.1["request"]["options"][2]["optionId"], "trust-space");
  ```

---

## 4. The approve predicate in `gate.rs` (allow vs reject), and `trust-space`

The whole decision in `AgentLoop::gate_tool` (`src-tauri/src/agent/harness/loop/gate.rs`):

```rust
pub(super) async fn gate_tool(&self, tc: &ToolCall, turn: &CancellationToken) -> bool {
    let outcome = native_permission_gate(
        &self.session_id,
        &tc.id,
        &permission_title(&tc.name, &tc.arguments),
        &self.sink,
        &self.pending_permissions,
        self.trust.as_deref(),
        &self.space_cwd,
        turn,
    )
    .await;
    matches!(
        outcome,
        PermissionOutcome::Selected { option_id }
            if option_id == "allow" || option_id == "trust-space"
    )
}
```

`trust-space` is treated as an **allow** at the gate — the caller (`turn.rs`) maps `true` to
`dispatch_tool`, `false` to the `"permission denied"` tool-result error. `Cancelled` is a
deny. The gate itself never writes the trust flag (its doc comment: "The `trust-space` flag
WRITE is NOT here (ADR 0025 — the Worker has no `Db`): the Supervisor's `respond_permission`
relay applies it … + the Worker's `StaticTrustSource` flip"). The `gate_tool` doc comment
also records that its own trust check is now redundant with `decision_for` (a trusted Space's
verdict is already `Allow`, so an `Ask` reaching here implies untrusted), kept because the
gate is the seam that answers `trust-space`.

---

## 5. The trust flip split (ADR 0025)

**Worker side — the live flip** (`src-tauri/src/agent/worker/core.rs`,
`WorkerCore::handle`, `Inbound::PermissionResponse` arm):

```rust
if let PermissionOutcome::Selected { option_id } = &outcome {
    if option_id == "trust-space" {
        if let Some(s) = &self.trust {
            s.set(true);
        }
    }
}
```

The `self.trust` field is `Option<Arc<StaticTrustSource>>`, created in `WorkerCore::new` as
`Some(Arc::new(StaticTrustSource::new(false)))`, **shared** with the `Start`-built loop: the
`build_loop` seam's closure captures the same `Arc`, `Start` sets it (`if let Some(s) =
&self.trust { s.set(env.trusted); }`), and `Inbound::Config { trusted: Some(t) }` flips it the
same way. One sentence: **the Worker owns the live half — `s.set(true)` on a
`trust-space` outcome, which makes the very next tool call auto-approve.**

**Supervisor side — the persistence** (`src-tauri/src/agent/session/mod.rs`,
`SessionManager::respond_permission`):

```rust
if let permission::PermissionOutcome::Selected { option_id } = &outcome {
    if option_id == "trust-space" {
        if let (Some(db), Some(cwd)) = (&self.driver.db, cwd) {
            let _ = db.set_space_trusted(&cwd.display().to_string(), true);
        }
    }
}
```

The `cwd` is looked up from the `live` map by `session_id` just above this block (the 
`{ let live = self.live.lock()…; live.get(session_id).map(|l| l.cwd.clone()) }` block).
One sentence: **the Supervisor owns the persistent half — `db.set_space_trusted(cwd, true)`
against the `spaces` table (the same `Db` the Settings UI writes), and it authors no
`StaticTrustSource`.**

The spec's rule-write ("Always allow this directory" appends one rule to `settings.json`) is
modelled on this split: **the relay (Supervisor) persists, the gate (Worker) never writes
state** — the gate has no `Db` and no settings access (`AgentLoop::new` receives a
`config_dir` for the policy file, but the gate/Worker-side loop never writes it; see §9 for
where `FilePolicy` lives).

---

## 6. `worker/protocol.rs`: `Inbound::PermissionResponse` and `PermissionRequest` (verbatim)

```rust
/// The REAL outcome (3-option UI: `Selected { option_id }` ∈
/// allow / reject / trust-space, or `Cancelled`) — NOT a bool.
#[serde(rename = "permission-response", rename_all = "camelCase")]
PermissionResponse {
    id: String,
    outcome: crate::agent::permission::PermissionOutcome,
},
```

```rust
/// `id` = the payload's `requestId` (the `PendingPermissions` map
/// key — the same key the loop used); `payload` = the gate's
/// `permission-request` sink payload VERBATIM.
#[serde(rename = "permission-request", rename_all = "camelCase")]
PermissionRequest { id: String, payload: Value },
```

For context — the enum is internally-tagged and the wire names are the per-variant `rename`s:

```rust
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum Inbound {
```

The module doc records the conventions: snake_case `type` discriminators, camelCase payload
fields (per-variant `rename_all`), and — critically for the new field — **"The `Model` /
`ModelCatalog` / `PermissionOutcome` / `ChatMessage` / `ImageRef` / `LaunchConfig` /
`SubagentOutcome` types already derive serde — they ride the wire VERBATIM (no separate
provider wire type)".** `PermissionOutcome` is not wrapper-mapped in `protocol.rs`; it is the
field type directly, so its serde attributes ARE the wire shape. Wire spelling of the payload
today: `{"type":"permission-response","id":"…","outcome":{"selected":{"option_id":"…"}}}`
(for `Selected`) or `{"type":"permission-response","id":"…","outcome":"cancelled"}`
(for `Cancelled`). A `value` field on `Selected` adds `"value"` inside the
`{"selected":{…}}` object.

Decoding is routed by the explicit allow-list in `decode_inbound` (`"permission-response"`
is listed — so a payload that fails to deserialize is a hard `ProtoError::Json`, NOT the
permissive `Unknown` fallback). The `Unknown { raw: Value }` catch-all exists for unknown
top-level `type`s only.

---

## 7. Test inventory

### 7.1 `src-tauri/src/agent/permission.rs` — inline `mod tests`

| Test fn | One-clause description |
|---|---|
| `permission_titles_name_the_thing_being_approved` | The `permission_title` table: path tools name the path, search tools name pattern-in-dir, `bash` the command. |
| `permission_title_degrades_instead_of_panicking_on_missing_arguments` | Degraded titles: `path` defaults to `"."`, missing args fall back without panicking. |
| `an_unanswered_permission_prompt_never_settles_on_a_clock` (`#[tokio::test(start_paused = true)]`) | Advances 20 min past a prompt; asserts the gate stays open, then that a late `allow` answer still resolves it. |
| `native_gate_trusted_space_auto_approves` | A trusted Space returns `Selected { option_id: "allow" }` with **no** `permission-request` and **no** oneshot entry. |
| `native_gate_untrusted_prompts_and_maps_the_outcome` | An untrusted Space emits the `permission-request` with a 3-option `options` array (asserts `payload["request"]["options"].as_array().unwrap().len() == 3`), resolves `allow`, drains the map. |
| `native_gate_trust_space_allows_without_writing_the_flag` | Resolving `trust-space` returns `Selected { option_id: "trust-space" }` and the `Db` row stays **untrusted** (asserts `!db.space_trusted(&cwd)`). |
| `native_gate_cancel_is_a_denial` | A pre-cancelled token returns `Cancelled` without prompting. |

**Tests that pin the three-option list or `trust-space`**: `native_gate_untrusted_prompts_and_maps_the_outcome`
(pins `options.len() == 3`); `native_gate_trust_space_allows_without_writing_the_flag`
(pins the `trust-space` option id and the no-write split). The `RecSink` helper records
`(event, Value)` pairs.

### 7.2 `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`

| Test fn (exact prose names) | One-clause description |
|---|---|
| `ask_beyond_the_boundary_prompts_naming_the_path_then_runs` | `reads: Ask` + untrusted: one `permission-request` naming the path, answered `allow` → the read runs and returns content. |
| `sandboxed_beyond_the_boundary_errors_with_no_prompt` | `reads: Sandboxed` beyond the boundary: an error worded like the executor's, **no** `permission-request`, no oneshot. |
| `the_default_policy_reads_and_writes_beyond_the_boundary_in_silence` | Default `Allow` (and no-`config_dir`): out-of-boundary read and write dispatch silently, the write lands. |
| `a_settings_edit_between_prompts_changes_the_next_turns_gating` | (ADR 0030 Deviation 4) Editing `settings.json` between two prompts changes the second turn's gating (`ask` → `sandboxed`). |
| `a_sandboxed_shell_dispatches_confined_with_no_prompt` | `shell: Sandboxed` confines (Landlock when available) or fails closed visibly — never prompts. |
| `a_gate_denial_of_a_protected_dir_uses_the_protected_wording` | A write into `.agents/skills` / `.pi/agent/skills` / `.agents/agents` / `.pi/agent/agents` is a gate **Deny** (no prompt) worded `protected agent-definition directory` + the sanctioned route, even under `writes: sandboxed`. |
| `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session` | (issue #92) A protected dir missing at `AgentLoop::new` snapshot time, recreated mid-session, is still refused with the protected wording. |
| `a_trusted_space_suppresses_the_prompt_the_policy_would_raise` | Trust turns the verdict `Ask` → `Allow` (asserted on `policy_verdict` directly and end-to-end); no prompt, the read runs. |
| `the_skill_tools_stay_outside_the_policy_gate` | `read_skill` is ungated: `sandboxed` policy leaves the executor's own "unknown skill" error alone. |

**Tests that pin the three-option list or `trust-space`**: none of the `policy_gate.rs`
tests assert on the options array or on `trust-space` — they answer via the `answer_permission`
helper (constructed `Selected { option_id: option.to_string() }`) with `"allow"`, and the only
`trust-space`-adjacent facts are the protected-deny ones (which assert **no prompt at all**).
The three-option pins live in `permission.rs`'s inline tests, `worker/sink.rs`, and
`worker/client.rs` (see §3.3). The gate's `trust-space` acceptance is pinned nowhere in a test
today — only the comment in `gate.rs` states it.

---

## 8. `commands/sessions.rs`: the command signature

Full signature (verbatim, see §2.9). It **takes the outcome by value**:

```rust
#[tauri::command]
pub async fn respond_permission(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    request_id: String,
    outcome: PermissionOutcome,
) -> Result<(), crate::agent::SessionError> {
```

Because `PermissionOutcome` is `Deserialize`d from the invoke payload, a **new `value` field
on `Selected` flows through untouched** — as long as it is `#[serde(default)]`, the command's
parameter binding accepts both old (field absent) and new (field present) payloads, and
`SessionManager::respond_permission` (by value onward) and `WorkerHandle::send_permission_response`
(by `&PermissionOutcome`) need no signature change. What changes is the **match inside**
`SessionManager::respond_permission` (the `if let permission::PermissionOutcome::Selected
{ option_id } = &outcome` — needs `..`), with the rule-write hook riding next to the
`trust-space` persist block at the exact site quoted in §5.

---

## 9. Conventions

### 9.1 serde-default for backward compat — the crate's inline precedent

The most on-point precedent is literally the protocol file's own
`a_failed_subagent_result_in_the_old_shape_still_decodes` test, whose doc comment frames it as
the cross-version guard:

> (Cross-version guard) An OLD-shape `Failed` payload — the pre-salvage
> `{"Failed":{"error":"x"}}`, with NO `reason` / `output` / `metrics` —
> still DECODES. … The `#[serde(default)]`s on the new fields
> are what keep an old Worker working.

The fields it guards, in `src-tauri/src/agent/subagent.rs` (`SubagentOutcome::Failed`):

```rust
Failed {
    /// Why it ended (the machine-readable answer — never parsed out of
    /// `error`). `#[serde(default)]` so a stale Worker's payload decodes.
    #[serde(default)]
    reason: SubagentFailureReason,
    error: String,
    /// Whatever the child had produced … 
    #[serde(default)]
    output: String,
    /// REAL accumulated usage + wall clock …
    #[serde(default)]
    metrics: SubagentMetrics,
},
```

This is the same mechanism the spec names for the `value` field ("The field is
serde-defaulted, so previously serialized outcomes still parse"). The deliberate-contrast
(where defaults are refused) is documented in `worker/protocol.rs` on
`name_resolution` / `AgentNameResolution`: "Deliberately NOT `#[serde(default)]` … Every
default for this field is a LIE" — so a planner in doubt reads the `subagent-result` triad as
the "tolerate old shapes" model and `SubagentDispatch::name_resolution` as the "refuse loud"
model.

Other `#[serde(default)]` sites in `src/agent` for pattern: `harness/catalog.rs`
(`ModelsResponse { #[serde(default)] data: Vec<DiscoveredModel> }` and two more),
`mcp/types.rs` (a block of per-field defaults), `web/providers/{brave,perplexity,searxng}.rs`.
`FilePolicy` itself carries `#[serde(default)]` and `config.rs:686` pins "an old
`settings.json` parses to the new defaults" — quoted in the spec's Enforcement section.

### 9.2 Test-name style

- **`project_verb_prose` snake_case sentences, no `test_` prefix**, top-heavy on the subject:
  `an_unanswered_permission_prompt_never_settles_on_a_clock`,
  `native_gate_trusted_space_auto_approves`,
  `a_gate_denial_of_a_protected_dir_uses_the_protected_wording`,
  `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session`,
  `a_failed_subagent_result_in_the_old_shape_still_decodes`,
  `permission_response_trust_space_flips_the_trust_source`.
- Test fns carry a **doc comment explaining the pin and sometimes the trap it guards**
  (see `a_failed_subagent_result_in_the_old_shape_still_decodes`'s comment in §9.1).
- Tokio tests are `#[tokio::test]` (plus `(start_paused = true)` for the clock test);
  pure ones are `#[test]`.

---

## 10. Scoped test commands from `src-tauri/`

The crate is `archimedes` (the `[package]`) with the lib renamed `archimedes_lib`
(`[lib] name = "archimedes_lib"`); `default-run = "archimedes"`; the bin targets live in
`src/bin/` (`fake_worker.rs`, `fake_mcp_stdio.rs`).

Commands that hit this area (run from `src-tauri/`):

```
# The permission gate's inline tests + the loop's policy_gate module
cargo test --lib permission::tests
cargo test --lib permission::
cargo test --lib policy_gate::

# The policy_gate module lives under the loop's test tree:
#   src/agent/harness/loop/tests/policy_gate.rs, declared in
#   src/agent/harness/loop/tests/mod.rs (mod policy_gate);
# the parent is src/agent/harness/loop.rs (mod tests;).
cargo test --lib harness::loop::tests::policy_gate::

# The worker wire: protocol round-trips, the sink frame maps, the core handlers
cargo test --lib worker::protocol::
cargo test --lib worker::sink::
cargo test --lib worker::core::

# The Supervisor-side client tests — these SPAWN the fixture binary
# (Client::fixture_path: "$CARGO_MANIFEST_DIR/target/debug/fake_worker"),
# so the bin target must exist first:
cargo test --lib worker::client::
cargo build --bin fake_worker
cargo test --lib worker::client::

# The WorkerManager tests (also spawn the fixture; see tests/mod.rs's fixture_path)
cargo build --bin fake_worker
cargo test --lib worker::manager::

# A whole-module sweep (safe: one module, no worker spawn unless the module does)
cargo test --lib -- agent::worker::
```

Caveats recorded in the spec and worth repeating for a planner: `archimedes` is **one
compilation unit**, so Rust implementation tasks cannot share a wave; `cargo test --lib`
does **not** rebuild `fake_worker` (the fixture is a separate bin target — hence the explicit
`cargo build --bin fake_worker` before the client/manager suites); `#[cfg(windows)]`
behaviour type-checks locally and runs only on CI. The spec's Verification section adds
`clippy --all-targets` (0 warnings) and `fmt --check` from `src-tauri/`, plus
`cargo check --target x86_64-pc-windows-gnu --all-targets` for the Windows path.

---

## Reset of facts a planner will need (no `file:line` — by symbol)

- **The type is constructed/consumed in exactly these places**: `permission.rs`
  (gate internals + 6 tests), `gate.rs` `gate_tool` (the one native match site), `turn.rs`
  (the one `gate_tool` call), `worker/core.rs` (handler + 2 tests), `worker/client.rs`
  (send wrapper + 1 test), `worker/protocol.rs` (field type + round-trip tests),
  `worker/manager/tests/mod.rs` (1 test), `session/mod.rs`
  (`SessionManager::respond_permission` + the trust-space block), `commands/sessions.rs`
  (by-value command param), `harness/loop/tests/policy_gate.rs` (the `answer_permission`
  helper). The `fake_worker` fixture carries the word "PermissionOutcome" only in a comment —
  it never constructs the enum (it decodes `Inbound` lines generically; its `__permission__`
  arm emits an `Outbound::PermissionRequest` `json!` with the three options and then loops on
  `decode_inbound` until `matches!(m2, Inbound::PermissionResponse { .. })`).
- **The wire has two serialized shapes of the outcome**: `{"selected":{"option_id":"…"}}`
  and `"cancelled"`. Any new field lands inside the `"selected"` object.
- **The gate treats exactly two option ids as allow**: `"allow"` and `"trust-space"`;
  everything else (including `Cancelled`) is a deny.
- **The prompt options are `json!` data, not a struct**: three verbatim copies of the
  options list exist (production `permission.rs`, test `worker/sink.rs`, fixture
  `fake_worker.rs`), plus canned copies in `worker/protocol.rs` and `worker/client.rs` tests.
- **The rule for a new field's backward compat has two in-repo models**: the defaulted
  `SubagentOutcome::Failed` fields (tolerate old shapes — the model the spec chooses) and the
  deliberately non-defaulted `SubagentDispatch::name_resolution` (refuse loud).