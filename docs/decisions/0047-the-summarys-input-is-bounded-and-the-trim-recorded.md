---
status: accepted
date: 2026-10-14
superseded-by:
---

# The summary's input is bounded by the window, and the trim is recorded

`summarize` handed EVERY older message to the same model that had just refused the full prompt, so when the older history alone exceeded the window — routine after a switch to a smaller-window model — the summary request overflowed too, compaction reported `Failed`, and the turn ended with "not enough older context to compact". We decided to give the summary its own budget: an output cap (`⌊0.8 × reserve_tokens⌋`, clamped to 8 192, passed as `max_tokens`) and a window-relative input budget (`context_window − output cap − min(reserve_tokens, 4096)`), keeping only the NEWEST slice of the older set that fits. Compaction recovers the turn in one round trip and can no longer overflow on its own input.

The part that gets dropped is the oldest, and compaction destroys that text either way — so the loss is recorded rather than hidden: a harness-written count goes into the stored summary row (the model is told at generation time too, so it does not present a partial summary as complete), because the summary row is the only thing future turns read and a model's own count of what it never saw is not a fact.

## Considered Options

- **Map-reduce summarization** (chunk the older set, summarize each, fold the digests): better recall on huge histories, but several model calls inside one compaction, messier cancellation, and it would dilute ADR 0045's one-compact-and-retry-per-episode contract into one episode with N+1 calls. Rejected for cost and latency on a path that is trying to *save* a turn; it stays available later if trimmed detail proves it mattered.
- **Output cap only**: does not remove the ceiling, so rejected.

## Consequences

- A model whose window is smaller than `reserve_tokens` has no affordable summary input at all. Such a compaction stays `Skipped` with the actionable message — it is NOT forced, because a summary request that cannot fit would just cost a round trip. This is a real remaining limit, stated rather than papered over.
- The trim boundary may not start on a `tool` result: its `assistant.tool_calls` may have been trimmed, and an orphaned tool result is a request some providers reject. Those messages join the trimmed count.
- The 8 192 clamp stands in for a per-model maximum-output we do not model — `Model` carries `context_window` but no `max_tokens`.
- One summary call per compaction is unchanged, so ADR 0045 is untouched.
