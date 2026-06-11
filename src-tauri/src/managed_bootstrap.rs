//! One-time bootstrap of managed ownership from pre-manifest installations.
//!
//! Does not create a permanent historical-version framework. Runs only when
//! managed-state.json is absent and infers ownership from known old surfaces.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

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

pub fn bootstrap_metadata_dir_entries(workspace_root: &Path) -> Vec<String> {
    let dir = workspace_root.join("metadata/deprecated-skills");
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut paths = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                if let Ok(rel) = entry.path().strip_prefix(workspace_root) {
                    paths.push(rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    paths.sort();
    paths
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
    let canonical: HashSet<String> =
        crate::artifact_registry::discover_skill_names_for_harness(workspace_root, harness)?
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
    let canonical = workspace_root.join("agents/repo-scout.md");
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
        validate_skill_name(&name, "codex legacy scan")?;
        let Some(sn) = SkillName::new(name) else {
            continue;
        };
        let legacy = ArtifactId::CodexLegacySkill(sn.clone());
        let current = ArtifactId::CodexSkill(sn);
        let legacy_dest = legacy.resolve_dest(home, workspace_root)?;
        let current_dest = current.resolve_dest(home, workspace_root)?;
        if !legacy_dest.is_dir() {
            continue;
        }
        if current_dest.is_dir() {
            let legacy_md = legacy_dest.join("SKILL.md");
            let current_md = current_dest.join("SKILL.md");
            if crate::commands::file_eq(&legacy_md, &current_md) {
                artifacts.push(legacy);
            }
        } else if setup_fingerprint::artifact_source_digest(&current, workspace_root, home).is_ok()
        {
            artifacts.push(legacy);
        }
    }
    Ok(artifacts)
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
            records.push(ManagedArtifactRecord {
                identity: workspace_file_identity(&rel),
                hash,
                surface: None,
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
            if hash != ABSENT_DIGEST {
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
        if hash != ABSENT_DIGEST {
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
        if hash != ABSENT_DIGEST {
            records.push(ManagedArtifactRecord {
                identity: artifact_identity(&artifact),
                hash,
                surface: Some("codex_skills".into()),
            });
        }
    }
    records.sort_by(|a, b| a.identity.cmp(&b.identity));
    Ok(records)
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

fn artifact_from_identity(identity: &str) -> Result<ArtifactId, String> {
    if let Some(rel) = identity.strip_prefix("workspace:file:") {
        let wrel = WorkspaceRelPath::new(rel)
            .ok_or_else(|| format!("invalid workspace id: {identity}"))?;
        return Ok(ArtifactId::WorkspaceFile(wrel));
    }
    serde_json::from_str(identity).map_err(|e| format!("invalid artifact identity: {e}"))
}
