import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessionStatus, useSessionStatuses } from "./useSessionStatus";
import { useSessions } from "../store/sessions";
import { usePermissions } from "../store/permissions";
import { useInteractive } from "../store/interactive";
import { useSubagents } from "../store/subagents";

const live = (sessionId: string) => ({
  sessionId,
  cwd: "/w",
  capabilities: {},
  archived: false,
});

beforeEach(() => {
  useSessions.setState({
    sessions: [],
    historySessions: [],
    archivedSessions: [],
    activeSessionId: null,
    inTurn: {},
    messages: {},
  });
  usePermissions.setState({ prompts: {} });
  useInteractive.setState({ requests: {} });
  // `useSubagents` feeds the child-gate half of the status. Without this reset
  // an entry added by one test leaks into the next and a `running` expectation
  // fails for a reason that looks unrelated (the same loop
  // `usePendingSubagentRequests.test.ts` runs).
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
});

/**
 * The rail's whole job is to say the same thing the row says, in less space —
 * so the derivation is ONE hook with two consumers (the open `SessionRow`'s
 * spinner + Waiting pill, and the collapsed rail's mark). These tests pin the
 * four states, because a rail that disagrees with the list it summarises is
 * worse than no rail.
 */
describe("useSessionStatus (one derivation, the list row AND the rail)", () => {
  const of = (id: string) => renderHook(() => useSessionStatus(id)).result.current;

  it("stored → stored (nothing live, nothing pending)", () => {
    useSessions.setState({ historySessions: [live("s1")] });
    expect(of("s1")).toBe("stored");
  });

  it("live → live (a live session not in a turn)", () => {
    useSessions.setState({ sessions: [live("s1")] });
    expect(of("s1")).toBe("live");
  });

  it("running → running (live AND in a turn — the row's spinner condition)", () => {
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    expect(of("s1")).toBe("running");
  });

  it("a turn without a live session is NOT running (an old flag on a closed session)", () => {
    // The row shows the spinner on `isLive && inTurn`; the rail must not invent
    // activity for a session that is gone.
    useSessions.setState({ historySessions: [live("s1")], inTurn: { s1: true } });
    expect(of("s1")).toBe("stored");
  });

  it("a pending permission prompt → waiting", () => {
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    usePermissions.setState({
      prompts: {
        s1: [{ requestId: "r1", toolTitle: "bash", options: [] }],
      },
    });
    // Waiting WINS over running: the session is not working, it is blocked on
    // the user, and that is the fact the cue exists to report.
    expect(of("s1")).toBe("waiting");
  });

  it("a pending ask/confirm/password → waiting", () => {
    useSessions.setState({ sessions: [live("s1")] });
    for (const method of ["ask", "confirm", "password"] as const) {
      act(() => {
        useInteractive.setState({
          requests: {
            s1: [{ requestId: "r1", method, source: "main", params: {} }],
          },
        });
      });
      expect(of("s1"), method).toBe("waiting");
    }
  });
});

/**
 * A parent blocked on its CHILD's gate is blocked ON THE USER, so its row and
 * its rail mark must read `waiting` — not the `running` its own `inTurn` flag
 * alone would give it. Both hooks are driven at the HOOK level (this file never
 * calls `sessionStatusOf` directly), because the rail's whole guarantee is that
 * it says what the row says.
 */
describe("a child's gate waits on its parent (row + rail)", () => {
  const row = (id: string) =>
    renderHook(() => useSessionStatus(id)).result.current;
  const rail = (ids: string[]) =>
    renderHook(() => useSessionStatuses(ids)).result.current;

  const childOf = (parentSessionId: string, childSessionId: string) =>
    useSubagents.getState().addSession({
      sessionId: childSessionId,
      parentSessionId,
      agentName: "reviewer",
      task: "review the diff",
      status: "running",
    });

  it("a live, in-turn parent whose child holds an `ask` is `waiting`, not `running`", () => {
    // The regression: the parent has NOTHING under its own id, so before
    // `childGateCount` it read `running` — claiming to work while it waited.
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    childOf("s1", "sub1");
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    expect(row("s1")).toBe("waiting");
  });

  it("the rail agrees with the row for a parent blocked on its child's gate", () => {
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    childOf("s1", "sub1");
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    expect(rail(["s1"])["s1"]).toBe("waiting");
  });

  it("a child's Permission prompt also waits on the parent (both stores, both hooks)", () => {
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    childOf("s1", "sub1");
    usePermissions.getState().addPrompt("sub1", "p1", {
      toolCall: { title: "Run rm -rf" },
      options: [{ optionId: "allow_once", name: "Allow once" }],
    });
    expect(row("s1")).toBe("waiting");
    expect(rail(["s1"])["s1"]).toBe("waiting");
  });

  it("a gate held by ANOTHER parent's child does not make this row wait", () => {
    // The count is PARENT-scoped (the dot stays app-wide; the row may not).
    // A naive "every child gate in the app" wiring fails here.
    useSessions.setState({
      sessions: [live("s1"), live("s2")],
      inTurn: { s1: true },
    });
    childOf("s2", "sub2");
    useInteractive.getState().addRequest("sub2", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    expect(row("s1")).toBe("running");
    expect(rail(["s1", "s2"])["s1"]).toBe("running");
    expect(rail(["s1", "s2"])["s2"]).toBe("waiting");
  });

  it("a parent whose child has NO `SubagentEntry` stays `running` (an unknown parent owns no row)", () => {
    // `childGatesOf` drops a gate whose child has no entry — the row must not
    // inherit some stranger's gate.
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    useInteractive.getState().addRequest("subX", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    expect(row("s1")).toBe("running");
    expect(rail(["s1"])["s1"]).toBe("running");
  });

  it("once the child answers, the parent stops waiting (row + rail)", () => {
    useSessions.setState({ sessions: [live("s1")], inTurn: { s1: true } });
    childOf("s1", "sub1");
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    expect(row("s1")).toBe("waiting");
    act(() => {
      useInteractive.getState().removeRequest("sub1", "r1");
    });
    expect(row("s1")).toBe("running");
    expect(rail(["s1"])["s1"]).toBe("running");
  });
});
