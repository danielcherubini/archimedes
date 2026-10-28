---
status: committed
done-when: "`PermissionOutcome::Selected { option_id, value }` ships serde-defaulted with the attribute PAIR `#[serde(default, skip_serializing_if = "Option::is_none")]` on `value` — a `None` omits the key (`{"selected":{"option_id":"allow"}}`, byte-identical to today's wire; bare `default` would serialize `"value": null`) — and every construction/match site in the crate (lib, bin, AND `tests/` integration tests — the two files `cargo test --lib` never compiles) compiles and tests green; the permission prompt's option list is built per-prompt by a pure helper — boundary prompts emit exactly the old three options without `path`, guard prompts emit exactly allow / allow-directory (with `path`) / reject and NEVER `trust-space`; `gate_tool`'s approve predicate accepts `allow` and `trust-space` (and, at T03, `allow-directory` — see `## Out of scope` and the T03 loud pin `a_guard_allow_directory_runs_the_tool`) against the `..`-patterned matching; a `Selected` serialized WITHOUT `value` still deserializes and serializes WITHOUT the key; the crate compiles, all tests green (full suite, not just `--lib`), clippy 0 warnings, fmt clean, mingw check clean."
parent: docs/roadmap/permissions-section.md
---

# Plan — T02: `PermissionOutcome::Selected { option_id, value }`, per-prompt option lists, the approve predicate, drop `trust-space` from the guard prompt

**Goal:** Make the permission outcome carry the wire `value` the frontend already echoes back, make the prompt's option list per-prompt instead of always-three, and remove `trust-space` from the guard prompt.
**Architecture:** One Rust enum change (`PermissionOutcome::Selected` gains `value: Option<String>`, serde-defaulted) plus a pure option-builder (`permission_options`) whose callers (`native_permission_gate`, and at T03 the guard) pick boundary vs guard sets. No enforcement moves in this task — verdict wiring that reaches the guard is T03.
**Tech Stack:** Rust 2021, serde, `serde_json::json!`, `tokio`. ONE compilation unit (`archimedes`).

---

## Parallelisation

**Verdict:** SERIAL — this is a single task (consumed-mode plan); the run's parallelism is between tasks, in the waves `roadmap` owns. Recorded for the executor: no `**Parallel:**` line exists because there is nothing to parallelise with; the wave grouping is the orchestrator's call.

---

## Context: what this task is, and what it is not

The approved spec (`docs/roadmap/permissions-section.md`) makes the self-modification guard an **ask**: when no rule matches a write into an agent-definition dir, the gate must prompt instead of silently denying. T02 is a **shape-and-prompt** task on the permission wire — **not** enforcement:

- `PermissionOutcome::Selected` gains `option_id: String, value: Option<String>` (the UI's `PermissionOption.path` rides as `value`; `PermissionPrompt.tsx` already echoes it — wave 1 landed the frontend half). `value` is `#[serde(default, skip_serializing_if = "Option::is_none")]` — the PAIR, both halves: `default` makes already-serialized old outcomes (no `value`) still parse, and `skip_serializing_if = "Option::is_none"` keeps a `None` OFF the wire (`{"selected":{"option_id":"allow"}}`, byte-identical to today's — bare `default` alone would serialize `"value": null` and break the byte-pin).
- The prompt builder picks option lists **per-prompt** — today it always emits three options including `trust-space`, with a comment asserting that is always correct because "a prompt only ever appears for an untrusted Space". That assumption dies: a **guard** prompt can appear on a **trusted** Space (trust suppresses asks by definition, so a guard ask implies untrusted — but the guard's *prompt* is exactly the ask T03 wires). The guard's options are `allow` / `allow-directory` (carrying `path`) / `reject`, and **`trust-space` is deliberately absent**:
  > the guard protects the agent's own instruction directories, and its third option today is a one-click permanent way to disable that protection — the most likely click when a prompt recurs. Deliberate trust stays available from Space settings; accidental trust does not.
  That sentence is load-bearing and must live as a code comment next to the guard option list.
- `gate_tool`'s approve predicate (`gate.rs`) currently reads `matches!(outcome, Selected { option_id } if option_id == "allow" || option_id == "trust-space")` — it must compile against the new variant and keep approving the boundary ids. Its relationship to `allow-directory` is a *boundary claim* (see below), because whether a guard prompt can reach `gate_tool` in THIS tree is itself load-bearing.

### What T02 does NOT do (the hand-off markers)

- **No wiring of rules into the verdict.** `decision_for` was deliberately NOT extended by T01, so `gate.rs::policy_verdict` still compiles unchanged today, and at T02's HEAD a write targeting a protected dir is STILL refused with NO prompt: under the default `writes: Allow` posture the write DISPATCHES and the **executor's** `protected_refusal` (`tools/exec/fs_tools.rs` — `write`/`edit` lines ~101/148) refuses it; under `Sandboxed` the **gate's** `deny_tool_result` (`loop/gate.rs` line ~166) does. Neither path prompts, and both are T03's to convert; the guard ask becomes reachable only when **T03** wires `rule_for` into `policy_verdict`. T02 therefore cannot end-to-end "show the guard prompt" — the pin for the guard options must live on the pure builder.
- **No persistence.** `session/mod.rs` is **NOT in T02's Owns set** (T04 owns the relay that persists a rule). T02 makes the shape carry `value`; it does not write it. The `value`'s destination (T04's `allow-directory` rule append) is out of scope here. See `## Blocker` for the one `session/mod.rs` edit T02's shape change *forces*.
- **No executor/`access.rs`/`sandbox.rs` change** (T03).

---

## Current state of the tree (grounded at `6fd3740`)

Wave 1 landed `c90f5dd` (T01) + `6fd3740` (T05). Verified facts the plan builds on:

- `src-tauri/src/agent/permission.rs`:
  - `pub enum PermissionOutcome` (line ~50): `#[serde(rename_all = "snake_case")]`, variants `Selected { option_id: String }` and `Cancelled`. Wire shape `{"selected":{"option_id":"…"}}` / `"cancelled"`.
  - `pub async fn native_permission_gate(session_id: &str, request_id: &str, title: &str, sink: &Arc<dyn EventSink>, pending_permissions: &PendingPermissions, trust: Option<&dyn TrustSource>, cwd: &std::path::Path, cancel: &CancellationToken) -> PermissionOutcome` — contains the trusted auto-approve (`Selected { option_id: "allow" }`, line ~160) and the prompt emitter (line ~186) whose comment asserts "always three options … so `trust-space` is always actionable" and whose `json!` has the three options inline.
  - Six inline tests construct the enum (`an_unanswered_permission_prompt_never_settles_on_a_clock`, `native_gate_trusted_space_auto_approves`, `native_gate_untrusted_prompts_and_maps_the_outcome`, `native_gate_trust_space_allows_without_writing_the_flag` ×2 each, `native_gate_cancel_is_a_denial`); two pin the three-option list / `trust-space`.
- `src-tauri/src/agent/harness/loop/gate.rs` (`pub(super) async fn gate_tool`): the ONLY native match site — `matches!(outcome, PermissionOutcome::Selected { option_id } if option_id == "allow" || option_id == "trust-space")`.
- `src-tauri/src/agent/worker/core.rs` (`WorkerCore::handle`, `Inbound::PermissionResponse` arm): `if let PermissionOutcome::Selected { option_id } = &outcome` (line 630) + two tests constructing the enum.
- `src-tauri/src/agent/worker/client.rs`: `send_permission_response(&self, id: &str, outcome: &PermissionOutcome)` (pass-through, no change needed) + one test constructing `Selected` (line 1215).
- `src-tauri/src/agent/worker/protocol.rs`: `PermissionOutcome` is the field type directly (rides the wire via its own serde attrs — no wrapper), the `decode_inbound` allow-list keeps `"permission-response"` (no change needed), one round-trip test constructs `Selected { option_id: "trust-space" }` (line 546).
- `src-tauri/src/agent/worker/manager/tests/mod.rs`: one construction (`an_answered_gates_card_is_not_closed_again_at_teardown`, line 1918).
- `src-tauri/tests/worker_e2e.rs` (`permission_round_trip_real_worker`): **CONSTRUCTS** `&PermissionOutcome::Selected { option_id: "allow" }` (line 810 — passed to `send_permission_response`). NOT `#[ignore]`d (verified: no `#[ignore]` in the file). Lives in the `tests/` tree — **`cargo test --lib` does NOT compile it**; only the full `cargo test` does.
- `src-tauri/tests/harness_loop.rs` (`tool_call_gates_executes_loops_and_settles`): **CONSTRUCTS** `PermissionOutcome::Selected { option_id: "allow" }` (line 435 — resolved into `PendingPermissions`). NOT `#[ignore]`d (verified: no `#[ignore]` in the file). The `value: None` edit is the ONLY change it needs — it never destructures the outcome.
- `src-tauri/src/agent/session/mod.rs` (`SessionManager::respond_permission`): **DESTRUCTURES** — `if let permission::PermissionOutcome::Selected { option_id } = &outcome` (line 1937) — the **boundary** file, see `## Blocker`.
- `src-tauri/src/commands/sessions.rs`: `pub async fn respond_permission(state: State<'_, Arc<SessionManager>>, session_id: String, request_id: String, outcome: PermissionOutcome) -> Result<(), crate::agent::SessionError>` — by-value parameter, deserialize-only; needs NO edit beyond a doc word if desired.
- `src-tauri/src/agent/mod.rs`: `pub use permission::{permission_key, PendingPermissions, PermissionOutcome};` — the re-export does NOT change.
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`: helper `answer_permission` (line ~107) constructs `Selected { option_id: option.to_string() }`.
- `src-tauri/src/bin/fake_worker.rs`: the `"__permission__"` arm emits the three options verbatim in the canned `PermissionRequest` payload (`// mirroring permission.rs:135-158`); its parse loop only ever tests `matches!(m2, Inbound::PermissionResponse { .. })` — the fixture decodes `PermissionResponse` generically and never matches on `option_id` (and emits the BOUNDARY list, which is byte-identical this wave). **Visibility question settled, do NOT revisit:** `fake_worker` is a SEPARATE bin crate linked against `archimedes_lib`, `permission` is a PRIVATE module of `agent` (no `pub` path to `permission_options`), so a `pub(crate)` builder is NOT nameable from the fixture — the literal stays (finding 5). The drift risk is genuinely low: the boundary list is unchanged this wave and the fixture never inspects `value`.
- **Second and further verbatim copies of the three-option payload**, all of which a prompt-shape change must keep in step: `worker/sink.rs`'s `permission_request_maps_to_the_frame_with_the_payload_verbatim` (asserts `options.len() == 3` + option 0 `allow` + option 2 `trust-space` when resolved directly in `worker/client.rs`'s `a_permission_response_round_trip_completes_the_canned_flow`), `worker/protocol.rs`'s `every_outbound_variant_round_trips` canned `permission_payload`, `bin/fake_worker.rs`'s canned options. There is **no Rust struct** for the prompt payload — every copy is a `json!` literal, so a prompt-shape change is a multi-site edit.
- T01-landed vocabulary in `src-tauri/src/agent/policy.rs` (read-only for T02 — may only be *called*): `FilePolicy` (with `rules`, serde-defaulted, `NOT Copy`), `AccessRule { path: String, direction: RuleDirection, decision: RuleDecision }`, `enum RuleDirection { Read, Write, ReadWrite }`, `enum RuleDecision { Allow, Deny }`, `pub fn rule_for<'a>(rules: &'a [AccessRule], direction: RuleDirection, path: &Path, home: Option<&Path>) -> Option<&'a AccessRule>`, `pub fn default_rules() -> Vec<AccessRule>`, `pub fn canonicalize_lenient(path: &Path) -> PathBuf` (in `agent/fs_backend.rs`, **`pub(crate)`** — and `agent/fs_backend.rs` is NOT in T02's Owns set; nothing in T02 needs it anyway).
- The gate's protected-deny today: `deny_tool_result` consults `self.protected` (`AgentLoop::protected`, frozen once per session, `loop.rs` ~line 325) via `protected_refusal_text` for the `Write` direction. `policy_verdict` does NOT consult rules (T01 left `decision_for` untouched by design).

---

## The design decisions, stated

**D1 — The variant is `Selected { option_id: String, value: Option<String> }` with the attribute PAIR `#[serde(default, skip_serializing_if = "Option::is_none")]` on `value`, and NO `#[non_exhaustive]`.**
The serde-default is the crate's own backward-compat precedent, `SubagentOutcome::Failed`'s `reason` / `output` / `metrics` (`worker/protocol.rs`'s `a_failed_subagent_result_in_the_old_shape_still_decodes` — the field is literally named `value` there too). `skip_serializing_if = "Option::is_none"` is the SECOND, equally load-bearing half: `default` governs DESERIALIZATION only, and bare `default` alone would serialize `value: None` as `"value": null` — NOT the byte shape this plan pins. The pair is the crate's own convention for optional payload fields (`mcp/oauth.rs` lines ~45-54, `harness/ask.rs` lines ~247-252, `harness/provider/types.rs`). With the pair: old payload `{"selected":{"option_id":"allow"}}` is the EXACT byte image of a fresh `Selected { option_id: "allow", value: None }` — the plan's `a_selected_without_value_serializes_without_the_key` and the "payload byte-identical to today's wire" claim are consistent. The deliberate counter-example is `SubagentDispatch::name_resolution` (deliberately NOT defaulted — "every default for this field is a LIE"). `value`'s default (`None`) is not a lie: it is the honest "no directory carried", and `None` is exactly what the boundary prompt produces. Keep `PartialEq, Eq` (the tests compare outcomes by value) — `Option<String>` keeps all of those. Keep the enum-level `#[serde(rename_all = "snake_case")]`; the wire key for the payload stays exactly `{"selected":{"option_id":"…","value":"…"}}` — `selected` is the variant key, `option_id` / `value` fields inside it (pinned by the wave-1 frontend report and `permission-wire` §6).

**D2 — A pure `permission_options` builder carries the per-prompt lists; `native_permission_gate` calls it.**
There is no Rust struct for the prompt payload, so the "one struct to change" option does not exist. The cheapest honest shape: a `pub(crate) fn permission_options(boundary: bool) -> Vec<Value>` (or `Vec<serde_json::Map<String, Value>>`) whose `boundary: true` branch returns the old three options byte-for-byte (no `path`) and whose `boundary: false` branch returns the guard's three (`allow` "Allow once", `allow-directory` "Always allow this directory" carrying `"path"`, `reject` "Block") with a comment carrying the spec's trust-space rationale. `native_permission_gate` becomes the ONLY production caller, and its `json!` consumes `permission_options(true)`. The builder's test pins the three options of EACH kind (these are the only pins reachable in T02's tree — the guard list cannot be reached end-to-end until T03 wires the guard ask, and even T03 cannot reach it through `gate_tool` until the verifier routes protected writes to Ask; see `## Code comment: the guard-prompt seam`).

**D3 — `gate_tool`'s approve predicate becomes `matches!(outcome, PermissionOutcome::Selected { option_id, .. } if option_id == "allow" || option_id == "trust-space")`.**
The `..` accepts the new field. Two facts about this predicate, both load-bearing for the vet:
- **Accepting `trust-space` stays** — the option is still in the BOUNDARY list and the mid-session flip loop (`worker/core.rs`) + the Supervisor persist (`session/mod.rs`, T04) still key on it. Removing it here would break `native_gate_trust_space_allows_without_writing_the_flag`.
- **`allow-directory` is NOT added here.** Adding it to the allow set at T02 would dispatch the tool that triggered a protected write — but at T02's HEAD that write never reaches the gate (see the postures in §Context — executor `protected_refusal` or gate `deny_tool_result`), so "approve" is unreachable; and the identical avoid-the-crash reasoning from `## Blocker` should be recorded, not half-done: the honest home for the `allow-directory` bit is T03, whose contract MUST include (1) the predicate extension AND (2) the ONE named loud pin `a_guard_allow_directory_runs_the_tool` (see `## Out of scope`). This plan therefore records it as a **commit-time requirement**: the plan review's gate is about compilation, and `allow-directory`'s absence neither breaks compilation nor changes any test — but T03's plan MUST extend the predicate and land the pin, and this boundary claim is the marker that says so.

**D4 — Serde round-trip pins are added at the type, following the `SubagentOutcome::Failed` model.**
`before_value_selected_still_deserializes` + `a_selected_with_value_round_trips` + `a_selected_without_value_serializes_without_the_key` live in `permission.rs`'s inline tests (where the decode precedent's sibling lives in `protocol.rs`). The crate-wide pin that the wire shape is `{"selected":{"option_id":"…","value":"…"}}` is `every_inbound_variant_round_trips` (protocol.rs) gaining a `Selected { option_id, value: Some }` case, and `before_value` gains a `Selected { option_id, value: Some }` companion. The decode mechanics, stated precisely (finding 4): `permission-response` is in `decode_inbound`'s EXPLICIT allow-list (`protocol.rs` line ~395 — `| "permission-response" ... from_value(...).map_err(|e| ProtoError::Json(e.to_string()))`), NOT the permissive `Unknown { raw }` fallback — so a missing `option_id` (or any structural mismatch) is a hard `ProtoError::Json`; but a missing `value` is NOT an error, exactly the field `#[serde(default)]` exists to absorb — it decodes to `None`. `option_id` has NO default and never will: a `permission-response` without it is a hard `ProtoError::Json`, the direction the `SubagentOutcome` precedent guards.

**D5 — The option-builder is `pub(crate)`, not `pub`.**
Only `permission.rs` (and its tests) need it. `pub` would leak a prompt-list builder as if it were API.

---

## The complete `Selected` site census (re-grepped at `5bdbca3`)

`grep -rn "Selected" src-tauri/src src-tauri/tests --include=*.rs` — the FULL list, split by kind. This is the authoritative site list; S5 follows it exactly.

**CONSTRUCTION sites (`PermissionOutcome::Selected { … }` built — must each gain a `value:` field):**

| # | File:line | Site | Compiles in `--lib`? |
|---|-----------|------|----------------------|
| 1 | `src/agent/permission.rs:160` | trusted auto-approve `Selected { option_id: "allow" }` (prod code) | yes |
| 2 | `src/agent/permission.rs:372/381` | `an_unanswered_permission_prompt_never_settles_on_a_clock` (×2) | yes |
| 3 | `src/agent/permission.rs:441` | `native_gate_trusted_space_auto_approves` | yes |
| 4 | `src/agent/permission.rs:507/513` | `native_gate_untrusted_prompts_and_maps_the_outcome` (×2) | yes |
| 5 | `src/agent/permission.rs:564/570` | `native_gate_trust_space_allows_without_writing_the_flag` (×2) | yes |
| 6 | `src/agent/harness/loop/tests/policy_gate.rs:117` | `answer_permission` helper | yes |
| 7 | `src/agent/worker/client.rs:1215` | `a_permission_response_round_trip_completes_the_canned_flow` | yes |
| 8 | `src/agent/worker/core.rs:1196/1206` | `permission_response_resolves_the_pending_oneshot` (×2) | yes |
| 9 | `src/agent/worker/core.rs:1245` | `permission_response_trust_space_flips_the_trust_source` | yes |
| 10 | `src/agent/worker/manager/tests/mod.rs:1918` | `an_answered_gates_card_is_not_closed_again_at_teardown` | yes |
| 11 | `src/agent/worker/protocol.rs:546` | `every_inbound_variant_round_trips` | yes |
| 12 | `tests/worker_e2e.rs:810` | `permission_round_trip_real_worker` — **`cargo test --lib` does NOT compile it** | **NO — full suite only** |
| 13 | `tests/harness_loop.rs:435` | `tool_call_gates_executes_loops_and_settles` — **`cargo test --lib` does NOT compile it** | **NO — full suite only** |

**DESTRUCTURE sites (pattern-sites that must gain `..`; constructions above do NOT need `..`):**

| # | File:line | Site |
|---|-----------|------|
| D1 | `src/agent/session/mod.rs:1937` | `if let permission::PermissionOutcome::Selected { option_id } = &outcome` — the Blocker line (the `## Blocker` extension owns its `..`; everything else in the file is read-only) |
| D2 | `src/agent/worker/core.rs:630` | `if let PermissionOutcome::Selected { option_id } = &outcome` (prod, Worker `handle`) |
| D3 | `src/agent/harness/loop/gate.rs:237` | `matches!(outcome, PermissionOutcome::Selected { option_id } if …)` — needs `{ option_id, .. }` |

No other sites exist (verified by re-grep, including comment/doc occurrences, which are NOT sites — e.g. the doc strings in `permission.rs:14/17/23/123/126`, `client.rs:592`, `core.rs:1180/1221`, `protocol.rs:85/524`, `session/mod.rs:1904`, `worker_e2e.rs:709/803`).

---

## Code comment: the guard-prompt seam

The guard's option list must exist at T02 even though the guard ask is wired in at T03 — and it needs the spec's rationale as a comment:

> The guard prompt offers ONE kind of option list: `allow` / `allow-directory` (carrying the resolved path as `path`) / `reject`. **`trust-space` is deliberately absent here.** Trust still suppresses the guard — trusting a Space from Space settings silences it, consistent with the precedence table. What is removed is the shortcut INSIDE the guard's own prompt: a one-click, permanent way to disable the protection the prompt exists to provide — the most likely click when a prompt recurs. Deliberate trust stays available; accidental trust does not. (Boundary prompts, which ask about the user's own files beyond the read boundary, keep `trust-space`.)

The call site comment in `gate_tool` (the seam) becomes:

> The guard ask (T03) reaches `gate_tool` ONLY if the precedent wiring sends protected writes to `Ask` — that verdict is T03's. When it does, the prompt offers `allow` / `allow-directory` / `reject`, and `allow-directory` must become an allow id HERE — T03's contract names the loud pin `a_guard_allow_directory_runs_the_tool` (the value rides to the Supervisor, which persists it — T04). Both extensions are recorded in T02's plan; this gate stays boundary-only until they land.

---

## Files

**Owned (the ONLY files this task may modify):**

- Modify: `src-tauri/src/agent/permission.rs`
- Modify: `src-tauri/src/agent/harness/loop/gate.rs`
- Modify: `src-tauri/src/agent/worker/sink.rs`
- Modify: `src-tauri/src/agent/worker/protocol.rs`
- Modify: `src-tauri/src/agent/worker/client.rs`
- Modify: `src-tauri/src/agent/worker/core.rs`
- Modify: `src-tauri/src/agent/worker/manager/tests/mod.rs`
- Modify: `src-tauri/src/bin/fake_worker.rs`
- Modify: `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`
- Modify: `src-tauri/src/commands/sessions.rs` (only if a doc word changes — the parameter binding itself needs NO edit; see Step 7)
- Modify: `src-tauri/tests/worker_e2e.rs` — the ONE `value: None` at `permission_round_trip_real_worker` (line ~810); **absorbed per finding 1** — S5 compiles it.
- Modify: `src-tauri/tests/harness_loop.rs` — the ONE `value: None` at `tool_call_gates_executes_loops_and_settles` (line ~435); **absorbed per finding 1** — S5 compiles it.
- **Extend-Owns (one file):** `src-tauri/src/agent/session/mod.rs` — ONE line (the destructure `..`), see `## Blocker`. The two `tests/` files are listed as **Modify** above (absorbed per finding 1), not as Extend-Owns — absorption into the Owns set is exactly what the finding asked for.
- UNCHANGED: `src-tauri/src/agent/mod.rs` (the re-export does not change — verified: `pub use permission::{permission_key, PendingPermissions, PermissionOutcome};` names the type, not its fields)

**Read-only (inside the Owns/blocker set, not modified):** `src-tauri/src/agent/harness/loop.rs` (the `protected` field + `AgentLoop::new`), `src-tauri/src/agent/harness/loop/turn.rs` (the `gate_tool` call site — no edit), `src-tauri/src/agent/session/mod.rs` (ALL lines EXCEPT the `## Blocker` destructure line — the blocker line is the ONE line T02 edits), `src-tauri/src/agent/policy.rs` (T01's vocabulary — read-only for T02).

**NOT in the Owns set, NOT touched:** `src-tauri/src/agent/fs_backend.rs` (T02 needs nothing from it; `canonicalize_lenient` is `pub(crate)` there anyway), `src-tauri/src/agent/boundary.rs`, `src-tauri/src/agent/tools/exec/*`, `src-tauri/src/config.rs`, everything frontend.

If any other `PermissionOutcome` construction or `Selected` match is found during execution (a `grep -rn "Selected" src-tauri/{src,tests} --include=*.rs` that names a file outside this set), STOP and report — do not edit outside the set.

**The grep and STOP rule, split by kind (finding 1):**
- **Constructing** a `Selected` is: an expression that BUILDS `PermissionOutcome::Selected { … }` (the `Selected {` token pair). These MUST each gain `value: …` — missing one breaks THE FULL SUITE even when `--lib` is green, because `tests/` is not in `cargo test --lib`'s build. This is a **compile-blocker** outside the set.
- **Destructuring** a `Selected` is: a pattern (`match` / `if let`) that tears it apart (`Selected { option_id }` — `src/session/mod.rs:1937`, `worker/core.rs:630`). Patterns that bind `option_id` but NOT `value` must gain `..`. Missing one is a **compile-blocker** outside the set. Patterns the new field does NOT disturb are NOT sites (`matches!` with `_` or ref-to-field patterns keep working unchanged).
- At `src/session/mod.rs:1937` BOTH apply simultaneously (one line: `if let` destructure), and the Blocker owns it — never treat a destructure and a construction as interchangeable.

---

## What to implement

### 1. `PermissionOutcome` (## permission.rs)

```rust
/// The user's decision on a permission prompt, as chosen via the
/// `respond_permission` Tauri command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOutcome {
    /// The user selected one of the offered options; `option_id` is its id
    /// and `value` is the option's optional payload (`path` — copied back
    /// verbatim by the frontend).
    Selected {
        option_id: String,
        /// The option's payload (`path` for `allow-directory`). The serde
        /// PAIR: `default` (a previously-serialized outcome — one with NO
        /// `value` — still parses; `SubagentOutcome::Failed` model; the
        /// deliberate contrast is `SubagentDispatch::name_resolution`,
        /// which refuses defaults because every default for it is a LIE —
        /// `None` here is not a lie, it is the honest "no directory") +
        /// `skip_serializing_if = "Option::is_none"` (`None` OMITS the key
        /// on the wire — byte-identical to today's `{"selected":{…}}`,
        /// which bare `default` alone would NOT be: it would serialize
        /// `"value": null`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    /// The user dismissed the prompt (or the turn / session was cancelled).
    Cancelled,
}
```

The variant `Selected { option_id: String, value: Option<String> }`; `value` carries the attribute PAIR `#[serde(default, skip_serializing_if = "Option::is_none")]`. Black-box: old payload `{"selected":{"option_id":"allow"}}` parses to `value: None` (via `default`) AND a fresh `value: None` serializes back to exactly that (via `skip_serializing_if`) — the round is byte-identical; new payload `{"selected":{"option_id":"allow-directory","value":"/home/u/.pi/agent/agents"}}` parses to `value: Some(…)`; the enum's serde attrs are THE wire shape (`protocol.rs` uses no wrapper).

### 2. The per-prompt option builder (## permission.rs, next to `native_permission_gate`)

```rust
/// The `options` array of a `permission-request` payload, per prompt kind.
/// `boundary: true` — the old three (`allow` "Allow" / `reject` "Block" /
/// `trust-space` "Don't ask again for this Space"), byte-identical to the
/// pre-per-prompt shape; `boundary: false` — the GUARD's three (`allow`
/// "Allow once" / `allow-directory` "Always allow this directory" carrying
/// its `"path"` / `reject` "Block"). A prompt is one kind or the other
/// (the old claim — "always three options, since a prompt only ever appears
/// for an untrusted Space, so `trust-space` is always actionable" — breaks
/// the day the guard prompts: a guard ask is an ask, and an ask can appear
/// for a Space that is trusted enough to make `trust-space` a one-click way
/// to disable the protection the prompt exists to provide).
pub(crate) fn permission_options(boundary: bool) -> Vec<serde_json::Value> {
    if boundary {
        vec![
            json!({ "optionId": "allow", "name": "Allow", "kind": "allow" }),
            json!({ "optionId": "reject", "name": "Block", "kind": "reject" }),
            json!({ "optionId": "trust-space", "name": "Don't ask again for this Space", "kind": "allow" }),
        ]
    } else {
        vec![
            json!({ "optionId": "allow", "name": "Allow once", "kind": "allow" }),
            // THE guard's distinctive option: `allow-directory` carries the
            // resolved path as `path` (echoed back by the frontend as the
            // outcome's `value`). `trust-space` is DELIBERATELY absent: the
            // guard protects the agent's own instruction directories, and its
            // third option today is a one-click permanent way to disable that
            // protection — the most likely click when a prompt recurs.
            // Deliberate trust stays available from Space settings; accidental
            // trust does not.
            json!({ "optionId": "allow-directory", "name": "Always allow this directory", "path": "", "kind": "allow" }),
            json!({ "optionId": "reject", "name": "Block", "kind": "reject" }),
        ]
    }
}
```

Notes:
- The `"path"` value is a PLACEHOLDER here (`""`). The real resolved path is computed at the guard's call site — **T03's job**, because the path computation needs the target path, which `native_permission_gate`'s signature does not carry, and the nearest-existing-ancestor computation is a T03 concern (its `agent/fs_backend.rs`/guard wiring). T02 pins the SHAPE (the `"path"` key present, `""` value); T03 replaces the placeholder with the real ancestor. Mark this in the comment (`""` placeholder: T03).
- Alternatively, if the implementer prefers `Vec<serde_json::Map<String, Value>>`, that is acceptable — the tests index by `["optionId"]`, which works either way. Pick ONE and keep the tests consistent.

### 3. `native_permission_gate` (## permission.rs)

- The trusted auto-approve becomes:
  ```rust
  return PermissionOutcome::Selected {
      option_id: "allow".to_string(),
      value: None,
  };
  ```
- The prompt emitter (`// (b) Tell the UI …`) becomes:
  ```rust
  let options = permission_options(true);
  sink.emit(
      "permission-request",
      json!({
          "sessionId": session_id,
          "requestId": request_id,
          "request": {
              "sessionId": session_id,
              "toolCall": { "title": title },
              "options": options,
          },
      }),
  );
  ```
  The old "always three options" comment is replaced by the builder call (`permission_options(true)` — the boundary set, the only kind `native_permission_gate` produces until T03 adds the guard's caller).

### 4. `gate_tool` (## gate.rs)

```rust
matches!(
    outcome,
    PermissionOutcome::Selected { option_id, .. }
        if option_id == "allow" || option_id == "trust-space"
)
```
plus the seam comment from `## Code comment: the guard-prompt seam` attached to `gate_tool`.

### 5. The mechanical `..`-pattern fixes (no behaviour): `worker/core.rs` line 630, `session/mod.rs` line 1937, `gate.rs`'s `matches!` line 237 — the DESTRUCTURE sites (census D1–D3).

### 6. Construction sites gain `value: None` — ALL of census rows 1–13 (the full list, including `tests/worker_e2e.rs` and `tests/harness_loop.rs`; the two `tests/` files are absorbed per finding 1).

---

## Steps

> **Atomicity:** `archimedes` is ONE compilation unit — NEVER add the `value` field and leave a construction site un-updated, and never merge step 4's prompt-shaped fixtures before the enum is changed (they are tests: they must fail first, silently at compile time). Step 1 is a single atomic diff: enum + the first `value: None` site = the lib compiles for `permission.rs` itself. Steps 2–8 are enlargement, not repair. **The FULL suite is the real compile gate for the two `tests/` files: `cargo test --lib` never sees them — the atomicity rule extends to `cargo test --no-run` in S5/S9 (finding 1).**

- [ ] **S1 — First failing test (the backward-compat pins), in `src-tauri/src/agent/permission.rs`'s inline tests.**
  Add the doc-commented tests (these fail RED against the current enum — `value` does not exist yet):
  - `before_value_selected_still_deserializes` — `serde_json::from_str::<PermissionOutcome>(r#"{"selected":{"option_id":"allow"}}"#)` yields `Selected { option_id: "allow", value: None }`; and the same shape with `"trust-space"`. Doc comment: the `SubagentOutcome` cross-version model — an OLD outcome (no `value`) must still parse, because `permission-response` is in `decode_inbound`'s explicit allow-list (a missing `option_id` would be `ProtoError::Json`, NOT the permissive `Unknown`; a missing `value` is NOT an error — `default` absorbs it — this is the exact behavioural asymmetry the pair encodes).
  - `a_selected_without_value_serializes_without_the_key` — `serde_json::to_value(&Selected { option_id: "allow", value: None })` equals `json!({"selected":{"option_id":"allow"}})` (the `skip_serializing_if = "Option::is_none"` behavior — exactly the byte-shape of today's wire; without `skip_serializing_if` this would serialize `"value": null` and fail RED on the `==`).
  - `a_selected_with_value_round_trips` — `to_value` → `from_value` round-trips `value: Some("…")`; the serialized form contains `"value"`.
  Run `cargo test --lib permission::` from `src-tauri/` — expect compile/runtime RED (the constructors in these new tests use the new shape, which does not exist). If it PASSES, stop and investigate (the enum may have been half-changed already).

- [ ] **S2 — The atomic enum change: `Selected { option_id, value }` + a first `value: None` site.**
  In `src-tauri/src/agent/permission.rs`: change the variant, add the attribute PAIR `#[serde(default, skip_serializing_if = "Option::is_none")]` on `value` (D1 — BOTH halves; `default` alone would deserialize correctly but serialize `"value": null`, failing `a_selected_without_value_serializes_without_the_key`), and update the trusted auto-approve to `value: None` (step 3 of `## What to implement`) in the SAME edit so the file's own compile stays coherent. Run `cargo check` (from `src-tauri/`) — expect errors ONLY from the OTHER files' constructions (which is the expected blast radius; the crate does not compile until S5's sweep below). Record the exact error list.
  - **Do NOT touch the prompt emitter yet** (its three options are still correct for the boundary prompt — S4 makes that explicit).

- [ ] **S3 — `## permission_options` + wire `native_permission_gate` onto it (D2).**
  In `permission.rs`: add `permission_options(boundary: bool) -> Vec<serde_json::Value>` exactly as specified (both lists + the load-bearing comments), and replace the `json!` options array in the emitter with `let options = permission_options(true);` + `"options": options`.
  Run `cargo test --lib permission::` (compile only if S5's sweep is not yet done — see the atomicity note; if other files' constructions still break the build, run `cargo check --lib` instead, or temporarily continue with the sweep).

- [ ] **S4 — The pin `a_boundary_prompt_emits_the_old_three_options_with_trust_space` + the guard-list pins, in `permission.rs`.**
  - `a_boundary_prompt_emits_the_old_three_options_with_trust_space` — call the gate (the `native_gate_untrusted_prompts_and_maps_the_outcome` pattern) OR assert directly on `permission_options(true)`; REQUIRE: `options.len() == 3`; `optionId == "allow"` at index 0; `optionId == "reject"` at index 1; `optionId == "trust-space"` at index 2; and `options[2]["name"] == "Don't ask again for this Space"`. If you assert directly on the builder, ONE of the two must go through the gate's emitted payload (the existing `native_gate_untrusted_prompts_and_maps_the_outcome` already asserts `options.len() == 3` on the emitted payload — extend it to assert `options[2]["optionId"] == "trust-space"` so the emission path is pinned).
  - `a_guard_prompt_offers_exactly_allow_allow_directory_reject_and_no_trust_space` — pure builder assert on `permission_options(false)`: `len == 3`; ids in order `allow` / `allow-directory` / `reject`; names in order `"Allow once"` / `"Always allow this directory"` / `"Block"`; `options[1]` carries a `"path"` key; and **`permission_options(false).iter().all(|o| o["optionId"] != "trust-space")`** (the spec's own pin for this area — "the guard prompt offers exactly the three options with no `trust-space`").
  Run `cargo test --lib permission::` — this fails RED now (both `permission_options` and the enum are from S2/S3; if you run it after S2+S3 it passes GREEN — the point of S1's pins was the RED, these are the GREEN pins).

- [ ] **S5 — The construction/destructure-site sweep (make the crate compile).** Follow the census table in `## The complete `Selected` site census` EXACTLY (re-grep your own tree first — if it differs, STOP and report). Update to `Selected { option_id: …, value: None }` (or `value: Some(…)` where a test now wants the value); the placements below give the exact list:
  - `src-tauri/src/agent/permission.rs` — the gate's own tests: `an_unanswered_permission_prompt_never_settles_on_a_clock` (×2), `native_gate_trusted_space_auto_approves` (×1, `"allow"`), `native_gate_untrusted_prompts_and_maps_the_outcome` (×2), `native_gate_trust_space_allows_without_writing_the_flag` (×2, `"trust-space"`), and the S1/S4 test constructions (census rows 2–5).
  - `src-tauri/src/agent/harness/loop/gate.rs` — the `matches!` pattern gains `..` (Step 4 of `## What to implement`, census D3) + the seam comment. THIS is the one gate.rs edit.
  - `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — `answer_permission`'s construction at ~line 117 gains `value: None` (census row 6).
  - `src-tauri/src/agent/worker/core.rs` — line 630's `if let` gains `..` (census D2); two test constructions (`permission_response_resolves_the_pending_oneshot` ×2, `permission_response_trust_space_flips_the_trust_source` ×1) gain `value: None` (census rows 8–9).
  - `src-tauri/src/agent/worker/client.rs` — one test construction (~line 1215) gains `value: None` (census row 7).
  - `src-tauri/src/agent/worker/protocol.rs` — the round-trip test's `Selected { option_id: "trust-space" }` gains `value: None`; add the new-value case from D4; and add `before_value_permission_response_still_decodes` (D4's crate-wide companion — `decode_inbound` + `encode_inbound` on the OLD line, asserting `value: None`, doc-comment as the `SubagentOutcome` twin) (census row 11).
  - `src-tauri/src/agent/worker/manager/tests/mod.rs` — line 1918's construction gains `value: None` (census row 10).
  - `src-tauri/src/agent/session/mod.rs` — the blocker line (see `## Blocker`): change `Selected { option_id }` to `Selected { option_id, .. }` and update the `(Task 1)` comment to name the `..` (census D1).
  - `src-tauri/tests/worker_e2e.rs` — the construction at line ~810 gains `value: None` (census row 12). **NOT part of `cargo test --lib`'s compilation — `cargo check --tests` (or `cargo test` in S9) compiles it; do NOT skip it: a red full suite ends the task on a non-compiling commit.**
  - `src-tauri/tests/harness_loop.rs` — the construction at line ~435 gains `value: None` (census row 13). Same caution as `worker_e2e.rs`.
  Run `cargo check` from `src-tauri/` (compiles the lib); then `cargo check --tests` is NOT sufficient on its own — run the scoped suites: `cargo test --lib permission::`, `cargo test --lib worker::core::`, `cargo test --lib worker::protocol::`, `cargo test --lib worker::manager::`, `cargo test --lib harness::loop::tests::policy_gate::` — all GREEN. **And confirm the full suite is what compiles the two `tests/` files: run `cargo test --no-run` (or, if `--no-run` is unsupported, `cargo check --tests`) once here so the integration files are compile-proven BEFORE S9 — the full gate in S9 then cannot end on a non-compiling commit.**

- [ ] **S6 — The second verbatim copy: `worker/sink.rs`'s frame test (finding 6 — option (b), the cheap one).**
  Its canned `json!` payload options are exactly the old three-position form (allow / reject / trust-space) — for the BOUNDARY prompt this is still the right list, byte-identical this wave, and the test's WHOLE PURPOSE is proving the payload rides VERBATIM via `assert_eq!(back, payload)`. **Option (b) is instructed: leave the canned literal and the `client.rs` assertion untouched** — do NOT replace the literal with `permission_options(true)`: that swap would rebuild the payload through the builder, breaking the verbatim-ride proof (the test would be proving the builder round-trips itself) and buying nothing, since the boundary list is unchanged this wave. Add ONLY the `value: Some` round-trip case (D4) at the `client.rs` construction. RE-RUN `cargo test --lib worker::sink::` + `cargo test --lib worker::client::`.

- [ ] **S7 — The third verbatim copy: `worker/protocol.rs`'s canned `permission_payload` + `commands/sessions.rs` doc (if desired).**
  In `every_outbound_variant_round_trips`, keep the canned payload's `options` consistent with the shaped boundary list — same choice as S6 (the `json!` already has them verbatim; they ARE the current boundary list, so a pure-copy check: ids allow/reject/trust-space). The only NEW bit: the round-trip must now also carry a `Selected` with `value: Some` (D4) — add it beside the existing `Cancelled` case in `every_inbound_variant_round_trips`. In `commands/sessions.rs`, the command needs NO code change (by-value deserialize-only — the new optional field flows through); optionally update the doc comment on `respond_permission` to mention the `value`. This file is owned precisely for the "if it needs no edit, T02 does not touch it" rule — a doc-comment-only edit is acceptable and cheap; a code edit is NOT expected. UNLESS the vet's read shows a comment that misstates the outcome, leave it: **do not edit `commands/sessions.rs` at all** if nothing is wrong (the Owns set permits it, it does not require it).

- [ ] **S8 — The fixture: `src-tauri/src/bin/fake_worker.rs` (finding 5 — visibility settled, keep the literal).**
  The `"__permission__"` arm's canned options are the old three — for the boundary prompt that is still correct. **Visibility verdict (do NOT re-open):** `fake_worker` is a SEPARATE bin crate linked against `archimedes_lib` (`Cargo.toml` `[lib] name = "archimedes_lib"`; `use archimedes_lib::…` in the file), and `permission` is a PRIVATE module (`src/agent/mod.rs:18 mod permission;`) — `PermissionOutcome` reaches the fixture ONLY via the `pub use` re-export, which names the TYPE, not its fields. So `permission_options` (`pub(crate)`) is NOT nameable from the fixture, and `pub` would leak a prompt-list builder as API — neither is acceptable. **Keep the canned literal verbatim.** The drift risk is genuinely low: the fixture emits the BOUNDARY list (byte-identical this wave — `permission_options(true)` produces the same three), it decodes `PermissionResponse` GENERICALLY (`matches!(m2, Inbound::PermissionResponse { .. })`), and never matches on `option_id`. REBUILD the fixture: `cargo build --bin fake_worker` from `src-tauri/` — **a stale fixture binary is a protocol fixture and produces misleading failures in the client/manager suites** (`$CARGO_MANIFEST_DIR/target/debug/fake_worker` is a separate bin target; `cargo test --lib` does NOT rebuild it).

- [ ] **S9 — The full gate (one wave, so the FULL suite runs here, not later).**
  From `src-tauri/`:
  ```
  cargo test --no-run                          # compiles EVERYTHING — including the two tests/ files
                                               # (worker_e2e + harness_loop), which cargo test --lib
                                               # does NOT compile. If this is RED, fix and re-run —
                                               # it is the commit-time proof the full suite cannot
                                               # end on a non-compiling commit (finding 1).
  cargo test --lib worker::client::      # spawns the fixture — needs S8's rebuild
  cargo test --lib worker::manager::     # spawns the fixture
  cargo test --lib                       # the rest of the lib
  cargo test                             # the full suite (integration + e2e) — runs the two tests/ files
  cargo clippy --all-targets             # must be 0 warnings
  cargo fmt --check
  cargo check --target x86_64-pc-windows-gnu --all-targets   # the Windows path proof
  ```
  Any RED: fix and re-run. The 4 pre-existing ignored tests (manual/live-network) are not ours — do not un-ignore or delete them.

- [ ] **S10 — Commit.**
  `git add` the exact owned pathspecs (the docs/roadmap dir is gitignored — `git add -f` the plan and status files; the source pathspecs are normal). Commit message: `feat(agent): permission outcome carries value; per-prompt option lists; drop trust-space from the guard prompt`.

---

## Verification / commands

From `src-tauri/` unless noted:

```
cargo test --no-run                        # compiles everything INCLUDING tests/ (worker_e2e + harness_loop)
cargo test --lib permission::
cargo test --lib worker::core::
cargo test --lib worker::protocol::
cargo test --lib worker::sink::
cargo test --lib worker::client::        # needs: cargo build --bin fake_worker (S8)
cargo test --lib worker::manager::       # needs: cargo build --bin fake_worker (S8)
cargo test --lib harness::loop::tests::policy_gate::
cargo test --lib                         # does NOT rebuild fake_worker — S8 is separate
cargo test                               # the full suite (one wave => full suite in-wave)
cargo clippy --all-targets
cargo fmt --check
cargo check --target x86_64-pc-windows-gnu --all-targets
```

The fixture rule, stated once: **`cargo test --lib` does NOT rebuild `fake_worker`** — it is a separate bin target, so `cargo build --bin fake_worker` is required before the client/manager suites. A stale binary makes the client/manager round-trip tests fail in ways that look like the wire change.

The tests/ rule, stated once: **`cargo test --lib` does NOT compile `tests/worker_e2e.rs` or `tests/harness_loop.rs`** — they compile only in the full-suite targets, so the ONLY `--lib`-scoped proof that both construction sites were found is the full `cargo test --no-run` / `cargo test` gate. `cargo test --no-run` is the commit-time compile check for BOTH files (finding 1).

---

## Acceptance criteria

- [ ] `PermissionOutcome::Selected` is `{ option_id: String, value: Option<String> }` with the attribute PAIR `#[serde(default, skip_serializing_if = "Option::is_none")]` on `value`, and the crate compiles with `value: None` threaded through every construction site in the Owns set + the blocker file — **including `tests/worker_e2e.rs:810` and `tests/harness_loop.rs:435` (compile-proven by the full `cargo test --no-run` / `cargo test` gate — the two sites `cargo test --lib` never compiles; finding 1).**
- [ ] **`a_guard_prompt_offers_exactly_allow_allow_directory_reject_and_no_trust_space`** (new, in `permission.rs`) passes: `permission_options(false)` has exactly three options `allow` / `allow-directory` / `reject` with the names `"Allow once"` / `"Always allow this directory"` / `"Block"`, `options[1]` carries the `"path"` key, and **no option has `optionId == "trust-space"`**.
- [ ] **`a_boundary_prompt_emits_the_old_three_options_with_trust_space`** (new, in `permission.rs`) passes: the boundary options are exactly the old three (allow / reject / trust-space) with `trust-space` labelled `"Don't ask again for this Space"`, and the existing `native_gate_untrusted_prompts_and_maps_the_outcome` pins `len == 3` + `options[2]["optionId"] == "trust-space"` on the ACTUAL emitted payload.
- [ ] **`before_value_selected_still_deserializes`** (new, in `permission.rs`) passes: an outcome serialized WITHOUT `value` (`{"selected":{"option_id":"allow"}}`) deserializes to `value: None` — both `"allow"` and `"trust-space"` spellings.
- [ ] `a_selected_without_value_serializes_without_the_key` passes: `value: None` does NOT appear on the wire — the byte shape stays `{"selected":{"option_id":"allow"}}`. **(This pin is the `skip_serializing_if` proof: bare `#[serde(default)]` alone would emit `"value": null` and fail it RED — the plan's "payload byte-identical to today's wire" and this pin are consistent ONLY with the pair.**)
- [ ] `a_selected_with_value_round_trips` passes (the `value` field round-trips).
- [ ] `before_value_permission_response_still_decodes` (new, in `protocol.rs`) passes: an OLD-shape `permission-response` line decodes to `value: None`, and `every_inbound_variant_round_trips` now includes a `Selected` with `value: Some(…)` so the new shape is the crate-wide default.
- [ ] `gate_tool`'s predicate compiles as `Selected { option_id, .. }` with the `allow`/`trust-space` ids unchanged (boundary behavior intact; `trust-space` still accepted because the boundary prompt still offers it).
- [ ] `tests/worker_e2e.rs::permission_round_trip_real_worker` and `tests/harness_loop.rs::tool_call_gates_executes_loops_and_settles` both carry `value: None` and both COMPILE in the full-suite targets (proven by `cargo test --no-run`; NOT by `cargo test --lib` — finding 1) and PASS in `cargo test`.
- [ ] The seam comments (the guard rationale + the T03/T04 hand-off) are in the code as specified.
- [ ] `fake_worker` rebuilt (`cargo build --bin fake_worker`); the canned literal stays verbatim (finding 5: `pub(crate)` builder not nameable from the separate bin crate; finding 6: option (b), byte-identical boundary list, verbatim-ride proof intact); client + manager suites GREEN.
- [ ] Full gate GREEN: `cargo test --no-run` (compiles tests/ too), `cargo test`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check`, `cargo check --target x86_64-pc-windows-gnu --all-targets`.

---

## Blocker

**`src-tauri/src/agent/session/mod.rs` is NOT in T02's Owns set, but T02's shape change breaks its ONLY DESTRUCTURE — the only `Selected` pattern-site outside the set. (Finding 1's construction sites in `tests/` are separate; this is a *destructure*, not a *construction*.)**

`SessionManager::respond_permission` (line ~1937) contains:

```rust
if let permission::PermissionOutcome::Selected { option_id } = &outcome {
```

Adding `value` to the variant makes this a compile error (missing field) in the ONE compilation unit. The fix is a pure `..`-pattern compile fix, exactly the boundary the dispatch named: T02 makes the shape carry `value`; T04 owns the relay that persists a rule; T02 does not write persistence.

**Resolution requested from the orchestrator: extend T02's Owns set to `src-tauri/src/agent/session/mod.rs` for ONE line** — `Selected { option_id }` → `Selected { option_id, .. }` — plus a comment tweak on the `(Task 1)` block naming the `..` and noting that the rule-write lands at T04. Justification for preferring the honest one-line extension over a "design the variant so the existing destructure still compiles":

1. **The design alternative is worse.** Keeping the destructure compiling without `..` would require `value` to default in a pattern, which Rust does not do for struct variants — the only "shape that keeps the old destructure compiling" would be to NOT add the field to the variant (impossible, it is the task) or to add `#[non_exhaustive]`-style penalty games that make EVERY external match (T04's, the UI's) harder for zero benefit.
2. **There is no green intermediate state without the `..`.** `archimedes` is ONE compilation unit — the variant change and `session/mod.rs`'s match are the same compile. Extending the set is the same class of decision T01's 12-file extension was (mechanical blast-radius absorption, not scope creep): the ONE line carries no persistence logic and no rule behavior. The same mechanical absorption (finding 1, precedent: T01's absorbing `tests/worker_e2e.rs`) adds `tests/worker_e2e.rs` and `tests/harness_loop.rs` for one `value: None` each.
3. **`session/mod.rs` stays T04's** for everything else — T04's plan (relay persists `allow-directory`) is unaffected; T02 merely touches the destructure the shape change forces. T04 must still be told it inherits a file with a `..`-patterned match.

If the orchestrator declines, T02 stops and reports BLOCKED rather than editing the file unowned — the plan never ends on a non-compiling commit, and an unowned edit would break the wave's disjointness proof either way.

---

## Out of scope

- **T03 — rule enforcement at the gate and executor**: wiring `rule_for` + `default_rules` into `policy_verdict` (rows 1–4 of the spec), the protected write becoming an `Ask` when no rule matches, the executor's `access.rs` / `tools/types.rs` / `tools/sandbox.rs` agreement, the frozen-default-set question. T02 only builds the guard's option list; T03 calls it. **T03's ONE concrete obligation — the loud pin (finding 3): land the end-to-end pin `a_guard_allow_directory_runs_the_tool` in `harness/loop/tests/policy_gate.rs`. It MUST route a protected write through the guard ask, answer `allow-directory` at the gate, and assert the tool RUNS. This single pin is BOTH the loud failure for the predicate contract (`gate_tool`'s approve predicate matches only `allow`/`trust-space`; without T03's extension the shipped "Always allow this directory" option silently produces `permission denied` — `turn.rs`'s `false → "permission denied"` — nothing fails loud) AND the end-to-end proof T02's delivery CANNOT provide at this HEAD (a protected write never reaches the gate here — it is refused by the executor's `protected_refusal` under `writes: Allow`, or the gate's `deny_tool_result` under `Sandboxed`, no prompt in either posture). Make it impossible for T03's implementer to miss: this paragraph is the contractual marker.** The predicate bit, the pin, and the value's persistence at T04 are three different seams — T02 provides the option, records the predicate contract, and names the pin; T04 persists.
- **T04 — relay persistence**: `SessionManager::respond_permission` writing one `{path, direction: ReadWrite, decision: Allow}` rule for `allow-directory` (via `rule_for`'s defaults-then-user concatenation), plus the settings round-trip and the subagent-relay branch. The `value: Option<String>` this task adds is the carrier T04 consumes.
- **Frontend** — already shipped in wave 1 (T05): `PermissionOption.path`, `value?: string`, `PermissionPrompt.tsx` echoing `path` as `value`.
- **ADR 0083 / CONTEXT.md / docs** (T07).
- **T01's policy module** — read-only; the defaults/rules concatenation contract it pinned is T03/T04's to honor, not T02's to extend.

## Honest limits, recorded

- **The guard's option list is pinned on a pure builder, not end-to-end, because the guard ask is NOT reachable at T02's HEAD.** A write targeting a protected dir is refused with NO prompt at T02 (T01 deliberately did not wire rules into `decision_for`): under the default `writes: Allow` posture the write DISPATCHES and the **executor's** `protected_refusal` refuses it; under `Sandboxed` the **gate's** `deny_tool_result` does — neither prompts, and both are T03's to convert. The guard prompt becomes reachable only at T03. The builder + its pins are the faithful seam; end-to-end proof is T03's acceptance, named `a_guard_allow_directory_runs_the_tool`.
- **`allow-directory` is not yet an allow id at the gate** — deliberate (D3): at T02's HEAD no guard prompt can reach `gate_tool`, so adding the id would be dead code. The predicate extension is T03's and is recorded three places so it cannot be forgotten: `## Out of scope` (with the named loud pin `a_guard_allow_directory_runs_the_tool`), the gate seam comment, and the done-when. A code comment is the weakest kind of handoff — the named end-to-end pin is what makes the shipped option's silent `permission denied` fail LOUD.
- **The `path` in the guard's `allow-directory` option is a `""` placeholder.** The real nearest-existing-ancestor computation needs the target path at the guard's call site and the lenient canonicalizer — both are T03's wiring (T02's signature `native_permission_gate` does not carry the target path). The shape (`"path"` key present) is pinned; the value is T03's.
- **`commands/sessions.rs` likely needs zero edits** (by-value deserialize-only passthrough). The plan permits a doc-comment-only touch and otherwise leaves it untouched — a deliberate exercise of the owned-but-unneeded rule.
- Files listed as "Modify" that end up needing little or no change are in the set precisely because their canned copies are the multi-edit-site property of `json!` prompts — owning them is the point. After finding 6 (option (b)), `worker/sink.rs`'s canned literal stays byte-identical (zero edits — the verbatim-ride proof is the point of the test, and the builder swap would break it), `worker/protocol.rs` gains only the `value: Some` round-trip case, and `fake_worker.rs`'s literal stays verbatim (finding 5's visibility verdict). `commands/sessions.rs` likely needs zero edits (by-value deserialize-only passthrough); a doc-comment-only touch is permitted but not expected.