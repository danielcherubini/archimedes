---
status: committed
issue: 49
done-when: `src-tauri/src/agent/tools/exec.rs` is modularized into cohesive executors under `agent/tools/exec/`, duplicate pipe-buffering in `exec_bash` is unified into `OutputCollector`, the `childproc.rs` census test passes, and `cargo test`, `cargo clippy --all-targets` (0 warnings), and `cargo fmt --check` are green across platforms.
---

# Tool Execution & Sandbox Modularization — Plan

**Goal:** Decompose the 4,633-line `src-tauri/src/agent/tools/exec.rs` into modular tool executors under `src-tauri/src/agent/tools/exec/`, extract its 3,060 lines of tests to `exec/tests/`, deduplicate the 4x copy-pasted pipe-pump logic in `exec_bash` using `OutputCollector`, and extract shared tool types to break circular dependencies.
**Architecture:** Update `childproc.rs` process safety census first to aggregate across multi-file executors; extract shared types (`ToolCtx`, `ToolResult`, `ContentBlock`, `ImageRef`) to `tools/types.rs`; split tool executors into `exec/access.rs`, `exec/bash.rs`, `exec/fs_tools.rs`, `exec/search.rs`, and `exec/skills.rs`; and move test suites into `exec/tests/`. Items required by `tests/` are re-exported in `exec.rs` via `#[cfg(test)] pub(crate)`.
**Tech Stack:** Rust 2021 (pinned in `src-tauri/rust-toolchain.toml`), Tokio, Landlock (Linux), `childproc.rs`.

**Execution Order & Dependencies:**
- **Phase A (Parallel Foundation):** Spec 2 can be executed in parallel with Spec 1 (`harness-loop-decomposition`), Spec 4 (`file-commands-decomposition`), and Spec 5 (`frontend-store-decoupling`).
- Spec 3 (`session-worker-supervision-and-typed-ids`) runs in Phase B.

**Disjoint File Boundary:**
This spec modifies *only* `src-tauri/src/agent/childproc.rs`, `src-tauri/src/agent/tools.rs`, and files under `src-tauri/src/agent/tools/`. It does NOT touch harness loop, commands, session, worker, or frontend `src/`. Locate code by symbol name, as line numbers will drift across extractions.

---

### Task 1: Update `childproc.rs` Census Test for Modular Executors (Prerequisite E0)

**Context:**
`src-tauri/src/agent/childproc.rs` enforces compile-time/test-time AST linting (`production_source_has_exactly_one_child_constructor`) ensuring no unauthorized `std::process::Command::new` or `tokio::process::Command::new` exist. Invariant C explicitly asserts that `agent/tools/exec.rs` has exactly 4 `childproc::command(` calls and at least 3 `closed_stdin` calls. Moving `exec_find` and `exec_grep` into separate files would cause this test to fail unless the scanner aggregates across `agent/tools/exec*`.

**Files:**
- Modify: `src-tauri/src/agent/childproc.rs`

**What to implement:**
- In `src-tauri/src/agent/childproc.rs`:
  - Add a unit test asserting that `production_region(&Path) -> Vec<SourceLine>` returns an empty `Vec` for test files (matching `**/tests.rs` or containing `/tests/`).
  - Update `production_region` to return an empty `Vec` for test-path files.
  - Update Invariant C: retain the per-file ordering check (that `closed_stdin` appears before any `spawn()` or `output()` on that command), but aggregate the total constructor count (`== 4`) and total `closed_stdin` count (`>= 3`) across all production files under `agent/tools/exec.rs` and `agent/tools/exec/**/*.rs` (excluding test files).

**Steps:**
- [ ] Write a failing test in `childproc.rs` asserting `production_region` returns empty `Vec` for `tests.rs` paths.
- [ ] Update `production_region` and Invariant C aggregation in `childproc.rs`.
- [ ] Run `cd src-tauri && cargo test agent::childproc`
  - Ensure all census invariant tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "test(childproc): update census scanner for modular tool executors"

**Acceptance criteria:**
- [ ] Census scanner aggregates across `agent/tools/exec*`.
- [ ] Test files under `exec/tests/` excluded from production constructor scanning.

---

### Task 2: Extract Shared Tool Types to `agent/tools/types.rs`

**Context:**
`exec.rs` currently defines core data structures (`ToolCtx`, `ToolResult`, `ContentBlock`, `ImageRef`) used by the entire agent harness and web tools layer. This creates an awkward dependency where `web/tools.rs` imports types from `tools/exec.rs`, while `exec.rs` dispatches into `web/tools.rs`.

**Files:**
- Create: `src-tauri/src/agent/tools/types.rs`
- Modify: `src-tauri/src/agent/tools.rs`
- Modify: `src-tauri/src/agent/tools/exec.rs`

**What to implement:**
- Move `ContentBlock`, `ImageRef`, `ToolResult`, and `ToolCtx` (lines 81–195 of `exec.rs`) to `src-tauri/src/agent/tools/types.rs`.
- Re-export them from `src-tauri/src/agent/tools/exec.rs` via `pub use super::types::*;` so existing importers continue to compile seamlessly.
- Expose `pub mod types;` in `src-tauri/src/agent/tools.rs`.

**Steps:**
- [ ] Create `src-tauri/src/agent/tools/types.rs` and move the type definitions.
- [ ] Add `pub use super::types::*;` in `exec.rs`.
- [ ] Add `pub mod types;` in `agent/tools.rs`.
- [ ] Run `cd src-tauri && cargo check` to confirm clean compilation.
- [ ] Run `cd src-tauri && cargo test agent::tools`
  - Verify all tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(tools): extract shared tool types to agent/tools/types.rs"

**Acceptance criteria:**
- [ ] Core tool types isolated in `tools/types.rs`.
- [ ] Zero breakage across external importers.

---

### Task 3: Extract Test Suites to `agent/tools/exec/tests/`

**Context:**
Lines 1571–4633 of `exec.rs` (~3,060 lines) consist of inline unit and integration tests, including 625 lines of hostenv integration tests and 630 lines of skills tests. Moving these tests to `exec/tests/` shrinks `exec.rs` dramatically and allows running tool test suites in parallel.

**Files:**
- Create: `src-tauri/src/agent/tools/exec/tests/mod.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/support.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/bash.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/bash_hostenv.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/fs_tools.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/search.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/policy.rs`
- Create: `src-tauri/src/agent/tools/exec/tests/skills.rs`
- Modify: `src-tauri/src/agent/tools/exec.rs`

**What to implement:**
- In `exec.rs`, replace inline `#[cfg(test)] mod tests { ... }` with `#[cfg(test)] mod tests;`.
- In `support.rs`: provide test helpers (`temp_cwd`, `ctx`, `ctx_policy`, `can_confine`, `text_of`) with `pub(crate)`.
- In `bash.rs` and `bash_hostenv.rs`: update self-respawn test filter names at lines 1814 and 4393 to match the relocated submodule paths (e.g. `agent::tools::exec::tests::bash::...` and `agent::tools::exec::tests::bash_hostenv::...` without crate prefix).
- Distribute tests into their respective themed test files under `agent/tools/exec/tests/`.

**Steps:**
- [ ] Snapshot test names: `cd src-tauri && cargo test agent::tools::exec -- --list | sed 's/.*:://' | sort > /tmp/exec-tests-before.txt`.
- [ ] Create `src-tauri/src/agent/tools/exec/tests/` directory structure.
- [ ] Move test functions into themed test files and update self-respawn filters.
- [ ] Verify test parity: `cd src-tauri && cargo test agent::tools::exec -- --list | sed 's/.*:://' | sort > /tmp/exec-tests-after.txt`
  - Verify diff is empty.
- [ ] Run `cargo test agent::tools::exec` from `src-tauri/`.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(tools): extract exec.rs test suites to exec/tests/"

**Acceptance criteria:**
- [ ] `exec.rs` line count reduced by ~3,060 lines.
- [ ] All tool executor tests pass.

---

### Task 4: Extract `exec/bash.rs` & Deduplicate Pipe Pumping

**Context:**
`exec_bash` (lines 359–674 of `exec.rs`) manages process spawning, stream capture, timeout deadlines, and Landlock/hostenv integration. The stream reading logic is duplicated four times across stdout and stderr in both the main loop and post-kill drain.

**Files:**
- Create: `src-tauri/src/agent/tools/exec/bash.rs`
- Modify: `src-tauri/src/agent/tools/exec.rs`

**What to implement:**
- In `exec/bash.rs`:
  - Define `struct OutputCollector`:
    ```rust
    pub(super) struct OutputCollector {
        buf: Vec<u8>,
        truncated: bool,
        max_bytes: usize,
    }
    impl OutputCollector {
        pub(super) fn new(max_bytes: usize) -> Self {
            Self { buf: Vec::new(), truncated: false, max_bytes }
        }
        pub(super) fn ingest(&mut self, chunk: &[u8]) {
            let available = self.max_bytes.saturating_sub(self.buf.len());
            let take = chunk.len().min(available);
            self.buf.extend_from_slice(&chunk[..take]);
            if self.buf.len() >= self.max_bytes {
                self.truncated = true;
            }
        }
        pub(super) fn into_bytes(self) -> Vec<u8> { self.buf }
        pub(super) fn is_truncated(&self) -> bool { self.truncated }
    }
    ```
  - Note: stdout and stderr share ONE combined `OutputCollector` (with `MAX_OUTPUT_BYTES` = 100 KiB cap, matching `exec.rs:64`).
  - Move `exec_bash`, `exit_signal`, `bash_exit_report`, `kill_bash_process_group`, `DRAIN_GRACE`, `DEFAULT_BASH_TIMEOUT`, `MAX_BASH_TIMEOUT`, and `clamp_timeout_ms` into `exec/bash.rs` with `pub(crate)`.
- In `exec.rs`:
  - Re-export items needed by tests:
    ```rust
    #[cfg(test)]
    pub(crate) use bash::{
        bash_exit_report, clamp_timeout_ms, exit_signal, kill_bash_process_group,
        DEFAULT_BASH_TIMEOUT, DRAIN_GRACE, MAX_BASH_TIMEOUT,
    };
    ```
  - Declare `mod bash;` and delegate `execute_tool("bash", ...)` to `bash::exec_bash`.

**Steps:**
- [ ] Write unit test for `OutputCollector` verifying capping and `truncated` flag behavior.
- [ ] Implement `OutputCollector` and move bash execution logic into `exec/bash.rs`.
- [ ] Re-export test-required symbols in `exec.rs`.
- [ ] Run `cd src-tauri && cargo test agent::tools::exec::tests::bash`
  - Ensure all bash execution and timeout tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(tools): extract exec/bash.rs and deduplicate stream buffer logic"

**Acceptance criteria:**
- [ ] 4x duplicate stream read arms replaced by single `OutputCollector`.
- [ ] All shell execution and timeout tests pass unchanged.

---

### Task 5: Modularize Access, Filesystem, Search, and Skill Tool Executors

**Context:**
The remainder of `exec.rs` consists of access control helpers, filesystem commands (`read`, `write`, `edit`, `ls`, `unified_diff`), search commands (`find`, `grep`, `glob_match*`), and skills management (`list_skills`, `read_skill`). Splitting these into dedicated modules completes the modularization of `exec.rs`.

**Files:**
- Create: `src-tauri/src/agent/tools/exec/access.rs`
- Create: `src-tauri/src/agent/tools/exec/fs_tools.rs`
- Create: `src-tauri/src/agent/tools/exec/search.rs`
- Create: `src-tauri/src/agent/tools/exec/skills.rs`
- Modify: `src-tauri/src/agent/tools/exec.rs`

**What to implement:**
- In `access.rs`:
  - Move `read_backend`, `write_backend`, `protected_refusal`, `protected_refusal_text`.
- In `fs_tools.rs`:
  - Move `exec_read`, `exec_write`, `exec_edit`, `exec_ls`, `image_mime`, `unified_diff`, `MAX_READ_LINES`.
- In `search.rs`:
  - Move `exec_find`, `exec_grep`, `glob_match*`, `DEFAULT_MAX_RESULTS`.
- In `skills.rs`:
  - Move `skills_for`, `model_skills_for`, `exec_list_skills`, `exec_read_skill`.
- In `exec.rs`:
  - Re-export production items:
    ```rust
    pub(crate) use access::protected_refusal_text;
    ```
  - Re-export test-only items with `#[cfg(test)]`:
    ```rust
    #[cfg(test)]
    pub(crate) use fs_tools::{exec_edit, exec_ls, exec_read, exec_write, image_mime, unified_diff, MAX_READ_LINES};
    #[cfg(test)]
    pub(crate) use search::{exec_find, exec_grep, glob_match, DEFAULT_MAX_RESULTS};
    #[cfg(test)]
    pub(crate) use skills::{exec_list_skills, exec_read_skill, model_skills_for, skills_for};
    ```
  - Retain `execute_tool` router and module declarations.

**Steps:**
- [ ] Move access helpers to `exec/access.rs`.
- [ ] Move filesystem executors into `exec/fs_tools.rs`.
- [ ] Move search executors into `exec/search.rs`.
- [ ] Move skills executors into `exec/skills.rs`.
- [ ] Re-export items in `exec.rs` for test and external caller access.
- [ ] Run `cd src-tauri && cargo test agent::tools`
  - Verify all tool execution tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Verify `wc -l src-tauri/src/agent/tools/exec.rs` is under 200 lines.
- [ ] Commit with message: "refactor(tools): extract access, fs_tools, search, and skills modules"

**Acceptance criteria:**
- [ ] `exec.rs` reduced from 4,633 lines to ~150 lines (router and re-exports).
- [ ] All tool tests pass.
