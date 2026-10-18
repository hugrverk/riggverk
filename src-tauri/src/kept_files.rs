//! Per-file "I keep my version of this skill or agent file" choices.
//!
//! A skill or agent file the user edited by hand is a conflict the app refuses to resolve on its
//! own. The user can keep their version: the choice is recorded here, and the file then plans as a
//! manual step instead of a conflict, so it no longer blocks and is never written by an update.
//! Nothing in this module lets the app write to a skill or agent file; it writes only
//! `kept-files.json`.
//!
//! An entry names the file by artifact identity (the key managed state and manifests use) and by
//! the destination it had when the choice was made. An identity names a root, not a path, so a
//! root that moved (`CODEX_HOME`, a skills path variable) must not inherit the choice: an entry
//! applies only while the artifact still resolves to the recorded destination.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::ArtifactId;
use crate::managed_state::artifact_identity;

pub const KEPT_FILES_REL: &str = ".agent-workspace/kept-files.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Most files one workspace can keep; a bigger file is read as no choices.
pub const MAX_ENTRIES: usize = 2048;

/// One kept file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeptEntry {
    /// `artifact_identity` of the file.
    pub identity: String,
    /// Display form (`~/...`) of the destination the choice was made for.
    pub dest: String,
    /// Digest of the bundled file when the choice was made. A missing digest counts as changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeptDocument {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    kept: Vec<KeptEntry>,
}

/// What `kept-files.json` holds.
enum Stored {
    Absent,
    Usable(Vec<KeptEntry>),
    /// Valid JSON of another schema version: written by another version of the app.
    Foreign,
    /// Unreadable, oversized, not a regular file, behind a link, or not JSON.
    Unusable,
}

fn path_of(workspace_root: &Path) -> PathBuf {
    workspace_root.join(KEPT_FILES_REL)
}

fn read_stored(workspace_root: &Path) -> Stored {
    let path = path_of(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "kept files").is_err()
        || crate::path_safety::reject_symlink(&path, "kept files").is_err()
    {
        return Stored::Unusable;
    }
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Stored::Absent,
        Err(_) => return Stored::Unusable,
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Stored::Unusable;
    }
    let Some(document) = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<KeptDocument>(&raw).ok())
    else {
        return Stored::Unusable;
    };
    if document.schema_version != SCHEMA_VERSION {
        return Stored::Foreign;
    }
    if document.kept.len() > MAX_ENTRIES {
        return Stored::Unusable;
    }
    Stored::Usable(document.kept)
}

/// Files the app can resolve: a skill file or an agent file. Rules files, configs, MCP files and
/// workspace files have their own flows and can never be kept here.
pub fn is_keepable(artifact: &ArtifactId) -> bool {
    matches!(
        artifact,
        ArtifactId::SkillFile(_)
            | ArtifactId::OpenCodeAgent(_)
            | ArtifactId::CodexAgent(_)
            | ArtifactId::ClaudeAgent(_)
            | ArtifactId::CursorAgent(_)
    )
}

/// The destination of `artifact` as an entry records it.
pub fn dest_label(
    artifact: &ArtifactId,
    home: &Path,
    workspace_root: &Path,
) -> Result<String, String> {
    let dest = artifact.resolve_dest(home, workspace_root)?;
    Ok(crate::skill_loads::display_path(&dest, home))
}

/// The kept files of a workspace, read once per plan.
#[derive(Debug, Clone, Default)]
pub struct KeptFiles {
    entries: HashMap<String, KeptEntry>,
}

impl KeptFiles {
    /// An unreadable, oversized or unsupported file counts as "no choices": the files then keep
    /// reporting their conflicts, which is the safe default.
    pub fn load(workspace_root: &Path) -> Self {
        match read_stored(workspace_root) {
            Stored::Usable(entries) => Self {
                entries: entries
                    .into_iter()
                    .map(|entry| (entry.identity.clone(), entry))
                    .collect(),
            },
            Stored::Absent | Stored::Foreign | Stored::Unusable => Self::default(),
        }
    }

    /// The choice recorded for `artifact`, when it was made for the file at `dest` (see
    /// [`dest_label`]).
    pub fn entry(&self, artifact: &ArtifactId, dest: &str) -> Option<&KeptEntry> {
        if self.entries.is_empty() || !is_keepable(artifact) {
            return None;
        }
        self.entries
            .get(&artifact_identity(artifact))
            .filter(|entry| entry.dest == dest)
    }

    /// Whether `artifact` has an entry for exactly this destination.
    pub fn contains(&self, artifact: &ArtifactId, dest: &str) -> bool {
        self.entry(artifact, dest).is_some()
    }
}

/// Identities of the kept files that now equal the bundled file, for the destination they were kept
/// at. `equals_bundle` decides for one artifact whether its installed file is the bundled one.
///
/// Such an entry is inert: the file is current, so it plans as no change and the choice is never
/// consulted. It must not outlive that, or a later edit of the file would be taken for a file the
/// user still keeps. The caller releases them.
pub fn matching_the_bundle(
    workspace_root: &Path,
    home: &Path,
    equals_bundle: impl Fn(&ArtifactId) -> bool,
) -> Vec<String> {
    let Stored::Usable(entries) = read_stored(workspace_root) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|entry| {
            crate::managed_bootstrap::artifact_from_identity(&entry.identity)
                .ok()
                .is_some_and(|artifact| {
                    is_keepable(&artifact)
                        && dest_label(&artifact, home, workspace_root)
                            .is_ok_and(|dest| dest == entry.dest)
                        && equals_bundle(&artifact)
                })
        })
        .map(|entry| entry.identity)
        .collect()
}

/// A file to keep.
pub struct Keep {
    pub artifact: ArtifactId,
    pub dest: String,
    pub bundle: Option<String>,
}

fn update(
    workspace_root: &Path,
    change: impl FnOnce(&mut Vec<KeptEntry>) -> Result<(), String>,
) -> Result<(), String> {
    let mut before = match read_stored(workspace_root) {
        Stored::Usable(entries) => entries,
        Stored::Absent | Stored::Unusable => Vec::new(),
        Stored::Foreign => {
            return Err(
                "kept-files.json was written by another version of Riggverk; update the app or move the file away"
                    .to_string(),
            )
        }
    };
    before.sort_by(|a, b| a.identity.cmp(&b.identity));
    let mut after = before.clone();
    change(&mut after)?;
    after.sort_by(|a, b| a.identity.cmp(&b.identity));
    if after == before {
        return Ok(());
    }
    if after.len() > MAX_ENTRIES {
        return Err("too many kept files".to_string());
    }
    let document = KeptDocument {
        schema_version: SCHEMA_VERSION,
        kept: after,
    };
    let raw = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("serialize kept files: {error}"))?;
    crate::safe_filesystem::write_regular_file_atomic(
        &path_of(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|error| format!("write kept files: {error}"))
}

/// Records the files as kept. A file already kept is replaced, so its destination and bundled
/// digest follow the new choice. Writes only `kept-files.json`, and nothing when it would not
/// change.
pub fn keep(workspace_root: &Path, items: &[Keep]) -> Result<(), String> {
    if let Some(item) = items.iter().find(|item| !is_keepable(&item.artifact)) {
        return Err(format!(
            "only skill and agent files can be kept: {:?}",
            item.artifact
        ));
    }
    update(workspace_root, |entries| {
        for item in items {
            let identity = artifact_identity(&item.artifact);
            entries.retain(|entry| entry.identity != identity);
            entries.push(KeptEntry {
                identity,
                dest: item.dest.clone(),
                bundle: item.bundle.clone(),
            });
        }
        Ok(())
    })
}

/// Removes the choices of the files with these identities. Writes nothing when none is kept.
pub fn release(workspace_root: &Path, identities: &[String]) -> Result<(), String> {
    if identities.is_empty() {
        return Ok(());
    }
    update(workspace_root, |entries| {
        entries.retain(|entry| !identities.contains(&entry.identity));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_registry::{AgentName, SkillName, SkillRelPath};
    use crate::skill_roots::SkillRoot;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-kept-files-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn skill(name: &str, rel: &str) -> ArtifactId {
        ArtifactId::skill_file(
            SkillRoot::Claude,
            SkillName::new(name).unwrap(),
            SkillRelPath::new(rel).unwrap(),
        )
    }

    fn agent(name: &str) -> ArtifactId {
        ArtifactId::ClaudeAgent(AgentName::new(name).unwrap())
    }

    fn keep_one(artifact: &ArtifactId, dest: &str, bundle: Option<&str>) -> Keep {
        Keep {
            artifact: artifact.clone(),
            dest: dest.to_string(),
            bundle: bundle.map(str::to_string),
        }
    }

    #[test]
    fn choices_round_trip_per_identity_and_sort() {
        let ws = temp("roundtrip");
        let tdd = skill("tdd", "SKILL.md");
        let verifier = agent("verifier");
        assert!(KeptFiles::load(&ws).entry(&tdd, "~/a").is_none());

        keep(
            &ws,
            &[
                keep_one(&verifier, "~/.claude/agents/verifier.md", Some("sha256:b")),
                keep_one(&tdd, "~/.claude/skills/tdd/SKILL.md", Some("sha256:a")),
            ],
        )
        .unwrap();
        let kept = KeptFiles::load(&ws);
        let entry = kept
            .entry(&tdd, "~/.claude/skills/tdd/SKILL.md")
            .expect("tdd is kept");
        assert_eq!(entry.bundle.as_deref(), Some("sha256:a"));
        assert!(kept.contains(&verifier, "~/.claude/agents/verifier.md"));
        assert!(!kept.contains(&skill("tdd", "HUNTING.md"), "~/.claude/skills/tdd/SKILL.md"));

        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(path_of(&ws)).unwrap()).unwrap();
        assert_eq!(raw["schema_version"], 1);
        let identities: Vec<&str> = raw["kept"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["identity"].as_str().unwrap())
            .collect();
        let mut sorted = identities.clone();
        sorted.sort();
        assert_eq!(identities, sorted, "entries are written in identity order");

        release(&ws, &[artifact_identity(&tdd)]).unwrap();
        let kept = KeptFiles::load(&ws);
        assert!(!kept.contains(&tdd, "~/.claude/skills/tdd/SKILL.md"));
        assert!(kept.contains(&verifier, "~/.claude/agents/verifier.md"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn an_entry_applies_only_to_the_destination_it_was_made_for() {
        let ws = temp("dest");
        let tdd = skill("tdd", "SKILL.md");
        keep(
            &ws,
            &[keep_one(&tdd, "~/.claude/skills/tdd/SKILL.md", None)],
        )
        .unwrap();
        let kept = KeptFiles::load(&ws);
        assert!(kept.contains(&tdd, "~/.claude/skills/tdd/SKILL.md"));
        assert!(
            !kept.contains(&tdd, "~/elsewhere/skills/tdd/SKILL.md"),
            "a moved root does not inherit the choice"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_missing_bundle_digest_is_kept_as_missing() {
        let ws = temp("bundle");
        let tdd = skill("tdd", "SKILL.md");
        keep(&ws, &[keep_one(&tdd, "~/d", None)]).unwrap();
        let kept = KeptFiles::load(&ws);
        assert_eq!(kept.entry(&tdd, "~/d").unwrap().bundle, None);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn only_skill_and_agent_files_can_be_kept() {
        let ws = temp("kinds");
        for artifact in [
            ArtifactId::CodexConfig,
            ArtifactId::ClaudeRules,
            ArtifactId::CursorMcp,
            ArtifactId::WorkspaceFile(
                crate::artifact_registry::WorkspaceRelPath::new("README.md").unwrap(),
            ),
        ] {
            assert!(!is_keepable(&artifact), "{artifact:?}");
            assert!(keep(&ws, &[keep_one(&artifact, "~/d", None)]).is_err());
        }
        assert!(!path_of(&ws).exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unreadable_oversized_or_foreign_files_mean_no_choices() {
        let ws = temp("garbage");
        let tdd = skill("tdd", "SKILL.md");
        let identity = artifact_identity(&tdd);
        let path = path_of(&ws);
        fs::create_dir_all(path.parent().unwrap()).unwrap();

        fs::write(&path, "not json").unwrap();
        assert!(KeptFiles::load(&ws).entry(&tdd, "~/d").is_none());

        let entry = serde_json::json!({"identity": identity, "dest": "~/d"});
        fs::write(
            &path,
            serde_json::json!({"schema_version": 99, "kept": [entry]}).to_string(),
        )
        .unwrap();
        assert!(KeptFiles::load(&ws).entry(&tdd, "~/d").is_none());

        let padding = "x".repeat(MAX_FILE_BYTES as usize);
        fs::write(
            &path,
            serde_json::json!({"schema_version": 1, "kept": [entry], "pad": padding}).to_string(),
        )
        .unwrap();
        assert!(KeptFiles::load(&ws).entry(&tdd, "~/d").is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_file_of_another_schema_is_not_overwritten() {
        let ws = temp("foreign");
        let path = path_of(&ws);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let foreign = r#"{"schema_version": 7, "kept": []}"#;
        fs::write(&path, foreign).unwrap();
        let error = keep(&ws, &[keep_one(&skill("tdd", "SKILL.md"), "~/d", None)]).unwrap_err();
        assert!(error.contains("another version"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), foreign);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn repeating_a_choice_or_releasing_nothing_writes_nothing() {
        let ws = temp("idempotent");
        let tdd = skill("tdd", "SKILL.md");
        release(&ws, &[artifact_identity(&tdd)]).unwrap();
        assert!(
            !path_of(&ws).exists(),
            "nothing was kept, nothing is written"
        );

        keep(&ws, &[keep_one(&tdd, "~/d", Some("sha256:a"))]).unwrap();
        let first = fs::read(path_of(&ws)).unwrap();
        keep(&ws, &[keep_one(&tdd, "~/d", Some("sha256:a"))]).unwrap();
        assert_eq!(fs::read(path_of(&ws)).unwrap(), first);

        release(&ws, &[artifact_identity(&skill("tdd", "OTHER.md"))]).unwrap();
        assert_eq!(fs::read(path_of(&ws)).unwrap(), first);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn keeping_again_replaces_the_recorded_digest() {
        let ws = temp("replace");
        let tdd = skill("tdd", "SKILL.md");
        keep(&ws, &[keep_one(&tdd, "~/d", Some("sha256:a"))]).unwrap();
        keep(&ws, &[keep_one(&tdd, "~/d", Some("sha256:b"))]).unwrap();
        let kept = KeptFiles::load(&ws);
        assert_eq!(
            kept.entry(&tdd, "~/d").unwrap().bundle.as_deref(),
            Some("sha256:b")
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn more_than_the_cap_is_refused_and_nothing_is_written() {
        let ws = temp("cap");
        let items: Vec<Keep> = (0..=MAX_ENTRIES)
            .map(|index| Keep {
                artifact: skill("tdd", &format!("file-{index}.md")),
                dest: "~/d".to_string(),
                bundle: None,
            })
            .collect();
        let error = keep(&ws, &items).unwrap_err();
        assert!(error.contains("too many"), "{error}");
        assert!(!path_of(&ws).exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_way_is_no_choices_and_is_not_followed() {
        let ws = temp("link");
        let elsewhere = temp("link-target");
        let tdd = skill("tdd", "SKILL.md");
        keep(&ws, &[keep_one(&tdd, "~/d", None)]).unwrap();
        let real = fs::read(path_of(&ws)).unwrap();
        let target = elsewhere.join("kept-files.json");
        fs::write(&target, &real).unwrap();
        fs::remove_file(path_of(&ws)).unwrap();
        std::os::unix::fs::symlink(&target, path_of(&ws)).unwrap();

        assert!(KeptFiles::load(&ws).entry(&tdd, "~/d").is_none());
        assert!(keep(&ws, &[keep_one(&skill("tdd", "X.md"), "~/d", None)]).is_err());
        assert_eq!(
            fs::read(&target).unwrap(),
            real,
            "the link target is untouched"
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&elsewhere);
    }
}
