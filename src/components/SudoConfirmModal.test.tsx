import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SudoConfirmModal from "./SudoConfirmModal";
import { useInteractive } from "../store/interactive";
import { resetStores } from "../test/resetStores";

/**
 * The `sudo_exec` confirm gate had NO test file at all — it is one of the two
 * error-bearing components that shipped without one (Task C3's note; it had to
 * verify its `IpcErrorLine` migration by DOM capture instead). Task C1 changes
 * this component's busy/error SHAPE (the two `useState`s become one
 * `useAsyncAction`), so the gap is closed here rather than left open behind a
 * refactor.
 *
 * These are CHARACTERIZATION tests: every assertion describes what the
 * component does TODAY (including the two behaviours a fresh design would
 * probably change — the unguarded double click, and the request staying in the
 * store after a failed answer). They exist so the migration cannot move
 * behaviour unnoticed.
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

const confirmRequest = {
  requestId: "r1",
  method: "confirm" as const,
  source: "native",
  params: {
    command: "apt-get update",
    reason: "install the build toolchain",
  },
};

/** Seed one confirm request for session `s1`. */
function seed(overrides: Record<string, unknown> = {}) {
  useInteractive.getState().addRequest("s1", {
    ...confirmRequest,
    ...overrides,
  });
}

beforeEach(() => {
  resetStores();
  mockedRespond.mockReset();
  mockedRespond.mockResolvedValue(undefined);
});

describe("SudoConfirmModal", () => {
  it("renders the command and the reason verbatim", () => {
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    expect(screen.getByText("Run this command with sudo?")).toBeTruthy();
    // The `<pre>` carries the command UNMODIFIED — the whole point of the gate
    // is that the user reads exactly what will run.
    expect(screen.getByText("apt-get update").tagName).toBe("PRE");
    expect(screen.getByText("install the build toolchain")).toBeTruthy();
  });

  it("renders Run and Cancel and nothing else", () => {
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("renders nothing for a missing request", () => {
    const { container } = render(
      <SudoConfirmModal sessionId="s1" requestId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the request is not a confirm (an ask is not this modal)", () => {
    seed({ method: "ask", params: { questions: [] } });
    const { container } = render(
      <SudoConfirmModal sessionId="s1" requestId="r1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the request is a password request", () => {
    seed({ method: "password", params: { command: "apt-get update" } });
    const { container } = render(
      <SudoConfirmModal sessionId="s1" requestId="r1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("Run answers { confirmed: true }", async () => {
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        confirmed: true,
      }),
    );
  });

  it("Cancel answers { confirmed: false }", async () => {
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(mockedRespond).toHaveBeenCalledWith("s1", "r1", {
        confirmed: false,
      }),
    );
  });

  it("removes the request from the store after a successful answer", async () => {
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
  });

  it("omits the reason paragraph when the request carries none", () => {
    seed({ params: { command: "apt-get update" } });
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    expect(screen.getByText("apt-get update")).toBeTruthy();
    expect(screen.queryByText("install the build toolchain")).toBeNull();
  });

  it("announces a failed answer through role=\"alert\" and keeps the gate open", async () => {
    seed();
    mockedRespond.mockRejectedValueOnce("sudo confirm rejected");
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("sudo confirm rejected");
    // The error line's class string (Task C3's `IpcErrorLine` default, with no
    // per-site override at this call site).
    expect(alert.getAttribute("class")).toBe("text-ui-sm text-destructive");
    // A failed answer is NOT a settled request: the gate stays in the store, so
    // the user can retry (ADR 0040 — a gate is never rendered nowhere).
    expect(useInteractive.getState().requests["s1"]).toHaveLength(1);
  });

  it("re-enables both buttons after a failure", async () => {
    seed();
    mockedRespond.mockRejectedValueOnce("sudo confirm rejected");
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    const run = screen.getByRole("button", { name: "Run" });
    fireEvent.click(run);
    await screen.findByRole("alert");
    expect(run.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("renders no alert region while nothing has failed", () => {
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables both buttons while the answer is in flight, and the modal collapses once it is answered", async () => {
    // The busy half of the machine: the buttons go dead for the duration of the
    // round trip. Note the assertions capture the buttons BEFORE the resolve —
    // on success the request is removed from the store and the component
    // renders `null`, so the nodes are detached and their `disabled` attribute
    // would read stale forever.
    let resolveCall!: () => void;
    mockedRespond.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCall = resolve;
        }),
    );
    seed();
    const { container } = render(
      <SudoConfirmModal sessionId="s1" requestId="r1" />,
    );
    const run = screen.getByRole("button", { name: "Run" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(run);
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(true));
    expect(cancel.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      resolveCall();
    });
    // The request is settled → removed → nothing renders (the dialog portals, so
    // the content node is gone rather than hidden).
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
    expect(container.ownerDocument.body.textContent).not.toContain(
      "Run this command with sudo?",
    );
  });

  it("the ONLY re-entrancy protection here is the disabled attribute — the handler has none", async () => {
    // Task C1's guard question, answered with an executable answer.
    // `SudoConfirmModal` has NO `if (busy) return` (unlike
    // `SudoPasswordModal.tsx:49`). A fast double click still issues ONE call,
    // but NOT because the handler guards: the first click's `setBusy(true)`
    // re-renders before the second click is dispatched, and a disabled
    // `<button>` never reaches its listener. So the protection lives in the
    // DOM, and `disabled={busy}` on BOTH buttons is load-bearing — if a later
    // change drops it, this site becomes double-answerable, because the JS has
    // no guard behind it. That is exactly why `useAsyncAction`'s default `run`
    // does NOT self-guard (it would be inventing protection this component never
    // had in code) and why the migration must keep `disabled={busy}`.
    let resolveCall!: () => void;
    mockedRespond.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCall = resolve;
        }),
    );
    seed();
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    const run = screen.getByRole("button", { name: "Run" });
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(run.hasAttribute("disabled")).toBe(true));
    expect(mockedRespond).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCall();
    });
  });

  it("answers again on a later click once the previous answer settled (no sticky guard)", async () => {
    // The other half of the same claim: nothing in the component latches. After
    // a FAILED answer the gate is still open, the buttons are live, and a second
    // click issues a second call.
    seed();
    mockedRespond.mockRejectedValueOnce("sudo confirm rejected");
    render(<SudoConfirmModal sessionId="s1" requestId="r1" />);
    const run = screen.getByRole("button", { name: "Run" });
    fireEvent.click(run);
    await screen.findByRole("alert");
    fireEvent.click(run);
    await waitFor(() => expect(mockedRespond).toHaveBeenCalledTimes(2));
  });
});
