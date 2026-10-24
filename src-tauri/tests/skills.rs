//! Skill discovery (skills feature, Task 1): a pure, dependency-free
//! module that finds and parses skills on disk. Mirrors the roots pi
//! scans (so the left pane matches what pi advertises in the common
//! case) and ZCode's bounded-walk + best-effort frontmatter rules.

use std::fs;
use std::path::{Path, PathBuf};

use archimedes_lib::skills::{discover_in_roots, discover_skills, space_roots, SkillScope};

/// Write one file into `dir` (creating the file's parent dirs first).
fn write_file(dir: &Path, name: &str, contents: &str) {
    let path = dir.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

/// A skill dir with a `SKILL.md` at `<root>/<name>`.
fn write_skill(root: &Path, name: &str, content: &str) {
    write_file(root, &format!("{name}/SKILL.md"), content);
}

/// The skill's row, or panic with context.
fn find_row<'a>(
    rows: &'a [archimedes_lib::skills::SkillInfo],
    name: &str,
) -> &'a archimedes_lib::skills::SkillInfo {
    rows.iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("skill {name:?} not found in {rows:?}"))
}

/// `name: alpha` + a multi-line `description: >` block (folded).
const ALPHA: &str =
    "---\nname: alpha\ndescription: >\n  a folded\n  description line\n---\nBody text here.\n";

#[test]
fn discover_in_roots_empty_and_missing_roots() {
    assert!(discover_in_roots(&[]).is_empty());
    let missing = PathBuf::from("/nonexistent/definitely/does/not/exist/skills");
    assert!(discover_in_roots(&[(missing, SkillScope::User)]).is_empty());
}

#[test]
fn discovers_a_skill_with_frontmatter() {
    let tmp = tempfile::tempdir().unwrap();
    write_skill(tmp.path(), "alpha", ALPHA);
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root.clone(), SkillScope::User)]);
    assert_eq!(rows.len(), 1);
    let s = &rows[0];
    assert_eq!(s.name, "alpha");
    assert_eq!(s.description, "a folded description line");
    assert_eq!(s.scope, SkillScope::User);
    // BOTH `path` and `dir` are canonical (a `tempdir()` path can be a
    // symlink prefix on some platforms — canonicalize the EXPECTED too).
    assert_eq!(
        s.path,
        fs::canonicalize(root.join("alpha/SKILL.md")).unwrap()
    );
    assert_eq!(s.dir, fs::canonicalize(root.join("alpha")).unwrap());
    assert_eq!(s.body, "Body text here.");
}

#[test]
fn no_frontmatter_uses_the_directory_name() {
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "gamma",
        "Just a plain body, no frontmatter at all.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root.clone(), SkillScope::User)]);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "gamma");
    assert_eq!(rows[0].description, "");
    assert_eq!(rows[0].body, "Just a plain body, no frontmatter at all.");
}

#[test]
fn quoted_and_block_values() {
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "beta",
        "---\nname: \"beta\"\ndescription: |\n  line one\n  line two\n---\nBeta body.\n",
    );
    write_skill(
        tmp.path(),
        "delta",
        "---\nname: delta\ndescription: >-\n  chomped\n  block\n---\nDelta body.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root.clone(), SkillScope::User)]);
    assert_eq!(rows.len(), 2);
    // Quoted `name` → the unquoted value.
    assert_eq!(find_row(&rows, "beta").name, "beta");
    // `|` joins with `\n`.
    assert_eq!(find_row(&rows, "beta").description, "line one\nline two");
    // `>-` (the most common real-world chomping form) keeps the `>`
    // fold semantics: joined with a single space, trimmed.
    assert_eq!(find_row(&rows, "delta").description, "chomped block");
}

#[test]
fn description_over_1024_chars_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let long = "x".repeat(1025);
    write_skill(
        tmp.path(),
        "toolong",
        &format!("---\nname: toolong\ndescription: {long}\n---\nBody.\n"),
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    assert!(
        rows.iter().all(|s| s.name != "toolong"),
        "1025-char description must be skipped: {rows:?}"
    );
}

#[test]
fn unicode_whitespace_in_block_indent_does_not_panic() {
    // Regression: the block dedent measured the leading whitespace in
    // BYTES but `trim_start` trims UNICODE whitespace (e.g. U+00A0
    // NBSP) — slicing at that byte offset can land mid-character and
    // panic. The discovery must be TOTAL: this skill is parsed (or
    // skipped), never a panic.
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "nb",
        "---\nname: nb\ndescription: |\n \u{00A0}x\n  y\n---\nB.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    // The skill is parsed with a description derived from the block
    // (the NBSP is content, not indent — only the ASCII space is).
    assert_eq!(rows.len(), 1, "skill must be listed: {rows:?}");
    assert_eq!(rows[0].name, "nb");
    assert_eq!(rows[0].description, "x\n y");
}

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
        (
            "name: a # note\ndescription: Do the thing # internal",
            "a",
            "Do the thing",
        ),
        ("name: a # note\ndescription: d", "a", "d"),
        // a quoted `#` survives; a comment after the closing quote does not
        ("name: alpha\ndescription: \"# keep\"", "alpha", "# keep"),
        ("name: alpha\ndescription: '# keep'", "alpha", "# keep"),
        ("name: alpha\ndescription: \"a # b\"", "alpha", "a # b"),
        ("name: alpha\ndescription: 'a # b'", "alpha", "a # b"),
        (
            "name: alpha\ndescription: \"a # b\" # note",
            "alpha",
            "a # b",
        ),
        ("name: alpha\ndescription: \"text\" # note", "alpha", "text"),
        ("name: \"a b\" # note\ndescription: d", "a b", "d"),
        // THE SINGLE-QUOTED SHAPE, where YAML's own escape is a DOUBLED `''`
        // and NOT a backslash. The pair is what makes these rows the interesting
        // ones: a scanner that treats every `'` as a closer ends the scalar at
        // the SECOND quote of `''`, and the tail it then tests (`s fine' # note`)
        // starts with no space-then-`#`, so the strip silently does NOTHING and
        // both quotes plus the comment reach the description. pi's
        // `yaml@2.9.0` un-doubles the pair and closes at the LAST `'`, giving
        // `it's fine`.
        (
            "name: x\ndescription: 'it''s fine' # note",
            "x",
            "it's fine",
        ),
        // …the same scalar with NO comment after it (the pair still un-doubles
        // rather than reading as a closed scalar plus junk).
        ("name: alpha\ndescription: 'it''s'", "alpha", "it's"),
        // a `#` INSIDE the doubled-quote scalar is scalar text; the comment is
        // the one that follows the REAL closing quote.
        (
            "name: alpha\ndescription: 'don''t # say' # note",
            "alpha",
            "don't # say",
        ),
        // no ASCII space/tab before the `#` ⇒ scalar text, NOT a comment
        (
            "name: alpha\ndescription: has#nospace",
            "alpha",
            "has#nospace",
        ),
        ("name: alpha\ndescription: a#b # real", "alpha", "a#b"),
        // Unicode whitespace is not a YAML separator ⇒ pi keeps the whole text
        (
            "name: alpha\ndescription: a \u{A0}# note",
            "alpha",
            "a \u{A0}# note",
        ),
        (
            "name: alpha\ndescription: a\u{A0}# note",
            "alpha",
            "a\u{A0}# note",
        ),
        (
            "name: alpha\ndescription: a \u{3000}# note",
            "alpha",
            "a \u{3000}# note",
        ),
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
        (
            "name: alpha\ndescription: a # note: with a colon",
            "alpha",
            "a",
        ),
        (
            "name: alpha\ndescription: ends with hash #",
            "alpha",
            "ends with hash",
        ),
        // a `#` after a block indicator is a comment and the BLOCK still reads
        // (pi gives `"folded line more\n"`; our block path has always trimmed —
        // the pre-existing difference `quoted_and_block_values` already pins.
        // What this row pins is that the `# note` no longer swallows the block
        // indicator itself.)
        (
            "name: alpha\ndescription: > # note\n  folded line\n  more",
            "alpha",
            "folded line more",
        ),
        // …and a `#` INSIDE a block scalar is scalar text (unchanged behaviour)
        (
            "name: alpha\ndescription: >-\n  chomped # keeps",
            "alpha",
            "chomped # keeps",
        ),
        (
            "name: alpha\ndescription: |\n  line one\n  line two",
            "alpha",
            "line one\nline two",
        ),
        // no comment at all ⇒ nothing moves
        ("name: alpha\ndescription: alpha", "alpha", "alpha"),
    ];
    for (fm, name, description) in CASES {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, "alpha", &format!("---\n{fm}\n---\nBody.\n"));
        let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
        assert_eq!(
            rows.len(),
            1,
            "case {fm:?} must still be discovered: {rows:?}"
        );
        assert_eq!(rows[0].name, *name, "case {fm:?}");
        assert_eq!(rows[0].description, *description, "case {fm:?}");
    }
}

#[test]
fn a_commented_name_keeps_the_skill_addressable_by_pis_name() {
    // Issue #11: `name: a # note` used to yield the name `a # note`. A space is
    // not a control character, so `is_tag_safe_name` ACCEPTED it and the skill was
    // discovered — but `is_mentionable_name` rejects it, so no `$` token could ever
    // address it. pi names the same file `a`, so one shared `~/.agents/skills`
    // entry had two different names across the two tools.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(
        root,
        "commented",
        "---\nname: a # note\ndescription: D\n---\nB.\n",
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        find_row(&rows, "a").name,
        "a",
        "the pi name must be the row name"
    );
    assert!(
        rows.iter().all(|s| s.name != "a # note"),
        "the comment must never reach the name: {rows:?}"
    );
}

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
    assert_eq!(
        rows.len(),
        1,
        "a 1020-char description must be listed: {rows:?}"
    );
    assert_eq!(rows[0].description, long, "{:?}", rows[0].description.len());
}

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
    write_skill(
        root,
        "glued",
        "---\nname: glued\ndescription:# glued\n---\nB.\n",
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(
        rows.len(),
        1,
        "the glued form is still read by our prefix match: {rows:?}"
    );
    assert_eq!(rows[0].description, "", "{:?}", rows[0]);
}

#[test]
fn empty_inline_name_falls_back_to_the_directory_name() {
    // Regression: `name: ""` parsed to `Some("")` and the fallback only
    // fired on `None` — an empty name broke the left-pane row.
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "gamma",
        "---\nname: \"\"\ndescription: d\n---\nB.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].name, "gamma", "empty name must fall back: {rows:?}");
}

#[test]
fn a_name_containing_a_quote_is_skipped() {
    // An unquoted inline `name: a"b` keeps the quote (the quote-strip only
    // removes ONE pair of MATCHING surrounding quotes) — and the name is
    // interpolated UNESCAPED into the injected `<skill name="…">` attribute,
    // so a `"` there would produce a malformed tag the agent mis-parses
    // → the skill is skipped, never listed.
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "q",
        "---\nname: a\"b\ndescription: d\n---\nB.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    // Each fixture holds exactly ONE skill → the skip contract is that
    // the result is EMPTY (a fallback to the directory name would keep
    // a row and fail this).
    assert!(
        rows.is_empty(),
        "a name containing a quote must be skipped: {rows:?}"
    );
}

/// Windows pins for the two quote-in-PATH tests: `"` is an ILLEGAL path
/// component on NTFS, so the fixture cannot be built (CI proved it:
/// `create_dir_all` → `Os { code: 123, kind: InvalidFilename }`). The
/// honest expectation is THAT — the quote-carrying skill path cannot exist
/// on Windows, so the discovery skip is unreachable-by-construction (the
/// skip RULE itself stays pinned on Windows through the frontmatter route,
/// `a_name_containing_a_quote_is_skipped`, which needs no illegal name).
#[cfg(windows)]
fn assert_quote_component_is_unconstructible(dir: &Path) {
    let built = fs::create_dir_all(dir.join("we\"ird/SKILL.md"));
    assert!(
        built.is_err(),
        "NTFS must REFUSE a `\"` component for this scenario to stay \
         unreachable — if this ever succeeds, delete the cfg branch and \
         run the real assertion"
    );
}

#[test]
fn a_directory_name_containing_a_quote_is_skipped() {
    // A `SKILL.md` with NO frontmatter in a directory named `we"ird`
    // (a legal Unix directory name): the directory-name fallback carries
    // the quote → the skill is skipped, never listed.
    let tmp = tempfile::tempdir().unwrap();
    // NOTE: the two cfg blocks are ALTERNATIVES (exactly one compiles per
    // platform) — no early `return` needed, and clippy on the Windows
    // runner flags one as needless.
    #[cfg(windows)]
    {
        assert_quote_component_is_unconstructible(tmp.path());
    }
    #[cfg(not(windows))]
    {
        write_skill(
            tmp.path(),
            "we\"ird",
            "Just a plain body, no frontmatter at all.\n",
        );
        let root = tmp.path().to_path_buf();

        let rows = discover_in_roots(&[(root, SkillScope::User)]);
        assert!(
            rows.is_empty(),
            "a fallback name containing a quote must be skipped: {rows:?}"
        );
    }
}

#[test]
fn a_path_containing_a_quote_is_skipped() {
    // A skill at `<root>/we"ird/SKILL.md` WITH a valid frontmatter name:
    // the name check passes, but the frontend ALSO interpolates `path`
    // UNESCAPED into the injected `<skill location="…">` attribute (and
    // `dir` into the `References are relative to DIR.` line) — the same
    // malformed-tag class the name check guards against → the skill is
    // skipped, never listed.
    let tmp = tempfile::tempdir().unwrap();
    // NOTE: the two cfg blocks are ALTERNATIVES (exactly one compiles per
    // platform) — no early `return` needed, and clippy on the Windows
    // runner flags one as needless.
    #[cfg(windows)]
    {
        // Windows: the scenario CANNOT be built — `"` is illegal in an
        // NTFS component (`create_dir_all` → ERROR_INVALID_NAME 123, which
        // is what CI's first run did, at the fixture line). So there is no
        // path-with-quote to discover: the skip is unreachable by
        // construction, and the NTFS refusal IS the platform's own
        // guarantee of the property (the helper asserts it, and fails
        // loudly if NTFS ever starts accepting the component).
        assert_quote_component_is_unconstructible(tmp.path());
    }
    #[cfg(not(windows))]
    {
        write_skill(
            tmp.path(),
            "we\"ird",
            "---\nname: foo\ndescription: d\n---\nB.\n",
        );
        let root = tmp.path().to_path_buf();

        let rows = discover_in_roots(&[(root, SkillScope::User)]);
        assert!(
            rows.is_empty(),
            "a skill whose path contains a quote must be skipped: {rows:?}"
        );
    }
}

#[test]
fn a_block_value_name_with_a_newline_is_skipped() {
    // A `|` (literal) block `name` joined with `\n`: the joined name
    // contains a control character → the skill is skipped, never listed.
    // (The `>` style would FOLD to spaces and stay clean — only `|`
    // preserves newlines.)
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "bl",
        "---\nname: |\n  line one\n  line two\n---\nB.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    assert!(
        rows.is_empty(),
        "a block name containing a newline must be skipped: {rows:?}"
    );
}

#[test]
fn a_whitespace_only_name_falls_back_to_the_directory_name() {
    // `name: "   "` parses to `Some("   ")` (non-empty) — a whitespace-only
    // name would yield a blank dialog row and an inert `$   ` insert token;
    // it must fall back to the directory name, same as an empty one.
    let tmp = tempfile::tempdir().unwrap();
    write_skill(
        tmp.path(),
        "gamma",
        "---\nname: \"   \"\ndescription: d\n---\nB.\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        rows[0].name, "gamma",
        "whitespace-only name must fall back: {rows:?}"
    );
}

#[test]
fn description_1024_cjk_chars_is_still_listed() {
    // Regression: the 1024 limit was measured in BYTES, dropping a
    // CJK description (≈3 bytes/char) at ~341 CHARS. The spec is
    // chars — 1024 CJK chars (3072 bytes) must still be listed, while
    // the 1025-ASCII-char test above proves the char limit still drops
    // over-limit descriptions.
    let tmp = tempfile::tempdir().unwrap();
    let long = "你".repeat(1024);
    write_skill(
        tmp.path(),
        "cjk",
        &format!("---\nname: cjk\ndescription: {long}\n---\nBody.\n"),
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    assert!(
        rows.iter().any(|s| s.name == "cjk"),
        "1024-CHAR (3072-byte) description must be listed: {rows:?}"
    );
    // Sanity: the description is stored in full (3072 bytes of content).
    assert_eq!(find_row(&rows, "cjk").description.len(), 3072);
}

#[test]
fn malformed_frontmatter_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    // Opening `---` but EOF before a closing `---` → malformed → skipped.
    write_skill(
        tmp.path(),
        "broken",
        "---\nname: broken\ndescription: oops\n(no closing dash line)\n",
    );
    let root = tmp.path().to_path_buf();

    let rows = discover_in_roots(&[(root, SkillScope::User)]);
    assert!(
        rows.iter().all(|s| s.name != "broken"),
        "malformed frontmatter must be skipped: {rows:?}"
    );
}

#[test]
fn walk_skips_node_modules_and_bounded_depth() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // `node_modules` is skipped entirely.
    write_skill(
        &root.join("node_modules/x"),
        "nm",
        "---\nname: nm\n---\nB.\n",
    );
    // Depth 5 → absent.
    write_skill(
        &root.join("b1/b2/b3/b4/b5"),
        "SKILL.md",
        "---\nname: deep5\n---\nB.\n",
    );
    // Depth 4 → present.
    write_file(
        &root.join("a1/a2/a3/a4"),
        "SKILL.md",
        "---\nname: kept4\n---\nB.\n",
    );
    // A `SKILL.md` directly at the root (depth 0) → absent.
    fs::write(root.join("SKILL.md"), "---\nname: atroot\n---\nB.\n").unwrap();

    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    let names: Vec<&str> = rows.iter().map(|s| s.name.as_str()).collect();
    assert!(
        !names.contains(&"nm"),
        "node_modules must be skipped: {names:?}"
    );
    assert!(
        !names.contains(&"deep5"),
        "depth 5 must be skipped: {names:?}"
    );
    assert!(
        names.contains(&"kept4"),
        "depth 4 must be present: {names:?}"
    );
    assert!(
        !names.contains(&"atroot"),
        "depth 0 must be skipped: {names:?}"
    );
}

#[cfg(unix)]
#[test]
fn symlink_dedupe() {
    // WITHIN ONE root: `b/SKILL.md` is a symlink to `a/SKILL.md`, and
    // NEITHER has frontmatter (the fallback names `a`/`b` differ — the
    // name-dedupe CANNOT hide a broken path-dedupe). The skill appears
    // ONCE, via the canonical-path `HashSet`.
    let tmp = tempfile::tempdir().unwrap();
    write_skill(tmp.path(), "a", "Body of a (via link).\n");
    // `b/SKILL.md` is a symlink to `a/SKILL.md` (b must not pre-exist).
    let a = tmp.path().join("a/SKILL.md");
    let b = tmp.path().join("b/SKILL.md");
    fs::create_dir_all(b.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&a, &b).unwrap();

    let rows = discover_in_roots(&[(tmp.path().to_path_buf(), SkillScope::User)]);
    assert_eq!(
        rows.len(),
        1,
        "symlinked SKILL.md must collapse to one row: {rows:?}"
    );
    assert_eq!(rows[0].name, "a");
    assert_eq!(rows[0].body, "Body of a (via link).");
}

#[test]
fn first_wins_dedupe_and_order() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    write_skill(
        a.path(),
        "shared",
        "---\nname: shared\ndescription: from A\n---\nA body.\n",
    );
    write_skill(
        b.path(),
        "shared",
        "---\nname: shared\ndescription: from B\n---\nB body.\n",
    );
    write_skill(a.path(), "zeta", "---\nname: zeta\n---\nZ.\n");
    write_skill(b.path(), "Beta", "---\nname: Beta\n---\nB.\n");

    // Root A first → A's `shared` shadows B's. Mixed names sort
    // case-insensitively (Beta < shared < zeta).
    let rows = discover_in_roots(&[
        (a.path().to_path_buf(), SkillScope::Space),
        (b.path().to_path_buf(), SkillScope::User),
    ]);
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(
        find_row(&rows, "shared").description,
        "from A",
        "first-wins dedupe: {rows:?}"
    );
    assert_eq!(
        find_row(&rows, "shared").shadowed.len(),
        1,
        "the shadowed loser must be reported at the integration surface: {rows:?}"
    );
    let order: Vec<&str> = rows.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(order, vec!["Beta", "shared", "zeta"]);
    assert_eq!(rows[0].scope, SkillScope::User); // `Beta` lives in root B
    assert_eq!(rows[2].scope, SkillScope::Space); // `zeta` lives in root A
}

#[test]
fn space_roots_walks_up_to_the_git_marker() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let space = repo.join("sub");
    // `repo` is the repo root (a `.git` entry); `repo/sub` is the space.
    write_file(&space, ".agents/skills/inner/SKILL.md", "inner\n");
    write_file(&repo, ".pi/skills/gamma/SKILL.md", "gamma\n");
    fs::create_dir_all(repo.join(".git")).unwrap();

    let roots = space_roots(&space);
    assert_eq!(roots.len(), 4, "{roots:?}");
    // Innermost (the space itself) first, both variants at each level.
    assert_eq!(roots[0].0, space.join(".agents/skills"));
    assert_eq!(roots[0].1, SkillScope::Space);
    assert_eq!(roots[1].0, space.join(".pi/skills"));
    assert_eq!(roots[2].0, repo.join(".agents/skills"));
    assert_eq!(roots[3].0, repo.join(".pi/skills"));
    assert!(roots.iter().all(|(_, scope)| *scope == SkillScope::Space));
    // The discovery actually walks them: the ancestor-level skill is found.
    let rows = discover_in_roots(&roots);
    assert!(rows.iter().any(|s| s.name == "gamma"), "{rows:?}");
    assert!(rows.iter().any(|s| s.name == "inner"), "{rows:?}");

    // No `.git` anywhere up the chain → only the space path itself is a level.
    let bare = tempfile::tempdir().unwrap();
    let bare_space = bare.path().join("sp");
    write_file(&bare_space, ".agents/skills/x/SKILL.md", "x\n");
    let bare_roots = space_roots(&bare_space);
    assert_eq!(bare_roots.len(), 2, "{bare_roots:?}");
    assert_eq!(bare_roots[0].0, bare_space.join(".agents/skills"));
    assert_eq!(bare_roots[1].0, bare_space.join(".pi/skills"));
}

#[test]
fn discover_skills_none_returns_only_user_scope_rows() {
    // `None` → user-level roots only. Deterministic for ANY real `HOME`
    // contents: every row must be `User`-scoped (no `Space` rows).
    let rows = discover_skills(None);
    assert!(rows.iter().all(|s| s.scope == SkillScope::User), "{rows:?}");
}

/// The `list_skills` Tauri command (Task 2): a THIN wrapper over
/// `discover_skills` — the command is `async` and takes NO `State` (a pure
/// fs read, no manager/db access), so the test is a plain direct call via
/// the `archimedes_lib` crate path (integration tests are a separate crate
/// — `crate::` would refer to the test crate, not the library).
#[tokio::test]
async fn list_skills_command_is_a_thin_wrapper() {
    // fixture: <dir>/.agents/skills/alpha/SKILL.md
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write_skill(&dir.join(".agents/skills"), "alpha", ALPHA);

    // `Some(path)` → the Task 1 discovery for that Space: the skill is
    // present and `Space`-scoped (the space root shadows any same-named
    // user skill — it is walked first).
    let rows =
        archimedes_lib::commands::skills::list_skills(Some(dir.to_str().unwrap().to_string()))
            .await
            .unwrap();
    assert_eq!(
        find_row(&rows, "alpha").scope,
        SkillScope::Space,
        "the space's skill must be Space-scoped: {rows:?}"
    );

    // `None` → user-level skills only: Ok, and every row is `User`-scoped
    // (deterministic for ANY real `HOME` contents — no `Space` rows).
    let none_rows = archimedes_lib::commands::skills::list_skills(None)
        .await
        .unwrap();
    assert!(
        none_rows.iter().all(|s| s.scope == SkillScope::User),
        "None must return user-level skills only: {none_rows:?}"
    );
}

// ── Model-hidden skills (ADR 0036) ───────────────────────────────────────
//
// `disable-model-invocation: true` in a `SKILL.md`'s frontmatter makes the
// Skill MODEL-HIDDEN: invisible to the Agent, fully available to the user.
// These tests pin the PARSING and the CARRYING only — discovery stays TOTAL
// (it is the Client's source and the `$` Mention's source), so nothing here
// may filter.

/// A minimal `SKILL.md` named `name` whose frontmatter carries `extra`
/// (one or more whole lines, inserted verbatim after `description:`).
fn skill_md(name: &str, extra: &str) -> String {
    format!("---\nname: {name}\ndescription: D\n{extra}\n---\nBody.\n")
}

#[test]
fn frontmatter_flag_hides_a_skill() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(
        root,
        "hidden",
        &skill_md("hidden", "disable-model-invocation: true"),
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0].disable_model_invocation,
        "the core boolean `true` must hide: {:?}",
        rows[0]
    );
    assert!(!rows[0].model_visible());

    // The same file WITHOUT the key is model-visible.
    let plain = tempfile::tempdir().unwrap();
    let plain_root = plain.path();
    write_skill(plain_root, "alpha", &skill_md("alpha", "license: MIT"));
    let rows = discover_in_roots(&[(plain_root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].disable_model_invocation);
    assert!(rows[0].model_visible());
}

#[test]
fn frontmatter_flag_matches_pi_yaml_bool_resolution() {
    // The truth table is whatever pi's YAML parser produces: pi parses the
    // frontmatter with its `yaml` dependency and tests
    // `frontmatter["disable-model-invocation"] === true`
    // (`dist/core/skills.js`). We mirror that resolution instead of inventing
    // a friendlier truth table, because the same `SKILL.md` must not be
    // model-hidden for one harness and advertised for the other (ADR 0036).
    //
    // HIDES — the YAML 1.2 CORE-SCHEMA booleans `true` / `True` / `TRUE`
    //   (all three spellings: 1.2 dropped YAML 1.1's `yes`/`no`, and
    //   `yaml` implements the core schema), plus any of those followed by a
    //   comment — a `#` preceded by whitespace (space OR tab) ends the plain
    //   scalar, so the comment never reaches the comparison.
    // MODEL-VISIBLE — everything the parser does NOT read as the boolean
    //   `true`: `yes` / `on` (plain strings in the core schema), `1` (a
    //   number), `"true"` / `'true'` (quoted ⇒ strings), `true#x` (no space
    //   before the `#`, so ONE plain scalar and therefore a string), an empty
    //   value (`null`), and a `>` / `|` block scalar, which folds to the
    //   string `"true\n"`.
    //
    // Every row below was checked against pi's own `yaml@2.9.0` before being
    // pinned here — INCLUDING the Unicode-whitespace rows (each is the string
    // `true…`, never the boolean, to `yaml`).
    //
    // The trailing-whitespace rows are the direction that matters: a YAML
    // plain scalar is separated by SPACE and TAB ONLY, so `true` followed by
    // U+00A0 / U+3000 / VT / FF / NEL is NOT the boolean `true` and pi KEEPS
    // the Skill model-visible. A reader that trims UNICODE whitespace (Rust's
    // bare `trim()`) reads those as `true` and HIDES them — a fail-CLOSED
    // divergence on the same file, so they are pinned as MODEL_VISIBLE here.
    const HIDES: &[&str] = &[
        "true",
        "True",
        "TRUE",
        "true # keep this out of the agent's way",
        "true\t# a tab before the comment still ends the scalar",
        "TRUE # the uppercase spelling, with a comment",
        // ASCII space / tab are the ONLY characters YAML separates a plain
        // scalar on, so the comment still ends the scalar here.
        "true ",
        "true\t",
        // A run of SPACES AND TABS before the `#` still ends the scalar (the
        // shared `strip_trailing_comment` trims the whole run, not one char).
        "true  \t  # a tab-and-space run before the comment",
    ];
    const MODEL_VISIBLE: &[&str] = &[
        "yes",
        "on",
        "1",
        "\"true\"",
        "'true'",
        "true#no-space-before-the-hash",
        ">\n  true",
        "|\n  true",
        " ",
        // NOT YAML whitespace ⇒ part of the plain scalar ⇒ a STRING to pi, so
        // pi advertises these and the desktop must too (trimming them would
        // hide a skill pi shows — ADR 0036's "mirror pi, do not invent a
        // truth table").
        "true\u{A0}",       // U+00A0 NO-BREAK SPACE
        "\u{A0}true",       // the same, leading
        "true\u{3000}",     // U+3000 IDEOGRAPHIC SPACE
        "true\u{B}",        // U+000B VERTICAL TAB
        "true\u{C}",        // U+000C FORM FEED
        "true\u{85}",       // U+0085 NEXT LINE
        "true\u{A0}# note", // an NBSP before a `#` does NOT open a comment
        // A comment-only value resolves to `null` (never the boolean), and a
        // QUOTED "true" with a comment after the closing quote is the STRING
        // `"true"` to `yaml` — the strip runs before the resolution in the
        // shared helper, so none of these hide. Pinned so the shared-helper
        // refactor cannot move a boolean.
        "# note",          // a comment-only value ⇒ no value ⇒ not `true`
        "#",               // the same, empty
        "\"true\" # note", // quoted ⇒ a STRING to yaml, comment stripped first
        "'true' # note",   // the single-quoted spelling
    ];

    for (value, expect_hidden) in HIDES
        .iter()
        .map(|v| (*v, true))
        .chain(MODEL_VISIBLE.iter().map(|v| (*v, false)))
    {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(
            root,
            "alpha",
            &skill_md("alpha", &format!("disable-model-invocation: {value}")),
        );
        let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
        assert_eq!(rows.len(), 1, "case {value:?}");
        if expect_hidden {
            assert!(
                rows[0].disable_model_invocation,
                "case {value:?} must HIDE: {:?}",
                rows[0]
            );
            assert!(!rows[0].model_visible(), "case {value:?}");
        } else {
            assert!(
                !rows[0].disable_model_invocation,
                "case {value:?} must NOT hide: {:?}",
                rows[0]
            );
            assert!(rows[0].model_visible(), "case {value:?}");
        }
    }
}

#[test]
fn frontmatter_shapes_the_tolerant_reader_does_not_model_stay_visible() {
    // ADR 0036's documented residual gap, pinned in the FAIL-OPEN direction.
    // Each shape below resolves to the BOOLEAN `true` in pi — checked against
    // pi's own `yaml@2.9.0` — so pi HIDES the skill, while the tolerant
    // reader does not model the shape at all and leaves it model-VISIBLE.
    // Accepted deliberately (the reader exists to avoid a YAML dependency),
    // and pinned here so the divergence is a documented one rather than a
    // silent surprise if the reader is ever "helpfully" extended.
    for shape in [
        // A value folded onto the next line (a plain multi-line scalar).
        "disable-model-invocation:\n  true",
        // A space before the colon: no `disable-model-invocation:` prefix.
        "disable-model-invocation : true",
        // A quoted key.
        "\"disable-model-invocation\": true",
        // The explicit-key form.
        "? disable-model-invocation\n: true",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, "alpha", &skill_md("alpha", shape));
        let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
        assert_eq!(rows.len(), 1, "shape {shape:?}");
        assert!(
            !rows[0].disable_model_invocation,
            "shape {shape:?} is the boolean `true` to pi (would HIDE) and must \
             stay model-visible here: {:?}",
            rows[0]
        );
        assert!(rows[0].model_visible(), "shape {shape:?}");
    }
}

#[test]
fn glued_colon_flag_shape_hides_where_pi_drops_the_whole_file() {
    // ADR 0036: a GLUED `disable-model-invocation:true` — NO space after the
    // colon — is the one key shape that does NOT fail open, because YAML
    // itself refuses to parse it: pi's `yaml@2.9.0` throws `MISSING_CHAR`, so
    // the frontmatter parse fails and pi skips the WHOLE `SKILL.md` — the file
    // contributes no skill to pi at all. Our `strip_prefix(
    // "disable-model-invocation:")` matches the glued key, reads the value and
    // HIDES the Skill.
    //
    // So this is an EXISTENCE divergence — the two readers disagree about
    // whether the file is a skill at all, like the duplicate-key case below —
    // and NOT a fail-open one. It therefore must NEVER join
    // `frontmatter_shapes_the_tolerant_reader_does_not_model_stay_visible`,
    // whose rows are all shapes pi HIDES and the desktop advertises. (And note
    // it is a DIFFERENT shape from the space-BEFORE-the-colon row in that
    // list: `disable-model-invocation : true` has no `disable-model-invocation:`
    // prefix at all, so it is read as no key and stays visible.)
    //
    // Pinned because the direction here is a prefix match: tightening it to
    // `"disable-model-invocation: "` (with the space) would silently make this
    // file model-VISIBLE while pi has no skill from it at all. Hence BOTH
    // assertions — the file is still discovered, and it is model-HIDDEN.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(
        root,
        "alpha",
        &skill_md("alpha", "disable-model-invocation:true"),
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(
        rows.len(),
        1,
        "the glued form is our prefix match, so the file is still read: {rows:?}"
    );
    assert!(
        rows[0].disable_model_invocation,
        "the glued form HIDES here (pi drops the file on `MISSING_CHAR`): {:?}",
        rows[0]
    );
    assert!(!rows[0].model_visible());
}

#[test]
fn duplicate_flag_key_first_occurrence_wins_in_both_directions() {
    // ADR 0036: a DUPLICATE `disable-model-invocation` key is the clearest case
    // of the two readers genuinely diverging. pi's `yaml@2.9.0` throws `DUPLICATE_KEY`
    // for BOTH orders (checked against pi's own parser), `parseFrontmatter`
    // therefore throws, and `loadSkillFromFile` returns `skill: null` — pi
    // skips the WHOLE `SKILL.md`, so the file contributes no skill to pi at
    // all. The tolerant reader is forgiving: `parse_skill_file` only reads a
    // key while its slot is still empty (`if disable.is_none()`), so the
    // FIRST occurrence wins and the skill is kept. These two rows pin which
    // occurrence wins, in both directions, so the ADR bullet cannot silently
    // re-drift: `true`-then-`false` is model-HIDDEN and `false`-then-`true`
    // is model-VISIBLE.
    //
    // Only the second row is a model-facing DISAGREEMENT. Where the first
    // occurrence is `true` the OUTCOME coincides with pi's anyway: pi
    // publishes no skill from the file at all, and a model-hidden skill is
    // equally invisible to the model. Where the first occurrence is `false`
    // the desktop ADVERTISES a skill pi refuses to parse.
    for (extra, expect_hidden) in [
        // First occurrence `true` → hidden (the outcome pi reaches too, by
        // dropping the file entirely).
        (
            "disable-model-invocation: true\ndisable-model-invocation: false",
            true,
        ),
        // First occurrence `false` → visible: the genuinely divergent order.
        (
            "disable-model-invocation: false\ndisable-model-invocation: true",
            false,
        ),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_skill(root, "alpha", &skill_md("alpha", extra));
        let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
        assert_eq!(
            rows.len(),
            1,
            "a duplicate key must not drop the file: {rows:?}"
        );
        assert_eq!(
            rows[0].disable_model_invocation, expect_hidden,
            "the FIRST occurrence of the duplicate key must win ({extra:?}): {:?}",
            rows[0]
        );
        assert_eq!(rows[0].model_visible(), !expect_hidden, "{extra:?}");
    }
}

#[test]
fn frontmatter_flag_is_ignored_when_indented() {
    // Indented lines belong to the previous key's block value, so the key
    // folded INTO a `description: >` block is prose, not a top-level key.
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(
        root,
        "alpha",
        "---\nname: alpha\ndescription: >\n  a folded line\n  disable-model-invocation: true\n---\nBody.\n",
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 1);
    assert!(
        !rows[0].disable_model_invocation,
        "an indented key is part of the block value: {:?}",
        rows[0]
    );
    assert_eq!(
        rows[0].description,
        "a folded line disable-model-invocation: true"
    );
}

#[test]
fn discovery_still_returns_model_hidden_skills() {
    // The TOTAL-DISCOVERY invariant: `discover_in_roots` is the Client's
    // source (the Skills dialog) AND the `$` Mention's source, so it must
    // never filter. This test is what stops a later change from filtering
    // at the wrong seam (ADR 0036's rejected "filter in discover_skills").
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(root, "alpha", &skill_md("alpha", "license: MIT"));
    write_skill(
        root,
        "hidden",
        &skill_md("hidden", "disable-model-invocation: true"),
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    assert_eq!(rows.len(), 2, "discovery must stay unfiltered: {rows:?}");
    assert!(find_row(&rows, "hidden").disable_model_invocation);
    assert!(find_row(&rows, "alpha").model_visible());
}

#[test]
fn skill_info_serializes_the_model_hidden_key() {
    // camelCase over IPC (the TS `SkillInfo` gains `disableModelInvocation`).
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_skill(
        root,
        "hidden",
        &skill_md("hidden", "disable-model-invocation: true"),
    );
    let rows = discover_in_roots(&[(root.to_path_buf(), SkillScope::User)]);
    let json = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(
        json.get("disableModelInvocation"),
        Some(&serde_json::json!(true))
    );
    assert!(
        json.get("disable_model_invocation").is_none(),
        "must not leak the snake_case name over IPC: {json}"
    );
}

#[test]
fn skill_info_serializes_the_shadowed_key() {
    // The other half of this contract is a TS interface (`ShadowedSkill` in
    // `src/lib/tauri.ts`) — the two halves were written against the spec, not
    // against each other, so NOTHING but this test checks the wire shape the
    // dialog reads. The dialog groups the report by the WINNER's scope and
    // words it "hidden by a project skill" vs "hidden by a global skill", so
    // BOTH the key names and the lowercase scope strings are load-bearing.
    let space = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    // The collision the report needs: same name, GENUINELY different files,
    // Space root first so the Space entry wins (mirrors
    // `first_wins_dedupe_and_order`). `solo` never collides — it pins the
    // empty case below.
    write_skill(space.path(), "shared", &skill_md("shared", "license: MIT"));
    write_skill(user.path(), "shared", &skill_md("shared", "license: ISC"));
    write_skill(space.path(), "solo", &skill_md("solo", "license: MIT"));

    let rows = discover_in_roots(&[
        (space.path().to_path_buf(), SkillScope::Space),
        (user.path().to_path_buf(), SkillScope::User),
    ]);
    assert_eq!(rows.len(), 2, "the loser stays unaddressable: {rows:?}");
    let json = serde_json::to_value(find_row(&rows, "shared")).unwrap();

    // The key is EXACTLY `shadowed` (the TS field name) and it is an array.
    let losers = json
        .get("shadowed")
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("`shadowed` must serialize as an array: {json}"));
    assert_eq!(
        losers.len(),
        1,
        "the excluded entry is reported on the winner: {json}"
    );
    let loser = &losers[0];
    // All three keys `ShadowedSkill` declares are present, and `path` is the
    // canonical path the dialog shows (a `tempdir()` path can be a symlink
    // prefix — canonicalize the EXPECTED too).
    assert_eq!(loser.get("name"), Some(&serde_json::json!("shared")));
    assert_eq!(
        loser.get("path"),
        Some(&serde_json::json!(fs::canonicalize(
            user.path().join("shared/SKILL.md")
        )
        .unwrap())),
        "{json}"
    );
    assert_eq!(
        loser.get("scope"),
        Some(&serde_json::json!("user")),
        "the TS union is `\"space\" | \"user\"`: a `rename_all` change on \
         `SkillScope` silently breaks the dialog's winner/user wording — the \
         one thing telling \"hidden by a project skill\" from \"hidden by a \
         global skill\": {json}"
    );
    // The WINNER's own scope is what the dialog groups by, so it rides the
    // same lowercase rule.
    assert_eq!(
        json.get("scope"),
        Some(&serde_json::json!("space")),
        "the winner keeps its own scope over IPC: {json}"
    );

    // The two-sided assertion (as above for `disableModelInvocation`): the
    // key is there AND no other spelling of it leaks.
    assert!(
        json.get("shadowed").is_some(),
        "`shadowed` must be present over IPC: {json}"
    );
    assert!(
        json.get("shadowed_entries").is_none(),
        "must not leak the snake_case name over IPC: {json}"
    );
    // The TOP-LEVEL key is exactly `shadowed` — the TS field name — so a
    // rename in either direction (`shadowed_entries`, `shadowedEntries`) is
    // caught here rather than only by the dialog rendering nothing.
    let mut shadow_keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .filter(|k| k.to_lowercase().contains("shadow"))
        .map(String::as_str)
        .collect();
    shadow_keys.sort_unstable();
    assert_eq!(
        shadow_keys,
        vec!["shadowed"],
        "the IPC key must be exactly `shadowed`: {json}"
    );
    // Nor inside the loser item — the TS side has no snake_case key to read.
    let leaked: Vec<&str> = loser
        .as_object()
        .unwrap()
        .keys()
        .filter(|k| k.contains('_'))
        .map(String::as_str)
        .collect();
    assert!(
        leaked.is_empty(),
        "the loser item must not leak snake_case keys over IPC: {json} (found {leaked:?})"
    );

    // The EMPTY case: a non-colliding Skill carries `shadowed: []`, NOT an
    // absent key. Load-bearing — the TS field is REQUIRED (not optional)
    // because the Rust `Vec` always serializes, and the dialog's `?? []` is a
    // FALLBACK for a payload from before the field, not the contract.
    let solo = serde_json::to_value(find_row(&rows, "solo")).unwrap();
    assert_eq!(
        solo.get("shadowed"),
        Some(&serde_json::json!([])),
        "a Shadowing-free Skill must still serialize `shadowed: []` \
         (the TS `shadowed` is required, never optional): {solo}"
    );
}
