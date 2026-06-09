use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_skill_targets::validate_skill_dest_root;
use crate::commands::file_eq;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillRootScan {
    pub root_id: String,
    pub root_path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DuplicateSkillEntry {
    pub name: String,
    pub state: String,
    pub locations: Vec<SkillRootScan>,
    pub next_action: String,
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

fn scan_root(root_id: &str, root: &Path) -> Result<HashMap<String, PathBuf>, String> {
    let mut found = HashMap::new();
    if !root.is_dir() {
        return Ok(found);
    }
    validate_skill_dest_root(root)?;
    reject_symlink_path(root, "skill audit root")?;

    for entry in fs::read_dir(root).map_err(|e| format!("read {}: {e}", root.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink in skill audit root {}: {}",
                root_id,
                entry.path().display()
            ));
        }
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        reject_symlink_path(&skill_md, "skill file")?;
        if skill_md.is_file() {
            found.insert(name, skill_md);
        }
    }
    Ok(found)
}

pub fn audit_duplicate_skills(roots: &[(&str, PathBuf)]) -> Result<Vec<DuplicateSkillEntry>, String> {
    let mut by_name: HashMap<String, Vec<(String, PathBuf)>> = HashMap::new();

    for (root_id, root) in roots {
        for (name, skill_md) in scan_root(root_id, root)? {
            by_name
                .entry(name)
                .or_default()
                .push(((*root_id).to_string(), skill_md));
        }
    }

    let mut duplicates = Vec::new();
    for (name, locations) in by_name {
        if locations.len() < 2 {
            continue;
        }
        let first_md = &locations[0].1;
        let all_identical = locations
            .iter()
            .skip(1)
            .all(|(_, md)| file_eq(first_md, md));
        let state = if all_identical {
            "duplicate-identical"
        } else {
            "duplicate-diverged"
        };
        duplicates.push(DuplicateSkillEntry {
            name,
            state: state.into(),
            locations: locations
                .into_iter()
                .map(|(root_id, skill_md)| SkillRootScan {
                    root_id,
                    root_path: skill_md
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                })
                .collect(),
            next_action: "read-only audit; no automatic deduplication".into(),
        });
    }

    duplicates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(duplicates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-dup-audit-{label}-{nonce}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_skill(root: &Path, name: &str, content: &str) {
        let skill_md = root.join(name).join("SKILL.md");
        if let Some(parent) = skill_md.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(skill_md, content).expect("write");
    }

    #[test]
    fn identical_duplicates_are_classified() {
        let root_a = temp_root("a");
        let root_b = temp_root("b");
        write_skill(&root_a, "diagnose", "name: diagnose\n");
        write_skill(&root_b, "diagnose", "name: diagnose\n");
        let dups = audit_duplicate_skills(&[
            ("global", root_a.clone()),
            ("project", root_b.clone()),
        ])
        .expect("audit");
        assert_eq!(dups.len(), 1);
        assert_eq!(dups[0].state, "duplicate-identical");
    }

    #[test]
    fn diverged_duplicates_are_classified() {
        let root_a = temp_root("a-div");
        let root_b = temp_root("b-div");
        write_skill(&root_a, "diagnose", "name: diagnose\na: true\n");
        write_skill(&root_b, "diagnose", "name: diagnose\nb: true\n");
        let dups = audit_duplicate_skills(&[("global", root_a), ("project", root_b)]).expect("audit");
        assert_eq!(dups.len(), 1);
        assert_eq!(dups[0].state, "duplicate-diverged");
    }
}
