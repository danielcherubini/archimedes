//! Errors for the session layer: `SessionError` is the only error type
//! (the read-only pre-approval `FsBackend` has its own local `FsError`
//! in `fs_backend.rs`).

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
    /// The serialized `kind` discriminator (the wire contract — see the ADR).
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

/// The IPC envelope: `{"kind", "message", …the variant's own field}`.
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

#[cfg(test)]
mod tests {
    use super::SessionError;

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
}
