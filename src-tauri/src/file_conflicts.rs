//! Conflicts on skill and agent files, as the user sees and acts on them.
//!
//! A skill or agent file that differs from the bundle without proof that the app wrote it is a
//! conflict the update refuses to overwrite. This module groups those files (and the ones the
//! user chose to keep, see [`crate::kept_files`]) into units, reports them in the installation
//! status, and builds a bounded read-only diff of the installed file against the bundled one.
//! Nothing here writes a skill or agent file.
//!
//! A unit is what the user acts on: the conflicting or kept files of one skill in one folder, or
//! the one file of an agent. The unit key is opaque to the UI; the commands re-derive the files
//! from the current plan, so the UI never names a path.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::artifact_registry::ArtifactId;
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction::PlannedArtifact;
use crate::skill_roots::{SkillRoot, SkillScope};

/// Most units one status lists; further ones are counted in `more`.
pub const MAX_STATUS_UNITS: usize = 100;
/// Most files one unit lists; further ones are counted in `more_files`.
pub const MAX_UNIT_FILES: usize = 50;
/// Most files of one unit a diff shows.
const MAX_DIFF_FILES: usize = 25;
/// Largest side of a diff that is read and compared; a bigger file is shown by size and digest.
const MAX_SIDE_BYTES: u64 = 512 * 1024;
/// Largest diff text of one unit.
const MAX_UNIT_DIFF_BYTES: usize = 256 * 1024;
/// Characters of a digest shown: `sha256:` and twelve hex digits.
const SHORT_DIGEST_CHARS: usize = 19;

/// Why the app does not treat a skill or agent file as its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictReason {
    /// A record says the app wrote the file, and it no longer matches.
    Edited,
    /// No record and no shipped version proves the app wrote the file.
    Unproven,
}

/// The user keeps this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeptState {
    /// The bundled file changed since the choice was made.
    pub bundle_changed: bool,
}

/// What a plan knows about a skill or agent file it could resolve: set only on files that differ
/// from the bundle with no proof of ownership, are regular files, and have no link in their path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileConflict {
    pub reason: ConflictReason,
    pub kept: Option<KeptState>,
    /// The bundle wants this file in this folder. False for a file of a retired skill or of a
    /// folder no harness needs any more.
    pub wanted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitKind {
    Skill,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitState {
    Conflict,
    Kept,
}

/// The files of one skill in one folder, or the one file of an agent, that are in conflict or kept.
pub struct Unit<'a> {
    pub key: String,
    pub kind: UnitKind,
    pub name: String,
    pub root: Option<SkillRoot>,
    pub wanted: bool,
    pub files: Vec<&'a PlannedArtifact>,
}

impl Unit<'_> {
    fn file_conflict(operation: &PlannedArtifact) -> FileConflict {
        // Only operations with a `file` are grouped.
        operation.file.unwrap_or(FileConflict {
            reason: ConflictReason::Unproven,
            kept: None,
            wanted: true,
        })
    }

    /// `conflict` while any file still blocks, `kept` when the user keeps every one.
    pub fn state(&self) -> UnitState {
        if self
            .files
            .iter()
            .any(|file| Self::file_conflict(file).kept.is_none())
        {
            UnitState::Conflict
        } else {
            UnitState::Kept
        }
    }

    pub fn reason(&self) -> ConflictReason {
        if self
            .files
            .iter()
            .any(|file| Self::file_conflict(file).reason == ConflictReason::Edited)
        {
            ConflictReason::Edited
        } else {
            ConflictReason::Unproven
        }
    }

    pub fn bundle_changed(&self) -> bool {
        self.files.iter().any(|file| {
            Self::file_conflict(file)
                .kept
                .is_some_and(|kept| kept.bundle_changed)
        })
    }
}

fn unit_identity(
    operation: &PlannedArtifact,
) -> Option<(String, UnitKind, String, Option<SkillRoot>)> {
    use ArtifactId::{ClaudeAgent, CodexAgent, CursorAgent, OpenCodeAgent, SkillFile};
    match &operation.artifact {
        SkillFile(file) => Some((
            format!("skill:{}:{}", file.root.label(), file.skill.as_str()),
            UnitKind::Skill,
            file.skill.as_str().to_string(),
            Some(file.root),
        )),
        ClaudeAgent(name) | CodexAgent(name) | OpenCodeAgent(name) | CursorAgent(name) => Some((
            format!("agent:{}", name.as_str()),
            UnitKind::Agent,
            name.as_str().to_string(),
            None,
        )),
        _ => None,
    }
}

/// Whether `surface` holds skill or agent files.
pub fn is_files_surface(surface: SetupSurfaceId) -> bool {
    matches!(
        surface,
        SetupSurfaceId::Skills
            | SetupSurfaceId::ClaudeAgents
            | SetupSurfaceId::CodexAgents
            | SetupSurfaceId::OpenCodeAgents
            | SetupSurfaceId::CursorAgents
    )
}

/// The units of a plan: conflicts first, then kept units, each group by folder and name.
pub fn units(planned: &[PlannedArtifact]) -> Vec<Unit<'_>> {
    let mut units: Vec<Unit<'_>> = Vec::new();
    for operation in planned.iter().filter(|operation| operation.file.is_some()) {
        let Some((key, kind, name, root)) = unit_identity(operation) else {
            continue;
        };
        match units.iter_mut().find(|unit| unit.key == key) {
            Some(unit) => unit.files.push(operation),
            None => units.push(Unit {
                key,
                kind,
                name,
                root,
                wanted: true,
                files: vec![operation],
            }),
        }
    }
    for unit in &mut units {
        unit.wanted = unit
            .files
            .iter()
            .all(|file| Unit::file_conflict(file).wanted);
    }
    let folder_order = |root: Option<SkillRoot>| {
        root.and_then(|root| {
            SkillRoot::ALL
                .iter()
                .position(|candidate| *candidate == root)
        })
        .unwrap_or(usize::MAX)
    };
    units.sort_by_key(|unit| {
        (
            unit.state() == UnitState::Kept,
            folder_order(unit.root),
            unit.name.clone(),
        )
    });
    units
}

// ── Status ──

#[derive(Debug, Clone, Serialize)]
pub struct FileStatus {
    pub rel: String,
    pub state: UnitState,
    pub reason: ConflictReason,
    pub bundle_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnitStatus {
    pub key: String,
    pub kind: UnitKind,
    pub name: String,
    /// The folder as people know it, `~/.claude/skills`.
    pub folder: String,
    pub wanted: bool,
    pub state: UnitState,
    pub reason: ConflictReason,
    pub bundle_changed: bool,
    /// The enabled harnesses that read this folder.
    pub read_by: Vec<String>,
    pub files: Vec<FileStatus>,
    pub more_files: usize,
}

/// The conflicting and kept skill or agent files of a surface. Present in the status only while
/// there are some.
#[derive(Debug, Clone, Serialize)]
pub struct FilesStatus {
    /// Files that block the update and that the user can resolve.
    pub conflicts: usize,
    /// Files the user keeps.
    pub kept: usize,
    /// Kept files whose bundled version changed since they were kept.
    pub kept_updates: usize,
    pub units: Vec<UnitStatus>,
    /// Units over the list limit.
    pub more: usize,
}

fn file_status(operation: &PlannedArtifact, dest_name: &str) -> FileStatus {
    let file = Unit::file_conflict(operation);
    let rel = match &operation.artifact {
        ArtifactId::SkillFile(skill) => skill.rel.as_str().to_string(),
        _ => dest_name.to_string(),
    };
    FileStatus {
        rel,
        state: if file.kept.is_some() {
            UnitState::Kept
        } else {
            UnitState::Conflict
        },
        reason: file.reason,
        bundle_changed: file.kept.is_some_and(|kept| kept.bundle_changed),
    }
}

fn dest_file_name(artifact: &ArtifactId, home: &Path, workspace_root: &Path) -> String {
    artifact
        .resolve_dest(home, workspace_root)
        .ok()
        .and_then(|dest| {
            dest.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

/// The harnesses (display names) that read the folder of `unit`.
fn read_by(unit: &Unit<'_>, surface: SetupSurfaceId, scope: Option<&SkillScope>) -> Vec<String> {
    use crate::agent_targets::HarnessId;
    match (unit.root, scope) {
        (Some(root), Some(scope)) => scope
            .harnesses()
            .iter()
            .copied()
            .filter(|harness: &HarnessId| {
                crate::skill_roots::readers(*harness)
                    .iter()
                    .any(|folder| folder.root() == Some(root))
            })
            .map(|harness| crate::setup_transaction::harness_name(harness).to_string())
            .collect(),
        (None, _) => surface
            .harness()
            .map(|harness| vec![crate::setup_transaction::harness_name(harness).to_string()])
            .unwrap_or_default(),
        (Some(_), None) => Vec::new(),
    }
}

pub fn unit_folder(unit: &Unit<'_>, home: &Path, workspace_root: &Path) -> String {
    if let Some(root) = unit.root {
        return root.display().to_string();
    }
    unit.files
        .first()
        .and_then(|operation| operation.artifact.resolve_dest(home, workspace_root).ok())
        .and_then(|dest| dest.parent().map(Path::to_path_buf))
        .map(|dir| crate::skill_loads::display_path(&dir, home))
        .unwrap_or_default()
}

/// The conflict and kept files of `surface`, or `None` when it has none. `planned` is the plan of
/// that surface; `scope` the skill roots it was made for, when known.
pub fn files_status(
    surface: SetupSurfaceId,
    planned: &[PlannedArtifact],
    scope: Option<&SkillScope>,
    workspace_root: &Path,
    home: &Path,
) -> Option<FilesStatus> {
    if !is_files_surface(surface) {
        return None;
    }
    let all = units(planned);
    if all.is_empty() {
        return None;
    }
    let files = || all.iter().flat_map(|unit| unit.files.iter());
    let conflicts = files()
        .filter(|operation| Unit::file_conflict(operation).kept.is_none())
        .count();
    let kept = files().count() - conflicts;
    let kept_updates = files()
        .filter(|operation| {
            Unit::file_conflict(operation)
                .kept
                .is_some_and(|kept| kept.bundle_changed)
        })
        .count();
    let listed = all.iter().take(MAX_STATUS_UNITS).map(|unit| {
        let more_files = unit.files.len().saturating_sub(MAX_UNIT_FILES);
        UnitStatus {
            key: unit.key.clone(),
            kind: unit.kind,
            name: unit.name.clone(),
            folder: unit_folder(unit, home, workspace_root),
            wanted: unit.wanted,
            state: unit.state(),
            reason: unit.reason(),
            bundle_changed: unit.bundle_changed(),
            read_by: read_by(unit, surface, scope),
            files: unit
                .files
                .iter()
                .take(MAX_UNIT_FILES)
                .map(|operation| {
                    file_status(
                        operation,
                        &dest_file_name(&operation.artifact, home, workspace_root),
                    )
                })
                .collect(),
            more_files,
        }
    });
    let units: Vec<UnitStatus> = listed.collect();
    Some(FilesStatus {
        conflicts,
        kept,
        kept_updates,
        more: all.len() - units.len(),
        units,
    })
}

// ── Diff ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffKind {
    /// A unified diff of text.
    Text,
    /// The text is equal, the bytes are not (line endings, a trailing byte order mark).
    IdenticalText,
    Binary,
    TooLarge,
    /// Contains private-key material: not shown.
    Withheld,
    /// The installed file is missing, or something is in its way.
    Unreadable,
    BundledMissing,
}

#[derive(Debug, Clone, Serialize)]
pub struct SideInfo {
    pub bytes: u64,
    /// `sha256:` and the first twelve hex digits.
    pub digest: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiffEntry {
    pub rel: String,
    pub state: UnitState,
    pub kind: DiffKind,
    pub from_label: String,
    pub to_label: String,
    pub installed: Option<SideInfo>,
    pub bundled: Option<SideInfo>,
    pub note: Option<String>,
    pub added: usize,
    pub removed: usize,
    /// The diff text was cut (per file at 64 KB, per unit at 256 KB).
    pub truncated: bool,
    /// Unified diff; empty unless `kind` is `text`.
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiffView {
    pub name: String,
    pub folder: String,
    pub files: Vec<FileDiffEntry>,
    /// Files of the unit beyond the 25 shown.
    pub more_files: usize,
    pub truncated: bool,
}

enum Side {
    Missing,
    Unreadable,
    Large(SideInfo),
    Bytes(SideInfo, Vec<u8>),
}

fn short(digest: &str) -> String {
    digest.chars().take(SHORT_DIGEST_CHARS).collect()
}

/// Reads one side of a diff: never a link, never more than [`MAX_SIDE_BYTES`].
fn read_side(path: &Path) -> Side {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Side::Missing,
        Err(_) => return Side::Unreadable,
    };
    if !meta.is_file() {
        return Side::Unreadable;
    }
    let large = |bytes: u64| match crate::stable_digest::file(path) {
        Ok(digest) => Side::Large(SideInfo {
            bytes,
            digest: short(&digest),
        }),
        Err(_) => Side::Unreadable,
    };
    if meta.len() > MAX_SIDE_BYTES {
        return large(meta.len());
    }
    let mut data = Vec::new();
    let read =
        fs::File::open(path).and_then(|file| file.take(MAX_SIDE_BYTES + 1).read_to_end(&mut data));
    if read.is_err() {
        return Side::Unreadable;
    }
    if data.len() as u64 > MAX_SIDE_BYTES {
        return large(data.len() as u64);
    }
    let info = SideInfo {
        bytes: data.len() as u64,
        digest: short(&crate::stable_digest::bytes(&data)),
    };
    Side::Bytes(info, data)
}

fn info_of(side: &Side) -> Option<SideInfo> {
    match side {
        Side::Large(info) | Side::Bytes(info, _) => Some(info.clone()),
        Side::Missing | Side::Unreadable => None,
    }
}

fn contains_private_key(text: &str) -> bool {
    text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----")
}

/// Text of a side, when it is UTF-8 without NUL bytes.
fn text_of(data: &[u8]) -> Option<&str> {
    if data.contains(&0) {
        return None;
    }
    std::str::from_utf8(data).ok()
}

fn entry(
    rel: String,
    state: UnitState,
    kind: DiffKind,
    installed: Option<SideInfo>,
    bundled: Option<SideInfo>,
    note: Option<&str>,
) -> FileDiffEntry {
    FileDiffEntry {
        rel,
        state,
        kind,
        from_label: "yours".to_string(),
        to_label: "bundled".to_string(),
        installed,
        bundled,
        note: note.map(str::to_string),
        added: 0,
        removed: 0,
        truncated: false,
        diff: String::new(),
    }
}

/// Compares the two sides of one file. Every note is a fixed phrase: file text only ever travels
/// in `diff`.
fn compare_sides(rel: String, state: UnitState, installed: &Side, bundled: &Side) -> FileDiffEntry {
    let (installed_info, bundled_info) = (info_of(installed), info_of(bundled));
    let make = |kind, note| {
        entry(
            rel.clone(),
            state,
            kind,
            installed_info.clone(),
            bundled_info.clone(),
            note,
        )
    };
    match (installed, bundled) {
        (Side::Missing | Side::Unreadable, _) => make(
            DiffKind::Unreadable,
            Some("your file is missing or cannot be read"),
        ),
        (_, Side::Missing | Side::Unreadable) => make(
            DiffKind::BundledMissing,
            Some("there is no bundled copy to compare with"),
        ),
        (Side::Large(_), _) | (_, Side::Large(_)) => make(
            DiffKind::TooLarge,
            Some("too large to compare here; sizes and digests only"),
        ),
        (Side::Bytes(_, mine), Side::Bytes(_, theirs)) => {
            let (Some(mine_text), Some(theirs_text)) = (text_of(mine), text_of(theirs)) else {
                return make(DiffKind::Binary, Some("not text; sizes and digests only"));
            };
            if contains_private_key(mine_text) || contains_private_key(theirs_text) {
                return make(DiffKind::Withheld, Some("contains key material, not shown"));
            }
            let diff = crate::rules_diff::unified_diff("yours", "bundled", mine_text, theirs_text);
            if diff.text.is_empty() {
                // Equal line by line, different bytes: line endings or trailing bytes.
                return make(
                    DiffKind::IdenticalText,
                    Some("differs only in line endings or trailing bytes"),
                );
            }
            let mut result = make(DiffKind::Text, None);
            result.added = diff.added;
            result.removed = diff.removed;
            result.truncated = diff.truncated;
            result.diff = diff.text;
            result
        }
    }
}

fn diff_file(operation: &PlannedArtifact, workspace_root: &Path, home: &Path) -> FileDiffEntry {
    let state = file_status(operation, "").state;
    let rel = match &operation.artifact {
        ArtifactId::SkillFile(skill) => skill.rel.as_str().to_string(),
        other => dest_file_name(other, home, workspace_root),
    };
    let Ok((source, dest)) = crate::setup_transaction::validate_artifact_source_dest(
        &operation.artifact,
        workspace_root,
        home,
    ) else {
        return entry(
            rel,
            state,
            DiffKind::Unreadable,
            None,
            None,
            Some("a link or folder is in the way; nothing can be compared"),
        );
    };
    compare_sides(rel, state, &read_side(&dest), &read_side(&source))
}

/// A bounded read-only diff of the installed files of `unit` against the bundled ones: what a
/// replacement by the bundled version would change.
pub fn diff_unit(unit: &Unit<'_>, workspace_root: &Path, home: &Path) -> FileDiffView {
    let mut files = Vec::new();
    let mut budget = MAX_UNIT_DIFF_BYTES;
    let mut truncated = false;
    for operation in unit.files.iter().take(MAX_DIFF_FILES) {
        let mut file = diff_file(operation, workspace_root, home);
        if file.diff.len() > budget {
            file.diff = String::new();
            file.truncated = true;
            file.note = Some("not shown: the diff of this unit is capped at 256 KB".to_string());
        }
        budget -= file.diff.len();
        truncated |= file.truncated;
        files.push(file);
    }
    FileDiffView {
        name: unit.name.clone(),
        folder: unit_folder(unit, home, workspace_root),
        files,
        more_files: unit.files.len().saturating_sub(MAX_DIFF_FILES),
        truncated,
    }
}

// ── Take bundled ──

/// One file a take-bundled review replaces.
#[derive(Debug, Clone, Serialize)]
pub struct TakeBundledFile {
    pub rel: String,
    pub state: UnitState,
    /// Where the backup of your file lands, below the backup folder of the transaction.
    pub backup_name: String,
    /// `sha256:` and the first twelve hex digits of your file as it is now.
    pub installed_digest: String,
    /// The same for the bundled file that replaces it.
    pub bundled_digest: String,
}

/// The files of `unit` that `operations` (from `take_bundled_operations`) replace, at most
/// [`MAX_UNIT_FILES`], and how many more there are. Digests only, never file text.
pub fn take_bundled_files(
    unit: &Unit<'_>,
    operations: &[PlannedArtifact],
    workspace_root: &Path,
    home: &Path,
) -> (Vec<TakeBundledFile>, usize) {
    let bundled_root = crate::skill_sources::SkillSources::for_workspace(workspace_root).ok();
    let files = unit
        .files
        .iter()
        .take(MAX_UNIT_FILES)
        .filter_map(|file| {
            let overwrite = operations
                .iter()
                .find(|operation| operation.artifact == file.artifact)?
                .overwrite
                .as_ref()?;
            let bundled = bundled_root.as_ref().and_then(|root| {
                crate::setup_fingerprint::artifact_source_digest(&file.artifact, root, home).ok()
            });
            let status = file_status(file, &dest_file_name(&file.artifact, home, workspace_root));
            Some(TakeBundledFile {
                rel: status.rel,
                state: status.state,
                backup_name: format!(
                    "artifacts/{}",
                    crate::setup_transaction::artifact_backup_rel(&file.artifact)
                ),
                installed_digest: short(&overwrite.expected_installed_digest),
                bundled_digest: bundled.as_deref().map(short).unwrap_or_default(),
            })
        })
        .collect();
    (files, unit.files.len().saturating_sub(MAX_UNIT_FILES))
}

/// Whether the operation is a file the user keeps.
pub fn is_kept(operation: &PlannedArtifact) -> bool {
    operation.kind == OperationKind::Manual
        && operation.file.is_some_and(|file| file.kept.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::{AgentName, SkillName, SkillRelPath};
    use crate::setup_transaction::{PreviousState, RollbackAction};

    fn operation(artifact: ArtifactId, file: Option<FileConflict>) -> PlannedArtifact {
        let kept = file.is_some_and(|file| file.kept.is_some());
        PlannedArtifact {
            surface: artifact.surface(),
            artifact,
            kind: if kept {
                OperationKind::Manual
            } else {
                OperationKind::Conflict
            },
            previous_state: PreviousState::Conflict,
            rollback_action: RollbackAction::NoAction,
            rules: None,
            rules_rewrite: None,
            mcp: None,
            file,
            overwrite: None,
        }
    }

    fn skill_file(root: SkillRoot, name: &str, rel: &str) -> ArtifactId {
        ArtifactId::skill_file(
            root,
            SkillName::new(name).unwrap(),
            SkillRelPath::new(rel).unwrap(),
        )
    }

    fn conflict(reason: ConflictReason) -> Option<FileConflict> {
        Some(FileConflict {
            reason,
            kept: None,
            wanted: true,
        })
    }

    fn kept(bundle_changed: bool) -> Option<FileConflict> {
        Some(FileConflict {
            reason: ConflictReason::Edited,
            kept: Some(KeptState { bundle_changed }),
            wanted: true,
        })
    }

    #[test]
    fn files_of_one_skill_in_one_folder_form_one_unit() {
        let planned = vec![
            operation(
                skill_file(SkillRoot::Claude, "tdd", "SKILL.md"),
                conflict(ConflictReason::Edited),
            ),
            operation(
                skill_file(SkillRoot::Claude, "tdd", "HUNTING.md"),
                conflict(ConflictReason::Unproven),
            ),
            operation(
                skill_file(SkillRoot::Agents, "tdd", "SKILL.md"),
                conflict(ConflictReason::Unproven),
            ),
            operation(skill_file(SkillRoot::Claude, "diagnose", "SKILL.md"), None),
        ];
        let grouped = units(&planned);
        let keys: Vec<&str> = grouped.iter().map(|unit| unit.key.as_str()).collect();
        assert_eq!(keys, ["skill:claude:tdd", "skill:agents:tdd"]);
        assert_eq!(grouped[0].files.len(), 2);
        assert_eq!(grouped[0].reason(), ConflictReason::Edited);
        assert_eq!(grouped[1].reason(), ConflictReason::Unproven);
    }

    #[test]
    fn an_agent_is_a_unit_of_its_own_and_kept_units_follow_conflicts() {
        let planned = vec![
            operation(
                ArtifactId::ClaudeAgent(AgentName::new("verifier").unwrap()),
                kept(true),
            ),
            operation(
                ArtifactId::ClaudeAgent(AgentName::new("sentinel").unwrap()),
                conflict(ConflictReason::Edited),
            ),
        ];
        let grouped = units(&planned);
        let order: Vec<(&str, UnitState)> = grouped
            .iter()
            .map(|unit| (unit.key.as_str(), unit.state()))
            .collect();
        assert_eq!(
            order,
            [
                ("agent:sentinel", UnitState::Conflict),
                ("agent:verifier", UnitState::Kept)
            ]
        );
        assert!(grouped[1].bundle_changed());
        assert!(!grouped[0].bundle_changed());
    }

    #[test]
    fn a_unit_with_one_file_still_blocking_is_a_conflict() {
        let planned = vec![
            operation(
                skill_file(SkillRoot::Claude, "tdd", "SKILL.md"),
                kept(false),
            ),
            operation(
                skill_file(SkillRoot::Claude, "tdd", "HUNTING.md"),
                conflict(ConflictReason::Unproven),
            ),
        ];
        assert_eq!(units(&planned)[0].state(), UnitState::Conflict);
    }

    #[test]
    fn a_unit_is_wanted_only_when_every_file_is() {
        let mut stale = conflict(ConflictReason::Edited).unwrap();
        stale.wanted = false;
        let planned = vec![
            operation(
                skill_file(SkillRoot::Claude, "old", "SKILL.md"),
                Some(stale),
            ),
            operation(
                skill_file(SkillRoot::Claude, "old", "HUNTING.md"),
                conflict(ConflictReason::Edited),
            ),
        ];
        assert!(!units(&planned)[0].wanted);
    }

    #[test]
    fn files_that_are_not_skill_or_agent_files_are_never_units() {
        let planned = vec![operation(
            ArtifactId::CodexConfig,
            conflict(ConflictReason::Edited),
        )];
        assert!(units(&planned).is_empty());
        assert!(!is_files_surface(SetupSurfaceId::CodexConfig));
        assert!(!is_files_surface(SetupSurfaceId::ClaudeRules));
        assert!(is_files_surface(SetupSurfaceId::Skills));
        assert!(is_files_surface(SetupSurfaceId::CursorAgents));
    }

    #[test]
    fn the_status_lists_units_and_files_within_their_caps() {
        let home = Path::new("/home/mock");
        let ws = Path::new("/home/mock/ws");
        let mut planned = Vec::new();
        for index in 0..(MAX_STATUS_UNITS + 3) {
            planned.push(operation(
                skill_file(SkillRoot::Claude, &format!("skill-{index:03}"), "SKILL.md"),
                conflict(ConflictReason::Edited),
            ));
        }
        for index in 0..(MAX_UNIT_FILES + 2) {
            planned.push(operation(
                skill_file(SkillRoot::Claude, "a-wide", &format!("file-{index:03}.md")),
                conflict(ConflictReason::Edited),
            ));
        }
        let status = files_status(SetupSurfaceId::Skills, &planned, None, ws, home).unwrap();
        assert_eq!(status.conflicts, MAX_STATUS_UNITS + 3 + MAX_UNIT_FILES + 2);
        assert_eq!(status.kept, 0);
        assert_eq!(status.units.len(), MAX_STATUS_UNITS);
        assert_eq!(status.more, 4);
        let wide = status
            .units
            .iter()
            .find(|unit| unit.name == "a-wide")
            .unwrap();
        assert_eq!(wide.files.len(), MAX_UNIT_FILES);
        assert_eq!(wide.more_files, 2);
        assert_eq!(wide.folder, "~/.claude/skills");
    }

    #[test]
    fn a_surface_without_units_or_files_has_no_status() {
        let home = Path::new("/home/mock");
        let ws = Path::new("/home/mock/ws");
        assert!(files_status(SetupSurfaceId::Skills, &[], None, ws, home).is_none());
        let planned = vec![operation(
            ArtifactId::CodexConfig,
            conflict(ConflictReason::Edited),
        )];
        assert!(files_status(SetupSurfaceId::CodexConfig, &planned, None, ws, home).is_none());
    }

    // ── Diff reading ──

    fn temp(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-file-diff-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The comparison of two byte strings, read from disk the way `diff_file` reads them.
    fn compare(label: &str, mine: &[u8], theirs: &[u8]) -> (FileDiffEntry, std::path::PathBuf) {
        let dir = temp(label);
        let (a, b) = (dir.join("mine"), dir.join("theirs"));
        fs::write(&a, mine).unwrap();
        fs::write(&b, theirs).unwrap();
        let entry = compare_sides(
            "f".into(),
            UnitState::Conflict,
            &read_side(&a),
            &read_side(&b),
        );
        (entry, dir)
    }

    #[test]
    fn sides_are_read_with_size_and_a_short_digest() {
        let dir = temp("side");
        let path = dir.join("f");
        fs::write(&path, b"hello\n").unwrap();
        match read_side(&path) {
            Side::Bytes(info, data) => {
                assert_eq!(info.bytes, 6);
                assert_eq!(info.digest.len(), SHORT_DIGEST_CHARS);
                assert!(info.digest.starts_with("sha256:"));
                assert_eq!(data, b"hello\n");
            }
            _ => panic!("a small file is read"),
        }
        assert!(matches!(read_side(&dir.join("absent")), Side::Missing));
        assert!(
            matches!(read_side(&dir), Side::Unreadable),
            "a folder is not a file"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_over_the_limit_is_shown_by_size_and_digest_only() {
        let dir = temp("large");
        let path = dir.join("f");
        fs::write(&path, vec![b'a'; MAX_SIDE_BYTES as usize + 1]).unwrap();
        match read_side(&path) {
            Side::Large(info) => {
                assert_eq!(info.bytes, MAX_SIDE_BYTES + 1);
                assert_eq!(info.digest.len(), SHORT_DIGEST_CHARS);
            }
            _ => panic!("a file over the limit is not read"),
        }
        let (entry, dir2) = compare(
            "large2",
            &vec![b'a'; MAX_SIDE_BYTES as usize + 1],
            b"small\n",
        );
        assert_eq!(entry.kind, DiffKind::TooLarge);
        assert!(entry.diff.is_empty());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    #[test]
    fn text_with_a_nul_byte_or_invalid_utf8_is_binary() {
        assert!(text_of(b"plain\n").is_some());
        assert!(text_of(b"nul\0inside").is_none());
        assert!(text_of(&[0xff, 0xfe, b'a']).is_none());
        let (entry, dir) = compare("binary", b"a\0b", b"text\n");
        assert_eq!(entry.kind, DiffKind::Binary);
        assert!(entry.diff.is_empty());
        assert!(entry.installed.is_some() && entry.bundled.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn private_key_material_on_either_side_is_withheld() {
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
        assert!(contains_private_key(key));
        assert!(!contains_private_key("-----BEGIN CERTIFICATE-----\nabc\n"));
        for (mine, theirs) in [(key, "plain\n"), ("plain\n", key)] {
            let (entry, dir) = compare("pem", mine.as_bytes(), theirs.as_bytes());
            assert_eq!(entry.kind, DiffKind::Withheld);
            assert!(entry.diff.is_empty(), "no text travels for a withheld file");
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn line_ending_only_differences_are_identical_text() {
        let (entry, dir) = compare("crlf", b"a\r\nb\r\n", b"a\nb\n");
        assert_eq!(entry.kind, DiffKind::IdenticalText);
        assert!(entry.diff.is_empty());
        let (entry, dir2) = compare("text", b"a\nb\n", b"a\nc\n");
        assert_eq!(entry.kind, DiffKind::Text);
        assert!(
            entry.diff.contains("-b") && entry.diff.contains("+c"),
            "{}",
            entry.diff
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }
}
