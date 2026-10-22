import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ChromeControls from "./ChromeControls";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import {
  getLeftPaneCollapsed,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import {
  getSidePaneCollapsed,
  setSidePaneCollapsed,
} from "../lib/sidePaneState";
import { CHROME_BUTTON } from "./chromeButton";
import { makeSessionRow } from "../test/fixtures";
import { resetModuleFlags, resetStores } from "../test/resetStores";

/**
 * The chrome bar's control cluster: the Settings gear and the two pane
 * toggles, immediately left of the window controls. The cluster exists because
 * the user asked for exactly one thing — those icons belong at the TOP of the
 * window, beside minimize/maximize/close, not at the bottom of their panes —
 * and this file pins the shape that decision implies: one gear, one toggle per
 * pane, present in BOTH collapse states, and the pending dot still meaning
 * "behind a hidden pane".
 */

/** The exact class string every control rendered BEFORE `CHROME_BUTTON`
 *  existed — `WindowControls`' grammar plus this cluster's `relative` (the
 *  pending dot is `absolute`, so the anchor is the caller's). A LITERAL, not a
 *  `cn("relative", CHROME_BUTTON)` recomputation: comparing the render to an
 *  expression built from the same constant would move both sides on a repaint. */
const CONTROL_BUTTON =
  "relative flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground";

/** Seed an ACTIVE session holding one permission prompt — the cheapest way to
 * make `useHasPendingRequest()` true, which is what the dot reads. */
function seedPendingPrompt(): void {
  useSessions.setState({
    sessions: [makeSessionRow({ sessionId: "s1", cwd: "/tmp/alpha" })],
    activeSessionId: "s1",
  });
  usePermissions.setState({
    prompts: { s1: [{ requestId: "r1", toolTitle: "bash", options: [] }] },
  });
}

beforeEach(() => {
  // Every store back to its own initial state — the hand-written version named
  // `useSessions.{sessions,activeSessionId}` + `usePermissions.prompts` and
  // left the store's other fourteen data fields to leak between cases.
  resetStores();
  // The two pane flags are module-scope (and persist to localStorage), so they
  // are `resetModuleFlags`' job, not the store's.
  resetModuleFlags();
});

describe("ChromeControls", () => {
  it("renders the gear and BOTH pane toggles — expanded or collapsed", () => {
    const { rerender } = render(<ChromeControls onOpenSettings={() => {}} />);
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByTestId("left-pane-toggle")).toBeTruthy();
    expect(screen.getByTestId("right-pane-toggle")).toBeTruthy();

    // Collapsed panes change nothing: the cluster is unconditional. That is the
    // property the per-pane footers could not have — a control bound to a pane's
    // width vanishes with it — so it is asserted rather than assumed.
    act(() => {
      setLeftPaneCollapsed(true);
      setSidePaneCollapsed(true);
    });
    rerender(<ChromeControls onOpenSettings={() => {}} />);
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
    expect(screen.getByTestId("left-pane-toggle")).toBeTruthy();
    expect(screen.getByTestId("right-pane-toggle")).toBeTruthy();
  });

  it("orders the cluster gear → left pane → right pane", () => {
    const { container } = render(<ChromeControls onOpenSettings={() => {}} />);
    const cluster = container.firstElementChild as HTMLElement;
    const kids = [...cluster.children];
    expect(kids).toHaveLength(3);
    expect(kids[0]).toBe(screen.getByRole("button", { name: "Settings" }));
    expect(kids[1]).toBe(screen.getByTestId("left-pane-toggle"));
    expect(kids[2]).toBe(screen.getByTestId("right-pane-toggle"));
  });

  it("fires the Settings callback", () => {
    const onOpenSettings = vi.fn();
    render(<ChromeControls onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("each toggle drives its own pane's flag in both directions, from the same button", () => {
    render(<ChromeControls onOpenSettings={() => {}} />);
    const left = screen.getByTestId("left-pane-toggle");
    const right = screen.getByTestId("right-pane-toggle");

    expect(left.getAttribute("aria-label")).toBe("Collapse session list");
    expect(left.getAttribute("aria-pressed")).toBe("true"); // pressed = open
    fireEvent.click(left);
    expect(getLeftPaneCollapsed()).toBe(true);
    expect(left.getAttribute("aria-label")).toBe("Expand session list");
    expect(left.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(left);
    expect(getLeftPaneCollapsed()).toBe(false);

    expect(right.getAttribute("aria-label")).toBe("Collapse side pane");
    fireEvent.click(right);
    expect(getSidePaneCollapsed()).toBe(true);
    fireEvent.click(right);
    expect(getSidePaneCollapsed()).toBe(false);
    // The SAME elements throughout: one control per pane does both jobs, so
    // there is no second button to hand off to anywhere in the shell.
    expect(screen.getByTestId("left-pane-toggle")).toBe(left);
    expect(screen.getByTestId("right-pane-toggle")).toBe(right);
  });

  it("every control renders the shared CHROME_BUTTON grammar plus this cluster's `relative`", () => {
    // Finding 6a: this cluster's `BTN` and `WindowControls`' two literals were
    // the same string spelled three times. The render is compared to the
    // PRE-EXTRACTION literal (so a repaint fails) and then to the constant with
    // `relative` prepended (so the sharing is what is asserted). `relative`
    // stays HERE, not in the constant: the pending dot is `absolute`, and
    // `WindowControls`' three buttons must not gain a positioning context.
    render(<ChromeControls onOpenSettings={() => {}} />);
    const controls = [
      screen.getByRole("button", { name: "Settings" }),
      screen.getByTestId("left-pane-toggle"),
      screen.getByTestId("right-pane-toggle"),
    ];
    for (const control of controls) {
      expect(control.className).toBe(CONTROL_BUTTON);
      expect(control.className).toBe(`relative ${CHROME_BUTTON}`);
    }
  });

  it("holds no pending dot while BOTH panes are open, even with a pending prompt", () => {
    // The dot's meaning is unchanged — "something needs you BEHIND the hidden
    // pane" — so it stays gated on that pane's own collapsed flag now that the
    // button has moved to the chrome bar. Two always-on dots beside the window
    // controls would be noise.
    seedPendingPrompt();
    const { container } = render(<ChromeControls onOpenSettings={() => {}} />);
    expect(container.querySelector(".bg-warning")).toBeNull();
  });

  it("shows the dot on the toggle of a COLLAPSED pane only, and clears when it reopens", () => {
    seedPendingPrompt();
    act(() => {
      setLeftPaneCollapsed(true);
    });
    const { container, rerender } = render(
      <ChromeControls onOpenSettings={() => {}} />,
    );
    const dots = container.querySelectorAll(".bg-warning");
    expect(dots).toHaveLength(1);
    expect(screen.getByTestId("left-pane-toggle").contains(dots[0]!)).toBe(true);
    expect(
      screen.getByTestId("right-pane-toggle").contains(dots[0]!),
    ).toBe(false);
    // Re-opening the left pane takes its dot with it.
    act(() => {
      setLeftPaneCollapsed(false);
    });
    rerender(<ChromeControls onOpenSettings={() => {}} />);
    expect(container.querySelector(".bg-warning")).toBeNull();
  });
});
