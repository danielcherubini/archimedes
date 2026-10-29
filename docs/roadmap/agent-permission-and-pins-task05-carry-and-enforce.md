# B2 / task05 — carry, layer, enforce, and the wire-half of report (#101(b))

Branch `feature/agent-permission-and-pins`, HEAD `27d761c` (matches the delta report). This is the
ENFORCEMENT task of #101: B1 (`2ccf1ff`) already parses `permission:` into
`AgentDefinition.permission: Option<PermissionBlock>` + `frontmatter_notes: Vec<FrontmatterNote>`.
This task is the remaining seams: **carry** (`LaunchConfig`), **layer** (`resolve_agent_launch` +
the AgentConfigDto column structs), **enforce** (`gate.rs` stricter-of-two), the **advertised-set
drop** for whole-tool denies, and the **wire half of report** (the notes reach `AgentConfigDto`).

Grounding: `docs/roadmap/agent-permission-and-pins-ground-definition-delta.md` (HEAD `27d761c`)
supersedes `…-ground-definition.md` wherever they differ. **All line numbers below were verified
against the tree at HEAD.**

## Scope decisions (the plan's calls, each with its reasoning)

1. **Carry — `permission` is a `LaunchConfig` + `ResolvedLaunch` field, carried to the child on the
   same path `tools:` takes** (`LaunhConfig.tools` → `SubagentDispatchWire.launch` →
   `subagent_flow.rs`). The field is `Option<crate::agent::definition_permission::PermissionBlock>`.
   It rides `SubagentDispatchWire.launch` outside our owned sets, but the **type itself** is
   `LaunchConfig` (owned). We do NOT restart the loop in-process. The **gate consumes it from a
   `set_permission` accessor on `AgentLoop`** (not owned — `loop.rs` is NOT in our set), so the
   production wiring (`core.rs` → `set_permission`) is a REQUIRED SCOPE CHANGE, stated in Findings.
2. **Layer — the rung set is `[File]` only, with `OverrideSource::File` on non-Option, non-null
   `Option<PermissionBlock>` map fields.** There is NO settings.json permission layer (the issue's
   scope is "what a file declares"), so `permission_source: OverrideSource` is always `File` when
   the file speaks, `Parent` when it does not — reusing the EXISTING three variants exactly
   (`Override` / `File` / `Parent`). This satisfies "`OverrideSource` can report `Override` / `File`
   / `Parent`", keeps `the_source_label_space_is_exactly_three_layers_and_never_space`
   (`commands/agents.rs:1341`) a compile-time pin (no fourth variant), and deliberately does NOT
   add a `settings.json` key or an `OverrideSource::Permission` variant (that pin's exhaustive match
   makes such an addition a compile error, which is the honest way to keep "three layers" a fact).
3. **Enforce — the per-agent verdict is merged as the STRICTER of the posture/rule verdict and the
   definition's verdict, under the total order `Allow < Confine < Ask < Deny`** (delta §5: `Deny`
   strictest, `Ask` next, `Confine` (a RUNNING sandbox) below `Ask`, `Allow` the identity). The
   per-agent vocabulary (`Action = Allow | Ask | Deny`, no `Confine`) is projected onto that order —
   a naive `min` over `{Allow, Ask, Deny}` is wrong for `bash` because `Confine` sits between
   `Allow` and `Ask` and the per-agent layer cannot express "sandbox it", so `Allow` never
   un-confines a `Sandboxed` shell and `Ask`/`Deny` can still tighten a confined run.
4. **The per-agent layer is consulted AFTER the write-rule/guard precedence (`rule_or_guard_verdict`
   rows 1–3) and term-wise STRICTER against the result**, never BEFORE it and never overriding its
   row-1 `Deny` or row-3 guard `Ask`. This is ADR 0030's "trust suppresses prompts but never widens
   a deny" applied to definitions — the core #101 design claim. The placement guarantees a
   definition's `Allow` can NEVER bypass the row-3 protected-dir guard or a row-1 user `deny`, and
   can STILL tighten a trust-widened `Allow`.
5. **Whole-tool deny drops the tool from the resolver-narrowed `launch.tools`** — a pre-wire
   advertisement filter inside `resolve_agent_launch`, mirroring the existing `narrow` closure
   (launch.rs:234–248). This is the §6a/§6b seam (the `narrow`-style filter on `def.permission` is
   ALREADY in our owned resolver). `subagent_flow.rs` then advertises the narrowed `child_tools`
   VERBATIM (its existing three-way rule — no edit needed there for the drop). This keeps the
   whole-tool drop inside our owned `launch.rs` — **enforcement is NOT impossible without
   `subagent_flow.rs`** (the resolver narrowing is a full enforcement path), but the *pattern*
   enforcement for bash-style per-command rules (out of scope by decision) has no advertisement
   effect.
6. **NO bash command-pattern matching.** B1 parses a `bash:` object with ≥1 pattern row and
   announces it `UnsupportedUnvalidatedMatcher(BashPatternRules)`; enforcing such rows needs a
   matcher nothing has validated (the redirect trap in the status file's decisions log). Whole-tool
   `bash: deny` (a bare `Action`, `Rules::is_deny()`) IS enforced. The reason is recorded: a
   command matcher must separate "redirect to a file" from "redirect to an fd" and archimedes has
   no tree-sitter command parse.
7. **Wire half of report / notes**: `frontmatter_notes` reaches `AgentConfigDto` as NEW REQUIRED
   non-`Option` fields on the DTO row, carried verbatim from `def`. **We DO ship the rot-proof
   DTO-carry test B1 required** (it fails if `frontmatter_notes` stops reaching the DTO), per the
   delta's hand-off obligation #2.
8. **Pattern paths are judged canonicalise-then-check under `canonicalize_lenient`, the SAME
   canonicaliser/root set the gate already uses** (`FsBackend::validate` / `canonicalize_lenient`,
   per grounding §9) — one resolver, no second canonicaliser. The decision recorded in the status
   file is that patterns are judged against the **boundary root set**, not opencode's
   workspace-relative root. (Concretely: whole-tool denies need no path; the recognized
   path-taking policed tools call `policed_direction` and their verdicts are path-agnostic in this
   task's enforcement.)

## Decisions log (this task)

- **2026-11-XX — whole-tool enforcement is scope-clean.** The whole-tool drop ("never offer a
  call the child cannot make") is implemented as a resolver-side narrowing of `launch.tools`, which
  is inside our owned `launch.rs` and takes effect pre-wire (`subagent_flow.rs` re-advertises the
  narrowed `tools` VERBATIM). No edit to `subagent_flow.rs` is required for the drop. The **only**
  edit that would require `subagent_flow.rs` is carrying the ruleset onto `StartEnv`/`core.rs` so
  the gate can see it in production — and because that file is NOT in our owned set, the gate
  consumption in production is a REQUIRED SCOPE CHANGE (see Findings), with the pattern-layer
  enforcement in `gate.rs` landing via a `set_permission` accessor on `AgentLoop` that B2 wires but
  does NOT production-consume.
- **2026-11-XX — `deny_tool_result` is the ONLY denial renderer.** A per-agent `Deny` produces
  the SAME tool-result error `deny_tool_result(tc)` would produce, so the model's recovery cannot
  distinguish a definition-level deny from a user-rule deny or a guard deny (ADR 0030's "gate
  denial and executor denial read identically"). No new wording is invented.
- **2026-11-XX — untrusted `filePolicy` + per-agent `Ask` does NOT prompt.** If the per-agent
  layer narrows a call to `Ask`, and the user's `filePolicy` verdict is `Allow` (silent) or the
  call is inside the boundary, the merged verdict is `Ask`. But this task's enforcement does NOT
  install an `Allow` in its merge for `bash` under a `Sandboxed` shell (that would be the `Confine`
  widening), and a per-agent `Ask` on an UN-policed tool (`web_search`, `fetch_content`,
  `read_skill`, `ask`, `mcp`, `subagent`) has NO `policed_direction` twin, so the gate's
  `policy_verdict` never returns a decision for those tools today. The recognized `ToolKey` set
  that CAN map onto `policed_direction` for enforcement is `bash`→Shell, `read`/`find`/`grep`/`ls`
  →Read, `write`/`edit`→Write. The remaining recognized keys (`write`'s file-twin `Write`,
  `ReadSkill`, `Ask`, `WebSearch`, `FetchContent`) parse + announce and have NO policed twin —
  enforcement for them is a NEW tool-level check, which is OUT OF OUR FILE SET (gate.rs is owned,
  but the non-policed tool path has no hook inside it today; building one would touch the
  dispatch/turn seam). Recorded as a named limitation, not silently dropped.

## Owned file set (Files: — NO other file may be edited)

1. `src-tauri/src/agent/subagent.rs` — the `LaunchConfig` field.
2. `src-tauri/src/agent/harness/launch.rs` — the resolver rungs + `ResolvedLaunch` + the
   whole-tool `narrow` + the File-source rung.
3. `src-tauri/src/commands/agents.rs` — the DTO widening.
4. `src-tauri/src/agent/harness/loop.rs` — the `set_permission` / `permission_block` accessor pair
   (thread the ruleset into the gate).
5. `src-tauri/src/agent/harness/loop/gate.rs` — the enforcement merge + `deny_tool_result` reuse.
6. `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — new gate tests.
7. `src-tauri/src/bin/fake_worker.rs` — the ONE fully-specified `LaunchConfig` literal (line 509;
   verified: every other literal in the tree uses `..Default::default()`; it is a bin target so
   `cargo test --lib` will NOT catch it — `cargo build --all-targets` does).

Do NOT touch: `agents.rs`, `agent/definition_permission.rs` (unless a serde attribute genuinely
blocks the wire — see Step 5), `skills.rs`, `agent/policy.rs`, `agent/permission.rs`,
`agent/worker/manager/subagent_flow.rs`, `agent/worker/protocol.rs` (only the LITERAL at
`protocol.rs:492` would break — it is already on our not-touched list; adding the field is
additive and compiles today, which is verified in Step 0), `agent/worker/core.rs`, and
`agent/interactive/mod.rs` (its literal at line 135 already uses `..Default::default()`).

## Steps (6, at the ceiling)

### Step 0 — verify the ground truth (no edits)

Read-only verification at HEAD `27d761c` (the source tree is byte-identical to `2ccf1ff`):

- `src-tauri/src/agent/subagent.rs:35-61` — `LaunchConfig { system_prompt, model, thinking,
  frontmatter_thinking, tools }`, derives `Clone, Debug, Default, PartialEq, Serialize,
  Deserialize` (line 37).
- `src-tauri/src/agent/subagent.rs:175-260` — `dispatch_native` builds `SubagentDispatchWire`:
  `parent_cwd`, `parent_enabled_tools`, `agent_name`, `name_resolution`, `launch`, `task`,
  `model_key` — `launch` (the `LaunchConfig`) rides the wire wrapped in the struct. The `launch`
  field is `crate::agent::worker::protocol::SubagentDispatchWire.launch:
  crate::agent::subagent::LaunchConfig` (protocol.rs:341) — **a `LaunchConfig` field addition is
  a serde wire-additive key**, tolerated by the daemons/supervisor and absent → `None` via
  `LaunchConfig::default()` (delta §4a).
- `src-tauri/src/agent/harness/launch.rs:50-60` — `ResolvedLaunch { launch, model_source,
  thinking_source, tools_source }`; its ONE construction site is line 270 (`resolve_agent_launch`'s
  `ResolvedLaunch { launch: LaunchConfig { system_prompt, model, thinking,
  frontmatter_thinking: def.thinking.clone(), tools }, model_source, thinking_source,
  tools_source }`).
- `src-tauri/src/agent/harness/launch.rs:146-165` — `resolve_agent_launch(explicit, def, layer,
  catalog) -> ResolvedLaunch`. The model/thinking/tools rungs are all inside this fn
  (`first_speaking` at 130-141).
- `src-tauri/src/agent/harness/launch.rs:234-248` — `narrow = |names: &[String]|` (the tools
  rung's filter: drop unknowns + `subagent`/`list_agents`, emptied → ABSENT).
- `src-tauri/src/commands/agents.rs:117-142` — `OverrideFields` (3 fields, `Default`,
  `#[serde(rename_all = "camelCase")]`), `SourceFields` (3 × `OverrideSource`). `file_fields`
  (201-207), `stored_fields` (213), `agent_config` (235-270) — `effective`/`source` read the
  resolved launch.
- `src-tauri/src/agent/harness/loop.rs:478-487` — `set_enabled_tools`/`enabled_tools` accessor
  pair (the pattern `set_permission`/`permission_block` copies).
- `src-tauri/src/agent/harness/loop/gate.rs:99-192` — `policy_verdict`; `rule_or_guard_verdict`
  198-237; `deny_tool_result` 335-382; `rule_deny_for` 384-408; `is_guard_path` 270-275;
  `protected_refusal_text`/`rule_deny_text` from `tools/exec/access.rs` (the shared wording).
- `cargo build --all-targets` at the END of the task (catch `fake_worker`) and
  `cargo clippy --all-targets` = 0 warnings; `cargo fmt --check`.
- Confirm the tree builds at HEAD: `cargo build --lib` (verified `Finished` in 14s at HEAD).

Run: `cargo test --lib` (nothing about the git state — the fixture pins below run against the
current tree).

### Step 1 — carry: `LaunchConfig.permission` + the resolver copy-through

**File: `src-tauri/src/agent/subagent.rs`**

Add to `LaunchConfig` (after `tools`, with B1's doc style):

```rust
    /// Frontmatter `permission` (issue #101's ruleset) as the definition
    /// DECLARES it — a NARROWING layer only: the gate's strict-of-two merge
    /// consumes it, so it can make a call MORE restricted than the user's
    /// `filePolicy` would, never less. `None` → the file does not speak
    /// about permissions (no narrowing). Crosses the wire inside
    /// `SubagentDispatchWire.launch`; a config-less dispatch stays `None`
    /// and the gate sees no per-agent layer.
    pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
```

- `LaunchConfig` derives `Default` (line 37) so this is wire-additive and every
  `..Default::default()` literal absorbs it silently. The OTHER production literal is
  `interactive/mod.rs:135` (has `..Default::default()` — survives).

**File: `src-tauri/src/agent/harness/launch.rs`**

- Add to `ResolvedLaunch` (line 50-60), doc: "Which layer supplied `permission`; `Parent` when
  the definition does not speak about permissions. There is NO settings.json permission layer
  (ADR 0066's scope is the file), so this is `File` exactly when
  `launch.permission.is_some()`.":
  ```rust
  pub permission_source: OverrideSource,
  ```
- In `resolve_agent_launch`, add a `permission` rung BEFORE the `ResolvedLaunch` construction:
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
- Add `permission,` inside the `LaunchConfig {}` literal (line 271) and `permission_source,`
  inside the `ResolvedLaunch {}` literal (line 275).
  **`ResolvedLaunch` has EXACTLY one construction site (line 270), so this touches only that site.**

**File: `src-tauri/src/bin/fake_worker.rs:509`**

The ONE fully-specified `LaunchConfig` literal in the tree (no `..Default::default()`); `cargo
test --lib` does not rebuild the bin (AGENTS.md). Add `permission: None,` in the same position
(after `tools`).

**Compile impact (verified):** the field is additive + `Default`, so `subagent.rs:1023,1071`,
`dispatch.rs:169`, the 21 `LaunchConfig {` test literals in `launch.rs` (ALL use
`..Default::default()` today — the base report's "4 fully-specified" count is stale in the GOOD
direction per delta §4a), `fake_worker`: done above, `interactive/mod.rs:135` (has the spread).
`cargo build --all-targets` after this step must be green for `fake_worker` specifically.

### Step 2 — layer: widen `OverrideFields` + `SourceFields` + `AgentConfigDto`, and update the DTO wire-shape pin test

**File: `src-tauri/src/commands/agents.rs`**

- `OverrideFields` (line 117): add
  ```rust
  pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
  ```
  Keep `#[serde(rename_all = "camelCase")]`, keep `Default` (an all-`None` default row serializes
  `permission: null`).
- `impl From<&AgentOverrideFields> for OverrideFields` (line 127): add `permission: None,` (the
  persisted `agentOverrides` entry has NO `permission` key — `config.rs:141-153` has only
  `model`/`thinking`/`tools`; absence is the ONLY meaning).
- `file_fields` (line 201): add `permission: def.permission.clone(),`.
- `stored_fields` (line 213): unchanged (`unwrap_or_default` now yields the 4th `None`).
- `agent_config`'s `effective` (line 255): add `permission: resolved.launch.permission,`.
- `agent_config`'s `source` (line 260): add `permission: resolved.permission_source,`.
- `AgentConfigDto` (line 158): add TWO REQUIRED non-`Option` fields with `#[serde(rename_all =
  "camelCase")]` on the struct already serializing them as camelCase:
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
  In `agent_config` (line 235-270): set `file_permission: def.permission.clone(),` and
  `frontmatter_notes: def.frontmatter_notes.clone(),` on the row (they are cloned from the
  definition BEFORE the resolver, i.e. the frontmatter half of the verdict the row reports).

- **UPDATE the DTO wire-shape pin test `the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads`
  (line 1390)** — the delta report quotes its EXACT column lists; adding the fields means updating
  BOTH the row-level column list AND the per-column iteration:
  - row-level list becomes `["name","description","scope","path","file","override","effective",
    "source","shadowed","filePermission","frontmatterNotes"]`;
  - the `file`/`override`/`effective` per-column loop iterates `["model","thinking","tools",
    "permission"]` (all must be present-and-null on the default row);
  - the `source` per-column loop additionally asserts `"permission"` = `"parent"` (a file that does
    not speak reports Parent).
  This is the pin B1 recorded: **it fails if a new DTO field is absent**, and the per-column
  iteration is what forces the column structs to carry the field.

**No `OverrideSource` change.** `SourceFields` (142) gains a 4th field but keeps the 3-variant
`OverrideSource` enum (the `the_source_label_space_is_exactly_three_layers_and_never_space`
exhaustive `match` at 1341 still compiles, now over the 4-field `SourceFields`).

**Web half deliberately NOT updated** (`AgentsDialog` / `types.ts` — B3's task). B3 re-reads the
actual serde shape (Step 0 of task06), including the mixed-casing table (delta §1d:
`whole_tool` snake_case; `ToolKey` camelCase; externally-tagged `FrontmatterNote`).

### Step 3 — enforce: consult `AgentLoop.permission_block` in `gate.rs`, STRICTER-of-two

**File: `src-tauri/src/agent/harness/loop.rs`**

- Add the accessor pair (mirroring `set_enabled_tools`, line 478):
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
- Add the field + init:
  ```rust
  /// (issue #101) The per-agent permission ruleset, `None` until set (the
  /// same construction-time stance as `file_policy`). Wired via
  /// [`Self::set_permission`] (the accessor the Worker seam will call once
  /// the wire carries it — B2 wires the type; the production `set_permission`
  /// call is the REQUIRED scope change in the status file).
  permission_block: Option<crate::agent::definition_permission::PermissionBlock>,
  ```
  and `permission_block: None,` in `AgentLoop::new` (line ~410, next to `file_policy`).

**File: `src-tauri/src/agent/harness/loop/gate.rs`**

- Add imports: `use crate::agent::definition_permission::ToolKey;` and
  `use crate::agent::policy::Decision as _Decision;` — leaning on the crate-pub re-export
  (`crate::agent::definition_permission` is public in `agent/mod.rs:9`). The `Decision` enum
  (`Allow|Ask|Deny|Confine`) is already imported.
- Replace `decision_for(...)`'s return with a **strict-of-two merge** at the very END of
  `policy_verdict` (the current tail, gate.rs ~134-139):
  ```rust
  let posture = decision_for(policy, beyond, trusted, dir == PolicyDirection::Shell);
  Some(stricter_of_two(
      posture,
      self.definition_verdict(&tc.name),
  ))
  ```
  where:
  ```rust
  /// The per-agent verdict for a tool, `AsSelf` (no narrowing) when the file
  /// does not speak about it or the tool has no policed twin. The
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

- **Placement requirement:** the merge runs on `policy_verdict`'s FINAL value, which is computed
  AFTER `rule_or_guard_verdict` (rows 1–3 return early, gate.rs 113-117), so:
  - a definition `Deny` CANNOT bypass the row-3 protected-dir guard `Ask` — wait, it CAN when the
    guard returns `Ask` and a definition `Deny` lands `stricter`. **Holding that exact property:**
    the row-3 guard `Ask` (a protected-dir write with no user rule) must NOT be deniable by the
    definition. The placement therefore consults the per-agent layer **BEFORE the write-rule
    branch** — i.e. in `policy_verdict`, `definition_verdict` is computed first, and the
    write-guard branch (rule_or_guard_verdict) is consulted before the per-agent verdict is merged,
    with the per-agent `Deny` allowed to override a posture `Allow`/`Ask`/`Confine` but NOT the
    row-1 rule `Deny` NOR the row-3 guard `Ask`. Concretely, the row-3 guard `Ask` is produced by
    `rule_or_guard_verdict` BEFORE the merge; a per-agent `Deny` merged afterward WOULD deny a
    protected write. **Fix:** the merge consults `definition_verdict` in the WRITE-rule branch as
    well, applied to the row-3 guard `Ask` as `Ask` (the strict-of-two leaves `Ask` at `Ask`); i.e.
    a per-agent `Deny` on a protected write is a `Deny` ONLY if the per-agent verdict is `Deny`
    AND the guard was NOT the deciding row-3 ask. The **simple, honest** resolution: the per-agent
    layer's `Deny` for a protected-dir write is NOT consulted first — the row-3 guard ASK is a
    user-protection that a `permission:`-block cannot silently erase. So `definition_verdict` is
    consulted in the WRITE branch at the same precedence point as `rule_or_guard_verdict`:
    **after** it (its row-1 `Deny` stays `Deny`, its row-2 `Allow` stays `Allow`, its row-3 `Ask`
    stays `Ask`), and the per-agent merge only applies to the posture `decision_for` result. This
    is the delta §5 phrase "the per-agent layer must be consulted AFTER `rule_or_guard_verdict`
    (row 4)": it ENTERS at row 4 and cannot see rows 1–3. The implementation does exactly that:
    `rule_or_guard_verdict` returns early for rows 1/2 and for row 3; a row-4 fallthrough combines
    the posture verdict with the per-agent verdict. **A per-agent `Deny` that targets a
    protected-dir write therefore produces a `Deny` through the SAME `deny_tool_result` wording
    (the protected-refusal sentence) — it just cannot erase the row-3 ask.**

- `deny_tool_result` (gate.rs 335): **NO code change needed for the per-agent `Deny`** — it already
  routes through the protected-refusal / rule-deny / escape arms purely on the call + context, NOT
  on which layer produced the `Decision::Deny` (turn.rs maps `Some(Decision::Deny)` →
  `self.deny_tool_result(tc)` unconditionally). The per-agent deny inherits the exact wording. Add
  a short doc note: "a per-agent `Deny` reaches here via the same `Decision::Deny` mapping, so the
  model's recovery cannot depend on which layer said no."

### Step 4 — whole-tool deny drops the tool from the child's advertised set (resolver side)

The **only** place the child's advertised set is derived from the definition is
`resolve_agent_launch`'s tools rung + `subagent_flow`'s VERBATIM re-advertisement. Implement the
drop in **`launch.rs`**, inside `resolve_agent_launch` AFTER the `narrow` result is picked:

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
        // allowed to zero a child). The explicit list is NEVER filtered (the
        // rung above), so this only ever narrows the override/frontmatter rung.
        (!names.is_empty()).then_some(names)
    } else {
        Some(names)
    }
});
```

with the helper (in `launch.rs`, next to `first_speaking`):

```rust
/// The advertised `tool_specs` NAME of a recognised `ToolKey`, `None` for
/// an unrecognised one (they stay parsed + announced; their enforcement
/// has no advertised twin). The name class is the `tool_specs()` set; a
/// key NOT in it (`Unrecognized`) has no advertised name to drop.
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

Explicit-list compatibility: `explicit.tools` passes through un-filtered (ADR 0067 — it stays the
only layer that can hand a child zero tools), so the drop applies to the override and frontmatter
rungs. `subagent`/`list_agents` are already stripped by `narrow` — a whole-tool `Unrecognized`
`deny` on `"subagent"` has no `tool_key_name` (out of scope by decision, recorded in the scope
line).

### Step 5 — DTO carry test + definition `permission` test + wire half obligations

**File: `src-tauri/src/commands/agents.rs`** — new tests in the existing `#[cfg(test)] mod tests`:

1. **`a_definition_with_permission_and_notes_carries_both_to_the_dto`** — THE rot-proof carry
   test B1 required (delta hand-off #2). Build a `definition("scout", AgentScope::User)` whose
   `permission` is `Some(PermissionBlock { tools: vec![(ToolKey::Bash,
   Rules::whole_tool(Action::Deny))] })` and whose `frontmatter_notes` is
   `vec![FrontmatterNote::UnknownKey("mode".to_string())]`, run `agent_config` with the default
   settings, and assert:
   - `rows[0].file_permission` is `Some(block)` (the DTO carries the declared block);
   - `rows[0].frontmatter_notes` == the source `vec![...]`;
   - the JSON string contains `"filePermission"` and `"frontmatterNotes"` — proving the KEY
     crossed the wire.
   This test fails if `frontmatter_notes` stops reaching the DTO — the exact silent-no-op class
   #101 exists to fix (the SAME requirement B1 recorded verbatim in the delta).
2. **`the_wire_shape_pin_covers_the_new_columns`** — the updated `the_dto_wire_...` pin
   (Step 2) is itself a test; keep it green.

Note the wire-spelling table from the delta (§1d): `PermissionBlock`/`Rules`/`Rule` carry NO
`rename_all` (so `whole_tool` is snake_case), `Action` is `lowercase`, `ToolKey`/
`FrontmatterNote` are camelCase and EXTERNALLY tagged. We do NOT change any of it (the wire task is
B3's, and a TS mirror must mirror this exact shape). **If a serde attribute genuinely blocks the
wire** (i.e. a `Serialize` derive fails to emit `filePermission`/`frontmatterNotes` with the mixed
casing), we do NOT touch `definition_permission.rs` — we pin the AVOIDED spelling with a test and
report the blocker in the findings (per the constraint). In practice nothing blocks: `Serialize`
is already derived everywhere the DTO carries.

### Step 6 — gate tests (policy_gate.rs) + the full gate

All reuse the delta-quoted helpers VERBATIM: `policy_settings`, `deny_rule`, `build_policy_loop`,
`read_call`, `write_scripts`, `pin_guard_home`, `answer_permission` (policy_gate.rs:38/56/86/117/
188/174/134); import `use crate::agent::definition_permission::{Action, PermissionBlock, Rules,
ToolKey};` in the test module. Set the ruleset on the loop BEFORE the first prompt via
`loop_.set_permission(Some(block))` and read the verdict after a `bounded_prompt` (so
`file_policy`/`rules` are freshened, the existing pattern). Test matrix (each a named test):

1. **`a_definition_narrowing_an_allow_to_an_ask_prompts`** — settings `"allow","allow","allow"`;
   block `read: ask`; a `read` of an out-of-boundary path → `policy_verdict` ==
   `Some(Decision::Ask)` and a `permission-request` arrives (the definition narrowed a posture
   `Allow` to a prompt).
2. **`a_definition_deny_refuses_with_the_rule_or_protected_wording`** — settings
   `"allow","allow","allow"`; block `write: deny`; a `write` of a path under the pinned
   `$HOME/.pi/agent/agents` → `Some(Decision::Deny)` and the tool-result text contains
   `"protected agent-definition directory"` (the SAME `protected_refusal_text` wording a user
   rule would produce — reuse `deny_tool_result`, no new wording).
3. **`a_definition_cannot_widen_a_user_deny`** — settings `"sandboxed","sandboxed","sandboxed"`;
   block `read: allow`; an out-of-boundary `read` → still `Some(Decision::Deny)` (the posture
   `Deny` beats the per-agent `Allow`).
4. **`a_definition_allow_cannot_bypass_the_protected_dir_guard`** — settings
   `"allow","allow","allow"`; block `write: allow`; a protected-dir `write` on an UNTRUSTED space
   → `Some(Decision::Ask)` (the row-3 guard survived the per-agent `Allow`).
5. **`a_definition_cannot_unconfine_a_sandboxed_shell`** — settings `"allow","allow","sandboxed"`;
   block `bash: allow`; a `bash` call → `Some(Decision::Confine)` (the per-agent `Allow` cannot
   widen a `Sandboxed` shell policy).
6. **`a_definition_ask_tightens_a_trust_widened_allow`** — settings `"allow","allow","allow"` on
   the TRUSTED space; block `read: ask`; an out-of-boundary `read` on the trusted space →
   `Some(Decision::Ask)` (the per-agent `Ask` beats the trust-produced `Allow`).
7. **`a_whole_tool_deny_is_never_offered`** — settings `"allow","allow","allow"`; block
   `bash: deny`; a `bash` call → `Some(Decision::Deny)`. **Advertisement half** (resolver): the
   `resolve_launch` result's `launch.tools` excludes `bash` when the definition declares
   `bash: deny` — assert via `resolve_agent_launch` on a `def` with `permission: Some(block)`
   (the file rung) and the empty floor:
   `r.launch.tools == Some(vec![...])` without `bash`.
8. **`a_definition_ask_on_an_unpoliced_tool_stays_as_self`** (the declared limitation) — block
   `web_search: deny` → NOT enforced by `policy_verdict` today (no `policed_direction` twin);
   pin that it does NOT panic and does NOT change the posture verdict (the recognized-but-
   unpoliced set is announced, not silently dropped — B1's guarantee).

The 6-gate-test matrix is the honest minimum for the narrowing-only + strict-of-two claim. Where
a test asserts on `policy_verdict` directly AFTER a `bounded_prompt` freeshes the turn state, it
mirrors the existing direct-verdict pins (policy_gate.rs:840`a_trusted_space_suppresses_...`).

## Repo conventions / commands

- TDD: write the failing tests in Step 5/6 against the STUBBED accessor + merge canary, then land
  the implementation; `cargo test --lib <filter>` from `src-tauri/` per test. **`loop` is a Rust
  keyword, so a filter path is `agent::harness::r#loop::…`** (e.g.
  `cargo test --lib agent::harness::r#loop::tests::policy_gate -- a_definition_deny_refuses_with_the_rule_or_protected_wording`).
- Scoped runs: `cargo test --lib agent::harness::launch::tests -- resolve_launch_a_narrowing_override_wins_and_the_guarded_names_are_stripped`;
  `cargo test --lib commands::agents::tests -- the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads`.
- **Required gates:** `cargo build --all-targets` (the `fake_worker` bin — `cargo test --lib`
  does NOT catch it), `cargo clippy --all-targets` (0 warnings — `archimedes` is ONE compilation
  unit), `cargo fmt --check`.
- Do NOT start long-running processes (no watch/dev server).

## Acceptance criteria

1. `LaunchConfig.permission: Option<PermissionBlock>` exists and rides the SAME
   `SubagentDispatchWire.launch` path `tools:` takes; `fake_worker.rs` compiles via
   `cargo build --all-targets`.
2. `resolve_agent_launch` reports `permission_source` ∈ {`File`, `Parent`} — never `Override`
   (no settings layer exists) — and `AgentConfigDto` carries `filePermission` + `frontmatterNotes`
   with the updated wire-shape pin green.
3. `policy_verdict`'s final verdict is `stricter_of_two(posture, definition_verdict)` under
   `Allow < Confine < Ask < Deny`; a per-agent `Deny` reuses `deny_tool_result`'s existing
   wording; the four narrowing-only properties (narrow Allow→Ask; deny wording; cannot-widen a
   user deny; cannot bypass the protected guard) are each pinned.
4. A whole-tool `deny` drops the tool from the resolver-narrowed `launch.tools` (never offered).
5. The DTO carry test (`a_definition_with_permission_and_notes_carries_both_to_the_dto`) fails if
   `frontmatter_notes` stops reaching the DTO.
6. `cargo clippy --all-targets` = 0 warnings; `cargo fmt --check` clean.

## Findings / risks (for the caller)

- **REQUIRED SCOPE CHANGE: the production gate can only be reached through `agent/worker/core.rs`
  and `agent/worker/manager/subagent_flow.rs`, which are NOT in the owned set.** The carry lands
  `permission` on the wire (`SubagentDispatchWire.launch` — a `LaunchConfig` field, wire-additive,
  in our set), but the child Worker's `build_loop` (core.rs:325) applies `env.enabled_tools` and
  would need `loop_.set_permission(...)` to materialize the field into the gate. Because
  `subagent_flow.rs` (which builds `StartEnv` at line ~660) and `core.rs` are outside the Files
  set, this task CANNOT production-wire the gate consumption; what it ships is:
  (a) `LaunchConfig.permission` (carried on the wire, additive);
  (b) `AgentLoop::set_permission`/`permission_block` + the `gate.rs` enforcement (the STRICTER
  merge is complete and testable against the accessor);
  (c) the whole-tool advertisement drop in `resolve_agent_launch` (production-effective WITHOUT
  `subagent_flow.rs` — the narrowed `launch.tools` re-advertises verbatim);
  (d) the DTO carry + notes.
  Without (a)(+core.rs+flow) there is NO production path from the child's wire to the child's
  gate. Recommend the orchestrator extend the owned set with
  `src-tauri/src/agent/worker/core.rs` (the `set_permission` call next to
  `set_enabled_tools`, line 325) OR dispatch a follow-up task to add that one line after B2.
  **Enforcement (the gate) is complete in this task; the production WIRING of the gate is the
  one-line gap.**
- **`AgentLoop.permission_block` is set via the accessor, not `new`** — the construction-time
  stance mirrors `file_policy` (`None` until the first `handle_prompt`); the gate tests set it
  before the first prompt, matching the existing pattern.
- **`policy_verdict`'s early `None` for un-policed tools** is unchanged; a per-agent `deny` on
  `web_search`/`fetch_content`/`read_skill`/`ask`/`mcp`/`subagent` (`ToolKey::Unrecognized` or no
  policed twin) stays announced + unenforced at the gate — recorded as a named limitation (the
  recognized-but-unpoliced set parse + announce; their enforcement needs a NEW pre-`dir` tool
  check outside `policed_direction`, which touches un-owned dispatch seams).
- **`PermissionBlock` derived `Clone`/`Default`** — the carry + DTO clone compile.
- **Serde blocking:** NONE found — `Serialize` is derived on all four carried types; the mixed
  casing (`whole_tool` snake_case) is pinned by B1's own tests and handed to B3 verbatim.
- **No `some rung` for permission by design** — the `[File]`-only layer + `permission_source`
  keeps the 3-variant `OverrideSource` pin green (the exhaustive match at 1341 would break on a
  fourth variant, which is the pin's entire point).

## Sources

- `src-tauri/src/agent/subagent.rs` (lines 35-61, 175-221, 1023/1071)
- `src-tauri/src/agent/harness/launch.rs` (50-60, 130-141, 146-275, 303-340, 1627-1649)
- `src-tauri/src/commands/agents.rs` (117-142, 158-200, 201-270, 1390-1428)
- `src-tauri/src/agent/harness/loop.rs` (144, 214, 478-487, 659-684)
- `src-tauri/src/agent/harness/loop/gate.rs` (17-45, 99-192, 198-237, 270-275, 335-382)
- `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` (helpers 1-260; existing guarded/rule
  pins 660-1917)
- `src-tauri/src/bin/fake_worker.rs:509`
- `src-tauri/src/agent/definition_permission.rs` (types 43-135; `whole_tool`/`is_deny`/
  `catch_all_action`; `ToolKey::from_frontmatter_key` 168-178)
- `src-tauri/src/agent/mod.rs:9,31` (public module + re-export)
- `src-tauri/src/agent/worker/protocol.rs` (237-290 StartEnv; 329-343 SubagentDispatchWire)
- `src-tauri/src/agent/worker/core.rs` (325 `set_enabled_tools`)
- `src-tauri/src/agent/worker/manager/subagent_flow.rs` (531-680 child StartEnv)
- `src-tauri/src/agent/harness/dispatch.rs` (188-207, 296-320 `resolve_launch` consumer)
- Grounding: `docs/roadmap/agent-permission-and-pins-ground-definition-delta.md` (HEAD `27d761c`),
  `docs/roadmap/agent-permission-and-pins-ground-definition.md`
