//! Layout of the data folder: the current names, and how a folder made under the earlier names is
//! carried over.
//!
//! Releases before the Riggverk rename kept the data folder and the state folder inside it under
//! other names (`LEGACY_WORKSPACE_DIR_NAME`, `LEGACY_STATE_DIR`). Now they are `~/.config/riggverk`
//! and `.riggverk/`. Nothing moves at launch and reading never writes:
//!
//! - Reads use the current names where they exist and the earlier ones where only those exist.
//! - The first mutation (under the mutation lock, before any write) renames the earlier folder to
//!   the current name. A same-folder `rename` is atomic, so a folder is moved whole or not at all.
//!   It never merges: when both exist the current one is used, the earlier one is left alone and
//!   reported.
//! - A rename that fails (a link, a permission) leaves everything where it was. Work continues in
//!   the earlier folder and the failure is reported.
//!
//! The state folder follows the same rule inside any data folder, including a custom folder saved
//! by an earlier version: that folder itself is never moved.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use crate::platform_paths::{
    default_installed_workspace_path, legacy_default_installed_workspace_path, Platform,
    PlatformEnv,
};

/// The state folder inside a data folder.
pub const STATE_DIR: &str = ".riggverk";
/// The state folder of builds before the rename.
pub(crate) const LEGACY_STATE_DIR: &str = ".agent-workspace";

/// What migration attempts could not do, for the diagnostics. Newest last.
static NOTES: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn remember(note: String) {
    eprintln!("riggverk: {note}");
    let mut notes = NOTES.lock().unwrap_or_else(PoisonError::into_inner);
    if !notes.contains(&note) {
        notes.push(note);
    }
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// The state folder to read and write: the current one when it exists, else the earlier one when
/// only that exists, else the current one (nothing written yet).
pub fn state_dir(workspace_root: &Path) -> PathBuf {
    let current = workspace_root.join(STATE_DIR);
    if exists(&current) {
        return current;
    }
    let earlier = workspace_root.join(LEGACY_STATE_DIR);
    if exists(&earlier) {
        return earlier;
    }
    current
}

/// A file in the state folder (see [`state_dir`]).
pub fn state_file(workspace_root: &Path, name: &str) -> PathBuf {
    state_dir(workspace_root).join(name)
}

/// Whether the folder holds a state folder of either name: the app has touched it.
pub fn holds_state_dir(workspace_root: &Path) -> bool {
    [STATE_DIR, LEGACY_STATE_DIR]
        .iter()
        .any(|name| fs::symlink_metadata(workspace_root.join(name)).is_ok_and(|meta| meta.is_dir()))
}

fn current_default() -> Result<PathBuf, String> {
    default_installed_workspace_path(&PlatformEnv::from_process_env(), Platform::current())
}

/// The default data folder of builds before the rename.
pub fn legacy_default_workspace_path() -> Option<PathBuf> {
    legacy_default_installed_workspace_path(&PlatformEnv::from_process_env(), Platform::current())
        .ok()
}

/// The default data folder to read: the current one when it exists, else the earlier one when only
/// that exists, else the current one (a fresh profile).
pub fn default_workspace_to_read() -> Result<PathBuf, String> {
    let current = current_default()?;
    if exists(&current) {
        return Ok(current);
    }
    match legacy_default_workspace_path() {
        Some(earlier) if exists(&earlier) => Ok(earlier),
        _ => Ok(current),
    }
}

/// Maps the earlier default data folder onto the current one, so a key made from either names the
/// same workspace. Any other path is returned as it is.
pub fn canonical_workspace_path(path: &Path) -> PathBuf {
    match (legacy_default_workspace_path(), current_default()) {
        (Some(earlier), Ok(current)) if path == earlier => current,
        _ => path.to_path_buf(),
    }
}

/// Moves the earlier default data folder to the current name when `path` is it and the current
/// one does not exist. Returns the folder to use afterwards: the current one after a move, else
/// `path`. Call it only under the mutation lock, before the first write.
pub fn migrate_default_workspace(path: &Path) -> PathBuf {
    let (Some(earlier), Ok(current)) = (legacy_default_workspace_path(), current_default()) else {
        return path.to_path_buf();
    };
    if path != earlier {
        return path.to_path_buf();
    }
    if exists(&current) {
        // A folder that appeared since the resolution is never merged into.
        return current;
    }
    let linked = fs::symlink_metadata(&earlier)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(true);
    if linked {
        remember(format!(
            "could not move {} to {}: the earlier folder is a link; it stays where it is",
            earlier.display(),
            current.display()
        ));
        return path.to_path_buf();
    }
    match fs::rename(&earlier, &current) {
        Ok(()) => current,
        Err(error) => {
            remember(format!(
                "could not move {} to {}: {error}; working in the earlier folder",
                earlier.display(),
                current.display()
            ));
            path.to_path_buf()
        }
    }
}

/// Renames the earlier state folder inside `workspace_root` to the current name. Leaves both in
/// place when both exist (the current one is used) or the earlier one is a link. Call it only under
/// the mutation lock, before the first write.
pub fn migrate_state_dir(workspace_root: &Path) {
    let root_is_real_folder = fs::symlink_metadata(workspace_root)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());
    if !root_is_real_folder {
        return;
    }
    let earlier = workspace_root.join(LEGACY_STATE_DIR);
    let current = workspace_root.join(STATE_DIR);
    let Ok(meta) = fs::symlink_metadata(&earlier) else {
        return;
    };
    if exists(&current) {
        remember(format!(
            "{} and {} both exist; {} is used and the earlier folder is not merged",
            earlier.display(),
            current.display(),
            current.display()
        ));
        return;
    }
    if meta.file_type().is_symlink() || !meta.is_dir() {
        remember(format!(
            "could not move {} to {}: it is not a plain folder; it stays where it is",
            earlier.display(),
            current.display()
        ));
        return;
    }
    if let Err(error) = fs::rename(&earlier, &current) {
        remember(format!(
            "could not move {} to {}: {error}; working in the earlier folder",
            earlier.display(),
            current.display()
        ));
    }
}

/// What the diagnostics report about the layout: failed moves of earlier runs, and earlier folders
/// that now sit next to the current ones and were left alone. Read-only.
pub fn layout_notes(workspace_root: Option<&Path>) -> Vec<String> {
    let mut notes = NOTES.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if let (Some(earlier), Ok(current)) = (legacy_default_workspace_path(), current_default()) {
        if exists(&earlier) && exists(&current) {
            notes.push(format!(
                "{} still exists next to {}; it is not merged. Move what you need out of it, then delete it",
                earlier.display(),
                current.display()
            ));
        }
    }
    if let Some(root) = workspace_root {
        let earlier = root.join(LEGACY_STATE_DIR);
        let current = root.join(STATE_DIR);
        if exists(&earlier) && exists(&current) {
            notes.push(format!(
                "{} still exists next to {}; it is not merged and is no longer read",
                earlier.display(),
                current.display()
            ));
        }
    }
    notes.dedup();
    notes
}

/// Forgets the notes of earlier runs; for tests that share the process.
#[cfg(test)]
pub fn clear_notes_for_test() {
    NOTES.lock().unwrap_or_else(PoisonError::into_inner).clear();
}
