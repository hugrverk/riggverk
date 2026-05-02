use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::agent_targets;

use super::process::{run_cmd, run_cmd_owned, ActionResult};
use super::workspace::{path_arg, workspace_root};

#[derive(Serialize)]
pub struct SkillSummary {
    id: String,
    name: String,
    description: String,
    path: String,
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillSummary>, String> {
    let root = workspace_root()?;
    let skills_dir = root.join("skills");
    let mut skills: Vec<SkillSummary> = Vec::new();

    let entries =
        std::fs::read_dir(&skills_dir).map_err(|e| format!("cannot read skills dir: {}", e))?;

    for area_entry in entries {
        let area_entry = area_entry.map_err(|e| format!("read error: {}", e))?;
        if !area_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_entries =
            std::fs::read_dir(area_entry.path()).map_err(|e| format!("read error: {}", e))?;

        for skill_entry in skill_entries {
            let skill_entry = skill_entry.map_err(|e| format!("read error: {}", e))?;
            if !skill_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let skill_md = skill_entry.path().join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let content = std::fs::read_to_string(&skill_md).unwrap_or_default();
            let name = extract_frontmatter(&content, "name");
            let desc = extract_frontmatter(&content, "description");
            let rel = skill_md
                .strip_prefix(&root)
                .unwrap_or(&skill_md)
                .to_string_lossy()
                .into_owned();
            let area = area_entry.file_name().to_string_lossy().into_owned();
            let skill_dir = skill_entry.file_name().to_string_lossy().into_owned();
            let id = format!("{}/{}", area, skill_dir);

            skills.push(SkillSummary {
                id,
                name: if name.is_empty() { skill_dir } else { name },
                description: desc,
                path: rel,
            });
        }
    }

    skills.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(skills)
}

#[tauri::command]
pub fn open_skill(id: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let skills = list_skills()?;
    let found = skills.iter().find(|s| s.id == id);
    match found {
        Some(s) => {
            let path = root.join(&s.path);
            let path_str = path_arg(&path)?;
            let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
            Ok(ActionResult::new(
                ok,
                format!("open_skill:{}", id),
                out,
                err,
                code,
            ))
        }
        None => Err(format!("unknown skill: {}", id)),
    }
}

fn extract_frontmatter(content: &str, key: &str) -> String {
    let prefix = format!("{}:", key);
    for line in content.lines() {
        if line.trim_start().starts_with(&prefix) {
            return line
                .trim_start()
                .strip_prefix(&prefix)
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }
    String::new()
}

fn has_project_marker(target: &Path) -> bool {
    [
        ".git",
        "package.json",
        "Cargo.toml",
        "composer.json",
        "pyproject.toml",
        "AGENTS.md",
        ".opencode",
        ".codex",
        "wp-content",
        "wordpress/wp-content",
    ]
    .iter()
    .any(|marker| target.join(marker).exists())
}

fn validate_project_install_target(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("project scope requires a target path".into());
    }

    let input = PathBuf::from(trimmed);
    let canonical = input
        .canonicalize()
        .map_err(|_| "project target does not exist".to_string())?;

    if !canonical.is_dir() {
        return Err("project target is not a directory".into());
    }

    let target_str = canonical
        .to_str()
        .ok_or_else(|| "project target path is not valid UTF-8".to_string())?;

    let home = agent_targets::home_dir()?;
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let slash_tmp = PathBuf::from("/tmp")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    let broad_paths = [
        PathBuf::from("/"),
        PathBuf::from("/Users"),
        home.clone(),
        home.join("Projects"),
        temp_root,
        slash_tmp,
    ];

    if broad_paths.contains(&canonical) {
        return Err(format!("refusing broad project target: {}", target_str));
    }

    if !has_project_marker(&canonical) {
        return Err("project target does not look like a project checkout".into());
    }

    Ok(canonical)
}

#[derive(Deserialize)]
pub struct InstallSkillsRequest {
    agents: Vec<String>,
    scope: String,
    target: Option<String>,
    skills: Vec<String>,
    dry_run: bool,
}

#[tauri::command]
pub fn install_skills(request: InstallSkillsRequest) -> Result<ActionResult, String> {
    if request.agents.is_empty() {
        return Err("no agents selected".into());
    }
    for a in &request.agents {
        match a.as_str() {
            "opencode" | "codex" | "auggie" => {}
            a => return Err(format!("invalid agent: {}", a)),
        }
    }

    match request.scope.as_str() {
        "global" => {}
        "project" => match &request.target {
            Some(t) => {
                validate_project_install_target(t)?;
            }
            _ => return Err("project scope requires a target path".into()),
        },
        s => return Err(format!("invalid scope: {}", s)),
    }

    if request.skills.is_empty() {
        return Err("no skills selected".into());
    }

    let available = list_skills()?;
    let valid_names: Vec<&str> = available.iter().map(|s| s.name.as_str()).collect();
    for skill in &request.skills {
        if !valid_names.contains(&skill.as_str()) {
            return Err(format!("unknown skill: {}", skill));
        }
    }

    let root = workspace_root()?;
    let script = root.join("scripts/install-skills.sh");
    let mut args: Vec<String> = vec![script.to_string_lossy().into_owned(), "--quiet".into()];

    for agent in &request.agents {
        args.push("--agent".into());
        args.push(agent.clone());
    }

    match request.scope.as_str() {
        "global" => args.push("--global".into()),
        "project" => {
            let target = validate_project_install_target(request.target.as_deref().unwrap_or(""))?;
            args.push("--project".into());
            args.push("--target".into());
            args.push(path_arg(&target)?);
        }
        _ => unreachable!(),
    }

    for skill in &request.skills {
        args.push("--skill".into());
        args.push(skill.clone());
    }

    if request.dry_run {
        args.push("--dry-run".into());
    }

    let (ok, out, err, code) = run_cmd_owned("bash", &args, &root);
    Ok(ActionResult::new(
        ok,
        if request.dry_run {
            "install_skills:dry-run"
        } else {
            "install_skills"
        },
        out,
        err,
        code,
    ))
}

#[tauri::command]
pub fn open_install_skills_script() -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let path = root.join("scripts/install-skills.sh");
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
    Ok(ActionResult::new(
        ok,
        "open_install_skills_script",
        out,
        err,
        code,
    ))
}

#[cfg(test)]
mod tests {
    use super::validate_project_install_target;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("ux-workspace-app-{name}-{nonce}"))
    }

    #[test]
    fn project_target_validation_rejects_unmarked_directory() {
        let root = temp_root("unmarked-project");
        fs::create_dir_all(&root).expect("create temp dir");

        let result = validate_project_install_target(root.to_str().expect("utf8 temp path"));
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            result.expect_err("unmarked project should be rejected"),
            "project target does not look like a project checkout"
        );
    }

    #[test]
    fn project_target_validation_accepts_git_marker() {
        let root = temp_root("marked-project");
        fs::create_dir_all(root.join(".git")).expect("create git marker");

        let result = validate_project_install_target(root.to_str().expect("utf8 temp path"));
        let _ = fs::remove_dir_all(&root);

        assert!(result.is_ok());
    }
}
