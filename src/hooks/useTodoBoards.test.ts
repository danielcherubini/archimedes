import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { todoBoardsOf, useTodoBoards, type TodoBoard } from "./useTodoBoards";
import { useInteractive, type TodoItem } from "../store/interactive";
import { useSubagents, type SubagentEntry } from "../store/subagents";

/**
 * `todoBoardsOf` is the ONE derivation of "which todo boards do the RUNNING
 * children of THIS Session have, in arrival order, labelled so two same-named
 * children are distinguishable" — the Side pane's child blocks (Task 3) read it
 * and nothing else, so they cannot disagree (the repo's standing rule; see
 * `useChildGates.ts`, whose shape this copies). The tests drive the PURE core
 * directly with object fixtures: a hook cannot be called once per parent at a
 * changing list length, and the derivation holds no React.
 */

/** A `SubagentEntry` fixture — EVERY required field, so `pnpm build`'s `tsc`
 * accepts it (`task` / `status` are not optional on the real type). */
const entry = (
  sessionId: string,
  parentSessionId: string,
  agentName: string,
  startedAt: number,
  status: SubagentEntry["status"] = "running",
): SubagentEntry => ({
  sessionId,
  parentSessionId,
  agentName,
  task: `task for ${agentName}`,
  status,
  startedAt,
});

/** A child's board fixture, built from the item statuses in list order. */
const board = (...statuses: TodoItem["status"][]): TodoItem[] =>
  statuses.map((status, i) => ({ content: `item ${i + 1}`, status }));

/** The todos map the pure core reads — fresh per call so a test cannot leak a
 * mutation into the next one. */
const noBoards = (): Record<string, TodoItem[]> => ({});

beforeEach(() => {
  // Reset the REAL stores this file seeds, so no case leaks into the next. The
  // pure-core cases pass fixtures, but the hook case writes through the stores,
  // and `useSubagents` / `useInteractive` are module singletons.
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  for (const id of Object.keys(useInteractive.getState().todos)) {
    useInteractive.getState().dismissSession(id);
  }
});

describe("todoBoardsOf (the pure core — the Side pane's single source)", () => {
  it("returns [] when there are no subagent entries", () => {
    expect(todoBoardsOf({}, noBoards(), "main1")).toEqual([]);
  });

  it("surfaces a running child's open board with every field of the board", () => {
    const todos = noBoards();
    todos.sub1 = board("completed", "in_progress", "pending");
    const boards = todoBoardsOf(
      { sub1: entry("sub1", "main1", "reviewer", 1000) },
      todos,
      "main1",
    );
    expect(boards).toHaveLength(1);
    // The WHOLE board, pinned with `toStrictEqual` so the FIELD SET is part of
    // the assertion: `completed` counts the done items and `open` the rest (the
    // block's `n/m` numerator and its visibility rule), `label` is bare because
    // no sibling shares the name, and `startedAt` is the entry's arrival verbatim.
    expect(boards[0]).toStrictEqual({
      childSessionId: "sub1",
      agentName: "reviewer",
      label: "reviewer",
      items: todos.sub1,
      completed: 1,
      open: 2,
      startedAt: 1000,
    } satisfies TodoBoard);
  });

  it("drops a child of ANOTHER Session (an unrelated board is not this pane's business)", () => {
    const todos = noBoards();
    todos.sub1 = board("pending");
    todos.sub2 = board("pending");
    const boards = todoBoardsOf(
      {
        sub1: entry("sub1", "main1", "reviewer", 1000),
        // Another Session's child — its board belongs in THAT pane.
        sub2: entry("sub2", "main2", "scout", 2000),
      },
      todos,
      "main1",
    );
    expect(boards.map((b) => b.childSessionId)).toEqual(["sub1"]);
  });

  it("drops a child that is no longer running (`completed` and `failed` stop taking space)", () => {
    // A finished child's outcome reads in its `SubagentDelegatingCard` and its
    // sheet; the board block disappearing IS the cleanup, so no close frame has
    // to have cleared the board first (a child's slice is cleared narrowly by
    // the `subagent-closed` handler, but this rule must not depend on that).
    const todos = noBoards();
    todos.subDone = board("pending", "pending");
    todos.subFailed = board("in_progress");
    todos.subRunning = board("pending");
    const boards = todoBoardsOf(
      {
        subDone: entry("subDone", "main1", "reviewer", 1000, "completed"),
        subFailed: entry("subFailed", "main1", "scout", 2000, "failed"),
        subRunning: entry("subRunning", "main1", "build", 3000),
      },
      todos,
      "main1",
    );
    expect(boards.map((b) => b.childSessionId)).toEqual(["subRunning"]);
  });

  it("drops a child whose list is fully completed (an all-completed board renders nothing)", () => {
    // The same visibility rule the PARENT's list already obeys
    // (`useBoardOpenCount` counts a fully-completed list as ZERO), applied to
    // a child so a finished checklist does not hold a block open in the pane.
    const todos = noBoards();
    todos.sub1 = board("completed", "completed");
    expect(
      todoBoardsOf({ sub1: entry("sub1", "main1", "reviewer", 1000) }, todos, "main1"),
    ).toEqual([]);
  });

  it("drops a child that has no board at all (an absent slice is `[]`, which has no open item)", () => {
    // `todos[sub] ?? []` — a child that never called `manage_todo_list` must not
    // draw an empty block, and the fallback lives INSIDE the derivation (never
    // as a `?? {}` on the store slice, which would mint a fresh object per read).
    expect(
      todoBoardsOf({ sub1: entry("sub1", "main1", "reviewer", 1000) }, noBoards(), "main1"),
    ).toEqual([]);
    // An explicitly-empty board behaves identically.
    const todos = noBoards();
    todos.sub1 = [];
    expect(
      todoBoardsOf({ sub1: entry("sub1", "main1", "reviewer", 1000) }, todos, "main1"),
    ).toEqual([]);
  });

  it("counts `completed` and `open` from the child's own list", () => {
    const todos = noBoards();
    todos.sub1 = board("completed", "completed", "in_progress", "pending");
    const boards = todoBoardsOf(
      { sub1: entry("sub1", "main1", "reviewer", 1000) },
      todos,
      "main1",
    );
    expect(boards[0].completed).toBe(2);
    expect(boards[0].open).toBe(2);
    // The block renders the FULL list (density is Task 3's render choice); the
    // derivation filters boards, never items.
    expect(boards[0].items).toBe(todos.sub1);
  });

  it("orders by child ARRIVAL (`startedAt`), not by map insertion order", () => {
    const todos = noBoards();
    todos.subEarly = board("pending");
    todos.subLate = board("pending");
    // `subLate` is inserted into the map FIRST but arrived SECOND — the sort key
    // is `startedAt`, so 1000 comes before 2000 regardless of `Object.values`
    // order. (A tie is what insertion order breaks, which is also arrival.)
    const boards = todoBoardsOf(
      {
        subLate: entry("subLate", "main1", "scout", 2000),
        subEarly: entry("subEarly", "main1", "reviewer", 1000),
      },
      todos,
      "main1",
    );
    expect(boards.map((b) => b.childSessionId)).toEqual(["subEarly", "subLate"]);
    expect(boards.map((b) => b.startedAt)).toEqual([1000, 2000]);
  });

  it("labels a repeated name bare, then ' 2' and ' 3' in arrival order", () => {
    const todos = noBoards();
    todos.a = board("pending");
    todos.b = board("pending");
    todos.c = board("pending");
    const boards = todoBoardsOf(
      {
        a: entry("a", "main1", "researcher", 1000),
        b: entry("b", "main1", "researcher", 2000),
        c: entry("c", "main1", "researcher", 3000),
      },
      todos,
      "main1",
    );
    expect(boards.map((b) => b.label)).toEqual([
      "researcher",
      "researcher 2",
      "researcher 3",
    ]);
    // `agentName` stays verbatim — the suffix belongs to the LABEL only, so a
    // consumer that needs the real name still has it.
    expect(boards.map((b) => b.agentName)).toEqual([
      "researcher",
      "researcher",
      "researcher",
    ]);
  });

  it("leaves a unique name bare even beside repeated siblings (the count is per name, not global)", () => {
    const todos = noBoards();
    todos.a = board("pending");
    todos.b = board("pending");
    todos.c = board("pending");
    const boards = todoBoardsOf(
      {
        // Insertion order is deliberately NOT arrival order: the disambiguation
        // is computed over the RENDERED set in ARRIVAL order.
        c: entry("c", "main1", "scout", 3000),
        a: entry("a", "main1", "researcher", 1000),
        b: entry("b", "main1", "researcher", 2000),
      },
      todos,
      "main1",
    );
    expect(boards.map((b) => b.label)).toEqual([
      "researcher",
      "researcher 2",
      "scout",
    ]);
  });

  it("counts names within the RENDERED set only — a filtered-out sibling does not force a suffix", () => {
    // The second `researcher` is another Session's child, so it renders nowhere
    // in this pane: the surviving board must stay bare rather than become
    // `"researcher 1"` / `"researcher 2"` for a sibling the user cannot see.
    const todos = noBoards();
    todos.mine = board("pending");
    todos.theirs = board("pending");
    const boards = todoBoardsOf(
      {
        mine: entry("mine", "main1", "researcher", 1000),
        theirs: entry("theirs", "main2", "researcher", 2000),
      },
      todos,
      "main1",
    );
    expect(boards.map((b) => b.label)).toEqual(["researcher"]);
  });

  it("parentSessionId: null returns [] — no active Session means nothing to scope to, NOT 'every child'", () => {
    const todos = noBoards();
    todos.sub1 = board("pending");
    todos.sub2 = board("pending");
    const entries = {
      sub1: entry("sub1", "main1", "reviewer", 1000),
      // A second parent's child: an "all children" reading would list it too.
      sub2: entry("sub2", "main2", "scout", 2000),
    };
    expect(todoBoardsOf(entries, todos, null)).toEqual([]);
    // ONE frozen array for "nothing" — the same reference every time, so the
    // answer is referentially stable across renders.
    expect(todoBoardsOf(entries, todos, null)).toBe(
      todoBoardsOf(entries, todos, null),
    );
    // And frozen: a consumer that mutated the shared instance throws instead of
    // corrupting every other render.
    expect(() => {
      (todoBoardsOf(entries, todos, null) as TodoBoard[]).push({
        childSessionId: "x",
        agentName: "x",
        label: "x",
        items: [],
        completed: 0,
        open: 0,
        startedAt: 0,
      });
    }).toThrow();
  });

  it("is pure: the same inputs give an equal, independent array (no store read, no shared item objects mutated)", () => {
    const entries = { sub1: entry("sub1", "main1", "reviewer", 1000) };
    const todos = noBoards();
    todos.sub1 = board("in_progress", "pending");
    const first = todoBoardsOf(entries, todos, "main1");
    const second = todoBoardsOf(entries, todos, "main1");
    expect(second).toEqual(first);
    // A fresh array per call — the hook's `useMemo` is what gives it identity;
    // the core itself holds no cache and reads no store.
    expect(second).not.toBe(first);
    // The derivation never copies or rewrites the store's items.
    expect(second[0].items[0]).toBe(todos.sub1[0]);
    // And an unrelated parent's id yields nothing without touching the inputs.
    expect(todoBoardsOf(entries, todos, "main9")).toEqual([]);
    expect(Object.keys(entries)).toEqual(["sub1"]);
    expect(todos.sub1).toHaveLength(2);
  });
});

describe("useTodoBoards (the hook — the thin store-reading wrapper)", () => {
  it("reads the two stores and returns only THIS parent's running children, in arrival order", () => {
    // The hook subscribes to the STORES, so this case writes through them
    // (`beforeEach` resets both, so nothing leaks between cases in this file).
    useSubagents.setState({
      entries: {
        // Explicit `startedAt` rather than `addSession`'s `Date.now()`: the
        // arrival assertion needs two distinct values, and the store STAMPS the
        // real clock, which a test cannot pin.
        subLate: entry("subLate", "main1", "researcher", 2000),
        subEarly: entry("subEarly", "main1", "researcher", 1000),
        // Another Session's child — not this pane's business.
        subOther: entry("subOther", "main2", "scout", 1500),
      },
    });
    // Boards arrive through the real `todos_update` path: the frame's `source`
    // is `"native"` for a Main session and a child alike, so it routes nothing
    // (ADR 0041) — the board lands under the CHILD session id the frame carries.
    useInteractive.getState().applyTodoUpdate("subLate", {
      source: "native",
      todos: board("in_progress"),
    });
    useInteractive.getState().applyTodoUpdate("subEarly", {
      source: "native",
      todos: board("completed", "pending"),
    });
    useInteractive.getState().applyTodoUpdate("subOther", {
      source: "native",
      todos: board("pending"),
    });

    const { result } = renderHook(() => useTodoBoards("main1"));
    expect(result.current.map((b) => b.childSessionId)).toEqual([
      "subEarly",
      "subLate",
    ]);
    expect(result.current.map((b) => b.label)).toEqual(["researcher", "researcher 2"]);
    expect(result.current.map((b) => b.open)).toEqual([1, 1]);
    expect(result.current.map((b) => b.completed)).toEqual([1, 0]);
  });
});
