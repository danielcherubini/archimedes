import { describe, expect, it } from "vitest";
import {
  ATTENTION_TITLE,
  attentionActivityStep,
  attentionAlertText,
  attentionCandidates,
  attentionStep,
  sameAttentionTrigger,
  type AttentionMemory,
  type AttentionOptions,
  type AttentionSnapshot,
  type AttentionTrigger,
} from "./attention";

/**
 * The attention rule, as a specification. Each `it` is one rule, or one of the
 * defects this rule was redesigned to eliminate — the self-disarming latch, the
 * once-per-Session silencing, the single announced-pause slot that let a pause
 * alert twice, and the announced pause that muted every pause underneath it —
 * so the feature can be learned from this file and a future edit can see which
 * piece of reasoning it would break. The SUPERSEDE is deliberately NOT on that
 * list: displacing a countdown is designed behaviour now, and what its real
 * precedence IS (a positional ladder, not "last pause wins") is pinned by the
 * R5 precedence block below. ADR 0038/0039; plan rules 1-5.
 */

// ---------------------------------------------------------------- fixtures

/** The monotonic instant these tests pretend is "now". Nothing here reads
 * `Date.now()` — the step is handed the clock (see `AttentionOptions`). */
const NOW = 100_000;
const DELAY = 15;
/** The armed deadline is `NOW + DELAY * 1000`; these straddle it. */
const BEFORE = NOW + DELAY * 1000 - 1000;
const AFTER = NOW + DELAY * 1000 + 1;

const settled = (sessionId: string): AttentionTrigger => ({ kind: "settled", sessionId });
const waiting = (sessionId: string, gateId: string): AttentionTrigger => ({
  kind: "waiting",
  sessionId,
  gateId,
});

const snap = (over: Partial<AttentionSnapshot> = {}): AttentionSnapshot => ({
  candidateOrder: [],
  settledWatch: [],
  inTurn: {},
  stopReasons: {},
  waitingIds: {},
  stalled: {},
  ...over,
});

const mem = (over: Partial<AttentionMemory> = {}): AttentionMemory => ({
  armed: null,
  armedExpiresAt: null,
  spent: [],
  ...over,
});

const opts = (over: Partial<AttentionOptions> = {}): AttentionOptions => ({
  enabled: true,
  now: NOW,
  delaySecs: DELAY,
  ...over,
});

/** One main session, live, MID-turn. */
const running = (id: string) =>
  snap({ candidateOrder: [id], settledWatch: [id], inTurn: { [id]: true } });
/** The same session one snapshot later: its turn has FALLEN. */
const fallen = (id: string) =>
  snap({
    candidateOrder: [id],
    settledWatch: [id],
    inTurn: { [id]: false },
    stopReasons: { [id]: "end_turn" },
  });

// ================================================================ trigger id

describe("sameAttentionTrigger", () => {
  it("is true for the same kind, session and gate", () => {
    expect(sameAttentionTrigger(waiting("A", "g1"), waiting("A", "g1"))).toBe(true);
    expect(sameAttentionTrigger(settled("A"), settled("A"))).toBe(true);
  });

  it("calls a different gate from the same session a DIFFERENT trigger", () => {
    // A second question is a new pause, so it must re-arm.
    expect(sameAttentionTrigger(waiting("A", "g1"), waiting("A", "g2"))).toBe(false);
  });

  it("separates settled from waiting, and never conflates null with a trigger", () => {
    expect(sameAttentionTrigger(settled("A"), waiting("A", "g1"))).toBe(false);
    expect(sameAttentionTrigger(null, null)).toBe(true);
    expect(sameAttentionTrigger(settled("A"), null)).toBe(false);
    expect(sameAttentionTrigger(null, settled("A"))).toBe(false);
  });
});

// ============================================ which pauses are owed, in order

describe("attentionCandidates", () => {
  // Asserted as the ORDERED LIST, not as a head: precedence (every gate before
  // every pulse) and the per-session gate order are both part of the contract,
  // because R5 walks the list for the first pause it does not already owe.
  it("names a settled session when its turn fell with nothing waiting", () => {
    expect(attentionCandidates(running("A"), fallen("A"))).toEqual([settled("A")]);
  });

  it("is a TRANSITION: no fall (false to false) is no candidate", () => {
    // Otherwise every idle session would announce itself on every store write.
    expect(attentionCandidates(fallen("A"), fallen("A"))).toEqual([]);
    expect(attentionCandidates(running("A"), running("A"))).toEqual([]);
  });

  it("never fires on the first snapshot (prev null has no before to fall from)", () => {
    // The mount case: sessions that settled long ago must not all ring.
    expect(attentionCandidates(null, fallen("A"))).toEqual([]);
  });

  it("lists EVERY pending gate of a session, in array order", () => {
    // A second question from the same Session is a SECOND pause the user owes,
    // so it has to be a candidate — ranked after the first, never hidden behind it.
    const next = snap({
      candidateOrder: ["A"],
      settledWatch: ["A"],
      waitingIds: { A: ["g2", "g1"] },
    });
    expect(attentionCandidates(running("A"), next)).toEqual([
      waiting("A", "g2"),
      waiting("A", "g1"),
    ]);
  });

  it("puts EVERY waiting candidate before EVERY settled one within one snapshot", () => {
    // A is falling while B and C hold gates: the gates are the more urgent
    // pauses — the same precedence `sessionStatusOf` gives waiting over running.
    const prev = snap({
      candidateOrder: ["A", "B", "C"],
      settledWatch: ["A", "B", "C"],
      inTurn: { A: true, B: false, C: false },
    });
    const next = snap({
      candidateOrder: ["A", "B", "C"],
      settledWatch: ["A", "B", "C"],
      inTurn: { A: false, B: false, C: false },
      stopReasons: { A: "end_turn" },
      waitingIds: { B: ["g9", "g8"], C: ["g7"] },
    });
    expect(attentionCandidates(prev, next)).toEqual([
      waiting("B", "g9"),
      waiting("B", "g8"),
      waiting("C", "g7"),
      settled("A"),
    ]);
  });

  it("never calls a STALLED session finished (that fall is a crash, not a finish)", () => {
    const stalledA = snap({ ...fallen("A"), stalled: { A: true } });
    expect(attentionCandidates(running("A"), stalledA)).toEqual([]);
  });

  it("never calls a CANCELLED run finished (a user Stop is not a finish)", () => {
    // This guard also catches the crash whose `session-stalled` has not landed
    // yet: `handle_crash` resolves with Cancelled BEFORE the stall flag arrives.
    expect(
      attentionCandidates(running("A"), snap({ ...fallen("A"), stopReasons: { A: "cancelled" } })),
    ).toEqual([]);
  });

  it("carries the SUBAGENT's own id when a subagent holds the gate", () => {
    // The subagent id is what the evidence rule later looks for: the alert is
    // disarmed when THAT gate closes, not when the parent's turn does.
    const next = snap({
      candidateOrder: ["A", "sub1"],
      settledWatch: ["A"],
      waitingIds: { sub1: ["g"] },
    });
    expect(attentionCandidates(running("A"), next)).toEqual([waiting("sub1", "g")]);
  });

  it("never settles a subagent (absent from settledWatch: its parent is still in turn)", () => {
    const prev = snap({
      candidateOrder: ["A", "sub1"],
      settledWatch: ["A"],
      inTurn: { A: true, sub1: true },
    });
    const next = snap({
      candidateOrder: ["A", "sub1"],
      settledWatch: ["A"],
      inTurn: { A: true, sub1: false },
      stopReasons: { sub1: "end_turn" },
    });
    expect(attentionCandidates(prev, next)).toEqual([]);
  });

  it("follows the candidate order: active first, live sessions before subagents", () => {
    const prev = snap({
      candidateOrder: ["B", "A"],
      settledWatch: ["B", "A"],
      inTurn: { B: true, A: true },
    });
    const next = snap({
      candidateOrder: ["B", "A"],
      settledWatch: ["B", "A"],
      inTurn: { B: false, A: false },
      stopReasons: { B: "end_turn", A: "end_turn" },
    });
    // Both pulses are owed, and the order says which one R5 arms (the others are
    // the fallbacks it reaches only if the front one is already spent).
    expect(attentionCandidates(prev, next)).toEqual([settled("B"), settled("A")]);

    const gated = snap({
      candidateOrder: ["sub1", "A"],
      settledWatch: ["A"],
      waitingIds: { sub1: ["gs"], A: ["ga"] },
    });
    expect(attentionCandidates(null, gated)).toEqual([waiting("sub1", "gs"), waiting("A", "ga")]);
  });
});

// ===================================================== R1: the master switch

describe("attentionStep — R1 disabled", () => {
  it("disarms an armed countdown and KEEPS announced pauses (off/on must not re-alert)", () => {
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: BEFORE, spent: [waiting("Z", "g9")] }),
      null,
      fallen("A"),
      opts({ enabled: false }),
    );
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual({ armed: null, armedExpiresAt: null, spent: [waiting("Z", "g9")] });
  });

  it("does nothing when disabled and nothing was armed", () => {
    const { effect, memory } = attentionStep(mem(), running("A"), fallen("A"), opts({
      enabled: false,
    }));
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual(mem());
  });
});

// ============================================ R2: retire an elapsed countdown

describe("attentionStep — R2 retire an elapsed countdown", () => {
  it("retires it: armed becomes null, spent GAINS the trigger, NO command is owed", () => {
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: NOW - 1 }),
      fallen("A"),
      fallen("A"),
      opts(),
    );
    // Nothing to cancel in Rust — that countdown is over, it already fired.
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual({ armed: null, armedExpiresAt: null, spent: [settled("A")] });
  });

  it("leaves a live countdown alone and marks nothing spent", () => {
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: NOW + 1 }),
      fallen("A"),
      fallen("A"),
      opts(),
    );
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual({ armed: settled("A"), armedExpiresAt: NOW + 1, spent: [] });
  });

  it("FALLS THROUGH: a retiring snapshot that also carries a new pulse still ARMS it", () => {
    // REGRESSION. If R2 returned here, B's pause would be lost forever: the
    // snapshot that retires A's countdown is often the one carrying B's pulse,
    // and a settled pulse is never re-delivered.
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: true },
    });
    const next = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: false },
      stopReasons: { B: "end_turn" },
    });
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: NOW - 1 }),
      prev,
      next,
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: settled("B") });
    expect(memory).toEqual({
      armed: settled("B"),
      armedExpiresAt: NOW + DELAY * 1000,
      spent: [settled("A")],
    });
  });
});

// ============================================== R3: disarm on lost evidence

describe("attentionStep — R3 evidence disarm", () => {
  const armedSettledA = mem({ armed: settled("A"), armedExpiresAt: BEFORE });

  it("disarms when the stall lands AFTER the countdown was armed", () => {
    const { effect, memory } = attentionStep(
      armedSettledA,
      fallen("A"),
      snap({ ...fallen("A"), stalled: { A: true } }),
      opts(),
    );
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual(mem());
  });

  it("re-arms the SAME open gate when a stall lands on an armed question (the stall-disarm is self-cancelling)", () => {
    // R3's stall clause is kind-agnostic, so a stall nulls an armed `waiting`
    // trigger and owes a disarm. But `attentionCandidates` guards ONLY the
    // `settled` branch on `stalled` — an open gate is still a candidate — so R5,
    // on the SAME pass (R3 falls through on purpose), finds that gate again and
    // arms it. One command leaves the hook and it is the `arm`: the stall's
    // disarm never reaches Rust, and the countdown is re-timed once.
    //
    // That is the RIGHT end state, not a hole in R3. A stalled Session with an
    // unanswered question is still a Session waiting on the user: the question is
    // on screen and unanswered, and the stall banner sits beside it rather than
    // replacing it — `markStalled` dismisses no gate, and even Rust's crash
    // cleanup cannot dismiss a Permission prompt from the renderer's `prompts`
    // map (its `interactive-request-close` frames are routed to the interactive
    // store alone). So the alert stays owed, and muting it would be the
    // self-disarming latch this rule was rewritten to remove. The only cost is
    // the one re-time, and a Session stalls once — the flag is cleared only by a
    // resume or a close — so it cannot re-time into a storm.
    const prev = snap({
      candidateOrder: ["A"],
      settledWatch: ["A"],
      inTurn: { A: true },
      waitingIds: { A: ["g1"] },
    });
    // The crash's own frame sequence: `handle_crash` resolves the turn with
    // `Cancelled`, then the stall flag lands. Neither makes the gate go away.
    const stalled = snap({
      candidateOrder: ["A"],
      settledWatch: ["A"],
      inTurn: { A: false },
      stopReasons: { A: "cancelled" },
      waitingIds: { A: ["g1"] },
      stalled: { A: true },
    });

    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      prev,
      stalled,
      opts(),
    );

    // ONE effect, and it is the arm, not the disarm R3 thought it owed.
    expect(effect).toEqual({ type: "arm", trigger: waiting("A", "g1") });
    // Still armed on the SAME gate, re-timed from `now` — the whole price.
    expect(memory).toEqual({
      armed: waiting("A", "g1"),
      armedExpiresAt: NOW + DELAY * 1000,
      spent: [],
    });
  });

  it("disarms when a NEW TURN starts in the armed session (a finished alert would be a lie)", () => {
    const { effect, memory } = attentionStep(
      armedSettledA,
      fallen("A"),
      snap({ ...running("A"), stopReasons: { A: "end_turn" } }),
      opts(),
    );
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual(mem());
  });

  it("disarms when the armed session is PAUSED (it leaves settledWatch while candidateOrder keeps it)", () => {
    // `handleSessionClosed` keeps `activeSessionId`, so the id stays a
    // candidate: only `settledWatch` says the session is gone.
    const { effect, memory } = attentionStep(
      armedSettledA,
      fallen("A"),
      snap({ candidateOrder: ["A"], settledWatch: [], inTurn: { A: false } }),
      opts(),
    );
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual(mem());
  });

  it("disarms when a session's last gate closes, taking the armed id with it", () => {
    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: ["g1"] } }),
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: [] } }),
      opts(),
    );
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual(mem());
  });

  it("disarms when the armed id is replaced while another session stays gate-free", () => {
    // The armed gate is gone from `waitingIds[A]` — timed out or answered — and
    // nothing else is paused on the user, so the only command is the disarm.
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      waitingIds: { A: ["g1"] },
    });
    const { effect } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      prev,
      snap({ ...prev, waitingIds: {} }),
      opts(),
    );
    expect(effect).toEqual({ type: "disarm" });
  });

  it("disarms when the session has gone away entirely (absent from candidateOrder)", () => {
    const { effect } = attentionStep(
      mem({ armed: waiting("sub1", "g"), armedExpiresAt: BEFORE }),
      snap({ candidateOrder: ["sub1"], waitingIds: { sub1: ["g"] } }),
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { sub1: ["g"] } }),
      opts(),
    );
    expect(effect).toEqual({ type: "disarm" });
  });

  it("does NOT disarm a re-delivered gate frame that re-appends the array", () => {
    // Membership, not position: the armed id is still in the list, so the gate
    // is still open and the countdown stands, deadline untouched.
    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      snap({ ...running("A"), waitingIds: { A: ["g1"] } }),
      snap({ ...running("A"), waitingIds: { A: ["g1", "g2"] } }),
      opts(),
    );
    expect(effect).toEqual({ type: "none" });
    expect(memory.armed).toEqual(waiting("A", "g1"));
    expect(memory.armedExpiresAt).toBe(BEFORE);
  });

  it("treats an armed id pushed off the front as STILL OPEN (evidence holds; it is superseded, not closed)", () => {
    // The array order is not the evidence — but the candidate list IS built in
    // that order, so whichever gate sits at the head holds the slot and takes the
    // countdown over (precedence is positional, and this re-delivered frame put
    // the newer gate first). What must NOT happen is a disarm: the armed gate
    // never closed.
    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: ["g1"] } }),
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: ["g2", "g1"] } }),
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: waiting("A", "g2") });
    expect(memory.armed).toEqual(waiting("A", "g2"));
  });

  it("FALLS THROUGH: a lost gate plus a new gate on one snapshot is ONE arm, not a disarm", () => {
    // `arm` replaces Rust's single pending countdown, so the owed disarm is
    // subsumed — sending both would be redundant IPC.
    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: ["g1"] } }),
      snap({
        candidateOrder: ["A", "B"],
        settledWatch: ["A", "B"],
        waitingIds: { A: [], B: ["g7"] },
      }),
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: waiting("B", "g7") });
    expect(memory).toEqual({
      armed: waiting("B", "g7"),
      armedExpiresAt: NOW + DELAY * 1000,
      spent: [],
    });
  });
});

// ================================= R4: forget a spent pause when it has ended

describe("attentionStep — R4 forget a spent pause when that pause ends", () => {
  it("lets a session's SECOND run alert again (REGRESSION: once-per-session silencing)", () => {
    // A settled trigger carries no per-occurrence identity, so without R4 the
    // one-shot would silence EVERY later run of that session for the whole app
    // lifetime. Walk the life of one pause, then the next one.
    const step = (
      memory: AttentionMemory,
      prev: AttentionSnapshot,
      next: AttentionSnapshot,
      at: number = NOW,
    ) => attentionStep(memory, prev, next, opts({ now: at }));

    // 1. The turn falls → arm.
    const one = step(mem(), running("A"), fallen("A"));
    expect(one.effect).toEqual({ type: "arm", trigger: settled("A") });

    // 2. The deadline passes with nothing else happening → retire, mark spent.
    const two = step(one.memory, fallen("A"), fallen("A"), AFTER);
    expect(two.effect).toEqual({ type: "none" });
    expect(two.memory).toEqual({ armed: null, armedExpiresAt: null, spent: [settled("A")] });

    // 3. The user starts another turn → that pause is over, so `spent` is forgotten.
    const three = step(two.memory, fallen("A"), running("A"));
    expect(three.effect).toEqual({ type: "none" });
    expect(three.memory).toEqual(mem());

    // 4. That run finishes → the SAME session arms again.
    const four = step(three.memory, running("A"), fallen("A"));
    expect(four.effect).toEqual({ type: "arm", trigger: settled("A") });
    expect(four.memory.armedExpiresAt).toBe(NOW + DELAY * 1000);
  });

  it("forgets a spent GATE once that gate is gone, so the same gate id can arm again", () => {
    // Recycled provider tool-call ids (some gateways emit `call_0` per response)
    // make this reachable rather than theoretical — nothing may assume a gate id
    // is globally unique.
    const noGate = snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: [] } });
    const first = attentionStep(mem({ spent: [waiting("A", "g1")] }), noGate, noGate, opts());
    expect(first.effect).toEqual({ type: "none" });
    expect(first.memory).toEqual(mem());

    const second = attentionStep(
      first.memory,
      noGate,
      snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: ["g1"] } }),
      opts(),
    );
    expect(second.effect).toEqual({ type: "arm", trigger: waiting("A", "g1") });
  });

  it("prunes EACH entry on its own evidence: one gate closing leaves the other announced", () => {
    // Per-entry, not whole-set: with a single slot the second entry simply did
    // not exist, and any prune wiped every announced pause at once — which is
    // how a still-open question in session B got un-muted.
    const snapshot = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      waitingIds: { A: [], B: ["g2"] },
    });
    const first = attentionStep(
      mem({ spent: [waiting("A", "g1"), waiting("B", "g2")] }),
      snapshot,
      snapshot,
      opts(),
    );
    expect(first.effect).toEqual({ type: "none" });
    expect(first.memory.spent).toEqual([waiting("B", "g2")]);

    // A's id is now FREE: a recycled provider tool-call id (`call_0` per
    // response) reappearing must arm, while B stays muted.
    const recycled = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      waitingIds: { A: ["g1"], B: ["g2"] },
    });
    const second = attentionStep(first.memory, snapshot, recycled, opts());
    expect(second.effect).toEqual({ type: "arm", trigger: waiting("A", "g1") });
    expect(second.memory.spent).toEqual([waiting("B", "g2")]);
  });

  it("keeps spent while the pause it names is still open (the one-shot holds)", () => {
    const open = snap({ candidateOrder: ["A"], settledWatch: ["A"], waitingIds: { A: ["g1"] } });
    const { memory } = attentionStep(mem({ spent: [waiting("A", "g1")] }), open, open, opts());
    expect(memory.spent).toEqual([waiting("A", "g1")]);
  });

  it("forgets a spent settled pause when the session is closed (it left settledWatch)", () => {
    const { memory } = attentionStep(
      mem({ spent: [settled("A")] }),
      fallen("A"),
      snap({ candidateOrder: [], settledWatch: [], inTurn: { A: false } }),
      opts(),
    );
    expect(memory).toEqual(mem());
  });

  it("does nothing when nothing is spent", () => {
    const { effect, memory } = attentionStep(mem(), fallen("A"), fallen("A"), opts());
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual(mem());
  });

  it("forgets a spent pause WHILE another countdown is armed (REGRESSION: the `armed === null` guard)", () => {
    // The trace of the lost alert, one snapshot per step. `spent` is a SET whose
    // entries each have their OWN `pauseOver`, so a live countdown in Session B
    // has no business keeping Session A's finished-pause remembered — yet the
    // `armed === null` guard made R4 skip its whole sweep whenever ANY
    // countdown was armed, which is the common case (a gate has no timeout).
    //
    //   0. B holds an open question (`armed`, live countdown) and A's finished
    //      pause has already been announced: `spent = [settled:A]`.
    //   1. The user starts a NEW TURN in A. A's pause is now OVER, so the entry
    //      should be forgotten — with the guard, R4 never runs and it stays.
    //   2. B's countdown elapses (R2 announces it) and A's run FINISHES on the
    //      same snapshot. With the guard `settled:A` is still in `spent`, so R5
    //      filters A's one-snapshot pulse away and the alert is lost for good:
    //      a pulse is never re-delivered. Without the guard, step 1 forgot it
    //      and A's SECOND run arms.
    const bQuestion = (aInTurn: boolean) =>
      snap({
        candidateOrder: ["A", "B"],
        settledWatch: ["A", "B"],
        inTurn: { A: aInTurn, B: false },
        waitingIds: { B: ["g1"] },
        stopReasons: { A: aInTurn ? undefined : "end_turn" },
      });
    const before = mem({ armed: waiting("B", "g1"), armedExpiresAt: AFTER, spent: [settled("A")] });

    // 1. A new turn in A, B's countdown STILL LIVE (now = NOW < AFTER).
    const one = attentionStep(before, bQuestion(false), bQuestion(true), opts());
    // NO command: the only candidate is B's gate, which is the armed trigger, so
    // the prune rides along on a pass that otherwise has nothing to say. (Pinned
    // because it is what makes the fix free: forgetting a spent entry emits
    // nothing, so it cannot disturb the countdown that is actually running.)
    expect(one.effect).toEqual({ type: "none" });
    expect(one.memory).toEqual({
      armed: waiting("B", "g1"),
      armedExpiresAt: AFTER,
      spent: [],
    });

    // 2. B's countdown elapses AND A's run finishes, on the one snapshot.
    const two = attentionStep(one.memory, bQuestion(true), bQuestion(false), opts({ now: AFTER }));
    expect(two.effect).toEqual({ type: "arm", trigger: settled("A") });
    // B's question is announced by R2 on this same pass and stays announced —
    // its gate is still open, so R4 may not forget it.
    expect(two.memory).toEqual({
      armed: settled("A"),
      armedExpiresAt: AFTER + DELAY * 1000,
      spent: [waiting("B", "g1")],
    });
  });
});

// ==================== R5: arm, the precedence it obeys, and the latch

describe("attentionStep — R5 arm, supersede, and the latch", () => {
  it("does NOT re-arm the same candidate while the countdown is live", () => {
    // Re-arming would restart Rust's countdown on every store write, so an alert
    // would never arrive for a session whose store keeps ticking.
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: BEFORE }),
      fallen("A"),
      fallen("A"),
      opts(),
    );
    expect(effect).toEqual({ type: "none" });
    expect(memory.armedExpiresAt).toBe(BEFORE);
  });

  it("LATCH (REGRESSION, the self-disarming bug): an armed, evidenced countdown with no candidate is left alone", () => {
    // The settled trigger is a ONE-SNAPSHOT pulse; the countdown outlives it.
    // Unrelated store writes — the naming pass rewrites `sessions` a couple of
    // seconds after a first exchange — must neither disarm nor re-arm it.
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: NOW + 14_000 }),
      null,
      snap({ candidateOrder: ["A"], settledWatch: ["A"], inTurn: { A: false } }),
      opts(),
    );
    // i.e. `attentionDisarm` is never implied by this pass.
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual({ armed: settled("A"), armedExpiresAt: NOW + 14_000, spent: [] });
  });

  it("SUPERSEDES: a settled pulse for another session replaces the armed countdown", () => {
    // Design rule 5, clause (c) — a `settled` countdown IS displaced by a
    // later-arriving `settled` pulse that ranks ahead of it: one alert app-wide,
    // and the pause it displaced is never announced.
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: true },
    });
    const next = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: false },
      stopReasons: { B: "end_turn" },
    });
    const { effect, memory } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: BEFORE }),
      prev,
      next,
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: settled("B") });
    expect(memory).toEqual({ armed: settled("B"), armedExpiresAt: NOW + DELAY * 1000, spent: [] });
  });

  it("SUPERSEDES: a gate opening over a settled countdown arms the gate", () => {
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: false },
    });
    const { effect } = attentionStep(
      mem({ armed: settled("A"), armedExpiresAt: BEFORE }),
      prev,
      snap({ ...prev, waitingIds: { B: ["g"] } }),
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: waiting("B", "g") });
  });

  it("will not arm a candidate that is already spent (the one-shot)", () => {
    const { effect, memory } = attentionStep(
      mem({ spent: [settled("A")] }),
      running("A"),
      fallen("A"),
      opts(),
    );
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual({ armed: null, armedExpiresAt: null, spent: [settled("A")] });
  });

  it("arms at now plus delaySecs seconds — the delay in force at ARM TIME", () => {
    const { memory } = attentionStep(mem(), running("A"), fallen("A"), opts({ delaySecs: 60 }));
    expect(memory.armedExpiresAt).toBe(NOW + 60_000);
  });

  it("never mutates the memory it was handed (the step is pure)", () => {
    const before = mem({ armed: settled("A"), armedExpiresAt: NOW - 1 });
    attentionStep(before, fallen("A"), fallen("A"), opts());
    expect(before).toEqual({ armed: settled("A"), armedExpiresAt: NOW - 1, spent: [] });
  });
});

// ==================== R5: the precedence ladder — who holds the single slot

describe("attentionStep — R5 precedence: which pause holds the single slot", () => {
  /**
   * `attentionStep` owns exactly one countdown, so these four clauses are the
   * WHOLE supersede rule (design rule 5). They are pinned together because "last
   * pause wins, naming the most recent pause" is only true for two of them: R5
   * takes the head of a POSITIONALLY ordered candidate list, so the slot changes
   * hands only when something higher-ranked appears — an arriving question, or an
   * arriving pulse — and a later question does not take over an older one.
   */
  it("clause 1: an unanswered question outranks a finished run, app-wide", () => {
    // B's gate and A's pulse are BOTH owed on this snapshot; the question takes
    // the slot (the same precedence `sessionStatusOf` gives waiting over running).
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: true, B: false },
    });
    const next = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: false },
      stopReasons: { A: "end_turn" },
      waitingIds: { B: ["g9"] },
    });
    const { effect } = attentionStep(mem(), prev, next, opts());
    expect(effect).toEqual({ type: "arm", trigger: waiting("B", "g9") });
  });

  it("clause 2: among questions the EARLIEST still-open one holds the slot (a newer gate does NOT take over)", () => {
    // The clause the "last pause wins" comment used to deny. `candidateOrder` is
    // positional and each session's `waitingIds` is arrival order, so a new gate
    // in session B ranks BEHIND the armed gate in A: the head still equals
    // `armed`, R5 has nothing to say, and the most overdue question keeps the
    // alert. Nothing is re-armed, so Rust's original deadline survives.
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      waitingIds: { A: ["g1"] },
    });
    const next = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      waitingIds: { A: ["g1"], B: ["g2"] },
    });
    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      prev,
      next,
      opts(),
    );
    expect(effect).toEqual({ type: "none" });
    // The armed trigger and its deadline are UNCHANGED — not displaced, and not
    // even re-timed (which would be the other way to lose the older question).
    expect(memory.armed).toEqual(waiting("A", "g1"));
    expect(memory.armedExpiresAt).toBe(BEFORE);
  });

  it("clause 3: a settled pulse never displaces a live question", () => {
    // B finishing while A's question is armed sends NOTHING: the pulse is the
    // lower-ranked candidate, and the head is still the armed gate. A walk-away
    // user gets one alert, for the question they have not answered.
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: true },
      waitingIds: { A: ["g1"] },
    });
    const next = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: false },
      stopReasons: { B: "end_turn" },
      waitingIds: { A: ["g1"] },
    });
    const { effect, memory } = attentionStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
      prev,
      next,
      opts(),
    );
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE, spent: [] });
  });

  it("clause 4: a settled countdown is displaced — by a question, and by a later pulse", () => {
    const armed = mem({ armed: settled("A"), armedExpiresAt: BEFORE });
    const prev = snap({
      candidateOrder: ["A", "B", "C"],
      settledWatch: ["A", "B", "C"],
      inTurn: { A: false, B: true, C: false },
    });
    // (a) a newer pulse of another Session takes the settled countdown over,
    // because both are pulses and B simply appears.
    const byPulse = attentionStep(
      armed,
      prev,
      snap({ ...prev, inTurn: { A: false, B: false, C: false }, stopReasons: { B: "end_turn" } }),
      opts(),
    );
    expect(byPulse.effect).toEqual({ type: "arm", trigger: settled("B") });

    // (b) and a question outranks both: with C's gate open on the same snapshot
    // as B's pulse, the gate wins the slot over the pulse AND over the armed one.
    const byGate = attentionStep(
      armed,
      prev,
      snap({
        ...prev,
        inTurn: { A: false, B: false, C: false },
        stopReasons: { B: "end_turn" },
        waitingIds: { C: ["g7"] },
      }),
      opts(),
    );
    expect(byGate.effect).toEqual({ type: "arm", trigger: waiting("C", "g7") });
  });
});

// ============================== R5: a spent pause filters, it never vetoes

describe("attentionStep — R5: an announced pause must not mute the pause underneath it", () => {
  it("a spent GATE in one session does not veto a fresh settled pulse in another", () => {
    // REGRESSION. `spent` used to be compared against a SINGLE head candidate,
    // and `waiting` wins app-wide — so a question the user already typed over
    // (an `ask` has no timeout, so this is a steady state, not a corner) refused
    // every `settled` pulse behind it, for as long as that gate stayed open. A
    // pulse is one snapshot wide and is never re-delivered, so those alerts were
    // lost permanently and the feature was silently dead, with no symptom.
    const prev = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: true, B: false },
      waitingIds: { B: ["g1"] },
    });
    const next = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      inTurn: { A: false, B: false },
      stopReasons: { A: "end_turn" },
      waitingIds: { B: ["g1"] },
    });
    const { effect, memory } = attentionStep(
      mem({ spent: [waiting("B", "g1")] }),
      prev,
      next,
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: settled("A") });
    // The spent gate stays spent — filtering it out is not the same as letting
    // it alert again.
    expect(memory).toEqual({
      armed: settled("A"),
      armedExpiresAt: NOW + DELAY * 1000,
      spent: [waiting("B", "g1")],
    });
  });

  it("a SECOND question in one session alerts while an earlier spent question is still open", () => {
    // Design rule: waiting is a STATE identified by the gate, so a new question
    // from the same Session is a new pause the user owes — even when the older
    // one is still sitting there, announced and spent.
    const open = snap({
      candidateOrder: ["B"],
      settledWatch: ["B"],
      waitingIds: { B: ["g1", "g2"] },
    });
    const { effect, memory } = attentionStep(
      mem({ spent: [waiting("B", "g1")] }),
      open,
      open,
      opts(),
    );
    expect(effect).toEqual({ type: "arm", trigger: waiting("B", "g2") });
    expect(memory.armed).toEqual(waiting("B", "g2"));
  });
});

// ======================= REGRESSION: the announced pauses are a SET, not a slot

describe("attentionStep — REGRESSION: one alert per pause, for EVERY pause", () => {
  /**
   * ADR 0038's promise is one alert per pause AND no alert for a pause already
   * announced. That held while there was one candidate and one `spent` slot, and
   * broke the moment `attentionCandidates` returned a LIST (4a6dd8d) while
   * `spent` stayed a SINGLE trigger: R2 wrote `spent = armed`, so retiring the
   * second announced pause ERASED the first, and the pause underneath it — still
   * open, already announced — armed again. These tests are that trace.
   */
  it("retiring an announced pause must not un-mute the pause underneath it", () => {
    // The verified trace of the duplicate alert, one snapshot per step:
    //   t=0     gate gA opens in A  → arm waiting:A/gA  (toast #1)
    //   t=15s   R2 retires          → announced = [A/gA]
    //   t=20s   B settles           → arm settled:B     (toast #2, correct)
    //   t=35s   R2 retires B        → announced = [A/gA, settled:B]  (was: B ONLY)
    //   t=36s   any store write     → NOTHING. A/gA is already announced.
    const gateAOpen = (bInTurn: boolean) =>
      snap({
        candidateOrder: ["A", "B"],
        settledWatch: ["A", "B"],
        inTurn: { A: false, B: bInTurn },
        waitingIds: { A: ["gA"] },
        stopReasons: bInTurn ? {} : { B: "end_turn" },
      });

    // 1. A's gate is the only pause → arm it.
    const one = attentionStep(mem(), gateAOpen(true), gateAOpen(true), opts());
    expect(one.effect).toEqual({ type: "arm", trigger: waiting("A", "gA") });

    // 2. Its countdown elapses. A's gate STAYS open (an `ask` has no timeout —
    //    this is the steady state, not a corner) and B is still streaming.
    const two = attentionStep(
      one.memory,
      gateAOpen(true),
      gateAOpen(true),
      opts({ now: AFTER }),
    );
    expect(two.effect).toEqual({ type: "none" });

    // 3. B's turn falls: a NEW pause, so it arms. The announced gate must not
    //    veto it (4a6dd8d's fix, which this change must not undo).
    const three = attentionStep(
      two.memory,
      gateAOpen(true),
      gateAOpen(false),
      opts({ now: NOW + 5_000 }),
    );
    expect(three.effect).toEqual({ type: "arm", trigger: settled("B") });

    // 4. B's countdown elapses too — and THIS is where the single slot broke:
    //    announcing B replaced the record of A, so the very next write re-armed
    //    A's already-announced question. Third toast for one unanswered question.
    const four = attentionStep(
      three.memory,
      gateAOpen(false),
      gateAOpen(false),
      opts({ now: NOW + 5_000 + DELAY * 1000 + 1 }),
    );
    expect(four.effect).toEqual({ type: "none" });

    // 5. THE HEADLINE: an unrelated store write re-derives `waiting:A/gA` as a
    //    candidate. It was announced at t=0, so this pass must be silent.
    const five = attentionStep(
      four.memory,
      gateAOpen(false),
      gateAOpen(false),
      opts({ now: NOW + 40_000 }),
    );
    expect(five.effect).toEqual({ type: "none" });

    // And both pauses are still remembered as announced: neither is over (A's
    // gate is open, B has started no new turn), so R4 may not forget either.
    expect(five.memory).toEqual({
      armed: null,
      armedExpiresAt: null,
      spent: [waiting("A", "gA"), settled("B")],
    });
  });

  it("two simultaneously open gates cannot ping-pong A→B→A→B forever", () => {
    // `loop.rs` runs tool calls in parallel, so ONE session can hold two gates
    // and two sessions can each hold one. With a single `spent` slot every
    // retirement un-mutef the other gate, so the storm was one OS notification
    // every `delaySecs` for as long as any store write landed per window.
    const both = snap({
      candidateOrder: ["A", "B"],
      settledWatch: ["A", "B"],
      waitingIds: { A: ["gA"], B: ["gB"] },
    });

    const first = attentionStep(mem(), both, both, opts());
    expect(first.effect).toEqual({ type: "arm", trigger: waiting("A", "gA") });
    const second = attentionStep(first.memory, both, both, opts({ now: AFTER }));
    expect(second.effect).toEqual({ type: "arm", trigger: waiting("B", "gB") });

    // The loop must be broken HERE, and it must stay broken on the next pass.
    const third = attentionStep(second.memory, both, both, opts({ now: AFTER + DELAY * 1000 + 1 }));
    expect(third.effect).toEqual({ type: "none" });
    const fourth = attentionStep(
      third.memory,
      both,
      both,
      opts({ now: AFTER + 2 * (DELAY * 1000 + 1) }),
    );
    expect(fourth.effect).toEqual({ type: "none" });
  });

  it("arms normally from an EMPTY announced set (no falsy-array short-circuit)", () => {
    // `[]` is truthy but empty, so an implementation that tested `spent` for
    // truthiness rather than length would silently never arm again.
    const { effect, memory } = attentionStep(mem({ spent: [] }), running("A"), fallen("A"), opts());
    expect(effect).toEqual({ type: "arm", trigger: settled("A") });
    expect(memory).toEqual({
      armed: settled("A"),
      armedExpiresAt: NOW + DELAY * 1000,
      spent: [],
    });
  });
});

// ============================================================= activity path

describe("attentionActivityStep", () => {
  it("disarms an armed countdown and marks that pause spent", () => {
    const { effect, memory } = attentionActivityStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE }),
    );
    // Spent, so typing without answering does not re-alert the same pause.
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual({ armed: null, armedExpiresAt: null, spent: [waiting("A", "g1")] });
  });

  it("sends NOTHING when nothing is armed (idle typing costs no IPC)", () => {
    const { effect, memory } = attentionActivityStep(mem({ spent: [settled("A")] }));
    expect(effect).toEqual({ type: "none" });
    expect(memory).toEqual(mem({ spent: [settled("A")] }));
  });

  it("ACCUMULATES the announced set instead of overwriting it", () => {
    // The activity path wrote `spent: memory.armed` and so destroyed every
    // earlier announced pause exactly like R2 did — same bug, second caller.
    const { effect, memory } = attentionActivityStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE, spent: [settled("Z")] }),
    );
    expect(effect).toEqual({ type: "disarm" });
    expect(memory).toEqual({
      armed: null,
      armedExpiresAt: null,
      spent: [settled("Z"), waiting("A", "g1")],
    });
  });

  it("does not double-book: spending a pause already in the set leaves ONE entry", () => {
    const { memory } = attentionActivityStep(
      mem({ armed: waiting("A", "g1"), armedExpiresAt: BEFORE, spent: [waiting("A", "g1")] }),
    );
    expect(memory.spent).toEqual([waiting("A", "g1")]);
  });
});

// =============================================================== alert text

describe("attentionAlertText", () => {
  const ctx = (
    sessions: { sessionId: string; cwd: string; title?: string | null }[],
    parents: Record<string, string> = {},
  ) => ({ sessions, parents });

  it("titles every alert Archimedes", () => {
    expect(ATTENTION_TITLE).toBe("Archimedes");
    expect(
      attentionAlertText(settled("A"), ctx([{ sessionId: "A", cwd: "/w/proj" }])).title,
    ).toBe(ATTENTION_TITLE);
    expect(
      attentionAlertText(waiting("A", "g"), ctx([{ sessionId: "A", cwd: "/w/proj" }])).title,
    ).toBe(ATTENTION_TITLE);
  });

  it("says finished-and-waiting for settled, needs-your-answer for waiting", () => {
    expect(
      attentionAlertText(settled("A"), ctx([{ sessionId: "A", cwd: "/w/proj" }])).body,
    ).toBe("proj finished — waiting for you");
    expect(
      attentionAlertText(waiting("A", "g"), ctx([{ sessionId: "A", cwd: "/w/proj" }])).body,
    ).toBe("proj needs your answer");
  });

  it("label precedence: trimmed title, then folder name, then the generic label", () => {
    expect(
      attentionAlertText(
        settled("A"),
        ctx([{ sessionId: "A", cwd: "/w/proj", title: "  Refactor auth  " }]),
      ).body,
    ).toBe("Refactor auth finished — waiting for you");
    expect(
      attentionAlertText(settled("A"), ctx([{ sessionId: "A", cwd: "/w/proj", title: null }])).body,
    ).toBe("proj finished — waiting for you");
    expect(attentionAlertText(settled("A"), ctx([])).body).toBe(
      "A session finished — waiting for you",
    );
  });

  it("falls through a blank or whitespace-only title", () => {
    expect(
      attentionAlertText(settled("A"), ctx([{ sessionId: "A", cwd: "/w/proj", title: "   " }]))
        .body,
    ).toBe("proj finished — waiting for you");
    expect(
      attentionAlertText(settled("A"), ctx([{ sessionId: "A", cwd: "/w/proj", title: "" }])).body,
    ).toBe("proj finished — waiting for you");
  });

  it("falls through a bare-root cwd, where basenameOfPath yields an empty string", () => {
    // A `??` chain could not reach the fallback here: an empty string is not
    // null, so the label rule is `||`.
    expect(attentionAlertText(settled("A"), ctx([{ sessionId: "A", cwd: "/" }])).body).toBe(
      "A session finished — waiting for you",
    );
  });

  it("labels a SUBAGENT trigger with the PARENT's title (the user's session is the parent)", () => {
    expect(
      attentionAlertText(
        waiting("sub1", "g"),
        ctx([{ sessionId: "P", cwd: "/w/app", title: "API work" }], { sub1: "P" }),
      ).body,
    ).toBe("API work needs your answer");
  });

  it("labels an unresolvable parent generically, never with a raw id", () => {
    expect(attentionAlertText(waiting("sub1", "g"), ctx([], { sub1: "P" })).body).toBe(
      "A session needs your answer",
    );
  });

  it("takes the first match, so a live row wins over a history row with the same id", () => {
    expect(
      attentionAlertText(
        settled("A"),
        ctx([
          { sessionId: "A", cwd: "/w/live", title: "Live" },
          { sessionId: "A", cwd: "/w/old", title: "History" },
        ]),
      ).body,
    ).toBe("Live finished — waiting for you");
  });
});
