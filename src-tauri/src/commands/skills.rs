use serde::{Deserialize, Serialize};
use std::path::Path;

use super::content::safe_canonical_target;
use super::content::DocumentContent;
#[cfg(not(windows))]
use super::process::run_cmd_owned_env;
use super::process::{run_cmd, ActionResult};
use super::workspace::{path_arg, workspace_root};
use crate::agent_skill_targets::{agent_global_skills_dest, validate_skill_agent};
use crate::skills_install::discover_workspace_skills;
#[cfg(not(windows))]
use crate::shell_runtime::resolve_bash;
#[cfg(windows)]
use crate::skills_install::{install_skills_native, InstallSkillsRequest as NativeInstallRequest};

#[derive(Serialize)]
pub struct SkillSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
    pub(crate) group: String,
    pub(crate) category: String,
    pub(crate) risk: String,
    pub(crate) targets: Vec<String>,
    pub(crate) related: Vec<String>,
}

fn reject_symlink_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("cannot inspect {label} {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing symlink {label}: {}", path.display()));
    }
    Ok(())
}

fn skill_summary_from_path(
    root: &Path,
    skill_md: &Path,
    id: String,
    fallback_name: String,
    group: String,
) -> SkillSummary {
    let content = std::fs::read_to_string(skill_md).unwrap_or_default();
    let name = extract_frontmatter(&content, "name");
    let desc = extract_frontmatter(&content, "description");
    let category = extract_frontmatter(&content, "category");
    let risk = extract_frontmatter(&content, "risk");
    let targets = extract_frontmatter_list(&content, "targets");
    let related = extract_frontmatter_list(&content, "related");
    let rel = skill_md
        .strip_prefix(root)
        .unwrap_or(skill_md)
        .to_string_lossy()
        .replace('\\', "/");

    SkillSummary {
        id,
        name: if name.is_empty() { fallback_name } else { name },
        description: desc,
        path: rel,
        group,
        category,
        risk,
        targets,
        related,
    }
}

fn has_deeper_skill_md(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            return true;
        }
    }
    false
}

pub(crate) fn discover_skills(root: &Path) -> Result<Vec<SkillSummary>, String> {
    let skills_dir = root.join("skills");
    let mut discovered: Vec<SkillSummary> = Vec::new();

    reject_symlink_path(&skills_dir, "skills root")?;

    let entries =
        std::fs::read_dir(&skills_dir).map_err(|e| format!("cannot read skills dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("read error: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file type error: {}", e))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink skill directory: {}",
                entry.path().display()
            ));
        }
        if !file_type.is_dir() {
            continue;
        }

        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let root_skill_md = entry_path.join("SKILL.md");
        reject_symlink_path(&root_skill_md, "skill file")?;
        if root_skill_md.is_file() {
            discovered.push(skill_summary_from_path(
                root,
                &root_skill_md,
                format!("workspace/{}", entry_name),
                entry_name,
                String::new(),
            ));
            continue;
        }

        let sub_entries = std::fs::read_dir(&entry_path)
            .map_err(|e| format!("cannot read skills group dir: {}", e))?;
        for sub in sub_entries {
            let sub = sub.map_err(|e| format!("read error: {}", e))?;
            let sub_type = sub
                .file_type()
                .map_err(|e| format!("file type error: {}", e))?;
            if sub_type.is_symlink() {
                return Err(format!(
                    "refusing symlink skill directory: {}",
                    sub.path().display()
                ));
            }
            if !sub_type.is_dir() {
                continue;
            }
            let sub_path = sub.path();
            let sub_name = sub.file_name().to_string_lossy().into_owned();
            let grouped_skill_md = sub_path.join("SKILL.md");
            reject_symlink_path(&grouped_skill_md, "skill file")?;
            if grouped_skill_md.is_file() {
                discovered.push(skill_summary_from_path(
                    root,
                    &grouped_skill_md,
                    format!("workspace/{}/{}", entry_name, sub_name),
                    sub_name,
                    entry_name.clone(),
                ));
            } else if has_deeper_skill_md(&sub_path) {
                return Err(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    sub_path.display()
                ));
            }
        }
    }

    discovered.sort_by(|a, b| match a.group.cmp(&b.group) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });

    let mut names = std::collections::HashSet::new();
    for skill in &discovered {
        if !names.insert(skill.name.clone()) {
            return Err(format!("duplicate skill name in repository: {}", skill.name));
        }
    }

    Ok(discovered)
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

fn extract_frontmatter_list(content: &str, key: &str) -> Vec<String> {
    let raw = extract_frontmatter(content, key);
    if raw.is_empty() {
        return Vec::new();
    }
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn validate_agent(agent: &str) -> Result<(), String> {
    validate_skill_agent(agent)
}

#[allow(dead_code)]
pub(crate) fn skill_install_backend() -> &'static str {
    #[cfg(windows)]
    {
        "native"
    }
    #[cfg(not(windows))]
    {
        "script"
    }
}

#[cfg(not(windows))]
fn install_skills_via_script(
    root: &Path,
    request: &InstallSkillsRequest,
) -> Result<ActionResult, String> {
    let script = workspace_script_arg(root, "scripts/install-skills.sh")?;
    let bash = resolve_bash()?;
    let mut args: Vec<String> = vec![script, "--quiet".into()];
    for agent in &request.agents {
        args.push("--agent".into());
        args.push(agent.clone());
    }
    args.push("--global".into());
    for skill in &request.skills {
        args.push("--skill".into());
        args.push(skill.clone());
    }
    if request.dry_run {
        args.push("--dry-run".into());
    }
    let (ok, out, err, code) = run_cmd_owned_env(&bash, &args, root, &[]);
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

fn workspace_script_arg(root: &Path, script_rel: &str) -> Result<String, String> {
    let script = root.join(script_rel);
    let canonical = safe_canonical_target(root, &script)?;
    if !canonical.is_file() {
        return Err(format!("workspace script not found: {}", script_rel));
    }
    path_arg(&canonical)
}

#[derive(Deserialize)]
pub struct InstallSkillsRequest {
    agents: Vec<String>,
    skills: Vec<String>,
    dry_run: bool,
}

pub(crate) fn workspace_skill_names(root: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = discover_workspace_skills(&root.join("skills"))?
        .into_keys()
        .collect();
    names.sort();
    Ok(names)
}

#[derive(Serialize)]
pub struct SkillSyncHealthEntry {
    pub name: String,
    pub group: String,
    pub source_path: String,
    pub target_path: String,
    pub supported: bool,
    pub state: String,
    pub next_action: String,
}

#[derive(Serialize)]
pub struct SkillsSyncHealth {
    pub expected_count: usize,
    pub synced_count: usize,
    pub missing_count: usize,
    pub diverged_count: usize,
    pub skills: Vec<SkillSyncHealthEntry>,
}

fn skill_install_state(source_md: &Path, target_md: &Path) -> (&'static str, &'static str) {
    if !source_md.is_file() {
        return ("invalid", "repair workspace source");
    }
    if !target_md.is_file() {
        return ("missing", "sync skill");
    }
    if super::status::file_eq(source_md, target_md) {
        ("synced", "none")
    } else {
        ("diverged", "review or repair")
    }
}

#[tauri::command]
pub fn get_skills_sync_health(agent: String) -> Result<SkillsSyncHealth, String> {
    validate_agent(&agent)?;
    let root = workspace_root()?;
    let summaries = discover_skills(&root)?;
    let dest_root = agent_global_skills_dest(&agent)?;
    let mut skills = Vec::new();
    let mut synced_count = 0usize;
    let mut missing_count = 0usize;
    let mut diverged_count = 0usize;

    for summary in summaries {
        let targets = &summary.targets;
        let supported = targets.is_empty()
            || targets.iter().any(|target| target.as_str() == agent);
        let source_md = root.join(&summary.path);
        let target_md = dest_root.join(&summary.name).join("SKILL.md");
        let (state, next_action) = if !supported {
            ("unsupported", "not installed for this harness")
        } else {
            skill_install_state(&source_md, &target_md)
        };
        match state {
            "synced" => synced_count += 1,
            "missing" => missing_count += 1,
            "diverged" => diverged_count += 1,
            _ => {}
        }
        skills.push(SkillSyncHealthEntry {
            name: summary.name.clone(),
            group: summary.group.clone(),
            source_path: summary.path.clone(),
            target_path: target_md.to_string_lossy().into_owned(),
            supported,
            state: state.into(),
            next_action: next_action.into(),
        });
    }

    Ok(SkillsSyncHealth {
        expected_count: skills.len(),
        synced_count,
        missing_count,
        diverged_count,
        skills,
    })
}

#[tauri::command]
pub fn install_skills(request: InstallSkillsRequest) -> Result<ActionResult, String> {
    if request.agents.is_empty() {
        return Err("no agents selected".into());
    }
    for a in &request.agents {
        validate_agent(a)?;
    }

    let available = list_skills()?;
    let mut skills_to_install = request.skills;
    if skills_to_install.is_empty() {
        skills_to_install = available.iter().map(|s| s.name.clone()).collect();
    }
    if skills_to_install.is_empty() {
        return Err("no skills available to install".into());
    }

    let valid_names: Vec<&str> = available.iter().map(|s| s.name.as_str()).collect();
    for skill in &skills_to_install {
        if !valid_names.contains(&skill.as_str()) {
            return Err(format!("unknown skill: {}", skill));
        }
    }

    let root = workspace_root()?;
    #[cfg(windows)]
    {
        let result = install_skills_native(
            &root,
            &NativeInstallRequest {
                agents: request.agents,
                skills: skills_to_install,
                dry_run: request.dry_run,
                agent_dest_overrides: None,
            },
        );
        Ok(ActionResult::new(
            result.success,
            if request.dry_run {
                "install_skills:dry-run"
            } else {
                "install_skills"
            },
            result.stdout,
            result.stderr,
            Some(result.exit_code),
        ))
    }
    #[cfg(not(windows))]
    {
        install_skills_via_script(
            &root,
            &InstallSkillsRequest {
                agents: request.agents,
                skills: skills_to_install,
                dry_run: request.dry_run,
            },
        )
    }
}

#[tauri::command]
pub fn open_install_skills_script() -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let path_str = workspace_script_arg(&root, "scripts/install-skills.sh")?;
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
    use super::discover_skills;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-{name}-{nonce}"))
    }

    fn write_skill(root: &Path, rel: &str, name: &str) {
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

    fn write_skill_with_metadata(
        root: &Path,
        rel: &str,
        name: &str,
        category: &str,
        risk: &str,
        targets: &str,
        related: &str,
    ) {
        let path = root.join(rel).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill parent");
        }
        fs::write(
            path,
            format!(
                "---\nname: {}\ndescription: test skill\ncategory: {}\nrisk: {}\ntargets: {}\nrelated: {}\n---\n",
                name, category, risk, targets, related
            ),
        )
        .expect("write skill with metadata");
    }

    #[test]
    fn skill_install_backend_is_platform_specific() {
        #[cfg(windows)]
        assert_eq!(super::skill_install_backend(), "native");
        #[cfg(not(windows))]
        assert_eq!(super::skill_install_backend(), "script");
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
    fn grouped_skill_layout_is_listed() {
        let root = temp_root("grouped-skills");
        write_skill(&root, "skills/kretsverket/kretsverket-editor-change", "kretsverket-editor-change");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "workspace/kretsverket/kretsverket-editor-change");
        assert_eq!(skills[0].name, "kretsverket-editor-change");
        assert_eq!(skills[0].group, "kretsverket");
        assert_eq!(
            skills[0].path,
            "skills/kretsverket/kretsverket-editor-change/SKILL.md"
        );
    }

    #[test]
    fn mixed_root_and_grouped_discovery() {
        let root = temp_root("mixed-skills");
        write_skill(&root, "skills/diagnose", "diagnose");
        write_skill(&root, "skills/kretsverket/kretsverket-editor-change", "kretsverket-editor-change");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "diagnose");
        assert_eq!(skills[0].group, "");
        assert_eq!(skills[1].name, "kretsverket-editor-change");
        assert_eq!(skills[1].group, "kretsverket");
    }

    #[test]
    fn duplicate_frontmatter_name_across_groups_is_rejected() {
        let root = temp_root("dup-groups");
        write_skill(&root, "skills/alpha/shared-skill", "shared-skill");
        write_skill(&root, "skills/beta/shared-skill", "shared-skill");

        match discover_skills(&root) {
            Err(err) => assert!(err.contains("duplicate skill name")),
            Ok(_) => panic!("duplicate names must fail"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deeper_nesting_is_rejected() {
        let root = temp_root("deep-nesting");
        write_skill(&root, "skills/debug/nested/diagnose", "diagnose");

        match discover_skills(&root) {
            Err(err) => assert!(err.contains("deeper than one group level")),
            Ok(_) => panic!("deep nesting must fail"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deterministic_ordering_by_group_and_name() {
        let root = temp_root("ordering");
        write_skill(&root, "skills/zeta/z-skill", "z-skill");
        write_skill(&root, "skills/alpha/a-skill", "a-skill");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["diagnose", "a-skill", "z-skill"]);
    }

    #[test]
    fn grouped_skill_open_and_read_paths_resolve() {
        let root = temp_root("grouped-open");
        write_skill(&root, "skills/kretsverket/kretsverket-editor-change", "kretsverket-editor-change");

        let skills = discover_skills(&root).expect("discover skills");
        let found = skills
            .iter()
            .find(|s| s.id == "workspace/kretsverket/kretsverket-editor-change")
            .expect("grouped skill id exists");
        let path = root.join(&found.path);
        let exists = path.is_file();
        let _ = fs::remove_dir_all(&root);
        assert!(exists);
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
    fn duplicate_root_skill_names_are_rejected() {
        let root = temp_root("duplicate-root-skills");
        write_skill(&root, "skills/diagnose-c", "duplicate-skill");
        write_skill(&root, "skills/diagnose-b", "duplicate-skill");

        match discover_skills(&root) {
            Err(err) => assert!(err.contains("duplicate skill name")),
            Ok(_) => panic!("duplicate names must fail"),
        }
        let _ = fs::remove_dir_all(&root);
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
    fn agent_validation_accepts_all_valid_agents() {
        for agent in crate::agent_skill_targets::VALID_SKILL_AGENTS {
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
        assert!(super::validate_agent("removed-agent").is_err());
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

    #[test]
    fn minimal_skill_has_empty_metadata_fields() {
        let root = temp_root("minimal-meta");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].category, "");
        assert_eq!(skills[0].risk, "");
        assert!(skills[0].targets.is_empty());
        assert!(skills[0].related.is_empty());
    }

    #[test]
    fn metadata_fields_parse_correctly() {
        let root = temp_root("meta-fields");
        write_skill_with_metadata(
            &root,
            "skills/frontend-design",
            "frontend-design",
            "frontend",
            "medium",
            "codex, opencode, claude, cursor",
            "screenshot-review, browser-qa, accessibility-review",
        );

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "frontend-design");
        assert_eq!(s.category, "frontend");
        assert_eq!(s.risk, "medium");
        assert_eq!(s.targets, vec!["codex", "opencode", "claude", "cursor"]);
        assert_eq!(
            s.related,
            vec!["screenshot-review", "browser-qa", "accessibility-review"]
        );
    }

    #[test]
    fn comma_lists_parse_deterministically() {
        let root = temp_root("meta-lists");
        write_skill_with_metadata(
            &root,
            "skills/security-review",
            "security-review",
            "security",
            "high",
            "codex,  opencode , claude,cursor,  ",
            "diagnose,  ,release-check,",
        );

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let s = &skills[0];
        // whitespace trimmed, empty entries removed
        assert_eq!(s.targets, vec!["codex", "opencode", "claude", "cursor"]);
        assert_eq!(s.related, vec!["diagnose", "release-check"]);
    }

    #[test]
    fn empty_metadata_stays_empty() {
        let root = temp_root("empty-meta");
        write_skill_with_metadata(&root, "skills/diagnose", "diagnose", "", "", "", "");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let s = &skills[0];
        assert_eq!(s.category, "");
        assert_eq!(s.risk, "");
        assert!(s.targets.is_empty());
        assert!(s.related.is_empty());
    }
}
