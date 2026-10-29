---
status: planned
task: "task04 (B1, #101 part (a)): parse + type + announce the `permission:` frontmatter block"
base: 2b6bd26
parallel: none
owning-wave: B1
---

# B1 — Parse the `permission:` block into a narrowing type, and announce unknown frontmatter keys

**Issue:** https://github.com/danielcherubini/archimedes/issues/101 (part (a) — parse + type + announce ONLY)

**Scope line (already decided):** Parse and type the whole opencode-shaped block. Enforce NOTHING. `bash:` blocks carrying per-command patterns must parse and announce themselves as **unsupported** — never a matcher nothing has validated (command text includes the redirect, so `grep x file 2>/dev/null` contains a `>`, a naive `*>*` deny would block the stderr-suppression idiom, and ordering cannot express "redirect to a file but not to an fd"). Whole-tool `bash: deny` IS supported. Per the issue's own non-goals, `external_directory` and `doom_loop` guard keys are out of scope (parsed? no — see the announce rules).

**Scope of THIS task (deliverables 1–4):** (1) a `permission` field on `AgentDefinition` backed by a new type in `agent/definition_permission.rs`; (2) a real NESTED reader — the format's first structured value; (3) the ADR 0020 parity statement naming the upstream the reader mirrors, without disturbing the two documented `parse_value` divergences; (4) unknown top-level keys announce themselves (the `Files:`-scoped half — see the announce-channel decision and its hand-off note).

**Carrying and enforcing is B2's task.** This plan must not change `OverrideFields`, `SourceFields`, `file_fields`, `stored_fields`, `agent_config`, or the `resolve_agent_launch` ladder — anything that needs them is a hand-off note below.

---

## The upstream the reader mirrors — stated up front (ADR 0020 parity)

The `permission:` block is **opencode's** agent frontmatter (opencode AI docs: *"You can also set permissions in Markdown agents … `permission:` … `edit: deny`", "Since the last matching rule takes precedence, put the `*` wildcard first and specific rules after"*). It is **NOT a pi format** — pi's subagent reader (`pi-subagents/src/agents/frontmatter.ts`) has no such key, and opencode's own reader is the `config`/JSON permission model (`permission` object of per-tool keys; tools that take patterns: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, `skill`; verdict strings `allow | ask | deny`; "last matching rule wins"; `*`/`?` wildcards over the parsed command or path).

So the new reader is NV (new vocabulary) relative to the two-copy `parse_value` rule, and the existing sentence shape is used to say so — see the verbatim parity/doc text in Step 1(b). The reader must state the naming sentence: *"This block's upstream is opencode's markdown-agent `permission:` block (opencode docs: "permission", "You can also set permissions in Markdown agents" — it mirrors `config.permission`, opencode's `permission` object grammar / last-matching-rule-wins ordering, no version claim pinned here). Nothing in the `parse_value` "both copies" rule or the ADR 0020 consequence applies to it: the block is NOT part of the pi agent format, both `agents.rs` and `skills.rs`'s `parse_value` copies read scalars only, and the two DED stays between the copies (the trailing-`#` strip and the `''` un-doubling) name DIFFERENT upstreams (pi's `yaml` vs pi's `frontmatter.ts` regex reader). If a shape bug in this block reader is found, it has ONE owner: this block reader alone."*

**Do not perturb the divergence pin.** The two fixtures in `the_two_parse_value_copies_diverge_where_their_parity_targets_differ` (`agents.rs:749`) exercise `parse_value` only — no `permission:` block. A new `permission` test fixture uses a separate file; the pin's two files (`quote.md`, `pair.md`) and their two expected-values assertions are untouched. Nothing in this task changes either `parse_value` copy.

---

## The type — the FULL aggregate, decided BEFORE execution (the silent-drop guard)

The plan pins ONE shape end-to-end, from the parser through `AgentDefinition.permission` to T5/T12's assertions. The alternative — an enum with one variant per tool (e.g. `Tools::Bash { patterns, whole_tool }`) fronting a block that can carry `edit:` + `bash:` + `read:` in one file — would let an implementer ship one-tool-per-variant and **silently drop every other tool of a multi-tool block**, which is the exact silent-no-op class #101 exists to fix. That is why the aggregate is part of the DESIGN, not left to the implementer:

- **`PermissionBlock` is the aggregate.** It is an ordered vector of key→ruleset pairs in FILE ORDER — `pub tools: Vec<(ToolKey, Rules)>` — the only shape that can represent a multi-tool block end-to-end:
  - `edit: {"*": deny, "*.md": allow}` + `read: ask` + `bash: deny` in one block is exactly three ordered elements (`Edit`, `Read`, `Bash`), each carrying its own `Rules`.
  - File order is preserved because opencode resolves per-tool maps independently (order matters INSIDE a tool's pattern object, never across tools) — so an ordered `Vec` is faithful, needs no HashMap, and its order is trivially deterministic for tests.
- **Never a HashMap** (same reason the rest of this codebase orders + their tests pin order): a `Vec<(ToolKey, Rules)>` keeps file order, gives deterministic serialization/assertions, and needs no `BTreeMap`-vs-`HashMap` decision. The only look-ups in this task are the tool-key→`ToolKey` fan-out (a `match`, not a map) and the six top-level-key arms in `parse_agent_file` (per-field `if`s, no map) — so the ordered-Vec discipline has no map-shaped temptation anywhere; the per-tool pattern ordering lives inside `Rules`.
- **`Rules` is the per-tool ruleset**: `pub patterns: Vec<Rule>` (ORDERED — opencode applies a tool's pattern object in order, LAST matching rule wins, which is why the `"*"` catch-all is written FIRST and the specifics after it carve out exceptions) **plus** `pub whole_tool: bool` — true exactly when the tool key carried a bare verdict (`edit: deny`, `bash: deny`, `read: ask`), i.e. the `{pattern → action}` shape's only action that applies to ANY argument. A bare verdict is stored as `patterns == vec![Rule { pattern: "*", action }]` with `whole_tool: true` (the catch-all spelling); a block that spells `{"*": action}` explicitly is `whole_tool: false` with the same single pattern (B2 can tell "the file said tool-wide" from "the file said star").
- **`ToolKey`** is the per-tool discriminant: `pub enum ToolKey { Edit, Read, Bash, Write, Find, Grep, Ls, ReadSkill /* `read_skill` */, Ask, WebSearch, FetchContent, Unrecognized(String) }` — the first eleven are the RECOGNISED keys (see the table), `Unrecognized(String)` preserves any other tool name verbatim.
- **Unrecognised tool names are RETAINED, never dropped:** opencode has more keys than this desktop has policed tools — `glob`, `grep`, `list`, `task`, `skill`, `lsp` are all valid opencode per-tool keys with no archimedes twin. A key that maps to `Unrecognized` still gets its pattern rows parsed into `Rule`s and a `FrontmatterNote::UnrecognizedToolKey(key)` pushed — the ruleset stays REPRESENTABLE (B2 can still enforce the deny) and the reader still ANNOUNCES. There is no code path that deletes a tool from the block.
- `AgentDefinition.permission: Option<PermissionBlock>` — `None` → this file does not speak about permissions; `Some` → the whole block.

**What the type can NEVER express (the narrowing layer is total):** no shape in this module can encode "allow beyond the user's policy". The only actions are `Allow | Ask | Deny`; `Allow` can only EVER narrow a call *toward* the user's `filePolicy` (a per-agent `Allow` is at most a no-op on the OUTSIDE of the user's boundary — the strict-of-two merge is B2's row work, but the vocabulary itself cannot widen).

**The full type, verbatim, lives in Step 1.** An implementer ships exactly this shape and nothing else.

### The recognised-key table (measured at 2b6bd26 — do not rediscover)

| ToolKey variant | Frontmatter key | Pattern rows parsed? | Notes |
|---|---|---|---|
| `Edit` | `edit:` | yes | path-taking — `pattern` is a glob over the resolved path |
| `Read` | `read:` | yes | path-taking same as `Edit` |
| `Bash` | `bash:` | yes (rows parsed; announced `UnsupportedReason::BashPatternRules`; whole-tool `deny` SUPPORTED) | rows are parsed into `Rule`s but the WHOLE defensible invariants are: bare `bash: <action>` → `whole_tool: true`; a bash OBJECT → `whole_tool: false` + rows |
| `Write` | `write:` | yes | path-taking (archimedes extension) |
| `Find` | `find:` | yes | path-taking |
| `Grep` | `grep:` | yes | path-taking |
| `Ls` | `ls:` | yes | path-taking |
| `ReadSkill` | `read_skill:` | yes | path-taking |
| `Ask` | `ask:` | yes | a `permission:`-block `ask:` key — NOT the tool named `ask`; map to `ToolKey::Ask` |
| `WebSearch` | `web_search:` | yes | no path — patterns parsed for completeness, B2's matcher decides |
| `FetchContent` | `fetch_content:` | yes | same as `WebSearch` |
| `Unrecognized(String)` | anything else | yes (parsed into `Rule` rows) | retained + announced — never dropped |

The eleven recognised keys derive from the RENDERING surface the desktop actually advertises: `tool_specs()` (`agent/harness/tool_specs.rs`) emits `bash, read, write, edit, find, grep, ls, list_skills, read_skill, ask, sudo_exec, manage_todo_list, subagent, list_agents, mcp, web_search, fetch_content, get_search_content` and `POLICIED_TOOLS` (`gate.rs:17`) lists `bash, read, find, grep, ls, write, edit`. `list_skills`, `sudo_exec`, `manage_todo_list`, `subagent`, `list_agents`, `mcp`, `get_search_content` are NOT in the key set: they take no path and cannot be permission-narrowed (a `subagent: deny` is a valid opencode spell but means "this agent may not spawn subagents" — that is a *ban*, not a narrowing of the user's file policy; B2's call, out of this scope). They fall to `Unrecognized(String)` and are retained+announced like `glob`/`task`/`lsp`. opencode's own key set (`glob`, `grep`, `list`, `task`, `skill`, `lsp`, `external_directory`, …) is NOT assumed complete — the `tool_specs()` set is the authoritative derivation, and everything else is retained via `Unrecognized`.

---

## Compile-collision note (measured at 2b6bd26 — do not rediscover)

`AgentDefinition` derives no `Default`, so adding the `permission` field breaks every fully-specified struct literal. There are exactly **four**, all but one in the OWNED set:

1. `commands/agents.rs` `full_definition()` — literal at `agents.rs`'s sibling module, line **322** (fn at 322, `AgentDefinition {` at 323);
2. `commands/agents.rs` `definition(name, scope)` — line **763** (fn at 763, literal at 764);
3. `harness/launch.rs` `def_with()` — line **1633** (fn at 1627, literal at 1633; the plan's earlier 1628 was the `model:` field of the literal, not the literal/`AgentDefinition {`);
4. **the PRODUCTION construction inside `discover_in_roots` — `agents.rs:182`** (the `AgentDefinition { … }` literal that moves the tuple fields `name, description, model, thinking, tools, system_prompt` and adds `scope`/`path`/`shadowed`), which the earlier plan never named.

Because **`archimedes` is ONE compilation unit**, B1 cannot compile without completing all four — that is why sites 1–3 and the production site are in `Files:`. **Their edits are literal-completion ONLY:** `permission: None,` inserted after `tools: …,` and `frontmatter_notes: Vec::new(),` after it — EXCEPT the `discover_in_roots` construction, which additionally threads `permission` and `notes` from the parse result (see Step 3: `permission` and `frontmatter_notes: notes` move into the tuple). `agents.rs` has **exactly ONE `parse_agent_file` call, at `agents.rs:139`** — the earlier plan's claim of a second destructure at `agents.rs:206` was false (that region is `space_roots`); the ONLY tuple destructure is line 139's `let Some((…)) = parse_agent_file(…)`, and its every element is moving on the widened tuple. The no-frontmatter early return (`parse_agent_file` lines 291–298) is a SECOND construction of the tuple, not a destructure. B2 owns the SEMANTICS of `commands/agents.rs` and `launch.rs`.

## Files:

- `src-tauri/src/agents.rs` (modify — the parse site, the struct, the unknown-key announce)
- `src-tauri/src/agent/definition_permission.rs` (CREATE — the new narrowing type, its parser, its tests)
- `src-tauri/src/agent/mod.rs` (modify — exactly two lines: `pub mod definition_permission;` + `pub use definition_permission::{Action, FrontmatterNote, PermissionBlock, Rule, Rules, ToolKey, UnsupportedReason};`)
- `src-tauri/src/commands/agents.rs` (modify — ONLY the two `AgentDefinition` test literals `full_definition()` and `definition()`: `permission: None,` + `frontmatter_notes: Vec::new(),`)
- `src-tauri/src/agent/harness/launch.rs` (modify — ONLY the one `AgentDefinition` test literal `def_with()`: `permission: None,` + `frontmatter_notes: Vec::new(),`)

**Batch note (hand-off, NOT work here):** `AgentDefinition` gains NO `Default` — the intentionally-empty literal is a REVIEWABLE constant (`AgentDefinition::default()`-would-be is the empty value; when B2 merges a `Default` request, reviewer to evaluate against the many-literal suite). `definition_permission.rs`'s tests live in an in-file `#[cfg(test)] mod tests`, which — like `agents.rs`'s own test module — RUNS under `cargo test --lib agent::definition_permission`; nothing is "compiled out" of the lib suite, and the type is a full-build type (see Step 4).

## Files the plan deliberately does NOT touch (hand-offs)

- **`src-tauri/src/agent/permission.rs` is NEVER touched by this task.** Despite the name it is the UNRELATED ADR 0010 native UI prompt gate (`native_permission_gate`, `permission_title`, `PendingPermissions`, all consumed by `gate_tool`), not the frontmatter ruleset's home — the new module is `agent/definition_permission.rs`, a different file. The per-agent ruleset's `Ask` verdict is *consumed* by `gate_tool` in B2; this module itself is not the storage/parse target.
- **B2** gets `LaunchConfig` gain, `ResolvedLaunch` site (`launch.rs:271`), the resolver copy-through, the launch wire (`SubagentDispatchWire` — wire-additive per serde), and ALL of `commands/agents.rs` semantics incl. any DTO widening.
- **B2** owns any enforcement (`agent/harness/loop/gate.rs` `rule_or_guard_verdict` rows; the `resolve_agent_launch`/`subagent_flow.rs` advertised-set chain; executor parity via `canonicalize_lenient`). Per the compile-collision note, its hands are already full with `LaunchConfig`'s four fully-specified literals + `fake_worker.rs:509`.
- **B3** renders the Agents modal; the WIRE side of the announce-channel report is handed off in the announce-channel decision below (it is the sibling-report half) — it is NOT silently assumed.

---

## Design decisions (decided here, with evidence — encode in the plan and the code)

### D1 — The announce channel: SIBLING of `Shadowed<T>`, additive per-definition report

(Decision: reuse the SHAPE of `Shadowed<T>` for a new `FrontmatterNote` report — NOT `Shadowed<T>` itself, NOT a widening of `shadowed`, and NOT carried to the wire in this task. One small, typed notes vector rides `AgentDefinition` today so the announce half is REAL and testable in discovery; the wire/UI half is a named hand-off.)

Evidence for "discovery is total, announcement must be a per-definition report": the grounding report (§4d) and the module doc (`agents.rs:1-19`) — `discover_agents` / `discover_in_roots` return only `Vec<AgentDefinition>`, infallible, non-panicking; a malformed file is skipped, never an error. So there is NO error/log channel; an announcement must ride the returned rows or not exist. The repo's ONLY precedent for a file announcing something is ADR 0065's `Shadowed<T>` — *"a shadow is a REPORT, not an entry"* — carried on `AgentDefinition` and surfaced through `AgentConfigDto` (`commands/agents.rs:197`, rendered as text on the winning row). The mechanism exists; what does NOT exist is a generic "warnings from this file" channel — so the decision below adds one small, typed slot.

**Why a sibling report field and not `Shadowed<T>` reuse:** `Shadowed<T>` is (a) a name-collision concept — it IS the losers of a name fight; an unknown-key note is "this file said something the reader does not understand", (b) generic over a SCOPE ENUM (`Shadowed<AgentScope>`), which a note has no use for, and (c) wired (DTO) + rendered — wiring it to nothing is a lie. **Why not widen `shadowed`:** its doc, ADR 0065, and `a_definition_with_no_collision_serializes_shadowed_as_an_empty_array` pin `shadowed: []` as an empty array on the wire; mixing a different report into it corrupts that meaning. **Why the notes are ONE small typed vector and not zero:** the announce half is one of this task's four named deliverables; shipping it as a file-discovered, in-Rust report (verified by a test) makes it real now (the "not another confident no-op" guarantee), leaves B2/B3 no room to silently drop it (they must deliberately carry or deliberately defer it — this plan's hand-off note), and costs two lines of construction. Shipping nothing at all would defer the task's own deliverable (4) with no recorded reason.

**The wire is left as an explicit hand-off note (NOT silently assumed):** B3 renders the Agents modal; B2 owns `commands/agents.rs` semantics. This task therefore does NOT touch `AgentConfigDto`, `AgentDefinitionDto` (verified: the `From<AgentDefinition>` at `commands/agents.rs:39` destructures only `name/description/model/scope` — the additive field is a **moving** destructure, so that arm compiles; it does NOT make the struct's field reach the wire), `OverrideFields`, `SourceFields`, `file_fields`, `stored_fields`, or `agent_config`. **Hand-off to B2/B3:** `AgentDefinition.frontmatter_notes` exists as of this task; deciding whether `AgentConfigDto` carries it (sibling `Vec<FrontmatterNote>`, `"frontmatterNotes"`, REQUIRED like `shadowed`) and how the modal renders it (text on the row, mirroring the shadowed row-text) is B2/B3's call, and must not ride `shadowed` (the wire pin above). `AgentDefinitionDto` stays unchanged by design — the picker/mention surface does not need notes.

**Why notes, and why this shape, beats deferring the whole announce half:** task ceiling is ≤6 Steps and ≤8 owned files; this plan fits 5 steps / 5 files including the notes. Deferring half of a named deliverable is only justified by the ceiling — it is not exceeded here. Deferring the WIRE half is separately justified by ownership (B2/B3 own those files), which is precisely what the hand-off note records.

### D2 — The type: a NARROWING layer, never a grant (all field types are `pub`)

`agent/definition_permission.rs` holds the FULL aggregate decided above:

```rust
//! The parsed `permission:` frontmatter block of an Agent definition
//! (issue #101), as a NARROWING layer only: rules here can only make a
//! call MORE restricted than the user's `filePolicy` would — never less.
//! No shape in this module can express "allow beyond the user's policy",
//! and the ONLY whole-tool spellings ever produced are the three actions
//! `allow | ask | deny`.

use serde::Serialize;

/// The three verdicts opencode's permission model carries (`allow | ask | deny`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Ask,
    Deny,
}

/// One deciding rule for a PATH-TAKING tool (issue #101, opencode shape):
/// a `pattern` that matched and the `action` the LAST matching rule in the
/// tool's (ordered) map carried. ORDERED: opencode resolves a tool's
/// pattern object in order, LAST matching rule wins — which is why the
/// `"*"` catch-all is written FIRST and the specifics after it carve out
/// exceptions. `pattern` is the layer's only place where opencode wildcards
/// (`*`, `?`) can appear. (Despite the generic sound of `pattern`, this is a
/// PATH/PATTERN matcher for path-taking tools ONLY — see `ToolKey`.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rule {
    pub pattern: String,
    pub action: Action,
}

/// The per-tool ruleset. ORDERED — opencode applies a tool's pattern object
/// in file order, LAST matching rule wins (the `"*"` catch-all first, the
/// specifics after it). An EMPTY set with `whole_tool` is exactly a bare
/// verdict; `whole_tool: true` is stored with `patterns == vec![Rule {
/// pattern: "*", action }]` (see `whole_tool`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Rules {
    pub patterns: Vec<Rule>,
    /// ALWAYS the `{pattern → action}` map; `whole_tool` says whether the
    /// action applies to ANY argument (a bare `edit: deny`) or only to
    /// matching patterns. Never order-sensitive (up to B2's matcher).
    pub whole_tool: bool,
}

/// The per-tool discriminant. The frontmatter KEY is the identity: eleven
/// RECOGNISED keys (below) + `Unrecognized(String)` which RETAINS any other
/// tool name verbatim (opencode has keys this desktop has no policed twin
/// for — `glob`, `grep`, `list`, `task`, `skill`, `lsp`; an unrecognised key
/// is announced via `FrontmatterNote::UnrecognizedToolKey`, NEVER dropped).
/// `pattern` is the layer's only place where opencode wildcards can appear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKey {
    Edit,
    Read,
    Bash,
    Write,
    Find,
    Grep,
    Ls,
    ReadSkill,
    /// This is the `permission:`-block `ask:` KEY — a verdict-bearing tool key,
    /// NOT the `ask` TOOL (the interactive prompt). Different spell.
    Ask,
    WebSearch,
    FetchContent,
    /// Any other tool name, kept verbatim so the ruleset stays REPRESENTABLE.
    Unrecognized(String),
}

/// WHY a block could not be used. Only produced for `bash`-style
/// per-command pattern blocks (the scope line: parse + announce as
/// unsupported — a matcher nothing has validated must not be enforced).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsupportedReason {
    /// opencode `bash`-style patterns over command text (incl. its
    /// redirects) are not a validated matcher in this desktop: a
    /// `grep x file 2>/dev/null` contains a `>`, and no rule language here
    /// has ever separated "redirect to a file" from "redirect to an fd".
    /// Whole-tool `bash: deny` (a bare `Action`) has NO patterns and IS
    /// supported — only a bash object with ≥1 pattern row is unsupported.
    BashPatternRules,
}

/// The FULL ordered aggregate: every tool the block speaks about, in FILE
/// ORDER. This is the type `AgentDefinition.permission` carries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PermissionBlock {
    /// A multi-tool block (`edit:` + `bash:` + `read:` in one file) is
    /// exactly three ordered elements. Never a HashMap: file order is
    /// faithful to how opencode applies per-tool maps (independently, in
    /// file order) and gives deterministic serialization and test
    /// assertions. Unrecognised keys are PRESERVED as
    /// `ToolKey::Unrecognized(…)` — the silent-drop class #101 exists to fix
    /// has no path in this type.
    pub tools: Vec<(ToolKey, Rules)>,
}

/// One "this file said something the reader does not understand" note —
/// the ANNOUNCE half (issue #101 / #78). A REPORT, never an error: discovery
/// stays total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FrontmatterNote {
    /// A top-level frontmatter key the desktop does not read (`mode:`,
    /// `temperature:`, …). `UnknownKey("permission")` is pushed ONLY when a
    /// `permission:` line is NOT a known key.
    UnknownKey(String),
    /// A recognised-but-unpoliced tool name, kept verbatim (`glob`, `task`,
    /// `lsp`, `subagent:`, …).
    UnrecognizedToolKey(String),
    /// A `bash`-style per-command pattern block: parsed (`Some(block)`) but
    /// announced unsupported — never enforced by a matcher nothing validated.
    UnsupportedUnvalidatedMatcher(UnsupportedReason),
    /// An action/verdict the parser does not recognise (`allow`/`ask`/`deny`
    /// are the only accepted spellings). The row is `None`-ed and the note
    /// carries the unknown spelling verbatim; parser tolerance, never a crash.
    UnknownAction(String),
}
```

- **Integrity (narrowing-only) pins:** `PermissionBlock`/`Rules` derive `Default`; the write constructor is `fn whole_tool(action: Action) -> Rules` (the WHOLE-TOOL shape: `patterns == [Rule { pattern: "*", action }]`, `whole_tool: true` — B2's only legal non-pattern user). The bare `Action` variant cannot appear in `patterns` (the parser maps a whole-tool action to the catch-all + `whole_tool: true`): **no shape can represent "allow beyond the user's policy" as a grant.**
- **Whole-tool `bash: deny` IS supported:** `ToolKey::Bash` with `whole_tool: true` fires `deny` for ANY command — announced as SUPPORTED; no matcher needed. Only a bash OBJECT with ≥1 pattern row parses into `whole_tool: false` + rows AND announces `UnsupportedReason::BashPatternRules` (the announce rules below).
- **Pattern rows under a `ToolKey::Bash` object are parsed into `Rule`s** — parse MUST succeed — and the whole tool-key object is announced as unsupported. ABSOLUTELY no rendering difference between a `ToolKey::Edit` object and a `ToolKey::Bash` object at TYPE level: `bash`'s object rows are typed, announced, and left for B2.
- **Ordering is structural, not inferred:** `Vec<(ToolKey, Rules)>` in file order; `Rules.patterns: Vec<Rule>` in file order. Nothing sorts, nothing dedupes, nothing re-orders.
- **Unrecognised tool keys (a valid opencode tool not in the table) and unknown action verdicts** are announced — never silently dropped (rules in "the announce rules" step). `UnrecognizedToolKey` carries the exact key string so B2/B3 can show it.

### D3 — Output and announce rules (implemented in B1, verified by tests)

The `permission:` reader returns `PermissionOut = (Option<PermissionBlock>, Vec<FrontmatterNote>)` — a successful parse carries `Some(block)`; a keyword/dialect miss carries an empty `None` block + the notes. On ANY unknown top-level frontmatter key (verified: `parse_agent_file` step 3 scans non-indented lines only and ignores everything it does not start-strip; `parse_value` returns `None` for an empty inline — a `permission:` block today yields nothing and its indented children are never visited) the reader pushes a `FrontmatterNote`. The note set, in code order:

1. `UnknownKey("permission")` — ONLY when the line is NOT a known key.
2. `UnknownKey("<key>")` — for every top-level line that is not `name`/`description`/`model`/`thinking`/`tools`/`permission` (quoted; e.g. opencode's `mode:`, `temperature:`, `tools`-values).
3. `UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules)` — for a bash OBJECT with ≥1 pattern row (announced; still `Some(block)` with the patterns typed).
4. `UnrecognizedToolKey("<key>")` — for a per-tool key with no known twin (glob, task, lsp, subagent, …); parse the object's rows into `Rules` regardless.
5. `UnknownAction("<action>")` — for an invalid verdict/action string (parser tolerance: `None`-row + note, never a crash; see Step 2).

**Order/note rule pins `first occurrence wins`** (the five-key scanner is first-wins per key; a RE-REPEATED `permission:` maps to one note, not N — the note is pushed once per file), and the sorted-files / dedupe tests in `agents.rs` stay green (notes are per-file, distinct from name).

### D4 — The parity divergence statement + a new divergence PIN (Step 1(b) fixture) — the two-copy DED stays untouched

- Statement lives in `definition_permission.rs`'s module doc AND next to the reader's doc: names opencode's markdown-agent `permission:` block as the upstream, says in the exact existing sentence shape that this is NEW vocabulary (see "The upstream the reader mirrors" above) and that neither `parse_value` copy (nor their two named DEDs) is involved.
- The two `parse_value` copies are NOT touched in this task; the pin test `the_two_parse_value_copies_diverge_where_their_parity_targets_differ` (agents.rs:749) stays GREEN — the fixtures are `permission:`-free.
- The plan requires the implementer to ADD the U-TURN PIN (in the `definition_permission.rs` test module): *"The opencode `permission:` block reader has NO upstream in the two `parse_value` copies — a bug in either copy (the NBSP/dedent byte-offset guard, the quote pair, the `: ` guard) is NOT applied here, and a bug here is NOT applied there. A change that TOUCHES the `parse_value` copies IN THIS TASK is a test failure by construction (the pin asserts the copies' byte-identical-parse_value body stays untouched this task)."* Any bug in shared value-reading logic gets applied to BOTH copies — per the ADR 0020 consequence — because the copies are the ONLY shared reading.

---

## Steps (≤6)

### Step 1 — `src-tauri/src/agent/definition_permission.rs` (CREATE) + `agent/mod.rs` (2 lines) + TDD

1. Write the module (`pub mod definition_permission;` in `src-tauri/src/agent/mod.rs` + `pub use definition_permission::{Action, FrontmatterNote, PermissionBlock, Rule, Rules, ToolKey, UnsupportedReason};` in the same file — exactly two lines, and this is the ONLY rendering of the re-export list in the plan, byte-identical to the `Files:` entry).
2. Inside it, define `Action`, `Rule`, `Rules`, `ToolKey`, `UnsupportedReason`, `PermissionBlock`, `FrontmatterNote` (D2's exact shapes), the `PermissionOut` return type, `parse_permission_block(fm: &[&str], idx: usize, rest: &str) -> PermissionOut` (the nested reader), the `Default`/`whole_tool(action)`/`per_tool_action`, `catch_all_action`, `is_deny()` accessors, and a `#[cfg(test)] mod tests`.

**Test-first (TDD per repo convention) — new-file tests, in order of writing:**

- **T1 `permission_action_verbs_are_lowercase_on_the_wire`** — `serde_json::to_string(&Action::Deny)` == `"\"deny\""`; `Allow` → `"allow"`, `Ask` → `"ask"` (locks the wire spelling B2 will ride).
- **T2 `a_bare_action_is_the_whole_tool_catch_all`** — `Rules::whole_tool(Action::Deny)` gives `patterns == vec![catch_all(deny)]` + `whole_tool == true` (the ONLY whole-tool shape; bash-whole-tool supported).
- **T3 `last_matching_rule_wins_parse_and_type`** — frontmatter `permission:` with `edit:` → `{ "*": "deny", "*.md": "allow", "src/lib/*.ts": "deny" }` parses to an ORDERED 3-rule list (`deny`, `allow`, `deny` — the last-matching-rule contract's ordering, tested at the type level: `rules.patterns[2].action == Deny` and `whole_tool == false` when spelled `{...}`, `true` when bare). Runs the actual block reader (TDD: reader written in the same test pass).
- **T4 `pattern_matching_applies_to_path_taking_tools_only`** — a `ToolKey::Edit` pattern block parses to `Edit { patterns, whole_tool: false }` — path-TAKING is a TYPE property, and `write:`/`find:`/`grep:`/`ls:`/`read_skill:` are the same arm.
- **T5 `a_multitool_block_is_fully_representable_and_preserved_order`** — ONE block carrying `edit: {...}` + `bash: deny` + `read: ask` parses to a THREE-element `PermissionBlock.tools` in FILE ORDER (`Edit`, `Bash`, `Read`) — the exact silent-drop regression from the KEY DISTINCTION above: an implementer whose shape can only hold one tool per block FAILS this test.
- **T6 `an_unrecognised_tool_key_is_retained_and_announced_not_dropped`** — a `glob:`/`task:`/`lsp:` object (opencode keys with no desktop twin) parses its pattern rows into `ToolKey::Unrecognized("glob"→string)` AND pushes `FrontmatterNote::UnrecognizedToolKey("glob")` — the ruleset stays representable, the key is announced, nothing is dropped.

### Step 2 — `parse_agent_file` 7-tuple + the `permission:` arm in step 3 (+ T7–T12 in `agents.rs`)

- Change `parse_agent_file` to return the 7-tuple `(name, description, model, thinking, tools, permission, body)` — `permission: Option<PermissionBlock>` + `body` moves from the 6th to the 7th slot. Update the module doc line (`Returns (… tools, permission, body)`), the no-frontmatter early return (adds `None` as the permission slot), and the ONE destructure site (`Some((name, …, tools, permission, system_prompt)) = parse_agent_file(…)` at `agents.rs:139` — every tuple element is moving on destructure, and line 139 is the ONLY `parse_agent_file` call in the tree).
- In step 3, add a `permission` arm: `if permission.is_none() { if let Some(rest) = line.strip_prefix("permission:") { permission = parse_permission_block(fm, i, rest) } }` — nested, first-wins, matching the five existing arms. `parse_permission_block` internally walks `fm[idx+1..]` while lines are INDENTED (the `is_block`-style collection loop in `parse_value` is the existing primitive — but `parse_value` itself returns `None` for an empty inline, so the block cannot ride the scalar path; the new reader collects indented lines).
- **Blank-line rule (the nested reader's block collection):** inside the collected block, an EMPTY line (a line that is empty or whitespace-only) is SKIPPED, never a terminator — the block ends ONLY at a non-indented, non-blank line or at `fm`'s end. A permission block with a blank line between tool groups (`edit: …` / blank / `bash: deny`) is legal and readable, and must not truncate the ruleset mid-block. The collected lines keep a BLANK placeholder so a `dedent`-then-join produces blank lines where the file had them, and the final block is `trim()`-ed. **This is a deliberate divergence from `parse_value`'s block branch, which BREAKS on an empty line (a blank line matches neither the indent branch nor the break branch — the loop just stops, so a mid-block blank truncates the value).** That bug cannot be copied here: it is the silent-loss class. T7 pins it (below).
- **Quote rule (what the reader strips, and which parity governs it):** the block reader owns ONE rule of its own, stated in its doc: a pattern-key value or an action token that is an EXACTLY-quoted single token (`"*.md"`, `'deny'`) gets ONE surrounding quote pair stripped (`value[1..len-1]`); anything else (a quoted string with trailing content, an unquoted multi-token value) is kept verbatim. Quotes ONLY at the token's own start and end count; a leading `'` inside a pattern (e.g. a regex-style quoted glob) is NOT a quote pair. This is the BLOCK READER's rule and governs here; the scalar `frontmatter.ts` precedent (`value.slice(1, -1)` in `pi-subagents/src/agents/frontmatter.ts`) governs `parse_value`'s inline scalar, NOT this reader. Rationale: YAML block scalars are not involved; the parity story is that this reader mirrors opencode's `config`-JSON-ish per-tool object grammar (where `"deny"` is a quoted verdict), so one surrounding pair may be stripped like `frontmatter.ts` does, but the reader breaks no string that is not wholly-quoted.
- The announce rules (D3) are implemented HERE as the step-3 scan's unknown-key detection: every non-indented line that is not one of the six named keys → a `FrontmatterNote`. The collect/notes plumbing: `parse_agent_file` grows a `let mut notes: Vec<FrontmatterNote> = Vec::new();` (or the composed out), the notes are seeded by every unknown-key push and by D3 rules 3–5 (bash-object-with-patterns, unrecognised tool keys, unknown action/verdict), and returned alongside. The notes are order-preserving per file; there is NO dedupe beyond "one note per event".

**Tests (agents.rs module):**

- **T7 `a_permission_block_with_a_blank_line_between_tool_groups_parses_in_full`** — `permission.md` with `edit: …` / blank / `bash: deny` discovers with `d.permission.tools.len() == 2` and BOTH groups present — pins the blank-line SKIP rule (this test FAILS against a `parse_value`-style break-on-blank loop). A blank line inside a block does NOT terminate it.
- **T8 `a_permission_block_is_parsed_into_the_typed_ruleset`** — write `permission.md` with an opencode-shaped block (per-tool bare + pattern rows: `edit: {"*": deny, "*.md": allow}`, whole-tool `bash: deny`, a path-tool `read: ask`) + body; `discover_in_roots` over `scratch()` (the existing owned-scratch `scratch()`/`write_file`/`canon(p)` pattern); assert `d.permission` is `Some(...)` with the ordered `Vec<(ToolKey, Rules)>` in file order (the ordering contract of T3), and `frontmatter_notes` empty. This pins the ENTIRE 7-field parse incl. `permission`.
- **T9 `a_permission_block_reads_as_a_real_value_not_a_noop`** — a file whose `permission:` block has a non-empty pattern row is discovered WITH `Some(permission)` and `frontmatter_notes == []` (the "confident no-op" regression); and `first occurrence wins` when the block repeats.
- **T10 `a_permission_announces_unsupported_bash_pattern_rules_but_parses`** — a bash OBJECT with ≥1 pattern row (`bash: {"*": deny, "grep *": allow}`) parses (per the scope line: MUST parse) into `ToolKey::Bash { whole_tool: false }` AND produces `UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules)` in `frontmatter_notes` — while a WHOLE-TOOL `bash: deny` (`whole_tool: true`, bare catch-all) parses with NO note (supported).
- **T11 `unknown_top_level_keys_are_announced_never_silently_dropped`** — a file `name:…` + `mode: subagent` + `temperature: 0.1` (opencode-markdown keys the desktop does not read) is discovered; name/description parse as usual AND `frontmatter_notes` contains the two `UnknownKey` entries in file order (#78's principle applied to files — the next dialect miss is not another silent no-op). A `permission:` line is NOT itself an unknown key (it is the 6th known key) — pinned implicitly by T8/T9's empty notes. An unrecognised per-tool key inside a `permission:` block adds `UnrecognizedToolKey` (T6, discovery-level).
- **T12 `malformed_permission_never_panics_the_discovery`** — an unterminated/indent-broken `permission:` block yields a file that still gets discovered with `permission: None` + a note (tolerant, total, never a crash) — does not funnel into the skip path the missing-closing-`---` case does.

### Step 3 — `AgentDefinition.permission` + `frontmatter_notes` + the construction-site literal completions (+ T13–T14)

- Add to `AgentDefinition` (after `tools:`, before `system_prompt`):

```rust
    /// Frontmatter `permission` (opencode's per-tool allow/ask/deny block,
    /// issue #101), typed as a NARROWING layer — an ORDERED aggregate of
    /// `(ToolKey, Rules)`, never a one-tool enum (a multi-tool block is
    /// fully representable; unrecognised tool keys are retained, not
    /// dropped). `None` → this file does not speak about permissions (B2's
    /// strict-of-two starts from `None` as "no narrowing"). `Some` → the
    /// rules this file CARRIES; enforcement is B2's task.
    pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
    /// The frontmatter-READ notes (unknown top-level keys, unrecognised
    /// tool keys, unsupported bash-pattern rows — issue #101's announce
    /// half; #78's principle applied to files). A REPORT, never an error:
    /// discovery stays total. The two `parse_value` copies are NOT
    /// affected. Additive: an empty vec is the ordinary case.
    /// **Wire/UI surfacing is B2/B3's hand-off, mirroring the `shadowed`
    /// report half ("a shadow is a REPORT, not an entry", ADR 0065).**
    /// NOT the `Shadowed<T>` type: that carries `{name,path,scope}` twice.
    /// NOT widened into `shadowed` (its `[]`-wire pin stands).
    pub frontmatter_notes: Vec<crate::agent::definition_permission::FrontmatterNote>,
```

- **Type visibility decision (unlike `AgentDefinition`, `permission`/`notes` are `pub` FIELDS):** the type is `pub` (not `pub(crate)`) because `AgentDefinition` is `pub` and B2 will carry it across the `AgentDefinition` → `resolve_agent_launch` → DTO surfaces; the grounding report's warning pins the precedent — `OverrideSource` is `pub` not `pub(crate)` exactly because clippy's `private_interfaces` fires TRANSITIVELY down a `pub` DTO graph under CI's `-D warnings` (`commands/agents.rs:49`'s doc). `FrontmatterNote`, `PermissionBlock`, `ToolKey`, `Rules`, `Rule`, `Action`, `UnsupportedReason` are likewise `pub`. The tests live in `agents.rs`/`definition_permission.rs`, so `pub` is correct and honest here.
- **Complete the literal-completion sites:** `commands/agents.rs` `full_definition()` (literal at `:323` after the `fn` at `:322`) and `definition()` (`:764` after the `fn` at `:763`), and `harness/launch.rs` `def_with()` (literal at `:1633`) each get `permission: None,` + `frontmatter_notes: Vec::new(),` ONLY — no semantic changes.
- **Thread the production construction** at `agents.rs:182` (`discover_in_roots`): the tuple destructure at `:139` now yields `permission` + `notes`; the literal gains `permission,` and `frontmatter_notes: notes,` (the moved names), after `tools,`/`system_prompt,`. This is the ONLY `AgentDefinition` literal that does NOT get `permission: None` — it CARRIES the parsed value.
- `AgentDefinitionDto::from` (commands/agents.rs:39) destructures fields — compiles as-is; NOT touched (B2/B3's wire scope).

**Tests:**
- **T13 `the_two_parse_value_copies_diverge_where_their_parity_targets_differ`** — MUST STAY GREEN untouched (run it; it is the divergence pin, D4).
- **T14 `a_notes_carrying_definition_is_discovered_without_affecting_adjoining_rows`** — one `mode:`-carrying file + one clean file in the same root: `frontmatter_notes` is per-file and empty on the clean row; the sorted-files / dedupe pins of the suite stay green.

### Step 4 — `commands/agents.rs` + `harness/launch.rs` literal completions, wire-scope guard, full-build (clippy)

- The three completion edits (the TWO test literals in `commands/agents.rs` + the ONE in `harness/launch.rs`) are the ONLY changes in these two files (reviewer to verify `git diff` shows exactly the two added lines per literal).
- `cargo fmt --check`, then from `src-tauri/`:
  - `cargo test --lib agents` — all of `agents::tests` incl. T7–T14 (21 pre-existing + ~8 new).
  - `cargo test --lib agent::definition_permission` — the new-file tests (T1–T6).
  - `cargo test --lib agent::harness::loop::tests::policy_gate -- default_posture_agent_dir_write_is_an_ask_not_a_silent_deny` and `cargo test --lib commands::agents::tests -- agent_config_and_the_dispatch_resolve_the_same_row` — the untouched-surface regression pins (compile-level: B1 must not have drifted into B2 terrain).
  - **`cargo build --all-targets`** — REQUIRED (per AGENTS.md: `cargo test --lib` does NOT rebuild `fake_worker`; a stale bin is a misleading-failure trap). With `cargo clippy --all-targets` — the `-D warnings` gate MUST be 0 (the `pub`-type-`private_interfaces` trap from the grounding report is the reason D2's types are `pub`).

### Step 5 — Close-out: key-count docs + the Changelog

- Update the `agents.rs` module doc: the parse now reads SIX keys (+ nested `permission`); the `Returns (… tools, permission, body)` line; the unknown-key announce sentence ("unknown top-level keys are announced as per-definition reports — never silent no-ops, never errors; #101 / #78").
- One line in `CHANGELOG.md`: `Parsed the opencode-style permission: frontmatter block into a typed, narrowing-only ruleset and announce unknown frontmatter keys as per-definition reports (issue #101, part a).` (the repo's changelog convention).
- No ADR is written: the announce shape (D1) and the type (D2) mirror ADR 0065's REPORT principle and opencode's docs — the plan file itself is the record (per the status file's "no spec doc" convention).

---

## Test plan — summary (all `cargo test` scoped, from `src-tauri/`)

| Test | File | Pins |
|---|---|---|
| T1 permission_action_verbs_are_lowercase_on_the_wire | definition_permission.rs | `allow`/`ask`/`deny` wire spelling |
| T2 a_bare_action_is_the_whole_tool_catch_all | definition_permission.rs | whole-tool shape (`whole_tool`) |
| T3 last_matching_rule_wins_parse_and_type | definition_permission.rs | ordered rules; last-wins retained |
| T4 pattern_matching_applies_to_path_taking_tools_only | definition_permission.rs | type-level path-only |
| T5 a_multitool_block_is_fully_representable_and_preserved_order | definition_permission.rs | 3-tool block = 3 ordered elements — the silent-drop regression |
| T6 an_unrecognised_tool_key_is_retained_and_announced_not_dropped | definition_permission.rs | `Unrecognized` + `UnrecognizedToolKey` note |
| T7 a_permission_block_with_a_blank_line_between_tool_groups_parses_in_full | agents.rs | blank-line SKIP rule (fails on `parse_value`-style break) |
| T8 a_permission_block_is_parsed_into_the_typed_ruleset | agents.rs | 7-tuple + `Some(permission)` + empty notes |
| T9 a_permission_block_reads_as_a_real_value_not_a_noop | agents.rs | regression, first-wins |
| T10 a_permission_announces_unsupported_bash_pattern_rules_but_parses | agents.rs | scope line: bash-object → note; whole-tool bash → supported |
| T11 unknown_top_level_keys_are_announced_never_silently_dropped | agents.rs | `mode:`/`temperature:` → `UnknownKey` notes |
| T12 malformed_permission_never_panics_the_discovery | agents.rs | total/no-panic |
| T13 the_two_parse_value_copies_diverge_where_their_parity_targets_differ | agents.rs | existing — STAYS GREEN |
| T14 a_notes_carrying_definition_is_discovered_without_affecting_adjoining_rows | agents.rs | per-file notes; suite pins stay green |

## Acceptance criteria (gate for THIS task)

1. `permission:` blocks parse into the typed narrowing ruleset (path-only patterns; whole-tool `bash:`/`edit:`/etc. actions) — `cargo test --lib agents` green.
2. A multi-tool block (`edit:` + `bash:` + `read:` in one file) is FULLY representable as an ordered `Vec<(ToolKey, Rules)>` (T5); an unrecognised opencode tool key is retained and announced, never dropped (T6).
3. A bash-object-with-≥1-pattern parses AND carries `UnsupportedReason::BashPatternRules` in `frontmatter_notes`; a whole-tool `bash: deny` carries no note (the scope line, encoded in T10).
4. A blank line inside a `permission:` block is SKIPPED, not a terminator — the block parses in full (T7).
5. Unknown top-level keys announce themselves as `FrontmatterNote`s (T11) — never a silent drop, never an error.
6. `the_two_parse_value_copies_diverge_where_their_parity_targets_differ` still passes untouched (D4).
7. `cargo clippy --all-targets` = 0 warnings (the `pub`-types decision holds), `cargo fmt --check` clean, and `cargo build --all-targets` builds (fake_worker included).
8. `commands/agents.rs` and `harness/launch.rs` diffs touch ONLY the two/one literal completion(s) each (+ nothing else); the `agents.rs:182` production literal gains `permission` + `frontmatter_notes: notes` and nothing else semantic.
9. `frontmatter_notes`/`permission` never reach the wire in this task (AgentDefinitionDto/AgentConfigDto untouched) — recorded hand-off to B2/B3 instead.
10. At the END of THIS task, a user file with an unknown key discovers with **ZERO visible indication** (no UI, no log, no wire field) — the "announce" rides the returned rows inside Rust only; the guarantee holds inside Rust, and surfacing it is the wire task's job (see the rot-proof hand-off below).

## Hand-off notes (to B2)

- **The announce half is REAL in Rust but user-invisible until the wire task lands — and no B1-style test would fail if the carry were later dropped. Make it rot-proof:** the wire task (B2/B3) MUST carry a test that fails if `frontmatter_notes` stops reaching the DTO — the sibling `Vec<FrontmatterNote>` on `AgentConfigDto` (REQUIRED like `shadowed`) or whatever surface is chosen. That requirement is part of the hand-off, not a suggestion: a `frontmatter_notes` that silently stops crossing the wire would be the exact silent-no-op #101 exists to fix, re-appearing one wave later. Write it in the B2 task's test plan *before* the wire field lands, so dropping the carry is a test failure rather than a quiet regression.
- **`LaunchConfig`/wire/DTO side is NOT built here.** B2 carries `permission` + `frontmatter_notes` across `resolve_agent_launch`/`LaunchConfig`/`SubagentDispatchWire` (wire-additive), decides the modal/DTO surface for the notes, and enforces the strict-of-two in `gate.rs` rows + the advertised-set chain — the compile-collision note explains why `commands/agents.rs`/`launch.rs` semantics (OverrideFields/SourceFields/file_fields/stored_fields/agent_config/ladder) are B2's, not this plan's.
- **The notes vector is NOT `Shadowed<T>` and must not ride `shadowed`'s wire pin.** B2/B3 own the render decision.
- If the announce-channel choice (D1) needs review, its evidence (discovery is total; ADR 0065 precedent; wire pins; ceiling budget) is in this file.

## Sources

- `docs/roadmap/agent-permission-and-pins-ground-definition.md` (the grounding; `parse_agent_file`, `parse_value` copies, `AgentDefinition`, the divergence pin, §4 announce-channel evidence, §11 DTO surfaces)
- `src-tauri/src/agents.rs` (parser, struct, test module; verified at 2b6bd26 — the ONE `parse_agent_file` call at :139, the PRODUCTION `AgentDefinition` literal at :182, the divergence pin at :749)
- `src-tauri/src/skills.rs` (the second `parse_value` copy + its divergence wording; `Shadowed<T>`)
- `src-tauri/src/agent/harness/tool_specs.rs` + `src-tauri/src/agent/harness/loop/gate.rs` (the recognised-key derivation — `tool_specs()` names + `POLICIED_TOOLS` at gate.rs:17)
- `src-tauri/src/agent/mod.rs` (where the two new lines go)
- `src-tauri/src/commands/agents.rs` (`full_definition()` :322/:323, `definition()` :763/:764, `AgentDefinitionDto`/`agent_config`/`AgentConfigDto` surfaces, `Shadowed` wire pin)
- `src-tauri/src/agent/harness/launch.rs` (`def_with()` :1627, literal :1633)
- `src-tauri/src/agent/permission.rs` (NOT touched — the unrelated ADR 0010 UI prompt gate)
- `docs/decisions/0020-native-subagent-agent-definitions.md` (the parity rule), `docs/decisions/0065-a-shadowed-skill-is-a-report-not-an-entry.md` (the report principle)
- opencode docs: https://opencode.ai/docs/agents (permissions section: per-tool keys, pattern objects, last-matching-rule-wins, markdown-agent `permission:` blocks) and https://opencode.ai/docs/permissions
