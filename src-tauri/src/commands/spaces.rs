//! Tauri commands for the space registry (read-only views plus the
//! dialog's folder check). See `docs/roadmap/spaces.md` Task 4.
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent::worker::manager::WorkerManager;
use crate::agent::SpacesError;
use crate::storage::Db;

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
}
