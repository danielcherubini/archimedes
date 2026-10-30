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
 * The reason is a TEST SEAM, not taste. Many test files `vi.mock` `@/lib/tauri`
 * BY MODULE PATH (the exact count is pinned in `src/lib/tauriBarrel.test.ts` and
 * deliberately stated nowhere else — every prose copy of it has gone stale at
 * least once), and `vi.mock` intercepts only the calls that travel THROUGH the
 * path it was given. So a single direct import of a domain module makes the tests
 * that mocked that function stop intercepting it.
 *
 * HOW BADLY THAT SHOWS UP, measured rather than assumed, because the claim this
 * comment used to make ("invisible in a green suite") was too strong: importing
 * `saveSettings` from `tauri/commands/settings.ts` reddened **37 tests**, and
 * bypassing `shellSandboxAvailable` — a function no test asserts on directly —
 * still reddened one, through a render dependency. So when the bypassed function
 * is mocked, the suite usually does catch it. The case the suite CANNOT see is a
 * hand-rolled `invoke("…")` in a component, which touches no mock at all: that
 * passed the whole suite and `tsc`. Both are gated mechanically anyway, because
 * "usually caught" is not a property to build on —
 * `src/lib/tauriBarrel.test.ts` scans the import graph (test files included,
 * because a test that imports a domain module bypasses its own mock) and reddens
 * on the first direct import, and `src/lib/tauriBoundary.test.ts` reddens on any
 * Tauri wire import outside the IPC modules. The first file also pins this
 * module's export set to the names measured before the split, so a forgotten
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
  // (task07a / finding 4) The compaction trigger vocabulary. TYPE-ONLY — it
  // vanishes at runtime, so `TAURI_RUNTIME_API` does NOT gain it (the
  // `AccessRule`/`AccessDirection` precedent). The `compaction_update` frame's
  // `reason` field and the store's `compacting` value are both this union.
  CompactionReason,
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
  StalledPayload,
  PermissionRequestPayload,
  AskQuestionDto,
  AskResponsePayload,
  InteractiveRequestPayload,
  InteractiveEventPayload,
  InteractiveResponseDto,
  AgentNameResolution,
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
  AccessDirection,
  AccessRule,
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
  // (issue #101) The declared-`permission:` wire types. TYPE-ONLY — they vanish
  // at runtime, so `TAURI_RUNTIME_API` does NOT gain them (the
  // `AccessRule`/`AccessDirection` precedent).
  AgentFrontmatterNote,
  AgentPermissionAction,
  AgentPermissionBlock,
  AgentPermissionRule,
  AgentPermissionRules,
  AgentToolKey,
  AgentUnsupportedReason,
  McpServerInfo,
  ShadowedSkill,
  ShadowedAgent,
  SkillInfo,
  FileListDto,
  CompletionEntryDto,
  CompletionDirDto,
  HistoryPage,
  SessionRecency,
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
  sessionRecency,
  reorderSessions,
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
  reorderSpaces,
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
