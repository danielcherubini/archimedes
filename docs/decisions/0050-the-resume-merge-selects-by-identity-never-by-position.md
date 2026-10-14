---
status: accepted
date: 2026-10-14
superseded-by:
---

# The resume merge selects messages by identity, never by position

`resumeSession` reloads the persisted transcript after an `await`, then merges "whatever the user added while we were loading" as `current.slice(prior.length)` — an index measured against a snapshot taken BEFORE that await. `applySessionUpdate` can now REMOVE messages (ADR 0048's Retraction filters by `messageId`), so the array can be shorter than the snapshot assumed, the slice shifts left, and a prompt the user sent during the window vanishes from the transcript until the next reload. We decided to select the added messages by identity — `mergeDedupeKey`, plus `at > priorAt` where content alone is ambiguous, which is already the rule the close/reload merge in the same file uses — so the merge stops depending on how many messages existed a round-trip ago.

## Consequences

- **When identity cannot decide, the merge KEEPS the message.** A duplicated bubble is annoying; a lost prompt is data loss. This is the same direction the existing user-message timestamp tiebreak already chose.
- **A live thought can be duplicated by this race, on purpose.** Live it carries `{stamp}:m1`, but its persisted row key is `{stamp}:m1#1`, so its dedupe key can never match its own reloaded row. Stripping the `#seg` to make them match would make two thought segments of one message indistinguishable in `mergeDedupeKey` — trading a rare duplicate for a possible drop of a real segment.
- **The merge still appends, so a message can change position across a resume.** Order comes from the reloaded rows, then the kept additions; nothing in the merge sorts by id. Positions were never identity, which is the whole point of the rule.
