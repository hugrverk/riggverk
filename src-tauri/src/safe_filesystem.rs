//! Bounded filesystem helpers for setup and deprecated-skill workflows.
//!
//! Copies and removes directory trees without following symlinks. Recursion is
//! depth-bounded to avoid stack overflow on pathological trees.

use std::fs;
use std::path::Path;

use crate::path_safety::reject_symlink;

const MAX_RECURSE_DEPTH: usize = 64;

/// Copy a directory tree without following symlinks.
pub fn copy_dir_no_symlinks(src: &Path, dst: &Path) -> Result<(), String> {
    reject_symlink(src, "copy source")?;
    fs::create_dir_all(dst).map_err(|e| format!("create dir {}: {e}", dst.display()))?;
    copy_dir_recurse(src, dst, 0)
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
pub fn remove_dir_no_symlinks(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    reject_symlink(path, "removal target")?;
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

/// Reject symlinks at any depth within a directory tree (does not follow symlinks).
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
        copy_dir_no_symlinks(&src, &dst).unwrap();
        assert!(dst.join("nested/a.txt").is_file());
        remove_dir_no_symlinks(&dst).unwrap();
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
        let err = copy_dir_no_symlinks(&src, &dst).expect_err("symlink in source");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }
}
