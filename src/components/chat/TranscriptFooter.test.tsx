import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TranscriptFooter, { transcriptFooterIsEmpty } from "./TranscriptFooter";
import type { PermissionPromptData } from "../../store/permissions";
import type { InteractiveRequestData } from "../../store/interactive";
import type { ChildGate } from "../../hooks/useChildGates";

vi.mock("../PermissionPrompt", () => ({
  default: ({ requestId }: { requestId: string }) => (
    <div data-testid={`prompt-${requestId}`}>prompt {requestId}</div>
  ),
}));

vi.mock("../AskQuestionCard", () => ({
  default: ({ requestId }: { requestId: string }) => (
    <div data-testid={`ask-${requestId}`}>ask {requestId}</div>
  ),
}));

vi.mock("../FileSummaryCard", () => ({
  default: ({ diffs }: { diffs: any[] }) => (
    <div data-testid="file-summary">{diffs.length} diffs</div>
  ),
}));

describe("TranscriptFooter", () => {
  const baseProps = {
    activeSessionId: "s1",
    prompts: [] as PermissionPromptData[],
    stackedAskRequests: [] as InteractiveRequestData[],
    childGates: [] as ChildGate[],
    turnDiffs: [] as { path: string; patch: string }[],
    stopReason: undefined,
    inTurn: false,
  };

  describe("transcriptFooterIsEmpty", () => {
    it("returns true when everything is empty and stopReason is undefined or end_turn", () => {
      expect(transcriptFooterIsEmpty(baseProps)).toBe(true);
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          stopReason: "end_turn",
        }),
      ).toBe(true);
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          inTurn: true,
          stopReason: "cancelled",
        }),
      ).toBe(true);
    });

    it("returns false if prompts are present", () => {
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          prompts: [
            {
              requestId: "p1",
              sessionId: "s1",
              tool: "bash",
              input: {},
            } as any,
          ],
        }),
      ).toBe(false);
    });

    it("returns false if interactive requests are present", () => {
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          stackedAskRequests: [
            {
              requestId: "a1",
              sessionId: "s1",
              question: "which?",
            } as any,
          ],
        }),
      ).toBe(false);
    });

    it("returns false if inline child gates are present", () => {
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          childGates: [
            {
              childSessionId: "c1",
              parentSessionId: "s1",
              agentName: "sub",
              kind: "ask",
              requestId: "r1",
              childStartedAt: 100,
            },
          ],
        }),
      ).toBe(false);
    });

    it("returns true if only non-inline child gates are present", () => {
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          childGates: [
            {
              childSessionId: "c1",
              parentSessionId: "s1",
              agentName: "sub",
              kind: "confirm",
              requestId: "r1",
              childStartedAt: 100,
            },
          ],
        }),
      ).toBe(true);
    });

    it("returns false if turnDiffs are present", () => {
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          turnDiffs: [{ path: "a.ts", patch: "@@" }],
        }),
      ).toBe(false);
    });

    it("returns false if not inTurn and stopReason is not end_turn", () => {
      expect(
        transcriptFooterIsEmpty({
          ...baseProps,
          stopReason: "cancelled",
        }),
      ).toBe(false);
    });
  });

  describe("rendering", () => {
    it("renders prompts, ask requests, inline child gates, turnDiffs, and stop reason", () => {
      const prompt: PermissionPromptData = {
        requestId: "p1",
        sessionId: "s1",
        tool: "bash",
        input: {},
      } as any;
      const ask: InteractiveRequestData = {
        requestId: "a1",
        sessionId: "s1",
        question: "q",
      } as any;
      const inlineGate: ChildGate = {
        childSessionId: "c1",
        parentSessionId: "s1",
        agentName: "explorer",
        kind: "ask",
        requestId: "cg1",
        childStartedAt: 100,
      };
      const modalGate: ChildGate = {
        childSessionId: "c2",
        parentSessionId: "s1",
        agentName: "worker",
        kind: "confirm",
        requestId: "cg2",
        childStartedAt: 100,
      };

      render(
        <TranscriptFooter
          {...baseProps}
          prompts={[prompt]}
          stackedAskRequests={[ask]}
          childGates={[inlineGate, modalGate]}
          turnDiffs={[{ path: "a.txt", patch: "..." }]}
          stopReason="max_tokens"
          inTurn={false}
        />,
      );

      expect(screen.getByTestId("prompt-p1")).toBeTruthy();
      expect(screen.getByTestId("ask-a1")).toBeTruthy();
      expect(screen.getByText("↳ explorer")).toBeTruthy();
      expect(screen.getByTestId("ask-cg1")).toBeTruthy();
      // modal gate should not render inline
      expect(screen.queryByText("↳ worker")).toBeNull();
      expect(screen.getByTestId("file-summary")).toBeTruthy();
      expect(screen.getByText("Turn ended: max_tokens")).toBeTruthy();
    });
  });
});
