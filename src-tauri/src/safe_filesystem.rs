//! Bounded filesystem helpers for setup and deprecated-skill workflows.
//!
//! Copies and removes directory trees without following symlinks. Recursion is
//! depth-bounded to avoid stack overflow on pathological trees. Callers must
//! supply an explicit allowlisted root for destination containment checks.

use std::fs;
use std::path::Path;

use crate::path_safety::{ensure_within_root, reject_symlink, reject_symlink_parent_chain};

const MAX_RECURSE_DEPTH: usize = 64;

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
        fs::create_dir_all(parent)
            .map_err(|e| format!("create parent {}: {e}", parent.display()))?;
    }
    fs::create_dir_all(dst).map_err(|e| format!("create dir {}: {e}", dst.display()))?;
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
            fs::create_dir_all(&target)
                .map_err(|e| format!("create dir {}: {e}", target.display()))?;
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
    ensure_within_root(dst_parent, allowlisted_root, "regular file copy destination parent")?;
    reject_symlink_parent_chain(dst_parent, allowlisted_root, "regular file copy destination parent")?;

    if dst.exists() {
        if dst.is_symlink() || !dst.is_file() {
            return Err(format!("destination exists as non-regular file: {}", dst.display()));
        }
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create destination parent {}: {e}", parent.display()))?;
    }
    fs::copy(src, dst)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))?;
    Ok(())
}

/// Remove a regular file without following symlinks.
///
/// Validates the path for symlink safety and ensures it is within
/// `allowlisted_root`.
pub fn remove_regular_file_no_symlinks(path: &Path, allowlisted_root: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    reject_symlink(path, "regular file removal")?;
    ensure_within_root(path, allowlisted_root, "regular file removal")?;
    reject_symlink_parent_chain(path, allowlisted_root, "regular file removal")?;
    if !path.is_file() {
        return Err(format!("path is not a regular file: {}", path.display()));
    }
    fs::remove_file(path)
        .map_err(|e| format!("remove file {}: {e}", path.display()))?;
    Ok(())
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

    #[cfg(unix)]
    #[test]
    fn regular_file_copy_rejects_destination_symlink() {
        let base = temp("reg-copy-sym-dst");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("src")).unwrap();
        fs::write(base.join("src/a.txt"), b"a").unwrap();
        fs::create_dir_all(base.join("dst")).unwrap();
        std::os::unix::fs::symlink(base.join("missing"), base.join("dst/a.txt")).unwrap();
        let err = copy_regular_file_no_symlinks(
            &base.join("src/a.txt"),
            &base.join("dst/a.txt"),
            &base,
        )
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
        let err = copy_regular_file_no_symlinks(
            &real.join("sub/a.txt"),
            &dst,
            &base,
        )
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
