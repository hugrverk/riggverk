use std::path::{Path, PathBuf};

use crate::cursor_profile_paths::{
    normalized_path_key, resolve_cursor_profile_paths, resolve_user_home,
};

pub const VALID_SKILL_AGENTS: &[&str] = &["codex", "opencode", "claude", "cursor"];

pub fn validate_skill_name(name: &str, source: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("invalid skill name (empty) from {source}"));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("skill name contains path traversal: \"{name}\" from {source}"));
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

/// Global skill install destination for an agent target.
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
                    return Ok(PathBuf::from(path));
                }
            }
            resolve_cursor_profile_paths()?.skills
        }
        _ => return Err(format!("invalid agent: {agent}")),
    };
    Ok(dest)
}

pub fn ensure_skill_dest_contained(dest_root: &Path, skill_name: &str) -> Result<PathBuf, String> {
    validate_skill_name(skill_name, "destination")?;
    if !dest_root.is_dir() {
        return Err(format!(
            "destination root does not exist: {}",
            dest_root.display()
        ));
    }

    let real_root = dest_root
        .canonicalize()
        .map_err(|e| format!("cannot resolve destination root: {e}"))?;
    let dest_dir = real_root.join(skill_name);

    if dest_dir.as_os_str().is_empty() || dest_dir == real_root || dest_dir == Path::new("/") {
        return Err(format!(
            "unsafe destination path: {}",
            dest_dir.display()
        ));
    }

    let child_key = normalized_path_key(&dest_dir);
    let root_key = normalized_path_key(&real_root);
    if child_key != root_key && !child_key.starts_with(&format!("{root_key}/")) {
        return Err(format!(
            "destination outside root: {}",
            dest_dir.display()
        ));
    }

    Ok(dest_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvRestore {
        home: Option<String>,
        userprofile: Option<String>,
        cursor_skills: Option<String>,
    }

    impl EnvRestore {
        fn set(
            home: Option<&str>,
            userprofile: Option<&str>,
            cursor_skills: Option<&str>,
        ) -> Self {
            let previous = EnvRestore {
                home: std::env::var("HOME").ok(),
                userprofile: std::env::var("USERPROFILE").ok(),
                cursor_skills: std::env::var("CURSOR_SKILLS_PATH").ok(),
            };
            set_optional("HOME", home);
            set_optional("USERPROFILE", userprofile);
            set_optional("CURSOR_SKILLS_PATH", cursor_skills);
            previous
        }
    }

    fn set_optional(key: &str, value: Option<&str>) {
        match value {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            set_optional("HOME", self.home.as_deref());
            set_optional("USERPROFILE", self.userprofile.as_deref());
            set_optional("CURSOR_SKILLS_PATH", self.cursor_skills.as_deref());
        }
    }

    #[test]
    fn cursor_global_dest_uses_profile_skills_path() {
        let _guard = env_lock().lock().expect("env lock");
        let _restore = EnvRestore::set(None, Some(r"C:\Users\Example"), None);
        let dest = agent_global_skills_dest("cursor").expect("cursor dest");
        assert_eq!(dest, PathBuf::from(r"C:\Users\Example\.cursor\skills"));
    }

    #[test]
    fn cursor_env_override_wins_over_default_profile() {
        let custom = r"D:\custom-profile\skills";
        let _guard = env_lock().lock().expect("env lock");
        let _restore = EnvRestore::set(None, Some(r"C:\Users\Example"), Some(custom));
        let dest = agent_global_skills_dest("cursor").expect("cursor dest");
        assert_eq!(dest, PathBuf::from(custom));
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
