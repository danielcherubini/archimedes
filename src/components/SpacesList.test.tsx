import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { deleteSession, listSkills, setSessionArchived, startSession } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import SpacesList from "./SpacesList";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // `AppSettings` document (a full shape — the `AppSettings` interface
    // mirrors the Rust `Settings` struct exactly).
    getSettings: vi.fn().mockResolvedValue({
      theme: "dark",
      paneLayout: {},
      defaultTrustNewSpaces: false,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledTools: [],
      providers: [],
      mcpServers: {},
      font: { sizePx: 14, uiFamily: null, codeFamily: null },
      defaultThinkingLevels: {},
      subagentModels: {},
      filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
      web: {
        braveApiKey: "",
        tavilyApiKey: "",
        perplexityApiKey: "",
        searxngUrl: "",
        defaultProvider: "auto",
        proxy: "",
      },
      mcpMentionsEnabled: false,
      sessionNamingEnabled: true,
      sessionNamingModel: null,
      sessionNamingReasoning: null,
      attentionAlertsEnabled: true,
      attentionAlertDelaySecs: 15,
    }),
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new1",
      cwd: "/tmp/ws",
      capabilities: { loadSession: false },
      archived: false,
    }),
    respondPermission: vi.fn(),
    respondInteractiveRequest: vi.fn(),
    loadHistory: vi.fn().mockResolvedValue([]),
    setSpaceTrusted: vi.fn().mockResolvedValue(undefined),
    deleteSpace: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "alpha",
        description: "Alpha skill",
        path: "/p/.agents/skills/alpha/SKILL.md",
        dir: "/p/.agents/skills/alpha",
        scope: "space",
        body: "B",
      },
    ]),
    setSessionArchived: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedStartSession = vi.mocked(startSession);
const mockedListSkills = vi.mocked(listSkills);
const mockedDeleteSession = vi.mocked(deleteSession);

/**
 * Whether a node is PAINTED — i.e. neither it nor any ancestor carries
 * `visibility: hidden` (Tailwind's `invisible`). jsdom resolves no CSS, so
 * "does this text bleed into the 40px sliver?" is read off the class list the
 * component renders, which is exactly what the collapse controls.
 */
function painted(node: HTMLElement): boolean {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    if (el.classList.contains("invisible")) return false;
  }
  return true;
}

/**
 * Fixture: two spaces. `alpha` holds a live session `s1` (in-turn, with a
 * loaded transcript) + a stored session `h1` (loaded transcript, ~1h old);
 * `beta` holds a stored session `h2` that was NOT opened this boot (no
 * loaded messages → no relative time).
 */
function seed(): void {
  const now = Date.now();
  // Seed via `setState` directly — NOT `getState().setSpaces(…)` (that
  // triggers boot auto-selection + `openSession` → `loadHistory` IPC).
  useSessions.setState({
    spaces: [
      { path: "/tmp/alpha", createdAt: now, lastOpenedAt: now, trusted: false },
      { path: "/tmp/beta", createdAt: now, lastOpenedAt: now, trusted: true },
    ],
    sessions: [
      { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
    ],
    historySessions: [
      { sessionId: "h1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      { sessionId: "h2", cwd: "/tmp/beta", capabilities: {}, archived: false },
    ],
    activeSessionId: "s1",
    // The selected space (the top tabs' state): `alpha` — the active
    // session's space (the sidebar lists THIS space's sessions).
    activeSpacePath: "/tmp/alpha",
    closeReasons: {},
    messages: {
      s1: [{ kind: "user", text: "Fix the login bug", at: now - 10_000 }],
      h1: [
        { kind: "user", text: "Refactor the parser", at: now - 3_600_000 },
      ],
    },
    inTurn: { s1: true },
    stopReasons: {},
  });
  usePermissions.setState({ prompts: {} });
  useInteractive.setState({
    requests: {},
    todos: {},
    agentState: {},
    cost: {},
    session: {},
  });
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
});
// The hook's module-level catalog cache is shared across tests in a
// file: clear it so each test refetches (without this, test 1's warm
// cache — keyed by the `seed()` fixture's `cwd` — makes a later test's
// fresh `listSkills` mock moot).
beforeEach(clearSkillCatalogCache);
// The left-pane collapsed flag is module-scoped: reset it between tests
// (the module is the single persistence owner — `setLeftPaneCollapsed`
// writes localStorage itself).
beforeEach(() => {
  setLeftPaneCollapsed(false);
});

describe("SpacesList", () => {
  it("renders the two action buttons with their labels and kbd hints", () => {
    render(<SpacesList />);
    expect(screen.getByRole("button", { name: /New Session/ })).toBeTruthy();
    expect(screen.getByText("⌘N")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open Space/ })).toBeTruthy();
    expect(screen.getByText("⌘O")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
  });

  it("opens the Open Space dialog from the action button", () => {
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /Open Space/ }));
    // A fresh (unvalidated) folder renders the literal "New space" title.
    expect(screen.getByText("New space")).toBeTruthy();
  });

  it("opens the Open Space dialog from the New Session button when no space is selected", () => {
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    expect(screen.getByText("New space")).toBeTruthy();
  });

  it("starts a new session in the SELECTED space (not the active session's space)", async () => {
    // The active session's cwd (`/tmp/gamma`) matches NO space in the
    // fixture — but the SELECTED space is `/tmp/beta` (the tabs' state
    // is independent of the active session): the button must start in
    // the selected space, not the orphan's cwd (and not the dialog).
    useSessions.setState({
      sessions: [
        {
          sessionId: "s-orphan",
          cwd: "/tmp/gamma",
          capabilities: {},
          archived: false,
        },
      ],
      activeSessionId: "s-orphan",
      activeSpacePath: "/tmp/beta",
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/beta"),
    );
  });


  it("renders the stored row's stored ring and its relative time, and NO spinner", () => {
    render(<SpacesList />);
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[role="status"]')).toBeNull();
    // A STORED session wears the dim ring — the idle cue the collapsed rail has
    // always had and the expanded list used to omit entirely (an empty slot
    // unless the session was in a turn).
    expect(row!.querySelector('[data-dot="stored"]')).toBeTruthy();
    // Last message ~1h ago → `1h`.
    expect(row!.textContent).toContain("1h");
  });

  it("renders an empty time slot (no time text) for a session with no loaded messages", () => {
    // A stored session in the ACTIVE space (`/tmp/alpha`) that was not
    // opened this boot: no loaded messages → the title falls back to
    // the space's base name (`alpha`) and the time slot is empty.
    useSessions.setState({
      historySessions: [
        { sessionId: "h1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
        { sessionId: "h3", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
    });
    render(<SpacesList />);
    const alphas = screen.getAllByText("alpha");
    // `h3`'s row (the third `alpha` — `s1`'s + `h1`'s rows have loaded
    // messages, `h3`'s does not → its title is the base name). It is also
    // LAST: no loaded transcript is no evidence, and the stored group puts
    // evidence-free below a session it can prove was used an hour ago.
    const row = alphas[alphas.length - 1].closest('[role="button"]');
    expect(row).not.toBeNull();
    // Title only — no time text.
    expect(row!.textContent).toBe("alpha");
  });

  it("marks a pending-permission row with the ? and KEEPS its relative time", () => {
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "Run a tool", options: [] }],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Fix the login bug")
      .closest('[role="button"]');
    // The `?` replaces the green "Waiting" PILL: the pill and the rail's dot
    // were one fact in two shapes, and the pill's cost was the time — while a
    // session waited you could not see how long ago it had been active.
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(row!.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(row!.querySelector('[role="status"]')).toBeNull();
    expect(row!.textContent).toContain("now");
  });

  it("marks a pending interactive ask/confirm/password row with the ? too", () => {
    useInteractive.setState({
      requests: {
        h1: [
          {
            requestId: "br1",
            method: "password",
            source: "main",
            params: { command: "sudo apt install foo", reason: "test" },
          },
        ],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    // `password` included: a pending sudo password had no cue anywhere else.
    expect(row!.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(row!.textContent).toContain("1h");
  });

  it("opens a session on row click (the store's activeSessionId + the selection styling)", () => {
    render(<SpacesList />);
    expect(useSessions.getState().activeSessionId).toBe("s1");
    fireEvent.click(screen.getByText("Refactor the parser"));
    expect(useSessions.getState().activeSessionId).toBe("h1");
    const row = screen
      .getByText("Refactor the parser")
      .closest('[role="button"]');
    expect(row!.className).toContain("bg-selected");
  });

  it("shows the IDLE mark in the EXPANDED list too (the cue the collapsed rail has always had)", () => {
    // The bug this pins: the open row's leading slot was empty unless the
    // session was in a turn, while the collapsed rail drew a dot for every
    // session — so EXPANDING the sidebar deleted the idle mark the user could
    // see when it was collapsed.
    useSessions.setState({
      sessions: [
        { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      activeSessionId: "s1",
      inTurn: {},
      messages: {
        s1: [{ kind: "user", text: "Fix the login bug", at: Date.now() - 10_000 }],
      },
    });
    render(<SpacesList />);
    const row = screen
      .getByText("Fix the login bug")
      .closest('[role="button"]');
    // Live and NOT in a turn → the filled live ring, and no spinner.
    expect(row!.querySelector('[data-dot="live"]')).toBeTruthy();
    expect(row!.querySelector('[role="status"]')).toBeNull();
  });

  it("orders the LIVE group by last activity, above the STORED group", () => {
    const now = Date.now();
    const s1 = { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false };
    const s2 = { sessionId: "s2", cwd: "/tmp/alpha", capabilities: {}, archived: false };
    useSessions.setState({
      sessions: [s1, s2],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "s2",
      messages: {
        s1: [{ kind: "user", text: "Task 1", at: now - 20_000 }],
        s2: [{ kind: "user", text: "Task 2", at: now - 10_000 }],
        h1: [{ kind: "user", text: "Refactor the parser", at: now - 3_600_000 }],
      },
    });

    render(<SpacesList />);

    const task2El = screen.getByText("Task 2");
    const task1El = screen.getByText("Task 1");
    const storedEl = screen.getByText("Refactor the parser");

    expect(task2El).toBeTruthy();
    expect(task1El).toBeTruthy();
    expect(storedEl).toBeTruthy();

    // Check DOM order: Task 2 above Task 1, Task 1 above stored row
    expect(
      task2El.compareDocumentPosition(task1El) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      task1El.compareDocumentPosition(storedEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Clicking Task 1 switches activeSessionId to s1
    fireEvent.click(task1El);
    expect(useSessions.getState().activeSessionId).toBe("s1");
  });

  it("ranks a live session by ITS ACTIVITY, not by which was started last", () => {
    // The old live order was reverse-INSERTION (`liveSessionsInSpace` reverses
    // the store's array), so the session started last sat on top even when it
    // had been idle for an hour and its sibling had just answered. `s1` was
    // started FIRST and is the one with the recent message — under the old rule
    // this assertion is red.
    const now = Date.now();
    useSessions.setState({
      sessions: [
        { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
        { sessionId: "s2", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "s2",
      messages: {
        s1: [{ kind: "user", text: "Busy moments ago", at: now - 5_000 }],
        s2: [{ kind: "user", text: "Started later, idle for hours", at: now - 7_200_000 }],
      },
    });
    render(<SpacesList />);
    const busy = screen.getByText("Busy moments ago");
    const idle = screen.getByText("Started later, idle for hours");
    expect(
      busy.compareDocumentPosition(idle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps a brand-new live session (no transcript yet) at the TOP of the live group", () => {
    // `addSession` gives a fresh session an EMPTY transcript, so "no loaded
    // messages" in the live group means JUST CREATED — the most recent activity
    // there. Sinking it below a session idle for an hour would hide the session
    // the user just made ⌘N.
    // A generated `title` labels the row, because with no messages the title
    // would otherwise fall back to the Space's name — which the fixture's
    // stored sessions also answer to.
    const now = Date.now();
    useSessions.setState({
      sessions: [
        { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
        {
          sessionId: "s-new",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
          title: "Just created",
        },
      ],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "s-new",
      messages: {
        s1: [{ kind: "user", text: "Idle for an hour", at: now - 3_600_000 }],
        "s-new": [],
      },
    });
    render(<SpacesList />);
    const freshRow = screen
      .getByText("Just created")
      .closest('[role="button"]');
    const idleRow = screen
      .getByText("Idle for an hour")
      .closest('[role="button"]');
    expect(freshRow).toBeTruthy();
    expect(idleRow).toBeTruthy();
    expect(
      freshRow!.compareDocumentPosition(idleRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("sorts a session that CLOSED this boot to the top of the stored group", () => {
    // `handleSessionClosed` APPENDS the closed session to `historySessions`, so
    // the array's own order files the most recently used stored session LAST —
    // the exact inversion the ordering removes.
    const now = Date.now();
    useSessions.setState({
      sessions: [],
      historySessions: [
        { sessionId: "h1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
        { sessionId: "h9", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "h9",
      messages: {
        h1: [{ kind: "user", text: "Used an hour ago", at: now - 3_600_000 }],
        h9: [{ kind: "user", text: "Used a second ago", at: now - 1_000 }],
      },
    });
    render(<SpacesList />);
    const recent = screen.getByText("Used a second ago");
    const older = screen.getByText("Used an hour ago");
    expect(
      recent.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("truncates a long title on a single line (the fade mask is the sole cue)", () => {
    // A 120-char first user message → `titleFor` slices it to 80 chars; the
    // title span must carry the truncation classes so it overflows under the
    // fade instead of wrapping.
    useSessions.setState({
      messages: {
        s1: [{ kind: "user", text: "x".repeat(120), at: Date.now() - 10_000 }],
      },
    });
    render(<SpacesList />);
    const title = screen.getByText("x".repeat(80));
    expect(title.className).toContain("overflow-hidden");
    expect(title.className).toContain("whitespace-nowrap");
    expect(title.className).toContain("min-w-0");
  });

  it("ignores ⌘N / Ctrl+O while the target is an input or a dialog", async () => {
    render(<SpacesList />);
    const input = document.createElement("input");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    // Appended to `document.body` OUTSIDE RTL's render tree — RTL cleanup
    // does not touch manually appended nodes, so remove them explicitly
    // (cross-test pollution: a stray `[role="dialog"]` in the body would
    // make later tests' shortcuts no-op via the `e.target` guard).
    document.body.append(input, dialog);
    try {
      // Ctrl+N on the input: hijacked by the guard (the target is an input).
      fireEvent.keyDown(input, { key: "n", ctrlKey: true });
      await waitFor(() => expect(mockedStartSession).not.toHaveBeenCalled());
      // Ctrl+O on a `[role="dialog"]`: also ignored.
      fireEvent.keyDown(dialog, { key: "o", metaKey: true });
      expect(screen.queryByText("New space")).toBeNull();
    } finally {
      input.remove();
      dialog.remove();
    }
  });

  it("does NOT ignore ⌘N while the target is a contenteditable=\"false\" element (the guard matches `contenteditable` except `false`)", async () => {
    render(<SpacesList />);
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "false");
    // Same manual-append caveat as the guard test above: remove it in
    // `finally` (RTL cleanup does not touch it).
    document.body.appendChild(div);
    try {
      // `contenteditable="false"` is NOT editable: the shortcut fires.
      fireEvent.keyDown(div, { key: "n", metaKey: true });
      await waitFor(() =>
        expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha"),
      );
    } finally {
      div.remove();
    }
  });

  it("⌘N / Ctrl+N trigger the New Session handler (a bare key does not)", async () => {
    render(<SpacesList />);
    // No modifier: ignored.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    expect(mockedStartSession).not.toHaveBeenCalled();
    // ⌘N: the active session's view owns `s1` (cwd `/tmp/alpha`) →
    // `startSession("/tmp/alpha")` (a native session — no agent to choose).
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", metaKey: true }),
    );
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha"),
    );
    // Ctrl+N (uppercase key): the same handler.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "N", ctrlKey: true }),
    );
    await waitFor(() => expect(mockedStartSession).toHaveBeenCalledTimes(2));
  });

  it("⌘O opens the Open Space dialog", () => {
    render(<SpacesList />);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "o", metaKey: true }),
      );
    });
    expect(screen.getByText("New space")).toBeTruthy();
  });

  it("the_skills_button_sits_in_the_button_row", async () => {
    render(<SpacesList />);
    // The third button in the `New Session` / `Open Space` row (the skill
    // LIST no longer renders in the pane — the button opens a modal).
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    // The one-fetch property (single consumer): one `listSkills` call.
    expect(mockedListSkills).toHaveBeenCalledTimes(1);
  });

  it("the_skills_modal_shows_the_empty_state_when_there_are_no_skills", async () => {
    // `clearAllMocks` PRESERVES the factory's 1-skill implementation, so
    // override it here. Declared LAST so the override cannot leak into
    // the other test (the `beforeEach` cache-clear makes each test
    // refetch; because implementations are preserved, this test's
    // `mockResolvedValue([])` would leak to any test declared after it —
    // declaration order is what keeps the two independent).
    vi.mocked(listSkills).mockResolvedValue([]);
    render(<SpacesList />);
    // Open the modal from the button.
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    await screen.findByText("No skills found.");
  });
});

describe("SpacesList (archive, ADR 0016)", () => {
  /** Seed an archived (flag-on) stored session in the `alpha` space.
   * `messages` (when given) makes the row's title message-derived. */
  function seedArchived(
    id: string = "a1",
    opts: { live?: boolean; messages?: { text: string; at: number } } = {},
  ): void {
    const row = {
      sessionId: id,
      cwd: "/tmp/alpha",
      capabilities: {},
      archived: true,
    };
    useSessions.setState({
      sessions: opts.live ? [row] : [],
      archivedSessions: [row],
      activeSessionId: id,
      ...(opts.messages
        ? { messages: { [id]: [{ kind: "user" as const, ...opts.messages }] } }
        : {}),
    });
  }

  it("a stored row offers an Archive hover action that archives it", async () => {
    render(<SpacesList />);
    // `h1`'s title is "Refactor the parser" (its first user message).
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Refactor the parser" }),
    );
    // The store action moved the entry (the backend call resolved via
    // the mock) — `historySessions` lost it, `archivedSessions` gained it.
    await waitFor(() => {
      const { archivedSessions, historySessions } = useSessions.getState();
      expect(
        archivedSessions.some((s) => s.sessionId === "h1"),
      ).toBe(true);
      expect(
        historySessions.some((s) => s.sessionId === "h1"),
      ).toBe(false);
    });
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("h1", true);
  });

  it("a live row offers no hover action (the pause concept is gone — the time slot is always shown)", () => {
    render(<SpacesList />);
    // `s1` is live: no hover action at all (the Pause button is gone —
    // the session is simply never paused from the UI).
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Archive Fix the login bug" }),
    ).toBeNull();
  });

  it("the Archived section is collapsed by default and lists archived sessions", () => {
    seedArchived("a1", {
      messages: { text: "Archive the logs", at: Date.now() - 3_600_000 },
    });
    render(<SpacesList />);
    // The header renders (with the count badge) even when collapsed…
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    // …and the row is NOT rendered while collapsed. (The row's title
    // carries a `· alpha` suffix as a nested span, so match on a
    // prefix, not the exact title text.)
    expect(screen.queryByText(/^Archive the logs/)).toBeNull();
    // Expanding the section (clicking the header) reveals the row.
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText(/^Archive the logs/)).toBeTruthy();
  });

  it("unarchive moves the row back", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() => {
      const { archivedSessions, historySessions } = useSessions.getState();
      expect(
        archivedSessions.some((s) => s.sessionId === "a1"),
      ).toBe(false);
      expect(
        historySessions.some((s) => s.sessionId === "a1"),
      ).toBe(true);
    });
    expect(vi.mocked(setSessionArchived)).toHaveBeenCalledWith("a1", false);
  });

  it("delete from the Archived section confirms and removes", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The destructive action opens the confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(screen.getByText("Delete session?")).toBeTruthy();
    // Cancel: the row remains, the dialog closes.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete session?")).toBeNull();
    expect(
      useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
    ).toBe(true);
    // Delete: the row vanishes from the store and the dialog closes.
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
      ).toBe(false),
    );
    expect(screen.queryByText("Delete session?")).toBeNull();
    expect(mockedDeleteSession).toHaveBeenCalledWith("a1");
  });

  it("a live session that is also archived is view-filtered out of the Archived section", () => {
    seedArchived("a1", { live: true, messages: { text: "Both lists", at: Date.now() - 10_000 } });
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    // The row renders exactly ONCE — as the live row in its Space group
    // (the sticky live id is view-filtered out of the Archived section).
    // Prefix match: the row's title carries a `· alpha` suffix span.
    expect(screen.getAllByText(/^Both lists/)).toHaveLength(1);
  });

  it("New Session with an archived session active starts a conversation in that space (not the Open Space dialog)", async () => {
    seedArchived();
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    // The `activeView` predicate matches via `archivedSessionIds` → the
    // hook starts a native session in that space.
    await waitFor(() =>
      expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha"),
    );
    expect(screen.queryByText("New space")).toBeNull();
  });

  it("an archived-only active session still resolves its space for the skill catalog", async () => {
    seedArchived();
    render(<SpacesList />);
    // The `useSkillCatalog` input path (`activeSession ? undefined :
    // activeHistory ?? archivedSessions.find(…)`): the active session's
    // Space path, NOT `null` (which would silently degrade the catalog
    // to user-level skills). `listSkills` is called with the fetch key.
    await waitFor(() =>
      expect(mockedListSkills).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  it("logs a console error when Archive fails (the row is NOT moved)", async () => {
    vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(
      screen.getByRole("button", { name: "Archive Refactor the parser" }),
    );
    // The rejection is logged (no unhandled rejection in the webview)...
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to archive session:",
        expect.anything(),
      ),
    );
    // ...and the move did NOT land: the row is still a stored session.
    const { archivedSessions, historySessions } = useSessions.getState();
    expect(archivedSessions.some((s) => s.sessionId === "h1")).toBe(false);
    expect(historySessions.some((s) => s.sessionId === "h1")).toBe(true);
    consoleError.mockRestore();
  });

  it("logs a console error when Unarchive fails (the row is NOT moved)", async () => {
    seedArchived();
    vi.mocked(setSessionArchived).mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to unarchive session:",
        expect.anything(),
      ),
    );
    // The row is still archived (the mirror move did NOT land).
    const { archivedSessions, historySessions } = useSessions.getState();
    expect(archivedSessions.some((s) => s.sessionId === "a1")).toBe(true);
    expect(historySessions.some((s) => s.sessionId === "a1")).toBe(false);
    consoleError.mockRestore();
  });

  it("closes the delete dialog and logs a console error when Delete fails (the row remains)", async () => {
    seedArchived();
    mockedDeleteSession.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // The dialog closes even on failure (a stuck-open dialog is worse
    // than a logged failure) — the close is deferred into the `.catch`,
    // so wait for it.
    await waitFor(() =>
      expect(screen.queryByText("Delete session?")).toBeNull(),
    );
    // ...and the rejection is logged (no unhandled rejection).
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to delete session:",
        expect.anything(),
      ),
    );
    // The row remains: the store's delete only lands after the command
    // resolves.
    expect(
      useSessions.getState().archivedSessions.some((s) => s.sessionId === "a1"),
    ).toBe(true);
    consoleError.mockRestore();
  });

  // -- The `...` menu (moved from the tab bar to the `Sessions` header,
  // -- right-aligned, next to the word `Sessions`) --

  it("the `...` menu in the Sessions header starts a session in the ACTIVE space", async () => {
    const { startSession } = await import("../lib/tauri");
    // The seed's active space is `/tmp/alpha`.
    render(<SpacesList />);
    // The menu sits in the `Sessions` header row (right of the label).
    const header = screen.getByText("Sessions").parentElement!;
    expect(
      header.querySelector('[aria-label="Session actions"]'),
    ).toBeTruthy();
    // Radix opens on `pointerDown` (`click` does not open the menu in
    // jsdom).
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }));
    // NO Resume / NO Pause (the pause concept is gone — the old header's
    // dropdown invariant now applies to this menu): the menu holds ONLY
    // the item below.
    expect(screen.queryByRole("menuitem", { name: /Resume/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Pause/ })).toBeNull();
    // Selection: `Enter` on the item (Radix's keyboard selection model).
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "New Session in this Space" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(vi.mocked(startSession)).toHaveBeenCalledWith("/tmp/alpha"),
    );
  });

  // -- The collapse toggle + the gear live in the pane's OWN footer row in
  // -- BOTH states: the chrome bar holds no pane control at all (`App.tsx`,
  // -- pinned by `App.test.tsx`'s `the chrome bar NEVER holds a pane
  // -- control`) --

  // -- The pane's OWN collapse toggle (bottom-inner corner = bottom right for
  // -- the left pane, pointing at the chat), rendered while expanded AND while
  // -- collapsed: collapsed it sits in the rail and re-expands the pane, so it
  // -- never hands off — see the `KEEPS its toggle while collapsed` case below
  // -- and `App.test.tsx`. --

  it("holds its own collapse toggle in the footer's inner corner, with the gear beside it", () => {
    const { container } = render(<SpacesList />);
    const footer = (container.firstChild as HTMLElement).lastElementChild!;
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    const gear = screen.getByRole("button", { name: "Settings" });
    // Both live in the footer row (the pane's bottom edge).
    expect(footer.contains(collapse)).toBe(true);
    expect(footer.contains(gear)).toBe(true);
    // The TOGGLE is the inner-most (last/rightmost) child: for the left pane
    // the inner side is the one facing the chat, so it takes the corner and
    // the gear sits outboard of it. The gear is NOT pushed out of the
    // right-hand cluster — it is one slot left, not moved to the far side.
    expect(footer.lastElementChild).toBe(collapse);
    const kids = [...footer.children];
    expect(kids.indexOf(gear)).toBeLessThan(kids.indexOf(collapse));
    // The cluster is RIGHT-aligned (`justify-end`, never `justify-between`):
    // the gear stays immediately outboard of the toggle. `justify-between`
    // keeps both assertions above true while flinging the gear to the pane's
    // OUTER edge — so the alignment is asserted, not inferred from order.
    expect(footer.className).toMatch(/\bjustify-end\b/);
    expect(footer.className).not.toMatch(/\bjustify-between\b/);
    // Expanded, exactly ONE toggle exists and it carries the label for the
    // direction it performs now (`Collapse sidebar`, queried above): nothing is
    // labelled `Expand sidebar` here, because the flip is a LABEL change on the
    // same button rather than a second control taking over.
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
  });

  it("KEEPS its toggle while collapsed, in the sliver, and it is the control that re-expands (it never moves to the chrome bar)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    // The STABLE hook, not the label: the label flips with the state, so a
    // name query would miss on exactly the collapsed side this test checks.
    const collapse = screen.getByTestId("left-pane-toggle");
    // The pane is NOT gone: it keeps a rail wide enough to hold the toggle,
    // so the control the user just used is still under their cursor.
    expect((container.firstChild as HTMLElement).style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // One control does both jobs — no second button appeared, and the label
    // flipped to the direction it now performs.
    expect(container.querySelectorAll('[data-testid="left-pane-toggle"]').length).toBe(1);
    expect(collapse.getAttribute("aria-label")).toBe("Expand sidebar");
    // aria-pressed flips to report the collapsed state.
    expect(collapse.getAttribute("aria-pressed")).toBe("false");
    // Settings is STILL reachable while collapsed, through exactly ONE door —
    // the rail's icon, not the footer's. The footer gear is not rendered:
    // clipping it with `overflow-hidden` instead would leave a ~4px sliver of
    // its icon poking into the rail (measured: the footer's natural content is
    // 68px — 2x24 buttons + 4 gap + 2x8 padding — against a 40px rail, so 28px
    // of the gear survives), which reads as a rendering glitch.
    //
    // This assertion used to read `queryByRole("Settings")).toBeNull()` on the
    // reasoning that "hiding it costs nothing". That was never true: the gear
    // was Settings' ONLY door, so collapsing the pane locked the user out of
    // Settings until they re-expanded it. The rail now carries the command, so
    // the door moved rather than closed — and it is asserted as exactly ONE,
    // because two gears (rail + a permanent chrome-bar one) was the alternative.
    const gears = screen.getAllByRole("button", { name: "Settings" });
    expect(gears).toHaveLength(1);
    expect(
      screen
        .getByTestId("session-rail-tail-actions")
        .contains(gears[0] as HTMLElement),
    ).toBe(true);
    // The toggle survives, and `shrink-0` is what keeps it a real 24px target:
    // in a 40px rail, flex would otherwise squeeze BOTH footer buttons to fit
    // rather than clip one, and a 12px-wide toggle is not a 24px hit area.
    expect(collapse.className).toMatch(/\bshrink-0\b/);
    act(() => {
      fireEvent.click(collapse);
    });
    expect(getLeftPaneCollapsed()).toBe(false);
  });

  it("the_gear_icon_opens_settings", () => {
    const onOpenSettings = vi.fn();
    render(<SpacesList onOpenSettings={onOpenSettings} />);
    // The footer's gear icon exists and fires the callback.
    const gear = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(gear);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("collapses to the sliver (the content stays mounted, clipped — the pane keeps its own toggle)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // The content (the `Sessions` label) is clipped (width 0 +
    // `overflow: hidden`) — NOT unmounted (the list's local state
    // survives a collapse; the `fixed` dialogs escape the clipping).
    expect(screen.getByText("Sessions")).toBeTruthy();
    // Expanding via the shared flag restores the full frame.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(frame.style.width).toBe("260px");
  });

  it("holds NO bg-warning toggle dot while EXPANDED, even with a pending request (the dot belongs to the collapsed toggle alone)", () => {
    // The TOGGLE's dot, not "no warning ink anywhere": the row now wears the
    // `?` in `text-warning` in BOTH sidebar states, so a pane-wide
    // "no warning anywhere" assertion would be false by design. What stays
    // collapsed-only is the FILL on the pane's toggle — its meaning is
    // "something needs you behind the hidden pane".
    useSessions.setState({
      sessions: [
        { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      activeSessionId: "s1",
    });
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "bash", options: [] }],
      },
    });
    const { container } = render(<SpacesList />);
    expect(container.querySelector(".bg-warning")).toBeNull();
    // And the row DOES carry the cue while expanded — the other half of the
    // pair, so the two assertions above cannot both be satisfied by a pane
    // that simply shows nothing.
    expect(container.querySelector('[data-dot="waiting"]')).toBeTruthy();
  });

  it("collapses to the sliver: the session marks show, and NO text bleeds in", () => {
    // The two defects the rail replaces, both from one cause: the collapse is
    // width + `overflow: hidden` with the content kept MOUNTED, so the list
    // painted INTO the 40px sliver — the action buttons wrapped to one word per
    // line ("O / Sp / Se / Sk"), the `Sessions` header became "Sess", and the
    // scroller grew a scrollbar in a 40px column.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    // The rail: the ACTIVE space's sessions, one mark each (the fixture's
    // `alpha` = live `s1` in-turn + stored `h1`).
    const rail = screen.getByTestId("session-rail");
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
    // Running first (the list's own order: live, then stored) — the SPINNER,
    // the glyph the open row uses for the same fact. Queried by test id rather
    // than `[role="status"]`: the rail's marks are decoration under one
    // summarising `role="img"`, so the spinner's own role is silenced here.
    const marks = screen.getAllByTestId("session-mark");
    expect(marks[0]!.tagName).toBe("svg");
    expect(marks[0]!.getAttribute("class")).toContain("animate-spin");
    expect(rail.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Sessions 2, 1 running" })).toBeTruthy();
    // Nothing that carries text is painted in the sliver: `visibility: hidden`
    // takes the content AND ITS SCROLLBAR out of the paint while leaving it
    // mounted (`hidden` would unlayout it, and clipping alone is what produced
    // the wrapped text and the stray scrollbar).
    for (const label of ["Open Space", "New Session", "Skills", "Sessions", "Archived"]) {
      const node = screen.queryByText(label);
      if (node) {
        expect(painted(node), `${label} bleeds into the sliver`).toBe(false);
      }
    }
    // …and the rail is NOT hidden — the assertion that makes the loop above
    // mean something rather than passing on a blanket `invisible` root.
    expect(painted(rail)).toBe(true);
    // Content stays MOUNTED (not unmounted): the row's title node is still in
    // the tree, just not painted.
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
    // Expanding restores the list and drops the rail.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(painted(screen.getByText("Sessions"))).toBe(true);
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  it("keeps the rail's marks POSITIONALLY equal to the rows after the activity sort", () => {
    // The rail's whole meaning is "the Nth mark is the Nth row". The sort is the
    // new thing that could break that silently, by giving the rail one order and
    // the list another. `s2` is the most-recently-STARTED live session and the
    // least-recently-ACTIVE one, so the two orders differ and the assertion can
    // tell them apart.
    const now = Date.now();
    useSessions.setState({
      sessions: [
        { sessionId: "s1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
        { sessionId: "s2", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      activeSpacePath: "/tmp/alpha",
      activeSessionId: "s2",
      // `s1` is the most recently ACTIVE live session and the one WAITING; `s2`
      // was started later (so the old reverse-insertion order put it first) and
      // is RUNNING. The marks therefore differ BY POSITION between the two
      // orders — a rail that sorted itself differently shows `running` first.
      inTurn: { s2: true },
      messages: {
        s1: [{ kind: "user", text: "Row one", at: now - 5_000 }],
        s2: [{ kind: "user", text: "Row two", at: now - 90_000 }],
        h1: [{ kind: "user", text: "Row three", at: now - 3_600_000 }],
      },
    });
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    const { unmount } = render(<SpacesList />);
    const one = screen.getByText("Row one");
    const two = screen.getByText("Row two");
    const three = screen.getByText("Row three");
    // Activity order (one, two, three) — NOT insertion order (two would lead).
    expect(
      one.compareDocumentPosition(two) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      two.compareDocumentPosition(three) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();

    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    const marks = [
      ...screen.getByTestId("session-rail-marks").querySelectorAll(
        "[data-testid='session-mark']",
      ),
    ];
    // Same COUNT as the rows, and per position the SAME GLYPH the row above it
    // wears: `?`, spinner, stored. A rail that ordered itself a second way would
    // lead with the spinner.
    expect(marks.map((m) => m.getAttribute("data-dot") ?? "running")).toEqual([
      "waiting",
      "running",
      "stored",
    ]);
  });

  it("shows the marks ONLY while collapsed (the open list is the readout)", () => {
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail")).toBeNull();
  });

  it("marks a session WAITING in the rail with the app's attention cue", () => {
    // The cue that matters most behind a collapsed pane: a session blocked on
    // the user. The `?` in the attention ink (see `SessionStatusMark`), and it
    // outranks the spinner (a blocked session is not working — see
    // `useSessionStatus`).
    usePermissions.setState({
      prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
    });
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    const dot = screen.getByTestId("session-rail").querySelector('[data-dot="waiting"]');
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute("class")).toContain("text-warning");
    expect(screen.getByRole("img", { name: "Sessions 2, 1 waiting" })).toBeTruthy();
  });

  // -- The rail's action strip: the pane's commands survive the collapse --

  it("offers all four commands as icons while collapsed, and they WORK", () => {
    const onOpenSettings = vi.fn();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList onOpenSettings={onOpenSettings} />);
    // The same four the open pane offers — collapsing must not cost you the
    // pane's commands (see `SessionRail`'s doc: `Skills`/`Settings` have no
    // shortcut, and the footer gear is `!collapsed`, so a collapsed sidebar
    // used to lock you out of Settings entirely). Asserted across BOTH strips,
    // because each sits where its button sits while the pane is open: the
    // list's three at the head, the footer's gear at the tail.
    for (const label of ["Open Space", "New Session", "Skills", "Settings"]) {
      expect(
        screen.getAllByRole("button", { name: label }).length,
        label,
      ).toBeGreaterThan(0);
    }
    expect(
      within(screen.getByTestId("session-rail-actions")).getAllByRole("button"),
    ).toHaveLength(3);
    expect(
      within(
        screen.getByTestId("session-rail-tail-actions"),
      ).getByRole("button", { name: "Settings" }),
    ).toBeTruthy();
  });

  it("wires each rail icon to the SAME handler the labelled button uses", () => {
    // Split from the presence test on purpose: `Skills` and `Open Space` open
    // MODALS, and a modal `aria-hidden`s the rest of the app — so a second
    // query against the rail after one opens fails for the correct reason
    // (testing-library honours it) and would read as a broken rail.
    const onOpenSettings = vi.fn();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTitle("Settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle("New Session"));
    expect(mockedStartSession).toHaveBeenCalledWith("/tmp/alpha");
    // The Skills modal renders, and it renders even though the pane's content
    // region is `invisible` — the dialogs sit OUTSIDE that region on purpose
    // (`visibility: hidden` inherits into `fixed` descendants).
    fireEvent.click(screen.getByTitle("Skills"));
    expect(screen.getByPlaceholderText("Search skills…")).toBeTruthy();
  });

  it("opens the Open Space dialog from the rail icon", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByTitle("Open Space"));
    expect(screen.getByText("New space")).toBeTruthy();
  });

  it("has EXACTLY ONE Settings door in either state (no gear is ever doubled)", () => {
    // The whole reason the gear lives in the pane and not the chrome bar: a
    // chrome-bar gear would be permanent (this repo's shell decision forbids a
    // control that teleports in when a pane collapses), and the rail already
    // carries one while collapsed — so the window would show two gears ~60px
    // apart. One door, which moves between the footer and the rail.
    render(<SpacesList />);
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
  });

  it("renders NO action strip while open (the labelled buttons are the controls)", () => {
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail-actions")).toBeNull();
  });

  it("keeps the commands available with NO sessions (an empty rail is not an inert rail)", () => {
    // The rail used to render only when the list had rows; the commands are
    // exactly what a user with an empty/fresh space needs (and `New Session`
    // routes to the Open Space dialog when no space is selected).
    useSessions.setState({ activeSpacePath: "/tmp/nonexistent" });
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    expect(screen.queryByTestId("session-rail-marks")).toBeNull();
    expect(
      within(screen.getByTestId("session-rail-actions")).getByRole("button", {
        name: "New Session",
      }),
    ).toBeTruthy();
  });

  it("the left rail is WIDE ENOUGH to show its toggle (the sliver is a guarantee, not a vibe)", () => {
    // The entire design rests on one number: a collapsed pane keeps a sliver
    // of width so its bottom toggle stays on screen. jsdom never clips, so NO
    // DOM assertion here can notice a rail that shrank below the button — the
    // toggle would silently vanish while every test stayed green and the pane
    // became unopenable (no keyboard shortcut exists). Hence arithmetic:
    //   24px button (`size-6`) + 8px inset/padding + 8px clear of the edge.
    expect(LEFT_PANE_RAIL).toBeGreaterThanOrEqual(24 + 8 + 8);
  });
});

describe("SpacesList (the generated session title)", () => {
  /** Seed ONE archived session with a generated title and NO transcript —
   * the title is then the row's only label source (the message derivation
   * has nothing to fall back to but the space name). */
  function seedArchivedTitled(title: string): void {
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [
        {
          sessionId: "a1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: true,
          title,
        },
      ],
      messages: {},
    });
  }

  it("labels a titled STORED row by its title, and an untitled row by its first message", () => {
    // `h1` gets a generated title; `s1` carries the backend's pre-naming
    // `title: null`, which must keep the OLD message-derived label.
    useSessions.setState({
      sessions: [
        {
          sessionId: "s1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
          title: null,
        },
      ],
      historySessions: [
        {
          sessionId: "h1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
          title: "Rewriting the parser",
        },
        { sessionId: "h2", cwd: "/tmp/beta", capabilities: {}, archived: false },
      ],
    });
    render(<SpacesList />);
    // The titled row shows the title INSTEAD of its first message.
    expect(screen.getByText("Rewriting the parser")).toBeTruthy();
    expect(screen.queryByText("Refactor the parser")).toBeNull();
    // …and the untitled row is labelled exactly as before.
    expect(screen.getByText("Fix the login bug")).toBeTruthy();
  });

  it("labels a titled LIVE row by its title (the row reads `sessions`, not only the stored lists)", () => {
    // The live case is the one the `session-titled` push feeds: the row's
    // `SessionInfo` is the entry in `sessions`, which the push rewrites.
    useSessions.setState({
      sessions: [
        {
          sessionId: "s1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
          title: "Porting the session namer",
        },
      ],
    });
    render(<SpacesList />);
    expect(screen.getByText("Porting the session namer")).toBeTruthy();
    expect(screen.queryByText("Fix the login bug")).toBeNull();
  });

  it("shows the titled archived row as `{title} · {spaceName}` (the space cue stays for a GENERATED title)", () => {
    // The suffix rule is about the SPACE CUE, not about the title's origin:
    // the row sits inside the Archived section, where which Space it belongs
    // to is the one thing the section itself does not say. A generated title
    // is never the space name, so the cue still shows.
    seedArchivedTitled("Archiving the log rotation");
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    expect(screen.getByText(/^Archiving the log rotation/).textContent).toBe(
      "Archiving the log rotation · alpha",
    );
  });

  it("names the delete-confirmation dialog by the generated title", () => {
    // The dialog's title is the SAME derivation as the row's, so the user
    // confirms the row they just clicked.
    seedArchivedTitled("Rotating the archived logs");
    render(<SpacesList />);
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Rotating the archived logs" }),
    );
    // Scoped to the dialog: the ROW renders the same title text, and
    // `getByText` would otherwise match both and throw on ambiguity.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete session?")).toBeTruthy();
    expect(within(dialog).getByText("Rotating the archived logs")).toBeTruthy();
  });
});
