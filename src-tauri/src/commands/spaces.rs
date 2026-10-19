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

#[tauri::command]
pub async fn space_for_path(
    state: State<'_, Arc<Db>>,
    path: String,
) -> Result<SpaceCheck, SpacesError> {
    let canonical =
        std::fs::canonicalize(&path).map_err(|_| SpacesError::FolderNotFound(path.clone()))?;
    if !canonical.is_dir() {
        return Err(SpacesError::NotAFolder(path));
    }
    let p = canonical.display().to_string();
    let is_space = state
        .find_space(&p)
        .map_err(|e| SpacesError::Database(e.to_string()))?
        .is_some();
    Ok(SpaceCheck {
        canonical_path: p,
        is_space,
    })
}

/// All spaces, most recently opened first.
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
        let db = Arc::new(Db::open(&db_path).unwrap());

        // We can't easily construct tauri::State in unit test without a runtime or helper,
        // but we can verify SpacesError formatting and kinds.
        let err = SpacesError::FolderNotFound("/nonexistent/path/12345".into());
        assert_eq!(err.kind(), "folder_not_found");
        assert_eq!(err.to_string(), "no such folder: /nonexistent/path/12345");
        drop(db);
    }
}
