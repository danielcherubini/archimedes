---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/67
done-when: Opening a 5,000-row session fetches only the latest 500 rows; scrolling up loads 200 more with no scroll jump or lost expanded state; the DOM stays bounded while streaming and the view follows a streaming reply only while the user is at the bottom; the Todo board survives a reload of a session whose last todo write is far outside the window; pnpm test, pnpm build, cargo test, cargo clippy --all-targets (0 warnings) and cargo fmt --check are green.
---

# Paged history window with a virtualized transcript — Plan

**Goal:** Opening a long session loads and draws quickly, and chatting in one stays smooth.

**Architecture:** `load_history` becomes paged (latest 500 rows, 200 more per scroll-up, cursor = `messages.id`) and returns `{ rows, hasMore, todos }`; the Todo board becomes persisted session state (`sessions.todos_json`) instead of a scan of the transcript; the transcript renders through `react-virtuoso`. The store keeps everything it has loaded (no sliding window). Decisions and terms: **ADR 0066** (`docs/decisions/0066-…md`) and **History window** in `CONTEXT.md` — read both first.

**Tech Stack:** Rust (rusqlite, Tauri 2 commands), React 19 + zustand 5, `react-virtuoso` (new), vitest 5 + jsdom.

**Validation bar (AGENTS.md)** — frontend from the repo root, Rust from `src-tauri/`: `pnpm test`, `pnpm build`, `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`. TDD: failing test first, confirm it fails, then make it pass.

**Facts the executing agent must know (verified against the code):**
- `messages` table (`src-tauri/src/storage/db.rs`): `id INTEGER PRIMARY KEY` (autoincrement-style, transcript order = `ORDER BY id`), `session_id`, `kind`, `message_key`, `payload_json`, `created_at`; index `idx_messages_session ON messages(session_id, id)`. `Db::messages_for(&self, session_id) -> Result<Vec<MessageRow>, DbError>` returns everything and is used by many Rust tests — **do not remove or change it**.
- `MessageRow` (`db.rs`) serializes camelCase: `{ id, sessionId, kind, messageKey, payloadJson, createdAt }`. The TS twin is `MessageRow` in `src/lib/tauri.ts`.
- The Worker has no DB. Persistence comes from the Supervisor: `SessionManager::route_event` (`src-tauri/src/agent/session/router.rs`) receives every Worker frame. Todo pushes arrive there as `WorkerInboundEvent::SinkFrame { event: "interactive-event", payload }` where `payload = { "sessionId", "seq", "event": "todos_update", "payload": { "source", "todos": [...] } }` (emitted in `src-tauri/src/agent/interactive/mod.rs` ~line 303). `src-tauri/` **never emits `todos_clear`**. A subagent's frames arrive with `is_subagent == true`.
- `route_event` has `self.persister: OnceLock<…TranscriptPersister>` (`self.persister.get()`); the persister owns `db: Arc<Db>` (`src-tauri/src/agent/persist.rs`).
- Sessions DB columns are added with a **pragma-gated `ALTER TABLE`** in `Db::open` (see the `context_usage_json` / `is_subagent` blocks, ~lines 195–230) AND declared in the `SCHEMA` const (`CREATE TABLE IF NOT EXISTS sessions (…)` ~line 749) for fresh DBs.
- Frontend: `loadHistory(sessionId)` in `src/lib/tauri.ts` (~line 809) is called from exactly two places, both in `src/store/sessions.ts`: `openSession` (~line 927) and `resumeSession` (~line 1003). The test mocks `loadHistory: vi.fn().mockResolvedValue([])` exist in `src/components/SessionStalledBanner.test.tsx`, `NewSessionErrorBanner.test.tsx`, `ChatStream.test.tsx`, `SpacesList.test.tsx`, `src/store/sessions.test.ts` (plus ~11 `mockImplementationOnce` sites in the last), and `SidePane.test.tsx` / `useAppShortcuts.test.ts` mention it in comments.
- `src/store/interactive.ts` imports only `zustand`, so `src/store/sessions.ts` may import `useInteractive` without a cycle. `useInteractive.applyTodoUpdate(sessionId, payload)` takes `{ todos: TodoItem[] }`. `dismissSession` is called from many places (`src/lib/sessionLifecycle.ts#onSessionClosed`, `App.tsx`, `SubagentTranscript.tsx`, `useAttentionAlert.ts`, `store/subagents.ts`) and is used as a reset between cases by ~14 test files — **leave `dismissSession` exactly as it is**. It deletes `todos[sessionId]` along with requests/cost/etc.; `onSessionClosed` (the only main-session caller on close) will preserve the board instead (Task 5).
- `useMainTodoItems(sessionId)` (`src/components/TodoBoardPanel.tsx`) returns `board ?? rawTodos ?? []` where `rawTodos` is a backwards scan of `messages[sessionId]` for the newest `manage_todo_list` write. This scan is what ADR 0066 deletes.
- `MessageList` (`src/components/chat/MessageList.tsx`) is props-only and must stay so (it must not read any store). Its scroll `div` carries `data-testid="transcript-scroll"` and currently keys rows `${activeSessionId}:${i}`. `ChatStream.tsx` owns `scrollRef` (~line 279) and an effect (~line 860) that does `el.scrollTop = el.scrollHeight` on `[messages, prompts.length, stackedAskRequests.length, inlineChildGates.length]`; `const units = groupConsecutiveFileWrites(messages)` is ~line 1553 and renders `<MessageList scrollRef units …/>` ~line 1587.
- jsdom has no layout: a virtualizer renders nothing unless sizes are mocked. `react-virtuoso` ships `VirtuosoMockContext` (`<VirtuosoMockContext.Provider value={{ viewportHeight, itemHeight }}>`), the supported way to render rows in jsdom. There is no vitest `setupFiles` today (`vite.config.ts` `test: { environment: "jsdom", globals: true }`) and no `src/test/` directory.
- `ChatStream.tsx` has an early `if (!activeSessionId) return …` (~line 873) and a file-level warning about hook order: **every new hook/selector in `ChatStream` must be declared ABOVE that return**. `units = groupConsecutiveFileWrites(messages)` is computed AFTER it (~line 1553) and is a fresh array on every render.
- `react-virtuoso` 4.18.19 (React 19 is a valid peer) API facts: `computeItemKey(index, item, context)` receives the **absolute** index (`originalIndex + firstItemIndex`); `followOutput` only reacts to `totalCount` changes (it does NOT follow an in-place growth of the last row — streamed text appends to one message); `ref` methods include `scrollToIndex({ index: "LAST", align: "end" })` and `autoscrollToBottom()` (only scrolls when `followOutput` is truthy and the list was at the bottom); extra props such as `data-testid` are forwarded to the scroller div and override Virtuoso's own testid; rows outside the viewport (+ `increaseViewportBy`) are UNMOUNTED, so row-local `useState` (e.g. `Reasoning`'s open state and `startTimeRef`) is lost for rows scrolled far away — an accepted consequence recorded in ADR 0066.

---

## Parallelisation

**Verdict:** SERIAL — Tasks 1–2 both modify `src-tauri/src/storage/db.rs` and `src-tauri/src/commands/history.rs`; Task 3 needs Task 2's `Db::record_session_todos`; Tasks 4–5 both modify `src/store/sessions.ts` / `src/lib/tauri.ts` and mocks in shared test files; Task 6 installs a dependency (`package.json` + `pnpm-lock.yaml`, a shared mutable artifact) and Task 7 imports what Task 6 creates. Every task must leave `main` green (its own scoped tests + `pnpm tsc --noEmit` / `cargo test`); the full suite runs at Tasks 4, 6, 7 and 8. Cargo and vitest also contend for one `target/` / cache. No safe wave exists; this is decided, not assumed.

---

### Task 1: Paged `load_history` on the Rust side

**Parallel:** none — modifies `db.rs` and `history.rs`, which Task 2 also modifies.

**Context:** Loading a long session today runs `SELECT … ORDER BY id` for every row. We need a page query keyed on `messages.id` (the cursor the frontend will carry), plus a `hasMore` flag, exposed through `load_history`. Omitting the new arguments must still return everything, so existing callers/tests are unaffected.

**Files:**
- Modify: `src-tauri/src/storage/db.rs`
- Modify: `src-tauri/src/commands/history.rs`

**What to implement:**
- In `db.rs`, next to `messages_for`, add
  `pub fn messages_page(&self, session_id: &str, before_id: Option<i64>, limit: Option<u32>) -> Result<(Vec<MessageRow>, bool), DbError>`.
  - `limit == None` → behave exactly like `messages_for` and return `(rows, false)` (ignore `before_id` only if you must; but keep the `id < before_id` filter applied when `before_id` is `Some`).
  - `limit == Some(n)` → run `SELECT id, session_id, kind, message_key, payload_json, created_at FROM messages WHERE session_id = ?1 AND id < COALESCE(?2, 9223372036854775807) ORDER BY id DESC LIMIT ?3` with `?3 = (n as i64) + 1` (compute in `i64` — `n + 1` in `u32` overflows at `u32::MAX`). The `COALESCE` form (not `?2 IS NULL OR id < ?2`) keeps the `idx_messages_session(session_id, id)` index seekable, so deep pages do not skip rows linearly. If more than `n` rows came back, the extra (OLDEST, i.e. last) row proves there is more: truncate to `n` and return `has_more = true`. Then **reverse** the vector so rows are in ascending transcript order.
  - Share the row-mapping closure with `messages_for` if it is trivial to do so; otherwise duplicate the 6-field mapping — do not refactor `messages_for`'s behavior.
- In `history.rs` add
  ```rust
  #[derive(Debug, Clone, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct HistoryPage {
      pub rows: Vec<MessageRow>,
      pub has_more: bool,
      /// Task 2 fills this; Task 1 always `None`.
      pub todos: Option<serde_json::Value>,
  }
  ```
  and change `load_history` to
  `pub async fn load_history(state: State<'_, Arc<Db>>, session_id: String, limit: Option<u32>, before_id: Option<i64>) -> Result<HistoryPage, String>` calling `messages_page`. Tauri exposes these as `sessionId`, `limit`, `beforeId`.
- Do NOT change `lib.rs` registration (the command name is unchanged).
- Update the module doc comment on `load_history`.

**Steps:**
- [ ] Write failing tests in the `#[cfg(test)] mod tests` of `db.rs`: first `record_session(&SessionInfo{…})` for BOTH sessions (the `messages.session_id` FK is enforced — copy the `mk`/`record_session` setup from the existing `list_sessions_filters_archived_by_default` test), then insert 7 rows for one session (and 2 for another) with `record_message(session, "agent-text", Some(&format!("k{i}")), "{}")` — give EVERY row a distinct `message_key` (a NULL key bypasses the `UNIQUE(session_id, kind, message_key)` and a repeated key upserts instead of inserting); assert `messages_page(s, None, Some(3))` returns the LAST 3 in ascending order with `has_more == true`; `messages_page(s, Some(<oldest returned id>), Some(3))` returns the previous 3 ascending, `has_more == true`; the next page returns 1 row with `has_more == false`; `messages_page(s, None, Some(7))` returns 7 with `has_more == false` (exact fit — the `limit + 1` probe must not report more); `messages_page(s, None, None)` equals `messages_for(s)` with `has_more == false`; another session's rows never appear.
- [ ] Run `cd src-tauri && cargo test messages_page` — expect a compile error / failure (function missing).
- [ ] Implement `messages_page` and `HistoryPage` + the new `load_history`.
- [ ] Run `cd src-tauri && cargo test messages_page` — all pass.
- [ ] Run `cd src-tauri && cargo test` (the whole crate; `load_history`'s signature changed) — all pass.
- [ ] Run `cd src-tauri && cargo fmt` then `cargo clippy --all-targets` — 0 warnings.
- [ ] Commit: "feat(history): page load_history by messages.id with hasMore"

**Acceptance criteria:**
- [ ] `messages_page` pages newest-first by id, returns ascending order, and `has_more` is exact (including the exact-fit case).
- [ ] `load_history` with no `limit`/`beforeId` returns every row, `hasMore: false`.
- [ ] `messages_for` and all existing tests are unchanged and green.

---

### Task 2: Persist the Todo board in `sessions.todos_json` and return it with the first page

**Parallel:** none — modifies `db.rs` and `history.rs` (shared with Task 1).

**Context:** Per ADR 0066 the Todo board must not be recovered by scanning history. We add a nullable `sessions.todos_json` column, a one-time backfill from each non-subagent session's newest non-read `manage_todo_list` row, accessors, and return the stored list as `todos` on the FIRST page (the call without `before_id`).

**Files:**
- Modify: `src-tauri/src/storage/db.rs`
- Modify: `src-tauri/src/commands/history.rs`

**What to implement:**
- `SCHEMA` const: add `todos_json TEXT` as the last column of `sessions`.
- In `Db::open`, after the `is_subagent` migration block, add a pragma-gated migration (same pattern): `SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'todos_json'`; when 0, open `conn.unchecked_transaction()` (as the `native_messages` FK migration does) and inside it run `ALTER TABLE sessions ADD COLUMN todos_json TEXT` **and then the backfill, then commit** — one transaction, so a crash between the ALTER and the backfill rolls both back and the next open retries (the column's presence is what gates the backfill, so a committed ALTER without a backfill would be a permanent miss). Backfill runs only on this branch, so it is one-time.
- Backfill (a private fn, e.g. `backfill_session_todos(conn: &Connection) -> Result<(), DbError>`): for each `id` in `SELECT id FROM sessions WHERE is_subagent = 0`, select tool-call rows newest-first, **prefiltered in SQL** so large unrelated `rawOutput` payloads are never parsed on the startup path: `SELECT payload_json FROM messages WHERE session_id = ?1 AND kind = 'tool-call' AND payload_json LIKE '%manage_todo_list%' ORDER BY id DESC`. Use `LIKE`, NOT `json_extract`: `json_extract` raises `malformed JSON` on a bad row (SQLite does not guarantee the `kind = …` conjunct short-circuits it), and an error here propagates out of `Db::open` and bricks startup — the failure class the FK migration's comments describe. The EXACT `payload.title == "manage_todo_list"` check happens in Rust, where an unparseable row is skipped. Add a test with a deliberately malformed `payload_json` row in the legacy DB proving `Db::open` still succeeds. For each row parse JSON; take the first where `payload.title == "manage_todo_list"`, `payload.rawInput.operation != "read"` (absent counts as write), and `payload.rawInput.todoList` is an array. Keep only array items having string `content` and string `status` (preserve `description` when a string — mirrors `useMainTodoItems`' old filter); if at least one item remains, `UPDATE sessions SET todos_json = ?2 WHERE id = ?1` with the filtered array serialized. Stop scanning that session at the first match. A parse failure on a row is skipped, never an error. Run the whole backfill inside a transaction.
- Accessors on `Db`: `pub fn record_session_todos(&self, id: &str, todos_json: Option<&str>) -> Result<(), DbError>` (`UPDATE sessions SET todos_json = ?2 WHERE id = ?1`; a missing row is a no-op) and `pub fn session_todos(&self, id: &str) -> Result<Option<String>, DbError>`.
- Do **not** add `todos_json` to `SessionRow` or `list_sessions` (the board travels only on the first history page).
- `history.rs`: when `before_id.is_none()`, fill `HistoryPage.todos` with `state.session_todos(&session_id)` parsed via `serde_json::from_str::<serde_json::Value>`; an unparseable string or `None` → `todos: None`. When `before_id` is `Some`, `todos` is `None`.

**Steps:**
- [ ] Write failing tests in `db.rs`: (a) `record_session_todos` then `session_todos` round-trips; `None` clears; a missing session id is a no-op and `session_todos` returns `None`; (b) a legacy DB (create the OLD `sessions` + `messages` schema WITHOUT `todos_json` in a temp file with `rusqlite::Connection`, insert a session with three `tool-call` rows — an older `manage_todo_list` write, a newer `manage_todo_list` with `operation: "read"`, and the newest non-read write — plus a subagent session with a todo row) → `Db::open` backfills the newest NON-read write for the main session only, leaves the subagent's `todos_json` NULL, and a second `Db::open` does not re-run (mutate `todos_json` to a sentinel between opens and assert it survives); (c) a session with no todo rows stays NULL. Write a failing `history.rs` test (or a `db`-level test of the same logic if the command is awkward to unit-test) asserting first-page `todos` is returned and a `before_id` page returns `None`. To make this testable without a Tauri `State`, extract the command body into a plain `pub(crate) fn history_page(db: &Db, session_id: &str, limit: Option<u32>, before_id: Option<i64>) -> Result<HistoryPage, DbError>` and have `load_history` call it; test `history_page` directly.
- [ ] Run `cd src-tauri && cargo test todos` — fails.
- [ ] Implement schema + migration + backfill + accessors + `HistoryPage.todos`.
- [ ] Run `cd src-tauri && cargo test` — all pass.
- [ ] Run `cargo fmt` and `cargo clippy --all-targets` — 0 warnings.
- [ ] Commit: "feat(todos): persist the todo board in sessions.todos_json with a one-time backfill"

**Acceptance criteria:**
- [ ] A fresh DB and a migrated legacy DB both have `sessions.todos_json`.
- [ ] The backfill picks the newest non-read write per main session, never touches subagent rows, and runs once.
- [ ] The first `load_history` page carries `todos`; later pages do not.

---

### Task 3: The Supervisor writes the board on every `todos_update`

**Parallel:** none — depends on Task 2's `Db::record_session_todos`.

**Context:** The Worker has no DB; its todo pushes pass through `SessionManager::route_event`'s `SinkFrame` arm (the UI re-emit). The Supervisor is the sole writer, so the persistence hook belongs there, for MAIN sessions only.

**Files:**
- Modify: `src-tauri/src/agent/persist.rs`
- Modify: `src-tauri/src/agent/session/router.rs`

**What to implement:**
- In `persist.rs` add `impl TranscriptPersister { pub fn apply_interactive_event(&self, session_id: &str, payload: &serde_json::Value) }`: if `payload["event"] == "todos_update"` and `payload["payload"]["todos"]` is an array → `self.db.record_session_todos(session_id, Some(&serde_json::to_string(todos)?))`; if `payload["event"] == "todos_clear"` → `record_session_todos(session_id, None)`; any other event, or a malformed payload, is ignored. Errors are `eprintln!`'d like the neighbouring methods, never propagated. Use the **`session_id` argument**, not `payload["sessionId"]`.
- In `router.rs`, in the `WorkerInboundEvent::SinkFrame { event, payload }` arm, BEFORE the existing re-emit consumes `payload`, add: `if !is_subagent && event == "interactive-event" { if let Some(p) = self.persister.get() { p.apply_interactive_event(session_id, &payload); } }`. The re-emit behavior must not change.

**Steps:**
- [ ] Write failing tests in `persist.rs`'s test module (use its `temp_db()` helper and a recorded session row): `todos_update` writes the list; a second `todos_update` replaces it; `todos_clear` sets NULL; an unrelated event and a payload without a `todos` array leave the column untouched. **Router tests are mandatory** (`router.rs` has a `mod tests` using `SessionManager::new` + `route_event`; `attach_db(&mut self, Arc<Db>)` installs the persister — follow the existing tests there): (i) a main session (`is_subagent: false`) `SinkFrame{event:"interactive-event", payload:{event:"todos_update",…}}` writes `todos_json` AND the frame is still re-emitted to the sink unchanged; (ii) the same frame with `is_subagent: true` (parent's delivery id) does NOT touch the parent's `todos_json`.
- [ ] Run `cd src-tauri && cargo test apply_interactive_event` — fails.
- [ ] Implement `apply_interactive_event` and the router hook.
- [ ] Run `cd src-tauri && cargo test` — all pass.
- [ ] Run `cargo fmt` and `cargo clippy --all-targets` — 0 warnings.
- [ ] Commit: "feat(todos): the supervisor persists a main session's todos_update frames"

**Acceptance criteria:**
- [ ] After a main-session `todos_update`, `Db::session_todos` returns the list; a subagent's never writes.
- [ ] The UI re-emit of the same frame is unchanged.

---

### Task 4: Frontend paging — `loadHistory` contract and store window

**Parallel:** none — modifies `src/lib/tauri.ts` and `src/store/sessions.ts`, and the `loadHistory` mocks in five shared test files that Task 5 also edits.

**Context:** The store must load only the tail (500 rows), remember the oldest loaded row id per session, expose `loadOlderHistory` (200 rows per call), reset the window on resume (ADR 0066 — rows scrolled back to are dropped), and seed the Todo board from the first page.

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/store/sessions.ts`
- Modify (mock shape + new tests): `src/store/sessions.test.ts`, `src/lib/tauri.test.ts`
- Modify (mock shape only: `loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false })`): `src/components/SessionStalledBanner.test.tsx`, `src/components/NewSessionErrorBanner.test.tsx`, `src/components/ChatStream.test.tsx`, `src/components/SpacesList.test.tsx`

**What to implement:**
- `tauri.ts`: `export interface HistoryPage { rows: MessageRow[]; hasMore: boolean; todos?: unknown[] | null }` and
  `export async function loadHistory(sessionId: string, opts?: { limit?: number; beforeId?: number }): Promise<HistoryPage>` → `invoke<HistoryPage>("load_history", { sessionId, limit: opts?.limit ?? null, beforeId: opts?.beforeId ?? null })`.
- `sessions.ts`:
  - `export const INITIAL_HISTORY_PAGE = 500; export const OLDER_HISTORY_PAGE = 200;`
  - State: `history: Record<string, { oldestRowId: number | null; hasMore: boolean; loadingMore: boolean; generation: number }>`, initial `{}`. A session with no entry behaves as `{ oldestRowId: null, hasMore: false, loadingMore: false, generation: 0 }`. `generation` increments every time the window is (re)initialised (open and resume), so the UI can remount the list.
  - `openSession`: call `loadHistory(sessionId, { limit: INITIAL_HISTORY_PAGE })`. **Seed the board FIRST, then write the transcript** (so the Side pane's hydration/auto-open edge sees board and messages together — ADR 0042's no-pop rule): if `Array.isArray(page.todos) && page.todos.length > 0` **and `!(sessionId in useInteractive.getState().todos)`** (a live `todos_update` that arrived during the fetch is newer than the DB read — never overwrite it) call `useInteractive.getState().applyTodoUpdate(sessionId, { todos: page.todos as TodoItem[] })` (import `useInteractive` from `./interactive`; reuse its `TodoItem` type). Then set `messages[sessionId] = page.rows.flatMap(rowToMessages)` and `history[sessionId] = { oldestRowId: page.rows[0]?.id ?? null, hasMore: page.hasMore, loadingMore: false, generation: prev + 1 }` in ONE `set`. Keep the existing "already loaded" early return and the "user switched away" guard.
  - `resumeSession`: same `loadHistory(sessionId, { limit: INITIAL_HISTORY_PAGE })`, use `page.rows` as `rows` in the existing ADR 0050 merge unchanged, and in the final `set` also write `history[sessionId]` from the page (`generation + 1`); seed todos with the same only-if-absent rule (before the final `set`). The merge's `prior`/`current` logic must not change.
  - `loadOlderHistory(sessionId): Promise<void>`: no-op unless `history[sessionId]` exists with `hasMore && !loadingMore && oldestRowId !== null`; capture `const gen = history[sessionId].generation`; set `loadingMore: true`; `loadHistory(sessionId, { limit: OLDER_HISTORY_PAGE, beforeId: oldestRowId })`; **then, inside the `set`, bail out (apply nothing) unless `state.history[sessionId]?.generation === gen`** — a `resumeSession` (which resets the window and bumps `generation`) or `deleteSession` (which removes the entry) that landed while the page was in flight must not have stale rows prepended onto the new tail or the entry resurrected. Otherwise **prepend** `page.rows.flatMap(rowToMessages)` to the CURRENT `messages[sessionId]` (read it fresh inside `set`, live messages may have appended); update `oldestRowId = page.rows[0]?.id ?? oldestRowId`, `hasMore = page.hasMore`, `loadingMore: false`, keep `generation`. On error: `loadingMore: false` and `console.error`, `hasMore` unchanged. Add it to the store's interface.
  - Delete `history[sessionId]` and `useInteractive` todos at every site that deletes `messages[sessionId]` for a MAIN session on user delete (`deleteSession`). Do NOT change `discardSessionMessages` (subagent transcripts are never paged).
- Update all the `loadHistory` mocks listed above to the new `{ rows, hasMore }` shape (`mockResolvedValue({ rows: [], hasMore: false })`, and wrap the rows arrays in the ~11 `mockImplementationOnce` sites of `sessions.test.ts` as `{ rows: […], hasMore: false }`, including the typed `resolveRows: (rows: MessageRow[]) => …` callbacks). Update `sessions.test.ts:~2868` `expect(loadHistory).toHaveBeenCalledWith("live-b")` to `("live-b", { limit: 500 })`, and reset `history: {}` in that file's `beforeEach` `setState`.

**Steps:**
- [ ] Write failing tests in `src/store/sessions.test.ts`: `openSession` requests `{ limit: 500 }` and stores `history.oldestRowId`/`hasMore`; `loadOlderHistory` calls `loadHistory(id, { limit: 200, beforeId })`, prepends (older rows first, live-appended message preserved at the end), updates the cursor, and is a no-op when `hasMore` is false or `loadingMore` is true (two concurrent calls issue ONE request); a failing page leaves `loadingMore: false`; **a page that resolves after a `resumeSession` (generation bumped) or a `deleteSession` is discarded** (messages and history untouched); a live `todos_update` that lands before the first page resolves is NOT overwritten by the seeded `todos`; `resumeSession` resets the window to the tail (an older-prepended store ends as just the reloaded tail + fresh), bumps `generation`; first-page `todos` seeds `useInteractive.todos[id]` and an empty/absent `todos` does not; `deleteSession` removes `history[id]`. Add a `src/lib/tauri.test.ts` case that `loadHistory` invokes `load_history` with `{ sessionId, limit: null, beforeId: null }` by default and with the options when given (follow that file's existing `invoke` mock pattern).
- [ ] Run `pnpm vitest run src/store/sessions.test.ts src/lib/tauri.test.ts` — new tests fail; mocks not yet migrated may also fail.
- [ ] Implement `tauri.ts` + `sessions.ts` changes and migrate the mocks.
- [ ] Run `pnpm vitest run src/store/sessions.test.ts src/lib/tauri.test.ts src/components/SessionStalledBanner.test.tsx src/components/NewSessionErrorBanner.test.tsx src/components/SpacesList.test.tsx src/components/ChatStream.test.tsx` — pass (`ChatStream.test.tsx` only changes its mock shape here).
- [ ] Run `pnpm test` — green (the whole frontend suite; nothing else depends on `loadHistory`'s old shape).
- [ ] Run `pnpm tsc --noEmit` — clean.
- [ ] Commit: "feat(history): page the history window in the sessions store"

**Acceptance criteria:**
- [ ] A session opens with ≤500 rows requested; scrolling-up API (`loadOlderHistory`) prepends 200-row pages and stops at the start.
- [ ] Resume resets the window; the ADR 0050 merge tests in `sessions.test.ts` still pass unmodified apart from the mock shape.
- [ ] First-page todos seed the interactive store.

---

### Task 5: The board reads session state only (delete the history scan)

**Parallel:** none — touches `store/interactive.ts` doc/semantics, `sessionLifecycle.ts` and shared test files; follows Task 4.

**Context:** With todos persisted and seeded (Task 4), `useMainTodoItems`' `rawInput` scan of `messages[]` is dead and, with a windowed store, wrong. Also `onSessionClosed` calls `dismissSession`, which deletes `todos[sessionId]`; the scan used to re-seed a closed session's board from its transcript, and nothing else would now — so a closed MAIN session must keep its board. `dismissSession` itself is NOT changed (see Facts).

**Files:**
- Modify: `src/components/TodoBoardPanel.tsx`
- Modify: `src/lib/sessionLifecycle.ts`
- Modify (comments/docs only, they describe the deleted seed): `src/store/interactive.ts` (the long `applyTodoClear`/`todos` doc comments — a MAIN session's `rawInput` seed no longer exists; a clear now leaves the board empty until the next `todos_update`), `src/store/sessions.ts` (the `rawInput` field comment, ~line 57), `src/hooks/useTodoBoards.ts` (doc rule 7: a child's board comes only from `useInteractive.todos`), `src/components/SidePane.tsx` (~lines 312–340 comments), `src/components/TodoRail.tsx` (~line 34 comment)
- Test: `src/components/TodoBoardPanel.test.tsx`, `src/components/SidePane.test.tsx`, `src/hooks/useTodoBoards.test.ts`, `src/lib/sessionLifecycle.test.ts`, `src/store/interactive.test.ts` (only if a test asserts the seed)

**What to implement:**
- `useMainTodoItems(sessionId)` returns `useInteractive((s) => sessionId ? s.todos[sessionId] : undefined) ?? EMPTY_TODOS` — a module-level `const EMPTY_TODOS: TodoItem[] = []` so the return is reference-stable. Delete the `useSessions` import, the `useMemo` scan and its comments; keep a short accurate doc comment (board = interactive store only; seeded from the persisted board on open/resume, ADR 0066).
- `onSessionClosed(sessionId, reason)` (`src/lib/sessionLifecycle.ts`): capture `const board = useInteractive.getState().todos[sessionId];` BEFORE `dismissSession`, and after it, `if (board) useInteractive.getState().applyTodoUpdate(sessionId, { todos: board });`. Everything else in that function is unchanged. (A subagent id never reaches `onSessionClosed` — no `session-closed` ever names a child — so child boards are still freed by `subagent-closed`.)
- Update every existing test that seeded a board via a `manage_todo_list` `rawInput` tool-call message to seed `useInteractive.getState().applyTodoUpdate(sessionId, { todos })` instead; delete or rewrite tests whose only subject was the `rawInput` fallback (`TodoBoardPanel.test.tsx` — the "both halves of that consequence" comment; `SidePane.test.tsx` ~lines 477–610 "openSession → loadHistory gap" cases — keep the invariant they pin, "hydration must not auto-expand the pane", but drive it through a first-page `todos` seed; any `SidePane.test.tsx` text saying "`todos` is never persisted").

**Steps:**
- [ ] Write/adjust failing tests: board shows from `useInteractive.todos` alone; a session with a `manage_todo_list` tool-call message but no board shows NOTHING; `onSessionClosed` keeps `todos[id]` for a main session (and `sessionLifecycle.test.ts`'s existing assertion `dismissSession` was called with `("test-session-123")` still holds); a board seeded through `openSession`'s first page renders and does not auto-open the pane (preserve the existing no-auto-expand invariant).
- [ ] Run `pnpm vitest run src/components/TodoBoardPanel.test.tsx src/components/SidePane.test.tsx src/hooks/useTodoBoards.test.ts src/lib/sessionLifecycle.test.ts src/store/interactive.test.ts` — fails.
- [ ] Implement the changes.
- [ ] Run the same command — pass. Then `pnpm tsc --noEmit` and `pnpm test` — green.
- [ ] Commit: "refactor(todos): the board reads session state, not the transcript"

**Acceptance criteria:**
- [ ] No code reads a board from `messages[]` (`rg "rawTodos|rawInput" src/components/TodoBoardPanel.tsx` is empty; `toolOutput.ts`'s labels are unrelated).
- [ ] A closed main session keeps its board in the store; `dismissSession` is unchanged.
- [ ] No comment still describes the `rawInput` seed as live behavior.

---

### Task 6: Dependency, pure building blocks and the global Virtuoso test setup

**Parallel:** none — installs a dependency (shared `package.json` / `pnpm-lock.yaml`), edits `vite.config.ts` and refactors `MessageList.tsx` which Task 7 rewrites.

**Context:** Everything Task 7 needs that can be built and tested WITHOUT yet swapping the list: the dependency, identity keys, the prepend-anchoring hook, the footer extraction, and a global jsdom setup so that virtualized rows render in every test file. Each piece is green on its own and the existing UI is unchanged after this task.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add -E react-virtuoso@4.18.19` — an EXACT pin, AGENTS.md prefers pinned toolchain pieces)
- Modify: `vite.config.ts` (`test.setupFiles: ["./src/test/setup.tsx"]`)
- Create: `src/test/setup.tsx`
- Create: `src/lib/transcript/unitKeys.ts`, `src/lib/transcript/unitKeys.test.ts`
- Create: `src/hooks/useFirstItemIndex.ts`, `src/hooks/useFirstItemIndex.test.ts`
- Create: `src/components/chat/TranscriptFooter.tsx`
- Modify: `src/components/chat/MessageList.tsx` (replace its inline tail with `<TranscriptFooter/>` only — no behavior change)

**What to implement:**
- `src/test/setup.tsx` (`.tsx` — it needs JSX; start it with `import { vi } from "vitest"` — `tsconfig.json` has no vitest globals types and `pnpm build` runs `tsc`): 
  - a global `vi.mock("react-virtuoso", async (importOriginal) => …)` that re-exports the real module but replaces `Virtuoso` with a plain function component that renders the real `Virtuoso` inside `<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 40 }}>` with `{...props}` spread (React 19 forwards `ref` as a prop, so no `forwardRef` is needed). **The wrapper must STRIP `initialTopMostItemIndex` before passing props to the real `Virtuoso`** — verified: under jsdom + `VirtuosoMockContext`, a real initial-index prop renders 0 rows synchronously (the scroller's `offsetHeight` is 0 so its scroll helper returns early) and rows only appear after ~4 animation frames; with it stripped, `firstItemIndex` + `alignToBottom` + `increaseViewportBy` + `followOutput` + `components` + `context` + `StrictMode` render rows and the Footer SYNCHRONOUSLY, which the ~290 existing synchronous `render(<ChatStream/>)`/`render(<App/>)` assertions need. The initial-index prop is tested only through a per-file captured mock (Task 7 test (a)). Do NOT stub `offsetHeight` globally (`ChatStream.tsx:~424` reads `el.offsetHeight` for textarea sizing).
  - `Element.prototype.scrollBy` and `Element.prototype.scrollTo` stubbed to no-ops (jsdom 30 lacks them; a prepend calls `scrollBy` and `scrollToIndex` calls `scrollTo`, so a real-Virtuoso prepend test throws `scrollBy is not a function` without it).
  - Test-file `vi.mock("react-virtuoso")` overrides still win over this global mock (verified).
- `unitKeys.ts` — pure functions over `RenderUnit[]` (`src/lib/toolGroups.ts`) / `Message` (`src/store/sessions.ts`):
  - `messageKey(m: Message): string` → `tool:${id}` (tool-call), `text:${messageId}`, `thought:${messageId}`, `diff:${path}:${at}`, `user:${at}`.
  - `unitKeys(units: RenderUnit[]): string[]` → each unit's key = `messageKey` of its FIRST message (a `changes-group` uses its first member), duplicates disambiguated in order by a `#n` suffix (second occurrence `…#1`) so keys are unique.
  - `unitContainsKey(unit: RenderUnit, key: string): boolean` (single: its message's `messageKey === key`; group: any member's).
  - `prependedUnitCount(prevFirstMessageKey: string | undefined, units: RenderUnit[]): number` → the index of the first unit that `unitContainsKey(prevFirstMessageKey)`, else `0` (also `0` for `undefined`). A `Changes` group straddling a page boundary merges with the previously-first group and still *contains* the old first key, so the count stays right. Known, accepted rarities (document in a comment): a same-ms duplicate `user:${at}` or the `"default"` messageId fallback can make a prepended older duplicate steal a `#0` suffix; a merged group's own key changes (its first member changed), so that ONE row remounts.
- `useFirstItemIndex.ts`: `useFirstItemIndex(units: RenderUnit[], sessionId: string, generation: number): number` returning Virtuoso's `firstItemIndex`. Use **derived state, not a ref mutated in render** (StrictMode double-invokes render; abandoned renders must not leave state behind): `const [st, setSt] = useState({ sessionId, generation, firstKey, index: START_INDEX })`; during render, if `sessionId`/`generation` changed → `setSt({ …, firstKey: firstKeyOf(units), index: START_INDEX })`; else if `firstKeyOf(units) !== st.firstKey` → `const n = prependedUnitCount(st.firstKey, units)`; `setSt({ …, firstKey: firstKeyOf(units), index: st.index - n })` (React permits setState during render for derived state). `START_INDEX = 100_000`. Return the current `st.index` (after the derivation). `firstKeyOf(units)` = `messageKey` of the first message of the first unit, `undefined` for empty. A pure live append never changes the first key, so the index is stable.
- `TranscriptFooter.tsx` — props-only, extracted verbatim from the current tail of `MessageList` (stacked `PermissionPrompt`s, stacked `AskQuestionCard`s, the `childGates.filter(isInlineChildGate)` block with its `Escape` stop, `↳ agentName` chip and `childGateKey`, `FileSummaryCard`, the stop-reason line). In THIS task it returns a **Fragment** of exactly the children the old tail rendered — no wrapper element, no spacer — so the old container's `gap-3` still supplies the spacing and the UI is byte-for-byte unchanged. Also export `transcriptFooterIsEmpty(props): boolean` (true when there are no prompts, no stacked asks, no inline child gates, no `turnDiffs`, and no stop-reason line) for Task 7's Footer wrapper. Move the long explanatory comments with the code. `MessageList` renders `<TranscriptFooter …/>` where the tail was.

**Steps:**
- [ ] `pnpm add -E react-virtuoso@4.18.19`.
- [ ] Write failing tests: `unitKeys.test.ts` (key shapes; duplicate `#1`; `prependedUnitCount`: no-op, plain prepend of N units, prepend where a `changes-group` merges with the old first group, key not found → 0, undefined → 0); `useFirstItemIndex.test.ts` with `renderHook` (stable on live append; decreases by N on prepend; resets to `START_INDEX` on `sessionId` or `generation` change; stable under `React.StrictMode`); a setup smoke test (`src/test/setup.test.tsx`) that renders `<Virtuoso>` with Task 7's EXACT prop set (`data`, `firstItemIndex={99_990}`, `alignToBottom`, `initialTopMostItemIndex={{index:"LAST",align:"end"}}` (stripped by the wrapper), `followOutput`, `increaseViewportBy`, `components={{Header,Footer}}`, `context`) inside `<React.StrictMode>` and asserts all rows AND the Footer are found with a SYNCHRONOUS `getByText` (not `findBy`) — a bare three-row `Virtuoso` would pass while the real one does not; the existing `MessageList.gap.test.tsx` and gate tests must pass unmodified after the footer extraction.
- [ ] Run `pnpm vitest run src/lib/transcript/unitKeys.test.ts src/hooks/useFirstItemIndex.test.ts src/test src/components/chat` — fails.
- [ ] Implement the files above and the `MessageList` footer extraction.
- [ ] Run the same command — pass.
- [ ] Run `pnpm test` and `pnpm build` — green.
- [ ] Commit: "chore(chat): add react-virtuoso, unit keys, prepend anchoring hook and footer extraction"

**Acceptance criteria:**
- [ ] Rows render under jsdom through the global setup.
- [ ] `prependedUnitCount` / `useFirstItemIndex` handle plain, merged-group, reset and StrictMode cases.
- [ ] The UI is unchanged (DOM identical for the footer); `pnpm test` and `pnpm build` are green.

---

### Task 7: Virtualize `MessageList` and wire `ChatStream` — paging, prepend anchoring, follow rules

**Parallel:** none — rewrites `MessageList.tsx` and `ChatStream.tsx` and their large shared test files; follows Task 6.

**Context:** Swap the plain scroll `div` for `<Virtuoso>`. `MessageList` owns ALL scroll behavior (it is rendered only past `ChatStream`'s early returns, so its hooks are order-safe): infinite scroll-up, prepend anchoring, follow-at-bottom (including in-place growth of a streaming reply), jump-to-bottom on send, and scrolling a new gate card into view. `ChatStream` only supplies history state. `MessageList` stays free of store reads — all inputs arrive as props.

**Files:**
- Modify: `src/components/chat/MessageList.tsx`
- Modify: `src/components/ChatStream.tsx`
- Test (rewrite as needed): `src/components/chat/MessageList.gap.test.tsx`, `src/components/ChatStream.test.tsx`, `src/App.test.tsx`

**What to implement — `MessageList.tsx`:**
- Props: remove `scrollRef`; add `hasMore: boolean`, `loadingMore: boolean`, `generation: number`, `onStartReached: () => void`. Internally: `const virtuosoRef = useRef<VirtuosoHandle>(null)`, `const keys = unitKeys(units)` (a plain per-render computation — NOT `useMemo`: `units` is a fresh array every `ChatStream` render, so a memo keyed on it never hits; the O(n) pass is accepted), `const firstItemIndex = useFirstItemIndex(units, activeSessionId, generation)`.
- Non-empty (`units.length > 0`): `<Virtuoso key={activeSessionId + ":" + generation} ref={virtuosoRef} data-testid="transcript-scroll" data={units} firstItemIndex={firstItemIndex} computeItemKey={(index) => activeSessionId + ":" + keys[index - firstItemIndex]} initialTopMostItemIndex={{ index: "LAST", align: "end" }} alignToBottom followOutput={(atBottom) => (atBottom ? "auto" : false)} atBottomThreshold={80} startReached={onStartReached} increaseViewportBy={{ top: 600, bottom: 600 }} className="flex-1 min-w-0 max-w-full overflow-x-hidden" context={…} components={{ Header, Footer }} itemContent={…} />`. NOTE `computeItemKey` receives the ABSOLUTE index (`originalIndex + firstItemIndex`); the same offset applies to `itemContent`'s index — use `const i = index - firstItemIndex` for `units[i - 1]`, the tool-pair rule and the streaming check (`i === units.length - 1`). `Header`/`Footer` are **module-level** components reading props from Virtuoso's `context` (never inline lambdas — a new component identity per render remounts the footer and drops focus/state).
- Item wrapper: `div` with `min-w-0 max-w-full flex flex-col px-4` and a **top padding** replacing `gap-3`/`mt-4`: none for `i === 0`; `pt-7` (28px = 12 + 16) when `isToolUnit(units[i-1]) || isToolUnit(unit)`; otherwise `pt-3` (12px). The container's old `p-4`: `Header` renders `pt-4` (plus the spinner / "Start of conversation" row, below) and `Footer` renders `px-4 pb-4` around `<TranscriptFooter/>`, with a `pt-3` spacer and an inner `flex flex-col gap-3` ONLY when `!transcriptFooterIsEmpty(…)` (the spacing the old container `gap-3` used to supply). Do NOT put padding on `components.List` (that would need a custom forwardRef List and fights Virtuoso's measuring).
- `Header`: a FIXED-height row (`h-6`, same height in every state so the swap never shifts the scroll position): spinner while `loadingMore`; `Start of conversation` (`text-ui-sm text-foreground-subtlest`) when `!hasMore && units.length > 0`; otherwise an empty `h-6` row. `startReached` may fire repeatedly — `onStartReached` is idempotent (`loadingMore` guard in the store).
- Empty (`units.length === 0`): no Virtuoso. Render the old non-virtualized wrapper `<div ref={emptyRef} data-testid="transcript-scroll" className="flex-1 flex flex-col gap-3 overflow-y-auto overflow-x-hidden min-w-0 max-w-full p-4">` with the "Send a prompt to start" hint (existing conditions) and `<TranscriptFooter/>`.
- Scroll effects (all in `MessageList`, all guarded so they never fight a user who scrolled up):
  1. **Gate cards**: `useEffect` on `[prompts.length, stackedAskRequests.length, childGates.filter(isInlineChildGate).length]` → if Virtuoso is mounted, **defer one frame** — `requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" }))` (the new card is in the Footer and Virtuoso adds the footer height as of the moment the call fires; the effect runs in the commit that mounts the card, before the Footer's `ResizeObserver` has measured it, so an immediate call can land short); cancel the frame in the cleanup. Else (empty branch) `emptyRef.current.scrollTop = emptyRef.current.scrollHeight` immediately. This frame-timing cannot be verified in jsdom — see the manual smoke step in Task 8. Move the rationale comment (an un-scrolled view would hide the card the user must answer) here.
  2. **Streaming in-place growth**: `followOutput` only reacts to a changed item COUNT, so streamed text appended to the last message would stop following after the first delta. Track whether the list is at the bottom with `atBottomStateChange={(b) => { atBottomRef.current = b; }}` (a ref, initial `true`). Compute `tailSig` in render (last unit's last message: for text/thought `kind:text.length`; for tool-call `kind:status`; else `kind`) and `useEffect(() => { if (atBottomRef.current) virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" }); }, [tailSig])`. Do NOT use `autoscrollToBottom()` here: it only fires once the tail has grown past `atBottomThreshold` (80px), so the reply would lag and then snap. The ref is still `true` when the effect runs (Virtuoso has not measured the growth yet), and a user who scrolled up has `atBottomRef.current === false`, so they are never yanked.
  3. **Send**: when `units.length` grew and the LAST unit is a `user` message that was not the last unit of the previous render (track the previous last-user key in a ref), call `scrollToIndex({ index: "LAST", align: "end" })` unconditionally — a send lands at the bottom even if the user had scrolled up (ADR 0066).

**What to implement — `ChatStream.tsx`:**
- ABOVE the early `if (!activeSessionId) return …` (~line 873) declare: `const history = useSessions((s) => activeSessionId ? s.history[activeSessionId] : undefined)` (a stable reference — never build a fresh object in a selector) and `const loadOlder = useSessions((s) => s.loadOlderHistory)`. Derive `hasMore = history?.hasMore ?? false`, `loadingMore = history?.loadingMore ?? false`, `generation = history?.generation ?? 0`.
- Pass to `<MessageList>`: `hasMore`, `loadingMore`, `generation`, `onStartReached={() => { if (activeSessionId) void loadOlder(activeSessionId); }}`. Remove `scrollRef` (declaration ~line 279, prop, and the `scrollTop = scrollHeight` effect ~line 860). Nothing else in `ChatStream` scrolls. (Accepted: `turnDiffs`/`lastUserIndex` (~line 1247) scan the window, so a single turn longer than the window yields a partial `FileSummaryCard`.)

**Steps:**
- [ ] Run `pnpm vitest run src/components/ChatStream.test.tsx src/App.test.tsx src/components/chat` BEFORE changing code to record the baseline (green).
- [ ] Write failing tests: (a) `MessageList` passes `startReached` through — drive it with a mocked `Virtuoso` (`vi.mock("react-virtuoso")` in that test file, capturing props) and assert `onStartReached` is wired and `computeItemKey` returns unique, stable keys for `firstItemIndex = 100000 − k` (index-offset regression); (b) `firstItemIndex` prop decreases by the prepended unit count and resets on `generation` change (via the captured props); (c) a gate-count change calls `scrollToIndex({index:"LAST"})` one animation frame later (use `vi.useFakeTimers()` + `vi.advanceTimersByTime(16)` or a stubbed `requestAnimationFrame`) when units exist, and writes `scrollTop` immediately in the empty branch; (d) a `tailSig` change calls `scrollToIndex({index:"LAST"})` when `atBottomStateChange(true)` was last reported and does NOT when it last reported `false`; (e) a new trailing `user` unit calls `scrollToIndex` even when not at bottom; (f) header shows spinner / `Start of conversation` with fixed height; (g) a rendered `Reasoning` row keeps its expanded state across a prepend (same key → same node); (h) rhythm: item wrapper classes — first none, plain pair `pt-3`, tool-adjacent `pt-7`, run of tool rows steady `pt-7`, `changes-group` counts as a tool row; child-gate cases against the footer (the `Escape` stop, `↳ agent` chip).
- [ ] Run `pnpm vitest run src/components/chat src/components/ChatStream.test.tsx src/App.test.tsx` — new tests fail.
- [ ] Implement `MessageList` and `ChatStream` changes.
- [ ] Rewrite the tests that pinned the old DOM: `MessageList.gap.test.tsx` (positional `scroll.children`/`gap-3`/`mt-4` → the wrapper `pt-*` classes and footer), `ChatStream.test.tsx` scroll-position tests (~lines 6221–6312: assert `scrollTop = scrollHeight` → assert effects 1–3 above; seed at least one message where the test targets the Virtuoso branch), and position-based queries. Keep every other test's intent.
- [ ] Run `pnpm vitest run src/components src/App.test.tsx src/store src/hooks src/lib` — pass.
- [ ] Run `pnpm test` and `pnpm build` — green.
- [ ] Commit: "feat(chat): virtualize the transcript, page on scroll-up, follow output at the bottom"

**Acceptance criteria:**
- [ ] Reaching the top fetches the next 200-row page; the viewport does not jump; same-key rows keep their DOM and state across a prepend.
- [ ] A streaming reply is followed only while the user is at the bottom; sending always lands at the bottom; a new gate card scrolls into view (virtualized and empty transcript alike).
- [ ] Rhythm values (12px base, 28px next to a tool row) are unchanged; `MessageList` still reads no store.
- [ ] A resume remounts the list at the bottom.
- [ ] `pnpm test` and `pnpm build` are green.

---

### Task 8: Ship — full validation and cleanup

**Parallel:** none — a whole-tree serial gate.

**Context:** Final verification per `AGENTS.md`, plus the "plans are deleted on ship" convention. Durable content already lives in ADR 0066 and `CONTEXT.md`.

**Files:**
- Delete: `docs/roadmap/history-window.md` (only when the user ships/merges — on the feature branch's last commit)

**Steps:**
- [ ] Run `pnpm test` — all pass.
- [ ] Run `pnpm build` — succeeds (type-check + build).
- [ ] Run `cd src-tauri && cargo test` — all pass.
- [ ] Run `cd src-tauri && cargo clippy --all-targets` — 0 warnings.
- [ ] Run `cd src-tauri && cargo fmt --check` — clean.
- [ ] Manual smoke (`pnpm tauri dev`): open a session with >500 rows → only the tail appears, scroll up loads more with no jump; stream a reply while scrolled up → the view is not yanked; stream while at the bottom → it follows; reload a long session whose last todo write is old → the Side-pane board is present; while scrolled up, a new permission/`ask` card appears → it is brought fully into view (frame timing — not verifiable in jsdom); sending a prompt while scrolled up lands at the bottom; a streaming reply follows without lagging when at the bottom.
- [ ] Delete `docs/roadmap/history-window.md` and commit: "docs: ship history-window (delete roadmap)".

**Acceptance criteria:**
- [ ] All five validation commands are green.
- [ ] The manual smoke checks above behave as described.
