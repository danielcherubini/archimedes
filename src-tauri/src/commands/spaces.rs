//! Tauri commands for the space registry (read-only views plus the
//! dialog's folder check). See `docs/roadmap/spaces.md` Task 4.
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::worker::manager::WorkerManager;
use crate::agent::SpacesError;
use crate::storage::{Db, DbError};

/// The folder check + canonicalizer for the new-space dialog.
///
/// Returns the CANONICAL path and whether a space row already exists for
/// it. A typed `~/x` or a missing folder is an ERROR ("no such folder"),
/// not a `None`: the dialog shows it inline instead of letting a broken
/// path travel to `start_session`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCheck {
    pub canonical_path: String,
    pub is_space: bool,
}

/// Core logic for checking a folder path and space membership against the database.
pub fn resolve_space_for_path(db: &Db, path: &str) -> Result<SpaceCheck, SpacesError> {
    let canonical =
        std::fs::canonicalize(path).map_err(|_| SpacesError::FolderNotFound(path.to_string()))?;
    if !canonical.is_dir() {
        return Err(SpacesError::NotAFolder(path.to_string()));
    }
    let p = canonical.display().to_string();
    let is_space = db
        .find_space(&p)
        .map_err(|e| SpacesError::Database(e.to_string()))?
        .is_some();
    Ok(SpaceCheck {
        canonical_path: p,
        is_space,
    })
}

#[tauri::command]
pub async fn space_for_path(
    state: State<'_, Arc<Db>>,
    path: String,
) -> Result<SpaceCheck, SpacesError> {
    resolve_space_for_path(&state, &path)
}

/// All spaces, in the user's manual order (`sort_order`; see `Db::list_spaces`).
#[tauri::command]
pub async fn list_spaces(
    state: State<'_, Arc<Db>>,
) -> Result<Vec<crate::storage::SpaceRow>, SpacesError> {
    state
        .list_spaces()
        .map_err(|e| SpacesError::Database(e.to_string()))
}

/// "Forget this space" — deletes the bookkeeping row only (conversations
/// stay stored; design decision). No-op if the row is already gone.
#[tauri::command]
pub async fn delete_space(state: State<'_, Arc<Db>>, path: String) -> Result<(), SpacesError> {
    state
        .delete_space(&path)
        .map_err(|e| SpacesError::Database(e.to_string()))
}

/// Rewrite the manual order of the spaces in ONE transaction (only a drag
/// calls this — ADR 0075).
///
/// Keyed by `paths`, not ids: the `spaces` table's key IS the canonical path
/// (`space_key`), and the values arriving from `list_spaces` are already that
/// stored key. The command layer deliberately does NOT re-canonicalize — a
/// folder that vanished mid-drag would then be silently skipped and leave a
/// PARTIAL renumber behind, the worst outcome (see `Db::reorder_spaces`).
#[tauri::command]
pub async fn reorder_spaces(
    state: State<'_, Arc<Db>>,
    paths: Vec<String>,
) -> Result<(), SpacesError> {
    reorder_space_rows(&state, &paths).map_err(|e| SpacesError::Database(e.to_string()))
}

pub(crate) fn reorder_space_rows(db: &Db, paths: &[String]) -> Result<(), DbError> {
    db.reorder_spaces(paths)
}

/// Set (or clear) a space's trust flag (Trusted Space, ADR 0010).
/// No-op if the row is missing — still a SUCCESS (the shield's optimistic
/// update just has nothing to persist; the no-op is logged, not silent).
///
/// ALSO (the Spaces-UI mid-session trust toggle — ADR 0025): after the
/// `db` write, send `Config { trusted }` to every RUNNING Worker in the
/// affected Space (the Worker's `StaticTrustSource` flip — the live
/// lookup half; the `trust-space` permission-outcome path is the separate
/// `respond_permission` `db` write + flip). A mid-session toggle for a
/// session in ANOTHER space is unaffected (the `cwd` match).
#[tauri::command]
pub async fn set_space_trusted(
    state: State<'_, Arc<Db>>,
    wm: State<'_, Arc<WorkerManager>>,
    path: String,
    trusted: bool,
) -> Result<(), SpacesError> {
    match state.set_space_trusted(&path, trusted) {
        Ok(true) => {
            // The running-Workers `config` update (the `StaticTrustSource`
            // flip — a dead / absent Worker is a no-op, not an error).
            wm.send_config_to_space(&path, trusted);
            Ok(())
        }
        Ok(false) => {
            eprintln!("set_space_trusted: no space row for {path} (no-op)");
            Ok(())
        }
        Err(e) => Err(SpacesError::Database(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_for_path_nonexistent_returns_folder_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Db::open(&db_path).unwrap();

        let nonexistent = dir.path().join("nonexistent_folder_12345");
        let path_str = nonexistent.to_str().unwrap();
        let err = resolve_space_for_path(&db, path_str).unwrap_err();
        assert_eq!(err.kind(), "folder_not_found");
        assert_eq!(err.to_string(), format!("no such folder: {path_str}"));
    }

    #[test]
    fn space_for_path_file_returns_not_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("file.txt");
        std::fs::write(&file_path, "content").unwrap();
        let db_path = dir.path().join("test.db");
        let db = Db::open(&db_path).unwrap();

        let path_str = file_path.to_str().unwrap();
        let err = resolve_space_for_path(&db, path_str).unwrap_err();
        assert_eq!(err.kind(), "not_a_folder");
        assert_eq!(err.to_string(), format!("not a folder: {path_str}"));
    }

    #[test]
    fn space_for_path_directory_checks_space_membership() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("space_dir");
        std::fs::create_dir(&folder).unwrap();
        let db_path = dir.path().join("test.db");
        let db = Db::open(&db_path).unwrap();

        let path_str = folder.to_str().unwrap();
        let check = resolve_space_for_path(&db, path_str).unwrap();
        assert_eq!(
            check.canonical_path,
            std::fs::canonicalize(&folder)
                .unwrap()
                .display()
                .to_string()
        );
        assert!(!check.is_space);

        // Mark it as a space in DB
        db.upsert_space(&check.canonical_path, false).unwrap();
        let check_after = resolve_space_for_path(&db, path_str).unwrap();
        assert!(check_after.is_space);
    }

    /// (ADR 0075) `reorder_space_rows` writes the slice in the GIVEN order: the
    /// paths arrive as `[c, a, b]` and `list_spaces` reads that back verbatim, so
    /// the command layer cannot sort or reorder a tab-strip drag. The paths are
    /// the STORED keys (the canonical paths `list_spaces` returns) — the command
    /// layer deliberately does NOT re-canonicalize, so the test feeds exactly
    /// what the frontend would send. Also proves the
    /// `Vec<String> → &[String]` deref the `#[tauri::command]` wrapper needs.
    #[test]
    fn reorder_space_rows_writes_the_slice_in_given_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("test.db")).unwrap();
        // `space_key` canonicalizes, so the folders must EXIST.
        let mut keys: Vec<String> = Vec::new();
        for name in ["a", "b", "c"] {
            let folder = dir.path().join(name);
            std::fs::create_dir_all(&folder).unwrap();
            db.upsert_space(folder.to_str().unwrap(), false).unwrap();
            keys.push(
                std::fs::canonicalize(&folder)
                    .unwrap()
                    .display()
                    .to_string(),
            );
        }
        let [a, b, c] = <[String; 3]>::try_from(keys).expect("three space keys");

        reorder_space_rows(&db, &[c.clone(), a.clone(), b.clone()])
            .expect("reorder_space_rows should succeed");

        let listed: Vec<String> = db
            .list_spaces()
            .expect("list_spaces should succeed")
            .into_iter()
            .map(|s| s.path)
            .collect();
        assert_eq!(
            listed,
            vec![c, a, b],
            "the given slice order IS the stored order"
        );
    }
}
