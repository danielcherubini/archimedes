# Grounding Report — Definition (B1 parse, B2 carry + enforce)

Branch `feature/agent-permission-and-pins`, base `2b6bd26 "Permissions: the agent's own dirs become an ask, plus a rule model (#119)"`.

Scope: **definition** — Agent definition files (`agents.rs`), the launch-precedence resolver (`agent/harness/launch.rs`), the subagent dispatch (`agent/subagent.rs`, `agent/harness/dispatch.rs`, `agent/worker/manager/subagent_flow.rs`), the policy gate (`agent/harness/loop/gate.rs`), the policy vocabulary (`agent/policy.rs`), the canonicalizer (`agent/fs_backend.rs`), the loop seam (`agent/harness/loop.rs`), and the modal command (`commands/agents.rs`). Everything quoted below is VERBATIM from the tree at this commit unless a `[…]` elision says otherwise.

---

## 1. `src-tauri/src/agents.rs` — the parser B1 must modify

### 1a. `parse_agent_file` IN FULL

The parser B1 extends. `lines 285–388` (module doc comment + signature + full body):

```rust
/// The tolerant frontmatter reader (no YAML crate): any failure mode
/// (missing closing `---`, …) → `None` (the agent is skipped, never a
/// crash).
///
/// Returns `(name, description, model, thinking, tools, body)`.
#[allow(clippy::type_complexity)] // the 6-tuple IS the spec's signature
fn parse_agent_file(
    content: &str,
    fallback_name: &str,
) -> Option<(
    String,
    String,
    Option<String>,
    Option<String>,
    Option<Vec<String>>,
    String,
)> {
    // 1. Normalize `\r\n` and lone `\r` to `\n`.
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    // 2. Frontmatter = a block starting at the very beginning: line 1
    //    is exactly `---`, then lines until a line that is exactly
    //    `---`. If line 1 is not `---`: no frontmatter → name =
    //    fallback (the stem), description = "", all Option fields =
    //    None, body = the whole content (trimmed).
    if lines.first() != Some(&"---") {
        return Some((
            fallback_name.to_string(),
            String::new(),
            None,
            None,
            None,
            normalized.trim().to_string(),
        ));
    }
    // The closing `---` is REQUIRED — EOF before it means the
    // frontmatter is malformed → None.
    let close = lines[1..].iter().position(|l| *l == "---")?;
    let fm_end = 1 + close;
    let fm: &[&str] = &lines[1..fm_end];
    let body = lines[fm_end + 1..].join("\n").trim().to_string();

    // 3. Top-level (non-indented) keys only, first occurrence of each
    //    wins (indented lines belong to the previous key's block value;
    //    any other top-level key is ignored).
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut model: Option<String> = None;
    let mut thinking: Option<String> = None;
    let mut tools: Option<String> = None;
    let mut i = 0;
    while i < fm.len() {
        let line = fm[i];
        if !line.starts_with(' ') && !line.starts_with('\t') {
            if name.is_none() {
                if let Some(rest) = line.strip_prefix("name:") {
                    name = parse_value(fm, i, rest);
                }
            }
            if description.is_none() {
                if let Some(rest) = line.strip_prefix("description:") {
                    description = parse_value(fm, i, rest);
                }
            }
            if model.is_none() {
                if let Some(rest) = line.strip_prefix("model:") {
                    model = parse_value(fm, i, rest);
                }
            }
            if thinking.is_none() {
                if let Some(rest) = line.strip_prefix("thinking:") {
                    thinking = parse_value(fm, i, rest);
                }
            }
            if tools.is_none() {
                if let Some(rest) = line.strip_prefix("tools:") {
                    tools = parse_value(fm, i, rest);
                }
            }
        }
        i += 1;
    }

    // 4. `name` empty or whitespace-only after parsing (an `""` value,
    //    a `"   "` value, or a block with no indented lines) → fallback
    //    (the stem).
    #[… long tag-safety paragraph, elided — see 1b for the key sentence …]
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    // `description` left as parsed (may be empty). NO 1024-char cap HERE, […]
    let description = description.unwrap_or_default();
    // `model` / `thinking` empty after parsing → None.
    let model = model.filter(|m| !m.trim().is_empty());
    let thinking = thinking.filter(|t| !t.trim().is_empty());
    // `tools`: normalize the string / array spellings; a list that
    // empties out → None.
    let tools = tools.as_deref().and_then(parse_tools);

    // 5. `body` = the content after the closing `---` (trimmed).
    Some((name, description, model, thinking, tools, body))
}
```

Key facts for B1:

- **The 6-tuple is the function's contract** — `#[allow(clippy::type_complexity)] // the 6-tuple IS the spec's signature`. Adding a 7th element (`permission`) changes the return type and every destructure at the two call sites: the `discover_in_roots` construction site (quoted in 1d) and the no-frontmatter early return here.
- **Step 3's top-level scan ONLY visits non-indented lines.** The guard is:
  ```rust
  if !line.starts_with(' ') && !line.starts_with('\t') {
  ```
  A `permission:` block — whose value is the *indented* lines under it — is **unreadable today**: the scan only ever calls `parse_value` on lines that do not start with a space/tab, so a `permission:` key with an empty inline value (`rest` empty after the `:`), which is exactly the shape `permission:` followed by indented rules gets:
    - `rest.trim()` is empty → `parse_value` returns `None` (first line of `parse_value`'s body), so `permission` would read as "no value" and the indented rule lines below are *skipped entirely* by the top-level scan (they start with a space).
  - B1 must therefore either thread the indented block through a new reader (the natural shape: read the indented descendants of a `permission:` line inside step 3, or a nested helper mirroring `parse_value`'s block branch), or extend `parse_value`. The two `if x.is_none()` arms block FIRST-occurrence-wins; they are per-field and additive.
- **Every `if x.is_none()` arm** is quoted in full above (five fields: `name`, `description`, `model`, `thinking`, `tools`). A `permission` field follows the same first-wins pattern.
- The `\r\n` normalisation (step 1) and `---` block rules (step 2) are quoted verbatim above; a nested reader operates on `fm` (the `&[&str]` of frontmatter lines *after* `\r\n` normalisation and after the two `---` delimiters are stripped) — the indented descendants are already clean of CR.

### 1b. The step-4 tag-safety paragraph (verbatim, key sentence)

Full `name` handling quoted in 1a; the injected paragraph (elided above) is:

```rust
    //    NO tag-safety skip here — and the reason is NOT that the name never
    //    reaches a prompt tag. It DOES: the composer's `@`-mention expansion
    //    interpolates it UNESCAPED into `<agent name="NAME">` and into the
    //    block body (`definition "NAME"`, `agentName "NAME"`) — see
    //    `buildAgentBlock` in `src/lib/skills.ts`. What makes that safe is
    //    `expandMentions`' EXACT-MATCH lookup: a hit requires
    //    `name.toLowerCase() === token` and every tag-UNSAFE character (`"`,
    //    `<`, control chars) is UNCHANGED by `toLowerCase()`, so a name
    //    containing one equals no `[a-z0-9-]` token and can NEVER be
    //    interpolated at all (the argument is NOT injectivity — U+212A KELVIN
    //    SIGN folds to `k`, and is harmless only because it is itself
    //    tag-safe) — and the picker surfaces hide such names so no dead token
    //    is ever offered (`commands::agents::list_agent_definitions_for_space`).
    //
    //    Discovery itself must therefore NOT skip unsafe names: the harness's
    //    `agentName` dispatch still honors them (a name with a space is
    //    dispatchable — the model passes it verbatim), so skipping would
    //    silently break existing user files. `list_agents` needs no guard
    //    either — its output crosses the wire JSON-escaped.
```

### 1c. `parse_value` IN FULL (agents.rs copy)

`lines 415–472`:

```rust
/// Parse the value of a top-level `key: <rest>` line (step 3).
///
/// (A copy of `skills.rs`'s `parse_value` — deliberate per ADR 0020
/// (docs/decisions/0020-native-subagent-agent-definitions.md): "do NOT
/// change `skills.rs`'s visibility — the two frontmatter shapes differ,
/// so the modules stay independent". `parse_value` itself is
/// shape-agnostic: if a bug is found in the value-reading logic (e.g. the
/// NBSP/dedent byte-offset guard documented below), it must be applied to
/// BOTH copies.)
///
/// ONE CARVE-OUT to that "both copies" rule, and it is not a shape bug: the
/// trailing `#`-comment strip that `skills.rs`'s `parse_value` gained for issue
/// #11 belongs HERE NOT. The two copies mirror DIFFERENT upstream readers.
/// `skills.rs` mirrors pi's `parseFrontmatter`, which parses with the `yaml`
/// package — a plain scalar ENDS at a `#` preceded by a space or tab, so pi
/// strips it. This copy mirrors the reader ADR 0020 names for Agent
/// definitions: pi's subagent extension (`pi-subagents`,
/// `src/agents/frontmatter.ts`), whose `parseFrontmatter` is a hand-rolled
/// `/^([\w-]+):\s*(.*)$/` regex reader. Measured against it, that reader KEEPS
/// the comment — `name: a # note` → `"a # note"` and `description: Do the thing
/// # internal` → `"Do the thing # internal"`. Stripping here would therefore
/// move the desktop AWAY from the only pi-side reader of Agent definitions and
/// MANUFACTURE the divergence ADR 0036 exists to prevent. So: the "both copies"
/// rule binds for SHAPE bugs (the NBSP/dedent guard, the quote pair, the `: `
/// guard — where both copies read the same thing) and does NOT bind for this
/// strip. Should that scoping ever be revisited, it needs its own parity target
/// decided first, plus a truth table here — issue #11 is about Skills only.
///
/// A SECOND exception sits in the quote pair itself, and it narrows the
/// "the quote pair" clause above rather than contradicting it: `skills.rs` now
/// additionally UN-DOUBLES a SINGLE-quoted scalar's `''` escapes, because YAML's
/// single-quote escape IS the doubled pair and `yaml` resolves it to one `'`
/// (`'it''s fine'` → `it's fine`). This copy must NOT do that. The same
/// `frontmatter.ts` reader slices one quote pair off and stops
/// (`value = value.slice(1, -1)`) — measured against it, `description: 'it''s'`
/// is `it''s`, pair still doubled. So the shared part of the quote pair is what
/// both readers actually do (remove one matching surrounding pair); the
/// un-doubling belongs to the `yaml`-backed reader alone, for the same reason as
/// the comment strip above: a second divergence in the same direction, against
/// the same target, manufactured for free. Each side names the other.
///
/// - inline: the rest of the line, trimmed; strip one pair of matching
///   surrounding quotes; an empty inline value means "no value".
/// - block: the inline value is exactly `|` or `>` (optionally followed
///   by ONE chomping/indent indicator — `-` or `+ — with any further
///   trailing whitespace: the value is the following indented lines
///   until the next non-indented line; `|` joins with `\n`, `>` joins
///   with a single space; the result is dedented and trimmed.
/// - an unquoted inline value containing `: ` (a YAML mapping
///   ambiguity) → no value (tolerant, no crash).
fn parse_value(fm: &[&str], idx: usize, rest: &str) -> Option<String> {
    let inline = rest.trim();
    if inline.is_empty() {
        return None;
    }

    let (style, is_block) = match inline {
        "|" => ('|', true),
        "|-" => ('|', true),
        "|+" => ('|', true),
        ">" => ('>', true),
        ">-" => ('>', true),
        ">+" => ('>', true),
        _ => ('\0', false),
    };
    if is_block {
        let mut collected = Vec::new();
        let mut j = idx + 1;
        while j < fm.len() {
            let l = fm[j];
            if l.starts_with(' ') || l.starts_with('\t') {
                collected.push(l);
                j += 1;
            } else {
                break;
            }
        }
        if collected.is_empty() {
            return Some(String::new());
        }
        // Dedent: strip the common leading whitespace (YAML block
        // semantics — the block's indent is not part of the value).
        // ASCII spaces/tabs ONLY: `trim_start` would also trim UNICODE
        // whitespace (e.g. U+00A0 NBSP, 2 bytes), making the byte offset
        // land mid-character and the `&l[min..]` slice panic — but the
        // discovery must be total (never panic). NBSP is content, not
        // indent.
        let min: usize = collected
            .iter()
            .map(|l| l.len() - l.trim_start_matches([' ', '\t']).len())
            .min()
            .unwrap_or(0);
        let dedented: Vec<&str> = collected.iter().map(|l| &l[min..]).collect();
        let joined = if style == '|' {
            dedented.join("\n")
        } else {
            dedented.join(" ")
        };
        return Some(joined.trim().to_string());
    }

    // Strip one pair of matching surrounding quotes.
    let first = inline.chars().next().unwrap();
    let last = inline.chars().next_back().unwrap();
    if (first == '"' || first == '\'') && first == last && inline.len() >= 2 {
        return Some(inline[1..inline.len() - 1].to_string());
    }
    // Unquoted inline containing `: ` (a YAML mapping ambiguity) → no
    // value (tolerant, no crash).
    if inline.contains(": ") {
        return None;
    }
    Some(inline.to_string())
}
```

The two reasons the planner must see:

1. **`parse_value` returns `None` for an empty inline value** (`if inline.is_empty() { return None; }`). A `permission:` line whose rules are on the *following indented lines* has an empty `rest`, so a plain `parse_value` call reads it as "no value".
2. **The step-3 scan visits non-indented lines only** (quoted in 1a), so the indented rule rows under `permission:` are never visited by the top-level loop. A nested reader that walks `fm[idx+1..]` while lines are indented (exactly the `is_block` branch's collection loop, quoted above) is the existing primitive that CAN see them. Note the `is_block` collection semantics (indent-collect → `dedent` → join) and its ASCII-space/tab totalness contract — the NBSP/dedent byte-offset guard.

Also note `parse_tools` (lines 390–413, unchanged by B1) normalizes the `tools` string/array spellings — the pattern a `permission` block reader should NOT blindly reuse (it splits on `,`, which is wrong for `tool: pattern` rows).

### 1d. `AgentDefinition` struct with ALL doc comments + the `discover_in_roots` construction site

Struct (lines 34–88):

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    /// Frontmatter `name`, else the file's STEM name (`scout.md` → `scout`).
    pub name: String,
    /// Frontmatter `description`, else `""`.
    pub description: String,
    /// Frontmatter `model` (`"provider/id"` or `"provider/id:<level>"`), verbatim.
    pub model: Option<String>,
    /// Frontmatter `thinking` (a native extension beyond pi's format).
    pub thinking: Option<String>,
    /// Frontmatter `tools` (both the `read, bash` string and the `[read, bash]`
    /// array spellings normalize to this).
    pub tools: Option<Vec<String>>,
    /// The file body (minus the frontmatter), trimmed. `""` when the body is
    /// empty (no system prompt).
    pub system_prompt: String,
    pub scope: AgentScope,
    /// Absolute (canonical) path to the file.
    pub path: String,
    /// The Agent definitions this name collision EXCLUDED, reported here on the
    /// winner (ADR 0065: a shadow is a REPORT, not an entry — the losers stay
    /// unaddressable by name). The SAME rule `skills.rs` applies, over the SAME
    /// shared `Shadowed<T>` shape. Additive, so every existing consumer of this
    /// struct is unaffected.
    ///
    /// **A REPORT, rendered on the winning row — never a row of its own.** It
    /// crosses the wire: `commands::agents::AgentConfigDto` carries this very
    /// `Shadowed<AgentScope>` (ADR 0068), so the sidebar **Agents** modal can
    /// name the loser a collision excluded. `AgentDefinitionDto` still does NOT
    /// carry it — and `discover_agents(None)` reads user-level roots only, so
    /// the old app-global Settings page could never have seen a
    /// Space-shadows-user collision anyway. The modal runs discovery with the
    /// active Space's `cwd`, which is the surface that CAN.
    pub shadowed: Vec<crate::skills::Shadowed<AgentScope>>,
}
```

Construction site inside `discover_in_roots` (lines 206–216):

```rust
            content_by_name.insert(key.clone(), normalized);
            by_name.insert(
                key,
                AgentDefinition {
                    name,
                    description,
                    model,
                    thinking,
                    tools,
                    system_prompt,
                    scope: *scope,
                    path: canon.to_string_lossy().into_owned(),
                    shadowed: Vec::new(),
                },
            );
```

The `Some((name, description, model, thinking, tools, system_prompt)) = parse_agent_file(&content, &stem) else { continue; };` destructure (line 190) is the other shape B1 touches. B1 also needs the `#[serde(rename_all = "camelCase")]` note: a nested `permission` value would serialize verbatim with the struct's derive unless it carries its own serde attrs.

---

## 2. ADR 0020 parity rule + the two-copy divergence — wording the new reader must mirror

### 2a. The parity rule (ADR 0020, consequence #4, verbatim)

From `docs/decisions/0020-native-subagent-agent-definitions.md`:

> - `skills.rs` and `agents.rs` each carry a copy of the shape-agnostic `parse_value` helper (the reviewed plan kept the modules independent — the two frontmatter shapes differ, and `skills.rs`'s visibility is NOT changed): a bug in the value-reading logic (e.g. the NBSP/dedent byte-offset guard) must be applied to BOTH copies.

The `agents.rs` copy restates the rule in its own doc (quoted in full in 1c): the rule "binds for SHAPE bugs (the NBSP/dedent guard, the quote pair, the `: ` guard)" and **does NOT bind** for the two named divergences.

### 2b. Where `skills.rs`'s `parse_value` states it deliberately diverges (verbatim)

`src-tauri/src/skills.rs` line 756 `fn parse_value(…)` + the two named places:

First — the trailing-`#` strip, `skills.rs` lines 761–768:

```rust
    // A trailing `#` comment is not part of the value (issue #11: pi strips it,
    // and a `name: a # note` left whole is a name no `$` token can address).
    // BEFORE the block-indicator match, so `description: > # note` still reads
    // as the block scalar pi reads it there.
    let inline = strip_trailing_comment(inline);
    if inline.is_empty() {
        return None;
    }
```

Second — the `''` un-doubling, `skills.rs` doc above the quote slice:

```rust
        // SINGLE QUOTES ONLY, deliberately: inside a DOUBLE-quoted scalar `''`
        // is two literal apostrophes (its escape is the backslash), so
        // `"it''s"` stays `it''s` for pi and stays untouched here.
        //
        // DIVERGENCE from `agents.rs`'s copy of this function, and the "apply
        // shape bugs to BOTH copies" rule it states: that copy mirrors pi's
        // SUBAGENT reader (`pi-subagents/src/agents/frontmatter.ts`), a
        // hand-rolled regex reader that slices one quote pair off and NOTHING
        // ELSE — measured against it, `description: 'it''s'` is `it''s`, quotes
        // stripped, pair left doubled. Un-doubling there would move the desktop
        // away from its only pi-side parity target, exactly as the trailing-`#`
        // strip does (that carve-out's doc names the same reason). So this
        // clause is a SECOND, named exception to the "both copies" rule: the
        // rule binds for the guards both readers share (the NBSP/dedent
        // byte-offset guard, the `: ` guard), and NOT for either of the two
        // places where the two upstream readers genuinely differ.
```

And in `agents.rs`, the mirror statement (quoted in full in 1c): *"This copy mirrors the reader ADR 0020 names for Agent definitions: pi's subagent extension (`pi-subagents`, `src/agents/frontmatter.ts`)"*.

**Constraint B1 must respect:** a `permission` block reader is NEW vocabulary — it is not a copy of either `parse_value`'s scalar logic. But if B1 *reuses* `agents.rs`'s `parse_value` (or a shape bug is fixed), the "BOTH copies" binding applies to shared logic; and any divergence the permission reader introduces must be stated against the SAME parity target (`pi-subagents/src/agents/frontmatter.ts`). **Also relevant:** opencode's `permission:` frontmatter block (the target of #101) is NOT a pi format — pi's reader has no such key. So the new reader's doc should name its upstream explicitly rather than borrow the pi-parity language; the existing wording gives the exact sentence shape (`"…which is the divergence ADR 0036 exists to prevent"` / `"measured against it, …"`).

### 2c. The divergence pin test, name + assertions

Test lives in `agents.rs`'s test module: `the_two_parse_value_copies_diverge_where_their_parity_targets_differ` (line 749). Its doc:

```rust
    /// The two `parse_value` copies are DOCUMENTED to diverge on exactly two
    /// shapes (see this fn's doc: the trailing `#` strip and the single-quoted
    /// `''` un-doubling), and the doc is only worth anything if a change that
    /// re-unifies them is caught. So this pins the DIVERGENCE at the discovery
    /// level — both public readers, the SAME frontmatter text, two expected
    /// values — rather than asserting equality (which would be the wrong
    /// invariant) or reading a private fn (which would need the visibility
    /// change ADR 0020 forbids).
```

Its assertions (agent side):

```rust
        assert_eq!(
            agent("quote"),
            "'it''s fine' # note",
            "DIVERGENCE HALF 1, agent side: this copy mirrors `frontmatter.ts`, \
             a regex reader with NO comment rule at all, so the value stays \
             verbatim. Stripping the note here would move the desktop away from \
             its only pi-side reader of Agent definitions and manufacture the \
             divergence ADR 0036 exists to prevent"
        );
        assert_eq!(
            agent("pair"),
            "it''s",
            "DIVERGENCE HALF 2, agent side: the quote branch DOES run here (the \
             value starts and ends with `'`), and it does exactly what \
             `frontmatter.ts` does — `value.slice(1, -1)`: one surrounding pair \
             removed, NOTHING else. The doubled `''` survives, because that \
             reader has no escape rule. Un-doubling it here (`\"''\"` → `\"'\"`) \
             would manufacture the same ADR 0036 divergence as half 1, against \
             the same parity target"
        );
```

The test body writes the same frontmatter text (`---\nname: quote\ndescription: 'it''s fine' # note\n…` and `---\nname: pair\ndescription: 'it''s'\n…`) into both an agent root (`discover_in_roots` with `AgentScope::Space`) and a skill root (`crate::skills::discover_in_roots` with `SkillScope::User`), then asserts the two sides read `quote`/`pair` differently as quoted above. A B1 nested reader must NOT perturb these two fixtures (they exercise `parse_value` only, no `permission:` block).

---

## 3. Every existing test in `agents.rs`'s test module + the scratch helper

`#[cfg(test)] mod tests` (line 473 onward). Helper functions: `scratch()`, `write_file(path, content)`, `canon(p)`. Tests, all 23 by name:

1. `the_agents_scratch_helper_owns_its_dir`
2. `a_panicking_assertion_still_removes_the_agents_scratch`
3. `a_flat_agent_file_is_discovered_with_all_fields`
4. `a_file_without_frontmatter_uses_the_stem_name`
5. `a_missing_name_key_falls_back_to_the_stem`
6. `a_malformed_frontmatter_is_skipped`
7. `tools_accepts_string_and_array_spellings`
8. `the_two_parse_value_copies_diverge_where_their_parity_targets_differ` (see §2c)
9. `tools_empty_list_is_none`
10. `a_missing_root_yields_an_empty_vec`
11. `a_non_md_file_is_ignored`
12. `first_wins_dedupe_space_shadows_user`
13. `innermost_level_shadows_outer`
14. `a_symlink_collapses_across_roots`
15. `a_model_with_a_level_suffix_is_preserved_verbatim`
16. `output_is_deterministically_sorted`
17. `user_roots_reads_home`
18. `space_roots_walks_up_to_the_repo_root`
19. `identical_agent_files_across_roots_are_silent`
20. `a_crlf_agent_copy_across_roots_is_silent`
21. `a_shadowed_agent_names_its_loser_path`

(That is 21 `#[test]` fns listed via the `#[test]`-anchored grep; `a_flat_agent_file_is_discovered_with_all_fields` pins the FULL 6-field parse — a new `permission` field must not break the `d.tools`, `d.model`, `d.description`, `d.system_prompt`, `d.scope`, `d.path` assertions, and `AgentDefinition` gets a new field so `assert_eq!` on whole structs is not possible anyway — the tests assert per-field.)

The scratch helper (verbatim, lines 476–497):

```rust
    /// A scratch root with an EMPTY `.git/` dir so the context walk is
    /// bounded at the scratch (a stray `~/.agents/agents` or `~/.pi`
    /// from a developer's real home must not break the assertions) — and
    /// OWNED (#96 task 08): the dir and everything under it is removed when
    /// the guard drops. NOT `Clone`; `to_path_buf()` is the escape hatch
    /// where a `PathBuf` is needed.
    ///
    /// The `archimedes-agents-` prefix is verbatim (D12: #96's census
    /// attributes by prefix) with a `root` tag inserted INSIDE it, so the
    /// name shape changes and the census glob does not. This helper is
    /// called 24 times per run and the file contained ZERO `remove_dir_all`
    /// before this change — 24 dirs/run, the largest single-file leak in the
    /// lib suite.
    fn scratch() -> crate::test_support::ScratchDir {
        let dir = crate::test_support::ScratchDir::in_env_temp("archimedes-agents-", "root");
        fs::create_dir_all(dir.join(".git")).unwrap();
        dir
    }
```

`ScratchDir` itself (in `src-tauri/src/test_support.rs`):

```rust
pub struct ScratchDir {
    path: std::path::PathBuf,
}
// …
    pub fn in_env_temp(prefix: &str, tag: &str) -> Self {
        Self::in_dir(&std::env::temp_dir(), prefix, tag).expect(…)
    }
```

A new B1 parse test should follow the `scratch()` + `write_file` + `discover_in_roots(&[(root.to_path_buf(), AgentScope::User)])` pattern that every test above uses. Note `test_support::env_lock()` exists (`src-tauri/src/test_support.rs:14`) for tests that pin `$HOME`; the agents parses need no `$HOME` pin (discovery takes explicit roots).

---

## 4. "Announce an unknown key" — the existing REPORT/shadow channel

**Question:** is there any mechanism for a definition file to *announce* something? Answer: YES, exactly one, and it is **a report carried on a row, never a new error path** — the `Shadowed<T>` shape. There is NO generic "warnings from this file" channel today; if B1's "announce unknown top-level keys" needs to surface, it must either reuse the `shadowed`-style report pattern (a new field on `AgentDefinition` + a new field on `AgentConfigDto`, rendered by the modal) or create a new report field. Nothing exists to hang "this file had an unknown key" on.

### 4a. `Shadowed<AgentScope>` (verbatim, `skills.rs` lines 70–80)

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shadowed<T> {
    pub name: String,
    /// Canonical path to the shadowed `SKILL.md`.
    pub path: String,
    pub scope: T,
}
```

And `AgentDefinition::shadowed`'s doc (quoted in 1d) — the field itself is `pub shadowed: Vec<crate::skills::Shadowed<AgentScope>>`.

### 4b. ADR 0065 — "a shadow is a REPORT, not an entry" (verbatim)

From `docs/decisions/0065-a-shadowed-skill-is-a-report-not-an-entry.md`:

> A shadowed Skill stays **unaddressable**… the excluded Skills are **Shadowed**: disclosed in the Skills dialog as a count plus each loser's name, path and scope, rather than listed as entries of their own. **Name** — not path — stays a Skill's identity, so a shadowed Skill stays unaddressable.
> …
> **The same reporting applies to Agent definitions**, which shadow identically (`agents.rs`): the rule and the `Shadowed<T>` shape are shared with `skills.rs`, and the line-ending normalization has ONE owner (`skills::normalize_line_endings`) rather than a second copy. It is computed on `AgentDefinition` and **NOT carried on `AgentDefinitionDto`** — the DTO deliberately excludes the fields the UI doesn't need, `path` among them…

The "a shadow is a REPORT, not an entry" sentence lives in `AgentDefinition::shadowed`'s doc: *"ADR 0065: a shadow is a REPORT, not an entry — the losers stay unaddressable by name"* (quoted in 1d), and in `AgentConfigDto::shadowed`'s doc: *"Rendered as TEXT on this row, never as rows of its own."* (quoted in 11).

### 4c. How `list_agent_config` surfaces it

`AgentConfigDto.shadowed` (line 197) is `REQUIRED on the wire, not Option … Rendered as TEXT on this row, never as rows of its own`, cloned straight from `def.shadowed` in `agent_config` (`shadowed: def.shadowed.clone()`). The test `agent_config_carries_the_shadowing_report_on_the_winning_row` pins it (see §11).

### 4d. Can discovery return anything but `Vec<AgentDefinition>`?

**No.** Both are total and infallible:

```rust
pub fn discover_agents(space_path: Option<&Path>) -> Vec<AgentDefinition> { … }

pub fn discover_in_roots(roots: &[(PathBuf, AgentScope)]) -> Vec<AgentDefinition> { … }
```

`discover_in_roots` has no `Result` and never panics (module doc: *"Pure (fs reads only) and total: `discover_agents` never panics and never errors — a missing root, an unreadable file, or malformed frontmatter is silently skipped."*). So "announce an unknown key" **cannot** be a new error/`Result` path — it structurally must ride the returned `Vec<AgentDefinition>` (a new field, empty for files with no unknown keys), or a side channel like the event sink, which discovery has no access to. This is a hard constraint: B1's announcement is a per-definition report field or nothing.

---

## 5. `agent/harness/launch.rs` — the resolver B2 threads through

### 5a. `LaunchConfig` (verbatim, from `agent/subagent.rs` lines 35–61 — the struct is defined there, used here)

```rust
/// Per-dispatch pi configuration for a subagent session (moved verbatim
/// from `launch_wrapper.rs` — the wrapper script is deleted in this task;
/// the flags are now passed directly to the `pi` spawn).
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

`LaunchConfig` derives `Default` and `Deserialize`, and crosses the wire inside `SubagentDispatchWire` (`agent/worker/protocol.rs:341 pub launch: crate::agent::subagent::LaunchConfig`). **A fourth field (the `permission` ruleset) is a wire-additive JSON key** — old daemons/supervisors tolerate an unknown key (serde default), and `LaunchConfig::default()` gives it `None`, so every construction site that uses `..Default::default()` needs no edit.

### 5b. `ResolvedLaunch`, `OverrideSource`, `OverrideLayer`, `override_layer` (verbatim)

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

`ResolvedLaunch` has exactly ONE construction site: `resolve_agent_launch` itself (line 270). Adding a `permission`-carrying field to `ResolvedLaunch` touches only that one site.

```rust
/// Which layer supplied a resolved field — the label space of the Agents modal
/// (`override` / `file` / `parent`, ADR 0068) and NOTHING else. A fourth layer
/// (ADR 0066's per-Space door) means adding a variant here, and the exhaustive
/// match in Task 2's test is what makes that a compile error rather than a
/// silent label.
///
/// `pub`, NOT `pub(crate)`: Task 2's `AgentConfigDto` is `pub` and carries a
/// source struct, and clippy's `private_interfaces` fires transitively down
/// that graph under CI's `-D warnings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OverrideSource {
    /// `settings.json`'s `agentOverrides` (ADR 0066).
    Override,
    /// The Agent definition's frontmatter.
    File,
    /// Nothing BELOW the explicit `subagent` param spoke, so the child
    /// inherits — which is NOT a promise: a dispatch that passes `model:`
    /// overrides what a `parent` row shows, hence the modal's
    /// `Inherits parent` wording (ADR 0068). The label space has no word for
    /// "the explicit param itself" (no live modal can observe one, and
    /// `list_agent_config` passes an empty `LaunchConfig`), so a field the
    /// explicit param supplied reports `Parent`.
    Parent,
}
```

```rust
pub(crate) struct OverrideLayer<'a> {
    pub global: Option<&'a AgentOverrideFields>,
}
```

```rust
pub fn override_layer<'a>(settings: Option<&'a Settings>, agent_name: &str) -> OverrideLayer<'a> {
    OverrideLayer {
        // `None` settings (no file) and "no entry" both give `global: None` —
        // see `OverrideLayer`'s note on the three collapsed causes.
        global: settings.and_then(|settings| {
            settings
                .agent_overrides
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(agent_name))
                .map(|(_, entry)| entry)
        }),
    }
}
```

### 5c. The precedence ladder — the `pick`/rungs code for model, thinking, tools

The shared rung-picker (`first_speaking`, lines 110–141):

```rust
/// The FIRST rung that supplies a value, plus the name of the layer that
/// supplied it (`Parent` when none did).
///
/// Every field of the chain runs through here, so the rungs of ONE field are
/// listed in ONE expression — and a new layer (ADR 0066's *Deferred: per-Space*
/// door: one more map folded at load time) joins that list in order, in the one
/// place a reviewer can see it. A layer added to the dispatch and forgotten in
/// the modal is the drift ADR 0068 exists to prevent; a shared list of rungs is
/// the shape that makes it hard to do by accident.
///
/// A rung whose value needs no filtering (the explicit `subagent` params) is
/// passed through UNFILTERED as the first rung; a filtered or soft-degraded
/// candidate arrives as `None` when it does not survive, which is precisely
/// "this layer does not speak" (ADR 0067).
fn first_speaking<T>(
    rungs: impl IntoIterator<Item = (OverrideSource, Option<T>)>,
) -> (Option<T>, OverrideSource) {
    rungs
        .into_iter()
        .find_map(|(source, value)| value.map(|value| (Some(value), source)))
        .unwrap_or((None, OverrideSource::Parent))
}
```

The three rung lists inside `resolve_agent_launch` (lines 143–262), verbatim:

**model:**
```rust
    // The rungs, in order: the explicit param (NEVER degraded — see above), the
    // override, the frontmatter.
    let (model, model_source) = first_speaking([
        (OverrideSource::Parent, explicit.model.clone()),
        (
            OverrideSource::Override,
            layer
                .global
                .and_then(|o| o.model.as_ref())
                .filter(|m| soft(m))
                .cloned(),
        ),
        (
            OverrideSource::File,
            def.model.as_ref().filter(|m| soft(m)).cloned(),
        ),
    ]);
```

**thinking:**
```rust
    let (thinking, thinking_source) = match explicit.thinking.clone() {
        Some(level) => (Some(level), OverrideSource::Parent),
        None => match layer.global.and_then(|o| o.thinking.as_ref()) {
            Some(level) if advertises(level) => (Some(level.clone()), OverrideSource::Override),
            // Absent, or demoted because the winning model lacks it.
            _ => (None, OverrideSource::Parent),
        },
    };
```

**tools:**
```rust
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
```

`resolve_agent_launch`'s signature + doc:

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

And the constructed output:

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

**What adding a fourth field (the `permission` ruleset) costs here:** a `permission` field on `LaunchConfig` + a `resolve_agent_launch` arm that copies `def.permission` into `launch.permission` (with NO rung ladder unless the override/explicit layers may speak about permissions — the plan's call). It is NOT a `first_speaking` candidate today (no `OverrideSource::Permission` variant, and adding one would force the §11 `SourceFields` three-column shape and `the_source_label_space_is_exactly_three_layers_and_never_space` to change). And the whole-tool-deny behavior lives in the *gate/enforcement* seam (§7) and the *tool-advertisement* seam (§6), not in the resolver.

### 5d. The tests + helpers

`resolve_agent_launch_reports_which_layer_supplied_each_field` — verbatim core:

```rust
    /// (ADR 0068) `source` per field names the layer that SUPPLIED it:
    /// `override` for the store, `file` for the frontmatter, `parent` when
    /// nothing below the explicit param spoke.
    #[test]
    fn resolve_agent_launch_reports_which_layer_supplied_each_field() {
        let catalog = ModelCatalog {
            models: vec![fake_model("m1"), fake_model("m2")],
            default_model: None,
            compaction: CompactionConfig::default(),
        };
        // (a) the override supplies the model, the file supplies the tools.
        let def = def_with(Some("fake/m1"), None, Some(&["read"]));
        let layer = OverrideLayer {
            global: Some(&AgentOverrideFields {
                model: Some("fake/m2".to_string()),
                thinking: None,
                tools: None,
            }),
        };
        let r = resolve_agent_launch(&LaunchConfig::default(), &def, &layer, &catalog);
        assert_eq!(r.launch.model, Some("fake/m2".to_string()));
        assert_eq!(r.model_source, OverrideSource::Override);
        assert_eq!(r.launch.tools, Some(vec!["read".to_string()]));
        assert_eq!(r.tools_source, OverrideSource::File);
        // A demoted / absent thinking is NOT reported as the override's, and the
        // file's value never moves into `thinking` — so `thinking_source` is
        // `Parent` here even though `frontmatter_thinking` carries `low`.
        assert_eq!(r.launch.thinking, None);
        assert_eq!(r.thinking_source, OverrideSource::Parent);
        // (b) NOTHING speaks (no layer, no frontmatter values) → every field is
        // `Parent` = "no layer below the explicit param spoke" (ADR 0068 — the
        // modal labels it `Inherits parent`, and a dispatch that passes the
        // param still overrides it).
        let bare = def_with(None, None, None);
        let r = resolve_agent_launch(
            &LaunchConfig::default(),
            &bare,
            &OverrideLayer { global: None },
            &catalog,
        );
        assert_eq!(r.launch.model, None);
        assert_eq!(r.model_source, OverrideSource::Parent);
        assert_eq!(r.thinking_source, OverrideSource::Parent);
        assert_eq!(r.tools_source, OverrideSource::Parent);
    }
```

The `definition` test helper B2 extends — `def_with` (lines 1627–1649):

```rust
    /// A `scout` definition with the given frontmatter fields.
    fn def_with(
        model: Option<&str>,
        thinking: Option<&str>,
        tools: Option<&[&str]>,
    ) -> AgentDefinition {
        AgentDefinition {
            name: "scout".to_string(),
            description: "Fast recon.".to_string(),
            model: model.map(str::to_string),
            thinking: thinking.map(str::to_string),
            tools: tools.map(|t| t.iter().map(|s| s.to_string()).collect()),
            system_prompt: "You are a scout.".to_string(),
            scope: crate::agents::AgentScope::Space,
            path: "/tmp/scout.md".to_string(),
            shadowed: Vec::new(),
        }
    }
```

**`def_with` is a direct `AgentDefinition` struct literal — B1 adding a `permission` field makes this not compile until it gains the field.** The same is true of `commands/agents.rs`'s `full_definition()` and `definition()` (§11) and the six `LaunchConfig { … }` test literals in `launch.rs` (lines 446/491/539/579/620/661 and 745/784/822/874/916 and 1020 — all use `..Default::default()` per the tests quoted in 5d/`resolve_launch_no_agent_name…`, so most survive; only the fully-specified literal at line 1397 + 1865/1934/1987 pin all fields).

### 5e. All `LaunchConfig` / `ResolvedLaunch` construction sites in the tree

`grep -rn "LaunchConfig {" src-tauri/src --include=*.rs` → **24 hits**; the non-test production ones B2 must decide about:

| File:line | Site |
|---|---|
| `src-tauri/src/bin/fake_worker.rs:509` | `launch: LaunchConfig { system_prompt, model: None, thinking: None, frontmatter_thinking: None, tools }` — **fully-specified literal; a 5th field breaks compile** (fake_worker, see §14 for the `--lib` caveat). |
| `src-tauri/src/agent/worker/dispatch.rs:169` | `LaunchConfig { system_prompt: Some(..), ..Default::default() }` — survives via `Default`. |
| `src-tauri/src/agent/interactive/mod.rs:135` | `LaunchConfig { system_prompt: params…, model:…, thinking:…, tools:… }` — **fully-specified literal; 5th field breaks compile**. |
| `src-tauri/src/agent/subagent.rs:1023` | `LaunchConfig { system_prompt: Some(..), ..Default::default() }` — survives. |
| `src-tauri/src/agent/subagent.rs:1071` | `LaunchConfig { system_prompt: Some(..), ..Default::default() }` — survives. |
| `src-tauri/src/agent/harness/launch.rs:271` | the `resolve_agent_launch` output (5c) — B2's main edit. |
| `src-tauri/src/agent/harness/launch.rs` test module | literals at 446, 491, 539, 579, 620, 661 (all `..Default::default()`), 745, 784, 822, 874, 916 (all `..Default::default()`), 1020 (`..Default::default()`), **1397, 1865, 1934, 1987 — fully-specified** (the `write_override_world`-style world-builders and the `settings_with` fixtures). |

`LaunchConfig::default()` call sites (no literal): `commands/agents.rs:245,933`, `harness/dispatch.rs:514,642,684`, `worker/manager/subagent_flow.rs:1725`, `worker/dispatch.rs:254`, `worker/protocol.rs:757,859`, and ten sites in `agent/subagent.rs` (630, 709, 767, 805, 843, 957, 1118, 1166, 1224, 1268). All survive an additive field.

`ResolvedLaunch {` construction: **exactly one site**, `agent/harness/launch.rs:270`.

---

## 6. How `LaunchConfig.tools` becomes the child's `enabled_tools` — the B2 whole-tool-deny seam

### 6a. The parent side: `resolve_launch` → `dispatch_subagent`

`agent/harness/dispatch.rs:296` (the parent's subagent tool call):

```rust
    let (launch, name_resolution) = crate::agent::harness::launch::resolve_launch(
        &launch,
        &agent_name,
        parent.catalog,
        parent.config_dir,
        parent.space_cwd,
    );
    let (dispatch_rx, cancel) = dispatcher.dispatch(
        parent.session_id,
        parent.space_cwd,
        parent.model,
        parent.enabled_tools.map(|v| v.to_vec()).unwrap_or_default(),
        agent_name,
        name_resolution,
        launch,
        task,
        parent.sink,
    );
```

`dispatcher.dispatch` is `SubagentSessionManager::dispatch_native` (`agent/subagent.rs:175`), which wraps everything into a `SubagentDispatchWire { … launch, … }` and calls `wm.dispatch_subagent_to(...)`.

### 6b. The child side: `subagent_flow.rs` step 3 (the FULL three-way rule)

`agent/worker/manager/subagent_flow.rs` lines 619–655:

```rust
    // 3. The child tool set (the FULL three-way rule — the current
    // driver's step 7, moved verbatim): `launch.tools` `Some` →
    // VERBATIM minus `subagent`/`list_agents` (a non-empty set that
    // empties out yields NO tools — NOT re-expanded);
    // `launch.tools` `None` → the parent's list minus the guard;
    // the `[]` (empty parent list) case → ALL tools minus the
    // guard (the "empty = all" expansion applies ONLY to the
    // inherited-parent case — the `parent_enabled_tools` `[]` is
    // the documented harness convention).
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

then step 5 puts it on the wire:

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
    );
```

**This is the exact seam a whole-tool `deny` must insert at (or before):** the resolved child tool list is a `Vec<String>` computed here from `wire.launch.tools`. A per-agent whole-tool deny (e.g. `task: deny` / `bash: deny`) that must *drop* the tool from the child's advertised set has two candidate insertion points:

- attach the narrowed `tools` BEFORE the wire (in `resolve_agent_launch` / `dispatch_native` so `launch.tools` is already the narrowed set), or
- pass the per-agent ruleset on the wire (a new `LaunchConfig` field) and narrow `child_tools` here, in the flow that actually renders the advertised set.

`StartEnv::from_parts(...)` (8th positional arg `Some(child_tools.clone())` is `enabled_tools`, `protocol.rs:246 pub enabled_tools: Option<Vec<String>>`). The child worker's `core.rs` applies it verbatim:

### 6c. `StartEnv.enabled_tools` → `AgentLoop.enabled_tools`

`agent/worker/core.rs:325` (production `build_loop`) and `:824` (the stub):

```rust
        // (3) The wire field IS the harness convention (`None` = all,
        // `Some(v)` = exactly `v`, `Some(vec![])` = NO tools) — applied
        // VERBATIM, NO mapping (the settings `[]` = all convention is
        // mapped at `StartEnv` CONSTRUCTION, Task 3/4; a legitimately-
        // empty child tool set must NOT re-expand into all tools — the
        // recursion guard). BEFORE the system prompt build (the
        // `advertised_specs`' `<tools>` section must match the enabled
        // set — the in-process order: `set_enabled_tools` before
        // `build_main_prompt`).
        loop_.set_enabled_tools(env.enabled_tools.clone());
```

```rust
    /// Set the enabled tools (`None` = ALL; `Some(v)` = exactly `v` —
    /// `Some(vec![])` = NO tools; a disabled tool is a tool-result
    /// error, NOT executed; finding 13b).
    pub fn set_enabled_tools(&mut self, tools: Option<Vec<String>>) {
        self.enabled_tools = tools;
    }

    /// The enabled tools (`None` = ALL — finding 13b; the
    /// `dispatch_native` driver derives the child's tool set from it).
    pub fn enabled_tools(&self) -> Option<&[String]> {
        self.enabled_tools.as_deref()
    }
```

### 6d. `is_tool_enabled` and `advertised_tool_specs` (the advertisement B2's whole-tool deny must affect)

`agent/harness/dispatch.rs:196`:

```rust
/// Whether `name` passes the `enabled_tools` filter (`None` = all enabled).
pub(crate) fn is_tool_enabled(enabled_tools: Option<&[String]>, name: &str) -> bool {
    match enabled_tools {
        Some(tools) => tools.iter().any(|t| t == effective_tool_name(name)),
        None => true,
    }
}
```

(`effective_tool_name` maps `dispatch_subagent` → `subagent`, lines 188–195.)

`agent/harness/loop.rs:1077`:

```rust
    fn advertised_tool_specs(enabled_tools: &Option<Vec<String>>, is_child: bool) -> Vec<ToolSpec> {
        tool_specs()
            .into_iter()
            .filter(|spec| {
                let enabled = match enabled_tools {
                    Some(tools) => tools.contains(&spec.name),
                    None => true,
                };
                let not_child =
                    !is_child || (spec.name != "subagent" && spec.name != "list_agents");
                enabled && not_child
            })
            .collect()
    }
```

and the `dispatch_tool` runtime filter (`agent/harness/loop/tools.rs:61–77`):

```rust
    pub(super) async fn dispatch_tool(
        &mut self,
        tc: &ToolCall,
        turn: &CancellationToken,
    ) -> ToolResult {
        // The `enabled_tools` filter (`None` = ALL — finding 13b): a
        // disabled tool is a tool-result error, NOT executed.
        // `dispatch_subagent` is an ALIAS of `subagent` (the `match`
        // below routes both to it): the gate must know the alias — a
        // parent with `enabled_tools: Some(["subagent"])` must not get
        // `tool not enabled: dispatch_subagent` when the model emits it.
        if !self.is_tool_enabled(&tc.name) {
            return ToolResult {
                content: vec![ContentBlock::Text {
                    text: format!("tool not enabled: {}", tc.name),
                }],
                details: None,
                is_error: true,
            };
        }
```

**Bottom line for B2:** the child's advertised set is already a pure function of `child_tools` (6b) → `enabled_tools` (6c) → `advertised_tool_specs` (6d). If the per-agent whole-tool `deny` lands as a *narrowing of the tools rung before the wire* (`resolve_agent_launch`'s `narrow` closure already does exactly this shape: filter names, drop unknowns, etc.), then "remove a tool from the child's advertised set" needs **zero new plumbing** — it is just another name-filter in the existing chain. The `subagent_flow` three-way rule already strips `subagent`/`list_agents`; a per-agent `task: deny` filter is the same list-operation on the same seam.

---

## 7. The policy gate (`agent/harness/loop/gate.rs`) — decision path in full

### 7a. `POLICIED_TOOLS`, `policed_direction`, `PolicyDirection` (verbatim, top of gate.rs)

```rust
/// `get_search_content` (network calls and cache reads are not filesystem
/// operations and are not policy-gated, ADR 0056), `subagent` / `mcp` /
/// `manage_todo_list` / the interactive flows (no argument of theirs reaches
/// the filesystem in a way this policy describes).
pub(super) const POLICIED_TOOLS: &[(&str, PolicyDirection)] = &[
    ("bash", PolicyDirection::Shell),
    ("read", PolicyDirection::Read),
    ("find", PolicyDirection::Read),
    ("grep", PolicyDirection::Read),
    ("ls", PolicyDirection::Read),
    ("write", PolicyDirection::Write),
    ("edit", PolicyDirection::Write),
];

/// The direction a policed tool is judged in (ADR 0030: the policy is
/// per-DIRECTION, so `read` obeys `reads` and `edit` obeys `writes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PolicyDirection {
    /// Judged against the read boundary; policy `reads`.
    Read,
    /// Judged against the session `cwd`; policy `writes`.
    Write,
    /// No path: always `beyond`; policy `shell`.
    Shell,
}

/// The tool the file-access policy judges, and in which direction
/// (`None` = ungated — the skill tools, `subagent`, `mcp`, the interactive
/// flows, everything else).
pub(super) fn policed_direction(tool: &str) -> Option<PolicyDirection> {
    POLICIED_TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, dir)| *dir)
}
```

### 7b. `decision_for` — signature and `Decision` (from `agent/policy.rs`)

```rust
/// What the GATE does with one tool call (the return of
/// [`decision_for`]) — the four outcomes of the ADR 0030 policy.
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

### 7c. `policy_verdict` (verbatim, gate.rs lines 109–192)

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

### 7d. The write-rule precedence table — `rule_or_guard_verdict` (verbatim, gate.rs lines 208–252) — **the four rows B2 must place its narrowing layer relative to**

```rust
    /// (T03 rows 1–3) The rule / guard decision for ONE resolved WRITE target,
    /// shared by `policy_verdict` (which returns the verdict) and
    /// [`Self::guard_target`] (which hands the corridor the target a guard
    /// prompt must name). `rule_for` is the ONE resolver — per `policy.rs`'s
    /// module doc, "per ADR 0029/0030's one-canonicalizer rule the gate and
    /// the executor must both go through [`crate::agent::policy::rule_for`],
    /// never a second matcher" — and the executor's twin in
    /// [`crate::agent::tools::exec::access`] consults it with the SAME list
    /// (`ToolCtx::rules`, the per-turn concat) and the SAME resolved path, so
    /// the two layers cannot decide differently about one write.
    ///
    /// The rows of the spec's precedence table:
    /// 1. a `Deny` rule → [`Decision::Deny`] — a tool-result error, and
    ///    TRUST-IMMUNE (trust suppresses prompts, never widens a deny);
    /// 2. an `Allow` rule → [`Decision::Allow`] SILENTLY (the posture select is
    ///    not reached — this is what makes an `allow-directory` answer mean
    ///    something);
    /// 3. NO rule matches AND the target is under an agent-definition dir →
    ///    [`Decision::Ask`], the guard prompt. Trust suppresses it (the spec:
    ///    "Trust suppresses the guard. A trusted Space's agent can also write
    ///    its own instruction directories without asking"), so on a trusted
    ///    Space this returns `None` and the posture select decides;
    /// 4. otherwise `None` — the caller falls through to `decision_for`.
    ///
    /// The `Option<PathBuf>` in the tuple is the resolved target of a ROW-3
    /// ask — `Some` exactly when the verdict is the guard's `Ask` — so the
    /// prompt can carry the REAL nearest-existing-ancestor instead of T02's
    /// `""` placeholder.
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

### 7e. `is_guard_path`, `rule_deny_for`, `deny_tool_result`, `guard_target`, `beyond_error` (verbatim)

```rust
    fn is_guard_path(&self, dir: PolicyDirection, resolved: &Path) -> bool {
        dir == PolicyDirection::Write
            && self.protected.iter().any(|root| resolved.starts_with(root))
    }
```

```rust
    fn rule_deny_for(
        &self,
        dir: Option<PolicyDirection>,
        path: &Path,
    ) -> Option<&crate::agent::policy::AccessRule> {
        let rdir = match dir? {
            PolicyDirection::Read => crate::agent::policy::RuleDirection::Read,
            PolicyDirection::Write => crate::agent::policy::RuleDirection::Write,
            // Rules never apply to `bash`.
            PolicyDirection::Shell => return None,
        };
        crate::agent::policy::rule_for(
            &self.rules,
            rdir,
            &crate::agent::fs_backend::canonicalize_lenient(path),
            self.rules_home.as_deref(),
        )
        .filter(|rule| rule.decision == crate::agent::policy::RuleDecision::Deny)
    }
```

```rust
    pub(super) fn guard_target(&self, tc: &ToolCall) -> Option<PathBuf> {
        if policed_direction(&tc.name)? != PolicyDirection::Write {
            return None;
        }
        let raw = tc.arguments.get("path").and_then(|v| v.as_str())?;
        let resolved = crate::agent::fs_backend::canonicalize_lenient(Path::new(raw));
        self.rule_or_guard_verdict(&resolved, self.space_trusted())?
            .1
    }
```

```rust
    pub(super) fn beyond_error(&self, dir: PolicyDirection, path: &Path) -> Option<FsError> {
        let roots = self.direction_boundary(dir);
        FsBackend { roots }.validate(path).err()
    }
```

`deny_tool_result` (lines 305–377) is long; verbatim core:

```rust
    pub(super) fn deny_tool_result(&self, tc: &ToolCall) -> ToolResult {
        let dir = policed_direction(&tc.name);
        let text = match tc.arguments.get("path").and_then(|v| v.as_str()) {
            Some(raw) => {
                let path = Path::new(raw);
                let protected = (dir == Some(PolicyDirection::Write))
                    .then(|| protected_refusal_text(&self.protected, &tc.name, path))
                    .flatten();
                match protected {
                    Some(msg) => msg,
                    None => match self.rule_deny_for(dir, path) {
                        Some(rule) => crate::agent::tools::exec::access::rule_deny_text(
                            &tc.name,
                            rule,
                            &crate::agent::fs_backend::canonicalize_lenient(path),
                        ),
                        None => self.escape_text(dir, &tc.name, path, raw),
                    },
                }
            }
            // `bash` has no path: the policy simply refused the command.
            None => format!("{}: refused by the file-access policy (Sandboxed)", tc.name),
        };
        ToolResult {
            content: vec![ContentBlock::Text { text }],
            details: None,
            is_error: true,
        }
    }
```

### 7f. The `Gate`/`AgentLoop` fields the gate reads (verbatim from `loop.rs`)

The gate is a method-set on `AgentLoop` (no separate `Gate` struct exists in this tree). The relevant fields, with line references and docs:

- `pub space_cwd: PathBuf` (line 146) — the write boundary root.
- `enabled_tools: Option<Vec<String>>` (line 214) — `None` = all; `Some(v)` = exactly `v`.
- `read_boundary: Vec<PathBuf>` (line 258) — "The session's READ boundary — `cwd` + the discovery roots … frozen for the session's life."
- `protected: Vec<PathBuf>` (line 265) — "The write GUARD-MEMBERSHIP list (`boundary::protected_dirs()` — the four user-level agent-definition dirs), frozen with the boundary. Since the permissions spec's round-3 correction this is NOT a rule set: a write under one of these with no rule matching is the guard's ROW-3 ASK, not a deny."
- `default_rules: Vec<crate::agent::policy::AccessRule>` (line 276) — "`policy::default_rules()` — EMPTY since the round-3 correction".
- `rules_home: Option<std::path::PathBuf>` (line 283) — the home `rule_for` expands `~` against.
- `rules: Vec<crate::agent::policy::AccessRule>` (line 285) — "`default_rules() ++ file_policy.rules` — defaults FIRST, the CONCATENATION CONTRACT … reassembled at the top of every `handle_prompt`".
- `file_policy: FilePolicy` (line 316) — per-turn from settings.
- `pub trust: Option<Arc<dyn TrustSource>>`, `pub sink`, `pub pending_permissions: PendingPermissions`, `pub session_id` — the ask machinery (`space_trusted`/`gate_tool`).

**B2's insertion point, stated precisely:** `policy_verdict` computes `(policy, beyond, resolved)`, consults `rule_or_guard_verdict` for WRITE only, then falls to `decision_for`. A per-agent narrowing layer (stricter-of-two with `file_policy`) has three candidate placements, in descending "least invasive":

1. **Whole-tool decision, before direction logic**: a tool-level `deny` (e.g. `task: deny`, `bash: deny`) can return `Some(Decision::Deny)` before/independent of `policed_direction` — but note `bash: deny` inside a *pattern* key set also interacts with the `Sandboxed → Confine` row (7b) — the gate's `Deny` is a tool-result error, which is the correct `deny` mapping.
2. **Pattern-level, in the same shape as `rule_for`**: an `AgentPermission` matcher consulted per-call, whose `Deny`/`Allow`/`Ask` verdict is "stricter of the two" against the posture verdict. The existing `rule_or_guard_verdict` rows 1–4 (7d) are the model to describe it against: *row 1 `Deny` is trust-immune; row 2 `Allow` is silent; row 3 is the guard ASK; row 4 falls through to the posture select*. A per-agent rule layer must define its own row order and what "stricter" means per pair (e.g. per-agent `Deny` beats posture `Allow`; posture `Deny` beats per-agent `Allow`; per-agent `Ask` vs posture `Ask` are the same; `Confine` (bash) is only producible by the posture path).
3. **Tools drop (whole-tool deny), in the resolver** — §6: a whole-tool `deny` should ALSO (per #101's brief) drop the tool from the child's `enabled_tools`, which is a §6 seam (resolve_agent_launch/`subagent_flow`), NOT a gate seam.

**Where the gate consumes the verdict** (`agent/harness/loop/turn.rs:471`):

```rust
                match self.policy_verdict(tc) {
                    Some(Decision::Ask) => {
                        let guard = self.guard_target(tc);
                        if self.gate_tool(tc, turn, guard.as_deref()).await {
                            self.dispatch_tool(tc, turn).await
                        } else {
                            ToolResult { content: vec![ContentBlock::Text {
                                text: "permission denied".to_string(),
                            }], details: None, is_error: true }
                        }
                    }
                    Some(Decision::Deny) => self.deny_tool_result(tc),
                    _ => self.dispatch_tool(tc, turn).await,
                }
```

---

## 8. `agent/policy.rs` — vocabulary and why it is NOT reused for per-agent rules

### 8a. `AccessPolicy`, `FilePolicy`, `PolicyRule`/`AccessRule`, `default_rules()` (verbatim)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AccessPolicy {
    /// Reject it (a tool-result error, never a prompt).
    Sandboxed,
    /// Prompt the user.
    Ask,
    /// Allow it silently. THE derived default — see `FilePolicy`.
    #[default]
    Allow,
}
```

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRule {
    pub path: String,
    pub direction: RuleDirection,
    pub decision: RuleDecision,
}
```

(`RuleDecision` is `Allow | Deny` — "THERE IS NO `ask` VALUE — asking is what happens when NO rule matches (the self-modification guard), never a decision a rule can carry".)

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FilePolicy {
    pub reads: AccessPolicy,
    pub writes: AccessPolicy,
    /// `bash`. Defaults to `Allow` like the others — so this field alone
    /// removes the ADR 0010 untrusted-Space prompt for `bash` unless the
    /// user sets it back to `Ask`. That is the intended product posture
    /// (pi gates nothing), not a bug to "fix" back to `Ask`.
    pub shell: AccessPolicy,
    /// User rules (`path` may lead with `~`). Serde-defaulted: an old
    /// `settings.json` without the key still parses; an EMPTY list is not
    /// serialized, so the three-direction wire shape is byte-identical to
    /// today (…).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<AccessRule>,
}
```

```rust
pub fn default_rules() -> Vec<AccessRule> {
    Vec::new()
}
```

### 8b. `decision_for` — quoted in full at §7b.

### 8c. `rule_for` and how `AccessRule` differs from a `permission:` pattern

`rule_for` (the ONE rules resolver) is quoted in full in §7d's context; its matching is: `RuleDirection` (Read/Write/ReadWrite) covers the direction; `expand_rule_path` (`~` expand); `canonicalize_lenient` BOTH sides; FILTER (component prefix) → RANK (longest canonical prefix) → TIE-BREAK (last in list). **Pattern keywords like `*` and `*.md` do not exist in `rule_for`** — it is an exact/prefix path matcher; opencode-style `*`/`*.md`/tool-key wildcards are a different (glob or plain-prefix) matcher B2 must define (likely in a new module or on `AgentDefinition.permission`).

### 8d. `Sandboxed` and Landlock — why the per-agent layer is NOT the policy vocabulary

- `AccessPolicy::Sandboxed` for `bash` yields `Decision::Confine` (7b) — "Produced ONLY for `bash`".
- The Landlock confinement lives in the `bash` executor path (`agent/harness/loop/turn.rs` comment: "the `Sandboxed` floor and confines `bash`", and `agent/harness/loop/tools.rs:111`; `deny_tool_result`'s `bash` refusal text is `"{}: refused by the file-access policy (Sandboxed)"`).
- `FilePolicy` is a **per-turn snapshot of `settings.json`** (structure `{reads,writes,shell,rules}`), while a `permission:` block is a **per-definition frontmatter value**. They have different lifetimes (turn vs dispatch), different provenance (user settings doc vs user agent file), and different shapes (three directions + path rules vs per-tool pattern maps). There is also a conflict in *who narrows whom*: `default_rules()` was deliberately emptied so the four agent-dirs guard ASK is reachable (§7d row 3), and the per-agent layer must NOT reintroduce a default deny that makes row 3 unreachable again (see `default_rules()`'s doc: "deriving the write guard-membership set from this rule set … makes the spec's row 3 … `A AND NOT A` and is unreachable"). The "stricter-of-two with the user's `filePolicy`" (B2's brief) is a **merge/decision rule to define**, not a reuse of `AccessRule`.

---

## 9. `agent/fs_backend.rs` — the canonicaliser patterns MUST be judged with

### 9a. `canonicalize_lenient` (verbatim, lines 278–288)

```rust
/// when it exists, otherwise the canonical form of its deepest existing
/// ancestor with the remaining components re-appended (the SAME peel rules
/// [`FsBackend::resolve`] runs — one implementation, see [`peel_to_existing`]).
///
/// A path that cannot be resolved at all (no existing ancestor, or a `..`
/// under a missing parent) comes back UNCHANGED: the caller then compares the
/// raw spelling, which is the best available answer for a caller that cannot
/// fail (unlike `resolve`, this has no error to return).
///
/// Idempotent on canonical input: a path that is already canonical
/// canonicalizes to itself, so passing a resolved path through here is a
/// no-op — which is what makes it safe to call from a seam shared by callers
/// that hand over raw paths and callers that hand over resolved ones.
pub(crate) fn canonicalize_lenient(path: &Path) -> PathBuf {
    match peel_to_existing(path) {
        Ok(peel) if peel.trailing.is_empty() => peel.canon,
        Ok(peel) => reapply(peel.canon, &peel.trailing),
        Err(_) => path.to_path_buf(),
    }
}
```

### 9b. `FsBackend::validate` (verbatim, lines 102–113)

```rust
    /// Canonicalize `path` and verify it stays under any root, returning the
    /// resolved path WITHOUT performing any I/O on the target itself —
    /// the validation seam the tool executors (`ls`/`find`/`grep`/image
    /// `read`) use. Same semantics as the `read`/`write` validation.
    pub fn validate(&self, path: &Path) -> Result<PathBuf, FsError> {
        self.resolve(path)
    }
```

(and the underlying `resolve`'s ADR 0029/0030 "one-canonicalizer" contract, quoted at §7/§9 — the module doc: *"the gate and the executor must both go through `rule_for`, never a second matcher"*.) The instruction to the planner is direct: **any B2 pattern matcher that canonicalizes must use `crate::agent::fs_backend::canonicalize_lenient`, exactly as `rule_for` does, so a gate precedent and an executor precedent cannot disagree about where a path lands.**

---

## 10. `agent/harness/loop.rs` — where `protected` comes from, and where per-agent rules thread in

### 10a. `AgentLoop::new` — boundary + protected + rules construction (verbatim)

```rust
        // (ADR 0030) The boundary is computed ONCE here, not per tool call
        // (it is frozen for the session, and `read_roots` walks the tree +
        // canonicalizes). Reading `$HOME` is legitimate HERE — the Worker
        // process already does it for MCP and for skill discovery.
        let read_boundary = crate::agent::boundary::read_roots(&space_cwd);
        let protected = crate::agent::boundary::protected_dirs();
        // (T03) The rule layer's frozen half. `default_rules()` goes through
        // the SAME `skills::home_dir()` chain `protected_dirs()` just walked,
        // so ONE binding serves both the rule set and the `~`-expansion home
        // `rule_for` needs — no second `$HOME` read after construction.
        let rules_home = crate::skills::home_dir();
        let default_rules = crate::agent::policy::default_rules();
```

and the struct init:

```rust
            read_boundary,
            protected,
            default_rules,
            rules_home,
            // (T03) The per-turn rule list. `Vec::new()` mirrors the
            // `file_policy` default below: the concat first runs at the top
            // of `handle_prompt`, and there is no tool call before a prompt.
            rules: Vec::new(),
            file_policy: FilePolicy::default(),
```

### 10b. The per-turn refresh + concat (`handle_prompt`, lines 660–684)

```rust
        let settings = self.config_dir.as_deref().map(crate::config::load_settings);
        self.file_policy = settings
            .as_ref()
            .map(|s| s.file_policy.clone())
            .unwrap_or_default();
        // (T03) The rules IN FORCE for this turn: the frozen defaults FIRST,
        // the user rules SECOND — the CONCATENATION CONTRACT of
        // `policy::default_rules()` (…). ONE concat per turn, next to
        // the `file_policy` re-read, so the gate and the executors judge the
        // SAME list for the whole turn and a mid-turn hand-edit lands at the
        // NEXT prompt (Deviation 4).
        self.rules = {
            let mut rules = self.default_rules.clone();
            rules.extend(self.file_policy.rules.iter().cloned());
            rules
        };
```

**Where a per-agent ruleset would thread in:** the child loop is constructed by `worker/core.rs` `build_loop` (which calls `AgentLoop::new` with fixed args and then `set_enabled_tools(env.enabled_tools)`). The gate fields live on `AgentLoop`. A per-agent `permission` set arrives on the child via the launch/wire (either pre-narrowed in `resolve_agent_launch`, or as a new `LaunchConfig`/`StartEnv` field). Two seams exist:
- **Pre-narrow in the resolver** (§5/§6): `launch.tools` is already narrowed → the gate never sees the denied tool for *whole-tool* denies; for *pattern* rules the gate still needs the ruleset, so
- **A new field on `AgentLoop`** (set right after `set_enabled_tools`, e.g. `loop_.set_permission_rules(env.permission.clone())`) ingested by `policy_verdict`/`rule_or_guard_verdict` — this mirrors the existing `set_enabled_tools`/`enabled_tools` accessor pair (10c) and the per-turn `rules` concat (10b).

### 10c. `set_enabled_tools` / `enabled_tools` (verbatim — the pattern B2's new accessor should copy)

```rust
    /// Set the enabled tools (`None` = ALL; `Some(v)` = exactly `v` —
    /// `Some(vec![])` = NO tools; a disabled tool is a tool-result
    /// error, NOT executed; finding 13b).
    pub fn set_enabled_tools(&mut self, tools: Option<Vec<String>>) {
        self.enabled_tools = tools;
    }

    /// The enabled tools (`None` = ALL — finding 13b; the
    /// `dispatch_native` driver derives the child's tool set from it).
    pub fn enabled_tools(&self) -> Option<&[String]> {
        self.enabled_tools.as_deref()
    }
```

---

## 11. `commands/agents.rs` — what widening `OverrideFields`/`SourceFields`/the DTO costs

### 11a. The three column structs + the DTO (verbatim)

```rust
/// One field-triple as the resolver or a file sees it: the three fields the
/// chain can speak about, each independently absent.
///
/// `pub` because it types a `pub` DTO field — clippy's `private_interfaces`
/// fires TRANSITIVELY down that graph and CI runs `clippy --all-targets --
/// -D warnings`, so a crate-private nested type is a build failure here, not a
/// style note.
///
/// The `Option`s are `null` on the wire (no `skip_serializing_if`) — the three
/// columns are ROWS of a report, not the stored document, and "this column has
/// no value" is information the modal renders (as `Inherits parent`) rather
/// than a state ADR 0067 forbids. The store keeps the opposite rule because
/// there, absence is the ONLY meaning of "this override does not speak".
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideFields {
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub tools: Option<Vec<String>>,
}
```

```rust
/// Which layer supplied each of the three fields (ADR 0068's label space:
/// `override` / `file` / `parent`, and NOTHING else). `pub` for the same
/// `private_interfaces` reason as [`OverrideFields`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFields {
    pub model: OverrideSource,
    pub thinking: OverrideSource,
    pub tools: OverrideSource,
}
```

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigDto {
    pub name: String,
    pub description: String,
    /// `"space" | "user"` (the `AgentScope` Display form).
    pub scope: String,
    /// The DEFINITION FILE's path (the modal prints it; `AgentDefinitionDto`
    /// deliberately omits this one).
    pub path: String,
    /// The frontmatter VERBATIM — before the filter, so the row can say what
    /// the file actually said even when none of it survived.
    pub file: OverrideFields,
    /// The stored override for this name as the SUPERVISOR read it, VERBATIM
    /// (not the resolver's output). [long doc elided]
    #[serde(rename = "override")]
    pub override_: OverrideFields,
    /// What the dispatch will launch with — produced by the resolver itself.
    pub effective: OverrideFields,
    /// Which layer supplied each of those three values.
    pub source: SourceFields,
    /// The definitions this name collision EXCLUDED (ADR 0065) — carried
    /// verbatim from `AgentDefinition::shadowed`, which is already a
    /// `Serialize`-deriving `Shadowed<AgentScope>` (camelCase, `{name, path,
    /// scope: "space"|"user"}`). REQUIRED on the wire, not `Option`: the Rust
    /// side always serializes the `Vec` (empty as `[]`), exactly like
    /// `SkillInfo::shadowed` (…). Rendered as TEXT on this row, never as rows of its own.
    pub shadowed: Vec<crate::skills::Shadowed<crate::agents::AgentScope>>,
}
```

```rust
fn file_fields(def: &AgentDefinition) -> OverrideFields {
    OverrideFields {
        model: def.model.clone(),
        thinking: def.thinking.clone(),
        tools: def.tools.clone(),
    }
}

fn stored_fields(layer: &crate::agent::harness::launch::OverrideLayer<'_>) -> OverrideFields {
    layer.global.map(OverrideFields::from).unwrap_or_default()
}

pub(crate) fn agent_config(
    settings: &Settings,
    defs: &[AgentDefinition],
    catalog: &ModelCatalog,
) -> Vec<AgentConfigDto> {
    defs.iter()
        .map(|def| {
            let layer = override_layer(Some(settings), &def.name);
            let resolved = resolve_agent_launch(&LaunchConfig::default(), def, &layer, catalog);
            AgentConfigDto {
                name: def.name.clone(),
                description: def.description.clone(),
                scope: def.scope.to_string(),
                path: def.path.clone(),
                file: file_fields(def),
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
        })
        .collect()
}
```

### 11b. What widening them costs

- `OverrideFields` is a 3-field struct with `impl From<&AgentOverrideFields>` (the persisted entry) and a `Default` used by `stored_fields`. Widening it to carry `permission` means: the `From<&AgentOverrideFields>` mapping (persisted `agentOverrides` entry has NO `permission` key today), `file_fields`, `agent_config`'s `effective` / `source`, and the `#[serde(camelCase)]` wire contract.
- `AgentConfigDto` already carries `file`/`override`/`effective`/`source`/`shadowed`. **A per-agent `permission` block is not an OverrideFields-shaped value** (it is a nested ruleset, not a `model|thinking|tools` triple), so the natural shape is a NEW DTO field (e.g. `filePermission` / `effectivePermission`) rather than widening the three columns — widening `OverrideFields` with a 4th typed value would break `the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads` (it iterates `["model","thinking","tools"]` inside each column and asserts all three are present-and-null).
- `SourceFields` is pinned to EXACTLY three layers by `the_source_label_space_is_exactly_three_layers_and_never_space` (the exhaustive `match` in the test is a compile error if `OverrideSource` gains a variant — quoted in 5b's fourth paragraph). **B2 should NOT add a `Permission` variant to `OverrideSource` unless the modal needs a per-field source column for it.**

### 11c. Which tests pin these shapes

In `commands/agents.rs`'s test module:
- `full_definition()` (line 322) — a direct `AgentDefinition { … }` literal → breaks compile on B1's new field.
- `definition(name, scope)` (line 763) — a direct `AgentDefinition { … }` literal → breaks compile on B1's new field.
- `one_row(rows)` (line 797): `assert_eq!(rows.len(), 1, "expected exactly one row: {rows:?}"); &rows[0]`.
- `agent_config_lists_a_space_level_and_a_user_level_definition_with_their_identity`
- `agent_config_and_the_dispatch_resolve_the_same_row` (the "SAME effective/source as dispatch" pin — quoted in §5/§11 context)
- `agent_config_lists_an_unmentionable_name_the_picker_hides`
- `agent_config_carries_the_shadowing_report_on_the_winning_row`
- `a_definition_with_no_collision_serializes_shadowed_as_an_empty_array`
- `the_app_scope_read_is_user_level_rows_only`
- `a_stale_pinned_model_reports_the_layer_that_won_and_still_shows_the_stale_value`
- `an_override_model_wins_and_reports_the_layer_that_supplied_it`
- `an_override_thinking_the_winning_model_lacks_is_demoted`
- `an_override_thinking_the_winning_model_advertises_is_effective`
- `the_file_column_is_verbatim_and_the_effective_column_is_filtered`
- `an_empty_override_tools_list_speaks_not`
- `the_source_label_space_is_exactly_three_layers_and_never_space`
- `the_dto_wire_shape_is_the_camel_case_contract_the_modal_reads` (iterates the column keys verbatim — quoted in §11b)
- `case_fold_twin_keys_win_wholesale_never_merged`

---

## 12. `agent/harness/loop/tests/policy_gate.rs` — protected-dir / rule-precedence pins + ALL helpers verbatim

### 12a. Tests covering protected-dir and rule-precedence wording (by name)

- `a_user_deny_rule_refuses_an_agent_dir_write_with_the_unchanged_protected_wording`
- `a_recreated_protected_dir_is_refused_by_the_gate_without_a_new_session`
- `default_posture_agent_dir_write_is_an_ask_not_a_silent_deny` (the headline churn pin — "today's hardcoded deny becomes an ask")
- `a_guard_allow_directory_runs_the_tool`
- `a_guard_allow_directory_runs_the_tool_without_a_value_payload`
- `a_guard_allow_directory_runs_the_tool_on_a_trusted_space`
- `the_guard_ask_does_not_fire_on_a_trusted_space`
- `a_rule_deny_refuses_on_a_trusted_space`
- `the_guard_prompt_end_to_end_carries_exactly_three_options_a_real_path_and_no_trust_space`
- `a_rule_naming_a_not_yet_existing_dir_matches_at_the_gate`
- `a_read_of_an_agent_definition_file_is_not_an_ask`
- `a_tilde_spelled_guarded_write_yields_an_ancestor_rule_for_matches`
- `a_settings_rule_edit_between_prompts_changes_the_next_turns_gating`
- `the_per_turn_rule_list_is_defaults_first_then_the_user_rules`
- `a_rule_deny_on_an_ordinary_dir_uses_the_rule_wording_not_an_escape_claim`
- (plus the non-rule rows:) `ask_beyond_the_boundary_prompts_naming_the_path_then_runs`, `sandboxed_beyond_the_boundary_errors_with_no_prompt`, `the_default_policy_reads_and_writes_beyond_the_boundary_in_silence`, `a_settings_edit_between_prompts_changes_the_next_turns_gating`, `a_sandboxed_shell_dispatches_confined_with_no_prompt`, `a_trusted_space_suppresses_the_prompt_the_policy_would_raise`, `the_skill_tools_stay_outside_the_policy_gate`.

### 12b. Helpers VERBATIM (a new gate test reuses all of these)

```rust
/// `handle_prompt` under a hard bound. Every policy test uses it: a
/// gate that regressed into prompting on a turn nobody answers would
/// otherwise hang the suite until the test harness timeout (a FAIL
/// pointing at the gate is the point — not a stall).
async fn bounded_prompt(loop_: &mut AgentLoop, text: &str) {
    tokio::time::timeout(
        Duration::from_secs(30),
        loop_.handle_prompt(&text_prompt(text)),
    )
    .await
    .unwrap_or_else(|_| {
        panic!("the turn never settled — a prompt nobody answered, or a tool that hung")
    });
}
```

```rust
fn policy_settings(reads: &str, writes: &str, shell: &str) -> String {
    format!(
        r#"{{ "filePolicy": {{ "reads": "{reads}", "writes": "{writes}", "shell": "{shell}" }} }}"#
    )
}
```

```rust
fn policy_settings_with_rules(reads: &str, writes: &str, shell: &str, rules: &str) -> String {
    format!(
        r#"{{ "filePolicy": {{ "reads": "{reads}", "writes": "{writes}", "shell": "{shell}", "rules": {rules} }} }}"#
    )
}
```

```rust
fn deny_rule(path: &str) -> String {
    format!(r#"[{{ "path": "{path}", "direction": "write", "decision": "deny" }}]"#)
}

fn allow_rule(path: &str) -> String {
    format!(r#"[{{ "path": "{path}", "direction": "write", "decision": "allow" }}]"#)
}
```

```rust
fn build_policy_loop(
    provider: Box<dyn Provider>,
    events: mpsc::UnboundedSender<RpcEvent>,
    sink: Arc<dyn EventSink>,
    settings: Option<&str>,
) -> (crate::test_support::ScratchDir, AgentLoop, Option<Tmp>) {
    let config_dir = settings.map(|_| Tmp::new("cfg"));
    if let (Some(dir), Some(json)) = (config_dir.as_ref(), settings) {
        std::fs::write(dir.path().join("settings.json"), json).unwrap();
    }
    let (_cfg_space, mut loop_, _db) = build_loop_with_db(
        provider,
        events,
        Arc::new(StdMutex::new(CancellationToken::new())),
        watch::channel(0u64).0,
        RetryPolicy::new_with(5, Duration::from_millis(1)),
        vec![fake_model("m1")],
        config_dir
            .as_ref()
            .map(|d| d.path().to_path_buf())
            .as_deref(),
    );
    // Swap the `TestSink` for the recording one (the field is `pub`).
    loop_.sink = sink;
    (_cfg_space, loop_, config_dir)
}
```

(`build_loop_with_db` / `text_prompt` / `fake_model` come from `agent/harness/loop/tests/support.rs` lines 282 / 400 / 500.)

```rust
fn read_call(id: &str, path: &str) -> ToolCall {
    ToolCall {
        id: id.to_string(),
        name: "read".to_string(),
        arguments: json!({ "path": path }),
    }
}
```

```rust
fn pin_guard_home(tag: &str) -> (std::sync::MutexGuard<'static, ()>, RestoreHome, Tmp) {
    let lock = crate::test_support::env_lock();
    let home = Tmp::new(tag);
    std::fs::create_dir_all(home.path().join(".pi/agent")).unwrap();
    let original = std::env::var_os("HOME");
    // SAFETY: the `ENV_LOCK` is held for the whole set→assert→restore span;
    // no other thread mutates HOME concurrently.
    unsafe { std::env::set_var("HOME", home.path()) };
    (lock, RestoreHome(original), home)
}
```

```rust
fn write_scripts(path: &str, content: &str) -> Vec<Option<Vec<ProviderEvent>>> {
    vec![
        Some(vec![
            ProviderEvent::ToolCall(ToolCall {
                id: "t1".to_string(),
                name: "write".to_string(),
                arguments: json!({ "path": path, "content": content }),
            }),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]
}
```

```rust
fn read_scripts(path: &str) -> Vec<Option<Vec<ProviderEvent>>> {
    vec![
        Some(vec![
            ProviderEvent::ToolCall(read_call("t1", path)),
            ProviderEvent::Done(FinishReason::ToolCalls),
        ]),
        Some(vec![
            ProviderEvent::TextDelta("done".to_string()),
            ProviderEvent::Done(FinishReason::Stop),
        ]),
    ]
}
```

(also `answer_permission` — quoted in §12b's read; `trust_the_space`, `permission_requests`, `tool_ends`, `answer_with_recorded_directory` are the remaining helpers at lines 134/223/235/247/998.)

B2's per-agent rows "beside them" would add a sibling test module pattern: pin a `$HOME` (guard) or not (posture), build the loop, feed a definition whose `permission:` parses, and drive `bounded_prompt` + a `ToolCall`.

---

## 13. Anything ALREADY implemented toward #101

**grep for the frontmatter concept of `permission` in the B1/B2 files is EMPTY.** `grep -rn "permission" agents.rs launch.rs subagent.rs gate.rs` returns only:

- `gate.rs`'s import `use crate::agent::permission::{native_permission_gate, permission_title, PermissionOutcome};` and the `gate_tool` machinery (the **UNRELATED UI permission gate**);
- `subagent.rs:1209–1215` doc text about the child's permission gate auto-approving on a trusted Space;
- nothing in `agents.rs`, `launch.rs`, `agent/worker/manager/subagent_flow.rs` names the frontmatter block.

**`src-tauri/src/agent/permission.rs` is the UNRELATED native UI permission gate (ADR 0010)** — its module doc: *"The native in-process permission gate (ADR 0010): turns the native `AgentLoop`'s permission requests into a UI prompt, and delivers the user's answer back to the loop."* It is the `ask`/prompt machinery (`permission_key`, `permission_title`, `permission_options(boundary)`, `native_permission_gate`, `PermissionOutcome`). **A planner must NOT wire the `permission:` frontmatter ruleset into `agent/permission.rs`** — the per-agent ruleset is a policy-input concept (parsed into `AgentDefinition`), while `agent/permission.rs` is the prompt-delivery layer. The ruleset's `Ask` verdict is *consumed* by `gate_tool` (which lives in `gate.rs` and calls `native_permission_gate`), but the module itself is not the storage/parse target.

There is also `agent/ids.rs:12 pub struct GateKey` (unrelated — the MCP/pending-permission key shape), and `tools/exec/access.rs` `rule_deny_text` + `protected_refusal_text` (executor-side wording the gate mirrors — §7e).

---

## 14. Scoped test commands + AGENTS.md facts that matter

### 14a. Rust test commands (AGENTS.md table: `cargo test` runs from `src-tauri/`)

- Full lib suite: `cargo test --lib` (from `src-tauri/`).
- Scoped module runs:
  - `cargo test --lib agents::tests` (definition parser; module path `crate::agents::tests` → filter `agents::tests`; to run one: `cargo test --lib agents::tests -- a_flat_agent_file_is_discovered_with_all_fields`)
  - `cargo test --lib agent::harness::launch::tests -- resolve_agent_launch_reports_which_layer_supplied_each_field`
  - `cargo test --lib agent::subagent::tests` (the `LaunchConfig`/dispatch pins)
  - `cargo test --lib agent::harness::loop::tests::policy_gate -- default_posture_agent_dir_write_is_an_ask_not_a_silent_deny`
  - `cargo test --lib agent::policy::tests -- decision_for` (the truth-table pin)
  - `cargo test --lib commands::agents::tests -- agent_config_and_the_dispatch_resolve_the_same_row`
- Lint: `cargo clippy --all-targets` (must be 0 warnings), `cargo fmt --check`.

### 14b. AGENTS.md facts (verbatim)

> - **`archimedes` is ONE compilation unit**, so a syntax error anywhere breaks
>   every scoped `cargo test` run: two Rust implementation tasks can never share a
>   wave. Read-only planning dispatches fan out freely. (Established with a planted
>   error, not assumed.)
> - **`cargo test --lib` does not rebuild `fake_worker`.** A stale
>   `bin/fake_worker.rs` binary surfaces as `manager::tests` failing with
>   misleading values after a protocol change; run `cargo build --all-targets`
>   first when a fixture looks like it is lying.

Both bite #101 directly: B1's `AgentDefinition` field change compiles across the WHOLE crate (the `def_with`/`full_definition`/`definition` literals in `launch.rs` and `commands/agents.rs` (§5d, §11c) fail to compile until touched, and `fake_worker.rs:509`'s fully-specified `LaunchConfig` literal is a 5th-field break that `cargo test --lib` will NOT catch because `--lib` skips the binary — a B2 protocol/launch change must be validated with `cargo build --all-targets` locally.

---

## Findings summary (the decisions B1/B2 must make, with the facts that constrain them)

1. **B1 parse seam:** `parse_agent_file` is the only reader; step 3's top-level scan can be extended with a `permission` arm that reads the *indented* descendant lines (the `is_block`-style collection loop in `parse_value` is the existing primitive — but `parse_value` itself returns `None` for an empty inline, so the block cannot ride the scalar path). The 6-tuple signature and both destructure sites change.
2. **B1 announce:** NO error channel exists — discovery is total (`Vec<AgentDefinition>` only; §4d). The only precedent for a file "announcing" something is the `Shadowed<T>` report shape (§4), additive on `AgentDefinition`/`AgentConfigDto`. Whether unknown-key announcements follow that shape or stay silent is a plan decision; "write a warning somewhere" has no existing home.
3. **Mirror statement:** any new divergence in the readers must be written in the ADR-0020/0036 language naming the upstream reader (§2) — and the `permission:` block has NO pi upstream, so the doc should say so rather than borrow pi-parity claims.
4. **B2 carry:** `LaunchConfig` gains the field (wire-additive; `Default`-derived so 31 call sites survive, 4 fully-specified literals + `fake_worker` need edits); `ResolvedLaunch` has one construction site; `resolve_agent_launch` copies `def.permission` through; `OverrideSource` must NOT gain a variant without breaking §11 pins.
5. **B2 enforce — whole-tool deny:** two independent effects — (a) *pattern gate* rows inserted into/alongside `rule_or_guard_verdict`'s 4-row table (§7d) with a defined "stricter of the two" per pair; (b) *advertised-set drop* via the §6 chain (`resolve_agent_launch`'s `narrow` filter, or `subagent_flow`'s `child_tools`), which is the actual `enabled_tools`/`advertised_tool_specs` seam. The gate does not control advertisement; the resolver/flow does.
6. **Executor parity:** any pattern matcher that touches paths must canonicalise with `canonicalize_lenient` (§9), and the executor's `access::rule_deny_text`/`protected_refusal_text` wording must stay byte-identical to the gate's (the `deny_tool_result` design makes a gate denial indistinguishable from an executor denial).
7. **Constraint from `default_rules()`:** the per-agent layer must not reintroduce default denies that make guard-row 3 unreachable (§8d), and must be a per-definition narrowing OVER the user's `filePolicy`, decided per call in `policy_verdict`.

**Sources (all in-tree):** `src-tauri/src/agents.rs`, `src-tauri/src/skills.rs`, `src-tauri/src/agent/policy.rs`, `src-tauri/src/agent/fs_backend.rs`, `src-tauri/src/agent/harness/launch.rs`, `src-tauri/src/agent/harness/loop.rs`, `src-tauri/src/agent/harness/loop/gate.rs`, `src-tauri/src/agent/harness/loop/turn.rs`, `src-tauri/src/agent/harness/loop/tools.rs`, `src-tauri/src/agent/harness/dispatch.rs`, `src-tauri/src/agent/harness/loop/tests/policy_gate.rs`, `src-tauri/src/agent/subagent.rs`, `src-tauri/src/agent/worker/manager/subagent_flow.rs`, `src-tauri/src/agent/worker/core.rs`, `src-tauri/src/agent/worker/dispatch.rs`, `src-tauri/src/agent/worker/protocol.rs`, `src-tauri/src/agent/interactive/mod.rs`, `src-tauri/src/bin/fake_worker.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/test_support.rs`, `docs/decisions/0020-native-subagent-agent-definitions.md`, `docs/decisions/0065-a-shadowed-skill-is-a-report-not-an-entry.md`, `AGENTS.md`.