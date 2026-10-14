---
status: approved
done-when: "A transcript whose older history alone exceeds the model's window still compacts successfully, and a reply that failed mid-stream leaves no trace of its partial text in either the live view or the saved display row on BOTH retry paths."
---

# Overflow recovery — the two follow-ups PR #12 left open

**Origin:** PR #12 (`/compact`, in-turn context-overflow recovery, the `Compacting` indicator). Greptile raised four P1 findings; two were fixed in that PR (`952fb6f` — the overflow trigger lives only as long as the turn that queued it; `8713a21` — a crashed Worker's in-flight compaction frame cannot re-lock the Composer). These two were triaged as real but **design-scale**, and Greptile agreed with both triages and reclassified them as follow-ups. They are recorded here so they are not lost; neither is a regression introduced by PR #12 — both are ceilings the recovery path inherits.

Shipped context: ADR 0045 (overflow is a provider tier, recovered in-turn), ADR 0046 (`input_tokens` is cache-inclusive at the parser seam), ADR 0028 (context accounting is a snapshot).

## 1 — The recovery summary can itself overflow

**Where:** `src-tauri/src/agent/harness/loop.rs` (the overflow recovery's compaction call), calling `compact::run_compaction` → `summarize`.

**The problem:** recovery hands the ENTIRE `older` set to one summary request against the SAME model that just refused the full prompt. If `older` alone exceeds the model's window — most reachable right after switching to a smaller-window model (`set_model` rebuilds the `Compactor` with the new window, so the whole existing history can already be over threshold) — the summary request fails with `ContextOverflow` too. The turn then settles with the actionable "not enough older context to compact" line and the history is never reduced. The user is back to typing "continue", which is the outcome ADR 0045 exists to remove.

**Why it was not fixed in PR #12:** closing it changes the contract ADR 0045 fixed — one compact-and-retry per overflow episode — because a bounded summary may need several model calls per compaction. It deserves its own ADR.

**What a fix looks like:** chunk `older` into bounded groups sized from the model's window, summarize each (sequentially, feeding the running digest forward, or map-reduce), and let the summary target shrink as it goes. `keep_budget()` (Task 1 of PR #12) already caps the RETAINED side; this is the mirror-image cap on the SUMMARISED side. Also decide what a partially-succeeded summary means when a later chunk fails — today `Failed` means "transcript untouched", which would need to stay true or be re-specified deliberately.

**Acceptance:** a session whose older history is, say, 3× the new model's window compacts successfully after a model switch and the turn continues without user action; a mid-summary failure still leaves the transcript unmodified.

## 2 — A partially-streamed reply survives recovery

**Where:** `src-tauri/src/agent/harness/loop.rs` (mid-stream recovery: the retry reuses the announced `message_start` id), with the display consequence in `src-tauri/src/agent/normalize.rs`'s `compute_display_rows`.

**The problem:** when a reply has already streamed some text and then the provider errors with a mid-stream overflow, recovery keeps the SAME `messageId` for the retry but discards the failed attempt's local reply. Already-emitted chunks are not retracted, and `message_end` does not replace them. With a failed attempt that streamed `parti` and a retry that streams `recovered`:

- the live view keeps both replies around the compaction line,
- the saved display row becomes `partirecovered` — the two are WELDED, because `applySessionUpdate` appends same-`messageId` agent-text chunks with no separator (`src/store/sessions.ts`),
- the model's history contains only `recovered`.

So the user reads a sentence that is a paste of a aborted attempt onto the real answer. This is the same welding hazard PR #12 avoided twice elsewhere (Task 5's unique local `messageId`, Task 6's "replace instead of append" `Compaction failed:` line).

**Why it was not fixed in PR #12:** it is **pre-existing on the retryable-retry path too** — `compute_display_rows` accumulates `agent_text_acc` per `messageId` with no reset — so patching only the overflow branch would make the two retry paths disagree about what a retried message looks like. Fixing it properly means one rule for both.

**What a fix looks like:** pick ONE contract for "a reply was abandoned mid-stream" and apply it to both the retryable-retry and overflow-recovery paths. Either the loop emits a retraction (a new frame the renderer and the display-row builder both honour by dropping that `messageId`'s accumulated text), or the retry is forced onto a FRESH `messageId` and the abandoned one is closed properly with its own `message_end`. The second is smaller and needs no new frame; the first is honest about "this text was withdrawn" and could render as a collapsed "interrupted" row.

**Acceptance:** with a provider that streams `parti` then errors — once via the retryable path and once via the overflow path — the live view shows only the successful reply, the persisted display row is exactly `recovered`, and the model history matches both.
