# B2b / task05b — ENFORCE the `permission:` block IN THE GATE and make it LIVE end-to-end (#101(b), second half)

**THE SPLIT (why this half exists, recorded per the dispatch).** `…-task05-carry-and-enforce.md` was
reviewed sound but its enforcement would have shipped **dormant**: real, unit-tested, and NEVER
consulted, because the one production line that makes it live — `loop_.set_permission(...)` in
`worker/core.rs`, fed by a `StartEnv.permission` field — lived outside its owned set. That is the
confident-no-op class #101 exists to fix. This plan is the **SECOND half: enforce AND make it
live.** It runs immediately after **task05a** (`docs/roadmap/agent-permission-and-pins-task05a-carry-and-wire.md`),
which adds `LaunchConfig.permission`, widens the DTO, and lands the wire half of report. **This
plan DEPENDS on task05a**: it consumes `LaunchConfig.permission` (the field task05a creates — the
child flow passes `wire.launch.permission` on into the `StartEnv`), and task05a's whole-tool-deny
advertisement drop stays resolver-side there (production-effective without this file). This half
owns only what makes the CHILD's gate see the ruleset in production, plus the gate enforcement
STEP 3 and the gate tests STEP 6 taken from the source plan. **A note on the tree:** the
`…-task05a-…` plan file is NOT yet present under `docs/roadmap/` (this split was recorded in
`…-status.md` at `ef32c7b` before the plan files were split); the dependency language above mirrors
the status file's split entry and the source plan's own scope decision 1. HEAD is `ef32c7b`
(source tree identical to `2ccf1ff` for every file below — verified).

Grounding: `docs/roadmap/agent-permission-and-pins-ground-definition-delta.md` (HEAD `27d761c`)
supersedes `docs/roadmap/agent-permission-and-pins-ground-definition.md` wherever they differ. The
source plan (`…-task05-carry-and-enforce.md`) is the parent this half cuts in half: **STEP 3 (the
enforcement design) and STEP 6 (the gate tests) are taken over with their reasoning preserved
verbatim**; Steps 0/1/2/4/5 (the `LaunchConfig` field, the resolver rung, the DTO widening, the
whole-tool advertisement drop, the notes DTO test) belong to task05a and are left out. All line
numbers below were verified against the tree at HEAD.

## Scope decisions (this half's calls, each with its reasoning)

1. **Enforce — the per-agent verdict is merged as the STRICTER of the posture/rule verdict and the
   definition's verdict, under the total order `Allow < Confine < Ask < Deny`** (delta §5: `Deny`
   strictest, `Ask` next, `Confine` (a RUNNING sandbox) below `Ask`, `Allow` the identity). The
   per-agent vocabulary (`Action = Allow | Ask | Deny`, no `Confine`) is projected onto that order —
   **a naive `min` over `{Allow, Ask, Deny}` is wrong for `bash` because `Confine` sits between
   `Allow` and `Ask` and the per-agent layer cannot express "sandbox it"**, so `Allow` never
   un-confines a `Sandboxed` shell and `Ask`/`Deny` can still tighten a confined run. **This
   warning is the subtlest thing in the task; a `min` over the three per-agent actions mis-orders
   `bash` and is the diff reviewers must look for first.**
2. **The per-agent layer is consulted AFTER the write-rule/guard precedence (`rule_or_guard_verdict`
   rows 1–3) and term-wise STRICTER against the result**, never BEFORE it and never overriding its
   row-1 `Deny` or row-3 guard `Ask` (the delta §5 sentence: the per-agent layer ENTERS at row 4
   and cannot see rows 1–3). This is ADR 0030's "trust suppresses prompts but never widens a deny"
   applied to definitions — the core #101 design claim. The placement guarantees a definition's
   `Allow` can NEVER bypass the row-3 protected-dir guard or a row-1 user `deny`, and can STILL
   tighten a trust-widened `Allow`.
3. **A per-agent `Deny` reuses `deny_tool_result` UNCHANGED** — the model's recovery cannot depend
   on which layer said no (ADR 0030: a gate denial and an executor denial read identically). No new
   wording is invented.
4. **Pattern paths are judged canonicalise-then-check under `canonicalize_lenient`, the SAME
   canonicaliser / root set the gate and the executor already share** (`FsBackend::validate` /
   `canonicalize_lenient`, per grounding §9) — one resolver, no second canonicaliser, because a
   pattern layer resolving `..` or a symlink differently from the executor is the #92 / ADR 0081
   escape class. The root question ("relative to what?") is answered by the **boundary root set**,
   not opencode's workspace-relative root. (Concretely in this task: whole-tool verdicts only — a
   per-agent `Deny` on a path-taking tool folds onto `policed_direction`, whose beyond-check is
   already the shared `beyond_error`; no new path resolution is added.)
5. **Make it LIVE — THIS half's point.** Unit-tested gate logic is not evidence the feature works.
   This half requires the PRODUCTION wiring (a) `protocol.rs` `StartEnv.permission` +
   `from_parts`, (b) `worker/core.rs` `loop_.set_permission(...)` next to `set_enabled_tools`,
   (c) `subagent_flow.rs` passing `wire.launch.permission` into the child's `StartEnv` — and an
   **end-to-end real-worker test** driving the whole chain
   (`subagent` dispatch → `SubagentDispatchWire` → `subagent_flow` → `StartEnv` → `core.rs` →
   `AgentLoop` → gate) proving a definition `permission: deny` actually refuses the CHILD. Plus a
   plumbing red-test: **if `StartEnv.permission` were never populated, a test must redden** (the
   e2e assertion on the wire launch below would fail at `wire.launch.permission`), so the carry
   cannot silently drop.
6. **NO bash command-pattern matching.** B1 parses a `bash:` object with ≥1 pattern row and
   announces it `UnsupportedUnvalidatedMatcher(BashPatternRules)` (task04's decision); enforcing
   such rows needs a matcher nothing has validated (the redirect trap recorded in the status file's
   decisions log: `grep x file 2>/dev/null` contains a `>`). Whole-tool `bash: deny` (a bare
   `Action`, `Rules::is_deny()`) IS enforced. Leave the pattern rows alone.
7. **A per-agent `Ask` on an UN-policed tool stays unenforced — the named limitation, not a silent
   drop.** `read_skill`/`ask`/`web_search`/`fetch_content`/`subagent`/`mcp` have NO
   `policed_direction` twin, so `policy_verdict` early-returns `None` for them today (the `?` at the
   top); their enforcement would need a NEW tool-level check outside the gate's policed set.
   Recognized set that CAN map onto `policed_direction`: `bash`→Shell, `read`/`find`/`grep`/`ls`
   →Read, `write`/`edit`→Write. Any other key stays parsed + announced (B1's guarantee) and
   unenforced at the gate — recorded, not dropped.

## Decisions log (this half)

- **2026-11-XX — `deny_tool_result` is the ONLY denial renderer.** A per-agent `Deny` produces the
  SAME tool-result error `deny_tool_result(tc)` would produce, so the model's recovery cannot
  distinguish a definition-level deny from a user-rule deny or a guard deny (ADR 0030). No new
  wording is invented.
- **2026-11-XX — the child Worker is the ONLY production consumer.** `resolve_agent_launch` has
  exactly two callers — `commands/agents.rs` (the modal's read-only report) and `harness/dispatch.rs`
  → `resolve_launch` (the `subagent` tool call) — and no main-session path passes an
  `AgentDefinition` at all (status file's split entry), so a definition's `permission:` governs
  CHILDREN only and the child loop is built in `worker/core.rs` from `StartEnv`. This half's wire
  touches exactly that path.
- **2026-11-XX — `StartEnv.permission` is set from `wire.launch.permission` (VERBATIM), and
  `core.rs` applies it next to `set_enabled_tools`.** No mapping, no re-resolution: `launch.permission`
  is already the definition's declared block (task05a's carry). `None` = the file does not speak
  about permissions = no narrowing at the gate.
- **2026-11-XX — the task05a whole-tool-deny advertisement drop is NOT duplicated here.** The
  resolver-side `launch.tools` narrowing (task05a's Step 4) is production-effective without this
  file; `core.rs` handles only the RUNTIME gate verdict. The never-offered property is pinned by
  task05a's own tests and the e2e test's `read` path stays offered (only the verdict denies).

## Owned file set (Files: — exactly these seven, no others)

1. `src-tauri/src/agent/harness/loop/gate.rs` — the stricter-of-two consult.
2. `src-tauri/src/agent/harness/loop.rs` — the `permission_block` field + setter (mirror the
   existing `set_enabled_tools`/`enabled_tools` pair).
3. `src-tauri/src/agent/worker/protocol.rs` — `StartEnv.permission` + `from_parts`.
4. `src-tauri/src/agent/worker/core.rs` — the `loop_.set_permission(...)` line, next to the
   existing `set_enabled_tools` call.
5. `src-tauri/src/agent/worker/manager/subagent_flow.rs` — pass `wire.launch.permission` into the
   child's `StartEnv`.
6. `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — the gate tests.
7. `src-tauri/src/agent/definition_permission.rs` — the `Deserialize` impls (Step 1, Part A). **Why this
   file joins THIS task (it was B1-owned yesterday):** `StartEnv` (and `Inbound` — constructor
   and wire) derive BOTH `Serialize` AND `Deserialize`, and `decode_inbound` (protocol.rs:384,
   production worker stdin loop at `worker/mod.rs:267`) deserialises the `"start"` frame in the
   parent. So as soon as this task puts `permission: Option<PermissionBlock>` on `StartEnv`, the
   crate CANNOT compile unless `PermissionBlock` implements `Deserialize` — and transitively so
   must every type it aggregates: `ToolKey`, `Rules`, `Rule`, `Action`, plus
   `FrontmatterNote`/`UnsupportedReason` if they ride along (E0277 otherwise; proven by minimal
   reproduction). No other task owns this file at this point, so this task takes it. **This is a
   required step of THIS task, not a follow-up — the "Serialize-only, no Deserialize needed"
   claim in the earlier draft was WRONG and would have shipped a non-building crate.**

**NOT owned (must NOT be edited):** `agents.rs`, `skills.rs`,
`agent/policy.rs`, `agent/permission.rs` (the unrelated ADR 0010 UI gate), `commands/agents.rs`,
`agent/harness/launch.rs`, `agent/subagent.rs`, `bin/fake_worker.rs` (all task05a), and
`tests/worker_e2e.rs` is **owned for TESTS ONLY** (its ONLY changed lines are the new `#[test]` +
the one changed test-module builder arg the widening `from_parts` forces — the `None,` trailing arg
at `worker_e2e.rs:389`; see the REPO
CONVENTIONS note below; no production/protocol line in it moves).

## Steps (6, at the ceiling)

### Step 0 — verify the ground truth (no edits)

Read-only verification at HEAD `ef32c7b`:

- `src-tauri/src/agent/harness/loop.rs:478-487` — `set_enabled_tools`/`enabled_tools` accessor pair
  (the pattern `set_permission`/`permission_block` copies); the struct's `file_policy` field at
  `:316` and its construction-time stance at `:427` (`FilePolicy::default()` — `permission_block`
  mirrors it: `None` until set, wired before the first prompt); `AgentLoop::new` at `:327`.
- `src-tauri/src/agent/worker/protocol.rs:237-256` — `StartEnv { session_id, cwd, mode, transcript,
  model, catalog, thinking, trusted, enabled_tools, config_dir, subagent_enabled, system_prompt,
  incarnation }`, derives `Clone, PartialEq, Serialize, Deserialize` (both — `:235`) +
  `#[serde(rename_all = "camelCase")]`; `from_parts` at `:257` (12 args,
  `#[allow(clippy::too_many_arguments)]`). `Inbound` (`:49`) derives BOTH too and carries
  `Start(Box<StartEnv>)`; `decode_inbound` (`:384`) deserialises the `"start"` frame in
  production (`worker/mod.rs:267` stdin loop) — so `StartEnv` MUST stay deserialisable, and
  therefore so must its new `permission` field's type.
- `src-tauri/src/agent/worker/protocol.rs:492` — `start_inbound()` builds `StartEnv { … }` with all
  THIRTEEN fields namefully (a new field is a compile break; the literal-completion lands here).
  The test holding it is `every_inbound_variant_round_trips` (`:529`) — `Inbound::Start` is in its
  `cases` vec, so the round-trip pins the new field's wire `camelCase` spelling.
- `src-tauri/src/agent/worker/core.rs:325` — `loop_.set_enabled_tools(env.enabled_tools.clone());`
  (production `build_loop`); `:824` — the stub `build_loop`'s identical line (BOTH get the
  `set_permission` sibling; a missing stub-application would let
  `core.rs`'s unit tests measure a loop that never saw the ruleset).
- `src-tauri/src/agent/worker/manager/subagent_flow.rs:669-681` — the child's
  `StartEnv::from_parts(...)` (12 positional args; `Some(child_tools.clone())` is the 9th =
  `enabled_tools`; the new 13th arg is `wire.launch.permission.clone()`).
- `src-tauri/src/agent/harness/loop/gate.rs:99-152` — `policy_verdict` (the `?` early-`None` for
  un-policed tools at `:100`; the WRITE rule/guard branch at `:145-150` returning rows 1–3 EARLY;
  the `decision_for(...)` tail at `:152-158` — the ONLY tail the merge may touch); `:198-237`
  `rule_or_guard_verdict` (rows 1–3); `:335-382` `deny_tool_result` (no per-layer branch — the
  per-agent deny inherits the existing wording by construction).
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — helpers `policy_settings` (`:38`),
  `deny_rule` (`:56`), `build_policy_loop` (`:86`), `read_call` (`:117`), `answer_permission`
  (`:134`), `pin_guard_home` (`:174`), `write_scripts` (`:188`), `read_scripts` (`:206`),
  `trust_the_space` (`:223`), `permission_requests` (`:235`), `tool_ends` (`:247`); import
  `use crate::agent::policy::Decision;` (the `Decision` enum is `Allow|Ask|Deny|Confine`).
- `src-tauri/tests/worker_e2e.rs` — `subagent_dispatch_end_to_end_real_workers` (`:1051`): a REAL
  `archimedes --worker`, `HOME`-isolated (`~/.pi/agent/agents/scout.md` canned agent, ENV_LOCK),
  the MAIN's wiremock streams a `subagent` tool call, the child's own wiremock streams a text
  answer, and the test asserts the `SubagentDispatch` frame's `launch.*` + the child's
  `enabledTools` + the final captured text. This is the harness this half extends (see Step 2).
- `src-tauri/tests/harness_subagent_dispatch.rs` — in-process parent (`MockProvider`), but spawns
  the REAL `fake_worker` child (the `FakeWorkerFactory` at `:63`) and resolves the oneshot; also
  usable, but `worker_e2e` already asserts the child's ENV/allocation — extend THAT one.
- Confirm the tree builds at HEAD: `cargo build --all-targets` (must be `Finished`; the e2e adds
  `tests/`-target code, so also confirm `cargo test --no-run --test worker_e2e` compiles).

Run: `cargo test --lib` (nothing about the git state — the fixtures below run against the current
tree).

### Step 1 — `Deserialize` on the aggregate (REQUIRED) + carry on `StartEnv` + apply in `core.rs` — the LIVE seam

**Part A — `Deserialize` on the `permission` aggregate (REQUIRED, blocking).** This lands first:
without it, Part B's `StartEnv.permission` field cannot compile (`Serialize`-only type inside a
`Deserialize`-deriving struct / enum = E0277).

**File: `src-tauri/src/agent/definition_permission.rs`**

Add `::serde::Deserialize` to the derive list of every type the new
`StartEnv.permission` field can carry — nothing less compiles, because
`StartEnv`/`Inbound` derive `Deserialize` and `decode_inbound` deserialises the
`"start"` frame at runtime:
- `Action` (`:51`) → `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]`
- `Rule` (`:67`) → same, both derives
- `Rules` (`:77`) → same, both derives (it already carries `Default`, which
  `Deserialize` does not need — keep it)
- `ToolKey` (`:140`) → both derives
- `PermissionBlock` (`:201`) → both derives
- `FrontmatterNote` (`:223`) + `UnsupportedReason` (`:187`) — IF they ride the
  wire (the notes report may follow the block). `PermissionBlock` itself needs
  only `ToolKey`, `Rules`→`Rule`→`Action`; the notes pair becomes REQUIRED the
  moment any `Deserialize`-deriving struct aggregates them. Cheap to add in the
  same step; the decision is written here so it is not "discovered"
  mid-implementation.

(The file's `use serde::Serialize;` import at `:42` becomes `use serde::{Deserialize, Serialize};`
or the fully-qualified `serde::Deserialize` appears in the derive lists — either style, this task's
choice as long as `cargo fmt --check` passes.)

**THE impls MUST round-trip the EXACT pinned wire spellings — no convenience
renames, no `rename_all` additions.** This repo has NO wire-contract test, and
B1 pinned the spellings deliberately:
- `Action` is **lowercase** (`"deny"` — `#[serde(rename_all = "lowercase")]`, `:52`);
- `ToolKey` / `UnsupportedReason` / `FrontmatterNote` are **camelCase**
  (`rename_all = "camelCase"` on each);
- `ToolKey::Unrecognized` is EXTERNALLY tagged `{"unrecognized":"…"}` (the
  verbatim-name survival pin);
- `FrontmatterNote` is EXTERNALLY tagged (`{"unknownKey":"mode"}`, `:216-217`);
- `Rule` / `Rules` / `PermissionBlock` carry **NO** `rename_all` at all — so
  `whole_tool` is **`whole_tool` (snake_case)** even inside a camelCase parent.

Say it plainly: **a `#[serde(rename_all = "camelCase")]` added "for convenience" on
`Rules` would break B1's pins `a_permission_block_serializes_in_file_order`
(definition_permission.rs:1229) and `frontmatter_notes_serialize_as_a_tagged_object_per_note`
(`:1200`) — and would silently DESERIALISE a real file's block into a DIFFERENT ruleset than the
one parsed (a `whole_tool` key in a real file's JSON would fail to decode without the
`#[serde(default)]`-style leniency that the spelling redesign is NOT allowed to introduce here,
or a decoder that accepts only `wholeTool` would mis-read a `whole_tool`-spelled block). That is
the silent-drift class this whole issue exists to fix. The derive additions alter NO wire
spelling; only the compile-time capability. The spelling pins (*Serialize* side) are the
ground-truth oracle for the *Deserialize* side.

**The round-trip pin that catches a mistake for free:** `every_inbound_variant_round_trips`
(protocol.rs:529) decodes the encoded `Inbound` (including `Inbound::Start`) and asserts
`assert_eq!(case, decoded)`. With `start_inbound()`'s literal carrying a non-`None` block (Part B
below), that test round-trips the REAL `permission` payload through `Deserialize` on every run —
so a wrong `rename_all`/tagging on any nested type reddens it. **Keep
`start_inbound()`'s non-`None` block — it is the reason the Deserialize risk is BOUNDED by an
existing pin instead of another silent-spelling class.** (The B1-side serialization pins in
`definition_permission.rs` are symmetric: they already pin the exact JSON the `Deserialize` side
must accept, because the wire contract is spelled there today.)

**Part B — carry on `StartEnv` + apply in `core.rs` (the LIVE seam).**

**File 1: `src-tauri/src/agent/worker/protocol.rs`** (after the task05a `LaunchConfig` field already
exists — this half carries THAT field's value one hop further, onto the child's start envelope):

- Add to `StartEnv` (after `enabled_tools`, matching the struct's doc style):
  ```rust
  /// The per-agent `permission:` ruleset (issue #101) as the PARENT's
  /// resolved launch carried it (VERBATIM from `LaunchConfig.permission` —
  /// a definition's declared NARROWING layer). `None` → the file does not
  /// speak about permissions; the child's gate starts from "no narrowing".
  /// Crosses the wire inside the `start` envelope (`camelCase`, additive —
  /// an absent key on an OLD supervisor decodes to `None`).
  pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
  ```
- Append the parameter to `from_parts` (new last arg):
  ```rust
  pub fn from_parts(
      …,
      system_prompt: Option<String>,
      permission: Option<crate::agent::definition_permission::PermissionBlock>,
  ) -> Self
  ```
  and set `permission,` beside `system_prompt,` in the `Self { … }` literal. The
  `#[allow(clippy::too_many_arguments)]` stays (now 13 args).

**Compile impact (measured, re-verified at HEAD):** every `StartEnv::from_parts(` call site names
its 12 positional args positionally, so a 13th ARG breaks all of them unless each is updated.
Verified census — `grep -rn "StartEnv::from_parts("` (crate + bins + `tests/` —
`cargo build --all-targets` covers every one) → **14 call sites, exactly**:
- 9 in the LIBRARY & its unit-test modules (the crate alone — what `cargo test --lib`
  compiles):
  - `src-tauri/src/agent/worker/manager/subagent_flow.rs:669` — the child flow (edited in Step 1).
  - `src-tauri/src/agent/worker/protocol.rs:473` — `test_env()` (test):
    `permission: None,`.
  - `src-tauri/src/agent/worker/protocol.rs:492` — `start_inbound()`: the FULLY-SPECIFIED
    `StartEnv { … }` LITERAL (13 fields namefully — **compile breaks on the new field**): add
    `permission: Some(PermissionBlock { tools: vec![] })` i.e. a `Default` block or a
    `Some(block)` fixture — use
    `permission: Some(crate::agent::definition_permission::PermissionBlock::default()),` so the
    `Inbound::Start` round-trip carries a NON-`None` value and the shared round-trip test
    (`every_inbound_variant_round_trips`, `:529`) pins the wire spelling for free.
  - `src-tauri/src/agent/worker/core.rs:750` — the `#[cfg(test)]` `test_env` helper: `None,`.
  - `src-tauri/src/agent/harness/dispatch.rs:467` (test helper): `None,`.
  - `src-tauri/src/agent/session/mod.rs:1169` (production main-session start): **`None,`** (a main
    session has NO definition — the status file's finding; a hardcoded `None` here is correct and
    the e2e's `start_env_with_file_policy` test builder mirrors it).
  - `src-tauri/src/agent/worker/manager/tests/mod.rs:95` — `test_env` helper: `None,`.
  - `src-tauri/src/agent/worker/client.rs:891` — `test_env` helper: `None,`.
  - `src-tauri/src/agent/subagent.rs:473` — the `SubagentSessionManager` START helper
    (`subagent_start` — a MAIN/worker-side start, not the child flow): `None,`.
    (`agent/harness/loop/tests/subagents.rs:78` also calls `from_parts` — the rc `subagents.rs` test
    module; `None,`.)
- **5 MORE, in the `tests/` integration binaries — the census the earlier draft MISSED, and the
  reason `cargo test --lib` alone is NOT the compile gate:**
  - `tests/worker_e2e.rs:389` — `start_env_with_file_policy` (the builder Step 2 edits): `None,`.
  - `tests/worker_stderr.rs:41` — `start_env` helper: `None,`.
  - `tests/worker_stdin.rs:81` — `subagent_start` helper: `None,`.
  - `tests/harness_dispatch_native.rs:96` — the parent env in the native-dispatch harness: `None,`.
  - `tests/harness_subagent_dispatch.rs:99` — the parent env in the subagent-dispatch harness: `None,`.

Each is ONE trailing `None,` — the census is fully enumerable and the
`cargo build --all-targets` gate catches a miss (every site is in the crate, a bin, or a test
target). **Do NOT widen `safe_default`-style builders here** — the two `protocol.rs` LITERAL sites are the
only ones requiring thought.

- **`StartEnv` derives `Deserialize` (protocol.rs:235) — so `PermissionBlock` MUST derive
  `Deserialize`, and transitively `ToolKey`/`Rules`/`Rule`/`Action` (Step 1 Part A).** This is NOT a
  follow-up and NOT optional: `Inbound` (protocol.rs:49) derives `Deserialize` and carries
  `Start(Box<StartEnv>)`, and `decode_inbound` (protocol.rs:384, run from the production worker
  stdin loop at `worker/mod.rs:267`) deserialises the `"start"` frame. The moment this task adds
  `permission: Option<PermissionBlock>` to `StartEnv`, the crate will NOT compile unless the
  whole aggregate implements `Deserialize` — proven by minimal reproduction (a `Serialize`-only
  type inside a `Deserialize`-deriving struct fails with `E0277: the trait bound
  PermissionBlock: Deserialize<'de> is not satisfied`). The earlier draft's "the field is
  Serialize-only in effect; no `Deserialize` is added" ruling was WRONG — it was reasoning about
  OUTBOUND only and missed that `decode_inbound` deserialises the same struct in the parent. The
  add is BEHIND the wire back-compat claim, not in front of it: an old supervisor's `start`
  WITHOUT `permission` still decodes (`Option`'s default-`None`), and a `start` WITH the key
  decodes into a typed block.

**File 2: `src-tauri/src/agent/worker/core.rs`** — both `build_loop` (production) and the `stub_handles`
stub:

```rust
        loop_.set_enabled_tools(env.enabled_tools.clone());
        // (issue #101) The per-agent `permission:` ruleset the parent's
        // launch carried (VERBATIM). THE line that makes the gate LIVE:
        // without it the gate's strict-of-two consult sees `None` on every
        // child and the definition's deny/ask never narrows a thing.
        loop_.set_permission(env.permission.clone());
```

Production at `core.rs:325` (immediately after the existing `set_enabled_tools` call); the stub at
`:824` gets the SAME line (so `core.rs`'s own unit tests exercise the applied ruleset — a gate
test passing while the child loop never received the block is the dormant-enforcement class this
half exists to kill).

**File 3: `src-tauri/src/agent/worker/manager/subagent_flow.rs`** — the child's `StartEnv`:

```rust
    let env = StartEnv::from_parts(
        child_id.clone(),
        wire.parent_cwd.clone(),
        StartMode::FreshChild,
        None,
        model.clone(),
        parent_env.catalog.clone(),
        thinking.clone(),
        parent_env.trusted,
        Some(child_tools.clone()),
        parent_env.config_dir.clone(),
        false,
        system_prompt,
        // (issue #101) The per-agent ruleset rides the child's start
        // envelope VERBATIM — the child Worker's `core.rs` applies it to
        // the loop's gate. `wire.launch.permission` is the definition's
        // declared block, carried through task05a's `LaunchConfig`.
        wire.launch.permission.clone(),
    );
```

**The plumbing-red test (Step 2's e2e) is what makes this line non-optional:** if
`wire.launch.permission` (or `core.rs`) is omitted, the e2e's `read` would NOT be refused and the
"refused" assertion reddens — the carry cannot silently drop.

### Step 2 — the ONE e2e test that proves it is LIVE (tests dir, tests-only)

**File: `src-tauri/tests/worker_e2e.rs`** — a NEW `#[tokio::test]` **beside** the existing
`subagent_dispatch_end_to_end_real_workers` (the proven real-worker subagent harness — TWO real
`archimedes --worker` processes, main + child, wiremock streams, `HOME` isolation with the
`ENV_LOCK`, `E2e`/`wait`/`wait_sink`/`tool_execution_end`/`start_env_with_file_policy` helpers all
reused). The dispatch names this file as the harness to extend — it is the one whose child is a
REAL worker AND whose `SubagentDispatch` frame exposes `launch.*` (so the carry is observable);
`harness_subagent_dispatch.rs`'s child is the same `fake_worker`, but its assertions stop at the
oneshot and never inspect the child's gate.

**`the_definition_permission_deny_refuses_the_child_real_worker`** — TDD-first, it FAILS on the
current tree for TWO independent reasons (a) the runtime reason: the gate has no
`permission_block` — the `read` would be allowed and the "refused" asserts redden; (b) the
compile reason: the helper's `StartEnv::from_parts` (worker_e2e.rs:389) lacks the new 13th arg,
and this test lives in a `tests/`-binary target that `cargo test --lib` never compiles — a
MISSED `tests/`-binary call site breaks it AT COMPILE TIME, which is exactly why
`cargo build --all-targets` is a required gate. It proves the full chain:

1. `HOME`-isolate exactly like the sibling test (`ENV_LOCK` + `RestoreHome` + a temp home with
   `~/.pi/agent/agents/`).
2. Write the canned agent:
   ```
   ---
   name: gated
   model: fake/sub-model
   tools: [read]
   permission:
     read: deny
   ---
   You are the gated child.
   ```
3. The MAIN's wiremock: stream 1 = a `subagent` tool call (`task: "read the secret"`,
   `agentName: "gated"`), stream 2 = the final `stop`. The CHILD's wiremock: stream 1 = a
   `read` tool call `{"path": "/tmp/…/secret.txt"}`, stream 2 = the final `stop`.
4. Attach the main env with `enabled_tools: Some(["subagent"])` (the main only needs `subagent`),
   `subagent_enabled: true`, all-`Allow` policy (via `start_env` — NO settings file) — the user
   policy WOULD allow the read; only the definition should stop it.
5. **Plumbing half (the carry is observable, not assumed):** after the dispatch, assert on the
   emitted `WorkerInboundEvent::SubagentDispatch` frame that `dispatch.launch.permission` is
   `Some(json!({"tools": [ ["read", {"patterns":[{"pattern":"*","action":"deny"}], "whole_tool":true}] ]}))`
   — the block RODE the wire as a `LaunchConfig` field (task05a) → `SubagentDispatchWire`. **This
   assertion is the plumbing red-test: if `StartEnv.permission` were never populated, it still
   passes — so the runtime half below is the one that reddens on a dropped `StartEnv` field.**
   Stated honestly in the plan: **both halves are needed** — (a) the wire assert catches a
   `subagent_flow`/`launch` drop; (b) the child's refusal catches a `core.rs`/`StartEnv` drop. If
   the answer to "which test reddens when the plumbing drops?" were "none", the plan would be
   incomplete — this pair is that answer.
6. **Runtime half (the gate is LIVE):** the child's `read` of an out-of-boundary path reaches the
   child gate → `policy_verdict` → `stricter_of_two(Allow, Deny)` = `Deny` → `deny_tool_result`.
   The child's `tool_execution_end` for `read` has `is_error: true` and its `content[0].text`
   `contains("escapes the session sandbox")` (the `escape_text` wording — `read` has no rule/protected
   wording so the boundary sentence is the per-agent deny's renderer; the child never sends a
   `PermissionRequest`). Also assert NO `PermissionRequest` arrived for the child (a deny never
   prompts) and the child settles.
7. Assert the finally-captured text / settle as the sibling does; clean close (the child's worker
   exited 0 — `h.crashes` empty). The main's final assistant text is whatever `stop` stream says.

Note on the ONE helper line this test needs in `worker_e2e.rs`: the `start_env_with_file_policy`
builder's `StartEnv::from_parts` call (`worker_e2e.rs:389`) gains the trailing `permission: None`
arg (it is the test module's own builder — its shape is updated HERE, not in a production file;
this is the ONLY non-test line the e2e file changes, and it is how the file keeps compiling
against the widened `from_parts`). It needs NO extra `Deserialize` work: `StartEnv::from_parts`
CONSTRUCTS the struct (no JSON), and the fixture's `permission: None` field never
round-trips inside the e2e — the `Deserialize` obligation lives entirely in Step 1 Part A's file
(and is proven crate-side by `every_inbound_variant_round_trips`, not by the e2e builder).
Worth naming: `ArchimedesLib`'s `tests/`-only `worker_stderr.rs:41` /
`worker_stdin.rs:81` / `harness_dispatch_native.rs:96` / `harness_subagent_dispatch.rs:99`
helpers share the same "construct, never deserialise" shape — same one-arg change, same
non-obligation.

### Step 3 — enforce: consult `AgentLoop.permission_block` in `gate.rs`, STRICTER-of-two

**File: `src-tauri/src/agent/harness/loop.rs`**

- Add the accessor pair (mirroring `set_enabled_tools` at `:478`, verified `:478-487`):
  ```rust
  /// Set the per-agent permission ruleset (issue #101) — `None` = the file
  /// does not speak about permissions (no narrowing). The gate consumes it
  /// in the strict-of-two merge; a definition's rules can only NARROW the
  /// user's `filePolicy`, never widen it.
  pub fn set_permission(&mut self, permission: Option<crate::agent::definition_permission::PermissionBlock>) {
      self.permission_block = permission;
  }

  /// The per-agent permission ruleset (`None` = no narrowing).
  pub fn permission_block(&self) -> Option<&crate::agent::definition_permission::PermissionBlock> {
      self.permission_block.as_ref()
  }
  ```
- Add the field + init next to `file_policy` (struct field at `:316`; init at `:427`):
  ```rust
  /// (issue #101) The per-agent permission ruleset — `None` until set, the
  /// same construction-time stance as `file_policy`. Wired via
  /// [`Self::set_permission`] by the child Worker's `core.rs` (the line
  /// that makes the gate LIVE); gate tests set it before the first prompt.
  permission_block: Option<crate::agent::definition_permission::PermissionBlock>,
  ```
  and `permission_block: None,` in `AgentLoop::new` next to `file_policy: FilePolicy::default(),`.

**File: `src-tauri/src/agent/harness/loop/gate.rs`**

- Add imports: `use crate::agent::definition_permission::ToolKey;` and
  `use crate::agent::policy::Decision as _Decision;` — leaning on the crate-pub re-export
  (`crate::agent::definition_permission` is public in `agent/mod.rs:9`; the `Decision` enum
  `Allow|Ask|Deny|Confine` is already imported at `:9`).
- **Replace `policy_verdict`'s TAIL** (the ONLY change to that fn — the write-rule/guard branch at
  `:145-150` keeps its EARLY returns, which is exactly the row-4-consultation property) at
  `gate.rs:152-158`:
  ```rust
  let posture = decision_for(policy, beyond, trusted, dir == PolicyDirection::Shell);
  Some(stricter_of_two(
      posture,
      self.definition_verdict(&tc.name),
  ))
  ```
  where:
  ```rust
  /// The per-agent verdict for a tool, `AsSelf` (no narrowing) when the
  /// file does not speak about it or the tool has no policed twin. The
  /// recognized path-taking `ToolKey`s fold onto the policed directions;
  /// an unrecognised / un-policed key stays `AsSelf`.
  fn definition_verdict(&self, tool: &str) -> DefinitionVerdict {
      let Some(block) = self.permission_block.as_ref() else {
          return DefinitionVerdict::AsSelf;
      };
      // The ORDERED aggregate; FIRST matching tool key wins (B1's
      // FIRST-WINS per tool key inside a block).
      let rules = match block.tools.iter().find(|(key, _)| tool_key_matches(key, tool)) {
          Some((_, rules)) => rules,
          None => return DefinitionVerdict::AsSelf,
      };
      match rules.catch_all_action() {
          Some(Action::Deny) => DefinitionVerdict::Deny,
          Some(Action::Ask) => DefinitionVerdict::Ask,
          Some(Action::Allow) => DefinitionVerdict::Allow,
          // An EXPLICIT `{"*": action}` pattern ruleset (`whole_tool: false`)
          // has NO tool-wide verdict — `catch_all_action()` is `None` for it
          // (delta §1b) — and pattern matching is out of scope by decision
          // (bash patterns are announced unsupported; see the scope line).
          None => DefinitionVerdict::AsSelf,
      }
  }

  /// The per-agent verdict projected onto the strict-of-two order.
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  enum DefinitionVerdict {
      Deny,   // strictest
      Ask,
      Allow,
      AsSelf, // the file does not narrow; the identity for the merge
  }
  ```
- The merge itself:
  ```rust
  /// STRICTEST-WINS over `Allow < Confine < Ask < Deny` (delta §5). The
  /// per-agent vocabulary has NO `Confine`; `AsSelf` is the identity. This
  /// is the NARROWING-ONLY merge: `Allow` never widens a posture `Deny` /
  /// `Confine` / a rule `Deny` / the row-3 guard `Ask`, and `Ask` / `Deny`
  /// only ever tighten. `Confine` (a RUNNING sandbox) ranks BELOW `Ask` so a
  /// per-agent `ask` tightens a confined `bash`, and ABOVE `Allow` so a
  /// per-agent `allow` can never un-confine a `Sandboxed` shell policy.
  fn stricter_of_two(a: Decision, pf: DefinitionVerdict) -> Decision {
      match pf {
          DefinitionVerdict::AsSelf => a,
          DefinitionVerdict::Allow => a,           // identity: Allow < everything
          DefinitionVerdict::Ask => match a {
              Decision::Allow | Decision::Confine => Decision::Ask,
              a => a,                              // Ask == Ask, Deny > Ask
          },
          DefinitionVerdict::Deny => Decision::Deny,
      }
  }
  ```
  (The per-agent vocabulary uses `Action` only; `catch_all_action()` gives `None` for a per-pattern
  ruleset, and `Ask`/`Deny` map 1:1 onto `Decision::Ask`/`Decision::Deny`. The ordering is a
  partial order over the four `Decision`s projected onto the three `Action`s — the honest way to
  state it is the match above, not a numeric rank.)

- **Placement requirement — stated precisely, preserving the source plan's reasoning verbatim:**
  the merge runs on `policy_verdict`'s FINAL value, which is computed AFTER
  `rule_or_guard_verdict` (rows 1–3 return early at `:145-150`). The source plan's own analysis
  flagged that a naive "merge after the rule branch" WOULD let a per-agent `Deny` override the
  row-3 guard `Ask`; the resolution it landed on — and this plan preserves — is that
  `policy_verdict`'s write branch KEEPS its early returns for rows 1/2 and row 3, so `definition_verdict`
  is consulted ONLY on the row-4 fallthrough (`decision_for`'s result). Concretely:
  - a per-agent `Deny` CANNOT bypass the row-3 protected-dir guard `Ask` (the guard returns EARLY —
    the definition's `Deny` never sees it);
  - a per-agent `Allow` CANNOT bypass the row-1 rule `Deny` (also early) NOR the row-3 `Ask`;
  - a per-agent `Ask`/`Deny` CAN still tighten a trust-widened `Allow` (the row-4 merge sees the
    `Allow` that `decision_for`'s trusted arm produced and `Ask`/`Deny` beat it).
  This is exactly the delta §5 phrase "the per-agent layer must be consulted AFTER
  `rule_or_guard_verdict` (row 4)": it ENTERS at row 4 and cannot see rows 1–3. The implementation
  changes NO return in the write branch — only the tail's `decision_for(...)` result is merged. **A
  per-agent `Deny` that targets a protected-dir write therefore produces a `Deny` through the SAME
  `deny_tool_result` wording (the protected-refusal sentence) as a posture deny — it just cannot
  erase the row-3 ask.**

- **`tool_key_matches`** (new helper next to `definition_verdict`; the only path from a call's
  `tc.name` to a per-agent `ToolKey`, and where ToolKey names are matched against `tool_specs()`
  names — the SAME advertised names `subagent_flow`/`core` use):
  ```rust
  /// The one place a call's tool name maps onto a per-agent `ToolKey`.
  /// A `ToolKey::Unrecognized(name)` matches ITS OWN verbatim name only —
  /// it has no advertised `tool_specs` twin to police, so the match is
  /// exact-or-nothing.
  fn tool_key_matches(key: &ToolKey, tool: &str) -> bool {
      match key {
          ToolKey::Bash => tool == "bash",
          ToolKey::Read => matches!(tool, "read"),
          ToolKey::Write => matches!(tool, "write"),
          ToolKey::Edit => matches!(tool, "edit"),
          ToolKey::Find => matches!(tool, "find"),
          ToolKey::Grep => matches!(tool, "grep"),
          ToolKey::Ls => matches!(tool, "ls"),
          ToolKey::ReadSkill => matches!(tool, "read_skill"),
          ToolKey::Ask => matches!(tool, "ask"),
          ToolKey::WebSearch => matches!(tool, "web_search"),
          ToolKey::FetchContent => matches!(tool, "fetch_content"),
          ToolKey::Unrecognized(name) => name == tool,
      }
  }
  ```
  **The read trio policy:** `read`/`find`/`grep`/`ls` all judge Read at the gate; the
  per-agent layer treats `read: deny` as denying the READ direction's `path` tool only (a `find`
  with a `pattern`/`max_results` arg is not the gated `path`), matching `POLICIED_TOOLS`'s
  per-name mapping. `tool_key_matches` is where `read` stays `"read"` — a `find` is NOT caught by a
  `read: deny` (the per-agent map is per-tool-key, and `find` has its own key).

- `deny_tool_result` (gate.rs:335): **NO code change needed for the per-agent `Deny`** — it already
  routes through the protected-refusal / rule-deny / escape arms purely on the call + context, NOT
  on which layer produced the `Decision::Deny` (turn.rs maps `Some(Decision::Deny)` →
  `self.deny_tool_result(tc)` unconditionally). The per-agent deny inherits the exact wording. Add
  a short doc note: "a per-agent `Deny` reaches here via the same `Decision::Deny` mapping, so the
  model's recovery cannot depend on which layer said no."

### Step 4 — gate tests (policy_gate.rs), preserved verbatim from the source plan's Step 6

**File: `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`** — all reuse the delta-quoted
helpers VERBATIM: `policy_settings`, `deny_rule`, `build_policy_loop`, `read_call`, `write_scripts`,
`pin_guard_home`, `answer_permission` (policy_gate.rs:38/56/86/117/188/174/134). Add to the test
module's imports: `use crate::agent::definition_permission::{Action, PermissionBlock, Rules, ToolKey};`.
Set the ruleset on the loop BEFORE the first prompt via `loop_.set_permission(Some(block))` (the
existing `file_policy`-before-prompt pattern) and read the verdict/messages after a
`bounded_prompt` (so `file_policy`/`rules` are freshened — the existing pattern). Test matrix (each
a named test):

1. **`a_definition_narrowing_an_allow_to_an_ask_prompts`** — settings `"allow","allow","allow"`;
   block `read: ask`; a `read` of an out-of-boundary path → `policy_verdict` ==
   `Some(Decision::Ask)` and a `permission-request` arrives (the definition narrowed a posture
   `Allow` to a prompt). Fixture: the `ask_beyond_the_boundary…` shape (an outside `Tmp` file, a
   `read_call`, `answer_permission` approving) — the definition is what made the prompt exist.
2. **`a_definition_deny_refuses_with_the_rule_or_protected_wording`** — settings
   `"allow","allow","allow"`; block `write: deny`; a `write` of a path under the pinned
   `$HOME/.pi/agent/agents` → `Some(Decision::Deny)` and the tool-result text contains
   `"protected agent-definition directory"` (the SAME `protected_refusal_text` wording a user rule
   would produce — reuse `deny_tool_result`, no new wording).
3. **`a_definition_cannot_widen_a_user_deny`** — settings `"sandboxed","sandboxed","sandboxed"`;
   block `read: allow`; an out-of-boundary `read` → still `Some(Decision::Deny)` (the posture
   `Deny` beats the per-agent `Allow`).
4. **`a_definition_allow_cannot_bypass_the_protected_dir_guard`** — settings
   `"allow","allow","allow"`; block `write: allow`; a protected-dir `write` on an UNTRUSTED space
   → `Some(Decision::Ask)` (the row-3 guard survived the per-agent `Allow`).
5. **`a_definition_cannot_unconfine_a_sandboxed_shell`** — settings `"allow","allow","sandboxed"`;
   block `bash: allow`; a `bash` call → `Some(Decision::Confine)` (the per-agent `Allow` cannot
   widen a `Sandboxed` shell policy — the `Confine`-not-a-midpoint warning pinned).
6. **`a_definition_ask_tightens_a_trust_widened_allow`** — settings `"allow","allow","allow"` on a
   TRUSTED space (`trust_the_space`, `:223`); block `read: ask`; an out-of-boundary `read` on the
   trusted space → `Some(Decision::Ask)` (the per-agent `Ask` beats the trust-produced `Allow`).

**Named-limitation pin (also a test, so it cannot silently regress into a panic or a DROP):**
7. **`a_definition_ask_on_an_unpoliced_tool_stays_as_self`** — block `web_search: deny`; a
   `web_search` call → `policy_verdict` is `None` (the `policed_direction` `?` still early-returns)
   and no panic; the recognized-but-unpoliced set stays announced, never silently dropped (B1's
   guarantee).

The 7 named tests are the honest minimum for the narrowing-only + strict-of-two claim. Every test
asserts on `policy_verdict` AFTER a `bounded_prompt` freshens the turn state, mirroring the
existing direct-verdict pins (e.g. `a_trusted_space_suppresses…` at `:846`).

### Step 5 — the wiring red-test pair (Step 2's e2e) + scoped runs

The e2e test from Step 2 IS the wiring red-test. Its two halves, stated as the accept/reject
criteria:

- **Plumbing half ("if `wire.launch.permission` stops riding the wire, which test reddens?"):**
  the `SubagentDispatch.launch.permission` assertion in the e2e reddens (task05a's carry dropping
  is caught here too). **Runtime half ("if `StartEnv.permission` is never populated, which test
  reddens?"): the child's `read` refusal in the SAME e2e reddens** — `core.rs`/`subagent_flow`/
  `StartEnv` dropping the field is caught by the child's gate returning `Allow` instead of `Deny`.
  Both halves of ONE test, because a dropped `StartEnv.permission` with the wire intact is
  precisely the dormant-enforcement class; a single test whose SECOND assertion is the refusal is
  the answer to "is the plumbing actually live?".

Scoped runs (from `src-tauri/`), one per writer:

- Gate tests: `cargo test --lib agent::harness::r#loop::tests::policy_gate -- a_definition_narrowing_an_allow_to_an_ask_prompts`
  (the `r#loop` keyword filter; run per name).
- Protocol/definition_permission + worker units (Step 1's compile — including the new
  `Deserialize` derives — + the `start_inbound` round-trip):
  `cargo test --lib agent::worker::protocol::tests -- every_inbound_variant_round_trips`,
  `cargo test --lib agent::definition_permission` (B1's spelling pins stay green under the
  derive additions),
  `cargo test --lib agent::worker::manager::tests`.
- The e2e: `cargo test --test worker_e2e the_definition_permission_deny_refuses_the_child_real_worker`
  then the sibling `subagent_dispatch_end_to_end_real_workers` (the edited file must not regress
  it). NOTE: `cargo test --test worker_e2e` requires the `archimedes` bin + `fake_worker` built —
  run `cargo build --all-targets` first (AGENTS.md: `cargo test --lib` does NOT rebuild bins; the
  e2e spawns `target/debug/archimedes` and `target/debug/fake_worker`).

### Step 6 — required gates

- `cargo build --all-targets` (catches the 14-site `from_parts` census — the 9 crate sites AND
  the 5 `tests/`-binary sites — plus the `protocol.rs:492` literal; `cargo test --lib` would not
  compile the `tests/` targets).
- `cargo clippy --all-targets` = 0 warnings (`archimedes` is ONE compilation unit; the new
  `from_parts` arg keeps its `too_many_arguments` allow; the e2e's new test follows the existing
  `#[allow(clippy::await_holding_lock)]` pattern).
- `cargo fmt --check`.
- No long-running processes (no watch/dev server).

## Repo conventions

- TDD: write the failing tests in Step 2/4 against the STUBBED accessor + merge canary, then land
  the implementation. `cargo test --lib <filter>` from `src-tauri/` per test. **`loop` is a Rust
  keyword, so a filter path is `agent::harness::r#loop::tests::policy_gate`** (e.g.
  `cargo test --lib agent::harness::r#loop::tests::policy_gate -- a_definition_ask_tightens_a_trust_widened_allow`).
- `archimedes` is ONE compilation unit — every scoped run compiles the whole crate; never share a
  wave with another Rust task (the status file's rule).
- `docs/roadmap/` is gitignored — the status file's step 6 requires a force-add for the plan docs
  (irrelevant to this half's implementation, but the commit of this file must `git add -f`).

## Acceptance criteria

1. `StartEnv.permission: Option<PermissionBlock>` exists, `from_parts` carries it as the 13th arg
   (all 14 call sites compile — 9 crate + 5 `tests/`-binary, see Step 1's census; the
   `start_inbound` literal + round-trip pin it), and the child
   flow's `Wire.launch.permission` rides the child's envelope VERBATIM.
2. **`PermissionBlock`, `ToolKey`, `Rules`, `Rule`, `Action` (and `FrontmatterNote` /
   `UnsupportedReason` if they ride along) derive `Deserialize`, round-tripping the EXACT pinned
   B1 spellings — no `rename_all` added to `Rules` or any nested type. `every_inbound_variant_
   round_trips` (protocol.rs:529) passes with `start_inbound()`'s non-`None` block, proving the
   wire `Deserialize` side matches the pinned `Serialize` side.**
3. `worker/core.rs` (production AND the stub) applies `loop_.set_permission(env.permission.clone())`
   immediately after `set_enabled_tools` — the gate is LIVE on every child.
4. `policy_verdict`'s final verdict is `stricter_of_two(posture, definition_verdict)` under
   `Allow < Confine < Ask < Deny`; the row-4-only consultation holds (rows 1–3 return early;
   `Allow` can neither bypass the row-3 guard nor un-confine a `Sandboxed` shell; `Ask`/`Deny` only
   tighten); a per-agent `Deny` reuses `deny_tool_result`'s existing wording (no new renderer).
5. The seven gate tests in `policy_gate.rs` pass, including the `Confine`-non-midpoint and the
   named-limitation pins.
6. **The e2e** `the_definition_permission_deny_refuses_the_child_real_worker` **passes with a REAL
   worker child** — and its plumbing-half assertion (`dispatch.launch.permission`) makes a dropped
   carry a red test, not a silent no-op.
7. `cargo build --all-targets`, `cargo clippy --all-targets` (0 warnings), `cargo fmt --check` all
   green.

## Findings / risks (for the caller)

- **The source plan's dormant-enforcement gap is closed BY THIS half's owned set — but only if the
  e2e is treated as load-bearing.** The gate can pass every unit test and still be dead; the
  `worker_e2e.rs` test is the acceptance evidence. It costs a real `archimedes --worker` spawn per
  run (~seconds) — accept the suite-time cost; there is no cheaper proof of "live".
- **`PermissionBlock`/`ToolKey`/`Rules`/`Rule`/`Action` (and `FrontmatterNote`/`UnsupportedReason`
  if they ride along) gain `Deserialize` in THIS task — REQUIRED, not follow-up.** `StartEnv` and
  `Inbound` derive `Deserialize` (protocol.rs:235/49) and `decode_inbound` (protocol.rs:384) runs
  in PRODUCTION (the worker's stdin loop, `worker/mod.rs:267`, deserialises the `"start"` frame).
  A `Serialize`-only type inside a `Deserialize`-deriving struct is an E0277 compile error the
  moment `permission` lands on `StartEnv` (proven by minimal reproduction). The doomed
  "Serialize-only, no `Deserialize`" reading survived only because it looked at OUTBOUND
  (`From<&StartEnv> for Inbound`) and forgot the parent's DECODE side. The wire back-compat claim
  is BEHIND the addition: `Option`'s default-`None` keeps an old supervisor's `start` without the
  key decodable.
- **The `Deserialize` impls must round-trip the EXACT pinned B1 spellings: `Action` lowercase,
  `ToolKey`/`UnsupportedReason`/`FrontmatterNote` camelCase, `ToolKey::Unrecognized` and the
  notes EXTERNALLY tagged, and `Rule`/`Rules`/`PermissionBlock` carrying NO `rename_all`
  (`whole_tool` stays snake_case).** A convenience `rename_all = "camelCase"` on `Rules` would
  break `a_permission_block_serializes_in_file_order` and
  `frontmatter_notes_serialize_as_a_tagged_object_per_note` AND silently deserialise a real
  file's block into a DIFFERENT ruleset than the one parsed — the silent-drift class #101
  exists to fix. Keep `start_inbound()`'s NON-`None` block: it makes `every_inbound_variant_
  round_trips` (protocol.rs:529) deserialise a real block every run, which is why this risk is
  BOUNDED by an existing pin.
- **`from_parts` has 14 call sites, all positional (9 crate + 5 `tests/`-binary), NOT 9.** The
  earlier draft's census stopped at `src/` and missed the five integration-test helpers
  (`worker_e2e.rs:389`, `worker_stderr.rs:41`, `worker_stdin.rs:81`,
  `harness_dispatch_native.rs:96`, `harness_subagent_dispatch.rs:99`) — each one trailing
  `None,`. The `fake_worker` bin has NO `from_parts` call (verified), but `cargo build
  --all-targets` is still the ONLY gate that compiles both the bins AND all `tests/` targets —
  `cargo test --lib` would NOT catch a missed `tests/` site. A new site added between planning
  and implement would be caught by that same gate. The main-session
  start (`session/mod.rs:1169`) and the `subagent.rs` start helper get hardcoded `None,` — a main
  session has no `AgentDefinition` (the status file's finding), so `permission: None` is CORRECT
  there, not a dropped carry.
- **Un-policed tools stay unenforced at the gate (named limitation, pinned by test 7).** A
  definition's `read_skill: deny`/`web_search: deny`/`subagent: deny` parses + announces (B1) but
  does NOT refuse at the gate (no `policed_direction` twin; building one would touch the
  dispatch/turn seam outside the owned set). Whole-tool `bash: deny` IS enforced (it is policed).
  Per-command bash patterns remain announced-unsupported (task04's decision; the redirect trap).
- **The `StartEnv` wire-spelling pin is free:** `start_inbound`'s literal carries a non-`None`
  block so `every_inbound_variant_round_trips` pins `permission`'s camelCase presence.
- **`tool_key_matches` is a NEW helper (verified absent from the tree)** — the source plan's gate
  pseudocode referenced it; it functions exactly as named and makes `ToolKey::Unrecognized(name)`
  exact-or-nothing. The `tool_key_name`-based advertisement drop is task05a's, not here.
- **Do NOT edit `agent/policy.rs`, `agent/permission.rs`, `commands/agents.rs`, `launch.rs`,
  `subagent.rs`, `fake_worker.rs`, `definition_permission.rs`, `agents.rs`, `skills.rs`.** The
  unrelated ADR 0010 UI gate (`agent/permission.rs`) is the `ask`-prompt machinery only.

## Sources

- `src-tauri/src/agent/harness/loop/gate.rs` (99-158, 198-237, 335-382)
- `src-tauri/src/agent/harness/loop.rs` (316, 327, 427, 478-487)
- `src-tauri/src/agent/worker/protocol.rs` (49 `Inbound` derives incl. `Deserialize`; 235-290
  `StartEnv` + `from_parts`; 329-347 `SubagentDispatchWire`; 384-400 `decode_inbound`; 472-525
  `test_env`/`start_inbound` + the round-trip test `every_inbound_variant_round_trips` 529)
- `src-tauri/src/agent/worker/core.rs` (323-327, 824, 749-770)
- `src-tauri/src/agent/worker/manager/subagent_flow.rs` (610-682)
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` (helpers 24-260; existing pins 660-1917)
- `src-tauri/tests/worker_e2e.rs` (130-240 `E2e`, 367-397 `start_env_with_file_policy`, 1051-1330
  `subagent_dispatch_end_to_end_real_workers`)
- `src-tauri/src/agent/definition_permission.rs` (42 `use serde::Serialize`; 45-135 types incl.
  `Action` 51-53 / `Rule` 67 / `Rules` 77 / `whole_tool`/`is_deny`/`catch_all_action`; 140-143
  `ToolKey` camelCase + `Unrecognized`; 166-178 `from_frontmatter_key`; 187-189
  `UnsupportedReason`; 201-215 `PermissionBlock`; 216-225 `FrontmatterNote`
  EXTERNALLY-tagged; pins `frontmatter_notes_serialize_as_a_tagged_object_per_note` 1200 and
  `a_permission_block_serializes_in_file_order` 1229 — the `Deserialize`-side oracle)
- `src-tauri/src/agent/worker/mod.rs` (267 — the PRODUCTION stdin-loop `decode_inbound` that
  deserialises a `start` with a `permission` block)
- Grounding: `docs/roadmap/agent-permission-and-pins-ground-definition-delta.md` (HEAD `27d761c`),
  `docs/roadmap/agent-permission-and-pins-ground-definition.md`
- Parent plan: `docs/roadmap/agent-permission-and-pins-task05-carry-and-enforce.md` (Steps 3 & 6
  taken verbatim)
- Split record: `docs/roadmap/agent-permission-and-pins-status.md` (the 2026-10-29 B2-split entry)