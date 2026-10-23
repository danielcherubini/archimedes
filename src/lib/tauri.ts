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
import { describeIpcError } from "./ipcError";
import type {
  AgentConfigDto,
  AgentDefinitionDto,
  AppSettings,
  CompletionDirDto,
  FileListDto,
  InteractiveEventPayload,
  InteractiveRequestClosePayload,
  InteractiveRequestPayload,
  InteractiveResponseDto,
  KnownProvider,
  McpServerEntry,
  McpServerInfo,
  ModelDto,
  PermissionOutcome,
  PermissionRequestPayload,
  SessionClosedPayload,
  SessionTitledPayload,
  SessionUpdatePayload,
  SkillInfo,
  SpaceCheck,
  SpaceRow,
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


export async function respondPermission(
  sessionId: string,
  requestId: string,
  outcome: PermissionOutcome,
): Promise<void> {
  return invoke("respond_permission", { sessionId, requestId, outcome });
}


/**
 * The current system-clipboard image (if any) as PNG bytes.
 *
 * WebKitGTK's `paste` event does not expose clipboard images as
 * `DataTransfer` file items (`items`/`files` are empty for a pasted image —
 * verified on webkit2gtk-4.1 2.52.5 on Wayland), so the composer reads the
 * image from the system clipboard directly (Rust/arboard) as a fallback.
 * `null` when the clipboard has no image (text-only or empty).
 */
export async function readClipboardImage(): Promise<number[] | null> {
  return invoke<number[] | null>("read_clipboard_image");
}


/**
 * A picked file's bytes (the `+` file picker's read — the webview cannot
 * read an arbitrary local path itself; a dialog selection is a PATH, not
 * a `File`). `null` when the file is not a supported image (the picker's
 * allowlist — the frontend skips it silently); a rejected Promise when
 * the file cannot be read (e.g. over the 10 MiB cap — the composer shows
 * it on its error line).
 */
export async function readFileBytes(path: string): Promise<number[] | null> {
  return invoke<number[] | null>("read_file_bytes", { path });
}


export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}


export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke("save_settings", { settings });
}


/** The effective catalog's models (the Default-model select + provider discovery status). `forceRefresh` = a provider id whose discovery cache is bypassed. */
export async function listModels(forceRefresh?: string): Promise<ModelDto[]> {
  return invoke("list_models", { forceRefresh: forceRefresh ?? null });
}


/** The native harness's tool names, sorted (the Settings page's enabled-tools checkbox list). */
export async function listTools(): Promise<string[]> {
  return invoke<string[]>("list_tools");
}


/** The known-providers catalog (the Settings' picker's data source — ADR 0024). */
export async function listKnownProviders(): Promise<KnownProvider[]> {
  return invoke<KnownProvider[]>("list_known_providers");
}


/**
 * (ADR 0030) Whether a `Sandboxed` shell can actually be confined HERE:
 * Linux + a kernel that enforces Landlock. `false` means every confined
 * command FAILS CLOSED, so the Settings page greys the tier out and says
 * why (it is the same signal the executor checks — the UI can never offer
 * a choice that only produces errors).
 */
export async function shellSandboxAvailable(): Promise<boolean> {
  return invoke<boolean>("shell_sandbox_available");
}


/** Test ONE MCP server entry (the Settings page's Test action, ADR 0019): a one-shot bounded connect + `tools/list`. Resolves the tool count; rejects with the error text (a `needs-auth` / a network failure). */
export async function testMcpServer(entry: McpServerEntry, name?: string): Promise<number> {
  return invoke("test_mcp_server", { name: name ?? null, entry });
}


/** Run interactive OAuth authentication for an MCP server (the Settings page's Sign in action). */
export async function authMcpServer(name: string, entry: McpServerEntry): Promise<string> {
  return invoke("auth_mcp_server", { name, entry });
}


/** Test ONE Search provider (Settings → Web search): one canned query, reporting the hit count or error. */
export async function testSearchProvider(provider: string, settings: AppSettings): Promise<number> {
  return invoke("test_search_provider", { provider, settings });
}


// ---------------------------------------------------------------------------
// Spaces commands (boot, the new-session dialog, "forget this space")
// ---------------------------------------------------------------------------

/** All spaces, most recently opened first. */
export async function listSpaces(): Promise<SpaceRow[]> {
  return invoke<SpaceRow[]>("list_spaces");
}


/** "Forget this space": delete the bookkeeping row (conversations stay stored). */
export async function deleteSpace(path: string): Promise<void> {
  return invoke("delete_space", { path });
}


/** Flip a space's trusted flag (no-op for a missing row). */
export async function setSpaceTrusted(path: string, trusted: boolean): Promise<void> {
  return invoke("set_space_trusted", { path, trusted });
}


/** Canonicalize a folder and say whether a space row already exists for it. */
export async function spaceForPath(path: string): Promise<SpaceCheck> {
  return invoke<SpaceCheck>("space_for_path", { path });
}


/** The skill catalog for a Space (`null` = user-level skills only). */
export async function listSkills(spacePath: string | null): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("list_skills", { spacePath: spacePath ?? null });
}


/** The agent-definition catalog for a Space (`null` = user-level only). */
export async function listAgentDefinitionsForSpace(spacePath: string | null): Promise<AgentDefinitionDto[]> {
  return invoke<AgentDefinitionDto[]>("list_agent_definitions_for_space", { cwd: spacePath ?? null });
}


/** The effective Agent config for the Space's definitions — the sidebar Agents modal's data source (ADR 0068). `cwd: null` = app-scope (user-level definitions only; the override map is global and unaffected). */
export async function listAgentConfig(
  cwd: string | null,
): Promise<AgentConfigDto[]> {
  return invoke<AgentConfigDto[]>("list_agent_config", {
    cwd: cwd ?? null,
  });
}


/** The effective MCP servers for a Space (`null` = user-level only). */
export async function listMcpServersEffective(spacePath: string | null): Promise<McpServerInfo[]> {
  return invoke<McpServerInfo[]>("list_mcp_servers_effective", { cwd: spacePath ?? null });
}


/**
 * The file listing a Space offers the `?` path completion (ADR 0033 — a
 * PATH is inserted, never the contents). `null` = no Space: the Rust
 * command degrades to the empty listing rather than erroring.
 */
export async function listSpaceFiles(spacePath: string | null): Promise<FileListDto> {
  return invoke<FileListDto>("list_space_files", { spacePath: spacePath ?? null });
}


/**
 * The out-of-Space `?` rows for ONE directory (ADR 0035 — a `~/-`- or
 * drive-rooted token), never a walk. `null` = no out-of-Space token open.
 *
 * `null` is PASSED THROUGH as `{ query: null }`, exactly as `listSpaceFiles`
 * passes `spacePath: null` (pinned in `src/lib/tauri.test.ts`), and the command
 * never rejects — it degrades to the empty listing. Do NOT add a client-side
 * short-circuit: the Rust `None` arm already touches no filesystem at all, and a
 * short-circuit here would move that guarantee out of the one place a Rust test
 * can see it, for no gain.
 */
export async function listCompletionEntries(
  query: string | null,
): Promise<CompletionDirDto> {
  return invoke<CompletionDirDto>("list_completion_entries", {
    query: query ?? null,
  });
}


// ---------------------------------------------------------------------------
// Attention alerts (ADR 0038/0039 — the countdown lives in Rust)
// ---------------------------------------------------------------------------

/** Arm the Supervisor's attention countdown (ADR 0039: Rust owns the clock).
 * One armed alert at a time — arming REPLACES the pending countdown. */
export async function attentionArm(
  delaySecs: number,
  title: string,
  body: string,
): Promise<void> {
  // The arg key `delaySecs` maps to the Rust `delay_secs` parameter, and the
  // delay is passed through EXACTLY (`0` = fire immediately) — no client-side
  // defaulting here: Rust owns the clock and the ceiling. The wire contract is
  // pinned in `src/lib/tauri.test.ts`, the only place a typo can be caught.
  await invoke("attention_arm", { delaySecs, title, body });
}


/** Disarm the attention countdown. Idempotent; called for EVERY disarm reason. */
export async function attentionDisarm(): Promise<void> {
  // No payload: the Rust command takes only its `State<Arc<AttentionTimer>>`.
  await invoke("attention_disarm");
}


// ---------------------------------------------------------------------------
// External open (ADR 0051 — the policy is Rust's, this is only the wire)
// ---------------------------------------------------------------------------

/** External open (ADR 0051): hand `href` to the OS default handler. A relative
 * href is a path resolved against `cwd` (the active Session's `cwd`, i.e. its
 * **Space**); with no `cwd` a relative href is refused. NEVER rejects — a
 * refusal or an OS failure lands in `console.warn` with the typed reason. */
export async function externalOpen(
  href: string,
  cwd?: string | null,
): Promise<void> {
  // The classification, the scheme denylist and the path join are ALL in
  // `crate::open` (Rust owns path semantics — a Windows join is not a `/`), so
  // nothing is decided here beyond the wire shape: the command NAME and the two
  // arg KEYS are pinned in `src/lib/tauri.test.ts`, and `cwd` is normalised to
  // an explicit `null` (never an absent key) so the Rust `Option<String>` sees
  // one shape. The swallow is deliberate: every caller is a click handler with
  // no `catch`, and the wire error IS the typed refusal code
  // (`denied-scheme:…`, `relative-without-cwd`, `os-error:…`).
  try {
    await invoke("external_open", { href, cwd: cwd ?? null });
  } catch (err) {
    console.warn(`external open refused: ${describeIpcError(err)}`, href);
  }
}


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


/**
 * Answer an interactive request. The invoke key is `result` (the Rust command's
 * `result: serde_json::Value` param — Tauri's camelCase↔snake_case handles
 * `sessionId`/`requestId` but will not alias `response`↔`result`). The
 * `result` is written into the response frame verbatim (no wrapper).
 */
export async function respondInteractiveRequest(
  sessionId: string,
  requestId: string,
  result: InteractiveResponseDto,
): Promise<void> {
  return invoke("respond_interactive_request", { sessionId, requestId, result });
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
