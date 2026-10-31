---
status: accepted
date: 2026-10-30
---

# Two-stage asynchronous session titling with wire isolation

ADR 0037 introduced single-stage Supervisor-side session titling, executing on the first turn's `agent_end` hook and writing with `WHERE title IS NULL`. In practice, the initial exchange often represents preliminary greetings or setup, resulting in premature or poorly descriptive titles. Additionally, sending the raw session id on title generation requests polluted LiteLLM and proxy session tracking with auxiliary title calls.

We decide:
1. **Two-stage lifecycle (`title_stage: 0 -> 1 -> 2`)**:
   - **Stage 1 (Initial)**: Triggered on turn 1 (`title_stage == 0 && interactions >= 1`). Generates a title from the first exchange (`first_exchange_text`). Advances `title_stage` from 0 to 1.
   - **Stage 2 (Settled / Re-titling)**: Triggered when user interactions reach 5 (`title_stage == 1 && interactions >= 5`). Uses a multi-turn conversation excerpt (`multi_turn_exchange_text`) collecting up to 5 user interactions (prompts and answered `ask` selections) along with closing assistant responses. Advances `title_stage` from 1 to 2.
   - **Settled state**: Turns after stage 2 (`title_stage >= 2`) are complete no-ops and never invoke the model. Resuming a session already at stage 2 never invokes titling. Resuming at stage 1 evaluates interaction count and triggers stage 2 once 5 interactions are reached.
   - **Manual rename invariant**: Any future manual rename command must set `title_stage = 2` so that auto-titling at interaction 5 never overwrites a user-chosen title.
2. **Atomic state transitions**:
   - Stored in SQLite `sessions.title_stage INTEGER NOT NULL DEFAULT 0`.
   - Written conditionally via `UPDATE sessions SET title = ?2, title_stage = ?4 WHERE id = ?1 AND title_stage = ?3`.
   - If the stage changes mid-flight (e.g. concurrent race or external write), the statement matches 0 rows and drops the write harmlessly without counting as a failure.
3. **Wire isolation (`{id}-title`)**:
   - Model requests for titling carry `session_id: Some(format!("{session_id}-title"))` using `TITLE_SESSION_SUFFIX`.
   - The transport layer (`litellm_headers`) detects `TITLE_SESSION_SUFFIX` and emits `x-litellm-session-id: {session_id}-title` with a unique request ID `x-request-id: {session_id}-title-{uuid}`, isolating title queries from main session telemetry.
   - When reasoning effort is resolved, `max_tokens` is omitted (`None`) so reasoning tokens cannot starve title generation; otherwise it is bounded to `Some(100)`.
   - On `FinishReason::Length`, the cleaned title is accepted only if it has at least 2 words and no newlines.
