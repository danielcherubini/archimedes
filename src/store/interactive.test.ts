import { beforeEach, describe, expect, it } from "vitest";
import { useInteractive } from "./interactive";

const S1 = "s1";
const S2 = "s2";

beforeEach(() => {
  const s = useInteractive.getState();
  // Reset everything a previous test may have left behind.
  for (const id of new Set([
    ...Object.keys(s.requests),
    ...Object.keys(s.todos),
    ...Object.keys(s.agentState),
    ...Object.keys(s.cost),
    ...Object.keys(s.session),
  ])) {
    s.dismissSession(id);
  }
});

describe("addRequest / removeRequest", () => {
  it("adds a request keyed by session id", () => {
    useInteractive.getState().addRequest(S1, {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: { questions: [] },
    });
    const list = useInteractive.getState().requests[S1];
    expect(list).toHaveLength(1);
    expect(list?.[0]).toMatchObject({
      requestId: "r1",
      method: "ask",
      source: "main",
    });
  });

  it("dedups by requestId (a re-delivered frame replaces, not duplicates)", () => {
    const add = useInteractive.getState().addRequest;
    add(S1, {
      requestId: "r1",
      method: "confirm",
      source: "main",
      params: { command: "a", reason: "b" },
    });
    add(S1, {
      requestId: "r1",
      method: "confirm",
      source: "main",
      params: { command: "a2", reason: "b2" },
    });
    const list = useInteractive.getState().requests[S1];
    expect(list).toHaveLength(1);
    expect(list?.[0].params).toEqual({ command: "a2", reason: "b2" });
  });

  it("keeps requests for different sessions separate", () => {
    const add = useInteractive.getState().addRequest;
    add(S1, { requestId: "r1", method: "ask", source: "main", params: {} });
    add(S2, { requestId: "r1", method: "confirm", source: "main", params: {} });
    expect(useInteractive.getState().requests[S1]).toHaveLength(1);
    expect(useInteractive.getState().requests[S2]).toHaveLength(1);
  });

  it("removes a request by requestId", () => {
    useInteractive
      .getState()
      .addRequest(S1, {
        requestId: "r1",
        method: "ask",
        source: "main",
        params: {},
      });
    useInteractive.getState().removeRequest(S1, "r1");
    expect(useInteractive.getState().requests[S1]).toHaveLength(0);
  });
});

/**
 * Boards are keyed by SESSION id and by nothing else (ADR 0041): one Session
 * runs one Agent harness, so it produces exactly one board, and the payload's
 * `source` label is inert. Every frame the desktop emits carries
 * `"native"` for a MAIN session and a Subagent session alike, so the cases
 * below deliberately drive the SAME session id through every label variant —
 * the regression pin for the `native`-heading bug.
 */
describe("todos", () => {
  it("applyTodoUpdate writes the session's own board", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "in_progress" }],
    });
    expect(useInteractive.getState().todos[S1]).toEqual([
      { content: "a", status: "in_progress" },
    ]);
  });

  it("the `source` label routes NOTHING: every variant lands in the same session's slice", () => {
    const board = [{ content: "board", status: "pending" }];
    for (const payload of [
      { source: "native", todos: board },
      { source: "main", todos: board },
      { source: "subagent:x", todos: board },
      // No `source` key at all — the store must not read it, so a payload
      // missing it is still a board for this session.
      { todos: board },
    ]) {
      useInteractive.getState().applyTodoUpdate(S1, payload);
      expect(useInteractive.getState().todos[S1]).toEqual(board);
    }
    // Keyed by id, so another session's slice is untouched (and the label
    // never became a key of its own).
    expect(useInteractive.getState().todos[S2]).toBeUndefined();
  });

  it("applyTodoUpdate replaces the board on re-delivery (latest wins)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "b", status: "completed" }],
    });
    expect(useInteractive.getState().todos[S1]).toEqual([
      { content: "b", status: "completed" },
    ]);
  });

  /**
   * The shape guard (`!Array.isArray(p.todos)`) is the only thing standing
   * between a malformed frame and every board consumer in the Client —
   * `useMainTodoItems` hands its result straight to `TodoBoardPanel`'s
   * `.filter`/`.map`, so a write of `"nope"` or `{}` would throw inside the
   * Side pane, not merely render oddly. It is also the ONLY guard left: ADR
   * 0041 deleted the `source` branch, so a payload with a bad label and a
   * good array still lands (pinned above), while a payload with a good label
   * and a bad `todos` must not land at all.
   */
  it("applyTodoUpdate ignores a payload whose `todos` is not an array (the state object is returned IDENTICAL)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "the board", status: "pending" }],
    });
    for (const todos of ["nope", {}, null, undefined, 0, true]) {
      const before = useInteractive.getState();
      useInteractive.getState().applyTodoUpdate(S1, { source: "native", todos });
      // `toBe` on the STATE OBJECT, not `toEqual` on the slice: the guard
      // returns `state` untouched, so no store notification and no re-render
      // (an `toEqual` on `todos[S1]` would also pass for a write of the same
      // contents, which is a different event).
      expect(useInteractive.getState()).toBe(before);
      expect(useInteractive.getState().todos[S1]).toEqual([
        { content: "the board", status: "pending" },
      ]);
    }
    // A payload that is not an object at all is the same no-op (the guard's
    // `!p ||` half, which the `todos` loop above cannot reach).
    const before = useInteractive.getState();
    useInteractive.getState().applyTodoUpdate(S1, null);
    useInteractive.getState().applyTodoUpdate(S1, undefined);
    useInteractive.getState().applyTodoUpdate(S1, "nope");
    expect(useInteractive.getState()).toBe(before);
  });

  it("applyTodoClear drops the session's WHOLE board (no `source` argument)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    useInteractive.getState().applyTodoClear(S1);
    expect(useInteractive.getState().todos[S1]).toBeUndefined();
  });

  /**
   * The key DELETED, not an empty array written. `toBeUndefined()` above
   * cannot tell the two apart (`({} as …)["s1"]` is `undefined` too), and the
   * difference is the documented consequence: `applyTodoClear` leaves the
   * session's board empty until the next `todos_update`.
   */
  it("applyTodoClear DELETES the key rather than writing `[]`", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    useInteractive.getState().applyTodoClear(S1);
    expect("s1" in useInteractive.getState().todos).toBe(false);
    // The sibling sessions survive the spread-copy-and-delete (the write is
    // not a wholesale reset of the map).
    useInteractive.getState().applyTodoUpdate(S2, {
      source: "native",
      todos: [{ content: "b", status: "pending" }],
    });
    useInteractive.getState().applyTodoClear(S1);
    expect("s1" in useInteractive.getState().todos).toBe(false);
    expect("s2" in useInteractive.getState().todos).toBe(true);
  });

  it("applyTodoClear for a session with no board is a no-op (identical state object)", () => {
    useInteractive.getState().applyTodoUpdate(S1, {
      source: "native",
      todos: [{ content: "a", status: "pending" }],
    });
    const before = useInteractive.getState();
    useInteractive.getState().applyTodoClear("nope");
    expect(useInteractive.getState()).toBe(before);
  });
});

describe("wired-but-not-rendered state", () => {
  it("applyState stores the agent state", () => {
    useInteractive.getState().applyState(S1, { state: "blocked" });
    expect(useInteractive.getState().agentState[S1]).toBe("blocked");
  });

  it("applySession stores the session payload", () => {
    useInteractive.getState().applySession(S1, { bridgeSession: "abc" });
    expect(useInteractive.getState().session[S1]).toEqual({ bridgeSession: "abc" });
  });
});

/**
 * `applyCost` — the session's money (issue #87).
 *
 * This describe used to be a case inside `wired-but-not-rendered state`,
 * asserting `applyCost(S1, { inputTokens: 10 })` stored the payload back
 * VERBATIM (`toEqual({ inputTokens: 10 })`). That assertion was the defect: a
 * frame is not stored, it is NORMALISED and ADDED, and after #87 the figure is
 * rendered. The case now lives here and asserts the normalised shape.
 */
describe("applyCost (the session's cumulative USD figure, #87)", () => {
  it("normalises the first frame instead of storing it raw", () => {
    useInteractive.getState().applyCost(S1, { inputTokens: 10 });
    // Every field the entry type carries is present after ONE frame — the
    // entry's shape must not depend on how many frames have arrived (rule R3).
    expect(useInteractive.getState().cost[S1]).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: null,
      costUsd: null,
    });
  });

  it("two cost frames SUM — a frame is THIS CALL's money; if the emitter ever sends a running total, change combineSessionCost, not the renderer", () => {
    useInteractive.getState().applyCost(S1, { costUsd: 0.02 });
    useInteractive.getState().applyCost(S1, { costUsd: 0.05 });
    const entry = useInteractive.getState().cost[S1] as { costUsd: number };
    expect(entry.costUsd).toBeCloseTo(0.07, 10);
  });

  it("a frame with costUsd: null never becomes a real 0 — the session total stays null", () => {
    // D5: `null` means "no call this session reported a cost" and renders
    // NOTHING. The old arithmetic was `(prev.cost ?? 0) + (p?.cost ?? 0)`,
    // which manufactured a numeric `0` out of two unknowns — the phantom
    // `$0.00` #87 was filed to end.
    useInteractive.getState().applyCost(S1, { costUsd: null });
    useInteractive.getState().applyCost(S1, { costUsd: null });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeNull();
    // The alias cannot drift from the primary: both say "unknown".
    expect(entry.cost).toBeNull();
  });

  it("a frame that carries no money key at all is unknown, not zero", () => {
    // T09's emitter OMITS the key rather than sending `null` (its Decision 2),
    // so absence must land in the same state as `null`.
    useInteractive.getState().applyCost(S1, { inputTokens: 100, outputTokens: 20 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeNull();
    expect(entry.cost).toBeNull();
  });

  it("an unknown frame followed by a priced frame yields the figure, not figure+0", () => {
    useInteractive.getState().applyCost(S1, { costUsd: null });
    useInteractive.getState().applyCost(S1, { costUsd: 0.03 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.03, 10);
    expect(entry.cost).toBeCloseTo(0.03, 10);
  });

  it("a priced frame followed by an unknown frame keeps the figure (unknown is not a number to add)", () => {
    useInteractive.getState().applyCost(S1, { costUsd: 0.03 });
    useInteractive.getState().applyCost(S1, { costUsd: null });
    const entry = useInteractive.getState().cost[S1] as { costUsd: number | null };
    expect(entry.costUsd).toBeCloseTo(0.03, 10);
  });

  it("the legacy cost key still lands AND gains the costUsd alias (SubagentDelegatingCard reads cost)", () => {
    // A REAL zero-cost `0` is a figure (D5: `$0.00`), so the state below is a
    // figure and not an unknown.
    //
    // Applied to an EMPTY store on purpose: this is the FIRST frame, and the
    // branch this pins away was `interactive.ts`'s
    // `if (!prev) return { cost: { ...state.cost, [sessionId]: payload } }`,
    // which stored the payload RAW and left it with NO `costUsd` key — so the
    // renderer read nothing while money existed. Do not "fix" this case by
    // seeding a second frame: that would route it around the branch again.
    useInteractive.getState().applyCost(S1, { cost: 0.035 });
    const entry = useInteractive.getState().cost[S1] as {
      cost: number | null;
      costUsd: number | null;
    };
    expect(entry.cost).toBeCloseTo(0.035, 10);
    expect(entry.costUsd).toBeCloseTo(0.035, 10);
  });

  it("the FIRST costUsd frame is normalised too: the entry gains the cost alias on frame one", () => {
    // The mirror of the case above (rule R3, other direction): a D5-shaped
    // first frame stored raw carries NO `cost` key, and
    // `SubagentDelegatingCard`'s `interactiveCost?.cost` link reads `undefined`
    // for that session until a second frame arrives.
    useInteractive.getState().applyCost(S1, { costUsd: 0.0042 });
    const entry = useInteractive.getState().cost[S1] as {
      cost: number | null;
      costUsd: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.0042, 10);
    expect(entry.cost).toBeCloseTo(0.0042, 10);
  });

  it("a legacy frame and a costUsd frame SUM ONCE into one total, never twice", () => {
    // Rule R4. `costUsd` and `cost` are ONE accumulator, not two sums: the
    // frame's money is chosen ONCE (`costUsd` first, legacy `cost` second) and
    // only then added. Adding both keys would report `0.02` for `0.01` spent —
    // the double-count trap D4/D5 exist to stop, relocated into the store.
    useInteractive.getState().applyCost(S1, { cost: 0.005 });
    useInteractive.getState().applyCost(S1, { costUsd: 0.005 });
    const entry = useInteractive.getState().cost[S1] as {
      cost: number | null;
      costUsd: number | null;
    };
    expect(entry.costUsd).toBeCloseTo(0.01, 10);
    expect(entry.costUsd).not.toBeCloseTo(0.02, 10);
    // And the alias tracks the primary, so the card cannot show a different
    // figure from the session line.
    expect(entry.cost).toBeCloseTo(0.01, 10);
  });

  it("costUsd wins when one frame carries both keys", () => {
    // Rule R2: `costUsd` is D5's authoritative key; `cost` is the fallback for
    // a pre-D5 emitter. A frame carrying both must count the D5 one ONCE.
    useInteractive.getState().applyCost(S1, { cost: 0.005, costUsd: 0.007 });
    const entry = useInteractive.getState().cost[S1] as { costUsd: number | null };
    expect(entry.costUsd).toBeCloseTo(0.007, 10);
  });

  it("a malformed figure (string / NaN / negative) is unknown, never invented money", () => {
    useInteractive.getState().applyCost(S1, { costUsd: "0.05" });
    useInteractive.getState().applyCost(S1, { costUsd: Number.NaN });
    useInteractive.getState().applyCost(S1, { costUsd: -1 });
    useInteractive.getState().applyCost(S1, { costUsd: Number.POSITIVE_INFINITY });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBeNull();
    expect(entry.cost).toBeNull();
  });

  it("a real zero figure is kept as 0, not collapsed into unknown", () => {
    // D5: `0` is a real zero and renders `$0.00` — the opposite state from
    // `null`. The store must not lose the difference.
    useInteractive.getState().applyCost(S1, { costUsd: 0 });
    const entry = useInteractive.getState().cost[S1] as {
      costUsd: number | null;
      cost: number | null;
    };
    expect(entry.costUsd).toBe(0);
    expect(entry.cost).toBe(0);
  });

  it("keeps the token fields the SubagentDelegatingCard reads off the same entry", () => {
    // The card's context-% chain (`interactiveCost.inputTokens/outputTokens`)
    // and its `#85` test seed tokens with NO cost key at all.
    useInteractive.getState().applyCost(S1, { inputTokens: 25000 });
    useInteractive.getState().applyCost(S1, { outputTokens: 5000 });
    const entry = useInteractive.getState().cost[S1] as {
      inputTokens: number;
      outputTokens: number;
    };
    expect(entry.inputTokens).toBe(25000);
    expect(entry.outputTokens).toBe(5000);
  });
});

describe("dismissSession", () => {
  it("clears requests, todos, agentState, cost, and session for the session", () => {
    const s = useInteractive.getState();
    s.addRequest(S1, {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {},
    });
    s.applyTodoUpdate(S1, {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    s.applyState(S1, { state: "working" });
    s.applyCost(S1, { inputTokens: 1 });
    s.applySession(S1, { bridgeSession: "abc" });
    s.dismissSession(S1);
    const after = useInteractive.getState();
    expect(after.requests[S1]).toBeUndefined();
    expect(after.todos[S1]).toBeUndefined();
    expect(after.agentState[S1]).toBeUndefined();
    expect(after.cost[S1]).toBeUndefined();
    expect(after.session[S1]).toBeUndefined();
  });

  it("leaves other sessions alone", () => {
    const s = useInteractive.getState();
    s.addRequest(S1, {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {},
    });
    s.addRequest(S2, {
      requestId: "r2",
      method: "ask",
      source: "main",
      params: {},
    });
    s.dismissSession(S1);
    expect(useInteractive.getState().requests[S2]).toHaveLength(1);
  });
});
