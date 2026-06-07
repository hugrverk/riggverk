use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::sync::Mutex;

use crate::agent_skill_targets::{
    agent_global_skills_dest, ensure_skill_dest_contained, validate_skill_agent,
    validate_skill_name,
};

#[derive(Debug, Clone)]
pub struct InstallSkillsRequest {
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallSkillsResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn extract_frontmatter(content: &str, key: &str) -> String {
    let prefix = format!("{key}:");
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with(&prefix) {
            return trimmed[prefix.len()..].trim().to_string();
        }
    }
    String::new()
}

pub fn discover_workspace_skills(skills_dir: &Path) -> Result<HashMap<String, PathBuf>, String> {
    if !skills_dir.is_dir() {
        return Err(format!(
            "skills directory not found: {}",
            skills_dir.display()
        ));
    }

    let mut mapping = HashMap::new();
    for entry in fs::read_dir(skills_dir).map_err(|e| format!("cannot read skills dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read error: {e}"))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let content = fs::read_to_string(&skill_md)
            .map_err(|e| format!("cannot read {}: {e}", skill_md.display()))?;
        let mut name = extract_frontmatter(&content, "name");
        if name.is_empty() {
            name = dir_name.clone();
        }
        validate_skill_name(&name, &skill_md.to_string_lossy())?;
        if mapping.contains_key(&name) {
            return Err(format!("duplicate skill name in repository: {name}"));
        }
        mapping.insert(name, entry.path());
    }

    if mapping.is_empty() {
        return Err(format!("no skills found in {}", skills_dir.display()));
    }
    Ok(mapping)
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("create dir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
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

fn remove_dir_all(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("remove dir {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
static FAIL_RENAME_TO: Mutex<Option<PathBuf>> = Mutex::new(None);

fn unique_dir_under_root(dest_root: &Path, prefix: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    dest_root.join(format!(".{prefix}-{nonce}"))
}

fn rename_path(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(test)]
    if let Ok(guard) = FAIL_RENAME_TO.lock() {
        let staging_to_dest = from
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".aw-skill-staging-"))
            && guard.as_ref().is_some_and(|expected| expected == to);
        if staging_to_dest {
            return Err(format!(
                "rename {} -> {}: forced test failure",
                from.display(),
                to.display()
            ));
        }
    }
    fs::rename(from, to).map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))
}

fn validate_source_tree(src_dir: &Path) -> Result<(), String> {
    let skill_md = src_dir.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("source missing SKILL.md: {}", src_dir.display()));
    }
    Ok(())
}

fn replace_skill_directory(
    src_dir: &Path,
    dest_dir: &Path,
    dest_root: &Path,
) -> Result<(), String> {
    validate_source_tree(src_dir)?;

    let staging = unique_dir_under_root(dest_root, "aw-skill-staging");
    if staging.exists() {
        return Err(format!(
            "staging path already exists: {}",
            staging.display()
        ));
    }

    if let Err(err) = copy_dir_all(src_dir, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    if let Err(err) = validate_source_tree(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }

    let rollback = if dest_dir.exists() {
        let rollback_dir = unique_dir_under_root(dest_root, "aw-skill-rollback");
        if rollback_dir.exists() {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "rollback path already exists: {}",
                rollback_dir.display()
            ));
        }
        rename_path(dest_dir, &rollback_dir)?;
        Some(rollback_dir)
    } else {
        None
    };

    if let Err(err) = rename_path(&staging, dest_dir) {
        if let Some(rollback_dir) = &rollback {
            let _ = rename_path(rollback_dir, dest_dir);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }

    if let Some(rollback_dir) = rollback {
        remove_dir_all(&rollback_dir)?;
    }

    Ok(())
}

pub fn install_skills_native(
    workspace_root: &Path,
    request: &InstallSkillsRequest,
) -> InstallSkillsResult {
    let mut stderr = String::new();
    let mut stdout = String::new();
    let mut exit_code = 0i32;

    if request.agents.is_empty() {
        return InstallSkillsResult {
            success: false,
            stdout,
            stderr: "no agents selected".into(),
            exit_code: 1,
        };
    }
    for agent in &request.agents {
        if let Err(err) = validate_skill_agent(agent) {
            return InstallSkillsResult {
                success: false,
                stdout,
                stderr: err,
                exit_code: 1,
            };
        }
    }
    if request.skills.is_empty() {
        return InstallSkillsResult {
            success: false,
            stdout,
            stderr: "no skills selected".into(),
            exit_code: 1,
        };
    }

    let skills_dir = workspace_root.join("skills");
    let discovered = match discover_workspace_skills(&skills_dir) {
        Ok(mapping) => mapping,
        Err(err) => {
            return InstallSkillsResult {
                success: false,
                stdout,
                stderr: err,
                exit_code: 1,
            };
        }
    };

    let mut install_pairs: Vec<(String, PathBuf)> = Vec::new();
    for skill in &request.skills {
        let Some(src_dir) = discovered.get(skill) else {
            return InstallSkillsResult {
                success: false,
                stdout,
                stderr: format!("unknown skill: {skill}"),
                exit_code: 1,
            };
        };
        install_pairs.push((skill.clone(), src_dir.clone()));
    }

    if request.dry_run {
        for agent in &request.agents {
            let names: Vec<&str> = install_pairs
                .iter()
                .map(|(name, _)| name.as_str())
                .collect();
            stdout.push_str(&format!(
                "{:<10} {}\n",
                format!("{agent}:"),
                names.join(" ")
            ));
        }
        return InstallSkillsResult {
            success: true,
            stdout,
            stderr,
            exit_code: 0,
        };
    }

    for agent in &request.agents {
        let dest_root = match agent_global_skills_dest(agent) {
            Ok(path) => path,
            Err(err) => {
                stderr.push_str(&err);
                stderr.push('\n');
                exit_code = 1;
                continue;
            }
        };
        if let Err(err) = fs::create_dir_all(&dest_root) {
            stderr.push_str(&format!(
                "create destination {}: {err}\n",
                dest_root.display()
            ));
            exit_code = 1;
            continue;
        }

        for (name, src_dir) in &install_pairs {
            let dest_dir = match ensure_skill_dest_contained(&dest_root, name) {
                Ok(path) => path,
                Err(err) => {
                    stdout.push_str(&format!(
                        "  {:<10} FAIL {name} ({err})\n",
                        format!("{agent}:")
                    ));
                    exit_code = 1;
                    continue;
                }
            };
            if let Err(err) = replace_skill_directory(src_dir, &dest_dir, &dest_root) {
                stdout.push_str(&format!(
                    "  {:<10} FAIL {name} (src={} dest={err})\n",
                    format!("{agent}:"),
                    src_dir.display()
                ));
                exit_code = 1;
            } else {
                stdout.push_str(&format!("  {:<10} OK   {name}\n", format!("{agent}:")));
            }
        }
    }

    InstallSkillsResult {
        success: exit_code == 0,
        stdout,
        stderr,
        exit_code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("aw-skills-install-{name}-{nonce}"))
    }

    fn write_skill(root: &Path, dir_name: &str, skill_name: &str) {
        let skill_dir = root.join("skills").join(dir_name);
        fs::create_dir_all(&skill_dir).expect("mkdir skill");
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {skill_name}\ndescription: test\n---\n"),
        )
        .expect("write skill");
        fs::write(skill_dir.join("extra.txt"), "payload").expect("write extra");
    }

    #[test]
    fn dry_run_does_not_write_files() {
        let workspace = temp_root("dry-run");
        let profile = temp_root("profile-dry");
        fs::create_dir_all(&profile).expect("profile dir");
        write_skill(&workspace, "diagnose", "diagnose");

        let skills_dest = profile.join("skills");
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var("CURSOR_SKILLS_PATH", &skills_dest);
        }

        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills: vec!["diagnose".into()],
                dry_run: true,
            },
        );
        assert!(result.success);
        assert!(result.stdout.contains("cursor:"));
        assert!(!profile.join("skills/diagnose/SKILL.md").exists());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn apply_copies_skill_directory_to_cursor_profile() {
        let workspace = temp_root("apply");
        let profile = temp_root("profile-apply");
        fs::create_dir_all(&profile).expect("profile dir");
        write_skill(&workspace, "diagnose", "diagnose");

        let skills_dest = profile.join("skills");
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var("CURSOR_SKILLS_PATH", &skills_dest);
        }

        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills: vec!["diagnose".into()],
                dry_run: false,
            },
        );
        assert!(
            result.success,
            "stdout={} stderr={}",
            result.stdout, result.stderr
        );
        assert!(skills_dest.join("diagnose/SKILL.md").is_file());
        assert!(skills_dest.join("diagnose/extra.txt").is_file());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn unknown_skill_is_rejected() {
        let workspace = temp_root("unknown-skill");
        write_skill(&workspace, "diagnose", "diagnose");
        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills: vec!["missing-skill".into()],
                dry_run: true,
            },
        );
        assert!(!result.success);
        assert!(result.stderr.contains("unknown skill"));
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn invalid_agent_is_rejected() {
        let workspace = temp_root("invalid-agent");
        write_skill(&workspace, "diagnose", "diagnose");
        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["gemini".into()],
                skills: vec!["diagnose".into()],
                dry_run: true,
            },
        );
        assert!(!result.success);
        assert!(result.stderr.contains("invalid agent"));
        let _ = fs::remove_dir_all(&workspace);
    }

    fn staging_artifacts(dest_root: &Path) -> Vec<PathBuf> {
        fs::read_dir(dest_root)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with(".aw-skill-staging-")
                            || name.starts_with(".aw-skill-rollback-")
                    })
            })
            .collect()
    }

    #[test]
    fn source_validation_failure_preserves_existing_installation() {
        let workspace = temp_root("bad-source");
        let profile = temp_root("profile-bad-source");
        fs::create_dir_all(profile.join("skills/diagnose")).expect("old skill");
        fs::write(profile.join("skills/diagnose/SKILL.md"), "old content").expect("old md");
        fs::create_dir_all(workspace.join("skills/diagnose")).expect("bad source");
        fs::write(workspace.join("skills/diagnose/extra.txt"), "only extra").expect("extra");

        let skills_dest = profile.join("skills");
        let err = replace_skill_directory(
            &workspace.join("skills/diagnose"),
            &skills_dest.join("diagnose"),
            &skills_dest,
        )
        .expect_err("missing SKILL.md");
        assert!(err.contains("SKILL.md"));
        assert_eq!(
            fs::read_to_string(skills_dest.join("diagnose/SKILL.md")).expect("old preserved"),
            "old content"
        );
        assert!(staging_artifacts(&skills_dest).is_empty());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn replacement_failure_restores_existing_installation() {
        let workspace = temp_root("rename-fail");
        let profile = temp_root("profile-rename-fail");
        fs::create_dir_all(profile.join("skills/diagnose")).expect("old skill");
        fs::write(profile.join("skills/diagnose/SKILL.md"), "old content").expect("old md");
        write_skill(&workspace, "diagnose", "diagnose");

        let skills_dest = profile.join("skills");
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var("CURSOR_SKILLS_PATH", &skills_dest);
        }

        let dest_dir =
            ensure_skill_dest_contained(&skills_dest, "diagnose").expect("canonical dest");
        {
            let mut guard = FAIL_RENAME_TO.lock().expect("rename fail lock");
            *guard = Some(dest_dir);
        }
        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills: vec!["diagnose".into()],
                dry_run: false,
            },
        );
        {
            let mut guard = FAIL_RENAME_TO.lock().expect("rename fail lock");
            *guard = None;
        }

        assert!(!result.success);
        assert_eq!(
            fs::read_to_string(skills_dest.join("diagnose/SKILL.md")).expect("restored"),
            "old content"
        );
        assert!(staging_artifacts(&skills_dest).is_empty());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn successful_replacement_leaves_no_staging_or_rollback_dirs() {
        let workspace = temp_root("clean-success");
        let profile = temp_root("profile-clean-success");
        fs::create_dir_all(profile.join("skills/diagnose")).expect("old skill");
        fs::write(profile.join("skills/diagnose/SKILL.md"), "old").expect("old md");
        write_skill(&workspace, "diagnose", "diagnose");

        let skills_dest = profile.join("skills");
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var("CURSOR_SKILLS_PATH", &skills_dest);
        }

        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills: vec!["diagnose".into()],
                dry_run: false,
            },
        );
        assert!(result.success);
        assert!(staging_artifacts(&skills_dest).is_empty());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn apply_overwrites_existing_skill_directory() {
        let workspace = temp_root("overwrite");
        let profile = temp_root("profile-overwrite");
        fs::create_dir_all(profile.join("skills/diagnose")).expect("old skill");
        fs::write(profile.join("skills/diagnose/SKILL.md"), "old").expect("old md");
        write_skill(&workspace, "diagnose", "diagnose");

        let skills_dest = profile.join("skills");
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var("CURSOR_SKILLS_PATH", &skills_dest);
        }

        let result = install_skills_native(
            &workspace,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills: vec!["diagnose".into()],
                dry_run: false,
            },
        );
        assert!(result.success);
        let content = fs::read_to_string(skills_dest.join("diagnose/SKILL.md")).expect("read");
        assert!(content.contains("name: diagnose"));
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }
}
