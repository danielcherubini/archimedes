use super::support::{
    assert_readdir_disagrees_with_sorted_order, git_repo, tmp_dir, tmpfs_dir, touch,
    ungrammatical_fixture, write,
};
use crate::commands::files::{collect_files, list_space_files};

#[test]
fn collect_files_lists_nothing_when_the_root_is_a_file() {
    let dir = tmp_dir("root-is-file");
    let file = dir.join("not-a-space.txt");
    std::fs::write(&file, b"x").unwrap();
    let (entries, truncated) = collect_files(&file, 5_000);
    assert!(
        entries.is_empty(),
        "a file root has no children to list; got {entries:?}"
    );
    assert!(!truncated, "an empty listing is complete, not capped");
}

#[test]
fn collect_files_lists_nothing_for_an_empty_directory_root() {
    let root = tmp_dir("empty-root");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert!(
        entries.is_empty(),
        "an empty directory has no files to list; got {entries:?}"
    );
    assert!(!truncated);
}

#[test]
fn collect_files_lists_nested_files_relative_and_sorted() {
    let root = tmp_dir("nested");
    touch(&root, "a.txt");
    touch(&root, "src/b.rs");
    touch(&root, "src/c/d.md");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["a.txt", "src/b.rs", "src/c/d.md"]);
    assert!(!truncated);
}

#[test]
fn collect_files_prunes_vcs_directories_and_lists_other_dot_directories() {
    let root = tmp_dir("prune");
    touch(&root, ".git/config");
    touch(&root, ".hidden/z");
    touch(&root, "keep.rs");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec![".hidden/z", "keep.rs"],
        "`.git` is pruned; `.hidden` is the repo's call, and it declared nothing"
    );
    assert!(!truncated);
}

#[test]
fn collect_files_lists_a_tracked_dot_directory() {
    let root = tmp_dir("tracked-dot-dir");
    git_repo(&root);
    touch(&root, ".github/workflows/ci.yml");
    touch(&root, "src/app.rs");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec![".github/workflows/ci.yml", "src/app.rs"],
        "a dot-directory the repo tracks is listable"
    );
    assert!(!truncated);
}

#[test]
fn collect_files_lists_a_dot_directory_the_repo_does_not_ignore() {
    let root = tmp_dir("dot-dir-not-ignored");
    git_repo(&root);
    write(&root, ".gitignore", "dist/\n");
    touch(&root, ".claude/settings.json");
    touch(&root, ".venv/pyvenv.cfg");
    touch(&root, "dist/bundle.js");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec![
            ".claude/settings.json",
            ".gitignore",
            ".venv/pyvenv.cfg",
            "keep.rs"
        ],
        "everything the repo does not ignore is listed, dot-named or not"
    );
}

#[test]
fn collect_files_never_lists_a_nested_git_directory() {
    let root = tmp_dir("nested-git");
    git_repo(&root);
    touch(&root, ".git/config");
    touch(&root, "modules/x/.git/config");
    touch(&root, "modules/x/src/app.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec!["modules/x/src/app.rs"],
        "a nested `.git` is pruned while the nested repo's real source survives"
    );
    assert!(
        entries.iter().all(|e| !e.contains(".git/")),
        "no `.git/…` path may reach the picker; got {entries:?}"
    );
}

#[test]
fn collect_files_prunes_mercurial_and_svn_metadata_directories() {
    let root = tmp_dir("vcs-other");
    touch(&root, ".hg/store/00changelog.i");
    touch(&root, "sub/.svn/entries");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["keep.rs"]);
}

#[test]
fn collect_files_lists_a_file_named_git_because_the_prune_is_directories_only() {
    let root = tmp_dir("git-file");
    write(&root, "modules/x/.git", "gitdir: ../../.git/modules/x\n");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["keep.rs", "modules/x/.git"]);
}

#[test]
fn collect_files_lets_a_non_ignored_dot_directory_eat_the_cap() {
    let root = tmp_dir("dot-dir-cap");
    git_repo(&root);
    for i in 0..4 {
        touch(&root, &format!(".venv/lib/pkg/mod{i}.py"));
    }
    touch(&root, "src/app.rs");

    let (entries, truncated) = collect_files(&root, 3);
    assert!(
        truncated,
        "a non-ignored dot-tree bigger than the cap must report truncation"
    );
    assert_eq!(entries.len(), 3);
    assert!(
        entries.iter().all(|e| e.starts_with(".venv/")),
        "the crowding is done by the dot-tree; got {entries:?}"
    );
    assert!(
        !entries.contains(&"src/app.rs".to_string()),
        "test shape: real source is what got crowded out; got {entries:?}"
    );

    let (entries, truncated) = collect_files(&root, 5_000);
    assert!(!truncated);
    assert!(entries.contains(&"src/app.rs".to_string()));
}

#[test]
fn collect_files_lists_node_modules_when_the_repo_declares_it_source() {
    let root = tmp_dir("node-modules");
    touch(&root, "node_modules/pkg/index.js");
    touch(&root, "keep.rs");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["keep.rs", "node_modules/pkg/index.js"]);
    assert!(!truncated);
}

#[test]
fn collect_files_build_output_cannot_eat_the_cap_and_hide_source() {
    let root = tmp_dir("cap-build");
    git_repo(&root);
    write(&root, ".gitignore", "build/\n");
    for i in 0..4 {
        touch(&root, &format!("build/artifact-{i}.o"));
    }
    touch(&root, "src/app.rs");

    let (entries, truncated) = collect_files(&root, 3);
    assert!(
        entries.contains(&"src/app.rs".to_string()),
        "source must survive a build tree larger than the cap; got {entries:?}"
    );
    assert!(
        entries.iter().all(|e| !e.starts_with("build/")),
        "the repo declared build/ not-source; got {entries:?}"
    );
    assert!(!truncated, "the listing is complete once build/ is pruned");
    assert_eq!(entries, vec![".gitignore", "src/app.rs"]);
}

#[test]
fn collect_files_honours_gitignore() {
    let root = tmp_dir("gitignore");
    git_repo(&root);
    write(&root, ".gitignore", "secret.txt\n");
    touch(&root, "secret.txt");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec![".gitignore", "keep.rs"]);
}

#[test]
fn collect_files_honours_git_info_exclude_while_never_listing_git_itself() {
    let root = tmp_dir("git-exclude");
    write(&root, ".git/info/exclude", "secret.txt\n");
    touch(&root, ".git/config");
    touch(&root, "secret.txt");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec!["keep.rs"],
        "the exclude-listed file is pruned AND no `.git/…` path is ever listed"
    );
}

#[test]
fn collect_files_honours_ignore_files_without_git() {
    let root = tmp_dir("ignore-no-git");
    write(&root, ".ignore", "vendor/\n");
    touch(&root, "vendor/lib.c");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec![".ignore", "keep.rs"]);
}

#[test]
fn collect_files_lists_a_dotfile_unless_the_repo_ignores_it() {
    let root = tmp_dir("dotfile-ignored");
    git_repo(&root);
    write(&root, ".gitignore", "*.local\n");
    touch(&root, ".env");
    touch(&root, ".env.local");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec![".env", ".gitignore"]);
}

#[test]
fn collect_files_lets_an_ignore_file_outrank_gitignore() {
    let root = tmp_dir("ignore-outranks");
    git_repo(&root);
    write(&root, ".gitignore", "secret.txt\n");
    write(&root, ".ignore", "!secret.txt\n");
    touch(&root, "secret.txt");
    touch(&root, "keep.rs");
    let (entries, _) = collect_files(&root, 5_000);
    assert!(
        entries.contains(&"secret.txt".to_string()),
        ".ignore outranks .gitignore; got {entries:?}"
    );
}

#[test]
fn collect_files_applies_no_git_rules_without_a_git_directory() {
    let root = tmp_dir("no-git-dir");
    write(&root, ".gitignore", "secret.txt\n");
    touch(&root, "secret.txt");
    let (entries, _) = collect_files(&root, 5_000);
    assert!(
        entries.contains(&"secret.txt".to_string()),
        "a non-git Space lists everything; got {entries:?}"
    );
}

#[test]
fn collect_files_inherits_the_repo_root_rules_for_a_package_space() {
    let outer = tmp_dir("package-space");
    git_repo(&outer);
    write(&outer, ".gitignore", "build/\n");
    let pkg = outer.join("package");
    touch(&pkg, "build/artifact.o");
    touch(&pkg, "src/app.rs");
    let (entries, truncated) = collect_files(&pkg, 5_000);
    assert_eq!(
        entries,
        vec!["src/app.rs"],
        "the repo root's `.gitignore` must reach a package Space"
    );
    assert!(!truncated);
}

#[test]
fn collect_files_does_not_let_a_gitignore_above_the_git_root_reach_in() {
    let outer = tmp_dir("reach-bound");
    write(&outer, ".gitignore", "leaked.txt\n");
    let repo = outer.join("repo");
    git_repo(&repo);
    touch(&repo, "leaked.txt");
    let (entries, _) = collect_files(&repo, 5_000);
    assert!(
        entries.contains(&"leaked.txt".to_string()),
        "git rules are repo-scoped; got {entries:?}"
    );
}

#[cfg(unix)]
#[test]
fn collect_files_skips_an_unreadable_subdirectory_without_losing_the_listing() {
    use std::os::unix::fs::PermissionsExt;
    let root = tmp_dir("unreadable");
    touch(&root, "a.txt");
    touch(&root, "locked/hidden.txt");
    let locked = root.join("locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = std::panic::catch_unwind(|| collect_files(&root, 5_000));
    let restored = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
    let (entries, truncated) = result.expect("an unreadable directory must not panic the walk");
    restored.unwrap();
    assert_eq!(
        entries,
        vec!["a.txt"],
        "the readable part of the tree survives"
    );
    assert!(!truncated);
}

#[test]
fn collect_files_keeps_dot_named_files() {
    let root = tmp_dir("dotfile");
    touch(&root, ".gitignore");
    touch(&root, ".env");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec![".env", ".gitignore"]);
}

#[test]
fn collect_files_keeps_a_dot_named_root() {
    let parent = tmp_dir("dotroot");
    let root = parent.join(".dotfiles");
    std::fs::create_dir_all(&root).unwrap();
    touch(&root, "a.txt");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["a.txt"]);

    let vcs_root = parent.join(".git");
    std::fs::create_dir_all(&vcs_root).unwrap();
    touch(&vcs_root, "HEAD");
    let (entries, _) = collect_files(&vcs_root, 5_000);
    assert_eq!(
        entries,
        vec!["HEAD"],
        "depth 0 is never a prune decision, whatever the directory is called"
    );
}

#[test]
fn collect_files_caps_and_reports_truncation() {
    let root = tmp_dir("cap");
    for i in 0..5 {
        touch(&root, &format!("f{i}.txt"));
    }
    let (entries, truncated) = collect_files(&root, 3);
    assert_eq!(entries.len(), 3);
    assert!(truncated);
}

#[test]
fn collect_files_truncation_keeps_the_alphabetically_first_entries_not_readdir_order() {
    // tmpfs-backed, same reason as `completion_dir_truncates_at_the_cap`.
    let root = tmpfs_dir("cap-order");
    let names: Vec<String> = ('a'..='l').map(|c| format!("{c}.txt")).collect();
    for name in &names {
        touch(&root, name);
    }
    assert_readdir_disagrees_with_sorted_order(&root);

    let (entries, truncated) = collect_files(&root, 4);
    assert!(
        truncated,
        "12 files under a cap of 4 must report truncation"
    );
    assert_eq!(entries, vec!["a.txt", "b.txt", "c.txt", "d.txt"]);
}

#[test]
fn collect_files_sorts_display_order_across_directories() {
    let root = tmp_dir("display-order");
    touch(&root, "main.rs");
    touch(&root, "main/util.rs");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["main.rs", "main/util.rs"]);
    assert!(!truncated);
}

#[test]
fn collect_files_at_exactly_the_cap_is_not_truncated() {
    let root = tmp_dir("cap-exact");
    for i in 0..4 {
        touch(&root, &format!("f{i}.txt"));
    }
    let (entries, truncated) = collect_files(&root, 4);
    assert_eq!(entries, vec!["f0.txt", "f1.txt", "f2.txt", "f3.txt"]);
    assert_eq!(entries.len(), 4);
    assert!(!truncated, "exactly `cap` files are a complete listing");
}

#[cfg(unix)]
#[test]
fn collect_files_does_not_descend_into_a_symlinked_directory() {
    use std::os::unix::fs::symlink;
    let outside = tmp_dir("symdir-outside");
    std::fs::create_dir_all(outside.join("nest")).unwrap();
    std::fs::write(outside.join("nest/secret.txt"), b"secret").unwrap();
    let root = tmp_dir("symdir-root");
    touch(&root, "a.txt");
    symlink(&outside, root.join("escape")).unwrap();
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec!["a.txt"],
        "a symlinked dir is neither listed nor walked"
    );
    assert!(!truncated);
}

#[cfg(unix)]
#[test]
fn collect_files_does_not_follow_symlinks() {
    use std::os::unix::fs::symlink;
    let outside = tmp_dir("symlink-outside");
    std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
    let root = tmp_dir("symlink-root");
    touch(&root, "a.txt");
    symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(entries, vec!["a.txt"]);
}

#[test]
fn collect_files_refuses_names_the_token_grammar_cannot_hold() {
    let root = ungrammatical_fixture("collect-grammar");
    let (entries, truncated) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec![
            "a file with spaces.md",
            "docs/ok.md",
            "keep.md",
            "normal.rs",
        ],
        "the ungrammatical names are absent, the poisoned directory's subtree is not walked, and every other row survives"
    );
    assert!(!truncated);
}

#[cfg(unix)]
#[test]
fn collect_files_refuses_a_name_holding_a_newline() {
    let root = tmp_dir("collect-newline");
    touch(&root, "src/keep.rs");
    std::fs::File::create(root.join("bad\nname.md")).unwrap();
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec!["src/keep.rs"],
        "the newline-named file is not offered, and the ordinary file in its subdirectory is"
    );
}

#[cfg(unix)]
#[test]
fn collect_files_does_not_descend_into_a_directory_whose_name_the_grammar_cannot_hold() {
    let root = tmp_dir("collect-grammar-dir");
    touch(&root, "we?ird/inner.md");
    touch(&root, "docs/ok.md");
    let (entries, _) = collect_files(&root, 5_000);
    assert_eq!(
        entries,
        vec!["docs/ok.md"],
        "the poisoned subtree is not walked, and the sibling directory is"
    );
}

#[tokio::test]
async fn list_space_files_none_is_empty() {
    let dto = list_space_files(None).await.unwrap();
    assert!(dto.entries.is_empty());
    assert!(!dto.truncated);
}

#[tokio::test]
async fn list_space_files_returns_relative_slash_separated_entries() {
    let root = tmp_dir("space");
    touch(&root, "README.md");
    touch(&root, "src/main.rs");
    let dto = list_space_files(Some(root.to_string_lossy().into()))
        .await
        .unwrap();
    assert_eq!(dto.entries, vec!["README.md", "src/main.rs"]);
    assert!(!dto.truncated);
    for entry in &dto.entries {
        assert!(
            !std::path::Path::new(entry).is_absolute(),
            "{entry} is absolute"
        );
        assert!(!entry.contains('\\'), "{entry} has a backslash");
    }
}

#[tokio::test]
async fn list_space_files_degrades_to_empty_for_a_space_that_is_a_file() {
    let dir = tmp_dir("space-is-a-file");
    let file = dir.join("not-a-space.txt");
    std::fs::write(&file, b"x").unwrap();
    let dto = list_space_files(Some(file.to_string_lossy().into()))
        .await
        .unwrap();
    assert!(dto.entries.is_empty());
    assert!(!dto.truncated);
}

#[tokio::test]
async fn list_space_files_degrades_to_empty_for_an_uncanonicalizable_space() {
    let dto = list_space_files(Some("/no/such/space".to_string()))
        .await
        .unwrap();
    assert!(dto.entries.is_empty());
    assert!(!dto.truncated);
}
