//! Tauri commands for session history: list, load, archive, delete.
//!
//! History is owned by the client (this app): the frontend calls
//! `list_sessions` on boot to populate the session list, `load_history`
//! when a stored session is opened (or paged on scroll-up, ADR 0073),
//! `set_session_archived` to archive / unarchive a session (ADR 0016), and
//! `delete_session` to remove a session (and, via `ON DELETE CASCADE`, its
//! messages).

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::{SessionInfo, SessionManager};
use crate::storage::{Db, DbError, MessageRow};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub rows: Vec<MessageRow>,
    pub has_more: bool,
    /// Task 2 fills this; Task 1 always `None`.
    pub todos: Option<serde_json::Value>,
}

/// All stored sessions, MOST RECENTLY ACTIVE FIRST (see `Db::list_sessions`),
/// as `SessionInfo` (camelCase over IPC).
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
}
