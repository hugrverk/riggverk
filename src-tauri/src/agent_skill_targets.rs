use std::path::{Path, PathBuf};

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

pub fn codex_home(home: &Path) -> PathBuf {
    std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"))
}

/// The Codex skills folder `$CODEX_HOME/skills` (`CODEX_SKILLS_PATH` when set), typically
/// `~/.codex/skills`.
///
/// Codex reads personal skills from `~/.agents/skills`, and still from here (deprecated, and
/// `.system` below it is Codex's own). The app installs here only when `CODEX_HOME` is customised,
/// so that Codex reads nothing outside its isolated home; otherwise skills go to
/// `~/.agents/skills` and copies older versions put in this folder are removed. See
/// `skill_roots::install_roots`.
pub fn codex_global_skills_dest(home: &Path) -> PathBuf {
    std::env::var("CODEX_SKILLS_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home(home).join("skills"))
}

/// `~/.agents/skills`: the folder Codex, OpenCode and Cursor all read personal skills from.
pub fn codex_legacy_skills_dest(home: &Path) -> PathBuf {
    home.join(".agents").join("skills")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_skills_folder_follows_codex_home_and_the_skills_path_override() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = std::env::temp_dir().join("aw-codex-skills-folder-home");
        unsafe {
            std::env::remove_var("CODEX_SKILLS_PATH");
            std::env::remove_var("CODEX_HOME");
        }
        assert_eq!(
            codex_global_skills_dest(&home),
            home.join(".codex").join("skills")
        );
        assert_eq!(
            codex_legacy_skills_dest(&home),
            home.join(".agents").join("skills")
        );
        unsafe { std::env::set_var("CODEX_HOME", home.join("isolated")) };
        assert_eq!(
            codex_global_skills_dest(&home),
            home.join("isolated").join("skills")
        );
        let custom = home.join("my-skills");
        unsafe { std::env::set_var("CODEX_SKILLS_PATH", &custom) };
        assert_eq!(codex_global_skills_dest(&home), custom);
    }

    #[test]
    fn skill_names_are_plain_lowercase_words() {
        assert!(validate_skill_name("tdd", "test").is_ok());
        assert!(validate_skill_name("security-audit", "test").is_ok());
        for bad in ["", "../x", "a/b", "A", "-x", "a_b"] {
            assert!(validate_skill_name(bad, "test").is_err(), "{bad:?}");
        }
    }
}
