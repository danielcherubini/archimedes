---
status: committed
issue: 48
done-when: `src-tauri/src/agent/harness/loop.rs` is reduced from 9,035 lines to a ~700-1,000 line orchestrator, its test suites and sub-responsibilities are cleanly modularized in `harness/loop/`, and `cargo test`, `cargo clippy --all-targets` (0 warnings), and `cargo fmt --check` pass with zero regressions.
---

# Agent Harness Loop Decomposition — Plan

**Goal:** Decompose the monolithic 9,035-line `src-tauri/src/agent/harness/loop.rs` into focused, cohesive submodules under `src-tauri/src/agent/harness/loop/` and extract its extensive test suite without altering any agent runtime behavior.
**Architecture:** Retain `AgentLoop` struct definition, lifecycle methods, and model request builders in `loop.rs`, while delegating policy evaluation to `loop/gate.rs`, tool dispatching to `loop/tools.rs`, event emission / accumulation to `loop/emit.rs`, turn execution stages to `loop/turn.rs`, tool specifications to `harness/tool_specs.rs`, and test suites into behavioral modules under `loop/tests/`. Moved items use `pub(super)` visibility.
**Tech Stack:** Rust 2021 (pinned in `src-tauri/rust-toolchain.toml`), Tokio, Serde, Futures.

**Execution Order & Dependencies:**
- **Phase A (Parallel Foundation):** Spec 1 can be executed in parallel with Spec 2 (`tool-exec-modularization`), Spec 4 (`file-commands-decomposition`), and Spec 5 (`frontend-store-decoupling`).
- Spec 3 (`session-worker-supervision-and-typed-ids`) runs in Phase B.

**Disjoint File Boundary:**
This spec modifies *only* files under `src-tauri/src/agent/harness/`. It does NOT touch `tools/`, `commands/`, `session/`, `worker/`, or frontend `src/`. Locate code by symbol name, as line numbers will drift across extractions.

---

### Task 1: Extract Test Suite to `harness/loop/tests/`

**Context:**
`loop.rs` contains over 6,538 lines of test code (~72% of the file) in a single inline `mod tests`. Moving tests into categorized submodules allows developers and subagents to inspect and run targeted tests independently.

**Files:**
- Create: `src-tauri/src/agent/harness/loop/tests/mod.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/support.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/compaction_overflow.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/context_usage.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/tools_enabled.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/subagents.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`
- Create: `src-tauri/src/agent/harness/loop/tests/turn_lifecycle.rs`
- Modify: `src-tauri/src/agent/harness/loop.rs`

**What to implement:**
- In `loop.rs`, replace the inline `#[cfg(test)] mod tests { ... }` block (lines 2497–9035) with `#[cfg(test)] mod tests;`. Keep `#[cfg(test)] pub(crate) fn result_text` in `loop.rs`.
- In `src-tauri/src/agent/harness/loop/tests/mod.rs`:
  ```rust
  pub(super) mod support;
  mod compaction_overflow;
  mod context_usage;
  mod tools_enabled;
  mod subagents;
  mod policy_gate;
  mod turn_lifecycle;
  ```
- In `support.rs`: move test helpers and fakes shared by ≥ 2 files (`ScriptedProvider`, `FailingProvider`, `OverflowingProvider`, `TestSink`, `AllEventsSink`, `OrderingSink`, `RecordingSink`, `Tmp`, `build_loop*` helpers) with `pub(super)` visibility. Single-use helpers stay beside their tests.
- Distribute test functions into their respective themed test files using `use super::support::*;` and `use super::super::*;`:
  - `compaction_overflow.rs`: Context compaction and retry/overflow tests.
  - `context_usage.rs`: Token accounting and usage reporting tests.
  - `tools_enabled.rs`: Built-in and MCP tool enable/disable tests, plus `the_child_tool_set_is_pinned`.
  - `subagents.rs`: Child subagent dispatch, nesting, and cancellation tests.
  - `policy_gate.rs`: Security boundary and policy permission check tests.
  - `turn_lifecycle.rs`: Generic turn execution, cancellation, and persistence tests, plus the tool spec tests until Task 2 moves them.

**Steps:**
- [ ] Snapshot test names: run `cd src-tauri && cargo test agent::harness::loop -- --list | sed 's/.*:://' | sort > /tmp/loop-tests-before.txt`
- [ ] Create `src-tauri/src/agent/harness/loop/tests/` directory structure.
- [ ] Extract test helpers and fakes into `support.rs`.
- [ ] Move tests into themed files under `src-tauri/src/agent/harness/loop/tests/`.
- [ ] Replace inline test block in `loop.rs` with `#[cfg(test)] mod tests;`.
- [ ] Verify test parity: run `cd src-tauri && cargo test agent::harness::loop -- --list | sed 's/.*:://' | sort > /tmp/loop-tests-after.txt`
  - Verify `diff /tmp/loop-tests-before.txt /tmp/loop-tests-after.txt` is empty.
- [ ] Run `cargo test agent::harness::loop` from `src-tauri/`.
  - Ensure all tests pass.
- [ ] Run `cargo fmt --check` and `cargo clippy --all-targets` (must be 0 warnings).
- [ ] Commit with message: "refactor(harness): extract loop.rs test suites to harness/loop/tests/"

**Acceptance criteria:**
- [ ] `loop.rs` line count reduced by ~6,500 lines.
- [ ] All existing loop tests pass unchanged.
- [ ] Zero clippy warnings with `--all-targets`.

---

### Task 2: Extract Tool Specifications to `harness/tool_specs.rs`

**Context:**
`tool_specs()` is a pure data function that defines the JSON schemas for built-in tools (`read`, `write`, `edit`, `bash`, `find`, `grep`, `ls`, `subagent`, `list_agents`). Extracting it to a dedicated module decouples tool metadata from loop control flow.

**Files:**
- Create: `src-tauri/src/agent/harness/tool_specs.rs`
- Modify: `src-tauri/src/agent/harness/mod.rs`
- Modify: `src-tauri/src/agent/harness/loop.rs`
- Modify: `src-tauri/src/agent/harness/loop/tests/turn_lifecycle.rs`

**What to implement:**
- In `src-tauri/src/agent/harness/tool_specs.rs`:
  - Move `pub(crate) fn tool_specs() -> Vec<ToolSpec>`.
  - Move `every_tool_spec_is_in_the_param_key_table` and `tool_specs_advertise_exactly_the_executor_param_keys` tests from `loop/tests/turn_lifecycle.rs`, along with the `exec_param_keys()` helper.
- In `src-tauri/src/agent/harness/mod.rs`:
  - Declare `pub mod tool_specs;`.
  - Replace `pub(crate) use r#loop::tool_specs;` with `pub(crate) use tool_specs::tool_specs;`.
- In `src-tauri/src/agent/harness/loop.rs`:
  - Re-export `pub(crate) use super::tool_specs::tool_specs;`.
  - *(Note: Keep `AgentLoop::advertised_tool_specs` as an associated method on `AgentLoop` in `loop.rs`.)*

**Steps:**
- [ ] Create `src-tauri/src/agent/harness/tool_specs.rs`.
- [ ] Move `tool_specs()` and its tests into `tool_specs.rs`.
- [ ] Update re-exports in `harness/mod.rs` and `loop.rs`.
- [ ] Run `cd src-tauri && cargo test harness::tool_specs`
  - Ensure spec tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(harness): extract tool_specs to dedicated module"

**Acceptance criteria:**
- [ ] Schema generation logic removed from `loop.rs` (~326 lines removed).
- [ ] Existing callers of `tool_specs` continue to compile without signature changes.

---

### Task 3: Extract Policy Gating to `loop/gate.rs`

**Context:**
Evaluating security policies (`AccessPolicy`, `Beyond-boundary policy`, Landlock confinement, and trust sources) comprises ~211 lines of `loop.rs`.

**Files:**
- Create: `src-tauri/src/agent/harness/loop/gate.rs`
- Modify: `src-tauri/src/agent/harness/loop.rs`

**What to implement:**
- In `gate.rs`, move items with exact existing signatures and `pub(super)` visibility:
  - `pub(super) const POLICIED_TOOLS: &[(&str, PolicyDirection)]`
  - `pub(super) enum PolicyDirection`
  - `pub(super) fn policed_direction(tool: &str) -> Option<PolicyDirection>`
  - `impl AgentLoop` block containing:
    - `pub(super) fn policy_verdict(&self, tc: &crate::agent::harness::provider::ToolCall) -> Option<crate::agent::policy::Decision>`
    - `pub(super) fn direction_policy(&self, dir: PolicyDirection) -> crate::agent::policy::AccessPolicy`
    - `pub(super) fn direction_boundary(&self, dir: PolicyDirection) -> Vec<std::path::PathBuf>`
    - `pub(super) async fn gate_tool(&self, tc: &crate::agent::harness::provider::ToolCall, turn: &tokio_util::sync::CancellationToken) -> bool`
    - `pub(super) fn deny_tool_result(&self, tc: &crate::agent::harness::provider::ToolCall) -> crate::agent::tools::ToolResult`
    - `pub(super) fn beyond_error(&self, dir: PolicyDirection, path: &std::path::Path) -> Option<crate::agent::fs_backend::FsError>`
    - `pub(super) fn escape_text(&self, dir: Option<PolicyDirection>, tool: &str, path: &std::path::Path, raw: &str) -> String`
- In `loop.rs`, declare `mod gate;`.

**Steps:**
- [ ] Move policy constants, enum, and gating methods from `loop.rs` to `src-tauri/src/agent/harness/loop/gate.rs`.
- [ ] Run `cd src-tauri && cargo check` to confirm `pub(super)` visibility.
- [ ] Run `cd src-tauri && cargo test agent::harness::loop::tests::policy_gate`
  - Ensure all policy and boundary test cases pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(harness): extract policy gating to loop/gate.rs"

**Acceptance criteria:**
- [ ] ~211 lines of security gating code extracted from `loop.rs`.
- [ ] Boundary and permission gating tests pass without alteration.

---

### Task 4: Extract Tool Dispatch & Event Emission to `loop/tools.rs` & `loop/emit.rs`

**Context:**
`loop.rs` dispatches tools, subagents, and MCP tools and serializes/emits events to the event sink and SQLite database (keeping model request builder in `loop.rs`).

**Files:**
- Create: `src-tauri/src/agent/harness/loop/tools.rs`
- Create: `src-tauri/src/agent/harness/loop/emit.rs`
- Modify: `src-tauri/src/agent/harness/loop.rs`

**What to implement:**
- In `tools.rs` (with `pub(super)`):
  - `dispatch_tool`, `dispatch_subagent`, `list_agents_tool`, `is_tool_enabled`
  - Associated result helpers: `pub(super) fn cancelled_tool_result() -> ToolResult`, `pub(super) fn abandoned_tool_result() -> ToolResult`, `pub(super) fn sudo_cancelled_result() -> ToolResult`
- In `emit.rs` (with `pub(super)`):
  - `pub(super) struct TurnAccumulator` with all fields `pub(super)`:
    - `pub(super) text: String`
    - `pub(super) thinking: String`
    - `pub(super) tool_calls: Vec<ToolCall>`
    - `pub(super) usage: Option<Usage>`
    - `pub(super) finish: Option<FinishReason>`
    - `impl TurnAccumulator { pub(super) fn usage_value(&self) -> ... }`
  - `emit`, `emit_context_usage`, `note_context`, `assistant_message_value`, `persist_transcript_message`, `persist_system_message`, `normalized_for_display`
- In `loop.rs`, declare `mod tools;` and `mod emit;`.

**Steps:**
- [ ] Move dispatch routines into `src-tauri/src/agent/harness/loop/tools.rs`.
- [ ] Move emission and accumulation routines into `src-tauri/src/agent/harness/loop/emit.rs`.
- [ ] Run `cd src-tauri && cargo check` and fix any missing imports.
- [ ] Run `cd src-tauri && cargo test agent::harness::loop` to verify event and dispatch integration.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(harness): extract dispatch and emit helpers to submodules"

**Acceptance criteria:**
- [ ] `loop.rs` reduced by ~580 lines.
- [ ] All tool execution and UI event emissions continue working identically.

---

### Task 5: Decompose `handle_turn` Stages into `loop/turn.rs`

**Context:**
`handle_turn` is a 630-line function with complex control flow racing cancels, retries, and token compactions. Dividing this method into distinct turn lifecycle stages in `loop/turn.rs` makes it readable, maintainable, and safely under 1,000 lines.

**Files:**
- Create: `src-tauri/src/agent/harness/loop/turn.rs`
- Modify: `src-tauri/src/agent/harness/loop.rs`

**What to implement:**
- In `src-tauri/src/agent/harness/loop/turn.rs`:
  ```rust
  pub(super) enum TurnFlow {
      Continue,
      Return,
  }

  pub(super) struct TurnLoopState {
      pub turn_tool_results: Vec<serde_json::Value>,
      pub message_started: bool,
      pub overflow_recovered: bool,
  }
  ```
  - Implement `impl AgentLoop` helper methods:
    - `pub(super) async fn run_tool_batch(&mut self, tool_calls: &[crate::agent::harness::provider::ToolCall], turn: &tokio_util::sync::CancellationToken) -> Vec<serde_json::Value>`
    - `pub(super) fn begin_turn(&mut self, text: &str, images: &[crate::agent::tools::ImageRef])`
    - `pub(super) async fn compact_if_due(&mut self, turn: &tokio_util::sync::CancellationToken, turn_tool_results: &mut Vec<serde_json::Value>) -> TurnFlow`
    - `pub(super) async fn consume_stream(&mut self, stream: &mut (impl futures_util::Stream<Item = Result<crate::agent::harness::provider::ProviderEvent, crate::agent::harness::provider::ProviderError>> + Unpin), turn: &tokio_util::sync::CancellationToken, acc: &mut super::emit::TurnAccumulator) -> Result<(), crate::agent::harness::provider::ProviderError>`
    - `pub(super) async fn handle_mid_stream_error(&mut self, err: crate::agent::harness::provider::ProviderError, turn: &tokio_util::sync::CancellationToken, state: &mut TurnLoopState, acc: &super::emit::TurnAccumulator) -> TurnFlow`
- In `loop.rs`, declare `mod turn;` and retain `handle_turn(&mut self, turn: &tokio_util::sync::CancellationToken, text: &str, images: &[ImageRef])` as a ~180-line orchestrator method coordinating these stages.

**Steps:**
- [ ] Create `src-tauri/src/agent/harness/loop/turn.rs`.
- [ ] Extract `run_tool_batch` and run `cargo test agent::harness::loop::tests::subagents`.
- [ ] Extract `begin_turn` and `compact_if_due` and run `cargo test agent::harness::loop::tests::compaction_overflow`.
- [ ] Extract `consume_stream` and `handle_mid_stream_error`.
- [ ] Run `cd src-tauri && cargo test agent::harness::loop`
  - Verify entire loop test suite passes.
- [ ] Run `cargo clippy --all-targets` (0 warnings) and `cargo fmt --check`.
- [ ] Verify `wc -l src-tauri/src/agent/harness/loop.rs` is under 1,000 lines.
- [ ] Commit with message: "refactor(harness): decompose handle_turn stages into loop/turn.rs"

**Acceptance criteria:**
- [ ] `handle_turn` is reduced to an orchestrator function of ≤ ~200 lines.
- [ ] `loop.rs` total file length is under 1,000 lines.
- [ ] Full backend test suite passes.
