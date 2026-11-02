//! Compact managed artifact state for setup reconciliation.
//!
//! Records only app-owned artifacts that Riggverk has successfully applied.
//! Unknown files are never added merely because they live inside a managed parent.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::{expand_surface, ArtifactId};
use crate::platform_paths::{names_match, Platform};
use crate::setup_fingerprint;
use crate::setup_lifecycle::SetupSurfaceId;
use crate::skill_roots::SkillScope;
use crate::skill_sources::{BundleOnly, SourceRoot};

pub const MANAGED_STATE_SCHEMA_VERSION: u32 = 2;
pub const MANAGED_STATE_REL: &str = ".riggverk/managed-state.json";
/// Where builds before the rename kept the ownership records. Read in place until the first write
/// moves the state folder (see `workspace_layout`).
pub(crate) const LEGACY_MANAGED_STATE_REL: &str = ".agent-workspace/managed-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedArtifactRecord {
    /// Stable logical identity (serialized ArtifactId or workspace rel path key).
    pub identity: String,
    /// Managed content digest after last successful apply.
    pub hash: String,
    /// Setup surface when the artifact is harness-owned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    /// OpenCode config only: the `agent.<role>.model` values the app wrote at the last apply that
    /// left the file current, by role. Proof that a pin is the app's: a value not recorded here
    /// and not pinned by the model override is the user's, never changed or removed. Records
    /// from older versions have none.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub role_models: BTreeMap<String, String>,
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
    crate::workspace_layout::state_file(workspace_root, "managed-state.json")
}

/// Creates the data folder, owner-only, for the first write that needs it (a state file, a
/// personal doc or an install). A fresh profile has none, and nothing creates it at launch.
pub fn ensure_data_folder(workspace_root: &Path) -> Result<(), String> {
    crate::safe_filesystem::create_private_leaf_directory(workspace_root)
        .map_err(|e| format!("create workspace folder: {e}"))
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
    Some(normalize_identities(state))
}

/// Identity under which a record is looked up today. Older versions recorded the `SKILL.md` of a
/// skill under a per-harness identity; the same file is now a `SkillFile`. Without this, such a
/// record would look stale next to the wanted `SkillFile` at the same destination, and the plan
/// would both update and remove one file.
fn current_identity(identity: &str) -> String {
    crate::managed_bootstrap::artifact_from_identity(identity)
        .ok()
        .and_then(|artifact| artifact.current_equivalent())
        .map_or_else(
            || identity.to_string(),
            |current| artifact_identity(&current),
        )
}

/// Records under legacy identities move to their current identity. When both identities of one
/// file are present the first record wins.
fn normalize_identities(mut state: ManagedState) -> ManagedState {
    let mut seen = HashSet::new();
    state.artifacts = state
        .artifacts
        .into_iter()
        .map(|mut record| {
            record.identity = current_identity(&record.identity);
            record
        })
        .filter(|record| seen.insert(record.identity.clone()))
        .collect();
    state
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
    ensure_data_folder(workspace_root)?;
    if let Some(parent) = path.parent() {
        crate::safe_filesystem::create_private_directory_all_no_symlinks(parent, workspace_root)
            .map_err(|e| format!("create managed-state parent: {e}"))?;
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

/// Drops the records of `artifact`'s skill file under another case (`Notes.md` for `notes.md`):
/// on a case-insensitive volume they are the one file the new record now covers. Linux compares
/// exactly, so nothing is dropped there.
fn drop_case_variants(
    records: &mut HashMap<String, ManagedArtifactRecord>,
    artifact: &crate::artifact_registry::ArtifactId,
) {
    let Some(file) = artifact.as_skill_file() else {
        return;
    };
    let own = artifact_identity(artifact);
    records.retain(|identity, _| {
        // The identity string differs in case too; checked first, so a plan parses no record of
        // another file.
        *identity == own
            || !names_match(identity, &own, Platform::current())
            || crate::managed_bootstrap::artifact_from_identity(identity)
                .ok()
                .and_then(|other| other.as_skill_file())
                .is_none_or(|other| !file.same_file(&other))
    });
}

pub fn next_state_from_operations<R: SourceRoot + ?Sized>(
    previous: Option<&ManagedState>,
    bundled_root: &R,
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
                drop_case_variants(&mut records, &operation.artifact);
                records.insert(
                    identity.clone(),
                    ManagedArtifactRecord {
                        identity,
                        hash,
                        surface: serde_json::to_value(operation.surface)
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string)),
                        role_models: Default::default(),
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
        let expected = setup_fingerprint::artifact_effective_source_digest(
            &planned.artifact,
            bundled_root,
            runtime_root,
            home,
        )?;
        let installed = setup_fingerprint::artifact_installed_managed_digest(
            &planned.artifact,
            runtime_root,
            home,
        )?;
        if expected != installed || installed == setup_fingerprint::ABSENT_DIGEST {
            return Err(format!("cannot adopt unverified exact artifact {identity}"));
        }
        drop_case_variants(&mut records, &planned.artifact);
        records.insert(
            identity.clone(),
            ManagedArtifactRecord {
                identity,
                hash: installed,
                surface: serde_json::to_value(planned.surface)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string)),
                role_models: Default::default(),
            },
        );
    }
    refresh_records_matching_source(&mut records, bundled_root, runtime_root, home);
    record_opencode_role_models(&mut records, bundled_root, runtime_root, home);
    let mut artifacts: Vec<_> = records.into_values().collect();
    artifacts.sort_by(|a, b| a.identity.cmp(&b.identity));
    Ok(ManagedState {
        schema_version: MANAGED_STATE_SCHEMA_VERSION,
        bundled_version: compute_bundled_version(
            bundled_root.bundle(),
            home,
            bundled_root.bundle(),
        )?,
        artifacts,
    })
}

/// Refresh records whose installed artifact already equals the current
/// bundled source. That equality proves the app owns the content even when the
/// file was synced by other means, so the record must follow it; a stale hash
/// would turn the next source change into a false conflict. Artifacts that
/// differ from both the record and the source are user-modified and keep their
/// record untouched.
fn refresh_records_matching_source<R: SourceRoot + ?Sized>(
    records: &mut HashMap<String, ManagedArtifactRecord>,
    bundled_root: &R,
    runtime_root: &Path,
    home: &Path,
) {
    for record in records.values_mut() {
        let Ok(artifact) = crate::managed_bootstrap::artifact_from_identity(&record.identity)
        else {
            continue;
        };
        let Ok(installed) =
            setup_fingerprint::artifact_installed_managed_digest(&artifact, runtime_root, home)
        else {
            continue;
        };
        if installed == setup_fingerprint::ABSENT_DIGEST || installed == record.hash {
            continue;
        }
        let matches_source = setup_fingerprint::artifact_effective_source_digest(
            &artifact,
            bundled_root,
            runtime_root,
            home,
        )
        .is_ok_and(|source| source == installed);
        if matches_source {
            record.hash = installed;
        }
    }
}

/// While the installed `opencode.json` is what an install makes of it, the role models it holds
/// for the app are the ones the override pins: record those, and only those, as written by the
/// app. A file that differs keeps the roles it had: what the app wrote is still unchanged there.
fn record_opencode_role_models<R: SourceRoot + ?Sized>(
    records: &mut HashMap<String, ManagedArtifactRecord>,
    bundled_root: &R,
    runtime_root: &Path,
    home: &Path,
) {
    let artifact = ArtifactId::OpenCodeConfig;
    let Some(record) = records.get_mut(&artifact_identity(&artifact)) else {
        return;
    };
    let current =
        setup_fingerprint::artifact_installed_managed_digest(&artifact, runtime_root, home)
            .is_ok_and(|installed| {
                installed != setup_fingerprint::ABSENT_DIGEST
                    && setup_fingerprint::artifact_effective_source_digest(
                        &artifact,
                        bundled_root,
                        runtime_root,
                        home,
                    )
                    .is_ok_and(|source| source == installed)
            });
    if current {
        record.role_models = crate::commands::pinned_role_models(home);
    }
}

/// Collect canonical harness artifact IDs for all managed surfaces. The skill files are those of
/// the roots in `scope`.
pub fn canonical_harness_artifacts<R: SourceRoot + ?Sized>(
    workspace_root: &R,
    scope: &SkillScope,
) -> Result<Vec<ArtifactId>, String> {
    let surfaces: Vec<SetupSurfaceId> = SetupSurfaceId::ALL
        .iter()
        .filter(|s| !matches!(s, SetupSurfaceId::WorkspaceBundle))
        .copied()
        .collect();
    let mut artifacts = Vec::new();
    let mut seen = HashSet::new();
    for surface in surfaces {
        for artifact in expand_surface(surface, workspace_root, scope)? {
            if seen.insert(artifact.clone()) {
                artifacts.push(artifact);
            }
        }
    }
    Ok(artifacts)
}

/// Logical identities for all current canonical artifacts (from the bundle and the packs). A recorded
/// artifact that is not among them is stale: that includes a skill file in a root `scope` no
/// longer wants.
pub fn canonical_artifact_identities<R: SourceRoot + ?Sized>(
    bundled_root: &R,
    scope: &SkillScope,
) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for artifact in canonical_harness_artifacts(bundled_root, scope)? {
        ids.insert(artifact_identity(&artifact));
    }
    // The marker stays canonical, so its record is never stale and it is never removed. The old
    // copies of the bundle are not: their records are stale removals.
    ids.insert(workspace_file_identity(
        crate::commands::retired_workspace_files::LEGACY_MARKER_REL,
    ));
    Ok(ids)
}

/// Identities of the recorded files of the skills in `held`, any root. They are not canonical, yet
/// they must not be treated as stale either (see `skill_sources`).
pub fn held_skill_identities(
    held: &HashSet<&str>,
    records: &[ManagedArtifactRecord],
) -> HashSet<String> {
    if held.is_empty() {
        return HashSet::new();
    }
    records
        .iter()
        .filter(|record| {
            crate::managed_bootstrap::artifact_from_identity(&record.identity)
                .ok()
                .and_then(|artifact| artifact.as_skill_file())
                .is_some_and(|file| held.contains(file.skill.as_str()))
        })
        .map(|record| record.identity.clone())
        .collect()
}

pub fn compute_bundled_version(
    _workspace_root: &Path,
    home: &Path,
    bundled_root: &Path,
) -> Result<String, String> {
    let mut input = Vec::new();
    // The fingerprint of the bundle must not move with the settings: every root counts. Packs
    // are not part of the bundle, so they do not move it either.
    let bundle = BundleOnly(bundled_root);
    for artifact in canonical_harness_artifacts(&bundle, &SkillScope::all())? {
        let digest = setup_fingerprint::artifact_source_digest(&artifact, &bundle, home)?;
        input.extend_from_slice(artifact_identity(&artifact).as_bytes());
        input.push(0);
        input.extend_from_slice(digest.as_bytes());
        input.push(0xff);
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
        fs::create_dir_all(root.join(crate::workspace_layout::STATE_DIR)).unwrap();
        let state = ManagedState {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![ManagedArtifactRecord {
                identity: "workspace:file:README.md".into(),
                hash: crate::stable_digest::bytes(b"artifact"),
                surface: None,
                role_models: Default::default(),
            }],
        };
        write_managed_state_atomic(&root, &state).unwrap();
        let read = read_managed_state(&root).expect("read back");
        assert_eq!(read, state);
    }

    fn skill_md(root: crate::skill_roots::SkillRoot, name: &str) -> ArtifactId {
        ArtifactId::skill_md(
            root,
            crate::artifact_registry::SkillName::new(name).unwrap(),
        )
    }

    fn record(identity: &str, bytes: &[u8]) -> ManagedArtifactRecord {
        ManagedArtifactRecord {
            identity: identity.to_string(),
            hash: crate::stable_digest::bytes(bytes),
            surface: Some("claude_skills".into()),
            role_models: Default::default(),
        }
    }

    #[test]
    fn records_under_legacy_skill_identities_are_read_under_the_skill_file_identity() {
        use crate::skill_roots::SkillRoot;
        let root = temp_dir("legacy-identities");
        let cases = [
            ("ClaudeSkill", SkillRoot::Claude),
            ("OpenCodeSkill", SkillRoot::OpenCode),
            ("CodexSkill", SkillRoot::CodexHome),
            ("CursorSkill", SkillRoot::Cursor),
            ("CodexLegacySkill", SkillRoot::Agents),
        ];
        let mut artifacts: Vec<ManagedArtifactRecord> = cases
            .iter()
            .map(|(variant, _)| record(&format!(r#"{{"type":"{variant}","name":"tdd"}}"#), b"tdd"))
            .collect();
        artifacts.push(record("workspace:file:README.md", b"readme"));
        artifacts.push(record(
            &artifact_identity(&ArtifactId::ClaudeRules),
            b"rules",
        ));
        write_managed_state_atomic(
            &root,
            &ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts,
            },
        )
        .unwrap();

        let read = read_managed_state(&root).expect("state");
        let identities: Vec<&str> = read
            .artifacts
            .iter()
            .map(|record| record.identity.as_str())
            .collect();
        for (_, skill_root) in &cases {
            let current = artifact_identity(&skill_md(*skill_root, "tdd"));
            assert!(identities.contains(&current.as_str()), "{current}");
        }
        assert!(identities.contains(&"workspace:file:README.md"));
        assert!(identities.contains(&artifact_identity(&ArtifactId::ClaudeRules).as_str()));
        assert_eq!(read.artifacts.len(), 7);
        assert!(
            read.artifacts
                .iter()
                .all(|record| !record.identity.contains("Skill\",")),
            "no legacy identity is left: {identities:?}"
        );
        // The hash and surface of the record are untouched.
        let claude = artifact_identity(&skill_md(SkillRoot::Claude, "tdd"));
        let kept = read
            .artifacts
            .iter()
            .find(|r| r.identity == claude)
            .unwrap();
        assert_eq!(kept.hash, crate::stable_digest::bytes(b"tdd"));
        assert_eq!(kept.surface.as_deref(), Some("claude_skills"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn when_a_file_is_recorded_under_both_identities_the_first_record_wins() {
        use crate::skill_roots::SkillRoot;
        let root = temp_dir("both-identities");
        let current = artifact_identity(&skill_md(SkillRoot::Claude, "tdd"));
        write_managed_state_atomic(
            &root,
            &ManagedState {
                schema_version: MANAGED_STATE_SCHEMA_VERSION,
                bundled_version: crate::stable_digest::bytes(b"bundle"),
                artifacts: vec![
                    record(r#"{"type":"ClaudeSkill","name":"tdd"}"#, b"first"),
                    record(&current, b"second"),
                ],
            },
        )
        .unwrap();
        let read = read_managed_state(&root).expect("state");
        assert_eq!(read.artifacts.len(), 1);
        assert_eq!(read.artifacts[0].identity, current);
        assert_eq!(
            read.artifacts[0].hash,
            crate::stable_digest::bytes(b"first")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn schema_one_is_not_trusted() {
        let root = temp_dir("schema-one");
        fs::create_dir_all(root.join(crate::workspace_layout::STATE_DIR)).unwrap();
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
        fs::create_dir_all(root.join(crate::workspace_layout::STATE_DIR)).unwrap();
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

    #[test]
    fn stale_record_follows_installed_content_that_matches_source() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let base = temp_dir("stale-record");
        let home = base.join("home");
        let ws = base.join("ws");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        crate::test_env::set_test_user_dirs(&home);
        let bundled = crate::setup_roots::bundled_root().unwrap();

        // Codex rules were synced by other means: installed == current source,
        // but the record still holds an older hash.
        let source = fs::read(bundled.join("templates/sync/codex-rules.md")).unwrap();
        fs::write(home.join(".codex/AGENTS.md"), &source).unwrap();
        // OpenCode rules were edited by the user: differs from record and source.
        fs::write(home.join(".config/opencode/AGENTS.md"), "user edit").unwrap();
        let stale_hash = crate::stable_digest::bytes(b"older shipped version");
        let record = |artifact: &ArtifactId| ManagedArtifactRecord {
            identity: artifact_identity(artifact),
            hash: stale_hash.clone(),
            surface: None,
            role_models: Default::default(),
        };
        let previous = ManagedState {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            bundled_version: crate::stable_digest::bytes(b"bundle"),
            artifacts: vec![
                record(&ArtifactId::CodexRules),
                record(&ArtifactId::OpenCodeRules),
            ],
        };

        let next = next_state_from_operations(Some(&previous), &bundled, &ws, &home, &[], &[])
            .expect("next state");

        let hash_of = |artifact: &ArtifactId| {
            next.artifacts
                .iter()
                .find(|r| r.identity == artifact_identity(artifact))
                .map(|r| r.hash.clone())
                .expect("record kept")
        };
        assert_eq!(
            hash_of(&ArtifactId::CodexRules),
            crate::stable_digest::bytes(&source),
            "record must follow installed content that equals the source"
        );
        assert_eq!(
            hash_of(&ArtifactId::OpenCodeRules),
            stale_hash,
            "user-modified artifact keeps its record"
        );
        let _ = fs::remove_dir_all(base);
    }
}
