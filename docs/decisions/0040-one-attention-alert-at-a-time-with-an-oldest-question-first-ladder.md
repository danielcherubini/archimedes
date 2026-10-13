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

**AMENDED 2026-10-13 — one clause of the cross-Session rank, and nothing else.** This
ADR ranked subagents LAST in `candidateOrder`. A **Subagent session**'s gate is now
keyed to its **parent**: it rides in the parent's `waitingIds` array, and every parent
named by a live `SubagentEntry` joins `candidateOrder`, so the gate ranks wherever its
parent ranks (the `candidateOrder` build in the
`src/hooks/useAttentionAlert.ts` snapshot). The reason is *where the gate
is answered*, and the whole rule — including the composite `gateId` that makes the
re-key safe — is spelled out under *Amendment (2026-10-13)* at the end. Everything else
below stands unchanged: question-over-`settled` app-wide, positional rank, oldest-wins
within a Session, and the announced-pauses-are-a-SET fix. This ADR is NOT superseded.

The rule, as implemented in `attentionCandidates` and rule R5 (both in
`src/lib/attention.ts`), is a positional ladder evaluated over a LIST of candidates
rather than a timestamp, and the slot changes hands only for a higher-ranked pause:

- **a question outranks a finished run, app-wide** — every `waiting` candidate is
  listed before every `settled` one, the same precedence `sessionStatusOf` gives
  `waiting` over `running`, so an unanswered question displaces a running "finished"
  countdown and a `settled` pulse never displaces a live question;
- **among open questions the one that ranks FIRST holds the slot**, and rank is
  positional because there is no cross-Session arrival stamp: WITHIN a Session the
  ranking is `waitingIds` array order, i.e. arrival order, so the earliest-arrived
  still-open gate keeps the slot and a newer question there changes nothing; ACROSS
  Sessions `candidateOrder` decides (active Session first, then live main Sessions in
  store order, then the PARENT of every live `SubagentEntry` — the `push` dedupes, so a
  parent already listed from the session list is not listed twice: see the
  `candidateOrder` build in `src/hooks/useAttentionAlert.ts`). A **Subagent
  session**'s gate is never its own candidate: it is keyed to its parent and appended
  to the parent's `waitingIds` array, so it ranks AT THE PARENT'S RANK and a child id
  never enters this list at all (see *Amendment (2026-10-13)*);
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
count, both cited by ADR 0038, plus — since the 2026-10-13 amendment — the gate's OWN
card, which a **Subagent session**'s displaced pause now presents where the user is
already looking (its parent's transcript, or the overlay that covers every other
parent while the workspace view is mounted) instead of inside the child's sheet.

**A rapid series of `settled` pulses can still slide the deadline,** since `settled`
displaces `settled`. Accepted: it needs several Sessions finishing in succession,
where choosing any one of them is arbitrary anyway, and questions — the pauses that
genuinely block — cannot do it to each other.

**The ladder is reproducible from one snapshot.** Positional rank means no clock, no
arrival bookkeeping, and no ordering assumption about IPC, so all four clauses are
pinned by plain object literals: the four `R5 precedence` clauses
(`src/lib/attention.test.ts`: `attentionStep — R5 precedence: which pause holds the
single slot`), the mute regression (there: `attentionStep — R5: an announced pause
must not mute the pause underneath it`), and the announced-pauses-are-a-set regression
(there: `attentionStep — REGRESSION: one alert per pause, for EVERY pause`). Rust
keeps one slot and no Session vocabulary (ADR 0039), so re-ranking the ladder never
moves the Supervisor.

## Amendment (2026-10-13) — a Subagent session's gate rides at its PARENT's rank

**What changed is the ACROSS-Session clause only, and it changed because of where the
gate is answered.** A **Subagent session**'s `ask` and **Permission prompt** are answered
at the bottom of its **parent**'s transcript when the parent is the active Session
(`MessageList`'s child-gate block, the `childGates.filter(isInlineChildGate)` render,
fed by `useChildGates(activeSessionId)` in `src/components/ChatStream.tsx`), and
otherwise by the always-mounted `SubagentModals` host at the `App` root (whose
render-contract doc states the partition; mounted in `src/App.tsx`'s root JSX as a
sibling of the view ternary) — the two sites are mutually exclusive, partitioned on
"is this gate's parent the ACTIVE Session", and the child's `confirm`/`password` always
live in the overlay because they are Radix `Dialog`s. An
alert that ranked that pause behind every Session would therefore name a Session the
user is not being asked about, and would sit below pauses the user is being asked about.
So the pause is no longer the child's for ranking purposes: **a Subagent session's gate
is keyed to its PARENT's id and rides in the parent's `waitingIds` array, and every
parent named by a live `SubagentEntry` joins `candidateOrder` — including one that lives
only in `historySessions`.** Child ids enter neither list.

**The ordering, as shipped** (`src/hooks/useAttentionAlert.ts`'s snapshot).
`candidateOrder` is the active Session, then live MAIN Sessions in store order, then
the parent of every live `SubagentEntry`, deduped by the `push` helper; a child's id
never enters it. Within one parent's `waitingIds` array the fill is deliberately TWO
passes: every non-child Session's `requests` to completion, THEN its `prompts`, so a
parent's own `ask` and its own Permission prompt both outrank any of its children's
gates; then the child gates, in `childGatesOf` order
(`src/hooks/useChildGates.ts`), appended under their parent.
Across two children of one parent the rank is
therefore `(childStartedAt, request arrival)` — A asks t1, B asks t2, A asks t3 gives
`A:t1, B:t2, A:t3` — which IS the rule, not an approximation of wall-clock interleave,
because the stores hold no cross-child arrival stamp. Registering the parents explicitly
is not redundant with "live main Sessions": `historySessions` never enters
`candidateOrder`, and `attentionCandidates` visits ONLY the ids listed there (its first
loop over `next.candidateOrder`, `src/lib/attention.ts`), so a parent registered by
nothing would make
every child of a Session the user navigated away from — this feature's motivating case —
permanently unannounceable.

**The surprising half, which cannot be re-derived: a child's `gateId` is the COMPOSITE
`childSessionId:requestId`, never the bare `requestId`** (`childGateKey` in
`src/hooks/useChildGates.ts`, imported by the snapshot in
`src/hooks/useAttentionAlert.ts`). Trigger identity is
`(kind, sessionId, gateId)` (`sameAttentionTrigger`, over `AttentionTrigger`, in
`src/lib/attention.ts`), and once the sessionId half is the shared PARENT, the gate id
alone has to carry the distinction: some
OpenAI-compatible gateways index tool-call ids per response, so a `requestId` like
`call_0` RECURS (`AttentionTrigger`'s own doc comment — "Nothing here may assume a
gate id is globally unique"). With a bare `requestId`, two children of one parent
holding `call_0` collapse into ONE trigger, and after the first is announced `spent`
mutes the survivor FOREVER — R4 forgets a spent pause when the gate it names closes,
and it cannot tell the survivor from the one it saw. A parent's own gate keeps its
bare `requestId`, and the two shapes cannot collide — but state the reason the RIGHT
way round, since it is the
only defence against someone "simplifying" the composite away. It is NOT that a minted
session id contains a `:` (it does not: `mint_session_id` is `arch_<uuid v4>`,
`src-tauri/src/agent/types.rs`, pinned by the `mint_session_id_format` test in
`src-tauri/src/agent/session/mod.rs`), and NOT that a parent's own gate id
lacks one (it often has one: the sudo flow emits `{toolCallId}:confirm` /
`{toolCallId}:password` AS the `requestId`, both in the sudo prompt flow in
`src-tauri/src/agent/interactive/mod.rs`). The reason is the PREFIX: for
a parent's own gate id to read as a child's it would have to begin with a whole
`arch_<uuid v4>` child id followed by `:`, and a provider-minted tool-call id never
does. `gateId` is OPAQUE to the pure rule (equality and membership only), which is why
the whole re-key needed no change in `src/lib/attention.ts` at all.

**Three consequences of speaking of a child's pause as its parent's, all accepted.** A
STALLED parent disarms — and rule R5 immediately re-arms — a still-open child countdown,
and because R3's stall clause has no latch while the stall flag survives until a resume
or a close, that re-time happens on EVERY pass whose deps changed, not once: the parked
child's alert lands only after `delaySecs` of total dependency quiet, so unrelated churn
in other Sessions can starve it (pinned by `src/hooks/useAttentionAlert.test.ts`:
`re-times the SAME child countdown on EVERY pass while its parent stays stalled`). The
shape is reachable, not theoretical — `handle_crash` marks the crashed Session stalled
and runs the pending-modal cleanup for THAT session alone
(`src-tauri/src/agent/session/router.rs`: `handle_crash` →
`cleanup_pending_modals`), so a parent whose Worker crashed leaves its child's `ask`
open and announceable. And a child whose `SubagentEntry` disappears
stops being announced: the snapshot then keys its gate back to `waitingIds[childId]`, an
id absent from `candidateOrder`, so R3's membership arm disarms it — unchanged
behaviour, only a moved mechanism (note the asymmetry with `childGatesOf`, which DROPS
that gate instead: a card needs a parent transcript to sit in, while the alert can still
name an owner it cannot resolve). Third: because the gate is keyed to the parent, a
child's OWN `stalled` flag no longer reaches its gate's evidence at all (R3 reads the
parent's) — and the gap that opens is REAL, because the crash safety net a reader would
reach for does not fire for a **Subagent session**. `cleanup_pending_modals` starts
`live.get(session_id) else { return }` and the ONLY insert into `live` is on the
main-session start/resume path (`establish_worker_session` in
`src-tauri/src/agent/session/mod.rs`), so a child has no `live` entry to clean up.
Worse, the child's relayed modal ids are tracked under the DELIVERY id — the PARENT
(the pump's `delivery_id` in `src-tauri/src/agent/worker/manager.rs`, routed into
`route_event`) — so any close frame that IS emitted carries `sessionId = parent` and
reaches `App.tsx`'s `interactive-request-close` listener as
`removeRequest(parent, <the child's request id>)`, a no-op on the child's slice. That
mis-keying is a known upstream defect with a follow-up outstanding. What DOES exist
today: `SudoPromptCleanup` (`src-tauri/src/agent/interactive/sudo_exec.rs`), which
emits the close under the correct CHILD id but only for a DROPPED sudo flow (i.e. a
cancel) and only for `confirm` / `password`; and the child's `SubagentEntry`
disappearing (after `MAX_CLOSED_ENTRIES` evicts it). So **a crashed child's open
`ask` / Permission prompt is NOT auto-closed today** — the card stays on screen. What
resolves the DELEGATION is the Worker's exit itself (the drive task races
`handle.exited()` →
`Failed "subagent worker exited unexpectedly"`); what resolves a child merely PARKED
on an unanswered gate is the 30-minute bound (`DEFAULT_SUBAGENT_SETTLE_TIMEOUT` in
`src-tauri/src/agent/worker/manager.rs`), not a close frame. The JS-side rule therefore
carries the whole load: only the gate leaving `waitingIds` disarms the countdown, and a
child's own stall disarms nothing (pinned by the hook test named
`only the gate leaving waitingIds disarms it — the CHILD's own stall disarms
nothing`).
The rule's "a subagent
finishing is not the user's pause" skip survives for free and is now simply unreachable,
since no child id reaches `candidateOrder`
(`attentionCandidates`' `settledWatch` guard).

**What this does NOT touch:** the rest of the ladder — question-over-`settled` app-wide,
positional rank, oldest-wins within a Session, the announced-pauses-are-a-SET fix — and
`settledWatch`, which stays the live main Sessions (`settledWatch` in the hook's
snapshot) so a child finishing is still no pulse. Pinned by the
`a child's gate IS its parent's pause (the snapshot re-key)` describe in
`src/hooks/useAttentionAlert.test.ts`: two children on one recurring gateway id
are TWO
pauses (`treats two children holding the same gateway tool-call id as TWO pauses`), a
parent's own gates outrank its children's whichever store key was inserted first
(`orders a parent's own gates fully ahead of its children's, whichever store key was
inserted first`), a parent named only by `historySessions` is still
announceable (`announces a child of a parent that lives ONLY in historySessions (never
unannounceable)`), and a child's gate ranks at its PARENT's position (`ranks a child's
gate at its PARENT's position, not last`).
