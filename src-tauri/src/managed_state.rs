//! Compact managed artifact state for setup reconciliation.
//!
//! Records only app-owned artifacts that Agent Workspace has successfully applied.
//! Unknown files are never added merely because they live inside a managed parent.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::{expand_surface, ArtifactId};
use crate::setup_fingerprint::{self, ABSENT_DIGEST};
use crate::setup_lifecycle::SetupSurfaceId;

pub const MANAGED_STATE_SCHEMA_VERSION: u32 = 1;
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

impl ManagedState {
    #[allow(dead_code)]
    pub fn empty() -> Self {
        Self {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: String::new(),
            artifacts: Vec::new(),
        }
    }

    #[allow(dead_code)]
    pub fn by_identity(&self) -> HashMap<&str, &ManagedArtifactRecord> {
        self.artifacts
            .iter()
            .map(|a| (a.identity.as_str(), a))
            .collect()
    }
}

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
    if !path.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let state: ManagedState = serde_json::from_str(&raw).ok()?;
    if state.schema_version != MANAGED_STATE_SCHEMA_VERSION {
        return None;
    }
    Some(state)
}

/// Atomic write with backup of the previous state file when present.
pub fn write_managed_state_atomic(
    workspace_root: &Path,
    state: &ManagedState,
) -> Result<(), String> {
    let path = managed_state_path(workspace_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create managed-state parent: {e}"))?;
    }
    crate::path_safety::reject_symlink(&path, "managed-state")?;
    let json =
        serde_json::to_string_pretty(state).map_err(|e| format!("serialize managed-state: {e}"))?;
    let _: ManagedState =
        serde_json::from_str(&json).map_err(|e| format!("validate managed-state json: {e}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, &json).map_err(|e| format!("write managed-state temp: {e}"))?;
    fs::rename(&temp, &path).map_err(|e| format!("replace managed-state: {e}"))?;
    Ok(())
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

pub fn resolve_bundled_root(workspace_root: &Path) -> PathBuf {
    if workspace_root.join("skills").is_dir() {
        workspace_root.to_path_buf()
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }
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
    workspace_root: &Path,
    home: &Path,
    bundled_root: &Path,
) -> Result<String, String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for artifact in canonical_harness_artifacts(workspace_root)? {
        let digest = setup_fingerprint::artifact_source_digest(&artifact, workspace_root, home)?;
        artifact_identity(&artifact).hash(&mut hasher);
        digest.hash(&mut hasher);
    }
    for rel in canonical_workspace_file_paths() {
        let src = bundled_root.join(rel);
        if src.is_file() {
            rel.hash(&mut hasher);
            let bytes = fs::read(&src).map_err(|e| format!("read bundled {rel}: {e}"))?;
            bytes.hash(&mut hasher);
        }
    }
    Ok(format!("{:016x}", hasher.finish()))
}

/// Build managed records from current installed state after a successful update.
pub fn build_managed_state_from_installed(
    workspace_root: &Path,
    home: &Path,
    bundled_root: &Path,
) -> Result<ManagedState, String> {
    let bundled_version = compute_bundled_version(workspace_root, home, bundled_root)?;
    let mut artifacts = Vec::new();

    for artifact in canonical_harness_artifacts(workspace_root)? {
        let hash =
            setup_fingerprint::artifact_installed_managed_digest(&artifact, workspace_root, home)?;
        if hash == ABSENT_DIGEST {
            continue;
        }
        artifacts.push(ManagedArtifactRecord {
            identity: artifact_identity(&artifact),
            hash,
            surface: Some(format!("{:?}", artifact.surface()).to_lowercase()),
        });
    }

    for rel in canonical_workspace_file_paths() {
        let dest = workspace_root.join(rel);
        if !dest.is_file() {
            continue;
        }
        let hash = setup_fingerprint::hash_file_path(&dest)?;
        artifacts.push(ManagedArtifactRecord {
            identity: workspace_file_identity(rel),
            hash,
            surface: None,
        });
    }

    artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
    Ok(ManagedState {
        schema_version: MANAGED_STATE_SCHEMA_VERSION,
        bundled_version,
        artifacts,
    })
}

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
            bundled_version: "abc123".into(),
            artifacts: vec![ManagedArtifactRecord {
                identity: "workspace:file:README.md".into(),
                hash: "deadbeef".into(),
                surface: None,
            }],
        };
        write_managed_state_atomic(&root, &state).unwrap();
        let read = read_managed_state(&root).expect("read back");
        assert_eq!(read, state);
    }
}
