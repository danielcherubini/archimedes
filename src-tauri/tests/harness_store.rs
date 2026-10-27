//! The native transcript store (native-agent-harness Task 6): the
//! `native_messages` table — round-trip, clear/display independence,
//! and the tool-transcript fidelity (the lossy-transcript guard: a
//! `ToolCall` message's arguments + a `tool` result's `tool_call_id`
//! must round-trip through `content_json`).

use std::sync::Arc;

use archimedes_lib::agent::harness::{
    ChatMessage, ChatRole, MessageContent, SessionStore, ToolCall,
};
use archimedes_lib::agent::SessionInfo;
use archimedes_lib::storage::Db;
use serde_json::json;

/// A temp `Db` with its scratch dir OWNED (#96 task 06). The guard is FIRST:
/// destructured locals drop in reverse declaration order, so the `Db` — whose
/// SQLite file lives INSIDE `dir` — closes before `dir` is removed. That is
/// what Windows needs and Linux cannot show (a probe outside this repo
/// confirmed `remove_dir_all` succeeds there even with the handle open).
///
/// The old signature was `(Arc<Db>, PathBuf)`, and every caller bound the
/// `PathBuf` as `_dir` — a name that owned nothing, so all five dirs leaked.
///
/// A fresh file per test — `Db` is a single `rusqlite::Connection` behind a
/// `std::sync::Mutex`.
fn temp_db() -> (archimedes_lib::test_support::ScratchDir, Arc<Db>) {
    let dir = archimedes_lib::test_support::ScratchDir::in_env_temp("harness-store-", "db");
    let path = dir.join("db.sqlite");
    let db = Arc::new(Db::open(&path).unwrap());
    (dir, db)
}

/// A `sessions` row (the display `messages` table AND `native_messages`
/// are FK-referenced to it — a transcript row requires the session row).
fn record_session(db: &Db, id: &str) {
    db.record_session(&SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp"),
        capabilities: json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    })
    .unwrap();
}

fn user(text: &str) -> ChatMessage {
    ChatMessage {
        role: ChatRole::User,
        content: MessageContent::Text(text.to_string()),
        tool_call_id: None,
        tool_calls: None,
    }
}

fn assistant(text: &str) -> ChatMessage {
    ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Text(text.to_string()),
        tool_call_id: None,
        tool_calls: None,
    }
}

#[test]
fn insert_and_load_round_trip() {
    let (_dir, db) = temp_db();
    record_session(&db, "s1");
    let store = SessionStore::new(db.clone());

    store
        .insert_message(
            "s1",
            0,
            "user",
            &serde_json::to_string(&user("hi")).unwrap(),
        )
        .unwrap();
    store
        .insert_message(
            "s1",
            1,
            "assistant",
            &serde_json::to_string(&assistant("hello")).unwrap(),
        )
        .unwrap();

    let msgs = store.load_messages("s1").unwrap();
    assert_eq!(msgs.len(), 2, "both rows load");
    assert_eq!(msgs[0], user("hi"), "the user message round-trips");
    assert_eq!(
        msgs[1],
        assistant("hello"),
        "the assistant message round-trips"
    );
    // A different session is isolated.
    assert!(store.load_messages("s2").unwrap().is_empty());
}

#[test]
fn insert_is_idempotent_on_conflict() {
    let (_dir, db) = temp_db();
    record_session(&db, "s1");
    let store = SessionStore::new(db.clone());

    let first = serde_json::to_string(&user("v1")).unwrap();
    store.insert_message("s1", 0, "user", &first).unwrap();
    let second = serde_json::to_string(&user("v2")).unwrap();
    store.insert_message("s1", 0, "user", &second).unwrap();

    let msgs = store.load_messages("s1").unwrap();
    assert_eq!(
        msgs.len(),
        1,
        "the same (session_id, seq) collapses to one row"
    );
    assert_eq!(msgs[0], user("v2"), "the upsert refreshes the content");
}

#[test]
fn clear_messages_clears_native_but_not_display() {
    let (_dir, db) = temp_db();
    let store = SessionStore::new(db.clone());
    record_session(&db, "s1");
    // A display row (the `record_message` upsert — the display
    // `messages` table).
    db.record_message("s1", "user", None, r#"{"text":"display"}"#)
        .unwrap();
    store
        .insert_message(
            "s1",
            0,
            "user",
            &serde_json::to_string(&user("native")).unwrap(),
        )
        .unwrap();

    store.clear_messages("s1").unwrap();

    assert!(
        store.load_messages("s1").unwrap().is_empty(),
        "clear_messages empties the native_messages rows"
    );
    let rows = db.messages_for("s1").unwrap();
    assert_eq!(rows.len(), 1, "the display `messages` row survives");
    assert_eq!(rows[0].kind, "user");
    assert_eq!(rows[0].payload_json, r#"{"text":"display"}"#);
}

#[test]
fn tool_transcript_round_trip_preserves_tool_calls_and_ids() {
    // The lossy-transcript guard: a `ToolCall` message (with arguments)
    // + a `tool` result message (with `tool_call_id`) must round-trip
    // through `content_json` with the tool-call arguments and the
    // result's `tool_call_id` intact.
    let (_dir, db) = temp_db();
    record_session(&db, "s1");
    let store = SessionStore::new(db.clone());

    let assistant_with_call = ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Text(String::new()),
        tool_call_id: None,
        tool_calls: Some(vec![ToolCall {
            id: "call_1".to_string(),
            name: "bash".to_string(),
            arguments: json!({ "command": "ls -la", "timeout_ms": 5000 }),
        }]),
    };
    let tool_result = ChatMessage {
        role: ChatRole::Tool,
        content: MessageContent::Text("file-list".to_string()),
        tool_call_id: Some("call_1".to_string()),
        tool_calls: None,
    };
    store
        .insert_message(
            "s1",
            0,
            "assistant",
            &serde_json::to_string(&assistant_with_call).unwrap(),
        )
        .unwrap();
    store
        .insert_message(
            "s1",
            1,
            "tool",
            &serde_json::to_string(&tool_result).unwrap(),
        )
        .unwrap();

    let msgs = store.load_messages("s1").unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(
        msgs[0].tool_calls,
        Some(vec![ToolCall {
            id: "call_1".to_string(),
            name: "bash".to_string(),
            arguments: json!({ "command": "ls -la", "timeout_ms": 5000 }),
        }]),
        "the tool-call arguments round-trip"
    );
    assert_eq!(
        msgs[1].tool_call_id.as_deref(),
        Some("call_1"),
        "the tool result's tool_call_id round-trips"
    );
    assert_eq!(msgs[1], tool_result);
}

#[test]
fn display_record_is_independent_of_native_messages() {
    let (_dir, db) = temp_db();
    let store = SessionStore::new(db.clone());
    record_session(&db, "s1");

    // A display row ONLY (the existing `record_message` persistence —
    // the display `payload_json` is a display shape, lossy for the
    // provider transcript).
    db.record_message("s1", "agent-text", Some("m1"), r#"{"text":"x"}"#)
        .unwrap();

    assert!(
        store.load_messages("s1").unwrap().is_empty(),
        "a display row never lands in native_messages"
    );
}

/// #96 task 06: the store fixture must OWN its scratch. `temp_db()` handed
/// back a bare `PathBuf` and every caller bound it as `_dir` — a name that
/// owns nothing — so all five dirs outlived the run (100 of them on disk,
/// 5 per run). The GREEN half of this assertion is the real win in this
/// file; the drop is what makes the panic path cost nothing.
#[test]
fn the_temp_db_fixture_removes_its_scratch_when_its_owner_is_dropped() {
    let (dir, db) = temp_db();
    record_session(&db, "s1");
    let captured = dir.to_path_buf();
    assert!(captured.is_dir(), "the fixture created its scratch dir");
    // `drop((a, b))` drops LEFT then RIGHT, so the `Db` closes before the
    // dir holding its SQLite file is removed — correct for BOTH the old
    // `(db, dir)` and the new `(dir, db)` shape, which is what lets this
    // test compile at RED and only need a REBIND at GREEN.
    drop((db, dir));
    assert!(
        !captured.exists(),
        "the fixture's scratch goes with its owner: {captured:?}"
    );
}

/// The panic path: an assertion that FAILS while the fixture still owns its
/// scratch must not leave it behind. The guard is MOVED INTO the panicking
/// scope — that is the value the unwind drops (the `test_support` /
/// `agent/mcp/oauth.rs` precedent). What this does NOT pin is #96's headline
/// case — a test failing with its guard as a plain local, so the HARNESS's
/// own unwind would have to remove the dir — because Rust makes no portable
/// guarantee there and status-doc D10 assigns that case to task 09's census.
#[test]
fn a_panicking_assertion_still_removes_the_temp_db_scratch() {
    let captured = {
        let (dir, db) = temp_db();
        let p = dir.to_path_buf();
        assert!(p.is_dir(), "the fixture created its scratch dir");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            // ONE tuple binding, not a destructure: a tuple VALUE drops
            // left-to-right (`db` closes, then `dir` is removed), while
            // `let (a, b) = tuple` would create two locals and drop them in
            // REVERSE declaration order — which would remove the dir under
            // the still-open SQLite handle. Both orders pass on Linux; only
            // the first is correct on Windows.
            let _fixture = (db, dir);
            assert_eq!(
                1, 2,
                "an assertion fails while the fixture owns its scratch"
            );
        }));
        assert!(r.is_err(), "the assertion failed as arranged");
        p
    };
    assert!(
        !captured.exists(),
        "the unwind ran the removal: {captured:?}"
    );
}
