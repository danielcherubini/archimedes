---
status: committed
issue: 44
done-when: A Windows user whose first Space fails to open reads a real sentence — "Could not start a session — no models available for the native session" or "…folder not found: C:\work" — never `[object Object]`, on every surface that reports a failure; with `ARCHIMEDES_DEBUG=1` set before launch the same sentence is on disk at `%APPDATA%\archimedes\supervisor.log` (Linux `~/.local/share/archimedes/`, macOS `~/Library/Application Support/archimedes/`); the session-cwd / space-path string coupling is pinned by a test that fails if either side is normalized alone, and the Windows verbatim-path question is settled with recorded evidence rather than a guess; and the full AGENTS.md bar is green on ubuntu / windows / macos.
---

# Make every IPC failure say why — Plan

**Goal:** Make a rejected Tauri command carry its real message to the user's eye, and leave the same sentence on disk for diagnosis.

**Architecture:** Two independent halves — a Rust-side payload fix and a frontend-side renderer — plus a diagnostic-logging layer, and a Windows investigation that is deliberately pinned rather than fixed. Rust side: `SessionError` stops deriving `Serialize` and instead gets a hand-written `impl From<SessionError> for tauri::ipc::InvokeError` that always emits `{"kind", "message", …fields}` — so a payload that cannot serialize becomes unrepresentable rather than possible. Frontend side: one zero-import helper `describeIpcError(unknown): string` in `src/lib/ipcError.ts`, adopted at every `catch` that renders a rejection. Third: rejections are appended to the existing `ARCHIMEDES_DEBUG` log at the command layer, so a support report has the same sentence the user saw. The Windows verbatim `\\?\` path is investigated and its coupling pinned by a test — it is deliberately NOT stripped here, because Task 4 records five verified reasons a strip is a larger change than it looks.

**Tech Stack:** Rust 2021 (pinned by `src-tauri/rust-toolchain.toml` — do not float it, AGENTS.md), `tauri::ipc::InvokeError` 2.12.2 (`pub struct InvokeError(pub serde_json::Value)` — the field is `pub`, so it is constructible from our crate; verified against the vendored source), `serde_json`, the existing `crate::agent::debuglog`, React 19 + vitest, `@tauri-apps/api` (unmodified — no JS-side patching of the IPC layer).

---

## Diagnosis (read first — this is what the plan is fixing)

Reported symptom, on Windows, first Space on a fresh install: the error reads **`[object Object]`** and **no log file appears anywhere**. Both halves are real and independent.

**Half 1 — `[object Object]`.** Most commands return `Result<_, String>` (31 of the 43 `#[tauri::command]`s in `src-tauri/src/commands/*.rs`; the other 3 are infallible — `app_info`, `get_window_state`, …) and Tauri delivers those as a JS `string`. The session commands do not: all nine in `src-tauri/src/commands/sessions.rs` return `Result<_, crate::agent::SessionError>` (`:36`, `:46`, `:60`, `:81`, `:112`, `:134`, `:149`, `:165`, `:179`), and `SessionError` derives `#[serde(tag = "kind", rename_all = "snake_case")]` (`src-tauri/src/agent/errors.rs:10-11`). Tauri turns the error into `InvokeError` via the blanket `impl<T: Serialize> From<T> for InvokeError` (`tauri-2.12.2/src/ipc/mod.rs:240-247`), which is `serde_json::to_value(value).map(Self).unwrap_or_else(Self::from_error)`. So the webview rejects with a **plain object**, and every call site uses the `e instanceof Error ? e.message : String(e)` idiom — whose fallback is exactly what prints `[object Object]`. 18 such sites are listed in Task 2 (plus one console-only site it also fixes).

**Half 1b — a second, worse bug found while verifying this one.** An internally-tagged enum cannot serialize a *newtype variant containing a string* (serde's constraint). `SessionError::Io(String)` is exactly that, and it is constructed 13 times in `src-tauri/src/agent/session/mod.rs` — 11 with a hand-written sentence (`"a native session requires an attached database"` at `:826`/`:894`, `"list_sessions requires an attached database"` at `:1068`, `"the session's WorkerManager is not attached"` at `:891`/`:1197`/`:1309`/`:1354`/`:1402`/`:1593`/`:1660`/`:1703`) and 2 carrying a raw `DbError` string (`:952`, `:1072`). Measured against this tree with a throwaway integration test:

```
Command { error: "boom" }      -> {"error":"boom","kind":"command"}
FolderMissing { path: "C:\\x" } -> {"kind":"folder_missing","path":"C:\\x"}
Io("disk")                     -> <SER FAIL: cannot serialize tagged newtype variant SessionError::Io containing a string>
```

So an `Io` rejection reaches the user as the serde complaint string, not the actual reason — the `unwrap_or_else(Self::from_error)` fallback in `ipc/mod.rs:245` replaces the error with the serialization error. The wire string a user saw for those 13 sites was `"cannot serialize tagged newtype variant SessionError::Io containing a string"`. Task 1 fixes this too, and its test pins it.

**Half 2 — no log.** Nothing logs a command rejection. `start_session`'s exits are silent `return Err(...)`: `agent/session/mod.rs:1133` (`FolderMissing` from a failed `canonicalize`), `:914` (`resolve_native_model` → `Command`), `:824`/`:891` (`Io`). `debuglog` is opt-in (`ARCHIMEDES_DEBUG=1`, read once at startup — `agent/debuglog.rs:43-56`), and release builds are `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` (`src-tauri/src/main.rs:2`), so no console exists and `eprintln!` (the command layer's existing diagnostic convention, `commands/spaces.rs:78`, `commands/files.rs:941`) is invisible. `%APPDATA%\archimedes` containing only `archimedes.db` and no crash log is the *expected* state here — a rejected command is not a panic, so `crashlog` never runs.

**Leading hypothesis for what actually failed on their machine.** A brand-new install has no providers configured, so `resolve_native_model` (`agent/session/mod.rs:1776-1799`) finds nothing in the catalog and returns `SessionError::Command { error: "no models available for the native session" }` (`:1796`). That fits every observed fact: first Space, fresh Windows install, a structured `{"kind":"command","error":"…"}` rejection, no log. After Task 1 + Task 2 the banner reads **"Could not start a session — command failed: no models available for the native session"**, which is actionable. Confirming it needs that one line from their machine — which is precisely what Tasks 1-3 make possible. Do not "fix" the model-resolution message before confirming; a dedicated hint ("add a provider in Settings") is a follow-up, recorded at the bottom of this doc.

**Second candidate — the Windows verbatim path (and why it is not a quick fix).** `std::fs::canonicalize` on Windows returns `\\?\`-prefixed paths (`\\?\C:\Users\…` for a normal path, `\\?\C:\` for a drive root). That string is persisted by `space_key` (`storage/db.rs:742-746`) and `upsert_space` (`:644-652`), stored on `sessions.cwd` (`:317-325`), handed to the Worker as `StartEnv.cwd` (`agent/session/mod.rs:951-967` → `agent/worker/core.rs:253`) and shown in the tab tooltip (`src/components/SpaceTabs.tsx:237-239`). Windows users are therefore seeing `\\?\C:\…` in the UI today. Task 4 investigates this as its own defect with a failing test, and it is defensible without the drive-root theory being true.

---

## Conventions for every task

All Rust commands run from `src-tauri/` (the pinned toolchain resolves there — AGENTS.md); frontend commands from the repo root. The merge bar is `cargo fmt --all -- --check` (what `.github/workflows/ci.yml:118` runs), `cargo clippy --all-targets -- -D warnings` (0 warnings), `cargo test`, `pnpm test`, `pnpm build`. CI runs the whole bar on **ubuntu / windows / macos** (`ci.yml:24`), and `--all-targets` lints test code too, so every change must compile and lint on all three.

Branch per `gitflow-branching`: one `feature/readable-ipc-errors` off `main`, commits within it, squash-merge at the end. Per AGENTS.md, **write the failing test first and confirm it fails**. This doc is **deleted on ship**.

⚠ Two traps a context-free reader falls into:

- **`src-tauri/tests/ipc.rs` is `#![cfg(target_os = "linux")]`-gated** (the header explains: the macOS one-thread harness has not landed). Anything added to that file never runs on Windows/macOS. Prefer unit tests inside the owning module — they run on all three.
- **`crashlog.rs` has a census invariant** forbidding a `dirs::data_dir()` call in its production region (`childproc` idiom; AGENTS.md and ADR 0025 §"guards"). Task 3 does not touch that file. Do not add a data-dir resolver anywhere new — `debuglog::log` already knows its directory.

---

### Task 1: `SessionError` reaches the wire with a guaranteed `message`

**Context:**
The frontend cannot be made safe alone: today the payload itself is wrong (no `message` key at all for six variants, and a serde error string for `Io`). Fix it at the source so every session command's rejection is a self-describing object, then let the frontend render it. The decision: hand-write the conversion instead of deriving `Serialize`, and **remove the `Serialize` derive entirely**. That removal is load-bearing, not tidiness: Tauri's `From<T> for InvokeError` blanket impl only applies to `T: Serialize`, so dropping the derive means the only route from `SessionError` to the wire is our `impl From<SessionError> for InvokeError`. A future variant containing something unserializable then fails at **compile time** in this file instead of silently turning into a serde complaint at runtime — which is exactly the bug class that produced Half 1b.

**Files:**
- Modify: `src-tauri/src/agent/errors.rs`
- Modify: `src-tauri/src/commands/sessions.rs` (only if a test needs a re-export; the command signatures do NOT change)
- Test: inside `src-tauri/src/agent/errors.rs` in a new `#[cfg(test)] mod tests` (the file has none today)

**What to implement:**

1. In `src-tauri/src/agent/errors.rs`, change the derive from
   `#[derive(Debug, thiserror::Error, Clone, Serialize, PartialEq, Eq)]` to
   `#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]`
   and delete the `#[serde(tag = "kind", rename_all = "snake_case")]` attribute plus the now-unused `use serde::Serialize;` (line 5) — clippy `-D warnings` fails on the unused import. Keep every variant, every `#[error(...)]` Display string, and the variant **names** unchanged.

2. Add the conversion:

   ```rust
   /// The serialized `kind` discriminator (the wire contract — see the ADR).
   fn kind(&self) -> &'static str
   ```
   A private method on `SessionError` returning, exactly, in variant order:
   `"io"`, `"command"`, `"unknown_session"`, `"not_resumable"`, `"folder_missing"`, `"invalid_prompt"`, `"settle_timeout"`.
   (These are byte-identical to what `rename_all = "snake_case"` produced, so any external reader of `kind` keeps working.)

3. Add:

   ```rust
   impl From<SessionError> for tauri::ipc::InvokeError {
       fn from(err: SessionError) -> Self { … }
   }
   ```

   Building a `serde_json::Value::Object` with `tauri::ipc::InvokeError` — whose single field is `pub` (`tauri-2.12.2/src/ipc/mod.rs:224`) — so a plain `tauri::ipc::InvokeError(json)` works. Keys, always:

   - `"kind"` → `err.kind()`
   - `"message"` → `err.to_string()` — the `#[error(...)]` Display string, e.g. `"folder not found: C:\\work"`. **This key is the contract Task 2 renders and it must always be a non-empty string.**
   - plus the variant's own field, name preserved from the current struct shape: `Command → "error"`, `UnknownSession → "id"`, `NotResumable → "id"`, `FolderMissing → "path"`, `InvalidPrompt → "reason"`, `SettleTimeout → "detail"`. `Io` contributes no extra key (its payload is already in `message`).

   Match over the variants explicitly (no catch-all arm that a new variant could hide behind — an exhaustive `match` makes adding a variant a compile error here, which is the point).

4. Do NOT change `commands/sessions.rs` signatures: `Result<SessionInfo, crate::agent::SessionError>` keeps compiling because the generated wrapper requires `E: Into<InvokeError>` (`tauri-2.12.2/src/ipc/command.rs:258`) and our `From` satisfies it. Verified by compiling this exact pattern against the tree.

**What NOT to change:** the other 31 commands all return `Err(String)` and are correct as they are — do not "unify" them. Do not touch `src-tauri/src/agent/mcp/rpc.rs:33` — that is a **different, unrelated** `SessionError` struct (a JSON-RPC error object); a workspace-wide rename or search-and-replace will corrupt it. Do not add `Serialize` back, and do not add a `Deserialize` impl (nothing reads these from the wire).

**Steps:**
- [ ] Write the failing test in `src-tauri/src/agent/errors.rs`: `every_variant_reaches_the_wire_with_a_kind_and_a_nonempty_message`. Iterate all seven variants; for each, `let wire = tauri::ipc::InvokeError::from(err.clone()).0;` and assert (a) `wire["kind"]` equals the expected string, (b) `wire["message"].as_str()` is `Some` and non-empty and equals `err.to_string()`, (c) the variant's own field key matches. Assert the `Io` case **specifically**: `SessionError::Io("the session's WorkerManager is not attached".into())` must produce `"message": "i/o error: the session's WorkerManager is not attached"` and must NOT contain the substring `"cannot serialize"`.
  Run `cargo test --lib agent::errors` from `src-tauri/`.
  - ⚠ Expect an **assertion** failure, NOT a compile error: with `Serialize` still derived, Tauri's blanket `impl<T: Serialize> From<T> for InvokeError` (`ipc/mod.rs:240-247`) already satisfies `Into<InvokeError>` and `.0` is already `pub`, so the test builds and fails on `assert!(!wire.to_string().contains("cannot serialize"))`. Do not treat a red that is an assertion (rather than a compile error) as a broken harness.
- [ ] Implement steps 1-3.
- [ ] Run `cargo test --lib agent::errors` — green?
- [ ] Run `cargo test` — the whole Rust suite green? (Anything that serialized `SessionError` breaks loudly here; a grep during planning found no other consumer, but the compiler is the check.)
- [ ] Run `cargo clippy --all-targets -- -D warnings` from `src-tauri/` — 0 warnings (watch for the unused `use serde::Serialize;`).
- [ ] Run `cargo fmt --all -- --check` — clean (else `cargo fmt --all`).
- [ ] Commit: `fix(ipc): SessionError always carries a message — the Io variant sent a serde error`

**Acceptance criteria:**
- [ ] All seven variants produce a JSON object with `kind` + non-empty `message`; the six structured ones keep their own field key.
- [ ] `SessionError::Io` no longer produces `"cannot serialize tagged newtype variant …"`.
- [ ] `Serialize` is not derived on `agent::errors::SessionError` anywhere in the file (grep `Serialize` in it → no hits).
- [ ] `kind` strings are byte-identical to the previous `rename_all = "snake_case"` output.

---

### Task 2: `describeIpcError` — one renderer for every rejection

**Context:**
Task 1 guarantees a `message`, but only if something reads it. 18 `catch` sites across the frontend render a rejection (15 match `e instanceof Error ? e.message : String(e)` on one line, `ChatStream.tsx:1110` is the same shape spread over six lines and invisible to that pattern, and 2 are bare `String(error)` — `UpdateSection.tsx:176`/`:209`), and one console-only site interpolates a bare `String(err)` into its own message. The dominant shape is `e instanceof Error ? e.message : String(e)`, inherited from when every command rejected with a plain string; `ChatStream.tsx:1109-1114` already carries the correct three-way unwrap with the comment "a pre-existing gap" and `ChatStream.test.tsx:2186` pins it ("a non-Error rejection shows the message, not [object Object]"). Decision: fix **all** sites, not just the session-start path. Reasons: the shape is byte-identical at every site, so a partial fix leaves 18 latent copies of a bug whose symptom is "the user cannot read the error"; and the two sites in the reported flow (`store/sessions.ts:1054`, `NewSpaceDialog.tsx:97`) are the least likely places a future report will name. The helper lives in its **own zero-import module** rather than in `src/lib/tauri.ts` because three of the consuming files (`settings/UpdateSection.tsx`, `settings/WebSearchSection.tsx`, `settings/McpSection.tsx`) do not import `lib/tauri` today, and pulling `@tauri-apps/api/core` + `/event` into a Settings component to format a string is a dependency edge in the wrong direction.

**Files:**
- Create: `src/lib/ipcError.ts`
- Test: `src/lib/ipcError.test.ts`
- Modify (18 rendering sites + 1 console site = 19, listed exhaustively):
  - `src/store/sessions.ts:1054`
  - `src/components/NewSpaceDialog.tsx:58`, `:97`
  - `src/components/ChatStream.tsx:1109-1114` (the inline three-way unwrap), `:1133`, `:1308`
  - `src/components/PermissionPrompt.tsx:42`
  - `src/components/AskQuestionCard.tsx:241`
  - `src/components/SudoConfirmModal.tsx:44`
  - `src/components/SudoPasswordModal.tsx:58`
  - `src/components/SessionConfigSelect.tsx:201`
  - `src/components/settings/McpSection.tsx:91`, `:106`
  - `src/components/settings/WebSearchSection.tsx:66`, `:146`, `:204`
  - `src/components/settings/UpdateSection.tsx:176`, `:209` (these two use a bare `String(error)` — the worst shape, since the updater's typed codes like `release-not-found` are the diagnostic and currently go through the same fallback)
  - plus one console-only site, handled by implement step 5 (read the exclusion rule there): `src/lib/tauri.ts:977`

**What to implement:**

1. `src/lib/ipcError.ts`, no imports at all (so no test in this file needs to mock Tauri):

   ```ts
   /** Render a rejected Tauri command as the sentence the user should read. */
   export function describeIpcError(err: unknown): string
   ```

   Resolution order, each step guarded so a hostile/absurd value cannot throw:
   1. `typeof err === "string"` → `err` (the 31 `Err(String)` commands — the majority of the surface).
   2. `err instanceof Error` → `err.message`.
   3. a non-null object with a **string** `message` property → that string. This is the Task 1 envelope and the shape `ChatStream.test.tsx:2186` already asserts.
   4. a non-null object with a string `kind` property → the `kind` alone (`"folder_missing"`), which is strictly better than `[object Object]` and is the last thing available when a payload arrives with no `message` (e.g. an older backend behind a newer webview).
   5. otherwise → `String(err)`, and if that yields exactly `"[object Object]"`, return `"unknown error"` instead — never emit the string this whole plan exists to remove. **Wrap this step in `try`/`catch` returning `"unknown error"`**: `String()` itself throws (`TypeError: Cannot convert object to primitive value`) on `Object.create(null)` and on `{ toString: null }`, so the step that is supposed to be the safe fallback is the only one that can throw. Unreachable from a real Tauri rejection (JSON yields plain objects), but this function is documented as total and Task 5 makes the order normative.

   Note resolution rule 5's `[object Object]` guard is the safety net, not the mechanism; the mechanism is rules 1 and 3.

2. At each of the 18 rendering sites, replace the expression with `describeIpcError(e)` / `describeIpcError(err)` / `describeIpcError(error)` as named there, and add the import. Use the `@/lib/ipcError` form in files that already use `@/…` imports (all `src/components/settings/*` files do) and the relative form (`../lib/ipcError`, `./ipcError`) in files that use relative imports, matching each file's existing style — do not mix styles within a file.

3. `src/components/ChatStream.tsx`: replace **only** the `const msg = …` expression at `:1109-1114` with `const msg = describeIpcError(err);`, and rewrite the three comment lines at `:1106-1108` to point at `src/lib/ipcError.ts`. ⚠ **Do not touch `:1105`** — `turnCompleted(targetSessionId, "end_turn");` is live turn-state code inside the same `catch`, and nothing in `ChatStream.test.tsx` asserts it for *this* error path, so deleting it is a silent behavioral regression. Leave `:1115-1117` (the `activeSessionIdRef` guard) alone. The existing test at `ChatStream.test.tsx:2186` must stay green **unchanged** — it is the regression proof that the migration preserved behavior (it rejects with `{kind: "error", message: "proto"}` and expects `"proto"`, which is rule 3).

4. Migrate the remaining 16 rendering sites (the exhaustive list minus the two done in step 2). Same mechanical change; import style per file as step 2 says. Also rewrite the stale `String(e)` mention in the `NewSpaceDialog.tsx:38-43` comment block while you are in that file, so the second invariant grep's residue promise holds.

5. The one console-only site, `src/lib/tauri.ts:977`. The exclusion rule below says console-only sites are left alone, and this one is console-only — it is included deliberately, on a different basis: `lib/tauri.ts` **owns the formatting of that message** (it composes the whole `external open refused: …` line), so the rule reads: *console-only sites are left alone unless the module already owns the message's formatting.* It is `Err(String)` today, so this changes no output; it future-proofs the line and keeps the greps clean. `src/lib/tauri.test.ts:288`/`:296` assert with `toContain` on the refusal code and stay green because rule 1 returns the string unchanged.
   Note what this does NOT fix, and record it in the PR body: `close_session` rejections are logged (`console.error` at `SpaceTabs.tsx:334`/`:340`) and rendered nowhere, so a close failure stays invisible to the user — Task 3 logs it server-side, nothing surfaces it. Filed under Follow-ups.

**What NOT to change:** no component's state shape, no error UI, no banner copy. `NewSessionErrorBanner.tsx`'s text "Could not start a session — {newSessionError}" stays exactly as written; only what fills `newSessionError` changes. Do not make `describeIpcError` localize, prefix, or add punctuation. **Exclusion rule:** console-only sites are left alone — logging a rejection is not rendering one — **unless the module already owns that message's formatting** (which is why `src/lib/tauri.ts:977` IS in scope — implement step 5). So `src/components/SpaceTabs.tsx:334`/`:340` and the other console-only catches (`SettingsPage.tsx:167`, `SpacesList.tsx:461`/`:647`/`:803`, `SpaceTabs.tsx:112`, `useSkillCatalog.ts:67`, `useMentionCatalogs.ts:118`, `store/settings.ts:28`, `lib/settings.ts:63`, `store/sessions.ts:1264`/`:1440`, `App.tsx:321`) stay as they are.

**Steps:**
- [ ] Write `src/lib/ipcError.test.ts` FIRST with cases for: a plain string; an `Error` (message wins over any own `message` oddity); `{"kind":"folder_missing","message":"folder not found: C:\\work","path":"…"}` → the message; `{}` → not `"[object Object]"`; `{kind:"command"}` → `"command"`; `{message: 42}` (non-string message) → falls through to `kind`/`String`; `null`, `undefined`, `42`, `""`, an array; and an object whose `message` is an **inherited** getter (a class instance that is not an `Error`) → renders without throwing.
  Run `pnpm test src/lib/ipcError.test.ts` from the repo root.
  - Did it fail with "Cannot find module './ipcError'"? Expected.
- [ ] Implement `src/lib/ipcError.ts`; re-run `pnpm test src/lib/ipcError.test.ts` → green.
- [ ] Migrate the two sites in the reported flow first — `src/store/sessions.ts:1054` and `src/components/NewSpaceDialog.tsx:97` — then run `pnpm test` (the whole frontend suite). Green with no existing expectation edited? If `ChatStream.test.tsx:2186` or any `sessions.test.ts` error assertion changed meaning, stop: the helper is not a drop-in and the resolution order is wrong.
- [ ] Migrate the remaining 16 rendering sites (step 4), then `src/lib/tauri.ts:977` (step 5).
- [ ] Run `pnpm test` → green.
- [ ] Run `pnpm build` → succeeds (this is the type-check; the `unknown` argument makes a forgotten site visible only at runtime, so also confirm with the two greps below).
- [ ] **Invariant grep 1:** `grep -rn "instanceof Error ? " src/ --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v "lib/ipcError.ts"` → **nothing**. (`lib/ipcError.ts` is excluded because rule 2 legitimately tests `err instanceof Error` — write it as an `if`, never as the `x instanceof Error ? …` ternary, or the helper fails its own invariant.)
- [ ] **Invariant grep 2:** `grep -rn "String(err)\|String(e)\|String(error)\|String(ex)" src/ --include=*.ts --include=*.tsx | grep -v "\.test\."` → **nothing**, or only comments. This grep is mandatory and is not redundant with grep 1: `UpdateSection.tsx:176`/`:209` are bare `String(error)` and grep 1 structurally cannot see them, yet the plan calls them the worst sites (they swallow the updater's typed codes). Before the change grep 2 also matches two comment lines (`NewSpaceDialog.tsx:42`, `ChatStream.tsx:1107`) — both disappear as you migrate.
- [ ] Commit: `fix(ui): one IPC-error renderer — 19 sites stop printing [object Object]`

**Acceptance criteria:**
- [ ] `describeIpcError` has zero imports and its own passing test file.
- [ ] Both invariant greps are empty (the `instanceof Error ?` shape and the bare `String(err)` shape).
- [ ] `Object.create(null)` and `{ toString: null }` return `"unknown error"` rather than throwing (asserted in `ipcError.test.ts`).
- [ ] `ChatStream.test.tsx:2186` passes with its assertions unedited.
- [ ] The string `[object Object]` appears in `src/` only in test names/comments, never in a rendered path.

---

### Task 3: log every session-command rejection to the debug log

**Context:**
Half 2 of the diagnosis: a rejected command leaves no trace, because nothing logs it and the release build has no console. Decision (approved in discussion): write rejections into the **existing** `debuglog` — i.e. behind `ARCHIMEDES_DEBUG=1`, not always-on. What that costs is stated honestly so the next reader does not "fix" it: a user reporting a bug must have set the variable before reproducing, which is exactly the step that hid this report. What it buys is that the diagnostic surface stays one switch, the log keeps its existing 5 MB rotation, and nothing writes to disk on a normal run. `debuglog::log` is a free no-op when disabled (a cached atomic read, `agent/debuglog.rs:28`, `:58-60`) and creates no file, so wrapping every command costs nothing when the variable is unset. The command layer is the right place, not `SessionManager`: the manager is used by the Worker and by tests, and the rejection the user sees is formed at the IPC boundary.

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`
- Test: a new `#[cfg(test)] mod tests` at the bottom of `src-tauri/src/commands/sessions.rs` (none today). Deliberately **not** `src-tauri/tests/ipc.rs` — that file is Linux-gated (see Conventions).

**What to implement:**

1. A private wrapper in `commands/sessions.rs`:

   ```rust
   /// Log a rejected session command to the `ARCHIMEDES_DEBUG` log (a no-op when off).
   fn logged<T>(command: &str, result: Result<T, crate::agent::SessionError>) -> Result<T, crate::agent::SessionError>
   ```

   Composed through a pure helper so the format string is testable without the global logger:

   ```rust
   /// The log line for a rejected command (PURE — no global state).
   fn logged_line(command: &str, err: &crate::agent::SessionError) -> String
   ```
   returning `format!("ipc {command} FAILED: {err}")`, and `logged` doing
   `if let Err(e) = &result { debuglog::log(&logged_line(command, e)); }`.
   Returns the result unchanged, unconditionally — the wrapper must not be able to alter control flow. Include the `Display` string (`{e}`), which is the same sentence the user sees after Tasks 1-2, so a support log and a screenshot agree.

2. Wrap the body of each of the nine commands so the single returned `Result` passes through `logged`: `start_session`, `send_prompt`, `close_session`, `respond_permission`, `respond_interactive_request`, `resume_session`, `set_session_config_option`, `cancel_session`, `compact_session`. `commands/sessions.rs:31-195` is the whole file's command region. Use the command's own snake_case name as the label (`"start_session"`, …) — these strings are what a person greps for.
   `get_stalled_info` (`commands/sessions.rs:190`, the last command in the file) returns `Result<_, String>` and is a pure query — **do not** wrap it.

3. For `respond_permission` / `respond_interactive_request`, whose bodies have an `if !hit { eprintln!(…) }` after the `?`, keep that `eprintln!` and restructure minimally so the `Result` still goes through `logged` (e.g. bind the inner call to a local, pass it to `logged` with `?`, then the `hit` check). Behavior unchanged; the existing `eprintln!` stays.

4. Do NOT also add the command's arguments to the line. `send_prompt` carries the user's **prompt text**; writing prompt text into a log file is a privacy change and belongs to a decision this plan does not make. Session ids and command names only. (Note: `debuglog` already logs full IPC frames including prompt text when `ARCHIMEDES_DEBUG=1` — `agent/worker/client.rs` `log_truncated` on both directions — so this task adds nothing new on that axis, and it must not add more.)

**Steps:**
- [ ] Write the failing tests. TWO seams, because the global `debuglog::DIR` is process-global and Worker tests call `debuglog::log` **without** holding the env lock (`agent/worker/manager.rs:556`/`:981`, `worker/client.rs:330`/`:344`), so a test that points the global at its own temp dir and demands the line landed there can be redirected by a sibling test and fail non-deterministically. `debuglog`'s own tests solved this by routing the interesting case through the pure `append_to` — copy that shape.
  1. **Pure (the real assertions, no global state):** `fn logged_line(command: &str, err: &SessionError) -> String` (step 1 below), tested directly — `logged_line("start_session", &SessionError::FolderMissing { path: "/nope".into() })` contains `start_session`, `ipc`, `FAILED` and `folder not found: /nope`. Use a unique `uuid` marker in the message where you can.
  2. **Wiring (thin, race-tolerant):** take `crate::test_support::env_lock()` — ⚠ that is the correct helper (`test_support.rs`, `#[cfg(test)] pub(crate)`); `debuglog`'s own `lock()` is a private fn inside its `#[cfg(test)] mod tests` and is **not importable** from here. With `debuglog::init(true, Some(temp_dir))`, assert `logged("start_session", Err(…))` returns the `Err` **unchanged** (same variant + payload) — that is the whole contract of the wrapper, and it needs no read of the shared file. If you also assert the line reached `supervisor.log`, make it `contains`-tolerant with a per-test unique marker and say why in a comment (the `log_delegates_to_append_to_when_enabled` convention).
  3. **No disabled-case test here — deliberately.** `debuglog::init(false, Some(dir))` sets `DIR = None` too (`debuglog.rs:34`/`:36`: `*g = if enabled { dir } else { None }`), so it is byte-identical global state to `init(false, None)` and a "no file was created" assertion **cannot fail** under either — deleting `log`'s flag guard still returns at the `let Some(dir) = dir else { return }` guard (`:61-67`). Do NOT invent a test-only seam in `debuglog.rs` to make it assertable; the no-op-when-disabled behavior is already pinned by `debuglog.rs`'s own `log_is_a_noop_when_disabled`. `logged` never consults the flag itself — that is seams 1 and 2's job. Finish the test by calling `debuglog::init(false, None)` so the global is clean for sibling tests.
  Run `cargo test --lib commands::sessions` from `src-tauri/`.
  - Fail with "cannot find function `logged`"? Expected.
- [ ] Implement `logged` + the nine wraps.
- [ ] Run `cargo test --lib commands::sessions` → green.
- [ ] Run `cargo test` → whole suite green (the wraps are transparent; any test driving a session command exercises them).
- [ ] Run `cargo clippy --all-targets -- -D warnings` → 0 warnings.
- [ ] Run `cargo fmt --all` then `cargo fmt --all -- --check` → clean.
- [ ] Commit: `feat(diagnostic): rejected session commands land in the ARCHIMEDES_DEBUG log`

**Acceptance criteria:**
- [ ] All nine session commands log `ipc <name> FAILED: <Display>` on rejection, and only on rejection.
- [ ] `logged` contains no enablement check of its own (it delegates to `debuglog::log`, whose own suite pins the disabled case) — so there is no second flag to drift out of sync.
- [ ] No prompt text, image data, or user path other than the error's own message reaches the log line.
- [ ] `tests/ipc.rs` is untouched.

---

### Task 4: diagnose the Windows verbatim path — and guard the coupling that makes a naive fix unsafe

**Context:**
`std::fs::canonicalize` on Windows returns **verbatim** paths: `\\?\C:\Users\me\proj`, and `\\?\C:\` for a drive root (`/?/C:/…` on some targets). That string reaches the database (`storage/db.rs:745` `space_key`, `:325` `record_session`), the Worker (`agent/session/mod.rs:959` → `StartEnv.cwd`), the system prompt (`harness/prompt.rs:138`, which slash-normalizes it into `//?/C:/Users/me` — a path the model cannot use), and the UI (`types.rs:31` `SessionInfo.cwd` is a `PathBuf`, serde stringifies it verbatim, and `src/lib/tauri.ts:53` types it as `string`; `SpaceTabs.tsx:237-240` renders it in a tooltip). So a Windows user is being shown `\\?\C:\…` today, and it is a reasonable hypothesis that this is what broke the reported Space.

**This task does not strip the prefix.** A first draft of this plan proposed exactly that — a `plain_display` helper at four sites plus a re-key migration — and two independent review passes, both verified by experiment, found it would have shipped three serious regressions. Those findings are recorded below **as constraints**, because the strip is genuinely tempting and the next reader will be tempted too. The task instead: pin the coupling with a test that a naive fix turns red, settle the long-path question with evidence, and get the facts off the reporter's machine. If the evidence then says the prefix is the cause, **ADR 0063's follow-up designs the fix against the constraints below** — it is a change with a real blast radius, not a helper plus a grep.

**Why a naive strip is unsafe — read all five before proposing anything:**

1. **`\\?\` is load-bearing for long paths.** `src-tauri/windows-app-manifest.xml` is 14 lines and contains **no** `<longPathAware>` element (verified: `grep -c longPathAware` → 0); `build.rs:21-23` documents it as a byte-for-byte copy of tauri-build's default ("same md5", restated at `:84-86`). Without long-path awareness, Win32 wide APIs reject a non-verbatim path over `MAX_PATH` (260) with `ERROR_PATH_NOT_FOUND`, so the verbatim prefix from `canonicalize` is currently **the only thing that lets a deep Space open**. Stripping it where a path is later opened — `StartEnv.cwd` (`mod.rs:959` → `worker/core.rs:253` → `tools/exec.rs:401` `cmd.current_dir(&ctx.cwd)`) — turns a working deep Space into failures. And a re-key migration is worse: it rewrites `sessions.cwd` to the plain form, `resume_session` then canonicalizes that (`mod.rs:1156`) on a 300-char path, that **fails**, and the user gets *"folder not found"* for a folder that exists. The plan's earlier claim that "the `PathBuf` stays a `PathBuf`, so only strings change" is false for `StartEnv.cwd`, which is a `String` and *is* the path handed to the OS.
2. **The frontend joins Spaces to sessions by raw string equality against `SessionInfo.cwd`.** seven sites in `src/store/sessions.ts` (`:465`, `:501`, `:559`, `:564`, `:920`, `:965`, `:1248`) compare `session.cwd === space.path`, plus `SpaceTabs.tsx:106` (the tab-close "how many are open" gate) and `:162` (the per-tab count) and `SpacesList.tsx:74` (reached with `session.cwd` from `:204`/`:758`). `sessions.ts:1037` gates `startSessionInActiveSpace` on the same equality and `SpaceTabs.tsx:150` drives the highlight downstream of `addSpace(info.cwd)` (`sessions.ts:944`). If the DB stores the plain form while `SessionInfo.cwd` still carries `\\?\`, `addSpace(info.cwd)` (`sessions.ts:1052`, `NewSpaceDialog.tsx:92`) mints a **second tab for one folder**, sessions render in no Space group, and `delete_space` (`db.rs:721-725`) and `find_space` (`db.rs:691-694`) take the frontend string **raw**, so a close-forget and the dialog's "is this already a Space" check go wrong in silence (`set_space_trusted` at least `eprintln!`s its miss, `commands/spaces.rs:78`, and DOES re-canonicalize at `db.rs:661`, so a trust write would still land on the verbatim row — the two sides drift **differently**, which is worse than drifting together). Any fix must move **both** sides in one change, or neither.
3. **`worker/manager.rs:768`** matches Workers with `entry.env.cwd == cwd` — a raw string compare between `StartEnv.cwd` and a Space path the frontend supplied. A one-sided strip makes a mid-session trust flip deliver to zero Workers, silently.
4. **`Db::open`'s migration ordering bricks startup if guessed.** The probe+transaction pattern cited at `db.rs:118-131` runs **before** `conn.execute_batch(SCHEMA)` at `:162`, where `spaces` does not exist yet — a `SELECT … FROM spaces` there errors `no such table`. A re-key must go **after** `:162`. And `spaces.path` is a `PRIMARY KEY`: an `UPDATE` onto an existing plain key raises `UNIQUE constraint failed`, which propagates as `DbError::Sqlite` and **fails `Db::open` forever** — the file's own comments at `:239-250` describe exactly this class. Delete-then-update also silently discards the verbatim row's `trusted`, reintroducing the forgotten-trust-flag bug the migration exists to prevent.
5. **A SQL `LIKE` probe silently matches nothing.** Verified against sqlite3 with a seeded `\\?\C:\proj`: `LIKE '\\?\%' ESCAPE '\'` matches **0** rows (under `ESCAPE '\'` the pattern is a 5-char exact match — no wildcard); `substr(path,1,4)='\\?\'` matches 1. A probe that finds nothing makes the migration look correct on every database except the ones it exists to fix. If SQL is used at all, use `substr`; prefer a Rust-side `starts_with(r"\\?\")` scan. Note also that `LIKE` is ASCII-case-insensitive while `PRIMARY KEY` lookups are binary — another way the two disagree.

**What IS safe, and why the PathBuf comparisons are not part of the problem:** the trusted-space lookup, the sandbox's
session-boundary checks and `FsBackend::check_under_roots` all canonicalize **both** sides at check time
(`fs_backend.rs:161-171`, `agent/boundary.rs:96-98`, `tools/sandbox.rs:573-589`, `tools/exec.rs:320-323`), so both
carry the prefix and they agree — they are genuinely unaffected. ⚠ Wording matters here: `canonicalize` does not
*remove* the prefix on Windows, it **adds** it (`agent/boundary.rs:28-35` documents exactly this). Anyone tempted to
reason "the OS normalizes it away" should apply that to a **string** site first — that is how the bug comes back.

**What is safe to do now, and is the scope of this task:**

1. **Pin the coupling** so a future one-sided strip goes red in CI rather than shipping two tabs.
2. **Settle the long-path question** (does the manifest need `<longPathAware>`?) and record it, because the answer gates any strip.
3. **Get the evidence** from the reporter's machine, which Tasks 1-3 now make possible.

**Files:**
- Modify: `src-tauri/src/types.rs` (`SessionInfo.cwd` — a doc comment only, no type change)
- Test: `src-tauri/tests/storage.rs` (a new characterization test; this file already covers the Space/session cwd coupling at `:413-434`)
- Modify: `docs/roadmap/readable-ipc-errors.md` — this file, adding a `## Findings` section (step 4)

**What to implement:**

1. A **characterization test** in `src-tauri/tests/storage.rs`, named `the_session_cwd_string_and_the_space_path_key_are_the_same_string`. Purely at the `Db` level — no session machinery needed:
   - build a real temp dir and **canonicalize it before building the `SessionInfo`**: `let dir = std::fs::canonicalize(base.join("space")).expect("canonical");`, then `cwd: dir` as a `PathBuf`. ⚠ This is not hygiene, it is the difference between green and red on 2 of 3 CI platforms: `record_session` writes the **raw** `info.cwd.display()` while `upsert_space` writes the **re-canonicalized** `space_key()`, so a raw temp path diverges on macOS (`/var` is a symlink → `/private/var/…`) and on Windows (the prefix is added on one side only). Production always hands both an already-canonicalized `cwd` (`agent/session/mod.rs:1133`, `:1156`); the invariant is about the **stringifiers**, not about canonicalization being free. `tests/storage.rs:413-414` canonicalizes for the same reason.
   - Construct `SessionInfo` the way `agent/session/mod.rs:2668`'s tests already do (`SessionInfo` and all its fields are `pub`, re-exported as `archimedes_lib::agent::SessionInfo`; `Db` is re-exported from `storage`);
   - `db.record_session(&info)` — the ONLY writer of `sessions.cwd` (`db.rs:317-325`, which stringifies `info.cwd.display()`);
   - `db.upsert_space(&info.cwd.display().to_string(), false)` — exactly what `agent/session/mod.rs:760` passes, and the only caller shape that exercises `space_key`'s re-canonicalization (`db.rs:645` calling `:742-746`);
   - read BOTH values back out of the database and assert the two strings are `==`: `db.session(&info.session_id)` → `SessionRow.cwd: String` (`db.rs:388`, field at `:38`) and `db.list_spaces()` → `SpaceRow.path: String` (`db.rs:670`, field at `:81`). No new dev-dependency is needed (`uuid` is already a main dep).
   Add a comment stating the invariant in words: *every Space↔session join in the frontend is a raw string equality between these two, so any change to how either is stringified must be applied to both in the same change.* This PASSES today on all three OSes; its job is to fail the moment someone normalizes one side only. ⚠ Do not call `space_key` on both sides (it is private, and doing so makes the test tautological) and do not hand-write the expected string — read both values from the database.

2. A doc comment on `types.rs`'s `pub cwd: PathBuf` recording why it is a `PathBuf` and what depends on its serde stringification: every `session.cwd === space.path` equality listed in constraint 2 (seven in `store/sessions.ts`, plus `SpaceTabs.tsx:106`/`:162` and `SpacesList.tsx:74`), and the `worker/manager.rs:768` compare. This is the single line a future reader needs before touching it.

3. The **long-path determination**, by reading not guessing: confirm `windows-app-manifest.xml` has no `<longPathAware>`, confirm `build.rs` embeds it with `/MANIFEST:EMBED` + `/MANIFESTINPUT` + `/WX` (`build.rs:87-98`; the `WindowsAttributes::new_without_app_manifest()` branch is `:44-48`), and record in `## Findings` what adding it would require (`<application><windowsSettings>` with `xmlns:wsx="urn:schemas-microsoft-com:asm.v3"`; Windows 10 1607+ **and** the `LongPathsEnabled` registry value, which is off by default on Windows 10 and on by default on 11 — so a manifest entry alone does not make long paths work on every user's machine). Note that `build.rs`'s comment claims the manifest is byte-identical to tauri-build's default, and that claim would become false — it must be updated in whatever change adds the element.

4. **Evidence from the reporter**, once they can produce it: on Windows with `ARCHIMEDES_DEBUG=1` set **before** launch, open a Space (a) at a drive root, (b) at a normal folder, (c) at a >260-char path, then read `%APPDATA%\archimedes\supervisor.log` (Task 3's `ipc start_session FAILED: …` line) and the `spaces`/`sessions` tables. Write the outcome into a `## Findings` heading here: which failure reproduced, what `StartEnv.cwd` held, and whether the report was the drive root or `no models available for the native session` (the leading hypothesis).

Two more canonicalized-path display sites exist and are **deliberately out of scope**, listed so a grep does not read them as oversights: `agents.rs:139` (`path: canon.to_string_lossy()…`, canonicalize at `:105`) and `skills.rs:259` put the verbatim prefix into `AgentDefinition.path` / skill paths, which reach the wire and the system prompt's `<location>` / `<project_instructions path>` attributes (`harness/prompt.rs:96`). Cosmetic on both OSes, and fixing them independently is the same one-sided-normalization hazard.

**What NOT to change:** do not add a `plain_display`-style helper, a migration, or any `strip_prefix(r"\\?\")`. Do not normalize `SessionInfo.cwd`, `StartEnv.cwd`, `sessions.cwd` or `spaces.path`. Do not add `<longPathAware>` as part of this plan — it changes what the shipped binary can open, it needs `build.rs`'s byte-equality comment rewritten, and it deserves its own ADR. Do not "fix" the `//?/C:/` shape in `harness/prompt.rs:138` either: it is cosmetic (a path in a prompt), and fixing it independently is exactly the one-sided normalization this task exists to prevent.

**Steps:**
- [ ] Write the characterization test in `src-tauri/tests/storage.rs` (step 1).
  Run `cargo test --test storage the_session_cwd_string_and_the_space_path_key_are_the_same_string` from `src-tauri/`.
  - ⚠ **Expect it to PASS immediately.** This is a characterization test, not a bug-hunting one — it documents an invariant that currently holds. Confirm it is not vacuous by temporarily changing `db.rs:325` to append a marker character: the test must go red. Revert that probe before committing.
- [ ] Add the `types.rs` doc comment (step 2).
- [ ] Run `cargo test --test storage` → green (the backfill test `open_backfills_space_rows_from_existing_sessions`, `tests/storage.rs:364`, with its three cwd assertions at `:413-434`, must stay green — they are the neighbours this change could disturb).
- [ ] Run `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check` → all clean.
- [ ] Record the long-path findings + the reporter's log outcome in `## Findings` at the bottom of this file. If the reporter cannot produce a log before this branch merges, write that explicitly — an honestly-empty Findings section is the required output, not a skip.
- [ ] Commit: `test(windows): pin the session-cwd / space-path string coupling, record the verbatim-path findings`

**Acceptance criteria:**
- [ ] A characterization test asserts `sessions.cwd` and `spaces.path` are byte-identical for one folder, and demonstrably fails if either side is stringified differently.
- [ ] `types.rs` documents what depends on `SessionInfo.cwd`'s serialized form.
- [ ] `## Findings` records the long-path analysis and the reporter's evidence (or its absence) — no untested claim that the prefix is or is not the cause.
- [ ] No behavior changed: the diff is one test, one doc comment, and this document.

### Task 5: write down where errors live, and what the envelope is

**Context:**
Two documentation gaps are part of this bug. First, no file tells a user or a supporter that logs live at `%APPDATA%\archimedes\supervisor.log` on Windows and that `ARCHIMEDES_DEBUG=1` must be set **before launch** — the discoverability gap that made this report unauditable, and the reason the fix in Task 3 stays opt-in is only acceptable if the switch is findable. Second, the IPC error envelope (`{kind, message, …}`) is now a cross-language contract with a hand-written producer and a hand-written consumer on either side; per repo convention that is an ADR (`docs/decisions/`, and `src/lib/tauri.ts`'s header already documents wire case conventions for the same reason).

**Files:**
- Create: `docs/decisions/0063-ipc-errors-carry-a-kind-and-a-message.md`
- Modify: `README.md` — append a new `## Diagnostics` section at the **end** of the file (headings currently end at `## Development`, `README.md:345`; do not insert near `:178`, whose "logs" mention is part of the release ceremony and unrelated)
- Modify: `src/lib/ipcError.ts` (doc comment cross-referencing the ADR) and `src-tauri/src/agent/errors.rs` (same, replacing the stale "Derives `Serialize` so it can cross the Tauri IPC boundary" comment at `:8`)

**What to implement:**

1. **ADR 0063.** Follow the existing format exactly: front-matter `status: accepted`, `date:` (today), `superseded-by:` empty; then a prose title stating the decision and the reason. Content, in the house style (open with the user-visible failure; then the decision; then "What was considered"):
   - The failure it closes: `[object Object]` for every session command, and the `Io` variant shipping a serde error string in place of the reason.
   - **Decision:** the IPC error envelope is `{ "kind": <snake_case discriminator>, "message": <the Display sentence>, …variant fields }`. **Rust owns the sentence** — the frontend never assembles prose from `kind`. `SessionError` therefore does **not** implement `Serialize`: the only route to the wire is the hand-written `From<SessionError> for InvokeError`, so an unserializable future variant is a compile error in that file rather than a runtime fallback (`tauri-2.12.2/src/ipc/mod.rs:240-247`'s `unwrap_or_else(Self::from_error)` is the trap that turned a serialization failure into a user-facing string).
   - The frontend's resolution order is normative (string → `Error.message` → `message` → `kind` → `String()` → `"unknown error"`), and `[object Object]` is a forbidden output.
   - **Considered and rejected:** (a) making every command return `Err(String)` — loses `kind`, and the typed codes are used by `commands/open.rs`'s refusal codes and the updater's `release-not-found`; (b) always-on logging — recorded as the option the reviewer preferred, with the counter-argument (one switch, existing rotation, nothing on disk in a normal run) and the accepted cost (a reporter must set the variable before reproducing); (c) patching `@tauri-apps/api`'s `core.js` — a vendored-asset fork for a one-line problem.
   - Note the three guards that keep it honest: `describeIpcError`'s own test, the two invariant greps (`instanceof Error ?` and the bare `String(err)` shape — the second one is what catches `UpdateSection.tsx`, which the first structurally cannot see), and Task 4's characterization test if the envelope shape is ever revisited.
   - Record the console-only exclusion rule (left alone unless the module owns the message's formatting) and the consequence it leaves open: `close_session` rejections are logged and rendered nowhere.
2. **README `## Diagnostics`.** One short block: the three per-platform log directory paths (Windows `%APPDATA%\archimedes`, Linux `~/.local/share/archimedes`, macOS `~/Library/Application Support/archimedes`); what lives there (`supervisor.log` + `.old` rotated at 5 MB, `crash-<ts>-<tag>-<pid>.log` kept 30 days / 50 files, `archimedes.db`); that `ARCHIMEDES_DEBUG=1` must be set **before starting the app** and that with it unset no log file is created at all; that `crash-*.log` means a panic and `supervisor.log` means a lifecycle or IPC failure; that older pre-amendment logs may be pid-less (`crash-<ts>-<tag>.log` is still written by pre-#40 builds and still matched by the prune — `crashlog.rs`'s header), so a supporter told to look only for the pid-stamped name may not find their own file; and the Windows-specific note that the release build has no console, so the crash log is the only trace of a panic. State the `%APPDATA%` subtlety that AGENTS.md/ADR 0025 records: on Windows the directory resolves via `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`, which **ignores `%APPDATA%`**, so pointing a supporter at the Roaming path is the only reliable instruction there.
3. Doc-comment updates: `src-tauri/src/agent/errors.rs`'s header (it currently says `SessionError` derives `Serialize` — after Task 1 that is false) and `src/lib/ipcError.ts` pointing at ADR 0063 for the envelope.

**Steps:**
- [ ] Read `docs/decisions/0061-…windows….md` first and copy its shape (front-matter, title voice, the "we decided" sentence, the considered-options section).
- [ ] Write the ADR, then the README section, then the two doc comments.
- [ ] Run `pnpm test` and `cargo test` — docs-only task, both must stay green (a doc-comment change can break nothing, and this proves no stray edit).
- [ ] Run `cargo fmt --all -- --check` → clean.
- [ ] Check the ADR number: `ls docs/decisions/ | tail` shows 0061 on `main`; 0058/0059 are gaps and 0062 exists only on the unmerged `feature/ui-design-lightning-round`. **Use 0063 and add one line to the ADR noting that 0062 is in flight on an unmerged branch**, so nobody backfills a gap or renumbers after a merge race. Do not renumber to 0062 — that number is taken in git.
- [ ] Commit: `docs: ADR 0063 (the IPC error envelope) + where the logs live`

**Acceptance criteria:**
- [ ] A person with no repo access can, from `README.md`, find the log file on Windows and know they must set `ARCHIMEDES_DEBUG=1` before launching.
- [ ] ADR 0063 records the envelope, who owns the sentence, and the always-on-logging rejection with its cost named.
- [ ] No doc still claims `SessionError` derives `Serialize`.

---

## Follow-ups recorded, deliberately not in this plan

- **Long-path awareness on Windows.** `src-tauri/windows-app-manifest.xml` declares no `<longPathAware>`, so the `\\?\` prefix from `canonicalize` is currently the only thing letting a >260-char path open. A Space deep enough to cross 260 characters may therefore be behaving oddly today for that reason alone, independently of everything in this plan. (The registry value gates only the *manifest-based*, non-verbatim route — do not confuse the two.) Adding the manifest element is a real change (it alters what the shipped binary can open, and it invalidates `build.rs:21-23`'s "byte-identical to tauri-build's default" claim) and needs its own ADR.
- **Stripping `\\?\` for display.** If Task 4's findings say the prefix matters, design it against Task 4's five constraints — the strip has to move `SessionInfo.cwd`, `sessions.cwd`, `spaces.path` and the frontend's seven string joins in one change, and the migration must run after `db.rs:162` with an explicit delete/update order.
- **`close_session` failures are invisible.** They are `console.error`-only (`SpaceTabs.tsx:334`/`:340`) and rendered nowhere, so a Space whose sessions failed to stop looks exactly like one that closed cleanly. Task 3 logs them server-side; nothing surfaces them. Whether a banner is warranted is a product call.

- **A dedicated message for the likely root cause.** If Task 4's investigation confirms the fresh-install failure is `no models available for the native session`, the right fix is product-level — detect "no provider configured" and send the user to Settings — not a better sentence. Out of scope here; the message becomes legible in Tasks 1-2 regardless.
- **`prune_crash_logs`' cross-process hazard** is already tracked upstream in issue #42 (`agent/crashlog.rs`'s "Accepted, not fixed" section). Unrelated to this plan.
- **Always-on logging**, if the opt-in switch proves too costly in practice — the decision and its cost are recorded in ADR 0063 so reopening it does not require re-deriving the argument.
