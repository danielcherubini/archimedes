import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import SubagentDetailHost from "./SubagentDetailHost";
import { useSubagents } from "../store/subagents";
import { useSubagentSelection } from "../store/subagentSelection";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";

// NO `vi.mock("../lib/tauri")` here on purpose. This file used to mock
// `respondInteractiveRequest` / `respondPermission`, which implied the sheet
// hosts prompt cards and could answer them — the inference the render-site
// partition removed when the transcript stopped rendering gates (see
// `SubagentTranscript`'s doc: a gate
// rendered there is a bug). Nothing this file renders reaches IPC, so the mock
// is gone rather than kept as a hint of a capability the component no longer
// has. If a gate ever DOES render inside the sheet, this file needs the mock
// back — and `App.test.tsx`'s sheet pin fails first, because that is a third
// render site.

const entry = {
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running" as const,
};

const otherEntry = {
  sessionId: "sub2",
  parentSessionId: "main1",
  agentName: "explorer",
  task: "explore the codebase",
  status: "running" as const,
};

/** Seed the selection and flush the re-render. */
function select(id: string | null): void {
  act(() => {
    useSubagentSelection.getState().select(id);
  });
}

beforeEach(() => {
  useSubagentSelection.setState({ selectedSessionId: null });
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

describe("SubagentDetailHost (the subagent transcript sheet)", () => {
  it("renders the modal HIDDEN (no header) when selectedSessionId is null", () => {
    useSubagents.getState().addSession(entry);
    render(<SubagentDetailHost />);
    // The sheet's outer `div` stays in the DOM even with nothing selected...
    const dialog = screen.getByRole("dialog", { name: /transcript/ });
    expect(dialog.className).toContain("hidden");
    // ...and the inner content (the header) is NOT mounted.
    expect(
      screen.queryByRole("button", { name: "Close subagent transcript" }),
    ).toBeNull();
  });

  it("OPENS the modal (the header renders) when select(sessionId) is called for an existing entry", () => {
    useSubagents.getState().addSession(entry);
    render(<SubagentDetailHost />);
    select("sub1");
    const dialog = screen.getByRole("dialog", { name: /transcript/ });
    expect(dialog.className).not.toContain("hidden");
    // The header: the status icon + the agent name + the status chip.
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("shows the selected subagent's transcript in the modal (rendered exactly once)", () => {
    useSubagents.getState().addSession(entry);
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the subagent" },
    });
    render(<SubagentDetailHost />);
    select("sub1");
    const dialog = screen.getByRole("dialog", { name: /transcript/ });
    const msg = screen.getByText("hello from the subagent");
    // The transcript is inside the sheet...
    expect(dialog.contains(msg)).toBe(true);
    // ...rendered EXACTLY ONCE (the sheet is the transcript's only mount
    // point — a second copy would mean a second live instance of one stream).
    expect(screen.getAllByText("hello from the subagent")).toHaveLength(1);
  });

  it("CLOSES on the X button (selectedSessionId → null)", () => {
    useSubagents.getState().addSession(entry);
    render(<SubagentDetailHost />);
    select("sub1");
    fireEvent.click(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    );
    expect(
      screen.queryByRole("button", { name: "Close subagent transcript" }),
    ).toBeNull();
    expect(useSubagentSelection.getState().selectedSessionId).toBeNull();
  });

  it("CLOSES on Escape (a React onKeyDown on the SHEET — fired on the sheet, NOT window)", () => {
    useSubagents.getState().addSession(entry);
    render(<SubagentDetailHost />);
    select("sub1");
    // The implementation is a React `onKeyDown` on the sheet, so the
    // event must be fired ON THE SHEET (an element inside the modal —
    // a window-targeted keydown would never reach a React handler and
    // would contradict the known-limitation text: Esc only closes the
    // modal when focus is INSIDE the sheet).
    fireEvent.keyDown(screen.getByRole("dialog", { name: /transcript/ }), {
      key: "Escape",
    });
    expect(
      screen.queryByRole("button", { name: "Close subagent transcript" }),
    ).toBeNull();
    expect(useSubagentSelection.getState().selectedSessionId).toBeNull();
  });

  it("a sheet-scoped Escape does NOT reach the window (ChatStream's turn-cancel listener does not fire)", () => {
    useSubagents.getState().addSession(entry);
    render(<SubagentDetailHost />);
    select("sub1");
    // `ChatStream`'s Esc handler is a WINDOW-level `keydown` listener
    // (active while `inTurn`) that cancels the turn. The sheet's
    // `onKeyDown` `stopPropagation()`s the NATIVE event (React forwards
    // it to `nativeEvent.stopPropagation()`) BEFORE it reaches
    // `window` — the spy models that window listener.
    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    fireEvent.keyDown(screen.getByRole("dialog", { name: /transcript/ }), {
      key: "Escape",
    });
    window.removeEventListener("keydown", windowEsc);
    // The modal closed...
    expect(useSubagentSelection.getState().selectedSessionId).toBeNull();
    // ...but the native event was stopped AT THE SHEET (it never
    // reached `window` — the turn is NOT cancelled).
    expect(windowEsc).not.toHaveBeenCalled();
  });

  it("closing does NOT dismiss the entry (it stays in useSubagents) and the transcript is GONE from the DOM", () => {
    useSubagents.getState().addSession(entry);
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the subagent" },
    });
    render(<SubagentDetailHost />);
    select("sub1");
    // Open: the transcript renders inside the sheet.
    const dialog = screen.getByRole("dialog", { name: /transcript/ });
    expect(dialog.contains(screen.getByText("hello from the subagent"))).toBe(
      true,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close subagent transcript" }),
    );
    // The entry is NOT dismissed (closing is `select(null)` only — it
    // never calls `dismiss`): the row stays in the subagent list.
    expect(useSubagents.getState().entries["sub1"]).toBeDefined();
    // The sheet's inner content (the header) is unmounted.
    expect(
      screen.queryByRole("button", { name: "Close subagent transcript" }),
    ).toBeNull();
    // And the transcript is NOT rendered anywhere any more — the sheet is
    // its only mount point. A copy still in the DOM here would be the
    // retired second mount, whose only purpose was keeping the child's
    // prompt cards rendered so an unseen request could not hang; the
    // transcript renders no gate at all, so that reason is gone.
    expect(screen.queryByText("hello from the subagent")).toBeNull();
  });

  it("renders the transcript EXACTLY ONCE, for the SELECTED entry only (the others render nothing)", () => {
    useSubagents.getState().addSession(entry);
    useSubagents.getState().addSession(otherEntry);
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the subagent" },
    });
    useSessions.getState().applySessionUpdate("sub2", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the explorer" },
    });
    render(<SubagentDetailHost />);
    select("sub1");
    // The selected entry's transcript is in the sheet, EXACTLY ONCE.
    expect(screen.getAllByText("hello from the subagent")).toHaveLength(1);
    // A NON-selected entry renders NOTHING at all: nothing mounts a
    // transcript for an entry the sheet is not showing.
    expect(screen.queryByText("hello from the explorer")).toBeNull();
  });

  // NOTE: the former test `an Escape consumed by a nested
  // AskQuestionCard does NOT close the modal` was DELETED here, not deferred:
  // the transcript no longer renders ANY prompt card (every child gate renders
  // in `SubagentModals`), so no card can exist inside the sheet to consume an
  // Escape — the subject of that test no longer exists. The sheet-level Esc
  // tests above (`CLOSES on Escape`, and the window-listener one) are
  // untouched and still pin the sheet's own behaviour.
  //
  // The guarantee that test pinned — an Esc consumed by a child's card stays
  // with the card and reaches nothing else — now lives in `ChatStream.test.tsx`
  // (`an Escape INSIDE the inline child card answers the CHILD and does NOT
  // cancel the parent`), which is where a child's `ask` card renders today: the
  // parent's transcript when the parent is active, the `SubagentModals` panel
  // otherwise (pinned there by `an `ask` card's OWN Escape still dismisses the
  // card (the wrapper's stop does not swallow it)`).
});
