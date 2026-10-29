# Grounding — permission-guard (issue #124: announce an unenforced path-tool pattern map)

**Area:** how an agent definition's `permission:` frontmatter is parsed into rules, turned into `FrontmatterNote`s, and consulted by the harness policy gate.
**Branch:** `feature/backlog-79-122-124-28` (dirty; read-only).
**Task served:** issue #124 on `danielcherubini/archimedes` — the residue of #101.
**Owner decision (already made, do not re-open):** **ANNOUNCE, do not enforce.** Drop the bash-only guard so ANY unenforced pattern map announces itself as unsupported. The "enforce path patterns via the shared canonicaliser" option is OUT OF SCOPE for this run — record it as a follow-up candidate only.
**Files in scope (Owns set):** `src-tauri/src/agent/definition_permission.rs`, `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/agents.rs`.

All Rust line numbers are against this tree on this branch. All quotes are verbatim from that tree. The status file (`docs/roadmap/backlog-79-122-124-28-status.md` row A3 / #124) already names this task as `backlog-79-122-124-28-task03-path-pattern-announce.md` with the same four files.

---

## 1. `FrontmatterNote` and `UnsupportedReason` — full definitions, and who consumes the note list

Both enums live in `src-tauri/src/agent/definition_permission.rs`. The `UnsupportedReason` enum (lines 194–204) — note the doc comments, which state the current scope line verbatim:

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

The `FrontmatterNote` enum (lines 231–248):

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

There is currently **one** consumer of the note list, and it is the full chain from parse to UI:

- `agents.rs` (the field + reader): `AgentDefinition.frontmatter_notes: Vec<crate::agent::definition_permission::FrontmatterNote>` (line 139 in `agents.rs`), filled by `parse_agent_file` step 3 — `notes.extend(block_notes)` from `parse_permission_block` (agents.rs lines ~450–460). So the note list is a **REPORT, never an error**: the definition is still discovered; the notes ride the definition row.
- `commands/agents.rs` (the wire DTO, ADR 0068): `AgentConfigDto` carries `pub frontmatter_notes: Vec<crate::agent::definition_permission::FrontmatterNote>` (line 226), copied verbatim at `frontmatter_notes: def.frontmatter_notes.clone()` (line 305) inside `list_agent_config`.
- `src/lib/tauri/types.ts` (the TS mirror): `AgentFrontmatterNote` (line 915) with the union member `{ unsupportedUnvalidatedMatcher: AgentUnsupportedReason }` (line 923) and `AgentUnsupportedReason = "bashPatternRules"` (line 834).
- `src/components/AgentsDialog.tsx` (the modal): `PermissionReport` reads `row.frontmatterNotes`, and `describeNote` renders the note into words. This is the **only UI surface**; it renders automatically for any note variant (see §6).

The modal's render is display-only, plain text, ordered as the backend sent it, one muted line per note (`notes.map(...)` → `<MutedCaption>{describeNote(note)}</MutedCaption>`, `AgentsDialog.tsx` `PermissionReport` bottom block).

---

## 2. THE GUARD ITSELF — the `notes.push` site, its enclosing condition, the enclosing function signature, and `ToolKey`'s variants

Enclosing function — the block reader's signature (definition_permission.rs line 270):

```rust
pub fn parse_permission_block(fm: &[&str], idx: usize, rest: &str) -> PermissionOut {
```

with `pub type PermissionOut = (Option<PermissionBlock>, Vec<FrontmatterNote>);` (line 257).

`ToolKey`'s variants (lines 142–167):

```rust
/// The per-tool discriminant. The frontmatter KEY is the identity: eleven
/// RECOGNISED keys + [`ToolKey::Unrecognized`] which RETAINS any other tool
/// name verbatim (opencode has keys this desktop has no policed twin for —
/// `glob`, `grep`, `list`, `task`, `skill`, `lsp`; an unrecognised key is
/// announced via [`FrontmatterNote::UnrecognizedToolKey`], NEVER dropped).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

(`ToolKey::from_frontmatter_key`, the `match` fan-out `"edit" → Edit`, `"read" → Read`, `"bash" → Bash`, `"write" → Write`, `"find" → Find`, `"grep" → Grep`, `"ls" → Ls`, `"read_skill" → ReadSkill`, `"ask" → Ask`, `"web_search" → WebSearch`, `"fetch_content" → FetchContent`, else `Unrecognized(verbatim)`, is at lines 172–188.)

The **guard and its lone push site** — the ONLY place `UnsupportedUnvalidatedMatcher` is ever constructed (definition_permission.rs lines 414–425, verbatim):

```rust
        // The scope line: a bash OBJECT with ≥1 pattern row parses (it must) and
        // announces itself unsupported — command text carries its redirects, so
        // no matcher here has any business deciding it. A whole-tool `bash: deny`
        // needs no matcher and is therefore SUPPORTED (no note).
        if tool == ToolKey::Bash && !rules.whole_tool && !rules.patterns.is_empty() {
            notes.push(FrontmatterNote::UnsupportedUnvalidatedMatcher(
                UnsupportedReason::BashPatternRules,
            ));
        }
```

Dropping the bash-only guard = removing `tool == ToolKey::Bash &&` from this condition (the decision: any unenforced pattern map — any `!rules.whole_tool && !rules.patterns.is_empty()` ruleset — announces itself). The `rules` variable in scope is the just-parsed `Rules` for the current tool in the loop (`let rules = if ...` above), and `tool` is the `ToolKey` from `ToolKey::from_frontmatter_key(key)`.

Note also the module-level framing comment at the top of definition_permission.rs (lines 30–32): *"Not an enforcer. This task parses, types and ANNOUNCES; carrying the block to the gate and deciding the strict-of-two against the user's policy is the follow-up task's job."* — that "follow-up task" was #101 task05b and has landed; the parse module still only ever announces.

---

## 3. How `UnsupportedReason` is constructed today, and the exhaustive-match blast radius of adding a variant

**Construction sites — exactly three in the whole tree, all `BashPatternRules`, and two of them are test expectations:**

- definition_permission.rs line 420 — the guard (`UnsupportedReason::BashPatternRules` inside the `notes.push`).
- agents.rs line 1533 — inside test `a_permission_announces_unsupported_bash_pattern_rules_but_parses`, the expected-note assertion.
- policy_gate.rs line 2577 — inside test `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones`, `notes.contains(&FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules))`.

**Match sites (no exhaustive `match` in the tree — verified by full-tree grep):**

- `UnsupportedReason` has **no exhaustive `match { .. }` anywhere**; the only Rust constructor of the type is the guard.
- `FrontmatterNote` likewise has no exhaustive `match` in Rust. The **one** place that discriminates the note payload is frontend: `describeNote` in `AgentsDialog.tsx` (a chain of `in`-probes over the wire keys, with the `unsupportedUnvalidatedMatcher` arm having a bash-specific string and a `: ` fallback):
  - the `: ` fallback `\`unsupported matcher: ${note.unsupportedUnvalidatedMatcher}\`` already handles any new `UnsupportedReason` value, because the payload is a string.
  - `AgentUnsupportedReason` is a string-literal union (`export type AgentUnsupportedReason = "bashPatternRules"`) — a new variant on the Rust side serializes as a new camelCase string and TypeScript widens without a compile error; the modal then prints it through the existing fallback.
  - The TS side **does** enumerate the note keys though: `AgentFrontmatterNote` is a union of four single-key object shapes (types.ts 915–924). Adding a **note variant** (not an `UnsupportedReason` value) would need a fifth union member; adding a reason value needs nothing.
- Serde: `UnsupportedReason` derives `Serialize` only (`#[serde(rename_all = "camelCase")]`); `FrontmatterNote` derives `Serialize` only. **Neither is `Deserialize`**, so a new variant cannot break a `Deserialize` impl. `FrontmatterNote`'s `Debug`/`PartialEq`/`Eq` derives are used by the `assert_eq!` expectations quoted in §5 (the tests would simply fail to compile if a `FrontmatterNote` variant were added — they are not exhaustive matches, so there is no "unreachable arm" compile error for reason-level changes).

**So: if a path-tool note needs a reason today, it would have to be either**
(a) reuse `UnsupportedReason::BashPatternRules` — misleading name/doc (the doc comment is bash-specific), or
(b) a new variant of `UnsupportedReason` (e.g. `PathPatternRules`, matching the decision), which **no Rust code must match exhaustively** (verified), serializes without a contract break, and is rendered by the existing frontend fallback. The only Rust cost is the two existing `BashPatternRules` test expectations keep their literal spelling, and the type gains a variant. The doc comment on the enum ("Only produced for `bash`-style per-command pattern blocks") and the variant's own doc would need updating — docs only.

The known test sites that assert the exact `BashPatternRules` literal are the three construction sites above; widening the guard (§5) changes the *expected note lists* in tests but not the variant spelling itself.

---

## 4. The gate — how `gate.rs` derives a definition's verdict, the comment at the `UnsupportedUnvalidatedMatcher` reference, and confirmation that a per-pattern ruleset resolves to `AsSelf` and narrows nothing

The gate entry point is `AgentLoop::policy_verdict` (gate.rs line 178). The definition layer enters at the tail of row 4, after rows 1–3 have declined to answer:

```rust
        Some(stricter_of_two(
            decision_for(policy, beyond, trusted, dir == PolicyDirection::Shell),
            // (issue #101) THE row-4 consultation. ...
            self.definition_verdict(&tc.name),
        ))
```

`stricter_of_two` (gate.rs lines 83–101) implements `Allow < Confine < Ask < Deny`, with `AsSelf` and `Allow` both identities.

**The per-agent verdict derivation** — `definition_verdict` (gate.rs lines 265–289), verbatim:

```rust
    fn definition_verdict(&self, tool: &str) -> DefinitionVerdict {
        let Some(block) = self.permission_block.as_ref() else {
            return DefinitionVerdict::AsSelf;
        };
        let Some((_, rules)) = block
            .tools
            .iter()
            .find(|(key, _)| tool_key_matches(key, tool))
        else {
            return DefinitionVerdict::AsSelf;
        };
        match rules.catch_all_action() {
            Some(Action::Deny) => DefinitionVerdict::Deny,
            Some(Action::Ask) => DefinitionVerdict::Ask,
            Some(Action::Allow) => DefinitionVerdict::Allow,
            // An explicit `{"*": action}` pattern ruleset has NO tool-wide
            // verdict (`catch_all_action()` is `None` for it) — see above.
            None => DefinitionVerdict::AsSelf,
        }
    }
```

`Rules::catch_all_action()` returns `Some(action)` **only** when `whole_tool == true` AND the single pattern is `"*"` (definition_permission.rs lines 74–83); a per-pattern ruleset (`whole_tool: false`) — including one that explicitly spells `{"*": action}` — returns `None` → `DefinitionVerdict::AsSelf`. So a per-pattern map on ANY tool (bash, edit, read, write, …) is `AsSelf` and **narrows nothing, at the gate** — confirmed in the code above. `pick` is the first matching `ToolKey` (`tool_key_matches`, gate.rs lines 111–124).

**The `UnsupportedUnvalidatedMatcher` reference in gate.rs** — this is a doc comment on `definition_verdict` (gate.rs lines 249–264), and it explains the bash decision; verbatim:

```rust
    /// (issue #101) The per-agent verdict for a tool name — `AsSelf` (no
    /// narrowing) when the file does not speak about permissions at all, does
    /// not mention this tool, or the ruleset is a per-pattern object this layer
    /// cannot decide.
    ///
    /// NO PATH RESOLUTION HAPPENS HERE, and that is deliberate (grounding §9 /
    /// ADR 0029's one-canonicalizer rule): the only verdict this layer produces
    /// is a WHOLE-TOOL one (`Rules::catch_all_action()`), which folds onto the
    /// direction's posture verdict — the "beyond the boundary?" question stays
    /// the shared `FsBackend::validate` / `canonicalize_lenient` check the gate
    /// and the executor already agree on, and the boundary ROOT SET (not
    /// opencode's workspace-relative root) is what "relative to what" answers to.
    /// Adding a second pattern resolver here would be the #92 / ADR 0081 escape
    /// class, so there is none.
    ///
    /// A per-pattern ruleset (`whole_tool: false`, e.g. the motivating
    /// `researcher.md`'s `bash:` object) is `AsSelf` by design: enforcing those
    /// rows needs a command matcher nothing has validated (B1 parses them and
    /// announces `UnsupportedUnvalidatedMatcher(BashPatternRules)`), so the
    /// posture stands — announced-unsupported, never silently mis-enforced.
    ///
    /// FIRST matching tool key wins (B1's FIRST-WINS per key inside a block).
```

The gate test pins that a per-pattern block decides nothing end-to-end: `per_pattern_rules_leave_the_verdict_untouched` in policy_gate.rs (a `bash: {"*": allow, "rm *": deny}` block → `Some(Decision::Allow)` at an all-Allow posture), and `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones` (the `edit:` and `bash:` pattern objects → `Allow`, `task: deny` → `None`). **None of those verdicts is disturbed by the announce task** — widening the guard changes only the notes, never the verdict.

---

## 5. THE PINNED SILENCE — the test, and EVERY assertion that breaks when the guard widens

### 5a. The pinned-silence test (definition_permission.rs lines 793–806)

The issue quotes it by name. Verbatim:

```rust
    /// A blank line INSIDE a nested pattern map is skipped too — the rule is
    /// about the block, not about one nesting level.
    #[test]
    fn a_blank_line_inside_a_nested_pattern_map_is_skipped_too() {
        let b = block(
            "name: nested\npermission:\n  edit:\n    \"*\": deny\n\n    \"*.md\": allow\n  bash: deny\n",
        );
        assert_eq!(b.tools.len(), 2, "{b:?}");
        assert_eq!(
            b.tools[0].1.patterns,
            vec![rule("*", Action::Deny), rule("*.md", Action::Allow)],
            "the rows after the blank still belong to `edit`"
        );
    }
```

The helper it rides (definition_permission.rs lines 637–647) is what pins the silence:

```rust
    /// The block half of a fixture, panicking with the notes on `None` so a
    /// reader that drops the block fails LOUDLY instead of vacuously.
    fn block(fm_text: &str) -> PermissionBlock {
        let (block, notes) = parse_block(fm_text);
        assert!(
            notes.is_empty(),
            "this fixture announces nothing: {notes:?}"
        );
        block.expect("the fixture must parse to Some(block)")
    }
```

`block()` **asserts an empty note list unconditionally** — and the fixture's `edit:` nested map (a per-pattern map on a path tool, exactly the shape #124 targets) consequently is asserted to be *silent*. The bash half is a whole-tool `bash: deny` (supported → no note even after the widening) — so the ONLY note the widening would produce in this fixture is the `edit:` map's announcement, and that single arrival turns the `block()` helper's `notes.is_empty()` panic into a test failure.

**Measured helper blast radius** — every caller of `block()` in definition_permission.rs that feeds a per-pattern map on a path tool, listed so the planner knows the full inventory:

1. `last_matching_rule_wins_parse_and_type` (T3) — `edit: {"*": deny, "*.md": allow, "src/lib/*.ts": deny}` → **breaks**.
2. `a_multitool_block_is_fully_representable_and_preserved_order` (T5) — `edit: {"*": deny, "*.md": allow}` (with whole-tool `bash: deny`, `read: ask` — the bash half is supported/no-note) → **breaks** on the `edit:` map's announcement.
3. `pattern_matching_applies_to_path_taking_tools_only` (T4) — ten keys, nine of them path tools (`edit`,`read`,`write`,`find`,`grep`,`ls`,`read_skill`,`ask`,`web_search`,`fetch_content`), each spell `{key}: {"*.rs": deny, "docs/**": allow}` → **breaks** (all nine non-bash per-pattern map calls).
4. `a_blank_line_between_tool_groups_is_skipped_not_a_terminator` — `edit: {"*": deny, "*.md": allow}` → **breaks**.
5. `a_blank_line_inside_a_nested_pattern_map_is_skipped_too` — the pinned-silence test → **breaks**.
6. `a_comment_line_is_skipped_neither_announced_nor_a_terminator` — `read:` nested with `"*": ask`, `"secrets/**": deny` → **breaks**.
7. `a_comment_at_column_zero_does_not_end_the_block_or_move_its_dedent` — whole-tool only (`edit: deny`, `bash: deny`) → **safe**.
8. `a_trailing_comment_on_a_rule_row_is_kept_verbatim_and_announced` — the trailing-comment fixtures end with whole-tool/default rules; the closing "flip side" block's `"build#1/*.rs": deny` under `edit:` is a single per-pattern row (`edit:\n    "build#1/*.rs": deny` → per-pattern ruleset) → **breaks** (the `b = block(...)` at the end).
9. `an_exactly_quoted_token_loses_one_quote_pair_and_nothing_else` — `edit: {'*.md': 'deny', "*.rs": allow, "a b": deny}` → **breaks**.
10. `a_pattern_row_keeps_verbatim_what_the_scalar_readers_would_drop` — calls `parse_block` directly (not `block()`), and asserts an explicit expected note list (`vec![UnknownAction("deny # trailing")]`) → **breaks with an unexpected-first note** (the per-pattern `edit:` map note slots before the `UnknownAction`).
11. `an_unknown_action_is_announced_and_the_tool_is_still_retained` — `edit: maybe` (unreadable) → **safe**; `read: ask` whole-tool → safe.
12. `a_row_the_reader_cannot_read_is_announced_not_skipped_silently` — `edit:` bare rows → **safe** (not a per-pattern ruleset).
13. `a_permission_block_serializes_in_file_order` — calls `parse_block`, expects `vec![UnrecognizedToolKey("glob")]`; both tools whole-tool → **safe**.
14. `the_real_researcher_block_shape_parses_with_no_comment_noise` — calls `parse_block`, **asserts the exact two-note list** `[UnrecognizedToolKey("task"), UnsupportedUnvalidatedMatcher(BashPatternRules)]`; the file's `edit:` nested map is a per-pattern map on a path tool → **breaks** (a third note appears; the expected vec must grow to include the `edit:` announcement — order: `edit` precedes `task`/`bash` in file order, so the new note lands FIRST).
15. `frontmatter_notes_serialize_as_a_tagged_object_per_note` — constructs its own note vec by hand, no parsing → **safe** (but pins the exact wire strings; a new `UnsupportedReason` value would not touch it).

### 5b. `agents.rs` — two sites that break

**Site 1 — test `a_permission_block_with_comments_reports_only_real_tools_and_real_notes` (agents.rs):** the fixture's `edit:` nested map is a per-pattern map on a path tool, and the test asserts the exact note list (agents.rs lines 1399–1411):

```rust
        assert_eq!(
            d.frontmatter_notes,
            vec![
                FrontmatterNote::UnrecognizedToolKey("task".to_string()),
                FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules),
            ],
            "no comment-derived note — the announce channel stays credible"
        );
```

**Site 2 — test `a_permission_block_with_a_blank_line_between_tool_groups_parses_in_full` (agents.rs):** feeds `edit: {"*": deny, "*.md": allow}` and asserts the notes are EMPTY (agents.rs lines 1395–1397):

```rust
        assert!(d.frontmatter_notes.is_empty(), "{:?}", d.frontmatter_notes);
```

(That test is the discovery-level twin of the §5a pin — same shape, same empty-note assertion, different layer.)

The adjacent tests are safe: `a_permission_block_is_parsed_into_the_typed_ruleset` has `edit: {"*": deny, "*.md": allow}` but asserts `d.frontmatter_notes.is_empty()` (agents.rs line ~1496) — **this is a THIRD agents.rs break site** (the issue's "two sites" understates the real count; the typed-ruleset test also carries a per-pattern `edit:` map with an empty-notes assertion, and its `read:` nested map too — both would announce). `a_permission_announces_unsupported_bash_pattern_rules_but_parses` asserts the exact bash-only note list — **safe** (it is the bash case and its expected list is exactly `[UnsupportedUnvalidatedMatcher(BashPatternRules)]`; the `supported` half uses whole-tool `bash: deny` → no note, stays green).

Also note the module doc contract quoted at agents.rs lines ~145–150: *"The frontmatter-READ notes (unknown top-level keys, unrecognised tool keys, unsupported bash-pattern rows — issue #101's announce half; #78's principle applied to files)… Wire/UI surfacing is the follow-up task's hand-off."* — "unsupported bash-pattern rows" is a doc sentence the announce-widening makes stale (docs only).

### 5c. `harness/loop/tests/policy_gate.rs` — one site that breaks

Test `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones` (policy_gate.rs lines ~2570–2585) asserts a `contains` over the notes, not an exact list (verbatim):

```rust
    // The block reader's own announcement is the record that the bash rows are
    // UNSUPPORTED — the gate's `AsSelf` below is that decision, not a drop.
    assert!(
        notes.contains(&FrontmatterNote::UnsupportedUnvalidatedMatcher(
            UnsupportedReason::BashPatternRules
        )),
        "the real block announces its bash pattern rows: {notes:?}"
    );
```

`contains` stays TRUE when the `edit:` map gains an announcement, so this **does not break** — it is the one policy_gate.rs note assertion, and the issue's "known site" list can be corrected to: definition_permission.rs (the `block()` helper explode, §5a), agents.rs (three sites, §5b), and policy_gate.rs which only asserts `contains` → **safe**. No policy_gate.rs verdict assertion changes meaning (all verdicts are `AsSelf`-driven and untouched by notes).

### 5d. The complete list the planner MUST carry

| # | File | Test | Assertion | Change on widening |
|---|---|---|---|---|
| 1 | definition_permission.rs | `a_blank_line_inside_a_nested_pattern_map_is_skipped_too` | empty notes via `block()` | breaks |
| 2 | definition_permission.rs | `last_matching_rule_wins_parse_and_type` | empty notes via `block()` | breaks |
| 3 | definition_permission.rs | `pattern_matching_applies_to_path_taking_tools_only` | empty notes via `block()` (9 per-pattern path keys) | breaks |
| 4 | definition_permission.rs | `a_blank_line_between_tool_groups_is_skipped_not_a_terminator` | empty notes via `block()` | breaks |
| 5 | definition_permission.rs | `a_comment_line_is_skipped_neither_announced_nor_a_terminator` | empty notes via `block()` | breaks |
| 6 | definition_permission.rs | `a_trailing_comment_on_a_rule_row_is_kept_verbatim_and_announced` | `block()` on `"build#1/*.rs": deny` edit map | breaks |
| 7 | definition_permission.rs | `an_exactly_quoted_token_loses_one_quote_pair_and_nothing_else` | empty notes via `block()` | breaks |
| 8 | definition_permission.rs | `a_pattern_row_keeps_verbatim_what_the_scalar_readers_would_drop` | exact `UnknownAction` note vec | breaks (expected list grows) |
| 9 | definition_permission.rs | `the_real_researcher_block_shape_parses_with_no_comment_noise` | exact 2-note vec | breaks (expected list grows, edit note FIRST) |
| 10 | definition_permission.rs | `a_multitool_block_is_fully_representable_and_preserved_order` (T5) | empty notes via `block()` | breaks |
| 11 | agents.rs | `a_permission_block_with_comments_reports_only_real_tools_and_real_notes` | exact 2-note vec | breaks (expected list grows) |
| 12 | agents.rs | `a_permission_block_with_a_blank_line_between_tool_groups_parses_in_full` | `frontmatter_notes.is_empty()` | breaks |
| 13 | agents.rs | `a_permission_block_is_parsed_into_the_typed_ruleset` | `frontmatter_notes.is_empty()` | breaks (NOT in the issue's list — verified) |
| 14 | policy_gate.rs | `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones` | `notes.contains(...)` | **safe — no change** |
| — | agents.rs | `a_permission_announces_unsupported_bash_pattern_rules_but_parses` | exact bash note vec | **safe** (bash case stays) |

---

## 6. Does the Agents modal auto-show a path-tool announcement, or does it need a change outside the Owns set?

**Files that read the notes:** `src/components/AgentsDialog.tsx` — the row's `PermissionReport` reads `const notes: AgentFrontmatterNote[] = row.frontmatterNotes ?? [];` and renders `describeNote` per note; `describeNote` discriminates on the wire key and maps `unsupportedUnvalidatedMatcher` to `"bash pattern rules are parsed but NOT enforced"` for `"bashPatternRules"` and `\`unsupported matcher: ${...}\`` for any other value. The wire field it reads is `frontmatterNotes` (`AgentFrontmatterNote[]`, from `list_agent_config` → `AgentConfigDto.frontmatter_notes`).

**Conclusion — the modal will automatically show the new announcement, with one caveat.** If the implementation keeps the existing variant (`UnsupportedReason::BashPatternRules`) for path tools, the modal shows the bash-specific sentence `"bash pattern rules are parsed but NOT enforced"` on an `edit:` row — **wrong wording, and the `data-permission-report` block appears as soon as a note exists, so the disclosure is automatic but mis-worded**. If the implementation adds a new `UnsupportedReason` variant (recommended shape per §3), the existing `: \`unsupported matcher: ${...}\`` fallback renders it correctly **without any frontend change** — the modal needs NO change for the announcement to appear and to be truthfully worded.

**The caveat that DOES need a change outside the Owns set — a guard against the silence returning.** The issue's minimum bar is "a test that reddens if the silence comes back" and notes: *"this repo has no wire-contract test."* The frontend `AgentsDialog.test.tsx` (and `src/lib/tauri.test.ts`, `tauriBarrel.test.ts`) enumerate the note keys — `AgentFrontmatterNote` has a key union with `"unsupportedUnvalidatedMatcher"` already, so a reason-VALUE change needs no TS edit. But a note-VARIANT change would need `types.ts` + a test. For the announce task itself: **no frontend file needs to change** if the reason variant is added; if the wording must be per-tool, `AgentsDialog.tsx`'s `describeNote` is a frontend edit **outside the Owns set** — that is a scope fact the orchestrator needs: the Owns set is four Rust files, and the sentence the modal prints is decided in `AgentsDialog.tsx`.

---

## 7. Scoped and full test commands

Everything is a Tauri/Rust crate at `src-tauri/` (lib target `archimedes_lib`, bin `archimedes`) plus a Vitest frontend at the repo root. CI runs `cargo test` from `src-tauri/` (with `XDG_DATA_HOME`/`ARCHIMEDES_TEST_DATA_DIR` redirected on Linux/macOS) and `pnpm test` (= `vitest run`) from the repo root.

Run from `src-tauri/` unless noted — scoped rows for the four Owns-set files plus the frontend files that enumerate notes:

```sh
# The four Owns-set files, one filter each:
cargo test --lib a_blank_line_inside_a_nested_pattern_map_is_skipped_too        # definition_permission.rs — the pinned silence
cargo test --lib the_real_researcher_block_shape_parses_with_no_comment_noise   # definition_permission.rs
cargo test --lib a_permission_block_with_comments_reports_only_real_tools_and_real_notes   # agents.rs
cargo test --lib a_permission_block_with_a_blank_line_between_tool_groups_parses_in_full   # agents.rs
cargo test --lib a_permission_block_is_parsed_into_the_typed_ruleset            # agents.rs (third break site)
cargo test --lib the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones   # policy_gate.rs — stays green
cargo test --lib a_permission_announces_unsupported_bash_pattern_rules_but_parses         # agents.rs — stays green

# Whole files (the policy-gate module is part of the lib's loop tests):
cargo test --lib definition_permission::tests
cargo test --lib agents::tests
cargo test --lib policy_gate
cargo test --lib harness::loop  # the loop test dir incl. policy_gate, subagents, tools_enabled, …

# Frontend (from the repo root) — the files that read/render notes and pin the wire mirror:
pnpm test -- src/components/AgentsDialog.test.tsx src/lib/tauri.test.ts src/lib/tauriBarrel.test.ts
```

Full suite (CI's wave-close gate, from the status file: `cargo test` 1698 passed, `pnpm test` 154 files / 3260 tests, `pnpm build` clean — as of 2026-10-29):

```sh
cd src-tauri && cargo test          # full Rust suite
cd .. && pnpm test                  # full Vitest suite (repo root)
pnpm build                          # tsc + vite build
```

(`cargo test --lib` includes the `definition_permission`/`agents`/loop-tests modules; `policy_gate` is included via `src/agent/harness/loop.rs`'s `#[cfg(test)] mod tests;` → `loop/tests/mod.rs` → `mod policy_gate;`.)

---

## 8. Anything ALREADY implemented that overlaps

**Existing announcements for path tools: none.** The only `UnsupportedUnvalidatedMatcher` production is bash (`tool == ToolKey::Bash`, §2). The ONLY other announcement on a path tool is the generic `UnknownAction`/`UnknownKey` noise for *unreadable* rows — not for a readable, unenforced pattern map. So #124's gap ("parses into real rules, renders as rules in the modal, refuses nothing, no note") is exactly the current state, and ADR 0084 + permissions-model.md both name it as the measured follow-up.

**Existing enforcement of path-tool pattern maps: none, and none is being added.** The gate reads only `Rules::catch_all_action()` (whole-tool) — `definition_verdict`'s `None` arm returns `AsSelf` (gate.rs §4). `Rules::is_deny()`/`catch_all_action()` are consulted by the advertisement narrowing in `harness/launch.rs` (whole-tool deny → tool dropped from child's advertised list; an emptied list stays `Some(vec![])`, ADR 0084's ruling) — **pattern maps do not reach that seam either** (`catch_all_action()` is `None` for `whole_tool: false`).

**Symbols that already exist and are relevant, cited so the planner does not re-derive them:**
- `parse_permission_block` (definition_permission.rs:270), `PermissionOut` (257), `Rules::whole_tool`/`per_tool`/`catch_all_action`/`is_deny` (60–97), `ToolKey::from_frontmatter_key` (172).
- `AgentLoop::policy_verdict` (gate.rs:178), `stricter_of_two` (83), `DefinitionVerdict` (58), `definition_verdict` (265), `tool_key_matches` (111), `POLICIED_TOOLS` (30).
- `AgentDefinition.frontmatter_notes` (agents.rs:139), the `permission` field (agents.rs:128), `parse_agent_file` (agents.rs:311).
- `AgentConfigDto.file_permission` + `frontmatter_notes` (commands/agents.rs:221/226), wire keys `filePermission` / `frontmatterNotes`.
- FS note: `Rules::whole_tool` is deliberately **snake_case on the wire** inside a camelCase DTO (`a_permission_block_serializes_in_file_order` pins it; the TS mirror's comment restates it) — a "tidying" rename is a wire-contract change and out of scope here.

**Follow-up candidate (recorded, NOT this run):** enforcing path patterns via the shared canonicaliser — `FsBackend::validate` / `canonicalize_lenient` already exist and are shared (ADR 0081 / ADR 0029's one-canonicalizer rule; the gate deliberately does no second resolution — see `definition_verdict`'s doc, §4). The issue notes it needs a root-set decision (ADR 0084 answers "the boundary root set", not workspace-relative) and must sit at row 4's tail to not bypass the protected-dir guard. Out of scope by owner decision; the announcement task must not half-build it (e.g. must not resolve paths in the parse module).

---

## Sources

- Issue #124 body — `gh issue view 124 --repo danielcherubini/archimedes --json body` (quoted decision table, distinct shapes; the "What is NOT being asked" and minimum-bar clauses).
- `docs/decisions/0084-a-definition-permission-block-is-consulted-only-at-the-tail-of-row-4-and-can-only-narrow.md` — the bash-enforcement rejection, the measured silence ("the unsupported announcement fires only for `ToolKey::Bash` — measured at the one `notes.push` site", the corroborating pin `a_blank_line_inside_a_nested_pattern_map_is_skipped_too`), and its own honest-limits note proposing a follow-up test.
- `docs/decisions/0081-a-lenient-deny-list-entry-needs-a-lenient-compare-one-half-alone-is-a-silent-no-op.md` — the lenient canonicaliser, why a failed compare is a silent no-op, and why the definition layer resolves no paths (#92 escape class).
- `docs/features/permissions-model.md` — "## Scope of the third layer — what it ACTUALLY enforces" (the four bullets incl. "a gap the announcement does not cover"), "## The motivating file still refuses nothing", and the `verified-by` stamp listing the exact files read.
- Code verified by direct read on this branch: `src-tauri/src/agent/definition_permission.rs`, `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/agents.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/agent/harness/loop.rs` (module wiring), `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `.github/workflows/ci.yml`, `src/components/AgentsDialog.tsx`, `src/lib/tauri/types.ts`, `src/lib/tauri.ts`, `package.json`.
- Status file `docs/roadmap/backlog-79-122-124-28-status.md` (row A3, #124 task name, suite figures).

*Grounding only — no plan, no patch, no ranking. The enforce-via-canonicaliser option is recorded as a follow-up candidate per the owner decision.*