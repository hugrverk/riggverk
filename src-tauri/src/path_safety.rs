//! Bounded path safety checks for managed installation mutations.
//!
//! Rejects symlinks on paths and in parent chains up to an allowlisted root.

use std::ffi::OsStr;
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
    let mut path_components = path.components();
    let mut root_components = root.components();
    loop {
        match (path_components.next(), root_components.next()) {
            (None, None) => return true,
            (Some(actual), Some(expected)) if component_eq(actual, &expected) => {}
            _ => return false,
        }
    }
}

fn component_eq(a: Component<'_>, b: &Component<'_>) -> bool {
    match (a, b) {
        (Component::Prefix(a), Component::Prefix(b)) => os_str_eq(a.as_os_str(), b.as_os_str()),
        (Component::Normal(a), Component::Normal(b)) => os_str_eq(a, b),
        (Component::RootDir, Component::RootDir) => true,
        (Component::CurDir, Component::CurDir) => true,
        _ => false,
    }
}

fn os_str_eq(a: &OsStr, b: &OsStr) -> bool {
    #[cfg(windows)]
    {
        let a = a.to_string_lossy();
        let b = b.to_string_lossy();
        a.eq_ignore_ascii_case(&b)
    }
    #[cfg(not(windows))]
    {
        a == b
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
        // Canonical base: on macOS /var is a symlink to /private/var and would
        // mask symlink-ancestor bugs behind an unrelated rejection.
        fs::canonicalize(std::env::temp_dir())
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(format!("aw-path-safety-{label}-{n}"))
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

    #[cfg(windows)]
    #[test]
    fn windows_drive_prefix_descendant_passes() {
        let root = PathBuf::from(r"C:\Users\runneradmin\AppData\Local\Temp\aw-root");
        let child = PathBuf::from(r"c:\users\runneradmin\AppData\Local\Temp\aw-root\child");
        assert!(reject_path_escape(&child, &root, "child").is_ok());
    }

    fn root_under_canonical_temp(label: &str) -> PathBuf {
        let root = temp(label).join("root");
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn reject_path_escape_rejects_parent_dir_components() {
        let root = root_under_canonical_temp("escape-parent");
        // Built from components: canonical roots on Windows are verbatim (`\\?\\C:\\...`),
        // where "/" is not a separator.
        for child in [
            root.join("..").join("x"),
            root.join("a").join("..").join("..").join("x"),
            root.join("a").join("..").join("b"),
            PathBuf::from("..").join("x"),
            PathBuf::from("a").join("..").join("..").join("x"),
        ] {
            let err = reject_path_escape(&child, &root, "child")
                .expect_err(&format!("{} must be rejected", child.display()));
            assert!(
                err.contains("child escapes allowlisted root"),
                "{}: {err}",
                child.display()
            );
        }
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn reject_path_escape_rejects_paths_outside_the_root() {
        let root = root_under_canonical_temp("escape-foreign");
        let sibling_with_shared_prefix = root.with_file_name("root-evil").join("file");
        for child in [
            root.parent().unwrap().join("outside/file"),
            sibling_with_shared_prefix,
            PathBuf::from("/etc/passwd"),
            PathBuf::from("/"),
        ] {
            let err = reject_path_escape(&child, &root, "child")
                .expect_err(&format!("{} must be rejected", child.display()));
            assert!(
                err.contains("child escapes allowlisted root"),
                "{}: {err}",
                child.display()
            );
        }
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn reject_path_escape_accepts_descendants_and_the_root_itself() {
        let root = root_under_canonical_temp("escape-ok");
        for child in [
            root.clone(),
            root.join("a"),
            root.join("a/b/c.txt"),
            PathBuf::from("a/b"),
        ] {
            reject_path_escape(&child, &root, "child")
                .unwrap_or_else(|e| panic!("{} rejected: {e}", child.display()));
        }
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn relative_allowlisted_root_is_rejected() {
        let err = reject_path_escape(Path::new("a/b"), Path::new("a"), "child")
            .expect_err("relative root");
        assert!(err.contains("allowlisted root must be absolute"), "{err}");
        let err = reject_symlink_parent_chain(Path::new("a/b"), Path::new("a"), "child")
            .expect_err("relative root");
        assert!(err.contains("allowlisted root must be absolute"), "{err}");
    }

    #[test]
    fn parent_chain_walk_reaching_the_filesystem_root_is_an_escape() {
        // The temp base is canonical, so no symlink ancestor can end the walk
        // early: only the escape rule can reject this path.
        let base = temp("chain-escape");
        let root = base.join("root");
        let outside = base.join("outside/child");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let err = reject_symlink_parent_chain(&outside, &root, "outside")
            .expect_err("path outside the root");
        assert!(err.contains("outside escapes allowlisted root"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn reject_symlink_reports_inspection_errors_other_than_not_found() {
        let base = temp("inspect-error");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("file"), b"x").unwrap();
        let err = reject_symlink(&base.join("file/child"), "child").expect_err("ENOTDIR");
        assert!(err.contains("cannot inspect child"), "{err}");
        assert!(reject_symlink(&base.join("missing"), "child").is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_within_root_rejects_existing_child_reached_through_symlinked_parent() {
        let base = temp("within-canonical");
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        // Lexically inside the root and not itself a symlink: only the
        // canonical comparison can see that it resolves outside.
        let err = ensure_within_root(&root.join("link/secret.txt"), &root, "child")
            .expect_err("resolves outside the root");
        assert!(err.contains("child escapes destination root"), "{err}");
        ensure_within_root(&root, &root, "root").expect("root contains itself");
        let _ = fs::remove_dir_all(&base);
    }
}
