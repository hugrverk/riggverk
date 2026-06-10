//! Canonical read-only skill catalog discovery.
//!
//! Single owner for SKILL.md layout validation, frontmatter parsing, and
//! harness target metadata used by setup, health checks, and artifact expansion.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_skill_targets::VALID_SKILL_AGENTS;

/// One discovered skill from the workspace skills catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    pub targets: Vec<String>,
    pub group: String,
    pub source_dir: PathBuf,
    pub skill_md_path: PathBuf,
    /// Path relative to workspace root, forward slashes (e.g. skills/foo/SKILL.md).
    pub relative_path: String,
}

/// Error kind for distinguishing invalid catalog from empty valid catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillDiscoveryError {
    MissingRoot(String),
    InvalidCatalog(String),
}

impl SkillDiscoveryError {
    pub fn message(&self) -> &str {
        match self {
            Self::MissingRoot(m) | Self::InvalidCatalog(m) => m,
        }
    }
}

impl std::fmt::Display for SkillDiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

fn reject_symlink_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("cannot inspect {label} {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing symlink {label}: {}", path.display()));
    }
    Ok(())
}

fn has_deeper_skill_md(dir: &Path) -> bool {
    scan_deeper_skill_md(dir, 0)
}

fn scan_deeper_skill_md(dir: &Path, depth: usize) -> bool {
    const MAX_ENTRIES: usize = 10_000;
    const MAX_DEPTH: usize = 20;

    if depth > MAX_DEPTH {
        return true;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };

    let mut count = 0;
    for entry in entries.flatten() {
        count += 1;
        if count > MAX_ENTRIES {
            return true;
        }
        let path = entry.path();
        if path.is_symlink() {
            return true;
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

fn extract_frontmatter(content: &str, key: &str) -> String {
    let prefix = format!("{key}:");
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
    // Support comma-separated: targets: codex, opencode, claude, cursor
    // Also support bracket lists: targets: [codex, opencode]
    let trimmed = raw.trim();
    let inner = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        trimmed
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim()
    } else {
        trimmed
    };
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_frontmatter_body(content: &str) -> Result<&str, String> {
    let rest = content
        .strip_prefix("---")
        .ok_or_else(|| "missing frontmatter opening delimiter".to_string())?;
    let end = rest
        .find("---")
        .ok_or_else(|| "missing frontmatter closing delimiter".to_string())?;
    Ok(&rest[..end])
}

fn read_skill_metadata(skill_md: &Path, fallback_name: &str) -> Result<(String, String, Vec<String>), String> {
    let content = fs::read_to_string(skill_md)
        .map_err(|e| format!("cannot read {}: {e}", skill_md.display()))?;
    parse_frontmatter_body(&content).map_err(|e| {
        format!("invalid frontmatter in {}: {e}", skill_md.display())
    })?;
    let name = extract_frontmatter(&content, "name");
    let description = extract_frontmatter(&content, "description");
    let targets = extract_frontmatter_list(&content, "targets");
    let name = if name.is_empty() {
        fallback_name.to_string()
    } else {
        name
    };
    if name.is_empty() {
        return Err(format!(
            "skill name is empty in {}",
            skill_md.display()
        ));
    }
    if description.is_empty() {
        return Err(format!(
            "skill description is empty in {}",
            skill_md.display()
        ));
    }
    Ok((name, description, targets))
}

fn register_skill(
    discovered: &mut Vec<DiscoveredSkill>,
    workspace_root: &Path,
    skill_dir: &Path,
    skill_md: &Path,
    fallback_name: &str,
    group: &str,
) -> Result<(), String> {
    reject_symlink_path(skill_dir, "skill directory")?;
    reject_symlink_path(skill_md, "skill file")?;
    if !skill_md.is_file() {
        return Ok(());
    }
    let (name, description, targets) = read_skill_metadata(skill_md, fallback_name)?;
    if discovered.iter().any(|s| s.name == name) {
        return Err(format!("duplicate skill name in repository: {name}"));
    }
    let relative_path = skill_md
        .strip_prefix(workspace_root)
        .unwrap_or(skill_md)
        .to_string_lossy()
        .replace('\\', "/");
    discovered.push(DiscoveredSkill {
        name,
        description,
        targets,
        group: group.to_string(),
        source_dir: skill_dir.to_path_buf(),
        skill_md_path: skill_md.to_path_buf(),
        relative_path,
    });
    Ok(())
}

/// Discover the full skill catalog under `workspace_root/skills`.
///
/// Returns `Err` on missing root, unreadable entries, invalid metadata, or
/// duplicate names. Never returns an empty `Ok` after a parsing failure.
pub fn discover_skill_catalog(workspace_root: &Path) -> Result<Vec<DiscoveredSkill>, SkillDiscoveryError> {
    let skills_dir = workspace_root.join("skills");
    if !skills_dir.is_dir() {
        return Err(SkillDiscoveryError::MissingRoot(format!(
            "skills directory not found: {}",
            skills_dir.display()
        )));
    }
    if let Err(e) = reject_symlink_path(&skills_dir, "skills root") {
        return Err(SkillDiscoveryError::InvalidCatalog(e));
    }

    let mut discovered: Vec<DiscoveredSkill> = Vec::new();
    let entries = fs::read_dir(&skills_dir).map_err(|e| {
        SkillDiscoveryError::InvalidCatalog(format!("cannot read skills dir: {e}"))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("read error: {e}")))?;
        let file_type = entry
            .file_type()
            .map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("file type error: {e}")))?;
        if file_type.is_symlink() {
            return Err(SkillDiscoveryError::InvalidCatalog(format!(
                "refusing symlink skill directory: {}",
                entry.path().display()
            )));
        }
        if !file_type.is_dir() {
            continue;
        }

        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let root_skill_md = entry_path.join("SKILL.md");
        if root_skill_md.is_file() {
            if has_deeper_skill_md(&entry_path) {
                return Err(SkillDiscoveryError::InvalidCatalog(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    entry_path.display()
                )));
            }
            register_skill(
                &mut discovered,
                workspace_root,
                &entry_path,
                &root_skill_md,
                &entry_name,
                "",
            )
            .map_err(SkillDiscoveryError::InvalidCatalog)?;
            continue;
        }

        let sub_entries = fs::read_dir(&entry_path).map_err(|e| {
            SkillDiscoveryError::InvalidCatalog(format!("cannot read skills group dir: {e}"))
        })?;
        for sub in sub_entries {
            let sub = sub.map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("read error: {e}")))?;
            let sub_type = sub
                .file_type()
                .map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("file type error: {e}")))?;
            if sub_type.is_symlink() {
                return Err(SkillDiscoveryError::InvalidCatalog(format!(
                    "refusing symlink skill directory: {}",
                    sub.path().display()
                )));
            }
            if !sub_type.is_dir() {
                continue;
            }
            let sub_path = sub.path();
            let sub_name = sub.file_name().to_string_lossy().into_owned();
            let grouped_skill_md = sub_path.join("SKILL.md");
            if grouped_skill_md.is_file() {
                register_skill(
                    &mut discovered,
                    workspace_root,
                    &sub_path,
                    &grouped_skill_md,
                    &sub_name,
                    &entry_name,
                )
                .map_err(SkillDiscoveryError::InvalidCatalog)?;
            } else if has_deeper_skill_md(&sub_path) {
                return Err(SkillDiscoveryError::InvalidCatalog(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    sub_path.display()
                )));
            }
        }
    }

    discovered.sort_by(|a, b| match a.group.cmp(&b.group) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });

    if discovered.is_empty() {
        return Err(SkillDiscoveryError::InvalidCatalog(format!(
            "no skills found in {}",
            skills_dir.display()
        )));
    }

    Ok(discovered)
}

/// Return skill names from the catalog that target the given harness.
///
/// Fails closed if the catalog is invalid or the harness is unknown.
pub fn skill_names_for_harness(
    workspace_root: &Path,
    harness: &str,
) -> Result<Vec<String>, String> {
    if !VALID_SKILL_AGENTS.contains(&harness) {
        return Err(format!("invalid harness agent: {harness}"));
    }
    let catalog = discover_skill_catalog(workspace_root).map_err(|e| e.message().to_string())?;
    Ok(catalog
        .iter()
        .filter(|s| s.targets.iter().any(|t| t == harness))
        .map(|s| s.name.clone())
        .collect())
}

/// Require every skill in the catalog to declare exactly the supported harness set.
pub fn validate_catalog_targets_exact(catalog: &[DiscoveredSkill]) -> Result<(), String> {
    let expected: HashSet<&str> = VALID_SKILL_AGENTS.iter().copied().collect();
    for skill in catalog {
        let actual: HashSet<&str> = skill.targets.iter().map(|s| s.as_str()).collect();
        if actual != expected {
            return Err(format!(
                "skill '{}' targets {:?}; expected exactly {:?}",
                skill.name, skill.targets, VALID_SKILL_AGENTS
            ));
        }
    }
    Ok(())
}

/// Find source directory for a skill name (root-level or grouped).
pub fn find_skill_source_dir(workspace_root: &Path, name: &str) -> Option<PathBuf> {
    let catalog = discover_skill_catalog(workspace_root).ok()?;
    catalog
        .iter()
        .find(|s| s.name == name)
        .map(|s| s.source_dir.clone())
}

/// Check whether a skill targets a harness using canonical catalog discovery.
pub fn skill_targets_harness(workspace_root: &Path, skill_name: &str, harness: &str) -> Result<bool, String> {
    let catalog = discover_skill_catalog(workspace_root).map_err(|e| e.message().to_string())?;
    Ok(catalog
        .iter()
        .find(|s| s.name == skill_name)
        .map(|s| s.targets.iter().any(|t| t == harness))
        .unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-skill-disc-{name}-{nonce}"))
    }

    fn write_skill(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    const ALL_TARGETS: &str = "codex, opencode, claude, cursor";

    fn skill_body(name: &str, targets: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: test skill\ntargets: {targets}\n---\n# {name}\n"
        )
    }

    #[test]
    fn root_level_skill_discovered() {
        let root = temp_root("root");
        write_skill(&root, "skills/diagnose", &skill_body("diagnose", ALL_TARGETS));
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "diagnose");
        assert_eq!(catalog[0].group, "");
        assert!(catalog[0].skill_md_path.ends_with("SKILL.md"));
    }

    #[test]
    fn grouped_skill_discovered() {
        let root = temp_root("grouped");
        write_skill(
            &root,
            "skills/kretsverket/kretsverket-editor-change",
            &skill_body("kretsverket-editor-change", ALL_TARGETS),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "kretsverket-editor-change");
        assert_eq!(catalog[0].group, "kretsverket");
    }

    #[test]
    fn comma_separated_targets_parsed() {
        let root = temp_root("comma");
        write_skill(
            &root,
            "skills/security-review",
            &skill_body("security-review", "codex,  opencode , claude,cursor"),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(
            catalog[0].targets,
            vec!["codex", "opencode", "claude", "cursor"]
        );
    }

    #[test]
    fn all_four_targets_required_for_exact_validation() {
        let root = temp_root("four");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", ALL_TARGETS),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        validate_catalog_targets_exact(&catalog).expect("exact targets");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_target_fails_exact_validation() {
        let root = temp_root("missing-target");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", "codex, opencode, claude"),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let err = validate_catalog_targets_exact(&catalog).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.contains("diagnose"));
    }

    #[test]
    fn unknown_target_fails_exact_validation() {
        let root = temp_root("unknown-target");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", "codex, opencode, claude, cursor, gemini"),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let err = validate_catalog_targets_exact(&catalog).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.contains("diagnose"));
    }

    #[test]
    fn duplicate_name_fails() {
        let root = temp_root("dup");
        write_skill(&root, "skills/a/foo", &skill_body("same-name", ALL_TARGETS));
        write_skill(&root, "skills/b/foo", &skill_body("same-name", ALL_TARGETS));
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("duplicate skill name"));
    }

    #[test]
    fn deep_nesting_rejected() {
        let root = temp_root("deep");
        write_skill(
            &root,
            "skills/group/nested/skill",
            &skill_body("deep-skill", ALL_TARGETS),
        );
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("deeper than one group level"));
    }

    #[test]
    fn symlinked_group_rejected() {
        let root = temp_root("sym-group");
        let real = root.join("skills/real-group/real-skill");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        write_skill(&root, "skills/real-group/real-skill", &skill_body("real-skill", ALL_TARGETS));
        let link = root.join("skills/link-group");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("skills/real-group"), &link).unwrap();
            let err = discover_skill_catalog(&root).unwrap_err();
            assert!(err.message().contains("symlink"));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn symlinked_skill_rejected() {
        let root = temp_root("sym-skill");
        let real = root.join("skills/real-skill");
        fs::create_dir_all(&real).unwrap();
        write_skill(&root, "skills/real-skill", &skill_body("real-skill", ALL_TARGETS));
        let link = root.join("skills/link-skill");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let err = discover_skill_catalog(&root).unwrap_err();
            assert!(err.message().contains("symlink"));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_frontmatter_rejected() {
        let root = temp_root("bad-fm");
        write_skill(&root, "skills/bad", "no frontmatter here\n");
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("frontmatter"));
    }

    #[test]
    fn missing_skills_root_is_error() {
        let root = temp_root("no-skills");
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(matches!(err, SkillDiscoveryError::MissingRoot(_)));
    }

    #[test]
    fn harness_filter_returns_matching_names() {
        let root = temp_root("harness");
        write_skill(&root, "skills/a", &skill_body("skill-a", ALL_TARGETS));
        write_skill(
            &root,
            "skills/b",
            &skill_body("skill-b", "codex, opencode"),
        );
        let names = skill_names_for_harness(&root, "claude").expect("filter");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(names, vec!["skill-a"]);
    }

    #[test]
    fn bundled_workspace_has_exactly_21_skills() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let catalog = discover_skill_catalog(&repo).expect("bundled catalog");
        validate_catalog_targets_exact(&catalog).expect("bundled targets");
        assert_eq!(catalog.len(), 21, "expected 21 bundled skills");
    }
}
