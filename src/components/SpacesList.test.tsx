import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import {
  deleteSession,
  getSettings,
  listAgentConfig,
  listSkills,
  saveSettings,
  setSessionArchived,
  startSession,
  type AgentConfigDto,
  type AppSettings,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import {
  getLeftPaneCollapsed,
  LEFT_PANE_RAIL,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "../lib/newSpaceDialogState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearAgentCatalogCache } from "../hooks/useAgentCatalog";
import SpacesList from "./SpacesList";

/**
 * The settings document the STORE is seeded with (see the `beforeEach` below).
 *
 * TYPED as `AppSettings`, which is deliberate: the `getSettings` mock factory's
 * literal below is untyped (a hoisted `vi.mock` factory cannot reference an outer
 * const), so `tsc` cannot check that document for a missing key. This one is
 * checked, and `AgentsDialog` reads `settings.agentOverrides` off the STORE — so
 * if this fixture ever lacks the field, the build catches it instead of the modal
 * throwing for a key that only shows up at runtime.
 */
const SETTINGS_FIXTURE: AppSettings = {
  theme: "dark",
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  // The value the STORE holds. The read-modify-write test below makes the
  // RE-READ return a different one, which is what proves the save composes from
  // the fresh document and not from this copy.
  defaultModel: "stale/model",
  defaultThinkingLevel: null,
  enabledTools: [],
  providers: [],
  mcpServers: {},
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
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
};

/** One `list_agent_config` row (the Agents modal's data). */
function agentRow(overrides: Partial<AgentConfigDto> = {}): AgentConfigDto {
  return {
    name: "scout",
    description: "Fast recon",
    scope: "user",
    path: "/u/.agents/agents/scout.md",
    file: { model: null, thinking: null, tools: null },
    override: { model: null, thinking: null, tools: null },
    effective: { model: null, thinking: null, tools: null },
    source: { model: "parent", thinking: "parent", tools: "parent" },
    shadowed: [],
    ...overrides,
  };
}

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // `AppSettings` document (a full shape — the `AppSettings` interface
    // mirrors the Rust `Settings` struct exactly). UNtyped, because a hoisted
    // `vi.mock` factory cannot reference the typed `SETTINGS_FIXTURE` above —
    // which is exactly why `agentOverrides: {}` had to be added to this literal
    // BY HAND and why the store seeding below uses the typed one instead.
    getSettings: vi.fn().mockResolvedValue({
      theme: "dark",
      palette: null,
      paneLayout: {},
      defaultTrustNewSpaces: false,
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledTools: [],
      providers: [],
      mcpServers: {},
      font: { sizePx: 14, uiFamily: null, codeFamily: null },
      defaultThinkingLevels: {},
      agentOverrides: {},
      spinnerStyle: null,
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
        shadowed: [],
      },
    ]),
    setSessionArchived: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    // The Agents modal's three catalog sources + its write path.
    listAgentConfig: vi.fn().mockResolvedValue([agentRow()]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: "Qwen3.8",
        provider: "tama",
        contextWindow: 200_000,
        supportsThinking: true,
        thinkingLevels: ["high", "medium", "low"],
      },
    ]),
    listTools: vi.fn().mockResolvedValue(["grep", "read_file"]),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedStartSession = vi.mocked(startSession);
const mockedListSkills = vi.mocked(listSkills);
const mockedDeleteSession = vi.mocked(deleteSession);
const mockedGetSettings = vi.mocked(getSettings);
const mockedSaveSettings = vi.mocked(saveSettings);
const mockedListAgentConfig = vi.mocked(listAgentConfig);

/**
 * The MOUNT PROBE for the render-site pin (see
 * `the dialog is mounted OUTSIDE the panes content region`).
 *
 * Why a probe and not an ancestor walk on the dialog node: `DialogContent` portals
 * itself to `document.body` — Radix's `Dialog.Content` renders an internal `Portal`
 * for a modal dialog, NOT the `DialogPortal` the app's `ui/dialog` merely re-exports
 * (stubbing that wrapper is INERT; `Dialog.Content` portals regardless, which is how
 * this test was first written and found vacuous). So in any real mount the dialog
 * node is a child of `document.body` whether the component was mounted inside the
 * `visibility: hidden` content region or beside it — `contains()` and any
 * `painted()`-style ancestor walk pass EVEN WITH THE BUG PRESENT.
 *
 * The wrapper below renders an ordinary (unportalled) node next to the real dialog.
 * Its position in the DOM is EXACTLY where `SpacesList` mounted the component, so it
 * reports the one fact the collapse depends on. Real `AgentsDialog` is still
 * rendered, so every other test in this file runs against the real modal; the probe
 * is a sibling `div` with no role, so it cannot disturb a `getByRole` query.
 */
let probeOn = false;

vi.mock("./AgentsDialog", async () => {
  const actual = await vi.importActual<typeof import("./AgentsDialog")>(
    "./AgentsDialog",
  );
  const Real = actual.default;
  return {
    default: (props: Parameters<typeof Real>[0]) =>
      React.createElement(
        React.Fragment,
        null,
        // Read at RENDER time (the factory is hoisted above this file's `let`).
        probeOn
          ? React.createElement("div", {
              "data-testid": "agents-mount-probe",
            })
          : null,
        React.createElement(Real, props),
      ),
  };
});

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
 * Open the Agents modal AND wait until it holds a ROW.
 *
 * `await screen.findByRole("dialog")` on its own is not enough to open the modal
 * the tests then edit: the rows come from `useAgentCatalog`, which starts at `[]`
 * and only fills in when `list_agent_config` lands, so a dialog found on the
 * click's own tick can be the one rendering `No Agent definitions found.`. Every
 * test below that open makes the next lookup SYNCHRONOUS
 * (`within(dialog).getByRole("Model for scout")`), so whenever the fetch lost that
 * race the failure read "the model button is missing" for a modal that was fine and
 * a write path that was fine — a flake with no subject. Awaiting one row control
 * makes the open deterministic, and it happens BEFORE any edit, so it cannot reorder
 * the writes the tests are about.
 */
async function openAgentsModal(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("button", { name: "Model for scout" });
  return dialog;
}

/**
 * A RECORDING SUBSCRIPTION to the settings store: every `agentOverrides` map the
 * store holds from now on, in order, as JSON (consecutive duplicates collapsed).
 *
 * Why a trace and not a final read: the defect this exists for is a GLIMPSE, not
 * an end state. Each link of the `agentOverrides` write chain publishes its own
 * snapshot when it completes, so a slow link finishing AFTER a newer optimistic
 * publish hands the store the OLDER map — the user's newer pick flickers back to
 * "Inherits" for a frame, and any edit composed inside that window silently loses
 * a field from `settings.json`. `waitFor(() => store == X)` cannot see that at
 * all: it polls for a condition that the buggy code also ends up satisfying, so
 * the assertion of record has to be about the SEQUENCE the store passed through.
 *
 * `subscribe` is the store's own notify path (zustand without the selector
 * middleware, hence the manual dedupe), and the record is synchronous with each
 * `set`, so a publish that happens inside a promise continuation is captured even
 * when no React render is watching.
 */
function traceAgentOverrides(): { seen: () => string[]; stop: () => void } {
  const seen: string[] = [];
  const record = (settings: AppSettings | null) => {
    const map = JSON.stringify(settings?.agentOverrides ?? null);
    if (seen[seen.length - 1] !== map) seen.push(map);
  };
  record(useSettings.getState().settings);
  const unsubscribe = useSettings.subscribe((state) => record(state.settings));
  return { seen: () => seen, stop: unsubscribe };
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
// Seed the SETTINGS STORE. `SpacesList.tsx` did not read `useSettings` before the
// Agents modal mounted (only `main.tsx`'s boot path ever populated it), and this
// file never seeded it — so with the mount's `settings &&` guard the dialog would
// render in NO test here, and every failure would read as "the Agents button is
// broken" when the real cause is an empty store. The same seeding pattern
// `ChatStream.test.tsx` uses. Reset to `null` first: the store is module-scoped,
// so a test that writes settings must not leak them into the next one.
beforeEach(() => {
  useSettings.setState({ settings: null, loaded: false });
  useSettings.getState().setSettings(SETTINGS_FIXTURE);
});
// The hook's module-level catalog cache is shared across tests in a
// file: clear it so each test refetches (without this, test 1's warm
// cache — keyed by the `seed()` fixture's `cwd` — makes a later test's
// fresh `listSkills` mock moot).
beforeEach(clearSkillCatalogCache);
// …and the same for the Agent catalog's module-level cache (the Agents modal
// fetches through `useAgentCatalog`, keyed by the `seed()` fixture's Space).
beforeEach(clearAgentCatalogCache);
// The left-pane collapsed flag is module-scoped: reset it between tests
// (the module is the single persistence owner — `setLeftPaneCollapsed`
// writes localStorage itself).
beforeEach(() => {
  setLeftPaneCollapsed(false);
});
// jsdom has no layout, so Radix's `Select` throws on the focus-first-option
// scroll (`candidate?.scrollIntoView is not a function`). The repo-wide
// convention for this in every file that mounts a `Select`
// (`SettingsPage.test.tsx`, `SessionConfigSelect.test.tsx`, …) — this file
// needed it the moment a test opened the Agents modal's Thinking select.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
// The Open-Space-dialog flag is module-scoped too, and THIS file can raise
// it (the `Open Space` button, the rail icon, `⌘O`, the `…` menu). A leaked
// `true` makes every later `render(<SpacesList/>)` auto-mount a real Radix
// modal, which sets `document.body.style.pointerEvents = "none"` and
// `aria-hidden`s its siblings — so unrelated `getByRole` queries further down
// this file throw for a reason that has nothing to do with them. Reset at
// FILE scope, not inside one `describe`.
beforeEach(() => {
  setNewSpaceDialogOpen(false);
});
// The mount probe above is a module-level switch: a test that asks for it must
// not leak it into the tests after it.
beforeEach(() => {
  probeOn = false;
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
    // Asserted on the SHARED FLAG, not on the dialog's "New space" title: this
    // pane RAISES the flag and no longer renders the dialog (`App` root owns the
    // render site), so a text query here can only ever fail. The dialog's own
    // title is pinned in `NewSpaceDialog.test.tsx`, and its root render in
    // `App.test.tsx`.
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("opens the Open Space dialog from the New Session button when no space is selected", () => {
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/ }));
    // The no-Space routing is the STORE command's now (`startSessionInActiveSpace`
    // → `openNewSpaceDialog`), so the button just delegates. Same flag assertion
    // as above — the dialog itself is rendered at `App` root.
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("raises the flag but renders NO dialog of its own (the render site is `App` root)", () => {
    // The one-dialog rule, pinned from this side: this pane is one of the flag's
    // FOUR raisers, so if it also mounted a dialog the app would paint two (and
    // `App.test.tsx` would see a doubled title). Put the flag-gated dialog render
    // back in `SpacesList.tsx` and this goes red.
    setNewSpaceDialogOpen(true);
    render(<SpacesList />);
    expect(getNewSpaceDialogOpen()).toBe(true);
    expect(screen.queryByText("New space")).toBeNull();
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

  it("ignores nothing on its own: ⌘N on an <input> is the chord's business now, and a dialog is inert", () => {
    // The chord left this component, so this file cannot test the guard — but it
    // keeps the two facts that used to be entangled with it, and separates them:
    // (1) the OLD input half is INVERTED. A text-field target no longer suppresses
    // the chord; whether the chord fires is `useAppShortcuts.test.ts`'s case, and
    // what belongs HERE is that this pane mounts no listener at all, so dispatching
    // a chord against an input inside it starts nothing on its own.
    // (2) the `role="dialog"` half survives as a statement about THIS pane: raising
    // the flag while a keypress happens inside a dialog does not stack a second
    // dialog, because the flag has one owner.
    render(<SpacesList />);
    const input = document.createElement("input");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    // Appended to `document.body` OUTSIDE RTL's render tree — RTL cleanup
    // does not touch manually appended nodes, so remove them explicitly.
    document.body.append(input, dialog);
    try {
      fireEvent.keyDown(input, { key: "n", ctrlKey: true });
      // No listener in this pane any more: nothing this component owns reacts.
      expect(mockedStartSession).not.toHaveBeenCalled();
      expect(getNewSpaceDialogOpen()).toBe(false);
      // A `[role="dialog"]` keypress raises nothing either — and the guard that
      // makes the chord inert there is pinned in `useAppShortcuts.test.ts`.
      fireEvent.keyDown(dialog, { key: "o", metaKey: true });
      expect(getNewSpaceDialogOpen()).toBe(false);
    } finally {
      input.remove();
      dialog.remove();
    }
  });

  // The two chord tests that used to live here — `⌘N / Ctrl+N trigger the New
  // Session handler (a bare key does not)` and `⌘O opens the Open Space dialog` —
  // MOVED to `../hooks/useAppShortcuts.test.ts`. They dispatched on `window`, which
  // was only reachable because this component subscribed on `window`; no listener
  // remains here, so keeping them would mean they pass vacuously. Their coverage
  // moved with them (plus the `contenteditable="false"` case, the textarea cases,
  // the auto-repeat case and the dialog/alertdialog guard cases).

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

  // -------------------------------------------------------------------------
  // The Agents modal (ADR 0066 / ADR 0068) — the fourth command in this pane,
  // mounted beside `Skills` with the same two boundaries: it must survive the
  // collapse (the rail icon), and it must render OUTSIDE the content region.
  // -------------------------------------------------------------------------

  it("an_Agents_button_exists_and_opens_the_dialog", async () => {
    render(<SpacesList />);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    // `getByRole("dialog")`, NEVER a text query: the pane now holds BOTH a
    // button labelled `Agents` AND a `DialogTitle` reading `Agents`, so
    // `findByText("Agents")` matches two nodes and throws on ambiguity (the same
    // hazard this file documents for `Skills`).
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Agents")).toBeTruthy();
    // The row came from `list_agent_config` keyed by the ACTIVE Space. AWAITED,
    // for the reason `openAgentsModal` states: the rows arrive with the fetch, so
    // a row queried on the dialog's own tick can race it.
    expect(await within(dialog).findByText("scout")).toBeTruthy();
  });

  it("the_collapsed_rails_Agents_icon_opens_the_dialog_too", async () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
    fireEvent.click(screen.getByTitle("Agents"));
    // The dialog renders while the pane is COLLAPSED — the acceptance criterion,
    // and the reason the render site sits outside the `invisible` content region.
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("scout")).toBeTruthy();
  });

  it("the dialog is mounted OUTSIDE the panes content region (structural)", async () => {
    // The hazard is real and invisible: the content region carries
    // `visibility: hidden` while the pane is collapsed, and `visibility` INHERITS
    // into `fixed` descendants — a dialog mounted inside that region opens with
    // nothing painted. The file's comment at the close of the region says exactly
    // this about `SkillsDialog`, and the Agents dialog has the same requirement.
    //
    // WHY THE ASSERTION IS STRUCTURAL AND NOT A `visibility` TEST OF THE DIALOG.
    // `DialogContent` portals itself to `document.body` (Radix's `Dialog.Content`
    // renders an internal `Portal` — not the `DialogPortal` `ui/dialog`
    // re-exports, so stubbing THAT wrapper is inert; an ancestor walk on the real
    // dialog passed even with the dialog mounted inside the hidden region).
    // jsdom therefore CANNOT demonstrate the `visibility` argument behaviourally on
    // the dialog node: it is never a DOM descendant of the region in ANY
    // configuration.
    //
    // The `agents-mount-probe` (see the mock at the top of this file) is an
    // ordinary un-portalled node rendered at the same site as the dialog, so its
    // PARENT reports where the component was actually mounted. The second
    // assertion reads the same `invisible` class the collapse applies through the
    // `painted()` helper — the structural statement of the `visibility` argument.
    // Move the `{agentsOpen && settings && …}` render inside the content-region
    // `<div>` and BOTH assertions go red (measured; see the commit notes).
    probeOn = true;
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const pane = container.firstChild as HTMLElement;
    expect(pane.tagName).toBe("ASIDE");
    // THE CONTENT REGION — the div that carries `invisible` while collapsed. The
    // dialogs sit under the `<aside>` BESIDE this div, so the region (not the pane
    // frame) is the container whose `visibility` is the hazard.
    const contentRegion = pane.firstElementChild as HTMLElement;
    expect(contentRegion.classList.contains("invisible")).toBe(true);
    fireEvent.click(screen.getByTitle("Agents"));
    const probe = await screen.findByTestId("agents-mount-probe");
    // The dialog ITSELF is rendered too (the probe is a sibling, not a
    // replacement) — so this cannot pass on a component that never mounted.
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The mount site is outside the hidden region…
    expect(contentRegion.contains(probe)).toBe(false);
    // …and consequently PAINTED while collapsed.
    expect(painted(probe)).toBe(true);
  });

  it("the Portal relocates the dialog to document.body (why the test above needs a probe)", async () => {
    // The fact that makes a plain structural walk vacuous, pinned rather than
    // assumed: with the Portal live (the default here), the dialog node is a
    // child of `document.body` — NOT of the pane — whichever render site the
    // component uses. If Radix ever stops relocating (or the app starts passing a
    // `container`), the probe above stops being the only discriminator and this
    // test says so out loud.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    const pane = container.firstChild as HTMLElement;
    fireEvent.click(screen.getByTitle("Agents"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    // Which is exactly the configuration in which `pane.contains(dialog)` is
    // `false` for BOTH render sites — the reason it is not the assertion of
    // record above.
    expect(pane.contains(dialog)).toBe(false);
  });

  it("picking_a_model_saves_agentOverrides_through_a_read_modify_write", async () => {
    // The one new write path in the feature. The save must be composed from a
    // FRESH `get_settings` read, never from the store's copy: Rust writes
    // `settings.json` on its own (`agent/session/mod.rs:1678` persists a
    // remembered thinking level via load-mutate-write), so the store can be
    // holding a stale document and composing from it would silently clobber a
    // concurrent change.
    //
    // The re-read returns a document whose `defaultModel` DIFFERS from the store
    // fixture's, so "every other field preserved" can only pass by reading the
    // fresh document — a save composed from the store would write `stale/model`.
    // Its `agentOverrides` carries a SECOND agent on purpose: that entry is
    // expected to be REPLACED away, because the map is the one field the user is
    // editing and the dialog hands over the whole edited map (see the write
    // helper's comment in `SpacesList.tsx` — sound because no writer outside this
    // modal is live while the modal is, the one exception being `SettingsPage`'s
    // Provider-rename remap, which cannot overlap because Settings unmounts this pane).
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      defaultModel: "fresh/model",
      agentOverrides: { plan: { thinking: "high" } },
    };
    // The store seed (already set) is `SETTINGS_FIXTURE`; the RE-READ is `fresh`.
    mockedGetSettings.mockResolvedValue(fresh);
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
    // The re-read happened BEFORE the save (the read-modify-write order).
    expect(mockedGetSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSaveSettings.mock.invocationCallOrder[0],
    );
    expect(mockedSaveSettings).toHaveBeenCalledWith({
      ...fresh,
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
    });
    // Every field OTHER than the edited map is the FRESH document's, byte-identical
    // — the store's stale `defaultModel` must not appear anywhere in the call.
    const saved = mockedSaveSettings.mock.calls[0][0];
    expect(saved.defaultModel).toBe("fresh/model");
    expect(JSON.stringify(saved)).not.toContain("stale/model");
    // And the store now agrees with the file (a divergent store is how the next
    // write gets composed from a document that no longer exists).
    expect(useSettings.getState().settings).toEqual({
      ...fresh,
      agentOverrides: { scout: { model: "tama/Qwen3.8" } },
    });
  });

  it("two rapid edits both land in the file (the writes are serialized)", async () => {
    // The dialog builds the map it hands over from the RENDER-TIME store
    // snapshot, and the store only catches up once `getSettings` → `saveSettings`
    // resolve. So a second edit issued inside that window carries a map that has
    // never seen the first edit's field, and the write replaces the map
    // WHOLESALE — the first pick vanishes from `settings.json` with no feedback.
    // A model-pick then a thinking-pick is one natural ~300ms gesture, so this is
    // the ordinary case, not a corner.
    //
    // The save is held open here to make that window deterministic instead of
    // timing-dependent: the second edit is issued while the first save is
    // provably still in flight. What is asserted is the END STATE of the file —
    // the LAST document written carries both fields, whether that comes from one
    // coalesced save or from two serialized ones.
    let releaseFirstSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        }),
    );
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit 1: the model.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    // Edit 2: the thinking level, WITHOUT awaiting the first save.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    act(() => releaseFirstSave());
    // The second write still flows after the first lands (the chain is not
    // abandoned when a link resolves slowly — or when one fails).
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(1),
    );
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides).toEqual({
      scout: { model: "tama/Qwen3.8", thinking: "high" },
    });
    // …and the store agrees with the file the user just wrote.
    await waitFor(() =>
      expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
        model: "tama/Qwen3.8",
        thinking: "high",
      }),
    );
  });

  it("a newer optimistic publish is never reverted by an older link completing (no flicker)", async () => {
    // The half of the serialized chain the FILE writes do not cover. Every link
    // writes its map in the right ORDER, but each link also PUBLISHES its own
    // snapshot on completion: success → `setSettings(freshDocument)` with THIS
    // link's map, failure → `loadSettings()` re-seed. So with edit A in flight and
    // edit B published optimistically on top of it, link A landing hands the store
    // the {A}-only map — B's pick visibly reverts for a frame, and an edit C
    // composed in that window builds on {A} and silently drops B from the file.
    // Deterministic on every rapid two-edit gesture (this is the same window the
    // test above holds open on purpose).
    //
    // The assertion is the STORE TRACE (see `traceAgentOverrides`): the end state
    // is what the buggy code also eventually reaches, so only the SEQUENCE shows
    // the regression. `settle()` is a macrotask turn — enough for the continuation
    // after a resolved `getSettings`/`saveSettings` to run and publish, which is
    // the exact moment the bug paints.
    const MODEL_ONLY = JSON.stringify({ scout: { model: "tama/Qwen3.8" } });
    const BOTH = JSON.stringify({
      scout: { model: "tama/Qwen3.8", thinking: "high" },
    });
    let releaseFirstSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        }),
    );
    // The trace starts BEFORE any edit, so its first entry is the empty map and
    // every later entry is something the write path published.
    const trace = traceAgentOverrides();
    try {
      render(<SpacesList />);
      const dialog = await openAgentsModal();
      // Edit A: the model — its save is now provably in flight.
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Model for scout" }),
      );
      fireEvent.click(await screen.findByText("Qwen3.8"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
      // Edit B: the thinking level, composed on the optimistically-published map.
      fireEvent.click(
        within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
      );
      fireEvent.click(await screen.findByRole("option", { name: "high" }));
      // B's optimistic publish is in the trace, and nothing older has landed yet.
      expect(trace.seen()).toContain(BOTH);
      // Now land A. Its link still holds the {A}-only map.
      act(() => releaseFirstSave());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // THE FLICKER: after B published the two-field map, the store must never be
      // handed the {A}-only map again. (Read off the trace, not off the store — a
      // later link republishes the newer map, so the end state hides this.)
      const afterB = trace.seen().slice(trace.seen().indexOf(BOTH) + 1);
      expect(afterB).not.toContain(MODEL_ONLY);
      // End states, in the shape `two rapid edits both land` asserts them: the last
      // write is the file's answer and the store agrees with it.
      const lastSaved =
        mockedSaveSettings.mock.calls[
          mockedSaveSettings.mock.calls.length - 1
        ][0];
      expect(JSON.stringify(lastSaved.agentOverrides)).toBe(BOTH);
      expect(JSON.stringify(useSettings.getState().settings?.agentOverrides)).toBe(
        BOTH,
      );
    } finally {
      trace.stop();
    }
  });

  it("three edits while the first save is in flight keep the middle pick", async () => {
    // The gesture the flicker actually costs something in. With link A still in
    // flight, B publishes {A,B}; A's completion reverts the store to {A}; edit C is
    // then composed off the REVERTED store, so the map handed to the third write
    // never saw B and B is deleted from `settings.json` with no feedback. The
    // middle pick is the one the user cannot see being lost, because the picker
    // they are looking at is already showing C.
    //
    // BOTH of the first two saves are held open, so the window between link A's
    // publish and link B's is open for the whole time C is issued — the window the
    // bug lives in, made deterministic instead of a race. (Holding only the first
    // would let link B republish the two-field map before C happens, and the test
    // would pass for the wrong reason.)
    const deferred = (): { promise: Promise<void>; release: () => void } => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const first = deferred();
    const second = deferred();
    mockedSaveSettings
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // A — the model.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(1);
    // B — the thinking level.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    // Link A lands and publishes while link B's save is still held — the exact
    // moment the store is holding the OLDER map.
    act(() => first.release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedSaveSettings).toHaveBeenCalledTimes(2);
    // C — a tool tick, composed off whatever the store is holding right now.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Override tool grep for scout" }),
    );
    // Let C's link start its save, then land B's (the queued one).
    act(() => second.release());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    // End states (same shape as `two rapid edits both land`): the LAST document
    // written carries all three fields, and the store agrees with the file.
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides).toEqual({
      scout: { model: "tama/Qwen3.8", thinking: "high", tools: ["grep"] },
    });
    await waitFor(() =>
      expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
        model: "tama/Qwen3.8",
        thinking: "high",
        tools: ["grep"],
      }),
    );
  });

  it("a slow first save cannot land after the second edit's save (out-of-order writes)", async () => {
    // The other half of the same gesture, and the half the store's optimistic
    // publish CANNOT fix: two `saveSettings` calls are two independent IPC round
    // trips, so the FIRST one can resolve LAST and write the older map over the
    // newer file. The chain in `patchAgentOverrides` is what makes "last edit
    // wins" mean the last map the user produced rather than whichever round trip
    // finished second.
    //
    // Deterministic instead of racy: call 1's save is held open, call 2's resolves
    // at once (the factory's default). Unserialized, call 2 writes both fields
    // first and call 1 then writes the model-only map on top of it; serialized,
    // call 2 does not even start until call 1 has landed.
    let releaseFirstSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        }),
    );
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    // Let whatever is queued settle, THEN land the first save. Anything that
    // writes after this point is the last word the file gets.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => releaseFirstSave());
    // A REAL settle (not a bare `waitFor`, which would pass on the store's state
    // from BEFORE the late save landed — the exact state the bug leaves behind):
    // each successful save publishes its own document, so the store now reports
    // what the LAST-RESOLVING write wrote, i.e. what the file ends up holding.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useSettings.getState().settings?.agentOverrides.scout).toEqual({
      model: "tama/Qwen3.8",
      thinking: "high",
    });
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides).toEqual({
      scout: { model: "tama/Qwen3.8", thinking: "high" },
    });
  });

  it("a failed save does not strand the edit after it (the chain stays alive)", async () => {
    // The chain is a promise held in a ref, so a rejection would be POISON: every
    // later link would resolve to that same stale rejection and no subsequent edit
    // would ever reach the file. The write helper swallows its own error (log +
    // re-seed) precisely so the chain survives a failed link.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit 1 fails.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    // Edit 2 still reaches the file.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    // …and the map that landed carries the second edit.
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides.scout?.thinking).toBe("high");
    consoleError.mockRestore();
  });

  it("a throwing failure logger does not poison the chain (the swallow is structural)", async () => {
    // The swallow's own failure mode. A `catch` block inside `writeAgentOverrides`
    // makes the swallow depend on the error HANDLER being infallible: if
    // `console.error` itself throws — a broken logger, an environment that throws
    // on logging, a re-seed that throws — the CATCH throws, the link resolves to a
    // REJECTION, and every write chained after it silently resolves to that same
    // stale rejection without touching the file. The modal keeps looking like it
    // saves (the optimistic publish is synchronous) forever after.
    //
    // So the swallow belongs on the CHAIN LINK (`.catch(() => {})` before the
    // `.then`), not only inside the helper: nothing the failure path does can then
    // disable the queue. This test is the difference between those two spellings —
    // with the swallow inside the helper it fails, because the poisoned link eats
    // edit 2's save entirely (`saveSettings` is never called a second time).
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {
        throw new Error("the logger is broken too");
      });
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Edit 1 fails, and handling that failure fails as well.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    // Edit 2 still reaches the file.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    await waitFor(() =>
      expect(mockedSaveSettings.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    const lastSaved =
      mockedSaveSettings.mock.calls[mockedSaveSettings.mock.calls.length - 1][0];
    expect(lastSaved.agentOverrides.scout?.thinking).toBe("high");
    consoleError.mockRestore();
  });

  it("a landed save still evicts the catalog when the store publish throws (and is not logged as a save failure)", async () => {
    // The other half of making the swallow STRUCTURAL: what the error handler
    // COVERS. Today `setSettings` sits inside the same `try` as the save and the
    // eviction, so a publish that throws after a save that LANDED is reported as
    // "Failed to save agent overrides" — a lie about a write the file has — and the
    // eviction after it is skipped, so the modal keeps serving `runs` columns
    // resolved against the map that edit replaced.
    //
    // The two facts are independent: the save landed (→ evict, → do not log a save
    // failure), and the store mirror failed (→ the store lags, nothing more). So the
    // publish is the one step the epoch guard already stands in front of, and the
    // eviction happens whatever the publish does.
    const realPublish = useSettings.getState().setSettings;
    let publishes = 0;
    // Replaced ON THE LIVE STATE OBJECT (not `vi.spyOn(getState(), …)`): zustand
    // `set` builds a NEW state object on every write, so a spy installed on the old
    // one is what gets restored, and the live store would keep the spy.
    const publish = (document: AppSettings) => {
      publishes += 1;
      // Call 1 is the optimistic publish in `patchAgentOverrides` — let it through,
      // or the modal never re-renders and the second edit cannot happen. Call 2 is
      // the success mirror, and it is the one that throws.
      if (publishes > 1) throw new Error("store publish failed");
      realPublish(document);
    };
    useSettings.setState({ setSettings: publish });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = render(<SpacesList />);
      const dialog = await openAgentsModal();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Model for scout" }),
      );
      fireEvent.click(await screen.findByText("Qwen3.8"));
      await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
      // Let the success path run to completion (the throw is inside it).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // A save that landed is not a save failure.
      expect(consoleError).not.toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      );
      // …and the catalog the edit invalidated is gone anyway — the assertion the
      // eviction test uses (the next MOUNT of the hook, since the pane owns the
      // fetch): unmount and re-mount with the same Space key.
      expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
      first.unmount();
      render(<SpacesList />);
      await waitFor(() =>
        expect(mockedListAgentConfig).toHaveBeenCalledTimes(2),
      );
    } finally {
      useSettings.setState({ setSettings: realPublish });
      consoleError.mockRestore();
    }
  });

  it("logs a console error when saving Agent overrides fails (the store re-seeds from the file)", async () => {
    // The failure arm of the one write path, in this file's established shape for
    // that class (`logs a console error when Archive fails`, Unfail, Delete): the
    // rejection is LOGGED (no unhandled rejection in the webview) and the state
    // ends up agreeing with the FILE.
    //
    // The second half matters more here than it does for the archive move, because
    // the write path publishes the edited map into the store OPTIMISTICALLY before
    // the save resolves. A save that did not land therefore leaves the store
    // claiming an override the file has never seen — and the NEXT edit would be
    // composed on top of it. The re-fetch has to roll that back, so the fixture's
    // re-read carries a map that is NOT what the user picked.
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      agentOverrides: { plan: { thinking: "high" } },
    };
    mockedGetSettings.mockResolvedValue(fresh);
    mockedSaveSettings.mockRejectedValueOnce(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    // ...the rejection is logged...
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    // ...and the store ends up holding the RE-FETCHED document: the optimistic map
    // is gone, the file's map is back. (A store left holding `scout` would be the
    // lie — the picker would show a pin nothing saved.)
    await waitFor(() => expect(useSettings.getState().settings).toEqual(fresh));
    expect(useSettings.getState().settings?.agentOverrides.scout).toBeUndefined();
    consoleError.mockRestore();
  });

  it("a failed save re-arms the stored-pin cue the failed edit explained nothing about", async () => {
    // The cue's suppression has a half-life. A field the user wrote in this mount is
    // skipped, because the difference against the FETCH-time `row.override` column is
    // explained by a save the backend already has. A save that DID NOT LAND takes
    // that explanation away: the failure path re-fetches, so the store goes back to
    // the FILE's map and the difference is again one this modal did not cause — the
    // fetch predating the file, which is exactly the case the cue exists to name. If
    // the suppression survives the failure, the row silently hides a stale-column
    // disagreement forever after, for a gesture that never happened.
    //
    // The fixture wires that case end to end: the fetched row says the stored pin was
    // `max`, the FILE says `low`, and the store starts with no pin at all — so the cue
    // is legitimately up at mount, the pick suppresses it, and only the rollback can
    // bring it back.
    const fresh: AppSettings = {
      ...SETTINGS_FIXTURE,
      agentOverrides: { scout: { thinking: "low" } },
    };
    mockedGetSettings.mockResolvedValue(fresh);
    // The save is held open, so "in flight" is a state the test can look at: the
    // rejection has to arrive on the test's schedule or the suppressed window is
    // over before the assertion runs.
    let failSave!: () => void;
    mockedSaveSettings.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failSave = () => reject(new Error("boom"));
        }),
    );
    mockedListAgentConfig.mockResolvedValue([
      agentRow({ override: { model: null, thinking: "max", tools: null } }),
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<SpacesList />);
    const dialog = await openAgentsModal();
    // Mount: the fetch's column (`max`) and the store's map (no pin) disagree, and
    // nothing in this modal caused that.
    expect(
      await screen.findByText(/stored pin the last fetch saw differs/),
    ).toBeTruthy();
    // The edit: `high`, and its save is provably still in flight.
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Thinking for scout" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "high" }));
    await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
    // The difference is explained by a save the backend is being told about, so the
    // cue goes quiet for that field.
    expect(
      screen.queryByText(/stored pin the last fetch saw differs/),
    ).toBeNull();
    // The save fails and the store rolls back to the FILE's map (`low`).
    act(() => failSave());
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to save agent overrides:",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(useSettings.getState().settings).toEqual(fresh));
    // THE RE-ARM: the suppressed edit never landed, so the `max`-vs-`low`
    // disagreement is unexplained again and the row has to say it.
    const cue = await screen.findByText(/stored pin the last fetch saw differs/);
    expect(cue.textContent).toContain("thinking max");
    consoleError.mockRestore();
  });

  it("a successful save evicts the Agent catalog (no stale runs after an edit)", async () => {
    // `useAgentCatalog` caches the in-flight promise per Space on purpose (rule 3
    // of the hook's four rules): an UNCHANGED key never evicts, so a remount reuses
    // the settled entry instead of re-running a NETWORK-BOUND discovery. That is
    // right for a remount that changes nothing, and wrong after a WRITE — `runs` is
    // "what the last fetch saw the dispatch launch with", and the map that fetch
    // resolved against has just been replaced. Invalidation-on-write is what rule
    // 3 assumed someone would add if a writer ever appeared; this is that writer.
    //
    // The assertion is about the next MOUNT of the hook, because that is what the
    // eviction can affect: the catalog is fetched by the PANE (the dialog is
    // prop-driven), so re-opening the modal inside one pane mount cannot re-run the
    // effect — the rows it renders were fetched at mount. Unmounting the pane (the
    // Settings view does exactly that) and mounting it again with the SAME key is
    // the case the cache would otherwise serve a pre-edit answer for.
    const first = render(<SpacesList />);
    const dialog = await openAgentsModal();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Model for scout" }),
    );
    fireEvent.click(await screen.findByText("Qwen3.8"));
    await waitFor(() => expect(mockedSaveSettings).toHaveBeenCalledTimes(1));
    // One fetch so far — the mount's.
    expect(mockedListAgentConfig).toHaveBeenCalledTimes(1);
    // …the pane unmounts (Settings view) and mounts again, same Space key…
    first.unmount();
    render(<SpacesList />);
    // …and the catalog is re-fetched rather than served from the entry the write
    // invalidated.
    await waitFor(() => expect(mockedListAgentConfig).toHaveBeenCalledTimes(2));
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
    // The negative pin, on the FLAG: "it did not fall back to the dialog" is the
    // claim, and `queryByText("New space")` could no longer express it — this pane
    // renders no dialog, so a text query there would pass for every input.
    expect(getNewSpaceDialogOpen()).toBe(false);
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

  // -- The pane holds NO controls at all: the collapse toggle and the Settings
  // -- gear both live in the chrome bar's `ChromeControls`, beside the window
  // -- controls (`App.tsx`, pinned by `App.test.tsx`'s `the chrome bar carries
  // -- the app controls`). What follows asserts the ABSENCE from this pane in
  // -- both states — the shape the move leaves behind. --

  for (const state of ["expanded", "collapsed"] as const) {
    it(`holds NO collapse toggle and NO gear while ${state} (both moved to the chrome bar)`, () => {
      act(() => {
        setLeftPaneCollapsed(state === "collapsed");
      });
      const { container } = render(<SpacesList />);
      // Every label the toggle has ever carried, plus the gear's, so a rename
      // cannot quietly re-add one of these two controls here and leave this
      // test vacuous. The pane's OWN commands (`Open Space`, `New Session`,
      // `Skills`, `Agents`) are NOT in this list — they legitimately survive the
      // collapse as rail icons, which is what the rail's own tests assert.
      for (const label of [
        "Collapse sidebar",
        "Expand sidebar",
        "Settings",
      ]) {
        expect(screen.queryByRole("button", { name: label }), label).toBeNull();
      }
      // The STABLE hook, not the label: the label flips with the state, so a
      // name-only query could pass on one side of the collapse by accident.
      expect(container.querySelector('[data-testid="left-pane-toggle"]')).toBeNull();
      // The footer ROW is gone, not merely emptied. The pane's last child is
      // now the clipped content region (expanded) or the collapsed rail — both
      // of which DO hold buttons, so the check is which surface ends the pane,
      // not whether it holds any. A footer control strip would come last.
      const last = (container.firstChild as HTMLElement).lastElementChild!;
      const isContentRegion = last.contains(screen.getByText("Sessions"));
      const isRail = last.getAttribute("data-testid") === "session-rail";
      expect(
        isContentRegion || isRail,
        `the pane ends with a ${last.tagName}, not the content region or the rail`,
      ).toBe(true);
    });
  }

  it("takes its collapse from the shared flag with no control of its own", () => {
    // The pane is now a pure READER of `leftPaneState` — the writer sits in the
    // chrome bar — so collapsing from outside still resizes it. This is the
    // contract between `ChromeControls` (writer) and this pane (reader).
    const { container } = render(<SpacesList />);
    const frame = container.firstChild as HTMLElement;
    expect(frame.style.width).toBe("260px");
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(getLeftPaneCollapsed()).toBe(true);
    expect(frame.style.width).toBe(`${LEFT_PANE_RAIL}px`);
    act(() => {
      setLeftPaneCollapsed(false);
    });
    expect(frame.style.width).toBe("260px");
  });

  it("collapses to the sliver (the content stays mounted, clipped, not unmounted)", () => {
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

  it("carries NO bg-warning FILL in either state, even with a pending request (the dot rides the chrome-bar toggle now)", () => {
    // The pane's own toggle used to wear a `bg-warning` dot while collapsed.
    // That button now lives in `ChromeControls`, so the pane keeps only the
    // ROW's cue — the `?` in `text-warning`, in both sidebar states. Asserted
    // in both states, because the collapsed rail is exactly where a leftover
    // dot would have been.
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
    for (const collapsedNow of [false, true]) {
      act(() => {
        setLeftPaneCollapsed(collapsedNow);
      });
      const { container: c } = render(<SpacesList />);
      expect(c.querySelector(".bg-warning"), `collapsed=${collapsedNow}`).toBeNull();
      // …and the row DOES carry its own cue, so the assertion above cannot be
      // satisfied by a pane that shows nothing at all.
      expect(c.querySelector('[data-dot="waiting"]'), `collapsed=${collapsedNow}`).toBeTruthy();
    }
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
    for (const label of ["Open Space", "New Session", "Skills", "Agents", "Sessions", "Archived"]) {
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

  it("offers the pane's four commands as icons while collapsed (not Settings)", () => {
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container } = render(<SpacesList />);
    // The list's own four buttons survive the collapse as icons. `Settings` is
    // deliberately NOT among them: the gear lives in the chrome bar in both
    // states, so the rail used to carry a second copy and that tail strip is
    // gone (see `SessionRail`'s doc).
    //
    // FOUR, not three: `Agents` is the fourth, and it is on the rail because the
    // labelled button sits inside the region the collapse hides — dropping it
    // here would give the command a vanishing door, which is the exact defect the
    // `railActions` comment exists to prevent. Widening the count and this name
    // together is intentional, not a broken pin.
    for (const label of ["Open Space", "New Session", "Skills", "Agents"]) {
      expect(
        within(screen.getByTestId("session-rail-actions")).getByRole("button", {
          name: label,
        }),
        label,
      ).toBeTruthy();
    }
    expect(
      within(screen.getByTestId("session-rail-actions")).getAllByRole("button"),
    ).toHaveLength(4);
    // And nothing here reaches for Settings, in either strip or anywhere else.
    expect(container.querySelector('[data-testid="session-rail-tail-actions"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("wires each rail icon to the SAME handler the labelled button uses", () => {
    // Split from the presence test on purpose: `Skills` and `Open Space` open
    // MODALS, and a modal `aria-hidden`s the rest of the app — so a second
    // query against the rail after one opens fails for the correct reason
    // (testing-library honours it) and would read as a broken rail.
    // (`Settings` used to be asserted here too, through an `onOpenSettings`
    // prop — the gear is the chrome bar's now, and the pane has no such prop.)
    act(() => {
      setLeftPaneCollapsed(true);
    });
    render(<SpacesList />);
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
    // The rail's icon and the labelled button are the SAME closure, so they raise
    // the same flag — asserted on the flag, because the dialog renders at `App`
    // root now (see the button case above for why a text query is the wrong probe
    // in this file).
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("the `…` menu's \"New Session in this Space\" gets the no-Space dialog fallback too", () => {
    // The deliberate behaviour change of this task. The menu item used to call the
    // (now deleted) hook DIRECTLY, which no-oped with no Space selected — unlike
    // the button path, it had NO dialog fallback, so it was a menu item that looked
    // alive and did nothing. Routing it through `startSessionInActiveSpace` gives it
    // the store's fallback; this is the only test that would notice it going back to
    // the direct call (the button path's fallback is pinned above).
    useSessions.setState({ activeSpacePath: null });
    render(<SpacesList />);
    // Radix opens on `pointerDown` (`click` does not open the menu in jsdom) and
    // selects on `Enter` — the same two steps the menu's other test here uses.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Session actions" }),
    );
    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "New Session in this Space" }),
      { key: "Enter" },
    );
    expect(getNewSpaceDialogOpen()).toBe(true);
    // …and it did NOT try to start a Session in a Space that does not exist.
    expect(mockedStartSession).not.toHaveBeenCalled();
  });

  it("holds NO Settings door at all — the pane owns none in either state", () => {
    // The reverse of the old guarantee. This pane used to be Settings' only
    // door, which is why collapsing it needed a replacement gear in the rail;
    // the chrome bar now holds the single gear for both states, so this
    // component must render none — and must not accept an `onOpenSettings`
    // prop to be wired to. The single-door assertion lives in `App.test.tsx`.
    render(<SpacesList />);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
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

  it("the left rail is WIDE ENOUGH for its own controls (the sliver is a guarantee, not a vibe)", () => {
    // A collapsed pane keeps a sliver of width so the rail's marks and its
    // three command icons stay visible. jsdom never clips, so NO DOM assertion
    // here can notice a rail that shrank below the icons — the commands would
    // silently vanish while every test stayed green. Hence arithmetic:
    //   24px icon button (`size-6`) + 8px clear of each edge.
    // (It used to be justified as the room for the pane's OWN collapse toggle;
    // that button is in the chrome bar now, and the rail's icons still need it.)
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
