import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { closeSession, deleteSpace, reorderSpaces } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { getNewSpaceDialogOpen } from "../lib/newSpaceDialogState";
import { makeSessionRow, makeSpaceRow } from "../test/fixtures";
import { resetModuleFlags, resetStores } from "../test/resetStores";
import SpaceTabs from "./SpaceTabs";

// Radix (the `DropdownMenu` + `NewSpaceDialog`'s `Dialog`) needs the
// pointer-capture stubs jsdom lacks + `matchMedia`; `src/test/setup.tsx` installs
// all of them for every file, so this file's own `beforeAll` block is gone.

vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "new-1",
      cwd: "/w/new",
      capabilities: {},
      archived: false,
    }),
    // Closing a tab calls BOTH: `deleteSpace` (the Space row) and, when the
    // user confirms, `closeSession` per open Session. The real wrappers would
    // `invoke` and reject in jsdom.
    deleteSpace: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    // The tab strip's drag write (ADR 0075). The store's `reorderSpaces` action
    // calls through THIS module, and this file's mock replaces the module — so
    // without an armed arm the real wrapper would `invoke` and reject in jsdom,
    // and the store's rollback would snap the strip back a microtask after the
    // optimistic write the DOM assertions below read.
    reorderSpaces: vi.fn().mockResolvedValue(undefined),
  };
});

const space = (path: string) => makeSpaceRow({ path });

const info = (sessionId: string, cwd: string) => makeSessionRow({ sessionId, cwd });

beforeEach(() => {
  // Every store back to its own initial state — the hand-written version named
  // nine `useSessions` keys + `usePermissions.prompts` and nothing else, so
  // every data field the store has gained or that list never reached was left
  // dirty for the next case (see `src/test/resetStores.ts`, which deliberately
  // quotes no field count: the store's shape moves and a copied number goes
  // stale in every copy).
  resetStores();
  // The Open-Space-dialog flag is module-scoped and the `+` raises it: a
  // leaked `true` would auto-mount a real Radix modal in every later render
  // here (which `aria-hidden`s the rest of the document).
  resetModuleFlags();
  // Closing tabs is asserted with `not.toHaveBeenCalled()` too, so the command
  // mocks must not carry calls across cases.
  vi.clearAllMocks();
});

describe("SpaceTabs (the Spaces as browser-style tabs at the top of the chat)", () => {
  it("renders one tab per space (the base name), the active one selected", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/beta",
    });
    render(<SpaceTabs />);
    const alpha = screen.getByRole("tab", { name: "alpha" });
    const beta = screen.getByRole("tab", { name: "beta" });
    expect(alpha.getAttribute("aria-selected")).toBe("false");
    expect(beta.getAttribute("aria-selected")).toBe("true");
  });

  // -- The accessibility tree: the strip IS a tablist (finding 18) ---------

  /**
   * The labels carry `role="tab"` + `aria-selected`, and a `tab` with no
   * `tablist` ancestor is an ORPHAN: a screen reader announces "tab" against
   * nothing, cannot report the group, and cannot report its orientation. These
   * assertions read the RENDERED a11y tree through `getByRole` (the queries the
   * rest of the file already uses) — not the source, so they cannot pass on a
   * comment that merely claims the attribute is there.
   */
  it("the tab strip is a horizontal tablist and every tab lives inside it", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta"), space("/w/gamma")],
      activeSpacePath: "/w/beta",
    });
    render(<SpaceTabs />);
    const tablist = screen.getByRole("tablist");
    expect(tablist.getAttribute("aria-orientation"), "the orientation").toBe(
      "horizontal",
    );
    // THE SAME ELEMENT the tests and the drag-region pins already address — so
    // the tablist was marked on the existing container and no DOM level was
    // introduced (`getByTestId` would find a second element if it had been).
    expect(tablist).toBe(screen.getByTestId("space-tabs"));
    // One tab per Space, ALL inside the tablist (a `role="tab"` outside it is
    // exactly the orphan this task exists to remove).
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tablist.contains(tab), tab.textContent ?? "(no text)").toBe(true);
    }
  });

  it("the `New space` control is not exposed as a tab (the tablist's tabs are Spaces only)", () => {
    // The `+` is a sibling control inside the tablist (see the accepted
    // limitation documented on the container in `SpaceTabs.tsx`). It must stay
    // a plain button: if it ever picked up `role="tab"` it would announce itself
    // as a fourth Space you can select, and `getAllByRole("tab")` above would
    // silently stop meaning "one per Space".
    useSessions.setState({ spaces: [space("/w/alpha")], activeSpacePath: "/w/alpha" });
    render(<SpaceTabs />);
    const tablist = screen.getByRole("tablist");
    const names = within(tablist)
      .queryAllByRole("tab")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());
    expect(names).not.toContain("New space");
    // And it is still reachable as what it is — a button, not a tab.
    expect(screen.getByRole("button", { name: "New space" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "New space" })).toBeNull();
  });

  it("renders a spinner on the tab when a space has an active running session", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
      sessions: [
        info("s-alpha", "/w/alpha"),
        info("s-beta", "/w/beta"),
      ],
      inTurn: {
        "s-beta": true,
      },
    });
    render(<SpaceTabs />);

    const alphaTab = screen.getByRole("tab", { name: "alpha" });
    const betaTab = screen.getByRole("tab", { name: "beta" });

    // alpha has no running session -> no spinner
    expect(alphaTab.querySelector('[data-testid="space-tab-mark"]')).toBeNull();

    // beta has a running session -> spinner rendered
    expect(betaTab.querySelector('[data-testid="space-tab-mark"]')).toBeTruthy();

    // When beta's turn ends, the spinner disappears
    act(() => {
      useSessions.setState({ inTurn: { "s-beta": false } });
    });
    expect(betaTab.querySelector('[data-testid="space-tab-mark"]')).toBeNull();
  });

  it("shows the QUESTION instead of the spinner when the Space's session is waiting on the user", () => {
    useSessions.setState({
      spaces: [space("/w/alpha")],
      activeSpacePath: "/w/alpha",
      sessions: [info("s-alpha", "/w/alpha")],
      inTurn: { "s-alpha": true },
    });
    usePermissions.setState({
      prompts: {
        "s-alpha": [
          {
            requestId: "p1",
            toolTitle: "bash",
            options: [{ optionId: "allow", name: "Allow" }],
          },
        ],
      },
    });
    render(<SpaceTabs />);
    const tab = screen.getByRole("tab", { name: "alpha" });
    // A blocked Space is NOT working, so it must not claim to be: the spinner
    // is gone and the `?` is there (`waiting` outranks `running`, the same
    // precedence `sessionStatusOf` gives a Session).
    expect(tab.querySelector('[role="status"]')).toBeNull();
    expect(tab.querySelector('[data-dot="waiting"]')).toBeTruthy();
  });

  it("shows the QUESTION on the tab when ANY of the Space's live sessions is waiting", () => {
    // One Worker streaming, one blocked on a permission: the Space needs you,
    // and that outranks "something is busy".
    useSessions.setState({
      spaces: [space("/w/alpha")],
      activeSpacePath: "/w/alpha",
      sessions: [info("s1", "/w/alpha"), info("s2", "/w/alpha")],
      inTurn: { s1: true, s2: false },
    });
    usePermissions.setState({
      prompts: {
        s2: [{ requestId: "p1", toolTitle: "bash", options: [] }],
      },
    });
    render(<SpaceTabs />);
    const tab = screen.getByRole("tab", { name: "alpha" });
    expect(tab.querySelector('[data-dot="waiting"]')).toBeTruthy();
    expect(tab.querySelector('[role="status"]')).toBeNull();
    expect(tab.getAttribute("title")).toContain("waiting for you");
  });

  it("renders spinner if any of multiple live sessions in the space is running", () => {
    useSessions.setState({
      spaces: [space("/w/alpha")],
      activeSpacePath: "/w/alpha",
      sessions: [info("s1", "/w/alpha"), info("s2", "/w/alpha")],
      inTurn: { "s1": false, "s2": true },
    });
    render(<SpaceTabs />);
    const tab = screen.getByRole("tab", { name: "alpha" });
    expect(tab.querySelector('[data-testid="space-tab-mark"]')).toBeTruthy();
  });

  it("clicking a tab selects the space (the store's `selectSpace`)", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("tab", { name: "beta" }));
    expect(useSessions.getState().activeSpacePath).toBe("/w/beta");
  });

  it("a tab for a space with a live session opens it on click", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("tab", { name: "beta" }));
    expect(useSessions.getState().activeSessionId).toBe("live-1");
  });

  it("the `+` button raises the shared Open-Space-dialog flag (picking a folder IS creating a space)", () => {
    // The flag, not the dialog: the tab strip only RAISES it now (one owner —
    // see `newSpaceDialogState`), and it never owned the render, so there is
    // no dialog in this component's DOM to query — the sidebar renders it
    // today and the `App` root takes that over next.
    useSessions.setState({ spaces: [space("/w/alpha")] });
    render(<SpaceTabs />);
    expect(getNewSpaceDialogOpen()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    expect(getNewSpaceDialogOpen()).toBe(true);
  });

  it("renders NO NewSpaceDialog of its own (one dialog, one render site — two owners would mount a second)", () => {
    // The tab strip used to hold a private `newSpaceOpen` AND its own
    // `<NewSpaceDialog>`, which is the second owner this removes: with the
    // sidebar also rendering on the shared flag, both would be true at once
    // and `getByText("New space")` would become "Found multiple elements".
    useSessions.setState({ spaces: [space("/w/alpha")] });
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the tab bar holds NO `...` menu, NO pane toggle and NO warning dot (the menu lives in the sidebar's `Sessions` header; the pane toggles live in the chrome bar's `ChromeControls`, never in the strip)", () => {
    useSessions.setState({
      spaces: [space("/w/alpha")],
      activeSpacePath: "/w/alpha",
    });
    const { container } = render(<SpaceTabs />);
    expect(
      screen.queryByRole("button", { name: "Session actions" }),
    ).toBeNull();
    // The pane toggles live in the chrome bar's `ChromeControls` (`App.test.tsx`
    // pins that), never in the tab strip: the tabs are Spaces, and a strip that
    // also held window furniture would read as a second titlebar. EVERY label
    // the left toggle has ever carried plus the current one, because the old
    // assertion here queried a label that had since been renamed and so could
    // never fail.
    for (const label of [
      "Collapse session list",
      "Expand session list",
      "Collapse sidebar",
      "Expand sidebar",
      "Collapse side pane",
      "Expand side pane",
    ]) {
      expect(screen.queryByRole("button", { name: label }), label).toBeNull();
    }
    expect(container.querySelector(".bg-warning")).toBeNull();
  });

  // -- The pill's hit area (every pixel of it is a control) ---------------

  /**
   * DOM-level pin, not a source grep: the assertions read what the component
   * RENDERS (attribute + class list). jsdom has no layout engine, so "the
   * label fills the pill" is asserted through the flex classes that produce
   * it — `items-stretch` on the wrapper and a `flex items-center` label —
   * rather than through measured heights, which are all 0 here.
   */
  it("the pill opts OUT of the window-drag region and leaves no slack above or below the label", () => {
    useSessions.setState({ spaces: [space("/w/alpha")], activeSpacePath: "/w/alpha" });
    render(<SpaceTabs />);
    const tab = screen.getByRole("tab", { name: "alpha" });
    const close = screen.getByRole("button", { name: "Close alpha" });
    const pill = tab.parentElement!;
    // The wrapper is one object holding BOTH controls (the label and the ✕).
    expect(close.parentElement, "the ✕ left the pill").toBe(pill);
    // (a) THE DRAG REGION — and this attribute has TWO load-bearing reasons, so
    // do not "simplify" it away when reading either one. The chrome bar is
    // `data-tauri-drag-region="deep"`, and Tauri's injected drag script walks the
    // event's composed path and stops at the FIRST element carrying the
    // attribute: `="false"` means "not chrome". A plain `div` with no attribute is
    // therefore claimed as drag surface, which would make part of a control drag
    // the window.
    //   REASON 1 (the original one, and the one the assertions below read): a
    //   control is not chrome — every pixel of the pill selects or closes, so no
    //   pixel of it may drag the window.
    //   REASON 2 (ADR 0075, T07): it is what lets a tab be DRAGGED AT ALL. The
    //   pill is now a drag source (`draggable` + the `useDragReorder` handlers),
    //   and HTML5 drag-and-drop begins from the same mousedown the injected
    //   script is hunting for. Without this `"false"` the script claims that
    //   mousedown as a WINDOW drag and the browser never starts the tab's drag —
    //   the tab strip would look draggable and move the window instead, with
    //   every drag test in this file still green, because jsdom has no injected
    //   script. Pinned alongside the attribute by
    //   "the pill keeps opting OUT of the window-drag region after a drag
    //   (spec §5 #16)"; the drag itself is pinned by
    //   "a LEFT-drag started on the tab pill does not close the tab".
    expect(pill.getAttribute("data-tauri-drag-region")).toBe("false");
    // (b) NO SLACK. `items-center` on the wrapper centred the label's LINE
    // inside the `h-8` pill and left ~6px of bare pill above and below it —
    // dead pixels that (with (a) unfixed) dragged the window. The label is
    // therefore the thing that STRETCHES (`self-stretch`) and centres its own
    // text, while the wrapper centres everything else.
    expect(pill.className, "the wrapper still stretches its children").not.toMatch(
      /(^|\s)items-stretch(\s|$)/,
    );
    expect(pill.className, "the wrapper does not centre its children").toMatch(
      /(^|\s)items-center(\s|$)/,
    );
    expect(tab.className, "the label does not fill the pill").toMatch(
      /(^|\s)self-stretch(\s|$)/,
    );
    expect(tab.className, "the label does not fill the pill").toMatch(/(^|\s)flex(\s|$)/);
    expect(tab.className, "the label is not vertically centred in its own box").toMatch(
      /(^|\s)items-center(\s|$)/,
    );
    // The ✕ stays a 20px square — it must NOT stretch to the pill's height
    // (a full-height hover patch would read as a second tab).
    expect(close.className, "the ✕ stretched with the label").not.toMatch(
      /(^|\s)self-stretch(\s|$)/,
    );
    expect(close.className, "the ✕ does not centre its own glyph").toMatch(
      /(^|\s)place-items-center(\s|$)/,
    );
  });

  it("the ✕ sits on EVERY tab — no hover and no active state hides it", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    const active = screen.getByRole("button", { name: "Close alpha" });
    const inactive = screen.getByRole("button", { name: "Close beta" });
    for (const [label, close] of [
      ["active", active],
      ["inactive", inactive],
    ] as const) {
      // No opacity machinery at all: the old shape drew the control
      // TRANSPARENT until the pointer arrived, so a tab you were not hovering
      // looked un-closable — and an invisible-but-focusable control is its own
      // a11y oddity.
      expect(close.className, `${label} tab's ✕ hides itself`).not.toMatch(
        /opacity-/,
      );
    }
    // ONE kind of control: the two ✕ are the same object in two tabs, exactly
    // as the two pills are (the pill's FILL is the only active-state class).
    expect(inactive.className).toBe(active.className);
  });

  it("the ✕ is inset from the pill's edge by the same margin the label is", () => {
    useSessions.setState({ spaces: [space("/w/alpha")], activeSpacePath: "/w/alpha" });
    render(<SpaceTabs />);
    const tab = screen.getByRole("tab", { name: "alpha" });
    const close = screen.getByRole("button", { name: "Close alpha" });
    // Class-level pin (jsdom lays nothing out): the label's leading inset and
    // the ✕'s trailing inset are the SAME utility, so the ✕ no longer sits
    // jammed against the pill's right edge while the label floats 12px from
    // the left one.
    expect(tab.className).toMatch(/(^|\s)pl-3(\s|$)/);
    expect(close.className).toMatch(/(^|\s)mr-3(\s|$)/);
    expect(close.className).not.toMatch(/(^|\s)mr-1(\s|$)/);
  });

  // -- Closing a tab (the × and the middle-click) -------------------------

  it("every tab carries its own close control, named for the Space", () => {
    useSessions.setState({ spaces: [space("/w/alpha"), space("/w/beta")] });
    render(<SpaceTabs />);
    expect(screen.getByRole("button", { name: "Close alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close beta" })).toBeTruthy();
  });

  it("the close control is a SIBLING of the tab, never inside it (a control inside a control is invisible to assistive tech)", () => {
    useSessions.setState({ spaces: [space("/w/alpha")] });
    render(<SpaceTabs />);
    const tab = screen.getByRole("tab", { name: "alpha" });
    expect(tab.querySelector("button")).toBeNull();
    // The tab's own accessible name is the Space and nothing else — no
    // `Close` smuggled in by wrapping the ✕ inside it.
    expect(tab.textContent).toBe("alpha");
  });

  it("clicking × closes the tab WITHOUT selecting it first", async () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    await waitFor(() =>
      expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
        "/w/alpha",
      ]),
    );
    // The view never moved: closing a background tab must not change what is
    // on screen.
    expect(useSessions.getState().activeSpacePath).toBe("/w/alpha");
  });

  it("a quiet Space closes with NO dialog (it is reversible by re-opening the folder)", async () => {
    useSessions.setState({ spaces: [space("/w/alpha")] });
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close alpha" }));
    await waitFor(() => expect(useSessions.getState().spaces).toHaveLength(0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("middle-clicking a tab closes it; a LEFT press and a middle-click on the empty strip do not", async () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "beta" }), {
      button: 1,
    });
    await waitFor(() =>
      expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
        "/w/alpha",
      ]),
    );
    await waitFor(() => expect(deleteSpace).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "alpha" }), {
      button: 0,
    });
    expect(useSessions.getState().spaces).toHaveLength(1);
    // The EMPTY STRIP after the `+` is the browser's empty tab strip — a
    // spacer that belongs to the window's drag region, never a tab. A
    // middle-click there must close nothing (it used to go untested, so the
    // test's name claimed more than it checked).
    fireEvent.mouseDown(screen.getByTestId("space-tabs"), { button: 1 });
    expect(deleteSpace).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().spaces).toHaveLength(1);
  });

  it("middle-clicking a tab whose Space holds a LIVE Session asks instead of closing", async () => {
    // The middle-click is the gesture with no visible ✕ to aim at, so it is
    // the one that could silently throw away running work. The confirm is what
    // stands between the two, for BOTH gestures.
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    render(<SpaceTabs />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "beta" }), {
      button: 1,
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useSessions.getState().spaces).toHaveLength(2);
    expect(closeSession).not.toHaveBeenCalled();
    expect(deleteSpace).not.toHaveBeenCalled();
  });

  it("a middle-click that lands ON the ✕ closes the tab exactly once", async () => {
    // The ✕ sits inside the pill that owns the middle-click, so a press there
    // reaches the pill too. It must not close twice (nor ask twice).
    useSessions.setState({ spaces: [space("/w/alpha"), space("/w/beta")] });
    render(<SpaceTabs />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Close beta" }), {
      button: 1,
    });
    await waitFor(() => expect(deleteSpace).toHaveBeenCalledTimes(1));
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
      "/w/alpha",
    ]);
  });

  it("a middle-click on a tab you are NOT looking at closes it with no dialog when the Space is quiet", async () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
      activeSessionId: "live-a",
    });
    useSessions.getState().addSession(info("live-a", "/w/alpha"));
    render(<SpaceTabs />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "beta" }), {
      button: 1,
    });
    await waitFor(() => expect(useSessions.getState().spaces).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // And the view never moved: the Space on screen is still on screen.
    expect(useSessions.getState().activeSpacePath).toBe("/w/alpha");
    expect(useSessions.getState().activeSessionId).toBe("live-a");
  });

  it("a Space with an OPEN session asks first — nothing is stopped or removed yet", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useSessions.getState().spaces).toHaveLength(2);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("…and Stop and close stops each open Session of THAT Space, then closes the tab", async () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    useSessions.getState().addSession(info("live-2", "/w/beta"));
    // A live session in the space the user is LOOKING at — not the one being
    // closed — must not be stopped by this click.
    useSessions.getState().addSession(info("live-3", "/w/alpha"));
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop and close" }));
    await waitFor(() =>
      expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
        "/w/alpha",
      ]),
    );
    expect(closeSession).toHaveBeenCalledWith("live-1");
    expect(closeSession).toHaveBeenCalledWith("live-2");
    expect(closeSession).not.toHaveBeenCalledWith("live-3");
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
      "/w/alpha",
    ]);
  });

  it("…Close anyway drops the tab and leaves the Sessions running", async () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    await waitFor(() => expect(useSessions.getState().spaces).toHaveLength(1));
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("…Cancel leaves everything exactly as it was", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSessions.getState().spaces).toHaveLength(2);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("names an untitled Session in the confirm the way its ROW names it (one title rule)", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    // No generated title, but a first user message — the rows fall back to
    // that text, so the confirm must not fall back to the folder name. AFTER
    // `addSession`, which seeds the id's transcript as `[]`.
    useSessions.setState({
      messages: {
        "live-1": [
          { kind: "user", text: "Refactor the auth middleware", at: 1 },
        ],
      },
    });
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    expect(screen.getByText("Refactor the auth middleware")).toBeTruthy();
  });

  it("closing the ACTIVE tab lands on the neighbouring Space's session", async () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
      activeSessionId: "live-a",
    });
    useSessions.getState().addSession(info("live-a", "/w/alpha"));
    useSessions.getState().addSession(info("live-b", "/w/beta"));
    render(<SpaceTabs />);
    // The active space HAS an open session, so this confirms — the point here
    // is where the user ends up afterwards.
    fireEvent.click(screen.getByRole("button", { name: "Close alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop and close" }));
    await waitFor(() =>
      expect(useSessions.getState().activeSessionId).toBe("live-b"),
    );
    expect(useSessions.getState().activeSpacePath).toBe("/w/beta");
    expect(useSessions.getState().activeSessionId).toBe("live-b");
  });

  // -- A close that FAILS (the backend command rejected) ------------------

  it("a REJECTED close leaves the tab where it is and puts the failure on the console", async () => {
    // `removeSpace` awaits the `delete_space` command, so a rejection makes
    // `closeSpace` reject — and the dialog is already closed by then. Without
    // a `catch` on the `void` call this is an unhandled rejection: the tab
    // simply refuses to close and nothing says why.
    vi.mocked(deleteSpace).mockRejectedValueOnce(new Error("disk on fire"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    useSessions.setState({ spaces: [space("/w/alpha")] });
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close alpha" }));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    // The Space is still there (the command failed, so the row was never
    // removed) — the tab lies about having closed.
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
      "/w/alpha",
    ]);
    // And the log names WHICH Space, or it is not diagnosable.
    expect(
      consoleError.mock.calls.some((args) =>
        args.some((a) => String(a).includes("/w/alpha")),
      ),
    ).toBe(true);
    consoleError.mockRestore();
  });

  it("a REJECTED close from the confirm (Close anyway) is reported too — the dialog is already gone", async () => {
    // The more dangerous half: the confirm has already closed itself, so a
    // swallowed rejection here means the user answered the question and got
    // neither a closed tab nor an error.
    vi.mocked(deleteSpace).mockRejectedValueOnce(new Error("disk on fire"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    useSessions.getState().addSession(info("live-1", "/w/beta"));
    render(<SpaceTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(useSessions.getState().spaces).toHaveLength(2);
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// C7 (finding 6d): the tab label and the `+` are `<Button>`s.
//
// These two sites are the tab strip's share of the raw-`<button>` sweep. The ✕
// is deliberately NOT one of them and is NOT asserted here: `Button`'s base
// carries `disabled:opacity-50`, which the assertion above ("no opacity
// machinery at all") forbids and which `className` cannot strip — it names no
// `opacity-*` utility for `tailwind-merge` to drop, so the variant survives the
// merge. That blocker is recorded on the component.
//
// WHY A SET COMPARISON AND A PINNED ADDITION LIST (the shape C7 group 3
// introduced, and for the same reason): the byte-exact `toBe` on a class
// attribute is unsatisfiable once `Button` contributes utilities, but "every
// token still present" plus "the additions are EXACTLY this literal" is the
// stronger claim — it fails on a repaint in either direction, and it does not
// move when `buttonVariants` is edited, because the list is a literal rather
// than a recomputation from the component under test.
//
// Every entry in the addition lists is inert HERE, and the wall constants on
// the component carry the per-token reasoning. What these tests guard is the
// two properties the strip's own contract depends on: the label still owns the
// pill's height and its leading inset, and the `+` is still a `rounded-md`
// 32px square in the second chrome cluster.
// ---------------------------------------------------------------------------

/** Class attributes are SETS, not strings — `cn()` reorders on conflict. */
const tokensOf = (className: string): string[] =>
  [...new Set(className.split(/\s+/).filter(Boolean))].sort();

/** What `<Button variant="link" size="default">` adds to the tab label. */
const TAB_ADDITIONS = [
  "[&_svg:not([class*='size-'])]:size-3.5",
  "[&_svg]:pointer-events-none",
  "[&_svg]:shrink-0",
  "aria-invalid:border-destructive",
  "aria-invalid:ring-2",
  "aria-invalid:ring-destructive/20",
  "bg-clip-padding",
  "border-0",
  "border-transparent",
  "dark:aria-invalid:border-destructive/50",
  "dark:aria-invalid:ring-destructive/40",
  "disabled:opacity-50",
  "disabled:pointer-events-none",
  "group/button",
  "h-auto",
  "has-data-[icon=inline-end]:pr-1.5",
  "has-data-[icon=inline-start]:pl-1.5",
  "hover:no-underline",
  "justify-start",
  "outline-none",
  "px-0",
  "rounded-md",
  "select-auto",
  "shrink",
  "transition-none",
  "underline-offset-4",
  "whitespace-normal",
].sort();

/** What `<Button variant="ghost" size="icon-lg">` adds to the `+`. */
const NEW_SPACE_ADDITIONS = [
  "[&_svg:not([class*='size-'])]:size-4",
  "[&_svg]:pointer-events-none",
  "[&_svg]:shrink-0",
  "aria-expanded:bg-hover",
  "aria-expanded:text-foreground",
  "aria-invalid:border-destructive",
  "aria-invalid:ring-2",
  "aria-invalid:ring-destructive/20",
  "bg-clip-padding",
  "border-0",
  "border-transparent",
  "dark:aria-invalid:border-destructive/50",
  "dark:aria-invalid:ring-destructive/40",
  "disabled:opacity-50",
  "disabled:pointer-events-none",
  "group/button",
  "hover:text-foreground-subtle",
  "inline-block",
  "items-center",
  "justify-center",
  "outline-none",
  "select-auto",
  "text-[length:inherit]",
  "transition-none",
  "whitespace-normal",
].sort();

describe("the tab label and the `+` route through <Button> (C7)", () => {
  /** The label's class list BEFORE the sweep, spelled as a literal rather than
   *  recomputed: `classNameConvention.test.ts` records why a pin must not go
   *  through `cn()` — a merge could hide a change from the assertion meant to
   *  catch it. (These two strings are the identity under `cn()`; they are here
   *  as the pre-extraction record, exactly as `ChromeControls.test.tsx` keeps
   *  its `CONTROL_BUTTON` literal.) */
  const LABEL_WAS_ACTIVE =
    "flex min-w-0 self-stretch items-center gap-1.5 pl-3 text-ui-base font-medium text-foreground";
  const LABEL_WAS_INACTIVE =
    "flex min-w-0 self-stretch items-center gap-1.5 pl-3 text-ui-base text-foreground-subtle";
  const labelWas = (active: boolean): string[] =>
    tokensOf(active ? LABEL_WAS_ACTIVE : LABEL_WAS_INACTIVE);

  it("the tab label is a <Button variant=\"link\" size=\"default\"> that loses nothing", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    for (const [name, active] of [
      ["alpha", true],
      ["beta", false],
    ] as const) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.tagName, `${name}: the tab is not a <button>`).toBe("BUTTON");
      expect(tab.getAttribute("data-slot"), `${name}: not a Button`).toBe(
        "button",
      );
      expect(tab.getAttribute("data-variant"), `${name}: variant`).toBe("link");
      expect(tab.getAttribute("data-size"), `${name}: size`).toBe("default");
      const painted = tokensOf(tab.className);
      for (const token of labelWas(active)) {
        expect(painted, `${name}'s tab lost ${token}`).toContain(token);
      }
      expect(
        painted.filter((t) => !labelWas(active).includes(t)),
        `${name}: the additions are not the pinned inert set`,
      ).toEqual(TAB_ADDITIONS);
      // The strip's own geometry contract, restated so a future wall edit that
      // removes one of these cannot pass on the set comparison alone.
      expect(painted).toContain("self-stretch");
      expect(painted).toContain("pl-3");
      expect(painted).toContain("items-center");
      // Exactly ONE font-size utility: the label spelled `text-ui-base` and
      // must not gain a second one (`ChatStream.test.tsx`'s `primaryLines()`
      // finds rows by `.text-ui-base`, so a gained token is selectable code).
      expect(painted.filter((t) => /^text-ui-/.test(t))).toEqual([
        "text-ui-base",
      ]);
    }
  });

  it("the `+` is a <Button variant=\"ghost\" size=\"icon-lg\"> that stays a rounded-md square", () => {
    useSessions.setState({ spaces: [space("/w/alpha")], activeSpacePath: "/w/alpha" });
    render(<SpaceTabs />);
    const plus = screen.getByRole("button", { name: "New space" });
    expect(plus.getAttribute("data-slot")).toBe("button");
    expect(plus.getAttribute("data-variant")).toBe("ghost");
    expect(plus.getAttribute("data-size")).toBe("icon-lg");
    const was = tokensOf(
      "size-8 shrink-0 rounded-md text-foreground-subtle hover:bg-surface-hover",
    );
    const painted = tokensOf(plus.className);
    for (const token of was) {
      expect(painted, `the + lost ${token}`).toContain(token);
    }
    expect(painted.filter((t) => !was.includes(t))).toEqual(
      NEW_SPACE_ADDITIONS,
    );
    // The second chrome cluster's corners survive: `icon-lg` contributes
    // `rounded-lg`, and the site's own `rounded-md` must be the one that wins
    // the border-radius group (tailwind-merge keeps the LAST, i.e. the site).
    expect(painted.filter((t) => /^rounded(-|$)/.test(t))).toEqual([
      "rounded-md",
    ]);
    // And the box: `icon-lg`'s `size-8` is the same 32px the site spelled, so
    // exactly one size utility is declared.
    expect(painted.filter((t) => /^size-/.test(t))).toEqual(["size-8"]);
  });

  it("neither conversion puts a control inside a control (the pill's two stay siblings)", () => {
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta")],
      activeSpacePath: "/w/alpha",
    });
    const { container } = render(<SpaceTabs />);
    // `Button` renders a `<button>`, so a `role="tab"` that became one is still
    // not allowed to hold the ✕ (`SpaceTabs.test.tsx` above pins this for the
    // raw shape; this is the same claim, re-asserted after the sweep).
    expect(screen.getByRole("tab", { name: "alpha" }).querySelector("button")).toBeNull();
    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });
});

/**
 * T07 — the tab strip is DRAGGABLE (ADR 0075, spec §4 "Tabs" + §Drag mechanics).
 *
 * `useDragReorder` (T05) owns the gesture and the store's `reorderSpaces` (T05)
 * owns the write; what THIS block pins is the WIRING between them and the pills:
 * the hook's six spread keys reaching the pill `div`, the pointer's half deciding
 * left-or-right in the RENDERED strip, the drop edge drawn on the target pill and
 * nowhere else, the ✕ refusing to start a drag, and the two hazards the spec
 * names as "pin in tests, not discover later".
 *
 * THREE jsdom FACTS every drag here is built on, all inherited from
 * `useDragReorder.test.tsx` (and from T06's block in `SpacesList.test.tsx`) —
 * reach for the obvious idiom instead and these tests pass VACUOUSLY:
 *  1. `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` (a plain
 *     `Event` swallows the unknown init member and it arrives `undefined`), and
 *     the same is true of `clientX` — so `dragOver` below hand-builds the event
 *     and assigns BOTH.
 *  2. `getBoundingClientRect()` is all zeros in jsdom, so the midpoint is `0`
 *     and EVERY pointer answers "after" — hence `layOut`, which makes the half a
 *     fact the test chooses rather than one the environment decides.
 *  3. AND THE RECT MUST BE NON-DEGENERATE ON THE AXIS THE TEST IS NOT ABOUT.
 *     This is the fact this block originally got wrong, and it is why the strip
 *     shipped broken with every test below green: the fixtures placed the pills
 *     along Y and every pointer was a `clientY`, so X was never exercised at all.
 *     An unset `clientX` compares `undefined < midpoint` → `false` → "after",
 *     which is the SAME answer a zero-width rect gives — so a hook reading the
 *     wrong axis agreed with every assertion. `layOut` now gives each pill a real
 *     x range AND a real y range, `dragOver` always sends both coordinates, and
 *     the strip's pointers are stated in X with `clientY` pinned to the pills'
 *     shared vertical midpoint. That combination is what makes an axis mistake
 *     here fail loudly instead of quietly.
 *
 * WHY FOUR TABS AND WHY ALL FOUR ARE NAMED BY THE SLICE. The store's
 * `reorderSpaces` keeps a Space the slice does not name at the BOTTOM of the
 * array (the approved "new rows join at the bottom" rule), which is deliberately
 * NOT its original index. Every fixture here names every Space the strip renders,
 * so that rule has nothing to sink and no order assertion below can be satisfied
 * by it — the strip's order is the user's, exactly. (The disagreement between the
 * two rules is pinned where it can be constructed without a render race:
 * `src/store/sessions.test.ts`'s "a Space the slice does not name is kept, at the
 * BOTTOM".)
 */
describe("SpaceTabs (dragging the tabs, ADR 0075)", () => {
  // FOUR tabs, not three. With three, dragging the last tab onto the middle
  // one's RIGHT half answers `alpha, beta, gamma` — the order the strip already
  // has — so the hook correctly writes nothing and the right-half test would
  // have to assert an absence. Four is the smallest strip where before, after
  // and the off-by-one are three DIFFERENT arrays. (The two AXIS tests near the
  // end seed THREE tabs on purpose: the rightward one drags onto the LEFT half,
  // which moves even in a three-tab strip, and it is the unchanged-strip answer
  // that IS its bug — asserted as a failure, not dodged.)
  const TAB_NAMES = ["alpha", "beta", "gamma", "delta"];
  const TAB_PATHS = ["/w/alpha", "/w/beta", "/w/gamma", "/w/delta"];

  /** Four tabs, in this order, with `alpha` selected. */
  function seedFourTabs(): void {
    useSessions.setState({
      spaces: TAB_PATHS.map((path) => space(path)),
      activeSpacePath: "/w/alpha",
    });
  }

  beforeEach(() => {
    // The file-level mock factory arms `reorderSpaces` to resolve; `clearAllMocks`
    // in the file's own `beforeEach` wipes call records but keeps that
    // implementation, so a drag's write resolves here exactly as it does in the
    // sidebar's block.
    seedFourTabs();
  });

  /** The pill `div` for a tab (the wrapper holding the label and the ✕ — the
   *  shape the tests above pin), which is what the drag surface rides on. */
  const pillOf = (name: string): HTMLElement =>
    screen.getByRole("tab", { name }).parentElement!;

  /** jsdom has no layout, so the rect is a fact the TEST chooses.
   *
   *  HORIZONTAL, because THIS strip is horizontal: every pill spans the SAME y
   *  range (100..132) and differs only in x, exactly as the real strip lays out.
   *  That is deliberate and it is the point — with `clientY` fixed at the pills'
   *  shared vertical midpoint (116) the Y rule answers "after" for EVERY pointer
   *  in EVERY test below, so no assertion here can be satisfied by a hook that
   *  reads Y. Only `clientX` can move the edge.
   *
   *  THE FIXTURE THAT HID THE BUG: this block used to place pills on the Y axis
   *  (`top`, `bottom`) and drive them with `clientY`, so the X axis was never
   *  exercised at all — a rect with no width, or an unset `clientX` (which
   *  compares `undefined < midpoint` → `false` → "after"), makes the two axes
   *  agree and the feature ship broken with every test green. Both axes are
   *  non-degenerate here and the pointers are stated in X. */
  const layOut = (el: HTMLElement, left: number, width = 120) => {
    el.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 132,
        height: 32,
        width,
        left,
        right: left + width,
        x: left,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
  };

  /** Hand-built `dragover` carrying BOTH coordinates.
   *  `fireEvent.dragOver(el, { clientY })` does NOT deliver `clientY` (measured
   *  `undefined`) — nor `clientX`, the same jsdom fact — so both are assigned
   *  after construction. `clientY` is ALWAYS 116, the shared vertical midpoint:
   *  the grab a user actually makes, and the coordinate that made the old
   *  Y-only rule a no-op machine. The return value is `false` iff a handler
   *  called `preventDefault`, i.e. "this pill accepted the drop". */
  const dragOver = (el: Element, clientX: number) => {
    const ev = new Event("dragover", {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.assign(ev, { clientX, clientY: 116 });
    return fireEvent(el, ev);
  };

  const buildDrop = () =>
    new Event("drop", { bubbles: true, cancelable: true, composed: true });

  /** A hand-built drag event carrying BOTH coordinates. `fireEvent.dragOver(el,
   *  { clientY })` delivers neither `clientY` nor `clientX` (a plain `Event`
   *  swallows unknown init members — jsdom fact 1 above), so both are assigned
   *  after construction. `dataTransfer` is the full three-member stub the real
   *  gesture offers, since `dragstart` needs `setData`. Used by the two AXIS
   *  tests below, which state the geometry the bug was measured with: a 32px pill
   *  spanning y 100..132, grabbed at its vertical CENTRE (116). */
  const mkDrag = (type: string, x: number, y: number) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, {
      clientX: x,
      clientY: y,
      dataTransfer: {
        setData: () => {},
        getData: () => "",
        setDragImage: () => {},
      },
    });
    return ev;
  };

  /** A tab's pill `div` for a set of names, in RENDER order, derived from the DOM
   *  rather than from the store — the whole point is to assert what the user is
   *  shown. `before` counts how many sibling tabs precede a tab, so the sort is a
   *  real positional read rather than a comparator that happens to be consistent.
   *  Takes the names so a test can seed a strip of its own size (the axis tests
   *  below use three tabs; the block's default strip has four). */
  const renderedOrderOf = (names: string[]): string[] => {
    const nodes = names.map((n) => screen.getByRole("tab", { name: n }));
    return nodes
      .map((node, i) => ({
        path: `/w/${names[i]}`,
        before: nodes.filter(
          (other) =>
            other !== node &&
            (other.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0,
        ).length,
      }))
      .sort((a, b) => a.before - b.before)
      .map((x) => x.path);
  };

  /** The strip's RENDER order for the block's four default tabs. */
  const renderedStrip = (): string[] => renderedOrderOf(TAB_NAMES);

  /** Press-and-hold on `fromName`, hover `overName` at `clientX` (with `clientY`
   *  pinned to the pills' shared vertical midpoint, see `dragOver`), release.
   *  Returns the `drop` event so a test can read `defaultPrevented`.
   *  The target pill spans x 100..220, so its midpoint is 160: the two pointers
   *  the tests below use are 110 (LEFT half → before) and 210 (RIGHT half →
   *  after). */
  function drag(fromName: string, overName: string, clientX: number): Event {
    const from = pillOf(fromName);
    const to = pillOf(overName);
    layOut(from, 0);
    layOut(to, 100); // 100..220, midpoint 160
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, clientX);
    const ev = buildDrop();
    fireEvent(to, ev);
    return ev;
  }

  it("every tab pill is draggable, and the drag surface is EXACTLY the pills", () => {
    // THE WIRING PIN, and the positive control every gesture test below leans on.
    // TWO COMPETING ANSWERS: `draggable="true"` on each pill (the hook's spread
    // landed) vs the attribute absent (the prop was dropped at the call site) —
    // and with it absent NO tab can be dragged in the app while every other test
    // in this block still passes, because they drive the handlers directly. The
    // CENSUS is the other half: a `draggable` that leaked onto the tablist
    // container or the spacer would make the whole strip one drag source, so
    // "exactly four elements in the strip carry it" is the claim, not "at least".
    render(<SpaceTabs />);
    const strip = screen.getByTestId("space-tabs");
    const draggables = [...strip.querySelectorAll('[draggable="true"]')];
    expect(draggables).toHaveLength(TAB_PATHS.length);
    for (const name of TAB_NAMES) {
      expect(pillOf(name).getAttribute("draggable"), name).toBe("true");
      expect(draggables, name).toContain(pillOf(name));
    }
  });

  it("dragging a tab onto another tab's LEFT half reorders the strip to alpha, delta, beta, gamma", async () => {
    // Spec §5 test #13, in the tab strip. TWO COMPETING ANSWERS: "before" means
    // DIRECTLY LEFT of the target → [alpha, delta, beta, gamma]; an off-by-one
    // reading "before" as one slot earlier answers [delta, alpha, beta, gamma],
    // i.e. the tab lands left of alpha while the indicator was promising beta.
    // The pointer is 110, in the target's LEFT half (100..220, midpoint 160),
    // with `clientY` pinned to the pills' shared vertical midpoint — so ONLY an
    // X reading can produce this array.
    // A display sort is the THIRD answer, and the one ADR 0075 exists to delete.
    render(<SpaceTabs />);
    expect(renderedStrip()).toEqual(TAB_PATHS);
    drag("delta", "beta", 110); // 110 < midpoint 160 → LEFT half → before
    expect(renderedStrip()).toEqual([
      "/w/alpha",
      "/w/delta",
      "/w/beta",
      "/w/gamma",
    ]);
    // The write is the WHOLE strip, not the moved tab (the Rust side writes each
    // index as the row's stored number, so a partial list is a half-moved list —
    // and a Space the slice omits is kept at the BOTTOM, which would silently
    // strand the tabs that were not named). `waitFor` because the store LINKS its
    // command behind the previous reorder's promise, so the IPC call lands a
    // microtask after the optimistic write the DOM above already reflects.
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));
    expect(reorderSpaces).toHaveBeenCalledWith([
      "/w/alpha",
      "/w/delta",
      "/w/beta",
      "/w/gamma",
    ]);
  });

  it("dragging a tab onto another tab's RIGHT half reorders to alpha, beta, delta, gamma — the other answer", async () => {
    // The same gesture with the pointer 100px further RIGHT. Without BOTH halves
    // asserted, a call site that ignores `overEdge` (or a hook that always
    // inserts after) passes the left-half test by accident.
    render(<SpaceTabs />);
    drag("delta", "beta", 210); // 210 > midpoint 160 → RIGHT half → after
    expect(renderedStrip()).toEqual([
      "/w/alpha",
      "/w/beta",
      "/w/delta",
      "/w/gamma",
    ]);
    await waitFor(() =>
      expect(reorderSpaces).toHaveBeenCalledWith([
        "/w/alpha",
        "/w/beta",
        "/w/delta",
        "/w/gamma",
      ]),
    );
  });

  it("the drop edge shows on the TARGET pill only, on the edge the pointer is nearest", () => {
    // The indicator is a class on the real pill (spec §Indicator) — asserted on
    // the pill under the pointer and on NO other pill. TWO COMPETING ANSWERS at
    // the call site: `border-*` gated on `drag.overId === path` (the hook's edge,
    // gated on the hook's target) vs gated on `overEdge` alone — which paints the
    // edge on EVERY pill and would read as the whole strip lifting.
    //
    // LEFT AND RIGHT, not top and bottom: this strip is horizontal, so "earlier"
    // is the pill's left edge. The sidebar keeps `border-t-2`/`border-b-2` — the
    // pair the call site chooses is part of its contract, so asserting the
    // horizontal pair HERE and the vertical pair in `SpacesList.test.tsx` is what
    // pins that the two call sites did not collapse onto one another.
    render(<SpaceTabs />);
    const from = pillOf("delta");
    const to = pillOf("beta");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 110); // LEFT half of 100..220 → "before"
    expect(to.className).toContain("border-l-2");
    expect(to.className).not.toContain("border-r-2");
    // And NOT the vertical pair the sidebar paints — a call site that kept the
    // top/bottom edges while the hook switched to X would paint a line the user
    // cannot connect to their left/right intent.
    expect(to.className).not.toContain("border-t-2");
    expect(to.className).not.toContain("border-b-2");
    for (const name of ["alpha", "gamma", "delta"]) {
      const el = pillOf(name);
      expect(el.className, name).not.toContain("border-l-2");
      expect(el.className, name).not.toContain("border-r-2");
    }
    // The pointer crossing to the RIGHT half flips the edge, and the left edge
    // goes away — an indicator that only ever paints one edge is the bug the
    // hook's `overEdge` exists to prevent.
    dragOver(to, 210);
    expect(to.className).toContain("border-r-2");
    expect(to.className).not.toContain("border-l-2");
  });

  it("no edge is painted before the gesture and none after it ends", () => {
    // A lingering indicator reads as "drop here" on a strip that is no longer
    // being dragged at. THE POSITIVE CONTROL is the middle assertion: without
    // proving the edge APPEARS mid-gesture, this whole test is a statement about
    // a class nothing in the tree can ever paint — the "certifying the absence of
    // the mechanism" shape this branch has been bitten by twice.
    render(<SpaceTabs />);
    const edge = (el: HTMLElement) =>
      el.className.includes("border-l-2") || el.className.includes("border-r-2");
    for (const name of TAB_NAMES) expect(edge(pillOf(name))).toBe(false);
    const from = pillOf("delta");
    const to = pillOf("beta");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    dragOver(to, 210);
    expect(edge(to)).toBe(true);
    // Release (which clears the gesture) — no edge survives it.
    fireEvent(to, buildDrop());
    for (const name of TAB_NAMES) expect(edge(pillOf(name))).toBe(false);
  });

  it("dropping a tab on itself is a no-op: no reorder, no IPC, no indicator, no move", async () => {
    // TWO COMPETING ANSWERS: a call site that lets a pill target itself fires an
    // IPC with an unchanged slice (a pointless write that still rewrites every
    // Space's stored number) and paints an edge on the tab the user is holding.
    // The hook refuses the target — this pins that the refusal reaches the
    // RENDERED strip, not just the hook's own state.
    render(<SpaceTabs />);
    const self = pillOf("beta");
    // THE POSITIVE CONTROL, and the reason it sits here rather than only in the
    // wiring test: with no drag mounted at all, every assertion below passes on
    // an inert pill — `dragOver` returns `true` because NOTHING handled it.
    expect(self.getAttribute("draggable")).toBe("true");
    layOut(self, 100);
    fireEvent.dragStart(self, { dataTransfer: { setData: vi.fn() } });
    // `true` === nothing prevented === the browser's no-drop cursor, and the
    // window backstop is what swallows the release (spec hazard 2).
    expect(dragOver(self, 210)).toBe(true);
    expect(self.className).not.toContain("border-r-2");
    fireEvent(self, buildDrop());
    expect(reorderSpaces).not.toHaveBeenCalled();
    expect(renderedStrip()).toEqual(TAB_PATHS);
    // THE CONTROL THAT MAKES THE SILENCE MEAN SOMETHING: the same tab, dropped on
    // a NEIGHBOUR in a way that actually changes the order, does fire the write —
    // so the two assertions above are the self-target refusal talking, not dead
    // wiring. (It has to be the RIGHT half: dropping `beta` on `gamma`'s LEFT half
    // is the order the strip already has, and the hook correctly refuses to write
    // a no-op — so that gesture would leave this control as green as the bug.)
    drag("beta", "gamma", 210);
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));
  });

  it("a tab that joined the strip mid-drag is named by the write and keeps its own slot", async () => {
    // THE INDEPENDENCE PIN, and the fixture the "new rows join at the bottom"
    // rule forces. The store's `reorderSpaces` keeps a Space the slice does not
    // name at the BOTTOM of the array — deliberately NOT its original index — so
    // an order assertion that could be satisfied by that rule pins nothing. Here
    // a fifth Space arrives MID-GESTURE and in the MIDDLE of the strip (a boot
    // `setSpaces` re-seeds the array in the DB's order, so a Space can land
    // anywhere), which makes the two rules answer differently:
    //  - the hook reads the ids of the LAST RENDER, so the write names all five
    //    and `epsilon` keeps the MIDDLE slot the strip shows it in →
    //    [alpha, epsilon, delta, beta, gamma];
    //  - a call site that froze the paths when the drag STARTED sends four, and
    //    the bottom-join rule sinks `epsilon` → [alpha, delta, beta, gamma,
    //    epsilon] — a tab the user never dragged jumps to the end.
    // The write's own contents are asserted too, because "the strip looks right"
    // is also true for the stale slice until the next re-render.
    render(<SpaceTabs />);
    const from = pillOf("delta");
    const to = pillOf("beta");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    // The Space arrives mid-gesture, in the MIDDLE (see the note above).
    act(() => {
      useSessions.setState({
        spaces: [
          space("/w/alpha"),
          space("/w/epsilon"),
          space("/w/beta"),
          space("/w/gamma"),
          space("/w/delta"),
        ],
      });
    });
    dragOver(to, 110); // LEFT half → before
    fireEvent(to, buildDrop());
    expect(
      useSessions.getState().spaces.map((s) => s.path),
      "the mid-drag tab was sunk to the bottom by a stale slice",
    ).toEqual(["/w/alpha", "/w/epsilon", "/w/delta", "/w/beta", "/w/gamma"]);
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));
    expect(reorderSpaces).toHaveBeenCalledWith([
      "/w/alpha",
      "/w/epsilon",
      "/w/delta",
      "/w/beta",
      "/w/gamma",
    ]);
  });

  it("the ✕ carries draggable={false}, so a press on the close control starts no drag", () => {
    // Spec §Handle + §5 test #18. The ✕ is a CHILD of the draggable pill, so an
    // inherited/absent value lets the browser walk up to the pill and drag the
    // TAB instead of closing it — a destructive control reachable only by
    // accident. TWO COMPETING ANSWERS: `"false"` (the opt-out landed) vs the
    // attribute absent. The pill's own `draggable="true"` is asserted alongside so
    // the ✕ is proven to sit inside a draggable parent — otherwise "false" would
    // be inherited-free by construction and the test would certify nothing.
    render(<SpaceTabs />);
    for (const name of TAB_NAMES) {
      const close = screen.getByRole("button", { name: `Close ${name}` });
      expect(close.getAttribute("draggable"), name).toBe("false");
      expect(pillOf(name).getAttribute("draggable"), name).toBe("true");
    }
  });

  it("a LEFT-drag started on the tab pill does not close the tab", async () => {
    // SPEC HAZARD 2, and the one this branch could not pin before `draggable`
    // existed (T05's D8): the pill's `onMouseDown` closes on `button === 1` and
    // returns early for every other button, so a left press falls through — a
    // property with no mechanism until the pill became a drag source.
    // TWO COMPETING ANSWERS: the left press is the drag's start and closes
    // nothing (correct) vs an `onMouseDown` rewritten to act on any button, which
    // closes the tab the moment the user commits to a drag.
    render(<SpaceTabs />);
    const from = pillOf("beta");
    expect(from.getAttribute("draggable"), "the drag surface never landed").toBe(
      "true",
    );
    // The press that begins a drag, then the gesture itself, on the SAME pill.
    fireEvent.mouseDown(from, { button: 0 });
    // FLUSH, then assert: `closeSpace` → `removeSpace` reaches `deleteSpace`
    // through a promise chain, so a synchronous `not.toHaveBeenCalled()` here
    // would be green even under the bug (measured — a mutated handler that acts
    // on button 0 was only caught several assertions later, which is how a pin
    // ends up pointing at the wrong line). A macrotask drains the whole chain.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(deleteSpace, "a left press closed the tab").not.toHaveBeenCalled();
    expect(useSessions.getState().spaces).toHaveLength(4);
    layOut(from, 0);
    const to = pillOf("alpha");
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    expect(dragOver(to, 110)).toBe(false);
    fireEvent(to, buildDrop());
    // The drag COMPLETED (so the assertions above are a fall-through talking, not
    // an inert pill) and still nothing closed, and nothing asked.
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));
    expect(deleteSpace).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
      "/w/beta",
      "/w/alpha",
      "/w/gamma",
      "/w/delta",
    ]);
    // THE OTHER BUTTON STILL WORKS: the same pill's middle-click closes, exactly
    // as it did before the pill was draggable — the two gestures share one
    // `onMouseDown` and only one of them may fire.
    fireEvent.mouseDown(pillOf("beta"), { button: 1 });
    await waitFor(() => expect(deleteSpace).toHaveBeenCalledTimes(1));
    expect(useSessions.getState().spaces.map((s) => s.path)).toEqual([
      "/w/alpha",
      "/w/gamma",
      "/w/delta",
    ]);
  });

  it("the pill keeps opting OUT of the window-drag region after a drag (spec §5 #16)", () => {
    // SPEC HAZARD 1, the after-drag half. The attribute's presence is pinned by
    // "the pill opts OUT of the window-drag region …" above (whose comment names
    // both reasons it is load-bearing); this pins that the reorder's re-render —
    // the pills moving to new DOM positions — does not lose it. TWO COMPETING
    // ANSWERS: every pill still answers `"false"` vs a re-render that drops it,
    // which hands Tauri's injected drag script the mousedown and makes the tab
    // drag the WINDOW instead of the tab.
    render(<SpaceTabs />);
    drag("delta", "beta", 110);
    // The strip actually moved, so the pills below were re-rendered and re-read.
    expect(renderedStrip()).toEqual([
      "/w/alpha",
      "/w/delta",
      "/w/beta",
      "/w/gamma",
    ]);
    for (const name of TAB_NAMES) {
      expect(
        pillOf(name).getAttribute("data-tauri-drag-region"),
        name,
      ).toBe("false");
    }
  });

  it("RIGHTWARD: dragging gamma rightward onto beta's LEFT half reorders to alpha, gamma, beta (the axis bug)", async () => {
    // THE BUG THIS TEST EXISTS TO CATCH, and the reason the two tests above
    // passed while the feature was broken: the strip is HORIZONTAL, so a tab
    // drag holds `clientY` essentially constant and the landing side must be
    // read off `clientX`. The hook read `clientY` for both lists, so a grab at
    // the pill's vertical CENTRE — the most natural grab, and the one this
    // fixture spells — answered "after" no matter where the pointer was
    // horizontally.
    //
    // TWO COMPETING ANSWERS, and they are the two halves of the bug:
    //   - the BUG: edge "after" → moveId(gamma, beta, after) →
    //     [alpha, beta, gamma] → identical to the current order → the hook's
    //     "nothing moved" guard fires → **no reorder at all, no IPC, the strip
    //     does not move**;
    //   - the FIX: clientX 20 is in beta's LEFT half → "before" →
    //     [alpha, gamma, beta].
    // The LEFTWARD sibling below ([beta, alpha, gamma] from an alpha-onto-beta
    // drag) is GREEN under the bug — it lands on "after" by accident — which is
    // exactly why the pair had to include the RIGHTWARD case to have any
    // detection value at all. That asymmetry is the whole shape of the bug:
    // "leftward drags work, rightward drags silently do nothing".
    //
    // `clientY` sits EXACTLY on the rect's vertical midpoint (116 of 100..132),
    // so no Y-based rule can be what satisfies this test, and the pill's rect is
    // 120px WIDE (the degenerate-axis fixture this block shipped with is what
    // hid the bug).
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta"), space("/w/gamma")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    const three = ["alpha", "beta", "gamma"];
    expect(renderedOrderOf(three)).toEqual([
      "/w/alpha",
      "/w/beta",
      "/w/gamma",
    ]);

    const from = pillOf("gamma");
    const to = pillOf("beta");
    // Both pills at x 0..120, y 100..132 — BOTH axes non-degenerate.
    // The TARGET pill sits at x 0..120 (midpoint 60), so x 20 is unambiguously
    // its LEFT half. Both pills share y 100..132 — BOTH axes non-degenerate.
    layOut(from, 0);
    layOut(to, 0);
    fireEvent(from, mkDrag("dragstart", 60, 116));
    // The grab is at the pill's vertical CENTRE (116) and in beta's LEFT third
    // (x 20 of 0..120) — a rightward intent stated entirely in X.
    fireEvent(to, mkDrag("dragover", 20, 116));
    fireEvent(to, mkDrag("drop", 20, 116));

    expect(
      renderedOrderOf(three),
      "no reorder happened: the horizontal drag was decided by clientY",
    ).toEqual(["/w/alpha", "/w/gamma", "/w/beta"]);
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));
    expect(reorderSpaces).toHaveBeenCalledWith([
      "/w/alpha",
      "/w/gamma",
      "/w/beta",
    ]);
  });

  it("a LEFTWARD tab drag works too (the direction the bug got right by accident)", async () => {
    // The other half of the pair. A horizontal drag onto a target to the LEFT
    // landed on "after" under the buggy Y rule as well, so this direction was
    // never visibly broken — the bug's user-visible shape was asymmetric.
    // TWO COMPETING ANSWERS: [beta, alpha, gamma] (x 100 is RIGHT of the pill's
    // midpoint 60 → "after") vs NO REORDER at all (an X comparison inverted to
    // `>` would answer "before", and `alpha` dropped before `beta` is the order
    // the strip already has, so the guard fires and nothing moves).
    // It is deliberately GREEN under the old hook too, and it exists for the
    // mutation the RIGHTWARD test cannot see: a "fix" that flips the comparison
    // instead of the axis reddens THIS one while leaving the rightward case
    // looking right. Without it, the pair above could be satisfied by an inverted
    // rule and the strip would break leftward instead.
    useSessions.setState({
      spaces: [space("/w/alpha"), space("/w/beta"), space("/w/gamma")],
      activeSpacePath: "/w/alpha",
    });
    render(<SpaceTabs />);
    const three = ["alpha", "beta", "gamma"];
    const from = pillOf("alpha");
    const to = pillOf("beta");
    layOut(from, 0);
    layOut(to, 0); // the target spans x 0..120, midpoint 60
    fireEvent(from, mkDrag("dragstart", 60, 116));
    // Grab at beta's vertical CENTRE again (so Y answers nothing), on its RIGHT
    // half (x 100 > midpoint 60) → "after".
    fireEvent(to, mkDrag("dragover", 100, 116));
    fireEvent(to, mkDrag("drop", 100, 116));
    expect(renderedOrderOf(three)).toEqual([
      "/w/beta",
      "/w/alpha",
      "/w/gamma",
    ]);
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));
  });

  it("a tab's drop wins without stopping propagation, so a release outside any pill is left to the backstop", async () => {
    // Spec hazard 2 at the CALL SITE. `useWindowDropBackstop` listens on `window`
    // and the pill's handler fires first during bubbling, so the pill wins the
    // drop on its own — but only if it does not take propagation away on the way
    // out, because the backstop is the one thing standing between a stray drop
    // and the webview NAVIGATING to it. (The backstop mounts in `ChatStream`, not
    // here, so what is provable in this file is the pill's half — the same split
    // T06 documents for a sidebar row.)
    // TWO COMPETING ANSWERS to "did the pill claim the event?": a pill that calls
    // `stopPropagation` reorders correctly AND leaves the backstop deaf (every
    // reorder test stays green, the app navigates away on a stray drop); the
    // correct pill prevents and propagates.
    render(<SpaceTabs />);
    const from = pillOf("delta");
    const to = pillOf("beta");
    layOut(from, 0);
    layOut(to, 100);
    fireEvent.dragStart(from, { dataTransfer: { setData: vi.fn() } });
    // THE POSITIVE CONTROL: the pill has to have CLAIMED the gesture for the
    // release below to mean anything. Without this line the assertions pass on a
    // strip with no drag wiring at all.
    expect(dragOver(to, 110)).toBe(false);

    // Half one — released ON the pill: prevented, reordered, and NOT stopped.
    const onPill = buildDrop();
    const stopped = vi.spyOn(onPill, "stopPropagation");
    fireEvent(to, onPill);
    expect(onPill.defaultPrevented).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(reorderSpaces).toHaveBeenCalledTimes(1));

    // Half two — released OUTSIDE every pill: the strip never claims it, so the
    // event arrives at `window` un-prevented and un-stopped for the backstop to
    // swallow, and no tab moves.
    vi.mocked(reorderSpaces).mockClear();
    const stray = buildDrop();
    const strayStopped = vi.spyOn(stray, "stopPropagation");
    fireEvent(document.body, stray);
    expect(stray.defaultPrevented).toBe(false);
    expect(strayStopped).toHaveBeenCalledTimes(0);
    expect(reorderSpaces).not.toHaveBeenCalled();
  });
});
