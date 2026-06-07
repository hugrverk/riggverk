use std::path::{Path, PathBuf};

/// Resolve an executable without invoking a shell or running the candidate.
pub fn resolve_executable(program: &str, path_env: &str, pathext: Option<&str>) -> Option<PathBuf> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return if is_executable_file(candidate, pathext) {
            Some(candidate.to_path_buf())
        } else {
            None
        };
    }

    if candidate.components().count() > 1 {
        return if is_executable_file(candidate, pathext) {
            Some(candidate.to_path_buf())
        } else {
            None
        };
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

fn resolve_with_extensions(base: &Path, pathext: Option<&str>) -> Option<PathBuf> {
    if is_executable_file(base, pathext) {
        return Some(base.to_path_buf());
    }
    let exts = pathext?;
    for ext in exts.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        let suffix = if ext.starts_with('.') {
            ext.to_string()
        } else {
            format!(".{ext}")
        };
        let candidate = PathBuf::from(format!("{}{}", base.display(), suffix));
        if is_executable_file(&candidate, pathext) {
            return Some(candidate);
        }
        if let Some(existing) = find_case_insensitive_match(base, &suffix) {
            return Some(existing);
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

fn is_executable_file(path: &Path, pathext: Option<&str>) -> bool {
    if !path.is_file() {
        return false;
    }
    if pathext.is_some() {
        return true;
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
