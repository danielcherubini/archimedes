import { unifiedPatch } from "../diff";
import type {
  AcpSessionUpdate,
  AcpToolCallStatus,
  MessageRow,
  ToolCallContent,
} from "../tauri";
import type { DiffRef, Message, ToolCallUiStatus } from "../../store/sessions";
import { diffMessages } from "./identity";

export function mapStatus(status: AcpToolCallStatus | undefined): ToolCallUiStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      // pending | in_progress | unknown → still open
      return "pending";
  }
}

/** Pull every `ToolCallContent::Diff` out of a tool call's content list. */
export function extractDiffs(content: ToolCallContent[] | undefined): DiffRef[] {
  if (!content) return [];
  const diffs: DiffRef[] = [];
  for (const item of content) {
    if (
      item.type === "diff" &&
      typeof item.path === "string" &&
      typeof item.newText === "string"
    ) {
      diffs.push({
        path: item.path,
        patch: unifiedPatch(item.path, item.oldText ?? null, item.newText),
      });
    }
  }
  return diffs;
}

/**
 * Pure reducer for `session-update` events: returns a NEW message array.
 *
 * - `agent_message_chunk`: appended to the trailing agent-text message with
 *   the same `messageId`; a new `messageId` (or an intervening non-text
 *   message) starts a new message — real agents emit several messages per
 *   turn, so we never just "append to the last agent-text".
 * - `agent_thought_chunk`: appended to the trailing agent-thought message with
 *   the same `messageId`; a new `messageId` (or an intervening non-thought
 *   message) starts a new message — same segmentation rules as agent-text.
 * - `tool_call` / `tool_call_update`: create/update the tool-call message;
 *   diffs inside the content are extracted into standalone diff messages
 *   (there is no dedicated file-edit update type).
 * - `message_retracted`: DROP every agent-text / agent-thought message that
 *   carries the retracted `messageId` (ADR 0048) — the only update that can
 *   SHRINK the array, and it returns the SAME reference when nothing matched.
 * - unknown update types: ignored (forward-compat).
 */
export function applySessionUpdate(
  messages: Message[],
  update: AcpSessionUpdate,
  at: number,
): Message[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content;
      if (!content || content.type !== "text" || typeof content.text !== "string") {
        return messages;
      }
      const text = content.text;
      if (text === "") return messages;
      const messageId = update.messageId ?? "default";
      const last = messages[messages.length - 1];
      if (last && last.kind === "agent-text" && last.messageId === messageId) {
        return [...messages.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...messages, { kind: "agent-text", messageId, text, at }];
    }

    case "agent_thought_chunk": {
      const content = update.content;
      if (!content || content.type !== "text" || typeof content.text !== "string") {
        return messages;
      }
      const text = content.text;
      if (text === "") return messages;
      const messageId = update.messageId ?? "default";
      const last = messages[messages.length - 1];
      if (last && last.kind === "agent-thought" && last.messageId === messageId) {
        return [...messages.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...messages, { kind: "agent-thought", messageId, text, at }];
    }

    case "message_retracted": {
      // (ADR 0048) The attempt behind this messageId was abandoned and its
      // reply retried under the SAME id (one message_start per message), so the
      // partial text must not weld onto the retry. Live thought messages carry
      // this id WITHOUT its `#seg` suffix too (the `#seg` is a persistence
      // detail), so this clears thoughts with the text. Bookkeeping lines are
      // never the abandoned id, so they survive: since ADR 0049 they read
      // `{stamp}:system` / `{stamp}:retract:N`, and the bare `system` /
      // `retract:N` shape is what a transcript written BEFORE ADR 0049 still
      // carries — both shapes reach this filter, which compares ids verbatim
      // and normalises nothing (a stamped reply is a different row from a bare
      // one, and from another incarnation's same-counter reply).
      const kept = messages.filter(
        (m) =>
          (m.kind !== "agent-text" && m.kind !== "agent-thought") ||
          m.messageId !== update.messageId,
      );
      // Same reference when nothing matched: silence must not read as a change.
      return kept.length === messages.length ? messages : kept;
    }

    case "tool_call": {
      const diffs = extractDiffs(update.content);
      const msg: Message = {
        kind: "tool-call",
        id: update.toolCallId,
        title: update.title ?? update.toolCallId,
        status: mapStatus(update.status),
        diff: diffs[0],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        at,
      };
      return [...messages, msg, ...diffMessages(diffs, at)];
    }

    case "tool_call_update": {
      const diffs = extractDiffs(update.content);
      const index = messages.findIndex(
        (m) => m.kind === "tool-call" && m.id === update.toolCallId,
      );
      if (index === -1) {
        // Update for a tool call we never saw: treat it as a new one.
        const msg: Message = {
          kind: "tool-call",
          id: update.toolCallId,
          title: update.title ?? update.toolCallId,
          status: mapStatus(update.status),
          diff: diffs[0],
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          at,
        };
        return [...messages, msg, ...diffMessages(diffs, at)];
      }
      const prev = messages[index];
      if (prev.kind !== "tool-call") return messages;
      const updated: Message = {
        ...prev,
        title: update.title ?? prev.title,
        status: update.status ? mapStatus(update.status) : prev.status,
        diff: diffs[0] ?? prev.diff,
        rawInput: update.rawInput ?? prev.rawInput,
        rawOutput: update.rawOutput ?? prev.rawOutput,
      };
      const next = [...messages];
      next[index] = updated;
      return [...next, ...diffMessages(diffs, at)];
    }

    default:
      return messages;
  }
}

/**
 * Session-closed cleanup: mark every still-pending tool call failed so the
 * transcript doesn't show a spinner forever.
 */
export function finalizeSessionMessages(messages: Message[]): Message[] {
  return messages.map((m) =>
    m.kind === "tool-call" && m.status === "pending"
      ? { ...m, status: "failed" as const }
      : m,
  );
}

/**
 * Map a persisted `MessageRow` back to transcript messages. A tool-call row
 * also re-derives its standalone diff messages (diffs are stored inside the
 * tool call's content, not as separate rows).
 */
export function rowToMessages(row: MessageRow): Message[] {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  switch (row.kind) {
    case "user": {
      if (typeof payload.text !== "string") return [];
      const rawImages = Array.isArray(payload.images) ? payload.images : [];
      const images = rawImages
        .filter(
          (img): img is Record<string, unknown> =>
            img !== null &&
            typeof img === "object" &&
            typeof (img as Record<string, unknown>).data === "string" &&
            typeof (img as Record<string, unknown>).mimeType === "string",
        )
        .map((img) => ({
          name: typeof img.name === "string" ? img.name : "",
          mimeType: img.mimeType as string,
          sizeBytes: typeof img.sizeBytes === "number" ? img.sizeBytes : 0,
          data: img.data as string,
        }));
      return [
        {
          kind: "user",
          text: payload.text,
          at: row.createdAt,
          ...(images.length > 0 ? { images } : {}),
        },
      ];
    }
    case "agent-text":
      // An empty text is a Retraction's overwrite (the display store has no
      // DELETE), never a real bubble — so an empty row hydrates as nothing.
      return typeof payload.text === "string" && payload.text !== ""
        ? [
            {
              kind: "agent-text",
              messageId: row.messageKey ?? "default",
              text: payload.text,
              at: row.createdAt,
            },
          ]
        : [];
    case "agent-thought":
      // Empty for the same reason as `agent-text` above (ADR 0048).
      return typeof payload.text === "string" && payload.text !== ""
        ? [
            {
              kind: "agent-thought",
              messageId: row.messageKey ?? "default",
              text: payload.text,
              at: row.createdAt,
            },
          ]
        : [];
    case "tool-call": {
      const id =
        typeof payload.toolCallId === "string"
          ? payload.toolCallId
          : (row.messageKey ?? "unknown");
      const title = typeof payload.title === "string" ? payload.title : id;
      const diffs = extractDiffs(
        payload.content as ToolCallContent[] | undefined,
      );
      const msg: Message = {
        kind: "tool-call",
        id,
        title,
        status: mapStatus(payload.status as AcpToolCallStatus | undefined),
        diff: diffs[0],
        rawInput: payload.rawInput,
        rawOutput: payload.rawOutput,
        at: row.createdAt,
      };
      return [
        msg,
        ...diffs.map((d) => ({
          kind: "diff" as const,
          path: d.path,
          patch: d.patch,
          at: row.createdAt,
        })),
      ];
    }
    default:
      return [];
  }
}
