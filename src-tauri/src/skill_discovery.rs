//! Canonical read-only skill catalog discovery.
//!
//! Single owner for SKILL.md layout validation, frontmatter parsing, and
//! harness target metadata used by setup, health checks, and artifact expansion.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_skill_targets::VALID_SKILL_AGENTS;
use crate::path_safety::reject_symlink;

/// One discovered skill from the workspace skills catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    pub targets: Vec<String>,
    pub group: String,
    pub source_dir: PathBuf,
    pub skill_md_path: PathBuf,
    /// Path relative to workspace root, forward slashes (e.g. skills/foo/SKILL.md).
    pub relative_path: String,
}

/// Error kind for distinguishing invalid catalog from empty valid catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillDiscoveryError {
    MissingRoot(String),
    InvalidCatalog(String),
}

impl SkillDiscoveryError {
    pub fn message(&self) -> &str {
        match self {
            Self::MissingRoot(m) | Self::InvalidCatalog(m) => m,
        }
    }
}

impl std::fmt::Display for SkillDiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// Whether a `SKILL.md` sits more than one level below `dir`, or the tree cannot be told apart
/// from one (a symlink, too deep, too many entries). Dot entries (`.git`, `.venv`) are never read
/// or installed, so they are not walked either.
pub(crate) fn has_deeper_skill_md(dir: &Path) -> bool {
    let mut seen = 0;
    scan_deeper_skill_md(dir, 0, &mut seen)
}

fn scan_deeper_skill_md(dir: &Path, depth: usize, seen: &mut usize) -> bool {
    /// Entries of the whole walk, not per folder.
    const MAX_ENTRIES: usize = 10_000;
    const MAX_DEPTH: usize = 20;

    if depth > MAX_DEPTH {
        return true;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };

    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        *seen += 1;
        if *seen > MAX_ENTRIES {
            return true;
        }
        let path = entry.path();
        if path.is_symlink() {
            return true;
        }
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            return true;
        }
        if scan_deeper_skill_md(&path, depth + 1, seen) {
            return true;
        }
    }
    false
}

/// The lines between a first line `---` and the next line `---`. A text other readers could split
/// into other lines is refused: a carriage return outside CRLF, U+2028 or U+2029 (line breaks to
/// YAML or to a `^` regex) and every other control character but tab, anywhere in the file.
fn frontmatter_lines(content: &str) -> Result<Vec<&str>, String> {
    let breaks = |c: char| (c.is_control() && c != '\t') || matches!(c, '\u{2028}' | '\u{2029}');
    if let Some(index) = content.lines().position(|line| line.contains(breaks)) {
        return Err(format!(
            "line {} holds a lone carriage return, a line separator or a control character",
            index + 1
        ));
    }
    let mut lines = content.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Err("missing frontmatter opening delimiter".to_string());
    }
    let mut block = Vec::new();
    for line in lines {
        if line.trim_end() == "---" {
            return Ok(block);
        }
        block.push(line);
    }
    Err("missing frontmatter closing delimiter".to_string())
}

/// The top-level keys of a `SKILL.md` frontmatter and their scalar values, read the way a YAML
/// harness reads them for the keys skills use: only unindented `key: value` lines count (a nested
/// `metadata:` mapping is not the skill's name), one level of `"…"` or `'…'` quotes is removed,
/// `|`, `|-`, `>` and `>-` block scalars are read, and indented lines after a plain value continue
/// it. A key that is not a scalar (a nested mapping or list) reads as empty. A key given twice is
/// an error: harnesses disagree on which one wins.
pub(crate) fn frontmatter_fields(content: &str) -> Result<BTreeMap<String, String>, String> {
    scalar_fields(&frontmatter_lines(content)?)
}

/// The scalar entries of a block mapping whose keys start at column 0 (see [`frontmatter_fields`]).
fn scalar_fields(lines: &[&str]) -> Result<BTreeMap<String, String>, String> {
    let mut fields = BTreeMap::new();
    read_mapping(lines, |key, rest, continuation| {
        let value = scalar_value(rest, continuation)
            .map_err(|reason| format!("frontmatter key {key}: {reason}"))?;
        if fields.insert(key.to_string(), value).is_some() {
            return Err(format!("frontmatter key {key} is given more than once"));
        }
        Ok(())
    })?;
    Ok(fields)
}

/// Calls `entry` with the key, the text after the colon and the indented lines that belong to it,
/// for every unindented `key: value` line of `lines`. Any other unindented line is an error, since
/// a YAML parser may read a key there that this reader would skip: an explicit `? key`, a tag, an
/// anchor or alias, a merge key `<<`, a flow mapping, a byte order mark.
fn read_mapping<'a>(
    lines: &[&'a str],
    mut entry: impl FnMut(&str, &str, &[&'a str]) -> Result<(), String>,
) -> Result<(), String> {
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.is_empty() || line.starts_with(|c: char| c.is_whitespace() || c == '#' || c == '-')
        {
            continue;
        }
        let plain = line.starts_with(|c: char| c.is_ascii_alphanumeric() || "_\"'".contains(c));
        let Some((key, rest)) = split_key(line).filter(|_| plain) else {
            return Err(format!("unsupported top-level line {line:?}"));
        };
        let key = unquote_key(key)?;
        let start = index;
        while index < lines.len() {
            let next = lines[index];
            if !next.trim().is_empty() && !next.starts_with(char::is_whitespace) {
                break;
            }
            index += 1;
        }
        entry(&key, rest, &lines[start..index])?;
    }
    Ok(())
}

/// The scalar entries of the frontmatter's `metadata:` block mapping, which the Agent Skills spec
/// defines as string keys to string values. Its entries are read like top-level keys. Empty when
/// there is no `metadata:` key or it holds no block mapping (a flow mapping, a list, a scalar).
fn frontmatter_metadata(content: &str) -> Result<BTreeMap<String, String>, String> {
    let lines = frontmatter_lines(content)?;
    let mut block: Option<Vec<&str>> = None;
    read_mapping(&lines, |key, rest, continuation| {
        if key == "metadata" && (rest.is_empty() || rest.starts_with('#')) {
            block = Some(continuation.to_vec());
        }
        Ok(())
    })?;
    let Some(block) = block else {
        return Ok(BTreeMap::new());
    };
    let indent = block
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    let dedented: Vec<&str> = block
        .iter()
        .map(|line| line.get(indent..).unwrap_or(""))
        .collect();
    scalar_fields(&dedented).map_err(|e| format!("metadata: {e}"))
}

/// Keys Riggverk reads that the Agent Skills spec keeps under `metadata:`. Bundled skills set them
/// there; older packs and personal skills set them at the top level, and both layouts are read.
pub(crate) const RIGGVERK_METADATA_KEYS: [&str; 4] = ["category", "risk", "targets", "related"];

/// The frontmatter as the app reads a skill: the top-level keys of [`frontmatter_fields`], with
/// each of [`RIGGVERK_METADATA_KEYS`] taken from `metadata:` when it is set there and not empty.
/// So `metadata.<key>` wins over a top-level `<key>` in a file that has both. A `metadata:` block
/// that cannot be read is ignored (it was never read before), so the top-level keys still count.
pub(crate) fn skill_fields(content: &str) -> Result<BTreeMap<String, String>, String> {
    let mut fields = frontmatter_fields(content)?;
    let metadata = frontmatter_metadata(content).unwrap_or_default();
    for key in RIGGVERK_METADATA_KEYS {
        if let Some(value) = metadata.get(key).filter(|value| !value.is_empty()) {
            fields.insert(key.to_string(), value.clone());
        }
    }
    Ok(fields)
}

/// `key` and the rest of a `key: value` line; `None` for a line that is no mapping entry.
fn split_key(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    let (key, rest) = (&line[..colon], &line[colon + 1..]);
    if key.trim().is_empty() || !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
        return None;
    }
    Some((key.trim_end(), rest.trim()))
}

/// A quoted top-level key reads as its unquoted text (`"name": tdd` is the key `name`). Escapes in
/// a quoted key are rejected: a key must not be able to spell `name` indirectly.
fn unquote_key(key: &str) -> Result<String, String> {
    let Some(quote) = key.chars().next().filter(|c| *c == '"' || *c == '\'') else {
        return Ok(key.to_string());
    };
    let inner = key
        .strip_prefix(quote)
        .and_then(|inner| inner.strip_suffix(quote))
        .filter(|inner| key.len() >= 2 && !inner.contains([quote, '\\']))
        .ok_or_else(|| format!("unsupported quoted frontmatter key {key}"))?;
    Ok(inner.to_string())
}

fn scalar_value(rest: &str, continuation: &[&str]) -> Result<String, String> {
    let more = || {
        continuation
            .iter()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
    };
    if let Some(style) = rest.strip_prefix(['|', '>']) {
        let style = style.split(" #").next().unwrap_or("").trim();
        if !matches!(style, "" | "-") {
            return Err(format!("unsupported block scalar {rest:?}"));
        }
        let literal = rest.starts_with('|');
        return Ok(block_scalar(continuation, literal));
    }
    if let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let rest = match rest.ends_with(quote) {
            true => rest,
            false => rest.split(" #").next().unwrap_or("").trim_end(),
        };
        let inner = rest
            .strip_prefix(quote)
            .and_then(|inner| inner.strip_suffix(quote))
            .filter(|_| rest.len() >= 2 && more().next().is_none())
            .ok_or_else(|| "a quoted value must close on its own line".to_string())?;
        return Ok(if quote == '"' {
            inner.replace("\\\"", "\"").replace("\\\\", "\\")
        } else {
            inner.replace("''", "'")
        });
    }
    if rest.is_empty() {
        // A nested mapping or list, or nothing at all: no scalar.
        return Ok(String::new());
    }
    let plain = |text: &str| text.split(" #").next().unwrap_or("").trim().to_string();
    let mut value = plain(rest);
    for line in more() {
        value.push(' ');
        value.push_str(&plain(line));
    }
    Ok(value)
}

/// A `|` (lines kept) or `>` (lines folded into one) block scalar, trailing newlines stripped.
fn block_scalar(lines: &[&str], literal: bool) -> String {
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    let body: Vec<&str> = lines
        .iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end())
        .collect();
    let text = if literal {
        body.join("\n")
    } else {
        let mut folded = String::new();
        for line in body {
            if line.is_empty() {
                folded.push('\n');
            } else {
                if !folded.is_empty() && !folded.ends_with('\n') {
                    folded.push(' ');
                }
                folded.push_str(line);
            }
        }
        folded
    };
    text.trim().to_string()
}

fn extract_frontmatter_list(fields: &BTreeMap<String, String>, key: &str) -> Vec<String> {
    let raw = fields.get(key).cloned().unwrap_or_default();
    if raw.is_empty() {
        return Vec::new();
    }
    // Support comma-separated: targets: codex, opencode, claude, cursor
    // Also support bracket lists: targets: [codex, opencode]
    let trimmed = raw.trim();
    let inner = if trimmed.starts_with('[') && trimmed.ends_with(']') {
        trimmed.trim_start_matches('[').trim_end_matches(']').trim()
    } else {
        trimmed
    };
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Largest `SKILL.md` read for its metadata.
pub(crate) const MAX_SKILL_MD_BYTES: u64 = 1024 * 1024;

/// The text of a `SKILL.md`, refusing one over [`MAX_SKILL_MD_BYTES`].
/// Unicode tag characters and bidi overrides or isolates: they can hide or reorder an instruction
/// so that it reads differently in a review than to an agent.
pub(crate) fn hides_or_reorders_text(c: char) -> bool {
    let code = u32::from(c);
    (0xE0000..=0xE007F).contains(&code)
        || (0x202A..=0x202E).contains(&code)
        || (0x2066..=0x2069).contains(&code)
}

pub(crate) fn read_skill_md_capped(skill_md: &Path) -> Result<String, String> {
    use std::io::Read;
    let file =
        fs::File::open(skill_md).map_err(|e| format!("cannot read {}: {e}", skill_md.display()))?;
    let mut content = String::new();
    file.take(MAX_SKILL_MD_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| format!("cannot read {}: {e}", skill_md.display()))?;
    if content.len() as u64 > MAX_SKILL_MD_BYTES {
        return Err(format!(
            "SKILL.md is over {MAX_SKILL_MD_BYTES} bytes: {}",
            skill_md.display()
        ));
    }
    Ok(content)
}

/// The `name` a `SKILL.md` declares, when it can be read at all (a skill that fails validation
/// still has a name worth keeping).
pub(crate) fn declared_skill_name(skill_md: &Path) -> Option<String> {
    let fields = frontmatter_fields(&read_skill_md_capped(skill_md).ok()?).ok()?;
    fields.get("name").filter(|name| !name.is_empty()).cloned()
}

/// Why the text of a `SKILL.md` would not load as the skill `name` (in the folder `folder`), in
/// words for the editor; `Ok` when it would. A save that breaks the skill is refused with this,
/// since a skill that does not load can no longer be edited in the app.
pub(crate) fn check_skill_text(content: &str, name: &str, folder: &str) -> Result<(), String> {
    let fields =
        skill_fields(content).map_err(|e| format!("The frontmatter cannot be read: {e}."))?;
    let declared = fields
        .get("name")
        .filter(|declared| !declared.is_empty())
        .map_or(folder, String::as_str);
    if declared != name {
        return Err(format!("The name in the frontmatter must stay {name}."));
    }
    if fields.get("description").is_none_or(String::is_empty) {
        return Err("The description in the frontmatter cannot be empty.".to_string());
    }
    // A pack skill without `targets` is for every harness; a target it names must exist.
    let targets = extract_frontmatter_list(&fields, "targets");
    if targets
        .iter()
        .any(|target| !VALID_SKILL_AGENTS.contains(&target.as_str()))
    {
        return Err(format!(
            "The targets in the frontmatter must list harnesses from: {}.",
            VALID_SKILL_AGENTS.join(", ")
        ));
    }
    Ok(())
}

/// Top-level `SKILL.md` keys a harness acts on by itself once the skill runs, with what the two
/// that act without asking do. Claude Code lets the tools in `allowed-tools` run without a
/// permission prompt while the skill is active and registers the commands in `hooks` for the
/// session; `context`, `agent`, `background` and `model` change where and how the skill runs.
/// A pack skill is copied byte for byte, so these are shown before Install, never refused.
pub(crate) const PRIVILEGED_SKILL_KEYS: [(&str, &str); 6] = [
    ("allowed-tools", "grants tool access without asking"),
    ("hooks", "runs commands without asking"),
    ("context", ""),
    ("agent", ""),
    ("background", ""),
    ("model", ""),
];

/// One of [`PRIVILEGED_SKILL_KEYS`] set in a `SKILL.md`. Config, not a secret: shown as written.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PrivilegedKey {
    pub key: String,
    /// The value as written, nested lines included, with each run of whitespace made one space.
    pub value: String,
    /// What it grants in plain words; empty for a key that grants nothing by itself.
    pub note: String,
}

/// The [`PRIVILEGED_SKILL_KEYS`] a `SKILL.md` text sets at the top level of its frontmatter, in
/// file order, then its `!` command lines under [`SHELL_COMMAND_KEY`]. Empty when the frontmatter
/// cannot be read: such a skill does not load at all.
pub(crate) fn privileged_keys(content: &str) -> Vec<PrivilegedKey> {
    let Ok(lines) = frontmatter_lines(content) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let _ = read_mapping(&lines, |key, rest, continuation| {
        if let Some((key, note)) = PRIVILEGED_SKILL_KEYS
            .iter()
            .find(|(privileged, _)| *privileged == key)
        {
            let value = std::iter::once(rest)
                .chain(continuation.iter().copied())
                .flat_map(str::split_whitespace)
                .collect::<Vec<_>>()
                .join(" ");
            found.push(PrivilegedKey {
                key: key.to_string(),
                value,
                note: note.to_string(),
            });
        }
        Ok(())
    });
    let commands = shell_command_lines(content);
    if !commands.is_empty() {
        found.push(PrivilegedKey {
            key: SHELL_COMMAND_KEY.to_string(),
            value: commands.join("; "),
            note: "runs shell commands when the skill loads".to_string(),
        });
    }
    found
}

/// The entry [`privileged_keys`] adds for `!` commands in the body, under this key. Claude Code runs
/// `` !`command` `` (and a ```` ```! ```` block) as a shell command when the skill loads, before the
/// model sees the text, so a pack skill that has one is flagged like a key that acts without asking.
pub(crate) const SHELL_COMMAND_KEY: &str = "!";

/// The body lines (after the frontmatter) that hold a `!` command, as `line N: text`, whitespace
/// collapsed. Inline code that only mentions the syntax counts too: a flag too many is harmless.
fn shell_command_lines(content: &str) -> Vec<String> {
    let mut closed = false;
    let mut found = Vec::new();
    for (index, line) in content.lines().enumerate() {
        if index == 0 {
            continue;
        }
        if !closed {
            closed = line.trim_end() == "---";
            continue;
        }
        if line.contains("!`") || is_command_fence(line) {
            let text = line.split_whitespace().collect::<Vec<_>>().join(" ");
            found.push(format!("line {}: {text}", index + 1));
        }
    }
    found
}

/// Whether `line` opens a fence of three or more backticks or tildes with `!` right after it:
/// a ```` ```! ```` block, and the longer and tilde forms Markdown reads as the same fence.
fn is_command_fence(line: &str) -> bool {
    let line = line.trim_start();
    ['`', '~'].into_iter().any(|mark| {
        let rest = line.trim_start_matches(mark);
        line.len() - rest.len() >= 3 && rest.starts_with('!')
    })
}

/// [`privileged_keys`] of the `SKILL.md` at `skill_md`; empty when it cannot be read.
pub(crate) fn read_privileged_keys(skill_md: &Path) -> Vec<PrivilegedKey> {
    read_skill_md_capped(skill_md)
        .map(|content| privileged_keys(&content))
        .unwrap_or_default()
}

pub(crate) fn read_skill_metadata(
    skill_md: &Path,
    fallback_name: &str,
) -> Result<(String, String, Vec<String>), String> {
    let content = read_skill_md_capped(skill_md)?;
    let fields = skill_fields(&content)
        .map_err(|e| format!("invalid frontmatter in {}: {e}", skill_md.display()))?;
    let name = fields.get("name").cloned().unwrap_or_default();
    let description = fields.get("description").cloned().unwrap_or_default();
    let targets = extract_frontmatter_list(&fields, "targets");
    let name = if name.is_empty() {
        fallback_name.to_string()
    } else {
        name
    };
    if name.is_empty() {
        return Err(format!("skill name is empty in {}", skill_md.display()));
    }
    if description.is_empty() {
        return Err(format!(
            "skill description is empty in {}",
            skill_md.display()
        ));
    }
    Ok((name, description, targets))
}

fn register_skill(
    discovered: &mut Vec<DiscoveredSkill>,
    workspace_root: &Path,
    skill_dir: &Path,
    skill_md: &Path,
    fallback_name: &str,
    group: &str,
) -> Result<(), String> {
    reject_symlink(skill_dir, "skill directory")?;
    reject_symlink(skill_md, "skill file")?;
    if !skill_md.is_file() {
        return Ok(());
    }
    let (name, description, targets) = read_skill_metadata(skill_md, fallback_name)?;
    if discovered.iter().any(|s| s.name == name) {
        return Err(format!("duplicate skill name in repository: {name}"));
    }
    let relative_path = skill_md
        .strip_prefix(workspace_root)
        .unwrap_or(skill_md)
        .to_string_lossy()
        .replace('\\', "/");
    discovered.push(DiscoveredSkill {
        name,
        description,
        targets,
        group: group.to_string(),
        source_dir: skill_dir.to_path_buf(),
        skill_md_path: skill_md.to_path_buf(),
        relative_path,
    });
    Ok(())
}

/// Discover the full skill catalog under `workspace_root/skills`.
///
/// Returns `Err` on missing root, unreadable entries, invalid metadata, or
/// duplicate names. Never returns an empty `Ok` after a parsing failure.
pub fn discover_skill_catalog(
    workspace_root: &Path,
) -> Result<Vec<DiscoveredSkill>, SkillDiscoveryError> {
    let skills_dir = workspace_root.join("skills");
    if !skills_dir.is_dir() {
        return Err(SkillDiscoveryError::MissingRoot(format!(
            "skills directory not found: {}",
            skills_dir.display()
        )));
    }
    if let Err(e) = reject_symlink(&skills_dir, "skills root") {
        return Err(SkillDiscoveryError::InvalidCatalog(e));
    }

    let mut discovered: Vec<DiscoveredSkill> = Vec::new();
    let entries = fs::read_dir(&skills_dir)
        .map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("cannot read skills dir: {e}")))?;

    for entry in entries {
        let entry =
            entry.map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("read error: {e}")))?;
        let file_type = entry
            .file_type()
            .map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("file type error: {e}")))?;
        if file_type.is_symlink() {
            return Err(SkillDiscoveryError::InvalidCatalog(format!(
                "refusing symlink skill directory: {}",
                entry.path().display()
            )));
        }
        if !file_type.is_dir() {
            continue;
        }

        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let root_skill_md = entry_path.join("SKILL.md");
        if root_skill_md.is_file() {
            if has_deeper_skill_md(&entry_path) {
                return Err(SkillDiscoveryError::InvalidCatalog(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    entry_path.display()
                )));
            }
            register_skill(
                &mut discovered,
                workspace_root,
                &entry_path,
                &root_skill_md,
                &entry_name,
                "",
            )
            .map_err(SkillDiscoveryError::InvalidCatalog)?;
            continue;
        }

        let sub_entries = fs::read_dir(&entry_path).map_err(|e| {
            SkillDiscoveryError::InvalidCatalog(format!("cannot read skills group dir: {e}"))
        })?;
        for sub in sub_entries {
            let sub =
                sub.map_err(|e| SkillDiscoveryError::InvalidCatalog(format!("read error: {e}")))?;
            let sub_type = sub.file_type().map_err(|e| {
                SkillDiscoveryError::InvalidCatalog(format!("file type error: {e}"))
            })?;
            if sub_type.is_symlink() {
                return Err(SkillDiscoveryError::InvalidCatalog(format!(
                    "refusing symlink skill directory: {}",
                    sub.path().display()
                )));
            }
            if !sub_type.is_dir() {
                continue;
            }
            let sub_path = sub.path();
            let sub_name = sub.file_name().to_string_lossy().into_owned();
            let grouped_skill_md = sub_path.join("SKILL.md");
            if grouped_skill_md.is_file() {
                register_skill(
                    &mut discovered,
                    workspace_root,
                    &sub_path,
                    &grouped_skill_md,
                    &sub_name,
                    &entry_name,
                )
                .map_err(SkillDiscoveryError::InvalidCatalog)?;
            } else if has_deeper_skill_md(&sub_path) {
                return Err(SkillDiscoveryError::InvalidCatalog(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    sub_path.display()
                )));
            }
        }
    }

    discovered.sort_by(|a, b| match a.group.cmp(&b.group) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });

    if discovered.is_empty() {
        return Err(SkillDiscoveryError::InvalidCatalog(format!(
            "no skills found in {}",
            skills_dir.display()
        )));
    }

    validate_skill_targets(&discovered).map_err(SkillDiscoveryError::InvalidCatalog)?;

    Ok(discovered)
}

/// Most supporting files one skill may carry.
pub const MAX_SUPPORT_FILES: usize = 64;
/// Most bytes all supporting files of one skill may add up to.
pub const MAX_SUPPORT_TOTAL_BYTES: u64 = 2 * 1024 * 1024;
/// Largest single supporting file.
pub const MAX_SUPPORT_FILE_BYTES: u64 = 1024 * 1024;
/// Most path components of a supporting file below the skill directory (`assets/a/b/c.txt`).
pub const MAX_SUPPORT_DEPTH: usize = 4;

/// Supporting files installed beside the `SKILL.md` of the skill in `skill_dir`: the regular
/// files below it, as `/`-separated paths relative to the directory, sorted.
///
/// Dot entries are skipped. A symlink, any other non-regular entry, a nested `SKILL.md`, a name
/// the installer cannot represent, or a skill over the limits above is an error: a bundled skill
/// that breaks them is a packaging mistake, and nothing of it is installed.
pub fn skill_support_files(skill_dir: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    scan_support_dir(skill_dir, "", 1, &mut files, &mut total_bytes)?;
    files.sort();
    refuse_case_collisions(&files)?;
    Ok(files)
}

/// Two supporting files whose paths differ only in case are one file on a case-insensitive volume
/// (APFS by default), so a skill that has them (from a case-sensitive one) cannot be installed.
fn refuse_case_collisions(files: &[String]) -> Result<(), String> {
    let mut folded = HashSet::new();
    for file in files {
        if !folded.insert(file.to_ascii_lowercase()) {
            return Err(format!(
                "supporting files whose names differ only in case cannot be installed side by side: {file}"
            ));
        }
    }
    Ok(())
}

fn scan_support_dir(
    dir: &Path,
    prefix: &str,
    depth: usize,
    files: &mut Vec<String>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read error in {}: {e}", dir.display()))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| format!("non-UTF-8 file name in {}", dir.display()))?;
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if depth > MAX_SUPPORT_DEPTH {
            return Err(format!(
                "supporting file nested deeper than {MAX_SUPPORT_DEPTH} levels: {}",
                path.display()
            ));
        }
        let rel = format!("{prefix}{name}");
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file type error for {}: {e}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!("refusing symlink in skill: {}", path.display()));
        }
        if file_type.is_dir() {
            scan_support_dir(&path, &format!("{rel}/"), depth + 1, files, total_bytes)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(format!(
                "refusing non-regular file in skill: {}",
                path.display()
            ));
        }
        if name.eq_ignore_ascii_case("SKILL.md") {
            if depth == 1 {
                continue;
            }
            return Err(format!("nested SKILL.md in skill: {}", path.display()));
        }
        let len = entry
            .metadata()
            .map_err(|e| format!("cannot inspect {}: {e}", path.display()))?
            .len();
        if len > MAX_SUPPORT_FILE_BYTES {
            return Err(format!(
                "supporting file over {MAX_SUPPORT_FILE_BYTES} bytes: {}",
                path.display()
            ));
        }
        *total_bytes += len;
        if files.len() >= MAX_SUPPORT_FILES || *total_bytes > MAX_SUPPORT_TOTAL_BYTES {
            return Err(format!(
                "skill has more than {MAX_SUPPORT_FILES} supporting files or {MAX_SUPPORT_TOTAL_BYTES} bytes: {}",
                dir.display()
            ));
        }
        files.push(rel);
    }
    Ok(())
}

/// Path of the canonical `SKILL.md` of the skill called `name`, the one install source every
/// harness copies byte for byte.
///
/// Looked up through the catalog, so root-level and grouped skills resolve alike. A name the
/// catalog does not hold (a retired skill, or a catalog that fails validation) resolves to the
/// root-level location, which callers then find missing instead of having no path to check.
pub fn canonical_skill_md(workspace_root: &Path, name: &str) -> PathBuf {
    discover_skill_catalog(workspace_root)
        .ok()
        .and_then(|catalog| catalog.into_iter().find(|skill| skill.name == name))
        .map(|skill| skill.skill_md_path)
        .unwrap_or_else(|| workspace_root.join("skills").join(name).join("SKILL.md"))
}

/// Directory of the skill called `name`, the install source of its supporting files.
///
/// Found with stat calls only (`skills/<name>`, then `skills/<group>/<name>`), because it is
/// asked for once per supporting file. A name nothing holds resolves to the root-level location,
/// which callers then find missing.
pub fn canonical_skill_dir(workspace_root: &Path, name: &str) -> PathBuf {
    let skills = workspace_root.join("skills");
    let root_level = skills.join(name);
    if root_level.join("SKILL.md").is_file() {
        return root_level;
    }
    if let Ok(entries) = fs::read_dir(&skills) {
        for entry in entries.flatten() {
            let grouped = entry.path().join(name);
            if grouped.join("SKILL.md").is_file() {
                return grouped;
            }
        }
    }
    root_level
}

/// Require every skill to declare at least one known harness target.
pub fn validate_skill_targets(catalog: &[DiscoveredSkill]) -> Result<(), String> {
    let allowed: HashSet<&str> = VALID_SKILL_AGENTS.iter().copied().collect();
    for skill in catalog {
        if skill.targets.is_empty() {
            return Err(format!("skill '{}' has no targets", skill.name));
        }
        for target in &skill.targets {
            if !allowed.contains(target.as_str()) {
                return Err(format!(
                    "skill '{}' has unknown target '{target}'",
                    skill.name
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn privileged_keys_are_listed_with_their_values_as_written() {
        let text = [
            "---",
            "name: demo",
            "description: Use for any release question.",
            "targets: [claude]",
            "allowed-tools: Bash(touch *)",
            "hooks:",
            "  PreToolUse:",
            "    - matcher: \"Bash\"",
            "      hooks:",
            "        - type: command",
            "          command: \"touch \\\"$HOME/marker\\\"\"",
            "metadata:",
            "  model: not-top-level",
            "\"context\": fork",
            "---",
            "# Demo",
            "allowed-tools: in the body",
        ]
        .join("\n");
        let keys = privileged_keys(&text);
        let pairs: Vec<_> = keys
            .iter()
            .map(|key| (key.key.as_str(), key.value.as_str(), key.note.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                (
                    "allowed-tools",
                    "Bash(touch *)",
                    "grants tool access without asking"
                ),
                (
                    "hooks",
                    "PreToolUse: - matcher: \"Bash\" hooks: - type: command command: \"touch \\\"$HOME/marker\\\"\"",
                    "runs commands without asking"
                ),
                ("context", "fork", ""),
            ]
        );
    }

    #[test]
    fn shell_command_lines_of_the_body_are_listed_under_the_bang_key() {
        let text = [
            "---",
            "name: demo",
            "description: \"Says !`not-the-body` here\"",
            "---",
            "# Demo",
            "Branch:   !`git branch --show-current`",
            "```!",
            "ls -la",
            "```",
            "No command here!",
        ]
        .join("\n");
        assert_eq!(
            privileged_keys(&text),
            [PrivilegedKey {
                key: SHELL_COMMAND_KEY.to_string(),
                value: "line 6: Branch: !`git branch --show-current`; line 7: ```!".to_string(),
                note: "runs shell commands when the skill loads".to_string(),
            }]
        );
    }

    #[test]
    fn longer_and_tilde_command_fences_are_listed_too() {
        let text = "---\nname: demo\ndescription: d\n---\n````!\nls\n````\n  ~~~!\n``!\n~~!\n";
        assert_eq!(
            privileged_keys(text)[0].value,
            "line 5: ````!; line 8: ~~~!"
        );
    }

    /// A key a YAML parser reads but this line reader would skip makes the frontmatter unreadable,
    /// so `allowed-tools` or `hooks` cannot be set without being listed: the skill does not load.
    #[test]
    fn frontmatter_a_yaml_parser_could_read_differently_is_refused() {
        for (spelling, rest) in [
            ("explicit key", "\n? allowed-tools\n: Bash(*)\n"),
            ("tagged key", "\n!!str allowed-tools: Bash(*)\n"),
            ("lone carriage return", "\rallowed-tools: Bash(*)\n"),
            ("merge key", "\nbase: &a\n  hooks: {}\n<<: *a\n"),
            ("anchored key", "\n&a allowed-tools: Bash(*)\n"),
            ("flow mapping", "\n{allowed-tools: Bash(*)}\n"),
            ("byte order mark", "\n\u{FEFF}allowed-tools: Bash(*)\n"),
            ("control character", "\u{1}\n"),
            ("line separator", "\u{2028}allowed-tools: Bash(*)\n"),
        ] {
            let text = format!("---\nname: demo\ndescription: d{rest}---\n# Demo\n");
            assert!(frontmatter_fields(&text).is_err(), "{spelling}");
            assert!(
                check_skill_text(&text, "demo", "demo").is_err(),
                "{spelling}"
            );
        }
        // In the body, a lone carriage return could hide a ```! line from the `!` detector.
        assert!(frontmatter_fields("---\nname: demo\ndescription: d\n---\nok\r```!\n").is_err());
        let plain = "---\r\n# comment\r\nname: demo\r\n\r\ndescription: d\r\nallowed-tools:\r\n- Bash\r\n---\r\n\tbody\r\n";
        assert_eq!(field(plain, "name").unwrap(), "demo");
        assert_eq!(privileged_keys(plain)[0].key, "allowed-tools");
    }

    #[test]
    fn a_skill_without_privileged_keys_or_frontmatter_lists_none() {
        assert!(
            privileged_keys("---\nname: a\ndescription: b\n---\nallowed-tools: x\n").is_empty()
        );
        assert!(privileged_keys("allowed-tools: Bash\n").is_empty());
        assert!(privileged_keys("---\nallowed-tools: Bash\n").is_empty());
    }

    fn validate_bundled_catalog_all_targets(catalog: &[DiscoveredSkill]) -> Result<(), String> {
        let expected: HashSet<&str> = VALID_SKILL_AGENTS.iter().copied().collect();
        for skill in catalog {
            let actual: HashSet<&str> = skill.targets.iter().map(|s| s.as_str()).collect();
            if actual != expected {
                return Err(format!(
                    "skill '{}' targets {:?}; expected exactly {:?}",
                    skill.name, skill.targets, VALID_SKILL_AGENTS
                ));
            }
        }
        Ok(())
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-skill-disc-{name}-{nonce}"))
    }

    fn write_skill(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    const ALL_TARGETS: &str = "codex, opencode, claude, cursor";

    fn skill_body(name: &str, targets: &str) -> String {
        format!("---\nname: {name}\ndescription: test skill\ntargets: {targets}\n---\n# {name}\n")
    }

    #[test]
    fn root_level_skill_discovered() {
        let root = temp_root("root");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", ALL_TARGETS),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "diagnose");
        assert_eq!(catalog[0].group, "");
        assert!(catalog[0].skill_md_path.ends_with("SKILL.md"));
    }

    #[test]
    fn grouped_skill_discovered() {
        let root = temp_root("grouped");
        write_skill(
            &root,
            "skills/domain/domain-change",
            &skill_body("domain-change", ALL_TARGETS),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let dir = canonical_skill_dir(&root, "domain-change");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "domain-change");
        assert_eq!(catalog[0].group, "domain");
        assert_eq!(dir, root.join("skills/domain/domain-change"));
    }

    #[test]
    fn comma_separated_targets_parsed() {
        let root = temp_root("comma");
        write_skill(
            &root,
            "skills/security-review",
            &skill_body("security-review", "codex,  opencode , claude,cursor"),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(
            catalog[0].targets,
            vec!["codex", "opencode", "claude", "cursor"]
        );
    }

    #[test]
    fn every_harness_target_required_for_bundled_catalog() {
        let root = temp_root("every");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", &VALID_SKILL_AGENTS.join(", ")),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        validate_bundled_catalog_all_targets(&catalog).expect("bundled targets");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn partial_targets_allowed_in_discovery() {
        let root = temp_root("missing-target");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", "codex, opencode, claude"),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        let diagnose = catalog
            .iter()
            .find(|s| s.name == "diagnose")
            .expect("diagnose");
        assert_eq!(diagnose.targets, vec!["codex", "opencode", "claude"]);
    }

    #[test]
    fn unknown_target_fails_discovery() {
        let root = temp_root("unknown-target");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", "codex, opencode, claude, cursor, gemini"),
        );
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("unknown target"));
    }

    #[test]
    fn duplicate_name_fails() {
        let root = temp_root("dup");
        write_skill(&root, "skills/a/foo", &skill_body("same-name", ALL_TARGETS));
        write_skill(&root, "skills/b/foo", &skill_body("same-name", ALL_TARGETS));
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("duplicate skill name"));
    }

    #[test]
    fn deep_nesting_rejected() {
        let root = temp_root("deep");
        write_skill(
            &root,
            "skills/group/nested/skill",
            &skill_body("deep-skill", ALL_TARGETS),
        );
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("deeper than one group level"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_group_rejected() {
        let root = temp_root("sym-group");
        let real = root.join("skills/real-group/real-skill");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        write_skill(
            &root,
            "skills/real-group/real-skill",
            &skill_body("real-skill", ALL_TARGETS),
        );
        let link = root.join("skills/link-group");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("skills/real-group"), &link).unwrap();
            let err = discover_skill_catalog(&root).unwrap_err();
            assert!(err.message().contains("symlink"));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_skill_rejected() {
        let root = temp_root("sym-skill");
        let real = root.join("skills/real-skill");
        fs::create_dir_all(&real).unwrap();
        write_skill(
            &root,
            "skills/real-skill",
            &skill_body("real-skill", ALL_TARGETS),
        );
        let link = root.join("skills/link-skill");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let err = discover_skill_catalog(&root).unwrap_err();
            assert!(err.message().contains("symlink"));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_frontmatter_rejected() {
        let root = temp_root("bad-fm");
        write_skill(&root, "skills/bad", "no frontmatter here\n");
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(err.message().contains("frontmatter"));
    }

    fn field(content: &str, key: &str) -> Result<String, String> {
        frontmatter_fields(content).map(|fields| fields.get(key).cloned().unwrap_or_default())
    }

    #[test]
    fn only_top_level_frontmatter_keys_count() {
        let nested =
            "---\ndescription: d\nmetadata:\n  name: nested-helper\nname: tdd\n---\nname: body\n";
        assert_eq!(field(nested, "name").unwrap(), "tdd");
        assert_eq!(field(nested, "metadata").unwrap(), "");
        let body_only = "---\ndescription: d\n---\nname: from-the-body\n";
        assert_eq!(field(body_only, "name").unwrap(), "");
        let crlf = "---\r\nname: crlf\r\ndescription: d\r\n---\r\n";
        assert_eq!(field(crlf, "name").unwrap(), "crlf");
    }

    #[test]
    fn quoted_frontmatter_values_lose_their_quotes() {
        assert_eq!(
            field("---\nname: \"quoted\"\n---\n", "name").unwrap(),
            "quoted"
        );
        assert_eq!(
            field("---\nname: 'single'\n---\n", "name").unwrap(),
            "single"
        );
        assert_eq!(
            field(
                "---\ndescription: 'it''s \"fine\"' # note\n---\n",
                "description"
            )
            .unwrap(),
            "it's \"fine\""
        );
        assert_eq!(
            field("---\nname: plain # a comment\n---\n", "name").unwrap(),
            "plain"
        );
        assert!(field("---\nname: \"open\n---\n", "name").is_err());
    }

    #[test]
    fn quoted_frontmatter_keys_lose_their_quotes() {
        assert_eq!(
            field("---\n\"name\": tdd\ndescription: d\n---\n", "name").unwrap(),
            "tdd"
        );
        assert_eq!(
            field("---\n'name': tdd\ndescription: d\n---\n", "name").unwrap(),
            "tdd"
        );
        // A quoted key repeating a plain key is still a duplicate.
        assert!(field("---\nname: a\n\"name\": b\n---\n", "name").is_err());
        // Escapes could spell `name` indirectly.
        assert!(field("---\n\"na\\u006de\": tdd\n---\n", "name").is_err());
    }

    #[test]
    fn block_scalar_descriptions_are_read() {
        let folded =
            "---\ndescription: >-\n  the real description\n  continues\n\n  here\nname: x\n---\n";
        assert_eq!(
            field(folded, "description").unwrap(),
            "the real description continues\nhere"
        );
        assert_eq!(field(folded, "name").unwrap(), "x");
        let folded_clip = "---\ndescription: >\n  one\n  two\n---\n";
        assert_eq!(field(folded_clip, "description").unwrap(), "one two");
        let literal = "---\ndescription: |-\n  line one\n  line two\n---\n";
        assert_eq!(field(literal, "description").unwrap(), "line one\nline two");
        let literal_clip = "---\ndescription: |\n  only\n---\n";
        assert_eq!(field(literal_clip, "description").unwrap(), "only");
        let plain = "---\ndescription: a plain value\n  that continues\n---\n";
        assert_eq!(
            field(plain, "description").unwrap(),
            "a plain value that continues"
        );
        assert!(field("---\ndescription: |+2\n  x\n---\n", "description").is_err());
    }

    const LEGACY_LAYOUT: &str = "---\nname: tdd\ndescription: d\ncategory: testing\nrisk: low\ntargets: codex, claude\nrelated: diagnose\n---\n# tdd\n";
    const SPEC_LAYOUT: &str = "---\nname: tdd\ndescription: d\nlicense: MIT\nmetadata:\n  category: testing\n  risk: low\n  targets: codex, claude\n  related: diagnose\n---\n# tdd\n";
    const MIXED_LAYOUT: &str = "---\nname: tdd\ndescription: d\ncategory: testing\nrisk: low\nmetadata:\n  targets: codex, claude\n  related: diagnose\n---\n# tdd\n";

    fn riggverk_keys(content: &str) -> Vec<(String, String)> {
        let fields = skill_fields(content).expect("fields");
        RIGGVERK_METADATA_KEYS
            .iter()
            .map(|key| {
                (
                    key.to_string(),
                    fields.get(*key).cloned().unwrap_or_default(),
                )
            })
            .collect()
    }

    #[test]
    fn legacy_spec_and_mixed_metadata_layouts_read_the_same() {
        let legacy = riggverk_keys(LEGACY_LAYOUT);
        assert_eq!(
            legacy,
            vec![
                ("category".to_string(), "testing".to_string()),
                ("risk".to_string(), "low".to_string()),
                ("targets".to_string(), "codex, claude".to_string()),
                ("related".to_string(), "diagnose".to_string()),
            ]
        );
        assert_eq!(riggverk_keys(SPEC_LAYOUT), legacy);
        assert_eq!(riggverk_keys(MIXED_LAYOUT), legacy);
        for content in [LEGACY_LAYOUT, SPEC_LAYOUT, MIXED_LAYOUT] {
            check_skill_text(content, "tdd", "tdd").expect("valid in every layout");
            let root = temp_root("layouts");
            write_skill(&root, "skills/tdd", content);
            let catalog = discover_skill_catalog(&root).expect("discover");
            let _ = fs::remove_dir_all(&root);
            assert_eq!(catalog[0].targets, vec!["codex", "claude"]);
        }
    }

    #[test]
    fn metadata_wins_over_a_top_level_key_and_only_for_the_riggverk_keys() {
        let both = "---\nname: tdd\ndescription: top\nrisk: high\ntargets: codex\nmetadata:\n  name: other\n  description: nested\n  risk: low\n  targets: claude, pi\n  category: \n---\n";
        let fields = skill_fields(both).expect("fields");
        assert_eq!(fields["name"], "tdd");
        assert_eq!(fields["description"], "top");
        assert_eq!(fields["risk"], "low");
        assert_eq!(fields["targets"], "claude, pi");
        assert!(
            !fields.contains_key("category"),
            "an empty metadata value adds nothing"
        );
        // The top-level reader is unchanged: the nested block is not a scalar.
        assert_eq!(field(both, "metadata").unwrap(), "");
        assert_eq!(field(both, "targets").unwrap(), "codex");
    }

    #[test]
    fn a_metadata_block_that_cannot_be_read_falls_back_to_the_top_level_keys() {
        for metadata in [
            "metadata:\n  targets: claude\n  targets: pi\n",
            "metadata: {targets: pi}\n",
            "metadata:\n  - targets\n",
        ] {
            let content = format!("---\nname: x\ndescription: d\ntargets: codex\n{metadata}---\n");
            assert_eq!(
                skill_fields(&content).expect("fields")["targets"],
                "codex",
                "{metadata}"
            );
        }
        let quoted = "---\nname: x\ndescription: d\nmetadata:\n  # a comment\n  'targets': \"codex, grok\"\n  risk: >-\n    folded\n    risk\n---\n";
        let fields = skill_fields(quoted).expect("fields");
        assert_eq!(fields["targets"], "codex, grok");
        assert_eq!(fields["risk"], "folded risk");
    }

    #[test]
    fn every_harness_is_a_valid_target() {
        let all = VALID_SKILL_AGENTS.join(", ");
        check_skill_text(&skill_body("x", &all), "x", "x").expect("every harness");
        let err = check_skill_text(&skill_body("x", "gemini"), "x", "x").unwrap_err();
        assert!(err.starts_with("The targets in the frontmatter"), "{err}");
    }

    #[test]
    fn a_duplicate_top_level_name_is_refused() {
        let err = field("---\nname: a\ndescription: d\nname: b\n---\n", "name").unwrap_err();
        assert!(
            err.contains("name") && err.contains("more than once"),
            "{err}"
        );
        let root = temp_root("dup-key");
        write_skill(
            &root,
            "skills/twice",
            "---\nname: twice\ndescription: d\ntargets: claude\nname: other\n---\n",
        );
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(
            err.message().contains("more than once"),
            "{}",
            err.message()
        );
    }

    #[test]
    fn a_closing_delimiter_must_be_its_own_line() {
        assert!(field("---\nname: a---b\n", "name").is_err());
        assert_eq!(
            field("---\nname: a---b\ndescription: x --- y\n---\n", "name").unwrap(),
            "a---b"
        );
    }

    #[test]
    fn the_nesting_walk_skips_dot_folders_and_is_bounded_in_total() {
        let root = temp_root("deeper-walk");
        fs::create_dir_all(root.join(".archive/old")).unwrap();
        fs::write(root.join(".archive/old/SKILL.md"), "x").unwrap();
        assert!(!has_deeper_skill_md(&root));
        fs::create_dir_all(root.join("docs/nested")).unwrap();
        fs::write(root.join("docs/nested/SKILL.md"), "x").unwrap();
        assert!(has_deeper_skill_md(&root));
        fs::remove_dir_all(root.join("docs")).unwrap();
        // Under the cap in every folder, over it in total.
        for folder in 0..3 {
            let dir = root.join(format!("d{folder}"));
            fs::create_dir_all(&dir).unwrap();
            for file in 0..4_000 {
                fs::write(dir.join(format!("f{file}")), "").unwrap();
            }
        }
        let bounded = has_deeper_skill_md(&root);
        let _ = fs::remove_dir_all(&root);
        assert!(bounded, "12 000 entries in total is over the cap");
    }

    #[test]
    fn missing_skills_root_is_error() {
        let root = temp_root("no-skills");
        let err = discover_skill_catalog(&root).unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(matches!(err, SkillDiscoveryError::MissingRoot(_)));
    }

    #[test]
    fn bundled_workspace_lists_every_skill() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let catalog = discover_skill_catalog(&repo).expect("bundled catalog");
        validate_bundled_catalog_all_targets(&catalog).expect("bundled targets");
        assert_eq!(catalog.len(), crate::test_env::source_skill_count());
    }

    // ── Supporting files ──

    fn support_fixture(label: &str) -> PathBuf {
        let root = temp_root(label);
        write_skill(&root, "skill", &skill_body("skill", ALL_TARGETS));
        root.join("skill")
    }

    fn write_support(dir: &Path, rel: &str, content: &[u8]) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn supporting_files_are_the_nested_regular_files_sorted_without_the_skill_md() {
        let dir = support_fixture("support-list");
        write_support(&dir, "HUNTING.md", b"a");
        write_support(&dir, "assets/report.html", b"b");
        write_support(&dir, "assets/img/logo.svg", b"c");
        write_support(&dir, "LICENSE", b"d");
        fs::create_dir_all(dir.join("empty")).unwrap();
        let files = skill_support_files(&dir);
        cleanup(&dir);
        assert_eq!(
            files.unwrap(),
            vec![
                "HUNTING.md",
                "LICENSE",
                "assets/img/logo.svg",
                "assets/report.html"
            ]
        );
    }

    #[test]
    fn dot_entries_are_not_supporting_files() {
        let dir = support_fixture("support-dot");
        write_support(&dir, ".DS_Store", b"x");
        write_support(&dir, ".hidden/file.md", b"x");
        write_support(&dir, "assets/.gitkeep", b"x");
        write_support(&dir, "assets/page.html", b"x");
        let files = skill_support_files(&dir);
        cleanup(&dir);
        assert_eq!(files.unwrap(), vec!["assets/page.html"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_a_skill_is_an_error() {
        let dir = support_fixture("support-symlink");
        write_support(&dir, "real.md", b"x");
        std::os::unix::fs::symlink(dir.join("real.md"), dir.join("link.md")).unwrap();
        let err = skill_support_files(&dir).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        fs::remove_file(dir.join("link.md")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();
        let err = skill_support_files(&dir).unwrap_err();
        cleanup(&dir);
        assert!(err.contains("symlink"), "{err}");
    }

    #[test]
    fn supporting_files_that_differ_only_in_case_are_an_error() {
        let dir = support_fixture("support-case");
        write_support(&dir, "Notes.md", b"a");
        write_support(&dir, "notes.md", b"b");
        let both_exist = fs::read_dir(&dir).unwrap().count() == 3;
        let result = skill_support_files(&dir);
        cleanup(&dir);
        if both_exist {
            let err = result.unwrap_err();
            assert!(err.contains("differ only in case"), "{err}");
        } else {
            // A case-insensitive volume holds one file: nothing collides.
            assert_eq!(result.unwrap().len(), 1);
        }
        let files = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let err = refuse_case_collisions(&files(&["Notes.md", "a/b.md", "notes.md"])).unwrap_err();
        assert!(err.contains("differ only in case"), "{err}");
        assert!(refuse_case_collisions(&files(&["A/b.md", "a/c.md", "notes.md"])).is_ok());
    }

    #[test]
    fn a_nested_skill_md_is_an_error() {
        let dir = support_fixture("support-nested");
        write_support(&dir, "inner/SKILL.md", b"x");
        let err = skill_support_files(&dir).unwrap_err();
        cleanup(&dir);
        assert!(err.contains("nested SKILL.md"), "{err}");
    }

    #[test]
    fn supporting_files_may_sit_four_levels_deep_and_no_deeper() {
        let dir = support_fixture("support-depth");
        write_support(&dir, "a/b/c/d.txt", b"x");
        fs::create_dir_all(dir.join("e/f/g/h")).unwrap();
        let files = skill_support_files(&dir);
        assert_eq!(files.unwrap(), vec!["a/b/c/d.txt"]);
        write_support(&dir, "a/b/c/d/e.txt", b"x");
        let err = skill_support_files(&dir).unwrap_err();
        cleanup(&dir);
        assert!(err.contains("deeper than"), "{err}");
    }

    #[test]
    fn a_skill_is_bounded_in_files_and_bytes() {
        let dir = support_fixture("support-bounds");
        for index in 0..MAX_SUPPORT_FILES {
            write_support(&dir, &format!("f{index}.md"), b"x");
        }
        assert_eq!(skill_support_files(&dir).unwrap().len(), MAX_SUPPORT_FILES);
        write_support(&dir, "one-too-many.md", b"x");
        let err = skill_support_files(&dir).unwrap_err();
        assert!(err.contains("supporting files"), "{err}");
        cleanup(&dir);

        let dir = support_fixture("support-size");
        write_support(
            &dir,
            "big.bin",
            &vec![b'x'; MAX_SUPPORT_FILE_BYTES as usize],
        );
        assert!(
            skill_support_files(&dir).is_ok(),
            "exactly the limit is fine"
        );
        write_support(
            &dir,
            "bigger.bin",
            &vec![b'x'; MAX_SUPPORT_FILE_BYTES as usize + 1],
        );
        let err = skill_support_files(&dir).unwrap_err();
        assert!(err.contains("over"), "{err}");
        cleanup(&dir);

        let dir = support_fixture("support-total");
        for index in 0..3 {
            write_support(&dir, &format!("part{index}.bin"), &vec![b'x'; 800 * 1024]);
        }
        let err = skill_support_files(&dir).unwrap_err();
        cleanup(&dir);
        assert!(err.contains("supporting files"), "{err}");
    }

    #[test]
    fn bundled_skills_carry_their_supporting_files() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let catalog = discover_skill_catalog(&repo).expect("bundled catalog");
        let counts: std::collections::BTreeMap<String, usize> = catalog
            .iter()
            .map(|skill| {
                let files = skill_support_files(&skill.source_dir).expect("bundled skill files");
                (skill.name.clone(), files.len())
            })
            .filter(|(_, count)| *count > 0)
            .collect();
        assert_eq!(counts.get("security-audit"), Some(&19));
        assert_eq!(counts.get("agents-md"), Some(&1));
        assert_eq!(counts.get("adversarial-implementation"), Some(&2));
        assert_eq!(counts.get("adversarial-review"), Some(&2));
        assert_eq!(counts.get("adversarial-test"), Some(&2));
        assert_eq!(counts.get("browser-qa"), Some(&1));
        assert_eq!(counts.get("delegate"), Some(&1));
        assert_eq!(counts.get("status-report"), Some(&4));
        assert_eq!(counts.get("pr-workflow"), Some(&1));
        assert_eq!(counts.len(), 9, "{counts:?}");
        assert_eq!(
            canonical_skill_dir(&repo, "security-audit"),
            repo.join("skills/security-audit")
        );
    }
}
