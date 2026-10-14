---
status: accepted
date: 2026-10-14
superseded-by:
---

# An abandoned reply is retracted by protocol, not by rendering

A retried assistant call reuses the `messageId` its first attempt announced — `message_started` stays true so exactly ONE `message_start` is emitted — and the renderer APPENDS same-`messageId` chunks with no separator. So when an attempt streamed text and then failed, the retry's text welded onto it: a first attempt of `parti` plus a retry of `recovered` persisted as `partirecovered`, while the model's own history correctly held only `recovered`. We decided to make the abandonment an explicit frame — `message_retracted`, emitted by EVERY retry path before its loop-back — which clears the abandoned attempt's accumulated text and thought for that `messageId` in all three places that must agree: the harness accumulator, the persisted display row, and the live store. The retry then streams into the same, now-cleared id, so the one-`message_start` invariant survives.

## Consequences

- A `messageId`'s displayed text can now be ERASED after it was shown. Anything that renders or re-hydrates transcript text must handle that, and empty `agent-text` / `agent-thought` rows are skipped on load so an erase leaves no empty bubble.
- A retraction stays SILENT when nothing streamed for that id — the common pre-stream retry emits no frame and no line, exactly as before. Only a real discard says so, with a short line ("Discarded an incomplete reply") carrying a UNIQUE `messageId`, because the shared `"system"` key would weld two of them into one bubble.
- **Any third retry path must emit the retraction too.** That is the reason for a protocol event rather than an overflow-branch patch: the retryable-retry path had the same defect, and fixing only one of the two would leave them disagreeing about what a retried message looks like.
- An abandoned attempt's thinking is erased with its text. It does not weld (the intervening update already closes the thought segment), but it would otherwise linger as thinking the model never kept.
- **A fourth consumer is the subagent capture.** `SubagentCapture::observe_sink_frame` accumulates a child's `agent_message_chunk` text per `messageId`, and `captured_text()` becomes the PARENT's `subagent` tool result — the one place a welded reply is fed to a MODEL rather than read by a human. It removes the retracted id's text, and clears `last_message_id` when it named that id. Because the discard line is itself an `agent_message_chunk`, which ids are bookkeeping rather than model output is decided in ONE place (`normalize::is_bookkeeping_message_id`: `"system"` and `retract:N`), so a discard line can never be handed to a parent model as its child's answer.
- **An Abandoned attempt's tool calls are CLOSED, not retracted.** A `ToolCall` announces a card at `in_progress` and the abandoned attempt never dispatches it, so it would spin forever in the live transcript and the persisted row. Tool rows are keyed by `toolCallId`, not `messageId`, so the retraction frame cannot reach them; instead each gets a synthetic `tool_execution_end` (`is_error: true`, a result that says the call was discarded, not that it failed) — the vocabulary the cancel path already uses for a call that never ran. Firing a retraction for a tool-only attempt instead would have emitted an erase that erased nothing, which the silence rule above forbids.

## Considered Options

- **A fresh `messageId` per attempt**: no new frame, but it strands an orphan truncated bubble in the transcript and deliberately breaks a pinned invariant.
- **Replace the row at `message_end`**: self-heals storage only; the weld is still visible while streaming, which is the part the user reads.
