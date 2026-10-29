# TASK A3 / #124 — A path-tool `permission:` pattern map is neither enforced nor announced

**One task, one commitable delta.** The announcement half of issue #124 (`danielcherubini/archimedes`): a `permission:` pattern map on a path-taking tool (`edit` / `read` / `write` / `find` / `grep` / `ls` / `read_skill` / `ask` / `web_search` / `fetch_content`) parses into a real ruleset, renders in the Agents modal as rules, refuses nothing at the gate, and — today — does not even say it is unsupported. The `bash` case announces itself; the path-tool case is silent. This task makes the silence impossible.

**OWNER DECISION (made, not re-opened):** **ANNOUNCE, do not enforce.** Replace the bash-only guard with a widened guard so ANY unenforced pattern map on a RECOGNISED PATH-TAKING tool (`!rules.whole_tool && !rules.patterns.is_empty()`) announces itself as unsupported. Enforcing path patterns via the shared canonicaliser (`FsBackend::validate` / `canonicalize_lenient`) is **OUT OF SCOPE** this run — recorded below as a named follow-up candidate only. ADR 0084's standing refusal to add a second matcher still holds and is cited in §Follow-up.

**DESIGN DECISION — what the widened guard matches (reviewer-confirmed, settled here):** a per-pattern pattern object announces itself unsupported with a REASON that says which class it is: `bash` command-text patterns keep `BashPatternRules` (unchanged); the ten **recognised** path-taking tool keys — `edit` / `read` / `write` / `find` / `grep` / `ls` / `read_skill` / `ask` / `web_search` / `fetch_content` — announce `PathPatternRules`; and `ToolKey::Unrecognized(_)` is deliberately EXCLUDED. Rationale: an `Unrecognized` key is by definition NOT KNOWN to be a path-taking tool (opencode keys like `glob`, `task`, `lsp`, `skill` carry no path semantics this desktop has a policed twin for), so claiming "path patterns unenforced" about it would announce a falsehood; the announcement must be accurate on its face. This matches the acceptance criterion's enumeration of the ten recognised path tools (§Acceptance criterion 2). It is expressed as an exhaustive `match tool { … Some(reason) / None }` INSIDE the widened `if` (the final guard above), so an unrecognised key resolves to `None` and cannot fire the note, and bash keeps its own reason rather than inheriting `PathPatternRules`. Consequence for the inventory: `an_unrecognised_tool_key_is_retained_and_announced_not_dropped` (T6 — `glob` / `task` / `lsp`) stays **genuinely safe**: its `glob: {"*.json": deny}` and `lsp: {"*": ask}` rows are per-pattern maps, but both keys are `Unrecognized`, so the guard fires with `None` and the exact three-note `assert_eq!` (definition_permission.rs:803–815) stays green. (A naively-widened guard that only dropped the bash prefix WOULD have broken it — resolved here by the `match`'s `None` arm, NOT by re-writing T6's expected vec.) The authors of the blocked review are right that "exclude `Unrecognized`" is the honest answer; this plan writes that exclusion down in the guard expression itself, so an implementer cannot reintroduce the red by copying a two-condition `if` from an earlier draft.

**Status-file row:** `docs/roadmap/backlog-79-122-124-28-status.md` row A3 / #124 names this exact task file and the four files below (issue ~2100 words, one owner decision, tests red / green as measured).

**REVISION — ROUND 2 (refinement in place, this file):** a reviewer opened the source and proved the first draft's break-site inventory was under-inclusive on one BLOCKING item and wrong on three accuracy points. All four are resolved IN this file, with the guard expression quoted exactly as it will be written: (1) T6 (`glob`/`task`/`lsp`) does NOT break, because the final guard EXCLUDES `ToolKey::Unrecognized(_)` via a `match`'s `None` arm — the honest design (an `Unrecognized` key is not known to be path-taking), written down as the DESIGN DECISION above rather than fudged; (2) the agents.rs safe list is re-derived from the tree — the phantom test names are gone, replaced by `a_permission_block_reads_as_a_real_value_not_a_noop` (line 1472), `malformed_permission_never_panics_the_discovery` (line 1582, which CONTAINS the no-fence sub-scenario as case (d)), and the no-fence phantom is dropped; (3) the `BashPatternRules` construction-site count is corrected from three to SIX grep-verified literal occurrences (guard 420, definition_permission.rs tests 930 & 1210, agents.rs tests 1407 & 1533, policy_gate.rs test 2577; gate.rs:261 is a doc comment) — the load-bearing "no exhaustive `match` → no unhandled-arm error" claim is unchanged; (4) `pattern_matching_applies_to_path_taking_tools_only` iterates TEN keys and ALL TEN break (corrected from "nine"). Net break count stays **13** (ten definition_permission.rs + three agents.rs), re-verified by grepping every `block(`/`parse_block(` caller and every `notes` assertion in the four Owned files; the corrected full table is in §Changed-assertion inventory. Anti-silence test verified RED in Step 1 (before the guard widening in Step 2) and GREEN after.

**Branch:** `feature/backlog-79-122-124-28` in `/home/daniel/Coding/AI/archimedes-desktop`. Line numbers below are against this tree, this branch (verified by direct read; HEAD baseline run green — see §Verification the implementer can trust).

---

## Grounding and scope

- Grounding report (trust it over the issue — it corrects #124 on two counts): `docs/roadmap/backlog-79-122-124-28-ground-permission-guard.md`.
- Issue #124 body: `gh issue view 124 --repo danielcherubini/archimedes --json body`. The issue's "two sites" understates reality: **agents.rs breaks in three assertions, and definition_permission.rs breaks in ten tests** (its `block()` helper asserts an empty note list unconditionally). This plan carries the full corrected list (§Changed-assertion inventory).
- `docs/decisions/0084-a-definition-permission-block-is-consulted-only-at-the-tail-of-row-4-and-can-only-narrow.md` — the bash-enforcement rejection, the measured silence ("the unsupported announcement fires only for `ToolKey::Bash` — measured at the one `notes.push` site"), and the corroborating pin. 0084's refusal to add a second matcher stands and is cited in the follow-up.
- `docs/decisions/0081-a-lenient-deny-list-entry-needs-a-lenient-compare-one-half-alone-is-a-silent-no-op.md` — the #92 / one-canonicalizer escape class that keeps the definition layer path-free.
- `docs/features/permissions-model.md` — "## Scope of the third layer" (the four bullets incl. the gap this task closes) and "## The motivating file still refuses nothing".

**OWNED FILE SET — this task edits ONLY these four Rust files:**

1. `src-tauri/src/agent/definition_permission.rs` — the enum + the one guard (the change).
2. `src-tauri/src/agent/harness/loop/gate.rs` — doc-comment update ONLY (lines 243–263, three paragraphs quoted below).
3. `src-tauri/src/agent/harness/loop/tests/policy_gate.rs` — one assertion tightened to `contains` (safe-site hygiene) and the anti-silence gate-adjacent test.
4. `src-tauri/src/agents.rs` — three test expectations + one doc sentence.

**Do NOT touch** `src-tauri/src/agent/harness/loop/tests/mod.rs` — the shared barrel declares `mod policy_gate;` already (verified: `loop/tests/mod.rs` has ten `mod` lines including `policy_gate`, and `loop.rs`'s `#[cfg(test)] mod tests;` at line 1156 wires it). Add all new tests to `policy_gate.rs`; never a new file. No barrel edit is needed.

**No frontend file changes.** `src/components/AgentsDialog.tsx`, `src/lib/tauri/types.ts`, `AgentsDialog.test.tsx`, `tauri.test.ts`, `tauriBarrel.test.ts` are read-only witnesses (see §Frontend contract — confirmed).

---

## The guard, the enum, the variant (quoted verbatim from this tree)

**`UnsupportedReason` (definition_permission.rs:195–204):**

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

**The guard and its lone push site (definition_permission.rs:417–422):**

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

The fix widens the guard to fire for a per-pattern pattern object on ANY tool that has a matcher-less explanation to give, with the reason chosen per tool: `bash` command-text patterns keep their dedicated `BashPatternRules` note; the ten recognised path-taking tools announce `PathPatternRules`; `Unrecognized(_)` is EXCLUDED. `tool` and `rules` are in scope at that point in the per-key loop of `parse_permission_block` (lines 311, 367, 376). A whole-tool bare verdict (`edit: deny`, `bash: deny`, `read: ask` — `Rules::whole_tool`) **never** announces; an explicit `{"*": action}` object on a recognised path tool is `whole_tool: false` and **does** announce (that is correct: it is a per-pattern map the gate reads as `AsSelf` via `catch_all_action()` for any tool, bash included). An `Unrecognized(_)` key — path semantics unknown — never announces (the DESIGN DECISION above), and a per-pattern `bash:` object still announces `BashPatternRules` (the anti-silence baseline for `a_permission_announces_unsupported_bash_pattern_rules_but_parses`, C1 and the researcher gate test).

**FINAL guard expression, quoted exactly as it will be written (replacing definition_permission.rs:418's `if tool == ToolKey::Bash && …`):**

```rust
        // The scope line: a PATTERN OBJECT with ≥1 row parses (it must) and
        // announces itself unsupported with a reason that says WHY. bash
        // command-text patterns keep their dedicated reason; a recognised
        // PATH-TAKING tool's path patterns announce as path patterns (no
        // matcher here has any business deciding them — ADR 0084, one-
        // canonicalizer rule). A whole-tool bare verdict needs no matcher and
        // is therefore SUPPORTED (no note). An UNRECOGNISED key is not known
        // to be path-taking, so it is excluded — announcing "path patterns
        // unenforced" for `glob:` would be a falsehood.
        if !rules.whole_tool && !rules.patterns.is_empty() {
            let reason = match tool {
                ToolKey::Bash => Some(UnsupportedReason::BashPatternRules),
                ToolKey::Edit
                | ToolKey::Read
                | ToolKey::Write
                | ToolKey::Find
                | ToolKey::Grep
                | ToolKey::Ls
                | ToolKey::ReadSkill
                | ToolKey::Ask
                | ToolKey::WebSearch
                | ToolKey::FetchContent => Some(UnsupportedReason::PathPatternRules),
                ToolKey::Unrecognized(_) => None,
            };
            if let Some(reason) = reason {
                notes.push(FrontmatterNote::UnsupportedUnvalidatedMatcher(reason));
            }
        }
```

Three behaviours fall straight out of this expression, and every inventory row below is read against them: (1) bash per-pattern → `BashPatternRules` (unchanged, literal same); (2) any of the ten path-tool maps → `PathPatternRules`; (3) `Unrecognized(_)` → nothing. The `match` over `ToolKey` is exhaustive over the CURRENT twelve variants (Bash, the ten, `Unrecognized(_)`) — the only future-unseen-arm risk is a NEW `ToolKey` variant, which this task does not add. Note the exclusion lives INSIDE the `if`, as the `None` arm of the `match` — NOT as a second guard condition, so a naive two-condition `if` that merely dropped the bash prefix (which WOULD break T6) is not what an implementer copies from this page.

**New variant (same file, adjacent to the enum):**

```rust
pub enum UnsupportedReason {
    /// opencode `bash`-style patterns over command text ... (unchanged)
    BashPatternRules,
    /// A PATH-PATTERN map on a recognised path-taking tool (`edit:` / `read:` /
    /// `write:` / `find:` / `grep:` / `ls:` / `read_skill:` / `ask:` /
    /// `web_search:` / `fetch_content:`): parsed, announced, and NOT enforced.
    /// The gate's `definition_verdict` reads only `Rules::catch_all_action()`
    /// (whole-tool) and answers `AsSelf` for a per-pattern ruleset (gate.rs),
    /// and the definition layer deliberately does NO path resolution (ADR 0081 /
    /// ADR 0029 one-canonicalizer rule; ADR 0084).
    PathPatternRules,
}
```

Update the enum's module doc ("Only produced for `bash`-style per-command pattern blocks …"), the `UnsupportedUnvalidatedMatcher` variant doc ("A `bash`-style per-command pattern block: …"), and the `ToolKey` doc's parenthetical (which already names `glob`, `grep`, `list`, `task`, `skill`, `lsp` as keys with no policed twin) to name both spellings and the exclusion.

**Why adding a variant is cheap — verified against this tree, say what was run:**

- Full-tree `grep -rn "match .*FrontmatterNote" --include="*.rs" .` and `grep -rn "match .*UnsupportedReason" --include="*.rs" .` (run from `src-tauri/src`) → **both empty**. The only Rust discriminator of the note payload is `describeNote` in `AgentsDialog.tsx` (a frontend `in`-probe chain, not a `match`). In the CURRENT (pre-change) tree there are SIX literal `BashPatternRules` occurrences (counted by grep, not memory): the guard (definition_permission.rs:420), definition_permission.rs's two expected-note test literals (lines 930, 1210), agents.rs's two expected-note test literals (lines 1407, 1533), and policy_gate.rs's one `contains` literal (line 2577). Gate.rs has NO construction site — its `BashPatternRules` mention at gate.rs:261 is a doc comment. AFTER the change, the guard's one occurrence becomes the `match` arms (one `BashPatternRules` + one `PathPatternRules`), and the two new `PathPatternRules` literals (anti-silence test, tightened `contains`) are additive — the five test literals keep their bash spelling. (The reviewer's "five" was off by the agents.rs second literal at 1533; the load-bearing claim changes nothing: **no exhaustive `match` exists anywhere, so a new variant cannot produce an unhandled-arm compile error**.)
- Serde: both enums derive `Serialize` only — **neither is `Deserialize`** — so a new variant cannot break a deserialize impl.
- The new variant serializes as the camelCase string `"pathPatternRules"` (externally tagged, `rename_all = "camelCase"`), widened into by the TS string-literal union `AgentUnsupportedReason = "bashPatternRules"` (types.ts:834) without a compile error.

---

## Frontend contract — confirmed: NO frontend change required; where a copy improvement would live

- `describeNote` (`src/components/AgentsDialog.tsx:875–896`) discriminates on the wire key and maps `unsupportedUnvalidatedMatcher` to `"bash pattern rules are parsed but NOT enforced"` for the literal `"bashPatternRules"` and to the **fallback `` `unsupported matcher: ${note.unsupportedUnvalidatedMatcher}` `` for any other value.** A `PathPatternRules` value renders through that existing fallback as `unsupported matcher: pathPatternRules` — automatic, truthful, and **no frontend edit needed**. Confirmed by direct read.
- The modal renders ANY note automatically: `PermissionReport` reads `row.frontmatterNotes ?? []` and renders `notes.map(...)` → one muted `<MutedCaption>{describeNote(note)}</MutedCaption>` per note (`AgentsDialog.tsx:864`), in backend order. The `data-permission-report` block appears as soon as a note exists — the disclosure is automatic.
- **A copy improvement WOULD live in `AgentsDialog.tsx` (out of the Owns set)** — e.g. branching in `describeNote` to print `"path pattern rules are parsed but NOT enforced"` for `"pathPatternRules"`, mirroring the bash sentence, plus the awaited-on-word fork that keeps the bash literal. `AgentsDialog.test.tsx:1042–1099` (`unrecognised_and_unsupported_rows_are_named_not_dropped`) is where the copy pin would land. **Not performed here; record for the orchestrator as a follow-up** so it is tracked rather than smuggled in. Without it the disclosure is complete but the sentence is generic (`unsupported matcher: pathPatternRules`) — a wording lag only.
- The TS key union `AgentFrontmatterNote` (types.ts:915–924) enumerates the four note keys; a reason-VALUE (not a note-VARIANT) change widens into the union member without a TS edit and without reddening `AgentsDialog.test.tsx` / `tauri.test.ts` / `tauriBarrel.test.ts` (all three read-only; the title of `tauriBarrel.test.ts:194` says the assertions there are type-only). `frontmatter_notes_serialize_as_a_tagged_object_per_note` pins the existing wire spellings and is untouched (it never parses).

---

## The gate — verdicts are untouched by this task (confirmation)

`AgentLoop::definition_verdict` (gate.rs:265–289) reads only `Rules::catch_all_action()`, which is `Some(action)` **only** when `whole_tool == true` AND the single pattern is `"*"` (definition_permission.rs:88–97). A per-pattern ruleset — on ANY tool, bash or path — is `None` → `DefinitionVerdict::AsSelf`, so a per-pattern map narrows nothing at the gate today and **still narrows nothing after this task** (the task changes only the notes, never a verdict). This is pinned end-to-end by `per_pattern_rules_leave_the_verdict_untouched` (policy_gate.rs:2479, `bash` per-pattern → `Some(Decision::Allow)` at an all-Allow posture) and `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones` (policy_gate.rs:2558). Both stay green; neither verdict assertion changes meaning.

**gate.rs edit is doc-only** — update the three doc paragraphs on `definition_verdict` (quoted in the grounding, §4). The sentence "B1 parses them and announces `UnsupportedUnvalidatedMatcher(BashPatternRules)`" becomes "…announces `UnsupportedUnvalidatedMatcher(BashPatternRules | PathPatternRules)`"; the two sentences about "a per-pattern ruleset (`whole_tool: false`, e.g. the motivating `researcher.md`'s `bash:` object)" get the path-tool map added ("e.g. the motivating `researcher.md`'s `edit:` and `bash:` objects"). No behavioural edit, no second matcher, no path resolution. ADR 0081 / ADR 0029's one-canonicalizer sentence stays.

---

## Changed-assertion inventory — every existing assertion whose meaning changes, with disposition

Tool `Action` enum: `allow` / `ask` / `deny` (all lowercase). `FrontmatterNote` order is push order — file order. A new `edit:`-first announcement lands at index **0** because `edit` precedes `task`/`bash` in file order (verified: `parse_agent_file` extends notes in per-line file order, agents.rs:220; `parse_permission_block` pushes per tool, in key order).

**Keyed note-shape change:** all existing per-pattern path-tool expectations change from *silence* to *a `PathPatternRules` note*. Bash expectations (`BashPatternRules`) keep their literal spelling. Whole-tool expectations stay silent.

### definition_permission.rs — ten tests break (the `block()` helper explode)

`block()` (lines 638–644) asserts `notes.is_empty()` **unconditionally**. Its `notes: {notes:?}` panic fires on the FIRST note the widened guard pushes for a per-pattern path-tool map. Each break is the test's silence assumption, not its typed content — the per-tool / whole-tool / row-shape assertions beneath are unchanged.

| # | Test | Fixture shape | WHY it breaks | Disposition |
|---|---|---|---|---|
| 1 | `a_blank_line_inside_a_nested_pattern_map_is_skipped_too` (the **pinned silence**) | `edit:\n "*": deny\n … "*.md": allow` + whole-tool `bash: deny` | `edit` is a per-pattern path map → new note in `block()` | **the intended change; test re-written to expect the note** |
| 2 | `last_matching_rule_wins_parse_and_type` (T3) | `edit: {"*": deny, "*.md": allow, "src/lib/*.ts": deny}` | per-pattern `edit` map | re-written; cells unchanged |
| 3 | `pattern_matching_applies_to_path_taking_tools_only` (T4) | loop over TEN keys, each `{key}: {"*.rs": deny, "docs/**": allow}` | **ALL TEN keys are recognised path tools** — every iteration fires the note (corrected from the earlier "nine": bash is not in the loop, and none of the ten is excluded) | re-written — the loop asserts `notes == vec![PathPatternRules]` per key (the `block()`-free form), keeping the ten keys, variant fan-out and row-shape asserts |
| 4 | `a_blank_line_between_tool_groups_is_skipped_not_a_terminator` | `edit: {"*": deny, "*.md": allow}` + whole-tool bash/read | per-pattern `edit` map | re-written |
| 5 | `a_comment_line_is_skipped_neither_announced_nor_a_terminator` (C2) | `edit: deny`, nested `read:` (`"*": ask`, `"secrets/**": deny`), whole-tool `bash: deny` + comments | nested `read:` is a per-pattern path map | re-written; comment assertions unchanged |
| 6 | `a_trailing_comment_on_a_rule_row_is_kept_verbatim_and_announced` (C5) | trailing-comment rows + the flip-side `block("name: hash\npermission:\n  edit:\n    \"build#1/*.rs\": deny\n")` | the flip-side `edit:` is a per-pattern single-row map | re-written — the flip side's `block(...)` gains the expected note; the trailing-comment MAIN half stays green (its rows are all unreadable → empty `patterns`, so no note) and must be split so it keeps asserting its three-`UnknownAction` vec |
| 7 | `an_exactly_quoted_token_loses_one_quote_pair_and_nothing_else` | `edit: {'*.md': 'deny', "*.rs": allow, "a b": deny}` | per-pattern `edit` map | re-written; `unquote_token` asserts unchanged |
| 8 | `a_pattern_row_keeps_verbatim_what_the_scalar_readers_would_drop` | `edit: {"grep: *": deny, 'it''s': ask, "x": deny # trailing}` via `parse_block` | expected `notes` (currently `vec![UnknownAction("deny # trailing")]`) gains the `edit:` map announcement **AFTER** the `UnknownAction` | **update the expected vec** — `rows_to_rules` pushes the `UnknownAction` (line 527) BEFORE the guard runs (line 418–424), so the new vec is `[UnknownAction("deny # trailing"), PathPatternRules]`; wording assertions unchanged |
| 9 | `the_real_researcher_block_shape_parses_with_no_comment_noise` (C1) | the real `researcher.md` block: `edit:` nested map, `task: deny`, `bash:` pattern object, comments | expected vec grows from `[UnrecognizedToolKey("task"), UnsupportedUnvalidatedMatcher(BashPatternRules)]` to THREE, **with the `edit:` `PathPatternRules` note FIRST** (the guard fires for `edit:` before `task`/`bash` are even read — file order) | **update the expected vec** to `[PathPatternRules, UnrecognizedToolKey("task"), BashPatternRules]`; the fallible `for` comment-leak check stays; the "ONLY two notes" doc comment updated to three; block/row assertions untouched |
| 10 | `a_multitool_block_is_fully_representable_and_preserved_order` (T5) | `edit: {"*": deny, "*.md": allow}` + whole-tool `bash: deny`, `read: ask` | per-pattern `edit` map | re-written; three-key order assertion unchanged |

### agents.rs — three tests break (the issue's "two sites" is off by one — verified here)

| # | Test | Assertion | Disposition |
|---|---|---|---|
| 11 | `a_permission_block_with_comments_reports_only_real_tools_and_real_notes` (T7b) | exact `vec![UnrecognizedToolKey("task"), UnsupportedUnvalidatedMatcher(BashPatternRules)]` (lines 1404–1411) | **update the expected vec** to `[PathPatternRules, UnrecognizedToolKey("task"), BashPatternRules]` (`edit:` precedes `task`/`bash` in file order → its note lands first); the comment-credibility doc comment ("the ONLY notes this file may produce are the two") updated to three |
| 12 | `a_permission_block_with_a_blank_line_between_tool_groups_parses_in_full` (T7) | `assert!(d.frontmatter_notes.is_empty(), ...)` (line 1329) with `edit: {"*": deny, "*.md": allow}` | update to assert the exact one-note vec `[PathPatternRules]` |
| 13 | `a_permission_block_is_parsed_into_the_typed_ruleset` (T8) | `assert!(d.frontmatter_notes.is_empty(), ...)` (lines 1463–1465) with `edit:` inline map AND nested `read:` map (both per-pattern path maps) + whole-tool `bash: deny` | update to assert the exact two-note vec `[PathPatternRules, PathPatternRules]` (edit note first, then read note) — and the "with nothing announced" doc comment |

Also in agents.rs: the `AgentDefinition::frontmatter_notes` doc (line 73, "unsupported bash-pattern rows — issue #101's announce half") — the parenthesis becomes stale; extend to name path-pattern rows (**doc only**).

### Genuinely safe sites (re-derived from the tree by grep on every `block(` / `parse_block(` caller and every `notes` assertion — listed so they are not "fixed")

- **agents.rs `a_permission_announces_unsupported_bash_pattern_rules_but_parses`** (line 1499) — asserts the exact bash-only vec (1531–1533); the `supported` half is whole-tool `bash: deny` → no note. **Stays green** (bash case is unchanged by the final guard; nothing is re-worded).
- **policy_gate.rs `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones`** (line 2551) — asserts `notes.contains(&FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules))` (lines 2575–2579). `contains` stays TRUE when the `edit:` map gains its `PathPatternRules` note. **Stays green.** (Safe-site hygiene, done in Step 4: tighten to assert BOTH reasons via a second `contains`, so the gate-adjacent record keeps naming the full announcement set.) No policy_gate.rs **verdict** assertion changes meaning — all verdicts are `AsSelf`-driven and untouched by notes.
- definition_permission.rs `a_comment_at_column_zero_does_not_end_the_block_or_move_its_dedent` (984) — whole-tool only (`edit: deny`, `bash: deny`) → no note. Safe.
- definition_permission.rs `an_unknown_action_is_announced_and_the_tool_is_still_retained` (1139) — `edit: maybe` is unreadable (no map → empty `patterns`), `read: ask` whole-tool → no per-pattern map. Safe.
- definition_permission.rs `a_row_the_reader_cannot_read_is_announced_not_skipped_silently` (1186) — `edit:` bare list rows (unreadable → empty `patterns`), `bash: deny` → no per-pattern map. Safe.
- definition_permission.rs `a_permission_block_serializes_in_file_order` (1236) — `edit: deny` (whole-tool) + `glob: deny` (a BARE verdict on an `Unrecognized` key → also `whole_tool: true`) → no per-pattern map; expected `[UnrecognizedToolKey("glob")]`. Safe — under BOTH a naive widening and the final guard (the bare `glob: deny` produces no pattern rows).
- definition_permission.rs `frontmatter_notes_serialize_as_a_tagged_object_per_note` (1206) — hand-built note vec, no parsing; pins the four existing spellings. Safe. **Do not extend** — the wire shape of the new value is exercised by the anti-silence test's serde-less equality; this pin's job is the tagged-object shape, which the new value satisfies by the same derivation.
- definition_permission.rs `a_bare_action_is_the_whole_tool_catch_all` (666), `an_unrecognised_tool_key_is_retained_and_announced_not_dropped` (T6, line 783 — **now safe under the final guard for the RIGHT reason**: its `glob: {"*.json": deny}` and `lsp: {"*": ask}` rows ARE per-pattern maps, but both keys are `Unrecognized` and the guard's `match` resolves them to `None`, so the exact three-note `assert_eq!` at 803–815 stays green; it was on the earlier safe list for the wrong reason, and a naive bash-prefix-drop would have broken it — see the DESIGN DECISION), `a_block_of_only_comments_announces_instead_of_vanishing` (1001), `a_permission_key_with_no_block_announces_instead_of_vanishing` (1163), `permission_action_verbs_are_lowercase_on_the_wire` (656), `the_copy_extractor_survives_a_crlf_checkout` (1299), `the_two_parse_value_copies_are_untouched_by_the_permission_reader` (1334) — no per-pattern path map → safe.
- agents.rs `a_permission_block_reads_as_a_real_value_not_a_noop` (line 1472 — the real name of the "repeated permission key" case; `edit: deny` / `read: deny` are whole-tool) → safe. `malformed_permission_never_panics_the_discovery` (line 1582 — sub-scenarios (a) inline value, (b) broken indent, (c) empty block, AND (d) the no-fence case, which lives INSIDE this test) → safe. `a_notes_carrying_definition_is_discovered_without_affecting_adjoining_rows` (line 1642, `mode:` key only) → safe. `unknown_top_level_keys_are_announced_never_silently_dropped` (line 1560) → safe.
- **Do NOT look for** the phantom names `a_permission_block_with_a_repeated_permission_key_announces_once`, `a_permission_key_with_no_block_never_panics_the_discovery`, or `a_permission_block_discoverable_without_a_fence` — none exists in the tree (the first is `a_permission_block_reads_as_a_real_value_not_a_noop`, the second is `malformed_permission_never_panics_the_discovery`, the third matches nothing — the no-fence case is the (d) sub-scenario of `malformed_permission_never_panics_the_discovery`). An implementer grepping for them will find nothing.
- policy_gate.rs all other definition tests use `whole_tool_block` (line 1938, a hand-built `PermissionBlock` — no parsing, no notes) → safe.

**Net: 13 break sites updated, zero left red, every other assertion verified safe** — ten break sites in definition_permission.rs (`block()`-riders 1–7 + 10, the D4 vec 8, the researcher vec 9) and three in agents.rs, matching the 13 this heading and the ROUND-2 note carry. Two sites that LOOK breakable but are NOT: `a_permission_block_serializes_in_file_order` (`glob: deny` is whole-tool) and T6 (final guard's `None` arm for `Unrecognized`).

---

## Steps: — the serial plan (TDD)

**Step 0 — baseline (verify before touching anything).** From `src-tauri/`:
```sh
cargo test --lib definition_permission::tests      # 22 passed (measured at HEAD)
cargo test --lib agents::tests                     # 55 passed (measured at HEAD)
cargo test --lib policy_gate                       # 33 passed (measured at HEAD)
```
(Baseline measured green on this branch at HEAD — the three commands above each passed; the full-gate legs live at the end.)

**Step 1 — `definition_permission.rs`: add ONLY the `PathPatternRules` variant (no behaviour change yet) + write the anti-silence RED test in `policy_gate.rs` (inverted first, against the STILL-bash-only guard).**

The variant addition is pure: the enum gains a unit variant that nothing constructs yet, no exhaustive `match` exists (verified empty above, so no unhandled-arm compile error), serde only serializes, and no test observes a `PathPatternRules` until the guard changes — so Step 1 must NOT touch the guard. The RED test CANNOT be written before the variant exists (it references `UnsupportedReason::PathPatternRules`, so it would not compile), which is why the variant comes first and the guard change waits.
- [ ] Add the `PathPatternRules` variant (quoted above) and update the enum + `FrontmatterNote::UnsupportedUnvalidatedMatcher` doc comments to name both spellings. **Do not touch the guard yet.**
- [ ] **RED** — add to policy_gate.rs the anti-silence test (name: `a_path_tool_pattern_map_announces_itself_unsupported`):
  ```rust
  /// #124 — minimum bar: if the bash-only guard ever comes back, this test
  /// REDDENS. The modal reads the SAME note data this reader produces, so a
  /// silent parse here is a silently silent modal there — the exact defect
  /// class #101 exists to fix.
  #[test]
  fn a_path_tool_pattern_map_announces_itself_unsupported() {
      use crate::agent::definition_permission::{FrontmatterNote, UnsupportedReason};

      let fm = "name: p\npermission:\n  edit: {\"*\": deny, \"*.md\": allow}\n";
      let lines: Vec<&str> = fm.lines().collect();
      let idx = lines.iter().position(|l| l.starts_with("permission:")).unwrap();
      let (block, notes) =
          crate::agent::definition_permission::parse_permission_block(&lines, idx, "");
      let block = block.expect("a pattern map on a path tool must PARSE");
      assert!(!block.tools[0].1.whole_tool, "an object is per-pattern");
      assert!(
          notes.contains(&FrontmatterNote::UnsupportedUnvalidatedMatcher(
              UnsupportedReason::PathPatternRules
          )),
          "a path-tool pattern map ANNOUNCES itself unsupported: {notes:?}"
      );
      assert!(
          notes
              .iter()
              .all(|n| !matches!(n, FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::BashPatternRules))),
          "the path-tool announcement is its OWN reason, never bash's: {notes:?}"
      );
  }
  ```
- [ ] Run it: `cargo test --lib a_path_tool_pattern_map_announces_itself_unsupported` — **must FAIL at this point** (the guard still pins bash-only, so `edit:` produces no note and the `contains` assertion fails red). Record the failure message. Do not proceed until it is red — a red here is the proof that the CURRENT guard is silent for path tools.
- [ ] `cargo test --lib definition_permission::tests` — must STILL be green (the variant addition changed nothing observable).

**Step 2 — widen the guard + fix the ten broken `definition_permission.rs` tests; the RED test turns green.**

Order the guard first, then the tests, so the RED test is green as soon as the guard lands.
- [ ] Replace the guard at definition_permission.rs:418 with the FINAL guard expression quoted in §The guard (the widened `if !rules.whole_tool && !rules.patterns.is_empty()` containing the exhaustive `match tool { Bash → BashPatternRules, ten path tools → PathPatternRules, Unrecognized(_) → None }`); rewrite the scope-line comment to say both announcement reasons and the Unrecognized exclusion, keeping the whole-tool-supported sentence.
- [ ] **Green check first:** re-run `cargo test --lib a_path_tool_pattern_map_announces_itself_unsupported` — **must PASS now**. If it passes while the guard still cannot produce `PathPatternRules`, the guard is not the thing under test — stop and redo Step 1/2.
- [ ] Rewrite tests #1–#7, #10 (the `block()`-riders) from `let b = block(fm);` to `let (b, notes) = parse_block(fm); … assert_eq!(notes, vec![FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::PathPatternRules)]);` + `b.expect(...)` (or an equivalent `block_with_notes` helper — the point is the one expected note is asserted, never the unconditional `block()` empty assert); split C5 (#6) so the trailing-comment MAIN half keeps asserting its three-`UnknownAction` vec (its rows are unreadable → no pattern rows → still green) and the `"build#1/*.rs"` flip side asserts the one `PathPatternRules` note.
- [ ] Update the expected vecs of #8 (`[UnknownAction("deny # trailing"), PathPatternRules]` — `rows_to_rules` pushes first) and #9 (`[PathPatternRules, UnrecognizedToolKey("task"), BashPatternRules]`), and #9's doc comment ("ONLY two notes" → three).
- [ ] Confirmation:
```sh
cargo test --lib definition_permission::tests
cargo test --lib a_path_tool_pattern_map_announces_itself_unsupported
```

**Step 3 — `agents.rs`: fix the three broken tests + the stale doc sentence.**
- [ ] Update T7b's expected vec (line 1404–1411) to `[PathPatternRules, UnrecognizedToolKey("task"), BashPatternRules]` and its "the ONLY notes this file may produce are the two" doc comment to three.
- [ ] Replace T7's `is_empty` (line 1329) with `assert_eq!(d.frontmatter_notes, vec![FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::PathPatternRules)], ...)` (the `edit:` map is the only per-pattern map).
- [ ] Replace T8's `is_empty` (lines 1463–1465) with the exact two-note vec `[PathPatternRules, PathPatternRules]` (edit note, then read note) and update the "with nothing announced" doc comment.
- [ ] Update `AgentDefinition::frontmatter_notes`'s doc (line 73) "unsupported bash-pattern rows" to name both bash and path-pattern rows.
- [ ] Confirmation:
```sh
cargo test --lib agents::tests
```

**Step 4 — `policy_gate.rs` hygiene + `gate.rs` doc comment (safe-site hygiene, no assertion weakened).**
- [ ] **Tighten** `the_real_researcher_block_is_read_and_its_verdicts_are_the_scoped_ones`'s `contains` from bash-only to BOTH reasons — add `assert!(notes.contains(&FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::PathPatternRules)), "the real block announces its edit path-pattern rows: {notes:?}");` right after the existing bash `contains` (line 2575–2579), keeping the bash assertion as-is.
- [ ] Update the gate.rs `definition_verdict` doc (three paragraphs, gate.rs:243–263) to name both announcement reasons and the motivating file's `edit:` map: the bash sentence becomes "B1 parses them and announces `UnsupportedUnvalidatedMatcher(BashPatternRules | PathPatternRules)`" and the per-pattern-ruleset sentence names `edit:` alongside `bash:`.
- [ ] Confirmation:
```sh
cargo test --lib policy_gate
```

**Step 5 — `cargo fmt`, `cargo clippy --all-targets`, full suites, and the gate.**
- [ ] `cargo fmt --check` (from `src-tauri/`) — run `cargo fmt` first so the check passes.
- [ ] `cargo clippy --all-targets` (from `src-tauri/`, `-- -D warnings` not required by the tree, but fix any new lint the diff introduces).
- [ ] `cargo test` (from `src-tauri/`; full Rust suite — 1698 tests at the status file's last wave; expects 0 failures, only renames/adds).
- [ ] From the repo root: `pnpm test` (full Vitest — 154 files / 3260 at the last wave; the frontend is untouched, so this must stay green) and `pnpm build` (tsc + vite; untouched, must stay clean).
- [ ] Acceptance re-run of the anti-silence test (named in §Acceptance).

---

## Acceptance criteria

1. **The anti-silence test passes and is named:** `a_path_tool_pattern_map_announces_itself_unsupported` (in `policy_gate.rs`). It is the issue's non-negotiable minimum bar — **a test that reddens if the silence comes back** — and it lives in a file of the Owned set.
2. A `permission:` pattern map with ≥1 pattern row on any of the ten recognised path-taking tools (`edit` / `read` / `write` / `find` / `grep` / `ls` / `read_skill` / `ask` / `web_search` / `fetch_content`) produces `FrontmatterNote::UnsupportedUnvalidatedMatcher(UnsupportedReason::PathPatternRules)`; a whole-tool bare verdict (`edit: deny`) produces nothing; a bash per-pattern object still produces `BashPatternRules` (that variant's literal is unchanged); and a per-pattern object on an `Unrecognized(_)` key (`glob:` / `task:` / `lsp:`) produces **nothing** — the guard's `match` resolves it to `None` (the DESIGN DECISION), so `an_unrecognised_tool_key_is_retained_and_announced_not_dropped` passes with its exact three-note vec unchanged.
3. Every break site in the §Changed-assertion inventory is updated or verified safe — **no assertion is left red**; the `block()` helper's unconditional `notes.is_empty()` is no longer fed a per-pattern path map by any fixture in the four Owned files. `cargo test` from `src-tauri/` is green (0 failures).
4. The gate's verdicts are untouched: `policy_verdict` answers are identical to HEAD for every pinned fixture (`A0`-style re-run: same verdicts, same count; the only adds are the anti-silence test and the tightened `contains` — no existing baseline test removed or weakened).
5. The modal discloses the path-tool map without a frontend change: `describeNote`'s `: ` fallback renders `unsupported matcher: pathPatternRules` for the new value; the frontend files are untouched by this task (their suites pass unchanged).
6. `pnpm test`, `pnpm build` (repo root), `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` (`src-tauri/`) all pass.
7. ADR 0084's no-second-matcher refusal stands: the plan/task adds **no** matcher, no path resolution in the parse module, and no gate behaviour change. `gate.rs` is doc-only.

---

## Follow-up candidates (recorded, NOT this run — per the owner decision)

1. **Enforce path patterns via the shared canonicaliser** (the owner-excluded option, named here only): judge `edit`/`read`/`write`/find-style rows with `FsBackend::validate` / `canonicalize_lenient` — the canonicaliser already exists and is shared (ADR 0081 / ADR 0029's **one-canonicalizer rule**; the gate deliberately does no second resolution — see `definition_verdict`'s doc and the ADR 0084 rejection of the #92 / ADR 0081 escape class). Needs (a) a root-set decision — ADR 0084 answers "the boundary root set", not opencode's workspace-relative root — and (b) consultation at the tail of row 4 like every other definition verdict, or it can bypass the protected-dir guard. The announce task must not half-build it (no path resolution in the parse module).
2. **Per-tool copy in the modal** — `AgentsDialog.tsx`'s `describeNote`: branch on `"pathPatternRules"` for "path pattern rules are parsed but NOT enforced", keeping the bash sentence; pin in `AgentsDialog.test.tsx` beside `unrecognised_and_unsupported_rows_are_named_not_dropped`. The wire contract (`types.ts`'s `AgentUnsupportedReason` union) would also gain `"pathPatternRules"` and the type-only pin in `tauriBarrel.test.ts:194` would widen. **Out of the Owned set; do not smuggle in.**
3. (ADR 0084's standing honesty note) A README/ADR sentence stating the announced, unenforced class for path tools — this plan's §Frontend contract and the updated gate.rs doc are the code-side record; a durable ADR/feature-page paragraph is the docs follow-up the permissions-model.md's own "announced and UNENFORCEABLE" bullet anticipates.

---

## Out-of-set needs

None. The plan needs no edit outside the four Owned files. The barrel (`loop/tests/mod.rs`) already declares `mod policy_gate;` — verified — so no barrel edit is required. If during execution a barrel edit ever appears unavoidable, **stop and report it here** rather than touching it (a sibling task works in that directory).

---

## Verification the implementer can trust (what I ran, this branch)

- **Full-tree grep for exhaustive `match`es on `FrontmatterNote` / `UnsupportedReason`** — `grep -rn "match .*FrontmatterNote" --include="*.rs" .` and the `UnsupportedReason` twin: **both empty**. No exhaustive match anywhere → the `PathPatternRules` variant has minimal blast radius (verified, matches the grounding's claim).
- **Frontend fallback** — `describeNote` read at `AgentsDialog.tsx:875–896`: the non-`"bashPatternRules"` arm is `` `unsupported matcher: ${note.unsupportedUnvalidatedMatcher}` `` (fallback confirmed).
- **Barrel** — `loop/tests/mod.rs` read: contains `mod policy_gate;`; `loop.rs:1156` is `mod tests;`. No barrel edit needed.
- **Gate doc + `definition_verdict`** — read at gate.rs:265–289 (the fn) and the doc comment at 243–263; `catch_all_action()` at definition_permission.rs:88–97 (`None` for `whole_tool == false`).
- **Full baseline** at HEAD on this branch, run from `src-tauri/`: `cargo test --lib definition_permission::tests` → **22 passed**; `cargo test --lib agents::tests` → **55 passed** (the `agents::tests` filter includes `commands::agents::tests`; 55 total); `cargo test --lib policy_gate` → **33 passed**; `cargo test --lib "harness::loop"` → 0 (no in-file tests; expected). All targeted red tests identified above are in the `definition_permission::tests` (22) / `agents::tests` (55) / `policy_gate` (33) scopes.
- **ROUND-2 RE-VERIFICATION (this revision, greps re-run on this branch):** (a) every `block(` / `parse_block(` caller and every `notes` assertion in the four Owned files was re-grepped (definition_permission.rs callers at lines 704, 746, 765, 785, 819, 834, 887, 963, 987, 1006, 1030, 1065, 1077, 1111, 1139, 1170, 1186, 1236; agents.rs `discover_one` fixtures and `frontmatter_notes` asserts; policy_gate.rs `parse_permission_block` at 2571) — the 13-site net is re-derived from that, not from memory; (b) the phantom agents.rs names are gone, replaced by the real ones read from the tree (`a_permission_block_reads_as_a_real_value_not_a_noop` at 1472, `malformed_permission_never_panics_the_discovery` at 1582 with the no-fence case as its sub-scenario (d)); (c) the six `BashPatternRules` occurrences were counted by `grep -c` per file (definition_permission.rs 3, agents.rs 2, policy_gate.rs 1, gate.rs 0 — the four-file total is SIX); (d) T4's loop was re-read at lines 733–761: TEN keys, all ten break; (e) T6's fixture re-read at 784 and its note order confirmed (three `UnrecognizedToolKey`, no `UnsupportedUnvalidatedMatcher`); (f) the note ORDER inside one block was re-derived from the reader's push sites — `rows_to_rules` `UnknownAction` (line 527) and `collect_block`/guard order mean row-8's vec is `[UnknownAction("deny # trailing"), PathPatternRules]` (D4's `UnknownAction` is pushed BEFORE the guard runs), and C1's vec is `[PathPatternRules, UnrecognizedToolKey("task"), BashPatternRules]` (guard fires per tool as the loop reads `edit` first).
- **Grounding-file citations** — the two ADRs and the permissions-model page were read in full; every quote in this plan is from direct read on this branch, and the handful of line numbers that drifted from the grounding (guard 418 not 414; enum 195 not 194; `parse_permission_block` 311 not 270) were re-measured here.
- **Un-verified by design:** `cargo clippy --all-targets`, `cargo fmt --check`, full `cargo test`, `pnpm test`, `pnpm build` are the implementer's gate legs — the implementer must run them per the `Steps:`; the plan asserts expectations (0 failures; frontend untouched) but does not claim them as measurements.
- **A note on the fixture count:** the previous draft's "one green fixture + one gate-adjacent fixture" note is superseded — BOTH named fixtures (`a_blank_line_inside_a_nested_pattern_map_is_skipped_too` and `the_real_researcher_block_is_read_...`) are now in the break/update list (rows 1 and the tightened-`contains` hygiene in Step 4). The researcher-shape `edit:` map is covered by the anti-silence test (deliberately minimal and serde-free so it cannot pass on the wrong reason), C1's updated vec, and the tightened researcher `contains`.