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

export {
  getWindowState,
} from "./tauri/commands/window";

export {
  listenSessionUpdate,
  listenSessionClosed,
  listenSessionStalled,
  listenSessionTitled,
  listenPermissionRequest,
  listenInteractiveRequest,
  listenInteractiveRequestClose,
  listenInteractiveEvent,
  listenSubagentSessionStarted,
  listenSubagentClosed,
  listenWindowState,
} from "./tauri/events";
