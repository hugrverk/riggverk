use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_skill_targets::{validate_skill_dest_root, validate_skill_name};
use crate::commands::backups::backup_root;
use crate::commands::{file_eq, ActionResult};

const MANIFEST_REL: &str = "metadata/deprecated-skills.json";
const REFERENCE_ROOT_REL: &str = "metadata/deprecated-skills";

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeprecatedSkillEntry {
    pub name: String,
    pub state: String,
    pub target_path: String,
    pub removable: bool,
    pub next_action: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeprecatedRemovalPreview {
    pub agent: String,
    pub backup_path: String,
    pub items: Vec<DeprecatedRemovalPreviewItem>,
    pub removable_count: usize,
    pub skipped_diverged_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeprecatedRemovalPreviewItem {
    pub name: String,
    pub state: String,
    pub target_path: String,
    pub action: String,
}

pub fn load_deprecated_names(workspace_root: &Path) -> Result<Vec<String>, String> {
    let manifest_path = workspace_root.join(MANIFEST_REL);
    if !manifest_path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("cannot read {}: {e}", manifest_path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid {}: {e}", manifest_path.display()))?;
    let skills = value
        .get("skills")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("{} missing skills array", manifest_path.display()))?;
    let mut names = Vec::new();
    for item in skills {
        let name = item
            .as_str()
            .ok_or_else(|| format!("{} skills entries must be strings", manifest_path.display()))?
            .to_string();
        validate_skill_name(&name, MANIFEST_REL)?;
        names.push(name);
    }
    names.sort();
    names.dedup();
    Ok(names)
}

fn reference_skill_md(workspace_root: &Path, name: &str) -> PathBuf {
    workspace_root
        .join(REFERENCE_ROOT_REL)
        .join(name)
        .join("SKILL.md")
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
            "skill path escapes destination root: {}",
            child.display()
        ))
    }
}

fn classify_deprecated(
    workspace_root: &Path,
    dest_root: &Path,
    name: &str,
) -> Result<Option<DeprecatedSkillEntry>, String> {
    validate_skill_name(name, "installed skill directory")?;
    let skill_dir = dest_root.join(name);
    reject_symlink_path(&skill_dir, "installed skill directory")?;
    if !skill_dir.is_dir() {
        return Ok(None);
    }
    path_within_root(&skill_dir, dest_root)?;

    let installed_md = skill_dir.join("SKILL.md");
    reject_symlink_path(&installed_md, "installed skill file")?;
    if !installed_md.is_file() {
        return Ok(None);
    }

    let reference_md = reference_skill_md(workspace_root, name);
    reject_symlink_path(&reference_md, "deprecated reference file")?;
    if !reference_md.is_file() {
        return Err(format!(
            "deprecated reference missing for {name}: {}",
            reference_md.display()
        ));
    }

    let identical = file_eq(&installed_md, &reference_md);
    let state = if identical {
        "deprecated-identical"
    } else {
        "deprecated-diverged"
    };
    let (removable, next_action) = if identical {
        (true, "preview removal")
    } else {
        (false, "review manually; sync will not remove")
    };

    Ok(Some(DeprecatedSkillEntry {
        name: name.to_string(),
        state: state.into(),
        target_path: skill_dir.to_string_lossy().into_owned(),
        removable,
        next_action: next_action.into(),
    }))
}

pub fn scan_deprecated_installed(
    workspace_root: &Path,
    dest_root: &Path,
    current_skill_names: &HashSet<String>,
) -> Result<Vec<DeprecatedSkillEntry>, String> {
    validate_skill_dest_root(dest_root)?;
    reject_symlink_path(dest_root, "skill destination root")?;

    let deprecated_names: HashSet<String> = load_deprecated_names(workspace_root)?
        .into_iter()
        .collect();
    if deprecated_names.is_empty() {
        return Ok(Vec::new());
    }

    if !dest_root.exists() {
        return Ok(Vec::new());
    }

    let mut found = Vec::new();
    for entry in fs::read_dir(dest_root)
        .map_err(|e| format!("cannot read skill destination {}: {e}", dest_root.display()))?
    {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink in skill destination: {}",
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
        if current_skill_names.contains(&name) {
            continue;
        }
        if !deprecated_names.contains(&name) {
            continue;
        }
        if let Some(item) = classify_deprecated(workspace_root, dest_root, &name)? {
            found.push(item);
        }
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

fn planned_backup_dir(agent: &str) -> Result<PathBuf, String> {
    let root = backup_root()?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    Ok(root.join("deprecated-skills").join(format!("{agent}-{nonce}")))
}

fn create_backup_dir(agent: &str) -> Result<PathBuf, String> {
    let dir = planned_backup_dir(agent)?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create backup dir {}: {e}", dir.display()))?;
    Ok(dir)
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    reject_symlink_path(src, "backup source")?;
    fs::create_dir_all(dst).map_err(|e| format!("create dir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink in backup source: {}",
                entry.path().display()
            ));
        }
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|e| format!("copy {} -> {}: {e}", entry.path().display(), target.display()))?;
        }
    }
    Ok(())
}

fn remove_dir_all(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    reject_symlink_path(path, "removal target")?;
    for entry in fs::read_dir(path).map_err(|e| format!("read dir {}: {e}", path.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let entry_path = entry.path();
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink during removal: {}",
                entry_path.display()
            ));
        }
        if file_type.is_dir() {
            remove_dir_all(&entry_path)?;
        } else {
            fs::remove_file(&entry_path)
                .map_err(|e| format!("remove file {}: {e}", entry_path.display()))?;
        }
    }
    fs::remove_dir(path).map_err(|e| format!("remove dir {}: {e}", path.display()))
}

pub fn preview_removal(
    agent: &str,
    workspace_root: &Path,
    dest_root: &Path,
    current_skill_names: &HashSet<String>,
) -> Result<DeprecatedRemovalPreview, String> {
    let deprecated = scan_deprecated_installed(workspace_root, dest_root, current_skill_names)?;
    let backup_path = planned_backup_dir(agent)?;
    let mut items = Vec::new();
    let mut removable_count = 0usize;
    let mut skipped_diverged_count = 0usize;

    for entry in deprecated {
        let action = if entry.removable {
            removable_count += 1;
            "remove after backup"
        } else {
            skipped_diverged_count += 1;
            "skip (diverged)"
        };
        items.push(DeprecatedRemovalPreviewItem {
            name: entry.name,
            state: entry.state,
            target_path: entry.target_path,
            action: action.into(),
        });
    }

    Ok(DeprecatedRemovalPreview {
        agent: agent.into(),
        backup_path: if removable_count > 0 {
            backup_path.to_string_lossy().into_owned()
        } else {
            String::new()
        },
        items,
        removable_count,
        skipped_diverged_count,
    })
}

pub fn remove_identical_deprecated(
    agent: &str,
    workspace_root: &Path,
    dest_root: &Path,
    current_skill_names: &HashSet<String>,
    dry_run: bool,
) -> Result<ActionResult, String> {
    let preview = preview_removal(agent, workspace_root, dest_root, current_skill_names)?;
    let mut lines = Vec::new();
    lines.push(format!(
        "deprecated skill removal preview for {agent}: {} removable, {} diverged (skipped)",
        preview.removable_count, preview.skipped_diverged_count
    ));
    for item in &preview.items {
        lines.push(format!(
            "- {} [{}] {} -> {}",
            item.name, item.state, item.target_path, item.action
        ));
    }

    if preview.removable_count == 0 {
        return Ok(ActionResult::new(
            true,
            if dry_run {
                "remove_deprecated_skills:dry-run"
            } else {
                "remove_deprecated_skills"
            },
            lines.join("\n"),
            String::new(),
            Some(0),
        ));
    }

    if dry_run {
        lines.push(format!(
            "backup would be written to: {}",
            preview.backup_path
        ));
        return Ok(ActionResult::new(
            true,
            "remove_deprecated_skills:dry-run",
            lines.join("\n"),
            String::new(),
            Some(0),
        ));
    }

    let backup_dir = create_backup_dir(agent)?;
    let mut removed: Vec<String> = Vec::new();
    for item in preview
        .items
        .iter()
        .filter(|item| item.action == "remove after backup")
    {
        let skill_dir = PathBuf::from(&item.target_path);
        path_within_root(&skill_dir, dest_root)?;
        let backup_target = backup_dir.join(&item.name);
        if let Err(err) = copy_dir_all(&skill_dir, &backup_target) {
            return Err(format!(
                "backup failed for {} after removing [{}]: {err}; rollback from {}",
                item.name,
                removed.join(", "),
                backup_dir.display()
            ));
        }
        if let Err(err) = remove_dir_all(&skill_dir) {
            return Err(format!(
                "removal failed for {} after removing [{}]: {err}; rollback from {}",
                item.name,
                removed.join(", "),
                backup_dir.display()
            ));
        }
        removed.push(item.name.clone());
        lines.push(format!("removed {} (backup: {})", item.name, backup_target.display()));
    }

    lines.push(format!("backup root: {}", backup_dir.display()));
    Ok(ActionResult::new(
        true,
        "remove_deprecated_skills",
        lines.join("\n"),
        String::new(),
        Some(0),
    ))
}

pub fn rollback_removal(backup_path: &str) -> Result<ActionResult, String> {
    let backup_dir = PathBuf::from(backup_path);
    reject_symlink_path(&backup_dir, "rollback backup")?;
    if !backup_dir.is_dir() {
        return Err(format!("rollback backup not found: {}", backup_dir.display()));
    }

    let parent = backup_dir
        .parent()
        .ok_or_else(|| "rollback backup has no parent".to_string())?;
    if parent
        .file_name()
        .and_then(|name| name.to_str())
        != Some("deprecated-skills")
    {
        return Err(format!(
            "refusing rollback outside deprecated-skills backups: {}",
            backup_dir.display()
        ));
    }

    let mut restored = Vec::new();
    for entry in fs::read_dir(&backup_dir)
        .map_err(|e| format!("cannot read rollback backup {}: {e}", backup_dir.display()))?
    {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink in rollback backup: {}",
                entry.path().display()
            ));
        }
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        validate_skill_name(&name, "rollback skill")?;
        restored.push(name);
    }

    Ok(ActionResult::new(
        true,
        "rollback_deprecated_skills_removal",
        format!(
            "rollback backup contains {} skill directories: {}",
            restored.len(),
            restored.join(", ")
        ),
        format!(
            "restore manually by copying each directory from {} back to the harness skills destination",
            backup_dir.display()
        ),
        Some(0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::{guard, set_test_user_dirs};
    use std::sync::Mutex;

    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-deprecated-{label}-{nonce}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, content).expect("write");
    }

    fn setup_workspace_with_deprecated_refs(root: &Path) {
        write_file(
            &root.join("metadata/deprecated-skills.json"),
            r#"{"version":1,"skills":["caveman"]}"#,
        );
        write_file(
            &root.join("metadata/deprecated-skills/caveman/SKILL.md"),
            "name: caveman\n",
        );
    }

    #[test]
    fn identical_deprecated_skill_is_removable() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-identical");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-identical");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".codex/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::from(["diagnose".to_string()]);
        let found = scan_deprecated_installed(&workspace, &dest, &current).expect("scan");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].state, "deprecated-identical");
        assert!(found[0].removable);

        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, false)
            .expect("remove");
        assert!(result.success);
        assert!(!dest.join("caveman").exists());
    }

    #[test]
    fn diverged_deprecated_skill_is_not_removed() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-diverged");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-diverged");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".codex/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\ncustom: true\n");

        let current = HashSet::new();
        let preview = preview_removal("codex", &workspace, &dest, &current).expect("preview");
        assert_eq!(preview.removable_count, 0);
        assert_eq!(preview.skipped_diverged_count, 1);

        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, false)
            .expect("remove");
        assert!(result.success);
        assert!(dest.join("caveman").exists());
    }

    #[test]
    fn dry_run_does_not_remove_or_backup() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-dry");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-dry");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".codex/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, true)
            .expect("dry run");
        assert!(result.success);
        assert!(dest.join("caveman").exists());
        assert!(home.join("backups/deprecated-skills").read_dir().is_err()
            || home.join("backups/deprecated-skills").read_dir().unwrap().count() == 0);
    }

    #[test]
    fn bundled_skills_are_not_classified_as_deprecated() {
        let workspace = temp_root("ws-bundled");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = temp_root("dest-bundled");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::from(["caveman".to_string()]);
        let found = scan_deprecated_installed(&workspace, &dest, &current).expect("scan");
        assert!(found.is_empty());
    }
}
