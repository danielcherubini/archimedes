import { describe, expect, it } from "vitest";
import {
  estimateTokensFromMessages,
  extractTargetInfo,
  FAILURE_LABELS,
  getActivityDisplay,
  type ActivityRow,
} from "./subagentActivity";
import type { ToolCallUiStatus } from "../lib/sessionTypes";
import { makeMessage } from "../test/fixtures";

/**
 * The four pure derivations that lived inline in `SubagentDelegatingCard.tsx`.
 * They had NEVER been unit-tested — the only guard was the component render
 * test, which reaches them through the DOM and therefore only ever exercised
 * the arms a rendered row happens to hit. These tests pin the functions
 * directly, at the same time the code MOVES (Task A2) — every expectation below
 * was read off the moved source, and `SubagentDelegatingCard.test.tsx` stays the
 * behaviour-preservation guard for the render path.
 */

const user = (text: string, at = 0) => makeMessage("user", { text, at });
const agentText = (text: string, at = 0) =>
  makeMessage("agent-text", { text, at });
const agentThought = (text: string, at = 0) =>
  makeMessage("agent-thought", { text, at });
const toolCall = (
  title: string,
  status: ToolCallUiStatus,
  rawInput?: unknown,
  at = 0,
) => makeMessage("tool-call", { id: `t-${title}`, title, status, rawInput, at });
const diff = (patch: string, at = 0) => makeMessage("diff", { path: "a.ts", patch, at });

describe("extractTargetInfo (the subagent tool call's task / session targets)", () => {
  it("reads a TASK LIST from rawInput.tasks, keeping the string and object forms", () => {
    const info = extractTargetInfo(
      {
        tasks: [
          "review the diff",
          { task: "write the tests", agent: "tester", model: "claude:high", thinking: "high" },
          { note: "no task field — skipped" },
          "",
        ],
      },
      undefined,
    );
    expect(info.targetTasks).toEqual(["review the diff", "write the tests"]);
    expect(info.inputItems).toEqual([
      { task: "review the diff" },
      { task: "write the tests", agent: "tester", model: "claude:high", thinking: "high" },
    ]);
    expect(info.targetSessionIds).toEqual([]);
    expect(info.progressList).toEqual([]);
    expect(info.resultsList).toEqual([]);
    expect(info.details).toBeUndefined();
  });

  it("reads a SINGLE task from rawInput.task, carrying agent / model / thinking", () => {
    const info = extractTargetInfo(
      { task: "review the diff", agent: "reviewer", model: "claude:high", thinking: "low" },
      undefined,
    );
    expect(info.targetTasks).toEqual(["review the diff"]);
    expect(info.inputItems).toEqual([
      { task: "review the diff", agent: "reviewer", model: "claude:high", thinking: "low" },
    ]);
  });

  it("ignores a non-string task / agent / model / thinking instead of coercing them", () => {
    const info = extractTargetInfo({ task: 42 }, undefined);
    expect(info.targetTasks).toEqual([]);
    expect(info.inputItems).toEqual([]);
  });

  it("tolerates UNPARSEABLE input (a string, null, undefined) with empty collections", () => {
    for (const rawInput of ["not json", null, undefined, 7, []]) {
      const info = extractTargetInfo(rawInput, undefined);
      expect(info.targetTasks).toEqual([]);
      expect(info.targetSessionIds).toEqual([]);
      expect(info.inputItems).toEqual([]);
      expect(info.progressList).toEqual([]);
      expect(info.resultsList).toEqual([]);
      expect(info.details).toBeUndefined();
    }
  });

  it("harvests tasks + child session ids from the rawOutput details envelope", () => {
    const info = extractTargetInfo(
      { task: "review the diff" },
      {
        details: {
          progress: [{ task: "review the diff", status: "running" }, { task: "check the build" }],
          results: [
            { task: "review the diff", childSessionId: "sub1" },
            { childSessionId: "sub2" },
            { task: "", childSessionId: "" },
          ],
        },
      },
    );
    // Set-deduped: the single-task input and the progress row name the SAME task.
    expect(info.targetTasks).toEqual(["review the diff", "check the build"]);
    expect(info.targetSessionIds).toEqual(["sub1", "sub2"]);
    expect(info.progressList).toHaveLength(2);
    expect(info.resultsList).toHaveLength(3);
    expect(info.details).toBeTruthy();
  });

  it("falls back to empty lists when details.progress / results are not arrays", () => {
    const info = extractTargetInfo({}, { details: { progress: "nope", results: 5 } });
    expect(info.progressList).toEqual([]);
    expect(info.resultsList).toEqual([]);
  });
});

describe("estimateTokensFromMessages (the char/4 transcript estimate)", () => {
  it("is 0 for an empty transcript", () => {
    expect(estimateTokensFromMessages([])).toBe(0);
  });

  it("counts user / agent-text / agent-thought text and rounds the total by 4", () => {
    // 4 + 12 + 4 = 20 chars → 5
    expect(estimateTokensFromMessages([user("abcd"), agentText("hello world!"), agentThought("deep")])).toBe(5);
  });

  it("counts a tool call's rawInput and rawOutput (string or JSON-stringified object)", () => {
    // rawInput object {"a":1} → 7 chars; rawOutput string "12345" → 5 chars → 12/4 = 3
    expect(
      estimateTokensFromMessages([
        {
          kind: "tool-call",
          id: "t1",
          title: "bash",
          status: "completed",
          rawInput: { a: 1 },
          rawOutput: "12345",
          at: 0,
        },
      ]),
    ).toBe(3);
    // The string form measures the same 12 chars.
    expect(
      estimateTokensFromMessages([
        {
          kind: "tool-call",
          id: "t1",
          title: "bash",
          status: "completed",
          rawInput: '{"a":1}',
          rawOutput: "12345",
          at: 0,
        },
      ]),
    ).toBe(3);
  });

  it("counts a diff's patch and ignores a tool call with no payload", () => {
    expect(estimateTokensFromMessages([diff("12345678")])).toBe(2);
    expect(
      estimateTokensFromMessages([
        { kind: "tool-call", id: "t1", title: "bash", status: "pending", at: 0 },
      ]),
    ).toBe(0);
  });
});

describe("FAILURE_LABELS (the ADR 0055 short reason line)", () => {
  it("has exactly the four Rust enum values, with the blessed strings", () => {
    expect(FAILURE_LABELS).toEqual({
      unresponsive: "Unresponsive — no output for a long period",
      crashed: "Crashed",
      cancelled: "Cancelled",
      other: "Failed",
    });
  });
});

describe("getActivityDisplay (line 3 of a subagent row)", () => {
  it("renders the label for every SubagentFailureReason, and NEVER the error prose", () => {
    const prose = "subagent worker exited unexpectedly (code 137)";
    for (const [reason, label] of Object.entries(FAILURE_LABELS)) {
      const info = getActivityDisplay(
        {
          status: "failed",
          reason: reason as keyof typeof FAILURE_LABELS,
          error: prose,
        },
        undefined,
        0,
      );
      expect(info).toEqual({ glyph: "✗", text: label, colorClass: "text-destructive" });
    }
  });

  it("lets `reason` WIN over `error` when both exist (code over prose)", () => {
    const info = getActivityDisplay(
      { status: "failed", reason: "crashed", error: "unresponsive" },
      undefined,
      0,
    );
    expect(info?.text).toBe("Crashed");
  });

  it("falls back to `error` when there is no reason (a pre-`reason` payload)", () => {
    const info = getActivityDisplay(
      { status: "failed", error: "unresponsive" },
      undefined,
      0,
    );
    expect(info).toEqual({
      glyph: "✗",
      text: "unresponsive",
      colorClass: "text-destructive",
    });
  });

  it("falls through to Failed when a failed row carries neither reason nor error", () => {
    const info = getActivityDisplay({ status: "failed" }, undefined, 0);
    expect(info).toEqual({ glyph: "✗", text: "Failed", colorClass: "text-destructive" });
  });

  it("short-circuits a completed row to Done, even when a result is present", () => {
    // `status === "completed"` is checked BEFORE the result arm, so the result
    // never speaks for a completed row. Pinned because it is easy to "tidy" away.
    const info = getActivityDisplay(
      { status: "completed", result: { exitCode: 0, finalOutput: "ignored" } },
      undefined,
      0,
    );
    expect(info).toEqual({ glyph: "✓", text: "Done", colorClass: "text-success" });
  });

  it("shows the IN-FLIGHT tool call from the live transcript, with its elapsed duration", () => {
    const info = getActivityDisplay(
      { status: "running" },
      [toolCall("bash", "pending", { command: "ls -la" }, 1000)],
      6000,
    );
    expect(info).toEqual({
      glyph: "▸",
      text: "bash: ls -la",
      duration: " · 5s",
      colorClass: "text-foreground-subtle",
    });
  });

  it("wins the in-flight tool over a LATER message", () => {
    const info = getActivityDisplay(
      { status: "running" },
      [toolCall("bash", "pending", { command: "ls" }, 1000), agentText("later")],
      6000,
    );
    expect(info?.text).toBe("bash: ls");
  });

  it("has NO duration segment when the in-flight tool carries no stamp", () => {
    const info = getActivityDisplay(
      { status: "running" },
      [toolCall("bash", "pending", { command: "ls" }, 0)],
      6000,
    );
    expect(info?.duration).toBe("");
  });

  it("shows the LAST transcript message when nothing is in flight", () => {
    expect(
      getActivityDisplay({ status: "running" }, [agentText("first"), toolCall("read", "completed", { path: "src/a.ts" })], 0),
    ).toEqual({
      glyph: "✓",
      text: "read: src/a.ts",
      colorClass: "text-foreground-subtle",
    });
    expect(
      getActivityDisplay({ status: "running" }, [toolCall("read", "failed", { path: "src/a.ts" })], 0),
    ).toEqual({
      glyph: "✗",
      text: "read: src/a.ts",
      colorClass: "text-destructive",
    });
    expect(
      getActivityDisplay({ status: "running" }, [agentThought("one\n  \ntwo")], 0),
    ).toEqual({
      glyph: "▸",
      text: "[thinking] two",
      colorClass: "text-foreground-subtlest",
    });
    expect(getActivityDisplay({ status: "running" }, [agentText("one\ntwo")], 0)).toEqual({
      glyph: "▸",
      text: "two",
      colorClass: "text-foreground-subtlest",
    });
  });

  it("ignores a transcript whose last message has only blank lines and falls through", () => {
    const info = getActivityDisplay({ status: "running" }, [agentThought("  \n \n")], 0);
    expect(info).toEqual({
      glyph: "▸",
      text: "Starting...",
      colorClass: "text-foreground-subtlest",
    });
  });

  it("reads the CURRENT tool from the details progress envelope, with args + elapsed", () => {
    const info = getActivityDisplay(
      { status: "running", progress: { currentTool: "bash", currentToolArgs: "ls -la", currentToolStartedAt: 1000 } },
      undefined,
      6000,
    );
    expect(info).toEqual({
      glyph: "▸",
      text: "bash: ls -la",
      duration: " · 5s",
      colorClass: "text-foreground-subtle",
    });
  });

  it("reads the LAST progress tool call, string or object form", () => {
    expect(
      getActivityDisplay({ status: "running", progress: { toolCalls: ["read src/a.ts"] } }, undefined, 0),
    ).toEqual({ glyph: "✓", text: "read src/a.ts", colorClass: "text-foreground-subtle" });
    expect(
      getActivityDisplay(
        { status: "running", progress: { toolCalls: [{ name: "bash", argsPreview: "ls" }, { name: "edit", error: true }] } },
        undefined,
        0,
      ),
    ).toEqual({ glyph: "✗", text: "edit", colorClass: "text-destructive" });
    // A tool call with no name still says "tool".
    expect(
      getActivityDisplay({ status: "running", progress: { toolCalls: [{}] } }, undefined, 0),
    ).toEqual({ glyph: "✓", text: "tool", colorClass: "text-foreground-subtle" });
  });

  it("reads the last progress output line (recentOutput, then output)", () => {
    expect(
      getActivityDisplay({ status: "running", progress: { recentOutput: ["a", "b"] } }, undefined, 0),
    ).toEqual({ glyph: "▸", text: "b", colorClass: "text-foreground-subtlest" });
    expect(
      getActivityDisplay({ status: "running", progress: { output: "one\n  \ntwo" } }, undefined, 0),
    ).toEqual({ glyph: "▸", text: "two", colorClass: "text-foreground-subtlest" });
  });

  it("reads a result: its error, its last finalOutput line, or its exit code", () => {
    expect(
      getActivityDisplay({ status: "running", result: { exitCode: 1, error: "boom" } }, undefined, 0),
    ).toEqual({ glyph: "✗", text: "boom", colorClass: "text-destructive" });
    expect(
      getActivityDisplay(
        { status: "running", result: { exitCode: 0, finalOutput: "one\ntwo" } },
        undefined,
        0,
      ),
    ).toEqual({ text: "two", colorClass: "text-foreground-subtle" });
    expect(
      getActivityDisplay({ status: "running", result: { exitCode: 0 } }, undefined, 0),
    ).toEqual({ glyph: "✓", text: "Done", colorClass: "text-success" });
    expect(
      getActivityDisplay({ status: "running", result: { exitCode: 2 } }, undefined, 0),
    ).toEqual({ glyph: "✗", text: "Failed", colorClass: "text-destructive" });
  });

  it("says Starting... for a running row with nothing to show", () => {
    const info = getActivityDisplay({ status: "running" }, undefined, 0);
    expect(info).toEqual({
      glyph: "▸",
      text: "Starting...",
      colorClass: "text-foreground-subtlest",
    });
  });

  it("returns undefined for a status the derivations do not know", () => {
    // The `undefined` arm is only reachable with a status outside the three the
    // type allows — a backend that ships a new state. Pinned so the fall-through
    // stays a silent no-render rather than becoming a wrong "Done".
    const row: ActivityRow = { status: "queued" as unknown as ActivityRow["status"] };
    expect(getActivityDisplay(row, undefined, 0)).toBeUndefined();
  });
});
