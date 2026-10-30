---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/136
done-when: Unit and integration tests verify that session titling sends `{sessionId}-title` on the wire, generates an initial title at turn 1 (`title_stage: 0 -> 1`), refines the title at interaction 5 (`title_stage: 1 -> 2`), updates SQLite atomically without duplicate runs across restarts, existing pre-migration titled sessions are preserved at stage 2, and full validation (`cargo test`, `cargo clippy --all-targets`, `pnpm test`, `pnpm build`) is green.
---

# Two-Stage Async Session Titling with Wire Isolation Plan

**Goal:** Provide responsive, non-blocking session naming by decoupling titling requests from the main chat on the wire (`{sessionId}-title`) and upgrading to a two-stage titling lifecycle (initial title at turn 1, refined title at interaction 5).

**Architecture:** Titling runs entirely in the Supervisor as detached Tokio tasks with bounded tokens (`max_tokens: Some(100)`). On the wire, `session_id` carries `{sessionId}-title`, stamping `x-litellm-session-id: <id>-title` and a unique `x-request-id: <id>-title-<uuid>` via a shared constant `TITLE_SESSION_SUFFIX = "-title"` to isolate proxy logging and avoid session concurrency locks. Lifecycle progression is persisted atomically in SQLite via a new `title_stage` column (`0 -> 1 -> 2`), evaluated deterministically from `native_messages` interaction counts at `agent_end`.

**Tech Stack:** Rust, SQLite (rusqlite), Tokio, reqwest/LiteLLM headers, Tauri event sink (`session-titled`).

---

## Parallelisation

**Verdict:** SERIAL — `archimedes` is one compilation unit, and every task touches or depends on core Rust crates (`storage::db`, `provider::transport`, `agent::session::naming`). Tasks must be implemented and verified in order.

---

### Task 1: SQLite Schema, Migration, and Staged Title Persistence

**Parallel:** none — foundational database schema and persistence methods required by subsequent tasks.

**Context:**
Currently, `sessions` only stores `title TEXT`, and `set_session_title` writes `WHERE title IS NULL`. To support two-stage titling (Stage 1 at turn 1, Stage 2 at interaction 5) and ensure idempotency across app restarts, the `sessions` table needs a `title_stage INTEGER NOT NULL DEFAULT 0` column. Writing must be atomic and conditional on the expected prior stage (`WHERE title_stage = ?`).
Pre-existing sessions that already carry a title from the single-stage era must be migrated to `title_stage = 2` so their settled titles are preserved and not unexpectedly overwritten when the user continues working in them.

**Files:**
- Modify: `src-tauri/src/storage/db.rs`
- Test: `src-tauri/src/storage/db.rs` (unit tests in `mod tests`)

**What to implement:**
1. In `src-tauri/src/storage/db.rs`:
   - In `const SCHEMA` (`CREATE TABLE IF NOT EXISTS sessions`, line 1319): Append `title_stage INTEGER NOT NULL DEFAULT 0` at the end of the column list (after `sort_order`).
   - In `Db::open` (after line 353, following `sessions.sort_order` migration): Add migration checking `pragma_table_info('sessions')` for `title_stage`:
     ```rust
     let has_title_stage: i64 = conn.query_row(
         "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'title_stage'",
         [],
         |row| row.get(0),
     )?;
     if has_title_stage == 0 {
         let tx = conn.unchecked_transaction()?;
         tx.execute(
             "ALTER TABLE sessions ADD COLUMN title_stage INTEGER NOT NULL DEFAULT 0",
             [],
         )?;
         // Existing titled sessions are migrated to stage 2 so they are preserved
         // and not overwritten by an unexpected stage-2 re-title.
         tx.execute(
             "UPDATE sessions SET title_stage = 2 WHERE title IS NOT NULL",
             [],
         )?;
         tx.commit()?;
     }
     ```
   - In `SessionRow`: Add `pub title_stage: i64`.
   - In `Db::session`: Update the SELECT query (line 645) to include `title_stage` as column index 9 and map it with `title_stage: row.get(9)?`.
   - In `Db::list_sessions`: Update both SELECT queries (lines 692, 697) to include `title_stage` and map it into `SessionRow`.
   - Implement `set_session_title_stage`:
     ```rust
     pub fn set_session_title_stage(
         &self,
         id: &str,
         title: &str,
         from_stage: i64,
         to_stage: i64,
     ) -> Result<bool, DbError> {
         let n = self.conn.lock().expect("db mutex poisoned").execute(
             "UPDATE sessions SET title = ?2, title_stage = ?4 WHERE id = ?1 AND title_stage = ?3",
             params![id, title, from_stage, to_stage],
         )?;
         Ok(n > 0)
     }
     ```
   - Update `set_session_title` to delegate to `self.set_session_title_stage(id, title, 0, 1)` for backwards compatibility with test fixtures.

**Steps:**
- [ ] Write failing unit tests in `src-tauri/src/storage/db.rs` under `mod tests`:
  - `set_session_title_stage_transitions_from_0_to_1`
  - `set_session_title_stage_transitions_from_1_to_2`
  - `set_session_title_stage_fails_on_mismatched_from_stage`
  - `title_stage_migrates_existing_titled_sessions_to_stage_2_and_untitled_to_0` (following legacy schema test pattern at ~line 2860).
- [ ] Run `cargo test --lib storage::db` from `src-tauri/`
  - Verify that tests fail as expected (missing `title_stage` and method).
- [ ] Implement `SCHEMA` change, `Db::open` migration, `SessionRow` field, SELECT updates, and `set_session_title_stage` in `src-tauri/src/storage/db.rs`.
- [ ] Run `cargo test --lib storage::db` from `src-tauri/`
  - Verify that all database unit tests pass.
- [ ] Run `cargo fmt --check` from `src-tauri/`
- [ ] Run `cargo clippy --all-targets` from `src-tauri/`
- [ ] Commit with message: `feat(storage): add title_stage column, migration, and set_session_title_stage`

**Acceptance criteria:**
- [ ] `Db::open` migrates pre-existing databases by adding `title_stage` and marking already-titled sessions as `title_stage = 2`.
- [ ] Fresh databases create `sessions` with `title_stage INTEGER NOT NULL DEFAULT 0`.
- [ ] `set_session_title_stage` returns `Ok(true)` only when `id` matches AND current `title_stage == from_stage`.
- [ ] `cargo test --lib storage::db` passes with 0 failures.

---

### Task 2: Wire Isolation & Context Extraction Primitives

**Parallel:** none — depends on Task 1 and implements the wire header shaping and dialogue extraction functions.

**Context:**
To decouple titling from the main conversation in LiteLLM and proxy dashboards, titling requests must use `{sessionId}-title`. In `transport::litellm_headers`, a `-title` session ID should produce a unique `x-request-id: <sessionId>-title-<uuid>`.
Additionally, Stage 2 titling requires counting user interactions and extracting a multi-turn conversation excerpt up to turn 5.
Note: Add `#[allow(dead_code)]` to `count_user_interactions` and `multi_turn_exchange_text` in this task so `cargo clippy --all-targets` has 0 warnings before they are wired to `SessionManager` in Task 3.

**Files:**
- Modify: `src-tauri/src/agent/harness/provider/transport.rs`
- Modify: `src-tauri/src/agent/session/naming.rs`
- Test: `src-tauri/src/agent/harness/provider/transport.rs` (unit tests in `mod tests`)
- Test: `src-tauri/src/agent/session/naming.rs` (unit tests in `mod tests`)

**What to implement:**
1. In `src-tauri/src/agent/harness/provider/transport.rs`:
   - Define `pub(crate) const TITLE_SESSION_SUFFIX: &str = "-title";`.
   - Update `litellm_headers(session_id: Option<&str>) -> Vec<(String, String)>`:
     ```rust
     pub(crate) fn litellm_headers(session_id: Option<&str>) -> Vec<(String, String)> {
         match session_id {
             Some(sid) => {
                 let request_id = if sid.ends_with(TITLE_SESSION_SUFFIX) {
                     format!("{sid}-{}", uuid::Uuid::new_v4())
                 } else {
                     sid.to_string()
                 };
                 vec![
                     ("x-litellm-session-id".to_string(), sid.to_string()),
                     ("x-request-id".to_string(), request_id),
                 ]
             }
             None => Vec::new(),
         }
     }
     ```
   - In `transport.rs` `mod tests`: Add unit tests:
     - `litellm_headers_sets_unique_uuid_request_id_for_title_suffix` (asserts `x-litellm-session-id == "sess-1-title"` and `x-request-id` starts with `"sess-1-title-"` and trailing part parses as `uuid::Uuid`).
     - `litellm_headers_sets_identical_request_id_for_normal_session` (asserts `x-request-id == "sess-1"`).
2. In `src-tauri/src/agent/session/naming.rs`:
   - Implement `count_user_interactions(messages: &[ChatMessage]) -> usize`:
     - Maintain `ask_tool_call_ids: HashSet<String>`.
     - When inspecting `ChatMessage` with `role == ChatRole::Assistant`:
       If `m.tool_calls` contains any `ToolCall` with `name == "ask"`, insert its `id` into `ask_tool_call_ids`.
     - When inspecting `ChatMessage` with `role == ChatRole::User`:
       If `!message_text(&m.content).trim().is_empty()`, increment interaction count.
     - When inspecting `ChatMessage` with `role == ChatRole::Tool`:
       If `m.tool_call_id` is in `ask_tool_call_ids`:
       Extract text via `message_text(&m.content)`.
       If `text.trim_start().starts_with("User answers:")`, increment interaction count (multi-question `ask` counts as 1 interaction; cancelled `ask` starting with `"User cancelled"` is ignored).
   - Implement helper `clean_ask_selection(text: &str) -> String`:
     Extract the content between `"User answers:\n"` and `"\n\nAnswer context:"` (or end of string), trimmed.
   - Implement `multi_turn_exchange_text(messages: &[ChatMessage], max_interactions: usize) -> Option<String>`:
     - Collects up to `max_interactions` interactions (prompts and ask selections) along with the `Assistant` text response closing each turn (the last non-empty assistant text before the next user prompt or end of transcript).
     - Formats user prompts: `User: <cap_chars(text, 400)>`.
     - Formats ask selections: `User (selection): <cap_chars(clean_ask_selection(text), 200)>`.
     - Formats assistant responses: `Assistant: <cap_chars(text, 400)>`.
     - Joins formatted lines with `\n`. Total joined text capped at 2,500 chars via `cap_chars`.
     - Returns `None` if no lines were generated.
   - Decorate both functions with `#[allow(dead_code)]` with a comment explaining they are wired in Task 3.

**Steps:**
- [ ] Write failing unit tests in `src-tauri/src/agent/harness/provider/transport.rs`:
  - `litellm_headers_sets_unique_uuid_request_id_for_title_suffix`
  - `litellm_headers_sets_identical_request_id_for_normal_session`
- [ ] Write failing unit tests in `src-tauri/src/agent/session/naming.rs`:
  - `count_user_interactions_counts_prompts_and_answered_asks_blocks` (using `MessageContent::Blocks`)
  - `count_user_interactions_ignores_cancelled_asks_and_tool_outputs`
  - `multi_turn_exchange_text_formats_up_to_5_interactions_with_caps`
  - `multi_turn_exchange_text_returns_none_when_empty`
- [ ] Run `cargo test --lib agent::harness::provider::transport` and `cargo test --lib agent::session::naming`
  - Verify that tests fail as expected.
- [ ] Implement `TITLE_SESSION_SUFFIX` and `litellm_headers` in `transport.rs`.
- [ ] Implement `count_user_interactions`, `clean_ask_selection`, and `multi_turn_exchange_text` in `naming.rs`.
- [ ] Run `cargo test --lib agent::harness::provider::transport` and `cargo test --lib agent::session::naming`
  - Verify that tests pass.
- [ ] Run `cargo fmt --check` and `cargo clippy --all-targets` from `src-tauri/`
  - Verify 0 clippy warnings.
- [ ] Commit with message: `feat(agent): add wire-isolated headers, interaction counting, and multi-turn excerpting`

**Acceptance criteria:**
- [ ] `litellm_headers` with `Some("sess-1-title")` produces `x-litellm-session-id: sess-1-title` and `x-request-id: sess-1-title-<uuid>`.
- [ ] `count_user_interactions` accurately counts user prompts and answered `ask` selections across `MessageContent::Blocks`.
- [ ] `multi_turn_exchange_text` extracts clean user selections without answer context boilerplate and caps total length.
- [ ] `cargo clippy --all-targets` passes with 0 warnings.

---

### Task 3: Staged Titling Trigger Logic, Integration Tests, and Docs

**Parallel:** none — connects the database persistence (Task 1) and extraction/wire primitives (Task 2) into the router and naming task, and updates docs/comments.

**Context:**
With the storage layer and extraction primitives in place, the Supervisor's `maybe_name_session` and `name_session` functions must be updated to evaluate `title_stage` on `agent_end`, generate the appropriate excerpt (Stage 1 vs Stage 2), send bounded tokens (`max_tokens: Some(100)`), and update `title_stage` atomically in SQLite. Remove `#[allow(dead_code)]` from Task 2.
Also update ADR 0037 / `CONTEXT.md` to document the two-stage lifecycle and `{id}-title` wire isolation.

**Files:**
- Modify: `src-tauri/src/agent/session/naming.rs`
- Modify: `CONTEXT.md`
- Create: `docs/decisions/0084-two-stage-async-session-titling-with-wire-isolation.md`
- Test: `src-tauri/src/agent/session/naming.rs` (integration tests in `mod tests`)

**What to implement:**
1. In `NamingRequest` (`naming.rs`):
   - Add fields `from_stage: i64` and `to_stage: i64`.
2. In `SessionManager::maybe_name_session` (`naming.rs`):
   - Remove `#[allow(dead_code)]` from `count_user_interactions` and `multi_turn_exchange_text`.
   - Update guard step 3:
     ```rust
     let Ok(Some(row)) = db.session(session_id) else {
         return;
     };
     if row.is_subagent || row.title_stage >= 2 {
         return;
     }
     ```
   - Load `messages = SessionStore::new(db.clone()).load_messages(session_id)`.
   - Compute `interactions = count_user_interactions(&messages)`.
   - Determine stage and extract conversation excerpt:
     ```rust
     let (from_stage, to_stage, exchange) = if row.title_stage == 0 && interactions >= 1 {
         let Some(exchange) = first_exchange_text(&messages) else {
             return;
         };
         (0, 1, exchange)
     } else if row.title_stage == 1 && interactions >= 5 {
         let Some(exchange) = multi_turn_exchange_text(&messages, 5) else {
             return;
         };
         (1, 2, exchange)
     } else {
         return;
     };
     ```
   - Verify `Handle::try_current()` and claim `in_flight` under the lock (re-checking `fails >= MAX_FAILURES || in_flight`).
   - Spawn `name_session` passing `from_stage` and `to_stage` in `NamingRequest`.
3. In `name_session` (`naming.rs`):
   - In `ModelRequest`:
     - Set `session_id: Some(format!("{session_id}{TITLE_SESSION_SUFFIX}"))`.
     - Set `options.max_tokens: Some(100)` (generous for a 3–8 word title while safe for reasoning models).
   - In stream drain:
     - If `Done(FinishReason::Length)` occurs: check `clean_title(&text)`. If a valid non-empty title was parsed before truncation, accept it rather than failing immediately.
   - On completion:
     - Call `request.db.set_session_title_stage(session_id, &title, request.from_stage, request.to_stage)`.
     - If `Ok(true)`: call `note_success` and emit `session-titled` to `sink`.
     - If `Ok(false)`: do nothing (stage changed mid-flight, write dropped harmlessly).
     - If `Err(e)`: call `note_failure`.
4. Update existing tests in `naming.rs`:
   - `the_first_agent_end_titles_the_session_once`: change assertion to `assert_eq!(req.session_id.as_deref(), Some(&format!("{id}-title")));`.
   - `the_naming_model_override_resolves_through_the_effective_catalog`: change assertion to expect `{id}-title`.
   - Update `Harness` helpers:
     - Add `seed_multi_interaction_transcript(&self, id: &str, interaction_count: usize)` helper.
     - Add `set_stage(&self, id: &str, stage: i64)` helper.
5. Add new tests in `naming.rs`:
   - `stage_1_titles_on_first_turn_and_sets_stage_1`
   - `stage_2_retitles_when_interactions_reach_5`
   - `subsequent_agent_end_after_stage_2_is_noop`
   - `stage_race_where_stage_changed_mid_flight_drops_write_silently`
   - `resumed_session_at_stage_1_triggers_stage_2_at_turn_5`
6. Update documentation:
   - Create ADR `docs/decisions/0084-two-stage-async-session-titling-with-wire-isolation.md` amending ADR 0037.
   - Update `CONTEXT.md` under **Session title** to record the two-stage lifecycle and `{id}-title` wire isolation.
   - Update comments in `naming.rs` (module header, step 3 guard, and `ModelRequest.session_id` attribution comment).

**Steps:**
- [ ] Write failing integration tests in `src-tauri/src/agent/session/naming.rs` for two-stage progression, `{sessionId}-title` wire assertion, and stage race.
- [ ] Run `cargo test --lib agent::session::naming`
  - Verify that new tests fail as expected.
- [ ] Implement `from_stage`/`to_stage` in `NamingRequest`, trigger gates in `maybe_name_session`, and bounded execution in `name_session`.
- [ ] Update existing tests in `naming.rs` where `session_id` on `ModelRequest` changed to `{session_id}-title`.
- [ ] Run `cargo test --lib agent::session::naming`
  - Verify all naming tests pass.
- [ ] Write ADR `docs/decisions/0084-two-stage-async-session-titling-with-wire-isolation.md` and update `CONTEXT.md`.
- [ ] Run full project validation:
  - `cargo test` from `src-tauri/`
  - `cargo clippy --all-targets` from `src-tauri/`
  - `cargo fmt --check` from `src-tauri/`
  - `pnpm test` from repo root
  - `pnpm build` from repo root
- [ ] Commit with message: `feat(agent): implement two-stage session titling with wire isolation`

**Acceptance criteria:**
- [ ] First turn generates initial title with `session_id: Some("<id>-title")` and advances `title_stage` to 1.
- [ ] Reaching 5 interactions triggers re-titling with multi-turn dialogue and advances `title_stage` to 2.
- [ ] Turns after stage 2 do not invoke the provider.
- [ ] Resuming a session with `title_stage == 2` never triggers titling.
- [ ] ADR 0084 is written and `CONTEXT.md` is updated.
- [ ] `cargo test` is completely green.
- [ ] `cargo clippy --all-targets` reports 0 warnings.
- [ ] `pnpm test` and `pnpm build` are green.
