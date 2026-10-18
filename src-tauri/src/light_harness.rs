//! The light tier: GitHub Copilot, Pi and Kilo Code.
//!
//! A light harness gets the shared skills (through the folders it reads, see
//! [`crate::skill_roots`]), one managed rules block and a runtime health row set. Install facts
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
/// Where the generated rules bases live in the bundle (`scripts/generate-agent-rules.py`).
const RULES_SOURCE_DIR: &str = "templates/sync";
/// `$XDG_CONFIG_HOME` stands in for this folder of the home directory.
const XDG_CONFIG_DEFAULT: &str = ".config/";

/// Files a descriptor may never name as a rules target: the harnesses keep credentials, state and
/// permissions in them.
const DENIED_FILE_NAMES: &[&str] = &[
    "config.json",
    "settings.json",
    "auth.json",
    "models.json",
    "models-store.json",
    "providers.json",
    "permissions-config.json",
    "lsp-config.json",
    "mcp.json",
    "mcp-config.json",
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
    rules: RawRules,
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
}

/// One light harness as the descriptor describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightHarness {
    pub id: HarnessId,
    /// Display name: the tab, the page title and messages.
    pub label: String,
    /// The CLI program name looked up on `PATH`; the only call made to it is `--version`.
    pub cli_program: String,
    /// The managed rules block.
    pub rules: LightRules,
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

    /// The rules block of the harness, with the same caveat as [`Self::descriptor`].
    pub fn rules(self) -> Option<&'static LightRules> {
        self.descriptor().map(|harness| &harness.rules)
    }

    /// The setup surface that owns the harness's rules file. `parse` refuses a descriptor for a
    /// light harness that has none, so the fallback is unreachable in a build whose tests pass.
    pub fn rules_surface(self) -> SetupSurfaceId {
        SetupSurfaceId::light_rules(self.0).unwrap_or(SetupSurfaceId::WorkspaceBundle)
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
        if let Some(dir) = self.xdg_dir(xdg_config_home) {
            // `parse` guarantees the default location starts with `.config/`.
            let rest = self
                .target_rel
                .strip_prefix(XDG_CONFIG_DEFAULT)
                .unwrap_or(&self.target_rel);
            return join_rel(dir, rest);
        }
        join_rel(home.to_path_buf(), &self.target_rel)
    }

    /// The rules file as people know it: `~/...`, or `$XDG_CONFIG_HOME/...` for a file that lives
    /// outside the home directory.
    pub fn display_path(&self, home: &Path) -> String {
        let dest = self.resolve_dest(home);
        if let Ok(rel) = dest.strip_prefix(home) {
            return format!("~/{}", rel.to_string_lossy().replace('\\', "/"));
        }
        match self.target_rel.strip_prefix(XDG_CONFIG_DEFAULT) {
            Some(rest) if self.xdg_config_home => format!("$XDG_CONFIG_HOME/{rest}"),
            _ => format!("~/{}", self.target_rel),
        }
    }

    fn xdg_dir(&self, xdg_config_home: Option<&str>) -> Option<PathBuf> {
        if !self.xdg_config_home {
            return None;
        }
        xdg_config_home
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
    }

    /// The folder the file must stay inside when it is written, backed up, restored or removed:
    /// `home`, or `$XDG_CONFIG_HOME` when the file lives there outside `home`.
    pub fn allowlist_root(&self, home: &Path) -> PathBuf {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        self.allowlist_root_with(home, xdg.as_deref())
    }

    fn allowlist_root_with(&self, home: &Path, xdg_config_home: Option<&str>) -> PathBuf {
        let dest = self.resolve_dest_with(home, xdg_config_home);
        if dest.starts_with(home) {
            return home.to_path_buf();
        }
        self.xdg_dir(xdg_config_home)
            .filter(|dir| dest.starts_with(dir))
            .unwrap_or_else(|| home.to_path_buf())
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

fn join_rel(base: PathBuf, rel: &str) -> PathBuf {
    rel.split('/').fold(base, |path, part| path.join(part))
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
    own: &str,
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    if names.len() > MAX_FILE_NAMES {
        return Err(format!(
            "{key}: rules.{field} lists more than {MAX_FILE_NAMES} files"
        ));
    }
    for name in &names {
        if !is_plain_name(name) || name == own || !seen.insert(name.as_str()) {
            return Err(format!(
                "{key}: rules.{field} has an entry that is not a plain, unique file name"
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
    let masked_by = parse_file_names(key, "masked_by", raw.masked_by, &file_label)?;
    let peer_files = parse_file_names(key, "peer_files", raw.peer_files, &file_label)?;
    let shadows = match raw.shadows {
        None => None,
        Some(shadowed) if is_plain_rel(&shadowed) && shadowed != rel => {
            Some(format!("~/{shadowed}"))
        }
        Some(_) => return Err(format!("{key}: rules.shadows is not a plain relative path")),
    };
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
        surface,
    })
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
        by_id.insert(
            id.as_str(),
            LightHarness {
                id,
                label: harness.label,
                cli_program: harness.cli.program,
                rules: parse_rules(id, harness.rules)?,
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
    // Two harnesses never share a rules file, a base or a history folder.
    let mut files = HashSet::new();
    let mut adapters = HashSet::new();
    for harness in &ordered {
        if !files.insert(harness.rules.target_rel.as_str())
            || !adapters.insert(harness.rules.adapter.as_str())
        {
            return Err(format!(
                "{}: rules.target_rel or rules.adapter is used by another harness",
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

/// The light harness whose rules toggle is `target_id`.
pub fn rules_for_target(target_id: &str) -> Option<&'static LightHarness> {
    light_harnesses()
        .iter()
        .find(|harness| harness.rules.target_id == target_id)
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
        &descriptor(
            HarnessId::ALL
                .iter()
                .copied()
                .find(|id| id.as_str() == key)
                .expect("harness id"),
        )
        .expect("light harness")
        .rules
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
            ]
        );
        assert_eq!(light_harnesses(), harnesses.as_slice());
    }

    #[test]
    fn the_embedded_rules_sections_pin_every_target_the_app_writes() {
        let summary: Vec<_> = light_harnesses()
            .iter()
            .map(|harness| {
                let rules = &harness.rules;
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
            ]
        );
        assert_eq!(rules_of("pi").masked_by, ["AGENTS.override.md"]);
        assert_eq!(
            rules_of("pi").peer_files,
            ["CLAUDE.md", "CLAUDE.MD", "AGENTS.MD"]
        );
        for key in ["copilot", "kilo"] {
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
            let entry = &adapters["harnesses"][&harness.rules.adapter];
            assert_eq!(
                entry["output"],
                serde_json::json!(harness.rules.source_rel),
                "{}",
                harness.id.as_str()
            );
            let appendix = entry["appendix"].as_str().expect("appendix path");
            assert!(resources.join(appendix).is_file(), "{appendix}");
            assert!(
                resources.join(&harness.rules.source_rel).is_file(),
                "{}",
                harness.rules.source_rel
            );
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
            rules_for_target("pi_rules").map(|harness| harness.id),
            Some(HarnessId::Pi)
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
        assert_eq!(pi.rules.file_label, "RULES.md");
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
        // A relative value is not a path the XDG specification allows: it is ignored.
        assert_eq!(
            kilo.resolve_dest_with(home, Some("relative/dir")),
            home.join(".config").join("kilo").join("AGENTS.md")
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
}
