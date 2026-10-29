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

/// The lines between a first line `---` and the next line `---`.
fn frontmatter_lines(content: &str) -> Result<Vec<&str>, String> {
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
    let lines = frontmatter_lines(content)?;
    let mut fields = BTreeMap::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.starts_with(|c: char| c.is_whitespace() || c == '#' || c == '-') {
            continue;
        }
        let Some((key, rest)) = split_key(line) else {
            continue;
        };
        // The indented lines that belong to this key.
        let start = index;
        while index < lines.len() {
            let next = lines[index];
            if !next.trim().is_empty() && !next.starts_with(char::is_whitespace) {
                break;
            }
            index += 1;
        }
        let continuation = &lines[start..index];
        let value = scalar_value(rest, continuation)
            .map_err(|reason| format!("frontmatter key {key}: {reason}"))?;
        if fields.insert(key.to_string(), value).is_some() {
            return Err(format!("frontmatter key {key} is given more than once"));
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
        frontmatter_fields(content).map_err(|e| format!("The frontmatter cannot be read: {e}."))?;
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
    let targets = extract_frontmatter_list(&fields, "targets");
    if targets.is_empty()
        || targets
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

pub(crate) fn read_skill_metadata(
    skill_md: &Path,
    fallback_name: &str,
) -> Result<(String, String, Vec<String>), String> {
    let content = read_skill_md_capped(skill_md)?;
    let fields = frontmatter_fields(&content)
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
    Ok(files)
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
            "skills/kretsverket/kretsverket-editor-change",
            &skill_body("kretsverket-editor-change", ALL_TARGETS),
        );
        let catalog = discover_skill_catalog(&root).expect("discover");
        let _ = fs::remove_dir_all(&root);
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].name, "kretsverket-editor-change");
        assert_eq!(catalog[0].group, "kretsverket");
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
    fn all_four_targets_required_for_bundled_catalog() {
        let root = temp_root("four");
        write_skill(
            &root,
            "skills/diagnose",
            &skill_body("diagnose", ALL_TARGETS),
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
        assert_eq!(counts.get("kretsverket-status-report"), Some(&2));
        assert_eq!(counts.get("adversarial-implementation"), Some(&2));
        assert_eq!(counts.len(), 3, "{counts:?}");
        assert_eq!(
            canonical_skill_dir(&repo, "kretsverket-status-report"),
            repo.join("skills/kretsverket/kretsverket-status-report")
        );
        assert_eq!(
            canonical_skill_dir(&repo, "security-audit"),
            repo.join("skills/security-audit")
        );
    }
}
