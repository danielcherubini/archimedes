---
status: committed
parent: docs/roadmap/issue-triage-backlog-status.md
done-when: A `SKILL.md` carrying `name: a # note` / `description: Do the thing # internal`
  is discovered by the desktop under the name `a` with the description `Do the thing`
  — the same identity and the same advertised prose pi gives the same file — and the
  AGENTS.md gate is green.
---

# Issue #11 — `parse_value` strips trailing `#` comments, matching pi

**Goal:** Make `skills::parse_value` strip a trailing YAML comment from an inline
frontmatter value, so the desktop advertises exactly the text pi advertises and a
commented `name:` keeps the name `$a` can address.

**Architecture:** One new private helper in `src-tauri/src/skills.rs`,
`strip_trailing_comment(&str) -> &str`, becomes the crate's single owner of the
"a `#` ends an inline value when an ASCII space or tab introduces it, and a leading
quote is respected" rule. `parse_value`'s inline path calls it, and the
`disable-model-invocation` branch — which today carries its own hand-inlined copy of
that rule — calls the SAME helper, so the asymmetry the code comment records is
closed by construction rather than by two readers agreeing by luck. The block-scalar
path and the `: ` mapping-ambiguity guard are untouched; the "discovery is total,
never panics" contract is preserved by ASCII-space/tab arithmetic only.

**Tech Stack:** Rust 2021 (`src-tauri/`, crate `archimedes`, lib `archimedes_lib`),
`tempfile`-backed integration tests over `discover_in_roots`. No new dependencies.

---

## Parallelisation

**Verdict:** SERIAL — this plan contains exactly one task, and the parent roadmap
already forced every Rust task serial: `archimedes` is ONE compilation unit, so any
sibling's half-finished `.rs` edit breaks every other task's `cargo` verification
(measured in the parent status file by planting a syntax error in `src/skills.rs` and
watching `cargo test --lib palette` fail to compile). No `**Parallel:**` line follows;
this task runs alone.

---

### Task 1: `parse_value` strips trailing `#` comments, mirroring pi

**Context:**

`src-tauri/src/skills.rs`'s tolerant frontmatter reader has two value readers with
two different comment rules, and the difference is a real user-visible defect
(GitHub issue #11).

`parse_value`'s inline path ends `Some(inline.to_string())` and never looks at `#`.
The `disable-model-invocation:` branch in `parse_skill_file` DOES strip a comment
introduced by an ASCII space or tab. Measured against pi's own
`parseFrontmatter` → `yaml@2.9.0` (`~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js`)
on the file

    ---
    name: a # note
    description: Do the thing # internal
    ---

pi answers `{"name":"a","description":"Do the thing"}`; the desktop answers the name
`a # note` and the description `Do the thing # internal`. Two consequences, in order
of severity:

1. **Identity divergence.** A space is not a control character, so
   `is_tag_safe_name` ACCEPTS `a # note` (its own unit test
   `is_tag_safe_name_rejects_quotes_and_control_chars_only` asserts exactly that with
   `assert!(is_tag_safe_name("has space"))`) — so the skill IS discovered, but
   `is_mentionable_name` rejects it, so no `$` token can ever address it. The same
   file under `~/.agents/skills` therefore has TWO DIFFERENT NAMES across the two
   tools: `a` in pi (mentionable), `a # note` in the desktop (unaddressable).
2. **Author-only text leaks.** A `# internal note` in a description reaches the
   `<skills>` system-prompt section (`agent::harness::prompt`'s
   `format_skills_for_prompt`, which interpolates `skill.description` into
   `<description>…</description>`) and the Skills dialog.

`src-tauri/src/skills.rs` carries an `// ASYMMETRY, deliberate and SCOPED OUT:`
comment block inside the `disable-model-invocation` branch (immediately after
`disable = Some(matches!(value, "true" | "True" | "TRUE"));`) that records this exact
gap and scopes it out as "a larger and separately-reviewable change". **THIS TASK IS
THAT CHANGE.** That comment block must be rewritten in this commit — leaving it would
make the code lie about itself. It is the only place in the repo that states the
asymmetry (verified: grepping for `advertised here WITH` / `separately-reviewable`
hits only that block).

Two contracts this change must NOT break, both already documented in the file:

* **Discovery is total — never panics.** Read the comment on the block-scalar dedent
  inside `parse_value` ("ASCII spaces/tabs ONLY: `trim_start` would also trim UNICODE
  whitespace (e.g. U+00A0 NBSP, 2 bytes), making the byte offset land mid-character
  and the `&l[min..]` slice panic"). The new helper obeys the same rule. It is
  actually safer than the dedent: every slice offset it uses is the byte index of an
  ASCII `#` or a char boundary advanced by `char::len_utf8()`, so it can never land
  mid-character even by construction.
* **The glued `disable-model-invocation:true` (no space after the colon) keeps
  HIDING.** `parse_skill_file`'s doc comment and
  `glued_colon_flag_shape_hides_where_pi_drops_the_whole_file` pin it: pi's `yaml`
  throws `MISSING_CHAR` and drops the whole file, while our `strip_prefix` reads the
  key. That test must stay green untouched.

**Files:**

- Modify: `src-tauri/src/skills.rs` — new `strip_trailing_comment` helper;
  `parse_value`'s inline path + its doc comment; the `disable-model-invocation`
  branch (call the helper, rewrite the `ASYMMETRY` block).
- Modify: `src-tauri/src/agents.rs` — **doc comment only**, no behaviour change (see
  step 6; ADR 0020's "apply to BOTH copies" rule needs its carve-out recorded).
- Test: `src-tauri/src/skills.rs` → `mod tests` (the no-panic totality unit test).
- Test: `src-tauri/tests/skills.rs` (the pi-pinned truth table + the identity and
  the 1024-limit consequences).

**What to implement:**

### 1. The helper (new, private, in `src-tauri/src/skills.rs`)

Place it immediately ABOVE `parse_value` (next to it, so the reader finds the rule
where the rule is used). Signature and body — this exact code was run against every
row of the truth table below and against 21,435,888 fuzzed strings (the alphabet
`t r u e # ' ' \t " ' \\ x`, lengths 1..=8) for flag-branch equivalence, with zero mismatches:

```rust
/// A trailing `#` comment ends an inline frontmatter value, the way pi's `yaml`
/// ends a plain scalar at one (`name: a # note` is `a` to pi, not `a # note`).
///
/// A comment is introduced by an ASCII SPACE or a TAB — `has#nospace` is one plain
/// scalar, and so is anything preceded by U+00A0 / U+3000 / VT / FF / NEL, which
/// are NOT YAML separators. ASCII-only for the same reason the
/// `disable-model-invocation` branch and the block dedent give theirs:
/// `char::is_whitespace` includes NBSP, so a bare `trim()` / `trim_end()` would cut
/// text pi keeps (and, in the dedent, would slice mid-character). A `#` that OPENS
/// the value is a comment too (`description: # internal` is `null` to pi, not the
/// string `# internal`).
///
/// A LEADING QUOTE is respected: the comment only starts after the CLOSING quote,
/// so `"# keep"` survives and `"a # b" # note` is `a # b`. A double-quoted scalar
/// escapes with a backslash (`\"`); a single-quoted one does not, so the escape is
/// only consumed for `"`.
///
/// TOTAL, like every other reader here: every offset it slices at is either the
/// byte index of an ASCII `#` or a boundary advanced by `char::len_utf8()`, so it
/// can never land mid-character. An unterminated quote (pi's `yaml` throws
/// `MISSING_CHAR` / `Missing closing "quote` there and drops the file) is read as
/// an unquoted scalar — fail-open, the tolerant reader's standing direction.
fn strip_trailing_comment(inline: &str) -> &str {
    if let Some(quote) = inline.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let mut skip_next = false;
        // `.skip(1)` starts the scan AFTER the opening quote (`skip` counts
        // items, not bytes, and both quote chars are one byte).
        for (i, c) in inline.char_indices().skip(1) {
            if skip_next {
                skip_next = false;
                continue;
            }
            if quote == '"' && c == '\\' {
                skip_next = true;
                continue;
            }
            if c == quote {
                let close = i + c.len_utf8();
                let tail = &inline[close..];
                return if tail.starts_with([' ', '\t'])
                    && tail.trim_start_matches([' ', '\t']).starts_with('#')
                {
                    &inline[..close]
                } else {
                    inline
                };
            }
        }
        // No matching close quote: not a quoted scalar. Fall through and read
        // the text as the plain scalar it looks like.
    }
    match inline
        .match_indices('#')
        .find(|(i, _)| *i == 0 || inline[..*i].ends_with([' ', '\t']))
        .map(|(i, _)| i)
    {
        Some(0) => "",
        Some(i) => inline[..i].trim_end_matches([' ', '\t']),
        None => inline,
    }
}
```

Note the `match_indices(...).find(...)` shape: it must be the first `#` that is
*comment-eligible*, not the first `#`. `description: a#b # real` is `a#b` — a plain
`inline.find('#')` + guard (the flag branch's current hand-inlined form) gets that
row wrong, which is why the flag branch's inlined copy is replaced rather than
copied. (`a#b # real` is not in the flag branch's truth table, which is why the
hand-inlined form survived review there; it is in the string table below.)

### 2. `parse_value` — call it, and only there in the inline path

Inside `parse_value`, immediately after the existing `let inline = rest.trim();`
and its `if inline.is_empty() { return None; }`, insert:

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

Two shapes this ordering decides, both DECIDED and neither to "fix":

* `description: > # note` (a comment after the indicator) — pi's `yaml` folds this to
  the block's own text. The strip running first is what makes our reader agree:
  `> # note` → `>` → the block path reads the indented lines. The
  `("name: alpha\ndescription: > # note\n  folded line\n  more", …)` row of the
  table pins it.
* `description: ># note` / `description: |# note` (the indicator GLUED to the `#`) —
  pi's `yaml` THROWS here and drops the whole file, so there is no pi output to
  mirror. The strip does not fire (no space/tab before the `#`), so the reader keeps
  its existing behaviour and returns the literal `># note` / `|# note` as an inline
  value. That is fail-OPEN on a shape no hand-written `SKILL.md` carries, the same
  direction as every other gap ADR 0036 states rather than closes. Do not add a rule
  for it; do not add a test asserting pi agreement, because pi has none.

Then leave EVERYTHING ELSE in `parse_value` exactly as it is: the `|`/`>` block
match, the block collection loop, the dedent and its ASCII-only comment, the
quote-pair early return, the `: ` guard, and the final `Some(inline.to_string())`.
Do NOT move the comment strip after the `: ` guard or after the quote-pair return —
the strip has to run first so `description: a # note: with a colon` yields `a`
(pi's answer) instead of no-value, and so `"# keep"` reaches the quote-pair return
with its quotes still on it.

Do NOT touch `parse_skill_file`'s step-4b tag-safety skip, the 1024-char skip, the
`is_tag_safe_name` / `is_mentionable_name` predicates, or the fallback-to-directory
name. They are downstream and correct; only the value they receive changes.

### 3. `parse_skill_file`'s `disable-model-invocation` branch — share the helper

Replace the branch's hand-inlined comment strip

```rust
                    let value = rest.trim_matches([' ', '\t']);
                    let value = match value.find('#') {
                        // A `#` only opens a comment when a space or a tab
                        // precedes it; glued to the token it is scalar text.
                        Some(i) if value[..i].ends_with([' ', '\t']) => {
                            value[..i].trim_end_matches([' ', '\t'])
                        }
                        _ => value,
                    };
```

with

```rust
                    let value = rest.trim_matches([' ', '\t']);
                    let value = strip_trailing_comment(value);
```

Keep the long `// pi: yaml.parse(frontmatter)["disable-model-invocation"] === true`
comment block above it (the core-schema bool reasoning) and keep the
`// ASCII SPACE AND TAB ONLY, at both trims` paragraph — the helper does not do the
TRIM, so that reasoning still binds. Its closing sentence, "The same rule
`parse_value`'s dedent states for the same reason", stays TRUE and stays as written.
The one phrase in that paragraph that goes stale is its heading's `at both trims`
(after step 3 the branch has ONE trim and one shared strip): reword just that to
`ASCII SPACE AND TAB ONLY — at the trim and in the shared comment strip` and leave the
rest of the paragraph alone.

### 4. Rewrite the `ASYMMETRY` block — it now describes a bug that no longer exists

Delete the whole `// ASYMMETRY, deliberate and SCOPED OUT: …` paragraph — it starts
one line BELOW `disable = Some(matches!(value, "true" | "True" | "TRUE"));` and ends
on its own `Do not "unify" the two readers by reflex.` line (the block is the only
`// ASYMMETRY` in the file, so anchor on those two lines, not on a count) — and put
this in its place:

```rust
                    // ONE reader, deliberately: this branch and `parse_value`
                    // (which reads `name` and `description`) strip the comment
                    // through the SAME `strip_trailing_comment`, so the same
                    // `SKILL.md` cannot be advertised with different prose by the
                    // two keys. Issue #11 closed the asymmetry this branch used to
                    // document; do not re-split the rule into two copies. What
                    // still differs is the TRIM above (`trim_matches([' ', '\t'])`
                    // here, `trim()` in `parse_value`) and that is deliberate —
                    // see the ASCII-only paragraph above.
```

### 5. `parse_value`'s doc comment — state the new rule

Its first bullet currently reads
`- inline: the rest of the line, trimmed; strip one pair of matching surrounding quotes; an empty inline value means "no value".`
Extend it (keeping the bullet's style) with: *a trailing `#` comment introduced by an
ASCII space or tab is stripped first, and a `#` that opens the value makes the whole
value empty — see `strip_trailing_comment`*.

### 6. `src-tauri/src/agents.rs` — doc comment ONLY, no behaviour change

`agents.rs` carries a deliberate copy of `parse_value` and a doc comment that says a
bug in the value-reading logic "must be applied to BOTH copies" (ADR 0020). This
change does NOT apply to it, and the reason must be recorded on the spot or that
comment becomes a trap:

* `skills.rs` mirrors **pi's `yaml`-backed `parseFrontmatter`**, which strips.
* `agents.rs` mirrors the reader ADR 0020 names — pi's subagent extension
  (`pi-subagents`, `src/agents/frontmatter.ts`), which is a hand-rolled
  `/^([\w-]+):\s*(.*)$/` regex reader. **Measured:** it keeps the comment —
  `name: a # note` → `"a # note"`, `description: Do the thing # internal` →
  `"Do the thing # internal"`. Stripping in `agents.rs` would move the desktop AWAY
  from the only pi-side reader of Agent definitions, i.e. it would manufacture the
  very divergence ADR 0036 exists to prevent.

Add a short paragraph to that `parse_value` doc comment recording exactly this: the
"both copies" rule binds for *shape* bugs (the NBSP/dedent guard, the quote pair,
the `: ` guard) and does NOT bind for the trailing-comment strip, which `skills.rs`
has and `agents.rs` must not gain, because the two copies mirror different upstream
readers — with `pi-subagents`' `parseFrontmatter` named as the evidence. Change no
code in `agents.rs`.

If the reader disagrees with that scoping, the change is a one-line call to a copied
helper plus a new truth table in `src-tauri/src/agents.rs`'s `mod tests`; it is out
of scope here because it needs its own parity target decided, and issue #11 is only
about skills.

### 7. Tests — pin pi's outputs, do not invent semantics

Every expected value below was measured against pi's own `yaml@2.9.0` through
pi's own `parseFrontmatter` before being written here. Add to `src-tauri/tests/skills.rs`:

**(a) `inline_values_strip_the_comment_pi_strips`** — table-driven, one real
`SKILL.md` per row through `discover_in_roots`, using the existing `write_skill`
helper and a directory named `alpha`. Every row carries its own `name:` line, so
the fallback-to-directory-name path (`frontmatterName || parentDirName` in pi) is
never what produces the expected name here — the name comes from the frontmatter,
which is the whole point of row 1.

```rust
/// pi's own `parseFrontmatter` (`yaml@2.9.0`) outputs, pinned row by row: the
/// reader is a MIRROR of pi, not an inventor of YAML semantics (ADR 0036). Each
/// row is (frontmatter lines, expected name, expected description); `""` is pi's
/// `null` — no value — which the tolerant reader carries as an empty description.
///
/// THREE rows are rows where pi has NO SKILL AT ALL and the desktop lists one:
/// the `description: # internal` / `description: #` / `description: #glued` rows
/// resolve to `null`, and pi drops a file whose description is missing or blank
/// (`core/skills.js`: `hasDescription = typeof description === "string" &&
/// description.trim() !== ""`, then `if (!isDeclaredSkill && !hasDescription)
/// return { skill: null }`). The desktop has never had a description-required
/// skip, and this task does NOT add one — closing that gap is a separate,
/// larger parity decision (it would DROP skills, the fail-CLOSED direction,
/// where every other documented divergence here fails open). The rows pin the
/// PARSING (`""`, not `# internal`), which is what changed; the extra row pi
/// does not have is pre-existing and is what `no_frontmatter_uses_the_directory_name`
/// already tolerates.
#[test]
fn inline_values_strip_the_comment_pi_strips() {
    const CASES: &[(&str, &str, &str)] = &[
        // the exact file from issue #11
        ("name: a # note\ndescription: Do the thing # internal", "a", "Do the thing"),
        ("name: a # note\ndescription: d", "a", "d"),
        // a quoted `#` survives; a comment after the closing quote does not
        ("name: alpha\ndescription: \"# keep\"", "alpha", "# keep"),
        ("name: alpha\ndescription: '# keep'", "alpha", "# keep"),
        ("name: alpha\ndescription: \"a # b\"", "alpha", "a # b"),
        ("name: alpha\ndescription: 'a # b'", "alpha", "a # b"),
        ("name: alpha\ndescription: \"a # b\" # note", "alpha", "a # b"),
        ("name: alpha\ndescription: \"text\" # note", "alpha", "text"),
        ("name: \"a b\" # note\ndescription: d", "a b", "d"),
        // no ASCII space/tab before the `#` ⇒ scalar text, NOT a comment
        ("name: alpha\ndescription: has#nospace", "alpha", "has#nospace"),
        ("name: alpha\ndescription: a#b # real", "alpha", "a#b"),
        // Unicode whitespace is not a YAML separator ⇒ pi keeps the whole text
        ("name: alpha\ndescription: a \u{A0}# note", "alpha", "a \u{A0}# note"),
        ("name: alpha\ndescription: a\u{A0}# note", "alpha", "a\u{A0}# note"),
        ("name: alpha\ndescription: a \u{3000}# note", "alpha", "a \u{3000}# note"),
        // a TAB introduces a comment exactly like a space
        ("name: alpha\ndescription: a\t# note", "alpha", "a"),
        ("name: alpha\ndescription: value\t", "alpha", "value"),
        // a `#` that opens the value ⇒ the whole value is a comment ⇒ no value
        ("name: alpha\ndescription: # internal", "alpha", ""),
        ("name: alpha\ndescription: #", "alpha", ""),
        ("name: alpha\ndescription: #glued", "alpha", ""),
        // the FIRST comment-eligible `#` wins, and the `: ` guard must not fire
        // on the stripped value
        ("name: alpha\ndescription: a #b # c", "alpha", "a"),
        ("name: alpha\ndescription: a # note: with a colon", "alpha", "a"),
        ("name: alpha\ndescription: ends with hash #", "alpha", "ends with hash"),
        // a `#` after a block indicator is a comment and the BLOCK still reads
        ("name: alpha\ndescription: > # note\n  folded line\n  more", "alpha", "folded line more"),
        // …and a `#` INSIDE a block scalar is scalar text (unchanged behaviour)
        ("name: alpha\ndescription: >-\n  chomped # keeps", "alpha", "chomped # keeps"),
        ("name: alpha\ndescription: |\n  line one\n  line two", "alpha", "line one\nline two"),
        // no comment at all ⇒ nothing moves
        ("name: alpha\ndescription: alpha", "alpha", "alpha"),
    ];
    for (fm, name, description) in CASES {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, "alpha", &format!("---\n{fm}\n---\nBody.\n"));
        let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
        assert_eq!(rows.len(), 1, "case {fm:?} must still be discovered: {rows:?}");
        assert_eq!(rows[0].name, *name, "case {fm:?}");
        assert_eq!(rows[0].description, *description, "case {fm:?}");
    }
}
```

Two rows are worth a comment in the test body because they look wrong and are not:

* the `> # note` row expects the FOLDED block text. pi gives
  `"folded line more\n"`; the desktop's block path has always trimmed, which is the
  pre-existing difference `quoted_and_block_values` already pins — this change does
  not touch it, it only stops the `# note` from being read as the block indicator's
  own value.
* `"name: \"a b\" # note"` yields the name `a b`, which `is_tag_safe_name` accepts
  and `is_mentionable_name` rejects. That is pi's answer too (pi only WARNS on an
  invalid name), and it is the pre-existing documented divergence at step 4b — not
  something this task fixes.

**(b) `a_commented_name_keeps_the_skill_addressable_by_pis_name`** — the identity
consequence, stated as the thing the user actually loses. This is the test that
proves issue #11 is fixed:

```rust
#[test]
fn a_commented_name_keeps_the_skill_addressable_by_pis_name() {
    // Issue #11: `name: a # note` used to yield the name `a # note`. A space is
    // not a control character, so `is_tag_safe_name` ACCEPTED it and the skill was
    // discovered — but `is_mentionable_name` rejects it, so no `$` token could ever
    // address it. pi names the same file `a`, so one shared `~/.agents/skills`
    // entry had two different names across the two tools.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(root, "commented", "---\nname: a # note\ndescription: D\n---\nB.\n");
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(find_row(&rows, "a").name, "a", "the pi name must be the row name");
    assert!(
        rows.iter().all(|s| s.name != "a # note"),
        "the comment must never reach the name: {rows:?}"
    );
}
```

**(c) `a_commented_description_no_longer_pushes_a_skill_over_the_1024_limit`** — the
strip only ever SHORTENS, so it can only ever UN-skip a skill, never skip one. Pin
the one direction where the fix changes discovery, in pi's favour:

```rust
#[test]
fn a_commented_description_no_longer_pushes_a_skill_over_the_1024_limit() {
    // 1020 chars + ` # internal note` is 1036 CHARS to the old reader, so the
    // 1024-char skip dropped a skill pi advertises (pi's own description is 1020).
    // Stripping the comment first is what makes the two agree.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let long = "x".repeat(1020);
    write_skill(
        root,
        "edge",
        &format!("---\nname: edge\ndescription: {long} # internal note\n---\nB.\n"),
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1, "a 1020-char description must be listed: {rows:?}");
    assert_eq!(rows[0].description, long, "{:?}", rows[0].description.len());
}
```

**(d) `glued_colon_description_is_a_value_not_a_comment`** — the glued-colon shape on
the STRING side, so the strip is not mistaken for "a `#` anywhere after a colon is a
comment":

```rust
#[test]
fn glued_colon_description_is_a_value_not_a_comment() {
    // `description:# glued` (no space after the colon) is where pi's `yaml` throws
    // `MISSING_CHAR` and drops the WHOLE file — the same EXISTENCE divergence the
    // glued flag shape has (`glued_colon_flag_shape_hides_where_pi_drops_the_whole_file`),
    // reached here through `strip_prefix("description:")`. We keep the file, and the
    // `#` now opens a comment, so the description is EMPTY (matching what pi's
    // `description: # glued` resolves to) rather than the literal `# glued`.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(root, "glued", "---\nname: glued\ndescription:# glued\n---\nB.\n");
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1, "the glued form is still read by our prefix match: {rows:?}");
    assert_eq!(rows[0].description, "", "{:?}", rows[0]);
}
```

**(e) Extend the EXISTING flag truth table**
`frontmatter_flag_matches_pi_yaml_bool_resolution` rather than only mirroring it —
this proves the refactor in step 3 cannot move a boolean. Add to its `HIDES` array:

```rust
        "true  \t  # a tab-and-space run before the comment",
```

and to its `MODEL_VISIBLE` array:

```rust
        "# note",             // a comment-only value ⇒ no value ⇒ not `true`
        "#",                  // the same, empty
        "\"true\" # note",    // quoted ⇒ a STRING to yaml, comment stripped first
        "'true' # note",      // the single-quoted spelling
```

FIVE rows total (one + four). Every one was measured against pi's `yaml`:
`"true" # note` and `'true' # note` resolve to the STRING `"true"` (so `=== true` is
false ⇒ model-visible), a comment-only value resolves to `null`, and the
space-and-tab run before the `#` still ends the scalar ⇒ the boolean `true`. Keep the existing `"true\u{A0}# note"` row exactly where it is —
it is the NBSP mirror the issue names, and it must stay green through the refactor.

**(f) The no-panic unit test**, in `src-tauri/src/skills.rs`'s `mod tests` (which
already does `use super::*`, so it can call the private `parse_value`):

```rust
#[test]
fn parse_value_is_total_over_multibyte_whitespace_and_hashes() {
    // Discovery never panics (the same contract the block-dedent comment protects):
    // every offset `strip_trailing_comment` slices at is an ASCII `#` index or a
    // boundary advanced by `char::len_utf8()`, never a mid-character byte.
    for rest in [
        " a \u{A0}# note",
        " a\u{A0}# note",
        " \u{1F600}#\u{1F600}",
        " a \u{3000}# x",
        " a \u{B}# x",
        " \"a \\\" # b\"",
        " \"unclosed # keep",
        " #",
        " \"",
        " a\t# b",
    ] {
        let _ = parse_value(&[], 0, rest); // totality: whatever it returns, it must not panic
    }
    assert_eq!(parse_value(&[], 0, " a # note").as_deref(), Some("a"));
    assert_eq!(parse_value(&[], 0, " \u{1F600}#\u{1F600}").as_deref(), Some("\u{1F600}#\u{1F600}"));
    assert_eq!(parse_value(&[], 0, " \"# keep\"").as_deref(), Some("# keep"));
    assert_eq!(parse_value(&[], 0, " # note").as_deref(), None);
}
```

**What NOT to change:**

* Do not add a YAML dependency, and do not make the reader learn anchors, tags,
  folded multi-line scalars, or quoted KEYS. ADR 0036 states those fail-OPEN gaps as
  accepted; closing them is not this task.
* Do not touch `is_tag_safe_name`, `is_mentionable_name`, step 4b, the 1024-char
  skip, `format_skills_for_prompt`, `src/lib/skills.ts`, or the Skills dialog. The
  frontend never parses frontmatter (verified: `src/lib/skills.ts` only parses
  `<skill>` blocks out of transcript text), so there is no TS side to this fix.
* Do not change `src-tauri/src/agents.rs`'s code, and do not change
  `src-tauri/tests/skill_tools_boundary.rs` (its `write_skill` fixture emits
  `name: {name}` with no comment, so it is unaffected).
* Do not edit `docs/decisions/0020-*` or `docs/decisions/0036-*`. `docs/decisions/`
  is append-only (stated in 0022, 0033, 0036, 0049, 0057, 0062). 0036's flag truth
  table is unchanged by this work; nothing in it claims `parse_value` leaves comments
  in, so it does not need an amendment.
* Do not "improve" the block-scalar path, the quote-pair rule, or the `: ` guard.

**Steps:**

- [ ] Read, in this order, before typing anything: `parse_value` and its doc comment,
      the block-dedent comment inside it, the `disable-model-invocation` branch and
      its three comment blocks (the `pi: yaml.parse…` one, the `ASCII SPACE AND TAB
      ONLY` one, the `ASYMMETRY` one), `parse_skill_file`'s doc comment, and in
      `src-tauri/tests/skills.rs` the tests `quoted_and_block_values`,
      `unicode_whitespace_in_block_indent_does_not_panic`,
      `frontmatter_flag_matches_pi_yaml_bool_resolution`,
      `glued_colon_flag_shape_hides_where_pi_drops_the_whole_file`,
      `empty_inline_name_falls_back_to_the_directory_name`,
      `a_name_containing_a_quote_is_skipped`,
      `description_over_1024_chars_is_skipped`.
- [ ] Write tests (a)–(f) FIRST, in `src-tauri/tests/skills.rs` and `src-tauri/src/skills.rs`'s `mod tests`.
- [ ] Run, from `src-tauri/`: `cargo test --test skills`
  - Expected RED: `inline_values_strip_the_comment_pi_strips` fails on the very first
    row with `assertion \`left == right\` failed` / `case "name: a # note\ndescription:
    Do the thing # internal"` and `left: "a # note"`, plus failures in (b), (c), (d)
    and (f). If (b) or (c) PASSES before you have changed any code, stop and
    investigate — you are not reproducing the defect.
  - Expected RED too, and this is the ONLY expected red that is not the defect:
    `glued_colon_description_is_a_value_not_a_comment` (d) asserts
    `description == ""` and today reads `"# glued"`.
  - Expected still GREEN at this point: everything pre-existing, including
    `glued_colon_flag_shape_hides_where_pi_drops_the_whole_file`,
    `frontmatter_flag_matches_pi_yaml_bool_resolution` — its four new rows in (e) are
    green BEFORE the change too (`"# note"` / `"#"` read today as a literal non-`true`
    value, and `"true" # note` already has its comment stripped by the inlined copy),
    so they are RED-FREE by design: they exist to prove step 3's refactor moves nothing
    — `quoted_and_block_values`, and
    `unicode_whitespace_in_block_indent_does_not_panic`.
- [ ] Implement steps 1–2 (the helper + the `parse_value` call + its doc comment).
- [ ] Run `cargo test --test skills`
  - (a)–(d) and (f) must now pass. If a row disagrees with its expectation here, the
    row is NOT negotiable — re-measure it against pi (`node -e` importing `yaml` from
    `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/yaml`, or
    `parseFrontmatter` from `…/pi-coding-agent/dist/utils/frontmatter.js`) and fix the
    CODE, not the expectation. Only if pi itself disagrees with the table above is the
    table wrong, and then say so in the commit body.
- [ ] Implement step 3 (the flag branch calls the helper) and step 4 (rewrite the
      `ASYMMETRY` block).
- [ ] Run `cargo test --test skills` and `cargo test --lib skills`
  - `frontmatter_flag_matches_pi_yaml_bool_resolution` and
    `glued_colon_flag_shape_hides_where_pi_drops_the_whole_file` must both be green.
    A red flag test here means the shared helper moved a boolean — it must not; the
    two forms were proven equivalent over 21.4M fuzzed strings, so a difference is a typo.
- [ ] Implement step 5 (`parse_value`'s doc comment) and step 6 (`agents.rs`'s doc
      comment — text only).
- [ ] `cargo fmt --all` (from `src-tauri/`). There is no `rustfmt.toml` anywhere in
      the repo, so DEFAULTS apply — and the helper as written above is already
      rustfmt-clean (verified with `rustfmt --edition 2021 --check` on it in
      isolation, on the pinned 1.99.0 toolchain `rust-toolchain.toml` names). If
      `cargo fmt --all` reformats files this task did not touch, you have a stray
      edit — undo it rather than committing a drive-by reformat.
- [ ] `cargo fmt --all -- --check` — exit 0. (CI runs exactly this, `.github/workflows/ci.yml`'s
      `cargo fmt` step; AGENTS.md writes it as `cargo fmt --check`, same gate.)
- [ ] `cargo clippy --all-targets -- -D warnings` — 0 warnings (CI's exact form; the
      AGENTS.md bar). The helper as written is clippy-clean under the pinned 1.99.0
      (verified in isolation). If clippy suggests `manual_strip` / a rewrite of the
      scan loop that changes behaviour, do not take it — restructure and re-run the
      tests.
- [ ] `cargo test` (the whole crate) — 0 failures. Baseline at `a6e3f02` was 1355
      passed / 0 failed / 4 ignored; this task adds FOUR integration tests
      ((a)–(d)) and ONE unit test ((f)), and extends the existing
      `frontmatter_flag_matches_pi_yaml_bool_resolution` in place — so expect 1360
      passed / 4 ignored.
- [ ] From the repo root: `pnpm test` and `pnpm build` — both green (nothing here
      touches the frontend; these prove no accidental cross-edit).
- [ ] Commit BY PATHSPEC, exactly the THREE files this plan names:
      `git add src-tauri/src/skills.rs src-tauri/src/agents.rs src-tauri/tests/skills.rs`
      then
      `git commit -m "fix(skills): parse_value strips trailing # comments, matching pi (#11)"`
      (`src-tauri/src/skills.rs` appears in BOTH the Modify and the Test list — one
      file carrying both the code and the unit test.) Before committing, `git status
      --short` must show nothing staged beyond those three; in particular do NOT
      stage `docs/roadmap/issue-triage-backlog-status.md` — the loop's orchestrator
      owns that file and this plan.

**On scoped verification (this roadmap's constraint):** the implementation child will
be told to verify scoped, e.g. `cargo test --test skills` or `cargo test --lib skills`
(both measured green on the untouched tree: 29 and 39 tests respectively). Know that
`archimedes` is a SINGLE COMPILATION UNIT — `src-tauri/src/skills.rs` and
`src-tauri/tests/skills.rs` both link the whole `archimedes_lib` crate — so a "scoped"
cargo run still compiles the entire crate and still fails to compile if any other file
in the tree is mid-edit. That is FINE here precisely because this task runs ALONE
(serial, no sibling editing), and it is exactly why it runs alone: a scoped run is a
whole-crate signal, so two Rust tasks can never share a wave. Do not read a scoped
run's success as "only skills.rs was compiled", and do not widen it into a wave.

**Acceptance criteria:**

- [ ] `cargo test --test skills` passes, including
      `inline_values_strip_the_comment_pi_strips` and
      `a_commented_name_keeps_the_skill_addressable_by_pis_name`. **This is the
      criterion that proves issue #11 done**: the issue's own fixture file is
      discovered under the name `a` with the description `Do the thing`, read through
      the real `discover_in_roots` entry point — i.e. the desktop's identity and
      advertised prose for a shared `~/.agents/skills` file now equal pi's, so `$a`
      addresses the same skill in both tools and no `# internal note` reaches the
      `<skills>` section.
- [ ] `glued_colon_flag_shape_hides_where_pi_drops_the_whole_file` and
      `frontmatter_flag_matches_pi_yaml_bool_resolution` (now with its five added
      rows) are green: the shared helper did not move a single boolean.
- [ ] `unicode_whitespace_in_block_indent_does_not_panic`,
      `quoted_and_block_values`, `a_name_containing_a_quote_is_skipped`,
      `empty_inline_name_falls_back_to_the_directory_name` and
      `description_over_1024_chars_is_skipped` are all green untouched — no existing
      reader behaviour moved except the comment strip itself.
- [ ] The `// ASYMMETRY, deliberate and SCOPED OUT` block is GONE from
      `src-tauri/src/skills.rs` — `grep -n "deliberate and SCOPED OUT\|separately-reviewable"
      src-tauri/src/skills.rs` returns nothing — replaced by the one-reader note. (The
      replacement text uses the lowercase word "asymmetry" to say the gap is closed;
      that is intended and is not what this grep looks for.)
- [ ] `src-tauri/src/agents.rs`'s `parse_value` doc comment records why the
      "apply to BOTH copies" rule does not bind for the comment strip, and
      `git diff --stat` shows `agents.rs` changed in comments only (no line of
      executable code differs).
- [ ] The AGENTS.md gate is green: `cargo test`, `cargo clippy --all-targets` (0
      warnings), `cargo fmt --check` from `src-tauri/`; `pnpm test`, `pnpm build` from
      the repo root.
