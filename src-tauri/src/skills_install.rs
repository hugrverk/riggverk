use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_skill_targets::validate_skill_name;
use crate::path_safety::reject_symlink;

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

fn path_within_root(child: &Path, root: &Path) -> Result<(), String> {
    let canonical_child = child
        .canonicalize()
        .map_err(|e| format!("cannot resolve {}: {e}", child.display()))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve skills root {}: {e}", root.display()))?;
    if canonical_child == canonical_root || canonical_child.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err(format!(
            "skill path escapes workspace skills root: {}",
            child.display()
        ))
    }
}

fn has_deeper_skill_md(dir: &Path) -> bool {
    scan_deeper_skill_md(dir, 0)
}

/// Recursively scan for SKILL.md files at depths deeper than one group level.
/// Bounded to prevent infinite recursion on deep trees.
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

fn register_discovered_skill(
    mapping: &mut HashMap<String, PathBuf>,
    skill_dir: &Path,
    skill_md: &Path,
    fallback_name: &str,
) -> Result<(), String> {
    reject_symlink(skill_dir, "skill directory")?;
    reject_symlink(skill_md, "skill file")?;
    if !skill_md.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(skill_md)
        .map_err(|e| format!("cannot read {}: {e}", skill_md.display()))?;
    let mut name = extract_frontmatter(&content, "name");
    if name.is_empty() {
        name = fallback_name.to_string();
    }
    validate_skill_name(&name, &skill_md.to_string_lossy())?;
    if mapping.contains_key(&name) {
        return Err(format!("duplicate skill name in repository: {name}"));
    }
    mapping.insert(name, skill_dir.to_path_buf());
    Ok(())
}

pub fn discover_workspace_skills(skills_dir: &Path) -> Result<HashMap<String, PathBuf>, String> {
    if !skills_dir.is_dir() {
        return Err(format!(
            "skills directory not found: {}",
            skills_dir.display()
        ));
    }
    reject_symlink(skills_dir, "skills root")?;
    let canonical_root = skills_dir
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize skills root: {e}"))?;

    let mut mapping = HashMap::new();
    for entry in fs::read_dir(skills_dir).map_err(|e| format!("cannot read skills dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read error: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
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
        path_within_root(&entry_path, &canonical_root)?;
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let root_skill_md = entry_path.join("SKILL.md");
        if root_skill_md.is_file() {
            if has_deeper_skill_md(&entry_path) {
                return Err(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    entry_path.display()
                ));
            }
            register_discovered_skill(&mut mapping, &entry_path, &root_skill_md, &entry_name)?;
            continue;
        }

        let sub_entries =
            fs::read_dir(&entry_path).map_err(|e| format!("cannot read skills group dir: {e}"))?;
        for sub in sub_entries {
            let sub = sub.map_err(|e| format!("read error: {e}"))?;
            let sub_type = sub.file_type().map_err(|e| format!("file type: {e}"))?;
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
            path_within_root(&sub_path, &canonical_root)?;
            let sub_name = sub.file_name().to_string_lossy().into_owned();
            let grouped_skill_md = sub_path.join("SKILL.md");
            if grouped_skill_md.is_file() {
                register_discovered_skill(&mut mapping, &sub_path, &grouped_skill_md, &sub_name)?;
            } else if has_deeper_skill_md(&sub_path) {
                return Err(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    sub_path.display()
                ));
            }
        }
    }

    if mapping.is_empty() {
        return Err(format!("no skills found in {}", skills_dir.display()));
    }
    Ok(mapping)
}
