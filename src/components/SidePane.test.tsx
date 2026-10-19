import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SidePane from "./SidePane";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { useSessions } from "../store/sessions";
import type { Message } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { setSessionConfigOption } from "../lib/tauri";
import { getSidePaneCollapsed, setSidePaneCollapsed, SIDE_PANE_RAIL } from "../lib/sidePaneState";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    // The pane's config block WRITES through this (the model picker's `onSet`):
    // un-mocked, the real export reaches `invoke` and rejects on jsdom's missing
    // `window.__TAURI_INTERNALS__`, so the write-path test would be pinning a
    // rejection instead of the call. Resolves to a fresh option list (what the
    // command returns) so `applyConfigOptions` has something to apply.
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
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
  // The WHOLE session slice, not just `messages`: the relocated config-block
  // cases (Model / Reasoning / Context, ported from `ChatStream.test.tsx`) seed
  // `sessions` / `historySessions` / `configOptions` / `contextUsage`, and the
  // pane reads all of them for that block. Left seeded, a config case would leak
  // a live session into the pane's own cases — which read the store for the
  // title, the boards AND (now) the config block.
  vi.mocked(setSessionConfigOption).mockClear();
  useSessions.setState({
    messages: {},
    activeSessionId: null,
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    spaces: [],
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    contextUsage: {},
    compacting: {},
  });
});

/**
 * Seed a LIVE session (the shape `ChatStream.test.tsx`'s `seedLiveSession`
 * used — these config-block cases came from that file). `id` stays `s1` so the
 * ported fixtures could move verbatim.
 */
function seedLiveSession(): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [
      { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
    ],
    spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
    historySessions: [],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    contextUsage: {},
  });
}

/**
 * Seed a STORED (non-live) session: `sessions` is empty, the session lives in
 * `historySessions`, so the pane's block treats it as closed (the selectors are
 * populated but DISABLED).
 */
function seedStoredSession(capabilities: Record<string, unknown> = {}): void {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [],
    spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
    historySessions: [
      { sessionId: "s1", cwd: "/home/u/proj", capabilities, archived: false },
    ],
    messages: { s1: [] },
    inTurn: {},
    stopReasons: {},
    closeReasons: {},
    configOptions: {},
    contextUsage: {},
  });
}

describe("SidePane (the status panel)", () => {
  it("renders NO TODO section when there are no todos (the config block is always there)", () => {
    const { container } = render(<SidePane />);
    // The todo section is data-gated (the ZCode `canRender*` treatment): an
    // empty board is no section at all — no "No todos yet" placeholder.
    expect(screen.queryByText("Todos")).toBeNull();
    // What the frame DOES hold, always: the config block (Model / Reasoning /
    // Context). It is not data-gated, so with no active session it renders the
    // two DISABLED stubs and an empty 0% track — the same treatment a closed
    // session gets (the pane cannot know a config it does not have, but the
    // control's identity stays). The pane's frame is therefore never empty
    // text-wise; only its TODO content is.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block).toBeTruthy();
    expect((screen.getByRole("button", { name: "Model" }) as HTMLButtonElement).hasAttribute("disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "Thinking" }) as HTMLButtonElement).hasAttribute("disabled")).toBe(true);
    const bar = block.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(block.querySelector('[data-testid="context-usage"]')).toBeNull();
    // And nothing else: the frame's text is exactly the block's two stub labels
    // (no todo copy hiding behind them). The `○` is the thinking stub's
    // off-level glyph, which precedes its label inside the trigger. Read on
    // `container` rather than on the block, so a stray label elsewhere in the
    // frame would show up here — the toggle button and (with no session, hence
    // no boards) the rail both carry zero text.
    expect(container.textContent).toBe("Model○Thinking");
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

  // ===========================================================================
  // THE CONFIG BLOCK (Model / Reasoning / Context) — the three lines that left
  // the composer's bottom row and now sit pinned at the bottom of this pane.
  //
  // These cases were ported from `ChatStream.test.tsx` when the surface moved;
  // only the render target and the container they query changed. Read them as
  // the block's contract, not as history: the composer no longer hosts ANY of
  // these controls (pinned by the "composer no longer hosts" cases there).
  //
  // The behaviour the move had to preserve, all of it previously living in
  // `ChatStream`'s derivations and now in `src/lib/sessionConfig.ts`:
  //   - the four-way fallback for BOTH config options and context usage (the
  //     live map → `sessions` → `historySessions` → `archivedSessions`),
  //   - `disabled` for a session that is not live,
  //   - the traffic-light ramp (success < 50, caution < 70, warning < 90,
  //     destructive from 90).
  // ===========================================================================

  it("renders the config block for a closed (history-only) session (the stubs + the empty track — there is no `isLive` gate on rendering)", () => {
    seedStoredSession();
    const { container } = render(<SidePane />);
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block).toBeTruthy();
    // The context bar renders (an empty 0% track — the session's context is
    // dropped on close and re-emits on resume; the label waits for data).
    const bar = block.querySelector(
      '[data-testid="context-usage-bar"]',
    ) as HTMLElement;
    expect(bar).toBeTruthy();
    const progress = bar.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(progress.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.querySelector('[data-testid="context-usage"]')).toBeNull();
    // The model/thinking selects render as DISABLED stubs (the config
    // options are dropped on close — no data to show; the identity stays).
    const model = block.querySelector('[aria-label="Model"]') as HTMLElement;
    expect(model).toBeTruthy();
    expect(model.hasAttribute("disabled")).toBe(true);
    const thinking = block.querySelector(
      '[aria-label="Thinking"]',
    ) as HTMLElement;
    expect(thinking).toBeTruthy();
    expect(thinking.hasAttribute("disabled")).toBe(true);
  });

  it("a live session WITH a model + thinking config option renders BOTH selects IN THE PANE (the composer carries neither)", async () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [
              { value: "acme/alpha", name: "acme/Alpha" },
              { value: "acme/beta", name: "acme/Beta" },
            ],
          },
          {
            id: "thought_level",
            name: "Thinking",
            type: "select",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
            ],
          },
        ],
      },
    });
    const { container } = render(<SidePane />);
    // The pane's block carries the model/thought controls (it used to be the
    // composer's toolbar — left of the send button).
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block.querySelector('[aria-label="Model"]')).toBeTruthy();
    expect(block.querySelector('[aria-label="Thinking"]')).toBeTruthy();
    // The model trigger shows the BARE id + the provider suffix (the
    // composed `provider/id` key is the VALUE, not the display text).
    expect(screen.getByText(/alpha/)).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
  });

  it("stacks the three lines ONE PER LINE in the order Model → Reasoning → Context (they are no longer a side-by-side cluster)", () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [{ value: "acme/alpha", name: "acme/Alpha" }],
          },
          {
            id: "thought_level",
            name: "Thinking",
            type: "select",
            currentValue: "medium",
            options: [{ value: "medium", name: "Medium" }],
          },
        ],
      },
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    // The old composer premise was ONE tight cluster: both triggers inside one
    // wrapper whose `gap-1` was tighter than the `gap-2` separating the cluster
    // from Send. That premise died with the move — the pane is 240–480px wide
    // and stacks, so the contract is now ORDER and ONE CONTROL PER LINE.
    const lines = Array.from(
      container.querySelectorAll('[data-testid="session-config-controls"] > div'),
    ) as HTMLElement[];
    expect(lines).toHaveLength(3);
    // One control per line (a line holding two is the old cluster back again),
    // in the stated order.
    expect(lines[0]!.querySelector('[aria-label="Model"]')).toBeTruthy();
    expect(lines[0]!.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(lines[1]!.querySelector('[aria-label="Thinking"]')).toBeTruthy();
    expect(lines[1]!.querySelector('[aria-label="Model"]')).toBeNull();
    expect(lines[2]!.getAttribute("data-testid")).toBe("context-usage-bar");
    // And each line is FULL WIDTH (`w-full` on the trigger, `flex-1` on the
    // bar's track) rather than hugging its text.
    expect(
      (lines[0]!.querySelector('[aria-label="Model"]') as HTMLElement).className,
    ).toContain("w-full");
    expect(
      (lines[1]!.querySelector('[aria-label="Thinking"]') as HTMLElement).className,
    ).toContain("w-full");
    // The vertical stack (`flex-col`) is what makes them lines rather than a row.
    const group = container.querySelector(
      '[data-testid="session-config-controls"]',
    ) as HTMLElement;
    expect(group.className).toContain("flex-col");
  });

  // --- The context bar (the dynamic percentage — a progress bar with the
  // reference UI's `🧠 [====bar====] 61%` look). ---

  it("renders a dynamic context bar in the pane when the usage is known", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    // 53760 / 128000 = 42% — inside the pane's block (NOT the composer).
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const group = block.querySelector(
      '[data-testid="context-usage-bar"]',
    ) as HTMLElement | null;
    expect(group).toBeTruthy();
    const bar = group!.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement | null;
    expect(bar).toBeTruthy();
    expect(bar!.getAttribute("aria-valuemin")).toBe("0");
    expect(bar!.getAttribute("aria-valuemax")).toBe("100");
    expect(bar!.getAttribute("aria-valuenow")).toBe("42");
    // The fill's width follows the percentage, and 42% (< 50%) is the
    // green band (the label follows the fill's color).
    const fill = bar!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("42%");
    expect(fill.className).toContain("bg-success");
    expect(fill.className).not.toContain("bg-caution");
    // The label sits at the bar's right edge (the reference UI's `61%`).
    const labelEl = group!.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(labelEl.textContent).toBe("42%");
    expect(labelEl.className).toContain("text-success");
    // The brain icon cues the bar (the reference UI's `🧠` placement).
    expect(group!.querySelector('[data-testid="context-bar-icon"]')).toBeTruthy();
  });

  it("the Context line rides the pane's own plane — no well, no box", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<SidePane />);
    // The bar briefly lived in a `bg-input` WELL (it read as a sunken slot
    // inside the pane and the user asked for it gone — see the component
    // note). What must survive: the track's own token class on the fill, and
    // NO surface class on the row. Pinned as class assertions because jsdom
    // runs no layout; the contrast ratios live in the CSS gates, which now
    // grade against `--color-inspector` — the surface these pixels land on.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const row = block.querySelector(
      '[data-testid="context-usage-bar"]',
    ) as HTMLElement;
    expect(row.className).not.toContain("bg-");
    const bar = row.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.className).toContain("bg-context-track");
  });

  // The token counts are HOVER-ONLY on the number (the bar row is dense —
  // `53,760 / 128,000 tokens` inline would push the model selector off the
  // row, and the native `title` tooltip is unstyled and ~1s slow).
  it("the context number reveals the token counts on hover, not inline", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    render(<SidePane />);
    const label = screen.getByTestId("context-usage");
    // The inline text stays the bare percentage.
    expect(label.textContent).toBe("42%");
    // No native tooltip (the styled Radix one replaces it).
    expect(label.getAttribute("title")).toBeNull();
    // CLOSED until hover — the counts are not in the DOM at rest.
    expect(document.body.textContent).not.toContain("53,760");
    // Radix `TooltipTrigger` opens on pointer/focus (see the
    // `ToolCallCard` failure-tooltip test — `mouseEnter` does not fire it
    // in this Radix version; `focus` does; `TooltipProvider`'s
    // `delayDuration = 0` mounts the portal synchronously).
    fireEvent.focus(label);
    expect(document.body.textContent).toContain("53,760 / 128,000 tokens");
  });

  // The counts are keyboard-accessible: the tooltip trigger is a focusable
  // control (a Tab stop) whose accessible name carries the token counts,
  // and the progressbar exposes them as its text alternative — so nothing
  // about the context is hover-only.
  it("the context counts are reachable by keyboard, not hover alone", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    render(<SidePane />);
    const label = screen.getByTestId("context-usage");
    // A real control in the tab order (a bare `<span>` was not).
    expect(label.tagName).toBe("BUTTON");
    expect(label.getAttribute("tabindex")).not.toBe("-1");
    // The accessible name carries the counts (a screen reader hears them
    // without opening the tooltip).
    expect(label.getAttribute("aria-label")).toBe(
      "Context used: 53,760 of 128,000 tokens (42%)",
    );
    // The progressbar's text alternative carries them too.
    const bar = screen
      .getByTestId("context-usage-bar")
      .querySelector('[role="progressbar"][aria-label="Context used"]') as HTMLElement;
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "53,760 of 128,000 tokens (42%)",
    );
    // And focus (keyboard) opens the tooltip, as hover does.
    fireEvent.focus(label);
    expect(document.body.textContent).toContain("53,760 / 128,000 tokens");
  });

  it("a caution-band context percentage (50–69%) renders the fill in caution", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 78080, window: 128000 } },
    });
    render(<SidePane />);
    const group = screen.getByTestId("context-usage-bar");
    const bar = group.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("61");
    // 61% is the caution band (50–69%): caution (NOT green, NOT warning),
    // and the label follows the fill's color.
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-caution");
    expect(fill.className).not.toContain("bg-success");
    expect(fill.className).not.toContain("bg-warning");
    const label = group.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(label.textContent).toBe("61%");
    expect(label.className).toContain("text-caution");
  });

  it("a mid context percentage (70–89%) escalates the fill to the warning color", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 96000, window: 128000 } },
    });
    render(<SidePane />);
    const group = screen.getByTestId("context-usage-bar");
    const bar = group.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    // 75% is the warning band (70–89%): warning (NOT caution, NOT red),
    // and the label follows the fill's color.
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-warning");
    expect(fill.className).not.toContain("bg-caution");
    expect(fill.className).not.toContain("bg-destructive");
    const label = group.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(label.textContent).toBe("75%");
    expect(label.className).toContain("text-warning");
  });

  it("a high context percentage (>= 90%) escalates the fill to the destructive color", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 115200, window: 128000 } },
    });
    render(<SidePane />);
    const group = screen.getByTestId("context-usage-bar");
    const bar = group.querySelector(
      '[role="progressbar"][aria-label="Context used"]',
    ) as HTMLElement;
    expect(bar.getAttribute("aria-valuenow")).toBe("90");
    // 90% is the red band (90–100%): the destructive red (the label
    // follows the fill's color).
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-destructive");
    expect(fill.className).not.toContain("bg-warning");
    const label = group.querySelector('[data-testid="context-usage"]') as HTMLElement;
    expect(label.textContent).toBe("90%");
    expect(label.className).toContain("text-destructive");
  });

  it("renders an empty context bar (no label) when the usage is unknown", () => {
    seedLiveSession();
    useSessions.setState({ contextUsage: {} });
    render(<SidePane />);
    // The bar renders from the start (layout stability — the fill appears
    // as the session grows) but the label waits for the first frame.
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("0%");
    expect(bar.querySelector('[data-testid="context-usage"]')).toBeNull();
  });

  it("renders the context bar for a stored session as an empty 0% track (the context is dropped on close and re-emits on resume)", () => {
    seedStoredSession();
    render(<SidePane />);
    // The bar is ALWAYS rendered (there is no `isLive` gate on rendering): a
    // stored session's context is dropped on close — the track is the empty 0%
    // fill (the label waits for the resume to re-emit the usage).
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.queryByTestId("context-usage")).toBeNull();
  });

  it("renders the block POPULATED for a stored session (config options + context usage from the session row — the selectors are disabled)", () => {
    // The `list_sessions` shape: the row carries `configOptions` (the
    // stored `model` / `thinkingLevel` synthesized) + `contextUsage` (the
    // last known usage — persisted on every `context_usage_update` frame).
    useSessions.setState({
      activeSessionId: "s1",
      sessions: [],
      spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      historySessions: [
        {
          sessionId: "s1",
          cwd: "/home/u/proj",
          capabilities: { loadSession: true },
          archived: false,
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "tama/m1",
              options: [{ value: "tama/m1", name: "m1" }],
            },
            {
              id: "thought_level",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ],
          contextUsage: { used: 53760, window: 128000 },
        },
      ],
      messages: { s1: [] },
      inTurn: {},
      stopReasons: {},
      closeReasons: {},
      configOptions: {},
      contextUsage: {},
    });
    render(<SidePane />);
    // The context bar is FILLED from the row's usage (53760 / 128000 ≈
    // 42% — the green band).
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByTestId("context-usage").textContent).toBe("42%");
    // The model selector is POPULATED with the stored model's name, but
    // DISABLED (a stored session can't set config — no agent process to
    // deliver `set_config_option` to).
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.hasAttribute("disabled")).toBe(true);
    expect(model.textContent).toContain("m1 · tama");
    // The thinking selector is POPULATED with the stored level + disabled.
    const thinking = screen.getByRole("combobox");
    expect(thinking.hasAttribute("disabled")).toBe(true);
    expect(thinking.textContent).toContain("High");
  });

  it("a stored session's live config options win over the row's (the store's map is fresher — the last frame before the close)", () => {
    // The store's map has a FRESHER value (the session was live in this
    // app session, closed, and the store kept its last known config — the
    // `handleSessionClosed` no longer drops it); the row's value is the
    // DB's (persisted on the same frame — same value, but the store's
    // map is the primary source).
    seedStoredSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "tama/m2",
            options: [{ value: "tama/m2", name: "m2" }],
          },
        ],
      },
      contextUsage: { s1: { used: 100000, window: 128000 } },
    });
    render(<SidePane />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.textContent).toContain("m2 · tama");
    const bar = screen.getByRole("progressbar", { name: "Context used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("78"); // 100000/128000 ≈ 78%
  });

  it("choosing a model item invokes setSessionConfigOption (the pane owns the write path now)", async () => {
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [
              { value: "acme/alpha", name: "acme/Alpha" },
              { value: "acme/beta", name: "acme/Beta" },
            ],
          },
        ],
      },
    });
    render(<SidePane />);
    // The model picker is a DIALOG (the trigger is a button — the catalog
    // is too long for a Radix dropdown).
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    // The row name is the BARE id; the sent value is the full composed key.
    fireEvent.click(screen.getByText("beta"));
    // The handler is async (`await setSessionConfigOption`, then
    // `applyConfigOptions`), so the call lands a microtask after the click.
    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith("s1", "model", "acme/beta"),
    );
  });

  it("a live session WITHOUT configOptions renders neither selector (the stubs are the whole block)", () => {
    seedLiveSession();
    render(<SidePane />);
    // A live session with no `configOptions` is the STUB case: the block
    // renders two disabled stubs and no real control. (Moved here with the
    // controls — in the composer this assertion had gone vacuous, since
    // nothing in the composer can be a combobox any more.)
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
    expect(screen.getByRole("button", { name: "Model" })).toBeTruthy();
  });

  it("a STORED session with configOptions still renders no SELECTOR control (it is populated but read-only)", () => {
    seedStoredSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [{ value: "acme/alpha", name: "acme/Alpha" }],
          },
        ],
      },
    });
    render(<SidePane />);
    // The original meaning survives the move: a stored session's model option
    // is never an interactive combobox — the pane renders the model trigger as
    // a (disabled) dialog BUTTON, so `queryByRole("combobox")` stays null.
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  });

  // --- The block's PINNING inside the pane (the three geometry traps). ---

  it("pins the config block with shrink-0 (the pane's scroller is `flex-1`, so the block must not absorb the height shortfall)", () => {
    const { container } = render(<SidePane />);
    // The frame is a `flex-col` whose content div is `flex-1` (basis 0). A new
    // sibling with the default `flex-basis: auto` would be the ONLY item that
    // can shrink, so a long todo board would squash the block instead of
    // scrolling — the exact failure the composer island documents for itself.
    // Classes are all jsdom can grade, so that is what is asserted.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    expect(block.className).toContain("shrink-0");
    expect(block.className).not.toMatch(/\bflex-1\b/);
  });

  it("clears the collapse toggle out of the block's bottom-left corner (the toggle is absolutely positioned over it)", () => {
    const { container } = render(<SidePane />);
    // The toggle is `absolute bottom-2 left-2 z-10 size-6`, so it overlays the
    // block's bottom-left corner for ~40px of height. Without bottom padding the
    // Context line would sit under it and be unclickable.
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    const pb = block.className.match(/(^|\s)pb-(\[[0-9.]+rem\]|[0-9]+)/);
    expect(pb, "the block carries no bottom padding to clear the toggle").toBeTruthy();
    const raw = pb![2]!;
    const px = raw.startsWith("[")
      ? Number(raw.replace(/[\[\]rem]/g, "")) * 16
      : Number(raw) * 4;
    // The toggle is 24px (`size-6`) inset 8px from the bottom → it reaches 32px
    // up from the frame's bottom edge.
    expect(px, `pb of ${px}px does not clear a 32px-tall overlay`).toBeGreaterThanOrEqual(32);
  });

  it("hides the config block in the sliver with its own `invisible` (it sits OUTSIDE the scroller, so the scroller's class cannot reach it)", () => {
    seedLiveSession();
    useSessions.setState({
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    act(() => {
      setSidePaneCollapsed(true);
    });
    const { container } = render(<SidePane />);
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    // The scroller's `invisible`-while-collapsed class is what takes the board
    // and its scrollbar out of the 40px paint — and the block is a SIBLING of
    // the scroller, not inside it, so it needs its own. `visibility: hidden`
    // keeps it mounted (the collapse clips, it never unmounts) while painting
    // nothing; jsdom runs no layout, so the class IS the check.
    expect(block.className).toContain("invisible");
    // Still mounted (the pane keeps its content across a collapse).
    expect(screen.getByTestId("context-usage")).toBeTruthy();
    // And it comes back when the pane opens.
    act(() => {
      setSidePaneCollapsed(false);
    });
    expect(
      container.querySelector(
        '[data-testid="session-config-block"]',
      )!.className,
    ).not.toContain("invisible");
    // The scroller keeps its own copy of the class (this did not replace it).
    expect(
      (container.querySelector(".overflow-y-auto") as HTMLElement).className,
    ).toContain("overflow-y-auto");
  });

  it("mounts the config block AFTER the scroll area (so a growing todo board cannot push it away or scroll it out of sight)", () => {
    useSessions.setState({ activeSessionId: "main1" });
    useInteractive.getState().applyTodoUpdate("main1", {
      source: "main",
      todos: [{ content: "a", status: "pending" }],
    });
    const { container } = render(<SidePane />);
    const scroller = container.querySelector(".overflow-y-auto") as HTMLElement;
    const block = container.querySelector(
      '[data-testid="session-config-block"]',
    ) as HTMLElement;
    // A SIBLING after the scroller — not a child of it. Inside the scroller the
    // block would scroll away with the board and drift with its length.
    expect(scroller.contains(block)).toBe(false);
    expect(block.previousElementSibling).toBe(scroller);
    // Both are direct children of the frame.
    expect(block.parentElement).toBe(scroller.parentElement);
  });
});
