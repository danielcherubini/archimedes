/**
 * The TypeScript mirror of the Rust IPC surface: every shape the desktop sends
 * or receives over `invoke` / `listen`, declared ONCE.
 *
 * ONE module rather than a type per command module, deliberately: these
 * interfaces CROSS-CUT. `SessionInfo` is the return of `start_session` AND the
 * row shape of `list_sessions`; `AppSettings` is a `save_settings` argument AND
 * a `test_search_provider` argument; `MessageRow` is what `HistoryPage` carries,
 * and `HistoryPage` belongs to the history commands while `MessageRow` is a
 * storage row. Splitting them by subject would file each type next to ONE of its
 * users and force the other to reach across, so the seam is "wire shape" vs
 * "wire action", not "sessions" vs "settings".
 *
 * The three payload types the `listen*` wrappers used to declare inline
 * (`SessionTitledPayload`, `InteractiveRequestClosePayload`,
 * `WindowFrameState`) came here for the same reason — a consumer that handles an
 * event needs the payload type, not the listener.
 *
 * Case conventions on the wire (inherited from the file this was split out of):
 * - command arguments: camelCase here (Tauri maps them to snake_case Rust
 *   parameters),
 * - `SessionInfo` (the `start_session` return value): camelCase
 *   (`sessionId`, `cwd`),
 * - event payloads: camelCase (`sessionId`, `requestId`),
 * - ACP update discriminators: snake_case (`agent_message_chunk`, …).
 */

import type { InteractiveEventName } from "../ipc/events";

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
  /**
   * The session's provider-reported running cost in USD (issue #105).
   *
   * `null`/`undefined` means no call ever reported a cost — which is NOT the
   * same as `0`, a call that reported a genuine zero (D5, ADR 0082). The
   * renderer prints nothing for the first and `$0.00` for the second.
   *
   * Persisted on the `sessions` row from every `cost_update` frame, so a CLOSED
   * session keeps its figure: the store drops its entry on close, and the row is
   * the source of truth for a stored session. MONEY ONLY — there are no token
   * fields here on purpose (see the plan's fact 3): `SubagentDelegatingCard`'s
   * context-% chain must keep falling through to its own sources.
   *
   * OPTIONAL TS-side, like `title` / `contextUsage`: a required field would
   * break `tsc` at every fixture that builds a `SessionInfo`. It is optional
   * because a row may carry no figure — NOT because the wire withholds the
   * key: the Rust field is `Option<f64>` with `#[serde(default)]` and no
   * `skip_serializing_if`, so a `None` column arrives as `"costUsd": null`
   * (PRESENT AND NULL). Read the value, never the key's presence: both `null`
   * and a missing key mean "no figure" to `sessionFieldOf`.
   */
  costUsd?: number | null;
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


/** One session's recency, decoupled from its list position (ADR 0075). camelCase over IPC. */
export interface SessionRecency {
  sessionId: string;
  /** Unix ms — the newest transcript stamp, or the row's own `created_at` when it has no messages. Never null. */
  lastActiveAt: number;
  /** The row's position in the user's Manual order (bigger = lower). Boot order map input; no component reads it. */
  sortOrder: number;
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
 * string `"cancelled"`, the struct variant to
 * `{"selected": {"option_id": …, "value": …}}`.
 *
 * `selected` is the struct-variant wire KEY; `option_id` and `value` are the
 * fields inside it (the Rust enum carries `#[serde(rename_all = "snake_case")]`,
 * so there is NO top-level `option_id`). `value` echoes the chosen option's
 * `path` (the guard prompt's `allow-directory` option). It is **absent, not
 * `null`**, when the option carries no `path` — the Rust field is
 * `Option<String>` and serde-defaulted, and the UI omits the key entirely, so a
 * boundary prompt's payload stays byte-identical to the pre-feature shape.
 */
export type PermissionOutcome =
  | { selected: { option_id: string; value?: string } }
  | "cancelled";


export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
  /** The guard prompt's echoed value: the emitted option carries `path`, the UI
   * sends it back as `value` on the selected outcome. Absent for boundary
   * options (posture-`Ask` prompts), which is what keeps those payloads
   * unchanged. */
  path?: string;
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
 * An `interactive-event` push (camelCase over the wire). `event` is the wire
 * name, typed as [`InteractiveEventName`](./ipc/events.ts) so a handler that
 * forgets one discriminant is a compile error rather than a silently-dropped
 * frame; `payload` is the bus payload verbatim.
 */
export interface InteractiveEventPayload {
  sessionId: string;
  seq: number;
  event: InteractiveEventName;
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
 * `cost` is the child's summed per-call cost in USD, and it is NULLABLE
 * (issue #107): `null` means "no call reported a cost" — a preflight failure, a
 * child that never started, or a child whose every call came back unpriced —
 * and `0` means a call reported a REAL zero, which IS a figure. The two are
 * never collapsed, which is the same rule `SessionInfo.costUsd` /
 * `SessionCostLine` keep: the renderer prints nothing for the first and `$0.00`
 * for the second (D5, ADR 0082). The Rust field is `Option<f64>` with NO
 * `skip_serializing_if` on this field, so a `None` arrives as `"cost": null`
 * (PRESENT AND NULL — read the value, never the key's presence). The earlier
 * text here claimed `cost` was "`0.0` literally, because nothing prices a
 * child's usage"; that has been false since issue #87 made the mechanism real.
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
  cost: number | null;
  durationMs: number;
}


/**
 * The Rust `AgentNameResolution` (`src-tauri/src/agent/subagent.rs`) over the
 * wire — whether a `subagent` call's `agentName` matched a discovered Agent
 * definition. `resolve_launch` returns the SAME verbatim launch for `no_name`
 * and `unmatched` (ADR 0020: an unknown or omitted name is a config-less
 * dispatch, never an error), so this is the ONLY thing that separates the
 * deliberate case from the typo, and the surfaces that print a child's name
 * render the marker in exactly one of the three states.
 *
 * Serialised by serde `#[serde(rename_all = "snake_case")]`, so `no_name` is
 * the one two-word value (unlike `SubagentFailureReason`, whose four values are
 * single words and so coincide in every case).
 */
export type AgentNameResolution = "no_name" | "matched" | "unmatched";

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
  /**
   * (issue #47) Whether `agentName` resolved. OPTIONAL for the same reason
   * `SubagentClosedPayload.reason` is: a payload from a backend that predates
   * the field omits it, and the UI then renders exactly what it rendered
   * before. `undefined` and `"matched"` and `"no_name"` all render NOTHING
   * extra — only `"unmatched"` says anything, because only it means "this
   * child loaded no persona, no tool allowlist and no model from the name it
   * was given". NON-BLOCKING by design: the child still runs and its output is
   * real (the same reasoning ADR 0055 applies to a failed child's metrics).
   */
  nameResolution?: AgentNameResolution;
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


/** A rule's direction (the Rust `AccessDirection` serde renames). Required —
 * "`/` has read" is direction-specific, so a direction-less rule is an error. */
export type AccessDirection = "read" | "write" | "readWrite";

/** One `{path, direction, decision}` exception in `FilePolicy.rules` (mirror of
 * the Rust `AccessRule`, T01). `decision` is exactly `"allow" | "deny"` — there
 * is NO `ask` rule value: an ask is what happens when no rule matches and the
 * guard applies. `path` may carry a leading `~` and may name a directory that
 * does not exist yet (ADR 0081 leniency is load-bearing for rules). */
export interface AccessRule {
  path: string;
  direction: AccessDirection;
  decision: "allow" | "deny";
}

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
  /** (permissions-section) `{path, direction, decision}` exceptions, evaluated
   * by longest canonical prefix. OPTIONAL on purpose: a pre-feature
   * `settings.json` has no `rules` key and the backend defaults it to empty, so
   * read it nullishly. Rules NEVER apply to `bash`. */
  rules?: AccessRule[];
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


// ═══════════════════════════════════════════════════════════════════════════
// The declared `permission:` block (issue #101). Every shape below is a
// BYTE-FOR-BYTE mirror of `src-tauri/src/agent/definition_permission.rs`, and
// the mixed casing is NOT an accident — it is what the Rust serde attributes
// actually produce, and this repo has NO wire-contract test linking the two
// sides (the frontend mocks `invoke`, the Rust tests never emit IPC), so a
// drift here is invisible to BOTH suites. The per-type attribute, restated so a
// future editor cannot "tidy" a snake_case key into camelCase:
//
//   `Action`               `rename_all = "lowercase"`  → `allow` / `ask` / `deny`
//   `Rule`                 NO rename                   → `pattern`, `action`
//   `Rules`                NO rename                   → `patterns`, **`whole_tool`**
//   `PermissionBlock`      NO rename                   → `tools`
//   `ToolKey`              `rename_all = "camelCase"`  → `readSkill`, `webSearch`,
//                                                        `fetchContent`
//   `UnsupportedReason`    `rename_all = "camelCase"`  → `bashPatternRules`,
//                                                        `pathPatternRules`
//   `FrontmatterNote`      `rename_all = "camelCase"`, EXTERNALLY tagged
//
// A `rename_all` on a struct does NOT reach a nested type, which is why
// `whole_tool` stays snake_case inside a camelCase `AgentConfigDto`. Do not
// "fix" it here: the fix, if it ever happens, is a `rename_all` on the Rust
// `Rules`, landed in the same change that re-pins `a_permission_block_serializes_in_file_order`.
//
// The narrowing-only invariant the Rust module pins, and which these types must
// keep un-widenable: *"No shape in this module can express 'allow beyond the
// user's policy' — the actions are exactly `allow | ask | deny` and a per-agent
// `allow` is at most a no-op on the outside of the user's boundary."* Widening
// `AgentPermissionAction` past those three verbs turns the type into a grant.
// ═══════════════════════════════════════════════════════════════════════════

/** One of the three verdicts a declared rule can carry (the Rust `Action`,
 *  `rename_all = "lowercase"`). EXACTLY three — see the narrowing-only note
 *  above the block. */
export type AgentPermissionAction = "allow" | "ask" | "deny";

/** Why a rule could not be used (the Rust `UnsupportedReason`,
 *  `rename_all = "camelCase"`). Two variants, one per pattern CLASS:
 *  `bashPatternRules` for opencode `bash`-style patterns over command text,
 *  `pathPatternRules` for a pattern map on a recognised path-taking tool. Both
 *  are parsed and ANNOUNCED, never enforced — by a matcher (command text) or by
 *  a path resolution (path map) that this layer deliberately does not do. A
 *  `ToolKey::Unrecognized` key gets NEITHER variant. */
export type AgentUnsupportedReason = "bashPatternRules" | "pathPatternRules";

/** One rule of a path-taking tool's ORDERED pattern→action map (the Rust
 *  `Rule`; no `rename_all`, so both keys are already lowercase).
 *  ORDERED: opencode resolves a tool's pattern object in file order and the
 *  LAST matching rule wins — which is why the `"*"` catch-all is written FIRST
 *  and the specifics after it carve out exceptions. Nothing sorts this list. */
export interface AgentPermissionRule {
  pattern: string;
  action: AgentPermissionAction;
}

/** One tool's ruleset (the Rust `Rules`; no `rename_all`).
 *
 *  `whole_tool` is **snake_case** — a struct-level `rename_all` on the parent
 *  DTO never reaches this nested type, and this is the one key in the whole
 *  mirror a camelCase guess would get wrong in silence. */
export interface AgentPermissionRules {
  patterns: AgentPermissionRule[];
  /** True when the file wrote a BARE verdict (`bash: deny`), so the action
   *  applies to ANY argument. Rust stores that as the catch-all `"*"` row PLUS
   *  this flag; an explicit `{"*": deny}` map is the same row with this `false`.
   *  The distinction is why the field exists — "the file said tool-wide" is not
   *  the same claim as "the file said star", and the row renders them
   *  differently. */
  whole_tool: boolean;
}

/** The per-tool discriminant (the Rust `ToolKey`, `rename_all = "camelCase"`,
 *  EXTERNALLY tagged).
 *
 *  The two arms are NOT one string union: the eleven recognised keys arrive as
 *  their camelCase verb, and `ToolKey::Unrecognized(String)` arrives as the
 *  tagged OBJECT `{"unrecognized":"glob"}` — serde wraps a tuple element that is
 *  an enum, so its verbatim name survives. An unrecognised key is a FIRST-CLASS
 *  case, never a drop: the silent-drop class #101 exists to fix has no path
 *  through this type. Note this is deliberately NOT widened with `(string & {})`
 *  — the wire never sends a bare unknown string, and admitting one would let a
 *  typo of a recognised key type-check. */
export type AgentToolKey =
  | "edit"
  | "read"
  | "bash"
  | "write"
  | "find"
  | "grep"
  | "ls"
  /** The frontmatter key is `read_skill`. */
  | "readSkill"
  /** The `permission:`-block `ask:` KEY — a verdict-bearing tool key, NOT the
   *  interactive `ask` TOOL. Different spell, same word. */
  | "ask"
  | "webSearch"
  | "fetchContent"
  /** Any other tool name (opencode has `glob`, `task`, `lsp`, …), kept verbatim
   *  so the ruleset stays REPRESENTABLE. */
  | { unrecognized: string };

/** The FULL declared block, IN FILE ORDER (the Rust `PermissionBlock`; no
 *  `rename_all`).
 *
 *  `tools` is an ORDERED ARRAY OF PAIRS, because Rust serializes
 *  `Vec<(ToolKey, Rules)>` as a 2-element JSON array — `[["edit", {…}], …]` —
 *  NOT as an object. A `{ edit: {…} }` literal here would not type-check, and
 *  that is the point: a map cannot hold two tools in an order, and last-match-
 *  wins ordering is the whole semantics of the block. */
export interface AgentPermissionBlock {
  tools: [AgentToolKey, AgentPermissionRules][];
}

/** One "the file said something the reader does not understand" note (the Rust
 *  `FrontmatterNote`) — the ANNOUNCE half of #101: a report, never an error.
 *
 *  EXTERNALLY tagged: one object keyed by the camelCase variant name, e.g.
 *  `{"unknownKey":"mode"}`. It is NOT `{kind:"unknownKey", value:"mode"}` —
 *  `#[serde(tag = "kind")]` was tried and REJECTED, because serde's
 *  internally-tagged representation can only tag payloads that serialize as a
 *  MAP and every payload here is a bare `String`/unit, so it would compile and
 *  then fail at RUNTIME on the first wire send. Pinned in Rust by
 *  `frontmatter_notes_serialize_as_a_tagged_object_per_note`; read here by
 *  discriminating on the KEY, which is the only thing the wire carries. */
export type AgentFrontmatterNote =
  /** A top-level frontmatter key the desktop does not read (`mode:`,
   *  `temperature:`). `{"unknownKey":"permission"}` means the `permission:` line
   *  yielded NOTHING readable — the key itself is known. */
  | { unknownKey: string }
  /** A recognised-but-unpoliced tool name, kept verbatim. */
  | { unrecognizedToolKey: string }
  /** A pattern block this desktop does not police (either reason class — see
   *  [`AgentUnsupportedReason`]): parsed, announced unsupported, never enforced. */
  | { unsupportedUnvalidatedMatcher: AgentUnsupportedReason }
  /** A verdict the parser does not recognise — the unknown spelling, verbatim. */
  | { unknownAction: string };


/**
 * One field-triple of the Agents modal's report (the Rust `OverrideFields`).
 * The four `Option`s are serialized ALWAYS PRESENT — no `skip_serializing_if`
 * — so "this column has no value" arrives as `null` and the fields are
 * `… | null`, NOT optional. That is the deliberate opposite of `AgentOverride`,
 * where absence is the only meaning of "does not speak": these are ROWS of a
 * report the modal renders (as `Inherits parent`), not the stored document.
 */
export interface AgentOverrideFields {
  model: string | null;
  thinking: string | null;
  tools: string[] | null;
  /** The declared `permission:` ruleset as THIS layer sees it (issue #101).
   *  Only the `file` column can ever be non-`null`: the stored entry has no
   *  `permission` key at all (ADR 0066's shape is `model`/`thinking`/`tools`,
   *  and absence is its ONLY meaning), so `override.permission` is `null` by
   *  construction. The column exists anyway so the three columns stay ONE
   *  shape, which is what lets the wire pin iterate the same four keys over
   *  each of them. */
  permission: AgentPermissionBlock | null;
}


/** Which layer supplied each of the report's four fields (the Rust
 *  `SourceFields`). */
export interface AgentOverrideSources {
  model: OverrideSource;
  thinking: OverrideSource;
  tools: OverrideSource;
  /** Which layer supplied `permission` (issue #101). There is NO settings.json
   *  permission layer, so Rust reports `file` exactly when the definition
   *  declared a block and `parent` when it did not — NEVER `override`, and NO
   *  fourth `OverrideSource` variant exists for it. Verified against the actual
   *  enum (`launch.rs`): `OverrideSource` is `Override | File | Parent`, three
   *  variants, and the permission layer REUSES it rather than inventing a word. */
  permission: OverrideSource;
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
  /** The definition file's declared `permission:` block, VERBATIM (issue #101),
   *  or `null` when the file does not speak about permissions.
   *
   *  The wire name is `filePermission` — the Rust field is `file_permission`
   *  under the DTO's `rename_all = "camelCase"`, and it is NOT `permission`:
   *  `permission` is the name of the three COLUMN structs' fourth field
   *  (`AgentOverrideFields.permission`), which carries the same block from one
   *  layer's point of view. This one is the row-level "what the file declared"
   *  copy, and it is deliberately NOT an effective verdict — the gate's
   *  strict-of-two merge against the user's policy is a RUNTIME decision, so no
   *  static row can report it.
   *
   *  `Option` on the Rust side and therefore `| null` here (NOT `?`): the DTO
   *  has no `skip_serializing_if`, so the key always arrives. */
  filePermission: AgentPermissionBlock | null;
  /** The file-READ announce notes (issue #101): unknown top-level keys,
   *  unrecognised tool keys, unsupported bash-pattern rows, unknown verdicts.
   *  REQUIRED, not optional, on the `shadowed` precedent — Rust always
   *  serializes the `Vec` (empty as `[]`, never `null`), and a clean file's `[]`
   *  renders nothing. */
  frontmatterNotes: AgentFrontmatterNote[];
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


export interface HistoryPage {
  rows: MessageRow[];
  hasMore: boolean;
  todos?: unknown[] | null;
}


/** The `session-titled` payload: a generated session title. */
export interface SessionTitledPayload {
  sessionId: string;
  title: string;
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


// ---------------------------------------------------------------------------
// Window state (Linux tiling / snap detection)
// ---------------------------------------------------------------------------

export interface WindowFrameState {
  isTiled: boolean;
  isMaximized: boolean;
  isFullscreen: boolean;
  native: boolean;
}
