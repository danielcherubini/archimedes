---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/136
done-when: Unit and integration tests verify that session titling sends `{sessionId}-title` on the wire, generates an initial title at turn 1 (`title_stage: 0 -> 1`), refines the title at interaction 5 (`title_stage: 1 -> 2`), updates SQLite atomically without duplicate runs across restarts, and full validation (`cargo test`, `cargo clippy --all-targets`, `pnpm test`, `pnpm build`) is green.
---

# Specification: Two-Stage Async Session Titling with Wire Isolation

## 1. Overview & Motivation
Session auto-titling in Archimedes Desktop previously ran exclusively after the first conversational exchange and sent the main `sessionId` in the model request headers (`x-litellm-session-id` and `x-request-id`). This resulted in:
1. **Proxy & Chat Pollution**: LiteLLM and upstream gateways logged the titling prompt inside the main chat session, occasionally triggering per-session proxy concurrency locks or queueing.
2. **Premature Titles**: A single opening prompt often lacks the full context of what the user is working on, especially when initial turns involve troubleshooting or preliminary questions.
3. **Slow Latency Perception**: Titling requests on large reasoning models without token boundaries could take 10–20 seconds, compounding proxy queueing.

This change upgrades session titling to a **two-stage, wire-isolated, fully asynchronous** architecture:
- **Wire Isolation**: Titling requests send `{sessionId}-title` as their session identifier, fully decoupling titling from the main chat logs and proxy session queues.
- **Two-Stage Titling**:
  - **Stage 1 (Initial)**: Generates a title immediately after Turn 1 settles, ensuring every session gets a prompt label right away.
  - **Stage 2 (Refined)**: Re-titles the session after 5 user interactions (prompts + answered `ask` questions) have settled, using multi-turn conversational context.
- **Persistent Idempotency**: Tracked via `title_stage` (`0 -> 1 -> 2`) in SQLite with atomic conditional updates (`WHERE title_stage = ?`), surviving restarts and preventing duplicate runs.

## 2. Technical Design

### A. Wire Isolation & Request Bounds (`agent/session/naming.rs`, `provider/transport.rs`)
1. **Derived Session ID**:
   - In `ModelRequest`, the titling pass sets `session_id: Some(format!("{session_id}-title"))`.
   - In `transport::litellm_headers`, `x-litellm-session-id` is set to `<sessionId>-title` and `x-request-id` is set to `<sessionId>-title-<uuid>`.
2. **Token Bounds & Options**:
   - `options.max_tokens` is bounded to `Some(60)` (sufficient for 3–8 word titles), ensuring fast generation.
   - Temperature remains `0.0`.
   - Respects `sessionNamingModel` and `sessionNamingReasoning` settings, falling back to the session model.
3. **Detached Background Execution**:
   - Runs in a spawned Tokio task (`tokio::spawn`) with a 30s timeout; never blocks the Supervisor event loop, the router, or user typing.

### B. User Interaction Counting & Turn Triggers (`agent/session/naming.rs`)
1. **Interaction Counting**:
   - `count_user_interactions(messages: &[ChatMessage]) -> usize` counts:
     - User prompts (`role == ChatRole::User`).
     - User responses to `ask` tool gates (`role == ChatRole::Tool` corresponding to an `ask` tool call).
   - Derived directly from `native_messages`, guaranteeing deterministic state across restarts and resumes.
2. **Trigger Gates on `RpcEvent::agent_end`**:
   - When a main session (`!is_subagent`) emits `agent_end`:
     - Inspect `row.title_stage`:
       - **Stage 1**: If `title_stage == 0` and `interactions >= 1` → trigger Stage 1 titling.
       - **Stage 2**: If `title_stage == 1` and `interactions >= 5` → trigger Stage 2 titling.
       - **Complete**: If `title_stage >= 2` → no-op.
   - Concurrency guard: Supervisor in-memory `naming` map continues to enforce `in_flight: bool` so multiple `agent_end` events cannot spawn duplicate tasks.

### C. Context Extraction (`agent/session/naming.rs`)
1. **Stage 1 (First Exchange)**:
   - Uses `first_exchange_text`: first non-empty user message (max 500 chars) + first non-empty assistant text response (max 500 chars).
2. **Stage 2 (Multi-Turn Excerpt)**:
   - `multi_turn_exchange_text(messages, max_interactions: 5)`:
     - Includes each user prompt (max 400 chars).
     - Includes each user selection to an `ask` question (max 200 chars, labelled `User (selection): ...`).
     - Includes each turn's assistant text response (max 400 chars, excluding tool call JSON and tool outputs).
     - Overall conversation excerpt capped at 2,500 chars.
3. **Sanitization**:
   - Both stages use `clean_title`: collapses whitespace runs, strips enclosing quotes, caps to 80 chars, rejects empty strings.

### D. SQLite Persistence & Live UI (`storage/db.rs`, `store/sessions.ts`)
1. **Schema & Migration**:
   - Add column `title_stage INTEGER NOT NULL DEFAULT 0` to `sessions`.
   - Migration in `Db::open`:
     - Runs `ALTER TABLE sessions ADD COLUMN title_stage INTEGER NOT NULL DEFAULT 0;` if missing.
     - Sets `title_stage = 1` for existing rows where `title IS NOT NULL AND title_stage = 0`.
2. **Atomic Staged Write**:
   - `Db::set_session_title_stage(id, title, from_stage, to_stage) -> Result<bool, DbError>`:
     ```sql
     UPDATE sessions
     SET title = ?2, title_stage = ?4
     WHERE id = ?1 AND title_stage = ?3
     ```
   - Stage 1: `set_session_title_stage(session_id, title, 0, 1)`
   - Stage 2: `set_session_title_stage(session_id, title, 1, 2)`
3. **Live Updates**:
   - Upon successful database write in either stage, emits `session-titled` (`{ sessionId, title }`).
   - React frontend (`useSessions.titleSession`) updates the title in memory, automatically updating `SpacesList`, tab strips, and the side pane header.
