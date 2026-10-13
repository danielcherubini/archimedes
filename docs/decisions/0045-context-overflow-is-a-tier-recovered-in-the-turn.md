---
status: accepted
date: 2026-10-13
superseded-by:
---

# Context overflow is its own provider tier, recovered IN the turn — and it is deliberately NOT retryable

A provider that refuses a request for being over the context window now surfaces as
`ProviderError::ContextOverflow`, which the **Agent harness** handles where it happens: retract
the dead attempt, run a forced compaction, and re-issue the SAME model call inside the SAME
turn. The turn does not end, so the user types nothing. Compaction is reported with
`reason: "overflow"` and `will_retry: true`, joining the vocabulary pi already uses —
`manual | threshold | overflow`.

**Why:** a 400 is not one of the three existing tiers, so it arrived as `Fatal`,
`RetryPolicy` returned it verbatim, and the loop settled the turn (`loop.rs:758`) — leaving the
user staring at a dead transcript that they had to nudge with a fresh "continue". That is the
symptom, and it is the worst possible one for the one failure a harness is supposed to absorb
silently. pi's rule is the one that matters here — *"Context overflow errors are NOT retryable
(handled by compaction instead)"* — because retrying an oversized request re-sends the identical
oversized bytes: the retry ladder cannot help, and if it also claims the error the two
mechanisms fight over the turn.

**Considered Options**

- **String-match the `Fatal` at the decision site (rejected)** — three wires would have to
  agree on one prose-matching call, the `RetryPolicy` would still classify it as retryable or
  fatal by status code, and every future error path has to remember the match. A tier makes the
  classification structural.
- **End the turn and prompt the user to compact (rejected)** — pi had to do something like this
  because its driver loop lives OUTSIDE the agent (`while (await this._handlePostAgentRun())
  await this.agent.continue()`). Our threshold already sits at the top of the turn's inner loop,
  so a compaction continues by construction and a user prompt would be pure ceremony.
- **Let the retry ladder retry it (rejected)** — the request bytes do not change between
  attempts, so every attempt fails identically, with backoff in between.
- **One compact-and-retry per TURN (rejected in favour of per-episode)** — the guard resets when
  a model call SUCCEEDS (pi resets on `stopReason !== "error"`), because a 60-call turn can
  cross the window more than once legitimately; a per-turn guard would kill the second
  recovery, which is the one that would have been needed.

**Consequences**

- **`force_compact` finally has a caller.** `AgentLoop::compact()` and its flag existed with no
  production caller — they were built for exactly this and reached only by tests. Idle-triggered
  compaction goes through the control channel instead, so the two seams have clean ownership:
  `ControlCmd::Compact` when idle, `force_compact` mid-turn.
- **No doomed second call.** `run_compaction` reports whether the transcript actually shrank,
  and overflow settles immediately when it did not — `Skipped` means the kept tail alone is over
  the window, `Failed` means the summary call failed. Both produce an actionable message instead
  of a provider string, and neither spends a request that cannot succeed.
- **Detection is a ported pattern table, including its exclusions.** pi's
  `NON_OVERFLOW_PATTERNS` exist because a Bedrock throttle says *"too many tokens"*; shipping
  the matchers without them converts a rate limit into a spurious compaction. Message-matching a
  400 is already accepted practice in this harness — the `stream_options` latch
  (`openai.rs:59-66`) does the same thing with the same false-positive cost.
- **Some endpoints never error, and that half is fixed by ADR 0046, not here.** z.ai sometimes
  accepts an over-window prompt silently; pi catches it via `usage.input + cacheRead > window`.
  Once `input_tokens` is cache-inclusive, our own threshold already covers it — which is why no
  separate silent-overflow check is added.
- **`reason` is now a real contract**, not the hardcoded `"context_limit"` it was, and the
  renderer keys a visible state off it (ADR 0044's spec: the `compaction_update` frame). A new
  compaction entry point must pick a reason or the indicator lies.
