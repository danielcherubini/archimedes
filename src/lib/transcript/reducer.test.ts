import { describe, expect, it } from "vitest";
import {
  applySessionUpdate,
  extractDiffs,
  finalizeSessionMessages,
  mapStatus,
  rowToMessages,
} from "./reducer";
import { isStaleCompactionStart } from "./identity";
import type { AcpSessionUpdate, MessageRow } from "../tauri";
import type { Message } from "../../store/sessions";

describe("src/lib/transcript", () => {
  describe("mapStatus", () => {
    it("maps undefined, pending, and in_progress to pending", () => {
      expect(mapStatus(undefined)).toBe("pending");
      expect(mapStatus("pending" as any)).toBe("pending");
      expect(mapStatus("in_progress" as any)).toBe("pending");
    });

    it("maps completed and failed accurately", () => {
      expect(mapStatus("completed")).toBe("completed");
      expect(mapStatus("failed")).toBe("failed");
    });
  });

  describe("extractDiffs", () => {
    it("extracts diff entries and computes unified patch", () => {
      const diffs = extractDiffs([
        {
          type: "diff",
          path: "file.txt",
          oldText: "old content",
          newText: "new content",
        },
      ]);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].path).toBe("file.txt");
      expect(diffs[0].patch).toContain("old content");
      expect(diffs[0].patch).toContain("new content");
    });

    it("returns empty array for undefined or non-diff content", () => {
      expect(extractDiffs(undefined)).toEqual([]);
      expect(extractDiffs([{ type: "text", text: "hello" } as any])).toEqual([]);
    });
  });

  describe("applySessionUpdate — text delta appending", () => {
    it("appends consecutive chunks with the same messageId", () => {
      let messages: Message[] = [];
      const chunk1: AcpSessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg1",
        content: { type: "text", text: "Hello " },
      };
      const chunk2: AcpSessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg1",
        content: { type: "text", text: "world!" },
      };

      messages = applySessionUpdate(messages, chunk1, 100);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        kind: "agent-text",
        messageId: "msg1",
        text: "Hello ",
        at: 100,
      });

      messages = applySessionUpdate(messages, chunk2, 200);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        kind: "agent-text",
        messageId: "msg1",
        text: "Hello world!",
        at: 100,
      });
    });

    it("creates a new message when messageId changes", () => {
      let messages: Message[] = [];
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg1",
          content: { type: "text", text: "First" },
        },
        100,
      );
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg2",
          content: { type: "text", text: "Second" },
        },
        200,
      );

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ text: "First" });
      expect(messages[1]).toMatchObject({ text: "Second" });
    });
  });

  describe("applySessionUpdate & finalizeSessionMessages — tool call accumulation and status updates", () => {
    it("accumulates tool call creation and updates, tracking status through to failed", () => {
      let messages: Message[] = [];

      // Create tool call (in_progress -> pending)
      const callUpdate: AcpSessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Reading file",
        status: "in_progress",
        rawInput: { path: "test.ts" },
      };
      messages = applySessionUpdate(messages, callUpdate, 100);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: "tool-call",
        id: "call_1",
        title: "Reading file",
        status: "pending",
        rawInput: { path: "test.ts" },
      });

      // Update tool call to completed
      const completionUpdate: AcpSessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: "file content",
      };
      messages = applySessionUpdate(messages, completionUpdate, 150);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: "tool-call",
        id: "call_1",
        status: "completed",
        rawOutput: "file content",
      });

      // Another tool call that stays pending
      messages = applySessionUpdate(
        messages,
        {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "Writing file",
          status: "in_progress",
        },
        200,
      );

      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({ status: "pending" });

      // Finalize session messages: pending flips to failed, completed stays completed
      const finalized = finalizeSessionMessages(messages);
      expect(finalized[0]).toMatchObject({ status: "completed" });
      expect(finalized[1]).toMatchObject({ status: "failed" });
    });
  });

  describe("isStaleCompactionStart", () => {
    it("filters active compaction event when session is stalled", () => {
      const activeCompaction: AcpSessionUpdate = {
        sessionUpdate: "compaction_update",
        active: true,
        reason: "manual",
      };

      expect(isStaleCompactionStart(activeCompaction, true)).toBe(true);
      expect(isStaleCompactionStart(activeCompaction, false)).toBe(false);

      const inactiveCompaction: AcpSessionUpdate = {
        sessionUpdate: "compaction_update",
        active: false,
        reason: "manual",
      };
      expect(isStaleCompactionStart(inactiveCompaction, true)).toBe(false);
      expect(isStaleCompactionStart(inactiveCompaction, false)).toBe(false);

      const otherUpdate: AcpSessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      };
      expect(isStaleCompactionStart(otherUpdate, true)).toBe(false);
    });
  });

  describe("rowToMessages", () => {
    it("hydrates user row with text", () => {
      const row: MessageRow = {
        id: 1,
        sessionId: "s1",
        kind: "user",
        messageKey: null,
        payloadJson: JSON.stringify({ text: "Hello agent" }),
        createdAt: 1000,
      };
      const result = rowToMessages(row);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        kind: "user",
        text: "Hello agent",
        at: 1000,
      });
    });
  });
});
