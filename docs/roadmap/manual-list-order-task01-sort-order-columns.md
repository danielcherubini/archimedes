# T01 — `sort_order` columns on `spaces` and `sessions`

Written by `specify` (CONSUMED MODE) for Wave 1 of `docs/roadmap/manual-list-order.md`.
Seam: `src-tauri/src/storage/db.rs` (owned outright) + `src-tauri/tests/storage.rs`, plus three
comment-only doc lines outside `db.rs` that the `ORDER BY` swap makes false (Task 3): two in the Rust
command layer (`src-tauri/src/commands/spaces.rs`, `src-tauri/src/commands/history.rs`) and one on the
`list_sessions`-shaped helper in `src-tauri/src/agent/session/mod.rs` — plus two bullets appended to
the existing ADR 0075 (Task 2). Nothing under `src/`: the frontend sites the swap strands are named
and deferred in §Out of scope.

## Goal

Give both `spaces` and `sessions` a `sort_order INTEGER NOT NULL DEFAULT 0` column that is
seeded `0..n` in *today's* order on upgrade, grows at the bottom on insert, is the sole sort key
of `Db::list_spaces` / `Db::list_sessions`, and is rewritable in one transaction by the new
`Db::reorder_spaces` / `Db::reorder_sessions` — with no IPC, no row-struct, and no frontend change.

## Done-when

All of these are observable, and all are measured from `src-tauri/`:

1. `cargo test --lib -- storage::db` and `cargo test --test storage` are green, and within them:
   - a pre-existing DB whose rows were inserted in recency order comes back from `Db::open` with
     `sort_order` values `0..n-1` in exactly that order (spaces by `last_opened_at DESC, path ASC`;
     sessions by the last-activity expression then `id DESC`), and a **re-open does not re-seed**
     (a sentinel written after the first open survives the second);
   - every seeded row value is **distinct** — including hidden `is_subagent = 1` rows, which are
     seeded too;
   - `Db::upsert_space`, `Db::record_session` and the phase-11 space-backfill INSERT each put a
     NEW row at `MAX + 1`, and a **re-upsert / re-record never renumbers** an existing row;
   - `Db::list_spaces` / `Db::list_sessions` return the `sort_order` order even when it
     **contradicts** recency (a session with a fresh transcript sits where its number says);
   - `Db::reorder_spaces` / `Db::reorder_sessions` persist a whole slice in one call and the new
     order survives a close + re-open, and a `reorder_sessions` that renumbers ONE Space's slice
     leaves every other Space reading in its own order even where the numbers now collide.
2. `grep -rn "sort_order" src/` (repo root) returns **zero** hits, and `SpaceRow` / `SessionRow`
   have the same field lists they had before this branch — i.e. no new IPC key.
3. `cargo test --lib`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` green from
   `src-tauri/`; `pnpm test`, `pnpm build` green from repo root (untouched by this task).
4. No doc comment or assert message in a `.rs` file under `src-tauri/` still claims `list_spaces` is
   "most recently opened first" or `list_sessions` is "MOST RECENTLY ACTIVE FIRST" (the proof below
   greps the whole `src-tauri/` tree, so it covers the two literal strings sitting in
   `tests/storage.rs`'s asserts as well as the doc comments).

Re-measure every count at your own HEAD. The numbers below are the delta this plan intends, not a
baseline to assert.

---

## Conventions this plan inherits (do not re-litigate)

- TDD is a repo convention: write the failing test, run it, **see it fail for the stated reason**,
  then implement. Every task below has an explicit red command.
- Every lock site in `db.rs` uses `.expect("db mutex poisoned")` — never `unwrap()`.
- `Db::open` holds an OWNED `Connection`, so its migrations use
  `conn.unchecked_transaction()?`. A `&self` method holds a `StdMutex` guard, so it uses
  `let mut guard = …` + `guard.transaction()?` — `mut` is mandatory (`transaction` takes
  `&mut self`; `let guard` is a compile error). Precedent: `Db::replace_native_messages`.
- A migration helper is a FREE fn `fn seed_*(conn: &Connection) -> Result<(), DbError>` defined
  BELOW the `impl Db` block just above `SCHEMA`, with a `/// One-time …` doc comment, handed
  `&tx` (a `rusqlite::Transaction` derefs to `Connection`). Precedent: `backfill_session_todos`.
- A live `Statement` borrows the connection immutably, so `prepare`/`execute` on the same conn after
  it will still compile and run — dropping it is HYGIENE, not a compile or SQLite requirement: it
  keeps the read cursor closed before the writes start, which is what the existing
  `backfill_session_todos` does with `drop(session_stmt)`. Follow that precedent; do not claim the
  code would break without it.
- In-file tests build their own temp dir (`std::env::temp_dir().join(format!("db-<name>-test-{}",
  uuid::Uuid::new_v4()))`) and end with `let _ = std::fs::remove_dir_all(&dir);` on the success
  path only. `tests/storage.rs` uses `temp_db_path()` (the DB FILE) and
  `let _ = std::fs::remove_file(&path);`.
- Tests that exercise `upsert_space` / `reorder_spaces` with real paths must create the folders
  (`std::fs::create_dir_all`) — `space_key` canonicalizes, and a nonexistent path silently falls
  back to the raw string.

---

## Task 1 — the columns, the two seed migrations, and the `LAST_ACTIVITY` const

**Files owned:** `src-tauri/src/storage/db.rs` (`SCHEMA`, `Db::open`, two new free fns, one new
module-level const) and the `#[cfg(test)] mod tests` at the bottom of that file. Nothing else.

**Write the failing tests FIRST** (all in `db.rs::tests`):

1. `sort_order_columns_exist_on_a_fresh_database` — after `Db::open` on an empty dir, assert
   `SELECT COUNT(*) FROM pragma_table_info('spaces') WHERE name = 'sort_order'` == 1 and the same
   for `'sessions'`. Read through `db.conn.lock().expect("db mutex poisoned").query_row(…)` — the
   in-file idiom used by `archived_column_migration_on_a_preexisting_db`.
2. `sort_order_seeded_in_the_old_space_order_on_a_preexisting_db` — build the OLD schema with a raw
   `Connection::open` + `execute_batch` (the fixture is today's `SCHEMA` text with the
   `sort_order` column removed from both tables — i.e. exactly what a pre-T01 DB looks like,
   `native_messages` FK included so phase 10 stays quiet), `drop(conn)`, then `Db::open`. Insert
   three `spaces` rows: `('/x/b', created 1, opened 3000)`, `('/x/a', 1, 2000)`,
   `('/x/c', 1, 2000)`. **Insert no `sessions` rows** (or only cwds that do not exist on disk) so
   the phase-11 space backfill cannot add rows and pollute the assertion. Assert
   `SELECT path FROM spaces ORDER BY sort_order ASC, path ASC` == `["/x/b", "/x/a", "/x/c"]` —
   `b` leads on recency, and `a` beats `c` on the `path ASC` tie-break at a tied timestamp, so the
   assertion pins BOTH halves of the seed's read order.
3. `sort_order_seeded_in_the_old_session_order_on_a_preexisting_db` — same fixture. Three sessions:
   `s_old_used` created 1000, `s_stale` created 2000, `s_fresh` created 3000, plus one `messages`
   row for `s_old_used` with `created_at` 9999 (raw `INSERT INTO messages (session_id, kind,
   message_key, payload_json, created_at) VALUES ('s_old_used','user',NULL,'{}',9999)`). Assert
   `SELECT id FROM sessions ORDER BY sort_order ASC, id DESC` ==
   `["s_old_used", "s_fresh", "s_stale"]` — the order the user was already looking at, which is
   NOT `id DESC` and NOT `created_at DESC` alone.
4. `sort_order_seed_does_not_rerun_on_reopen` — the sentinel idiom from
   `legacy_db_migration_backfills_newest_non_read_todos_once`: open, raw-`UPDATE spaces SET
   sort_order = 4242 WHERE path = ?1` and `UPDATE sessions SET sort_order = 77 WHERE id = ?1`,
   `drop(db)`, `Db::open(&path)` again, assert both sentinels survived. This is the proof that the
   seed is gated, not merely idempotent.
5. `sort_order_seed_numbers_subagent_rows_too` (hazard H1) — legacy fixture with three sessions:
   two with `is_subagent = 0`, one with `is_subagent = 1`. Assert
   `SELECT COUNT(*) FROM sessions` == `SELECT COUNT(DISTINCT sort_order) FROM sessions` == 3, and
   `SELECT COUNT(*) FROM sessions WHERE sort_order = 0` == 1.

Red for all five: `cd src-tauri && cargo test --lib -- sort_order` → five failures, each on a
missing column (`no such column: sort_order` / the pragma count being 0), not on a panic in test
setup.

Note on syntax (verified at this HEAD): a scoped run is `cargo test --lib -- <filter> [<filter>…]`
— the filter goes AFTER `--`; `cargo test --lib storage::db sort_order` is a cargo CLI error. Several
filters after `--` are **OR'd** — the run is the UNION of each filter's matches, not their
intersection, so a second filter can only ADD tests to the run, never narrow it.

**Then implement:**

- `SCHEMA`: append `sort_order INTEGER NOT NULL DEFAULT 0` as the last column of `sessions` (after
  `todos_json`) and of `spaces` (after `trusted`). A fresh DB gets the column with no migration.
- Module-level const, next to the new helpers: the sessions recency expression, moved verbatim out
  of `RECENT_FIRST`'s body and named for what it now is —
  `const LAST_ACTIVITY: &str = "COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE \
   m.session_id = sessions.id), sessions.created_at)";`
  Do **not** touch `RECENT_FIRST` in this task (that is Task 3); for exactly two commits the
  expression exists twice, and Task 3's tie tests are what prove the second copy's removal is safe.
- Two **independent** pragma-gated phases in `Db::open`, inserted immediately after the
  `todos_json` gate, each in its own `unchecked_transaction`:
  `spaces.sort_order` → `ALTER TABLE spaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0` +
  `seed_space_sort_order(&tx)?`; `sessions.sort_order` → the matching ALTER +
  `seed_session_sort_order(&tx)?`. Split them because each gate probes and repairs its own table
  through `pragma_table_info`, so a crash between the two commits leaves one table seeded and the
  other un-migrated — a state that is **self-healing**: the next `Db::open` re-probes both tables
  and runs whichever gate is still missing, independently. It also matches the file's
  one-column-per-gate style (`trusted`, `archived`, `context_usage_json`, `is_subagent` and
  `todos_json` each have their own gate). The mixed state the split allows is not a hazard to be
  prevented: independent transactions are what ALLOW it, and it is harmless precisely because every
  gate is independently re-runnable. The seed runs INSIDE the same gate as its ALTER, which is
  what makes it one-time.
- **Invariant that actually matters, and it is load-bearing for Task 2: both seed gates run BEFORE
  the phase-11 space backfill** (`SELECT DISTINCT cwd FROM sessions`).
- `fn seed_space_sort_order(conn: &Connection) -> Result<(), DbError>`: read
  `SELECT path FROM spaces ORDER BY last_opened_at DESC, path ASC` into a `Vec<String>`
  (`drop(stmt)` immediately), then in the same tx `UPDATE spaces SET sort_order = ?2 WHERE
  path = ?1` with `i as i64` from `iter().enumerate()`.
- `fn seed_session_sort_order(conn: &Connection) -> Result<(), DbError>`: read
  `format!("SELECT id FROM sessions ORDER BY {LAST_ACTIVITY} DESC, id DESC")` — **no `WHERE`**
  (H1) — into a `Vec<String>`, `drop(stmt)`, then `UPDATE sessions SET sort_order = ?2 WHERE id = ?1`.
- Doc comment on each helper starts `/// One-time …` and states, in one line, that the read order is
  the OLD display order and is hardcoded on purpose (the full reason is the ADR bullet Task 2 adds).

**Verify green:** `cd src-tauri && cargo test --lib -- storage::db` (all tests, not just the five —
the ORDER BY is untouched, so every pre-existing test must still pass; that is this task's regression
proof. Count them before you start and compare like with like: this task ADDS five (20 → 25 at this
plan's HEAD), so the run reports the pre-existing total plus five — re-count at your own HEAD and
never assert the number). Then `cargo fmt` + `cargo clippy --all-targets`.

**Commit:** `git add src-tauri/src/storage/db.rs && git commit -m "feat(storage): add sort_order to spaces and sessions, seeded in the current display order"`

---

## Task 2 — new rows join at the BOTTOM (three INSERTs), and the ADR gets the two durable facts

**Files owned:** `src-tauri/src/storage/db.rs` (`Db::upsert_space`, `Db::record_session`, the
phase-11 backfill INSERT, their doc comments) + `docs/decisions/0075-list-position-is-not-evidence.md`.

**Write the failing tests FIRST** (in `db.rs::tests` — they assert through raw SQL because
`list_spaces`/`list_sessions` still sort by the old key until Task 3):

1. `upsert_space_new_row_joins_at_the_bottom` — three real temp dirs, `upsert_space` a, b, c in
   that order. Assert the raw `SELECT path FROM spaces ORDER BY sort_order ASC, path ASC` equals
   insertion order, and that the raw `SELECT sort_order FROM spaces ORDER BY sort_order ASC`
   is `[0, 1, 2]`.
2. `upsert_space_retouch_does_not_renumber` — upsert a then b, then a **again**; assert a's
   `sort_order` is still `0` and the raw order is still `[a, b]`. This is the feature, and it is
   also the resume hazard: `DO UPDATE` must never touch `sort_order`.
3. `record_session_new_row_joins_at_the_bottom` — two `SessionInfo` literals (the
   `record_session_preserves_the_archived_flag` shape) recorded in order; assert
   `SELECT id FROM sessions ORDER BY sort_order ASC, id DESC` == insertion order and the values are
   `0, 1`.
4. `record_session_re_record_does_not_renumber` — record, read `sort_order`, record the same
   `SessionInfo` again (a resume re-runs `record_session`), assert the value is unchanged.
5. `backfilled_space_rows_join_at_the_bottom` (hazard H4) — legacy fixture with two `sessions` rows
   whose `cwd`s are two real temp dirs and an **empty** `spaces` table, so the seed numbers nothing
   and the phase-11 backfill creates both rows. Assert, order-agnostically (the backfill reads
   `SELECT DISTINCT cwd FROM sessions`, which has no defined order — do NOT assert a sequence):
   `SELECT COUNT(DISTINCT sort_order) FROM spaces` == `SELECT COUNT(*) FROM spaces` == 2, and
   `SELECT COUNT(*) FROM spaces WHERE sort_order = 0` == 1. Before the fix BOTH fail: every
   backfilled row carries `DEFAULT 0`, so `COUNT(DISTINCT sort_order)` is `1` (not `2`) and the
   `sort_order = 0` count is `2` (not `1`).

Red: `cd src-tauri && cargo test --lib -- joins_at_the_bottom does_not_renumber` → all five fail,
each because every row still carries `DEFAULT 0` (the column exists after Task 1; nothing writes it
yet). Name the temp dirs so that INSERTION order is NOT `path ASC` order — otherwise test 1's
`ORDER BY sort_order ASC, path ASC` falls back to the tie-break and passes vacuously.

**Then implement** — one expression, three sites, and the params arrays do NOT grow (SQLite computes
it, so `params![]` stays exactly as it is):

- `Db::upsert_space`: add `sort_order` to the column list and
  `COALESCE((SELECT MAX(sort_order) FROM spaces), -1) + 1` to `VALUES`. Leave the
  `ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at` branch byte-for-byte
  unchanged — a re-touch refreshes recency and must not renumber.
- `Db::record_session`: same, over `sessions`, `DO UPDATE` branch untouched.
- The phase-11 space-backfill INSERT: same expression, `ON CONFLICT(path) DO NOTHING` unchanged
  (H4 — see Decisions).
- Doc comments: state on `upsert_space` and `record_session` that a NEW row joins at the bottom and
  the CONFLICT branch never renumbers (a resume re-runs `record_session`). Do NOT rewrite the
  phase-11 comment's "recent-first ordering" phrase here — that phrase dies in Task 3, with the
  `ORDER BY`.
- **ADR:** append exactly two bullets to `## Consequences` of
  `docs/decisions/0075-list-position-is-not-evidence.md` (do not restate the thesis — it already
  owns "position is not evidence"):
  1. the phase-11 space-backfill INSERT carries the same bottom-join expression as `upsert_space`,
     because on the upgrade path where a DB has stored sessions but no `spaces` rows the seed
     numbers nothing, and `DEFAULT 0` would tie every backfilled row and hand the user an
     alphabetical list on the very boot the spec promises is unchanged;
  2. the seed's read queries hardcode the OLD order and must never be pointed at `sort_order`,
     because at seed time every value is `DEFAULT 0`, so `ORDER BY sort_order` is a pure tie and
     would pick an order nobody ever saw.

**Verify green:** `cd src-tauri && cargo test --lib -- storage::db` then `cargo test --lib` (the
`agent::session`, `persist`, `ipc`, `worker_e2e` call sites were verified order-independent — one
of those suites failing means the plan is wrong, not the test). Run
`cargo test --test storage -- open_backfills` too (before and after): that test compares a
`(path, created_at, last_opened_at)` tuple vec built from two separate `list_spaces()` calls, so it
IS order-sensitive and it stays green here. Be precise about why: it CANNOT catch H4. Pre-patch
every backfilled row carries `DEFAULT 0`, so ordering falls through to the stored
`last_opened_at DESC, path ASC`, and both `list_spaces()` calls read those same stored values —
`ON CONFLICT DO NOTHING` never refreshes them, which is the very thing this test asserts — so
`before == after` whether the numbers are distinct or all tied. What it pins is `DO NOTHING` (no
timestamp refresh on open); nothing pre-existing pinned the tie, which is exactly why Task 2's own
`backfilled_space_rows_join_at_the_bottom` exists.

**Commit:** `git add src-tauri/src/storage/db.rs docs/decisions/0075-list-position-is-not-evidence.md && git commit -m "feat(storage): new spaces and sessions join the list at the bottom"`

---

## Task 3 — the `ORDER BY` swap, and the tests whose premise the swap kills

**Files owned:** `src-tauri/src/storage/db.rs` (`Db::list_spaces`, `Db::list_sessions`, the
`RECENT_FIRST` const, the phase-11 comment) + `src-tauri/tests/storage.rs` + three comment-only doc
lines outside `db.rs` that the swap turns into lies: two in the command layer
(`src-tauri/src/commands/spaces.rs`, `src-tauri/src/commands/history.rs`) and one on the
`list_sessions`-shaped helper in `src-tauri/src/agent/session/mod.rs`.

**Write the failing tests FIRST.** The rule for every one of them: the fixture must make
`sort_order` and recency **disagree**, or the test passes vacuously under the old `ORDER BY` and
proves nothing.

Delete `db.rs::tests::list_sessions_orders_by_last_message_then_created_at` (its entire premise is
the recency `ORDER BY`; its raw INSERTs bypass `record_session`, so after the swap every row takes
`DEFAULT 0` and the assertion is meaningless) in the SAME edit that adds tests 1–4 — otherwise the
red filter below also matches it, and while the swap is still unimplemented it PASSES (the old
recency `ORDER BY` is still in place), which reads like a green test hiding among the reds. Replace
it with:

1. `list_sessions_orders_by_sort_order_then_id_desc` — three sessions recorded via
   `record_session` (so `sort_order` is written), then raw-`UPDATE` their `sort_order` to a
   non-recency sequence, and give the LAST-listed one a fresh `record_message`. Assert
   `list_sessions(false)` ids equal the `sort_order` order.
2. `list_sessions_ties_break_on_id_desc` — two rows with an EQUAL `sort_order`, neither archived;
   assert `list_sessions(false)` returns ids `["s_b", "s_a"]` (`id DESC`). Then **archive one of the
   two tied rows** (as the deleted test's second half did) and assert `list_sessions(true)` returns
   the same pair in the same order — the archive is what makes the second read the OTHER arm of the
   query, so it can fail on its own; without it both reads run the identical statement over the
   identical rows and the second assertion is a copy of the first. This is the inherited "both arms
   share one `ORDER BY`, so they cannot drift" half.
3. `list_sessions_ignores_transcript_activity` — the ADR 0075 behaviour pin: the session with the
   newest message sits in the middle of the `sort_order` sequence and stays there.
4. `list_spaces_orders_by_sort_order_then_path` — three spaces upserted in one order, then
   raw-`UPDATE`d so the FIRST-listed row has the LOWEST `last_opened_at`; assert `list_spaces()`
   returns the `sort_order` order. Then raw-`UPDATE` two rows to the same `sort_order` and assert
   they come back `path ASC` (the tie-break must not swap between reads).

In `src-tauri/tests/storage.rs`, split `spaces_upsert_find_delete_and_order`:

5. `spaces_upsert_find_delete` — the surviving body: the empty-on-fresh assert, `len() == 2`,
   `find_space` hits/miss, `pa.created_at <= pa.last_opened_at`, `delete_space` leaves one, the
   recreated-`pb` section. **Drop** the two recency asserts (`spaces[0].path == "/tmp/pb"` "most
   recently opened first" and "a re-touch wins the recent-first ordering") and the three
   `std::thread::sleep`s that existed only to separate `last_opened_at` values. In the recreated-`pb`
   section, reach `pb` with `.iter().find(|s| s.path == "/tmp/pb")` instead of an index — a
   recreated row joins at the bottom, so its index is not stable. `temp_db_path()` /
   `sample_session()` stay as they are.
6. `space_retouch_keeps_its_position_and_new_rows_join_last` — the integration-level replacement,
   asserted through the PUBLIC surface only (`tests/storage.rs` cannot touch `db.conn`, which is
   why this half lives here and the raw-SQL halves live in `db.rs`): upsert a, b, c →
   `list_spaces()` == `[a, b, c]`; re-touch `a` → still `[a, b, c]`; upsert `d` → `[a, b, c, d]`.

Red: `cd src-tauri && cargo test --lib -- storage::db::tests::list_sessions storage::db::tests::list_spaces_orders`
and `cargo test --test storage -- space_`. The four new `db.rs` tests fail (rows still come back in
recency order) and `space_retouch_keeps_its_position_and_new_rows_join_last` fails on
`spaces[0].path`.

Read the red output as a UNION, not a subset (see the syntax note in Task 1): each filter after `--`
adds its own matches, so a second filter can only widen the run. The module-prefixed form above is
what keeps that predictable:
- `storage::db::tests::list_sessions` matches the three new `list_sessions_*` tests AND two
  pre-existing ones in the same module — `list_sessions_filters_archived_by_default` and
  `list_sessions_hides_subagent_rows_but_their_transcripts_load`. Expect those two GREEN among the
  reds: neither depends on the `ORDER BY`, so a green there is the expected result, not a failure
  hiding in the noise. (Once the old test is deleted in the same edit, nothing else named
  `list_sessions_orders…` remains to pass vacuously.)
- Prefixing is also what EXCLUDES two tests that live outside the module but share the name stem:
  `agent::session::session_tests::list_sessions_carries_the_stored_config_options_and_context_usage`
  and `agent::session::session_tests::list_sessions_carries_the_stored_title`. A bare
  `-- list_sessions list_spaces_orders` pulls both of those in as extra green tests; the
  `storage::db::tests::` prefix keeps them out of the run.
- The `space_` filter on `tests/storage.rs` is the loose one and CANNOT be tightened the same way (an
  integration test has no module prefix beyond the file), so its extra matches are named next.

The other `space_`-matching tests in `tests/storage.rs`
(`set_space_trusted_updates_and_flag_reads`, `space_trusted_fail_closed`,
`space_methods_agree_on_the_canonical_key`,
`the_session_cwd_string_and_the_space_path_key_are_the_same_string`,
`open_backfills_space_rows_from_existing_sessions`) were verified order-independent and must stay
green throughout — a red there means the swap broke something this plan did not predict. The
cwd-coupling test belongs in that list because `space_` matches inside its name (
`the_…_and_the_SPACE_PATH_key_are_the_same_string`); it asserts `spaces.len() == 1` and then reads
`spaces[0].path`, and a single-row list is order-proof. Note what the filter does NOT match:
`spaces_trusted_column_fresh_and_migrated` and the split `spaces_upsert_find_delete` (the plural
`spaces_` is not the filter `space_`), so they are not in the red run at all and their own green
comes from the plain `cargo test --test storage`.

**Then implement:**

- `Db::list_spaces`: `ORDER BY sort_order ASC, path ASC`. Doc comment becomes "All spaces, in the
  user's manual order (`sort_order`), `path` breaking ties. Nothing else moves a row." — the old
  "most recently opened first" is now a lie.
- `Db::list_sessions`: delete the `RECENT_FIRST` const entirely; both `format!` arms end with
  `ORDER BY sort_order ASC, id DESC`. Rewrite the doc preamble: the rows come back in the manual
  order; recency is no longer implied by position (cite ADR 0075 by path, not by number-only
  prose); `LAST_ACTIVITY` survives as the single copy of the expression the seed reads with and
  that T02 will `SELECT` as `last_active_at`, so the number a row prints and the number a recency
  decision reads cannot drift. Keep the existing `include_archived` prose (both arms still filter
  identically, and now both still order identically for the same reason).
- Phase-11 backfill comment: replace the "recent-first ordering … collapse … to a tie on every
  restart" rationale — recency is no longer the sort key. Keep the `DO NOTHING` rule and its
  reason (the backfill must never refresh `last_opened_at` / `created_at` on open), and add one
  line that the INSERT joins at the bottom so a backfilled row is not tied at 0 (the ADR owns the
  full reason; point at it).
- Comment-only, no signature/serde/IPC change, in the three files the swap makes wrong:
  `commands/spaces.rs::list_spaces` ("All spaces, most recently opened first." → manual order),
  `commands/history.rs::list_sessions` ("MOST RECENTLY ACTIVE FIRST (see `Db::list_sessions`)" →
  manual order, recency is a field not a position), `agent/session/mod.rs`'s `list_sessions`-shaped
  helper doc ("most recently ACTIVE first — `Db::list_sessions`" → manual order). These three lines
  are in this commit's blast radius; widening further is out of scope.

**Verify green:** `cd src-tauri && cargo test --lib -- storage::db && cargo test --test storage` then
`cargo test --lib`, `cargo clippy --all-targets`, `cargo fmt --check`. `open_backfills_space_rows_from_existing_sessions`
is in this commit's path and must stay green: after the swap its two `list_spaces()` calls both read
`ORDER BY sort_order ASC` over rows that carry distinct numbers (Task 2 wrote them at `MAX + 1`), so
its before/after tuple comparison still lines up — and note that it would line up even if they did
not, because both reads use the same order (that is exactly what Task 2's note about it says).

**Commit:** `git add src-tauri/src/storage/db.rs src-tauri/tests/storage.rs src-tauri/src/commands/spaces.rs src-tauri/src/commands/history.rs src-tauri/src/agent/session/mod.rs && git commit -m "feat(storage): list spaces and sessions in sort_order instead of recency"`

---

## Task 4 — `Db::reorder_spaces` / `Db::reorder_sessions` (one transaction, no IPC)

**Files owned:** `src-tauri/src/storage/db.rs` (two new `pub fn`s on `impl Db`, placed beside
`Db::delete_space` / `Db::set_session_archived`) + `db.rs::tests`.

**Write the failing tests FIRST** (`db.rs::tests`; red is `no method reorder_spaces for Db`):

1. `reorder_spaces_writes_the_given_order` — three real dirs upserted a, b, c;
   `db.reorder_spaces(&[c, a, b])` (the canonical keys — `list_spaces()`'s paths, which is exactly
   where the frontend's ids come from); assert `list_spaces()` == `[c, a, b]` and that the raw
   `sort_order` values are `0, 1, 2`.
2. `reorder_spaces_survives_a_reopen` — reorder, `drop(db)`, `Db::open(&path)` again, assert the
   order is still `[c, a, b]` (i.e. the seed gate did not fire and did not clobber it).
3. `reorder_spaces_with_an_unknown_path_is_not_an_error` — pass `["/nope-<uuid>", a, b]`; assert
   `is_ok()` and that the two known rows landed at `1` and `2` (the slice INDEX is the value, so a
   row the caller never heard of simply occupies its slot). This pins the documented semantics
   rather than leaving them undefined.
4. `reorder_sessions_writes_the_given_order` — three sessions via `record_session`,
   `db.reorder_sessions(&[id2, id0, id1])`, assert `list_sessions(false)` ids == that order, and
   that the order survives a re-open. Also assert a subagent row (recorded with `is_subagent: true`)
   is reorderable by id: `list_sessions` filters `is_subagent = 0`, so it never appears in ANY
   `list_*` result and the ONLY witness that its number changed is raw SQL against
   `db.conn.lock().expect("db mutex poisoned")` — the same raw-read shape Task 2's tests use.
5. `reorder_sessions_is_per_space_even_when_numbers_collide_across_spaces` (the global-numbering
   consequence — see Decisions) — two real cwds A and B; `record_session` in the order a1, b1, b2, a2
   so the global numbers come out `0, 1, 2, 3` and A's two rows STRADDLE B's (that interleaving is
   the whole point — record a1, a2, b1, b2 and no collision is possible). Then
   `db.reorder_sessions(&[a2, a1])` — the sidebar's visible slice of A only, so B's rows are never
   passed. Assert ALL THREE:
   - `db.list_sessions(false)` filtered to A's `cwd` == `[a2, a1]` (the dragged order);
   - filtered to B's `cwd` == `[b1, b2]` (untouched, still in its own order);
   - the raw `SELECT COUNT(*) FROM sessions` (4) is strictly greater than
     `SELECT COUNT(DISTINCT sort_order) FROM sessions` (3) — after the renumber, `a1` sits at `1`
     exactly where `b1` already was. A duplicate number across Spaces is the EXPECTED steady state,
     not corruption this call should have repaired.

Red: `cd src-tauri && cargo test --lib -- reorder_`.

**The red is a whole-binary compile error, and that is the blast radius — say it out loud before you
run anything.** `db.rs` and its `#[cfg(test)] mod tests` live in ONE crate, so a test that calls a
`reorder_spaces` which does not exist yet fails to compile the ENTIRE `archimedes_lib` test binary:
`cargo test --lib -- reorder_` reports the missing-method error (E0599 — at this HEAD, `no method
named 'reorder_spaces' found for struct 'Db'`; take the wording from your own run) and then NOTHING
ELSE — not "0 tests run", and no other test's result. The same is true of
`cargo clippy --all-targets` (it exits 101) and of the full `cargo test`. So while Task 4's tests
exist unfixed, no gate — scoped or full — can be claimed green OR red, because none of them ran.
Prove the red from the compiler message alone, then implement, and only after the crate compiles
again run any gate and report its numbers.

**Then implement** — both methods identical in shape, following `Db::replace_native_messages`, both
placed inside `impl Db` (so the sketch's indentation is not literal):

```rust
/// Rewrite the manual order of the given space paths in ONE transaction:
/// the slice index becomes `sort_order` (ADR 0075 — only a drag calls this).
/// Keyed by the stored path RAW, as `find_space`/`delete_space` do: the ids
/// come from a `list_spaces()` result and are already the stored key, and
/// re-canonicalizing would silently skip a row whose folder is gone and
/// leave a PARTIAL renumber behind. An id that matches no row is a no-op.
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
```

and the same over `sessions` keyed by `id` (`UPDATE sessions SET sort_order = ?2 WHERE id = ?1`),
with a doc comment noting it renumbers hidden subagent rows too (H1's consequence: `MAX + 1` is
global, so a hidden row occupies a number and the caller may legitimately hand one back).

Return `Result<(), DbError>` — every void write in this file does; `Result<bool, DbError>` is only
for calls where a 0-row match is reportable, and a full-slice reorder has no meaningful partial
answer. Use `iter().enumerate()` (clippy's `needless_range_loop` otherwise).

**Verify green:** only once the crate compiles again (see the red note above — with the tests
unfixed, nothing ran). `cd src-tauri && cargo test --lib -- storage::db`, then the full set below.

**Commit:** `git add src-tauri/src/storage/db.rs && git commit -m "feat(storage): add reorder_spaces and reorder_sessions"`

---

## Decisions this plan makes

- **H1 — the seed renumbers EVERY session row, with no `WHERE`.** `MAX + 1` is global and
  `ensure_session_row` routes subagent rows through `record_session`, so hidden rows already consume
  numbers; seeding only the visible rows would duplicate values and tie them with the visible row at
  0. Pinned by `sort_order_seed_numbers_subagent_rows_too` and `sort_order_seed_does_not_rerun_on_reopen`.
- **H2 — the recency expression survives as one module-level `LAST_ACTIVITY` const.** T01 removes it
  from the `ORDER BY` but keeps the expression (the seed reads with it, T02 selects it as
  `last_active_at`); one copy means the printed number and any recency decision cannot drift.
  `RECENT_FIRST` is deleted in Task 3, so the expression is duplicated for exactly two commits —
  an accepted cost of keeping each commit's ordering change atomic.
- **H3 — the seed queries hardcode today's order** (`last_opened_at DESC, path ASC` /
  `{LAST_ACTIVITY} DESC, id DESC`) and are never pointed at `sort_order`, which at seed time is all
  `DEFAULT 0` — a pure tie, i.e. an order the user never saw. Recorded in ADR 0075's Consequences.
- **H4 — patch the phase-11 backfill INSERT with the bottom-join expression; do NOT move the seed
  after the backfill.** Moving the seed would number a fresh-but-populated DB in unspecified
  `SELECT DISTINCT cwd` order (a real nondeterminism), whereas patching the INSERT is
  order-independent and keeps `DO NOTHING` intact; the alternative also reorders work that Task 3's
  comment rewrite assumes stays put.
- **Seed gates sit immediately after the `todos_json` gate, both before the phase-11 backfill**, so
  a DB that already has `spaces` rows gets seeded and then backfilled at `MAX + 1`, and a DB with
  none gets a fully-numbered backfill. Two independent gates, one per table, each crash-idempotent
  on its own.
- **`reorder_sessions` may leave DUPLICATE `sort_order` values across Spaces, and that is the
  intended steady state.** `reorder_sessions` receives the sidebar's visible slice, which is the
  sessions of ONE Space, while the numbering is GLOBAL (the spec's own choice, and H1's premise).
  So a drag renumbers that one slice `0..k` and never touches the rows of any other Space, which
  keep their old numbers and therefore collide with the freshly-written ones: after a drag on one
  Space, two rows in different Spaces commonly carry the same `sort_order`. That is invisible and
  harmless — `ORDER BY sort_order ASC, id DESC` is total, so every read is deterministic, and display
  is per-Space, so no surface ever renders two Spaces' rows side by side by `sort_order` alone.
  `reorder_spaces` is immune to the whole question because `list_spaces` IS the whole table: the
  sidebar's tab strip always passes the full slice, so a space reorder renumbers everything there is.
  The alternative — have `reorder_sessions` renumber the untouched rows to keep the column globally
  unique — would move rows the user did not drag, in Spaces they are not looking at, which is the bug
  this wave exists to kill. Pinned by
  `reorder_sessions_is_per_space_even_when_numbers_collide_across_spaces`.
- **`reorder_*` take the raw id** (the `find_space` / `delete_space` precedent): the ids come from a
  `list_*` result and are already the stored key, and re-canonicalizing would silently skip a row
  whose folder vanished mid-drag, leaving a PARTIAL renumber — the worst possible outcome.
- **Durable facts → ADR 0075's `## Consequences`, not the status file and not a plan comment.** The
  status file lives under `docs/roadmap/`, which is deleted on ship, so a Decisions-log entry there
  does not survive; ADR 0075 already exists, already owns the design these two facts are consequences
  of, and is disjoint from T08's seam (`docs/features/`). T08 must NOT expect to write these two
  bullets — they are already in the ADR by the end of T01; T08 folds the *shipped behaviour* and the
  two accepted gaps into `docs/features/manual-list-order.md`.
- **The three stale doc comments outside `db.rs` (two in the command layer, one in
  `agent/session/mod.rs`) are edited here, comment-only.** They state the old order
  verbatim and become false in this commit, so they are in its blast radius; the task's out-of-scope
  rule carves out "where the task genuinely cannot proceed without it", and a lying doc comment on a
  command that now returns a different order is exactly that. No signature, no `serde`, no `lib.rs`
  registration, no `src/` file.

## Out of scope

- **`SpaceRow` / `SessionRow` gain NO field.** The exclusion is a seam question, not a mechanism
  claim: `SpaceRow` is returned straight through by `commands/spaces.rs::list_spaces`, so a new field
  on it IS a new IPC key; `SessionRow` is never returned by any command at all — the session commands
  return `SessionInfo` (`src-tauri/src/types.rs`), so adding a field there changes no wire format
  today. Either way both structs sit in T02's seam (`src-tauri/src/types.rs`,
  `src-tauri/src/commands/`, `src/lib/tauri/types.ts`), which is where the field belongs.
  `last_active_at` is T02's, selected from the
  `LAST_ACTIVITY` const this plan leaves in place.
- **No `reorder_*` over IPC**, no `lib.rs` command registration, no TS mirror — T02.
- **Nothing under `src/`.** The frontend never re-sorts, so the changed server order flows through
  unchanged; the store derivation is T03, the sidebar render is T04, the drag is T05–T07. No
  comment-only frontend edits either.
  - **Recorded exemption — these frontend comments are knowingly stale between Task 3's commit and
    T03/T04.** Task 3 fixes the three Rust doc comments it makes false and then excludes the
    frontend; that exclusion is deliberate, but it leaves the following sites asserting an order that
    is no longer true, and the record here is what makes it a decision rather than an oversight:
    1. `src/store/sessions.ts` — the `autoSelectActive` **ordering note**, the most load-bearing of
       them: it quotes both old SQL statements verbatim (`ORDER BY COALESCE(last message's
       created_at, created_at) DESC, id DESC` and `ORDER BY last_opened_at DESC, path ASC`) and
       concludes "input order IS the order — `spaces[0]` is the most recently opened space". ADR 0075
       names this note as the origin of the bug, so it is the worst thing left lying;
    2. `src/store/sessions.ts` — `SpaceView.storedSessionIds`'s doc ("in `list_sessions` order (most
       recently ACTIVE first …)");
    3. `src/store/sessions.ts` — `spaceViewFor`'s `// Input order = newest-first from
       list_sessions; NOT re-sorted.` comment;
    4. `src/components/SpacesList.tsx` — `// … groups follow the server's recent-first order.` on the
       `views` memo, and the `activityKey` / `sortByActivity` comment block above it ("the ORDER now
       reads the same field — so a row's time and its position in the list can never disagree").
  - **T03 owns 1–3 (it rewrites `sessions.ts`) and T04 owns 4 (it deletes the sort and its
    subscription).** Each must DELETE or rewrite its entries above, not merely work around them —
    `grep -rn "recent-first\|recently ACTIVE first\|newest-first" src/store/sessions.ts src/components/SpacesList.tsx`
    is a red flag for whoever lands there next. T01 does not touch them because a comment-only edit
    in a file whose whole derivation T03 rewrites is churn in someone else's seam.
- **No `SELECT` of `sort_order`** into any row struct, and no change to `find_space`,
  `space_trusted`, `set_space_trusted`, `delete_space`, `session`, `set_session_archived`,
  `record_session_context_usage`, `record_session_todos`, or the `messages` / `native_messages`
  paths.
- **The Archived section's explicit recency sort is not here** (ADR 0075 flags it as the trap) — it
  is a frontend change owned by T03/T04.
- **`docs/features/manual-list-order.md` is not created** — T08's seam.

## Verification

From `src-tauri/` after each task, and in full at the end:

    cargo test --lib -- storage::db    # the in-file tests (scoped)
    cargo test --test storage         # tests/storage.rs (scoped)
    cargo test --lib -- storage::db reorder_   # two filters after `--` = the UNION of their
                                               # matches (OR'd), not their intersection
    cargo test --lib                  # whole crate incl. agent/session, persist, ipc, worker_e2e
    cargo test                        # full Rust suite (unit + integration)
    cargo clippy --all-targets        # must be 0 warnings — clean at the branch base, so any
                                      # warning from here on belongs to this task
    cargo fmt --check

From the repo root (untouched by T01, run once at the end because the gate says so):

    pnpm test
    pnpm build

Scope proof (run from repo root, all must hold):

    git diff --name-only <branch-base>..HEAD   # only: src-tauri/src/storage/db.rs,
                                               # src-tauri/tests/storage.rs,
                                               # src-tauri/src/commands/{spaces,history}.rs,
                                               # src-tauri/src/agent/session/mod.rs,
                                               # docs/decisions/0075-list-position-is-not-evidence.md
    grep -rn "sort_order" src/                 # zero hits — no frontend leak
    grep -rn --include=*.rs "most recently opened first\|MOST RECENTLY ACTIVE FIRST\|most recently ACTIVE first" src-tauri/
                                               # zero hits. The scope is `src-tauri/`, NOT
                                               # `src-tauri/src`: tests/storage.rs carries two of
                                               # these literal strings in its asserts until Task 3
                                               # drops them, and Done-when #4 promises the whole
                                               # directory. `--include=*.rs` is mandatory — without
                                               # it the grep matches the compiled binaries and
                                               # rustdoc HTML under src-tauri/target/
    grep -n "pub struct SpaceRow" -A 12 src-tauri/src/storage/db.rs   # unchanged field list
    grep -n "pub struct SessionRow" -A 25 src-tauri/src/storage/db.rs # unchanged field list — the
                                               # `is_subagent` field is the LAST one and sits past
                                               # the reach of a shorter -A window

Write-path safety, verified (recorded as the argument it is, not a to-do): the plan changes three
`INSERT`s and nothing else creates a numbered row, and that closure was checked rather than assumed.
Production `INSERT INTO spaces` exists at exactly two sites (`Db::upsert_space` and the phase-11
backfill) and `INSERT INTO sessions` at exactly one (`Db::record_session`) — all three are patched —
and there is no fourth site hiding behind `INSERT OR IGNORE` / `REPLACE INTO` / an
`INSERT INTO <table> SELECT`, so no row can ever be created without a number. The seed cannot re-run
on a migrated DB, which `sort_order_seed_does_not_rerun_on_reopen` proves with a sentinel instead of
by inspection. And the positional `INSERT INTO sessions VALUES (…)` fixtures in the in-file tests
cannot be broken by the new column: each one issues its OWN local `CREATE TABLE` in the same
`execute_batch`, so its arity is its own and not `SCHEMA`'s.

Counts (re-measure at your own HEAD — these are the intended deltas, not a baseline to assert):
`db.rs` in-file tests 20 → 38 (−1 deleted `list_sessions_orders_by_last_message_then_created_at`,
+5 Task 1, +5 Task 2, +4 Task 3, +5 Task 4); `tests/storage.rs` 12 → 13 (one split into two). If a
scoped run cannot even compile, remember `archimedes` is ONE compilation unit — a syntax error
anywhere in `db.rs` breaks every scoped `cargo test`, so fix the compile before chasing a failure.
The ONE place this plan deliberately sits in that state is between Task 4's red and its
implementation: there, the tests reference `reorder_spaces` / `reorder_sessions` before they exist,
so the compile failure is the expected red and no gate number from it means anything (see Task 4's
red note).

## Known limits this plan accepts (record them in the Changelog line, not in code)

- The recency expression exists twice (`LAST_ACTIVITY` and the inside-`list_sessions`
  `RECENT_FIRST`) for the two commits between Task 1 and Task 3. Task 3's tie tests are the guard.
- Same class, same length: the phase-11 comment's "recent-first ordering" phrase keeps lying for the
  one commit between Task 2 (which edits that INSERT and is told NOT to rewrite the comment) and
  Task 3 (which deletes the phrase with the `ORDER BY`). Accepted for the same reason as the duplicated
  expression — Task 2's diff stays a write-path diff and the comment fix lands with the change that
  makes it false.
- Mid-transaction rollback in `reorder_*` is not tested: nothing in a `UPDATE … WHERE pk = ?` loop
  can fail after the first statement without a fault-injection point. The transaction is there
  because the whole slice must land or not at all; `reorder_spaces_with_an_unknown_path_is_not_an_error`
  pins the only failure mode that is reachable (a 0-row update, which is not an error).
- The phase-11 backfill's row order remains `SELECT DISTINCT cwd` order (unspecified). Task 2 only
  asserts distinctness, not sequence, so the test does not encode a nondeterminism.
- `upsert_space` still refreshes `last_opened_at` on a re-touch. Nothing reads it for ordering after
  Task 3, so it is now a bookkeeping timestamp only; removing it is not T01's business.
- **Two concurrent app instances on one data dir now do real WRITE work inside `Db::open`, and a
  collision aborts startup.** `Cargo.toml` pulls `tauri-plugin-dialog` / `-opener` / `-window-state`
  / `-notification` / `-updater` and there is **no single-instance plugin**, so nothing prevents a
  second instance from opening the same file. Today the migrations in `Db::open` are DDL that a
  second instance skips; from Task 1 on, the seed issues real `UPDATE`s over every row inside a
  transaction. A `SQLITE_BUSY` there returns through the `#[from] rusqlite::Error` arm as
  `DbError::Sqlite`, and `Db::open` is the startup path — so the second window fails to start with a
  database error instead of quietly sharing. Accepted: the plan does not add a plugin, does not set a
  `busy_timeout`, and does not retry; the seed is a one-time burst, so the window is a single boot of
  a second instance, and the honest fix (single-instance enforcement) is a different task's seam.
- **The seed's lock regime is unspecified and stays unspecified.** The plan never says which locking
  mode the seed runs under: `Connection::open` gives whatever the build defaults to (no `journal_mode`
  or `busy_timeout` pragma is set anywhere in `db.rs` — only `foreign_keys`), and the seed's writes go
  through `unchecked_transaction`, i.e. a deferred transaction that takes its write lock at the first
  statement. That is fine for the single-instance app this is, and it is why the previous bullet is a
  recorded limitation rather than a design question — but do not read "the seed is one transaction" as
  "the seed is conflict-safe against another writer".
