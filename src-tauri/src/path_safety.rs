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
/// directory only that owner (or root) can rename or remove it. `private_group`: the folder's
/// group is the user's private group ([`user_private_gid`]), whose members may write it.
#[cfg(unix)]
pub(crate) fn folder_rule(
    dir: DirOwnership,
    child_uid: Option<u32>,
    euid: u32,
    admin_gid: Option<u32>,
    private_group: bool,
) -> Result<(), &'static str> {
    if dir.uid != 0 && dir.uid != euid {
        return Err("is owned by another user");
    }
    let trusted_group = dir.gid == 0 || Some(dir.gid) == admin_gid || private_group;
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

/// Why the folder that holds the user's data could be changed by someone other than the user, or
/// `None`: it must belong to the user and be writable by no one else, except the user's private
/// group (`private_group`).
#[cfg(unix)]
pub(crate) fn own_folder_rule(
    dir: DirOwnership,
    euid: u32,
    private_group: bool,
) -> Result<(), &'static str> {
    if dir.uid != euid {
        return Err("it is not owned by you");
    }
    if others_can_write(dir.mode, private_group) {
        return Err("it is writable by its group or by everyone");
    }
    Ok(())
}

/// Whether `mode` lets anyone but the owner write: everyone, or a group other than the user's
/// private group (`private_group`: the entry's group is [`user_private_gid`]).
#[cfg(unix)]
pub(crate) fn others_can_write(mode: u32, private_group: bool) -> bool {
    mode & 0o002 != 0 || (mode & 0o020 != 0 && !private_group)
}

/// Whether the group named `group` with `members` is the private group of the user named `user`:
/// it carries the user's name and lists no one else.
#[cfg(unix)]
fn is_private_group(user: &[u8], group: &[u8], members: &[Vec<u8>]) -> bool {
    group == user && members.iter().all(|member| member.as_slice() == user)
}

/// The user's primary group when it is the user's private group ([`is_private_group`]), as on
/// Linux distributions that give every user one; its members can then only be the user. `None`
/// otherwise, for example for macOS's `staff`, which every user shares. Looked up once.
#[cfg(unix)]
pub(crate) fn user_private_gid() -> Option<u32> {
    static GID: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *GID.get_or_init(|| private_gid_of(crate::skill_sources::effective_uid()))
}

#[cfg(unix)]
fn private_gid_of(uid: u32) -> Option<u32> {
    use std::ffi::CStr;
    let (user, gid) = with_lookup_buffer(libc::_SC_GETPW_R_SIZE_MAX, |buf| {
        // SAFETY: `passwd` is plain data; all-zero is a valid value that getpwuid_r overwrites.
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call and `buf.len()` is the buffer's size.
        let code =
            unsafe { libc::getpwuid_r(uid, &mut entry, buf.as_mut_ptr(), buf.len(), &mut found) };
        if code != 0 || found.is_null() {
            return Err(code);
        }
        // SAFETY: on success `pw_name` is a NUL-terminated string inside `buf`, still alive.
        let name = unsafe { CStr::from_ptr(entry.pw_name) }.to_bytes().to_vec();
        Ok((name, entry.pw_gid))
    })?;
    let (group, members) = with_lookup_buffer(libc::_SC_GETGR_R_SIZE_MAX, |buf| {
        // SAFETY: `group` is plain data; all-zero is a valid value that getgrgid_r overwrites.
        let mut entry: libc::group = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::group = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call and `buf.len()` is the buffer's size.
        let code =
            unsafe { libc::getgrgid_r(gid, &mut entry, buf.as_mut_ptr(), buf.len(), &mut found) };
        if code != 0 || found.is_null() {
            return Err(code);
        }
        // SAFETY: on success `gr_name` is a NUL-terminated string and `gr_mem` a NULL-terminated
        // array of them, all inside `buf`, still alive.
        let (name, members) = unsafe {
            let name = CStr::from_ptr(entry.gr_name).to_bytes().to_vec();
            let mut members = Vec::new();
            let mut cursor = entry.gr_mem;
            while !cursor.is_null() && !(*cursor).is_null() {
                members.push(CStr::from_ptr(*cursor).to_bytes().to_vec());
                cursor = cursor.add(1);
            }
            (name, members)
        };
        Ok((name, members))
    })?;
    is_private_group(&user, &group, &members).then_some(gid)
}

/// Runs a reentrant user or group lookup with a buffer of the size `sysconf(size_key)` suggests,
/// doubled while the call answers `ERANGE`. `None` when the entry is missing or the call fails.
#[cfg(unix)]
fn with_lookup_buffer<T>(
    size_key: libc::c_int,
    mut lookup: impl FnMut(&mut [libc::c_char]) -> Result<T, libc::c_int>,
) -> Option<T> {
    // SAFETY: sysconf takes a plain integer and has no preconditions.
    let suggested = unsafe { libc::sysconf(size_key) };
    let mut size = usize::try_from(suggested)
        .ok()
        .filter(|size| *size > 0)
        .unwrap_or(1024);
    loop {
        let mut buf = vec![0 as libc::c_char; size];
        match lookup(&mut buf) {
            Ok(value) => return Some(value),
            Err(libc::ERANGE) if size < 1 << 20 => size *= 2,
            Err(_) => return None,
        }
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
                // The missing rest goes back on, so the folder the link points to is checked too.
                let rest = path.strip_prefix(existing).unwrap_or(Path::new(""));
                check_chain_above(&resolved.join(rest), label)?;
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
            let private_group = Some(ownership.gid) == user_private_gid();
            folder_rule(
                ownership,
                child_uid,
                euid,
                trusted_admin_gid(),
                private_group,
            )
            .map_err(|why| {
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
/// unless it belongs to the user and only the user (or the user's private group) can write it, and
/// no folder above it can be changed by someone else ([`check_folders_above`]).
pub fn check_private_folder(dir: &Path, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::symlink_metadata(dir)
            .map_err(|e| format!("cannot inspect {label} {}: {e}", dir.display()))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(format!("{label} is not a folder: {}", dir.display()));
        }
        let ownership = DirOwnership {
            uid: meta.uid(),
            gid: meta.gid(),
            mode: meta.mode(),
        };
        let euid = crate::skill_sources::effective_uid();
        let private_group = Some(ownership.gid) == user_private_gid();
        if let Err(why) = own_folder_rule(ownership, euid, private_group) {
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
        let rule = |d, child, admin| folder_rule(d, child, euid, admin, false);
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
    fn the_users_private_group_may_write_the_folders() {
        let euid = 1000;
        let dir = |uid, gid, mode| DirOwnership { uid, gid, mode };
        // Above the folder: group-writable passes for the user's private group only.
        assert_eq!(
            folder_rule(dir(euid, 1000, 0o775), None, euid, None, true),
            Ok(())
        );
        assert_eq!(
            folder_rule(dir(euid, 1000, 0o775), None, euid, None, false),
            Err("is writable by its group or by everyone")
        );
        assert_eq!(
            folder_rule(dir(euid, 1000, 0o777), None, euid, None, true),
            Err("is writable by its group or by everyone")
        );
        // The folder itself: the same, and world write stays refused.
        assert_eq!(own_folder_rule(dir(euid, 1000, 0o775), euid, true), Ok(()));
        assert_eq!(own_folder_rule(dir(euid, 1000, 0o700), euid, false), Ok(()));
        assert_eq!(
            own_folder_rule(dir(euid, 1000, 0o775), euid, false),
            Err("it is writable by its group or by everyone")
        );
        assert_eq!(
            own_folder_rule(dir(euid, 1000, 0o777), euid, true),
            Err("it is writable by its group or by everyone")
        );
        assert_eq!(
            own_folder_rule(dir(euid, 1000, 0o757), euid, true),
            Err("it is writable by its group or by everyone")
        );
        assert_eq!(
            own_folder_rule(dir(0, 1000, 0o700), euid, true),
            Err("it is not owned by you")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_private_group_has_the_users_name_and_no_other_member() {
        let user = b"alex".to_vec();
        assert!(is_private_group(&user, b"alex", &[]));
        assert!(is_private_group(&user, b"alex", &[b"alex".to_vec()]));
        assert!(!is_private_group(&user, b"alex", &[b"sam".to_vec()]));
        assert!(!is_private_group(&user, b"staff", &[]));
        assert!(!is_private_group(&user, b"users", &[b"alex".to_vec()]));
    }

    /// Runs anywhere: a folder writable by its group passes only when that group is the user's
    /// private group, which a Linux user with a private group and umask 002 gets by default.
    #[cfg(unix)]
    #[test]
    fn a_folder_writable_by_its_group_passes_only_for_the_users_private_group() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let base = temp("own-group");
        let folder = base.join("data");
        crate::test_env::create_dir_all(&folder).unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o775)).unwrap();
        let group = fs::metadata(&folder).unwrap().gid();
        let private = user_private_gid() == Some(group);
        let own = check_private_folder(&folder, "data folder");
        assert_eq!(own.is_ok(), private, "group {group}: {own:?}");
        let above = check_folders_above(&folder.join("child"), "data folder");
        assert_eq!(above.is_ok(), private, "group {group}: {above:?}");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(check_private_folder(&folder, "data folder").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_shared_staff_group_is_not_a_private_group() {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(
            user_private_gid(),
            Some(20),
            "staff is shared by every user"
        );
        let base = temp("staff-group");
        let folder = base.join("data");
        fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::chown(&folder, None, Some(20)).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o775)).unwrap();
        let err = check_private_folder(&folder, "data folder").expect_err("staff can write it");
        assert!(
            err.contains("writable by its group or by everyone"),
            "{err}"
        );
        let err = check_folders_above(&folder.join("child"), "data folder")
            .expect_err("staff can write the folder above");
        assert!(
            err.contains("writable by its group or by everyone"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&base);
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
            assert!(
                err.contains("it is writable by its group or by everyone"),
                "{err}"
            );
        }
        set(&folder, 0o700);

        // Everyone can write a folder above, without the sticky bit.
        set(&base, 0o777);
        let err = check_private_folder(&folder, "data folder").expect_err("open ancestor");
        assert!(
            err.contains(&format!("the folder {} above it", base.display())),
            "{err}"
        );
        let err = check_folders_above(&folder.join("missing"), "data folder")
            .expect_err("open ancestor of a missing folder");
        assert!(
            err.contains("writable by its group or by everyone"),
            "{err}"
        );

        // With the sticky bit, the user's own folder in it cannot be replaced.
        set(&base, 0o1777);
        check_private_folder(&folder, "data folder").expect("sticky ancestor");
        set(&base, 0o755);
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_above_a_missing_path_is_checked_where_it_points() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("linked-above");
        let real = base.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&real, base.join("link")).unwrap();
        let missing = base.join("link/data/missing");
        fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();
        check_folders_above(&missing, "data folder").expect("private linked folder");
        fs::set_permissions(&real, fs::Permissions::from_mode(0o777)).unwrap();
        let err = check_folders_above(&missing, "data folder").expect_err("open linked folder");
        assert!(
            err.contains("writable by its group or by everyone"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_folder_above_writable_by_the_admin_group_is_accepted() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("admin-group");
        let folder = base.join("Cellar/tool");
        crate::test_env::create_dir_all(&folder).unwrap();
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
        assert!(
            err.contains("writable by its group or by everyone"),
            "{err}"
        );
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
