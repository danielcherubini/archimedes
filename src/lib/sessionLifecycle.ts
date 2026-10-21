import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { discardSessionMessages, useSessions } from "../store/sessions";
import type { CloseReasonStr } from "./tauri";

export function onSessionClosed(sessionId: string, reason: CloseReasonStr): void {
  const board = useInteractive.getState().todos[sessionId];
  useInteractive.getState().dismissSession(sessionId);
  if (board) {
    useInteractive.getState().applyTodoUpdate(sessionId, { todos: board });
  }
  usePermissions.getState().dismissSessionPrompts(sessionId);
  // ADR 0069: a reopened Session must not offer a Flush whose turn can never
  // arrive — the queue goes with the close, which is also what owns (and so
  // releases) the queued attachments' object URLs.
  useQueuedPrompts.getState().clearSession(sessionId);
  useSessions.getState().handleSessionClosed(sessionId, reason);
  discardSessionMessages(sessionId);
}
