---
status: committed
done-when: a resumed Worker's ids carry a stamp its predecessor never had, a Retraction in the new incarnation provably leaves every row of the old one intact (asserted at the display-row seam and across a real two-process resume), `resumeSession` cannot drop a user message to a Retraction racing its history load, and no test still asserts a bare `m1` that would hide a regression to the old shape.
---

# Session incarnation Plan

**Goal:** two **Workers** that embody the same **Session** can never write the same display row, and the frontend's resume merge stops depending on transcript *positions*.

**Architecture:** the **Supervisor** mints a short opaque token per `Start` envelope (`StartEnv.incarnation`); the Worker seeds its `TurnState` with it, and `normalize` — the only place a `messageId` is ever put on a frame — stamps every id it mints (`a3f9c1:m1`, `a3f9c1:m1#2`, `a3f9c1:retract:1`, `a3f9c1:system`, `a3f9c1:default`). `compute_display_rows` is a *reader* of ids off frames, so display keys inherit the stamp untouched. Front-side, `resumeSession` selects the messages that arrived during its history load by identity instead of by array index.

**Tech Stack:** Rust 2021 (`src-tauri/`, `cargo`), React 19 + TypeScript (`src/`, `vitest` 5).

**Spec:** this file's earlier revision (approved 2026-10-14). Durable decisions: ADR 0049 (ids are stamped per incarnation), ADR 0050 (the resume merge selects by identity), ADR 0048 (the Retraction this makes safe). Glossary: **Session incarnation** in `CONTEXT.md`.

---

## Why this is a bug at all (read this before touching anything)

A **Session** outlives its **Worker**: a **Resume** spawns a *new Worker process* (ADR 0025) with a *new* `AgentLoop`, and `TurnState` is built once per `AgentLoop` — so `msg_counter` and `retract_seq` start at 0 again and the resumed session's first reply is `m1`, the id its first Worker already used. The display store UPSERTs (`storage/db.rs::record_message`, `UNIQUE(session_id, kind, message_key)`), so the new incarnation silently overwrites the old one's rows, and ADR 0048's Retraction — which erases BY `messageId` — can erase history that is not its own.

Counters are only three of the five colliding key families. `agent-text` rows are ALSO keyed by the constants `"system"` and `"default"`, and a fresh `text_acc` means a resumed Worker's first system line ("Compacting context…", "Retrying (attempt 1/3…)") UPSERTs over the previous Worker's and destroys it. **No counter-seeding can fix those two**, which is why the fix is an id namespace, not a seed.

Facts the plan depends on, each verified against the code:

- `normalize.rs` is the ONLY producer of `messageId` on a frame (`:145`, `:156`, `:423`, `:427`, `:80`, `:101`). `harness/loop.rs` never injects one. The only other writers are the `src/bin/fake_worker.rs` fixture (hardcoded `"m1"` frames, no `normalize`) and test inputs.
- `compute_display_rows` only READS ids off the frames it is handed (`:519-524`, `:561-566`, the thought key join `:537`, the retraction arm `:585-601`) — **it needs no change, arm by arm**, including its defensive `unwrap_or("default")` fallbacks.
- `TurnState` derives `Default` (`normalize.rs:65`) and is constructed in production at exactly one place: `harness/loop.rs:368` inside `AgentLoop::new`. No struct literals anywhere.
- Ids never enter the model's history: `native_messages` keys on `seq`, `ChatMessage` carries no id. Stamping cannot affect compaction, retries, or any provider prompt.
- `tool-call` rows are keyed by provider-generated `toolCallId`s; `user` rows by `NULL` (`session/mod.rs:1208`, and SQLite treats NULLs as distinct so `ON CONFLICT` never fires); `diff` display rows are never written. None of the three collides across lives.
- Children (**Subagent sessions**) never resume and are isolated by `session_id`; they get a stamp anyway for one-id-shape-per-transcript.
- The frontend is id-opaque and needs no id change: `sessions.ts:143`/`:158`/`:174` are `===` comparisons, `:306` is a concatenation, `:141`/`:156`/`:360`/`:372`/`:382` are `??` fallback *producers*, and React keys are positional (`MessageList.tsx:142` = `${activeSessionId}:${i}`, never `messageId`).
- No migration: a bare `m1` can never equal a stamped `a3f9c1:m1`, and nothing parses the shape. A Session that straddles the change mixes both shapes and renders correctly.

---

## Repo rules every task obeys

- Rust validation runs from `src-tauri/` (`cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`); frontend from the repo root (`pnpm test`, `pnpm build`). Run suites sequentially, not concurrently.
- **Single-file runs:** vitest filters go WITHOUT `--` — `pnpm test src/store/sessions.test.ts` runs 1 file; `pnpm test -- src/store/sessions.test.ts` runs all 82. Rust: `cargo test --lib <module::path>` (the real module paths here are `agent::normalize::normalize_tests::…` and `agent::normalize::compute_display_rows_tests::…` — there is no `normalize::tests`, and a filter that matches nothing exits 0, which is how a gate silently passes).
- **Introduce a helper together with its non-test caller.** `mod normalize` is private (`agent/mod.rs:17`), so a helper called only from `mod tests` is dead in the `--lib` build that `--all-targets` lints — `pub` alone does not save it. This is why Task 2 lands `TurnState::stamped` in the same commit as its `AgentLoop::new` caller.
- Do not weaken an assertion into `str::contains` / `ends_with`. Where an id assertion changes, it changes to a *different exact value*. The reason this defect shipped is that nothing asserted strongly enough across two Worker lives.
- `src/bin/fake_worker.rs` emits literal `"m1"` frames and hardcoded `DisplayUpsert` keys, and it must keep doing so — no task depends on it running `normalize`. Its ONE permitted edit is Task 3's addition of `"incarnation"` to the `session_info` envelope echo (Task 3 names it explicitly).
- Known load-flaky tests (re-run the single file to confirm before believing a failure): `SettingsPage.test.tsx`, `ModelPicker.test.tsx`, `App.test.tsx`, `SkillsDialog`, `SpacesList`; Rust `agent::mcp::http::tests::http_a_slow_sse_stream_completes`.

Tasks 1→2→3 are strictly ordered. **Task 4 is independent** (different language, different files) and may run in parallel.

---

### Task 1: The start envelope carries an incarnation stamp

**Context:**
A **Session** outlives its **Worker**, so the Worker must be *told* which life it is — it must not invent it. Everything session-scoped already reaches the Worker through `StartEnv` (`session_id`, `cwd`, `mode`, `trusted`, `config_dir`), and the Worker cannot read the DB at all (`worker/store.rs::load_messages` errors with "worker store is write-only — resume is rehydrated via the start envelope"). So the stamp rides the envelope.

This task makes the field exist and be populated. Nothing reads it yet — deliberately, so the commit is inert and green. The token is minted INSIDE `StartEnv::from_parts` rather than passed as a 13th argument: `from_parts` IS where the envelope is built (15 call sites), and minting there makes it impossible for a call site to omit a stamp or reuse one.

**Files:**
- Modify: `src-tauri/src/agent/types.rs` (add `mint_incarnation` beside `mint_session_id` at `:10-12`)
- Modify: `src-tauri/src/agent/worker/protocol.rs` (`StartEnv` `:195-207`, `from_parts` `:213`, the struct literal `:434` with its "all 12 fields" comment at `:432`, the round-trip test starting `:745`)
- Test: `src-tauri/src/agent/worker/protocol.rs` (`mod tests`)

**What to implement:**

1. In `src-tauri/src/agent/types.rs`, beside `mint_session_id`:

```rust
/// Mint the id stamp for ONE Worker's life within a Session (a **Session
/// incarnation**, ADR 0049). SIX lowercase hex chars, opaque: it is a
/// namespace, not a value anyone decodes — and being hex-only is what lets
/// `normalize::is_bookkeeping_message_id` read an id's fields positionally
/// without ever mistaking a stamp for one of them.
pub fn mint_incarnation() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    id[..6].to_string()
}
```

(`uuid` is a direct dependency of this crate; `agent::types` is a `pub` module, so `crate::agent::types::mint_incarnation` imports cleanly into `worker/protocol.rs`.)

2. In `protocol.rs`, add as `StartEnv`'s LAST field and set it in `from_parts`' returned `Self` (the 12 parameters stay exactly as they are — do NOT add a 13th):

```rust
    /// The stamp for THIS Worker's life within the Session (ADR 0049). Every
    /// `messageId` the harness mints carries it, so two incarnations of one
    /// Session cannot write the same display row. Minted per envelope — ONE
    /// stamp per `Start`.
    pub incarnation: String,
```

with `incarnation: crate::agent::types::mint_incarnation(),` in the constructor.

3. The only struct-literal construction, `:434` inside the "all 12 fields" test helper, gains `incarnation: "a3f9c1".to_string(),` — and reword that test's doc comment to 13 fields.

4. In `start_env_from_parts_matches_the_inbound_start_variant` (`:745`), add `assert_eq!(env_dec.incarnation, env.incarnation);` after the `system_prompt` assertion.

5. New test in the same module — `every_start_env_gets_its_own_incarnation_stamp`: build two envs from the module's `test_env()` helper and assert each stamp is 6 chars, parses as `u32::from_str_radix(&s, 16)` (i.e. hex), and that the two differ. Doc comment: the token is what keeps a resumed Worker out of its predecessor's rows, so two `Start`s sharing one token would reproduce the collision.

**What NOT to change:** `session/mod.rs:924`, `worker/manager.rs:968`, `worker/core.rs`, and every other `from_parts` call site — all 15 keep compiling because the mint lives inside `from_parts`.

**Steps:**
- [ ] Write `every_start_env_gets_its_own_incarnation_stamp` + the round-trip assertion.
- [ ] `cd src-tauri && cargo test --lib agent::worker::protocol` — must fail to compile with `no field 'incarnation'`. If it compiles, stop and check whether the field already exists.
- [ ] Implement 1–4.
- [ ] `cargo test --lib agent::worker::protocol` — green (the module's 7 tests).
- [ ] `cargo test --lib` — green (nothing reads the field yet).
- [ ] `cargo clippy --all-targets -- -D warnings` — silent (`mint_incarnation` has a non-test caller already).
- [ ] `cargo fmt` then `cargo fmt --check`.
- [ ] Commit: `feat: the start envelope carries an incarnation stamp`

**Acceptance criteria:**
- [ ] `StartEnv.incarnation` is a required `String` (never `Option`), serialized as `incarnation`.
- [ ] Two envs from `from_parts` never share a stamp; the token is 6 lowercase hex chars.
- [ ] All 15 existing `StartEnv::from_parts` call sites are untouched.

---

### Task 2: Every id the harness mints carries the stamp

**Context:**
This is the fix. `normalize::normalize` mints five id families: `m{n}` (`message_start`, assistant only — `:144-146`), `m{n}#{seg}` (the thought arm joins the frame id with `ThoughtState.next`, whose count spans the life of the loop), `retract:{n}` (the Retraction's discard line, `:424-428`), and the constants `system` (`system_chunk`, `:98-107`) and `default` (the no-id-open fallback, `:153-157` and `:420-423`). Stamping all five at the source means `compute_display_rows`, the live store, and the persisted keys agree without any of them knowing.

Stamping is **unconditional** in `TurnState`: an empty stamp yields `":m1"`, which is loudly wrong in a test rather than quietly colliding in production. Production cannot reach that state because `AgentLoop::new` (`loop.rs:299`, 21 params, `:300-323`) gains a required `incarnation: String`.

`is_bookkeeping_message_id` (`:89-96`) is the only structural reader of ids: it decides which `agent_message_chunk` ids are harness bookkeeping rather than model output, and its one consumer is `SubagentCapture::observe_sink_frame` (`worker/manager.rs:194`) — the predicate that stops a harness line being handed to a parent model as its child's answer. **It keeps its current meaning exactly: `system` and `retract` only.** `default` is NOT bookkeeping — a `{stamp}:default` chunk is real model text (a `message_update` that arrives before any assistant `message_start`), and today it IS captured; widening the set would silently drop a child's answer. `default` needs the stamp (it is a colliding row key) but not bookkeeping status.

**Files:**
- Modify: `src-tauri/src/agent/normalize.rs` (`TurnState` `:45-75`, `unique_system_chunk` `:80`, `is_bookkeeping_message_id` `:89-96`, `system_chunk` `:98-107`, `normalize` `:136+`, and the tests listed below)
- Modify: `src-tauri/src/agent/harness/loop.rs` (`AgentLoop::new` `:299-323`, the `turn_state` init `:368`, the test helpers at `:2720` and `:6405`)
- Modify: `src-tauri/src/agent/worker/core.rs` (the `AgentLoop::new` calls at `:176` production and `:626` inside `stub_handles(env: &StartEnv, …)`)
- Modify: `src-tauri/tests/harness_loop.rs` (`:202` the call, `:346` the id assertion)
- Modify: `src-tauri/tests/harness_subagent_dispatch.rs` (`:159` the call; it asserts no ids)
- Modify (comment only): `src-tauri/src/agent/worker/manager.rs:113-119` (the capture's doc comment enumerates which ids are bookkeeping)
- Test: `src-tauri/src/agent/normalize.rs` (`mod normalize_tests`, `:688`)

**What to implement:**

1. `TurnState` gains a field and two items:

```rust
    /// The stamp for this Worker's life (ADR 0049), prefixed onto every id
    /// this state mints. An EMPTY stamp is a test artifact — production can
    /// only build a `TurnState` through `AgentLoop::new`, which requires one.
    pub incarnation: String,
```

```rust
impl TurnState {
    /// A state whose ids are namespaced by `incarnation` (ADR 0049).
    pub fn stamped(incarnation: impl Into<String>) -> Self {
        Self { incarnation: incarnation.into(), ..Self::default() }
    }

    /// Namespace one of this state's ids: `a3f9c1:m1`, `a3f9c1:system`.
    fn id(&self, suffix: &str) -> String {
        format!("{}:{}", self.incarnation, suffix)
    }
}
```

`stamped` is `pub` (its caller `AgentLoop::new` is another module, and it lands in THIS commit, so the `--lib` build sees a caller); `id` stays private (same-module callers only).

2. Mint through the state, inside `normalize`:
   - `message_start` (`:144-146`): `st.current_message_id = Some(st.id(&format!("m{}", st.msg_counter)));`
   - both fallbacks (the `message_update` arm `:153-157`, the `message_retracted` arm `:420-423`) use the two-statement form so no closure borrows `st` while it is being read:
     ```rust
     let fallback = st.id("default");
     let mid = st.current_message_id.clone().unwrap_or_else(|| fallback.clone());
     ```
   - `message_retracted`'s line: keep `st.retract_seq += 1;` where it is, then pass the stamped id to the unchanged helper (it already takes `(message_id, text)`): `unique_system_chunk(&st.id(&format!("retract:{}", st.retract_seq)), "Discarded an incomplete reply")`.
   - `system_chunk` gains a leading id parameter — `fn system_chunk(message_id: &str, text: impl Into<String>) -> Value` with `"messageId": message_id` — and each of the SEVEN call sites (`:383`, `:404`, `:405`, `:437`, `:442`, `:444`, `:448`) passes `&st.id("system")` inline. Do NOT hoist it above the `match`: `normalize` runs per streamed token, and a hoisted `format!` would allocate on every frame for the seven arms that need it. None of those seven arms mutates `st`, so an immutable `st.id(..)` call inside them is borrow-clean.
   - Update `TurnState`'s doc comment (`:45-52`): `current_message_id` is `{incarnation}:m{n}`.

3. The predicate keeps its meaning and gains shape tolerance:

```rust
/// Is this messageId a harness bookkeeping line rather than model output?
/// The bookkeeping ids are `system` (the shared one-liner key) and
/// `retract:N` (a discard line, ADR 0048) — either bare, or after the
/// incarnation stamp (ADR 0049), because a pre-change database still carries
/// bare keys. A stamp is SIX HEX CHARS (`types::mint_incarnation`), so it can
/// never BE one of these words. `default` is deliberately NOT here: it is the
/// no-id-open fallback over REAL model text, and the subagent capture must
/// still hand it to the parent. Anything that must capture ONLY what the model
/// said — the subagent capture, whose text becomes the PARENT's tool result —
/// asks this instead of re-deciding the convention.
pub fn is_bookkeeping_message_id(id: &str) -> bool {
    id.split(':')
        .any(|field| field == "system" || field == "retract")
}
```

Update the capture's doc comment at `worker/manager.rs:113-119` in the same commit (it enumerates the bookkeeping ids and currently names only bare `system` / `retract:N`).

4. Thread the stamp. Append `incarnation: String` as the LAST parameter of `AgentLoop::new` (after `config_dir`; `#[allow(clippy::too_many_arguments)]` is already on it) and change `:368` to `turn_state: std::sync::Mutex::new(TurnState::stamped(incarnation)),`. Then the six call sites:
   - `worker/core.rs:176` — `env.incarnation.clone()` (`env: &StartEnv` is in scope; this line is what makes the fix real).
   - `worker/core.rs:626` — `"t".to_string()`.
   - `harness/loop.rs:2720` and `harness/loop.rs:6405` — `"t".to_string()`.
   - `tests/harness_loop.rs:202` — `"t".to_string()`.
   - `tests/harness_subagent_dispatch.rs:159` — `"t".to_string()`.

5. Re-target the MINTING assertions. Exact value → exact value, one row per test, every assertion named:

| test (`normalize.rs`, `mod normalize_tests`) | assertions to change |
|---|---|
| `message_id_advances_only_for_assistant_messages` (`:703`) | `Some("m1")` → `Some("t:m1")` (`:722`); `frames[0]["messageId"]` `"m1"` → `"t:m1"` (`:733`). The `msg_counter` 0/1 assertions stay. |
| `end_and_start_frames_emit_nothing` (`:743`) | `Some("m2")` → `Some("t:m2")` (`:753`) |
| `thinking_delta_maps_to_agent_thought_chunk` (`:771`) | `"m1"` → `"t:m1"` (`:788`) |
| `bookkeeping_events_and_one_liners` (`:1049`) | `"system"` → `"t:system"` (`:1058`) |
| `a_compaction_error_message_replaces_the_success_line` (`:1124`) | `"system"` → `"t:system"` (`:1150`) |
| `a_retraction_erases_the_current_message_and_says_so` (`:1184`) | the expected erase frame's `"messageId": "m1"` → `"t:m1"` (`:1196`); the discard line's `"retract:1"` → `"t:retract:1"` (`:1200`); `current_message_id == Some("m1")` → `Some("t:m1")` (`:1206`) |
| `a_second_retraction_gets_its_own_line_id` | `"retract:1"`/`"retract:2"` → `"t:retract:1"`/`"t:retract:2"` (`:1224-1225`) |
| `a_retraction_before_any_message_start_says_default` (`:1231`) | `"default"` → `"t:default"` (`:1236`) |
| `tests/harness_loop.rs:346` | `"m1"` → `"t:m1"` |

   Each of those tests constructs its state; switch `TurnState::default()` → `TurnState::stamped("t")` in them.

   **Leave alone** — these FEED literal ids to `compute_display_rows` (or to the capture) and never call `normalize`, so they are inputs, not minting assertions: `compute_display_rows_matches_the_legacy_persist_update_writes` (`:1279`), `a_compaction_update_frame_persists_no_display_row` (`:1399`), `a_retraction_empties_the_abandoned_rows` (`:1445`), `a_retraction_erases_exactly_the_keys_that_exist` (`:1536`), `a_retraction_of_a_message_that_never_streamed_writes_nothing` (`:1590`), the `worker/manager.rs` capture tests (`:1749-1863`), `harness/store.rs:386`, `worker/store.rs:182`, `agent/persist.rs:230`, `storage/db.rs:1113-1119`, `tests/storage.rs:89`, and the four tool-call tests that mint nothing (`toolcall_frames_accumulate_args`, `tool_execution_frames_map_to_updates`, `native_harness_toolcall_end_announces_single_row`, `empty_toolname_defers_announcement_to_toolcall_end`).

6. Two new tests in `mod normalize_tests`:

```rust
/// A stamp is a NAMESPACE, not a suffix to sort by: the same counter value in
/// two incarnations must produce two different ids, or a resumed Worker is
/// back in its predecessor's rows (ADR 0049).
#[test]
fn two_incarnations_mint_disjoint_ids_for_the_same_counter() { … }
```
Feed a `message_start` carrying an `assistant` message to BOTH `TurnState::stamped("aaaaaa")` and `TurnState::stamped("bbbbbb")`, then assert the MINTED values: `st_a.current_message_id.as_deref() == Some("aaaaaa:m1")`, `st_b.current_message_id.as_deref() == Some("bbbbbb:m1")`, and `st_a.current_message_id != st_b.current_message_id`. (Asserting `"aaaaaa:m1" != "bbbbbb:m1"` as two literals would be a tautology — assert what the code produced.)

```rust
/// The bookkeeping set is `system` and `retract`, in either shape — and
/// `default` is NOT in it: that id carries real model text (a `message_update`
/// before any assistant `message_start`), and the subagent capture must still
/// hand it to the parent (ADR 0048's fourth consumer).
#[test]
fn the_bookkeeping_predicate_reads_both_id_shapes() { … }
```
True: `system`, `retract:1`, `a3f9c1:system`, `a3f9c1:retract:1`. False: `a3f9c1:m1`, `a3f9c1:m2#3`, `default`, `a3f9c1:default`.

**What NOT to change:** `compute_display_rows`, `ThoughtState`, `unique_system_chunk`'s signature, `worker/manager.rs`'s capture logic (only its doc comment), `src/bin/fake_worker.rs`, the frontend.

**Steps:**
- [ ] Write `two_incarnations_mint_disjoint_ids_for_the_same_counter` and `the_bookkeeping_predicate_reads_both_id_shapes` first.
- [ ] `cd src-tauri && cargo test --lib agent::normalize` — red (no `stamped`, ids unstamped)? A filter that matches 0 tests also "passes", so confirm the test COUNT moved.
- [ ] Implement 1–3 in `normalize.rs`.
- [ ] `cargo test --lib agent::normalize` — green, including the re-targeted assertions (both `normalize_tests` and `compute_display_rows_tests` must stay green).
- [ ] Implement 4 (`AgentLoop::new` + six call sites) and `tests/harness_loop.rs:346`.
- [ ] `cargo test --lib`, then `cargo test` (all targets) — green? A `dead_code` warning means a helper has no non-test caller yet; an unexpected `m1` failure means that file MINTS ids — read it before touching it.
- [ ] `cd .. && pnpm test` — green with NO frontend change (ids are carried opaquely; if a frontend test breaks, it was parsing an id — investigate, never strip the stamp).
- [ ] `cd src-tauri && cargo clippy --all-targets -- -D warnings`, `cargo fmt`, `cargo fmt --check`.
- [ ] Commit: `feat: every id the harness mints carries its incarnation stamp`

**Acceptance criteria:**
- [ ] Over a real loop the first assistant frame's `messageId` is `t:m1` and the discard line is `t:retract:1`; the bookkeeping one-liner is `t:system`; the no-id fallback is `t:default`.
- [ ] `is_bookkeeping_message_id` is true for bare and stamped `system`/`retract`, and false for `{stamp}:m1`, `{stamp}:m2#3`, `default` and `{stamp}:default`.
- [ ] `compute_display_rows` and `ThoughtState` are byte-for-byte unchanged.
- [ ] No assertion anywhere became a substring/ends-with matcher.

---

### Task 3: Prove it across two Worker lives — one at the seam, one across a real resume

**Context:**
Nothing in the suite spans two incarnations today: the resume tests assert only that `session_id` survives (`tests/session_native.rs:277-281`, `tests/ipc.rs:475`), which is exactly why the collision shipped. Task 2 makes the behaviour correct; this task makes it falsifiable, at two levels, and the two levels prove DIFFERENT things — do not confuse them:

- **The seam test** (`mod normalize_tests`) proves the display-key claim exhaustively: two `TurnState`s with different stamps, two fresh accumulator sets, ONE `session_id`, ONE `Db` — which is precisely what two Worker lives do. All five id families are visible here, and this is where a dropped stamp is caught.
- **The integration test** (`tests/session_native.rs::native_session_end_to_end`) drives the `fake_worker` FIXTURE through a real two-process resume. The fixture does NOT run `normalize` and hardcodes `message_key: "m1"` on its `DisplayUpsert` (`src/bin/fake_worker.rs:184-192`, applied verbatim at `agent/persist.rs:128`), so this test can NEVER show a stamped display key — do not go looking for one and do not change the fixture's ids. What it CAN prove, and the only thing it should claim, is that two Worker processes spawned for one Session receive **different stamps** — which is the invariant the seam test then acts on.

To make the stamp observable across a process boundary, the fixture echoes it the way it already echoes `enabledTools` / `systemPrompt` / `trusted` off the decoded envelope (`src/bin/fake_worker.rs:344-352`). This is the ONE sanctioned edit to `fake_worker.rs`; the literal `m1` frames stay.

**Files:**
- Test: `src-tauri/src/agent/normalize.rs` (`mod normalize_tests`, `:688`)
- Modify: `src-tauri/src/bin/fake_worker.rs` (the `session_info` echo at `:344-352` — add one field)
- Test: `src-tauri/tests/session_native.rs` (`native_session_end_to_end`, `:169+`; helpers `wait_for_update` `:134`, `drain` `:159`)

**What to implement:**

1. `fake_worker.rs`'s Start arm: add `"incarnation": env.incarnation,` to the `session_info` `update` object, with a one-line comment naming ADR 0049 (the two-incarnation assertion). Nothing else in the fixture changes.

2. `two_incarnations_of_one_session_never_share_a_display_row` in `mod normalize_tests`. That module does not yet import the storage types, so start by copying the sibling module's fixture VERBATIM (`compute_display_rows_tests::temp_db`, `normalize.rs:1250-1269` — a private fn in a sibling `mod` is not importable) into `normalize_tests`, with its imports:

```rust
    use crate::agent::harness::store::SessionStore;   // + `Store` for the trait
    use crate::storage::Db;                           // NOT `crate::storage::db::Db` — `mod db` is private
    use crate::types::SessionInfo;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};
    // plus, added to the existing `use super::{normalize, TurnState};`:
    //   compute_display_rows, ThoughtState
```

`temp_db()` opens a temp `Db` and calls `db.record_session(&SessionInfo { session_id: "s1", cwd: "/tmp", capabilities: json!({}), config_options: None, archived: false, title: None, context_usage: None, is_subagent: false })` — the `messages` rows FK to `sessions` and `Db::open` enables FK enforcement, so an orphan insert errors. There is no `Db::insert_session`.

   - **Incarnation A** — `let mut st_a = TurnState::stamped("aaaaaa");` with its OWN `StdMutex`-wrapped accumulators (`HashMap<String,String>` text, `HashMap<String,Value>` tool state, `ThoughtState`), persisting through `SessionStore::new(db.clone()).persist_display("s1", &rows)` exactly as `compute_display_rows_matches_the_legacy_persist_update_writes` does. Feed, in order, through `normalize` then `compute_display_rows`:
     1. `message_start` (assistant) — opens `aaaaaa:m1`
     2. `message_update` with `text_delta` `"history"`
     3. `message_update` with `thinking_delta` `"think"`
     4. `auto_retry_start` (attempt 1/3) — puts a `"aaaaaa:system"` line on the stream
   - **Incarnation B** — `let mut st_b = TurnState::stamped("bbbbbb");` with a SECOND, FRESH set of accumulators (that is what a new Worker has), same `"s1"`, same `Db`. Feed:
     1. `message_start` (assistant) — mints `bbbbbb:m1`, the SAME counter value A used
     2. `message_update` `text_delta` `"parti"`
     3. `message_update` `thinking_delta` `"partthink"` — REQUIRED: the retraction's erase rows are emitted only for segments recorded in `ThoughtState.segments`, so without a thought there is no `bbbbbb:m1#1` row to assert
     4. `message_retracted`
   - Read back `db.messages_for("s1")` into a `Vec<(String /*kind*/, String /*key*/, String /*payload*/)>` and assert:
     - `("agent-text", "aaaaaa:m1")` exists and its payload contains `history`;
     - `("agent-thought", "aaaaaa:m1#1")` exists and contains `think`;
     - `("agent-text", "aaaaaa:system")` exists and contains `Retrying` — the family with NO counter to seed, and the one a seeding design would have left broken;
     - `("agent-text", "bbbbbb:m1")` and `("agent-thought", "bbbbbb:m1#1")` both exist with payload `{"text":""}` — B erased its OWN rows and nothing else;
     - `("agent-text", "bbbbbb:retract:1")` exists (the discard line is a row too — assert it so nobody "cleans it up");
     - no row has key `m1`, `m1#1` or `system` — nothing unstamped was ever written;
     - and A's text row key is not B's (`("agent-text","aaaaaa:m1") != ("agent-text","bbbbbb:m1")` as keys), which fails the instant the stamp stops being part of the key.

3. Extend `native_session_end_to_end` (additive; change no existing assertion). `wait_for_update(rx, kind)` skips non-matching frames, so it is safe to wait for a `session_info` early:
   - After the config-option assertions (before step (3)'s `send_prompt`), add:
     `let first_env = wait_for_update(&mut sink_rx, "session_info").await;`
     `let stamp_a = first_env["incarnation"].as_str().expect("the start envelope echoes its incarnation stamp").to_string();`
     `assert_eq!(stamp_a.len(), 6, "the stamp is six hex chars, got {stamp_a}");`
     `u32::from_str_radix(&stamp_a, 16).expect("the stamp is hex");`
   - Just before the close/resume (step (5)), capture the pre-resume display rows with NO `?` (the test returns `()`) and NO `.to_string()` (it trips `clippy::implicit_clone`):
     ```rust
     let before: Vec<(String, String)> = db
         .messages_for(&sid)
         .unwrap()
         .into_iter()
         .filter(|m| m.kind == "agent-text")
         .map(|m| (m.message_key.unwrap(), m.payload_json))
         .collect();
     assert!(!before.is_empty(), "the first incarnation persisted a display row");
     ```
   - Immediately after `resume_session` returns and BEFORE the existing `drain(&mut sink_rx)`, capture the second stamp the same way (`session_info` arrives when the resumed Worker attaches; `wait_for_update` skips turn 1's leftovers) and `assert_ne!(stamp_a, stamp_b, "a resumed Worker is a NEW incarnation and must not inherit the stamp")`.
   - After the resumed turn settles, re-read `db.messages_for(&sid)` and assert every `(key, payload)` pair in `before` is still present verbatim — the first incarnation's rows survived the second one's arrival.
   - Do NOT assert that any display key gained a stamp here (the fixture writes literal `m1`; see Context).

**Steps:**
- [ ] Write the seam test first (step 2), including the `temp_db()` copy and its imports.
- [ ] `cd src-tauri && cargo test --lib agent::normalize::normalize_tests::two_incarnations_of_one_session_never_share_a_display_row` — the full test path, because a filter matching nothing exits 0. It must PASS (Task 2 shipped the behaviour). If it FAILS, Task 2 is incomplete — finish Task 2; do not adjust this test's expectations.
- [ ] Add the `incarnation` echo to `fake_worker.rs`, then the three additions to `native_session_end_to_end`.
- [ ] `cargo test --test session_native` — green. A `session_info` timeout means the wait was placed after `drain` (which discards it) — move the wait, do not lengthen the timeout.
- [ ] Mutation check, and put it back: drop the stamp from `TurnState::id` (make it return `suffix.to_string()`) and confirm BOTH new tests fail; restore. If either survives, that test has no teeth.
- [ ] `cargo test` (all targets) — green.
- [ ] `cargo clippy --all-targets -- -D warnings`, `cargo fmt`, `cargo fmt --check`.
- [ ] Commit: `test: two incarnations of one session never share a display row`

**Acceptance criteria:**
- [ ] One test proves a Retraction in incarnation B leaves incarnation A's text, thought AND system rows intact.
- [ ] A real two-process resume gives the two Workers different 6-hex stamps, and leaves the first incarnation's `agent-text` rows byte-identical.
- [ ] Both new tests fail when the stamp is removed from `TurnState::id`.

---

### Task 4: The resume merge selects additions by identity, not position

**Context:**
`resumeSession` (`src/store/sessions.ts:1180-1275`) snapshots `prior` at `:1223`, `await`s `loadHistory(sessionId)` at `:1224`, then takes `added = (get().messages[sessionId] ?? []).slice(prior.length)` at `:1228` — an index measured against a snapshot taken before the await. `applySessionUpdate` can now REMOVE messages (its `message_retracted` arm filters by `messageId`, `sessions.ts:164-177`), so the array can be shorter than assumed, the slice shifts left, and a prompt the user sent during the window vanishes until the next reload. The only identity-based selection in the file is the dedupe pass INSIDE this same merge (`:1246-1266`), which is what the new rule must agree with. (There is no other reload merge in the file — `openSession` at `:1128` applies its rows verbatim with no merge at all, which is a related-but-separate hole, recorded as a follow-up.)

The replacement rule: the additions are the messages in `current` that are not in the snapshot, matched on identity — `mergeDedupeKey(m)` plus the message's own `at` — counted as a MULTISET so a repeat of an identical message still counts as new. Where identity cannot decide, keep the message: a duplicated bubble beats a lost prompt (the same direction the existing user-message timestamp tiebreak at `:1259-1265` already chose).

Accepted consequences, to be written into the code comment (ADR 0050):
- `mergeDedupeKey` is content-based (`sessions.ts:296-311` — text for `agent-text`, `title|status` for `tool-call`), so a message that EXISTED before the snapshot but MUTATES during the window (an in-flight same-id append at `:141-146`/`:156-161`, or a `tool_call_update` flipping a card) is no longer "in the snapshot" and re-enters `added` → a duplicate bubble if its persisted row lags. That replaces the old rule's silent truncation of the streamed tail. Keep it.
- A live thought can appear twice — live it carries `{stamp}:m1`, its persisted row key is `{stamp}:m1#1`, so its key never matches its own reloaded row. This duplication is PRE-EXISTING (`slice()` included it too), not caused by this change; collapsing the `#seg` would make two thought segments of one message indistinguishable in `mergeDedupeKey`, which is worse.

**Files:**
- Modify: `src/store/sessions.ts` (`resumeSession`'s merge block `:1213-1273`; the single line `:1228`)
- Test: `src/store/sessions.test.ts` (inside `describe("resumeSession (history reload race)")` at `:1659`)

**What to implement:**

1. Replace `sessions.ts:1228` (`const added = (get().messages[sessionId] ?? []).slice(prior.length);`) with:

```ts
        // WHAT ARRIVED WHILE WE WERE LOADING — selected by IDENTITY, never by
        // position (ADR 0050). `slice(prior.length)` assumed the array could
        // only grow across the await; a Retraction (ADR 0048) REMOVES a
        // message, which shifts every index left and silently dropped a prompt
        // the user sent in the window — and dropped the retry that reused a
        // retracted id, and anything prepended. Identity is `mergeDedupeKey` +
        // the message's own `at`, COUNTED: two identical messages in the same
        // millisecond are two messages, and the second is the new one. Where
        // identity cannot decide we KEEP the message — a duplicated bubble
        // beats a lost prompt. Two duplications are accepted: a live thought
        // (its persisted key is `{stamp}:m1#1`, so it can never match its own
        // row), and a pre-existing message the reducer MUTATES in place during
        // the window (`mergeDedupeKey` is content-based, so a changed message
        // is no longer "in the snapshot") — both replace the old rule's silent
        // truncation of the streamed tail.
        const priorCount = new Map<string, number>();
        for (const m of prior) {
          const k = `${mergeDedupeKey(m)}|${m.at}`;
          priorCount.set(k, (priorCount.get(k) ?? 0) + 1);
        }
        const seenNow = new Map<string, number>();
        const added = (get().messages[sessionId] ?? []).filter((m) => {
          const k = `${mergeDedupeKey(m)}|${m.at}`;
          const nth = (seenNow.get(k) ?? 0) + 1;
          seenNow.set(k, nth);
          return nth > (priorCount.get(k) ?? 0);
        });
```

`mergeDedupeKey` is module-scope (`:296`) and already called from this closure (`:1249`, `:1260`); every `Message` variant carries `at` (`:37-56`). Leave `:1223-1227` and everything from `:1229` (the dedupe block `:1246-1266`, the `set` at `:1267`) exactly as they are.

2. Add the racing test to the `describe` block at `:1659`, copying the seeding of its neighbour at `:1671-1688` (a session must be registered or `resumeSession` throws `unknown session`, which would turn the first red into a throw):

```ts
  it("keeps a user message added while the reload is in flight when a retraction shrinks the transcript (ADR 0050)", async () => { … });
```
   - Seed `activeSessionId: "s1"`, `historySessions: [{ sessionId: "s1", cwd: "/x", capabilities: { loadSession: true }, archived: false }]`, and `messages: { s1: [{ kind: "user", text: "one", at: 1 }, { kind: "agent-text", messageId: "a3f9c1:m1", text: "two", at: 2 }] }`.
   - Defer history: `vi.mocked(loadHistory).mockImplementationOnce(() => new Promise<MessageRow[]>((r) => (resolveRows = r)))`, then `await useSessions.getState().resumeSession("s1")`.
   - **In the window**, shrink then add — the store action takes two args (`sessions.ts:734`; for the call form see `src/components/SubagentDetailHost.test.tsx:84`):
     `useSessions.getState().applySessionUpdate("s1", { sessionUpdate: "message_retracted", messageId: "a3f9c1:m1" });` (frame shape: `src/lib/tauri.ts:189-197`) — this REMOVES the trailing message, 2 → 1 — then `useSessions.getState().addUserMessage("s1", "three")` → 2 again.
   - Resolve with ONLY the persisted `user`/`one` row (`kind: "user"`, `messageKey: null`, `payloadJson: JSON.stringify({ text: "one" })`, `createdAt: 1`).
   - Flush with `await new Promise((r) => setTimeout(r, 0))`, then assert the prompt survived: `expect(useSessions.getState().messages.s1.some((m) => m.kind === "user" && m.text === "three")).toBe(true)`.
   - Why it is red before the fix: `prior.length` is 2, the array is 2 again after shrink+add, so `slice(2)` is `[]`, `added` is empty, and the merge result is just the reloaded `one` row.

3. Optional but cheap, and it pins the multiset rule: a second test with the SAME deferred-load shape that adds `addUserMessage("s1", "again")` TWICE while `prior` already holds one identical `again` (same `at` — freeze it by seeding the messages array rather than the action, or use two distinct `at`s and assert both copies survive). Assert both new copies are present.

**What NOT to change:** `applySessionUpdate`'s reducer arms, `mergeDedupeKey`, `rowToMessages`, `openSession` (`:1128-1160`), the dedupe block `:1246-1266`, and anything the Rust tasks touch.

**Steps:**
- [ ] Write the racing test first.
- [ ] `pnpm test src/store/sessions.test.ts` (NO `--` — with `--` vitest runs all 82 files) — did it FAIL on the missing `"three"` (not on `unknown session`)? If it passed, the retraction did not shrink the array; fix the setup.
- [ ] Implement 1.
- [ ] `pnpm test src/store/sessions.test.ts` — green? If an existing resume test fails, READ it: an expectation about the *positions* of added messages is pinning the rule this task replaces — update it and say so in the commit body. An assertion that a message is present or absent means the merge is losing something — **stop and investigate**.
- [ ] `pnpm test` (full) and `pnpm build` — green.
- [ ] Commit: `fix: the resume merge selects its additions by identity, not position`

**Acceptance criteria:**
- [ ] A retraction during `resumeSession`'s load cannot drop a user message.
- [ ] No `slice(` remains in `resumeSession`'s merge block (`sessions.ts:1213-1273`) — it legitimately remains at `:144` and `:159`, which are the reducer's append arms.
- [ ] The pre-existing "does not wipe a user message added while the history reload is in flight" and "does not render a resumed prompt twice" tests pass UNMODIFIED.

---

## Final validation (whole branch, run sequentially)

```
cd src-tauri && cargo fmt --check
cd src-tauri && cargo test
cd src-tauri && cargo clippy --all-targets -- -D warnings
pnpm test
pnpm build
```

All green, clippy silent. Then update `docs/roadmap/compaction-recovery-hardening-follow-ups.md`: §3 stays retired (ADR 0049), §4 (the stalled tail) and §5 (`openSession` applies a reload verbatim — the same race class Task 4 closes for `resumeSession`) remain open.
