# Codebase Improvement Report — 2026-10-19

## Summary
12 findings across 8 categories. 4 high, 5 medium, 3 low.

## Context
- CONTEXT.md: loaded (no `## Engineering Rules` section found; defaults applied)
- ADRs reviewed: 20 (ADR 0025, 0032, 0033, 0038, 0040, 0047, 0048, 0049, 0050, 0051, 0052, 0053, 0054, 0055, 0056, 0057, 0060, 0061, 0063, 0064)
- Plans reviewed: 3 (`appimage-child-process-env-scrub.md`, `multi-platform-build-and-release.md`, `compaction-recovery-hardening-follow-ups.md`)

## Findings

### 🔴 High Severity

#### 1. Decompose `src-tauri/src/agent/harness/loop.rs` (9,035 lines) & Extract Test Infrastructure
- **Lens:** File Length + Structure
- **Files:** `src-tauri/src/agent/harness/loop.rs`
- **Severity:** High
- **Confidence:** High
- **Problem:** `loop.rs` has grown to 9,035 lines (a ~40% increase since the previous audit). It is 72% test code (~6,540 lines with 12 fake types and 80+ tests) in a single inline `mod tests`. The production code features a single 630-line `handle_turn` with five interleaved recovery flags (overflow, retry, cancel, compaction, settlement) and a 40-field `AgentLoop` struct. This makes it the highest regression-risk module in the application, and every PR touching harness logic creates merge conflicts.
- **Proposal:**
  1. Move the inline `mod tests` out of `loop.rs` into `src-tauri/src/agent/harness/loop/tests.rs` and split into behavioral test suites (`tests/{support, compaction_overflow, context_usage, tools_enabled, specs, subagents, policy_gate}.rs`).
  2. Extract tool specifications to `harness/tool_specs.rs`.
  3. Extract policy gating to `loop/gate.rs`.
  4. Extract tool dispatch to `loop/tools.rs` and event emission / persistence to `loop/emit.rs`.
  5. Decompose `handle_turn` into isolated sub-functions (`run_tool_batch`, `begin_turn`, `consume_stream`, `handle_mid_stream_error`) behind the unchanged test suite.

#### 2. Refactor `src-tauri/src/agent/tools/exec.rs` (4,633 lines) & Deduplicate Pipe Pumping
- **Lens:** File Length + Structure
- **Files:** `src-tauri/src/agent/tools/exec.rs`, `src-tauri/src/agent/childproc.rs`
- **Severity:** High
- **Confidence:** High
- **Problem:** `exec.rs` spans 4,633 lines (~66% tests), acting both as the central executor and the shared type module for all tools. In `exec_bash`, stream buffering and output truncation logic is copy-pasted 4 times across stdout/stderr in main and post-kill drain paths. Over 625 lines are hostenv tests and 630 lines are skills tests for other modules. Furthermore, the `childproc.rs` census test (`production_source_has_exactly_one_child_constructor`) has hard-coded file path and constructor count assumptions for `exec.rs` that would break a naive split.
- **Proposal:**
  1. Update `childproc.rs` (prerequisite step E0, TDD) so the census aggregates across `agent/tools/exec*` and ignores `tests.rs` / `tests/**`.
  2. Extract shared tool types (`ToolCtx`, `ToolResult`, `ContentBlock`, `ImageRef`) to `src-tauri/src/agent/tools/types.rs`.
  3. Move tests to `exec/tests/`.
  4. Extract `exec/bash.rs` and introduce a pure, unit-tested `OutputCollector { buf, truncated }` with `ingest()` to eliminate 4x duplicate pipe-pump logic.
  5. Move file operations to `exec/fs_tools.rs`, search to `exec/search.rs`, and skills to `exec/skills.rs`.

#### 3. Break Circular Coupling in Session/Worker Orchestration (`SessionManager` ↔ `WorkerManager`)
- **Lens:** Coupling Issues
- **Files:** `src-tauri/src/agent/session/mod.rs`, `src-tauri/src/agent/worker/manager.rs`, `src-tauri/src/agent/session/router.rs`, `src-tauri/src/lib.rs`
- **Severity:** High
- **Confidence:** High
- **Problem:** `SessionManager` and `WorkerManager` have a strong `Arc` circular reference cycle held together by five `OnceLock` fields on the session side and cross-capturing closures. Forgetting to wire fails at the first prompt rather than at construction time. `attach_worker_manager` has silent order dependencies with `set_subagent_manager`, and tests leak managers/DB handles. In addition, the worker event pump runs synchronous SQLite transcript writes on a tokio thread over a 256-slot broadcast channel, silently dropping frames on `RecvError::Lagged`.
- **Proposal:**
  1. Consolidate the 4 positional closures of `WorkerManager::new` into a unified `WorkerHooks` trait (`on_event`, `on_crash`, `sink_for`, `register_child_cwd`) with mockable test helpers (`NullHooks`, `ClosureHooks`).
  2. Introduce `SessionManagerBuilder` utilizing `Arc::new_cyclic` and `Weak` to construct the cyclic reference safely in one pass, eliminating the `OnceLock` fields on `SessionManager`.
  3. Log `RecvError::Lagged` and decouple synchronous SQLite transcript writes from the worker event pump.

#### 4. Decompose Monolithic File Command Module (`src-tauri/src/commands/files.rs`)
- **Lens:** File Length + Structure
- **Files:** `src-tauri/src/commands/files.rs`
- **Severity:** High
- **Confidence:** High
- **Problem:** `files.rs` spans 3,251 lines, combining image attachment validation/reading, ripgrep ignore Space file walking (`collect_files`), out-of-Space single-directory completion (`completion_dir`), token representability rules, and 2,175 lines of tests. In addition, `read_file_bytes` suffers from a TOCTOU / non-regular file size cap bypass where symlinks to special files (e.g. `/dev/zero`) or files growing post-metadata check can trigger unbounded reads.
- **Proposal:**
  1. Fix `read_file_bytes` with an atomic `read_image_capped` using `File::open` and `take(MAX_IMAGE_BYTES + 1)` with symlink/regular-file verification.
  2. Decompose into `src-tauri/src/commands/files/`: `mod.rs` (Tauri commands & shared `blocking_or_empty` helper), `image.rs` (image formats & cap checks), `space_walk.rs` (ripgrep ignore traversal & pruning), `completion.rs` (directory completion), and `token.rs` (`name_is_completable`).

---

### 🟡 Medium Severity

#### 5. Eliminate Primitive Obsession for `SessionId` and `RequestId` (Weak Abstractions)
- **Lens:** Weak Abstractions
- **Files:** `src-tauri/src/agent/types.rs`, `src-tauri/src/agent/permission.rs`, `src-tauri/src/agent/interactive/mod.rs`, `src-tauri/src/commands/sessions.rs`, `src/lib/tauri.ts`, `src/lib/ids.ts`
- **Severity:** Medium
- **Confidence:** High
- **Problem:** Over 700 occurrences of raw `String` / `&str` / `string` represent session and request IDs. Multiple critical functions take pairs of strings with identical types in proximity (e.g., `permission_key(session_id, request_id)`, `note_gate_answered(session_id, request_id)`, `respond_permission`, `respond_interactive_request`). Transposing these arguments compiles cleanly without warning, causing permission prompts or interactive gates to hang indefinitely. Furthermore, three separate modules build identical `format!("{session_id}/{request_id}")` string keys for separate pending HashMaps.
- **Proposal:**
  1. In Rust, introduce a transparent `SessionId(String)` newtype and `RequestId(String)` newtype in `src-tauri/src/agent/ids.rs` with `#[serde(transparent)]`.
  2. Introduce a unified `struct GateKey { session: SessionId, request: RequestId }` with `Hash + Eq` to replace ad-hoc `format!("{session_id}/{request_id}")` strings and prefix-drain scans across pending permission/interactive maps.
  3. In TypeScript, define branded types `type SessionId = Brand<string, "SessionId">` and `RequestId = Brand<string, "RequestId">` in `src/lib/ids.ts` and apply them at the `lib/tauri.ts` IPC edge.

#### 6. Consolidate Inconsistent Frontend Session-Close Fan-Out & Decouple `useSessions`
- **Lens:** Coupling Issues
- **Files:** `src/store/sessions.ts`, `src/App.tsx`, `src/lib/sessionLifecycle.ts`
- **Severity:** Medium
- **Confidence:** High
- **Problem:** When a `session-closed` event occurs, cleanup logic is scattered across three places: `App.tsx` calls `useInteractive.dismissSession(...)`, `useSessions.handleSessionClosed` reaches into `usePermissions.getState().dismissSessionPrompts(...)`, and `App.tsx` calls `discardSessionMessages(...)` (which reads `useSubagents`). This makes `useSessions` coupled to foreign stores, prevents testing session state transitions in isolation, and makes cleanup order implicit. In addition, `sessions.ts` spans 1,683 lines with mixed concerns (reducer, history merge, spaces, lifecycle).
- **Proposal:**
  1. Extract a dedicated `src/lib/sessionLifecycle.ts` module with `onSessionClosed(payload)` coordinating dismissal across interactive, permissions, and sessions in a single deterministic sequence.
  2. Remove foreign store `.getState()` calls from `src/store/sessions.ts`, making `handleSessionClosed` a pure session state transition.
  3. Extract transcript reducer functions (`applySessionUpdates` internals) from `sessions.ts` into pure modules under `src/lib/transcript/`.

#### 7. Harmonize Tauri IPC Command Error Handling with ADR 0063
- **Lens:** Inconsistent Patterns
- **Files:** `src-tauri/src/commands/files.rs`, `src-tauri/src/commands/settings.rs`, `src-tauri/src/commands/spaces.rs`, `src-tauri/src/commands/mcp.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/agent/errors.rs`
- **Severity:** Medium
- **Confidence:** High
- **Problem:** While `commands/sessions.rs` adheres to ADR 0063 by returning structured `Result<T, SessionError>` with hand-crafted `{ kind, message }` IPC envelopes, commands across `files.rs`, `settings.rs`, `spaces.rs`, `mcp.rs`, and `agents.rs` return plain `Result<T, String>` using ad-hoc `.map_err(|e| e.to_string())`. This erases error context and forces frontend callers to rely on substring checks for error classification.
- **Proposal:**
  Extend the `{ kind, message }` IPC error contract established in ADR 0063 to other domain command modules, providing typed domain errors (e.g. `SettingsError`, `McpError`) with explicit `Display` sentences owned by Rust.

#### 8. Resolve Domain Terminology Collisions with Bare `Prompt`
- **Lens:** Naming
- **Files:** `src-tauri/src/agent/harness/loop.rs`, `src-tauri/src/agent/harness/prompt.rs`, `src/components/chat/ComposerMentions.tsx`
- **Severity:** Medium
- **Confidence:** High
- **Problem:** `CONTEXT.md` domain glossary explicitly marks bare `prompt` under *Avoid: prompt (bare — that is the Permission prompt specifically)*. However, `loop.rs` defines `struct Prompt` (representing user prompt input), and several frontend components use bare `prompt` for message drafts or turn input. This causes conceptual ambiguity between user input turns and security/permission prompt gates.
- **Proposal:**
  Rename internal struct `Prompt` in `loop.rs` / `harness/prompt.rs` to `PromptTurn` or `UserPromptSubmission`, and rename frontend variables from bare `prompt` to `messageText` or `draftText`.

#### 9. Extract Common Web Provider Response Parsing & Error Handling
- **Lens:** DRY Violations
- **Files:** `src-tauri/src/agent/web/providers/brave.rs`, `src-tauri/src/agent/web/providers/duckduckgo.rs`, `src-tauri/src/agent/web/providers/perplexity.rs`, `src-tauri/src/agent/web/providers/searxng.rs`, `src-tauri/src/agent/web/providers/tavily.rs`
- **Severity:** Medium
- **Confidence:** High
- **Problem:** All five web search provider modules duplicate boilerplate routines for JSON extraction, HTTP error recovery, empty result fallbacks, and response header sanitization.
- **Proposal:**
  Extract common search provider parsing helpers and HTTP client resilience utilities into `src-tauri/src/agent/web/providers/common.rs`.

---

### 🟢 Low Severity

#### 10. Clean Up Unused Legacy Code & Dead Utility Exports
- **Lens:** Dead Code
- **Files:** `src-tauri/src/agent/worker/core.rs`, `src/lib/cssSource.ts`, `src/components/lib/transcriptRow.ts`, `src/lib/spin-quips.ts`
- **Severity:** Low
- **Confidence:** High
- **Problem:** Unused exports (`extractRuleDeclarations`, `injectDynamicStylesheet` in `cssSource.ts`, `TranscriptRowLegacyProps` in `transcriptRow.ts`, `OLD_QUIPS_DEPRECATED` in `spin-quips.ts`) and commented-out legacy loops in `worker/core.rs` clutter the codebase.
- **Proposal:**
  Remove commented-out code and purge unused exports.

#### 11. Standardize React Component Styling with `cn()` Helper
- **Lens:** Inconsistent Patterns
- **Files:** `src/components/SubagentTranscript.tsx`, `src/components/chat/MessageList.tsx`, `src/components/ui/`
- **Severity:** Low
- **Confidence:** High
- **Problem:** Mixed conventions for CSS styling: while UI primitives use Tailwind with the `cn()` merge utility, several higher-level components resort to raw string interpolation or inline style objects.
- **Proposal:**
  Adopt `cn(...)` consistently across all component styling.

#### 12. Optimize `SubagentDetailHost` Entry Selection Selector
- **Lens:** Coupling Issues
- **Files:** `src/components/SubagentDetailHost.tsx`
- **Severity:** Low
- **Confidence:** High
- **Problem:** `SubagentDetailHost.tsx` calls `Object.values(useSubagents((s) => s.entries)).find(...)`, which subscribes to the entire entries map and performs an O(N) search on every render.
- **Proposal:**
  Replace with a keyed selector: `useSubagents((s) => selectedId ? s.entries[selectedId] : undefined)`.

---

## Top Recommendation
**Finding 1: Decompose `src-tauri/src/agent/harness/loop.rs` and Extract Test Infrastructure.**
`loop.rs` is the single largest maintenance and regression risk in the application (9,035 lines), carrying ~72% test code, a 630-line state machine in `handle_turn`, and frequent merge conflicts. Extracting its test suites and decomposing it into cohesive submodules (`gate.rs`, `tools.rs`, `emit.rs`, and isolated `handle_turn` phases) creates the foundation for all future harness feature work.
