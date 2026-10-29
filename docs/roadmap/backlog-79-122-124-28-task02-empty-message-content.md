# A2 — #122: silence the empty-content sanitisation notice & guard empty message content

- **Branch:** `feature/backlog-79-122-124-28` (HEAD `f5ba339`)
- **Spec:** GitHub issue **#122** (`danielcherubini/archimedes`); grounding: `docs/roadmap/backlog-79-122-124-28-ground-worker-wire.md`
- **ADR 0054 governs placement:** `docs/decisions/0054-the-system-message-fold-belongs-to-the-wire-not-the-transcript.md` — the reservation holds that wire **shape** is corrected on the wire, at the request-build site (`request_body`), never by re-labelling the durable transcript.

## 1. Problem (& where each half lives)

The string `[System: Empty message content sanitised to satisfy protocol]` is **not produced anywhere in this repo** (grounding §2 — grep across `src/`, `src-tauri/src/`, all case variants: zero hits). It is injected **upstream** by LiteLLM's `_sanitize_empty_text_content` (`factory.py`, `modify_params=True`) when a message with empty/whitespace `str` content passes through it. Two halves, two seams:

1. **OUTBOUND — stop emitting `content: ""`** (root-cause §1 of the issue): an assistant message with only tool calls serialises `MessageContent::Text("")` → `"content": ""` on the OpenAI-compatible wire (`MessageContent::to_wire()` in `provider/types.rs`; inserted verbatim by `request_body` in `harness/provider/openai.rs`). LiteLLM then rewrites it — so the placeholder is *created by our outbound shape*.
2. **INBOUND — filter whatever a proxy/model still returns** (root-cause §3): when LiteLLM streams the placeholder back, `consume_stream` in `harness/loop/turn.rs` pushes every `TextDelta` into `acc.text` and forwards it as `message_update { delta }` (and hence `agent_message_chunk` → transcript + UI) **untested**.
3. **In scope (Owns-set):** `SubagentOutcome::Completed { output: "" }` currently survives unguarded into the parent's transcript as a `tool`-message `Text("")` (dispatch.rs `Completed` arm creates `ToolResult { content: [Text { text: output }] }`); only `Failed` is shielded by `salvage_text` (dispatch.rs:383, `if output.is_empty()`). Grounding §3d and §1c(3) document the exact leakage.

**Scope (fixed, already approved, do not widen):** the fix is **Rust-side**. "Filtering inbound" means the frontend never receives the placeholder. **No frontend edits** (`src/lib/transcript/reducer.ts`, `src/components/MessageBubble.tsx`).

## 2. Known limitation (honest) — legacy transcripts

Transcripts persisted **before this fix** may already contain the placeholder text (`persist_transcript_message` stored the full `ChatMessage` including the poisoned text, and the frontend's `agent_message_chunk` arm only drops `text === ""` — a non-empty placeholder passes through). This plan does **not** add a migration/rewrite of stored rows: the repo rule is *"prefer the cheap correct-enough fix plus an honest recorded limitation over the expensive complete one."* Consequence, stated: **a room/prompt replayed from a pre-fix transcript will still render the placeholder**; new turns after this fix will not produce or relay it. Follow-up if the product wants it: a stored-row scrub on `Resume`/`load_transcript` (belongs to a future task; would require editing `harness/loop.rs` or `store.rs`, both outside the Owns set — flagged in §8).

## 3. Owned file set (edit ONLY these)

| File | What moves here |
|---|---|
| `src-tauri/src/agent/harness/loop/turn.rs` | The shared constants + predicate (`EMPTY_CONTENT_SANITISE_PLACEHOLDER` / `content_is_effectively_empty`) and the inbound filter applied to `TextDelta` in `consume_stream` (the cross-wire bolt — every non-OpenAI wire reaches this single choke point). |
| `src-tauri/src/agent/harness/provider/openai.rs` | `request_body` outbound guard: empty/whitespace `Text` → omit `"content"` on assistant messages (never a bare `""`); the SSE-side split-safe filter of record (`handle_chunk` + the `SseStream` flush, §5.3); its `#[cfg(test)] mod tests` already holds the request-body + SSE pins. |
| `src-tauri/src/agent/worker/core.rs` | `SubagentResult` arm: guard `Completed { output }` → non-empty before the waiter is resolved (Requesting-Worker path). |
| `src-tauri/src/agent/worker/client.rs` | `route_outbound`: guard the `TranscriptInsert` assistant row against empty/placeholder `content` before it reaches the store (the Supervisor-side belt). **Not** the `TranscriptReplace` arm — that clamp is deferred (§8, follow-up F3). |
| `src-tauri/src/agent/worker/manager/subagent_flow.rs` | `drive_subagent` `Race::Settled`: `Completed { output: "" }` → `Failed { reason: Other, error: …, output: "" }` with honest marker text; tests live in its inline `mod tests`. |
| `src-tauri/src/agent/worker/manager/tests/mod.rs` | The end-to-end pin: `__subagent__` fixture (empty result) ⇒ the outcome the requester receives is `Failed` with the marker text, `Completed { output: "" }` never crosses the wire. |
| `src-tauri/src/agent/harness/loop/tests/turn_lifecycle.rs` | The loop-level inbound filter pins (already declared in the barrel: `harness/loop/tests/mod.rs:10 mod turn_lifecycle;`). |

**Belt trim (round-2 review, adopted):** the placeholder can enter the transcript through exactly two producer paths — the main loop's `consume_stream` (`loop.rs:838` is the single caller) and the subagent capture (§5.4/§5.5) — so the fix keeps a *filter of record* (SSE `handle_chunk`, §5.3, turns the split case into exact-match) plus **two** exact-match belts: the `consume_stream` cross-wire bolt (§5.1) and the `request_body` outbound guard (§5.2), plus the two subagent guards (§5.4/§5.5). The `TranscriptReplace` store-row clamp and the JSON-parsing `clamp_empty_text_with_tool_calls` helper are **dropped** from this task and recorded as follow-up F3 (§8) — the `Insert` half of the store-row belt is kept because it is the only seam outside the harness that can observe a transport-carrying child's poisoned row, and its replacement is a self-contained pure test. Four seams remain where the original proposed four-plus-two; each is load-bearing (§9 "Why these four seams").

**Do NOT touch** `src-tauri/src/agent/harness/loop/tests/mod.rs` (barrel, sibling-shared) — no new test files either; extra tests go into `turn_lifecycle.rs`, the inline `#[cfg(test)] mod tests` of `openai.rs`, and the existing `manager/tests/mod.rs`.

## 4. The shared strings (new, defined once in `turn.rs`)

```rust
/// (issue #122) The literal placeholder LiteLLM's `_sanitize_empty_text_content`
/// (factory.py, `modify_params=True`) substitutes for empty/whitespace string content.
/// It is PRODUCED UPSTREAM — this repo's transcripts only ever *echo* it — so both
/// the inbound stream filter and the outbound `request_body` guard key on this one
/// definition. The guard never relies on the string alone (see `content_is_effectively_empty`).
pub(super) const EMPTY_CONTENT_SANITISE_PLACEHOLDER: &str =
    "[System: Empty message content sanitised to satisfy protocol]";

/// True when a content fragment is nothing the model/user ever meant to say:
/// empty-ish, or the upstream sanitisation placeholder (optionally wrapped in
/// mention-ish brackets/`*`s — pasted straight into `#[cfg(test)]` as the
/// `sse_…` raw-chunk literals, the assertion stays on the CONSTANT).
pub(super) fn content_is_effectively_empty(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.is_empty()
        || trimmed.replace(['*', '`'], "").trim() == EMPTY_CONTENT_SANITISE_PLACEHOLDER
}
```

**Why both halves key on these:** the SSE parser in `openai.rs` must reassemble a placeholder that arrives split across deltas and reconstruct it before matching, while `request_body` only ever sees whole `MessageContent::Text` values (placeholder / whitespace). One definition, and `turn.rs` is the shared lowest-level home for it (single package `archimedes`, lib `archimedes_lib` — the harness and the worker are modules of the same crate).

## 5. Changes by file

### 5.1 `src-tauri/src/agent/harness/loop/turn.rs` — the inbound filter (main path)

**Signature (existing, quote):**

```rust
pub(super) async fn consume_stream(
    &mut self,
    stream: &mut (impl futures_util::Stream<Item = ProviderEvent> + Unpin),
    turn: &CancellationToken,
    acc: &mut TurnAccumulator,
) -> Option<ProviderError>
```

**The only arm that changes** (turn.rs:131, the verbatim block):

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

**Becomes** — accumulate into the accumulator **only when the delta is not sanitisation-only**; a placeholder/whitespace delta is dropped entirely (never emitted, so the frontend never sees it; never accumulated, so it is never persisted — `acc.text` is the ONLY thing that becomes `MessageContent::Text(acc.text.clone())` at loop.rs:897):

```rust
ProviderEvent::TextDelta(d) => {
    // (issue #122) The upstream sanitisation placeholder must never enter
    // the transcript, the store, or the user's eyes. FILTER HERE:
    // `content_is_effectively_empty` is the exact placeholder (or
    // whitespace) — such a delta is dropped entirely, neither emitted (the
    // frontend never sees it) nor accumulated (it is never persisted).
    //
    // EXACT-MATCH ONLY, deliberately: a placeholder SPLIT across deltas is
    // reassembled and silenced by the OpenAI wire's SSE parser
    // (`openai.rs handle_chunk` — the filter of record, which sees the whole
    // delta stream). This guard is the fast path for the common case (the
    // whole placeholder in one chunk) and the bolt for the other wires
    // (Anthropic / Responses emit their text as whole parts through
    // `TextDelta`). Partial fragments of the literal are never matched here —
    // a run like `"[Sys"` streams, and a referenced banner in a longer line
    // streams too. The caveat lives on the SSE seam's byte-exact case, not
    // here: see §5.3's "recorded exact-match trade-offs" (a message that is
    // EXACTLY the placeholder verbatim is dropped at every exact-match seam).
    if !content_is_effectively_empty(&d) {
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
}
```

**Ordering with issue #64** (turn.rs:295 `handle_empty_turn`): a placeholder-only turn now accumulates NO text, so `acc.finish == Stop && acc.text.is_empty() && tool_calls.is_empty()` — the genuine empty-turn condition — matches, and the turn is retried on the shared budget exactly as a normal empty turn, persisting nothing. The filter runs inside `consume_stream`, i.e. BEFORE the empty-turn check at loop.rs:881. This is a *desired* interaction: a placeholder-only model reply is not a successful turn.

### 5.2 `src-tauri/src/agent/harness/provider/openai.rs` — outbound `request_body` guard

**Signature (existing, quote):**

```rust
fn request_body(req: &ModelRequest, ask_usage: bool) -> Value
```

**One insertion** at the `content` line (openai.rs: `obj.insert("content".to_string(), m.content.to_wire());`):

```rust
// (issue #122) An empty/whitespace assistant message must never send
// `"content": ""` on the OpenAI-compatible wire — LiteLLM's
// `_sanitize_empty_text_content` would rewrite it into the placeholder and
// SAVE that back into history, which is the root cause of the leaked
// `[System: Empty message content sanitised to satisfy protocol]` banner.
// `isinstance(content, str)` is false for an OMITTED field, so omitting it
// (per the OpenAI contract — `"content"` is not required on an assistant
// message that carries `tool_calls`) keeps LiteLLM's sanitizer a no-op.
// Shaping here, not in the transcript: ADR 0054 — the fold and the wire
// vocabulary live where the request is built. A `tool` message with empty
// text is untouched (its `"content"` is required to pair with `tool_call_id`).
let empty_text = match &m.content {
    MessageContent::Text(t) => content_is_effectively_empty(t),
    MessageContent::Blocks(_) => false,
};
if !(empty_text && m.tool_calls.is_some()) {
    obj.insert("content".to_string(), m.content.to_wire());
}
```

**Exact-emit rules that the test pins** (keep the plan's signal crisp):

| `m.content` | `m.tool_calls` | result |
|---|---|---|
| `Text("")` / whitespace / placeholder | `Some` | `"content"` **omitted** (never `""`) |
| `Text("")` / whitespace / placeholder | `None` | `"content": ""` **kept** — shape is the transcript's; the empty-assistant turn is separately retried by issue #64 (`handle_empty_turn`) and never becomes a wire round-trip |
| `Blocks(…)` | either | unchanged (arrays pass `isinstance(content, str)` false at LiteLLM — no sanitisation hazard) |
| `Text("real")` | either | unchanged |

**Tests — all in the existing inline `#[cfg(test)] mod tests` of `openai.rs`** (no new file):

1. `request_body_omits_content_for_an_empty_text_assistant_message_with_tool_calls` — build the same `ModelRequest` as `request_body_serializes_tool_calls_in_the_openai_wire_shape` (empty `ToolCall` message) and assert `body["messages"][0].get("content").is_none()`; also a whitespace variant and a placeholder variant.
2. `request_body_keeps_content_for_an_empty_text_assistant_message_without_tool_calls` — `Text(String::new())`, `tool_calls: None` ⇒ `body["messages"][0]["content"] == ""` (guard rail — the shape, not the sanitisation, decides).
3. The SSE inbound tests live below (§5.3, same inline module): **`sse_streamed_placeholder_content_is_silenced`** and **`sse_does_not_silence_legitimate_content`** — this is their ***only*** spelling anywhere in this plan (see §5.3, §6, and the Acceptance list).

### 5.3 `src-tauri/src/agent/harness/provider/openai.rs` — inbound SSE-side (the split-safe filter of record)

**Live site (`handle_chunk`, quoted):**

```rust
if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
    self.pending.push_back(ProviderEvent::TextDelta(text.to_string()));
}
```

**Extend** — the SSE parser is the **filter of record**: it sees the whole `delta.content` stream, so it can reassemble a placeholder split across chunks and drop it *before* it ever becomes a `TextDelta`. Algorithm: **hold only while the accumulated run is a strict prefix of the placeholder; release (or drop) the moment it diverges.** This makes the split case exact and the normal case byte-identical to today:

1. **New field** on `SseStream`: `stream_text_accum: String` (initialised `String::new()` in `SseStream::new`). It never grows past a placeholder-sized prefix + one chunk.
2. **In `handle_chunk`**, replace the single-delta emit (openai.rs ~330) with:

```rust
if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
    self.stream_text_accum.push_str(text);
    if content_is_effectively_empty(&self.stream_text_accum) {
        // (issue #122) The accumulated run IS the placeholder (possibly split
        // across chunks, plus trailing whitespace) — silenced here, at the
        // parse seam. It never becomes a `TextDelta`, so the loop, the
        // transcript, and the UI never see it.
        self.stream_text_accum.clear();
    } else if self.stream_text_accum.len() < EMPTY_CONTENT_SANITISE_PLACEHOLDER.len()
        && EMPTY_CONTENT_SANITISE_PLACEHOLDER.starts_with(&self.stream_text_accum)
    {
        // A STRICT prefix of the placeholder — might still be the split
        // placeholder's head, so hold it for the next chunk. Buffer size is
        // bounded by the placeholder's own length (≤ 62 chars).
    } else {
        // Diverged from the placeholder (or was never related): release what
        // accumulated as ONE `TextDelta`, exactly as if it had streamed.
        let text = std::mem::take(&mut self.stream_text_accum);
        self.pending.push_back(ProviderEvent::TextDelta(text));
    }
}
```

3. **Flush the held run at turn close** — a strict-prefix fragment (e.g. a legit message that merely *starts* with `"["`) must not be lost when the stream ends without completing the placeholder: in the `finish_reason` branch (before `Done`) and in `Poll::Ready(None)`'s tail path, release the accumulator if it holds anything (`content_is_effectively_empty` → drop, else emit as one `TextDelta`). **The flush site carries its own comment** (the round-2 review asked for the seam to say what it is):

```rust
// (issue #122) FLUSH SEAM: the stream ended with a held strict-prefix
// fragment (or a `finish_reason` arrived). `stream_text_accum` may hold
// a real message's head that merely started like the placeholder (e.g.
// "["), plus — only when the WHOLE stream was a placeholder prefix —
// the whole held placeholder. Release or drop it NOW: a strict prefix of
// the placeholder can be held until stream end, and a provider that
// stalls mid-prefix holds ALL of its text on this run, so every flush
// site releases (or drops) whatever is held, and `poll_next` never
// returns `None` while `stream_text_accum` is non-empty.
if content_is_effectively_empty(&self.stream_text_accum) {
    self.stream_text_accum.clear();
} else if !self.stream_text_accum.is_empty() {
    let text = std::mem::take(&mut self.stream_text_accum);
    self.pending.push_back(ProviderEvent::TextDelta(text));
}
```

(There is no separate unbounded hold: the accumulator only ever contains a strict prefix of the placeholder — at most `EMPTY_CONTENT_SANITISE_PLACEHOLDER.len() - 1` chars — until the single diverging chunk is appended. The worst-case hold is therefore **one placeholder prefix + one chunk ≤ ~2 × 62 chars per turn**, and it is bounded even if the provider splits mid-token forever. The worst-case *delay* is the real trade-off, not the size: **a provider that stalls mid-prefix leaves every streamed run of that turn (up to the whole message if it starts like the placeholder) held on this run until the stream ends or the next chunk arrives** — recorded in §9 as the known hold limitation.)

**Correctness argument (why this cannot eat real content):** the hold happens only while the accumulated run is a strict PREFIX of the placeholder — a genuine message either diverges immediately (released per-chunk, byte-identical to today) or diverges at the first character that cannot be the placeholder's continuation. Every delta is released in its original order; the only observable difference is that a few leading chunks of a message that STARTS like the placeholder coalesce into one `TextDelta` (downstream only appends to `acc.text` — chunk granularity is invisible).

**The recorded exact-match trade-offs (round-2 review, corrected):** at the SSE seam, a text whose *entire accumulated run* equals the placeholder is dropped — this covers BOTH the upstream notice AND **a user literally typing the placeholder as their prompt** (a user message is read from the transcript, so a user *prompt* travels OUTBOUND, never through this SSE *inbound* parser — but a model echoing the literal, a proxied transcript replay, or any inbound text that happens to be exactly the banner is dropped). The older claim that "a user quoting the banner is untouched" is **false at this seam**: a message that is EXACTLY the placeholder verbatim is dropped by `content_is_effectively_empty`. The infinitely-likely case — a user *referencing* the banner inside a longer line ("what does `…sanitised to satisfy protocol]` mean?") — diverges at the first non-prefix character and streams untouched (it cannot be a strict prefix of the placeholder, so it is never held). §9 records the exact-match trade-off explicitly. (The subagent seams §5.4/§5.5 share the same exact-match property: a child whose *entire* output equals the placeholder becomes `Failed` — the whole-output check, never a substring match.)

**Tests (inline `#[cfg(test)] mod tests`, `sse_stream(&[…])` raw chunks):**

```rust
#[tokio::test]
async fn sse_streamed_placeholder_content_is_silenced() {
    let events = collect(sse_stream(&[
        // LiteLLM splits the string mid-token across TWO `delta.content` fragments.
        "data: {\"choices\":[{\"delta\":{\"content\":\"[System: Empty message \"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"content sanitised to satisfy protocol]\"},\"finish_reason\":\"stop\"}]}\n\n",
    ]))
        .await;
    assert_eq!(
        events,
        vec![ProviderEvent::Done(FinishReason::Stop)],
        "the split placeholder is reconstructed and SILENCED (no `TextDelta`)"
    );
}
```

```rust
#[tokio::test]
async fn sse_does_not_silence_legitimate_content() {
    let events = collect(sse_stream(&[
        "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"llo\"},\"finish_reason\":\"stop\"}]}\n\n",
    ]))
        .await;
    assert_eq!(
        events,
        vec![
            ProviderEvent::TextDelta("hello".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ],
        "split TERMINAL deltas still stream (the `he`/`llo` split reaches the UI)"
    );
}
```

### 5.4 `src-tauri/src/agent/worker/manager/subagent_flow.rs` — stop `Completed { output: "" }` from crossing the IPC

**Site: `drive_subagent`'s `Race::Settled` arm (quoted in the grounding §3b):**

```rust
Race::Settled => {
    let (input_tokens, output_tokens) = capture.usage();
    let output = capture.captured_text();
    let metrics = SubagentMetrics { … };
    SubagentOutcome::Completed { output, metrics }
}
```

**Becomes** — local `let`, no early `return` (the arm is an expression producing the outcome value):

```rust
Race::Settled => {
    let (input_tokens, output_tokens) = capture.usage();
    let output = capture.captured_text();
    if content_is_effectively_empty(&output) {
        // (issue #122) A child that SETTLED with no text (or only the
        // sanitisation placeholder) must not deliver `Completed { output: "" }`
        // to the parent: dispatch.rs would build `ToolResult { text: "" }` and
        // the parent's NEXT request would carry `"content": ""` (the wire the
        // root cause runs through). It becomes a `Failed` with the honest
        // marker text — `subagent-closed` still fires `status: "failed"` and
        // the child's metrics are preserved on the `Failed` path.
        SubagentOutcome::Failed {
            // `Other`, NOT `Cancelled`: the child was not stopped — it
            // settled. `Cancelled` is reserved for a parent/user Stop (the
            // ADR-0055 meaning), and a `Failed` here must never read as one.
            reason: SubagentFailureReason::Other,
            error: "the subagent settled with no output".to_string(),
            output: String::new(),
            metrics: SubagentMetrics {
                output,
                input_tokens,
                output_tokens,
                cost: capture.cost_usd(),
                duration_ms,
            },
        }
    } else {
        SubagentOutcome::Completed { output, metrics }
    }
}
```

(`metrics` construction is hoisted above the `if`; only the branch differs. **No guard on the `Failed` path** — its `output` already rides `captured_text()` and the parent's `salvage_text` shields the empty case (dispatch.rs:383). The non-`Settled` arms (`Dead`/`Cancelled`/`Exited`) already go through `failed_with_salvage`, which can never produce an empty `Completed`.)

### 5.5 `src-tauri/src/agent/worker/core.rs` — belt on the `SubagentResult` inbound arm

**Existing arm (quoted, core.rs:667):**

```rust
Inbound::SubagentResult { id, outcome } => {
    let mut waiters = self.subagent_waiters.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(tx) = waiters.remove(&id) {
        let _ = tx.send(outcome);
    }
    Vec::new()
}
```

**Add at the top (defence in depth — 5.4 is the normal path; a stale/malformed Worker still cannot deliver an empty `Completed`):**

```rust
Inbound::SubagentResult { id, outcome } => {
    // (issue #122) Guard the inbound edge too: a `Completed { output: "" }`
    // that somehow reaches a WAITER (a stale Worker, a race with 5.4's
    // settle) must become the honest `Failed` — an empty `Completed` would
    // become a parent `tool` message with `Text("")` and poison the next request.
    // Exact-match only (`content_is_effectively_empty` — never a substring
    // match): a child legitimately ending its answer with the placeholder
    // sentence keeps it, per the repo's don't-filter-too-much rule (§9).
    let outcome = match outcome {
        SubagentOutcome::Completed { output, metrics }
            if content_is_effectively_empty(&output) =>
        {
            SubagentOutcome::Failed {
                reason: SubagentFailureReason::Other,
                error: "the subagent settled with no output".to_string(),
                output: String::new(),
                metrics,
            }
        }
        other => other,
    };
    …unchanged…
}
```

### 5.6 `src-tauri/src/agent/worker/client.rs` — `route_outbound` store-row belt (the **`Insert` half only**)

**Existing arm (quoted):**

```rust
Outbound::TranscriptInsert { session_id, seq, role, content_json } =>
    WorkerInboundEvent::Store(StoreFrame::Insert { session_id, seq, role, content_json }),
```

**Amend** — clamp the store row **without parsing**: the parse-free rule *"an `assistant` row whose serialized content is the sanitization placeholder must not reach the store"* (see the trade-off below). The row arrives as opaque `content_json` (the `ChatMessage` serde shape); the clamp replaces the placeholder JSON *only when it appears as the entire content value*, and leaves everything else byte-identical:

```rust
Outbound::TranscriptInsert { session_id, seq, role, content_json } => {
    // (issue #122) Belt at the store seam: a persisted placeholder row
    // re-enters the live loop on a Resume (`core.rs (Resume, _) →
    // load_transcript`) and would be re-sent to the wire. Clamp WITHOUT
    // parsing: the only shape the sanitizer rewrites is an assistant row
    // whose content is exactly the placeholder string, and that string is
    // a fixed, non-closing-boundary literal ("`" / "*" are stripped by the
    // predicate, and the `]` cannot legally appear mid-JSON as a bare
    // content value), so a whole-value match is AST-exact in practice.
    let content_json = clamp_placeholder_row(&role, content_json);
    WorkerInboundEvent::Store(StoreFrame::Insert { session_id, seq, role, content_json })
}
```

with a private helper in `client.rs` (no serde import is needed — this never parses `ChatMessage`; **the JSON-parsing `clamp_empty_text_with_tool_calls` variant the first-round plan proposed is dropped**, see the trade-off note):

```rust
/// (issue #122) The store-row belt, PARSE-FREE: an `assistant` row whose
/// serialized content is the sanitization placeholder is replaced with the
/// canonical empty-`Text` row JSON. The placeholder string is a fixed,
/// self-identifying literal that cannot collide mid-JSON (see the header
/// comment) — so a whole-value byte match on the `"content": "…"` region
/// is exact in practice. Anything else passes through byte-identical.
fn clamp_placeholder_row(role: &str, content_json: String) -> String {
    if role != "assistant" { return content_json; }
    let needle = format!(
        // The serde-canonical row shape for an assistant message with an
        // empty `Text` content (what `persist_transcript_message` writes
        // for `Text("")` — the field order is serde-stable for this type).
        "\"content\":\"{}\"",
        serde_json::escape(EMPTY_CONTENT_SANITISE_PLACEHOLDER),
    );
    if content_json.contains(&needle) {
        content_json.replace(&needle, "\"content\":\"\"")
    } else {
        content_json
    }
}
```
(Note the belt's scope, deliberately narrow: it mirrors 5.2 only for the **placeholder** string — an `assistant` row whose content is `Text("")` is **not** clamped here; the empty-`Text`-with-zero-root-cause belongs to the outbound wire guard (5.2) and to `handle_empty_turn`, and the summary of what a stored empty row does is recorded in §9. The `TranscriptReplace` arm is **not** clamped in this task — see follow-up F3 in §8.)

### 5.7 `manager/tests/mod.rs` — end-to-end pin

New `#[tokio::test]` (in the existing module, next to the `__subagent__` example test around line 664):

```rust
/// (issue #122) A child that SETTLED with NO text (the `__subagent__` fixture
/// emits `agent_settled` with no `agent_message_chunk`) must NOT deliver
/// `Completed { output: "" }` to the parent — the empty `Completed` would
/// become a `tool`-message `Text("")` and a `"content": ""` on the parent's
/// next OpenAI request (the wire the sanitisation placeholder's root cause
/// runs through). It arrives as the honest `Failed { output: "" }` instead.
#[tokio::test]
async fn a_silent_child_that_settled_is_not_completed_empty() {
    let (manager, _crashes, events, _sinks) = make_manager(Some(Duration::from_secs(30)));
    manager.attach("p1", &test_env("p1", Some(vec!["bash".to_string()]))).await
        .expect("the parent attach completes");
    dispatch_child_task(&manager, "p1", "__subagent__");
    let outcome = subagent_result_outcome_after_ack(&events, "p1").await;
    match outcome {
        SubagentOutcome::Completed { .. } =>
            panic!("an empty-result child is never `Completed`"),
        SubagentOutcome::Failed { reason, error, output, .. } => {
            assert_eq!(reason, SubagentFailureReason::Other);
            assert_eq!(error, "the subagent settled with no output");
            assert!(output.is_empty(), "no partial to salvage — the child produced nothing");
        }
    }
}
```

- **Naming check:** the fixture `__subagent__` (fake_worker.rs:844) emits a `SubagentDispatch` + `agent_settled`, **no** `agent_message_chunk`; its capture yields `captured_text() == ""`. So this test observes the **real end-to-end 5.4 guard** (it exercises the production `finish_subagent` → `subagent-result-ack` wire) — if `cargo test --lib` flake appears, `cargo build --all-targets` first (the fixture binary is stale; per the constraint note).

## 6. `Steps:` — TDD, one per half + the outbound subagent + the belt + the glue

- [ ] **S1 — fail first (inbound, main path).** Add to `turn_lifecycle.rs` (no edits to `harness/loop/tests/mod.rs`):

  ```rust
  #[tokio::test]
  async fn a_placeholder_stream_is_never_emitted_or_persisted() {
      let (events_tx, mut events_rx) = mpsc::unbounded_channel();
      // The placeholder-only attempt, then the retry that answers properly
      // (issue #64: after the filter `acc.text` is empty, so `handle_empty_turn`
      // retries on the shared budget — the SAME shape the empty-turn tests use).
      let (provider, calls) = ScriptedProvider::new(vec![
          Some(vec![
              ProviderEvent::TextDelta(
                  "[System: Empty message content sanitised to satisfy protocol]".to_string(),
              ),
              ProviderEvent::Done(FinishReason::Stop),
          ]),
          Some(vec![
              ProviderEvent::TextDelta("ok".to_string()),
              ProviderEvent::Done(FinishReason::Stop),
          ]),
      ]);
      let (_, mut loop_, _db) = build_loop_with_db(
          Box::new(provider),
          events_tx,
          Arc::new(StdMutex::new(CancellationToken::new())),
          watch::channel(0u64).0,
          RetryPolicy::new_with(5, Duration::from_millis(1)),
          vec![fake_model("m1")],
          None,
      );
      loop_.handle_prompt(&text_prompt("hi")).await;
      let events = drain_events(&mut events_rx);
      // The delta must never be emitted (no `text_delta` message_update)…
      assert!(!events.iter().any(|e| matches!(e, RpcEvent::message_update { .. })));
      // …the placeholder-only attempt was retried (an empty turn), exactly once…
      assert_eq!(calls.load(Ordering::SeqCst), 2, "the placeholder attempt + the retry");
      // …and no stored row ever contains the placeholder…
      let loaded = loop_.store.load_messages("s1").unwrap();
      assert!(loaded.iter().all(|m| !serde_json::to_string(&m)
          .unwrap_or_default().contains("Empty message")));
      // …and the abandoned attempt persisted NO assistant row (only the retry's).
      assert_eq!(
          loaded.iter().filter(|m| matches!(m.role, ChatRole::Assistant)).count(),
          1,
          "exactly ONE assistant row (the retry's), got {loaded:?}"
      );
  }
  ```

  Run `cargo test -p archimedes --lib agent::harness::r#loop::tests::turn_lifecycle` from `src-tauri/` → **red**. What actually fails today, named:

  - **`assert!(!events.iter().any(|e| matches!(e, RpcEvent::message_update { .. })))`** — RED. Pre-fix the placeholder delta is emitted as `message_update` with a `"type": "text_delta"` payload (the loop streams **any** `TextDelta`; nothing filters). This is the measurable half of the acceptance criterion "the placeholder never reaches the UI".
  - **the `contains("Empty message")` row assertion** — RED. Pre-fix the placeholder is a **normal** `Stop` with non-empty `acc.text`, so it pushes an assistant row whose serialized content contains `"Empty message"` (the assertion fails).

  The two assertions that are NOT red today, stated so the failure signal is honest:
  - **`calls == 2`** — pre-fix the placeholder is a normal stop (non-empty text, no tool call), so it does **not** enter `handle_empty_turn` — there is no retry; the single `complete` persists and settles (`calls == 1`). The assertion IS red, but for the uninteresting reason.
  - **the `count() == 1` assistant-row assertion** — pre-fix there is exactly ONE assistant row too (the placeholder's — the retry that would add the second row never happens), so it is an **accidental green**, NOT a red signal. It is the *post-fix* guarantee ("the abandoned attempt persists nothing"): with the filter in place the placeholder attempt retries and the count proves the retry's single row. Read it as a green-canary, not a red-canary.

  The true red is the emission + the stored placeholder. If a fixture looks like it is lying: `cargo build --all-targets` first — `cargo test --lib` does NOT rebuild `fake_worker` (a stale fixture binary is the only way this test could pass pre-fix).

- [ ] **S2 — pass.** Implement `content_is_effectively_empty` (turn.rs), wire `consume_stream` per 5.1, add the SSE reassembly + its two tests per 5.3. The `turn_lifecycle` and `openai` inline `mod tests` are green.

- [ ] **S3 — fail first (outbound, OpenAI wire).** Add to `openai.rs` inline tests: `request_body_omits_content_for_an_empty_text_assistant_message_with_tool_calls` (and the keep-content guard). Run `cargo test -p archimedes --lib agent::harness::provider::openai::tests` → red (`body["messages"][0]["content"] == ""` today).

- [ ] **S4 — pass.** Implement the `request_body` guard per 5.2. Green.

- [ ] **S5 — fail first (subagent outbound).** `manager/tests/mod.rs`: `a_silent_child_that_settled_is_not_completed_empty` (5.7) — the end-to-end pin through the real settle. In `subagent_flow.rs`'s inline `mod tests`, add the capture-shape unit (what's testable without the whole `drive_subagent` machinery):

  ```rust
  /// (issue #122) The CAPTURE half: a child whose capture holds only the
  /// placeholder is an empty-result settle. `captured_text()` is the input
  /// the `Race::Settled` guard (5.4) judges — this pin proves the input the
  /// guard sees is the placeholder string byte-for-byte, so the guard's
  /// `content_is_effectively_empty` decision (itself pinned via the §4
  /// constant's tests) is total over the real shape.
  #[test]
  fn a_settled_placeholder_only_capture_is_captured_text_placeholder() {
      let capture = SubagentCapture::new();
      capture.observe_sink_frame("session-update", &json!({
          "sessionId": "child-1",
          "update": {
              "sessionUpdate": "agent_message_chunk",
              "messageId": "m1",
              "content": { "type": "text",
                  "text": "[System: Empty message content sanitised to satisfy protocol]" }
          }
      }));
      assert_eq!(
          capture.captured_text(),
          "[System: Empty message content sanitised to satisfy protocol]",
          "the capture records the placeholder byte-for-byte, so the settle guard \
           sees exactly what 5.4 filters"
      );
  }
  ```
  The *outcome-conversion* half (a placeholder/empty capture → `Failed { reason: Other, error: "the subagent settled with no output" }`) is the production `Race::Settled` arm; it is exercised end-to-end by 5.7's `manager/tests/mod.rs` pin through the real settle path, and the `finish_subagent`-shaped outcome construction can additionally mirror the existing `rollup_tests` pattern (subagent_flow.rs ~1745) if the implementer wants a nearer red/green loop — whichever is used, the acceptance criterion is 5.7's test name.

  **Red, honestly:** the capture-shape unit above is GREEN today (the capture already records the placeholder byte-for-byte — grounding §3a, "no value filter beyond the empty check"). The RED comes from **5.7's `a_silent_child_that_settled_is_not_completed_empty`**: pre-fix the `__subagent__` fixture's settle delivers `Completed { output: "" }` (the `Race::Settled` arm builds `Completed` unconditionally; only `Failed` is shielded by `salvage_text`), so 5.7's `match outcome { SubagentOutcome::Completed { .. } => panic!(...) }` fails. Run `cargo test -p archimedes --lib agent::worker::manager` → red against 5.7 (the inline capture unit stays green — it is the *input* pin, not the guard).

- [ ] **S6 — pass.** 5.4 (subagent_flow) + the `core.rs` / `client.rs` belts (5.5 / 5.6), with tests for the `client.rs` helper inside its existing inline `mod tests` — a plain `#[test]` calling `clamp_placeholder_row` on canned row JSON (an `assistant` row whose content is the placeholder → clamped; an `assistant` row with a non-placeholder `"content"` (including `Text("")` and any prefix) → unchanged; a `tool` row → unchanged; a `role != "assistant"` row → unchanged) — and for the `core.rs` arm (extend the existing `subagent_result_resolves_the_waiter`: send a `Completed { output: String::new() }`, assert the resolved outcome is the `Failed` marker, and the waiter still resolves — re-using `stub_core` / `test_env`). All unit suites green; then the full gates (§7).

Acceptance **(MEASURES true — the tests named for both halves):**

- **Inbound half:** `sse_streamed_placeholder_content_is_silenced` (the SSE parser reassembles and silences a split placeholder — the filter of record) **and** `a_placeholder_stream_is_never_emitted_or_persisted` (the loop `consume_stream` filter — nothing emitted, nothing persisted, retried as an empty turn) — green.
- **Outbound half:** `request_body_omits_content_for_an_empty_text_assistant_message_with_tool_calls` (the OpenAI request-body serialization — no `content: ""` ever sent) **and** `a_silent_child_that_settled_is_not_completed_empty` (the subagent → parent tool-message flow) — green.
- The placeholder never appears in the UI (the frontend receives no `message_update` delta carrying it) or in the transcript written after this fix.

## 7. GATE (run from the given directories)

From repo root:

```bash
pnpm test && pnpm build
```

From `src-tauri/`:

```bash
cargo build --all-targets          # MUST precede `cargo test` — `cargo test --lib` does NOT rebuild `fake_worker`
cargo fmt --check
cargo clippy --all-targets
cargo test
```

(Single package `archimedes`; the OWNED tests live in the files of §3.)

## 8. Out-of-set needs (for the orchestrator — not planned to edit)

| Use | Owner rationale |
|---|---|
| **(none required to pass this task.)** | All implemented changes stay inside the §3 file set. |
| **F3** — Follow-up (not this task, owned by a future task): the **`TranscriptReplace` clamp + the generic parsing helper**, dropped from this task by the round-2 belt trim. The `Replace` arm's rows (`Vec<(u64, String, String)>`) can carry a placeholder cell from the compaction rewrite; clamping it would require the JSON-parsing `clamp_empty_text_with_tool_calls` (the round-1 helper), which this task deliberately dropped to keep the store belt parse-free (a `String` replace is testable without a serde dependency). When/if that clamp lands, the tests live next to the `Insert` tests in `client.rs`'s inline `mod tests`, and the affordable seams stay inside the §3 file set. A `Resume` of a transcript that compacted an already-poisoned row is the residual exposure (§2's legacy limitation covers it). | ADR 0054: shaping lives on the wire; a durable-row rewrite is a data decision documented as a follow-up, not a fix shipped here. |
| **F2** — Follow-up (not this task, owned by a future task): a **legacy-transcript scrub**: on `Resume`/`load_transcript` (or at store read), replace/drop stored placeholder content in rows written before this fix, so replaying an old session stops rendering it. Would touch `harness/loop.rs` (or `store.rs`) — outside this task's Owns set, and it re-opens the honest-limitation decision (migrations / row rewrites are not a done deal in this repo). | ADR 0054: durable rows are never re-labelled for a wire's sake; the scrub is a data decision, not a wire decision. |
| If a wire-contract test is ever added: `src-tauri/tests/provider.rs` (the existing integration file for the OpenAI-compatible provider — MockServer-based; a `content: null`/omitted-wire pin belongs there). **This task does NOT add one** — the issue says the repo has no wire contract test, and the plan stays scoped to the unit seams whose names the acceptance criteria name; note it as the follow-up location. | Keep S6 small; a MockServer e2e is a full sibling feature, and the "cheap correct-enough plus honest limitation" rule says the inline `request_body` test is the correct-enough pin. |

## 9. Risks / edge cases / honest notes

- **Why these four seams (round-2 belt trim, per the reviewer's KEEP set):** each remaining guard covers a *distinct* producer the one above it cannot see:
  - **5.3 (SSE `handle_chunk`, the filter of record)** — the only seam that sees split deltas; turning the split case into an exact match is what makes every other guard an exact-match check (without it, the split case would NEED a substring match somewhere, which is the over-filtering the trim removes).
  - **5.1 (`consume_stream` bolt)** — the cross-wire bolt: the Anthropic and Responses parsers (`anthropic.rs:338`, `responses.rs:145`) emit whole text parts as `TextDelta`s and never pass through `openai.rs`'s SSE parser. The subagent capture also reads `agent_message_chunk` frames derived from the loop's own `message_update` — so without this bolt, an Anthropic/Responses model (or any third-party provider reaching this crate) that returns the placeholder as one text part would leak it into the transcript and UI. One guard, one choke point every non-OpenAI inbound byte crosses.
  - **5.2 (`request_body` outbound)** — the *upstream root cause*: stops the placeholder from ever being *authored* by our outbound shape (LiteLLM rewrites `"content": ""`). Without it, the inbound filters would be permanently downstream of a self-perpetuating history (LiteLLM saves the rewrite into history; the model sees it on later turns). This is THE fix the issue names; 5.1/5.3 are the defense against a proxy/model that still returns it.
  - **5.4/5.5 (subagent `Race::Settled` + `core.rs` inbound)** — the subagent capture is a **separate path** (the child's `SinkFrame`s, not the main loop) with its own accumulator (`SubagentCapture`, `subagent_flow.rs:85`). An empty-result child would otherwise deliver `Completed { output: "" }` → parent `tool`-message `Text("")` → `"content": ""` on the next parent request. 5.5 is the request boundary: a stale/malformed Worker (or any future caller) still cannot resolve a waiter with an empty `Completed`. **5.6 (the `Insert` store-row belt)** is the remaining edge — the Supervisor's `TranscriptPersister` writes the row from a *transport-carrying* child that never passes through the testable harness path; the belt there exists because the durable row is what a Resume re-reads (`core.rs (Resume, _)` → `load_transcript`). Everything else from the first round (the `Replace` clamp + the JSON-parsing helper) is dropped → **F3**.
- **Split-mid-token placeholder:** the loop `consume_stream` guard (whole-delta) cannot match a placeholder split across chunks; **the SSE parser (`handle_chunk`) is the filter of record** and reassembles it via the `stream_text_accum`. This is why the acceptance test names the SSE test for the inbound half, not the loop test alone. The loop guard additionally serves as the bolt for the other wires (Anthropic / Responses) whose text parts arrive whole through `TextDelta` — documented in code.
- **Don't-filter-too-much (corrected round 2):** the reconstruction holds *only while the accumulated run is a strict prefix of the placeholder*, so a legitimate delta containing the words but not the literal (e.g. a user asking "what does `[System: Empty message content sanitised to satisfy protocol]` mean?") diverges at the first non-prefix character and streams untouched. **The exact-match trade-off is recorded, not papered over:** any text whose *entire accumulated run* equals the placeholder is dropped at the SSE seam and at every subagent seam (5.4/5.5 whole-output check) — this includes a user literally typing the placeholder as their *prompt* (their text is read from the transcript and travels OUTBOUND, so a user-prompt line is never silenced by the *inbound* SSE parser — but a model echoing the exact literal, a proxied transcript replay, or any inbound text that happens to be exactly the banner is dropped). §5.3 states this caveat in the code that could be affected. `sse_does_not_silence_legitimate_content` pins the split-`he`/`llo` case.
- **Flush-seam hold (known limitation, recorded):** a strict prefix of the placeholder can be held until the stream ends — **a provider that stalls mid-prefix holds all of that run's streamed text on this run** until the stream ends or the next chunk diverges it (the flush comment + §5.3 spell out the "release or drop at every flush site" rule; `poll_next` never returns `None` while the accumulator is non-empty). The accumulator's *size* is bounded (a strict placeholder prefix + one chunk ≤ ~2 × 62 chars), so the worst case is **delayed delivery of a legitimately-`[`-starting message**, never loss without a stream end.
- **Ordering with issue #64:** a placeholder-only turn settles as a normal *empty* turn (`handle_empty_turn` retry) — it never persists an empty assistant row (the retry path, turn.rs ~295, persists nothing). A `Stop` with placeholder text + no tools is NOT an empty turn in `window` (this filter runs before `handle_empty_turn`'s check) but the *loop* logic still treats `acc.text.is_empty() && tool_calls.is_empty()` as empty — which is now **true** for a placeholder-only turn (desired).
- **The store-belt summary:** 5.6 clamps *only* the placeholder literal in `Insert` rows for `role == "assistant"`; an **empty-`Text`** row (`"content": ""`) is deliberately not clamped there — an empty assistant row is either today's *legitimate* tool-call shape (whose wire fix is 5.2) or the empty-turn case `handle_empty_turn` already retries without persisting, so a persisted empty `Text` row is either pre-existing (legacy, §2) or transient on a Resume that the next successful turn re-persists over. Clamping it in the store would be re-labelling durable state for a wire's sake, which ADR 0054 reserves against.
- **`Blocks` content:** never `"content": ""`-sanitised by LiteLLM (`str` check is false for arrays) — out of scope, documented.
- **No transcript mutation in this task** — the honest legacy-limitation of §2 stands.

## 10. Sources

- Issue #122 body — `gh issue view 122 --repo danielcherubini/archimedes --json body` (root-cause §1, LiteLLM `_sanitize_empty_text_content` in `factory.py`, acceptance criteria).
- `docs/decisions/0054-the-system-message-fold-belongs-to-the-wire-not-the-transcript.md`
- `docs/roadmap/backlog-79-122-124-28-ground-worker-wire.md`
- `src-tauri/src/agent/harness/loop/turn.rs` (131–170: `consume_stream`; 295: empty-turn)
- `src-tauri/src/agent/harness/loop.rs` (838: `consume_stream` call; 897: the `Text(acc.text.clone())` push; 906: `persist_transcript_message`)
- `src-tauri/src/agent/harness/provider/openai.rs` (`request_body` ~500–560; `handle_chunk` ~262–330; inline `mod tests` with `request_body_serializes_tool_calls_in_the_openai_wire_shape` ~870)
- `src-tauri/src/agent/harness/provider/types.rs` (`MessageContent::to_wire`; `ModelRequest::system_text`; `ChatMessage`)
- `src-tauri/src/agent/harness/dispatch.rs` (222–375: `SubagentWait` → `ToolResult`; 383: `salvage_text`)
- `src-tauri/src/agent/worker/core.rs` (667–676: `Inbound::SubagentResult` arm)
- `src-tauri/src/agent/worker/client.rs` (747–830: `route_outbound`)
- `src-tauri/src/agent/worker/manager/subagent_flow.rs` (95–260: `SubagentCapture`; 1008–1018: `Race::Settled`; 1135+: `finish_subagent`; 1333: `send_subagent_result`; inline `mod tests` 1387+)
- `src-tauri/src/agent/worker/manager/tests/mod.rs` (335: `subagent_result_outcome`; 664: the canonical `__subagent__` outcome test)
- `src-tauri/src/agent/subagent.rs` (348: `SubagentFailureReason`; 365: `SubagentOutcome`)
- `src-tauri/src/bin/fake_worker.rs` (844: `__subagent__`, 1025 lines)
- `src/lib/transcript/reducer.ts` (100–155: the frontend's untouched `text === ""` gates)
