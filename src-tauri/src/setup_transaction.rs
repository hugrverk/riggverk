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
use crate::file_conflicts::is_kept;
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::skill_roots::SkillScope;
use crate::skill_sources::{SkillSources, SourceRoot};

pub const ARTIFACT_MANIFEST_SCHEMA_VERSION: u32 = 5;
/// Most operations one transaction manifest may hold; a manifest outside `1..=` this is refused
/// before anything is written or replayed.
///
/// It bounds the work one transaction can ask for: apply rewrites the whole manifest (fsynced)
/// before every operation and rollback replays all of them, so the cost grows with the square of
/// the count, and a damaged or hand-made manifest must not be able to ask for an unbounded amount.
/// A plan over the limit fails before the first write, so an upgrade that does not fit is one the
/// user can never apply: the limit has to cover the largest legitimate first upgrade with room
/// to spare. That is a profile from before the shared skill files with every harness enabled
/// (nine, Antigravity with two skill folders of its own): the whole bundle, retired adapters and
/// their manifest, skills in every wanted folder, the app's older copies in other folders
/// (including removed skills), and agent, rules and config files, tested in
/// `skill_folders_contract` with half again as margin for future skills. Real plans do not grow
/// with the limit; only that extreme profile pays the quadratic cost.
pub(crate) const MAX_MANIFEST_OPERATIONS: usize = 2048;

/// Error reported when rollback finds user changes made after apply. Callers
/// compare against it to tell a preserved user edit from a real failure.
pub const CHANGED_SINCE_APPLY: &str = "artifact changed since apply";

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

impl TransactionStatus {
    /// Completed and rolled-back transactions are finished. A rollback-failed one is
    /// terminal for automatic reconciliation: its leftover artifacts were preserved on
    /// purpose (user edits) or need a person to look at them, and re-running it on every apply
    /// could restore an old backup over newer state. An explicit rollback can still retry it.
    /// Every other status may have left artifacts half-applied and needs reconciliation.
    pub fn needs_reconciliation(self) -> bool {
        !matches!(
            self,
            TransactionStatus::Completed
                | TransactionStatus::RolledBack
                | TransactionStatus::RollbackFailed
        )
    }
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
    /// Full-file digest of what the apply is about to write ([`crate::setup_fingerprint::ABSENT_DIGEST`]
    /// for a removal), recorded before the mutation. When the app stops before the post-apply
    /// digests are saved, it is the only proof of which content the app wrote. Absent in older
    /// manifests and where the output is not known in advance (see [`expected_apply_full_digest`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_full_digest: Option<String>,
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
            expected_full_digest: None,
        }
    }
}

/// Receipt facts only: no plan summaries, paths, or file contents are persisted here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupReceipt {
    #[serde(default)]
    pub synced: Vec<SetupSurfaceId>,
    #[serde(default)]
    pub left_for_you: Vec<SetupReceiptItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupReceiptItem {
    pub surface: SetupSurfaceId,
    pub reason: SetupReceiptReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupReceiptReason {
    Conflict,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactTransactionManifest {
    pub schema_version: u32,
    pub workspace_key: String,
    pub created_at: String,
    /// Unix nanoseconds, like `created_at`; absent in older manifests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// Absent means the run did not record receipt facts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<SetupReceipt>,
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

/// The part of a stored manifest needed to decide whether its transaction can
/// still need reconciliation, readable even when the full manifest no longer
/// validates (older schema, damaged operations).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestHeader {
    pub workspace_key: Option<String>,
    pub status: TransactionStatus,
}

pub fn read_manifest_header(raw: &str) -> Result<ManifestHeader, String> {
    #[derive(Deserialize)]
    struct Header {
        #[serde(default)]
        workspace_key: Option<String>,
        #[serde(default)]
        transaction_status: TransactionStatus,
    }
    let header: Header =
        serde_json::from_str(raw).map_err(|e| format!("unreadable manifest header: {e}"))?;
    Ok(ManifestHeader {
        workspace_key: header.workspace_key,
        status: header.transaction_status,
    })
}

#[derive(Debug, Clone)]
pub struct PlannedArtifact {
    pub artifact: ArtifactId,
    pub surface: SetupSurfaceId,
    pub kind: OperationKind,
    pub previous_state: PreviousState,
    pub rollback_action: RollbackAction,
    /// Block classification for rules artifacts; `None` for every other artifact.
    pub rules: Option<crate::rules_block::RulesAssessment>,
    /// Exact content for an explicit rules conversion; `None` for every
    /// regular plan.
    pub rules_rewrite: Option<RulesRewrite>,
    /// How the managed entry stands in the MCP file of a light harness; `None` for every other
    /// artifact and when the entry template or the descriptor is unavailable.
    pub mcp: Option<crate::light_mcp::EntryState>,
    /// Set on a skill or agent file in conflict the user can resolve (and on one the user keeps);
    /// `None` for every other artifact and for a conflict something blocks.
    pub file: Option<crate::file_conflicts::FileConflict>,
    /// Set only by [`plan_take_bundled`]: the user's file in conflict is replaced by the bundled one,
    /// and only while it is still the file the user reviewed. `None` for every regular plan.
    pub overwrite: Option<Overwrite>,
}

/// A skill or agent file the user chose to replace by the bundled version (their version is backed
/// up first). Apply refuses to write when the file changed since the preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overwrite {
    /// Digest of the installed file the preview was computed from.
    pub expected_installed_digest: String,
}

/// A file the user chose to rewrite (a rules conversion, or the Codex config reset to Riggverk's
/// defaults): the complete new content, and the digest of the file it was computed from. Apply
/// refuses to write when the file changed since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesRewrite {
    pub content: String,
    pub expected_installed_digest: String,
}

const MAX_PREVIEW_TOKENS: usize = 64;
const PREVIEW_TOKEN_TTL_SECS: u64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewPurpose {
    Apply,
    /// A skill import (`commands::skill_import`): the fingerprint is the staged copy's digest.
    SkillImport,
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

pub(crate) fn stable_fingerprint(parts: &[String]) -> Result<String, String> {
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

/// Makes every issued token older than its lifetime, as if the preview had been left open.
#[cfg(test)]
pub fn expire_preview_tokens_for_test() {
    if let Ok(mut map) = preview_tokens().lock() {
        for entry in map.values_mut() {
            entry.issued_at = SystemTime::now()
                .checked_sub(std::time::Duration::from_secs(PREVIEW_TOKEN_TTL_SECS + 1))
                .unwrap_or(UNIX_EPOCH);
        }
    }
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
    Ok(
        crate::workspace_layout::canonical_workspace_path(workspace_root)
            .to_string_lossy()
            .into_owned(),
    )
}

/// Whether two workspace keys name the same workspace. The earlier default data folder and the
/// current one are the same workspace: a manifest or token made before the folder was renamed
/// still matches it.
pub fn workspace_keys_match(recorded: &str, current: &str) -> bool {
    let canonical = |key: &str| {
        crate::workspace_layout::canonical_workspace_path(Path::new(key))
            .to_string_lossy()
            .into_owned()
    };
    recorded == current || canonical(recorded) == canonical(current)
}

/// Expands surfaces to artifacts. A retired per-harness skill surface is the `Skills` surface,
/// and a surface asked for twice is expanded once. Only `Skills` (no harness is enabled) and
/// `WorkspaceBundle` (it wants no file: the copy of the bundle is gone) may expand to nothing; any
/// other empty expansion is an error.
pub fn expand_surfaces_to_artifacts(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    scope: &SkillScope,
) -> Result<Vec<ArtifactId>, String> {
    let sources = SkillSources::for_workspace(workspace_root)?;
    expand_surfaces_to_artifacts_with(surfaces, workspace_root, scope, &sources)
}

/// [`expand_surfaces_to_artifacts`] with the sources already read.
pub fn expand_surfaces_to_artifacts_with(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    scope: &SkillScope,
    sources: &SkillSources,
) -> Result<Vec<ArtifactId>, String> {
    let mut artifacts: Vec<ArtifactId> = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_surfaces = HashSet::new();
    for surface in surfaces {
        let surface = surface.canonical();
        if !seen_surfaces.insert(surface) {
            continue;
        }
        let expanded = expand_surface_fail_closed(surface, sources, scope)?;
        if expanded.is_empty()
            && !matches!(
                surface,
                SetupSurfaceId::Skills | SetupSurfaceId::WorkspaceBundle
            )
        {
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
                &artifact.resolve_dest(&user_home()?, workspace_root)?,
            )?;
            artifacts.push(artifact);
        }
    }
    Ok(artifacts)
}

pub fn expand_surface_fail_closed<R: SourceRoot + ?Sized>(
    surface: SetupSurfaceId,
    sources: &R,
    scope: &SkillScope,
) -> Result<Vec<ArtifactId>, String> {
    crate::artifact_registry::expand_surface(surface, sources, scope)
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

/// Resolve and validate an artifact's destination before mutation: it must stay inside the
/// artifact's allowlist root, and neither it nor a folder between it and that root may be a
/// symlink. Returns the destination and the allowlist root writes must use.
pub fn validate_artifact_dest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    if !workspace_root.is_absolute() {
        return Err("workspace root must be absolute".to_string());
    }
    let dest = artifact.resolve_dest(home, workspace_root)?;
    let dest_root = artifact.allowlist_root(home, workspace_root)?;
    crate::path_safety::reject_path_escape(&dest, &dest_root, "destination")?;
    reject_symlink_parent_chain(&dest, &dest_root, "destination")?;
    reject_symlink(&dest, "destination")?;
    Ok((dest, dest_root))
}

/// Resolve and validate artifact source and destination paths before mutation.
pub fn validate_artifact_source_dest(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let sources = SkillSources::for_workspace(workspace_root)?;
    validate_artifact_source_dest_with(artifact, workspace_root, home, &sources)
}

/// [`validate_artifact_source_dest`] with the sources already read (by
/// [`SkillSources::for_workspace`] for the same `workspace_root`), for a caller that validates
/// many artifacts of one plan, preflight or apply.
pub fn validate_artifact_source_dest_with(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    sources: &SkillSources,
) -> Result<(PathBuf, PathBuf), String> {
    let (dest, _) = validate_artifact_dest(artifact, workspace_root, home)?;
    let source = artifact
        .resolve_source(sources)
        .ok_or_else(|| format!("missing source for {artifact:?}"))?;
    // A skill of a pack is read from its pack folder; everything else from the bundle.
    let mut source_root = sources.source_root_of(&source);
    // The bundle is checked by its canonical path: the packaged one may be spelled with `..`.
    let source = if source_root == sources.bundle() {
        let canonical = source_root
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize bundled workspace: {e}"))?;
        let below = source
            .strip_prefix(&source_root)
            .map(Path::to_path_buf)
            .unwrap_or_default();
        source_root = canonical.clone();
        canonical.join(below)
    } else {
        source
    };
    crate::path_safety::reject_path_escape(&source, &source_root, "source")?;
    reject_symlink_parent_chain(&source, &source_root, "source")?;
    reject_symlink(&source, "source")?;
    Ok((source, dest))
}

/// Aggregate artifact operation kinds while keeping safe work available beside conflicts.
pub fn aggregate_operation_kind(kinds: &[OperationKind]) -> OperationKind {
    if kinds.is_empty() {
        return OperationKind::Unavailable;
    }
    let any = |wanted: OperationKind| kinds.contains(&wanted);
    // A surface that gains files and loses others (skills moving to another folder) differs from
    // its source; it is neither a plain removal nor a plain creation.
    if any(OperationKind::Update) || (any(OperationKind::Remove) && any(OperationKind::Create)) {
        return OperationKind::Update;
    }
    if any(OperationKind::Remove) {
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
#[cfg(test)]
pub fn detect_surface_state(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    home: &Path,
) -> (SetupSurfaceId, OperationKind, String) {
    match SkillSources::for_workspace(workspace_root) {
        Ok(sources) => detect_surface_state_with(surface, workspace_root, home, &sources),
        Err(message) => (
            surface,
            OperationKind::Unavailable,
            format!("{} unavailable: {message}", surface.label()),
        ),
    }
}

/// [`detect_surface_state`] with the sources already read, for a caller that looks at every
/// surface of one plan.
pub fn detect_surface_state_with(
    surface: SetupSurfaceId,
    workspace_root: &Path,
    home: &Path,
    sources: &SkillSources,
) -> (SetupSurfaceId, OperationKind, String) {
    let (kinds, conflict_reason, manual_count): (Vec<OperationKind>, Option<String>, usize) =
        match scope_for_surfaces(&[surface], home).and_then(|scope| {
            plan_artifacts_for_surfaces_with(&[surface], workspace_root, home, &scope, sources)
        }) {
            Ok(planned) if !planned.is_empty() => {
                // Why an MCP file is left alone, so the review says it beside the conflict.
                let reason = planned
                    .iter()
                    .filter(|p| p.kind == OperationKind::Conflict)
                    .find_map(|p| {
                        p.mcp
                            .and_then(|state| mcp_conflict_reason(state, &p.artifact))
                            .or_else(|| {
                                (p.artifact == ArtifactId::OpenCodeTui)
                                    .then(|| tui_conflict_reason(workspace_root, home))
                                    .flatten()
                            })
                            .or_else(|| {
                                (p.artifact == ArtifactId::OpenCodeConfig)
                                    .then(|| opencode_config_conflict_reason(workspace_root, home))
                                    .flatten()
                            })
                            .or_else(|| {
                                (p.artifact == ArtifactId::ClaudeSettings)
                                    .then(|| claude_settings_conflict_reason(workspace_root, home))
                                    .flatten()
                            })
                            .or_else(|| {
                                (p.artifact == ArtifactId::CodexConfig
                                    && crate::commands::codex_python().is_none())
                                .then(|| crate::commands::CODEX_PYTHON_REQUIRED.to_string())
                            })
                            .or_else(|| {
                                (p.artifact == ArtifactId::CodexConfig)
                                    .then(|| {
                                        crate::codex_config_keep::conflict_reason(
                                            workspace_root,
                                            home,
                                        )
                                    })
                                    .flatten()
                            })
                    });
                let manual = planned
                    .iter()
                    .filter(|p| p.kind == OperationKind::Manual)
                    .count();
                (planned.iter().map(|p| p.kind).collect(), reason, manual)
            }
            // The workspace folder holds no old copy of the bundle: nothing to do.
            Ok(_) if surface == SetupSurfaceId::WorkspaceBundle => {
                return (
                    surface,
                    OperationKind::NoChange,
                    format!("{}: no old copies to remove", surface.label()),
                );
            }
            // No harness is enabled: no skill is wanted anywhere, and nothing is removed.
            Ok(_) if surface.canonical() == SetupSurfaceId::Skills => {
                return (
                    surface,
                    OperationKind::NoChange,
                    format!("{}: no harness is enabled", surface.label()),
                );
            }
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
    if surface == SetupSurfaceId::WorkspaceBundle {
        let count = |wanted: OperationKind| kinds.iter().filter(|kind| **kind == wanted).count();
        let copies = |n: usize| format!("{n} old cop{}", if n == 1 { "y" } else { "ies" });
        let summary = match kind {
            OperationKind::Remove => format!(
                "{}: {} of the bundle to remove (backed up; z restores them)",
                surface.label(),
                copies(count(OperationKind::Remove))
            ),
            OperationKind::Manual => format!(
                "{}: {} of the bundle left in place",
                surface.label(),
                copies(count(OperationKind::Manual))
            ),
            OperationKind::NoChange => format!("{}: no old copies to remove", surface.label()),
            _ => format!("{} unavailable", surface.label()),
        };
        return (surface, kind, summary);
    }
    let summary = match kind {
        OperationKind::NoChange => format!("{} synced", surface.label()),
        OperationKind::Create => format!("{} not installed", surface.label()),
        OperationKind::Update => format!("{} differs from source", surface.label()),
        OperationKind::Conflict => match conflict_reason {
            Some(reason) => format!("{}: {reason}", surface.label()),
            None => format!("{} has conflicts", surface.label()),
        },
        // Skill and agent files the user keeps.
        OperationKind::Manual if crate::file_conflicts::is_files_surface(surface) => format!(
            "{}: you manage {manual_count} file{}; bundled updates are skipped",
            surface.label(),
            if manual_count == 1 { "" } else { "s" }
        ),
        // Attribution the user set themselves.
        OperationKind::Manual if surface == SetupSurfaceId::ClaudeConfig => format!(
            "{}: you set attribution yourself; left as is",
            surface.label()
        ),
        // A rules file the user chose to manage.
        OperationKind::Manual => format!(
            "{}: you manage this file; base updates are skipped",
            surface.label()
        ),
        OperationKind::Unavailable => format!("{} unavailable", surface.label()),
        OperationKind::Remove => format!("{} has old app files to remove", surface.label()),
    };
    (surface, kind, summary)
}

fn artifact_kind(artifact: &ArtifactId) -> ArtifactKind {
    match artifact {
        ArtifactId::WorkspaceFile(_) => ArtifactKind::RulesFile,
        ArtifactId::CodexLegacySkill(_) | ArtifactId::SkillFile(_) => ArtifactKind::SkillFile,
        ArtifactId::OpenCodeConfig | ArtifactId::CodexConfig => ArtifactKind::ConfigFile,
        ArtifactId::OpenCodeTui => ArtifactKind::TuiConfig,
        ArtifactId::ClaudeSettings => ArtifactKind::ClaudeSettings,
        ArtifactId::OpenCodePlaywrightMcp => ArtifactKind::McpConfig,
        ArtifactId::OpenCodeRules
        | ArtifactId::CodexRules
        | ArtifactId::ClaudeRules
        | ArtifactId::HarnessRules(_) => ArtifactKind::RulesFile,
        ArtifactId::OpenCodeAgent(_)
        | ArtifactId::CodexAgent(_)
        | ArtifactId::ClaudeAgent(_)
        | ArtifactId::CursorAgent(_) => ArtifactKind::AgentFile,
        ArtifactId::OpenCodeSkill(_)
        | ArtifactId::CodexSkill(_)
        | ArtifactId::ClaudeSkill(_)
        | ArtifactId::CursorSkill(_) => ArtifactKind::SkillFile,
        ArtifactId::CursorMcp | ArtifactId::HarnessMcp(_) => ArtifactKind::McpConfig,
    }
}

pub fn compute_plan_fingerprint(
    workspace_root: &Path,
    surfaces: &[SetupSurfaceId],
    artifact_ops: &[PlannedArtifact],
    home: &Path,
) -> Result<String, String> {
    let sources = SkillSources::for_workspace(workspace_root)?;
    compute_plan_fingerprint_with(workspace_root, surfaces, artifact_ops, home, &sources)
}

/// [`compute_plan_fingerprint`] with the sources the plan was made from.
pub fn compute_plan_fingerprint_with(
    workspace_root: &Path,
    surfaces: &[SetupSurfaceId],
    artifact_ops: &[PlannedArtifact],
    home: &Path,
    sources: &SkillSources,
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
        let planned_kind = artifact_ops
            .iter()
            .find(|operation| operation.artifact == *artifact)
            .map(|operation| operation.kind);
        let source_digest = if matches!(planned_kind, Some(OperationKind::Remove)) {
            crate::setup_fingerprint::ABSENT_DIGEST.to_string()
        } else if artifact
            .resolve_source(sources)
            .is_some_and(|source| source.exists())
        {
            // The Codex config's keys the user keeps are part of what the source side says.
            crate::setup_fingerprint::artifact_effective_source_digest(
                artifact,
                sources,
                workspace_root,
                home,
            )
            .map_err(|error| {
                format!("fingerprint source for {artifact:?} ({planned_kind:?}): {error}")
            })?
        } else {
            crate::setup_fingerprint::ABSENT_DIGEST.to_string()
        };
        parts.push(format!("source:{source_digest}"));
        // An old workspace copy left in place is never written, and may be a link the digest
        // refuses to follow. Its kind is fingerprinted: a copy that turns removable changes it.
        let installed_digest = if planned_kind == Some(OperationKind::Manual)
            && matches!(artifact, ArtifactId::WorkspaceFile(_))
        {
            "left-in-place".to_string()
        } else {
            crate::setup_fingerprint::artifact_installed_managed_digest(
                artifact,
                workspace_root,
                home,
            )?
        };
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

#[cfg(test)]
pub fn detect_artifact_state(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> (OperationKind, PreviousState) {
    match SkillSources::for_workspace(workspace_root) {
        Ok(sources) => detect_artifact_state_with(artifact, workspace_root, home, &sources),
        Err(_) => (OperationKind::Unavailable, PreviousState::Unavailable),
    }
}

/// [`detect_artifact_state`] with the sources already read, for a caller that looks at many
/// artifacts of one plan or apply.
pub fn detect_artifact_state_with(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    sources: &SkillSources,
) -> (OperationKind, PreviousState) {
    let dest = match artifact.resolve_dest(home, workspace_root) {
        Ok(p) => p,
        Err(_) => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };
    let bundled_root = sources.bundle().to_path_buf();
    if artifact == &ArtifactId::ClaudeSettings {
        // No bundled source; and no ownership record here, so values already in the file are
        // never the app's.
        return claude_settings_outcome(&dest, false);
    }
    let source = match artifact.resolve_source(sources) {
        Some(p) => p,
        None => return (OperationKind::Unavailable, PreviousState::Unavailable),
    };

    if reject_symlink(&dest, "destination").is_err() {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    if reject_symlink(&source, "source").is_err() {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    }

    if artifact.is_rules_block() {
        // Without a managed record only the exact outcomes are known: absent,
        // or a block that already carries the current base.
        let assessment = crate::pack_routing::rules_source_text(artifact, sources)
            .ok()
            .and_then(|source_text| assess_rules(artifact, &dest, &source_text, None));
        return match assessment {
            Some(assessment) => rules_outcome(assessment.plan),
            None => (OperationKind::Unavailable, PreviousState::Unavailable),
        };
    }

    match artifact_kind(artifact) {
        ArtifactKind::ConfigFile => {
            detect_config_artifact(artifact, &dest, &source, workspace_root, home)
        }
        ArtifactKind::TuiConfig => detect_tui_artifact(&dest, &source),
        // Answered above: the artifact has no source to resolve.
        ArtifactKind::ClaudeSettings => claude_settings_outcome(&dest, false),
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
        ArtifactKind::SkillFile => {
            if !source.is_file() {
                (OperationKind::Unavailable, PreviousState::Unavailable)
            } else if skill_destination_blocked(artifact, &dest, home, workspace_root) {
                (OperationKind::Conflict, PreviousState::Conflict)
            } else if !dest.is_file() {
                (OperationKind::Create, PreviousState::Absent)
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
        ArtifactKind::McpConfig if matches!(artifact, ArtifactId::HarnessMcp(_)) => {
            use crate::light_mcp::EntryState;
            match harness_mcp_state(artifact, workspace_root, &bundled_root, home) {
                None => (OperationKind::Unavailable, PreviousState::Unavailable),
                Some(EntryState::Absent) => (OperationKind::Create, PreviousState::Absent),
                // The merge rewrites only the managed entry and keeps every other server.
                Some(EntryState::EntryMissing | EntryState::Differs) => {
                    (OperationKind::Update, PreviousState::MergeableConfigFile)
                }
                Some(EntryState::Equal) => {
                    (OperationKind::NoChange, PreviousState::MergeableConfigFile)
                }
                Some(EntryState::Refused(_)) => (OperationKind::Conflict, PreviousState::Conflict),
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
            // entry and preserves every other server, so divergence, and a
            // file that has other servers but no playwright entry yet, are
            // mergeable rather than whole-file ownership.
            match status.as_str() {
                "synced" => (OperationKind::NoChange, PreviousState::MergeableConfigFile),
                "missing" => (OperationKind::Create, PreviousState::Absent),
                "diverged" | "partial" => {
                    (OperationKind::Update, PreviousState::MergeableConfigFile)
                }
                _ => (OperationKind::Unavailable, PreviousState::Unavailable),
            }
        }
    }
}

/// Whether something already on disk keeps a skill file from being written or removed: a symlink
/// in the folders above it (a symlinked skills root included), a destination that is not a
/// regular file, or a file where one of its directories must be. Such a file is preserved as a
/// conflict at plan time; apply would otherwise fail on it and roll the whole transaction back.
fn skill_destination_blocked(
    artifact: &ArtifactId,
    dest: &Path,
    home: &Path,
    workspace_root: &Path,
) -> bool {
    let Ok(root) = artifact.allowlist_root(home, workspace_root) else {
        return true;
    };
    if reject_symlink_parent_chain(dest, &root, "destination").is_err() {
        return true;
    }
    if fs::symlink_metadata(dest).is_ok_and(|meta| !meta.is_file()) {
        return true;
    }
    let mut ancestor = dest.parent();
    while let Some(dir) = ancestor {
        if dir == root || !dir.starts_with(&root) {
            break;
        }
        if fs::symlink_metadata(dir).is_ok_and(|meta| !meta.is_dir()) {
            return true;
        }
        ancestor = dir.parent();
    }
    false
}

/// Classify a rules artifact's installed file against its source text (the bundled base with the
/// packs' routing, see [`crate::pack_routing::rules_source_text`]).
fn assess_rules(
    artifact: &ArtifactId,
    dest: &Path,
    source_text: &str,
    managed_hash: Option<&str>,
) -> Option<crate::rules_block::RulesAssessment> {
    use crate::rules_block::{MalformedReason, RulesAssessment, RulesConflict, RulesLayout};
    let unusable = |reason| {
        Some(RulesAssessment {
            plan: crate::rules_block::RulesPlan::Conflict(RulesConflict::MalformedMarkers),
            layout: RulesLayout::Malformed,
            malformed: Some(reason),
            refinement_lines: 0,
        })
    };
    let installed = match fs::symlink_metadata(dest) {
        Ok(meta) if meta.len() > crate::rules_block::MAX_RULES_FILE_BYTES => {
            return unusable(MalformedReason::TooLarge);
        }
        Ok(_) => match fs::read(dest) {
            Ok(bytes) => Some(bytes),
            // Present but unreadable (a directory, no permission): never replaced.
            Err(_) => return unusable(MalformedReason::NotUtf8),
        },
        Err(_) => None,
    };
    let mut assessment =
        crate::rules_block::assess(installed.as_deref(), source_text, managed_hash, &|digest| {
            crate::managed_bootstrap::approved_rules_base_digest(artifact, digest)
        });
    // A file in the same folder can keep the harness from reading the block at all; writing
    // would then change nothing the harness sees (a masking override) or hide the user's own
    // context file (a peer), so the plan is a conflict whatever the file itself holds.
    if let ArtifactId::HarnessRules(harness) = artifact {
        if let Some(conflict) = harness.rules().and_then(|rules| rules.preflight(dest)) {
            assessment.plan = crate::rules_block::RulesPlan::Conflict(conflict);
        }
    }
    // A harness that reads only so many bytes of the file (Antigravity) would miss the end of a
    // longer one: the app then writes nothing.
    if let ArtifactId::HarnessRules(harness) = artifact {
        let written = rendered_rules(assessment.plan, installed.as_deref(), source_text);
        if let (Some(rules), Some(written)) = (harness.rules(), written) {
            if !rules.fits(written.len()) {
                assessment.plan =
                    crate::rules_block::RulesPlan::Conflict(RulesConflict::ExceedsHarnessLimit);
            }
        }
    }
    Some(assessment)
}

/// The file a writing rules plan produces; `None` for a plan that writes nothing.
fn rendered_rules(
    plan: crate::rules_block::RulesPlan,
    installed: Option<&[u8]>,
    source_text: &str,
) -> Option<String> {
    use crate::rules_block::RulesPlan;
    match plan {
        RulesPlan::Create | RulesPlan::WrapLegacy => {
            Some(crate::rules_block::render_new(source_text))
        }
        RulesPlan::UpdateBlock => crate::rules_block::parse_bytes(installed?)
            .ok()
            .flatten()
            .map(|file| file.render_with_body(source_text)),
        RulesPlan::NoChange | RulesPlan::Conflict(_) => None,
    }
}

/// The state of the managed entry in the MCP file of a light harness. `None` when the
/// descriptor, the destination or the bundled entry cannot be used.
fn harness_mcp_state(
    artifact: &ArtifactId,
    workspace_root: &Path,
    bundled_root: &Path,
    home: &Path,
) -> Option<crate::light_mcp::EntryState> {
    let ArtifactId::HarnessMcp(harness) = artifact else {
        return None;
    };
    let spec = harness.mcp()?;
    let dest = artifact.resolve_dest(home, workspace_root).ok()?;
    let source = artifact.resolve_bundle_source(bundled_root)?;
    reject_symlink(&source, "source").ok()?;
    let expected = crate::light_mcp::expected_entry(spec, bundled_root, home).ok()?;
    // A symlink or anything else that is not a regular file is refused by the read itself.
    Some(crate::light_mcp::assess(spec, &dest, &expected))
}

/// Whether `~/.cursor/mcp.json` holds a `playwright` entry that differs from the app's (not one
/// that is missing): the merge would replace it.
fn cursor_mcp_entry_differs(artifact: &ArtifactId, bundled_root: &Path) -> bool {
    *artifact == ArtifactId::CursorMcp
        && crate::cursor_profile_paths::resolve_cursor_profile_paths().is_ok_and(|paths| {
            crate::cursor_profile_ops::mcp_diff_status(bundled_root, &paths) == "diverged"
        })
}

/// One MCP entry planned as an operation.
struct McpPlan {
    state: Option<crate::light_mcp::EntryState>,
    kind: OperationKind,
    previous_state: PreviousState,
}

/// Plans the managed entry of a light harness's MCP file, or the attribution values of Claude's
/// `settings.json`; `None` for any other artifact.
///
/// A file without the entry is merged into (never created over, so a rollback cannot delete the
/// user's file). An entry of that name that differs is the user's own unless a record proves the
/// app wrote it, and then only while it is still what the app wrote: otherwise it is a conflict,
/// and so is a file the app does not edit (comments, trailing comma, byte order mark, ...).
fn plan_mcp_artifact(
    artifact: &ArtifactId,
    workspace_root: &Path,
    bundled_root: &Path,
    home: &Path,
    managed_hash: Option<&str>,
) -> Option<McpPlan> {
    use crate::light_mcp::EntryState;
    if artifact == &ArtifactId::ClaudeSettings {
        return Some(plan_claude_settings(
            artifact,
            workspace_root,
            bundled_root,
            home,
            managed_hash,
        ));
    }
    if !matches!(artifact, ArtifactId::HarnessMcp(_)) {
        return None;
    }
    let Some(state) = harness_mcp_state(artifact, workspace_root, bundled_root, home) else {
        return Some(McpPlan {
            state: None,
            kind: OperationKind::Unavailable,
            previous_state: PreviousState::Unavailable,
        });
    };
    let (kind, previous_state) = match state {
        EntryState::Absent => (OperationKind::Create, PreviousState::Absent),
        EntryState::EntryMissing => (OperationKind::Update, PreviousState::MergeableConfigFile),
        EntryState::Equal => (OperationKind::NoChange, PreviousState::MergeableConfigFile),
        EntryState::Differs if managed_hash.is_some() => refine_with_managed_hash(
            OperationKind::Update,
            PreviousState::MergeableConfigFile,
            artifact,
            workspace_root,
            &crate::skill_sources::BundleOnly(bundled_root),
            home,
            managed_hash,
        ),
        EntryState::Differs | EntryState::Refused(_) => {
            (OperationKind::Conflict, PreviousState::Conflict)
        }
    };
    Some(McpPlan {
        state: Some(state),
        kind,
        previous_state,
    })
}

/// The key the app manages in the MCP file of `artifact`, for messages.
pub(crate) fn mcp_entry_key(artifact: &ArtifactId) -> &'static str {
    match artifact {
        ArtifactId::HarnessMcp(harness) => harness
            .mcp()
            .map_or("playwright", |mcp| mcp.entry_key.as_str()),
        _ => "playwright",
    }
}

/// Why the MCP file of `artifact` is left alone in `state`, for messages: fixed phrases only.
pub(crate) fn mcp_conflict_reason(
    state: crate::light_mcp::EntryState,
    artifact: &ArtifactId,
) -> Option<String> {
    let format = match artifact {
        ArtifactId::HarnessMcp(harness) => harness.mcp().map(|mcp| mcp.format),
        _ => None,
    };
    state.conflict_reason(mcp_entry_key(artifact), format.unwrap_or_default())
}

/// Re-checks, at apply time, that an MCP file may still be written: the plan came from an
/// earlier read, and a file the app does not edit, or an entry of the user's own, must never be
/// replaced.
pub fn ensure_mcp_apply_allowed(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let managed = crate::managed_state::read_managed_state(workspace_root);
    let records = records_with_bootstrap(workspace_root, home, managed.as_ref());
    let identity = crate::managed_state::artifact_identity(artifact);
    let managed_hash = managed_hash_for(&identity, &records);
    let bundled_root = crate::setup_roots::bundled_root_for(workspace_root)?;
    let plan = plan_mcp_artifact(
        artifact,
        workspace_root,
        &bundled_root,
        home,
        managed_hash.as_deref(),
    )
    .ok_or_else(|| "not an MCP entry".to_string())?;
    match (plan.kind, plan.state) {
        (OperationKind::Unavailable, _) => {
            Err("the MCP entry or its file is unavailable; nothing written".to_string())
        }
        (OperationKind::Conflict, state) => Err(format!(
            "refusing to change the MCP file: {}",
            state
                .and_then(|state| mcp_conflict_reason(state, artifact))
                .unwrap_or_else(|| "it has a conflict".to_string())
        )),
        _ => Ok(()),
    }
}

/// Block classification for the plan, or `None` for non-rules artifacts and
/// rules artifacts whose source or destination cannot be used.
fn plan_rules_artifact(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    managed_hash: Option<&str>,
    sources: &SkillSources,
) -> Option<crate::rules_block::RulesAssessment> {
    if !artifact.is_rules_block() {
        return None;
    }
    let dest = artifact.resolve_dest(home, workspace_root).ok()?;
    if reject_symlink(&dest, "destination").is_err() {
        return None;
    }
    let source_text = crate::pack_routing::rules_source_text(artifact, sources).ok()?;
    assess_rules(artifact, &dest, &source_text, managed_hash)
}

/// Conflicts the user may resolve by converting the file onto the base block.
/// Malformed markers are never rewritten: the file is not understood.
pub fn is_convertible(plan: crate::rules_block::RulesPlan) -> bool {
    use crate::rules_block::{RulesConflict, RulesPlan};
    matches!(
        plan,
        RulesPlan::Conflict(RulesConflict::LegacyDiverged | RulesConflict::BaseBlockEdited)
    )
}

/// Installed state and classification of a rules artifact, for previews and
/// explicit conversion.
pub struct RulesContext {
    pub source_text: String,
    pub bundled_root: PathBuf,
    pub installed: Option<Vec<u8>>,
    pub assessment: crate::rules_block::RulesAssessment,
}

pub fn rules_context(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<RulesContext, String> {
    if !artifact.is_rules_block() {
        return Err("not a rules artifact".to_string());
    }
    let managed = crate::managed_state::read_managed_state(workspace_root);
    let records = records_with_bootstrap(workspace_root, home, managed.as_ref());
    let identity = crate::managed_state::artifact_identity(artifact);
    let managed_hash = managed_hash_for(&identity, &records);
    let sources = SkillSources::for_workspace(workspace_root)?;
    let assessment = plan_rules_artifact(
        artifact,
        workspace_root,
        home,
        managed_hash.as_deref(),
        &sources,
    )
    .ok_or_else(|| "rules source or destination is unavailable".to_string())?;
    let bundled_root = sources.bundle().to_path_buf();
    let source_text = crate::pack_routing::rules_source_text(artifact, &sources)?;
    let dest = artifact.resolve_dest(home, workspace_root)?;
    let installed = match fs::symlink_metadata(&dest) {
        Ok(meta) if meta.len() > crate::rules_block::MAX_RULES_FILE_BYTES => {
            return Err("rules file is too large".to_string());
        }
        Ok(_) => Some(fs::read(&dest).map_err(|e| format!("read rules file: {e}"))?),
        Err(_) => None,
    };
    Ok(RulesContext {
        source_text,
        bundled_root,
        installed,
        assessment,
    })
}

/// The transaction operation for converting a rules file with `rewrite`.
pub fn conversion_operation(
    artifact: &ArtifactId,
    assessment: crate::rules_block::RulesAssessment,
    rewrite: RulesRewrite,
) -> PlannedArtifact {
    PlannedArtifact {
        artifact: artifact.clone(),
        surface: artifact.surface(),
        kind: OperationKind::Update,
        previous_state: PreviousState::ManagedFile,
        rollback_action: rollback_action_for(OperationKind::Update, PreviousState::ManagedFile),
        rules: Some(assessment),
        rules_rewrite: Some(rewrite),
        mcp: None,
        file: None,
        overwrite: None,
    }
}

/// Fingerprint of an explicit rules conversion: the regular plan fingerprint
/// plus the exact content to be written.
pub fn conversion_fingerprint(
    workspace_root: &Path,
    home: &Path,
    operation: &PlannedArtifact,
) -> Result<String, String> {
    let rewrite = operation
        .rules_rewrite
        .as_ref()
        .ok_or_else(|| "conversion without content".to_string())?;
    let base = compute_plan_fingerprint(
        workspace_root,
        &[operation.surface],
        std::slice::from_ref(operation),
        home,
    )?;
    stable_fingerprint(&[
        base,
        rewrite.expected_installed_digest.clone(),
        crate::stable_digest::bytes(rewrite.content.as_bytes()),
    ])
}

/// Why no unit of that key can be replaced; a fixed phrase, never file text.
const TAKE_BUNDLED_UNKNOWN: &str = "this skill or agent has no conflicting or kept files right now";

/// The operations that replace the files of these units by the bundled ones, from a fresh plan of
/// `surface`. See [`take_bundled_operations`].
pub fn plan_take_bundled(
    surface: SetupSurfaceId,
    unit_keys: &[String],
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<PlannedArtifact>, String> {
    let planned = plan_artifacts_for_surfaces(&[surface], workspace_root, home)?;
    take_bundled_operations(&planned, surface, unit_keys, workspace_root, home)
}

/// The operations that replace the files of these units by the bundled ones, taken from `planned`
/// (a plan of `surface`).
///
/// Only the currently resolvable files of the named units are selected: files in conflict, and
/// files the user keeps. Everything else in the plan (other conflicts, other safe updates) is left
/// out, so exactly the chosen files are written. The request fails closed: a unit that is unknown,
/// no longer a conflict, blocked by a link or a folder, or not wanted in its folder is an error and
/// nothing is selected. Each operation is an `Update` of a managed file (so it is backed up, rolled
/// back and recorded like any update) carrying the digest of the file as it is now.
pub fn take_bundled_operations(
    planned: &[PlannedArtifact],
    surface: SetupSurfaceId,
    unit_keys: &[String],
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<PlannedArtifact>, String> {
    if !crate::file_conflicts::is_files_surface(surface) {
        return Err(format!("{} has no skill or agent files", surface.label()));
    }
    if unit_keys.is_empty() {
        return Err("name at least one skill or agent".to_string());
    }
    let units = crate::file_conflicts::units(planned);
    let mut seen = HashSet::new();
    let mut operations = Vec::new();
    for key in unit_keys.iter().filter(|key| seen.insert(key.as_str())) {
        let unit = units
            .iter()
            .find(|candidate| &candidate.key == key)
            .ok_or_else(|| TAKE_BUNDLED_UNKNOWN.to_string())?;
        if !unit.wanted {
            return Err("no bundled copy is wanted in this folder".to_string());
        }
        for operation in &unit.files {
            let resolvable = operation.file.is_some_and(|file| file.wanted)
                && matches!(
                    operation.kind,
                    OperationKind::Conflict | OperationKind::Manual
                )
                && crate::kept_files::is_keepable(&operation.artifact);
            if !resolvable {
                return Err(TAKE_BUNDLED_UNKNOWN.to_string());
            }
            let (source, dest) =
                validate_artifact_source_dest(&operation.artifact, workspace_root, home)
                    .map_err(|_| BLOCKED_FILE.to_string())?;
            if skill_destination_blocked(&operation.artifact, &dest, home, workspace_root)
                || !dest.is_file()
                || !source.is_file()
            {
                return Err(BLOCKED_FILE.to_string());
            }
            // The backup reads the whole file into memory, and the file is the user's: bound it.
            let size = fs::metadata(&dest)
                .map_err(|e| format!("read {}: {e}", dest.display()))?
                .len();
            if size > MAX_REPLACED_FILE_BYTES {
                return Err(
                    "a file is too large to back up here; nothing can be replaced".to_string(),
                );
            }
            let installed = crate::stable_digest::file(&dest)?;
            if crate::stable_digest::file(&source)? == installed {
                // Already the bundled file: there is nothing to replace.
                return Err(TAKE_BUNDLED_UNKNOWN.to_string());
            }
            operations.push(PlannedArtifact {
                artifact: operation.artifact.clone(),
                surface: operation.surface,
                kind: OperationKind::Update,
                previous_state: PreviousState::ManagedFile,
                rollback_action: rollback_action_for(
                    OperationKind::Update,
                    PreviousState::ManagedFile,
                ),
                rules: None,
                rules_rewrite: None,
                mcp: None,
                // Kept for the fingerprint: keeping or handing back after the preview makes it stale.
                file: operation.file,
                overwrite: Some(Overwrite {
                    expected_installed_digest: installed,
                }),
            });
        }
    }
    Ok(operations)
}

const BLOCKED_FILE: &str = "a link or folder is in the way; nothing can be replaced here";
/// Largest installed file a take bundled replaces (it is backed up first).
const MAX_REPLACED_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Fingerprint of a take-bundled request: the regular plan fingerprint of the operations plus, for
/// every file, the exact digest of the installed file the user reviewed and whether they keep it.
/// An edit of a file, or keeping or handing back one, after the preview therefore changes it.
pub fn overwrite_fingerprint(
    workspace_root: &Path,
    home: &Path,
    operations: &[PlannedArtifact],
) -> Result<String, String> {
    if operations.is_empty() {
        return Err("take bundled without files".to_string());
    }
    let mut surfaces: Vec<SetupSurfaceId> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for operation in operations {
        let overwrite = operation
            .overwrite
            .as_ref()
            .ok_or_else(|| "take bundled without a reviewed file".to_string())?;
        if !surfaces.contains(&operation.surface) {
            surfaces.push(operation.surface);
        }
        let kept = operation.file.is_some_and(|file| file.kept.is_some());
        files.push(format!(
            "{}={}:{}",
            crate::managed_state::artifact_identity(&operation.artifact),
            overwrite.expected_installed_digest,
            if kept { "kept" } else { "conflict" }
        ));
    }
    files.sort();
    let mut parts = vec![
        compute_plan_fingerprint(workspace_root, &surfaces, operations, home)?,
        "take_bundled".to_string(),
    ];
    parts.extend(files);
    stable_fingerprint(&parts)
}

/// Re-checks, at write time, that a file may still be replaced by the bundled one: it is a skill
/// or agent file, a regular file with no link in its path, and still the bytes the user reviewed.
/// The plan came from an earlier read, and an edit made since must never be overwritten.
pub fn ensure_overwrite_allowed(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    overwrite: &Overwrite,
) -> Result<(), String> {
    if !crate::kept_files::is_keepable(artifact) {
        return Err("only a skill or agent file can be replaced by the bundled one".to_string());
    }
    let dest = artifact.resolve_dest(home, workspace_root)?;
    if skill_destination_blocked(artifact, &dest, home, workspace_root) || !dest.is_file() {
        return Err(BLOCKED_FILE.to_string());
    }
    if crate::stable_digest::file(&dest)? != overwrite.expected_installed_digest {
        return Err("file changed since preview; preview again".to_string());
    }
    Ok(())
}

/// Re-checks, at apply time, that a rules file may still be written: the plan
/// came from an earlier read, and a diverged or malformed file must never be
/// replaced.
pub fn ensure_rules_apply_allowed(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    sources: &SkillSources,
) -> Result<(), String> {
    let managed = crate::managed_state::read_managed_state(workspace_root);
    let records = records_with_bootstrap(workspace_root, home, managed.as_ref());
    let identity = crate::managed_state::artifact_identity(artifact);
    let managed_hash = managed_hash_for(&identity, &records);
    let assessment = plan_rules_artifact(
        artifact,
        workspace_root,
        home,
        managed_hash.as_deref(),
        sources,
    )
    .ok_or_else(|| "rules source or destination is unavailable".to_string())?;
    match assessment.plan {
        crate::rules_block::RulesPlan::Conflict(conflict) => Err(format!(
            "refusing to change rules file: {}",
            conflict.message()
        )),
        _ => Ok(()),
    }
}

fn rules_outcome(plan: crate::rules_block::RulesPlan) -> (OperationKind, PreviousState) {
    use crate::rules_block::RulesPlan;
    match plan {
        RulesPlan::Create => (OperationKind::Create, PreviousState::Absent),
        RulesPlan::NoChange => (OperationKind::NoChange, PreviousState::MergeableConfigFile),
        // Only the block body changes; the user's text around it is merged.
        RulesPlan::UpdateBlock => (OperationKind::Update, PreviousState::MergeableConfigFile),
        // A pristine pre-block file is replaced whole after a full backup.
        RulesPlan::WrapLegacy => (OperationKind::Update, PreviousState::ManagedFile),
        RulesPlan::Conflict(_) => (OperationKind::Conflict, PreviousState::Conflict),
    }
}

fn detect_config_artifact(
    artifact: &ArtifactId,
    dest: &Path,
    source: &Path,
    workspace_root: &Path,
    home: &Path,
) -> (OperationKind, PreviousState) {
    if !dest.exists() {
        return (OperationKind::Create, PreviousState::Absent);
    }
    if !source.exists() {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    }
    if artifact == &ArtifactId::CodexConfig {
        let installed_str =
            match crate::setup_fingerprint::read_user_config(dest, "Codex config.toml") {
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
        // The keys the user keeps match as they are installed; the others follow the template.
        let effective = crate::codex_config_keep::assess(
            Some(workspace_root),
            home,
            &installed_toml,
            &source_toml,
        )
        .effective;
        if crate::commands::managed_codex_keys_match(&installed_toml, &effective) {
            (OperationKind::NoChange, PreviousState::MergeableConfigFile)
        } else {
            (OperationKind::Update, PreviousState::MergeableConfigFile)
        }
    } else if artifact == &ArtifactId::OpenCodeConfig {
        let installed_str =
            match crate::setup_fingerprint::read_user_config(dest, "OpenCode opencode.json") {
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
        // The user's own role models are theirs: no drift, and an install keeps them.
        let app = crate::commands::AppRoleModels::load(Some(workspace_root), home);
        if crate::commands::managed_opencode_keys_match(
            &crate::commands::without_user_role_models(&installed_json, &app),
            &rendered,
        ) {
            (OperationKind::NoChange, PreviousState::MergeableConfigFile)
        } else {
            (OperationKind::Update, PreviousState::MergeableConfigFile)
        }
    } else {
        (OperationKind::Unavailable, PreviousState::Unavailable)
    }
}

/// `tui.json` is merge-managed: only the managed keys are compared, and a file the app does not
/// edit (comments, invalid JSON, ...) is a conflict that is never written.
fn detect_tui_artifact(dest: &Path, source: &Path) -> (OperationKind, PreviousState) {
    use crate::opencode_tui::Assessment;
    let (Ok(keys), Ok(template)) = (
        crate::opencode_tui::managed_keys(),
        crate::opencode_tui::bundled(source),
    ) else {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    };
    match crate::opencode_tui::assess(dest, &template, keys) {
        Assessment::Absent => (OperationKind::Create, PreviousState::Absent),
        Assessment::Synced => (OperationKind::NoChange, PreviousState::MergeableConfigFile),
        Assessment::Differs(_) => (OperationKind::Update, PreviousState::MergeableConfigFile),
        Assessment::Refused(_) => (OperationKind::Conflict, PreviousState::Conflict),
    }
}

/// Why `tui.json` is left alone, for the review: the file is not strict JSON, or a managed key
/// was changed after the app wrote it. Only fixed phrases and managed key names.
fn tui_conflict_reason(workspace_root: &Path, home: &Path) -> Option<String> {
    use crate::opencode_tui::Assessment;
    let artifact = ArtifactId::OpenCodeTui;
    let dest = artifact.resolve_dest(home, workspace_root).ok()?;
    let bundled_root = crate::setup_roots::bundled_root_for(workspace_root).ok()?;
    let template =
        crate::opencode_tui::bundled(&artifact.resolve_bundle_source(&bundled_root)?).ok()?;
    match crate::opencode_tui::assess(&dest, &template, crate::opencode_tui::managed_keys().ok()?) {
        Assessment::Refused(refusal) => Some(crate::opencode_tui::refusal_reason(refusal)),
        Assessment::Differs(keys) => Some(format!(
            "tui.json: {} changed since the app wrote it; the file is left as is",
            keys.join(", ")
        )),
        Assessment::Absent | Assessment::Synced => None,
    }
}

/// What `settings.json` plans to. `owned` is whether an ownership record proves that the app
/// wrote the values already in the file: a user's own `""` is theirs, however it looks.
fn claude_settings_outcome(dest: &Path, owned: bool) -> (OperationKind, PreviousState) {
    use crate::claude_settings::Assessment;
    if crate::claude_settings::config_dir_override() {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    match crate::claude_settings::assess(dest) {
        Assessment::Absent => (OperationKind::Create, PreviousState::Absent),
        Assessment::Missing => (OperationKind::Update, PreviousState::MergeableConfigFile),
        Assessment::Hidden if owned => {
            (OperationKind::NoChange, PreviousState::MergeableConfigFile)
        }
        // The user's own choice is never written, and never recorded as the app's.
        Assessment::Hidden | Assessment::UserSet => {
            (OperationKind::Manual, PreviousState::MergeableConfigFile)
        }
        Assessment::UnexpectedType | Assessment::Refused(_) => {
            (OperationKind::Conflict, PreviousState::Conflict)
        }
    }
}

/// Plans `settings.json`. The record owns the values only while they are still what the app
/// wrote (the constant projection).
fn plan_claude_settings(
    artifact: &ArtifactId,
    workspace_root: &Path,
    bundled_root: &Path,
    home: &Path,
    managed_hash: Option<&str>,
) -> McpPlan {
    let Ok(dest) = artifact.resolve_dest(home, workspace_root) else {
        return McpPlan {
            state: None,
            kind: OperationKind::Unavailable,
            previous_state: PreviousState::Unavailable,
        };
    };
    let owned = managed_hash.is_some_and(|hash| {
        crate::setup_fingerprint::artifact_source_digest(
            artifact,
            &crate::skill_sources::BundleOnly(bundled_root),
            home,
        )
        .is_ok_and(|expected| expected == hash)
    });
    let (kind, previous_state) = claude_settings_outcome(&dest, owned);
    McpPlan {
        state: None,
        kind,
        previous_state,
    }
}

/// Why `settings.json` is left alone, for the review: `CLAUDE_CONFIG_DIR` is set, the file is not
/// strict JSON, or `attribution` has a type nobody writes. Only fixed phrases.
pub(crate) fn claude_settings_conflict_reason(
    workspace_root: &Path,
    home: &Path,
) -> Option<String> {
    if crate::claude_settings::config_dir_override() {
        return Some(crate::claude_settings::CONFIG_DIR_REASON.to_string());
    }
    let dest = ArtifactId::ClaudeSettings
        .resolve_dest(home, workspace_root)
        .ok()?;
    crate::claude_settings::conflict_reason(&crate::claude_settings::assess(&dest))
}

/// Why `opencode.json` is left alone, for the review, when its text is the reason: it has
/// comments, trailing commas or a byte order mark (JSONC, which OpenCode reads but the app does
/// not write), or it is not JSON at all. Only fixed phrases and file names.
fn opencode_config_conflict_reason(workspace_root: &Path, home: &Path) -> Option<String> {
    let dest = ArtifactId::OpenCodeConfig
        .resolve_dest(home, workspace_root)
        .ok()?;
    crate::opencode_precedence::conflict_reason(&dest)
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

/// [`managed_hash_for`], and for a skill file without a record of its own the record of the same
/// file under another case: on a case-insensitive volume (APFS by default) a case-only rename
/// (`Notes.md` to `notes.md`) finds the installed file, which the app owns.
fn managed_hash_for_artifact(
    artifact: &ArtifactId,
    identity: &str,
    records: &[crate::managed_state::ManagedArtifactRecord],
) -> Option<String> {
    managed_hash_for(identity, records).or_else(|| {
        let file = artifact.as_skill_file()?;
        records
            .iter()
            .find(|record| {
                record.identity.eq_ignore_ascii_case(identity)
                    && crate::managed_bootstrap::artifact_from_identity(&record.identity)
                        .ok()
                        .and_then(|other| other.as_skill_file())
                        .is_some_and(|other| file.same_file_ignoring_case(&other))
            })
            .map(|record| record.hash.clone())
    })
}

fn detect_stale_artifact_state<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    workspace_root: &Path,
    sources: &R,
    home: &Path,
    managed_hash: Option<&str>,
) -> (OperationKind, PreviousState) {
    if matches!(artifact, ArtifactId::WorkspaceFile(_)) {
        return detect_retired_workspace_copy_state(
            artifact,
            workspace_root,
            sources.bundle(),
            home,
            managed_hash,
        );
    }
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
    if artifact.is_skill_file() && skill_destination_blocked(artifact, &dest, home, workspace_root)
    {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    let installed = match crate::setup_fingerprint::artifact_installed_managed_digest(
        artifact,
        workspace_root,
        home,
    ) {
        Ok(d) => d,
        Err(_) => return (OperationKind::Conflict, PreviousState::Conflict),
    };
    // Byte-for-byte a version the app shipped is as good as a recorded hash.
    let shipped = crate::shipped_digests::is_shipped_version(artifact, sources, &installed);
    if managed_hash.is_none() && !shipped {
        return (OperationKind::Conflict, PreviousState::Conflict);
    }
    if managed_hash == Some(installed.as_str()) || shipped {
        (OperationKind::Remove, PreviousState::ManagedFile)
    } else {
        (OperationKind::Conflict, PreviousState::Conflict)
    }
}

/// A file in the workspace folder that is no longer wanted: an old copy of the bundle, or a file an
/// older release left there. One the app provably wrote (see
/// [`crate::managed_bootstrap::retired_workspace_copy_owned`]) is removed. Anything else is left
/// in place as a manual step, never a conflict: an edited copy, a file nothing proves the app's, a
/// link on the file or on a folder above it, a folder where the file was. The app no longer reads
/// any of them, so nothing waits for the user to resolve.
fn detect_retired_workspace_copy_state(
    artifact: &ArtifactId,
    workspace_root: &Path,
    bundled_root: &Path,
    home: &Path,
    managed_hash: Option<&str>,
) -> (OperationKind, PreviousState) {
    let left_in_place = (OperationKind::Manual, PreviousState::Conflict);
    let Ok(dest) = artifact.resolve_dest(home, workspace_root) else {
        return (OperationKind::Unavailable, PreviousState::Unavailable);
    };
    let meta = match fs::symlink_metadata(&dest) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (OperationKind::NoChange, PreviousState::Absent);
        }
        Err(_) => return left_in_place,
    };
    if !meta.is_file()
        || reject_symlink_parent_chain(&dest, workspace_root, "workspace copy").is_err()
    {
        return left_in_place;
    }
    let Ok(installed) =
        crate::setup_fingerprint::artifact_installed_managed_digest(artifact, workspace_root, home)
    else {
        return left_in_place;
    };
    if crate::managed_bootstrap::retired_workspace_copy_owned(
        artifact,
        bundled_root,
        &installed,
        managed_hash,
    ) {
        (OperationKind::Remove, PreviousState::ManagedFile)
    } else {
        left_in_place
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
    let records = records_with_bootstrap(workspace_root, home, managed.as_ref());
    let sources = SkillSources::for_workspace(workspace_root)?;

    // Uninstall sees every root: copies in folders a harness no longer needs are the app's too.
    let scope = SkillScope::all();
    let artifacts =
        expand_surfaces_to_artifacts_with(SetupSurfaceId::ALL, workspace_root, &scope, &sources)?;
    let mut removals = Vec::new();
    let mut preserved = Vec::new();
    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // Two skill roots can be one folder (an environment variable names another root); the file is
    // removed once.
    let mut skill_destinations: HashSet<PathBuf> = HashSet::new();
    for artifact in artifacts {
        let identity = crate::managed_state::artifact_identity(&artifact);
        seen.insert(identity.clone());
        if artifact.is_skill_file()
            && artifact
                .resolve_dest(home, workspace_root)
                .is_ok_and(|dest| !skill_destinations.insert(dest))
        {
            continue;
        }
        if matches!(
            artifact_kind(&artifact),
            ArtifactKind::ConfigFile
                | ArtifactKind::TuiConfig
                | ArtifactKind::McpConfig
                | ArtifactKind::ClaudeSettings
        ) {
            // Managed keys were merged into a user-owned file; deleting the
            // file would destroy user content.
            let exists = artifact
                .resolve_dest(home, workspace_root)
                .map(|dest| dest.is_file())
                .unwrap_or(false);
            if exists && holds_managed_entry(&artifact, home, workspace_root) {
                merged.push(artifact);
            }
            continue;
        }
        if rules_block_has_user_content(&artifact, workspace_root, home) {
            // The file holds the user's own text beside the base block;
            // deleting it would destroy that content.
            merged.push(artifact);
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
        // The current source is the bundle every install copies from, never the workspace copy.
        let source =
            crate::setup_fingerprint::artifact_source_digest(&artifact, &sources, home).ok();
        let managed_hash = managed_hash_for(&identity, &records);
        let owned = managed_hash.as_deref() == Some(installed.as_str())
            || source.as_deref() == Some(installed.as_str())
            || crate::shipped_digests::is_shipped_version(&artifact, &sources, &installed);
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
                rules: None,
                rules_rewrite: None,
                mcp: None,
                file: None,
                overwrite: None,
            });
        } else {
            preserved.push(artifact);
        }
    }

    // Stale app-owned files from older versions are part of the install too.
    let canonical_identities =
        crate::managed_state::canonical_artifact_identities(&sources, &scope).unwrap_or_default();
    let stale = crate::managed_bootstrap::collect_stale_removal_artifacts(
        workspace_root,
        home,
        &records,
        &canonical_identities,
        &scope,
    )?;
    let handled_destinations: HashSet<PathBuf> = removals
        .iter()
        .map(|operation| &operation.artifact)
        .chain(preserved.iter())
        .chain(merged.iter())
        .filter_map(|artifact| artifact.resolve_dest(home, workspace_root).ok())
        .collect();
    for artifact in stale {
        let identity = crate::managed_state::artifact_identity(&artifact);
        if !seen.insert(identity.clone())
            || artifact
                .resolve_dest(home, workspace_root)
                .is_ok_and(|dest| handled_destinations.contains(&dest))
        {
            continue;
        }
        let managed_hash = managed_hash_for(&identity, &records);
        let (kind, previous_state) = detect_stale_artifact_state(
            &artifact,
            workspace_root,
            &sources,
            home,
            managed_hash.as_deref(),
        );
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
                    rules: None,
                    rules_rewrite: None,
                    mcp: None,
                    file: None,
                    overwrite: None,
                });
            }
            // An edited old copy in the workspace folder stays, like any edited file.
            OperationKind::Conflict | OperationKind::Manual => preserved.push(artifact),
            _ => {}
        }
    }

    Ok(UninstallArtifactPlan {
        removals,
        preserved,
        merged,
    })
}

/// Whether a merge-managed file may hold something of the app's. The MCP file of a light harness
/// the app never wrote into is the user's alone, and is not reported as merged; one that cannot be
/// read as strict JSON was never written by the app either.
fn holds_managed_entry(artifact: &ArtifactId, home: &Path, workspace_root: &Path) -> bool {
    if artifact == &ArtifactId::ClaudeSettings {
        // The user's own `settings.json` is the app's only where it wrote the values.
        let identity = crate::managed_state::artifact_identity(artifact);
        return crate::managed_state::read_managed_state(workspace_root)
            .is_some_and(|state| state.artifacts.iter().any(|r| r.identity == identity))
            && artifact
                .resolve_dest(home, workspace_root)
                .is_ok_and(|dest| {
                    crate::claude_settings::assess(&dest)
                        == crate::claude_settings::Assessment::Hidden
                });
    }
    let ArtifactId::HarnessMcp(harness) = artifact else {
        return true;
    };
    let (Some(spec), Ok(dest)) = (harness.mcp(), artifact.resolve_dest(home, workspace_root))
    else {
        return false;
    };
    crate::light_mcp::read(&dest, spec)
        .ok()
        .flatten()
        .is_some_and(|document| document.entry(spec).is_some())
}

/// Whether a rules file carries user text around its managed block.
fn rules_block_has_user_content(artifact: &ArtifactId, workspace_root: &Path, home: &Path) -> bool {
    if !artifact.is_rules_block() {
        return false;
    }
    let Ok(dest) = artifact.resolve_dest(home, workspace_root) else {
        return false;
    };
    if fs::metadata(&dest).is_ok_and(|meta| meta.len() > crate::rules_block::MAX_RULES_FILE_BYTES) {
        return false;
    }
    let Ok(bytes) = fs::read(&dest) else {
        return false;
    };
    matches!(
        crate::rules_block::parse_bytes(&bytes),
        Ok(Some(file)) if !file.user_region_is_blank()
    )
}

/// Managed records plus historical-ownership records for pre-manifest copies.
///
/// Pre-manifest copies stay adoptable after the first apply: explicit managed
/// records win, historical-ownership records fill the gaps for artifacts an
/// earlier app version installed but no apply has touched. Artifacts that
/// already have a record are not inspected again, and one that cannot be
/// inspected only loses its own adoption.
///
/// Only a workspace folder the app has touched is inspected: one holding the state folder
/// `.riggverk/` or its earlier name (every earlier release wrote its marker there). It is not the copy of the
/// bundle, which the workspace cleanup removes: adoption has to outlive it.
fn records_with_bootstrap(
    workspace_root: &Path,
    home: &Path,
    managed: Option<&crate::managed_state::ManagedState>,
) -> Vec<crate::managed_state::ManagedArtifactRecord> {
    let mut records: Vec<crate::managed_state::ManagedArtifactRecord> = managed
        .map(|state| state.artifacts.clone())
        .unwrap_or_default();
    if !crate::managed_bootstrap::workspace_folder_touched(workspace_root) {
        return records;
    }
    let known: HashSet<String> = records.iter().map(|r| r.identity.clone()).collect();
    match crate::managed_bootstrap::infer_bootstrap_records(workspace_root, home, &known) {
        Ok(inference) => {
            log_skipped_bootstrap(&inference.skipped);
            records.extend(
                inference
                    .records
                    .into_iter()
                    .filter(|record| !known.contains(&record.identity)),
            );
        }
        Err(error) => log_skipped_bootstrap(&[error]),
    }
    records
}

/// Plans run several times per preview or apply; report each reason once.
fn log_skipped_bootstrap(skipped: &[String]) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let Ok(mut logged) = LOGGED.get_or_init(Mutex::default).lock() else {
        return;
    };
    for reason in skipped {
        if logged.insert(reason.clone()) {
            eprintln!("riggverk: skipped historical-ownership check: {reason}");
        }
    }
}

/// Plans `surfaces`. The skills surface is planned for the roots the enabled harnesses read
/// ([`SkillScope::current`]); it fails when the settings cannot be read, so no removal is ever
/// planned from a guess.
pub fn plan_artifacts_for_surfaces(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<PlannedArtifact>, String> {
    let scope = scope_for_surfaces(surfaces, home)?;
    plan_artifacts_for_surfaces_in(surfaces, workspace_root, home, &scope)
}

/// The skill roots a plan of `surfaces` is made for. Surfaces other than `Skills` do not depend
/// on the settings, so they are planned without reading them.
pub fn scope_for_surfaces(surfaces: &[SetupSurfaceId], home: &Path) -> Result<SkillScope, String> {
    if surfaces
        .iter()
        .any(|surface| surface.canonical() == SetupSurfaceId::Skills)
    {
        SkillScope::current(home)
    } else {
        Ok(SkillScope::all())
    }
}

/// [`plan_artifacts_for_surfaces`] for an explicit skill scope.
///
/// Operations come in apply order: what is wanted first, removals of what is no longer wanted
/// last. A skill that moves between folders is therefore present in its new folder before it is
/// removed from the old one, and one transaction covers both, so a failure or a crash restores
/// the old state.
pub fn plan_artifacts_for_surfaces_in(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
    scope: &SkillScope,
) -> Result<Vec<PlannedArtifact>, String> {
    let sources = SkillSources::for_workspace(workspace_root)?;
    plan_artifacts_for_surfaces_with(surfaces, workspace_root, home, scope, &sources)
}

/// [`plan_artifacts_for_surfaces_in`] with the sources already read: the plan reads each pack
/// skill once, however many artifacts it holds.
pub fn plan_artifacts_for_surfaces_with(
    surfaces: &[SetupSurfaceId],
    workspace_root: &Path,
    home: &Path,
    scope: &SkillScope,
    sources: &SkillSources,
) -> Result<Vec<PlannedArtifact>, String> {
    let managed = crate::managed_state::read_managed_state(workspace_root);
    let records = records_with_bootstrap(workspace_root, home, managed.as_ref());

    let mut canonical_identities =
        match crate::managed_state::canonical_artifact_identities(sources, scope) {
            Ok(identities) => identities,
            #[cfg(test)]
            Err(_) => std::collections::HashSet::new(),
            #[cfg(not(test))]
            Err(error) => return Err(error),
        };
    // An installed pack skill whose pack cannot be read is not retired: it is left as it is until
    // the user forgets the pack.
    canonical_identities.extend(crate::managed_state::held_skill_identities(
        &sources.held_names(),
        &records,
    ));

    let artifacts = expand_surfaces_to_artifacts_with(surfaces, workspace_root, scope, sources)?;
    let kept = crate::kept_files::KeptFiles::load(workspace_root);
    let mut planned = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for artifact in artifacts {
        seen.insert(crate::managed_state::artifact_identity(&artifact));
        let surface = artifact.surface();
        let identity = crate::managed_state::artifact_identity(&artifact);
        let managed_hash = managed_hash_for_artifact(&artifact, &identity, &records);
        let rules = plan_rules_artifact(
            &artifact,
            workspace_root,
            home,
            managed_hash.as_deref(),
            sources,
        );
        let mcp = plan_mcp_artifact(
            &artifact,
            workspace_root,
            sources,
            home,
            managed_hash.as_deref(),
        );
        let mut file = None;
        let (kind, previous_state) = match (&rules, &mcp) {
            (Some(assessment), _) => {
                let (kind, previous_state) = rules_outcome(assessment.plan);
                // A hand-edited file the user chose to manage stays untouched
                // and reports no conflict; it needs their own action.
                if kind == OperationKind::Conflict
                    && is_convertible(assessment.plan)
                    && crate::rules_preferences::is_user_managed(workspace_root, &artifact)
                {
                    (OperationKind::Manual, previous_state)
                } else {
                    (kind, previous_state)
                }
            }
            (None, Some(plan)) => (plan.kind, plan.previous_state),
            (None, None) => {
                let (kind, previous_state) =
                    detect_artifact_state_with(&artifact, workspace_root, home, sources);
                let (kind, previous_state) = refine_with_managed_hash(
                    kind,
                    previous_state,
                    &artifact,
                    workspace_root,
                    sources,
                    home,
                    managed_hash.as_deref(),
                );
                // Updates without proven ownership are preserved as conflicts,
                // except mergeable configs (their merge rewrites only managed
                // keys and preserves user-owned content by construction) and
                // files that are byte-for-byte a version the app shipped. A
                // differing Cursor `playwright` entry is the user's own: the
                // merge would replace it, so it needs the record too.
                let (kind, previous_state) = if managed_hash.is_none()
                    && matches!(kind, OperationKind::Update)
                    && (!matches!(previous_state, PreviousState::MergeableConfigFile)
                        || cursor_mcp_entry_differs(&artifact, sources.bundle()))
                    && !installed_is_shipped_version(&artifact, workspace_root, sources, home)
                {
                    (OperationKind::Conflict, PreviousState::Conflict)
                } else {
                    (kind, previous_state)
                };
                // A skill or agent file the user can resolve; one they keep is left alone.
                if kind == OperationKind::Conflict {
                    file = file_conflict(
                        &artifact,
                        workspace_root,
                        sources,
                        home,
                        &kept,
                        managed_hash.as_deref(),
                        true,
                    );
                }
                if file.is_some_and(|file| file.kept.is_some()) {
                    (OperationKind::Manual, previous_state)
                } else if codex_update_needs_python(&artifact, kind) {
                    // The merge scripts need `tomllib`: held back at preview, not failed mid-apply.
                    (OperationKind::Conflict, PreviousState::Conflict)
                } else {
                    (kind, previous_state)
                }
            }
        };
        let rollback_action = rollback_action_for(kind, previous_state);
        planned.push(PlannedArtifact {
            artifact,
            surface,
            kind,
            previous_state,
            rollback_action,
            rules,
            rules_rewrite: None,
            mcp: mcp.and_then(|plan| plan.state),
            file,
            overwrite: None,
        });
    }

    let requested_surfaces: std::collections::HashSet<SetupSurfaceId> =
        surfaces.iter().map(|surface| surface.canonical()).collect();
    // One file is never both wanted and stale: whatever has a wanted artifact's destination is
    // that artifact, using the current platform’s path comparison rule.
    let wanted_destinations: HashSet<PathBuf> = planned
        .iter()
        .filter_map(|operation| operation.artifact.resolve_dest(home, workspace_root).ok())
        .map(|dest| {
            crate::platform_paths::path_comparison_key(
                &dest,
                crate::platform_paths::Platform::current(),
            )
        })
        .collect();
    let stale = crate::managed_bootstrap::collect_stale_removal_artifacts(
        workspace_root,
        home,
        &records,
        &canonical_identities,
        scope,
    )?;
    let mut stale_destinations: HashSet<PathBuf> = HashSet::new();
    for artifact in stale {
        // Stale cleanup stays scoped to the surfaces the caller asked for;
        // a Claude update must not remove Codex or OpenCode files.
        if !requested_surfaces.contains(&artifact.surface()) {
            continue;
        }
        // With no harness enabled nothing is wanted anywhere, which is not a reason to remove
        // what is installed: uninstall is the way to do that.
        if artifact.is_skill_file() && scope.is_empty() {
            continue;
        }
        let identity = crate::managed_state::artifact_identity(&artifact);
        if seen.contains(&identity)
            || artifact
                .resolve_dest(home, workspace_root)
                .map(|dest| {
                    crate::platform_paths::path_comparison_key(
                        &dest,
                        crate::platform_paths::Platform::current(),
                    )
                })
                .is_ok_and(|dest| {
                    wanted_destinations.contains(&dest)
                    // Two skill roots that are one folder: the file is removed once.
                    || (artifact.is_skill_file() && !stale_destinations.insert(dest))
                })
        {
            continue;
        }
        seen.insert(identity.clone());
        let managed_hash = managed_hash_for(&identity, &records);
        let (kind, previous_state) = detect_stale_artifact_state(
            &artifact,
            workspace_root,
            sources,
            home,
            managed_hash.as_deref(),
        );
        if matches!(kind, OperationKind::NoChange | OperationKind::Unavailable) {
            continue;
        }
        // An edited copy of a retired skill is the user's to resolve too; one they keep stays.
        let file = (kind == OperationKind::Conflict)
            .then(|| {
                file_conflict(
                    &artifact,
                    workspace_root,
                    sources,
                    home,
                    &kept,
                    managed_hash.as_deref(),
                    false,
                )
            })
            .flatten();
        let kind = if file.is_some_and(|file| file.kept.is_some()) {
            OperationKind::Manual
        } else {
            kind
        };
        let surface = artifact.surface();
        let rollback_action = rollback_action_for(kind, previous_state);
        planned.push(PlannedArtifact {
            artifact,
            surface,
            kind,
            previous_state,
            rollback_action,
            rules: None,
            rules_rewrite: None,
            mcp: None,
            file,
            overwrite: None,
        });
    }
    keep_stale_units_whole(&mut planned);
    // Removals go last, whatever order the stale artifacts were found in (stable: the order inside
    // each group is kept).
    planned.sort_by_key(|operation| operation.kind == OperationKind::Remove);
    Ok(planned)
}

/// An update of the Codex config merges through the bundled Python scripts, which need a Python
/// that can read TOML (3.11+). Without one the update cannot run.
fn codex_update_needs_python(artifact: &ArtifactId, kind: OperationKind) -> bool {
    *artifact == ArtifactId::CodexConfig
        && kind == OperationKind::Update
        && crate::commands::codex_python().is_none()
}

/// A skill or agent file in conflict the user could resolve, with whether they keep it. `None`
/// when something blocks the file (a link in its path, a folder where it belongs): that stays a
/// plain conflict nothing here can resolve. `wanted` is whether the bundle wants the file here.
fn file_conflict(
    artifact: &ArtifactId,
    workspace_root: &Path,
    sources: &SkillSources,
    home: &Path,
    kept: &crate::kept_files::KeptFiles,
    managed_hash: Option<&str>,
    wanted: bool,
) -> Option<crate::file_conflicts::FileConflict> {
    use crate::file_conflicts::{ConflictReason, FileConflict, KeptState};
    if !crate::kept_files::is_keepable(artifact) {
        return None;
    }
    let dest = artifact.resolve_dest(home, workspace_root).ok()?;
    if skill_destination_blocked(artifact, &dest, home, workspace_root) || !dest.is_file() {
        return None;
    }
    let entry = kept.entry(
        artifact,
        &crate::kept_files::dest_label(artifact, home, workspace_root).ok()?,
    );
    Some(FileConflict {
        reason: if managed_hash.is_some() {
            ConflictReason::Edited
        } else {
            ConflictReason::Unproven
        },
        kept: entry.map(|entry| KeptState {
            // A file nothing bundles here has no update to wait for.
            bundle_changed: wanted
                && crate::setup_fingerprint::artifact_source_digest(artifact, sources, home)
                    .is_ok_and(|current| entry.bundle.as_deref() != Some(current.as_str())),
        }),
        wanted,
    })
}

/// A retired skill with a file the user keeps, or an edited file they have not resolved yet,
/// keeps all its files: removing the others would leave half a skill behind. Its other removals
/// become manual steps.
fn keep_stale_units_whole(planned: &mut [PlannedArtifact]) {
    use crate::artifact_registry::ArtifactId::SkillFile;
    let kept_units: HashSet<_> = planned
        .iter()
        .filter(|operation| {
            crate::file_conflicts::is_kept(operation) || operation.kind == OperationKind::Conflict
        })
        .filter(|operation| operation.file.is_some_and(|file| !file.wanted))
        .filter_map(|operation| match &operation.artifact {
            SkillFile(file) => Some((file.root, file.skill.clone())),
            _ => None,
        })
        .collect();
    if kept_units.is_empty() {
        return;
    }
    for operation in planned
        .iter_mut()
        .filter(|operation| operation.kind == OperationKind::Remove)
    {
        let SkillFile(file) = &operation.artifact else {
            continue;
        };
        if kept_units.contains(&(file.root, file.skill.clone())) {
            operation.kind = OperationKind::Manual;
            operation.rollback_action =
                rollback_action_for(OperationKind::Manual, operation.previous_state);
        }
    }
}

/// A pack skill whose `SKILL.md` sets keys the harness acts on by itself, for the review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlaggedSkill {
    pub pack: String,
    pub keys: Vec<crate::skill_discovery::PrivilegedKey>,
}

/// The pack skills of the catalog that set any of
/// [`crate::skill_discovery::PRIVILEGED_SKILL_KEYS`], by name. Bundled skills are not listed: the
/// bundle's keys are reviewed where it is built.
pub fn flagged_pack_skills<R: SourceRoot + ?Sized>(
    sources: &R,
) -> std::collections::BTreeMap<String, FlaggedSkill> {
    sources
        .catalog()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let pack = entry.pack?;
            let keys = crate::skill_discovery::read_privileged_keys(&entry.skill.skill_md_path);
            (!keys.is_empty()).then_some((entry.skill.name, FlaggedSkill { pack, keys }))
        })
        .collect()
}

/// The longest value of a privileged key a review line carries; the Library shows it whole.
const REVIEW_KEY_VALUE_CHARS: usize = 200;

/// The note of a flagged skill's review line: `pack team; allowed-tools: Bash(git *) [grants tool
/// access without asking]; model: opus`.
fn flagged_note(flagged: &FlaggedSkill) -> String {
    let mut parts = vec![format!("pack {}", flagged.pack)];
    for key in &flagged.keys {
        let mut value: String = key.value.chars().take(REVIEW_KEY_VALUE_CHARS).collect();
        if value.len() < key.value.len() {
            value.push_str("… (whole value in the Library)");
        }
        let note = if key.note.is_empty() {
            String::new()
        } else {
            format!(" [{}]", key.note)
        };
        parts.push(format!("{}: {value}{note}", key.key));
    }
    parts.join("; ")
}

/// Review lines for the skills surface, one per folder and kind, in the shape the review table
/// reads (`+ file (note)`):
///
/// ```text
/// + ~/.agents/skills (N skills, M files)
/// ~ ~/.claude/skills (N skills, M files)
/// + ~/.claude/skills/deploy (pack team; allowed-tools: Bash(git *) [grants tool access without asking])
/// - $CODEX_HOME/skills (N skills, owned copies)
/// ! ~/.cursor/skills/tdd (edited, kept)
/// = ~/.claude/skills/diagnose (you manage; bundled update available)
/// ```
///
/// Creations, updates and removals are summarised per folder, except a pack skill in `flagged`
/// (it sets keys the harness acts on without asking), which gets a line of its own in each folder
/// it is written to, naming those keys and their values. Every skill that stays because it was
/// edited or is in the way gets its own line, with the harnesses that read both that copy and the
/// installed one. `=` marks a skill with a file the user keeps.
pub fn skill_plan_details(
    planned: &[PlannedArtifact],
    scope: &SkillScope,
    flagged: &std::collections::BTreeMap<String, FlaggedSkill>,
) -> Vec<String> {
    use std::collections::{BTreeMap, BTreeSet};
    let count = |n: usize, noun: &str| format!("{n} {noun}{}", if n == 1 { "" } else { "s" });
    let mut lines = Vec::new();
    for (sign, kind, owned) in [
        ("+", OperationKind::Create, false),
        ("~", OperationKind::Update, false),
        ("-", OperationKind::Remove, true),
    ] {
        for root in crate::skill_roots::SkillRoot::ALL {
            let (own_line, files): (Vec<_>, Vec<_>) = planned
                .iter()
                .filter(|operation| operation.kind == kind)
                .filter_map(|operation| operation.artifact.as_skill_file())
                .filter(|file| file.root == root)
                .partition(|file| !owned && flagged.contains_key(file.skill.as_str()));
            if !files.is_empty() {
                let skills: BTreeSet<_> = files.iter().map(|file| file.skill.as_str()).collect();
                let tail = if owned {
                    "owned copies".to_string()
                } else {
                    count(files.len(), "file")
                };
                lines.push(format!(
                    "{sign} {} ({}, {tail})",
                    root.display(),
                    count(skills.len(), "skill")
                ));
            }
            let own_skills: BTreeSet<_> = own_line.iter().map(|file| file.skill.as_str()).collect();
            for skill in own_skills {
                lines.push(format!(
                    "{sign} {}/{skill} ({})",
                    root.display(),
                    flagged_note(&flagged[skill])
                ));
            }
        }
    }
    // The skills that stay as they are, per folder and name: edited ones (conflicts) and the ones
    // the user keeps.
    #[derive(Default)]
    struct Held {
        conflict: bool,
        kept: bool,
        update: bool,
        wanted: bool,
    }
    let mut held: BTreeMap<(usize, String), Held> = BTreeMap::new();
    for operation in planned
        .iter()
        .filter(|operation| operation.kind == OperationKind::Conflict || is_kept(operation))
    {
        let Some(file) = operation.artifact.as_skill_file() else {
            continue;
        };
        let order = crate::skill_roots::SkillRoot::ALL
            .iter()
            .position(|root| *root == file.root)
            .unwrap_or_default();
        let entry = held
            .entry((order, file.skill.as_str().to_string()))
            .or_default();
        match operation
            .file
            .and_then(|file| file.kept.map(|kept| (kept, file.wanted)))
        {
            Some((kept, wanted)) => {
                entry.kept = true;
                entry.update |= kept.bundle_changed;
                entry.wanted = wanted;
            }
            None => entry.conflict = true,
        }
    }
    for ((order, skill), held) in held {
        let root = crate::skill_roots::SkillRoot::ALL[order];
        let readers: Vec<&str> = scope
            .harnesses()
            .iter()
            .filter(|harness| {
                !scope.contains(root)
                    && crate::skill_roots::readers(**harness)
                        .iter()
                        .any(|folder| folder.root() == Some(root))
            })
            .map(|harness| harness_name(*harness))
            .collect();
        let reads = match readers.as_slice() {
            [] => String::new(),
            [one] => format!("; {one} reads both copies"),
            many => format!("; {} read both copies", many.join(", ")),
        };
        if held.conflict {
            lines.push(format!(
                "! {}/{skill} (edited, kept{reads})",
                root.display()
            ));
        }
        if held.kept {
            let bundle = match (held.wanted, held.update) {
                (false, _) => "",
                (true, true) => "; bundled update available",
                (true, false) => "; bundle unchanged",
            };
            lines.push(format!(
                "= {}/{skill} (you manage{bundle}{reads})",
                root.display()
            ));
        }
    }
    lines
}

pub(crate) fn harness_name(harness: crate::agent_targets::HarnessId) -> &'static str {
    use crate::agent_targets::HarnessId;
    match harness {
        HarnessId::Claude => "Claude",
        HarnessId::Codex => "Codex",
        HarnessId::OpenCode => "OpenCode",
        HarnessId::Cursor => "Cursor",
        HarnessId::Copilot
        | HarnessId::Pi
        | HarnessId::Kilo
        | HarnessId::Antigravity
        | HarnessId::Grok => crate::light_harness::display_name(harness),
    }
}

/// Whether the installed copy is byte-for-byte a version the app shipped for
/// this artifact. An unreadable or absent copy is not.
fn installed_is_shipped_version<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    workspace_root: &Path,
    sources: &R,
    home: &Path,
) -> bool {
    crate::setup_fingerprint::artifact_installed_managed_digest(artifact, workspace_root, home)
        .is_ok_and(|installed| {
            crate::shipped_digests::is_shipped_version(artifact, sources, &installed)
        })
}

fn refine_with_managed_hash<R: SourceRoot + ?Sized>(
    kind: OperationKind,
    previous: PreviousState,
    artifact: &ArtifactId,
    workspace_root: &Path,
    sources: &R,
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
    // A recorded hash that no longer matches may only be stale: a file that is
    // exactly a version the app shipped is still the app's to update.
    if installed == expected
        || crate::shipped_digests::is_shipped_version(artifact, sources, &installed)
        || legacy_whole_file_record_holds(artifact, workspace_root, home, expected)
        || codex_record_holds_beside_kept(artifact, workspace_root, sources, home, expected)
        || (*artifact == ArtifactId::OpenCodeConfig
            && crate::setup_fingerprint::opencode_record_holds(workspace_root, home, expected))
    {
        (OperationKind::Update, previous)
    } else {
        (OperationKind::Conflict, PreviousState::Conflict)
    }
}

/// The record of the Codex config describes the file as the app last wrote it, before the user
/// kept any key. With the kept keys put back to the template's values, a file that is still what
/// the record describes (or a version the app shipped) is the app's to update: the update leaves
/// the kept keys alone.
fn codex_record_holds_beside_kept<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    workspace_root: &Path,
    sources: &R,
    home: &Path,
    recorded: &str,
) -> bool {
    if *artifact != ArtifactId::CodexConfig {
        return false;
    }
    let read = |path: PathBuf| {
        crate::setup_fingerprint::read_user_config(&path, "Codex config.toml")
            .ok()
            .and_then(|raw| raw.parse::<toml::Value>().ok())
    };
    let (Ok(dest), Some(source)) = (
        artifact.resolve_dest(home, workspace_root),
        artifact.resolve_source(sources),
    ) else {
        return false;
    };
    let (Some(installed), Some(template)) = (read(dest), read(source)) else {
        return false;
    };
    let active = crate::codex_config_keep::active_kept(workspace_root, home, &installed);
    if active.is_empty() {
        return false;
    }
    let digest = crate::setup_fingerprint::codex_managed_digest(
        &crate::codex_config_keep::with_kept_reset(&installed, &template, &active),
    );
    digest == recorded || crate::shipped_digests::is_shipped_version(artifact, sources, &digest)
}

/// Before `tui.json` was merge-managed its record held the digest of the whole file the app
/// copied. A file that is still exactly those bytes holds the app's managed keys, so the record
/// proves them; after the next apply the record holds the managed-key digest.
fn legacy_whole_file_record_holds(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    recorded: &str,
) -> bool {
    *artifact == ArtifactId::OpenCodeTui
        && crate::setup_fingerprint::artifact_installed_full_digest(artifact, workspace_root, home)
            .is_ok_and(|full| full == recorded)
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
        ArtifactId::ClaudeSettings => "claude-settings".into(),
        ArtifactId::HarnessRules(harness) => format!("{}-rules", harness.harness().as_str()),
        ArtifactId::HarnessMcp(harness) => format!("{}-mcp", harness.harness().as_str()),
        ArtifactId::CursorMcp => "cursor-mcp".into(),
        ArtifactId::OpenCodeAgent(name) => format!("opencode-agent-{}", name.as_str()),
        ArtifactId::CodexAgent(name) => format!("codex-agent-{}", name.as_str()),
        ArtifactId::ClaudeAgent(name) => format!("claude-agent-{}", name.as_str()),
        ArtifactId::CursorAgent(name) => format!("cursor-agent-{}", name.as_str()),
        // `~` appears in neither a skill name nor a skill file path, so the name ends at the first
        // one and every `~` after it stands for a `/`: two files never share a backup.
        ArtifactId::SkillFile(file) => format!(
            "skill-{}-{}~{}",
            file.root.label(),
            file.skill.as_str(),
            file.rel.as_str().replace('/', "~")
        ),
        ArtifactId::OpenCodeSkill(name) => format!("opencode-skill-{}", name.as_str()),
        ArtifactId::CodexSkill(name) => format!("codex-skill-{}", name.as_str()),
        ArtifactId::ClaudeSkill(name) => format!("claude-skill-{}", name.as_str()),
        ArtifactId::CursorSkill(name) => format!("cursor-skill-{}", name.as_str()),
        ArtifactId::CodexLegacySkill(name) => format!("codex-legacy-skill-{}", name.as_str()),
        ArtifactId::WorkspaceFile(rel) => {
            format!("workspace-file-{}", rel.as_str().replace('/', "__"))
        }
    };
    if id.len() <= MAX_LEN {
        return id;
    }
    // A name over the cap keeps a digest of the whole id, so two long ids never share a backup.
    let digest = crate::stable_digest::bytes(id.as_bytes());
    let suffix = digest.strip_prefix("sha256:").unwrap_or(&digest);
    let mut cut = MAX_LEN - 9;
    while !id.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}-{}", &id[..cut], &suffix[..8])
}

/// After a skill file was removed: remove the directories it left empty, from its own directory
/// up to the skill's directory, never the skill root. A directory that still holds anything (a
/// sibling file the user added, a supporting file) stays, and so does everything above it.
pub fn remove_empty_skill_directories(
    artifact: &ArtifactId,
    dest: &Path,
    home: &Path,
    allowlist_root: &Path,
) -> Result<(), String> {
    let Some(file) = artifact.as_skill_file() else {
        return Ok(());
    };
    let skill_root = file.root.path(home)?;
    let mut current = dest.parent();
    while let Some(dir) = current {
        if dir == skill_root || !dir.starts_with(&skill_root) {
            break;
        }
        crate::safe_filesystem::remove_empty_directory_no_symlinks(dir, allowlist_root)?;
        if dir.exists() {
            break;
        }
        current = dir.parent();
    }
    Ok(())
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

/// The full digest of what applying `planned` writes, rendered from the same inputs the write
/// reads, just before it. Recorded in the manifest before the mutation (see
/// [`ArtifactManifestOperation::expected_full_digest`]). `None` where the output is not known in
/// advance: a folder copy, the Cursor MCP merge (a script), the merge of an existing Codex config
/// (Python) and the OpenCode config merge. Recovery then needs other proof and fails closed.
pub fn expected_apply_full_digest(
    planned: &PlannedArtifact,
    workspace_root: &Path,
    home: &Path,
    sources: &SkillSources,
) -> Option<String> {
    let digest = |text: String| Some(crate::stable_digest::bytes(text.as_bytes()));
    if matches!(planned.kind, OperationKind::Remove) {
        return Some(crate::setup_fingerprint::ABSENT_DIGEST.to_string());
    }
    if let Some(rewrite) = &planned.rules_rewrite {
        return digest(rewrite.content.clone());
    }
    let artifact = &planned.artifact;
    let dest = artifact.resolve_dest(home, workspace_root).ok()?;
    if artifact == &ArtifactId::ClaudeSettings {
        return crate::claude_settings::render_install(&dest)
            .ok()
            .and_then(digest);
    }
    let source = artifact.resolve_source(sources)?;
    if source.is_dir() {
        return None;
    }
    if artifact.is_rules_block() {
        let text = crate::pack_routing::rules_source_text(artifact, sources).ok()?;
        if !dest.exists() {
            return digest(crate::rules_block::render_new(&text));
        }
        let installed = fs::read(&dest).ok()?;
        return digest(match crate::rules_block::parse_bytes(&installed).ok()? {
            Some(file) => file.render_with_body(&text),
            None => crate::rules_block::render_new(&text),
        });
    }
    match artifact {
        ArtifactId::HarnessMcp(harness) => {
            let spec = harness.mcp()?;
            let bundled = crate::setup_roots::bundled_root_for(workspace_root).ok()?;
            let entry = crate::light_mcp::expected_entry(spec, &bundled, home).ok()?;
            let document = crate::light_mcp::read(&dest, spec).ok()?;
            crate::light_mcp::render(spec, document, entry)
                .ok()
                .and_then(digest)
        }
        ArtifactId::OpenCodeTui => crate::opencode_tui::render_install(&source, &dest)
            .ok()
            .and_then(digest),
        ArtifactId::CursorMcp | ArtifactId::OpenCodeConfig => None,
        ArtifactId::CodexConfig if dest.is_file() => None,
        // Everything else is a plain copy of its source.
        _ => crate::stable_digest::file(&source).ok(),
    }
}

/// Whether the managed digest of `artifact` covers every byte of the file, so a match with the
/// source proves the whole file is the app's.
fn managed_digest_covers_whole_file(artifact: &ArtifactId) -> bool {
    !artifact.is_rules_block()
        && matches!(
            artifact_kind(artifact),
            ArtifactKind::SkillFile | ArtifactKind::AgentFile | ArtifactKind::RulesFile
        )
}

pub fn artifact_matches_post_apply_state(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<bool, String> {
    let Some(expected_full) = op.post_apply_full_digest.as_deref() else {
        // Apply was interrupted before digests were recorded.
        return Ok(unrecorded_apply_restore_mode(op, workspace_root, home)?.is_some());
    };
    let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if current_full != expected_full {
        return Ok(false);
    }
    if let Some(expected_managed) = op.post_apply_digest.as_deref() {
        let current_managed = recorded_form_managed_digest(op, workspace_root, home)?;
        if current_managed != expected_managed {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The managed digest of the installed artifact in the form `op` recorded it. An operation on
/// `tui.json` from before the file was merge-managed recorded the whole-file digest as its
/// managed digest (equal to its full digest), so it is compared on the whole file.
fn recorded_form_managed_digest(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<String, String> {
    if op.artifact == ArtifactId::OpenCodeTui
        && op.post_apply_digest.is_some()
        && op.post_apply_digest == op.post_apply_full_digest
    {
        return crate::setup_fingerprint::artifact_installed_full_digest(
            &op.artifact,
            workspace_root,
            home,
        );
    }
    crate::setup_fingerprint::artifact_installed_managed_digest(&op.artifact, workspace_root, home)
}

/// How to undo an operation whose post-apply digests were never recorded (apply failed or was
/// interrupted mid-operation), or `None` when nothing proves the app produced the current content.
///
/// The digest recorded before the write proves the whole file. Without it, a merge-managed config
/// restores only its managed projection, and only while that is the current source's; replacing or
/// removing a whole file needs a digest that covers the whole file, so a file the user may have
/// added to (a created `settings.json`, an MCP file, a rules file) is kept.
fn unrecorded_apply_restore_mode(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<Option<RollbackRestoreMode>, String> {
    let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if op.expected_full_digest.as_deref() == Some(current_full.as_str()) {
        return Ok(Some(RollbackRestoreMode::FullBackup));
    }
    if matches!(op.rollback_action, RollbackAction::RestoreManagedConfigFile) {
        return Ok(
            artifact_matches_current_source_output(op, workspace_root, home)?
                .then_some(RollbackRestoreMode::ManagedProjectionMerge),
        );
    }
    if matches!(op.kind, OperationKind::Remove) {
        // A removal writes nothing: an absent file is all of its output.
        return Ok((current_full == crate::setup_fingerprint::ABSENT_DIGEST)
            .then_some(RollbackRestoreMode::FullBackup));
    }
    if op.expected_full_digest.is_some() || !managed_digest_covers_whole_file(&op.artifact) {
        return Ok(None);
    }
    Ok(
        artifact_matches_current_source_output(op, workspace_root, home)?
            .then_some(RollbackRestoreMode::FullBackup),
    )
}

/// Whether the managed projection of the artifact is what the current source makes of it: the
/// planned content, read again, for an operation that recorded no digest of its output.
fn artifact_matches_current_source_output(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<bool, String> {
    let current = crate::setup_fingerprint::artifact_installed_managed_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    let expected = SkillSources::for_workspace(workspace_root).and_then(|bundled| {
        crate::setup_fingerprint::artifact_effective_source_digest(
            &op.artifact,
            &bundled,
            workspace_root,
            home,
        )
    });
    Ok(expected.is_ok_and(|expected| expected == current))
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
                    workspace_root,
                    home,
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

/// Refuses a transaction folder someone other than the user could have written. Rollback and
/// interrupted-transaction recovery trust the digests in `manifest.json` and the bytes below
/// `artifacts/` with nothing to authenticate them, so the folder, the manifest and `artifacts/`
/// must each be no link, owned by the current user and not writable by its group or by everyone
/// (Unix; the checks a pack folder gets). The reasons are fixed phrases without the path.
pub fn check_transaction_folder_trusted(backup_dir: &Path) -> Result<(), String> {
    let entries = [
        (
            backup_dir.to_path_buf(),
            "the setup transaction folder",
            true,
        ),
        (backup_dir.join("manifest.json"), "the setup manifest", true),
        (
            backup_dir.join("artifacts"),
            "the setup backup folder",
            false,
        ),
    ];
    for (path, what, required) in entries {
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(format!("cannot inspect {what}")),
        };
        if meta.file_type().is_symlink() {
            return Err(format!("refusing {what}: it is a link"));
        }
        crate::skill_sources::check_trusted(&meta, what)?;
    }
    Ok(())
}

/// Refuses a backup someone other than the user could have written before it is restored: the
/// file, or the folder and everything below it, must be no link, owned by the current user and not
/// writable by its group or by everyone (Unix). Nothing authenticates the backed-up bytes, so this
/// is what keeps another local user from choosing what a rollback writes. Read access is not
/// checked: releases before v2026.10.1 left backups 0644 and folders 0755, which still restore.
pub fn check_backup_trusted(backup: &Path) -> Result<(), String> {
    const WHAT: &str = "the setup backup";
    let meta = fs::symlink_metadata(backup).map_err(|_| format!("cannot inspect {WHAT}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing {WHAT}: it is a link"));
    }
    crate::skill_sources::check_trusted(&meta, WHAT)?;
    if meta.is_dir() {
        for entry in fs::read_dir(backup).map_err(|_| format!("cannot inspect {WHAT}"))? {
            let entry = entry.map_err(|_| format!("cannot inspect {WHAT}"))?;
            check_backup_trusted(&entry.path())?;
        }
    }
    Ok(())
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
    crate::safe_filesystem::write_private_regular_file_atomic(
        path,
        json.as_bytes(),
        allowlisted_root,
    )?;
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
    let source_root = artifact.allowlist_root(home, workspace_root)?;
    if dest.is_dir() {
        crate::safe_filesystem::copy_private_dir_no_symlinks(&dest, &backup_path, backup_dir)
            .map_err(|e| format!("backup dir {}: {e}", dest.display()))?;
        validate_backup_copy(artifact, &dest, &backup_path, backup_dir)?;
    } else {
        reject_symlink_parent_chain(&dest, &source_root, "backup source file")?;
        crate::safe_filesystem::copy_private_regular_file_no_symlinks(
            &dest,
            &backup_path,
            backup_dir,
        )
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

/// Whether `recorded` is the surface a manifest operation may name for `artifact`. A skill file
/// recorded by an older version names the retired per-harness skill surface it was installed
/// through; such a manifest must still validate so it can be rolled back.
fn surface_matches(artifact: &ArtifactId, recorded: SetupSurfaceId) -> bool {
    artifact.surface() == recorded
        || (artifact.is_skill_file() && recorded.is_retired_skill_surface())
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
    // A manifest keyed by the earlier default folder maps onto the current folder only when that
    // folder was moved. If an earlier folder exists again next to the current one, the manifest
    // could mean either, and rolling it back could write into the wrong one.
    if let Some(earlier) = crate::workspace_layout::legacy_default_workspace_path() {
        if Path::new(&manifest.workspace_key) == earlier
            && workspace_root != earlier
            && fs::symlink_metadata(&earlier).is_ok()
        {
            return Err(format!(
                "manifest was recorded for the earlier workspace folder {}, which still exists next to {}; move or remove it, then roll back",
                earlier.display(),
                workspace_root.display()
            ));
        }
    }
    if !workspace_keys_match(&manifest.workspace_key, &ws_key) {
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
        if !surface_matches(&op.artifact, op.surface) {
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
    let current_managed = recorded_form_managed_digest(op, workspace_root, home)?;
    if current_managed != expected_managed {
        return Err(CHANGED_SINCE_APPLY.into());
    }
    Ok(())
}

fn rollback_restore_mode(
    op: &ArtifactManifestOperation,
    workspace_root: &Path,
    home: &Path,
) -> Result<RollbackRestoreMode, String> {
    if op.post_apply_full_digest.is_none() {
        if let Some(expected_full) = op.expected_full_digest.as_deref() {
            // The app stopped before it saved the post-apply digests: the digest recorded before
            // the write proves the content, and only as a whole.
            let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
                &op.artifact,
                workspace_root,
                home,
            )?;
            return if current_full == expected_full {
                Ok(RollbackRestoreMode::FullBackup)
            } else {
                Err(CHANGED_SINCE_APPLY.into())
            };
        }
    }
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
        Err(CHANGED_SINCE_APPLY.into())
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
    // Without post-apply digests (the app stopped before saving them), the digest recorded before
    // the write is the proof.
    let expected_full = op
        .post_apply_full_digest
        .as_deref()
        .or(op.expected_full_digest.as_deref())
        .ok_or_else(|| "missing post-apply full digest".to_string())?;
    let current_full = crate::setup_fingerprint::artifact_installed_full_digest(
        &op.artifact,
        workspace_root,
        home,
    )?;
    if current_full != expected_full {
        return Err(CHANGED_SINCE_APPLY.into());
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
    let mode = rollback_restore_mode(op, workspace_root, home)?;
    // Merging the Codex config back runs the bundled Python scripts: refused before anything is
    // touched (and in the Undo preview) when no Python can read TOML.
    if mode == RollbackRestoreMode::ManagedProjectionMerge
        && op.artifact == ArtifactId::CodexConfig
        && crate::commands::codex_python().is_none()
    {
        return Err(crate::commands::CODEX_PYTHON_REQUIRED.into());
    }
    Ok(())
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
    check_backup_trusted(&backup_path)?;
    if backup_path.is_dir() {
        scan_backup_tree_no_symlinks(&backup_path)?;
    } else if !backup_path.is_file() {
        return Err("backup is not a regular file".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn validate_artifact_after_apply(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Result<(), String> {
    let (kind, _) = detect_artifact_state(artifact, workspace_root, home);
    check_state_after_apply(artifact, kind)
}

/// [`validate_artifact_after_apply`] with the sources already read.
pub fn validate_artifact_after_apply_with(
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
    sources: &SkillSources,
) -> Result<(), String> {
    let (kind, _) = detect_artifact_state_with(artifact, workspace_root, home, sources);
    check_state_after_apply(artifact, kind)
}

fn check_state_after_apply(artifact: &ArtifactId, kind: OperationKind) -> Result<(), String> {
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

/// Restore for automatic rollback (failed apply or interrupted-apply
/// reconciliation). Never overwrites content the transaction did not produce:
/// an artifact the user changed after apply fails with [`CHANGED_SINCE_APPLY`]
/// and is left untouched.
pub fn restore_artifact_from_backup(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    match automatic_restore_mode(op, backup_dir, home, workspace_root)? {
        Some(mode) => {
            restore_artifact_from_backup_with_mode(op, backup_dir, home, mode, Some(workspace_root))
        }
        None => Ok(()),
    }
}

/// `None` means the artifact already matches its pre-apply state.
fn automatic_restore_mode(
    op: &ArtifactManifestOperation,
    backup_dir: &Path,
    home: &Path,
    workspace_root: &Path,
) -> Result<Option<RollbackRestoreMode>, String> {
    if artifact_matches_previous_backup_state(op, backup_dir, home, workspace_root)? {
        return Ok(None);
    }
    if op.post_apply_digest.is_some() && op.post_apply_full_digest.is_some() {
        return rollback_restore_mode(op, workspace_root, home).map(Some);
    }
    match unrecorded_apply_restore_mode(op, workspace_root, home)? {
        Some(mode) => Ok(Some(mode)),
        None => Err(CHANGED_SINCE_APPLY.into()),
    }
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
    let allowlist_root = op.artifact.allowlist_root(home, ws_root)?;
    let allowlist_root = allowlist_root.as_path();

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
            check_backup_trusted(&backup_path)?;
            // The copy replaces the destination atomically; removing it first
            // would lose the file if the copy then fails.
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
            check_backup_trusted(&backup_path)?;
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
                            serde_json::from_str(&installed_str).map_err(|_| {
                                "the OpenCode opencode.json is not valid JSON".to_string()
                            })?;
                        let backup_str = fs::read_to_string(&backup_path)
                            .map_err(|e| format!("read backup opencode config: {e}"))?;
                        let backup_json: serde_json::Value = serde_json::from_str(&backup_str)
                            .map_err(|_| {
                                "the backed-up opencode.json is not valid JSON".to_string()
                            })?;
                        let template_path = crate::setup_roots::bundled_root_for(ws_root)?
                            .join("templates/opencode.json");
                        let template: serde_json::Value = serde_json::from_str(
                            &fs::read_to_string(template_path)
                                .map_err(|_| "cannot read opencode template")?,
                        )
                        .map_err(|_| "invalid opencode template")?;
                        let expected =
                            crate::commands::render_expected_opencode_config(&template, home)
                                .ok_or("cannot render opencode template")?;
                        let mut projection =
                            crate::commands::extract_managed_opencode_config(&backup_json);
                        if let Some(object) = projection.as_object_mut() {
                            for key in ["model", "small_model"] {
                                if expected.get(key).is_none() {
                                    object.shift_remove(key);
                                }
                            }
                        }
                        let merged = crate::commands::merge_managed_opencode_config(
                            &installed_json,
                            &projection,
                        );
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            crate::commands::serialize_opencode_preserving_models(
                                &installed_str,
                                &merged,
                            )?
                            .as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write opencode config: {e}"))?;
                    } else if op.artifact == ArtifactId::OpenCodeTui {
                        let rendered = crate::opencode_tui::render_restored(&dest, &backup_path)?;
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            rendered.as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write tui.json: {e}"))?;
                    } else if op.artifact == ArtifactId::ClaudeSettings {
                        // Put the two values back as the backup had them; the rest of the file
                        // is whatever it is now.
                        let rendered =
                            crate::claude_settings::render_restored(&dest, &backup_path)?;
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            rendered.as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write settings.json: {e}"))?;
                    } else if op.artifact == ArtifactId::CodexConfig {
                        let workspace_root = workspace_root.ok_or_else(|| {
                            "workspace root required for codex managed rollback".to_string()
                        })?;
                        // The merge scripts come from the bundled root, never from the runtime workspace.
                        let rendered = crate::commands::render_codex_config_managed_projection(
                            &crate::setup_roots::bundled_root_for(workspace_root)?,
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
                                .map_err(|_| "the Cursor mcp.json is not valid JSON".to_string())?;
                        let backup_str = fs::read_to_string(&backup_path)
                            .map_err(|e| format!("read backup cursor mcp: {e}"))?;
                        let backup_json: serde_json::Value = serde_json::from_str(&backup_str)
                            .map_err(|_| {
                                "the backed-up Cursor mcp.json is not valid JSON".to_string()
                            })?;
                        let backup_projection = backup_json
                            .get("mcpServers")
                            .and_then(|v| v.get("playwright"))
                            .cloned();
                        let mut merged = installed_json;
                        let servers = merged
                            .as_object_mut()
                            .and_then(|obj| obj.get_mut("mcpServers"))
                            .and_then(|v| v.as_object_mut())
                            .ok_or_else(|| "installed cursor mcp missing mcpServers".to_string())?;
                        match backup_projection {
                            Some(projection) => {
                                servers.insert("playwright".to_string(), projection);
                            }
                            // The backup had no playwright entry, so the apply added it:
                            // take it out again and keep the user's other servers.
                            None => {
                                servers.shift_remove("playwright");
                            }
                        }
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            (serde_json::to_string_pretty(&merged)
                                .map_err(|e| format!("serialize cursor mcp: {e}"))?
                                + "\n")
                                .as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write cursor mcp: {e}"))?;
                    } else if let ArtifactId::HarnessMcp(harness) = &op.artifact {
                        // Put the previous entry back, or take the added one out; the rest of
                        // the file is whatever it is now.
                        let spec = harness.mcp().ok_or_else(|| {
                            "the light harness descriptor is unavailable".to_string()
                        })?;
                        let rendered =
                            crate::light_mcp::render_restored(spec, &dest, &backup_path)?;
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            rendered.as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write MCP file: {e}"))?;
                    } else if op.artifact.is_rules_block() {
                        // Put the previous base back inside the block; the
                        // user's text around it is whatever it is now.
                        let backup_bytes = fs::read(&backup_path)
                            .map_err(|e| format!("read backup rules file: {e}"))?;
                        let backup_file = crate::rules_block::parse_bytes(&backup_bytes)
                            .map_err(|reason| {
                                format!("backup rules file is unusable: {}", reason.message())
                            })?
                            .ok_or_else(|| "backup rules file has no managed block".to_string())?;
                        let installed_bytes = fs::read(&dest)
                            .map_err(|e| format!("read installed rules file: {e}"))?;
                        let installed_file = crate::rules_block::parse_bytes(&installed_bytes)
                            .map_err(|reason| {
                                format!("installed rules file is unusable: {}", reason.message())
                            })?
                            .ok_or_else(|| {
                                "installed rules file has no managed block".to_string()
                            })?;
                        let rendered = installed_file.render_with_body(backup_file.body);
                        crate::safe_filesystem::write_regular_file_atomic(
                            &dest,
                            rendered.as_bytes(),
                            allowlist_root,
                        )
                        .map_err(|e| format!("write rules file: {e}"))?;
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
            remove_empty_skill_directories(&op.artifact, &dest, home, allowlist_root)?;
            Ok(())
        }
        RollbackAction::NoAction => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::ArtifactId;
    use crate::skill_roots::SkillRoot;
    use std::fs;

    fn temp(label: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-txn-{label}-{n}"))
    }

    #[test]
    fn expand_bundled_skills_count() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let one_root = SkillScope::of(&[SkillRoot::Claude]);
        let artifacts =
            expand_surface_fail_closed(SetupSurfaceId::Skills, &repo, &one_root).unwrap();
        let skill_md = artifacts
            .iter()
            .filter(|artifact| matches!(artifact, ArtifactId::SkillFile(file) if file.rel.is_skill_md()))
            .count();
        let (expected_skills, supporting) =
            crate::test_env::skill_file_counts(&repo.join("skills"));
        assert_eq!(skill_md, expected_skills, "one SKILL.md per bundled skill");
        assert_eq!(
            artifacts.len() - skill_md,
            supporting,
            "supporting files of the bundled skills"
        );
    }

    #[test]
    fn skill_without_a_canonical_source_is_unavailable_and_with_one_is_created() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp("skill-source-home");
        let ws = temp("skill-source-ws");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&ws).unwrap();
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("OPENCODE_SKILLS_PATH");
            std::env::remove_var("CLAUDE_SKILLS_PATH");
        }
        let name = |name: &str| crate::artifact_registry::SkillName::new(name).unwrap();

        let skill_md = |root, name| ArtifactId::skill_md(root, name);
        let missing = skill_md(SkillRoot::OpenCode, name("no-such-skill"));
        assert_eq!(
            detect_artifact_state(&missing, &ws, &home),
            (OperationKind::Unavailable, PreviousState::Unavailable)
        );
        for artifact in [
            skill_md(SkillRoot::OpenCode, name("tdd")),
            skill_md(SkillRoot::Claude, name("tdd")),
        ] {
            assert_eq!(
                detect_artifact_state(&artifact, &ws, &home),
                (OperationKind::Create, PreviousState::Absent),
                "{artifact:?}"
            );
        }
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn workspace_bundle_wants_no_file_and_its_empty_expansion_is_not_an_error() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let artifacts =
            expand_surface_fail_closed(SetupSurfaceId::WorkspaceBundle, &repo, &SkillScope::all())
                .unwrap();
        assert!(artifacts.is_empty(), "{artifacts:?}");
        let ws = std::env::temp_dir().join(format!(
            "aw-empty-bundle-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        assert!(expand_surfaces_to_artifacts(
            &[SetupSurfaceId::WorkspaceBundle],
            &ws,
            &SkillScope::all()
        )
        .unwrap()
        .is_empty());
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
            finished_at: None,
            receipt: None,
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
            let _guard = crate::test_env::guard::lock();
            let _restore = crate::test_env::guard::EnvRestore::capture();
            unsafe { std::env::remove_var("CODEX_HOME") };
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

    fn codex_agent_artifact() -> ArtifactId {
        ArtifactId::CodexAgent(crate::artifact_registry::AgentName::new("repo-scout").unwrap())
    }

    #[test]
    fn validate_artifact_source_dest_allows_codex_home_outside_home() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let base = temp("codex-home-outside");
        let ws = base.join("ws");
        let home = base.join("home");
        let codex = base.join("elsewhere/codex");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&codex).unwrap();
        unsafe { std::env::set_var("CODEX_HOME", &codex) };

        for artifact in [
            ArtifactId::CodexRules,
            ArtifactId::CodexConfig,
            codex_agent_artifact(),
        ] {
            let (_, dest) = validate_artifact_source_dest(&artifact, &ws, &home)
                .unwrap_or_else(|e| panic!("{artifact:?}: {e}"));
            assert!(dest.starts_with(&codex), "{artifact:?}: {dest:?}");
        }
        // Surfaces that live under home keep their home allowlist.
        let (_, dest) =
            validate_artifact_source_dest(&ArtifactId::ClaudeRules, &ws, &home).unwrap();
        assert!(dest.starts_with(&home), "{dest:?}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_artifact_source_dest_rejects_relative_codex_home() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let base = temp("codex-home-relative");
        let ws = base.join("ws");
        let home = base.join("home");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("CODEX_HOME", "relative/codex") };

        let err = validate_artifact_source_dest(&ArtifactId::CodexRules, &ws, &home)
            .expect_err("relative CODEX_HOME must be rejected");
        assert!(err.contains("CODEX_HOME must be an absolute path"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_flagged_pack_skill_gets_its_own_review_line_naming_its_keys() {
        use crate::artifact_registry::{SkillName, SkillRelPath};
        use crate::skill_discovery::PrivilegedKey;
        use crate::skill_roots::SkillRoot;
        let file = |skill: &str, rel: &str, kind: OperationKind| PlannedArtifact {
            artifact: ArtifactId::skill_file(
                SkillRoot::Claude,
                SkillName::new(skill).unwrap(),
                SkillRelPath::new(rel).unwrap(),
            ),
            surface: SetupSurfaceId::Skills,
            kind,
            previous_state: PreviousState::Absent,
            rollback_action: RollbackAction::RemoveCreatedFile,
            rules: None,
            rules_rewrite: None,
            mcp: None,
            file: None,
            overwrite: None,
        };
        let planned = [
            file("tdd", "SKILL.md", OperationKind::Create),
            file("deploy", "SKILL.md", OperationKind::Create),
            file("deploy", "notes.md", OperationKind::Create),
        ];
        let long = "x".repeat(250);
        let flagged = std::collections::BTreeMap::from([(
            "deploy".to_string(),
            FlaggedSkill {
                pack: "team".to_string(),
                keys: vec![
                    PrivilegedKey {
                        key: "allowed-tools".to_string(),
                        value: "Bash(git *)".to_string(),
                        note: "grants tool access without asking".to_string(),
                    },
                    PrivilegedKey {
                        key: "model".to_string(),
                        value: long,
                        note: String::new(),
                    },
                ],
            },
        )]);
        let lines = skill_plan_details(&planned, &SkillScope::all(), &flagged);
        assert_eq!(
            lines,
            [
                "+ ~/.claude/skills (1 skill, 1 file)".to_string(),
                format!(
                    "+ ~/.claude/skills/deploy (pack team; allowed-tools: Bash(git *) [grants tool \
                     access without asking]; model: {}… (whole value in the Library))",
                    "x".repeat(200)
                ),
            ]
        );
        assert_eq!(
            skill_plan_details(&planned, &SkillScope::all(), &Default::default()),
            ["+ ~/.claude/skills (2 skills, 3 files)"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_transaction_folder_is_trusted_only_without_links_or_shared_write() {
        let base = temp("txn-trust");
        let txn = base.join("setup/123");
        fs::create_dir_all(&txn).unwrap();
        fs::write(txn.join("manifest.json"), b"{}").unwrap();
        check_transaction_folder_trusted(&txn).expect("no artifacts folder is fine");

        fs::write(base.join("planted.json"), b"{}").unwrap();
        fs::remove_file(txn.join("manifest.json")).unwrap();
        std::os::unix::fs::symlink(base.join("planted.json"), txn.join("manifest.json")).unwrap();
        assert_eq!(
            check_transaction_folder_trusted(&txn).unwrap_err(),
            "refusing the setup manifest: it is a link"
        );
        fs::remove_file(txn.join("manifest.json")).unwrap();
        assert_eq!(
            check_transaction_folder_trusted(&txn).unwrap_err(),
            "cannot inspect the setup manifest"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn explicit_rollback_restores_codex_artifact_under_codex_home_outside_home() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let base = temp("codex-home-restore");
        let ws = base.join("ws");
        let home = base.join("home");
        let codex = base.join("elsewhere/codex");
        let backup_dir = base.join("backup");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(codex.join("agents")).unwrap();
        fs::create_dir_all(backup_dir.join("artifacts")).unwrap();
        unsafe { std::env::set_var("CODEX_HOME", &codex) };
        let dest = codex.join("agents/repo-scout.toml");
        fs::write(&dest, "applied").unwrap();
        fs::write(backup_dir.join("artifacts/agent"), "before").unwrap();
        let op = ArtifactManifestOperation {
            artifact: codex_agent_artifact(),
            surface: SetupSurfaceId::CodexAgents,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/agent".into()),
            apply_status: ApplyStatus::Applied,
            ..Default::default()
        };

        restore_artifact_from_backup_with_mode(
            &op,
            &backup_dir,
            &home,
            RollbackRestoreMode::FullBackup,
            Some(&ws),
        )
        .expect("restore under CODEX_HOME");

        assert_eq!(fs::read_to_string(&dest).unwrap(), "before");
        let _ = fs::remove_dir_all(&base);
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
            finished_at: None,
            receipt: None,
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
        let _guard = crate::test_env::guard::lock();
        let home = temp("val-home");
        let ws = temp("val-ws");
        fs::create_dir_all(home.join(".codex")).unwrap();
        let artifact = ArtifactId::CodexRules;
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
        let installed = home.join(".codex/AGENTS.md");
        // An unwrapped file that equals the source still shows a pending update:
        // apply was supposed to put the base in a managed block.
        fs::write(&installed, &source).unwrap();
        let err = validate_artifact_after_apply(&artifact, &ws, &home).unwrap_err();
        assert!(err.contains("Update"), "{err}");
        // A block that differs from the source is no valid outcome either.
        fs::write(&installed, crate::rules_block::render_new("# other base\n")).unwrap();
        assert!(validate_artifact_after_apply(&artifact, &ws, &home).is_err());
        // The source in a block, with user text around it, is.
        fs::write(
            &installed,
            format!("mine\n{}tail\n", crate::rules_block::render_new(&source)),
        )
        .unwrap();
        assert!(validate_artifact_after_apply(&artifact, &ws, &home).is_ok());
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&ws);
    }

    // ── Automatic rollback safety ──

    /// Update of the Codex rules file with a backup holding `original`.
    /// Returns (op, backup_dir, home, ws).
    fn automatic_restore_fixture(
        label: &str,
        original: &str,
        installed: &str,
    ) -> (ArtifactManifestOperation, PathBuf, PathBuf, PathBuf) {
        let base = temp(label);
        let home = base.join("home");
        let ws = base.join("ws");
        let backup_dir = base.join("txn");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(backup_dir.join("artifacts")).unwrap();
        fs::write(backup_dir.join("artifacts/codex-rules"), original).unwrap();
        fs::write(home.join(".codex/AGENTS.md"), installed).unwrap();
        let op = ArtifactManifestOperation {
            artifact: ArtifactId::CodexRules,
            surface: SetupSurfaceId::CodexRules,
            kind: OperationKind::Update,
            previous_state: PreviousState::ManagedFile,
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/codex-rules".into()),
            apply_status: ApplyStatus::InFlight,
            ..Default::default()
        };
        (op, backup_dir, home, ws)
    }

    #[test]
    fn automatic_restore_keeps_user_edit_when_digests_were_never_recorded() {
        let _guard = crate::test_env::guard::lock();
        let (op, backup_dir, home, ws) =
            automatic_restore_fixture("auto-user-edit", "original", "user edit");
        let err = restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err();
        assert_eq!(err, CHANGED_SINCE_APPLY);
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "user edit"
        );
    }

    #[test]
    fn automatic_restore_keeps_a_rules_file_the_whole_of_which_nothing_proves() {
        let _guard = crate::test_env::guard::lock();
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
        // An older manifest: no digest recorded before the write. The managed block matching the
        // source says nothing about the text around it, so the file is not replaced.
        let (op, backup_dir, home, ws) =
            automatic_restore_fixture("auto-unproven", "original", &source);
        let err = restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err();
        assert_eq!(err, CHANGED_SINCE_APPLY);
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            source
        );
    }

    #[test]
    fn automatic_restore_restores_recorded_output_and_skips_original() {
        let _guard = crate::test_env::guard::lock();
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
        let (mut op, backup_dir, home, ws) =
            automatic_restore_fixture("auto-planned", "original", &source);
        op.expected_full_digest = Some(crate::stable_digest::bytes(source.as_bytes()));
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("restore");
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "original"
        );
        // Restoring again is a no-op: the artifact is at its pre-apply state.
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("idempotent");
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "original"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_backup_file_others_can_write_is_never_restored() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = crate::test_env::guard::lock();
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
        let (mut op, backup_dir, home, ws) =
            automatic_restore_fixture("auto-shared-backup", "original", &source);
        op.expected_full_digest = Some(crate::stable_digest::bytes(source.as_bytes()));
        let backup = backup_dir.join("artifacts/codex-rules");
        let dest = home.join(".codex/AGENTS.md");
        let set_mode = |path: &Path, mode: u32| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
        };

        set_mode(&backup, 0o666);
        let refused = "refusing the setup backup: it is writable by its group or by everyone; \
                       run chmod go-w on it";
        assert_eq!(
            restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err(),
            refused
        );
        assert_eq!(
            restore_artifact_from_backup_for_explicit_rollback(&op, &backup_dir, &home, &ws)
                .unwrap_err(),
            refused
        );
        assert_eq!(
            validate_backup_for_rollback(&op, &backup_dir).unwrap_err(),
            refused
        );
        assert_eq!(
            fs::read_to_string(&dest).unwrap(),
            source,
            "nothing restored"
        );

        // Owner-only, as this version writes it, or 0644 as releases before v2026.10.1 left it.
        for mode in [0o600, 0o644] {
            fs::write(&dest, &source).unwrap();
            set_mode(&backup, mode);
            validate_backup_for_rollback(&op, &backup_dir).expect("trusted backup");
            restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("restore");
            assert_eq!(fs::read_to_string(&dest).unwrap(), "original");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_backup_is_trusted_only_when_nothing_below_it_is_shared() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp("shared-backup-tree");
        let tree = base.join("txn/artifacts/skill");
        fs::create_dir_all(tree.join("nested")).unwrap();
        fs::write(tree.join("SKILL.md"), "skill").unwrap();
        fs::write(tree.join("nested/notes.md"), "notes").unwrap();
        let op = ArtifactManifestOperation {
            rollback_action: RollbackAction::RestoreFile,
            backup_rel: Some("artifacts/skill".into()),
            ..Default::default()
        };
        let backup_dir = base.join("txn");
        let set_mode = |path: &Path, mode: u32| {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap()
        };
        for path in [tree.clone(), tree.join("nested")] {
            set_mode(&path, 0o755);
        }
        validate_backup_for_rollback(&op, &backup_dir).expect("0755 folders, 0644 files");
        set_mode(&tree.join("nested/notes.md"), 0o666);
        assert!(validate_backup_for_rollback(&op, &backup_dir)
            .unwrap_err()
            .starts_with("refusing the setup backup: it is writable"));
        set_mode(&tree.join("nested/notes.md"), 0o600);
        set_mode(&tree.join("nested"), 0o777);
        assert!(validate_backup_for_rollback(&op, &backup_dir)
            .unwrap_err()
            .starts_with("refusing the setup backup: it is writable"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn automatic_restore_keeps_edit_made_after_recorded_apply() {
        let _guard = crate::test_env::guard::lock();
        let (mut op, backup_dir, home, ws) =
            automatic_restore_fixture("auto-recorded", "original", "applied");
        let dest = home.join(".codex/AGENTS.md");
        op.apply_status = ApplyStatus::Applied;
        op.post_apply_digest = Some(crate::stable_digest::bytes(b"applied"));
        op.post_apply_full_digest = Some(crate::stable_digest::bytes(b"applied"));
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("unchanged restores");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "original");

        fs::write(&dest, "edited later").unwrap();
        let err = restore_artifact_from_backup(&op, &backup_dir, &home, &ws).unwrap_err();
        assert_eq!(err, CHANGED_SINCE_APPLY);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "edited later");
    }

    #[test]
    fn rollback_after_a_crash_uses_the_digest_recorded_before_the_write() {
        let _guard = crate::test_env::guard::lock();
        // What the app wrote is no longer what the source makes (the source changed since), and
        // no post-apply digest was saved: only the digest recorded before the write proves it.
        let (mut op, backup_dir, home, ws) =
            automatic_restore_fixture("crash-proof", "original", "written by an older source");
        let dest = home.join(".codex/AGENTS.md");
        op.expected_full_digest = Some(crate::stable_digest::bytes(b"written by an older source"));
        validate_update_target_unchanged(&op, &ws, &home).expect("explicit preflight");
        restore_artifact_from_backup_for_explicit_rollback(&op, &backup_dir, &home, &ws)
            .expect("explicit rollback");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "original");

        fs::write(&dest, "written by an older source").unwrap();
        restore_artifact_from_backup(&op, &backup_dir, &home, &ws).expect("automatic rollback");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "original");

        // Anything else is kept, by both.
        fs::write(&dest, "edited after the crash").unwrap();
        for result in [
            restore_artifact_from_backup_for_explicit_rollback(&op, &backup_dir, &home, &ws),
            restore_artifact_from_backup(&op, &backup_dir, &home, &ws),
        ] {
            assert_eq!(result.unwrap_err(), CHANGED_SINCE_APPLY);
        }
        assert_eq!(fs::read_to_string(&dest).unwrap(), "edited after the crash");
    }

    #[test]
    fn restore_file_failure_keeps_the_destination() {
        let _guard = crate::test_env::guard::lock();
        let (mut op, backup_dir, home, ws) =
            automatic_restore_fixture("restore-keeps-dest", "original", "current");
        // A backup that is not a regular file makes the copy fail.
        fs::remove_file(backup_dir.join("artifacts/codex-rules")).unwrap();
        fs::create_dir_all(backup_dir.join("artifacts/codex-rules")).unwrap();
        op.apply_status = ApplyStatus::Applied;
        let err = restore_artifact_from_backup_with_mode(
            &op,
            &backup_dir,
            &home,
            RollbackRestoreMode::FullBackup,
            Some(&ws),
        )
        .expect_err("directory backup cannot be restored");
        assert!(err.contains("restore file"), "{err}");
        assert_eq!(
            fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(),
            "current",
            "failed restore must not delete the destination"
        );
    }

    #[test]
    fn refreshed_record_turns_the_next_source_change_into_update_not_conflict() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let base = temp("stale-record-plan");
        let home = base.join("home");
        let ws = base.join("ws");
        fs::create_dir_all(home.join(".codex")).unwrap();
        crate::test_env::set_test_user_dirs(&home);
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let artifact = ArtifactId::CodexRules;
        let identity = crate::managed_state::artifact_identity(&artifact);

        // Installed == current source, record stale: planned as no change.
        let source = fs::read_to_string(bundled.join("templates/sync/codex-rules.md")).unwrap();
        fs::write(
            home.join(".codex/AGENTS.md"),
            crate::rules_block::render_new(&source),
        )
        .unwrap();
        let stale = crate::managed_state::ManagedState {
            schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![crate::managed_state::ManagedArtifactRecord {
                identity: identity.clone(),
                hash: crate::stable_digest::bytes(b"older shipped version"),
                surface: None,
                role_models: Default::default(),
            }],
        };
        let (kind, _) = detect_artifact_state(&artifact, &ws, &home);
        assert_eq!(kind, OperationKind::NoChange);

        // The next apply refreshes the record from the installed content.
        let refreshed = crate::managed_state::next_state_from_operations(
            Some(&stale),
            &bundled,
            &ws,
            &home,
            &[],
            &[],
        )
        .unwrap();

        // Once the source moves on, the installed file differs from it. Only the
        // refreshed record still proves ownership, so only it yields an update.
        let installed = fs::read(home.join(".codex/AGENTS.md")).unwrap();
        let decide = |state: &crate::managed_state::ManagedState| {
            crate::rules_block::assess(
                Some(&installed),
                "# a newer base\n",
                managed_hash_for(&identity, &state.artifacts).as_deref(),
                &|_| false,
            )
            .plan
        };
        assert_eq!(
            decide(&stale),
            crate::rules_block::RulesPlan::Conflict(
                crate::rules_block::RulesConflict::BaseBlockEdited
            )
        );
        assert_eq!(
            decide(&refreshed),
            crate::rules_block::RulesPlan::UpdateBlock
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn managed_opencode_rollback_removes_added_entries_and_keeps_user_edits_and_order() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        let home = temp("opencode-rollback-home");
        let ws = home.join("workspace");
        let backups = temp("opencode-rollback-backups");
        let backup: serde_json::Value = serde_json::from_str(
            r#"{"theme":"before","model":"old/main","provider":{"z":{},"a":{}},
                "mcp":{"first":{},"last":{}},
                "agent":{"plan":{"model":"mine/plan","prompt":"mine"},
                    "inspector":{"description":"mine","prompt":"keep"},"custom":{}},"keybinds":{}}"#,
        ).unwrap();
        let rendered = serde_json::json!({
            "model":"new/main", "lsp":true, "permission":{"*":"ask"},
            "mcp":{"playwright":{"command":["test-mcp"]}},
            "agent":{"plan":{"permission":{"edit":"deny"}},
                "explore":{"permission":{"edit":"deny"}},
                "inspector":{"model":"new/cheap"},"sentinel":{"model":"new/cheap"}}
        });
        let mut current = crate::commands::merge_managed_opencode_config(&backup, &rendered);
        current["theme"] = serde_json::json!("edited after apply");
        current["agent"]["inspector"]["prompt"] = serde_json::json!("edited after apply");
        current["user_after_apply"] = serde_json::json!({"keep":true});
        current["last_user_key"] = serde_json::json!("keep last");
        let mut expected = backup.clone();
        expected["model"] = current["model"].clone();
        expected["theme"] = current["theme"].clone();
        expected["agent"]["inspector"]["prompt"] = current["agent"]["inspector"]["prompt"].clone();
        expected["user_after_apply"] = current["user_after_apply"].clone();
        expected["last_user_key"] = current["last_user_key"].clone();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(backups.join("artifacts")).unwrap();
        let dest = home.join(".config/opencode/opencode.json");
        let current_text = serde_json::to_string_pretty(&current)
            .unwrap()
            .replace("new/main", r"new/\u006dain");
        fs::write(&dest, current_text).unwrap();
        fs::write(
            backups.join("artifacts/opencode-config"),
            serde_json::to_vec(&backup).unwrap(),
        )
        .unwrap();
        let op = ArtifactManifestOperation {
            artifact: ArtifactId::OpenCodeConfig,
            surface: SetupSurfaceId::OpenCodeConfig,
            kind: OperationKind::Update,
            previous_state: PreviousState::MergeableConfigFile,
            rollback_action: RollbackAction::RestoreManagedConfigFile,
            backup_rel: Some("artifacts/opencode-config".into()),
            ..Default::default()
        };
        restore_artifact_from_backup_with_mode(
            &op,
            &backups,
            &home,
            RollbackRestoreMode::ManagedProjectionMerge,
            Some(&ws),
        )
        .unwrap();
        let restored: serde_json::Value =
            serde_json::from_slice(&fs::read(&dest).unwrap()).unwrap();
        assert!(fs::read_to_string(&dest)
            .unwrap()
            .contains(r"new/\u006dain"));
        // String comparison checks the order of every retained user object as well as values.
        assert_eq!(
            serde_json::to_string(&restored).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
        for dir in [&home, &backups] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// Rollback puts back the role models an apply changed, the user's own and the ones the app
    /// recorded writing, and the backup check agrees with the restored file.
    #[test]
    fn managed_opencode_rollback_restores_role_models_and_matches_the_backup() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp("opencode-role-rollback-home");
        let backups = temp("opencode-role-rollback-backups");
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        crate::test_env::set_test_user_dirs(&home);
        let ws = home.join("workspace");
        let dest = home.join(".config/opencode/opencode.json");
        fs::create_dir_all(backups.join("artifacts")).unwrap();
        let op = ArtifactManifestOperation {
            artifact: ArtifactId::OpenCodeConfig,
            surface: SetupSurfaceId::OpenCodeConfig,
            kind: OperationKind::Update,
            previous_state: PreviousState::MergeableConfigFile,
            rollback_action: RollbackAction::RestoreManagedConfigFile,
            backup_rel: Some("artifacts/opencode-config".into()),
            ..Default::default()
        };
        let record = |role_models: &[(&str, &str)]| {
            let state = crate::managed_state::ManagedState {
                schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: vec![crate::managed_state::ManagedArtifactRecord {
                    identity: crate::managed_state::artifact_identity(&ArtifactId::OpenCodeConfig),
                    hash: crate::stable_digest::bytes(b"record"),
                    surface: None,
                    role_models: role_models
                        .iter()
                        .map(|(role, model)| (role.to_string(), model.to_string()))
                        .collect(),
                }],
            };
            crate::managed_state::write_managed_state_atomic(&ws, &state).unwrap();
        };
        let roll_back = |backup: &serde_json::Value, current: &serde_json::Value| {
            fs::write(
                backups.join("artifacts/opencode-config"),
                serde_json::to_vec(backup).unwrap(),
            )
            .unwrap();
            fs::write(&dest, serde_json::to_vec_pretty(current).unwrap()).unwrap();
            assert!(!artifact_matches_previous_backup_state(&op, &backups, &home, &ws).unwrap());
            restore_artifact_from_backup_with_mode(
                &op,
                &backups,
                &home,
                RollbackRestoreMode::ManagedProjectionMerge,
                Some(&ws),
            )
            .unwrap();
            assert!(artifact_matches_previous_backup_state(&op, &backups, &home, &ws).unwrap());
            serde_json::from_slice::<serde_json::Value>(&fs::read(&dest).unwrap()).unwrap()
        };

        // An override pinned every role over the user's own inspector model.
        crate::commands::update_opencode_model_selection(
            "main/large".to_string(),
            "main/small".to_string(),
            Some("cheap/fast".to_string()),
            None,
        )
        .unwrap();
        record(&[]);
        let backup = serde_json::json!({"agent": {"inspector": {"model": "mine/pin"}}});
        let mut current = serde_json::json!({"agent": {}});
        for role in ["repo-scout", "inspector", "sentinel", "verifier", "scribe"] {
            current["agent"][role] = serde_json::json!({"model": "cheap/fast"});
        }
        assert_eq!(roll_back(&backup, &current), backup);

        // After a reset an apply removed the scribe model the app recorded writing.
        crate::commands::reset_opencode_model_selection().unwrap();
        record(&[("scribe", "cheap/fast")]);
        let backup = serde_json::json!({
            "agent": {"scribe": {"model": "cheap/fast"}, "inspector": {"model": "mine/pin"}}
        });
        let current = serde_json::json!({"agent": {"inspector": {"model": "mine/pin"}}});
        assert_eq!(
            roll_back(&backup, &current)["agent"]["scribe"]["model"],
            "cheap/fast"
        );

        for dir in [&home, &backups] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_codex_rollback_never_runs_workspace_scripts() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe { std::env::remove_var("CODEX_HOME") };

        let home = temp("codex-rollback-home");
        let ws = temp("codex-rollback-ws");
        let backups = temp("codex-rollback-backups");
        let sentinel = temp("codex-rollback-sentinel");
        let malicious = format!(
            "#!/usr/bin/env python3\nopen('{}', 'w').write('executed')\n",
            sentinel.display()
        );
        for script in ["merge-codex-config.py", "ensure-codex-routing-defaults.py"] {
            fs::create_dir_all(ws.join("scripts")).unwrap();
            fs::write(ws.join("scripts").join(script), &malicious).unwrap();
        }
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            "approval_policy = \"never\"\n",
        )
        .unwrap();
        fs::create_dir_all(backups.join("artifacts")).unwrap();
        fs::write(
            backups.join("artifacts/codex-config"),
            "approval_policy = \"on-request\"\n",
        )
        .unwrap();
        let op = ArtifactManifestOperation {
            artifact: ArtifactId::CodexConfig,
            surface: SetupSurfaceId::CodexConfig,
            kind: OperationKind::Update,
            previous_state: PreviousState::MergeableConfigFile,
            rollback_action: RollbackAction::RestoreManagedConfigFile,
            backup_rel: Some("artifacts/codex-config".into()),
            ..Default::default()
        };

        let result = restore_artifact_from_backup_with_mode(
            &op,
            &backups,
            &home,
            RollbackRestoreMode::ManagedProjectionMerge,
            Some(&ws),
        );
        let sentinel_created = sentinel.exists();
        let restored = fs::read_to_string(home.join(".codex/config.toml")).unwrap_or_default();
        for dir in [&home, &ws, &backups] {
            let _ = fs::remove_dir_all(dir);
        }
        let _ = fs::remove_file(&sentinel);

        assert!(
            !sentinel_created,
            "a merge script inside the workspace must never run"
        );
        result.expect("the bundled merge scripts render the rollback");
        assert!(restored.contains("approval_policy"), "{restored}");
    }

    fn shipped_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = temp(label);
        let home = base.join("home");
        let ws = base.join("ws");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&ws).unwrap();
        (base, home, ws)
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn inject_shipped(key: &str, bytes: &[u8]) -> crate::shipped_digests::test_override::Guard {
        crate::shipped_digests::test_override::inject(
            &crate::shipped_digests::test_override::json_for(
                key,
                &[crate::stable_digest::bytes(bytes)],
            ),
        )
    }

    #[test]
    fn stale_artifact_that_is_a_shipped_version_is_removed_with_or_without_a_record() {
        let (base, home, ws) = shipped_fixture("stale-shipped");
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let retired = crate::managed_bootstrap::REMOVED_SKILL_NAMES[0];
        let artifact = ArtifactId::skill_md(
            SkillRoot::Claude,
            crate::artifact_registry::SkillName::new(retired).unwrap(),
        );
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        let shipped = b"a version the app shipped\n";
        let key = format!("skills/{retired}/SKILL.md");
        let _inject = inject_shipped(&key, shipped);
        let other_record = crate::stable_digest::bytes(b"an older recorded hash");
        let detect = |record: Option<&str>| {
            detect_stale_artifact_state(&artifact, &ws, &bundled, &home, record)
        };
        let remove = (OperationKind::Remove, PreviousState::ManagedFile);
        let conflict = (OperationKind::Conflict, PreviousState::Conflict);

        write_file(&dest, shipped);
        assert_eq!(detect(None), remove);
        assert_eq!(detect(Some(&other_record)), remove);
        assert_eq!(
            detect(Some(&crate::stable_digest::bytes(shipped))),
            remove,
            "a matching record is proof on its own"
        );

        // Anything the app never shipped keeps today's behaviour.
        write_file(&dest, b"the user edited this\n");
        assert_eq!(detect(None), conflict);
        assert_eq!(detect(Some(&other_record)), conflict);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn stale_artifact_ownership_ignores_metadata_that_does_not_parse() {
        let (base, home, ws) = shipped_fixture("stale-malformed");
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let retired = crate::managed_bootstrap::REMOVED_SKILL_NAMES[0];
        let artifact = ArtifactId::skill_md(
            SkillRoot::Claude,
            crate::artifact_registry::SkillName::new(retired).unwrap(),
        );
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        write_file(&dest, b"a version the app shipped\n");
        let _inject = crate::shipped_digests::test_override::inject("{ not json");
        assert_eq!(
            detect_stale_artifact_state(&artifact, &ws, &bundled, &home, None),
            (OperationKind::Conflict, PreviousState::Conflict)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_shipped_copy_in_the_old_codex_folder_is_removed_whatever_else_is_installed() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let (base, home, ws) = shipped_fixture("legacy-shipped");
        crate::test_env::set_test_user_dirs(&home);
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let name = crate::artifact_registry::SkillName::new("tdd").unwrap();
        let old = ArtifactId::skill_md(SkillRoot::CodexHome, name.clone());
        let other = ArtifactId::skill_md(SkillRoot::Agents, name);
        let shipped = b"a version the app shipped\n";
        let _inject = inject_shipped("templates/skills/codex/tdd/SKILL.md", shipped);
        write_file(&old.resolve_dest(&home, &ws).unwrap(), shipped);
        let detect = |artifact: &ArtifactId| {
            detect_stale_artifact_state(artifact, &ws, &bundled, &home, None)
        };
        let remove = (OperationKind::Remove, PreviousState::ManagedFile);

        assert_eq!(detect(&old), remove);
        // A different copy in the folder Codex reads now does not change that: each file is
        // judged on its own bytes.
        write_file(
            &other.resolve_dest(&home, &ws).unwrap(),
            b"the user's own copy\n",
        );
        assert_eq!(detect(&old), remove);
        // The user's copy is not proven app-owned and is kept.
        assert_eq!(
            detect(&other),
            (OperationKind::Conflict, PreviousState::Conflict)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn recorded_hash_mismatch_is_an_update_only_for_a_shipped_version() {
        let (base, home, ws) = shipped_fixture("refine-shipped");
        let bundled = crate::setup_roots::bundled_root().unwrap();
        let artifact =
            ArtifactId::ClaudeAgent(crate::artifact_registry::AgentName::new("verifier").unwrap());
        let dest = artifact.resolve_dest(&home, &ws).unwrap();
        let shipped = b"an older verifier agent\n";
        let _inject = inject_shipped("templates/claude/agents/verifier.md", shipped);
        let stale_record = crate::stable_digest::bytes(b"an even older recorded hash");
        let refine = |record: Option<&str>| {
            refine_with_managed_hash(
                OperationKind::Update,
                PreviousState::ManagedFile,
                &artifact,
                &ws,
                &bundled,
                &home,
                record,
            )
        };

        write_file(&dest, shipped);
        assert_eq!(
            refine(Some(&stale_record)),
            (OperationKind::Update, PreviousState::ManagedFile)
        );
        write_file(&dest, b"the user edited this\n");
        assert_eq!(
            refine(Some(&stale_record)),
            (OperationKind::Conflict, PreviousState::Conflict)
        );
        let _ = fs::remove_dir_all(base);
    }

    // ── Skill files ──

    fn bundled_repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    /// Every artifact the bundle can install, skill files in every root included, and every old
    /// copy of the bundle a workspace cleanup backs up.
    fn every_bundled_artifact() -> Vec<ArtifactId> {
        let repo = bundled_repo();
        let mut artifacts = Vec::new();
        for surface in SetupSurfaceId::ALL {
            artifacts
                .extend(expand_surface_fail_closed(*surface, &repo, &SkillScope::all()).unwrap());
        }
        artifacts.extend(
            crate::commands::retired_workspace_files::workspace_copy_paths().map(|rel| {
                ArtifactId::WorkspaceFile(
                    crate::artifact_registry::WorkspaceRelPath::new(rel).unwrap(),
                )
            }),
        );
        artifacts
    }

    #[test]
    fn backup_ids_are_unique_across_the_bundle_and_within_the_length_cap() {
        let artifacts = every_bundled_artifact();
        let mut seen = HashSet::new();
        for artifact in &artifacts {
            let id = artifact_backup_rel(artifact);
            assert!(id.len() <= 120, "{id}");
            assert!(seen.insert(id.clone()), "{id} names two artifacts");
        }
        assert!(artifacts.len() > 300, "{}", artifacts.len());
    }

    #[test]
    fn skill_backup_ids_cannot_collide_through_dashes_underscores_or_slashes() {
        let file = |root, skill: &str, rel: &str| {
            artifact_backup_rel(&ArtifactId::skill_file(
                root,
                crate::artifact_registry::SkillName::new(skill).unwrap(),
                crate::artifact_registry::SkillRelPath::new(rel).unwrap(),
            ))
        };
        let ids = [
            file(SkillRoot::Claude, "a-b", "c"),
            file(SkillRoot::Claude, "a", "b-c"),
            file(SkillRoot::Claude, "a", "b/c"),
            file(SkillRoot::Claude, "a", "b__c"),
            file(SkillRoot::Claude, "a", "b_c"),
            file(SkillRoot::CodexHome, "a", "b/c"),
            file(SkillRoot::Agents, "a", "b/c"),
        ];
        let unique: HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "{ids:?}");
    }

    #[test]
    fn a_backup_id_over_the_cap_keeps_a_digest_of_the_whole_id() {
        let rel = |name: &str| {
            artifact_backup_rel(&ArtifactId::WorkspaceFile(
                crate::artifact_registry::WorkspaceRelPath::new(format!(
                    "docs/{}/{name}.md",
                    "long-directory-name".repeat(8)
                ))
                .unwrap(),
            ))
        };
        let (first, second) = (rel("first"), rel("second"));
        assert!(first.len() <= 120 && second.len() <= 120);
        assert_ne!(
            first, second,
            "ids that differ only past the cap stay distinct"
        );
    }

    #[test]
    fn removing_a_skill_file_removes_the_directories_it_empties_up_to_the_skill_root_only() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let base = temp("empty-skill-dirs");
        let home = base.join("home");
        fs::create_dir_all(&home).unwrap();
        crate::test_env::set_test_user_dirs(&home);
        let ws = base.join("ws");
        let name = crate::artifact_registry::SkillName::new("some-skill").unwrap();
        let artifact = |rel: &str| {
            ArtifactId::skill_file(
                SkillRoot::Claude,
                name.clone(),
                crate::artifact_registry::SkillRelPath::new(rel).unwrap(),
            )
        };
        let skills = home.join(".claude/skills");
        let clean = |artifact: &ArtifactId| {
            let dest = artifact.resolve_dest(&home, &ws).unwrap();
            fs::remove_file(&dest).unwrap();
            remove_empty_skill_directories(artifact, &dest, &home, &home).unwrap();
        };

        // Emptied directories go, from the file's own up to the skill's.
        let deep = artifact("assets/deep/page.html");
        write_file(&deep.resolve_dest(&home, &ws).unwrap(), b"x");
        clean(&deep);
        assert!(!skills.join("some-skill").exists());
        assert!(skills.is_dir(), "the skill root is never removed");

        // A foreign file keeps its directory and everything above it.
        let owned = artifact("assets/deep/page.html");
        write_file(&owned.resolve_dest(&home, &ws).unwrap(), b"x");
        write_file(&skills.join("some-skill/assets/mine.md"), b"mine");
        clean(&owned);
        assert!(!skills.join("some-skill/assets/deep").exists());
        assert!(skills.join("some-skill/assets/mine.md").is_file());

        // A sibling file of the skill keeps the skill directory.
        fs::remove_file(skills.join("some-skill/assets/mine.md")).unwrap();
        fs::remove_dir(skills.join("some-skill/assets")).unwrap();
        let md = artifact("SKILL.md");
        write_file(&md.resolve_dest(&home, &ws).unwrap(), b"x");
        write_file(&skills.join("some-skill/notes.md"), b"mine");
        clean(&md);
        assert!(skills.join("some-skill/notes.md").is_file());

        // Anything that is not a skill file is left alone.
        let rules_dir = home.join(".claude");
        remove_empty_skill_directories(
            &ArtifactId::ClaudeRules,
            &rules_dir.join("x"),
            &home,
            &home,
        )
        .unwrap();
        assert!(rules_dir.is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_stale_artifact_at_a_wanted_destination_is_planned_once_as_the_wanted_one() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let (base, home, ws) = shipped_fixture("same-destination");
        crate::test_env::set_test_user_dirs(&home);
        // Codex reads the folder that older versions cleaned up as legacy: both roots coincide.
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::set_var("CODEX_SKILLS_PATH", home.join(".agents/skills"));
        }
        let name = crate::artifact_registry::SkillName::new("tdd").unwrap();
        let wanted = ArtifactId::skill_md(SkillRoot::CodexHome, name.clone());
        let legacy = ArtifactId::skill_md(SkillRoot::Agents, name);
        let dest = wanted.resolve_dest(&home, &ws).unwrap();
        assert_eq!(dest, legacy.resolve_dest(&home, &ws).unwrap());
        let source = fs::read(
            wanted
                .resolve_source(&crate::setup_roots::bundled_root().unwrap())
                .unwrap(),
        )
        .unwrap();
        write_file(&dest, &source);
        let state = crate::managed_state::ManagedState {
            schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: [&wanted, &legacy]
                .iter()
                .map(|artifact| crate::managed_state::ManagedArtifactRecord {
                    identity: crate::managed_state::artifact_identity(artifact),
                    hash: crate::stable_digest::bytes(&source),
                    surface: None,
                    role_models: Default::default(),
                })
                .collect(),
        };
        crate::managed_state::write_managed_state_atomic(&ws, &state).unwrap();

        let scope = SkillScope::of(&[SkillRoot::CodexHome]);
        let planned = plan_artifacts_for_surfaces_in(&[SetupSurfaceId::Skills], &ws, &home, &scope)
            .expect("plan");
        let for_dest: Vec<_> = planned
            .iter()
            .filter(|operation| operation.artifact.resolve_dest(&home, &ws).as_ref() == Ok(&dest))
            .collect();
        assert_eq!(for_dest.len(), 1, "{for_dest:?}");
        assert_eq!(for_dest[0].artifact, wanted);
        assert_eq!(for_dest[0].kind, OperationKind::NoChange);
        let _ = fs::remove_dir_all(base);
    }
}
