use std::fs;
use std::path::{Path, PathBuf};

use crate::cursor_profile_paths::{
    normalized_path_key, resolve_cursor_profile_paths, resolve_user_home,
};
use crate::platform_paths::{
    is_unc_share_root, is_windows_drive_root, reject_broad_write_root, Platform,
};

pub const VALID_SKILL_AGENTS: &[&str] = &["codex", "opencode", "claude", "cursor"];

pub fn validate_skill_name(name: &str, source: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("invalid skill name (empty) from {source}"));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!(
            "skill name contains path traversal: \"{name}\" from {source}"
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(format!(
            "invalid skill name: \"{name}\" from {source} (must be a-z0-9-)"
        ));
    }
    match name.chars().next() {
        Some(ch) if ch.is_ascii_lowercase() || ch.is_ascii_digit() => Ok(()),
        _ => Err(format!(
            "skill name must start with a-z0-9: \"{name}\" from {source}"
        )),
    }
}

pub fn validate_skill_agent(agent: &str) -> Result<(), String> {
    if VALID_SKILL_AGENTS.contains(&agent) {
        Ok(())
    } else {
        Err(format!("invalid agent: {agent}"))
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn validate_skill_dest_root(dest: &Path) -> Result<(), String> {
    if dest.as_os_str().is_empty() {
        return Err("skill destination root is empty".into());
    }
    let home = resolve_user_home()?;
    let platform = Platform::current();
    reject_broad_write_root(dest, &home, platform, "skill destination")?;
    if is_windows_drive_root(dest) {
        return Err(format!(
            "refusing Windows drive root skill destination: {}",
            dest.display()
        ));
    }
    if is_unc_share_root(dest) {
        return Err(format!(
            "refusing UNC skill destination root: {}",
            dest.display()
        ));
    }
    if dest.exists() {
        let meta = fs::symlink_metadata(dest)
            .map_err(|e| format!("cannot inspect skill destination root: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "refusing symlinked skill destination root: {}",
                dest.display()
            ));
        }
    }
    Ok(())
}

/// Global skill install destination for an agent target.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn agent_global_skills_dest(agent: &str) -> Result<PathBuf, String> {
    let home = resolve_user_home()?;
    let dest = match agent {
        "codex" => {
            let codex_home = std::env::var("CODEX_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            std::env::var("CODEX_SKILLS_PATH")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| codex_home.join("skills"))
        }
        "opencode" => std::env::var("OPENCODE_SKILLS_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config/opencode/skills")),
        "claude" => std::env::var("CLAUDE_SKILLS_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude/skills")),
        "cursor" => {
            if let Ok(path) = std::env::var("CURSOR_SKILLS_PATH") {
                if !path.trim().is_empty() {
                    PathBuf::from(path)
                } else {
                    resolve_cursor_profile_paths()?.skills
                }
            } else {
                resolve_cursor_profile_paths()?.skills
            }
        }
        _ => return Err(format!("invalid agent: {agent}")),
    };
    validate_skill_dest_root(&dest)?;
    Ok(dest)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn ensure_skill_dest_contained(dest_root: &Path, skill_name: &str) -> Result<PathBuf, String> {
    validate_skill_name(skill_name, "destination")?;
    validate_skill_dest_root(dest_root)?;
    if !dest_root.is_dir() {
        return Err(format!(
            "destination root does not exist: {}",
            dest_root.display()
        ));
    }

    let real_root = dest_root
        .canonicalize()
        .map_err(|e| format!("cannot resolve destination root: {e}"))?;
    if fs::symlink_metadata(&real_root)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "refusing symlinked destination root: {}",
            real_root.display()
        ));
    }
    let dest_dir = real_root.join(skill_name);

    if dest_dir.as_os_str().is_empty() || dest_dir == real_root || dest_dir == Path::new("/") {
        return Err(format!("unsafe destination path: {}", dest_dir.display()));
    }

    let child_key = normalized_path_key(&dest_dir);
    let root_key = normalized_path_key(&real_root);
    if child_key != root_key && !child_key.starts_with(&format!("{root_key}/")) {
        return Err(format!("destination outside root: {}", dest_dir.display()));
    }

    Ok(dest_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform_paths::{is_broad_write_root, Platform};

    #[test]
    fn rejects_unix_root_skill_destination() {
        let home = PathBuf::from("/Users/example");
        assert!(validate_skill_dest_root(Path::new("/")).is_err());
        assert!(is_broad_write_root(Path::new("/"), &home, Platform::Linux));
    }

    #[test]
    fn rejects_user_home_skill_destination() {
        let home = std::env::temp_dir().join("aw-home-root-test");
        let _ = fs::create_dir_all(&home);
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::set_var("CURSOR_SKILLS_PATH", &home);
        }
        assert!(validate_skill_dest_root(&home).is_err());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn rejects_windows_drive_root_skill_destination_model() {
        assert!(validate_skill_dest_root(Path::new(r"C:\")).is_err());
        assert!(validate_skill_dest_root(Path::new(r"C:")).is_err());
    }

    #[test]
    fn rejects_unc_skill_destination_model() {
        assert!(validate_skill_dest_root(Path::new(r"\\server\share\skills")).is_err());
    }

    #[test]
    fn accepts_valid_custom_skills_directory() {
        let custom = std::env::temp_dir().join("aw-valid-custom-skills");
        let _ = fs::create_dir_all(&custom);
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", custom.parent().unwrap());
            std::env::set_var("CURSOR_SKILLS_PATH", &custom);
        }
        assert!(validate_skill_dest_root(&custom).is_ok());
        let _ = fs::remove_dir_all(&custom);
    }

    #[test]
    fn default_agent_destinations_are_accepted() {
        let profile = std::env::temp_dir().join("aw-agent-dest-profile");
        let _ = fs::create_dir_all(&profile);
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", &profile);
            std::env::remove_var("CURSOR_SKILLS_PATH");
            std::env::remove_var("CODEX_SKILLS_PATH");
            std::env::remove_var("OPENCODE_SKILLS_PATH");
            std::env::remove_var("CLAUDE_SKILLS_PATH");
        }
        for agent in VALID_SKILL_AGENTS {
            assert!(
                agent_global_skills_dest(agent).is_ok(),
                "agent {agent} should resolve safely"
            );
        }
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn cursor_global_dest_uses_profile_skills_path() {
        let home = std::env::temp_dir().join("aw-cursor-profile-skills-test");
        let _ = fs::create_dir_all(&home);
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("CURSOR_SKILLS_PATH");
        }
        let dest = agent_global_skills_dest("cursor").expect("cursor dest");
        assert_eq!(dest, home.join(".cursor").join("skills"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn cursor_env_override_wins_over_default_profile() {
        let home = std::env::temp_dir().join("aw-cursor-env-override-home");
        let custom = std::env::temp_dir().join("aw-cursor-env-override-skills");
        let _ = fs::create_dir_all(&home);
        let _ = fs::create_dir_all(&custom);
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::set_var("CURSOR_SKILLS_PATH", &custom);
        }
        let dest = agent_global_skills_dest("cursor").expect("cursor dest");
        assert_eq!(dest, custom);
        let _ = fs::remove_dir_all(&custom);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn invalid_agent_is_rejected() {
        assert!(agent_global_skills_dest("gemini").is_err());
    }

    #[test]
    fn containment_rejects_path_traversal_skill_name() {
        let root = std::env::temp_dir().join("aw-skill-contain-root");
        let _ = std::fs::create_dir_all(&root);
        let err = ensure_skill_dest_contained(&root, "../outside").expect_err("escape");
        let _ = std::fs::remove_dir_all(&root);
        assert!(err.contains("path traversal"));
    }
}
