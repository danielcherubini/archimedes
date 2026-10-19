//! Directory completion for the composer's `?` file picker outside of Space (ADR 0035).

use super::space_walk::is_skipped_dir;
use super::token::name_is_completable;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// One row of an out-of-Space **Directory completion** (ADR 0035): one entry of
/// ONE directory, as the `?` picker should show it.
///
/// `name` is what the renderer filters on and `display` is what it shows; they
/// differ only by the `~/` abbreviation. `insert` is the ABSOLUTE path — the
/// draft gets that and NOT the abbreviation, because nothing in this app expands
/// a tilde (`FsBackend::resolve` would read `~/x` as `<cwd>/~/x`), and teaching
/// it to would put a normalisation rule on the seam the **Boundary** is decided
/// at. See ADR 0035 before changing any of the three.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionEntryDto {
    /// The entry's own name, no trailing separator (what the filter matches).
    pub name: String,
    /// ABSOLUTE, `/`-separated — this is what lands in the draft. ONE caveat,
    /// because the word means one less thing on one platform: on WINDOWS a row
    /// under a `?/…` query (as opposed to a `?C:/…` or `?~/…` one) is rooted but
    /// drive-LESS, i.e. `/x/f`, which the platform resolves against the current
    /// drive. Every other row is absolute in the plain sense; nothing is ever
    /// relative to the CWD DIRECTORY (see `expand_completion_root`, which owns
    /// that refusal).
    pub insert: String,
    /// `~/…` when under the home directory, else the same as `insert`. The
    /// abbreviation is a PATH-PREFIX test on the path as the walker produced it,
    /// NOT a test of which directory it is: a queried path that reaches home
    /// THROUGH A SYMLINK (a `link-home -> $HOME`, measured: `display =
    /// "/tmp/…/link-home/notes"` where `$HOME/notes` would read `~/notes`) does not
    /// strip and is therefore displayed in full. That is the no-canonicalisation
    /// rule of `expand_completion_root` showing up in the UI, and it is display
    /// only — `insert` is the same path either way.
    pub display: String,
    /// A directory: the row descends instead of finishing.
    pub is_dir: bool,
}

/// One directory's worth of completion rows + whether the cap trimmed it.
/// The whole directory comes back UNFILTERED so the renderer keeps filtering
/// synchronously — a fetch happens only when the token's DIRECTORY part changes
/// (ADR 0035), which is why this returns rows and not matches.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionDirDto {
    pub entries: Vec<CompletionEntryDto>,
    pub truncated: bool,
}

/// Expand the RAW remainder of an out-of-Space `?` token into the directory it
/// names, WITHOUT touching the filesystem: `~/x` → `<home>/x`, `/x` → `/x`,
/// `C:/x` → `C:/x` ON THE PLATFORM WHERE THAT IS AN ABSOLUTE PATH, and ANYTHING
/// ELSE → `None`.
///
/// THE OUTPUT CONTRACT, which every arm upholds: `Some(path)` is a path the
/// caller may treat as rooted — never a path that resolves against the process
/// CWD. It is not decoration: `CompletionEntryDto::insert` is documented
/// ABSOLUTE and is built from a path under this answer, so a relative answer here
/// becomes a draft that resolves against whatever directory the app happens to be
/// running in — a DIFFERENT directory than the one the user typed, and, through
/// `..`, one they never named. That is the concrete defect the `is_absolute` guard
/// in the drive-root arm exists to prevent (see the comment there), and
/// `expand_completion_root_never_returns_a_relative_path` asserts the contract
/// across a battery of queries.
///
/// ONE PLATFORM CAVEAT ON THE WORD "ABSOLUTE", because `Path::is_absolute` means
/// slightly different things and pretending otherwise would just move the lie: on
/// Unix and macOS every `Some` below IS `is_absolute()`. On WINDOWS a `?/…` token
/// expands to a ROOTED but drive-less path (`/x`), and Rust's `is_absolute` is
/// false for that shape because it wants a drive prefix. It is still rooted — the
/// platform resolves it against the current drive, which is what a Windows user
/// means by `/x` — so this function keeps expanding it, and the refusal is
/// reserved for paths that would land in the CWD DIRECTORY. Both halves are
/// `cfg`-gated in the tests, never asserted silently across platforms.
///
/// WHY `home` IS A PARAMETER. This function never reads `HOME`, `dirs::`, or any
/// environment variable, and that is not tidiness — the same refusal is the
/// reason this file's `git_global(false)` flag has NO test (see the note at the
/// top of `mod tests`): observing it meant mutating process-global `HOME` inside
/// a threaded test binary that other tests read `$HOME` through. The caller
/// resolves the home directory once (`crate::skills::home_dir()`) and hands it
/// in, so every arm below — including `home == None` — is testable as written.
///
/// `None` is the safety property, not an error: it is what makes `~user`, a bare
/// `~`, and EVERY relative query never reach the filesystem. `~user` is a
/// documented refusal (ADR 0035) — supporting it would invite a walk of `/home`.
///
/// No normalisation and no `..` rejection: the **Boundary** canonicalises at gate
/// time and the picker is a view of the filesystem, not the enforcement point
/// (ADR 0033/0035). Two opinions about the same path is the failure mode this
/// file keeps refusing.
///
/// ONE CONSEQUENCE OF READING THE RAW STRING, said plainly because it looks like a
/// bug and is not: a trailing `.` selects a DIFFERENT directory than the token
/// reads. The "ends with `/`" rule below is applied to the query as typed, and
/// `Path::parent()` works on `components()`, which normalises `.` away — so the
/// final component of `<home>/.ssh/.` is `.ssh`, and its PARENT is `<home>`:
/// measured, `~/.ssh/.` lists HOME, while `~/.ssh/` lists `~/.ssh`'s contents. The
/// same split on `..`: `~/notes/..` takes the parent arm and lists `notes` (the
/// `..` is the component `parent()` removes), while `~/notes/../` ends in `/`, so
/// it takes the directory arm and lists the parent. `abs_to_slash` then drops `.`
/// components from the OUTPUT paths (they carry nothing a token can use), which is
/// why the rows can read inconsistently with the query rather than echoing it.
/// Nothing here normalises, and no `..`/`.` is resolved away — the asymmetry IS
/// the refusal above, and the Boundary canonicalises at gate time either way.
pub fn expand_completion_root(query: &str, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(rest) = query.strip_prefix("~/") {
        // FIRST POSITION ONLY. `a~b` and `~user/x` fail this test and fall
        // through to `None` below.
        //
        // The `is_absolute` filter is the SAME contract as the drive-root arm's
        // guard, applied to the one input this arm cannot vouch for on its own: the
        // `home` is the CALLER's, resolved from `$HOME`/`USERPROFILE` by
        // `crate::skills::home_dir()`, so a relative one would turn every `~` row
        // into a CWD-relative path. A real home is absolute on all three platforms,
        // so this filter refuses only the broken case.
        return home
            .map(|h| h.join(rest))
            .filter(|expanded| expanded.is_absolute());
    }
    if query.starts_with('/') {
        // Rooted. Absolute on Unix/macOS; on Windows this is drive-LESS (see the
        // "ONE PLATFORM CAVEAT" paragraph above), which is the platform's own
        // meaning for `/x` and NOT the CWD-relative shape the guard below refuses.
        return Some(PathBuf::from(query));
    }
    // A Windows drive root, `X:/`. Written as a BYTE test on purpose: nothing
    // here may consult the host platform, because CI is ubuntu-only and a
    // Linux-visible failure is the only kind this branch can have. It exists for
    // the Windows descent: a directory row there inserts `C:/Users/you/…`, and
    // if that did not parse the kept-`?` token would die after one level —
    // invisibly to this CI.
    //
    // …AND IT IS NOT ENOUGH ON ITS OWN, which is what the `is_absolute` guard
    // below supplies. The byte test says the query LOOKS like a drive root; only
    // the platform's own `Path` says whether it IS one, and off Windows it is
    // not: `PathBuf::from("C:/x")` is a RELATIVE path on Unix, so the arm used to
    // hand back a path under the process CWD (measured: with a literal `C:`
    // directory in the CWD, `C:/secret/` listed files there, and
    // `C:/../../../etc/` listed `/etc` through it — both as rows whose `insert`
    // claimed to be absolute). So the guard is the contract, and the arm under it
    // is Windows-only IN EFFECT while remaining platform-neutral IN CODE: on
    // Windows the byte test yields an absolute path and the descent works; on
    // Unix and macOS a drive-root query is refused, which is the honest answer,
    // because that syntax names nothing there. Pinned by
    // `expand_completion_root_never_returns_a_relative_path` (the invariant, true
    // on every platform) and by the `cfg`-gated arms of
    // `expand_completion_root_accepts_a_windows_drive_root` (which side each
    // platform takes).
    let bytes = query.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        let path = PathBuf::from(query);
        return path.is_absolute().then_some(path);
    }
    // Nothing else expands — INCLUDING a drive-relative `C:x` and any bare
    // relative path, both of which would otherwise be resolved against whatever
    // directory the app happens to be running in.
    None
}

/// Render an absolute path as the `/`-separated string the composer's token
/// charset accepts.
///
/// WHY THIS IS NOT `collect_files`' construction reused. That one is safe only
/// because it STRIPS the root and joins RELATIVE components, so no
/// `Component::RootDir` ever survives to be joined. `insert` here is absolute,
/// and `RootDir`'s `as_os_str()` is the SOURCE separator — `\` for a Windows
/// path, which is exactly what a `\`-rooted `USERPROFILE` home produces. A `\` in
/// `insert` is fatal twice over: it is outside the token charset, and `?C:\…`
/// fails the absolute token shape's `[A-Za-z]:/` root — so Windows `~`-descent
/// would die after one level, the very failure the drive root above was added to
/// prevent.
///
/// WHAT IS AND IS NOT OBSERVABLE HERE, stated plainly: the `RootDir` arm below
/// RUNS on Linux for every absolute path this function is given — it is covered,
/// by `abs_to_slash_round_trips_a_slash_rooted_path`, which fails if the arm
/// emits anything but a single leading `/` (a `components().join("/")` rewrite
/// produces `//home/u/x` and reddens it). What CANNOT occur on this host is a
/// `\`-VALUED `RootDir`, so the Windows value this arm defends against never
/// appears on CI; mutation-checked: replacing the arm with the raw component
/// leaves every test here GREEN here, which is exactly why the sentence above
/// points at the round-trip test rather than at that one.
pub fn abs_to_slash(p: &Path) -> String {
    let mut out = String::new();
    for component in p.components() {
        match component {
            // `.` carries no information a token can use.
            Component::CurDir => {}
            Component::RootDir => {
                // `/`, NEVER `as_os_str()` — see the doc comment. On Linux this
                // yields `/`; on Windows it replaces `\`.
                if !out.ends_with('/') {
                    out.push('/');
                }
            }
            // `Prefix` (`C:`) stays as-is: it is charset-safe and it is the
            // drive. `ParentDir` (`..`) stays as-is — no normalisation here
            // (see `expand_completion_root`).
            Component::Prefix(_) | Component::ParentDir | Component::Normal(_) => {
                if !out.is_empty() && !out.ends_with('/') {
                    out.push('/');
                }
                out.push_str(&component.as_os_str().to_string_lossy());
            }
        }
    }
    out
}

/// List ONE directory for an out-of-Space `?` token (ADR 0035): the directory is
/// the expanded root when `query` ends with `/` (the token is INSIDE it), else
/// the root's parent (`~/notes` completes names inside `$HOME`, `~/notes/` lists
/// `$HOME/notes`, `/` lists `/`). Unresolvable root, no parent, or a directory
/// that cannot be read → `(empty, false)`. Never panics and never errors: this
/// runs inside `spawn_blocking` in the command, where a panic would empty the
/// whole listing.
///
/// The visibility rules are `collect_files`' — the SAME builder chain, one level
/// deep — because two opinions about what a directory contains is exactly what
/// ADR 0035 rejects (raw `read_dir` was considered and refused for it). It
/// therefore honours another repository's `.gitignore`, `.ignore` and
/// `.git/info/exclude`, prunes `.git`/`.hg`/`.svn` through the SAME
/// `is_skipped_dir`, and refuses names the token grammar cannot hold through the
/// SAME `name_is_completable`. Pinned by
/// `completion_dir_hides_ignored_entries_in_another_repository`,
/// `completion_dir_never_offers_the_vcs_directories` and
/// `completion_dir_refuses_names_the_token_grammar_cannot_hold`.
///
/// The queried directory's OWN name is never a prune decision, so naming `.git`
/// directly LISTS it (`?/repo/.git/` → `objects`, `HEAD`, `config`). That matches
/// `is_skipped_dir`'s `depth > 0` gate, the depth-0 rule in `collect_files`, and a
/// Space opened at `.git`: the prune is an ENTRY rule for what a directory
/// contains, not a veto on what may be asked about.
///
/// REACH, including the part that surprises: the rules are read from the queried
/// directory AND ITS ANCESTORS (`parents(true)`), and the git matchers are gated
/// by the nearest `.git` ANYWHERE ABOVE rather than by the queried directory being
/// a repository. So a peek into a monorepo package is filtered by that repo's
/// rules (the intended half), and a peek into ANY directory under a repository —
/// including `$HOME` when it is a dotfiles checkout, which is common — is decided
/// by rules that live outside the directory the user named, with no note in the
/// listing (the surprising half, and the one thing a reader of this function must
/// not miss). Both are pinned, with the `.parents(false)` mutation named in the
/// test comments, by
/// `completion_dir_inherits_an_ancestor_repositorys_gitignore` and
/// `completion_dir_treats_a_gitignore_as_inert_without_an_ancestor_repository`;
/// nothing above the nearest `.git` reaches in, and `core.excludesFile` never
/// does (`git_global(false)`).
///
/// The chain differs from `collect_files` in exactly THREE ways, each with its
/// own reason below: `follow_links` (true, not false — out here a symlink is the
/// norm and there is nothing to contain), `max_depth` (`Some(1)` — one directory,
/// NEVER a walk; that is the whole design), and what is kept (directories AS
/// WELL AS files, because a directory row is how the descent continues).
///
/// THE CAP AND WHAT IT MAY DROP. The rows are composed **all directories first,
/// then files, each group in the walker's name order, `total` bounded by `cap`**,
/// and the whole directory is read BEFORE that composition happens — it is not
/// cut off mid-walk. `truncated` is true when ANYTHING was dropped, and WHICH
/// HALF was dropped is decided by this order, always: **files are dropped first**
/// (the directories keep the cap's first claim, so a capped listing is always
/// descendable), and **directories are dropped only when they alone exceed
/// `cap`**, in which case the alphabetically first `cap` directories are kept,
/// EVERY file is dropped, and `truncated` is still true. That is a decision and
/// not an accident: a directory row continues the gesture (select it and you are
/// inside), a file row ends it, so when there is not room for both the answer
/// that keeps the user moving is the one that keeps the descent open. Pinned by
/// `completion_dir_keeps_every_directory_when_the_directory_exceeds_the_cap`,
/// `completion_dir_keeps_the_first_cap_directories_when_directories_alone_exceed_the_cap`
/// and — for the case where ONLY directories were dropped, which is the only
/// fixture whose `truncated` cannot be carried by the files term —
/// `completion_dir_reports_truncation_when_only_directories_are_dropped`.
///
/// WHAT `cap` BOUNDS, and what removing the early `break` COSTS — the two are
/// different and this paragraph used to conflate them. MEMORY: `walkdir`'s sorted
/// mode (what `sort_by_file_name` selects) collects the ENTIRE directory into a
/// `Vec` and sorts it before yielding entry #1, so PEAK MEMORY scales with the
/// size of the directory no matter how early the loop stops — a reviewer measured
/// a 250,000-entry directory at ~26 MiB peak, and the `walkdir-2.5.0` source says
/// the same. That is why the `break` never bounded memory, which is what the
/// retracted comment here got wrong. WALL CLOCK is the OTHER axis and does NOT
/// behave that way: it scales with how far the loop is allowed to go, so removing
/// the `break` was a real cost, roughly 3-5x on the loop (see the comment inside
/// it for the measured numbers, both halves of that claim, and what it means for
/// the held-`Enter` window). Do not re-derive one axis from the other: the
/// sentence this paragraph replaced asserted the wall clock was free because the
/// memory was already paid, and measurement disproved it.
///
/// What `cap` bounds is downstream of the walk: the rows materialised as DTOs (at
/// most `2 * cap` are ever built below, so a huge directory does not allocate a
/// row per entry) and hence the size of the IPC payload. Dropping
/// `sort_by_file_name` is NOT the fix for the cost above: the sort STEP is a
/// minority of the bill (measured at about a tenth of a full scan), and the
/// materialise-plus-sort that sorted mode does before entry #1 is a further
/// fraction of it and not the whole of it (a walk-only pass over a 55,000-entry
/// directory measured here in a debug build at ~170 ms sorted against ~100 ms
/// unsorted). Removing the sorted order would also make WHICH rows survive the
/// cap `readdir` luck, which is the worse trade. Nothing here is cheap, and no
/// comment may claim it is.
pub fn completion_dir(
    query: &str,
    home: Option<&Path>,
    cap: usize,
) -> (Vec<CompletionEntryDto>, bool) {
    let Some(root) = expand_completion_root(query, home) else {
        return (Vec::new(), false);
    };
    let dir: &Path = if query.ends_with('/') {
        &root
    } else {
        match root.parent() {
            Some(parent) => parent,
            None => return (Vec::new(), false),
        }
    };
    // Two groups, kept in the walker's name order, so the composition after the
    // loop is a concatenation and never a re-sort. The `_total` counters, not the
    // vector lengths, are what `truncated` is computed from, because the loop
    // below REFUSES to materialise more than `cap` rows of either kind.
    let mut dirs: Vec<CompletionEntryDto> = Vec::new();
    let mut files: Vec<CompletionEntryDto> = Vec::new();
    let mut dir_total = 0usize;
    let mut file_total = 0usize;
    let walker = ignore::WalkBuilder::new(dir)
        // THE FLAGS INHERITED FROM `collect_files`, each with its OWN pin for THIS
        // walk (the visibility claim above is only as good as these, and four of
        // them were comment-only until they were mutation-checked here):
        //   hidden(false)   — `completion_dir_offers_dot_named_files_and_directories`
        //                     (`~/.ssh`, `~/.config`, `~/.aws` are the feature's
        //                     headline targets, and they are all dot-named);
        //   parents(true)   — `completion_dir_inherits_an_ancestor_repositorys_gitignore`
        //                     (the reach rule, including the case where the
        //                     repository is NOT the queried directory);
        //   git_ignore(true) — `completion_dir_hides_ignored_entries_in_another_repository`;
        //   git_exclude(true) — `completion_dir_honours_another_repositorys_git_info_exclude`;
        //   ignore(true)    — `completion_dir_honours_an_ignore_file_in_a_directory_that_is_not_a_repository`.
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_exclude(true)
        // UNPINNED REFUSAL, inherited from `collect_files` and unpinnable for
        // the same reason (see the `mod tests` note): reading a machine-wide
        // `core.excludesFile` here would make a completion of ANY directory a
        // function of the user's environment.
        .git_global(false)
        .ignore(true)
        // DIFFERENT from `collect_files` (out of the Space): one level deep
        // there is no cycle to follow and nothing to contain, and symlinks are
        // the norm rather than the exception (`/etc/os-release`, `~/.local/bin`,
        // most of macOS `~/Library`). The Space walk keeps `follow_links(false)`
        // because there a symlink's invisibility IS containment (ADR 0033). It
        // does not widen what the agent may READ: `FsBackend` judges the
        // canonicalised target.
        .follow_links(true)
        // DIFFERENT from `collect_files`: the one-directory rule IS the design
        // (ADR 0035) — no code path walks further. MUTATION-CHECKED, and NOT on
        // one test: `max_depth(Some(2))` reddens every test that states the WHOLE
        // row list of a fixture holding a directory with something inside it, because
        // the grandchild appears in walk order and those assertions are exhaustive.
        // At the time of writing that is
        // `completion_dir_lists_directories_as_well_as_files` (the grandchild of the
        // listed directory), `completion_dir_offers_symlinked_files_and_directories`
        // (the file INSIDE a symlinked directory),
        // `completion_dir_lists_a_directory_named_git_when_it_is_the_one_queried`
        // (`objects/` gains a child),
        // `completion_dir_offers_dot_named_files_and_directories`
        // (`.config/` gains one), `completion_dir_refuses_names_the_token_grammar_cannot_hold`
        // (`docs/` gains one) and the command-level
        // `list_completion_entries_lists_one_directory`. NO COUNT IS WRITTEN HERE ON
        // PURPOSE: the set grows with every whole-list assertion anyone adds, and
        // this comment's own count had already rotted once (it said "two", then
        // "THREE", and the measurement is six) — which is all a counted claim in a
        // comment ever is: a countdown.
        .max_depth(Some(1))
        .sort_by_file_name(Ord::cmp)
        .filter_entry(|e| {
            // IDENTICAL to `collect_files`: one prune rule for both walks, so
            // `.git` cannot be visible here and invisible there — and the SAME
            // representability rule for the same reason.
            !(e.file_type().is_some_and(|t| t.is_dir())
                && is_skipped_dir(&e.file_name().to_string_lossy(), e.depth()))
                && name_is_completable(&e.file_name().to_string_lossy())
        })
        .build()
        // Swallow, exactly as the Space walk does: a broken symlink is an ERROR
        // entry under `follow_links(true)`, so it is simply invisible (ADR
        // 0035). An `unwrap` here would panic inside `spawn_blocking` and empty
        // the listing.
        .filter_map(|e| e.ok());
    for entry in walker {
        // The directory itself is never a row. NOT `.min_depth(Some(1))`:
        // `collect_files` records that that configuration PANICKED under one
        // flag set and not under another, and a panic here would empty the
        // listing — the loop idiom is what the Space walk already relies on.
        if entry.depth() == 0 {
            continue;
        }
        // DIFFERENT from `collect_files`, which keeps files only: a DIRECTORY is
        // a row here, because selecting it descends. Under `follow_links(true)`
        // a symlink-to-file reports `is_file()` and a symlink-to-dir reports
        // `is_dir()`, which is the behaviour wanted (pinned by
        // `completion_dir_offers_symlinked_files_and_directories`).
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if !is_dir && !entry.file_type().is_some_and(|t| t.is_file()) {
            continue; // fifos, sockets, devices: not completable
        }
        // NO EARLY `break` ANY MORE, and the reason is the finding this shape
        // fixes: cutting the WALK at `cap` decided which rows existed by WHERE
        // the alphabet put the directories, so a directory whose files sort
        // first returned a capped listing holding NO directory at all — 45 of 199
        // directories silently lost in `/usr/lib64`, measured — and the picker
        // then said "keep typing", which cannot recover a row that was never
        // sent. Truncation is therefore a decision made over the WHOLE directory
        // after the loop, where the dirs-first claim below can actually be
        // honoured.
        //
        // AND THE FULL SCAN IS NOT FREE. Both axes, because they differ:
        //   * PEAK MEMORY is unchanged by the `break` — sorted mode materialises
        //     and sorts the directory before entry #1 (the doc comment, the
        //     `walkdir-2.5.0` source, and RSS all agree), so this loop was never
        //     the memory cliff.
        //   * WALL CLOCK is not: the `break` stopped the iteration, the entry
        //     classification and the row build for everything past the cap, and the
        //     sort it could not skip is only about a tenth of the cost. Measured on
        //     a 55,000-entry directory: ~37 ms WITH the old break-at-cap loop
        //     against ~108 ms for this full scan (about 3x, and 3-5x across sizes
        //     and profiles), with ~280 ms for the full scan at 100,000 entries. The
        //     multiplier is machine- and profile-dependent — a debug build on the
        //     dev box measured ~110 ms with the break against ~228 ms full at
        //     55,000, and ~200 ms against ~420 ms at 100,000 — the direction is not.
        //
        // NAME THE USER-VISIBLE HALF: since `560f610` the composer HOLDS `Enter`
        // while a completion fetch is in flight, and this loop is inside that
        // fetch, so a huge directory is now also a longer held-keystroke window.
        // The `break` was still the wrong trade — it bought that time by deciding
        // which rows EXISTED by where the alphabet put the directories — but the
        // trade is a trade, and "costs nothing" is the sentence this one replaces.
        let path = entry.path();
        let insert = abs_to_slash(path);
        // The abbreviation is DISPLAY-only, and computed from the PATH rather
        // than by string-trimming `insert`, so a home of `/home/uu` cannot be
        // mistaken for a prefix of `/home/u…`. What it therefore CANNOT do is
        // recognise a home reached through a SYMLINK: the walk's path is not
        // canonicalised (nothing here is), so `…/link-home/notes` does not strip to
        // `~/notes` and that row shows its full path — see `CompletionEntryDto::display`.
        let display = home
            .and_then(|h| path.strip_prefix(h).ok())
            .filter(|rel| !rel.as_os_str().is_empty())
            .map(|rel| format!("~/{}", abs_to_slash(rel)))
            .unwrap_or_else(|| insert.clone());
        let row = CompletionEntryDto {
            name: entry.file_name().to_string_lossy().into_owned(),
            insert,
            display,
            is_dir,
        };
        // The per-group bound: `cap` rows of each kind is the most the
        // composition below can ever keep (directories keep at most `cap`; files
        // at most the room the directories leave, which is <= `cap`), so the
        // surplus entries of a huge directory are COUNTED and skipped instead of
        // each becoming three `String`s. It is an ALLOCATION bound and NOT a
        // behaviour rule: mutation-checked, deleting it leaves every test here
        // GREEN, which is why the `min(cap)` on `dir_keep` below is written even
        // though this bound already implies `dirs.len() <= cap` — the subtraction
        // must not depend on a bound no test enforces. The counters ARE
        // load-bearing for behaviour, and
        // `completion_dir_keeps_every_directory_when_the_directory_exceeds_the_cap`
        // is where a wrong count shows up as a missing row.
        if is_dir {
            dir_total += 1;
            if dirs.len() < cap {
                dirs.push(row);
            }
        } else {
            file_total += 1;
            if files.len() < cap {
                files.push(row);
            }
        }
    }
    // DIRECTORIES FIRST, each group in the walker's name order, TOTAL bounded by
    // `cap`. A directory is not an answer, so it is offered ahead of the files a
    // user would rather see: descending is the gesture that gets you there.
    // Pinned by `completion_dir_sorts_directories_before_files`.
    //
    // `sort_by_file_name` on the builder is what makes BOTH halves of that
    // deterministic (the same two-sorts, two-jobs reasoning as `collect_files`):
    // it decides WHICH entries the directory holds in sorted order, so "the
    // alphabetically first `cap`" means the same thing on every filesystem
    // instead of being `readdir` luck, and it makes each group's order stable.
    //
    // The directories' claim comes first and the files get the remainder, which
    // is the whole of the drop policy stated in the doc comment.
    let dir_keep = dirs.len().min(cap);
    let file_room = cap - dir_keep;
    let file_keep = files.len().min(file_room);
    // TRUE iff this listing left something behind — a dropped file, or a dropped
    // directory when the directories alone exceeded the cap. BOTH terms are
    // load-bearing: with only the files term the whole suite stayed green, because
    // every fixture that drops a directory also drops a file; the directories term
    // is pinned on its own by
    // `completion_dir_reports_truncation_when_only_directories_are_dropped`, whose
    // directory holds nothing but directories. Never true for a listing that is
    // actually complete (pinned by
    // `completion_dir_at_exactly_the_cap_is_not_truncated`).
    let truncated = dir_keep < dir_total || file_keep < file_total;
    dirs.truncate(dir_keep);
    files.truncate(file_keep);
    let mut entries = dirs;
    entries.extend(files);
    (entries, truncated)
}
