import { basenameOfPath } from "./paths";
import type { StopReason } from "./tauri";

/**
 * Attention alerts (ADR 0038/0039) — the decision core, as pure functions.
 *
 * The split of responsibility is deliberate: the renderer DECIDES (it holds the
 * stores and is the only place DOM input exists) and Rust COUNTS (a webview
 * that is hidden or minimised is throttled, and a hidden window is this
 * feature's entire customer, so a renderer-side `setTimeout` is a notification
 * feature that does not notify exactly when it matters). What crosses IPC is
 * therefore two commands — arm with a delay and some text, or disarm — and this
 * module is everything that decides which of the two to send.
 *
 * Like `sessionStatusOf`, every rule lives here rather than in the hook, so the
 * hook and the tests read one copy of the truth. No React, no zustand, no IPC:
 * the clock and the enabled flag are handed in, which is what makes the whole
 * feature testable without a webview.
 */

/** Which kind of pause the user is being held on. */
export type AttentionKind = "settled" | "waiting";

/**
 * One pause on the user. Note the asymmetry, which is the whole design:
 *
 * - **`waiting` is a STATE**, so it carries the gate's identity. A second
 *   question from the same Session is a different trigger and re-arms.
 * - **`settled` is a PULSE** — it exists only on the snapshot where `inTurn`
 *   fell — so it carries no per-occurrence identity, and the memory's `spent`
 *   entry has to be FORGOTTEN when that pause ends (rule R4) rather than
 *   remembered forever.
 *
 * A gate id is the interactive `requestId`, which on the native path IS the
 * model's tool-call id (`ask_flow(…, &tc.id, …)`; the sudo flow derives
 * `{toolCallId}:confirm` / `:password`). Some OpenAI-compatible gateways index
 * tool-call ids per response (`call_0`, `call_1`), so an id CAN recur across
 * turns — harmless only because R4 forgets a spent pause when its gate closes.
 * Nothing here may assume a gate id is globally unique.
 */
export type AttentionTrigger =
  /** The gate's identity is part of the trigger: a new question from the same
   * session is a new trigger (and re-arms). A subagent's gate is keyed to its
   * PARENT — `sessionId` is the parent's id and `gateId` the composite
   * `childSessionId:requestId` (`childGateKey`) — so the PARENT's evidence is
   * what disarms the alert, and the parent's own gates stay distinguishable from
   * them by that prefix (ADR 0040, amended 2026-10-13). */
  | { kind: "waiting"; sessionId: string; gateId: string }
  | { kind: "settled"; sessionId: string };

/** Identity, not equality-by-reference: `armed`/`spent` are rebuilt constantly. */
export function sameAttentionTrigger(
  a: AttentionTrigger | null,
  b: AttentionTrigger | null,
): boolean {
  if (a === null || b === null) return a === null && b === null;
  if (a.kind !== b.kind || a.sessionId !== b.sessionId) return false;
  return a.kind === "waiting" ? b.kind === "waiting" && a.gateId === b.gateId : true;
}

/**
 * Everything the rule reads, built by the hook OUTSIDE any zustand selector
 * (a selector that assembles a fresh object re-renders forever). The hook owns
 * the candidate ORDER; this module only ever reads that order, so the rule stays
 * independent of how the stores are shaped.
 */
export interface AttentionSnapshot {
  /** Deterministic candidate order: active session first, then live MAIN
   * sessions in store order, then the PARENT of every live `SubagentEntry`
   * (deduped) — a child's id never appears here (ADR 0040, amended 2026-10-13). */
  candidateOrder: string[];
  /** Live main session ids ONLY (a subagent finishing is not the user's pause —
   * its parent is still in turn). ALSO the liveness test for a settled trigger:
   * a PAUSED session leaves this list, and its "finished" alert goes with it. */
  settledWatch: string[];
  inTurn: Record<string, boolean>;
  /** From `useSessions.stopReasons` — a `cancelled` turn never "finished". */
  stopReasons: Record<string, StopReason | undefined>;
  /** id → EVERY pending gate id for that session (`InteractiveRequestData.requestId`
   * for `ask`/`confirm`/`password`, then `PermissionPromptData.requestId`; under a
   * PARENT's id also the composite `childGateKey` ids of its children's gates).
   * Non-empty = that session is waiting. EVERY entry is a candidate, in array
   * order (a second question is a second pause); membership (not position) is the
   * evidence an armed countdown stands on. */
  waitingIds: Record<string, string[]>;
  /** id → true when STALLED (ADR 0025) — never "settled". */
  stalled: Record<string, boolean>;
}

/**
 * What the renderer remembers about countdowns Rust never reports back from —
 * the protocol is one-way, so this little struct is the only record that an
 * alert was asked for, fired, and is done. Held in a ref by the hook; never a
 * module singleton (a second webview would inherit the first's memory).
 */
export interface AttentionMemory {
  /** What the renderer last asked Rust to count (`null` = nothing armed). */
  armed: AttentionTrigger | null;
  /** The monotonic instant (`performance.now()`) at which the armed countdown is
   * over, so the renderer can retire its own memory of a countdown Rust never
   * reports back from. Captured AT ARM TIME from the delay in force then — a
   * later settings change must not re-time a running countdown. `null` when
   * unarmed. */
  armedExpiresAt: number | null;
  /** The pauses that have ALREADY been announced — ADR 0038's one-shot, and a
   * SET, because a snapshot can owe several pauses at once (every open gate, and
   * `loop.rs` runs tool calls in parallel so two `ask`s really can be open) and
   * several more can be announced while an earlier one is still held. Each entry
   * is forgotten by rule R4 under its OWN `pauseOver`, never as a group.
   *
   * A single slot here was a real defect: R2, the activity path and R3 all
   * WROTE this field, so announcing the second pause erased the record of the
   * first, the still-open pause underneath it stopped being muted, and it armed
   * again — a second (then third, then a storm of) OS notification for a pause
   * the user had already been told about. Empty array = nothing announced.
   * Immutable by convention like the rest of the struct: never mutated in place. */
  spent: AttentionTrigger[];
}

export interface AttentionOptions {
  enabled: boolean;
  /** **Monotonic** (`performance.now()`), injected so the step stays pure.
   * Never `Date.now()`: a wall-clock step (suspend/resume, NTP correction)
   * would retire the memory while Rust's monotonic countdown is still live,
   * and an armed countdown can then no longer be disarmed by activity. */
  now: number;
  delaySecs: number;
}

/** The ONE command a pass may send. `arm` subsumes `disarm` because Rust holds a
 * single pending countdown and replacing it is what arming already does. */
export type AttentionEffect =
  | { type: "arm"; trigger: AttentionTrigger }
  | { type: "disarm" }
  | { type: "none" };

/**
 * Every pause the user is owed on THIS snapshot, in strict precedence order.
 *
 * A LIST and not a single head, and that is the whole point: the head can be a
 * pause that was already announced (`spent`), and it must not swallow the pause
 * underneath it. A single head used to be compared against `spent`, so one
 * already-answered-but-still-open question — `ask`/`confirm`/`password` gates
 * have NO timeout, so that is a steady state — vetoed every later pause in every
 * other Session, and because a `settled` pulse exists on exactly one snapshot and
 * is never re-delivered, those alerts were lost for good. Rule R5 therefore
 * filters this list and takes the first entry it does not already owe.
 *
 * Order, which R5 relies on and the tests pin:
 * 1. **every pending gate**, in `next.candidateOrder`, and within one session in
 *    `next.waitingIds[id]` array order — `waiting` outranks `settled` app-wide
 *    (the same precedence `sessionStatusOf` gives waiting over running: a session
 *    holding a gate is blocked on the user RIGHT NOW), and a SECOND question from
 *    the same Session is a different pause that ranks right after the first;
 * 2. **then every `settled` pulse** — a TRANSITION, so each needs a `prev` to
 *    have fallen from, with the guards below.
 */
export function attentionCandidates(
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
): AttentionTrigger[] {
  const candidates: AttentionTrigger[] = [];

  // 1. Waiting is a state, and every open gate is a pause the user owes.
  for (const id of next.candidateOrder) {
    for (const gateId of next.waitingIds[id] ?? []) {
      candidates.push({ kind: "waiting", sessionId: id, gateId });
    }
  }

  // 2. Settled is a TRANSITION, so it needs a `prev` to have fallen from. Without
  //    the `prev === null` guard, every already-idle session would announce
  //    itself the moment the app mounted.
  if (prev === null) return candidates;
  const live = new Set(next.settledWatch);
  for (const id of next.candidateOrder) {
    // A subagent finishing is not the user's pause — its parent is still in turn.
    if (!live.has(id)) continue;
    if (
      prev.inTurn[id] === true &&
      next.inTurn[id] === false &&
      // A STALLED session must never announce itself as finished, and a run the
      // user Stop-ed did not "finish". The `stopReasons` guard is the one that
      // catches a crash: `handle_crash` resolves the turn with `Cancelled`
      // BEFORE the `session-stalled` flag arrives, so on the pulse snapshot the
      // stall flag has often not landed yet.
      next.stalled[id] !== true &&
      next.stopReasons[id] !== "cancelled"
    ) {
      candidates.push({ kind: "settled", sessionId: id });
    }
  }

  return candidates;
}

/**
 * Add an announced pause to the set, deduped by trigger identity. Returns the
 * SAME array when the entry is already there, and never mutates the one it was
 * handed (`AttentionMemory` is immutable by convention; a test asserts the input
 * memory survives a pass untouched).
 */
function announceSpent(
  spent: AttentionTrigger[],
  trigger: AttentionTrigger,
): AttentionTrigger[] {
  return spent.some((s) => sameAttentionTrigger(s, trigger)) ? spent : [...spent, trigger];
}

/** Has the pause this trigger names stopped being a pause the user owes? */
function pauseOver(trigger: AttentionTrigger, next: AttentionSnapshot): boolean {
  if (trigger.kind === "settled") {
    // A new turn began, or the session is gone (paused/closed).
    return (
      next.inTurn[trigger.sessionId] === true ||
      !next.settledWatch.includes(trigger.sessionId)
    );
  }
  return !(next.waitingIds[trigger.sessionId] ?? []).includes(trigger.gateId);
}

/**
 * The whole rule, in one pure pass over one snapshot.
 *
 * **The order and the fall-through are both load-bearing.** R2/R3/R4 only
 * change memory, so they mutate the working copy, remember any command they
 * owe, and KEEP GOING; only R1, R5 and R6 return. That matters because the
 * snapshot that retires or disarms an old countdown is frequently the same one
 * carrying a brand-new pulse, and a settled pulse is never re-delivered — a
 * rule that returned after touching memory would silently drop that pause for
 * good. At most one command leaves the hook per pass, and since `arm` replaces
 * Rust's single pending countdown, an owed `disarm` is subsumed by an `arm`.
 */
export function attentionStep(
  memory: AttentionMemory,
  prev: AttentionSnapshot | null,
  next: AttentionSnapshot,
  opts: AttentionOptions,
): { effect: AttentionEffect; memory: AttentionMemory } {
  let { armed, armedExpiresAt, spent } = memory;
  let owesDisarm = false;

  // R1 — switched off (returns). Rust must not be left counting, but `spent`
  // survives: flipping the setting off and back on must not re-alert a pause
  // that already alerted. R4 owns that entry's lifetime, not this rule.
  if (!opts.enabled) {
    if (armed !== null) owesDisarm = true;
    return {
      effect: owesDisarm ? { type: "disarm" } : { type: "none" },
      memory: { armed: null, armedExpiresAt: null, spent },
    };
  }

  // R2 — retire an elapsed countdown (FALLS THROUGH). Rust never reports back,
  // so the renderer retires its own memory — LAZILY, on the first snapshot at or
  // after the deadline, because the hook owns no timer (Rust owns the clock).
  // NO command is owed: that countdown is over, there is nothing to cancel.
  // ADD to the announced set, never replace it: this pause joins the ones
  // already announced, and every entry there keeps muting its own pause.
  if (armed !== null && opts.now >= (armedExpiresAt ?? opts.now)) {
    spent = announceSpent(spent, armed);
    armed = null;
    armedExpiresAt = null;
  }

  // R3 — evidence disarm (FALLS THROUGH). An armed countdown stands until its
  // EVIDENCE goes away: never merely because this snapshot has no candidate.
  if (armed !== null) {
    const id = armed.sessionId;
    const evidenceGone =
      // The crash that raced the trigger (see the `stopReasons` guard above).
      // Kind-agnostic on purpose: a stalled Session holding an UNANSWERED gate is
      // still waiting on the user, so R5 re-arms that gate on this same pass and
      // the owed disarm never reaches Rust (`attention.test.ts`:
      // "re-arms the SAME open gate when a stall lands on an armed question (the
      // stall-disarm is self-cancelling)"). What is NOT true is that this costs ONE
      // re-time: there is no latch, this clause is re-tested on every pass, and
      // Rust clears the stall flag only on a resume or a close — so while it
      // holds, every pass whose deps changed re-arms the same trigger and moves
      // Rust's deadline a full `delaySecs` from then. The honest cost is "the
      // alert lands after `delaySecs` of total dependency quiet", pinned at
      // `useAttentionAlert.test.ts` (`re-times the SAME child countdown on EVERY
      // pass …`), where a child's gate under a stalled PARENT is the shape that
      // makes that starvation user-visible.
      next.stalled[id] === true ||
      // A new turn started in THAT session — "finished" would be a lie. Scoped
      // to the armed session on purpose: a turn elsewhere does not make this
      // session's finished alert false.
      (armed.kind === "settled" && next.inTurn[id] === true) ||
      // The session was paused or closed. `handleSessionClosed` keeps
      // `activeSessionId`, so `candidateOrder` alone would not notice.
      (armed.kind === "settled" && !next.settledWatch.includes(id)) ||
      // That exact gate closed, timed out, or was replaced. MEMBERSHIP, not
      // position: a re-delivered frame re-appends the array and must not look
      // like a close.
      (armed.kind === "waiting" && !(next.waitingIds[id] ?? []).includes(armed.gateId)) ||
      // A subagent entry that has gone away entirely.
      !next.candidateOrder.includes(id);
    if (evidenceGone) {
      const disarmed = armed;
      owesDisarm = true;
      armed = null;
      armedExpiresAt = null;
      // Drop ONLY this trigger from the announced set. Under the invariant R5
      // maintains — it arms only a candidate that is not already announced — the
      // armed trigger is never a member of `spent`, so on every reachable pass
      // this filter changes nothing. It is spelled out anyway so the rule states
      // the invariant it leans on, and so the SHAPE of the operation is the right
      // one: an announced pause is forgotten by R4, under its OWN `pauseOver`,
      // never as a group. Clearing the whole set here — which is what the single
      // slot's `spent = null` did — is the defect this field now exists to
      // prevent: it un-mutes other pauses that are still open and were already
      // announced.
      spent = spent.filter((s) => !sameAttentionTrigger(s, disarmed));
    }
  }

  // R4 — forget a spent pause once that pause has ended (FALLS THROUGH). No
  // command: the countdown already happened. This is what lets a session's
  // SECOND run alert again — a settled trigger carries no per-occurrence
  // identity, so without it the one-shot would silence every later run of that
  // session for the whole app lifetime. It is also what makes a recycled
  // provider tool-call id harmless. Per ENTRY: each announced pause is judged on
  // its own evidence, so forgetting one never un-mutes another — and that is
  // exactly why this rule is NOT gated on `armed === null` any more. It used to
  // be ("leave everything else behaviourally identical while a countdown runs"),
  // and that was a lost alert: an entry's `pauseOver` is about ITS OWN pause, so
  // a live countdown in another Session has no claim on it. With the guard, a
  // spent `settled:A` survived for as long as ANY countdown was armed — which is
  // most of the time, since a gate has no timeout — so when A's pulse landed it
  // was still filtered as announced, and a pulse is never re-delivered. Pruning
  // emits no command at all, so a pass whose only news is a forgotten entry
  // cannot disturb the countdown that is actually running: the guard bought
  // nothing and cost an alert.
  if (spent.length > 0) {
    const stillAnnounced = spent.filter((s) => !pauseOver(s, next));
    if (stillAnnounced.length !== spent.length) spent = stillAnnounced;
  }

  // R5 — arm (returns). The FIRST candidate the user is not already owed — that
  // is, the first one that is neither the live countdown nor an
  // already-announced pause — gets the countdown. Filtering the LIST rather than
  // testing a single head is load-bearing: the head may be a pause that already
  // alerted, and it must not mute the pause below it (see `attentionCandidates`).
  //
  // This one rule is also the SUPERSEDE, and its real precedence is narrower than
  // "last pause wins". R5 takes the HEAD of a list ordered positionally
  // (`candidateOrder`, then each session's `waitingIds` array = arrival order),
  // so the slot changes hands only when a HIGHER-ranked pause appears:
  //
  // - an unanswered question outranks a finished run, app-wide (`waiting` is
  //   listed before every `settled`);
  // - among open questions the one that RANKS FIRST holds the slot, and rank is
  //   POSITIONAL, never a timestamp (there is no cross-Session arrival stamp).
  //   WITHIN a Session the ranking is arrival order, so the earliest-arrived gate
  //   holds the slot and a newer question there ranks behind the armed one,
  //   equals `armed`, and changes nothing. ACROSS Sessions `candidateOrder`
  //   decides, so a gate opening in a Session that ranks ahead of the armed one
  //   — switching to it puts it FIRST — does take the slot, even though the
  //   question it displaces is older and still unanswered. That displaced
  //   question keeps waiting on screen with no alert behind it, which is the
  //   accepted price of one alert app-wide (and why the alert names the Session,
  //   not the question);
  // - a `settled` pulse therefore never displaces a live question;
  // - a `settled` countdown IS displaced — by a question opening over it, and by
  //   a later-arriving `settled` pulse of another Session that ranks ahead.
  //
  // So "the alert names the most recent pause" holds only settled-over-settled
  // and gate-over-settled; gate-over-gate is oldest-wins inside a Session and
  // first-in-`candidateOrder` across Sessions.
  const target = attentionCandidates(prev, next).find(
    (c) => !spent.some((s) => sameAttentionTrigger(s, c)),
  );
  if (target !== undefined && !sameAttentionTrigger(target, armed)) {
    return {
      effect: { type: "arm", trigger: target },
      // The delay is captured here, at arm time: changing the setting must not
      // re-time a countdown already running in Rust.
      memory: {
        armed: target,
        armedExpiresAt: opts.now + opts.delaySecs * 1000,
        spent,
      },
    };
  }

  // R6 — nothing to do (returns). The LATCH lives here: an armed, evidenced
  // countdown with no candidate reaches this line and sends NOTHING. Neither a
  // disarm (the settled pulse is one snapshot wide, so an absent candidate is
  // the normal state of a live countdown) nor a re-arm (that would restart
  // Rust's clock on every store write, and the alert would never arrive).
  return {
    effect: owesDisarm ? { type: "disarm" } : { type: "none" },
    memory: { armed, armedExpiresAt, spent },
  };
}

/**
 * The activity path (keydown / pointerdown / wheel), pure so its cost rule is
 * testable: Rust never learns about input unless a countdown is actually
 * running, so idle typing crosses no IPC (ADR 0039).
 *
 * The disarmed pause JOINS the announced set rather than left armed, so typing
 * without answering does not re-alert it, and the pauses announced before it
 * stay announced (assigning here instead of adding was the same overwrite bug as
 * R2). R4, or the next evidence-driven disarm, forgets an entry when ITS OWN
 * pause ends.
 */
export function attentionActivityStep(memory: AttentionMemory): {
  effect: AttentionEffect;
  memory: AttentionMemory;
} {
  if (memory.armed === null) return { effect: { type: "none" }, memory };
  return {
    effect: { type: "disarm" },
    memory: {
      armed: null,
      armedExpiresAt: null,
      spent: announceSpent(memory.spent, memory.armed),
    },
  };
}

/** The app name every alert carries — the OS shows it as the source. */
export const ATTENTION_TITLE = "Archimedes";

export interface AttentionLabelContext {
  /** Live sessions first, then history: the first `sessionId` match wins. */
  sessions: { sessionId: string; cwd: string; title?: string | null }[];
  /** Subagent id → parent id (`SubagentEntry.parentSessionId`). */
  parents: Record<string, string>;
}

/**
 * The alert's text. Rust owns no session vocabulary (ADR 0039), so the renderer
 * composes the sentence here — which also means the notification names the
 * SESSION, and a subagent's gate names the parent the user is actually waiting
 * on, not a child id they have never seen.
 */
export function attentionAlertText(
  trigger: AttentionTrigger,
  ctx: AttentionLabelContext,
): { title: string; body: string } {
  const id = ctx.parents[trigger.sessionId] ?? trigger.sessionId;
  const row = ctx.sessions.find((s) => s.sessionId === id);
  // `||`, not `??`: `basenameOfPath` returns an empty string for empty input or
  // a bare root like `/`, and an empty string is not null — a `??` chain would
  // hand the OS an unnamed alert instead of reaching the fallback.
  const label = row?.title?.trim() || (row ? basenameOfPath(row.cwd) : "") || "A session";
  return {
    title: ATTENTION_TITLE,
    body:
      trigger.kind === "waiting"
        ? `${label} needs your answer`
        : `${label} finished — waiting for you`,
  };
}
