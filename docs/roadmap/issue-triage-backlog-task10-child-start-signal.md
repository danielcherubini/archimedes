---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
issue: 9
done-when: A **Subagent session** whose reduced message resolves to `None` (no launch/definition prompt AND no `manage_todo_list` in its resolved tool set) starts with NO system message at all — its transcript has no `system` row and its first model call carries no `system`/`instructions` field — while a main session still gets the full main prompt as its seq-0 row; the wire says so explicitly (`"mode": "fresh_child"`), and both child shapes are pinned by tests.
---

# Task 10 — A child start signal that never reaches the main-prompt arm (issue #9)

**Goal:** `worker/core.rs`'s `(StartMode::Fresh, None)` arm is the MAIN-prompt arm, and a **Subagent child** with no reduced message lands in it, so narrowing a child's tools is REWARDED with the largest prompt in the app. Give the arm a start signal it can DISTINGUISH — a third `StartMode` variant — so a child never reaches it and prepends NOTHING.

**Architecture:** `StartMode` (`src-tauri/src/agent/worker/protocol.rs`) gains `FreshChild`, serialized `"fresh_child"`. `StartEnv.system_prompt` stays `Option<String>` VERBATIM (the `systemPrompt` wire field, the `fake_worker.rs` echo and the three test files that assert on it — `subagent.rs`, `tests/harness_dispatch_native.rs`, `harness/loop/tests/subagents.rs` — are untouched). `default_build_loop`'s init `match` becomes four arms — `Resume` → hydrate, `Some(msg)` (either fresh mode) → `prepend_system`, `(Fresh, None)` → the main prompt, `(FreshChild, None)` → nothing — and `subagent_flow.rs`'s child envelope is the ONLY production site that sends `FreshChild`. The child with no message then has no seq-0 row at all (its first `native_messages` row is the `user` task), which is the shape the code's own comments have always claimed and which compaction, the three provider wires and the frontend already tolerate.

**Tech Stack:** Rust 2021, serde externally-tagged enums (`#[serde(rename_all = "snake_case")]` on `StartMode`), the stdio JSONL Worker protocol (ADR 0025), `AgentLoop::prepend_system` / `persist_system_message` (`harness/loop.rs`, `loop/emit.rs`), the `TranscriptPersister` (`agent/persist.rs`), wiremock + the real `archimedes --worker` binary in `src-tauri/tests/worker_e2e.rs`.

---

## Parallelisation

**Verdict:** SERIAL — one task of the issue-triage backlog, and every file it touches is a Rust source in `archimedes`, which is **one compilation unit**: the parent roadmap measured (planted-error experiment, `docs/roadmap/issue-triage-backlog-status.md` §"Why the waves collapsed to serial") that any sibling's half-finished `.rs` edit makes an unrelated scoped `cargo test` fail to compile, which destroys gate 4. The parent lists T10 in the serial column, and it shares `worker/protocol.rs` + `worker/manager/subagent_flow.rs` with T11 and `worker/manager/tests/mod.rs` + `src/bin/fake_worker.rs` with T11/T12 — so no two of them can share a wave even setting the compile unit aside.

Consequence for the executor: **run the FULL gate**, not a scoped run — a scoped `cargo test --lib <filter>` compiles the whole crate here anyway, so scoping buys nothing.

---

## Context — why this exists, and what was verified against the tree

### The defect, and the exact reachable path (verified line by line)

1. An Agent definition with a `tools:` list that excludes `manage_todo_list` and an EMPTY body. `src-tauri/src/agents.rs:306` — `let body = lines[fm_end + 1..].join("\n").trim().to_string();` — yields `""`.
2. `src-tauri/src/agent/harness/launch.rs:264-266` — `system_prompt = explicit.or_else(|| (!def.system_prompt.is_empty()).then(|| def.system_prompt.clone()))` → **`None`** (the comment above it says the `or_else` must not turn an empty body into `Some("")`; the test `launch.rs:849 resolve_launch_empty_body_means_no_system_prompt` pins it).
3. `src-tauri/src/agent/worker/manager/subagent_flow.rs:598-600` — `has_todo_tool` comes from the RESOLVED child tool list (`subagent_flow.rs:574-592`: `launch.tools = Some(_)` → VERBATIM minus `subagent`/`list_agents`), so a `tools: [bash]` definition gives `has_todo_tool == false`, and `build_child_system_message(None, false)` returns `None` — the `(None, false) => None` arm at `src-tauri/src/agent/harness/prompt.rs:162`.
4. `subagent_flow.rs:611-624` builds `StartEnv::from_parts(child_id, cwd, StartMode::Fresh, …, system_prompt /* None */)`.
5. `src-tauri/src/agent/worker/core.rs:329-370` — `default_build_loop`'s init `match (&env.mode, &env.system_prompt)`: the `(StartMode::Fresh, None)` arm at `core.rs:347` calls `build_main_prompt(&PromptContext { … })` and `prepend_system`s it. So the child's seq-0 row is the WHOLE main prompt: the preamble, `<tools>`, `<rules>`, `<project_context>` (the AGENTS.md walk-up + the `~/.pi/agent` global file), the `<skills>` section and `<cwd>`.

**Narrowing a child's tools is therefore rewarded with the LARGEST prompt** — the one shape the Supervisor deliberately reduced is the one shape that gets the unreduced one. It is NOT a security problem: the `<skills>` section is `model_visible()`-filtered like any other (ADR 0036's subagent bullet), and `<tools>` matches the child's own advertised set (`advertised_specs()` is read AFTER `set_enabled_tools`, `core.rs:323` vs the prompt build at `:357`). It is an intent / cost / testability defect, and the two comments disagree about it: `core.rs:352-356` admits "this arm is NOT main-session-only in practice", while `subagent_flow.rs:595-597` claims the opposite ("`None` → no system message — the child's seq-0 row is absent"). **Both comments are part of the defect surface and both change in this commit.**

### What "no message" actually does downstream — verified, and why NO seq-0 row beats an empty one

`prepend_system` (`src-tauri/src/agent/harness/loop.rs:427-441`) is the ONLY thing that writes the seq-0 row: it pushes a `System` message, re-estimates the `Compactor`, emits `context_usage_update` and calls `persist_system_message`. Not calling it means `self.messages` starts EMPTY, the first `begin_turn` (`loop/turn.rs:54-61`) pushes the `user` task at index 0, and `persist_transcript_message` writes it at seq 0. Every consumer of "the first row" was read:

- `persist_system_message` (`loop/emit.rs:105-121`): `None => return` for an empty transcript and a role guard for a non-`System` first row — silent, no eprintln. **Safe.**
- `run_compaction` (`src-tauri/src/agent/harness/compact.rs:436-442`): `system_head` is `first().filter(System && !summary)`; `None` → the whole transcript is compactable and the summary is re-prepended at index 0. Its own comment already names this case ("a summary at index 0 — a legacy pre-ADR-0017 resume / **a child with no system message** — is NOT a leading system message"), and `compact.rs`'s test fixtures carry a `transcript_without_system()` shape (`compact.rs:2039`). **Already supported by design.**
- The three provider wires all fold `System` messages and all guard non-empty: `ModelRequest::system_text()` (`harness/provider/types.rs:53-68`) returns `""`, `openai.rs:507-510` skips the leading `system` message when it is empty, `anthropic.rs:684-686` omits `system`, `responses.rs:591-593` omits `instructions` (pinned by `responses.rs:1177-1180` "no system messages → NO `instructions` field"). **Safe — and this is the argument against an "explicitly empty seq-0"**, which is the alternative the issue floats:
  - An empty `System` row would be a DB row the model never sees (the fold drops it), i.e. a record of a prompt that does not exist;
  - `run_compaction` would classify it as PROMPT STATE (`System` and not a summary) and preserve it forever at index 0;
  - it would require inventing a `prepend_system("")` call whose only content is a lie about the session's instructions.
  So: **no message → prepend nothing → no row.** That is also exactly what the existing comments claim already happens, so the fix makes the code match the documented contract rather than adding a new shape.
- Resume: a child is never resumed (`session-closed` never carries a child id; `list_sessions` filters `is_subagent = 0`, `storage/db.rs:486-495`), and `(StartMode::Resume, _)` replays whatever rows exist. **Safe.**
- The frontend: a child's transcript is built from `agent_message_chunk` `SinkFrame`s, not from `native_messages` (the UI's history path reads the `messages` DISPLAY table, `commands/history.rs:59-85`), and `applySessionUpdate`'s `default:` arm ignores unknown update kinds (`src/lib/transcript/reducer.ts:219-221`). **No frontend change, no frontend break.**

### The chosen start signal: a third `StartMode` variant (option (a))

```rust
pub enum StartMode {
    Fresh,        // wire "fresh"       — a main session: the Worker builds the MAIN prompt (seq 0)
    FreshChild,   // wire "fresh_child" — a Subagent child: the Supervisor's message, or NOTHING
    Resume,       // wire "resume"      — the Supervisor rehydrated the transcript
}
```

**Wire reasoning (read `protocol.rs` before deciding otherwise).** `StartMode` is `#[derive(Serialize, Deserialize)] #[serde(rename_all = "snake_case")]` (`protocol.rs:23-36`) — a plain string on the wire inside the `start` payload. The protocol's documented permissiveness (`protocol.rs:15-19`, `decode_inbound` at `:340-362`) is **permissive only about unknown top-level `type`s**: the decoder routes on `type` and then deserializes the WHOLE payload into the variant, so an unknown value of the NESTED `mode` field is a `ProtoError::Json`, which `spawn_stdin_reader` (`worker/mod.rs:273-276`) prints as `worker: bad inbound line` and DROPS. That is the honest direction of failure — loud on the Worker's stderr (which the Supervisor pipes into `supervisor.log` under `worker-stderr:`) — and the alternative is not: adding `#[serde(other)]` to `Fresh` would make an unknown mode SILENTLY become the main-prompt arm, i.e. the exact defect this task removes. **Do not add `#[serde(other)]`.** Test F below pins the error direction.

Does a new variant break an old-Worker / new-Supervisor mix? It would (the `start` line would be dropped and the child would hang to the **Dead bound**) — and the mix cannot occur: the Worker is a **self-exec of the same binary** (`WorkerHandle::spawn(std::env::current_exe())` + `--worker`, `worker/client.rs:272` / `lib.rs:34-36`, ADR 0022 + 0025), so Supervisor and Worker are always one build, and every session spawns its own process (a stale Worker from a previous version cannot exist across an upgrade — `reap_all` closes them on exit, `manager/registry.rs`). The `fake_worker` fixture is built from the same source by `cargo test`. This is the same reasoning `protocol.rs`'s own header gives for keeping the surface unversioned.

Why not **(b), a tri-state on the prompt field** (`MainPrompt | ChildMessage(String) | NoMessage`): it is a SHAPE change to an existing wire field (`systemPrompt: string|null` → `prompt: {"child_message": "…"}`), which forces `fake_worker.rs:561`'s echo plus `subagent.rs`'s four-case envelope test, `tests/harness_dispatch_native.rs:405-500` and `harness/loop/tests/subagents.rs:457-476` to be rewritten, and it does not fix the thing that actually broke: `(Fresh, None)` for a MAIN session and `(Fresh, None)` for a CHILD would still be the same bytes. The defect is that the envelope cannot say WHO is starting; only the mode can.

Why not **(c), a `is_child: bool` beside `system_prompt: Option<String>`**: it keeps the illegal state representable (`Fresh` + `None` still means two different things depending on a second field), and the arm would read two fields to answer one question. `StartMode` already IS the "how does this transcript start" field — its doc comment says so verbatim.

Bonus of (a): `StartMode` is `Copy` and matched exhaustively in exactly TWO places (`core.rs:329` production, `core.rs:792` the test stub's mirror — grepped: the `env.mode` FIELD is read nowhere else in the crate but `protocol.rs:875`'s round-trip `assert_eq!`; `subagent_flow.rs:17` / `core.rs:33` only import the type to name a variant), so **the compiler enumerates the sites for you**. No other `match`/construction needs a thought.

### Every `StartEnv` / `StartMode` site, and which change (all read, not assumed)

| Site | What it builds | Change? |
|---|---|---|
| `src/agent/worker/protocol.rs:23-36` | the `StartMode` enum | **CHANGE** — add `FreshChild` + rewrite the doc comments |
| `src/agent/worker/core.rs:329-370` | production init `match` | **CHANGE** — four arms + kill the stale "NOT main-session-only in practice" comment |
| `src/agent/worker/core.rs:792-803` | `stub_handles`' mirror of the init | **CHANGE** — mirror the same four arms (`(FreshChild, None) => {}`) |
| `src/agent/worker/manager/subagent_flow.rs:611-624` | the CHILD envelope | **CHANGE** — `StartMode::FreshChild`, and fix the step-4 comment |
| `src/agent/session/mod.rs:1141-1163` | the MAIN envelope (`Fresh`/`Resume` + `system_prompt: None`) | unchanged (the comment above it stays true) |
| `src/agent/worker/core.rs:729-751` `test_env(mode, transcript, sp)` | test helper, mode is a parameter | unchanged (the new tests pass `FreshChild`) |
| `src/agent/worker/core.rs:1001` `subagent_worker_system_prompt_is_the_seq_zero_row` | the stub-based child pin the issue names | **CHANGE** — drive it with `FreshChild` (it is a CHILD), keep the name |
| `src/agent/worker/protocol.rs:428-443` `test_env()` / `:447-478` `start_inbound()` | wire round-trip inputs (`Fresh` / `Resume`) | unchanged (new tests added alongside) |
| `src/agent/worker/client.rs:867-902` `test_env` | a PARENT env (the fixture never builds a loop) | unchanged |
| `src/agent/worker/manager/tests/mod.rs:77-108` `test_env` | a PARENT env | unchanged |
| `src/agent/subagent.rs:404-429` `test_env` + `:932-943` `the_child_system_prompt_rides_the_start_envelope` | a PARENT env + the four-case `systemPrompt` ENVELOPE pin | behaviour unchanged (the `systemPrompt` field is untouched); **sharpen case 4's comment** (`subagent.rs:1086-1087`, `:1126-1129`) — "the child's seq-0 row is absent" is now TRUE |
| `src/agent/harness/dispatch.rs:448-462` (in `mod tests`) | a PARENT env | unchanged |
| `src/agent/harness/loop/tests/subagents.rs:73-97` | a PARENT env | unchanged (its `session_info` assertion at `:457-476` keys on `systemPrompt`, untouched) |
| `src-tauri/tests/worker_stderr.rs:39-59` `start_env` | a MAIN-shaped env (`Fresh` + `None`) | unchanged — it exercises stderr plumbing; building the main prompt is correct for it |
| `src-tauri/tests/worker_stdin.rs:77-108` `subagent_start` | "the subagent shape — `Fresh` + a `system_prompt`" | **CHANGE** → `StartMode::FreshChild` (keep it `Some(..)`: the test's whole premise is the seq-0 push racing the inbound `prompt`); fix its doc line |
| `src-tauri/tests/harness_dispatch_native.rs:95-110` | a PARENT env | unchanged |
| `src-tauri/tests/harness_subagent_dispatch.rs:99-114` | a PARENT env | unchanged |
| `src-tauri/tests/worker_e2e.rs:320-346` `start_env` | the MAIN env | unchanged; **new test added** (G below) |
| `src/bin/fake_worker.rs` | decodes `Inbound::Start(env)` and echoes `enabledTools` / `systemPrompt` / `trusted` / `incarnation` (`:548-578`) | **NO CHANGE** — it never pattern-matches on `mode` and never builds a loop, so a new variant is inert to it. Read `:546-580` to confirm before believing this line. |

### Comments and docs that are part of the defect surface (fix in the same pass)

- `worker/core.rs:347-356` — the arm's "NOTE: this arm is NOT main-session-only in practice …" paragraph: DELETE (it becomes false) and replace with one sentence saying `(Fresh, None)` is now the main session ONLY because a child arrives as `FreshChild`, and that `(Fresh, Some(_))` is kept so the envelope stays total (production's main path always sends `None` — `session/mod.rs:1161`).
- `worker/manager/subagent_flow.rs:595-597` — "`None` → no system message — the child's seq-0 row is absent": now TRUE; keep the claim and make it cite `FreshChild` as the mechanism that guarantees it.
- `worker/core.rs:1-11` (module doc) — "the main system prompt for `Fresh`" → name both fresh modes.
- `worker/manager/mod.rs:258-272` — the `dispatch_subagent` doc: say the child envelope carries `mode: FreshChild`, and that a `None` reduced message means the child gets NO system message.
- `harness/prompt.rs:144-151` — `build_child_system_message`'s doc says "`None` means 'no REDUCED message', NOT 'no system message': the worker's `(StartMode::Fresh, None)` arm then builds the MAIN prompt for that child". The second clause dies here; rewrite so `None` means "no system message at all", and keep the ADR 0036 pointer for the TOOLS half (the child still holds `read_skill`/`list_skills`, which is what filters a model-hidden Skill now that no child gets a `<skills>` section at all).
- `harness/loop/tests/tools_enabled.rs:312-320` and `:355-361` — both claim the no-reduced-message child "falls through to the MAIN-prompt arm in `worker/core.rs`, whose section is FILTERED the same way". False after this commit: that child gets NO section at all, so the TOOLS are now the only filter for EVERY child shape. Rewrite both, keep every assertion (they all still hold — the child set keeps `read_skill` and `list_skills`).
- `docs/decisions/0036-model-hidden-skills.md:31` — the "Subagent children inherit the filter for free" bullet states the fall-through to the main-prompt arm as fact. `docs/decisions/` is append-only, so add a short dated **Amendment** block at the END of that ADR (the file already carries an "Amended 2026-10-23" block — follow its shape) saying: the fall-through is gone, a child now has no `<skills>` section in either shape, so the tool-side filter is the whole child story, and the bullet's conclusion ("no child shape advertises a model-hidden Skill") holds for a STRONGER reason than the one written. Do not add a new ADR: this change makes the code match what ADR 0017/0020 already documented (a REDUCED child message), so it is a correction, not a decision. Leave `0017` and `0020` untouched (neither claims the fall-through).

### The T11 seam — keep it, do not solve it

T11 (#47) adds a resolve-miss marker to the `subagent-session-started` payload, which `subagent_flow.rs:625-645` builds, and it also touches `protocol.rs`. This task adds **NOTHING** to that `json!` block — the child's start signal stays entirely inside the `Start` envelope, which the UI never sees (the `session_info` echo is the test fixture's own construction; production's Worker emits no such frame). Keep `:625-645` byte-identical so T11's diff is one clean insertion. If T11 ever wants to name the child shape for the UI, `env.mode` is on the same struct it already reads — that is the seam; note it in the commit body and stop there.

---

## Files

- Modify: `src-tauri/src/agent/worker/protocol.rs` (the enum + two new tests)
- Modify: `src-tauri/src/agent/worker/core.rs` (the production `match`, the stub's mirror, three doc comments, one extended + three new tests)
- Modify: `src-tauri/src/agent/worker/manager/subagent_flow.rs` (the child envelope's mode + the step-4 comment)
- Modify: `src-tauri/src/agent/worker/manager/mod.rs` (the `dispatch_subagent` doc comment only)
- Modify: `src-tauri/src/agent/harness/prompt.rs` (`build_child_system_message`'s doc comment only)
- Modify: `src-tauri/src/agent/harness/loop/tests/tools_enabled.rs` (two comments only — no assertion changes)
- Modify: `src-tauri/src/agent/subagent.rs` (case-4 comment/doc only — no assertion changes)
- Modify: `src-tauri/tests/worker_stdin.rs` (one enum path + one doc line)
- Test: `src-tauri/tests/worker_e2e.rs` (one new `#[tokio::test]`)
- Modify: `docs/decisions/0036-model-hidden-skills.md` (one dated amendment block at the end)

Do NOT touch: `src/bin/fake_worker.rs` (see the site table — it is inert to the new variant, and T12 owns it), `src/agent/worker/manager/tests/mod.rs` (T11/T12 own it; nothing here needs a new manager-level test), `src/agent/session/mod.rs`, `src/agent/harness/launch.rs`, `src/agent/harness/loop.rs`, `src/agent/harness/loop/emit.rs`, `src/agent/harness/compact.rs`, `src/agent/worker/store.rs`, `src/agent/persist.rs`, anything under `src/` (the frontend), `Cargo.toml`, `docs/decisions/0017*`, `docs/decisions/0020*`, `docs/decisions/0025*`.

---

## What to implement

### 1. `worker/protocol.rs` — the third variant

Replace the enum (`protocol.rs:24-36`) with three variants, keeping the derives EXACTLY as they are (`Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize` + `#[serde(rename_all = "snake_case")]` — no `#[serde(other)]`, no `#[serde(untagged)]`, no `deny_unknown_fields` anywhere):

```rust
/// The session-start mode (the `start` envelope's `mode` field): WHICH
/// prompt this session starts from, and the FIRST half of every arm of
/// `default_build_loop`'s init `match`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartMode {
    /// A fresh MAIN session: the Worker builds the main system prompt itself
    /// (the seq-0 transcript row) — ADR 0017.
    Fresh,
    /// A fresh SUBAGENT child (ADR 0017's REDUCED message): the Supervisor has
    /// already computed `build_child_system_message` into `system_prompt`.
    /// `Some` → that message is the seq-0 row; `None` → the child gets NO
    /// system message at all and NO seq-0 row. A child NEVER reaches the
    /// main-prompt arm — that is the whole reason this variant exists
    /// (issue #9: `(Fresh, None)` used to mean both "main session" and
    /// "child with nothing to say", and the child lost that tie to the
    /// largest prompt in the app).
    FreshChild,
    /// A resume: the Supervisor rehydrated the provider transcript (the
    /// `native_messages` re-read) and it arrives in the envelope's `transcript`.
    Resume,
}
```

Wire names: `fresh`, `fresh_child`, `resume` (the enum-level `snake_case` does all three — `StartMode` has no per-variant `rename`, unlike the `Inbound`/`Outbound` discriminators; do not add one).

Add two tests to `protocol.rs`'s `mod tests` (next to `start_env_from_parts_matches_the_inbound_start_variant` at `protocol.rs:866`):

- **E `the_fresh_child_mode_round_trips_as_the_fresh_child_wire_name`** — take `test_env()`, set `mode = StartMode::FreshChild`, encode, and assert the LINE contains the exact substring `"mode":"fresh_child"` (a raw-string check, not just a decoded equality — the wire spelling is the contract, and a rename of the variant must not silently change it), then `decode_inbound` and assert the variant is `FreshChild`.
- **F `an_unknown_start_mode_is_a_decode_error_never_a_silent_main_prompt`** — take the encoded line from E and rewrite `"mode":"fresh_child"` to `"mode":"nonsense"`; assert `decode_inbound(..).is_err()`. The doc comment must say WHY this is the desired direction: the protocol is permissive about unknown `type`s only, and the alternative — a `#[serde(other)]` fallback — would make an unreadable mode SILENTLY become the main-prompt arm, which is the exact defect issue #9 removes. This test is the trap-pin against someone "tidying" the tolerance later.

### 2. `worker/core.rs` — the four arms

Rewrite the init `match` (`core.rs:329-370`) so the two fresh modes share the `Some` arm and differ only on `None`:

```rust
match (&env.mode, &env.system_prompt) {
    (StartMode::Resume, _) => { /* unchanged: load_transcript */ }
    // A Supervisor-computed message — a child's `build_child_system_message`
    // output (`FreshChild`), or any envelope that carries an explicit prompt.
    // One arm for both fresh modes so the seq-0 push has ONE home.
    (StartMode::Fresh | StartMode::FreshChild, Some(sp)) => {
        loop_.prepend_system(sp.clone());
    }
    // THE MAIN PROMPT (ADR 0017) — the main session ONLY. A child arrives as
    // `FreshChild`, so the shape that used to land here (`None` + no todo tool)
    // now prepends NOTHING below; `(Fresh, Some(_))` above stays so the
    // envelope remains total (production's main path always sends `None` —
    // `session/mod.rs` passes it literally).
    (StartMode::Fresh, None) => { /* unchanged body: build_main_prompt + prepend */ }
    // A child with NO reduced message: no launch/definition prompt AND no
    // `manage_todo_list`. It gets NO system message and NO seq-0 row — the
    // first `native_messages` row is the `user` task. Do NOT "fix" this into an
    // empty `prepend_system("")`: every wire folds `System` text and omits the
    // field when it is empty (`provider/types.rs` `system_text`), so an empty
    // row would be a transcript record of a prompt the model never receives,
    // and `run_compaction` would preserve it forever as prompt state.
    (StartMode::FreshChild, None) => {}
}
```

Keep the `agent_dir` / `discover_skills` / `advertised_specs` / `build_main_prompt` body of the `(Fresh, None)` arm byte-identical (only its comment changes). `set_enabled_tools` stays BEFORE the `match` (the `<tools>` section must match the advertised set).

Mirror the same four arms in the test stub `stub_handles` (`core.rs:756`, the init `match` at `:792-803`), where `(Fresh, None)` currently does `loop_.prepend_system("test system prompt".to_string())`. Keep that literal for `(Fresh, None)` (the stub must stay observably different from the `Some` arm, or the stub-based tests cannot tell the two apart), and add `(StartMode::FreshChild, None) => {}`.

### 3. `worker/manager/subagent_flow.rs` — the child sends the new mode

`subagent_flow.rs:614`: `StartMode::Fresh` → `StartMode::FreshChild`. Nothing else in the call changes (`system_prompt` stays the `Option<String>` from step 4; `enabled_tools` stays `Some(child_tools)` VERBATIM; `subagent_enabled` stays `false`). Rewrite the step-4 comment (`:595-597`) so it states the guarantee instead of asserting a hope: "`has_todo_tool` from the resolved child tool list; `None` → the child gets NO system message, and the envelope's `FreshChild` mode is what makes that true — `(Fresh, None)` is the main-prompt arm and a child must never reach it (issue #9)."

### 4. `tests/worker_stdin.rs` — keep the model honest

`subagent_start` (`tests/worker_stdin.rs:77-108`): `StartMode::Fresh` → `StartMode::FreshChild`, and update the doc line above it ("the subagent shape — `Fresh` + a `system_prompt`" → `FreshChild`). Keep `system_prompt: Some(..)` — the test's premise is that handling `start` pushes the seq-0 `transcript-insert` onto `outbound_rx` at the exact moment a >4 KiB `prompt` frame is mid-pipe, and `(FreshChild, None)` would push nothing and make the test prove nothing.

### 5. The tests (write them FIRST; they are the RED)

In `worker/core.rs`'s `mod tests` — the three new ones drive the PRODUCTION builder (`WorkerCore::new(out_tx)` with NO `with_build_loop`), which is what makes them worth writing: today every core test swaps the seam, so the real arm has never been asserted. All three are `#[tokio::test]`, all three call `core.handle(Inbound::from(&env)).await` and then `drain(&mut out_rx)` — no `Prompt` is sent, so the loop just idles and the runtime drops it at test end (the same shape `start_builds_the_loop_and_a_prompt_runs_a_full_turn` already has). Build the env from the existing `test_env(mode, None, sp)` helper (`core.rs:729`) with `enabled_tools: None` — the default builder's `test_env` passes `None` there, which is fine: the assertions below never depend on the tool set.

- **A `a_child_with_a_reduced_message_gets_that_message_and_nothing_else`** — `test_env(StartMode::FreshChild, None, Some("child reduced message".into()))`. Exactly one `TranscriptInsert` frame, `seq == 0`, `role == "system"`, its `content_json` contains `child reduced message`, and it does NOT contain `<tools>` and does NOT contain `<cwd>` (the reduced message is not the main prompt — those two markers are the sections `build_main_prompt` pushes UNCONDITIONALLY, `prompt.rs:63` and `:139`, so the assertion cannot be perturbed by a stray `AGENTS.md` or by a `HOME` another test is mutating).
- **B `a_child_with_no_reduced_message_gets_no_prompt_at_all`** — `test_env(StartMode::FreshChild, None, None)`. Assert `frames.iter().all(|f| !matches!(f, Outbound::TranscriptInsert { .. }))` — no transcript row of ANY seq, hence no seq-0. (Assert "no `TranscriptInsert`", not "the frame list is empty": `prepend_system` is not the only thing that could ever emit here, and a future context frame must not redden this test for the wrong reason.)
- **C `only_the_main_fresh_mode_builds_the_main_prompt`** — `test_env(StartMode::Fresh, None, None)`. There IS a `TranscriptInsert { seq: 0, role: "system" }` and its `content_json` contains `<tools>` AND `<cwd>`. **This is the contrast that keeps B from passing vacuously** — same builder, same `system_prompt: None`, only the mode differs. Do NOT assert on `<project_context>` or `<skills>`: both are conditional on the filesystem (`<project_context>` needs a readable context file, `prompt.rs:86-106`, and `<skills>` needs a skill tool plus a non-empty filtered body, `prompt.rs:121-136`), and the core tests run with `cwd = "/tmp"` and no `ENV_LOCK`, so a presence/absence assertion on those two sections is a false failure waiting for someone's `~/.pi/agent/AGENTS.md`.
- **D** — extend the existing `subagent_worker_system_prompt_is_the_seq_zero_row` (`:1001`, the stub-based pin the issue names) to drive `StartMode::FreshChild` instead of `Fresh`, and say in its doc that it is the STUB mirror of A (cheap to keep honest, and the pair is the reason the stub exists).

In `src-tauri/tests/worker_e2e.rs` — **G `a_child_with_a_tools_list_and_an_empty_body_gets_no_main_prompt`**, the issue's exact inverted path through the REAL binary and the REAL `default_build_loop`:

- Copy the `HOME` isolation from `subagent_dispatch_end_to_end_real_workers` (`:1015-1055`) VERBATIM in spirit: `ENV_LOCK` held across the awaits + `#[allow(clippy::await_holding_lock)]` + the `RestoreHome` drop guard, `HOME` → a fresh temp dir.
- Write `$HOME/.pi/agent/agents/scout.md` with `---\nname: scout\ndescription: Fast recon.\nmodel: fake/sub-model\ntools: [bash]\n---\n` and **nothing after the closing `---`** — that is the empty body (→ `agents.rs:306` → `""` → `launch.rs:264` → `None`). Keep `model: fake/sub-model`: without it the child would run the MAIN wiremock, whose first-stream mock answers a `subagent` tool call and would make the child re-dispatch.
- Two wiremocks exactly like the existing test (`mount_two_request_streams` on the main server: a `subagent` tool call with `"agentName":"scout"` then `all done`; `mount_sse` on the sub server: one text answer), `start_env("e2e-nochildprompt", …)` with `Some(vec!["bash".to_string(), "subagent".to_string()])` and `subagent_enabled: true`, `send_prompt("go")`.
- Wait for `subagent-closed` (the existing `wait_sink` + `started["sessionId"]` pattern gives `child_id`), assert `closed["status"] == "completed"` — **this half of the assertion is what proves "no seq-0" breaks nothing downstream** (the drive settles, the `SubagentCapture` captures, the `SubagentResult` lands, the parent's turn finishes).
- Then `h.db.load_native_messages(&child_id)` and assert:
  - NO row has `role == "system"`;
  - `cv[0]["role"] == "user"` and `cv[0]["content"] == "find the answer"` (the task is the first row — the child's seq 0 belongs to the conversation, not to a prompt);
  - no row's raw JSON contains `<project_context>`, `<tools>` or `<cwd>` — the literal assertion the issue asks for, and the reason the AGENTS.md walk-up never runs for a narrowed child;
  - `child_rows.len() >= 2` (the `user` task + the child's final text) — the guard that keeps "no `system` row" from passing on an EMPTY transcript, which is a different bug (a child that never persisted anything).
  - Do NOT assert an exact row COUNT with `wait_for_rows` (that helper returns as soon as `len >= want`, so a race reads a partial set): wait for the close FIRST (the store frames all land before the child's `agent_settled`, per `worker/manager/pump.rs`'s capture-feed ordering), then load and assert the bullets above without an exact count.

Run order for the RED: tests A/B/C/E/F fail to COMPILE first (`FreshChild` does not exist) — that is the RED and it is an honest one; say so in the commit body rather than implying an assertion failure. G compiles and FAILS (the child's rows contain the `system` main prompt) — G is the one test that can show a real assertion RED before the fix, so run it first if you want visible RED evidence:
`cargo test --test worker_e2e a_child_with_a_tools_list_and_an_empty_body` from `src-tauri/`.

---

## Steps

- [ ] Read, in this order: `src-tauri/src/agent/worker/protocol.rs:1-40` + `:195-250` + `:340-375` (the tolerance rules), `src-tauri/src/agent/worker/core.rs:1-11` + `:240-375` + `:720-810` + `:860-1020`, `src-tauri/src/agent/worker/manager/subagent_flow.rs:560-650`, `src-tauri/src/agent/harness/prompt.rs:44-165`, `src-tauri/src/agent/harness/loop.rs:415-455`, `src-tauri/src/agent/harness/loop/emit.rs:80-125`, `src-tauri/src/agent/harness/compact.rs:415-500`, `src-tauri/src/bin/fake_worker.rs:540-580`, `src-tauri/tests/worker_e2e.rs:1015-1310`, `src-tauri/tests/worker_stdin.rs:70-110`, and `docs/decisions/0036-model-hidden-skills.md` (the bullet at line 31 + the existing Amendment block's shape). Trust the tree over this plan if they disagree — and say so in the report.
- [ ] Write tests A, B, C (in `worker/core.rs`'s `mod tests`) and E, F (in `protocol.rs`'s `mod tests`). Run `cargo test --lib agent::worker` from `src-tauri/` → it must fail to compile with `no variant, constant, or function named FreshChild` (or the `E0599`/`E0574` shape). If it compiles, you wrote a test that cannot fail — stop and look.
- [ ] Write test G in `tests/worker_e2e.rs` (before the fix). Run `cargo test --test worker_e2e a_child_with_a_tools_list_and_an_empty_body` → it must FAIL with the child carrying a `system` row whose content names `<project_context>`/`<tools>`. That is the issue reproduced in CI terms. If it passes, your agent file has a non-empty body or your `tools:` list still contains `manage_todo_list` — check both before touching code.
- [ ] Implement §1 (`protocol.rs`), §2 (`core.rs`'s production `match` + the stub mirror), §3 (`subagent_flow.rs`), §4 (`worker_stdin.rs`).
- [ ] `cargo test --lib agent::worker` → green (the new tests plus every pre-existing `worker::` test). Note which is which before believing a green: `start_builds_the_loop_and_a_prompt_runs_a_full_turn` and `subagent_worker_system_prompt_is_the_seq_zero_row` run on the STUB builder (`stub_core()`), so they only move if you change the stub's mirror; the three new ones run on the PRODUCTION builder, so they are the only core tests that assert the real arm.
- [ ] `cargo test --test worker_e2e` (all four e2e tests + yours) → green. The pre-existing `subagent_dispatch_end_to_end_real_workers` MUST stay green untouched: its `scout.md` has a non-empty body, so its child keeps its reduced message and its `system + user + assistant` three-row shape (`worker_e2e.rs:1266-1300`). If that test reddens, you changed the `Some` arm, not just the `None` one.
- [ ] `cargo test --test worker_stdin` and `cargo test --test worker_stderr` → green (the stdin test is the pipe-bound race; a red there means the seq-0 push moved out of the `start` handler).
- [ ] Fix every comment/doc named in §"Comments and docs" (the two `core.rs` ones, `subagent_flow.rs`, `manager/mod.rs`, `prompt.rs`, the two in `loop/tests/tools_enabled.rs`, `subagent.rs`'s case 4) and add the amendment block to `docs/decisions/0036-model-hidden-skills.md`. `cargo fmt` after the doc edits (a doc-comment rewrap is the most common fmt red on a task like this).
- [ ] `cargo fmt --all -- --check` from `src-tauri/`.
- [ ] `cargo clippy --all-targets -- -D warnings` from `src-tauri/` → **0 warnings**. Watch for: `unused_imports` if a `StartMode` import becomes unnecessary anywhere, and `wildcard_imports`/`match_same_arms` (if clippy suggests collapsing `(Fresh, None)` and `(FreshChild, None)` into one arm, it is wrong — the two arms differ DELIBERATELY; keep them separate and let the comment say why; do not add an `#[allow]`).
- [ ] FULL gate from `src-tauri/`: `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`; from the repo root: `pnpm test`, `pnpm build`.
  - Baseline not to regress (the parent roadmap's CURRENT figures): Rust **1369 passed / 0 failed / 4 ignored**, clippy 0 warnings, fmt clean, FE **3051 tests / 149 files**, build exit 0.
  - Expect Rust **1375** (+6: A, B, C, E, F, G — the extended D rewrites an existing test and adds no count). Land on 1374 and one of A/B/C/E/F/G never registered; land on 1376+ and you added a test this plan did not ask for. (`agent::hostenv`'s count is platform-split, 16 Linux / 7 elsewhere — that is pre-existing and unrelated; the figure above is the Linux number the parent roadmap records.)
  - `pnpm` must be BYTE-IDENTICAL (3051 / 149) — this task touches no frontend file and adds no field to any payload the frontend reads. A frontend delta means something leaked into the `subagent-session-started` payload; revert it (that block belongs to T11).
- [ ] Commit with message: `fix(worker): a child with no reduced message gets NO prompt, never the main one (#9)`

---

## Acceptance criteria

- [ ] `StartMode::FreshChild` exists and is the ONLY mode `subagent_flow.rs` sends; `session/mod.rs` still sends `Fresh`/`Resume`; `StartEnv.system_prompt` is still `Option<String>` and the `systemPrompt` wire field is unchanged (so `fake_worker.rs`, `subagent.rs`'s four-case envelope test and `harness_dispatch_native.rs`'s `systemPrompt` assertions are untouched and green).
- [ ] A child with a reduced message gets exactly that message as its seq-0 row and NO `<tools>`/`<cwd>` in it (test A, plus the existing stub pin D and the untouched `worker_e2e` subagent test's (e) block).
- [ ] A child with NO reduced message gets NO system message: no `TranscriptInsert` at any seq from the `start` handler (test B) and no `system` row in its persisted transcript, whose first row is the `user` task (test G).
- [ ] The exact inverted path — a definition with `tools:` excluding `manage_todo_list` and an empty body — produces a child whose transcript contains no `<project_context>`, `<tools>` or `<cwd>` anywhere (test G), and the child still completes (`subagent-closed` `status: "completed"`).
- [ ] A main session still gets the full main prompt as its seq-0 row (test C + the pre-existing `start_builds_the_loop_and_a_prompt_runs_a_full_turn`), i.e. the fix removed a fall-through, not the feature.
- [ ] The wire spells the mode `fresh_child` and an unreadable `mode` is a decode ERROR, never a silent main prompt (tests E, F); no `#[serde(other)]` was added anywhere in `protocol.rs`.
- [ ] Both stale comments are gone (`worker/core.rs`'s "NOT main-session-only in practice" and `subagent_flow.rs`'s "the child's seq-0 row is absent" — the second now backed by the mode, not by hope), and `harness/prompt.rs`, `worker/manager/mod.rs`, the two `loop/tests/tools_enabled.rs` comments and ADR 0036 no longer claim a child can receive the main prompt.
- [ ] `subagent-session-started`'s payload is byte-identical (no new field) and no frontend file changed; `pnpm test` is 3051/149 and `pnpm build` exits 0.
- [ ] `cargo test` 1375 / 0 failed / 4 ignored, `cargo clippy --all-targets -- -D warnings` 0 warnings, `cargo fmt --all -- --check` clean.

---

## Recorded, not fixed here

- **The child's first model call now has no system prompt at all** for that one shape, so a narrowed child gets zero instructions — no role, no "be concise", nothing. That is the intended reading of ADR 0017 (a child is shaped by its `systemPrompt`, and a parent that gives it neither a prompt nor the todo tool has said "no instructions"), and it is the cheapest correct fix. The alternative — a THIRD message kind ("you are a subagent, be concise") for the empty case — would be a new prompt shape with no ADR behind it, and it would re-introduce a prompt the issue calls for removing. If a follow-up wants child instructions, it is a decision, not a bugfix: write the ADR first.
- **No `mode` echo in the `fake_worker` fixture.** The supervisor-side tests could pin the child env's `mode` directly if `fake_worker.rs:559-568` echoed it, but that file is T12's, the value is already pinned behaviourally by G (only `FreshChild` avoids the main prompt), and the wire spelling is pinned by E. Handed to T12 if it wants the extra assertion.
- **No manager-level unit test for the child env's mode.** `dispatch_subagent` builds the envelope inline (`subagent_flow.rs:611-624`); exposing it as a `child_start_env(...)` seam would take 8 parameters to assert one field, and `manager/tests/mod.rs` is T11/T12's file. The e2e (G) is the honest observation point.
- **The mixed-version wire hazard is real but unreachable.** An old Worker handed `"mode":"fresh_child"` drops the `start` line and the child hangs to the Dead bound; the self-exec pairing (`current_exe()` + `--worker`) makes the pair always one build. Stated rather than coded around, because the only mitigation — `#[serde(other)]` — would re-create this task's defect.
- **T11's seam:** `subagent_flow.rs:625-645` (the `subagent-session-started` `json!`) is deliberately untouched here; T11 adds its resolve-miss marker there and can read `env.mode` from the same struct if it needs the child shape.
