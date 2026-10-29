# Grounding Delta — Definition (B1 landed at 2ccf1ff; next task = B2 carry + enforce)

Branch `feature/agent-permission-and-pins`, HEAD `27d761c` (the only commit after `2ccf1ff` is the docs-status commit `27d761c` — **the source tree at HEAD is byte-identical to `2ccf1ff`**; `git diff 2ccf1ff..27d761c -- src-tauri/src/` is empty).

This is a **delta** over `docs/roadmap/agent-permission-and-pins-ground-definition.md` (written at `2b6bd26`). That report is STILL VALID for `harness/launch.rs`, `agent/subagent.rs`, `harness/loop.rs`, `harness/loop/gate.rs`, `agent/policy.rs`, `agent/fs_backend.rs`, `commands/agents.rs` and `loop/tests/policy_gate.rs` — wave 1 changed none of them (the only edits were the two literal-completion lines each in `launch.rs:1639-1640` and `commands/agents.rs:329-330,772-773`). It is STALE for exactly two files, and only where the delta below says:

- `src-tauri/src/agent/definition_permission.rs` — NEW (the final, real shape; the earlier plan's version was speculative and differed in load-bearing ways).
- `src-tauri/src/agents.rs` — the parser now reads SIX keys (five scalars + the nested `permission:` block) and returns an **8-tuple**.

Everything below is VERBATIM from the tree at HEAD unless a `[…]` elision says otherwise. No `status: committed` front-matter.

---

## 1. `src-tauri/src/agent/definition_permission.rs` — the FINAL, real shape

`1321` lines. Module doc says (verbatim, first lines):

```rust
//! The parsed `permission:` frontmatter block of an Agent definition
//! (issue #101), as a NARROWING layer only: rules here can only make a
//! call MORE restricted than the user's `filePolicy` would — never less.
//! No shape in this module can express "allow beyond the user's policy",
//! and the ONLY whole-tool spellings ever produced are the three actions
//! `allow | ask | deny`.
```

The `agent/mod.rs` re-export is exactly two new lines (verbatim):

```rust
pub mod definition_permission;
```
```rust
pub use definition_permission::{
    Action, FrontmatterNote, PermissionBlock, Rule, Rules, ToolKey, UnsupportedReason,
};
```

### 1a. Every type, its derives + serde attributes (VERBATIM)

```rust
/// The catch-all pattern spelling — the pattern opencode's docs put FIRST so
/// the specific rules after it carve out exceptions. PRIVATE on purpose: the
/// public surface of this module is exactly the aggregate the plan pins, and
/// this is a storage detail of `Rules::whole_tool`, not a type to carry.
const CATCH_ALL_PATTERN: &str = "*";
```

```rust
/// The three verdicts opencode's permission model carries (`allow | ask | deny`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Ask,
    Deny,
}
```

```rust
/// One deciding rule for a PATH-TAKING tool (issue #101, opencode shape):
/// a `pattern` that matched and the `action` the LAST matching rule in the
/// tool's (ordered) map carried. ORDERED: opencode resolves a tool's pattern
/// object in order, LAST matching rule wins — which is why the `"*"` catch-all
/// is written FIRST and the specifics after it carve out exceptions.
/// `pattern` is the layer's only place where opencode wildcards (`*`, `?`) can
/// appear. (Despite the generic sound of `pattern`, this is a PATH/PATTERN
/// matcher for path-taking tools ONLY — see [`ToolKey`].)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rule {
    pub pattern: String,
    pub action: Action,
}
```

```rust
/// The per-tool ruleset. ORDERED — opencode applies a tool's pattern object in
/// file order, LAST matching rule wins (the `"*"` catch-all first, the
/// specifics after it). A bare verdict is stored as the catch-all pattern with
/// `whole_tool: true` (see [`Rules::whole_tool`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Rules {
    pub patterns: Vec<Rule>,
    /// Whether the action applies to ANY argument (a bare `edit: deny`) or
    /// only to matching patterns. A bare verdict is `patterns == [catch-all]`
    /// with this `true`; an explicit `{"*": action}` map is the same single
    /// pattern with this `false`, so "the file said tool-wide" stays
    /// distinguishable from "the file said star". Never order-sensitive (up to
    /// the follow-up task's matcher).
    pub whole_tool: bool,
}
```

```rust
/// The per-tool discriminant. The frontmatter KEY is the identity: eleven
/// RECOGNISED keys + [`ToolKey::Unrecognized`] which RETAINS any other tool
/// name verbatim (opencode has keys this desktop has no policed twin for —
/// `glob`, `grep`, `list`, `task`, `skill`, `lsp`; an unrecognised key is
/// announced via [`FrontmatterNote::UnrecognizedToolKey`], NEVER dropped).
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
```

```rust
/// WHY a block could not be used. Only produced for `bash`-style per-command
/// pattern blocks (the scope line: parse + announce as unsupported — never
/// enforce with a matcher nothing has validated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsupportedReason {
    /// opencode `bash`-style patterns over command text (incl. its redirects)
    /// are not a validated matcher in this desktop: a `grep x file 2>/dev/null`
    /// contains a `>`, and no rule language here has ever separated "redirect
    /// to a file" from "redirect to an fd". Whole-tool `bash: deny` (a bare
    /// [`Action`]) has NO patterns and IS supported — only a bash object with
    /// ≥1 pattern row is unsupported.
    BashPatternRules,
}
```

```rust
/// The FULL ordered aggregate: every tool the block speaks about, in FILE
/// ORDER. This is the type `AgentDefinition.permission` carries.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PermissionBlock {
    /// A multi-tool block (`edit:` + `bash:` + `read:` in one file) is exactly
    /// three ordered elements. Never a HashMap: file order is faithful to how
    /// opencode applies per-tool maps (independently, in file order) and gives
    /// deterministic serialization and test assertions. Unrecognised keys are
    /// PRESERVED as [`ToolKey::Unrecognized`] — the silent-drop class #101
    /// exists to fix has no path in this type.
    pub tools: Vec<(ToolKey, Rules)>,
}
```

```rust
/// One "this file said something the reader does not understand" note — the
/// ANNOUNCE half (issue #101 / #78). A REPORT, never an error: discovery stays
/// total.
///
/// EXTERNALLY tagged (`{"unknownKey": "mode"}`), NOT `#[serde(tag = "kind")]`:
/// every payload here is a bare `String`/unit, and serde's internally-tagged
/// representation can only tag variants whose payload serializes as a MAP —
/// `tag = "kind"` would compile and then fail at RUNTIME the first time a note
/// crossed the wire, which is the silent-no-op class this issue exists to fix.
/// `frontmatter_notes_serialize_as_a_tagged_object_per_note` pins the shape
/// the follow-up (wire) task will ride.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FrontmatterNote {
    /// A top-level frontmatter key the desktop does not read (`mode:`,
    /// `temperature:`, …). `UnknownKey("permission")` is pushed ONLY when a
    /// `permission:` line yielded nothing readable at all — the key itself is
    /// known, so an ordinary `permission:` block never produces it.
    UnknownKey(String),
    /// A recognised-but-unpoliced tool name, kept verbatim (`glob`, `task`,
    /// `lsp`, `subagent`, …).
    UnrecognizedToolKey(String),
    /// A `bash`-style per-command pattern block: parsed (`Some(block)`) but
    /// announced unsupported — never enforced by a matcher nothing validated.
    UnsupportedUnvalidatedMatcher(UnsupportedReason),
    /// An action/verdict the parser does not recognise (`allow`/`ask`/`deny`
    /// are the only accepted spellings). The row is dropped and the note
    /// carries the unknown spelling verbatim; parser tolerance, never a crash.
    UnknownAction(String),
}
```

### 1b. The helper constructors (VERBATIM, inside `impl Rules`)

```rust
impl Rules {
    /// THE whole-tool constructor: a bare verdict (`edit: deny`) is the catch-all
    /// pattern carrying that action, flagged tool-wide. This is the ONLY shape
    /// that ever carries `whole_tool: true`, and the only action it can carry is
    /// an [`Action`] — so no constructor here can express a grant beyond the
    /// user's policy.
    pub fn whole_tool(action: Action) -> Self {
        Self {
            patterns: vec![Rule {
                pattern: CATCH_ALL_PATTERN.to_string(),
                action,
            }],
            whole_tool: true,
        }
    }

    /// The per-tool constructor: an ordered list of pattern rows, NOT
    /// tool-wide.
    pub fn per_tool(patterns: Vec<Rule>) -> Self {
        Self {
            patterns,
            whole_tool: false,
        }
    }

    /// The tool-wide verdict, if this ruleset IS a whole-tool catch-all
    /// (`whole_tool` + exactly the one `"*"` pattern). `None` for a per-pattern
    /// ruleset — including one that spells `{"*": action}` explicitly.
    pub fn catch_all_action(&self) -> Option<Action> {
        if self.whole_tool
            && self.patterns.len() == 1
            && self.patterns[0].pattern == CATCH_ALL_PATTERN
        {
            Some(self.patterns[0].action)
        } else {
            None
        }
    }

    /// Whether this tool is denied outright (the whole-tool `deny` the
    /// advertisement-narrowing seam can act on WITHOUT any pattern matcher).
    pub fn is_deny(&self) -> bool {
        self.catch_all_action() == Some(Action::Deny)
    }
}
```

`ToolKey::from_frontmatter_key` (VERBATIM — the fan-out; a `match`, not a map):

```rust
impl ToolKey {
    /// The frontmatter key → variant fan-out. A `match`, not a map — the only
    /// look-up this layer does, so the ordered-`Vec` discipline above never
    /// meets a map-shaped temptation. Keys are matched EXACTLY (opencode spells
    /// them lowercase); anything else is retained verbatim as
    /// [`ToolKey::Unrecognized`] rather than guessed at or dropped.
    pub fn from_frontmatter_key(key: &str) -> Self {
        match key {
            "edit" => ToolKey::Edit,
            "read" => ToolKey::Read,
            "bash" => ToolKey::Bash,
            "write" => ToolKey::Write,
            "find" => ToolKey::Find,
            "grep" => ToolKey::Grep,
            "ls" => ToolKey::Ls,
            "read_skill" => ToolKey::ReadSkill,
            "ask" => ToolKey::Ask,
            "web_search" => ToolKey::WebSearch,
            "fetch_content" => ToolKey::FetchContent,
            other => ToolKey::Unrecognized(other.to_string()),
        }
    }
}
```

### 1c. The public entry point (VERBATIM)

```rust
/// What the block reader returns: the block (`Some` when the file said
/// anything usable) and the notes it ANNOUNCES along the way. A malformed
/// block is `None` + a note — never a skip, never an error, never a panic.
pub type PermissionOut = (Option<PermissionBlock>, Vec<FrontmatterNote>);
```

```rust
pub fn parse_permission_block(fm: &[&str], idx: usize, rest: &str) -> PermissionOut {
```

`parse_permission_block(fm: &[&str], idx: usize, rest: &str) -> PermissionOut` — the NESTED reader; it does NOT return `Option<...>`, it returns the `PermissionOut` pair (`None` block + notes for an unreadable block; never a skip/error/panic). `agents.rs`'s step-3 `permission:` arm is the only caller anywhere in the tree (`parse_agent_file` line `let (block, block_notes) = parse_permission_block(fm, i, rest);` — quoted in §2b). Its full doc-block "three rules this reader owns" is quoted at length in the task04 plan and echoed in §1e below.

The reader's internal flow (for B2's matcher author): inline-on-`permission:`-line → `UnknownKey("permission")` + `(None, notes)`; `collect_block(fm, idx)` dedents (ASCII space/tab only — the NBSP byte-offset guard carries over) and returns `None` when no readable content line at all; the tool loop: skip blanks/comments; a deeper-indented stray line → `UnknownKey(row)`; `split_key_value` (colon OUTSIDE quotes) else `UnknownKey(row)`; unrecognised tool keys → `UnrecognizedToolKey(kept)` note AND retained; three rule spellings — inline `{…}` map (`split_top_level_commas`), nested indented rows (with the blank/comment skip), bare verdict (`unquote_token` + `parse_action`; a failed action → `UnknownAction(token)` + `Rules::default()`); then `if tool == ToolKey::Bash && !rules.whole_tool && !rules.patterns.is_empty() { notes.push(UnsupportedUnvalidatedMatcher(BashPatternRules)) }` (the scope line); then FIRST-WINS per tool key (`if tools.iter().any(|(seen, _)| *seen == tool) { i += 1; continue; }` — a repeated tool key keeps the first ruleset, and the second is announced by NO note because the plan defines no variant for it — recorded in `parse_permission_block`'s comment as a hand-off); empty `tools` at the end → `(None, notes)`, else `(Some(PermissionBlock { tools }), notes)`.

### 1d. the wire-spelling test pin — the load-bearing detail for the next task

**`FrontmatterNote` is EXTERNALLY tagged** (`#[serde(rename_all = "camelCase")]`, no `tag`), and `Action` is `lowercase`. **`Rule`, `Rules` and `PermissionBlock` carry NO `rename_all` at all** — so `whole_tool` serializes **snake_case** even though the parent `AgentDefinition` is `#[serde(rename_all = "camelCase")]` (a struct-level rename never reaches a nested type). By contrast `ToolKey`, `UnsupportedReason` and `FrontmatterNote` DO carry `rename_all = "camelCase"` (so `ReadSkill` → `readSkill`, `UnsupportedUnvalidatedMatcher` → `unsupportedUnvalidatedMatcher`, `BashPatternRules` → `bashPatternRules`, `UnrecognizedToolKey` → `unrecognizedToolKey`; and a `ToolKey::Unrecognized("glob")` serializes as the **externally-tagged object** `{"unrecognized":"glob"}` — the tuple element is an enum, so serde wraps it).

The two tests that pin it (VERBATIM — these are the shapes a TypeScript mirror must not guess):

```rust
    /// The notes' wire shape, pinned BEFORE the wire task lands: externally
    /// tagged, one object per note. An internally tagged (`tag = "kind"`)
    /// representation COMPILES and then fails at runtime on a `String` payload,
    /// which would be the same silent-no-op class one wave later.
    #[test]
    fn frontmatter_notes_serialize_as_a_tagged_object_per_note() {
        let notes = vec![
            FrontmatterNote::UnknownKey("mode".to_string()),
            FrontmatterNote::UnrecognizedToolKey("glob".to_string()),
            FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules),
            FrontmatterNote::UnknownAction("maybe".to_string()),
        ];
        assert_eq!(
            serde_json::to_string(&notes).unwrap(),
            "[{\"unknownKey\":\"mode\"},{\"unrecognizedToolKey\":\"glob\"},\
             {\"unsupportedUnvalidatedMatcher\":\"bashPatternRules\"},\
             {\"unknownAction\":\"maybe\"}]"
        );
    }
```

```rust
    /// The block's own wire shape (the ordered aggregate, tuples and all) —
    /// the follow-up task carries THIS, not a re-sorted map.
    ///
    /// Note the mixed casing, and that it is the plan's shape rather than an
    /// accident: `ToolKey` / `UnsupportedReason` / `FrontmatterNote` carry
    /// `rename_all = "camelCase"`, `Action` carries `lowercase`, and `Rule` /
    /// `Rules` / `PermissionBlock` carry NO rename — so `whole_tool` is
    /// snake_case even though the parent `AgentDefinition` is camelCase (a
    /// struct-level `rename_all` never reaches a nested type). Nothing from this
    /// module crosses the wire in this task, so the spelling is pinned here and
    /// handed to the wire task: if the modal wants `wholeTool`, `Rules` gains
    /// `rename_all = "camelCase"` THERE, in the change that also renders it —
    /// not silently here.
    #[test]
    fn a_permission_block_serializes_in_file_order() {
        let (b, notes) = parse_block("name: s\npermission:\n  edit: deny\n  glob: deny\n");
        assert_eq!(
            notes,
            vec![FrontmatterNote::UnrecognizedToolKey("glob".to_string())],
            "the unrecognised key is announced AND kept"
        );
        let b = b.expect("the block parses");
        assert_eq!(
            serde_json::to_value(&b).unwrap(),
            serde_json::json!({
                "tools": [
                    ["edit", {
                        "patterns": [{"pattern": "*", "action": "deny"}],
                        "whole_tool": true
                    }],
                    [{"unrecognized": "glob"}, {
                        "patterns": [{"pattern": "*", "action": "deny"}],
                        "whole_tool": true
                    }]
                ]
            }),
            "`tools` stays an ORDERED array of [toolKey, rules] pairs (a \
             recognised key is the camelCase verb, an unrecognised one is the \
             externally-tagged `{{\"unrecognized\": …}}` object so its verbatim name \
             survives). `Rule`/`Rules`/`PermissionBlock` carry no `rename_all`, so \
             `whole_tool` is snake_case — the wire task's decision to change, not \
             this one's"
        );
    }
```

**Exact camelCase vs not table (for a TS mirror — this repo has NO wire-contract test linking Rust serde to the TS types):**

| Type | `rename_all` | Wire spellings |
|---|---|---|
| `Action` | `lowercase` | `"allow"`, `"ask"`, `"deny"` |
| `Rule` | (none) | `pattern`, `action` (both already lowercase words — no visual drift) |
| `Rules` | (none) | **`patterns`, `whole_tool`** — `whole_tool` is snake_case, NOT `wholeTool` |
| `PermissionBlock` | (none) | **`tools`** |
| `ToolKey` | `camelCase` | `edit`, `read`, `bash`, `write`, `find`, `grep`, `ls`, `readSkill`, `ask`, `webSearch`, `fetchContent`; `Unrecognized(String)` serializes as the externally-tagged object `{"unrecognized":"<verbatim>"}` |
| `UnsupportedReason` | `camelCase` | `bashPatternRules` |
| `FrontmatterNote` | `camelCase` (EXTERNALLY tagged, no `#[serde(tag)]`) | `{"unknownKey":"…"}`, `{"unrecognizedToolKey":"…"}`, `{"unsupportedUnvalidatedMatcher":"bashPatternRules"}`, `{"unknownAction":"…"}` |

The doc on `FrontmatterNote` states the reason the plan's `#[serde(tag = "kind")]` was dropped: internally-tagged serialization can only tag variants whose payload serializes as a MAP; with `String`/unit payloads it would fail at RUNTIME on first wire crossing. The reader doc calls this "the silent-no-op class this issue exists to fix". **This is the one load-bearing divergence from the earlier plan** the dispatch flagged.

### 1e. Other implementation facts that differ from / go beyond the earlier plan

- The comment rule is a genuinely shipped behavior (issue-driven: the real `~/.agents/agents/researcher.md` carries seven comment lines): a line whose first non-whitespace char is `#` is skipped everywhere in a block — collector, tool loop, nested row loop — is NEVER a terminator (a column-0 comment cannot move the dedent baseline), and is NEVER announced. Trailing `#` text is deliberately kept VERBATIM (an unstripped `deny # destructive` is NOT a verdict — the row is dropped and the exact spelling announced as `UnknownAction`).
- Blank lines: skipped, never terminators (deliberate divergence from `parse_value`'s block branch, which breaks on a blank).
- Quote rule: ONE surrounding pair stripped from an exactly-quoted single token; nothing else.
- FIRST-WINS per tool key inside a block (the second block for a key is skipped silently-by-type, no note variant exists — recorded in-code as a hand-off).
- `parse_agent_file`'s top-level unknown-key announce is driven by `top_level_key(line)` (a `[\w-]+` key class) with a `known` check, so a REPEATED known key is never announced as unknown, and a `permission:` whose block is unreadable is announced exactly once per FILE via the `permission_announced` flag (the `parse_permission_block` result's own `UnknownKey("permission")` note, not a second one from the arm).
- The D4/U-turn pin `the_two_parse_value_copies_are_untouched_by_the_permission_reader` greps BOTH `parse_value` copies (`include_str!`) for their shared guards + named divergences AND asserts neither copy contains `parse_permission_block`.

---

## 2. `src-tauri/src/agents.rs` — what changed (at HEAD)

### 2a. `AgentDefinition` — the two new fields with their doc comments (VERBATIM)

Inserted between `tools` and `system_prompt`:

```rust
    /// Frontmatter `permission` (opencode's per-tool allow/ask/deny block,
    /// issue #101), typed as a NARROWING layer — an ORDERED aggregate of
    /// `(ToolKey, Rules)`, never a one-tool enum (a multi-tool block is
    /// fully representable; unrecognised tool keys are retained, not
    /// dropped). `None` → this file does not speak about permissions (the
    /// strict-of-two merge starts from `None` as "no narrowing"). `Some` →
    /// the rules this file CARRIES; enforcement is the follow-up task's.
    pub permission: Option<crate::agent::definition_permission::PermissionBlock>,
    /// The frontmatter-READ notes (unknown top-level keys, unrecognised
    /// tool keys, unsupported bash-pattern rows — issue #101's announce
    /// half; #78's principle applied to files). A REPORT, never an error:
    /// discovery stays total. The two `parse_value` copies are NOT
    /// affected. Additive: an empty vec is the ordinary case.
    /// **Wire/UI surfacing is the follow-up task's hand-off, mirroring the
    /// `shadowed` report half ("a shadow is a REPORT, not an entry", ADR
    /// 0065).** NOT the `Shadowed<T>` type: that carries
    /// `{name,path,scope}` twice. NOT widened into `shadowed` (its
    /// `[]`-wire pin stands).
    pub frontmatter_notes: Vec<crate::agent::definition_permission::FrontmatterNote>,
```

### 2b. `parse_agent_file` — the widened tuple + the `permission:` arm

The tuple is now **8-wide**: `(name, description, model, thinking, tools, permission, notes, body)` — `permission: Option<PermissionBlock>` and `notes: Vec<FrontmatterNote>` inserted between `tools` and `body`. The `#[allow(clippy::type_complexity)]` situation is UNCHANGED in spirit but the comment text moved:

```rust
/// The tolerant frontmatter reader (no YAML crate): any failure mode
/// (missing closing `---`, …) → `None` (the agent is skipped, never a
/// crash).
///
/// Returns `(name, description, model, thinking, tools, permission, notes,
/// body)` — SIX keys read (`permission` being the format's first NESTED
/// value, owned by [`crate::agent::definition_permission`]), plus the
/// announce notes for every top-level key this reader does not read.
///
/// The notes are a REPORT, never an error: the tuple is still `Some` and the
/// definition is still discovered (issue #101 / #78 — the next dialect miss
/// must not be another silent no-op, and discovery must stay total).
#[allow(clippy::type_complexity)] // the wide tuple IS the spec's signature
fn parse_agent_file(
    content: &str,
    fallback_name: &str,
) -> Option<(
    String,
    String,
    Option<String>,
    Option<String>,
    Option<Vec<String>>,
    Option<crate::agent::definition_permission::PermissionBlock>,
    Vec<crate::agent::definition_permission::FrontmatterNote>,
    String,
)> {
```

The no-frontmatter early return gained `None, Vec::new(),` (verbatim):

```rust
    if lines.first() != Some(&"---") {
        return Some((
            fallback_name.to_string(),
            String::new(),
            None,
            None,
            None,
            None,
            Vec::new(),
            normalized.trim().to_string(),
        ));
    }
```

`top_level_key` + `known` + the step-3 announce (verbatim core of the changed scan; note the comments state the D3 notes rules, and `permission_announced` implements D3's one-note-per-file):

```rust
            // The line's key (None for a line that is not a `key: value` pair
            // at all — a stray comment, a list item). A key that IS one of the
            // six is never announced, EVEN WHEN it repeats: the repeat is a
            // first-wins drop of a key the reader definitely knows, and
            // announcing it as "unknown" would be a lie about the reader.
            let key = top_level_key(line);
            let known = matches!(
                key,
                Some("name")
                    | Some("description")
                    | Some("model")
                    | Some("thinking")
                    | Some("tools")
                    | Some("permission")
            );
```

```rust
            // The NESTED arm. `parse_value` cannot carry this: it returns
            // `None` for an empty inline value, and a `permission:` block's
            // inline IS empty — its value lives entirely in the indented
            // lines below, which the scalar path never visits. So the block
            // gets its own reader (and its own parity statement — opencode's
            // markdown-agent `permission:` block, NOT a pi format).
            //
            // The READER owns every note about the block, including
            // `UnknownKey("permission")` for a `permission:` that yielded
            // nothing readable at all — so this arm EXTENDS and never adds a
            // note of its own, which would double-report the same event.
            if permission.is_none() {
                if let Some(rest) = line.strip_prefix("permission:") {
                    let (block, block_notes) = parse_permission_block(fm, i, rest);
                    // A REPEAT of an unreadable `permission:` adds nothing: the
                    // note is per file (D3's one-note-per-file rule).
                    let repeat_of_unreadable = block.is_none() && permission_announced;
                    if block.is_none() {
                        permission_announced = true;
                    }
                    if !repeat_of_unreadable {
                        notes.extend(block_notes);
                        permission = block;
                    }
                }
            }
            if !known {
                if let Some(key) = key {
                    notes.push(FrontmatterNote::UnknownKey(key.to_string()));
                }
            }
```

`top_level_key` (VERBATIM, new helper):

```rust
/// The KEY of a top-level frontmatter line, or `None` when the line is not a
/// `key: value` pair at all.
///
/// Deliberately stricter than `parse_value`'s separator rule and deliberately
/// NOT a second reader: it only decides *which key a line names*, so the
/// unknown-key announce can name it verbatim. A key must be a bare identifier
/// (`[\w-]+`, the same character class the `frontmatter.ts` reader this copy
/// mirrors uses in its `/^([\w-]+):\s*(.*)$/` regex), so a quoted token, a
/// list item (`- deny`) or a comment line is not a key and gets no note here —
/// a block's own reader announces its own unreadable rows.
fn top_level_key(line: &str) -> Option<&str> {
    let colon = line.find(':')?;
    let key = &line[..colon];
    if key.is_empty() {
        return None;
    }
    if key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Some(key)
    } else {
        None
    }
}
```

The step-5 final tuple (verbatim — body is now the LAST element):

```rust
    Some((
        name,
        description,
        model,
        thinking,
        tools,
        permission,
        notes,
        body,
    ))
```

### 2c. `discover_in_roots` — the widened destructure + how notes are accumulated

The SINGLE `parse_agent_file` call site (note: the earlier plan's claim of the production literal at `agents.rs:182` is now at line ~169; the earlier report's claim of a SECOND destructure at `:206` was already known false — one call total):

```rust
            let Some((name, description, model, thinking, tools, permission, notes, system_prompt)) =
                parse_agent_file(&content, &stem)
            else {
                continue;
            };
```

The production construction site (verbatim — `permission,`/`frontmatter_notes: notes,` use the MOVED names; this is the ONLY site that does NOT get `permission: None,`):

```rust
            by_name.insert(
                key,
                AgentDefinition {
                    name,
                    description,
                    model,
                    thinking,
                    tools,
                    permission,
                    frontmatter_notes: notes,
                    system_prompt,
                    scope: *scope,
                    path: canon.to_string_lossy().into_owned(),
                    shadowed: Vec::new(),
                },
            );
```

Notes accumulate per-file inside `parse_agent_file` (`let mut notes: Vec<FrontmatterNote> = Vec::new();`), are returned in the tuple, and land on the definition untouched — nothing in `discover_in_roots` merges, dedupes or orders them (per-file order is the step-3 scan order). A shadowed loser's `permission`/`frontmatter_notes` are NOT carried to the winner (the loser only contributes to `winner.shadowed` — unchanged).

### 2d. The three literal-completion sites

- `harness/launch.rs` `def_with()` (VERBATIM, after `tools: …`): `permission: None,` + `frontmatter_notes: Vec::new(),`.
- `commands/agents.rs` `full_definition()`: `permission: None,` + `frontmatter_notes: Vec::new(),`.
- `commands/agents.rs` `definition(name, scope)`: `permission: None,` + `frontmatter_notes: Vec::new(),`.

Nothing else in either file changed (`git diff 2b6bd26..HEAD` shows exactly those four + two lines). `AgentDefinitionDto::from` still destructures only `name/description/model/scope` and compiles unchanged.

---

## 3. The hand-offs B1 explicitly left for the next task — obligations

From the task04 plan's "Hand-off notes (to B2)" and the code/doc comments. These are OBLIGATIONS on the carry task, not suggestions:

1. **The wire half is not built; nothing reaches the UI.** From the commit message: *"The wire half is deliberately not in this commit: nothing reaches the UI yet, and the follow-up task must carry a test that fails if the notes stop reaching the DTO."* `git grep` confirms `frontmatter_notes` appears in NO other file (`commands/agents.rs`'s DTO/dto surfaces untouched, `AgentConfigDto`, `AgentDefinitionDto` unchanged, `launch.rs` production untouched). At HEAD an unknown key has **zero user-visible effect** — the announce rides `AgentDefinition` rows inside Rust only.
2. **Rot-proof test requirement (verbatim from the plan):** *"the wire task (B2/B3) MUST carry a test that fails if `frontmatter_notes` stops reaching the DTO — the sibling `Vec<FrontmatterNote>` on `AgentConfigDto` (REQUIRED like `shadowed`) or whatever surface is chosen. That requirement is part of the hand-off, not a suggestion: a `frontmatter_notes` that silently stops crossing the wire would be the exact silent-no-op #101 exists to fix, re-appearing one wave later. Write it in the B2 task's test plan *before* the wire field lands, so dropping the carry is a test failure rather than a quiet regression."*
3. **`LaunchConfig`/wire/DTO side is NOT built here** — B2 carries `permission` + `frontmatter_notes` across `resolve_agent_launch`/`LaunchConfig`/`SubagentDispatchWire` (wire-additive), decides the modal/DTO surface for the notes, and enforces the strict-of-two in `gate.rs` rows + the advertised-set chain.
4. **The notes vector is NOT `Shadowed<T>`** and must not ride `shadowed`'s wire pin (`the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads` iterates `["name","description","scope","path","file","override","effective","source","shadowed"]` and asserts every column has all three of `["model","thinking","tools"]` — quoted in full in §4c).
5. **Two announced-only conditions have NO `FrontmatterNote` variant — silently first-wins:** (a) a REPEATED `permission:` block / repeated tool key inside one block — in-code: *"two rulesets for one tool key have no meaning the follow-up task's per-key matcher could resolve. Announcing it needs a note variant this plan does not define — recorded as a hand-off, not a silent loss of the TOOL."*; (b) a REPEATED unreadable `permission:` (D3's one-note-per-file). The carry task inherits "repeated key → first wins silently" as the current contract.

---

## 4. What the next task must thread — the exact current seams (all VERBATIM at HEAD)

### 4a. `LaunchConfig` (in `agent/subagent.rs:35-61`) — field list + derives

```rust
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LaunchConfig {
    /// The agent file body (named agents); `None` for config-less dispatch.
    pub system_prompt: Option<String>,
    /// Resolved model ("provider/id" or "provider/id:<thinking>"); `None` = pi default.
    pub model: Option<String>,
    /// The thinking level from the OVERRIDE layer or the explicit tool-call
    /// param — NEVER the frontmatter's own value, and never the model key's
    /// `:<level>` suffix.
    ///
    /// This field is the TOP rung of the dispatch's thinking chain
    /// (`subagent_flow.rs`: this > the model key's suffix >
    /// `frontmatter_thinking`), so whatever lands in it outranks the suffix.
    /// ADR 0066 put the `agentOverrides` thinking level here — the only layer
    /// below the explicit param allowed to — and `resolve_agent_launch` writes
    /// it only when the model that just resolved advertises the level, so a
    /// demoted override never reaches a child (nor gets reported as effective,
    /// ADR 0068). The frontmatter's `thinking` stays in
    /// `frontmatter_thinking`, the LAST rung.
    pub thinking: Option<String>,
    /// The frontmatter's `thinking` (the dispatch resolves the thinking in
    /// the doc-correct order: explicit > model-key `:<level>` suffix >
    /// this — the frontmatter's `thinking` is the LAST rung). `None` for
    /// a config-less dispatch.
    pub frontmatter_thinking: Option<String>,
    /// Tool allowlist (named agents with `tools`); `None` → `--exclude-tools subagent`.
    pub tools: Option<Vec<String>>,
}
```

It derives `Default` AND `Deserialize`. **Literal census at HEAD:** `grep -rn "LaunchConfig {"` → **24 hits** (same count as the base report):

- **17 test literals in `harness/launch.rs` (lines 446, 491, 539, 579, 620, 661, 703, 745, 784, 822, 874, 916, 1020, 1397, 1867, 1936, 1989) — ALL use `..Default::default()`.** The fully-specified lines 1397/1867/1936/1989 from the base report have since been converted to `..Default::default()` (1397 → `model`,`thinking`,`tools` + `..Default::default()`; the other three → `..Default::default()`). **At HEAD there are ZERO fully-specified `LaunchConfig {` literals left in the tree except the two production sites below.** The base report's count "4 fully-specified literals + fake_worker" is stale in the GOOD direction — an additive field breaks only the two production literals.
- **The two production literals that WILL break compile on a new field:**
  - `src-tauri/src/bin/fake_worker.rs:509` (fully-specified: `system_prompt, model: None, thinking: None, frontmatter_thinking: None, tools` — **no `..Default::default()`**; and `cargo test --lib` does NOT rebuild `fake_worker` per AGENTS.md, so a B2 protocol change must be validated with `cargo build --all-targets`).
  - `src-tauri/src/agent/interactive/mod.rs:135` (fully-specified `system_prompt`/`model`/`thinking`/`tools` from params + `..Default::default()` — this one HAS the spread, so it survives an additive field).
- All `LaunchConfig::default()` call sites (43) survive additively; the other 6 literal sites (`dispatch.rs:169`, `subagent.rs:1023,1071`) use `..Default::default()` and survive.

The `resolve_agent_launch` output literal (`launch.rs:271`, VERBATIM — B2's main edit; `ResolvedLaunch` has exactly ONE construction site, line 270):

```rust
    ResolvedLaunch {
        launch: LaunchConfig {
            system_prompt,
            model,
            thinking,
            frontmatter_thinking: def.thinking.clone(),
            tools,
        },
        model_source,
        thinking_source,
        tools_source,
    }
```

`ResolvedLaunch` (verbatim):

```rust
pub(crate) struct ResolvedLaunch {
    pub launch: LaunchConfig,
    /// Which layer supplied `model`; `Parent` when none did.
    pub model_source: OverrideSource,
    /// Which layer supplied `thinking`; `Parent` when none did. A demoted
    /// override level (one the resolved model does not advertise) is NEITHER
    /// written NOR reported, so this never reads `Override` for a level the
    /// child will not use.
    pub thinking_source: OverrideSource,
    /// Which layer supplied `tools`; `Parent` when none did.
    pub tools_source: OverrideSource,
}
```

### 4b. `first_speaking` + the three rung lists + the system-prompt layering + `narrow`

```rust
fn first_speaking<T>(
    rungs: impl IntoIterator<Item = (OverrideSource, Option<T>)>,
) -> (Option<T>, OverrideSource) {
    rungs
        .into_iter()
        .find_map(|(source, value)| value.map(|value| (Some(value), source)))
        .unwrap_or((None, OverrideSource::Parent))
}
```

Tools rung + `narrow` (verbatim — the shape a whole-tool `deny` filter mirrors; `narrow` = drop unknown names + strip `subagent`/`list_agents` + treat an emptied list as ABSENT):

```rust
    let specs = tool_specs();
    let narrow = |names: &[String]| {
        let known: Vec<String> = names
            .iter()
            .filter(|name| {
                name.as_str() != "subagent"
                    && name.as_str() != "list_agents"
                    && specs.iter().any(|s| s.name == **name)
            })
            .cloned()
            .collect();
        (!known.is_empty()).then_some(known)
    };
    let (tools, tools_source) = first_speaking([
        // The explicit list is passed VERBATIM — this layer is the only one
        // that can hand a child zero tools (ADR 0067).
        (OverrideSource::Parent, explicit.tools.clone()),
        (
            OverrideSource::Override,
            layer
                .global
                .and_then(|o| o.tools.as_ref())
                .and_then(|t| narrow(t)),
        ),
        (
            OverrideSource::File,
            def.tools.as_ref().and_then(|t| narrow(t)),
        ),
    ]);
    // An EMPTY frontmatter body means "no system prompt" (the `or_else` must not
    // turn it into `Some("")` — `dispatch_native` would prepend an empty
    // message). The system-prompt layering is unchanged by ADR 0066 (an
    // override cannot speak about prompts).
    let system_prompt = explicit
        .system_prompt
        .clone()
        .or_else(|| (!def.system_prompt.is_empty()).then(|| def.system_prompt.clone()));
```

`resolve_agent_launch`'s signature + doc (identical to base):

```rust
/// Resolve a launch against the definition + the override layer: per field,
/// the FIRST layer that supplies a value wins (`explicit > override >
/// frontmatter > parent`), each field independently.
///
/// This is the shared seam ADR 0068 asks for — `resolve_launch` (the dispatch)
/// and `list_agent_config` (the modal) call it, so filtering and soft
/// degradation exist in exactly one place.
pub(crate) fn resolve_agent_launch(
    explicit: &LaunchConfig,
    def: &AgentDefinition,
    layer: &OverrideLayer<'_>,
    catalog: &ModelCatalog,
) -> ResolvedLaunch
```

**A `permission` copy-through is NOT a `first_speaking` candidate today** (no `OverrideSource::Permission` variant; adding one breaks the §11 three-layer pins quoted below).

### 4c. The DTO wire-shape pin test — the column list a new field forces an update to (VERBATIM)

`commands/agents.rs` test:

```rust
    /// The camelCase wire contract Task 4's TypeScript is written against.
    /// Note `override_` → `override` (a Rust field cannot be named `override`)
    /// and the always-present nullable fields inside the three column structs.
    #[test]
    fn the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads() {
        let rows = agent_config(
            &Settings::default(),
            std::slice::from_ref(&definition("scout", AgentScope::User)),
            &catalog(),
        );
        let json: serde_json::Value = serde_json::to_value(&rows[0]).unwrap();
        let row = json.as_object().unwrap();
        for key in [
            "name",
            "description",
            "scope",
            "path",
            "file",
            "override",
            "effective",
            "source",
            "shadowed",
        ] {
            assert!(row.contains_key(key), "missing `{key}` in {json}");
        }
        // `override_` speaks as `override` — and NOT as `override_`.
        assert!(
            !row.contains_key("override_"),
            "the trailing underscore is a Rust spelling, not a wire name: {json}"
        );
        // Every column struct carries all three fields, `null` when absent —
        // Task 4 types them `string | null`, so an absent key would be a lie.
        for column in ["file", "override", "effective"] {
            let obj = row[column].as_object().unwrap();
            for key in ["model", "thinking", "tools"] {
                assert!(
                    obj.contains_key(key),
                    "`{column}.{key}` must be present (null), not absent: {json}"
                );
                assert!(
                    obj[key].is_null(),
                    "`{column}.{key}` should be null: {json}"
                );
            }
        }
        let source = row["source"].as_object().unwrap();
        for key in ["model", "thinking", "tools"] {
            assert_eq!(source[key], serde_json::json!("parent"), "`{key}`: {json}");
        }
    }
```

Column list as of now (verbatim): `["name","description","scope","path","file","override","effective","source","shadowed"]`; each of `file`/`override`/`effective` must have keys `["model","thinking","tools"]` (all `null` on the default row); `source` must have `["model","thinking","tools"]` all `"parent"` (the `-D warnings`-safe exhaustive `OverrideSource` match in `the_source_label_space_is_exactly_three_layers_and_never_space` is the third pin — `OverrideSource` must NOT gain a `Permission` variant without breaking it).

### 4d. `file_fields` / `stored_fields` / `agent_config` (VERBATIM)

```rust
fn file_fields(def: &AgentDefinition) -> OverrideFields {
    OverrideFields {
        model: def.model.clone(),
        thinking: def.thinking.clone(),
        tools: def.tools.clone(),
    }
}
```

```rust
fn stored_fields(layer: &crate::agent::harness::launch::OverrideLayer<'_>) -> OverrideFields {
    layer.global.map(OverrideFields::from).unwrap_or_default()
}
```

`agent_config` core (verbatim — `effective`/`source` read `resolved.launch.*` / `resolved.*_source`; the natural spot for a `filePermission`/`effectivePermission`-style sibling field):

```rust
            AgentConfigDto {
                name: def.name.clone(),
                description: def.description.clone(),
                scope: def.scope.to_string(),
                path: def.path.clone(),
                file: file_fields(def),
                // The STORED entry verbatim — a stale pin has to stay visible
                // beside the value that replaced it.
                override_: stored_fields(&layer),
                effective: OverrideFields {
                    model: resolved.launch.model,
                    thinking: resolved.launch.thinking,
                    tools: resolved.launch.tools,
                },
                source: SourceFields {
                    model: resolved.model_source,
                    thinking: resolved.thinking_source,
                    tools: resolved.tools_source,
                },
                shadowed: def.shadowed.clone(),
            }
```

`OverrideFields` (`#[serde(rename_all = "camelCase")]`, 3 fields, `Default`) and `SourceFields` (3 fields × `OverrideSource`), `From<&AgentOverrideFields>` — all unchanged from base. The `AgentConfigDto.shadowed` doc pins the precedent for a REQUIRED non-`Option` `Vec` on the wire ("REQUIRED on the wire, not `Option`: the Rust side always serializes the `Vec` (empty as `[]`)") — the sibling `Vec<FrontmatterNote>` carry should follow it.

### 4e. The gate seam (VERBATIM at HEAD) — `POLICIED_TOOLS`, `policed_direction`, `Decision`, `decision_for`

```rust
pub(super) const POLICIED_TOOLS: &[(&str, PolicyDirection)] = &[
    ("bash", PolicyDirection::Shell),
    ("read", PolicyDirection::Read),
    ("find", PolicyDirection::Read),
    ("grep", PolicyDirection::Read),
    ("ls", PolicyDirection::Read),
    ("write", PolicyDirection::Write),
    ("edit", PolicyDirection::Write),
];
```

```rust
pub(super) fn policed_direction(tool: &str) -> Option<PolicyDirection> {
    POLICIED_TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, dir)| *dir)
}
```

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Run the tool as-is.
    Allow,
    /// Prompt via the existing `gate_tool`.
    Ask,
    /// Reject with a tool-result error; never a prompt.
    Deny,
    /// Run, but inside the OS sandbox (Task 5). Produced ONLY for `bash`.
    Confine,
}
```

```rust
pub fn decision_for(policy: AccessPolicy, beyond: bool, trusted: bool, is_shell: bool) -> Decision {
    // Inside the boundary every policy allows — the policy decides ONLY
    // the beyond-boundary case.
    if !beyond {
        return Decision::Allow;
    }
    match policy {
        // The derived default: silent.
        AccessPolicy::Allow => Decision::Allow,
        // A prompt, unless Trust suppresses it. Trust is checked HERE and
        // nowhere else: it is a suppressor of prompts, never a widener.
        AccessPolicy::Ask => {
            if trusted {
                Decision::Allow
            } else {
                Decision::Ask
            }
        }
        // `bash` is CONFINED, not refused (Task 5's Landlock sandbox); a
        // path tool has nothing to confine, so it is refused. `trusted`
        // is deliberately unread in this arm — Deny is never widened.
        AccessPolicy::Sandboxed if is_shell => Decision::Confine,
        AccessPolicy::Sandboxed => Decision::Deny,
    }
}
```

### 4f. `policy_verdict` — the exact insertion geometry (VERBATIM)

```rust
    pub(super) fn policy_verdict(&self, tc: &ToolCall) -> Option<Decision> {
        let dir = policed_direction(&tc.name)?;
        let (policy, beyond, resolved) = match dir {
            PolicyDirection::Shell => {
                // No path to judge: a command can reach ANYWHERE, so it is
                // always beyond the boundary (see `decision_for`). Rules never
                // apply to `bash` either (the spec's guard-rail), so there is
                // nothing to resolve.
                (self.file_policy.shell, true, None)
            }
            PolicyDirection::Read | PolicyDirection::Write => {
                let Some(raw) = tc.arguments.get("path").and_then(|v| v.as_str()) else {
                    // `read` / `write` / `edit` REQUIRE a path (the executor
                    // rejects the call without one) and the directory tools
                    // default it to the `cwd` — either way there is nothing
                    // to gate, and NOTHING to guard: an absent or empty `path`
                    // never reaches a guard ask.
                    return Some(Decision::Allow);
                };
                let policy = self.direction_policy(dir);
                let beyond = self.beyond_error(dir, Path::new(raw)).is_some();
                let resolved = (dir == PolicyDirection::Write)
                    .then(|| crate::agent::fs_backend::canonicalize_lenient(Path::new(raw)));
                (policy, beyond, resolved)
            }
        };
        let trusted = self.space_trusted();
        // (T03 rows 1–3) For a WRITE with a usable path, a RULE — or the
        // absence of one under an agent-definition dir — may decide before the
        // posture does. See [`Self::write_rule_decision`] for the rows.
        if dir == PolicyDirection::Write {
            if let Some(resolved) = resolved.as_deref() {
                if let Some((verdict, _)) = self.rule_or_guard_verdict(resolved, trusted) {
                    return Some(verdict);
                }
            }
        }
        Some(decision_for(
            policy,
            beyond,
            trusted,
            dir == PolicyDirection::Shell,
        ))
    }
```

`rule_or_guard_verdict` — the 4-row precedence table the per-agent layer must be placed RELATIVE TO (VERBATIM):

```rust
    fn rule_or_guard_verdict(
        &self,
        resolved: &Path,
        trusted: bool,
    ) -> Option<(Decision, Option<PathBuf>)> {
        if let Some(rule) = crate::agent::policy::rule_for(
            &self.rules,
            crate::agent::policy::RuleDirection::Write,
            resolved,
            self.rules_home.as_deref(),
        ) {
            return Some((
                match rule.decision {
                    // Row 1.
                    crate::agent::policy::RuleDecision::Deny => Decision::Deny,
                    // Row 2 — silent; the posture is not consulted.
                    crate::agent::policy::RuleDecision::Allow => Decision::Allow,
                },
                None,
            ));
        }
        // Row 3: no rule speaks to this write, but it lands inside an
        // agent-definition dir. With `default_rules()` EMPTY these two facts
        // are the ORDINARY default posture, not an override — which is the
        // whole point of the round-3 correction.
        if self.is_guard_path(PolicyDirection::Write, resolved) && !trusted {
            return Some((Decision::Ask, Some(resolved.to_path_buf())));
        }
        None
    }
```

`deny_tool_result`, `is_guard_path`, `rule_deny_for`, `guard_target`, `beyond_error` — all byte-identical to the base report's §7e quotes (verified by line-checking; the wording of the `bash`-refusal branch is unchanged: `None => format!("{}: refused by the file-access policy (Sandboxed)", tc.name)`). For the seams quoted in the base report only, the line numbers at HEAD: `is_guard_path` at `gate.rs:270`, `direction_policy` at `:277`, `beyond_error` at `:311`, `deny_tool_result` at `:335`, `rule_deny_for` at `:384`, `escape_text` at `:410`, `guard_target` at `:240`, `gate_tool` at `:470`. The gate consumes `policy_verdict` in `turn.rs:471-497` (verbatim):

```rust
                match self.policy_verdict(tc) {
                    Some(Decision::Ask) => {
                        let guard = self.guard_target(tc);
                        if self.gate_tool(tc, turn, guard.as_deref()).await {
                            self.dispatch_tool(tc, turn).await
                        } else {
                            ToolResult {
                                content: vec![ContentBlock::Text {
                                    text: "permission denied".to_string(),
                                }],
                                details: None,
                                is_error: true,
                            }
                        }
                    }
                    Some(Decision::Deny) => self.deny_tool_result(tc),
                    _ => self.dispatch_tool(tc, turn).await,
                }
```

### 4g. How `enabled_tools` is computed for a child — the whole-tool-deny seam

`subagent_flow.rs:629` (VERBATIM, the three-way rule):

```rust
    let child_tools: Vec<String> = match &wire.launch.tools {
        Some(tools) => tools
            .iter()
            .filter(|t| !matches!(t.as_str(), "subagent" | "list_agents"))
            .cloned()
            .collect(),
        None => {
            if wire.parent_enabled_tools.is_empty() {
                tool_specs()
                    .into_iter()
                    .map(|t| t.name)
                    .filter(|t| !matches!(t.as_str(), "subagent" | "list_agents"))
                    .collect()
            } else {
                wire.parent_enabled_tools
                    .iter()
                    .filter(|t| !matches!(t.as_str(), "subagent" | "list_agents"))
                    .cloned()
                    .collect()
            }
        }
    };
```

then `StartEnv::from_parts(…, Some(child_tools.clone()), …)` — the 8th positional arg is `enabled_tools` (`protocol.rs:246 pub enabled_tools: Option<Vec<String>>`), applied verbatim by `worker/core.rs` (`loop_.set_enabled_tools(env.enabled_tools.clone());`), and advertised by `loop.rs:1077`'s `advertised_tool_specs` (filter (a) `enabled_tools` match, (b) `subagent`/`list_agents` dropped when `is_child`). **A whole-tool `deny` that must drop the tool from the child's advertised set hooks: (1) `resolve_agent_launch`'s tools rung / `narrow`-style filter on `def.permission` (pre-wire — `launch.tools` already narrowed), or (2) `subagent_flow`'s `child_tools` computation (post-wire).** The gate does NOT control advertisement; the resolver/flow does. `SubagentDispatchWire.launch` (`protocol.rs:341 pub launch: crate::agent::subagent::LaunchConfig`) is wire-additive per serde — old daemons tolerate an unknown key, and `LaunchConfig::default()` gives `None`.

---

## 5. The narrowing-only constraint, made concrete

Issue #101 requires the effective verdict to be the STRICTER of the user's `filePolicy` verdict and the definition's rule — the per-agent layer may narrow, never widen. With the real `Decision` enum (`Allow | Ask | Deny | Confine`) and the real precedence rows, "stricter" needs a precise ordering because a naive `min` is WRONG.

**Proposed ordering (the vocabulary makes it forced)** — per-call, per-tool/path decision, from LEAST to MOST restrictive:

```
Allow < Confine < Ask < Deny
```

Read this as: `Deny` is the strictest (a tool-result error, never a prompt — `turn.rs` maps `Some(Decision::Deny)` → `deny_tool_result`), `Ask` next (a prompt via `gate_tool`, or a suppressible deny on a trusted Space), `Confine` next (the sandboxed `bash` runs — it is actionable), `Allow` least (run as-is). So "stricter(a, b)" = the one that appears LATER in that order, and `Allow` is the identity for the merge (`stricter(Allow, x) = x`).

**Why `Confine` is not "between" `Ask` and `Deny` in a simple `min`:** `Confine` is only producible by the posture path for `bash` under `file_policy.shell == Sandboxed` (`AccessPolicy::Sandboxed if is_shell => Decision::Confine`, `decision_for`). Semantically a confined `bash` RUNS (inside the Landlock sandbox) — so `Confine` is LESS restrictive than both `Ask` (which may block via the prompt) and `Deny` (which errors). If "stricter" were computed by ranking on a line `Allow < Ask < Deny` (the ADR 0030 pre-Sandbox mental model) a `Confine` would be mis-ranked; and the per-agent vocabulary (`Action = Allow | Ask | Deny`) has NO `Confine` at all — the layer simply cannot express "sandbox it". The correct merge for `bash` is therefore: **per-agent `Action::Deny` (via `Rules::is_deny()` / a whole-tool catch-all) beats `Confine`; everything else (Allow/Ask/patterns) leaves `Confine` alone**, because a per-agent `Allow` cannot un-confine a `Sandboxed` shell policy and a per-agent `Ask` cannot widen a confined run. `stricter` as `max` over `Allow < Confine < Ask < Deny` gives exactly that: `max(Ask, Confine) = Ask` (a per-agent `ask` on a `Sandboxed` shell DOES tighten — that matches the spec: a `bash: ask` in a file under a user Sandboxed-shell policy should prompt) and `max(Allow, Confine) = Confine`.

**The exact point in `policy_verdict` where the per-agent layer must be consulted** (so it cannot bypass the protected-dir guard or the trust rules):

`policy_verdict` resolves `(policy, beyond, resolved)` for the direction, then:
- **WRITE (and only write today — reads have no gate-side rule layer):** `rule_or_guard_verdict` runs FIRST (rows 1–4: rule `Deny` → `Deny` trust-immune; rule `Allow` → `Allow` silent; row-3 guard `Ask` for an untrusted agent-dir write; row-4 `None` → posture). **The per-agent layer must be consulted AFTER `rule_or_guard_verdict` returns `None` (row 4) and BEFORE (or as part of the final) `decision_for`**, or after `decision_for` produces its verdict — but in BOTH cases its `Deny` must be able to override a posture `Allow`/`Ask`/`Confine`, and its `Allow` must NOT be able to override a row-1 rule `Deny`, the row-3 guard `Ask`, or a posture `Deny`/`Confine`. Concretely: `stricter(per_agent_verdict, posture_or_rule_verdict)` with the ordering above gives the required property — `Allow` never overrides anything (it is the identity), `Ask`/`Deny` only ever tighten.
- The two placements to explicitly FLAG:
  - **Inside the write branch, before the posture select:** a placement that returns the per-agent verdict BEFORE `rule_or_guard_verdict` would let a per-agent `Allow` bypass the row-3 protected-dir guard ASK (a definition file could write into the four protected dirs silently — a WIDENING). That is forbidden.
  - **`decision_for`'s `AccessPolicy::Ask` + trusted → `Allow` arm:** `decision_for` checks trust internally. A per-agent layer merged AFTER `decision_for` sees `Allow` where the untrusted row-3 guard previously returned `Ask` via `rule_or_guard_verdict` (which already handled trust); the per-agent layer must still be able to produce `Ask`/`Deny` there, which the ordering merge does (`Ask` beats an `Allow` that trust produced).
- **READ / SHELL (`policy_verdict`'s other paths):** `policed_direction(&tc.name)?` returns `None` for non-policed tools (`get_search_content`, `subagent`, `mcp`, the skill tools, `manage_todo_list`, `sudo_exec`, `list_skills`, `list_agents`) — those calls never reach `policy_verdict` (the `?` early-returns `None`), so a per-agent `read_skill: deny` or `subagent: deny` has NO gate-side hook today; per the toolkey table (§1e) those keys parse as `ToolKey::Unrecognized` (announced) and their enforcement, if any, is a NEW tool-level check OUTSIDE `policed_direction` (the natural seam: a pre-`dir` check in `policy_verdict`, or a filter in the advertisement chain of §4g). **The recognized `ToolKey` set that CAN map onto `policed_direction`/`decision_for` today:** `bash`→Shell, `read`/`find`/`grep`/`ls`→Read, `write`/`edit`→Write — and `Write`/`ReadSkill`/`Ask`/`WebSearch`/`FetchContent` have no policed twin (they parse + announce; enforcement needs the new check). Note `read` is Read, NOT `GetSearchContent`; `grep` and `find` are Read; their `pattern`/`max_results` args are not the gated `path`.
- **`deny_tool_result` interplay:** a per-agent `Deny` must render the SAME tool-result text a rule/posture `Deny` would (the design: "a gate denial and an executor denial read identically to the model"). The current `deny_tool_result` routes protected-dir writes to `protected_refusal_text`, rule denies to `access::rule_deny_text`, everything else to `escape_text`, and `bash` to `"{}: refused by the file-access policy (Sandboxed)"` — a per-agent `Deny` on `bash` should reuse that same sentence shape rather than inventing a fourth wording (the base report's finding 6: executor parity is byte-level).

---

## 6. No other per-agent permission concept exists in the tree

`grep -rn "permission" src-tauri/src/agent/harness/launch.rs src-tauri/src/agent/subagent.rs src-tauri/src/agent/harness/loop/gate.rs src-tauri/src/agent/harness/loop.rs` returns ONLY:

- `gate.rs:8` `use crate::agent::permission::{native_permission_gate, permission_title, PermissionOutcome};` — the **unrelated ADR 0010 native UI prompt gate** (module doc: *"The native in-process permission gate (ADR 0010): turns the native `AgentLoop`'s permission requests into a UI prompt, and delivers the user's answer back to the loop."*; `gate.rs:477/479/489/492/494` are its `permission_options`/`native_permission_gate`/`permission_title` calls inside `gate_tool`).
- `loop.rs:49` `use crate::agent::permission::PendingPermissions;`, `loop.rs:192 pub pending_permissions: PendingPermissions`, `:340`, `:395` — the same ADR 0010 machinery.
- `harness/launch.rs:1639` — the new `permission: None,` literal completion in `def_with` (B1).

**`src-tauri/src/agent/permission.rs` is the ADR 0010 UI gate, NOT the frontmatter ruleset's home** — the parse target is `agent/definition_permission.rs`, a DIFFERENT file; B2 must not wire the frontmatter ruleset's storage into `agent/permission.rs` (its `Ask` verdict is *consumed* by `gate_tool`, but the module is the prompt-delivery layer, and even the new file's own module doc says so — *"Not `crate::agent::permission` (a PRIVATE module, despite the similar name) — that is the unrelated ADR 0010 native UI prompt gate"*). The only `permission`-related frontmatter concept in the whole tree is `AgentDefinition.permission` + `frontmatter_notes` + `agent::definition_permission`.

---

## Findings summary (what the delta changes for the NEXT task)

1. **Stale-report corrections:** (a) `AgentDefinition` gained `permission: Option<PermissionBlock>` + `frontmatter_notes: Vec<FrontmatterNote>` and `parse_agent_file` returns an 8-tuple (was 6); (b) there are ZERO fully-specified `LaunchConfig {` test literals left — at HEAD only `fake_worker.rs:509` (no spread) and `interactive/mod.rs:135` (has `..Default::default()`) are production literals, so a `permission` field breaks compile in exactly ONE file `cargo test --lib` will not catch (`fake_worker` — validate with `cargo build --all-targets`); (c) the `def_with`/`full_definition`/`definition` literals already carry the two new fields at HEAD — B1 completed its own compile-collision work.
2. **Wire spellings (the silent-drift trap):** `whole_tool` is snake_case (`Rule`/`Rules`/`PermissionBlock` have NO `rename_all`); `Action` is lowercase; `ToolKey`/`UnsupportedReason`/`FrontmatterNote` are camelCase; `FrontmatterNote` is EXTERNALLY tagged (NOT `#[serde(tag="kind")]`); `ToolKey::Unrecognized` serializes as `{"unrecognized":"<verbatim>"}`. Pinned by `frontmatter_notes_serialize_as_a_tagged_object_per_note` and `a_permission_block_serializes_in_file_order` — a TS mirror must mirror these exactly (no wire-contract test exists to catch drift).
3. **Hand-off obligations B2 inherits:** the wire half has zero user-visible effect today; the carry task MUST ship a test failing if `frontmatter_notes` stops reaching the DTO; `permission`/`frontmatter_notes` must cross `resolve_agent_launch`/`LaunchConfig`/`SubagentDispatchWire`; the notes must not ride `shadowed`; a repeated tool key / repeated unreadable `permission:` has no note variant (silently first-wins) — the current contract.
4. **Thread seams all verified unchanged** from the base report's §5–§11 (with the line-number and literal-census corrections above): `ResolvedLaunch` has one construction site; `first_speaking` unchanged; the DTO pin's column list is `["name","description","scope","path","file","override","effective","source","shadowed"]` (a new field = update the list); `POLICIED_TOOLS`/`policed_direction`/`Decision`/`decision_for`/`policy_verdict`/`rule_or_guard_verdict`/`deny_tool_result`/`is_guard_path` verbatim; `child_tools` in `subagent_flow.rs:629` is the advertisement seam.
5. **"Stricter" over the real `Decision`:** `Allow < Confine < Ask < Deny` (projecting the per-agent `Allow|Ask|Deny` onto it) — `Deny` trust-immune-strictest, `Ask` next, `Confine` (a RUNNING sandbox) below `Ask`, `Allow` the identity. A naive `min` over just `{Allow,Ask,Deny}` is wrong for `bash` because `Confine` sits between `Allow` and `Ask`, and the per-agent layer has no `Confine` to express. Consult the per-agent layer AFTER `rule_or_guard_verdict` (row 4) so a per-agent `Allow` can never bypass the row-3 protected-dir guard or a row-1 rule `Deny`, and the merge must let a per-agent `Ask`/`Deny` tighten a trust-widened `Allow`.
6. **No other per-agent permission concept exists** — only ADR 0010's UI prompt gate (`agent/permission.rs`) and the new B1 surface; `agent/definition_permission.rs` owns the whole ruleset vocabulary.

**Sources:** `src-tauri/src/agent/definition_permission.rs` (HEAD), `src-tauri/src/agents.rs` (HEAD), `src-tauri/src/agent/mod.rs` (HEAD), `src-tauri/src/agent/harness/launch.rs` (HEAD), `src-tauri/src/agent/subagent.rs` (HEAD), `src-tauri/src/agent/harness/loop.rs` (HEAD), `src-tauri/src/agent/harness/loop/gate.rs` (HEAD), `src-tauri/src/agent/harness/loop/turn.rs` (HEAD), `src-tauri/src/agent/harness/loop/tools.rs` (HEAD), `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` (HEAD), `src-tauri/src/agent/harness/dispatch.rs`, `src-tauri/src/agent/worker/manager/subagent_flow.rs`, `src-tauri/src/agent/worker/core.rs`, `src-tauri/src/agent/worker/protocol.rs`, `src-tauri/src/agent/worker/dispatch.rs`, `src-tauri/src/agent/interactive/mod.rs`, `src-tauri/src/bin/fake_worker.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/agent/policy.rs`, `src-tauri/src/agent/permission.rs`, `src-tauri/src/agent/boundary.rs`, `src-tauri/src/agent/harness/tool_specs.rs`, `docs/roadmap/agent-permission-and-pins-task04-parse-permission-frontmatter.md`, `docs/roadmap/agent-permission-and-pins-ground-definition.md`, commit `2ccf1ff`, HEAD `27d761c`.