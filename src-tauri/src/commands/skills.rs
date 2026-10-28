use serde::Serialize;
use std::path::Path;

use super::content::{bundled_library_root, DocumentContent};
use super::workspace::setup_workspace_target_path;
use crate::path_safety::reject_symlink;
#[cfg(test)]
use crate::skills_install::discover_workspace_skills;

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
    scan_deeper_skill_md(dir, 0)
}

/// Recursively scan for SKILL.md files at depths deeper than one group level.
/// Bounded to MAX_ENTRIES to prevent infinite recursion on deep trees.
fn scan_deeper_skill_md(dir: &Path, depth: usize) -> bool {
    const MAX_ENTRIES: usize = 10_000;
    const MAX_DEPTH: usize = 20;

    if depth > MAX_DEPTH {
        return true; // Too deep — treat as violation
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };

    let mut count = 0;
    for entry in entries.flatten() {
        count += 1;
        if count > MAX_ENTRIES {
            return true; // Too many entries — treat as violation
        }
        let path = entry.path();
        if path.is_symlink() {
            return true; // Symlinked descendants rejected
        }
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            return true;
        }
        if scan_deeper_skill_md(&path, depth + 1) {
            return true;
        }
    }
    false
}

pub(crate) fn discover_skills(root: &Path) -> Result<Vec<SkillSummary>, String> {
    let skills_dir = root.join("skills");
    let mut discovered: Vec<SkillSummary> = Vec::new();

    reject_symlink(&skills_dir, "skills root")?;

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
        reject_symlink(&root_skill_md, "skill file")?;
        if root_skill_md.is_file() {
            if has_deeper_skill_md(&entry_path) {
                return Err(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    entry_path.display()
                ));
            }
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
            reject_symlink(&grouped_skill_md, "skill file")?;
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
            return Err(format!(
                "duplicate skill name in repository: {}",
                skill.name
            ));
        }
    }

    Ok(discovered)
}

/// The skills bundled with the app, read from the bundle (never from a copy in the workspace).
#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillSummary>, String> {
    discover_skills(&bundled_library_root()?)
}

/// The skill copies each enabled harness loads and the problems among them (see `skill_loads`).
///
/// Read-only. It lists the skills folders the enabled harnesses read and opens the `SKILL.md` of
/// their subfolders, nothing else, so it runs off the main thread.
#[tauri::command(async)]
pub fn get_effective_skill_loads() -> Result<crate::skill_loads::EffectiveSkillLoads, String> {
    let settings = crate::settings::try_load()
        .map_err(|error| format!("cannot tell which harnesses are enabled: {error}"))?;
    let workspace_root = setup_workspace_target_path()?;
    let home = crate::agent_targets::home_dir()?;
    let bundled_root = crate::setup_roots::bundled_root_for(&workspace_root)?;
    let records = crate::managed_state::read_managed_state(&workspace_root)
        .map(|state| state.artifacts)
        .unwrap_or_default();
    let proof = crate::skill_loads::OwnershipProof::new(&bundled_root, &records)?
        .with_kept(crate::kept_files::KeptFiles::load(&workspace_root));
    Ok(crate::skill_loads::effective_skill_loads(
        &home,
        &settings.enabled_harness_ids,
        &crate::skill_loads::FolderPaths::resolve(&home),
        &proof,
    ))
}

#[tauri::command]
pub fn read_skill(id: String) -> Result<DocumentContent, String> {
    let root = bundled_library_root()?;
    let skills = discover_skills(&root)?;
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

#[cfg(test)]
pub(crate) fn workspace_skill_names(root: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = discover_workspace_skills(&root.join("skills"))?
        .into_keys()
        .collect();
    names.sort();
    Ok(names)
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
        std::env::temp_dir().join(format!("riggverk-{name}-{nonce}"))
    }

    #[cfg(unix)]
    #[test]
    fn dangling_skill_file_symlink_is_refused() {
        let root = temp_root("dangling-skill-md");
        let skill_dir = root.join("skills/group/skill");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::os::unix::fs::symlink(root.join("missing.md"), skill_dir.join("SKILL.md"))
            .expect("create dangling symlink");
        let result = discover_skills(&root);
        let _ = fs::remove_dir_all(&root);
        let err = result.err().expect("dangling symlink must not be skipped");
        assert!(err.contains("refusing symlink skill file"), "{err}");
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
        write_skill(
            &root,
            "skills/kretsverket/kretsverket-editor-change",
            "kretsverket-editor-change",
        );

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(
            skills[0].id,
            "workspace/kretsverket/kretsverket-editor-change"
        );
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
        write_skill(
            &root,
            "skills/kretsverket/kretsverket-editor-change",
            "kretsverket-editor-change",
        );

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
        write_skill(
            &root,
            "skills/kretsverket/kretsverket-editor-change",
            "kretsverket-editor-change",
        );

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
