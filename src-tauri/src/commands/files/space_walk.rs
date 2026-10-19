//! Space traversal for the composer's `?` file completion (ADR 0033).

use super::token::name_is_completable;
use serde::Serialize;
use std::path::Path;

/// The `?` file-completion cap (ADR 0033). A big repo must not hang the
/// Client. Past the cap the picker says the listing is capped rather than
/// implying it is complete — BUT THAT NOTE IS NOT ALWAYS WHAT THE USER SEES:
/// `ChatStream.tsx`'s `pickerNote` tries the render-cap arm FIRST, so when the
/// query matched more rows than the frontend renders (`MAX_PICKER_ROWS`) the
/// line reads "Too many matches — keep typing" and the cap goes unreported.
/// The cap is reported UNLESS the too-many-matches arm wins.
pub const MAX_PICKER_ENTRIES: usize = 5_000;

/// One `?`-picker listing: paths RELATIVE to the Space root, `/`-separated
/// (normalized so a Windows walk never inserts `\` into the composer's
/// token), sorted. `truncated` = the cap was hit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListDto {
    pub entries: Vec<String>,
    pub truncated: bool,
}

/// Directory names the app ALWAYS prunes from the `?` listing, at every depth
/// below the Space root.
///
/// WHY exactly these three, and NOT a broader list of heavy directories
/// (`node_modules`, `dist`, `target`, `.venv`, …): those are precisely what a
/// repository's own ignore rules exist to decide, and re-adding an app-side list
/// would recreate the defect ADR 0034 removed — a hand-rolled approximation of
/// what the repo declares, wrong in both directions (it hides a committed
/// `node_modules` and misses an oddly-named build tree). ADR 0034's principle is
/// that the REPOSITORY decides what the `?` listing shows, and the blanket
/// dot-prefix rule this list replaced was the app overriding the repo on that
/// exact axis.
///
/// What the app must still own is the ONE thing no ignore file is ever asked to
/// protect: the VCS metadata directories. They are machine state rather than
/// project content, and `.gitignore` does NOT exclude them and never can — `git`
/// cannot ignore its own `.git/`. Without this prune the picker would offer
/// thousands of `.git/objects/…` paths. `.hg` (Mercurial) and `.svn`
/// (Subversion, which keeps one per working directory, hence the any-depth rule)
/// are the same machine state for the other two VCSs whose checkouts get opened
/// as a Space.
pub const PRUNED_VCS_DIRS: &[&str] = &[".git", ".hg", ".svn"];

/// Is a DIRECTORY named `name` one we never descend into / never list?
///
/// DIRECTORIES ONLY, and that gate lives in the caller (`filter_entry` checks
/// `is_dir()`): a FILE named `.git` — a submodule's gitfile, `gitdir: …` — is
/// still offered, because the dot-FILE rule (ADR 0033) keeps dot-named files
/// completable. Pinned by
/// `collect_files_lists_a_file_named_git_because_the_prune_is_directories_only`.
pub fn is_skipped_dir(name: &str, depth: usize) -> bool {
    // Depth 0 is the Space root itself, which may legitimately be a
    // dot-dir (a Space opened at `~/.dotfiles`) — never pruned. Belt and
    // braces: the crate already refuses to apply `filter_entry` to a depth-0
    // entry (see `collect_files_keeps_a_dot_named_root`), so no test covers
    // this half of the condition.
    depth > 0 && PRUNED_VCS_DIRS.contains(&name)
}

/// Walk `root` for the `?` picker: files only, and the VCS metadata directories
/// ([`PRUNED_VCS_DIRS`]) PRUNED at the directory level. Dot-named FILES are KEPT
/// (`.gitignore`, `.env` are real completion targets — `.` is in the token
/// charset), which is why the skip is a directory-level prune and not a
/// name-prefix filter over every entry — and consequently why a FILE named `.git`
/// (a submodule's gitfile) is still listed.
///
/// What the app decides, and what the repo decides. The ONLY name rules the app
/// applies are the VCS-directory prune above and [`name_is_completable`]'s
/// representability rule — the first unconditional (an APP rule, not the repo's)
/// precisely because no ignore file can exclude `.git/`, that being the one thing
/// the repo is never asked to decide; the second a property of the composer's
/// grammar rather than a judgement about the file (see its doc comment, which is
/// explicit that it is NOT the `PICKER_SKIP_DIRS` list ADR 0034 deleted).
/// EVERYTHING ELSE IS THE REPO'S CALL,
/// dot-named or not: `.github/`, `.vscode/`, `.claude/` and a `.venv` nobody
/// ignored are all walked and listed unless an ignore file says otherwise, which
/// is what `rg --hidden` does. The blanket dot-prefix rule this replaced
/// contradicted that (this repo's own tracked `.github/workflows/ci.yml` was not
/// listable here); dropping it applies ADR 0034's principle consistently rather
/// than introducing a new one.
///
/// Apart from those TWO rules nothing is skipped by name — no `node_modules` /
/// `dist` / `target` blacklist or anything like it, because a hand-rolled list is
/// an approximation of what the repo itself declares, and the repo's own ignore
/// rules are the real thing (ADR 0034). The two rules that remain are the VCS
/// prune above and [`name_is_completable`]'s representability rule, and neither
/// one is a visibility decision: the first protects machine state no ignore file
/// can name, the second refuses the two bytes the composer's token grammar cannot
/// carry. Both are pinned for this walk by
/// `collect_files_refuses_names_the_token_grammar_cannot_hold`,
/// `collect_files_refuses_a_name_holding_a_newline` and
/// `collect_files_does_not_descend_into_a_directory_whose_name_the_grammar_cannot_hold`.
/// The cost of that position is ACCEPTED and
/// pinned by `collect_files_lets_a_non_ignored_dot_directory_eat_the_cap`: a heavy
/// tree the repo does not ignore can consume the entry cap and crowd real source
/// out of the listing. VISIBILITY for everything else is decided by
/// `.gitignore`, `.ignore` and `.git/info/exclude`, which is why a dot-file the
/// repo ignores is NOT listable even though `hidden(false)` keeps dot-FILES
/// listable in general.
///
/// Three user-facing rules about those rules:
///
/// * **`.ignore` is the override knob.** It outranks `.gitignore`, and it needs
///   no git — so it is also the documented remedy for a Space that is not a
///   repository.
/// * **A non-git Space lists everything** git could otherwise exclude, because
///   git rules are repo-scoped (`require_git` left at its crate default of
///   `true`). Say "add a `.ignore` file", not "run `git init`".
/// * **A file under an excluded DIRECTORY cannot be re-included** — git's rule,
///   inherited here. Once `dist/` is excluded, `!dist/app.js` resurrects
///   NOTHING: the negation has to target the pattern that excluded the *file*.
///
/// REACH — where those rules are read from — is the repo's own directories, and
/// no machine-wide rule is ever consulted (`git_global(false)`). There is
/// however ONE leak that survives this design, and it is a known boundary
/// rather than a hidden contradiction: `parents(true)` reads **`.ignore` files
/// from ancestor directories above the Space, and `.ignore` is NOT gated by the
/// `.git` barrier the git matchers are.** So an `~/.ignore` above a repo root
/// does apply to every Space under `$HOME`, while a `~/.gitignore` does not.
/// That is `ripgrep`'s own behaviour and we accept it deliberately — but nothing
/// in this file or in ADR 0034 may say reach is bounded to the repo without
/// carrying this caveat.
///
/// Deliberately NOT shared with `exec_find` (see the cross-reference there):
/// that shells out to `fd` with a `walkdir` FALLBACK whose dot-skip is
/// per-FILE and which descends INTO `.git`.
///
/// Symlinks are NOT followed (`ignore`'s default with `follow_links(false)`,
/// inherited from the `walkdir` it wraps: a symlink's `file_type()` is
/// symlink, so `is_file()` is false and it is not listed, nor descended into).
/// Bounded by `cap`. Blocking by nature, so callers run it on
/// `spawn_blocking`.
pub fn collect_files(root: &Path, cap: usize) -> (Vec<String>, bool) {
    let mut entries: Vec<String> = Vec::new();
    let mut truncated = false;
    // The root itself is never an entry (and its own name is never a skip
    // decision) — the loop below skips `depth() == 0` rather than gating a min
    // depth on the builder. `min_depth(Some(1))` was measured on 0.4.33 to
    // COMPILE AND THEN PANIC (`called Option::unwrap() on a None value`, in
    // `walk.rs`) on any tree holding a subdirectory — but under the
    // all-matchers-off flag set this call used to carry, and re-measured with
    // the flags below it does NOT panic. A configuration-dependent panic inside
    // `spawn_blocking` (which would trip `list_space_files`' JoinError arm and
    // empty the whole picker) is reason enough to avoid it, and skipping depth 0
    // in the loop is equivalent, holds on every 0.4.x whatever the flag set, and
    // keeps the file-root invariant: a Space opened at a FILE yields nothing, so
    // the `debug_assert!` below can never see a `""` relative path. No depth
    // LIMIT — a deeply-nested file is still addressable; the walk is
    // count-bound only.
    //
    // TWO sorts, two jobs. `sort_by_file_name` makes the WALK deterministic,
    // which is what decides WHICH entries survive when the walk is truncated
    // mid-iteration by the cap — without it the surviving set is `readdir`
    // order, i.e. filesystem luck. The `entries.sort()` at the end makes the
    // DISPLAY order deterministic, and cannot substitute for the builder
    // sort because it runs only after the `break`.
    //
    // FOUR of `WalkBuilder`'s six default-ON filters are ON: the repo decides
    // which of its files are source (ADR 0034). The TWO refusals below are
    // deliberate and load-bearing, and they are spelled out because a future
    // reader will otherwise "helpfully" enable them for `ripgrep` parity.
    //
    //   hidden(false)     — dot-FILES stay listable (ADR 0033): `?.env`
    //                       completes. A dot-file the repo ignores (`*.local`
    //                       here) still does not — that is the matchers below
    //                       deciding, not a name rule up here.
    //   git_global(false) — NEVER read `~/.gitconfig`'s `core.excludesFile` or
    //                       `$XDG_CONFIG_HOME/git/ignore`. Refused so two
    //                       people on the same Space get the same listing
    //                       (ADR 0034): machine-wide rules would make the
    //                       listing a function of the user's environment.
    //                       OF EVERY FLAG ON THIS BUILDER, THIS IS THE ONE NO
    //                       TEST COVERS: flipping it to `true` leaves the whole
    //                       suite green (mutation-checked). See the `mod tests`
    //                       note for why the pin was refused; until someone
    //                       builds a harness that can isolate the environment,
    //                       this comment is the only guard — so treat flipping
    //                       the flag as a design change needing its own ADR.
    //
    // `require_git` is also left alone — at the crate default of `true`, and
    // deliberately not called here. It is what makes git rules repo-scoped AND
    // what stops the crate reading `.gitignore` from parents above the git
    // root; `require_git(false)` would re-import machine/home reach through a
    // different door (a stray `~/.gitignore` would decide every Space under
    // it). `parents(true)` below is what lets a Space opened at a monorepo
    // PACKAGE still inherit the repo root's rules; see the REACH paragraph in
    // the doc comment for the ancestor-`.ignore` leak that comes with it.
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_exclude(true)
        // UNPINNED REFUSAL (no test can reach it without mutating process-
        // global `HOME`/`XDG_CONFIG_HOME`; see the `mod tests` note and the
        // flag table above). Do not read the green suite as evidence here.
        .git_global(false)
        .ignore(true)
        .follow_links(false)
        .sort_by_file_name(Ord::cmp)
        .filter_entry(|e| {
            // A directory whose own name is skipped: prune the whole subtree
            // (and it would never be listed anyway — only files are).
            !(e.file_type().is_some_and(|t| t.is_dir())
                && is_skipped_dir(&e.file_name().to_string_lossy(), e.depth()))
                // …AND the representability rule, on EVERY entry's own name: a
                // directory whose name cannot form a token is pruned (every path
                // under it inherits the byte), a file whose name cannot is simply
                // not a row. See `name_is_completable` — this is the grammar's
                // limit, not a policy about the file.
                && name_is_completable(&e.file_name().to_string_lossy())
        })
        .build()
        // `Walk::Item` is `Result<DirEntry, ignore::Error>`, NOT a DirEntry.
        // Swallow: a subtree we cannot read is ONE missing subtree. An
        // `unwrap` here panics inside `spawn_blocking`, trips the JoinError arm
        // of `list_space_files`, and empties the ENTIRE listing.
        .filter_map(|e| e.ok());
    for entry in walker {
        if entry.depth() == 0 {
            continue; // the root is never an entry — see the note above
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if entries.len() >= cap {
            truncated = true;
            break;
        }
        // SEPARATORS: build the relative path by joining `components()` with
        // `/`. `to_string_lossy()` on a stripped path (what `exec_find`'s
        // walkdir fallback does) yields `\` on Windows, which is NOT in the
        // composer's token charset — every nested completion would silently
        // truncate at the first separator. Invisible to CI (ubuntu-latest),
        // so this is load-bearing by construction rather than by test.
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let joined = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        // A non-empty relative path is guaranteed by the depth-0 skip above
        // (a child's stripped path is never empty) — asserted rather than
        // skipped, so the invariant keeps a tripwire without dead code.
        debug_assert!(!joined.is_empty());
        entries.push(joined);
    }
    // Display order: the walk is already deterministic, but per-directory
    // name sorting is depth-first, so a nested `src/a.rs` can precede a
    // root-level `t.txt`. The picker must be deterministic AND sorted.
    entries.sort();
    (entries, truncated)
}
