//! Bounded path safety checks for setup lifecycle mutations.
//!
//! Rejects symlinks on paths and in parent chains up to an allowlisted root.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Reject when `path` is a symlink, including dangling symlinks.
///
/// Missing paths that are not symlinks are allowed so safe descendants can be created.
pub fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot inspect {label} {}: {e}", path.display())),
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("refusing symlink {label}: {}", path.display()))
        }
        Ok(_) => Ok(()),
    }
}

/// Reject symlink ancestors from `path` up to (but not including) `allowlisted_root`.
///
/// Does not canonicalize through user-controlled symlinks. Stops at the first path
/// component matching `allowlisted_root` when walking upward from `path`.
pub fn reject_symlink_parent_chain(
    path: &Path,
    allowlisted_root: &Path,
    label: &str,
) -> Result<(), String> {
    reject_symlink(path, label)?;
    let root = normalize_allowlisted_root(allowlisted_root)?;
    let mut current = path.to_path_buf();
    loop {
        if paths_equal_under_root(&current, &root) {
            return Ok(());
        }
        let parent = match current.parent() {
            Some(p) if p != current.as_path() => p.to_path_buf(),
            _ => {
                return Err(format!(
                    "{label} escapes allowlisted root {}",
                    root.display()
                ));
            }
        };
        reject_symlink(&parent, &format!("{label} parent"))?;
        current = parent;
    }
}

/// Ensure `child` is contained within `allowlisted_root` using lexical components only.
pub fn reject_path_escape(
    child: &Path,
    allowlisted_root: &Path,
    label: &str,
) -> Result<(), String> {
    let root = normalize_allowlisted_root(allowlisted_root)?;
    let root_components: Vec<_> = root.components().collect();
    let child_abs = if child.is_absolute() {
        child.to_path_buf()
    } else {
        root.join(child)
    };
    let mut child_components = child_abs.components().peekable();
    for expected in &root_components {
        match child_components.next() {
            Some(actual) if component_eq(actual, expected) => {}
            _ => {
                return Err(format!(
                    "{label} escapes allowlisted root {}",
                    root.display()
                ));
            }
        }
    }
    for component in child_components {
        if matches!(component, Component::ParentDir) {
            return Err(format!(
                "{label} escapes allowlisted root {}",
                root.display()
            ));
        }
    }
    Ok(())
}

fn normalize_allowlisted_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err(format!(
            "allowlisted root must be absolute: {}",
            root.display()
        ));
    }
    Ok(root.to_path_buf())
}

fn paths_equal_under_root(path: &Path, root: &Path) -> bool {
    path.components().eq(root.components())
}

fn component_eq(a: Component<'_>, b: &Component<'_>) -> bool {
    match (a, b) {
        (Component::Normal(a), Component::Normal(b)) => a == *b,
        (Component::RootDir, Component::RootDir) => true,
        (Component::CurDir, Component::CurDir) => true,
        _ => false,
    }
}

/// Lexical containment plus symlink rejection; canonical comparison when paths exist.
pub fn ensure_within_root(child: &Path, root: &Path, label: &str) -> Result<(), String> {
    reject_symlink(child, label)?;
    reject_symlink(root, "destination root")?;
    reject_path_escape(child, root, label)?;
    if child.exists() {
        let canonical_child = child
            .canonicalize()
            .map_err(|e| format!("cannot resolve {label} {}: {e}", child.display()))?;
        let canonical_root = root
            .canonicalize()
            .map_err(|e| format!("cannot resolve destination root {}: {e}", root.display()))?;
        if canonical_child != canonical_root && !canonical_child.starts_with(&canonical_root) {
            return Err(format!(
                "{label} escapes destination root: {}",
                child.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(label: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-path-safety-{label}-{n}"))
    }

    #[test]
    fn safe_descendant_below_safe_parent_passes() {
        let root = temp("safe-root");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("child")).unwrap();
        let child = root.join("child/file.txt");
        fs::write(&child, b"x").unwrap();
        assert!(reject_symlink_parent_chain(&child, &root, "child").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_is_rejected() {
        let base = temp("dangling");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let link = base.join("broken-link");
        std::os::unix::fs::symlink(base.join("missing-target"), &link).unwrap();
        let err = reject_symlink(&link, "dangling").expect_err("dangling symlink");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_is_rejected() {
        let base = temp("sym-parent");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = base.join("linked");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let file = link.join("file.txt");
        fs::write(&file, b"x").unwrap();
        let err = reject_symlink_parent_chain(&file, &base, "file").expect_err("symlink parent");
        assert!(err.contains("symlink"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn path_outside_allowlisted_root_is_rejected() {
        let base = temp("escape-base");
        let _ = fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert!(
            reject_symlink_parent_chain(&outside, &root, "outside").is_err(),
            "path outside allowlisted root must be rejected"
        );
        let _ = fs::remove_dir_all(&base);
    }
}
