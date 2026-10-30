//! The skill catalog over IPC (read-only — the desktop is a READER of skill
//! directories, never a writer; ADR 0013).
use std::path::Path;

use crate::skills::SkillInfo;

/// The skill catalog for a Space (its roots + the user-level roots).
/// `space_path: None` → user-level skills only. INFALLIBLE by construction:
/// discovery is total (a missing root / unreadable file is skipped, Task 1), so
/// there is no `Err` arm to carry — the command returns the listing directly
/// (task14c: the `Result<_, String>` it used to carry was a phantom the wire
/// could never reject; ADR 0063).
#[tauri::command]
pub async fn list_skills(space_path: Option<String>) -> Vec<SkillInfo> {
    crate::skills::discover_skills(space_path.as_deref().map(Path::new))
}
