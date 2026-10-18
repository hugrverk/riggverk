//! One-time move of the per-user app data directory to its Riggverk name.
//!
//! Builds before the rename kept settings, the OpenCode model override and
//! backups in `LEGACY_APP_DATA_DIR_NAME`; they now live in `APP_DATA_DIR_NAME`.
//! On first launch the whole directory is moved with a single `rename`, which
//! is atomic, keeps modes and mtimes (the backup list is ordered by directory
//! mtime), and leaves no second copy of an in-flight setup transaction behind.
//!
//! Rules:
//! - Nothing legacy: nothing happens.
//! - A legacy path that is a symlink or not a directory is never followed or
//!   moved. It is left in place and reported once through the settings load
//!   warning.
//! - A current directory that already exists wins. The two are never merged and
//!   the legacy one is left untouched. The one exception is an empty current
//!   directory (something pre-created it), which is replaced.
//! - A marker file is written into the legacy directory first, so it travels
//!   inside the atomic rename and cannot disagree with it.
//! - Failure is fail-closed: startup stops with an error naming both paths and
//!   the legacy directory stays where it was. Continuing would let the first
//!   settings save create the new directory and strand the old data.
//! - There is no cleanup step. To undo the move by hand, quit the app and
//!   rename the directory back (see docs/RELEASE.md).
//!
//! This runs as the first statement of the Tauri `setup` closure. In Tauri 2
//! `setup` runs on the main thread inside the event loop's `Ready` callback and
//! blocks it, and the webview delivers its IPC messages through that same
//! loop, so no command can run before it returns.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::platform_paths::{app_support_dir, legacy_app_support_dir, Platform, PlatformEnv};

/// Written into the legacy directory before the move, so it ends up in the
/// current one.
pub const MIGRATION_MARKER_FILE: &str = ".migrated-from.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The data directories could not be resolved (no home or `APPDATA`). The
    /// settings load falls back to defaults in that case anyway.
    Unresolved(String),
    /// No legacy directory exists.
    NoLegacy,
    /// Both directories exist (or the current one is not an empty directory):
    /// the current one wins and the legacy one is left alone.
    AlreadyCurrent,
    /// The legacy directory was moved.
    Moved,
    /// The current directory existed but was empty; it was replaced by the
    /// legacy one.
    ReplacedEmptyTarget,
    /// The legacy path is a symlink or not a directory; left in place.
    SkippedSymlink,
}

/// Warning for the settings load channel, set once by `run_at_startup`.
static STARTUP_WARNING: Mutex<Option<String>> = Mutex::new(None);

/// The pending startup warning, if any. Returned once.
pub fn take_startup_warning() -> Option<String> {
    STARTUP_WARNING
        .lock()
        .ok()
        .and_then(|mut warning| warning.take())
}

/// Move the legacy directory to the current one when the rules above say so.
/// `rename` is injected so tests can fail it.
pub fn migrate(
    env: &PlatformEnv,
    platform: Platform,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<Outcome, String> {
    let (old, new) = match (
        legacy_app_support_dir(env, platform),
        app_support_dir(env, platform),
    ) {
        (Ok(old), Ok(new)) => (old, new),
        (Err(reason), _) | (_, Err(reason)) => return Ok(Outcome::Unresolved(reason)),
    };

    match fs::symlink_metadata(&old) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Outcome::NoLegacy),
        Err(error) => {
            return Err(format!(
                "cannot inspect the previous app data directory {}: {error}",
                old.display()
            ))
        }
        // `symlink_metadata` never follows, so a symlink is not a directory here.
        Ok(metadata) if !metadata.is_dir() => return Ok(Outcome::SkippedSymlink),
        Ok(_) => {}
    }

    let mut replace_empty_target = false;
    match fs::symlink_metadata(&new) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot inspect the app data directory {}: {error}",
                new.display()
            ))
        }
        Ok(metadata) if metadata.is_dir() && is_empty_dir(&new) => replace_empty_target = true,
        Ok(_) => return Ok(Outcome::AlreadyCurrent),
    }

    write_marker(&old, &new).map_err(|error| {
        format!(
            "cannot move app data from {} to {}: {error}. Nothing was moved; your data is still in {}.",
            old.display(),
            new.display(),
            old.display()
        )
    })?;

    if replace_empty_target {
        // `remove_dir` fails on a non-empty directory, so this cannot delete data.
        fs::remove_dir(&new).map_err(|error| {
            remove_marker(&old);
            format!(
                "cannot move app data from {} to {}: cannot replace the empty directory at the new path: {error}. Nothing was moved; your data is still in {}.",
                old.display(),
                new.display(),
                old.display()
            )
        })?;
    }

    rename(&old, &new).map_err(|error| {
        remove_marker(&old);
        format!(
            "cannot move app data from {} to {}: {error}. Nothing was moved; your data is still in {}. Quit any other copy of the app, check that both paths are on the same disk and writable, then start the app again.",
            old.display(),
            new.display(),
            old.display()
        )
    })?;

    Ok(if replace_empty_target {
        Outcome::ReplacedEmptyTarget
    } else {
        Outcome::Moved
    })
}

/// Unreadable counts as not empty: the only destructive step is removing an
/// empty directory, so any doubt keeps the current directory.
fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

/// Best effort: leave the legacy directory as it was found when the move fails.
fn remove_marker(old: &Path) {
    let _ = fs::remove_file(old.join(MIGRATION_MARKER_FILE));
}

fn write_marker(old: &Path, new: &Path) -> Result<(), String> {
    let marker = old.join(MIGRATION_MARKER_FILE);
    // A marker already there is stale: an earlier attempt failed before its
    // rename, or the move was undone by hand. Replace a regular file; refuse
    // anything else.
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() => fs::remove_file(&marker)
            .map_err(|error| format!("cannot replace {}: {error}", marker.display()))?,
        Ok(_) => return Err(format!("{} is not a regular file", marker.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("cannot inspect {}: {error}", marker.display())),
    }
    let unix_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let mut body = serde_json::to_string_pretty(&serde_json::json!({
        "from": old.to_string_lossy(),
        "to": new.to_string_lossy(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "unix_time": unix_time,
    }))
    .map_err(|error| format!("serialize migration marker: {error}"))?;
    body.push('\n');
    crate::safe_filesystem::write_private_new_regular_file_synced(&marker, body.as_bytes(), old)
}

/// Run the migration for the real process environment. Call it first in the
/// Tauri `setup` closure, before anything reads or writes the data directory.
pub fn run_at_startup() -> Result<(), String> {
    let env = PlatformEnv::from_process_env();
    let platform = Platform::current();
    let outcome = migrate(&env, platform, &|from, to| fs::rename(from, to))?;
    let old = legacy_app_support_dir(&env, platform).unwrap_or_default();
    let new = app_support_dir(&env, platform).unwrap_or_default();
    match outcome {
        Outcome::NoLegacy => {}
        Outcome::Unresolved(reason) => {
            eprintln!("riggverk: app data migration skipped: {reason}");
        }
        Outcome::Moved | Outcome::ReplacedEmptyTarget => {
            eprintln!(
                "riggverk: moved app data from {} to {}",
                old.display(),
                new.display()
            );
        }
        Outcome::AlreadyCurrent => {
            eprintln!(
                "riggverk: previous app data at {} ignored; {} already exists",
                old.display(),
                new.display()
            );
        }
        Outcome::SkippedSymlink => {
            let warning = format!(
                "Previous app data at {} is a symlink or not a folder, so it was not moved and is ignored. Riggverk now keeps its data in {}; copy settings across by hand if you want them.",
                old.display(),
                new.display()
            );
            eprintln!("riggverk: {warning}");
            if let Ok(mut pending) = STARTUP_WARNING.lock() {
                *pending = Some(warning);
            }
        }
    }
    Ok(())
}
