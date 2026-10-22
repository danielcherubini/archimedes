import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { closeSession, deleteSpace } from "../lib/tauri";
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
  };
});

const space = (path: string) => makeSpaceRow({ path });

const info = (sessionId: string, cwd: string) => makeSessionRow({ sessionId, cwd });

beforeEach(() => {
  // Every store back to its own initial state — the hand-written version named
  // nine `useSessions` keys + `usePermissions.prompts`, and the store has
  // sixteen data fields (see `src/test/resetStores.ts`).
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
    // (a) THE DRAG REGION. The chrome bar is `data-tauri-drag-region="deep"`,
    // and Tauri's injected drag script walks the event's composed path and
    // stops at the FIRST element carrying the attribute: `="false"` means "not
    // chrome". A plain `div` with no attribute is therefore claimed as drag
    // surface, which would make part of a control drag the window.
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
