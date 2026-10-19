//! Shared test fixtures and utilities for files tests.

use crate::commands::files::CompletionEntryDto;

/// Names the composer's `?` grammar cannot carry, so neither walk may offer
/// them: `?` (a second `?` annihilates the token instead of ending it) and a
/// newline (which also terminates the message).
pub const UNGRAMMATABLE: [&str; 2] = ["we?ird.md", "bad\nname.md"];

/// A fresh temp dir for one test (the same pattern the `read_file_bytes`
/// tests below use).
pub fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("files-cmd-test-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn touch(dir: &std::path::Path, rel: &str) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, b"x").unwrap();
}

/// Write `contents` to `dir/rel`, creating parent directories (`touch`
/// writes a fixed body; these fixtures need rule FILES whose contents ARE
/// the rule).
pub fn write(dir: &std::path::Path, rel: &str, contents: &str) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

/// Make `dir` a git repository for fixture purposes: an EMPTY `.git`
/// DIRECTORY.
pub fn git_repo(dir: &std::path::Path) {
    std::fs::create_dir_all(dir.join(".git")).unwrap();
}

/// Did `std::fs::read_dir` on `dir` happen to return entry names in sorted order?
pub fn read_dir_order_is_sorted(dir: &std::path::Path) -> bool {
    let names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    let mut sorted = names.clone();
    sorted.sort();
    names == sorted
}

/// Assert the fixture's raw enumeration order DISAGREES with the alphabetical
/// order `sort_by_file_name` imposes — the premise every "the survivors are the
/// alphabetically first" assertion below depends on — and say so out loud on
/// the one platform where the premise cannot be established.
///
/// WHY IT CANNOT BE ESTABLISHED ON WINDOWS: NTFS enumerates a directory in its
/// B-tree index order, i.e. already sorted, so `readdir` cannot disagree with
/// the walker's sort no matter how the files are created (measured on
/// windows-latest: the guard fired for both cap fixtures). Linux (tmpfs/ext4,
/// insertion-hash / reversed order) and macOS (APFS) do disagree, so the
/// premise holds and is asserted there. Skipping it on Windows makes the
/// survivor-order assertion VACUOUS there — stated, not hidden — and the
/// determinism claim stays pinned on every other platform. The alternative was
/// to delete the guard and let the test pass for the wrong reason silently,
/// which is exactly what the guard was written against.
pub fn assert_readdir_disagrees_with_sorted_order(dir: &std::path::Path) {
    if !read_dir_order_is_sorted(dir) {
        return;
    }
    // `cfg!` is a COMPILE-time constant, so this reads as a per-platform
    // guard rather than an `assert!` on a constant (which clippy 1.99
    // rejects, and which a `const { assert!(…) }` would make a COMPILE
    // error on every unix build — the wrong shape for a runtime premise).
    #[cfg(unix)]
    panic!(
        "test setup: this filesystem already returns readdir in alphabetical order, so the layout cannot discriminate"
    );
    #[cfg(not(unix))]
    eprintln!(
        "note: readdir here is already alphabetical (NTFS index order), so the \
         survivor-ORDER half of this fixture is vacuous on this platform; the \
         survivor-COUNT and `truncated` halves still run"
    );
}

pub fn rows(entries: &[CompletionEntryDto]) -> Vec<(&str, bool)> {
    entries
        .iter()
        .map(|e| (e.name.as_str(), e.is_dir))
        .collect()
}

/// `abs_to_slash` exists: a directory row on Windows inserts `C:/Users/you/…`
/// so the NEXT token is still formable. `dir.to_string_lossy()` is the other
/// spelling: on Windows the platform's own temp root renders
/// `C:\Users\runneradmin\AppData\Local\Temp`, and a query built from it fails
/// `expand_completion_root`'s drive-root byte test (`bytes[2] == b'/'`), which
/// returns `None`, and `completion_dir` honestly answers `(empty, false)`.
/// Every `[]` in the Windows run of this module came from here, not from the
/// walker.
///
/// So the FIXTURE was wrong, not the product: it handed the engine a shape its
/// documented contract says no caller can produce, and then read the refusal as
/// an empty listing. The substitution is a BYTE test mirroring the product's own
/// drive-root arm — no `cfg!`, so Linux and macOS take the `else` branch
/// untouched (their temp roots are `/`-rooted and already carry `/`), and only a
/// drive-letter-with-backslashes spelling is rewritten.
pub fn slash_query_form(dir: &std::path::Path) -> String {
    let raw = dir.to_string_lossy().into_owned();
    let bytes = raw.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        raw.replace('\\', "/")
    } else {
        raw
    }
}

/// A `completion_dir` query meaning "list `dir` itself": an absolute path
/// plus the trailing separator the grammar puts there (no trailing `/` means
/// "list the parent", which is a different test).
pub fn list_query(dir: &std::path::Path) -> String {
    format!("{}/", slash_query_form(dir))
}

pub fn os_allows_grammar_hostile_name() -> bool {
    cfg!(unix)
}

pub fn ungrammatical_fixture(tag: &str) -> std::path::PathBuf {
    let root = tmp_dir(tag);
    touch(&root, "keep.md");
    touch(&root, "normal.rs");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    touch(&root, "docs/ok.md");
    touch(&root, "a file with spaces.md");
    if os_allows_grammar_hostile_name() {
        touch(&root, UNGRAMMATABLE[0]);
        touch(&root, UNGRAMMATABLE[1]);
        touch(&root, "wei?rd/inner.md");
    }
    root
}
