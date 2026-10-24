//! Tauri commands for session history: list, load, archive, delete.
//!
//! History is owned by the client (this app): the frontend calls
//! `list_sessions` on boot to populate the session list, `load_history`
//! when a stored session is opened (or paged on scroll-up, ADR 0073),
//! `set_session_archived` to archive / unarchive a session (ADR 0016),
//! `delete_session` to remove a session (and, via `ON DELETE CASCADE`, its
//! messages), `session_recency` for recency as a FIELD now that list position
//! is not evidence (ADR 0075), and `reorder_sessions` when a drag rewrites the
//! manual order of one Space's visible slice.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::{SessionInfo, SessionManager};
use crate::storage::{Db, DbError, MessageRow, SessionRecency};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub rows: Vec<MessageRow>,
    pub has_more: bool,
    /// Task 2 fills this; Task 1 always `None`.
    pub todos: Option<serde_json::Value>,
}

/// All stored sessions, in the user's MANUAL ORDER (see `Db::list_sessions`),
/// as `SessionInfo` (camelCase over IPC). Position says nothing about recency
/// (ADR 0075, `docs/decisions/0075-list-position-is-not-evidence.md`).
///
/// `include_archived` (ADR 0016, `Option` → the frontend may omit the
/// argument): `false` (the default) hides archived sessions; `true`
/// returns them with the `archived` flag set (the frontend splits the
/// boot list client-side).
///
/// Each row carries `config_options` synthesized from the stored
/// `model` / `thinkingLevel` (the same resolution as the resume — the
/// frontend's `SessionConfigSelect` renders them in the stored session's
/// composer, disabled) and `context_usage` read from the row's
/// `context_usage_json` (the last known usage — the frontend's store
/// drops it on close, so the row is the source of truth for the stored
/// session's context bar). Delegates to `SessionManager::list_sessions`
/// (the manager's `effective_catalog` — the user's providers, not the
/// test-only static catalog).
#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Arc<SessionManager>>,
    include_archived: Option<bool>,
) -> Result<Vec<SessionInfo>, String> {
    state
        .list_sessions(include_archived.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// A stored session's transcript page, in insertion order (ADR 0073).
///
/// Bounded by `limit` (newest rows first) and `before_id` (cursor for
/// paging older rows). When omitted, returns all rows up to `before_id`
/// with `has_more = false`.
pub(crate) fn history_page(
    db: &Db,
    session_id: &str,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<HistoryPage, DbError> {
    let (rows, has_more) = db.messages_page(session_id, before_id, limit)?;
    let todos = if before_id.is_none() {
        db.session_todos(session_id)?
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    } else {
        None
    };
    Ok(HistoryPage {
        rows,
        has_more,
        todos,
    })
}

#[tauri::command]
pub async fn load_history(
    state: State<'_, Arc<Db>>,
    session_id: String,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<HistoryPage, String> {
    history_page(&state, &session_id, limit, before_id).map_err(|e| e.to_string())
}

/// Archive (or unarchive) a stored session (ADR 0016): sets the
/// `sessions.archived` flag. The transcript is NOT touched.
#[tauri::command]
pub async fn set_session_archived(
    state: State<'_, Arc<Db>>,
    session_id: String,
    archived: bool,
) -> Result<bool, String> {
    state
        .set_session_archived(&session_id, archived)
        .map_err(|e| e.to_string())
}

/// Delete a stored session; its messages are removed by the cascade.
#[tauri::command]
pub async fn delete_session(state: State<'_, Arc<Db>>, session_id: String) -> Result<(), String> {
    state.delete_session(&session_id).map_err(|e| e.to_string())
}

/// Every non-subagent session's recency as an explicit FIELD (ADR 0075).
#[tauri::command]
pub async fn session_recency(state: State<'_, Arc<Db>>) -> Result<Vec<SessionRecency>, String> {
    session_recency_rows(&state).map_err(|e| e.to_string())
}

pub(crate) fn session_recency_rows(db: &Db) -> Result<Vec<SessionRecency>, DbError> {
    db.session_recency()
}

/// Rewrite the manual order of the given session ids in ONE transaction.
/// Only a drag calls this (ADR 0075); the ids are the visible slice of ONE Space.
#[tauri::command]
pub async fn reorder_sessions(state: State<'_, Arc<Db>>, ids: Vec<String>) -> Result<(), String> {
    reorder_session_rows(&state, &ids).map_err(|e| e.to_string())
}

pub(crate) fn reorder_session_rows(db: &Db, ids: &[String]) -> Result<(), DbError> {
    db.reorder_sessions(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_page_todos_first_page_and_subsequent_pages() {
        let dir = std::env::temp_dir().join(format!("history-todos-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let db = Db::open(&path).expect("db should open");

        let s1 = SessionInfo {
            session_id: "sess-todos".to_string(),
            cwd: std::path::PathBuf::from("/tmp"),
            capabilities: serde_json::json!({}),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            is_subagent: false,
        };
        let s_empty = SessionInfo {
            session_id: "sess-empty".to_string(),
            cwd: std::path::PathBuf::from("/tmp"),
            capabilities: serde_json::json!({}),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            is_subagent: false,
        };
        db.record_session(&s1).unwrap();
        db.record_session(&s_empty).unwrap();

        let todos_str = r#"[{"content":"task1","status":"pending"}]"#;
        db.record_session_todos("sess-todos", Some(todos_str))
            .unwrap();

        for i in 0..5 {
            db.record_message("sess-todos", "agent-text", Some(&format!("k{i}")), "{}")
                .unwrap();
        }

        // First page (before_id: None) on a session with todos returns todos: Some(...)
        let p1 =
            history_page(&db, "sess-todos", Some(2), None).expect("history_page should succeed");
        assert!(p1.todos.is_some(), "first page should have todos");
        assert_eq!(
            p1.todos.unwrap(),
            serde_json::json!([{"content":"task1","status":"pending"}])
        );

        // Subsequent page (before_id: Some(...)) on that same session returns todos: None
        let oldest_id = p1.rows[0].id;
        let p2 = history_page(&db, "sess-todos", Some(2), Some(oldest_id))
            .expect("history_page should succeed");
        assert_eq!(p2.todos, None, "subsequent page should have todos: None");

        // Session with no todos returns todos: None on the first page
        let p_empty =
            history_page(&db, "sess-empty", Some(2), None).expect("history_page should succeed");
        assert_eq!(
            p_empty.todos, None,
            "session with no todos returns todos: None"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0075) The WIRE KEYS of `SessionRecency` are pinned as literals:
    /// `serde_json::to_value` on a row yields exactly `sessionId` and
    /// `lastActiveAt`. The keys are the load-bearing half of this test — a
    /// dropped `#[serde(rename_all = "camelCase")]` changes no field VALUE, so it
    /// passes every value assertion on both sides of the wire and is invisible to
    /// the hand-written TypeScript mirror; only a key literal sees it.
    ///
    /// The value half is asserted too, against the far-future stamp the fixture
    /// writes by RAW SQL rather than `record_message`: both `Db::record_*` helpers
    /// stamp `now_ms()`, so a `record_message` row could not be told apart from a
    /// "recent" default (T01's trap, carried forward).
    #[test]
    fn session_recency_rows_serializes_to_the_pinned_camel_case_keys() {
        let dir =
            std::env::temp_dir().join(format!("history-recency-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the test dir");
        let path = dir.join("t.db");
        let db = Db::open(&path).expect("db should open");

        let titled = |id: &str| SessionInfo {
            session_id: id.to_string(),
            cwd: std::path::PathBuf::from("/tmp"),
            capabilities: serde_json::json!({}),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            is_subagent: false,
        };
        db.record_session(&titled("s_rec")).expect("record s_rec");
        db.record_session(&titled("s_plain"))
            .expect("record s_plain");
        // The message row goes in through a SECOND raw connection to the same
        // file — the `tests/storage.rs` idiom — because `Db::conn` is private
        // outside `storage::db`. It is still RAW SQL with an EXPLICIT
        // far-future `created_at`, never `record_message` (which stamps
        // `now_ms()` and would tie every row written in the same millisecond —
        // T01's trap), and the connection is closed before the `Db` reads, the
        // same ordering those tests use.
        {
            let conn = rusqlite::Connection::open(&path).expect("raw open of the fixture db");
            conn.execute(
                "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
                 VALUES ('s_rec', 'user', NULL, '{}', 9_999_999_999_999)",
                [],
            )
            .expect("fixture message row (explicit far-future created_at)");
        }

        let rows = session_recency_rows(&db).expect("session_recency_rows should succeed");
        let value = serde_json::to_value(&rows).expect("SessionRecency serializes");
        let items = value.as_array().expect("the payload is an array");
        assert_eq!(items.len(), 2, "one entry per non-subagent session");

        for item in items {
            let keys: Vec<String> = item
                .as_object()
                .expect("a serialized SessionRecency is an object")
                .keys()
                .cloned()
                .collect();
            assert_eq!(
                keys,
                vec!["lastActiveAt".to_string(), "sessionId".to_string()],
                "the wire keys are exactly `lastActiveAt` and `sessionId` \
                 (the pinned camelCase form — a dropped `rename_all` changes no value)"
            );
        }

        // The value half: the fixture's explicit stamp, not a `now_ms()` number.
        let rec = items
            .iter()
            .find(|i| i["sessionId"] == serde_json::json!("s_rec"))
            .expect("s_rec is listed");
        assert_eq!(
            rec["lastActiveAt"],
            serde_json::json!(9_999_999_999_999_i64),
            "the number is the fixture's explicit stamp"
        );
        let plain = items
            .iter()
            .find(|i| i["sessionId"] == serde_json::json!("s_plain"))
            .expect("s_plain is listed");
        assert!(
            plain["lastActiveAt"].is_i64(),
            "a session with no messages still carries a NUMBER (the `COALESCE` \
             fallback), never null"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0075) `reorder_session_rows` writes the slice in the GIVEN order:
    /// the ids arrive as `["s_c", "s_a", "s_b"]` and `list_sessions` reads that
    /// back verbatim, so the command layer cannot sort, dedupe, or reorder a
    /// drag. Also proves the `Vec<String> → &[String]` deref the `#[tauri::command]`
    /// wrapper needs.
    #[test]
    fn reorder_session_rows_writes_the_slice_in_given_order() {
        let dir =
            std::env::temp_dir().join(format!("history-reorder-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create the test dir");
        let db = Db::open(&dir.join("t.db")).expect("db should open");

        let titled = |id: &str| SessionInfo {
            session_id: id.to_string(),
            cwd: std::path::PathBuf::from("/tmp"),
            capabilities: serde_json::json!({}),
            config_options: None,
            archived: false,
            title: None,
            context_usage: None,
            is_subagent: false,
        };
        for id in ["s_a", "s_b", "s_c"] {
            db.record_session(&titled(id))
                .expect("record_session should succeed");
        }

        let ids = vec!["s_c".to_string(), "s_a".to_string(), "s_b".to_string()];
        reorder_session_rows(&db, &ids).expect("reorder_session_rows should succeed");

        let listed: Vec<String> = db
            .list_sessions(false)
            .expect("list_sessions should succeed")
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(
            listed,
            vec!["s_c".to_string(), "s_a".to_string(), "s_b".to_string()],
            "the given slice order IS the stored order"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
