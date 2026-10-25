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

/**
 * C7 moved these three controls onto `<Button variant="ghost" size="icon">`, so
 * the rendered attribute is the constant (merged LAST, so it still wins every
 * group it spells) plus what the base and the `ghost`/`icon` arms contribute.
 * The byte-exact `toBe` below therefore becomes a SET comparison — lost-tokens
 * empty, gained-tokens exactly this list — which is the same claim `
 * WindowControls.test.tsx`'s `BUTTON_ADDITIONS` makes, token for token: the two
 * clusters are one grammar, so they gain the identical set. Each addition is
 * inert here (no text, no `aria-invalid`/`aria-expanded`, never disabled, no
 * competing flex pressure); the reasoning is on the component. `border-0` is the
 * component's own wall against the base's 1px `border`.
 */
const BUTTON_ADDITIONS = [
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
  "outline-none",
  "select-none",
  "shrink-0",
  "size-7",
  "text-ui-base/relaxed",
  "whitespace-nowrap",
].sort();

/** Class attributes are SETS, not strings — `cn()` reorders on conflict. */
const tokens = (className: string): string[] =>
  [...new Set(className.split(/\s+/).filter(Boolean))].sort();

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
  // left every other data field the store carries to leak between cases. No
  // comment here quotes HOW MANY fields that is — the next field added to a
  // store would stale every copy of the number, and a stale count in a
  // comment reads as evidence.
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

  it("every control keeps the shared CHROME_BUTTON grammar plus this cluster's `relative`", () => {
    // Finding 6a: this cluster's `BTN` and `WindowControls`' two literals were
    // the same string spelled three times, and they still wear the same
    // constant. Under C7 that constant is `className` on a `<Button>`, so the
    // pin is a SET comparison — every pre-extraction token survives, and the
    // additions are exactly the inert set (see `BUTTON_ADDITIONS`). `relative`
    // stays HERE, not in the constant: the pending dot is `absolute`, and
    // `WindowControls`' three buttons must not gain a positioning context.
    render(<ChromeControls onOpenSettings={() => {}} />);
    const controls = [
      screen.getByRole("button", { name: "Settings" }),
      screen.getByTestId("left-pane-toggle"),
      screen.getByTestId("right-pane-toggle"),
    ];
    for (const control of controls) {
      const painted = tokens(control.className);
      for (const token of tokens(CONTROL_BUTTON)) {
        expect(painted, `control lost ${token}`).toContain(token);
      }
      expect(
        painted.filter((t) => !tokens(CONTROL_BUTTON).includes(t)),
      ).toEqual(BUTTON_ADDITIONS);
      expect(control.className).toContain(`relative ${CHROME_BUTTON}`);
    }
    // The two clusters are ONE grammar: the left toggle and `WindowControls`'
    // Minimize differ by exactly `relative` and nothing else.
    expect(tokens(screen.getByTestId("left-pane-toggle").className)).toEqual(
      [...tokens(CHROME_BUTTON), "relative", ...BUTTON_ADDITIONS].sort(),
    );
  });

  it("each glyph carries an explicit `size-*` CLASS matching its `size` PROP (the Button base would otherwise force 16px)", () => {
    // The same hazard `WindowControls.test.tsx` pins for the window cluster:
    // `buttonVariants`' `[&_svg:not([class*='size-'])]:size-4` selects svgs that
    // size themselves by PROP, and CSS beats the presentation attribute. All
    // three of these glyphs were `size={14}`, so all three carry `size-3.5`.
    render(<ChromeControls onOpenSettings={() => {}} />);
    const svgs = [
      screen.getByRole("button", { name: "Settings" }),
      screen.getByTestId("left-pane-toggle"),
      screen.getByTestId("right-pane-toggle"),
    ].map((b) => b.querySelector("svg") as SVGSVGElement | null);
    expect(svgs.every((s) => s !== null)).toBe(true);
    for (const svg of svgs as SVGSVGElement[]) {
      expect(svg.getAttribute("class")).toContain("size-3.5");
      expect(svg.getAttribute("width")).toBe("14");
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
