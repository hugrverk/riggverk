use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_skill_targets::{codex_global_skills_dest, codex_legacy_skills_dest, validate_skill_dest_root};
use crate::commands::{file_eq, ActionResult};
use crate::cursor_profile_paths::resolve_user_home;

#[derive(Debug, Clone, serde::Serialize)]
pub struct CodexLegacySkillEntry {
    pub name: String,
    pub state: String,
    pub legacy_path: String,
    pub target_path: String,
    pub next_action: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CodexLegacyMigrationPreview {
    pub legacy_root: String,
    pub target_root: String,
    pub items: Vec<CodexLegacySkillEntry>,
    pub migratable_count: usize,
    pub already_migrated_count: usize,
    pub conflict_count: usize,
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

fn list_skill_dirs(root: &Path) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    reject_symlink_path(root, "skill root")?;
    let mut names = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| format!("read {}: {e}", root.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
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
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        reject_symlink_path(&skill_md, "skill file")?;
        if skill_md.is_file() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub fn preview_migration(home: &Path) -> Result<CodexLegacyMigrationPreview, String> {
    let legacy_root = codex_legacy_skills_dest(home);
    let target_root = codex_global_skills_dest(home);
    validate_skill_dest_root(&legacy_root)?;
    validate_skill_dest_root(&target_root)?;

    let mut items = Vec::new();
    let mut migratable_count = 0usize;
    let mut already_migrated_count = 0usize;
    let mut conflict_count = 0usize;

    for name in list_skill_dirs(&legacy_root)? {
        let legacy_dir = legacy_root.join(&name);
        let target_dir = target_root.join(&name);
        let legacy_md = legacy_dir.join("SKILL.md");
        let target_md = target_dir.join("SKILL.md");

        let (state, next_action) = if !target_md.is_file() {
            migratable_count += 1;
            ("legacy-migratable", "copy from legacy to ~/.agents/skills")
        } else if file_eq(&legacy_md, &target_md) {
            already_migrated_count += 1;
            ("legacy-already-migrated", "none")
        } else {
            conflict_count += 1;
            ("legacy-conflict", "review manually; legacy left untouched")
        };

        items.push(CodexLegacySkillEntry {
            name,
            state: state.into(),
            legacy_path: legacy_dir.to_string_lossy().into_owned(),
            target_path: target_dir.to_string_lossy().into_owned(),
            next_action: next_action.into(),
        });
    }

    Ok(CodexLegacyMigrationPreview {
        legacy_root: legacy_root.to_string_lossy().into_owned(),
        target_root: target_root.to_string_lossy().into_owned(),
        items,
        migratable_count,
        already_migrated_count,
        conflict_count,
    })
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    reject_symlink_path(src, "migration source")?;
    fs::create_dir_all(dst).map_err(|e| format!("create dir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("file type: {e}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink in migration source: {}",
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

pub fn migrate_legacy_skills(dry_run: bool) -> Result<ActionResult, String> {
    let home = resolve_user_home()?;
    let preview = preview_migration(&home)?;
    let mut lines = vec![format!(
        "codex legacy migration: {} migratable, {} already migrated, {} conflicts",
        preview.migratable_count, preview.already_migrated_count, preview.conflict_count
    )];
    for item in &preview.items {
        lines.push(format!(
            "- {} [{}] legacy={} target={} -> {}",
            item.name, item.state, item.legacy_path, item.target_path, item.next_action
        ));
    }

    if preview.migratable_count == 0 {
        return Ok(ActionResult::new(
            true,
            if dry_run {
                "migrate_codex_legacy_skills:dry-run"
            } else {
                "migrate_codex_legacy_skills"
            },
            lines.join("\n"),
            String::new(),
            Some(0),
        ));
    }

    if dry_run {
        lines.push("dry run: no files copied; legacy directories left untouched".into());
        return Ok(ActionResult::new(
            true,
            "migrate_codex_legacy_skills:dry-run",
            lines.join("\n"),
            String::new(),
            Some(0),
        ));
    }

    let target_root = PathBuf::from(&preview.target_root);
    fs::create_dir_all(&target_root)
        .map_err(|e| format!("cannot create target root {}: {e}", target_root.display()))?;

    let mut migrated = Vec::new();
    for item in preview
        .items
        .iter()
        .filter(|item| item.state == "legacy-migratable")
    {
        let legacy_dir = PathBuf::from(&item.legacy_path);
        let target_dir = target_root.join(&item.name);
        if let Err(err) = copy_dir_all(&legacy_dir, &target_dir) {
            return Err(format!(
                "migration failed for {} after migrating [{}]: {err}",
                item.name,
                migrated.join(", ")
            ));
        }
        migrated.push(item.name.clone());
        lines.push(format!("migrated {} to {}", item.name, target_dir.display()));
    }

    lines.push("legacy directories were not deleted".into());
    Ok(ActionResult::new(
        true,
        "migrate_codex_legacy_skills",
        lines.join("\n"),
        String::new(),
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
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-codex-legacy-{label}-{nonce}"));
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
    fn migratable_legacy_skill_copies_to_agents_path() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-migrate");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("CODEX_SKILLS_PATH");
            std::env::remove_var("CODEX_HOME");
        }

        write_skill(&codex_legacy_skills_dest(&home), "diagnose", "name: diagnose\n");
        let result = migrate_legacy_skills(false).expect("migrate");
        assert!(result.success);
        assert!(codex_global_skills_dest(&home).join("diagnose/SKILL.md").is_file());
        assert!(codex_legacy_skills_dest(&home).join("diagnose/SKILL.md").is_file());
    }

    #[test]
    fn conflict_leaves_both_paths_untouched() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-conflict");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("CODEX_SKILLS_PATH");
            std::env::remove_var("CODEX_HOME");
        }

        write_skill(&codex_legacy_skills_dest(&home), "diagnose", "name: diagnose\nlegacy: true\n");
        write_skill(&codex_global_skills_dest(&home), "diagnose", "name: diagnose\n");

        let preview = preview_migration(&home).expect("preview");
        assert_eq!(preview.conflict_count, 1);
        let result = migrate_legacy_skills(false).expect("migrate");
        assert!(result.success);
        assert!(codex_legacy_skills_dest(&home).join("diagnose/SKILL.md").is_file());
        let target = fs::read_to_string(codex_global_skills_dest(&home).join("diagnose/SKILL.md"))
            .expect("target");
        let legacy = fs::read_to_string(codex_legacy_skills_dest(&home).join("diagnose/SKILL.md"))
            .expect("legacy");
        assert!(legacy.contains("legacy: true"));
        assert!(!target.contains("legacy: true"));
    }
}
