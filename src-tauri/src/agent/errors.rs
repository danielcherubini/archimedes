//! Errors for the session and files layers: `SessionError` and `FilesError`.
//! (the read-only pre-approval `FsBackend` has its own local `FsError`
//! in `fs_backend.rs`).
//!
//! The wire contract this file implements — the `{kind, message, …}` envelope,
//! the rule that RUST owns the sentence the user reads, and why there is no
//! `Serialize` derive — is ADR 0063
//! (`docs/decisions/0063-ipc-errors-carry-a-kind-and-a-message.md`).

use crate::storage::DbError;

/// Errors surfaced by the session layer.
///
/// Carries NO serde derive, on purpose: the only route from here to the wire
/// is the hand-written `impl From<SessionError> for tauri::ipc::InvokeError`
/// below. Tauri's own blanket `From` impl for every serde-encodable error type
/// (`tauri-2.12.2/src/ipc/mod.rs:240-247`) would otherwise win, and it replaces
/// a payload serde cannot encode with the serde complaint itself — which is
/// what `Io(String)` did (an internally-tagged enum cannot encode a newtype
/// variant containing a string), so 13 rejection sites showed the user
/// `"cannot serialize tagged newtype variant SessionError::Io containing a
/// string"` instead of the reason. With no derive, such a payload is a COMPILE
/// error in this file instead of a wrong sentence on screen.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// A filesystem read-write failure.
    #[error("i/o error: {0}")]
    Io(String),

    /// A command failed.
    #[error("command failed: {error}")]
    Command { error: String },

    /// No live session with the given id exists.
    #[error("unknown session: {id}")]
    UnknownSession { id: String },

    /// The stored session cannot be resumed (a stored row with
    /// `loadSession: false` has no native transcript to load).
    #[error("session {id} cannot be resumed")]
    NotResumable { id: String },

    /// The requested working directory does not exist (or is not a folder).
    #[error("folder not found: {path}")]
    FolderMissing { path: String },

    /// A user prompt payload failed validation (invalid image mime type,
    /// oversized image).
    #[error("invalid prompt payload: {reason}")]
    InvalidPrompt { reason: String },

    /// The turn did not settle within the turn's settle BOUND (a hung turn).
    /// UNCONSTRUCTED today (the session layer has no turn-level bound); the
    /// serialised `kind` string is part of the IPC contract, so this variant's
    /// NAME is deliberately untouched by the ADR 0055 subagent rename — it is
    /// the MAIN-session turn vocabulary, not the subagent **Dead bound**.
    #[error("settle timeout: {detail}")]
    SettleTimeout { detail: String },
}

impl SessionError {
    /// The serialized `kind` discriminator (the wire contract — ADR 0063).
    ///
    /// Byte-identical to what the deleted `#[serde(rename_all = "snake_case")]`
    /// produced, so anything already reading `kind` keeps working. Exhaustive:
    /// a new variant has to be named here AND in the `From` impl below, which
    /// is the point — the bug class this file used to hide.
    fn kind(&self) -> &'static str {
        match self {
            SessionError::Io(_) => "io",
            SessionError::Command { .. } => "command",
            SessionError::UnknownSession { .. } => "unknown_session",
            SessionError::NotResumable { .. } => "not_resumable",
            SessionError::FolderMissing { .. } => "folder_missing",
            SessionError::InvalidPrompt { .. } => "invalid_prompt",
            SessionError::SettleTimeout { .. } => "settle_timeout",
        }
    }
}

/// The IPC envelope: `{"kind", "message", …the variant's own field}` — the
/// contract, and the reason it is hand-built rather than derived, is ADR 0063.
///
/// `message` is the `#[error(...)]` Display sentence and is ALWAYS present and
/// non-empty — it is the key the frontend renders, and the reason the payload
/// is built by hand. `kind` is the machine-readable discriminator, and the
/// variant's field keeps the name the old derived shape gave it, so structured
/// consumers are unaffected.
///
/// `tauri::ipc::InvokeError`'s single field is `pub`
/// (`tauri-2.12.2/src/ipc/mod.rs:224`), so the envelope is constructible here.
impl From<SessionError> for tauri::ipc::InvokeError {
    fn from(err: SessionError) -> Self {
        // Exhaustive on purpose: no catch-all arm, so a future variant is a
        // compile error in this file rather than a runtime serialization
        // failure on the user's screen.
        let extra: Option<(&'static str, String)> = match &err {
            // The payload is already the whole `message` ("i/o error: …"), so
            // `Io` adds no key.
            SessionError::Io(_) => None,
            SessionError::Command { error } => Some(("error", error.clone())),
            SessionError::UnknownSession { id } => Some(("id", id.clone())),
            SessionError::NotResumable { id } => Some(("id", id.clone())),
            SessionError::FolderMissing { path } => Some(("path", path.clone())),
            SessionError::InvalidPrompt { reason } => Some(("reason", reason.clone())),
            SessionError::SettleTimeout { detail } => Some(("detail", detail.clone())),
        };

        let mut body = serde_json::Map::new();
        body.insert("kind".into(), serde_json::Value::String(err.kind().into()));
        body.insert("message".into(), serde_json::Value::String(err.to_string()));
        if let Some((key, value)) = extra {
            body.insert(key.into(), serde_json::Value::String(value));
        }

        tauri::ipc::InvokeError(serde_json::Value::Object(body))
    }
}

/// Errors surfaced by the history commands.
///
/// The five `DbError`-backed commands in `commands/history.rs`
/// (`load_history`, `set_session_archived`, `delete_session`,
/// `session_recency`, `reorder_sessions`). `list_sessions` is NOT one of them:
/// it delegates to `SessionManager::list_sessions` and returns `SessionError`
/// directly — the error type is chosen by the wire, not by the file (ADR 0063).
///
/// `From<DbError>` maps each `DbError` variant to its OWN kind, so "history
/// won't load" can say whether SQLite, the disk or a JSON payload failed —
/// the discrimination Finding 20 measured as lost when the commands flattened
/// `DbError` to a `String`.
///
/// Carries NO serde derive, for `SessionError`'s reason (ADR 0063): the only
/// route to the wire is the hand-written `From` below, so a payload the
/// envelope cannot express is a compile error in this file, never a wrong
/// sentence on the user's screen.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HistoryError {
    /// SQLite itself refused the statement or the transaction.
    #[error("sqlite error: {0}")]
    Sqlite(String),

    /// The filesystem under the database failed.
    #[error("io error: {0}")]
    Io(String),

    /// A stored JSON payload could not be decoded.
    #[error("json error: {0}")]
    Json(String),
}

impl HistoryError {
    /// The serialized `kind` discriminator (the wire contract — ADR 0063).
    /// Exhaustive: a new variant has to be named here AND in the `From` impl
    /// below, which is the point.
    pub fn kind(&self) -> &'static str {
        match self {
            HistoryError::Sqlite(_) => "sqlite",
            HistoryError::Io(_) => "io",
            HistoryError::Json(_) => "json",
        }
    }
}

/// Each `DbError` variant keeps its own identity across the wire, and the
/// `message` half is the inner error's `Display` — so the sentence the user
/// reads is the one the flattened `String` carried before, byte-identical.
impl From<DbError> for HistoryError {
    fn from(e: DbError) -> Self {
        match e {
            DbError::Sqlite(e) => HistoryError::Sqlite(e.to_string()),
            DbError::Io(e) => HistoryError::Io(e.to_string()),
            DbError::Json(e) => HistoryError::Json(e.to_string()),
        }
    }
}

/// The IPC envelope: `{"kind", "message"}` — hand-built, no derive (ADR 0063).
///
/// No variant adds a field beyond those two: each newtype payload already IS
/// the whole `message` (`"sqlite error: …"`), the `SessionError::Io` precedent.
impl From<HistoryError> for tauri::ipc::InvokeError {
    fn from(err: HistoryError) -> Self {
        // Exhaustive on purpose: no catch-all arm, so a future variant is a
        // compile error here rather than a runtime failure on screen. A variant
        // that carries a field of its own has to name it here — the second of
        // the two namings ADR 0063 requires of every new variant.
        let extra: Option<(&'static str, String)> = match &err {
            // The payload already IS the whole `message` ("sqlite error: …"),
            // so no variant of this enum adds a key — the `SessionError::Io`
            // precedent.
            HistoryError::Sqlite(_) | HistoryError::Io(_) | HistoryError::Json(_) => None,
        };

        let mut body = serde_json::Map::new();
        body.insert("kind".into(), serde_json::Value::String(err.kind().into()));
        body.insert("message".into(), serde_json::Value::String(err.to_string()));
        if let Some((key, value)) = extra {
            body.insert(key.into(), serde_json::Value::String(value));
        }

        tauri::ipc::InvokeError(serde_json::Value::Object(body))
    }
}

/// Errors surfaced by the two attention commands (`attention_arm`,
/// `attention_disarm`).
///
/// The two `#[error(…)]` sentences are the ones `commands/attention.rs`
/// produced as bare `Err(String)`s — moved here VERBATIM so the wire `message`
/// is byte-identical to the sentence the renderer logged before this enum
/// existed (Finding 20's wire wall). `alert_text` and `AttentionTimer::arm`
/// keep their own `String` errors as non-command helpers; the command maps them
/// onto these two variants.
///
/// Carries NO serde derive (ADR 0063's load-bearing half): the only route to
/// the wire is the hand-written `From` below.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AttentionError {
    /// The renderer composed an alert with no body, so there is nothing to show.
    #[error("attention_arm: empty alert body (the renderer composed nothing)")]
    EmptyBody,

    /// There is no tokio runtime to hold the countdown, so the alert can never fire.
    #[error("attention_arm: no tokio runtime to hold the countdown")]
    NoRuntime,
}

impl AttentionError {
    /// The serialized `kind` discriminator (the wire contract — ADR 0063).
    ///
    /// The FROZEN spelling pair is `attention_empty_body` / `attention_no_runtime`
    /// — the family-prefixed candidate the plan offered first, chosen for
    /// `SettingsError::mcp_test_failed`'s reason: a bare `empty_body` says nothing
    /// about which wire it came from once several families share one frontend
    /// union. `attention_error_kind_spellings_are_frozen` freezes it; the frontend
    /// mirror lands `export type AttentionErrorKind = "attention_empty_body" | "attention_no_runtime";`
    /// (`src/lib/tauri/types.ts`, task14b) by copying THAT list, never by guessing.
    pub fn kind(&self) -> &'static str {
        match self {
            AttentionError::EmptyBody => "attention_empty_body",
            AttentionError::NoRuntime => "attention_no_runtime",
        }
    }
}

impl From<AttentionError> for tauri::ipc::InvokeError {
    fn from(err: AttentionError) -> Self {
        // Exhaustive on purpose: no catch-all arm, so a new variant has to be
        // named here AND in `kind()` (ADR 0063).
        let extra: Option<(&'static str, String)> = match &err {
            // Both variants are field-less: the `#[error(…)]` sentence IS the
            // whole payload, so nothing is added beyond kind + message.
            AttentionError::EmptyBody | AttentionError::NoRuntime => None,
        };

        let mut body = serde_json::Map::new();
        body.insert("kind".into(), serde_json::Value::String(err.kind().into()));
        body.insert("message".into(), serde_json::Value::String(err.to_string()));
        if let Some((key, value)) = extra {
            body.insert(key.into(), serde_json::Value::String(value));
        }

        tauri::ipc::InvokeError(serde_json::Value::Object(body))
    }
}

/// Errors surfaced by the clipboard image command (`read_clipboard_image`).
///
/// The two sentences the command can produce are the arboard error's own
/// `Display` and the two-tier byte-cap sentences that live in
/// `commands/clipboard.rs::rgba_to_png_bytes` (a non-command helper whose own
/// tests pin them). This enum adds the family prefix the `kind` already names;
/// the inner sentence is forwarded unchanged.
///
/// Carries NO serde derive (ADR 0063's load-bearing half).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClipboardError {
    /// The clipboard could not be acquired or read (an arboard failure).
    #[error("clipboard error: {0}")]
    Clipboard(String),

    /// The clipboard image was read but could not be PNG-encoded within the caps.
    #[error("clipboard image encode failed: {0}")]
    Encode(String),
}

impl ClipboardError {
    /// The serialized `kind` discriminator (the wire contract — ADR 0063).
    /// Frozen by `clipboard_error_kind_spellings_are_frozen`; the frontend
    /// mirror lands `export type ClipboardErrorKind = "clipboard" | "encode";`.
    pub fn kind(&self) -> &'static str {
        match self {
            ClipboardError::Clipboard(_) => "clipboard",
            ClipboardError::Encode(_) => "encode",
        }
    }
}

impl From<ClipboardError> for tauri::ipc::InvokeError {
    fn from(err: ClipboardError) -> Self {
        // Exhaustive on purpose: no catch-all arm (ADR 0063).
        let extra: Option<(&'static str, String)> = match &err {
            // The newtype payload lives inside `message`, so no extra key — the
            // `SessionError::Io` precedent.
            ClipboardError::Clipboard(_) | ClipboardError::Encode(_) => None,
        };

        let mut body = serde_json::Map::new();
        body.insert("kind".into(), serde_json::Value::String(err.kind().into()));
        body.insert("message".into(), serde_json::Value::String(err.to_string()));
        if let Some((key, value)) = extra {
            body.insert(key.into(), serde_json::Value::String(value));
        }

        tauri::ipc::InvokeError(serde_json::Value::Object(body))
    }
}

/// Errors surfaced by the external-open command (`external_open`).
///
/// A NEWTYPE over [`crate::open`]`::Refusal`'s frozen kebab refusal codes
/// (`empty`, `denied-scheme:{scheme}`, `bad-file-url:{href}`,
/// `relative-without-cwd`) plus the opener plugin's `os-error:{e}`. `crate::open`
/// is NOT touched by this migration — its code table and its own tests stand —
/// and `message` IS the code VERBATIM, because the `externalOpen` wrapper logs
/// exactly that string and a bug report is read from it.
///
/// `kind` is DERIVED from the code by [`OpenError::kind_of`] (a pure fn pinned
/// by its own test), so the envelope gains the machine discriminator without
/// editing the sentence by a single character.
///
/// Carries NO serde derive (ADR 0063's load-bearing half): the only route to the
/// wire is the hand-written `From` below.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    /// `message` = the refusal code verbatim (`crate::open`'s vocabulary:
    /// `empty` / `denied-scheme:{scheme}` / `relative-without-cwd` / `os-error:{e}`).
    #[error("{0}")]
    Code(String),
}

impl OpenError {
    /// The `kind` for a refusal code: the code's own vocabulary, snake_cased.
    ///
    /// A total function over `&str` (the code space is open — the `os-error:`
    /// and `denied-scheme:` payloads are free text), so the fallback arm is the
    /// plan's named `other`, and `bad-file-url:{href}` — the fourth
    /// `crate::open` refusal, which no command-level test reaches — deliberately
    /// lands there rather than growing the frozen vocabulary. Frozen by
    /// `open_error_kind_of_maps_the_refusal_codes`; the frontend mirror lands
    /// `export type OpenErrorKind = "invalid_href" | "denied_scheme" |
    /// "relative_without_cwd" | "os_error" | "other";`.
    pub fn kind_of(code: &str) -> &'static str {
        match code {
            "empty" => "invalid_href",
            s if s.starts_with("denied-scheme:") => "denied_scheme",
            "relative-without-cwd" => "relative_without_cwd",
            s if s.starts_with("os-error:") => "os_error",
            // Includes `bad-file-url:{href}` (the fourth `crate::open` refusal,
            // unreachable from this command's own tests) and any code a future
            // policy adds — the sentence still reaches the user unchanged.
            _ => "other",
        }
    }

    /// The serialized `kind` discriminator (the wire contract — ADR 0063).
    pub fn kind(&self) -> &'static str {
        // Exhaustive on purpose: no catch-all arm, so a second variant has to
        // be named here AND in the `From` match below (ADR 0063).
        match self {
            OpenError::Code(code) => Self::kind_of(code),
        }
    }
}

impl From<OpenError> for tauri::ipc::InvokeError {
    fn from(err: OpenError) -> Self {
        // Exhaustive on purpose: no catch-all arm — the second naming site ADR
        // 0063 requires of every new variant.
        let extra: Option<(&'static str, String)> = match &err {
            // The refusal code IS the whole `message`, so no extra key — the
            // `SessionError::Io` precedent.
            OpenError::Code(_) => None,
        };

        let mut body = serde_json::Map::new();
        body.insert("kind".into(), serde_json::Value::String(err.kind().into()));
        body.insert("message".into(), serde_json::Value::String(err.to_string()));
        if let Some((key, value)) = extra {
            body.insert(key.into(), serde_json::Value::String(value));
        }

        tauri::ipc::InvokeError(serde_json::Value::Object(body))
    }
}

/// The updater family's wire error (`check_update`, `install_update`).
///
/// A NEWTYPE over the FROZEN kebab-code vocabulary `map_check_error` produces
/// in `commands/update.rs` (`release-not-found`, `endpoints-not-configured`,
/// `network:{s}`, `invalid-target:{t}`, `signature-mismatch`, `install-failed`,
/// `install-in-progress`, `no-update-available`, `unsupported-platform`,
/// `invalid-update-format`, `authentication-failed`, `io:{s}`,
/// `update-error:{s}`). `message` IS the code verbatim — the frontend renders it
/// (`UpdateSection.tsx` through `describeIpcError`) and `UpdateSection.test.tsx`
/// pins `release-not-found` / `install-failed` reaching the UI, so this type is
/// ALLOWED TO CHANGE NOTHING about the sentence. `map_check_error` itself is not
/// a command and is unchanged.
///
/// `kind` is derived by [`UpdateError::kind_of`] (a pure fn pinned by its own
/// test), which is the whole gain of the migration: the machine-readable
/// discriminator appears, the human-readable code does not move.
///
/// Carries NO serde derive (ADR 0063's load-bearing half): the only route to the
/// wire is the hand-written `From` below, so an unencodable payload is a compile
/// error in this file rather than the encoder's complaint on the user's screen.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UpdateError(pub String);

impl UpdateError {
    /// The `kind` for an updater code: the code's own vocabulary, snake_cased.
    ///
    /// Total over `&str` because three of the codes carry a free-text detail
    /// after a colon (`network:{s}`, `io:{s}`, `update-error:{s}`), so those
    /// three are matched by PREFIX. `update-error:` answers `other` on purpose:
    /// it is `map_check_error`'s own fallback arm — the plugin's open enum
    /// beyond the named codes — and mirroring the fallback in both layers keeps
    /// "a code nobody named" one answer instead of two. Frozen by
    /// `update_error_kind_of_maps_the_frozen_code_table`; the frontend mirror
    /// lands the same thirteen values in `src/lib/tauri/types.ts`.
    pub fn kind_of(code: &str) -> &'static str {
        match code {
            "release-not-found" => "release_not_found",
            "endpoints-not-configured" => "endpoints_not_configured",
            "signature-mismatch" => "signature_mismatch",
            "install-failed" => "install_failed",
            "install-in-progress" => "install_in_progress",
            "no-update-available" => "no_update_available",
            "unsupported-platform" => "unsupported_platform",
            "invalid-update-format" => "invalid_update_format",
            "authentication-failed" => "authentication_failed",
            s if s.starts_with("network:") => "network",
            s if s.starts_with("invalid-target:") => "invalid_target",
            s if s.starts_with("io:") => "io",
            // `update-error:{…}` (map_check_error's own fallback) and anything a
            // future plugin bump surfaces: the sentence still reaches the user
            // unchanged, and `kind` declines to guess.
            _ => "other",
        }
    }

    /// The serialized `kind` discriminator (the wire contract — ADR 0063).
    pub fn kind(&self) -> &'static str {
        // Exhaustive on purpose: the newtype has one shape today, and naming it
        // here is the second of the two namings ADR 0063 requires — a second
        // variant or a second field has to be accounted for at compile time.
        match self {
            UpdateError(code) => Self::kind_of(code),
        }
    }
}

impl From<UpdateError> for tauri::ipc::InvokeError {
    fn from(err: UpdateError) -> Self {
        // Exhaustive on purpose: no catch-all arm (ADR 0063).
        let extra: Option<(&'static str, String)> = match &err {
            // The code IS the whole `message` ("release-not-found"), so no extra
            // key — the `SessionError::Io` precedent.
            UpdateError(_) => None,
        };

        let mut body = serde_json::Map::new();
        body.insert("kind".into(), serde_json::Value::String(err.kind().into()));
        body.insert("message".into(), serde_json::Value::String(err.to_string()));
        if let Some((key, value)) = extra {
            body.insert(key.into(), serde_json::Value::String(value));
        }

        tauri::ipc::InvokeError(serde_json::Value::Object(body))
    }
}

/// Errors surfaced by file commands (`read_file_bytes`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FilesError {
    #[error("the file is {size} bytes, which exceeds the 10 MiB limit")]
    ImageTooLarge { size: u64, max: u64 },
    #[error("i/o error: {0}")]
    Io(String),
}

impl From<FilesError> for tauri::ipc::InvokeError {
    fn from(e: FilesError) -> Self {
        let kind = match &e {
            FilesError::ImageTooLarge { .. } => "image_too_large",
            FilesError::Io(_) => "io",
        };
        let mut map = serde_json::Map::new();
        map.insert("kind".into(), serde_json::Value::String(kind.into()));
        map.insert("message".into(), serde_json::Value::String(e.to_string()));
        if let FilesError::ImageTooLarge { size, max } = e {
            map.insert("size".into(), serde_json::Value::Number(size.into()));
            map.insert("max".into(), serde_json::Value::Number(max.into()));
        }
        tauri::ipc::InvokeError(serde_json::Value::Object(map))
    }
}

trait InvokeErrorExt {
    fn from_value(value: serde_json::Value) -> Self;
}

impl InvokeErrorExt for tauri::ipc::InvokeError {
    fn from_value(value: serde_json::Value) -> Self {
        Self(value)
    }
}

/// Errors surfaced by settings commands.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("failed to save settings: {0}")]
    SaveFailed(String),

    #[error("invalid MCP server entry ({0})")]
    InvalidMcpServer(String),

    #[error("MCP server test failed: {0}")]
    McpTestFailed(String),

    #[error("MCP server auth failed: {0}")]
    McpAuthFailed(String),

    #[error("Unknown search provider '{0}'. Valid providers: {1}")]
    UnknownSearchProvider(String, String),

    #[error("Search provider '{0}' is not configured with an API key or URL")]
    SearchNotConfigured(String),

    #[error("Search provider '{0}' timed out after 10s")]
    SearchTimeout(String),

    #[error("search provider failed: {0}")]
    SearchFailed(String),

    #[error("{0}")]
    Other(String),
}

impl SettingsError {
    pub fn kind(&self) -> &'static str {
        match self {
            SettingsError::SaveFailed(_) => "save_failed",
            SettingsError::InvalidMcpServer(_) => "invalid_mcp_server",
            SettingsError::McpTestFailed(_) => "mcp_test_failed",
            SettingsError::McpAuthFailed(_) => "mcp_auth_failed",
            SettingsError::UnknownSearchProvider(_, _) => "unknown_search_provider",
            SettingsError::SearchNotConfigured(_) => "search_not_configured",
            SettingsError::SearchTimeout(_) => "search_timeout",
            SettingsError::SearchFailed(_) => "search_failed",
            SettingsError::Other(_) => "other",
        }
    }
}

impl From<SettingsError> for tauri::ipc::InvokeError {
    fn from(err: SettingsError) -> Self {
        let payload = serde_json::json!({
            "kind": err.kind(),
            "message": err.to_string(),
        });
        Self::from_value(payload)
    }
}

/// Errors surfaced by space registry commands.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpacesError {
    #[error("no such folder: {0}")]
    FolderNotFound(String),

    #[error("not a folder: {0}")]
    NotAFolder(String),

    #[error("database error: {0}")]
    Database(String),

    #[error("{0}")]
    Other(String),
}

impl SpacesError {
    pub fn kind(&self) -> &'static str {
        match self {
            SpacesError::FolderNotFound(_) => "folder_not_found",
            SpacesError::NotAFolder(_) => "not_a_folder",
            SpacesError::Database(_) => "database",
            SpacesError::Other(_) => "other",
        }
    }
}

impl From<rusqlite::Error> for SpacesError {
    fn from(e: rusqlite::Error) -> Self {
        SpacesError::Database(e.to_string())
    }
}

impl From<SpacesError> for tauri::ipc::InvokeError {
    fn from(err: SpacesError) -> Self {
        let payload = serde_json::json!({
            "kind": err.kind(),
            "message": err.to_string(),
        });
        Self::from_value(payload)
    }
}

/// Errors surfaced by MCP commands.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum McpError {
    #[error("failed to load MCP servers: {0}")]
    LoadFailed(String),

    #[error("server not found: {0}")]
    NotFound(String),

    #[error("MCP operation failed: {0}")]
    Failed(String),

    #[error("{0}")]
    Other(String),
}

impl McpError {
    pub fn kind(&self) -> &'static str {
        match self {
            McpError::LoadFailed(_) => "load_failed",
            McpError::NotFound(_) => "not_found",
            McpError::Failed(_) => "failed",
            McpError::Other(_) => "other",
        }
    }
}

impl From<McpError> for tauri::ipc::InvokeError {
    fn from(err: McpError) -> Self {
        let payload = serde_json::json!({
            "kind": err.kind(),
            "message": err.to_string(),
        });
        Self::from_value(payload)
    }
}

/// Errors surfaced by agent listing commands.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentsError {
    #[error("failed to discover agents: {0}")]
    DiscoveryFailed(String),

    #[error("agent not found: {0}")]
    NotFound(String),

    #[error("{0}")]
    Other(String),
}

impl AgentsError {
    pub fn kind(&self) -> &'static str {
        match self {
            AgentsError::DiscoveryFailed(_) => "discovery_failed",
            AgentsError::NotFound(_) => "not_found",
            AgentsError::Other(_) => "other",
        }
    }
}

impl From<AgentsError> for tauri::ipc::InvokeError {
    fn from(err: AgentsError) -> Self {
        let payload = serde_json::json!({
            "kind": err.kind(),
            "message": err.to_string(),
        });
        Self::from_value(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AttentionError, ClipboardError, HistoryError, OpenError, SessionError, UpdateError,
    };

    /// One wire-contract case: the error, its expected `kind`, and the
    /// expected extra field (key + value). A type alias because clippy's
    /// `type_complexity` lint objects to the bare tuple type.
    type Case = (
        SessionError,
        &'static str,
        Option<(&'static str, &'static str)>,
    );

    /// Every rejection a session command can send must arrive as an OBJECT
    /// carrying `kind` + a non-empty `message` (+ the variant's own field),
    /// because the frontend renders `message` and has nothing else to render.
    ///
    /// The `Io` assertion is the bug this conversion exists for: as a derived
    /// internally-tagged serde impl, `Io(String)` is a *newtype variant
    /// containing a string*, which serde refuses to encode, so Tauri's blanket
    /// `From` impl for serde-encodable errors
    /// (`tauri-2.12.2/src/ipc/mod.rs:240-247`) fell back to
    /// `Self::from_error` and the user was shown
    /// `"cannot serialize tagged newtype variant SessionError::Io containing a
    /// string"` instead of the real reason — for 13 call sites in
    /// `agent/session/mod.rs`.
    #[test]
    fn every_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message() {
        let cases: &[Case] = &[
            (
                SessionError::Io("disk went away".into()),
                "io",
                // The newtype payload lives in `message`, so no extra key.
                None,
            ),
            (
                SessionError::Command {
                    error: "boom".into(),
                },
                "command",
                Some(("error", "boom")),
            ),
            (
                SessionError::UnknownSession { id: "s-1".into() },
                "unknown_session",
                Some(("id", "s-1")),
            ),
            (
                SessionError::NotResumable { id: "s-2".into() },
                "not_resumable",
                Some(("id", "s-2")),
            ),
            (
                SessionError::FolderMissing {
                    path: "C:\\work".into(),
                },
                "folder_missing",
                Some(("path", "C:\\work")),
            ),
            (
                SessionError::InvalidPrompt {
                    reason: "bad mime".into(),
                },
                "invalid_prompt",
                Some(("reason", "bad mime")),
            ),
            (
                SessionError::SettleTimeout {
                    detail: "no turn in 90s".into(),
                },
                "settle_timeout",
                Some(("detail", "no turn in 90s")),
            ),
        ];

        for (err, expected_kind, extra) in cases {
            let wire = tauri::ipc::InvokeError::from(err.clone()).0;

            assert!(
                wire.is_object(),
                "{err:?} must reach the wire as an object, got {wire}"
            );
            assert_eq!(
                wire["kind"].as_str(),
                Some(*expected_kind),
                "kind for {err:?}"
            );

            let message = wire["message"]
                .as_str()
                .unwrap_or_else(|| panic!("{} must carry a string `message`: {wire}", err));
            assert!(
                !message.is_empty(),
                "`message` must be non-empty for {err:?}: {wire}"
            );
            assert_eq!(
                message,
                err.to_string(),
                "message must be the Display string of {err:?}"
            );

            match extra {
                Some((key, value)) => assert_eq!(
                    wire[*key].as_str(),
                    Some(*value),
                    "field `{key}` for {err:?}: {wire}"
                ),
                None => assert_eq!(
                    wire.as_object().map(|m| m.len()),
                    Some(2),
                    "{err:?} contributes no field beyond kind + message: {wire}"
                ),
            }
        }
    }

    /// The exact `Io` sentence the plan's diagnosis recorded, end to end.
    #[test]
    fn io_reaches_the_wire_as_its_own_sentence_not_a_serde_complaint() {
        let err = SessionError::Io("the session's WorkerManager is not attached".into());
        let wire = tauri::ipc::InvokeError::from(err.clone()).0;
        let rendered = wire.to_string();

        assert_eq!(
            wire["message"].as_str(),
            Some("i/o error: the session's WorkerManager is not attached")
        );
        assert_eq!(wire["kind"].as_str(), Some("io"));
        assert_eq!(
            err.to_string().as_str(),
            "i/o error: the session's WorkerManager is not attached"
        );
        assert!(
            !rendered.contains("cannot serialize"),
            "the serde complaint leaked to the wire instead of the real reason: {rendered}"
        );
    }

    #[test]
    fn files_error_serializes_to_adr_0063_envelope() {
        let err = super::FilesError::ImageTooLarge {
            size: 15_000_000,
            max: 10_485_760,
        };
        let wire = tauri::ipc::InvokeError::from(err).0;
        assert!(wire.is_object());
        assert_eq!(wire["kind"].as_str(), Some("image_too_large"));
        assert_eq!(
            wire["message"].as_str(),
            Some("the file is 15000000 bytes, which exceeds the 10 MiB limit")
        );
        assert_eq!(wire["size"].as_u64(), Some(15_000_000));
        assert_eq!(wire["max"].as_u64(), Some(10_485_760));

        let io_err = super::FilesError::Io("permission denied".into());
        let wire_io = tauri::ipc::InvokeError::from(io_err).0;
        assert!(wire_io.is_object());
        assert_eq!(wire_io["kind"].as_str(), Some("io"));
        assert_eq!(
            wire_io["message"].as_str(),
            Some("i/o error: permission denied")
        );
        assert_eq!(wire_io.as_object().map(|m| m.len()), Some(2));
    }

    #[test]
    fn settings_error_serializes_to_adr_0063_envelope() {
        let err = super::SettingsError::SaveFailed("disk full".into());
        let wire = tauri::ipc::InvokeError::from(err.clone()).0;
        assert!(wire.is_object());
        assert_eq!(wire["kind"].as_str(), Some("save_failed"));
        assert_eq!(wire["message"].as_str(), Some(err.to_string().as_str()));
    }

    #[test]
    fn spaces_error_serializes_to_adr_0063_envelope() {
        let err = super::SpacesError::FolderNotFound("/missing".into());
        let wire = tauri::ipc::InvokeError::from(err.clone()).0;
        assert!(wire.is_object());
        assert_eq!(wire["kind"].as_str(), Some("folder_not_found"));
        assert_eq!(wire["message"].as_str(), Some(err.to_string().as_str()));
    }

    #[test]
    fn mcp_error_serializes_to_adr_0063_envelope() {
        let err = super::McpError::LoadFailed("corrupt config".into());
        let wire = tauri::ipc::InvokeError::from(err.clone()).0;
        assert!(wire.is_object());
        assert_eq!(wire["kind"].as_str(), Some("load_failed"));
        assert_eq!(wire["message"].as_str(), Some(err.to_string().as_str()));
    }

    #[test]
    fn agents_error_serializes_to_adr_0063_envelope() {
        let err = super::AgentsError::DiscoveryFailed("io error".into());
        let wire = tauri::ipc::InvokeError::from(err.clone()).0;
        assert!(wire.is_object());
        assert_eq!(wire["kind"].as_str(), Some("discovery_failed"));
        assert_eq!(wire["message"].as_str(), Some(err.to_string().as_str()));
    }

    // -------------------------------------------------------------------
    // HistoryError (Finding 20): the five `DbError`-backed history commands.
    // -------------------------------------------------------------------

    /// `From<DbError>` maps EACH `DbError` variant to its OWN `HistoryError`
    /// kind — Finding 20's lost discrimination ("history won't load" must say
    /// whether SQLite, the disk or a JSON payload failed). The `message` half is
    /// the inner error's `Display`, so the sentence the user reads stays
    /// byte-identical to the `.map_err(|e| e.to_string())` the commands did
    /// before this enum existed.
    #[test]
    fn history_error_from_db_error_maps_each_variant_to_its_kind() {
        use crate::storage::DbError;

        let cases: Vec<(DbError, &str, String)> = vec![
            (
                DbError::Sqlite(rusqlite::Error::QueryReturnedNoRows),
                "sqlite",
                "sqlite error: ".to_string(),
            ),
            (
                DbError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "permission denied",
                )),
                "io",
                "io error: permission denied".to_string(),
            ),
            (
                DbError::Json(
                    serde_json::from_str::<serde_json::Value>("{")
                        .expect_err("a lone brace is not JSON"),
                ),
                "json",
                "json error: ".to_string(),
            ),
        ];

        for (db_err, expected_kind, message_prefix) in cases {
            let display = db_err.to_string();
            let err = HistoryError::from(db_err);

            assert_eq!(err.kind(), expected_kind, "kind for {err:?}");
            assert!(
                !err.to_string().is_empty(),
                "`message` must be non-empty for {err:?}"
            );
            // The Display sentence is `DbError`'s own, character for character:
            // the variant prefix plus the inner error's Display, which is what
            // the commands flattened to a `String` before this enum existed.
            assert_eq!(
                err.to_string(),
                display,
                "the HistoryError sentence must be the DbError sentence verbatim"
            );
            assert!(
                err.to_string().starts_with(&message_prefix),
                "expected the sentence to start with {message_prefix:?}, got {:?}",
                err.to_string()
            );
        }
    }

    /// The DRIFT PIN for the history wire vocabulary. These three spellings are
    /// the frozen list the frontend mirror lands as
    /// `export type HistoryErrorKind = "sqlite" | "io" | "json";`
    /// (`src/lib/tauri/types.ts`, task14b) — so a spelling drift, or a fourth
    /// variant nobody told the frontend about, fails HERE before CI sees it.
    /// The shape is `protocol.rs`'s `compaction_reason_serde_spellings_are_frozen`,
    /// applied to the hand-built envelope (no serde is involved to drift).
    #[test]
    fn history_error_kind_spellings_are_frozen() {
        let frozen: &[(&str, HistoryError)] = &[
            ("sqlite", HistoryError::Sqlite("no such table".into())),
            ("io", HistoryError::Io("disk went away".into())),
            ("json", HistoryError::Json("bad payload".into())),
        ];

        let spelled: Vec<&'static str> = frozen.iter().map(|(_, e)| e.kind()).collect();
        assert_eq!(
            spelled,
            vec!["sqlite", "io", "json"],
            "the HistoryError `kind` vocabulary is frozen (see the TS union above)"
        );
        for (expected, err) in frozen {
            assert_eq!(&err.kind(), expected, "frozen spelling for {err:?}");
        }
    }

    /// The mirror of `every_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message`
    /// for `HistoryError`: every variant reaches the wire as an OBJECT with a
    /// `kind`, a non-empty `message` equal to `Display`, and NO field beyond
    /// those two — the newtype payload already IS the whole `message`, exactly
    /// the `SessionError::Io` precedent ADR 0063 records.
    #[test]
    fn every_history_error_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message() {
        let cases: &[(&str, HistoryError)] = &[
            ("sqlite", HistoryError::Sqlite("no such table".into())),
            ("io", HistoryError::Io("disk went away".into())),
            ("json", HistoryError::Json("bad payload".into())),
        ];

        for (expected_kind, err) in cases {
            let wire = tauri::ipc::InvokeError::from(err.clone()).0;
            assert!(
                wire.is_object(),
                "{err:?} must reach the wire as an object, got {wire}"
            );
            assert_eq!(
                wire["kind"].as_str(),
                Some(*expected_kind),
                "kind for {err:?}"
            );
            let message = wire["message"]
                .as_str()
                .unwrap_or_else(|| panic!("{} must carry a string `message`: {wire}", err));
            assert!(
                !message.is_empty(),
                "`message` must be non-empty for {err:?}: {wire}"
            );
            assert_eq!(
                message,
                err.to_string(),
                "message must be the Display of {err:?}"
            );
            assert_eq!(
                wire.as_object().map(|m| m.len()),
                Some(2),
                "{err:?} contributes no field beyond kind + message: {wire}"
            );
        }
    }

    // -------------------------------------------------------------------
    // AttentionError / ClipboardError (Finding 20): the small families whose
    // enums land here so their command files (task14c's) have a wire error to
    // return. The kind vocabularies below are FROZEN by these pins — the
    // frontend mirrors copy these lists, never guess.
    // -------------------------------------------------------------------

    /// The mirror pin for `AttentionError`: object + `kind` + non-empty
    /// `message` == `Display` + exactly 2 keys (both variants are field-less —
    /// the `#[error(…)]` sentence IS the payload).
    #[test]
    fn every_attention_error_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message() {
        let cases: &[(&str, AttentionError)] = &[
            ("attention_empty_body", AttentionError::EmptyBody),
            ("attention_no_runtime", AttentionError::NoRuntime),
        ];

        for (expected_kind, err) in cases {
            let wire = tauri::ipc::InvokeError::from(err.clone()).0;
            assert!(
                wire.is_object(),
                "{err:?} must reach the wire as an object: {wire}"
            );
            assert_eq!(
                wire["kind"].as_str(),
                Some(*expected_kind),
                "kind for {err:?}"
            );
            let message = wire["message"]
                .as_str()
                .unwrap_or_else(|| panic!("{} must carry a string `message`: {wire}", err));
            assert!(
                !message.is_empty(),
                "`message` must be non-empty for {err:?}"
            );
            assert_eq!(
                message,
                err.to_string(),
                "message must be the Display of {err:?}"
            );
            assert_eq!(
                wire.as_object().map(|m| m.len()),
                Some(2),
                "{err:?} contributes no field beyond kind + message: {wire}"
            );
        }
    }

    /// The DRIFT PIN for the attention wire vocabulary. Both sentences are
    /// quoted because they are the byte-identity contract with the pre-migration
    /// `Err(String)`s of `commands/attention.rs` — the wire `message` the
    /// renderer's `logFailure` line carries must not change character.
    /// The frontend mirror lands
    /// `export type AttentionErrorKind = "attention_empty_body" | "attention_no_runtime";`
    /// (`src/lib/tauri/types.ts`, task14b) by copying THIS list.
    #[test]
    fn attention_error_kind_spellings_are_frozen() {
        let frozen: &[(&str, AttentionError, &str)] = &[
            (
                "attention_empty_body",
                AttentionError::EmptyBody,
                "attention_arm: empty alert body (the renderer composed nothing)",
            ),
            (
                "attention_no_runtime",
                AttentionError::NoRuntime,
                "attention_arm: no tokio runtime to hold the countdown",
            ),
        ];

        let spelled: Vec<&'static str> = frozen.iter().map(|(_, e, _)| e.kind()).collect();
        assert_eq!(
            spelled,
            vec!["attention_empty_body", "attention_no_runtime"],
            "the AttentionError `kind` vocabulary is frozen (the family-prefixed \
             candidate pair, chosen once; see AttentionError::kind)"
        );
        for (expected_kind, err, expected_message) in frozen {
            assert_eq!(&err.kind(), expected_kind, "frozen spelling for {err:?}");
            assert_eq!(
                &err.to_string(),
                expected_message,
                "the sentence the pre-migration Err(String) carried is byte-identical on the wire"
            );
        }
    }

    /// The mirror pin for `ClipboardError` (the `SessionError::Io` shape: the
    /// newtype payload lives inside `message`, so no extra key).
    #[test]
    fn every_clipboard_error_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message() {
        let cases: &[(&str, ClipboardError)] = &[
            (
                "clipboard",
                ClipboardError::Clipboard("clipboard init failed".into()),
            ),
            ("encode", ClipboardError::Encode("png encode failed".into())),
        ];

        for (expected_kind, err) in cases {
            let wire = tauri::ipc::InvokeError::from(err.clone()).0;
            assert!(
                wire.is_object(),
                "{err:?} must reach the wire as an object: {wire}"
            );
            assert_eq!(
                wire["kind"].as_str(),
                Some(*expected_kind),
                "kind for {err:?}"
            );
            let message = wire["message"]
                .as_str()
                .unwrap_or_else(|| panic!("{} must carry a string `message`: {wire}", err));
            assert!(
                !message.is_empty(),
                "`message` must be non-empty for {err:?}"
            );
            assert_eq!(
                message,
                err.to_string(),
                "message must be the Display of {err:?}"
            );
            assert_eq!(
                wire.as_object().map(|m| m.len()),
                Some(2),
                "{err:?} contributes no field beyond kind + message: {wire}"
            );
        }
    }

    /// The DRIFT PIN for the clipboard wire vocabulary. The frontend mirror
    /// lands `export type ClipboardErrorKind = "clipboard" | "encode";`
    /// (`src/lib/tauri/types.ts`, task14b) by copying THIS list.
    #[test]
    fn clipboard_error_kind_spellings_are_frozen() {
        let frozen: &[(&str, ClipboardError)] = &[
            ("clipboard", ClipboardError::Clipboard("x".into())),
            ("encode", ClipboardError::Encode("x".into())),
        ];

        let spelled: Vec<&'static str> = frozen.iter().map(|(_, e)| e.kind()).collect();
        assert_eq!(
            spelled,
            vec!["clipboard", "encode"],
            "the ClipboardError `kind` vocabulary is frozen"
        );
        for (expected, err) in frozen {
            assert_eq!(&err.kind(), expected, "frozen spelling for {err:?}");
        }
    }

    /// The mirror pin for `OpenError`: object + `kind` + non-empty `message` ==
    /// `Display`, and the `message` is the refusal code VERBATIM (the whole
    /// point: the envelope adds `kind` without editing the code by a character).
    #[test]
    fn every_open_error_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message() {
        let cases: &[(&str, &str, OpenError)] = &[
            ("invalid_href", "empty", OpenError::Code("empty".into())),
            (
                "denied_scheme",
                "denied-scheme:javascript",
                OpenError::Code("denied-scheme:javascript".into()),
            ),
            (
                "relative_without_cwd",
                "relative-without-cwd",
                OpenError::Code("relative-without-cwd".into()),
            ),
            (
                "os_error",
                "os-error:xdg-open not found",
                OpenError::Code("os-error:xdg-open not found".into()),
            ),
            (
                "other",
                "some-future-code",
                OpenError::Code("some-future-code".into()),
            ),
        ];

        for (expected_kind, expected_message, err) in cases {
            let wire = tauri::ipc::InvokeError::from(err.clone()).0;
            assert!(
                wire.is_object(),
                "{err:?} must reach the wire as an object: {wire}"
            );
            assert_eq!(
                wire["kind"].as_str(),
                Some(*expected_kind),
                "kind for {err:?}"
            );
            let message = wire["message"]
                .as_str()
                .unwrap_or_else(|| panic!("{} must carry a string `message`: {wire}", err));
            assert!(
                !message.is_empty(),
                "`message` must be non-empty for {err:?}"
            );
            assert_eq!(
                message,
                err.to_string(),
                "message must be the Display of {err:?}"
            );
            assert_eq!(
                message, *expected_message,
                "the refusal code reaches the wire verbatim for {err:?}"
            );
            assert_eq!(
                wire.as_object().map(|m| m.len()),
                Some(2),
                "{err:?} contributes no field beyond kind + message: {wire}"
            );
        }
    }

    /// `kind_of`'s ENTIRE code table, frozen — including the `other` fallback
    /// that catches a code the policy has not grown yet (and `bad-file-url:…`,
    /// `crate::open`'s fourth refusal, which no command-level test reaches).
    /// A code that silently changed kind, or a code whose sentence a reword
    /// would move between arms, fails HERE.
    #[test]
    fn open_error_kind_of_maps_the_refusal_codes() {
        let frozen: &[(&str, &str)] = &[
            ("empty", "invalid_href"),
            ("denied-scheme:javascript", "denied_scheme"),
            ("denied-scheme:data", "denied_scheme"),
            ("relative-without-cwd", "relative_without_cwd"),
            ("os-error:no such file or directory", "os_error"),
            // The documented fallback: an unknown code keeps its sentence and
            // answers `other`; `bad-file-url:{href}` is in this arm on purpose
            // (the frozen vocabulary is five values, not six).
            ("bad-file-url:file://otherhost/x", "other"),
            ("", "other"),
            ("anything-else", "other"),
        ];

        for (code, expected_kind) in frozen {
            assert_eq!(
                OpenError::kind_of(code),
                *expected_kind,
                "kind_of({code:?}) is frozen"
            );
            assert_eq!(
                OpenError::Code((*code).into()).kind(),
                *expected_kind,
                "OpenError::Code({code:?}).kind() agrees with kind_of"
            );
        }

        // The vocabulary itself, frozen for the frontend mirror.
        let spelled: Vec<&'static str> = frozen.iter().map(|(_, k)| *k).collect();
        let unique: std::collections::BTreeSet<&str> = spelled.iter().copied().collect();
        assert_eq!(
            unique.into_iter().collect::<Vec<_>>(),
            vec![
                "denied_scheme",
                "invalid_href",
                "os_error",
                "other",
                "relative_without_cwd"
            ],
            "the OpenError `kind` vocabulary is exactly these five spellings"
        );
    }

    /// `kind_of`'s ENTIRE frozen code table, every arm named — the thirteen
    /// codes `map_check_error` (in `commands/update.rs`, UNCHANGED by this
    /// migration) can produce, plus the `other` fallback. `release-not-found` is
    /// the row `UpdateSection.test.tsx` and `AGENTS.md`'s release ceremony both
    /// quote, so it is asserted twice: as a `kind`, and as a `message` that is
    /// the code byte-identical.
    #[test]
    fn update_error_kind_of_maps_the_frozen_code_table() {
        let frozen: &[(&str, &str)] = &[
            ("release-not-found", "release_not_found"),
            ("endpoints-not-configured", "endpoints_not_configured"),
            ("network:404 Not Found", "network"),
            ("invalid-target:linux-x86_64", "invalid_target"),
            (
                "invalid-target:linux-x86_64,linux-aarch64",
                "invalid_target",
            ),
            ("signature-mismatch", "signature_mismatch"),
            ("install-failed", "install_failed"),
            ("install-in-progress", "install_in_progress"),
            ("no-update-available", "no_update_available"),
            ("unsupported-platform", "unsupported_platform"),
            ("invalid-update-format", "invalid_update_format"),
            ("authentication-failed", "authentication_failed"),
            ("io:permission denied", "io"),
            // map_check_error's own catch-all, mirrored as `other` here.
            ("update-error:semver parse failed", "other"),
            ("", "other"),
            ("a-code-nobody-named-yet", "other"),
        ];

        for (code, expected_kind) in frozen {
            assert_eq!(
                UpdateError::kind_of(code),
                *expected_kind,
                "kind_of({code:?}) is frozen"
            );
            // The newtype agrees with the pure fn, and its Display is the code
            // VERBATIM — the byte-identity half of the wire contract.
            let err = UpdateError((*code).into());
            assert_eq!(err.kind(), *expected_kind, "UpdateError({code:?}).kind()");
            assert_eq!(
                err.to_string(),
                *code,
                "the updater code must reach the wire as the message, unchanged"
            );
        }

        // The vocabulary itself, frozen for the frontend mirror.
        let unique: std::collections::BTreeSet<&'static str> = frozen
            .iter()
            .map(|(_, kind)| *kind)
            .filter(|kind| *kind != "other")
            .collect();
        assert_eq!(
            unique.into_iter().collect::<Vec<_>>(),
            vec![
                "authentication_failed",
                "endpoints_not_configured",
                "install_failed",
                "install_in_progress",
                "invalid_target",
                "invalid_update_format",
                "io",
                "network",
                "no_update_available",
                "release_not_found",
                "signature_mismatch",
                "unsupported_platform",
            ],
            "the UpdateError `kind` vocabulary (besides `other`) is exactly these \
             twelve spellings — the thirteenth value in the frontend union is `other`"
        );
    }

    /// The mirror pin for `UpdateError`: object + `kind` + non-empty `message`
    /// == `Display`, exactly 2 keys, and for the SECURITY-relevant
    /// `signature-mismatch` and the ceremony-pinned `release-not-found` the
    /// sentence is asserted as a literal so a reword cannot slip through.
    #[test]
    fn every_update_error_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message() {
        let cases: &[(&str, &str, UpdateError)] = &[
            (
                "release_not_found",
                "release-not-found",
                UpdateError("release-not-found".into()),
            ),
            (
                "signature_mismatch",
                "signature-mismatch",
                UpdateError("signature-mismatch".into()),
            ),
            (
                "install_in_progress",
                "install-in-progress",
                UpdateError("install-in-progress".into()),
            ),
            (
                "no_update_available",
                "no-update-available",
                UpdateError("no-update-available".into()),
            ),
            (
                "network",
                "network:boom",
                UpdateError("network:boom".into()),
            ),
            (
                "other",
                "update-error:x",
                UpdateError("update-error:x".into()),
            ),
        ];

        for (expected_kind, expected_message, err) in cases {
            let wire = tauri::ipc::InvokeError::from(err.clone()).0;
            assert!(
                wire.is_object(),
                "{err:?} must reach the wire as an object: {wire}"
            );
            assert_eq!(
                wire["kind"].as_str(),
                Some(*expected_kind),
                "kind for {err:?}"
            );
            let message = wire["message"]
                .as_str()
                .unwrap_or_else(|| panic!("{} must carry a string `message`: {wire}", err));
            assert!(
                !message.is_empty(),
                "`message` must be non-empty for {err:?}"
            );
            assert_eq!(
                message,
                err.to_string(),
                "message must be the Display of {err:?}"
            );
            assert_eq!(
                message, *expected_message,
                "the updater code reaches the wire verbatim for {err:?} — the \
                 frontend renders this string and UpdateSection.test.tsx pins it"
            );
            assert_eq!(
                wire.as_object().map(|m| m.len()),
                Some(2),
                "{err:?} contributes no field beyond kind + message: {wire}"
            );
        }
    }
}
