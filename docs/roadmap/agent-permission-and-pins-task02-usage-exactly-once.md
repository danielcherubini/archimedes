# Task 02 — exactly-once `Usage` guard on the openai / openai-responses parsers (#108)

- **Issue:** https://github.com/danielcherubini/archimedes/issues/108
- **Grounding:** `docs/roadmap/agent-permission-and-pins-ground-provider.md` (written at `2b6bd26` = current HEAD; signatures quoted verbatim in the grounding). The task is fully settled there; this plan is its execution order.
- **Branch / per-task branch:** `feature/agent-permission-and-pins`; commit directly on that branch (repo convention — the follow-ups and ADRs land there).
- **Owned file set (`Files:` — NO other file may be edited):**
  - `src-tauri/src/agent/harness/provider/openai.rs` (modify)
  - `src-tauri/src/agent/harness/provider/responses.rs` (modify)
  - **Do NOT touch** `anthropic.rs` (it holds the reference guard this task mirrors) or `provider/test_util.rs`. If a shared test helper were needed, it would go in each file's own `mod tests` — the two new pins need none.
- **Scoped from `src-tauri/`:** `cargo test --lib agent::harness::provider::openai` and `...::responses`. `archimedes` is ONE compilation unit — a syntax error anywhere breaks every scoped run; each edit is followed by the scoped run. `cargo clippy --all-targets` must stay at 0 warnings (all-new code carries explanatory doc comments — the clippy convention).

## Background

The three provider parsers read the per-call cost off `usage` in the response body. The **Anthropic** parser has an exactly-once guard (`usage_emitted`, declared on its struct, consulted and set inside the standalone `fn emit_usage` — a fn whose whole body is the emission, which is what makes its early `return` the right shape THERE); **`openai` and `openai-responses` have none**. Today it is latent (both are pinned by canned JSON), but cost makes a duplicate VISIBLE: a tokens double-count in a frame the UI ignores is invisible — a cost double-count reads as money that was not spent, and the roll-up (`SubagentDelegatingCard`… `emit_cost_update` in `src-tauri/src/agent/harness/loop/emit.rs`) summing per-call frames turns one duplicate into a wrong total.

**Two grounding-settled facts that change the shape of the work:**

1. **`responses.rs` is a LIVE fix, not a no-op.** `terminated` does NOT protect the usage push: it is consulted only at stream end to decide whether to synthesise `Done`, and the three terminal arms (the `Some("response.completed")` / `Some("response.incomplete")` / `Some("response.failed")` cases of `handle_event`) each `push_back` a `Usage` **unconditionally** (when `response_usage(v)` is `Some`), setting `terminated = true` AFTER the push. A doubled `response.completed`, or an `.incomplete` followed by a `.completed`, yields two `Usage` frames today. Guard ALL THREE sites — a single private `fn emit_terminal_usage(&mut self, v: &Value)` replaces the duplicated three-line pattern. **Do not downscope the responses half.**
2. **`openai.rs` has ONE push site** (the `usage` branch of `handle_chunk`), whose existing gate deliberately requires BOTH token counts present (the `.zip()`), so a cost-only chunk emits nothing (pinned by `sse_cost_only_usage_chunk_emits_no_usage_event`). The guard must preserve that gate exactly and must NOT create a second `Usage` producer.

**The ADR 0082 residue and why the fix lives at the parser seam.** ADR 0082's Honest-limits table records this residue — *"A proxy that repeats `usage` per chunk would make the store over-count; the openai/Responses parsers have no exactly-once guard"* — and its falsifier section re-arms the *"exactly-once assumption — a parser emitting more than one `Usage` per call"* candidate; both say the remedy is *"a once-guard at the **parser** seam … **not** an accumulator"* and the preamble calls the residue *"**observed, not guaranteed**"*. `emit_cost_update` (in `src-tauri/src/agent/harness/loop/emit.rs`) must therefore add **no dedupe of its own**: the loop has no per-call identity (a `Usage` is one frame among several; two frames from one call look exactly like two calls to `ScriptedProvider`'s consumers). A future reader who "improves" this into a dedupe inside `emit_cost_update` — or inside `Compactor::record_usage` (in `src-tauri/src/agent/harness/compact.rs`), the other `Usage` consumer, whose watermark arithmetic assumes per-call frames — breaks the per-call identity of the summary and double-counts in the OTHER direction. State this in the diff's doc-comments; the guard is the whole fix.

**Family uniform.** `usage_emitted` field name + doc-comment style are mirrored from the anthropic parser so the three parsers read as one family: the comment opens with *"A combined `Usage` was emitted (exactly once — …)"*, the field sits with the other state flags, `new()` initialises `usage_emitted: false`. The anthropic pattern is **emit-fn-shaped**: its `fn emit_usage` is a STANDALONE fn whose entire body is the emission, so `if self.usage_emitted { return; }` is correct THERE. `handle_chunk` is NOT that shape — the push is inline in a fn with work after it — so the openai guard is a conditional wrapping the push, never a `return` (the "design, openai" section below).

**Fixture style (copy exactly).** SSE fixtures are single contiguous `&str`s per wire "read": `"event: X\n\ data: {\"...\"}\n\n"` — the `\n\` is the Rust **line-continuation backslash inside the string literal**, the 13-space leading indentation of the continuation line is OUTSIDE the string, `\n\n` after each `data:` line, `\"` for JSON quotes. When a payload must be inserted verbatim (e.g. syntactic malformations), the established escape hatch is `json!` + `format!` — `&format!("data: {payload}\n\n")` for openai (see `sse_usage_malformed_cost_is_none_not_a_panic`) and `&format!("event: response.completed\ndata: {payload}\n\n")` for responses (see `responses_sse_malformed_cost_is_none`); the responses fixture builds the `event:`/`data:` lines with literal `\n` **separators** (NOT `\n\` continuation) precisely because the payload spans lines — copy that variant verbatim, and note its comment: *"Built with `json!` so the malformed value is inserted VERBATIM (a hand-escaped format! string is how this pin first shipped a truncated fixture and reddened for the wrong reason)."* Nothing in the new pins is a malformed payload, so Step 3 uses the plain `\n\`-continuation strings. Both new pin names carry the `{events:?}` vector in their failure messages (the repo's existing *"… (got {events:?})"* idiom); the extension is that the pins' `--nocapture` output is the exactly-once EVIDENCE — the same vector the failure message shows — not a per-step diagnostic. No assertions are added or deleted anywhere else.

**TDD discipline.** The two new pins quantify exactly-twice `Usage` frames, so each REDs on today's parser (asserting exactly ONE frame fails against two produced frames) and the registration runs files-green→files-green except for the two pins. The edit is therefore two phases inside the Steps: **RED** (add ONLY the two pins — implementation untouched — run both scoped suites → exactly the two pins fail, everything else green) then **GREEN** (add the guards to both files — one compilation unit — run both scoped suites → all green). Baseline step 1 is only the "check the empty gold file before any edit" record (files run GREEN; no test can fail without any change, so step 1 is a formality whose failure would only mean a flaky baseline worth attributing). No `(verify)` steps exist (repo convention).

**Verification ordering (per-file) — the two verification seams order themselves.** Given files are green, the new test names must sit in module-traversal order before their impl seams, or they cannot evidence `--nocapture`. Both pins are named for and sit inside the file they verify, so this orders itself — nothing to do.

## The exactly-once guard — what the implementation must deliver (verified against the tree)

Replace the two-line-armed plans at the ground report's verdicts with these specifics, quoted/anchored to today's source (symbol names, not line numbers — the citations below are the assertion/`fn` names you can hold against the tree):

- **Field (both files):** add, to `SseStream` and `ResponsesStream`, a `usage_emitted: bool` field mirrored VERBATIM in name and doc-comment style from the anthropic field — *"A combined `Usage` was emitted (exactly once — the `message_delta` `stop_reason` event, or the stream end when it never arrived)."* (Each parser's doc-comment should name its own wire's trigger, keeping the first sentence and the parenthetical's shape.) It joins the other state flags; the anthropic initialisation is `usage_emitted: false` in `new()`, mirrored by both new `new()`s.
- **openai.rs — single push site, guarded as a CONDITIONAL wrapping the push (no early `return` from `handle_chunk`).** The usage block sits at the TOP of `handle_chunk`, before the `choices[0].delta` handling (`ThinkingDelta` / `TextDelta` / `ToolCallDelta`) and the `finish_reason` arm (tool-call flush + `Done`). It is NOT an emit-fn: an early `return` inside the block would exit the WHOLE fn — a chunk that carries BOTH a `usage` object and a `delta` or a `finish_reason` would lose its text/thinking/tool-call/`Done` events once usage has been emitted. The guard must therefore wrap the push, not return. Change the existing `if let Some(u) = v.get("usage").and_then(…)` block — keeping the `.zip()` counts gate byte-identical and the `SECOND producer` comment in place — to:

  ```rust
  if let Some(u) = v.get("usage").and_then(/* …the existing `.zip()` gate, BYTE-IDENTICAL… */) {
      // The GATE above is unchanged and deliberate: both counts must
      // be present, so a chunk carrying a cost and no token pair
      // emits NO event — a cost-only emission path would make this a
      // SECOND `Usage` producer and hand T09 money detached from the
      // counts D4 pairs it with (pinned by
      // `sse_cost_only_usage_chunk_emits_no_usage_event`).
      // The money rides the SAME usage object the counts were read
      // from (D4, AMENDED: the body, not a header). Purely ADDITIVE
      // — the token arithmetic above is untouched.
      //
      // Exactly-once (the same `#108` defect class the anthropic
      // `usage_emitted` guard fixes): the trailing `usage` chunk is
      // emitted ONCE — a proxy re-sending it must not push a second
      // frame the roll-up would sum as money that was not spent. This
      // guard WRAPS the push, it does NOT early-return: `handle_chunk`
      // continues past this block to the `choices[0].delta` handling
      // and the `finish_reason` flush+`Done`, and a chunk that carries
      // BOTH `usage` and a delta/finish_reason must still deliver them.
      if !self.usage_emitted {
          self.usage_emitted = true;
          self.pending.push_back(ProviderEvent::Usage(
              Usage {
                  input_tokens: u32::try_from(u.0).unwrap_or(u32::MAX),
                  output_tokens: u32::try_from(u.1).unwrap_or(u32::MAX),
              },
              v.get("usage").and_then(cost_usd_from_usage),
          ));
      }
  }
  ```

  The existing `.zip()` gate, the `SECOND producer` comment and the `push_back` arguments stay byte-identical (the single textual moves: `if self.usage_emitted { … }` added as the push's WRAPPER, `self.usage_emitted = true;` set immediately before the push). The flag is only ever read or written inside that block, so `sse_cost_only_usage_chunk_emits_no_usage_event` still holds — a cost-only chunk never enters the block at all. The `finish_reason`/`delta` work after the block is untouched: a usage chunk that also carries `choices[0].finish_reason` still reaches the `Some(choice)` arm and emits its `Done` (checked against `handle_chunk`'s control flow — the block is not a fn boundary). Do NOT check the flag anywhere else; do NOT add a cost term to the gate.
- **responses.rs — all THREE push sites.** Replace the duplicated three-line pattern at each of the three terminal arms — the `Some("response.completed")` / `Some("response.incomplete")` / `Some("response.failed")` cases of `handle_event` — `if let Some(usage) = self.response_usage(v) { self.pending.push_back(ProviderEvent::Usage(usage, self.response_cost(v))); }` — with a single call: `self.emit_terminal_usage(v);`. Add the private method (best placed immediately ABOVE `response_usage`, as the guarded wrapper around it):

  ```rust
  /// Emit the terminal `Usage` ONCE — a doubled terminal event (a proxy
  /// re-sending `response.completed`, or an `incomplete` followed by a
  /// `completed`) must not push a second frame the roll-up would sum as
  /// money that was not spent. The `usage_emitted` flag guards all THREE
  /// terminal arms (`response.completed` / `response.incomplete` /
  /// `response.failed`) — `terminated` does not: it is consulted only at
  /// stream end, and it is set AFTER this push (the order is
  /// coincidental, not protective). The counts gate is UNCHANGED:
  /// `response_usage`'s `(None, None) => None` still drops a cost-only
  /// `response.usage` (pinned by
  /// `responses_sse_cost_with_no_token_counts_emits_no_usage_event`), so
  /// this helper is NOT a second `Usage` producer.
  fn emit_terminal_usage(&mut self, v: &Value) {
      if self.usage_emitted {
          return;
      }
      let Some(usage) = self.response_usage(v) else {
          return;
      };
      // The cost rides the SAME terminal `response.usage` object the
      // counts came from — one more element on this push, no new
      // emission path.
      self.usage_emitted = true;
      self.pending.push_back(ProviderEvent::Usage(usage, self.response_cost(v)));
  }
  ```

  This is the anthropic shape and it is safe: `emit_terminal_usage` is a STANDALONE fn whose entire body is the emission, so its early `return` never skips anything the caller must still do. The three arms keep their `terminated = true;` plus per-arm `Done` logic (and the `response.completed` status check) — the push is replaced by the call, so each arm's relative order is push-at-old-site → `terminated = true` → `Done`, unchanged. The `Some("error")` arm pushes NO `Usage` and is untouched (it is not a `response_usage` call site). Stream end emits NO `Usage` and is untouched.

## Existing tests asserting a `Usage` — per-test guard impact (enumerated from the tree)

No existing assertions change: every current fixture that emits a `Usage` contains EXACTLY ONE usage object, so the exactly-once guard is never triggered on green code. All single-usage tests below are **unchanged in expectation**; the two `any(…` ABSENCE pins and `responses_sse_failed` (a usage-less fixture exercising `response_usage`'s missing-`usage` early return, not a second-frame path) are also unchanged. No test feeds two usage chunks today, so **nothing is deleted or rewritten** — only the two NEW pins are added.

- **openai.rs** (the openai test module — `mod tests` at the file's end):

| Test (name) | Fixture's usage chunks | Asserts | Guard impact |
|---|---|---|---|
| `sse_usage_chunk` | 1 | `Usage(10, 5, None)` | unchanged |
| `sse_usage_does_not_add_the_cached_tokens_detail` | 1 | `Usage(1000, 5, None)` | unchanged |
| `sse_usage_saturates_on_u32_overflow` | 1 | first event is `Usage(u32::MAX, 5, _)` | unchanged |
| `sse_usage_chunk_carries_the_provider_cost` | 1 | `Usage(10, 5, Some(0.000011662))` | unchanged |
| `sse_usage_chunk_without_cost_reports_none` | 1 | `Usage(10, 5, None)` | unchanged |
| `sse_usage_malformed_cost_is_none_not_a_panic` | 1 per loop iteration | `Usage(10, 5, None)` | unchanged |
| `sse_cost_only_usage_chunk_emits_no_usage_event` | 1, cost-only (rejected by the gate) | `!any(Usage)` | unchanged (a cost-only chunk still emits nothing — the `.zip()` gate is byte-identical and the flag is only consulted INSIDE the gate, so that chunk never enters the block) |
| `sse_usage_chunk_with_an_unparsable_number_emits_no_usage_event` | 1 (whole chunk fails to parse) | `!any(Usage)` | unchanged (the `serde_json` parse fails before the enum arm — the flag never sees it) |

- **responses.rs** (the responses test module — `mod tests` at the file's end):

| Test (name) | Fixture's terminal events | Asserts | Guard impact |
|---|---|---|---|
| `responses_sse_text_and_completed` | 1 × `completed` | `Usage(10, 5, None)` then `Done(Stop)` | unchanged |
| `responses_usage_does_not_add_the_cached_tokens_detail` | 1 × `completed` | `Usage(1000, 0, None)` | unchanged |
| `responses_sse_reasoning_summary` | 1 × `completed` | `Usage(10, 3, None)` | unchanged |
| `responses_sse_incomplete_max_output_tokens` | 1 × `incomplete` | `Usage(10, 32000, None)` then `Done(Length)` | unchanged |
| `responses_sse_failed` | 1 × `failed`, NO `usage` object | `vec![Done(Error)]` — no `Usage` | unchanged (`response_usage` returns `None`, so the new `else` return is hit) |
| `responses_sse_cost_rides_the_completed_response_usage` | 1 × `completed` + `cost` | `Usage(10, 5, Some(2.122e-05))` | unchanged |
| `responses_sse_cost_rides_the_incomplete_terminal` | 1 × `incomplete` + `cost` | `Usage(10, 32000, Some(0.25))` | unchanged |
| `responses_sse_cost_rides_the_failed_terminal` | 1 × `failed` + `cost` | `Usage(10, 1, Some(0.003))` | unchanged |
| `responses_sse_absent_cost_is_none_not_zero` | 1 × `completed`, no `cost` | `Usage(10, 5, None)` | unchanged |
| `responses_sse_malformed_cost_is_none` | 1 × `completed` per loop iteration, malformed `cost` | `Usage(10, 5, None)` | unchanged |
| `responses_sse_cost_with_no_token_counts_emits_no_usage_event` | 1 × `completed`, cost-only (rejected by `(None, None)`) | `!any(Usage)` | unchanged (the `(None, None) => None` arm still returns `None`, so `emit_terminal_usage`'s `let-else` returns before the flag is set — and it is the LAST terminal event anyway) |

**None of these feeds two usage chunks. If any ever did, it would assert two frames today (a doubled `response.completed` yields `Usage` + `Done(Stop)` twice, and a duplicated `usage` chunk on the openai wire yields two `Usage` frames) and would become RED after the guard — that is precisely the defect class #108 fixes, evidenced by the two new pins.

## Steps (TDD; ≤ 6; no `**Parallel:**` — one roadmap task, serial by construction)

1. **Baseline (pre-edit record).** From `src-tauri/`, run the two scoped suites and the clippy gate, and record the results:
   `cargo test --lib agent::harness::provider::openai 2>&1 | tail -1` → `test result: ok …` (read the passing count from the output), then
   `cargo test --lib agent::harness::provider::responses 2>&1 | tail -1` → `test result: ok …` (same — the counts are the runtime evidence, not a number this plan asserts), then
   `cargo clippy --all-targets 2>&1 | grep -c warning` → `0`.
   No file is touched. The only way a RED surfaces here is a flaky baseline worth attributing, so the recorded output doubles as the record.
2. **RED (pins only, no implementation).** In **each** file's `mod tests`, add ONE pin — `sse_usage_emitted_once_from_two_chunks` in `openai.rs` and `sse_single_usage_chunk` in `responses.rs`, each named for and placed BEFORE the seam it verifies, in `collect(…stream(&[…fixture…]))` + `assert_eq!` style. Both are `None`-cost, and both assert on the FULL event vector — a filter-count on `Usage` is NOT enough (see the "why the openai pin is built this way" note after the fixture). The openai fixture feeds TWO `data:` chunks each carrying BOTH token counts, and **at least one of the two ALSO carries `choices[0].delta.content` — or a `choices[0].finish_reason`** — so a buggy early `return` would drop that chunk's `TextDelta` / `Done` and the assertion must catch it:

   ```rust
   // Two `usage` chunks on the wire; the SECOND also carries a
   // `TextDelta` — so a buggy early-`return` guard (which would drop
   // that chunk's `TextDelta`/`Done` once usage was emitted) FAILS this
   // pin's full-vector assert, not merely its `Usage` count.
   let events = collect(sse_stream(&[
       "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n\
        data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
   ]))
   .await;
   assert_eq!(
       events,
       vec![
           ProviderEvent::Usage(
               Usage {
                   input_tokens: 10,
                   output_tokens: 5,
               },
               None
           ),
           ProviderEvent::TextDelta("hi".to_string()),
           ProviderEvent::Done(FinishReason::Stop),
       ]
   );
   ```

   A GREEN parser emits exactly `[Usage, TextDelta("hi"), Done]` (one `Usage` frame, the text, one `Done`). The buggy version of the old early-`return` design would emit `[Usage]` — and the full-vector assert fails on the MISSING `TextDelta`/`Done` as well as on the absent second-`Usage` count. (Both should fail anyway, but the count trivially ticks on the mutate-the-implementation wrong-side; only the full-vector assert catches a guard that also EATS the delta — the bug's real cost.) The responses fixture feeds TWO terminal `response.completed` events (the doubled final event on that wire; no `created`-style prelude, so the duplication is what the pin isolates), asserting the full vector `[Usage, Done(Stop), Done(Stop)]` — one `Usage` (the thing #108 guards) but TWO `Done(Stop)` frames, because the guard deliberately covers only the `Usage` push.

   **Scope note — `Usage` ONLY (do not extend to `Done`).** This task guards the `Usage` push ONLY. A doubled terminal event still yields a doubled `Done` — that is a PRE-EXISTING, SEPARATE class deliberately OUT of #108's scope (ADR 0082 names only the cost over-count; `Done` duplication is an unrelated stop-reason concern). The pin's expected vector `[Usage, Done(Stop), Done(Stop)]` documents that residue rather than hiding it. Do NOT "fix" it by extending the guard to `Done` — that is scope creep past the issue and would change stop-reason behaviour. Record doubled-`Done` as a follow-up observation, not an implementation step. Run: `cargo test --lib agent::harness::provider::openai` and `…::responses` → exactly TWO failures (the new pins; each fails on today's doubled `Usage`), everything else green. Copy the FAILING fixtures verbatim (including the observed vectors, `(got {events:?})`) into the Step 3 bodies as they evolve.

   **Registration note.** Both pins fail on today's parser (a doubled usage frame is produced before any guard exists), so step 2's files-green→files-green reading is preserved — the registration runs green except for the two new pins.
3. **GREEN (guards, one compilation unit).** Add to `openai.rs`: `usage_emitted: bool` field + `usage_emitted: false` in `new()`; in `handle_chunk`, wrap the existing `push_back` (the block described in "design, openai" above) with `if !self.usage_emitted { … }`, setting `self.usage_emitted = true;` immediately BEFORE the `push_back` — the `.zip()` counts gate and the `SECOND producer` comment stay byte-identical, and there is NO `return` anywhere in the block (a guard that drops the delta fails `sse_usage_emitted_once_from_two_chunks`'s full-vector assert). Add to `responses.rs`: field + `usage_emitted: false` in `new()`; the private `fn emit_terminal_usage(&mut self, v: &Value)` placed immediately ABOVE `response_usage`, guarded with `if self.usage_emitted { return; }` then the `let Some(usage) = self.response_usage(v) else { return; };` counts gate then `self.usage_emitted = true;` + the single push; replace the pushes at the three terminal arms — the `Some("response.completed")` / `Some("response.incomplete")` / `Some("response.failed")` cases of `handle_event` — with `self.emit_terminal_usage(v);`, keeping each arm's `terminated = true;` and its `Done` logic. Run both scoped suites → all green (read the new passing counts from the `cargo test` output — the baseline plus the two new pins, evidenced at run time, not asserted here), `cargo clippy --all-targets` → 0 warnings.
4. **Consumer/regression margin.** From `src-tauri/`: `cargo test --lib agent::harness` (provider tree) and `cargo test --lib agent::harness::loop::tests::cost` + `::context_usage` (the `Usage`-consuming suites — `emit_cost_update` and `record_usage` unchanged; this is a formality) → all green; `cargo clippy --all-targets` → 0 warnings.
5. **Full-unit + clippy.** `cargo test --lib` (whole crate, one unit) → all green; `cargo clippy --all-targets` → 0 warnings.
6. **The two verification seams, evidenced.** Run `cargo test --lib agent::harness::provider::responses sse_single_usage_chunk -- --nocapture` and `cargo test --lib agent::harness::provider::openai sse_usage_emitted_once_from_two_chunks -- --nocapture`; the exactly-ONE `Usage`-frame count is asserted by the pins AND observable from test output (both parser tests print their vectors — no step-3-only eprintln stays; the pins' message bodies carry the vector, matching the repo's `… (got {events:?})` idiom). Commit (single commit — "the guard is whole or it is absent"): `git add src-tauri/src/agent/harness/provider/openai.rs src-tauri/src/agent/harness/provider/responses.rs && git commit -m "feat(provider): guard Usage emission exactly once on the openai and openai-responses parsers (#108)"`.

## Verification

- Acceptance is the natural-ordered green pins: `cargo test --lib agent::harness::provider::responses sse_single_usage_chunk` and `cargo test --lib agent::harness::provider::openai sse_usage_emitted_once_from_two_chunks` both pass, and the fixtures' double-`usage`/double-terminal inputs yield exactly one `ProviderEvent::Usage` — asserted by the pins on the FULL vector (so a guard that eats the delta is equally a fail), and confirmed by eye (Step 6's `--nocapture` shows each parser's full vector).
- PLUS both scoped suites `cargo test --lib agent::harness::provider::openai` / `…::responses` green (read the counts from the output: the baseline plus the two new pins); `cargo test --lib agent::harness::loop::tests::cost` and `::context_usage` green (the consumer side, unchanged — `emit_cost_update` gains no dedupe); `cargo clippy --all-targets` at 0 warnings.
- NOT acceptance: any change to `anthropic.rs` / `test_util.rs` / `loop/{emit,turn,compact}.rs` (dedupes and reordering there are the exact "improvement" ADR 0082 forbids).
- **GREEN-pedantic guard rail:** the acceptance is identical whether the openai guard is a conditional wrapping the push (the design above) or a buggy early `return` from `handle_chunk` that ALSO passes the `Usage` count — a careless implementer could gate with `if self.usage_emitted { return; }` inside the usage block, or check the flag at a SECOND site, and a `Usage`-count-only pin would gaily go green. The mechanics above constrain that four ways: (1) the guard is a `if !self.usage_emitted { … }` wrapper around a single push with NO `return` in the block; (2) the wrapper textually encloses the `push_back`, so the `Done`/delta code after the block is provably still reached; (3) the new `sse_usage_emitted_once_from_two_chunks` pin asserts the FULL vector — `[Usage, TextDelta("hi"), Done]` — on a fixture whose second usage chunk ALSO carries `choices[0].delta.content` and a `finish_reason`, so an early `return` that drops the delta fails it on the missing frames, not just on the count (a `Usage`-count-only pin passes against the buggy version — said explicitly; the full-vector assert is what makes it a REAL pin); (4) `sse_usage_chunk` (a single usage chunk still yields `[Usage, Done]`) pins the gate-and-push order. Everything else is the reviewer reading the diff, not the red campaign.

## Risks

1. **Two `Usage` frames from one call on the openai wire (the live defect).** A real proxy that re-sends the trailing `usage` chunk, or sends a `usage` chunk AND a `finish_reason` chunk AND a `usage` chunk again, over-counts today. Guarded exactly once: `handle_chunk`'s usage block is NOT an emit-fn — `return` would exit the WHOLE fn and drop the `choices[0].delta` handling and the `finish_reason` flush+`Done` that follow it in the same chunk — so the guard is a `if !self.usage_emitted { … }` conditional WRAPPING the push (no early `return`), with the `.zip()` gate and the `SECOND producer` comment byte-identical, preserving `sse_cost_only_usage_chunk_emits_no_usage_event`. A usage chunk that ALSO carries `choices[0].delta.content` or `choices[0].finish_reason` still flows past the block to the `Some(choice)` arm and emits its delta and `Done` after the single `Usage` — and `sse_usage_emitted_once_from_two_chunks` proves it (its second usage chunk carries both a `TextDelta` and a `finish_reason`, and the full-vector assert fails if either is dropped; the responses pin is unaffected by the openai shape).
2. **A doubled terminal on the responses wire.** `completed`+`completed`, `incomplete`+`completed`, `failed`+`completed` all push two `Usage` frames today (each with its own `Done`). Guarded at all three sites via `emit_terminal_usage`'s `usage_emitted`; a second terminal's `Done` is still emitted (the arms keep their `Done` logic), which is exactly the pre-change `terminated` semantics — the guard is deliberately *only* about the `Usage` frame, not `Done` (ADR 0082 names only the over-count; `Done` duplication is a separate pre-existing class out of #108's scope, and a doubled usage-less terminal was never visible because `response_usage` returned `None`).
3. **The `.zip()` gate is untouched.** A cost-only chunk must STILL emit nothing (`sse_cost_only_usage_chunk_emits_no_usage_event`); a cost-only RESPONSES usage must STILL emit nothing (`responses_sse_cost_with_no_token_counts_emits_no_usage_event`). `emit_terminal_usage`'s `let-else` return BEFORE the flag set is what preserves that.
4. **Clippy on new code**: doc comments accompany all three additions, matching the repo convention (an all-new `fn` without one is a warning; the family-style field comments are likewise).
5. **One compilation unit**: `archimedes` compiles as a whole; the two-file guard edit must land as one unit (Step 3), so the natural-ordered RED (pins-only, Step 2) is clean — any cross-file compile break scrubs the scoped-run evidence mid-edit, and the Step 1 baseline log reassigns any non-guard flake.
