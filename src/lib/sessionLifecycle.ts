import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { discardSessionMessages, useSessions } from "../store/sessions";
import type { CloseReasonStr } from "./tauri";

export function onSessionClosed(sessionId: string, reason: CloseReasonStr): void {
  useInteractive.getState().dismissSession(sessionId);
  usePermissions.getState().dismissSessionPrompts(sessionId);
  useSessions.getState().handleSessionClosed(sessionId, reason);
  discardSessionMessages(sessionId);
}
