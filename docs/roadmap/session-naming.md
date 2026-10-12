---
status: committed
done-when: After the first exchange of a new session finishes, the sidebar row and the side-pane header show a short model-written title for that session (surviving a restart), instead of the truncated first message; turning "Name sessions automatically" off stops any title request; a session that already has a title is never re-titled.
---

# Session Naming (port of pi-archimedes `@pi-archimedes/session-name`) Plan

**Goal:** Give every main session a short model-written title after its first exchange, persisted on the `sessions` row and shown wherever the desktop labels a session.
**Architecture:** The Supervisor (not the Worker) names sessions. On the `agent_end` event of a main session it already holds everything needed — the `Db`, the `ModelCatalog`, the provider factory, the live session's resolved `Model` — so a background `tokio::spawn` in the Supervisor reads the first exchange from `native_messages`, makes one no-tools model call, and writes `sessions.title` through an atomic `UPDATE … WHERE title IS NULL`. A new `session-titled` Tauri event pushes the result to the live UI.
**Tech Stack:** Rust (Tauri 2, tokio, rusqlite, the native harness `Provider` seam), React 19 + TypeScript + zustand, vitest.

Reference implementation being ported: `~/Coding/Javascript/pi-archimedes/packages/session-name/src/index.ts` (read it before starting; the rules below are derived from it and from its `src/index.test.ts`).

## Design decisions (already made — do not re-litigate)

1. **Supervisor-side call site.** The Worker keeps no naming logic and no new IPC frame. The hook is the existing `SessionManager::route_event` bookkeeping arm, which already matches on `RpcEvent::agent_settled`.
2. **Auto-only.** No rename UI in this change. "Manual names win" is ported as: naming runs only when `sessions.title IS NULL`, and the write itself is `UPDATE … WHERE title IS NULL` (the SQL is the race guard — one statement under the `Db` mutex, strictly stronger than pi's async read-then-recheck).
3. **Reasoning default is "omit", and validation is against the MODEL'S vocabulary, not pi's fixed list.** pi asks for `minimal` because a pi model call carries thinking by default; here `ModelOptions.reasoning_effort: None` already means "no thinking", so asking for `minimal` would *add* cost. So: absent setting → omit the key; a configured level is forwarded only when the chosen model advertises it (`Model.thinking_levels`). pi excludes `off` from its fixed list because it is a fourth spelling of "unset" there; in this app `off` / `none` ARE a provider's advertised vocabulary for "no thinking", so an advertised `off` is forwarded verbatim.
4. **No UI surface for the failure warning** (the desktop has no toast primitive). The 3-failure budget is ported; the warning is an `eprintln!` line, matching the crate's existing log convention (`agent/persist.rs`, `config.rs`).
5. **The call is not cancellable.** It is detached from the turn's cancel token, so pi's `stopReason === "aborted"` path has no analog; a session closed mid-flight is handled by the `title IS NULL` + row-missing write (a deleted session gets no write).
6. **Skip rules.** pi's "ephemeral session (no session file)" → `is_subagent = 1` or no `sessions` row. pi's "model has no configured auth" → `Model.api_key.is_empty()`.
7. **Surfaces:** the two existing first-message derivations (`src/components/SidePane.tsx`, `src/components/SpacesList.tsx`) prefer the stored title. The session rail and the window/tab title are explicitly out of scope.

## Settings shape (`settings.json`, camelCase)

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `sessionNamingEnabled` | bool | `true` | Master switch (pi: `archimedes.sessionName.enabled`). |
| `sessionNamingModel` | string \| null | `null` | Composed key `provider/id` (a `:level` suffix and a bare unique `id` are tolerated). `null`/blank = the session's own model. |
| `sessionNamingReasoning` | string \| null | `null` | Thinking level for the title request, honoured only when the model advertises it. JSON-only — no UI row. |

---

### Task 1: Persist and surface a session title

**Context:**
The `sessions` table already has a `title TEXT` column (`src-tauri/src/storage/db.rs:707`) but nothing ever writes it: `record_session` inserts `Option::<String>::None` and its `ON CONFLICT DO UPDATE` deliberately never touches `title`. `SessionInfo` (`src-tauri/src/types.rs`) has no title field, so the frontend cannot see one even if it existed. Everything downstream (naming write, boot fetch, resume, the UI) needs this plumbing first.

**Files:**
- Modify: `src-tauri/src/storage/db.rs` (new `set_session_title`, tests near the existing `set_session_archived` tests ~line 1300+)
- Modify: `src-tauri/src/types.rs` (`SessionInfo`)
- Modify: `src-tauri/src/agent/session/mod.rs` (`list_sessions` at :1004, the shared `establish_worker_session` `SessionInfo` at :940 + the `ResumeCtx` that feeds it, every other `SessionInfo {` literal)
- Modify: `src-tauri/src/agent/persist.rs` (:165), `src-tauri/src/agent/normalize.rs` (:976), `src-tauri/src/agent/harness/store.rs` (:271), `src-tauri/src/agent/harness/compact.rs` (:587), `src-tauri/src/agent/harness/loop.rs` (:2275), `src-tauri/src/storage/db.rs` ×5 (the remaining in-crate `SessionInfo {` literals, all but one in `mod tests`)
- Modify: `src-tauri/tests/storage.rs` (:19, :375; `:132` already uses `..session.clone()`), `src-tauri/tests/harness_store.rs` (:29), `src-tauri/tests/harness_loop.rs` (:176), `src-tauri/tests/harness_subagent_dispatch.rs` (:136), `src-tauri/tests/session_native.rs` (:329) — the INTEGRATION-test literals. `cargo test` / `cargo clippy --all-targets` compile `src-tauri/tests/`, so missing `title` there reddens the gate even though `grep` over `src` is clean.
- Modify: `src/lib/tauri.ts` (`SessionInfo` interface, ~line 51)
- Test: `src-tauri/src/storage/db.rs`, `src-tauri/src/agent/session/mod.rs`

**What to implement:**
1. In `src-tauri/src/storage/db.rs`, next to `set_session_archived` (:453):

```rust
/// Set a session's title ONLY when it has none (`title IS NULL`), so a
/// title that already exists — a generated one from an earlier turn, or
/// one a future rename affordance wrote — is never overwritten. The
/// `WHERE title IS NULL` IS the race guard: one statement under the `Db`
/// mutex, so a concurrent writer cannot slip between a check and a write.
/// Returns `true` when a row was written, `false` when the row is missing
/// or already titled.
pub fn set_session_title(&self, id: &str, title: &str) -> Result<bool, DbError> {
    let n = self.conn.lock().expect("db mutex poisoned").execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1 AND title IS NULL",
        params![id, title],
    )?;
    Ok(n > 0)
}
```

Do NOT change `record_session`: its `DO UPDATE` set-list must keep excluding `title` (a resume must not clobber a stored title) and its `INSERT` keeps `Option::<String>::None`.

2. Add to `SessionInfo` in `src-tauri/src/types.rs` (after `archived`):

```rust
/// The session's generated title (`None` until a title is generated).
/// Auto-generated only in this change — there is no rename affordance,
/// so `Some` always means "the naming pass wrote this". `#[serde(default)]`
/// so a pre-feature stored envelope / subagent envelope deserialises.
#[serde(default)]
pub title: Option<String>,
```

Add `title: None,` to every `SessionInfo { … }` LITERAL — **16 in `src-tauri/src` + 6 in `src-tauri/tests`**. `grep -rn "SessionInfo {" src-tauri/src` returns 18 hits but only 16 are literals (skip the `pub struct SessionInfo {` definition at `types.rs:29` and the doc-comment mention at `agent/persist.rs:150`): `storage/db.rs` ×5 (1223, 1300, 1344, 1355, 1457), `agent/harness/store.rs:271`, `agent/harness/compact.rs:587`, `agent/harness/loop.rs:2275`, `agent/persist.rs:165`, `agent/normalize.rs:976`, `agent/session/mod.rs` ×6 (940, 1036, 1839, 2388, 2440, 2516). Then `grep -rn "SessionInfo {" src-tauri/tests` for the other six.

3. `list_sessions` (`agent/session/mod.rs:1036`, the `SessionInfo { … }` map): set `title: row.title`.
4. `establish_worker_session` builds the ONE `SessionInfo` shared by a fresh start AND a resume (`agent/session/mod.rs:940`). Give it the title: add `title: Option<String>` to `ResumeCtx` (`:267`), set it from `row.title` where `resume_native_session` builds the `ResumeCtx` (right where it already carries `archived` + `context_usage` from the same row), and thread it into the `SessionInfo` at :940 — `None` on the fresh path. A resume must return the stored title so a resumed session's label survives the round-trip.
5. `src/lib/tauri.ts`: add to `SessionInfo`:

```ts
/** The session's generated title (`null`/`undefined` until the naming pass writes one). Auto-generated only — there is no rename affordance yet. */
title?: string | null;
```

Do NOT add a title setter command, a rename UI, or a `session_renamed` event — out of scope (decision 2).

**Steps:**
- [ ] Write failing tests in `src-tauri/src/storage/db.rs`: (a) `set_session_title` writes a `NULL` title and returns `true`; (b) a second call with a different title returns `false` and leaves the first title; (c) an unknown id returns `false`; (d) `record_session` on a re-record (resume) does not clear an existing title.
- [ ] Run `cargo test set_session_title` from `src-tauri/`. Expect: compile error (no method). If it compiles and passes, stop and investigate.
- [ ] Implement steps 1–5.
- [ ] Run `cargo test` from `src-tauri/` — all green (the 16 literal sites compile only after all are updated).
- [ ] Run `cargo clippy --all-targets` from `src-tauri/` — 0 warnings.
- [ ] Run `cargo fmt` from `src-tauri/`, then `cargo fmt --check`.
- [ ] Run `pnpm build` from the repo root (the `SessionInfo` TS addition type-checks).
- [ ] Commit: `feat(sessions): persist and surface a session title`

**Acceptance criteria:**
- [ ] `Db::set_session_title` writes at most once per session and never overwrites a non-NULL title.
- [ ] `list_sessions` and a resume carry the stored title over IPC; a fresh session carries `null`.
- [ ] No behaviour change visible in the UI yet (nothing writes a title).

---

### Task 2: The naming settings

**Context:**
pi's extension reads `archimedes.sessionName.{enabled,model,reasoning}` from `~/.pi/agent/settings.json`. The desktop's equivalent is the `Settings` struct in `src-tauri/src/config.rs`, read with a fresh `load_settings(&config_dir)` (the `record_session` precedent at `agent/session/mod.rs:703`). Three new fields, all `#[serde(default)]`-backed so a pre-feature file needs no migration. `sessionNamingEnabled` defaults to **true** (pi ships naming on), so it needs a `default = "default_true"` — the crate has `default_theme()`/`default_font_size()` precedents for a non-`false` default.

**Files:**
- Modify: `src-tauri/src/config.rs` (`Settings`, `Default`, `load_settings`, tests)
- Modify: `src/lib/tauri.ts` (`AppSettings`, ~line 431)
- Modify: the test fixtures that build a full `AppSettings` — `grep -rln "mcpMentionsEnabled:" src` (→ `src/components/settings/SettingsPage.test.tsx`, `src/components/MessageBubble.codeblock.test.tsx`, `src/components/SpacesList.test.tsx`, `src/components/ChatStream.test.tsx`, `src/lib/settings.test.ts`, `src/store/settings.test.ts`, `src/App.test.tsx`)
- Test: `src-tauri/src/config.rs`

**What to implement:**
1. In `Settings` (after `spinner_style`):

```rust
/// Session naming (ported from pi-archimedes' `session-name`): the master
/// switch for the post-first-exchange title request. `#[serde(default =
/// "default_true")]` — pi ships naming ON, so a pre-feature file reads as
/// enabled (unlike the `#[serde(default)]` bools above, whose default is
/// `false`).
#[serde(default = "default_true")]
pub session_naming_enabled: bool,
/// The model used for title generation: the composed key
/// (`"provider/id"`, or a hand-edited `"provider/id:<level>"`). `None` /
/// blank = the session's own model (pi's `model` setting).
#[serde(default)]
pub session_naming_model: Option<String>,
/// The thinking level for the title request. Honoured ONLY when the chosen
/// model advertises it; `None` = omit the `reasoning_effort` key (the
/// default — `ModelOptions.reasoning_effort: None` already means "no
/// thinking" here, so pi's `minimal` default would ADD cost). JSON-only:
/// there is no settings row for it.
#[serde(default)]
pub session_naming_reasoning: Option<String>,
```

2. `fn default_true() -> bool { true }` beside `default_theme`.
3. `Settings::default()`: `session_naming_enabled: true,` + the two `None`s.
4. `load_settings` normalisation (the file is hand-editable): a blank `session_naming_model` (`Some("")` or all whitespace) becomes `None`. The existing blank-`default_thinking_level` rule at `config.rs:245-249` is the shape to follow — NOTE it normalises only the exact `""`, so the all-whitespace case is a deliberate WIDENING of that precedent (keep the existing rule as it is; do not change `default_thinking_level`'s behavior). Trim only for the blank test — do NOT rewrite the stored value's spelling.
5. `src-tauri/src/config.rs`'s `settings_round_trip_with_the_new_fields` test (:741) builds a FULL `Settings { … }` literal (no `..Default::default()`), so it must gain the three fields. It is the only full literal — the other settings tests use `..Settings::default()`.
6. `src/lib/tauri.ts` `AppSettings`: `sessionNamingEnabled: boolean;`, `sessionNamingModel: string | null;`, `sessionNamingReasoning: string | null;` — required (the backend always emits them via `#[serde(default)]`), same comment style as `mcpMentionsEnabled`.
7. Fixtures. The TYPED `AppSettings` fixtures must gain the three keys or `tsc` reddens: `src/components/settings/SettingsPage.test.tsx` (`baseSettings: AppSettings`), `src/components/ChatStream.test.tsx`, `src/components/MessageBubble.codeblock.test.tsx`, `src/lib/settings.test.ts`, `src/store/settings.test.ts`. `src/App.test.tsx` and `src/components/SpacesList.test.tsx` are untyped `mockResolvedValue({...})` payloads (they already omit `palette` / `spinnerStyle`) — add the keys there too for honesty, but they cannot redden the gate.

**Steps:**
- [ ] Write failing tests in `src-tauri/src/config.rs`: (a) `Settings::default().session_naming_enabled == true`; (b) a pre-feature JSON (no naming keys) parses to enabled + two `None`s; (c) camelCase round-trip — `sessionNamingModel` / `sessionNamingReasoning` / `sessionNamingEnabled` are the wire names (see the `default_thinking_levels_defaults_to_empty_and_round_trips` test at :633 for the pattern); (d) `load_settings` on a file with `"sessionNamingModel": "   "` yields `None`.
- [ ] Run `cargo test config` from `src-tauri/`. Expect: compile failure (unknown fields).
- [ ] Implement steps 1–6. Re-run → green.
- [ ] Run `pnpm build` from the repo root. Expect: `tsc` errors on the fixtures until step 7 lands (NOTE: `pnpm test` is `vitest run` and vitest does NOT type-check, so the missing keys are invisible there — `pnpm build` is the gate that catches them). After step 7: green.
- [ ] Run `pnpm test`, `pnpm build`, `cargo clippy --all-targets`, `cargo fmt` (then `cargo fmt --check`).
- [ ] Commit: `feat(settings): session-naming settings`

**Acceptance criteria:**
- [ ] A pre-feature `settings.json` reads as naming-enabled with no model/reasoning override.
- [ ] The three keys round-trip through `save_settings`/`load_settings` in camelCase.
- [ ] Nothing reads these settings yet (Task 4 wires them).

---

### Task 3: The naming primitives (pure)

**Context:**
pi's `generateTitle` mixes three concerns worth testing independently of any provider: what text feeds the prompt (first user + first assistant text, 500 chars per side), how the answer is cleaned (collapse whitespace, strip one layer of quotes, cap 80), and what thinking level is asked for (never forward a level the model does not advertise). This task creates the new `session::naming` module with those pure functions only — no async, no `Db`, no provider. Task 4 wires them.

**Files:**
- Create: `src-tauri/src/agent/session/naming.rs`
- Modify: `src-tauri/src/agent/session/mod.rs` (add `#[allow(dead_code)] mod naming;` beside `mod router;` — the attribute and why it is there are below)
- Test: `src-tauri/src/agent/session/naming.rs` (`#[cfg(test)] mod tests`)

**What to implement:**
In `src-tauri/src/agent/session/naming.rs`, `pub(crate)` items (the module is a CHILD of `session`, like `router.rs`, so it may see the parent's private items later). The module declaration in `agent/session/mod.rs` carries a temporary lint suppression, REMOVED by Task 4:

```rust
#[allow(dead_code)] // the consumers land with Task 4's naming pass; drop this then
mod naming;
```

```rust
/// Per-side character cap on the conversation excerpt (pi: 500).
pub(crate) const EXCERPT_CAP: usize = 500;
/// The title's hard cap (pi: 80).
pub(crate) const TITLE_MAX_CHARS: usize = 80;
/// Consecutive title-request failures tolerated before naming stops
/// (pi: 3).
pub(crate) const MAX_FAILURES: u32 = 3;

/// The text of a transcript message (`MessageContent::Text` verbatim;
/// `Blocks` → the `ContentBlock::Text` parts joined with `\n` — the same
/// "text blocks only" rule pi filters for).
pub(crate) fn message_text(content: &MessageContent) -> String

/// The first exchange: the first `User` message with non-empty text, then
/// the first `Assistant` message with non-empty text AFTER it. Each side
/// is `"<Role>: " + text`, trimmed and capped at `EXCERPT_CAP` CHARS
/// (`.chars().take(n)` — a byte slice would panic on a multi-byte title).
/// Other roles (system / tool) are ignored, and an assistant message that
/// precedes any user message is ignored (pi requires `foundUser` first).
/// `None` when there is no user text at all; an assistant side is OPTIONAL
/// (a turn whose assistant output was all tool calls still names from the
/// user text — pi's `conversationText` is non-empty on the user line
/// alone).
pub(crate) fn first_exchange_text(messages: &[ChatMessage]) -> Option<String>

/// The title request's single user message, VERBATIM pi's copy:
/// "Generate a concise title (3-8 words) for this conversation." /
/// "The title should capture what the user is working on." /
/// "Return only the title, nothing else." / "" / "<conversation>" /
/// `<exchange>` / "</conversation>" — joined with `\n`.
pub(crate) fn title_prompt(exchange: &str) -> String

/// Clean a model answer: whitespace runs → one space, trim, strip ONE
/// layer of matching surrounding quotes (`"…"` / `'…'`), then cap at
/// `TITLE_MAX_CHARS` CHARS. `None` when nothing survives.
pub(crate) fn clean_title(raw: &str) -> Option<String>

/// The thinking level the title request asks for (decision 3).
/// `None` (absent / blank setting) → `None`: omit the key. A configured
/// value is matched case- and padding-insensitively against
/// `model.thinking_levels` and the MODEL'S OWN spelling is returned (the
/// provider's vocabulary, not the user's typo-corrected one). A model that
/// advertises NO levels yields `None` — the same rule
/// `remembered_thinking_level` applies (`agent/session/mod.rs:1635`),
/// NOT `supports_thinking_level`'s soft-pass: an unverifiable level is
/// never sent, because `ModelOptions.reasoning_effort` is forwarded
/// verbatim by every adapter and an unknown level is provider-dependent
/// (some read it as MORE thinking, some reject the request).
/// An unrecognised value against a non-empty set logs
/// `eprintln!("session-name: ignoring unrecognized reasoning {raw:?}")`
/// and returns `None`.
pub(crate) fn resolve_naming_reasoning(model: &Model, configured: Option<&str>) -> Option<String>

/// Resolve the `sessionNamingModel` override, in pi's order. TRIM the key
/// first and return `None` for a blank one (pi's `resolveModel` does both).
/// 1. the key as a canonical `provider/id`, compared IGNORE-CASE over
/// `catalog.all()`; 2. the key as a bare id, matched case-insensitively
/// against `Model.id` and resolved ONLY when exactly one model matches (pi:
/// a bare id must be unique across providers); 3. if the key contains a `:`
/// and neither rung hit, strip everything after the LAST `:` (the
/// thinking-level suffix — a model id may itself contain `:`, so the suffix
/// is the trailing segment) and retry rungs 1 and 2 with the stripped form,
/// but ONLY when the stripped form is non-empty (pi's `if (prefix)` — so a
/// key like `":high"` never matches the whole catalog on an empty string);
/// 4. anything else → `None` (the caller falls back to the session's own
/// model).
/// Do NOT delegate to `resolve_composed_model` (it matches with `==`, so a
/// differently-cased key silently misses) and do NOT pre-strip with
/// `ModelRef::parse` (it returns `None` for a key without a `/`, so a bare
/// `"m1:high"` would never resolve).
pub(crate) fn resolve_naming_model(catalog: &ModelCatalog, key: &str) -> Option<Model>
```

Imports come from the existing seams — `crate::agent::harness::provider::{ChatMessage, ChatRole, MessageContent}` (the re-export list at `harness/provider/mod.rs:24-27`), `crate::agent::tools::ContentBlock` (it lives in `agent/tools/exec.rs` and is NOT re-exported by `harness::provider`), `crate::agent::harness::catalog::{Model, ModelCatalog}`, `crate::agent::harness::model_key::ModelKey` (only if the composed-key comparison needs it — `ModelKey::from(&model)` renders `provider/id`). Do NOT import `resolve_composed_model`: the spec forbids it, and an unused import breaks the 0-warning clippy gate.

Deviation from pi (deliberate, and it belongs in the doc comment): pi validates against a FIXED list (`minimal…max`, `off` excluded because it is a fourth spelling of "unset"). Here the vocabulary is the MODEL'S advertised `thinking_levels`, which for this app's providers legitimately include `off` / `none` meaning "no thinking" — an advertised `off` is forwarded, because the model says it understands it.

**Steps:**
- [ ] Write the failing tests in `naming.rs` first, one per rule, mirroring `~/Coding/Javascript/pi-archimedes/packages/session-name/src/index.test.ts`:
  - `first_exchange_text`: user-only → `Some("User: …")`; user+assistant → both lines in `User:`/`Assistant:` order; assistant-before-user ignored; system/tool rows ignored; a 600-char user message capped at 500 chars; a multi-byte message capped without panicking; empty/whitespace-only user text → `None`; no rows → `None`.
  - `clean_title`: `"  Porting   the session namer \n"` → `Some("Porting the session namer")`; `'"Porting the session namer"'` → quotes stripped; `"'x'"` → `x`; `'"unbalanced'` → left alone; `""` / `"   "` → `None`; a 200-char answer → 80 chars; an 80-char multi-byte answer → exactly 80 CHARS.
  - `title_prompt`: the three instruction lines and the `<conversation>` wrapper are present verbatim, and the excerpt sits between the tags.
  - `resolve_naming_reasoning`: `None`/`Some("")` → `None`; `Some("low")` on a model advertising `["off","low","high","xhigh"]` → `Some("low")`; `Some(" LOW ")` → `Some("low")` (the model's spelling wins); `Some("turbo")` → `None` + the log line; `Some("off")` on a model that advertises `off` → `Some("off")` (the deviation note); any value on a model with `thinking_levels: []` → `None`.
  - `resolve_naming_model`: exact `provider/id`; a differently-cased key (`"TAMA/m1"` for a `tama/m1` model) still resolves; a PADDED key (`" tama/m1 "`) resolves (the trim); `"tama/m1:xhigh"` resolves; a BARE `"m1:high"` still resolves to the unique `m1` (the suffix strip must not require a `/`); a unique bare `m1` resolves; a bare id matching two models → `None`; an unknown key → `None`; an empty / whitespace-only key → `None`; `":high"` → `None` (the stripped form is empty, so no empty-string catalog match); a model whose OWN id contains a `:` is matched by rung 1 before any stripping.
- [ ] Run `cargo test naming` from `src-tauri/`. Expect: compile failure (module missing). Implement `mod naming;` (with the `#[allow(dead_code)]` above) + the functions. Re-run → green.
- [ ] Run `cargo clippy --all-targets` from `src-tauri/` — 0 warnings (this is why the module carries the temporary `#[allow(dead_code)]`: nothing in the non-test build uses these functions until Task 4, and the crate has no crate-level `allow(dead_code)`).
- [ ] Commit: `feat(sessions): session-title naming primitives`

**Acceptance criteria:**
- [ ] Every pure rule above is covered by a unit test that does not touch the DB, a provider, or a runtime.
- [ ] No `.truncate()` / byte-slicing on user-supplied text anywhere in the module.

---

### Task 4: The Supervisor naming pass

**Context:**
This is the wire-up: on a main session's `agent_end`, the Supervisor spawns one background task that titles the session once. `SessionManager::route_event` (`src-tauri/src/agent/session/router.rs:26`) already owns the "internal bookkeeping only" arm for `WorkerInboundEvent::Event` — that is the pi `agent_end` hook's exact analog, and it fires on every turn (so the guards must be the ones that make it fire at most once). The Supervisor holds everything the task needs (`driver.db`, `sink`, `provider_factory`, `config_state` → the live session's `Model`, `EffectiveCatalog` for the override model), so the task takes owned clones and no `Arc<Self>` back-pointer is added — this is the same shape `subagent.rs::dispatch_native` uses.

**Files:**
- Modify: `src-tauri/src/agent/session/naming.rs` (add `NamingState`, `NamingRequest`, `maybe_name_session`, `name_session` + the `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/agent/session/mod.rs` (new `naming` field on `SessionManager`, initialised in `new` — there is NO `impl Default for SessionManager`; widen the test doubles in `#[cfg(test)] mod session_tests` (:1752) — `open_db` (:1790), `TestSink.tx` (:1772-1774), `level_test_model` (:2015), `write_settings_json` (:2005) — to `pub(crate)`, which is what lets `naming::tests` reach them as `crate::agent::session::session_tests::…`)
- Modify: `src-tauri/src/agent/session/router.rs` (the `agent_end` hook in `route_event`; widen `on_session_exited_expected` (:190) to `pub(crate)` and drop the `naming` entry there — the single close/clean teardown site, next to the `config_state` removal at :226 — AND in `handle_crash` (:104, already `pub`), which tears down nothing today and would otherwise strand a stale entry across a crash-then-resume)
- Test: `src-tauri/src/agent/session/naming.rs` (tests), plus a `route_event` guard test

**What to implement:**

1. `SessionManager` gains one field (next to `config_state`, same `Arc<StdMutex<HashMap<…>>>` shape):

```rust
/// Per-session session-naming state (the naming pass runs on every
/// `agent_end`, so it needs to know "already running / given up"). The
/// entry is dropped with the session (`close_session` / the exit cleanup).
naming: Arc<StdMutex<HashMap<String, NamingState>>>,
```

```rust
/// The per-session naming bookkeeping: `fails` counts REQUEST failures
/// only; `in_flight` keeps two `agent_end`s from spawning two requests.
#[derive(Debug, Default, Clone)]
pub(crate) struct NamingState {
    pub(crate) fails: u32,
    pub(crate) in_flight: bool,
}
```

2. Modify `agent/session/mod.rs` and `agent/session/router.rs` for the seams this task's tests need: remove Task 3's temporary `#[allow(dead_code)]` from `mod naming;` (that removal is part of THIS task's 0-warning gate), add the new field, and initialise `naming` in `SessionManager::new` (there is NO `impl Default for SessionManager`). Then widen, to `pub(crate)`: `on_session_exited_expected` (`router.rs:190`, private to `session::router`, so `naming::tests` cannot reach it as-is), and the test doubles `open_db` (`mod.rs:1790`), `TestSink.tx` (:1772-1774), `level_test_model` (:2015), `write_settings_json` (:2005) — the last four live in `#[cfg(test)] mod session_tests` (:1752), whose items are private to that module.

3. In `naming.rs`, the sync entry point. Every guard returns early WITHOUT consuming the failure budget, exactly as pi's `agent_end` handler does:

```rust
impl SessionManager {
    /// The `agent_end` hook (the port of pi's `session-name` handler):
    /// guard, then fire-and-forget. Never blocks the router — the model
    /// call is `tokio::spawn`ed.
    pub(crate) fn maybe_name_session(&self, session_id: &str) {
        // 1. settings off → return.
        // 2. `driver.db` is None → return (no row to write). The sink is
        //    `Arc<OnceLock<Arc<dyn EventSink>>>` (`mod.rs:451`) — take it
        //    with `self.sink.get().cloned()` but DO NOT require it: pass
        //    `Option<Arc<dyn EventSink>>` and skip only the emit (a title
        //    still deserves persisting).
        // 3. read the row: missing → return (pi's "ephemeral session");
        //    `title.is_some()` → return (a name exists; decision 2);
        //    `is_subagent` → return (pi skips ephemeral sessions; a
        //    subagent's transcript is hidden — naming it is meaningless).
        // 4. state: `fails >= MAX_FAILURES` → return; `in_flight` → return.
        //    Read-only here — `in_flight` is SET at step 7, never before an
        //    early return (a guard that returns after setting it strands
        //    the session in `in_flight` forever, which is the very bug the
        //    teardown exists to avoid).
        // 5. the session's own model: `config_state[session_id].model`
        //    (the live mirror, `NativeConfigState` at :221). Absent →
        //    return (a session with no resolved model cannot be titled).
        // 6. the excerpt: `SessionStore::new(db.clone()).load_messages(
        //    session_id)` → `first_exchange_text(...)`. `None` → return
        //    (retry on a later `agent_end`).
        // 7. set `in_flight = true`, clone the owned inputs, and
        //    `tokio::spawn(name_session(req))`.
    }
}
```

`NamingRequest` (owned, `'static`): `session_id: String`, `db: Arc<Db>`, `sink: Option<Arc<dyn EventSink>>`, `provider_factory: ProviderFactory`, `catalog: EffectiveCatalog`, `session_model: Model`, `settings: Settings`, `state: Arc<StdMutex<HashMap<String, NamingState>>>`. `Settings` is read ONCE by `maybe_name_session` via `load_settings(&self.config_dir)` (the `record_session` precedent, `mod.rs:703`) so the two naming settings and the master switch cannot disagree mid-flight. `EffectiveCatalog { config_dir, cache: self.discovery_cache.clone(), base: self.catalog.clone() }` (the `effective_catalog` wrapper's own construction, `agent/session/mod.rs:633-638`).

Call the factory as `(self.provider_factory)(&model)` INSIDE the task (the type is `Arc<dyn Fn(&Model) -> Box<dyn Provider> + Send + Sync>`, `mod.rs:316` — clone the `Arc` into the request).

4. `name_session(req: NamingRequest)` — `pub(crate) async fn`, the whole body wrapped so a panic-free early exit always clears `in_flight` (use a small guard struct or explicit clears on every return path; the tests below pin the behaviour):
   - Model: when `settings.session_naming_model` is `Some`, `catalog.resolve(None).await` → `resolve_naming_model`; a miss falls back to `req.session_model` (pi: settings model else current model). No override → `req.session_model` and NO catalog resolution (do not pay a discovery round-trip for the common case).
   - Auth: `model.api_key.is_empty()` → clear `in_flight`, return (not a failure — pi).
   - Request: `ModelRequest { model: model.id.clone(), messages: vec![ChatMessage { role: ChatRole::User, content: MessageContent::Text(title_prompt(&exchange)), tool_call_id: None, tool_calls: None }], tools: Vec::new(), options: ModelOptions { temperature: Some(0.0), max_tokens: None, reasoning_effort: resolve_naming_reasoning(&model, settings.session_naming_reasoning.as_deref()), stream: true }, session_id: Some(session_id.clone()) }`.
     NOTE `ModelRequest.model` takes the BARE id (`model.id`), NOT the composed key — match `compact.rs::summarize` (`src-tauri/src/agent/harness/compact.rs:409`).
   - Build the provider: `(req.provider_factory)(&model)`.
   - Drain: `tokio::time::timeout(Duration::from_secs(30), …)` around the stream loop; collect `ProviderEvent::TextDelta`; stop at `ProviderEvent::Done(finish)` — treat `Done(FinishReason::Error)` / `Done(FinishReason::Length)` and `ProviderEvent::Error(_)` and a timeout and a stream that ends with no `Done` as failures (the `compact.rs::summarize` precedent for "a truncated answer is an error, not a partial success"). Ignore non-text events.
   - `clean_title(&collected)` → `None` counts as a failure (pi does the same).
   - Write: `db.set_session_title(&session_id, &title)`. `Ok(true)` → `if let Some(sink) = req.sink { sink.emit("session-titled", json!({ "sessionId": session_id, "title": title })) }` and reset `fails = 0`. `Ok(false)` → the row vanished or a title appeared meanwhile: drop the title, do NOT count a failure, do NOT emit (pi's race guard). `Err(e)` → log `eprintln!("session-name: failed to write title for {session_id}: {e}")` and count a failure.
   - Failure path: `fails += 1`; when it reaches exactly `MAX_FAILURES`, log once:
     `eprintln!("session-name: naming failed {MAX_FAILURES} times for {session_id}; check the model configuration or set sessionNamingModel")`.
   - Never write to the DB or emit from a path other than the above (a test asserts a failing provider emits nothing).

Compaction note: `native_messages` is the excerpt source, and a compaction rewrites that table (`run_compaction` → `replace_native_messages`). Naming normally completes on the first turn, long before any compaction; if the first user row was already summarised away, `first_exchange_text` titles from whatever survives. That is acceptable — add NO special handling for it.

Frame-ordering note: the `RpcEvent` stream and the store frames ride DIFFERENT outbound paths (`worker/core.rs` pumps `Outbound::Event` separately from the store frames), so the assistant `TranscriptInsert` may or may not be applied to SQLite by the time this hook reads `load_messages`. The result is a title written from the user line alone — acceptable (the assistant side is optional by design), and the once-only write means it is never revisited. Do NOT add a retry, a sleep, or a re-read loop for it.

LiteLLM note: pi issues the title call under a FRESH `crypto.randomUUID()` session id; here `ModelRequest.session_id` carries the REAL session id on purpose (ADR 0026's per-session request tracking wants every request of the session attributed, and the footer's cost total comes from the event stream, which this call never touches).

5. Hook in `router.rs`'s `WorkerInboundEvent::Event(e)` arm:

```rust
if matches!(e, RpcEvent::agent_settled) {
    self.resolve_turn(session_id);
}
// Session naming: `agent_end` is the turn's last frame (`agent_settled`
// is the settle signal the turn resolver waits on). MAIN sessions only
// — a subagent's transcript is hidden (`is_subagent` rows are filtered
// out of `list_sessions`).
if !is_subagent && matches!(e, RpcEvent::agent_end { .. }) {
    self.maybe_name_session(session_id);
}
```

6. Cleanup, two places:
   - `on_session_exited_expected` (`router.rs:190`) is the ONE close/exit teardown — it already removes `live` (:221) and `config_state` (:226); add the `naming` removal beside them. `close_session` (`mod.rs:1576`) needs NOTHING of its own: it only marks the close kind and `detach`s, and reaches this site through the Worker's EXPECTED `Exited`.
   - `handle_crash` (`router.rs:104`, the UNEXPECTED `Exited`) tears down the modals but NOT the per-session maps (a pre-existing `config_state` leak — do not fix that here). Clear the `naming` entry there too: a crashed-then-resumed session re-uses the SAME id, so a stale `in_flight` would block naming forever and a stale `fails == MAX_FAILURES` would silently kill it.

**Steps:**
- [ ] Write the failing tests in `naming.rs` first. The seams, and their real visibility (verified — do not guess):
  - Build the manager: `let mut manager = SessionManager::new(temp_config_dir());` then `manager.attach_db(db)`, `manager.set_catalog(catalog)`, `manager.set_sink(sink)`, `manager.set_provider_factory(closure)` — all `&mut self`, so configure BEFORE any `Arc::new`. `set_provider_factory` takes `impl Fn(&Model) -> Box<dyn Provider> + Send + Sync + 'static` (`mod.rs:562`), so pass the closure DIRECTLY — `Arc::new(move |_| …)` does not compile.
  - `set_catalog` takes a `ModelCatalog` literal (`{ models, default_model, compaction }`); build its model with `session_tests::level_test_model("tama", "m1", &["off","low","high","xhigh"])` — widen that helper to `pub(crate)` (it is currently private in `session::session_tests`).
  - The DB: `session_tests::open_db` — widen it to `pub(crate)` and use it. `temp_config_dir` is already `pub` ✓. `session_tests::write_settings_json` — widen it too (the `sessionNamingEnabled: false` test needs it).
  - The sink: `session_tests::TestSink` sends on a PRIVATE `tx` field — widen the field to `pub(crate)`, then construct `TestSink { tx }` with your own `mpsc::unbounded_channel()` and assert on the received `{ "event": "session-titled", "payload": { sessionId, title } }` values. (It records EVERY emit, so filter by event name.) `EventSink` must be in scope to construct it.
  - The model call: the crate has NO shared mock provider — `ScriptedProvider` / `FailingProvider` (`harness/loop.rs:2135`, `:2176`) and `CannedProvider` (`worker/core.rs:535`) are private to their own test modules and none records the request. Author a local `struct RecordingProvider` in `naming.rs`'s tests: `#[async_trait] impl Provider for RecordingProvider`, with `Arc<Mutex<Vec<ModelRequest>>>` + a scripted sequence of `Vec<ProviderEvent>` + a `tokio::sync::Notify` fired on the first `complete()` call, so a test can `notify_notified().await` instead of sleeping. Clone the `Arc` state into the closure passed to `set_provider_factory`.
  - The task's imports, so the 0-warning gate holds: `futures_util::StreamExt` (for `stream.next()` over the `BoxStream`, the `compact.rs` pattern), `async_trait::async_trait`, `std::time::Duration`, `serde_json::json`, `tokio::sync::{Mutex, Notify, mpsc}`, `crate::agent::events::EventSink`, `crate::agent::harness::provider::{FinishReason, ModelOptions, ModelRequest, Provider, ProviderEvent}`, `super::{EffectiveCatalog, NamingState, …}`.
  - `config_state` is a private field of `SessionManager` — a child module sees its parent's privates, so `naming.rs`'s tests may seed it directly: `manager.config_state.lock().unwrap().insert(session_id.into(), NativeConfigState { model, thinking_level: None });`. Without this the guard-5 early return makes every "the provider was called" assertion fail. Likewise the session needs a `sessions` row (`db.record_session(&SessionInfo { … })`) — guard 3 reads it.
  - `temp_config_dir` is already `pub` in `session::tests` ✓.
  - The provider/auth/settings failures must produce nothing visible: assert the sink records no event and `title` stays `NULL`.
  - `agent_end` on a main session with no title → the provider is called once and `sessions.title` is set + `session-titled` emitted with `{ sessionId, title }`.
  - A second `agent_end` in the same session does not re-call the provider after a successful title (guard 3, via the DB row).
  - A second `agent_end` while a request is in flight spawns nothing (guard 4: `in_flight`).
  - A session row with `title = Some(..)` → no provider call.
  - `is_subagent = true` → no provider call (test through `route_event` with `is_subagent: true`).
  - `session_naming_enabled = false` in `settings.json` → no provider call.
  - A model with `api_key: ""` → no provider call, `fails` stays 0.
  - A provider returning `ProviderEvent::Error` three times → after the third, `fails == 3` and the next `agent_end` spawns nothing.
  - A provider whose stream ends with `Done(FinishReason::Length)` → counted as a failure, nothing written.
  - The provider answers `'"Porting the session namer"'` → the stored/emitted title is `Porting the session namer`.
  - `session_naming_model = "tama/m2:xhigh"` resolves through the effective catalog and the request goes to `m2`'s bare id.
  - `session_naming_model` unknown → the session's own model is used (no error).
  - `session_naming_reasoning = "turbo"` → the request's `reasoning_effort` is `None`.
  - The row is deleted between the read and the write (simulate by deleting inside the mock provider) → nothing emitted, `fails` unchanged.
  - `set_sink` never called (a `NamingRequest` with `sink: None`) → the title is still WRITTEN, nothing is emitted.
- [ ] Drive `route_event` directly in the hook tests (`WorkerInboundEvent::Event(RpcEvent::agent_end { messages: vec![], will_retry: false })`) under `#[tokio::test]`, awaiting the mock provider's `Notify` before asserting (a `tokio::time::sleep` here is a flake waiting to happen — do not use one). No `Arc<SessionManager>` is needed: `maybe_name_session` takes `&self` and the spawned task owns its inputs.
- [ ] Run `cargo test naming` from `src-tauri/`. Expect: compile failure (missing items). Implement steps 1–5. Re-run → green.
- [ ] Run `cargo test` from `src-tauri/` (the `route_event`/`close_session` suites must stay green), then `cargo clippy --all-targets` (0 warnings) and `cargo fmt` + `cargo fmt --check`.
- [ ] Commit: `feat(sessions): name sessions after the first exchange`

**Acceptance criteria:**
- [ ] One title request per session, fired after the first `agent_end` that has user text, never blocking the router.
- [ ] A session with a title is never re-titled; the write is conditional in SQL.
- [ ] Provider/auth/settings failures never produce a UI-visible error; three request failures stop further attempts for that session.
- [ ] A closed session leaves no `naming` entry behind (both the clean-exit and the crash path).

---

### Task 5: The UI shows the title

**Context:**
Two places label a session today, both by truncating the first user message: `src/components/SidePane.tsx:200-210` (the side-pane header, the old chat header's title) and `titleFor()` in `src/components/SpacesList.tsx:69-76` (the sidebar's session rows). Both must prefer a real title. A live session's title arrives by push (the `session-titled` event) because the boot `list_sessions` fetch happened before it existed; a session titled in an earlier run already carries `title` in its `SessionInfo`.

**Files:**
- Modify: `src/lib/tauri.ts` (`SessionTitledPayload` + `listenSessionTitled`, next to `listenSessionStalled` at :805)
- Modify: `src/store/sessions.ts` (a new `titleSession` action)
- Modify: `src/App.tsx` (register the listener next to `listenSessionStalled`, :75)
- Modify: `src/components/SidePane.tsx`, `src/components/SpacesList.tsx`
- Test: `src/store/sessions.test.ts`, `src/components/SidePane.test.tsx`, `src/components/SpacesList.test.tsx`

**What to implement:**
1. `src/lib/tauri.ts`:

```ts
/** The `session-titled` payload: a generated session title. */
export interface SessionTitledPayload {
  sessionId: string;
  title: string;
}

export function listenSessionTitled(
  callback: (payload: SessionTitledPayload) => void,
): Promise<UnlistenFn> {
  return listen<SessionTitledPayload>("session-titled", (event) =>
    callback(event.payload),
  );
}
```

2. `src/store/sessions.ts`: declare `titleSession: (sessionId: string, title: string) => void;` in the `SessionsState` interface (the action block at ~:491-614, with the file's one-line doc comment per action) AND implement it in the `create<SessionsState>` body (~:632+). Behaviour: set `title` on the matching entry in `sessions`, `historySessions`, AND `archivedSessions` (a session can be in any one of the three lists when its title lands). The three-list map-and-rewrite shape is the `archiveSession` action (the `sessions.ts` list-move code), NOT `markStalled` (which writes a separate `stalled` map, not the session rows). Entries in none of the lists → a no-op.
3. `src/App.tsx`: `unlistenPromises.push(listenSessionTitled(({ sessionId, title }) => useSessions.getState().titleSession(sessionId, title)));`
4. `src/components/SidePane.tsx`: the title becomes `stored title ?? first-user-text slice ?? basename`. Read the stored title with its OWN `useSessions` selector that returns a PRIMITIVE (a `string | null`), walking `s.sessions` → `s.historySessions` → `s.archivedSessions` the way the existing `activeCwd` selector (:186-196) walks them for `cwd`. Do NOT fold it into `activeCwd` by returning `{ cwd, title }`: zustand v5 (`^5.0.15`) re-runs a selector that yields a fresh object on every snapshot read and the component re-renders forever (`useShallow` would also work, but a second primitive selector is cheaper and matches the file's existing shape). Short-circuit the `firstUserText`/`activeCwd` chain when the title is a non-empty string. Keep the existing mask/fade markup untouched.
5. `src/components/SpacesList.tsx`: `titleFor(messages, spaceName, title?: string | null)` — return `title` when it is a non-empty string, else the existing derivation. Its THREE call sites differ in what they have in scope, so each is wired differently (verified):
   - `:159` (the delete-confirmation dialog's title): `deleteTarget` IS a `SessionInfo` → pass `deleteTarget.title`.
   - `:526` in `SessionRow` (:507): its props are `{ sessionId, spaceName, active, onOpen }` — NO `SessionInfo`, and its parent passes only ids (`activeView.liveSessionId` / `storedSessionIds`), so add a selector inside `SessionRow` that returns the primitive title for `sessionId` (same three-list walk as step 4) and pass that. Do NOT thread a `SessionInfo` prop through `SpaceView` — it holds ids by design.
   - `:694` in `ArchivedSessionRow` (:679): its `session` prop IS a `SessionInfo` → pass `session.title`. Leave its `showSuffix = title !== spaceName` rule UNCHANGED (a generated title is not the space name, so the `· {spaceName}` cue still shows — the row is inside the Archived section, where the space cue matters most); update that row's doc comment, which currently says the suffix appears "ONLY when the title is message-derived", to "message-derived OR generated".

Pin the titled case in `SpacesList.test.tsx` (the archived row renders `{title} · {spaceName}` for a generated title), so the suffix rule cannot drift.

Why the push event is required: `listSessions` is fetched ONCE at boot (`src/App.tsx:206`, inside the `Promise.all([listSessions(true), listSpaces()])`) and nothing re-fetches it afterwards, so a title generated in the current run would otherwise never reach the sidebar. Register the new listener beside `listenSessionStalled` (:75).

**Steps:**
- [ ] Failing store test in `src/store/sessions.test.ts`: `titleSession` updates the entry in `sessions`, and in `historySessions`, and in `archivedSessions`; an unknown id is a no-op (does not throw, does not append).
- [ ] `src/App.test.tsx` mocks every `listen*` App registers in its `vi.mock("./lib/tauri")` factory (:67-74) — add `listenSessionTitled: vi.fn().mockResolvedValue(() => {})` there, or the un-mocked export reaches the real `listen()` in jsdom.
- [ ] Failing component tests: `SidePane.test.tsx` — a session with `title: "Porting the session namer"` renders that string even when the first user message is longer/different; a session with `title: null` still renders the first-message truncation (the existing behaviour must not regress). `SpacesList.test.tsx` — the row label uses `title` when present and the first message otherwise, for BOTH `SessionRow` and `ArchivedSessionRow`.
- [ ] Run `pnpm test src/store/sessions.test.ts src/components/SidePane.test.tsx src/components/SpacesList.test.tsx`. Expect: the new assertions fail (missing action / unchanged derivation). If they pass unexpectedly, stop and find out why.
- [ ] Implement steps 1–5 above. Re-run the same command → green.
- [ ] Run `pnpm test` and `pnpm build` from the repo root.
- [ ] Commit: `feat(sessions): show the generated session title`

**Acceptance criteria:**
- [ ] A live session's label changes to the title the moment `session-titled` lands (no refetch).
- [ ] A stored session restored at boot shows its stored title.
- [ ] Untitled sessions are labelled exactly as before (first message, else folder name).

---

### Task 6: The settings rows

**Context:**
pi exposes the naming model in its `/archimedes` panel ("Model for naming" — blank = the current model) and keeps `reasoning` JSON-only. Mirror that: one switch for the master switch and one model picker, both in the General section, both copy-pasting the existing rows in `src/components/settings/GeneralSection.tsx` (the `Switch` at :210-221 for "Trust new Spaces by default", the `ModelPicker` at :240-265 for "Default model"). `sessionNamingReasoning` stays JSON-only by decision.

**Files:**
- Modify: `src/components/settings/GeneralSection.tsx`
- Test: `src/components/settings/SettingsPage.test.tsx`

**What to implement:**
Two `SettingsRow`s, inserted immediately after the "Default thinking level" row (the naming model belongs next to the model rows, before the enabled-tools list):
- Label `Name sessions automatically`; description says what it does and that a session keeps the name it already has (naming never overwrites). `Switch` bound to `settings.sessionNamingEnabled`, `onCheckedChange` → `onSave({ sessionNamingEnabled: checked })`, `aria-label="Name sessions automatically"`.
- Label `Session naming model`; description `Model used to write session names (the session's own model when unset)`. A `ModelPicker` identical to the "Default model" row — same `modelItemsFromCatalog(models.map(m => `${m.provider}/${m.id}`), settings.providers)` items plus `{ value: "", name: "Session's own model" }`, `value={settings.sessionNamingModel ?? ""}`, `onSelect` → `onSave({ sessionNamingModel: value === "" ? null : value })`. Pass `label="Session naming model"` and NOTHING else for accessibility: `ModelPicker`'s props are `{ label, value, placeholder?, items, onSelect, variant?, triggerClassName?, icon?, disabled? }` and it sets `aria-label={label}` on its own trigger (`src/components/ModelPicker.tsx:71`) — an `aria-label` PROP is a TS excess-property error. The accessible name is therefore `getByRole("button", { name: "Session naming model" })`. An unset picker shows the selected item's name (`Session's own model`), not a `placeholder` — do not pass one.

Do NOT add a thinking-level row. Do NOT add a per-session rename control.

**Steps:**
- [ ] Write failing tests in `src/components/settings/SettingsPage.test.tsx` following that file's existing settings-row pattern: a row is found by its label text (`screen.getByText("Default model")` :344, `screen.getByRole("button", { name: "Default model" })` :585). Assert: the switch renders checked from `sessionNamingEnabled` and a click saves the flipped flag; the model picker's trigger shows the stored model (or the placeholder) and choosing a row saves `sessionNamingModel`, choosing the placeholder saves `null`.
- [ ] Check the row-ordering assertion at `:824` (`index("Shell") < index("Trust new Spaces by default")`) still holds after inserting the two rows after "Default thinking level" — it does not name the new rows, so no change is expected; extend it only if it reddens.
- [ ] Run `pnpm test src/components/settings/SettingsPage.test.tsx`. Expect: failure (rows missing).
- [ ] Implement. Re-run → green.
- [ ] Run `pnpm test` + `pnpm build` from the repo root.
- [ ] Commit: `feat(settings): session-naming controls`

**Acceptance criteria:**
- [ ] Turning naming off persists `sessionNamingEnabled: false` and (with Task 4's guard) stops all further title requests, including for untitled live sessions.
- [ ] The picker writes a composed `provider/id` and blank writes `null`.

---

### Task 7: ADR 0037 and the full gate

**Context:**
The port carries decisions a future reader will otherwise re-litigate: why naming lives in the Supervisor rather than the Worker (ADR 0025 makes that a real fork), why the reasoning default is "omit" rather than pi's `minimal`, why the write is conditional SQL, and that auto-only ships with no rename affordance. AGENTS.md puts durable decisions in `docs/decisions/NNNN-slug.md`; the next free number is 0037 (0036 is model-hidden skills).

**Files:**
- Create: `docs/decisions/0037-supervisor-side-session-naming.md`
- Modify: `CONTEXT.md` (the Language section: a **Session title** term — model-written after the first exchange, `NULL` until named, never overwritten; the two Client surfaces that render it)
- Delete: `docs/roadmap/session-naming.md` (AGENTS.md: in-flight plans are deleted on ship — the model-hidden-skills feature commit did exactly that)

**What to implement:**
An ADR in the same shape as `docs/decisions/0036-model-hidden-skills.md` (read it first and copy its heading structure and tone): context (the pi port, ADR 0025's Supervisor/Worker split), decision (the seven decisions above, each with the one-line reason), and the rejected alternatives (Worker-side naming + a `session_title` store frame — needs a new IPC variant and cannot write the DB itself; `Arc<Self>` back-pointer on `SessionManager` — the owned-input task shape needs no cycle; reasoning default `minimal` — adds cost here). Note the two deliberate gaps: no rename UI, and the failure warning is a log line (no toast primitive in the desktop).

**Steps:**
- [ ] Read `docs/decisions/0036-model-hidden-skills.md`, then write the ADR (its shape: a `status`/`date`/`superseded-by` front-matter block, a single sentence-style H1, then **Why:**, **Considered Options**, **Consequences**).
- [ ] Add the **Session title** term to `CONTEXT.md`'s Language section (the file's existing `**Term**:` + definition format).
- [ ] Run the full gate and fix anything it reddens:
  - `pnpm test` and `pnpm build` from the repo root
  - `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` from `src-tauri/`
- [ ] Manual check: start a session in a Space, send one prompt, wait for the turn to settle → the sidebar row and side-pane header show a short title; restart the app → the same title is shown; `settings.json` gains `"sessionNamingEnabled": true` on the next settings save.
- [ ] Commit: `docs: ADR 0037 supervisor-side session naming` (includes the `CONTEXT.md` term and the deletion of this roadmap doc)

**Acceptance criteria:**
- [ ] ADR 0037 exists and states the Worker-vs-Supervisor fork and the reasoning-default deviation.
- [ ] All five gate commands are green.
- [ ] The manual check above passes on a real session.
