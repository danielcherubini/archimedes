# Grounding — worker-wire (issue #122: Empty-message sanitisation placeholder)

Area grounded: the agent worker's message/protocol layer for issue #122
("Silence `[System: Empty message content sanitised to satisfy protocol]` and guard
empty message content"). Branch `feature/backlog-79-122-124-28`, worktree CLEAN
(`git status --short` empty; HEAD `f5ba339`). This is a **grounding report only** — no
patch, no plan, no ranking. All line numbers are as of HEAD on this branch.

The task's own **Owns** set (all under `src-tauri/src/agent/worker/`):
`core.rs`, `client.rs`, `manager/subagent_flow.rs`, `manager/tests/mod.rs`.

> **Headline finding first, because it shapes the whole plan:** the issue's own
> root-cause (§1 of the issue body) names `src-tauri/src/agent/harness/provider/openai.rs`
> (`request_body`, `MessageContent::to_wire`) as the outbound empty-`content` site, and
> §3 names the stream/transcript path (`TextDelta` → `message_update` → `agent_message_chunk`)
> as the inbound leakage site. **Neither site is in the task's Owns set.** The Owns set
> is the *worker IPC* layer (Supervisor↔Worker frames over stdio) plus the subagent
> manager — a **relay**, not the origin, of the affected content. The report below
> documents every place in the Owns set where content transits and could be empty, so the
> planner can decide where the task's actual edits land (or formally widen the Owns set).

---

## 0. Spec sources read

- **Issue #122** — `gh issue view 122 --repo danielcherubini/archimedes --json body`.
  Three root-cause parts:
  1. Outbound assistant tool-call messages send `content: ""` on the OpenAI wire
     (`harness/provider/openai.rs` `request_body`; `MessageContent::to_wire()` →
     `Value::String("")` when `acc.text` is empty). LiteLLM's
     `_sanitize_empty_text_content` (in `factory.py`, `modify_params=True`) replaces
     empty/whitespace `str` content with the placeholder, then saves it into history;
     the model sees it on later turns.
  2. Response leakage: when LiteLLM / a proxy / a model streams or returns the
     placeholder, Archimedes receives it via `TextDelta` and passes it through to the UI
     and transcript untested.
  3. Issue's proposed changes: (1) filter/strip the placeholder from incoming text
     deltas; (2) emit `"content": null` (or omit) instead of `"content": ""` for
     assistant messages with tool calls; (3) similarly guard empty/whitespace system
     messages/content blocks. Acceptance criteria: the placeholder never appears in UI
     or transcript; outbound assistant tool-call messages send `content: null`/omitted;
     unit tests for the request-body serialization and for strip of streamed
     placeholder; existing provider tests keep passing.
- **ADR 0054** — `docs/decisions/0054-the-system-message-fold-belongs-to-the-wire-not-the-transcript.md`
  (date 2026-10-15). The `System`-message fold is a **wire** fact, not a transcript one:
  `ModelRequest::system_text()` (`provider/types.rs`) is the single definition; every wire
  sends at most one leading system message; transcript keeps unfolded shape. Consequence
  quoted in §2 relevant to empty content: "every future wire must fold, and a wire that
  forwards `messages` verbatim is a bug".

---

## 1. Message content construction & serialisation toward the provider

### 1a. The content/message types (verbatim)

`src-tauri/src/agent/harness/provider/types.rs`:

```rust
/// A message's content: plain text, or a list of content blocks (mirrors
/// the Task 1 [`ContentBlock`] shape — text or a base64 image).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    /// `{ "content": "..." }` (the common case).
    Text(String),
    /// `{ "content": [{ "type": "text" | "image", ... }] }`.
    Blocks(Vec<ContentBlock>),
}
```

```rust
/// One chat message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: MessageContent,
    /// Set on a `tool` message: the `tool_call.id` this result answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Set on an `assistant` message that called tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}
```

```rust
/// A chat message's role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    /// A tool result (paired with `tool_call_id`).
    Tool,
}
```

```rust
/// A model request (the `AgentLoop`'s `complete()` argument, Task 6).
#[derive(Debug, Clone)]
pub struct ModelRequest {
    /// The model id (e.g. `tama` / an OpenRouter slug).
    pub model: String,
    /// The conversation so far.
    pub messages: Vec<ChatMessage>,
    /// The tool specs the model may call (empty = no tools).
    pub tools: Vec<ToolSpec>,
    /// Sampling / limits.
    pub options: ModelOptions,
    /// The session id for LiteLLM session / request tracking (if known).
    pub session_id: Option<String>,
}
```

### 1b. The conversion function internal → wire payload

`MessageContent::to_wire` (`provider/types.rs`, verbatim signature and body):

```rust
impl MessageContent {
    /// The OpenAI-compatible WIRE form of the content: `Text` → a plain
    /// string ... `Blocks` → an array of OpenAI content parts ...
    /// This is the ONLY serialization used on the request wire
    /// (`request_body`); ...
    pub fn to_wire(&self) -> Value {
        match self {
            MessageContent::Text(t) => Value::String(t.clone()),
            MessageContent::Blocks(blocks) => { ... }
        }
    }
}
```

`MessageContent::Text("")` therefore serialises to the JSON string `""`. The
`request_body` mapper (in `openai.rs`, NOT in the Owns set) inserts it verbatim:

```rust
obj.insert("content".to_string(), m.content.to_wire());
```

and there is **no** `skip_serializing_if` / null / omission logic for an empty text on
this wire (contrast Anthropic and Responses wires, §5).

### 1c. Every place a content field can legitimately end up empty

1. **Assistant turn with only tool calls** — `AgentLoop` settle in
   `harness/loop.rs` (~line 897):

   ```rust
   self.messages.push(ChatMessage {
       role: ChatRole::Assistant,
       content: MessageContent::Text(acc.text.clone()),
       tool_call_id: None,
       tool_calls: (!tool_calls.is_empty()).then_some(tool_calls.clone()),
   });
   ```

   `acc.text` is the streamed `TextDelta` accumulation (empty for a tool-only turn) →
   `MessageContent::Text("")` → `"content": ""` on the OpenAI wire. **This is the issue's
   root cause #1.** (Anthropic wire: `anthropic.rs` ~line 678 guards with
   `text.as_str().is_some_and(|s| !s.is_empty())` — empty `Text` → tool blocks only.
   Responses wire: `responses.rs` ~line 567 emits text only `if !t.is_empty()`.)

2. **The `system_text()` fold** (`ModelRequest::system_text`, `types.rs` line 53) — emits
   the folded system text only if non-empty (`if !system.is_empty()` in `openai.rs`
   line 537); empty fold → no leading `system` message. The `FreshChild` no-system-prompt
   path is documented in `core.rs` (`StartMode::FreshChild, None` arm): a child with no
   reduced message gets NO seq-0 row "Do NOT 'fix' this into an empty `prepend_system("")`"
   — the comment cites the wire fold omitting empty text.

3. **Subagent tool result text** — `harness/dispatch.rs`:
   `SubagentWait::Completed { output } => ToolResult { content: vec![ContentBlock::Text { text: output }], ... }`
   — `output` is the capture's final text, `""` when nothing was captured (§3). That
   `ToolResult` becomes the parent's next `tool`-role `ChatMessage.content`
   (`MessageContent::Text("")` allowed).

4. **`WorkerHandle::send_prompt(text, …)` / `Inbound::Prompt { text }`** — user payload
   arrives as `String` from the frontend; nothing validates non-emptiness in the Owns set.
   (`Prompt` handler in `core.rs` forwards to `PromptTurn { text, images }` verbatim.)

5. **`StartEnv.transcript`** (Resume) — `Vec<ChatMessage>` re-hydrated by the Supervisor;
   a stored empty-`Text` row (e.g. one LiteLLM already poisoned) replays verbatim via
   `loop_.load_transcript(messages)` (`core.rs` `(StartMode::Resume, _)` arm, ~line 320).

---

## 2. Where the sanitisation notice originates (grep evidence)

**The string is NOT produced anywhere in this repository.** It is injected upstream
(LiteLLM / proxy) and merely echoed through our transcript. Evidence:

### 2a. Grep across the Rust and TS/TSX trees — zero matches

```console
$ cd /home/daniel/Coding/AI/archimedes-desktop
$ grep -rn "Empty message content\|sanitised\|sanitiz\|Sanitiz" -ri src/ src-tauri/src/ 2>/dev/null | grep -v target
$ echo "=== grep exit: $? ==="
=== grep exit: 1 ===
```

Exit 1 = no match. Re-run case-insensitive across the whole tree except build dirs,
including all file extensions that could carry a Rust/Tauri string or frontend constant:

```console
$ grep -rn -i "empty message content\|sanitised\|sanitized" . \
      --include="*.rs" --include="*.ts" --include="*.tsx" --include="*.js" \
      --include="*.svelte" --include="*.toml" --include="*.lock" --include="*.md" \
      2>/dev/null | grep -v -E "target/|node_modules/|dist/|docs/roadmap" | head -20
$ echo "=== exit: $? ==="
=== exit: 0 ===
```

Exit 0 but **zero output lines** — no match anywhere (the only `.rs`/`.md`/`.ts` hit of
anything related is the frontend test `src/lib/ipcError.test.ts:33` — `"returns the empty
message of a messageless Error"` — an unrelated wording).

```console
$ grep -rn -i "sanitis\|sanitiz\|empty message" src/ --include="*.ts" --include="*.tsx" 2>/dev/null
=== exit 0 ===   (no output)
```

### 2b. Conclusion — category (i) of the dispatch brief

The placeholder is **injected by an upstream provider/gateway/LiteLLM** (it cannot be
(iii) "produced somewhere our grep missed" — no case variant, no split `format!` macro
string, no runtime concatenation exists in the tree, and the string is unique enough that
a `format!`-split would still be visible as fragments containing `sanitised` / `Empty
message`, of which there are none). No dependency crate in `Cargo.toml` manufactures
provider content. Therefore:

- The **inbound** half of the issue (silence the placeholder in responses) is client-side
  filtering of a string that only ever arrives from the network.
- The **outbound** half (don't send `content: ""` so LiteLLM never rewrites it) is in
  `harness/provider/openai.rs` `request_body` — **outside the Owns set** (§7), though the
  places where empty content is *built* (the `messages.push` in `loop.rs`, the capture in
  `subagent_flow.rs`) are partly inside it.

---

## 3. `subagent_flow.rs` — how a subagent result becomes a parent-visible message

Path: child Worker → child stdout `SinkFrame`s → Supervisor pump → `SubagentCapture` →
`SubagentOutcome` → parent's `SubagentResult` inbound → parent loop's `SubagentWait` →
`ToolResult` → parent transcript → next model request.

### 3a. Capture is the only text source (`SubagentCapture`, `subagent_flow.rs`)

```rust
/// The `SubagentCapture` (reviewer-corrected: capture from the subagent's
/// `SinkFrame` `session-update` stream — the enveloped `agent_message_chunk`
/// frames — the last-`messageId`-with-non-empty-text rule; ...
pub struct SubagentCapture {
    /// `messageId` → accumulated text ...
    text: StdMutex<HashMap<String, String>>,
    /// The LAST `messageId` with a non-empty capture ...
    last_message_id: StdMutex<Option<String>>,
    ...
}
```

The capture arm already has an emptiness guard (line ~225):

```rust
if let (Some(mid), Some(delta)) = (mid, delta) {
    if !delta.is_empty() && !is_bookkeeping_message_id(mid) {
        let mut text = self.text.lock().unwrap_or_else(|p| p.into_inner());
        text.entry(mid.to_string()).or_default().push_str(delta);
        *self.last_message_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(mid.to_string());
    }
}
```

`captured_text()` returns the last non-empty `messageId`'s accumulated text,
`""` when none:

```rust
pub fn captured_text(&self) -> String {
    let last = self.last_message_id.lock().unwrap_or_else(|p| p.into_inner()).clone();
    last.and_then(|id| {
        self.text.lock().unwrap_or_else(|p| p.into_inner()).get(&id).cloned()
    })
    .unwrap_or_default()
}
```

**If the only thing the child streamed was the placeholder text** (a LiteLLM-echoing
child — now impossible per §2, but historically the reported shape), the capture records
it as ordinary text; there is no value filter beyond the empty check.

### 3b. The drive folds the capture into the outcome (`drive_subagent`, races → outcome)

```rust
Race::Settled => {
    let (input_tokens, output_tokens) = capture.usage();
    let output = capture.captured_text();
    let metrics = SubagentMetrics {
        output: output.clone(),
        input_tokens,
        output_tokens,
        cost: capture.cost_usd(),
        duration_ms,
    };
    SubagentOutcome::Completed { output, metrics }
}
```

`failed_with_salvage` does the same for `Failed` (`output: capture.captured_text()`).

### 3c. The outcome crosses IPC into the parent (`send_subagent_result`)

```rust
fn send_subagent_result(
    state: &ManagerState,
    parent_session_id: &str,
    wire: &SubagentDispatchWire,
    outcome: SubagentOutcome,
) -> bool {
    let handle = state.workers.lock().unwrap_or_else(|p| p.into_inner())
        .get(parent_session_id).map(|e| e.handle.clone());
    let Some(handle) = handle else { return false; };
    handle.send_inbound_frame(Inbound::SubagentResult { id: wire.id.clone(), outcome }).is_ok()
}
```

### 3d. The parent loop turns the outcome into a tool-role message (`harness/dispatch.rs`, outside Owns)

```rust
match outcome {
    SubagentWait::Completed { output } => ToolResult {
        content: vec![ContentBlock::Text { text: output }],
        details: None,
        is_error: false,
    },
    ...
```

**The specific path where an empty result survives:** `Completed { output: "" }` →
`ToolResult { content: vec![Text { text: "" }] }` → that `ToolResult` becomes the next
`ChatMessage { role: Tool, content: MessageContent::Text("") }` in the parent's
transcript (`AgentLoop` tool-batch append) → `MessageContent::Text("")` → `"content": ""`
on the OpenAI wire → LiteLLM rewrites it (upstream) → placeholder leaks back into the
parent transcript. `Failed` with empty output is shielded by `salvage_text` (a bare
`"subagent failed: {error}"` — never empty), but `Completed` is not.

---

## 4. `core.rs` and `client.rs` — the request/response boundary

### 4a. Where the message list is finalised before send (OUTSIDE Owns, named for precision)

- `AgentLoop::model_request` (`harness/loop.rs`) builds the `ModelRequest` from
  `self.messages`.
- `OpenAiCompatibleProvider::complete` (`harness/provider/openai.rs`) calls
  `send_model_request` → `request_body(req, ask_usage)` — the single point that maps
  `ChatMessage`s to the OpenAI wire JSON (the issue's root-cause site).

### 4b. Response folded back into the transcript (OUTSIDE Owns, named for precision)

- `consume_stream` (`harness/loop/turn.rs` line ~131) — `ProviderEvent::TextDelta(d)` →
  `acc.text.push_str(&d)` + `emit(RpcEvent::message_update { … text_delta … delta })`.
  **No filtering of any substring of the delta exists here** — see verbatim snippet:

  ```rust
  ProviderEvent::TextDelta(d) => {
      acc.text.push_str(&d);
      self.emit(RpcEvent::message_update {
          usage: acc.usage_value(),
          assistant_message_event: json!({
              "type": "text_delta",
              "contentIndex": 0,
              "delta": d,
          }),
      });
  }
  ```

- `loop.rs` settle (~line 897) pushes the assistant `ChatMessage` and calls
  `persist_transcript_message` (in `harness/loop/emit.rs`):

  ```rust
  pub(super) fn persist_transcript_message(&self) {
      let len = self.messages.len();
      let m = self.messages.get(len - 1).cloned()
          .expect("a message was just pushed");
      let content_json = serde_json::to_string(&m).unwrap_or_default();
      if let Err(e) = self.store.insert_message(&self.session_id, (len - 1) as u64,
              role_str(m.role), &content_json) { eprintln!(...); }
  }
  ```

  `assistant_message_value`/`message_end`/`agent_end` (display wire) skip empty text
  already (`emit.rs` line ~54: `if !acc.text.is_empty() { content.push(json!({ "type": "text", "text": acc.text })); }`),
  but the **stored transcript** (`insert_message`) stores the full `ChatMessage` including
  the empty/poisoned text verbatim.

### 4c. The Owns-set boundaries (the worker IPC edges)

- **Outbound (worker → supervisor), `client.rs` `route_outbound`** — the single mapper
  from every `Outbound` frame to `WorkerInboundEvent`:

  ```rust
  fn route_outbound(frame: Outbound) -> Option<WorkerInboundEvent> {
      Some(match frame {
          Outbound::Ready { version, .. } => WorkerInboundEvent::Ready { version },
          Outbound::Event { event } => WorkerInboundEvent::Event(event),
          Outbound::TranscriptInsert { session_id, seq, role, content_json } =>
              WorkerInboundEvent::Store(StoreFrame::Insert { session_id, seq, role, content_json }),
          Outbound::TranscriptReplace { session_id, rows } =>
              WorkerInboundEvent::Store(StoreFrame::Replace { session_id, rows }),
          Outbound::DisplayUpsert { session_id, rows } =>
              WorkerInboundEvent::Store(StoreFrame::Display { session_id, rows }),
          Outbound::ContextUsage { session_id, used, window } =>
              WorkerInboundEvent::Store(StoreFrame::ContextUsage { session_id, used, window }),
          Outbound::PermissionRequest { id, payload } => WorkerInboundEvent::PermissionRequest { id, payload },
          Outbound::InteractiveRequest { id, payload } => WorkerInboundEvent::InteractiveRequest { id, payload },
          Outbound::SubagentDispatch { id, parent_session_id, parent_cwd, parent_enabled_tools,
              agent_name, name_resolution, launch, task, model_key } =>
              WorkerInboundEvent::SubagentDispatch(SubagentDispatchWire { ... }),
          ...
      })
  }
  ```

  `content_json` in `TranscriptInsert` is an opaque `String` here — this layer never
  parses message content. A filter placed at this seam (or in the pump / capture) would
  be the Owns-set location for "silence the placeholder in the subagent path".
- **Inbound (supervisor → worker), `core.rs handle`** — the match over `Inbound`
  (`Start`, `Prompt`, `Config`, `Abort`, `Compact`, `Close`, `PermissionResponse`,
  `InteractiveResponse`, `SubagentResult`, `FetchRenderResponse`, `Unknown`). The
  `SubagentResult` arm resolves the dispatch waiter:

  ```rust
  Inbound::SubagentResult { id, outcome } => {
      let mut waiters = self.subagent_waiters.lock().unwrap_or_else(|p| p.into_inner());
      if let Some(tx) = waiters.remove(&id) {
          let _ = tx.send(outcome);
      }
      Vec::new()
  }
  ```

  This is the exact boundary where a non-empty `output` guard on
  `SubagentOutcome::Completed` could be applied (it is also reachable in-process via
  `SubagentOutcomeSink::Oneshot`, `subagent_flow.rs` line 55 — same `outcome` type).

- **The `Start` arm** (`core.rs` line ~505) runs `build_loop`; the default path
  (`default_build_loop`, `core.rs` line 245) constructs `AgentLoop::new` with
  `build_provider(&env.model)`, then `(Resume, _)` → `loop_.load_transcript(messages)`
  and `(Fresh|FreshChild, Some(sp))` → `loop_.prepend_system(sp)`. This is where a
  Resume's stored `ChatMessage`s — including any already-poisoned empty/placeholder
  rows — enter the live loop.

---

## 5. Anything ALREADY implemented — overlaps the planner must not re-ship

| Symbol / site | What exists | Where |
|---|---|---|
| `ModelRequest::system_text()` | The single `System`-fold definition (ADR 0054); omits the system field when the fold is empty | `provider/types.rs:53` |
| `request_body` empty-system guard | `if !system.is_empty() { messages.push(...) }` — no empty `system` message ever sent | `provider/openai.rs:537` |
| Anthropic empty-`Text` guard | `if text.as_str().is_some_and(|s| !s.is_empty())` — empty assistant text → `tool_use` blocks only, NO empty `text` block | `provider/anthropic.rs:678` |
| Responses empty-text guard | `MessageContent::Text(t) if !t.is_empty() => Some(json!(...))` | `provider/responses.rs:567` |
| Empty-turn detection | A `FinishReason::Stop` with empty `text` AND empty `tool_calls` is NOT persisted — retried on the shared budget (`handle_empty_turn`, `turn.rs:295`); the pre-fix behaviour was "the 33-byte empty assistant row" — explicit guard comment at `loop.rs:860` | `harness/loop.rs` ~line 859; `harness/loop/turn.rs:295` |
| Display-wire empty skip | `assistant_message_value` only pushes text/thinking blocks when non-empty | `harness/loop/emit.rs:54` |
| `SubagentCapture` empty-delta guard | `if !delta.is_empty() && !is_bookkeeping_message_id(mid)` — empty chunks never captured | `manager/subagent_flow.rs:225` |
| Bookkeeping-id exclusion | `is_bookkeeping_message_id` (`{stamp}:system` / `{stamp}:retract:N` and bare forms) never captured as child output | `subagent_flow.rs` (fn in `manager/mod.rs`); pinned in tests |
| `salvage_text` empty-output guard | `if output.is_empty() { return format!("subagent failed: {error}"); }` — failed + empty output never renders a lying banner | `harness/dispatch.rs:383` |
| Frontend empty-body guards | `src/lib/transcript/reducer.ts`: `if (text === "") return messages;` for both `agent_message_chunk` and `agent_thought_chunk`; `normalize.rs` `agent_message_chunk` arm: `if text.is_empty() { return Vec::new(); }` | `src/lib/transcript/reducer.ts:128,146`; `src-tauri/src/agent/normalize.rs:674` |

**Not pre-shipped (still missing):** (a) any inbound filter of the literal placeholder in
`TextDelta`/captured text; (b) any `null`/omit for empty assistant `content` on the
OpenAI wire (`request_body`); (c) any emptiness guard on the `ChatMessage` **stored** row
or on `SubagentOutcome::Completed { output }` before it becomes a parent tool message.
The issue is open; there is no prior task in the repo's git log (`git log --oneline -8`
shows no #122 work).

---

## 6. The test file `manager/tests/mod.rs` — conventions

### 6a. How a worker/manager is constructed in tests

- Real `WorkerHandle::spawn` against a **fixture binary**: `fixture_path()` =
  `CARGO_MANIFEST_DIR/target/debug/fake_worker` (note: `cargo test` must have built the
  `bin` targets — the manager tests depend on `target/debug/fake_worker` existing;
  `src-tauri/src/bin/fake_worker.rs`, 1025 lines, contains canned scenarios keyed by task
  text — `__subagent__`, `__slow_subagent__`, `__subagent_tools__`, `__subagent_cost_0__`,
  `__crash_burst__`, `__long_stream__`, plus a `subagent-result` → `subagent-result-ack`
  round-trip).
- Seam: `WorkerFactory` trait — `FakeWorkerFactory` in tests vs
  `WorkerHandle::spawn(std::env::current_exe().as_path())` in production.
- `make_manager(dead_bound)` (line ~145) returns `(WorkerManager, CrashLog, EventLog,
  SinkMap)`; `make_stalling_manager(...)` (line ~186) adds the one-shot pump stall.
- The manager is created via `WorkerManager::new(factory, on_crash, on_event,
  sink_for)`; a parent session is registered with `manager.attach("id", &test_env("id",
  Some(enabled_tools))).await`; a child is dispatched via
  `dispatch_child_task(&manager, parent_id, task)` / `dispatch_child_task_with_id(...,
  "sub1")` (the `__cancel__` fixture cancels by dispatch id).
- Fixtures: `test_env(session_id, enabled_tools) -> StartEnv` (line ~80, fake `fake/m1`
  model + catalog); `register_sink(&sinks, sid) -> SinkEvents` (line ~292);
  `wait_for_event`, `subagent_result_outcome`, `subagent_result_outcome_after_ack`,
  `wait_for_closed`, `wait_for_child_id`, `wait_for_open_gate`, `emitted`.
- Observation points: the `on_event` `EventLog` (the `subagent-result-ack` frame carries
  the `SubagentOutcome` verbatim) and the parent-scope `CollectorSink` `SinkEvents`
  (`subagent-closed`, `subagent-session-started`, `interactive-request-close`,
  `session-update` frames).

### 6b. Representative test names (`#[tokio::test]` unless noted)

- `dispatch_subagent_spawns_a_subagent_and_delivers_the_result` (line 664) — the canonical
  outcome test; asserts `Completed { output: "canned answer", .. }`.
- `the_subagent_capture_captures_the_final_text_from_the_sink_frames` (`#[test]`, line 743).
- `every_failure_path_carries_the_partial_output_and_real_usage` (line 1366).
- `a_silent_child_with_nothing_in_flight_hits_the_dead_bound` (1167), `a_streaming_subagent_outlives_the_dead_bound` (1239).
- `a_real_zero_child_emits_null_metrics_and_a_parent_costs_zero` (2074).
- `the_started_payload_names_a_resolve_miss_and_pins_its_full_key_set` (2195).
- `worker_manager_with_hooks_invokes_custom_hooks` (2422).

### 6c. Existing empty-content tests

**None about empty message content.** The `"empty"` hits in this file are about empty
crash/event/session collections (`is_empty()` on `crashes`, `sub_events`,
`liveness_view`…). `subagent_flow.rs`'s own test module has `observe_sink_frame_still_ignores_unrelated_interactive_frames`
and capture-pin tests, and `harness/dispatch.rs` has
`a_failed_dispatch_with_no_output_omits_the_partial_output_banner`. There is **no** test
asserting `Completed { output: "" }` behaviour, and no test asserting a placeholder
string anywhere.

---

## 7. Integration points OUTSIDE the Owns set — must NOT be edited, must be compatible

Same-process harness (the actual request/response origin and sink):
- `src-tauri/src/agent/harness/loop.rs` — `AgentLoop::model_request`, `run`/settle
  (`messages.push(ChatMessage …)`, `persist_transcript_message`), empty-turn guard.
- `src-tauri/src/agent/harness/loop/turn.rs` — `consume_stream` (the `TextDelta`
  passthrough), `handle_empty_turn`.
- `src-tauri/src/agent/harness/loop/emit.rs` — `emit`, `assistant_message_value`,
  `persist_transcript_message`, `emit_cost_update`.
- `src-tauri/src/agent/harness/provider/openai.rs` — `request_body`, `SseStream`
  (`handle_chunk` emitting `TextDelta`s). **The issue's root-cause file.**
- `src-tauri/src/agent/harness/provider/types.rs` — `MessageContent::to_wire`,
  `ModelRequest::system_text`, `ChatMessage` (serde shape used for the stored transcript).
- `src-tauri/src/agent/harness/provider/mod.rs` — `build_provider`.
- `src-tauri/src/agent/harness/dispatch.rs` — `SubagentWait` → `ToolResult` mapping,
  `salvage_text`.
- `src-tauri/src/agent/normalize.rs` — `RpcEvent::message_update` →
  `agent_message_chunk` frames (line ~200) and the `agent_message_chunk` display-row
  arm (line ~674, already empties-guarded).
- `src-tauri/src/agent/events.rs` — `RpcEvent` vocabulary (`text_delta`, `message_update`).

**The frontend DOES render these messages — if the task's "silence" is meant to keep the
placeholder out of the visible transcript, that is NOT Rust-only:**

- `src/components/MessageBubble.tsx` (872 lines; default-memo `MessageBubble`, `case
  "agent-text": return <AgentText text={message.text} />;` renders agent text; the
  component header file-comment is the UI-convention doc). `src/components/MessageList.tsx`
  lists bubbles; `src/components/ChatStream.tsx` wires updates; `src/components/SubagentTranscript.tsx`
  renders subagent text.
- `src/lib/transcript/reducer.ts` — `applySessionUpdate` is the pure reducer for
  `session-update` frames; its `agent_message_chunk` arm already drops `text === ""` but
  passes any non-empty text (placeholder included) into the `Message[]` store. The Rust
  `normalize.rs` arm is the mirror (`if text.is_empty() { return Vec::new(); }`).
- `src/store/sessions.ts` — `applySessionUpdate` delegate; `src/store/interactive.ts` —
  the `requestId`-exact match filtering relevant to the ADR 0055 gate teardown frames.
- The **persisted** transcript (DB) is written from the harness store
  (`Store::insert_message`, IPC as `Outbound::TranscriptInsert`, applied by the
  Supervisor's `TranscriptPersister`) — a silent-assistant fix that only filters
  *display* would still leave poisoned rows in the stored transcript that a Resume
  (`core.rs` `(Resume, _)` arm) would replay into the next request.

So: a full fix likely touches files outside the Owns set *or* must be narrowly justified
at one of the Owns-set seams (e.g. the `core.rs` `SubagentResult` arm / `subagent_flow.rs`
capture/delivery, plus a frontend/`normalize` filter for display-only), and the planner
should decide — and record in the plan — which files leave the Owns set and how the
no-edit constraint is honoured for the rest. This report only grounds; it does not choose.

---

## 8. Verification commands

From the repo root:

```bash
cd /home/daniel/Coding/AI/archimedes-desktop

# The Owns set's unit + integration tests:
cargo test -p app --lib agent::worker::core          --manifest-path src-tauri/Cargo.toml
cargo test -p app --lib agent::worker::protocol     --manifest-path src-tauri/Cargo.toml
cargo test -p app --lib agent::worker::manager      --manifest-path src-tauri/Cargo.toml
cargo test -p app --lib agent::worker::worker       --manifest-path src-tauri/Cargo.toml   # (client.rs, if its tests live under this module name)
```

From within `src-tauri/`:

```bash
cd src-tauri
cargo test --lib agent::worker::core
cargo test --lib agent::worker::protocol
cargo test --lib agent::worker::manager          # requires ./target/debug/fake_worker (bin targets)
cargo test --bin fake_worker
cargo test --lib agent::harness::provider        # provider request-body/SSE pins; issue's acceptance criteria live here
cargo test --lib agent::harness::r#loop          # turn/emit/empty-turn pins
cargo test --lib agent::normalize
cargo test --lib agent::harness::dispatch        # salvage_text pins
cargo test --lib agent::harness::compact         # compaction / transcript-shape pins (ADR 0054)
```

Notes:
- The package name is `app` (verify with `cargo metadata` if uncertain); the manager
  tests compile the `fake_worker` bin, so a bare `cargo test --lib agent::worker::manager`
  needs the bin targets built first (a normal `cargo test` builds them; a fresh
  `cargo test --lib` alone may not — build with `cargo build --bin fake_worker` first if
  the fixture path is missing).
- Frontend (if a display-side filter is ever considered): `npm run test` / the
  targeted suites for `src/lib/transcript/reducer.*` — **this is doc-only; the Rust
  provider/manager decisions must not depend on it being green unless the plan edits
  frontend files.**
- Skip `target/` when grepping (all greps in §2 exclude it).

---

## 9. Sources

- Issue #122 body: `gh issue view 122 --repo danielcherubini/archimedes --json body`
  (quoted verbatim in §0; LiteLLM link: `litellm/litellm_core_utils/prompt_templates/factory.py`).
- `docs/decisions/0054-the-system-message-fold-belongs-to-the-wire-not-the-transcript.md`
- `src-tauri/src/agent/harness/provider/types.rs` (lines 18–150)
- `src-tauri/src/agent/harness/provider/openai.rs` (lines 432–620: `request_body`; 230–270: `SseStream::handle_chunk`)
- `src-tauri/src/agent/harness/provider/anthropic.rs` (line ~670–680)
- `src-tauri/src/agent/harness/provider/responses.rs` (line ~560–575)
- `src-tauri/src/agent/harness/loop.rs` (lines ~820–910)
- `src-tauri/src/agent/harness/loop/turn.rs` (lines 131–170, 295–330)
- `src-tauri/src/agent/harness/loop/emit.rs` (lines 40–130)
- `src-tauri/src/agent/harness/dispatch.rs` (lines 222–395)
- `src-tauri/src/agent/normalize.rs` (lines 195–230, 660–705)
- `src-tauri/src/agent/worker/core.rs` (lines 245–505: `default_build_loop` + `handle`)
- `src-tauri/src/agent/worker/client.rs` (lines 747–830: `route_outbound`; 283–580: `WorkerHandle`)
- `src-tauri/src/agent/worker/protocol.rs` (lines 29–400: `Inbound`/`Outbound`/`StartEnv`)
- `src-tauri/src/agent/worker/manager/subagent_flow.rs` (lines 55–290 capture; 531–845 dispatch; 845–1135 drive; 1135–1340 finish/deliver)
- `src-tauri/src/agent/worker/manager/tests/mod.rs` (lines 1–500 helpers; 664, 743, 2074, 2195 exemplars)
- `src-tauri/src/agent/worker/manager/pump.rs`
- `src-tauri/src/bin/fake_worker.rs`
- `src/lib/transcript/reducer.ts` (lines 100–155)
- `src/components/MessageBubble.tsx`
- `src/store/sessions.ts`