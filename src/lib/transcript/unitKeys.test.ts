import { describe, it, expect } from "vitest";
import type { Message } from "../sessionTypes";
import type { RenderUnit, ToolCallMessage } from "../toolGroups";
import {
  messageKey,
  unitKeys,
  unitContainsKey,
  prependedUnitCount,
} from "./unitKeys";

describe("unitKeys", () => {
  describe("messageKey", () => {
    it("returns tool:${id} for tool-call", () => {
      const msg: Message = {
        kind: "tool-call",
        id: "call_123",
        title: "bash",
        status: "completed",
        at: 100,
      };
      expect(messageKey(msg)).toBe("tool:call_123");
    });

    it("returns text:${messageId} for agent-text", () => {
      const msg: Message = {
        kind: "agent-text",
        messageId: "msg_456",
        text: "hello",
        at: 100,
      };
      expect(messageKey(msg)).toBe("text:msg_456");
    });

    it("returns thought:${messageId} for agent-thought", () => {
      const msg: Message = {
        kind: "agent-thought",
        messageId: "th_789",
        text: "pondering",
        at: 100,
      };
      expect(messageKey(msg)).toBe("thought:th_789");
    });

    it("returns diff:${path}:${at} for diff", () => {
      const msg: Message = {
        kind: "diff",
        path: "src/a.ts",
        patch: "@@ ...",
        at: 12345,
      };
      expect(messageKey(msg)).toBe("diff:src/a.ts:12345");
    });

    it("returns user:${at} for user", () => {
      const msg: Message = {
        kind: "user",
        text: "start",
        at: 54321,
      };
      expect(messageKey(msg)).toBe("user:54321");
    });
  });

  describe("unitKeys", () => {
    it("returns empty array for empty units", () => {
      expect(unitKeys([])).toEqual([]);
    });

    it("derives keys for single units and changes-group units", () => {
      const userMsg: Message = { kind: "user", text: "hi", at: 100 };
      const tool1: ToolCallMessage = {
        kind: "tool-call",
        id: "t1",
        title: "write",
        status: "completed",
        at: 101,
      };
      const tool2: ToolCallMessage = {
        kind: "tool-call",
        id: "t2",
        title: "edit",
        status: "completed",
        at: 102,
      };
      const textMsg: Message = {
        kind: "agent-text",
        messageId: "m1",
        text: "done",
        at: 103,
      };

      const units: RenderUnit[] = [
        { kind: "single", message: userMsg },
        { kind: "changes-group", messages: [tool1, tool2] },
        { kind: "single", message: textMsg },
      ];

      expect(unitKeys(units)).toEqual(["user:100", "tool:t1", "text:m1"]);
    });

    it("disambiguates duplicate keys with #1, #2 suffixes", () => {
      const user1: Message = { kind: "user", text: "one", at: 100 };
      const user2: Message = { kind: "user", text: "two", at: 100 };
      const user3: Message = { kind: "user", text: "three", at: 100 };

      const units: RenderUnit[] = [
        { kind: "single", message: user1 },
        { kind: "single", message: user2 },
        { kind: "single", message: user3 },
      ];

      expect(unitKeys(units)).toEqual(["user:100", "user:100#1", "user:100#2"]);
    });
  });

  describe("unitContainsKey", () => {
    it("matches single unit key", () => {
      const userMsg: Message = { kind: "user", text: "hi", at: 100 };
      const unit: RenderUnit = { kind: "single", message: userMsg };
      expect(unitContainsKey(unit, "user:100")).toBe(true);
      expect(unitContainsKey(unit, "user:200")).toBe(false);
    });

    it("matches changes-group if any message matches key", () => {
      const tool1: ToolCallMessage = {
        kind: "tool-call",
        id: "t1",
        title: "write",
        status: "completed",
        at: 101,
      };
      const tool2: ToolCallMessage = {
        kind: "tool-call",
        id: "t2",
        title: "edit",
        status: "completed",
        at: 102,
      };
      const unit: RenderUnit = { kind: "changes-group", messages: [tool1, tool2] };
      expect(unitContainsKey(unit, "tool:t1")).toBe(true);
      expect(unitContainsKey(unit, "tool:t2")).toBe(true);
      expect(unitContainsKey(unit, "tool:t3")).toBe(false);
    });
  });

  describe("prependedUnitCount", () => {
    it("returns 0 if prevFirstMessageKey is undefined or units empty", () => {
      expect(prependedUnitCount(undefined, [])).toBe(0);
      expect(prependedUnitCount("user:100", [])).toBe(0);
      const units: RenderUnit[] = [
        { kind: "single", message: { kind: "user", text: "hi", at: 100 } },
      ];
      expect(prependedUnitCount(undefined, units)).toBe(0);
    });

    it("returns index of matching unit when older items are prepended", () => {
      const older1: Message = { kind: "user", text: "old 1", at: 10 };
      const older2: Message = { kind: "user", text: "old 2", at: 20 };
      const prevFirst: Message = { kind: "user", text: "prev first", at: 100 };
      const later: Message = { kind: "agent-text", messageId: "m1", text: "later", at: 200 };

      const units: RenderUnit[] = [
        { kind: "single", message: older1 },
        { kind: "single", message: older2 },
        { kind: "single", message: prevFirst },
        { kind: "single", message: later },
      ];

      expect(prependedUnitCount("user:100", units)).toBe(2);
    });

    it("returns 0 if prevFirstMessageKey is already at index 0", () => {
      const prevFirst: Message = { kind: "user", text: "prev first", at: 100 };
      const later: Message = { kind: "agent-text", messageId: "m1", text: "later", at: 200 };

      const units: RenderUnit[] = [
        { kind: "single", message: prevFirst },
        { kind: "single", message: later },
      ];

      expect(prependedUnitCount("user:100", units)).toBe(0);
    });

    it("returns 0 if prevFirstMessageKey is not found in units", () => {
      const units: RenderUnit[] = [
        { kind: "single", message: { kind: "user", text: "a", at: 10 } },
        { kind: "single", message: { kind: "user", text: "b", at: 20 } },
      ];

      expect(prependedUnitCount("user:999", units)).toBe(0);
    });

    it("matches when prevFirstMessageKey was inside a changes-group", () => {
      const older: Message = { kind: "user", text: "old", at: 10 };
      const tool1: ToolCallMessage = {
        kind: "tool-call",
        id: "t1",
        title: "write",
        status: "completed",
        at: 101,
      };
      const tool2: ToolCallMessage = {
        kind: "tool-call",
        id: "t2",
        title: "edit",
        status: "completed",
        at: 102,
      };

      const units: RenderUnit[] = [
        { kind: "single", message: older },
        { kind: "changes-group", messages: [tool1, tool2] },
      ];

      expect(prependedUnitCount("tool:t2", units)).toBe(1);
    });
  });
});
