import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";

/**
 * THE MEMOISATION PIN for `usePendingSubagentRequests`.
 *
 * Its sibling `useChildGates` is pinned the same way ("hands back the SAME array
 * on a re-render that changed no store"), but THIS hook returns a `number`, and a
 * number's identity means nothing — so the memo cannot be observed through the
 * return value at all. What CAN be observed is the work: the derivation is
 * `childGatesOf(…, null)`, which allocates a `ChildGate` object per gate and
 * sorts the result, and it runs on EVERY render of the hook's three callers —
 * one of which is `ChatStream`, re-rendered by every streamed token and every
 * composer keystroke (`useHasPendingRequest` → `ChatStream.tsx`,
 * `SidePane.tsx`, `SpacesList.tsx`).
 *
 * So the pure core is wrapped — delegating to the real implementation, so the
 * hook's ANSWER is untouched and every value pin in
 * `usePendingSubagentRequests.test.ts` still applies — and the pin counts how
 * many times it was asked to work.
 */
const derivations: number[] = [];

vi.mock("./useChildGates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useChildGates")>();
  return {
    ...actual,
    childGatesOf: (...args: Parameters<typeof actual.childGatesOf>) => {
      derivations.push(args[3] === null ? 1 : 0);
      return actual.childGatesOf(...args);
    },
  };
});

// Import AFTER the mock is registered (the pattern from
// `SessionConfigSelect.memo.test.tsx`).
import { usePendingSubagentRequests } from "./usePendingSubagentRequests";

const entry = {
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running" as const,
};

beforeEach(() => {
  derivations.length = 0;
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  useInteractive.getState().dismissSession("sub1");
  usePermissions.getState().dismissSessionPrompts("sub1");
});

describe("usePendingSubagentRequests (the derivation is memoised)", () => {
  it("does NOT re-derive on a render that changed no store, and still re-derives after a store write", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: { question: "which library?" },
    });
    const { result, rerender } = renderHook(() => usePendingSubagentRequests());
    expect(result.current).toBe(1);
    const atMount = derivations.length;
    expect(atMount).toBe(1);

    // A re-render with NO store write — `ChatStream` typing a character, or a
    // streamed token: the three store references are the same objects, so there
    // is nothing new to count and the derivation must not run again.
    rerender();
    rerender();
    expect(derivations.length, "two renders that changed no store re-derived the gate list").toBe(
      atMount,
    );
    expect(result.current).toBe(1);

    // A store write still re-derives: the memo keys on the store REFERENCES, it
    // does not freeze an answer past the write (the count is the cue the user
    // reads, so a stale one would be a lie).
    act(() => {
      useInteractive.getState().addRequest("sub1", {
        requestId: "r2",
        method: "password",
        source: "subagent:reviewer",
        params: { command: "apt install ripgrep", reason: "install the tool" },
      });
    });
    expect(derivations.length).toBeGreaterThan(atMount);
    expect(result.current).toBe(2);
  });
});
