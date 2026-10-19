---
status: committed
issue: 51
done-when: `src-tauri/src/commands/files.rs` is modularized under `commands/files/`, the `read_file_bytes` special-file cap bypass is fixed with unit tests, file commands return structured `{ kind, message }` IPC errors per ADR 0063, and `cargo test`, `cargo clippy --all-targets` (0 warnings), and `cargo fmt --check` pass cleanly.
---

# File Commands Decomposition & IPC Error Harmonization — Plan

**Goal:** Decompose the 3,251-line `src-tauri/src/commands/files.rs` into cohesive submodules under `commands/files/`, extract its 2,175 lines of tests to `commands/files/tests/`, fix the special-file/FIFO unbounded read vulnerability in `read_file_bytes`, and harmonize Tauri IPC command error handling with ADR 0063.
**Architecture:** Retain Tauri command wrappers in `commands/files/mod.rs`; extract image validation into `image.rs`, Space traversal into `space_walk.rs`, out-of-Space directory completion into `completion.rs`, and token representability into `token.rs`. Extend ADR 0063's hand-crafted `{ kind, message }` IPC error envelope to `read_file_bytes` (`FilesError`).
**Tech Stack:** Rust 2021, Tauri 2 IPC (`tauri::async_runtime::spawn_blocking`), `ignore::WalkBuilder`.

**Execution Order & Dependencies:**
- **Phase A (Parallel Foundation):** Spec 4 can be executed in parallel with Spec 1 (`harness-loop-decomposition`), Spec 2 (`tool-exec-modularization`), and Spec 5 (`frontend-store-decoupling`).
- Spec 3 (`session-worker-supervision-and-typed-ids`) runs in Phase B.

**Disjoint File Boundary:**
This spec modifies *only* `src-tauri/src/commands/files/` (and replaces `commands/files.rs`), `src-tauri/src/agent/errors.rs`, and `src-tauri/src/agent/mod.rs`. Command registration in `src-tauri/src/lib.rs` remains unchanged because the commands remain exposed at `commands::files::*`. It does NOT touch frontend `src/`, `harness/`, `tools/`, or `session/`.

---

### Task 1: Fix Image Attachment Size Cap Bypass (`read_image_capped`)

**Context:**
`read_file_bytes` currently checks `fs::metadata(&path).len()` before issuing `fs::read(&path)`. Special files (e.g. FIFOs, `/dev/zero`) report 0 bytes to metadata. Opening a FIFO directly with `File::open` blocks indefinitely until a writer appears, hanging a tokio thread. Furthermore, files growing post-metadata check can cause unbounded reads. Using `symlink_metadata` would break valid symlinked images, so `fs::metadata` must be used with non-blocking open guards on Unix.

**Files:**
- Modify: `src-tauri/src/commands/files.rs`

**What to implement:**
- Implement `read_image_capped(path: &Path) -> Result<Option<Vec<u8>>, String>`:
  1. Inspect `std::fs::metadata(path)?` (following symlinks so valid symlinks work).
  2. If `!md.is_file()`, return `Ok(None)` (skip non-regular files safely).
  3. Pre-check `image_within_cap(md.len())`.
  4. On Unix, open with `std::os::unix::fs::OpenOptionsExt::custom_flags(&mut std::fs::OpenOptions::new().read(true), libc::O_NONBLOCK).open(path)?`; on Windows, use standard `File::open(path)?`.
  5. Re-verify `file.metadata()?.is_file()`.
  6. Read via `file.take(MAX_IMAGE_BYTES as u64 + 1).read_to_end(&mut buf)`.
  7. If `buf.len() > MAX_IMAGE_BYTES as usize`, return `Err(format!("the file is {} bytes, which exceeds the {} byte limit", md.len().max(buf.len() as u64), MAX_IMAGE_BYTES))`.
- Update `read_file_bytes` to call `read_image_capped` inside `tauri::async_runtime::spawn_blocking`.
- Add unit tests verifying:
  - `#[cfg(unix)]`: special non-regular files (a FIFO created with an image extension `fifo.png` via `libc::mkfifo`) return `Ok(None)` without blocking, executed under a 500ms timeout (`tokio::time::timeout`).
  - Normal image under 10 MiB succeeds.
  - Valid symlinked image succeeds.
  - File exceeding 10 MiB returns the expected error.

**Steps:**
- [ ] Write the FIFO test on Unix under a 500ms timeout to confirm it hangs on unpatched code.
- [ ] Implement `read_image_capped` with non-blocking open and `file.take(...)`.
- [ ] Run `cd src-tauri && cargo test commands::files`
  - Ensure all image tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "fix(files): atomic capped image reading to prevent special-file bypass"

**Acceptance criteria:**
- [ ] Non-regular files refused without blocking.
- [ ] Symlinked images continue to work.
- [ ] Reads capped at `MAX_IMAGE_BYTES`.

---

### Task 2: Extract Image, Token, and Test Submodules

**Context:**
`files.rs` contains image attachment helpers, token grammar validations (`name_is_completable`), and ~2,175 lines of tests.

**Files:**
- Create: `src-tauri/src/commands/files/image.rs`
- Create: `src-tauri/src/commands/files/token.rs`
- Create: `src-tauri/src/commands/files/tests/mod.rs`
- Create: `src-tauri/src/commands/files/tests/support.rs`
- Create: `src-tauri/src/commands/files/tests/image.rs`
- Create: `src-tauri/src/commands/files/tests/space_walk.rs`
- Create: `src-tauri/src/commands/files/tests/completion.rs`
- Create: `src-tauri/src/commands/files/tests/token.rs`
- Create: `src-tauri/src/commands/files/mod.rs`
- Modify: `src-tauri/src/commands/files.rs` (replace with directory)

**What to implement:**
- In `image.rs`:
  - `IMAGE_EXTENSIONS`, `is_supported_image_path`, `image_within_cap`, `read_image_capped`.
- In `token.rs`:
  - `name_is_completable` predicate.
- In `commands/files/tests/`:
  - Distribute existing tests into themed files.
- In `commands/files/mod.rs`:
  - Re-export items needed by tests and callers with `pub(crate)`.

**Steps:**
- [ ] Snapshot test names: `cd src-tauri && cargo test commands::files -- --list | sed 's/.*:://' | sort > /tmp/files-tests-before.txt`.
- [ ] Create `commands/files/image.rs`, `token.rs`, and `tests/` modules.
- [ ] Move corresponding functions and tests.
- [ ] Verify test parity: `cd src-tauri && cargo test commands::files -- --list | sed 's/.*:://' | sort > /tmp/files-tests-after.txt`
  - Verify diff is empty.
- [ ] Run `cd src-tauri && cargo test commands::files`
  - Verify image and token tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(files): extract image, token, and test modules"

**Acceptance criteria:**
- [ ] Image and token logic cleanly separated.
- [ ] Token representability rules tested.

---

### Task 3: Extract Space Walking and Directory Completion Submodules

**Context:**
`collect_files` walks the Space directory respecting `.gitignore`, `.ignore`, and pruning `.git` VCS directories. `completion_dir` handles single-directory completion outside the Space. Both preserve a degrade-to-empty contract on join errors.

**Files:**
- Create: `src-tauri/src/commands/files/space_walk.rs`
- Create: `src-tauri/src/commands/files/completion.rs`
- Modify: `src-tauri/src/commands/files/mod.rs`

**What to implement:**
- In `space_walk.rs`:
  - `FileListDto`, `MAX_PICKER_ENTRIES`, `PRUNED_VCS_DIRS`, `is_skipped_dir`, `collect_files`.
- In `completion.rs`:
  - `CompletionEntryDto`, `CompletionDirDto`, `expand_completion_root`, `abs_to_slash`, `completion_dir`.
- In `mod.rs`:
  - Implement `#[tauri::command]` functions: `read_file_bytes`, `list_space_files`, `list_completion_entries` using `tauri::async_runtime::spawn_blocking`.
  - Preserve degrade-to-empty contract: on join error, `list_space_files` and `list_completion_entries` return `Ok` with empty lists.

**Steps:**
- [ ] Move Space walker and completion engine into their respective files.
- [ ] Run `cd src-tauri && cargo test commands::files`
  - Ensure all picker and completion tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(files): extract space_walk and completion submodules"

**Acceptance criteria:**
- [ ] `commands/files/` structured into cohesive submodules.
- [ ] All ignore and picker tests pass.

---

### Task 4: Harmonize `read_file_bytes` with ADR 0063 IPC Error Envelope

**Context:**
ADR 0063 established that Tauri IPC errors must carry `{ "kind": "<snake_case>", "message": "<sentence>" }` owned by Rust. Currently, `read_file_bytes` returns `Result<Option<Vec<u8>>, String>`. Frontend `describeIpcError` already handles `{ kind, message }` envelopes without frontend changes.

**Files:**
- Modify: `src-tauri/src/agent/errors.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/commands/files/mod.rs`
- Modify: `src-tauri/src/commands/files/image.rs`
- Modify: `src-tauri/src/commands/files/tests/image.rs`

**What to implement:**
- In `src-tauri/src/agent/errors.rs`:
  ```rust
  #[derive(Debug, PartialEq, Eq, thiserror::Error)]
  pub enum FilesError {
      #[error("the file is {size} bytes, which exceeds the {max} byte limit")]
      ImageTooLarge { size: u64, max: u64 },
      #[error("i/o error: {0}")]
      Io(String),
  }

  impl From<FilesError> for tauri::ipc::InvokeError {
      fn from(e: FilesError) -> Self {
          let kind = match &e {
              FilesError::ImageTooLarge { .. } => "image_too_large",
              FilesError::Io(_) => "io",
          };
          let mut map = serde_json::Map::new();
          map.insert("kind".into(), serde_json::Value::String(kind.into()));
          map.insert("message".into(), serde_json::Value::String(e.to_string()));
          if let FilesError::ImageTooLarge { size, max } = e {
              map.insert("size".into(), serde_json::Value::Number(size.into()));
              map.insert("max".into(), serde_json::Value::Number(max.into()));
          }
          tauri::ipc::InvokeError(serde_json::Value::Object(map))
      }
  }
  ```
  - Add unit test asserting `FilesError` serializes into `{ kind, message }` `Value::Object`.
  - Update `errors.rs` module header comment to document `FilesError`.
- In `src-tauri/src/agent/mod.rs`:
  - Add `pub use errors::FilesError;`.
- In `commands/files/mod.rs`:
  - Change `read_file_bytes` return type to `Result<Option<Vec<u8>>, FilesError>`.
- In `commands/files/tests/image.rs`:
  - Update tests to assert on `FilesError` rather than string error methods.

**Steps:**
- [ ] Define `FilesError` and IPC InvokeError conversion in `errors.rs` with unit tests.
- [ ] Update `commands/files/mod.rs` to return `Result<_, FilesError>`.
- [ ] Update `commands/files/tests/image.rs` test assertions.
- [ ] Run `cd src-tauri && cargo test agent::errors && cargo test commands::files`
  - Verify error serialization and command tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "feat(ipc): harmonize read_file_bytes errors with ADR 0063 envelope"

**Acceptance criteria:**
- [ ] `read_file_bytes` errors return structured `{ kind, message }` payloads as `Value::Object`.
- [ ] Clean compilation with 0 warnings.
