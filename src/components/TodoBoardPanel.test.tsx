import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import TodoBoardPanel, { useBoardOpenCount, useMainTodoItems } from "./TodoBoardPanel";
import { useInteractive, type TodoItem } from "../store/interactive";
import { useSessions } from "../store/sessions";
import { useSubagents } from "../store/subagents";
import { useSubagentSelection } from "../store/subagentSelection";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  useInteractive.getState().dismissSession("main1");
  useInteractive.getState().dismissSession("sub1");
  useInteractive.getState().dismissSession("sub2");
  // The child-board cases seed `useSubagents` entries, which live in a module
  // store: undismissed they leak into the NEXT case and quietly change the
  // board COUNT, which is what the density assertions read — so the assertions
  // would become order-dependent.
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  useSubagentSelection.getState().select(null);
  useSessions.setState({ messages: {}, activeSessionId: null });
});

describe("TodoBoardPanel", () => {
  it("renders the section header (the Todos label + N/M) with a progress indicator for a main column", () => {
    // 1 done / 3 total.
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "done item", status: "completed" },
        { content: "active item", status: "in_progress" },
        { content: "later item", status: "pending" },
      ],
    });
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // The section label (the `SidePane` hosts the board as a section — the
    // ZCode `Goal`/`Progress` treatment: the header carries the label +
    // the count, the body the progress bar + checklist).
    expect(screen.getByText("Todos")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    const indicator = container.querySelector<HTMLElement>(
      '[data-slot="progress-indicator"]',
    );
    expect(indicator).not.toBeNull();
    // The ported `progress.tsx` normalizes `value` to 0–100 and applies it
    // ONLY to the indicator's `width` style.
    expect(Math.abs(parseFloat(indicator!.style.width) - 100 / 3)).toBeLessThan(
      0.01,
    );
  });

  it("renders the three-state indicators (done / in-progress / pending)", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "done item", status: "completed" },
        { content: "active item", status: "in_progress" },
        { content: "later item", status: "pending" },
      ],
    });
    render(<TodoBoardPanel sessionId="main1" />);
    // Done: a `size-4` circle with a check icon, `text-success`.
    const doneRow = screen.getByText("done item").parentElement;
    const circle = doneRow?.querySelector(".text-success");
    expect(circle).not.toBeNull();
    expect(circle!.className).toContain("size-4");
    expect(circle!.querySelector("svg")).not.toBeNull();
    // In-progress: `◉` in `text-warning`.
    const inProgress = screen.getByText("◉");
    expect(inProgress.className).toContain("text-warning");
    // Pending: `○` in `text-foreground-subtlest`.
    const pending = screen.getByText("○");
    expect(pending.className).toContain("text-foreground-subtlest");
  });

  it("renders NOTHING when there are no todos (the board is visible only while open todos exist)", () => {
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // No "No todos yet" placeholder — an empty board is hidden entirely.
    expect(screen.queryByText("No todos yet")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders NOTHING when ALL main todos are completed (the board hides once the list is done)", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "done one", status: "completed" },
        { content: "done two", status: "completed" },
      ],
    });
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // No progress header, no checklist rows — a fully-completed board is
    // hidden (it carries no attention cue; the badge is gone too, via the
    // same open-count derivation).
    expect(
      container.querySelector('[data-slot="progress-indicator"]'),
    ).toBeNull();
    expect(screen.queryByText("done one")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders a MAIN session's board from a `source: native` frame, and never draws the label (ADR 0041)", () => {
    // The bug this pins: every frame the desktop emits carries
    // `"native"` — for a Main session and a Subagent session alike — and the
    // old `source` branch filed that board in a subagent bucket, so the
    // sidebar drew the word `native` above the PARENT's own list.
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [
        { content: "done item", status: "completed" },
        { content: "active item", status: "in_progress" },
        { content: "later item", status: "pending" },
      ],
    });
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // The board is the MAIN section: header + `N/M` + the checklist rows.
    expect(screen.getByText("Todos")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("done item")).toBeTruthy();
    expect(screen.getByText("active item")).toBeTruthy();
    expect(screen.getByText("later item")).toBeTruthy();
    // The FULL parent checklist is a NAMED list region too: the full-list branch
    // passes NO `label`, so `TodoItems`' default ("Todos") is what names it — this
    // pins that fact (and that the parent's board is therefore never the anonymous
    // `list` the panel's own doc forbids presenting). The REDUCED parent row's name
    // is pinned by `reduces the PARENT to its Current todo while a child board
    // shows`; this no-children shape was the one list whose name nothing pinned.
    expect(screen.getByRole("list", { name: "Todos" })).toBeTruthy();
    // And the emitter's label is rendered NOWHERE.
    expect(container.textContent).not.toContain("native");
  });

  it("renders the board from the `rawInput` seed when NO `todos_update` frame arrived", () => {
    // A non-interactive agent: the transcript carries the
    // `manage_todo_list` call, the interactive store has no slice for the
    // session at all, and the seed still draws the whole board (header and
    // count included — the panel used to be able to miss it entirely).
    useSessions.getState().applySessionUpdate("main1", {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "manage_todo_list",
      status: "in_progress",
      rawInput: {
        operation: "write",
        todoList: [
          { content: "raw one", status: "pending" },
          { content: "raw two", status: "completed" },
        ],
      },
    });
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    expect(screen.getByText("Todos")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("raw one")).toBeTruthy();
    expect(screen.getByText("raw two")).toBeTruthy();
    expect(container.textContent).not.toContain("native");
  });

  /**
   * The render half of `applyTodoClear`'s documented consequence
   * (`src/store/interactive.ts`): a clear DELETES the session's key instead of
   * writing `[]`, and `useMainTodoItems` reads `board ?? rawTodos ?? []` — so
   * ONLY an absent slice lets the transcript-derived `rawInput` seed back
   * through. A store test cannot pin this half (`"s1" in todos` and an
   * empty-array write both read as "no board" to `toBeUndefined`), and without
   * it the one line that turns a clear into a re-seed is unchecked: writing
   * `[]` would silently blank the board instead.
   */
  it("a clear UNMASKS the session's `rawInput` seed (the key goes, so the transcript's list renders again)", () => {
    // The seed: a `manage_todo_list` call in the transcript.
    useSessions.getState().applySessionUpdate("main1", {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "manage_todo_list",
      status: "in_progress",
      rawInput: {
        operation: "write",
        todoList: [
          { content: "raw one", status: "pending" },
          { content: "raw two", status: "completed" },
        ],
      },
    });
    // The live board wins while it exists — that is what the clear removes.
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [
        { content: "live one", status: "in_progress" },
        { content: "live two", status: "pending" },
      ],
    });
    const { rerender } = render(<TodoBoardPanel sessionId="main1" />);
    expect(screen.getByText("live one")).toBeTruthy();
    expect(screen.getByText("live two")).toBeTruthy();
    expect(screen.queryByText("raw one")).toBeNull();
    expect(screen.getByText("0/2")).toBeTruthy();

    act(() => {
      useInteractive.getState().applyTodoClear("main1");
    });
    rerender(<TodoBoardPanel sessionId="main1" />);

    // The seed is what the transcript actually shows, so it renders again —
    // rows AND the header's count, which now counts the seeded list.
    expect(screen.getByText("raw one")).toBeTruthy();
    expect(screen.getByText("raw two")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.queryByText("live one")).toBeNull();
    expect(screen.queryByText("live two")).toBeNull();
    // And it is genuinely the ABSENCE of a slice, not an empty board that
    // happens to render nothing (the store test asserts the same fact from the
    // other side).
    expect("main1" in useInteractive.getState().todos).toBe(false);
  });

  it("useBoardOpenCount returns the OPEN (non-completed) todo count (zero when fully completed)", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "completed" },
        { content: "c", status: "in_progress" },
        { content: "d", status: "completed" },
      ],
    });
    const { result, rerender } = renderHook(() => useBoardOpenCount("main1"));
    expect(result.current).toBe(2);
    // A fully-completed list counts as ZERO (the badge and the panel's
    // visibility share this derivation — they can never disagree).
    act(() => {
      useInteractive.getState().applyTodoUpdate("main1", {
        source: "main",
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ],
      });
    });
    rerender();
    expect(result.current).toBe(0);
  });

  it("useMainTodoItems returns the rawInput fallback when the interactive column is absent", () => {
    // A non-interactive agent: no `todos_update` column, only a
    // `manage_todo_list` tool-call in the session's transcript.
    useSessions.getState().applySessionUpdate("main1", {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "manage_todo_list",
      status: "in_progress",
      rawInput: {
        operation: "write",
        todoList: [
          { content: "raw one", status: "pending" },
          { content: "raw two", status: "completed" },
        ],
      },
    });
    const { result } = renderHook(() => useMainTodoItems("main1"));
    expect(result.current.map((t) => t.content)).toEqual([
      "raw one",
      "raw two",
    ]);
  });

  // -- Child boards: one labelled block per running child of THIS session --
  //
  // `addSession` STAMPS `startedAt` itself (`Date.now()`), so the seeders below
  // never pass it. Two children added in the same millisecond therefore share a
  // `startedAt`, and their relative order is the store's insertion order — that
  // is arrival order, and it is pinned in `src/hooks/useTodoBoards.test.ts`. The
  // cases here therefore assert membership by TEXT, never by index.

  const seedChild = (
    sessionId: string,
    agentName: string,
    todos: TodoItem[],
    status: "running" | "completed" = "running",
  ) => {
    useSubagents.getState().addSession({
      sessionId,
      parentSessionId: "main1",
      agentName,
      task: `the ${agentName} task`,
      status,
    });
    // The label the desktop puts on EVERY `todos_update` frame, for a Main
    // session and a Subagent session alike (ADR 0041).
    useInteractive.getState().applyTodoUpdate(sessionId, {
      source: "native",
      todos,
    });
  };

  it("renders a labelled block per running child with an open list, at FULL density when it is the only board", () => {
    seedChild("sub1", "reviewer", [
      { content: "child done one", status: "completed" },
      { content: "child done two", status: "completed" },
      { content: "child pending", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const block = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"]',
    );
    expect(block).not.toBeNull();
    // The header: the agent's name + `completed/total`.
    expect(block!.textContent).toContain("reviewer");
    expect(block!.textContent).toContain("2/3");
    // The block itself is NOT the control (see the a11y case below) — the
    // header line is, and its accessible name is the action, not a
    // `label n/m` string that would replace the checklist wholesale.
    expect(block!.getAttribute("role")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open reviewer transcript" }),
    ).toBeTruthy();
    // The ONE board at its level → its FULL list, every state.
    expect(block!.querySelectorAll("li")).toHaveLength(3);
    expect(block!.textContent).toContain("child pending");
    // Distinguished by a left BORDER, never an indent (the `pl-6` indent went
    // with the mis-routed block in Task 1): a bar reads as "someone else's
    // list" at any pane width.
    expect(block!.className).toContain("border-l");
    expect(block!.className).not.toContain("pl-6");
  });

  it("renders NO block for a child whose list is fully completed", () => {
    seedChild("sub1", "reviewer", [
      { content: "child done one", status: "completed" },
      { content: "child done two", status: "completed" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // The same visibility rule the parent's own list obeys — a finished
    // checklist holds no block open (and, with no parent board either, the
    // panel is hidden entirely).
    expect(
      container.querySelector('[data-testid="todo-board-child"]'),
    ).toBeNull();
    expect(screen.queryByText("reviewer")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders NO block for a child that is no longer running", () => {
    seedChild(
      "sub1",
      "reviewer",
      [{ content: "child pending", status: "pending" }],
      "completed",
    );
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // The block disappearing IS the cleanup: the outcome still reads in the
    // parent's "Delegating" card and in the child's own sheet.
    expect(
      container.querySelector('[data-testid="todo-board-child"]'),
    ).toBeNull();
    expect(screen.queryByText("child pending")).toBeNull();
  });

  it("reduces the PARENT to its Current todo while a child board shows", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [
        { content: "parent done", status: "completed" },
        { content: "parent working", status: "in_progress" },
        { content: "parent later", status: "pending" },
      ],
    });
    seedChild("sub1", "reviewer", [
      { content: "child pending", status: "pending" },
    ]);
    render(<TodoBoardPanel sessionId="main1" />);
    // A board yields to the boards beside it: one row — the `in_progress` one.
    expect(screen.getByText("parent working")).toBeTruthy();
    expect(screen.queryByText("parent done")).toBeNull();
    expect(screen.queryByText("parent later")).toBeNull();
    // The header still counts the WHOLE list: reduced is a render choice, and
    // the store always holds the full list.
    expect(screen.getByText("1/3")).toBeTruthy();
    // TWO checklists on screen, each a NAMED region: the parent's list keeps the
    // section's own word (`Todos`) and the child's carries its label, so an AT
    // user navigating by landmark hears which board each list belongs to rather
    // than two anonymous "list"s.
    expect(screen.getByRole("list", { name: "Todos" })).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "reviewer checklist" }),
    ).toBeTruthy();
  });

  it("reduces the parent to its FIRST OPEN item when nothing is in progress", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [
        { content: "parent done", status: "completed" },
        { content: "parent next", status: "pending" },
        { content: "parent after", status: "pending" },
      ],
    });
    seedChild("sub1", "reviewer", [
      { content: "child pending", status: "pending" },
    ]);
    render(<TodoBoardPanel sessionId="main1" />);
    // The Current todo is the `in_progress` entry, else the FIRST OPEN one —
    // OPEN meaning "not `completed`" (`CONTEXT.md`), which this fixture happens
    // to fill with `pending` items; the case below pins an open item whose
    // status is outside the union. Never a completed one, never the third item.
    expect(screen.getByText("parent next")).toBeTruthy();
    expect(screen.queryByText("parent after")).toBeNull();
    expect(screen.queryByText("parent done")).toBeNull();
  });

  it("disambiguates two children that share an agent name: `researcher` and `researcher 2`", () => {
    // The panel must render `board.label`, never `board.agentName`: the `" 2"`
    // suffix is what tells two same-named children apart, and it is computed by
    // `todoBoardsOf`' rule 6, so a panel that reached past the label would
    // re-collide two headings with nothing else in the suite noticing.
    //
    // Seeded with `setState` rather than `addSession`, because `addSession`
    // stamps `startedAt = Date.now()` and two children added in the same
    // millisecond share it — here the arrival order (and therefore WHICH block
    // earns the suffix) is pinned by explicit values.
    useSubagents.setState({
      entries: {
        sub1: {
          sessionId: "sub1",
          parentSessionId: "main1",
          agentName: "researcher",
          task: "read the diff",
          status: "running",
          startedAt: 1_000,
        },
        sub2: {
          sessionId: "sub2",
          parentSessionId: "main1",
          agentName: "researcher",
          task: "read the tests",
          status: "running",
          startedAt: 2_000,
        },
      },
    });
    useInteractive.getState().applyTodoUpdate("sub1", {
      source: "native",
      todos: [{ content: "alpha one", status: "in_progress" }],
    });
    useInteractive.getState().applyTodoUpdate("sub2", {
      source: "native",
      todos: [{ content: "beta one", status: "pending" }],
    });
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const first = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"][data-child="sub1"]',
    )!;
    const second = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"][data-child="sub2"]',
    )!;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The VISIBLE header text: the first arrival stays bare, the second is
    // suffixed (rule 6 — a repeated name's first block needs no disambiguation).
    expect(first.querySelector("p span")!.textContent).toBe("researcher");
    expect(second.querySelector("p span")!.textContent).toBe("researcher 2");
    // And the CONTROL's accessible name carries the same disambiguation — a
    // screen reader tabbing the two targets hears two different buttons.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    const firstControl = screen.getByRole("button", {
      name: "Open researcher transcript",
    });
    const secondControl = screen.getByRole("button", {
      name: "Open researcher 2 transcript",
    });
    // Each name belongs to ITS OWN block (the suffix is not merely rendered,
    // it is on the control that routes to that child).
    expect(first.contains(firstControl)).toBe(true);
    expect(second.contains(secondControl)).toBe(true);
    expect(second.contains(firstControl)).toBe(false);
  });

  it("reduces the PARENT to an open item whose `status` is outside the union", () => {
    // `open` is `status !== "completed"` (`useBoardOpenCount`, and rule 4 of
    // `todoBoardsOf`), while `useMainTodoItems` casts ANY model-authored string
    // into `TodoItem["status"]`. So a hyphenated `"in-progress"` counted toward
    // the number that AUTO-OPENS the frame while the old fallback — the first
    // `pending` specifically — returned `undefined`: the frame opened and the
    // reduced parent row rendered NOTHING.
    useInteractive.getState().applyTodoUpdate("main1", {
      // The store takes `payload: unknown`; this is exactly the boundary that
      // lets a non-union status into a typed board in production.
      source: "native",
      todos: [
        { content: "parent done", status: "completed" },
        { content: "parent in flight", status: "in-progress" },
      ],
    });
    // A child board, so the parent is REDUCED (the only path that consults
    // `currentTodo`).
    seedChild("sub1", "reviewer", [
      { content: "child pending", status: "pending" },
    ]);
    render(<TodoBoardPanel sessionId="main1" />);
    expect(screen.getByText("parent in flight")).toBeTruthy();
    expect(screen.queryByText("parent done")).toBeNull();
  });

  it("reduces a CHILD to an open item whose `status` is outside the union", () => {
    // The SAME rule on the child half of the pane: the board counts as open (so
    // the block renders), but a fallback that only accepted `pending` left it
    // headless — a labelled block with no row at all.
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "the reviewer task",
      status: "running",
    });
    useInteractive.getState().applyTodoUpdate("sub1", {
      source: "native",
      todos: [
        { content: "alpha done", status: "completed" },
        { content: "alpha in flight", status: "doing" },
      ],
    });
    // A second board, so BOTH are reduced.
    seedChild("sub2", "builder", [
      { content: "beta pending", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const alpha = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"][data-child="sub1"]',
    )!;
    expect(alpha).not.toBeNull();
    expect(alpha.querySelectorAll("li")).toHaveLength(1);
    expect(alpha.textContent).toContain("alpha in flight");
  });

  it("reduces EACH child to one row once a second child board appears", () => {
    seedChild("sub1", "reviewer", [
      { content: "alpha one", status: "pending" },
      { content: "alpha two", status: "pending" },
    ]);
    seedChild("sub2", "builder", [
      { content: "beta work", status: "in_progress" },
      { content: "beta later", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    expect(
      container.querySelectorAll('[data-testid="todo-board-child"]'),
    ).toHaveLength(2);
    const alpha = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"][data-child="sub1"]',
    );
    const beta = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"][data-child="sub2"]',
    );
    expect(alpha).not.toBeNull();
    expect(beta).not.toBeNull();
    // Two boards at one level → each is REDUCED to its Current todo.
    expect(alpha!.querySelectorAll("li")).toHaveLength(1);
    expect(alpha!.textContent).toContain("alpha one");
    expect(alpha!.textContent).not.toContain("alpha two");
    expect(beta!.querySelectorAll("li")).toHaveLength(1);
    expect(beta!.textContent).toContain("beta work");
    expect(beta!.textContent).not.toContain("beta later");
    // Each block still counts its OWN list — in the header text AND in the
    // control's accessible name.
    expect(beta!.textContent).toContain("0/2");
    expect(
      screen.getByRole("button", { name: "Open builder transcript" }),
    ).toBeTruthy();
  });

  it("keeps the child's checklist OUT of the named control, so a screen reader still hears the rows", () => {
    // `role="button"` — like a real `<button>` — is "Children Presentational:
    // True", and an `aria-label` wins the name computation outright. When the
    // WHOLE block was the control, a screen reader heard `reviewer 2/3,
    // button` and never one item of the child's checklist, while the parent's
    // rows (a plain `<ol>` outside any control) were exposed: two checklists
    // for a sighted user, one for an AT user.
    seedChild("sub1", "reviewer", [
      { content: "child done one", status: "completed" },
      { content: "child work", status: "in_progress" },
      { content: "child later", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const block = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"]',
    )!;
    const control = screen.getByRole("button", {
      name: "Open reviewer transcript",
    });
    // The control is INSIDE the block and holds only the header line…
    expect(block.contains(control)).toBe(true);
    expect(control.tagName).toBe("DIV");
    expect(control.tabIndex).toBe(0);
    // …so NO row of the checklist sits inside it. THE STRUCTURAL CHECKS BELOW
    // (`control.contains(row) === false`, `row.closest('[role="button"]') ===
    // null`) are the PINS of this case: they are what differs between the broken
    // shape (the whole block as the control) and this one. The role query after
    // them is NOT evidence of the same thing and must not be read as such —
    // `getAllByRole` does not model "Children Presentational: True", the spec
    // rule that actually decides what an AT user hears: a `role=button`
    // container with an `aria-label` still yields its `li`s there, so these three
    // `listitem`s were also found in the BROKEN shape (round 1, re-measured on
    // this branch: restoring the block-as-control reddens ONLY the structural
    // checks, never this one). They are kept as
    // a shape assertion — three rows, each carrying its own text (`listitem` take
    // no name from content), none of them moved out of the document by moving the
    // control.
    const rows = Array.from(block.querySelectorAll("li"));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(control.contains(row)).toBe(false);
      expect(row.closest('[role="button"]')).toBeNull();
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    // AND the checklist is a NAMED list region. A bare `<ol>` is an anonymous
    // `list` to assistive tech, and the pane can present three of them at once
    // (the parent's list plus two child blocks), so "list" alone says nothing
    // about WHICH board the rows belong to.
    expect(
      screen.getAllByRole("list", { name: "reviewer checklist" }),
    ).toHaveLength(1);
    expect(screen.getByText("child work")).toBeTruthy();
    expect(screen.getByText("child later")).toBeTruthy();
    // And the progress is exposed too. The visible `n/m` lives INSIDE the named
    // control — whose `aria-label` replaces the whole name computation, so it
    // says nothing there — hence the `sr-only` sibling: without it the counts
    // (and thus ANY status cue, since the row indicators are `aria-hidden`)
    // would be invisible to a screen reader.
    const progress = screen.getByText("1 of 3 complete");
    expect(progress.className).toContain("sr-only");
    expect(control.contains(progress)).toBe(false);
  });

  it("opens the child's transcript sheet on click AND on Enter/Space, from the header control", () => {
    seedChild("sub1", "reviewer", [
      { content: "child pending", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const block = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"]',
    )!;
    // The block is a plain `div` (a `role=button` there would make its
    // children presentational and hide the checklist); the HEADER LINE is the
    // control. It is a `div[role=button]` rather than a `<button>` because a
    // `<button>`'s content model forbids block-level content.
    expect(block.tagName).toBe("DIV");
    expect(block.getAttribute("role")).toBeNull();
    expect(block.hasAttribute("aria-label")).toBe(false);
    expect(block.tabIndex).toBe(-1);
    const control = screen.getByRole("button", {
      name: "Open reviewer transcript",
    });
    expect(control.getAttribute("role")).toBe("button");
    expect(control.tabIndex).toBe(0);
    // The click-through routes on the CHILD id (never the name) and opens
    // `SubagentDetailHost`.
    fireEvent.click(control);
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    useSubagentSelection.getState().select(null);
    fireEvent.keyDown(control, { key: "Enter" });
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    useSubagentSelection.getState().select(null);
    fireEvent.keyDown(control, { key: " " });
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
  });

  it("opens the child's sheet from a click on the block's ROW BODY too (the whole block is a mouse target)", () => {
    // Batch A moved the CONTROL to the header line (the a11y shape, pinned
    // above), but it moved `cursor-pointer`/`hover` there too, which left the
    // row bodies inert: a mouse user clicking the checklist they can see — the
    // biggest target in the block — got nothing. The a11y shape and the pointer
    // target are separate concerns: the container carries the click, the header
    // stays the only control.
    seedChild("sub1", "reviewer", [
      { content: "child done one", status: "completed" },
      { content: "child work", status: "in_progress" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const block = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"]',
    )!;
    const rows = Array.from(block.querySelectorAll("li"));
    expect(rows).toHaveLength(2);
    // The ROW BODY, not the header: the row's own text node is what the click
    // lands on, and it bubbles to the container.
    fireEvent.click(screen.getByText("child work"));
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    useSubagentSelection.getState().select(null);
    fireEvent.click(rows[0]!);
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    // …and the container is STILL not a control: no `role`, not focusable, so
    // the rows inside it stay exposed to assistive tech (the case above pins
    // that shape; this pins that restoring the mouse target did not undo it).
    expect(block.getAttribute("role")).toBeNull();
    expect(block.tabIndex).toBe(-1);
    // The pointer affordance sits on the container now, because the CONTAINER is
    // what the pointer activates.
    expect(block.className).toContain("cursor-pointer");
    // The header control is untouched: still the named, focusable control.
    const control = screen.getByRole("button", {
      name: "Open reviewer transcript",
    });
    expect(control.getAttribute("role")).toBe("button");
    expect(control.tabIndex).toBe(0);
  });

  it("does NOT open the sheet when the click ENDS A TEXT SELECTION inside the block — on a row OR on the header line", () => {
    // The block is the mouse target, so its `onClick` used to fire for ANY click
    // inside it — including the one that finishes a select-drag. Reading a
    // child's checklist and dragging over the last row to select it therefore
    // opened that child's transcript sheet on top of the text the user had just
    // selected. A drag that ENDS inside the block is not an activation.
    seedChild("sub1", "reviewer", [
      { content: "child one", status: "pending" },
      { content: "child two", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    const block = container.querySelector<HTMLElement>(
      '[data-testid="todo-board-child"]',
    )!;
    const rows = Array.from(block.querySelectorAll("li"));
    const control = screen.getByRole("button", {
      name: "Open reviewer transcript",
    });
    // jsdom has no selection UX to drive, so the observable the guard reads is
    // stubbed: the guard fires ONLY on a live range (`type === "Range"`); a
    // plain click reports something else (`"None"`, or the `"Caret"` a mousedown
    // leaves) and stays an activation.
    const selection = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ type: "Range" } as Selection);
    try {
      // The release of the drag, landing on a row body — the ordinary mouse
      // target, one `fireEvent.click` away from opening the sheet.
      fireEvent.click(rows[1]!);
      expect(screen.getByText("child two")).toBeTruthy();
      // THE HEADER LINE TOO. The header was argued to be "an explicit target,
      // not a surface a drag happens to end on", but its own text (`reviewer`,
      // `1/2`) is SELECTABLE, so a drag that ends on that line releases inside
      // it exactly as it does on a row. Both handlers therefore read the SAME
      // predicate — this is the half that was unguarded.
      fireEvent.click(control);
    } finally {
      selection.mockRestore();
    }
    expect(useSubagentSelection.getState().selectedSessionId).toBeNull();
    // And the guard is scoped to the selection, not to the block: the very same
    // click with no selection is the activation the block exists for (the case
    // above pins that shape; this says the guard did not swallow it — at EITHER
    // level, since the header is the keyboard/AT route to the same sheet).
    fireEvent.click(rows[1]!);
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    useSubagentSelection.getState().select(null);
    fireEvent.click(control);
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
  });

  it("writes the selection EXACTLY ONCE per activation of the child block", () => {
    // The header now BUBBLES into the container's handler, so without
    // `stopPropagation` one click writes the selection twice. The end state is
    // identical (same id), which is exactly why the resulting-state assertion
    // above cannot see it — hence the counting stand-in for `select`.
    const real = useSubagentSelection.getState().select;
    const calls: Array<string | null> = [];
    useSubagentSelection.setState({
      select: (sessionId: string | null) => {
        calls.push(sessionId);
      },
    });
    try {
      seedChild("sub1", "reviewer", [
        { content: "child pending", status: "pending" },
      ]);
      const { container } = render(<TodoBoardPanel sessionId="main1" />);
      const block = container.querySelector<HTMLElement>(
        '[data-testid="todo-board-child"]',
      )!;
      const control = screen.getByRole("button", {
        name: "Open reviewer transcript",
      });
      fireEvent.click(control);
      expect(calls).toEqual(["sub1"]);
      // A row activates the container alone — also exactly one write.
      fireEvent.click(block.querySelector("li")!);
      expect(calls).toEqual(["sub1", "sub1"]);
      // Keyboard activation still routes, and still writes once (the header's
      // own handler — Enter does not synthesize a click in jsdom, so the
      // container is not involved).
      calls.length = 0;
      fireEvent.keyDown(control, { key: "Enter" });
      expect(calls).toEqual(["sub1"]);
    } finally {
      useSubagentSelection.setState({ select: real });
    }
  });

  it("names each row's STATE in its accessible text — for the parent's list AND a child's rows", () => {
    // The three marks are glyphs (`◉` / `○`) and an icon, all decoration: a
    // screen reader hears the item text and NONE of its state — the counts in
    // the `sr-only` "n of m complete" say how far along a board is, not which
    // row is which. So every row carries its state in words. Both levels share
    // `TodoIndicator`, so both are pinned here.
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [
        { content: "ship the parser", status: "completed" },
        { content: "harden the cache", status: "in_progress" },
        { content: "retire the shim", status: "pending" },
      ],
    });
    const stateOf = (content: string) =>
      (screen.getByText(content).closest("li") as HTMLElement).querySelector(
        ".sr-only",
      )?.textContent;
    const { rerender } = render(<TodoBoardPanel sessionId="main1" />);
    expect(stateOf("ship the parser")).toBe("done");
    expect(stateOf("harden the cache")).toBe("in progress");
    expect(stateOf("retire the shim")).toBe("pending");
    // The same three words on a CHILD board's rows.
    useInteractive.getState().dismissSession("main1");
    seedChild("sub1", "reviewer", [
      { content: "child shipped", status: "completed" },
      { content: "child working", status: "in_progress" },
      { content: "child waiting", status: "pending" },
    ]);
    rerender(<TodoBoardPanel sessionId="main1" />);
    expect(stateOf("child shipped")).toBe("done");
    expect(stateOf("child working")).toBe("in progress");
    expect(stateOf("child waiting")).toBe("pending");
    // And the words are `sr-only`: nothing visible changes (the glyphs the
    // density/indicator cases assert are still the sighted reading), and the
    // glyph itself stays hidden from assistive tech so a row is not announced
    // twice.
    const row = screen.getByText("child working").closest("li") as HTMLElement;
    expect(row.querySelector(".sr-only")?.textContent).toBe("in progress");
    expect(row.textContent).toContain("child working");
    const glyph = row.querySelector("[aria-hidden]");
    expect(glyph).not.toBeNull();
    expect(glyph!.textContent).toBe("◉");
  });

  it("renders the wire's `source` label NOWHERE, for a parent or a child board", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [{ content: "parent working", status: "in_progress" }],
    });
    seedChild("sub1", "reviewer", [
      { content: "child pending", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // Both halves are drawn (the block, and the pane's own header), and the
    // emitter's label is absent from every one of them.
    expect(screen.getByText("parent working")).toBeTruthy();
    expect(
      container.querySelector('[data-testid="todo-board-child"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("native");
  });

  it("renders a live child beside a FULLY-COMPLETED parent list, with no parent row and no header", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [
        { content: "parent done one", status: "completed" },
        { content: "parent done two", status: "completed" },
      ],
    });
    seedChild("sub1", "reviewer", [
      { content: "child pending", status: "pending" },
    ]);
    const { container } = render(<TodoBoardPanel sessionId="main1" />);
    // The gate is board-wide: a delegation whose parent has nothing open still
    // opens the section.
    expect(container.firstChild).not.toBeNull();
    expect(
      container.querySelector('[data-testid="todo-board-child"]'),
    ).not.toBeNull();
    // The parent contributes NOTHING. Its Current todo is `undefined` (no open
    // item at all), so there is no row — and rendering one would have thrown on
    // `undefined.content`. The header goes with it (its gate is the parent's own
    // open count, and 2/2 completed is zero open).
    expect(screen.queryByText("parent done one")).toBeNull();
    expect(screen.queryByText("parent done two")).toBeNull();
    expect(screen.queryByText("Todos")).toBeNull();
    expect(
      container.querySelector('[data-slot="progress-indicator"]'),
    ).toBeNull();
  });

  it("useBoardOpenCount counts the parent's list PLUS every running child's", () => {
    // The parent has NOTHING open; the whole count comes from the child. This
    // is the number the frame's auto-open reads, so a delegation whose parent
    // never wrote a list still opens the pane.
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [{ content: "parent done", status: "completed" }],
    });
    seedChild("sub1", "reviewer", [
      { content: "child one", status: "pending" },
      { content: "child two", status: "in_progress" },
      { content: "child three", status: "completed" },
    ]);
    const { result } = renderHook(() => useBoardOpenCount("main1"));
    expect(result.current).toBe(2);
  });

  it("renders multi-line todo items with wrapping and min-height rather than fixed height", () => {
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        {
          content:
            "Task 1: Fix hardcoded discriminator literal in UserPartyRestrictionDao and ensure proper wrapping",
          status: "in_progress",
        },
      ],
    });
    render(<TodoBoardPanel sessionId="main1" />);
    const textNode = screen.getByText(/Task 1: Fix hardcoded discriminator/);
    expect(textNode.className).toContain("break-words");
    const row = textNode.closest("li");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("min-h-8");
    expect(row!.className).toContain("items-start");
    expect(row!.classList.contains("h-8")).toBe(false);
  });
});
