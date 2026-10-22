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
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ImageRef } from "./chatAttachments";
import { describeIpcError } from "./ipcError";

// ---------------------------------------------------------------------------
// Types mirroring the Rust side
// ---------------------------------------------------------------------------

/** One entry of a config option's `options` list (camelCase). */
export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

/** A group in a config option's `options` list (camelCase). */
export interface SessionConfigSelectGroup {
  name: string;
  options: SessionConfigSelectOption[];
}

/**
 * A session config option the agent advertises (camelCase wire shape).
 * `category` is snake_case per the ACP spec (`"model"`,
 * `"thought_level"`); `type` discriminates the payload shape.
 */
export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: (SessionConfigSelectOption | SessionConfigSelectGroup)[]; // select kind only
}

/** Return value of the `start_session` command (camelCase). */
export interface SessionInfo {
  sessionId: string;
  cwd: string;
  capabilities: Record<string, unknown>;
  configOptions?: SessionConfigOption[];
  /** The desktop's archived flag (ADR 0016): `true` hides the session from its Space group into the Archived section (the transcript is kept). Always present over IPC. */
  archived: boolean;
  /** The session's generated title (`null`/`undefined` until the naming pass writes one). Auto-generated only — there is no rename affordance yet. */
  title?: string | null;
  /** The session's last known context usage (the `context_usage_update` frame's values — the provider's `input_tokens` vs the model's window). Persisted on the `sessions` row on every frame, so a CLOSED session's context survives (the store drops the entry on close — the row is the source of truth for the stored session's context bar). `undefined` until the first frame. */
  contextUsage?: { used: number; window: number };
}

/** A space bookkeeping row (camelCase over IPC). */
export interface SpaceRow {
  path: string;
  createdAt: number;
  lastOpenedAt: number;
  /** Whether the space is trusted (permission prompts for gated tools are auto-approved). */
  trusted: boolean;
}

/** The folder-check result (camelCase over IPC). */
export interface SpaceCheck {
  canonicalPath: string;
  isSpace: boolean;
}

/**
 * Why a session was closed (snake_case strings over the `session-closed`
 * event). The UI renders close reasons in the paused banner copy.
 * Recorded per session id in the store's `closeReasons`.
 */
export type CloseReasonStr = "user" | "agent-exited" | "error";

/** Why the agent stopped a prompt turn (snake_case strings). */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "max_turn_requests"
  | "cancelled";

/**
 * The user's decision on a permission prompt. Mirrors the Rust
 * `PermissionOutcome` serde shape: the unit variant serializes to the bare
 * string `"cancelled"`, the struct variant to `{"selected": {"option_id": …}}`.
 */
export type PermissionOutcome =
  | { selected: { option_id: string } }
  | "cancelled";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

/** The agent's `session/request_permission` request (camelCase). */
export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId?: string; title: string };
  options: PermissionOption[];
}

export type AcpToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolCallDiff {
  path: string;
  oldText?: string | null;
  newText: string;
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string };

/**
 * A `session/update` notification body. The eight update types the desktop
 * handles are modelled; anything else (unknown/future types) falls through
 * to the reducer's `default` branch and is ignored (forward-compat).
 *
 * `rawOutput` is the tool's result (the RPC `AgentToolResult`), live-partial
 * while the tool runs, final on `tool_execution_end`.
 */
export type AcpSessionUpdate =
  | {
      sessionUpdate: "agent_message_chunk";
      content?: ContentBlock;
      messageId?: string;
    }
  | {
      sessionUpdate: "agent_thought_chunk";
      content?: ContentBlock;
      messageId?: string;
    }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      status?: AcpToolCallStatus;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: ToolCallContent[];
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      status?: AcpToolCallStatus;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: ToolCallContent[];
    }
  | { sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] }
  | {
      sessionUpdate: "context_usage_update";
      /** The session's current context size (tokens — the provider-reported prompt size, or the post-compaction / resume re-estimate). */
      usedTokens: number;
      /** The session model's context window (tokens). */
      windowTokens: number;
    }
  | {
      sessionUpdate: "compaction_update";
      /** True while a compaction runs; false when it ends (any outcome). */
      active: boolean;
      /** "manual" | "threshold" | "overflow" (ADR 0045's vocabulary). */
      reason: string;
    }
  | {
      /** (ADR 0048) An Abandoned attempt's reply is RetRACTED: every
       * agent-text / agent-thought message with this `messageId` is dropped.
       * Silent when nothing was streamed under it. The discard line arrives
       * separately as a `{stamp}:retract:N` chunk (ADR 0049 stamps it), so it
       * survives. */
      sessionUpdate: "message_retracted";
      messageId: string;
    };

export interface SessionUpdatePayload {
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface SessionClosedPayload {
  sessionId: string;
  reason: CloseReasonStr;
}

/**
 * The `session-stalled` event payload (a Worker crash, ADR 0025 Task 4 —
 * the `StalledInfo` shape + the session id, camelCase over the wire). The
 * frontend's banner reads it; the `getStalledInfo` command is the PULL
 * form (the same `StalledInfo`, no `sessionId` — the command's parameter).
 */
export interface StalledInfo {
  /** Unix milliseconds (the crash time). */
  at: number;
  /** The crashed Worker's own `crash-<ts>-worker-<pid>.log` — selected by the pid of the child the Supervisor reaped, and FROZEN at crash time (the `session-stalled` push and `getStalledInfo` name the same path). `null` when the pid matched no log — never another Worker's crash. */
  crashLog: string | null;
}

export interface StalledPayload {
  sessionId: string;
  at: number;
  crashLog: string | null;
}

export interface PermissionRequestPayload {
  sessionId: string;
  requestId: string;
  request: PermissionRequest;
}

// ---------------------------------------------------------------------------
// Interactive (the delegated interactive UI — the listener emits these)
// ---------------------------------------------------------------------------

/**
 * One question of the ask schema (the `ask` tool's `params.questions` entry,
 * mirrored structurally — the ask package owns the concrete type).
 *
 * The Rust `ask` flow normalizes every payload it emits to THIS shape (a bare
 * string option becomes `{ label }`, and a question with no `id` gets a unique
 * positional one), so a LIVE request satisfies it. A `tool-call` row persisted
 * BEFORE that normalization landed replays the model's raw arguments instead —
 * `id` absent, `options` bare strings — so readers stay defensive (`?? ""`)
 * rather than trusting the declaration for stored history.
 */
export interface AskQuestionDto {
  id: string;
  question: string;
  description?: string;
  options: Array<{ label: string }>;
  multi?: boolean;
  recommended?: number;
}

/**
 * The user's answer to an `ask` interactive request — the `result` of the
 * response frame, verbatim (one result per question).
 */
export interface AskResponsePayload {
  cancelled: boolean;
  results: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
}

/**
 * An `interactive-request` event payload (camelCase over the wire — the Rust
 * loop builds it). `sessionId` is the ACP session id (the native `AgentLoop`
 * is constructed with it, so the events always carry it). `params` = the
 * method's params: the ask schema (`{ questions }`) for `ask`, `{ command,
 * reason }` for `confirm`/`password`.
 */
export interface InteractiveRequestPayload {
  sessionId: string;
  requestId: string;
  method: "ask" | "confirm" | "password";
  source: string;
  toolCallId?: string;
  params: Record<string, unknown>;
}

/**
 * An `interactive-event` push (camelCase over the wire). `event` is the wire name
 * (`todos_update` / `todos_clear` / `cost_update` / `state` / `session` —
 * the bus `COST_UPDATE` maps to `cost_update`, NOT `cost`); `payload` is the
 * bus payload verbatim.
 */
export interface InteractiveEventPayload {
  sessionId: string;
  seq: number;
  event: string;
  payload: unknown;
}

/**
 * The `result` to send back via `respond_interactive_request` — for `ask`, the
 * `AskResponsePayload` verbatim; for `confirm`, `{ confirmed }`; for
 * `password`, `{ password }` (or `{ password: "" }` for a cancel).
 */
export type InteractiveResponseDto =
  | AskResponsePayload
  | { confirmed: boolean }
  | { password: string };

/**
 * The `metrics` of the `subagent-closed` payload / the `dispatch_subagent`
 * response (same shape over the wire) — the usage the Supervisor accumulated
 * for the child plus its wall-clock duration, i.e. what `SubagentClosedPayload`
 * calls the sole hand-off of a child's usage: no other frame carries a child's
 * usage to the client, so the subagents-store snapshot is built from this object
 * and from nothing else.
 *
 * `inputTokens` / `outputTokens` are REAL on a completed child: the Supervisor's
 * `SubagentCapture` (`src-tauri/src/agent/worker/manager.rs`) reads the child's
 * `message_update` `usage` frames and keeps the MAX of each field across them
 * (a turn's usage is cumulative per message, so the last is the largest) —
 * `the_subagent_capture_captures_the_final_text_from_the_sink_frames` pins that
 * accumulation. `durationMs` is the drive task's wall clock.
 *
 * `cost` is the ONE constant: `drive_subagent` builds the struct with `cost:
 * 0.0` literally, because nothing prices a child's usage.
 *
 * On a FAILED child these fields are REAL TOO (ADR 0055): `drive_subagent`'s
 * non-settled arms read the same `SubagentCapture` the completed arm does, so a
 * reaped / crashed / cancelled child reports the tokens it actually burned
 * before it died, and `finish_subagent` forwards that payload instead of a
 * `SubagentMetrics::default()`. Tokens are 0 on a failed child only when it
 * genuinely produced nothing (a preflight failure — the child never started).
 */
export interface SubagentMetrics {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
}

/**
 * A `subagent-session-started` event payload (camelCase over the wire).
 *
 * Emitted by `dispatch_subagent` (`src-tauri/src/agent/worker/manager.rs`) on
 * the PARENT session's sink — the `WorkerManager`'s Supervisor-side flow, which
 * `SubagentSessionManager::dispatch_native` only delegates to. There is no
 * session to "establish" first (ADR 0022 removed the ACP layer): the child id is
 * minted (`mint_session_id`, or handed in already minted by the in-process
 * `dispatch_native`) BEFORE this frame is emitted and never changes after, so
 * `sessionId` is that final id — never a stand-in for a later one.
 *
 * The ordering is load-bearing and is what `App`'s `listenSubagentClosed`
 * handler relies on: the frame fires BEFORE the flow spawns the drive task that
 * spawns the child's Worker and reaches `finish_subagent`, so a
 * `subagent-closed` can never precede its own `started` — not even when the
 * Worker spawn fails, which short-circuits straight into that teardown.
 */
export interface SubagentSessionStartedPayload {
  sessionId: string;
  parentSessionId: string;
  agentName: string;
  task: string;
  model?: string;
  thinkingLevel?: string;
  enabledTools?: string[];
}

/**
 * A `subagent-closed` event payload (camelCase over the wire). `error` is
 * present only for `failed`; `metrics` = the usage the Supervisor accumulated
 * for the child plus its wall-clock duration (see `SubagentMetrics`). This is
 * the ONLY frame that names the end of a child session: `session-closed` never
 * carries a child id — its one emitter, `on_session_exited_expected`
 * (`src-tauri/src/agent/session/router.rs`), returns without a `live` entry and
 * the only insert into `live` is `establish_worker_session`
 * (`src-tauri/src/agent/session/mod.rs`) on the main-session start / resume
 * paths — while a child's teardown, `finish_subagent`
 * (`src-tauri/src/agent/worker/manager.rs`), emits this event and nothing else.
 * Hence the snapshot the frontend keeps in the subagents store: it is the sole
 * hand-off of a child's usage, not a race-covering copy of one.
 */
export interface SubagentClosedPayload {
  sessionId: string;
  status: "completed" | "failed";
  error?: string;
  metrics?: SubagentMetrics;
  /**
   * WHY a `failed` child failed — the machine-readable code, NOT prose. It
   * exists because the card under the `subagent` tool call renders ONE short
   * line, while `error` is the SALVAGE TEXT the parent model reads (ADR 0055:
   * every failure path carries the partial output and a sentence like
   * "subagent worker exited unexpectedly (code 137)"). Rendering `error` in
   * that row put parent-facing prose in the user's compact view, so the row
   * reads this code and maps it to a label.
   *
   * The values are `SubagentFailureReason`
   * (`src-tauri/src/agent/subagent.rs`) serialised by serde
   * (`#[serde(rename_all = "snake_case")]`) — all four variants are single
   * words, so snake_case and camelCase and bare lowercase coincide.
   *
   * OPTIONAL, not because it is incidental but because a payload written by a
   * backend predating it omits the field; the card then falls back to `error`
   * rather than showing nothing. Absent on a `completed` payload.
   */
  reason?: SubagentFailureReason;
}

/**
 * The Rust `SubagentFailureReason` (ADR 0055) over the wire: `unresponsive` =
 * the **Dead bound** won (silent, nothing in flight), `crashed` = the Worker
 * process exited, `cancelled` = a Stop on the parent, `other` = anything else
 * (a preflight failure — the child never started). Nothing may infer these by
 * string-matching `error`.
 */
export type SubagentFailureReason =
  | "unresponsive"
  | "crashed"
  | "cancelled"
  | "other";

/** A row from the app's SQLite `messages` table (camelCase over IPC). */
export interface MessageRow {
  id: number;
  sessionId: string;
  kind: "user" | "agent-text" | "agent-thought" | "tool-call" | "diff" | (string & {});
  /** ContentChunk.messageId for agent-text; the tool call id for tool-call. */
  messageKey: string | null;
  /** The message body, serialized (camelCase). */
  payloadJson: string;
  /** Unix milliseconds. */
  createdAt: number;
}

/** The provider wire vocabulary (ADR 0024 + 0026): the three wires the harness speaks + the `litellm` DISCOVERY MODE (its wire is `openai-completions` — ADR 0026). */
export type WireApi =
  | "openai-completions"
  | "anthropic-messages"
  | "openai-responses"
  | "litellm";

/** A user-configured model provider (`settings.json` `providers` entry). */
export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** The wire API (ADR 0024): `"openai-completions"` (default) / `"anthropic-messages"` / `"openai-responses"` / `"litellm"` (discovery via `GET /model/info`, wire = openai-completions — ADR 0026). */
  api: WireApi;
  /** The key-management page URL (set by the known-providers picker — the row's "Get key" link; `null` / absent for a hand-typed provider). */
  keyUrl?: string | null;
}

/** A known provider template (the built-in catalog — the Settings' known-providers picker's data source; the Rust `KnownProviderDto`'s camelCase wire shape, ADR 0024). */
export interface KnownProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: WireApi;
  keyUrl: string;
}

/**
 * An MCP server entry (the `settings.json` `mcpServers` value — ADR 0019):
 * pi's `mcpServers` entry shape VERBATIM, so an entry copy-pastes between
 * the desktop's `settings.json` and pi's `mcp.json` files. An entry is an
 * HTTP server (`url` + optional `headers` / `auth` / `bearerTokenEnv`) or
 * a stdio server (`command` + optional `args` / `env` / `cwd`).
 */
export interface McpServerEntry {
  // HTTP:
  url?: string;
  headers?: Record<string, string>;
  /** `"oauth"` (the interactive flow) or the OAuth config object's fields. */
  auth?: string | Record<string, string>;
  bearerTokenEnv?: string;
  // stdio:
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // common:
  disabled?: boolean;
}

/** The font settings (the settings UI's size slider + optional family overrides). */
export interface FontSettings {
  sizePx: number;
  uiFamily: string | null;
  codeFamily: string | null;
}

/**
 * (ADR 0030) What happens to a file access that goes BEYOND the boundary.
 * The wire values are the Rust `AccessPolicy`'s serde renames — the UI
 * label for `"allow"` is "Don't ask me" (the label never rides the wire).
 */
export type AccessPolicy =
  /** Refuse it (a tool-result error, never a prompt). */
  | "sandboxed"
  /** Prompt the user. */
  | "ask"
  /** Allow it silently — THE derived default in every direction. */
  | "allow";

/**
 * (ADR 0030) The per-direction file-access policies (the Settings UI's
 * three selects). Every direction defaults to `"allow"`: a pre-feature
 * `settings.json` has no `filePolicy` key and the backend serves
 * all-`allow`, so the UI renders "Don't ask me" everywhere on a fresh
 * install (the UI reads the field nullishly, so a document that predates
 * the field — or a bare mock — still renders the honest default rather than
 * an empty select).
 */
export interface FilePolicy {
  reads: AccessPolicy;
  writes: AccessPolicy;
  /** `bash`. */
  shell: AccessPolicy;
}

/**
 * Configuration for the web tools (`web_search` and `fetch_content`).
 * Mirrors the Rust `WebSettings` struct's camelCase shape.
 */
export interface WebSettings {
  braveApiKey: string;
  tavilyApiKey: string;
  perplexityApiKey: string;
  /** The self-hosted SearXNG instance base URL. */
  searxngUrl: string;
  /** "auto" (default) or one of brave|tavily|perplexity|searxng|duckduckgo. */
  defaultProvider: string;
  /** An explicit proxy URL. Empty = fall back to HTTPS_PROXY/HTTP_PROXY. */
  proxy: string;
}

/**
 * The persisted app settings (`settings.json` in the config dir).
 * Mirrors the Rust `Settings` struct's camelCase shape exactly (a
 * `saveSettings` round-trip loses no field).
 */
export interface AppSettings {
  /** "system" follows the OS scheme live (the `matchMedia` listener in theme.ts). */
  theme: "system" | "dark" | "light";
  /** (ADR 0027) The color scheme; `null` = `"zai"` (a pre-feature file). Orthogonal to `theme` — `"dracula"` is dark-only and PINS dark, so the mode is ignored. */
  palette: "zai" | "dracula" | null;
  paneLayout: Record<string, unknown>;
  defaultTrustNewSpaces: boolean;
  defaultModel: string | null;
  /** The per-app thinking-level seed (`null` = the model's own default — the session start's last rung: remembered > stored > this > `None`). */
  defaultThinkingLevel: string | null;
  /** The harness-level tool filter: `[]` = all tools enabled. */
  enabledTools: string[];
  providers: ProviderConfig[];
  /** (ADR 0019) The user-managed MCP servers: `name → entry` (pi's entry shape). */
  mcpServers: Record<string, McpServerEntry>;
  font: FontSettings;
  /** Per-model remembered thinking level (ADR 0015): `"<provider>/<id>"` → the last level the user set for that model. */
  defaultThinkingLevels: Record<string, string>;
  /**
   * (ADR 0066) Global Agent overrides: agent name → override. Replaces
   * `subagentModels`, whose legacy values the backend folds in on read.
   *
   * REQUIRED, not optional — and that is backed by the store, not by hope:
   * `agent_overrides` carries `#[serde(default)]` WITHOUT `skip_serializing_if`,
   * deliberately matching every other map field in `config.rs` (`mcpServers`,
   * `defaultThinkingLevels`), so the backend always answers
   * `"agentOverrides": {}` instead of omitting the key. Dropping the key when
   * empty would hand the renderer `undefined` for a required field and make the
   * Agents modal throw for every user who has never pinned anything.
   */
  agentOverrides: AgentOverrides;
  /** The working-indicator spinner style (a `braille-loader` variant name, e.g. `"typing"` / `"pendulum"`); `null` = the `typing` default. */
  spinnerStyle: string | null;
  /** The empty-state animation (`"off"` / `"static"` / `"animated"`); `null` = the `"animated"` default. `prefers-reduced-motion` may pin `"animated"` to `"static"`, never un-`off` a deliberate `"off"` (ADR 0070). */
  emptyStateAnimation: string | null;
  /** (ADR 0030) The per-direction file-access policies. The backend ALWAYS emits it (`#[serde(default)]` fills all-`allow` for a pre-feature file), so it is required here; the UI still falls back to all-`allow` if the key is ever absent. */
  filePolicy: FilePolicy;
  /** The web tools' configuration (search API keys, proxy, default Search provider). */
  web: WebSettings;
  /**
   * (ADR 0031 follow-up) Whether the composer's `#` trigger names an MCP
   * server. OFF by default: `#` is the ONE prefix that collides with pasted
   * developer text — `#include`, an issue number `#123` and `#hashtag` all
   * satisfy the token grammar, so an accidental expansion lands whenever a
   * server shares such a name. `$` and `@` stay always on.
   *
   * Gates the TRIGGER only (the picker rows + the send-path expansion, both
   * fed an EMPTY MCP catalog when off). It does NOT gate the DISPLAY: a
   * message persisted while the trigger was on keeps rendering its `<mcp>`
   * chip. The backend emits it with `#[serde(default)]`, so a pre-feature
   * `settings.json` reads as `false`.
   */
  mcpMentionsEnabled: boolean;
  /**
   * Session naming (ported from pi-archimedes' `session-name`): the master
   * switch for the title request the desktop fires after a session's first
   * exchange. ON by default — pi ships naming on, so the backend's serde
   * default is `true` and a pre-feature `settings.json` reads as enabled
   * (unlike `mcpMentionsEnabled`, whose default is `false`). The required
   * modifier is safe for the same reason: the backend always emits it via
   * `#[serde(default)]`.
   */
  sessionNamingEnabled: boolean;
  /** The model used to write session names: the composed key `"provider/id"` (a hand-edited `"provider/id:<level>"` is tolerated); `null` = the session's own model. */
  sessionNamingModel: string | null;
  /** The thinking level for the title request, honoured only when the chosen model advertises it; `null` = no reasoning effort on the request. JSON-only — there is no Settings row for it. */
  sessionNamingReasoning: string | null;
  /** Attention alerts (ADR 0038/0039): master switch for the OS notification raised when a session has been paused on you longer than `attentionAlertDelaySecs`. ON by default, so a pre-feature `settings.json` reads as enabled. */
  attentionAlertsEnabled: boolean;
  /** Seconds between an attention trigger and the alert (default 15). Read at arm time: changing it does not re-time a countdown already running. */
  attentionAlertDelaySecs: number;
}

/** The effective catalog's model (the Default-model select + provider discovery status). */
export interface ModelDto {
  id: string;
  provider: string;
  contextWindow: number;
  supportsThinking: boolean;
  thinkingLevels: string[];
}

/** One discovered agent definition (camelCase over IPC — the Rust `AgentDefinitionDto`). */
export interface AgentDefinitionDto {
  name: string;
  description: string;
  model: string | null;
  scope: "space" | "user";
}

/** One agent's override (ADR 0066: `settings.json`'s `agentOverrides[<name>]`). An ABSENT field means "this override does not speak" (ADR 0067) — never send `null` to mean inherit. */
export interface AgentOverride {
  model?: string;
  thinking?: string;
  /** An EMPTY list speaks NOTHING (ADR 0067) — no override can zero out a child's tools. */
  tools?: string[];
}

/** `settings.json`'s `agentOverrides` (ADR 0066): agent name → override. One global map — there is NO per-Space map, and keys are matched case-insensitively by the backend. */
export type AgentOverrides = Record<string, AgentOverride>;

/** Which layer supplied a field. `parent` = nothing below the explicit `subagent` param spoke (ADR 0068) — a dispatch that passes the param still overrides it. */
export type OverrideSource = "override" | "file" | "parent";

/**
 * One field-triple of the Agents modal's report (the Rust `OverrideFields`).
 * The three `Option`s are serialized ALWAYS PRESENT — no `skip_serializing_if`
 * — so "this column has no value" arrives as `null` and the fields are
 * `… | null`, NOT optional. That is the deliberate opposite of `AgentOverride`,
 * where absence is the only meaning of "does not speak": these are ROWS of a
 * report the modal renders (as `Inherits parent`), not the stored document.
 */
export interface AgentOverrideFields {
  model: string | null;
  thinking: string | null;
  tools: string[] | null;
}

/** Which layer supplied each of the report's three fields (the Rust `SourceFields`). */
export interface AgentOverrideSources {
  model: OverrideSource;
  thinking: OverrideSource;
  tools: OverrideSource;
}

/** One row of `list_agent_config` (camelCase over IPC — the Rust `AgentConfigDto`). */
export interface AgentConfigDto {
  name: string;
  description: string;
  scope: "space" | "user";
  /** The DEFINITION FILE's path. */
  path: string;
  /** The frontmatter VERBATIM — before any filtering, so the row can say what the file actually said. */
  file: AgentOverrideFields;
  /** The STORED entry VERBATIM (not the resolver's output), so a stale pin stays visible. Rust spells this `override_` (a keyword); the wire name is `override`. */
  override: AgentOverrideFields;
  /** What the dispatch will launch with — produced by the resolver itself. */
  effective: AgentOverrideFields;
  /** Which layer supplied each of those three values. */
  source: AgentOverrideSources;
  /** The entries this name EXCLUDED by shadowing (ADR 0065) — a REPORT
   *  rendered on this row, never a row of its own. REQUIRED, not optional:
   *  the Rust DTO always serializes the Vec (empty as `[]`), exactly like
   *  `SkillInfo.shadowed`, and `SkillsDialog`'s `?? []` tolerance is a
   *  defence for old rows, not a licence to omit it here. */
  shadowed: ShadowedAgent[];
}

/** One effective MCP server (camelCase over IPC — the Rust `McpServerInfo`). */
export interface McpServerInfo {
  name: string;
  kind: "http" | "stdio";
  /** The `url` (HTTP) or `command + args` (stdio). */
  summary: string;
}

/** One Skill excluded by **shadowing** (camelCase over IPC — Rust `skills::Shadowed`).
 *  It has NO `$` mention route and no `read_skill` route in this Space: another
 *  root contributed the same name first, and name is a Skill's identity (ADR 0065).
 *  Rendered as a report, never as a row. */
export interface ShadowedSkill {
  name: string;
  /** Canonical path to the shadowed SKILL.md. */
  path: string;
  scope: "space" | "user";
}

/** One Agent definition excluded by **shadowing** (camelCase over IPC — the same
 *  Rust `skills::Shadowed<T>` the Skill row above is). A DELIBERATE two-line NAME
 *  duplicate of `ShadowedSkill`, not a shape duplicate: Rust ships ONE generic
 *  `Shadowed<T>` for both surfaces, but this file names its wire types per
 *  surface (`SkillInfo` / `AgentDefinitionDto`), and reusing `ShadowedSkill` on
 *  an Agent row would make that interface's own doc-comment ("One Skill excluded
 *  by shadowing") a lie. Two lines of structural duplicate is the cheaper lie. */
export interface ShadowedAgent {
  name: string;
  /** Canonical path to the shadowed agent definition file. */
  path: string;
  scope: "space" | "user";
}

/** One discovered skill (camelCase over IPC — the Rust `SkillInfo`). */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  dir: string;
  scope: "space" | "user";
  /** The SKILL.md content minus the frontmatter (the injected block's BODY). */
  body: string;
  /** Frontmatter `disable-model-invocation: true` — the Agent is not OFFERED
   *  this skill: the live skill tools drop it (sooner than the session's frozen
   *  `<skills>` prompt section does — ADR 0036), and a `$name` Mention reaches
   *  it WHENEVER the mention grammar can carry the name (`isMentionableSkillName`). */
  disableModelInvocation: boolean;
  /** The entries this row EXCLUDED by shadowing (ADR 0065 — name is a Skill's
   *  identity, so the later root's same-named `SKILL.md` never becomes a route).
   *  REQUIRED because the Rust DTO always serializes the `Vec` (empty as `[]`).
   *  UI-only, never sent to the model. */
  shadowed: ShadowedSkill[];
}

/** One `?` file-completion listing (camelCase over IPC — the Rust `FileListDto`). */
export interface FileListDto {
  /** Paths RELATIVE to the Space root, `/`-separated, sorted. */
  entries: string[];
  /** The walk hit `MAX_PICKER_ENTRIES` — the picker says so instead of lying. */
  truncated: boolean;
}

/**
 * One row of an out-of-Space **Directory completion** (ADR 0035 — the Rust
 * `CompletionEntryDto`). The three strings differ on purpose: `name` is what the
 * renderer filters, `display` is what it shows (`~/…` when under the home
 * directory), and `insert` is the ABSOLUTE path that lands in the draft —
 * NOTHING in this app expands a tilde, so the abbreviation is display-only and
 * must never be inserted.
 */
export interface CompletionEntryDto {
  /** The entry's own name, no trailing separator (what the filter matches). */
  name: string;
  /** ABSOLUTE, `/`-separated — this is what lands in the draft. */
  insert: string;
  /** `~/…` when under the home directory, else the same as `insert`. */
  display: string;
  /** A directory: the row descends (and keeps the `?`) instead of finishing. */
  isDir: boolean;
}

/**
 * ONE directory's worth of completion rows (ADR 0035 — the Rust
 * `CompletionDirDto`). The whole directory comes back UNFILTERED so the renderer
 * keeps filtering synchronously and a fetch happens only when the token's
 * DIRECTORY part changes.
 */
export interface CompletionDirDto {
  entries: CompletionEntryDto[];
  /** The cap trimmed the directory — the picker says so instead of lying. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Commands (invoke)
// ---------------------------------------------------------------------------

export async function startSession(cwd: string): Promise<SessionInfo> {
  return invoke<SessionInfo>("start_session", { cwd });
}

export async function sendPrompt(
  sessionId: string,
  text: string,
  images?: ImageRef[],
): Promise<StopReason> {
  return invoke<StopReason>("send_prompt", { sessionId, text, images: images ?? [] });
}

/**
 * Compact a session NOW — the `/compact` **Composer command** (ADR 0044), the
 * one control command the Client consumes instead of sending. The command never
 * reaches the Agent, so this invoke is its only route in.
 *
 * `false` is the NOT-LIVE answer, not an error: compacting a stored (non-live)
 * session is a no-op by design, and the composer turns this one boolean into
 * its whole one-line explanation. `true` means the frame was actually written.
 *
 * `instructions` are the user's extra summary instructions (`/compact <args>`),
 * `null` when the command stood alone — passed through VERBATIM, and
 * deliberately NOT normalized the way `sendPrompt` one line above normalizes
 * its `images` (`?? []`): the Rust parameter is `Option<String>`, so `""` is a
 * different instruction to the harness than `None`.
 */
export async function compactSession(
  sessionId: string,
  instructions: string | null,
): Promise<boolean> {
  return invoke<boolean>("compact_session", { sessionId, instructions });
}

export async function closeSession(sessionId: string): Promise<void> {
  return invoke("close_session", { sessionId });
}

export async function respondPermission(
  sessionId: string,
  requestId: string,
  outcome: PermissionOutcome,
): Promise<void> {
  return invoke("respond_permission", { sessionId, requestId, outcome });
}

export async function resumeSession(
  sessionId: string,
  cwd: string,
): Promise<SessionInfo> {
  return invoke<SessionInfo>("resume_session", { sessionId, cwd });
}

/** Cancel the session's in-flight prompt turn (Esc). The agent resolves the open prompt with `stopReason: "cancelled"`. */
export async function cancelSession(sessionId: string): Promise<void> {
  return invoke("cancel_session", { sessionId });
}

/** Set a session config option (model / thinking level); returns the agent's updated `configOptions`. */
export async function setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string,
): Promise<SessionConfigOption[]> {
  return invoke<SessionConfigOption[]>("set_session_config_option", {
    sessionId,
    configId,
    value,
  });
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

// ---------------------------------------------------------------------------
// History (SQLite) + settings commands
// ---------------------------------------------------------------------------

/** All stored sessions, newest first. `includeArchived` includes the archived rows (their `archived` flag is set); `undefined` → the Rust default `false`. */
export async function listSessions(
  includeArchived?: boolean,
): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("list_sessions", { includeArchived });
}

export interface HistoryPage {
  rows: MessageRow[];
  hasMore: boolean;
  todos?: unknown[] | null;
}

/** A stored session's transcript page (ADR 0066). */
export async function loadHistory(
  sessionId: string,
  opts?: { limit?: number; beforeId?: number },
): Promise<HistoryPage> {
  return invoke<HistoryPage>("load_history", {
    sessionId,
    limit: opts?.limit ?? null,
    beforeId: opts?.beforeId ?? null,
  });
}

/** Delete a stored session (its messages cascade). */
export async function deleteSession(sessionId: string): Promise<void> {
  return invoke("delete_session", { sessionId });
}

/** Archive (or unarchive) a stored session (ADR 0016): sets the `sessions.archived` flag; the transcript is NOT touched. `false` when no row matched. */
export async function setSessionArchived(
  sessionId: string,
  archived: boolean,
): Promise<boolean> {
  return invoke("set_session_archived", { sessionId, archived });
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

/** The user-level discovered agent definitions — the app-scope read of the same total discovery `listAgentDefinitionsForSpace` narrows per Space. It is NO LONGER the Settings page's Subagents' data source: that section is deleted (the sidebar **Agents** modal is the single Agent surface), and this wrapper stays as the one place a future app-scope surface reaches for the catalog. Unreferenced outside `tauri.test.ts` right now, and `noUnusedLocals` cannot flag an exported function, so it is kept on purpose. */
export async function listAgentDefinitions(): Promise<AgentDefinitionDto[]> {
  return invoke<AgentDefinitionDto[]>("list_agent_definitions");
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
  return listen<SessionUpdatePayload>("session-update", (event) =>
    callback(event.payload),
  );
}

export function listenSessionClosed(
  callback: (payload: SessionClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionClosedPayload>("session-closed", (event) =>
    callback(event.payload),
  );
}

/**
 * A session's stalled state (the `get_stalled_info` command — the PULL
 * form of the `session-stalled` push; `null` when the session is not
 * stalled / unknown).
 */
export async function getStalledInfo(
  sessionId: string,
): Promise<StalledInfo | null> {
  return invoke<StalledInfo | null>("get_stalled_info", { sessionId });
}

export function listenSessionStalled(
  callback: (payload: StalledPayload) => void,
): Promise<UnlistenFn> {
  return listen<StalledPayload>("session-stalled", (event) =>
    callback(event.payload),
  );
}

/** The `session-titled` payload: a generated session title. */
export interface SessionTitledPayload {
  sessionId: string;
  title: string;
}

/**
 * A session's generated title (the naming pass's push). The PULL form is
 * `list_sessions` — which runs ONCE at boot, so a title generated in this
 * run reaches the sidebar ONLY through this event.
 */
export function listenSessionTitled(
  callback: (payload: SessionTitledPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionTitledPayload>("session-titled", (event) =>
    callback(event.payload),
  );
}

export function listenPermissionRequest(
  callback: (payload: PermissionRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen<PermissionRequestPayload>("permission-request", (event) =>
    callback(event.payload),
  );
}

export function listenInteractiveRequest(
  callback: (payload: InteractiveRequestPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveRequestPayload>("interactive-request", (event) =>
    callback(event.payload),
  );
}

/**
 * An `interactive-request-close` event payload (the Rust `SudoPromptCleanup` drop
 * guard emits it when a `sudo_exec` sub-prompt is DROPPED — a turn cancel
 * skips the flow's exit-path cleanup, so the modal must be closed here). The
 * `requestId` is the sub-prompt's derived id (`"{id}:confirm"` /
 * `"{id}:password"`).
 */
export interface InteractiveRequestClosePayload {
  sessionId: string;
  requestId: string;
}

export function listenInteractiveRequestClose(
  callback: (payload: InteractiveRequestClosePayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveRequestClosePayload>("interactive-request-close", (event) =>
    callback(event.payload),
  );
}

export function listenInteractiveEvent(
  callback: (payload: InteractiveEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<InteractiveEventPayload>("interactive-event", (event) =>
    callback(event.payload),
  );
}

export function listenSubagentSessionStarted(
  callback: (payload: SubagentSessionStartedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SubagentSessionStartedPayload>(
    "subagent-session-started",
    (event) => callback(event.payload),
  );
}

export function listenSubagentClosed(
  callback: (payload: SubagentClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<SubagentClosedPayload>("subagent-closed", (event) =>
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

// ---------------------------------------------------------------------------
// Window state (Linux tiling / snap detection)
// ---------------------------------------------------------------------------

export interface WindowFrameState {
  isTiled: boolean;
  isMaximized: boolean;
  isFullscreen: boolean;
  native: boolean;
}

export async function getWindowState(): Promise<WindowFrameState> {
  return invoke<WindowFrameState>("get_window_state");
}

export async function listenWindowState(
  handler: (payload: WindowFrameState) => void,
): Promise<() => void> {
  return listen<WindowFrameState>("window-state-changed", (event) =>
    handler(event.payload),
  );
}
