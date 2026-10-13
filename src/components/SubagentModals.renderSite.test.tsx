import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { SubagentModals } from "./SubagentModals";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import { useSubagentSelection } from "../store/subagentSelection";

/**
 * THE STRUCTURAL PIN FOR THE PARTITION'S OTHER HALF.
 *
 * `SubagentModals`' card region is DEFINED as "the kinds `isInlineChildGate`
 * claims, for a parent that is not the active session" — the transcript's half,
 * minus the parent whose transcript is on screen. `SubagentModals.test.tsx`
 * pins the OUTCOME (which cards appear); this file pins the MECHANISM, which is
 * the thing that can rot silently: the overlay must obtain that set by ASKING
 * the one predicate `MessageList` filters its rows with, never by re-deriving it
 * from a local `kind` comparison.
 *
 * Why the mechanism needs its own test when the outcome is already pinned: with
 * today's four `ChildGateKind`s a hand-written `ask || permission` copy and the
 * shared predicate agree on every input, so NO input this file can build tells
 * them apart — until someone adds a fifth kind to `isInlineChildGate`. Then the
 * transcript starts drawing it, the copy keeps drawing only the old two, and
 * that kind renders in BOTH sites at once: two live cards of one request, two
 * divergent typed-but-unsubmitted drafts, an Esc that closes only one. Every
 * outcome assertion written against the old kinds would stay green while that
 * happened, which is exactly how this file earns its keep.
 *
 * So the predicate is wrapped (not replaced — it still answers from the real
 * implementation) and the overlay is asked to name its gates. Anything the
 * overlay decided on its own would show up as a gate that never passed through
 * the shared predicate.
 */
const seenByPredicate: string[] = [];

vi.mock("../hooks/useChildGates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useChildGates")>();
  return {
    ...actual,
    isInlineChildGate: (gate: Parameters<typeof actual.isInlineChildGate>[0]) => {
      // Pushed at CALL time (inside the wrapper, which only runs during a
      // render), never at factory time — the mock factory runs while this file's
      // imports are still being evaluated.
      seenByPredicate.push(gate.kind);
      return actual.isInlineChildGate(gate);
    },
  };
});

const entry = {
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running" as const,
};

beforeEach(() => {
  seenByPredicate.length = 0;
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  useInteractive.getState().dismissSession("sub1");
  usePermissions.getState().dismissSessionPrompts("sub1");
  useSessions.setState({ activeSessionId: "other", messages: {} });
  useSubagentSelection.getState().select(null);
});

describe("SubagentModals (the card half is asked, not re-derived)", () => {
  it("every gate the overlay classifies passes through `isInlineChildGate`", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r3",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });

    render(<SubagentModals />);

    // The render really happened (so this cannot pass on a component that drew
    // nothing and consulted nothing either).
    expect(screen.getByTestId("subagent-gate-overlay").textContent).toContain(
      "Which color?",
    );
    // Then a SECOND render, which this component is explicitly designed to take:
    // its selectors return the stores' own maps, so it re-renders on ANY
    // session's gate churn (the PERF note on the component calls this an accepted
    // trade). Unrelated session churn must not change the answer this pin gives.
    act(() => {
      useSessions.setState({ activeSessionId: "yet-another-session" });
    });
    expect(screen.getByTestId("subagent-gate-overlay").textContent).toContain(
      "Which color?",
    );
    // ALL FOUR kinds were classified by the SHARED predicate — including the
    // two that are NOT cards, because the exclusion is the predicate's answer,
    // not a local kind check that skipped them.
    //
    // DEDUPED ON PURPOSE. The claim is WHICH kinds went through the predicate,
    // and that is a SET question. The call log itself is per-render, so comparing
    // it as an array would silently add a second claim this file has no interest
    // in — "the overlay consulted the predicate exactly once per gate" — and
    // would go red pointing at nothing the moment the component legitimately
    // renders twice (a store reference changes, React re-invokes the render
    // function, and every gate is classified again). If that once-per-render
    // property is ever wanted, it needs its own test and its own reason.
    expect([...new Set(seenByPredicate)].sort()).toEqual([
      "ask",
      "confirm",
      "password",
      "permission",
    ]);
  });
});
