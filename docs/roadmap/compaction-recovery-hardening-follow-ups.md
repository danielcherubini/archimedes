---
status: approved
---

# Compaction recovery hardening — the things it does not fix

Follow-ups to `compaction-recovery-hardening.md` (the bounded summary + the
Retraction). §1 and §2 were found while planning that work and are deliberately
NOT fixed by it. §3 was found in review of the PR that shipped it, and is not
fixed there either — for the reason stated in it. None is a blocker; all are
recorded so the next reader finds a decision rather than an oversight.

**Disposition (2026-10-14).** §1 is folded into `session-incarnation.md` (ADR 0050) and §3 is RETIRED by ADR 0049 — resolved before it was ever planned as its own change. §2 stays open. §4 is the stalled tail and §5 `openSession`'s reload race, both written down while planning that spec (the latter found reviewing its plan). §6 (the bare `default` fallback key) and §7 (`tool-call` rows are the one display-key family ADR 0049 does not scope) are the two residues the review of that branch named: both are **recorded on purpose, not open work** — §6 deliberately left bare on both sides, §7 a pre-existing hazard rather than an incarnation one. §8 is the third mutator ADR 0050's merge accepts, named in review of the same branch: also **accepted, not open work**, with its alternative recorded. §9 is test-hygiene only (a leaked temp dir), recorded here because the plan that found it is deleted on ship.

Citations in this document name **symbols, not line numbers** — `applySessionUpdate`'s chunk arms, the pump's `Lagged` arm — because line numbers re-drift on every commit and a stale one points a reader at the wrong code, which this document did once.

## 1. `resumeSession`'s merge counts array positions, and the reducer can now shrink the array

**Status: folded into `session-incarnation.md` (ADR 0050).** The analysis below stands as written; the fix is the merge rule that spec selects.

`applySessionUpdate` could previously only ever APPEND or REPLACE-LAST
(`applySessionUpdate`'s chunk arms). The Retraction makes it able to **remove**
(`message_retracted` filters by `messageId`). `resumeSession` does not survive
that pattern by construction:

**HISTORICAL — this code no longer exists.** It is `resumeSession`'s merge as it
stood before ADR 0050 replaced it with the identity selection; quoted because
the analysis below is about that rule.

```ts
// resumeSession's merge as it stood before ADR 0050 (shape)
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

**What would fix it:** stop expressing "what arrived while we were loading" as
an index. Select on `mergeDedupeKey` (+ the message's own `at`) exactly like the
dedupe pass INSIDE that same merge already does — `resumeSession`'s dedupe pass
(`reloadedKeys` / `reloadedUserAt`), long the only identity-based selection in
the file; an earlier revision of this document pointed at a separate
"close/reload merge" there, which does not exist, and a line-number range for
this spot is now actively misleading, because that range holds the NEW counted-
multiset selection ADR 0050 landed rather than the dedupe pass it described.

**Test to write first:** drive `resumeSession` with a `message_retracted`
arriving after the history `loadHistory` promise resolves but before the merge
runs, and assert the user message added in that window is still present.

## 2. The channel that carries a Retraction drops frames when it lags

The Retraction is a frame on the same `tokio::sync::broadcast` (capacity 256) as
the text chunks it erases (`worker/client.rs:160`, `:324`), and the pump
**discards the lagged messages** rather than recovering them (the pump's
`Lagged` arm in `worker/manager.rs`, which `continue`s). So a subscriber that
falls behind can keep the retry's chunks and lose the erasure between them —
which reproduces the exact weld (`partirecovered`) in both the live store and
the persisted rows.

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

**Status: RETIRED — resolved by ADR 0049, which chose neither option below.** Every id the harness mints now carries its **incarnation** stamp, so two Workers of one Session share no key at all. The two options here also undercounted the problem: `agent-text` rows are keyed by the constants `"system"` and `"default"` too, which no counter seed can separate — the reason stamping won. Kept because it is the analysis the ADR answered.

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

## 4. A crashed Worker leaves a reply on screen that the model never had

ADR 0048 makes an **Abandoned attempt** loud: every retry path retracts the text
it streamed. A **crash** is the one turn exit with nobody left to emit the frame.
The chunks are already persisted — the sink wrote them as they arrived — so a
**Stalled session** shows a half sentence, **Resume** starts a fresh Worker, and
the model's own history (`native_messages`) never contained that reply at all.
The UI already treats the turn as ended (a crash resolves the in-flight turn the
way a real finish does, ADR 0038's note in **Attention alert**); it is only the
text that lies.

**Repro shape:** stream text, kill the Worker mid-turn (`tests/ipc.rs` already
drives a crash and a resume), then assert from `messages_for` that the truncated
`agent-text` row is still there after `resume_session` — which it is, and which
is the defect.

**The fork, which is why this wants its own ADR:**

- **erase it on Resume** — the Supervisor is the sole writer and has seen every
  `DisplayUpsert` for the session, so it knows the last `agent-text` key; a
  Resume could retract it and say so, which is ADR 0048's vocabulary applied by
  the **Supervisor** instead of the harness. Honest about the model's history,
  and it throws away the only trace of where the reply stopped.
- **keep it, marked** — the row stays as evidence that a reply was cut off, with
  something distinguishing "truncated by a death" from "finished". Today the
  display schema carries no such marker, so this is a schema question, not a
  call-site one.

Erasing and keeping are both defensible and they optimise for different readers,
so the decision is a product one. Not fixed by the incarnation work, which is
about ids that cannot collide — not about who owns the last word of a dead
Worker's reply.

## 5. `openSession` applies a history reload verbatim, so it can drop live messages too

Found while fixing §1. `openSession` is the OTHER history reload in the store,
and it has no merge at all (abridged):

```ts
const rows = await loadHistory(sessionId);   // ← an await
if (get().activeSessionId !== sessionId) return;
set({ messages: { ...st.messages, [sessionId]: rows.flatMap(rowToMessages) } });
```

Anything the Client added to that session's transcript while the fetch was in
flight — a **Composer command**'s system line, a `Client`-side notice, a queued
user message — is overwritten, not merged. The guard only protects against the
user having switched AWAY; it says nothing about what landed in between.

Why it is separate from ADR 0050: `resumeSession` had an index-based merge to
replace, and this one has no merge to replace, so the fix is a decision (adopt
the same identity-based merge, or make the open path read-before-write once and
block writes until it settles) rather than a correction.

**Test to write first:** open a stored session whose `loadHistory` resolves
late, add a message to it during the window, and assert the message is still
there afterwards.

## 6. The bare `default` fallback key is the one STAMPED-SHAPE display key still able to collide across incarnations

**Problem.** ADR 0049 stamps every id the harness MINTS, but the no-`messageId`
fallback key stays bare on BOTH sides: `compute_display_rows`'s
`.unwrap_or("default")` on the persisted side and `applySessionUpdate`'s
`update.messageId ?? "default"` in the live store. Two lives of one Session that
ever reached those fallbacks would share the `default` key, which is precisely
the collision class ADR 0049 exists to remove.

**Why deferred — it is unreachable, and closing it on one side only is worse
than leaving it.** The fallback fires only for a frame carrying no `messageId`
at all where one was expected, and `normalize` never produces one: every
`agent_message_chunk` / `agent_thought_chunk` it emits is stamped. And it is
bare on both sides DELIBERATELY: the Worker's stamp never crosses to the Client
(the only frame in the stream that could carry it is `session_info_update`,
whose production shape is the title alone — the `incarnation` field the
two-incarnation e2e reads is a `fake_worker` fixture addition, not a wire
promise), so stamping only the persisted side would desync a reloaded row from
the live row the Client already rendered for the same frame — a duplicate
bubble per resume instead of a theoretical collision. ADR 0049 records this as
a residue rather than a defect.

**Sketch.** If a frame ever ships without a `messageId`, the fix belongs on
BOTH sides in the same commit: either the frame carries the stamp (which means
the Client learns the Worker's stamp — a protocol change, since
`StartEnv.incarnation` is Worker-side today), or the fallback key is derived
from something both sides compute identically WITHOUT the stamp. There is no
such field on the wire today — no `turn_id`, no sequence number on a
`session-update` frame — which is exactly why the fallback is a bare constant.

## 7. `tool-call` rows are the one display-key family ADR 0049 does not scope — and the live reducer already resolves their duplicates by first-match

**Problem.** A `tool-call` display row is keyed by `toolCallId`, which the
PROVIDER mints, not the harness — so it is the one display-key family that
carries no incarnation stamp (ADR 0049's five families are the ids `normalize`
mints: `m{n}`, `m{n}#{seg}`, `retract:{n}`, `system`, `default`). A resumed
Worker whose provider reused a `toolCallId` would UPSERT over the earlier
life's card.

**Why this is tolerable today (the sharper reason).** Stamping it is not
available — the harness does not own the id — and the reuse it would protect
against is already a frontend hazard that predates the incarnation work: the
live reducer resolves a duplicate `toolCallId` to the FIRST match
(`applySessionUpdate`'s tool arms — `tool_call_update` locates its card with
`findIndex`, so an update naming an id two lives both used lands on the OLDER
card). Tool-id reuse across lives is therefore a **pre-existing frontend hazard,
not an incarnation one**: the store already cannot tell two same-`toolCallId`
cards apart, stamping the persisted key would change nothing about that, and
ADR 0049's row-level guarantee was never what keeps tool cards apart.

**Sketch.** If it ever needs closing, the harness could key its `tool-call`
display row `{stamp}:{toolCallId}` while the frame keeps the bare provider id —
but that splits the two sides exactly the way §6 refuses to, because the live
reducer keys the card on the frame's `toolCallId`. The honest fix is the same
both-sides rule: get the stamp (or any per-life token) to the Client, then key
AND match with it.

## 8. A Close inside `resumeSession`'s load window duplicates a tool card — the third mutator ADR 0050 accepts

**Problem.** `handleSessionClosed` runs `finalizeSessionMessages`, which maps
every still-`pending` tool call to `failed`. **Resume** a session and then
**Pause**/Close it before `loadHistory` resolves, and that card's
`mergeDedupeKey` (`tool-call|<id>|<title>|<status>` — `status` is part of the
identity) changes INSIDE the window: the card is no longer "in the snapshot",
it re-enters `added`, and the `reloadedKeys` gate does not catch it either,
because the persisted row still carries the status the WORKER last wrote
(`finalizeSessionMessages` is a frontend-only map — nothing about a close ever
reaches the display store). The merged transcript holds TWO cards for one tool
call: the reloaded row at `pending` — an open spinner for a session the user
just closed — and the finalized live copy at `failed`. Verified on the store
before being recorded, and pinned by `sessions.test.ts`'s "duplicates a tool
card when a session close finalizes it inside the load window (the third
mutator ADR 0050 accepts)".

**Why deferred — this is ADR 0050's decision APPLIED, not an oversight.**
Where identity cannot decide, the merge KEEPS the message: a duplicated card is
annoying, a lost message is data loss, and this window is exactly the case the
ADR chose duplication for. The positional rule the branch replaced could not
produce this duplicate (it never re-selected a message that was already in the
snapshot), but on the same window it produced the opposite error — silently
truncating the streamed tail — so removing the duplicate by going back to
position, or by dropping the finalized copy, re-opens the worse half of the
trade. The scope is also narrow in a way the other two mutators are not: it
needs a Close in the load window AND a persisted row that LAGS the live card.
A tool call whose `tool_call` frame merely arrives during the window is kept
exactly once (the control test, in the same `describe`), because with no
reloaded row there is no key to mismatch.

**Sketch — the alternative, if the duplicate ever proves unacceptable.** Gate
`fresh` on ID-EXISTENCE rather than whole-key existence for the id-bearing
kinds: drop an added `tool-call` when a reloaded row carries the same `id`,
whatever its `title` / `status`. That removes this duplicate and every
`tool_call_update` duplicate in the window — by CHOOSING loss over duplication
for precisely those kinds (the kept copy is the lagging persisted one), which
is a decision wanting its own ADR rather than a comment to edit. It must NOT
reach `user` messages (no id at all, so nothing to gate on) or
`agent-text` / `agent-thought`, whose same-`messageId` append during the window
is the streamed tail ADR 0050 refuses to truncate. The change is not silent:
the pinned test above reddens the moment `fresh` is gated on the tool-call id
(verified by mutation — that gate reddens it and nothing else in the suite).

## 9. `tests/session_native.rs`'s `temp_config_dir()` leaks its directory

**Problem.** The e2e's `temp_config_dir()` hand-rolls a directory under
`temp_dir()` and removes it only on the success path, so a failing run leaves it
behind permanently — and the passing path's `remove_dir_all` silently ignores
every error. Hundreds of these accumulated on one development machine before
anyone looked.

**Why deferred — out of scope, and it is a two-line fix whenever it is wanted.**
The session-incarnation branch fixed the *other* copy of this defect
(`normalize.rs`'s `temp_db()` now returns a `tempfile::TempDir` guard and the
caller holds it) and deliberately did not widen that Rust iteration into the
integration fixtures. Nothing depends on the leak; it just fills `/tmp` and
eventually confuses a disk-space investigation.

**Sketch.** Return the guard, exactly as `temp_db()` does now: make
`temp_config_dir()` return `(PathBuf, tempfile::TempDir)` (or
`tempfile::TempDir` plus a path into it) and bind both at each call site. The
dev-dependency is already in `Cargo.toml`, used this way by `agent/mcp`'s tool
tests. Grep for `env::temp_dir()` across `src-tauri/` when doing it — that is
the shape this defect leaves behind.
