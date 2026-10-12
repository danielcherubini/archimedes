---
status: accepted
date: 2026-10-12
superseded-by:
---

# One attention alert at a time, oldest question first

Several **Sessions** can be paused on the user at once — two open `ask`s, a run that
finished while a **Permission prompt** waits, a **Subagent session** holding a gate —
while **ADR 0039** gives the app exactly one countdown: Rust holds a single pending
task and `attention_arm` replaces it. Someone must therefore decide which pause owns
that slot, and this ADR is that decision. It belongs apart from ADR 0038, which
decides *whether* an armed alert fires; this one decides *which pause gets armed*, and
they fail independently.

The rule, as implemented in `attentionCandidates` (`src/lib/attention.ts:153`) and
rule R5 (`:357`), is a positional ladder evaluated over a LIST of candidates rather
than a timestamp, and the slot changes hands only for a higher-ranked pause:

- **a question outranks a finished run, app-wide** — every `waiting` candidate is
  listed before every `settled` one, the same precedence `sessionStatusOf` gives
  `waiting` over `running`, so an unanswered question displaces a running "finished"
  countdown and a `settled` pulse never displaces a live question;
- **among open questions the one that ranks FIRST holds the slot**, and rank is
  positional because there is no cross-Session arrival stamp: WITHIN a Session the
  ranking is `waitingIds` array order, i.e. arrival order, so the earliest-arrived
  still-open gate keeps the slot and a newer question there changes nothing; ACROSS
  Sessions `candidateOrder` decides (active Session first, then live main Sessions in
  store order, then subagents — `src/hooks/useAttentionAlert.ts:106-116`);
- **a `settled` countdown IS displaced** — by a question opening over it, and by a
  later `settled` pulse from a Session ranking ahead;
- **a pause that was already announced never re-alerts, and no longer mutes what is
  under it.** The announced set (`spent`) is a SET and the candidate list is a LIST,
  and both shapes are load-bearing: with a single announced-pause slot, announcing the
  second pause erased the record of the first and re-alerted a pause the user had
  already been told about (`6b8b613`); with a single head candidate compared against
  that set, one already-announced question — which is a steady state, since
  `ask`/`confirm`/`password` gates have no timeout — vetoed every later pause in every
  other Session *permanently*, because a `settled` pulse exists on exactly one
  snapshot and is never re-delivered (`4a6dd8d`).

## Considered Options

- Newest-question-wins ("the alert names the most recent pause") — rejected on two
  grounds. Mechanically, each arriving question would re-arm Rust's clock, so a stream
  of questions keeps the deadline sliding and no alert ever lands: the failure mode
  the feature exists to prevent, manufactured by the rule. And informationally, the
  body names the **Session**, not the question (`X needs your answer`), so "the most
  recent one" buys the user nothing actionable at the moment they act on it anyway.
- One countdown per Session (or per pause) — rejected: it ends the ladder by removing
  the single slot, but the slot is what makes the protocol one-way and id-less (ADR
  0039 — Rust is handed a delay and some text and learns nothing). Per-pause timers
  mean a cancel-by-id protocol plus N banners landing together, which is the noise ADR
  0038 exists to avoid.
- Timestamp-rank the questions — rejected: the snapshot carries no cross-Session
  arrival time, and inventing one means state to keep in sync (gate re-deliveries,
  reloads) to buy a ranking `candidateOrder` already provides deterministically.
- A single announced-pause slot, or a single head candidate — not options in the end;
  both shipped, both were defects, and the two fixes above are what replaced them.

## Consequences

**"The alert names the most recent pause" is false as a general statement, and must
not be re-derived from memory.** It holds for `settled`-over-`settled` and
`waiting`-over-`settled` only. Gate-over-gate is oldest-wins inside a Session and
first-in-`candidateOrder` across them. Any doc, comment, or test name that says "last
pause wins" about two open questions is wrong.

**A displaced question keeps waiting with no alert behind it.** Across Sessions, a
gate opening in a Session that ranks AHEAD of the armed one takes the slot even though
the question it displaces is older and still unanswered — and that user sees nothing
until the winner is resolved. That is the accepted price of one alert app-wide, and
the reason the alert body names the Session rather than the question. The in-app
affordances carry it: the "Waiting" pill in the session list and the rail's waiting
count, both cited by ADR 0038.

**A rapid series of `settled` pulses can still slide the deadline,** since `settled`
displaces `settled`. Accepted: it needs several Sessions finishing in succession,
where choosing any one of them is arbitrary anyway, and questions — the pauses that
genuinely block — cannot do it to each other.

**The ladder is reproducible from one snapshot.** Positional rank means no clock, no
arrival bookkeeping, and no ordering assumption about IPC, so all four clauses are
pinned by plain object literals: the four `R5 precedence` clauses
(`src/lib/attention.test.ts:736-852`), the mute regression (`:856-911`), and the
announced-pauses-are-a-set regression (`:915-1033`). Rust keeps one slot and no
Session vocabulary (ADR 0039), so re-ranking the ladder never moves the Supervisor.
