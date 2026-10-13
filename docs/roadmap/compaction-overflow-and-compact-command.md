---
status: approved
done-when: "Typing `/compact` at idle compacts the session immediately and the composer shows `Compacting` with the `pulse` spinner; a provider context-overflow 400 compacts and retries the SAME turn with no user action and no error line; a 32k-window model's compaction actually shrinks the transcript; and an Anthropic session's context bar counts its cached prefix."
---

# Compaction you can trigger, compaction that recovers, and a "Compacting" you can see

## Problem

Four defects, one shared root: compaction is the harness's only defence against a full
context, and today it can only be reached by a threshold that fires late, it cannot be
reached by hand, it cannot recover from the error it exists to prevent, and the user
cannot see it happening.

1. **No manual trigger.** `AgentLoop::compact()` (`loop.rs:518`) sets `force_compact`, which
   is read *inside* a turn at the top of the inner loop (`loop.rs:716`). Nothing outside a
   turn can reach it, so it has **no production caller** — only tests.
2. **No overflow recovery.** A context-length 400 maps to `ProviderError::Fatal`, which
   `RetryPolicy` returns verbatim, so `loop.rs:758` calls `settle_error` and ends the turn.
   The user must type "continue" to retry — the exact situation compaction exists to avoid.
3. **A compaction can be a no-op.** `CompactionConfig` is ONE catalog-level value
   (`reserve_tokens: 16384`, `keep_recent_tokens: 20000`) applied to every model, while
   `context_window` is per-`Model`. When the 20k keep budget covers the whole transcript,
   `split_for_compaction` returns an empty `older` → `CompactionOutcome::Skipped` → nothing
   shrinks, while `should_compact()` stays true. Any window under ~36k is degenerate.
4. **Compaction is invisible as state.** `compaction_start`/`compaction_end` normalize to two
   text one-liners with `messageId: "system"` (`normalize.rs:342-343`). No state reaches the
   renderer, so the working indicator cannot know it is compacting — and it renders only when
   `agentState === "blocked" || workingOrInTurn` (`ComposerModals.tsx:40`), which an idle
   compaction is neither.

Also fixed here: `reason` is hardcoded `"context_limit"` at both emit sites
(`loop.rs:1628`, `1658`) and `will_retry` is always `false`, although `compaction_end` already
carries `reason`/`result`/`aborted`/`will_retry`/`error_message` (`events.rs:146-156`).

Reference implementation studied: pi (`pi-mono` at HEAD) —
`packages/coding-agent/src/core/agent-session.ts` (`reason: "manual" | "threshold" |
"overflow"`, `_checkCompaction`, `_runAutoCompaction`, `_overflowRecoveryAttempted`,
*"Context overflow errors are NOT retryable (handled by compaction instead)"*) and
`packages/ai/src/utils/overflow.ts` (the provider pattern table). pi needs a caller-side
`while (await this._handlePostAgentRun()) await this.agent.continue()` loop to continue after
a compaction; **we do not** — our check sits at the top of the turn's inner loop, so a
compaction continues by construction. That is why fix #2 is the whole answer to "don't make
me say continue".

## 1. Composer command — the third composer semantics

A **Composer command** is a `/name` token the **Client** intercepts on send that **never
reaches the Agent**. `src/lib/skills.ts:268` already documents the composer as *"a picker
shared by prefixes that do not share semantics"*; this adds a fourth prefix and a third
semantics: expand (`$ @ #`), insert-path (`?`), **act-and-consume** (`/`).

- `ComposerPrefix` gains `"/"`.
- `activeMentionToken` gains one shape: `/(^|\s)(\/[a-z0-9-]*)$/` — the `(^|\s)` left
  boundary the `@`/`#` shapes already require, and the Mention charset, so a command name
  matches **exactly** (the same exact-match property ADR 0031's tag-safety rests on).
  `?/etc/hosts` is unaffected: a `?` token claims the leading `?` first.
- `ComposerMentions.tsx` renders command rows for the active prefix. Selecting one inserts
  `/compact ` **with the trailing space** — the same load-bearing space File completion adds
  to END a token (ADR 0033), so the next keystroke is args, not a longer token.
- Dispatch in `ChatStream.handleSend`, BEFORE `expandMentions` and before
  `addUserMessage`/`beginTurn`/`sendPrompt`: if the draft starts with `/`, the name runs to
  the first space and the rest is **args**. Exact match in a small table
  (`src/lib/composerCommands.ts`, one entry today) → run it, clear the draft, send nothing.
- **Unmatched → fall through byte-identically as prose.** Not cosmetic: File completion
  CONSUMES its `?` and inserts the absolute path verbatim (ADR 0033/0035), so a draft can
  legitimately begin `/etc/hosts ` or `/home/…/notes.md ` today. Pin it with a test whose
  fixture is exactly that insert at position 0. `/compactme` is prose, not a near-miss.
- A command persists no user row and sends nothing, so there is no `mergeDedupeKey` to
  match. That is a stated, bounded exception to ADR 0031's "live bubble = stored row = model
  input" contract, which governs text that IS sent.
- `/compact <text>` passes `<text>` as extra summary instructions (pi's
  `compact(customInstructions?)`): one field on `CompactionCtx`, appended as one line to the
  `summarize` system prompt (`compact.rs:392`, which is hardcoded today). Threshold and
  overflow pass `None`.
- A **stored (non-live) session** answers `/compact` with a system one-liner and does nothing:
  resuming a session in order to compact it is a bigger flow than the command is worth, and
  the resume's own `reestimate` is what tells you whether compaction is needed.
- A command is only ever typed at idle, because the composer is locked during a turn. So the
  manual path is exclusively `ControlCmd::Compact` and `force_compact` belongs to overflow
  alone.

## 2. The manual path

`compact_session(session_id)` Tauri command (`commands/sessions.rs`) → `SessionManager` →
`Inbound::Compact` (`worker/protocol.rs`) → `WorkerCore::handle` → `control_tx` →
`ControlCmd::Compact` (`harness/loop.rs:119`), applied in `run()` **when idle**, exactly like
`SetModel`/`SetThinkingLevel`, then `run_compaction(reason = "manual")`.

## 3. The event contract, and the indicator

- `reason` becomes `"manual" | "threshold" | "overflow"`; `will_retry` true for
  overflow-with-retry. No shape change — the fields exist.
- New **`sessionUpdate: "compaction_update" { active, reason }`**, the third session-scoped
  bookkeeping frame beside `config_option_update` and `context_usage_update`. `useSessions`
  gains `compacting: Record<string, CompactionReason | undefined>` next to `contextUsage`.
  Cleared by `compaction_end` **whatever the outcome**, by session close, and defensively when
  a session goes **stalled** (a Worker dying mid-summary must not pin the indicator).
  Deriving it from the `"Compacting context…"` chunk is rejected: that string is a test-pinned
  display constant.
- `WorkingIndicator` gains a `compacting` prop. Precedence `blocked > compacting > working` —
  a threshold compaction happens INSIDE a turn and the point is to say what is happening now.
  While compacting: `<BrailleLoader variant="pulse">` — overriding the settings'
  `spinnerStyle` — and the literal **"Compacting"** replacing the rotating quip
  (`useSpinQuip` keeps running; its value is simply not rendered). One label for all three
  reasons.
- Gates this forces: `composerLocked` gains `|| compacting` (`ChatStream.tsx:200`) and the
  Esc-to-cancel effect's gate (`ChatStream.tsx:386`) becomes `inTurn || compacting`.
  Cancellability is not a nicety: a summary over a large history is bounded only by the
  transport's `read_timeout` *between bytes*, and pi offers the same escape.
- An idle compaction runs under a **turn token armed by `run()` for its duration**, so Esc →
  `cancel_session` → `Abort` → the turn token fires (all `Abort` does —
  `abort_cancels_the_turn_token_only`) → `summarize`'s existing `select!` on
  `turn.cancelled()` returns `Err` → `Failed` → **transcript unchanged** →
  `compaction_end { aborted: true }`. No new cancel plumbing; "a failed compaction is never a
  lost context" is what makes cancelling safe. `inTurn` stays false (no `turn_start` /
  `agent_settled`), so no `pending_turn` resolver exists to settle.
- The two transcript one-liners stay verbatim: the summary is a `System` message in
  `native_messages` and NEVER a display row, so that pair is the only durable trace that
  history was rewritten.

## 4. Overflow recovery

- New tier `ProviderError::ContextOverflow(String)` (`provider/types.rs:254`). `RetryPolicy`
  returns it verbatim as it already returns `Fatal`/`Auth` — pi's rule that *"context overflow
  is handled by compaction, not retry"* is what stops the two mechanisms fighting.
- New `provider/overflow.rs`: pi's `OVERFLOW_PATTERNS` **and** its `NON_OVERFLOW_PATTERNS`
  exclusions (a Bedrock throttle says *"too many tokens"*), including the z.ai shapes now
  upstream — `prompt too long`, `prompt exceeds max length` (CN, code 1261),
  `model_context_window_exceeded`. Each wire's error mapping calls it where it already embeds
  the body verbatim. Matching a 400's message is established practice here — the
  `stream_options` latch (`openai.rs:59-66`) does it with the same false-positive analysis.
- Recovery at `loop.rs:758`, and the same arm for a mid-stream
  `ProviderEvent::Error(ContextOverflow)` (some proxies fail only inside the SSE body):

  ```rust
  Err(ProviderError::ContextOverflow(_)) if !overflow_recovered => {
      overflow_recovered = true;
      self.compactor.turn_abandoned(&self.messages); // exists: retract the dead attempt
      self.force_compact = true;                     // exists, finally has its caller
      continue; // → top of loop → run_compaction("overflow", will_retry: true) → model call
  }
  ```

  The threshold check learns nothing about overflow.
- The one-shot guard **resets when a model call succeeds** (our equivalent of pi's reset on
  `stopReason !== "error"`), because a long turn can overflow legitimately more than once.
- **No doomed second call.** `run_compaction` (the `loop.rs` wrapper) returns whether the
  transcript actually shrank; the overflow branch settles immediately when it did not, with an
  actionable message instead of a provider string:
  - `Skipped` → "Context overflow: not enough older context to compact — try a
    larger-context model."
  - `Failed` → names both the summary failure and the overflow.

## 5. The keep budget, derived from the window

`keep = clamp(window − reserve − headroom, FLOOR, config.keep_recent_tokens)` with
`headroom = min(reserve, 4096)` and a non-zero `FLOOR`; one pure fn on `Compactor`
(`keep_budget()`), read by `run_compaction` in place of `ctx.keep_recent_tokens`.
`split_for_compaction` is already a pure function of the budget, so nothing else moves.

| window | threshold | keep today | keep derived |
|---|---|---|---|
| 200k | 183,616 | 20,000 | 20,000 (config still wins — big models unchanged) |
| 64k | 47,616 | 20,000 | 20,000 |
| 32k | 15,616 | 20,000 → no-op | ~12k → shrinks |
| 8k | 0 (saturating) | 20,000 → no-op | FLOOR → shrinks |

## 6. The cache-inclusive anchor

`Usage` stays TWO fields. The invariant is stated and enforced at the parser seam instead:

> **`Usage.input_tokens` IS the whole prompt the model was shown, cached prefix included.**

- **Anthropic** (`anthropic.rs:226`): the wire splits one prompt into `input_tokens`
  (uncached remainder), `cache_read_input_tokens`, `cache_creation_input_tokens` — the parser
  SUMS all three. This is ADR 0028's own named consequence: today the cached prefix is
  invisible, the anchor under-reads, and compaction arrives **late, as a 400**.
- **OpenAI-completions** (`openai.rs:236`) and **Responses**: `prompt_tokens`/`input_tokens`
  already include cached tokens and `…details.cached_tokens` is a SUBSET — unchanged, each
  **pinned by a test that a `cached_tokens` field changes nothing**, because the "consistency"
  edit there double-counts and makes compaction arrive **early**.
- Consequence: `record_usage`, the anchor formula and the `Compactor` do not change at all and
  stay wire-blind.
- This RETIRES pi's silent-overflow case rather than implementing it: once `input_tokens` is
  whole, `should_compact()` already catches a reply that crossed the window. Where we differ
  from pi on purpose: pi compacts at `agent_end`, we compact at the top of the next turn — the
  same moment for the user (still before anything oversized is sent) and it keeps every
  compaction inside the loop that owns `force_compact`.

## Non-goals

- pi's **recoverable length stop** (a provider that truncates input and returns `length` with
  zero output — Xiaomi MiMo): not detected today, not detected here.
- **No Settings surface** for `CompactionConfig` (still catalog defaults).
- The dormant `CostUpdatePayload.cacheReadTokens` / `cacheWriteTokens` seam is **left alone and
  named**, not fed: `cost_update` has NO native emitter (only `todos_update` is pushed —
  `interactive/mod.rs:307`), `drive_subagent` hardcodes `cost: 0.0`, and
  `SubagentDelegatingCard` renders only `cost`. Feeding it is plumbing that arrives nowhere;
  deleting the ACP-era remnants is a separate dead-code audit that touches the card's fallback
  chain, which is not compaction.
- No `/help`, no command autocomplete beyond the shared picker, no second command.

## Verification

Frontend (`pnpm test`, `pnpm build`) and Rust (`cargo test`,
`cargo clippy --all-targets` at 0 warnings, `cargo fmt --check`) per `AGENTS.md`.

- Rust: `overflow.rs` pattern table incl. the NON-overflow exclusions and the z.ai shapes;
  the recover-in-place path asserting the turn continues and `settle_error` is NOT reached;
  the one-shot guard and its reset on success; `run_compaction` shrinking-vs-not outcomes;
  `keep_budget()` against the table above; the Anthropic three-part sum and both
  double-count pins; `ControlCmd::Compact` applied when idle and cancellable by `Abort`.
- Frontend: `/compact` dispatch (nothing sent, no user row, draft cleared); the
  **File-completion-insert fall-through pin** (`/etc/hosts …` at position 0 sends as prose);
  args forwarded; `compaction_update` sets and clears `compacting` (including on
  abort/fail/stall); indicator precedence `blocked > compacting > working` with `variant="pulse"`
  and the literal "Compacting"; composer locked and Esc cancelling while compacting.

## Captured alongside this spec

- ADR 0044 — the Composer-command grammar (four prefixes, three semantics).
- ADR 0045 — context overflow is a provider tier, recovered in-turn and never retried.
- ADR 0046 — `input_tokens` is cache-inclusive at the parser seam (extends ADR 0028's
  named consequence; does not supersede it).
- `CONTEXT.md` — **Composer command**, **compaction reason**; **Anchor** gains "cached prefix
  included".
