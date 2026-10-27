import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { discardSessionMessages, useSessions } from "../store/sessions";
import type { CostUpdatePayload } from "../store/interactive";
import type { CloseReasonStr } from "./tauri";

export function onSessionClosed(sessionId: string, reason: CloseReasonStr): void {
  const board = useInteractive.getState().todos[sessionId];
  // THE MONEY IS READ HERE, BEFORE THE DISMISS, and it is the whole reason this
  // line sits this far from the call that consumes it: `dismissSession` below
  // DELETES `cost[sessionId]`, so any read after it sees nothing. The figure has
  // to be handed to `handleSessionClosed` because the row it files into
  // `historySessions` is the ONLY place a stored session's money lives once this
  // map is gone (`lib/sessionCost.ts`'s `costUsdOf` falls back to that row, and
  // the map hydrator that could refill the map runs only from Settings) — so a
  // figure that is not carried is a cost line that goes blank under a session the
  // `SidePane` is still rendering, until a reload. Issue #105; same shape as the
  // `board` capture on the line above and for the same reason.
  //
  // `?? undefined`, not a bare read: an entry holding `costUsd: null` is the live
  // "frames arrived, none carried a figure" REPORT (`CostUpdatePayload`'s D5
  // note), NOT a figure to file — and the persisted row may well hold a real
  // running total that a reload would show. Handing over `null` would either
  // wipe it or, worse, print nothing for money that exists.
  const closedEntry = useInteractive.getState()
    .cost[sessionId] as CostUpdatePayload | undefined;
  const closedCostUsd = closedEntry?.costUsd ?? undefined;
  useInteractive.getState().dismissSession(sessionId);
  if (board) {
    useInteractive.getState().applyTodoUpdate(sessionId, { todos: board });
  }
  usePermissions.getState().dismissSessionPrompts(sessionId);
  // ADR 0069: a reopened Session must not offer a Flush whose turn can never
  // arrive — the queue goes with the close, which is also what owns (and so
  // releases) the queued attachments' object URLs.
  useQueuedPrompts.getState().clearSession(sessionId);
  // A figure this run never produced is passed as NO THIRD ARGUMENT rather than
  // as `undefined`: `handleSessionClosed` treats an absent argument as "file the
  // row exactly as it stands", and `lib/sessionLifecycle.test.ts` pins this
  // call's argument list byte-for-byte (`toHaveBeenCalledWith(id, reason)`, which
  // a trailing explicit `undefined` fails). One call site, one shape.
  if (closedCostUsd === undefined) {
    useSessions.getState().handleSessionClosed(sessionId, reason);
  } else {
    useSessions.getState().handleSessionClosed(sessionId, reason, closedCostUsd);
  }
  discardSessionMessages(sessionId);
}
