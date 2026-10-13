---
status: committed
done-when: "Typing `/compact` at idle compacts the session immediately and the composer shows `Compacting` with the `pulse` spinner; a provider context-overflow 400 compacts and retries the SAME turn with no user action and no error line; a 32k-window model's compaction actually shrinks the transcript; and an Anthropic session's context bar counts its cached prefix."
---

# Compaction: `/compact`, overflow recovery, and a visible "Compacting" — Plan

**Goal:** Make compaction reachable by hand (`/compact`), able to recover a context-overflow failure inside the same turn, able to actually shrink small-window models, and visible in the composer as `Compacting` with the `pulse` spinner.

**Architecture:** Four seams. (1) `Compactor` derives the keep-recent budget from the model's window instead of trusting one catalog-wide 20k. (2) A provider overflow becomes its own `ProviderError` tier, classified once in the shared HTTP transport, and recovered *inside* the turn's inner loop via a reason-carrying forced-compaction flag. (3) `/compact` is a new **Composer command** — a fourth composer prefix with a third semantics (act-and-consume) — dispatched over the existing idle-time `ControlCmd` channel. (4) `compaction_start`/`compaction_end` gain a real `reason` and a state frame (`compaction_update`) the renderer keys a `compacting` flag off, which the working indicator draws as `pulse` + "Compacting".

**Tech stack:** Rust (Tauri 2 backend, `src-tauri/`), React 19 + TypeScript + Zustand + Vitest (`src/`). No new dependencies (`regex` is NOT in `Cargo.toml` — it is transitive in `Cargo.lock` only, so `use regex::…` will not compile; use lowercase substring matching).

**Validation (`AGENTS.md`):** Rust from `src-tauri/` — `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`. **CI runs it as `cargo clippy --all-targets -- -D warnings`**, and `unused_variables` / `unused_assignments` are warn-by-default — so a variable a task declares but never reads fails that task AND blocks every later task. Do not add a local nothing reads. Frontend from the repo root — `pnpm test` (= `vitest run`; `pnpm test src/store` filtering is verified to work), `pnpm build` (= `tsc && vite build`). A task is done only when all are green.

**Terminology (`CONTEXT.md`):** **Agent harness**, **Session**, **Worker process**, **Supervisor**, **Anchor** / **Watermark**, **compaction reason**, **Composer command**, **Mention**, **File completion**, **working indicator** (`WorkingIndicator`), **Space**.

**Durable decisions:** ADR 0044 (composer-command grammar), ADR 0045 (overflow is a tier, recovered in-turn, never retried), ADR 0046 (`input_tokens` is cache-inclusive at the parser seam). Read all three first.

**Task order matters:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 4 consumes Task 2's frame; Task 3 arms the cancel token Task 4 depends on; Task 6 uses Task 2's `reason` values and the `shrank` bool, and Task 1's budget to succeed.

---

## Verified facts (already checked against the code — do not re-derive, do not "fix")

| Fact | Where |
|---|---|
| `Compactor` fields: `config: CompactionConfig`, `context_window: u32` | `compact.rs:26-27` |
| Defaults `16384` / `20000`; `CompactionConfig { enabled, reserve_tokens, keep_recent_tokens }` | `catalog.rs:19-20`, `:82-85` |
| `run_compaction` the FREE FUNCTION (takes `CompactionCtx`) vs `run_compaction` the METHOD on `AgentLoop` | `compact.rs:305` vs `loop.rs:1626` |
| `CompactionCtx` has 3 construction sites: `compact.rs:1325` (`call_summarize`), `compact.rs:1361` (`Harness::run`), `loop.rs:1632` | — |
| The test harness is `Harness` (`compact.rs:1339`), `run` at `:1360`, `Harness::new` at `:1348`. Helpers: `temp_store` `:582`, `fake_model` `:563` (window 128000 `:569`), `text_msg` `:602` | — |
| Existing fixtures force a real compaction with a tiny EXPLICIT budget: `compact.rs:1366` (`keep_recent_tokens: 1`) and `loop.rs:3404`, `:4103`, `:4209` (`catalog.compaction.keep_recent_tokens = 1`) | — |
| `run_compaction` is called in tests too: `loop.rs:3087`, `loop.rs:4130` | — |
| Compaction emit sites: `compaction_start` `loop.rs:1627`, `compaction_end` `loop.rs:1655`; `aborted` is set true ONLY on `CompactionOutcome::Failed` (`loop.rs:1651`) | — |
| Threshold check + compaction call: `loop.rs:716-718`; model call follows at `loop.rs:735` | — |
| Pre-stream error arm `Err(e) =>` at `loop.rs:757`, `settle_error` at `:763`; `self.retry = retry;` at `:754` (so a `continue` from a new arm is safe) | — |
| Mid-stream error is CAPTURED at `loop.rs:869` (inside the stream-consumption loop, `:791-877`) and HANDLED at `loop.rs:937-943`; the existing retry loop-back (`continue`) is at `:925-928`; the model call is at `~:723`/`~:745`; `note_context()` after the assistant push is `:975` | — |
| `settle_error` emits ONLY `turn_end` + `agent_settled` (`loop.rs:1188-1196`); normalize's catch-all is `_ => Vec::new()` (`normalize.rs:547`); `auto_retry_end`'s one-liner DROPS `final_error` (`normalize.rs:351-356`); `extension_error` → `"Extension error: …"` (`normalize.rs:357-359`). **There is NO existing route that shows a provider error body in the transcript** — mid-stream errors are `eprintln!` only (`loop.rs:762`, `:941`) | — |
| `normalize.rs` has TWO test modules: `mod normalize_tests` (`:553`, holds `bookkeeping_events_and_one_liners` at `:907`) and `mod compute_display_rows_tests` (`:959`, holds the fixture test at `:997` and imports `compute_display_rows`) | — |
| A budget of 0 is EXACTLY equivalent to a budget of 1 in `split_for_compaction` (`estimate_message_tokens` returns ≥ 1, so the backward walk breaks right after the last message) | `compact.rs:197-230` |
| `ProviderEvent::Error` is captured INSIDE the stream-consumption loop (`loop.rs:791-877`) at `:869`, and `mid_stream_error` is HANDLED at `:937-943`. `map_anthropic_error` (`anthropic.rs:84-108`) is the ONLY producer of mid-stream `ProviderError`s and maps `invalid_request_error` → `Fatal` | — |
| `system_chunk` emits `messageId: "system"` (`normalize.rs:69-76`) and `applySessionUpdate` APPENDS same-`messageId` chunks with NO separator (`sessions.ts:110-124`) — two consecutive one-liners in one batch weld into one bubble | — |
| `pickerRows`'s switch variable is `prefix` (`= picker?.prefix ?? "$"`, `ChatStream.tsx:552`), the rows go through a shared `matchedRows` filter (`r.name.toLowerCase().includes(…)`, `:701`), and the row type is `MentionRow { key; prefix; name; label?; isDir?; description? }` (`ComposerMentions.tsx:13-38`) | — |
| `send()`'s `try {` is `:880` (right after `sendingRef.current = true;` `:879`; `setError(null)` is `:881`) with `finally { sendingRef.current = false }` at `:1008-1010` — an early `return` OUTSIDE the `try` leaves `sendingRef.current` stuck `true` and every later send no-ops at `:878` | — |
| `take_pump()` returns `Some` only AFTER `core.handle(Inbound::from(&env)).await` (`core.rs:349-358`), and its tuple is `(events_rx, join_handle)` — the pump itself is a separate `pump_tx`/`pump_rx` pair (`core.rs:727-740`). `src/bin/fake_worker.rs:597` matches `Inbound` with a `_ => {}` catch-all | — |
| HTTP status → `ProviderError` happens in ONE shared place: `provider/transport.rs` `map_status`/`map_response` (`:57-92`, the 4xx→`Fatal` arm is `:69-70`), used by `openai.rs:88,110`, `anthropic.rs:732`, `responses.rs:676`. `map_anthropic_error` (`anthropic.rs:84-108`) maps an SSE `error` EVENT, not a status, and is the ONLY mid-stream `ProviderError` producer | — |
| `stream_options` latch logic is `openai.rs:90-110` (the doc comment is `:59-66`) and its gate is `!matches!(err, ProviderError::Fatal(_))` at `openai.rs:97` | — |
| `RetryPolicy` already returns any non-`Retryable` variant verbatim (`retry.rs:139`, `:177-179`); the pin test is `fatal_is_never_retried` at `retry.rs:311` | — |
| `Inbound` deserialization uses an EXPLICIT `type` allow-list in `decode_inbound` (`protocol.rs:321-342`); everything else → `Inbound::Unknown`. The Inbound round-trip test is at `protocol.rs:666` | — |
| `WorkerCore::handle` returns `Vec::new()` for control-ish frames; `RpcEvent`s leave through the PUMP (`take_pump()` at `core.rs:351`, one-shot `&mut self`), not the outbound channel. `stub_core` `core.rs:660`, `stub_handles` `core.rs:595` (its `CannedProvider` at `:535-550` returns a COMPLETE stream synchronously) | — |
| `Abort` cancels whatever token is in the shared `turn_cancel` mutex at that instant (`core.rs:422-433`); `handle_prompt` arms a FRESH turn token per prompt (`loop.rs:631-635`); `run()`'s turn-cancel arm re-arms + drains the prompt queue (`loop.rs:544-568`) | — |
| `cancel_requested` is CLEARED in `send_prompt` (`session/mod.rs:1198`) and read only while a `pending_turn` slot is occupied (`router.rs:170-189`) → an idle compaction cannot leak it | — |
| `AgentLoop` is `pub`-re-exported (`harness/mod.rs:35`), so deleting `AgentLoop::compact()` produces NO `dead_code` warning | — |
| Anthropic `message_start` usage read is `anthropic.rs:222-229`; `Usage` is emitted from `emit_usage` (`:354-366`), which RETURNS when both `input_tokens` and `last_output_tokens` are `None` | — |
| `Usage` struct `types.rs:207`; `prompt_tokens` read `openai.rs:232-242`; `response_usage` `responses.rs:345`; `usage_value()` `loop.rs:1858` | — |
| `pulse` is a real variant: `src/lib/braille-loader.ts:20`, `src/lib/braille/registry.ts:39`; prop type `src/components/ui/braille-loader.tsx:13`; its `label` renders as an `sr-only` span (`:103`) and the frame span is `aria-hidden` but contributes braille glyphs to `textContent` (`:104-113`) | — |
| A Rust `sessionUpdate` reaches the store VERBATIM: `loop.rs:1826-1831` → `session/router.rs:36-39` → `App.tsx:60-64` → `lib/batchSessionUpdates.ts` → `sessions.ts:1242` `applySessionUpdates`. Unknown kinds are silently ignored (pure reducer `default:` at `sessions.ts:192`). Production uses ONLY the batch action | — |
| `handleSessionClosed` (`sessions.ts:1304`) deliberately KEEPS `configOptions` + `contextUsage` (`:1335-1341`, pinned by `sessions.test.ts:876`); `markStalled` is `sessions.ts:697`. `tauri.ts:57`'s "dropped on close" comment is STALE | — |
| The composer textarea has NO `disabled` attribute EVER (`ComposerRow.tsx:150-166`) — `composerLocked` disables only `+` (`:290`) and Send (`:381-385`). Pinned by `ChatStream.test.tsx:774,790,888,942,1033,1061,1081` | — |
| The send function is `send` (`ChatStream.tsx:875`), NOT `handleSend`; stale-draft guard `:935`; `expandMentions` `:950`; the auto-resume block is `:884-901`; `sendingRef.current = true` is `:879` | — |
| Row insertion policy is `selectMention` (`ChatStream.tsx:1243-1248`); its final fall-through `` `${row.prefix}${row.name.toLowerCase()} ` `` ALREADY produces `/compact ` for `prefix: "/"` | — |
| Picker rows are built in the `pickerRows` memo (`ChatStream.tsx:546-735`); its catalog switch TERMINATES in `else: skills.map(...)` at `:694`. `ComposerMentions.tsx` is prefix-agnostic (renders `row.prefix` as a badge) | — |
| `ComposerRow.tsx:247-259` is the `completionPending` Enter-HOLD gate, NOT an insertion policy. Enter is intercepted by the picker whenever `picker && token && filtered.length > 0` (`:220-224`) | — |
| `ChatStream.test.tsx` mock factory is `{ ...actual, … }` at `:128-208`; `seedLiveSession` at `:216-230` enumerates the store keys it resets | — |
| `ComposerPrefix` `skills.ts:273`; the "share a picker, not a semantics" comment `skills.ts:268`; `FILE_ABSOLUTE_TOKEN_RE` `:427` admits SPACES | — |

---

### Task 1: The keep-recent budget is derived from the model's window

**Context:**
`CompactionConfig` (`catalog.rs:82`) is ONE catalog-wide value (`reserve_tokens: 16384`, `keep_recent_tokens: 20000`) while `context_window` is per-`Model`. `split_for_compaction` (`compact.rs:197`) walks backwards spending that fixed 20k, so on a model whose whole transcript fits inside 20k the budget is never exhausted, `older` comes back EMPTY, `run_compaction` returns `CompactionOutcome::Skipped`, and nothing shrinks — while `should_compact()` stays true forever. Any window under ~36k is degenerate, and Settings lets users add their own providers, so 32k and 8k models are one edit away. That also breaks Task 6's overflow recovery, which needs a compaction to actually shrink. Fix: the production budget is `min(configured, what the window can afford)`.

**Design constraints this task must respect (verified):**
- `CompactionCtx.keep_recent_tokens` STAYS. It is the explicit-budget seam three test fixtures use to force a real compaction (`compact.rs:1366` passes `1`; `loop.rs:3404`, `:4103`, `:4209` set `catalog.compaction.keep_recent_tokens = 1`). Removing the field or overriding a small configured value with a floor reddens those fixtures.
- Therefore: **no floor.** A budget of 0 is meaningful and correct — `split_for_compaction` with budget 0 breaks on its first iteration and keeps exactly the LAST message (and snaps back off a `tool` message), which is the aggressive-but-bounded shrinking a tiny window needs.
- Consequence for the three fixtures that set `catalog.compaction.keep_recent_tokens = 1` AFTER `AgentLoop::new` (`loop.rs:3404`, `:4103`, `:4209`): that knob becomes inert, because production now reads the budget from the COMPACTOR's own config copy. `:3404` (window 16 484) and `:4209` (switches to 16 484 via `set_model`, which rebuilds the `Compactor` — `loop.rs:414`) land on budget 0 and still compact, which is equivalent to budget 1 (see the table above) — **leave those two alone**. But `:4103` (`a_compaction_emits_a_context_usage_update_from_the_reestimate`, test at `:4083`) uses `fake_model("m1")` = window **128 000** → budget 20 000 → its 4-message transcript (~4 tokens) yields `older` empty → `Skipped` → the fixture would silently stop exercising a compaction (its scripted `"the summary"` reply going unused while its tautological assertion still passes). **Fix it honestly at `:4103`:** replace the catalog mutation with a compactor replacement, so the budget lands where production reads it:
  ```rust
  loop_.compactor = Compactor::new(
      CompactionConfig { keep_recent_tokens: 1, ..Default::default() },
      128_000,
  );
  ```
  Then assert the compaction really ran (e.g. the resulting transcript is 2 messages, or a `context_usage_update` follows the compaction frame).

**Files:**
- Modify: `src-tauri/src/agent/harness/compact.rs` — add `Compactor::keep_budget()` (put it next to `should_compact`, ~line 121); extend `Harness` (`compact.rs:1339`) with a `keep: Option<u32>` field, initialize it as `keep: None` in `Harness::new` (`:1348` — omitting it is `E0063` in every existing test), and have `Harness::run` (`:1360`) use it in place of the hardcoded `keep_recent_tokens: 1` when set (`None` → current behaviour, so every existing `Harness` test is untouched).
- Modify: `src-tauri/src/agent/harness/loop.rs:1632` — in the `CompactionCtx` literal, compute the budget BEFORE constructing the ctx (borrow: `keep_budget(&self)` must not overlap `compactor: &mut self.compactor`):
  ```rust
  let keep_recent_tokens = self.compactor.keep_budget();
  let mut ctx = compact::CompactionCtx {
      …,
      keep_recent_tokens,
      compactor: &mut self.compactor,
  };
  ```
- Test: `mod tests` in `compact.rs` (helpers `temp_store` `:582`, `fake_model` `:563`, `text_msg` `:602`).

**What to implement:**

```rust
/// The keep-recent budget THIS model's window can afford: the configured
/// `keep_recent_tokens` CAPPED by `window − reserve − headroom`. The catalog
/// budget is catalog-wide and the window is per-model, so an uncapped budget
/// can cover the whole transcript — `older` comes back empty, the compaction
/// is a no-op, and `should_compact()` stays true forever.
///
/// No floor, deliberately: `split_for_compaction` with budget 0 keeps exactly
/// the last message (it breaks before spending anything, then snaps back off a
/// `tool` message), which is the shrinking a tiny window needs. A floor would
/// also override the small budgets the tests use to force a real compaction.
pub fn keep_budget(&self) -> u32 {
    const HEADROOM_CAP: u32 = 4_096;
    let headroom = self.config.reserve_tokens.min(HEADROOM_CAP);
    let affordable = u64::from(self.context_window)
        .saturating_sub(u64::from(self.config.reserve_tokens))
        .saturating_sub(u64::from(headroom));
    u64::from(self.config.keep_recent_tokens).min(affordable) as u32
}
```

Pinned values against `CompactionConfig::default()`: 200 000 → 20 000 (config wins, big models unchanged) · 65 536 → 20 000 · 32 768 → 12 288 · 8 192 → 0 (keeps the last message only, still shrinks).

Do NOT change `split_for_compaction`, `CompactionConfig`, its `Default`, `should_compact()`, or any existing fixture's budget.

**Steps:**
- [ ] Write `keep_budget_caps_the_keep_to_what_the_window_affords` asserting the four values above.
- [ ] Run `cd src-tauri && cargo test keep_budget` — must FAIL to compile with ``no method named `keep_budget` ``. If it compiles, stop and check you added it to the right `impl`.
- [ ] Implement `keep_budget()` and the `loop.rs:1632` call site.
- [ ] Add `keep: Option<u32>` to `Harness` (used by `Harness::run` in place of the hardcoded `1` when `Some`). Write `a_small_window_compaction_actually_shrinks_the_transcript`:
  - `Harness::new(...)`, then `loop_.compactor`-equivalent: `harness.compactor = Compactor::new(CompactionConfig::default(), 32_768);` and `harness.keep = Some(harness.compactor.keep_budget());` (legal — the RHS borrows a different field than the assignment target). Passing `keep = None` would run budget 1 and pass whether or not `keep_budget()` is right, so it pins nothing.
  - Build a transcript whose `estimate_context` falls in the band **`16_384 < estimate < 20_000`** — that band is the whole point: below 16 384 the window is not over threshold, above 20 000 the OLD uncapped budget would still compact it, and only inside the band does the test distinguish "derived budget shrinks it" from "old budget `Skipped`". Assert `estimate_context(&transcript)` is inside the band before running the compaction.
  - Assert the outcome is `CompactionOutcome::Compacted { .. }` (i.e. `older` was non-empty) and that one resulting message satisfies `is_compaction_summary`.
- [ ] Fix `loop.rs:4103` as specified in the design constraints above, and assert the compaction actually ran there.
- [ ] Run `cd src-tauri && cargo test` — ALL green. **Report the test count** and confirm the fixtures named above (`compact.rs:1117`, `:1167`, `:1199`, `:1259`, `loop.rs:3362`, `:4083`, `:4148`) still pass; if any fails, you changed a budget you were told to leave alone.
- [ ] Run `cd src-tauri && cargo clippy --all-targets` — 0 warnings. Then `cargo fmt --check`.
- [ ] Commit: `fix: derive the compaction keep-recent budget from the model's window`

**Acceptance criteria:**
- [ ] `keep_budget()` returns 20 000 / 20 000 / 12 288 / 0 for the four pinned windows.
- [ ] `CompactionCtx.keep_recent_tokens` still exists; production (`loop.rs`) passes the derived budget; tests still pass explicit budgets.
- [ ] A 32k-window transcript over its threshold compacts to FEWER messages (previously `Skipped`).
- [ ] Every pre-existing compaction fixture passes unchanged.

---

### Task 2: The compaction `reason` becomes real, and the renderer gets a state frame

**Context:**
Both emit sites hardcode `reason: "context_limit"` (`loop.rs:1627`, `:1655`) and `will_retry: false`, though `compaction_end` already carries `reason`/`result`/`aborted`/`will_retry`/`error_message` (`events.rs:146-156`). Meanwhile the ONLY thing reaching the renderer is two text one-liners with `messageId: "system"` (`normalize.rs:342-343`) — no STATE for "a compaction is running", which Task 4's indicator needs. Three entry points are arriving (`manual`/`threshold`/`overflow`), so the reason becomes a real field, and the wrapper starts reporting whether the transcript shrank (Task 6 refuses a doomed second request based on it).

**Files:**
- Modify: `src-tauri/src/agent/harness/loop.rs` — the METHOD `run_compaction` (`:1626`): params `reason: &str, will_retry: bool`, returns `bool` ("the transcript shrank"). Task 3 adds ONE more parameter to this same method; Task 6 calls it. No second wrapper method is ever created.
- Modify: `src-tauri/src/agent/normalize.rs:342-343`.
- Test: `normalize.rs`'s `mod normalize_tests` (`:553`, the `bookkeeping_events_and_one_liners` test at `:907`) and `mod compute_display_rows_tests` (`:959`); `loop.rs`'s `mod tests`.

**What to implement:**

1. `normalize` gains a second frame per event, carrying the event's reason:
```rust
RpcEvent::compaction_start { reason } => vec![
    system_chunk("Compacting context…"),
    json!({ "sessionUpdate": "compaction_update", "active": true, "reason": reason }),
],
RpcEvent::compaction_end { reason, .. } => vec![
    system_chunk("Compaction finished"),
    json!({ "sessionUpdate": "compaction_update", "active": false, "reason": reason }),
],
```
   The two one-liner strings stay byte-identical (pinned by `normalize.rs:913`/`:925`, and they are the only durable transcript trace — the summary is a `native_messages` `System` row, never a display row).
   Verified: `compute_display_rows`'s catch-all is `_ => Vec::new()` (`normalize.rs:547`), so the new frame persists no display row and does not touch the thinking-segment state. Pin it anyway (step below) — a future change to that catch-all would make the frame replay as a chat bubble on resume.
2. `run_compaction` signature/return: `async fn run_compaction(&mut self, reason: &str, will_retry: bool, turn: &CancellationToken) -> bool`. Emit `compaction_start { reason: reason.to_string() }`; at the end `compaction_end { reason: reason.to_string(), result: None, aborted, will_retry, error_message }`. Return `true` ONLY for `CompactionOutcome::Compacted { .. }`; `Skipped`/`Failed` → `false`.
3. Update ALL THREE call sites — `loop.rs:718` (threshold) and the two test sites `loop.rs:3087`, `loop.rs:4130` — to pass the two new args. **Do NOT store the returned `bool` anywhere yet:** nothing reads it until Task 6, and an unread local (or an unread assignment) is a warn-by-default lint that CI's `clippy --all-targets -- -D warnings` turns into a failure for this and every later task. The threshold site calls the method as a statement. Clippy does not require `let _ =` for a discarded `bool` — do not add one.
4. Do NOT add `overflow`/`manual` call sites and do NOT change `force_compact` — Tasks 3 and 6 own those.

**Steps:**
- [ ] Extend `bookkeeping_events_and_one_liners` (`normalize.rs:907`): `compaction_start { reason: "manual" }` yields TWO frames — `frames[0]["content"]["text"] == "Compacting context…"` and `frames[1] == json!({"sessionUpdate":"compaction_update","active":true,"reason":"manual"})`; same shape for `compaction_end` with `active: false`.
- [ ] Add `a_compaction_update_frame_persists_no_display_row` to `mod compute_display_rows_tests` (`normalize.rs:959`), reusing the three state fixtures the way `compute_display_rows_matches_the_legacy_persist_update_writes` (`:997`) builds them; assert the returned `Vec` is empty.
- [ ] Run `cd src-tauri && cargo test normalize` — must FAIL (one frame, not two). If it passes, you edited the wrong arm.
- [ ] Implement the arms; re-run to green.
- [ ] Change the `run_compaction` signature + the three call sites; add a `loop.rs` test `a_skipped_compaction_reports_no_shrink` that calls the wrapper directly (the `loop.rs:3087` shape) on a transcript too small to compact and asserts `false`.
- [ ] Run `cd src-tauri && cargo test` — green (this step is the red step for the new signature: it fails to compile until the three call sites are updated).
- [ ] `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check`.
- [ ] Commit: `feat: give compaction a real reason and a compaction_update frame`

**Acceptance criteria:**
- [ ] `compaction_start`/`compaction_end` carry a real `reason`; the threshold path sends `"threshold"`, `will_retry: false`.
- [ ] A `compaction_update { active, reason }` frame is emitted on start AND end and produces no display row.
- [ ] `run_compaction` returns whether the transcript shrank (`Compacted` → `true`; `Skipped`/`Failed` → `false`), and nothing stores that value before Task 6.
- [ ] The two transcript one-liners are unchanged byte for byte.

---

### Task 3: `/compact` reaches the harness — the idle-time control command

**Context:**
`AgentLoop::compact()` (`loop.rs:517-520`) sets `force_compact`, read only INSIDE a turn (`loop.rs:716`), so nothing outside a turn can trigger a compaction and the method has no production caller. The composer is locked during a turn, so a hand-triggered compaction is ALWAYS an idle action — exactly what the idle control channel is for (`ControlCmd::{SetModel, SetThinkingLevel}`, applied in `run()`'s control arm `loop.rs:571-579`). It must also be CANCELLABLE: a summary over a large history is bounded only by the transport's `read_timeout` *between bytes*, and the existing Stop path (Esc → `cancel_session` → `Inbound::Abort`) cancels whatever token is in the shared `turn_cancel` mutex. Decisions: ADR 0044 (a command never reaches the Agent; a stored/non-live session is a no-op).

**Two verified traps:**
- `decode_inbound` (`protocol.rs:321-342`) matches an EXPLICIT `type` allow-list and routes everything else to `Inbound::Unknown`. Without adding `"compact"` there, the feature is a silent no-op over real IPC while a raw-serde unit test still passes.
- `WorkerCore::handle` returns `Vec::new()`; `RpcEvent`s leave via the PUMP (`take_pump()` `core.rs:351`), not the returned/outbound frames. And `stub_handles`' `CannedProvider` (`core.rs:535-550`) returns a COMPLETE stream synchronously, so no cancel window exists in the stub.

**Files:**
- Modify `src-tauri/src/agent/harness/loop.rs` — add `ControlCmd::Compact` (`enum` at `:117-124`); handle it in `run()`'s control arm (`:571-579`); DELETE `pub fn compact()` (`:517-520`) and its doc (no `dead_code` warning will point at it — `AgentLoop` is `pub`-re-exported, so delete it deliberately). Do not change `force_compact`'s type (Task 6 does).
- Modify `src-tauri/src/agent/worker/protocol.rs` — `Inbound::Compact` (enum `:39`) AND `"compact"` in `decode_inbound`'s allow-list (`:321-342`).
- Modify `src-tauri/src/agent/worker/core.rs` — the `Inbound::Compact` arm only (mirror `Inbound::Config` `:394-421`). Do NOT arm any token here (see item 3).
- Modify `src-tauri/src/agent/worker/client.rs` — `send_compact` (mirror `send_abort` `:506`).
- Modify `src-tauri/src/agent/session/mod.rs` — `SessionManager::compact_session` (near `cancel_session` `:1271`).
- Modify `src-tauri/src/commands/sessions.rs` (mirror `cancel_session` `:161-166`) and `src-tauri/src/lib.rs` (register after `cancel_session`, `:257`).
- Modify `src/bin/fake_worker.rs` — it matches `Inbound` with a `_ => {}` catch-all (`:597`), so `Compact` compiles but is silently ignored by the IPC-parity tool. Add a `Compact` arm that prints what it received.
- Test: `protocol.rs` (Inbound round-trip shape at `:666`, `decode_inbound` is `pub` at `:321`, test module at `:373`), `core.rs` (`stub_core`/`stub_handles`/`take_pump`), `loop.rs`.

**What to implement:**

1. ```rust
   /// Compact NOW (the `/compact` Composer command). Applied when IDLE — a
   /// command sent mid-turn queues behind the turn, the same rule as
   /// `SetModel`. `instructions` are the user's extra summary instructions.
   Compact { instructions: Option<String> },
   ```
2. `Inbound::Compact { instructions: Option<String> }` with `#[serde(rename = "compact", rename_all = "camelCase")]`, **plus** `"compact"` added to `decode_inbound`'s `type` match arm so a real IPC line decodes to the variant instead of `Unknown`.
3. `core.rs`'s arm forwards and arms NOTHING:
   ```rust
   Inbound::Compact { instructions } => {
       if let Some(ctl) = &self.loop_control {
           if let Err(e) = ctl.control_tx.send(ControlCmd::Compact { instructions }).await {
               eprintln!("worker: control send failed: {e}");
           }
       }
       Vec::new()
   }
   ```
   Do NOT replace the token in `ctl.turn_cancel` here. `handle` runs on the IPC side and can receive `Compact` while a turn is still in flight (the command then QUEUES, because `run()` only polls the control queue between turns) — arming here would swap out the token that in-flight turn is racing, so a Stop for it would be silently lost. Arm inside `run()`'s arm instead (item 4), which only ever executes at idle.
4. `run()`'s control arm — arm a FRESH turn token, then compact with it:
   ```rust
   Some(ControlCmd::Compact { instructions }) => {
       // Arm a fresh TURN token here (never in `handle`: see item 3). The
       // existing Stop path (`Inbound::Abort`) cancels whatever token is in
       // the shared mutex, so this is what makes an idle compaction
       // cancellable — `summarize` already races `turn.cancelled()`. The
       // cancelled token is left in place: `run()`'s turn-cancel arm
       // re-arms it, and `handle_prompt` arms its own fresh token per
       // prompt, so a cancel cannot leak into the next turn.
       let token = CancellationToken::new();
       *self.turn_cancel.lock().unwrap_or_else(|p| p.into_inner()) = token.clone();
       self.run_compaction("manual", false, instructions, &token).await;
   }
   ```
   Accepted residual race: an `Abort` landing BETWEEN `handle` queueing the command and this arm cancels the previous token and is missed. It is not reachable from the UI (the composer is locked while a turn runs, and the Esc effect is inert when neither `inTurn` nor `compacting` holds), and it self-heals because the compaction still runs.
5. `run_compaction` gains ONE parameter — `instructions: Option<String>` — inserted before `turn`, and passes it through to `compact::CompactionCtx`. There is exactly ONE compaction wrapper; do not create a second method. Update all three existing call sites (`loop.rs:718` threshold → `None`; the two test sites `loop.rs:3087`, `:4130` → `None`).
   `CompactionCtx` gains `instructions: Option<String>` and must set it at ALL THREE construction sites: `compact.rs:1325` (`call_summarize`), `compact.rs:1361` (`Harness::run`), `loop.rs:1632`. In `summarize` (`compact.rs:392`), when `instructions` is `Some(s)` and `!s.trim().is_empty()`, build the system text as the existing literal + a newline + `format!("Additional instructions for this summary: {s}")`. Threshold and overflow pass `None`.
6. `send_compact(&self, instructions: Option<String>) -> Result<(), WorkerError>` → `Inbound::Compact { instructions }`.
7. `SessionManager::compact_session(&self, session_id: &str, instructions: Option<String>) -> Result<bool, SessionError>`: require the `WorkerManager`; look the session up in `live`; NOT live → `Ok(false)` (a stored session is not an error — ADR 0044); live → `handle.send_compact(instructions)` and **propagate the send error** (mirror the "act only when the send SUCCEEDS" precedent at `session/mod.rs:1335-1336`): `Ok(true)` only on `Ok(())`. **Do NOT set `cancel_requested`** — verified that `send_prompt` clears it (`:1198`) and `router.rs:170-189` reads it only while a turn slot is occupied, so an idle compaction must not touch it at all.
8. `#[tauri::command] pub async fn compact_session(state: State<'_, Arc<SessionManager>>, session_id: String, instructions: Option<String>) -> Result<bool, crate::agent::SessionError>` + register in `lib.rs`.

**Steps:**
- [ ] `protocol.rs`: extend the Inbound round-trip test (`:666` shape) with `Inbound::Compact { instructions: Some("keep the tests".into()) }`, asserting BOTH the serde round-trip AND that `decode_inbound` on `{"type":"compact","instructions":"keep the tests"}` returns the `Compact` variant (NOT `Unknown`). This second assertion is the one that catches the allow-list.
- [ ] `loop.rs`: `a_compact_control_command_compacts_when_idle` — build a loop with a transcript, spawn `run()`, send `ControlCmd::Compact { instructions: None }`, and assert `compaction_start { reason: "manual" }` then `compaction_end` arrive on the events channel with no turn in flight.
- [ ] `loop.rs`: `abort_cancels_an_idle_compaction` — use the `ScriptedProvider` whose single script is `None` (it yields `futures_util::future::pending()`, i.e. a genuinely blocking summary call) with a transcript large enough that `older` is non-empty; start the compaction, cancel its token, and assert a `compaction_end` with `aborted: true` arrives and the transcript is unchanged. (Do NOT write this test in `core.rs`: its `CannedProvider` completes instantly and `aborted` is only ever set on `Failed`.)
- [ ] `core.rs`: `inbound_compact_reaches_the_loop` — `stub_core()`; `core.handle(Inbound::from(&env)).await` FIRST (`take_pump()` only returns `Some` after the `Start` frame has built the loop — `core.rs:349-358`); then `let (mut events_rx, _join) = core.take_pump().unwrap();` — that tuple is the loop's EVENT receiver plus its join handle, NOT the pump; the pump is the separate `pump_tx`/`pump_rx` pair the copied snippet at `core.rs:727-740` creates and forwards `events_rx` into. Follow that snippet exactly. Then `core.handle(Inbound::Compact { instructions: None }).await` and collect from the pump receiver, asserting an `RpcEvent::compaction_start { reason: "manual" }` is produced (the stub transcript makes the outcome `Skipped`; both frames still fire). Do NOT assert cancellation behaviour here — the stub's `CannedProvider` completes instantly; that case lives in `loop.rs`.
- [ ] Run `cd src-tauri && cargo test compact` — must FAIL to compile (``no variant named `Compact` ``). If it compiles, you edited the wrong enum.
- [ ] Implement items 1-8; re-run to green.
- [ ] Run `cd src-tauri && cargo test` — green; then `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check`.
- [ ] Commit: `feat: route /compact to an idle-time compaction in the harness`

**Acceptance criteria:**
- [ ] `decode_inbound` decodes `{"type":"compact",…}` to `Inbound::Compact` (pinned).
- [ ] A compact command with no turn running emits `compaction_start { reason: "manual" }` then `compaction_end`.
- [ ] Cancelling the armed turn token mid-summary ends the compaction with `aborted: true` and leaves the transcript unchanged (the arming lives in `run()`'s arm, so this is a `loop.rs` test).
- [ ] `/compact <args>` reaches `summarize` as an extra instruction line; threshold/overflow pass `None`.
- [ ] `compact_session` returns `Ok(false)` for a non-live session, `Ok(true)` only when the frame was sent, and never sets `cancel_requested`.
- [ ] `AgentLoop::compact()` is deleted; `force_compact` remains.

---

### Task 4: The working indicator says "Compacting" with the `pulse` spinner

**Context:**
`WorkingIndicator` (`src/components/chat/ComposerModals.tsx`) renders a `BrailleLoader` in the user's `spinnerStyle` plus the rotating quip — and its outer gate at `:40` renders the row only under `agentState === "blocked" || workingOrInTurn`. An idle compaction is neither, so **the gate itself must widen**, or the new branch never renders. State arrives as Task 2's `compaction_update` frame; deriving it from the `"Compacting context…"` text is rejected (that string is a test-pinned display constant). `pulse` already exists as a variant — this is a variant OVERRIDE. One label ("Compacting") for all three reasons is a product decision.

**Three verified traps:**
- The textarea is NEVER `disabled` (`ComposerRow.tsx:150-166`); `composerLocked` disables `+` and Send only. Seven existing tests pin `disabled === false` on the textarea, and `ChatStream.tsx:196-199` documents the design. Assert the Send button, not the textarea.
- Production sends EVERY frame through `applySessionUpdates` (`App.tsx:56`), whose reducer ENDS with `if (!messagesChanged && !configChanged && !contextChanged) return state;` (`sessions.ts:1295-1300`). A `compaction_update` changes no messages, so without a new `*Changed` sentinel the update is silently discarded.
- The Esc effect's deps are `[inTurn, activeSessionId]` (`ChatStream.tsx:395`) — without adding `compacting`, the listener is never attached at idle and Esc does nothing.

**Files:**
- Modify `src/lib/tauri.ts` — add the variant to `AcpSessionUpdate` (after `context_usage_update`, ~`:177`).
- Modify `src/store/sessions.ts` — `compacting` state + the two store ACTIONS (`applySessionUpdate` `:1206`, `applySessionUpdates` `:1242`) + the sentinel + clears in `handleSessionClosed` (`:1304`) and `markStalled` (`:697`).
- Modify `src/components/chat/ComposerModals.tsx` — the `compacting` prop, the WIDENED GATE (`:40`), and the middle branch.
- Modify `src/components/ChatStream.tsx` — declare `compacting` before `composerLocked` (`:200`), pass the prop (`:1345`), widen `composerLocked`, widen the Esc gate AND its deps (`:386-395`).
- Test: `src/store/sessions.test.ts` and `src/components/ChatStream.test.tsx` (there is NO `WorkingIndicator` test file — `src/components/chat/` holds only `MessageList.gap.test.tsx`).

**What to implement:**

1. `src/lib/tauri.ts`:
```ts
| {
    sessionUpdate: "compaction_update";
    /** True while a compaction runs; false when it ends (any outcome). */
    active: boolean;
    /** "manual" | "threshold" | "overflow" (ADR 0045's vocabulary). */
    reason: string;
  }
```
2. `src/store/sessions.ts`: `compacting: Record<string, string | undefined>` next to `contextUsage` (`:553`), defaulting `{}`. In BOTH actions handle the frame, and in the batch action add the sentinel:
   ```ts
   let compacting = state.compacting;
   let compactingChanged = false;
   // …in the loop:
   if (update.sessionUpdate === "compaction_update") {
     compacting = {
       ...compacting,
       [sessionId]: update.active ? update.reason : undefined,
     };
     compactingChanged = true;
   }
   // …and BOTH the early-return guard (:1295) and the spread (:1296-1300) gain `compacting`:
   if (!messagesChanged && !configChanged && !contextChanged && !compactingChanged) return state;
   ```
   Use `[sessionId]: undefined` (the store's convention for `stalled` `:1352` / `markStalled` `:699`) — not `delete`. The PURE reducer (`:105`) needs NO change: its `default:` branch (`:192`) is what makes an unknown frame harmless, and this frame carries no message content.
   Clears: `handleSessionClosed` (`:1304`, alongside `inTurn: { [id]: false }` `:1349`) and `markStalled` (`:697`) both set `compacting[sessionId] = undefined`. Rationale to write in the comment: a lingering `compacting` pins `composerLocked` (`ChatStream.tsx:200`) on a session that can no longer compact. Do NOT touch `contextUsage` (it deliberately survives a close — pinned by `sessions.test.ts:876`).
3. `ComposerModals.tsx`: add `compacting?: string` to the props and WIDEN THE GATE:
   ```tsx
   {agentState === "blocked" || compacting !== undefined || workingOrInTurn ? (
   ```
   Then the precedence chain inside: `blocked` → the waiting line (unchanged); else `compacting !== undefined` → `<BrailleLoader variant="pulse" speed="normal" fontSize={14} label="Compacting" />` + `<p className="text-ui-sm text-foreground-subtle">Compacting</p>`; else the existing spinner+quip branch. Keep `data-testid="working-indicator"`.
4. `ChatStream.tsx`: declare BEFORE `composerLocked` (`:200`, next to `agentState`/`workingOrInTurn` at `:149-152`, i.e. above the `if (!activeSessionId) return` early return at `:854` — a `const` declared below it is a TDZ error the file already warns about at `:941-947`):
   ```ts
   const compacting = useSessions((s) =>
     s.activeSessionId ? s.compacting[s.activeSessionId] : undefined,
   );
   ```
   (Indexing with `activeSessionId: string | null` directly is TS2538 under `strict`.) Then `composerLocked = workingOrInTurn || agentState === "blocked" || compacting !== undefined;`, pass `compacting` to `WorkingIndicator` (`:1345`), and the Esc effect becomes:
   ```ts
   if ((!inTurn && compacting === undefined) || !activeSessionId) return;
   // … deps:
   }, [inTurn, activeSessionId, compacting]);
   ```
   Do NOT touch `beginTurn`/`turnCompleted`/`inTurn`: an idle compaction emits no `turn_start`/`agent_settled`, so there is no in-flight turn.
5. No autocomplete, no per-reason labels, no change to `useSpinQuip`.
6. Known cosmetic consequence to NOTE in the code comment, not to fix: `ComposerRow.tsx:231-234` closes the picker on Esc WITHOUT stopping propagation, so once the window listener is attached while compacting, Esc both dismisses an open picker and cancels the compaction. That is the pre-existing shape during a turn; fixing it belongs to the composer's key handling, not here.

**Steps:**
- [ ] Store test first in `src/store/sessions.test.ts`: applying the batch `[{sessionId, update:{sessionUpdate:"compaction_update",active:true,reason:"manual"}}]` sets `compacting[s] === "manual"`; `active:false` clears it to `undefined`; `markStalled` clears it; `handleSessionClosed` clears it; and a batch containing ONLY a `compaction_update` still updates state (this is the `compactingChanged` trap). Follow the `context_usage_update` tests' shape (`grep -n context_usage src/store/sessions.test.ts`).
- [ ] Run `pnpm test src/store` — must FAIL (`compacting` not in state). If it passes, you asserted the wrong key.
- [ ] Implement 1-2; re-run `pnpm test src/store` — green.
- [ ] Tests in `ChatStream.test.tsx` (add `compacting: {}` to `seedLiveSession`'s reset list, `:216-230`):
  - while `compacting` is set at idle, `[data-testid="working-indicator"]` EXISTS (this is the widened-gate assertion), and `container.querySelector('[data-testid="working-indicator"] p')?.textContent` is exactly `"Compacting"` (do NOT use `getByText("Compacting")` — the loader's `sr-only` label adds a second match, and the `aria-hidden` frame span contributes braille glyphs to `textContent`, which is why existing assertions use `toContain`, e.g. `ChatStream.test.tsx:549`);
  - the quip is not rendered: `container.querySelectorAll('[data-testid="working-indicator"] p').length === 1`;
  - Send is disabled — `screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")` (pattern: `ChatStream.test.tsx:930-941`). Do NOT assert anything about the textarea's `disabled`;
  - Enter with a draft while compacting does not call `sendPrompt` (pattern `:1063`);
  - `Escape` while compacting calls the cancel path (mirror the existing inTurn/Escape test);
  - precedence: `agentState: "blocked"` + `compacting` set renders "Waiting for your input…", not "Compacting";
  - coalescing: a batch carrying BOTH `active:true` and `active:false` (a `Skipped` compaction's two frames in one rAF batch) leaves `compacting` cleared — pin this as deliberate.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx` — must FAIL (prop does not exist / the row does not render), then implement 3-4 and re-run to green.
- [ ] Run `pnpm test` and `pnpm build` — green / `tsc` clean.
- [ ] Commit: `feat: the working indicator says Compacting with the pulse spinner`

**Acceptance criteria:**
- [ ] `compacting` is per-session store state, set on `active: true`, cleared on `active: false`, on `handleSessionClosed`, and on `markStalled` — and a batch containing only that frame is not dropped by the early return.
- [ ] At idle, a compaction renders the row (`Compacting` + `variant="pulse"`), overriding the user's `spinnerStyle`; the quip is not rendered.
- [ ] Precedence `blocked > compacting > working`.
- [ ] Send is disabled and Esc sends the cancel while compacting; the textarea stays editable (unchanged invariant).
- [ ] `inTurn` semantics untouched.

---

### Task 5: `/compact` — the Composer command grammar and dispatch

**Context:**
ADR 0044: a fourth prefix `/` and a third semantics — act-and-consume. `skills.ts:268` already says it: *"`$`/`@`/`#` are Mentions … `?` is File completion … the three share a picker, not a semantics"*. A leading `/` claims the message (pi's rule) and trailing text becomes args, so **an unmatched `/foo` MUST fall through as prose** — load-bearing, because **File completion** file rows CONSUME their `?` and insert the absolute path verbatim (ADR 0033/0035), so a draft can legitimately begin `/etc/hosts ` today. The command is intercepted BEFORE `expandMentions`, sends nothing, persists no user row, starts no turn.

**Five verified traps:**
- `send()` (`ChatStream.tsx:875` — there is no `handleSend`) runs an auto-resume block at `:884-901` (`if (!isLive) { if (!canResume) return; if (!(await resume())) return; }`). Intercepting AFTER it means a stored session RESUMES — exactly what ADR 0044 rejects — and then `compact_session` reports live, making the non-live branch dead. Intercept BEFORE that block.
- `selectMention` (`ChatStream.tsx:1243-1248`) already produces exactly `/compact ` for `prefix: "/"` via its fall-through, and `setPicker(null)` ends the token. `ComposerRow.tsx:247-259` is the `completionPending` Enter-HOLD gate, NOT the insertion policy — do not touch it.
- `pickerRows` (`ChatStream.tsx:546-735`) terminates in `else: skills.map(...)` (`:694`): without an explicit `/` branch BEFORE that chain, a `/comp` token lists every skill. `ComposerMentions.tsx` needs no change (it is prefix-agnostic).
- Enter is intercepted by the picker whenever `picker && token && filtered.length > 0` (`ComposerRow.tsx:220-224`), so a fully hand-typed `/compact` + Enter SELECTS the row (inserting `/compact `) rather than sending. Accepted and pinned: the user presses Enter again to send (identical to today's `?`/`$` behaviour). Dispatch tests must therefore click Send, not press Enter.
- The `ChatStream.test.tsx` mock is `{ ...actual }` (`:128-208`), so an unmocked `compactSession` hits the real `invoke` and rejects — a test would "pass" for the wrong reason.

**Files:**
- Create `src/lib/composerCommands.ts` + `src/lib/composerCommands.test.ts`.
- Modify `src/lib/skills.ts` — `ComposerPrefix` (`:273`) + `activeMentionToken` (`:301`).
- Modify `src/components/ChatStream.tsx` — the `pickerRows` `/` branch and the `send()` intercept (before `:884`).
- Modify `src/lib/tauri.ts` — the `compactSession` wrapper (next to `sendPrompt`, `:618`) + its arg-key pin in `src/lib/tauri.test.ts`.
- Modify `src/store/sessions.ts` — `addSystemLine(sessionId, text)`.
- Test: `src/lib/skills.test.ts`, `src/components/ChatStream.test.tsx`, `src/lib/tauri.test.ts`.

**What to implement:**

1. `ComposerPrefix = "$" | "@" | "#" | "?" | "/"`.
2. In `activeMentionToken`, after the Mention match and BEFORE the two `?` shapes:
   ```ts
   const c = before.match(/(^|\s)(\/[a-z0-9-]*)$/);
   if (c) {
     return { prefix: "/", remainder: c[2]!.slice(1), start: (c.index ?? 0) + c[1]!.length };
   }
   ```
   Same `(^|\s)` boundary `@`/`#` require; the Mention charset (lowercase + hyphen), so names match EXACTLY. `?/etc/ho` still yields the `?` token (a `?` is not a `(^|\s)` boundary — verified). Accepted consequence of trying `/` first: `"?~/notes /comp"` now yields the `/` token, consistent with the documented last-token-wins rule (`skills.ts:897-911`) — pin it.
3. `src/lib/composerCommands.ts`:
   ```ts
   export interface ComposerCommand { name: string; description: string }
   export const composerCommands: ComposerCommand[] = [
     { name: "compact", description: "Summarize the older context now" },
   ];
   export interface ParsedCommand { name: string; args: string }
   /** A leading `/` claims the message (ADR 0044). `null` = send it as prose. */
   export function parseComposerCommand(text: string): ParsedCommand | null;
   ```
   Trim; must start with `/`; name = the run to the first whitespace minus the `/`; args = the rest, trimmed; EXACT lookup in `composerCommands`; no match → `null`.
4. `tauri.ts`:
   ```ts
   export async function compactSession(
     sessionId: string,
     instructions: string | null,
   ): Promise<boolean> {
     return invoke<boolean>("compact_session", { sessionId, instructions });
   }
   ```
   (Do not carry over `sendPrompt`'s `?? []` normalization.) Add the arg-key pin in `src/lib/tauri.test.ts` (cf. `:30`, `:70`, `:125` — that file is where a typo'd invoke key is caught).
5. `addSystemLine(sessionId, text)` in `sessions.ts`, implemented by DELEGATING to the existing action — `get().applySessionUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId: clientSystemMessageId() })` — where `clientSystemMessageId()` returns a UNIQUE id per call (module-local counter, e.g. `client:${++n}`). Reason: `case "agent_message_chunk"` (`:111-124`) APPENDS to the trailing agent-text with the SAME `messageId` and no separator, so reusing the harness's `"system"` key would weld two local lines into one bubble. Document that in the action's doc comment. `ChatStream` then pulls it the way it pulls every action: `const addSystemLine = useSessions((s) => s.addSystemLine);` next to `addUserMessage` (`:137`).
6. `pickerRows`: the memo switches on the variable `prefix` (`= picker?.prefix ?? "$"`, `ChatStream.tsx:552`), NOT `token.prefix`, and the in-scope search string is **`query`** (`= picker?.query ?? ""`, `:586`) — there is no `remainder` binding in the memo, and the component-scope `activeRemainder` (`:482`) is `""` for any non-`?` prefix, so using it would list every command. Add an EARLY `if (prefix === "/") { … return { rows, matched: rows.length, live: true }; }` BEFORE the `const rows: MentionRow[] = prefix === "#" ? …` chain (`:678-700`) — the shape every arm already returns (every arm returns `{ rows, matched, live }`; `live` is consumed only under `picker?.prefix === "?"`). Building command rows INSIDE that chain instead would route them through the shared `matchedRows` filter (`r.name.toLowerCase().includes(…)`, `:701`), contradicting the case-sensitive `startsWith` rule. Build them from `composerCommands` filtered by `c.name.startsWith(query)`, each a `MentionRow { key: `/${c.name}`; prefix: "/"; name: c.name; description: c.description }` (`ComposerMentions.tsx:13-38`; `description` is required, and the `key` prefix keeps a command from colliding with a skill of the same name). Selection needs NO new code (trap 2) — pin it instead.
7. The intercept, in `send()`, as the FIRST STATEMENT INSIDE the `try` (the `try {` is `:880`, immediately after `sendingRef.current = true;` `:879`), right after `setError(null)` (`:881`) and BEFORE the `if (!isLive)` block (`:884`). Placement matters: the `finally { sendingRef.current = false }` is at `:1008-1010`, so an early `return` placed BEFORE the `try` would leave `sendingRef.current` stuck `true` and silently break every later send at `:878`.
   ```ts
   const command = parseComposerCommand(rawText);
   if (command) {
     setDraft("");
     if (command.name === "compact") {
       const live = await compactSession(activeSessionId, command.args || null);
       if (!live) {
         addSystemLine(activeSessionId, "Nothing to compact — this session is not open.");
       }
     }
     // Staged attachments are deliberately left staged and unsent: a Composer
     // command is not a prompt.
     return;
   }
   ```
   No `addUserMessage`, no `beginTurn`, no `sendPrompt`, no `turnCompleted`. Because it sits before the FileReader/resume blocks, it neither resumes a stored session nor touches staged attachments.
8. Do NOT add `/help`, fuzzy matching, arg autocomplete, or a second command.

**Steps:**
- [ ] Write `src/lib/composerCommands.test.ts`: `"/compact"` → `{name:"compact",args:""}`; `"/compact focus on open tasks"` → args `"focus on open tasks"`; `"/"` → `null`; `"/compct"` → `null`; `"/compactme"` → `null`; `"try /compact now"` → `null`; `"/etc/hosts has two entries"` → `null` (the File-completion-insert fall-through); `"  /compact  keep tests"` → `{name:"compact",args:"keep tests"}`.
- [ ] Run `pnpm test src/lib/composerCommands.test.ts` — must FAIL (module missing). Implement, re-run to green.
- [ ] Grammar tests in `src/lib/skills.test.ts`: `activeMentionToken("/comp", 5)` → `{prefix:"/",remainder:"comp",start:0}`; `"say /comp"` → `start: 4`; `"/foo /comp"` → last token wins; `"?/etc/ho"` → still `prefix: "?"`; `"/COMP"` → `null`; `"?~/notes /comp"` → the `/` token at the trailing span (pin the accepted precedence); `"/etc/hosts"` → `null` (`/` and `.` are outside the charset).
- [ ] Run `pnpm test src/lib/skills.test.ts` — FAIL then implement (steps 1-2) then green.
- [ ] Dispatch tests in `ChatStream.test.tsx` — add `compactSession: vi.fn().mockResolvedValue(true)` to the tauri mock factory (`:128-208`) and use `fireEvent.click(screen.getByRole("button", { name: "Send" }))` (NEVER Enter — trap 4):
   `/compact` calls `compactSession(id, null)`, never `sendPrompt`, adds no `user` message, and clears the draft; `/compact keep the tests` passes `"keep the tests"`; `compactSession` resolving `false` adds exactly one agent-text line with the not-open text and its own unique `messageId`, and sends nothing; `"/etc/hosts has two entries"` calls `sendPrompt` with byte-identical text; selecting the `compact` row inserts `"/compact "` (pin `selectMention`'s fall-through).
- [ ] Run `pnpm test src/components/ChatStream.test.tsx` — FAIL, implement 3-7, green.
- [ ] Run `pnpm test` and `pnpm build` — green / `tsc` clean.
- [ ] Commit: `feat: /compact — the first Composer command`

**Acceptance criteria:**
- [ ] `/` then letters opens the shared picker showing `compact` + description; selecting inserts `/compact ` (no new insertion code).
- [ ] `/compact` and `/compact <args>` are intercepted: no `sendPrompt`, no user row, draft cleared, compaction dispatched, and NO resume of a stored session.
- [ ] `?/etc/ho` still behaves as a **File completion** token, and any unmatched `/foo` sends as byte-identical prose.
- [ ] Args reach `compact_session` as `instructions`.
- [ ] A non-live session gets exactly one system-style line and no command.

---

### Task 6: Context overflow is a provider tier, recovered inside the turn

**Context:**
ADR 0045. A context-length 400 arrives as `ProviderError::Fatal`, `RetryPolicy` returns it verbatim, and `loop.rs:757-763` calls `settle_error` and ENDS the turn — the user must type "continue", the worst possible outcome for the one failure compaction exists to absorb. A fourth tier that the ladder does NOT retry (pi: *"Context overflow errors are NOT retryable (handled by compaction instead)"* — retrying re-sends identical oversized bytes), recovered in place, ONE attempt per overflow episode (reset when a model call succeeds), and NO second request when the compaction could not shrink.

**Four verified traps:**
- HTTP status → `ProviderError` is decided in ONE shared place, `provider/transport.rs` (`map_status`/`map_response`, `:57-92`; the 4xx→`Fatal` arm is `:69-70`). No provider maps a status itself. Classification goes there, before that arm.
- The ONLY producer of MID-STREAM `ProviderError`s is `map_anthropic_error` (`anthropic.rs:84-108`), which maps `invalid_request_error` → `Fatal`. Without touching it, a mid-stream overflow arm is dead code.
- `ProviderEvent::Error` is captured INSIDE the stream-consumption loop (`loop.rs:791-877`) at `:869`; a `continue` THERE re-polls the same dying stream. Intercept where `mid_stream_error` is HANDLED (`:937-943`), so `continue` binds to the turn loop.
- `force_compact` is a `bool`, and the only compaction call site is `loop.rs:716-718`, which Task 2 pins to `("threshold", false)`. A bool therefore cannot produce `reason: "overflow"` / `will_retry: true`. Make the flag carry the trigger.
- There is NO route today that shows a provider error body in the transcript (`settle_error` emits only `turn_end` + `agent_settled`; `auto_retry_end`'s one-liner drops `final_error`; mid-stream bodies are `eprintln!` only). So an "actionable message" needs an explicit emission, not a hunt for an existing route — and `run_compaction` ALREADY emits a `compaction_end`, so a second one would double the transcript line and the state frame.
- With `force_compact + continue`, a `Skipped`/`Failed` compaction falls through to the model call at `loop.rs:735` — the oversized request IS re-sent. The guard must gate the model call, not just the recovery.

**Files:**
- Modify `src-tauri/src/agent/harness/provider/transport.rs` — the classification (`map_status`), + extend its existing status-table test (`:117-146`).
- Create `src-tauri/src/agent/harness/provider/overflow.rs`; Modify `.../provider/mod.rs` (`mod overflow;`).
- Modify `src-tauri/src/agent/harness/provider/types.rs` — the new variant (`enum` at `:254`).
- Modify `src-tauri/src/agent/harness/provider/openai.rs:97` — the `stream_options` latch gate (see step 4).
- Modify `src-tauri/src/agent/harness/provider/anthropic.rs` — `map_anthropic_error` (`:84-108`) so a mid-stream SSE error can classify as overflow.
- Modify `src-tauri/src/agent/harness/retry.rs` — DOC COMMENTS ONLY (`:3`, `:108`); `:139`/`:177-179` already return non-`Retryable` variants verbatim.
- Modify `src-tauri/src/agent/harness/loop.rs` — `force_compact` becomes `Option<CompactionTrigger>`; the loop-top gate + model call (`:716-735`), the pre-stream arm (`:757`), the mid-stream HANDLING site (`:937-943`), and the success reset near `:979`.
- Modify `src-tauri/src/agent/normalize.rs` — surface `compaction_end`'s `error_message` as a system chunk.
- Test: `overflow.rs` (unit), `transport.rs` (`:117-146` table test), `retry.rs` (`:311` shape), `loop.rs`.

**What to implement:**

1. `overflow.rs`:
   ```rust
   /// True when provider error text means "the prompt is over the model's
   /// context window". The EXCLUSIONS run FIRST: a Bedrock throttle says
   /// "too many tokens", and turning a rate limit into a compaction is worse
   /// than missing an overflow.
   pub(crate) fn is_context_overflow_text(text: &str) -> bool
   ```
   Lowercase substring matching (NO regex crate). Overflow fragments: `prompt is too long`, `prompt too long`, `prompt exceeds max length`, `request_too_large`, `exceeds the context window`, `maximum context length`, `context_length_exceeded`, `input token count`+`exceeds the maximum`, `maximum prompt length is`, `reduce the length of the messages`, `maximum context length is`, `exceeds the maximum allowed input length`, `is longer than the model's context length`, `exceeds the limit of`, `exceeds the available context size`, `greater than the context length`, `context window exceeds limit`, `exceeded model token limit`, `model_context_window_exceeded`, `too many tokens`, `token limit exceeded`, `configured context size is`. Non-overflow exclusions, checked FIRST: `rate limit`, `too many requests`, `throttling error:`, `throttlingexception`, `service unavailable:`.
   **Deliberate divergence from pi, and why:** pi's exclusion is the ANCHORED `/^(Throttling error|Service unavailable):/i`, which does NOT match AWS's `ThrottlingException: Too many tokens, please wait before trying again.` — one of pi's own documented examples. Since our fragments include `too many tokens`, that string would classify as overflow and a Bedrock throttle would trigger a pointless compaction. Adding `throttlingexception` to the exclusion list fixes it here; say so in the doc comment so nobody "restores parity".
2. `ProviderError::ContextOverflow(String)` with `#[error("context overflow: {0}")]`. Then `grep -rn "ProviderError::" src-tauri/src` and handle every `match` the compiler surfaces.
3. In `transport.rs::map_status` (`:57-72`), which returns `Option<ProviderError>` as one `if / else if` chain, insert an arm AFTER the 401/403 (`Auth`) and 429/5xx (`Retryable`) arms and BEFORE `else if status.is_client_error()` (the 4xx→`Fatal` arm, `:69-70`), keeping the neighbouring arms' message shape:
   ```rust
   } else if is_context_overflow_text(body) {
       Some(ProviderError::ContextOverflow(format!("status {status}: {body}")))
   ```
   Note the terminal 1xx/3xx arm deliberately never reads the body — do not change that.
3b. In `map_anthropic_error` (`anthropic.rs:84-108`), BEFORE the `kind` match: `if is_context_overflow_text(message) { return ProviderError::ContextOverflow(format!("{kind}: {message}")); }`. Without it nothing can ever produce a mid-stream overflow and the mid-stream arm below is dead code.
4. `openai.rs:97` gates the `stream_options` latch on `!matches!(err, ProviderError::Fatal(_))`. An overflow 4xx is no longer `Fatal`, so a body naming both `stream_options` and overflow wording would trigger a pointless re-issue and permanently lose usage reporting for the session. Widen the exclusion to `!matches!(err, ProviderError::Fatal(_) | ProviderError::ContextOverflow(_))` and pin it.
5. `loop.rs` — replace `force_compact: bool` with a trigger that carries what the event needs:
   ```rust
   /// A compaction the loop must run before its next model call, and what to
   /// report it as (`reason` is a UI contract — ADR 0045; `will_retry` is true
   /// only for overflow recovery).
   pub(crate) struct CompactionTrigger {
       pub reason: &'static str,
       pub will_retry: bool,
   }
   // field: force_compact: Option<CompactionTrigger>
   ```
   In the turn body, next to `message_started`, declare ONLY:
   ```rust
   let mut overflow_recovered = false;
   ```
   (No "last compaction shrank" variable: the value is consumed in the same block below, and an unread local or unread assignment is a CI `clippy -D warnings` failure.)
   Loop-top compaction (`:716-718`, currently `if self.compactor.should_compact() || self.force_compact { self.force_compact = false; self.run_compaction(turn).await; }`) becomes: take the trigger, run the compaction, and when an overflow trigger did NOT shrink the transcript, settle WITHOUT the model call:
   ```rust
   let trigger = self.force_compact.take();
   let due = trigger.is_some() || self.compactor.should_compact();
   if due {
       let t = trigger.unwrap_or(CompactionTrigger { reason: "threshold", will_retry: false });
       let shrank = self.run_compaction(t.reason, t.will_retry, None, turn).await;
       if t.reason == "overflow" && !shrank {
           // No doomed second request: the oversized prompt is exactly what
           // just failed, and a request that cannot succeed costs a round trip.
           // `run_compaction` has already emitted the single `compaction_end`
           // carrying the actionable `error_message` (see item 5b).
           self.settle_error(std::mem::take(&mut turn_tool_results));
           return;
       }
   }
   ```
   Emit NOTHING here — `run_compaction` already emits exactly one `compaction_end`; a second would double the transcript line and the `compaction_update` frame.
5b. `run_compaction` composes the actionable message ITSELF, so the single `compaction_end` carries it. After the outcome match, set `error_message` to:
   - `Some("Context overflow: not enough older context to compact — try a larger-context model.")` when `reason == "overflow"` and the outcome is `Skipped`;
   - `Some(format!("Context overflow: the summary call failed ({e}) — the transcript was left unchanged."))` when `reason == "overflow"` and the outcome is `Failed { error: e }`;
   - otherwise the existing `error_message` unchanged (`None` today).
   `aborted` stays as-is (`true` only on `Failed`, `loop.rs:1651`) — a `Skipped` compaction is not an abort.
   Pre-stream arm, inserted BEFORE `Err(e) =>` (`:757`):
   ```rust
   Err(ProviderError::ContextOverflow(_)) if !overflow_recovered => {
       overflow_recovered = true;
       self.compactor.turn_abandoned(&self.messages);
       self.force_compact = Some(CompactionTrigger { reason: "overflow", will_retry: true });
       continue;
   }
   ```
   Mid-stream: intercept where `mid_stream_error` is HANDLED (`:937-943`), NOT where it is captured (`:869`, inside the stream-consumption loop at `:791-877` — a `continue` there re-polls the same dying stream and the turn still falls through to the settle). Insert BEFORE the existing `if let Some(e) = mid_stream_error { … settle_error … return; }`:
   ```rust
   if let Some(ProviderError::ContextOverflow(_)) = &mid_stream_error {
       if !overflow_recovered {
           overflow_recovered = true;
           self.compactor.turn_abandoned(&self.messages);
           self.force_compact = Some(CompactionTrigger {
               reason: "overflow",
               will_retry: true,
           });
           continue; // binds to the TURN loop from here
       }
   }
   ```
   Verified safe: `turn_tool_results` intentionally survives a loop-back (same as the existing retry loop-back at `:925-928`), `message_started` stays `true` so the retried call reuses the announced `message_start`, and the compaction emits its own `context_usage_update`.
   Reset `overflow_recovered = false;` where the assistant message is pushed (`:975`, next to `note_context()`).
6. `normalize.rs`: the `compaction_end` arm surfaces `error_message`. When it is `Some(m)`, emit the failure line **INSTEAD OF** `"Compaction finished"` (a successful compaction has no `error_message`, so the pinned string still ships on the success path — say so in the comment): `system_chunk(format!("Compaction failed: {m}"))`. Frame order stays `[one-liner, compaction_update]`.
   WHY "instead of" and not "in addition to": both lines are `system_chunk`, i.e. `messageId: "system"` (`normalize.rs:69-76`), and `applySessionUpdate` APPENDS same-`messageId` chunks with NO separator (`sessions.ts:110-124`) — two of them in one batch weld into one bubble reading `Compaction finishedCompaction failed: …`. Task 5 hits the same hazard and solves it with a unique local `messageId`; here the simpler fix is to replace the line.
   SCOPE NOTE (intended, not a bug): ANY `error_message` now reaches the transcript, so an ordinary transient summary failure — `a_failed_summary_does_not_rewrite_the_transcript` (`loop.rs:3068`) — also prints `Compaction failed: …`. That is the first time a provider-side compaction failure is visible to the user at all.
   The frame-level test cannot see the weld, so ALSO assert at the store level: applying the two frames through `applySessionUpdate` yields ONE agent-text message whose text does not contain `"finishedCompaction"`.
7. Do NOT add: a post-turn compaction, pi's "recoverable length stop", or a Settings knob.

**Steps:**
- [ ] `overflow.rs` tests FIRST — every pi example classifies `true` (`"prompt is too long: 213462 tokens > 200000 maximum"`, `"413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"`, `"Your input exceeds the context window of this model"`, `"Requested token count exceeds the model's maximum context length of 131072 tokens"`, `"Input length (265330) exceeds model's maximum context length (262144)."`, `"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"`, `"This model's maximum prompt length is 131072 but the request contains 537812 tokens"`, `"Please reduce the length of the messages or completion"`, `"the request exceeds the available context size, try increasing it"`, `"Prompt exceeds max length"` (z.ai CN), `"{\"code\":\"1261\",\"message\":\"Prompt too long\"}"`, `"model_context_window_exceeded"`, `"prompt token count of 250000 exceeds the limit of 200000"`, `"context window exceeds limit"`); and these are `false`: `"ThrottlingException: Too many tokens, please wait before trying again."`, `"rate limit exceeded"`, `"429 Too Many Requests"`, `"invalid api key"`, `"{\"detail\":\"field required\"}"`.
- [ ] Run `cd src-tauri && cargo test overflow` — FAIL (missing function), implement, green.
- [ ] Add the `transport.rs` cases to its existing status-table test (`:117-146`): a 400 whose body matches → `ContextOverflow`; a 400 whose body does not → `Fatal`; a 401 with matching text → still `Auth`. Do NOT write per-provider HTTP tests — `wiremock` is declared but unused; provider suites drive parsers over canned SSE (`provider/test_util.rs::collect`), and the only HTTP-level precedent is the `TcpListener` stub at `transport.rs:292-347`.
- [ ] Add the tier; fix every compile error it surfaces; add a `retry.rs` test `context_overflow_is_never_retried` mirroring `fatal_is_never_retried` (`retry.rs:311`). Update `retry.rs`'s doc comments (`:3`, `:108`) — its `match` needs no change.
- [ ] Add the `openai.rs` pin that a `ContextOverflow` does NOT trigger the `stream_options` latch.
- [ ] `loop.rs` tests (three, one per entry path):
  - `a_context_overflow_error_compacts_and_retries_the_turn` — scripted provider whose first `complete` returns `Err(ContextOverflow("prompt is too long".into()))` and later calls succeed, transcript large enough that `older` is non-empty; assert NO error settle, a `compaction_start { reason: "overflow", willRetry: true }`, and that the provider was called again.
  - `a_mid_stream_context_overflow_compacts_and_retries_the_turn` — the SAME scenario delivered as a mid-stream `ProviderEvent::Error(ContextOverflow(…))` (the path `map_anthropic_error` produces); assert the compaction runs and the provider is called again. Without this test the mid-stream arm is unpinned.
  - `a_second_overflow_after_a_failed_recovery_gives_up_without_a_second_request` — every call overflows with a transcript too small to compact; assert exactly ONE compaction attempt, exactly ONE `compaction_end` (carrying the actionable `error_message`), the `"Compaction failed: …"` chunk from normalize, and that the provider was called at most once per attempt (no doomed third request).
- [ ] Add the store-level weld assertion described in step 6 (one agent-text message, no `"finishedCompaction"`).
- [ ] Run `cd src-tauri && cargo test` — green; then `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check`.
- [ ] Commit: `feat: recover from context overflow by compacting inside the turn`

**Acceptance criteria:**
- [ ] A context-length 400 compacts and re-issues the same model call in the SAME turn, whether it arrives PRE-STREAM (transport status) or MID-STREAM (an SSE `error` event); `settle_error` is not reached.
- [ ] `compaction_start` carries `reason: "overflow"`, `will_retry: true`.
- [ ] The retry ladder never retries an overflow (pinned), and a non-overflow 4xx is still `Fatal`.
- [ ] At most one compact-and-retry per overflow episode; the guard resets after a successful model call.
- [ ] When the compaction cannot shrink (or fails) the turn settles with the actionable message in the transcript as a SINGLE unwelded line, and NO doomed request is sent.
- [ ] A throttle/rate-limit body is never classified as overflow, and a `ContextOverflow` never trips the `stream_options` latch.

---

### Task 7: `input_tokens` is the whole prompt, cached prefix included

**Context:**
ADR 0046 / ADR 0028's named consequence: `Usage` carries only `input_tokens`/`output_tokens` (`types.rs:207`), and Anthropic's Messages wire reports `input_tokens` as the UNCACHED remainder — the cached prefix lives in `cache_read_input_tokens` / `cache_creation_input_tokens`. So on a cache-heavy endpoint the **Anchor** under-reads and compaction arrives LATE (a 400) instead of early. Deliberate: do NOT widen `Usage` — state the invariant at the parser seam, because on the OpenAI-shaped wires `prompt_tokens` ALREADY includes cached tokens and `…details.cached_tokens` is a SUBSET, so "sum the cache fields for consistency" DOUBLE-COUNTS and makes compaction arrive EARLY.

**Verified trap:** `emit_usage` (`anthropic.rs:354-366`) emits `Usage` only when at least one side is `Some`; storing the sum unconditionally would turn a `message_start` with no/empty `usage` into `Some(0)` and emit a spurious `Usage(0, n)` (breaking the "NO `Usage`" fixture at `anthropic.rs:1056`).

**Files:**
- Modify `src-tauri/src/agent/harness/provider/anthropic.rs` — the `message_start` read (`:222-229`).
- Modify `src-tauri/src/agent/harness/provider/types.rs` — the doc comment on `Usage.input_tokens` (`:207`). No new fields.
- Test only: `src-tauri/src/agent/harness/provider/openai.rs` (`:232-242`), `.../responses.rs` (`response_usage`, `:345`).

**What to implement:**
1. In `anthropic.rs`, on `message_start`, read the three optional counts and store their sum ONLY IF at least one is present — otherwise leave `input_tokens` as `None` (preserving the `emit_usage` guard's contract). Per-field clamp stays `unwrap_or(u32::MAX)`; sum with `saturating_add`. `message_delta`'s `output_tokens` handling is UNCHANGED.
2. `types.rs` doc comment: `input_tokens` IS the whole prompt the model was shown, cached prefix included; the cached subsets are deliberately NOT separate fields because two of three wires report them as a SUBSET of this number and adding them double-counts.
3. The anti-double-count pins for `openai.rs` and `responses.rs`.
4. Do NOT add cache numbers anywhere — not `Usage`, not `usage_value()` (`loop.rs:1858`), not `CostUpdatePayload.cacheReadTokens`/`cacheWriteTokens` in `src/store/interactive.ts` (verified: `cost_update` has NO native emitter — `todos_update` is the only push, `interactive/mod.rs:307`; `drive_subagent` hardcodes `cost: 0.0`; `SubagentDelegatingCard` renders only `cost`). That dormant seam is left for a separate dead-code audit.

**Steps:**
- [ ] Anthropic test first: `message_start` with `{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":25}` + `message_delta` `output_tokens: 7` → `ProviderEvent::Usage(Usage { input_tokens: 175, output_tokens: 7 })`; second case with the cache fields ABSENT → `input_tokens: 100`; third case with NO `usage` on `message_start` **and no `output_tokens` on `message_delta`** → no `Usage` emitted at all (the `emit_usage` guard — with an `output_tokens` present it emits `Usage(0, n)` BY DESIGN, which is not the case under test).
- [ ] Run `cd src-tauri && cargo test anthropic` — the 175 case must FAIL with `100`. Implement, re-run green.
- [ ] Add the two pins: `prompt_tokens: 1000` + `completion_tokens: 5` + `prompt_tokens_details:{cached_tokens:800}` → `Usage { input_tokens: 1000, output_tokens: 5 }` (`openai.rs` — the parser emits `Usage` only when BOTH counts are present, so an `openai.rs` fixture without `completion_tokens` produces NO `Usage` at all); `input_tokens: 1000` + `input_tokens_details:{cached_tokens:800}` → `1000` (`responses.rs` — `response_usage` DOES accept an input-only usage). Run `cargo test openai` / `cargo test responses`: these must PASS IMMEDIATELY — they pin present behaviour against a future "consistency" edit, so a failure means the fixture is wrong, not the parser.
- [ ] Update the `types.rs` doc comment.
- [ ] Run `cd src-tauri && cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`.
- [ ] Commit: `fix: count the cached prefix in provider-reported input_tokens`

**Acceptance criteria:**
- [ ] An Anthropic response with cache fields anchors the FULL prompt (175 in the pinned case), so the bar and `should_compact()` see the cached prefix.
- [ ] A `message_start` with no usage still emits NO `Usage`.
- [ ] `Usage` is still two fields; `record_usage` and the anchor formula are untouched.
- [ ] Both OpenAI-shaped wires pass their counts through unchanged when a cached-tokens detail is present (pinned).
- [ ] No cache number is added to the display/cost path.

---

## Out of scope (deliberate — do not "improve" these in)

- pi's **recoverable length stop** (`finish_reason: length` + zero output + input filling the window — Xiaomi MiMo). Not detected today, not here.
- Any **Settings surface** for `CompactionConfig` (still the catalog `16384` / `20000`).
- Feeding or deleting the dormant `CostUpdatePayload.cacheReadTokens` / `cacheWriteTokens` seam.
- A second Composer command, `/help`, fuzzy command matching, or a command palette.
- A post-turn (`agent_end`) compaction check: ours runs at the top of the next turn — the same moment for the user, and it keeps every compaction inside the loop that owns the forced trigger.
- Making a hand-typed `/compact` send on the first Enter: the picker intercepts Enter whenever it has a matching row, exactly as it does for `?`/`$`. Pinned, not fixed.
