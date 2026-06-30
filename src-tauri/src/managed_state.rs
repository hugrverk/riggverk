//! Compact managed artifact state for setup reconciliation.
//!
//! Records only app-owned artifacts that Agent Workspace has successfully applied.
//! Unknown files are never added merely because they live inside a managed parent.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::{expand_surface, ArtifactId};
use crate::setup_fingerprint;
use crate::setup_lifecycle::SetupSurfaceId;

pub const MANAGED_STATE_SCHEMA_VERSION: u32 = 2;
pub const MANAGED_STATE_REL: &str = ".agent-workspace/managed-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedArtifactRecord {
    /// Stable logical identity (serialized ArtifactId or workspace rel path key).
    pub identity: String,
    /// Managed content digest after last successful apply.
    pub hash: String,
    /// Setup surface when the artifact is harness-owned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedState {
    pub schema_version: u32,
    /// Fingerprint of the canonical bundled inventory at last successful update.
    pub bundled_version: String,
    pub artifacts: Vec<ManagedArtifactRecord>,
}

static STATE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn managed_state_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(MANAGED_STATE_REL)
}

pub fn artifact_identity(artifact: &ArtifactId) -> String {
    match artifact {
        ArtifactId::WorkspaceFile(rel) => workspace_file_identity(rel.as_str()),
        _ => serde_json::to_string(artifact).unwrap_or_else(|_| format!("{artifact:?}")),
    }
}

pub fn workspace_file_identity(rel_path: &str) -> String {
    format!("workspace:file:{rel_path}")
}

pub fn read_managed_state(workspace_root: &Path) -> Option<ManagedState> {
    let path = managed_state_path(workspace_root);
    crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "managed-state").ok()?;
    if !path.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let state: ManagedState = serde_json::from_str(&raw).ok()?;
    if state.schema_version != MANAGED_STATE_SCHEMA_VERSION {
        return None;
    }
    if state
        .artifacts
        .iter()
        .any(|artifact| !crate::stable_digest::valid(&artifact.hash))
        || !crate::stable_digest::valid(&state.bundled_version)
    {
        return None;
    }
    Some(state)
}

/// Atomic write with backup of the previous state file when present.
pub fn write_managed_state_atomic(
    workspace_root: &Path,
    state: &ManagedState,
) -> Result<(), String> {
    validate_state(state)?;
    let json =
        serde_json::to_vec_pretty(state).map_err(|e| format!("serialize managed-state: {e}"))?;
    write_managed_state_raw_atomic(workspace_root, &json)
}

pub fn write_managed_state_raw_atomic(workspace_root: &Path, raw: &[u8]) -> Result<(), String> {
    let state: ManagedState =
        serde_json::from_slice(raw).map_err(|e| format!("parse managed-state: {e}"))?;
    validate_state(&state)?;
    write_raw_atomic(workspace_root, raw)
}

pub fn restore_managed_state_raw_atomic(workspace_root: &Path, raw: &[u8]) -> Result<(), String> {
    let _: serde_json::Value =
        serde_json::from_slice(raw).map_err(|e| format!("parse previous managed-state: {e}"))?;
    write_raw_atomic(workspace_root, raw)
}

fn write_raw_atomic(workspace_root: &Path, raw: &[u8]) -> Result<(), String> {
    let path = managed_state_path(workspace_root);
    crate::path_safety::reject_path_escape(&path, workspace_root, "managed-state")?;
    crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "managed-state")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create managed-state parent: {e}"))?;
    }
    crate::path_safety::reject_symlink(&path, "managed-state")?;
    crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "managed-state")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = STATE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!(
        "json.{}.{}.{}.tmp",
        std::process::id(),
        nonce,
        sequence
    ));
    crate::path_safety::reject_path_escape(&temp, workspace_root, "managed-state temporary file")?;
    crate::path_safety::reject_symlink_parent_chain(
        &temp,
        workspace_root,
        "managed-state temporary file",
    )?;
    crate::path_safety::reject_symlink(&temp, "managed-state temporary file")?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("create managed-state temp: {e}"))?;
    output
        .write_all(raw)
        .map_err(|e| format!("write managed-state temp: {e}"))?;
    output
        .sync_all()
        .map_err(|e| format!("flush managed-state temp: {e}"))?;
    drop(output);
    fs::rename(&temp, &path).map_err(|e| format!("replace managed-state: {e}"))?;
    if let Some(parent) = path.parent() {
        flush_parent_directory(parent)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn flush_parent_directory(parent: &Path) -> Result<(), String> {
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| format!("flush managed-state parent: {e}"))
}

#[cfg(windows)]
fn flush_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

fn validate_state(state: &ManagedState) -> Result<(), String> {
    if state.schema_version != MANAGED_STATE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported managed-state schema {}",
            state.schema_version
        ));
    }
    if !crate::stable_digest::valid(&state.bundled_version) {
        return Err("invalid bundled managed-state digest".to_string());
    }
    let mut identities = HashSet::new();
    for artifact in &state.artifacts {
        if artifact.identity.is_empty()
            || !identities.insert(artifact.identity.as_str())
            || !crate::stable_digest::valid(&artifact.hash)
        {
            return Err("invalid managed-state artifact record".to_string());
        }
    }
    Ok(())
}

pub fn next_state_from_operations(
    previous: Option<&ManagedState>,
    bundled_root: &Path,
    runtime_root: &Path,
    home: &Path,
    operations: &[crate::setup_transaction::ArtifactManifestOperation],
    selected: &[crate::setup_transaction::PlannedArtifact],
) -> Result<ManagedState, String> {
    let mut records: HashMap<String, ManagedArtifactRecord> = previous
        .into_iter()
        .flat_map(|state| state.artifacts.iter().cloned())
        .map(|record| (record.identity.clone(), record))
        .collect();
    for operation in operations {
        let identity = artifact_identity(&operation.artifact);
        match operation.kind {
            crate::setup_lifecycle::OperationKind::Create
            | crate::setup_lifecycle::OperationKind::Update => {
                let hash = operation
                    .post_apply_digest
                    .clone()
                    .ok_or_else(|| format!("missing validated digest for {identity}"))?;
                records.insert(
                    identity.clone(),
                    ManagedArtifactRecord {
                        identity,
                        hash,
                        surface: serde_json::to_value(operation.surface)
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string)),
                    },
                );
            }
            crate::setup_lifecycle::OperationKind::Remove => {
                records.remove(&identity);
            }
            _ => {}
        }
    }
    for planned in selected
        .iter()
        .filter(|planned| planned.kind == crate::setup_lifecycle::OperationKind::NoChange)
    {
        let identity = artifact_identity(&planned.artifact);
        if records.contains_key(&identity) {
            continue;
        }
        let expected =
            setup_fingerprint::artifact_source_digest(&planned.artifact, bundled_root, home)?;
        let installed = setup_fingerprint::artifact_installed_managed_digest(
            &planned.artifact,
            runtime_root,
            home,
        )?;
        if expected != installed || installed == setup_fingerprint::ABSENT_DIGEST {
            return Err(format!("cannot adopt unverified exact artifact {identity}"));
        }
        records.insert(
            identity.clone(),
            ManagedArtifactRecord {
                identity,
                hash: installed,
                surface: serde_json::to_value(planned.surface)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string)),
            },
        );
    }
    let mut artifacts: Vec<_> = records.into_values().collect();
    artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
    Ok(ManagedState {
        schema_version: MANAGED_STATE_SCHEMA_VERSION,
        bundled_version: compute_bundled_version(bundled_root, home, bundled_root)?,
        artifacts,
    })
}

/// Collect canonical harness artifact IDs for all managed surfaces.
pub fn canonical_harness_artifacts(workspace_root: &Path) -> Result<Vec<ArtifactId>, String> {
    let surfaces: Vec<SetupSurfaceId> = SetupSurfaceId::ALL
        .iter()
        .filter(|s| !matches!(s, SetupSurfaceId::WorkspaceBundle))
        .copied()
        .collect();
    let mut artifacts = Vec::new();
    let mut seen = HashSet::new();
    for surface in surfaces {
        for artifact in expand_surface(surface, workspace_root)? {
            if seen.insert(artifact.clone()) {
                artifacts.push(artifact);
            }
        }
    }
    Ok(artifacts)
}

/// Logical identities for all current canonical artifacts (from bundled sources).
pub fn canonical_artifact_identities(bundled_root: &Path) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for artifact in canonical_harness_artifacts(bundled_root)? {
        ids.insert(artifact_identity(&artifact));
    }
    for rel in canonical_workspace_file_paths() {
        ids.insert(workspace_file_identity(rel));
    }
    Ok(ids)
}

/// Collect canonical workspace file relative paths from the bundled manifest.
pub fn canonical_workspace_file_paths() -> Vec<&'static str> {
    crate::commands::default_workspace_files()
        .into_iter()
        .flat_map(|(_, paths)| paths.iter().copied())
        .filter(|rel| !rel.contains("..") && !rel.is_empty() && !Path::new(rel).is_absolute())
        .collect()
}

pub fn compute_bundled_version(
    _workspace_root: &Path,
    home: &Path,
    bundled_root: &Path,
) -> Result<String, String> {
    let mut input = Vec::new();
    for artifact in canonical_harness_artifacts(bundled_root)? {
        let digest = setup_fingerprint::artifact_source_digest(&artifact, bundled_root, home)?;
        input.extend_from_slice(artifact_identity(&artifact).as_bytes());
        input.push(0);
        input.extend_from_slice(digest.as_bytes());
        input.push(0xff);
    }
    for rel in canonical_workspace_file_paths() {
        let src = bundled_root.join(rel);
        if src.is_file() {
            input.extend_from_slice(rel.as_bytes());
            input.push(0);
            let bytes = fs::read(&src).map_err(|e| format!("read bundled {rel}: {e}"))?;
            input.extend_from_slice(&bytes);
            input.push(0xff);
        }
    }
    Ok(crate::stable_digest::bytes(&input))
}

/// Build managed records from current installed state after a successful update.
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("managed-state-{label}-{nonce}"))
    }

    #[test]
    fn round_trip_managed_state() {
        let root = temp_dir("round-trip");
        fs::create_dir_all(root.join(".agent-workspace")).unwrap();
        let state = ManagedState {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![ManagedArtifactRecord {
                identity: "workspace:file:README.md".into(),
                hash: crate::stable_digest::bytes(b"artifact"),
                surface: None,
            }],
        };
        write_managed_state_atomic(&root, &state).unwrap();
        let read = read_managed_state(&root).expect("read back");
        assert_eq!(read, state);
    }

    #[test]
    fn schema_one_is_not_trusted() {
        let root = temp_dir("schema-one");
        fs::create_dir_all(root.join(".agent-workspace")).unwrap();
        fs::write(
            managed_state_path(&root),
            r#"{"schema_version":1,"bundled_version":"legacy","artifacts":[]}"#,
        )
        .unwrap();
        assert!(read_managed_state(&root).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn managed_state_symlink_is_not_trusted_or_overwritten() {
        let root = temp_dir("symlink");
        fs::create_dir_all(root.join(".agent-workspace")).unwrap();
        let outside = root.join("outside.json");
        fs::write(&outside, "{}").unwrap();
        std::os::unix::fs::symlink(&outside, managed_state_path(&root)).unwrap();
        assert!(read_managed_state(&root).is_none());
        let state = ManagedState {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![],
        };
        assert!(write_managed_state_atomic(&root, &state)
            .unwrap_err()
            .contains("symlink"));
        let _ = fs::remove_dir_all(root);
    }
}
