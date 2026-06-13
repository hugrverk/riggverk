//! Artifact-owned setup transaction engine.
//!
//! Expands surfaces to concrete artifacts, runs preflight/backup/manifest/apply/
//! validation/rollback at artifact granularity. Surface owners execute writes;
//! this module owns transaction evidence and per-artifact state.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::{ArtifactId, ArtifactKind};
use crate::commands::file_eq;
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};

pub const ARTIFACT_MANIFEST_SCHEMA_VERSION: u32 = 5;
const MAX_MANIFEST_OPERATIONS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviousState {
    Absent,
    ManagedFile,
    MergeableConfigFile,
    Conflict,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RollbackAction {
    RestoreFile,
    RestoreManagedConfigFile,
    RemoveCreatedFile,
    NoAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ApplyStatus {
    #[default]
    Pending,
    InFlight,
    Applied,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransactionStatus {
    #[default]
    Prepared,
    Applying,
    Completed,
    Failed,
    RollingBack,
    RolledBack,
    RollbackFailed,
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
    /// Rollback mutation started or possibly completed before status was persisted.
    InFlight,
    Restored,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackReconcileOutcome {
    AlreadyRestored,
    NeedsRollback,
    Conflicted,
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
    /// Bounded managed digest recorded after successful apply validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_apply_digest: Option<String>,
    /// Full-file or full-directory digest recorded after successful apply validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_apply_full_digest: Option<String>,
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
            post_apply_digest: None,
            post_apply_full_digest: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactTransactionManifest {
    pub schema_version: u32,
    pub workspace_key: String,
    pub created_at: String,
    pub surface_ids: Vec<SetupSurfaceId>,
    #[serde(default)]
    pub transaction_status: TransactionStatus,
    #[serde(default)]
    pub previous_managed_state_present: bool,
    #[serde(default)]
    pub previous_managed_state_trusted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_managed_state_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_managed_state_backup_rel: Option<String>,
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

const MAX_PREVIEW_TOKENS: usize = 64;
const PREVIEW_TOKEN_TTL_SECS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewPurpose {
    Apply,
}

#[derive(Debug, Clone)]
struct PreviewTokenEntry {
    workspace_key: String,
    fingerprint: String,
    purpose: PreviewPurpose,
    scope_surfaces: Vec<SetupSurfaceId>,
    issued_at: SystemTime,
    consumed: bool,
}

static PREVIEW_TOKENS: OnceLock<Mutex<HashMap<String, PreviewTokenEntry>>> = OnceLock::new();
static PREVIEW_TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

fn preview_tokens() -> &'static Mutex<HashMap<String, PreviewTokenEntry>> {
    PREVIEW_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn prune_preview_tokens(map: &mut HashMap<String, PreviewTokenEntry>) {
    let now = now_secs();
    map.retain(|_, entry| {
        !entry.consumed
            && now.saturating_sub(
                entry
                    .issued_at
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            ) < PREVIEW_TOKEN_TTL_SECS
    });
    while map.len() > MAX_PREVIEW_TOKENS {
        let Some(oldest_key) = map
            .iter()
            .min_by_key(|(_, entry)| entry.issued_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        map.remove(&oldest_key);
    }
}

fn surfaces_match(a: &[SetupSurfaceId], b: &[SetupSurfaceId]) -> bool {
    let mut left: Vec<_> = a.iter().map(|s| format!("{s:?}")).collect();
    let mut right: Vec<_> = b.iter().map(|s| format!("{s:?}")).collect();
    left.sort();
    right.sort();
    left == right
}

fn stable_fingerprint(parts: &[String]) -> Result<String, String> {
    let encoded =
        serde_json::to_vec(parts).map_err(|e| format!("serialize fingerprint input: {e}"))?;
    Ok(crate::stable_digest::bytes(&encoded)
        .strip_prefix("sha256:")
        .unwrap_or_default()
        .to_string())
}

pub fn issue_preview_token(
    workspace_root: &Path,
    fingerprint: &str,
    purpose: PreviewPurpose,
    scope_surfaces: &[SetupSurfaceId],
) -> Result<String, String> {
    let workspace_key = workspace_key(workspace_root)?;
    let seq = PREVIEW_TOKEN_SEQ.fetch_add(1, Ordering::Relaxed);
    let token = stable_fingerprint(&[
        workspace_key.clone(),
        fingerprint.to_string(),
        format!("{purpose:?}"),
        now_secs().to_string(),
        std::process::id().to_string(),
        seq.to_string(),
    ])?;
    let mut map = preview_tokens()
        .lock()
        .map_err(|_| "preview token registry unavailable".to_string())?;
    prune_preview_tokens(&mut map);
    map.insert(
        token.clone(),
        PreviewTokenEntry {
            workspace_key,
            fingerprint: fingerprint.to_string(),
            purpose,
            scope_surfaces: scope_surfaces.to_vec(),
            issued_at: SystemTime::now(),
            consumed: false,
        },
    );
    Ok(token)
}

pub fn validate_preview_token(
    token: &str,
    workspace_root: &Path,
    fingerprint: &str,
    purpose: PreviewPurpose,
    scope_surfaces: &[SetupSurfaceId],
) -> Result<(), String> {
    let workspace_key = workspace_key(workspace_root)?;
    let map = preview_tokens()
        .lock()
        .map_err(|_| "preview token registry unavailable".to_string())?;
    let entry = map
        .get(token)
        .ok_or_else(|| "invalid or expired preview token".to_string())?;
    if entry.consumed {
        return Err("preview token already used".to_string());
    }
    let age = SystemTime::now()
        .duration_since(entry.issued_at)
        .map(|d| d.as_secs())
        .unwrap_or(PREVIEW_TOKEN_TTL_SECS);
    if age >= PREVIEW_TOKEN_TTL_SECS {
        return Err("preview token expired".to_string());
    }
    if entry.workspace_key != workspace_key {
        return Err("preview token workspace mismatch".to_string());
    }
    if entry.fingerprint != fingerprint {
        return Err("preview token fingerprint mismatch".to_string());
    }
    if entry.purpose != purpose {
        return Err("preview token purpose mismatch".to_string());
    }
    if !surfaces_match(&entry.scope_surfaces, scope_surfaces) {
        return Err("preview token scope mismatch".to_string());
    }
    Ok(())
}

pub fn consume_preview_token(token: &str) -> Result<(), String> {
    let mut map = preview_tokens()
        .lock()
        .map_err(|_| "preview token registry unavailable".to_string())?;
    let entry = map
        .get_mut(token)
        .ok_or_else(|| "invalid or expired preview token".to_string())?;
    if entry.consumed {
        return Err("preview token already used".to_string());
    }
    entry.consumed = true;
    Ok(())
}

#[cfg(test)]
pub fn clear_preview_tokens_for_test() {
    if let Ok(mut map) = preview_tokens().lock() {
        map.clear();
    }
}

pub fn new_transaction_id() -> Result<String, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| Ok(d.as_nanos().to_string()))
        .map_err(|e| format!("cannot generate transaction id: {e}"))?
}

pub fn workspace_key(workspace_root: &Path) -> Result<String, String> {
    if !workspace_root.is_absolute() {
        return Err(format!(
            "workspace path must be absolute: {}",
            workspace_root.display()
        ));
    }
    Ok(workspace_root.to_string_lossy().into_owned())
}

pub fn expand_surfaces_to_artifacts(
    surfaces: &[SetupSurfaceId],
    _workspace_root: &Path,
) -> Result<Vec<ArtifactId>, String> {
    let bundled_root = crate::setup_roots::bundled_root_for(_workspace_root)?;
    let mut artifacts: Vec<ArtifactId> = Vec::new();
    let mut seen = HashSet::new();
    for surface in surfaces {
        let expanded = expand_surface_fail_closed(*surface, &bundled_root)?;
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
                &artifact.resolve_dest(&user_home()?, _workspace_root)?,
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
    crate::artifact_registry::expand_surface(surface, workspace_root)
}

fn user_home() -> Result<PathBuf, String> {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
}

pub fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    crate::path_safety::reject_symlink(path, label)
}

pub fn reject_symlink_parent_chain(
    path: &Path,
    allowlisted_root: &Path,
    label: &str,
) -> Result<(), String> {
    crate::path_safety::reject_symlink_parent_chain(path, allowlisted_root, label)
}

/// Resolve and validate artifact source and destination paths before mutation.
pub fn validate_artifact_source_dest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    if !workspace_root.is_absolute() {
        return Err("workspace root must be absolute".to_string());
    }
    let ws_root = workspace_root.to_path_buf();
    let dest = artifact.resolve_dest(home, &ws_root)?;
    let dest_root = if matches!(artifact, ArtifactId::WorkspaceFile(_)) {
        &ws_root
    } else {
        home
    };
    crate::path_safety::reject_path_escape(&dest, dest_root, "destination")?;
    reject_symlink_parent_chain(&dest, dest_root, "destination")?;
    reject_symlink(&dest, "destination")?;
    let bundled_root = crate::setup_roots::bundled_root_for(&ws_root)?
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize bundled workspace: {e}"))?;
    let source = artifact
        .resolve_source(&bundled_root)
        .ok_or_else(|| format!("missing source for {artifact:?}"))?;
    crate::path_safety::reject_path_escape(&source, &bundled_root, "source")?;
    reject_symlink_parent_chain(&source, &bundled_root, "source")?;
    reject_symlink(&source, "source")?;
    Ok((source, dest))
}

/// Aggregate artifact operation kinds while keeping safe work available beside conflicts.
pub fn aggregate_operation_kind(kinds: &[OperationKind]) -> OperationKind {
    if kinds.is_empty() {
        return OperationKind::Unavailable;
    }
    if kinds.iter().any(|k| matches!(k, OperationKind::Update)) {
        return OperationKind::Update;
    }
    if kinds.iter().any(|k| matches!(k, OperationKind::Remove)) {
        return OperationKind::Remove;
    }
    if kinds.iter().any(|k| matches!(k, OperationKind::Create)) {
        return OperationKind::Create;
    }
    if kinds.iter().any(|k| matches!(k, OperationKind::Conflict)) {
        return OperationKind::Conflict;
    }
    if kinds
        .iter()
        .any(|k| matches!(k, OperationKind::Unavailable))
    {
        return OperationKind::Unavailable;
    }
    if kinds.iter().any(|k| matches!(k, OperationKind::Manual)) {
        return OperationKind::Manual;
    }
    OperationKind::NoChange
}

/// Detect surface state by aggregating artifact-level detection for all owned artifacts.
pub fn detect_surface_state(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    home: &Path,
) -> (SetupSurfaceId, OperationKind, String) {
    let kinds: Vec<OperationKind> =
        match plan_artifacts_for_surfaces(&[surface], workspace_root, home) {
            Ok(planned) if !planned.is_empty() => planned.iter().map(|p| p.kind).collect(),
            Ok(_) => {
                return (
                    surface,
                    OperationKind::Unavailable,
                    format!("{} unavailable", surface.label()),
                );
            }
            Err(message) => {
                return (
                    surface,
                    OperationKind::Unavailable,
                    format!("{} unavailable: {message}", surface.label()),
                );
            }
        };
    let kind = aggregate_operation_kind(&kinds);
    let summary = match kind {
        OperationKind::NoChange => format!("{} synced", surface.label()),
        OperationKind::Create => format!("{} not installed", surface.label()),
        OperationKind::Update => format!("{} differs from source", surface.label()),
        OperationKind::Conflict => format!("{} has conflicts", surface.label()),
        OperationKind::Manual => format!("{} requires manual action", surface.label()),
        OperationKind::Unavailable => format!("{} unavailable", surface.label()),
        OperationKind::Remove => format!("{} has old app files to remove", surface.label()),
    };
    (surface, kind, summary)
}

fn artifact_kind(artifact: &ArtifactId) -> ArtifactKind {
    match artifact {
        ArtifactId::WorkspaceFile(_) => ArtifactKind::RulesFile,
        ArtifactId::CodexLegacySkill(_) => ArtifactKind::SkillFile,
        ArtifactId::OpenCodeConfig | ArtifactId::CodexConfig => ArtifactKind::ConfigFile,
        ArtifactId::OpenCodeTui => ArtifactKind::TuiConfig,
        ArtifactId::OpenCodePlaywrightMcp => ArtifactKind::McpConfig,
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
        | ArtifactId::CursorSkill(_) => ArtifactKind::SkillFile,
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
    let mut parts = vec![ws_key];
    let mut surface_ids: Vec<_> = surfaces.to_vec();
    surface_ids.sort_by_key(|s| format!("{s:?}"));
    for s in &surface_ids {
        parts.push(format!("surface:{s:?}"));
    }
    let mut artifacts: Vec<_> = artifact_ops.iter().map(|a| a.artifact.clone()).collect();
    artifacts.sort_by_key(|a| format!("{a:?}"));
    for artifact in &artifacts {
        parts.push(format!("artifact:{artifact:?}"));
        let bundled_root = crate::setup_roots::bundled_root_for(workspace_root)?;
        let planned_kind = artifact_ops
            .iter()
            .find(|operation| operation.artifact == *artifact)
            .map(|operation| operation.kind);
        let source_digest = if matches!(planned_kind, Some(OperationKind::Remove)) {
            crate::setup_fingerprint::ABSENT_DIGEST.to_string()
        } else if artifact
            .resolve_source(&bundled_root)
            .is_some_and(|source| source.exists())
        {
            crate::setup_fingerprint::artifact_source_digest(artifact, &bundled_root, home)
                .map_err(|error| {
                    format!("fingerprint source for {artifact:?} ({planned_kind:?}): {error}")
                })?
        } else {
            crate::setup_fingerprint::ABSENT_DIGEST.to_string()
        };
        parts.push(format!("source:{source_digest}"));
        let installed_digest = crate::setup_fingerprint::artifact_installed_managed_digest(
            artifact,
            workspace_root,
            home,
        )?;
        parts.push(format!("installed:{installed_digest}"));
        if let Some(op) = artifact_ops.iter().find(|o| o.artifact == *artifact) {
            parts.push(format!("operation:{:?}", op.kind));
        }
    }
    stable_fingerprint(&parts)
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
    let dest = match artifact.resolve_dest(home, workspace_root) {
        Ok(p) => p,
        Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };
    let bundled_root = match crate::setup_roots::bundled_root_for(workspace_root) {
        Ok(root) => root,
        Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };
    let source = match artifact.resolve_source(&bundled_root) {
        Some(p) => p,
        None => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };

    if reject_symlink(&dest, "destination").is_err() {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    if reject_symlink(&source, "source").is_err() {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    }

    match artifact_kind(artifact) {
        ArtifactKind::ConfigFile => detect_config_artifact(artifact, &dest, &source, home),
        ArtifactKind::TuiConfig | ArtifactKind::RulesFile | ArtifactKind::AgentFile => {
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
        ArtifactKind::SkillFile => {
            if !dest.is_file() {
                (OperationKind::Create, PreviousState::Absent)
            } else if !source.is_file() {
                (OperationKind::Unavailable, PreviousState::Unavailable)
            } else if file_eq(&dest, &source) {
                (OperationKind::NoChange, PreviousState::ManagedFile)
            } else {
                (OperationKind::Update, PreviousState::ManagedFile)
            }
        }
        ArtifactKind::McpConfig if artifact == &ArtifactId::OpenCodePlaywrightMcp => {
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
        ArtifactKind::McpConfig => {
            let status = crate::cursor_profile_ops::mcp_diff_status(
                &bundled_root,
                &match crate::cursor_profile_paths::resolve_cursor_profile_paths() {
                    Ok(p) => p,
                    Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
                },
            );
            // The Cursor MCP merge rewrites only the managed playwright
            // entry and preserves every other server, so divergence is
            // mergeable rather than whole-file ownership.
            match status.as_str() {
                "synced" => (OperationKind::NoChange, PreviousState::MergeableConfigFile),
                "missing" => (OperationKind::Create, PreviousState::Absent),
                "diverged" => (OperationKind::Update, PreviousState::MergeableConfigFile),
                _ => (OperationKind::Unavailable, PreviousState::Unavailable),
            }
        }
    }
}

fn detect_config_artifact(
    artifact: &ArtifactId,
    dest: &Path,
    source: &Path,
    home: &Path,
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
    } else if artifact == &ArtifactId::OpenCodeConfig {
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
        let rendered = match crate::commands::render_expected_opencode_config(&source_json, home) {
            Some(v) => v,
            None => return (OperationKind::Unavailable, PreviousState::Unavailable),
        };
        if crate::commands::managed_opencode_keys_match(&installed_json, &rendered) {
            (OperationKind::NoChange, PreviousState::MergeableConfigFile)
        } else {
            (OperationKind::Update, PreviousState::MergeableConfigFile)
        }
    } else {
        (OperationKind::Unavailable, PreviousState::Unavailable)
    }
}

fn managed_hash_for(
    identity: &str,
    records: &[crate::managed_state::ManagedArtifactRecord],
) -> Option<String> {
    records
        .iter()
        .find(|r| r.identity == identity)
        .map(|r| r.hash.clone())
}

fn detect_stale_artifact_state(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    managed_hash: Option<&str>,
) -> (OperationKind, PreviousState) {
    let dest = match artifact.resolve_dest(home, workspace_root) {
        Ok(p) => p,
        Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };
    if reject_symlink(&dest, "destination").is_err() {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    if !dest.exists() {
        return (OperationKind::NoChange, PreviousState::Absent);
    }
    let installed = match crate::setup_fingerprint::artifact_installed_managed_digest(
        artifact,
        workspace_root,
        home,
    ) {
        Ok(d) => d,
        Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
    };
    let Some(expected) = managed_hash else {
        return (OperationKind::Conflict, PreviousState::Conflict);
    };
    if let ArtifactId::CodexLegacySkill(name) = artifact {
        let Some(current) = crate::artifact_registry::SkillName::new(name.as_str().to_string())
            .map(ArtifactId::CodexSkill)
        else {
            return (OperationKind::Conflict, PreviousState::Conflict);
        };
        let current_dest = match current.resolve_dest(home, workspace_root) {
            Ok(path) => path,
            Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
        };
        if current_dest.exists() {
            let current_digest = crate::setup_fingerprint::artifact_installed_managed_digest(
                &current,
                workspace_root,
                home,
            );
            // A legacy copy that duplicates the migrated copy or matches an
            // app-shipped digest is app-owned; anything else is preserved.
            let duplicate = current_digest.as_deref() == Ok(installed.as_str());
            if !duplicate
                && !crate::managed_bootstrap::approved_codex_legacy_digest(
                    artifact,
                    &installed,
                    workspace_root,
                    home,
                )
            {
                return (OperationKind::Conflict, PreviousState::Conflict);
            }
        }
    }
    if installed == expected {
        (OperationKind::Remove, PreviousState::ManagedFile)
    } else {
        (OperationKind::Conflict, PreviousState::Conflict)
    }
}

/// Result of planning a full uninstall.
pub struct UninstallArtifactPlan {
    /// Proven app-owned installed artifacts, planned as Remove operations.
    pub removals: Vec<PlannedArtifact>,
    /// Installed artifacts whose content diverged from any app-owned proof;
    /// these are preserved and reported.
    pub preserved: Vec<ArtifactId>,
    /// Merge-managed config files (user-owned by contract); never deleted.
    pub merged: Vec<ArtifactId>,
}

/// Plan a full uninstall across all surfaces: every installed artifact whose
/// content matches an app-owned proof (managed state, historical ownership,
/// or current source) becomes a Remove operation. Diverged copies and
/// merge-managed configs are preserved.
pub fn plan_artifacts_for_uninstall(
    workspace_root: &Path,
    home: &Path,
) -> Result<UninstallArtifactPlan, String> {
    let managed = crate::managed_state::read_managed_state(workspace_root);
    let bootstrap_records = if workspace_root.join("skills").is_dir() {
        crate::managed_bootstrap::infer_bootstrap_records(workspace_root, home).unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut records: Vec<crate::managed_state::ManagedArtifactRecord> = managed
        .as_ref()
        .map(|s| s.artifacts.clone())
        .unwrap_or_default();
    let known: std::collections::HashSet<String> =
        records.iter().map(|r| r.identity.clone()).collect();
    records.extend(
        bootstrap_records
            .into_iter()
            .filter(|record| !known.contains(&record.identity)),
    );
    let bundled_root = crate::setup_roots::bundled_root_for(workspace_root)?;

    let artifacts = expand_surfaces_to_artifacts(SetupSurfaceId::ALL, workspace_root)?;
    let mut removals = Vec::new();
    let mut preserved = Vec::new();
    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for artifact in artifacts {
        let identity = crate::managed_state::artifact_identity(&artifact);
        seen.insert(identity.clone());
        if matches!(
            artifact_kind(&artifact),
            ArtifactKind::ConfigFile | ArtifactKind::TuiConfig | ArtifactKind::McpConfig
        ) {
            // Managed keys were merged into a user-owned file; deleting the
            // file would destroy user content.
            let exists = artifact
                .resolve_dest(home, workspace_root)
                .map(|dest| dest.is_file())
                .unwrap_or(false);
            if exists {
                merged.push(artifact);
            }
            continue;
        }
        let installed = crate::setup_fingerprint::artifact_installed_managed_digest(
            &artifact,
            workspace_root,
            home,
        )?;
        if installed == crate::setup_fingerprint::ABSENT_DIGEST {
            continue;
        }
        let source_root = if matches!(artifact, ArtifactId::WorkspaceFile(_)) {
            bundled_root.as_path()
        } else {
            workspace_root
        };
        let source =
            crate::setup_fingerprint::artifact_source_digest(&artifact, source_root, home).ok();
        let managed_hash = managed_hash_for(&identity, &records);
        let owned = managed_hash.as_deref() == Some(installed.as_str())
            || source.as_deref() == Some(installed.as_str());
        if owned {
            let surface = artifact.surface();
            removals.push(PlannedArtifact {
                artifact,
                surface,
                kind: OperationKind::Remove,
                previous_state: PreviousState::ManagedFile,
                rollback_action: rollback_action_for(
                    OperationKind::Remove,
                    PreviousState::ManagedFile,
                ),
            });
        } else {
            preserved.push(artifact);
        }
    }

    // Stale app-owned files from older versions are part of the install too.
    let canonical_identities =
        crate::managed_state::canonical_artifact_identities(&bundled_root).unwrap_or_default();
    let stale = crate::managed_bootstrap::collect_stale_removal_artifacts(
        workspace_root,
        home,
        &records,
        &canonical_identities,
    )?;
    for artifact in stale {
        let identity = crate::managed_state::artifact_identity(&artifact);
        if !seen.insert(identity.clone()) {
            continue;
        }
        let managed_hash = managed_hash_for(&identity, &records);
        let (kind, previous_state) =
            detect_stale_artifact_state(&artifact, workspace_root, home, managed_hash.as_deref());
        match kind {
            OperationKind::Remove => {
                let surface = artifact.surface();
                let rollback_action = rollback_action_for(kind, previous_state);
                removals.push(PlannedArtifact {
                    artifact,
                    surface,
                    kind,
                    previous_state,
                    rollback_action,
                });
            }
            OperationKind::Conflict => preserved.push(artifact),
            _ => {}
        }
    }

    Ok(UninstallArtifactPlan {
        removals,
        preserved,
        merged,
    })
}

pub fn plan_artifacts_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<PlannedArtifact>, String> {
    let managed = crate::managed_state::read_managed_state(workspace_root);
    let bootstrap_records = if workspace_root.join("skills").is_dir() {
        crate::managed_bootstrap::infer_bootstrap_records(workspace_root, home).unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut records: Vec<crate::managed_state::ManagedArtifactRecord> = managed
        .as_ref()
        .map(|s| s.artifacts.clone())
        .unwrap_or_default();
    // Pre-manifest copies stay adoptable after the first apply: explicit
    // managed records win, historical-ownership records fill the gaps for
    // artifacts an earlier app version installed but no apply has touched.
    let known: std::collections::HashSet<String> =
        records.iter().map(|r| r.identity.clone()).collect();
    records.extend(
        bootstrap_records
            .into_iter()
            .filter(|record| !known.contains(&record.identity)),
    );

    let bundled_root = crate::setup_roots::bundled_root_for(workspace_root)?;
    let canonical_identities =
        match crate::managed_state::canonical_artifact_identities(&bundled_root) {
            Ok(identities) => identities,
            #[cfg(test)]
            Err(_) => std::collections::HashSet::new(),
            #[cfg(not(test))]
            Err(error) => return Err(error),
        };

    let artifacts = expand_surfaces_to_artifacts(surfaces, workspace_root)?;
    let mut planned = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for artifact in artifacts {
        seen.insert(crate::managed_state::artifact_identity(&artifact));
        let surface = artifact.surface();
        let identity = crate::managed_state::artifact_identity(&artifact);
        let managed_hash = managed_hash_for(&identity, &records);
        let (kind, previous_state) = detect_artifact_state(&artifact, workspace_root, home);
        let (kind, previous_state) = refine_with_managed_hash(
            kind,
            previous_state,
            &artifact,
            workspace_root,
            home,
            managed_hash.as_deref(),
        );
        // Updates without proven ownership are preserved as conflicts, except
        // mergeable configs: their merge rewrites only managed keys and
        // preserves user-owned content by construction.
        let (kind, previous_state) = if managed_hash.is_none()
            && matches!(kind, OperationKind::Update)
            && !matches!(previous_state, PreviousState::MergeableConfigFile)
        {
            (OperationKind::Conflict, PreviousState::Conflict)
        } else {
            (kind, previous_state)
        };
        let rollback_action = rollback_action_for(kind, previous_state);
        planned.push(PlannedArtifact {
            artifact,
            surface,
            kind,
            previous_state,
            rollback_action,
        });
    }

    let requested_surfaces: std::collections::HashSet<SetupSurfaceId> =
        surfaces.iter().copied().collect();
    let stale = crate::managed_bootstrap::collect_stale_removal_artifacts(
        workspace_root,
        home,
        &records,
        &canonical_identities,
    )?;
    for artifact in stale {
        // Stale cleanup stays scoped to the surfaces the caller asked for;
        // a Claude update must not remove Codex or OpenCode files.
        if !requested_surfaces.contains(&artifact.surface()) {
            continue;
        }
        let identity = crate::managed_state::artifact_identity(&artifact);
        if seen.contains(&identity) {
            continue;
        }
        seen.insert(identity.clone());
        let managed_hash = managed_hash_for(&identity, &records);
        let (kind, previous_state) =
            detect_stale_artifact_state(&artifact, workspace_root, home, managed_hash.as_deref());
        if matches!(kind, OperationKind::NoChange | OperationKind::Unavailable) {
            continue;
        }
        let surface = artifact.surface();
        let rollback_action = rollback_action_for(kind, previous_state);
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

fn refine_with_managed_hash(
    kind: OperationKind,
    previous: PreviousState,
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    managed_hash: Option<&str>,
) -> (OperationKind, PreviousState) {
    let Some(expected) = managed_hash else {
        return (kind, previous);
    };
    if !matches!(kind, OperationKind::Update) {
        return (kind, previous);
    }
    let installed =
        crate::setup_fingerprint::artifact_installed_managed_digest(artifact, workspace_root, home)
            .unwrap_or(crate::setup_fingerprint::ABSENT_DIGEST.into());
    if installed == expected {
        (OperationKind::Update, previous)
    } else {
        (OperationKind::Conflict, PreviousState::Conflict)
    }
}

pub fn rollback_action_for(kind: OperationKind, previous: PreviousState) -> RollbackAction {
    match (kind, previous) {
        (OperationKind::Create, PreviousState::Absent) => RollbackAction::RemoveCreatedFile,
        (OperationKind::Update, PreviousState::ManagedFile) => RollbackAction::RestoreFile,
        (OperationKind::Update, PreviousState::MergeableConfigFile) => {
            RollbackAction::RestoreManagedConfigFile
        }
        (OperationKind::Remove, PreviousState::ManagedFile) => RollbackAction::RestoreFile,
        _ => RollbackAction::NoAction,
    }
}

pub fn artifact_backup_rel(artifact: &ArtifactId) -> String {
    const MAX_LEN: usize = 120;
    let id = match artifact {
        ArtifactId::OpenCodeConfig => "opencode-config".into(),
        ArtifactId::OpenCodeTui => "opencode-tui".into(),
        ArtifactId::OpenCodePlaywrightMcp => "opencode-playwright-mcp".into(),
        ArtifactId::OpenCodeRules => "opencode-rules".into(),
        ArtifactId::CodexConfig => "codex-config".into(),
        ArtifactId::CodexRules => "codex-rules".into(),
        ArtifactId::ClaudeRules => "claude-rules".into(),
        ArtifactId::CursorMcp => "cursor-mcp".into(),
        ArtifactId::OpenCodeAgent(name) => format!("opencode-agent-{}", name.as_str()),
        ArtifactId::CodexAgent(name) => format!("codex-agent-{}", name.as_str()),
        ArtifactId::ClaudeAgent(name) => format!("claude-agent-{}", name.as_str()),
        ArtifactId::CursorAgent(name) => format!("cursor-agent-{}", name.as_str()),
        ArtifactId::OpenCodeSkill(name) => format!("opencode-skill-{}", name.as_str()),
        ArtifactId::CodexSkill(name) => format!("codex-skill-{}", name.as_str()),
        ArtifactId::ClaudeSkill(name) => format!("claude-skill-{}", name.as_str()),
        ArtifactId::CursorSkill(name) => format!("cursor-skill-{}", name.as_str()),
        ArtifactId::CodexLegacySkill(name) => format!("codex-legacy-skill-{}", name.as_str()),
        ArtifactId::WorkspaceFile(rel) => {
            format!("workspace-file-{}", rel.as_str().replace('/', "__"))
        }
    };
    if id.len() > MAX_LEN {
        id[..MAX_LEN].to_string()
    } else {
        id
    }
}

pub fn operation_may_have_been_modified(status: ApplyStatus) -> bool {
    matches!(
        status,
        ApplyStatus::InFlight | ApplyStatus::Applied | ApplyStatus::Failed
    )
}

/// Artifacts that may still be rolled back: modified during apply and not already restored.
pub fn operation_eligible_for_rollback_mutation(op: &ArtifactManifestOperation) -> bool {
    operation_may_have_been_modified(op.apply_status)
        && !matches!(op.rollback_status, RollbackStatus::Restored)
}

/// Indices of operations eligible for rollback, in manifest apply order.
pub fn rollback_eligible_indices(operations: &[ArtifactManifestOperation]) -> Vec<usize> {
    operations
        .iter()
        .enumerate()
        .filter(|(_, op)| operation_eligible_for_rollback_mutation(op))
        .map(|(i, _)| i)
        .collect()
}

pub fn validate_operation_status_combo(op: &ArtifactManifestOperation) -> Result<(), String> {
    if matches!(op.apply_status, ApplyStatus::Pending)
        && matches!(op.validation_status, ValidationStatus::Passed)
    {
        return Err("pending artifact cannot have passed validation".into());
    }
    if matches!(op.kind, OperationKind::Create)
        && matches!(op.previous_state, PreviousState::Absent)
        && matches!(
            op.rollback_action,
            RollbackAction::RestoreFile | RollbackAction::RestoreManagedConfigFile
        )
    {
        return Err("create from absent cannot restore from backup".into());
    }
    if matches!(op.kind, OperationKind::Update)
        && matches!(op.rollback_action, RollbackAction::RemoveCreatedFile)
    {
        return Err("update cannot remove created artifact".into());
    }
    if matches!(op.rollback_status, RollbackStatus::Restored)
        && matches!(op.apply_status, ApplyStatus::Pending)
    {
        return Err("rolled back artifact cannot be pending".into());
    }
    if matches!(op.rollback_status, RollbackStatus::Pending)
        && matches!(op.apply_status, ApplyStatus::Applied)
        && matches!(op.validation_status, ValidationStatus::Failed)
    {
        return Err("applied artifact cannot have failed validation with pending rollback".into());
    }
    if matches!(op.rollback_status, RollbackStatus::InFlight)
        && matches!(op.apply_status, ApplyStatus::Pending)
    {
        return Err("in_flight rollback cannot be pending apply".into());
    }
    Ok(())
}

pub fn validate_transaction_rollback_status_combo(
    manifest: &ArtifactTransactionManifest,
) -> Result<(), String> {
    let rolling = matches!(
        manifest.transaction_status,
        TransactionStatus::RollingBack | TransactionStatus::RollbackFailed
    );
    if matches!(manifest.transaction_status, TransactionStatus::RolledBack) {
        for op in &manifest.operations {
            if operation_may_have_been_modified(op.apply_status)
                && !matches!(op.rollback_status, RollbackStatus::Restored)
            {
                return Err(
                    "rolled_back transaction cannot have unresolved rollback artifacts".into(),
                );
            }
            if matches!(op.rollback_status, RollbackStatus::InFlight) {
                return Err("rolled_back transaction cannot have in_flight rollback".into());
            }
        }
    }
    for op in &manifest.operations {
        if matches!(op.rollback_status, RollbackStatus::InFlight) && !rolling {
            return Err("in_flight rollback requires rolling_back transaction".into());
        }
    }
    Ok(())
}

pub fn artifact_matches_post_apply_state(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<bool, String> {
    let expected_full = op
        .post_apply_full_digest
        .as_deref()
        .ok_or_else(|| "missing post-apply full digest".to_string())?;
    let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if current_full != expected_full {
        return Ok(false);
    }
    if let Some(expected_managed) = op.post_apply_digest.as_deref() {
        let current_managed = crate::setup_fingerprint::artifact_installed_managed_digest(
            &op.artifact,
            workspace_root,
            home,
        )?;
        if current_managed != expected_managed {
            return Ok(false);
        }
    }
    Ok(true)
}

fn backup_path_for_op(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
) -> Result<PathBuf, String> {
    let rel = op
        .backup_rel
        .as_ref()
        .ok_or_else(|| "missing backup for restore".to_string())?;
    if rel.starts_with('/') || rel.contains("..") {
        return Err("unsafe backup path".into());
    }
    let backup_path = backup_dir.join(rel);
    reject_path_within_transaction_root(&backup_path, backup_dir)?;
    Ok(backup_path)
}

pub fn artifact_matches_previous_backup_state(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<bool, String> {
    let dest = op.artifact.resolve_dest(home, workspace_root)?;
    match op.rollback_action {
        RollbackAction::RemoveCreatedFile => {
            let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
                &op.artifact,
                workspace_root,
                home,
            )?;
            Ok(current_full == crate::setup_fingerprint::ABSENT_DIGEST)
        }
        RollbackAction::RestoreFile => {
            let backup_path = backup_path_for_op(op, backup_dir)?;
            if !backup_path.is_file() {
                return Err("backup missing".into());
            }
            if !dest.is_file() {
                return Ok(false);
            }
            Ok(file_eq(&dest, &backup_path))
        }
        RollbackAction::RestoreManagedConfigFile => {
            let backup_path = backup_path_for_op(op, backup_dir)?;
            if !backup_path.is_file() {
                return Err("backup missing".into());
            }
            if !dest.is_file() {
                return Ok(false);
            }
            let backup_managed =
                crate::setup_fingerprint::artifact_installed_managed_digest_from_path(
                    &op.artifact,
                    &backup_path,
                )?;
            let current_managed = crate::setup_fingerprint::artifact_installed_managed_digest(
                &op.artifact,
                workspace_root,
                home,
            )?;
            Ok(backup_managed == current_managed)
        }
        RollbackAction::NoAction => Ok(true),
    }
}

pub fn reconcile_in_flight_rollback_artifact(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<RollbackReconcileOutcome, String> {
    if artifact_matches_previous_backup_state(op, backup_dir, home, workspace_root)? {
        return Ok(RollbackReconcileOutcome::AlreadyRestored);
    }
    if artifact_matches_post_apply_state(op, workspace_root, home)? {
        return Ok(RollbackReconcileOutcome::NeedsRollback);
    }
    Ok(RollbackReconcileOutcome::Conflicted)
}

pub fn validate_artifact_matches_backup_after_rollback(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    if !artifact_matches_previous_backup_state(op, backup_dir, home, workspace_root)? {
        return Err("rollback validation failed: artifact does not match backup".into());
    }
    Ok(())
}

pub fn compute_finalize_rollback_status(
    operations: &[ArtifactManifestOperation],
) -> TransactionStatus {
    let modified: Vec<_> = operations
        .iter()
        .filter(|op| operation_may_have_been_modified(op.apply_status))
        .collect();
    if modified.is_empty() {
        return TransactionStatus::RolledBack;
    }
    if modified
        .iter()
        .all(|op| matches!(op.rollback_status, RollbackStatus::Restored))
    {
        return TransactionStatus::RolledBack;
    }
    TransactionStatus::RollbackFailed
}

fn validate_operation_consistency(op: &ArtifactManifestOperation) -> Result<(), String> {
    let expected = rollback_action_for(op.kind, op.previous_state);
    if op.rollback_action != expected {
        return Err(format!(
            "rollback action {:?} inconsistent with kind {:?} and previous state {:?}",
            op.rollback_action, op.kind, op.previous_state
        ));
    }
    match (op.kind, op.previous_state) {
        (OperationKind::Create, PreviousState::Absent) if op.backup_rel.is_some() => {
            return Err("create from absent must not have backup".into());
        }
        (OperationKind::Create, PreviousState::Absent) => {}
        (OperationKind::Update, PreviousState::ManagedFile)
        | (OperationKind::Update, PreviousState::MergeableConfigFile)
            if op.backup_rel.is_none() =>
        {
            return Err("update requires backup".into());
        }
        (OperationKind::Update, PreviousState::ManagedFile)
        | (OperationKind::Update, PreviousState::MergeableConfigFile) => {}
        (OperationKind::Remove, PreviousState::ManagedFile) if op.backup_rel.is_none() => {
            return Err("remove requires backup".into());
        }
        (OperationKind::Remove, PreviousState::ManagedFile) => {}
        (OperationKind::NoChange, _) => {
            return Err("no_change must not appear in manifest operations".into());
        }
        _ => {}
    }
    validate_operation_status_combo(op)
}

pub fn persist_manifest_atomic(
    path: &Path,
    manifest: &ArtifactTransactionManifest,
    allowlisted_root: &Path,
) -> Result<(), String> {
    reject_symlink_parent_chain(path, allowlisted_root, "manifest path")?;
    reject_symlink(path, "manifest path")?;
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    let _: ArtifactTransactionManifest =
        serde_json::from_str(&json).map_err(|e| format!("validate manifest json: {e}"))?;
    crate::safe_filesystem::write_regular_file_atomic(path, json.as_bytes(), allowlisted_root)?;
    let read_back = fs::read_to_string(path).map_err(|e| format!("re-read manifest: {e}"))?;
    let parsed: ArtifactTransactionManifest =
        serde_json::from_str(&read_back).map_err(|e| format!("parse re-read manifest: {e}"))?;
    if parsed.schema_version != manifest.schema_version
        || parsed.operations.len() != manifest.operations.len()
    {
        return Err("manifest re-read mismatch".into());
    }
    Ok(())
}

pub fn backup_artifact(
    artifact: &ArtifactId,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<Option<String>, String> {
    let dest = artifact.resolve_dest(home, workspace_root)?;
    if !dest.exists() {
        return Ok(None);
    }
    reject_symlink(&dest, "backup destination")?;
    let rel = format!("artifacts/{}", artifact_backup_rel(artifact));
    let backup_path = backup_dir.join(&rel);
    reject_path_within_transaction_root(&backup_path, backup_dir)?;
    // Validate source parent chain against the appropriate root.
    let source_root = if matches!(artifact, ArtifactId::WorkspaceFile(_)) {
        workspace_root
    } else {
        home
    };
    if dest.is_dir() {
        crate::safe_filesystem::copy_dir_no_symlinks(&dest, &backup_path, backup_dir)
            .map_err(|e| format!("backup dir {}: {e}", dest.display()))?;
        validate_backup_copy(artifact, &dest, &backup_path, backup_dir)?;
    } else {
        reject_symlink_parent_chain(&dest, source_root, "backup source file")?;
        crate::safe_filesystem::copy_regular_file_no_symlinks(&dest, &backup_path, backup_dir)
            .map_err(|e| format!("backup file {}: {e}", dest.display()))?;
        validate_backup_copy(artifact, &dest, &backup_path, backup_dir)?;
    }
    Ok(Some(rel))
}

fn reject_path_within_transaction_root(path: &Path, transaction_root: &Path) -> Result<(), String> {
    crate::path_safety::reject_path_escape(path, transaction_root, "backup path")?;
    reject_symlink_parent_chain(path, transaction_root, "backup path")
}

fn validate_backup_copy(
    artifact: &ArtifactId,
    original: &Path,
    backup: &Path,
    transaction_root: &Path,
) -> Result<(), String> {
    reject_symlink(backup, "backup copy")?;
    reject_path_within_transaction_root(backup, transaction_root)?;
    if original.is_dir() {
        if !backup.is_dir() {
            return Err("backup is not a directory".into());
        }
        validate_directory_backup_tree(original, backup)?;
    } else {
        if !backup.is_file() {
            return Err("backup is not a regular file".into());
        }
        if !file_eq(original, backup) {
            return Err("backup content does not match original".into());
        }
    }
    let _ = artifact;
    Ok(())
}

fn scan_backup_tree_no_symlinks(backup: &Path) -> Result<(), String> {
    reject_symlink(backup, "backup tree")?;
    if !backup.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(backup).map_err(|e| format!("read backup dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read backup entry: {e}"))?;
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            return Err("nested symlink in directory backup".into());
        }
        let path = entry.path();
        if path.is_dir() {
            scan_backup_tree_no_symlinks(&path)?;
        }
    }
    Ok(())
}

fn validate_directory_backup_tree(original: &Path, backup: &Path) -> Result<(), String> {
    reject_symlink(original, "directory backup original")?;
    reject_symlink(backup, "directory backup")?;
    if !original.is_dir() {
        return Err("original is not a directory".into());
    }
    if !backup.is_dir() {
        return Err("backup is not a directory".into());
    }

    let mut original_entries = std::collections::BTreeMap::new();
    for entry in fs::read_dir(original).map_err(|e| format!("read original dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read original entry: {e}"))?;
        let path = entry.path();
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            return Err("nested symlink in original directory".into());
        }
        original_entries.insert(entry.file_name(), path);
    }

    let mut backup_entries = std::collections::BTreeMap::new();
    for entry in fs::read_dir(backup).map_err(|e| format!("read backup dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read backup entry: {e}"))?;
        let path = entry.path();
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            return Err("nested symlink in directory backup".into());
        }
        backup_entries.insert(entry.file_name(), (path, entry.file_type().ok()));
    }

    if original_entries.len() != backup_entries.len() {
        return Err("directory backup entry count mismatch".into());
    }

    for (name, original_child) in &original_entries {
        let (backup_child, backup_type) = backup_entries
            .get(name)
            .ok_or_else(|| "missing original entry in backup".to_string())?;
        let original_is_dir = original_child.is_dir();
        let backup_is_dir = backup_type
            .map(|t| t.is_dir())
            .unwrap_or_else(|| backup_child.is_dir());
        if original_is_dir != backup_is_dir {
            return Err("file versus directory mismatch in directory backup".into());
        }
        if original_is_dir {
            validate_directory_backup_tree(original_child, backup_child)?;
        } else if !original_child.is_file() || !backup_child.is_file() {
            return Err("unreadable directory backup entry".into());
        } else if !file_eq(original_child, backup_child) {
            return Err("directory backup content mismatch".into());
        }
    }
    Ok(())
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
    match (
        manifest.previous_managed_state_present,
        manifest.previous_managed_state_trusted,
        manifest.previous_managed_state_digest.as_deref(),
        manifest.previous_managed_state_backup_rel.as_deref(),
    ) {
        (true, _, Some(digest), Some(relative))
            if crate::stable_digest::valid(digest)
                && !relative.starts_with('/')
                && !relative.contains("..") => {}
        (false, false, None, None) => {}
        _ => return Err("invalid previous managed-state backup metadata".into()),
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
        if !matches!(
            op.kind,
            OperationKind::Create | OperationKind::Update | OperationKind::Remove
        ) {
            return Err("invalid manifest operation kind".into());
        }
        validate_operation_consistency(op)?;
        validate_operation_status_combo(op)?;
    }
    validate_transaction_rollback_status_combo(manifest)?;
    Ok(())
}

pub fn artifact_unchanged_since_apply(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let expected_managed = op
        .post_apply_digest
        .as_deref()
        .ok_or_else(|| "missing post-apply digest".to_string())?;
    let current_managed = crate::setup_fingerprint::artifact_installed_managed_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if current_managed != expected_managed {
        return Err("artifact changed since apply".into());
    }
    Ok(())
}

fn rollback_restore_mode(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<RollbackRestoreMode, String> {
    artifact_unchanged_since_apply(op, workspace_root, home)?;
    let expected_full = op
        .post_apply_full_digest
        .as_deref()
        .ok_or_else(|| "missing post-apply full digest".to_string())?;
    let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if current_full == expected_full {
        Ok(RollbackRestoreMode::FullBackup)
    } else if matches!(op.rollback_action, RollbackAction::RestoreManagedConfigFile) {
        Ok(RollbackRestoreMode::ManagedProjectionMerge)
    } else {
        Err("artifact changed since apply".into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RollbackRestoreMode {
    FullBackup,
    ManagedProjectionMerge,
}

pub fn validate_create_target_unchanged(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    if !matches!(op.kind, OperationKind::Create) {
        return Ok(());
    }
    let expected_full = op
        .post_apply_full_digest
        .as_deref()
        .ok_or_else(|| "missing post-apply full digest".to_string())?;
    let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if current_full != expected_full {
        return Err("artifact changed since apply".into());
    }
    Ok(())
}

pub fn validate_update_target_unchanged(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    if !matches!(op.kind, OperationKind::Update) {
        return Ok(());
    }
    rollback_restore_mode(op, workspace_root, home).map(|_| ())
}

pub fn validate_backup_for_rollback(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
) -> Result<(), String> {
    match op.rollback_action {
        RollbackAction::RemoveCreatedFile => {
            return Ok(());
        }
        RollbackAction::NoAction => return Ok(()),
        _ => {}
    }
    let rel = op
        .backup_rel
        .as_ref()
        .ok_or_else(|| "missing backup for restore".to_string())?;
    if rel.starts_with('/') || rel.contains("..") {
        return Err("unsafe backup path".into());
    }
    let backup_path = backup_dir.join(rel);
    reject_path_within_transaction_root(&backup_path, backup_dir)?;
    if !backup_path.exists() {
        return Err("backup missing".into());
    }
    reject_symlink(&backup_path, "rollback backup")?;
    if backup_path.is_dir() {
        scan_backup_tree_no_symlinks(&backup_path)?;
    } else if !backup_path.is_file() {
        return Err("backup is not a regular file".into());
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
    workspace_root: &Path,
) -> Result<(), String> {
    restore_artifact_from_backup_with_mode(
        op,
        backup_dir,
        home,
        RollbackRestoreMode::FullBackup,
        Some(workspace_root),
    )
}

pub fn restore_artifact_from_backup_for_explicit_rollback(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    let mode = rollback_restore_mode(op, workspace_root, home)?;
    restore_artifact_from_backup_with_mode(op, backup_dir, home, mode, Some(workspace_root))
}

fn restore_artifact_from_backup_with_mode(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    mode: RollbackRestoreMode,
    workspace_root: Option<&Path>,
) -> Result<(), String> {
    let ws_root =
        workspace_root.ok_or_else(|| "workspace root required for rollback".to_string())?;
    let dest = op.artifact.resolve_dest(home, ws_root)?;
    reject_symlink(&dest, "rollback destination")?;
    let allowlist_root = match &op.artifact {
        ArtifactId::WorkspaceFile(_) => ws_root,
        _ => home,
    };

    let restore_dest = dest.clone();

    match op.rollback_action {
        RollbackAction::RestoreFile => {
            let rel = op
                .backup_rel
                .as_ref()
                .ok_or_else(|| "missing backup for restore".to_string())?;
            let backup_path = backup_dir.join(rel);
            if !backup_path.exists() {
                return Err("backup missing".into());
            }
            reject_symlink(&backup_path, "backup")?;
            if restore_dest.exists() {
                crate::safe_filesystem::remove_regular_file_no_symlinks(
                    &restore_dest,
                    allowlist_root,
                )
                .map_err(|e| format!("remove restore dest file: {e}"))?;
            }
            crate::safe_filesystem::copy_regular_file_no_symlinks(
                &backup_path,
                &restore_dest,
                allowlist_root,
            )
            .map_err(|e| format!("restore file: {e}"))?;
            Ok(())
        }
        RollbackAction::RestoreManagedConfigFile => {
            let rel = op
                .backup_rel
                .as_ref()
                .ok_or_else(|| "missing backup for restore".to_string())?;
            let backup_path = backup_dir.join(rel);
            if !backup_path.is_file() {
                return Err("backup missing".into());
            }
            reject_symlink(&backup_path, "backup")?;
            match mode {
                RollbackRestoreMode::FullBackup => {
                    crate::safe_filesystem::copy_regular_file_no_symlinks(
                        &backup_path,
                        &dest,
                        allowlist_root,
                    )
                    .map_err(|e| format!("restore file: {e}"))?;
                }
                RollbackRestoreMode::ManagedProjectionMerge => {
                    if op.artifact == ArtifactId::OpenCodeConfig {
                        let installed_str = fs::read_to_string(&dest)
                            .map_err(|e| format!("read installed opencode config: {e}"))?;
                        let installed_json: serde_json::Value =
                            serde_json::from_str(&installed_str)
                                .map_err(|e| format!("parse installed opencode json: {e}"))?;
                        let backup_str = fs::read_to_string(&backup_path)
                            .map_err(|e| format!("read backup opencode config: {e}"))?;
                        let backup_json: serde_json::Value = serde_json::from_str(&backup_str)
                            .map_err(|e| format!("parse backup opencode json: {e}"))?;
                        let merged = crate::commands::merge_managed_opencode_config(
                            &installed_json,
                            &crate::commands::extract_managed_opencode_config(&backup_json),
                        );
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            (serde_json::to_string_pretty(&merged)
                                .map_err(|e| format!("serialize opencode config: {e}"))?
                                + "\n")
                                .as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write opencode config: {e}"))?;
                    } else if op.artifact == ArtifactId::CodexConfig {
                        let workspace_root = workspace_root.ok_or_else(|| {
                            "workspace root required for codex managed rollback".to_string()
                        })?;
                        let rendered = crate::commands::render_codex_config_managed_projection(
                            workspace_root,
                            &dest,
                            &backup_path,
                        )?;
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            rendered.as_bytes(),
                            allowlist_root,
                        )?;
                    } else if op.artifact == ArtifactId::CursorMcp {
                        let installed_str = fs::read_to_string(&dest)
                            .map_err(|e| format!("read installed cursor mcp: {e}"))?;
                        let installed_json: serde_json::Value =
                            serde_json::from_str(&installed_str)
                                .map_err(|e| format!("parse installed cursor mcp: {e}"))?;
                        let backup_str = fs::read_to_string(&backup_path)
                            .map_err(|e| format!("read backup cursor mcp: {e}"))?;
                        let backup_json: serde_json::Value = serde_json::from_str(&backup_str)
                            .map_err(|e| format!("parse backup cursor mcp: {e}"))?;
                        let backup_projection = backup_json
                            .get("mcpServers")
                            .and_then(|v| v.get("playwright"))
                            .cloned()
                            .ok_or_else(|| {
                                "backup cursor mcp missing playwright projection".to_string()
                            })?;
                        let mut merged = installed_json;
                        let servers = merged
                            .as_object_mut()
                            .and_then(|obj| obj.get_mut("mcpServers"))
                            .and_then(|v| v.as_object_mut())
                            .ok_or_else(|| "installed cursor mcp missing mcpServers".to_string())?;
                        servers.insert("playwright".to_string(), backup_projection);
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            (serde_json::to_string_pretty(&merged)
                                .map_err(|e| format!("serialize cursor mcp: {e}"))?
                                + "\n")
                                .as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write cursor mcp: {e}"))?;
                    } else {
                        return Err("unsupported managed config artifact".into());
                    }
                }
            }
            Ok(())
        }
        RollbackAction::RemoveCreatedFile => {
            if dest.is_file() {
                crate::safe_filesystem::remove_regular_file_no_symlinks(&dest, allowlist_root)
                    .map_err(|e| format!("remove created file: {e}"))?;
            }
            if matches!(
                op.artifact,
                ArtifactId::OpenCodeSkill(_)
                    | ArtifactId::CodexSkill(_)
                    | ArtifactId::ClaudeSkill(_)
                    | ArtifactId::CursorSkill(_)
                    | ArtifactId::CodexLegacySkill(_)
            ) {
                if let Some(parent) = dest.parent() {
                    crate::safe_filesystem::remove_empty_directory_no_symlinks(
                        parent,
                        allowlist_root,
                    )?;
                }
            }
            Ok(())
        }
        RollbackAction::NoAction => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::ArtifactId;
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
    fn workspace_bundle_expands_from_bundled_repo() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let artifacts = expand_surface_fail_closed(SetupSurfaceId::WorkspaceBundle, &repo).unwrap();
        assert!(!artifacts.is_empty());
    }

    #[test]
    fn fingerprint_rejects_empty() {
        assert!(!validate_fingerprint_format(""));
        assert!(!validate_fingerprint_format("not hex!"));
    }

    #[test]
    fn aggregate_surface_keeps_safe_update_available_beside_conflict() {
        let kinds = vec![OperationKind::Update, OperationKind::Conflict];
        assert_eq!(aggregate_operation_kind(&kinds), OperationKind::Update);
    }

    #[test]
    fn aggregate_surface_update_when_any_artifact_differs() {
        let kinds = vec![OperationKind::NoChange, OperationKind::Create];
        assert_eq!(aggregate_operation_kind(&kinds), OperationKind::Create);
        let kinds = vec![OperationKind::NoChange, OperationKind::Update];
        assert_eq!(aggregate_operation_kind(&kinds), OperationKind::Update);
    }

    #[test]
    fn preview_token_rejects_reuse() {
        clear_preview_tokens_for_test();
        let ws = temp("token-ws");
        fs::create_dir_all(&ws).unwrap();
        let fp = "abc123def4567890";
        let surfaces = vec![SetupSurfaceId::OpenCodeRules];
        let token = issue_preview_token(&ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
        validate_preview_token(&token, &ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
        consume_preview_token(&token).unwrap();
        assert!(validate_preview_token(&token, &ws, fp, PreviewPurpose::Apply, &surfaces).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rapid_identical_previews_receive_distinct_tokens() {
        clear_preview_tokens_for_test();
        let ws = temp("token-rapid");
        fs::create_dir_all(&ws).unwrap();
        let fp = "abc123def4567890abcdef1234567890";
        let surfaces = vec![SetupSurfaceId::OpenCodeRules];
        let first = issue_preview_token(&ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
        let second = issue_preview_token(&ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
        assert_ne!(
            first, second,
            "rapid duplicate previews must get distinct tokens"
        );
        validate_preview_token(&first, &ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
        validate_preview_token(&second, &ws, fp, PreviewPurpose::Apply, &surfaces).unwrap();
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rollback_does_not_include_untouched_surface_sibling() {
        let ops = vec![
            ArtifactManifestOperation {
                surface: SetupSurfaceId::OpenCodeRules,
                kind: OperationKind::Update,
                previous_state: PreviousState::ManagedFile,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/a".into()),
                apply_status: ApplyStatus::InFlight,
                ..Default::default()
            },
            ArtifactManifestOperation {
                surface: SetupSurfaceId::OpenCodeRules,
                kind: OperationKind::Update,
                previous_state: PreviousState::ManagedFile,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/b".into()),
                ..Default::default()
            },
        ];
        let eligible = rollback_eligible_indices(&ops);
        assert_eq!(
            eligible,
            vec![0],
            "only the InFlight artifact must be eligible for rollback"
        );
    }

    #[test]
    fn pending_operations_remain_pending_after_failed_first_artifact() {
        let ops = vec![
            ArtifactManifestOperation {
                apply_status: ApplyStatus::Failed,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/a".into()),
                ..Default::default()
            },
            ArtifactManifestOperation {
                apply_status: ApplyStatus::Pending,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/b".into()),
                ..Default::default()
            },
        ];
        let eligible = rollback_eligible_indices(&ops);
        assert_eq!(eligible, vec![0]);
        assert_eq!(ops[1].apply_status, ApplyStatus::Pending);
    }

    #[test]
    fn preview_token_rejects_fingerprint_mismatch() {
        clear_preview_tokens_for_test();
        let ws = temp("token-fp");
        fs::create_dir_all(&ws).unwrap();
        let surfaces = vec![SetupSurfaceId::OpenCodeRules];
        let token =
            issue_preview_token(&ws, "aaaaaaaaaaaaaaaa", PreviewPurpose::Apply, &surfaces).unwrap();
        assert!(validate_preview_token(
            &token,
            &ws,
            "bbbbbbbbbbbbbbbb",
            PreviewPurpose::Apply,
            &surfaces
        )
        .is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rollback_action_for_skill_file_uses_file_semantics() {
        assert_eq!(
            rollback_action_for(OperationKind::Update, PreviousState::ManagedFile),
            RollbackAction::RestoreFile
        );
        assert_eq!(
            rollback_action_for(OperationKind::Remove, PreviousState::ManagedFile),
            RollbackAction::RestoreFile
        );
    }

    #[test]
    fn manifest_rejects_duplicate_artifact_ids() {
        let ws = temp("manifest-dup");
        let manifest = ArtifactTransactionManifest {
            schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: workspace_key(&ws).unwrap_or_default(),
            created_at: "1".into(),
            surface_ids: vec![SetupSurfaceId::OpenCodeRules],
            transaction_status: TransactionStatus::Prepared,
            previous_managed_state_present: false,
            previous_managed_state_trusted: false,
            previous_managed_state_digest: None,
            previous_managed_state_backup_rel: None,
            operations: vec![
                ArtifactManifestOperation {
                    artifact: ArtifactId::OpenCodeRules,
                    surface: SetupSurfaceId::OpenCodeRules,
                    kind: OperationKind::Update,
                    previous_state: PreviousState::ManagedFile,
                    rollback_action: RollbackAction::RestoreFile,
                    backup_rel: Some("artifacts/x".into()),
                    ..Default::default()
                },
                ArtifactManifestOperation {
                    artifact: ArtifactId::OpenCodeRules,
                    surface: SetupSurfaceId::OpenCodeRules,
                    kind: OperationKind::Update,
                    previous_state: PreviousState::ManagedFile,
                    rollback_action: RollbackAction::RestoreFile,
                    backup_rel: Some("artifacts/y".into()),
                    ..Default::default()
                },
            ],
        };
        assert!(validate_manifest(&manifest, &ws).is_err());
    }

    #[test]
    fn directory_backup_validation_rejects_missing_original_entry() {
        let base = temp("dir-backup-missing");
        let _ = fs::remove_dir_all(&base);
        let original = base.join("original");
        let backup = base.join("backup");
        fs::create_dir_all(original.join("nested")).unwrap();
        fs::write(original.join("nested/a.txt"), b"a").unwrap();
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("extra.txt"), b"x").unwrap();
        let err = validate_directory_backup_tree(&original, &backup).expect_err("missing");
        assert!(err.contains("mismatch") || err.contains("missing"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn directory_backup_validation_accepts_exact_copy() {
        let base = temp("dir-backup-exact");
        let _ = fs::remove_dir_all(&base);
        let original = base.join("original");
        let backup = base.join("backup");
        fs::create_dir_all(original.join("nested")).unwrap();
        fs::write(original.join("nested/a.txt"), b"a").unwrap();
        fs::create_dir_all(backup.join("nested")).unwrap();
        fs::write(backup.join("nested/a.txt"), b"a").unwrap();
        assert!(validate_directory_backup_tree(&original, &backup).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_artifact_source_dest_rejects_dangling_destination() {
        #[cfg(unix)]
        {
            let base = temp("dangling-dest");
            let _ = fs::remove_dir_all(&base);
            let ws = base.join("ws");
            let home = base.join("home");
            fs::create_dir_all(ws.join("templates/sync")).unwrap();
            fs::write(ws.join("templates/sync/codex-rules.md"), "rules").unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
            let link = home.join(".codex/AGENTS.md");
            std::os::unix::fs::symlink(home.join("missing-rules"), &link).unwrap();
            let artifact = ArtifactId::CodexRules;
            let err =
                validate_artifact_source_dest(&artifact, &ws, &home).expect_err("dangling dest");
            assert!(err.contains("symlink"), "{err}");
            let _ = fs::remove_dir_all(&base);
        }
    }

    #[test]
    fn rollback_status_in_flight_serializes_and_deserializes() {
        let status = RollbackStatus::InFlight;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"in_flight\"");
        let parsed: RollbackStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, RollbackStatus::InFlight);
    }

    #[test]
    fn validate_transaction_rejects_in_flight_on_rolled_back() {
        let ws = temp("txn-inflight-rolled");
        let manifest = ArtifactTransactionManifest {
            schema_version: ARTIFACT_MANIFEST_SCHEMA_VERSION,
            workspace_key: workspace_key(&ws).unwrap_or_default(),
            created_at: "1".into(),
            surface_ids: vec![SetupSurfaceId::OpenCodeRules],
            transaction_status: TransactionStatus::RolledBack,
            previous_managed_state_present: false,
            previous_managed_state_trusted: false,
            previous_managed_state_digest: None,
            previous_managed_state_backup_rel: None,
            operations: vec![ArtifactManifestOperation {
                artifact: ArtifactId::OpenCodeRules,
                surface: SetupSurfaceId::OpenCodeRules,
                kind: OperationKind::Update,
                previous_state: PreviousState::ManagedFile,
                rollback_action: RollbackAction::RestoreFile,
                backup_rel: Some("artifacts/x".into()),
                apply_status: ApplyStatus::Applied,
                rollback_status: RollbackStatus::InFlight,
                ..Default::default()
            }],
        };
        assert!(validate_transaction_rollback_status_combo(&manifest).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn compute_finalize_rollback_status_all_restored() {
        let ops = vec![
            ArtifactManifestOperation {
                apply_status: ApplyStatus::Applied,
                rollback_status: RollbackStatus::Restored,
                ..Default::default()
            },
            ArtifactManifestOperation {
                apply_status: ApplyStatus::Applied,
                rollback_status: RollbackStatus::Restored,
                ..Default::default()
            },
        ];
        assert_eq!(
            compute_finalize_rollback_status(&ops),
            TransactionStatus::RolledBack
        );
    }

    #[test]
    fn compute_finalize_rollback_status_unresolved_failed() {
        let ops = vec![ArtifactManifestOperation {
            apply_status: ApplyStatus::Applied,
            rollback_status: RollbackStatus::Failed,
            ..Default::default()
        }];
        assert_eq!(
            compute_finalize_rollback_status(&ops),
            TransactionStatus::RollbackFailed
        );
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
