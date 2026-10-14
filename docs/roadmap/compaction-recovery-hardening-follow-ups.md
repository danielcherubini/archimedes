---
status: approved
---

# Compaction recovery hardening — the things it does not fix

Follow-ups to `compaction-recovery-hardening.md` (the bounded summary + the
Retraction). §1 and §2 were found while planning that work and are deliberately
NOT fixed by it. §3 was found in review of the PR that shipped it, and is not
fixed there either — for the reason stated in it. None is a blocker; all are
recorded so the next reader finds a decision rather than an oversight.

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

## 3. A resumed Worker reuses the previous Worker's messageIds, so a Retraction can erase history that is not its own

`TurnState` is built once per `AgentLoop` (`loop.rs`, the `turn_state` mutex's
`TurnState::default()`), and `msg_counter` and `retract_seq` both start at 0.
A resume is a NEW Worker with a NEW loop, so the resumed session's first
assistant reply is `m1` again — the id its first Worker already used — and its
first discard line is `retract:1` again.

ADR 0048 erases BY messageId, so both of its erasure paths reach the previous
incarnation's rows:

- **the live store** — `applySessionUpdate`'s `message_retracted` arm filters
every `agent-text` / `agent-thought` carrying the id, and `resumeSession`'s
`loadHistory` hydration has just put the OLD reply in the store under that same
bare id (`rowToMessages` sets `messageId` from the persisted `message_key`,
which for text rows IS the bare messageId);
- **the persisted rows** — the erase overwrites `m1` and `m1#n` with empty
text, and the display store UPSERTs on `UNIQUE(session_id, kind, message_key)`,
so the historical answer is gone from the next hydrate too.

**Reproduced** (at the store, no Worker needed): hydrate one `agent-text` row
keyed `m1` with text, apply a thinking-only `agent_thought_chunk` on `m1` (the
new attempt streamed thinking and nothing else), then `message_retracted` for
`m1`. The transcript comes back **empty** — the abandoned attempt deleted text
it never emitted.

**Why it is not fixed by this PR.** The id reset is not the Retraction's
doing: a resumed reply already UPSERTs over the earlier `m1` row with no
Retraction involved, so the collision predates ADR 0048 — what the Retraction
changes is that the collision becomes *visible* as vanished history instead of a
silently overwritten row. Nor can the reducer absorb it. A "clear only the
trailing run carrying this id" rule fails because a partial reply is not
necessarily the transcript's tail: an abandoned attempt announces tool calls
too, which is exactly why ADR 0048 closes them with a synthetic
`tool_execution_end`. The store cannot tell which incarnation streamed a row;
only the harness knows, so the fix is the id namespace, and that is a decision
of its own:

- **seed the counters per session** — the Supervisor reads the highest
`m{n}` and `retract:{n}` already persisted for the session and passes both in
`StartEnv` (a new field on the start envelope + one query); or
- **give the ids a per-incarnation token** (`m1·7f3a…`), which changes the id
every consumer and every persisted key carries.

Seeding keeps `m{n}` intact for a fresh session, so nothing downstream changes.
Both counters need it: the discard line CANNOT be keyed off the retracted
message id, because one message can be retracted more than once — each retry
reuses that id (`message_start` fires once per assistant message) until an
attempt lands. `ThoughtState.next` does not, since its `{id}#{n}` keys inherit
the seeded id's uniqueness.

**Test to write first:** the store repro above as a case in
`sessions.test.ts`, then a Worker-level test that resumes a session whose
persisted rows include `m1` and asserts the next reply's `messageId` is not
`m1`.
