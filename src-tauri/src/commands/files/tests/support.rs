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

/// Assert that the filesystem did NOT happen to return entries in sorted order.
pub fn assert_readdir_disagrees_with_sorted_order(dir: &std::path::Path) {
    assert!(
        !read_dir_order_is_sorted(dir),
        "the filesystem happened to return entries in sorted order, which vacates the assertion"
    );
}

pub fn rows(entries: &[CompletionEntryDto]) -> Vec<(&str, bool)> {
    entries
        .iter()
        .map(|e| (e.name.as_str(), e.is_dir))
        .collect()
}

pub fn slash_query_form(dir: &std::path::Path) -> String {
    let s = dir.to_string_lossy();
    if s.ends_with('/') {
        s.into_owned()
    } else {
        format!("{s}/")
    }
}

pub fn list_query(dir: &std::path::Path) -> String {
    slash_query_form(dir)
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
