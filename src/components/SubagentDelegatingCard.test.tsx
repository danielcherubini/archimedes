import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import SubagentDelegatingCard from "./SubagentDelegatingCard";
import { useSubagents } from "../store/subagents";
import { useSubagentSelection } from "../store/subagentSelection";
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import type { SubagentEntry } from "../store/subagents";
import { unmatchedAgentTooltip } from "../lib/subagentActivity";

const entry = (over: Partial<SubagentEntry>): SubagentEntry => ({
  sessionId: "sub1",
  parentSessionId: "main1",
  agentName: "reviewer",
  task: "review the diff",
  status: "running",
  startedAt: Date.now(),
  ...over,
});

beforeEach(() => {
  for (const id of Object.keys(useSubagents.getState().entries)) {
    useSubagents.getState().dismiss(id);
  }
  useSubagentSelection.getState().select(null);
  useInteractive.setState({ cost: {} });
});

describe("SubagentDelegatingCard (the subagent tool card with the nested list)", () => {
  it("renders a short structured reason line for a failed child (ADR 0055)", () => {
    // `reason` is the machine-readable why (`SubagentFailureReason`, snake_case
    // over the wire); `error` is the PARENT-FACING salvage prose the parent
    // model reads. The card is a one-line row: it renders the short label and
    // must NOT dump the prose.
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        status: "failed",
        error: "subagent worker exited unexpectedly (code 137)",
        reason: "crashed",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "review the diff" }}
        sessionId="main1"
      />,
    );
    expect(screen.getByText("Crashed")).toBeTruthy();
    expect(screen.queryByText(/subagent worker exited unexpectedly/)).toBeNull();
  });

  it("names the **Dead bound** in words, not the timeout prose", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        status: "failed",
        error: "unresponsive",
        reason: "unresponsive",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "review the diff" }}
        sessionId="main1"
      />,
    );
    expect(
      screen.getByText("Unresponsive — no output for a long period"),
    ).toBeTruthy();
    // The raw `error` wire text must never reach this row (the label comes from
    // `reason`). Asserting the CURRENT wire string keeps the pin real.
    expect(screen.queryByText("unresponsive")).toBeNull();
  });

  it("renders `Cancelled` for a cancelled child", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        status: "failed",
        error: "some prose the row must not show",
        reason: "cancelled",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "review the diff" }}
        sessionId="main1"
      />,
    );
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText("some prose the row must not show")).toBeNull();
  });

  it("renders `Failed` for the `other` reason (a preflight failure)", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        status: "failed",
        error: "spawn the subagent worker: no such file",
        reason: "other",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "review the diff" }}
        sessionId="main1"
      />,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText(/no such file/)).toBeNull();
  });

  it("falls back to `error` when the payload carries no `reason` (older backend)", () => {
    // `reason` is optional: a `subagent-closed` from a backend predating
    // ADR 0055 has only `error`, and showing nothing would hide the failure.
    useSubagents.getState().addSession(
      entry({ sessionId: "sub1", status: "failed", error: "boom" }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "review the diff" }}
        sessionId="main1"
      />,
    );
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("renders nested rows for subagents delegated in the tool call (name + task)", () => {
    useSubagents.getState().addSession(
      entry({ sessionId: "sub1", agentName: "reviewer", task: "review the diff" }),
    );
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub2",
        agentName: "explorer",
        task: "explore the codebase",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{
          tasks: [
            { task: "review the diff" },
            { task: "explore the codebase" },
          ],
        }}
        sessionId="main1"
      />,
    );
    // Both agent names + both tasks render (the card is OPEN by default).
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("review the diff")).toBeTruthy();
    expect(screen.getByText("explorer")).toBeTruthy();
    expect(screen.getByText("explore the codebase")).toBeTruthy();
  });

  it("does NOT show subagent entries from previous tool calls in the same parent session", () => {
    // S1 was dispatched in a previous tool call (Task 1)
    useSubagents.getState().addSession(
      entry({ sessionId: "sub1", agentName: "coder", task: "Task 1: UserPartyRestrictionDao fix" }),
    );
    // S2 was dispatched in a previous tool call (Task 2)
    useSubagents.getState().addSession(
      entry({ sessionId: "sub2", agentName: "coder", task: "Task 2: SqlLikeEscaper utility" }),
    );
    // S3 is dispatched in the current tool call (Task 3)
    useSubagents.getState().addSession(
      entry({ sessionId: "sub3", agentName: "coder", task: "Task 3: ClaimHeaderAutoDao registration" }),
    );

    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "Task 3: ClaimHeaderAutoDao registration" }}
        sessionId="main1"
      />,
    );

    // Only Task 3 from this tool call must be displayed (header + nested row)
    expect(screen.getAllByText("Task 3: ClaimHeaderAutoDao registration")).toHaveLength(2);
    expect(screen.queryByText("Task 1: UserPartyRestrictionDao fix")).toBeNull();
    expect(screen.queryByText("Task 2: SqlLikeEscaper utility")).toBeNull();
  });

  it("renders model, thinking level, and tokens/stats in the metadata line (no redundant 'running' text)", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "reviewer",
        task: "review the diff",
        model: "anthropic/claude-3-7-sonnet",
        thinkingLevel: "high",
        status: "running",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "review the diff" }}
        sessionId="main1"
        rawOutput={{
          details: {
            progress: [
              {
                agent: "reviewer",
                task: "review the diff",
                status: "running",
                model: "claude-3-7-sonnet",
                tokens: 15400,
                percent: 8,
                currentTool: "read",
                currentToolArgs: "docs/foo.md",
              },
            ],
          },
        }}
      />,
    );

    // Shows model and formatted thinking indicator
    expect(screen.getByText("claude-3-7-sonnet")).toBeTruthy();
    expect(screen.getByText("◕ high")).toBeTruthy();
    // Shows context percentage / tokens
    expect(screen.getByText("15.4k tok (8%)")).toBeTruthy();
    // Does NOT render "running" chip text
    expect(screen.queryByText("running")).toBeNull();
  });

  it("reads live accumulated cost and tokens from useInteractive.cost", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "coder",
        task: "Task 5: UserDao case normalization",
        status: "running",
        model: "protector/gemini-3.8-flash",
      }),
    );

    useInteractive.getState().applyCost("sub1", {
      inputTokens: 25000,
      outputTokens: 5000,
      cost: 0.035,
    });

    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "Task 5: UserDao case normalization" }}
        sessionId="main1"
      />,
    );

    // Shows 30k tokens with calculated 3% context window for Gemini (1M context) and cost
    expect(screen.getByText("30k tok (3%)")).toBeTruthy();
    expect(screen.getByText("$0.04")).toBeTruthy();
  });

  it("renders NO rows for entries whose parentSessionId does not match", () => {
    useSubagents.getState().addSession(
      entry({ sessionId: "sub1", parentSessionId: "other-main" }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        sessionId="main1"
      />,
    );
    expect(screen.queryByText("reviewer")).toBeNull();
    expect(screen.queryByText("review the diff")).toBeNull();
  });

  it("renders the empty state when there are no matching entries", () => {
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        sessionId="main1"
      />,
    );
    expect(screen.getByText("No subagents yet.")).toBeTruthy();
  });

  it("updates the activity preview live when the tool call's details change", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        task: "review the diff",
        status: "running",
      }),
    );
    const { rerender } = render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        sessionId="main1"
        rawInput={{ task: "review the diff" }}
        rawOutput={{
          details: {
            progress: [
              {
                agent: "reviewer",
                task: "review the diff",
                status: "running",
                currentTool: "read",
                currentToolArgs: "docs/foo.md",
              },
            ],
          },
        }}
      />,
    );
    // The one-line activity renders for the matching entry.
    expect(screen.getByText("read: docs/foo.md")).toBeTruthy();
    // The details change (a new tool) → the preview re-renders.
    rerender(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        sessionId="main1"
        rawInput={{ task: "review the diff" }}
        rawOutput={{
          details: {
            progress: [
              {
                agent: "reviewer",
                task: "review the diff",
                status: "running",
                currentTool: "grep",
                currentToolArgs: "TODO",
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("grep: TODO")).toBeTruthy();
    expect(screen.queryByText("read: docs/foo.md")).toBeNull();
  });

  it("clicking a row selects the subagent in useSubagentSelection", () => {
    useSubagents.getState().addSession(
      entry({ sessionId: "sub1", task: "review the diff" }),
    );
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub2",
        agentName: "explorer",
        task: "explore the codebase",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{
          tasks: [
            { task: "review the diff" },
            { task: "explore the codebase" },
          ],
        }}
        sessionId="main1"
      />,
    );
    // Nothing is selected yet.
    expect(useSubagentSelection.getState().selectedSessionId).toBeNull();
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Open reviewer transcript" }),
      );
    });
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub1");
    // Selecting another row replaces the selection.
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Open explorer transcript" }),
      );
    });
    expect(useSubagentSelection.getState().selectedSessionId).toBe("sub2");
  });

  it("renders live tool duration and tool calls in the activity line", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "coder",
        task: "run tests",
        status: "running",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "run tests" }}
        sessionId="main1"
        rawOutput={{
          details: {
            progress: [
              {
                agent: "coder",
                task: "run tests",
                status: "running",
                currentTool: "bash",
                currentToolArgs: "cargo test",
                currentToolStartedAt: Date.now() - 4000,
              },
            ],
          },
        }}
      />,
    );

    // Shows current tool and args
    expect(screen.getByText("bash: cargo test")).toBeTruthy();
    // Shows live duration in the activity line
    expect(screen.getByText("· 4s")).toBeTruthy();
  });

  it("renders completed Done status in activity line when finished", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "coder",
        task: "run tests",
        status: "completed",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "run tests" }}
        sessionId="main1"
        rawOutput={{
          details: {
            results: [
              {
                agent: "coder",
                task: "run tests",
                childSessionId: "sub1",
                exitCode: 0,
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("falls back to 'subagent' when agent name is empty string or absent", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "",
        task: "Task 5: UserDao case normalization",
        status: "running",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "Task 5: UserDao case normalization", agent: "" }}
        sessionId="main1"
      />,
    );

    expect(screen.getByText("subagent")).toBeTruthy();
    expect(screen.getAllByText("Task 5: UserDao case normalization")).toHaveLength(2);
  });

  it("reads live tool activity directly from subagent's session transcript in useSessions", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "coder",
        task: "Task 5: UserDao case normalization",
        status: "running",
      }),
    );

    // Populate subagent's session messages with an active tool call
    useSessions.setState({
      messages: {
        sub1: [
          {
            kind: "tool-call",
            id: "tc1",
            title: "read",
            status: "pending",
            rawInput: { path: "src/UserDao.java" },
            at: Date.now() - 3000,
          },
        ],
      },
    });

    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "Task 5: UserDao case normalization" }}
        sessionId="main1"
      />,
    );

    // Resolves tool call from useSessions messages
    expect(screen.getByText("read: src/UserDao.java")).toBeTruthy();
    expect(screen.getByText("· 3s")).toBeTruthy();
  });

  it("reads thinking activity from subagent's session transcript in useSessions", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "coder",
        task: "Task 5: UserDao case normalization",
        status: "running",
      }),
    );

    useSessions.setState({
      messages: {
        sub1: [
          {
            kind: "agent-thought",
            messageId: "m1",
            text: "Analyzing database query case sensitivity\nChecking UserDao implementation",
            at: Date.now() - 1000,
          },
        ],
      },
    });

    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "Task 5: UserDao case normalization" }}
        sessionId="main1"
      />,
    );

    expect(screen.getByText("[thinking] Checking UserDao implementation")).toBeTruthy();
  });
});

/**
 * D3 — the two row derivations must agree.
 *
 * Until this task the card built its rows TWICE: the `taskKeys.map` block and a
 * second `matchingStoreEntries.map` block with its own, DRIFTED copy of every
 * `??` chain. The second block only runs when the first produced no key at all,
 * which in practice means "the store entry carries no `task`" — so one child,
 * reached through the two derivations, rendered different numbers.
 *
 * These tests drive the SAME delegation (same child, same metrics, same tool
 * envelope) through both derivations and pin that the metadata line is now the
 * SAME string. The session ids are unique to this block: the file has no
 * `useSessions` reset, and the metadata line reads that store.
 */
describe("SubagentDelegatingCard (D3: one row derivation, no drift)", () => {
  const METRICS = { inputTokens: 500, outputTokens: 400, cost: 0.02, durationMs: 5000 };

  const metadataLine = () => {
    const lines = Array.from(
      document.querySelectorAll("div.font-mono.text-ui-xs"),
    ).map((n) => n.textContent);
    expect(lines).toHaveLength(1);
    return lines[0];
  };

  const child = (over: Partial<SubagentEntry>) =>
    useSubagents.getState().addSession(
      entry({
        sessionId: "d3-child",
        agentName: "coder",
        task: "run tests",
        status: "running",
        model: "protector/gemini-3.8-flash",
        ...over,
      }),
    );

  beforeEach(() => {
    for (const id of Object.keys(useSubagents.getState().entries)) {
      useSubagents.getState().dismiss(id);
    }
    useInteractive.setState({ cost: {} });
  });

  /**
   * The `progressSummary.tokens` arm: `result.usage` is absent and the child's
   * `subagent-closed` metrics snapshot says 900, so the two chains disagree on
   * which number the row prints. The `taskKeys` chain reads `progressSummary`
   * and wins 700; the `matchingStoreEntries` chain skipped that arm and fell
   * through to the snapshot, printing 900.
   */
  it("reads result.progressSummary.tokens when the row comes from the tool envelope", () => {
    child({ sessionId: "d3-env" });
    useSubagents.getState().markClosed("d3-env", "completed", undefined, METRICS);
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawInput={{ task: "run tests" }}
        rawOutput={{
          details: {
            results: [
              {
                agent: "coder",
                task: "run tests",
                childSessionId: "d3-env",
                exitCode: 0,
                progressSummary: { tokens: 700 },
              },
            ],
          },
        }}
        sessionId="main1"
      />,
    );
    expect(metadataLine()).toBe("protector/gemini-3.8-flash·700 tok (0.1%)·5s·$0.02");
  });

  it("reads the same tokens when the row comes from the store entry alone", () => {
    // The same child and the same envelope, but the store entry carries no
    // `task` and the envelope addresses the child by `childSessionId` only —
    // the one shape that used to fall through to the SECOND derivation.
    child({ sessionId: "d3-orphan", task: "" });
    useSubagents.getState().markClosed("d3-orphan", "completed", undefined, METRICS);
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="completed"
        rawOutput={{
          details: {
            results: [
              {
                agent: "coder",
                childSessionId: "d3-orphan",
                exitCode: 0,
                progressSummary: { tokens: 700 },
              },
            ],
          },
        }}
        sessionId="main1"
      />,
    );
    // IDENTICAL to the envelope-driven row above — one derivation, one answer.
    expect(metadataLine()).toBe("protector/gemini-3.8-flash·700 tok (0.1%)·5s·$0.02");
  });

  it("still renders a row for a store entry that carries no task", () => {
    // The ONLY job the deleted second derivation did in anger: a delegation
    // with no `task` produces no task key, so it must still get a row.
    child({ sessionId: "d3-blank", task: "" });
    render(
      <SubagentDelegatingCard title="subagent" status="pending" sessionId="main1" />,
    );
    expect(screen.getByRole("button", { name: "Open coder transcript" })).toBeTruthy();
  });

  it("renders no rows and the empty state when nothing was delegated", () => {
    render(
      <SubagentDelegatingCard title="subagent" status="pending" sessionId="main1" />,
    );
    expect(screen.getByText("No subagents yet.")).toBeTruthy();
  });
});

/**
 * D4 (issue #47) — a name that matched no Agent definition is VISIBLE.
 *
 * `subagent({ agentName: "reviewr" })` is a typo in a correctly-spelled key, so
 * nothing else in the app announces it: T9's checker fires on unknown KEYS, and
 * `agentName` is a known one. `resolve_launch` still hands back the launch
 * verbatim (ADR 0020) and the child still runs — so the row must gain ONE quiet
 * caption and change NOTHING else: not the name, not the status glyph, not the
 * metadata line, not the click handler.
 *
 * The second case is the half that keeps the tri-state a tri-state: `"no_name"`
 * is ADR 0020's DELIBERATE config-less dispatch, and a UI that flags it is a new
 * bug. An absent field (an older backend) renders today's output too.
 */
describe("SubagentDelegatingCard (the resolve-miss marker, issue #47)", () => {
  it("renders the resolve-miss caption for an unmatched name, and everything else unchanged", () => {
    useSubagents.getState().addSession(
      entry({
        sessionId: "sub1",
        agentName: "reviewr",
        nameResolution: "unmatched",
      }),
    );
    render(
      <SubagentDelegatingCard
        title="subagent"
        status="pending"
        rawInput={{ task: "review the diff", agent: "reviewr" }}
        sessionId="main1"
      />,
    );
    expect(screen.getByText("no matching Agent")).toBeTruthy();
    // The tooltip is the SHARED sentence, asserted THROUGH the helper
    // (issue #47 review): the point of `unmatchedAgentTooltip` is that the
    // directory row and the transcript sheet cannot carry different words, so
    // a literal here would re-create the copy it replaces. The sentence itself
    // is pinned verbatim in `subagentActivity.test.ts`.
    expect(screen.getByText("no matching Agent").getAttribute("title")).toBe(
      unmatchedAgentTooltip("reviewr"),
    );
    // ADDITIVE: the name is never replaced by the marker.
    expect(screen.getByText("reviewr")).toBeTruthy();
    // Click-to-open survives — the caption sits INSIDE the `<Button>`, and the
    // explicit `aria-label` wins the accname computation, so the accessible
    // name is unchanged.
    expect(
      screen.getByRole("button", { name: "Open reviewr transcript" }),
    ).toBeTruthy();
    // The status glyph is UNCHANGED: the child is running, not failed — a miss
    // never fails a dispatch.
    expect(document.querySelector("svg.animate-spin")).toBeTruthy();
    expect(screen.queryByText("Crashed")).toBeNull();
  });

  it("renders NOTHING extra for a matched name, a config-less dispatch, or an older payload", () => {
    // Three arms, one assertion each. `matched` is a working dispatch;
    // `no_name` is the DELIBERATE config-less case (flagging it would be the
    // bug the tri-state exists to prevent); the absent field is a backend that
    // predates it, which must render exactly what it rendered before.
    for (const over of [
      { nameResolution: "matched" as const },
      { nameResolution: "no_name" as const },
      {},
    ]) {
      for (const id of Object.keys(useSubagents.getState().entries)) {
        useSubagents.getState().dismiss(id);
      }
      useSubagents.getState().addSession(
        entry({ sessionId: "sub1", agentName: "reviewr", ...over }),
      );
      const { unmount } = render(
        <SubagentDelegatingCard
          title="subagent"
          status="pending"
          rawInput={{ task: "review the diff", agent: "reviewr" }}
          sessionId="main1"
        />,
      );
      expect(screen.queryByText("no matching Agent")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Open reviewr transcript" }),
      ).toBeTruthy();
      unmount();
    }
  });
});
