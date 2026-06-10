//! Artifact-owned setup transaction engine.
//!
//! Expands surfaces to concrete artifacts, runs preflight/backup/manifest/apply/
//! validation/rollback at artifact granularity. Surface owners execute writes;
//! this module owns transaction evidence and per-artifact state.

use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::{ArtifactId, ArtifactKind};
use crate::commands::file_eq;
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};

pub const ARTIFACT_MANIFEST_SCHEMA_VERSION: u32 = 2;
const MAX_MANIFEST_OPERATIONS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviousState {
    Absent,
    ManagedFile,
    ManagedDirectory,
    MergeableConfigFile,
    Conflict,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackAction {
    RestoreFile,
    RestoreDirectoryArtifact,
    RestoreManagedConfigFile,
    RemoveCreatedFile,
    RemoveCreatedSkillDirectory,
    NoAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApplyStatus {
    #[default]
    Pending,
    Applied,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ValidationStatus {
    #[default]
    Pending,
    Passed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RollbackStatus {
    #[default]
    Pending,
    Restored,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactManifestOperation {
    pub artifact: ArtifactId,
    pub surface: SetupSurfaceId,
    pub kind: OperationKind,
    pub previous_state: PreviousState,
    pub rollback_action: RollbackAction,
    pub backup_rel: Option<String>,
    #[serde(default)]
    pub apply_status: ApplyStatus,
    #[serde(default)]
    pub validation_status: ValidationStatus,
    #[serde(default)]
    pub rollback_status: RollbackStatus,
}

impl Default for ArtifactManifestOperation {
    fn default() -> Self {
        Self {
            artifact: ArtifactId::OpenCodeRules,
            surface: SetupSurfaceId::OpenCodeRules,
            kind: OperationKind::NoChange,
            previous_state: PreviousState::Absent,
            rollback_action: RollbackAction::NoAction,
            backup_rel: None,
            apply_status: ApplyStatus::Pending,
            validation_status: ValidationStatus::Pending,
            rollback_status: RollbackStatus::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactTransactionManifest {
    pub schema_version: u32,
    pub workspace_key: String,
    pub created_at: String,
    pub surface_ids: Vec<SetupSurfaceId>,
    pub operations: Vec<ArtifactManifestOperation>,
}

#[derive(Debug, Clone)]
pub struct PlannedArtifact {
    pub artifact: ArtifactId,
    pub surface: SetupSurfaceId,
    pub kind: OperationKind,
    pub previous_state: PreviousState,
    pub rollback_action: RollbackAction,
}

static CONSUMED_FINGERPRINTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn consumed_fingerprints() -> &'static Mutex<HashSet<String>> {
    CONSUMED_FINGERPRINTS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_fingerprint_consumed(fingerprint: &str) {
    if let Ok(mut set) = consumed_fingerprints().lock() {
        set.insert(fingerprint.to_string());
    }
}

pub fn is_fingerprint_consumed(fingerprint: &str) -> bool {
    consumed_fingerprints()
        .lock()
        .map(|set| set.contains(fingerprint))
        .unwrap_or(false)
}

#[cfg(test)]
pub fn clear_consumed_fingerprints_for_test() {
    if let Ok(mut set) = consumed_fingerprints().lock() {
        set.clear();
    }
}

pub fn new_transaction_id() -> Result<String, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| Ok(d.as_nanos().to_string()))
        .map_err(|e| format!("cannot generate transaction id: {e}"))?
}

pub fn workspace_key(workspace_root: &Path) -> Result<String, String> {
    let canonical = workspace_root
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize workspace: {e}"))?;
    Ok(canonical.to_string_lossy().into_owned())
}

pub fn expand_surfaces_to_artifacts(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
) -> Result<Vec<ArtifactId>, String> {
    let mut artifacts: Vec<ArtifactId> = Vec::new();
    let mut seen = HashSet::new();
    for surface in surfaces {
        if matches!(surface, SetupSurfaceId::DeprecatedSkillCleanup) {
            continue;
        }
        let expanded = expand_surface_fail_closed(*surface, workspace_root)?;
        if expanded.is_empty() {
            return Err(format!(
                "surface {} expanded to zero artifacts",
                surface.label()
            ));
        }
        for artifact in expanded {
            if !seen.insert(artifact.clone()) {
                return Err(format!("duplicate artifact {:?} across surfaces", artifact));
            }
            crate::artifact_registry::reject_broad_artifact_root(
                &artifact.resolve_dest(&user_home()?)?,
            )?;
            artifacts.push(artifact);
        }
    }
    Ok(artifacts)
}

pub fn expand_surface_fail_closed(
    surface: SetupSurfaceId,
    workspace_root: &Path,
) -> Result<Vec<ArtifactId>, String> {
    if matches!(surface, SetupSurfaceId::DeprecatedSkillCleanup) {
        return Ok(vec![]);
    }
    crate::artifact_registry::expand_surface(surface, workspace_root)
}

fn user_home() -> Result<PathBuf, String> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

pub fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
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

fn digest_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn digest_managed_config_json(installed: &Path, source: &Path) -> Result<String, String> {
    let installed_str =
        fs::read_to_string(installed).map_err(|e| format!("read installed config: {e}"))?;
    let source_str = fs::read_to_string(source).map_err(|e| format!("read source config: {e}"))?;
    let installed_json: serde_json::Value =
        serde_json::from_str(&installed_str).map_err(|e| format!("parse installed json: {e}"))?;
    let source_json: serde_json::Value =
        serde_json::from_str(&source_str).map_err(|e| format!("parse source json: {e}"))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!(
        "{:?}",
        crate::commands::extract_managed_opencode_config(&installed_json)
    )
    .hash(&mut hasher);
    format!(
        "{:?}",
        crate::commands::extract_managed_opencode_config(&source_json)
    )
    .hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn digest_managed_config_toml(installed: &Path, source: &Path) -> Result<String, String> {
    let installed_str =
        fs::read_to_string(installed).map_err(|e| format!("read installed config: {e}"))?;
    let source_str = fs::read_to_string(source).map_err(|e| format!("read source config: {e}"))?;
    let installed_toml: toml::Value = installed_str
        .parse()
        .map_err(|e| format!("parse installed toml: {e}"))?;
    let source_toml: toml::Value = source_str
        .parse()
        .map_err(|e| format!("parse source toml: {e}"))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!(
        "{:?}",
        crate::commands::extract_managed_codex_config(&installed_toml)
    )
    .hash(&mut hasher);
    format!(
        "{:?}",
        crate::commands::extract_managed_codex_config(&source_toml)
    )
    .hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

pub fn artifact_managed_digest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    let dest = artifact.resolve_dest(home)?;
    let source = artifact
        .resolve_source(workspace_root)
        .ok_or_else(|| format!("no source for artifact {:?}", artifact))?;
    match artifact_kind(artifact) {
        ArtifactKind::ConfigFile | ArtifactKind::TuiConfig => {
            if artifact == &ArtifactId::CodexConfig {
                if dest.exists() && source.exists() {
                    digest_managed_config_toml(&dest, &source)
                } else {
                    Ok("absent".into())
                }
            } else if dest.exists() && source.exists() {
                digest_managed_config_json(&dest, &source)
            } else {
                Ok("absent".into())
            }
        }
        ArtifactKind::RulesFile | ArtifactKind::AgentFile | ArtifactKind::McpConfig => {
            if dest.exists() && source.exists() {
                digest_file(&dest)
            } else {
                Ok("absent".into())
            }
        }
        ArtifactKind::SkillDir => {
            let dest_md = dest.join("SKILL.md");
            let source_md = source.join("SKILL.md");
            if dest_md.is_file() && source_md.is_file() {
                digest_file(&source_md)
            } else {
                Ok("absent".into())
            }
        }
    }
}

fn artifact_kind(artifact: &ArtifactId) -> ArtifactKind {
    match artifact {
        ArtifactId::OpenCodeConfig | ArtifactId::CodexConfig => ArtifactKind::ConfigFile,
        ArtifactId::OpenCodeTui => ArtifactKind::TuiConfig,
        ArtifactId::OpenCodeRules | ArtifactId::CodexRules | ArtifactId::ClaudeRules => {
            ArtifactKind::RulesFile
        }
        ArtifactId::OpenCodeAgent(_)
        | ArtifactId::CodexAgent(_)
        | ArtifactId::ClaudeAgent(_)
        | ArtifactId::CursorAgent(_) => ArtifactKind::AgentFile,
        ArtifactId::OpenCodeSkill(_)
        | ArtifactId::CodexSkill(_)
        | ArtifactId::ClaudeSkill(_)
        | ArtifactId::CursorSkill(_) => ArtifactKind::SkillDir,
        ArtifactId::CursorMcp => ArtifactKind::McpConfig,
    }
}

pub fn compute_plan_fingerprint(
    workspace_root: &Path,
    surfaces: &[SetupSurfaceId],
    artifact_ops: &[PlannedArtifact],
    home: &Path,
) -> Result<String, String> {
    let ws_key = workspace_key(workspace_root)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    ws_key.hash(&mut hasher);
    let mut surface_ids: Vec<_> = surfaces.to_vec();
    surface_ids.sort_by_key(|s| format!("{s:?}"));
    for s in &surface_ids {
        format!("{s:?}").hash(&mut hasher);
    }
    let mut artifacts: Vec<_> = artifact_ops.iter().map(|a| a.artifact.clone()).collect();
    artifacts.sort_by_key(|a| format!("{a:?}"));
    for artifact in &artifacts {
        format!("{artifact:?}").hash(&mut hasher);
        let source_digest = artifact_managed_digest(artifact, workspace_root, home)?;
        source_digest.hash(&mut hasher);
        let installed_digest = if user_home().is_ok() {
            artifact_managed_digest(artifact, workspace_root, home).unwrap_or_else(|_| "err".into())
        } else {
            "no-home".into()
        };
        installed_digest.hash(&mut hasher);
        if let Some(op) = artifact_ops.iter().find(|o| o.artifact == *artifact) {
            format!("{:?}", op.kind).hash(&mut hasher);
        }
    }
    Ok(format!("{:016x}", hasher.finish()))
}

pub fn validate_fingerprint_format(fingerprint: &str) -> bool {
    !fingerprint.is_empty()
        && fingerprint.len() <= 64
        && fingerprint.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn detect_artifact_state(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> (OperationKind, PreviousState) {
    let dest = match artifact.resolve_dest(home) {
        Ok(p) => p,
        Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };
    let source = match artifact.resolve_source(workspace_root) {
        Some(p) => p,
        None => {
            if artifact == &ArtifactId::OpenCodeTui {
                return if dest.exists() {
                    (OperationKind::NoChange, PreviousState::MergeableConfigFile)
                } else {
                    (OperationKind::Create, PreviousState::Absent)
                };
            }
            return (OperationKind::Unavailable, PreviousState::Unavailable);
        }
    };

    if reject_symlink(&dest, "destination").is_err() {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    if reject_symlink(&source, "source").is_err() {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    }

    match artifact_kind(artifact) {
        ArtifactKind::ConfigFile => detect_config_artifact(artifact, &dest, &source),
        ArtifactKind::TuiConfig => {
            if !dest.exists() {
                (OperationKind::Create, PreviousState::Absent)
            } else {
                (OperationKind::NoChange, PreviousState::MergeableConfigFile)
            }
        }
        ArtifactKind::RulesFile | ArtifactKind::AgentFile => {
            if !dest.exists() {
                (OperationKind::Create, PreviousState::Absent)
            } else if !source.exists() {
                (OperationKind::Unavailable, PreviousState::Unavailable)
            } else if file_eq(&dest, &source) {
                (OperationKind::NoChange, PreviousState::ManagedFile)
            } else {
                (OperationKind::Update, PreviousState::ManagedFile)
            }
        }
        ArtifactKind::SkillDir => {
            let dest_md = dest.join("SKILL.md");
            let source_md = source.join("SKILL.md");
            if !dest_md.is_file() {
                (OperationKind::Create, PreviousState::Absent)
            } else if !source_md.is_file() {
                (OperationKind::Unavailable, PreviousState::Unavailable)
            } else if file_eq(&dest_md, &source_md) {
                (OperationKind::NoChange, PreviousState::ManagedDirectory)
            } else {
                (OperationKind::Update, PreviousState::ManagedDirectory)
            }
        }
        ArtifactKind::McpConfig => {
            let status = crate::cursor_profile_ops::mcp_diff_status(
                workspace_root,
                &match crate::cursor_profile_paths::resolve_cursor_profile_paths() {
                    Ok(p) => p,
                    Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
                },
            );
            match status.as_str() {
                "synced" => (OperationKind::NoChange, PreviousState::ManagedFile),
                "missing" => (OperationKind::Create, PreviousState::Absent),
                "diverged" => (OperationKind::Update, PreviousState::ManagedFile),
                _ => (OperationKind::Unavailable, PreviousState::Unavailable),
            }
        }
    }
}

fn detect_config_artifact(
    artifact: &ArtifactId,
    dest: &Path,
    source: &Path,
) -> (OperationKind, PreviousState) {
    if !dest.exists() {
        return (OperationKind::Create, PreviousState::Absent);
    }
    if !source.exists() {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    }
    if artifact == &ArtifactId::CodexConfig {
        let installed_str = match fs::read_to_string(dest) {
            Ok(s) => s,
            Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
        };
        let source_str = match fs::read_to_string(source) {
            Ok(s) => s,
            Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
        };
        let installed_toml: toml::Value = match installed_str.parse() {
            Ok(v) => v,
            Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
        };
        let source_toml: toml::Value = match source_str.parse() {
            Ok(v) => v,
            Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
        };
        if crate::commands::managed_codex_keys_match(&installed_toml, &source_toml) {
            (OperationKind::NoChange, PreviousState::MergeableConfigFile)
        } else {
            (OperationKind::Update, PreviousState::MergeableConfigFile)
        }
    } else {
        let installed_str = match fs::read_to_string(dest) {
            Ok(s) => s,
            Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
        };
        let source_str = match fs::read_to_string(source) {
            Ok(s) => s,
            Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
        };
        let installed_json: serde_json::Value = match serde_json::from_str(&installed_str) {
            Ok(v) => v,
            Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
        };
        let source_json: serde_json::Value = match serde_json::from_str(&source_str) {
            Ok(v) => v,
            Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
        };
        if crate::commands::managed_opencode_keys_match(&installed_json, &source_json) {
            (OperationKind::NoChange, PreviousState::MergeableConfigFile)
        } else {
            (OperationKind::Update, PreviousState::MergeableConfigFile)
        }
    }
}

pub fn plan_artifacts_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<PlannedArtifact>, String> {
    let artifacts = expand_surfaces_to_artifacts(surfaces, workspace_root)?;
    let mut planned = Vec::new();
    for artifact in artifacts {
        let surface = artifact.surface();
        let (kind, previous_state) = detect_artifact_state(&artifact, workspace_root, home);
        let rollback_action = rollback_action_for(kind, previous_state, &artifact);
        planned.push(PlannedArtifact {
            artifact,
            surface,
            kind,
            previous_state,
            rollback_action,
        });
    }
    Ok(planned)
}

fn rollback_action_for(
    kind: OperationKind,
    previous: PreviousState,
    artifact: &ArtifactId,
) -> RollbackAction {
    match (kind, previous) {
        (OperationKind::Create, PreviousState::Absent) => match artifact_kind(artifact) {
            ArtifactKind::SkillDir => RollbackAction::RemoveCreatedSkillDirectory,
            _ => RollbackAction::RemoveCreatedFile,
        },
        (OperationKind::Update, PreviousState::ManagedFile) => RollbackAction::RestoreFile,
        (OperationKind::Update, PreviousState::ManagedDirectory) => {
            RollbackAction::RestoreDirectoryArtifact
        }
        (OperationKind::Update, PreviousState::MergeableConfigFile) => {
            RollbackAction::RestoreManagedConfigFile
        }
        _ => RollbackAction::NoAction,
    }
}

pub fn artifact_backup_rel(artifact: &ArtifactId) -> String {
    let json = serde_json::to_string(artifact).unwrap_or_else(|_| "artifact".into());
    json.replace('/', "_").replace('"', "")
}

pub fn backup_artifact(
    artifact: &ArtifactId,
    backup_dir: &Path,
    home: &Path,
) -> Result<Option<String>, String> {
    let dest = artifact.resolve_dest(home)?;
    if !dest.exists() {
        return Ok(None);
    }
    reject_symlink(&dest, "backup destination")?;
    let rel = format!("artifacts/{}", artifact_backup_rel(artifact));
    let backup_path = backup_dir.join(&rel);
    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create backup parent: {e}"))?;
    }
    if dest.is_dir() {
        crate::deprecated_skills::copy_dir_all(&dest, &backup_path)
            .map_err(|e| format!("backup dir {}: {e}", dest.display()))?;
    } else {
        fs::copy(&dest, &backup_path)
            .map_err(|e| format!("backup file {}: {e}", dest.display()))?;
    }
    reject_symlink(&backup_path, "backup copy")?;
    Ok(Some(rel))
}

pub fn validate_manifest(
    manifest: &ArtifactTransactionManifest,
    workspace_root: &Path,
) -> Result<(), String> {
    if manifest.schema_version != ARTIFACT_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "unsupported manifest schema {}",
            manifest.schema_version
        ));
    }
    if manifest.operations.is_empty() || manifest.operations.len() > MAX_MANIFEST_OPERATIONS {
        return Err("invalid operation count".into());
    }
    let ws_key = workspace_key(workspace_root)?;
    if manifest.workspace_key != ws_key {
        return Err("manifest workspace mismatch".into());
    }
    let mut seen = HashSet::new();
    for op in &manifest.operations {
        if !seen.insert(op.artifact.clone()) {
            return Err("duplicate artifact id in manifest".into());
        }
        if op.artifact.surface() != op.surface {
            return Err("artifact surface mismatch".into());
        }
        if let Some(ref rel) = op.backup_rel {
            if rel.starts_with('/') || rel.contains("..") {
                return Err("unsafe backup path".into());
            }
        }
        if !matches!(op.kind, OperationKind::Create | OperationKind::Update) {
            return Err("invalid manifest operation kind".into());
        }
    }
    Ok(())
}

pub fn validate_artifact_after_apply(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let (kind, _) = detect_artifact_state(artifact, workspace_root, home);
    if kind == OperationKind::Update {
        return Err(format!(
            "validation failed: artifact {:?} still shows Update after apply",
            artifact
        ));
    }
    if matches!(kind, OperationKind::Conflict | OperationKind::Unavailable) {
        return Err(format!(
            "validation failed: artifact {:?} in state {:?}",
            artifact, kind
        ));
    }
    Ok(())
}

pub fn restore_artifact_from_backup(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
) -> Result<(), String> {
    let dest = op.artifact.resolve_dest(home)?;
    reject_symlink(&dest, "rollback destination")?;
    match op.rollback_action {
        RollbackAction::RestoreFile
        | RollbackAction::RestoreManagedConfigFile
        | RollbackAction::RestoreDirectoryArtifact => {
            let rel = op
                .backup_rel
                .as_ref()
                .ok_or_else(|| "missing backup for restore".to_string())?;
            let backup_path = backup_dir.join(rel);
            if !backup_path.exists() {
                return Err("backup missing".into());
            }
            reject_symlink(&backup_path, "backup")?;
            if dest.exists() {
                if dest.is_dir() {
                    fs::remove_dir_all(&dest).map_err(|e| format!("remove dest dir: {e}"))?;
                } else {
                    fs::remove_file(&dest).map_err(|e| format!("remove dest file: {e}"))?;
                }
            }
            if backup_path.is_dir() {
                crate::deprecated_skills::copy_dir_all(&backup_path, &dest)
                    .map_err(|e| format!("restore dir: {e}"))?;
            } else {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
                }
                fs::copy(&backup_path, &dest).map_err(|e| format!("restore file: {e}"))?;
            }
            Ok(())
        }
        RollbackAction::RemoveCreatedFile => {
            if dest.is_file() {
                fs::remove_file(&dest).map_err(|e| format!("remove created file: {e}"))?;
            }
            Ok(())
        }
        RollbackAction::RemoveCreatedSkillDirectory => {
            if dest.is_dir() {
                fs::remove_dir_all(&dest).map_err(|e| format!("remove created skill: {e}"))?;
            }
            Ok(())
        }
        RollbackAction::NoAction => Ok(()),
    }
}

pub fn surfaces_needing_apply(planned: &[PlannedArtifact]) -> Vec<SetupSurfaceId> {
    let mut surfaces: Vec<SetupSurfaceId> = planned
        .iter()
        .filter(|p| p.kind.needs_apply())
        .map(|p| p.surface)
        .collect();
    surfaces.sort_by_key(|s| format!("{s:?}"));
    surfaces.dedup();
    surfaces
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(label: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-txn-{label}-{n}"))
    }

    #[test]
    fn expand_bundled_opencode_skills_count() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let artifacts = expand_surface_fail_closed(SetupSurfaceId::OpenCodeSkills, &repo).unwrap();
        assert_eq!(artifacts.len(), 21);
    }

    #[test]
    fn deprecated_cleanup_expands_none() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let artifacts =
            expand_surface_fail_closed(SetupSurfaceId::DeprecatedSkillCleanup, &repo).unwrap();
        assert!(artifacts.is_empty());
    }

    #[test]
    fn fingerprint_rejects_empty() {
        assert!(!validate_fingerprint_format(""));
        assert!(!validate_fingerprint_format("not hex!"));
    }

    #[test]
    fn manifest_rejects_duplicate_artifact_ids() {
        let ws = temp("manifest-dup");
        let manifest = ArtifactTransactionManifest {
            schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: workspace_key(&ws).unwrap_or_default(),
            created_at: "1".into(),
            surface_ids: vec![SetupSurfaceId::OpenCodeRules],
            operations: vec![
                ArtifactManifestOperation {
                    artifact: ArtifactId::OpenCodeRules,
                    surface: SetupSurfaceId::OpenCodeRules,
                    kind: OperationKind::Update,
                    previous_state: PreviousState::ManagedFile,
                    rollback_action: RollbackAction::RestoreFile,
                    backup_rel: Some("artifacts/x".into()),
                    apply_status: ApplyStatus::Pending,
                    validation_status: ValidationStatus::Pending,
                    rollback_status: RollbackStatus::Pending,
                },
                ArtifactManifestOperation {
                    artifact: ArtifactId::OpenCodeRules,
                    surface: SetupSurfaceId::OpenCodeRules,
                    kind: OperationKind::Update,
                    previous_state: PreviousState::ManagedFile,
                    rollback_action: RollbackAction::RestoreFile,
                    backup_rel: Some("artifacts/y".into()),
                    apply_status: ApplyStatus::Pending,
                    validation_status: ValidationStatus::Pending,
                    rollback_status: RollbackStatus::Pending,
                },
            ],
        };
        assert!(validate_manifest(&manifest, &ws).is_err());
    }

    #[test]
    fn validation_fails_on_update_after_apply() {
        let home = temp("val-home");
        let ws = temp("val-ws");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(ws.join("templates/sync")).unwrap();
        fs::write(ws.join("templates/sync/codex-rules.md"), "a").unwrap();
        fs::write(home.join(".codex/AGENTS.md"), "b").unwrap();
        let artifact = ArtifactId::CodexRules;
        let err = validate_artifact_after_apply(&artifact, &ws, &home).unwrap_err();
        assert!(err.contains("Update"));
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&ws);
    }
}
