use super::*;

/// (settings trust) a NEW space row is born `trusted` per the flag
/// (the INSERT writes `trusted` from the flag). Asserted via
/// `list_spaces()` (NOT `space_trusted` — a canonicalize failure
/// fail-closes to `false` on a nonexistent path, a misleading red).
/// Real temp dirs for the paths (a nonexistent path canonicalize-
/// fails → `space_key` falls back to the raw string; the canonical
/// key is asserted here).
#[test]
fn upsert_space_insert_sets_trusted_from_the_flag() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-trusted-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).unwrap();
    let a = dir.join("a");
    std::fs::create_dir_all(&a).unwrap();
    let b = dir.join("b");
    std::fs::create_dir_all(&b).unwrap();
    db.upsert_space(a.to_str().unwrap(), true).unwrap();
    db.upsert_space(b.to_str().unwrap(), false).unwrap();
    let rows = db.list_spaces().unwrap();
    let a_canon = std::fs::canonicalize(&a).unwrap().display().to_string();
    let b_canon = std::fs::canonicalize(&b).unwrap().display().to_string();
    let row_a = rows.iter().find(|r| r.path == a_canon).unwrap();
    let row_b = rows.iter().find(|r| r.path == b_canon).unwrap();
    assert!(
        row_a.trusted,
        "the INSERT writes `trusted` from the flag (true)"
    );
    assert!(
        !row_b.trusted,
        "the INSERT writes `trusted` from the flag (false)"
    );
}

/// (settings trust) a re-upsert on an EXISTING row never touches the
/// trust flag (the CONFLICT branch only refreshes `last_opened_at`
/// — no retroactive trust): `false` → trust ON → re-upsert `false`
/// → the row is STILL trusted.
#[test]
fn upsert_space_conflict_leaves_the_existing_trust_untouched() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-trusted-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).unwrap();
    let c = dir.join("c");
    std::fs::create_dir_all(&c).unwrap();
    let c_canon = std::fs::canonicalize(&c).unwrap().display().to_string();
    db.upsert_space(&c_canon, false).unwrap();
    db.set_space_trusted(&c_canon, true).unwrap();
    db.upsert_space(&c_canon, false).unwrap();
    let rows = db.list_spaces().unwrap();
    let row = rows.iter().find(|r| r.path == c_canon).unwrap();
    assert!(row.trusted, "the CONFLICT branch never touches `trusted`");
}

/// (the FK migration) A crash MID-BATCH leaves a stale
/// `native_messages_migrated` table behind (the original
/// `native_messages` still exists, WITHOUT the FK): the next
/// `Db::open` must RECOVER (the migration is atomic +
/// crash-idempotent — pre-fix the re-run hit `CREATE TABLE …
/// already exists` and `Db::open` errored forever, bricking startup).
#[test]
fn a_crashed_fk_migration_recovers_on_the_next_open() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-migration-test-", "scratch");
    let path = dir.join("t.db");
    // A pre-existing database: `native_messages` WITHOUT the FK (the
    // pre-migration schema) + a session row + a transcript row.
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL
        );
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        INSERT INTO sessions VALUES ('s1', 'archimedes', '/tmp', 1, NULL, '{}');
        INSERT INTO native_messages VALUES ('s1', 0, 'user', '{}', 1);",
    )
    .unwrap();
    // The mid-batch CRASH state: a stale `native_messages_migrated`
    // table left behind.
    conn.execute_batch(
        "CREATE TABLE native_messages_migrated (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        INSERT INTO native_messages_migrated VALUES ('s1', 9, 'assistant', '{}', 2);",
    )
    .unwrap();
    drop(conn);
    // The next `Db::open` must SUCCEED (the migration is atomic +
    // crash-idempotent).
    let db = Db::open(&path).expect("the migration is crash-idempotent/atomic");
    // ...and the FK is in place now.
    let fk: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('native_messages') \
             WHERE \"table\" = 'sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fk, 1, "the FK is in place after recovery");
    // ...and the pre-existing rows survived the migration (the stale
    // `native_messages_migrated`'s rows were NOT merged in — only the
    // original table's rows are the transcript).
    let n: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "the pre-existing transcript row survived");
}

/// (finding 5) A legacy crash state: a crash under the pre-fix
/// autocommit code between `DROP TABLE native_messages` and the
/// `RENAME` leaves `native_messages` GONE with the rows living in
/// `native_messages_migrated`. `Db::open` must RECOVER (rename the
/// migrated table — the rows survive + the FK is restored), not error
/// forever (pre-fix the re-run hit `INSERT … SELECT … FROM
/// native_messages` → "no such table" → rollback → `Db::open` errored
/// forever, bricking startup).
#[test]
fn a_crashed_fk_migration_with_native_messages_gone_recovers_on_the_next_open() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-migration-test-", "scratch");
    let path = dir.join("t.db");
    // The crash state: `native_messages` is GONE (dropped + autocommitted)
    // and the rows live in `native_messages_migrated` (created WITH the FK
    // + the copy, autocommitted).
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL
        );
        CREATE TABLE native_messages_migrated (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        INSERT INTO sessions VALUES ('s1', 'archimedes', '/tmp', 1, NULL, '{}');
        INSERT INTO native_messages_migrated VALUES ('s1', 0, 'user', '{}', 1);",
    )
    .unwrap();
    drop(conn);
    // The next `Db::open` must SUCCEED (the migration recovers the crash
    // state by renaming the migrated table).
    let db = Db::open(&path).expect("the migration recovers the crash state");
    // ...and the FK is in place (the migrated table was created with it).
    let fk: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('native_messages') \
             WHERE \"table\" = 'sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fk, 1, "the FK is in place after recovery");
    // ...and the rows SURVIVED the recovery (the migrated table's rows
    // are the transcript now).
    let n: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id = 's1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "the transcript row survived the recovery");
}

/// (ADR 0016) A pre-existing database whose `sessions` table predates
/// the `archived` column must open CLEANLY (the one-time migration adds
/// the column with a `DEFAULT 0` backfill) and the pre-existing rows
/// must read `archived == false` (the default).
///
/// The fixture is `SCHEMA_WITHOUT_ARCHIVED`: every OTHER gated column is
/// present, so the `trusted` / `context_usage_json` / `is_subagent` /
/// `todos_json` / `cost_usd` / two `sort_order` gates and the pre-rip-out
/// `agent_id` purge all stay silent and this test observes its own gate.
#[test]
fn archived_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_ARCHIVED,
        // A cwd that does not exist on disk (the idiom the sort-order fixtures
        // use): the phase-11 space backfill skips it, so the fixture stays about
        // the ONE session row and the silence below is provable. The original
        // fixture's `/tmp` was never asserted — the row's `id` and `archived`
        // are what this test reads.
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/x/nope-not-a-folder', 1, '{}');",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the archived migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'archived'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the archived column is in place after the migration"
    );
    // Isolation, asserted rather than assumed: the sibling gates were silent,
    // so the ONE row this fixture seeded is the only row `Db::open` saw — no
    // space row was backfilled from a `sessions` cwd, no seed renumbered it.
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM spaces"),
        0,
        "the phase-11 space backfill stayed silent (the `/tmp` cwd of the fixture \
         row is not canonicalizable to a fresh space row here, so a space row \
         would mean a sibling gate ran inside this test)"
    );
    // ...and the pre-existing row reads `archived == false` (the default).
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed");
    assert_eq!(rows.len(), 1, "the pre-existing row survived");
    assert_eq!(rows[0].id, "s1");
    assert!(
        !rows[0].archived,
        "a pre-existing row reads archived == false"
    );
    // ...and a SECOND open of the already-migrated database is a clean
    // no-op (the `pragma_table_info` gate skips the ALTER) — the
    // migration is idempotent: the row survives re-opening intact with
    // `archived == false`.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed on the second open");
    assert_eq!(rows.len(), 1, "the pre-existing row survived the re-open");
    assert_eq!(rows[0].id, "s1");
    assert!(
        !rows[0].archived,
        "the re-opened row still reads archived == false"
    );
}

/// (native-only rip-out) A pre-rip-out database (`sessions` WITH the
/// `agent_id` column) must open CLEANLY on `Db::open`: the one-way
/// migration deletes ALL external `sessions` rows (`agent_id <> 'archimedes'`
/// — the built-in `pi` + any user-configured external entries; their
/// `messages` rows cascade via the FK) and drops the `agent_id` column.
/// The `messages` table STAYS (the native display transcript) and the
/// `archimedes` row + its `messages` / `native_messages` rows are intact.
/// Idempotent: a SECOND `Db::open` on the same file is a clean no-op
/// (the `PRAGMA table_info` probe is the guard).
#[test]
fn opening_a_pre_rip_out_database_migrates_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-riput-test-", "scratch");
    let path = dir.join("t.db");
    // A pre-rip-out database: the CURRENT schema with the `agent_id`
    // column still on `sessions` (the pre-feature shape).
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            message_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, kind, message_key)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        CREATE TABLE spaces (
            path TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0
        );
        -- (a) the built-in `pi` external entry + a display row.
        INSERT INTO sessions VALUES ('s-pi', 'pi', '/tmp', 1, NULL, '{}', 0);
        INSERT INTO messages VALUES (1, 's-pi', 'agent-text', 'm1', '{}', 1);
        -- (b) a user-configured external entry + a display row.
        INSERT INTO sessions VALUES ('s-cc', 'claude-code', '/tmp', 2, NULL, '{}', 0);
        INSERT INTO messages VALUES (2, 's-cc', 'agent-text', 'm2', '{}', 2);
        -- (c) the native entry + display + provider transcript rows.
        INSERT INTO sessions VALUES ('s-native', 'archimedes', '/tmp', 3, NULL, '{}', 0);
        INSERT INTO messages VALUES (3, 's-native', 'agent-text', 'm3', '{}', 3);
        INSERT INTO native_messages VALUES ('s-native', 0, 'user', '{}', 3);",
    )
    .unwrap();
    drop(conn);
    // `Db::open` must SUCCEED (the migration is one-way + idempotent).
    let db = Db::open(&path).expect("the pre-rip-out migration must not brick startup");
    let conn = db.conn.lock().expect("db mutex poisoned");
    // The `messages` table STILL EXISTS (the native display transcript).
    let messages_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        messages_exists, 1,
        "the messages table survives the migration (the native display transcript)"
    );
    // `sessions` has NO `agent_id` column (the migration dropped it).
    let has_agent_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'agent_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has_agent_id, 0,
        "the agent_id column is gone after the migration"
    );
    // The external rows are GONE with their `messages` rows (the FK cascade).
    let external_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id IN ('s-pi', 's-cc')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        external_sessions, 0,
        "the pi + claude-code session rows are deleted"
    );
    let external_messages: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id IN ('s-pi', 's-cc')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        external_messages, 0,
        "the external messages rows cascaded away"
    );
    // The `archimedes` row SURVIVES with its `messages` + `native_messages`
    // rows intact.
    let native_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_sessions, 1, "the archimedes session row survived");
    let native_messages: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_messages, 1, "the native messages row survived");
    let native_transcript: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM native_messages WHERE session_id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_transcript, 1, "the native transcript row survived");
    // A SECOND `Db::open` on the same file is a clean no-op (idempotency —
    // the `PRAGMA table_info` probe is the guard): the rows are intact.
    drop(conn);
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let conn = db.conn.lock().expect("db mutex poisoned");
    let has_agent_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'agent_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has_agent_id, 0,
        "the re-open is a no-op (the column stays dropped)"
    );
    let native_sessions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = 's-native'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(native_sessions, 1, "the native row survived the re-open");
}

/// (ADR 0016) `list_sessions(false)` never returns archived rows;
/// `list_sessions(true)` returns them with the flag set. Mixed-list
/// parity: with a mix of archived and non-archived rows, the default
/// list returns EXACTLY the non-archived row and the full list returns
/// both with the correct flags.
#[test]
fn list_sessions_filters_archived_by_default() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let mk = |id: &str| SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    // Two sessions; one of them gets archived.
    db.record_session(&mk("sess-1"))
        .expect("record_session should succeed");
    db.record_session(&mk("sess-2"))
        .expect("record_session should succeed");
    assert!(
        db.set_session_archived("sess-1", true)
            .expect("set_session_archived should succeed"),
        "a matching row returns true"
    );
    let visible = db
        .list_sessions(false)
        .expect("list_sessions(false) should succeed");
    assert_eq!(
        visible.len(),
        1,
        "list_sessions(false) returns exactly the non-archived row"
    );
    assert_eq!(
        visible[0].id, "sess-2",
        "the default list returns the non-archived row"
    );
    assert!(
        !visible[0].archived,
        "list_sessions(false) never returns archived rows"
    );
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 2, "list_sessions(true) returns both rows");
    let by_id: std::collections::HashMap<&str, &bool> =
        all.iter().map(|r| (r.id.as_str(), &r.archived)).collect();
    assert_eq!(
        by_id["sess-1"], &true,
        "the archived flag is set on the row"
    );
    assert_eq!(by_id["sess-2"], &false, "the non-archived flag is clear");
}

/// (ADR 0016) `set_session_archived` on an id with no row is a no-op:
/// `Ok(false)` (mirrors `set_space_trusted`'s documented behavior).
#[test]
fn set_session_archived_is_a_noop_for_an_unknown_id() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    assert!(
        !db.set_session_archived("no-such-session", true)
            .expect("should not error"),
        "a missing row is a no-op returning false"
    );
}

/// The list is ordered by `sort_order`, then `id DESC`: the position the
/// user (or a drag) gave a row decides where it sits, and nothing else
/// moves it (ADR 0075 — `docs/decisions/0075-list-position-is-not-evidence.md`).
///
/// The fixture makes `sort_order` and recency DISAGREE: the last-listed
/// session gets the newest transcript, so the old recency `ORDER BY` would
/// have floated it to the top. A fixture where both orders agreed would pass
/// under either statement and prove nothing.
#[test]
fn list_sessions_orders_by_sort_order_then_id_desc() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortlist-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Recorded through `record_session` so `sort_order` is actually written
    // (raw INSERTs would leave every row on `DEFAULT 0` and tie the list).
    for id in ["s_x", "s_y", "s_z"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }
    // Re-number them into a NON-recency sequence: `s_y` leads, the row
    // recorded first (`s_x`) lands last.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (id, value) in [("s_x", 2_i64), ("s_y", 0), ("s_z", 1)] {
            conn.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, value],
            )
            .expect("sort_order write should succeed");
        }
    }
    // The LAST-listed row gets the newest transcript: recency says it leads,
    // its number says it trails, and the number is what wins.
    db.record_message("s_x", "user", None, "{\"text\":\"hi\"}")
        .expect("record_message should succeed");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_y", "s_z", "s_x"],
        "rows come back in `sort_order` order even though the last one has \
         the newest message — position is not evidence of recency"
    );
}

/// Two rows sharing a `sort_order` break the tie on `id DESC`, and BOTH arms
/// of the statement order identically: the archived-inclusive read is the
/// OTHER arm, so it is a real second assertion (it can fail on its own) and
/// not a copy of the first — one shared `ORDER BY` is what keeps them from
/// drifting.
///
/// Recency is made to disagree (the first-id row carries the newest
/// transcript), so the assertion cannot be satisfied by the old ordering.
#[test]
fn list_sessions_ties_break_on_id_desc() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sorttie-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&title_session("s_a"))
        .expect("record s_a");
    db.record_session(&title_session("s_b"))
        .expect("record s_b");
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        conn.execute("UPDATE sessions SET sort_order = 5", [])
            .expect("tie the two rows on one number");
    }
    // `s_a`'s transcript is the newer one, so the old recency key would put
    // `s_a` FIRST; the tie-break is what puts `s_b` first here. The
    // `created_at` is written EXPLICITLY and far in the future: both rows
    // were recorded inside the same millisecond, so a `record_message`
    // timestamp could TIE their last activity and let the old statement
    // reach the same `id DESC` answer for the wrong reason.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_a', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_b", "s_a"],
        "an equal `sort_order` breaks on `id DESC`, never on recency"
    );

    // Archive one of the two tied rows: the second read now runs the
    // archived-inclusive arm over the same pair.
    assert!(db
        .set_session_archived("s_a", true)
        .expect("set_session_archived should succeed"));
    let ids: Vec<String> = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_b", "s_a"],
        "the archived-inclusive arm orders the tied pair identically"
    );
}

/// (ADR 0075 behaviour pin) Transcript activity never moves a row: the
/// session with the NEWEST message sits in the MIDDLE of the `sort_order`
/// sequence and stays there. The old statement floated it to the top on
/// every persisted message, which is the bug ADR 0075 exists to kill.
#[test]
fn list_sessions_ignores_transcript_activity() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortidle-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    for id in ["s_a", "s_b", "s_c"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }
    // Reverse the numbers: the sequence becomes [s_c, s_b, s_a], so `s_b`
    // is the MIDDLE row.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (id, value) in [("s_a", 2_i64), ("s_b", 1), ("s_c", 0)] {
            conn.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, value],
            )
            .expect("sort_order write should succeed");
        }
    }
    // The middle row gets the only (and therefore newest) transcript. The
    // `created_at` is written EXPLICITLY and far in the future so the old
    // recency key deterministically floats this row to the TOP: with three
    // rows recorded inside one millisecond a `record_message` timestamp
    // could tie every row's last activity, and the old statement's own
    // `id DESC` tie-break would then answer `["s_c", "s_b", "s_a"]` — the
    // expected order, for the wrong reason, i.e. a vacuous green.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_b', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_c", "s_b", "s_a"],
        "the session with the newest message keeps its middle position"
    );
}

/// CHARACTERISATION (ADR 0075, the pin Task 1 exists for): `session_recency`'s
/// `last_active_at` equals what the OLD recency expression — the one
/// `list_sessions` used to `ORDER BY` — yields for the same row. The
/// expectation is read by raw SQL that SPELLS the `COALESCE(MAX …)`
/// expression out in full and deliberately does NOT interpolate
/// `LAST_ACTIVITY`: recomputing the expectation from the const under test
/// would make this pin green on any edit to that const (the same reasoning
/// `tauriBarrel.test.ts` gives for its literal list, and the reasoning
/// `list_sessions_ties_break_on_id_desc` gives for its explicit timestamp).
///
/// The fixture covers the three shapes that can break the equivalence:
/// - `s_msg_new`: one message, so "newest" is unambiguous;
/// - `s_msg_old`: TWO messages inserted **smaller-last**, so an implementation
///   that read "the last message by id" instead of `MAX()` answers
///   `1_600_000_000_000` here while the real expression answers
///   `9_000_000_000_000` — the test cannot pass by accident;
/// - `s_no_messages`: `MAX()` over no rows is `NULL`, which SQLite sorts LAST
///   in a `DESC` list (the reason `RECENT_FIRST`'s `COALESCE` exists) — so the
///   entry must be PRESENT and equal the row's own `created_at`, never
///   NULL/absent;
/// - `s_archived`: the Archived section sorts by recency, so an archived
///   session with no recency entry is the bug this task must not ship.
///
/// Every message row is written by RAW SQL with an EXPLICIT far-future
/// `created_at`, never by `record_message`: `record_session` and
/// `record_message` both stamp `now_ms()`, so rows written inside one test
/// land in the same millisecond and recency cannot separate them at all — a
/// `record_message` fixture would tie every row and let the assertion pass for
/// the wrong reason (the trap T01 records and carries forward here).
#[test]
fn session_recency_matches_the_old_coalesce_expression() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-recency-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    for id in ["s_msg_new", "s_msg_old", "s_no_messages", "s_archived"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }

    // `s_msg_new`: the single newest transcript stamp, far in the future.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_msg_new', 'user', NULL, '{}', 9_999_999_999_999)",
            [],
        )
        .expect("fixture message row");
    // `s_msg_old`: TWO rows inserted SMALLER-LAST — the newest is the FIRST
    // insert, so `MAX()` and "last row by id" disagree (see the doc comment).
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_msg_old', 'user', NULL, '{}', 9_000_000_000_000)",
            [],
        )
        .expect("fixture message row (newer, inserted first)");
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_msg_old', 'agent-text', 'k0', '{}', 1_600_000_000_000)",
            [],
        )
        .expect("fixture message row (older, inserted LAST)");
    // `s_no_messages`: nothing written — the `COALESCE` fallback case.
    // `s_archived`: archived, no messages.
    assert!(db
        .set_session_archived("s_archived", true)
        .expect("set_session_archived should succeed"));

    let rows = db
        .session_recency()
        .expect("session_recency should succeed");

    // The OLD expression, spelled out rather than interpolated — the whole
    // point of a characterisation test.
    let old_key = |id: &str| -> i64 {
        db.conn
            .lock()
            .expect("db mutex poisoned")
            .query_row(
                "SELECT COALESCE((SELECT MAX(m.created_at) FROM messages m \
                  WHERE m.session_id = sessions.id), sessions.created_at) \
                 FROM sessions WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .expect("the old recency expression must resolve for a stored id")
    };

    for id in ["s_msg_new", "s_msg_old", "s_no_messages", "s_archived"] {
        let entry = rows
            .iter()
            .find(|r| r.session_id == id)
            .unwrap_or_else(|| panic!("`session_recency` must return an entry for {id}"));
        assert_eq!(
            entry.last_active_at,
            old_key(id),
            "`{id}`'s recency equals what the OLD expression yields for the same row"
        );
    }

    // The `MAX()`-not-last-inserted half, pinned as a NUMBER as well as
    // against the expression: `s_msg_old`'s newest stamp is its FIRST insert.
    assert_eq!(
        rows.iter()
            .find(|r| r.session_id == "s_msg_old")
            .expect("`s_msg_old` is listed")
            .last_active_at,
        9_000_000_000_000,
        "recency is `MAX(created_at)`, not the last-inserted row's stamp"
    );

    // The no-messages case, spelled out separately: the entry EXISTS (an
    // absent key would strand the row in T03's recency map) and equals the
    // row's own `created_at` — never NULL, never absent.
    let created_at: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT created_at FROM sessions WHERE id = 's_no_messages'",
            [],
            |r| r.get(0),
        )
        .expect("the row's own created_at");
    let fallback = rows
        .iter()
        .find(|r| r.session_id == "s_no_messages")
        .expect("a session with no messages still gets a recency entry");
    assert_eq!(
        fallback.last_active_at, created_at,
        "the `COALESCE` falls back to the row's own `created_at` \
         (`MAX()` over no rows is NULL, which SQLite sorts LAST in a DESC list)"
    );

    // The archived half: the Archived section sorts by recency, so the row
    // must be in the result at all.
    assert!(
        rows.iter().any(|r| r.session_id == "s_archived"),
        "an archived session gets a recency entry — the Archived section sorts by it"
    );
}

/// The DRIFT GUARD beside the characterisation test: `LAST_ACTIVITY` equals
/// the old expression, spelled as a LITERAL here. The moment anyone edits the
/// const this reddens, so the characterisation above has to be re-decided
/// rather than silently drifting with it.
///
/// The right-hand side is the ONE-LINE spelling on purpose (the const itself
/// carries `\\`-continuations): the assertion says out loud that the const's
/// multi-line form and this single-line form are the same expression, which a
/// whitespace-normalising comparison would not.
#[test]
fn the_last_activity_const_matches_the_expression_the_row_prints() {
    assert_eq!(
        LAST_ACTIVITY,
        "COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = sessions.id), sessions.created_at)"
    );
}

/// (ADR 0075) `session_recency` covers EVERY non-subagent session — archived
/// included, matching `list_sessions(true)`'s key set exactly — and excludes
/// `is_subagent = 1` rows.
///
/// The subagent row's PRESENCE in the table is witnessed by raw SQL against
/// `db.conn`: that is the only witness that exists, because `list_sessions`
/// filters hidden rows out of every read path (the shape
/// `list_sessions_hides_subagent_rows_but_their_transcripts_load` establishes).
/// Without it, "no third entry" would be indistinguishable from "the fixture
/// never wrote the row".
#[test]
fn session_recency_covers_archived_and_excludes_subagent_rows() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-recencycover-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");

    db.record_session(&title_session("main-1"))
        .expect("record main-1");
    db.record_session(&title_session("arch-1"))
        .expect("record arch-1");
    assert!(db
        .set_session_archived("arch-1", true)
        .expect("set_session_archived should succeed"));
    let sub = SessionInfo {
        session_id: "sub-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: true,
    };
    db.record_session(&sub).expect("record subagent");

    let ids: Vec<String> = db
        .session_recency()
        .expect("session_recency should succeed")
        .into_iter()
        .map(|r| r.session_id)
        .collect();
    assert_eq!(
        ids,
        vec!["arch-1", "main-1"],
        "every non-subagent session is returned (archived included) and \
         the subagent row is not — exactly `list_sessions(true)`'s key set"
    );

    // The hidden row is really in the table (raw SQL — the only witness).
    let hidden: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE id = 'sub-1'",
            [],
            |r| r.get(0),
        )
        .expect("count the subagent row");
    assert_eq!(
        hidden, 1,
        "the subagent row exists in `sessions` — it was EXCLUDED, not missing"
    );
}

/// (ADR 0075, D11 reversed) `session_recency` carries the row's OWN stored
/// order number, so ONE frontend sequence can interleave live and stored
/// rows: a resumed Session's row is in this result set (every non-subagent
/// row is), and its position is knowable without a second round-trip.
///
/// TWO halves, and the second is the point:
///  (a) each reported number EQUALS that row's `sort_order` column as read
///      by the file's own `sort_order_of` helper — the payload ECHOES the
///      column, it derives nothing;
///  (b) after `reorder_sessions` the reported numbers MOVE with it, so
///      `Db::session_recency` and `Db::reorder_sessions` — the write path a
///      drag uses — AGREE about the column. A boot order map built from a
///      reader that disagreed with the writer would reshuffle the list the
///      user just arranged, which is the exact bug this branch exists to
///      kill.
///
/// Sessions go in through `record_session`, never raw `INSERT`s: a raw row
/// keeps `DEFAULT 0` and would tie all three, so the numbers would prove
/// nothing (T01/T02's fixture rule). The expectations are literal integers,
/// never recomputed from a constant under test.
#[test]
fn session_recency_reports_the_manual_order_number_and_reorder_moves_it() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-recencyorder-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    for id in ["a", "b", "c"] {
        db.record_session(&title_session(id))
            .expect("record_session should succeed");
    }

    let reported = |id: &str| -> i64 {
        db.session_recency()
            .expect("session_recency should succeed")
            .into_iter()
            .find(|r| r.session_id == id)
            .unwrap_or_else(|| panic!("`session_recency` must return an entry for {id}"))
            .sort_order
    };

    // (a) The payload echoes the COLUMN, row by row — not the position in
    // the returned `Vec` (which is ordered by `id`, so on this fixture the
    // two would coincide; `sort_order_of` is the independent witness).
    for (id, number) in [("a", 0), ("b", 1), ("c", 2)] {
        assert_eq!(
            reported(id),
            sort_order_of(&db, "sessions", "id", id),
            "`{id}`'s reported number is the row's own `sort_order` column"
        );
        assert_eq!(
            reported(id),
            number,
            "`{id}` was recorded {number}th, so it holds the number {number} \
             (the bottom-join `MAX + 1` in record order)"
        );
    }

    // (b) The write path a drag uses moves the reported number too.
    let ids: Vec<String> = ["c", "a", "b"].iter().map(|s| s.to_string()).collect();
    db.reorder_sessions(&ids)
        .expect("reorder_sessions should succeed");
    assert_eq!(
        vec![reported("a"), reported("b"), reported("c")],
        vec![1, 2, 0],
        "after `reorder_sessions([c, a, b])` the reported numbers are the \
         new slice indices — the reader and the writer agree about the column"
    );
}

/// Spaces order by `sort_order` with `path ASC` breaking ties. The fixture
/// gives the FIRST-listed row the LOWEST `last_opened_at`, so the old
/// recency statement would have returned the reverse-ish order; and the
/// second half ties two rows so the tie-break itself is pinned (and pinned
/// as stable across reads, not re-derived from recency).
#[test]
fn list_spaces_orders_by_sort_order_then_path() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacelist-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Upserted z, m, a: `sort_order` 0,1,2 while `path ASC` is a,m,z — the
    // two orders disagree, so the tie-break half below is not vacuous.
    let dirs = [dir.join("zzz"), dir.join("mmm"), dir.join("aaa")];
    for d in &dirs {
        std::fs::create_dir_all(d).unwrap();
    }
    let keys: Vec<String> = dirs
        .iter()
        .map(|d| {
            db.upsert_space(d.to_str().unwrap(), false)
                .expect("upsert_space should succeed");
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    // Recency says the opposite: the first-listed row is the STALEST.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for (key, opened) in [(&keys[0], 1_000_i64), (&keys[1], 3_000), (&keys[2], 2_000)] {
            conn.execute(
                "UPDATE spaces SET last_opened_at = ?2 WHERE path = ?1",
                params![key, opened],
            )
            .expect("last_opened_at write should succeed");
        }
    }

    let paths: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        paths, keys,
        "rows come back in `sort_order` order although the first is the least recently opened"
    );

    // Tie two rows on one number: they must come back `path ASC` (`a`
    // before `m`), NOT in the order their `last_opened_at` values imply.
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        for key in [&keys[1], &keys[2]] {
            conn.execute(
                "UPDATE spaces SET sort_order = 7 WHERE path = ?1",
                params![key],
            )
            .expect("tie the two rows on one number");
        }
    }
    let paths: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        paths,
        vec![keys[0].clone(), keys[2].clone(), keys[1].clone()],
        "a tied `sort_order` breaks on `path ASC` and never on recency"
    );
}

/// A minimal recorded-session shape for the title tests (the title
/// itself is never part of the literal — nothing writes it through
/// `record_session`, only through `set_session_title`).
fn title_session(id: &str) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    }
}

/// The session's title is written ONLY while it has none, and only once:
/// the first `set_session_title` writes the `NULL` title and returns
/// `true`, and both `session()` and `list_sessions()` read it back (the
/// naming pass's write must reach the boot fetch that lists sessions).
#[test]
fn set_session_title_writes_a_null_title_and_reads_back() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");
    // A recorded session starts UNTITLED (`record_session` inserts NULL).
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title,
        None,
        "a recorded session has no title yet"
    );
    assert!(
        db.set_session_title("sess-1", "Refactor the auth middleware")
            .expect("set_session_title should succeed"),
        "a session with no title is written, so the call returns true"
    );
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title
            .as_deref(),
        Some("Refactor the auth middleware"),
        "the title is stored on the row"
    );
    // …and it surfaces in the listing the boot fetch uses.
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert_eq!(
        all[0].title.as_deref(),
        Some("Refactor the auth middleware"),
        "list_sessions reads the title back"
    );
}

/// A title that already exists is NEVER overwritten — a second
/// `set_session_title` returns `false` and leaves the FIRST title (the
/// generated title from an earlier turn, or one a future rename
/// affordance wrote, wins). This is the race guard: the naming pass may
/// fire on several turns, and only the first write lands.
#[test]
fn set_session_title_never_overwrites_an_existing_title() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    db.record_session(&title_session("sess-1"))
        .expect("record_session should succeed");
    db.set_session_title("sess-1", "First title")
        .expect("the first write should succeed");
    assert!(
        !db.set_session_title("sess-1", "Second title")
            .expect("set_session_title should not error on a titled row"),
        "a titled row writes nothing, so the call returns false"
    );
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title
            .as_deref(),
        Some("First title"),
        "the first title survives the second call"
    );
}

/// `set_session_title` on an id with no row is a no-op: `Ok(false)`
/// (mirrors `set_session_archived` — a missing row is not an error).
#[test]
fn set_session_title_is_a_noop_for_an_unknown_id() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    assert!(
        !db.set_session_title("no-such-session", "Any title")
            .expect("should not error"),
        "a missing row is a no-op returning false"
    );
}

/// A re-`record_session` (the resume re-record) never clears the stored
/// title — the `ON CONFLICT … DO UPDATE` branch must not touch `title`
/// (resuming a titled session must not erase its label, exactly as it
/// must not un-archive it).
#[test]
fn record_session_preserves_the_title() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-title-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = title_session("sess-1");
    db.record_session(&session)
        .expect("record_session should succeed");
    db.set_session_title("sess-1", "Kept title")
        .expect("set_session_title should succeed");
    // The resume re-record (the same upsert, a refreshed row).
    db.record_session(&session)
        .expect("re-record should succeed");
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .title
            .as_deref(),
        Some("Kept title"),
        "a re-record never clears the stored title"
    );
}

/// A re-`record_session` (the resume re-record) never resets the accumulated
/// `cost_usd` — the `ON CONFLICT … DO UPDATE` branch touches only `cwd` /
/// `capabilities_json` / `is_subagent`, so a session that has spent money
/// keeps its figure across a resume.
///
/// This is load-bearing and was pinned only in prose: `record_session`'s doc
/// and `record_session_cost`'s both lean on the DO UPDATE list being narrow.
/// A future column added to that list (or the cost moved into the INSERT
/// column list with a `excluded.cost_usd` update) would silently zero a
/// resumed session's total — the figure the user sees in the sidebar would
/// reset under a reopen while the provider keeps billing, and the roll-up
/// would then add the children's sums to a reset base. Mirrors
/// `record_session_preserves_the_title` /
/// `record_session_preserves_the_archived_flag` for the cost column.
#[test]
fn record_session_preserves_the_cost() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = title_session("sess-1");
    db.record_session(&session)
        .expect("record_session should succeed");
    // The accumulated figure (two frames' worth, so the assertion is not
    // accidentally pinning "one write" rather than "no clobber").
    db.record_session_cost("sess-1", 0.00001243)
        .expect("record_session_cost should succeed");
    db.record_session_cost("sess-1", 0.00002)
        .expect("record_session_cost should succeed");
    // The resume re-record (the same upsert, a refreshed row).
    db.record_session(&session)
        .expect("re-record should succeed");
    assert_eq!(
        db.session("sess-1")
            .expect("session should succeed")
            .expect("the row exists")
            .cost_usd,
        Some(0.00003243),
        "a re-record never resets the accumulated cost"
    );
    // And through the LIST read the sidebar / resume path actually uses.
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert_eq!(
        all[0].cost_usd,
        Some(0.00003243),
        "the figure survives a re-record on the list read too"
    );
}

/// (ADR 0016) A re-`record_session` (the resume re-record) never clears
/// the archived flag — the `ON CONFLICT … DO UPDATE` branch must not
/// touch `archived` (no retroactive un-archive).
#[test]
fn record_session_preserves_the_archived_flag() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = SessionInfo {
        session_id: "sess-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": "sess-1",
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&session)
        .expect("record_session should succeed");
    // The `is_subagent` flag is written (the `record_session` upsert).
    let row = db.session("sess-1").unwrap().unwrap();
    assert!(!row.is_subagent);
    db.set_session_archived("sess-1", true)
        .expect("set_session_archived should succeed");
    // The resume re-record (the same upsert, a refreshed row).
    db.record_session(&session)
        .expect("re-record should succeed");
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert!(
        all[0].archived,
        "a re-record never clears the archived flag"
    );
}

/// `update_session_capabilities` updates `capabilities_json` while preserving
/// `title`, `cost_usd`, and `sort_order` (the row's manual list position, ADR 0075).
#[test]
fn update_session_capabilities_updates_envelope_and_preserves_other_columns() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-caps-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = title_session("sess-1");
    db.record_session(&session)
        .expect("record_session should succeed");
    db.set_session_title("sess-1", "Kept title")
        .expect("set_session_title should succeed");
    db.record_session_cost("sess-1", 0.000042)
        .expect("record_session_cost should succeed");
    let initial_sort_order = sort_order_of(&db, "sessions", "id", "sess-1");

    let new_caps = serde_json::json!({
        "native": true,
        "model": "tama/b",
        "loadSession": true,
        "thinkingLevel": "xhigh",
    })
    .to_string();

    db.update_session_capabilities("sess-1", &new_caps)
        .expect("update_session_capabilities should succeed");

    let row = db
        .session("sess-1")
        .expect("session should succeed")
        .expect("the row exists");

    assert_eq!(row.capabilities_json, new_caps);
    assert_eq!(row.title.as_deref(), Some("Kept title"));
    assert_eq!(row.cost_usd, Some(0.000042));
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "sess-1"),
        initial_sort_order,
        "updating capabilities must never renumber sort_order (ADR 0075)"
    );
}

/// Calling `update_session_capabilities` on a non-existent session id succeeds
/// without error and creates no row (a silent no-op, mirroring `record_session_cost`).
#[test]
fn update_session_capabilities_on_a_missing_row_is_a_silent_no_op() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-caps-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");

    let caps = serde_json::json!({
        "native": true,
        "model": "tama/b",
    })
    .to_string();

    db.update_session_capabilities("nonexistent", &caps)
        .expect("a missing row is a no-op returning Ok(())");
    assert!(
        db.session("nonexistent").expect("session lookup").is_none(),
        "nothing was written for a row that does not exist"
    );
    assert!(db.list_sessions(true).expect("list_sessions").is_empty());
}

/// (ADR 0025 §3) A subagent `sessions` row (`is_subagent = 1`) is
/// HIDDEN from `list_sessions` (the `is_subagent = 0` filter) but its
/// transcript rows are still loadable (`load_native_messages` works
/// for subagent ids — it does NOT filter on `is_subagent`).
#[test]
fn list_sessions_hides_subagent_rows_but_their_transcripts_load() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-subagent-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    // A main session row.
    let main = SessionInfo {
        session_id: "main-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&main).expect("record main");
    // A subagent session row (hidden).
    let sub = SessionInfo {
        session_id: "sub-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: true,
    };
    db.record_session(&sub).expect("record subagent");
    // `list_sessions` (both variants) hides the subagent row.
    let all = db.list_sessions(true).expect("list");
    assert_eq!(all.len(), 1, "only the main session is listed");
    assert_eq!(all[0].id, "main-1");
    // The subagent's transcript is still loadable (no `is_subagent` filter).
    db.insert_native_message("sub-1", 0, "system", r#"{\"role\":\"system\"}"#)
        .expect("insert subagent transcript");
    let rows = db
        .load_native_messages("sub-1")
        .expect("load subagent transcript");
    assert_eq!(rows.len(), 1, "the subagent transcript loads");
}

/// A pre-existing database whose `sessions` table predates the
/// `context_usage_json` column must open CLEANLY (the one-time
/// migration adds the column) and the pre-existing rows must read
/// `context_usage == None` (the default).
///
/// The fixture is `SCHEMA_WITHOUT_CONTEXT_USAGE`: every OTHER gated column is
/// present, so the sibling gates stay silent and this test observes its own.
#[test]
fn context_usage_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-context-test-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_CONTEXT_USAGE,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, archived) \
         VALUES ('s1', '/tmp', 1, '{}', 0);",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the context_usage migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'context_usage_json'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the context_usage_json column is in place after the migration"
    );
    // ...and the pre-existing row reads `context_usage == None` (no data yet).
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed");
    assert_eq!(rows.len(), 1, "the pre-existing row survived");
    assert!(
        rows[0].context_usage_json.is_none(),
        "a pre-existing row reads context_usage == None"
    );
    // ...and a SECOND open of the already-migrated database is a clean
    // no-op (the `pragma_table_info` gate skips the ALTER) — the
    // migration is idempotent.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed on the second open");
    assert!(
        rows[0].context_usage_json.is_none(),
        "the re-opened row still reads context_usage == None"
    );
}

/// A pre-existing database whose `sessions` table predates the
/// `cost_usd` column must open CLEANLY (the one-time migration adds the
/// column) and the pre-existing rows must read `cost_usd == None`
/// (issue #105).
///
/// `None` — not `0.0` — is the load-bearing half of this test: a column
/// `DEFAULT 0` would migrate every old row to "this session spent
/// nothing", which is a FIGURE the provider never reported, and the
/// renderer would print `$0.00` under sessions that were never priced
/// (the D5 defect, ADR 0082). The migration therefore has no `DEFAULT`
/// and NO backfill — cost data never existed anywhere, so there is
/// nothing honest to backfill.
#[test]
fn cost_usd_column_migration_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    // A pre-existing database: the `sessions` table WITHOUT `cost_usd`.
    // Every OTHER gated column IS present, so this test isolates the
    // `cost_usd` gate (the sibling migrations are no-ops here) — the same
    // isolation the `context_usage_json` migration test above practices, now
    // spelled as the shared `SCHEMA_WITHOUT_COST_USD` constant.
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_COST_USD,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/tmp', 1, '{}');",
    );
    // The next `Db::open` must SUCCEED (the migration adds the column).
    let db = Db::open(&path).expect("the cost_usd migration is one-time and idempotent");
    // ...and the column is in place now.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'cost_usd'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the cost_usd column is in place after the migration"
    );
    // And it has NO default. A `DEFAULT 0` would pass the assertion below
    // only by lying — every migrated row would read "spent nothing", a
    // figure the provider never reported (the phantom-`$0.00` defect, D5 /
    // ADR 0082). Pinned directly, because the `None` assertions below would
    // ALSO pass under a `DEFAULT NULL` that someone later "improves".
    let default_value: Option<String> = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('sessions') WHERE name = 'cost_usd'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        default_value, None,
        "`cost_usd` has NO column DEFAULT — NULL means 'never reported', 0 means 'reported zero'"
    );
    // ...and the pre-existing row reads `cost_usd == None` — never `0.0`.
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed");
    assert_eq!(rows.len(), 1, "the pre-existing row survived");
    assert_eq!(
        rows[0].cost_usd, None,
        "a pre-existing row reads cost_usd == None (no figure was ever reported)"
    );
    // `session()` reads it the same way (the two queries stay in lockstep).
    let row = db
        .session("s1")
        .expect("session should succeed")
        .expect("the pre-existing row is there");
    assert_eq!(
        row.cost_usd, None,
        "the resume read agrees with the list read"
    );
    // ...and a SECOND open of the already-migrated database is a clean
    // no-op (the `pragma_table_info` gate skips the ALTER) — the
    // migration is idempotent.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the migrated db must succeed");
    let rows = db
        .list_sessions(true)
        .expect("list_sessions should succeed on the second open");
    assert_eq!(
        rows[0].cost_usd, None,
        "the re-opened row still reads cost_usd == None"
    );
}

/// `record_session_context_usage` persists the session's last known
/// context usage (the frontend's context-percentage display for a
/// CLOSED session — the store drops it on close, but the row keeps
/// it): `session()` / `list_sessions()` read it back, and
/// `record_session` (the resume re-record) does NOT clobber it.
#[test]
fn record_session_context_usage_persists_and_survives_record_session() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-context-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let session = SessionInfo {
        session_id: "sess-1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": "sess-1",
            "loadSession": true,
        }),
        config_options: None,
        context_usage: None,
        cost_usd: None,
        archived: false,
        title: None,
        is_subagent: false,
    };
    db.record_session(&session)
        .expect("record_session should succeed");
    // Persist the last known usage (the `context_usage_update` frame's
    // values — the provider's `input_tokens` vs the model's window).
    db.record_session_context_usage("sess-1", 53_760, 128_000)
        .expect("record_session_context_usage should succeed");
    // `session()` reads it back.
    let row = db
        .session("sess-1")
        .expect("session should succeed")
        .unwrap();
    let usage: serde_json::Value =
        serde_json::from_str(&row.context_usage_json.unwrap()).expect("the usage is JSON");
    assert_eq!(usage["used"], 53_760);
    assert_eq!(usage["window"], 128_000);
    // `list_sessions()` reads it back too.
    let all = db
        .list_sessions(true)
        .expect("list_sessions(true) should succeed");
    assert_eq!(all.len(), 1);
    assert!(all[0].context_usage_json.is_some());
    // The resume re-record (the same upsert, a refreshed row) must NOT
    // clobber the persisted usage (the `record_session` DO UPDATE never
    // touches `context_usage_json`).
    db.record_session(&session)
        .expect("re-record should succeed");
    let row = db
        .session("sess-1")
        .expect("session should succeed")
        .unwrap();
    let usage: serde_json::Value = serde_json::from_str(&row.context_usage_json.unwrap())
        .expect("the usage survived the re-record");
    assert_eq!(
        usage["used"], 53_760,
        "a re-record never clobbers the context usage"
    );
}

/// `messages_page` pages newest-first by id, returns ascending order,
/// and reports `has_more` correctly across boundaries and exact fits.
#[test]
fn messages_page_paginates_and_reports_has_more() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-page-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let mk = |id: &str| SessionInfo {
        session_id: id.to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({
            "piSessionId": id,
            "loadSession": true,
        }),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&mk("sess-1"))
        .expect("record_session should succeed");
    db.record_session(&mk("sess-2"))
        .expect("record_session should succeed");

    for i in 0..7 {
        db.record_message("sess-1", "agent-text", Some(&format!("k{i}")), "{}")
            .expect("record_message should succeed");
    }
    for i in 0..2 {
        db.record_message("sess-2", "agent-text", Some(&format!("k2_{i}")), "{}")
            .expect("record_message should succeed");
    }

    // messages_page(s, None, Some(3)) returns the LAST 3 in ascending order with has_more == true
    let (p1, has_more) = db
        .messages_page("sess-1", None, Some(3))
        .expect("messages_page should succeed");
    assert_eq!(p1.len(), 3);
    assert!(has_more);
    assert_eq!(p1[0].message_key.as_deref(), Some("k4"));
    assert_eq!(p1[1].message_key.as_deref(), Some("k5"));
    assert_eq!(p1[2].message_key.as_deref(), Some("k6"));
    assert!(p1.iter().all(|r| r.session_id == "sess-1"));

    // messages_page(s, Some(<oldest returned id>), Some(3)) returns the previous 3 ascending, has_more == true
    let oldest_id = p1[0].id;
    let (p2, has_more) = db
        .messages_page("sess-1", Some(oldest_id), Some(3))
        .expect("messages_page should succeed");
    assert_eq!(p2.len(), 3);
    assert!(has_more);
    assert_eq!(p2[0].message_key.as_deref(), Some("k1"));
    assert_eq!(p2[1].message_key.as_deref(), Some("k2"));
    assert_eq!(p2[2].message_key.as_deref(), Some("k3"));
    assert!(p2.iter().all(|r| r.session_id == "sess-1"));

    // the next page returns 1 row with has_more == false
    let oldest_id_p2 = p2[0].id;
    let (p3, has_more) = db
        .messages_page("sess-1", Some(oldest_id_p2), Some(3))
        .expect("messages_page should succeed");
    assert_eq!(p3.len(), 1);
    assert!(!has_more);
    assert_eq!(p3[0].message_key.as_deref(), Some("k0"));
    assert!(p3.iter().all(|r| r.session_id == "sess-1"));

    // messages_page(s, None, Some(7)) returns 7 with has_more == false (exact fit)
    let (p_all, has_more) = db
        .messages_page("sess-1", None, Some(7))
        .expect("messages_page should succeed");
    assert_eq!(p_all.len(), 7);
    assert!(!has_more);
    assert_eq!(p_all[0].message_key.as_deref(), Some("k0"));
    assert_eq!(p_all[6].message_key.as_deref(), Some("k6"));
    assert!(p_all.iter().all(|r| r.session_id == "sess-1"));

    // messages_page(s, None, None) equals messages_for(s) with has_more == false
    let (p_none, has_more) = db
        .messages_page("sess-1", None, None)
        .expect("messages_page should succeed");
    let for_all = db
        .messages_for("sess-1")
        .expect("messages_for should succeed");
    assert_eq!(p_none, for_all);
    assert!(!has_more);

    // the other session's rows never appear
    assert!(p_all.iter().all(|r| r.session_id == "sess-1"));
    let (p_sess2, has_more2) = db
        .messages_page("sess-2", None, None)
        .expect("messages_page should succeed");
    assert_eq!(p_sess2.len(), 2);
    assert!(!has_more2);
    assert!(p_sess2.iter().all(|r| r.session_id == "sess-2"));
}

#[test]
fn record_session_todos_roundtrips_and_clears() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-todos-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // Initially None
    assert_eq!(db.session_todos("s1").unwrap(), None);

    // Roundtrips Some
    let todos = r#"[{"content":"task1","status":"pending"}]"#;
    db.record_session_todos("s1", Some(todos)).unwrap();
    assert_eq!(db.session_todos("s1").unwrap(), Some(todos.to_string()));

    // None clears to None
    db.record_session_todos("s1", None).unwrap();
    assert_eq!(db.session_todos("s1").unwrap(), None);

    // Missing session id is a no-op returning Ok(()) and session_todos returns None
    db.record_session_todos("nonexistent", Some(todos)).unwrap();
    assert_eq!(db.session_todos("nonexistent").unwrap(), None);
}

/// A `cost_update` frame's per-call delta ADDS to the stored figure
/// (issue #105): two frames of `0.0001` accumulate to `0.0002`, and the
/// first frame turns the row's `NULL` ("never reported") into a figure.
///
/// The accumulation happens in Rust (`stored.unwrap_or(0.0) + delta`), not
/// in a SQL `COALESCE`, so the `NULL` handling is visible at the write site.
#[test]
fn a_cost_frame_accumulates_into_the_stored_figure() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // Before any frame: no figure at all (NOT a zero).
    assert_eq!(db.session_cost("s1").unwrap(), None);

    // One frame: `NULL + delta = delta` — the first frame creates the figure.
    db.record_session_cost("s1", 0.0001).unwrap();
    let after_one = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (after_one - 0.0001).abs() < 1e-12,
        "the first frame stores its own delta, got {after_one}"
    );

    // A second frame ADDS to it (the wire carries DELTAS, never totals).
    db.record_session_cost("s1", 0.0001).unwrap();
    let after_two = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (after_two - 0.0002).abs() < 1e-12,
        "two frames accumulate to their sum, got {after_two}"
    );

    // The stored figure is the row's own column — `session()` and
    // `list_sessions()` both project it (the two queries stay in lockstep),
    // which is what lets a CLOSED session keep its figure (issue #105).
    let row = db.session("s1").unwrap().expect("the row is there");
    let stored = row.cost_usd.expect("the row carries the figure");
    assert!(
        (stored - 0.0002).abs() < 1e-12,
        "`session()` reads the accumulated figure, got {stored}"
    );
    let listed = db.list_sessions(true).expect("list_sessions").remove(0);
    let listed = listed.cost_usd.expect("the listed row carries the figure");
    assert!(
        (listed - 0.0002).abs() < 1e-12,
        "`list_sessions()` reads the accumulated figure, got {listed}"
    );
}

/// `NULL` and `Some(0.0)` are DIFFERENT stored values (issue #105, D5,
/// ADR 0082). This is the D5 pin: "no call ever reported a cost" renders
/// NOTHING and "a call reported a real zero" renders `$0.00` — collapsing
/// them is the phantom-`$0.00` defect, so the distinction has to survive
/// the write → read round-trip, not just the wire.
#[test]
fn a_null_cost_and_a_real_zero_are_different() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    // A fresh row: NO figure. Not `Some(0.0)` — `None`.
    assert_eq!(
        db.session_cost("s1").unwrap(),
        None,
        "a session that never reported a cost reads None, not 0.0"
    );
    let row = db.session("s1").unwrap().expect("the row is there");
    assert_eq!(
        row.cost_usd, None,
        "`session()` reports absence, not a fabricated zero"
    );

    // A call that reported a REAL zero turns `NULL` into `Some(0.0)` — a
    // figure, distinguishable from the absence above.
    db.record_session_cost("s1", 0.0).unwrap();
    assert_eq!(
        db.session_cost("s1").unwrap(),
        Some(0.0),
        "a reported zero is a figure and must survive the round-trip as Some(0.0)"
    );
    let row = db.session("s1").unwrap().expect("the row is there");
    assert_eq!(row.cost_usd, Some(0.0), "`session()` agrees");
    let listed = db.list_sessions(true).expect("list_sessions").remove(0);
    assert_eq!(listed.cost_usd, Some(0.0), "`list_sessions()` agrees");
}

/// A REPLAYED `cost_update` frame DOUBLES the stored figure.
///
/// THIS TEST PINS A HAZARD, NOT A FEATURE (plan Trap 2). The increment is
/// deliberately non-idempotent because the wire gives a frame nothing to
/// dedupe on — `emit_cost_update` hardcodes `"seq": 0`, so a re-delivered
/// frame is indistinguishable from a second priced call. Prevention was
/// rejected as out of scope; VISIBILITY is the requirement, so the doubling
/// is asserted rather than hidden.
///
/// **If a future change makes this idempotent, this test must be DELETED,
/// not adjusted.** An adjusted assertion would hide the fact that the
/// hazard was designed away, and the plan's honest-limits section (and
/// `persist.rs`'s module doc, which names `cost_update` as the one
/// non-idempotent arm) would need rewriting in the same change.
#[test]
fn a_replayed_cost_frame_doubles_the_stored_figure() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let info = SessionInfo {
        session_id: "s1".to_string(),
        cwd: std::path::PathBuf::from("/tmp/proj"),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent: false,
    };
    db.record_session(&info).unwrap();

    let frame = 0.0000341;
    db.record_session_cost("s1", frame).unwrap();
    let once = db.session_cost("s1").unwrap().expect("a figure exists");

    // The SAME frame delivered twice: the figure doubles. Loudly.
    db.record_session_cost("s1", frame).unwrap();
    let twice = db.session_cost("s1").unwrap().expect("a figure exists");
    assert!(
        (twice - once * 2.0).abs() < 1e-12,
        "a replayed frame doubles the stored figure (the pinned hazard): \
         once={once}, twice={twice}"
    );
    assert!(
        twice > once,
        "the hazard is a GROWTH, not a no-op — if this ever reads equal, \
         idempotency was added and this test must be deleted, not adjusted"
    );
}

/// `record_session_cost` on a MISSING row is a silent `Ok(())` and writes
/// nothing (issue #105, Trap 1's evidence).
///
/// This mirrors `record_session_todos_roundtrips_and_clears`'s last two
/// lines for the sibling method, and it is NOT an oversight to be "fixed"
/// into an error: it is the proof that the CALLER — `apply_interactive_event`,
/// via `ensure_session_row` — is responsible for the row's existence. A
/// subagent's first `cost_update` can arrive before any `StoreFrame` has
/// created its row, and a bare `UPDATE … WHERE id = ?1` would then discard
/// the money without a sound. This method's silence is why the cost arm has
/// to ensure the row first.
#[test]
fn record_session_cost_on_a_missing_row_is_a_silent_no_op() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-cost-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");

    // No `record_session`, no row. The write succeeds and touches nothing.
    db.record_session_cost("nonexistent", 0.0001)
        .expect("a missing row is a no-op returning Ok(())");
    assert_eq!(
        db.session_cost("nonexistent").unwrap(),
        None,
        "nothing was written for a row that does not exist"
    );
    // And no row was CREATED by the attempt (an upsert here would be the
    // wrong fix — `ensure_session_row` owns row creation).
    assert!(db.list_sessions(true).expect("list_sessions").is_empty());
}

#[test]
fn legacy_db_migration_backfills_newest_non_read_todos_once() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-todos-backfill-", "scratch");
    let path = dir.join("t.db");

    // Pre-migration DB: WITHOUT todos_json
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            message_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, kind, message_key)
        );
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        CREATE TABLE spaces (
            path TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0
        );",
    )
    .unwrap();

    // Main session s1, subagent session s_child, empty session s_empty
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) VALUES ('s1', '/tmp', 1, '{}', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) VALUES ('s_child', '/tmp', 1, '{}', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) VALUES ('s_empty', '/tmp', 1, '{}', 0)",
        [],
    )
    .unwrap();

    // For s1:
    // (1) oldest write with task1
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (1, 's1', 'tool-call', 'tc1', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"task1\",\"status\":\"pending\"}]}}', 1)",
        [],
    )
    .unwrap();
    // (2) newer with operation: 'read'
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (2, 's1', 'tool-call', 'tc2', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"read\",\"todoList\":[]}}', 2)",
        [],
    )
    .unwrap();
    // (3) newest write with task2
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (3, 's1', 'tool-call', 'tc3', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"task2\",\"status\":\"in_progress\",\"description\":\"d2\"}]}}', 3)",
        [],
    )
    .unwrap();
    // (4) malformed payload_json row
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (4, 's1', 'tool-call', 'tc4', 'not valid json at all { manage_todo_list', 4)",
        [],
    )
    .unwrap();

    // For s_child: write row
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at) VALUES (5, 's_child', 'tool-call', 'tc_c', '{\"title\":\"manage_todo_list\",\"rawInput\":{\"operation\":\"write\",\"todoList\":[{\"content\":\"child_task\",\"status\":\"pending\"}]}}', 5)",
        [],
    )
    .unwrap();

    drop(conn);

    // Open via Db::open: Db::open succeeds despite the malformed row
    let db = Db::open(&path).expect("Db::open should succeed");

    // s1 holds task2 (the newest non-read write)
    let s1_todos = db
        .session_todos("s1")
        .expect("session_todos should succeed");
    assert!(s1_todos.is_some(), "s1 should have backfilled todos");
    let val: serde_json::Value = serde_json::from_str(&s1_todos.unwrap()).unwrap();
    assert_eq!(
        val,
        serde_json::json!([{"content":"task2","status":"in_progress","description":"d2"}])
    );

    // s_child's session_todos is None (subagents never backfilled)
    assert_eq!(db.session_todos("s_child").unwrap(), None);

    // s_empty ends with todos_json == None
    assert_eq!(db.session_todos("s_empty").unwrap(), None);

    // Mutate s1's todos_json with a sentinel
    db.record_session_todos("s1", Some("sentinel")).unwrap();
    drop(db);

    // Re-open Db::open(&path): assert the sentinel survived (proves backfill does NOT re-run)
    let db2 = Db::open(&path).expect("re-open should succeed");
    assert_eq!(
        db2.session_todos("s1").unwrap(),
        Some("sentinel".to_string())
    );
}

/// The pre-`sort_order` schema: the current `SCHEMA` with the
/// `sort_order` column absent from BOTH `sessions` and `spaces` — i.e.
/// exactly what a database written before the manual-order columns looks
/// like. `native_messages` keeps its FK so the phase-10 FK migration
/// stays quiet and the fixture exercises only the seed under test.
fn create_pre_sort_order_db(path: &Path) {
    let conn = Connection::open(path).expect("raw open of the fixture db");
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            cwd TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            title TEXT,
            capabilities_json TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            context_usage_json TEXT,
            is_subagent INTEGER NOT NULL DEFAULT 0,
            todos_json TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            message_key TEXT,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, kind, message_key)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
        CREATE TABLE native_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            content_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, seq)
        );
        CREATE TABLE spaces (
            path TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            last_opened_at INTEGER NOT NULL,
            trusted INTEGER NOT NULL DEFAULT 0
        );",
    )
    .expect("fixture schema should build");
    drop(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// The pre-existing-database fixture for the migration-gate cluster.
//
// The five pre-existing-database gate tests each used to open a raw
// `Connection`, hand-write a schema with ONE column missing, seed rows and drop
// the conn —
// five copies of the same skeleton. `preexisting_db` owns that skeleton; the
// `SCHEMA_WITHOUT_*` constants below are its only schema argument.
//
// ISOLATION IS THE LOAD-BEARING PROPERTY OF THESE STRINGS. Each is the full
// 4-table `CREATE` batch with EXACTLY ONE gate's column absent and every OTHER
// gated column present, so `Db::open`'s other gates find their column and stay
// SILENT: the test observes its own gate, not nine gates at once. Two of the
// five fixtures were NOT isolated before this consolidation (the `archived` one
// also omitted `trusted`, both `sort_order`s, `context_usage_json`,
// `is_subagent`, `todos_json` and `cost_usd`, and carried `agent_id` — so it
// also ran the pre-rip-out purge and both seeds; the `context_usage` one was
// similar). Making them isolated is the point of the change; the gate under
// test is unchanged in every case, and each gate keeps its own dedicated test.
//
// That is also why `create_pre_sort_order_db` must NEVER serve these five: its
// schema omits BOTH `sort_order` columns at once, so handing it to (say) the
// `archived` test would run the two sort-order SEEDS inside a test that is about
// `archived` — the isolation collapse the plan forbids. It stays in use for the
// five pre-0075 fixtures that genuinely want both columns absent.
// ─────────────────────────────────────────────────────────────────────────────

/// The `spaces` table as a post-trust, post-sort_order database has it — the
/// half every cluster fixture uses EXCEPT the one whose gate owns this table.
/// (A macro rather than a `const`, because [`legacy_batch!`] concatenates
/// literals.)
macro_rules! legacy_spaces_with_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `spaces` table WITHOUT `sort_order` (`trusted` present, so the trust gate
/// stays quiet) — only the space sort-order gate can fire on it.
macro_rules! legacy_spaces_without_sort_order {
    () => {
        "
CREATE TABLE spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0
);
"
    };
}

/// The `messages` + `native_messages` half of every fixture here — no gate in
/// this cluster touches either table. `native_messages` carries its
/// `ON DELETE CASCADE` FK, so `Db::open`'s FK-rewrite batch stays quiet on every
/// fixture below; a fixture that omitted the FK would be testing that rewrite,
/// not its own gate.
macro_rules! legacy_tail {
    () => {
        "
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message_key TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, kind, message_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE native_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);
"
    };
}

/// Assemble one legacy fixture batch: the `sessions` DDL the caller spells as a
/// literal, the `spaces` spelling the caller picks, and the two tables NO gate in
/// this cluster touches.
///
/// A macro rather than a function or `const` concatenation because `&str`
/// concatenation is not a const operation and `concat!` needs LITERALS — hence
/// the `sessions` DDL arriving as a literal argument, and the two `spaces`
/// spellings plus the tail living here once each so no fixture can invent its own.
macro_rules! legacy_batch {
    ($sessions:expr, spaces_with_sort_order) => {
        concat!($sessions, legacy_spaces_with_sort_order!(), legacy_tail!())
    };
    ($sessions:expr, spaces_without_sort_order) => {
        concat!(
            $sessions,
            legacy_spaces_without_sort_order!(),
            legacy_tail!()
        )
    };
}

/// The full 4-table batch with ONLY `sessions.archived` missing. Every other
/// gated column is present, so the sibling gates are no-ops on this fixture.
/// `agent_id` is absent too: the pre-rip-out purge is a DIFFERENT gate with its
/// own test (`opening_a_pre_rip_out_database_migrates_it`), and a fixture that
/// carried the column would run that purge as a side effect.
const SCHEMA_WITHOUT_ARCHIVED: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 4-table batch with ONLY `sessions.context_usage_json` missing.
const SCHEMA_WITHOUT_CONTEXT_USAGE: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 4-table batch with ONLY `sessions.cost_usd` missing — the isolation
/// the `dflt_value` pin depends on.
const SCHEMA_WITHOUT_COST_USD: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);
",
    spaces_with_sort_order
);

/// The full 4-table batch with ONLY `spaces.sort_order` missing (`sessions` is
/// complete, so the SESSION seed cannot fire — that is the isolation this
/// constant exists to provide).
const SCHEMA_WITHOUT_SPACE_SORT_ORDER: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
",
    spaces_without_sort_order
);

/// The full 4-table batch with ONLY `sessions.sort_order` missing (`spaces` is
/// complete, so the SPACE seed cannot fire).
const SCHEMA_WITHOUT_SESSION_SORT_ORDER: &str = legacy_batch!(
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    capabilities_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    context_usage_json TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    todos_json TEXT,
    cost_usd REAL
);
",
    spaces_with_sort_order
);

/// Isolation is these fixtures' load-bearing property, so it is ASSERTED rather
/// than commented: each `SCHEMA_WITHOUT_*` must omit EXACTLY ONE gated column
/// across both tables, and must carry the other eight. If a fixture silently
/// loses a second column, the sibling gate fires inside that test and the test
/// stops being about its own gate — this fails first, with the fixture named.
#[test]
fn each_cluster_schema_omits_exactly_one_gated_column() {
    // (table, column) for every gate `Db::open` probes, in probe order.
    const GATED: [(&str, &str); 8] = [
        ("spaces", "trusted"),
        ("sessions", "archived"),
        ("sessions", "context_usage_json"),
        ("sessions", "is_subagent"),
        ("sessions", "todos_json"),
        ("sessions", "cost_usd"),
        ("spaces", "sort_order"),
        ("sessions", "sort_order"),
    ];
    let fixtures: [(&str, &str); 5] = [
        ("SCHEMA_WITHOUT_ARCHIVED", SCHEMA_WITHOUT_ARCHIVED),
        ("SCHEMA_WITHOUT_CONTEXT_USAGE", SCHEMA_WITHOUT_CONTEXT_USAGE),
        ("SCHEMA_WITHOUT_COST_USD", SCHEMA_WITHOUT_COST_USD),
        (
            "SCHEMA_WITHOUT_SPACE_SORT_ORDER",
            SCHEMA_WITHOUT_SPACE_SORT_ORDER,
        ),
        (
            "SCHEMA_WITHOUT_SESSION_SORT_ORDER",
            SCHEMA_WITHOUT_SESSION_SORT_ORDER,
        ),
    ];
    for (name, schema) in fixtures {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-cluster-fixture-", "scratch");
        let path = preexisting_db(&dir, schema, "");
        let conn = Connection::open(&path).unwrap();
        let missing: Vec<(&str, &str)> = GATED
            .iter()
            .filter(|(table, column)| {
                let has: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                        rusqlite::params![*table, *column],
                        |row| row.get(0),
                    )
                    .unwrap();
                has == 0
            })
            .copied()
            .collect();
        assert_eq!(
            missing.len(),
            1,
            "`{name}` must omit EXACTLY ONE gated column so its sibling gates \
             stay silent; it omits {missing:?}"
        );
    }
}

/// Create a legacy database file WITHOUT opening `Db` — raw SQLite only.
///
/// `Db::open` is the code under test here (its gates are what these tests
/// observe), so the fixture must be the raw file: this factory never opens a
/// `Db`, and the conn is dropped before returning so `Db::open` gets the file
/// to itself.
///
/// `legacy_schema` is the full 4-table `CREATE` batch with the ONE gated column
/// under test missing and every OTHER gated column present (see the
/// `SCHEMA_WITHOUT_*` constants — get this wrong and a sibling gate runs inside
/// the test); `rows` seeds the pre-existing data.
fn preexisting_db(dir: &Path, legacy_schema: &str, rows: &str) -> std::path::PathBuf {
    let path = dir.join("t.db");
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    conn.execute_batch(&format!(
        "{legacy_schema}{rows}",
        legacy_schema = legacy_schema,
        rows = rows
    ))
    .expect("fixture schema");
    drop(conn);
    path
}

/// Reads a single TEXT column through the raw connection (the row structs
/// never select `sort_order`, so the seed assertions go straight to SQL).
fn raw_column(db: &Db, sql: &str) -> Vec<String> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let rows = guard
        .prepare(sql)
        .expect("prepare should succeed")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query should succeed")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should read");
    rows
}

/// The same for an INTEGER column (the `sort_order` values themselves).
fn raw_i64s(db: &Db, sql: &str) -> Vec<i64> {
    let guard = db.conn.lock().expect("db mutex poisoned");
    let rows = guard
        .prepare(sql)
        .expect("prepare should succeed")
        .query_map([], |row| row.get::<_, i64>(0))
        .expect("query should succeed")
        .collect::<Result<Vec<_>, _>>()
        .expect("rows should read");
    rows
}

/// One row's `sort_order`, keyed by a TEXT primary key (a path or an id).
fn sort_order_of(db: &Db, table: &str, key_column: &str, key: &str) -> i64 {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            &format!(
                "SELECT sort_order FROM {table} WHERE {key_column} = ?1",
                table = table,
                key_column = key_column
            ),
            params![key],
            |row| row.get(0),
        )
        .expect("sort_order should read")
}

/// The one scalar of an INTEGER column (a `COUNT(*)`-shaped assertion).
fn raw_scalar(db: &Db, sql: &str) -> i64 {
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(sql, [], |row| row.get(0))
        .expect("scalar query should succeed")
}

/// A minimal session shape on a caller-supplied cwd (the
/// `record_session_preserves_the_archived_flag` literal, with the cwd
/// and the subagent flag left to the caller).
fn session_on(id: &str, cwd: &Path, is_subagent: bool) -> SessionInfo {
    SessionInfo {
        session_id: id.to_string(),
        cwd: cwd.to_path_buf(),
        capabilities: serde_json::json!({}),
        config_options: None,
        archived: false,
        title: None,
        context_usage: None,
        cost_usd: None,
        is_subagent,
    }
}

/// (sort_order) A FRESH database gains the column from `SCHEMA` alone —
/// no migration runs (the pragma gate in `Db::open` skips it).
#[test]
fn sort_order_columns_exist_on_a_fresh_database() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortfresh-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let conn = db.conn.lock().expect("db mutex poisoned");
    for table in ["spaces", "sessions"] {
        let has: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = 'sort_order'"
                ),
                [],
                |row| row.get(0),
            )
            .expect("pragma query should succeed");
        assert_eq!(
            has, 1,
            "a fresh database has sort_order on {table} straight from SCHEMA"
        );
    }
    drop(conn);
}

/// (sort_order) A pre-existing database is seeded in the order the user
/// was ALREADY looking at for spaces: `last_opened_at DESC, path ASC`.
/// The assertion pins BOTH halves of that read order — `/x/b` leads on
/// recency, and `/x/a` beats `/x/c` on the `path ASC` tie-break at a tied
/// timestamp. No `sessions` rows are inserted, so the phase-11 space
/// backfill cannot add rows and pollute the assertion.
///
/// The fixture is `SCHEMA_WITHOUT_SPACE_SORT_ORDER`: `spaces` lacks
/// `sort_order` (the gate under test) while `sessions` — empty here —
/// already CARRIES its own `sort_order`, so the SESSION seed stays silent and
/// this test observes the space seed alone. (The shared
/// `create_pre_sort_order_db` omits BOTH columns, which would run both seeds
/// here — that is exactly why it does not serve this test.)
#[test]
fn sort_order_seeded_in_the_old_space_order_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortspace-test-", "scratch");
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_SPACE_SORT_ORDER,
        "INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/b', 1, 3000);
         INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/a', 1, 2000);
         INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/c', 1, 2000);",
    );

    let db = Db::open(&path).expect("the sort_order seed must not brick startup");
    // The column is in place (the gate's own ALTER), like every other gate test
    // in this cluster asserts.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('spaces') WHERE name = 'sort_order'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the spaces.sort_order column is in place after the migration"
    );
    let paths: Vec<String> = raw_column(
        &db,
        "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC",
    );
    assert_eq!(
        paths,
        vec!["/x/b", "/x/a", "/x/c"],
        "the seed numbers the spaces in the OLD display order \
         (last_opened_at DESC, then path ASC on a tied timestamp)"
    );
    // The ADR 0075 NUMBERS themselves, not just their order: the seed writes
    // 0-based positions in that read order, so a seed that numbered correctly
    // but started at 1 (or counted in the wrong direction) fails HERE even if a
    // future ORDER BY happened to forgive it.
    assert_eq!(
        (
            sort_order_of(&db, "spaces", "path", "/x/b"),
            sort_order_of(&db, "spaces", "path", "/x/a"),
            sort_order_of(&db, "spaces", "path", "/x/c"),
        ),
        (0, 1, 2),
        "the space seed numbers the rows 0, 1, 2 in the old display order"
    );
    // ...and a SECOND open is a clean no-op: the pragma gate is closed, so the
    // seed does not re-run and cannot renumber the rows.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the seeded db must succeed");
    assert_eq!(
        (
            sort_order_of(&db, "spaces", "path", "/x/b"),
            sort_order_of(&db, "spaces", "path", "/x/a"),
            sort_order_of(&db, "spaces", "path", "/x/c"),
        ),
        (0, 1, 2),
        "the re-open does not re-run the space seed — the numbers are untouched"
    );
    // Isolation, asserted rather than assumed: the numbers came from the SPACE
    // seed alone (the session gate never ran — its column was already there).
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM sessions"),
        0,
        "the fixture stayed spaces-only, so no session seed could have moved \
         anything this test reads"
    );
}

/// (sort_order) A pre-existing database is seeded in the order the user
/// was ALREADY looking at for sessions: last activity (the `COALESCE`
/// expression) then `id DESC`. That order is neither `id DESC` alone nor
/// `created_at DESC` alone, so the assertion pins the whole expression.
///
/// The fixture is `SCHEMA_WITHOUT_SESSION_SORT_ORDER`: `sessions` lacks
/// `sort_order` (the gate under test) while `spaces` — empty here — already
/// CARRIES its own, so the SPACE seed stays silent and this test observes the
/// session seed alone.
#[test]
fn sort_order_seeded_in_the_old_session_order_on_a_preexisting_db() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortsess-test-", "scratch");
    // A cwd that does not exist on disk: the phase-11 space backfill skips
    // it, so the fixture stays about sessions only.
    // The OLDEST-created session (`s_old_used`) is the most recently USED one.
    let path = preexisting_db(
        &dir,
        SCHEMA_WITHOUT_SESSION_SORT_ORDER,
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_old_used', '/x/nope-not-a-folder', 1000, '{}', 0);
         INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_stale', '/x/nope-not-a-folder', 2000, '{}', 0);
         INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_fresh', '/x/nope-not-a-folder', 3000, '{}', 0);
         INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
         VALUES ('s_old_used','user',NULL,'{}',9999);",
    );

    let db = Db::open(&path).expect("the sort_order seed must not brick startup");
    // The column is in place (the gate's own ALTER), like every other gate test
    // in this cluster asserts.
    let has: i64 = db
        .conn
        .lock()
        .expect("db mutex poisoned")
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'sort_order'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        has, 1,
        "the sessions.sort_order column is in place after the migration"
    );
    let ids: Vec<String> = raw_column(
        &db,
        "SELECT id FROM sessions ORDER BY sort_order ASC, id DESC",
    );
    assert_eq!(
        ids,
        vec!["s_old_used", "s_fresh", "s_stale"],
        "the seed numbers the sessions in the OLD display order \
         (last activity DESC, then id DESC)"
    );
    // The ADR 0075 NUMBERS themselves, not just their order (the space twin
    // above pins the same shape): the seed writes 0-based positions.
    assert_eq!(
        (
            sort_order_of(&db, "sessions", "id", "s_old_used"),
            sort_order_of(&db, "sessions", "id", "s_fresh"),
            sort_order_of(&db, "sessions", "id", "s_stale"),
        ),
        (0, 1, 2),
        "the session seed numbers the rows 0, 1, 2 in the old display order"
    );
    // ...and a SECOND open is a clean no-op: the pragma gate is closed, so the
    // seed does not re-run and cannot renumber the rows.
    drop(db);
    let db = Db::open(&path).expect("a re-open of the seeded db must succeed");
    assert_eq!(
        (
            sort_order_of(&db, "sessions", "id", "s_old_used"),
            sort_order_of(&db, "sessions", "id", "s_fresh"),
            sort_order_of(&db, "sessions", "id", "s_stale"),
        ),
        (0, 1, 2),
        "the re-open does not re-run the session seed — the numbers are untouched"
    );
    // Isolation, asserted rather than assumed: the fixture seeded no space
    // rows and every cwd is uncanonicalizable, so the space seed had nothing to
    // number and the backfill had nothing to insert.
    assert_eq!(
        raw_scalar(&db, "SELECT COUNT(*) FROM spaces"),
        0,
        "no space row exists, so the space seed could not have influenced \
         anything this test reads"
    );
}

/// (sort_order) The seed is GATED, not merely idempotent: after the first
/// open the pragma gate is closed, so a re-open never rewrites the
/// numbers. The sentinel idiom from
/// `legacy_db_migration_backfills_newest_non_read_todos_once`.
#[test]
fn sort_order_seed_does_not_rerun_on_reopen() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortonce-test-", "scratch");
    let path = dir.join("t.db");
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    conn.execute(
        "INSERT INTO spaces (path, created_at, last_opened_at) VALUES ('/x/a', 1, 1000)",
        [],
    )
    .expect("fixture space row");
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
         VALUES ('s_a', '/x/nope-not-a-folder', 1, '{}', 0)",
        [],
    )
    .expect("fixture session row");
    drop(conn);

    let db = Db::open(&path).expect("first open should seed the column");
    {
        let conn = db.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "UPDATE spaces SET sort_order = 4242 WHERE path = ?1",
            params!["/x/a"],
        )
        .expect("sentinel space write");
        conn.execute(
            "UPDATE sessions SET sort_order = 77 WHERE id = ?1",
            params!["s_a"],
        )
        .expect("sentinel session write");
    }
    drop(db);

    let db = Db::open(&path).expect("re-open of the migrated db must succeed");
    let conn = db.conn.lock().expect("db mutex poisoned");
    let space_value: i64 = conn
        .query_row(
            "SELECT sort_order FROM spaces WHERE path = ?1",
            params!["/x/a"],
            |row| row.get(0),
        )
        .expect("read the space sentinel");
    let session_value: i64 = conn
        .query_row(
            "SELECT sort_order FROM sessions WHERE id = ?1",
            params!["s_a"],
            |row| row.get(0),
        )
        .expect("read the session sentinel");
    assert_eq!(
        space_value, 4242,
        "the seed gate is closed on the second open, so the space sentinel survives"
    );
    assert_eq!(
        session_value, 77,
        "the seed gate is closed on the second open, so the session sentinel survives"
    );
}

/// (hazard H1) The seed renumbers EVERY session row, hidden subagent rows
/// included — no `WHERE`. `MAX + 1` is global and `ensure_session_row`
/// routes subagent rows through `record_session`, so a hidden row already
/// consumes a number: seeding only the visible rows would duplicate
/// values and tie them with the visible row at 0.
#[test]
fn sort_order_seed_numbers_subagent_rows_too() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sortsub-test-", "scratch");
    let path = dir.join("t.db");
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    for (id, is_subagent) in [("s_main_1", 0_i64), ("s_main_2", 0), ("s_sub", 1)] {
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, '/x/nope-not-a-folder', 1, '{}', ?2)",
            params![id, is_subagent],
        )
        .expect("fixture session row");
    }
    drop(conn);

    let db = Db::open(&path).expect("the seed must number hidden rows too");
    let conn = db.conn.lock().expect("db mutex poisoned");
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .expect("count sessions");
    let distinct: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT sort_order) FROM sessions",
            [],
            |row| row.get(0),
        )
        .expect("count distinct sort_order");
    let at_zero: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE sort_order = 0",
            [],
            |row| row.get(0),
        )
        .expect("count rows at sort_order 0");
    assert_eq!(total, 3, "three fixture rows are stored");
    assert_eq!(
        distinct, 3,
        "every row (the hidden subagent row included) got its own number"
    );
    assert_eq!(
        at_zero, 1,
        "exactly one row sits at 0 — no tie with the hidden row"
    );
}

/// A NEW space row joins the list at the BOTTOM (`MAX + 1`), not at the
/// top and not by name. Asserted through raw SQL because `list_spaces`
/// still sorts by recency until the `ORDER BY` swap.
///
/// The dir names are chosen so that INSERTION order is NOT `path ASC`
/// order — otherwise the `path ASC` tie-break would satisfy the assertion
/// on its own and the test would pass vacuously.
#[test]
fn upsert_space_new_row_joins_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacebottom-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = dir.join("zzz-first-inserted");
    let b = dir.join("mmm-second-inserted");
    let c = dir.join("aaa-third-inserted");
    for d in [&a, &b, &c] {
        std::fs::create_dir_all(d).unwrap();
    }
    db.upsert_space(a.to_str().unwrap(), false)
        .expect("upsert a");
    db.upsert_space(b.to_str().unwrap(), false)
        .expect("upsert b");
    db.upsert_space(c.to_str().unwrap(), false)
        .expect("upsert c");

    let keys: Vec<String> = [a, b, c]
        .iter()
        .map(|d| std::fs::canonicalize(d).unwrap().display().to_string())
        .collect();
    let order = raw_column(
        &db,
        "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC",
    );
    assert_eq!(
        order, keys,
        "rows come back in INSERTION order, i.e. each new row joined at the bottom"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT sort_order FROM spaces ORDER BY sort_order ASC"),
        vec![0, 1, 2],
        "the numbers grow from the bottom, one per row"
    );
}

/// A RE-TOUCH never renumbers: the `ON CONFLICT … DO UPDATE` branch
/// refreshes `last_opened_at` and must not touch `sort_order`. This is the
/// feature (a click must not move the tab) and simultaneously the resume
/// hazard (a re-touch used to be what moved a row to the top).
///
/// The dir names make INSERTION order contradict `path ASC`, so the
/// assertion cannot be satisfied by the tie-break on rows that all still
/// carry `DEFAULT 0`.
#[test]
fn upsert_space_retouch_does_not_renumber() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spaceretouch-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let a = dir.join("zzz-first-and-retouched");
    let b = dir.join("aaa-second");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let key_a = std::fs::canonicalize(&a).unwrap().display().to_string();
    let key_b = std::fs::canonicalize(&b).unwrap().display().to_string();

    db.upsert_space(a.to_str().unwrap(), false)
        .expect("upsert a");
    db.upsert_space(b.to_str().unwrap(), false)
        .expect("upsert b");
    db.upsert_space(a.to_str().unwrap(), false)
        .expect("re-touch a");

    assert_eq!(
        sort_order_of(&db, "spaces", "path", &key_a),
        0,
        "a re-touched row keeps the number it joined at"
    );
    assert_eq!(
        raw_column(
            &db,
            "SELECT path FROM spaces ORDER BY sort_order ASC, path ASC"
        ),
        vec![key_a, key_b],
        "the re-touched row did not move"
    );
}

/// A NEW session row joins at the BOTTOM too. The ids are chosen so `id
/// DESC` (the old tie-break) contradicts insertion order, so the assertion
/// cannot be satisfied by the tie-break alone.
#[test]
fn record_session_new_row_joins_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sessbottom-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    db.record_session(&session_on("s_first", Path::new("/tmp/proj"), false))
        .expect("record s_first");
    db.record_session(&session_on("s_second", Path::new("/tmp/proj"), false))
        .expect("record s_second");

    assert_eq!(
        raw_column(
            &db,
            "SELECT id FROM sessions ORDER BY sort_order ASC, id DESC"
        ),
        vec!["s_first", "s_second"],
        "rows come back in RECORD order, i.e. each new row joined at the bottom"
    );
    assert_eq!(
        raw_i64s(
            &db,
            "SELECT sort_order FROM sessions ORDER BY sort_order ASC"
        ),
        vec![0, 1],
        "the numbers grow from the bottom, one per row"
    );
}

/// A RE-RECORD never renumbers: a resume re-runs `record_session`, and the
/// `ON CONFLICT … DO UPDATE` branch must leave the row's position alone.
///
/// A second row is recorded alongside the re-recorded one on purpose: with
/// only one row in the table every number is `0` and "unchanged" is
/// trivially true, so the neighbouring row is what makes the assertion
/// observable (its id is below the re-recorded one so the `id DESC`
/// tie-break cannot hide a shared number).
#[test]
fn record_session_re_record_does_not_renumber() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-sessretouch-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let resumed = session_on("s_resumed", Path::new("/tmp/proj"), false);
    db.record_session(&resumed)
        .expect("record s_resumed (it joins at 0)");
    db.record_session(&session_on("s_other", Path::new("/tmp/proj"), false))
        .expect("record s_other (it joins below at 1)");
    db.record_session(&resumed)
        .expect("re-record s_resumed (the resume path re-runs record_session)");

    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_resumed"),
        0,
        "the re-recorded row keeps the number it joined at"
    );
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_other"),
        1,
        "and the row below it is not dragged up or pushed down by the re-record"
    );
}

/// (hazard H4) The phase-11 space-backfill INSERT carries the same
/// bottom-join expression. On this upgrade path — stored sessions, an
/// EMPTY `spaces` table — the seed numbers nothing, so an unpatched
/// `DEFAULT 0` would tie every backfilled row and hand the user an
/// alphabetical list on the very boot the spec promises is unchanged.
///
/// Asserted ORDER-AGNOSTICALLY on purpose: the backfill reads
/// `SELECT DISTINCT cwd FROM sessions`, which has no defined order, so the
/// test pins distinctness only and never encodes that nondeterminism.
#[test]
fn backfilled_space_rows_join_at_the_bottom() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-spacebackfill-test-", "scratch");
    let path = dir.join("t.db");
    let cwd_a = dir.join("cwd_a");
    let cwd_b = dir.join("cwd_b");
    // The cwds MUST exist for the backfill's canonicalization.
    std::fs::create_dir_all(&cwd_a).unwrap();
    std::fs::create_dir_all(&cwd_b).unwrap();
    create_pre_sort_order_db(&path);
    let conn = Connection::open(&path).expect("raw open of the fixture db");
    for (id, cwd) in [("s_a", &cwd_a), ("s_b", &cwd_b)] {
        conn.execute(
            "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
             VALUES (?1, ?2, 1, '{}', 0)",
            params![id, cwd.display().to_string()],
        )
        .expect("fixture session row");
    }
    drop(conn);

    let db = Db::open(&path).expect("the backfill must number its rows");
    let total = raw_scalar(&db, "SELECT COUNT(*) FROM spaces");
    let distinct = raw_scalar(&db, "SELECT COUNT(DISTINCT sort_order) FROM spaces");
    let at_zero = raw_scalar(&db, "SELECT COUNT(*) FROM spaces WHERE sort_order = 0");
    assert_eq!(total, 2, "the backfill created one row per existing cwd");
    assert_eq!(
        distinct, 2,
        "the backfilled rows carry DISTINCT numbers — the seed numbered nothing here, \
         so an unpatched INSERT leaves every row on DEFAULT 0"
    );
    assert_eq!(
        at_zero, 1,
        "exactly one row sits at 0 — not every backfilled row tied there"
    );
}
/// `reorder_spaces` writes the given slice as `sort_order`, in one call:
/// the slice INDEX becomes the value, so the list comes back exactly as
/// handed and the numbers are the dense `0..n` the caller implied.
#[test]
fn reorder_spaces_writes_the_given_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reordersp-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let keys = ["aaa", "mmm", "zzz"].map(|n| {
        let d = dir.join(n);
        std::fs::create_dir_all(&d).unwrap();
        d
    });
    for d in &keys {
        db.upsert_space(d.to_str().unwrap(), false)
            .expect("upsert_space should succeed");
    }
    // The canonical keys — exactly the strings `list_spaces()` returns, which
    // is where the frontend's ids come from.
    let paths: Vec<String> = keys
        .iter()
        .map(|d| std::fs::canonicalize(d).unwrap().display().to_string())
        .collect();
    let (a, b, c) = (paths[0].clone(), paths[1].clone(), paths[2].clone());
    // The dragged order the plan names: `[c, a, b]`.
    let wanted = vec![c.clone(), a.clone(), b.clone()];

    db.reorder_spaces(&wanted)
        .expect("reorder_spaces should succeed");

    let listed: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        listed, wanted,
        "the list comes back in the order the caller passed"
    );
    assert_eq!(
        raw_i64s(&db, "SELECT sort_order FROM spaces ORDER BY sort_order ASC"),
        vec![0, 1, 2],
        "the slice index became the value, densely from 0"
    );
    assert_eq!(sort_order_of(&db, "spaces", "path", &c), 0);
    assert_eq!(sort_order_of(&db, "spaces", "path", &a), 1);
    assert_eq!(sort_order_of(&db, "spaces", "path", &b), 2);
}

/// A reorder is PERSISTED work, not a view: it survives a close + re-open,
/// i.e. the one-time seed gate stays closed and does not clobber the order.
#[test]
fn reorder_spaces_survives_a_reopen() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reopentest-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let keys: Vec<String> = ["aaa", "mmm", "zzz"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    for k in &keys {
        db.upsert_space(k, false)
            .expect("upsert_space should succeed");
    }
    let wanted = vec![keys[2].clone(), keys[0].clone(), keys[1].clone()];
    db.reorder_spaces(&wanted)
        .expect("reorder_spaces should succeed");
    drop(db);

    let db = Db::open(&path).expect("re-open must succeed");
    let listed: Vec<String> = db
        .list_spaces()
        .expect("list_spaces should succeed")
        .into_iter()
        .map(|s| s.path)
        .collect();
    assert_eq!(
        listed, wanted,
        "the reorder survives the re-open — the seed gate did not fire and did not renumber"
    );
}

/// An id the caller never heard of is a NO-OP, not an error, and it still
/// occupies its slot: the slice index is the value, so the two known rows
/// land at 1 and 2. This pins the documented semantics rather than leaving
/// them undefined.
#[test]
fn reorder_spaces_with_an_unknown_path_is_not_an_error() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reordernope-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    let keys: Vec<String> = ["aaa", "mmm"]
        .iter()
        .map(|n| {
            let d = dir.join(n);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::canonicalize(d).unwrap().display().to_string()
        })
        .collect();
    for k in &keys {
        db.upsert_space(k, false)
            .expect("upsert_space should succeed");
    }

    let unknown = format!("/nope-{}", uuid::Uuid::new_v4());
    let slice = vec![unknown, keys[0].clone(), keys[1].clone()];
    assert!(
        db.reorder_spaces(&slice).is_ok(),
        "an id matching no row updates nothing and is not an error"
    );
    assert_eq!(
        sort_order_of(&db, "spaces", "path", &keys[0]),
        1,
        "the unknown id occupied slot 0, so the first known row is at 1"
    );
    assert_eq!(
        sort_order_of(&db, "spaces", "path", &keys[1]),
        2,
        "and the second known row at 2"
    );
}

/// `reorder_sessions` writes the visible slice's order AND renumbers hidden
/// subagent rows too (hazard H1's consequence: the bottom-join `MAX + 1` is
/// global, so a hidden row occupies a number and the caller may legitimately
/// hand one back). `list_sessions` filters `is_subagent = 0`, so the hidden
/// row never appears in ANY `list_*` result and the ONLY witness that its
/// number moved is raw SQL against the connection.
#[test]
fn reorder_sessions_writes_the_given_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reorderses-test-", "scratch");
    let path = dir.join("t.db");
    let db = Db::open(&path).expect("db should open");
    let cwd = Path::new("/tmp/proj");
    for id in ["s_0", "s_1", "s_2"] {
        db.record_session(&session_on(id, cwd, false))
            .expect("record_session should succeed");
    }
    db.record_session(&session_on("s_hidden", cwd, true))
        .expect("record the subagent row");
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_hidden"),
        3,
        "the hidden row consumed the next global number"
    );

    // The hidden row goes to the FRONT, so its number provably moves 3 → 0;
    // the visible three keep the relative order the plan names.
    let slice: Vec<String> = ["s_hidden", "s_2", "s_0", "s_1"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    db.reorder_sessions(&slice)
        .expect("reorder_sessions should succeed");

    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_2", "s_0", "s_1"],
        "the visible rows come back in the order the caller passed"
    );
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_hidden"),
        0,
        "the hidden subagent row was renumbered by id like any other"
    );
    drop(db);

    let db = Db::open(&path).expect("re-open must succeed");
    let ids: Vec<String> = db
        .list_sessions(false)
        .expect("list_sessions should succeed")
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(
        ids,
        vec!["s_2", "s_0", "s_1"],
        "the reorder survives the re-open"
    );
    assert_eq!(
        sort_order_of(&db, "sessions", "id", "s_hidden"),
        0,
        "and the hidden row's new number survives it too"
    );
}

/// A reorder renumbers ONLY the slice it was handed. The sidebar passes the
/// visible sessions of ONE Space, so another Space's rows keep their old
/// numbers and therefore COLLIDE with the freshly written ones — the expected
/// steady state of a global numbering with per-Space drags, not corruption
/// this call should have repaired.
///
/// The fixture records a1, b1, b2, a2 so Space A's two rows STRADDLE B's;
/// record them a1, a2, b1, b2 and no collision is possible at all.
#[test]
fn reorder_sessions_is_per_space_even_when_numbers_collide_across_spaces() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-reorderps-test-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("db should open");
    // Canonical cwds, so the `cwd` string the rows store is the string we filter on.
    let dir_a = dir.join("space_a");
    let dir_b = dir.join("space_b");
    std::fs::create_dir_all(&dir_a).unwrap();
    std::fs::create_dir_all(&dir_b).unwrap();
    let a = std::fs::canonicalize(&dir_a).unwrap();
    let b = std::fs::canonicalize(&dir_b).unwrap();
    for id in ["a1", "b1", "b2", "a2"] {
        let cwd = if id.starts_with('a') { &a } else { &b };
        db.record_session(&session_on(id, cwd, false))
            .expect("record_session should succeed");
    }

    // Drag Space A's two visible rows only — B's rows are never passed.
    let slice: Vec<String> = ["a2", "a1"].iter().map(|s| s.to_string()).collect();
    db.reorder_sessions(&slice)
        .expect("reorder_sessions should succeed");

    let listed = db
        .list_sessions(false)
        .expect("list_sessions should succeed");
    let of = |root: &Path| -> Vec<String> {
        listed
            .iter()
            .filter(|r| r.cwd == root.display().to_string())
            .map(|r| r.id.clone())
            .collect()
    };
    assert_eq!(
        of(&a),
        vec!["a2", "a1"],
        "the dragged Space reads in the dragged order"
    );
    assert_eq!(
        of(&b),
        vec!["b1", "b2"],
        "the untouched Space keeps its own order, whatever the numbers now say"
    );
    let total = raw_scalar(&db, "SELECT COUNT(*) FROM sessions");
    let distinct = raw_scalar(&db, "SELECT COUNT(DISTINCT sort_order) FROM sessions");
    assert_eq!(
        (total, distinct),
        (4, 3),
        "`a1` now sits exactly where `b1` already was — a duplicate number \
         across Spaces is expected, and `ORDER BY sort_order ASC, id DESC` is \
         still total so every read stays deterministic"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The mapper drift guards (finding 12's PRIMARY guard).
//
// The hazard these exist for: a `SessionRow`/`MessageRow`/`SpaceRow` used to be
// built beside its own literal `SELECT` list, so a column added to (or moved
// in) the list without the positional ladder COMPILES and mis-maps at runtime.
// The const list + one mapper per type made the pair visible in one place;
// THESE tests are what make the pair checked.
//
// `column_count() == *_ROW_FIELDS` is asserted FIRST, before any value, so an
// APPENDED column reddens the very first assertion with a message that names
// the real problem (SELECT-vs-mapper arity) instead of failing later behind a
// chain of value mismatches. A reorder, a mid-insert or a removal breaks at
// least one of the value asserts that follow — every stored value is
// column-distinct for exactly that reason.
//
// HONEST SCOPE (see the plan's drift-proof): this test is the guard. The
// compile-time arity tie catches only a half-renumbered pair of literals, and
// the typed `get::<_, i64>` calls only turn a DDL TYPE change into a loud
// runtime conversion error. Neither sees the SELECT statement.
//
// These tests pass on their first run — no drift exists today (all three lists
// were verified byte-identical to their ladders before this change). They are
// standing guards: they go red the moment a drift is introduced.
// ─────────────────────────────────────────────────────────────────────────────

/// The PRIMARY guard for `SessionRow`: the SELECT the const builds and the
/// ladder in `session_row_from` agree in LENGTH (asserted first) and in ORDER
/// (asserted by the column-distinct values).
#[test]
fn session_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-session-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    // ONE self-identifying row: every stored value is its own column's name or
    // a distinct number. `archived` and `is_subagent` are deliberately
    // DIFFERENT (1 and 0) — two booleans both set to 1 could be swapped
    // without any value assert noticing, which would defeat the guard.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO sessions (id, cwd, created_at, title, capabilities_json,
                                   archived, context_usage_json, is_subagent, cost_usd)
             VALUES ('id', 'cwd', 2, 'title', 'cap', 1, 'ctx', 0, 9.5)",
            [],
        )
        .unwrap();
    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM sessions WHERE id = ?1",
            SESSION_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position): an appended
    // column is reported here rather than behind a chain of value mismatches.
    // HONEST LIMIT, verified by experiment: this assert alone CANNOT be the
    // guard. The statement is prepared from SESSION_COLUMNS itself, and the
    // arity tie below already forces SESSION_COLUMNS.len() ==
    // SESSION_ROW_FIELDS, so this comparison holds whenever the crate compiles.
    // The INDEPENDENT witness is the golden name list immediately after it.
    assert_eq!(
        stmt.column_count(),
        SESSION_ROW_FIELDS,
        "the SELECT built from SESSION_COLUMNS must have exactly SESSION_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         session_row_from is the drift this guard exists to catch"
    );
    // THE ACTUAL GUARD: the column list spelled a SECOND time, as a literal in
    // THIS test, derived from nothing in prod. Appending a column to
    // SESSION_COLUMNS (even together with a matching SESSION_ROW_FIELDS bump,
    // which is the one edit the arity tie cannot see) reddens THIS assert,
    // because nothing forces this literal to follow the prod const. Order is
    // pinned too, so a reorder fails here as well as in the value asserts.
    const EXPECTED_SESSION_COLUMNS: [&str; 9] = [
        "id",
        "cwd",
        "created_at",
        "title",
        "capabilities_json",
        "archived",
        "context_usage_json",
        "is_subagent",
        "cost_usd",
    ];
    assert_eq!(
        SESSION_COLUMNS.as_slice(),
        EXPECTED_SESSION_COLUMNS.as_slice(),
        "SESSION_COLUMNS drifted from the column list session_row_from maps: the \
         mapper reads these 9 columns in THIS order (field names in the same \
         order), so a column added to or moved in the const must be matched here \
         AND by a field in session_row_from"
    );
    // Map through the PRODUCTION mapper, on the production statement (the same
    // pairing a real read uses — `Db::session` calls `session_row_from` on this
    // exact SQL shape).
    let got = stmt
        .query_row(params!["id"], session_row_from)
        .expect("the self-identifying row maps");
    // The value asserts (in list order): a reorder / mid-insert / removal
    // breaks one of these.
    assert_eq!(got.id, "id");
    assert_eq!(got.cwd, "cwd");
    assert_eq!(got.created_at, 2);
    assert_eq!(got.title.as_deref(), Some("title"));
    assert_eq!(got.capabilities_json, "cap");
    assert!(got.archived, "column 5 (`archived`) maps to `archived`");
    assert_eq!(got.context_usage_json.as_deref(), Some("ctx"));
    assert!(
        !got.is_subagent,
        "column 7 (`is_subagent`) maps to `is_subagent` — it holds 0 while \
         `archived` holds 1, so a 5↔7 swap cannot pass both boolean asserts"
    );
    assert_eq!(got.cost_usd, Some(9.5));
}

/// The PRIMARY guard for `MessageRow` (6 columns) — same shape, same first
/// assert.
#[test]
fn message_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-message-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    let conn = db.conn.lock().expect("db mutex poisoned");
    // The FK to `sessions` is live (the pragma `Db::open` sets), so the
    // transcript row needs its parent. The parent carries nothing the guard
    // reads — every asserted value lives on the message row.
    conn.execute(
        "INSERT INTO sessions (id, cwd, created_at, capabilities_json) \
         VALUES ('s1', '/tmp', 1, '{}')",
        [],
    )
    .unwrap();
    // One self-identifying message row: distinct value per column.
    conn.execute(
        "INSERT INTO messages (id, session_id, kind, message_key, payload_json, created_at)
         VALUES (11, 's1', 'kind', 'key', 'payload', 12)",
        [],
    )
    .unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM messages WHERE id = ?1",
            MESSAGE_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position) — same honest
    // limit as the SessionRow guard: prepared from MESSAGE_COLUMNS and tied to
    // MESSAGE_ROW_FIELDS at compile time, this holds whenever the crate
    // compiles. The golden name list after it is the independent witness.
    assert_eq!(
        stmt.column_count(),
        MESSAGE_ROW_FIELDS,
        "the SELECT built from MESSAGE_COLUMNS must have exactly MESSAGE_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         message_row_from is the drift this guard exists to catch"
    );
    // THE ACTUAL GUARD: the list spelled a SECOND time, as a literal in THIS
    // test, derived from nothing in prod — so a coordinated append to
    // MESSAGE_COLUMNS + MESSAGE_ROW_FIELDS (the edit the arity tie cannot see)
    // reddens THIS assert. Order is pinned here as well as by the values below.
    const EXPECTED_MESSAGE_COLUMNS: [&str; 6] = [
        "id",
        "session_id",
        "kind",
        "message_key",
        "payload_json",
        "created_at",
    ];
    assert_eq!(
        MESSAGE_COLUMNS.as_slice(),
        EXPECTED_MESSAGE_COLUMNS.as_slice(),
        "MESSAGE_COLUMNS drifted from the column list message_row_from maps: the \
         mapper reads these 6 columns in THIS order (field names in the same \
         order), so a column added to or moved in the const must be matched here \
         AND by a field in message_row_from"
    );
    let got = stmt
        .query_row(params![11i64], message_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.id, 11);
    assert_eq!(got.session_id, "s1");
    assert_eq!(got.kind, "kind");
    assert_eq!(got.message_key.as_deref(), Some("key"));
    assert_eq!(got.payload_json, "payload");
    assert_eq!(got.created_at, 12);
}

/// The PRIMARY guard for `SpaceRow` (4 columns) — same shape, same first
/// assert. `trusted` is the INTEGER-as-bool column, so this also pins that the
/// mapper reads it as `i64 != 0` (the same shape `session_row_from` uses for
/// its two booleans).
#[test]
fn space_row_from_maps_the_select_const_columns_in_order() {
    let dir = crate::test_support::ScratchDir::in_env_temp("db-space-mapper-", "scratch");
    let db = Db::open(&dir.join("t.db")).expect("fresh database");
    // No `sessions` row here on purpose: `Db::open`'s phase-11 backfill turns
    // every session cwd into a space row, and this guard wants exactly ONE
    // space — the one it inserted.
    db.conn
        .lock()
        .expect("db mutex poisoned")
        .execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted) \
             VALUES ('path', 3, 4, 1)",
            [],
        )
        .unwrap();
    let conn = db.conn.lock().expect("db mutex poisoned");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM spaces WHERE path = ?1",
            SPACE_COLUMNS.join(", ")
        ))
        .unwrap();
    // STRUCTURAL assert FIRST (the plan's mandated position) — same honest
    // limit as the other two guards; the golden name list after it is the
    // independent witness.
    assert_eq!(
        stmt.column_count(),
        SPACE_ROW_FIELDS,
        "the SELECT built from SPACE_COLUMNS must have exactly SPACE_ROW_FIELDS \
         columns — a column added to the const list without a matching field in \
         space_row_from is the drift this guard exists to catch. `sort_order` is \
         deliberately NOT one of them: SpaceRow has 4 fields by decision (see \
         SPACE_COLUMNS), so a fifth column here must fail THIS assert, not the \
         struct"
    );
    // THE ACTUAL GUARD: the list spelled a SECOND time, as a literal in THIS
    // test, derived from nothing in prod. This is also the assert that catches
    // `sort_order` being added to SPACE_COLUMNS — the decision SPACE_COLUMNS'
    // doc records would otherwise be editable in silence.
    const EXPECTED_SPACE_COLUMNS: [&str; 4] = ["path", "created_at", "last_opened_at", "trusted"];
    assert_eq!(
        SPACE_COLUMNS.as_slice(),
        EXPECTED_SPACE_COLUMNS.as_slice(),
        "SPACE_COLUMNS drifted from the column list space_row_from maps: the mapper \
         reads these 4 columns in THIS order, and `sort_order` stays OUT of the \
         projection by decision (adding it would change the Vec<SpaceRow> wire \
         type commands/spaces.rs returns)"
    );
    let got = stmt
        .query_row(params!["path"], space_row_from)
        .expect("the self-identifying row maps");
    assert_eq!(got.path, "path");
    assert_eq!(got.created_at, 3);
    assert_eq!(got.last_opened_at, 4);
    assert!(
        got.trusted,
        "column 3 (`trusted`) maps to `trusted` via i64 != 0"
    );
}
