use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
            if let Err(err) = remove_dir_all(&dest_dir) {
                stdout.push_str(&format!(
                    "  {:<10} FAIL {name} (remove existing: {err})\n",
                    format!("{agent}:")
                ));
                exit_code = 1;
                continue;
            }
            if let Err(err) = copy_dir_all(src_dir, &dest_dir) {
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
