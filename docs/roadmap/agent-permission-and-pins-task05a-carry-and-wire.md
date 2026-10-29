# B2a / task05a — carry, layer, and the wire-half of report (#101(b)) — FIRST half of the B2 split

Branch `feature/agent-permission-and-pins`, HEAD `27d761c`. This is the FIRST half of the split of
`docs/roadmap/agent-permission-and-pins-task05-carry-and-enforce.md` (644 lines; that file is
left in place, unedited, as the source of record for the second half). B1 (`2ccf1ff`) already
parses `permission:` into `AgentDefinition.permission: Option<PermissionBlock>` +
`frontmatter_notes: Vec<FrontmatterNote>`. This task is: **carry** (`LaunchConfig.permission`),
**layer** (`resolve_agent_launch` + `ResolvedLaunch.permission_source` + the `AgentConfigDto`
column structs), the **resolver-side whole-tool-deny advertisement drop**, and the **wire half
of report** (the notes reach `AgentConfigDto`).

Grounding: `docs/roadmap/agent-permission-and-pins-ground-definition-delta.md` (HEAD `27d761c`)
supersedes `…-ground-definition.md` wherever they differ. All line numbers below verified against
the tree at HEAD.

## WHY THE SPLIT (the orchestrator's decision — recorded for future readers)

The source plan completes carry + layer + gate enforcement + the DTO wire, but the ONE production
line that would make enforcement LIVE — `loop_.set_permission(...)` in `worker/core.rs`, fed by a
`StartEnv.permission` field — is outside its owned file set. Shipping the source plan whole would
produce enforcement that is real, unit-tested, and NEVER CONSULTED — the confident-no-op class
#101 itself exists to fix. So the work is split into two serial tasks:

- **THIS plan (task05a): carry + layer + wire.** `LaunchConfig.permission` lands on the
  `SubagentDispatchWire.launch` path, `resolve_agent_launch` reports `permission_source`,
  the modal's row gains `filePermission` + `frontmatterNotes`, and a whole-tool `deny` narrows the
  child's advertised tool set at the resolver. **It does NOT enforce.**
- **task05b (`docs/roadmap/agent-permission-and-pins-task05b-enforce-and-live.md`, to be
  derived from the source plan's Steps 3 + 6): enforce + live.** The `gate.rs` strict-of-two
  merge, the `AgentLoop::set_permission`/`permission_block` accessor pair, `StartEnv.permission`,
  the production `loop_.set_permission(...)` in `worker/core.rs`, `subagent_flow.rs`, and the
  `policy_gate.rs` gate tests. task05b is the commit that makes a definition's `permission:`
  change runtime behaviour.

## CRITICAL HONESTY STATEMENT (read before the steps)

After THIS commit, `LaunchConfig.permission` is carried and reported but **no gate, loop, or
worker code consumes it**: there is no `AgentLoop.permission_block`, no `StartEnv.permission`, and
no `policy_verdict` merge. Nothing in production reads the field to decide a verdict. The
definition's `permission:` changes **NO runtime behaviour** except the single bounded exception
below:

- **The one live effect: the resolver-side whole-tool advertisement drop (Step 3).** A whole-tool
  `deny` on a recognised tool key narrows `launch.tools` pre-wire, and because
  `subagent_flow.rs:629` re-advertises `launch.tools` VERBATIM (its three-way rule, no edit
  needed), the denied tool is never offered to the child. This is a name-filter inside this
  half's own `launch.rs` — the same class of filter the existing `narrow` closure already is.
- **Everything else a `permission:` block can say — `ask`, `allow`, per-command `bash` patterns,
  and any VERDICT at the gate (prompts, `deny_tool_result` errors, the strict-of-two merge) —
  changes NO behaviour after this commit.** A `read: ask` or `write: deny` definition changes
  nothing at runtime; the only visible surface is the modal's report (`filePermission` +
  `frontmatterNotes` columns). The commit that changes that is **task05b** (its production
  `loop_.set_permission(...)` wire). Do NOT let this plan read as if enforcement landed — the
  acceptance criteria below label every DATA criterion and the DEFERRED criteria explicitly.

## Scope decisions (this half's calls — taken VERBATIM from the source plan, with enforcement-only parts handed off to task05b)

1. **Carry — `permission` is a `LaunchConfig` + `ResolvedLaunch` field, carried to the child on
   the same path `tools:` takes** (`LaunchConfig.tools` → `SubagentDispatchWire.launch` →
   `subagent_flow.rs`). The field is `Option<crate::agent::definition_permission::PermissionBlock>`.
   It rides `SubagentDispatchWire.launch` (protocol.rs:341 `pub launch:
   crate::agent::subagent::LaunchConfig`); `LaunchConfig` derives `Default` + `Deserialize`, so
   the key is wire-additive and absent ⇒ `None` via `LaunchConfig::default()` (delta §4a). We do
   NOT restart the loop in-process. **The gate consumption (a `set_permission` accessor on
   `AgentLoop`, then `core.rs`'s production call) is task05b's — it requires files outside this
   half's owned set, stated in Findings.**
2. **Layer — the rung set is `[File]`-only, with `OverrideSource::File` on non-Option, non-null
   `Option<PermissionBlock>` map fields.** There is NO settings.json permission layer (the issue's
   scope is "what a file declares"), so `permission_source: OverrideSource` is always `File` when
   the file speaks, `Parent` when it does not — reusing the EXISTING three variants exactly
   (`Override` / `File` / `Parent`). This satisfies "`OverrideSource` can report `Override` /
   `File` / `Parent`", keeps `the_source_label_space_is_exactly_three_layers_and_never_space`
   (`commands/agents.rs:1341`) a compile-time pin (no fourth variant), and deliberately does NOT
   add a `settings.json` key or an `OverrideSource::Permission` variant (that pin's exhaustive
   match makes such an addition a compile error, which is the honest way to keep "three layers" a
   fact). `permission` is **never a `first_speaking` rung**.
3. **Wire half of report / notes**: `frontmatter_notes` reaches `AgentConfigDto` as a NEW REQUIRED
   non-`Option` field on the DTO row, carried verbatim from `def` — the `shadowed` precedent
   (ADR 0065's report shape: "REQUIRED on the wire, not `Option`: the Rust side ALWAYS serializes
   the `Vec` (empty as `[]`)"). **We DO ship the rot-proof DTO-carry test B1 required** (it fails
   if `frontmatter_notes` stops reaching the DTO), per the delta's hand-off obligation #2 — a hard
   acceptance criterion, not a nice-to-have.
4. **Whole-tool deny drops the tool from the resolver-narrowed `launch.tools`** — a pre-wire
   advertisement filter inside `resolve_agent_launch`, mirroring the existing `narrow` closure
   (launch.rs:234). `subagent_flow.rs` then advertises the narrowed `child_tools` VERBATIM (its
   existing three-way rule — no edit needed there). This keeps the whole-tool drop inside this
   half's owned `launch.rs`. The GATE half of a whole-tool deny (`policy_verdict` →
   `Some(Decision::Deny)`) is task05b's.
5. **NO bash command-pattern matching** (decision carried as-is, governs both halves): B1 parses a
   `bash:` object with ≥1 pattern row and announces it `UnsupportedUnvalidatedMatcher(
   BashPatternRules)`; enforcing such rows needs a matcher nothing has validated (the redirect
   trap in the status file's decisions log). Whole-tool `bash: deny` (a bare `Action`,
   `Rules::is_deny()`) IS carried for the advertisement drop (Step 3).
6. **The web half is NOT updated** (`AgentsDialog` / `types.ts` — task06's job). task06 re-reads
   the actual serde shape from this half's DTO plus B1's pin tests, including the mixed-casing
   table below.

## The serde spellings (QUOTE THESE — task06 mirrors them into TypeScript, and this repo has NO wire-contract test linking Rust serde to the TS types)

From `agent/definition_permission.rs` (pinned by B1's own tests
`frontmatter_notes_serialize_as_a_tagged_object_per_note` and
`a_permission_block_serializes_in_file_order`):

- **`FrontmatterNote` is EXTERNALLY tagged** (`#[serde(rename_all = "camelCase")]`, NO
  `#[serde(tag)]`) — one object per note: `{"unknownKey":"mode"}`,
  `{"unrecognizedToolKey":"glob"}`, `{"unsupportedUnvalidatedMatcher":"bashPatternRules"}`,
  `{"unknownAction":"maybe"}`. An internally-tagged representation would compile and then fail at
  RUNTIME on the `String` payloads — the exact silent-no-op class #101 exists to fix.
- **`Rule` / `Rules` / `PermissionBlock` carry NO `rename_all`** — so `whole_tool` is
  **snake_case** even though the parent `AgentDefinition` is camelCase (a struct-level
  `rename_all` never reaches a nested type). A block serializes as:
  `{"tools":[["edit",{"patterns":[{"pattern":"*","action":"deny"}],"whole_tool":true}],…]}`.
- `Action` is `lowercase` (`"allow"`/`"ask"`/`"deny"`); `ToolKey` is `camelCase` (`readSkill`,
  `webSearch`, `fetchContent`), and `ToolKey::Unrecognized("glob")` serializes as the
  externally-tagged object `{"unrecognized":"glob"}` (its tuple element is an enum, so serde
  wraps it). `OverrideSource` is `lowercase`: `"override"`/`"file"`/`"parent"`.
- If a serde attribute genuinely blocked the wire (a `Serialize` derive failing to emit
  `filePermission`/`frontmatterNotes` with this mixed casing), we do NOT touch
  `definition_permission.rs` — we pin the AVOIDED spelling with a test and report the blocker in
  the findings. In practice nothing blocks: `Serialize` is derived on every carried type.

## Decisions log (this task)

- **2026-11-XX — the wire-half is scope-clean for this half.** `LaunchConfig.permission` is
  wire-additive (old daemons/supervisors tolerate an unknown key; `LaunchConfig::default()`
  gives `None`). The whole-tool drop is a resolver-side narrowing of `launch.tools` inside this
  half's owned `launch.rs`, production-effective WITHOUT `subagent_flow.rs` (which re-advertises
  the narrowed `tools` VERBATIM). **The ONLY edit that would require `subagent_flow.rs` is
  carrying the ruleset onto `StartEnv`/`worker/core.rs` so the gate can see it in production —
  that is task05b's REQUIRED scope change (see Findings), and it is the one line this half
  deliberately does not ship.**
- **2026-11-XX — `filePermission` is REPORT, not verdict.** The DTO field is cloned from the
  definition BEFORE the resolver, doc-commented "NOT the effective verdict (the gate's
  strict-of-two merge is a runtime decision, not a static one)". Nothing in this commit computes
  an effective per-agent verdict; that is task05b's.
- **2026-11-XX — non-policed tool keys stay announced + unenforced.** A per-agent rule on
  `web_search` / `fetch_content` / `read_skill` / `ask` / `mcp` / `subagent` has no
  `policed_direction` twin; their enforcement needs a NEW tool-level check that does not exist
  today. Recorded as a named limitation handed to task05b, not silently dropped.

## Owned file set (Files: — exactly these four, NO other file may be edited)

1. `src-tauri/src/agent/subagent.rs` — the `LaunchConfig.permission` field.
2. `src-tauri/src/agent/harness/launch.rs` — `ResolvedLaunch.permission_source`, the resolver
   copy-through rung, the whole-tool deny drop + `tool_key_name` helper, the drop's resolver
   test.
3. `src-tauri/src/commands/agents.rs` — DTO widening (`OverrideFields`, `SourceFields`,
   `AgentConfigDto`), the `agent_config`/`file_fields`/`From` wiring, the wire-shape pin update,
   the rot-proof DTO carry test.
4. `src-tauri/src/bin/fake_worker.rs` — the ONE fully-specified `LaunchConfig` literal
   (line 509; verified: it has NO `..Default::default()`, and every other literal in the tree
   uses the spread — `interactive/mod.rs:135` included — so this is the only non-test literal a
   new field breaks that `cargo test --lib` will NOT catch; `cargo build --all-targets` does).

Do NOT touch: `agents.rs` (the parser — B1's file), `agent/definition_permission.rs`,
`skills.rs`, `agent/policy.rs`, `agent/permission.rs`, `agent/harness/loop.rs`,
`agent/harness/loop/gate.rs`, `agent/harness/loop/tests/policy_gate.rs`, `agent/worker/*`
(`protocol.rs`, `core.rs`, `manager/subagent_flow.rs`, `dispatch.rs`), `agent/interactive/mod.rs`,
`agent/harness/dispatch.rs`. The loop/gate/worker files are task05b-owned; the rest are out of
scope entirely.

## Steps (5)

### Step 1 — carry: `LaunchConfig.permission` + `ResolvedLaunch.permission_source` + the resolver copy-through + the `fake_worker` literal

**File: `src-tauri/src/agent/subagent.rs`**

Add to `LaunchConfig` (after `tools`; the struct derives `Clone, Debug, Default, PartialEq,
Serialize, Deserialize` at line 37, so this is wire-additive and every `..Default::default()`
literal absorbs it silently):

```rust
    /// Frontmatter `permission` (issue #101's ruleset) as the definition
    /// DECLARES it — a NARROWING layer only: the gate's strict-of-two merge
    /// consumes it (task05b), so it can make a call MORE restricted than the
    /// user's `filePolicy` would, never less. `None` → the file does not
    /// speak about permissions (no narrowing). Crosses the wire inside
    /// `SubagentDispatchWire.launch`; a config-less dispatch stays `None`.
    pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
```

**File: `src-tauri/src/agent/harness/launch.rs`**

- `ResolvedLaunch` (lines 50-60; its ONE construction site is line 270) — add, doc: "Which layer
  supplied `permission`; `Parent` when the definition does not speak about permissions. There is
  NO settings.json permission layer (ADR 0066's scope is the file), so this is `File` exactly
  when `launch.permission.is_some()`.":
  ```rust
  pub permission_source: OverrideSource,
  ```
- In `resolve_agent_launch`, add a `permission` rung BEFORE the `ResolvedLaunch` construction and
  copy into BOTH literals (line 271 `LaunchConfig {` gains `permission,`; line ~280
  `ResolvedLaunch {` gains `permission_source,`):
  ```rust
  // ── permission ────────────────────────────────────────────────────────
  // A file-declared ruleset (issue #101). NO rung ladder: there is no
  // settings.json `permission` key (the issue's scope is "what a file
  // declares"), and the explicit `subagent` call has no permission param —
  // so the layer is EXACTLY `File` when the file speaks and `Parent`
  // otherwise, reusing the existing three `OverrideSource` variants. Never
  // a `first_speaking` candidate: no `OverrideSource::Permission` variant
  // exists, and `the_source_label_space_is_exactly_three_layers_and_never_space`
  // pins the three-variant enum by a compile-error-exhaustive match.
  let (permission, permission_source) = match def.permission.clone() {
      Some(block) => (Some(block), OverrideSource::File),
      None => (None, OverrideSource::Parent),
  };
  ```

**File: `src-tauri/src/bin/fake_worker.rs:509`** — the tree's only fully-specified `LaunchConfig`
literal (no spread). Add `permission: None,` right after `tools,`.

**Compile impact (verified):** the field is additive + `Default`, so `subagent.rs:1023,1071`,
`dispatch.rs:169`, `interactive/mod.rs:135` (has the spread), and all 21 `LaunchConfig {` test
literals in `launch.rs` (ALL use `..Default::default()` at HEAD) survive. `fake_worker` is handled
above. `cargo build --all-targets` must be green for `fake_worker` specifically (AGENTS.md: a
`LaunchConfig` change surfaces as misleading `manager::tests` failures unless the bin rebuilds).

### Step 2 — layer: widen `OverrideFields` + `SourceFields` + `AgentConfigDto`, and update the DTO wire-shape pin test

**File: `src-tauri/src/commands/agents.rs`**

- `OverrideFields` (line 117): add
  ```rust
  pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
  ```
  Keep `#[serde(rename_all = "camelCase")]` and `Default` (an all-`None` default row serializes
  `permission: null`).
- `impl From<&AgentOverrideFields> for OverrideFields` (line 127): add `permission: None,` (the
  persisted `agentOverrides` entry has NO `permission` key — `config.rs:141-153` has only
  `model`/`thinking`/`tools`; absence is the ONLY meaning).
- `file_fields` (line 201): add `permission: def.permission.clone(),`.
- `stored_fields` (line 213): unchanged (`unwrap_or_default` now yields the 4th `None`).
- `SourceFields` (line 142) — gains a 4th field: `pub permission: OverrideSource,`. **The
  3-variant `OverrideSource` enum is NOT touched** — the exhaustive `match` at line 1341
  (`the_source_label_space_is_exactly_three_layers_and_never_space`) still compiles, now over the
  4-field `SourceFields`.
- `agent_config` (lines 255/260): `effective` gains `permission: resolved.launch.permission,`;
  `source` gains `permission: resolved.permission_source,`.
- `AgentConfigDto` (line 158): add TWO fields after `shadowed` (struct already
  `#[serde(rename_all = "camelCase")]`):
  ```rust
  /// The definition's declared `permission:` ruleset, VERBATIM from the
  /// file (opencode's allow/ask/deny block, issue #101) — `null` when the
  /// file does not speak about permissions. NOT the effective verdict (the
  /// gate's strict-of-two merge is a runtime decision, not a static one).
  pub file_permission: Option<crate::agent::definition_permission::PermissionBlock>,
  /// The file-READ announce notes (unknown keys, unrecognised tool keys,
  /// unsupported bash-pattern rows — issue #101's announce half). REQUIRED
  /// on the wire, not `Option`: the Rust side ALWAYS serializes the `Vec`
  /// (empty as `[]`), exactly like `shadowed` (ADR 0065's report shape).
  pub frontmatter_notes: Vec<crate::agent::definition_permission::FrontmatterNote>,
  ```
  In `agent_config`: set `file_permission: def.permission.clone(),` and
  `frontmatter_notes: def.frontmatter_notes.clone(),` — cloned from the definition BEFORE the
  resolver (the frontmatter half of the verdict the row reports).

- **UPDATE the DTO wire-shape pin test `the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads`
  (line 1390)** — the delta report quotes its EXACT column lists; adding the fields updates BOTH
  the row-level list AND the per-column iteration:
  - row-level list becomes `["name","description","scope","path","file","override","effective",
    "source","shadowed","filePermission","frontmatterNotes"]`;
  - the `file`/`override`/`effective` per-column loop iterates `["model","thinking","tools",
    "permission"]` (all must be present-and-null on the default row);
  - the `source` per-column loop additionally asserts `"permission"` = `"parent"` (a file that
    does not speak reports Parent).
  This is the pin B1 recorded: it fails if a new DTO field is absent, and the per-column
  iteration forces the column structs to carry the field.

**Compile impact (new, verified at HEAD — the source plan's Step 1-style census, for this
widening):** `agent_config_and_the_dispatch_resolve_the_same_row` (line ~839) holds FOUR cases
whose expectation structs are FULLY specified (no `..Default::default()`), and `SourceFields`
does not even derive `Default`:
- `OverrideFields { model, thinking, tools }` at lines 861, 881, 896, 913 — each gains
  `permission: None,` (the fixture definitions speak about nothing);
- `SourceFields { model, thinking, tools }` at lines 866, 886, 901, 918 — each gains
  `permission: OverrideSource::Parent,`.
No other `OverrideFields {`/`SourceFields {` literal exists in the tree (verified by grep), and
`AgentOverrideFields` (config.rs) is NOT widened — the `From` impl maps it with `permission: None`.

### Step 3 — whole-tool deny drops the tool from the child's advertised set (resolver side) + its resolver test

**File: `src-tauri/src/agent/harness/launch.rs`**

The only place the child's advertised set is derived from the definition is `resolve_agent_launch`'s
tools rung + `subagent_flow`'s VERBATIM re-advertisement. Implement the drop in `launch.rs`,
inside `resolve_agent_launch` AFTER the tools `narrow` result is picked:

```rust
// (issue #101) A whole-tool `deny` in the file's `permission:` block drops
// the tool from the child's advertised set BEFORE the wire — the
// `subagent_flow` three-way rule re-advertises `launch.tools` VERBATIM, so
// the model is never offered a call the gate would deny. Only whole-tool
// denies act here (a `Rules::is_deny()` on the Ordered `Vec`); per-command
// pattern rows announce as unsupported and are NOT advertisement-changed.
let tools = tools.and_then(|mut names| {
    if let Some(block) = def.permission.as_ref() {
        for (key, rules) in &block.tools {
            if rules.is_deny() {
                if let Some(name) = tool_key_name(key) {
                    names.retain(|n| n != name);
                }
            }
        }
        // Same ADR 0067-emptied-means-ABSENT rule as `narrow`: a list that
        // empties out is ABSENT, NOT "zero tools" (only the explicit list is
        // allowed to zero a child). The explicit list is NEVER filtered, so
        // this only ever narrows the override/frontmatter rung.
        (!names.is_empty()).then_some(names)
    } else {
        Some(names)
    }
});
```

with the helper next to `first_speaking`:

```rust
/// The advertised `tool_specs` NAME of a recognised `ToolKey`, `None` for
/// an unrecognised one (they stay parsed + announced; their enforcement
/// has no advertised twin). The name class is the `tool_specs()` set; a
/// key NOT in it has no advertised name to drop.
fn tool_key_name(key: &ToolKey) -> Option<&'static str> {
    match key {
        ToolKey::Bash => Some("bash"),
        ToolKey::Read => Some("read"),
        ToolKey::Write => Some("write"),
        ToolKey::Edit => Some("edit"),
        ToolKey::Find => Some("find"),
        ToolKey::Grep => Some("grep"),
        ToolKey::Ls => Some("ls"),
        ToolKey::ReadSkill => Some("read_skill"),
        ToolKey::Ask => Some("ask"),
        ToolKey::WebSearch => Some("web_search"),
        ToolKey::FetchContent => Some("fetch_content"),
        ToolKey::Unrecognized(_) => None,
    }
}
```

**Resolver test (in launch.rs's `#[cfg(test)] mod tests`, `use crate::agent::definition_permission::
{Action, PermissionBlock, Rules, ToolKey};`):** `a_whole_tool_deny_drops_the_tool_from_the_resolved_launch`
— build `AgentDefinition { permission: Some(PermissionBlock { tools: vec![(
ToolKey::Bash, Rules::whole_tool(Action::Deny))] }), ..def_with(None, None, Some(&["bash",
"read"])) }`, resolve with the empty floor (`LaunchConfig::default()` + `OverrideLayer { global:
None }` + a `catalog`), assert `r.launch.tools == Some(vec!["read".to_string()])` (no `bash`),
`r.tools_source == OverrideSource::File`, `r.launch.permission == Some(block)`, and
`r.permission_source == OverrideSource::File`. This is the launch.rs half of the source plan's
"a whole-tool deny is never offered" gate test; the gate half (`policy_verdict` →
`Some(Decision::Deny)`) is task05b's, in `policy_gate.rs`.

### Step 4 — the rot-proof DTO carry test (B1's obligation #2, a HARD criterion)

**File: `src-tauri/src/commands/agents.rs`** — in the existing `#[cfg(test)] mod tests`:

**`a_definition_with_permission_and_notes_carries_both_to_the_dto`** — THE rot-proof carry test
B1 required (delta hand-off #2). Build a `definition("scout", AgentScope::User)` whose
`permission` is `Some(PermissionBlock { tools: vec![(ToolKey::Bash,
Rules::whole_tool(Action::Deny))] })` and whose `frontmatter_notes` is
`vec![FrontmatterNote::UnknownKey("mode".to_string())]`, run `agent_config` with the default
settings (the `definition()` helper already carries `permission: None` + `frontmatter_notes:
Vec::new()` at HEAD, so the test overrides both fields), and assert:
- `rows[0].file_permission` is `Some(block)` (the DTO carries the declared block);
- `rows[0].frontmatter_notes` == the source `vec![...]`;
- the JSON string contains `"filePermission"` and `"frontmatterNotes"` — proving the KEY crossed
  the wire.
This test fails if `frontmatter_notes` stops reaching the DTO — the exact silent-no-op class #101
exists to fix (B1 recorded the requirement verbatim in the delta). The updated
`the_dto_wire_shape_...` pin (Step 2) is the second, structural test; keep it green.

### Step 5 — verification + required gates

Run from `src-tauri/` (AGENTS.md — `archimedes` is ONE compilation unit):

- `cargo test --lib agent::harness::launch::tests -- a_whole_tool_deny_drops_the_tool_from_the_resolved_launch`
- `cargo test --lib commands::agents::tests -- a_definition_with_permission_and_notes_carries_both_to_the_dto`
- `cargo test --lib commands::agents::tests -- the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads`
- `cargo test --lib` (the full lib suite — the wide-touch DTO columns mean the whole
  `commands::agents` module + `agents.rs`'s discovery pins must stay green)
- **`cargo build --all-targets` — REQUIRED.** `fake_worker` is a bin target invisible to
  `cargo test --lib`; the line 509 literal is this half's only non-test compile-collision.
- `cargo clippy --all-targets` at 0 warnings; `cargo fmt --check` clean.
- Do NOT start long-running processes (no watch/dev server).

## Acceptance criteria

DATA criteria (all must hold after this commit):

1. `LaunchConfig.permission: Option<PermissionBlock>` exists and rides the SAME
   `SubagentDispatchWire.launch` path `tools:` takes (wire-additive; old daemons tolerate it;
   absent ⇒ `None`); `fake_worker.rs` compiles via `cargo build --all-targets`.
2. `resolve_agent_launch` reports `permission_source` ∈ {`File`, `Parent`} — never `Override`
   (no settings layer exists) — copying `def.permission` through verbatim.
3. `AgentConfigDto` carries the REQUIRED non-`Option` `frontmatterNotes` (following the `shadowed`
   precedent), `filePermission`, and the widened `file`/`override`/`effective`/`source` column
   structs, WITH the updated wire-shape pin green (row-level list + per-column `permission`
   present-and-null + source `"parent"`).
4. **The rot-proof test
   `a_definition_with_permission_and_notes_carries_both_to_the_dto` FAILS if `frontmatter_notes`
   stops reaching the DTO.** (Hard criterion, not a nice-to-have.)

BEHAVIOUR criterion (the one live effect):

5. A whole-tool `deny` on a recognised tool key drops the tool from the resolver-narrowed
   `launch.tools` (asserted in the launch.rs resolver test) — never offered to the child.

DELIBERATELY DEFERRED (state plainly: enforcement did NOT land here):

6. NO gate, loop, or worker code consumes `LaunchConfig.permission` after this commit. There is
   no `AgentLoop.permission_block`, no `StartEnv.permission`, no `policy_verdict` strict-of-two
   merge, no per-agent `Ask` prompt, and no per-agent `Deny` tool-result. **After this commit a
   definition's `permission:` verdicts change NO runtime behaviour beyond criterion 5's
   advertisement drop; the only other visible surface is the modal's report columns. The commit
   that changes that is task05b** (its production `loop_.set_permission(...)` in `worker/core.rs`,
   fed by a `StartEnv.permission` field — see the hand-off).

7. `cargo clippy --all-targets` = 0 warnings; `cargo fmt --check` clean.

## Hand-off to task05b (enforce + live — exactly what it will need from this half)

- **The field:** `LaunchConfig.permission: Option<crate::agent::definition_permission::PermissionBlock>`
  (subagent.rs) — carried verbatim, wire-additive, `None` for config-less dispatch.
- **The resolver's output:** `ResolvedLaunch.permission_source: OverrideSource` (`File` exactly
  when `launch.permission.is_some()`, `Parent` otherwise), and `resolve_agent_launch` copies
  `def.permission` into `launch.permission` verbatim.
- **The wire fact:** `SubagentDispatchWire` already carries `launch: LaunchConfig` VERBATIM
  (protocol.rs:341), so `permission` rides the wire the moment the field exists — task05b needs
  NO protocol change to receive it; it must add `StartEnv.permission` (protocol.rs ~246, from
  `subagent_flow.rs`'s `StartEnv::from_parts` call) and the production
  `loop_.set_permission(env.permission.clone())` next to `core.rs:325`'s `set_enabled_tools`.
- **What task05b adds OUTSIDE this half's set:** the `AgentLoop::set_permission`/`permission_block`
  accessor pair (mirroring `set_enabled_tools`/`enabled_tools`, loop.rs:478-487), the gate's
  strict-of-two merge in `gate.rs::policy_verdict` (consulted AFTER `rule_or_guard_verdict`'s
  rows 1-3, merged as STRICTER under `Allow < Confine < Ask < Deny`, per-agent `Deny` reusing
  `deny_tool_result`'s existing wording — the source plan's Steps 3 + 6), `subagent_flow.rs`'s
  `StartEnv` construction, and the `policy_gate.rs` gate tests.
- **Shared vocabulary task05b reuses:** this half's `tool_key_name` (the advertised-name set)
  parallels task05b's gate-side `tool_key_matches`; the `[File]`-only rung decision (scope
  decision 2) means the gate merge never sees a settings.json permission layer; the serde
  spellings table above is the reference for the DTO-wire tests; the named limitation
  (recognised-but-unpoliced `ToolKey`s have no gate hook today) carries over unchanged.

## Findings / risks (for the caller)

- **REQUIRED SCOPE CHANGE (task05b's, stated here so it is not re-litigated): the production
  gate can only be reached through `agent/worker/core.rs` + `agent/worker/manager/subagent_flow.rs`**,
  which are OUTSIDE this half's owned set. This half ships the field on the wire; the one line
  that materializes it into the gate — `loop_.set_permission(...)` — is task05b's. Shipping it
  here would produce a field that is real, unit-tested, and NEVER CONSULTED — the confident-no-op
  class #101 exists to fix. **Enforcement is deliberately NOT in this commit; the whole-tool
  advertisement drop (criterion 5) is the only production-effective piece, and it needs no new
  production line.**
- **Compile-collision census (verified at HEAD, beyond the source plan's text):** the 8
  fully-specified `OverrideFields`/`SourceFields` expectation literals in
  `agent_config_and_the_dispatch_resolve_the_same_row` (861/881/896/913 + 866/886/901/918) all
  gain the new field; `SourceFields` does not derive `Default` so a spread is not available
  there. `AgentOverrideFields` is deliberately NOT widened.
- `PermissionBlock` derived `Clone`/`Default` — the carry + DTO clones compile.
- **Serde blocking:** NONE found — `Serialize` is derived on all four carried types; the mixed
  casing (`whole_tool` snake_case) is pinned by B1's own tests and handed to task06 verbatim.
- **No `some rung` for permission by design** — the `[File]`-only layer + `permission_source`
  keeps the 3-variant `OverrideSource` pin green (a fourth variant would break the exhaustive
  match at agents.rs:1341, which is the pin's entire point).
- **`fake_worker` bin invisibility** — `cargo test --lib` does NOT rebuild the binary; the line
  509 literal's `permission: None,` must be validated with `cargo build --all-targets`.

## Sources

- `src-tauri/src/agent/subagent.rs` (35-61 `LaunchConfig`, derives; 175+ `dispatch_native` /
  `SubagentDispatchWire`; 1023/1071 literals)
- `src-tauri/src/agent/harness/launch.rs` (50-60 `ResolvedLaunch`; 130 `first_speaking`; 146
  `resolve_agent_launch`; 234-248 `narrow`; 270-281 the sole `ResolvedLaunch` construction site;
  1627-1649 `def_with`)
- `src-tauri/src/commands/agents.rs` (117/127/142/158 column structs + DTO; 201/213/235
  `file_fields`/`stored_fields`/`agent_config`; 765 `definition()` helper — already carries
  `permission: None` + `frontmatter_notes`; 839+ `agent_config_and_the_dispatch_resolve_the_same_row`'s
  8 fully-specified literals at 861/866/881/886/896/901/913/918; 1341 the three-layer pin; 1390
  the DTO wire-shape pin)
- `src-tauri/src/bin/fake_worker.rs:509` (the ONLY fully-specified `LaunchConfig` literal)
- `src-tauri/src/agent/definition_permission.rs` (types 43-135; `whole_tool`/`is_deny`/
  `catch_all_action`; `ToolKey::from_frontmatter_key` 168-178; B1's wire-spelling pins at
  1200/1229)
- `src-tauri/src/agent/mod.rs:9` (public module + re-export)
- `src-tauri/src/agent/worker/protocol.rs:341` (`SubagentDispatchWire.launch` — the wire fact)
- `src-tauri/src/agent/worker/core.rs:325` (`set_enabled_tools` — task05b's seam)
- `src-tauri/src/agent/worker/manager/subagent_flow.rs:629` (the child_tools three-way rule)
- Grounding: `docs/roadmap/agent-permission-and-pins-ground-definition-delta.md` (HEAD `27d761c`),
  `docs/roadmap/agent-permission-and-pins-ground-definition.md`, and the source plan
  `docs/roadmap/agent-permission-and-pins-task05-carry-and-enforce.md` (untouched).