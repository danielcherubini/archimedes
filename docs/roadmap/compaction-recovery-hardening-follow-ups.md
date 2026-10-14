---
status: approved
---

# Compaction recovery hardening — the two things it does not fix

Follow-ups to `compaction-recovery-hardening.md` (the bounded summary + the
Retraction). Both were found while planning that work and are deliberately NOT
fixed by it. Neither is a blocker; both are recorded so the next reader finds a
decision rather than an oversight.

## 1. `resumeSession`'s merge counts array positions, and the reducer can now shrink the array

`applySessionUpdate` could previously only ever APPEND or REPLACE-LAST
(`sessions.ts:131-159`). The Retraction makes it able to **remove**
(`message_retracted` filters by `messageId`). `resumeSession` does not survive
that pattern by construction:

```ts
// sessions.ts:1207-1215 (shape)
const prior = <current messages>;
const rows = await loadHistory(sessionId);   // ← an await
const reloaded = rows.flatMap(rowToMessages);
const added = current.slice(prior.length);    // ← index arithmetic
```

If a Retraction lands during the `await`, `current` is shorter than the
snapshot assumed, `slice(prior.length)` shifts left, and a message the user
added in that window can be silently dropped from the merge.

The window is narrow — a session that is resuming is not usually mid-stream —
which is why it is a follow-up and not part of the Retraction's own work.

**What would fix it:** stop expressing "what arrived while we were loading" as an
index. The same file already has the right idea in the close/reload merge
(`sessions.ts:1237-1248`), which dedupes by `mergeDedupeKey` instead of by
position; `resumeSession` should select on that key (or on `at > priorAt`)
rather than on `slice(prior.length)`.

**Test to write first:** drive `resumeSession` with a `message_retracted`
arriving after the history `loadHistory` promise resolves but before the merge
runs, and assert the user message added in that window is still present.

## 2. The channel that carries a Retraction drops frames when it lags

The Retraction is a frame on the same `tokio::sync::broadcast` (capacity 256) as
the text chunks it erases (`worker/client.rs:160`, `:324`), and the pump
**discards the lagged messages** rather than recovering them
(`worker/manager.rs:626-636`, the `Lagged` arm). So a subscriber that falls
behind can keep the retry's chunks and lose the erasure between them — which
reproduces the exact weld (`partirecovered`) in both the live store and the
persisted rows.

This is not new: the same hole already applies to every frame the harness
emits, and ADR 0048 does not claim otherwise. It is listed here because the
Retraction is the first frame whose *absence* is incorrect output rather than a
missing cosmetic update — so if frame loss is ever observed in the field, this
is the first place to look.

**What would fix it:** either raise the capacity and treat `Lagged` as a fatal
condition for that subscriber (force a full `loadHistory` re-hydration of the
session, which the store already supports), or make the transcript read-through
(the renderer recomputes from persisted rows instead of accumulating frames).
Both are bigger than the Retraction and want their own ADR.
