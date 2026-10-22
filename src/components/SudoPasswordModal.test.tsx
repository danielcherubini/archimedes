import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SudoPasswordModal from "./SudoPasswordModal";
import { useInteractive } from "../store/interactive";
import { resetStores } from "../test/resetStores";

/**
 * The `sudo_exec` credential gate had NO test file (one of the two
 * error-bearing components that shipped without one — Task C3's note; it had to
 * verify its `IpcErrorLine` migration by DOM capture). Task C1 changes this
 * component's busy/error SHAPE, so the gap is closed here.
 *
 * These are CHARACTERIZATION tests: they describe what the component does TODAY
 * — including the one thing that makes it different from its sibling
 * `SudoConfirmModal`, the `if (busy) return` guard at `:49`.
 */

// Mock the Tauri IPC layer; everything else (the interactive store) is real.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
  };
});

import { respondInteractiveRequest } from "../lib/tauri";

const mockedRespond = vi.mocked(respondInteractiveRequest);

const passwordRequest = {
  requestId: "r1",
  method: "password" as const,
  source: "native",
  params: {
    command: "apt-get update",
    reason: "install the build toolchain",
  },
};

/** Seed one password request for session `s1`. */
function seed(overrides: Record<string, unknown> = {}) {
  useInteractive.getState().addRequest("s1", {
    ...passwordRequest,
    ...overrides,
  });
}

/** Type into the masked field (the controlled-mask trick appends per change). */
function type(text: string) {
  const input = screen.getByRole("textbox", { name: "Password" });
  let raw = "";
  for (const char of text) {
    // A real browser delivers the field's current value PLUS the typed
    // character, and the field's value is the MASK — so the change payload is
    // `mask + rawChar`, which is what `SudoPasswordModal`'s `onChange` appends.
    fireEvent.change(input, { target: { value: "•".repeat(raw.length) + char } });
    raw += char;
  }
  return input;
}

beforeEach(() => {
  resetStores();
  mockedRespond.mockReset();
  mockedRespond.mockResolvedValue(undefined);
});

describe("SudoPasswordModal", () => {
  it("renders the title, the command and the reason verbatim", () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(screen.getByText("apt-get update").tagName).toBe("PRE");
    expect(screen.getByText("install the build toolchain")).toBeTruthy();
  });

  it("renders nothing for a missing request", () => {
    const { container } = render(
      <SudoPasswordModal sessionId="s1" requestId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the request is not a password request", () => {
    seed({ method: "confirm", params: { command: "apt-get update" } });
    const { container } = render(
      <SudoPasswordModal sessionId="s1" requestId="r1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the MASK, never the raw secret", () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const input = type("hunter2");
    expect(input.getAttribute("value")).toBe("•".repeat(7));
    // The raw value appears nowhere in the rendered tree — the invariant of
    // 0010 / ADR 0022 (the password lives only in this component's `useState`).
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("Backspace deletes the last character of the mask", () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const input = type("abc");
    expect(input.getAttribute("value")).toBe("•••");
    fireEvent.change(input, { target: { value: "••" } });
    expect(input.getAttribute("value")).toBe("••");
  });

  it("Confirm sends the typed secret", async () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    type("hunter2");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        password: "hunter2",
      }),
    );
  });

  it("Enter in the field sends the typed secret", async () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const input = type("pw");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", { password: "pw" }),
    );
  });

  it("Cancel sends the empty password (the cancel sentinel)", async () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    type("hunter2");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", { password: "" }),
    );
  });

  it("Esc in the field cancels with the empty password AND stops the event reaching the window", async () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const input = type("pw");
    // The card owns the Esc: a window/document-level listener would ALSO see it
    // and send `session/cancel`, cancelling the whole turn. `stopPropagation` is
    // asserted on a listener attached to `document`, i.e. ABOVE the React root
    // where the synthetic handler runs.
    let sawEscape = false;
    const listener = () => {
      sawEscape = true;
    };
    document.addEventListener("keydown", listener);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", { password: "" }),
    );
    expect(sawEscape).toBe(false);
    document.removeEventListener("keydown", listener);
  });

  it("removes the request from the store after a successful answer", async () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
  });

  it("announces a failed answer through role=\"alert\" and keeps the gate open", async () => {
    seed();
    mockedRespond.mockRejectedValueOnce("sudo password rejected");
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("sudo password rejected");
    expect(alert.getAttribute("class")).toBe("text-ui-sm text-destructive");
    // A failed answer is not a settled request — the gate stays, so the user can
    // retype (ADR 0040).
    expect(useInteractive.getState().requests["s1"]).toHaveLength(1);
  });

  it("renders no alert region while nothing has failed", () => {
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables both buttons while the answer is in flight", async () => {
    let resolveCall!: () => void;
    mockedRespond.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCall = resolve;
        }),
    );
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(() => {
      resolveCall();
    });
  });

  it("the JS guard at :49 blocks a second Enter while the first answer is in flight", async () => {
    // THE site that self-guards, and the reason `useAsyncAction` takes
    // `{ guard: true }` here. The `disabled` attribute covers the BUTTONS, but
    // the `<input>` is never disabled, so a second Enter would reach the
    // handler — `if (busy) return` is the only thing standing between a held
    // Enter key and a second `respond_interactive_request`. If this reddens, the
    // guard is gone and a sudo password can be answered twice.
    let resolveCall!: () => void;
    mockedRespond.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCall = resolve;
        }),
    );
    seed();
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const input = screen.getByRole("textbox", { name: "Password" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockedRespond).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockedRespond).toHaveBeenCalledTimes(1);
    await act(() => {
      resolveCall();
    });
  });

  it("answers again on a later Enter once the previous answer FAILED (the guard is not sticky)", async () => {
    seed();
    mockedRespond.mockRejectedValueOnce("sudo password rejected");
    render(<SudoPasswordModal sessionId="s1" requestId="r1" />);
    const input = screen.getByRole("textbox", { name: "Password" });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("alert");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockedRespond).toHaveBeenCalledTimes(2));
  });
});
