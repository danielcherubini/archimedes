import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SidePane from "./SidePane";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { useSessions } from "../store/sessions";
import type { Message } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { getSidePaneCollapsed, setSidePaneCollapsed, SIDE_PANE_RAIL } from "../lib/sidePaneState";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
  };
});

const entry = {
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running" as const,
};

/**
 * Give each id the `messages` entry a real session always has.
 *
 * `addSession` writes `messages[id] = []` (`store/sessions.ts`), so a LIVE
 * session's transcript is an EMPTY ARRAY, never an absent key (a session reached
 * by `openSession`/`selectSpace`/`resumeSession` has none until its history
 * reload lands — that is the hydration gap). `SidePane` reads an absent entry as
 * "this session is still hydrating" (see the hydration case below), so any case
 * that pins an auto-open EDGE inside one session must model the transcript the
 * way the store leaves it, or it is pinning the suppression rather than the edge.
 */
const liveSessions = (...ids: string[]): void => {
  const existing = useSessions.getState().messages;
  const added: Record<string, Message[]> = {};
  for (const id of ids) {
    if (!(id in existing)) added[id] = [];
  }
  useSessions.setState({ messages: { ...existing, ...added } });
};

beforeAll(() => {
  // jsdom has no pointer capture: stub it (the component guards the ELEMENT
  // with `?.`, not the method).
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

beforeEach(() => {
  setSidePaneCollapsed(false);
  localStorage.clear();
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  usePermissions.getState().dismissSessionPrompts("sub1");
  usePermissions.getState().dismissSessionPrompts("main1");
  useInteractive.getState().dismissSession("sub1");
  useInteractive.getState().dismissSession("main1");
  // The session-switch cases below work with a SECOND session (`main2`) and its
  // own child (`sub2`); left seeded they would change the board set the NEXT
  // case derives (the derivation is keyed by parent, but the parent switch is
  // exactly what those cases exercise).
  useInteractive.getState().dismissSession("main2");
  useInteractive.getState().dismissSession("sub2");
  useSessions.setState({ messages: {}, activeSessionId: null });
});

describe("SidePane (the status panel)", () => {
  it("renders NO sections when there are no todos", () => {
    const { container } = render(<SidePane />);
    // The section is data-gated (the ZCode `canRender*` treatment): an
    // empty pane is an empty frame — no "No todos yet" placeholders.
    expect(screen.queryByText("Todos")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows the session title (the first user message, truncated to 80 chars) at the top of the pane", () => {
    // The old chat header's title moved here (the header is gone): the
    // first `user` message, truncated to ~80 chars (the SAME derivation
    // the sidebar rows use).
    const long = "x".repeat(120);
    useSessions.setState({
      activeSessionId: "main1",
      messages: {
        main1: [{ kind: "user", text: long, at: Date.now() }],
      },
    });
    render(<SidePane />);
    const title = screen.getByText(long.slice(0, 80));
    expect(title).toBeTruthy();
    // The title sits ABOVE the Todos section (the pane's top section).
    const todos = screen.queryByText("Todos");
    expect(todos).toBeNull(); // no todos — but the title still renders
    // (the title is NOT data-gated on todos).
  });

  it("falls back to the Space's base name when the session has no user message yet", () => {
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: false,
        },
      ],
      messages: {},
    });
    render(<SidePane />);
    // No `user` message → the title is the active session's cwd's base
    // name (a session whose cwd is no known Space still shows its
    // folder's base name).
    expect(screen.getByText("MyProject")).toBeTruthy();
  });

  it("shows the GENERATED title in place of the message truncation (a titled session is labelled by its title)", () => {
    // The naming pass writes a real title; the pane must show IT, not the
    // first prompt's first 80 chars. The message is deliberately longer
    // and completely different, so the assertion cannot pass by accident.
    const longPrompt =
      "Please implement the session naming port across the store, the sidebar and the header, with tests for every case";
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: false,
          title: "Porting the session namer",
        },
      ],
      messages: {
        main1: [{ kind: "user", text: longPrompt, at: Date.now() }],
      },
    });
    render(<SidePane />);
    expect(screen.getByText("Porting the session namer")).toBeTruthy();
    expect(screen.queryByText(longPrompt.slice(0, 80))).toBeNull();
  });

  it("reads the stored title from the ARCHIVED membership (the title lookup walks all three session lists)", () => {
    // A session opened from the Archived section has no `sessions` entry;
    // its title is read off `archivedSessions` exactly as its `cwd` is.
    useSessions.setState({
      activeSessionId: "arch1",
      sessions: [],
      historySessions: [],
      archivedSessions: [
        {
          sessionId: "arch1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: true,
          title: "A titled archived session",
        },
      ],
      messages: {
        arch1: [{ kind: "user", text: "Archive the logs", at: Date.now() }],
      },
    });
    render(<SidePane />);
    expect(screen.getByText("A titled archived session")).toBeTruthy();
    expect(screen.queryByText("Archive the logs")).toBeNull();
  });

  it("still truncates the first user message when the session's title is explicitly null", () => {
    // `title: null` is the shape the backend writes before the naming pass
    // (and when naming is off) — the OLD derivation must survive it
    // untouched, or every untitled session loses its label.
    const prompt = "Refactor the parser so the grammar is table-driven";
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/MyProject",
          capabilities: {},
          archived: false,
          title: null,
        },
      ],
      messages: { main1: [{ kind: "user", text: prompt, at: Date.now() }] },
    });
    render(<SidePane />);
    expect(screen.getByText(prompt)).toBeTruthy();
  });

  it("renders the Todos section (label + N/M + progress) when there are open todos", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "a", status: "pending" },
        { content: "b", status: "completed" },
      ],
    });
    const { container } = render(<SidePane />);
    // The section label + the open-count derivation (1 of 2 open).
    expect(screen.getByText("Todos")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).not.toBeNull();
  });

  it("hides the Todos section when all todos are completed", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
      ],
    });
    render(<SidePane />);
    expect(screen.queryByText("Todos")).toBeNull();
    expect(screen.queryByText("1/2")).toBeNull();
  });

  // -- Auto OPEN (the "popup" rule, ADR 0042: the frame expands on the
  // -- 0 → >0 edge of the TODO BOARD count — the parent's own list or a running
  // -- child's — and NEVER collapses itself; edge-triggered, so the user's own
  // -- toggle always wins) --

  it("auto-expands the frame when open todos appear (0 → visible)", () => {
    useSessions.setState({ activeSessionId: "main1" });
    liveSessions("main1");
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // Open todos appear (the 0 → visible edge): the frame EXPANDS.
    act(() => {
      useInteractive.getState().applyTodoUpdate("main1", {
        source: "main",
        todos: [{ content: "a", status: "pending" }],
      });
    });
    expect(frame.style.width).toBe("320px");
  });

  it("does NOT auto-expand on mount when todos already exist (no 0 → visible edge on the first render)", () => {
    useSessions.setState({ activeSessionId: "main1" });
    liveSessions("main1");
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    // The pane was collapsed while the todos were already open: the first
    // render is NOT an edge — the user's collapsed choice is respected.
    expect((container.firstChild as HTMLElement).style.width).toBe(`${SIDE_PANE_RAIL}px`);
  });

  it("does NOT auto-collapse when all todos complete (ADR 0042)", () => {
    // ADR 0042: the frame may OPEN itself and NEVER close itself. A board
    // finishing (`visible` 1 → 0) is not a reason to hide the surface that just
    // showed it — with child boards counted (ADR 0041) that dip is routine (one
    // child done while its siblings work), and it used to yank the pane away
    // mid-run. The user's own toggle is the ONLY thing that collapses it.
    useSessions.setState({
      activeSessionId: "main1",
      messages: {
        main1: [{ kind: "user", text: "Run the whole board", at: Date.now() }],
      },
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // The 0 → 1 edge: the frame opens itself.
    act(() => {
      useInteractive.getState().applyTodoUpdate("main1", {
        source: "main",
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      });
    });
    expect(frame.style.width).toBe("320px"); // auto-expanded
    // Every item completed (the 1 → 0 edge): the frame STAYS OPEN.
    act(() => {
      useInteractive.getState().applyTodoUpdate("main1", {
        source: "main",
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "completed" },
        ],
      });
    });
    expect(frame.style.width).toBe("320px");
    expect(getSidePaneCollapsed()).toBe(false);
    // The accepted consequence: a finished run leaves an OPEN frame whose
    // data-gated Todos section is simply gone — the session title remains, so
    // the frame is not an empty box.
    expect(screen.queryByText("Todos")).toBeNull();
    expect(screen.getByText("Run the whole board")).toBeTruthy();
  });

  it("does NOT auto-expand the frame when a subagent session with NO todo board starts", () => {
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // A subagent starts, and writes no list: NO 0 → visible edge (the pane
    // opens on OPEN BOARDS, not on the existence of a child — a child with
    // nothing to show has nothing to say), so the frame STAYS COLLAPSED.
    // The entry's `parentSessionId` is `"main1"` while this file's
    // `beforeEach` leaves `activeSessionId: null`, which is the other half of
    // what this pins: another Session's child never opens THIS pane.
    act(() => {
      useSubagents.getState().addSession(entry);
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
  });

  it("auto-expands the frame when a running child's open todo board appears (0 → visible)", () => {
    // The board-wide visibility rule (ADR 0042's premise): a delegation whose
    // PARENT never wrote a list still opens the pane, because the child's board
    // counts. Modelled on the parent-todos case above, NOT on a seed-before-
    // render: `useSessions` needs the active session (`useTodoBoards(null)` is
    // the frozen empty array, so without it this case could never pass), and
    // both writes must land AFTER the mount — seeding first initialises
    // `prevVisibleRef` to `true`, which kills the 0 → 1 edge the frame follows.
    useSessions.setState({ activeSessionId: "main1" });
    liveSessions("main1");
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useSubagents.getState().addSession(entry);
      useInteractive.getState().applyTodoUpdate("sub1", {
        source: "native",
        todos: [{ content: "child one", status: "pending" }],
      });
    });
    expect(frame.style.width).toBe("320px");
    // And the child's board is what the opened pane shows.
    expect(
      container.querySelector('[data-testid="todo-board-child"]'),
    ).not.toBeNull();
  });

  // -- The SESSION SWITCH is not an edge --
  //
  // `visible` is derived from the ACTIVE session while the collapsed flag is
  // APP-GLOBAL (it is what localStorage persists). So landing on another
  // Session whose board is already open moves `visible` `false → true` without
  // anything appearing in front of the user, and ADR 0042's open-only rule was
  // reasoned only about the within-session 0 → 1 edge. A switch therefore
  // re-baselines the previous-visible ref and never writes the flag.
  //
  // The HYDRATION GAP after a switch is not an edge either (the case further
  // down): `openSession` flips the id while `loadHistory` is still in flight,
  // and a stored session's board is SEEDED from that transcript, so `visible`
  // would otherwise go `false → true` a tick after the switch.
  //
  // What the cases below actually pin is the flag not being written. The
  // `prevVisibleRef` re-baseline is a DEFENSIVE line rather than the thing those
  // two cases test: the open arm can only fire on an arrival from `false`, so a
  // switch that lands on an already-visible board is caught by the
  // `prevSessionIdRef` guard whichever value the visible ref holds. Which case is
  // sensitive to what is stated per case, because a comment that overstates its
  // own pin is worse than none:
  //   - the hydration case reddens only without the `!prevHydratedRef.current`
  //     half of the guard (re-baselining while `!hydrated` alone does NOT catch
  //     it — `hydrated` and `visible` flip in the same commit);
  //   - the `re-baselines the visible ref …` case is the one that reddens if
  //     `prevVisibleRef.current = visible` is deleted from the suppression
  //     branch (measured: it is the only case in the file that does).

  it("does NOT auto-expand when a SESSION SWITCH lands on a session whose parent board is already open", () => {
    useSessions.setState({ activeSessionId: "main1" });
    // BOTH sessions hydrated, so this pins the RE-BASELINE and not the
    // hydration suppression (the case below covers the un-hydrated half).
    liveSessions("main1", "main2");
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // Session B's board is open BEFORE the user lands on it: nothing appears
    // while they look, so there is no board APPEARING to popup for.
    act(() => {
      useInteractive.getState().applyTodoUpdate("main2", {
        source: "native",
        todos: [{ content: "board in the other session", status: "pending" }],
      });
    });
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    // The switch is not an edge: the frame keeps the user's collapsed choice.
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    expect(getSidePaneCollapsed()).toBe(true);
    // CONTENT, not evidence about the frame: collapsing CLIPS the pane rather
    // than unmounting it (`invisible` + `overflow-hidden`), so its text is in the
    // document in BOTH states. This only says the clipped pane is now holding the
    // session the user landed on; the width assertion above is what says the
    // frame stayed shut.
    expect(screen.getByText("board in the other session")).toBeTruthy();
  });

  it("does NOT auto-expand when a SESSION SWITCH lands on a session whose CHILD board is already open", () => {
    // The half that made this edge COMMON: child boards count toward `visible`
    // (ADR 0041/0042), so a delegation running in ANOTHER session used to open
    // this pane the moment the user switched to that session.
    useSessions.setState({ activeSessionId: "main1" });
    // Hydrated on both sides (see the case above): the switch is what is pinned.
    liveSessions("main1", "main2");
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub2",
        parentSessionId: "main2",
        agentName: "builder",
        task: "build in the other session",
        status: "running",
      });
      useInteractive.getState().applyTodoUpdate("sub2", {
        source: "native",
        todos: [
          { content: "child board in the other session", status: "pending" },
        ],
      });
    });
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    expect(getSidePaneCollapsed()).toBe(true);
    // CONTENT only (see the case above — a collapsed pane is clipped, not
    // unmounted): the other session's child block is mounted behind the sliver,
    // and the width assertion above is what says the frame did not open for it.
    expect(
      container.querySelector('[data-testid="todo-board-child"]'),
    ).not.toBeNull();
  });

  it("does NOT auto-expand when the session it SWITCHED TO hydrates a board that was already in its transcript (the openSession → loadHistory gap)", () => {
    // The round-2 finding: the switch suppression did not survive HYDRATION.
    // `useSessions.openSession` flips `activeSessionId` SYNCHRONOUSLY and loads
    // the transcript LATER (`void (async () => loadHistory(sessionId))`), so on
    // landing on a not-yet-loaded stored session `visible` is `false` AT the
    // switch, and the board starts existing only when the transcript lands —
    // `useInteractive.todos` is never persisted, so a stored session's parent
    // board comes ONLY from the `rawInput` seed (`useMainTodoItems`). That moves
    // `visible` `false → true` INSIDE the now-active session, one tick after the
    // switch: a textbook open edge for a board the user never saw appear. The
    // app already names this window in `chat/MessageList.tsx` ("the window
    // between `openSession` and `loadHistory` hydration").
    useSessions.setState({
      activeSessionId: "main1",
      messages: {
        main1: [{ kind: "user", text: "the session you were on", at: 1 }],
      },
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // The switch itself (what `openSession` does before its await): `main2` has
    // NO `messages` entry at all, so its board is not knowable yet.
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // …then hydration lands (`loadHistory` resolves and writes the transcript).
    // The `manage_todo_list` call that stored session already had in its
    // database seeds the board, so `visible` goes `false → true` right here.
    act(() => {
      useSessions.setState({
        messages: {
          main1: [
            { kind: "user", text: "the session you were on", at: 1 },
          ],
          main2: [
            { kind: "user", text: "the session you switched to", at: 2 },
            {
              kind: "tool-call",
              id: "t1",
              title: "manage_todo_list",
              status: "completed",
              at: 3,
              rawInput: {
                operation: "write",
                todoList: [
                  { content: "written before the switch", status: "pending" },
                ],
              },
            },
          ],
        },
      });
    });
    // Landing the transcript is NOT a board appearing in front of the user: the
    // board was in that session the whole time, only unreadable. The switch
    // stays a non-edge until the session it switched TO is knowable.
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    expect(getSidePaneCollapsed()).toBe(true);
    // The board really did arrive (so this is not a test of an empty session):
    // the hydrated seed is what the clipped pane now holds.
    expect(screen.getByText("written before the switch")).toBeTruthy();
  });

  it("stops suppressing the moment the session it SWITCHED TO is hydrated (a board written AFTER the transcript lands still opens the frame)", () => {
    // The other half of the hydration rule: the suppression must not become
    // permanent. The transcript that lands carries NO board (no
    // `manage_todo_list` call), so `visible` is still `false` when the gap
    // closes, and the list the session writes afterwards is a genuine 0 → 1 edge
    // in the session the user is now looking at.
    useSessions.setState({
      activeSessionId: "main1",
      messages: {
        main1: [{ kind: "user", text: "the session you were on", at: 1 }],
      },
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useSessions.setState({
        messages: {
          main1: [
            { kind: "user", text: "the session you were on", at: 1 },
          ],
          main2: [{ kind: "user", text: "the session you switched to", at: 2 }],
        },
      });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // The transcript has landed, so edges are being judged again: this is the
    // same-session 0 → 1 open the pane has always performed.
    act(() => {
      useInteractive.getState().applyTodoUpdate("main2", {
        source: "native",
        todos: [{ content: "written after hydration", status: "pending" }],
      });
    });
    expect(frame.style.width).toBe("320px");
    expect(getSidePaneCollapsed()).toBe(false);
  });

  it("still auto-expands for a board that appears in the session it SWITCHED TO (the same-session edge survives)", () => {
    // The other half of the fix: re-baselining must not disable auto-open. The
    // switch itself carries no board, so the frame is still collapsed after it;
    // the board then LANDS while the user is looking at that session — a
    // genuine 0 → 1 edge inside the active session.
    useSessions.setState({ activeSessionId: "main1" });
    // Hydrated on both sides: the suppression ends with the transcript, so a
    // session that has one behaves exactly as it did before the gap existed.
    liveSessions("main1", "main2");
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useInteractive.getState().applyTodoUpdate("main2", {
        source: "native",
        todos: [{ content: "a board that appears after the switch", status: "pending" }],
      });
    });
    expect(frame.style.width).toBe("320px");
    expect(getSidePaneCollapsed()).toBe(false);
  });

  it("still auto-expands for a CHILD board that lands after the switch, in the session it SWITCHED TO", () => {
    useSessions.setState({ activeSessionId: "main1" });
    liveSessions("main1", "main2");
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    // The other session's child exists but has written no list yet: switching
    // to it opens nothing (unchanged rule), and the ref is re-baselined.
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub2",
        parentSessionId: "main2",
        agentName: "builder",
        task: "build in the other session",
        status: "running",
      });
    });
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // The child's FIRST list arrives while the user is on that session.
    act(() => {
      useInteractive.getState().applyTodoUpdate("sub2", {
        source: "native",
        todos: [{ content: "a child board after the switch", status: "pending" }],
      });
    });
    expect(frame.style.width).toBe("320px");
    expect(getSidePaneCollapsed()).toBe(false);
  });

  it("re-baselines the visible ref to the NEW session's visibility, so a stale `true` cannot disable auto-open there", () => {
    // The case that makes `prevVisibleRef.current = visible` inside the
    // suppression branch load-bearing rather than decorative. The user leaves a
    // session whose board is OPEN (visible `true`), lands on a stored one that
    // hydrates WITHOUT a board, and that session then writes its first list.
    // A visible ref left holding the previous session's `true` would leave the
    // open arm unable to fire ever again in the session they are now looking at.
    useSessions.setState({ activeSessionId: "main1" });
    liveSessions("main1");
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "native",
      todos: [{ content: "open in the session you were on", status: "pending" }],
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    // Mount is not an edge even though the board is open (the existing mount pin
    // above), so the frame starts shut with `visible === true`.
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useSessions.setState({ activeSessionId: "main2" });
    });
    // Hydration lands a transcript with no board in it: `visible` is `false` in
    // the new session, and THAT is what the baseline must now hold.
    act(() => {
      useSessions.setState({
        messages: {
          main1: [{ kind: "user", text: "the session you were on", at: 1 }],
          main2: [{ kind: "user", text: "the session you switched to", at: 2 }],
        },
      });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    act(() => {
      useInteractive.getState().applyTodoUpdate("main2", {
        source: "native",
        todos: [
          { content: "the new session's first list", status: "pending" },
        ],
      });
    });
    expect(frame.style.width).toBe("320px");
    expect(getSidePaneCollapsed()).toBe(false);
  });

  it("respects a MANUAL collapse while work is in flight (a change without the edge does not re-expand)", () => {
    useSessions.setState({ activeSessionId: "main1" });
    liveSessions("main1");
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    act(() => {
      useInteractive.getState().applyTodoUpdate("main1", {
        source: "main",
        todos: [{ content: "a", status: "pending" }],
      });
    });
    expect(frame.style.width).toBe("320px"); // auto-expanded
    // The user manually collapses (the header toggle) while work is open.
    act(() => {
      setSidePaneCollapsed(true);
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // Another todo arrives (1 → 2 — still visible, NO edge): the manual
    // collapse is respected (no re-expand).
    act(() => {
      useInteractive.getState().applyTodoUpdate("main1", {
        source: "main",
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      });
    });
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
  });

  // -- The footer toggle (the old header's toggle moved to the frame's
  // -- bottom-right; the collapsed rail keeps it reachable) --

  // -- The pane's OWN collapse toggle (bottom-inner corner = bottom LEFT for
  // -- the right pane, pointing back at the chat). It stays HERE in BOTH states:
  // -- the chrome bar holds NO pane control, open or collapsed — see
  // -- `App.test.tsx`'s `the chrome bar NEVER holds a pane control`. --

  it("holds its own collapse toggle at the frame's inner-bottom corner", () => {
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    const collapse = screen.getByRole("button", { name: "Collapse side pane" });
    expect(frame.contains(collapse)).toBe(true);
    // Anchored to the frame's bottom-left — the INNER side for a right-hand
    // pane (it points back at the chat). Asserted as classes because jsdom
    // resolves no layout: `absolute` + both bottom and left, so it cannot
    // silently migrate to the outer edge.
    const cls = collapse.className;
    expect(cls).toMatch(/absolute/);
    expect(cls).toMatch(/\bbottom-/);
    expect(cls).toMatch(/\bleft-/);
    expect(cls).not.toMatch(/\bright-/);
    expect(cls).not.toMatch(/\btop-/);
    // Pressed = open, the same meaning the chrome bar's control carries.
    expect(collapse.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Expand side pane" })).toBeNull();
  });

  it("insets the toggle clear of the 4px resize handle (the handle stays grabbable full-height)", () => {
    render(<SidePane />);
    const collapse = screen.getByRole("button", { name: "Collapse side pane" });
    const left = collapse.className.match(/\bleft-\[?([0-9]+)\]?/);
    expect(left, "the toggle is not offset from the left edge").toBeTruthy();
    // Tailwind spacing = 4px; the handle is `w-1` = 4px. The toggle must start
    // at least one unit clear of it, or resizing is impossible in that band.
    const unit = left![1].includes("[") ? Number(left![1]) : Number(left![1]) * 4;
    expect(unit, `left offset ${unit}px sits on the 4px handle`).toBeGreaterThanOrEqual(8);
  });

  it("KEEPS its toggle while collapsed, in the sliver — it never moves to the chrome bar", () => {
    setSidePaneCollapsed(true);
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // The STABLE hook: the label flips with the state, so a name query would
    // miss on exactly the collapsed side this test checks.
    const collapse = screen.getByTestId("right-pane-toggle");
    expect(frame.contains(collapse)).toBe(true);
    // One control does both jobs (no shortcut exists for this pane), and the
    // label flips to the direction it now performs.
    expect(container.querySelectorAll('[data-testid="right-pane-toggle"]').length).toBe(1);
    expect(collapse.getAttribute("aria-label")).toBe("Expand side pane");
    expect(collapse.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(collapse);
    expect(getSidePaneCollapsed()).toBe(false);
  });

  it("hides the resize handle while collapsed (resizing a 40px sliver is moot) but keeps the toggle", () => {
    setSidePaneCollapsed(true);
    const { container } = render(<SidePane />);
    expect(container.querySelector(".cursor-col-resize")).toBeNull();
    expect(screen.getByTestId("right-pane-toggle")).toBeTruthy();
  });

  it("collapses to the sliver (the content stays mounted, clipped — the pane keeps its own toggle)", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    // The content (the Todos section) is clipped (the 40px rail +
    // `overflow: hidden`) — NOT unmounted, so the board's scroll position and
    // its todo state stay alive across the collapse.
    expect(screen.queryByText("Todos")).not.toBeNull();
    // Expanding via the shared flag restores the full frame.
    act(() => {
      setSidePaneCollapsed(false);
    });
    expect(frame.style.width).toBe("320px");
  });

  it("paints the tick/dot overview while collapsed, and NOT while open", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ],
    });
    // A running child with a board of its own: the sliver must show it as its
    // OWN mark, not fold it into the parent's or drop it.
    useSubagents.getState().addSession(entry);
    useInteractive.getState().applyTodoUpdate("sub1", {
      source: "native",
      todos: [{ content: "child one", status: "pending" }],
    });
    // A SECOND running child that has written NO todo list at all. THIS is what
    // pins the rail's SCOPE: it iterates BOARDS, not `useSubagents` entries, so
    // a running child with no list is neither a mark nor a term in the
    // accessible name (rule 4 of `todoBoardsOf`). Before this entry existed both
    // children in the fixture had a board, so the two shapes were
    // indistinguishable and the rail could have been re-pointed at
    // `Object.values(entries)` with every assertion below still passing.
    useSubagents.getState().addSession({
      sessionId: "sub2",
      parentSessionId: "main1",
      agentName: "builder",
      task: "build the thing",
      status: "running",
    });
    const { rerender } = render(<SidePane />);
    // Open: the board is the readout — no second copy of it.
    expect(screen.queryByTestId("todo-rail")).toBeNull();
    act(() => {
      setSidePaneCollapsed(true);
    });
    rerender(<SidePane />);
    // Collapsed: the marks are the only thing the sliver can show, so they
    // appear — one per BOARD (the parent's list first, then each child), NOT one
    // per item: three parent rows plus one child row is TWO marks.
    const marks = screen.getAllByTestId("todo-mark");
    // TWO, not three: the board-less `sub2` draws no mark.
    expect(marks).toHaveLength(2);
    // The parent leads, and it is the live one (`in_progress` → the hot dot);
    // the child is waiting.
    expect(marks[0]!.className).toContain("bg-warning");
    expect(marks[1]!.className).not.toContain("bg-warning");
    // And every board is named, each with its OWN count — and ONLY the boards:
    // no `builder` term, because the board-less child is not on the rail.
    expect(
      screen.getByTestId("todo-rail").getAttribute("aria-label"),
    ).toBe("Todos — this session 1/3, reviewer 0/1");
  });

  it("hides the board's text in the sliver (the one-character-per-line column) while keeping it mounted", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a very long todo label", status: "pending" }],
    });
    // A child board too, so the board area has text from BOTH levels: its block
    // stays MOUNTED inside the `invisible` scroller (clipped, not unmounted),
    // which is exactly why the rail's no-text assertion below is scoped to the
    // rail and not to the container.
    useSubagents.getState().addSession(entry);
    useInteractive.getState().applyTodoUpdate("sub1", {
      source: "native",
      todos: [{ content: "a child label that must not leak", status: "pending" }],
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    // The scroller is `invisible` while collapsed: `visibility: hidden` takes
    // an element AND ITS SCROLLBAR out of the paint without touching layout, so
    // the content stays mounted (the mount-preserving collapse this pane is
    // built on) and no scrollbar is left in the sliver. `hidden`/`display:none`
    // would unlayout it; clipping alone (the old behavior) left both the
    // wrapped text and its scrollbar bleeding into the 40px column.
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.className).toContain("invisible");
    // Still mounted, and still the only copy of the text (the rail is
    // text-free), so a screen reader gets one summary, not a label and a copy.
    expect(screen.getByText("a very long todo label")).toBeTruthy();
    expect(screen.getByText("a child label that must not leak")).toBeTruthy();
    // The rail itself is text-free: the marks carry the boards, and the boards'
    // own labels are `invisible` behind them, so the collapsed tree holds one
    // summary (the rail's `aria-label`) and no painted copy of any label.
    expect(screen.getByTestId("todo-rail").textContent).toBe("");
    // And it comes back when the pane opens.
    act(() => {
      setSidePaneCollapsed(false);
    });
    expect(
      (container.querySelector(".overflow-y-auto") as HTMLElement).className,
    ).not.toContain("invisible");
  });

  it("shows NO overview strip when there are no todos (the rail is just the rail)", () => {
    act(() => {
      setSidePaneCollapsed(true);
    });
    render(<SidePane />);
    expect(screen.queryByTestId("todo-rail")).toBeNull();
  });

  it("flushes the drag width to localStorage on mouseup only (not on every mousemove)", () => {
    const { container } = render(<SidePane />);
    const handle = container.querySelector(".cursor-col-resize") as HTMLElement;
    const line = handle.querySelector("div") as HTMLElement;
    // `pointerdown` (the event carrying `pointerId` — `mousedown` does not
    // in the DOM) starts the drag and captures the pointer.
    fireEvent.pointerDown(handle);
    // Dragging: the line is visible (the class ends with `opacity-100`;
    // the non-drag class ends with `hover:opacity-100` — anchor at the end).
    expect(line.className).toMatch(/ opacity-100$/);
    fireEvent.mouseMove(window, { clientX: 300 });
    // The live width updates (320 - 300 clamped to the 240 min) but
    // localStorage is NOT written mid-drag.
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("240px");
    expect(localStorage.getItem("side-pane-width")).toBeNull();
    // The release (captured: delivered to the handle even outside the
    // webview) flushes the width ONCE and ends the drag.
    fireEvent.pointerUp(handle);
    expect(localStorage.getItem("side-pane-width")).toBe("240");
    expect(line.className).not.toMatch(/ opacity-100$/);
  });

  it("still ends the drag and flushes the width when releasePointerCapture throws", () => {
    const { container } = render(<SidePane />);
    const handle = container.querySelector(".cursor-col-resize") as HTMLElement;
    const line = handle.querySelector("div") as HTMLElement;
    // An expired `pointerId` / non-compliant webview: `releasePointerCapture`
    // throws — the drag must still end (the width must still flush; `dragging`
    // must NOT stick on).
    const release = vi
      .spyOn(handle, "releasePointerCapture")
      .mockImplementation(() => {
        throw new Error("InvalidPointerId");
      });
    try {
      fireEvent.pointerDown(handle);
      expect(line.className).toMatch(/ opacity-100$/);
      fireEvent.mouseMove(window, { clientX: 300 });
      fireEvent.pointerUp(handle);
      expect(line.className).not.toMatch(/ opacity-100$/);
      expect(localStorage.getItem("side-pane-width")).toBe("240");
    } finally {
      release.mockRestore();
    }
  });

  it("ends the drag on window blur (a release outside the webview)", () => {
    const { container } = render(<SidePane />);
    const handle = container.querySelector(".cursor-col-resize") as HTMLElement;
    const line = handle.querySelector("div") as HTMLElement;
    fireEvent.pointerDown(handle);
    expect(line.className).toMatch(/ opacity-100$/);
    fireEvent.mouseMove(window, { clientX: 300 });
    // The pointer is lost (released outside the webview): `blur` must end
    // the drag (it does NOT leave `dragging` stuck on).
    fireEvent.blur(window);
    expect(line.className).not.toMatch(/ opacity-100$/);
    expect(localStorage.getItem("side-pane-width")).toBe("240");
  });

  it("collapses the frame to the sliver and re-opens", () => {
    const { container } = render(<SidePane />);
    // The module seeds the flag from localStorage at import — the flag is
    // false, the frame is at its width.
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("320px");
    act(() => {
      setSidePaneCollapsed(true);
    });
    // The `w-0 overflow-hidden` mechanism (NOT `display: none` / unmount): the
    // pane's OWN content stays mounted, so re-opening never rebuilds it. (The
    // old version of this test also asserted a pending subagent
    // `SudoPasswordModal` was still in the document here — the gate host moved
    // to the `App` root, so that guarantee is pinned in `App.test.tsx`.)
    expect(frame.style.width).toBe(`${SIDE_PANE_RAIL}px`);
    expect(frame.className).toContain("overflow-hidden");
    act(() => {
      setSidePaneCollapsed(false);
    });
    expect(frame.style.width).toBe("320px");
  });

  it("the right rail is WIDE ENOUGH to show its toggle (the sliver is a guarantee, not a vibe)", () => {
    // The entire design rests on one number: a collapsed pane keeps a sliver
    // of width so its bottom toggle stays on screen. jsdom never clips, so NO
    // DOM assertion here can notice a rail that shrank below the button — the
    // toggle would silently vanish while every test stayed green and the pane
    // became unopenable (no keyboard shortcut exists). Hence arithmetic:
    //   24px button (`size-6`) + 8px inset/padding + 8px clear of the edge.
    expect(SIDE_PANE_RAIL).toBeGreaterThanOrEqual(24 + 8 + 8);
  });
});
