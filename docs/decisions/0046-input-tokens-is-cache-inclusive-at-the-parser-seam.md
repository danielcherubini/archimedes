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

## Amendment (2026-10-27) — `cost_update` now has a native emitter; the dormant cache-token seam stays dormant for a second reason

**AMENDED 2026-10-27 — one half of the last Consequences bullet stopped being true at commit `405be65` (2026-10-27, "feat(harness): emit the provider's per-call cost as `cost_update` (#87, T09)"), and the other half is now load-bearing for a different reason.** What stands unchanged: the whole-prompt `input_tokens` invariant and its parser-seam placement — the decision this ADR exists to record — the `Compactor`/anchor model of ADR 0028 that the invariant deliberately leaves untouched, and the cache-token fields themselves staying in place and unfed. This ADR is NOT superseded and its `status` is unchanged; the last Consequences bullet is deliberately left standing above as written, and corrected here rather than edited, because it is the record of what was true when the decision was taken. (The correction names its commit rather than an interval, because an interval in a durable document decays and is falsifiable the moment the tree moves — which is the exact defect issue #110 exists to catch.)

**What changed.** `cost_update` now has a **native Rust emitter**: `emit_cost_update` (`src-tauri/src/agent/harness/loop/emit.rs:63`), called from the `ProviderEvent::Usage` arm of the turn loop (`src-tauri/src/agent/harness/loop/turn.rs:206-207`), landing at `405be65` ("feat(harness): emit the provider's per-call cost as cost_update (#87, T09)"). So the bullet's two claims about the absent emitter are false from that commit onward: `todos_update` is no longer the only pushed event, and the removed pi extension suite is no longer the reason the cache-token counts have no emitter. The frame rides the `interactive-event` channel and `src-tauri/src/agent/events.rs` has no RPC variant for it and must not gain one; that is ADR 0082's decision and its pin (`a_cost_frame_is_not_an_rpc_event`), recorded there and not restated here.

**What is still true, and why it is now load-bearing for a different reason.** `CostUpdatePayload.cacheReadTokens` / `cacheWriteTokens` (renderer `src/store/interactive.ts`) still have **no** native emitter, and `SubagentDelegatingCard` renders `cost`, never the cache counts. That half matters now for a reason the bullet could not have stated: `applyCost` still SUMS the token fields on every frame, and the card reads its figure off that same entry — so leaving the fields on the payload is precisely what keeps this never-fed seam stable while a real `cost_update` frame is finally flying. They remain "left in place and named for a separate dead-code audit — feeding them would be plumbing that arrives nowhere."

**Considered, and rejected:** deleting the cache-token fields now — the dead-code audit is their owner, and the card still reads off the shared entry, so a deletion here would pre-empt another task's decision and touch the alias link ADR 0082 bounds; and adding an emitter for them now — a wire surface whose only consumer sums fields nothing populates.
