//! SQLite persistence for session history and message transcripts.
//!
//! The database lives at `app.path().app_data_dir()/archimedes.db`. The
//! client owns history: every session is recorded when it is established
//! (or resumed), and every message is upserted as it streams in, so a
//! restart restores the full conversation with no duplicate rows.
//!
//! Upsert semantics: `messages` is keyed by `(session_id, kind,
//! message_key)`. Agent text is stored once per message (one row per
//! `messageId`, holding the accumulated text — not one row per chunk);
//! tool calls are stored once per tool call id (the latest merged state).

use std::path::Path;
use std::sync::Mutex as StdMutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::types::SessionInfo;

/// Errors surfaced by the persistence layer.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// A row from the `sessions` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// The ACP session id (primary key).
    pub id: String,
    pub cwd: String,
    /// Unix milliseconds.
    pub created_at: i64,
    pub title: Option<String>,
    /// The negotiated `agent_capabilities`, serialized (camelCase).
    pub capabilities_json: String,
    /// The desktop's archived flag (ADR 0016): `true` hides the session from
    /// its Space group into the Archived section; the transcript is kept.
    pub archived: bool,
    /// The session's last known context usage (`{"used": n, "window": n}` —
    /// the `context_usage_update` frame's values: the provider's
    /// `input_tokens` vs the model's window), persisted on every frame so a
    /// CLOSED session's context survives (the frontend's store drops it on
    /// close — the row is the source of truth for the stored session's bar).
    /// `None` until the first frame (a fresh session with no usage yet).
    pub context_usage_json: Option<String>,
    /// The ephemeral-subagent flag (ADR 0025 §3): `true` for a subagent
    /// session (hidden from `list_sessions` — `is_subagent = 0` filter).
    /// `false` for a main session.
    pub is_subagent: bool,
}

/// A row from the `messages` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: i64,
    pub session_id: String,
    /// `'user' | 'agent-text' | 'agent-thought' | 'tool-call' | 'diff'`.
    pub kind: String,
    /// `ContentChunk.messageId` for agent-text; the tool call id for
    /// tool-call rows; `NULL` otherwise.
    pub message_key: Option<String>,
    /// The message body, serialized (camelCase).
    pub payload_json: String,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// A row from the `spaces` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRow {
    pub path: String,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub last_opened_at: i64,
    /// Trusted Space flag (untrusted by default; fail-closed reads).
    pub trusted: bool,
}

/// The app's SQLite database.
///
/// The connection is wrapped in a `std::sync::Mutex` (a raw
/// `rusqlite::Connection` is `!Sync`), and the `Db` itself is shared via
/// `Arc` between Tauri commands and driver tasks.
pub struct Db {
    conn: StdMutex<Connection>,
}

impl Db {
    /// Open (creating if needed) the database at `path`, migrating the
    /// schema. Parent directories are created as needed.
    pub fn open(path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // Enforce the ON DELETE CASCADE on messages.
        conn.pragma_update(None, "foreign_keys", true)?;
        // One-way migration for pre-rip-out databases (the desktop is
        // native-only now): drop the `sessions.agent_id` column. The
        // `messages` table STAYS (the native display transcript) — but ALL
        // external `sessions` rows (`agent_id <> 'archimedes'`: the built-in
        // `pi` + any user-configured external entries) are deleted first;
        // their `messages` rows cascade via the FK (the `foreign_keys`
        // pragma above is live). Gated on a `PRAGMA table_info` probe — a
        // fresh or already-migrated database skips it, so the migration is
        // idempotent by construction. ONE transaction (SQLite DDL is
        // transactional — a crash mid-batch cannot leave a half-migrated
        // schema behind; the `DELETE` + `ALTER` are atomic together).
        let has_agent_id: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'agent_id'",
            [],
            |row| row.get(0),
        )?;
        if has_agent_id > 0 {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "DELETE FROM sessions WHERE agent_id <> 'archimedes';
                ALTER TABLE sessions DROP COLUMN agent_id;",
            )?;
            tx.commit()?;
        }
        // (finding 5) A legacy crash state: a crash under the pre-fix
        // autocommit code between `DROP TABLE native_messages` and the
        // `RENAME` leaves `native_messages` GONE with the rows living in
        // `native_messages_migrated`. Recover it BEFORE the SCHEMA (which
        // would otherwise `CREATE TABLE IF NOT EXISTS native_messages` — an
        // empty table — and the FK migration's batch would `DROP TABLE IF
        // EXISTS native_messages_migrated`, losing the rows). The migrated
        // table was created WITH the FK, so the rename alone restores the FK
        // (the FK migration below is then a no-op). Pre-fix the re-run hit
        // `INSERT … SELECT … FROM native_messages` → "no such table" →
        // rollback → `Db::open` errored forever, bricking startup.
        let native_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
             AND name = 'native_messages'",
            [],
            |row| row.get(0),
        )?;
        let migrated_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
             AND name = 'native_messages_migrated'",
            [],
            |row| row.get(0),
        )?;
        if native_exists == 0 && migrated_exists > 0 {
            conn.execute(
                "ALTER TABLE native_messages_migrated RENAME TO native_messages",
                [],
            )?;
        }
        conn.execute_batch(SCHEMA)?;
        // One-time migration for pre-existing databases: add `trusted`
        // (fresh databases already have it from SCHEMA). Gated on a schema
        // pre-check — the ALTER runs only when the column is absent, so a
        // re-open never issues it and no error string is matched (the
        // backfill below, by contrast, is idempotent via DO NOTHING).
        let has_trusted: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('spaces') WHERE name = 'trusted'",
            [],
            |row| row.get(0),
        )?;
        if has_trusted == 0 {
            conn.execute(
                "ALTER TABLE spaces ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // One-time migration for pre-existing databases: add `archived` to
        // `sessions` (fresh databases already have it from SCHEMA). The same
        // pragma-gated pattern as the `trusted` migration above — the ALTER
        // runs only when the column is absent, so a re-open never issues it.
        let has_archived: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'archived'",
            [],
            |row| row.get(0),
        )?;
        if has_archived == 0 {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // One-time migration for pre-existing databases: add
        // `context_usage_json` to `sessions` (fresh databases already have
        // it from SCHEMA). The same pragma-gated pattern as the `archived`
        // migration above — the ALTER runs only when the column is absent,
        // so a re-open never issues it. `NULL` (no default): a pre-existing
        // row has NO known usage (the bar shows nothing) — a default value
        // would fabricate one.
        let has_context_usage: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'context_usage_json'",
            [],
            |row| row.get(0),
        )?;
        if has_context_usage == 0 {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN context_usage_json TEXT",
                [],
            )?;
        }
        // One-time migration for pre-existing databases: add `is_subagent`
        // to `sessions` (fresh databases already have it from SCHEMA). The
        // same pragma-gated pattern as the `archived` / `context_usage_json`
        // migrations above. `DEFAULT 0` (existing rows are main sessions —
        // ADR 0025 §6: no data migration).
        let has_is_subagent: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'is_subagent'",
            [],
            |row| row.get(0),
        )?;
        if has_is_subagent == 0 {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // One-time migration for pre-existing databases: add `todos_json`
        // to `sessions` (fresh databases already have it from SCHEMA) and
        // backfill each non-subagent session's newest `manage_todo_list` write
        // (ADR 0073). The ALTER and the backfill run in ONE transaction, so a
        // crash rolls both back and retries on next open.
        let has_todos_json: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'todos_json'",
            [],
            |row| row.get(0),
        )?;
        if has_todos_json == 0 {
            let tx = conn.unchecked_transaction()?;
            tx.execute("ALTER TABLE sessions ADD COLUMN todos_json TEXT", [])?;
            backfill_session_todos(&tx)?;
            tx.commit()?;
        }
        // One-time migration for pre-existing databases: give
        // `native_messages` its `ON DELETE CASCADE` foreign key (a
        // pre-existing table cannot GAIN an FK in place — recreate it,
        // preserving the rows). Gated on a pragma pre-check, like the
        // `trusted` migration above. (Orphan rows — a transcript for a
        // session that is no longer stored — are dropped: they could
        // never cascade, and the FK would reject them.)
        let native_fk: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('native_messages') \
             WHERE \"table\" = 'sessions'",
            [],
            |row| row.get(0),
        )?;
        if native_fk == 0 {
            // ONE transaction (SQLite DDL is transactional — atomic: a
            // crash mid-batch cannot leave a half-migrated schema
            // behind; pre-fix each statement autocommitted, and a crash
            // left `native_messages_migrated` behind (and/or
            // `native_messages` dropped), so the next open re-ran the
            // batch, hit `CREATE TABLE … already exists`, and `Db::open`
            // errored forever — bricking startup). The `DROP TABLE IF
            // EXISTS` first makes the re-run crash-idempotent too (a
            // stale `native_messages_migrated` from a pre-transactional
            // crash is dropped before the `CREATE`).
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS native_messages_migrated;
                CREATE TABLE native_messages_migrated (
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(session_id, seq)
                );
                INSERT INTO native_messages_migrated (session_id, seq, role, content_json, created_at)
                    SELECT nm.session_id, nm.seq, nm.role, nm.content_json, nm.created_at
                    FROM native_messages nm
                    WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = nm.session_id);
                DROP TABLE native_messages;
                ALTER TABLE native_messages_migrated RENAME TO native_messages;",
            )?;
            tx.commit()?;
        }
        // One-time backfill for pre-existing databases: give a space row to every
        // distinct stored session cwd (canonicalized). A vanished folder is skipped
        // silently — its sessions stay stored, just without a space.
        // DO NOTHING on conflict: the backfill must NOT refresh last_opened_at on
        // every open (that would collapse the sidebar's recent-first ordering to a
        // tie on every restart — recency is refreshed by `upsert_space`, which runs
        // on real starts/resumes, i.e. Task 3's `record_session` hook).
        //
        // Key regime: rows are keyed by CANONICAL path — every upsert source
        // canonicalizes (`upsert_space` is fed `info.cwd`, canonicalized at
        // `start_session`/`resume_session`; the backfill above canonicalizes too),
        // so this migration intentionally does NOT re-key pre-existing non-canonical
        // rows. A hypothetical legacy non-canonical row is fail-closed: the
        // canonical lookup never matches it, so it can only cause MORE prompts,
        // never fewer.
        let cwds: Vec<String> = {
            let mut stmt = conn.prepare("SELECT DISTINCT cwd FROM sessions")?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for cwd in cwds {
            if let Ok(c) = std::fs::canonicalize(&cwd) {
                let p = c.display().to_string();
                let now = now_ms();
                conn.execute(
                    "INSERT INTO spaces (path, created_at, last_opened_at) VALUES (?1, ?2, ?2)
                     ON CONFLICT(path) DO NOTHING",
                    params![p, now],
                )?;
            }
        }
        Ok(Self {
            conn: StdMutex::new(conn),
        })
    }

    /// Record (or refresh) a session.
    ///
    /// Upserts by session id: `created_at` and `title` are preserved on a
    /// re-record (e.g. a resume), while cwd / capabilities are refreshed.
    pub fn record_session(&self, info: &SessionInfo) -> Result<(), DbError> {
        let capabilities = serde_json::to_string(&info.capabilities)?;
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO sessions (id, cwd, created_at, title, capabilities_json, is_subagent)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               cwd = excluded.cwd,
               capabilities_json = excluded.capabilities_json,
               is_subagent = excluded.is_subagent",
            params![
                info.session_id.to_string(),
                info.cwd.display().to_string(),
                now_ms(),
                Option::<String>::None,
                capabilities,
                info.is_subagent,
            ],
        )?;
        Ok(())
    }

    /// Persist the session's last known context usage (the
    /// `context_usage_update` frame's values — the provider's
    /// `input_tokens` vs the model's window). Called on EVERY frame, so a
    /// CLOSED session's context survives: the frontend's store drops the
    /// entry on close, but the row keeps the last known value for the
    /// stored session's context bar. A SEPARATE statement — the
    /// `record_session` upsert's `DO UPDATE` never touches
    /// `context_usage_json`, so a re-record on resume can't clobber the
    /// persisted usage. A missing row is a no-op (the session is recorded
    /// before its first frame can land).
    pub fn record_session_context_usage(
        &self,
        id: &str,
        used: u64,
        window: u64,
    ) -> Result<(), DbError> {
        let payload = serde_json::to_string(&serde_json::json!({
            "used": used,
            "window": window,
        }))?;
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET context_usage_json = ?2 WHERE id = ?1",
            params![id.to_string(), payload],
        )?;
        Ok(())
    }

    /// Update a session's persisted todos JSON (ADR 0073).
    ///
    /// A missing session row is a no-op; returns `Ok(())`.
    pub fn record_session_todos(&self, id: &str, todos_json: Option<&str>) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET todos_json = ?2 WHERE id = ?1",
            params![id, todos_json],
        )?;
        Ok(())
    }

    /// Read a session's persisted todos JSON (`None` when missing or NULL).
    pub fn session_todos(&self, id: &str) -> Result<Option<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT todos_json FROM sessions WHERE id = ?1")?;
        let found = match stmt.query_row(params![id], |row| row.get::<_, Option<String>>(0)) {
            Ok(val) => val,
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// Insert or update a message.
    ///
    /// `INSERT ... ON CONFLICT(session_id, kind, message_key) DO UPDATE` —
    /// the same `(session_id, kind, message_key)` triple always collapses to
    /// one row, so re-sent or replayed updates never duplicate.
    pub fn record_message(
        &self,
        session_id: &str,
        kind: &str,
        message_key: Option<&str>,
        payload_json: &str,
    ) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, kind, message_key) DO UPDATE SET
               payload_json = excluded.payload_json,
               created_at = excluded.created_at",
            params![session_id, kind, message_key, payload_json, now_ms()],
        )?;
        Ok(())
    }

    /// One stored session by id (`None` when absent) — the resume path
    /// reads the stored `capabilities_json` (the `loadSession` flag is the
    /// pre-check for a native resume).
    pub fn session(&self, id: &str) -> Result<Option<SessionRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT id, cwd, created_at, title, capabilities_json, archived, context_usage_json, is_subagent \
             FROM sessions WHERE id = ?1",
        )?;
        let row = stmt
            .query_map(params![id], |row| {
                Ok(SessionRow {
                    id: row.get(0)?,
                    cwd: row.get(1)?,
                    created_at: row.get(2)?,
                    title: row.get(3)?,
                    capabilities_json: row.get(4)?,
                    archived: row.get::<_, i64>(5)? != 0,
                    context_usage_json: row.get(6)?,
                    is_subagent: row.get::<_, i64>(7)? != 0,
                })
            })?
            .next()
            .transpose()?;
        Ok(row)
    }

    /// All stored sessions, MOST RECENTLY ACTIVE FIRST.
    ///
    /// The key is the session's LAST PERSISTED MESSAGE, falling back to
    /// `created_at` when it has none: the sidebar orders its rows by last
    /// activity and prints each row's relative time from the same last
    /// message, so the two must be the same fact or a list can be sorted by
    /// one thing and labelled by another. Ordering by `created_at` alone made a
    /// session started weeks ago but used a minute ago sit below one created
    /// yesterday and never used, which is what read as "no order at all".
    ///
    /// The fallback is why `COALESCE` is on the subquery and not on a
    /// `left_join … max()`: a session with an empty transcript is a session
    /// nobody has used yet, and `MAX()` over no rows is `NULL`, which SQLite
    /// would sort LAST in a `DESC` list — burying the newest thing on the list.
    ///
    /// The subquery rides `idx_messages_session` (the `(session_id, id)` index
    /// covers the lookup), and `list_sessions` runs once per boot and once per
    /// archive/delete, not per token — a desktop-sized history is not a
    /// performance question here.
    ///
    /// `include_archived = false` (the default) excludes archived rows — the
    /// sidebar's Space groups render stored sessions only; the boot fetches
    /// with `true` and splits client-side by the flag (ADR 0016). BOTH arms
    /// order identically: the Archived section reads the same recency.
    pub fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        // ONE ordering expression, shared by both arms — two copies of a
        // three-line `COALESCE` is two things that can drift, and a drifted
        // Archived section reads as a random order.
        const RECENT_FIRST: &str = "ORDER BY \
             COALESCE((SELECT MAX(m.created_at) FROM messages m \
                       WHERE m.session_id = sessions.id), sessions.created_at) DESC, \
             id DESC";
        let sql = if include_archived {
            format!(
                "SELECT id, cwd, created_at, title, capabilities_json, archived, context_usage_json, is_subagent
                 FROM sessions
                 WHERE is_subagent = 0
                 {RECENT_FIRST}"
            )
        } else {
            format!(
                "SELECT id, cwd, created_at, title, capabilities_json, archived, context_usage_json, is_subagent
                 FROM sessions
                 WHERE archived = 0 AND is_subagent = 0
                 {RECENT_FIRST}"
            )
        };
        let mut stmt = guard.prepare(&sql)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionRow {
                    id: row.get(0)?,
                    cwd: row.get(1)?,
                    created_at: row.get(2)?,
                    title: row.get(3)?,
                    capabilities_json: row.get(4)?,
                    archived: row.get::<_, i64>(5)? != 0,
                    context_usage_json: row.get(6)?,
                    is_subagent: row.get::<_, i64>(7)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Set (or clear) a session's archived flag (ADR 0016): the transcript
    /// is NOT touched — only the flag on the `sessions` row.
    ///
    /// Returns `true` when a row matched, `false` when nothing matched (a
    /// missing row is a no-op, not an error — mirroring `set_space_trusted`).
    pub fn set_session_archived(&self, id: &str, archived: bool) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET archived = ?2 WHERE id = ?1",
            params![id, archived],
        )?;
        Ok(n > 0)
    }

    /// Set a session's title ONLY when it has none (`title IS NULL`), so a
    /// title that already exists — a generated one from an earlier turn, or
    /// one a future rename affordance wrote — is never overwritten. The
    /// `WHERE title IS NULL` IS the race guard: one statement under the `Db`
    /// mutex, so a concurrent writer cannot slip between a check and a
    /// write. Returns `true` when a row was written, `false` when the row is
    /// missing or already titled (a missing row is a no-op, not an error —
    /// mirroring `set_session_archived`).
    pub fn set_session_title(&self, id: &str, title: &str) -> Result<bool, DbError> {
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET title = ?2 WHERE id = ?1 AND title IS NULL",
            params![id, title],
        )?;
        Ok(n > 0)
    }

    /// A session's messages in insertion order (the transcript order).
    pub fn messages_for(&self, session_id: &str) -> Result<Vec<MessageRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT id, session_id, kind, message_key, payload_json, created_at
             FROM messages
             WHERE session_id = ?1
             ORDER BY id",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(MessageRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    kind: row.get(2)?,
                    message_key: row.get(3)?,
                    payload_json: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// A page of a session's messages, newest-first by id up to `limit`
    /// rows, returned in ascending transcript order, with `has_more`
    /// indicating whether older messages exist (ADR 0073).
    ///
    /// When `limit` is `None`, all messages (prior to `before_id`, if specified)
    /// are returned in insertion order and `has_more` is `false`.
    pub fn messages_page(
        &self,
        session_id: &str,
        before_id: Option<i64>,
        limit: Option<u32>,
    ) -> Result<(Vec<MessageRow>, bool), DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        if let Some(n) = limit {
            let limit_probe = (n as i64) + 1;
            let mut stmt = guard.prepare(
                "SELECT id, session_id, kind, message_key, payload_json, created_at
                 FROM messages
                 WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807)
                 ORDER BY id DESC
                 LIMIT ?3",
            )?;
            let mut rows = stmt
                .query_map(params![session_id, before_id, limit_probe], |row| {
                    Ok(MessageRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        kind: row.get(2)?,
                        message_key: row.get(3)?,
                        payload_json: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = rows.len() > n as usize;
            if has_more {
                rows.truncate(n as usize);
            }
            rows.reverse();
            Ok((rows, has_more))
        } else {
            let mut stmt = guard.prepare(
                "SELECT id, session_id, kind, message_key, payload_json, created_at
                 FROM messages
                 WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807)
                 ORDER BY id",
            )?;
            let rows = stmt
                .query_map(params![session_id, before_id], |row| {
                    Ok(MessageRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        kind: row.get(2)?,
                        message_key: row.get(3)?,
                        payload_json: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((rows, false))
        }
    }

    /// Insert or refresh one native transcript message (the native
    /// `AgentLoop`'s provider transcript — native-agent-harness Task 6).
    ///
    /// `INSERT ... ON CONFLICT(session_id, seq) DO UPDATE` — the same
    /// `(session_id, seq)` always collapses to one row (idempotent). The
    /// `role` column is a DENORMALIZED index for cheap queries; the
    /// content is the serialized full `ChatMessage` (`content_json` —
    /// role + content + `tool_calls` + `tool_call_id` round-trip).
    pub fn insert_native_message(
        &self,
        session_id: &str,
        seq: i64,
        role: &str,
        content_json: &str,
    ) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO native_messages (session_id, seq, role, content_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, seq) DO UPDATE SET
               content_json = excluded.content_json,
               created_at = excluded.created_at",
            params![session_id, seq, role, content_json, now_ms()],
        )?;
        Ok(())
    }

    /// A session's native transcript in `seq` order (the provider
    /// transcript — the `content_json` rows; the `role` column is a
    /// denormalized index and is NOT read here). A malformed row is a
    /// `Json` error (a corrupt transcript must not silently load as an
    /// empty one).
    pub fn load_native_messages(&self, session_id: &str) -> Result<Vec<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT content_json FROM native_messages WHERE session_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Delete a session's native transcript (`native_messages` ONLY —
    /// the display `messages` table is NOT touched: the native resume
    /// path must NOT clear before `load_messages`).
    pub fn clear_native_messages(&self, session_id: &str) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "DELETE FROM native_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Replace a session's native transcript ATOMICALLY: delete all its
    /// rows, then insert the new ones — in a SINGLE transaction (the
    /// `run_compaction` rewrite: a crash mid-rewrite must never leave an
    /// empty / partial transcript). The same `(session_id, seq)` upsert
    /// semantics as [`insert_native_message`] apply to each row.
    pub fn replace_native_messages(
        &self,
        session_id: &str,
        rows: &[(i64, String, String)],
    ) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        tx.execute(
            "DELETE FROM native_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        for (seq, role, content_json) in rows {
            tx.execute(
                "INSERT INTO native_messages (session_id, seq, role, content_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(session_id, seq) DO UPDATE SET
                   content_json = excluded.content_json,
                   created_at = excluded.created_at",
                params![session_id, *seq, *role, *content_json, now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Delete a session; its `messages` AND `native_messages` rows are
    /// removed (both tables are `ON DELETE CASCADE`; the explicit
    /// `native_messages` `DELETE` is belt-and-suspenders — it also
    /// covers a pre-migration database that never gained the FK).
    pub fn delete_session(&self, session_id: &str) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        tx.execute(
            "DELETE FROM native_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Insert or touch the bookkeeping row for a folder.
    ///
    /// Keyed by the canonical path (the single key form, ADR 0010) — the
    /// input is canonicalized here, falling back to the raw string when the
    /// folder no longer exists (a best-effort write; reads stay
    /// fail-closed). `created_at` is preserved on conflict; `last_opened_at`
    /// is always refreshed (an actual start/resume is a real "open"). No folder
    /// validation happens here — whether the folder exists is the caller's
    /// problem (the canonicalizing gate is in `start_session`/`space_for_path`).
    ///
    /// `default_trusted` is written ONLY on INSERT (a NEW row is born
    /// `trusted` per the flag — the settings' `default_trust_new_spaces`);
    /// the CONFLICT branch never touches `trusted` (an existing row's flag
    /// is never changed by a re-upsert — no retroactive trust).
    pub fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted) VALUES (?1, ?2, ?2, ?3)
                 ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at",
            params![key, now_ms(), default_trusted],
        )?;
        Ok(())
    }

    /// Set (or clear) a space's trust flag, keyed by the canonical path
    /// (raw fallback on canonicalize failure, as in `upsert_space`).
    ///
    /// Returns `true` when a row matched, `false` when nothing matched (a
    /// missing row is a no-op, not an error — but a diagnosable one, not a
    /// silent one).
    pub fn set_space_trusted(&self, path: &str, trusted: bool) -> Result<bool, DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        let n = self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE spaces SET trusted = ?2 WHERE path = ?1",
            params![key, trusted],
        )?;
        Ok(n > 0)
    }

    /// All spaces, most recently opened first.
    pub fn list_spaces(&self) -> Result<Vec<SpaceRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT path, created_at, last_opened_at, trusted
             FROM spaces
             ORDER BY last_opened_at DESC, path ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SpaceRow {
                    path: row.get(0)?,
                    created_at: row.get(1)?,
                    last_opened_at: row.get(2)?,
                    trusted: row.get::<_, i64>(3)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Look up one space row by exact stored path (`None` if absent).
    pub fn find_space(&self, path: &str) -> Result<Option<String>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT path FROM spaces WHERE path = ?1")?;
        let found = match stmt.query_row(params![path], |row| row.get::<_, String>(0)) {
            Ok(path) => Some(path),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        Ok(found)
    }

    /// The trust flag for the space at `cwd`, keyed by the canonical path
    /// (the single key form, ADR 0010). Fail-closed: a canonicalize failure
    /// or a missing row is `Ok(false)` — untrusted.
    pub fn space_trusted(&self, cwd: &std::path::Path) -> Result<bool, DbError> {
        // Fail-closed on canonicalize failure (unlike the write path's raw
        // fallback): a folder that can't be canonicalized is untrusted.
        let Some(key) = space_key(cwd) else {
            return Ok(false);
        };
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT trusted FROM spaces WHERE path = ?1")?;
        let found = stmt
            .query_map(params![key], |row| row.get::<_, i64>(0))?
            .next()
            .transpose()?;
        Ok(found.map(|t| t != 0).unwrap_or(false))
    }

    /// Delete the bookkeeping row only (conversations/messages are NOT touched).
    pub fn delete_space(&self, path: &str) -> Result<(), DbError> {
        self.conn
            .lock()
            .expect("db mutex poisoned")
            .execute("DELETE FROM spaces WHERE path = ?1", params![path])?;
        Ok(())
    }
}

/// The current unix time in milliseconds.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The single key form of a `spaces` row (ADR 0010): the canonical path.
/// `None` when the path can't be canonicalized (the folder is missing, or
/// the filesystem changed) — the write path falls back to the raw string
/// (best-effort), the read path fails closed.
fn space_key(path: impl AsRef<std::path::Path>) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|c| c.display().to_string())
}

/// One-time backfill of `sessions.todos_json` from the newest non-read
/// `manage_todo_list` write in `messages` (ADR 0073).
fn backfill_session_todos(conn: &Connection) -> Result<(), DbError> {
    let mut session_stmt = conn.prepare("SELECT id FROM sessions WHERE is_subagent = 0")?;
    let session_ids = session_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(session_stmt);

    for session_id in session_ids {
        let matching_todos = {
            let mut msg_stmt = conn.prepare(
                "SELECT payload_json FROM messages \
                 WHERE session_id = ?1 AND kind = 'tool-call' AND payload_json LIKE '%manage_todo_list%' \
                 ORDER BY id DESC",
            )?;
            let rows = msg_stmt.query_map(params![session_id], |row| row.get::<_, String>(0))?;
            let mut matched = None;

            for payload_res in rows {
                let payload_str = payload_res?;
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&payload_str) else {
                    continue;
                };
                if val.get("title").and_then(serde_json::Value::as_str) != Some("manage_todo_list")
                {
                    continue;
                }
                let Some(raw_input) = val.get("rawInput") else {
                    continue;
                };
                if raw_input
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    == Some("read")
                {
                    continue;
                }
                let Some(todo_list) = raw_input
                    .get("todoList")
                    .and_then(serde_json::Value::as_array)
                else {
                    continue;
                };

                let mut filtered = Vec::new();
                for item in todo_list {
                    let Some(content) = item.get("content").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(status) = item.get("status").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    // Drop items with empty content or status (slightly stricter than the old frontend filter).
                    if content.is_empty() || status.is_empty() {
                        continue;
                    }
                    let mut clean_item = serde_json::Map::new();
                    clean_item.insert(
                        "content".into(),
                        serde_json::Value::String(content.to_string()),
                    );
                    clean_item.insert(
                        "status".into(),
                        serde_json::Value::String(status.to_string()),
                    );
                    if let Some(desc) = item.get("description").and_then(serde_json::Value::as_str)
                    {
                        clean_item.insert(
                            "description".into(),
                            serde_json::Value::String(desc.to_string()),
                        );
                    }
                    filtered.push(serde_json::Value::Object(clean_item));
                }

                if !filtered.is_empty() {
                    matched = Some(serde_json::to_string(&filtered)?);
                    break;
                }
            }
            matched
        };

        if let Some(serialized) = matching_todos {
            conn.execute(
                "UPDATE sessions SET todos_json = ?2 WHERE id = ?1",
                params![session_id, serialized],
            )?;
        }
    }
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
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
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message_key TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, kind, message_key)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE TABLE IF NOT EXISTS native_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);
CREATE TABLE IF NOT EXISTS spaces (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0
);
"#;

#[cfg(test)]
mod tests {
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
        let dir = std::env::temp_dir().join(format!("db-trusted-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (settings trust) a re-upsert on an EXISTING row never touches the
    /// trust flag (the CONFLICT branch only refreshes `last_opened_at`
    /// — no retroactive trust): `false` → trust ON → re-upsert `false`
    /// → the row is STILL trusted.
    #[test]
    fn upsert_space_conflict_leaves_the_existing_trust_untouched() {
        let dir = std::env::temp_dir().join(format!("db-trusted-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (the FK migration) A crash MID-BATCH leaves a stale
    /// `native_messages_migrated` table behind (the original
    /// `native_messages` still exists, WITHOUT the FK): the next
    /// `Db::open` must RECOVER (the migration is atomic +
    /// crash-idempotent — pre-fix the re-run hit `CREATE TABLE …
    /// already exists` and `Db::open` errored forever, bricking startup).
    #[test]
    fn a_crashed_fk_migration_recovers_on_the_next_open() {
        let dir = std::env::temp_dir().join(format!("db-migration-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let dir = std::env::temp_dir().join(format!("db-migration-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0016) A pre-existing database whose `sessions` table predates
    /// the `archived` column must open CLEANLY (the one-time migration adds
    /// the column with a `DEFAULT 0` backfill) and the pre-existing rows
    /// must read `archived == false` (the default).
    #[test]
    fn archived_column_migration_on_a_preexisting_db() {
        let dir = std::env::temp_dir().join(format!("db-archived-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        // A pre-existing database: the LEGACY `sessions` table (WITHOUT
        // `archived`) + the rest of the schema.
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
                last_opened_at INTEGER NOT NULL
            );
            INSERT INTO sessions VALUES ('s1', 'archimedes', '/tmp', 1, NULL, '{}');",
        )
        .unwrap();
        drop(conn);
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let dir = std::env::temp_dir().join(format!("db-riput-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0016) `list_sessions(false)` never returns archived rows;
    /// `list_sessions(true)` returns them with the flag set. Mixed-list
    /// parity: with a mix of archived and non-archived rows, the default
    /// list returns EXACTLY the non-archived row and the full list returns
    /// both with the correct flags.
    #[test]
    fn list_sessions_filters_archived_by_default() {
        let dir = std::env::temp_dir().join(format!("db-archived-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0016) `set_session_archived` on an id with no row is a no-op:
    /// `Ok(false)` (mirrors `set_space_trusted`'s documented behavior).
    #[test]
    fn set_session_archived_is_a_noop_for_an_unknown_id() {
        let dir = std::env::temp_dir().join(format!("db-archived-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let db = Db::open(&path).expect("db should open");
        assert!(
            !db.set_session_archived("no-such-session", true)
                .expect("should not error"),
            "a missing row is a no-op returning false"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The list is ordered by LAST ACTIVITY, not by creation: the session with
    /// the newest persisted message comes first, and a session with NO messages
    /// falls back to `created_at` rather than to nothing.
    ///
    /// The two halves both matter. Ordering by `created_at` alone (the old rule)
    /// put a session started weeks ago but used a minute ago BELOW one created
    /// yesterday and never used — which is what read as "no order at all". And
    /// ordering by `MAX(messages.created_at)` alone with a left join would sort
    /// a never-used session's `NULL` LAST in a `DESC` list, burying the newest
    /// thing on the list; the `COALESCE` is what stops that.
    #[test]
    fn list_sessions_orders_by_last_message_then_created_at() {
        let dir = std::env::temp_dir().join(format!("db-recency-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("t.db")).expect("db should open");
        // `created_at` written EXPLICITLY (hours apart): `record_session` stamps
        // `now_ms()`, and three inserts inside one millisecond would make the
        // fallback order a coin flip between `created_at` and the `id DESC`
        // tiebreak — a test that passes on a fast machine is not a test.
        {
            let conn = db.conn.lock().expect("db mutex poisoned");
            for (id, created) in [
                ("old-but-used", 1_000_i64),
                ("fresh-unused", 3_000_i64),
                ("stale-unused", 2_000_i64),
            ] {
                conn.execute(
                    "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
                     VALUES (?1, '/tmp/proj', ?2, '{}', 0)",
                    params![id, created],
                )
                .expect("insert should succeed");
            }
        }
        // The OLDEST-created session gets a message. `record_message` stamps
        // `now_ms()`, which is strictly after every `created_at` above.
        db.record_message("old-but-used", "user", None, "{\"text\":\"hi\"}")
            .expect("record_message should succeed");
        let ids: Vec<String> = db
            .list_sessions(false)
            .expect("list_sessions should succeed")
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(
            ids,
            vec!["old-but-used", "fresh-unused", "stale-unused"],
            "the used session leads on its message; the never-used ones keep \
             `created_at` desc (the COALESCE fallback), not a NULL last"
        );
        // The archived arm orders identically — the Archived section reads the
        // same recency (one shared `ORDER BY`, so it cannot drift).
        db.set_session_archived("fresh-unused", true).unwrap();
        let ids: Vec<String> = db
            .list_sessions(true)
            .expect("list_sessions(true) should succeed")
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(
            ids,
            vec!["old-but-used", "fresh-unused", "stale-unused"],
            "the archived-inclusive list orders the same way"
        );
        let _ = std::fs::remove_dir_all(&dir);
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
            is_subagent: false,
        }
    }

    /// The session's title is written ONLY while it has none, and only once:
    /// the first `set_session_title` writes the `NULL` title and returns
    /// `true`, and both `session()` and `list_sessions()` read it back (the
    /// naming pass's write must reach the boot fetch that lists sessions).
    #[test]
    fn set_session_title_writes_a_null_title_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("db-title-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A title that already exists is NEVER overwritten — a second
    /// `set_session_title` returns `false` and leaves the FIRST title (the
    /// generated title from an earlier turn, or one a future rename
    /// affordance wrote, wins). This is the race guard: the naming pass may
    /// fire on several turns, and only the first write lands.
    #[test]
    fn set_session_title_never_overwrites_an_existing_title() {
        let dir = std::env::temp_dir().join(format!("db-title-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `set_session_title` on an id with no row is a no-op: `Ok(false)`
    /// (mirrors `set_session_archived` — a missing row is not an error).
    #[test]
    fn set_session_title_is_a_noop_for_an_unknown_id() {
        let dir = std::env::temp_dir().join(format!("db-title-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let db = Db::open(&path).expect("db should open");
        assert!(
            !db.set_session_title("no-such-session", "Any title")
                .expect("should not error"),
            "a missing row is a no-op returning false"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A re-`record_session` (the resume re-record) never clears the stored
    /// title — the `ON CONFLICT … DO UPDATE` branch must not touch `title`
    /// (resuming a titled session must not erase its label, exactly as it
    /// must not un-archive it).
    #[test]
    fn record_session_preserves_the_title() {
        let dir = std::env::temp_dir().join(format!("db-title-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0016) A re-`record_session` (the resume re-record) never clears
    /// the archived flag — the `ON CONFLICT … DO UPDATE` branch must not
    /// touch `archived` (no retroactive un-archive).
    #[test]
    fn record_session_preserves_the_archived_flag() {
        let dir = std::env::temp_dir().join(format!("db-archived-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (ADR 0025 §3) A subagent `sessions` row (`is_subagent = 1`) is
    /// HIDDEN from `list_sessions` (the `is_subagent = 0` filter) but its
    /// transcript rows are still loadable (`load_native_messages` works
    /// for subagent ids — it does NOT filter on `is_subagent`).
    #[test]
    fn list_sessions_hides_subagent_rows_but_their_transcripts_load() {
        let dir = std::env::temp_dir().join(format!("db-subagent-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pre-existing database whose `sessions` table predates the
    /// `context_usage_json` column must open CLEANLY (the one-time
    /// migration adds the column) and the pre-existing rows must read
    /// `context_usage == None` (the default).
    #[test]
    fn context_usage_column_migration_on_a_preexisting_db() {
        let dir = std::env::temp_dir().join(format!("db-context-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        // A pre-existing database: the `sessions` table WITHOUT
        // `context_usage_json` (the `archived` column IS present — this
        // test isolates the context migration).
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                cwd TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                title TEXT,
                capabilities_json TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO sessions VALUES ('s1', '/tmp', 1, NULL, '{}', 0);",
        )
        .unwrap();
        drop(conn);
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `record_session_context_usage` persists the session's last known
    /// context usage (the frontend's context-percentage display for a
    /// CLOSED session — the store drops it on close, but the row keeps
    /// it): `session()` / `list_sessions()` read it back, and
    /// `record_session` (the resume re-record) does NOT clobber it.
    #[test]
    fn record_session_context_usage_persists_and_survives_record_session() {
        let dir = std::env::temp_dir().join(format!("db-context-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `messages_page` pages newest-first by id, returns ascending order,
    /// and reports `has_more` correctly across boundaries and exact fits.
    #[test]
    fn messages_page_paginates_and_reports_has_more() {
        let dir = std::env::temp_dir().join(format!("db-page-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_session_todos_roundtrips_and_clears() {
        let dir = std::env::temp_dir().join(format!("db-todos-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_db_migration_backfills_newest_non_read_todos_once() {
        let dir = std::env::temp_dir().join(format!("db-todos-backfill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
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

        let _ = std::fs::remove_dir_all(&dir);
    }
}
