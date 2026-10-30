//! The light tier: GitHub Copilot, Pi, Kilo Code, Google Antigravity and Grok Build.
//!
//! A light harness gets the shared skills (through the folders it reads, see
//! [`crate::skill_roots`]), one managed rules block (or none of its own, when it reads a central
//! harness's rules file), one managed Playwright MCP entry and a runtime health row set. Install facts
//! that are data live in
//! `resources/default-workspace/metadata/light-harnesses.json`. That file is embedded at build time
//! and never read from the runtime workspace, so nothing the user edits can redirect what the app
//! runs or writes. Identity (the [`HarnessId`] variants, the TypeScript unions) stays code;
//! `scripts/check-harness-mirror.py` keeps the descriptor, the Rust ids and the UI in step.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::agent_targets::HarnessId;
use crate::rules_block::RulesConflict;
use crate::setup_lifecycle::SetupSurfaceId;

const DESCRIPTOR: &str =
    include_str!("../../resources/default-workspace/metadata/light-harnesses.json");

const SCHEMA_VERSION: u32 = 1;
const MAX_LABEL_CHARS: usize = 24;
const MAX_REL_CHARS: usize = 120;
const MAX_FILE_NAMES: usize = 8;
const MAX_NOTES: usize = 3;
const MAX_NOTE_CHARS: usize = 240;
const MAX_KEY_CHARS: usize = 32;
/// The smallest `rules.max_file_bytes`: a limit below the bundled base would refuse every write.
const MIN_RULES_FILE_BYTES: u64 = 16 * 1024;
/// Where the entry templates live in the bundle.
const MCP_TEMPLATE_DIR: &str = "templates/mcp/";
/// Where the generated rules bases live in the bundle (`scripts/generate-agent-rules.py`).
const RULES_SOURCE_DIR: &str = "templates/sync";
/// `$XDG_CONFIG_HOME` stands in for this folder of the home directory.
const XDG_CONFIG_DEFAULT: &str = ".config/";

/// Files a descriptor may never name as a target: the harnesses keep credentials, state and
/// permissions in them. A harness's MCP file (`mcp.json`, `mcp-config.json`, `kilo.jsonc`) is the
/// one deliberate write beside the rules file, and edits one key only.
const DENIED_FILE_NAMES: &[&str] = &[
    "config.json",
    "settings.json",
    "auth.json",
    "models.json",
    "models-store.json",
    "providers.json",
    "permissions-config.json",
    "lsp-config.json",
    ".claude.json",
];
/// Folders (or name prefixes) a descriptor may never write into.
const DENIED_FOLDERS: &[&str] = &["mcp-oauth-config", "mcp-secrets", "installed-plugins"];
const DENIED_FOLDER_PREFIXES: &[&str] = &["session"];
/// Roots of the central harnesses: a light rules file is never inside one.
const CENTRAL_ROOTS: &[&str] = &[
    ".claude",
    ".codex",
    ".cursor",
    ".agents",
    ".config/opencode",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDescriptor {
    version: u32,
    harnesses: BTreeMap<String, RawHarness>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHarness {
    label: String,
    cli: RawCli,
    /// The harness's own rules file. Exactly one of `rules` and `shared_rules` is set.
    #[serde(default)]
    rules: Option<RawRules>,
    /// A central harness whose managed rules file this harness reads instead (`claude`): the app
    /// writes no rules file for it.
    #[serde(default)]
    shared_rules: Option<String>,
    mcp: RawMcp,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCli {
    program: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRules {
    /// Names the entry of `metadata/rules-adapters.json` (appendix and generated base).
    adapter: String,
    /// The rules file below the home directory.
    target_rel: String,
    /// Whether the target is on for a fresh install and for a settings file that predates it.
    default_enabled: bool,
    /// The file lives in `$XDG_CONFIG_HOME` (instead of `~/.config`) when that variable is set.
    #[serde(default)]
    xdg_config_home: bool,
    /// Folders the app creates for the file are owner-only (0700): the harness makes its own
    /// that way.
    #[serde(default)]
    private_dir: bool,
    /// Files in the rules file's folder that make the harness ignore it.
    #[serde(default)]
    masked_by: Vec<String>,
    /// Files in the rules file's folder that the harness reads instead of it when it is absent.
    #[serde(default)]
    peer_files: Vec<String>,
    /// A file below the home directory that the harness stops reading while the rules file
    /// exists (it loads one global file: this one first).
    #[serde(default)]
    shadows: Option<String>,
    /// The largest file the harness reads in full; the app writes no rules file above it.
    #[serde(default)]
    max_file_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMcp {
    /// The MCP file below the home directory (below `.config/` when `xdg_config_home`).
    target_rel: String,
    /// `json` (the default: strict JSON) or `toml` (edited in place, see [`crate::light_mcp`]).
    #[serde(default)]
    format: McpFormat,
    /// Other files the harness reads as well, in the order the app prefers them when the file
    /// above does not exist.
    #[serde(default)]
    alt_target_rel: Vec<String>,
    /// The key that holds the servers (`mcpServers`, `mcp`).
    root_key: String,
    /// The key of the one server the app manages.
    entry_key: String,
    /// The entry, as a file of the bundle below `templates/mcp/`.
    template: String,
    /// Whether the target is on for a fresh install and for a settings file that predates it.
    default_enabled: bool,
    #[serde(default)]
    xdg_config_home: bool,
    /// Folders the app creates for the file are owner-only (0700).
    #[serde(default)]
    private_dir: bool,
    /// Files next to the chosen file that the harness reads after it, so they win over the entry.
    #[serde(default)]
    shadowed_by_siblings: Vec<String>,
    /// Files below the home directory that win over the chosen file.
    #[serde(default)]
    shadowed_by_home: Vec<String>,
    /// Warnings the health shows while the target is on.
    #[serde(default)]
    notes: Vec<String>,
}

/// One light harness as the descriptor describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightHarness {
    pub id: HarnessId,
    /// Display name: the tab, the page title and messages.
    pub label: String,
    /// The CLI program name looked up on `PATH`; the only call made to it is `--version`.
    pub cli_program: String,
    /// The managed rules block; `None` for a harness that reads [`Self::shared_rules`] instead.
    pub rules: Option<LightRules>,
    /// The central harness whose managed rules file this harness reads; it has no rules surface
    /// of its own. Set exactly when `rules` is `None`.
    pub shared_rules: Option<HarnessId>,
    /// The managed Playwright MCP entry.
    pub mcp: LightMcp,
}

/// How an MCP file is read and written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpFormat {
    /// Strict JSON, rewritten whole with the user's keys kept.
    #[default]
    Json,
    /// TOML, edited in place: only the managed table changes.
    Toml,
}

/// The managed MCP entry of a light harness: which file holds it, under which keys, and what the
/// entry is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightMcp {
    /// `<harness>_mcp`: the settings toggle of the surface.
    pub target_id: String,
    /// `<harness> mcp`.
    pub target_label: String,
    /// The entry template below the bundled root: `templates/mcp/<harness>.playwright.json`.
    pub template_rel: String,
    /// The default location below the home directory; the settings and the page show it.
    pub target_rel: String,
    /// Other files the harness reads, in preference order (below `.config/` like `target_rel`).
    pub alt_target_rel: Vec<String>,
    pub root_key: String,
    pub entry_key: String,
    pub format: McpFormat,
    pub default_enabled: bool,
    pub xdg_config_home: bool,
    pub private_dir: bool,
    pub shadowed_by_siblings: Vec<String>,
    pub shadowed_by_home: Vec<String>,
    pub notes: Vec<String>,
    /// The setup surface that owns the entry.
    pub surface: SetupSurfaceId,
}

/// The rules block of a light harness: where the file is, which base it carries and what makes
/// the harness ignore it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightRules {
    /// Entry of `metadata/rules-adapters.json`; also the folder name of the rules history.
    pub adapter: String,
    /// `<harness>_rules`: the settings toggle of the surface.
    pub target_id: String,
    /// `<harness> rules`.
    pub target_label: String,
    /// The generated base below the bundled root: `templates/sync/<adapter>-rules.md`.
    pub source_rel: String,
    /// The default location below the home directory; the settings and the page show it.
    pub target_rel: String,
    /// Name of the rules file, as the pages call it.
    pub file_label: String,
    pub default_enabled: bool,
    pub xdg_config_home: bool,
    pub private_dir: bool,
    pub masked_by: Vec<String>,
    pub peer_files: Vec<String>,
    /// `~/...` of the file the harness stops reading while the rules file exists.
    pub shadows: Option<String>,
    /// The largest file the harness reads in full (Antigravity: 24,000 bytes per rules file).
    pub max_file_bytes: Option<u64>,
    /// The setup surface that owns the file.
    pub surface: SetupSurfaceId,
}

/// A light harness id: a [`HarnessId`] of the light tier. Validated at construction and on
/// deserialization, so no manifest or managed-state record can name a central harness in an
/// artifact that resolves its paths from the descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "HarnessId")]
pub struct LightHarnessId(HarnessId);

impl TryFrom<HarnessId> for LightHarnessId {
    type Error = String;

    fn try_from(id: HarnessId) -> Result<Self, Self::Error> {
        Self::new(id).ok_or_else(|| format!("{} is not a light harness", id.as_str()))
    }
}

impl LightHarnessId {
    pub fn new(id: HarnessId) -> Option<Self> {
        id.is_light().then_some(Self(id))
    }

    pub fn harness(self) -> HarnessId {
        self.0
    }

    /// The descriptor of the harness. `None` only when the embedded descriptor is invalid.
    pub fn descriptor(self) -> Option<&'static LightHarness> {
        descriptor(self.0)
    }

    /// The rules block of the harness: `None` for one that reads a central harness's rules file,
    /// and with the same caveat as [`Self::descriptor`].
    pub fn rules(self) -> Option<&'static LightRules> {
        self.descriptor().and_then(|harness| harness.rules.as_ref())
    }

    /// The setup surface that owns the harness's rules file. `parse` pairs every rules section
    /// with a rules surface, and only a harness with one is named by a rules artifact, so the
    /// fallback is unreachable in a build whose tests pass.
    pub fn rules_surface(self) -> SetupSurfaceId {
        SetupSurfaceId::light_rules(self.0).unwrap_or(SetupSurfaceId::WorkspaceBundle)
    }

    /// The MCP entry of the harness, with the same caveat as [`Self::descriptor`].
    pub fn mcp(self) -> Option<&'static LightMcp> {
        self.descriptor().map(|harness| &harness.mcp)
    }

    /// The setup surface that owns the harness's MCP entry, with the same caveat as
    /// [`Self::rules_surface`].
    pub fn mcp_surface(self) -> SetupSurfaceId {
        SetupSurfaceId::light_mcp(self.0).unwrap_or(SetupSurfaceId::WorkspaceBundle)
    }
}

impl LightRules {
    /// The rules file for `home`: below `$XDG_CONFIG_HOME` when the descriptor follows it and the
    /// variable is set to an absolute path, else below `home`. A relative value is ignored, as
    /// the XDG Base Directory specification says: file operations would resolve it against the
    /// working directory, where no harness looks for it.
    pub fn resolve_dest(&self, home: &Path) -> PathBuf {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        self.resolve_dest_with(home, xdg.as_deref())
    }

    fn resolve_dest_with(&self, home: &Path, xdg_config_home: Option<&str>) -> PathBuf {
        place(
            home,
            xdg_config_home,
            self.xdg_config_home,
            &self.target_rel,
        )
    }

    /// The rules file as people know it: `~/...`, or `$XDG_CONFIG_HOME/...` for a file that lives
    /// outside the home directory.
    pub fn display_path(&self, home: &Path) -> String {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        display_of(home, xdg.as_deref(), self.xdg_config_home, &self.target_rel)
    }

    /// The folder the file must stay inside when it is written, backed up, restored or removed:
    /// `home`, or `$XDG_CONFIG_HOME` when the file lives there outside `home`.
    pub fn allowlist_root(&self, home: &Path) -> PathBuf {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        self.allowlist_root_with(home, xdg.as_deref())
    }

    fn allowlist_root_with(&self, home: &Path, xdg_config_home: Option<&str>) -> PathBuf {
        root_of(
            home,
            xdg_config_home,
            self.xdg_config_home,
            &self.target_rel,
        )
    }

    /// The files of `names` that exist next to `dest`. Only regular files count: the harness
    /// skips every other entry.
    fn files_next_to<'a>(&self, dest: &Path, names: &'a [String]) -> Vec<&'a str> {
        let Some(dir) = dest.parent() else {
            return Vec::new();
        };
        names
            .iter()
            .filter(|name| std::fs::metadata(dir.join(name)).is_ok_and(|m| m.is_file()))
            .map(String::as_str)
            .collect()
    }

    /// The override files next to `dest` that make the harness ignore the rules file.
    pub fn masking_files(&self, dest: &Path) -> Vec<&str> {
        self.files_next_to(dest, &self.masked_by)
    }

    /// The peer context files next to `dest` (the ones the harness reads when the rules file is
    /// absent).
    pub fn peer_context_files(&self, dest: &Path) -> Vec<&str> {
        self.files_next_to(dest, &self.peer_files)
    }

    /// Whether a rules file of `len` bytes is one the harness reads in full. A file the app would
    /// write past the limit is a conflict ([`RulesConflict::ExceedsHarnessLimit`]).
    pub fn fits(&self, len: usize) -> bool {
        self.max_file_bytes
            .is_none_or(|max| u64::try_from(len).is_ok_and(|len| len <= max))
    }

    /// Whether another file in the rules file's folder keeps the harness from reading the block:
    /// an override that takes precedence, or (with no rules file yet) a peer the harness would
    /// read instead and a new file would hide.
    pub fn preflight(&self, dest: &Path) -> Option<RulesConflict> {
        if !self.masking_files(dest).is_empty() {
            return Some(RulesConflict::MaskedByOverride);
        }
        let own = std::fs::metadata(dest).is_ok_and(|m| m.is_file());
        if !own && !self.peer_context_files(dest).is_empty() {
            return Some(RulesConflict::PeerContextFile);
        }
        None
    }
}

impl LightMcp {
    /// The file the entry goes into, for `home`: the first of `target_rel` and `alt_target_rel`
    /// that exists (in any form: a symlink or a folder in the way is reported, not skipped), else
    /// `target_rel`, which the app then creates.
    pub fn resolve_dest(&self, home: &Path) -> PathBuf {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        self.resolve_dest_with(home, xdg.as_deref())
    }

    fn chosen_rel(&self, home: &Path, xdg_config_home: Option<&str>) -> &str {
        std::iter::once(&self.target_rel)
            .chain(&self.alt_target_rel)
            .find(|rel| {
                let path = place(home, xdg_config_home, self.xdg_config_home, rel);
                std::fs::symlink_metadata(path).is_ok()
            })
            .unwrap_or(&self.target_rel)
    }

    fn resolve_dest_with(&self, home: &Path, xdg_config_home: Option<&str>) -> PathBuf {
        let rel = self.chosen_rel(home, xdg_config_home);
        place(home, xdg_config_home, self.xdg_config_home, rel)
    }

    /// The MCP file as people know it (`~/...`, or `$XDG_CONFIG_HOME/...`).
    pub fn display_path(&self, home: &Path) -> String {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let rel = self.chosen_rel(home, xdg.as_deref());
        display_of(home, xdg.as_deref(), self.xdg_config_home, rel)
    }

    /// The folder the file must stay inside when it is written, backed up, restored or removed.
    pub fn allowlist_root(&self, home: &Path) -> PathBuf {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let rel = self.chosen_rel(home, xdg.as_deref());
        root_of(home, xdg.as_deref(), self.xdg_config_home, rel)
    }

    /// The files that exist and win over the MCP file, as people know them. Only whether they
    /// exist is looked at: they may hold anything.
    pub fn shadowing_files(&self, home: &Path) -> Vec<String> {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let rel = self.chosen_rel(home, xdg.as_deref());
        let shown = display_of(home, xdg.as_deref(), self.xdg_config_home, rel);
        let dest = place(home, xdg.as_deref(), self.xdg_config_home, rel);
        let folder = shown.rsplit_once('/').map_or("", |(folder, _)| folder);
        let is_file = |path: PathBuf| std::fs::metadata(path).is_ok_and(|m| m.is_file());
        let next_to = self.shadowed_by_siblings.iter().filter_map(|name| {
            let sibling = dest.parent()?.join(name);
            is_file(sibling).then(|| format!("{folder}/{name}"))
        });
        let below_home = self
            .shadowed_by_home
            .iter()
            .filter(|rel| is_file(join_rel(home.to_path_buf(), rel)))
            .map(|rel| format!("~/{rel}"));
        next_to.chain(below_home).collect()
    }
}

fn join_rel(base: PathBuf, rel: &str) -> PathBuf {
    rel.split('/').fold(base, |path, part| path.join(part))
}

/// `$XDG_CONFIG_HOME` as a plain absolute folder, when a file follows it and the variable is set
/// to one ([`crate::platform_paths::xdg_config_home_dir`], which OpenCode's folder follows too).
/// It becomes the allowlisted root of a file, so it must name one place.
fn xdg_dir(follow_xdg: bool, xdg_config_home: Option<&str>) -> Option<PathBuf> {
    if !follow_xdg {
        return None;
    }
    crate::platform_paths::xdg_config_home_dir(xdg_config_home)
}

/// `rel` (a path below `home`) for `home`, or below `$XDG_CONFIG_HOME` when `follow_xdg` and the
/// variable is set to an absolute path. `parse` guarantees such a `rel` starts with `.config/`.
fn place(home: &Path, xdg_config_home: Option<&str>, follow_xdg: bool, rel: &str) -> PathBuf {
    if let Some(dir) = xdg_dir(follow_xdg, xdg_config_home) {
        return join_rel(dir, rel.strip_prefix(XDG_CONFIG_DEFAULT).unwrap_or(rel));
    }
    join_rel(home.to_path_buf(), rel)
}

/// The folder a placed file must stay inside: `home`, or `$XDG_CONFIG_HOME` when the file lives
/// there outside `home`.
fn root_of(home: &Path, xdg_config_home: Option<&str>, follow_xdg: bool, rel: &str) -> PathBuf {
    let dest = place(home, xdg_config_home, follow_xdg, rel);
    if dest.starts_with(home) {
        return home.to_path_buf();
    }
    xdg_dir(follow_xdg, xdg_config_home)
        .filter(|dir| dest.starts_with(dir))
        .unwrap_or_else(|| home.to_path_buf())
}

/// A placed file as people know it: `~/...`, or `$XDG_CONFIG_HOME/...` for a file that lives
/// outside the home directory.
fn display_of(home: &Path, xdg_config_home: Option<&str>, follow_xdg: bool, rel: &str) -> String {
    let dest = place(home, xdg_config_home, follow_xdg, rel);
    if let Ok(below_home) = dest.strip_prefix(home) {
        return format!("~/{}", below_home.to_string_lossy().replace('\\', "/"));
    }
    match rel.strip_prefix(XDG_CONFIG_DEFAULT) {
        Some(rest) if follow_xdg => format!("$XDG_CONFIG_HOME/{rest}"),
        _ => format!("~/{rel}"),
    }
}

fn is_plain_label(label: &str) -> bool {
    !label.is_empty()
        && label.chars().count() <= MAX_LABEL_CHARS
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '.'))
        && label.trim() == label
}

/// A bare program name: no path, no option-like leading dash, nothing a shell would interpret.
fn is_bare_program_name(program: &str) -> bool {
    let mut chars = program.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && program.len() <= 32
        && program
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A file or folder name of ASCII letters, digits, `.`, `_` and `-`.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A relative `/`-separated path of plain names: no empty part, no `.` or `..`, no backslash or
/// drive letter.
fn is_plain_rel(rel: &str) -> bool {
    !rel.is_empty() && rel.len() <= MAX_REL_CHARS && rel.split('/').all(is_plain_name)
}

fn is_under(rel: &str, root: &str) -> bool {
    rel == root || rel.starts_with(&format!("{root}/"))
}

/// Plain file names that stand for other files in the rules file's folder.
fn parse_file_names(
    key: &str,
    field: &str,
    names: Vec<String>,
    own: &[&str],
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    if names.len() > MAX_FILE_NAMES {
        return Err(format!(
            "{key}: {field} lists more than {MAX_FILE_NAMES} files"
        ));
    }
    for name in &names {
        if !is_plain_name(name) || own.contains(&name.as_str()) || !seen.insert(name.as_str()) {
            return Err(format!(
                "{key}: {field} has an entry that is not a plain, unique file name"
            ));
        }
    }
    Ok(names)
}

fn parse_rules(id: HarnessId, raw: RawRules) -> Result<LightRules, String> {
    let key = id.as_str();
    if !is_bare_program_name(&raw.adapter) {
        return Err(format!("{key}: rules.adapter is not a bare name"));
    }
    let rel = raw.target_rel;
    if !is_plain_rel(&rel) {
        return Err(format!(
            "{key}: rules.target_rel is not a plain relative path"
        ));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let file_label = parts.last().copied().unwrap_or_default().to_string();
    if parts.len() < 2 || !file_label.ends_with(".md") {
        return Err(format!(
            "{key}: rules.target_rel must be a Markdown file inside a folder of the harness"
        ));
    }
    if DENIED_FILE_NAMES.contains(&file_label.as_str())
        || parts[..parts.len() - 1].iter().any(|part| {
            DENIED_FOLDERS.contains(part)
                || DENIED_FOLDER_PREFIXES
                    .iter()
                    .any(|prefix| part.starts_with(prefix))
        })
    {
        return Err(format!(
            "{key}: rules.target_rel names a file or folder the app never writes"
        ));
    }
    if CENTRAL_ROOTS.iter().any(|root| is_under(&rel, root)) {
        return Err(format!(
            "{key}: rules.target_rel is inside the folder of a central harness"
        ));
    }
    if raw.xdg_config_home && (!rel.starts_with(XDG_CONFIG_DEFAULT) || parts.len() < 3) {
        return Err(format!(
            "{key}: rules.xdg_config_home needs a target_rel of the form .config/<folder>/<file>"
        ));
    }
    let masked_by = parse_file_names(key, "rules.masked_by", raw.masked_by, &[&file_label])?;
    let peer_files = parse_file_names(key, "rules.peer_files", raw.peer_files, &[&file_label])?;
    let shadows = match raw.shadows {
        None => None,
        Some(shadowed) if is_plain_rel(&shadowed) && shadowed != rel => {
            Some(format!("~/{shadowed}"))
        }
        Some(_) => return Err(format!("{key}: rules.shadows is not a plain relative path")),
    };
    if raw.max_file_bytes.is_some_and(|max| {
        !(MIN_RULES_FILE_BYTES..=crate::rules_block::MAX_RULES_FILE_BYTES).contains(&max)
    }) {
        return Err(format!(
            "{key}: rules.max_file_bytes must be between {MIN_RULES_FILE_BYTES} and the largest rules file the app reads"
        ));
    }
    let surface =
        SetupSurfaceId::light_rules(id).ok_or_else(|| format!("{key}: no rules surface"))?;
    Ok(LightRules {
        target_id: format!("{key}_rules"),
        target_label: format!("{key} rules"),
        source_rel: format!("{RULES_SOURCE_DIR}/{}-rules.md", raw.adapter),
        adapter: raw.adapter,
        target_rel: rel,
        file_label,
        default_enabled: raw.default_enabled,
        xdg_config_home: raw.xdg_config_home,
        private_dir: raw.private_dir,
        masked_by,
        peer_files,
        shadows,
        max_file_bytes: raw.max_file_bytes,
        surface,
    })
}

/// A JSON object key the app reads and writes: plain, so it cannot name a path or a pattern.
fn is_json_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_CHARS
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

/// Text for the health: ASCII letters, digits, punctuation and spaces, nothing a UI would
/// interpret.
fn is_plain_note(note: &str) -> bool {
    !note.is_empty()
        && note.len() <= MAX_NOTE_CHARS
        && note.trim() == note
        && note.chars().all(|c| c.is_ascii_graphic() || c == ' ')
}

/// A relative path of a file of `format` inside a folder of the harness (`<folder>/<name>.json[c]`,
/// `<folder>/<name>.toml`) that is neither a file the app never writes nor inside the folder of a
/// central harness.
fn parse_mcp_file(key: &str, field: &str, rel: &str, format: McpFormat) -> Result<(), String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let file = parts.last().copied().unwrap_or_default();
    let typed = match format {
        McpFormat::Json => file.ends_with(".json") || file.ends_with(".jsonc"),
        McpFormat::Toml => file.ends_with(".toml"),
    };
    if !is_plain_rel(rel) || parts.len() < 2 || !typed {
        return Err(format!(
            "{key}: mcp.{field} must be a file of its format inside a folder of the harness"
        ));
    }
    if DENIED_FILE_NAMES.contains(&file)
        || parts[..parts.len() - 1].iter().any(|part| {
            DENIED_FOLDERS.contains(part)
                || DENIED_FOLDER_PREFIXES
                    .iter()
                    .any(|prefix| part.starts_with(prefix))
        })
    {
        return Err(format!(
            "{key}: mcp.{field} names a file or folder the app never writes"
        ));
    }
    if CENTRAL_ROOTS.iter().any(|root| is_under(rel, root)) {
        return Err(format!(
            "{key}: mcp.{field} is inside the folder of a central harness"
        ));
    }
    Ok(())
}

fn parse_mcp(id: HarnessId, raw: RawMcp) -> Result<LightMcp, String> {
    let key = id.as_str();
    parse_mcp_file(key, "target_rel", &raw.target_rel, raw.format)?;
    let folder = raw
        .target_rel
        .rsplit_once('/')
        .map_or("", |(folder, _)| folder);
    if raw.alt_target_rel.len() > MAX_FILE_NAMES {
        return Err(format!(
            "{key}: mcp.alt_target_rel lists more than {MAX_FILE_NAMES} files"
        ));
    }
    let mut files = vec![raw.target_rel.as_str()];
    for rel in &raw.alt_target_rel {
        parse_mcp_file(key, "alt_target_rel", rel, raw.format)?;
        if rel.rsplit_once('/').map(|(alt_folder, _)| alt_folder) != Some(folder)
            || files.contains(&rel.as_str())
        {
            return Err(format!(
                "{key}: mcp.alt_target_rel must list other files of the same folder"
            ));
        }
        files.push(rel);
    }
    if raw.xdg_config_home
        && files
            .iter()
            .any(|rel| !rel.starts_with(XDG_CONFIG_DEFAULT) || rel.split('/').count() < 3)
    {
        return Err(format!(
            "{key}: mcp.xdg_config_home needs files of the form .config/<folder>/<file>"
        ));
    }
    if !is_json_key(&raw.root_key) || !is_json_key(&raw.entry_key) || raw.root_key == raw.entry_key
    {
        return Err(format!(
            "{key}: mcp.root_key and mcp.entry_key must be two different plain keys"
        ));
    }
    if !is_plain_rel(&raw.template)
        || !raw.template.starts_with(MCP_TEMPLATE_DIR)
        || !raw.template.ends_with(".json")
        || raw.template.matches('/').count() != MCP_TEMPLATE_DIR.matches('/').count()
    {
        return Err(format!(
            "{key}: mcp.template must be a JSON file directly in {MCP_TEMPLATE_DIR}"
        ));
    }
    let names: Vec<&str> = files
        .iter()
        .filter_map(|rel| rel.rsplit_once('/').map(|(_, name)| name))
        .collect();
    let shadowed_by_siblings = parse_file_names(
        key,
        "mcp.shadowed_by_siblings",
        raw.shadowed_by_siblings,
        &names,
    )?;
    if raw.shadowed_by_home.len() > MAX_FILE_NAMES {
        return Err(format!(
            "{key}: mcp.shadowed_by_home lists more than {MAX_FILE_NAMES} files"
        ));
    }
    let mut seen = HashSet::new();
    for rel in &raw.shadowed_by_home {
        if !is_plain_rel(rel)
            || rel.split('/').count() < 2
            || files.contains(&rel.as_str())
            || !seen.insert(rel)
        {
            return Err(format!(
                "{key}: mcp.shadowed_by_home has an entry that is not a plain, unique file path"
            ));
        }
    }
    if raw.notes.len() > MAX_NOTES || !raw.notes.iter().all(|note| is_plain_note(note)) {
        return Err(format!(
            "{key}: mcp.notes has more than {MAX_NOTES} entries or one that is not short plain text"
        ));
    }
    let surface = SetupSurfaceId::light_mcp(id).ok_or_else(|| format!("{key}: no MCP surface"))?;
    Ok(LightMcp {
        target_id: format!("{key}_mcp"),
        target_label: format!("{key} mcp"),
        template_rel: raw.template,
        target_rel: raw.target_rel,
        alt_target_rel: raw.alt_target_rel,
        root_key: raw.root_key,
        entry_key: raw.entry_key,
        format: raw.format,
        default_enabled: raw.default_enabled,
        xdg_config_home: raw.xdg_config_home,
        private_dir: raw.private_dir,
        shadowed_by_siblings,
        shadowed_by_home: raw.shadowed_by_home,
        notes: raw.notes,
        surface,
    })
}

/// The rules file of a central harness that a light harness reads instead of a file of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedRulesFile {
    pub harness: HarnessId,
    /// The settings toggle of the file.
    pub target_id: &'static str,
    /// The file as people know it.
    pub path: &'static str,
    /// The harness's name in messages.
    pub label: &'static str,
}

/// The central rules files a light harness can share. Only Claude Code's so far: Grok Build reads
/// `~/.claude/CLAUDE.md` with its Claude compatibility, which is on by default.
const SHARED_RULES: &[SharedRulesFile] = &[SharedRulesFile {
    harness: HarnessId::Claude,
    target_id: "claude_rules",
    path: "~/.claude/CLAUDE.md",
    label: "Claude Code",
}];

/// The central harness `shared_rules` names.
fn parse_shared_rules(key: &str, shared: &str) -> Result<HarnessId, String> {
    SHARED_RULES
        .iter()
        .map(|file| file.harness)
        .find(|id| id.as_str() == shared)
        .ok_or_else(|| format!("{key}: shared_rules does not name a central harness with rules"))
}

/// The rules file of `central`, when a light harness can share it.
pub fn shared_rules_file(central: HarnessId) -> Option<&'static SharedRulesFile> {
    SHARED_RULES.iter().find(|file| file.harness == central)
}

/// Parses and validates a descriptor. The result has one entry per light [`HarnessId`], in
/// [`HarnessId::ALL`] order.
fn parse(text: &str) -> Result<Vec<LightHarness>, String> {
    let raw: RawDescriptor =
        serde_json::from_str(text).map_err(|error| format!("not a valid descriptor: {error}"))?;
    if raw.version != SCHEMA_VERSION {
        return Err(format!("unsupported version {}", raw.version));
    }
    let mut by_id: BTreeMap<&str, LightHarness> = BTreeMap::new();
    for (key, harness) in raw.harnesses {
        let id = HarnessId::ALL
            .iter()
            .copied()
            .find(|candidate| candidate.as_str() == key)
            .ok_or_else(|| format!("unknown harness id {key:?}"))?;
        if !id.is_light() {
            return Err(format!("{key} is not a light harness"));
        }
        if !is_plain_label(&harness.label) {
            return Err(format!(
                "{key}: label is not plain text of 1-{MAX_LABEL_CHARS} characters"
            ));
        }
        if !is_bare_program_name(&harness.cli.program) {
            return Err(format!("{key}: cli.program is not a bare program name"));
        }
        let (rules, shared_rules) = match (harness.rules, harness.shared_rules) {
            (Some(rules), None) => (Some(parse_rules(id, rules)?), None),
            (None, Some(shared)) => (None, Some(parse_shared_rules(&key, &shared)?)),
            _ => {
                return Err(format!(
                    "{key}: exactly one of rules and shared_rules must be set"
                ))
            }
        };
        if rules.is_none() && SetupSurfaceId::light_rules(id).is_some() {
            return Err(format!("{key}: a harness with a rules surface needs rules"));
        }
        by_id.insert(
            id.as_str(),
            LightHarness {
                id,
                label: harness.label,
                cli_program: harness.cli.program,
                rules,
                shared_rules,
                mcp: parse_mcp(id, harness.mcp)?,
            },
        );
    }
    let ordered: Vec<LightHarness> = HarnessId::ALL
        .iter()
        .copied()
        .filter(|id| id.is_light())
        .map(|id| {
            by_id
                .remove(id.as_str())
                .ok_or_else(|| format!("light harness {} has no entry", id.as_str()))
        })
        .collect::<Result<_, _>>()?;
    // Two harnesses never share a rules file, a base or a history folder, an MCP file or a
    // template.
    let mut files = HashSet::new();
    let mut adapters = HashSet::new();
    let mut templates = HashSet::new();
    for harness in &ordered {
        if let Some(rules) = &harness.rules {
            if !files.insert(rules.target_rel.as_str()) || !adapters.insert(rules.adapter.as_str())
            {
                return Err(format!(
                    "{}: rules.target_rel or rules.adapter is used by another harness",
                    harness.id.as_str()
                ));
            }
        }
        let mcp = &harness.mcp;
        if !templates.insert(mcp.template_rel.as_str())
            || std::iter::once(&mcp.target_rel)
                .chain(&mcp.alt_target_rel)
                .any(|rel| !files.insert(rel.as_str()))
        {
            return Err(format!(
                "{}: an mcp file or template is used by another harness",
                harness.id.as_str()
            ));
        }
    }
    Ok(ordered)
}

/// Every light harness, in [`HarnessId::ALL`] order. Empty only when the embedded descriptor is
/// invalid, which `embedded_descriptor_is_valid` rules out for any build that passes its tests.
pub fn light_harnesses() -> &'static [LightHarness] {
    static PARSED: OnceLock<Vec<LightHarness>> = OnceLock::new();
    PARSED.get_or_init(|| parse(DESCRIPTOR).unwrap_or_default())
}

/// The descriptor of `id`; `None` for a central harness.
pub fn descriptor(id: HarnessId) -> Option<&'static LightHarness> {
    light_harnesses().iter().find(|harness| harness.id == id)
}

/// The name shown for `id`: the descriptor's label for a light harness, the wire name otherwise.
pub fn display_name(id: HarnessId) -> &'static str {
    descriptor(id).map_or(id.as_str(), |harness| harness.label.as_str())
}

/// The rules block whose toggle is `target_id`.
pub fn rules_for_target(target_id: &str) -> Option<&'static LightRules> {
    light_harnesses()
        .iter()
        .filter_map(|harness| harness.rules.as_ref())
        .find(|rules| rules.target_id == target_id)
}

/// The light harness whose MCP toggle is `target_id`.
pub fn mcp_for_target(target_id: &str) -> Option<&'static LightHarness> {
    light_harnesses()
        .iter()
        .find(|harness| harness.mcp.target_id == target_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> serde_json::Value {
        serde_json::from_str(DESCRIPTOR).expect("descriptor is JSON")
    }

    fn parse_value(value: &serde_json::Value) -> Result<Vec<LightHarness>, String> {
        parse(&value.to_string())
    }

    fn rules_of(key: &str) -> &'static LightRules {
        descriptor(
            HarnessId::ALL
                .iter()
                .copied()
                .find(|id| id.as_str() == key)
                .expect("harness id"),
        )
        .expect("light harness")
        .rules
        .as_ref()
        .expect("own rules")
    }

    fn temp(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-light-harness-{label}-{nonce}"));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn embedded_descriptor_is_valid() {
        let harnesses = parse(DESCRIPTOR).expect("the embedded descriptor validates");
        assert_eq!(
            harnesses
                .iter()
                .map(|harness| (
                    harness.id,
                    harness.label.as_str(),
                    harness.cli_program.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (HarnessId::Copilot, "Copilot", "copilot"),
                (HarnessId::Pi, "Pi", "pi"),
                (HarnessId::Kilo, "Kilo", "kilo"),
                (HarnessId::Antigravity, "Antigravity", "agy"),
                (HarnessId::Grok, "Grok", "grok"),
            ]
        );
        assert_eq!(light_harnesses(), harnesses.as_slice());
    }

    #[test]
    fn the_embedded_rules_sections_pin_every_target_the_app_writes() {
        let summary: Vec<_> = light_harnesses()
            .iter()
            .filter_map(|harness| harness.rules.as_ref())
            .map(|rules| {
                (
                    rules.target_id.as_str(),
                    rules.target_rel.as_str(),
                    rules.file_label.as_str(),
                    rules.source_rel.as_str(),
                    rules.xdg_config_home,
                    rules.private_dir,
                    rules.default_enabled,
                    rules.surface,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "copilot_rules",
                    ".copilot/copilot-instructions.md",
                    "copilot-instructions.md",
                    "templates/sync/copilot-rules.md",
                    false,
                    false,
                    true,
                    SetupSurfaceId::CopilotRules
                ),
                (
                    "pi_rules",
                    ".pi/agent/AGENTS.md",
                    "AGENTS.md",
                    "templates/sync/pi-rules.md",
                    false,
                    true,
                    true,
                    SetupSurfaceId::PiRules
                ),
                (
                    "kilo_rules",
                    ".config/kilo/AGENTS.md",
                    "AGENTS.md",
                    "templates/sync/kilo-rules.md",
                    true,
                    false,
                    true,
                    SetupSurfaceId::KiloRules
                ),
                (
                    "antigravity_rules",
                    ".gemini/AGENTS.md",
                    "AGENTS.md",
                    "templates/sync/antigravity-rules.md",
                    false,
                    false,
                    true,
                    SetupSurfaceId::AntigravityRules
                ),
            ]
        );
        // Antigravity reads at most 24,000 bytes of a rules file; the others have no limit.
        assert_eq!(rules_of("antigravity").max_file_bytes, Some(24_000));
        for key in ["copilot", "pi", "kilo"] {
            assert_eq!(rules_of(key).max_file_bytes, None, "{key}");
        }
        assert_eq!(rules_of("pi").masked_by, ["AGENTS.override.md"]);
        assert_eq!(
            rules_of("pi").peer_files,
            ["CLAUDE.md", "CLAUDE.MD", "AGENTS.MD"]
        );
        for key in ["copilot", "kilo", "antigravity"] {
            assert!(rules_of(key).masked_by.is_empty(), "{key}");
            assert!(rules_of(key).peer_files.is_empty(), "{key}");
        }
    }

    #[test]
    fn each_rules_adapter_exists_with_an_appendix_and_the_derived_output() {
        let adapters: serde_json::Value = serde_json::from_str(include_str!(
            "../../resources/default-workspace/metadata/rules-adapters.json"
        ))
        .expect("rules-adapters.json");
        let resources =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        for harness in light_harnesses() {
            let Some(rules) = &harness.rules else {
                continue;
            };
            let entry = &adapters["harnesses"][&rules.adapter];
            assert_eq!(
                entry["output"],
                serde_json::json!(rules.source_rel),
                "{}",
                harness.id.as_str()
            );
            let appendix = entry["appendix"].as_str().expect("appendix path");
            assert!(resources.join(appendix).is_file(), "{appendix}");
            assert!(
                resources.join(&rules.source_rel).is_file(),
                "{}",
                rules.source_rel
            );
        }
    }

    #[test]
    fn grok_reads_claude_codes_rules_file_and_has_no_rules_of_its_own() {
        let grok = descriptor(HarnessId::Grok).expect("light harness");
        assert_eq!(grok.rules, None);
        assert_eq!(grok.shared_rules, Some(HarnessId::Claude));
        assert_eq!(SetupSurfaceId::light_rules(HarnessId::Grok), None);
        let file = shared_rules_file(HarnessId::Claude).expect("Claude's rules file");
        assert_eq!(
            (file.target_id, file.path, file.label),
            ("claude_rules", "~/.claude/CLAUDE.md", "Claude Code")
        );
        let grok_id = LightHarnessId::new(HarnessId::Grok).expect("light");
        assert!(grok_id.rules().is_none());
        assert!(rules_for_target("grok_rules").is_none());
        // Every harness with rules still has them.
        for id in [HarnessId::Copilot, HarnessId::Pi, HarnessId::Kilo] {
            let harness = descriptor(id).expect("light harness");
            assert!(harness.rules.is_some() && harness.shared_rules.is_none());
        }
    }

    #[test]
    fn rules_and_shared_rules_are_exclusive_and_shared_rules_names_a_known_file() {
        // Both, or neither.
        let mut value = valid();
        value["harnesses"]["grok"]["rules"] = valid()["harnesses"]["pi"]["rules"].clone();
        assert!(parse_value(&value).unwrap_err().contains("exactly one"));
        let mut value = valid();
        value["harnesses"]["grok"]
            .as_object_mut()
            .unwrap()
            .remove("shared_rules");
        assert!(parse_value(&value).unwrap_err().contains("exactly one"));
        // A harness with a rules surface cannot give its rules away.
        let mut value = valid();
        value["harnesses"]["pi"]
            .as_object_mut()
            .unwrap()
            .remove("rules");
        value["harnesses"]["pi"]["shared_rules"] = serde_json::json!("claude");
        assert!(parse_value(&value).unwrap_err().contains("rules surface"));
        for shared in ["codex", "cursor", "kilo", "grok", "Claude", "", "../claude"] {
            let mut value = valid();
            value["harnesses"]["grok"]["shared_rules"] = serde_json::json!(shared);
            assert!(parse_value(&value).is_err(), "{shared:?}");
        }
    }

    #[test]
    fn every_light_harness_id_has_a_descriptor_and_no_central_one_has() {
        for id in HarnessId::ALL {
            assert_eq!(descriptor(*id).is_some(), id.is_light(), "{}", id.as_str());
        }
        assert_eq!(display_name(HarnessId::Copilot), "Copilot");
        assert_eq!(display_name(HarnessId::Claude), "claude");
        assert_eq!(
            rules_for_target("pi_rules").map(|rules| rules.surface),
            Some(SetupSurfaceId::PiRules)
        );
        assert!(rules_for_target("claude_rules").is_none());
    }

    #[test]
    fn a_descriptor_that_names_a_central_or_unknown_harness_is_refused() {
        for key in ["claude", "codex", "cursor", "opencode", "unknown", "Pi"] {
            let mut value = valid();
            value["harnesses"][key] = serde_json::json!({
                "label": "X",
                "cli": { "program": "x" },
                "rules": {
                    "adapter": "x",
                    "target_rel": ".x/AGENTS.md",
                    "default_enabled": true
                },
                "mcp": {
                    "target_rel": ".x/mcp.json",
                    "root_key": "mcpServers",
                    "entry_key": "playwright",
                    "template": "templates/mcp/x.playwright.json",
                    "default_enabled": true
                },
            });
            assert!(parse_value(&value).is_err(), "{key}");
        }
    }

    #[test]
    fn a_descriptor_missing_a_light_harness_or_with_unknown_fields_is_refused() {
        let mut value = valid();
        value["harnesses"].as_object_mut().unwrap().remove("pi");
        assert!(parse_value(&value).unwrap_err().contains("pi"));

        let mut value = valid();
        value["harnesses"]["pi"]["cli"]["version_args"] = serde_json::json!(["--help"]);
        assert!(
            parse_value(&value).is_err(),
            "no field the app does not read"
        );

        let mut value = valid();
        value["harnesses"]["pi"]["rules"]["extra"] = serde_json::json!(true);
        assert!(parse_value(&value).is_err());

        let mut value = valid();
        value["harnesses"]["pi"]
            .as_object_mut()
            .unwrap()
            .remove("rules");
        assert!(parse_value(&value).is_err(), "a light harness has rules");

        let mut value = valid();
        value["extra"] = serde_json::json!(true);
        assert!(parse_value(&value).is_err());

        let mut value = valid();
        value["version"] = serde_json::json!(2);
        assert!(parse_value(&value).unwrap_err().contains("version"));
    }

    #[test]
    fn programs_must_be_bare_names_and_labels_plain_text() {
        for program in [
            "",
            "-h",
            "../pi",
            "/usr/bin/pi",
            "pi --help",
            "pi;ls",
            "Pi",
            "pi.exe",
            &"a".repeat(33),
        ] {
            let mut value = valid();
            value["harnesses"]["pi"]["cli"]["program"] = serde_json::json!(program);
            assert!(parse_value(&value).is_err(), "{program:?}");
        }
        for label in ["", " Pi", "Pi ", "P\ni", "<b>Pi</b>", &"x".repeat(25)] {
            let mut value = valid();
            value["harnesses"]["pi"]["label"] = serde_json::json!(label);
            assert!(parse_value(&value).is_err(), "{label:?}");
        }
    }

    #[test]
    fn rules_targets_are_plain_relative_markdown_files_inside_the_harness_folder() {
        for rel in [
            "",
            "/etc/AGENTS.md",
            "../AGENTS.md",
            ".pi/../AGENTS.md",
            ".pi\\agent\\AGENTS.md",
            "C:/AGENTS.md",
            ".pi//AGENTS.md",
            "./AGENTS.md",
            "AGENTS.md",
            ".pi/agent/AGENTS.txt",
            ".pi/agent/AGENTS md",
            ".pi/agent/auth.json",
            ".pi/agent/settings.json",
            ".pi/agent/mcp.json",
            ".pi/agent/models.json",
            ".copilot/config.json",
            ".copilot/mcp-oauth-config/AGENTS.md",
            ".copilot/mcp-secrets/AGENTS.md",
            ".copilot/sessions/AGENTS.md",
            ".copilot/session-state/AGENTS.md",
            ".copilot/installed-plugins/AGENTS.md",
            ".claude/CLAUDE.md",
            ".claude/rules/pi.md",
            ".codex/AGENTS.md",
            ".cursor/rules/pi.md",
            ".agents/AGENTS.md",
            ".config/opencode/AGENTS.md",
            ".config/kilo/AGENTS.md",
            &format!(".pi/{}/AGENTS.md", "a".repeat(120)),
        ] {
            let mut value = valid();
            value["harnesses"]["pi"]["rules"]["target_rel"] = serde_json::json!(rel);
            assert!(parse_value(&value).is_err(), "{rel:?}");
        }
        let mut value = valid();
        value["harnesses"]["pi"]["rules"]["target_rel"] = serde_json::json!(".pi/agent/RULES.md");
        let pi = &parse_value(&value).expect("another plain file")[1];
        assert_eq!(pi.rules.as_ref().unwrap().file_label, "RULES.md");
    }

    #[test]
    fn the_xdg_flag_needs_a_file_in_a_folder_of_the_config_directory() {
        for rel in [
            ".kilo/AGENTS.md",
            ".config/AGENTS.md",
            ".config2/kilo/AGENTS.md",
        ] {
            let mut value = valid();
            value["harnesses"]["kilo"]["rules"]["target_rel"] = serde_json::json!(rel);
            assert!(parse_value(&value).is_err(), "{rel:?}");
        }
        let mut value = valid();
        value["harnesses"]["kilo"]["rules"]["target_rel"] =
            serde_json::json!(".config/kilo/sub/AGENTS.md");
        assert!(parse_value(&value).is_ok());
    }

    #[test]
    fn two_harnesses_never_share_a_file_or_an_adapter() {
        let mut value = valid();
        value["harnesses"]["kilo"]["rules"]["target_rel"] =
            serde_json::json!(".pi/agent/AGENTS.md");
        value["harnesses"]["kilo"]["rules"]["xdg_config_home"] = serde_json::json!(false);
        assert!(parse_value(&value).is_err());
        let mut value = valid();
        value["harnesses"]["kilo"]["rules"]["adapter"] = serde_json::json!("pi");
        assert!(parse_value(&value).is_err());
        for adapter in ["", "Pi", "../pi", "pi rules", "-pi"] {
            let mut value = valid();
            value["harnesses"]["pi"]["rules"]["adapter"] = serde_json::json!(adapter);
            assert!(parse_value(&value).is_err(), "{adapter:?}");
        }
    }

    #[test]
    fn masked_and_peer_files_are_plain_unique_names_other_than_the_rules_file() {
        for names in [
            serde_json::json!(["../x.md"]),
            serde_json::json!(["a/b.md"]),
            serde_json::json!([""]),
            serde_json::json!(["AGENTS.md"]),
            serde_json::json!(["X.md", "X.md"]),
            serde_json::json!((0..9).map(|n| format!("f{n}.md")).collect::<Vec<_>>()),
        ] {
            for field in ["masked_by", "peer_files"] {
                let mut value = valid();
                value["harnesses"]["pi"]["rules"][field] = names.clone();
                assert!(parse_value(&value).is_err(), "{field} {names}");
            }
        }
    }

    #[test]
    fn a_rules_size_limit_fits_the_bundled_base_and_the_files_the_app_reads() {
        for max in [
            0u64,
            1,
            16 * 1024 - 1,
            crate::rules_block::MAX_RULES_FILE_BYTES + 1,
        ] {
            let mut value = valid();
            value["harnesses"]["antigravity"]["rules"]["max_file_bytes"] = serde_json::json!(max);
            assert!(parse_value(&value).is_err(), "{max}");
        }
        for bad in [serde_json::json!(-1), serde_json::json!("24000")] {
            let mut value = valid();
            value["harnesses"]["antigravity"]["rules"]["max_file_bytes"] = bad.clone();
            assert!(parse_value(&value).is_err(), "{bad}");
        }
        let antigravity = rules_of("antigravity");
        assert!(antigravity.fits(0));
        assert!(antigravity.fits(24_000));
        assert!(!antigravity.fits(24_001));
        assert!(rules_of("pi").fits(10 * 1024 * 1024), "no limit");
        // The bundled base, rendered as a new file, fits with room for refinements.
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../resources/default-workspace")
                .join(&antigravity.source_rel),
        )
        .expect("bundled base");
        let rendered = crate::rules_block::render_new(&source);
        assert!(rendered.len() * 2 < 24_000, "{} bytes", rendered.len());
    }

    #[test]
    fn invalid_json_gives_an_error_not_a_panic() {
        assert!(parse("").is_err());
        assert!(parse("{").is_err());
        assert!(parse("[]").is_err());
    }

    #[test]
    fn a_light_harness_id_refuses_a_central_harness_everywhere() {
        for id in HarnessId::ALL {
            assert_eq!(LightHarnessId::new(*id).is_some(), id.is_light());
            let parsed: Result<LightHarnessId, _> =
                serde_json::from_value(serde_json::json!(id.as_str()));
            assert_eq!(parsed.is_ok(), id.is_light(), "{}", id.as_str());
        }
        let pi = LightHarnessId::new(HarnessId::Pi).expect("light");
        assert_eq!(serde_json::to_string(&pi).unwrap(), "\"pi\"");
        assert_eq!(
            serde_json::from_str::<LightHarnessId>("\"pi\"").unwrap(),
            pi
        );
        assert_eq!(pi.harness(), HarnessId::Pi);
        assert_eq!(
            pi.rules().map(|rules| rules.target_id.as_str()),
            Some("pi_rules")
        );
        assert!(serde_json::from_str::<LightHarnessId>("\"nope\"").is_err());
    }

    #[test]
    fn the_rules_file_is_below_home_and_the_kilo_file_follows_xdg_config_home() {
        let home = Path::new("/home/someone");
        let copilot = rules_of("copilot");
        let pi = rules_of("pi");
        let kilo = rules_of("kilo");
        for xdg in [None, Some(""), Some("  "), Some("/data/config")] {
            assert_eq!(
                copilot.resolve_dest_with(home, xdg),
                home.join(".copilot").join("copilot-instructions.md")
            );
            assert_eq!(
                pi.resolve_dest_with(home, xdg),
                home.join(".pi").join("agent").join("AGENTS.md"),
                "only Kilo follows XDG_CONFIG_HOME"
            );
        }
        for xdg in [None, Some(""), Some("  "), Some("./here")] {
            assert_eq!(
                kilo.resolve_dest_with(home, xdg),
                home.join(".config").join("kilo").join("AGENTS.md")
            );
        }
        assert_eq!(
            kilo.resolve_dest_with(home, Some("/data/config")),
            Path::new("/data/config").join("kilo").join("AGENTS.md")
        );
        // A relative value is not a path the XDG specification allows: it is ignored. So is one
        // that is the file system root or climbs with `..`, which would widen the allowlist.
        for bad in ["relative/dir", "/", "/data/../etc", "/data/config/.."] {
            assert_eq!(
                kilo.resolve_dest_with(home, Some(bad)),
                home.join(".config").join("kilo").join("AGENTS.md"),
                "{bad}"
            );
            assert_eq!(kilo.allowlist_root_with(home, Some(bad)), home, "{bad}");
        }
        assert_eq!(
            kilo.resolve_dest_with(home, Some("/data/config/")),
            Path::new("/data/config").join("kilo").join("AGENTS.md")
        );
    }

    #[test]
    fn the_allowlist_root_is_home_unless_xdg_config_home_holds_the_file_outside_home() {
        let home = Path::new("/home/someone");
        let kilo = rules_of("kilo");
        assert_eq!(kilo.allowlist_root_with(home, None), home);
        assert_eq!(
            kilo.allowlist_root_with(home, Some("/home/someone/dotfiles")),
            home
        );
        assert_eq!(
            kilo.allowlist_root_with(home, Some("/data/config")),
            Path::new("/data/config")
        );
        assert_eq!(kilo.allowlist_root_with(home, Some("rel")), home);
        assert_eq!(
            rules_of("pi").allowlist_root_with(home, Some("/data/config")),
            home
        );
    }

    #[test]
    fn pi_is_masked_by_an_override_and_a_peer_file_blocks_only_a_new_rules_file() {
        let pi = rules_of("pi");
        let dir = temp("preflight");
        let dest = dir.join("AGENTS.md");
        assert_eq!(pi.preflight(&dest), None, "an empty folder");

        std::fs::write(dir.join("AGENTS.override.md"), "x").unwrap();
        assert_eq!(pi.preflight(&dest), Some(RulesConflict::MaskedByOverride));
        std::fs::write(&dest, "x").unwrap();
        assert_eq!(
            pi.preflight(&dest),
            Some(RulesConflict::MaskedByOverride),
            "the override masks an existing file too"
        );
        std::fs::remove_file(dir.join("AGENTS.override.md")).unwrap();
        assert_eq!(pi.preflight(&dest), None);

        std::fs::remove_file(&dest).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "mine").unwrap();
        assert_eq!(pi.preflight(&dest), Some(RulesConflict::PeerContextFile));
        std::fs::write(&dest, "x").unwrap();
        assert_eq!(
            pi.preflight(&dest),
            None,
            "AGENTS.md already wins over CLAUDE.md"
        );

        std::fs::remove_file(&dest).unwrap();
        std::fs::remove_file(dir.join("CLAUDE.md")).unwrap();
        std::fs::create_dir(dir.join("AGENTS.override.md")).unwrap();
        std::fs::create_dir(dir.join("CLAUDE.md")).unwrap();
        assert_eq!(
            pi.preflight(&dest),
            None,
            "a folder is skipped like Pi does"
        );
        let _ = std::fs::remove_dir_all(dir);

        assert_eq!(rules_of("copilot").preflight(Path::new("/nope/x.md")), None);
        assert_eq!(
            rules_of("kilo").preflight(Path::new("/nope/AGENTS.md")),
            None
        );
    }

    // ── The MCP entry ──

    fn mcp_of(key: &str) -> &'static LightMcp {
        &descriptor(
            HarnessId::ALL
                .iter()
                .copied()
                .find(|id| id.as_str() == key)
                .expect("harness id"),
        )
        .expect("light harness")
        .mcp
    }

    #[test]
    fn the_embedded_mcp_sections_pin_every_file_the_app_writes() {
        let summary: Vec<_> = light_harnesses()
            .iter()
            .map(|harness| {
                let mcp = &harness.mcp;
                (
                    mcp.target_id.as_str(),
                    mcp.target_rel.as_str(),
                    mcp.alt_target_rel
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    mcp.root_key.as_str(),
                    mcp.entry_key.as_str(),
                    mcp.template_rel.as_str(),
                    mcp.default_enabled,
                    mcp.xdg_config_home,
                    mcp.private_dir,
                    mcp.surface,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "copilot_mcp",
                    ".copilot/mcp-config.json",
                    vec![],
                    "mcpServers",
                    "playwright",
                    "templates/mcp/copilot.playwright.json",
                    true,
                    false,
                    false,
                    SetupSurfaceId::CopilotMcp
                ),
                (
                    "pi_mcp",
                    ".pi/agent/mcp.json",
                    vec![],
                    "mcpServers",
                    "playwright",
                    "templates/mcp/pi.playwright.json",
                    true,
                    false,
                    true,
                    SetupSurfaceId::PiMcp
                ),
                (
                    "kilo_mcp",
                    ".config/kilo/kilo.jsonc",
                    vec![".config/kilo/kilo.json"],
                    "mcp",
                    "playwright",
                    "templates/mcp/kilo.playwright.json",
                    false,
                    true,
                    false,
                    SetupSurfaceId::KiloMcp
                ),
                (
                    "antigravity_mcp",
                    ".gemini/config/mcp_config.json",
                    vec![],
                    "mcpServers",
                    "playwright",
                    "templates/mcp/antigravity.playwright.json",
                    false,
                    false,
                    false,
                    SetupSurfaceId::AntigravityMcp
                ),
                (
                    "grok_mcp",
                    ".grok/config.toml",
                    vec![],
                    "mcp_servers",
                    "playwright",
                    "templates/mcp/grok.playwright.json",
                    false,
                    false,
                    false,
                    SetupSurfaceId::GrokMcp
                ),
            ]
        );
        assert!(mcp_of("antigravity").notes.is_empty());
        assert!(mcp_of("antigravity").shadowed_by_siblings.is_empty());
        assert_eq!(mcp_of("grok").format, McpFormat::Toml);
        for key in ["copilot", "pi", "kilo", "antigravity"] {
            assert_eq!(mcp_of(key).format, McpFormat::Json, "{key}");
        }
        assert_eq!(
            mcp_for_target("kilo_mcp").map(|harness| harness.id),
            Some(HarnessId::Kilo)
        );
        assert!(mcp_for_target("kilo_rules").is_none());
        assert!(mcp_for_target("cursor_setup").is_none());
        assert_eq!(mcp_of("pi").notes.len(), 1);
        assert!(mcp_of("pi").notes[0].contains("exposure"));
        assert!(mcp_of("copilot").notes.is_empty() && mcp_of("kilo").notes.is_empty());
        assert_eq!(
            mcp_of("kilo").shadowed_by_siblings,
            ["opencode.json", "opencode.jsonc"]
        );
        assert_eq!(
            mcp_of("kilo").shadowed_by_home,
            [".kilo/kilo.json", ".kilo/kilo.jsonc"]
        );
    }

    #[test]
    fn every_mcp_template_exists_in_the_bundle() {
        let resources =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        for harness in light_harnesses() {
            assert!(
                resources.join(&harness.mcp.template_rel).is_file(),
                "{}",
                harness.mcp.template_rel
            );
        }
    }

    #[test]
    fn mcp_files_are_json_files_inside_the_harness_folder_that_the_app_may_write() {
        for rel in [
            "",
            "/etc/mcp.json",
            "../mcp.json",
            ".pi//mcp.json",
            ".pi\\agent\\mcp.json",
            "mcp.json",
            ".pi/agent/mcp.txt",
            ".pi/agent/mcp",
            ".pi/agent/auth.json",
            ".pi/agent/settings.json",
            ".pi/agent/models.json",
            ".pi/agent/models-store.json",
            ".copilot/config.json",
            ".copilot/permissions-config.json",
            ".copilot/mcp-oauth-config/mcp.json",
            ".copilot/mcp-secrets/mcp.json",
            ".copilot/session-state/mcp.json",
            ".copilot/installed-plugins/mcp.json",
            ".claude/mcp.json",
            ".codex/mcp.json",
            ".cursor/mcp.json",
            ".agents/mcp.json",
            ".config/opencode/opencode.json",
            &format!(".pi/{}/mcp.json", "a".repeat(120)),
        ] {
            let mut value = valid();
            value["harnesses"]["pi"]["mcp"]["target_rel"] = serde_json::json!(rel);
            assert!(parse_value(&value).is_err(), "{rel:?}");
        }
        for rel in [
            ".pi/agent/mcp.json",
            ".pi/agent/servers.jsonc",
            ".pi/mcp.json",
        ] {
            let mut value = valid();
            value["harnesses"]["pi"]["mcp"]["target_rel"] = serde_json::json!(rel);
            assert!(parse_value(&value).is_ok(), "{rel:?}");
        }
    }

    #[test]
    fn a_toml_mcp_file_must_be_a_toml_file_the_app_may_write() {
        for rel in [
            ".grok/config.json",
            ".grok/mcp.json",
            ".grok/config",
            "config.toml",
            ".codex/config.toml",
            ".grok/session-state/config.toml",
            "../config.toml",
        ] {
            let mut value = valid();
            value["harnesses"]["grok"]["mcp"]["target_rel"] = serde_json::json!(rel);
            assert!(parse_value(&value).is_err(), "{rel:?}");
        }
        // A JSON harness cannot name a TOML file, and the format is a closed set.
        let mut value = valid();
        value["harnesses"]["pi"]["mcp"]["target_rel"] = serde_json::json!(".pi/agent/mcp.toml");
        assert!(parse_value(&value).is_err());
        let mut value = valid();
        value["harnesses"]["grok"]["mcp"]["format"] = serde_json::json!("yaml");
        assert!(parse_value(&value).is_err());
        // The template stays a JSON file of the bundle.
        let mut value = valid();
        value["harnesses"]["grok"]["mcp"]["template"] =
            serde_json::json!("templates/mcp/grok.playwright.toml");
        assert!(parse_value(&value).is_err());
    }

    #[test]
    fn alternative_mcp_files_are_other_files_of_the_same_folder() {
        for alt in [
            serde_json::json!([".config/kilo/kilo.jsonc"]),
            serde_json::json!([".config/kilo/kilo.json", ".config/kilo/kilo.json"]),
            serde_json::json!([".config/other/kilo.json"]),
            serde_json::json!([".config/kilo/sub/kilo.json"]),
            serde_json::json!([".config/kilo/config.json"]),
            serde_json::json!([".config/kilo/kilo.txt"]),
            serde_json::json!(["../kilo.json"]),
            serde_json::json!((0..9)
                .map(|n| format!(".config/kilo/k{n}.json"))
                .collect::<Vec<_>>()),
        ] {
            let mut value = valid();
            value["harnesses"]["kilo"]["mcp"]["alt_target_rel"] = alt.clone();
            assert!(parse_value(&value).is_err(), "{alt}");
        }
        let mut value = valid();
        value["harnesses"]["kilo"]["mcp"]["alt_target_rel"] = serde_json::json!([]);
        assert!(parse_value(&value).is_ok());
    }

    #[test]
    fn the_mcp_keys_template_and_lists_are_plain() {
        let cases: [(&str, serde_json::Value); 17] = [
            ("root_key", serde_json::json!("")),
            ("root_key", serde_json::json!("a.b")),
            ("root_key", serde_json::json!("mcp servers")),
            ("root_key", serde_json::json!("playwright")),
            ("entry_key", serde_json::json!("")),
            ("entry_key", serde_json::json!("../x")),
            ("entry_key", serde_json::json!("mcpServers")),
            ("template", serde_json::json!("templates/mcp/../x.json")),
            ("template", serde_json::json!("templates/mcp/sub/x.json")),
            ("template", serde_json::json!("templates/sync/pi-rules.md")),
            ("template", serde_json::json!("/templates/mcp/x.json")),
            ("template", serde_json::json!("templates/mcp/x.txt")),
            ("shadowed_by_siblings", serde_json::json!(["a/b.json"])),
            ("shadowed_by_siblings", serde_json::json!(["mcp.json"])),
            ("shadowed_by_home", serde_json::json!(["../x.json"])),
            ("shadowed_by_home", serde_json::json!(["x.json", "x.json"])),
            ("shadowed_by_home", serde_json::json!(["x.json"])),
        ];
        for (field, bad) in cases {
            let mut value = valid();
            value["harnesses"]["pi"]["mcp"][field] = bad.clone();
            assert!(parse_value(&value).is_err(), "{field} {bad}");
        }
        for notes in [
            serde_json::json!([""]),
            serde_json::json!(["<b>x</b>\n"]),
            serde_json::json!([" padded"]),
            serde_json::json!(["caf\u{e9}"]),
            serde_json::json!(["a", "b", "c", "d"]),
            serde_json::json!(["x".repeat(241)]),
        ] {
            let mut value = valid();
            value["harnesses"]["pi"]["mcp"]["notes"] = notes.clone();
            assert!(parse_value(&value).is_err(), "{notes}");
        }
        let mut value = valid();
        value["harnesses"]["pi"]["mcp"]["extra"] = serde_json::json!(true);
        assert!(
            parse_value(&value).is_err(),
            "no field the app does not read"
        );
        let mut value = valid();
        value["harnesses"]["pi"]
            .as_object_mut()
            .unwrap()
            .remove("mcp");
        assert!(
            parse_value(&value).is_err(),
            "a light harness has an mcp section"
        );
    }

    #[test]
    fn the_mcp_xdg_flag_needs_files_in_a_folder_of_the_config_directory() {
        for rel in [
            ".kilo/kilo.jsonc",
            ".config/kilo.jsonc",
            ".config2/kilo/kilo.jsonc",
        ] {
            let mut value = valid();
            value["harnesses"]["kilo"]["mcp"]["target_rel"] = serde_json::json!(rel);
            value["harnesses"]["kilo"]["mcp"]["alt_target_rel"] = serde_json::json!([]);
            assert!(parse_value(&value).is_err(), "{rel:?}");
        }
    }

    #[test]
    fn two_harnesses_never_share_an_mcp_file_or_template() {
        let mut value = valid();
        value["harnesses"]["kilo"]["mcp"]["template"] =
            serde_json::json!("templates/mcp/pi.playwright.json");
        assert!(parse_value(&value).is_err());
        let mut value = valid();
        value["harnesses"]["copilot"]["mcp"]["target_rel"] =
            serde_json::json!(".pi/agent/mcp.json");
        assert!(parse_value(&value).is_err());
    }

    #[test]
    fn the_mcp_file_is_chosen_from_what_exists_kilo_jsonc_first() {
        let kilo = mcp_of("kilo");
        let home = temp("mcp-choice");
        let folder = home.join(".config/kilo");
        let jsonc = folder.join("kilo.jsonc");
        let json = folder.join("kilo.json");
        assert_eq!(
            kilo.resolve_dest_with(&home, None),
            jsonc,
            "nothing exists: create jsonc"
        );

        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&json, "{}").unwrap();
        assert_eq!(
            kilo.resolve_dest_with(&home, None),
            json,
            "only kilo.json exists"
        );
        std::fs::write(&jsonc, "{}").unwrap();
        assert_eq!(
            kilo.resolve_dest_with(&home, None),
            jsonc,
            "both exist: jsonc"
        );
        std::fs::remove_file(&jsonc).unwrap();
        assert_eq!(kilo.resolve_dest_with(&home, None), json);

        // A folder in the way is a file that exists in some form: it is chosen and reported.
        std::fs::remove_file(&json).unwrap();
        std::fs::create_dir(&jsonc).unwrap();
        assert_eq!(kilo.resolve_dest_with(&home, None), jsonc);
        std::fs::remove_dir(&jsonc).unwrap();

        // Harnesses without alternatives always use their one file.
        assert_eq!(
            mcp_of("copilot").resolve_dest_with(&home, None),
            home.join(".copilot/mcp-config.json")
        );
        assert_eq!(
            mcp_of("pi").resolve_dest_with(&home, Some("/data/config")),
            home.join(".pi/agent/mcp.json"),
            "only Kilo follows XDG_CONFIG_HOME"
        );
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_kilo_mcp_file_follows_xdg_config_home_like_the_rules_file() {
        let kilo = mcp_of("kilo");
        let home = temp("mcp-xdg");
        let xdg = temp("mcp-xdg-config");
        let xdg_str = xdg.to_str().unwrap();
        assert_eq!(
            kilo.resolve_dest_with(&home, Some(xdg_str)),
            xdg.join("kilo/kilo.jsonc")
        );
        // The choice looks in the moved folder, not in ~/.config.
        std::fs::create_dir_all(home.join(".config/kilo")).unwrap();
        std::fs::write(home.join(".config/kilo/kilo.json"), "{}").unwrap();
        assert_eq!(
            kilo.resolve_dest_with(&home, Some(xdg_str)),
            xdg.join("kilo/kilo.jsonc")
        );
        std::fs::create_dir_all(xdg.join("kilo")).unwrap();
        std::fs::write(xdg.join("kilo/kilo.json"), "{}").unwrap();
        assert_eq!(
            kilo.resolve_dest_with(&home, Some(xdg_str)),
            xdg.join("kilo/kilo.json")
        );
        // A relative value is ignored.
        assert_eq!(
            kilo.resolve_dest_with(&home, Some("relative")),
            home.join(".config/kilo/kilo.json")
        );
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(xdg);
    }

    #[test]
    fn files_that_win_over_the_kilo_entry_are_named_by_existence_only() {
        let kilo = mcp_of("kilo");
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        std::env::remove_var("XDG_CONFIG_HOME");
        let home = temp("mcp-shadow");
        assert!(kilo.shadowing_files(&home).is_empty());
        std::fs::create_dir_all(home.join(".config/kilo")).unwrap();
        std::fs::create_dir_all(home.join(".kilo")).unwrap();
        std::fs::write(home.join(".config/kilo/opencode.jsonc"), "// secrets").unwrap();
        std::fs::write(home.join(".kilo/kilo.json"), "{}").unwrap();
        // A folder with such a name does not count.
        std::fs::create_dir(home.join(".kilo/kilo.jsonc")).unwrap();
        assert_eq!(
            kilo.shadowing_files(&home),
            ["~/.config/kilo/opencode.jsonc", "~/.kilo/kilo.json"]
        );
        assert!(mcp_of("copilot").shadowing_files(&home).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_light_harness_id_resolves_its_mcp_entry_and_surface() {
        let pi = LightHarnessId::new(HarnessId::Pi).expect("light");
        assert_eq!(pi.mcp().map(|mcp| mcp.target_id.as_str()), Some("pi_mcp"));
        assert_eq!(pi.mcp_surface(), SetupSurfaceId::PiMcp);
        assert_eq!(pi.rules_surface(), SetupSurfaceId::PiRules);
    }
}
