import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WindowControls from "./WindowControls";

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
});
