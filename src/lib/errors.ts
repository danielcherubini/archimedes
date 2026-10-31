/**
 * The TS mirror of the IPC error envelope — TYPES ONLY, no helpers, no prose.
 *
 * ADR 0063 (`docs/decisions/0063-ipc-errors-carry-a-kind-and-a-message.md`)
 * fixes the envelope and says why the sentence is written in Rust: the producer
 * is `src-tauri/src/agent/errors.rs`, and the renderer only CHOOSES which
 * available string to show (`describeIpcError` in `./ipcError`). Nothing in this
 * file builds a sentence from a `kind`, translates one, or pattern-matches one
 * into prose — the same doctrine `ipcError.ts` states for the renderer.
 *
 * The envelope is HAND-BUILT in Rust — `From<SessionError> for
 * tauri::ipc::InvokeError` inserts `"kind"` / `"message"` / the variant's own
 * field into a `serde_json::Map` by hand, with NO serde derive anywhere in the
 * route to the wire (ADR 0063's load-bearing half: a payload the envelope
 * cannot express is a compile error in `errors.rs`, never a wrong sentence on
 * the user's screen). These types therefore mirror an object the Rust side
 * constructs by hand — nothing serde-generated backs the spellings, and the
 * only arbiter is the Rust drift pins quoted on each union below.
 *
 * This module is type-only and DIRECT-imported (the `ipcError.ts` precedent —
 * `McpSection.tsx` already imports `describeIpcError` directly, not through the
 * barrel), so it never touches the `@/lib/tauri` barrel, `tauriBarrel.test.ts`
 * or `tauriBoundary.test.ts`.
 *
 * The kind unions are copied VERBATIM from the frozen drift-pin spellings in
 * `src-tauri/src/agent/errors.rs` (task14). A spelling drift must fail the Rust
 * drift pin first; the TS mirror exists so a drift cannot hide on this side
 * either. Never invent a kind here that the Rust side does not produce.
 */

/**
 * The wire shape every typed IPC rejection carries:
 * `{"kind", "message", …the variant's own field}` — the hand-built body of
 * `From<*Error> for tauri::ipc::InvokeError` in
 * `src-tauri/src/agent/errors.rs` (the `SessionError` arm is the quoted
 * pattern: `kind` = the discriminator, `message` = the `#[error(…)]` Display
 * sentence, ALWAYS present and non-empty, plus at most the variant's own
 * extra field).
 */
export interface IpcErrorEnvelope {
  /** The machine-readable discriminator (the unions below enumerate the values). */
  kind: string;
  /** The human sentence, written in Rust (ADR 0063). What `describeIpcError` renders. */
  message: string;
  /** The variant's own extra field (`path`, `error`, `id`, `size`, …) — presence varies. */
  [extra: string]: unknown;
}

/**
 * `HistoryError` — frozen by the Rust drift pin
 * `history_error_kind_spellings_are_frozen`
 * (`src-tauri/src/agent/errors.rs`, task14 Step 2a), which asserts exactly
 * `["sqlite", "io", "json"]` and names this union as its frontend mirror.
 */
export type HistoryErrorKind = "sqlite" | "io" | "json";

/**
 * `AttentionError` — frozen by the Rust drift pin
 * `attention_error_kind_spellings_are_frozen` (task14 Step 2c: "pick one, the
 * drift pin freezes it"). task14 LANDED the family-prefixed candidate pair, so
 * the plan's `UNVERIFIED-until-task14` flag is CLEARED: the pin froze
 * `["attention_empty_body", "attention_no_runtime"]` and this union copies that
 * frozen list.
 */
export type AttentionErrorKind = "attention_empty_body" | "attention_no_runtime";

/**
 * `ClipboardError` — frozen by the Rust drift pin
 * `clipboard_error_kind_spellings_are_frozen` (task14 Step 2d): exactly
 * `["clipboard", "encode"]`.
 */
export type ClipboardErrorKind = "clipboard" | "encode";

/**
 * `OpenError` — frozen by the Rust drift pin
 * `open_error_kind_of_maps_the_refusal_codes` (task14 Step 2e), whose
 * `kind_of` table maps the refusal codes onto exactly these five spellings
 * (`other` is the documented catch-all arm; the pin asserts the vocabulary is
 * "five values, not six"). The `message` on the wire is the refusal code
 * VERBATIM (`denied-scheme:…`, `relative-without-cwd`, `os-error:…`).
 */
export type OpenErrorKind =
  | "invalid_href"
  | "denied_scheme"
  | "relative_without_cwd"
  | "os_error"
  | "other";

/**
 * `UpdateError` — the thirteen values of the Rust drift pin
 * `update_error_kind_of_maps_the_frozen_code_table` (task14 Step 2f): the
 * twelve spellings that pin freezes verbatim (besides `other`) plus `other`
 * itself, the table's documented catch-all ("the thirteenth value in the
 * frontend union is `other`"). The `message` on the wire is the updater code
 * VERBATIM (`release-not-found`, `network:…`).
 */
export type UpdateErrorKind =
  | "release_not_found"
  | "endpoints_not_configured"
  | "network"
  | "invalid_target"
  | "signature_mismatch"
  | "install_failed"
  | "install_in_progress"
  | "no_update_available"
  | "unsupported_platform"
  | "invalid_update_format"
  | "authentication_failed"
  | "io"
  | "other";

/**
 * `SessionError` — the pre-existing family (the hand-built envelope's
 * original). Copied from `SessionError::kind` in
 * `src-tauri/src/agent/errors.rs`, byte-identical to what the deleted
 * `#[serde(rename_all = "snake_case")]` derive produced.
 */
export type SessionErrorKind =
  | "io"
  | "command"
  | "unknown_session"
  | "not_resumable"
  | "folder_missing"
  | "invalid_prompt"
  | "settle_timeout";

/**
 * `FilesError` — the pre-existing family behind the file listing commands
 * (`list_space_listing`, `list_completion_entries`) and `read_file_bytes`.
 * Copied from the `FilesError` arm of the hand-built envelope in
 * `src-tauri/src/agent/errors.rs`.
 */
export type FilesErrorKind = "image_too_large" | "io";

/**
 * `SettingsError` — the full family as `SettingsError::kind` in
 * `src-tauri/src/agent/errors.rs` enumerates it today (the wire vocabulary;
 * every command in `commands/settings.rs` emits one of these).
 */
export type SettingsErrorKind =
  | "save_failed"
  | "invalid_mcp_server"
  | "mcp_test_failed"
  | "mcp_auth_failed"
  | "unknown_search_provider"
  | "search_not_configured"
  | "search_timeout"
  | "search_failed"
  | "other";

/**
 * The SettingsError kinds the MCP-test seam can answer with, as the plan's
 * frozen list (the `test_mcp_server` wire today).
 *
 * The auth case has NO kind today: a 401-on-OAuth test rejects with
 * `kind: "mcp_test_failed"` and `message: "MCP server test failed:
 * needs-auth"` — the marker rides inside the sentence, no machine
 * discriminator exists. `McpSection`'s badge needs exactly that discriminator,
 * and the blocked candidate (`"needs_auth"`) joins this union ONLY when the
 * Rust side lands it (blocked-on-task14/14c — see
 * `src/components/settings/McpSection.test.tsx`). Until then, do not branch on
 * a kind the wire never sends.
 */
export type McpTestErrorKind = "mcp_test_failed" | "invalid_mcp_server" | "other";
