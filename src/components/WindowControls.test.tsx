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

  it("Minimize and Maximize render the shared CHROME_BUTTON grammar, byte-identically", () => {
    // Finding 6a: this string used to be spelled here AND in `ChromeControls`.
    // The rendered attribute is compared to the PRE-EXTRACTION literal, so the
    // extraction cannot repaint the box, the radius, the ink or the transition,
    // and then compared to the constant, which is what makes it shared.
    render(<WindowControls />);
    for (const title of ["Minimize", "Maximize / Restore"]) {
      const button = screen.getByTitle(title);
      expect(button.className).toBe(SUBTLE_BUTTON);
      expect(button.className).toBe(CHROME_BUTTON);
    }
  });

  it("Close renders the destructive-hover arm, byte-identically", () => {
    render(<WindowControls />);
    const close = screen.getByTitle("Close");
    expect(close.className).toBe(CLOSE_BUTTON);
    expect(close.className).toBe(CHROME_BUTTON_CLOSE);
    // The hover pair is SWAPPED, not added to — a Close that also filled
    // `bg-hover` would flash grey before red.
    expect(close.className).not.toContain("hover:bg-hover");
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
