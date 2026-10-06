//! One-time bootstrap of managed ownership from pre-manifest installations.
//!
//! Does not create a permanent historical-version framework. Runs only when
//! managed-state.json is absent and infers ownership from known old surfaces.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::agent_skill_targets::{codex_legacy_skills_dest, validate_skill_name};
use crate::artifact_registry::{AgentName, ArtifactId, SkillName, WorkspaceRelPath};
use crate::managed_state::{artifact_identity, workspace_file_identity, ManagedArtifactRecord};
use crate::setup_fingerprint::{self, ABSENT_DIGEST};

/// Skills removed from the canonical 21-skill bundle (old 33-skill installations).
pub const REMOVED_SKILL_NAMES: &[&str] = &[
    "agent-report-review",
    "caveman",
    "dependency-evaluation",
    "grill-me",
    "grill-with-docs",
    "improve-codebase-architecture",
    "nextjs-product-slice",
    "supabase-rls-review",
    "to-prd",
    "triage",
    "woocommerce-pdp-review",
    "write-a-skill",
];

/// Legacy agent file retired in favor of repo-scout.
pub const LEGACY_SCOUT_AGENT: &str = "scout";

/// Bootstrap metadata paths to remove after successful update.
pub const BOOTSTRAP_METADATA_PATHS: &[&str] = &["metadata/deprecated-skills.json"];

#[derive(Debug, Deserialize)]
struct HistoricalOwnershipManifest {
    migration_id: String,
    source_commit: String,
    artifacts: Vec<HistoricalOwnershipArtifact>,
}

#[derive(Debug, Deserialize)]
struct HistoricalOwnershipArtifact {
    identity: String,
    path_classes: Vec<String>,
    digests: Vec<String>,
    action: String,
}

fn historical_manifest() -> Result<HistoricalOwnershipManifest, String> {
    let manifest: HistoricalOwnershipManifest = serde_json::from_str(include_str!(
        "../../resources/default-workspace/metadata/pre-manifest-ownership.json"
    ))
    .map_err(|e| format!("parse pre-manifest ownership metadata: {e}"))?;
    if manifest.migration_id.is_empty()
        || manifest.source_commit != "2d85d94b6f2f1dc06f45f6ec52a22ae97e499588"
        || manifest.artifacts.is_empty()
    {
        return Err("invalid pre-manifest ownership metadata header".to_string());
    }
    for artifact in &manifest.artifacts {
        if artifact.identity.is_empty()
            || artifact.path_classes.is_empty()
            || !matches!(artifact.action.as_str(), "remove" | "update")
            || artifact.digests.is_empty()
            || artifact
                .digests
                .iter()
                .any(|digest| !crate::stable_digest::valid(digest))
        {
            return Err("invalid pre-manifest ownership artifact".to_string());
        }
    }
    Ok(manifest)
}

/// Identity namespace for a skill: removed skills keep their legacy prefix,
/// still-current skills use the generic skill namespace.
fn skill_identity(name: &str) -> String {
    if REMOVED_SKILL_NAMES.contains(&name) {
        format!("removed-skill:{name}")
    } else {
        format!("skill:{name}")
    }
}

fn historical_identity_and_path_class(artifact: &ArtifactId) -> Option<(String, &'static str)> {
    match artifact {
        ArtifactId::OpenCodeSkill(name)
        | ArtifactId::CodexSkill(name)
        | ArtifactId::ClaudeSkill(name)
        | ArtifactId::CursorSkill(name) => Some((skill_identity(name.as_str()), "harness-skill")),
        ArtifactId::CodexLegacySkill(name) => {
            Some((skill_identity(name.as_str()), "codex-legacy-skill"))
        }
        ArtifactId::OpenCodeAgent(name) if name.as_str() == LEGACY_SCOUT_AGENT => {
            Some(("legacy-agent:scout".to_string(), "opencode-agent"))
        }
        ArtifactId::OpenCodeAgent(name) => Some((
            format!("agent:opencode:{}", name.as_str()),
            "opencode-agent",
        )),
        ArtifactId::CodexAgent(name) => {
            Some((format!("agent:codex:{}", name.as_str()), "codex-agent"))
        }
        ArtifactId::ClaudeAgent(name) => {
            Some((format!("agent:claude:{}", name.as_str()), "claude-agent"))
        }
        ArtifactId::CursorAgent(name) => {
            Some((format!("agent:cursor:{}", name.as_str()), "cursor-agent"))
        }
        ArtifactId::OpenCodeRules => Some(("rules:opencode".to_string(), "opencode-rules")),
        ArtifactId::CodexRules => Some(("rules:codex".to_string(), "codex-rules")),
        ArtifactId::ClaudeRules => Some(("rules:claude".to_string(), "claude-rules")),
        ArtifactId::WorkspaceFile(path) => path
            .as_str()
            .strip_prefix("metadata/deprecated-skills/")
            .and_then(|rest| rest.split('/').next())
            .map(|name| (format!("removed-skill:{name}"), "runtime-deprecated-copy")),
        _ => None,
    }
    .or_else(|| match artifact {
        ArtifactId::WorkspaceFile(path) if path.as_str() == "metadata/deprecated-skills.json" => {
            Some((
                "legacy-metadata:deprecated-skills".to_string(),
                "runtime-metadata",
            ))
        }
        ArtifactId::WorkspaceFile(path) if path.as_str() == "agents/scout.md" => {
            Some(("legacy-agent:scout".to_string(), "runtime-agent"))
        }
        ArtifactId::WorkspaceFile(path) => path
            .as_str()
            .strip_prefix("skills/")
            .and_then(|rest| rest.strip_suffix("/SKILL.md"))
            .and_then(|rest| rest.rsplit('/').next())
            .map(|name| (skill_identity(name), "runtime-skill")),
        _ => None,
    })
    .or_else(|| match artifact {
        ArtifactId::WorkspaceFile(path) => {
            Some((workspace_file_identity(path.as_str()), "workspace-doc"))
        }
        _ => None,
    })
}

fn approved_historical_digest(artifact: &ArtifactId, action: &str, digest: &str) -> bool {
    let identity = historical_identity_and_path_class(artifact);
    historical_manifest().is_ok_and(|manifest| {
        identity.is_some_and(|(identity, path_class)| {
            manifest.artifacts.iter().any(|entry| {
                entry.identity == identity
                    && entry.path_classes.iter().any(|class| class == path_class)
                    && entry.action == action
                    && entry.digests.iter().any(|approved| approved == digest)
            })
        })
    })
}

pub fn bootstrap_metadata_dir_entries(workspace_root: &Path) -> Vec<String> {
    REMOVED_SKILL_NAMES
        .iter()
        .map(|name| format!("metadata/deprecated-skills/{name}/SKILL.md"))
        .filter(|rel| workspace_root.join(rel).is_file())
        .collect()
}

/// Stale workspace-relative paths from old installations (not in current manifest).
pub fn stale_workspace_paths(workspace_root: &Path) -> Vec<String> {
    let mut stale = Vec::new();
    for rel in BOOTSTRAP_METADATA_PATHS {
        if workspace_root.join(rel).exists() {
            stale.push((*rel).to_string());
        }
    }
    stale.extend(bootstrap_metadata_dir_entries(workspace_root));
    for name in REMOVED_SKILL_NAMES {
        let rel = format!("skills/{name}/SKILL.md");
        if workspace_root.join(&rel).is_file() {
            stale.push(rel);
        }
    }
    if workspace_root.join("agents/scout.md").is_file() {
        stale.push("agents/scout.md".into());
    }
    stale.sort();
    stale.dedup();
    stale
}

/// Build stale harness skill artifacts for removed skills still installed globally.
pub fn stale_harness_skill_artifacts(
    workspace_root: &Path,
    _home: &Path,
    harness: &str,
    map: impl Fn(SkillName) -> ArtifactId,
) -> Result<Vec<ArtifactId>, String> {
    let dest_root = crate::agent_skill_targets::agent_global_skills_dest(harness)?;
    if !dest_root.is_dir() {
        return Ok(Vec::new());
    }
    let bundled_root = crate::setup_roots::bundled_root_for(workspace_root)?;
    let canonical: HashSet<String> =
        crate::artifact_registry::discover_skill_names_for_harness(&bundled_root, harness)?
            .into_iter()
            .map(|n| n.as_str().to_string())
            .collect();

    let mut stale = Vec::new();
    for entry in fs::read_dir(&dest_root).map_err(|e| format!("read skills dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            return Err(format!(
                "refusing symlink skill: {}",
                entry.path().display()
            ));
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if canonical.contains(&name) {
            continue;
        }
        if !REMOVED_SKILL_NAMES.contains(&name.as_str()) && name != LEGACY_SCOUT_AGENT {
            continue;
        }
        validate_skill_name(&name, "bootstrap stale scan")?;
        let Some(sn) = SkillName::new(name) else {
            continue;
        };
        stale.push(map(sn));
    }
    Ok(stale)
}

/// Stale OpenCode agent scout.md when repo-scout is canonical.
pub fn stale_opencode_scout_agent(workspace_root: &Path, home: &Path) -> Option<ArtifactId> {
    let dest = home.join(".config/opencode/agents/scout.md");
    if !dest.is_file() {
        return None;
    }
    let canonical = crate::setup_roots::bundled_root_for(workspace_root)
        .ok()?
        .join("agents/repo-scout.md");
    if canonical.is_file() {
        AgentName::new("scout").map(ArtifactId::OpenCodeAgent)
    } else {
        None
    }
}

/// Codex legacy path skills that match canonical or old runtime sources.
pub fn codex_legacy_migration_artifacts(
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<ArtifactId>, String> {
    let legacy_root = codex_legacy_skills_dest(home);
    if !legacy_root.is_dir() {
        return Ok(Vec::new());
    }
    let bundled_root = crate::setup_roots::bundled_root_for(workspace_root)?;
    let canonical: HashSet<String> =
        crate::artifact_registry::discover_skill_names_for_harness(&bundled_root, "codex")?
            .into_iter()
            .map(|name| name.as_str().to_string())
            .collect();
    let mut artifacts = Vec::new();
    for entry in fs::read_dir(&legacy_root).map_err(|e| format!("read legacy codex skills: {e}"))? {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == ".system" {
            continue;
        }
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            return Err(format!(
                "refusing symlink legacy skill: {}",
                entry.path().display()
            ));
        }
        if !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        if !canonical.contains(&name) && !REMOVED_SKILL_NAMES.contains(&name.as_str()) {
            continue;
        }
        validate_skill_name(&name, "codex legacy scan")?;
        let Some(sn) = SkillName::new(name) else {
            continue;
        };
        artifacts.push(ArtifactId::CodexLegacySkill(sn));
    }
    Ok(artifacts)
}

pub(crate) fn approved_codex_legacy_digest(
    artifact: &ArtifactId,
    digest: &str,
    workspace_root: &Path,
    home: &Path,
) -> bool {
    if approved_historical_digest(artifact, "remove", digest)
        || approved_historical_digest(artifact, "update", digest)
    {
        return true;
    }
    let ArtifactId::CodexLegacySkill(name) = artifact else {
        return false;
    };
    let Some(current) = SkillName::new(name.as_str().to_string()).map(ArtifactId::CodexSkill)
    else {
        return false;
    };
    let Ok(bundled_root) = crate::setup_roots::bundled_root_for(workspace_root) else {
        return false;
    };
    setup_fingerprint::artifact_source_digest(&current, &bundled_root, home)
        .is_ok_and(|current_digest| current_digest == digest)
}

/// Infer bootstrap managed records from an old installation before first managed-state.json.
pub fn infer_bootstrap_records(
    workspace_root: &Path,
    home: &Path,
) -> Result<Vec<ManagedArtifactRecord>, String> {
    let mut records = Vec::new();
    for rel in stale_workspace_paths(workspace_root) {
        let path = workspace_root.join(&rel);
        if path.is_file() {
            let hash = setup_fingerprint::hash_file_path(&path)?;
            let artifact = WorkspaceRelPath::new(&rel).map(ArtifactId::WorkspaceFile);
            if artifact
                .as_ref()
                .is_some_and(|artifact| approved_historical_digest(artifact, "remove", &hash))
            {
                records.push(ManagedArtifactRecord {
                    identity: workspace_file_identity(&rel),
                    hash,
                    surface: None,
                });
            }
        }
    }
    // Adopt every still-current artifact (workspace files, harness skills,
    // agents, and rules) whose installed copy matches a digest the app
    // historically shipped. Without a record these copies would be treated
    // as user divergence and preserved as conflicts forever.
    let canonical = crate::setup_transaction::expand_surfaces_to_artifacts(
        crate::setup_lifecycle::SetupSurfaceId::ALL,
        workspace_root,
    )?;
    for artifact in canonical {
        let hash =
            setup_fingerprint::artifact_installed_managed_digest(&artifact, workspace_root, home)?;
        if hash != ABSENT_DIGEST && approved_historical_digest(&artifact, "update", &hash) {
            records.push(ManagedArtifactRecord {
                identity: artifact_identity(&artifact),
                hash,
                surface: surface_record_label(&artifact),
            });
        }
    }
    for harness in ["opencode", "codex", "claude", "cursor"] {
        let map = |sn: SkillName| match harness {
            "opencode" => ArtifactId::OpenCodeSkill(sn),
            "codex" => ArtifactId::CodexSkill(sn),
            "claude" => ArtifactId::ClaudeSkill(sn),
            _ => ArtifactId::CursorSkill(sn),
        };
        for artifact in stale_harness_skill_artifacts(workspace_root, home, harness, map)? {
            let hash = setup_fingerprint::artifact_installed_managed_digest(
                &artifact,
                workspace_root,
                home,
            )?;
            if hash != ABSENT_DIGEST && approved_historical_digest(&artifact, "remove", &hash) {
                records.push(ManagedArtifactRecord {
                    identity: artifact_identity(&artifact),
                    hash,
                    surface: Some(format!("{:?}", artifact.surface()).to_lowercase()),
                });
            }
        }
    }
    if let Some(agent) = stale_opencode_scout_agent(workspace_root, home) {
        let hash =
            setup_fingerprint::artifact_installed_managed_digest(&agent, workspace_root, home)?;
        if hash != ABSENT_DIGEST && approved_historical_digest(&agent, "remove", &hash) {
            records.push(ManagedArtifactRecord {
                identity: artifact_identity(&agent),
                hash,
                surface: Some("open_code_agents".into()),
            });
        }
    }
    for artifact in codex_legacy_migration_artifacts(workspace_root, home)? {
        let hash =
            setup_fingerprint::artifact_installed_managed_digest(&artifact, workspace_root, home)?;
        if hash != ABSENT_DIGEST
            && approved_codex_legacy_digest(&artifact, &hash, workspace_root, home)
        {
            records.push(ManagedArtifactRecord {
                identity: artifact_identity(&artifact),
                hash,
                surface: Some("codex_skills".into()),
            });
        }
    }
    records.sort_by(|a, b| a.identity.cmp(&b.identity));
    records.dedup_by(|a, b| a.identity == b.identity);
    Ok(records)
}

/// Record label for the owning surface; workspace files carry no surface.
fn surface_record_label(artifact: &ArtifactId) -> Option<String> {
    match artifact {
        ArtifactId::WorkspaceFile(_) => None,
        _ => serde_json::to_value(artifact.surface())
            .ok()
            .and_then(|value| value.as_str().map(str::to_string)),
    }
}

/// Collect all stale removal artifact candidates for bootstrap or managed-state reconciliation.
pub fn collect_stale_removal_artifacts(
    workspace_root: &Path,
    home: &Path,
    managed_records: &[ManagedArtifactRecord],
    canonical_identities: &HashSet<String>,
) -> Result<Vec<ArtifactId>, String> {
    let mut stale = Vec::new();
    for record in managed_records {
        if canonical_identities.contains(&record.identity) {
            continue;
        }
        if let Ok(artifact) = artifact_from_identity(&record.identity) {
            let dest = artifact.resolve_dest(home, workspace_root)?;
            if dest.exists() {
                stale.push(artifact);
            }
        }
    }
    if read_managed_state_missing(workspace_root) && workspace_root.join("skills").is_dir() {
        stale.extend(stale_workspace_artifacts(workspace_root)?);
        for harness in ["opencode", "codex", "claude", "cursor"] {
            let map = |sn: SkillName| match harness {
                "opencode" => ArtifactId::OpenCodeSkill(sn),
                "codex" => ArtifactId::CodexSkill(sn),
                "claude" => ArtifactId::ClaudeSkill(sn),
                _ => ArtifactId::CursorSkill(sn),
            };
            if let Ok(items) = stale_harness_skill_artifacts(workspace_root, home, harness, map) {
                stale.extend(items);
            }
        }
        if let Some(a) = stale_opencode_scout_agent(workspace_root, home) {
            stale.push(a);
        }
        if let Ok(items) = codex_legacy_migration_artifacts(workspace_root, home) {
            stale.extend(items);
        }
    }
    stale.sort_by_key(artifact_identity);
    stale.dedup_by(|a, b| a == b);
    Ok(stale)
}

fn read_managed_state_missing(workspace_root: &Path) -> bool {
    crate::managed_state::read_managed_state(workspace_root).is_none()
}

fn stale_workspace_artifacts(workspace_root: &Path) -> Result<Vec<ArtifactId>, String> {
    Ok(stale_workspace_paths(workspace_root)
        .into_iter()
        .filter_map(|rel| WorkspaceRelPath::new(&rel).map(ArtifactId::WorkspaceFile))
        .collect())
}

pub(crate) fn artifact_from_identity(identity: &str) -> Result<ArtifactId, String> {
    if let Some(rel) = identity.strip_prefix("workspace:file:") {
        let wrel = WorkspaceRelPath::new(rel)
            .ok_or_else(|| format!("invalid workspace id: {identity}"))?;
        return Ok(ArtifactId::WorkspaceFile(wrel));
    }
    serde_json::from_str(identity).map_err(|e| format!("invalid artifact identity: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_historical_manifest_is_bounded_and_complete() {
        let manifest = historical_manifest().expect("historical manifest");
        for name in REMOVED_SKILL_NAMES {
            assert!(manifest
                .artifacts
                .iter()
                .any(|entry| entry.identity == format!("removed-skill:{name}")));
        }
    }

    #[test]
    fn historical_digest_is_scoped_to_identity_path_class_and_action() {
        let manifest = historical_manifest().expect("historical manifest");
        let digest = manifest
            .artifacts
            .iter()
            .find(|entry| entry.identity == "legacy-agent:scout")
            .and_then(|entry| entry.digests.first())
            .expect("scout digest")
            .clone();
        let scout = ArtifactId::OpenCodeAgent(AgentName::new("scout").expect("scout"));
        assert!(approved_historical_digest(&scout, "remove", &digest));
        assert!(!approved_historical_digest(&scout, "update", &digest));
        let other = ArtifactId::OpenCodeAgent(AgentName::new("custom").expect("custom"));
        assert!(!approved_historical_digest(&other, "remove", &digest));
    }
}
