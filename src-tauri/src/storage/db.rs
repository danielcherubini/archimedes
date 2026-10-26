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

/// One session's recency, as a FIELD rather than a position (ADR 0075).
///
/// `list_sessions` stopped sorting by recency, so recency has to be asked for
/// by name. This is the ONLY thing that crosses the wire for that question —
/// deliberately NOT a `SessionInfo` field: `SessionInfo` is built by dozens of
/// struct literals and is the struct ADR 0064 protects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecency {
    pub session_id: String,
    /// Unix milliseconds. Never absent: `LAST_ACTIVITY`'s `COALESCE` falls back
    /// to the row's own `created_at` when the transcript is empty.
    pub last_active_at: i64,
    /// The row's position in the user's MANUAL ORDER (bigger number = lower
    /// row), echoed straight from the row's own order column.
    ///
    /// It rides THIS payload rather than a payload of its own because ONE
    /// sequence has to span live and stored rows, and the frontend cannot
    /// interleave what it cannot see: a **Session** RESUMED this boot is live,
    /// yet the slot it renders in is the one the database holds for it. A
    /// second boot round-trip for the same rows is the alternative, and the
    /// boot `Promise.all` already pays for this one.
    ///
    /// Nothing in the frontend reads the NAME — the store reduces it into an
    /// order map (`setSessionRecency` → `sessionOrder`) and only
    /// `mergeSessionOrder` consumes that. It is position and nothing else, so
    /// it is never evidence (ADR 0075).
    pub sort_order: i64,
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
        // One-time migration for pre-existing databases: add `sort_order` to
        // `spaces` (fresh databases already have it from SCHEMA) and seed it
        // with the order the user was already looking at. The ALTER and the
        // seed run in ONE transaction, so a crash rolls both back and retries
        // on the next open — which is what makes the seed one-time rather than
        // merely idempotent.
        //
        // TWO independent gates, one per table, because each gate probes and
        // repairs its own table through `pragma_table_info`: a crash between
        // the two commits leaves one table seeded and the other un-migrated,
        // and that mixed state is SELF-HEALING — the next open re-probes both
        // tables and runs whichever gate is still missing, independently. It
        // also matches this file's one-column-per-gate style.
        let has_space_sort_order: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('spaces') WHERE name = 'sort_order'",
            [],
            |row| row.get(0),
        )?;
        if has_space_sort_order == 0 {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "ALTER TABLE spaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            seed_space_sort_order(&tx)?;
            tx.commit()?;
        }
        // The matching gate for `sessions` (see the `spaces` gate above for
        // why the two are separate transactions). This gate — like the space
        // one — runs BEFORE the phase-11 space backfill below, so a database
        // that already has `sessions` rows but no `spaces` rows reaches the
        // backfill with the session numbering already settled.
        let has_session_sort_order: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'sort_order'",
            [],
            |row| row.get(0),
        )?;
        if has_session_sort_order == 0 {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            seed_session_sort_order(&tx)?;
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
        // DO NOTHING on conflict: the backfill must NOT refresh `last_opened_at`
        // or `created_at` on every open — an open is not an "open" the user did,
        // and those timestamps stay the bookkeeping values the row was born with.
        // (Recency is no longer the sort key at all — `list_spaces` reads
        // `sort_order` — so this rule protects the stored timestamps, not a list
        // order.)
        //
        // The INSERT joins at the BOTTOM (`MAX + 1`): on this upgrade path the
        // seed may have numbered nothing, and a row left on `DEFAULT 0` would tie
        // with every other backfilled row and hand the user an alphabetical list.
        // ADR 0075's Consequences own the full reason.
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
                    "INSERT INTO spaces (path, created_at, last_opened_at, sort_order) \
                     VALUES (?1, ?2, ?2, COALESCE((SELECT MAX(sort_order) FROM spaces), -1) + 1)
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
    ///
    /// A NEW row joins the list at the BOTTOM (`MAX + 1`); the CONFLICT branch
    /// never renumbers — a resume re-runs `record_session`, and a row the user
    /// has positioned must not move when its session is resumed (ADR 0075).
    pub fn record_session(&self, info: &SessionInfo) -> Result<(), DbError> {
        let capabilities = serde_json::to_string(&info.capabilities)?;
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO sessions (id, cwd, created_at, title, capabilities_json, is_subagent, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT MAX(sort_order) FROM sessions), -1) + 1)
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

    /// All stored sessions, in the user's manual order (`sort_order`), `id`
    /// descending breaking ties.
    ///
    /// Position is NOT evidence of recency: nothing but a drag (or the one-time
    /// upgrade seed) moves a row, so a session that was used a second ago sits
    /// exactly where its number says (ADR 0075,
    /// `docs/decisions/0075-list-position-is-not-evidence.md`). Recency is a
    /// FIELD, not a position — `LAST_ACTIVITY` is the single copy of that
    /// expression: the seed reads with it, and the row struct will `SELECT` it as
    /// `last_active_at`, so the number a row prints and the number any recency
    /// decision reads cannot drift.
    ///
    /// The subquery behind that expression rides `idx_messages_session` (the
    /// `(session_id, id)` index covers the lookup), and `list_sessions` runs once
    /// per boot and once per archive/delete, not per token — a desktop-sized
    /// history is not a performance question here.
    ///
    /// `include_archived = false` (the default) excludes archived rows — the
    /// sidebar's Space groups render stored sessions only; the boot fetches
    /// with `true` and splits client-side by the flag (ADR 0016). BOTH arms
    /// order identically, for the same reason they filter identically: one
    /// shared `ORDER BY`, so the Archived section cannot drift.
    pub fn list_sessions(&self, include_archived: bool) -> Result<Vec<SessionRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let sql = if include_archived {
            "SELECT id, cwd, created_at, title, capabilities_json, archived, context_usage_json, is_subagent
             FROM sessions
             WHERE is_subagent = 0
             ORDER BY sort_order ASC, id DESC"
        } else {
            "SELECT id, cwd, created_at, title, capabilities_json, archived, context_usage_json, is_subagent
             FROM sessions
             WHERE archived = 0 AND is_subagent = 0
             ORDER BY sort_order ASC, id DESC"
        };
        let mut stmt = guard.prepare(sql)?;
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

    /// Every non-subagent session's recency, as an explicit FIELD (ADR 0075 —
    /// position is not evidence, so anything that wants recency has to ask for it).
    ///
    /// The SQL is the SAME `LAST_ACTIVITY` const the upgrade seed
    /// (`seed_session_sort_order`) reads with, interpolated here with `format!`
    /// the way that seed builds its statement — so the number a row prints and
    /// the number a recency decision reads cannot drift: one copy of the
    /// expression exists, and it is that const.
    ///
    /// The filter is `is_subagent = 0` with NO `archived` filter, matching
    /// `list_sessions(true)` exactly. That equality is the contract: the recency
    /// map's key set equals the boot session list's key set, so a consumer can
    /// never meet a session with no recency entry, nor a recency entry with no
    /// session.
    ///
    /// `ORDER BY id` is arbitrary but STABLE: consumers key by id, so the order
    /// is not a contract — it is pinned only so the returned `Vec` is
    /// deterministic (a `Vec` with no `ORDER BY` is a nondeterministic fixture).
    /// `id` is the primary key, so the sort is free.
    ///
    /// The row's own order column travels with the stamp (see
    /// `SessionRecency::sort_order`), so ONE frontend sequence can span live and
    /// stored rows off this ONE read. No constant wraps that column name: it is
    /// a plain column, not a shared expression, and inventing one would imply a
    /// drift risk that does not exist.
    pub fn session_recency(&self) -> Result<Vec<SessionRecency>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(&format!(
            "SELECT id, {LAST_ACTIVITY}, sort_order FROM sessions WHERE is_subagent = 0 ORDER BY id"
        ))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SessionRecency {
                    session_id: row.get(0)?,
                    last_active_at: row.get(1)?,
                    sort_order: row.get(2)?,
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

    /// Rewrite the manual order of the given session ids in ONE transaction:
    /// the slice index becomes `sort_order` (ADR 0075 — only a drag calls this).
    ///
    /// Keyed by the stored id RAW, as `session`/`set_session_archived` are: the
    /// ids come from a `list_sessions()` result and are already the stored key.
    /// An id that matches no row is a no-op.
    ///
    /// The slice is the sidebar's VISIBLE list of ONE Space, but the numbering is
    /// GLOBAL, so this renumbers hidden `is_subagent = 1` rows too whenever the
    /// caller hands one back (hazard H1: a hidden row consumes a number) and
    /// leaves every other Space's rows on their old numbers — which therefore
    /// COLLIDE with the freshly written ones. That is the intended steady state,
    /// not corruption: `ORDER BY sort_order ASC, id DESC` is total, so reads stay
    /// deterministic, and display is per-Space, so no surface ever renders two
    /// Spaces' rows side by side by `sort_order` alone. Renumbering the untouched
    /// rows to keep the column globally unique would move rows the user did not
    /// drag, in Spaces they are not looking at.
    pub fn reorder_sessions(&self, ids: &[String]) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, index as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
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
    /// A NEW row joins the list at the BOTTOM (`MAX + 1`); the CONFLICT branch
    /// never renumbers, so a re-touch refreshes recency and leaves the row
    /// exactly where the user put it (ADR 0075 — only a drag moves a row).
    ///
    /// `default_trusted` is written ONLY on INSERT (a NEW row is born
    /// `trusted` per the flag — the settings' `default_trust_new_spaces`);
    /// the CONFLICT branch never touches `trusted` (an existing row's flag
    /// is never changed by a re-upsert — no retroactive trust).
    pub fn upsert_space(&self, path: &str, default_trusted: bool) -> Result<(), DbError> {
        let key = space_key(path).unwrap_or_else(|| path.to_string());
        self.conn.lock().expect("db mutex poisoned").execute(
            "INSERT INTO spaces (path, created_at, last_opened_at, trusted, sort_order) \
             VALUES (?1, ?2, ?2, ?3, COALESCE((SELECT MAX(sort_order) FROM spaces), -1) + 1)
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

    /// All spaces, in the user's manual order (`sort_order`), `path` breaking
    /// ties. Nothing else moves a row.
    pub fn list_spaces(&self) -> Result<Vec<SpaceRow>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT path, created_at, last_opened_at, trusted
             FROM spaces
             ORDER BY sort_order ASC, path ASC",
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

    /// Rewrite the manual order of the given space paths in ONE transaction:
    /// the slice index becomes `sort_order` (ADR 0075 — only a drag calls this).
    ///
    /// Keyed by the stored path RAW, as `find_space`/`delete_space` do: the ids
    /// come from a `list_spaces()` result and are already the stored key, and
    /// re-canonicalizing would silently skip a row whose folder is gone and
    /// leave a PARTIAL renumber behind. An id that matches no row is a no-op.
    ///
    /// Unlike `reorder_sessions` this always renumbers the WHOLE table: the
    /// sidebar's tab strip passes every Space it shows, so a space reorder cannot
    /// leave numbers colliding with rows it never saw.
    pub fn reorder_spaces(&self, paths: &[String]) -> Result<(), DbError> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        let tx = guard.transaction()?;
        for (index, path) in paths.iter().enumerate() {
            tx.execute(
                "UPDATE spaces SET sort_order = ?2 WHERE path = ?1",
                params![path, index as i64],
            )?;
        }
        tx.commit()?;
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

/// One-time seed of `spaces.sort_order` on a pre-existing database (ADR 0075).
///
/// The read order is the OLD display order (`last_opened_at DESC, path ASC`)
/// and is HARDCODED on purpose: at seed time every row still carries
/// `DEFAULT 0`, so ordering by `sort_order` would be a pure tie and would pick
/// an order nobody ever saw — the upgrade must reproduce the list the user was
/// already looking at (ADR 0075's Consequences own the full reason).
fn seed_space_sort_order(conn: &Connection) -> Result<(), DbError> {
    let mut stmt =
        conn.prepare("SELECT path FROM spaces ORDER BY last_opened_at DESC, path ASC")?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    // Close the read cursor before the writes start (the `backfill_session_todos`
    // hygiene — a live Statement is not a compile or SQLite requirement).
    drop(stmt);

    for (index, path) in paths.iter().enumerate() {
        conn.execute(
            "UPDATE spaces SET sort_order = ?2 WHERE path = ?1",
            params![path, index as i64],
        )?;
    }
    Ok(())
}

/// One-time seed of `sessions.sort_order` on a pre-existing database (ADR 0075).
///
/// The read order is the OLD display order (last activity, then `id DESC`) and
/// is HARDCODED on purpose for the same reason as `seed_space_sort_order`: at
/// seed time the column is all `DEFAULT 0`, so it cannot be its own seed order.
///
/// NO `WHERE` — every row is numbered, hidden `is_subagent = 1` rows included
/// (hazard H1): the bottom-join `MAX + 1` is global, so a hidden row already
/// consumes a number, and seeding only the visible rows would duplicate values
/// and tie them with the visible row at 0.
fn seed_session_sort_order(conn: &Connection) -> Result<(), DbError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM sessions ORDER BY {LAST_ACTIVITY} DESC, id DESC"
    ))?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt); // close the read cursor before the writes (hygiene, as above)

    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    Ok(())
}

/// A session's last activity in unix milliseconds: the newest timestamp in its
/// transcript, falling back to the row's own `created_at` when the transcript
/// is empty (`COALESCE` on the SUBQUERY — `MAX()` over no rows is `NULL`, which
/// SQLite sorts LAST in a `DESC` list, burying the newest thing on the list).
///
/// This is the single copy of the expression. It is the order the pre-manual
/// `list_sessions` used, it is the order `seed_session_sort_order` reads with,
/// and it is what the frontend prints as a session's `last_active_at` — so the
/// number a row shows and the number a recency decision reads cannot drift.
const LAST_ACTIVITY: &str = "COALESCE((SELECT MAX(m.created_at) FROM messages m \
                             WHERE m.session_id = sessions.id), sessions.created_at)";

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
    todos_json TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
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
    trusted INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
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
    #[test]
    fn archived_column_migration_on_a_preexisting_db() {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-archived-test-", "scratch");
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
    }

    /// A pre-existing database whose `sessions` table predates the
    /// `context_usage_json` column must open CLEANLY (the one-time
    /// migration adds the column) and the pre-existing rows must read
    /// `context_usage == None` (the default).
    #[test]
    fn context_usage_column_migration_on_a_preexisting_db() {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-context-test-", "scratch");
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
    #[test]
    fn sort_order_seeded_in_the_old_space_order_on_a_preexisting_db() {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-sortspace-test-", "scratch");
        let path = dir.join("t.db");
        create_pre_sort_order_db(&path);
        let conn = Connection::open(&path).expect("raw open of the fixture db");
        for (path_value, created, opened) in [
            ("/x/b", 1_i64, 3_000_i64),
            ("/x/a", 1, 2_000),
            ("/x/c", 1, 2_000),
        ] {
            conn.execute(
                "INSERT INTO spaces (path, created_at, last_opened_at) VALUES (?1, ?2, ?3)",
                params![path_value, created, opened],
            )
            .expect("fixture space row");
        }
        drop(conn);

        let db = Db::open(&path).expect("the sort_order seed must not brick startup");
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
    }

    /// (sort_order) A pre-existing database is seeded in the order the user
    /// was ALREADY looking at for sessions: last activity (the `COALESCE`
    /// expression) then `id DESC`. That order is neither `id DESC` alone nor
    /// `created_at DESC` alone, so the assertion pins the whole expression.
    #[test]
    fn sort_order_seeded_in_the_old_session_order_on_a_preexisting_db() {
        let dir = crate::test_support::ScratchDir::in_env_temp("db-sortsess-test-", "scratch");
        let path = dir.join("t.db");
        create_pre_sort_order_db(&path);
        let conn = Connection::open(&path).expect("raw open of the fixture db");
        // A cwd that does not exist on disk: the phase-11 space backfill skips
        // it, so the fixture stays about sessions only.
        for (id, created) in [
            ("s_old_used", 1_000_i64),
            ("s_stale", 2_000),
            ("s_fresh", 3_000),
        ] {
            conn.execute(
                "INSERT INTO sessions (id, cwd, created_at, capabilities_json, is_subagent) \
                 VALUES (?1, '/x/nope-not-a-folder', ?2, '{}', 0)",
                params![id, created],
            )
            .expect("fixture session row");
        }
        // The OLDEST-created session is the most recently USED one.
        conn.execute(
            "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
             VALUES ('s_old_used','user',NULL,'{}',9999)",
            [],
        )
        .expect("fixture message row");
        drop(conn);

        let db = Db::open(&path).expect("the sort_order seed must not brick startup");
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
}
