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
   * difference is the documented consequence: `useMainTodoItems` reads
   * `board ?? rawTodos ?? []`, so ONLY an absent slice re-exposes the
   * transcript-derived `rawInput` seed — an empty array is a board, and a
   * board that renders nothing. `src/components/TodoBoardPanel.test.tsx`
   * pins the render half of that claim.
   */
  it("applyTodoClear DELETES the key rather than writing `[]` (so the `rawInput` seed is unmasked)", () => {
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

  it("applyCost stores the cost payload", () => {
    useInteractive.getState().applyCost(S1, { inputTokens: 10 });
    expect(useInteractive.getState().cost[S1]).toEqual({ inputTokens: 10 });
  });

  it("applySession stores the session payload", () => {
    useInteractive.getState().applySession(S1, { bridgeSession: "abc" });
    expect(useInteractive.getState().session[S1]).toEqual({ bridgeSession: "abc" });
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
