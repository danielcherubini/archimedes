/**
 * The `listen*` wrappers — register once in `App.tsx`, dispatch into the stores.
 *
 * Every event NAME comes from `IPC_EVENTS` (`../ipc/events.ts`): no body here
 * spells a bare event string, which is what `src/lib/ipc/events.test.ts` pins,
 * and the payload types all come from `../types.ts`.
 *
 * `respond_interactive_request` is the one function that reads like a neighbour
 * of these and is NOT here — it is an `invoke`, so it lives in
 * `./commands/gates.ts`. Grouping by transport, not by proximity, is what keeps
 * the events module a module.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IPC_EVENTS } from "../ipc/events";
import type {
  InteractiveEventPayload,
  InteractiveRequestClosePayload,
  InteractiveRequestPayload,
  PermissionRequestPayload,
  SessionClosedPayload,
  SessionTitledPayload,
  SessionUpdatePayload,
  StalledPayload,
  SubagentClosedPayload,
  SubagentSessionStartedPayload,
  WindowFrameState,
} from "./types";


// ---------------------------------------------------------------------------
// Events (listen) — register once in App.tsx and dispatch into the stores
// ---------------------------------------------------------------------------

export function listenSessionUpdate(
  callback: (payload: SessionUpdatePayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionUpdatePayload>(IPC_EVENTS.sessionUpdate, (event) =>
    callback(event.payload),
  );
}


export function listenSessionClosed(
  callback: (payload: SessionClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionClosedPayload>(IPC_EVENTS.sessionClosed, (event) =>
    callback(event.payload),
  );
}


export function listenSessionStalled(
  callback: (payload: StalledPayload) => void,
): Promise<UnlistenFn> {
  return listen<StalledPayload>(IPC_EVENTS.sessionStalled, (event) =>
    callback(event.payload),
  );
}


/**
 * A session's generated title (the naming pass's push). The PULL form is
 * `list_sessions` — which runs ONCE at boot, so a title generated in this
 * run reaches the sidebar ONLY through this event.
 */
export function listenSessionTitled(
  callback: (payload: SessionTitledPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionTitledPayload>(IPC_EVENTS.sessionTitled, (event) =>
    callback(event.payload),
  );
}


export function listenPermissionRequest(
  callback: (payload: PermissionRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen<PermissionRequestPayload>(IPC_EVENTS.permissionRequest, (event) =>
    callback(event.payload),
  );
}


export function listenInteractiveRequest(
  callback: (payload: InteractiveRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveRequestPayload>(IPC_EVENTS.interactiveRequest, (event) =>
    callback(event.payload),
  );
}


export function listenInteractiveRequestClose(
  callback: (payload: InteractiveRequestClosePayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveRequestClosePayload>(
    IPC_EVENTS.interactiveRequestClose,
    (event) => callback(event.payload),
  );
}


export function listenInteractiveEvent(
  callback: (payload: InteractiveEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveEventPayload>(IPC_EVENTS.interactiveEvent, (event) =>
    callback(event.payload),
  );
}


export function listenSubagentSessionStarted(
  callback: (payload: SubagentSessionStartedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SubagentSessionStartedPayload>(
    IPC_EVENTS.subagentSessionStarted,
    (event) => callback(event.payload),
  );
}


export function listenSubagentClosed(
  callback: (payload: SubagentClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SubagentClosedPayload>(IPC_EVENTS.subagentClosed, (event) =>
    callback(event.payload),
  );
}


export async function listenWindowState(
  handler: (payload: WindowFrameState) => void,
): Promise<() => void> {
  return listen<WindowFrameState>(IPC_EVENTS.windowStateChanged, (event) =>
    handler(event.payload),
  );
}
