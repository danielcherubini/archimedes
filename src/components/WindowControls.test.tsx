import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WindowControls from "./WindowControls";
import { CHROME_BUTTON, CHROME_BUTTON_CLOSE } from "./chromeButton";

/**
 * The exact class string each control rendered BEFORE `CHROME_BUTTON` existed.
 * Spelled as a LITERAL here on purpose: if the test imported only the constant
 * and compared the rendered class to it, a repaint of the constant would move
 * both sides and stay green. The literal is the characterisation pin; the
 * equality assertion below is what proves the string is now SHARED.
 */
const SUBTLE_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground";
const CLOSE_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-destructive/20 hover:text-destructive";

/**
 * C7 moved these three buttons onto `<Button variant="ghost" size="icon">`, so
 * the rendered attribute is now `CHROME_BUTTON` (passed as `className`, merged
 * LAST so it still wins every group it spells) plus whatever the `Button` base
 * and the `ghost`/`icon` arms contribute. The pin above therefore CANNOT be a
 * byte-exact `toBe` any more — a gained utility is the point of the primitive —
 * so the characterisation moved from "the string is identical" to the two halves
 * that actually carry the no-repaint claim:
 *
 *  1. NOTHING IS LOST. Every token of the pre-extraction literal must still be
 *     on the element. This is the half that would catch a merge dropping the
 *     box, the ink, the radius or the hover pair, and it is the half the old
 *     `toBe` was standing in for.
 *  2. NOTHING UNEXPECTED IS GAINED. The additions are pinned as a SET, so a
 *     future change to `buttonVariants` that slips a painting utility in (a
 *     background, a padding, a border width) reddens here instead of silently
 *     repainting the chrome bar. Each entry is inert HERE, and the reason for
 *     every one of them is on the component's own doc-comment. `border-0` is in
 *     the list because the component adds it itself, to undo the base's `border`.
 *
 * `size-7` is a gain that needs no excuse: it is the `icon` size's box, and it
 * is 28px against the constant's `h-7 w-7` — the same 28px.
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

/** Class attributes are SETS, not strings — `cn()` reorders on conflict, and the
 *  program's evidence method compares sets (see the C3 decision on `cn()`). */
const tokens = (className: string): string[] =>
  [...new Set(className.split(/\s+/).filter(Boolean))].sort();

// The component calls getCurrentWindow() on every render, so the mock must
// return a STABLE object (hoisted) that we can clear between tests.
const mockWindow = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockWindow,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WindowControls", () => {
  it("renders minimize, maximize, and close controls", () => {
    render(<WindowControls />);
    expect(screen.getByTitle("Minimize")).toBeTruthy();
    expect(screen.getByTitle("Maximize / Restore")).toBeTruthy();
    expect(screen.getByTitle("Close")).toBeTruthy();
  });

  it("wraps EVERY control in the [data-window-control] container (the attention-alert exemption)", () => {
    render(<WindowControls />);
    const shells = document.querySelectorAll("[data-window-control]");
    expect(shells.length).toBe(1);
    for (const title of ["Minimize", "Maximize / Restore", "Close"]) {
      const control = screen.getByTitle(title);
      // The ancestor, not the buttons themselves: the activity handler asks
      // `event.target.closest("[data-window-control]")`, so a click on the
      // icon (the real target) resolves to the container.
      expect(control.closest("[data-window-control]")).toBe(shells[0]);
    }
  });

  it("calls window.minimize() on the minimize button", () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByTitle("Minimize"));
    expect(mockWindow.minimize).toHaveBeenCalledTimes(1);
  });

  it("calls window.toggleMaximize() on the maximize button", () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByTitle("Maximize / Restore"));
    expect(mockWindow.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("calls window.close() on the close button", () => {
    render(<WindowControls />);
    fireEvent.click(screen.getByTitle("Close"));
    expect(mockWindow.close).toHaveBeenCalledTimes(1);
  });

  it("Minimize and Maximize keep the shared CHROME_BUTTON grammar, plus only inert Button additions", () => {
    // Finding 6a's no-repaint claim, restated for a `<Button>` (see
    // `BUTTON_ADDITIONS` above): the constant's tokens are ALL still present,
    // and the only new tokens are the pinned inert set. The constant is still
    // what these buttons wear — the second assertion is what makes it shared.
    render(<WindowControls />);
    for (const title of ["Minimize", "Maximize / Restore"]) {
      const button = screen.getByTitle(title);
      const painted = tokens(button.className);
      for (const token of tokens(SUBTLE_BUTTON)) {
        expect(painted, `Minimize/Maximize lost ${token}`).toContain(token);
      }
      expect(painted.filter((t) => !tokens(SUBTLE_BUTTON).includes(t))).toEqual(
        BUTTON_ADDITIONS,
      );
      expect(button.className).toContain(CHROME_BUTTON);
    }
  });

  it("Close keeps the destructive-hover arm, plus only inert Button additions", () => {
    render(<WindowControls />);
    const close = screen.getByTitle("Close");
    const painted = tokens(close.className);
    for (const token of tokens(CLOSE_BUTTON)) {
      expect(painted, `Close lost ${token}`).toContain(token);
    }
    expect(painted.filter((t) => !tokens(CLOSE_BUTTON).includes(t))).toEqual(
      BUTTON_ADDITIONS,
    );
    expect(close.className).toContain(CHROME_BUTTON_CLOSE);
    // The hover pair is SWAPPED, not added to — a Close that also filled
    // `bg-hover` would flash grey before red. The `ghost` arm DOES carry
    // `hover:bg-hover`, so this asserts it lost the merge: the constant is
    // merged last and wins the group.
    expect(close.className).not.toContain("hover:bg-hover");
  });

  it("each glyph carries an explicit `size-*` CLASS matching its `size` PROP (the Button base would otherwise force 16px)", () => {
    // The hazard C7 exists to survive: `buttonVariants` carries
    // `[&_svg:not([class*='size-'])]:size-4`, which selects exactly the svgs that
    // size themselves with the `size` PROP, and a CSS rule beats a presentation
    // attribute. So a glyph that keeps only `size={14}` would render at 16px with
    // nothing in the DOM to show it. The class is what keeps 14px 14px and 12px
    // 12px; `size-3.5`/`size-3` are 14px/12px at the default `--spacing`.
    render(<WindowControls />);
    const expectSize = (title: string, cls: string) => {
      const svg = screen
        .getByTitle(title)
        .querySelector("svg") as SVGElement | null;
      expect(svg, `${title} lost its glyph`).toBeTruthy();
      expect((svg as SVGSVGElement).getAttribute("class")).toContain(cls);
      // The PROP is still there too — the class is what wins, but the attribute
      // is the number the class must keep agreeing with.
      expect(svg!.getAttribute("width")).toBe(cls === "size-3.5" ? "14" : "12");
    };
    expectSize("Minimize", "size-3.5");
    expectSize("Maximize / Restore", "size-3");
    expectSize("Close", "size-3.5");
  });

  it("no control carries `relative` — the shared constant must not add a positioning context here", () => {
    // `ChromeControls` adds `relative` itself because it owns an `absolute`
    // pending dot; these three never had one and must not gain one.
    render(<WindowControls />);
    for (const title of ["Minimize", "Maximize / Restore", "Close"]) {
      expect(screen.getByTitle(title).className.split(/\s+/)).not.toContain(
        "relative",
      );
    }
  });
});
