import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CloseSpaceDialog from "./CloseSpaceDialog";

// Radix `Dialog` needs the pointer-capture stubs in jsdom (the same block the
// other dialog tests use).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const open = (overrides: Partial<Parameters<typeof CloseSpaceDialog>[0]> = {}) =>
  render(
    <CloseSpaceDialog
      spaceName="alpha"
      sessions={[{ id: "live-1", label: "Refactor the auth middleware" }]}
      onStopAndClose={vi.fn()}
      onCloseAnyway={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );

describe("CloseSpaceDialog (closing a tab that still holds open Sessions)", () => {
  it("names the Space and the Sessions at stake", () => {
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/alpha/)).toBeTruthy();
    expect(screen.getByText("Refactor the auth middleware")).toBeTruthy();
  });

  it("says plainly that closing does NOT delete the conversations", () => {
    open();
    // The one thing a user must not have to guess about: forget ≠ delete.
    expect(screen.getByText(/stay/i)).toBeTruthy();
  });

  it("offers exactly three ways out: Cancel, Close anyway, Stop and close", () => {
    open();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close anyway" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop and close" }),
    ).toBeTruthy();
  });

  it("Stop and close reports the stop intent", () => {
    const onStopAndClose = vi.fn();
    const onCloseAnyway = vi.fn();
    open({ onStopAndClose, onCloseAnyway });
    fireEvent.click(screen.getByRole("button", { name: "Stop and close" }));
    expect(onStopAndClose).toHaveBeenCalledTimes(1);
    expect(onCloseAnyway).not.toHaveBeenCalled();
  });

  it("Close anyway closes WITHOUT stopping anything", () => {
    const onStopAndClose = vi.fn();
    const onCloseAnyway = vi.fn();
    open({ onStopAndClose, onCloseAnyway });
    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    expect(onCloseAnyway).toHaveBeenCalledTimes(1);
    expect(onStopAndClose).not.toHaveBeenCalled();
  });

  it("Cancel (button, and the same exits: Escape / the overlay) reports the abort", () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists every open Session when a Space holds several", () => {
    open({
      sessions: [
        { id: "a", label: "First" },
        { id: "b", label: "Second" },
        { id: "c", label: "Third" },
      ],
    });
    for (const label of ["First", "Second", "Third"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  // -- The SHAPE of the list (it is a list, not a run-on sentence) --------

  it("keys the list by Session id, so two Sessions with the SAME label cannot collide", () => {
    // `titleFor` falls back to the Space's folder name for a Session with no
    // title and no first message, so two such Sessions label identically — the
    // one case where a label cannot be a React key.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    open({
      sessions: [
        { id: "live-1", label: "alpha" },
        { id: "live-2", label: "alpha" },
      ],
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps the Session list OUT of the description a screen reader reads as one blob", () => {
    // `DialogDescription` is the dialog's `aria-describedby`: everything
    // inside it is announced as ONE run-on sentence, so the subject of the
    // question belongs in its own element and the description stays prose —
    // the `DeleteSessionDialog`'s split.
    open();
    const dialog = screen.getByRole("dialog");
    const describedById = dialog.getAttribute("aria-describedby");
    expect(describedById, "the dialog has no description to point at").toBeTruthy();
    const described = document.getElementById(describedById!);
    expect(described, "aria-describedby points at nothing").toBeTruthy();
    // The prose survives there…
    expect(described!.textContent).toMatch(/stay/i);
    // …and the labels do NOT.
    expect(described!.textContent).not.toMatch(/Refactor the auth middleware/);
    // They are a list, inside the dialog.
    expect(dialog.querySelector("ul li")?.textContent).toBe(
      "Refactor the auth middleware",
    );
  });

  it("caps the list's height — many Sessions must not grow the dialog off the viewport", () => {
    open({
      sessions: Array.from({ length: 12 }, (_, i) => ({
        id: `live-${i}`,
        label: `Session ${i}`,
      })),
    });
    const list = document.querySelector("ul");
    expect(list, "the Sessions are not a list").toBeTruthy();
    expect(list!.className, "the list has no height cap").toMatch(/max-h-40/);
    expect(list!.className, "an over-tall list cannot scroll").toMatch(
      /overflow-y-auto/,
    );
  });
});
