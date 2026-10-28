import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { SubagentTranscript } from "./SubagentTranscript";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    respondPermission: vi.fn().mockResolvedValue(undefined),
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

describe("SubagentTranscript (the read-only session transcript, expanded inline in the directory row)", () => {
  it("renders the agent-text stream (visible by default — the expansion IS the detail view, no auto-collapse)", () => {
    useSubagents.getState().addSession(entry);
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the subagent" },
    });
    render(<SubagentTranscript sessionId="sub1" />);
    expect(screen.getByText("hello from the subagent")).toBeTruthy();
  });

  it("keeps the stream visible when the session finishes (no auto-collapse — the expansion is the detail view)", () => {
    useSubagents.getState().addSession(entry);
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello from the subagent" },
    });
    render(<SubagentTranscript sessionId="sub1" />);
    expect(screen.getByText("hello from the subagent")).toBeTruthy();
    act(() => {
      useSubagents.getState().markClosed("sub1", "completed", undefined, {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        durationMs: 100,
      });
    });
    // The entry is read FROM THE STORE — the `act` re-rendered the
    // transcript with the closed entry: the stream stays visible (the
    // stream is ALWAYS visible — the expansion IS the detail view) and the
    // metrics line appears.
    expect(screen.getByText("hello from the subagent")).toBeTruthy();
    // The metrics line now goes through the SHARED `formatDuration` (the rule
    // every other surface uses), so 100 ms renders `0.1s` — not the raw
    // `100 ms` this pin used to assert. Intentional user-visible change.
    expect(screen.getByText(/0\.1s/)).toBeTruthy();
  });

  it("renders a closed entry's metrics line from useSubagents (surviving useInteractive.dismissSession)", () => {
    useSubagents.getState().addSession(entry);
    useSubagents.getState().markClosed("sub1", "completed", undefined, {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      durationMs: 1234,
    });
    render(<SubagentTranscript sessionId="sub1" />);
    // The metrics line (the status word lives in the DIRECTORY row — the
    // transcript's header was dropped: the row IS the header).
    // `formatDuration(1234)` → `1s`: the shared formatter's `ms >= 1000` path
    // floors to whole seconds, so the raw `1234 ms` this pin used to assert is
    // gone. Intentional user-visible change (and a zero cost no longer prints
    // `$0.00` — `formatCost(0)` → `""`).
    expect(screen.getByText(/1s/)).toBeTruthy();
    // What this pins: the metrics line reads the `subagent-closed` SNAPSHOT in
    // `useSubagents`, so it is immune to the interactive store dropping the id.
    // (`dismissSession` is NOT what drops it today — no `session-closed` ever
    // names a child id, so it never runs for one; `SubagentEntry.metrics`' doc
    // in `src/store/subagents.ts` says why. The call below pins the store
    // contract regardless: whatever clears a session's slice of
    // `useInteractive`, the metrics line does not read that slice.)
    act(() => {
      useInteractive.getState().dismissSession("sub1");
    });
    expect(screen.getByText(/1s/)).toBeTruthy();
  });

  it("renders nothing for a never-priced child's cost (issue #107)", () => {
    // `SubagentMetrics.cost` is `number | null`: `null` = "no call reported a
    // cost". The transcript coalesces it to `0`, which `formatCost` renders as
    // `""`, and the `.filter(Boolean)` swallows the empty segment — so a
    // never-priced child prints NO `$` and, critically, NO dangling ` · `.
    // This is the "never-priced does not print `$0.00`" end of the rule, seen
    // from the transcript side (the card owns the `$0.00`-for-a-real-zero end).
    useSubagents.getState().addSession(entry);
    useSubagents.getState().markClosed("sub1", "completed", undefined, {
      inputTokens: 10,
      outputTokens: 2,
      cost: null,
      durationMs: 1234,
    });
    render(<SubagentTranscript sessionId="sub1" />);
    const line = screen.getByText(/1s/).textContent ?? "";
    expect(line).toContain("1s");
    expect(line).not.toContain("$");
    // No dangling separator: the absent cost left the join with three segments.
    expect(line).toBe("10 in · 2 out · 1s");
  });

  it("renders a failed entry's error", () => {
    useSubagents.getState().addSession({ ...entry, status: "failed" });
    useSubagents.getState().markClosed("sub1", "failed", "boom");
    render(<SubagentTranscript sessionId="sub1" />);
    // The error text (the status word lives in the DIRECTORY row).
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("renders NEITHER an ask card NOR a permission prompt for a child holding both (the transcript renders no gate at all)", () => {
    useSubagents.getState().addSession(entry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which color?",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<SubagentTranscript sessionId="sub1" />);
    // NEGATIVE PIN: `SubagentTranscript` renders NO gate of any kind — a
    // child's gate has exactly ONE site, and it is never this component (the
    // active parent's `ask`/permission go inline in the PARENT's transcript,
    // everything else to `SubagentModals`). A second site would put two
    // answerable copies of one gate on screen, and a gate rendered HERE and in
    // the overlay is a gate whose answer can arrive twice.
    expect(screen.queryByText("Which color?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Red" })).toBeNull();
    expect(screen.queryByText("Bash (apt install ripgrep)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("renders thinking (streaming — expanded)", () => {
    useSubagents.getState().addSession(entry);
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "pondering" },
      messageId: "m1",
    });
    render(<SubagentTranscript sessionId="sub1" />);
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("pondering")).toBeTruthy();
  });

  it("renders thinking (completed — auto-collapsed, the main-chat treatment)", () => {
    useSubagents.getState().addSession({ ...entry, status: "completed" });
    useSessions.getState().applySessionUpdate("sub1", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "done" },
      messageId: "m1",
    });
    render(<SubagentTranscript sessionId="sub1" />);
    // Completed reasoning auto-collapses (the SAME treatment as the main
    // chat column): the trigger is visible, the content is not.
    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText("done")).toBeNull();
  });
});
