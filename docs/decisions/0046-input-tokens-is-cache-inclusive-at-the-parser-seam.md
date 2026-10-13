---
status: accepted
date: 2026-10-13
superseded-by:
---

# `Usage.input_tokens` is the WHOLE prompt, cached prefix included — the fix lives at the parser seam, not in the anchor

Each **Provider** parser must report `input_tokens` as the entire prompt the model was shown,
**including any cached prefix**. On the Anthropic Messages wire that means SUMMING
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; on the
OpenAI-completions and Responses wires it means changing NOTHING, because `prompt_tokens` /
`input_tokens` already include cached tokens and `…details.cached_tokens` is a SUBSET that must
never be added. The **Anchor** formula (`input + output`, ADR 0028) does not change at all.

**Why:** ADR 0028 named this exact loose end — *"`Usage` carries only `input_tokens` /
`output_tokens`, so the anchor is conservative in the WRONG direction on a cache-heavy wire…
compaction arrives **late** (a Provider 400) rather than early"* — and predicted the fix would
be "the `Usage` struct in `provider/types.rs` plus the three wire parsers, and the anchor
formula is the only consumer". We did less than that, deliberately: widening the struct invites
every consumer to sum the parts, and on two of our three wires that sum is WRONG (it
double-counts the entire cached prefix, which over-reads the anchor and makes compaction arrive
*early*). Putting the invariant at the seam where the wire's vocabulary is actually known keeps
the `Compactor` wire-blind and leaves the formula untouched.

**Considered Options**

- **Widen `Usage` with `cache_read` / `cache_creation` and add them in `record_usage`
  (rejected)** — it fixes Anthropic but silently breaks OpenAI-shaped wires unless each parser
  first SUBTRACTS the cached subset from `prompt_tokens`, i.e. it moves wire knowledge into the
  accounting layer and gives four fields two different meanings (disjoint parts on one wire, a
  subset on another). Every future consumer has to know which.
- **Leave it (rejected)** — the desktop's known-provider catalog is z.ai-shaped, cached prefixes
  are the normal case on Anthropic-compatible endpoints, and an under-read anchor is a failure
  that surfaces as a 400 rather than as a bug we can see.
- **Add a separate silent-overflow check (`input + cacheRead > window`, pi's case 2) (rejected)**
  — pi needs it because it keeps the counts apart. With a whole-prompt `input_tokens`, the
  existing `should_compact()` threshold already covers it.

**Consequences**

- **The double-count is the trap, and it gets pinned on both OpenAI-shaped wires**: a test
  asserting that a `cached_tokens` field changes NOTHING. The tempting "consistency" edit is the
  one that breaks it.
- **`Compactor`, `record_usage` and ADR 0028's snapshot model are unchanged.** This extends
  0028's consequence; it does not supersede the snapshot decision.
- **pi's three silent-overflow cases shrink to one gap for us.** z.ai-style silent overflow is now
  covered by the threshold. Still undetected, deliberately: a provider that truncates the input
  and returns `finish_reason: length` with zero output (Xiaomi MiMo) — the same case pi calls a
  recoverable length stop.
- **Where pi compacts vs where we compact, on purpose.** pi compacts at `agent_end`; we compact at
  the top of the next turn. Same moment for the user — still before anything oversized is sent —
  and it keeps every compaction inside the loop that owns `force_compact` (ADR 0045).
- **The dormant cache-token UI seam stays dormant.** `CostUpdatePayload.cacheReadTokens` /
  `cacheWriteTokens` (`src/store/interactive.ts`) have no native emitter at all (`cost_update`
  was self-emitted by the removed pi extension suite; only `todos_update` is pushed), and
  `SubagentDelegatingCard` renders `cost`, never the cache counts. They are left in place and
  named for a separate dead-code audit — feeding them would be plumbing that arrives nowhere.
