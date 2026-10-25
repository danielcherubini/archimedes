# T02 — the IPC surface: `session_recency`, the two reorder commands, the TS mirror

Written by `specify` (CONSUMED MODE). Contract is the spec **as amended inline on 2026-10-24** —
recency travels as a separate `session_recency` command, NOT as a field on `SessionInfo`. The
amendment is authoritative over the earlier §Section 1 text.

**Seam (owned outright by this task):** `src-tauri/src/storage/db.rs` (one new row struct + one new
`Db` method), `src-tauri/src/storage/mod.rs` (one re-export), `src-tauri/src/commands/history.rs`,
`src-tauri/src/commands/spaces.rs`, `src-tauri/src/lib.rs` (the invoke handler), `src-tauri/tests/ipc.rs`
(one round-trip + three harness entries), `src/lib/tauri/types.ts`,
`src/lib/tauri/commands/{sessions,spaces}.ts`, `src/lib/tauri.ts` (the barrel),
`src/lib/tauriBarrel.test.ts` (the two pinned literals), `src/lib/tauri.test.ts`.

**Deviation from the status file's seam table, stated rather than silent:** that table names
`src-tauri/src/types.rs` as T02's. This plan touches `types.rs` **zero times** and puts
`SessionRecency` beside `SessionRow` / `SpaceRow` / `MessageRow` in `storage/db.rs`, because those
three are the tree's existing SELECT-ed row shapes and all three live there; `types.rs` holds
`SessionInfo` alone — the struct ADR 0064 exists to protect — and a row shape has never lived in it.
`tests/ipc.rs` is added to the seam because it is the only harness in the tree that drives a command
name through the real dispatcher, and T02 is the task that adds command names.

## Goal

Put the three DB facts T01 created behind the IPC boundary, without touching `SessionInfo`,
`SpaceRow`, `SessionRow`, `src/store/`, or any component: a `session_recency` command whose SQL
reuses the single `LAST_ACTIVITY` const (so the number a row prints and the number a recency decision
reads cannot drift), and command wrappers over T01's `Db::reorder_spaces` / `Db::reorder_sessions`.
Plus the TypeScript mirror — one wire type, three wrappers, re-exported through the barrel — so T03
can consume them without re-deriving anything.

## The fixture rule that governs EVERY test below (T01 paid for this)

`Db::record_session` and `Db::record_message` both stamp `now_ms()`. Rows written inside one test
therefore land in the same millisecond, and **recency cannot separate them at all**. A test that uses
`record_message` to make "recent" disagree with something can pass VACUOUSLY — the old expression's
own `id DESC` tie-break then produces the expected answer for the wrong reason. T01 hit exactly this
and the status file's Decisions log records it as CARRIED FORWARD TO T02.

So: **every recency fixture in this task writes its `messages` rows with raw SQL and an EXPLICIT far
future `created_at`**, the way T01's `list_sessions_ties_break_on_id_desc` and
`list_sessions_ignores_transcript_activity` ended up doing:

```rust
db.conn
    .lock()
    .expect("db mutex poisoned")
    .execute(
        "INSERT INTO messages (session_id, kind, message_key, payload_json, created_at) \
         VALUES ('s_msg_new', 'user', NULL, '{}', 9_999_999_999_999)",
        [],
    )
    .expect("fixture message row");
```

A test that cannot name the reason its fixture uses raw SQL instead of `record_message` has not
followed this rule.

## Done-when

All observable; Rust measured from `src-tauri/`, frontend from repo root.

1. `Db::session_recency()` exists and returns `Vec<SessionRecency>` where `SessionRecency` is
   `{ session_id: String, last_active_at: i64 }`, `#[serde(rename_all = "camelCase")]` — i.e.
   `{ sessionId, lastActiveAt }` over the wire. Its SQL is built by `format!` around the existing
   module-level `LAST_ACTIVITY` const; no second copy of the expression exists in `db.rs` outside
   that const and the two test literals that exist specifically to pin it.
2. The **characterisation test** `session_recency_matches_the_old_coalesce_expression` is green and
   asserts, per row, that `last_active_at` equals the value the OLD expression yields for that id,
   read by raw SQL that SPELLS the `COALESCE((SELECT MAX(m.created_at) …), sessions.created_at)`
   expression out in full in the test — it does not read `LAST_ACTIVITY`. It covers: the newest-of-two
   messages case, the MAX-not-last-inserted case, and the **no-messages case, where the entry must
   exist and equal the row's own `created_at`, never NULL/absent**.
3. `session_recency` covers **every non-subagent session, archived included**, and excludes
   `is_subagent = 1` rows. Both halves asserted; the subagent row is witnessed by raw SQL against
   `db.conn`, since `list_sessions` filters it out of every read path.
4. Three commands exist and are registered in `src-tauri/src/lib.rs`'s invoke handler:
   `session_recency` → `Vec<SessionRecency>`, `reorder_sessions(ids: Vec<String>)` → unit,
   `reorder_spaces(paths: Vec<String>)` → unit. `tests/ipc.rs`'s harness declares all three and one
   round-trip test drives all three names through the real dispatcher and gets the Ok arm back.
5. The Rust wire keys are pinned as literals: `serde_json::to_value` on a `SessionRecency` yields
   exactly `sessionId` and `lastActiveAt`. (A missing `rename_all` is invisible to every Rust
   assertion on field values and invisible to the hand-written TS mirror.)
6. `src/lib/tauri/types.ts` declares `SessionRecency { sessionId: string; lastActiveAt: number }`, and
   `@/lib/tauri` exports `sessionRecency(): Promise<SessionRecency[]>`,
   `reorderSessions(ids: string[]): Promise<void>`, `reorderSpaces(paths: string[]): Promise<void>`.
   `src/lib/tauri.test.ts` pins each command NAME and each argument KEY as a literal.
7. Both barrel guards are green AFTER their pinned literals gained the four names: `tauriBarrel.test.ts`
   (9 tests, unchanged count) and `tauriBoundary.test.ts` (7 tests, unchanged count). No file outside
   `src/lib/tauri/` imports a domain module; no production file outside the allowlist names
   `@tauri-apps/api/`.
8. **Scope proofs (all must hold, run from repo root):**
   - `grep -n "pub struct SessionInfo" -A 90 src-tauri/src/types.rs | grep -oE "pub [a-z_]+:"` names
     exactly `session_id cwd capabilities config_options archived title context_usage is_subagent` —
     unchanged, eight fields, no `last_active_at`.
   - `grep -n "pub struct SpaceRow" -A 12 src-tauri/src/storage/db.rs | grep -oE "pub [a-z_]+:"` names
     exactly `path created_at last_opened_at trusted` — unchanged.
   - `grep -n "pub struct SessionRow" -A 24 src-tauri/src/storage/db.rs | grep -oE "pub [a-z_]+:"`
     names exactly `id cwd created_at title capabilities_json archived context_usage_json is_subagent`
     — unchanged (`is_subagent` is the last field; a shorter `-A` window truncates and false-reports).
   - `grep -rn "lastActiveAt" src/` hits ONLY `src/lib/tauri/types.ts` (the new interface),
     `src/lib/tauri.test.ts` (the new fixture), and the ONE pre-existing prose line in
     `src/lib/sessionActivity.ts`'s header ("IPC has no `createdAt`/`lastActiveAt` field…") that T04
     deletes. No store or component CONSUMER exists yet, by design (T03's).
   - `git diff --name-only c503c2d..HEAD` (T02's base — the HEAD this plan was written against, the
     commit that carries the spec amendment) lists nothing under `src/store/`, `src/components/`,
     `src/hooks/`, and does not list `src/App.tsx`, `src/lib/sessionActivity.ts`, or
     `src-tauri/src/types.rs`.
   - `grep -rn "sort_order\|sortOrder" src/` still returns **zero** hits (the column never reaches the
     frontend).
9. `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` green from
   `src-tauri/`; `pnpm test`, `pnpm build` green from repo root.

Counts are DELTAS, never baselines — re-measure at your own HEAD. Measured at `c503c2d`:
`cargo test` 1455 passed / 0 failed / 4 ignored · clippy 0 warnings · fmt clean · `pnpm test`
3063 passed / 149 files · `pnpm build` green (pre-existing chunk-size warning). This plan intends
`cargo test` **+7** (3 + 3 + 1) and `pnpm test` **+3**.

---

## Conventions this plan inherits (do not re-litigate)

- **TDD is a repo convention.** Every task writes its failing test first and names the command that
  proves it red.
- **`archimedes` is ONE compilation unit** (AGENTS.md). In this repo a Rust "red" that references a
  not-yet-existing symbol is a **whole-binary compile error**, not a scoped failure: while it stands,
  **no gate can be claimed green OR red**, and no count from it means anything. That is the recorded
  T01 lesson and it applies to Task 1 and Task 2 here — their red IS `error[E0599]: no method named
  'session_recency' found for struct 'Db'` / `cannot find function 'session_recency_rows' in this
  scope`, and that is a legitimate red, but it is a compile red and must be reported as one. The
  frontend reds in Task 3 are NOT like this: a missing named export reddens one vitest file, so a
  scoped `npx vitest run <file>` is a real, isolated red there.
- Scoped cargo syntax is `cargo test --lib -- <filter> [<filter>…]`. Filters after `--` are OR'd — a
  UNION, not a subset. `cargo test --lib storage::db session_recency` is a cargo CLI error.
- **Scoped vitest is `npx vitest run <path>…`, NOT `pnpm test -- <path>`.** Measured: the `pnpm` form
  ignores the filter and runs all 149 files.
- `db.rs` lock sites use `.expect("db mutex poisoned")`, never `unwrap()`. In-file `db.rs` tests build
  their own dir (`std::env::temp_dir().join(format!("db-<name>-test-{}", uuid::Uuid::new_v4()))` +
  `create_dir_all`) and end with `let _ = std::fs::remove_dir_all(&dir);` on the success path only.
- A `Db` method that reads returns `Result<_, DbError>` and borrows `self`; a command wrapper maps the
  error to whatever its own file already uses. Do not invent a third error convention.
- A Db-backed command that needs a unit test gets a `pub(crate)` inner fn taking `&Db` and returning
  `DbError`, with the `#[tauri::command]` wrapper as a two-line delegation. Precedent in the very file
  this adds to: `history.rs`'s `pub(crate) fn history_page(db: &Db, …) -> Result<HistoryPage, DbError>`
  + `load_history` doing `.map_err(|e| e.to_string())`. `State<'_, Arc<Db>>` is not constructible in a
  unit test, which is why the seam exists.

---

## Task 1 — `SessionRecency` + `Db::session_recency`, characterisation test first

**Files owned:** `src-tauri/src/storage/db.rs` (one new struct above `Db`, one new `impl Db` method,
three new tests in the `#[cfg(test)] mod tests`) and `src-tauri/src/storage/mod.rs` (add
`SessionRecency` to the existing `pub use db::{…}` line). Nothing else.

**Write the failing tests FIRST**, in this order, all in `db.rs::tests`:

1. **`session_recency_matches_the_old_coalesce_expression` — THE CHARACTERISATION TEST, written
   before anything else, and the reason Task 1 exists.** Four sessions via
   `record_session(&title_session(id))`: `s_msg_new`, `s_msg_old`, `s_no_messages`, `s_archived`.
   Fixture messages, raw SQL + explicit far-future stamps (see the fixture rule):
   - `s_msg_new` → one row `created_at = 9_999_999_999_999`;
   - `s_msg_old` → TWO rows, inserted **smaller-last**: `created_at = 9_000_000_000_000` then
     `created_at = 1_600_000_000_000`. Inserting the smaller one LAST is the point — an
     implementation that read "the last message by id" instead of `MAX()` answers `1_600_000_000_000`
     here and `9_000_000_000_000` for the real expression, so the test cannot pass by accident.
   - `s_no_messages` → nothing.
   - `s_archived` → `set_session_archived("s_archived", true)`, no messages.

   Then, for each of the four ids, assert
   `db.session_recency()?`'s entry for that id equals the value the OLD expression yields, read by
   raw SQL that **spells the expression out** rather than interpolating the const:

   ```rust
   let old_key: i64 = db
       .conn
       .lock()
       .expect("db mutex poisoned")
       .query_row(
           "SELECT COALESCE((SELECT MAX(m.created_at) FROM messages m \
             WHERE m.session_id = sessions.id), sessions.created_at) \
            FROM sessions WHERE id = ?1",
           [id],
           |r| r.get(0),
       )
       .expect("the old recency expression must resolve for a stored id");
   ```

   Four assertions (`s_msg_new`, `s_msg_old`, `s_no_messages`, `s_archived`), each comparing the
   struct's `last_active_at` against that `old_key`. The `s_no_messages` case additionally asserts the
   entry is PRESENT in the returned Vec at all, and equals `SELECT created_at FROM sessions WHERE
   id = 's_no_messages'` read separately — that is the fallback the `COALESCE` exists for, and it is
   the case the old `RECENT_FIRST` doc explains: `MAX()` over no rows is NULL and SQLite sorts NULL
   LAST in a `DESC` list, which would bury the newest session on the list.
   Assert `s_archived` is returned at all — the Archived section sorts by recency, so an archived
   session without a recency entry is the bug this task must not ship.

   **Why the literal and not the const:** recomputing the expectation from the file under test makes
   the pin green on any change to that file. Same reasoning `tauriBarrel.test.ts` gives for its
   literal pinned list, and the same reasoning T01's own tie-break test gives for its explicit
   timestamp.

2. **`the_last_activity_const_matches_the_expression_the_row_prints`** — the drift guard, and the
   cheap half of the characterisation:
   `assert_eq!(LAST_ACTIVITY, "COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = sessions.id), sessions.created_at")`,
   the right-hand side a literal typed in the test. This reddens the moment anyone edits the const, so
   the characterisation above has to be re-decided rather than silently drifting. (A third
   whitespace-normalising comparison would be weaker: the const carries `\`-continuations, so the
   literal must be the ONE-LINE spelling, and the assertion documents that the const's line-continuation
   form and this one-line form are the same expression.)

3. **`session_recency_covers_archived_and_excludes_subagent_rows`** — one main session, one archived
   main session, one `is_subagent: true` session (a full `SessionInfo` struct literal — copy the shape
   from `list_sessions_hides_subagent_rows_but_their_transcripts_load`). Assert the returned ids are
   exactly the two visible ones (no third entry), and — the only witness that exists, since
   `list_sessions` filters hidden rows out of every read path — that the subagent row is still present
   in the table: `SELECT COUNT(*) FROM sessions WHERE id = 'sub-1'` == 1, read through
   `db.conn.lock().expect("db mutex poisoned")`.

**Red:** `cd src-tauri && cargo test --lib -- session_recency` → a compile error
(`no method named 'session_recency' found for struct 'Db'`, plus `cannot find type 'SessionRecency'`).
**In that state no gate can be quoted at all** — not this one, not `cargo clippy`, not `cargo fmt`
against the lib target. Report the compile failure as the red it is.

**Implementation:**

```rust
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
}
```

and, in `impl Db`, next to `list_sessions`:

```rust
pub fn session_recency(&self) -> Result<Vec<SessionRecency>, DbError> {
    let guard = self.conn.lock().expect("db mutex poisoned");
    let mut stmt = guard.prepare(&format!(
        "SELECT id, {LAST_ACTIVITY} FROM sessions WHERE is_subagent = 0 ORDER BY id"
    ))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SessionRecency {
                session_id: row.get(0)?,
                last_active_at: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

Doc comment on it must say, in prose: the SQL is the same `LAST_ACTIVITY` const the upgrade seed
reads with, so the number a row prints and the number a recency decision reads cannot drift; the
filter is `is_subagent = 0` with **no `archived` filter**, matching `list_sessions(true)` exactly, so
the recency map's key set equals the boot session list's key set; and the `ORDER BY id` is arbitrary
but stable — consumers key by id, the order is not a contract, it is pinned only so the Vec is
deterministic. Interpolating the const with `format!` is how `seed_session_sort_order` already builds
its statement, so the reuse is literal, not aspirational.

Add `SessionRecency` to `pub use db::{…}` in `src-tauri/src/storage/mod.rs`.

**Green:** `cargo test --lib -- session_recency` (3 pass) → `cargo test --lib -- storage::db`
(38 → 41) → `cargo fmt --check` → `cargo clippy --all-targets` (0 warnings).

**Commit:** `feat(storage): add Db::session_recency over the single LAST_ACTIVITY expression`

---

## Task 2 — the three commands, registered

**Files owned:** `src-tauri/src/commands/history.rs` (`session_recency` + `reorder_sessions` + their
`pub(crate)` inner fns + tests + one line in the module header's list of what the frontend calls),
`src-tauri/src/commands/spaces.rs` (`reorder_spaces` + inner fn + test), `src-tauri/src/lib.rs` (the
invoke handler), `src-tauri/tests/ipc.rs` (three harness entries + one round-trip test).

**Write the failing tests FIRST:**

1. `commands/history.rs::tests` → **`session_recency_rows_serializes_to_the_pinned_camel_case_keys`**.
   Real `Db` via the file's own existing idiom (`std::env::temp_dir().join(format!("history-recency-test-{}",
   uuid::Uuid::new_v4()))` + `create_dir_all` + `remove_dir_all` on the success path — copy the shape of
   `history_page_todos_first_page_and_subsequent_pages` in this same file, do not import `tempfile`
   here). Record two sessions, write one far-future raw-SQL message for one of them, then
   `serde_json::to_value(session_recency_rows(&db)?)` and assert each element's `as_object().unwrap()`
   has exactly the keys `sessionId` and `lastActiveAt` (a sorted `Vec` of key names compared against a
   literal — the `commands/agents.rs` `as_object()` idiom), and that `lastActiveAt` is the number the
   fixture wrote, not a `now_ms()` value. The keys are the load-bearing half: a dropped
   `rename_all` changes no field VALUE and so passes every value assertion on both sides of the wire.
2. `commands/history.rs::tests` → **`reorder_session_rows_writes_the_slice_in_given_order`**. Three
   recorded sessions; call `reorder_session_rows(&db, &["s_c", "s_a", "s_b"].map(String::from))` (or
   the `Vec<String>` form), then assert `db.list_sessions(false)` ids == `["s_c", "s_a", "s_b"]`. It
   also proves the `Vec<String> → &[String]` deref the wrapper needs.
3. `commands/spaces.rs::tests` → **`reorder_space_rows_writes_the_slice_in_given_order`**. Same shape
   over `upsert_space` + `list_spaces`, using the file's existing `tempfile::tempdir()` +
   `Db::open(&dir.path().join("test.db"))` idiom, and creating the folders with `create_dir_all`
   because `space_key` canonicalizes.
4. `src-tauri/tests/ipc.rs` → **`the_list_order_commands_resolve_through_the_real_ipc_surface`**: add
   `archimedes_lib::commands::history::session_recency`,
   `archimedes_lib::commands::history::reorder_sessions`, and
   `archimedes_lib::commands::spaces::reorder_spaces` to the harness's own `generate_handler!` list,
   then in one `#[tokio::test]` drive all three through `invoke_ok`:
   `session_recency` with `json!({})` → `Value::Array(empty)` on a fresh DB;
   `reorder_sessions` with `json!({"ids": []})` → `Value::Null`;
   `reorder_spaces` with `json!({"paths": []})` → `Value::Null`. An unregistered name or an unmanaged
   `Arc<Db>` is the Err arm, which `invoke_ok` fails on with the payload in the message. Empty
   argument lists are deliberate: they are the idempotent no-ops, so the test proves name resolution +
   managed state without touching anyone's real data.

**Red:** `cargo test --lib -- session_recency_rows reorder_session_rows reorder_space_rows` → a
compile error (the inner fns do not exist). `cargo test --test ipc` likewise. **In that state no gate
is claimable in either direction** — see the compilation-unit note.

**Implementation** — three commands, all `State<'_, Arc<Db>>` (pure DB operations: no
SessionManager, no WorkerManager), each a two-line wrapper over a `pub(crate)` inner fn.

`commands/history.rs`:

```rust
/// Every non-subagent session's recency as an explicit FIELD (ADR 0075).
#[tauri::command]
pub async fn session_recency(
    state: State<'_, Arc<Db>>,
) -> Result<Vec<SessionRecency>, String> {
    session_recency_rows(&state).map_err(|e| e.to_string())
}

pub(crate) fn session_recency_rows(db: &Db) -> Result<Vec<SessionRecency>, DbError> {
    db.session_recency()
}

/// Rewrite the manual order of the given session ids in ONE transaction.
/// Only a drag calls this (ADR 0075); the ids are the visible slice of ONE Space.
#[tauri::command]
pub async fn reorder_sessions(
    state: State<'_, Arc<Db>>,
    ids: Vec<String>,
) -> Result<(), String> {
    reorder_session_rows(&state, &ids).map_err(|e| e.to_string())
}

pub(crate) fn reorder_session_rows(db: &Db, ids: &[String]) -> Result<(), DbError> {
    db.reorder_sessions(ids)
}
```

`commands/spaces.rs`:

```rust
/// Rewrite the manual order of the spaces in ONE transaction (only a drag calls this).
#[tauri::command]
pub async fn reorder_spaces(
    state: State<'_, Arc<Db>>,
    paths: Vec<String>,
) -> Result<(), SpacesError> {
    reorder_space_rows(&state, &paths).map_err(|e| SpacesError::Database(e.to_string()))
}

pub(crate) fn reorder_space_rows(db: &Db, paths: &[String]) -> Result<(), DbError> {
    db.reorder_spaces(paths)
}
```

Two import lines change with them, and only those: `history.rs`'s existing
`use crate::storage::{Db, DbError, MessageRow};` gains `SessionRecency`, and `spaces.rs`'s existing
`use crate::storage::Db;` gains `DbError`. Both files already import `State`, `Arc`, and their own
error type — nothing else is added.

`reorder_spaces` takes `paths`, not `ids`, and the TS mirror passes `{ paths }`: the `spaces` table is
keyed by the canonical path (`space_key`), and T01's `Db::reorder_spaces` writes by that key RAW — no
re-canonicalizing at the command layer, because a partial renumber (a folder that vanished mid-drag)
is the worst outcome and the ids arriving from `list_spaces` are already the stored key.

Registration — the three names join the invoke handler in `src-tauri/src/lib.rs`, next to their
siblings: `commands::history::session_recency` and `commands::history::reorder_sessions` after
`commands::history::set_session_archived`; `commands::spaces::reorder_spaces` after
`commands::spaces::set_space_trusted`.

**Green:** `cargo test --lib -- commands::history` (1 → 3) · `cargo test --lib -- commands::spaces`
(3 → 4) · `cargo test --test ipc` (8 → 9) · `cargo fmt --check` ·
`cargo clippy --all-targets` (0 warnings).

**Commit:** `feat(ipc): expose session_recency, reorder_sessions and reorder_spaces as commands`

---

## Task 3 — the TypeScript mirror, through the barrel (ADR 0074)

**Files owned:** `src/lib/tauri/types.ts`, `src/lib/tauri/commands/sessions.ts`,
`src/lib/tauri/commands/spaces.ts`, `src/lib/tauri.ts`, `src/lib/tauriBarrel.test.ts` (the two pinned
literals only), `src/lib/tauri.test.ts`.

**Why the wrappers must live in the domain modules and be re-exported, and may not be a hand-rolled
`invoke()` anywhere else:** `src/lib/tauri.ts` is a pure re-export barrel and it IS the mock seam — a
large set of test files `vi.mock("@/lib/tauri")` **by module path**, and `vi.mock` intercepts only
calls travelling through that path. A hand-rolled `invoke("reorder_sessions", …)` in a component keeps
the entire suite green while silently bypassing every mock. `tauriBarrel.test.ts` (incoming edges) and
`tauriBoundary.test.ts` (outgoing edges) exist to catch exactly that, mechanically.

**Write the failing tests FIRST** — `src/lib/tauri.test.ts`, three new `describe` blocks in the file's
existing shape (it already mocks `@tauri-apps/api/core` and pins the command NAME and the argument KEY
as literals, on the reasoning that a drift there passes every test on both sides and fails only at
runtime in the desktop app):

1. `describe("sessionRecency (the ADR 0075 recency IPC boundary)")` →
   `it("invokes \`session_recency\` with no payload")` —
   `expect(mockedInvoke).toHaveBeenCalledWith("session_recency")` and the rows come back UNCHANGED
   (`resolves.toEqual(payload)` on a `[{ sessionId: "s1", lastActiveAt: 9_999_999_999_999 }]` fixture —
   the far-future stamp, per the fixture rule, so a mocked payload cannot accidentally look like a
   `now_ms()` value).
2. `describe("reorderSessions (the sidebar drag write path, ADR 0075)")` →
   `it("invokes \`reorder_sessions\` with the \`ids\` argument key")` —
   `toHaveBeenCalledWith("reorder_sessions", { ids: ["s2", "s1", "s3"] })`, the order asserted as
   given (the whole visible slice, in order — a wrapper that sorted or deduped would silently corrupt
   the drag).
3. `describe("reorderSpaces (the tab-strip drag write path, ADR 0075)")` →
   `it("invokes \`reorder_spaces\` with the \`paths\` argument key")` —
   `toHaveBeenCalledWith("reorder_spaces", { paths: ["/b", "/a"] })`.

**Red (scoped, real):** `npx vitest run src/lib/tauri.test.ts` → the file fails to load, the module
does not provide the named export. Unlike the Rust tasks this red is isolated to one file and the rest
of the suite stays green, so a count IS quotable here.

**Implementation:**

`src/lib/tauri/types.ts` — one new interface, next to `SpaceRow` / `SpaceCheck`:

```ts
/** One session's recency, decoupled from its list position (ADR 0075). camelCase over IPC. */
export interface SessionRecency {
  sessionId: string;
  /** Unix ms — the newest transcript stamp, or the row's own `created_at` when it has no messages. Never null. */
  lastActiveAt: number;
}
```

`src/lib/tauri/commands/sessions.ts` — beside the other history reads, matching the file's one-line
`invoke` shape verbatim (and `SessionRecency` joins the file's existing `import type { … } from
"../types"` block, which already lists `HistoryPage`, `SessionConfigOption`, `SessionInfo`, `StopReason`):

```ts
/** Every non-subagent session's recency as a FIELD (ADR 0075: position is not evidence, so anything that wants recency has to ask). Archived rows included, subagent rows not. */
export async function sessionRecency(): Promise<SessionRecency[]> {
  return invoke<SessionRecency[]>("session_recency");
}

/** Rewrite the manual order of the given session ids in one transaction — the sidebar's whole visible slice of ONE Space, in its new order. Only a drag calls this. */
export async function reorderSessions(ids: string[]): Promise<void> {
  return invoke("reorder_sessions", { ids });
}
```

`src/lib/tauri/commands/spaces.ts`:

```ts
/** Rewrite the manual order of the spaces in one transaction — the whole tab strip, in its new order. Keyed by the canonical path. */
export async function reorderSpaces(paths: string[]): Promise<void> {
  return invoke("reorder_spaces", { paths });
}
```

`src/lib/tauri.ts` — `SessionRecency` joins the `export type { … } from "./tauri/types"` block;
`sessionRecency` and `reorderSessions` join the `export { … } from "./tauri/commands/sessions"` block;
`reorderSpaces` joins the `export { … } from "./tauri/commands/spaces"` block. Nothing else in the
barrel changes: it stays a pure re-export surface (no `invoke`, no `import`, no `export *`).

**Then** `npx vitest run src/lib/tauriBarrel.test.ts` goes RED — and that red is the guard doing its
documented job ("a name may only enter or leave this list on purpose, in a commit that says so").
Update the two pinned literals in that file: `SessionRecency` into `TAURI_PUBLIC_API`, and
`reorderSessions` / `reorderSpaces` / `sessionRecency` into `TAURI_RUNTIME_API`. **Read the assertion
and add the names in that file's alphabetical order; do not copy a count into a comment.** Adding
names to the barrel is expected and correct; a forgotten re-export is what those literals exist to
catch.

**Also in this commit — the two stale order comments T01 stranded on the functions this task edits.**
`listSpaces`'s doc still reads "All spaces, most recently opened first" and `listSessions`'s still
reads "All stored sessions, newest first". Both became FALSE in T01's `ORDER BY` swap and have been
lying across a whole task boundary. Rewrite both to name `sort_order` / manual order and point at ADR
0075 (matching the Rust command docs T01 already fixed). This is a two-line, comment-only edit inside
two files this task already edits; the store-level stale comments T01 recorded as exemptions
(`src/store/sessions.ts`, `src/components/SpacesList.tsx`) stay untouched — those are T03's and T04's
files by name.

**Green:** `npx vitest run src/lib/tauri.test.ts src/lib/tauriBarrel.test.ts src/lib/tauriBoundary.test.ts`
→ 26 + 9 + 7 (from 23 + 9 + 7), and `pnpm build` (the `tsc` half is what proves the new interface
compiles).

**Commit:** `feat(ipc): mirror session_recency and the reorder commands in the tauri barrel`

---

## Decisions this plan makes

- **`session_recency` lives in `commands/history.rs`.** It needs only `Arc<Db>`, and three of that
  file's four commands (`load_history`, `set_session_archived`, `delete_session`) are already pure
  `Arc<Db>` operations — `list_sessions` goes through the SessionManager solely for the model catalog,
  which recency has no use for. Session-domain read, Db-backed shape, existing file.
- **Subagent rows are EXCLUDED** (`WHERE is_subagent = 0`). They are hidden from every list, including
  the Archived section (`list_sessions` filters in both arms), so shipping their recency is dead bytes
  the store would key by; and the filter makes the recency map's key set EQUAL `list_sessions(true)`'s
  key set, so T03 can never meet a session with no recency entry or a recency entry with no session.
- **`SessionRecency` lives in `storage/db.rs`, not `types.rs`** (deviating from the status file's seam
  table, stated above): it is a SELECT-ed row shape, and all three existing ones are there; `types.rs`
  holds only the ADR-0064-protected `SessionInfo`, which this task must not touch at all.
- **`ORDER BY id` on `session_recency`.** The order is not a contract (consumers key by id), but a
  `Vec` with no `ORDER BY` is a nondeterministic test fixture; `id` is the primary key, so the sort is
  free.
- **Error types follow the file, not a new convention:** `String` via `.map_err(|e| e.to_string())` in
  `history.rs` (its existing three Db commands all do that), `SpacesError::Database` in `spaces.rs`
  (its existing two do that). Inventing one shared error for three commands would churn both files.
- **`pub(crate)` inner fns + thin command wrappers.** `State<'_, Arc<Db>>` cannot be built in a unit
  test; `history_page` and `resolve_space_for_path` already established this exact seam, one in each
  of the two files being edited.
- **One `tests/ipc.rs` round-trip for all three names, not three tests.** What it proves is name
  resolution + managed-state wiring, which is per-name, not per-interaction; three mock apps buy no
  extra signal. Empty argument lists keep it a no-op.
- **The characterisation test spells the old SQL as a literal and does not read `LAST_ACTIVITY`.**
  Deriving the expectation from the const under test makes the pin green on any edit to that const.
  Test #2 then pins the const itself, so an edit forces a decision instead of a silent drift.
- **T02 fixes the two stale frontend order comments** (`listSpaces`, `listSessions`) because both sit
  on functions this task's files contain and both have been false since T01; the store/component stale
  comments stay with T03/T04, whose FILES are named in T01's recorded exemption.
- **The spec's `#[serde(default)]` note is dropped as moot.** It belonged to the abandoned
  "field on `SessionInfo`" shape (it was there to keep rows predating the field parsing). A brand-new
  command's response always carries both keys, and `last_active_at` cannot be NULL because the
  `COALESCE` guarantees a number — a `default` would only hide a real failure.
- **`tauriBarrel.test.ts`'s header prose is NOT corrected.** It says "107 names: 58 types + 49
  functions" while the literal measures 108 (59 + 49) at this HEAD — a stale prose count that predates
  T02. Left alone: the file's own stated discipline is that counts live in the assertion and nowhere
  else, and "fixing" it would re-inscribe the number the file deliberately refuses to carry. Recorded
  under Known limits instead.

## Out of scope

- **`src/store/sessions.ts` and everything under `src/store/` — T03 owns it.** T02 ships the COMMAND
  and the TS WRAPPER only. The `Record<string, number>` side-channel in the store (the
  `closeReasons: Record<string, CloseReasonStr>` shape — declared in the state interface, initialised
  to `{}`, written per-session by id) and the boot `Promise.all` wiring are T03's. T01's plan already
  named the store's stale ordering note as T03's to rewrite; T02 does not touch it.
- **`src/components/SpacesList.tsx`, `SessionListRow.tsx` — T04 and T06.** `SpaceTabs.tsx` — T07.
  `src/lib/sessionActivity.ts` — T04 deletes it. `src/App.tsx` — T03 (it owns the boot fetch). No
  component imports the new wrappers in this task.
- **No drag UI, no `useDragReorder`, no optimistic store write, no refetch-on-rejection** — T05 owns
  the gesture and the store's reorder actions; T06/T07 wire them to rows and tabs. T02's reorder
  wrappers have no caller until T05, which is intentional and is the reason Done-when #8's
  `grep -rn "lastActiveAt" src/` proof must show hits only in the two new IPC files plus the one
  stale prose line T04 deletes.
- **No field added to `SessionInfo`, `SpaceRow`, or `SessionRow`.** That is the amendment's whole
  point, and Done-when #8 measures all three field lists.
- **The Archived section's explicit recency sort, and `recencyOf`** — T03 (ADR 0075 flags the Archived
  free-ride as the trap; it needs the recency map T03 wires, not a command T02 already provides).
- **No `sort_order` reaches the frontend**, in any shape, in this task.
- **`docs/features/manual-list-order.md`** — T08.

### The contract T03 consumes (do not re-derive it)

All three arrive through `@/lib/tauri` and nothing else:

```ts
sessionRecency(): Promise<SessionRecency[]>          // argumentless
reorderSessions(ids: string[]): Promise<void>        // the whole visible slice of ONE Space, in order
reorderSpaces(paths: string[]): Promise<void>        // the whole tab strip, in order, canonical paths
interface SessionRecency { sessionId: string; lastActiveAt: number }
```

T03's job is to turn `sessionRecency()`'s array into the store's `Record<string, number>` and to add
the fetch to the existing boot `Promise.all` in `src/App.tsx`, which currently reads:

```tsx
    Promise.all([listSessions(true), listSpaces()])
      .then(([rows, spaces]) => {
        useSessions.getState().setHistorySessions(rows);
        useSessions.getState().setSpaces(spaces);
      })
      .catch((err) =>
        console.error("failed to load stored sessions/spaces", err),
      );
```

That is the contract site: one more entry in the `Promise.all`, one more destructured element, one more
`set…`. `session_recency` runs once per boot alongside the other two, so the same staleness rule
already documented on `list_sessions`'s doc comment applies — the per-message `MAX()` subquery rides
`idx_messages_session` and this is not a per-token path.

## Verification

From `src-tauri/`, after each task and in full at the end:

    cargo test --lib -- session_recency reorder_session_rows reorder_space_rows   # the new scoped set
    cargo test --lib -- storage::db        # 38 → 41
    cargo test --lib -- commands::history  # 1 → 3
    cargo test --lib -- commands::spaces   # 3 → 4
    cargo test --test ipc                  # 8 → 9
    cargo test                             # 1455 → 1462 (intended delta, not a baseline)
    cargo clippy --all-targets             # must be 0 warnings — clean at HEAD, so any warning is ours
    cargo fmt --check

From repo root:

    npx vitest run src/lib/tauri.test.ts src/lib/tauriBarrel.test.ts src/lib/tauriBoundary.test.ts
                                           # 23 + 9 + 7 → 26 + 9 + 7. Use `npx vitest run <paths>`;
                                           # `pnpm test -- <path>` does NOT scope — measured.
    pnpm test                              # 3063 → 3066, 149 files
    pnpm build

Registration proof (the tree's own method — `tests/ipc.rs` states that its harness declares its OWN
handler list and therefore cannot prove `lib.rs` lists the commands, so the real list is read):

    grep -n "generate_handler" src-tauri/src/lib.rs            # exactly two hits: one prose mention
                                                               # in the updater-plugin comment, one call
    grep -n "commands::history::session_recency\|commands::history::reorder_sessions\|commands::spaces::reorder_spaces" src-tauri/src/lib.rs
                                                               # three hits, inside the handler block

Scope proofs (repo root): the six bullets of Done-when #8, verbatim, plus
`git diff --name-only c503c2d..HEAD` (re-run against your own base if the plan commit lands first —
the point is "nothing outside the seam list at the top of this plan", not that literal hash).

## Known limits this plan accepts

- **`tests/ipc.rs` is `#![cfg(target_os = "linux")]`** (the unfixed macOS mock-runtime `SIGSEGV`,
  documented in that file's header). So Task 2's round-trip does not run on the macOS or Windows CI
  legs, and on those platforms the registration proof is the `grep` above plus the read of the handler
  list. Never describe the Windows/macOS IPC path as behaviourally verified from this.
- **Between Task 2's commit and T03, the three commands are registered, tested and unused.** No
  frontend call site exists until T03 (recency) and T05 (reorder). That is one task boundary of
  dead-but-covered surface, and it is the price of the amended design: the alternative — a
  `SessionInfo` field — breaks dozens of struct literals at compile time, which is the door the spec's
  amendment closed.
- **The TS mirror is compile-time only.** `interface SessionRecency` is erased at runtime, so nothing
  checks that the Rust keys and the TS keys agree; what checks it is the Rust-side
  `serde_json::to_value` key assertion plus `tauri.test.ts`'s pass-through. A rename on one side and
  the same rename in the mirror would stay green — the same class of gap the `tauri.test.ts` header
  documents for every other command name, and the reason the NAME and the KEY are pinned as literals.
- **`tauriBarrel.test.ts`'s prose count is stale at HEAD** ("107 names: 58 types + 49 functions" vs a
  literal measuring 108). Deliberately not fixed — see the Decisions section.
- **`reorder_sessions`'s global-numbering collision behaviour is unchanged and not re-tested here.**
  T01 owns it and pinned it (`reorder_sessions_is_per_space_even_when_numbers_collide_across_spaces`);
  the command is a pure delegation, so the command layer cannot make it better or worse.
- **The command layer does not validate the id/path list.** An unknown id is a 0-row `UPDATE`, i.e. a
  no-op, exactly as T01 defined it (`reorder_spaces_with_an_unknown_path_is_not_an_error`), and a
  partial list renumbers only what it names. Validating "the whole visible slice arrived" would need
  the command to know what a Space is, which is a store question, not a storage one.
- **`session_recency` has no `archived` filter and no pagination.** It ships one row per non-subagent
  session on every boot, which is the same row count the boot `list_sessions(true)` already fetches;
  if history ever grows enough for that to matter, both queries need the same conversation, not just
  this one.
