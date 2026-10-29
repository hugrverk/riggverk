//! One-time bootstrap of managed ownership from pre-manifest installations.
//!
//! Does not create a permanent historical-version framework. Runs only when
//! managed-state.json is absent and infers ownership from known old surfaces.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::agent_skill_targets::validate_skill_name;
use crate::artifact_registry::{AgentName, ArtifactId, SkillName, WorkspaceRelPath};
use crate::managed_state::{artifact_identity, workspace_file_identity, ManagedArtifactRecord};
use crate::setup_fingerprint::{self, ABSENT_DIGEST};
use crate::skill_roots::{SkillRoot, SkillScope};

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

/// The metadata is embedded at build time, so it is parsed and validated once
/// per process instead of on every digest check.
fn historical_manifest() -> Result<&'static HistoricalOwnershipManifest, String> {
    static MANIFEST: OnceLock<Result<HistoricalOwnershipManifest, String>> = OnceLock::new();
    MANIFEST
        .get_or_init(parse_historical_manifest)
        .as_ref()
        .map_err(Clone::clone)
}

fn parse_historical_manifest() -> Result<HistoricalOwnershipManifest, String> {
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
    if let Some(current) = artifact.current_equivalent() {
        return historical_identity_and_path_class(&current);
    }
    match artifact {
        // Only a SKILL.md was ever installed before supporting files were; those have no history.
        ArtifactId::SkillFile(file) if file.rel.is_skill_md() => {
            let path_class = if file.root == SkillRoot::Agents {
                "codex-legacy-skill"
            } else {
                "harness-skill"
            };
            Some((skill_identity(file.skill.as_str()), path_class))
        }
        ArtifactId::SkillFile(_) => None,
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

/// Whether `digest` belongs to a rules base the app shipped. Pre-block
/// installs recorded whole-file digests, which equal the digest of the base
/// body they carried.
pub(crate) fn approved_rules_base_digest(artifact: &ArtifactId, digest: &str) -> bool {
    approved_historical_digest(artifact, "update", digest)
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

/// Skills an older version installed that a plan has to look for on disk because no managed
/// record names them (the managed state is missing): in every skill root,
///
/// - a skill the app no longer ships (and the retired `scout`), and
/// - in a root `wanted` does not name, any skill the app ships now: the copies older versions put
///   into per-harness folders. For those the supporting files that exist count too.
///
/// A candidate is only a candidate: its content must still be proven app-owned (a shipped
/// version) before it is removed, and an edited copy is a conflict. Dot entries
/// (`$CODEX_HOME/skills/.system` among them), symlinks, foreign skills and unknown files are
/// never candidates.
pub fn legacy_skill_artifacts(
    workspace_root: &Path,
    home: &Path,
    wanted: &SkillScope,
) -> Result<Vec<ArtifactId>, String> {
    let sources = crate::skill_sources::SkillSources::for_workspace(workspace_root)?;
    let current = crate::artifact_registry::catalog_skill_files(&sources)?;
    let mut artifacts = Vec::new();
    for root in SkillRoot::ALL {
        let Ok(dir) = root.path(home) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() || !kind.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.path().join("SKILL.md").is_file() {
                continue;
            }
            let retired =
                REMOVED_SKILL_NAMES.contains(&name.as_str()) || name == LEGACY_SCOUT_AGENT;
            let shipped = current.iter().find(|skill| skill.name.as_str() == name);
            if validate_skill_name(&name, "bootstrap skill scan").is_err() {
                continue;
            }
            let Some(sn) = SkillName::new(name) else {
                continue;
            };
            match shipped {
                Some(skill) if !wanted.contains(root) => {
                    for rel in &skill.files {
                        if rel.is_skill_md() || entry.path().join(rel.as_str()).is_file() {
                            artifacts.push(ArtifactId::skill_file(root, sn.clone(), rel.clone()));
                        }
                    }
                }
                None if retired => artifacts.push(ArtifactId::skill_md(root, sn)),
                _ => {}
            }
        }
    }
    Ok(artifacts)
}

/// Stale OpenCode agent scout.md when repo-scout is canonical.
pub fn stale_opencode_scout_agent(workspace_root: &Path, home: &Path) -> Option<ArtifactId> {
    let dest = crate::platform_paths::opencode_config_dir(home).join("agents/scout.md");
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

/// Result of [`infer_bootstrap_records`].
#[derive(Debug, Default)]
pub struct BootstrapInference {
    pub records: Vec<ManagedArtifactRecord>,
    /// Artifacts that could not be inspected (unreadable or unparsable). They
    /// are skipped so one bad file cannot discard every other adoption.
    pub skipped: Vec<String>,
}

/// Infer bootstrap managed records from an old installation.
///
/// Artifacts whose identity is already in `known_identities` have a managed
/// record and are not inspected again.
pub fn infer_bootstrap_records(
    workspace_root: &Path,
    home: &Path,
    known_identities: &HashSet<String>,
) -> Result<BootstrapInference, String> {
    let mut inference = BootstrapInference::default();
    for rel in stale_workspace_paths(workspace_root) {
        let identity = workspace_file_identity(&rel);
        let path = workspace_root.join(&rel);
        if known_identities.contains(&identity) || !path.is_file() {
            continue;
        }
        let hash = match setup_fingerprint::hash_file_path(&path) {
            Ok(hash) => hash,
            Err(error) => {
                inference.skipped.push(format!("{rel}: {error}"));
                continue;
            }
        };
        let artifact = WorkspaceRelPath::new(&rel).map(ArtifactId::WorkspaceFile);
        if artifact
            .as_ref()
            .is_some_and(|artifact| approved_historical_digest(artifact, "remove", &hash))
        {
            inference.records.push(ManagedArtifactRecord {
                identity,
                hash,
                surface: None,
                role_models: Default::default(),
            });
        }
    }
    // Adopt every still-current artifact (workspace files, harness skills,
    // agents, and rules) whose installed copy matches a digest the app
    // historically shipped. Without a record these copies would be treated
    // as user divergence and preserved as conflicts forever.
    let canonical = crate::setup_transaction::expand_surfaces_to_artifacts(
        crate::setup_lifecycle::SetupSurfaceId::ALL,
        workspace_root,
        &SkillScope::all(),
    )?;
    for artifact in canonical {
        let identity = artifact_identity(&artifact);
        // Configs have no historical digests; only inspect what could match.
        if known_identities.contains(&identity)
            || historical_identity_and_path_class(&artifact).is_none()
        {
            continue;
        }
        let Some(hash) = inspect_installed_digest(&mut inference, &artifact, workspace_root, home)
        else {
            continue;
        };
        if approved_historical_digest(&artifact, "update", &hash) {
            inference.records.push(ManagedArtifactRecord {
                identity,
                hash,
                surface: surface_record_label(&artifact),
                role_models: Default::default(),
            });
        }
    }
    // Skills the app no longer ships, wherever an older version put them. Skills it ships now were
    // handled above, in every root.
    match legacy_skill_artifacts(workspace_root, home, &SkillScope::all()) {
        Ok(retired) => {
            for artifact in retired {
                let identity = artifact_identity(&artifact);
                if known_identities.contains(&identity) {
                    continue;
                }
                let Some(hash) =
                    inspect_installed_digest(&mut inference, &artifact, workspace_root, home)
                else {
                    continue;
                };
                if approved_historical_digest(&artifact, "remove", &hash) {
                    inference.records.push(ManagedArtifactRecord {
                        identity,
                        hash,
                        surface: surface_record_label(&artifact),
                        role_models: Default::default(),
                    });
                }
            }
        }
        Err(error) => inference.skipped.push(format!("retired skills: {error}")),
    }
    if let Some(agent) = stale_opencode_scout_agent(workspace_root, home) {
        let identity = artifact_identity(&agent);
        if !known_identities.contains(&identity) {
            if let Some(hash) =
                inspect_installed_digest(&mut inference, &agent, workspace_root, home)
            {
                if approved_historical_digest(&agent, "remove", &hash) {
                    inference.records.push(ManagedArtifactRecord {
                        identity,
                        hash,
                        surface: Some("open_code_agents".into()),
                        role_models: Default::default(),
                    });
                }
            }
        }
    }
    inference
        .records
        .sort_by(|a, b| a.identity.cmp(&b.identity));
    inference.records.dedup_by(|a, b| a.identity == b.identity);
    Ok(inference)
}

/// Installed managed digest of an artifact that exists; `None` when it is
/// absent or could not be read (recorded in `inference.skipped`).
fn inspect_installed_digest(
    inference: &mut BootstrapInference,
    artifact: &ArtifactId,
    workspace_root: &Path,
    home: &Path,
) -> Option<String> {
    match setup_fingerprint::artifact_installed_managed_digest(artifact, workspace_root, home) {
        Ok(hash) if hash == ABSENT_DIGEST => None,
        Ok(hash) => Some(hash),
        Err(error) => {
            inference
                .skipped
                .push(format!("{}: {error}", artifact_identity(artifact)));
            None
        }
    }
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

/// Whether the app has touched `workspace_root`: it holds the state folder (`.riggverk/`, or the
/// earlier name every release before the rename wrote: the marker, then the ownership records).
/// Historical adoption and the legacy cleanup run only in such a folder. They used to look for the
/// copy's `skills/` folder, which the workspace cleanup removes.
pub fn workspace_folder_touched(workspace_root: &Path) -> bool {
    crate::workspace_layout::holds_state_dir(workspace_root)
}

/// Whether the app provably wrote this old copy of the bundle in the workspace folder, whose
/// content digest is `installed`: it equals the managed record, the current bundle file, or a
/// version an earlier release shipped (the pre-manifest metadata holds every committed version
/// but the current one, which is the bundle file). `shipped-digests.json` is not consulted: it
/// does not list workspace files.
pub fn retired_workspace_copy_owned(
    artifact: &ArtifactId,
    bundled_root: &Path,
    installed: &str,
    managed_hash: Option<&str>,
) -> bool {
    if !matches!(artifact, ArtifactId::WorkspaceFile(_)) || installed == ABSENT_DIGEST {
        return false;
    }
    managed_hash == Some(installed)
        || current_bundle_digest(artifact, bundled_root).as_deref() == Some(installed)
        || approved_historical_digest(artifact, "update", installed)
        || approved_historical_digest(artifact, "remove", installed)
}

/// Digest of the bundle's own file for a workspace copy, when the bundle still holds it.
fn current_bundle_digest(artifact: &ArtifactId, bundled_root: &Path) -> Option<String> {
    let source = artifact.resolve_bundle_source(bundled_root)?;
    if !fs::symlink_metadata(&source).is_ok_and(|meta| meta.is_file()) {
        return None;
    }
    setup_fingerprint::hash_file_path(&source).ok()
}

/// The old copies of the bundle that exist in `workspace_root`, whatever the managed state says:
/// installs from before the ownership records have none. A link or a folder in place is a
/// candidate too, so the review lists it as left in place. Never the marker, the state folder or
/// the personal docs (the frozen list holds none of them).
fn retired_workspace_copies(workspace_root: &Path) -> Vec<ArtifactId> {
    crate::commands::retired_workspace_files::RETIRED_WORKSPACE_FILES
        .iter()
        .filter(|rel| fs::symlink_metadata(workspace_root.join(rel)).is_ok())
        .filter_map(|rel| WorkspaceRelPath::new(*rel).map(ArtifactId::WorkspaceFile))
        .collect()
}

/// Collect all stale removal artifact candidates for bootstrap or managed-state reconciliation.
pub fn collect_stale_removal_artifacts(
    workspace_root: &Path,
    home: &Path,
    managed_records: &[ManagedArtifactRecord],
    canonical_identities: &HashSet<String>,
    wanted: &SkillScope,
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
    stale.extend(retired_workspace_copies(workspace_root));
    if read_managed_state_missing(workspace_root) && workspace_folder_touched(workspace_root) {
        stale.extend(stale_workspace_artifacts(workspace_root)?);
        if let Ok(items) = legacy_skill_artifacts(workspace_root, home, wanted) {
            stale.extend(items);
        }
        if let Some(a) = stale_opencode_scout_agent(workspace_root, home) {
            stale.push(a);
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
    fn historical_manifest_is_parsed_once() {
        let first = historical_manifest().expect("historical manifest");
        let second = historical_manifest().expect("historical manifest");
        assert!(std::ptr::eq(first, second));
    }

    #[test]
    fn only_a_skill_md_has_pre_manifest_history_and_the_class_follows_the_root() {
        let name = |value: &str| SkillName::new(value).expect("skill name");
        for root in [
            SkillRoot::Claude,
            SkillRoot::OpenCode,
            SkillRoot::CodexHome,
            SkillRoot::Cursor,
        ] {
            assert_eq!(
                historical_identity_and_path_class(&ArtifactId::skill_md(root, name("tdd"))),
                Some(("skill:tdd".to_string(), "harness-skill")),
                "{root:?}"
            );
        }
        assert_eq!(
            historical_identity_and_path_class(&ArtifactId::skill_md(
                SkillRoot::Agents,
                name("tdd")
            )),
            Some(("skill:tdd".to_string(), "codex-legacy-skill"))
        );
        assert_eq!(
            historical_identity_and_path_class(&ArtifactId::skill_md(
                SkillRoot::Claude,
                name("grill-me")
            )),
            Some(("removed-skill:grill-me".to_string(), "harness-skill"))
        );
        // Supporting files were never installed before this version.
        assert_eq!(
            historical_identity_and_path_class(&ArtifactId::skill_file(
                SkillRoot::Claude,
                name("security-audit"),
                crate::artifact_registry::SkillRelPath::new("HUNTING.md").expect("rel"),
            )),
            None
        );
        // An old identity is classified like the file it stands for.
        for (legacy, root) in [
            (ArtifactId::ClaudeSkill(name("tdd")), SkillRoot::Claude),
            (ArtifactId::CodexLegacySkill(name("tdd")), SkillRoot::Agents),
        ] {
            assert_eq!(
                historical_identity_and_path_class(&legacy),
                historical_identity_and_path_class(&ArtifactId::skill_md(root, name("tdd")))
            );
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

    // ── Skills the app may have installed, found on disk without a record ──

    fn scan_fixture(label: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("aw-legacy-scan-{label}-{nanos}"));
        let home = base.join("home");
        let ws = base.join("runtime");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(ws.join("skills")).expect("runtime skills");
        (base, home, ws)
    }

    fn put(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        fs::write(path, text).expect("file");
    }

    fn clear_skill_env() {
        for variable in [
            "CODEX_HOME",
            "CODEX_SKILLS_PATH",
            "CLAUDE_SKILLS_PATH",
            "OPENCODE_SKILLS_PATH",
            "CURSOR_SKILLS_PATH",
        ] {
            unsafe { std::env::remove_var(variable) };
        }
    }

    #[test]
    fn the_scan_finds_current_skills_only_in_unwanted_roots_and_retired_ones_everywhere() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let (base, home, ws) = scan_fixture("roots");
        crate::test_env::set_test_user_dirs(&home);
        clear_skill_env();
        let retired = REMOVED_SKILL_NAMES[0];
        for root in SkillRoot::ALL {
            let dir = root.path(&home).expect("root");
            put(&dir.join("tdd/SKILL.md"), "tdd\n");
            put(&dir.join(retired).join("SKILL.md"), "retired\n");
            // Not the app's: foreign skills, dot directories, directories without a SKILL.md.
            put(&dir.join("my-own-skill/SKILL.md"), "mine\n");
            put(&dir.join(".system/tdd/SKILL.md"), "codex\n");
            put(&dir.join("zoom-out/notes.md"), "no SKILL.md\n");
        }
        // A bundled supporting file next to an old copy is a candidate too, a file of the user's
        // is not.
        let opencode = SkillRoot::OpenCode.path(&home).unwrap();
        put(&opencode.join("security-audit/SKILL.md"), "old\n");
        put(&opencode.join("security-audit/HUNTING.md"), "old\n");
        put(&opencode.join("security-audit/my-notes.md"), "mine\n");

        let wanted = SkillScope::of(&[SkillRoot::Claude, SkillRoot::Agents]);
        let found = legacy_skill_artifacts(&ws, &home, &wanted).expect("scan");
        let has = |root: SkillRoot, skill: &str, rel: &str| {
            found.contains(&ArtifactId::skill_file(
                root,
                SkillName::new(skill).unwrap(),
                crate::artifact_registry::SkillRelPath::new(rel).unwrap(),
            ))
        };
        for root in SkillRoot::ALL {
            let is_wanted = wanted.contains(root);
            assert_eq!(has(root, "tdd", "SKILL.md"), !is_wanted, "tdd in {root:?}");
            assert!(has(root, retired, "SKILL.md"), "{retired} in {root:?}");
            assert!(!has(root, "my-own-skill", "SKILL.md"), "{root:?}");
            assert!(!has(root, "zoom-out", "notes.md"), "{root:?}");
        }
        assert!(found.iter().all(|artifact| !artifact
            .as_skill_file()
            .expect("skill file")
            .skill
            .as_str()
            .starts_with('.')));
        assert!(has(SkillRoot::OpenCode, "security-audit", "SKILL.md"));
        assert!(has(SkillRoot::OpenCode, "security-audit", "HUNTING.md"));
        assert!(!has(SkillRoot::OpenCode, "security-audit", "my-notes.md"));
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn the_scan_skips_symlinked_skills() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let (base, home, ws) = scan_fixture("symlink");
        crate::test_env::set_test_user_dirs(&home);
        clear_skill_env();
        let elsewhere = base.join("elsewhere/tdd");
        put(&elsewhere.join("SKILL.md"), "tdd\n");
        let root = SkillRoot::OpenCode.path(&home).unwrap();
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("tdd")).unwrap();
        let found = legacy_skill_artifacts(&ws, &home, &SkillScope::of(&[SkillRoot::Claude]))
            .expect("scan");
        assert!(found.is_empty(), "{found:?}");
        let _ = fs::remove_dir_all(base);
    }
}
