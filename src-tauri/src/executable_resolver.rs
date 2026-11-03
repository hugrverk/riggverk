use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Resolve an executable without invoking a shell or running the candidate.
pub fn resolve_executable(program: &str, path_env: &str, pathext: Option<&str>) -> Option<PathBuf> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }

    #[cfg(windows)]
    let windows_pathext = std::env::var("PATHEXT").ok();
    #[cfg(windows)]
    let pathext = Some(default_windows_pathext(
        pathext.or(windows_pathext.as_deref()),
    ));
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() || candidate.components().count() > 1 {
        return resolve_with_extensions(candidate, pathext);
    }

    let delimiter = if cfg!(windows) { ';' } else { ':' };
    for dir in path_env.split(delimiter) {
        let dir = dir.trim();
        if dir.is_empty() {
            continue;
        }
        let base = Path::new(dir).join(trimmed);
        if let Some(found) = resolve_with_extensions(&base, pathext) {
            return Some(found);
        }
    }
    None
}

#[cfg(any(test, windows))]
fn default_windows_pathext(pathext: Option<&str>) -> &str {
    pathext.unwrap_or(".COM;.EXE;.BAT;.CMD")
}

fn windows_extensions(pathext: &str) -> Vec<String> {
    let mut extensions: Vec<String> = pathext
        .split(';')
        .map(|ext| ext.trim().trim_start_matches('.').to_ascii_uppercase())
        .filter(|ext| matches!(ext.as_str(), "EXE" | "CMD" | "BAT" | "COM"))
        .collect();
    extensions.sort_by_key(|ext| match ext.as_str() {
        "EXE" => 0,
        "CMD" => 1,
        _ => 2,
    });
    extensions.dedup();
    extensions
}

fn resolve_with_extensions(base: &Path, pathext: Option<&str>) -> Option<PathBuf> {
    let Some(pathext) = pathext else {
        return is_executable_file(base, None).then(|| base.to_path_buf());
    };
    let extensions = windows_extensions(pathext);
    if base.extension().is_some_and(|ext| {
        extensions
            .iter()
            .any(|allowed| ext.eq_ignore_ascii_case(allowed))
    }) {
        return base.is_file().then(|| base.to_path_buf());
    }
    for ext in extensions {
        let suffix = format!(".{ext}");
        let mut name = base.as_os_str().to_os_string();
        name.push(&suffix);
        let candidate = PathBuf::from(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if let Some(existing) = find_case_insensitive_match(base, &suffix) {
            if existing.is_file() {
                return Some(existing);
            }
        }
    }
    None
}

fn find_case_insensitive_match(base: &Path, suffix: &str) -> Option<PathBuf> {
    let parent = base.parent()?;
    let stem = base.file_name()?.to_string_lossy();
    let target = format!("{stem}{suffix}").to_ascii_lowercase();
    for entry in std::fs::read_dir(parent).ok()? {
        let entry = entry.ok()?;
        if entry.file_name().to_string_lossy().to_ascii_lowercase() == target {
            return Some(entry.path());
        }
    }
    None
}

pub(crate) fn is_executable_file(path: &Path, pathext: Option<&str>) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(windows)]
    let pathext = Some(default_windows_pathext(pathext));
    if let Some(pathext) = pathext {
        return path.extension().is_some_and(|ext| {
            windows_extensions(pathext)
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// On Unix, the file `path` runs, links resolved, or `None` when it or its folder is owned by
/// someone other than root or the current user or is writable by its group or by everyone: another
/// local user could then choose what runs. Run the returned path, so a link changed later is not
/// followed. Elsewhere, `path` as it is.
pub(crate) fn trusted_executable(path: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let resolved = std::fs::canonicalize(path).ok()?;
        let folder = resolved.parent().unwrap_or(&resolved);
        for entry in [resolved.as_path(), folder] {
            let meta = std::fs::metadata(entry).ok()?;
            let owner = [0, crate::skill_sources::effective_uid()].contains(&meta.uid());
            if !owner || meta.mode() & 0o022 != 0 {
                return None;
            }
        }
        Some(resolved)
    }
    #[cfg(not(unix))]
    {
        Some(path.to_path_buf())
    }
}

/// Every `python3` in `tool_dirs` (the folders a GUI launch lacks, [`tool_dirs`]) and then on
/// `path` (the process `PATH`), each once. Tool folders come first: a Finder launch has `/usr/bin`
/// first on `PATH`, and running its `python3` stub without the Command Line Tools opens their
/// installer.
pub(crate) fn python3_candidates(tool_dirs: Vec<PathBuf>, path: Option<OsString>) -> Vec<PathBuf> {
    let mut dirs = tool_dirs;
    if let Some(path) = path {
        dirs.extend(std::env::split_paths(&path));
    }
    let pathext = std::env::var("PATHEXT").ok();
    let mut found: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        let Some(dir) = dir.to_str().filter(|dir| !dir.is_empty()) else {
            continue;
        };
        if let Some(python) = resolve_executable("python3", dir, pathext.as_deref()) {
            if !found.contains(&python) {
                found.push(python);
            }
        }
    }
    found
}

/// Returns `current` with every existing directory from `fallbacks` that is not already on it
/// appended, or `None` when nothing changes. Append-only so system tools earlier on the path
/// are never shadowed. An unset or empty `current` is left alone.
pub(crate) fn append_missing_path_dirs(current: &OsStr, fallbacks: &[PathBuf]) -> Option<OsString> {
    if current.is_empty() {
        return None;
    }
    let mut dirs: Vec<PathBuf> = std::env::split_paths(current).collect();
    let mut changed = false;
    for dir in fallbacks {
        if dir.is_dir() && !dirs.contains(dir) {
            dirs.push(dir.clone());
            changed = true;
        }
    }
    if changed {
        std::env::join_paths(dirs).ok()
    } else {
        None
    }
}

/// Add existing tool directories to PATH once at startup before other threads exist.
pub fn extend_path_with_tool_dirs() {
    let Some(current) = std::env::var_os("PATH") else {
        return;
    };
    if let Some(updated) = append_missing_path_dirs(&current, &tool_dirs()) {
        std::env::set_var("PATH", updated);
    }
}

/// Tool folders to append to PATH, in search order.
#[cfg(any(test, target_os = "linux"))]
fn linux_tool_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"), // residue-allow: the Linux Homebrew prefix, not a user home
    ];
    if let Some(home) = home {
        for dir in [
            ".local/bin",
            ".opencode/bin",
            ".linuxbrew/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
        ] {
            dirs.push(home.join(dir));
        }
    }
    dirs
}

#[cfg(any(test, windows))]
fn windows_tool_dirs(
    home: Option<&Path>,
    appdata: Option<&Path>,
    local_appdata: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = appdata {
        dirs.push(appdata.join("npm"));
    }
    if let Some(home) = home {
        for dir in [
            ".bun/bin",
            ".cargo/bin",
            "scoop/shims",
            ".local/bin",
            ".opencode/bin",
        ] {
            dirs.push(home.join(dir));
        }
    }
    if let Some(local) = local_appdata {
        for dir in ["Programs/opencode/bin", "Programs/Claude"] {
            dirs.push(local.join(dir));
        }
    }
    dirs
}

pub(crate) fn tool_dirs() -> Vec<PathBuf> {
    let home = crate::cursor_profile_paths::resolve_user_home().ok();
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        windows_tool_dirs(home.as_deref(), appdata.as_deref(), local.as_deref())
    }
    #[cfg(target_os = "linux")]
    {
        linux_tool_dirs(home.as_deref())
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let mut dirs = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        if let Some(home) = home {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".opencode/bin"));
        }
        dirs
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = home;
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_bin_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-exec-{name}-{nonce}"));
        fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[cfg(unix)]
    #[test]
    fn absolute_executable_path_is_accepted() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_bin_dir("abs");
        let script = dir.join("mytool");
        fs::write(&script, "#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let found = resolve_executable(&script.to_string_lossy(), "", None).expect("absolute");
        assert_eq!(found, script);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn path_lookup_finds_executable_in_path() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_bin_dir("path");
        let script = dir.join("aw-test-cmd");
        fs::write(&script, "#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let path_env = dir.to_string_lossy().into_owned();
        let found = resolve_executable("aw-test-cmd", &path_env, None).expect("found in PATH");
        assert_eq!(found, script);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_executable_returns_none() {
        let _guard = crate::test_env::guard::lock();
        assert!(
            resolve_executable("aw-definitely-missing-cmd-xyz", "/usr/bin:/bin", None).is_none()
        );
    }

    #[cfg(unix)]
    #[test]
    fn path_with_spaces_is_one_candidate() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_bin_dir("spaces");
        let nested = dir.join("My Tools");
        fs::create_dir_all(&nested).expect("nested");
        let script = nested.join("tool");
        fs::write(&script, "#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let path_env = nested.to_string_lossy().into_owned();
        let found = resolve_executable("tool", &path_env, None).expect("found");
        assert_eq!(found, script);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn empty_path_entries_are_skipped() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_bin_dir("empty-sep");
        let script = dir.join("aw-gap-cmd");
        fs::write(&script, "#!/bin/sh\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let delimiter = if cfg!(windows) { ';' } else { ':' };
        let path_env = format!(
            "{delimiter}{delimiter}{}{delimiter}{delimiter}",
            dir.display()
        );
        let found = resolve_executable("aw-gap-cmd", &path_env, None).expect("found");
        assert_eq!(found, script);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_pathext_lookup_finds_exe() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_bin_dir("pathext");
        let script = dir.join("aw-win-cmd.exe");
        fs::write(&script, "").expect("write");
        let path_env = dir.to_string_lossy().into_owned();
        let found = resolve_executable("aw-win-cmd", &path_env, Some(".EXE;.CMD;.BAT;.COM"))
            .expect("pathext");
        assert_eq!(
            found
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase()),
            script
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_resolution_prefers_exe_then_cmd_and_skips_shims() {
        assert_eq!(
            windows_extensions(default_windows_pathext(None)),
            ["EXE", "CMD", "COM", "BAT"]
        );
        let dir = temp_bin_dir("windows-order");
        for name in ["tool", "tool.cmd", "tool.exe", "other", "other.bat"] {
            fs::write(dir.join(name), "").unwrap();
        }
        let path = dir.to_str().unwrap();
        let canonical = |path: Option<PathBuf>| fs::canonicalize(path.unwrap()).unwrap();
        assert_eq!(
            canonical(resolve_executable(
                "tool",
                path,
                Some(".COM;.BAT;.CMD;.EXE")
            )),
            fs::canonicalize(dir.join("tool.exe")).unwrap()
        );
        fs::remove_file(dir.join("tool.exe")).unwrap();
        assert_eq!(
            canonical(resolve_executable(
                "tool",
                path,
                Some(".COM;.BAT;.CMD;.EXE")
            )),
            fs::canonicalize(dir.join("tool.cmd")).unwrap()
        );
        assert_eq!(
            canonical(resolve_executable(
                &dir.join("other").to_string_lossy(),
                "",
                Some(".BAT")
            )),
            fs::canonicalize(dir.join("other.bat")).unwrap()
        );
        assert!(resolve_executable("tool", path, Some(".PS1")).is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn platform_tool_directories_are_derived_from_supplied_roots() {
        let home = Path::new("home");
        let linux = linux_tool_dirs(Some(home));
        for dir in [
            ".local/bin",
            ".linuxbrew/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
        ] {
            assert!(linux.contains(&home.join(dir)));
        }
        assert!(linux.contains(&PathBuf::from("/home/linuxbrew/.linuxbrew/bin"))); // residue-allow: Homebrew prefix
        let windows = windows_tool_dirs(
            Some(home),
            Some(Path::new("roaming")),
            Some(Path::new("local")),
        );
        for dir in [".bun/bin", ".cargo/bin", "scoop/shims"] {
            assert!(windows.contains(&home.join(dir)));
        }
        assert!(windows.contains(&PathBuf::from("roaming/npm")));
        assert!(windows.contains(&PathBuf::from("local/Programs/opencode/bin")));
        assert!(!windows.contains(&PathBuf::from("local/Programs")));
        assert!(windows_tool_dirs(None, None, None).is_empty());
    }

    fn path_list(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).expect("join paths")
    }

    #[test]
    fn path_merge_appends_existing_missing_dirs_after_current_entries() {
        let first = temp_bin_dir("merge-first");
        let extra = temp_bin_dir("merge-extra");
        let current = path_list(&[Path::new("/usr/bin"), &first]);
        let merged = append_missing_path_dirs(&current, std::slice::from_ref(&extra))
            .expect("extra dir appended");
        let dirs: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(
            dirs,
            vec![PathBuf::from("/usr/bin"), first.clone(), extra.clone()]
        );
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&extra);
    }

    #[test]
    fn path_merge_skips_missing_and_already_present_dirs() {
        let present = temp_bin_dir("merge-present");
        let missing = std::env::temp_dir().join("aw-exec-merge-does-not-exist-xyz");
        let current = path_list(&[&present]);
        assert!(append_missing_path_dirs(&current, &[present.clone(), missing]).is_none());
        let _ = fs::remove_dir_all(&present);
    }

    #[test]
    fn path_merge_leaves_empty_path_untouched() {
        let extra = temp_bin_dir("merge-empty");
        assert!(append_missing_path_dirs(OsStr::new(""), std::slice::from_ref(&extra)).is_none());
        let _ = fs::remove_dir_all(&extra);
    }

    #[test]
    fn invalid_candidate_file_is_rejected() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_bin_dir("invalid");
        let script = dir.join("not-executable");
        fs::write(&script, "").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o644)).expect("chmod");
            let path_env = dir.to_string_lossy().into_owned();
            assert!(resolve_executable("not-executable", &path_env, None).is_none());
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
