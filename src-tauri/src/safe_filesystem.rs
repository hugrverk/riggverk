//! Bounded filesystem helpers for setup and deprecated-skill workflows.
//!
//! Copies and removes directory trees without following symlinks. Recursion is
//! depth-bounded to avoid stack overflow on pathological trees. Callers must
//! supply an explicit allowlisted root for destination containment checks.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::path_safety::{ensure_within_root, reject_symlink, reject_symlink_parent_chain};

const MAX_RECURSE_DEPTH: usize = 64;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(not(windows))]
fn replace_file_atomic(temp: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temp, destination)
}

#[cfg(windows)]
fn replace_file_atomic(temp: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    let existing: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Create one directory; owner-only (0700) when `private` on unix.
#[cfg(unix)]
fn create_dir(path: &Path, private: bool) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    if private {
        builder.mode(0o700);
    }
    builder.create(path)
}

#[cfg(not(unix))]
fn create_dir(path: &Path, _private: bool) -> std::io::Result<()> {
    fs::create_dir(path)
}

/// Create a new file; owner-only (0600) when `private` on unix.
#[cfg(unix)]
fn create_new_file(path: &Path, private: bool) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    if private {
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(not(unix))]
fn create_new_file(path: &Path, _private: bool) -> std::io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

/// Give the replacement the permission bits it ends with. The temporary file is always created
/// owner-only (0600) and holds content only at that mode; here it takes the destination's bits, so
/// an atomic write does not widen a restricted file (a 0600 config), and a new file that is not
/// `private` takes the mode a plain create would give it.
#[cfg(unix)]
fn preserve_destination_permissions(
    temp: &Path,
    destination: &Path,
    private: bool,
) -> Result<(), String> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.is_file() => fs::set_permissions(temp, metadata.permissions())
            .map_err(|e| format!("preserve permissions on {}: {e}", temp.display())),
        _ if private => Ok(()),
        _ => apply_default_new_file_mode(temp),
    }
}

/// Sets `temp` to the mode (process umask applied) a plain create gives a new file, found by
/// creating an empty probe file beside it.
#[cfg(unix)]
fn apply_default_new_file_mode(temp: &Path) -> Result<(), String> {
    let mut name = temp.as_os_str().to_os_string();
    name.push(".mode");
    let probe = std::path::PathBuf::from(name);
    let mode = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|file| file.metadata())
        .map(|metadata| metadata.permissions());
    let _ = fs::remove_file(&probe);
    let mode =
        mode.map_err(|e| format!("probe default permissions beside {}: {e}", temp.display()))?;
    fs::set_permissions(temp, mode)
        .map_err(|e| format!("set permissions on {}: {e}", temp.display()))
}

#[cfg(not(unix))]
fn preserve_destination_permissions(
    _temp: &Path,
    _destination: &Path,
    _private: bool,
) -> Result<(), String> {
    Ok(())
}

/// Owner-only permissions for a file copied with `fs::copy`, which carries over the source's mode:
/// 0600, or 0700 when the source was executable.
#[cfg(unix)]
fn restrict_file_to_owner(path: &Path) -> Result<(), String> {
    // The mode `fs::copy` carried over; read before it is replaced, by a call that refuses a link.
    let executable = file_is_executable(path)?;
    set_file_executable(path, executable, true)
}

#[cfg(not(unix))]
fn restrict_file_to_owner(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Sets or clears the execute bits of a regular file, never following a symlink and never granting
/// group or world write. `private` keeps the file owner-only (0600, or 0700 executable); otherwise
/// the existing read bits stay and an executable file gets the execute bit for all three classes.
#[cfg(unix)]
pub fn set_file_executable(path: &Path, executable: bool, private: bool) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let mode = match (private, executable) {
        (true, true) => 0o700,
        (true, false) => 0o600,
        (false, true) => (metadata.permissions().mode() & 0o644) | 0o111,
        (false, false) => metadata.permissions().mode() & 0o644,
    };
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|e| format!("set permissions on {}: {e}", path.display()))
}

#[cfg(not(unix))]
pub fn set_file_executable(_path: &Path, _executable: bool, _private: bool) -> Result<(), String> {
    Ok(())
}

/// Whether the owner, group or world execute bit of a regular file is set; a symlink is refused.
#[cfg(unix)]
pub fn file_is_executable(path: &Path) -> Result<bool, String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    Ok(metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
pub fn file_is_executable(_path: &Path) -> Result<bool, String> {
    Ok(false)
}

fn validate_mutation_path(path: &Path, allowlisted_root: &Path, label: &str) -> Result<(), String> {
    if allowlisted_root.parent().is_none() {
        return Err(format!(
            "refusing broad allowlisted root for {label}: {}",
            allowlisted_root.display()
        ));
    }
    reject_symlink(path, label)?;
    ensure_within_root(path, allowlisted_root, label)?;
    reject_symlink_parent_chain(path, allowlisted_root, label)
}

/// Create an allowlisted root directory and any missing ancestors, rejecting
/// symlinks at every existing level. Unlike `create_directory_all_no_symlinks`,
/// the root itself may be missing several levels deep — e.g. the app-data
/// backup root on a fresh install where `Application Support/<bundle-id>`
/// has never been created.
#[cfg(test)]
pub fn create_root_directory_all_no_symlinks(root: &Path) -> Result<(), String> {
    create_root_directory_all_with(root, false)
}

/// Like `create_root_directory_all_no_symlinks`; every directory it creates is
/// owner-only (0700 on unix). For backup roots.
pub fn create_private_root_directory_all_no_symlinks(root: &Path) -> Result<(), String> {
    create_root_directory_all_with(root, true)
}

/// Create `dir` owner-only (0700 on unix) when it is missing. Missing ancestors get the default
/// mode and a link on an ancestor is followed, as `fs::create_dir_all` does, so a linked
/// `~/.config` keeps working; a link or a non-directory at `dir` itself is refused.
pub fn create_private_leaf_directory(dir: &Path) -> Result<(), String> {
    let existing = |dir: &Path| match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("refusing symlinked directory: {}", dir.display()))
        }
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(format!("not a directory: {}", dir.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("inspect directory {}: {error}", dir.display())),
    };
    if existing(dir)? {
        return Ok(());
    }
    if let Some(parent) = dir.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create directory {}: {e}", parent.display()))?;
    }
    match create_dir(dir, true) {
        Ok(()) => Ok(()),
        // Created meanwhile by another writer: fine when it is a real directory.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            existing(dir).map(|_| ())
        }
        Err(error) => Err(format!("create directory {}: {error}", dir.display())),
    }
}

fn create_root_directory_all_with(root: &Path, private: bool) -> Result<(), String> {
    let mut missing: Vec<std::path::PathBuf> = Vec::new();
    let mut current = root.to_path_buf();
    loop {
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "refusing symlinked ancestor for root creation: {}",
                    current.display()
                ));
            }
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => {
                return Err(format!(
                    "root creation ancestor is not a directory: {}",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(current.clone());
                match current.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => {
                        current = parent.to_path_buf();
                    }
                    _ => {
                        return Err(format!(
                            "no existing ancestor for root creation: {}",
                            root.display()
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "inspect root creation ancestor {}: {error}",
                    current.display()
                ));
            }
        }
    }
    for dir in missing.iter().rev() {
        create_dir(dir, private).map_err(|e| format!("create directory {}: {e}", dir.display()))?;
    }
    Ok(())
}

pub fn create_directory_all_no_symlinks(
    path: &Path,
    allowlisted_root: &Path,
) -> Result<(), String> {
    create_directory_all_with(path, allowlisted_root, false)
}

/// Like `create_directory_all_no_symlinks`; every directory it creates is
/// owner-only (0700 on unix). For backup directories.
pub fn create_private_directory_all_no_symlinks(
    path: &Path,
    allowlisted_root: &Path,
) -> Result<(), String> {
    create_directory_all_with(path, allowlisted_root, true)
}

fn create_directory_all_with(
    path: &Path,
    allowlisted_root: &Path,
    private: bool,
) -> Result<(), String> {
    validate_mutation_path(path, allowlisted_root, "directory creation")?;
    if fs::symlink_metadata(path).is_ok() {
        if !path.is_dir() {
            return Err(format!(
                "directory destination is not a directory: {}",
                path.display()
            ));
        }
        return Ok(());
    }
    let relative = path
        .strip_prefix(allowlisted_root)
        .map_err(|_| format!("directory escapes allowlisted root: {}", path.display()))?;
    let mut current = allowlisted_root.to_path_buf();
    if fs::symlink_metadata(&current).is_err() {
        create_dir(&current, private)
            .map_err(|e| format!("create directory {}: {e}", current.display()))?;
    }
    for component in relative.components() {
        current.push(component);
        validate_mutation_path(&current, allowlisted_root, "directory creation")?;
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "directory destination is not a directory: {}",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                validate_mutation_path(&current, allowlisted_root, "directory creation")?;
                create_dir(&current, private)
                    .map_err(|e| format!("create directory {}: {e}", current.display()))?;
            }
            Err(error) => {
                return Err(format!(
                    "inspect directory destination {}: {error}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

/// Replace `path` atomically. An existing destination keeps its permission bits;
/// a new file gets the default mode.
pub fn write_regular_file_atomic(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
) -> Result<(), String> {
    write_regular_file_atomic_with(path, content, allowlisted_root, false)
}

/// Like `write_regular_file_atomic`; a new file is owner-only (0600 on unix).
pub fn write_private_regular_file_atomic(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
) -> Result<(), String> {
    write_regular_file_atomic_with(path, content, allowlisted_root, true)
}

fn write_regular_file_atomic_with(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
    private: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("write destination has no parent: {}", path.display()))?;
    create_directory_all_with(parent, allowlisted_root, private)?;
    validate_mutation_path(path, allowlisted_root, "atomic write destination")?;
    if fs::symlink_metadata(path).is_ok() && !path.is_file() {
        return Err(format!(
            "atomic write destination is not a regular file: {}",
            path.display()
        ));
    }
    // The sequence restarts at 0 in every process, so pid and time keep a
    // temporary file left behind by a crashed run from colliding with this one.
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    if path.file_name().is_none() {
        return Err(format!(
            "invalid write destination name: {}",
            path.display()
        ));
    }
    // Short, name-independent temp names keep deep backup paths under Windows MAX_PATH.
    let temp_path = parent.join(format!(
        ".aw-{:x}-{nanos:x}-{sequence:x}.tmp",
        std::process::id()
    ));
    validate_mutation_path(&temp_path, allowlisted_root, "atomic write temporary file")?;
    let result = (|| {
        // Owner-only while it holds content, whatever mode it ends with.
        let mut output = create_new_file(&temp_path, true)
            .map_err(|e| format!("create temporary file {}: {e}", temp_path.display()))?;
        output
            .write_all(content)
            .map_err(|e| format!("write temporary file {}: {e}", temp_path.display()))?;
        output
            .sync_all()
            .map_err(|e| format!("sync temporary file {}: {e}", temp_path.display()))?;
        validate_mutation_path(path, allowlisted_root, "atomic write destination")?;
        preserve_destination_permissions(&temp_path, path, private)?;
        validate_mutation_path(&temp_path, allowlisted_root, "atomic write temporary file")?;
        replace_file_atomic(&temp_path, path)
            .map_err(|e| format!("replace destination {}: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(test)]
pub fn write_new_regular_file_synced(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
) -> Result<(), String> {
    write_new_regular_file_synced_with(path, content, allowlisted_root, false)
}

/// Like `write_new_regular_file_synced`; the file is owner-only (0600 on unix).
pub fn write_private_new_regular_file_synced(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
) -> Result<(), String> {
    write_new_regular_file_synced_with(path, content, allowlisted_root, true)
}

fn write_new_regular_file_synced_with(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
    private: bool,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("write destination has no parent: {}", path.display()))?;
    create_directory_all_with(parent, allowlisted_root, private)?;
    validate_mutation_path(path, allowlisted_root, "create-new destination")?;
    let mut output = create_new_file(path, private)
        .map_err(|e| format!("create file {}: {e}", path.display()))?;
    output
        .write_all(content)
        .map_err(|e| format!("write file {}: {e}", path.display()))?;
    output
        .sync_all()
        .map_err(|e| format!("sync file {}: {e}", path.display()))
}

/// Copy a directory tree without following symlinks.
///
/// Rejects symlink or dangling-symlink destinations and unsafe parent chains
/// up to `allowlisted_root`.
pub fn copy_dir_no_symlinks(src: &Path, dst: &Path, allowlisted_root: &Path) -> Result<(), String> {
    copy_dir_with(src, dst, allowlisted_root, false)
}

/// Like `copy_dir_no_symlinks`; created directories are 0700 and copied files
/// 0600 on unix. For backup trees.
pub fn copy_private_dir_no_symlinks(
    src: &Path,
    dst: &Path,
    allowlisted_root: &Path,
) -> Result<(), String> {
    copy_dir_with(src, dst, allowlisted_root, true)
}

fn copy_dir_with(
    src: &Path,
    dst: &Path,
    allowlisted_root: &Path,
    private: bool,
) -> Result<(), String> {
    reject_symlink(src, "copy source")?;
    validate_copy_destination(dst, allowlisted_root)?;
    if dst.exists() {
        reject_symlink(dst, "copy destination")?;
        if !dst.is_dir() {
            return Err(format!(
                "refusing copy into non-directory destination: {}",
                dst.display()
            ));
        }
    } else if let Some(parent) = dst.parent() {
        create_directory_all_with(parent, allowlisted_root, private)?;
    }
    create_directory_all_with(dst, allowlisted_root, private)?;
    copy_dir_recurse(src, dst, 0, private)
}

fn validate_copy_destination(dst: &Path, allowlisted_root: &Path) -> Result<(), String> {
    reject_symlink(dst, "copy destination")?;
    ensure_within_root(dst, allowlisted_root, "copy destination")?;
    reject_symlink_parent_chain(dst, allowlisted_root, "copy destination")?;
    if let Some(parent) = dst.parent() {
        reject_symlink(parent, "copy destination parent")?;
        ensure_within_root(parent, allowlisted_root, "copy destination parent")?;
        reject_symlink_parent_chain(parent, allowlisted_root, "copy destination parent")?;
    }
    Ok(())
}

fn copy_dir_recurse(src: &Path, dst: &Path, depth: usize, private: bool) -> Result<(), String> {
    if depth > MAX_RECURSE_DEPTH {
        return Err(format!("max copy depth exceeded at {}", src.display()));
    }
    for entry in fs::read_dir(src).map_err(|e| format!("read dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink in copy source: {}",
                entry.path().display()
            ));
        }
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            create_directory_all_with(&target, dst, private)?;
            copy_dir_recurse(&entry.path(), &target, depth + 1, private)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "copy {} -> {}: {e}",
                    entry.path().display(),
                    target.display()
                )
            })?;
            if private {
                restrict_file_to_owner(&target)?;
            }
        }
    }
    Ok(())
}

/// Remove a directory tree without following symlinks.
///
/// Rejects dangling symlinks and paths outside `allowlisted_root`.
pub fn remove_dir_no_symlinks(path: &Path, allowlisted_root: &Path) -> Result<(), String> {
    reject_symlink(path, "removal target")?;
    if !path.exists() {
        return Ok(());
    }
    ensure_within_root(path, allowlisted_root, "removal target")?;
    reject_symlink_parent_chain(path, allowlisted_root, "removal target")?;
    remove_dir_recurse(path, 0)
}

fn remove_dir_recurse(path: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_RECURSE_DEPTH {
        return Err(format!("max removal depth exceeded at {}", path.display()));
    }
    for entry in fs::read_dir(path).map_err(|e| format!("read dir {}: {e}", path.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let entry_path = entry.path();
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink during removal: {}",
                entry_path.display()
            ));
        }
        if file_type.is_dir() {
            remove_dir_recurse(&entry_path, depth + 1)?;
        } else {
            fs::remove_file(&entry_path)
                .map_err(|e| format!("remove file {}: {e}", entry_path.display()))?;
        }
    }
    fs::remove_dir(path).map_err(|e| format!("remove dir {}: {e}", path.display()))
}

/// Copy a regular file without following symlinks.
///
/// Validates source and destination for symlink safety, rejects destination
/// that exists as a dangling symlink, and ensures the destination parent
/// chain is safe within `allowlisted_root`.
pub fn copy_regular_file_no_symlinks(
    src: &Path,
    dst: &Path,
    allowlisted_root: &Path,
) -> Result<(), String> {
    copy_regular_file_with(src, dst, allowlisted_root, false)
}

/// Like `copy_regular_file_no_symlinks`; a new destination and its missing
/// parents are owner-only (0600/0700 on unix). For backup files.
pub fn copy_private_regular_file_no_symlinks(
    src: &Path,
    dst: &Path,
    allowlisted_root: &Path,
) -> Result<(), String> {
    copy_regular_file_with(src, dst, allowlisted_root, true)
}

fn copy_regular_file_with(
    src: &Path,
    dst: &Path,
    allowlisted_root: &Path,
    private: bool,
) -> Result<(), String> {
    // Source: reject direct symlink only. Source comes from a trusted
    // workspace; parent chain may include system symlinks (macOS /var -> /private/var).
    reject_symlink(src, "regular file copy source")?;
    if !src.is_file() {
        return Err(format!("source is not a regular file: {}", src.display()));
    }

    // Destination: full safety checks including containment
    let dst_parent = dst
        .parent()
        .ok_or_else(|| format!("destination has no parent: {}", dst.display()))?;
    reject_symlink(dst, "regular file copy destination")?;
    ensure_within_root(dst, allowlisted_root, "regular file copy destination")?;
    reject_symlink_parent_chain(dst, allowlisted_root, "regular file copy destination")?;
    reject_symlink(dst_parent, "regular file copy destination parent")?;
    ensure_within_root(
        dst_parent,
        allowlisted_root,
        "regular file copy destination parent",
    )?;
    reject_symlink_parent_chain(
        dst_parent,
        allowlisted_root,
        "regular file copy destination parent",
    )?;

    if dst.exists() && (dst.is_symlink() || !dst.is_file()) {
        return Err(format!(
            "destination exists as non-regular file: {}",
            dst.display()
        ));
    }
    if let Some(parent) = dst.parent() {
        create_directory_all_with(parent, allowlisted_root, private)?;
    }
    validate_mutation_path(dst, allowlisted_root, "regular file copy destination")?;
    let content = fs::read(src).map_err(|e| format!("read copy source {}: {e}", src.display()))?;
    write_regular_file_atomic_with(dst, &content, allowlisted_root, private)?;
    if private {
        set_file_executable(dst, file_is_executable(src)?, true)?;
    }
    Ok(())
}

/// Remove a regular file without following symlinks.
///
/// Validates the path for symlink safety and ensures it is within
/// `allowlisted_root`.
pub fn remove_regular_file_no_symlinks(path: &Path, allowlisted_root: &Path) -> Result<(), String> {
    reject_symlink(path, "regular file removal")?;
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    ensure_within_root(path, allowlisted_root, "regular file removal")?;
    reject_symlink_parent_chain(path, allowlisted_root, "regular file removal")?;
    if !path.is_file() {
        return Err(format!("path is not a regular file: {}", path.display()));
    }
    fs::remove_file(path).map_err(|e| format!("remove file {}: {e}", path.display()))?;
    Ok(())
}

pub fn remove_empty_directory_no_symlinks(
    path: &Path,
    allowlisted_root: &Path,
) -> Result<(), String> {
    reject_symlink(path, "empty directory removal")?;
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    ensure_within_root(path, allowlisted_root, "empty directory removal")?;
    reject_symlink_parent_chain(path, allowlisted_root, "empty directory removal")?;
    if !path.is_dir() {
        return Err(format!("path is not a directory: {}", path.display()));
    }
    if fs::read_dir(path)
        .map_err(|e| format!("read directory {}: {e}", path.display()))?
        .next()
        .is_some()
    {
        return Ok(());
    }
    fs::remove_dir(path).map_err(|e| format!("remove empty directory {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(label: &str) -> std::path::PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        // Canonical base: on macOS /var is a symlink to /private/var and would
        // mask symlink-ancestor bugs behind an unrelated rejection.
        fs::canonicalize(std::env::temp_dir())
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(format!("aw-safe-fs-{label}-{n}"))
    }

    #[test]
    fn copy_and_remove_roundtrip() {
        let base = temp("roundtrip");
        let _ = fs::remove_dir_all(&base);
        let src = base.join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested/a.txt"), b"a").unwrap();
        let dst = base.join("dst");
        copy_dir_no_symlinks(&src, &dst, &base).unwrap();
        assert!(dst.join("nested/a.txt").is_file());
        remove_dir_no_symlinks(&dst, &base).unwrap();
        assert!(!dst.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn copy_rejects_symlink_in_source() {
        let base = temp("copy-sym");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), src.join("link")).unwrap();
        let dst = base.join("dst");
        let err = copy_dir_no_symlinks(&src, &dst, &base).expect_err("symlink in source");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn copy_rejects_dangling_destination_symlink() {
        let base = temp("copy-dangling-dst");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();
        let dst = base.join("dst");
        std::os::unix::fs::symlink(base.join("missing"), &dst).unwrap();
        let err = copy_dir_no_symlinks(&src, &dst, &base).expect_err("dangling dst");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn copy_rejects_symlinked_destination_parent() {
        let base = temp("copy-sym-parent");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = base.join("linked");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();
        let dst = link.join("dst");
        let err = copy_dir_no_symlinks(&src, &dst, &base).expect_err("symlink parent");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_backup_rejects_symlinked_parent() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        // backup_artifact rejects when the ACTUAL resolved dest path
        // has a symlink in its parent chain
        let base = temp("backup-sym-parent");
        let _ = fs::remove_dir_all(&base);
        let real_config = base.join("real-config");
        fs::create_dir_all(real_config.join("opencode")).unwrap();
        fs::write(real_config.join("opencode/AGENTS.md"), b"original").unwrap();
        // Make .config a symlink so dest goes through it
        let config_link = base.join(".config");
        std::os::unix::fs::symlink(&real_config, &config_link).unwrap();
        let backup_dir = base.join("backups");
        let err = crate::setup_transaction::backup_artifact(
            &crate::artifact_registry::ArtifactId::OpenCodeRules,
            &backup_dir,
            &base,
            &base,
        )
        .expect_err("symlinked parent backup must be rejected");
        assert!(err.contains("symlink") || err.contains("parent"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_rejects_destination_outside_root() {
        let base = temp("copy-outside");
        let _ = fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        let err = copy_dir_no_symlinks(&src, &outside, &root).expect_err("outside root");
        assert!(err.contains("outside"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }
    #[cfg(unix)]
    #[test]
    fn setting_the_execute_bit_refuses_a_link_and_a_non_regular_file() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("exec-refuse");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("dir")).unwrap();
        let real = base.join("real");
        fs::write(&real, b"x").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o644)).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        for private in [true, false] {
            assert!(set_file_executable(&link, true, private).is_err());
            assert!(file_is_executable(&link).is_err());
            assert!(set_file_executable(&base.join("dir"), true, private).is_err());
            assert!(file_is_executable(&base.join("dir")).is_err());
            assert!(set_file_executable(&base.join("missing"), true, private).is_err());
        }
        // The link's target was not touched.
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o644
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn setting_the_execute_bit_never_leaves_a_file_group_or_world_writable() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("exec-clamp");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let path = base.join("script");
        fs::write(&path, b"x").unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o7777;
        for start in [0o666, 0o777] {
            for executable in [true, false] {
                fs::set_permissions(&path, fs::Permissions::from_mode(start)).unwrap();
                set_file_executable(&path, executable, false).unwrap();
                let now = mode(&path);
                assert_eq!(now & 0o022, 0, "{start:o} -> {now:o}");
                assert_eq!(now & 0o111 != 0, executable, "{start:o} -> {now:o}");
                fs::set_permissions(&path, fs::Permissions::from_mode(start)).unwrap();
                set_file_executable(&path, executable, true).unwrap();
                assert_eq!(mode(&path), if executable { 0o700 } else { 0o600 });
            }
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn copying_an_executable_source_writes_a_readable_file() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("exec-source");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let src = base.join("validate.cjs");
        fs::write(&src, b"#!/usr/bin/env node\n").unwrap();
        fs::set_permissions(&src, fs::Permissions::from_mode(0o755)).unwrap();
        let dst = base.join("out/nested/validate.cjs");
        copy_regular_file_no_symlinks(&src, &dst, &base).unwrap();
        let mode = fs::metadata(&dst).unwrap().permissions().mode();
        assert_ne!(mode & 0o400, 0, "owner can read the copy: {mode:o}");
        assert_eq!(fs::read(&dst).unwrap(), fs::read(&src).unwrap());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn regular_file_copy_roundtrip() {
        let base = temp("reg-copy");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("src")).unwrap();
        fs::write(base.join("src/a.txt"), b"a").unwrap();
        fs::create_dir_all(base.join("dst")).unwrap();
        copy_regular_file_no_symlinks(&base.join("src/a.txt"), &base.join("dst/a.txt"), &base)
            .unwrap();
        assert_eq!(fs::read(base.join("dst/a.txt")).unwrap(), b"a");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_creates_and_replaces_regular_file() {
        let base = temp("atomic-write");
        fs::create_dir_all(&base).unwrap();
        let path = base.join("nested/config.json");
        write_regular_file_atomic(&path, b"one", &base).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one");
        write_regular_file_atomic(&path, b"two", &base).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(
            fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1,
            "temporary file must not remain"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn create_new_synced_refuses_existing_file() {
        let base = temp("create-new");
        fs::create_dir_all(&base).unwrap();
        let path = base.join("evidence.json");
        write_new_regular_file_synced(&path, b"one", &base).unwrap();
        let error =
            write_new_regular_file_synced(&path, b"two", &base).expect_err("must not replace");
        assert!(error.contains("create file"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"one");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_dangling_destination() {
        let base = temp("atomic-dangling");
        fs::create_dir_all(&base).unwrap();
        let path = base.join("config.json");
        std::os::unix::fs::symlink(base.join("missing"), &path).unwrap();
        let error =
            write_regular_file_atomic(&path, b"content", &base).expect_err("dangling symlink");
        assert!(error.contains("symlink"), "{error}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_rejects_symlinked_parent() {
        let base = temp("atomic-parent");
        fs::create_dir_all(&base).unwrap();
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let linked = base.join("linked");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        let error = write_regular_file_atomic(&linked.join("config.json"), b"content", &base)
            .expect_err("symlinked parent");
        assert!(error.contains("symlink"), "{error}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_rejects_filesystem_root_allowlist() {
        let base = temp("broad-root");
        fs::create_dir_all(&base).unwrap();
        let path = base.join("config.json");
        let error = write_regular_file_atomic(&path, b"content", Path::new("/"))
            .expect_err("filesystem root allowlist must be rejected");
        assert!(error.contains("broad allowlisted root"), "{error}");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_directory_removal_preserves_non_empty_directory() {
        let base = temp("empty-dir");
        fs::create_dir_all(base.join("skill")).unwrap();
        fs::write(base.join("skill/user.txt"), b"user").unwrap();
        remove_empty_directory_no_symlinks(&base.join("skill"), &base).unwrap();
        assert!(base.join("skill/user.txt").is_file());
        fs::remove_file(base.join("skill/user.txt")).unwrap();
        remove_empty_directory_no_symlinks(&base.join("skill"), &base).unwrap();
        assert!(!base.join("skill").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_copy_rejects_destination_symlink() {
        let base = temp("reg-copy-sym-dst");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("src")).unwrap();
        fs::write(base.join("src/a.txt"), b"a").unwrap();
        fs::create_dir_all(base.join("dst")).unwrap();
        std::os::unix::fs::symlink(base.join("missing"), base.join("dst/a.txt")).unwrap();
        let err =
            copy_regular_file_no_symlinks(&base.join("src/a.txt"), &base.join("dst/a.txt"), &base)
                .expect_err("destination symlink must be rejected");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_copy_rejects_symlinked_parent() {
        let base = temp("reg-copy-sym-parent");
        let _ = fs::remove_dir_all(&base);
        let real = base.join("real");
        let linked = base.join("linked");
        fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        fs::create_dir_all(real.join("sub")).unwrap();
        fs::write(real.join("sub/a.txt"), b"a").unwrap();
        let dst = linked.join("sub/a.txt");
        let err = copy_regular_file_no_symlinks(&real.join("sub/a.txt"), &dst, &base)
            .expect_err("symlinked parent must be rejected");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn regular_file_remove_roundtrip() {
        let base = temp("reg-remove");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("dst")).unwrap();
        fs::write(base.join("dst/a.txt"), b"a").unwrap();
        remove_regular_file_no_symlinks(&base.join("dst/a.txt"), &base).unwrap();
        assert!(!base.join("dst/a.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_dangling_target() {
        let base = temp("remove-dangling");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let link = base.join("broken");
        std::os::unix::fs::symlink(base.join("missing"), &link).unwrap();
        let err = remove_dir_no_symlinks(&link, &base).expect_err("dangling removal");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn create_root_directory_creates_missing_ancestors() {
        let base = temp("root-create");
        fs::create_dir_all(&base).unwrap();
        let root = base.join("a/b/c");
        create_root_directory_all_no_symlinks(&root).unwrap();
        assert!(root.is_dir());
        create_root_directory_all_no_symlinks(&root).expect("idempotent");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn create_root_directory_refuses_symlinked_ancestor() {
        let base = temp("root-create-symlink");
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let err = create_root_directory_all_no_symlinks(&link.join("missing/root"))
            .expect_err("symlinked ancestor must be refused");
        assert!(err.contains("refusing symlinked ancestor"), "{err}");
        assert!(!real.join("missing").exists(), "nothing may be created");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn create_root_directory_refuses_file_ancestor() {
        let base = temp("root-create-file");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("file"), b"x").unwrap();
        let err = create_root_directory_all_no_symlinks(&base.join("file"))
            .expect_err("file root must be refused");
        assert!(
            err.contains("root creation ancestor is not a directory"),
            "{err}"
        );
        let err = create_root_directory_all_no_symlinks(&base.join("file/root"))
            .expect_err("file ancestor must be refused");
        assert!(err.contains("root creation ancestor"), "{err}");
        assert!(!base.join("file/root").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn create_directory_all_creates_nested_directories_within_root() {
        let base = temp("dir-create");
        fs::create_dir_all(&base).unwrap();
        let nested = base.join("x/y/z");
        create_directory_all_no_symlinks(&nested, &base).unwrap();
        assert!(nested.is_dir());
        let outside = base.parent().unwrap().join("aw-safe-fs-outside");
        let err = create_directory_all_no_symlinks(&outside, &base).expect_err("outside root");
        assert!(err.contains("escapes"), "{err}");
        assert!(!outside.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_nested_symlink_without_following_it() {
        let base = temp("remove-nested-symlink");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let tree = base.join("tree");
        fs::create_dir_all(tree.join("nested")).unwrap();
        std::os::unix::fs::symlink(&outside, tree.join("nested/link")).unwrap();
        let err = remove_dir_no_symlinks(&tree, &base).expect_err("nested symlink");
        assert!(err.contains("refusing symlink during removal"), "{err}");
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert!(fs::symlink_metadata(tree.join("nested/link")).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    fn deep_tree(base: &Path, levels: usize) -> std::path::PathBuf {
        let mut path = base.join("deep");
        for _ in 0..levels {
            path.push("d");
        }
        fs::create_dir_all(&path).unwrap();
        base.join("deep")
    }

    #[test]
    fn remove_and_copy_recursion_depth_is_bounded() {
        let base = temp("depth-bound");
        fs::create_dir_all(&base).unwrap();

        let too_deep = deep_tree(&base, MAX_RECURSE_DEPTH + 6);
        let err = copy_dir_no_symlinks(&too_deep, &base.join("copy-too-deep"), &base)
            .expect_err("copy depth bound");
        assert!(err.contains("max copy depth exceeded"), "{err}");
        let err = remove_dir_no_symlinks(&too_deep, &base).expect_err("removal depth bound");
        assert!(err.contains("max removal depth exceeded"), "{err}");
        fs::remove_dir_all(&too_deep).unwrap();

        let within = deep_tree(&base, MAX_RECURSE_DEPTH - 4);
        copy_dir_no_symlinks(&within, &base.join("copy-within"), &base).expect("copy in bound");
        remove_dir_no_symlinks(&within, &base).expect("removal in bound");
        assert!(!within.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn regular_file_removal_rejects_symlink_and_keeps_target() {
        let base = temp("reg-remove-symlink");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("target.txt"), b"keep").unwrap();
        let link = base.join("link.txt");
        std::os::unix::fs::symlink(base.join("target.txt"), &link).unwrap();
        let err = remove_regular_file_no_symlinks(&link, &base).expect_err("symlink removal");
        assert!(err.contains("symlink"), "{err}");
        assert_eq!(fs::read(base.join("target.txt")).unwrap(), b"keep");
        assert!(fs::symlink_metadata(&link).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn empty_directory_removal_rejects_symlink_and_keeps_target() {
        let base = temp("empty-dir-symlink");
        fs::create_dir_all(base.join("real")).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(base.join("real"), &link).unwrap();
        let err = remove_empty_directory_no_symlinks(&link, &base).expect_err("symlink removal");
        assert!(err.contains("symlink"), "{err}");
        assert!(base.join("real").is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_destination_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("atomic-mode");
        fs::create_dir_all(&base).unwrap();
        for mode in [0o600, 0o640, 0o444] {
            let path = base.join(format!("config-{mode:o}.toml"));
            fs::write(&path, b"one").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            write_regular_file_atomic(&path, b"two", &base).unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"two");
            assert_eq!(mode_of(&path), mode, "mode {mode:o} must survive a replace");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_temporary_file_is_owner_only_and_the_final_mode_is_unchanged() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let base = temp("atomic-temp-mode");
        fs::create_dir_all(&base).unwrap();

        // The creation mode of the temporary file, whatever the umask.
        let probe = base.join("probe");
        drop(create_new_file(&probe, true).unwrap());
        assert_eq!(mode_of(&probe), 0o600);

        // A new file that is not private ends with the mode a plain create gives.
        let plain = base.join("plain.txt");
        fs::write(&plain, b"x").unwrap();
        let plain_mode = mode_of(&plain);
        let fresh = base.join("fresh.txt");
        write_regular_file_atomic(&fresh, b"content", &base).unwrap();
        assert_eq!(mode_of(&fresh), plain_mode);
        let private = base.join("private.txt");
        write_private_regular_file_atomic(&private, b"content", &base).unwrap();
        assert_eq!(mode_of(&private), 0o600);
        assert!(
            fs::read_dir(&base).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".mode")),
            "the probe file is removed"
        );

        // Replacing a private (0600) file: no temporary file is ever readable by anyone else,
        // because it is created owner-only before it holds any content.
        for index in 0..3 {
            let path = base.join(format!("w{index}.txt"));
            fs::write(&path, b"old").unwrap();
            fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
                .unwrap();
        }
        let done = Arc::new(AtomicBool::new(false));
        let writer = {
            let (base, done) = (base.clone(), done.clone());
            std::thread::spawn(move || {
                let content = vec![b'a'; 256 * 1024];
                for index in 0..150 {
                    let path = base.join(format!("w{}.txt", index % 3));
                    write_regular_file_atomic(&path, &content, &base).unwrap();
                }
                done.store(true, Ordering::SeqCst);
            })
        };
        while !done.load(Ordering::SeqCst) {
            for entry in fs::read_dir(&base).unwrap().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".aw-") && name.ends_with(".tmp") {
                    if let Ok(metadata) = fs::symlink_metadata(entry.path()) {
                        use std::os::unix::fs::PermissionsExt;
                        assert_eq!(metadata.permissions().mode() & 0o077, 0, "{name}");
                    }
                }
            }
        }
        writer.join().unwrap();
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn copy_over_existing_file_preserves_destination_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("copy-mode");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("src.txt"), b"new").unwrap();
        fs::set_permissions(base.join("src.txt"), fs::Permissions::from_mode(0o644)).unwrap();
        let dst = base.join("dst.txt");
        fs::write(&dst, b"old").unwrap();
        fs::set_permissions(&dst, fs::Permissions::from_mode(0o600)).unwrap();
        copy_regular_file_no_symlinks(&base.join("src.txt"), &dst, &base).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"new");
        assert_eq!(mode_of(&dst), 0o600);
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn private_helpers_create_owner_only_directories_and_files() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("private-modes");
        let root = base.join("app-data/backups");
        create_private_root_directory_all_no_symlinks(&root).unwrap();
        assert_eq!(mode_of(&root), 0o700);
        assert_eq!(mode_of(&base.join("app-data")), 0o700);

        let txn = root.join("setup/123");
        create_private_directory_all_no_symlinks(&txn, &root).unwrap();
        assert_eq!(mode_of(&root.join("setup")), 0o700);
        assert_eq!(mode_of(&txn), 0o700);

        let src = base.join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();
        fs::write(src.join("nested/b.txt"), b"b").unwrap();
        fs::set_permissions(src.join("a.txt"), fs::Permissions::from_mode(0o644)).unwrap();

        copy_private_regular_file_no_symlinks(&src.join("a.txt"), &txn.join("artifacts/a"), &root)
            .unwrap();
        assert_eq!(mode_of(&txn.join("artifacts")), 0o700);
        assert_eq!(mode_of(&txn.join("artifacts/a")), 0o600);

        copy_private_dir_no_symlinks(&src, &txn.join("artifacts/tree"), &root).unwrap();
        assert_eq!(mode_of(&txn.join("artifacts/tree")), 0o700);
        assert_eq!(mode_of(&txn.join("artifacts/tree/nested")), 0o700);
        assert_eq!(mode_of(&txn.join("artifacts/tree/a.txt")), 0o600);
        assert_eq!(mode_of(&txn.join("artifacts/tree/nested/b.txt")), 0o600);

        write_private_regular_file_atomic(&txn.join("manifest.json"), b"{}", &root).unwrap();
        assert_eq!(mode_of(&txn.join("manifest.json")), 0o600);
        write_private_new_regular_file_synced(&txn.join("previous.json"), b"{}", &root).unwrap();
        assert_eq!(mode_of(&txn.join("previous.json")), 0o600);

        // Existing private files keep their mode on replace, with either writer.
        write_regular_file_atomic(&txn.join("manifest.json"), b"{\"v\":2}", &root).unwrap();
        assert_eq!(mode_of(&txn.join("manifest.json")), 0o600);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn atomic_write_survives_leftover_temporary_files_from_another_process() {
        let base = temp("atomic-leftover");
        fs::create_dir_all(&base).unwrap();
        let path = base.join("config.json");
        // A crashed earlier run with the same pid and the same counter values left
        // temporary files behind; the timestamp in the name keeps this run clear of them.
        let next = TEMP_FILE_SEQUENCE.load(Ordering::Relaxed);
        let leftovers: Vec<_> = (0..64u64)
            .map(|offset| {
                base.join(format!(
                    ".aw-{:x}-{:x}-{:x}.tmp",
                    std::process::id(),
                    1u128,
                    next + offset
                ))
            })
            .collect();
        for leftover in &leftovers {
            fs::write(leftover, b"stale").unwrap();
        }
        write_regular_file_atomic(&path, b"fresh", &base).expect("write beside leftovers");
        assert_eq!(fs::read(&path).unwrap(), b"fresh");
        for leftover in &leftovers {
            assert_eq!(fs::read(leftover).unwrap(), b"stale", "leftover untouched");
        }
        let _ = fs::remove_dir_all(&base);
    }
}
