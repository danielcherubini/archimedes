import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { respondInteractiveRequest } from "../lib/tauri";
import { SubagentModals } from "./SubagentModals";
import SubagentDetailHost from "./SubagentDetailHost";
import {
  GATE_PANEL_DODGE_BREAKPOINT,
  SUBAGENT_SHEET_WIDTH,
} from "../lib/subagentSheetLayout";
import { useSubagents } from "../store/subagents";
import { childGatesOf, isInlineChildGate } from "../hooks/useChildGates";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
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

const entry = {
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running" as const,
};

const otherEntry = {
  sessionId: "sub2",
  parentSessionId: "main2",
  agentName: "explorer",
  task: "explore the codebase",
  status: "running" as const,
};

/** One child's pending `ask` (the payload `AskQuestionCard` renders). */
const askRequest = (requestId: string, question: string) => ({
  requestId,
  method: "ask" as const,
  source: "subagent:reviewer",
  params: {
    questions: [
      { id: "q1", question, options: [{ label: "Red" }, { label: "Blue" }] },
    ],
  },
});

beforeEach(() => {
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  useInteractive.getState().dismissSession("sub1");
  useInteractive.getState().dismissSession("sub2");
  useInteractive.getState().dismissSession("main1");
  usePermissions.getState().dismissSessionPrompts("sub1");
  usePermissions.getState().dismissSessionPrompts("sub2");
  usePermissions.getState().dismissSessionPrompts("main1");
  useSessions.setState({ messages: {} });
});

afterEach(() => {
  vi.mocked(respondInteractiveRequest).mockClear();
});

describe("SubagentModals (the one overlay host for every child's gates)", () => {
  it("renders a `confirm` request for the subagent session id as a SudoConfirmModal", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "confirm",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    // `ChatStream` renders the `SudoConfirmModal` ONLY for the ACTIVE
    // session's requests — and a `Subagent session` id is never the ACTIVE
    // session, so this is the ONLY renderer for a child's `confirm` (the
    // render-site partition). It matters: there is no prompt deadline, so a
    // gate rendered NOWHERE strands the child INDEFINITELY (ADR 0055: a child
    // parked on a gate holds its `tool_call_id` open, so it is an Active
    // Subagent and `DEFAULT_SUBAGENT_DEAD_BOUND` never runs on it).
    expect(screen.getByText("Run this command with sudo?")).toBeTruthy();
    expect(screen.getByText("apt install ripgrep")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("renders a `password` request for the subagent session id as a SudoPasswordModal", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("renders an `ask` request for the child session as an AskQuestionCard (answerable with the child's sheet CLOSED)", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    // The card is the ANSWERABLE card (its option buttons route the answer to
    // the CHILD's session id), not a placeholder.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    // The attribution chip names the child — the lifted card has no other
    // context in the overlay (the components themselves stay parent/child
    // agnostic, so the chip lives on the wrapper).
    expect(screen.getByText("↳ reviewer")).toBeTruthy();
  });

  it("renders a permission prompt for the child session as a PermissionPrompt", () => {
    useSubagents.getState().addSession(entry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<SubagentModals />);
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByText("↳ reviewer")).toBeTruthy();
  });

  it("renders TWO distinct cards when two children hold the same `requestId` (the composite-key regression)", () => {
    // A child's `requestId` is the model's tool-call id, which some
    // OpenAI-compatible gateways index per response (`call_0`), so an id DOES
    // recur across children. A bare-`requestId` key makes React drop one card
    // (the "two children with the same key" warning) — and a dropped card is
    // an unanswerable gate.
    useSubagents.getState().addSession(entry);
    useSubagents.getState().addSession(otherEntry);
    useInteractive.getState().addRequest("sub1", askRequest("call_0", "Which color?"));
    useInteractive.getState().addRequest("sub2", askRequest("call_0", "Which path?"));
    const keyWarnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      keyWarnings.push(args.map(String).join(" "));
    };
    try {
      render(<SubagentModals />);
    } finally {
      console.error = originalError;
    }
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByText("Which path?")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(2);
    // Both children are attributed (each card carries its own chip).
    expect(screen.getByText("↳ reviewer")).toBeTruthy();
    expect(screen.getByText("↳ explorer")).toBeTruthy();
    expect(
      keyWarnings.filter((m) => /same key/i.test(m)),
      keyWarnings.join("\n"),
    ).toEqual([]);
  });

  it("renders nothing without entries", () => {
    const { container } = render(<SubagentModals />);
    expect(container.textContent).toBe("");
    // No empty region either (an empty landmark would be announced as an
    // empty "prompts" region for a child that has none).
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("a lifted `ask` card does NOT steal focus from a field the user is editing", () => {
    // The overlay renders app-wide, so a child's `ask` can land while the user
    // types in the composer. The card is never anchored (`source !== "main"`),
    // so its unanchored auto-focus would fire and move focus into a
    // `tabIndex={-1}` div — losing the rest of the keystrokes and un-binding
    // Enter-to-send. The overlay passes `autoFocus={false}`.
    const { container } = render(
      <>
        <textarea aria-label="composer" />
        <SubagentModals />
      </>,
    );
    const composer = container.querySelector("textarea")!;
    composer.focus();
    expect(document.activeElement).toBe(composer);
    useSubagents.getState().addSession(entry);
    act(() => {
      useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    });
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(document.activeElement).toBe(composer);
  });

  it("the ask/permission wrapper is a `fixed` right-side panel BELOW the dialogs and the transcript sheet (z-40, never z-50)", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    // A `confirm` too, so a Radix `Dialog` exists to test the nesting against.
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    const wrapper = screen.getByTestId("subagent-gate-overlay");
    // `fixed`: the panel anchors to the viewport corner and takes no slot in
    // `App`'s flex row (it is a sibling of the workspace columns, mounted at
    // the `App` root — never inside the clipped `SidePane` frame).
    expect(wrapper.className).toContain("fixed");
    // `z-40`, NOT `z-50`: `DialogContent` and `SubagentDetailHost`'s sheet are
    // both `z-50` — `z-50` here would leave the tie to DOM order alone.
    expect(wrapper.className).toContain("z-40");
    expect(wrapper.className).not.toContain("z-50");
    // The panel scrolls (a tall ask must stay reachable) and is a named region.
    expect(wrapper.className).toContain("overflow-y-auto");
    expect(wrapper.getAttribute("role")).toBe("region");
    expect(wrapper.getAttribute("aria-label")).toContain("reviewer");
    // The sudo modals are SIBLINGS of the wrapper, never inside it: Radix
    // `Dialog` portals to `document.body` but React events still bubble
    // through the REACT tree, so a `Dialog` nested in the wrapper would have
    // its Esc swallowed by the wrapper's stop.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(wrapper.contains(dialog)).toBe(false);
  });

  it("the region label names each child EXACTLY ONCE (distinct, in arrival order)", () => {
    // The label is an accessibility affordance — a screen reader announces it
    // when the region takes focus. `SubagentModals` de-dupes the names because
    // one child routinely holds SEVERAL gates (an `ask` and a Permission prompt
    // at once), and without the de-dupe the same child would be announced twice
    // in a label the user cannot scan. Two children are seeded so the DISTINCT
    // half is exercised too: a fix that made the label unique by dropping the
    // repeats would have to keep BOTH children's names.
    useSessions.setState({ activeSessionId: null });
    useSubagents.getState().addSession(entry);
    useSubagents.getState().addSession(otherEntry);
    // TWO gates for `sub1` (both would push `reviewer`), ONE for `sub2`.
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    useInteractive.getState().addRequest("sub2", askRequest("r2", "Which path?"));
    render(<SubagentModals />);
    const label = screen
      .getByTestId("subagent-gate-overlay")
      .getAttribute("aria-label")!;
    const mentions = (name: string) => label.split(name).length - 1;
    // Both children are named…
    expect(mentions("reviewer")).toBe(1);
    expect(mentions("explorer")).toBe(1);
    // …in arrival order (`sub1` started first, so its name leads), and the
    // region is a real labelled landmark.
    expect(label.indexOf("reviewer")).toBeLessThan(label.indexOf("explorer"));
    expect(label.startsWith("Subagent prompts")).toBe(true);
    expect(screen.getByRole("region", { name: label })).toBeTruthy();
  });

  it("an `ask` card's OWN Escape still dismisses the card (the wrapper's stop does not swallow it)", async () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    // React runs the INNERMOST handler first, and the card's
    // `stopPropagation()` reaches `nativeEvent.stopPropagation()` — so the
    // wrapper's Escape stop never runs for a card that handles Esc itself.
    const card = screen.getByText("Which color?").closest("[tabindex='-1']")!;
    fireEvent.keyDown(card, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(respondInteractiveRequest)).toHaveBeenCalled();
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(0);
  });

  it("an Escape on the wrapper does NOT reach the window (the parent's turn is not cancelled)", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    // `ChatStream`'s turn-cancel listener is a WINDOW-level `keydown` (active
    // while `inTurn`); `PermissionPrompt` has NO Esc handler at all, so an Esc
    // landing on the wrapper or on one of its buttons would otherwise reach
    // that window listener and cancel the PARENT's turn.
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByTestId("subagent-gate-overlay"), {
      key: "Escape",
    });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).not.toHaveBeenCalled();
    // The region is NOT dismissible: stopping the Escape answers nothing and
    // hides nothing — the gate stays pending.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("an Escape inside a sudo Dialog is NOT swallowed by the wrapper (the modals are SIBLINGS, not children)", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    // Radix portals the `Dialog` to `document.body`, but React events still
    // bubble through the REACT tree — so a `Dialog` rendered INSIDE the
    // wrapper would have this Escape stopped by the wrapper, silently changing
    // today's Esc-in-sudo-modal behaviour. An Escape on the Dialog's own
    // content (not the password input, which has its own handler) therefore
    // still reaches `window`.
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).toHaveBeenCalled();
  });

  it("an Escape on a PermissionPrompt button does NOT reach the window either", () => {
    useSubagents.getState().addSession(entry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<SubagentModals />);
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    // `PermissionPrompt` carries no `onKeyDown` of its own — the wrapper is
    // the only thing between its buttons and `window`.
    fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
      key: "Escape",
    });
    window.removeEventListener("keydown", windowEsc);
    expect(windowEsc).not.toHaveBeenCalled();
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
  });
});

describe("SubagentModals (the overlay keeps only what ChatStream cannot render)", () => {
  // The partition key is now "is this gate's parent the ACTIVE session".
  // `ChatStream` renders only `activeSessionId`, so an ACTIVE parent gets its
  // child's `ask`/permission INLINE in its transcript and the overlay must
  // draw NONE of them (two live copies of one request = divergent typed drafts
  // and an Esc that closes only one). A NON-active parent has no transcript to
  // render into, so the overlay still draws them — never nowhere.
  // `confirm`/`password` stay in the overlay for EVERY child either way: they
  // are Radix `Dialog`s, and a modal `Dialog` inlined into a transcript is not
  // what this change signed up for.
  const active = (sessionId: string | null) =>
    useSessions.setState({ activeSessionId: sessionId });

  // The store is module-scoped: this block is the only one in this file that
  // seeds an ACTIVE session, so it seeds and un-seeds it (otherwise a test
  // appended after this block would silently inherit an active parent and
  // watch its cards go missing).
  beforeEach(() => {
    active(null);
    useSubagentSelection.getState().select(null);
  });
  afterEach(() => {
    active(null);
    useSubagentSelection.getState().select(null);
  });

  // GEOMETRY PINS, ALL CLASS-LEVEL ON PURPOSE. jsdom runs no layout engine:
  // there is no `getBoundingClientRect()` to ask, so what these can pin is the
  // CLASS LIST — which geometry the panel asks the real browser for, and under
  // which media query. The arithmetic they encode (`subagentSheetLayout.ts`)
  // and the compiled CSS are the two halves; the commit that changes either
  // must re-read both.
  const classes = (el: HTMLElement): string[] => el.className.split(/\s+/);

  it("class-level: with a sheet open the panel asks for BOTH geometries — corner as the base, the sheet dodge behind a min-width variant", () => {
    // Both regions are right-anchored and `SUBAGENT_SHEET_WIDTH` wide, so the
    // sheet fully COVERS a corner panel of the same width, and opening ANY
    // child's
    // transcript used to make every overlay card invisible — including the card
    // the OS alert just told the user to answer. So while a sheet is open the
    // panel asks for the sheet's LEFT edge instead … but ONLY from the
    // breakpoint up (the next test), and the ask is an ADDITIONAL variant class
    // rather than a swap: the corner geometry stays as the base.
    active("other");
    useSubagents.getState().addSession(entry);
    useSubagents.getState().addSession(otherEntry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    // The sheet belongs to a DIFFERENT child than the card's — it covers the
    // panel either way, so it moves the panel either way.
    useSubagentSelection.getState().select("sub2");
    render(<SubagentModals />);
    const tokens = classes(screen.getByTestId("subagent-gate-overlay"));
    // The dodge: offset to the sheet's left edge, and capped at the room left
    // over (the default window is 800px, so an uncapped 480px panel would hang
    // off the viewport's LEFT edge) — each gated on the breakpoint.
    expect(tokens).toContain(
      `min-[${GATE_PANEL_DODGE_BREAKPOINT}px]:right-[${SUBAGENT_SHEET_WIDTH}px]`,
    );
    expect(tokens).toContain(
      `min-[${GATE_PANEL_DODGE_BREAKPOINT}px]:max-w-[calc(100vw-${SUBAGENT_SHEET_WIDTH}px)]`,
    );
    // And NEVER unconditional: a bare offset of the sheet's width, with no
    // variant in front of it, is exactly what put a zero-width panel off-viewport
    // on a narrow window (the next test).
    expect(tokens).not.toContain(`right-[${SUBAGENT_SHEET_WIDTH}px]`);
    expect(tokens).not.toContain(
      `max-w-[calc(100vw-${SUBAGENT_SHEET_WIDTH}px)]`,
    );
    // Still the same panel: nothing about the card moved.
    expect(screen.getByText("Which color?")).toBeTruthy();
  });

  it("class-level: the corner geometry is the panel's UNCONDITIONAL base, so a window narrower than the dodge breakpoint gets a rendered card instead of an unreachable one", () => {
    // THE NARROW-VIEWPORT FALLBACK PIN. The dodge's own math gives the panel
    // `min(480, 100vw - 480)` — 320px at the 800px default, 120px at 600, a
    // ~40px sliver at 520, and at ≤ 480 the dodge's own width cap clamps to
    // 0 while its 480px offset moves the box OFF the viewport: mounted, zero
    // width, UNREACHABLE, stranding the child INDEFINITELY (ADR 0055 — a
    // gate-parked child is an Active Subagent and no clock bounds it). That
    // trades the branch's worst failure for a worse one,
    // so the dodge engages only from `GATE_PANEL_DODGE_BREAKPOINT` (760 = the
    // sheet's 480 + the 280px floor a card needs) and below it the panel keeps
    // the corner geometry — right edge, capped at 90% of the viewport: buried
    // behind the sheet, degraded but fully
    // RENDERED and answerable the moment the sheet closes — the geometry this
    // branch shipped with before the dodge existed.
    active("other");
    useSubagents.getState().addSession(entry);
    useSubagents.getState().addSession(otherEntry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    useSubagentSelection.getState().select("sub2");
    render(<SubagentModals />);
    const tokens = classes(screen.getByTestId("subagent-gate-overlay"));
    // The fallback geometry carries NO variant prefix, so it is what the
    // browser paints below the breakpoint (where the prefixed dodge does not
    // apply) — and if the variant ever failed to compile, it is also what the
    // browser paints everywhere, which fails safe (buried, not unreachable).
    expect(tokens).toContain("right-0");
    expect(tokens).toContain("max-w-[90vw]");
    expect(tokens).toContain(`w-[${SUBAGENT_SHEET_WIDTH}px]`);
  });

  it("class-level: with NO child sheet open the panel asks for the corner geometry and nothing else", () => {
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    const tokens = classes(screen.getByTestId("subagent-gate-overlay"));
    expect(tokens).toContain("right-0");
    // Not one dodge token — no offset, and no offset behind a variant either.
    expect(
      tokens.filter((t) => t.includes(`right-[${SUBAGENT_SHEET_WIDTH}px]`)),
    ).toEqual([]);
    expect(
      tokens.filter((t) => t.includes(`calc(100vw-${SUBAGENT_SHEET_WIDTH}px)`)),
    ).toEqual([]);
  });

  it("class-level: the panel does NOT move for a selection whose entry is gone (no sheet is painted)", () => {
    // `SubagentDetailHost` paints its sheet only for a selection that still has
    // an entry; a stale selection must not shove the panel off into empty space.
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    useSubagentSelection.getState().select("ghost");
    render(<SubagentModals />);
    const tokens = classes(screen.getByTestId("subagent-gate-overlay"));
    expect(tokens).toContain("right-0");
    // No dodge token at all — not the offset, not the width cap.
    expect(tokens.filter((t) => /right-\[/.test(t))).toEqual([]);
    expect(tokens.filter((t) => t.includes("calc(100vw-480px)"))).toEqual([]);
  });

  it("class-level: `sheetMounted={false}` pins the panel to the corner even for a selection that HAS an entry (the Settings view)", () => {
    // THE PHANTOM-DODGE PIN, at the unit level (`App.test.tsx` pins that `App`
    // actually passes the prop). The dodge needs TWO facts: the selection names a
    // sheet that still has an entry, AND the sheet's own view is mounted — and
    // the overlay can only read the first, since `SubagentDetailHost` lives
    // inside `App`'s `view === "settings"` ternary while this host deliberately
    // does not. Opening Settings is therefore a state where a live, entry-backed
    // selection names a sheet that is NOT painted, and the panel used to slide to
    // the sheet's left edge and float over the Settings page anyway. `App` tells
    // the host the second fact instead of clearing the selection, because
    // clearing it threw the user's sheet away.
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    useSubagentSelection.getState().select("sub1");
    render(<SubagentModals sheetMounted={false} />);
    const tokens = classes(screen.getByTestId("subagent-gate-overlay"));
    expect(tokens).toContain("right-0");
    // Not one dodge token — neither the offset nor the width cap.
    expect(tokens.filter((t) => /right-\[/.test(t))).toEqual([]);
    expect(tokens.filter((t) => t.includes("calc(100vw-"))).toEqual([]);
    // And the view change moved the PANEL only: the card is still rendered here,
    // so the gate is no further from answerable than it was.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
  });

  it("class-level: the sheet's width and the panel's dodge offset are ONE number (`SUBAGENT_SHEET_WIDTH`)", () => {
    // The dodge is only correct while it matches the sheet's width EXACTLY: too
    // small and the panel slides under the sheet (the bug the dodge exists to
    // fix), too large and it floats over the transcript with a gap. Tailwind
    // cannot interpolate a constant into a class name, so the two literals live
    // in two files and nothing but THIS test ties them — change one class
    // without the other (or without the constant) and this goes red.
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    useSubagentSelection.getState().select("sub1");
    render(
      <>
        <SubagentDetailHost />
        <SubagentModals />
      </>,
    );
    const sheet = screen.getByRole("dialog", { name: /transcript/ });
    const panel = screen.getByTestId("subagent-gate-overlay");
    // The sheet's width …
    expect(classes(sheet)).toContain(`w-[${SUBAGENT_SHEET_WIDTH}px]`);
    // … and the panel's offset, from the SAME constant.
    expect(classes(panel)).toContain(
      `min-[${GATE_PANEL_DODGE_BREAKPOINT}px]:right-[${SUBAGENT_SHEET_WIDTH}px]`,
    );
    // Pinned as a pair: the two literals in the DOM carry the same number, so
    // a drift in one of them cannot hide behind a stale constant.
    const sheetWidth = classes(sheet).find((t) => /^w-\[\d+px\]$/.test(t));
    const panelOffset = classes(panel).find((t) => /:right-\[\d+px\]$/.test(t));
    expect(sheetWidth).toBe(`w-[${SUBAGENT_SHEET_WIDTH}px]`);
    expect(panelOffset).toBe(
      `min-[${GATE_PANEL_DODGE_BREAKPOINT}px]:right-[${SUBAGENT_SHEET_WIDTH}px]`,
    );
  });

  it("the panel is CLICK-TRANSPARENT outside its cards (pointer-events-none region, pointer-events-auto cards)", () => {
    // The panel is `fixed` and up to 480px wide, so its rect covers real
    // controls it does not contain — the `SidePane` footer toggle, and (with
    // the dodge) the LEFT pane's footer/toggle too (`LEFT_PANE_WIDTH` = 260, so
    // a panel offset 480px from the right edge spans it on an 800px window).
    // The region therefore takes NO pointer events; each card wrapper takes
    // them back. That is also why the geometry costs stopped being a reason to
    // refuse the dodge: an overlapping-but-transparent panel steals no CLICKS —
    // and nothing here can pin the rest, because jsdom runs no layout engine. What
    // the frame's own transparency also gives up (its scrollbar cannot be dragged,
    // and a text drag cannot start in a gap) is named and accepted in the
    // component's JSX comment, not implied away by this test's name.
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    const panel = screen.getByTestId("subagent-gate-overlay");
    expect(classes(panel)).toContain("pointer-events-none");
    // Every card the region hosts is clickable.
    const cards = Array.from(panel.children).filter(
      (c) => (c as HTMLElement).tagName === "DIV",
    );
    expect(cards.length).toBe(1);
    for (const card of cards) {
      expect(classes(card as HTMLElement)).toContain("pointer-events-auto");
    }
  });

  it("renders NO ask card for a child whose parent IS the active session (it moved inline)", () => {
    active("main1");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    expect(screen.queryByText("Which color?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Red" })).toBeNull();
    // No empty region either (nothing is left for the panel to host).
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
  });

  it("renders NO Permission prompt for a child whose parent IS the active session", () => {
    active("main1");
    useSubagents.getState().addSession(entry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<SubagentModals />);
    expect(screen.queryByText("Bash (apt install ripgrep)")).toBeNull();
    expect(screen.queryByTestId("subagent-gate-overlay")).toBeNull();
  });

  it("DOES render the ask card when a DIFFERENT session is active (the never-nowhere half)", () => {
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    expect(screen.getByText("↳ reviewer")).toBeTruthy();
  });

  it("DOES render the Permission prompt when a DIFFERENT session is active", () => {
    active("other");
    useSubagents.getState().addSession(entry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<SubagentModals />);
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
    expect(screen.getByText("↳ reviewer")).toBeTruthy();
  });

  it("renders NO active child card when there is no active session at all (null is not a parent)", () => {
    // `activeSessionId === null` matches no `parentSessionId`, so nothing has a
    // live transcript — the overlay must keep drawing every child's card
    // (returning `[]` for `null` here would strand all of them).
    active(null);
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    render(<SubagentModals />);
    expect(screen.getByText("Which color?")).toBeTruthy();
  });

  it("still renders a `confirm` Dialog for a child whose parent IS active (sudo modals never move inline)", () => {
    active("main1");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    expect(screen.getByText("Run this command with sudo?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("still renders a `password` Dialog for a child whose parent IS active", () => {
    active("main1");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r3",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<SubagentModals />);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("splits a mixed set: the active parent's sudo Dialog stays while its ask moves inline, and another parent's ask stays in the panel", () => {
    active("main1");
    useSubagents.getState().addSession(entry);
    useSubagents.getState().addSession(otherEntry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    useInteractive.getState().addRequest("sub2", askRequest("r3", "Which path?"));
    render(<SubagentModals />);
    // Active parent's ask → inline (absent here); its sudo Dialog → present.
    expect(screen.queryByText("Which color?")).toBeNull();
    expect(screen.getByText("Run this command with sudo?")).toBeTruthy();
    // The inactive parent's ask → still the overlay's job.
    expect(screen.getByText("Which path?")).toBeTruthy();
    // The panel hosts exactly the one remaining card, and names only ITS child.
    const panel = screen.getByTestId("subagent-gate-overlay");
    expect(panel.textContent).toContain("Which path?");
    expect(panel.textContent).not.toContain("Which color?");
    expect(screen.getByText("↳ explorer")).toBeTruthy();
    expect(screen.queryByText("↳ reviewer")).toBeNull();
  });

  it("the card half is DERIVED FROM `isInlineChildGate` — one definition of the partition, never a hand-written kind list", () => {
    // The overlay's card set is DEFINED as "the kinds the transcript draws, for
    // a parent that is NOT active", so it is computed here from the SAME
    // predicate `MessageList` filters its rows with. The mutation this guards
    // is the one no kind-by-kind test can see: a fifth `ChildGateKind` added to
    // `isInlineChildGate` (and therefore to the transcript) while this component
    // kept its own `kind === "ask" || kind === "permission"` copy would render
    // that kind in BOTH sites — divergent typed drafts, an Esc that closes one —
    // and every assertion written against the old two kinds would stay green.
    // Because the expectation below is COMPUTED from the predicate, widening it
    // moves this test with the transcript instead of silently disagreeing.
    active("other");
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", askRequest("r1", "Which color?"));
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r3",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<SubagentModals />);
    // One child holding ALL FOUR gate kinds, with a parent that is not active:
    // the overlay owns every one of them, two as cards and two as `Dialog`s.
    const everyGate = childGatesOf(
      useSubagents.getState().entries,
      useInteractive.getState().requests,
      usePermissions.getState().prompts,
      null,
    );
    expect(everyGate).toHaveLength(4);
    const inlineKinds = everyGate.filter((g) => isInlineChildGate(g));
    const lifted = inlineKinds.filter(
      (g) => g.parentSessionId !== useSessions.getState().activeSessionId,
    );
    // The predicate is what decides, and the active-parent filter takes the
    // rest: the parent here is NOT active, so the inline half is lifted whole.
    expect(inlineKinds).toHaveLength(lifted.length);
    const panel = screen.getByTestId("subagent-gate-overlay");
    // One card wrapper per lifted gate — no more (double render), no fewer
    // (stranded gate).
    expect(Array.from(panel.children)).toHaveLength(lifted.length);
    // And the two kinds the predicate does NOT claim are still on screen, as
    // `Dialog`s outside the panel: the partition covers every gate exactly once.
    expect(screen.getByText("Run this command with sudo?")).toBeTruthy();
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(Array.from(panel.querySelectorAll("[role='dialog']"))).toHaveLength(0);
  });
});
