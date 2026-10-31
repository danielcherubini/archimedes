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

use rusqlite::{params, Connection, Row, Transaction};
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
    /// The session's provider-reported running cost in USD (issue #105):
    /// the SUM of every `cost_update` frame's per-call delta, accumulated by
    /// `record_session_cost` so a CLOSED session keeps its figure (the
    /// frontend's store drops its entry on close — the row is the source of
    /// truth for the stored figure) and a RESUMED session continues its total
    /// instead of restarting it.
    ///
    /// `None` means NO model call ever reported a cost — which is NOT the same
    /// as `Some(0.0)`, a call that reported a genuine zero. The renderer prints
    /// nothing for the first and `$0.00` for the second; collapsing them is the
    /// D5 defect this column exists to avoid (ADR 0082). The column therefore
    /// has no `DEFAULT` (see the migration in `Db::open`).
    pub cost_usd: Option<f64>,
}

/// The ONE `sessions` SELECT list every `SessionRow` read uses, as a const
/// array of column names.
///
/// It exists so the list and the mapper cannot be edited apart: the three
/// reads (`session`, both `list_sessions` arms) interpolate THIS list, and the
/// one mapper below reads it position-for-position. Before this const, each
/// read spelled its own copy of the 9 names and each built its own positional
/// `get` ladder — the F12 hazard: a list edited without its ladder compiles and
/// mis-maps at runtime.
///
/// The honest scope of what keeps them in sync: the per-row-type drift-guard
/// TEST (`session_row_from_maps_the_select_const_columns_in_order`, which
/// asserts `column_count() == SESSION_ROW_FIELDS` before any value) is the
/// guard. The const is what makes that test able to speak about the SELECT at
/// all; it is not itself a compile-time check of the SELECT text.
const SESSION_COLUMNS: [&str; 9] = [
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

const SESSION_ROW_FIELDS: usize = 9;
// Compile-time arity tie ONLY: the length of the const list must equal
// SESSION_ROW_FIELDS. It cannot see a column appended to both the const AND the
// field count in one edit, and it cannot see the SELECT statement at all — the
// per-row-type drift-guard TEST
// (`session_row_from_maps_the_select_const_columns_in_order`, in
// `storage/db/tests/`) is the guard. What this tie does buy: renumbering one
// literal without the other fails to compile, so a half-finished edit is
// rejected at once. It is kept for that fast rejection, not as the guard.
const _: [(); SESSION_COLUMNS.len()] = [(); SESSION_ROW_FIELDS];

/// Map one row of [`SESSION_COLUMNS`] onto a [`SessionRow`], index for index.
///
/// The ONE place a `SessionRow` is constructed (3 call sites: `session`, both
/// `list_sessions` arms). The `get::<_, i64>` calls on the two INTEGER-as-bool
/// columns are a RUNTIME conversion, not a compile-time check: a DDL type change
/// makes them fail loudly with `InvalidColumnType` instead of silently
/// mis-mapping, but they do not catch a column appended to the const (see the
/// drift-proof in the plan — the drift-guard TEST owns that class).
fn session_row_from(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        cwd: row.get(1)?,
        created_at: row.get(2)?,
        title: row.get(3)?,
        capabilities_json: row.get(4)?,
        archived: row.get::<_, i64>(5)? != 0,
        context_usage_json: row.get(6)?,
        is_subagent: row.get::<_, i64>(7)? != 0,
        cost_usd: row.get(8)?,
    })
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

/// The ONE `messages` SELECT list every `MessageRow` read uses, as a const
/// array of column names — same reason and same honest scope as
/// [`SESSION_COLUMNS`] (the drift-guard TEST is the guard).
const MESSAGE_COLUMNS: [&str; 6] = [
    "id",
    "session_id",
    "kind",
    "message_key",
    "payload_json",
    "created_at",
];

const MESSAGE_ROW_FIELDS: usize = 6;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS above for the honest
// scope: it catches a half-renumbered edit, it cannot see the SELECT, and the
// drift-guard TEST (`message_row_from_maps_the_select_const_columns_in_order`)
// is the guard.
const _: [(); MESSAGE_COLUMNS.len()] = [(); MESSAGE_ROW_FIELDS];

/// Map one row of [`MESSAGE_COLUMNS`] onto a [`MessageRow`], index for index.
///
/// The ONE place a `MessageRow` is constructed (3 call sites: `messages_for`,
/// both `messages_page` arms). Every column here is a plain `row.get` — the
/// table holds no INTEGER-as-bool column, so there is nothing to type-annotate.
fn message_row_from(row: &Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        kind: row.get(2)?,
        message_key: row.get(3)?,
        payload_json: row.get(4)?,
        created_at: row.get(5)?,
    })
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

/// The ONE `spaces` SELECT list `list_spaces` uses, as a const array of column
/// names — same reason and same honest scope as [`SESSION_COLUMNS`].
///
/// `sort_order` is deliberately ABSENT: `SpaceRow` predates manual ordering and
/// `list_spaces` consumes that column only in its `ORDER BY`, never as a field.
/// Adding it here would change the wire type `Vec<SpaceRow>` that
/// `commands/spaces.rs` returns, so its absence is a decision, not an omission.
const SPACE_COLUMNS: [&str; 4] = ["path", "created_at", "last_opened_at", "trusted"];

const SPACE_ROW_FIELDS: usize = 4;
// Compile-time arity tie ONLY — see SESSION_ROW_FIELDS above for the honest
// scope; the drift-guard TEST
// (`space_row_from_maps_the_select_const_columns_in_order`) is the guard.
const _: [(); SPACE_COLUMNS.len()] = [(); SPACE_ROW_FIELDS];

/// Map one row of [`SPACE_COLUMNS`] onto a [`SpaceRow`], index for index.
///
/// The ONE place a `SpaceRow` is constructed (1 call site: `list_spaces`).
/// `trusted` is the INTEGER-as-bool column, so its `get::<_, i64>` is a runtime
/// conversion (a loud `InvalidColumnType` on a DDL type change), not a
/// compile-time check — see the drift-proof in the plan.
fn space_row_from(row: &Row<'_>) -> rusqlite::Result<SpaceRow> {
    Ok(SpaceRow {
        path: row.get(0)?,
        created_at: row.get(1)?,
        last_opened_at: row.get(2)?,
        trusted: row.get::<_, i64>(3)? != 0,
    })
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

/// Run `add` inside ONE transaction iff `table.column` is absent (probed via
/// `pragma_table_info`).
///
/// `gate` is a TRANSACTION FACTORY: it opens the `unchecked_transaction`,
/// passes it to `add`, and commits ONLY after `add` returns Ok — so an ALTER
/// paired with a data step (backfill/seed) is atomic, and a crash
/// mid-backfill leaves the ALTER NOT committed, so the next open re-probes
/// and re-runs the whole gate. It is NOT a wrap-the-call helper: the
/// transaction is opened HERE (before the closure runs) and committed HERE
/// (only after it returns Ok), which is what makes the ALTER+backfill pair one
/// atomic unit. A single-statement gate just does its one ALTER inside the
/// same tx (a single DDL is atomic in SQLite anyway).
///
/// The crash-state this changes: before the factory existed, the gates that
/// paired an ALTER with a data step committed the ALTER and rolled back only
/// the data step on a mid-gate crash, so the next open re-ran the seed against
/// an already-migrated column — which for `sort_order` could DUPLICATE the
/// ADR 0075 numbers. Under the factory a crash rolls the ALTER back too, the
/// `pragma_table_info` probe still finds the column missing, and the WHOLE gate
/// runs cleanly on the next open.
///
/// Table and column are compile-time literals at every call site; they are
/// bound as parameters to the probe (both spellings are safe here).
fn gate(
    conn: &mut Connection,
    table: &str,
    column: &str,
    add: impl FnOnce(&mut Transaction<'_>) -> Result<(), DbError>,
) -> Result<(), DbError> {
    let has: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?;
    if has == 0 {
        let mut tx = conn.unchecked_transaction()?;
        // Closures that only read/execute may pass `&*tx` onward where a
        // `&Connection` is wanted (a `Transaction` derefs to one).
        add(&mut tx)?;
        tx.commit()?;
    }
    Ok(())
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
        let mut conn = Connection::open(path)?;
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
        gate(&mut conn, "spaces", "trusted", |tx| {
            tx.execute(
                "ALTER TABLE spaces ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `archived` to
        // `sessions` (fresh databases already have it from SCHEMA). The same
        // pragma-gated pattern as the `trusted` migration above — the ALTER
        // runs only when the column is absent, so a re-open never issues it.
        gate(&mut conn, "sessions", "archived", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add
        // `context_usage_json` to `sessions` (fresh databases already have
        // it from SCHEMA). The same pragma-gated pattern as the `archived`
        // migration above — the ALTER runs only when the column is absent,
        // so a re-open never issues it. `NULL` (no default): a pre-existing
        // row has NO known usage (the bar shows nothing) — a default value
        // would fabricate one.
        gate(&mut conn, "sessions", "context_usage_json", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN context_usage_json TEXT",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `is_subagent`
        // to `sessions` (fresh databases already have it from SCHEMA). The
        // same pragma-gated pattern as the `archived` / `context_usage_json`
        // migrations above. `DEFAULT 0` (existing rows are main sessions —
        // ADR 0025 §6: no data migration).
        gate(&mut conn, "sessions", "is_subagent", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `todos_json`
        // to `sessions` (fresh databases already have it from SCHEMA) and
        // backfill each non-subagent session's newest `manage_todo_list` write
        // (ADR 0073). The ALTER and the backfill run in ONE transaction, so a
        // crash rolls both back and retries on next open.
        gate(&mut conn, "sessions", "todos_json", |tx| {
            tx.execute("ALTER TABLE sessions ADD COLUMN todos_json TEXT", [])?;
            // The backfill helper takes `&Connection`; deref coercion reaches it
            // from the `&mut Transaction`, so the data step runs on the SAME
            // transaction as the ALTER above.
            backfill_session_todos(tx)?;
            Ok(())
        })?;
        // One-time migration for pre-existing databases: add `cost_usd` to
        // `sessions` (fresh databases already have it from SCHEMA). The same
        // pragma-gated pattern as the `todos_json` migration above.
        //
        // NO `DEFAULT` and NO backfill, and that is the load-bearing part of
        // this gate (issue #105, D5 / ADR 0082): `NULL` means "no model call
        // ever reported a cost" and renders NOTHING, while `0.0` means "a call
        // reported a real zero" and renders `$0.00`. A `DEFAULT 0` would
        // migrate every pre-existing row into the second meaning — a figure
        // the provider never reported — which is exactly the phantom-`$0.00`
        // defect this column exists to avoid. The `todos_json` precedent has a
        // backfill because todo data existed elsewhere; cost data never existed
        // anywhere, so `NULL` is the only honest value for an old row. That
        // no-default rule is asserted by the migration test
        // `cost_usd_column_migration_on_a_preexisting_db`, which reads
        // `pragma_table_info('sessions').dflt_value` and requires NULL — a
        // `DEFAULT 0` added here fails that pin.
        gate(&mut conn, "sessions", "cost_usd", |tx| {
            // No transaction wrapper is spelled at this call site: the single
            // ALTER runs inside the factory's tx (atomically, identically — a
            // lone DDL is atomic in SQLite anyway), so the gate states ONE
            // statement and ONE transaction policy like every other gate.
            tx.execute("ALTER TABLE sessions ADD COLUMN cost_usd REAL", [])?;
            Ok(())
        })?;
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
        gate(&mut conn, "spaces", "sort_order", |tx| {
            tx.execute(
                "ALTER TABLE spaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            seed_space_sort_order(tx)?;
            Ok(())
        })?;
        // The matching gate for `sessions` (see the `spaces` gate above for
        // why the two are separate transactions). This gate — like the space
        // one — runs BEFORE the phase-11 space backfill below, so a database
        // that already has `sessions` rows but no `spaces` rows reaches the
        // backfill with the session numbering already settled.
        gate(&mut conn, "sessions", "sort_order", |tx| {
            tx.execute(
                "ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            seed_session_sort_order(tx)?;
            Ok(())
        })?;
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

    /// Update a session's persisted capabilities JSON envelope (e.g. after a mid-session model switch).
    ///
    /// Updates only `capabilities_json` for the given session id; `title`, `sort_order`,
    /// `cost_usd`, and `archived` remain untouched. A missing row is a no-op; returns `Ok(())`.
    pub fn update_session_capabilities(
        &self,
        id: &str,
        capabilities_json: &str,
    ) -> Result<(), DbError> {
        self.conn.lock().expect("db mutex poisoned").execute(
            "UPDATE sessions SET capabilities_json = ?2 WHERE id = ?1",
            params![id, capabilities_json],
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

    /// Add one call's cost to the session's running figure (issue #105).
    ///
    /// NOT an upsert and NOT idempotent: this ADDS `delta` to whatever is
    /// stored, so a re-delivered frame doubles the figure. That is a property
    /// of the wire, not an oversight — `cost_update` frames carry no identity
    /// (`emit_cost_update` sends `"seq": 0`), so there is nothing to dedupe
    /// on. Bounded today by `emit_cost_update`'s production call sites
    /// (`turn.rs`'s `Usage` arm and `loop.rs`'s `run_compaction`), so a
    /// Resume cannot re-emit history; stated as a bound, not a count — a
    /// count goes stale the moment a third emitter lands (#110). Pinned by
    /// `a_replayed_cost_frame_doubles_the_stored_figure`,
    /// which must be DELETED — not adjusted — if idempotency is ever added.
    ///
    /// `NULL + x = x`: the first frame turns "never reported" into a figure.
    /// A `None` column and a stored `0.0` therefore both accumulate correctly
    /// and the distinction is only ever lost by a frame existing — which is
    /// exactly when it should be lost (D5 / ADR 0082).
    ///
    /// The read-modify-write holds the connection lock ONCE. The sibling
    /// methods lock per statement, but they are single writes; splitting this
    /// SELECT and its UPDATE across two locks would let a frame that lands in
    /// the gap be read as absent by the second read and lose its increment.
    /// The lock is released before anything is printed or returned — nothing
    /// slow (and no `eprintln!`) ever runs under it.
    ///
    /// A missing session row is a silent no-op returning `Ok(())` (the same
    /// shape `record_session_todos` has, pinned there by
    /// `record_session_todos_roundtrips_and_clears` and here by
    /// `record_session_cost_on_a_missing_row_is_a_silent_no_op`). That silence
    /// is the reason the CALLER must ensure the row first — see Trap 1: a
    /// subagent's first `cost_update` can arrive before any `StoreFrame` has
    /// created its row, so `apply_interactive_event` calls `ensure_session_row`
    /// before reaching here. Do not "fix" this into an error.
    pub fn record_session_cost(&self, id: &str, delta: f64) -> Result<(), DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        // The row's current figure. `QueryReturnedNoRows` means the session has
        // no row at all — a no-op, NOT a row we create (see the doc above).
        let stored: Option<f64> = {
            let mut stmt = guard.prepare("SELECT cost_usd FROM sessions WHERE id = ?1")?;
            match stmt.query_row(params![id], |row| row.get::<_, Option<f64>>(0)) {
                Ok(val) => val,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(()),
                Err(e) => return Err(e.into()),
            }
        };
        // The arithmetic is deliberately in RUST, not a SQL
        // `COALESCE(cost_usd, 0) + ?2`: the `NULL`-means-absence rule is the
        // whole point of the column, and `unwrap_or(0.0)` puts that rule where
        // a reader (and a test) can see it.
        let next = stored.unwrap_or(0.0) + delta;
        guard.execute(
            "UPDATE sessions SET cost_usd = ?2 WHERE id = ?1",
            params![id, next],
        )?;
        Ok(())
    }

    /// Read a session's persisted running cost (`None` when no figure is
    /// stored).
    ///
    /// `None` covers TWO cases that are indistinguishable here — "no such row"
    /// and "a row that has never had a cost frame" — and callers do not need to
    /// tell them apart: both render nothing. A `Some(0.0)` is different from
    /// both: a call reported a genuine zero (D5 / ADR 0082).
    pub fn session_cost(&self, id: &str) -> Result<Option<f64>, DbError> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT cost_usd FROM sessions WHERE id = ?1")?;
        let found = match stmt.query_row(params![id], |row| row.get::<_, Option<f64>>(0)) {
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
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM sessions WHERE id = ?1",
            SESSION_COLUMNS.join(", ")
        ))?;
        // The no-row case is matched EXPLICITLY (like `session_todos`) rather
        // than via `query_map(..).next().transpose()`: once the mapper can
        // error, a `query_map` chain makes "row present but failed to map"
        // INDISTINGUISHABLE from "no such row". `QueryReturnedNoRows` is the
        // only spelling of absence; any other error propagates.
        match stmt.query_row(params![id], session_row_from) {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
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
        // BOTH arms interpolate the SAME const list (they used to spell it
        // twice) and share ONE mapper, so the projected columns cannot differ
        // between the archived and un-archived read. The WHERE/ORDER arms stay
        // exactly as spelled today.
        let sql = if include_archived {
            format!(
                "SELECT {} FROM sessions
                 WHERE is_subagent = 0
                 ORDER BY sort_order ASC, id DESC",
                SESSION_COLUMNS.join(", ")
            )
        } else {
            format!(
                "SELECT {} FROM sessions
                 WHERE archived = 0 AND is_subagent = 0
                 ORDER BY sort_order ASC, id DESC",
                SESSION_COLUMNS.join(", ")
            )
        };
        let mut stmt = guard.prepare(&sql)?;
        let rows = stmt
            .query_map([], session_row_from)?
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
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM messages
             WHERE session_id = ?1
             ORDER BY id",
            MESSAGE_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map(params![session_id], message_row_from)?
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
            let mut stmt = guard.prepare(&format!(
                "SELECT {} FROM messages
                 WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807)
                 ORDER BY id DESC
                 LIMIT ?3",
                MESSAGE_COLUMNS.join(", ")
            ))?;
            let mut rows = stmt
                .query_map(
                    params![session_id, before_id, limit_probe],
                    message_row_from,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = rows.len() > n as usize;
            if has_more {
                rows.truncate(n as usize);
            }
            rows.reverse();
            Ok((rows, has_more))
        } else {
            let mut stmt = guard.prepare(&format!(
                "SELECT {} FROM messages
                 WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807)
                 ORDER BY id",
                MESSAGE_COLUMNS.join(", ")
            ))?;
            let rows = stmt
                .query_map(params![session_id, before_id], message_row_from)?
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
        let mut stmt = guard.prepare(&format!(
            "SELECT {} FROM spaces
             ORDER BY sort_order ASC, path ASC",
            SPACE_COLUMNS.join(", ")
        ))?;
        let rows = stmt
            .query_map([], space_row_from)?
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
    cost_usd REAL,
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
mod tests;
