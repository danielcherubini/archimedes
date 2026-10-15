---
status: accepted
date: 2026-10-15
superseded-by:
---

# The `System`-message fold belongs to the wire, not to the transcript

Every wire sends **at most one leading system message**, and it gets there at
request-build time. `ModelRequest::system_text()` (`provider/types.rs`) is the single
definition of the fold — each `System` message's text (`Text` verbatim, `Blocks` → that
block array's `Text` texts, an `Image` block dropped), the messages joined with `"\n\n"`
in transcript order. Anthropic puts the result in the top-level `system` field and
Responses in `instructions`, both keeping `System` out of `messages` / `input` (already
true before this); chat-completions, which has no such field, emits it as ONE `system`
message at index 0 and nothing else in transcript order. The transcript itself keeps
whatever shape the harness produced, including a `System` message at index 1.

**Why:** a compacted session died on its SECOND model call against any strict
ChatML-family server (the failure was reported from vLLM as
`template refused the request: Unable to generate parser for this template … Jinja
Exception: System message must be at the beginning.`). The cause was ours:
`compact::run_compaction` re-prepends the preserved leading system prompt and puts the
compaction summary immediately after it, and that summary is a `System` message — on
purpose, because it is CONVERSATION state rather than prompt state, so the next compaction
can fold it into the next summary (`compact.rs`, which credits pi's split: "System messages
are prompt state, not conversation"). So the transcript legitimately holds
`[system, system, user, …]`. Templates in the ChatML family assert that a `system` message
appears only at index 0, and vLLM does not merely compile the template: it **executes** it
to auto-generate the response parser, so the assertion fires before the model runs and
surfaces as a 400 that names the TEMPLATE rather than the messages — which is exactly why
this reads like a server bug and is not one.

## Considered Options

- **Re-order / re-label the transcript at write time so only `messages[0]` is ever `System` (rejected).** The advice floating around for this error, and it does silence the template. Rejected because it edits the durable record to satisfy one server family: the summary has to stay distinguishable from a real system prompt (which is why `is_compaction_summary` keys on the harness-generated `SUMMARY_PREFIX` text and not on the role) and foldable by the next compaction; seq order IS the replay order for a resume; and the rewrite would have to run on every compaction, every resume, and every already-stored session.
- **Send the summary as a `user` message instead (rejected).** Fits on the wire and keeps the position, but it makes the model an author of its own history — the summary would arrive as something the user said — and it forks the harness's notion of what a summary is from what the model is shown.
- **Patch the server template (rejected).** Our own template fix is possible on a vLLM we run, impossible on the user's llama.cpp / Ollama / SGLang / hosted endpoint. The client cannot require a permissive template.
- **Normalize in `AgentLoop::model_request` instead of per-provider (rejected).** One seam fewer, but the invariant is a wire fact: the Anthropic and Responses wires need the fold in a DIFFERENT place (a top-level field, with `System` excluded from the array), so a loop-level rewrite would still leave each provider deciding what to do with it. Shaping stays where the wire vocabulary lives, which is the same placement ADR 0046 chose for the cache-inclusive `input_tokens` reconciliation.

## Consequences

- **Already-broken sessions heal on the next request.** Nothing is stored differently, so there is no migration and no "fix only applies to new sessions" caveat — including a resumed session whose stored transcript is the pre-fix `[system, system, …]`.
- **`System`-at-index-1 is now a documented legal transcript shape**, not a leak. The next reader of `compact.rs` should not "tidy" the summary into index 0; `run_compaction` deliberately keeps prompt state and summary apart (a summary at index 0 is explicitly NOT treated as the leading system prompt, so it stays foldable).
- **The fold also absorbs a broken contract elsewhere.** `AgentLoop::prepend_system` documents "call AT MOST ONCE per session" because a second call stacks a second `System` at index 0; if that ever happens, the wire still sends one system message. The contract stays — the fold is a floor, not a licence.
- **Every future wire must fold, and a wire that forwards `messages` verbatim is a bug.** That is the one-line rule for a fourth `WireApi` (ADR 0024); `request_body`'s test — three `System` messages anywhere in the input, one leading `system` on the output, no `system` after index 0 — is the template for that test.
- **An `Image` block inside a `System` message is dropped on all three wires**, since the fold is text. Unreachable today (`prepend_system` builds the system prompt as `MessageContent::Text`, the summary is `Text` by construction), so no compatibility code was written for it.
- **Token accounting is untouched.** The `Compactor` estimates over `self.messages`, which still carries the unfolded transcript; the fold merges text that was already counted, so the drift is the join separators — noise against ADR 0028's snapshot model, and not worth a re-estimate on the wire's behalf.
