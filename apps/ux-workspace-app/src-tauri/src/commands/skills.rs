use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::agent_targets;

use super::content::DocumentContent;
use super::process::{run_cmd, run_cmd_owned, ActionResult};
use super::workspace::{path_arg, workspace_root};

#[derive(Serialize)]
pub struct SkillSummary {
    id: String,
    name: String,
    description: String,
    path: String,
}

fn skill_summary_from_path(
    root: &Path,
    skill_md: &Path,
    id: String,
    fallback_name: String,
) -> SkillSummary {
    let content = std::fs::read_to_string(skill_md).unwrap_or_default();
    let name = extract_frontmatter(&content, "name");
    let desc = extract_frontmatter(&content, "description");
    let rel = skill_md
        .strip_prefix(root)
        .unwrap_or(skill_md)
        .to_string_lossy()
        .into_owned();

    SkillSummary {
        id,
        name: if name.is_empty() { fallback_name } else { name },
        description: desc,
        path: rel,
    }
}

fn discover_skills(root: &Path) -> Result<Vec<SkillSummary>, String> {
    let skills_dir = root.join("skills");
    let mut discovered: Vec<SkillSummary> = Vec::new();

    let entries =
        std::fs::read_dir(&skills_dir).map_err(|e| format!("cannot read skills dir: {}", e))?;

    for area_entry in entries {
        let area_entry = area_entry.map_err(|e| format!("read error: {}", e))?;
        if !area_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }

        let area_path = area_entry.path();
        let area = area_entry.file_name().to_string_lossy().into_owned();
        let flat_skill_md = area_path.join("SKILL.md");
        if flat_skill_md.is_file() {
            discovered.push(skill_summary_from_path(
                root,
                &flat_skill_md,
                format!("workspace/{}", area),
                area,
            ));
            continue;
        }

        let skill_entries =
            std::fs::read_dir(&area_path).map_err(|e| format!("read error: {}", e))?;

        for skill_entry in skill_entries {
            let skill_entry = skill_entry.map_err(|e| format!("read error: {}", e))?;
            if !skill_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let skill_md = skill_entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }

            let skill_dir = skill_entry.file_name().to_string_lossy().into_owned();
            discovered.push(skill_summary_from_path(
                root,
                &skill_md,
                format!("{}/{}", area, skill_dir),
                skill_dir,
            ));
        }
    }

    discovered.sort_by(|a, b| a.id.cmp(&b.id));

    let mut names = std::collections::HashSet::new();
    let mut skills: Vec<SkillSummary> = Vec::new();
    for skill in discovered {
        if names.insert(skill.name.clone()) {
            skills.push(skill);
        }
    }

    Ok(skills)
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillSummary>, String> {
    let root = workspace_root()?;
    discover_skills(&root)
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

#[tauri::command]
pub fn read_skill(id: String) -> Result<DocumentContent, String> {
    let root = workspace_root()?;
    let skills = list_skills()?;
    let found = skills.iter().find(|s| s.id == id);
    match found {
        Some(s) => {
            let path = root.join(&s.path);
            let content =
                std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
            let area = s.id.split('/').next().unwrap_or("workspace").to_string();
            Ok(DocumentContent {
                id: s.id.clone(),
                title: s.name.clone(),
                section: area,
                path: s.path.clone(),
                source: "curated".into(),
                content,
            })
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

const VALID_SKILL_AGENTS: &[&str] = &["codex", "opencode", "claude", "gemini", "auggie"];

fn validate_agent(agent: &str) -> Result<(), String> {
    if VALID_SKILL_AGENTS.contains(&agent) {
        Ok(())
    } else {
        Err(format!("invalid agent: {}", agent))
    }
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
        validate_agent(a)?;
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
    use super::{discover_skills, validate_project_install_target};
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

    fn write_skill(root: &PathBuf, rel: &str, name: &str) {
        let path = root.join(rel).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill parent");
        }
        fs::write(
            path,
            format!("---\nname: {}\ndescription: test skill\n---\n", name),
        )
        .expect("write skill");
    }

    #[test]
    fn flat_skill_layout_is_listed() {
        let root = temp_root("flat-skills");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "workspace/diagnose");
        assert_eq!(skills[0].name, "diagnose");
        assert_eq!(skills[0].path, "skills/diagnose/SKILL.md");
    }

    #[test]
    fn nested_skill_layout_is_still_listed() {
        let root = temp_root("nested-skills");
        write_skill(&root, "skills/debug/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "debug/diagnose");
    }

    #[test]
    fn flat_baseline_starter_skills_are_discoverable() {
        let root = temp_root("baseline-skills");
        write_skill(&root, "skills/diagnose", "diagnose");
        write_skill(&root, "skills/security-review", "security-review");
        write_skill(&root, "skills/context-budget", "context-budget");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"diagnose"));
        assert!(names.contains(&"security-review"));
        assert!(names.contains(&"context-budget"));
    }

    #[test]
    fn duplicate_skill_names_choose_deterministic_first_id() {
        let root = temp_root("duplicate-skills");
        write_skill(&root, "skills/diagnose", "diagnose");
        write_skill(&root, "skills/debug/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "debug/diagnose");
    }

    #[test]
    fn flat_skill_id_resolves_to_openable_path() {
        let root = temp_root("flat-open-skill");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let found = skills
            .iter()
            .find(|s| s.id == "workspace/diagnose")
            .expect("flat skill id exists");
        let path = root.join(&found.path);
        let exists = path.is_file();
        let _ = fs::remove_dir_all(&root);

        assert!(exists, "flat skill id must resolve to SKILL.md");
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

    #[test]
    fn agent_validation_accepts_all_five_valid_agents() {
        for agent in super::VALID_SKILL_AGENTS {
            assert!(
                super::validate_agent(agent).is_ok(),
                "valid agent '{}' should be accepted",
                agent
            );
        }
    }

    #[test]
    fn agent_validation_rejects_unknown_agents() {
        for invalid in &["unknown", "codex_skill", "CODEX", "CLAUDE", ""] {
            assert!(
                super::validate_agent(invalid).is_err(),
                "invalid agent '{}' should be rejected",
                invalid
            );
        }
    }

    #[test]
    fn agent_validation_rejects_typo_agents() {
        assert!(super::validate_agent("opeencode").is_err());
        assert!(super::validate_agent("Claude").is_err());
        assert!(super::validate_agent("gemni").is_err());
    }

    #[test]
    fn read_skill_known_id_resolves_content() {
        let root = temp_root("read-skill-known");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let found = skills
            .iter()
            .find(|s| s.name == "diagnose")
            .expect("skill exists");

        let path = root.join(&found.path);
        let raw = std::fs::read_to_string(&path).expect("read raw");
        let _ = fs::remove_dir_all(&root);

        assert!(raw.contains("name: diagnose"));
        assert!(raw.contains("description: test skill"));
    }

    #[test]
    fn read_skill_unknown_id_is_rejected_via_registry() {
        let root = temp_root("read-skill-unknown");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let found = skills.iter().find(|s| s.id == "nonexistent/skill");
        assert!(found.is_none(), "unknown id must not resolve");
    }

    #[test]
    fn read_skill_path_traversal_id_is_rejected() {
        let root = temp_root("read-skill-traversal");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let bad_ids = [
            "../../../etc/passwd",
            "skills/../diagnose",
            "../../../../etc/hosts",
        ];
        for bad in &bad_ids {
            let found = skills.iter().find(|s| s.id == *bad);
            assert!(
                found.is_none(),
                "path traversal id '{}' must not resolve",
                bad
            );
        }
    }
}
