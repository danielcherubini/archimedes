---
status: committed
issue: 50
done-when: `WorkerHooks` and `SessionManagerBuilder` decouple the supervisor/worker construction cycle, `SessionId`/`RequestId`/`GateKey` newtypes are introduced in Rust, and `cargo test`, `cargo clippy --all-targets` (0 warnings), `pnpm test`, and `pnpm build` pass cleanly.
---

# Session & Worker Process Supervision & Typed IDs — Plan

**Goal:** Break the circular strong-`Arc` reference cycle between `SessionManager` and `WorkerManager` in the production runtime, introduce typed `SessionId`, `RequestId`, and `GateKey` types, modularize `worker/manager.rs`, and provide a clean `WorkerHooks` trait.
**Architecture:** Add `WorkerHooks` trait and `WorkerManager::with_hooks` while maintaining backward-compatible `WorkerManager::new` wrapper delegating to an internal `ClosureHooks`; use `Arc::new_cyclic` and `Weak` in `SessionManagerBuilder` to construct cyclic dependencies safely without late-wiring setters in production; introduce `SessionId(String)` and `RequestId(String)` with `serde(transparent)` and `GateKey` in Rust; and introduce branded types in TypeScript (`src/lib/ids.ts`).
**Tech Stack:** Rust 2021, Tokio, Serde, TypeScript.

**Execution Order & Dependencies:**
- **Phase B (Integration & Supervision):** This spec is executed in **Phase B after Spec 4 is merged** (to avoid merge conflicts on `src-tauri/src/agent/mod.rs`).

**Disjoint File Boundary:**
This spec modifies:
- `src-tauri/src/agent/ids.rs` (Create)
- `src-tauri/src/agent/mod.rs`
- `src-tauri/src/agent/types.rs`
- `src-tauri/src/agent/worker/manager/` (modularized from `worker/manager.rs`)
- `src-tauri/src/agent/worker/mod.rs`
- `src-tauri/src/agent/session/mod.rs`
- `src-tauri/src/test_support.rs`
- `src-tauri/src/lib.rs`
- `src/lib/ids.ts` (Create)
- `src/lib/ids.test.ts` (Create)

---

### Task 1: Introduce Strongly-Typed `SessionId`, `RequestId`, and `GateKey` in Rust

**Context:**
Currently, session IDs and request IDs are represented as raw `String` / `&str`. Functions taking both (e.g., `permission_key(session_id, request_id)` or `respond_permission`) can have their arguments transposed without compile-time errors. Furthermore, string formatting (`format!("{session_id}/{request_id}")`) is used across multiple modules.

**Files:**
- Create: `src-tauri/src/agent/ids.rs`
- Modify: `src-tauri/src/agent/mod.rs`
- Modify: `src-tauri/src/agent/types.rs`

**What to implement:**
- In `src-tauri/src/agent/ids.rs`:
  ```rust
  #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
  #[serde(transparent)]
  pub struct SessionId(String);

  #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
  #[serde(transparent)]
  pub struct RequestId(String);

  #[derive(Clone, Debug, PartialEq, Eq, Hash)]
  pub struct GateKey {
      pub session: SessionId,
      pub request: RequestId,
  }

  impl SessionId {
      pub fn mint() -> Self {
          Self(format!("arch_{}", uuid::Uuid::new_v4()))
      }
      pub fn as_str(&self) -> &str { &self.0 }
      pub fn into_string(self) -> String { self.0 }
  }

  impl RequestId {
      pub fn new(id: impl Into<String>) -> Self { Self(id.into()) }
      pub fn as_str(&self) -> &str { &self.0 }
      pub fn with_suffix(&self, suffix: &str) -> Self {
          Self(format!("{}{}", self.0, suffix))
      }
  }

  impl GateKey {
      pub fn new(session: impl Into<SessionId>, request: impl Into<RequestId>) -> Self {
          Self { session: session.into(), request: request.into() }
      }
      pub fn to_string_key(&self) -> String {
          format!("{}/{}", self.session, self.request)
      }
  }

  impl From<String> for SessionId { fn from(s: String) -> Self { Self(s) } }
  impl From<&str> for SessionId { fn from(s: &str) -> Self { Self(s.to_string()) } }
  impl AsRef<str> for SessionId { fn as_ref(&self) -> &str { &self.0 } }
  impl std::fmt::Display for SessionId {
      fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
  }
  impl From<String> for RequestId { fn from(s: String) -> Self { Self(s) } }
  impl From<&str> for RequestId { fn from(s: &str) -> Self { Self(s.to_string()) } }
  impl AsRef<str> for RequestId { fn as_ref(&self) -> &str { &self.0 } }
  impl std::fmt::Display for RequestId {
      fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
  }
  ```
- In `src-tauri/src/agent/mod.rs`: add `pub mod ids; pub use ids::{GateKey, RequestId, SessionId};`.
- In `agent/types.rs`, delegate `mint_session_id() -> String` to `SessionId::mint().into_string()`.

**Steps:**
- [ ] Write unit tests for `SessionId`, `RequestId`, and `GateKey` in `src-tauri/src/agent/ids.rs`.
- [ ] Register `ids` in `src-tauri/src/agent/mod.rs`.
- [ ] Update `agent/types.rs` to delegate to `SessionId::mint()`.
- [ ] Run `cd src-tauri && cargo test agent::ids`
  - Ensure all ID tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "feat(agent): introduce typed SessionId, RequestId, and GateKey"

**Acceptance criteria:**
- [ ] `SessionId` and `RequestId` newtypes available with transparent serde.
- [ ] Full backward compatibility with string callers via `mint_session_id`.

---

### Task 2: Introduce Branded Types in TypeScript

**Context:**
In the frontend, `sessionId` and `requestId` are plain `string` primitives. Introducing branded type utilities in `src/lib/ids.ts` allows typing operations without breaking existing `SessionInfo.sessionId: string` component contracts.

**Files:**
- Create: `src/lib/ids.ts`
- Create: `src/lib/ids.test.ts`

**What to implement:**
- In `src/lib/ids.ts`:
  ```ts
  declare const brand: unique symbol;
  export type Brand<T, B> = T & { readonly [brand]: B };

  export type SessionId = Brand<string, "SessionId">;
  export type RequestId = Brand<string, "RequestId">;

  export const asSessionId = (id: string): SessionId => id as SessionId;
  export const asRequestId = (id: string): RequestId => id as RequestId;
  ```
- Write unit tests using `expectTypeOf` verifying that branded types are assignable to `string` while maintaining distinct compile-time brand identity.

**Steps:**
- [ ] Create `src/lib/ids.ts` and unit tests in `src/lib/ids.test.ts`.
- [ ] Run `pnpm test src/lib/ids.test.ts`.
- [ ] Run `pnpm build` from the repo root to verify clean compilation.
- [ ] Commit with message: "feat(types): introduce branded SessionId and RequestId helpers in frontend"

**Acceptance criteria:**
- [ ] `SessionId` and `RequestId` brand utilities available in `src/lib/ids.ts`.
- [ ] Zero breakage across existing frontend components and test fixtures.

---

### Task 3: Introduce `WorkerHooks` Trait with Backward Compatibility

**Context:**
`WorkerManager::new` currently accepts 4 positional closures (`factory, on_crash, on_event, sink_for`) plus a 5th hook (`cwd_registrar`) set via a `OnceLock`. Introducing a `WorkerHooks` trait and a `with_hooks` constructor provides a clean abstraction while maintaining `WorkerManager::new` as a backward-compatible wrapper for existing tests.

**Files:**
- Modify: `src-tauri/src/agent/worker/manager.rs`
- Modify: `src-tauri/src/agent/worker/mod.rs`
- Modify: `src-tauri/src/test_support.rs`

**What to implement:**
- In `manager.rs`, define:
  ```rust
  pub trait WorkerHooks: Send + Sync {
      fn on_event(&self, session_id: &str, is_subagent: bool, evt: WorkerInboundEvent);
      fn on_crash(&self, session_id: &str, code: Option<i32>, pid: Option<u32>);
      fn sink_for(&self, parent_session_id: &str) -> Option<Arc<dyn EventSink>>;
      fn register_child_cwd(&self, session_id: &str, cwd: &str);
  }

  pub(super) struct ClosureHooks {
      on_crash: Box<dyn Fn(&str, Option<i32>, Option<u32>) + Send + Sync>,
      on_event: Box<dyn Fn(&str, bool, WorkerInboundEvent) + Send + Sync>,
      sink_for: Box<dyn Fn(&str) -> Option<Arc<dyn EventSink>> + Send + Sync>,
      cwd_registrar: std::sync::OnceLock<Arc<dyn Fn(&str, &str) + Send + Sync>>,
  }
  impl WorkerHooks for ClosureHooks { ... }
  ```
- In `src-tauri/src/test_support.rs`, provide `NullHooks`.
- Add `WorkerManager::with_hooks(factory: Arc<dyn WorkerFactory>, hooks: Arc<dyn WorkerHooks>) -> Self`.
- Retain `WorkerManager::new(factory, on_crash, on_event, sink_for)` as a convenience wrapper delegating to `with_hooks` using `ClosureHooks`.

**Steps:**
- [ ] Define `WorkerHooks` trait and `ClosureHooks` in `manager.rs`.
- [ ] Add `WorkerManager::with_hooks` constructor.
- [ ] Keep `WorkerManager::new` as a wrapper delegating to `with_hooks`.
- [ ] Run `cd src-tauri && cargo test agent::worker`
  - Verify all worker tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(worker): introduce WorkerHooks trait and with_hooks constructor"

**Acceptance criteria:**
- [ ] `WorkerHooks` trait available for clean dependency injection.
- [ ] Existing callers of `WorkerManager::new` continue compiling without edits.

---

### Task 4: Add `SessionManagerBuilder` via `Arc::new_cyclic`

**Context:**
`SessionManager` and `WorkerManager` have a strong `Arc` reference cycle where each holds references to the other, requiring `OnceLock` fields and manual late-wiring setters (`attach_worker_manager`, `attach_db`, `set_sink`).

**Files:**
- Modify: `src-tauri/src/agent/session/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**What to implement:**
- Implement `SessionManagerBuilder` in `src-tauri/src/agent/session/mod.rs`:
  - Accepts `{ config_dir, db, catalog, sink, crash_log_dir, subagent_mgr, app_handle: Option<tauri::AppHandle>, worker_factory, dead_bound, persister }`.
  - Uses `Arc::new_cyclic(|weak_sm| { ... })` so that `WorkerHooks` holds a `Weak<SessionManager>`, breaking the cyclic ownership. When upgrade fails (during shutdown), log with debuglog and drop safely.
  - Returns `(Arc<SessionManager>, Arc<WorkerManager>)` fully wired.
- In `src-tauri/src/lib.rs`, simplify initialization to call `SessionManagerBuilder::new(...).build()`.
- Retain `SessionManager::new(...)` and setters for test harnesses.
- Add test: verify that dropping the supervisor's `Arc<SessionManager>` frees the manager (weak upgrade fails).

**Steps:**
- [ ] Write unit test in `session/mod.rs` verifying dropping `SessionManager` causes `Weak::upgrade` to return `None`.
- [ ] Implement `SessionManagerBuilder` using `Arc::new_cyclic`.
- [ ] Update `lib.rs` production app setup to use `SessionManagerBuilder`.
- [ ] Run `cd src-tauri && cargo test agent::session`
  - Ensure all session and worker lifecycle tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(session): add SessionManagerBuilder with Arc::new_cyclic"

**Acceptance criteria:**
- [ ] Production setup uses `SessionManagerBuilder` without late-wiring setters.
- [ ] Strong reference cycle eliminated in production setup.

---

### Task 5: Modularize `worker/manager.rs` and Log Ring Lag

**Context:**
`worker/manager.rs` spans 3,970 lines combining process tracking, reading pumps, subagent capture, and ~2,100 lines of tests. The pump also silently drops frames on `RecvError::Lagged(_) => continue` without logging.

**Files:**
- Create: `src-tauri/src/agent/worker/manager/mod.rs`
- Create: `src-tauri/src/agent/worker/manager/registry.rs`
- Create: `src-tauri/src/agent/worker/manager/pump.rs`
- Create: `src-tauri/src/agent/worker/manager/subagent_flow.rs`
- Create: `src-tauri/src/agent/worker/manager/tests/mod.rs`
- Modify: `src-tauri/src/agent/worker/manager.rs` (replace with directory)

**What to implement:**
- In `pump.rs`, log `RecvError::Lagged(n)` using `crate::agent::debuglog::log(&format!("worker pump lagged {n} frames for session {session_id}"))`.
- Move `ManagerState` and mutex helpers to `registry.rs`.
- Move subagent drive, capture, and liveness to `subagent_flow.rs`.
- Move tests to `manager/tests/`.
- Re-export `WorkerManager`, `WorkerFactory`, `SubagentCapture`, `WorkerHooks` in `manager/mod.rs`.

**Steps:**
- [ ] Add `debuglog` emission on `Lagged` error in pump.
- [ ] Split `manager.rs` into submodules under `src-tauri/src/agent/worker/manager/`.
- [ ] Run `cd src-tauri && cargo test agent::worker::manager`
  - Verify all tests pass.
- [ ] Run `cargo clippy --all-targets` and `cargo fmt --check`.
- [ ] Commit with message: "refactor(worker): modularize manager.rs and log pump lagged frames"

**Acceptance criteria:**
- [ ] `manager.rs` split into modular components.
- [ ] Ring buffer lagged events logged rather than dropped silently.
