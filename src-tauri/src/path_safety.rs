//! Bounded path safety checks for managed installation mutations.
//!
//! Rejects symlinks (on Windows also junctions, which std reports as symlinks) on paths and
//! parent chains up to an allowlisted root. Other reparse points such as cloud placeholders are
//! allowed.

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

/// Owner, group and mode bits of a directory, the only metadata [`folder_rule`] reads.
#[cfg(unix)]
#[derive(Clone, Copy)]
pub(crate) struct DirOwnership {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
}

/// The group, besides root's (gid 0), whose members may write a folder on the way to the user's
/// data or programs: on macOS the administrators (`admin`, gid 80), who own the Homebrew prefix.
#[cfg(unix)]
pub(crate) const fn trusted_admin_gid() -> Option<u32> {
    if cfg!(target_os = "macos") {
        Some(80)
    } else {
        None
    }
}

/// Why someone other than the user (`euid`) or root could change what directory `dir` holds, or
/// `None`. `child_uid` owns the entry below `dir` on the path, if it exists: in a sticky
/// directory only that owner (or root) can rename or remove it.
#[cfg(unix)]
pub(crate) fn folder_rule(
    dir: DirOwnership,
    child_uid: Option<u32>,
    euid: u32,
    admin_gid: Option<u32>,
) -> Result<(), &'static str> {
    if dir.uid != 0 && dir.uid != euid {
        return Err("is owned by another user");
    }
    let trusted_group = dir.gid == 0 || Some(dir.gid) == admin_gid;
    let others_write = dir.mode & 0o002 != 0 || (dir.mode & 0o020 != 0 && !trusted_group);
    if !others_write {
        return Ok(());
    }
    if dir.mode & 0o1000 == 0 {
        return Err("is writable by its group or by everyone");
    }
    match child_uid {
        Some(uid) if uid != 0 && uid != euid => {
            Err("is writable by everyone and the entry in it is owned by another user")
        }
        _ => Ok(()),
    }
}

/// Refuses `path` when a folder above it can be changed by someone other than the user or root
/// ([`folder_rule`]). Walks the path as written and, when a link on it resolves elsewhere, the
/// resolved path too. Missing entries are skipped, so the caller can create them.
pub fn check_folders_above(path: &Path, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        check_chain_above(path, label)?;
        if let Some(existing) = path.ancestors().find(|entry| entry.exists()) {
            let resolved = fs::canonicalize(existing)
                .map_err(|e| format!("cannot resolve {label} {}: {e}", existing.display()))?;
            if resolved != existing {
                check_chain_above(&resolved, label)?;
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, label);
        Ok(())
    }
}

#[cfg(unix)]
fn check_chain_above(path: &Path, label: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let euid = crate::skill_sources::effective_uid();
    let mut child_uid = fs::symlink_metadata(path).ok().map(|meta| meta.uid());
    for dir in path.ancestors().skip(1) {
        let meta = fs::symlink_metadata(dir).ok();
        if let Some(meta) = meta.as_ref().filter(|meta| meta.is_dir()) {
            let ownership = DirOwnership {
                uid: meta.uid(),
                gid: meta.gid(),
                mode: meta.mode(),
            };
            folder_rule(ownership, child_uid, euid, trusted_admin_gid()).map_err(|why| {
                format!(
                    "refusing {label} {}: the folder {} above it {why}; it and the folders \
                     above it must belong to you or root and not be writable by others",
                    path.display(),
                    dir.display()
                )
            })?;
        }
        child_uid = meta.map(|meta| meta.uid());
    }
    Ok(())
}

/// Refuses the existing folder `dir` that holds the user's data (data folder, backup folder)
/// unless it belongs to the user and only the user can write it, and no folder above it can be
/// changed by someone else ([`check_folders_above`]).
pub fn check_private_folder(dir: &Path, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::symlink_metadata(dir)
            .map_err(|e| format!("cannot inspect {label} {}: {e}", dir.display()))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!("{label} is not a folder: {}", dir.display()));
        }
        let why = if meta.uid() != crate::skill_sources::effective_uid() {
            Some("it is not owned by you")
        } else if meta.mode() & 0o022 != 0 {
            Some("it is writable by its group or by everyone")
        } else {
            None
        };
        if let Some(why) = why {
            return Err(format!(
                "refusing {label} {}: {why}; it must belong to you and not be writable by others",
                dir.display()
            ));
        }
    }
    check_folders_above(dir, label)
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

    #[cfg(unix)]
    #[test]
    fn folder_rule_accepts_only_folders_the_user_or_root_controls() {
        let euid = 501;
        let dir = |uid, gid, mode| DirOwnership { uid, gid, mode };
        let rule = |d, child, admin| folder_rule(d, child, euid, admin);
        assert_eq!(rule(dir(euid, 20, 0o755), None, None), Ok(()));
        assert_eq!(rule(dir(0, 0, 0o755), Some(euid), None), Ok(()));
        // Another user's folder: cannot be created here, so only the rule is tested.
        assert_eq!(
            rule(dir(502, 20, 0o755), None, None),
            Err("is owned by another user")
        );
        // Group-writable: root's group always, the admin group only where it is trusted.
        assert_eq!(rule(dir(euid, 0, 0o775), None, None), Ok(()));
        assert_eq!(rule(dir(euid, 80, 0o775), None, Some(80)), Ok(()));
        assert_eq!(
            rule(dir(euid, 80, 0o775), None, None),
            Err("is writable by its group or by everyone")
        );
        assert_eq!(
            rule(dir(euid, 20, 0o775), None, Some(80)),
            Err("is writable by its group or by everyone")
        );
        assert_eq!(
            rule(dir(0, 0, 0o777), Some(euid), None),
            Err("is writable by its group or by everyone")
        );
        // Sticky: others can add entries but not replace the one on the path.
        assert_eq!(rule(dir(0, 0, 0o1777), Some(euid), None), Ok(()));
        assert_eq!(rule(dir(0, 0, 0o1777), Some(0), None), Ok(()));
        assert_eq!(rule(dir(0, 0, 0o1777), None, None), Ok(()));
        assert!(rule(dir(0, 0, 0o1777), Some(502), None).is_err());
        assert!(rule(dir(euid, 20, 0o1775), Some(502), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_folder_checks_the_folder_and_every_folder_above_it() {
        use std::os::unix::fs::PermissionsExt;
        let set = |path: &Path, mode| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
        };
        let base = temp("private-folder");
        let folder = base.join("mid/data");
        fs::create_dir_all(&folder).unwrap();
        set(&base, 0o755);
        set(&base.join("mid"), 0o755);
        set(&folder, 0o700);
        check_private_folder(&folder, "data folder").expect("owner-only folder");
        check_folders_above(&folder.join("missing/child"), "data folder").expect("missing below");

        for mode in [0o777, 0o775, 0o757] {
            set(&folder, mode);
            let err = check_private_folder(&folder, "data folder").expect_err("open folder");
            assert!(err.contains("it is writable by its group or by everyone"), "{err}");
        }
        set(&folder, 0o700);

        // Everyone can write a folder above, without the sticky bit.
        set(&base, 0o777);
        let err = check_private_folder(&folder, "data folder").expect_err("open ancestor");
        assert!(err.contains(&format!("the folder {} above it", base.display())), "{err}");
        let err = check_folders_above(&folder.join("missing"), "data folder")
            .expect_err("open ancestor of a missing folder");
        assert!(err.contains("writable by its group or by everyone"), "{err}");

        // With the sticky bit, the user's own folder in it cannot be replaced.
        set(&base, 0o1777);
        check_private_folder(&folder, "data folder").expect("sticky ancestor");
        set(&base, 0o755);
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_above_writable_by_the_admin_group_is_accepted() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("admin-group");
        let folder = base.join("Cellar/tool");
        fs::create_dir_all(&folder).unwrap();
        let cellar = base.join("Cellar");
        // The Homebrew layout: the user's folder, group admin, writable by the group.
        if std::os::unix::fs::chown(&cellar, None, Some(80)).is_err() {
            eprintln!("skipped: the user cannot give a folder to the admin group here");
            let _ = fs::remove_dir_all(&base);
            return;
        }
        fs::set_permissions(&cellar, fs::Permissions::from_mode(0o775)).unwrap();
        check_folders_above(&folder.join("bin/tool"), "program").expect("admin group folder");
        std::os::unix::fs::chown(&cellar, None, Some(20)).unwrap();
        let err = check_folders_above(&folder.join("bin/tool"), "program")
            .expect_err("a group-writable folder of another group");
        assert!(err.contains("writable by its group or by everyone"), "{err}");
        let _ = fs::remove_dir_all(&base);
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
        let mut children = vec![
            root.join("..").join("x"),
            root.join("a").join("..").join("..").join("x"),
            PathBuf::from("..").join("x"),
            PathBuf::from("a").join("..").join("..").join("x"),
        ];
        // Unix keeps `..` lexically, so any parent component is refused. Joining onto a
        // verbatim Windows root normalizes `a\..\b` to `b`, which stays inside the root.
        if cfg!(not(windows)) {
            children.push(root.join("a").join("..").join("b"));
        }
        for child in children {
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
