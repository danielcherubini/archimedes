/**
 * Typed wrappers over the Tauri IPC surface (commands + events) implemented
 * in Rust (Tasks 2–3).
 *
 * Case conventions on the wire:
 * - command arguments: camelCase here (Tauri maps them to snake_case Rust
 *   parameters),
 * - `SessionInfo` (the `start_session` return value): camelCase
 *   (`sessionId`, `cwd`),
 * - event payloads: camelCase (`sessionId`, `requestId`),
 * - ACP update discriminators: snake_case (`agent_message_chunk`, …).
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS A RE-EXPORT BARREL. IT IS LOAD-BEARING — DO NOT "SIMPLIFY" IT.
 * ---------------------------------------------------------------------------
 *
 * The implementation is split by domain under `./tauri/` (the wire shapes, the
 * `invoke` commands, the `listen` events). This module re-exports all of it, and
 * it is the ONLY path anything outside `src/lib/tauri/` may import:
 *
 *     import { startSession } from "@/lib/tauri";                    // correct
 *     import { startSession } from "@/lib/tauri/commands/sessions";  // WRONG
 *
 * The reason is a TEST SEAM, not taste. 33 test files `vi.mock` `@/lib/tauri` BY
 * MODULE PATH (121 named `vi.fn()` overrides between them), and `vi.mock`
 * intercepts only the calls that travel THROUGH the path it was given. So a
 * single direct import of a domain module makes every test that mocked that
 * function **silently stop intercepting — and still pass, against real IPC.**
 * That failure is invisible in a diff and invisible in a green suite, so it is
 * gated mechanically: `src/lib/tauriBarrel.test.ts` scans the import graph
 * (test files included, because a test that imports a domain module bypasses its
 * own mock) and reddens on the first direct import. The same file pins this
 * module's export set to the 107 names measured before the split, so a forgotten
 * re-export cannot hide either.
 *
 * It is a PURE surface — no logic lives here. A function the split failed to
 * place belongs in a domain module, not back in this file.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IPC_EVENTS } from "./ipc/events";
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
} from "./tauri/types";

export type {
  SessionConfigSelectOption,
  SessionConfigSelectGroup,
  SessionConfigOption,
  SessionInfo,
  SpaceRow,
  SpaceCheck,
  CloseReasonStr,
  StopReason,
  PermissionOutcome,
  PermissionOption,
  PermissionRequest,
  AcpToolCallStatus,
  ContentBlock,
  ToolCallContent,
  AcpSessionUpdate,
  SessionUpdatePayload,
  SessionClosedPayload,
  StalledInfo,
  StalledPayload,
  PermissionRequestPayload,
  AskQuestionDto,
  AskResponsePayload,
  InteractiveRequestPayload,
  InteractiveEventPayload,
  InteractiveResponseDto,
  SubagentMetrics,
  SubagentSessionStartedPayload,
  SubagentClosedPayload,
  SubagentFailureReason,
  MessageRow,
  WireApi,
  ProviderConfig,
  KnownProvider,
  McpServerEntry,
  FontSettings,
  AccessPolicy,
  FilePolicy,
  WebSettings,
  AppSettings,
  ModelDto,
  AgentDefinitionDto,
  AgentOverride,
  AgentOverrides,
  OverrideSource,
  AgentOverrideFields,
  AgentOverrideSources,
  AgentConfigDto,
  McpServerInfo,
  ShadowedSkill,
  ShadowedAgent,
  SkillInfo,
  FileListDto,
  CompletionEntryDto,
  CompletionDirDto,
  HistoryPage,
  SessionTitledPayload,
  InteractiveRequestClosePayload,
  WindowFrameState,
} from "./tauri/types";

export {
  startSession,
  sendPrompt,
  compactSession,
  closeSession,
  resumeSession,
  cancelSession,
  setSessionConfigOption,
  listSessions,
  loadHistory,
  deleteSession,
  setSessionArchived,
} from "./tauri/commands/sessions";

export {
  readClipboardImage,
  readFileBytes,
} from "./tauri/commands/files";

export {
  getSettings,
  saveSettings,
  listModels,
  listTools,
  listKnownProviders,
  shellSandboxAvailable,
  testMcpServer,
  authMcpServer,
  testSearchProvider,
} from "./tauri/commands/settings";

export {
  listSpaces,
  deleteSpace,
  setSpaceTrusted,
  spaceForPath,
} from "./tauri/commands/spaces";

export {
  listSkills,
  listAgentDefinitionsForSpace,
  listAgentConfig,
  listMcpServersEffective,
  listSpaceFiles,
  listCompletionEntries,
} from "./tauri/commands/catalogs";

export {
  respondPermission,
  respondInteractiveRequest,
} from "./tauri/commands/gates";

export {
  attentionArm,
  attentionDisarm,
} from "./tauri/commands/attention";

export {
  externalOpen,
} from "./tauri/commands/external";


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


export async function getWindowState(): Promise<WindowFrameState> {
  return invoke<WindowFrameState>("get_window_state");
}


export async function listenWindowState(
  handler: (payload: WindowFrameState) => void,
): Promise<() => void> {
  return listen<WindowFrameState>(IPC_EVENTS.windowStateChanged, (event) =>
    handler(event.payload),
  );
}
