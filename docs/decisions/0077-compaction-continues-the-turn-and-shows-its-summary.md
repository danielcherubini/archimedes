---
status: accepted
date: 2026-10-25
superseded-by:
---

# A compaction continues the turn it interrupted, and its summary is the output of a tool card

Two halves of one defect ([issue #90](https://github.com/danielcherubini/archimedes/issues/90)): an
automatic compaction that could not produce a summary **ended the turn** while its own event
promised it would not, and the summary — the only thing a compaction produces that a person would
want to read — was **shown nowhere**. We decided both: a `Failed` overflow recovery re-issues the
model call (only a `Skipped` one ends the turn), `will_retry` is reconciled with the outcome that
follows it, and a compaction is rendered as a `ToolCallCard` whose expanded body is the summary.

**Why:** ADR 0045 was written to end the symptom "the user stares at a dead transcript they have to
nudge with a fresh continue", and one sub-case of it never stopped producing that symptom.
`run_compaction` returned a single `bool` — "did the transcript shrink" — and `compact_if_due`
settled the turn whenever it was `false`. That boolean merged two facts that are not the same fact:
`Skipped` proves the kept tail alone is over the window, so a second request cannot succeed;
`Failed` proves only that the **summary call** errored, which says nothing about whether the turn's
own request fits, and leaves the transcript intact. The same event meanwhile carried
`will_retry: true`, documented in `loop.rs` as "the turn continues on the other side of this
compaction" — echoed from the trigger, never reconciled. A probe on this tree (overflow → summary
returns `Done(Length)`) read `will_retry = true`, two model calls, and an event stream of
`turn_start, compaction_start, compaction_end, turn_end, agent_settled`: the promise and the dead
turn in the same breath.

The second half had the same shape — information computed and then dropped. `compact.rs` holds the
summary in scope, writes it to the `System` transcript row the model is replayed, and the caller
emitted `compaction_end { result: None }` hardcoded. So the model knew the summary and the user
never could. The transcript's only trace was a `system_chunk` one-liner, and every one-liner shares
`{stamp}:system`, which the frontend appends with no separator — so a session that compacts
repeatedly reads as ONE bubble.

**Measured in the live dev `archimedes.db`.** Count the `messages` rows whose `message_key` ends
`:system` — that key is written only by `system_chunk`, so this selection cannot be polluted by a
session quoting these strings in its own tool output (an earlier count of mine was polluted exactly
that way and read 75/29; the method below is the one to re-run). Counting occurrences of the three
line texts inside those rows, not rows:

| | |
|---|---|
| compaction outcomes (`finished` + `failed`) | **74** |
| of them failed | **29** — **39%** |
| `:system` rows holding 2+ outcomes (i.e. welded) | **30** of 50 |
| worst single row | 12 starts + 13 failures, one bubble |

The worst row reads, literally:

`Compacting context…Compaction failed: retryable: the summary hit the output token limitCompacting context…Compaction failed: retryable: …`

**All 29 failures carry the same reason** — `retryable: the summary hit the output token limit`, i.e.
the summary hitting ADR 0047's output cap. That is the common case, not an edge one.

## Considered Options

- **Fix the lie only — make `will_retry` honest, leave the turn settling (rejected).** Smallest
  correct diff, and it satisfies no part of the report: the user still types "continue" after every
  failed compaction. The flag's honesty is worth having on its own, which is why it is done AS WELL
  as the re-issue rather than instead of it.
- **Always continue, including after `Skipped` (rejected).** Keeps ADR 0045's "no doomed second
  request" intact for the one case that earned it: `Skipped` is reached by *proving* the kept tail is
  over the window, so the request is known to fail and costs a round trip to learn nothing.
- **Keep the one-liner and hang the summary off it as an expandable body (rejected).** Cheaper in
  display-row kinds, but it invents a bespoke expand affordance next to a component that already
  renders "something ran, here is what it produced" — header verb, status, live partial, persisted
  output, reload rehydration — and it leaves the weld in place for every compaction after the first.
- **Emit the card only for automatic compactions, keep `/compact` a one-liner (rejected).** Two
  vocabularies for one event, and the weld is worst exactly where `/compact` lives (a manual
  compaction is what a user repeats while watching the context bar).
- **`compaction_update` as the carrier (rejected).** That frame is session *state* — the indicator,
  `composerLocked` and the Esc-to-cancel gate read it — and it persists no display row by design
  (`compute_display_rows`' catch-all, pinned). Transcript content and a live gauge are different
  surfaces; the frame survives both events unchanged.

## Consequences

- **`run_compaction` returns `CompactionRan` (`Compacted` / `Skipped` / `Failed`), not `bool`.**
  The three-way return is the fix, not decoration: the old `!shrank` test is what conflated
  "provably doomed" with "the summary call hiccuped". `compact_if_due` settles only on
  `overflow && Skipped`.
- **`will_retry` is now computed where the outcome is known**, at the one call site that sees both
  halves: `will_retry && !(overflow && ran == Skipped)`. It stays a UI contract, and pi's
  `agent_end.willRetry` is the same vocabulary, so a future consumer of the contract is no longer
  told the opposite of what happens.
- **The retry after a `Failed` overflow is bounded by the guard ADR 0045 already had.**
  `overflow_recovered` resets only when a model call SUCCEEDS, so the worst case is overflow →
  summary → one re-issue → settle. Measured: 3 model calls, then `turn_end` + `agent_settled`. No
  loop, and no new counter.
- **A compaction emits `tool_call` / `tool_call_update` and NO `system_chunk` at all.** The
  announce/settle pair is what `ToolCallCard` renders, so `rawInput` carries the trigger (the header
  reads it as "context over threshold", never raw JSON) and `rawOutput` carries the summary as an
  `AgentToolResult` `content[]` — the shape `normalizeToolOutput` already joins, and the shape
  `compute_display_rows` persists, so a reload restores the expanded body for free. A failure puts
  its reason in `details.error`, which is where `failureText` looks first, so ADR 0045's actionable
  line reaches the Failed tooltip exactly as any other tool's does.
- **Removing the one-liners deletes the defect they were engineered to dodge.** ADR 0045's
  replace-not-append rule existed because two `system_chunk`s weld; a compaction now emits none, and
  each one gets its own card id, so neither weld is reachable. The reducer's append rule is still
  load-bearing for the lines that remain (the retry line, the retraction line) and is pinned as such
  in `src/store/sessions.test.ts`.
- **The card id is `{stamp}:compact:{n}`** — stamped like every id the harness mints (ADR 0049), and
  shaped so no provider `toolCallId` (`call_…`, `chatcmpl-tool-…`) can collide. The per-compaction
  counter is load-bearing, not tidiness: a single shared key would merge a session's compactions
  into one card, re-creating the merge the one-liners had. `harness_loop.rs`'s ADR 0049 pin moved
  from the `system` key to this id family, which is the same `TurnState::id` under the test.
- **`compaction` is a display title, not a tool.** It is deliberately absent from `tool_specs()` —
  the model cannot call it — and absent from `dispatch_tool`, so nothing can execute under the name.
  Its verb pair (`Compacting` / `Compacted`) and icon live in `toolOutput.ts` beside the real tools,
  because `ToolCallCardHeader` renders `verb ?? title` and without the entry the row reads the raw
  string `compaction`.
- **A `compaction_end` with no matching `compaction_start` still lands** (a resume, or a Worker that
  began mid-compaction): it mints its own id rather than sharing a bare key, because dropping a
  FAILED outcome silently is worse than an unannounced card — and both `compute_display_rows` and
  the reducer already treat an unknown id as a new card.
- **A Worker that dies mid-compaction leaves a `pending` card, which `finalizeSessionMessages`
  marks `failed` on close** — the same rule every other in-flight tool call gets, so no new
  settle-path special case. The indicator itself was already cleared by `markStalled`; that path is
  unchanged.
- **The 39%-failure rate this surfaced is NOT fixed here.** The summary hitting its own output cap is
  ADR 0047's `summary_output_cap` (`min(0.8 × reserve_tokens, 8192)` = 8 192 at the default reserve)
  being too small for the range it is asked to summarize. What changed is that the failure is now
  survivable and legible: the turn continues, and the card says why. Widening the cap is a separate
  decision with its own cost (a longer summary costs more of the window it is trying to save).
