use super::support::{
    assert_readdir_disagrees_with_sorted_order, git_repo, list_query, rows, slash_query_form,
    tmp_dir, tmpfs_dir, touch, write,
};
use crate::commands::files::{
    abs_to_slash, completion_dir, expand_completion_root, list_completion_entries,
    MAX_PICKER_ENTRIES,
};

#[test]
fn expand_completion_root_expands_tilde_only_in_first_position() {
    let home = tmp_dir("expand-home");
    assert_eq!(
        expand_completion_root("~/.config/x", Some(&home)),
        Some(home.join(".config/x"))
    );
    assert_eq!(
        expand_completion_root("~/", Some(&home)),
        Some(home.clone())
    );
    assert_eq!(expand_completion_root("a~b", Some(&home)), None);
    assert_eq!(expand_completion_root("~", Some(&home)), None);
    assert_eq!(expand_completion_root("~user/x", Some(&home)), None);
    assert_eq!(
        expand_completion_root("/etc/pas", Some(&home)),
        Some(std::path::PathBuf::from("/etc/pas"))
    );
    assert_eq!(expand_completion_root("~/x", None), None);
    assert_eq!(
        expand_completion_root("/home/u/../secrets", Some(&home)),
        Some(std::path::PathBuf::from("/home/u/../secrets"))
    );
}

#[test]
fn expand_completion_root_never_returns_a_relative_path() {
    let home = tmp_dir("expand-invariant");
    for query in [
        "/",
        "/etc/pas",
        "~/",
        "~/notes/x",
        "C:/x",
        "C:/Users/you/",
        "c:/x",
        "C:/../../../etc/",
    ] {
        let Some(path) = expand_completion_root(query, Some(&home)) else {
            continue;
        };
        if cfg!(windows) && query.starts_with('/') {
            continue;
        }
        assert!(
            path.is_absolute(),
            "{query} expanded to the RELATIVE path {path:?}; every `insert` under it would resolve against the CWD"
        );
    }
    for query in [
        "", "~", "~user/x", "a~b", "Notes/x", "C:", "c:\\x", "./x", "x",
    ] {
        assert_eq!(
            expand_completion_root(query, Some(&home)),
            None,
            "{query} is not an absolute query and must not expand"
        );
    }
    assert_eq!(
        expand_completion_root("~/x", Some(std::path::Path::new("relative/home"))),
        None,
        "a relative `home` must not produce a relative root"
    );
}

#[test]
fn expand_completion_root_accepts_a_windows_drive_root() {
    #[cfg(windows)]
    {
        assert_eq!(
            expand_completion_root("C:/Users/you/", None),
            Some(std::path::PathBuf::from("C:/Users/you/")),
            "the Windows descent depends on this"
        );
        assert_eq!(
            expand_completion_root("c:/x", Some(std::path::Path::new("/home/u"))),
            Some(std::path::PathBuf::from("c:/x"))
        );
        assert!(expand_completion_root("C:/x", None).is_some());
    }
    #[cfg(not(windows))]
    {
        assert_eq!(expand_completion_root("C:/Users/you/", None), None);
        assert_eq!(
            expand_completion_root("c:/x", Some(std::path::Path::new("/home/u"))),
            None,
            "`home` is irrelevant here too: nothing expands a drive root off Windows"
        );
    }
    assert_eq!(expand_completion_root("C:", None), None);
    assert_eq!(expand_completion_root("Notes/x", None), None);
}

#[test]
fn completion_dir_lists_directories_as_well_as_files() {
    let root = tmp_dir("completion-list");
    touch(&root, "sub/f.txt");
    touch(&root, "top.txt");
    let (entries, truncated) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("sub", true), ("top.txt", false)],
        "one directory: the child directory AND the file, never the grandchild"
    );
    assert!(!truncated);
    for entry in &entries {
        let path = std::path::Path::new(&entry.insert);
        assert!(path.is_absolute(), "{} is not absolute", entry.insert);
        assert_eq!(path, root.join(&entry.name));
    }
}

#[test]
fn completion_dir_refuses_names_the_token_grammar_cannot_hold() {
    let root = super::support::ungrammatical_fixture("completion-grammar");
    let (entries, truncated) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![
            ("docs", true),
            ("a file with spaces.md", false),
            ("keep.md", false),
            ("normal.rs", false),
        ],
        "neither ungrammatical file is offered, the ungrammatically-named directory is not offered, and ordinary files and directories survive"
    );
    assert!(!truncated);
}

#[cfg(unix)]
#[test]
fn completion_dir_refuses_a_name_holding_a_newline() {
    let root = tmp_dir("completion-newline");
    touch(&root, "keep.rs");
    std::fs::File::create(root.join("bad\nname.md")).unwrap();
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("keep.rs", false)],
        "the newline-named file is not offered, and the ordinary file is"
    );
}

#[test]
fn completion_dir_lists_the_parent_while_a_last_component_is_being_typed() {
    let root = tmp_dir("completion-parent-arm");
    touch(&root, "notes/todo.md");
    touch(&root, "notes/other.md");
    let query = format!("{}/notes/todo", slash_query_form(&root));
    let (entries, truncated) = completion_dir(&query, None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("other.md", false), ("todo.md", false)],
        "without a trailing `/` the listed directory is the query's parent, not the query"
    );
    assert!(
        !truncated,
        "two rows under a cap of 5,000 is a complete listing"
    );

    let (slash, _) = completion_dir(
        &format!("{}/notes/", slash_query_form(&root)),
        None,
        MAX_PICKER_ENTRIES,
    );
    assert_eq!(
        rows(&slash),
        vec![("other.md", false), ("todo.md", false)],
        "the trailing `/` names the directory itself"
    );
}

#[test]
fn completion_dir_sorts_directories_before_files() {
    let root = tmp_dir("completion-sort");
    touch(&root, "a_file.txt");
    std::fs::create_dir_all(root.join("z_dir")).unwrap();
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("z_dir", true), ("a_file.txt", false)],
        "directories first, each group in the walker's name order"
    );
}

#[test]
fn completion_dir_displays_home_relative_and_inserts_absolute() {
    let home = tmp_dir("completion-home");
    touch(&home, "notes.md");
    let (entries, _) = completion_dir(&list_query(&home), Some(&home), MAX_PICKER_ENTRIES);
    let row = entries.first().expect("the fixture holds one entry");
    assert_eq!(row.display, "~/notes.md", "the display is abbreviated");
    assert_eq!(
        std::path::Path::new(&row.insert),
        home.join("notes.md"),
        "…while the insert is the real path"
    );
    assert_ne!(row.display, row.insert);

    let other = tmp_dir("completion-not-home");
    touch(&other, "elsewhere.txt");
    let (entries, _) = completion_dir(&list_query(&other), Some(&home), MAX_PICKER_ENTRIES);
    let row = entries.first().expect("the fixture holds one entry");
    assert_eq!(row.display, row.insert);
    assert!(
        std::path::Path::new(&row.display).is_absolute(),
        "{} is not absolute",
        row.display
    );
}

#[test]
fn completion_dir_never_offers_the_vcs_directories() {
    let root = tmp_dir("completion-vcs");
    git_repo(&root);
    std::fs::create_dir_all(root.join(".hg")).unwrap();
    std::fs::create_dir_all(root.join(".svn")).unwrap();
    touch(&root, "keep.rs");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("keep.rs", false)],
        "`.git`/`.hg`/`.svn` are never rows; got {entries:?}"
    );
}

#[test]
fn completion_dir_lists_a_directory_named_git_when_it_is_the_one_queried() {
    let root = tmp_dir("completion-git-root");
    touch(&root, ".git/config");
    touch(&root, ".git/HEAD");
    touch(&root, ".git/objects/pack.idx");
    let (entries, _) = completion_dir(&list_query(&root.join(".git")), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("objects", true), ("HEAD", false), ("config", false)],
        "the queried `.git` is listed; a nested one would be pruned"
    );
}

#[test]
fn completion_dir_hides_ignored_entries_in_another_repository() {
    let root = tmp_dir("completion-ignored");
    git_repo(&root);
    write(&root, ".gitignore", "node_modules\n");
    touch(&root, "node_modules/pkg/index.js");
    touch(&root, "package.json");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert!(
        !entries.iter().any(|e| e.name == "node_modules"),
        "a gitignored directory stays hidden out of the Space; got {entries:?}"
    );
    assert!(
        entries.iter().any(|e| e.name == "package.json"),
        "vacuity guard: the listing is not empty for the wrong reason"
    );
}

#[cfg(unix)]
#[test]
fn completion_dir_offers_symlinked_files_and_directories() {
    use std::os::unix::fs::symlink;
    let root = tmp_dir("completion-symlink");
    touch(&root, "real/target.txt");
    touch(&root, "realdir/inner.txt");
    symlink(root.join("real/target.txt"), root.join("link.txt")).unwrap();
    symlink(root.join("realdir"), root.join("linkdir")).unwrap();
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    let dir_row = entries
        .iter()
        .find(|e| e.name == "linkdir")
        .expect("a symlinked directory is offered as a directory row");
    assert!(dir_row.is_dir, "a symlink to a directory descends");
    let file_row = entries
        .iter()
        .find(|e| e.name == "link.txt")
        .expect("a symlinked file is offered");
    assert!(!file_row.is_dir, "a symlink to a file finishes");
    assert!(
        !entries.iter().any(|e| e.name == "inner.txt"),
        "following the link does not walk into it; got {entries:?}"
    );
}

#[cfg(unix)]
#[test]
fn completion_dir_hides_a_broken_symlink() {
    use std::os::unix::fs::symlink;
    let root = tmp_dir("completion-dangling");
    touch(&root, "keep.rs");
    symlink(root.join("no-such-target"), root.join("dangling")).unwrap();
    let (entries, truncated) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("keep.rs", false)],
        "the dangling link is absent and the rest of the listing survives"
    );
    assert!(!truncated);
}

#[test]
fn completion_dir_keeps_every_directory_when_the_directory_exceeds_the_cap() {
    let root = tmp_dir("completion-cap-dirs");
    for i in 0..8 {
        touch(&root, &format!("f{i}.txt"));
    }
    for name in ["z-a", "z-b", "z-c"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    let (entries, truncated) = completion_dir(&list_query(&root), None, 4);
    assert_eq!(
        rows(&entries),
        vec![
            ("z-a", true),
            ("z-b", true),
            ("z-c", true),
            ("f0.txt", false),
        ],
        "all three directories, then as many of the alphabetically first files as the cap leaves"
    );
    assert!(
        truncated,
        "eleven entries under a cap of 4 were trimmed, so the listing is not complete"
    );
    assert!(
        entries.iter().any(|e| e.is_dir),
        "vacuity guard: a capped listing must still be descendable"
    );
}

#[test]
fn completion_dir_keeps_the_first_cap_directories_when_directories_alone_exceed_the_cap() {
    let root = tmp_dir("completion-cap-dirsonly");
    for name in ["b", "c", "d", "e"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    touch(&root, "a.txt");
    let (entries, truncated) = completion_dir(&list_query(&root), None, 3);
    assert_eq!(
        rows(&entries),
        vec![("b", true), ("c", true), ("d", true)],
        "the alphabetically first `cap` directories, and no file"
    );
    assert!(
        truncated,
        "a dropped file and a dropped directory is a capped listing"
    );
}

#[test]
fn completion_dir_reports_truncation_when_only_directories_are_dropped() {
    let root = tmp_dir("completion-cap-dirsonly-nofiles");
    for name in ["e", "d", "c", "b", "a"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    let (entries, truncated) = completion_dir(&list_query(&root), None, 3);
    assert_eq!(
        rows(&entries),
        vec![("a", true), ("b", true), ("c", true)],
        "the alphabetically first `cap` directories, all of them directories"
    );
    assert!(
        truncated,
        "two directories were dropped and no file exists, so only the \
         directories' own term can report the truncation"
    );
}

#[test]
fn completion_dir_at_exactly_the_cap_is_not_truncated() {
    let root = tmp_dir("completion-cap-exact");
    std::fs::create_dir_all(root.join("z-dir")).unwrap();
    touch(&root, "a.txt");
    touch(&root, "b.txt");
    let (entries, truncated) = completion_dir(&list_query(&root), None, 3);
    assert_eq!(
        rows(&entries),
        vec![("z-dir", true), ("a.txt", false), ("b.txt", false)]
    );
    assert!(!truncated, "exactly `cap` rows means nothing was dropped");
}

#[test]
fn completion_dir_honours_an_ignore_file_in_a_directory_that_is_not_a_repository() {
    let root = tmp_dir("completion-dot-ignore");
    write(&root, ".ignore", "build.txt\n");
    touch(&root, "build.txt");
    touch(&root, "keep.rs");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![(".ignore", false), ("keep.rs", false)],
        "the `.ignore`listed file is hidden and the ordinary file is not"
    );
}

#[test]
fn completion_dir_honours_another_repositorys_git_info_exclude() {
    let root = tmp_dir("completion-exclude");
    write(&root, ".git/info/exclude", "secret.txt\n");
    touch(&root, ".git/config");
    touch(&root, "secret.txt");
    touch(&root, "keep.rs");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![("keep.rs", false)],
        "the exclude-listed file is hidden, `.git` is pruned, and the ordinary file survives"
    );
}

#[test]
fn completion_dir_reads_the_nearest_ancestor_repositorys_exclude_and_stops_above_it() {
    let root = tmp_dir("completion-nearest-repo");
    let top = root.join("top");
    write(&top, ".gitignore", "secret_top.txt\n");
    let repo = top.join("repo");
    git_repo(&repo);
    write(&repo, ".git/info/exclude", "secret_excluded.txt\n");
    touch(&repo, "inner/pkg/keep.rs");
    touch(&repo, "inner/pkg/secret_excluded.txt");
    touch(&repo, "inner/pkg/secret_top.txt");
    let (entries, truncated) = completion_dir(
        &list_query(&repo.join("inner/pkg")),
        None,
        MAX_PICKER_ENTRIES,
    );
    assert_eq!(
        rows(&entries),
        vec![("keep.rs", false), ("secret_top.txt", false)],
        "the ancestor repository's `.git/info/exclude` hides its file, and the `.gitignore` above that repository hides nothing"
    );
    assert!(
        !truncated,
        "a rule read from outside the queried directory leaves no trace in the payload"
    );
}

#[test]
fn completion_dir_inherits_an_ancestor_repositorys_gitignore() {
    let root = tmp_dir("completion-ancestor-repo");
    let outer = root.join("outer");
    git_repo(&outer);
    write(&outer, ".gitignore", "credentials.txt\n");
    touch(&outer, "inner/pkg/keep.rs");
    touch(&outer, "inner/pkg/credentials.txt");
    let (entries, truncated) = completion_dir(
        &list_query(&outer.join("inner/pkg")),
        None,
        MAX_PICKER_ENTRIES,
    );
    assert_eq!(
        rows(&entries),
        vec![("keep.rs", false)],
        "the ancestor repository's `.gitignore` decides what a peek into its package shows"
    );
    assert!(
        !truncated,
        "the rule is invisible in the payload too: a filtered listing is still 'complete'"
    );
}

#[test]
fn completion_dir_treats_a_gitignore_as_inert_without_an_ancestor_repository() {
    let root = tmp_dir("completion-no-ancestor-repo");
    let outer = root.join("outer");
    write(&outer, ".gitignore", "credentials.txt\n");
    touch(&outer, "inner/pkg/keep.rs");
    touch(&outer, "inner/pkg/credentials.txt");
    let (entries, _) = completion_dir(
        &list_query(&outer.join("inner/pkg")),
        None,
        MAX_PICKER_ENTRIES,
    );
    assert_eq!(
        rows(&entries),
        vec![("credentials.txt", false), ("keep.rs", false)],
        "no ancestor `.git` means the `.gitignore` is inert"
    );
}

#[test]
fn completion_dir_offers_dot_named_files_and_directories() {
    let root = tmp_dir("completion-hidden");
    touch(&root, ".env");
    touch(&root, ".config/settings.json");
    touch(&root, "notes.md");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert_eq!(
        rows(&entries),
        vec![(".config", true), (".env", false), ("notes.md", false)],
        "a dot-file and a dot-directory are both offered"
    );
}

#[test]
fn completion_dir_truncates_at_the_cap() {
    // tmpfs-backed: the premise asserted below belongs to the FILESYSTEM, so a
    // non-tmpfs `TMPDIR` (the desktop app sets one; its children inherit it)
    // makes the guard fire for reasons unrelated to this test. See `TmpfsDir`.
    let root = tmpfs_dir("completion-cap");
    for i in 0..5 {
        touch(&root, &format!("f{i}.txt"));
    }
    assert_readdir_disagrees_with_sorted_order(&root);
    let (entries, truncated) = completion_dir(&list_query(&root), None, 3);
    assert!(truncated, "more entries than the cap must be reported");
    assert_eq!(
        rows(&entries),
        vec![("f0.txt", false), ("f1.txt", false), ("f2.txt", false)]
    );

    let (entries, truncated) = completion_dir(&list_query(&root), None, 5);
    assert_eq!(entries.len(), 5);
    assert!(
        !truncated,
        "exactly `cap` rows is a complete listing, not a capped one"
    );
}

#[test]
fn completion_degrades_to_empty_for_a_missing_directory() {
    let (entries, truncated) = completion_dir("/no/such/directory/", None, MAX_PICKER_ENTRIES);
    assert!(entries.is_empty());
    assert!(!truncated, "an empty listing is complete, not capped");
}

#[test]
fn completion_degrades_to_empty_when_the_parent_is_a_file() {
    let root = tmp_dir("completion-parent-file");
    touch(&root, "f.txt");
    let query = format!("{}/f.txt/inner", root.to_string_lossy());
    let (entries, truncated) = completion_dir(&query, None, MAX_PICKER_ENTRIES);
    assert!(
        entries.is_empty(),
        "a file has no children to list; got {entries:?}"
    );
    assert!(!truncated);
}

#[test]
fn completion_degrades_to_empty_when_tilde_has_no_home() {
    let (entries, truncated) = completion_dir("~/notes/", None, MAX_PICKER_ENTRIES);
    assert!(entries.is_empty());
    assert!(!truncated);
}

#[test]
fn completion_insert_never_contains_a_backslash() {
    let root = tmp_dir("completion-backslash");
    touch(&root, "sub/f.txt");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    assert!(!entries.is_empty(), "vacuity guard");
    for entry in &entries {
        assert!(
            !entry.insert.contains('\\'),
            "{} has a backslash, which is outside the token charset",
            entry.insert
        );
    }
}

#[cfg(unix)]
#[test]
fn completion_dir_offers_a_name_containing_a_backslash() {
    let root = tmp_dir("completion-backslash-name");
    touch(&root, "weird\\name.rs");
    touch(&root, "keep.rs");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    let row = entries
        .iter()
        .find(|e| e.name == "weird\\name.rs")
        .expect("a backslash in a name is not a reason to hide the file");
    assert!(
        row.insert.contains('\\'),
        "the name is carried verbatim; got {}",
        row.insert
    );
    assert!(
        row.insert.starts_with('/') && row.insert.matches('/').count() >= 2,
        "the SEPARATORS are still `/` even in this row; got {}",
        row.insert
    );
}

#[cfg(target_os = "linux")]
#[test]
fn completion_dir_offers_a_non_utf8_name_with_a_lossy_insert() {
    use std::os::unix::ffi::OsStrExt;
    let root = tmp_dir("completion-non-utf8");
    let bad = std::ffi::OsStr::from_bytes(b"bad\xffname.md");
    std::fs::File::create(root.join(bad)).unwrap();
    assert!(
        root.join(bad).exists(),
        "test setup: the fixture must hold a file whose name is not valid UTF-8"
    );
    touch(&root, "keep.md");
    let (entries, _) = completion_dir(&list_query(&root), None, MAX_PICKER_ENTRIES);
    let row = entries
        .iter()
        .find(|e| e.name.contains('\u{FFFD}'))
        .unwrap_or_else(|| panic!("the non-UTF-8 name is offered; got {entries:?}"));
    assert!(
        row.insert.contains('\u{FFFD}'),
        "the lossy byte reaches the inserted path, which is the gap: {}",
        row.insert
    );
    assert!(
        !std::path::Path::new(&row.insert).exists(),
        "vacuity guard: the inserted path must NOT name the file, or this is not the gap described"
    );
    assert!(
        entries.iter().any(|e| e.name == "keep.md"),
        "the ordinary file survives"
    );
}

#[cfg(unix)]
#[test]
fn completion_dir_displays_a_symlinked_home_in_full() {
    use std::os::unix::fs::symlink;
    let home = tmp_dir("display-link-home");
    touch(&home, "notes.md");
    let outer = tmp_dir("display-link-outer");
    symlink(&home, outer.join("link-home")).unwrap();
    let (linked, _) = completion_dir(
        &list_query(&outer.join("link-home")),
        Some(&home),
        MAX_PICKER_ENTRIES,
    );
    let row = linked.first().expect("the fixture holds one entry");
    assert_eq!(
        row.display, row.insert,
        "a home reached through a symlink is displayed in full"
    );

    let (direct, _) = completion_dir(&list_query(&home), Some(&home), MAX_PICKER_ENTRIES);
    assert_eq!(
        direct.first().expect("the fixture holds one entry").display,
        "~/notes.md",
        "vacuity guard: the abbreviation works when the home is named directly"
    );
}

#[test]
fn abs_to_slash_round_trips_a_slash_rooted_path() {
    assert_eq!(
        abs_to_slash(std::path::Path::new("/home/u/notes.md")),
        "/home/u/notes.md"
    );
    assert_eq!(abs_to_slash(std::path::Path::new("/")), "/");
    assert_eq!(
        abs_to_slash(std::path::Path::new("/home/u/../x")),
        "/home/u/../x",
        "`..` survives untouched — the Boundary canonicalises at gate time"
    );
}

#[tokio::test]
async fn list_completion_entries_degrades_to_empty_without_a_query() {
    let dto = list_completion_entries(None).await.unwrap();
    assert!(dto.entries.is_empty());
    assert!(!dto.truncated);
}

#[tokio::test]
async fn list_completion_entries_lists_one_directory() {
    let root = tmp_dir("completion-cmd");
    touch(&root, "sub/f.txt");
    touch(&root, "top.txt");
    let dto = list_completion_entries(Some(list_query(&root)))
        .await
        .unwrap();
    assert_eq!(
        rows(&dto.entries),
        vec![("sub", true), ("top.txt", false)],
        "one directory: the child directory AND the file, never the grandchild"
    );
    assert!(!dto.truncated);
    for entry in &dto.entries {
        assert!(
            std::path::Path::new(&entry.insert).is_absolute(),
            "{} is not absolute",
            entry.insert
        );
    }
}
