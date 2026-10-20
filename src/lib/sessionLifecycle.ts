import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { discardSessionMessages, useSessions } from "../store/sessions";
import type { CloseReasonStr } from "./tauri";

export function onSessionClosed(sessionId: string, reason: CloseReasonStr): void {
  const board = useInteractive.getState().todos[sessionId];
  useInteractive.getState().dismissSession(sessionId);
  if (board) {
    useInteractive.getState().applyTodoUpdate(sessionId, { todos: board });
  }
  usePermissions.getState().dismissSessionPrompts(sessionId);
  useSessions.getState().handleSessionClosed(sessionId, reason);
  discardSessionMessages(sessionId);
}
