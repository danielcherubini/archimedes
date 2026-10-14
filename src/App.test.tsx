import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { externalOpen, listenSessionTitled, listenSubagentClosed } from "./lib/tauri";
import { useSessions } from "./store/sessions";
import { useSubagents } from "./store/subagents";
import { useInteractive } from "./store/interactive";
import { usePermissions } from "./store/permissions";
import { useSubagentSelection } from "./store/subagentSelection";
import { getLeftPaneCollapsed, LEFT_PANE_RAIL, setLeftPaneCollapsed } from "./lib/leftPaneState";
import { getSidePaneCollapsed, setSidePaneCollapsed } from "./lib/sidePaneState";

// Mock the Tauri IPC layer (the `importActual` pattern from
// `NewSpaceDialog.test.tsx`): the boot `useEffect` loads `listSessions` /
// `listSpaces` (resolving `[]` so the workspace renders its empty state),
// every `listen*` registration resolves a no-op unlisten (the App's
// listener `useEffect` awaits them in cleanup), and `listSkills` resolves
// `[]` (the `useSkillCatalog` hook in both `SpacesList` and `ChatStream`
// calls it on mount — the hook catches rejections, but the mock avoids
// noisy failures with a bare `vi.mock` factory).
vi.mock("./lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./lib/tauri");
  return {
    ...actual,
    listSessions: vi.fn().mockResolvedValue([]),
    listSpaces: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),
    // The three `useMentionCatalogs` fetches (`ChatStream`'s composer
    // catalogs). They MUST be mocked here: the factory spreads
    // `importActual`, so an un-mocked export still calls the REAL `invoke`,
    // which rejects in jsdom (`window.__TAURI_INTERNALS__` is undefined) and
    // the hook logs `"<name> failed:"` — 11 lines of stderr noise per test in
    // this file (green-but-noisy tests hide a real fetch failure). The empty
    // values are what the hook degrades to anyway, so the composer renders
    // exactly as it did before.
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([]),
    listMcpServersEffective: vi.fn().mockResolvedValue([]),
    listSpaceFiles: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
    // The out-of-Space Directory completion rows (ADR 0035). Required, not
    // optional: `ChatStream` calls `useCompletionDir(null)` on EVERY mount (an
    // empty draft has no token, so the derived `dirPrefix` is `null` and the
    // cache misses), and this factory spreads `importActual` — an un-mocked
    // export would fire a REAL `invoke` in jsdom and log a
    // `listCompletionEntries failed:` line in every test here.
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
    // `SettingsPage`'s data deps: the settings document + the model catalog.
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
      spinnerStyle: null,
      filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
      mcpMentionsEnabled: false,
      sessionNamingEnabled: true,
      sessionNamingModel: null,
      sessionNamingReasoning: null,
      attentionAlertsEnabled: true,
      attentionAlertDelaySecs: 15,
    }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    listTools: vi.fn().mockResolvedValue([]),
    // Every `listen*` registration resolves a no-op unlisten.
    listenSessionUpdate: vi.fn().mockResolvedValue(() => {}),
    listenSessionClosed: vi.fn().mockResolvedValue(() => {}),
    // The stalled + titled pushes: un-mocked, either export would reach the
    // REAL `listen()` in jsdom (no `window.__TAURI_INTERNALS__`), so the
    // registration rejects instead of resolving its no-op unlisten.
    listenSessionStalled: vi.fn().mockResolvedValue(() => {}),
    listenSessionTitled: vi.fn().mockResolvedValue(() => {}),
    listenPermissionRequest: vi.fn().mockResolvedValue(() => {}),
    listenInteractiveRequest: vi.fn().mockResolvedValue(() => {}),
    listenInteractiveRequestClose: vi.fn().mockResolvedValue(() => {}),
    listenInteractiveEvent: vi.fn().mockResolvedValue(() => {}),
    listenSubagentSessionStarted: vi.fn().mockResolvedValue(() => {}),
    listenSubagentClosed: vi.fn().mockResolvedValue(() => {}),
    // The attention-alert commands (`useAttentionAlert`, mounted at the top of
    // `App`). Required for the same reason as the catalog fetches above: this
    // factory spreads `importActual`, so an un-mocked export would reach the
    // REAL `invoke`, which rejects in jsdom and the hook logs
    // `attention alert failed:` — stderr noise instead of a green-and-silent run.
    attentionArm: vi.fn().mockResolvedValue(undefined),
    attentionDisarm: vi.fn().mockResolvedValue(undefined),
    // The **External open** command (ADR 0051): `OpenAnchor`'s click handler
    // calls it, and the real one reaches `invoke` — mocked so the two
    // `SpaceCwdProvider` tests below can assert the cwd it is handed.
    externalOpen: vi.fn().mockResolvedValue(undefined),
  };
});

// `App` renders `WindowControls`, which calls `getCurrentWindow()` from
// `@tauri-apps/api/window` on EVERY render (its own test file documents
// this and mocks the module); in jsdom `window.__TAURI_INTERNALS__` is
// undefined → `TypeError` during render → every case fails without it.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
});

describe("App (the gear icon + settings view swap)", () => {
  // The pane collapsed flags are module-scoped: reset them between tests.
  beforeEach(() => {
    setLeftPaneCollapsed(false);
    setSidePaneCollapsed(false);
  });

  it("the header shows the app icon (app-icon-large) and NO 'Archimedes' text (the word was removed — icon only)", () => {
    render(<App />);
    // The top-left header-bar icon (the label is gone — icon only).
    const icon = screen.getByAltText("Archimedes");
    expect(icon.getAttribute("src")).toBe("/app-icon-large.png");
    expect(screen.queryByText("Archimedes")).toBeNull();
  });

  it("the chrome bar is the drag region (the whole bar — draggable + double-click to maximize; the inner buttons stay interactive)", () => {
    render(<App />);
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    // The attribute on the CONTAINER with the value "deep": Tauri's
    // drag-region script honors a BARE attribute only on the element a
    // mousedown lands on DIRECTLY (a click on a child of a bare-attribute
    // element does NOT drag — the bar's logo segment / tab spacer would
    // be dead zones). "deep" extends the region to the whole subtree: the
    // bar's empty areas drag the window (double-click maximizes) while the
    // inner buttons/tabs (interactive elements without the attribute) still
    // block it and stay clickable.
    expect(chrome.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("renders the Space tabs in the top chrome bar (browser-style — NOT in the center column)", () => {
    render(<App />);
    const tabs = screen.getByTestId("space-tabs");
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    // The tabs are a direct child of the chrome bar (the top row) — the
    // old position was the center column's top row (above the chat).
    expect(chrome.contains(tabs)).toBe(true);
    expect(tabs.parentElement).toBe(chrome);
    // …and the content row (the second child) does NOT contain them.
    const content = document.querySelector('[data-testid="content-row"]')!;
    expect(content.contains(tabs)).toBe(false);
  });

  it("the chrome bar's logo segment follows the sidebar's width (the tabs start where the center column begins)", () => {
    render(<App />);
    const logo = screen.getByAltText("Archimedes").parentElement!;
    // Expanded sidebar (260px): the logo segment is 260px wide — the
    // tabs start at the center column's left edge.
    expect(logo.style.width).toBe("260px");
    // Collapsed sidebar (the `LEFT_PANE_RAIL` sliver — NOT 0: the pane keeps
    // a rail wide enough to hold its OWN toggle, so a rail is needed and the
    // segment follows it): the tabs still start at the center column's edge.
    act(() => {
      setLeftPaneCollapsed(true);
    });
    expect(logo.style.width).toBe(`${LEFT_PANE_RAIL}px`);
  });

  it("the chrome bar NEVER holds a pane control — expanded or collapsed (the toggles stay at the bottom of their panes in both states)", () => {
    render(<App />);
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    // Query by a STABLE hook, not the label: the label FLIPS with the state
    // (`Collapse sidebar` ↔ `Expand sidebar`) for screen-reader correctness,
    // so a name-based query would silently stop matching on one side of the
    // collapse — the exact vacuity this file has been bitten by twice.
    const TOGGLES = ["left-pane-toggle", "right-pane-toggle"];
    for (const id of TOGGLES) {
      expect(screen.getByTestId(id), `${id} belongs to the content row`).toBeTruthy();
      expect(chrome.contains(screen.getByTestId(id)), id).toBe(false);
    }
    // Collapsed: STILL nothing in the chrome bar. This is the regression this
    // pins — the collapsed state used to hand the control back to the top.
    act(() => {
      setLeftPaneCollapsed(true);
      setSidePaneCollapsed(true);
    });
    expect(chrome.querySelectorAll("[data-testid='left-pane-toggle']").length).toBe(0);
    expect(chrome.querySelectorAll("[data-testid='right-pane-toggle']").length).toBe(0);
    // …and each pane still exposes its OWN control at the bottom, collapsed,
    // now labelled for the direction it performs.
    expect(screen.getByTestId("left-pane-toggle").getAttribute("aria-label")).toBe("Expand sidebar");
    expect(screen.getByTestId("right-pane-toggle").getAttribute("aria-label")).toBe("Expand side pane");
    expect(chrome.querySelectorAll('[aria-label="Settings"]').length).toBe(0);
  });

  it("one toggle does both jobs from the same place, and its aria-label flips with the state", () => {
    render(<App />);
    const left = screen.getByTestId("left-pane-toggle");
    expect(left.getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(left.getAttribute("aria-pressed")).toBe("true"); // pressed = open
    fireEvent.click(left);
    expect(getLeftPaneCollapsed()).toBe(true);
    // The SAME element — no second control to hand off to, and no keyboard
    // shortcut exists, so one control must do both jobs from the bottom.
    expect(screen.getByTestId("left-pane-toggle")).toBe(left);
    expect(left.getAttribute("aria-label")).toBe("Expand sidebar");
    expect(left.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(left);
    expect(getLeftPaneCollapsed()).toBe(false);
    expect(left.getAttribute("aria-label")).toBe("Collapse sidebar");
  });

  it("the right pane's toggle does both jobs from the same place too", () => {
    render(<App />);
    const right = screen.getByTestId("right-pane-toggle");
    expect(right.getAttribute("aria-label")).toBe("Collapse side pane");
    fireEvent.click(right);
    expect(getSidePaneCollapsed()).toBe(true);
    expect(screen.getByTestId("right-pane-toggle")).toBe(right);
    fireEvent.click(right);
    expect(getSidePaneCollapsed()).toBe(false);
  });

  it("the settings view renders NO tabs and NO collapse buttons in the chrome bar (the logo segment spans full width)", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByTestId("space-tabs")).toBeNull();
    // EVERY pane-control name, expanded or collapsed: the old version of this
    // test queried a name that had been renamed, so it passed forever without
    // checking anything. A rename must be chased into these negatives too.
    for (const id of ["left-pane-toggle", "right-pane-toggle"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    const logo = screen.getByAltText("Archimedes").parentElement!;
    // No inline width — the segment is `flex-1` (full width, the old
    // chrome-bar behavior), icon only (the word was removed).
    expect(logo.style.width).toBe("");
    expect(screen.queryByText("Archimedes")).toBeNull();
  });

  it("the tabs start 1px right of the sidebar's right edge (the center column's left edge — the chrome bar's left padding lives INSIDE the logo segment, not before it)", () => {
    render(<App />);
    const chrome = document.querySelector('[data-testid="chrome-bar"]')!;
    const tabs = screen.getByTestId("space-tabs");
    // The chrome bar has NO left padding (a `pl-*` here would offset the
    // logo segment — and the tabs after it — right of the sidebar's
    // 260px edge): the 12px icon margin lives INSIDE the logo segment.
    expect(chrome.className).not.toContain("pl-");
    expect(chrome.className).not.toContain("px-");
    const logo = screen.getByAltText("Archimedes").parentElement!;
    expect(logo.className).toContain("pl-3");
    // …and the tabs container has a 1px left offset (`pl-px` — the user's
    // "1px too far left" nudge: the first tab sits 1px right of the
    // segment's edge = the center column's left edge) and NO larger left
    // padding (a `pl-1`/`pl-2`/… would push it further right).
    expect(tabs.className).toContain("pl-px");
    expect(tabs.className).not.toContain("pl-1");
    expect(tabs.className).not.toContain("pl-2");
    expect(tabs.className).not.toContain("pl-3");
    expect(tabs.className).not.toContain("px-");
  });

  it("the_gear_icon_swaps_to_the_settings_view", () => {
    render(<App />);
    // The workspace is visible (the `SpacesList`'s "Sessions" heading).
    expect(screen.getByText("Sessions")).toBeTruthy();
    // The gear icon (the left sidebar footer) opens the settings view.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // The settings view is visible (the `SettingsPage`'s section nav —
    // it is the left edge; the `SpacesList` is NOT rendered in the
    // settings view).
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Appearance")).toBeTruthy();
    expect(screen.getByText("Providers")).toBeTruthy();
    // ...and the workspace is gone (it UNMOUNTS — the stores are the
    // source of truth and re-hydrate on remount, so the ZCode
    // `opacity-0` + `inert` pattern is not needed).
    expect(screen.queryByText("Sessions")).toBeNull();
  });

  it("the_back_button_returns_to_the_workspace", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Sessions")).toBeTruthy();
  });
});

describe("App (the child-gate overlay host mounted at the App root)", () => {
  // The overlay host is mounted at the `App` root — OUTSIDE the
  // `view === "settings"` ternary — so these guarantees (a child's gate is
  // answerable whatever the view and whatever the pane's width) belong to
  // `App`, not to `SidePane`.
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.getState().dismissSession("sub1");
    useInteractive.getState().dismissSession("main1");
    usePermissions.getState().dismissSessionPrompts("sub1");
    usePermissions.getState().dismissSessionPrompts("main1");
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("a child's pending `ask` stays answerable while the SETTINGS view is open (the host is a sibling of the whole view ternary)", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    render(<App />);
    // The workspace unmounts in the settings view (`SidePane`,
    // `SubagentDetailHost`, `ChatStream` are all inside the ternary's
    // else-branch) — a host mounted in either of them would render NOTHING
    // here, and an unrendered gate strands the child until its 30-minute
    // `settle_timeout` (`DEFAULT_SUBAGENT_SETTLE_TIMEOUT`,
    // `src-tauri/src/agent/worker/manager.rs`).
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
  });

  it("a collapsed side pane still shows a pending child `ask` (the host lives at the `App` root, outside the frame entirely)", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    render(<App />);
    // Collapse the pane (the frame drops to the `SIDE_PANE_RAIL` sliver with
    // `overflow: hidden`). This assertion moved here from `SidePane.test.tsx`,
    // because the guarantee is now an `App`-root one: the host is mounted
    // outside the frame, so the pane's clip never applies to it.
    fireEvent.click(screen.getByTestId("right-pane-toggle"));
    expect(getSidePaneCollapsed()).toBe(true);
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    // And back open, still exactly one render of the card (the one-site
    // invariant — no second copy appears when the pane returns).
    fireEvent.click(screen.getByTestId("right-pane-toggle"));
    expect(getSidePaneCollapsed()).toBe(false);
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
  });

  it("a collapsed side pane still shows a pending child `password` modal (the guarantee moved here from SidePane.test)", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<App />);
    fireEvent.click(screen.getByTestId("right-pane-toggle"));
    expect(getSidePaneCollapsed()).toBe(true);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    fireEvent.click(screen.getByTestId("right-pane-toggle"));
    expect(screen.getAllByText("Sudo password required")).toHaveLength(1);
  });

  it("the gate panel stays in the DOM while a sudo modal is open (Radix hides it from assistive tech; the gate underneath stays pending)", () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<App />);
    // ACCEPTED stacking (documented on `SubagentModals`): the sudo `Dialog` is
    // `z-50` and Radix calls `hideOthers` + `disableOutsidePointerEvents` while
    // it is open, so the `z-40` panel is hidden from assistive tech and
    // pointer-inert — `getByRole` (which respects `aria-hidden`) cannot see the
    // card while the modal is up. It is still MOUNTED, so the ask is neither
    // unrendered nor answered twice; it becomes answerable again the moment the
    // modal is settled. That is why the two collapse tests above seed ONE kind
    // each.
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Red" }),
      "the panel must be hidden while the modal is open, not unmounted",
    ).toBeNull();
    expect(screen.getByTestId("subagent-gate-overlay").textContent).toContain(
      "Which color?",
    );
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(2);
  });
});

describe("App (a child gate renders at EXACTLY ONE site: inline vs overlay)", () => {
  // THE INVARIANT PIN. It lives here because only `App` mounts BOTH render
  // sites — `ChatStream` (inline, via `MessageList`) and `SubagentModals`
  // (the overlay) — so counting cards in `ChatStream.test.tsx`, which renders
  // `<ChatStream />` alone, could never see a duplicate. The render-site
  // partition splits the two sites on ONE key: is this gate's parent the ACTIVE
  // session. Exactly one site per gate, in every state — never two (divergent
  // typed-but-unsubmitted drafts, an Esc that closes only one) and never zero
  // (an unrendered gate strands the child until its 30-minute
  // `settle_timeout`).
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  /** Seed `sessionId` as the LIVE, ACTIVE session (so `ChatStream` renders a
   * transcript it could render a gate into). */
  const seedActiveSession = (sessionId: string) =>
    useSessions.setState({
      activeSessionId: sessionId,
      sessions: [
        { sessionId, cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      historySessions: [],
      archivedSessions: [],
      spaces: [{ path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      messages: { [sessionId]: [] },
      inTurn: {},
      stopReasons: {},
      closeReasons: {},
      configOptions: {},
    });
  const seedChildAsk = () => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.getState().dismissSession("sub1");
    usePermissions.getState().dismissSessionPrompts("sub1");
    // The sheet tests below open a sheet; a leaked selection would move
    // `SubagentModals`' panel for every later test in this file.
    useSubagentSelection.getState().select(null);
    useSessions.setState({
      activeSessionId: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      messages: {},
    });
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("with the PARENT active: one card, INLINE in the transcript, and NONE in the overlay", () => {
    seedActiveSession("main1");
    seedChildAsk();
    render(<App />);
    // EXACTLY ONE answerable card in the whole document.
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    // …and it is the TRANSCRIPT's copy: `sub1`'s parent IS the active session,
    // so `MessageList` owns it and the overlay must stand down.
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    expect(scroll.textContent).toContain("Which color?");
    expect(scroll.textContent).toContain("↳ reviewer");
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
  });

  it("with a DIFFERENT session active: one card, in the OVERLAY, and NONE in the transcript", () => {
    seedActiveSession("other");
    seedChildAsk();
    render(<App />);
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    // `sub1`'s parent is not the active session — `ChatStream` structurally
    // cannot render it, so the overlay must, or the gate renders NOWHERE.
    expect(scroll.textContent).not.toContain("Which color?");
    const panel = screen.getByTestId("subagent-gate-overlay");
    expect(panel.textContent).toContain("Which color?");
  });

  it("navigating between the parent and another session MOVES the card without duplicating or dropping it", () => {
    seedActiveSession("main1");
    seedChildAsk();
    render(<App />);
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    // The gate stays pending across the navigation (no answer, no dismiss).
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
    act(() => {
      useSessions.getState().setActiveSession("other");
    });
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(
      document
        .querySelector('[data-testid="subagent-gate-overlay"]')!
        .textContent,
    ).toContain("Which color?");
    act(() => {
      useSessions.getState().setActiveSession("main1");
    });
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).toContain("Which color?");
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("opening Settings keeps the child sheet: the panel never dodges a sheet that is NOT mounted, and Back re-opens it", () => {
    // The sheet and the overlay are mounted in DIFFERENT places:
    // `SubagentDetailHost` is inside the `view === "settings"` ternary's
    // else-branch and UNMOUNTS with the workspace, while `SubagentModals` is a
    // sibling of the whole ternary and stays (that is what keeps its half of the
    // gates answerable). So during the Settings round-trip the SELECTION outlives
    // the sheet it names, and the panel's dodge must key on whether the sheet is
    // MOUNTED — which `App` knows and the overlay cannot see — not on the
    // selection alone. `App` therefore passes `sheetMounted` down. It must NOT
    // pay for that by clearing the selection: the selection is the SHEET's state
    // (which row's transcript the user opened, owned by
    // `store/subagentSelection` / `SubagentDetailHost`), and clearing it on the
    // way into Settings silently threw the sheet away, so Back left the user with
    // a closed sheet they had to re-open by hand.
    seedActiveSession("other");
    seedChildAsk();
    render(<App />);
    const panel = () => screen.getByTestId("subagent-gate-overlay");
    // The overlay owns this card (its parent is not the active session) and
    // starts in the viewport corner.
    expect(panel().className).toContain("right-0");
    // Open the child's sheet: the panel dodges to the sheet's left edge (from
    // the breakpoint up — see the geometry pins in `SubagentModals.test.tsx`).
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    expect(panel().className).toContain("min-[760px]:right-[480px]");
    // Open Settings: the workspace — sheet included — unmounts.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Close subagent transcript" }),
    ).toBeNull();
    // THE FIRST HALF OF THE PIN: no sheet MOUNTED, so no dodge — the panel is
    // back at the right edge, and does not float over the Settings page at the
    // sheet's offset (squeezed per the geometry pins).
    expect(panel().className).toContain("right-0");
    expect(panel().className).not.toContain("min-[760px]:right-[480px]");
    // THE SECOND HALF: the sheet's own state survived the round-trip. The
    // selection still names the child whose transcript was open, and the entry
    // is untouched (`SubagentDetailHost`'s semantics: closing is `select(null)`
    // alone, and nothing here closes the ENTRY).
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    expect(useSubagents.getState().entries["sub1"]).toBeTruthy();
    // The gate itself never moved: the overlay still holds it (the accepted
    // Settings hole is only for an ACTIVE parent — this parent is not active).
    expect(panel().textContent).toContain("Which color?");
    // Back to the workspace: the sheet the user had open is open again — with NO
    // further `select` call from the test, i.e. by `App`'s own doing.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: /transcript/ }).textContent,
    ).toContain("reviewer");
    // And the panel dodges again, because a sheet is mounted again: the dodge is
    // `sheetMounted && the selection has an entry`, both halves live.
    expect(panel().className).toContain("min-[760px]:right-[480px]");
  });

  it("pins the SAME one-site rule for a Permission prompt (the second inline kind)", () => {
    // `MessageList` renders two kinds inline, so the invariant needs a pin on
    // both — a permission prompt that leaked into the overlay while also
    // rendering inline would be invisible to the `ask` tests above.
    seedActiveSession("main1");
    useSubagents.getState().addSession(childEntry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<App />);
    expect(screen.getAllByText("Bash (apt install ripgrep)")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).toContain("Bash (apt install ripgrep)");
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    act(() => {
      useSessions.getState().setActiveSession("other");
    });
    expect(screen.getAllByText("Bash (apt install ripgrep)")).toHaveLength(1);
    expect(
      document
        .querySelector('[data-testid="subagent-gate-overlay"]')!
        .textContent,
    ).toContain("Bash (apt install ripgrep)");
  });

  it("opening the gate-holding child's OWN sheet still renders the card EXACTLY ONCE (the sheet is not a third site)", () => {
    // THE THIRD-SITE PIN. There are exactly two gate hosts in the app — the
    // parent's transcript and the `SubagentModals` overlay — and a child's
    // transcript SHEET is neither (`SubagentDetailHost` renders
    // `SubagentTranscript`, which draws no prompt at all). The plausible
    // regression is a follow-up that "restores the prompt to the sheet" (or a
    // partial revert of the change that moved the gates out of
    // `SubagentTranscript`, when the sheet DID host a child's cards): the gate
    // would then render in the parent's transcript AND in the open sheet, which
    // breaks the one-site-per-gate rule — two live `AskQuestionCard`s of one
    // request, two divergent typed-but-unsubmitted drafts, and an answer that
    // can land twice. No test opened a child's sheet while that child held a
    // gate, so a mutation that added a third site here left the WHOLE suite
    // green.
    seedActiveSession("main1");
    seedChildAsk();
    render(<App />);
    // Baseline: the parent is active, so the single copy is INLINE.
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    // Open `sub1`'s sheet the way the UI does — a row click sets the selection.
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    // The sheet really is open (its header mounted), so this test cannot pass
    // by accident on a sheet that never appeared.
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    // STILL exactly one answerable card in the whole document — the sheet adds
    // no second copy.
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    // …and it is NOT the sheet's: the sheet contains NONE of the question's
    // text (nor the attribution chip that labels the gate).
    expect(sheet.textContent).not.toContain("Which color?");
    expect(sheet.textContent).not.toContain("↳ reviewer");
    // The one copy stays where it was — the parent's transcript.
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).toContain("Which color?");
    // And the overlay still stands down for the active parent (three sites
    // would need the overlay to re-adopt it too).
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    // Nothing answered or dismissed the gate — it is pending exactly once.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("with a DIFFERENT session active AND the child's sheet open, the card is still the overlay's alone", () => {
    // The other half of the same boundary: the sheet is not a site whatever the
    // active session is. Here the OVERLAY owns the gate (`sub1`'s parent is not
    // active, so `ChatStream` structurally cannot draw it) while the sheet is
    // open — a sheet that rendered the prompt too would double it in exactly
    // the state where the overlay cannot be blamed for it.
    seedActiveSession("other");
    seedChildAsk();
    render(<App />);
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    expect(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(1);
    expect(sheet.textContent).not.toContain("Which color?");
    expect(
      screen.getByTestId("subagent-gate-overlay").textContent,
    ).toContain("Which color?");
    // Closing the sheet neither drops nor duplicates the gate (never zero,
    // never two).
    fireEvent.click(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    );
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    expect(screen.getByTestId("subagent-gate-overlay").textContent).toContain(
      "Which color?",
    );
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("pins the SAME one-site rule for a `confirm` (the sudo kind asserted only from the overlay's own file until now)", () => {
    // `SubagentModals.test.tsx` renders the overlay ALONE, so it can pin that
    // the overlay draws a child's `confirm` but structurally cannot see a
    // DUPLICATE. By this block's own argument — the invariant lives in `App`
    // because only `App` mounts both sites — the sudo kinds were therefore
    // unpinned. The mutation this guards is the one `MessageList`'s doc forbids
    // ("do not complete this by rendering them"): inlining a child's
    // `SudoConfirmModal` while the overlay keeps drawing it too.
    seedActiveSession("main1");
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<App />);
    // EXACTLY ONE sudo dialog while the child's parent is the ACTIVE session —
    // `ComposerModals` renders sudo dialogs for the active session's own ids
    // only, and a child id can never be active (`list_sessions` filters
    // `is_subagent = 0`), so the overlay is the only site.
    expect(screen.getAllByText("Run this command with sudo?")).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="transcript-scroll"]')!.textContent,
    ).not.toContain("Run this command with sudo?");
    // And STILL exactly one when a different session is active (the overlay owns
    // this kind either way — never twice, never nowhere).
    act(() => {
      useSessions.getState().setActiveSession("other");
    });
    expect(screen.getAllByText("Run this command with sudo?")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });
});

describe("App (the `session-titled` listener)", () => {
  // The store is module-scoped, and the boot fetch only fills the STORED
  // lists — so the live row this test seeds must be cleaned up or it leaks
  // into the next test in this file.
  const clearStore = () =>
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      activeSessionId: null,
      activeSpacePath: null,
      messages: {},
    });
  beforeEach(clearStore);
  afterEach(clearStore);

  it("writes a pushed title into the store the moment `session-titled` lands (no refetch)", () => {
    // A live session, pre-naming (`title: null` — the shape the backend
    // writes before the naming pass runs).
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
      activeSessionId: "s1",
    });
    render(<App />);
    // App registers the listener once on mount; the mock holds the callback
    // it handed `listen()`, i.e. exactly what the webview invokes per event.
    // The LAST registration is this render's (the file never clears mocks, so
    // earlier tests' renders pushed theirs first).
    const calls = vi.mocked(listenSessionTitled).mock.calls;
    const onTitled = calls[calls.length - 1][0];
    act(() => {
      onTitled({ sessionId: "s1", title: "Porting the session namer" });
    });
    // The LIVE row is what the sidebar and the side pane read, so the label
    // flips here — no `list_sessions` refetch is involved (that fetch ran
    // once at boot, before this title existed).
    expect(useSessions.getState().sessions[0].title).toBe(
      "Porting the session namer",
    );
  });
});

describe("App (the `subagent-closed` listener)", () => {
  // Both stores are module-scoped, so anything seeded here leaks into the next
  // test in this file unless both sides clear it.
  const clearStore = () => {
    useInteractive.getState().dismissSession("sub1");
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useSessions.setState({
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      activeSessionId: null,
      activeSpacePath: null,
      messages: {},
    });
  };
  beforeEach(clearStore);
  afterEach(clearStore);

  it("frees a closed child's todo board, and NOTHING ELSE in `useInteractive`", () => {
    // A child's board AND a child's pending gate, both keyed to the CHILD id
    // (the router re-emits a Subagent's frames verbatim, so the todo frame
    // carries the child's id — ADR 0041).
    useInteractive.getState().applyTodoUpdate("sub1", {
      source: "native",
      todos: [{ content: "child task", status: "in_progress" }],
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    useSubagents.getState().addSession({
      sessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    render(<App />);
    // The LAST registration is this render's (the file never clears mocks).
    const calls = vi.mocked(listenSubagentClosed).mock.calls;
    const onClosed = calls[calls.length - 1][0];
    act(() => {
      onClosed({ sessionId: "sub1", status: "completed" });
    });
    // The board is gone. This is the ONLY frame that ever names the end of a
    // CHILD session (`session-closed` never carries a child id and
    // `src-tauri/` emits no `todos_clear` frame), so without this the child's
    // slice sat in the store for the life of the window.
    expect(useInteractive.getState().todos["sub1"]).toBeUndefined();
    // NARROW on purpose: `applyTodoClear`, NOT `dismissSession` — the latter
    // would also wipe the child's pending gates, and that IS the state ADR
    // 0040's amendment records (paraphrased here, not quoted): a closed child
    // keeps its gate card on screen until its entry is evicted.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });
});

describe("App (the accepted settings-view hole for an inline gate)", () => {
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.getState().dismissSession("sub1");
    useSessions.setState({
      activeSessionId: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      messages: {},
    });
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  it("KNOWN HOLE (accepted, documented): with the Settings view open AND the parent active, the inline gate has no transcript to render into", () => {
    // PIN OF A LIMITATION, NOT AN ENDORSEMENT. `ChatStream` lives inside the
    // `view === "settings"` ternary's else-branch, and the overlay stands down
    // for an ACTIVE parent's `ask`/permission — so opening Settings while the
    // parent is active leaves that gate unrendered. This is the SAME structural
    // hole a MAIN session's own `ask` has already had since before this feature
    // (`SubagentModals`' doc records it as pre-existing and out of scope);
    // this feature only extends its reach to an active parent's child gates and
    // no further. The fix is one of two moves, both out of scope here: move
    // `ChatStream` out of the ternary, or let the overlay host the active
    // parent's cards while the workspace is unmounted. A follow-up must pick
    // one; until then this test fails LOUDLY if the hole is closed by accident
    // (so the comment above has to be deleted with it) and passes while it
    // stands.
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        { sessionId: "main1", cwd: "/tmp/alpha", capabilities: {}, archived: false },
      ],
      spaces: [{ path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      messages: { main1: [] },
    });
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    render(<App />);
    // The workspace renders it first (the parent is active)…
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
    // …and the settings view is where the gate falls through both sites.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.queryByText("Which color?")).toBeNull();
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
    // The gate is still PENDING (nothing answered it), and nothing in the Rust
    // side closes it either: the bound that ends this state is the child's own
    // 30-minute `settle_timeout` (`DEFAULT_SUBAGENT_SETTLE_TIMEOUT`,
    // `src-tauri/src/agent/worker/manager.rs`), which fails the DELEGATION — it
    // is not a gate close, and the user leaving Settings is what makes the card
    // reachable again.
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
    // Back to the workspace and the card is answerable again (no leak, no dup).
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getAllByText("Which color?")).toHaveLength(1);
  });
});

describe("App (the SpaceCwdProvider that gives a transcript anchor its Space)", () => {
  // The provider's PLACEMENT is the design decision here (ADR 0051): it mounts
  // in `App`, OUTSIDE `ChatStream`, because the surfaces that External-open a
  // relative path are not all inside the chat — the subagent transcript sheet is
  // a SIBLING of the workspace view (`SubagentDetailHost`), and the gate overlay
  // is a sibling of the whole view ternary. Only `App` mounts the transcript AND
  // the sheet, so only a test in THIS file can see a provider that was moved back
  // down into `ChatStream`: the sheet's anchors would then resolve NO cwd, and
  // `external_open` refuses a relative path without one — a dead click that stays
  // green in every other file.
  // (What these two cases do NOT pin is the outermost wrap — nothing renders an
  // anchor inside `SubagentModals` yet, so the overlay half rests on the comment
  // in `App` until a consumer appears there.)
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "main1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const clearStores = () => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useSubagentSelection.getState().select(null);
    useSessions.setState({
      activeSessionId: null,
      sessions: [],
      historySessions: [],
      archivedSessions: [],
      spaces: [],
      messages: {},
    });
    vi.mocked(externalOpen).mockClear();
  };
  beforeEach(clearStores);
  afterEach(clearStores);

  /** A live ACTIVE parent, and a child with one line of transcript each — both
   * carrying a RELATIVE link, which is the only shape that needs the cwd. */
  const seedTranscripts = () =>
    useSessions.setState({
      activeSessionId: "main1",
      sessions: [
        {
          sessionId: "main1",
          cwd: "/tmp/alpha",
          capabilities: {},
          archived: false,
        },
      ],
      historySessions: [],
      archivedSessions: [],
      spaces: [
        { path: "/tmp/alpha", createdAt: 1, lastOpenedAt: 1, trusted: false },
      ],
      messages: {
        main1: [
          {
            kind: "agent-text",
            messageId: "m1",
            text: "[main.rs](src/main.rs)",
            at: 1,
          },
        ],
        sub1: [
          {
            kind: "agent-text",
            messageId: "m2",
            text: "[notes](docs/notes.md)",
            at: 1,
          },
        ],
      },
    });

  it("a transcript anchor's click External-opens with the ACTIVE Session's cwd, and navigates nothing", () => {
    seedTranscripts();
    render(<App />);
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    const a = scroll.querySelector("a")!;
    expect(a.textContent).toBe("main.rs");
    // `false` = the click was CANCELLED, i.e. the webview was never asked to
    // navigate — the bug the user reported (a link in a reply replaced the app).
    expect(fireEvent.click(a)).toBe(false);
    expect(vi.mocked(externalOpen).mock.calls).toEqual([
      ["src/main.rs", "/tmp/alpha"],
    ]);
  });

  it("an anchor in the subagent transcript SHEET gets the parent's cwd too (the provider is outside the view ternary)", () => {
    // The child's Worker runs with `cwd = parent_cwd`, so the active **Space** is
    // the right base for its transcript — but that only reaches the sheet because
    // the provider is mounted in `App` around BOTH branches of the ternary. Move
    // it into `ChatStream` and this is the first test to go red.
    seedTranscripts();
    useSubagents.getState().addSession(childEntry);
    render(<App />);
    act(() => {
      useSubagentSelection.getState().select("sub1");
    });
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    const a = sheet.querySelector("a")!;
    expect(a.textContent).toBe("notes");
    expect(fireEvent.click(a)).toBe(false);
    expect(vi.mocked(externalOpen).mock.calls).toEqual([
      ["docs/notes.md", "/tmp/alpha"],
    ]);
  });
});
