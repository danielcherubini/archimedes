//! File-reading commands (the composer's `+` file picker and its `?` file
//! completion).
//!
//! `read_file_bytes` is the backend half of the image picker: the frontend
//! opens the native file dialog (`tauri-plugin-dialog` — a selection is a
//! PATH, not a `File`), then reads the bytes here. The webview cannot read
//! an arbitrary local path itself (no `fs` plugin), so the read is a
//! Tauri command.
//!
//! `list_space_files` is the backend half of the `?` file completion (ADR
//! 0033): it lists NAMES in the active **Space** so the picker can offer a
//! PATH. It reads no file bytes — `?` completes to a path and the agent's
//! own Boundary/policy-gated `read` stays the enforcement point.

pub mod completion;
pub mod image;
pub mod space_walk;
pub mod token;

#[cfg(test)]
mod tests;

pub use completion::{
    abs_to_slash, completion_dir, expand_completion_root, CompletionDirDto, CompletionEntryDto,
};
pub use image::{image_within_cap, is_supported_image_path, read_image_capped, IMAGE_EXTENSIONS};
pub use space_walk::{
    collect_files, is_skipped_dir, FileListDto, MAX_PICKER_ENTRIES, PRUNED_VCS_DIRS,
};
pub use token::name_is_completable;

use crate::agent::FilesError;
use std::path::Path;

/// Read a picked file's bytes (an image for the composer's attachments).
///
/// TWO-TIER BOUND (defense in depth — the dialog already filters by these
/// extensions, but the command is public IPC): the extension must be in
/// the image allowlist (a miss is `Ok(None)` — "not an image", the
/// frontend skips it silently) AND the size must fit `MAX_IMAGE_BYTES`
/// (an over-cap file is an `Err` — the frontend shows it on the
/// composer's error line). The read is blocking (a disk I/O), so it runs
/// on a worker thread.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Option<Vec<u8>>, FilesError> {
    if !is_supported_image_path(&path) {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || read_image_capped(Path::new(&path)))
        .await
        .map_err(|e| FilesError::Io(e.to_string()))?
}

/// The `?` file-completion listing for a Space (ADR 0033). `None`, or a
/// Space that fails to canonicalize, → EMPTY (never an arbitrary-root
/// walk, never an error: the picker degrades to "no files"). Reads NO file
/// bytes — names only.
#[tauri::command]
pub async fn list_space_files(space_path: Option<String>) -> Result<FileListDto, String> {
    let empty = || FileListDto {
        entries: vec![],
        truncated: false,
    };
    let Some(space_path) = space_path else {
        return Ok(empty());
    };
    // Canonicalizing and walking are both blocking (disk I/O), so they run
    // on a worker thread — the same pattern `read_file_bytes` above uses.
    // Kept for the diagnostics below (`space_path` itself moves into the
    // blocking closure): which Space failed is the one thing a log line needs.
    let space_path_for_log = space_path.clone();
    let walked = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&space_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(collect_files(&root, MAX_PICKER_ENTRIES))
    })
    .await;

    let walked = match walked {
        Ok(Ok(w)) => w,
        // BOTH arms below degrade to an EMPTY listing (never an `Err`: the
        // picker must not fail an IPC round-trip over a Space it cannot read).
        // The `Ok(Err(_))` arm is pinned by
        // `list_space_files_degrades_to_empty_for_an_uncanonicalizable_space`;
        // the shape the same way — `Ok` + empty + not-truncated — is also what
        // `list_space_files_degrades_to_empty_for_a_space_that_is_a_file` pins
        // for a walk that succeeds and finds nothing. The `Err(_)` (JoinError)
        // arm has NO test and cannot get one from outside: nothing a caller can
        // pass makes that closure panic, so reaching it would mean inserting a
        // panic into this file. That is precisely why it is not left silent.
        //
        // That contract is exactly what makes these arms INDISTINGUISHABLE to
        // the Client from a Space that legitimately holds no files, and the
        // frontend only logs a REJECTED command, so without the `eprintln!`s
        // below a panic in the walk would be invisible: every file in the Space
        // silently stops being completable, with no trace anywhere. Which arm
        // fired is in the message because the two mean very different things —
        // one is a bad path, the other is a BUG in this file. `eprintln!` is
        // this crate's convention for command-level diagnostics (compare
        // `commands/sessions.rs` and `commands/spaces.rs`).
        Ok(Err(e)) => {
            eprintln!(
                "list_space_files: no listing for Space {space_path_for_log} (the path failed to canonicalize: {e}); degrading to an empty listing"
            );
            return Ok(empty());
        }
        Err(join) => {
            // A `JoinError` means the blocking closure DIED — i.e. the walk
            // panicked, which every "never unwrap in here" comment in
            // `collect_files` exists to prevent. Loud on purpose.
            eprintln!(
                "list_space_files: the file walk PANICKED for Space {space_path_for_log} ({join}); degrading to an empty listing"
            );
            return Ok(empty());
        }
    };
    Ok(FileListDto {
        entries: walked.0,
        truncated: walked.1,
    })
}

/// `?[~/…]q`, `?/…q` or `?C:/…q` — list ONE directory for an out-of-Space
/// completion (ADR 0035). `None` query = no active token = empty, and NO
/// filesystem access at all.
///
/// The contract is `list_space_files`'s, deliberately, including the part that
/// looks like a bug: **never an `Err`**, always `Ok`, degrading to an EMPTY
/// listing, because a `?` picker that errors is worse than one that shows
/// nothing. That is also what makes a failure INDISTINGUISHABLE to the Client
/// from a directory that legitimately holds no files, so the one arm that CAN
/// fail logs WHICH arm fired — `eprintln!` being this crate's convention for
/// command-level diagnostics (compare `list_space_files` above and
/// `commands/spaces.rs`).
///
/// ONE failure arm, not `list_space_files`' two. That command has an `Ok(Err(_))`
/// arm because `canonicalize` can fail there; `completion_dir` is INFALLIBLE (it
/// returns a tuple, not a `Result` — an unreadable directory, an unformable query
/// and a `~` with no home are all `(empty, false)` INSIDE it), so there is no
/// error to log on the `Ok` side, and an `Ok`-side `eprintln!` would fire on
/// EVERY directory fetch and bury the one message that matters. Do not "restore
/// symmetry" with `list_space_files` — the shapes differ because the fallibility
/// does.
///
/// The two properties below are stated with what actually guards them, because
/// both are load-bearing and ONE of them is not guarded by a test.
///
/// * **A `None` query touches no filesystem at all** — held BY CONSTRUCTION (the
///   early return below is the only thing that makes it true), NOT by a test.
///   MUTATION-CHECKED: deleting that early return so `None` falls through into
///   `completion_dir("", …)` leaves the WHOLE suite GREEN, because the engine
///   returns `(empty, false)` for a query it cannot expand — the two paths are
///   OBSERVABLY IDENTICAL from here, so no test can distinguish them and none
///   should be written to pretend otherwise (an assertion would have to inspect
///   the filesystem, which is not this command's contract).
///   `list_completion_entries_degrades_to_empty_without_a_query` pins the empty
///   listing and NOTHING more — do not read its name as a no-`read_dir` proof.
///   The early return is still the right shape: without it the property would be
///   an accident of `expand_completion_root` refusing to expand `""` (which is why
///   the fall-through is silent today), i.e. a filesystem guarantee owned by a
///   pure string function one refactor away from changing, instead of a line here
///   that cannot be wrong.
/// * **No code path walks further than one directory** — held by
///   `list_completion_entries_lists_one_directory`, which asserts the WHOLE row
///   list of a two-level tree; `max_depth(Some(2))` in `completion_dir` reddens
///   it (mutation-checked), so the one-directory claim is a test and not a
///   comment.
///
/// WHY THERE IS NO BOUNDARY GATE ON THIS COMMAND, recorded because it will
/// otherwise be proposed again: listing ANY path from the webview is NOT a new
/// class of access in this app, and a gate here would protect nothing while
/// costing the feature its point. `list_space_files` walks ANY path recursively,
/// `read_file_bytes` reads any allowlisted-extension file, `set_space_trusted`
/// flips the Boundary flag from the webview, and `test_mcp_server` spawns an
/// arbitrary process — all pre-existing, all ungated. A curated root set (`/`,
/// `$HOME`, nothing else) was considered and refused for the same reason: it would
/// be a policy this app does not enforce anywhere else, and the moment the agent
/// goes to READ the path the Boundary decides, which is the enforcement point ADR
/// 0033/0035 put there. The same reasoning keeps `follow_links(true)`: a symlink
/// adds no reach a user lacks (typing the target works), and dropping it would
/// break `~/.local/bin` and most of macOS `~/Library`.
#[tauri::command]
pub async fn list_completion_entries(query: Option<String>) -> Result<CompletionDirDto, String> {
    let empty = || CompletionDirDto {
        entries: vec![],
        truncated: false,
    };
    let Some(query) = query else {
        // The ONLY thing guaranteeing the no-filesystem-access property above —
        // and the reason it is a construction rather than a test is in the doc
        // comment, not here.
        return Ok(empty());
    };
    // Listing a directory is blocking (disk I/O), so it runs on a worker thread
    // — the SAME `tauri::async_runtime::spawn_blocking` this file already uses
    // above, not `tokio::task::spawn_blocking`, which also compiles but would
    // make one file speak two dialects. `home_dir()` is resolved INSIDE the
    // closure so the pure engine never reads the environment itself (see
    // `expand_completion_root` for why that refusal exists).
    let query_for_log = query.clone();
    let listed = tauri::async_runtime::spawn_blocking(move || {
        completion_dir(
            &query,
            crate::skills::home_dir().as_deref(),
            MAX_PICKER_ENTRIES,
        )
    })
    .await;

    Ok(match listed {
        // The `Ok` arm logs NOTHING — see the doc comment.
        Ok((entries, truncated)) => CompletionDirDto { entries, truncated },
        Err(join) => {
            // UNTESTABLE, stated rather than implied: nothing a caller can pass
            // makes that closure panic (`completion_dir` has no `unwrap`,
            // `expect` or `debug_assert` a hostile path can trip — that is what
            // every "never unwrap in here" note in `completion_dir` and
            // `collect_files` exists to prevent), so reaching this arm would mean
            // INSERTING a panic into this file. Same reason `list_space_files`'
            // JoinError arm has no test, and the same reason neither is left
            // silent: a panic here is a BUG in this file, and without this line
            // the only symptom is "the picker quietly went empty". It was
            // VERIFIED BY INJECTION rather than pinned: a `panic!` placed at the
            // top of the closure above made
            // `list_completion_entries_lists_one_directory` fail on an EMPTY row
            // list (so still `Ok`, still the degraded shape) with this line on
            // stderr naming the query; the injected panic was removed again, and
            // no permanent test asserts it, because a test that inserts its own
            // panic would only be testing the test.
            eprintln!(
                "list_completion_entries: the directory listing PANICKED for query {query_for_log} ({join}); degrading to an empty listing"
            );
            empty()
        }
    })
}
