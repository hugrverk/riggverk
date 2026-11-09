//! Layout of the data folder: the current names, and how a folder made under the earlier names is
//! carried over.
//!
//! Releases before the Riggverk rename kept the data folder and the state folder inside it under
//! other names (`LEGACY_WORKSPACE_DIR_NAME`, `LEGACY_STATE_DIR`). Now they are `~/.config/riggverk`
//! and `.riggverk/`. Nothing moves at launch and reading never writes:
//!
//! - The earlier default data folder counts as Riggverk's only while it holds a state folder of
//!   either name (every earlier release wrote its marker there). The earlier name is a generic
//!   one: a folder of that name without one belongs to something else. It is never read, moved,
//!   written into, or reported; Riggverk starts a fresh profile under the current name. A folder
//!   chosen explicitly (`RIGGVERK_WORKSPACE_PATH`, a saved custom folder) is used as chosen.
//! - Reads use the current names where they exist and the earlier ones where only those exist. A
//!   current name that is an empty plain folder counts as absent.
//! - The first mutation (under the mutation lock, before any write) renames the earlier folder to
//!   the current name. A same-parent `rename` is atomic, so a folder is moved whole or not at all
//!   (and it replaces an empty plain folder of the current name atomically on POSIX). It never
//!   merges: when both exist the current one is used, the earlier one is left alone and reported.
//! - A rename that fails (a link, a permission) leaves everything where it was. Work continues in
//!   the earlier folder and the failure is reported in plain English. A rename that fails because
//!   another process moved the folder first counts as moved.
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

/// What migration attempts could not do, for the diagnostics: the folder a note is about and the
/// text. A later successful move of that folder forgets its note.
static NOTES: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

fn remember(about: &Path, note: String) {
    eprintln!("riggverk: {note}");
    let mut notes = NOTES.lock().unwrap_or_else(PoisonError::into_inner);
    if !notes.iter().any(|(_, existing)| existing == &note) {
        notes.push((about.to_path_buf(), note));
    }
}

fn forget(about: &Path) {
    NOTES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|(path, _)| path != about);
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// A plain folder with nothing in it. The current name counts as absent while it is one: it holds
/// nothing to lose, so the earlier folder is moved over it.
fn is_empty_plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        && fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// The folder to use when an earlier and a current name may both exist: the current one, unless it
/// is absent or empty and the earlier one exists.
fn pick(earlier: PathBuf, current: PathBuf) -> PathBuf {
    let current_is_real = exists(&current) && !is_empty_plain_dir(&current);
    if current_is_real || !exists(&earlier) {
        current
    } else {
        earlier
    }
}

/// The state folder to read and write: the current one when it holds something or is all there is,
/// else the earlier one when it exists, else the current one (nothing written yet).
pub fn state_dir(workspace_root: &Path) -> PathBuf {
    pick(
        workspace_root.join(LEGACY_STATE_DIR),
        workspace_root.join(STATE_DIR),
    )
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

/// Whether the earlier default data folder is Riggverk's: it holds a state folder (see the module
/// doc). One without it is another tool's folder that happens to have the generic earlier name.
fn earlier_default_is_ours(earlier: &Path) -> bool {
    holds_state_dir(earlier)
}

fn current_default() -> Result<PathBuf, String> {
    default_installed_workspace_path(&PlatformEnv::from_process_env(), Platform::current())
}

/// The default data folder of builds before the rename.
pub fn legacy_default_workspace_path() -> Option<PathBuf> {
    legacy_default_installed_workspace_path(&PlatformEnv::from_process_env(), Platform::current())
        .ok()
}

/// The default data folder to read: the current one when it holds something or is all there is,
/// else the earlier one when it is Riggverk's, else the current one (a fresh profile).
pub fn default_workspace_to_read() -> Result<PathBuf, String> {
    let current = current_default()?;
    Ok(match legacy_default_workspace_path() {
        Some(earlier) if earlier_default_is_ours(&earlier) => pick(earlier, current),
        _ => current,
    })
}

/// Whether the earlier default folder is a saved custom folder: that choice is never rewritten.
fn saved_path_is(earlier: &Path) -> bool {
    crate::settings::load()
        .workspace_path
        .as_deref()
        .and_then(crate::path_utils::normalize_user_workspace_path)
        .is_some_and(|saved| Path::new(&saved) == earlier)
}

/// Maps the earlier default data folder onto the current one, so a key made from either names the
/// same workspace. It maps when the earlier folder is gone (it was moved), or when it is still the
/// default folder waiting for its first move: not while both folders hold something, not when the
/// earlier folder is not Riggverk's, and not when the path comes from `RIGGVERK_WORKSPACE_PATH` or
/// a saved custom folder. Any other path is returned as it is.
pub fn canonical_workspace_path(path: &Path) -> PathBuf {
    let (Some(earlier), Ok(current)) = (legacy_default_workspace_path(), current_default()) else {
        return path.to_path_buf();
    };
    if path != earlier {
        return path.to_path_buf();
    }
    let moved = !exists(&earlier);
    let default_pending = !exists(&current) || is_empty_plain_dir(&current);
    let default_origin =
        crate::env_overrides::workspace_path_override().is_none() && !saved_path_is(&earlier);
    if moved || (default_pending && default_origin && earlier_default_is_ours(&earlier)) {
        current
    } else {
        path.to_path_buf()
    }
}

/// How an attempt to move an earlier folder to the current name ended.
enum Move {
    /// The folder now has the current name (by this call or by another process).
    Moved,
    /// The current name holds something of its own: it is used, the earlier one is left alone.
    CurrentWins,
    /// Not moved; the reason is remembered for the diagnostics.
    Stays,
}

type Rename = dyn Fn(&Path, &Path) -> std::io::Result<()>;

/// Renames `earlier` to `current`. An empty plain folder under the current name is replaced
/// (POSIX `rename` swaps it atomically); anything else there is never merged into. A rename that
/// fails is checked again: if `current` exists and `earlier` is gone, another process moved it.
fn move_over(earlier: &Path, current: &Path, what: &str, rename: &Rename) -> Move {
    if exists(current) && !is_empty_plain_dir(current) {
        return Move::CurrentWins;
    }
    let plain = fs::symlink_metadata(earlier)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());
    if !plain {
        remember(
            earlier,
            format!(
                "Riggverk kept using {} because it is not a plain {what} (a link, for example) and Riggverk never renames those.",
                earlier.display()
            ),
        );
        return Move::Stays;
    }
    #[cfg(windows)]
    if exists(current) {
        // Windows cannot rename over a folder; it is empty, so removing it loses nothing.
        let _ = fs::remove_dir(current);
    }
    match rename(earlier, current) {
        Ok(()) => {
            forget(earlier);
            Move::Moved
        }
        Err(_) if exists(current) && !exists(earlier) => {
            forget(earlier);
            Move::Moved
        }
        Err(error) => {
            remember(
                earlier,
                format!(
                    "Riggverk kept using {} because it could not rename it to {} ({error}). Everything keeps working there, and Riggverk tries again on the next change.",
                    earlier.display(),
                    current.display()
                ),
            );
            Move::Stays
        }
    }
}

fn migrate_default_workspace_with(path: &Path, rename: &Rename) -> PathBuf {
    let (Some(earlier), Ok(current)) = (legacy_default_workspace_path(), current_default()) else {
        return path.to_path_buf();
    };
    if path != earlier {
        return path.to_path_buf();
    }
    if !earlier_default_is_ours(&earlier) {
        // Another tool's folder: never renamed and never written into.
        return current;
    }
    match move_over(&earlier, &current, "folder", rename) {
        Move::Moved | Move::CurrentWins => current,
        Move::Stays => path.to_path_buf(),
    }
}

/// Moves the earlier default data folder to the current name when `path` is it, it is Riggverk's,
/// and the current one does not exist or is empty. Returns the folder to use afterwards: the
/// current one after a move or when the earlier folder is not Riggverk's, else `path`. Call it only under the mutation lock, before the first write.
pub fn migrate_default_workspace(path: &Path) -> PathBuf {
    migrate_default_workspace_with(path, &|from, to| fs::rename(from, to))
}

fn migrate_state_dir_with(workspace_root: &Path, rename: &Rename) {
    let root_is_real_folder = fs::symlink_metadata(workspace_root)
        .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink());
    if !root_is_real_folder {
        return;
    }
    let earlier = workspace_root.join(LEGACY_STATE_DIR);
    let current = workspace_root.join(STATE_DIR);
    if !exists(&earlier) {
        return;
    }
    move_over(&earlier, &current, "state folder", rename);
}

/// Renames the earlier state folder inside `workspace_root` to the current name. Leaves both in
/// place when both hold something (the current one is used) or the earlier one is a link. Call it
/// only under the mutation lock, before the first write.
pub fn migrate_state_dir(workspace_root: &Path) {
    migrate_state_dir_with(workspace_root, &|from, to| fs::rename(from, to));
}

/// What the diagnostics report about the layout, in plain English: moves that were not done, and
/// earlier folders that sit next to the current ones and were left alone. Read-only.
pub fn layout_notes(workspace_root: Option<&Path>) -> Vec<String> {
    let mut notes: Vec<String> = NOTES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(_, note)| note.clone())
        .collect();
    if let (Some(earlier), Ok(current)) = (legacy_default_workspace_path(), current_default()) {
        if earlier_default_is_ours(&earlier) && exists(&current) && !is_empty_plain_dir(&current) {
            notes.push(format!(
                "An earlier folder {} still exists next to {}; Riggverk uses {} and left the earlier folder untouched. Move what you need out of it, then delete it.",
                earlier.display(),
                current.display(),
                current.display()
            ));
        }
    }
    if let Some(root) = workspace_root {
        let earlier = root.join(LEGACY_STATE_DIR);
        let current = root.join(STATE_DIR);
        if exists(&earlier) && exists(&current) && !is_empty_plain_dir(&current) {
            notes.push(format!(
                "An earlier state folder {} still exists next to {}; Riggverk uses {} and left the earlier folder untouched.",
                earlier.display(),
                current.display(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::guard;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riggverk-layout-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn real_rename(from: &Path, to: &Path) -> std::io::Result<()> {
        fs::rename(from, to)
    }

    // Two processes starting at once: the other one renames between this one's check and its
    // rename, so this rename fails. It must count as moved, not as a failure.
    #[test]
    fn a_rename_lost_to_another_process_counts_as_moved() {
        let _lock = guard::lock();
        clear_notes_for_test();
        let base = temp("race");
        let earlier = base.join("earlier");
        let current = base.join("current");
        fs::create_dir_all(&earlier).unwrap();
        let other_process = |from: &Path, to: &Path| {
            fs::rename(from, to).unwrap();
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        };
        assert!(matches!(
            move_over(&earlier, &current, "folder", &other_process),
            Move::Moved
        ));
        assert!(layout_notes(None).is_empty(), "{:?}", layout_notes(None));

        // A failure with nothing moved is still a failure, and is reported.
        let earlier = base.join("earlier-2");
        let current = base.join("current-2");
        fs::create_dir_all(&earlier).unwrap();
        let refused =
            |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(matches!(
            move_over(&earlier, &current, "folder", &refused),
            Move::Stays
        ));
        assert_eq!(layout_notes(None).len(), 1);

        // A later success forgets the note.
        assert!(matches!(
            move_over(&earlier, &current, "folder", &real_rename),
            Move::Moved
        ));
        assert!(layout_notes(None).is_empty(), "{:?}", layout_notes(None));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_current_folder_is_replaced_and_a_full_one_is_never_merged() {
        let _lock = guard::lock();
        clear_notes_for_test();
        let base = temp("empty");
        let earlier = base.join("earlier");
        let current = base.join("current");
        fs::create_dir_all(&earlier).unwrap();
        fs::write(earlier.join("kept.txt"), "x").unwrap();
        fs::create_dir_all(&current).unwrap();
        assert_eq!(pick(earlier.clone(), current.clone()), earlier);
        assert!(matches!(
            move_over(&earlier, &current, "folder", &real_rename),
            Move::Moved
        ));
        assert!(current.join("kept.txt").is_file() && !earlier.exists());

        fs::create_dir_all(&earlier).unwrap();
        assert_eq!(pick(earlier.clone(), current.clone()), current);
        assert!(matches!(
            move_over(&earlier, &current, "folder", &real_rename),
            Move::CurrentWins
        ));
        assert!(earlier.is_dir() && current.join("kept.txt").is_file());
        let _ = fs::remove_dir_all(&base);
    }
}
