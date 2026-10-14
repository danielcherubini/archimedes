---
status: accepted
date: 2026-10-14
superseded-by:
---

# The resume merge selects messages by identity, never by position

`resumeSession` (`src/store/sessions.ts`) reloads the persisted transcript after an `await`, then merges "whatever the user added while we were loading" as `current.slice(prior.length)` — an index measured against a snapshot taken BEFORE that await. `applySessionUpdate` can now REMOVE messages (ADR 0048's Retraction filters by `messageId`), so the array can be shorter than the snapshot assumed, the slice shifts left, and a prompt the user sent during the window vanishes from the transcript until the next reload. We decided to select the added messages by identity — `mergeDedupeKey` plus the message's own `at`, COUNTED so a repeat of an identical message still counts as new — matching the identity rule the same merge already applies to the reloaded rows, so the merge stops depending on how many messages existed a round-trip ago.

## Consequences

- **When identity cannot decide, the merge KEEPS the message.** A duplicated bubble is annoying; a lost prompt is data loss. This is the same direction the existing user-message timestamp tiebreak already chose.
- **A message that MUTATES during the window duplicates.** `mergeDedupeKey` is content-based, so an in-flight same-`messageId` append or a `tool_call_update` on a message that predates the snapshot is no longer "in the snapshot" and re-enters the additions — duplicating if its persisted row lags. Accepted: the positional rule truncated that streamed tail instead, which is the worse half of the same trade.
- **A live thought can be duplicated by this race.** Live it carries `{stamp}:m1`, but its persisted row key is `{stamp}:m1#1`, so its dedupe key can never match its own reloaded row (the duplication itself predates this decision — the positional rule included it too). Stripping the `#seg` to make them match would make two thought segments of one message indistinguishable in `mergeDedupeKey` — trading a rare duplicate for a possible drop of a real segment.
- **Nothing about ordering becomes stable.** The merge still appends — order comes from the reloaded rows, then the kept additions — and nothing sorts by id. Positions were never identity, which is the whole point of the rule.
- **`openSession` keeps the same class of hole** (it applies its reloaded rows verbatim, with no merge at all). Out of scope here because it has no window to lose messages *to* — it simply overwrites — and it is recorded as a follow-up.
