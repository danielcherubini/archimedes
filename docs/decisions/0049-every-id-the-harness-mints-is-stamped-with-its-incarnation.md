---
status: accepted
date: 2026-10-14
superseded-by:
---

# Every id the harness mints is stamped with its incarnation

A **Session** outlives its **Worker**: a **Stalled session** is resumed by a fresh Worker whose `TurnState` is fresh, so `msg_counter` and `retract_seq` start at 0 again and the resumed session's first reply is `m1` — the id its first Worker already used. The display store UPSERTs on `UNIQUE(session_id, kind, message_key)`, so the new incarnation silently overwrites the old one's rows, and ADR 0048's Retraction, which erases BY `messageId`, can then erase history that is not its own. It is worse than a counter problem: `agent-text` rows are also keyed by the fixed `"system"` and `"default"` ids, so a resumed Worker's first system line UPSERTs over the previous Worker's and destroys it with no counter involved at all. We decided to give each **incarnation** its own id space — the **Supervisor** mints a short opaque token per `Start` envelope (`StartEnv.incarnation`) and `normalize`, the ONLY place a `messageId` is ever put on a frame, stamps every id it mints with it — so two incarnations of one Session cannot write the same display row by construction.

## Consequences

- **Five id families, one rule.** `m{n}`, `m{n}#{seg}`, `retract:{n}` and the constants `system` / `default` all carry the stamp (`a3f9c1:m1`, `a3f9c1:m1#2`, `a3f9c1:retract:1`, `a3f9c1:system`). `compute_display_rows` reads ids off the frames rather than minting them, so every display key inherits the stamp, and a Retraction can only ever name ids carrying its own stamp.
- **One stamp per `Start` envelope** is the invariant, minted where the envelope is built (both production sites: a main session's start/resume and a **Subagent session**'s dispatch). `worker/core.rs` tolerates a second `Start` replacing the loop on a live Worker — test-only today, since a real resume always spawns a new process through `WorkerManager::attach` — and such an envelope MUST carry a fresh stamp, or the collision returns. We recorded the invariant rather than building a mechanism to police a path that should not exist.
- **No migration, and stored data cannot collide.** Rows written before this change keep their bare `m1` / `system` keys forever, and a bare key can never equal a stamped one. A Session that straddles the change mixes both shapes in one transcript and needs nothing from us, because nothing parses an id.
- **The one structural reader got a shape change.** `is_bookkeeping_message_id` decides which ids are harness bookkeeping rather than model output — the predicate that stops a discard line being handed to a parent model as its child's answer — and it now reads the field after the stamp rather than matching a bare prefix. It stays in ONE place, with a negative pin that a stamped real reply is still capturable.
- **A resumed transcript keeps what the previous incarnation said.** Where a resumed Worker used to overwrite the old system line, the two now sit in the transcript as separate rows. That is the fix, not a regression to tidy up.
- **Ids never enter the model's history.** `native_messages` keys on `seq` and a `ChatMessage` carries no id, so the stamp is a display/protocol concern only; compaction, retries and the provider prompt are untouched by it.
- **Everything downstream carries ids opaquely.** `mergeDedupeKey`, `rowToMessages`, the live store's `message_retracted` filter and React keys (index-based, not id-based) need no change. The Client's own `client:N` transcript lines are a separate, unpersisted namespace and stay bare.
- **Fresh sessions are stamped too**, and so are **Subagent sessions** (which never resume): one id shape for a whole transcript beats two shapes at a lifetime boundary.

## Considered Options

- **Seed the counters at start** — the **Supervisor** reads the highest persisted `m{n}` / `retract:{n}` / thought segment for the session and the new `TurnState` resumes numbering from it. Rejected: it needs a query over a TEXT column (`MAX(message_key)` is lexicographic, so `m10 < m2`) parsing three key families, couples session-start to the display table that the resume path deliberately never reads, and leaves `system` and `default` colliding — because neither is a counter. Its only real advantage is that ~40 existing id assertions keep their exact values, which is not the expensive part of this change.
- **Let the loop mint its own token** at construction — no protocol change at all, and the boundary is auto-correct. Rejected: every id assertion in the suite (`"m1"`, `"m1#1"`, `"retract:2"`) degrades from an exact value to a prefix matcher — and the reason this defect shipped is that no assertion was strong enough to span two Workers — while the Worker would decide for itself the one fact the start envelope exists to tell it.
- **Stamp only the counter-derived ids** and leave the constants bare — smallest diff, half the fix, and the half it leaves is the one with no counter to seed.
