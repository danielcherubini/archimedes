---
status: committed
---

# Bounded summaries and retracted replies — implementation plan

**Goal:** make the two recovery paths that PR #12 shipped actually finish — a
compaction summary whose own model call fits the window it is trying to recover,
and an abandoned model attempt whose partial reply is discarded everywhere
instead of welding onto the retry.

**Architecture decisions:** ADR 0047
`docs/decisions/0047-the-summarys-input-is-bounded-and-the-trim-recorded.md` and
ADR 0048 `docs/decisions/0048-an-abandoned-reply-is-retracted-by-protocol.md`.
**Read both before starting** — every task implements a decision those documents
record, and the tests pin the decisions, not the incidentals.

**Terminology** (`CONTEXT.md` has entries for *Summary input budget*, *Abandoned
attempt*, *Retraction*): use those words in code, comments, test names and commit
messages. "Display transcript" and "Provider transcript" are used below in the
sense ADR 0028 establishes (the rendered rows vs. the messages replayed to the
provider) — they are not glossary entries. The glossary also warns that "slash
command" is NOT a term: a `/name` Composer command is a *Composer command*.

## Global Constraints

- **Validation runs from two roots.** Rust: `cd src-tauri` then `cargo test`,
  `cargo clippy --all-targets`, `cargo fmt --check`. Frontend, repo root:
  `pnpm test` (vitest), `pnpm build` (`tsc && vite build`). CI effectively runs
  `cargo clippy --all-targets -- -D warnings`, so **zero warnings** locally. Run
  the Rust and frontend suites **sequentially** — concurrent runs time vitest
  out.
- **A function introduced before its production caller must be `pub`.**
  `cargo clippy --all-targets` compiles the lib target *without* `cfg(test)`, so
  a private item referenced only from `mod tests` is reported `dead_code` and
  `-D warnings` reddens the branch. Precedent: `pub fn split_for_compaction`
  (`compact.rs:218`). (A `pub` method on a reachable type is never `dead_code`.)
- **One `message_start` per assistant message**, including a retried model call
  (`loop.rs:877-882`, the `message_started` flag). This is exactly why a
  Retraction cannot be expressed as "the next message starts": the retried call
  REUSES the abandoned one's `messageId`. Nothing in this plan may emit a second
  `message_start`.
- **The display store has no DELETE.** `Store::persist_display` →
  `Db::record_message` UPSERTs `ON CONFLICT(session_id, kind, message_key)`
  (`storage/db.rs:367-384`); `Store::clear_messages` clears `native_messages`,
  not display rows. A Retraction therefore OVERWRITES the abandoned rows with
  empty text and the reader hydrates an empty text row as nothing (ADR 0048).
- **Text and thoughts are keyed by `messageId` at every layer, and same-id
  chunks APPEND** (`normalize.rs:485-521`, `src/store/sessions.ts:131-159`,
  `worker/manager.rs:163-173`). That is the welding hazard ADR 0048 removes; do
  not "fix" it by truncating at the renderer.
- **Thought row keys are `{messageId}#{n}` where `n` comes from a counter that
  is GLOBAL to the loop life**, not per message: a second assistant message's
  thoughts are `m2#2`, `m2#3`… (`normalize.rs:472-478`; `ThoughtState` is built
  once in `AgentLoop::new`, `loop.rs:371`, never reset). Never assume a
  message's run starts at `#1`.
- **The Retraction frame is delivered on the same `tokio::sync::broadcast`
  (capacity 256) as the chunks it erases, and that pump drops on `Lagged`**
  (`worker/client.rs:160,324`, `worker/manager.rs:626-636`). It is durable
  *enough* — the same channel that carries the text carries its erasure — but a
  lag window can lose either. Pre-existing; noted so nobody later mistakes the
  frame for a storage guarantee.
- **The summary prompt's base text is pinned** by `SUMMARY_SYSTEM`
  (`compact.rs:624`) and must stay byte-identical when nothing was trimmed and
  no instructions were given.
- **Do not float the toolchain or `@tauri-apps/cli`** (`AGENTS.md`).

### Key code already present (anchors verified against the files)

| What | Where |
|---|---|
| `Compactor` (private `config`, `context_window`), `should_compact`, `keep_budget`, `reestimate` | `src-tauri/src/agent/harness/compact.rs:26-42`, `:121-130`, `:132-149`, `:156-161` |
| `estimate_context` (`pub(crate)`), `estimate_message_tokens` (private; `chars/4 + tool_calls*20 + 1`) | `compact.rs:182-188`, `:192-208` |
| `split_for_compaction` (`pub`; the tool-role snap-**back** precedent) | `compact.rs:218-249` |
| `CompactionCtx`, `CompactionOutcome`, `run_compaction` | `compact.rs:286-310`, `:312-326`, `:334-409` |
| `SUMMARY_PREFIX` / `is_compaction_summary` | `compact.rs:277`, `:282-284` |
| `summary_system_prompt` (private, `:417`), `summarize` (`max_tokens: None` at `:458`) | `compact.rs:411-427`, `:429-515` |
| `summarize`'s THREE call sites: production, `recorded_summary_prompt`, `call_summarize` | `compact.rs:361`, `:683`, `:1567` (fns at `:666`, `:1551`) |
| `CompactionCtx` construction sites (FOUR) | `loop.rs:1801`, `compact.rs:674`, `:1558`, `:1602` |
| `ModelOptions { temperature, max_tokens: Option<u32>, reasoning_effort, stream }`; `ModelRequest: Clone` | `provider/types.rs:191-203`, `:16-29` |
| `MessageContent::{Text,Blocks}` — **no `text_content()` accessor** | `provider/types.rs:35-40` |
| `RpcEvent` (snake_case variant names ARE the `type` tag; unit variants exist) | `src-tauri/src/agent/events.rs:35-38`; `compaction_end` ends `:156` |
| `RpcEvent::kind()` — the ONLY exhaustive `match` on `RpcEvent` | `events.rs:204-264` |
| `TurnState`, `system_chunk` (hard-codes `messageId:"system"`), `normalize` | `normalize.rs:58-64`, `:66-76`, `:104-405` |
| `ThoughtState { current, open_key, next }`; the segment-open site; the `{id}#{n}` key | `normalize.rs:31-36`, `:472-478`, `:480` |
| `compute_display_rows` (doc says "0 or 1 rows"), `agent_thought_chunk` arm, `agent_message_chunk` arm, `tool_call` arm | `normalize.rs:443-452`, `:455-488`, `:489-521`, `:522` |
| `tool_execution_start` / `_update` / `_end` → `tool_call` / `tool_call_update` frames; `is_error` → `status:"failed"` | `events.rs:108-126`, `normalize.rs:277-331` |
| `now_ms`, `DisplayRow { kind, message_key, payload_json, created_at }` | `normalize.rs:579`, `harness/store.rs:33-40` |
| The one emit pipeline: `normalize` → sink frame → `compute_display_rows` → `persist_display` | `loop.rs:2016-2035` |
| `TurnAccumulator acc` per model call (`acc.text`, `acc.thinking`, `acc.tool_calls`) | `loop.rs:872`; delta arms `:893-912` |
| Retryable mid-stream retry, `turn_abandoned` at the retry site | `loop.rs:989-1036`, `:1026` |
| Overflow mid-stream intercept; `if !overflow_recovered {`; `turn_abandoned` | `loop.rs:1047-1056`, `:1048`, `:1050` |
| Overflow pre-stream arm (`acc` does not exist yet) | `loop.rs:836-851` |
| The cancel path's synthetic end for a call that never ran (`cancelled_tool_result`) | `loop.rs:1164-1174`, `:1519-1528` |
| `turn_state` / `text_acc` / `thought_state` built ONCE | `loop.rs:368-371` |
| `SubagentCapture` (`text`, `last_message_id`), `observe_sink_frame`, `captured_text` | `worker/manager.rs:108-118`, `:143-171`, `:195-208` |
| `AcpSessionUpdate` union; `compaction_update` member closes | `src/lib/tauri.ts:146-189`, `:189` |
| Pure reducer; tool-call statuses; `rowToMessages`; hydration arms | `src/store/sessions.ts:125-213`, `:55-66`/`:176-205`, `:300-387`, `:334-344`/`:345-355` |
| Test modules: `compact.rs` `mod tests` (**25** tests), `normalize.rs` `mod normalize_tests` (`:590`) and `mod compute_display_rows_tests` (`:1084`) | as named |

### Scope

In scope: the summary's input/output bounds and its recorded trim (ADR 0047);
the Retraction protocol event and its three consumers — harness accumulator +
persisted rows, live store, subagent capture — on BOTH abandonment paths
(ADR 0048); and an Abandoned attempt's **tool cards**, which are CLOSED rather
than retracted (Task 9, with the ADR 0048 amendment that records why).

Out of scope, tracked in `docs/roadmap/compaction-recovery-hardening-follow-ups.md`:
the index arithmetic in `resumeSession`'s history merge
(`sessions.ts:1207-1215`) — Task 7 makes the reducer able to SHRINK the array,
and that merge is the one place a mid-flight shrink could shift a `slice`; and
the `Lagged`-drops-the-frame hole in the broadcast channel the Retraction rides.

---

## Phase 1 — the summary's own call is bounded (ADR 0047)

### Task 1: the Summary input budget and the summary's output cap

**Files:**
- Modify: `src-tauri/src/agent/harness/compact.rs` (in `impl Compactor`, after `keep_budget`, which ends `:149`)
- Test: same file, `mod tests` (after `keep_budget_caps_the_keep_to_what_the_window_affords`, which ends `:1154`)
- Commit: `feat: the compaction summary gets a budget of its own`

Both numbers ADR 0047 fixed are pure arithmetic over what `Compactor` already
holds (`config` + `context_window`). `keep_budget()` (`:132-149`) is the
precedent: a budget derived from THIS model's window, saturating arithmetic, no
floor. Deterministic tests, no fixtures.

- [ ] `Step 1: write the failing tests.`

      ```rust
      /// (ADR 0047) The summary's two numbers: an output cap of
      /// `min(floor(0.8 × reserve), 8_192)` and an input budget of the window
      /// minus that cap minus the headroom `keep_budget` charges.
      #[test]
      fn the_summary_budget_is_the_window_minus_its_own_output_and_headroom() {
          // reserve 16 384 → cap min(13 107, 8 192) = 8 192; headroom min(16 384, 4 096).
          let c = Compactor::new(
              CompactionConfig {
                  reserve_tokens: 16_384,
                  ..Default::default()
              },
              32_000,
          );
          assert_eq!(c.summary_output_cap(), 8_192);
          assert_eq!(c.summary_input_budget(), 32_000 - 8_192 - 4_096);
      }

      /// A reserve below the ceiling caps the summary at 80% of itself — pi's rule.
      #[test]
      fn a_small_reserve_caps_the_summary_output_at_eighty_percent() {
          let c = Compactor::new(
              CompactionConfig {
                  reserve_tokens: 1_000,
                  ..Default::default()
              },
              32_000,
          );
          assert_eq!(c.summary_output_cap(), 800);
      }

      /// A window already spent on its own reserve has NOTHING left for a
      /// summary, and `saturating_*` makes that ZERO rather than a wrap-around
      /// that reads as a huge budget. A reserve of 0 affords no output at all.
      #[test]
      fn a_window_below_its_own_reserve_has_no_summary_budget() {
          let c = Compactor::new(
              CompactionConfig {
                  reserve_tokens: 16_384,
                  ..Default::default()
              },
              12_000,
          );
          assert_eq!(c.summary_input_budget(), 0);
          let none = Compactor::new(
              CompactionConfig {
                  reserve_tokens: 0,
                  ..Default::default()
              },
              128_000,
          );
          assert_eq!(none.summary_output_cap(), 0);
      }
      ```

- [ ] `Step 2: run them, see them fail.`
      `cargo test --lib harness::compact 2>&1 | tail -40` →
      `error[E0599]: no method named 'summary_output_cap' found for struct
      'Compactor' in the current scope` (the fixtures bind `Compactor` by value).

- [ ] `Step 3: implement.` In `impl Compactor`, immediately after `keep_budget`:

      ```rust
      /// The summary's OWN output cap (ADR 0047): `min(floor(0.8 ×
      /// reserve_tokens), 8_192)`. The summary is a model CALL, and a call needs
      /// an output budget it can afford — pi's rule, same shape. The harness's
      /// own model calls stay uncapped: their output is the point.
      pub fn summary_output_cap(&self) -> u32 {
          const SUMMARY_OUTPUT_CAP: u32 = 8_192;
          let reserve = u64::from(self.config.reserve_tokens);
          (reserve * 8 / 10).min(u64::from(SUMMARY_OUTPUT_CAP)) as u32
      }

      /// The Summary input budget (ADR 0047): what the summary call may CARRY —
      /// the window minus its own output cap minus the same headroom
      /// [`Compactor::keep_budget`] charges a small window. A summary built from
      /// the WHOLE summarized range is a call that overflows on its own way in,
      /// and the mechanism that fixes an overflow must not need fixing itself.
      ///
      /// Zero is a real answer (a window already spent on its reserve), and the
      /// caller reads it as "no summary is possible", not as "unbounded".
      pub fn summary_input_budget(&self) -> u32 {
          const SUMMARY_HEADROOM_CAP: u32 = 4_096;
          let headroom = self.config.reserve_tokens.min(SUMMARY_HEADROOM_CAP);
          u64::from(self.context_window)
              .saturating_sub(u64::from(self.summary_output_cap()))
              .saturating_sub(u64::from(headroom))
              as u32
      }
      ```

- [ ] `Step 4: run, see them pass.` `cargo test --lib harness::compact` → ok,
      **28** tests in this module (25 existing + 3).
- [ ] `Step 5: gate and commit.` `cargo clippy --all-targets` (zero warnings),
      `cargo fmt`, commit.

### Task 2: trim the summarized range to the budget

**Files:**
- Modify: `src-tauri/src/agent/harness/compact.rs` (after `split_for_compaction`, which ends `:249`)
- Test: same file, `mod tests` (after `split_never_starts_the_kept_tail_on_a_tool_message`, which ends `:1228`)
- Commit: `feat: the summarized range is trimmed to the summary's own budget`

A pure function: no I/O, no provider. `split_for_compaction` is the sibling, and
its "never start on a `tool` message" rule applies here too — but snapping
**forward**, because here it is the summarized range that must start on a real
turn.

**This must be `pub fn`** (Global Constraints: it has no non-test caller until
Task 3, and a private item would trip `dead_code` under `--all-targets`).

- [ ] `Step 1: write the failing tests.` Build the assistant-with-`tool_calls`
      and `tool` messages EXACTLY as
      `split_never_starts_the_kept_tail_on_a_tool_message` does inline at
      `compact.rs:1195-1210` — there is no helper.

      ```rust
      /// (ADR 0047) The recent END of the summarized range is what a summary
      /// must not lose, so the trim drops from the OLD end.
      #[test]
      fn the_trim_keeps_the_newest_slice_that_fits() {
          // Each message: "m{i}" + 3 999 x's = 4 001 chars → 4 001/4 + 1 = 1_001.
          let msgs: Vec<ChatMessage> =
              (0..4).map(|i| text_msg(&format!("m{i}{}", "x".repeat(3_999)))).collect();
          // 2_100 fits two (2_002) but not three (3_003).
          let (kept, dropped) = trim_for_summary_budget(&msgs, 2_100);
          assert_eq!(dropped, 2, "the two oldest are dropped");
          assert_eq!(kept.len(), 2, "the newest two are summarized");
          assert!(
              matches!(&kept[0].content, MessageContent::Text(t) if t.starts_with("m2")),
              "the slice starts at the newest end, got {:?}",
              kept[0].content
          );
      }

      /// The kept slice never STARTS on a `tool` result — the boundary snaps
      /// FORWARD past it, and the snapped-past message still counts as dropped
      /// (an orphaned `tool` message 400s on conformant APIs).
      #[test]
      fn the_trim_never_starts_the_kept_slice_on_a_tool_message() {
          /* inline `asst` (Assistant + one tool_call) and `tool` (Tool +
             tool_call_id) exactly as compact.rs:1195-1210 builds them, then: */
          // Estimates: "oldest" 2, `asst` 21 (one tool_call = 20, + 1), `tool` 2,
          // "newest" 2. Budget 10 takes newest (2) + tool (4), stops at `asst`
          // (25 > 10), so the RAW boundary lands on the tool result at index 2.
          let msgs = vec![text_msg("oldest"), asst, tool, text_msg("newest")];
          let (kept, dropped) = trim_for_summary_budget(&msgs, 10);
          assert_eq!(dropped, 3, "the snapped-past tool result is still dropped");
          assert_eq!(kept.len(), 1, "only the newest message is summarized");
          assert!(
              !matches!(kept[0].role, ChatRole::Tool),
              "the summarized slice does not start on an orphaned tool result"
          );
      }

      /// A budget that fits nothing summarizes nothing: the caller must NOT send
      /// a doomed call, so the empty slice is the signal.
      #[test]
      fn a_budget_that_fits_nothing_trims_everything() {
          let msgs = vec![text_msg("a"), text_msg("b")];
          let (kept, dropped) = trim_for_summary_budget(&msgs, 0);
          assert!(kept.is_empty(), "nothing fits a zero budget");
          assert_eq!(dropped, 2);
      }
      ```

- [ ] `Step 2: run them, see them fail.` `cargo test --lib harness::compact 2>&1 | tail -30`
      → `cannot find function 'trim_for_summary_budget' in this scope`.

- [ ] `Step 3: implement.` After `split_for_compaction`:

      ```rust
      /// Trim the summarized range to the Summary input budget (ADR 0047): keep
      /// the NEWEST slice that fits — the recent end is what a summary must not
      /// lose — and report how many messages were dropped, which the harness
      /// writes into the summary it stores.
      ///
      /// Like [`split_for_compaction`] the kept slice never STARTS on a `tool`
      /// message, but here the boundary snaps FORWARD (an orphaned `tool` result
      /// 400s on conformant APIs) and the snapped-past messages count as dropped.
      /// The result is always a SUFFIX of `older`, so "the oldest N" is literally
      /// true of the count. An EMPTY slice means the budget fits nothing: there is
      /// no honest summary to ask for and the caller must not send a doomed call.
      pub fn trim_for_summary_budget(
          older: &[ChatMessage],
          budget: u32,
      ) -> (Vec<ChatMessage>, usize) {
          let mut keep_from = older.len();
          let mut acc = 0u32;
          while keep_from > 0 {
              let next = acc.saturating_add(estimate_message_tokens(&older[keep_from - 1]));
              if next > budget {
                  break;
              }
              acc = next;
              keep_from -= 1;
          }
          while keep_from < older.len() && matches!(older[keep_from].role, ChatRole::Tool) {
              keep_from += 1;
          }
          (older[keep_from..].to_vec(), keep_from)
      }
      ```

- [ ] `Step 4: run, see them pass.` `cargo test --lib harness::compact` → ok,
      **31** tests in this module.
- [ ] `Step 5: gate and commit.` `cargo clippy --all-targets` (zero warnings —
      this is the step the `pub` above protects), `cargo fmt`, commit.

### Task 3: the bound and the record, wired into the compaction

**Files:**
- Modify: `src-tauri/src/agent/harness/compact.rs` (`run_compaction:334-409`, `summary_system_prompt:411-427`, `summarize:429-515`, the test doubles near `:535-603`)
- Test: same file, `mod tests`
- Commit: `feat: the summary call fits the window it is recovering`

Consumes Task 1's numbers and Task 2's trim. This is where the decision becomes
behaviour: the call is bounded, the trim is recorded in the stored summary, the
model is told the range is incomplete, and a budget that fits nothing produces
an honest `Skipped` with **no model call at all**.

- [ ] `Step 1: write the failing tests.` First add a double that keeps the whole
      request — `SessionRecordingProvider` (`:576-603`) records only the session
      id, and `ModelRequest` is `Clone`:

      ```rust
      /// Records the WHOLE summary `ModelRequest` — the input size and the output
      /// cap are what ADR 0047 pins.
      struct RequestRecordingProvider {
          recorded: Arc<std::sync::Mutex<Vec<crate::agent::harness::provider::ModelRequest>>>,
      }
      ```
      Implement `Provider` for it exactly as `SessionRecordingProvider` does
      (`#[async_trait::async_trait]`, push `req.clone()`, stream
      `TextDelta("ok")` + `Done(FinishReason::Stop)`). Then:

      ```rust
      /// (ADR 0047) The summary is a call with an output budget: `max_tokens` is
      /// the cap the Compactor derived, not the provider's own default.
      #[tokio::test]
      async fn the_summary_call_carries_its_own_output_cap() {
          let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
          let provider = RequestRecordingProvider {
              recorded: recorded.clone(),
          };
          let summary = call_summarize(&provider, &[text_msg("history")])
              .await
              .expect("summarize succeeds");
          assert_eq!(summary, "ok");
          let reqs = recorded.lock().unwrap_or_else(|p| p.into_inner()).clone();
          assert_eq!(reqs.len(), 1);
          // `call_summarize` builds its Compactor with `CompactionConfig::default()`
          // (reserve 16 384) → min(floor(0.8 × 16 384), 8 192).
          assert_eq!(reqs[0].options.max_tokens, Some(8_192));
      }

      /// A trimmed summary SAYS it is trimmed: the model is told the range is
      /// incomplete, and the stored record carries the harness's exact count.
      #[tokio::test]
      async fn a_trimmed_summary_records_what_it_dropped() {
          let (provider, _calls) = ScriptedProvider::new(vec![Some(vec![
              ProviderEvent::TextDelta("the summary".to_string()),
              ProviderEvent::Done(FinishReason::Stop),
          ])]);
          let (_db, store) = temp_store();
          let mut harness = Harness::new(&provider, store.clone());
          // The budget is the binding constraint: 16 384 − 8 192 output − 4 096
          // headroom = 4 096.
          harness.compactor = Compactor::new(CompactionConfig::default(), 16_384);
          harness.keep = Some(1);
          // 8 × (4 000 chars / 4 + 1) = 8 × 1_001 tokens. A keep-budget of 1 keeps
          // ONLY the last message, so `older` is 7 (7 007 tokens) — and 4 096
          // carries four of them (4 004), not five (5 005): 3 are dropped.
          harness.messages = (0..8).map(|_| text_msg(&"y".repeat(4_000))).collect();
          let outcome = harness.run().await;
          assert!(
              matches!(outcome, CompactionOutcome::Compacted { .. }),
              "four messages still fit the budget, so the compaction proceeds"
          );
          let rows = store.load_messages("s1").expect("rows load");
          let summary = rows
              .iter()
              .find(|m| is_compaction_summary(m))
              .expect("the summary is in the rewritten transcript");
          let MessageContent::Text(text) = &summary.content else {
              panic!("the summary is a text message");
          };
          assert!(
              text.contains(
                  "[Note: this summary is not complete. The oldest 3 message(s) of the \
                   summarized range were dropped"
              ),
              "the stored summary records its own trim verbatim, got {text}"
          );
      }

      /// A budget that fits NOTHING is an honest `Skipped` — and NO call is sent.
      /// The doomed request is exactly what ADR 0047 exists to stop.
      #[tokio::test]
      async fn a_summary_budget_that_fits_nothing_skips_without_a_call() {
          let (provider, calls) = ScriptedProvider::new(vec![Some(vec![
              ProviderEvent::TextDelta("never called".to_string()),
              ProviderEvent::Done(FinishReason::Stop),
          ])]);
          let (_db, store) = temp_store();
          let mut harness = Harness::new(&provider, store);
          // The window is already inside its own reserve: budget 0.
          harness.compactor = Compactor::new(
              CompactionConfig {
                  reserve_tokens: 16_384,
                  ..Default::default()
              },
              12_000,
          );
          harness.keep = Some(0);
          harness.messages = vec![text_msg("one"), text_msg("two")];
          assert!(matches!(harness.run().await, CompactionOutcome::Skipped));
          assert_eq!(
              calls.load(std::sync::atomic::Ordering::SeqCst),
              0,
              "no summary call is sent when the budget fits nothing"
          );
      }
      ```

      (`Store::load_messages` returns `Result<Vec<ChatMessage>, DbError>` —
      `harness/store.rs:54` — which is why the find above uses
      `is_compaction_summary` rather than a raw JSON scan.)

- [ ] `Step 2: run them, see them fail.` `cargo test --lib harness::compact 2>&1 | tail -40`
      → `the_summary_call_carries_its_own_output_cap` fails with
      `left: None, right: Some(8192)`; the record test fails on the missing
      `[Note:` text; the third fails because a doomed call IS made (`calls == 1`).

- [ ] `Step 3: bound the call.` In `summarize` (`:429-463`) add the parameter,
      and cap the output:

      ```rust
      pub(crate) async fn summarize(
          ctx: &CompactionCtx<'_>,
          older: &[ChatMessage],
          dropped: usize,
          turn: &CancellationToken,
      ) -> Result<String, ProviderError> {
      ```
      …`content: MessageContent::Text(summary_system_prompt(ctx.instructions.as_deref(), dropped)),`…

      ```rust
              options: ModelOptions {
                  temperature: Some(0.0),
                  // (ADR 0047) The summary's OWN output budget. Uncapped, an
                  // ambitious summary runs to the provider's own default and comes
                  // back `Done(Length)` — which the tail of this function correctly
                  // rejects as a truncated summary. `.max(1)` because a reserve of
                  // 0 must not produce a request that cannot answer with a byte.
                  max_tokens: Some(ctx.compactor.summary_output_cap().max(1)),
                  reasoning_effort: None,
                  stream: true,
              },
      ```
      Extend the doc comment: the range is already trimmed by the caller and
      `dropped` is how many messages the trim removed.

- [ ] `Step 4: tell the model.` `summary_system_prompt` (`:411-427`) gains the
      parameter; the base string stays byte-identical:

      ```rust
      fn summary_system_prompt(instructions: Option<&str>, dropped: usize) -> String {
          let base = "Summarize these messages concisely, preserving decisions, \
                      file paths, and open tasks. Respond with the summary only."
              .to_string();
          let mut prompt = match instructions {
              Some(s) if !s.trim().is_empty() => {
                  format!("{base}\nAdditional instructions for this summary: {s}")
              }
              _ => base,
          };
          // (ADR 0047) A trimmed range is not the whole story, and a summary that
          // does not know it is incomplete writes a summary that reads as complete.
          if dropped > 0 {
              prompt.push_str(&format!(
                  "\nThe oldest {dropped} message(s) of this range were dropped to fit \
                   this request. Summarize what is here, and say in the summary that it \
                   is not complete."
              ));
          }
          prompt
      }
      ```

- [ ] `Step 5: trim and record in `run_compaction`.` At the split (`:357-361`)
      and the summary construction (`:363-368`):

      ```rust
          let (older, recent) = split_for_compaction(compactable, ctx.keep_recent_tokens);
          if older.is_empty() {
              return CompactionOutcome::Skipped;
          }
          // (ADR 0047) The summary's own call is bounded: the summarized range is
          // trimmed to the budget this window affords, and the trim is RECORDED —
          // an unmarked summary would be a fabricated memory.
          let budget = ctx.compactor.summary_input_budget();
          let (summarized, dropped) = trim_for_summary_budget(&older, budget);
          if summarized.is_empty() {
              // The budget fits nothing, so there is no honest summary to ask for
              // and NO call is worth sending. `Skipped` is the honest outcome: the
              // transcript is unchanged and the caller says so. (For a window this
              // small this repeats every turn — no request is sent, so it costs the
              // provider nothing.)
              return CompactionOutcome::Skipped;
          }
          match summarize(ctx, &summarized, dropped, turn).await {
              Ok(summary) => {
                  // The record of the trim travels IN the summary (ADR 0047): the
                  // harness knows the exact count, so the stored row states it —
                  // and so does the model, because this same message is replayed.
                  let record = if dropped > 0 {
                      format!(
                          "\n\n[Note: this summary is not complete. The oldest \
                           {dropped} message(s) of the summarized range were dropped \
                           to fit the summary's own context window.]"
                      )
                  } else {
                      String::new()
                  };
                  let summary_msg = ChatMessage {
                      role: ChatRole::System,
                      content: MessageContent::Text(format!(
                          "{SUMMARY_PREFIX}\n{summary}{record}"
                      )),
                      tool_call_id: None,
                      tool_calls: None,
                  };
      ```
      Leave the rest of the `Compacted` branch — assembly, `reestimate`,
      `replace_messages` — untouched.

- [ ] `Step 6: fix the two test call sites.` `summarize` gained a parameter:
      pass `0` at `recorded_summary_prompt`'s call (`compact.rs:683`) and
      `call_summarize`'s call (`:1567`). Do NOT add a parameter to either helper
      — they pin the un-trimmed path; the tests above pin the trimmed one.

- [ ] `Step 7: run.` `cargo test --lib harness::compact` → **34** tests pass.
      Then `cargo test` — no regression. These must pass **unchanged**:
      `a_small_window_compaction_actually_shrinks_the_transcript` (`:1484`; its
      window 32 768 affords 20 480 against an `older` of 2 messages / 4 002
      tokens → no trim), `compaction_twice_*`,
      `compaction_preserves_leading_system_message`,
      `a_compaction_emits_a_context_usage_update_from_the_reestimate`,
      `a_skipped_compaction_reports_no_shrink`, the `summarize_*` prompt tests,
      and in `loop.rs`: the four overflow tests (window 128 000 → budget
      115 712), `a_tool_batch_is_measured_before_the_next_compaction_check`
      (window 16 484 → budget 4 196 vs `older` 22 tokens — the summary call
      still fires) and `tests/harness_loop.rs::context_threshold_triggers_compaction`.
      `a_summary_stream_ending_in_length_is_not_a_good_summary` (`:1259`) already
      pins the cap's new failure mode (`Done(Length)` → retryable `Err`), so no
      new test is needed for it.

- [ ] `Step 8: gate and commit.` `cargo clippy --all-targets` (zero warnings),
      `cargo fmt --check`, commit.

---

## Phase 2 — an abandoned reply is retracted (ADR 0048)

### Task 4: the Retraction event, its frame, and its line

**Files:**
- Modify: `src-tauri/src/agent/events.rs` (the enum; `kind()` at `:204-264`)
- Modify: `src-tauri/src/agent/normalize.rs` (`TurnState:58-64`, a new `normalize` arm before `:381`, a helper next to `system_chunk:66-76`)
- Test: `normalize.rs`, `mod normalize_tests` (`:590` — it already imports `normalize`, `TurnState`, `RpcEvent`, `json`; no new `use`)
- Commit: `feat: a Retraction is a protocol event that says so`

**ADR 0048 requires TWO things from a real discard**: the erase, and a short
line — "Discarded an incomplete reply" — **carrying a UNIQUE `messageId`**,
because the shared `"system"` key would weld two of them into one bubble (and the
retryable path emits `"Retrying (attempt 1/3…)"` through that same key
immediately before). So this task emits TWO frames, and the line's id is the
thing that makes it safe to capture, render, and persist.

- [ ] `Step 1: add the event.` `events.rs`, immediately after `compaction_end`
      (ends `:156`). A unit variant — this enum's internal tag makes it
      `{"type":"message_retracted"}`, exactly like the existing `agent_start` /
      `agent_settled` unit variants:

      ```rust
      /// (ADR 0048) An Abandoned attempt's partial reply is RETRACTED: every row
      /// keyed by the message id the harness is on is discarded — the persisted
      /// display rows, the live transcript, and the subagent capture alike.
      /// Emitted when a model call is abandoned mid-stream (a retryable retry, an
      /// overflow recovery) AFTER it streamed text or thinking; the retried call
      /// reuses the same id (one `message_start` per message), so without this
      /// event the two attempts' text welds into one reply. No payload:
      /// `normalize` resolves the id, the only place that knows it.
      message_retracted,
      ```

      And in `kind()` (`events.rs:204-264`, the only exhaustive `match` on
      `RpcEvent` — the compiler will point here):

      ```rust
      Self::message_retracted => Cow::Borrowed("message_retracted"),
      ```

- [ ] `Step 2: write the failing tests.` In `mod normalize_tests`, after the
      compaction tests:

      ```rust
      /// (ADR 0048) A real discard is both the erase AND a line saying so, and
      /// the line carries its OWN messageId — the shared `"system"` key would weld
      /// it onto the retry line emitted immediately before it.
      #[test]
      fn a_retraction_erases_the_current_message_and_says_so() {
          let mut st = TurnState::default();
          normalize(
              &RpcEvent::message_start {
                  message: json!({ "role": "assistant" }),
              },
              &mut st,
          );
          let frames = normalize(&RpcEvent::message_retracted, &mut st);
          assert_eq!(
              frames,
              vec![
                  json!({ "sessionUpdate": "message_retracted", "messageId": "m1" }),
                  json!({
                      "sessionUpdate": "agent_message_chunk",
                      "content": { "type": "text", "text": "Discarded an incomplete reply" },
                      "messageId": "retract:1",
                  }),
              ]
          );
          assert_eq!(
              st.current_message_id.as_deref(),
              Some("m1"),
              "the retried call REUSES the id: a Retraction is not a new message"
          );
      }

      /// Two discards in one turn must not weld (ADR 0048), so the line's id
      /// increments per Retraction — the ids are unique, not shared.
      #[test]
      fn a_second_retraction_gets_its_own_line_id() {
          let mut st = TurnState::default();
          normalize(
              &RpcEvent::message_start { message: json!({ "role": "assistant" }) },
              &mut st,
          );
          let first = normalize(&RpcEvent::message_retracted, &mut st);
          let second = normalize(&RpcEvent::message_retracted, &mut st);
          assert_eq!(first[1]["messageId"], "retract:1");
          assert_eq!(second[1]["messageId"], "retract:2");
      }

      /// A Retraction with no message announced yet is still well-formed (the
      /// `default` id every other chunk falls back to).
      #[test]
      fn a_retraction_before_any_message_start_says_default() {
          let mut st = TurnState::default();
          let frames = normalize(&RpcEvent::message_retracted, &mut st);
          assert_eq!(frames.len(), 2);
          assert_eq!(frames[0]["sessionUpdate"], "message_retracted");
          assert_eq!(frames[0]["messageId"], "default");
      }
      ```

- [ ] `Step 3: run them, see them fail.` `cargo test --lib normalize 2>&1 | tail -30`
      → `no variant named 'message_retracted'` before Step 4, then empty frame
      vectors (the `_ => Vec::new()` arm at `:403`) once the variant exists.

- [ ] `Step 4: implement.` Add the `TurnState` field (`:58-64`):

      ```rust
      /// How many Retractions this turn has announced. The discard line needs a
      /// messageId UNIQUE per discard (ADR 0048) — two lines sharing `"system"`
      /// would weld into one bubble.
      pub retract_seq: u64,
      ```

      A helper beside `system_chunk` (`:66-76`):

      ```rust
      /// A one-line `agent_message_chunk` carrying a UNIQUE messageId — for a line
      /// that must survive being adjacent to another line. `system_chunk`'s shared
      /// `"system"` key APPENDS (that is its point), so a second line on it welds.
      fn unique_system_chunk(message_id: &str, text: impl Into<String>) -> Value {
          let text = text.into();
          json!({
              "sessionUpdate": "agent_message_chunk",
              "content": { "type": "text", "text": text },
              "messageId": message_id,
          })
      }

      /// Is this messageId a harness bookkeeping line rather than model output?
      /// `"system"` is the shared one-liner key; `"retract:N"` is a discard line
      /// (ADR 0048). Anything that must capture ONLY what the model said — the
      /// subagent capture, whose text becomes the PARENT's tool result — asks this
      /// instead of re-deciding the convention.
      pub(crate) fn is_bookkeeping_message_id(id: &str) -> bool {
          id == "system" || id.starts_with("retract:")
      }
      ```

      The arm, immediately before `auto_retry_start` (`:381`):

      ```rust
      // (ADR 0048) An Abandoned attempt's reply is retracted. The id is the one
      // the harness is ON — the retried call REUSES it (`message_start` fires
      // once per assistant message), which is precisely why the discard is a
      // protocol event and not something the reader may infer. Then the line
      // says so, on its own id: reusing `"system"` would weld it onto the
      // "Retrying (attempt 1/3…)" line this path emits immediately before.
      RpcEvent::message_retracted => {
          let mid = st
              .current_message_id
              .clone()
              .unwrap_or_else(|| "default".to_string());
          st.retract_seq += 1;
          vec![
              json!({ "sessionUpdate": "message_retracted", "messageId": mid }),
              unique_system_chunk(
                  &format!("retract:{}", st.retract_seq),
                  "Discarded an incomplete reply",
              ),
          ]
      }
      ```

- [ ] `Step 5: run, see them pass.` `cargo test --lib normalize` → ok. Task 4
      alone is behaviourally inert — nothing emits the event until Task 6.
- [ ] `Step 6: gate and commit.` `cargo test` (every other `match` on `RpcEvent`
      has a wildcard, so nothing else moves; there is no golden list of event
      kinds and no TS mirror of `RpcEvent`), `cargo clippy --all-targets`,
      `cargo fmt`, commit.

### Task 5: the rows go too — the harness-side Retraction

**Files:**
- Modify: `src-tauri/src/agent/normalize.rs` (`ThoughtState:31-36`, the segment-open site `:472-478`, the `compute_display_rows` doc at `:443`, a new arm after `agent_message_chunk` which ends `:521`)
- Test: `normalize.rs`, `mod compute_display_rows_tests` (`:1084`; it imports `compute_display_rows, ThoughtState` at `:1087` and `HashMap/Arc/StdMutex` at `:1090-1092` — add `use serde_json::json;` if absent)
- Commit: `fix: a Retraction clears the abandoned rows, not just the frame`

`compute_display_rows` owns the state a Retraction must clear. Two facts shape
it: **there is no DELETE** (Global Constraints), so rows are overwritten with
empty text and the reader skips empties; and a message's thought run is
`{id}#{first}..={id}#{last}` with `first > 1` for every message after the first,
because `next` counts segments for the life of the loop. So the arm must erase
**exactly the keys that exist** — writing `{"text":""}` to a key that never
existed INSERTS junk that the UPSERT can never remove.

- [ ] `Step 1: write the failing tests.` In `mod compute_display_rows_tests`,
      following the setup of
      `compute_display_rows_matches_the_legacy_persist_update_writes` (`:1122`)
      and the multi-frame driving of `:1249-1280`.

      ```rust
      /// (ADR 0048) A Retraction empties the abandoned message's rows — text AND
      /// thoughts — and empties the accumulators, so the retried call that REUSES
      /// the id starts from nothing instead of welding on.
      #[test]
      fn a_retraction_empties_the_abandoned_rows() {
          /* drive: agent_message_chunk "m1" ("parti") → agent_thought_chunk "m1"
             ("th") → a tool_call frame (closes the thought segment) →
             agent_thought_chunk "m1" ("second") → message_retracted "m1".
             Then assert the erased key set is EXACTLY
               { ("agent-text","m1"), ("agent-thought","m1#1"), ("agent-thought","m1#2") }
             all with payload {"text":""}, that text_acc no longer holds "m1", and
             that thought open_key is None and current is empty. */
      }

      /// The run does NOT start at `#1`: `next` counts segments for the life of
      /// the loop, so a second message's thoughts are `m2#2`, `m2#3`. Erasing a
      /// range from `#1` would UPSERT rows that never existed, and the UPSERT has
      /// no undo.
      #[test]
      fn a_retraction_erases_exactly_the_keys_that_exist() {
          /* drive: agent_thought_chunk "m1" → agent_thought_chunk "m2" →
             agent_thought_chunk "m2" (a tool_call frame between them forces a new
             segment) → message_retracted "m2". Assert EXACTLY
               { ("agent-thought","m2#2"), ("agent-thought","m2#3") }
             and in particular that NO "m2#1" row is produced. */
      }

      /// Nothing streamed under this id, so nothing is written: an empty Retraction
      /// must not litter the table.
      #[test]
      fn a_retraction_of_a_message_that_never_streamed_writes_nothing() {
          /* drive: message_retracted "m7" → assert the rows are empty. */
      }
      ```

- [ ] `Step 2: run them, see them fail.` `cargo test --lib normalize 2>&1 | tail -30`
      → the retraction kind falls through `_ => Vec::new()` (`:575`), so the
      first two tests get zero rows and still-find `"parti"` in the accumulator.

- [ ] `Step 3: record which segments a message actually used.` `ThoughtState`
      (`:31-36`) gains:

      ```rust
      /// The segment indices each messageId actually used, in order. A message's
      /// thought rows are `{id}#{n}` for these `n` — and they do NOT start at 1
      /// for any message but the first, because `next` counts segments for the
      /// life of the loop. A Retraction erases exactly this list: the display
      /// store UPSERTs and has no DELETE, so erasing a key that never existed
      /// writes a row that can never be removed.
      segments: HashMap<String, Vec<u32>>,
      ```
      At the segment-open site (`:472-478`, keeping its two comment lines):

      ```rust
      if state.open_key.as_deref() != Some(key.as_str()) {
          state.next += 1;
          state
              .segments
              .entry(key.clone())
              .or_default()
              .push(state.next);
          state.open_key = Some(key);
          state.current = String::new();
      }
      ```

- [ ] `Step 4: the Retraction arm.` After the `agent_message_chunk` arm (ends
      `:521`), before `Some("tool_call")` (`:522`):

      ```rust
      // (ADR 0048) An Abandoned attempt's reply is erased. The display store has
      // no DELETE, so the rows are OVERWRITTEN with empty text and the reader
      // hydrates an empty row as nothing; the accumulators go with the rows,
      // because the retried call REUSES this message id.
      Some("message_retracted") => {
          let Some(id) = update.get("messageId").and_then(Value::as_str) else {
              return Vec::new();
          };
          let mut rows = Vec::new();
          let streamed_text = {
              let mut acc = agent_text_acc
                  .lock()
                  .expect("agent-text accumulator poisoned");
              acc.remove(id).map(|t| !t.is_empty()).unwrap_or(false)
          };
          if streamed_text {
              rows.push(DisplayRow {
                  kind: "agent-text".to_string(),
                  message_key: id.to_string(),
                  payload_json: json!({ "text": "" }),
                  created_at: now_ms(),
              });
          }
          let segments = {
              let mut state = thought_state.lock().expect("thought state poisoned");
              // The abandoned message's thoughts are CLOSED: the retry opens a
              // FRESH segment (a new row key) rather than continuing text that was
              // just discarded.
              state.open_key = None;
              state.current = String::new();
              state.segments.remove(id)
          };
          if let Some(used) = segments {
              rows.extend(used.into_iter().map(|n| DisplayRow {
                  kind: "agent-thought".to_string(),
                  message_key: format!("{id}#{n}"),
                  payload_json: json!({ "text": "" }),
                  created_at: now_ms(),
              }));
          }
          rows
      }
      ```

- [ ] `Step 5: correct the function's contract.` The doc at `:443` says "Returns
      0 or 1 rows (the `_` arm … yields none)". It is now 0 or more: a Retraction
      returns one row per erased row. Update that sentence — otherwise the next
      reader "fixes" this arm to one row. (The golden test at `:1147` asserts one
      row for ITS sequence, which contains no Retraction, and still passes.)

- [ ] `Step 6: run, see them pass.` `cargo test --lib normalize` → ok. The
      existing thought-keying tests still pass: `segments` is bookkeeping and
      changes no key.
- [ ] `Step 7: gate and commit.` `cargo test`, `cargo clippy --all-targets`,
      `cargo fmt`, commit.

### Task 6: the harness retracts at both abandonment sites

**Files:**
- Modify: `src-tauri/src/agent/harness/loop.rs` (`:989-1036` retryable retry — `turn_abandoned` at `:1026`; `:1047-1056` overflow mid-stream intercept — `if !overflow_recovered {` at `:1048`, `turn_abandoned` at `:1050`)
- Test: same file (`mod tests`)
- Commit: `fix: an abandoned reply is retracted before the retry reuses its id`

Both sites are in scope: ADR 0048 says the rule is general and that "**any third
retry path must emit the retraction too**". The gate is `acc` — the per-call
`TurnAccumulator` created at `:872`, in scope at both sites (the only partial
move, `std::mem::take(&mut acc.tool_calls)`, happens after them), holding exactly
this attempt's streamed bytes. The overflow **pre-stream** arm (`:836-851`) needs
nothing: `acc` does not exist yet, so nothing streamed.

- [ ] `Step 1: write the failing tests.` In `mod tests`, after
      `a_mid_stream_context_overflow_compacts_and_retries_the_turn` (ends
      `:3633`). Copy the harness/event plumbing from
      `a_retried_model_call_emits_one_message_start` (`:3220-3263`) and
      `a_mid_stream_context_overflow_compacts_and_retries_the_turn`
      (`:3564-3633`) — same `ScriptedProvider`, same builder, same
      `collect_events_until`.

      ```rust
      /// (ADR 0048) The retryable retry reuses the message id, so the partial
      /// reply it abandons is RETRACTED — otherwise `parti` welds onto `done`.
      #[tokio::test]
      async fn a_retried_reply_is_retracted_before_the_retry() {
          /* script: [TextDelta("part"), Error(Retryable("transient"))] then
                     [TextDelta("done"), Done(Stop)] */
          // assert: exactly ONE `message_retracted`; it precedes `agent_end`;
          //         `message_start` still counts 1 (the invariant holds).
      }

      /// (ADR 0048) The overflow recovery retracts too — the second retry path.
      #[tokio::test]
      async fn a_mid_stream_overflow_retracts_the_partial_reply() {
          /* the exact script of a_mid_stream_context_overflow_compacts_and_retries_the_turn:
             [TextDelta("parti"), Error(ContextOverflow(…))] then
             [TextDelta("summary"), Done(Stop)] then
             [TextDelta("recovered"), Done(Stop)] */
          // assert: exactly ONE `message_retracted`; ONE `message_start`;
          //         `compaction_start { reason: "overflow" }` still fires.
      }

      /// The gate is "streamed something", not "the attempt was abandoned": a
      /// PRE-stream overflow streams nothing and must stay silent (ADR 0048).
      #[tokio::test]
      async fn a_pre_stream_overflow_retracts_nothing() {
          /* OverflowingProvider::new(&[0], …) — the first call fails before any
             byte streams. */
          assert!(
              !kinds.iter().any(|k| k == "message_retracted"),
              "an attempt that streamed nothing is not a Retraction, got {kinds:?}"
          );
      }

      /// Same rule on the other path: a retryable error that arrives before any
      /// text emits no Retraction.
      #[tokio::test]
      async fn an_abandoned_attempt_that_streamed_nothing_is_silent() {
          /* script: [Error(Retryable("boom"))] alone on the first call, then a
             good second call. Assert no `message_retracted` event. */
      }
      ```

- [ ] `Step 2: run them, see them fail.` `cargo test --lib harness::loop 2>&1 | tail -40`
      → the two Retraction tests fail (no such event). **The two silence tests
      already pass before this task and must keep passing** — they pin the absence
      of a frame, so they are not this task's red; do not count them.

- [ ] `Step 3: retract at the retryable site.` Immediately before
      `self.compactor.turn_abandoned(&self.messages);` (`:1026`):

      ```rust
      // (ADR 0048) The partial reply this attempt streamed is RETRACTED before
      // the retry reuses its message id. `acc` is this call's own accumulator —
      // the exact bytes it streamed, and the exact reason the renderer would
      // otherwise weld `parti` onto `done`. Nothing streamed → silent.
      if !acc.text.is_empty() || !acc.thinking.is_empty() {
          self.emit(RpcEvent::message_retracted);
      }
      ```

- [ ] `Step 4: retract at the overflow mid-stream site.` Inside
      `if !overflow_recovered {` (`:1048`), before
      `self.compactor.turn_abandoned(&self.messages);` (`:1050`) — the same guard,
      with a comment pointing at the retryable site as its sibling.

- [ ] `Step 5: run.` `cargo test --lib harness::loop` → the two new tests pass and
      every existing retry/overflow test still passes:
      `a_retried_model_call_emits_one_message_start`,
      `a_mid_stream_context_overflow_compacts_and_retries_the_turn`,
      `a_later_overflow_in_the_same_turn_gets_its_own_compact_and_retry`,
      `a_second_overflow_after_a_failed_recovery_gives_up_without_a_second_request`,
      `a_retried_model_call_does_not_compact_for_the_reply_it_threw_away`. They
      assert on `RpcEvent`s only and never inspect frames, so a new event is
      invisible to them — if one fails, you changed something you should not have.
- [ ] `Step 6: full Rust gate and commit.` `cargo test`,
      `cargo clippy --all-targets`, `cargo fmt --check`, commit.

### Task 7: the Client honours the Retraction

**Files:**
- Modify: `src/lib/tauri.ts` (`AcpSessionUpdate`, ends `:189`)
- Modify: `src/store/sessions.ts` (pure reducer `:125-213`; hydration `rowToMessages:300-387`)
- Test: `src/store/sessions.test.ts`
- Commit: `feat: the Client drops a retracted reply and hydrates past an empty row`

The live reducer appends by `messageId` (`:131-159`), so the Retraction removes
instead. There is no precedent for splicing a message by id — every existing
removal rebuilds the array inside an *action* (`:1237-1248`, `:245-259`) — but a
filter is pure and returns the SAME array reference when nothing matched, which
keeps the batch path's reference-based changed-sentinel (`:1370`) honest.
`applySessionUpdates` (`:1339-1371`) delegates to this reducer per update, so it
needs no change.

- [ ] `Step 1: write the failing tests.` In `src/store/sessions.test.ts`. Use the
      file's OWN fixtures: the hydration describe at `:1269` builds rows with
      `row({ kind, messageKey, payloadJson, createdAt })` (object form,
      `:1270-1279`) and the thought tests at `:157-185` use `msgRow({…})` — do NOT
      invent positional helpers.

      ```ts
      // (ADR 0048) A Retraction removes the abandoned message's rows — text and
      // thought alike, since both are keyed by the message's id while live.
      it("removes every message carrying the retracted messageId", () => {
        const before: Message[] = [
          { kind: "user", text: "go", at: 1 },
          { kind: "agent-thought", messageId: "m1", text: "th", at: 2 },
          { kind: "agent-text", messageId: "m1", text: "parti", at: 3 },
        ];
        expect(
          applySessionUpdate(before, { sessionUpdate: "message_retracted", messageId: "m1" }, 4),
        ).toEqual([before[0]]);
      });

      it("is silent when nothing was streamed under that messageId", () => {
        const before: Message[] = [{ kind: "agent-text", messageId: "m1", text: "kept", at: 1 }];
        expect(
          applySessionUpdate(before, { sessionUpdate: "message_retracted", messageId: "m9" }, 2),
        ).toBe(before); // the SAME reference — the batch sentinel stays false
      });

      it("leaves the discard line and the tool cards alone", () => {
        /* a `messageId: "system"` one-liner, a discard line `retract:1`, and a
           `tool-call` message; retract "m1"; assert all three survive. */
      });

      // A Retraction persists as an empty row; history must not resurrect it.
      it("hydrates an empty agent-text row as nothing", () => {
        expect(
          rowToMessages(row({ kind: "agent-text", messageKey: "m1", payloadJson: '{"text":""}' })),
        ).toEqual([]);
      });
      it("hydrates an empty agent-thought row as nothing", () => {
        expect(
          rowToMessages(msgRow({ kind: "agent-thought", messageKey: "m1#1", payloadJson: '{"text":""}' })),
        ).toEqual([]);
      });
      ```
      Match the fixture names/fields the file actually uses; assert the real
      `Message` shape (both `agent-text` and `agent-thought` carry a REQUIRED
      `messageId`, `sessions.ts:38-39`).

- [ ] `Step 2: run them, see them fail.` `pnpm test src/store/sessions.test.ts` →
      `message_retracted` falls to the reducer's `default` (`:210`) leaving `parti`,
      and the empty rows hydrate into real empty messages.

- [ ] `Step 3: the frame type.` `src/lib/tauri.ts`, after the `compaction_update`
      member (which terminates at `:189`) — change that member's `};` to `|` and
      end the new one with `};`:

      ```ts
      | {
          /** (ADR 0048) An Abandoned attempt's reply is RetRACTED: every
           * agent-text / agent-thought message with this `messageId` is dropped.
           * Silent when nothing was streamed under it. The discard line arrives
           * separately as a `retract:N` chunk, so it survives. */
          sessionUpdate: "message_retracted";
          messageId: string;
        };
      ```

- [ ] `Step 4: the reducer case.` `src/store/sessions.ts`, in the `switch`
      (`:130`), after `agent_thought_chunk` (ends `:159`):

      ```ts
      case "message_retracted": {
        // (ADR 0048) The attempt behind this messageId was abandoned and its
        // reply retried under the SAME id (one message_start per message), so the
        // partial text must not weld onto the retry. Live thought messages carry
        // this bare id too (the `#n` suffix is a persistence detail), so this
        // clears thoughts with the text. Bookkeeping lines (`system`, `retract:N`)
        // are never the abandoned id, so they survive.
        const kept = messages.filter(
          (m) =>
            (m.kind !== "agent-text" && m.kind !== "agent-thought") ||
            m.messageId !== update.messageId,
        );
        // Same reference when nothing matched: silence must not read as a change.
        return kept.length === messages.length ? messages : kept;
      }
      ```

- [ ] `Step 5: hydration skips an empty row.` `rowToMessages`: the `agent-text`
      arm (`:334-344`) and `agent-thought` arm (`:345-355`) guard only
      `typeof payload.text === "string"`, so an empty Retraction row hydrates as a
      real (empty) bubble. Add the emptiness guard to both:

      ```ts
      return typeof payload.text === "string" && payload.text !== ""
        ? [ /* the same message object as now */ ]
        : [];
      ```
      No new arm and no new kind: a Retraction never reaches `rowToMessages` as a
      kind of its own. The `user` arm is untouched, so an image-only prompt
      (`text: ""`) still hydrates.

- [ ] `Step 6: run, see them pass.` `pnpm test src/store/sessions.test.ts` → all
      pass, including the pre-existing
      `maps an agent-text row to an agent-text message with its messageId`,
      `returns empty for an agent-thought row with a non-string payload.text`,
      `ignores non-text or empty thought chunks` (`:140`) and
      `ignores unknown update types` (`:1556`).

- [ ] `Step 7: full frontend gate and commit.` `pnpm test` and `pnpm build` (tsc
      must accept the widened union; there is no `never`-exhaustiveness check on
      `AcpSessionUpdate`). Note in the commit message that pre-existing empty
      `agent-text` / `agent-thought` rows now drop out of history — a behaviour
      change slightly wider than retractions, and intended.

### Task 8: the subagent capture honours the Retraction

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs` (`SubagentCapture::observe_sink_frame:143-171`)
- Test: same file (`mod tests` — follow the existing `SubagentCapture` usage near `:972-1013` for construction)
- Commit: `fix: a retracted child reply never reaches the parent's tool result`

`captured_text()` (`:195-208`) becomes the parent's `subagent` tool result — the
one place a welded reply is fed to a MODEL rather than shown to a human. A
retried child streams `"part"` then `"done"` under the same id, and
`observe_sink_frame` appends both, so the parent reads `"partdone"`. Note this is
also where Task 4's `retract:N` line would otherwise leak: it IS an
`agent_message_chunk`, so a capture that only excludes `"system"` would hand the
parent the sentence "Discarded an incomplete reply" as its child's output.

- [ ] `Step 1: write the failing tests.`

      ```rust
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
      ```

- [ ] `Step 2: run them, see them fail.` `cargo test --lib worker::manager 2>&1 | tail -30`
      → first: `"partdone" != "done"`; second: `"Discarded an incomplete reply" != ""`.

- [ ] `Step 3: implement.` In `observe_sink_frame`, immediately after
      `let update = payload.get("update");` and BEFORE the
      `!= Some("agent_message_chunk")` early return (`:147-153`):

      ```rust
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
              let mut last = self.last_message_id.lock().unwrap_or_else(|p| p.into_inner());
              if last.as_deref() == Some(id) {
                  *last = None;
              }
          }
          return;
      }
      ```
      Then replace the `mid != "system"` guard (`:165`) with the shared rule, so
      the discard line is excluded by definition rather than by coincidence:

      ```rust
      if !delta.is_empty() && !crate::agent::normalize::is_bookkeeping_message_id(mid) {
      ```

- [ ] `Step 4: run, see them pass.` `cargo test --lib worker::manager` → ok, and
      the existing capture tests (the settle/outcome ones around `:972-1140`) still
      pass — `captured_text()`'s contract is unchanged for every frame that is not
      a Retraction.
- [ ] `Step 5: gate and commit.` `cargo test`, `cargo clippy --all-targets`,
      `cargo fmt`, commit.

### Task 9: an abandoned attempt's tool calls are closed, not left spinning

**Files:**
- Modify: `src-tauri/src/agent/harness/loop.rs` (a constructor next to `cancelled_tool_result` at `:1519-1528`; the `if` Task 6 added at each abandonment site)
- Test: same file (`mod tests`)
- Commit: `fix: an abandoned attempt's tool calls close instead of spinning forever`

A `ToolCall` in the stream announces a card (`normalize.rs:256-262`,
`status: "in_progress"`) and an abandoned attempt never dispatches it, so the card
spins forever — live, and in the persisted `tool-call` row that reloads.

**No new protocol, and no frontend change.** `tool_execution_end` with
`is_error: true` ALREADY maps to `status: "failed"` (`normalize.rs:325-331`),
which the live reducer applies (`sessions.ts:176-205`) and which
`compute_display_rows` merges into the persisted row (`normalize.rs:543-571`), so
card, row and reload agree. And the harness already closes calls that never ran:
the cancel path emits synthetic ends built from `cancelled_tool_result()`
(`loop.rs:1164-1174`, `:1519-1528`). An Abandoned attempt owes the same.

Do NOT express this through the `message_retracted` frame: tool rows are keyed by
`toolCallId`, not `messageId`, so a frame carrying only the message id cannot
reach them — and firing a Retraction for a tool-only attempt that streamed no
text would break ADR 0048's silence rule.

- [ ] `Step 1: write the failing tests.` In `mod tests`.

      ```rust
      /// (ADR 0048) An Abandoned attempt's tool calls were ANNOUNCED and never
      /// ran. Leaving them open is a card that spins forever, live and persisted.
      #[tokio::test]
      async fn a_retried_reply_closes_the_tool_calls_it_abandoned() {
          /* script: first call = [ToolCall(t1 "bash"), Error(Retryable)] then a
             good second call. Assert a `tool_execution_end` for `t1` with
             `is_error: true` fires; that `message_retracted` fires (a tool-only
             discard is still a discard); and that the turn settles. */
      }

      /// The Provider transcript is untouched by the close: no `tool` message is
      /// appended for a call that never dispatched, because the retry replays the
      /// SAME messages.
      #[tokio::test]
      async fn an_abandoned_tool_call_appends_no_tool_message() {
          /* same script; after settling, load the native transcript and assert no
             `ChatRole::Tool` row exists. */
      }

      /// The overflow recovery closes them too.
      #[tokio::test]
      async fn a_mid_stream_overflow_closes_the_abandoned_tool_call() { /* … */ }

      /// Nothing announced, nothing to close — the silence rule still holds.
      #[tokio::test]
      async fn an_abandoned_attempt_that_announced_nothing_closes_nothing() {
          /* script: [Error(Retryable)] alone, then a good call. Assert NO
             `tool_execution_end` and NO `message_retracted`. */
      }
      ```

- [ ] `Step 2: run them, see them fail.` `cargo test --lib harness::loop 2>&1 | tail -40`
      → the three closing tests fail in `wait_for_event` (no `tool_execution_end`
      for `t1`); the fourth passes already and must stay passing — it is not this
      task's red.

- [ ] `Step 3: the honest result shape.` Next to `cancelled_tool_result` (`:1519`):

      ```rust
      /// The result for a tool call that never dispatched because its model call
      /// was Abandoned (ADR 0048). Honest about the reason: the tool did not FAIL —
      /// it was discarded with the attempt that announced it.
      fn abandoned_tool_result() -> ToolResult {
          ToolResult {
              content: vec![ContentBlock::Text {
                  text: "discarded — the model call that asked for this tool was \
                         abandoned before it ran"
                      .to_string(),
              }],
              details: None,
              is_error: true,
          }
      }
      ```

- [ ] `Step 4: close the calls, then retract.` At BOTH sites, replace the `if`
      Task 6 added with the block below (comment once, at the retryable site):

      ```rust
      // (ADR 0048) Each abandoned `tool_calls` entry was already ANNOUNCED (a
      // `tool_call` card at `in_progress`) and never dispatched, so it would spin
      // forever — live and in the persisted row. The cancel path closes calls that
      // never ran the same way; an Abandoned attempt owes the same. No `tool`
      // message is appended: the Provider transcript stays as it is, because the
      // retry replays the SAME messages.
      for tc in &acc.tool_calls {
          let result = Self::abandoned_tool_result();
          let result_value = serde_json::to_value(&result).unwrap_or(Value::Null);
          self.emit(RpcEvent::tool_execution_end {
              tool_call_id: tc.id.clone(),
              tool_name: tc.name.clone(),
              result: result_value,
              is_error: true,
          });
      }
      // A tool-only discard is still a discard, so the gate widens to it.
      if !acc.text.is_empty() || !acc.thinking.is_empty() || !acc.tool_calls.is_empty() {
          self.emit(RpcEvent::message_retracted);
      }
      ```
      Cards close first, then the text is retracted, then the discard line — so the
      transcript reads in that order.

      Note for the commit message: if a retry regenerates the SAME tool-call id,
      `normalize` sends a `tool_call_update` rather than a fresh `tool_call`
      (`:282-291`), which moves the just-closed card back to `in_progress` — the
      correct outcome for a tool that is now genuinely running.

- [ ] `Step 5: run.` `cargo test --lib harness::loop` → the new tests pass, the
      Task 6 silence tests still pass, and every existing tool test is untouched
      (`a_tool_batch_is_measured_before_the_next_compaction_check`, the dispatch
      and `ask_flow` tests) — a normal turn's `tool_execution_end` path does not
      change.
- [ ] `Step 6: full gate and commit.` `cargo test`,
      `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`,
      `pnpm test`, `pnpm build` — the frontend changes nothing here, so its suites
      must come back unchanged.

---

## Final validation (whole branch)

Run from the two roots, **sequentially**:

```bash
cd src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets -- -D warnings
pnpm test && pnpm build
```

Expect: `cargo fmt --check` clean; `cargo test` all green;
`cargo clippy --all-targets -- -D warnings` zero warnings; `pnpm test` all green;
`pnpm build` clean. Known load-flaky tests if a run reddens with a 5 s timeout:
`SettingsPage.test.tsx`, `ModelPicker.test.tsx`, `App.test.tsx`, `SkillsDialog`,
`SpacesList` (vitest) and
`agent::mcp::http::tests::http_a_slow_sse_stream_completes` (Rust) — re-run the
single file to confirm.

## Execution flow

1. **Main agent**: orchestrates only — no code edits.
2. **`general` subagent**: implements each task start-to-finish (TDD: failing
   test → confirm red → implement → confirm green → gate → commit).
3. **Main agent**: reads the actual diff and `git log`, runs the gates itself,
   marks that task's checkboxes, then moves on. Do not batch checkbox updates.
4. **Run Tasks 1→2→3 serially** — they all edit `compact.rs` and each commits.
   Task 5 needs Task 4's frame shape; Task 6 needs Task 4's event; Task 9 edits
   the same two lines Task 6 adds, so it runs AFTER Task 6. Task 7 needs only
   Task 4's frame shape (may run alongside 5, 6 and 9); Task 8 needs Task 4's
   frame shape and `is_bookkeeping_message_id`.
