import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import { usePendingSubagentRequests } from "./usePendingSubagentRequests";

const entry = {
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running" as const,
};

beforeEach(() => {
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  // The app-wide pin below sets an active session; clear it so the next test
  // never inherits it.
  useSessions.setState({ activeSessionId: null });
  useInteractive.getState().dismissSession("sub1");
  useInteractive.getState().dismissSession("main1");
  usePermissions.getState().dismissSessionPrompts("sub1");
  usePermissions.getState().dismissSessionPrompts("main1");
  useInteractive.getState().dismissSession("sub-of-A");
  useInteractive.getState().dismissSession("sub-of-B");
  usePermissions.getState().dismissSessionPrompts("sub-of-A");
  usePermissions.getState().dismissSessionPrompts("sub-of-B");
});

describe("usePendingSubagentRequests", () => {
  it("returns 0 with no subagent entries", () => {
    const { result } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(0);
  });

  it("returns 1 with a subagent entry and a pending ask request for its session", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    const { result } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(1);
  });

  it("returns 2 with a pending ask and a pending password request", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    const { result } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(2);
  });

  it("returns 0 after removeRequest / removePrompt settle the requests", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    usePermissions.getState().addPrompt("sub1", "p1", {
      toolCall: { title: "Run rm -rf" },
      options: [{ optionId: "allow_once", name: "Allow once" }],
    });
    const { result } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(2);
    // `act`: the store change must trigger a re-render for the hook to
    // pick up the settled request (a bare `getState()` mutation outside
    // `act` would leave `result.current` stale).
    act(() => {
      useInteractive.getState().removeRequest("sub1", "r1");
    });
    expect(result.current).toBe(1);
    act(() => {
      usePermissions.getState().removePrompt("sub1", "p1");
    });
    expect(result.current).toBe(0);
  });

  it("does NOT count requests for sessions with no subagent entry (the main session)", () => {
    useInteractive.getState().addRequest("main1", {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: { question: "which library?" },
    });
    const { result } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(0);
  });

  it("still counts a gate whose parent is NOT the active session (the dot stays app-wide)", () => {
    // THE regression pin for the refactor. "Improve" this by filtering to the
    // ACTIVE parent and the dot goes silent for a gate the user owes that is
    // on screen in the overlay. Parent-scoping is `useChildGates`'s job (its
    // own test file pins it); this count is deliberately every child.
    useSessions.setState({ activeSessionId: "A" });
    useSubagents.getState().addSession({
      sessionId: "sub-of-B",
      parentSessionId: "B",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    useInteractive.getState().addRequest("sub-of-B", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    const { result } = renderHook(() => usePendingSubagentRequests());
    // EXACTLY one, not "at least one": a derivation that counted the same gate
    // twice (e.g. summing the inline and overlay halves instead of taking their
    // union) would satisfy `>= 1` and still be wrong — the dot is a count the
    // user reads as "this many questions are waiting".
    expect(result.current).toBe(1);
  });

  it("counts every parent's gates exactly once (the all-children set is the union of the two render sites)", () => {
    // One child of the active parent (rendered inline) plus one child of an
    // inactive parent (rendered in the overlay) = two gates the user owes, each
    // counted ONCE. Deriving the number as `useChildGates(active).length + …`
    // is what double-counts; the pure core with a `null` parent cannot.
    useSessions.setState({ activeSessionId: "A" });
    useSubagents.getState().addSession({
      sessionId: "sub-of-A",
      parentSessionId: "A",
      agentName: "worker",
      task: "fix the failing test",
      status: "running",
    });
    useSubagents.getState().addSession({
      sessionId: "sub-of-B",
      parentSessionId: "B",
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });
    useInteractive.getState().addRequest("sub-of-A", {
      requestId: "r1",
      method: "ask",
      source: "subagent:worker",
      params: { question: "which library?" },
    });
    usePermissions.getState().addPrompt("sub-of-B", "p1", {
      toolCall: { title: "Run rm -rf" },
      options: [{ optionId: "allow_once", name: "Allow once" }],
    });
    const { result } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(2);
  });
});
