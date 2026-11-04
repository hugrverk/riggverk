//! Skill import: a skill found elsewhere becomes a skill of the app-owned pack `imported`.
//!
//! [`preview_skill_import`] copies what the user dropped or pasted (a skill folder, a loose
//! `SKILL.md`, or a folder that holds several skills) into a private staging folder without
//! following a link, validates the copy, and returns what it holds with a one-time token.
//! [`commit_skill_import`] checks that the staged copy is still the previewed one and publishes it,
//! unchanged, into `<data>/packs/imported/skills/<name>/` (temp folder + `rename`), recording where
//! it came from in `packs/imported/.riggverk-imports.json`. Replacing or removing an import backs
//! the old copy up first (`backups/imports/<name>-<ts>/`); [`undo_last_import`] puts it back.
//!
//! Nothing of a skill is ever run, and nothing is written to an agent's folders: the next Update
//! installs the pack like any other, after its own review.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::workspace::workspace_target_for_write;
use crate::artifact_registry::{SkillName, SkillRelPath};
use crate::setup_transaction::PreviewPurpose;
use crate::skill_discovery::{
    MAX_SKILL_MD_BYTES, MAX_SUPPORT_DEPTH, MAX_SUPPORT_FILES, MAX_SUPPORT_FILE_BYTES,
    MAX_SUPPORT_TOTAL_BYTES,
};
use crate::skill_sources::{SkillSources, SourceRoot, IMPORTED_PACK};

/// Where an import came from and what it holds, beside the pack's skills (a dot file: never read
/// as a skill).
const RECORD_FILE: &str = ".riggverk-imports.json";
const RECORD_SCHEMA: u32 = 1;
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;
/// Events kept in the record; the oldest go first.
const MAX_EVENTS: usize = 200;
/// Below the state folder; one folder per preview, named by its token.
const STAGING_DIR: &str = "import-staging";
const MANIFEST_FILE: &str = "candidates.json";
const MAX_SOURCE_PATHS: usize = 16;
const MAX_CANDIDATES: usize = 64;
/// Entries one skill folder may hold before it is read as something else (checked before copying).
const MAX_SKILL_ENTRIES: usize = 256;
/// Entries looked at while searching a folder for skills.
const MAX_FOLDER_ENTRIES: usize = 2_000;
/// A changed file's text is sent for the diff up to this size; a bigger one is only named.
const MAX_DIFF_TEXT_BYTES: usize = 256 * 1024;
/// Line numbers a flag or refusal lists before it says how many more there are.
const MAX_LISTED_LINES: usize = 20;

// ── What the webview gets ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// A folder with a `SKILL.md`.
    Folder,
    /// A `SKILL.md` on its own; the skill's folder is named after its `name`.
    File,
    /// A skill found in a folder of skills (`<name>/` or `skills/<name>/`).
    Collection,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportFile {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) executable: bool,
    pub(crate) binary: bool,
    /// Why the file cannot be installed; `None` when it can.
    pub(crate) problem: Option<String>,
}

/// Something the user should see before importing; shown, never refused.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportFlag {
    /// `key` (a frontmatter key the harness acts on by itself), `shell` (`!` commands),
    /// `openai` (`agents/openai.yaml`), `executable`, `binary` or `unicode`.
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportFileChange {
    pub(crate) path: String,
    /// `added`, `removed` or `changed`.
    pub(crate) change: String,
    /// The texts, for the diff; `None` for a binary file or one too big to show.
    pub(crate) before: Option<String>,
    pub(crate) after: Option<String>,
    /// The execute bit before and after; `None` for the side where the file does not exist.
    pub(crate) executable_before: Option<bool>,
    pub(crate) executable_after: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportCandidate {
    /// Picks the candidate in [`commit_skill_import`].
    pub(crate) key: String,
    pub(crate) kind: SourceKind,
    /// Where it is, as `~/...`.
    pub(crate) source: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) license: String,
    pub(crate) compatibility: String,
    /// `SKILL.md` first, then the supporting files.
    pub(crate) files: Vec<ImportFile>,
    /// Dot entries, which are never copied.
    pub(crate) omitted: Vec<String>,
    pub(crate) flags: Vec<ImportFlag>,
    /// Why it cannot be imported; empty when it can.
    pub(crate) problems: Vec<String>,
    /// The `SKILL.md` as it is, for the preview; empty when it was not copied.
    pub(crate) skill_md: String,
    pub(crate) digest: String,
    /// `new`, `update` (an import of this name exists), `unchanged` (it holds the same files) or
    /// `refused`.
    pub(crate) status: String,
    /// `bundled` when a bundled skill has the name: it can be imported only under another name.
    pub(crate) collision: Option<String>,
    /// For an update: the files that differ from the import in place.
    pub(crate) changes: Vec<ImportFileChange>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillImportPreview {
    /// One-time proof for [`commit_skill_import`]; `None` when nothing can be imported.
    pub(crate) token: Option<String>,
    pub(crate) candidates: Vec<ImportCandidate>,
    /// Sources that yielded no skill, with the reason.
    pub(crate) problems: Vec<String>,
    /// Where imports go, as `~/...`.
    pub(crate) folder: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillImportResult {
    pub(crate) imported: Vec<String>,
    pub(crate) updated: Vec<String>,
}

/// Where an imported skill came from, for the Library.
#[derive(Debug, Clone, Serialize)]
pub struct ImportProvenance {
    pub(crate) source: String,
    pub(crate) kind: SourceKind,
    /// Unix seconds.
    pub(crate) imported_at: u64,
    pub(crate) digest: String,
}

/// What [`undo_last_import`] would undo.
#[derive(Debug, Clone, Serialize)]
pub struct UndoImport {
    pub(crate) action: EventAction,
    pub(crate) name: String,
}

// ── The record ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ImportRecord {
    source: String,
    kind: SourceKind,
    imported_at: u64,
    tree_digest: String,
    /// Path to `sha256:<hex>`.
    files: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    renamed_from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventAction {
    Import,
    Replace,
    Remove,
    Undo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImportEvent {
    action: EventAction,
    name: String,
    at: u64,
    /// The backup folder (below `backups/imports/`) of the copy this event moved away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup: Option<String>,
    /// The record of the copy this event moved away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<ImportRecord>,
    /// The `routing.md` lines this event took out, as written: every line naming the skill for a
    /// removal or an undone import, the skill's own line(s) for a replacement that set its routing,
    /// so undoing it can put them back. Older records have none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    routing: Vec<String>,
    /// A replacement that set the skill's routing line, so undoing it puts back `routing`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    routing_set: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecordDocument {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    skills: BTreeMap<String, ImportRecord>,
    #[serde(default)]
    events: Vec<ImportEvent>,
}

/// One staged candidate, as the preview left it for the commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StagedCandidate {
    key: String,
    name: String,
    kind: SourceKind,
    source: String,
    digest: String,
    /// Digest of the import of this name the preview compared against; `None` for a new one.
    existing: Option<String>,
}

// ── Small helpers ──

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn nonce() -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock error".to_string())?
        .as_nanos();
    Ok(format!("{}-{nanos}", std::process::id()))
}

/// The Agent Skills spec's name rule (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64), which every name the
/// app keeps for a skill also passes.
pub(crate) fn valid_spec_skill_name(name: &str) -> bool {
    name.len() <= 64
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
        && SkillName::new(name).is_some()
        && crate::skill_sources::valid_pack_name(name)
}

/// `open(2)` flags: never follow a link in the last component, never block (a pipe would). They come
/// from libc because the values differ per platform: `O_NOFOLLOW` is `0o400000` on Linux x86_64 but
/// `0o100000` on Linux aarch64, where `0o400000` is `O_LARGEFILE`.
#[cfg(unix)]
const OPEN_FLAGS: i32 = libc::O_NOFOLLOW | libc::O_NONBLOCK;

/// Opens `path` for reading without following a link at it and without blocking, and returns the
/// handle with the metadata of what was opened (`fstat`): only a regular file with one link passes,
/// so what is read is what the metadata describes.
fn open_regular(path: &Path) -> Result<(fs::File, fs::Metadata), String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(OPEN_FLAGS);
    }
    let handle = options.open(path).map_err(|_| "cannot open".to_string())?;
    let meta = handle
        .metadata()
        .map_err(|_| "cannot inspect".to_string())?;
    if !meta.is_file() || link_count(&meta) != 1 {
        return Err("not a regular file".to_string());
    }
    Ok((handle, meta))
}

fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    open_regular(path)
        .map_err(|_| "a file of the skill is not a regular file".to_string())?
        .0
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read a file of the skill".to_string())?;
    if bytes.len() as u64 > cap {
        return Err("a file of the skill is over its size limit".to_string());
    }
    Ok(bytes)
}

/// The files of a skill folder and which of them carry an execute bit.
struct SkillTree {
    files: BTreeMap<String, Vec<u8>>,
    executables: BTreeSet<String>,
}

/// The files of a skill folder the app wrote (staging or the imported pack), by path.
fn tree_files(dir: &Path) -> Result<SkillTree, String> {
    crate::path_safety::reject_symlink(dir, "skill folder")?;
    let mut files = BTreeMap::new();
    files.insert(
        "SKILL.md".to_string(),
        read_capped(&dir.join("SKILL.md"), MAX_SKILL_MD_BYTES)?,
    );
    for rel in crate::skill_discovery::skill_support_files(dir)? {
        let bytes = read_capped(&dir.join(&rel), MAX_SUPPORT_FILE_BYTES)?;
        files.insert(rel, bytes);
    }
    let mut executables = BTreeSet::new();
    for rel in files.keys() {
        let (_, metadata) = open_regular(&dir.join(rel))?;
        if executable_bit(&metadata) {
            executables.insert(rel.clone());
        }
    }
    Ok(SkillTree { files, executables })
}

fn file_digests(files: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    files
        .iter()
        .map(|(rel, bytes)| (rel.clone(), crate::stable_digest::bytes(bytes)))
        .collect()
}

fn tree_digest(tree: &SkillTree) -> String {
    let mut listing: String = file_digests(&tree.files)
        .iter()
        .map(|(rel, digest)| format!("{rel}\0{digest}\n"))
        .collect();
    for rel in &tree.executables {
        listing.push_str(&format!("exec\0{rel}\n"));
    }
    crate::stable_digest::bytes(listing.as_bytes())
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn line_list(lines: &BTreeSet<usize>) -> String {
    let shown: Vec<String> = lines
        .iter()
        .take(MAX_LISTED_LINES)
        .map(usize::to_string)
        .collect();
    let more = lines.len().saturating_sub(MAX_LISTED_LINES);
    let mut text = shown.join(", ");
    if more > 0 {
        text.push_str(&format!(" and {more} more"));
    }
    text
}

fn plural(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

// ── Finding the skills of a source ──

/// A skill the source holds, before it is read.
struct Found {
    kind: SourceKind,
    /// The skill folder, or the loose `SKILL.md`.
    path: PathBuf,
}

fn is_file_named_skill_md(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join("SKILL.md")).is_ok()
}

/// The skills below `path`: the folder itself, a loose `SKILL.md`, or (for a folder without one)
/// `<name>/SKILL.md` and `skills/<name>/SKILL.md`, no deeper. `Err` says why there is none.
fn find_skills(path: &Path, shown: &str) -> Result<Vec<Found>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| format!("{shown}: cannot be read"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{shown}: is a link; links are not followed"));
    }
    if meta.is_file() {
        if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
            return Err(format!(
                "{shown}: only a skill folder, a SKILL.md or a folder of skills can be imported"
            ));
        }
        return Ok(vec![Found {
            kind: SourceKind::File,
            path: path.to_path_buf(),
        }]);
    }
    if !meta.is_dir() {
        return Err(format!("{shown}: is not a file or a folder"));
    }
    if is_file_named_skill_md(path) {
        return Ok(vec![Found {
            kind: SourceKind::Folder,
            path: path.to_path_buf(),
        }]);
    }
    let mut seen = 0usize;
    let mut found = Vec::new();
    for (name, sub) in child_dirs(path, &mut seen, shown)? {
        if is_file_named_skill_md(&sub) {
            found.push(Found {
                kind: SourceKind::Collection,
                path: sub,
            });
        } else if name == "skills" {
            for (_, skill) in child_dirs(&sub, &mut seen, shown)? {
                if is_file_named_skill_md(&skill) {
                    found.push(Found {
                        kind: SourceKind::Collection,
                        path: skill,
                    });
                }
            }
        }
    }
    if found.is_empty() {
        return Err(format!(
            "{shown}: no SKILL.md in it, in a folder in it, or in skills/<name>/"
        ));
    }
    Ok(found)
}

/// The folders directly in `dir`, sorted; dot entries and links are skipped (never followed).
fn child_dirs(dir: &Path, seen: &mut usize, shown: &str) -> Result<Vec<(String, PathBuf)>, String> {
    let entries = fs::read_dir(dir).map_err(|_| format!("{shown}: cannot be read"))?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        *seen += 1;
        if *seen > MAX_FOLDER_ENTRIES {
            return Err(format!(
                "{shown}: holds more than {MAX_FOLDER_ENTRIES} entries to look through"
            ));
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            dirs.push((name, entry.path()));
        }
    }
    dirs.sort();
    Ok(dirs)
}

// ── Reading one skill of the source ──

struct SourceFile {
    rel: String,
    path: PathBuf,
    size: u64,
    executable: bool,
    identity: (u64, u64),
}

#[derive(Default)]
struct Scan {
    files: Vec<SourceFile>,
    omitted: Vec<String>,
    problems: Vec<String>,
    unrepresentable: BTreeSet<String>,
    entries: usize,
}

#[cfg(unix)]
fn identity(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn identity(_meta: &fs::Metadata) -> (u64, u64) {
    (0, 0)
}

#[cfg(unix)]
fn link_count(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.nlink()
}

#[cfg(not(unix))]
fn link_count(_meta: &fs::Metadata) -> u64 {
    1
}

#[cfg(unix)]
fn executable_bit(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable_bit(_meta: &fs::Metadata) -> bool {
    false
}

/// Looks at one skill of the source with `lstat` only and checks every limit before anything is
/// copied: links, hard links, special files, nested `SKILL.md`, depth, counts, sizes and names.
fn scan_skill(found: &Found) -> Scan {
    let mut scan = Scan::default();
    match found.kind {
        SourceKind::File => match fs::symlink_metadata(&found.path) {
            Ok(meta) if meta.is_file() => add_file(&mut scan, "SKILL.md", &found.path, &meta),
            _ => scan.problems.push("SKILL.md cannot be read".to_string()),
        },
        SourceKind::Folder | SourceKind::Collection => scan_dir(&found.path, "", 1, &mut scan),
    }
    if !scan.files.iter().any(|file| file.rel == "SKILL.md") && scan.problems.is_empty() {
        scan.problems
            .push("SKILL.md is not a regular file in the skill folder".to_string());
    }
    let support: Vec<&SourceFile> = scan.files.iter().filter(|f| f.rel != "SKILL.md").collect();
    let total: u64 = support.iter().map(|file| file.size).sum();
    if support.len() > MAX_SUPPORT_FILES || total > MAX_SUPPORT_TOTAL_BYTES {
        scan.problems.push(format!(
            "more than {MAX_SUPPORT_FILES} supporting files or 2 MiB of them ({}, {total} bytes)",
            plural(support.len(), "file")
        ));
    }
    let mut folded = BTreeSet::new();
    for file in &support {
        if !folded.insert(file.rel.to_ascii_lowercase()) {
            scan.problems.push(format!(
                "{}: another file has this name in other letter case; both cannot be installed",
                file.rel
            ));
        }
    }
    scan
}

fn scan_dir(dir: &Path, prefix: &str, level: usize, scan: &mut Scan) {
    let shown = if prefix.is_empty() {
        "the skill folder"
    } else {
        prefix
    };
    let Ok(entries) = fs::read_dir(dir) else {
        scan.problems.push(format!("{shown}: cannot be read"));
        return;
    };
    // Every entry counts, dot entries and unreadable names too, and no more are read than the cap.
    let room = (MAX_SKILL_ENTRIES + 1).saturating_sub(scan.entries);
    let mut entries: Vec<fs::DirEntry> = entries.flatten().take(room).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        scan.entries += 1;
        if scan.entries > MAX_SKILL_ENTRIES {
            scan.problems.push(format!(
                "more than {MAX_SKILL_ENTRIES} files and folders in the skill"
            ));
            return;
        }
        let Ok(name) = entry.file_name().into_string() else {
            scan.problems
                .push(format!("{shown}: holds a file name that is not UTF-8"));
            return;
        };
        let rel = format!("{prefix}{name}");
        if name.starts_with('.') {
            scan.omitted.push(rel);
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            scan.problems.push(format!("{rel}: cannot be read"));
            continue;
        };
        let kind = meta.file_type();
        if kind.is_symlink() {
            scan.problems
                .push(format!("{rel}: is a link; links are not followed"));
        } else if kind.is_dir() {
            if level >= MAX_SUPPORT_DEPTH {
                scan.problems.push(format!(
                    "{rel}/: nested deeper than {MAX_SUPPORT_DEPTH} levels"
                ));
            } else {
                scan_dir(&entry.path(), &format!("{rel}/"), level + 1, scan);
            }
        } else if kind.is_file() {
            add_file(scan, &rel, &entry.path(), &meta);
        } else {
            scan.problems.push(format!(
                "{rel}: is not a regular file (a device, socket or pipe)"
            ));
        }
    }
}

fn add_file(scan: &mut Scan, rel: &str, path: &Path, meta: &fs::Metadata) {
    if link_count(meta) > 1 {
        scan.problems.push(format!(
            "{rel}: is a hard link; it shares its bytes with another file"
        ));
        return;
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if rel == "SKILL.md" {
        if meta.len() > MAX_SKILL_MD_BYTES {
            scan.problems.push("SKILL.md is over 1 MiB".to_string());
            return;
        }
    } else {
        if name.eq_ignore_ascii_case("SKILL.md") {
            scan.problems
                .push(format!("{rel}: a second SKILL.md inside the skill"));
            return;
        }
        if meta.len() > MAX_SUPPORT_FILE_BYTES {
            scan.problems.push(format!("{rel}: over 1 MiB"));
        }
        if SkillRelPath::new(rel).is_none() {
            scan.unrepresentable.insert(rel.to_string());
            scan.problems.push(format!(
                "{rel}: a name the installer cannot use (ASCII letters, digits, dot, dash and underscore)"
            ));
        }
    }
    scan.files.push(SourceFile {
        rel: rel.to_string(),
        path: path.to_path_buf(),
        size: meta.len(),
        executable: executable_bit(meta),
        identity: identity(meta),
    });
}

/// The bytes of a source file, refused when it is no longer the file that was scanned (replaced by
/// a link or another file, or grown) between the scan and the copy.
fn read_source(file: &SourceFile) -> Result<Vec<u8>, String> {
    let changed = || format!("{}: changed while it was read; import again", file.rel);
    // A link, a pipe or another file swapped in since the scan is refused on the opened handle.
    let (handle, meta) = open_regular(&file.path).map_err(|_| changed())?;
    if identity(&meta) != file.identity || executable_bit(&meta) != file.executable {
        return Err(changed());
    }
    let mut bytes = Vec::new();
    handle
        .take(file.size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("{}: cannot be read", file.rel))?;
    if bytes.len() as u64 != file.size {
        return Err(changed());
    }
    Ok(bytes)
}

// ── Checking the copy ──

/// Hidden characters of a `SKILL.md`: `Err` for tag characters and bidi overrides or isolates,
/// which can hide or reorder instructions; otherwise the flag for the other characters a routing
/// line refuses as invisible (format characters, variation selectors and the like), if any. A text
/// or emoji presentation selector (U+FE0E, U+FE0F) right after a visible non-ASCII character, as in
/// "⚠️", only picks how that character looks and is not counted.
fn hidden_unicode(text: &str) -> Result<Option<ImportFlag>, String> {
    let invisible = crate::pack_routing::is_invisible_in_routing;
    let mut refused = BTreeSet::new();
    let mut flagged = BTreeSet::new();
    let mut count = 0usize;
    for (index, line) in text.lines().enumerate() {
        let mut previous: Option<char> = None;
        for c in line.chars() {
            let code = u32::from(c);
            let presentation = matches!(c, '\u{FE0E}' | '\u{FE0F}')
                && previous.is_some_and(|p| {
                    !p.is_ascii() && !p.is_whitespace() && !p.is_control() && !invisible(p)
                });
            if (0xE0000..=0xE007F).contains(&code)
                || (0x202A..=0x202E).contains(&code)
                || (0x2066..=0x2069).contains(&code)
            {
                refused.insert(index + 1);
            } else if invisible(c) && !presentation {
                flagged.insert(index + 1);
                count += 1;
            }
            previous = Some(c);
        }
    }
    if !refused.is_empty() {
        return Err(format!(
            "SKILL.md holds hidden Unicode tag or bidi override characters, which can hide or \
             reorder text (lines {})",
            line_list(&refused)
        ));
    }
    Ok((count > 0).then(|| ImportFlag {
        kind: "unicode".to_string(),
        label: "hidden Unicode".to_string(),
        detail: format!(
            "{} (zero-width, soft hyphen, variation selector and the like) on lines {}",
            plural(count, "invisible character"),
            line_list(&flagged)
        ),
    }))
}

/// What the staged copy of a skill is: its name and frontmatter, flags and problems.
struct Inspected {
    name: String,
    description: String,
    license: String,
    compatibility: String,
    flags: Vec<ImportFlag>,
    problems: Vec<String>,
    skill_md: String,
}

fn inspect(
    files: &BTreeMap<String, Vec<u8>>,
    executables: &BTreeSet<String>,
    folder: Option<&str>,
) -> Inspected {
    let mut out = Inspected {
        name: String::new(),
        description: String::new(),
        license: String::new(),
        compatibility: String::new(),
        flags: Vec::new(),
        problems: Vec::new(),
        skill_md: String::new(),
    };
    let Some(text) = files
        .get("SKILL.md")
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
    else {
        out.problems.push("SKILL.md is not UTF-8 text".to_string());
        return out;
    };
    out.skill_md = text.to_string();
    match hidden_unicode(text) {
        Err(problem) => out.problems.push(problem),
        Ok(Some(flag)) => out.flags.push(flag),
        Ok(None) => {}
    }
    match crate::skill_discovery::skill_fields(text) {
        Err(error) => out
            .problems
            .push(format!("the frontmatter cannot be read: {error}")),
        Ok(fields) => {
            let field = |key: &str| fields.get(key).cloned().unwrap_or_default();
            out.name = field("name");
            out.description = field("description");
            out.license = field("license");
            out.compatibility = field("compatibility");
            if out.name.is_empty() {
                out.problems.push("the frontmatter has no name".to_string());
            } else if !valid_spec_skill_name(&out.name) {
                out.problems.push(format!(
                    "the name {:?} does not follow the Agent Skills rule: 1–64 lowercase letters, \
                     digits and single dashes, no dash first or last",
                    out.name
                ));
            } else if let Some(folder) = folder.filter(|folder| *folder != out.name) {
                out.problems.push(format!(
                    "the folder is named {folder} but the skill {}; the Agent Skills spec needs \
                     them equal, so rename the folder",
                    out.name
                ));
            }
            if out.description.is_empty() {
                out.problems
                    .push("the frontmatter has no description".to_string());
            }
            let targets = field("targets");
            let unknown: Vec<&str> = targets
                .trim_matches(|c| c == '[' || c == ']')
                .split(',')
                .map(|t| t.trim().trim_matches(|c| c == '"' || c == '\''))
                .filter(|t| {
                    !t.is_empty() && !crate::agent_skill_targets::VALID_SKILL_AGENTS.contains(t)
                })
                .collect();
            if !unknown.is_empty() {
                out.problems.push(format!(
                    "targets names harnesses the app does not know: {}",
                    unknown.join(", ")
                ));
            }
        }
    }
    for key in crate::skill_discovery::privileged_keys(text) {
        let shell = key.key == crate::skill_discovery::SHELL_COMMAND_KEY;
        out.flags.push(ImportFlag {
            kind: if shell { "shell" } else { "key" }.to_string(),
            label: if shell {
                "! commands".to_string()
            } else {
                key.key.clone()
            },
            detail: if key.note.is_empty() {
                key.value
            } else {
                format!("{} · {}", key.value, key.note)
            },
        });
    }
    if files.contains_key("agents/openai.yaml") {
        out.flags.push(ImportFlag {
            kind: "openai".to_string(),
            label: "agents/openai.yaml".to_string(),
            detail: "sets when Codex calls the skill by itself and the tools it depends on"
                .to_string(),
        });
    }
    let runnable: Vec<&str> = files
        .iter()
        .filter(|(rel, bytes)| {
            executables.contains(*rel) || rel.starts_with("scripts/") || bytes.starts_with(b"#!")
        })
        .map(|(rel, _)| rel.as_str())
        .collect();
    if !runnable.is_empty() {
        out.flags.push(ImportFlag {
            kind: "executable".to_string(),
            label: "scripts and executables".to_string(),
            detail: format!(
                "{}; an agent may run them. The app never does. The executable bit is kept: \
                 owner-only (0700) in the pack, executable when installed into agent skill folders",
                runnable.join(", ")
            ),
        });
    }
    let binaries: Vec<&str> = files
        .iter()
        .filter(|(rel, bytes)| *rel != "SKILL.md" && is_binary(bytes))
        .map(|(rel, _)| rel.as_str())
        .collect();
    if !binaries.is_empty() {
        out.flags.push(ImportFlag {
            kind: "binary".to_string(),
            label: "binary files".to_string(),
            detail: format!("{}; their content is not shown", binaries.join(", ")),
        });
    }
    out
}

fn text_for_diff(bytes: Option<&Vec<u8>>) -> Option<String> {
    let bytes = bytes?;
    if bytes.len() > MAX_DIFF_TEXT_BYTES || is_binary(bytes) {
        return None;
    }
    String::from_utf8(bytes.clone()).ok()
}

fn changes(before: &SkillTree, after: &SkillTree) -> Vec<ImportFileChange> {
    let paths: BTreeSet<&String> = before.files.keys().chain(after.files.keys()).collect();
    let mut out = Vec::new();
    for path in paths {
        let (old, new) = (before.files.get(path), after.files.get(path));
        let change = match (old, new) {
            (None, Some(_)) => "added",
            (Some(_), None) => "removed",
            (Some(a), Some(b))
                if a != b
                    || before.executables.contains(path) != after.executables.contains(path) =>
            {
                "changed"
            }
            _ => continue,
        };
        out.push(ImportFileChange {
            path: path.clone(),
            change: change.to_string(),
            before: text_for_diff(old),
            after: text_for_diff(new),
            executable_before: old.map(|_| before.executables.contains(path)),
            executable_after: new.map(|_| after.executables.contains(path)),
        });
    }
    out
}

// ── Renaming ──

/// `text` with its one top-level `name:` frontmatter line replaced by `name: <name>` (line ending
/// kept) and nothing else changed: what an import under another name writes. The dialog computes
/// the same text (`renamedSkillMd` in `skillImport.ts`) and shows it before Import. `Err` when there
/// is no such line to rewrite. The result is checked: one line differs, and the frontmatter reads
/// the same but for the name.
pub(crate) fn renamed_skill_md(text: &str, name: &str) -> Result<String, String> {
    let no_line = || "SKILL.md has no plain name: line to rewrite".to_string();
    let mut lines = text.split_inclusive('\n');
    let opening = lines.next().ok_or_else(no_line)?;
    if opening.trim_end() != "---" {
        return Err(no_line());
    }
    let mut out = opening.to_string();
    let mut done = false;
    for line in lines {
        let bare = line.trim_end_matches(['\r', '\n']);
        if !done && bare.trim_end() == "---" {
            return Err(no_line());
        }
        if !done && bare.starts_with("name:") {
            out.push_str(&format!("name: {name}"));
            out.push_str(&line[bare.len()..]);
            done = true;
        } else {
            out.push_str(line);
        }
    }
    if !done {
        return Err(no_line());
    }
    let changed = text
        .split_inclusive('\n')
        .zip(out.split_inclusive('\n'))
        .filter(|(a, b)| a != b)
        .count();
    let mut before = crate::skill_discovery::skill_fields(text).map_err(|_| no_line())?;
    let mut after = crate::skill_discovery::skill_fields(&out).map_err(|_| no_line())?;
    let renamed = after.remove("name");
    before.remove("name");
    if changed > 1
        || text.split_inclusive('\n').count() != out.split_inclusive('\n').count()
        || renamed.as_deref() != Some(name)
        || before != after
    {
        return Err("SKILL.md cannot be renamed by its name: line alone".to_string());
    }
    Ok(out)
}

// ── Packs and folders ──

fn imported_pack_dir(root: &Path) -> PathBuf {
    crate::skill_sources::packs_dir(root).join(IMPORTED_PACK)
}

fn imported_skills_dir(root: &Path) -> PathBuf {
    imported_pack_dir(root).join("skills")
}

fn staging_root(root: &Path) -> PathBuf {
    crate::workspace_layout::state_dir(root).join(STAGING_DIR)
}

/// The import of `name` in place, if any: its files.
fn existing_import(root: &Path, name: &str) -> Result<Option<SkillTree>, String> {
    let dir = imported_skills_dir(root).join(name);
    match fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => tree_files(&dir)
            .map(Some)
            .map_err(|_| format!("the imported skill {name} in place cannot be read")),
        _ => Err(format!("the imported skill {name} in place cannot be read")),
    }
}

/// Bundled skill names, and the skill names of every pack but `imported` (held ones too). `Err`
/// while a pack is refused or ignored: it may claim any name.
struct Names {
    bundled: BTreeSet<String>,
    other_packs: BTreeMap<String, String>,
}

fn taken_names(sources: &SkillSources) -> Result<Names, String> {
    let catalog = sources
        .catalog()
        .map_err(|_| "the bundled skills cannot be read".to_string())?;
    if sources.packs().iter().any(|pack| pack.refused.is_some())
        || sources
            .ignored()
            .iter()
            .any(|(name, _)| crate::skill_sources::valid_pack_name(name) || name == "packs")
    {
        return Err(
            "a pack is refused or ignored, so names cannot be checked; fix it in the Packs view first"
                .to_string(),
        );
    }
    let bundled = catalog
        .iter()
        .filter(|entry| entry.pack.is_none())
        .map(|entry| entry.skill.name.clone())
        .collect();
    let mut other_packs = BTreeMap::new();
    for pack in sources
        .packs()
        .iter()
        .filter(|pack| pack.name != IMPORTED_PACK)
    {
        for skill in &pack.skills {
            other_packs.insert(skill.name.clone(), pack.name.clone());
            other_packs.insert(skill.folder.clone(), pack.name.clone());
        }
    }
    for held in sources
        .held()
        .iter()
        .filter(|held| held.pack != IMPORTED_PACK)
    {
        let pack = if held.pack.is_empty() {
            "unknown"
        } else {
            &held.pack
        };
        other_packs.insert(held.name.clone(), pack.to_string());
    }
    Ok(Names {
        bundled,
        other_packs,
    })
}

fn name_problem(names: &Names, name: &str) -> Option<String> {
    names.other_packs.get(name).map(|pack| {
        format!("pack:{pack} already has a skill named {name}; remove or rename it there first")
    })
}

fn sources_for(root: &Path) -> Result<SkillSources, String> {
    SkillSources::for_workspace(root).map_err(|_| "skill sources are unavailable".to_string())
}

// ── Preview ──

/// The source root the user chose, resolved once: links in the folders above it are followed (as the
/// user named them; macOS's `/tmp` is one), a link at the root itself or anywhere below it is not.
fn resolve_root(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| "not a file or a folder".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "not a file or a folder".to_string())?
        .canonicalize()
        .map_err(|_| "cannot be read".to_string())?;
    Ok(parent.join(name))
}

/// A path as typed or dropped: absolute, or `~/...`.
fn source_path(raw: &str, home: &Path) -> Result<PathBuf, String> {
    let raw = raw.trim();
    let path = match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if raw == "~" => home.to_path_buf(),
        None => PathBuf::from(raw),
    };
    if raw.is_empty() || raw.contains('\0') || !path.is_absolute() {
        return Err("give a full path (starting with / or ~/)".to_string());
    }
    Ok(path)
}

/// Removes the staging folders of earlier previews: the dialog imports only from the latest one, so
/// staging never holds more than one preview. A failure only leaves them in place.
fn prune_staging(staging: &Path) {
    let Ok(entries) = fs::read_dir(staging) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = crate::safe_filesystem::remove_dir_no_symlinks(&entry.path(), staging);
    }
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|_| "cannot create a private staging folder".to_string())
}

/// Copies the source into private staging, validates the copy and lists what it holds, with a
/// one-time token for [`commit_skill_import`]. Nothing is published; nothing of the source is
/// followed through a link, run or changed.
#[tauri::command(async)]
pub fn preview_skill_import(paths: Vec<String>) -> Result<SkillImportPreview, String> {
    if paths.is_empty() || paths.len() > MAX_SOURCE_PATHS {
        return Err(format!("give 1 to {MAX_SOURCE_PATHS} paths"));
    }
    let _mutation = crate::mutation_lock::acquire()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let home =
        crate::agent_targets::home_dir().map_err(|_| "home folder is unavailable".to_string())?;
    let sources = sources_for(&root)?;
    let names = taken_names(&sources)?;
    let shown_home = home.canonicalize().unwrap_or_else(|_| home.clone());

    let mut problems = Vec::new();
    let mut found: Vec<Found> = Vec::new();
    for raw in &paths {
        let path = match source_path(raw, &home).and_then(|path| resolve_root(&path)) {
            Ok(path) => path,
            Err(problem) => {
                problems.push(format!("{raw}: {problem}"));
                continue;
            }
        };
        // The resolved path is what the preview shows and the record keeps.
        let shown = crate::skill_loads::display_path(&path, &shown_home);
        let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if canonical(&path).starts_with(canonical(&crate::skill_sources::packs_dir(&root)))
            || canonical(&path).starts_with(canonical(&crate::workspace_layout::state_dir(&root)))
        {
            problems.push(format!("{shown}: is in the packs folder already"));
            continue;
        }
        match find_skills(&path, &shown) {
            Ok(skills) => found.extend(skills),
            Err(problem) => problems.push(problem),
        }
    }
    if found.len() > MAX_CANDIDATES {
        return Err(format!("more than {MAX_CANDIDATES} skills at once"));
    }

    crate::safe_filesystem::create_private_root_directory_all_no_symlinks(&root)
        .map_err(|_| "cannot create the data folder safely".to_string())?;
    let staging = staging_root(&root);
    crate::safe_filesystem::create_private_directory_all_no_symlinks(&staging, &root)
        .map_err(|_| "cannot create the staging folder safely".to_string())?;
    prune_staging(&staging);
    let stage = staging.join(format!(".new-{}", nonce()?));
    create_private_dir(&stage)?;

    let result = stage_candidates(&root, &shown_home, &names, &found, &stage);
    let (candidates, staged) = match result {
        Ok(done) => done,
        Err(error) => {
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&stage, &staging);
            return Err(error);
        }
    };
    let importable = candidates
        .iter()
        .any(|candidate| candidate.problems.is_empty() && candidate.status != "unchanged");
    let folder = crate::skill_loads::display_path(&imported_skills_dir(&root), &home);
    if !importable {
        let _ = crate::safe_filesystem::remove_dir_no_symlinks(&stage, &staging);
        return Ok(SkillImportPreview {
            token: None,
            candidates,
            problems,
            folder,
        });
    }
    let manifest =
        serde_json::to_vec(&staged).map_err(|_| "cannot record the staged skills".to_string())?;
    let finish = || -> Result<String, String> {
        crate::safe_filesystem::write_private_new_regular_file_synced(
            &stage.join(MANIFEST_FILE),
            &manifest,
            &stage,
        )
        .map_err(|_| "cannot record the staged skills".to_string())?;
        let token = crate::setup_transaction::issue_preview_token(
            &root,
            &fingerprint(&manifest)?,
            PreviewPurpose::SkillImport,
            &[],
        )?;
        fs::rename(&stage, staging.join(&token))
            .map_err(|_| "cannot keep the staged skills".to_string())?;
        Ok(token)
    };
    match finish() {
        Ok(token) => Ok(SkillImportPreview {
            token: Some(token),
            candidates,
            problems,
            folder,
        }),
        Err(error) => {
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&stage, &staging);
            Err(error)
        }
    }
}

fn fingerprint(manifest: &[u8]) -> Result<String, String> {
    crate::setup_transaction::stable_fingerprint(&[crate::stable_digest::bytes(manifest)])
}

fn stage_candidates(
    root: &Path,
    home: &Path,
    names: &Names,
    found: &[Found],
    stage: &Path,
) -> Result<(Vec<ImportCandidate>, Vec<StagedCandidate>), String> {
    let mut candidates = Vec::new();
    let mut staged = Vec::new();
    let mut claimed: BTreeMap<String, usize> = BTreeMap::new();
    for (index, item) in found.iter().enumerate() {
        let key = index.to_string();
        let scan = scan_skill(item);
        let folder = match item.kind {
            SourceKind::File => None,
            _ => item.path.file_name().and_then(|name| name.to_str()),
        };
        let mut candidate = ImportCandidate {
            key: key.clone(),
            kind: item.kind,
            source: crate::skill_loads::display_path(&item.path, home),
            name: folder.unwrap_or_default().to_string(),
            description: String::new(),
            license: String::new(),
            compatibility: String::new(),
            files: scan
                .files
                .iter()
                .map(|file| ImportFile {
                    path: file.rel.clone(),
                    size: file.size,
                    executable: file.executable,
                    binary: false,
                    problem: scan
                        .unrepresentable
                        .contains(&file.rel)
                        .then(|| "the installer cannot use this name".to_string()),
                })
                .collect(),
            omitted: scan.omitted.clone(),
            flags: Vec::new(),
            problems: scan.problems.clone(),
            skill_md: String::new(),
            digest: String::new(),
            status: "refused".to_string(),
            collision: None,
            changes: Vec::new(),
        };
        // `SKILL.md` first in the list.
        candidate
            .files
            .sort_by_key(|file| (file.path != "SKILL.md", file.path.clone()));
        if !candidate.problems.is_empty() {
            candidates.push(candidate);
            continue;
        }
        // The copy: what the commit publishes, byte for byte.
        let dir = stage.join(&key);
        let mut files = BTreeMap::new();
        for file in &scan.files {
            let bytes = match read_source(file) {
                Ok(bytes) => bytes,
                Err(problem) => {
                    candidate.problems.push(problem);
                    break;
                }
            };
            crate::safe_filesystem::write_private_new_regular_file_synced(
                &dir.join(&file.rel),
                &bytes,
                stage,
            )
            .map_err(|_| "cannot write the staged copy".to_string())?;
            crate::safe_filesystem::set_file_executable(
                &dir.join(&file.rel),
                file.executable,
                true,
            )?;
            files.insert(file.rel.clone(), bytes);
        }
        if !candidate.problems.is_empty() {
            // A refused skill's copy is not kept.
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&dir, stage);
            candidates.push(candidate);
            continue;
        }
        let executables: BTreeSet<String> = scan
            .files
            .iter()
            .filter(|file| file.executable)
            .map(|file| file.rel.clone())
            .collect();
        let inspected = inspect(&files, &executables, folder);
        for file in candidate.files.iter_mut() {
            file.binary = files.get(&file.path).is_some_and(|bytes| is_binary(bytes));
        }
        candidate.name = inspected.name.clone();
        candidate.description = inspected.description;
        candidate.license = inspected.license;
        candidate.compatibility = inspected.compatibility;
        candidate.flags = inspected.flags;
        candidate.problems = inspected.problems;
        candidate.skill_md = inspected.skill_md;
        let tree = SkillTree { files, executables };
        candidate.digest = tree_digest(&tree);
        if candidate.problems.is_empty() {
            // The checks the pack reader applies, on the copy itself.
            if let Err(error) = crate::skill_discovery::skill_support_files(&dir) {
                candidate
                    .problems
                    .push(format!("the copy would not load as a pack skill: {error}"));
            }
        }
        let name = candidate.name.clone();
        if candidate.problems.is_empty() {
            if let Some(problem) = name_problem(names, &name) {
                candidate.problems.push(problem);
            } else if let Some(first) = claimed.get(&name) {
                candidate.problems.push(format!(
                    "another skill of this import is named {name} too (the one from {})",
                    candidates
                        .get(*first)
                        .map(|other: &ImportCandidate| other.source.clone())
                        .unwrap_or_default()
                ));
            }
        }
        if !candidate.problems.is_empty() {
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&dir, stage);
            candidates.push(candidate);
            continue;
        }
        claimed.insert(name.clone(), candidates.len());
        if names.bundled.contains(&name) {
            candidate.collision = Some("bundled".to_string());
        }
        let existing = existing_import(root, &name)?;
        let existing_digest = existing.as_ref().map(tree_digest);
        candidate.status = match &existing {
            None => "new",
            Some(before) if tree_digest(before) == candidate.digest => "unchanged",
            Some(_) => "update",
        }
        .to_string();
        if let Some(before) = &existing {
            candidate.changes = changes(before, &tree);
        }
        staged.push(StagedCandidate {
            key,
            name,
            kind: item.kind,
            source: candidate.source.clone(),
            digest: candidate.digest.clone(),
            existing: existing_digest,
        });
        candidates.push(candidate);
    }
    Ok((candidates, staged))
}

// ── The record file ──

fn record_path(root: &Path) -> PathBuf {
    imported_pack_dir(root).join(RECORD_FILE)
}

/// The record; an empty one when there is none yet. A record that cannot be read is never
/// rewritten: `Err`.
fn read_record(root: &Path) -> Result<RecordDocument, String> {
    let path = record_path(root);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecordDocument {
                schema_version: RECORD_SCHEMA,
                ..RecordDocument::default()
            })
        }
        Ok(meta) if meta.is_file() => {}
        _ => return Err("the import record cannot be read".to_string()),
    }
    let bytes = read_capped(&path, MAX_RECORD_BYTES)
        .map_err(|_| "the import record cannot be read".to_string())?;
    let document: RecordDocument = serde_json::from_slice(&bytes)
        .map_err(|_| "the import record cannot be read; it is left as it is".to_string())?;
    if document.schema_version != RECORD_SCHEMA {
        return Err("the import record is of another version; it is left as it is".to_string());
    }
    // Names in the record become paths: a record changed by hand is not used.
    let names_ok = document
        .skills
        .keys()
        .all(|name| valid_spec_skill_name(name))
        && document
            .events
            .iter()
            .all(|event| valid_spec_skill_name(&event.name));
    if !names_ok {
        return Err(
            "the import record names a skill that is no skill name; it is left as it is"
                .to_string(),
        );
    }
    Ok(document)
}

fn write_record(root: &Path, document: &mut RecordDocument) -> Result<(), String> {
    let excess = document.events.len().saturating_sub(MAX_EVENTS);
    document.events.drain(..excess);
    document.schema_version = RECORD_SCHEMA;
    let mut bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| "cannot write the import record".to_string())?;
    bytes.push(b'\n');
    crate::safe_filesystem::write_private_regular_file_atomic(
        &record_path(root),
        &bytes,
        &imported_pack_dir(root),
    )
    .map_err(|_| "cannot write the import record".to_string())
}

// ── Routing of imported skills ──
//
// The app keeps one line per imported skill in `packs/imported/routing.md`, in the form
// `pack_routing::routing_line` writes; lines of any other form are the user's and stay byte for byte.
// Only this app-owned pack is ever written. The reader validates the file as it does any pack's.

/// Refuses `text` over the reader's limits, which would exclude the whole file. Checked by every
/// edit that adds a line; one that only takes lines out (a removal, an undone import) or puts the
/// file back after a failure writes whatever it has, so a file the user made too long by hand never
/// blocks a removal.
fn routing_check(text: &str) -> Result<(), String> {
    use crate::pack_routing::{MAX_ROUTING_BYTES, MAX_ROUTING_LINES};
    if text.len() as u64 > MAX_ROUTING_BYTES {
        return Err(format!(
            "routing.md would be larger than {MAX_ROUTING_BYTES} bytes"
        ));
    }
    if text.split_inclusive('\n').count() > MAX_ROUTING_LINES {
        return Err(format!(
            "routing.md would be longer than {MAX_ROUTING_LINES} lines"
        ));
    }
    Ok(())
}

/// Writes `text` as the imported pack's `routing.md` (see [`routing_check`] for the limits).
fn routing_write(root: &Path, text: &str) -> Result<(), String> {
    let pack = imported_pack_dir(root);
    crate::safe_filesystem::write_private_regular_file_atomic(
        &pack.join(crate::pack_routing::ROUTING_FILE),
        text.as_bytes(),
        &pack,
    )
    .map_err(|_| "routing.md cannot be written safely".to_string())
}

/// `text` with each `(name, line)` applied to the app's own line of `name`: a line replaces the
/// first one in place (further ones go) or is appended; `None` takes them out.
fn routing_edit(text: &str, edits: &[(String, Option<String>)]) -> String {
    // The reader skips a leading byte order mark; it stays in front of the first line.
    let (bom, text) = match text.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", text),
    };
    let mut out = text.to_string();
    for (name, replacement) in edits {
        let mut next = String::new();
        let mut found = false;
        for line in out.split_inclusive('\n') {
            if crate::pack_routing::own_when(line, name).is_none() {
                next.push_str(line);
                continue;
            }
            if !found {
                if let Some(new) = replacement {
                    next.push_str(new);
                    next.push('\n');
                }
                found = true;
            }
        }
        if let (false, Some(new)) = (found, replacement) {
            if !next.is_empty() && !next.ends_with('\n') {
                next.push('\n');
            }
            next.push_str(new);
            next.push('\n');
        }
        out = next;
    }
    format!("{bom}{out}")
}

/// The app's own line(s) of `name` in `text`, without a leading byte order mark.
fn routing_own_lines(text: &str, name: &str) -> Vec<String> {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .split_inclusive('\n')
        .filter(|line| crate::pack_routing::own_when(line, name).is_some())
        .map(str::to_string)
        .collect()
}

/// `text` without every line that names `name` in backticks, the app's or the user's, since a line
/// naming a skill that is gone would exclude the whole file; and the lines taken out.
fn routing_remove_named(text: &str, name: &str) -> (String, Vec<String>) {
    let mut kept = String::new();
    let mut removed = Vec::new();
    for line in text.split_inclusive('\n') {
        if crate::pack_routing::names_skill(line, name) {
            removed.push(line.to_string());
        } else {
            kept.push_str(line);
        }
    }
    (kept, removed)
}

/// `text` with `lines` (as [`routing_remove_named`] took them out) appended again.
fn routing_restore(mut text: String, lines: &[String]) -> String {
    for line in lines {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(line);
    }
    text
}

/// The imported pack's `routing.md` before and after `edit`, and the lines `edit` took out; `None`
/// when nothing changes or the file cannot be read safely. The reader does not use such a file, so
/// removing or restoring a skill goes on without touching it.
fn routing_change(
    root: &Path,
    edit: impl FnOnce(&str) -> (String, Vec<String>),
) -> Option<(String, String, Vec<String>)> {
    let before = crate::pack_routing::read_raw(&imported_pack_dir(root)).ok()?;
    let (after, removed) = edit(&before);
    (after != before).then_some((before, after, removed))
}

/// The index of the event [`undo_last_import`] undoes: the latest one no undo has taken back.
fn undoable(document: &RecordDocument) -> Option<usize> {
    let mut stack = Vec::new();
    for (index, event) in document.events.iter().enumerate() {
        match event.action {
            EventAction::Undo => {
                stack.pop();
            }
            _ => stack.push(index),
        }
    }
    stack.pop()
}

/// The Library's view of the record: where each imported skill came from, and what Undo would
/// take back. Empty when there is no record or it cannot be read.
pub(super) fn library_imports(
    root: &Path,
) -> (BTreeMap<String, ImportProvenance>, Option<UndoImport>) {
    let Ok(document) = read_record(root) else {
        return (BTreeMap::new(), None);
    };
    let provenance = document
        .skills
        .iter()
        .map(|(name, record)| {
            (
                name.clone(),
                ImportProvenance {
                    source: record.source.clone(),
                    kind: record.kind,
                    imported_at: record.imported_at,
                    digest: record.tree_digest.clone(),
                },
            )
        })
        .collect();
    let undo = undoable(&document).map(|index| UndoImport {
        action: document.events[index].action,
        name: document.events[index].name.clone(),
    });
    (provenance, undo)
}

// ── Writing the pack ──

/// Copies the skill folder at `dir` to `backups/imports/<name>-<ts>/<name>/` and returns the
/// folder name below `backups/imports/`.
fn back_up(dir: &Path, name: &str) -> Result<String, String> {
    let root = super::backups::backup_root()?;
    let label = format!("{name}-{}", nonce()?);
    let target = root.join("imports").join(&label);
    crate::safe_filesystem::create_private_root_directory_all_no_symlinks(&root)
        .map_err(|_| "cannot create the backup folder".to_string())?;
    crate::safe_filesystem::create_private_directory_all_no_symlinks(&target, &root)
        .map_err(|_| "cannot create the backup folder".to_string())?;
    crate::safe_filesystem::copy_private_dir_no_symlinks(dir, &target.join(name), &root)
        .map_err(|_| "cannot back up the imported skill".to_string())?;
    Ok(label)
}

fn backup_dir(label: &str, name: &str) -> Result<PathBuf, String> {
    // `<name>-<pid>-<nanos>`, as [`back_up`] names it.
    let stamp = label
        .strip_prefix(name)
        .and_then(|rest| rest.strip_prefix('-'))
        .and_then(|rest| rest.split_once('-'))
        .filter(|(pid, nanos)| {
            [pid, nanos]
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        });
    if stamp.is_none() || !valid_spec_skill_name(name) {
        return Err("the backup of this import is not usable".to_string());
    }
    Ok(super::backups::backup_root()?
        .join("imports")
        .join(label)
        .join(name))
}

/// Writes `files` into a new temporary folder in `skills` and returns it.
fn write_temp(skills: &Path, files: &SkillTree) -> Result<PathBuf, String> {
    let temp = skills.join(format!(".import-{}", nonce()?));
    create_private_dir(&temp)?;
    for (rel, bytes) in &files.files {
        let written = crate::safe_filesystem::write_private_new_regular_file_synced(
            &temp.join(rel),
            bytes,
            &temp,
        )
        .and_then(|()| {
            crate::safe_filesystem::set_file_executable(
                &temp.join(rel),
                files.executables.contains(rel),
                true,
            )
        });
        if let Err(error) = written {
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&temp, skills);
            return Err(format!("cannot write the imported skill: {error}"));
        }
    }
    Ok(temp)
}

/// Puts `files` in place as `skills/<name>/`, all at once. An existing folder is moved aside first
/// and returned, so the caller can put it back or remove it.
fn publish(
    root: &Path,
    skills: &Path,
    name: &str,
    files: &SkillTree,
) -> Result<Option<PathBuf>, String> {
    let target = skills.join(name);
    super::content::safe_canonical_target(skills, &target)
        .map_err(|_| "unsafe imported skill destination".to_string())?;
    crate::path_safety::reject_symlink_parent_chain(&target, root, "imported skill")
        .map_err(|_| "refusing a symlink in the imported skill path".to_string())?;
    let temp = write_temp(skills, files)?;
    let aside = match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            let aside = skills.join(format!(".replaced-{}", nonce()?));
            if fs::rename(&target, &aside).is_err() {
                let _ = crate::safe_filesystem::remove_dir_no_symlinks(&temp, skills);
                return Err("cannot move the imported skill in place aside".to_string());
            }
            Some(aside)
        }
        _ => {
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&temp, skills);
            return Err("the imported skill's folder is not a plain folder".to_string());
        }
    };
    if fs::rename(&temp, &target).is_err() {
        if let Some(aside) = &aside {
            let _ = fs::rename(aside, &target);
        }
        let _ = crate::safe_filesystem::remove_dir_no_symlinks(&temp, skills);
        return Err("cannot publish the imported skill".to_string());
    }
    Ok(aside)
}

/// Undoes [`publish`]: removes the new folder and puts the one moved aside back.
fn unpublish(skills: &Path, name: &str, aside: Option<PathBuf>) {
    let target = skills.join(name);
    let _ = crate::safe_filesystem::remove_dir_no_symlinks(&target, skills);
    if let Some(aside) = aside {
        let _ = fs::rename(aside, target);
    }
}

fn record_of(
    files: &SkillTree,
    source: &str,
    kind: SourceKind,
    renamed_from: Option<String>,
) -> ImportRecord {
    ImportRecord {
        source: source.to_string(),
        kind,
        imported_at: now_secs(),
        tree_digest: tree_digest(files),
        files: file_digests(&files.files),
        renamed_from,
    }
}

/// Publishes the previewed skills picked in `selection` (candidate keys) into the imported pack,
/// each under its `name` or the name `renames` gives it. Refused when the staged copy or the import
/// in place changed since the preview, or the token is spent or expired. A replaced import is
/// backed up first. Nothing is installed: the next Update does that, after its own review.
#[tauri::command(async)]
pub fn commit_skill_import(
    token: String,
    selection: Vec<String>,
    renames: BTreeMap<String, String>,
    routing: BTreeMap<String, Option<String>>,
) -> Result<SkillImportResult, String> {
    if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid or expired preview token".to_string());
    }
    if selection.is_empty() {
        return Err("pick at least one skill to import".to_string());
    }
    let _mutation = crate::mutation_lock::acquire()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let staging = staging_root(&root);
    let stage = staging.join(&token);
    let result = commit_staged(&root, &stage, &token, &selection, &renames, &routing);
    if fs::symlink_metadata(&stage).is_ok_and(|meta| meta.is_dir()) {
        let _ = crate::safe_filesystem::remove_dir_no_symlinks(&stage, &staging);
    }
    result
}

fn commit_staged(
    root: &Path,
    stage: &Path,
    token: &str,
    selection: &[String],
    renames: &BTreeMap<String, String>,
    routing: &BTreeMap<String, Option<String>>,
) -> Result<SkillImportResult, String> {
    let changed = "the skill or the import in place changed since the preview; preview it again";
    crate::path_safety::reject_symlink(stage, "staging folder")
        .map_err(|_| "invalid or expired preview token".to_string())?;
    let manifest = read_capped(&stage.join(MANIFEST_FILE), MAX_RECORD_BYTES)
        .map_err(|_| "invalid or expired preview token".to_string())?;
    crate::setup_transaction::validate_preview_token(
        token,
        root,
        &fingerprint(&manifest)?,
        PreviewPurpose::SkillImport,
        &[],
    )?;
    let staged: Vec<StagedCandidate> =
        serde_json::from_slice(&manifest).map_err(|_| changed.to_string())?;
    // The staged copies and the imports in place are still what the preview showed.
    let mut picked = Vec::new();
    for key in selection {
        let candidate = staged
            .iter()
            .find(|candidate| &candidate.key == key)
            .ok_or_else(|| "a picked skill is not in the preview".to_string())?;
        if picked
            .iter()
            .any(|(c, _): &(&StagedCandidate, _)| c.key == candidate.key)
        {
            continue;
        }
        let files = tree_files(&stage.join(&candidate.key)).map_err(|_| changed.to_string())?;
        if tree_digest(&files) != candidate.digest
            || existing_import(root, &candidate.name)?
                .as_ref()
                .map(tree_digest)
                != candidate.existing
        {
            return Err(changed.to_string());
        }
        picked.push((candidate, files));
    }
    crate::setup_transaction::consume_preview_token(token)?;

    let sources = sources_for(root)?;
    let names = taken_names(&sources)?;
    if sources
        .packs()
        .iter()
        .any(|pack| pack.name == IMPORTED_PACK && pack.refused.is_some())
    {
        return Err(
            "the imported pack is refused; check ownership, permissions and links".to_string(),
        );
    }
    if sources.packs().len() >= crate::skill_sources::MAX_PACKS
        && !sources
            .packs()
            .iter()
            .any(|pack| pack.name == IMPORTED_PACK)
    {
        return Err("cannot add the imported pack: the pack limit is reached".to_string());
    }
    // Every name is decided before anything is written.
    let mut plan = Vec::new();
    let mut seen = BTreeSet::new();
    for (candidate, mut files) in picked {
        let name = renames
            .get(&candidate.key)
            .filter(|name| **name != candidate.name)
            .cloned();
        let final_name = name.clone().unwrap_or_else(|| candidate.name.clone());
        if !valid_spec_skill_name(&final_name) {
            return Err(format!(
                "{final_name:?} is not a skill name: 1–64 lowercase letters, digits and single dashes"
            ));
        }
        if names.bundled.contains(&final_name) {
            return Err(format!(
                "a bundled skill is named {final_name}; import it under another name"
            ));
        }
        if let Some(problem) = name_problem(&names, &final_name) {
            return Err(problem);
        }
        if !seen.insert(final_name.clone()) {
            return Err(format!(
                "two picked skills would both be named {final_name}"
            ));
        }
        if name.is_none() && candidate.existing.as_ref() == Some(&candidate.digest) {
            return Err(format!("{final_name} is imported already, unchanged"));
        }
        if name.is_some() {
            if existing_import(root, &final_name)?.is_some() {
                return Err(format!(
                    "an imported skill is named {final_name} already; choose another name"
                ));
            }
            // The bytes the dialog showed: the verified staged text with its `name:` line rewritten.
            let text = std::str::from_utf8(&files.files["SKILL.md"])
                .map_err(|_| "SKILL.md is not UTF-8 text".to_string())?;
            let renamed = renamed_skill_md(text, &final_name)?;
            files
                .files
                .insert("SKILL.md".to_string(), renamed.into_bytes());
        }
        plan.push((
            candidate,
            final_name,
            name.map(|_| candidate.name.clone()),
            files,
        ));
    }

    // Routing is checked and read before anything is published, so a bad line or an unsafe
    // routing.md refuses the import as a whole.
    let mut routing_edits = Vec::new();
    for (candidate, name, _, _) in &plan {
        if let Some(when) = routing.get(&candidate.key) {
            routing_edits.push((
                name.clone(),
                when.as_deref()
                    .map(|when| crate::pack_routing::routing_line(when, name))
                    .transpose()?,
            ));
        }
    }
    let routing_text = if routing_edits.is_empty() {
        None
    } else {
        let text = crate::pack_routing::read_raw(&imported_pack_dir(root))?;
        let edited = routing_edit(&text, &routing_edits);
        routing_check(&edited)?;
        Some((text, edited))
    };
    let routing_set_for = |name: &str| routing_edits.iter().any(|(edited, _)| edited == name);
    let mut document = read_record(root)?;
    let skills = super::packs::create_pack_skill_dirs(root, IMPORTED_PACK)?;
    let mut result = SkillImportResult {
        imported: Vec::new(),
        updated: Vec::new(),
    };
    // Each skill is published on its own; a failure stops there and says what is in already.
    let partial = |result: &SkillImportResult, error: String| {
        let done: Vec<&str> = result
            .imported
            .iter()
            .chain(&result.updated)
            .map(String::as_str)
            .collect();
        if done.is_empty() {
            error
        } else {
            format!("{error} ({} imported before this)", done.join(", "))
        }
    };
    for (candidate, name, renamed_from, files) in plan {
        let target = skills.join(&name);
        let replacing = fs::symlink_metadata(&target).is_ok();
        let backup = if replacing {
            Some(back_up(&target, &name).map_err(|e| partial(&result, e))?)
        } else {
            None
        };
        let aside = publish(root, &skills, &name, &files).map_err(|e| partial(&result, e))?;
        let previous = document.skills.insert(
            name.clone(),
            record_of(&files, &candidate.source, candidate.kind, renamed_from),
        );
        document.events.push(ImportEvent {
            action: if replacing {
                EventAction::Replace
            } else {
                EventAction::Import
            },
            name: name.clone(),
            at: now_secs(),
            backup,
            previous: if replacing { previous.clone() } else { None },
            routing: match &routing_text {
                Some((text, _)) if replacing && routing_set_for(&name) => {
                    routing_own_lines(text, &name)
                }
                _ => Vec::new(),
            },
            routing_set: replacing && routing_set_for(&name),
        });
        if let Err(error) = write_record(root, &mut document) {
            unpublish(&skills, &name, aside);
            return Err(partial(&result, error));
        }
        if let Some(aside) = aside {
            // The old copy is in the backup; the one moved aside goes.
            let _ = crate::safe_filesystem::remove_dir_no_symlinks(&aside, &skills);
            result.updated.push(name);
        } else {
            result.imported.push(name);
        }
    }
    if let Some((text, edited)) = routing_text {
        if edited != text {
            if let Err(error) = routing_write(root, &edited) {
                let done = result
                    .imported
                    .iter()
                    .chain(&result.updated)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!("{done} imported; routing was not saved: {error}"));
            }
        }
    }
    Ok(result)
}

// ── Remove and undo ──

fn locked_imported_skill(root: &Path, name: &str) -> Result<(PathBuf, PathBuf), String> {
    let skills = imported_skills_dir(root);
    let dir = skills.join(name);
    crate::path_safety::reject_symlink_parent_chain(&dir, root, "imported skill")
        .map_err(|_| "refusing a symlink in the imported skill path".to_string())?;
    Ok((skills, dir))
}

/// Saves or removes the app-managed routing line of an imported skill.
#[tauri::command(async)]
pub fn set_imported_skill_routing(name: String, when: Option<String>) -> Result<String, String> {
    if !valid_spec_skill_name(&name) {
        return Err("not an imported skill name".to_string());
    }
    let line = when
        .as_deref()
        .map(|when| crate::pack_routing::routing_line(when, &name))
        .transpose()?;
    let _mutation = crate::mutation_lock::acquire()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let (_, dir) = locked_imported_skill(&root, &name)?;
    if !fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
    {
        return Err(format!("no imported skill is named {name}"));
    }
    // The reader routes only to active skills: a line for a shadowed or broken one would exclude
    // the whole file. Taking a line out is always allowed.
    if line.is_some() {
        let sources = sources_for(&root)?;
        let active = sources.packs().iter().any(|pack| {
            pack.name == IMPORTED_PACK
                && pack.skills.iter().any(|skill| {
                    skill.name == name
                        && skill.state == crate::skill_sources::PackSkillState::Active
                })
        });
        if !active {
            return Err(format!(
                "{name} is not active (shadowed by a bundled skill or not valid), so it cannot be routed to"
            ));
        }
    }
    let text = crate::pack_routing::read_raw(&imported_pack_dir(&root))?;
    let edited = routing_edit(&text, &[(name.clone(), line)]);
    routing_check(&edited)?;
    routing_write(&root, &edited)?;
    Ok(if when.is_some() {
        format!("Routing for {name} saved; the next Update adds it to your rules files")
    } else {
        format!("Routing for {name} removed; the next Update takes it out of your rules files")
    })
}

/// Moves the imported skill `name` into a backup (never deletes it) and records the removal. The
/// next Update retires the installed copies, with a backup, like any skill gone from a pack.
#[tauri::command(async)]
pub fn remove_imported_skill(name: String) -> Result<String, String> {
    if !valid_spec_skill_name(&name) {
        return Err("not an imported skill name".to_string());
    }
    let _mutation = crate::mutation_lock::acquire()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let (skills, dir) = locked_imported_skill(&root, &name)?;
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        _ => return Err(format!("no imported skill is named {name}")),
    }
    let mut document = read_record(&root)?;
    let routing = routing_change(&root, |text| routing_remove_named(text, &name));
    let routing_unread = crate::pack_routing::read_raw(&imported_pack_dir(&root)).is_err();
    let backup = back_up(&dir, &name)?;
    let previous = document.skills.remove(&name);
    document.events.push(ImportEvent {
        action: EventAction::Remove,
        name: name.clone(),
        at: now_secs(),
        backup: Some(backup),
        previous,
        routing: routing
            .as_ref()
            .map(|(_, _, removed)| removed.clone())
            .unwrap_or_default(),
        routing_set: false,
    });
    let aside = skills.join(format!(".removed-{}", nonce()?));
    fs::rename(&dir, &aside).map_err(|_| "cannot remove the imported skill".to_string())?;
    if let Some((_, after, _)) = &routing {
        if let Err(error) = routing_write(&root, after) {
            let _ = fs::rename(&aside, &dir);
            return Err(error);
        }
    }
    if let Err(error) = write_record(&root, &mut document) {
        if let Some((before, _, _)) = &routing {
            let _ = routing_write(&root, before);
        }
        let _ = fs::rename(&aside, &dir);
        return Err(error);
    }
    let _ = crate::safe_filesystem::remove_dir_no_symlinks(&aside, &skills);
    Ok(format!(
        "{name} removed from pack:imported, with a backup; the next Update removes the installed copies{}",
        if routing_unread {
            "; routing.md cannot be read safely, so a line naming it is still there"
        } else {
            ""
        }
    ))
}

/// Takes back the latest import, replacement or removal that is not taken back yet: an import is
/// moved into a backup, a replaced or removed copy comes back from its backup. Refused when the
/// imported skill in place is no longer what that event left.
#[tauri::command(async)]
pub fn undo_last_import() -> Result<String, String> {
    let _mutation = crate::mutation_lock::acquire()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let mut document = read_record(&root)?;
    let index = undoable(&document).ok_or_else(|| "there is no import to undo".to_string())?;
    let event = document.events[index].clone();
    let name = event.name.clone();
    let (skills, dir) = locked_imported_skill(&root, &name)?;
    let in_place = existing_import(&root, &name)?;
    // An import or replacement is undone only while the skill is what it published.
    if matches!(event.action, EventAction::Import | EventAction::Replace) {
        let expected = document.skills.get(&name).map(|record| &record.tree_digest);
        if in_place.as_ref().map(tree_digest).as_ref() != expected {
            return Err(format!(
                "{name} changed since it was imported; remove it instead"
            ));
        }
    }
    let restore = match event.action {
        EventAction::Import => None,
        EventAction::Replace | EventAction::Remove => {
            let label = event
                .backup
                .as_deref()
                .ok_or_else(|| "the backup of this import is not recorded".to_string())?;
            // Nothing authenticates a backup: as in a setup rollback, it must be the user's alone
            // and still the copy the record describes.
            let backup = backup_dir(label, &name)?;
            let folder = backup.parent().unwrap_or(&backup);
            crate::setup_transaction::check_backup_trusted(folder, folder).map_err(|_| {
                "the backup of this import is a link, or someone else could have written it"
                    .to_string()
            })?;
            let files = tree_files(&backup)
                .map_err(|_| "the backup of this import cannot be read".to_string())?;
            let recorded = event.previous.as_ref().map(|record| &record.tree_digest);
            if recorded != Some(&tree_digest(&files)) {
                return Err("the backup of this import is not the copy it recorded".to_string());
            }
            Some(files)
        }
        EventAction::Undo => return Err("there is no import to undo".to_string()),
    };
    if event.action == EventAction::Remove {
        if in_place.is_some() {
            return Err(format!(
                "an imported skill is named {name} again; remove it first"
            ));
        }
        let names = taken_names(&sources_for(&root)?)?;
        if let Some(problem) = name_problem(&names, &name) {
            return Err(problem);
        }
    }
    // An undone import takes its lines out; an undone removal puts back the lines it took out.
    let routing = match event.action {
        EventAction::Import => routing_change(&root, |text| routing_remove_named(text, &name)),
        EventAction::Remove => routing_change(&root, |text| {
            (
                routing_restore(text.to_string(), &event.routing),
                Vec::new(),
            )
        }),
        // An undone replacement that set the line puts back the line the skill had, or none.
        EventAction::Replace if event.routing_set => routing_change(&root, |text| {
            let line = event
                .routing
                .first()
                .map(|line| line.trim_end().to_string());
            (routing_edit(text, &[(name.clone(), line)]), Vec::new())
        }),
        _ => None,
    };
    // Lines put back must fit; this is known before anything is moved.
    if let (Some((_, after, _)), EventAction::Remove | EventAction::Replace) =
        (&routing, &event.action)
    {
        routing_check(after)?;
    }
    let backup = if in_place.is_some() {
        Some(back_up(&dir, &name)?)
    } else {
        None
    };
    let skills = if restore.is_some() {
        super::packs::create_pack_skill_dirs(&root, IMPORTED_PACK)?
    } else {
        skills
    };
    let aside = match &restore {
        Some(files) => publish(&root, &skills, &name, files)?,
        None => {
            let aside = skills.join(format!(".removed-{}", nonce()?));
            fs::rename(&dir, &aside).map_err(|_| "cannot undo the import".to_string())?;
            Some(aside)
        }
    };
    match event.previous.clone() {
        Some(record) => document.skills.insert(name.clone(), record),
        None => document.skills.remove(&name),
    };
    document.events.push(ImportEvent {
        action: EventAction::Undo,
        name: name.clone(),
        at: now_secs(),
        backup,
        previous: None,
        routing: routing
            .as_ref()
            .map(|(_, _, removed)| removed.clone())
            .unwrap_or_default(),
        routing_set: false,
    });
    let saved = match &routing {
        Some((_, after, _)) => routing_write(&root, after),
        None => Ok(()),
    };
    if let Err(error) = saved.and_then(|()| write_record(&root, &mut document)) {
        if let Some((before, _, _)) = &routing {
            let _ = routing_write(&root, before);
        }
        match (&restore, aside) {
            (Some(_), aside) => unpublish(&skills, &name, aside),
            (None, Some(aside)) => {
                let _ = fs::rename(aside, &dir);
            }
            (None, None) => {}
        }
        return Err(error);
    }
    if let Some(aside) = aside {
        let _ = crate::safe_filesystem::remove_dir_no_symlinks(&aside, &skills);
    }
    Ok(match event.action {
        EventAction::Import => format!("import of {name} undone, with a backup"),
        EventAction::Replace => format!("{name} is back as it was before it was imported again"),
        _ => format!("{name} is back in pack:imported"),
    })
}

#[cfg(test)]
mod routing_tests {
    use super::*;

    #[test]
    fn edits_preserve_other_lines_and_enforce_limits() {
        let text = "- Old: `mine`.\r\n- Hand written `mine` and `other`.  \n- Again: `mine`.\n";
        let edited = routing_edit(
            text,
            &[
                ("mine".into(), Some("- New: `mine`.".into())),
                ("other".into(), Some("- Other: `other`.".into())),
            ],
        );
        assert_eq!(
            edited,
            "- New: `mine`.\n- Hand written `mine` and `other`.  \n- Other: `other`.\n"
        );
        assert_eq!(
            routing_edit(&edited, &[("mine".into(), None)]),
            "- Hand written `mine` and `other`.  \n- Other: `other`.\n"
        );
        let root = std::env::temp_dir().join(format!("routing-test-{}", nonce().unwrap()));
        fs::create_dir_all(imported_pack_dir(&root)).unwrap();
        assert!(routing_check(&"x\n".repeat(61)).is_err());
        assert!(routing_check(&"x\n".repeat(60)).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                root.join("elsewhere"),
                imported_pack_dir(&root).join("routing.md"),
            )
            .unwrap();
            assert!(crate::pack_routing::read_raw(&imported_pack_dir(&root)).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_byte_order_mark_stays_in_front_and_the_first_line_is_still_found() {
        let text = "\u{feff}- Old: `mine`.\n- Hand `mine` too.\n";
        assert_eq!(
            routing_edit(text, &[("mine".into(), Some("- New: `mine`.".into()))]),
            "\u{feff}- New: `mine`.\n- Hand `mine` too.\n"
        );
        assert_eq!(
            routing_edit(text, &[("mine".into(), None)]),
            "\u{feff}- Hand `mine` too.\n"
        );
        assert_eq!(routing_own_lines(text, "mine"), vec!["- Old: `mine`.\n"]);
    }

    #[test]
    fn old_events_default_to_no_routing() {
        let event: ImportEvent =
            serde_json::from_str(r#"{"action":"remove","name":"mine","at":1}"#).unwrap();
        assert!(event.routing.is_empty());
    }
}

#[cfg(test)]
mod rename_tests {
    use super::renamed_skill_md;

    #[test]
    fn a_rename_rewrites_the_top_level_name_line_only_and_keeps_line_endings() {
        let text = "---\r\nname: tdd\r\ndescription: d\r\nhooks:\r\n  name: nested\r\n---\r\nname: body\r\n";
        assert_eq!(
            renamed_skill_md(text, "my-tdd").expect("renamed"),
            "---\r\nname: my-tdd\r\ndescription: d\r\nhooks:\r\n  name: nested\r\n---\r\nname: body\r\n"
        );
    }

    #[test]
    fn a_skill_md_without_a_plain_name_line_is_not_renamed() {
        for text in [
            "no frontmatter\n",
            "---\ndescription: d\n---\nname: body\n",
            "---\n\"name\": tdd\ndescription: d\n---\n",
        ] {
            assert!(renamed_skill_md(text, "x").is_err(), "{text}");
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-import-open-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn scanned(path: &Path) -> SourceFile {
        let meta = fs::symlink_metadata(path).expect("lstat");
        SourceFile {
            rel: "a.md".to_string(),
            path: path.to_path_buf(),
            size: meta.len(),
            executable: false,
            identity: identity(&meta),
        }
    }

    /// A tree without an executable hashes as it did before the bit was recorded, so the digests
    /// in existing import records stay valid; an executable changes it.
    #[test]
    fn a_tree_digest_without_executables_is_the_one_computed_before_the_bit_was_recorded() {
        let mut files = BTreeMap::new();
        files.insert("SKILL.md".to_string(), b"text\n".to_vec());
        files.insert("scripts/run.sh".to_string(), b"#!/bin/sh\n".to_vec());
        let listing: String = file_digests(&files)
            .iter()
            .map(|(rel, digest)| format!("{rel}\0{digest}\n"))
            .collect();
        let old = crate::stable_digest::bytes(listing.as_bytes());
        let mut tree = SkillTree {
            files,
            executables: BTreeSet::new(),
        };
        assert_eq!(tree_digest(&tree), old);
        tree.executables.insert("scripts/run.sh".to_string());
        assert_ne!(tree_digest(&tree), old);
    }

    #[test]
    fn the_script_flag_says_the_executable_bit_is_kept() {
        let mut files = BTreeMap::new();
        files.insert(
            "SKILL.md".to_string(),
            b"---\nname: demo\ndescription: Use it.\n---\n# Demo\n".to_vec(),
        );
        files.insert("scripts/run.sh".to_string(), b"#!/bin/sh\n".to_vec());
        let executables = BTreeSet::from(["scripts/run.sh".to_string()]);
        let inspected = inspect(&files, &executables, Some("demo"));
        let flag = inspected
            .flags
            .iter()
            .find(|flag| flag.kind == "executable")
            .expect("script flag");
        assert!(
            flag.detail.contains("executable bit is kept"),
            "{}",
            flag.detail
        );
        assert!(!flag.detail.contains("without the executable bit"));
    }

    #[test]
    fn variation_selectors_are_flagged_as_hidden_unicode() {
        let flag = hidden_unicode("a\u{FE0F}b\nc\u{E0100}d\n")
            .expect("not refused")
            .expect("flagged");
        assert!(flag.detail.contains("2 invisible"), "{}", flag.detail);
        assert!(flag.detail.ends_with("lines 1, 2"), "{}", flag.detail);
    }

    /// "⚠️" and "☺︎" pick how a symbol looks; the same selectors standalone, after ASCII or in a run,
    /// and every other variation selector, are still flagged.
    #[test]
    fn a_presentation_selector_after_a_symbol_is_not_flagged() {
        let plain = hidden_unicode("\u{26A0}\u{FE0F} careful\n\u{263A}\u{FE0E} ok\n").expect("ok");
        assert!(plain.is_none(), "{plain:?}");
        let text = [
            "\u{FE0F}start",
            "x\u{FE0F}",
            "\u{26A0} \u{FE0F}",
            "\u{26A0}\u{FE0F}\u{FE0F}",
            "\u{26A0}\u{FE00}",
            "\u{26A0}\u{E0100}",
        ]
        .join("\n");
        let flag = hidden_unicode(&text)
            .expect("not refused")
            .expect("flagged");
        assert!(flag.detail.starts_with("6 invisible"), "{}", flag.detail);
        assert!(
            flag.detail.ends_with("lines 1, 2, 3, 4, 5, 6"),
            "{}",
            flag.detail
        );
    }

    #[test]
    fn a_scanned_file_swapped_for_a_link_to_the_same_inode_is_refused() {
        let dir = dir("link");
        let real = dir.join("real.md");
        fs::write(&real, "text\n").expect("file");
        let path = dir.join("a.md");
        fs::rename(&real, &path).expect("move");
        let file = scanned(&path);
        assert_eq!(read_source(&file).expect("unchanged"), b"text\n");
        // The same inode, reached through a link now: the open does not follow it.
        fs::rename(&path, &real).expect("move back");
        std::os::unix::fs::symlink(&real, &path).expect("link");
        assert!(read_source(&file)
            .unwrap_err()
            .contains("changed while it was read"));
        assert!(read_capped(&path, 1024).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_open_itself_refuses_a_link_to_a_regular_file() {
        let dir = dir("nofollow");
        let real = dir.join("real.md");
        fs::write(&real, "text\n").expect("file");
        let path = dir.join("a.md");
        std::os::unix::fs::symlink(&real, &path).expect("link");
        assert!(open_regular(&real).is_ok());
        // Followed, the link would open a regular file with one link, which passes the check after it.
        assert_eq!(open_regular(&path).unwrap_err(), "cannot open");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_scanned_file_swapped_for_a_pipe_is_refused_without_blocking() {
        let dir = dir("fifo");
        let path = dir.join("a.md");
        fs::write(&path, "text\n").expect("file");
        let file = scanned(&path);
        fs::remove_file(&path).expect("remove");
        let made = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("mkfifo");
        assert!(made.success());
        // Without a writer, a blocking open of a pipe never returns; this one does, and refuses.
        assert!(read_source(&file)
            .unwrap_err()
            .contains("changed while it was read"));
        assert!(read_capped(&path, 1024).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_scanned_file_that_gained_a_hard_link_or_was_replaced_is_refused() {
        let dir = dir("hard");
        let path = dir.join("a.md");
        fs::write(&path, "text\n").expect("file");
        let file = scanned(&path);
        fs::hard_link(&path, dir.join("other.md")).expect("hard link");
        assert!(read_source(&file).is_err(), "two links");
        fs::remove_file(dir.join("other.md")).expect("unlink");
        fs::remove_file(&path).expect("remove");
        fs::write(&path, "text\n").expect("another file, same bytes");
        let replaced = read_source(&file);
        // A new inode is refused; a file system that reuses the inode number still passes the size.
        if fs::symlink_metadata(&path).map(|m| identity(&m)).ok() != Some(file.identity) {
            assert!(replaced.is_err());
        }
        let _ = fs::remove_dir_all(dir);
    }
}
