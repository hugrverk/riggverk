//! Which skill copies each enabled harness loads, and which of them are a problem. Read only.
//!
//! Harnesses read overlapping skill folders (see [`crate::skill_roots::readers`]), so one skill can
//! be loaded from several places. What a harness does with a name it finds twice differs:
//!
//! - Codex lists every copy; a plain `$name` mention then selects nothing.
//! - OpenCode 1.x keeps one copy per name and which one varies from run to run; when the copies
//!   are byte for byte equal that is harmless.
//! - Cursor may list each copy (not verified for every version).
//! - Claude Code reads one folder, so a skill has one copy.
//!
//! The scan looks at `<folder>/<dir>/SKILL.md` for the direct, non-hidden subfolders of each
//! folder a harness reads, and at nothing else: no other file of a skill is opened. It is bounded
//! (see the constants), never follows a link out of the home folder, and counts a copy once however
//! many folders or links lead to it. Copies the app did not install are the user's own: they are
//! reported on their own, because the app cannot fix them.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agent_targets::HarnessId;
use crate::artifact_registry::{ArtifactId, SkillName};
use crate::managed_state::{artifact_identity, ManagedArtifactRecord};
use crate::skill_roots::{readers, ReadFolder, SkillRoot};

/// A `SKILL.md` larger than this is not read (a skill the app ships is a fraction of it).
pub const MAX_SKILL_MD_BYTES: u64 = 1024 * 1024;
/// Subfolders looked at per skills folder; further ones are counted as skipped.
const MAX_ENTRIES_PER_FOLDER: usize = 1000;
/// `SKILL.md` bytes read per skills folder; a file that would pass it is counted as skipped.
const MAX_BYTES_PER_FOLDER: u64 = 32 * 1024 * 1024;
/// Longest skill name shown; the name comes from a file the user controls.
const MAX_NAME_CHARS: usize = 80;
/// Hex digits of the content hash shown for a copy.
const HASH_HEX_CHARS: usize = 12;

/// Who a copy belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Owner {
    /// A version of a bundled skill the app wrote, or could have written
    Aw,
    /// Anything else: the user's own skill, or a bundled skill they edited
    Foreign,
}

/// One `SKILL.md` a harness would load.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillCopy {
    pub folder: ReadFolder,
    /// The skill's folder, `~/.claude/skills/tdd`; absolute when it is not below the home folder
    pub path: String,
    /// First hex digits of the SHA-256 of the file
    pub hash: String,
    pub owner: Owner,
    /// The file equals the bundled `SKILL.md` of that skill
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillLoadFlag {
    /// Codex lists every copy, so a plain `$name` mention selects none of them
    PlainMentionAmbiguous,
    /// OpenCode 1.x keeps one copy per name, and which one varies between runs
    WinnerNondeterministic,
    /// OpenCode with several byte-identical copies: noisy in its log, harmless, so information
    /// only and no warning
    DuplicateIdentical,
    /// Cursor may list every copy; not verified for every Cursor version
    PossibleDuplicate,
    /// At least one of several copies is the user's own: the app cannot fix it
    ForeignCopy,
}

/// One skill name as one harness sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillLoad {
    pub name: String,
    /// Every copy the harness can reach, in the order it reads its folders
    pub copies: Vec<SkillCopy>,
    /// Index into `copies` of the copy that is loaded when there is only one candidate; `None`
    /// when the harness loads several or the choice cannot be told
    pub winner: Option<usize>,
    pub flags: Vec<SkillLoadFlag>,
}

/// A folder a harness reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderInfo {
    pub folder: ReadFolder,
    pub path: String,
    pub exists: bool,
    /// Why the folder was not read completely, when it was not
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessSkillLoads {
    pub harness: HarnessId,
    pub folders: Vec<FolderInfo>,
    /// Sorted by name
    pub skills: Vec<SkillLoad>,
}

/// A skill name with several copies, some of them the user's own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForeignDuplicate {
    pub name: String,
    pub harnesses: Vec<HarnessId>,
    pub copies: Vec<SkillCopy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffectiveSkillLoads {
    pub harnesses: Vec<HarnessSkillLoads>,
    pub foreign_duplicates: Vec<ForeignDuplicate>,
}

/// Where each skills folder is. Injectable so tests do not depend on the environment.
#[derive(Debug, Clone, Default)]
pub struct FolderPaths(HashMap<ReadFolder, PathBuf>);

impl FolderPaths {
    /// The folders of this process: environment overrides and the Cursor profile included. A
    /// folder whose location cannot be worked out is left out and not scanned.
    pub fn resolve(home: &Path) -> Self {
        let mut paths = HashMap::new();
        for folder in ReadFolder::ALL {
            let path = match folder.root() {
                Some(root) => root.path(home).ok(),
                None => Some(home.join(".codex/skills")),
            };
            if let Some(path) = path {
                paths.insert(folder, path);
            }
        }
        Self(paths)
    }

    /// The default folders below `home`.
    #[cfg(test)]
    pub fn under(home: &Path) -> Self {
        Self(
            [
                (ReadFolder::Claude, ".claude/skills"),
                (ReadFolder::Agents, ".agents/skills"),
                (ReadFolder::CodexHome, ".codex/skills"),
                (ReadFolder::DotCodex, ".codex/skills"),
                (ReadFolder::OpenCode, ".config/opencode/skills"),
                (ReadFolder::Cursor, ".cursor/skills"),
            ]
            .into_iter()
            .map(|(folder, rel)| (folder, home.join(rel)))
            .collect(),
        )
    }

    fn get(&self, folder: ReadFolder) -> Option<&Path> {
        self.0.get(&folder).map(PathBuf::as_path)
    }
}

/// What tells a copy the app wrote from one that is the user's: the same proofs the planner and
/// the uninstall use. A copy is the app's when the skill is in the bundle and the file equals the
/// bundled `SKILL.md`, the hash the managed state recorded for it, or a version the app shipped.
pub struct OwnershipProof {
    bundled_root: PathBuf,
    /// Artifact identity to the hash recorded after the last apply
    records: HashMap<String, String>,
    /// Bundled skill name to the digest of its `SKILL.md`
    current: HashMap<String, String>,
}

impl OwnershipProof {
    pub fn new(bundled_root: &Path, records: &[ManagedArtifactRecord]) -> Result<Self, String> {
        let catalog = crate::skill_discovery::discover_skill_catalog(bundled_root)
            .map_err(|error| error.message().to_string())?;
        let current = catalog
            .iter()
            .filter_map(|skill| {
                let digest = crate::stable_digest::file(&skill.skill_md_path).ok()?;
                Some((skill.name.clone(), digest))
            })
            .collect();
        Ok(Self {
            bundled_root: bundled_root.to_path_buf(),
            records: records
                .iter()
                .map(|record| (record.identity.clone(), record.hash.clone()))
                .collect(),
            current,
        })
    }

    /// Owner of the copy in `skill_dir_name` below `folder`, and whether it is the bundled version.
    fn classify(&self, folder: ReadFolder, skill_dir_name: &str, digest: &str) -> (Owner, bool) {
        let Some(skill) = SkillName::new(skill_dir_name) else {
            return (Owner::Foreign, false);
        };
        let Some(bundled) = self.current.get(skill.as_str()) else {
            return (Owner::Foreign, false);
        };
        if bundled == digest {
            return (Owner::Aw, true);
        }
        // `~/.codex/skills` is never an install root; a copy there has no record of its own, but
        // the shipped versions still tell.
        let root = folder.root().unwrap_or(SkillRoot::CodexHome);
        let artifact = ArtifactId::skill_md(root, skill);
        let recorded = self
            .records
            .get(&artifact_identity(&artifact))
            .is_some_and(|hash| hash == digest);
        let owned = recorded
            || crate::shipped_digests::is_shipped_version(&artifact, &self.bundled_root, digest);
        (if owned { Owner::Aw } else { Owner::Foreign }, false)
    }
}

/// One skill found in one folder.
struct Found {
    dir: PathBuf,
    canonical: PathBuf,
    dir_name: String,
    name: String,
    digest: String,
}

struct FolderScan {
    exists: bool,
    note: Option<String>,
    found: Vec<Found>,
}

impl FolderScan {
    fn empty(exists: bool, note: Option<String>) -> Self {
        Self {
            exists,
            note,
            found: Vec::new(),
        }
    }
}

/// Reads the `SKILL.md` of every direct, non-hidden subfolder of `path`.
///
/// `home_canonical` bounds links: a folder below the home folder, or a skill in it, whose real
/// location is outside it is not read. A folder that is configured outside the home folder
/// (`CODEX_HOME`) is read, and links in it must stay inside it.
fn scan_folder(path: &Path, home: &Path, home_canonical: &Path) -> FolderScan {
    let Ok(canonical_root) = fs::canonicalize(path) else {
        return FolderScan::empty(false, None);
    };
    if !fs::metadata(&canonical_root).is_ok_and(|meta| meta.is_dir()) {
        return FolderScan::empty(false, None);
    }
    let boundary = if path.starts_with(home) {
        if !canonical_root.starts_with(home_canonical) {
            return FolderScan::empty(
                true,
                Some("a link to outside your home folder, not read".to_string()),
            );
        }
        home_canonical.to_path_buf()
    } else {
        canonical_root.clone()
    };
    let Ok(entries) = fs::read_dir(&canonical_root) else {
        return FolderScan::empty(true, Some("cannot be read".to_string()));
    };

    let mut skipped = 0usize;
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            skipped += 1;
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if names.len() >= MAX_ENTRIES_PER_FOLDER {
            skipped += 1;
            continue;
        }
        names.push(name);
    }
    names.sort();

    let mut found = Vec::new();
    let mut read_bytes = 0u64;
    for dir_name in names {
        let dir = path.join(&dir_name);
        // No SKILL.md (or a dangling link): not a skill folder, nothing to report.
        let Ok(canonical) = fs::canonicalize(dir.join("SKILL.md")) else {
            continue;
        };
        if !canonical.starts_with(&boundary) {
            skipped += 1;
            continue;
        }
        let Ok(meta) = fs::metadata(&canonical) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if read_bytes.saturating_add(meta.len()) > MAX_BYTES_PER_FOLDER {
            skipped += 1;
            continue;
        }
        let Some(bytes) = read_capped(&canonical) else {
            skipped += 1;
            continue;
        };
        read_bytes += bytes.len() as u64;
        let text = String::from_utf8_lossy(&bytes);
        let name = frontmatter_name(&text).unwrap_or_else(|| clean_name(&dir_name));
        found.push(Found {
            dir,
            canonical,
            dir_name,
            name,
            digest: crate::stable_digest::bytes(&bytes),
        });
    }

    let note = (skipped > 0).then(|| {
        format!(
            "{skipped} not read (a link outside your home folder, a SKILL.md over 1 MiB, or more than the app reads from one folder)"
        )
    });
    FolderScan {
        exists: true,
        note,
        found,
    }
}

/// The whole file, or `None` when it is larger than [`MAX_SKILL_MD_BYTES`] or cannot be read.
fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_SKILL_MD_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_SKILL_MD_BYTES).then_some(bytes)
}

/// The `name:` of the frontmatter, without quotes; `None` when there is none.
fn frontmatter_name(text: &str) -> Option<String> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some(value) = line.strip_prefix("name:") else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        return (!value.is_empty()).then(|| clean_name(value));
    }
    None
}

/// A name that is safe to show: no control characters, bounded length.
fn clean_name(raw: &str) -> String {
    raw.chars()
        .take(MAX_NAME_CHARS)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// `~/...` for a path below the home folder, the plain path otherwise.
fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!(
            "~/{}",
            rest.components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        ),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}

fn short_hash(digest: &str) -> String {
    digest
        .strip_prefix("sha256:")
        .unwrap_or(digest)
        .chars()
        .take(HASH_HEX_CHARS)
        .collect()
}

/// What loading several copies of one name means for `harness`.
fn flags_for(harness: HarnessId, copies: &[SkillCopy]) -> Vec<SkillLoadFlag> {
    if copies.len() < 2 {
        return Vec::new();
    }
    if copies.iter().any(|copy| copy.owner == Owner::Foreign) {
        return vec![SkillLoadFlag::ForeignCopy];
    }
    match harness {
        HarnessId::Codex => vec![SkillLoadFlag::PlainMentionAmbiguous],
        HarnessId::OpenCode => {
            let same = copies.windows(2).all(|pair| pair[0].hash == pair[1].hash);
            vec![if same {
                SkillLoadFlag::DuplicateIdentical
            } else {
                SkillLoadFlag::WinnerNondeterministic
            }]
        }
        HarnessId::Cursor => vec![SkillLoadFlag::PossibleDuplicate],
        HarnessId::Claude => Vec::new(),
    }
}

/// The skills each of the `enabled` harnesses loads from its folders.
pub fn effective_skill_loads(
    home: &Path,
    enabled: &[HarnessId],
    folders: &FolderPaths,
    proof: &OwnershipProof,
) -> EffectiveSkillLoads {
    let home_canonical = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let mut scans: HashMap<ReadFolder, FolderScan> = HashMap::new();
    let mut harnesses = Vec::new();

    for harness in HarnessId::ALL
        .iter()
        .copied()
        .filter(|h| enabled.contains(h))
    {
        let mut infos = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut by_name: BTreeMap<String, Vec<SkillCopy>> = BTreeMap::new();

        for &folder in readers(harness) {
            let Some(path) = folders.get(folder) else {
                continue;
            };
            let scan = scans
                .entry(folder)
                .or_insert_with(|| scan_folder(path, home, &home_canonical));
            infos.push(FolderInfo {
                folder,
                path: display_path(path, home),
                exists: scan.exists,
                note: scan.note.clone(),
            });
            for found in &scan.found {
                // A copy reached through two folders or links is one copy.
                if !seen.insert(found.canonical.clone()) {
                    continue;
                }
                let (owner, current) = proof.classify(folder, &found.dir_name, &found.digest);
                by_name
                    .entry(found.name.clone())
                    .or_default()
                    .push(SkillCopy {
                        folder,
                        path: display_path(&found.dir, home),
                        hash: short_hash(&found.digest),
                        owner,
                        current,
                    });
            }
        }

        let skills = by_name
            .into_iter()
            .map(|(name, copies)| SkillLoad {
                flags: flags_for(harness, &copies),
                winner: (copies.len() == 1).then_some(0),
                name,
                copies,
            })
            .collect();
        harnesses.push(HarnessSkillLoads {
            harness,
            folders: infos,
            skills,
        });
    }

    let foreign_duplicates = foreign_duplicates(&harnesses);
    EffectiveSkillLoads {
        harnesses,
        foreign_duplicates,
    }
}

/// Names that have several copies for some harness, at least one of them the user's own.
fn foreign_duplicates(harnesses: &[HarnessSkillLoads]) -> Vec<ForeignDuplicate> {
    let mut by_name: BTreeMap<&str, ForeignDuplicate> = BTreeMap::new();
    for loads in harnesses {
        for skill in &loads.skills {
            if !skill.flags.contains(&SkillLoadFlag::ForeignCopy) {
                continue;
            }
            let entry = by_name
                .entry(skill.name.as_str())
                .or_insert_with(|| ForeignDuplicate {
                    name: skill.name.clone(),
                    harnesses: Vec::new(),
                    copies: Vec::new(),
                });
            entry.harnesses.push(loads.harness);
            for copy in &skill.copies {
                if !entry.copies.iter().any(|known| known.path == copy.path) {
                    entry.copies.push(copy.clone());
                }
            }
        }
    }
    by_name.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shipped_digests::test_override;
    use crate::test_env::{canonical_skill_text, write_canonical_skill};

    const C: HarnessId = HarnessId::Claude;
    const X: HarnessId = HarnessId::Codex;
    const O: HarnessId = HarnessId::OpenCode;
    const U: HarnessId = HarnessId::Cursor;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-skill-loads-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        // The scan compares real paths, and a temp dir can sit behind a link (macOS /var).
        fs::canonicalize(dir).unwrap()
    }

    /// A home folder and a bundle that ships `alpha` and `beta`.
    struct Fixture {
        home: PathBuf,
        bundle: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let home = temp(&format!("{label}-home"));
            let bundle = temp(&format!("{label}-bundle"));
            write_canonical_skill(&bundle, None, "alpha", "body");
            write_canonical_skill(&bundle, None, "beta", "body");
            Self { home, bundle }
        }

        /// The bundled `SKILL.md` of `name`.
        fn current(&self, name: &str) -> String {
            canonical_skill_text(name, "body")
        }

        fn skill(&self, rel_folder: &str, dir: &str, text: &str) -> PathBuf {
            let path = self.home.join(rel_folder).join(dir).join("SKILL.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }

        fn loads(&self, enabled: &[HarnessId]) -> EffectiveSkillLoads {
            self.loads_with(enabled, &[])
        }

        fn loads_with(
            &self,
            enabled: &[HarnessId],
            records: &[ManagedArtifactRecord],
        ) -> EffectiveSkillLoads {
            let proof = OwnershipProof::new(&self.bundle, records).unwrap();
            effective_skill_loads(&self.home, enabled, &FolderPaths::under(&self.home), &proof)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
            let _ = fs::remove_dir_all(&self.bundle);
        }
    }

    fn of(loads: &EffectiveSkillLoads, harness: HarnessId) -> &HarnessSkillLoads {
        loads
            .harnesses
            .iter()
            .find(|candidate| candidate.harness == harness)
            .unwrap_or_else(|| panic!("{} is not in the result", harness.as_str()))
    }

    fn skill<'a>(loads: &'a HarnessSkillLoads, name: &str) -> &'a SkillLoad {
        loads
            .skills
            .iter()
            .find(|candidate| candidate.name == name)
            .unwrap_or_else(|| panic!("{name} is not loaded"))
    }

    fn flags(loads: &EffectiveSkillLoads, harness: HarnessId, name: &str) -> Vec<SkillLoadFlag> {
        skill(of(loads, harness), name).flags.clone()
    }

    /// An older version of `alpha` that the app shipped.
    fn shipped_alpha_v1() -> (String, test_override::Guard) {
        let text = canonical_skill_text("alpha", "an older body");
        let key = "templates/skills/codex/alpha/SKILL.md";
        let guard = test_override::inject(&test_override::json_for(
            key,
            &[crate::stable_digest::bytes(text.as_bytes())],
        ));
        (text, guard)
    }

    #[test]
    fn a_missing_folder_gives_empty_lists() {
        let fixture = Fixture::new("missing");
        let loads = fixture.loads(&[C, X, O, U]);
        assert_eq!(loads.harnesses.len(), 4);
        for harness in &loads.harnesses {
            assert!(harness.skills.is_empty(), "{:?}", harness.harness);
            assert!(!harness.folders.is_empty());
            assert!(
                harness.folders.iter().all(|folder| !folder.exists),
                "{:?}",
                harness.harness
            );
        }
        assert!(loads.foreign_duplicates.is_empty());
    }

    #[test]
    fn only_enabled_harnesses_are_reported_and_each_lists_the_folders_it_reads() {
        let fixture = Fixture::new("folders");
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[X, O]);
        assert_eq!(
            loads
                .harnesses
                .iter()
                .map(|h| h.harness)
                .collect::<Vec<_>>(),
            vec![X, O]
        );
        let paths = |harness| {
            of(&loads, harness)
                .folders
                .iter()
                .map(|folder| (folder.path.as_str(), folder.exists))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            paths(X),
            vec![("~/.agents/skills", false), ("~/.codex/skills", false)]
        );
        assert_eq!(
            paths(O),
            vec![
                ("~/.claude/skills", true),
                ("~/.agents/skills", false),
                ("~/.config/opencode/skills", false)
            ]
        );
    }

    #[test]
    fn one_current_copy_is_the_winner_with_a_short_hash_and_no_flags() {
        let fixture = Fixture::new("single");
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[C]);
        let alpha = skill(of(&loads, C), "alpha");
        assert_eq!(alpha.winner, Some(0));
        assert!(alpha.flags.is_empty());
        let copy = &alpha.copies[0];
        assert_eq!(copy.path, "~/.claude/skills/alpha");
        assert_eq!(copy.hash.len(), 12);
        assert!(copy.hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!((copy.owner, copy.current), (Owner::Aw, true));
    }

    #[test]
    fn codex_with_two_copies_cannot_resolve_a_plain_mention() {
        let fixture = Fixture::new("codex-two");
        fixture.skill(".agents/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(".codex/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[X]);
        let alpha = skill(of(&loads, X), "alpha");
        assert_eq!(alpha.copies.len(), 2);
        assert_eq!(alpha.winner, None);
        assert_eq!(alpha.flags, vec![SkillLoadFlag::PlainMentionAmbiguous]);
        // One copy is no problem.
        fs::remove_file(fixture.home.join(".codex/skills/alpha/SKILL.md")).unwrap();
        assert!(flags(&fixture.loads(&[X]), X, "alpha").is_empty());
    }

    #[test]
    fn opencode_with_different_copies_has_a_nondeterministic_winner() {
        let fixture = Fixture::new("opencode-differ");
        let (older, _guard) = shipped_alpha_v1();
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(".config/opencode/skills", "alpha", &older);
        let loads = fixture.loads(&[O]);
        let alpha = skill(of(&loads, O), "alpha");
        assert_eq!(alpha.flags, vec![SkillLoadFlag::WinnerNondeterministic]);
        // Both are the app's: one current, one an older shipped version.
        assert_eq!(
            alpha
                .copies
                .iter()
                .map(|copy| (copy.owner, copy.current))
                .collect::<Vec<_>>(),
            vec![(Owner::Aw, true), (Owner::Aw, false)]
        );
    }

    #[test]
    fn opencode_with_identical_copies_is_information_and_no_warning() {
        let fixture = Fixture::new("opencode-same");
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(".agents/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[O]);
        let alpha = skill(of(&loads, O), "alpha");
        assert_eq!(alpha.copies.len(), 2);
        assert_eq!(alpha.flags, vec![SkillLoadFlag::DuplicateIdentical]);
        assert!(loads.foreign_duplicates.is_empty());
    }

    #[test]
    fn cursor_with_two_copies_may_list_both() {
        let fixture = Fixture::new("cursor-two");
        fixture.skill(".cursor/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[U]);
        assert_eq!(
            flags(&loads, U, "alpha"),
            vec![SkillLoadFlag::PossibleDuplicate]
        );
        // Cursor also reads the literal ~/.codex/skills.
        fixture.skill(".codex/skills", "beta", &fixture.current("beta"));
        fixture.skill(".agents/skills", "beta", &fixture.current("beta"));
        let loads = fixture.loads(&[U]);
        assert_eq!(
            flags(&loads, U, "beta"),
            vec![SkillLoadFlag::PossibleDuplicate]
        );
    }

    #[test]
    fn claude_reads_one_folder_so_its_copy_is_never_flagged() {
        let fixture = Fixture::new("claude-one");
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        // Other harnesses' folders do not count for Claude.
        fixture.skill(".agents/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[C]);
        let alpha = skill(of(&loads, C), "alpha");
        assert_eq!(alpha.copies.len(), 1);
        assert!(alpha.flags.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_reached_through_a_link_counts_once() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new("link-once");
        fixture.skill(".agents/skills", "alpha", &fixture.current("alpha"));
        let codex = fixture.home.join(".codex/skills");
        fs::create_dir_all(&codex).unwrap();
        symlink(
            fixture.home.join(".agents/skills/alpha"),
            codex.join("alpha"),
        )
        .unwrap();
        let loads = fixture.loads(&[X]);
        let alpha = skill(of(&loads, X), "alpha");
        assert_eq!(alpha.copies.len(), 1, "{:?}", alpha.copies);
        assert!(alpha.flags.is_empty());
        assert_eq!(alpha.winner, Some(0));
        // The first folder Codex reads keeps the copy.
        assert_eq!(alpha.copies[0].folder, ReadFolder::Agents);
    }

    #[test]
    fn a_folder_two_harnesses_read_is_one_copy_for_each() {
        let fixture = Fixture::new("same-folder");
        fixture.skill(".codex/skills", "alpha", &fixture.current("alpha"));
        // CodexHome and DotCodex are one folder with the default CODEX_HOME; Cursor reads
        // only the second, Codex only the first, and neither sees a duplicate.
        let loads = fixture.loads(&[X, U]);
        assert!(flags(&loads, X, "alpha").is_empty());
        assert!(flags(&loads, U, "alpha").is_empty());
    }

    #[test]
    fn hidden_entries_and_codex_system_skills_are_ignored() {
        let fixture = Fixture::new("hidden");
        fixture.skill(".codex/skills/.system", "alpha", &fixture.current("alpha"));
        fixture.skill(".agents/skills", ".hidden", &fixture.current("beta"));
        let loads = fixture.loads(&[X, U]);
        assert!(of(&loads, X).skills.is_empty());
        assert!(of(&loads, U).skills.is_empty());
        // The folder itself exists: Codex wrote .system there.
        assert!(of(&loads, X).folders.iter().any(|folder| folder.exists));
    }

    #[test]
    fn only_skill_md_is_looked_at() {
        let fixture = Fixture::new("only-skill-md");
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        let other = fixture.home.join(".claude/skills/alpha/notes.md");
        fs::write(&other, "not a skill").unwrap();
        // A folder without SKILL.md and a plain file next to the skills are no skills.
        fs::create_dir_all(fixture.home.join(".claude/skills/empty")).unwrap();
        fs::write(fixture.home.join(".claude/skills/README.md"), "x").unwrap();
        let loads = fixture.loads(&[C]);
        assert_eq!(
            of(&loads, C)
                .skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha"]
        );
    }

    #[test]
    fn the_frontmatter_name_groups_copies_and_the_folder_name_is_the_fallback() {
        let fixture = Fixture::new("names");
        fixture.skill(
            ".agents/skills",
            "renamed",
            "---\nname: \"alpha\"\n---\nbody\n",
        );
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(".claude/skills", "no-name", "no frontmatter at all\n");
        let loads = fixture.loads(&[O]);
        assert_eq!(skill(of(&loads, O), "alpha").copies.len(), 2);
        assert_eq!(skill(of(&loads, O), "no-name").copies.len(), 1);
    }

    #[test]
    fn a_copy_the_user_made_is_foreign_and_listed_apart_from_the_app_flags() {
        let fixture = Fixture::new("foreign");
        // The user's own skill in two folders, and an edited copy of a bundled skill next to
        // the app's current one.
        fixture.skill(".agents/skills", "mine", "---\nname: mine\n---\nmine\n");
        fixture.skill(".codex/skills", "mine", "---\nname: mine\n---\nmine\n");
        fixture.skill(".agents/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(
            ".codex/skills",
            "alpha",
            "my edited alpha\n---\nname: alpha\n",
        );
        fixture.skill(".claude/skills", "beta", &fixture.current("beta"));
        fixture.skill(".agents/skills", "beta", &fixture.current("beta"));
        let loads = fixture.loads(&[X, C]);

        for name in ["mine", "alpha"] {
            assert_eq!(
                flags(&loads, X, name),
                vec![SkillLoadFlag::ForeignCopy],
                "{name}"
            );
        }
        assert!(skill(of(&loads, X), "mine")
            .copies
            .iter()
            .all(|copy| copy.owner == Owner::Foreign && !copy.current));
        // Claude reads neither folder with the foreign copies, so it is not affected.
        assert!(of(&loads, C).skills.iter().all(|s| s.name == "beta"));

        let names: Vec<_> = loads
            .foreign_duplicates
            .iter()
            .map(|dup| (dup.name.as_str(), dup.harnesses.clone(), dup.copies.len()))
            .collect();
        assert_eq!(names, vec![("alpha", vec![X], 2), ("mine", vec![X], 2)]);

        // beta is in a folder Claude reads and in one Codex reads: one copy each, no flag.
        assert!(flags(&loads, X, "beta").is_empty());
    }

    #[test]
    fn a_duplicate_of_a_foreign_copy_is_never_under_an_app_flag() {
        let fixture = Fixture::new("foreign-not-aw");
        fixture.skill(".claude/skills", "mine", "---\nname: mine\n---\nv1\n");
        fixture.skill(
            ".config/opencode/skills",
            "mine",
            "---\nname: mine\n---\nv2\n",
        );
        fixture.skill(".claude/skills", "alpha", &fixture.current("alpha"));
        fixture.skill(".agents/skills", "alpha", &fixture.current("alpha"));
        let loads = fixture.loads(&[O]);
        // Different contents, yet only a foreign flag: the winner is the user's to sort out.
        assert_eq!(flags(&loads, O, "mine"), vec![SkillLoadFlag::ForeignCopy]);
        assert_eq!(
            flags(&loads, O, "alpha"),
            vec![SkillLoadFlag::DuplicateIdentical]
        );
        assert_eq!(
            loads
                .foreign_duplicates
                .iter()
                .map(|dup| dup.name.as_str())
                .collect::<Vec<_>>(),
            vec!["mine"]
        );
    }

    #[test]
    fn ownership_follows_the_record_the_shipped_versions_and_the_bundle() {
        let fixture = Fixture::new("owner");
        // Recorded by the app after its last apply, though no shipped version.
        let recorded = canonical_skill_text("alpha", "recorded body");
        fixture.skill(".claude/skills", "alpha", &recorded);
        let record = ManagedArtifactRecord {
            identity: artifact_identity(&ArtifactId::skill_md(
                SkillRoot::Claude,
                SkillName::new("alpha").unwrap(),
            )),
            hash: crate::stable_digest::bytes(recorded.as_bytes()),
            surface: None,
        };
        // A shipped older version.
        let (older, _guard) = shipped_alpha_v1();
        fixture.skill(".agents/skills", "alpha", &older);
        // Edited since.
        fixture.skill(".config/opencode/skills", "alpha", "edited\n");
        // Not in the bundle at all.
        fixture.skill(
            ".config/opencode/skills",
            "gamma",
            &fixture.current("gamma"),
        );

        let loads = fixture.loads_with(&[O], &[record]);
        let owners: Vec<_> = skill(of(&loads, O), "alpha")
            .copies
            .iter()
            .map(|copy| (copy.folder, copy.owner, copy.current))
            .collect();
        assert_eq!(
            owners,
            vec![
                (ReadFolder::Claude, Owner::Aw, false),
                (ReadFolder::Agents, Owner::Aw, false),
                (ReadFolder::OpenCode, Owner::Foreign, false),
            ]
        );
        // Not a bundled skill: the user's, whatever its text says.
        assert_eq!(
            skill(of(&loads, O), "gamma").copies[0].owner,
            Owner::Foreign
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_linked_to_outside_the_home_folder_is_not_read() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new("root-link");
        let outside = temp("root-link-outside");
        fs::create_dir_all(outside.join("skills/alpha")).unwrap();
        fs::write(
            outside.join("skills/alpha/SKILL.md"),
            fixture.current("alpha"),
        )
        .unwrap();
        symlink(&outside, fixture.home.join(".claude")).unwrap();
        let loads = fixture.loads(&[C]);
        let folder = &of(&loads, C).folders[0];
        assert!(folder.exists);
        assert!(folder
            .note
            .as_deref()
            .is_some_and(|n| n.contains("outside your home")));
        assert!(of(&loads, C).skills.is_empty());
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_skill_linked_to_outside_the_home_folder_is_skipped_and_one_inside_is_read() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new("skill-link");
        let outside = temp("skill-link-outside");
        fs::write(outside.join("SKILL.md"), fixture.current("alpha")).unwrap();
        let dotfiles = fixture.home.join("dotfiles/beta");
        fs::create_dir_all(&dotfiles).unwrap();
        fs::write(dotfiles.join("SKILL.md"), fixture.current("beta")).unwrap();
        let claude = fixture.home.join(".claude/skills");
        fs::create_dir_all(&claude).unwrap();
        symlink(&outside, claude.join("alpha")).unwrap();
        symlink(&dotfiles, claude.join("beta")).unwrap();
        let loads = fixture.loads(&[C]);
        assert_eq!(
            of(&loads, C)
                .skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["beta"]
        );
        assert!(of(&loads, C).folders[0].note.is_some());
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn a_skill_md_over_the_cap_is_skipped_with_a_note() {
        let fixture = Fixture::new("cap");
        let big = "a".repeat(MAX_SKILL_MD_BYTES as usize + 1);
        fixture.skill(".claude/skills", "big", &big);
        let at_cap = format!(
            "---\nname: exact\n---\n{}",
            "a".repeat(MAX_SKILL_MD_BYTES as usize - "---\nname: exact\n---\n".len())
        );
        assert_eq!(at_cap.len() as u64, MAX_SKILL_MD_BYTES);
        fixture.skill(".claude/skills", "exact", &at_cap);
        let loads = fixture.loads(&[C]);
        let claude = of(&loads, C);
        assert_eq!(
            claude
                .skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["exact"]
        );
        assert!(claude.folders[0]
            .note
            .as_deref()
            .is_some_and(|n| n.starts_with("1 not read")));
    }

    #[test]
    fn a_folder_with_too_many_entries_is_cut_off_and_says_so() {
        let fixture = Fixture::new("many");
        let claude = fixture.home.join(".claude/skills");
        fs::create_dir_all(&claude).unwrap();
        for index in 0..MAX_ENTRIES_PER_FOLDER + 3 {
            fs::create_dir_all(claude.join(format!("s{index:04}"))).unwrap();
        }
        let loads = fixture.loads(&[C]);
        let note = of(&loads, C).folders[0].note.clone().unwrap_or_default();
        assert!(note.starts_with("3 not read"), "{note}");
    }

    #[test]
    fn a_folder_stops_being_read_after_its_byte_budget() {
        let fixture = Fixture::new("budget");
        let filler = |name: &str| {
            let head = format!("---\nname: {name}\n---\n");
            format!(
                "{head}{}",
                "a".repeat(MAX_SKILL_MD_BYTES as usize - head.len())
            )
        };
        let count = (MAX_BYTES_PER_FOLDER / MAX_SKILL_MD_BYTES) as usize;
        for index in 0..count + 2 {
            let name = format!("s{index:02}");
            fixture.skill(".claude/skills", &name, &filler(&name));
        }
        let loads = fixture.loads(&[C]);
        let claude = of(&loads, C);
        assert_eq!(
            claude.skills.len(),
            count,
            "the files up to the budget are read"
        );
        assert!(claude
            .skills
            .iter()
            .all(|skill| skill.name.as_str() < "s32"));
        let note = claude.folders[0].note.clone().unwrap_or_default();
        assert!(note.starts_with("2 not read"), "{note}");
    }

    #[test]
    fn a_folder_configured_outside_the_home_folder_is_read() {
        let fixture = Fixture::new("outside-home");
        let elsewhere = temp("outside-home-codex");
        fs::create_dir_all(elsewhere.join("alpha")).unwrap();
        fs::write(elsewhere.join("alpha/SKILL.md"), fixture.current("alpha")).unwrap();
        let mut folders = FolderPaths::under(&fixture.home);
        folders.0.insert(ReadFolder::CodexHome, elsewhere.clone());
        let proof = OwnershipProof::new(&fixture.bundle, &[]).unwrap();
        let loads = effective_skill_loads(&fixture.home, &[X], &folders, &proof);
        let codex = of(&loads, X);
        let alpha = skill(codex, "alpha");
        assert!(alpha.copies[0]
            .path
            .starts_with(&elsewhere.to_string_lossy().replace('\\', "/")));
        assert_eq!(alpha.copies[0].owner, Owner::Aw);
        let _ = fs::remove_dir_all(elsewhere);
    }

    #[test]
    fn names_from_files_are_bounded_and_control_free() {
        assert_eq!(clean_name("a\u{1b}b"), "a?b");
        assert_eq!(clean_name(&"x".repeat(500)).chars().count(), MAX_NAME_CHARS);
        assert_eq!(
            frontmatter_name("---\nname: 'tdd'\n---\n"),
            Some("tdd".into())
        );
        assert_eq!(
            frontmatter_name("---\ndescription: x\n---\nname: late\n"),
            None
        );
        assert_eq!(frontmatter_name("name: early\n"), None);
        assert_eq!(frontmatter_name("---\nname:\n---\n"), None);
    }

    #[test]
    fn the_wire_format_names_flags_owners_and_folders_in_snake_case() {
        let copy = SkillCopy {
            folder: ReadFolder::DotCodex,
            path: "~/.codex/skills/x".into(),
            hash: "abc".into(),
            owner: Owner::Foreign,
            current: false,
        };
        let json = serde_json::to_value(&copy).unwrap();
        assert_eq!(json["folder"], "dot_codex");
        assert_eq!(json["owner"], "foreign");
        assert_eq!(
            serde_json::to_value(SkillLoadFlag::PlainMentionAmbiguous).unwrap(),
            "plain_mention_ambiguous"
        );
        assert_eq!(
            serde_json::to_value(ReadFolder::OpenCode).unwrap(),
            "open_code"
        );
        assert_eq!(
            serde_json::to_value(HarnessId::OpenCode).unwrap(),
            "opencode"
        );
    }
}
