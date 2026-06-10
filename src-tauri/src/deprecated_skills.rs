use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_skill_targets::{
    agent_global_skills_dest, validate_skill_agent, validate_skill_dest_root, validate_skill_name,
};
use crate::commands::backups::backup_root;
use crate::commands::{file_eq, ActionResult};

const MANIFEST_REL: &str = "metadata/deprecated-skills.json";
const REFERENCE_ROOT_REL: &str = "metadata/deprecated-skills";
const SCHEMA_VERSION: u32 = 1;

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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TransactionManifest {
    schema_version: u32,
    harness: String,
    destination_root: String,
    created_at: String,
    skills: Vec<TransactionSkill>,
    operation: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct TransactionSkill {
    name: String,
    original_state: String,
    relative_backup_dir: String,
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

#[allow(dead_code)]
fn path_under_root(child: &Path, root: &Path) -> bool {
    match (child.canonicalize(), root.canonicalize()) {
        (Ok(c), Ok(r)) => c == r || c.starts_with(&r),
        _ => false,
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

    let deprecated_names: HashSet<String> =
        load_deprecated_names(workspace_root)?.into_iter().collect();
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
    Ok(root
        .join("deprecated-skills")
        .join(format!("{agent}-{nonce}")))
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

fn validate_backup_path(backup_dir: &Path) -> Result<(), String> {
    reject_symlink_path(backup_dir, "rollback backup")?;
    if !backup_dir.is_dir() {
        return Err(format!(
            "rollback backup not found: {}",
            backup_dir.display()
        ));
    }

    let parent = backup_dir
        .parent()
        .ok_or_else(|| "rollback backup has no parent".to_string())?;
    if parent.file_name().and_then(|name| name.to_str()) != Some("deprecated-skills") {
        return Err(format!(
            "refusing rollback outside deprecated-skills backups: {}",
            backup_dir.display()
        ));
    }

    let canonical_backup = backup_dir
        .canonicalize()
        .map_err(|e| format!("cannot resolve backup path: {e}"))?;

    let backup_root_val = backup_root()?;
    let canonical_backup_root = backup_root_val
        .canonicalize()
        .map_err(|e| format!("cannot resolve backup root: {e}"))?;

    if !canonical_backup.starts_with(&canonical_backup_root) {
        return Err(format!(
            "backup path {} is outside the canonical backup root",
            backup_dir.display()
        ));
    }

    Ok(())
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

    let removable: Vec<&DeprecatedRemovalPreviewItem> = preview
        .items
        .iter()
        .filter(|item| item.action == "remove after backup")
        .collect();

    // ── Preflight: all destinations within dest_root ──
    validate_skill_dest_root(dest_root)?;
    reject_symlink_path(dest_root, "skill destination root")?;
    for item in &removable {
        let skill_dir = PathBuf::from(&item.target_path);
        path_within_root(&skill_dir, dest_root)?;
    }

    // ── Preflight: backup path is valid ──
    let backup_dir = create_backup_dir(agent)?;

    // ── Phase 1: Back up ALL removable skills before any deletion ──
    let mut backed_up: Vec<String> = Vec::new();
    for item in &removable {
        let backup_target = backup_dir.join(&item.name);
        let skill_dir = PathBuf::from(&item.target_path);
        match copy_dir_all(&skill_dir, &backup_target) {
            Ok(()) => {
                backed_up.push(item.name.clone());
                lines.push(format!(
                    "backed up {} to {}",
                    item.name,
                    backup_target.display()
                ));
            }
            Err(err) => {
                // Backup failed. We have a partial backup directory.
                // We should NOT remove the backup dir — it contains partial data.
                // Return the error; nothing was deleted yet.
                return Err(format!(
                    "backup failed for {} after backing up [{}]: {err}; no skills were removed. Partial backup at {}",
                    item.name,
                    backed_up.join(", "),
                    backup_dir.display()
                ));
            }
        }
    }

    // ── Verify all backups exist ──
    for item in &removable {
        let backup_target = backup_dir.join(&item.name);
        if !backup_target.is_dir() {
            return Err(format!(
                "backup verification failed for {}: backup dir missing after copy; no skills were removed. Backup at {}",
                item.name,
                backup_dir.display()
            ));
        }
    }

    // ── Write transaction manifest ──
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let manifest = TransactionManifest {
        schema_version: SCHEMA_VERSION,
        harness: agent.to_string(),
        destination_root: dest_root.to_string_lossy().into_owned(),
        created_at: now.to_string(),
        operation: "deprecated-removal".to_string(),
        skills: removable
            .iter()
            .map(|item| TransactionSkill {
                name: item.name.clone(),
                original_state: item.state.clone(),
                relative_backup_dir: item.name.clone(),
            })
            .collect(),
    };
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("cannot serialize manifest: {e}"))?;
    let manifest_path = backup_dir.join("manifest.json");
    fs::write(&manifest_path, &manifest_json)
        .map_err(|e| format!("cannot write manifest {}: {e}", manifest_path.display()))?;

    // ── Phase 2: Remove all skills (stop on first failure, auto-restore) ──
    let mut removed: Vec<String> = Vec::new();
    for item in &removable {
        let skill_dir = PathBuf::from(&item.target_path);
        match remove_dir_all(&skill_dir) {
            Ok(()) => {
                removed.push(item.name.clone());
                lines.push(format!(
                    "removed {} (backup: {}/{})",
                    item.name,
                    backup_dir.display(),
                    item.name
                ));
            }
            Err(err) => {
                // Removal failed after some removals. Auto-restore.
                let restore_outcome =
                    attempt_auto_restore(&backup_dir, dest_root, &removed, &removable);
                let restore_msg = match restore_outcome {
                    Ok(()) => "auto-restore completed".to_string(),
                    Err(e) => format!("auto-restore error: {e}"),
                };
                lines.push(format!(
                    "removal failed for {}: {err}; {restore_msg}",
                    item.name
                ));
                return Err(format!(
                    "removal failed for {} after removing [{}]: {err}; {restore_msg}",
                    item.name,
                    removed.join(", "),
                ));
            }
        }
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

const MAX_SYMLINK_CHECK_DEPTH: usize = 32;

/// Recursively reject symlinks at any depth within a directory tree.
///
/// Does not follow symlinks. Bounded by MAX_SYMLINK_CHECK_DEPTH to prevent
/// stack overflow on deeply nested structures.
fn reject_nested_symlinks(dir: &Path, label: &str) -> Result<(), String> {
    fn recurse(dir: &Path, label: &str, depth: usize) -> Result<(), String> {
        if depth > MAX_SYMLINK_CHECK_DEPTH {
            return Err(format!(
                "max symlink check depth exceeded in {}: {}",
                label,
                dir.display()
            ));
        }
        if !dir.is_dir() {
            return Ok(());
        }
        let meta = fs::symlink_metadata(dir)
            .map_err(|e| format!("cannot inspect {}: {e}", dir.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "refusing symlink in {}: {}",
                label,
                dir.display()
            ));
        }
        let entries = fs::read_dir(dir)
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("entry error in {}: {e}", dir.display()))?;
            let path = entry.path();
            let ft = entry.file_type()
                .map_err(|e| format!("file type error: {e}"))?;
            if ft.is_symlink() {
                return Err(format!(
                    "nested symlink in {}: {}",
                    label,
                    path.display()
                ));
            }
            if ft.is_dir() {
                recurse(&path, label, depth + 1)?;
            }
        }
        Ok(())
    }
    recurse(dir, label, 0)
}

/// Attempt to restore already-removed skills from backup after a partial removal failure.
fn attempt_auto_restore(
    backup_dir: &Path,
    dest_root: &Path,
    already_removed: &[String],
    _all_removable: &[&DeprecatedRemovalPreviewItem],
) -> Result<(), String> {
    let mut restore_errors: Vec<String> = Vec::new();
    for name in already_removed {
        let backup_src = backup_dir.join(name);
        let dest = dest_root.join(name);
        if !backup_src.is_dir() {
            restore_errors.push(format!("backup missing for {name}"));
            continue;
        }
        if dest.exists() {
            restore_errors.push(format!("cannot restore {name}: destination already exists"));
            continue;
        }
        if let Err(e) = copy_dir_all(&backup_src, &dest) {
            restore_errors.push(format!("failed to restore {name}: {e}"));
        }
    }
    if restore_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "auto-restore completed with errors: {}",
            restore_errors.join("; ")
        ))
    }
}

pub fn rollback_removal(backup_path: &str) -> Result<ActionResult, String> {
    let backup_dir = PathBuf::from(backup_path);
    validate_backup_path(&backup_dir)?;

    // Read and validate manifest
    let manifest_path = backup_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!(
            "transaction manifest not found in backup: {}",
            manifest_path.display()
        ));
    }
    let manifest_raw =
        fs::read_to_string(&manifest_path).map_err(|e| format!("cannot read manifest: {e}"))?;
    let manifest: TransactionManifest =
        serde_json::from_str(&manifest_raw).map_err(|e| format!("invalid manifest JSON: {e}"))?;

    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported manifest schema version {} (expected {})",
            manifest.schema_version, SCHEMA_VERSION
        ));
    }

    if manifest.operation != "deprecated-removal" {
        return Err(format!(
            "unexpected manifest operation: {}",
            manifest.operation
        ));
    }

    // ── Validate harness against known agent allowlist ──
    validate_skill_agent(&manifest.harness)?;

    // ── Validate each manifest skill entry ──
    let mut seen_names = std::collections::HashSet::new();
    for skill in &manifest.skills {
        // Validate skill name
        validate_skill_name(&skill.name, "rollback manifest")?;
        if !seen_names.insert(&skill.name) {
            return Err(format!("duplicate skill name in manifest: {}", skill.name));
        }

        // Validate original_state
        match skill.original_state.as_str() {
            "deprecated-identical" | "deprecated-diverged" => {}
            other => {
                return Err(format!(
                    "invalid original_state for skill '{}': {}",
                    skill.name, other
                ));
            }
        }

        // Validate relative_backup_dir: must be a single path component
        if skill.relative_backup_dir.is_empty() {
            return Err(format!(
                "empty relative_backup_dir for skill '{}'",
                skill.name
            ));
        }
        if skill.relative_backup_dir.contains('/')
            || skill.relative_backup_dir.contains('\\')
            || skill.relative_backup_dir == "."
            || skill.relative_backup_dir == ".."
        {
            return Err(format!(
                "invalid relative_backup_dir for skill '{}': {}",
                skill.name, skill.relative_backup_dir
            ));
        }

        // Verify the backup source actually exists and reject symlinks
        let backup_src = backup_dir.join(&skill.relative_backup_dir);
        if !backup_src.is_dir() {
            return Err(format!(
                "rollback backup source missing for skill '{}': {}",
                skill.name,
                backup_src.display()
            ));
        }
        reject_symlink_path(&backup_src, "rollback source")?;

        // Reject nested symlinks at any depth inside backup skill directories
        reject_nested_symlinks(&backup_src, &skill.name)?;
    }

    // ── Resolve current harness destination (do NOT trust manifest path) ──
    let dest_root = agent_global_skills_dest(&manifest.harness)?;
    validate_skill_dest_root(&dest_root)?;
    reject_symlink_path(&dest_root, "rollback destination root")?;

    // ── Canonicalize resolved destination where it exists ──
    let canonical_dest = if dest_root.exists() {
        dest_root
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize destination: {e}"))?
    } else {
        dest_root.clone()
    };

    // ── Compare resolved destination with manifest (detect tampering or harness change) ──
    let manifest_dest = PathBuf::from(&manifest.destination_root);
    let canonical_manifest = if manifest_dest.exists() {
        manifest_dest
            .canonicalize()
            .unwrap_or_else(|_| manifest_dest.clone())
    } else {
        manifest_dest
    };
    if canonical_dest != canonical_manifest {
        return Err(format!(
            "destination mismatch: current harness '{}' resolves to '{}' but manifest records '{:?}'. Refusing rollback.",
            manifest.harness,
            canonical_dest.display(),
            canonical_manifest.as_os_str()
        ));
    }

    // ── Preflight: ensure no destination currently has an existing skill dir ──
    for skill in &manifest.skills {
        let dest = canonical_dest.join(&skill.name);
        if dest.exists() {
            return Err(format!(
                "rollback blocked: destination already exists for skill '{}' at {}. Remove it manually or choose a different restore target.",
                skill.name,
                dest.display()
            ));
        }
    }

    // ── Phase 1: Stage all restores in a same-filesystem staging area ──
    let staging_base = canonical_dest
        .parent()
        .ok_or_else(|| "cannot determine staging parent".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let staging_dir = staging_base.join(format!(".aw-rollback-staging-{nonce}"));

    let mut staged: Vec<String> = Vec::new();

    let result = (|| -> Result<Vec<String>, String> {
        for skill in &manifest.skills {
            let backup_src = backup_dir.join(&skill.relative_backup_dir);
            let stage_target = staging_dir.join(&skill.name);
            copy_dir_all(&backup_src, &stage_target)?;
            staged.push(skill.name.clone());
        }
        Ok(staged.clone())
    })();

    match result {
        Ok(staged_skills) => {
            // ── Phase 2: Verify staged content ──
            for name in &staged_skills {
                let stage_target = staging_dir.join(name);
                if !stage_target.join("SKILL.md").is_file() {
                    // Clean up staging on verification failure
                    let _ = fs::remove_dir_all(&staging_dir);
                    return Err(format!(
                        "staged restore for '{}' missing SKILL.md; rollback aborted",
                        name
                    ));
                }
            }

            // ── Phase 3: Move staged dirs to final destinations ──
            let mut moved: Vec<String> = Vec::new();
            let move_result = (|| -> Result<(), String> {
                for name in &staged_skills {
                    let stage_path = staging_dir.join(name);
                    let dest = canonical_dest.join(name);
                    if let Err(e) = rename_path(&stage_path, &dest) {
                        // Attempt to return already-moved items back to staging
                        for moved_name in &moved {
                            let moved_dest = canonical_dest.join(moved_name);
                            let back_to_stage = staging_dir.join(moved_name);
                            let _ = rename_path(&moved_dest, &back_to_stage);
                        }
                        return Err(format!("failed to move '{}' to destination: {e}", name));
                    }
                    moved.push(name.clone());
                }
                Ok(())
            })();

            match move_result {
                Ok(()) => {
                    // Clean up staging
                    let _ = fs::remove_dir_all(&staging_dir);
                    Ok(ActionResult::new(
                        true,
                        "rollback_deprecated_skills_removal",
                        format!(
                            "Successfully restored {} skill(s) from backup: {}",
                            moved.len(),
                            moved.join(", ")
                        ),
                        String::new(),
                        Some(0),
                    ))
                }
                Err(e) => {
                    // Some moves may have succeeded, some may have been returned to staging
                    let _ = fs::remove_dir_all(&staging_dir);
                    Err(format!(
                        "Rollback move failed after staging: {e}. Moved: [{}]. Check destination and staging area.",
                        moved.join(", ")
                    ))
                }
            }
        }
        Err(e) => {
            // Clean up staging if anything was staged
            let _ = fs::remove_dir_all(&staging_dir);
            Err(format!("Rollback staging failed: {e}"))
        }
    }
}

fn rename_path(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))
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
        let dest = home.join(".agents/skills");
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
        let dest = home.join(".agents/skills");
        write_file(
            &dest.join("caveman/SKILL.md"),
            "name: caveman\ncustom: true\n",
        );

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
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, true)
            .expect("dry run");
        assert!(result.success);
        assert!(dest.join("caveman").exists());
        assert!(
            home.join("backups/deprecated-skills").read_dir().is_err()
                || home
                    .join("backups/deprecated-skills")
                    .read_dir()
                    .unwrap()
                    .count()
                    == 0
        );
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

    #[test]
    fn preview_creates_no_backup() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-preview");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-preview");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        let preview = preview_removal("codex", &workspace, &dest, &current).expect("preview");
        assert_eq!(preview.removable_count, 1);
        // Verify no backup was created by preview
        assert!(
            home.join("backups/deprecated-skills").read_dir().is_err()
                || home
                    .join("backups/deprecated-skills")
                    .read_dir()
                    .unwrap()
                    .count()
                    == 0
        );
        // Skill still exists
        assert!(dest.join("caveman").exists());
    }

    #[test]
    fn successful_removal_creates_transaction_manifest() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-manifest");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-manifest");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");

        // Find backup dir and verify manifest
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let manifest_path = backup_dir_entry.path().join("manifest.json");
        assert!(
            manifest_path.is_file(),
            "manifest.json must exist after successful removal"
        );
        let manifest_raw = fs::read_to_string(&manifest_path).expect("read manifest");
        let manifest: TransactionManifest =
            serde_json::from_str(&manifest_raw).expect("parse manifest");
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.harness, "codex");
        assert_eq!(manifest.operation, "deprecated-removal");
        assert_eq!(manifest.skills.len(), 1);
        assert_eq!(manifest.skills[0].name, "caveman");
    }

    #[test]
    fn successful_rollback_restores_all_removed_skills() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-rollback");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-rollback");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");
        assert!(!dest.join("caveman").exists(), "skill should be removed");

        // Find backup dir
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_path = backup_dir_entry.path().to_string_lossy().to_string();

        let result = rollback_removal(&backup_path).expect("rollback");
        assert!(result.success, "rollback should succeed: {}", result.stderr);
        assert!(
            dest.join("caveman").exists(),
            "skill should be restored after rollback"
        );
    }

    #[test]
    fn rollback_rejects_arbitrary_backup_path() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-reject-arb");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        // Create a directory that is NOT under deprecated-skills parent
        let backup_like = home.join("not-deprecated").join("fake-backup");
        fs::create_dir_all(&backup_like).expect("create backup-like dir");
        write_file(&backup_like.join("manifest.json"), r#"{}"#);
        let result = rollback_removal(&backup_like.to_string_lossy());
        assert!(result.is_err(), "rollback must reject arbitrary path");
        let err = result.unwrap_err();
        assert!(
            err.contains("outside deprecated-skills backups"),
            "error should mention backup parent check: got: {err}"
        );
    }

    #[test]
    fn rollback_rejects_backup_outside_canonical_root() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-outside");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        // Create a backup-like directory NOT under the backup root
        let fake_backup = temp_root("fake-backup");
        let fake_dir = fake_backup.join("deprecated-skills").join("fake-123");
        fs::create_dir_all(&fake_dir).expect("create fake");
        let result = rollback_removal(&fake_dir.to_string_lossy());
        assert!(result.is_err(), "must reject backup outside canonical root");
    }

    #[test]
    fn rollback_rejects_occupied_destination() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-occupied");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-occupied");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        fs::create_dir_all(&dest).expect("create dest");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");
        assert!(!dest.join("caveman").exists());

        // Re-create the destination (simulating external interference)
        write_file(
            &dest.join("caveman/SKILL.md"),
            "name: caveman\ninterfered: true\n",
        );

        // Find backup dir
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_path = backup_dir_entry.path().to_string_lossy().to_string();

        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "rollback must reject occupied destination");
        let err = result.unwrap_err();
        assert!(
            err.contains("destination already exists"),
            "error should mention existing destination"
        );
    }

    #[test]
    fn all_backups_complete_before_first_removal() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-all-backups");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        // Set up two deprecated skills
        let workspace = temp_root("ws-all-backups");
        write_file(
            &workspace.join("metadata/deprecated-skills.json"),
            r#"{"version":1,"skills":["caveman","diagnose"]}"#,
        );
        write_file(
            &workspace.join("metadata/deprecated-skills/caveman/SKILL.md"),
            "name: caveman\n",
        );
        write_file(
            &workspace.join("metadata/deprecated-skills/diagnose/SKILL.md"),
            "name: diagnose\n",
        );

        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");
        write_file(&dest.join("diagnose/SKILL.md"), "name: diagnose\n");

        let current = HashSet::new();
        // Remove both skills
        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, false)
            .expect("remove");
        assert!(result.success);
        // Both should be removed
        assert!(!dest.join("caveman").exists());
        assert!(!dest.join("diagnose").exists());

        // Verify backup has both
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        assert!(backup_dir_entry.path().join("caveman/SKILL.md").is_file());
        assert!(backup_dir_entry.path().join("diagnose/SKILL.md").is_file());
        assert!(backup_dir_entry.path().join("manifest.json").is_file());
    }

    #[test]
    fn rollback_leaves_diverged_skills_untouched() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-diverged-rollback");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-diverged-rollback");
        // Two dl skills: caveman (identical, removable) and diagnose (deprecated + diverged)
        write_file(
            &workspace.join("metadata/deprecated-skills.json"),
            r#"{"version":1,"skills":["caveman","diagnose"]}"#,
        );
        write_file(
            &workspace.join("metadata/deprecated-skills/caveman/SKILL.md"),
            "name: caveman\n",
        );
        write_file(
            &workspace.join("metadata/deprecated-skills/diagnose/SKILL.md"),
            "name: diagnose\n",
        );

        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");
        // diverged: has extra content
        write_file(
            &dest.join("diagnose/SKILL.md"),
            "name: diagnose\ncustom: true\n",
        );

        let current = HashSet::new();
        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, false)
            .expect("remove");
        assert!(result.success);
        assert!(!dest.join("caveman").exists(), "identical skill removed");
        assert!(dest.join("diagnose").exists(), "diverged skill preserved");

        // Find backup dir
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_path = backup_dir_entry.path().to_string_lossy().to_string();

        let result = rollback_removal(&backup_path).expect("rollback");
        assert!(result.success);
        assert!(dest.join("caveman").exists(), "removed skill restored");
        assert!(
            dest.join("diagnose").exists(),
            "diverged skill still present"
        );
    }

    // ── Symlink rejection tests ──

    #[test]
    fn rollback_rejects_nested_symlink_to_external_dir() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-nested-sym-dir");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-nested-sym-dir");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");

        // Find backup dir and add a nested symlink to external dir
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_dir = backup_dir_entry.path();

        // Create a symlink inside the backup skill dir pointing to an external dir
        let external = temp_root("external-dir");
        fs::create_dir_all(&external).expect("create external");
        let symlink_target = backup_dir.join("caveman").join("external_link");
        std::os::unix::fs::symlink(&external, &symlink_target)
            .expect("create symlink");

        let backup_path = backup_dir.to_string_lossy().to_string();
        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "must reject nested symlink to external dir");
        let err = result.unwrap_err();
        assert!(err.contains("nested symlink"), "error should mention nested symlink: {err}");
    }

    #[test]
    fn rollback_rejects_nested_symlink_to_external_file() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-nested-sym-file");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-nested-sym-file");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");

        // Find backup dir and add a nested symlink to external file
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_dir = backup_dir_entry.path();

        // Create symlink to external file inside backup
        let external_file = temp_root("external-file").join("secret.txt");
        write_file(&external_file, "secret content");
        let symlink_target = backup_dir.join("caveman").join("secret_link.txt");
        std::os::unix::fs::symlink(&external_file, &symlink_target)
            .expect("create symlink to file");

        let backup_path = backup_dir.to_string_lossy().to_string();
        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "must reject nested symlink to external file");
        let err = result.unwrap_err();
        assert!(err.contains("nested symlink"), "error should mention nested symlink: {err}");
    }

    #[test]
    fn rollback_rejects_symlink_chain() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-sym-chain");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-sym-chain");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");

        // Create a chain: backup/caveman/middle -> backup/other -> external
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_dir = backup_dir_entry.path();

        let external = temp_root("chain-external");
        fs::create_dir_all(&external).expect("create external");
        write_file(&external.join("payload.txt"), "chain payload");

        // chain: backup/stepping_stone -> external
        let stepping_stone = backup_dir.join("stepping_stone");
        std::os::unix::fs::symlink(&external, &stepping_stone)
            .expect("create stepping stone symlink");

        // chain: backup/caveman/chain_link -> stepping_stone
        let chain_link = backup_dir.join("caveman").join("chain_link");
        std::os::unix::fs::symlink(&stepping_stone, &chain_link)
            .expect("create chain symlink");

        let backup_path = backup_dir.to_string_lossy().to_string();
        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "must reject symlink chain");
        let err = result.unwrap_err();
        assert!(err.contains("nested symlink"), "error should mention nested symlink: {err}");
    }

    #[test]
    fn rollback_rejects_destination_mismatch() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-dest-mismatch");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-dest-mismatch");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");

        // Find backup dir and tamper with manifest destination_root
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_dir = backup_dir_entry.path();
        let manifest_path = backup_dir.join("manifest.json");
        let mut manifest: TransactionManifest =
            serde_json::from_str(&fs::read_to_string(&manifest_path).expect("read manifest"))
                .expect("parse manifest");
        manifest.destination_root = "/tmp/fake-destination".to_string();
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).expect("serialize"))
            .expect("write tampered manifest");

        let backup_path = backup_dir.to_string_lossy().to_string();
        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "must reject destination mismatch");
        let err = result.unwrap_err();
        assert!(err.contains("destination mismatch"), "error should mention destination mismatch: {err}");
    }

    #[test]
    fn rollback_failure_before_first_mutation_has_no_staging() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-no-mutation");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-no-mutation");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        remove_identical_deprecated("codex", &workspace, &dest, &current, false).expect("remove");

        // Find backup dir and corrupt the manifest to cause early failure
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_dir = backup_dir_entry.path();
        let manifest_path = backup_dir.join("manifest.json");
        fs::write(&manifest_path, "invalid json").expect("corrupt manifest");

        let backup_path = backup_dir.to_string_lossy().to_string();
        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "must fail on corrupt manifest");
        // Verify no staging dir was created — no filesystem state was harmed
        let has_staging = fs::read_dir(dest.parent().unwrap())
            .map(|entries| {
                entries.filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().starts_with(".aw-rollback-staging-"))
            })
            .unwrap_or(false);
        assert!(!has_staging, "no staging dir should remain after early failure");
    }

    #[test]
    fn multi_skill_removal_and_rollback() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-multi-skill");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-multi-skill");
        write_file(
            &workspace.join("metadata/deprecated-skills.json"),
            r#"{"version":1,"skills":["caveman","diagnose","prototype"]}"#,
        );
        for skill in &["caveman", "diagnose", "prototype"] {
            write_file(
                &workspace.join(format!("metadata/deprecated-skills/{skill}/SKILL.md")),
                &format!("name: {skill}\n"),
            );
        }

        let dest = home.join(".agents/skills");
        for skill in &["caveman", "diagnose", "prototype"] {
            write_file(
                &dest.join(format!("{skill}/SKILL.md")),
                &format!("name: {skill}\n"),
            );
        }

        // Remove all three — use "codex" agent so dest matches codex_global_skills_dest
        let current = HashSet::new();
        let result = remove_identical_deprecated("codex", &workspace, &dest, &current, false)
            .expect("remove");
        assert!(result.success);
        for skill in &["caveman", "diagnose", "prototype"] {
            assert!(!dest.join(skill).exists(), "{skill} should be removed");
        }

        // Find backup dir and rollback
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("codex-"))
            .expect("backup dir");
        let backup_path = backup_dir_entry.path().to_string_lossy().to_string();

        let result = rollback_removal(&backup_path).expect("rollback");
        assert!(result.success);
        for skill in &["caveman", "diagnose", "prototype"] {
            assert!(dest.join(skill).exists(), "{skill} should be restored");
            assert!(
                dest.join(format!("{skill}/SKILL.md")).is_file(),
                "{skill}/SKILL.md should exist"
            );
        }
    }

    #[test]
    fn reject_nested_symlinks_deeply_nested() {
        let root = temp_root("deep-nested-symlinks");
        fs::create_dir_all(&root).expect("create root");
        let deep = root.join("a").join("b").join("c").join("d");
        fs::create_dir_all(&deep).expect("create deep dir");

        // No symlinks — should pass
        assert!(reject_nested_symlinks(&root, "test").is_ok());

        // Add a symlink at depth 4
        let external = temp_root("deep-external");
        fs::create_dir_all(&external).expect("create external");
        let sym_at_depth = deep.join("evil_link");
        std::os::unix::fs::symlink(&external, &sym_at_depth)
            .expect("create deep symlink");

        let result = reject_nested_symlinks(&root, "test");
        assert!(result.is_err(), "must reject deeply nested symlink");
        let err = result.unwrap_err();
        assert!(err.contains("nested symlink"), "error mentions nested symlink: {err}");
    }

    #[test]
    fn rollback_rejects_agent_not_in_skill_allowlist() {
        let _guard = guard::lock();
        let _local = ENV_TEST_LOCK.lock().expect("lock");
        let home = temp_root("home-invalid-agent-rollback");
        let _restore = guard::EnvRestore::capture();
        set_test_user_dirs(&home);
        unsafe {
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                home.join("backups").to_string_lossy().as_ref(),
            );
        }

        let workspace = temp_root("ws-invalid-agent-rollback");
        setup_workspace_with_deprecated_refs(&workspace);
        let dest = home.join(".agents/skills");
        write_file(&dest.join("caveman/SKILL.md"), "name: caveman\n");

        let current = HashSet::new();
        // remove allows any agent name (used as label); rollback validates
        let result = remove_identical_deprecated("nonexistent", &workspace, &dest, &current, false)
            .expect("remove should work with any agent label");
        assert!(result.success);
        assert!(!dest.join("caveman").exists());

        // Find backup dir
        let backup_dir_entry = fs::read_dir(home.join("backups/deprecated-skills"))
            .expect("read backups")
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("nonexistent-"))
            .expect("backup dir");
        let backup_path = backup_dir_entry.path().to_string_lossy().to_string();

        // Rollback must reject invalid agent in manifest
        let result = rollback_removal(&backup_path);
        assert!(result.is_err(), "rollback must reject invalid agent");
        let err = result.unwrap_err();
        assert!(err.contains("invalid agent"), "error mentions invalid agent: {err}");
    }
}
