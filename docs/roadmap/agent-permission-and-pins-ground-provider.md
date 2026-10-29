# Grounding Report — provider (the three stream parsers)

Area A2 · task #108 (exactly-once `Usage` guard on `openai` / `openai-responses`) · branch `feature/agent-permission-and-pins` · HEAD `2b6bd26` (`Permissions: the agent's own dirs become an ask, plus a rule model (#119)`), prior `a17ba4b`.

All code below is quoted VERBATIM from the tree; line numbers refer to `src-tauri/src/agent/harness/provider/<file>.rs`.

Search scope used: `src/agent/harness/provider/` entirely (anthropic.rs, openai.rs, responses.rs, test_util.rs, types.rs, mod.rs), plus `harness/loop/tests/{cost,context_usage}.rs` for who CONSUMES `ProviderEvent::Usage`.


## 1. The reference guard — `anthropic.rs`

### 1a. The `usage_emitted` field declaration with its doc comment (anthropic.rs:186, within lines 184–187)

```rust
    /// A combined `Usage` was emitted (exactly once — the `message_delta`
    /// `stop_reason` event, or the stream end when it never arrived).
    usage_emitted: bool,
```

It sits LAST among the four state flags, in this struct field order: `raw`, `lines`, `pending`, `event`, `tool_acc`, `input_tokens`, `last_output_tokens`, `cost_usd`, `finished`, `usage_emitted`, `exhausted` (anthropic.rs:146–186).

### 1b. Where it is initialised (anthropic.rs:192–210, `new()`)

```rust
    fn new(raw: BoxStream<'static, Result<Vec<u8>, reqwest::Error>>) -> Self {
        Self {
            raw,
            lines: LineAssembler::new(),
            pending: VecDeque::new(),
            event: None,
            tool_acc: BTreeMap::new(),
            input_tokens: None,
            last_output_tokens: None,
            cost_usd: None,
            finished: false,
            usage_emitted: false,
            exhausted: false,
        }
    }
```

### 1c. The emit function that checks and sets it — the WHOLE fn, short (anthropic.rs:447–466)

```rust
    /// Emit the combined `Usage` ONCE (the input from `message_start` —
    /// already the WHOLE prompt, cached prefix included, ADR 0046 — plus
    /// the last `output_tokens` seen; a `None` side becomes `0` — an
    /// absent count is reported as zero, NOT dropped: a `Usage` with one
    /// real side is more useful than none).
    ///
    /// The guard below is deliberately **counts-only**: it must NOT gain a
    /// `|| self.cost_usd.is_some()` term. A cost with no token counts on
    /// either side would push `Usage(0, 0, Some(money))`, and
    /// `Compactor::record_usage` would write a ZERO **Anchor** — a
    /// compaction regression bought for a figure (pinned by
    /// `anthropic_sse_cost_with_no_token_counts_emits_no_usage_event`).
    /// The cost is one more argument on this ONE push, so the
    /// `usage_emitted` exactly-once property is unchanged by it.
    fn emit_usage(&mut self) {
        if self.usage_emitted {
            return;
        }
        if self.input_tokens.is_none() && self.last_output_tokens.is_none() {
            return;
        }
        self.usage_emitted = true;
        self.pending.push_back(ProviderEvent::Usage(
            Usage {
                input_tokens: self.input_tokens.unwrap_or(0),
                output_tokens: self.last_output_tokens.unwrap_or(0),
            },
            self.cost_usd,
        ));
    }
```

Its two call sites: (a) the `message_delta` arm, exactly at `if let Some(reason) = v.get("delta")…get("stop_reason")` (anthropic.rs:378) — `emit_usage()`, then `flush_tool_calls()`, then `Done(map_anthropic_stop_reason(reason))`, then `finished = true`; (b) the stream-end branch (anthropic.rs:515) — after `lines.finish()` re-plays the tail, `emit_usage()`, then `if !self.finished { flush_tool_calls(); Done(Error) }`.

### 1d. The two tests — VERBATIM, so the planner can mirror the style

`anthropic_sse_usage_emitted_once_from_the_final_message_delta` (anthropic.rs:1317–1351):

```rust
    #[tokio::test]
    async fn anthropic_sse_usage_emitted_once_from_the_final_message_delta() {
        // An intermediate `message_delta` (NO `stop_reason`) does NOT emit
        // the `Usage` — exactly ONE, from the LAST value seen.
        let events = collect(anthropic_stream(&[
            "event: message_start\n\
             data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n\
             event: message_delta\n\
             data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n\n\
             event: message_delta\n\
             data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n",
        ]))
        .await;
        assert_eq!(
            events,
            vec![
                ProviderEvent::Usage(
                    Usage {
                        input_tokens: 10,
                        output_tokens: 7,
                    },
                    None
                ),
                ProviderEvent::Done(FinishReason::Stop),
            ]
        );
    }
```

`anthropic_sse_cost_is_emitted_exactly_once` (anthropic.rs:1547–1581), with its doc comment:

```rust
    /// Exactly-once survives the cost: a figure present on BOTH usage
    /// objects still yields ONE `Usage` event — the cost is one more
    /// argument on the single push behind the unchanged `usage_emitted`
    /// guard, so exactly-once holds by construction rather than by a new
    /// invariant.
    #[tokio::test]
    async fn anthropic_sse_cost_is_emitted_exactly_once() {
        let events = collect(anthropic_stream(&[
            "event: message_start\n\
             data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cost\":0.001}}}\n\n\
             event: message_delta\n\
             data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3,\"cost\":0.004}}\n\n\
             event: message_delta\n\
             data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7,\"cost\":0.009}}\n\n",
        ]))
        .await;
        let with_cost: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, ProviderEvent::Usage(..)))
            .collect();
        assert_eq!(
            with_cost.len(),
            1,
            "a cost seen twice still emits ONE Usage (got {events:?})"
        );
    }
```

## 2. `openai.rs` — `SseStream`

### 2a. The full struct field list (openai.rs:186–202)

```rust
pub(super) struct SseStream {
    /// The raw byte stream (`reqwest::bytes_stream`, mapped to `Vec<u8>`).
    raw: BoxStream<'static, Result<Vec<u8>, reqwest::Error>>,
    /// The raw-bytes line assembler (the multi-byte-codepoint safety —
    /// finding 9).
    lines: LineAssembler,
    /// Events parsed but not yet delivered.
    pending: VecDeque<ProviderEvent>,
    /// Per-`index` tool-call accumulation (flushed as `ToolCall`s at
    /// `finish_reason` / stream end).
    tool_acc: BTreeMap<u32, ToolAcc>,
    /// A `finish_reason` chunk was seen (no synthetic `Done` at end).
    finished: bool,
    /// The raw stream is exhausted (the stream ends after `pending`).
    exhausted: bool,
}
```

There is NO usage-memory field on `SseStream` (no `usage_emitted`, no `cost_usd` accumulator).

### 2b. `new()` (openai.rs:204–216)

```rust
    pub(super) fn new(raw: BoxStream<'static, Result<Vec<u8>, reqwest::Error>>) -> Self {
        Self {
            raw,
            lines: LineAssembler::new(),
            pending: VecDeque::new(),
            tool_acc: BTreeMap::new(),
            finished: false,
            exhausted: false,
        }
    }
```

(Note `pub(super)` — the parser is shared with the other suites' test mods.)

### 2c. The `usage` branch of `handle_chunk` (openai.rs:240–266), VERBATIM, including the SECOND-producer comment and the cost-only guard

```rust
    /// Handle one parsed chunk (a `choices[0].delta` + optional
    /// top-level `usage`).
    fn handle_chunk(&mut self, v: &Value) {
        // A trailing chunk may carry `usage` with an empty `choices`.
        // The wire `u64` token counts saturate to `u32::MAX` (a silent
        // `as u32` would TRUNCATE — a 4 GB token count would wrap to a
        // small one).
        if let Some(u) = v.get("usage").and_then(|u| {
            u.get("prompt_tokens")
                .and_then(|t| t.as_u64())
                .zip(u.get("completion_tokens").and_then(|t| t.as_u64()))
        }) {
            // The GATE above is unchanged and deliberate: both counts must
            // be present, so a chunk carrying a cost and no token pair
            // emits NO event — a cost-only emission path would make this a
            // SECOND `Usage` producer and hand T09 money detached from the
            // counts D4 pairs it with (pinned by
            // `sse_cost_only_usage_chunk_emits_no_usage_event`).
            // The money rides the SAME usage object the counts were read
            // from (D4, AMENDED: the body, not a header). Purely ADDITIVE
            // — the token arithmetic above is untouched.
            self.pending.push_back(ProviderEvent::Usage(
                Usage {
                    input_tokens: u32::try_from(u.0).unwrap_or(u32::MAX),
                    output_tokens: u32::try_from(u.1).unwrap_or(u32::MAX),
                },
                v.get("usage").and_then(cost_usd_from_usage),
            ));
        }
```

The “SECOND `Usage` producer” warning IS in this code, in this exact sentence: *“a cost-only emission path would make this a SECOND `Usage` producer and hand T09 money detached from the counts D4 pairs it with”* — i.e. the parser has exactly ONE `Usage` producer today, and the comment guards against ADDING a second one. The “cost-only guard” is the `.zip()` gate: BOTH `prompt_tokens` and `completion_tokens` must be present, so a cost-only chunk emits nothing.

### 2d. EVERY place a `ProviderEvent::Usage` is pushed — one site or several?

Exactly ONE production site: the block above (openai.rs:259–266). The cost is read at the same site (`v.get("usage").and_then(cost_usd_from_usage)`). No other code path in `SseStream` pushes `Usage` — not the `finish_reason` arm, not mid-stream `Error`, not stream end. So a guard belongs at exactly ONE site: check a new flag at the top of the push block (before the counts-parse — the gating `.zip()` can skip a second chunk without side effects), set it on the push. Optionally extract into a private `fn emit_usage` like Anthropic's; equivalently guard the inline push.

### 2e. Where `finished` / `exhausted` are set; can a synthetic `Done` path produce a second frame?

- `finished = true`: the `finish_reason` arm of `handle_chunk` (openai.rs:345).
- `exhausted = true`: the mid-stream `Error` branch (openai.rs:408), the stream-end branch (openai.rs:419), and the top-of-`poll_next` early-return check.
- Stream end (openai.rs:419–433): re-plays the un-`\n`ed tail through `handle_line` (so a usage chunk split across the last bytes is still parsed), then `if !this.finished { flush_tool_calls(); Done(Error) }`.

The synthetic-Done path CANNOT produce a second usage frame: it never synthesizes `Usage` itself — it only re-dispatches the tail line. Duplication on this wire can only come from TWO WIRE-LEVEL `usage` chunks (a proxy re-sending the trailing chunk, or a provider sending a `usage` chunk AND a `finish_reason` chunk AND again a chunk carrying `usage`). A guard at the single site closes all of them.

## 3. `responses.rs` — `ResponsesStream`

### 3a. The full struct field list (responses.rs:58–80)

```rust
struct ResponsesStream {
    /// The raw byte stream (`reqwest::bytes_stream`, mapped to `Vec<u8>`).
    raw: BoxStream<'static, Result<Vec<u8>, reqwest::Error>>,
    /// The raw-bytes line assembler (the multi-byte-codepoint safety —
    /// finding 9).
    lines: LineAssembler,
    /// Events parsed but not yet delivered.
    pending: VecDeque<ProviderEvent>,
    /// The current SSE `event:` name (a `data:` line without one is
    /// dispatched on its `type` field instead — the Responses events
    /// carry a `type` matching the event name).
    event: Option<String>,
    /// Per-item tool-call accumulation (the `output_index` of a
    /// `function_call` item; the `output_item.done` emits the `ToolCall`
    /// directly, the stream end flushes the not-`done` accs).
    tool_acc: BTreeMap<u32, ResponsesToolAcc>,
    /// A terminal event was seen (`response.completed` /
    /// `response.incomplete` / `response.failed` / `error` — no synthetic
    /// `Done` at stream end).
    terminated: bool,
    /// The raw stream is exhausted (the stream ends after `pending`).
    exhausted: bool,
}
```

There is NO `usage_emitted` field here.

### 3b. `new()` (responses.rs:85–95)

```rust
    fn new(raw: BoxStream<'static, Result<Vec<u8>, reqwest::Error>>) -> Self {
        Self {
            raw,
            lines: LineAssembler::new(),
            pending: VecDeque::new(),
            event: None,
            tool_acc: BTreeMap::new(),
            terminated: false,
            exhausted: false,
        }
    }
```

### 3c. ALL THREE `response_usage` call sites with the surrounding `terminated` logic — plus the `error` path

`response.completed` (responses.rs:272–287):

```rust
            Some("response.completed") => {
                // The terminal event: the `usage` (when at least one side
                // is present) PRECEDES the `Done`.
                if let Some(usage) = self.response_usage(v) {
                    // The cost rides the SAME terminal `response.usage`
                    // object the counts came from — one more element on
                    // this push, no new emission path.
                    self.pending
                        .push_back(ProviderEvent::Usage(usage, self.response_cost(v)));
                }
                self.terminated = true;
                if v.get("response")
                    .and_then(|r| r.get("status"))
                    .and_then(|s| s.as_str())
                    == Some("completed")
                {
                    self.pending
                        .push_back(ProviderEvent::Done(FinishReason::Stop));
                }
            }
```

`response.incomplete` (responses.rs:289–306):

```rust
            Some("response.incomplete") => {
                if let Some(usage) = self.response_usage(v) {
                    // The cost rides the SAME terminal `response.usage`
                    // object the counts came from — one more element on
                    // this push, no new emission path.
                    self.pending
                        .push_back(ProviderEvent::Usage(usage, self.response_cost(v)));
                }
                self.terminated = true;
                // `max_output_tokens` → `Length`; any other reason (or an
                // absent one) → `Error`.
                let reason = v
                    .get("response")
                    .and_then(|r| r.get("incomplete_details"))
                    .and_then(|d| d.get("reason"))
                    .and_then(|r| r.as_str());
                let finish = if reason == Some("max_output_tokens") {
                    FinishReason::Length
                } else {
                    FinishReason::Error
                };
                self.pending.push_back(ProviderEvent::Done(finish));
            }
```

`response.failed` (responses.rs:308–319):

```rust
            Some("response.failed") => {
                if let Some(usage) = self.response_usage(v) {
                    // The cost rides the SAME terminal `response.usage`
                    // object the counts came from — one more element on
                    // this push, no new emission path.
                    self.pending
                        .push_back(ProviderEvent::Usage(usage, self.response_cost(v)));
                }
                self.terminated = true;
                self.pending
                    .push_back(ProviderEvent::Done(FinishReason::Error));
            }
```

The `error` path (responses.rs:321–333) — terminal, but it is NOT a `response_usage` call site and pushes NO `Usage`:

```rust
            Some("error") => {
                // An in-stream `error` event (the HTTP status was 200 —
                // the error is IN the stream). Terminal: the turn cannot
                // continue (deliberately simpler than the Anthropic
                // `error` mapping — the Responses `error` object has no
                // stable `type` taxonomy, and a mid-stream error after a
                // partial response must NOT be blindly retried: the
                // `AgentLoop` has already consumed the partial deltas,
                // so the `RetryPolicy` sees a non-retryable end).
                self.exhausted = true;
                self.terminated = true;
                self.pending
                    .push_back(ProviderEvent::Done(FinishReason::Error));
            }
```

Stream end (responses.rs:419–471) NEVER emits `Usage` — the comment there says so explicitly: “NO `Usage` is synthesized here (unlike Anthropic — a Responses `usage` arrives only on the terminal events; a missing terminal event means missing usage, and a zero-filled `Usage` would misreport).”

### 3d. How a duplicate usage frame could arise on this wire — does `terminated` already prevent it?

**`terminated` does NOT prevent a duplicate `Usage` frame.** It is only checked once (stream end, `if !this.terminated`) to decide whether to synthesize `Done`; it is never consulted before a `Usage` push. The three terminal arms each `push_back` a `Usage` frame unconditionally (when `response_usage(v)` is `Some`), and `terminated = true` is set AFTER the push (the order is coincidental, not protective).

Duplicate-`Usage` scenarios on this wire:

- A doubled `response.completed` (a proxy re-sends the final event): two `Usage` frames + two `Done` frames.
- `response.incomplete` followed by `response.completed` (a proxy emitting an intermediate terminal and then the real one): two `Usage` frames.
- `response.failed` twice, `response.completed` after `response.failed`, etc. — every terminal event with a `response.usage` pushes again. (A terminal event with NO usage object pushes nothing — `response_usage` returns `None` — so a duplicated *usage-less* terminal does not duplicate usage, but that is happy-path luck, not a guard.)

Because the pushes sit at THREE distinct sites, the guard must cover all three. Cleanest mirror: one private `fn emit_terminal_usage(&mut self, v: &Value)` (it already reads `response_usage(v)` + `response_cost(v)`) that checks-and-sets a `usage_emitted` flag, called from the three terminal arms in place of the duplicated three-line pattern.

VERDICT, plainly: **the exactly-once `Usage` property does NOT hold on `openai-responses` today.** This wire is a live fix, not a no-op — do not let the planner downscope the task's responses half.

## 4. `response_usage` and `response_cost` (responses.rs:357–401), VERBATIM

```rust
    /// The `usage` of a terminal event's `response` object (the wire
    /// `u64` counts saturate to `u32::MAX — a silent `as u32` would
    /// TRUNCATE); a `None` side becomes `0`; `None` when NEITHER side is
    /// present (no `Usage` event — a zero-filled `Usage` would
    /// misreport).
    fn response_usage(&self, v: &Value) -> Option<Usage> {
        let usage = v.get("response")?.get("usage")?;
        let input = usage
            .get("input_tokens")
            .and_then(|t| t.as_u64())
            .map(|t| u32::try_from(t).unwrap_or(u32::MAX));
        let output = usage
            .get("output_tokens")
            .and_then(|t| t.as_u64())
            .map(|t| u32::try_from(t).unwrap_or(u32::MAX));
        match (input, output) {
            (Some(input), Some(output)) => Some(Usage {
                input_tokens: input,
                output_tokens: output,
            }),
            (Some(input), None) => Some(Usage {
                input_tokens: input,
                output_tokens: 0,
            }),
            (None, Some(output)) => Some(Usage {
                input_tokens: 0,
                output_tokens: output,
            }),
            (None, None) => None,
        }
    }
```

```rust
    /// The per-call cost (USD) of a terminal event's `response` object
    /// (D4, AMENDED: the money rides the BODY's usage object, not a
    /// header). A SIBLING of [`Self::response_usage`] rather than folded
    /// into it, so that helper's ADR 0046 arithmetic — including its
    /// "absent side becomes 0" arms and its `(None, None) => None` — stays
    /// textually untouched. `None` when the provider reported no figure:
    /// not zero, never a clamp.
    fn response_cost(&self, v: &Value) -> Option<f64> {
        v.get("response")
            .and_then(|r| r.get("usage"))
            .and_then(cost_usd_from_usage)
    }
```

(Tip: `response_usage` is the single funnel the three arms share — a guard INSIDE it would cover all three sites in one change; but it is a pure `&self` reader today, so the planner must decide whether the guard becomes `&mut self` / a stateful helper, or stays a separate per-site flag. The three independent push sites above are the honest description.)

## 5. The test harness

### 5a. `test_util.rs`'s `collect` (test_util.rs:16–17), VERBATIM

```rust
pub(crate) async fn collect<S: Stream<Item = ProviderEvent> + Unpin>(s: S) -> Vec<ProviderEvent> {
    s.collect().await
}
```

`test_util.rs` also has `chat_message(role, content, tool_call_id, tool_calls)` — the `ChatMessage` test-literal helper used by the request-body tests.

### 5b. The `sse_stream(...)` test helper in openai.rs (lines 735–747), VERBATIM

```rust
    /// Build an `SseStream` over RAW byte chunks (the `&str` helper below
    /// cannot split a multi-byte codepoint mid-byte — `&str` is valid
    /// UTF-8; this one can).
    fn sse_stream_bytes(chunks: &[Vec<u8>]) -> SseStream {
        let data: Vec<Vec<u8>> = chunks.to_vec();
        let raw: BoxStream<'static, Result<Vec<u8>, reqwest::Error>> =
            futures_util::stream::iter(data.into_iter().map(Ok)).boxed();
        SseStream::new(raw)
    }

    /// Build an `SseStream` over canned raw chunks (no HTTP).
    fn sse_stream(chunks: &[&str]) -> SseStream {
        // Owned data so the stream is `'static` (independent of `chunks`).
        let data: Vec<Vec<u8>> = chunks.iter().map(|c| c.as_bytes().to_vec()).collect();
        sse_stream_bytes(&data)
    }
```

The Responses equivalent is `responses_stream` / `responses_stream_bytes` (responses.rs:543–558), the Anthropic one is `anthropic_stream` / `anthropic_stream_bytes` (anthropic.rs:626–646) — same signature `(chunks: &[&str]) -> <Parser>` / `(chunks: &[Vec<u8>]) -> <Parser>`.

### 5c. How existing tests assert event vectors

Pattern, from every SSE test in all three files:

```rust
        let events = collect(sse_stream(&[ …fixture strings… ]))
            .await;
        assert_eq!(
            events,
            vec![ …ProviderEvent literals… ]
        );
```

Leaning variants used alongside:
- Length + first-element match: `assert_eq!(events.len(), 1, "an `error` event is terminal (the stream ends)");` then `match &events[0] { ProviderEvent::Usage(u, _) => {…} other => panic!(…) }`.
- All-vs-none predicate: `assert!(!events.iter().any(|e| matches!(e, ProviderEvent::Usage(..))), "… (got {events:?})")`.
- Exactly-N Usage count (the Anthropic exactly-once test — the direct model for #108's responses pin): `let with_cost: Vec<_> = events.iter().filter(|e| matches!(e, ProviderEvent::Usage(..))).collect(); assert_eq!(with_cost.len(), 1, "…");`.

The SSE fixture style is a single contiguous `&str` per wire “read”: `"event: …\n\ data: {\"...\"}\n\n\ event: …"` — the `\n\` continuation in the RUST source (line-continuation backslash in the string literal + the 13-space indentation of the next line, which is OUTSIDE the string), with `\n\n` after each `data:` line, and `\"` escaped quotes inside the JSON. The `event: X` line and its `data:` run on ONE logical string without a `\n` between the *statement* boundary lines… in practice the strings in the fixtures are written as `"event: response.completed\n\ data: {\"type\":…}\n\n"`. The exact escape style is what the pins MUST copy; two existing malformed-cost tests deliberately switch to `json!` + `format!("event: …\ndata: {payload}\n\n")` for a payload that must be inserted verbatim, with the comment: “Built with `json!` so the malformed value is inserted VERBATIM (a hand-escaped format! string is how this pin first shipped a truncated fixture and reddened for the wrong reason).”
