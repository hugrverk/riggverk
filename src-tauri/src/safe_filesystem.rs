//! Bounded filesystem helpers for setup and deprecated-skill workflows.
//!
//! Copies and removes directory trees without following symlinks. Recursion is
//! depth-bounded to avoid stack overflow on pathological trees. Callers must
//! supply an explicit allowlisted root for destination containment checks.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

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
pub fn create_root_directory_all_no_symlinks(root: &Path) -> Result<(), String> {
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
        fs::create_dir(dir).map_err(|e| format!("create directory {}: {e}", dir.display()))?;
    }
    Ok(())
}

pub fn create_directory_all_no_symlinks(
    path: &Path,
    allowlisted_root: &Path,
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
        fs::create_dir(&current)
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
                fs::create_dir(&current)
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

pub fn write_regular_file_atomic(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("write destination has no parent: {}", path.display()))?;
    create_directory_all_no_symlinks(parent, allowlisted_root)?;
    validate_mutation_path(path, allowlisted_root, "atomic write destination")?;
    if fs::symlink_metadata(path).is_ok() && !path.is_file() {
        return Err(format!(
            "atomic write destination is not a regular file: {}",
            path.display()
        ));
    }
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid write destination name: {}", path.display()))?;
    let temp_path = parent.join(format!(".{file_name}.agent-workspace-{sequence}.tmp"));
    validate_mutation_path(&temp_path, allowlisted_root, "atomic write temporary file")?;
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| format!("create temporary file {}: {e}", temp_path.display()))?;
        output
            .write_all(content)
            .map_err(|e| format!("write temporary file {}: {e}", temp_path.display()))?;
        output
            .sync_all()
            .map_err(|e| format!("sync temporary file {}: {e}", temp_path.display()))?;
        validate_mutation_path(path, allowlisted_root, "atomic write destination")?;
        validate_mutation_path(&temp_path, allowlisted_root, "atomic write temporary file")?;
        replace_file_atomic(&temp_path, path)
            .map_err(|e| format!("replace destination {}: {e}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

pub fn write_new_regular_file_synced(
    path: &Path,
    content: &[u8],
    allowlisted_root: &Path,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("write destination has no parent: {}", path.display()))?;
    create_directory_all_no_symlinks(parent, allowlisted_root)?;
    validate_mutation_path(path, allowlisted_root, "create-new destination")?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
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
        create_directory_all_no_symlinks(parent, allowlisted_root)?;
    }
    create_directory_all_no_symlinks(dst, allowlisted_root)?;
    copy_dir_recurse(src, dst, 0)
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

fn copy_dir_recurse(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
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
            create_directory_all_no_symlinks(&target, dst)?;
            copy_dir_recurse(&entry.path(), &target, depth + 1)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "copy {} -> {}: {e}",
                    entry.path().display(),
                    target.display()
                )
            })?;
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
        create_directory_all_no_symlinks(parent, allowlisted_root)?;
    }
    validate_mutation_path(dst, allowlisted_root, "regular file copy destination")?;
    let content = fs::read(src).map_err(|e| format!("read copy source {}: {e}", src.display()))?;
    write_regular_file_atomic(dst, &content, allowlisted_root)
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

/// Reject symlinks at any depth within a directory tree (does not follow symlinks).
#[allow(dead_code)]
pub fn reject_nested_symlinks(dir: &Path, label: &str) -> Result<(), String> {
    reject_nested_symlinks_recurse(dir, label, 0)
}

fn reject_nested_symlinks_recurse(dir: &Path, label: &str, depth: usize) -> Result<(), String> {
    if depth > MAX_RECURSE_DEPTH {
        return Err(format!(
            "max symlink check depth exceeded in {}: {}",
            label,
            dir.display()
        ));
    }
    reject_symlink(dir, label)?;
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("entry error in {}: {e}", dir.display()))?;
        let path = entry.path();
        let ft = entry
            .file_type()
            .map_err(|e| format!("file type error: {e}"))?;
        if ft.is_symlink() {
            return Err(format!("nested symlink in {}: {}", label, path.display()));
        }
        if ft.is_dir() {
            reject_nested_symlinks_recurse(&path, label, depth + 1)?;
        }
    }
    Ok(())
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
        std::env::temp_dir().join(format!("aw-safe-fs-{label}-{n}"))
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
}
