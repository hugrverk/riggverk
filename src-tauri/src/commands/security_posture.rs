//! Read-only security posture of a harness: which named permission and sandbox keys its global
//! config file sets.
//!
//! This is a separate module on purpose. `claude_runtime` promises it never reads settings files
//! (its test `health_does_not_read_mcp_or_settings` pins that), and the health of a managed surface
//! must stay cheap and credential-free. The posture is its own opt-in read of a few named keys.
//!
//! What it reads: the global config files named in [`compute`] (Claude `settings.json`, Codex
//! `config.toml` in `CODEX_HOME`, OpenCode `opencode.json`/`opencode.jsonc`/`config.json`, Cursor
//! `sandbox.json`, the Kilo config). Each file is read once, capped at 1 MiB, parsed in memory,
//! reduced to a few booleans, enums and counts, and dropped. Those files can hold provider keys, so
//! nothing of their text is ever formatted, logged, stored or returned: parse errors are mapped to
//! `()` without formatting (TOML errors quote the source), the wire types below hold only fixed
//! codes, static file names and small counts, and this module has no `println!`, `eprintln!`,
//! `dbg!` or log call. A file that cannot be read or parsed is reported as `unreadable` and
//! produces no finding.
//!
//! What it does not see: project config, managed config, profiles, command-line flags, aliases and
//! environment overrides. A result therefore never says "secure": the frontend shows only risky,
//! enforced-by-config, advice-only and not-covered rows, plus a fixed `config only` row.
//!
//! Keys checked against the vendor docs on 2026-10-28:
//! - Claude Code: <https://code.claude.com/docs/en/permissions>, `/settings`, `/sandboxing`
//!   (`permissions.defaultMode`, `permissions.disableBypassPermissionsMode`, `permissions.deny`,
//!   `sandbox.enabled`, `CLAUDE_CONFIG_DIR`).
//! - Codex: <https://learn.chatgpt.com> config reference and agent approvals and security
//!   (`sandbox_mode`, `approval_policy`, `sandbox_workspace_write.network_access`,
//!   `projects.<path>.trust_level`).
//! - OpenCode: <https://opencode.ai/docs/permissions> (`permission`, `permission.bash`,
//!   `permission.read`).
//! - Cursor: <https://cursor.com/docs/reference/sandbox> (`sandbox.json` `type`,
//!   `networkPolicy.default`) and `/docs/agent/security/run-modes` (run mode is a setting, not a
//!   file).
//! - Kilo: <https://kilo.ai/docs/customize/agent-permissions> (`permission`).
//! - Copilot CLI: <https://docs.github.com> "allowing tools"; per-session flags only.

use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::agent_targets::{self, HarnessId};
use crate::light_harness;

/// The biggest config file the posture check reads. Real ones are a few kilobytes.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// How a finding should be shown. `Enforced` means "set in the config file read", never "safe".
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PostureLevel {
    Risky,
    Enforced,
    Advice,
    NotCovered,
}

/// What happened to one config file.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Read,
    Missing,
    Unreadable,
    NotChecked,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PostureSource {
    pub file: &'static str,
    pub state: SourceState,
}

/// Every finding the check can produce. The frontend owns the phrase for each code
/// (`src/lib/securityPostureRows.ts`); a parity test keeps the two lists equal.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingCode {
    ClaudeBypassDisabled,
    ClaudeBypassDefault,
    ClaudeBypassAvailable,
    ClaudeSandboxOn,
    ClaudeSandboxOff,
    ClaudeEnvReadDenied,
    ClaudeEnvReadOpen,
    ClaudeConfigDirSet,
    CodexNoSandbox,
    CodexSandboxWorkspace,
    CodexSandboxReadOnly,
    CodexSandboxUnset,
    CodexApprovalsNever,
    CodexApprovalsOnRequest,
    CodexNetworkOn,
    CodexTrustedProjects,
    OpencodeAllowAll,
    OpencodeBashAllow,
    OpencodeDenyRules,
    OpencodeDenyRulesMissing,
    CursorSandboxOff,
    CursorNetworkOpen,
    CursorRunMode,
    KiloAllowAll,
    KiloBashAllow,
    KiloNoRules,
    CopilotNotCovered,
    PiNotCovered,
    GrokNotCovered,
    ConfigOnly,
    AntigravityNotCovered,
}

impl FindingCode {
    const fn level(self) -> PostureLevel {
        use FindingCode::*;
        match self {
            ClaudeBypassDefault | CodexNoSandbox | CodexApprovalsNever | CodexNetworkOn
            | OpencodeAllowAll | OpencodeBashAllow | CursorSandboxOff | CursorNetworkOpen
            | KiloAllowAll | KiloBashAllow => PostureLevel::Risky,
            ClaudeBypassDisabled
            | ClaudeSandboxOn
            | ClaudeEnvReadDenied
            | CodexSandboxWorkspace
            | CodexSandboxReadOnly
            | CodexApprovalsOnRequest
            | OpencodeDenyRules => PostureLevel::Enforced,
            ClaudeBypassAvailable
            | ClaudeSandboxOff
            | ClaudeEnvReadOpen
            | CodexSandboxUnset
            | CodexTrustedProjects
            | OpencodeDenyRulesMissing
            | KiloNoRules => PostureLevel::Advice,
            ClaudeConfigDirSet
            | CursorRunMode
            | CopilotNotCovered
            | PiNotCovered
            | GrokNotCovered
            | ConfigOnly
            | AntigravityNotCovered => PostureLevel::NotCovered,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PostureFinding {
    pub code: FindingCode,
    pub level: PostureLevel,
    pub file: Option<&'static str>,
    pub count: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SecurityPosture {
    pub harness: &'static str,
    pub sources: Vec<PostureSource>,
    pub findings: Vec<PostureFinding>,
}

/// Where the config files are. The command fills it from the environment; tests pass temp dirs.
pub struct Inputs {
    pub home: PathBuf,
    pub codex_home: PathBuf,
    pub opencode_dir: PathBuf,
    pub cursor_root: PathBuf,
    pub kilo_file: PathBuf,
    pub claude_config_dir_set: bool,
}

enum FileRead {
    Missing,
    Unreadable,
    Text(String),
}

/// Reads a regular file of at most [`MAX_CONFIG_BYTES`] bytes of UTF-8. Symlinks are followed.
/// Everything else (directory, FIFO, too large, bad UTF-8, permission error) is `Unreadable`.
fn read_capped(path: &Path) -> FileRead {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return FileRead::Missing,
        Err(_) => return FileRead::Unreadable,
    };
    if !meta.is_file() || meta.len() > MAX_CONFIG_BYTES {
        return FileRead::Unreadable;
    }
    let Ok(file) = fs::File::open(path) else {
        return FileRead::Unreadable;
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_CONFIG_BYTES
    {
        return FileRead::Unreadable;
    }
    match String::from_utf8(bytes) {
        Ok(text) => FileRead::Text(text),
        Err(_) => FileRead::Unreadable,
    }
}

/// Reads and reduces one file. A missing file reduces to the defaults; an unreadable or unparsable
/// one to `None`, with no text kept.
fn load<T: Default>(
    path: &Path,
    parse: impl FnOnce(&str) -> Option<T>,
) -> (SourceState, Option<T>) {
    match read_capped(path) {
        FileRead::Missing => (SourceState::Missing, Some(T::default())),
        FileRead::Unreadable => (SourceState::Unreadable, None),
        FileRead::Text(text) => match parse(&text) {
            Some(facts) => (SourceState::Read, Some(facts)),
            None => (SourceState::Unreadable, None),
        },
    }
}

fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).map_err(|_| ()).ok()
}

fn parse_jsonc(text: &str) -> Option<Value> {
    crate::jsonc::parse(text).map(|parsed| parsed.value)
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

// ---- Claude ----------------------------------------------------------------------------------

#[derive(Default)]
struct ClaudeFacts {
    bypass_disabled: bool,
    bypass_default: bool,
    sandbox_on: bool,
    env_read_denied: bool,
}

fn claude_facts(text: &str) -> Option<ClaudeFacts> {
    let value = parse_json(text)?;
    let bypass_disabled =
        str_at(&value, &["permissions", "disableBypassPermissionsMode"]) == Some("disable");
    let env_read_denied = value
        .get("permissions")
        .and_then(|p| p.get("deny"))
        .and_then(Value::as_array)
        .is_some_and(|rules| {
            rules
                .iter()
                .filter_map(Value::as_str)
                .any(|rule| rule.starts_with("Read") && rule.contains(".env"))
        });
    Some(ClaudeFacts {
        bypass_disabled,
        bypass_default: !bypass_disabled
            && str_at(&value, &["permissions", "defaultMode"]) == Some("bypassPermissions"),
        sandbox_on: value
            .get("sandbox")
            .and_then(|s| s.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true),
        env_read_denied,
    })
}

const CLAUDE_FILE: &str = "~/.claude/settings.json";

fn claude(inputs: &Inputs, out: &mut Out) {
    if inputs.claude_config_dir_set {
        out.source(CLAUDE_FILE, SourceState::NotChecked);
        out.add(FindingCode::ClaudeConfigDirSet, None, None);
        return;
    }
    let (state, facts) = load(&inputs.home.join(".claude/settings.json"), claude_facts);
    out.source(CLAUDE_FILE, state);
    let Some(facts) = facts else { return };
    out.add(
        if facts.bypass_disabled {
            FindingCode::ClaudeBypassDisabled
        } else if facts.bypass_default {
            FindingCode::ClaudeBypassDefault
        } else {
            FindingCode::ClaudeBypassAvailable
        },
        None,
        None,
    );
    out.add(
        if facts.sandbox_on {
            FindingCode::ClaudeSandboxOn
        } else {
            FindingCode::ClaudeSandboxOff
        },
        None,
        None,
    );
    out.add(
        if facts.env_read_denied {
            FindingCode::ClaudeEnvReadDenied
        } else {
            FindingCode::ClaudeEnvReadOpen
        },
        None,
        None,
    );
}

// ---- Codex -----------------------------------------------------------------------------------

#[derive(Default, PartialEq)]
enum CodexSandbox {
    #[default]
    Unset,
    Danger,
    Workspace,
    ReadOnly,
    Other,
}

#[derive(Default)]
struct CodexFacts {
    sandbox: CodexSandbox,
    approvals_never: bool,
    approvals_on_request: bool,
    network_on: bool,
    trusted: u32,
}

fn codex_facts(text: &str) -> Option<CodexFacts> {
    let value: toml::Value = toml::from_str(text).map_err(|_| ()).ok()?;
    let sandbox = match value.get("sandbox_mode") {
        None => CodexSandbox::Unset,
        Some(mode) => match mode.as_str() {
            Some("danger-full-access") => CodexSandbox::Danger,
            Some("workspace-write") => CodexSandbox::Workspace,
            Some("read-only") => CodexSandbox::ReadOnly,
            _ => CodexSandbox::Other,
        },
    };
    let approval = value.get("approval_policy").and_then(toml::Value::as_str);
    let trusted = value
        .get("projects")
        .and_then(toml::Value::as_table)
        .map(|projects| {
            projects
                .values()
                .filter(|project| {
                    project.get("trust_level").and_then(toml::Value::as_str) == Some("trusted")
                })
                .count()
        })
        .unwrap_or(0);
    Some(CodexFacts {
        sandbox,
        approvals_never: approval == Some("never"),
        approvals_on_request: approval == Some("on-request"),
        network_on: value
            .get("sandbox_workspace_write")
            .and_then(|s| s.get("network_access"))
            .and_then(toml::Value::as_bool)
            == Some(true),
        trusted: u32::try_from(trusted).unwrap_or(u32::MAX),
    })
}

fn codex(inputs: &Inputs, out: &mut Out) {
    let file = if inputs.codex_home == inputs.home.join(".codex") {
        "~/.codex/config.toml"
    } else {
        "$CODEX_HOME/config.toml"
    };
    let (state, facts) = load(&inputs.codex_home.join("config.toml"), codex_facts);
    out.source(file, state);
    let Some(facts) = facts else { return };
    match facts.sandbox {
        CodexSandbox::Danger => out.add(FindingCode::CodexNoSandbox, None, None),
        CodexSandbox::Workspace => out.add(FindingCode::CodexSandboxWorkspace, None, None),
        CodexSandbox::ReadOnly => out.add(FindingCode::CodexSandboxReadOnly, None, None),
        CodexSandbox::Unset => out.add(FindingCode::CodexSandboxUnset, None, None),
        CodexSandbox::Other => {}
    }
    if facts.approvals_never {
        out.add(FindingCode::CodexApprovalsNever, None, None);
    } else if facts.approvals_on_request {
        out.add(FindingCode::CodexApprovalsOnRequest, None, None);
    }
    if facts.network_on {
        out.add(FindingCode::CodexNetworkOn, None, None);
    }
    if facts.trusted > 0 {
        out.add(FindingCode::CodexTrustedProjects, None, Some(facts.trusted));
    }
}

// ---- OpenCode and Kilo (`permission` block) -------------------------------------------------

#[derive(Default)]
struct PermissionFacts {
    allow_all: bool,
    bash_allow: bool,
    deny_rules: u32,
}

/// `value` is `"allow"`, or an object whose `*` is `"allow"`.
fn allows_everything(value: &Value) -> bool {
    value.as_str() == Some("allow") || value.get("*").and_then(Value::as_str) == Some("allow")
}

/// Number of `"deny"` actions in a permission entry: the string itself, or the values of its
/// pattern object.
fn deny_actions(value: Option<&Value>) -> u32 {
    let count = match value {
        Some(Value::String(action)) => usize::from(action == "deny"),
        Some(Value::Object(patterns)) => patterns
            .values()
            .filter(|action| action.as_str() == Some("deny"))
            .count(),
        _ => 0,
    };
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn opencode_facts(text: &str) -> Option<PermissionFacts> {
    let value = parse_jsonc(text)?;
    let Some(permission) = value.get("permission") else {
        return Some(PermissionFacts::default());
    };
    Some(PermissionFacts {
        allow_all: allows_everything(permission),
        bash_allow: permission.get("bash").is_some_and(allows_everything),
        deny_rules: deny_actions(permission.get("bash"))
            .saturating_add(deny_actions(permission.get("read"))),
    })
}

fn kilo_facts(text: &str) -> Option<PermissionFacts> {
    let value = parse_jsonc(text)?;
    let Some(permission) = value.get("permission") else {
        return Some(PermissionFacts::default());
    };
    Some(PermissionFacts {
        allow_all: permission.get("*").and_then(Value::as_str) == Some("allow"),
        bash_allow: permission.get("bash").and_then(Value::as_str) == Some("allow"),
        deny_rules: 0,
    })
}

const OPENCODE_FILES: [&str; 3] = ["opencode.json", "opencode.jsonc", "config.json"];

fn opencode(inputs: &Inputs, out: &mut Out) {
    let mut allow_all = None;
    let mut bash_allow = None;
    let mut deny_rules = None;
    for name in OPENCODE_FILES {
        let (state, facts) = load(&inputs.opencode_dir.join(name), opencode_facts);
        out.source(name, state);
        let Some(facts) = facts else { continue };
        if facts.allow_all && allow_all.is_none() {
            allow_all = Some(name);
        }
        if facts.bash_allow && bash_allow.is_none() {
            bash_allow = Some(name);
        }
        if name == "opencode.json" {
            deny_rules = Some(facts.deny_rules);
        }
    }
    if let Some(file) = allow_all {
        out.add(FindingCode::OpencodeAllowAll, Some(file), None);
    }
    if let Some(file) = bash_allow {
        out.add(FindingCode::OpencodeBashAllow, Some(file), None);
    }
    match deny_rules {
        Some(count) if count > 0 => out.add(FindingCode::OpencodeDenyRules, None, Some(count)),
        Some(_) => out.add(FindingCode::OpencodeDenyRulesMissing, None, None),
        None => {}
    }
}

fn kilo(inputs: &Inputs, out: &mut Out) {
    let file = if inputs.kilo_file.file_name().and_then(|name| name.to_str()) == Some("kilo.json") {
        "kilo.json"
    } else {
        "kilo.jsonc"
    };
    let (state, facts) = load(&inputs.kilo_file, kilo_facts);
    out.source(file, state);
    let Some(facts) = facts else { return };
    if facts.allow_all {
        out.add(FindingCode::KiloAllowAll, Some(file), None);
    }
    if facts.bash_allow {
        out.add(FindingCode::KiloBashAllow, Some(file), None);
    }
    if !facts.allow_all && !facts.bash_allow {
        out.add(FindingCode::KiloNoRules, None, None);
    }
}

// ---- Cursor ----------------------------------------------------------------------------------

#[derive(Default)]
struct CursorFacts {
    sandbox_off: bool,
    network_open: bool,
}

fn cursor_facts(text: &str) -> Option<CursorFacts> {
    let value = parse_jsonc(text)?;
    Some(CursorFacts {
        sandbox_off: str_at(&value, &["type"]) == Some("insecure_none"),
        network_open: str_at(&value, &["networkPolicy", "default"]) == Some("allow"),
    })
}

fn cursor(inputs: &Inputs, out: &mut Out) {
    let (state, facts) = load(&inputs.cursor_root.join("sandbox.json"), cursor_facts);
    out.source("~/.cursor/sandbox.json", state);
    if let Some(facts) = facts {
        if facts.sandbox_off {
            out.add(FindingCode::CursorSandboxOff, None, None);
        }
        if facts.network_open {
            out.add(FindingCode::CursorNetworkOpen, None, None);
        }
    }
    out.add(FindingCode::CursorRunMode, None, None);
}

// ---- Result ----------------------------------------------------------------------------------

struct Out {
    sources: Vec<PostureSource>,
    findings: Vec<PostureFinding>,
}

impl Out {
    fn source(&mut self, file: &'static str, state: SourceState) {
        self.sources.push(PostureSource { file, state });
    }

    fn add(&mut self, code: FindingCode, file: Option<&'static str>, count: Option<u32>) {
        self.findings.push(PostureFinding {
            code,
            level: code.level(),
            file,
            count,
        });
    }
}

/// The posture of `harness` for the files below `inputs`. Pure apart from reading those files.
pub fn compute(harness: HarnessId, inputs: &Inputs) -> SecurityPosture {
    let mut out = Out {
        sources: Vec::new(),
        findings: Vec::new(),
    };
    match harness {
        HarnessId::Claude => claude(inputs, &mut out),
        HarnessId::Codex => codex(inputs, &mut out),
        HarnessId::OpenCode => opencode(inputs, &mut out),
        HarnessId::Cursor => cursor(inputs, &mut out),
        HarnessId::Kilo => kilo(inputs, &mut out),
        HarnessId::Copilot => out.add(FindingCode::CopilotNotCovered, None, None),
        HarnessId::Pi => out.add(FindingCode::PiNotCovered, None, None),
        HarnessId::Antigravity => out.add(FindingCode::AntigravityNotCovered, None, None),
        HarnessId::Grok => out.add(FindingCode::GrokNotCovered, None, None),
    }
    if !matches!(
        harness,
        HarnessId::Copilot | HarnessId::Pi | HarnessId::Antigravity | HarnessId::Grok
    ) {
        out.add(FindingCode::ConfigOnly, None, None);
    }
    SecurityPosture {
        harness: harness.as_str(),
        sources: out.sources,
        findings: out.findings,
    }
}

fn inputs_from_env(home: PathBuf) -> Inputs {
    let kilo_file = light_harness::descriptor(HarnessId::Kilo)
        .map(|descriptor| descriptor.mcp.resolve_dest(&home))
        .unwrap_or_else(|| home.join(".config/kilo/kilo.jsonc"));
    Inputs {
        codex_home: crate::agent_skill_targets::codex_home(&home),
        opencode_dir: crate::platform_paths::opencode_config_dir(&home),
        cursor_root: home.join(".cursor"),
        kilo_file,
        claude_config_dir_set: std::env::var("CLAUDE_CONFIG_DIR")
            .is_ok_and(|value| !value.trim().is_empty()),
        home,
    }
}

#[tauri::command(async)]
pub fn get_security_posture(harness: HarnessId) -> Result<SecurityPosture, String> {
    let home = agent_targets::home_dir()?;
    Ok(compute(harness, &inputs_from_env(home)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const MARKER: &str = "SECRET-MARKER";

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!("aw-posture-{label}-{nonce}"));
            fs::create_dir_all(&root).expect("create fixture root");
            Self { root }
        }

        fn inputs(&self) -> Inputs {
            Inputs {
                home: self.root.clone(),
                codex_home: self.root.join(".codex"),
                opencode_dir: self.root.join(".config/opencode"),
                cursor_root: self.root.join(".cursor"),
                kilo_file: self.root.join(".config/kilo/kilo.jsonc"),
                claude_config_dir_set: false,
            }
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, text).expect("write fixture");
        }

        fn posture(&self, harness: HarnessId) -> SecurityPosture {
            compute(harness, &self.inputs())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn codes(posture: &SecurityPosture) -> Vec<FindingCode> {
        posture.findings.iter().map(|f| f.code).collect()
    }

    fn has(posture: &SecurityPosture, code: FindingCode) -> bool {
        codes(posture).contains(&code)
    }

    fn any_risky(posture: &SecurityPosture) -> bool {
        posture
            .findings
            .iter()
            .any(|f| f.level == PostureLevel::Risky)
    }

    fn state(posture: &SecurityPosture, file: &str) -> SourceState {
        posture
            .sources
            .iter()
            .find(|s| s.file == file)
            .expect("source listed")
            .state
    }

    fn wire(posture: &SecurityPosture) -> String {
        serde_json::to_string(posture).expect("serialize")
    }

    const ALL_CODES: [FindingCode; 31] = [
        FindingCode::ClaudeBypassDisabled,
        FindingCode::ClaudeBypassDefault,
        FindingCode::ClaudeBypassAvailable,
        FindingCode::ClaudeSandboxOn,
        FindingCode::ClaudeSandboxOff,
        FindingCode::ClaudeEnvReadDenied,
        FindingCode::ClaudeEnvReadOpen,
        FindingCode::ClaudeConfigDirSet,
        FindingCode::CodexNoSandbox,
        FindingCode::CodexSandboxWorkspace,
        FindingCode::CodexSandboxReadOnly,
        FindingCode::CodexSandboxUnset,
        FindingCode::CodexApprovalsNever,
        FindingCode::CodexApprovalsOnRequest,
        FindingCode::CodexNetworkOn,
        FindingCode::CodexTrustedProjects,
        FindingCode::OpencodeAllowAll,
        FindingCode::OpencodeBashAllow,
        FindingCode::OpencodeDenyRules,
        FindingCode::OpencodeDenyRulesMissing,
        FindingCode::CursorSandboxOff,
        FindingCode::CursorNetworkOpen,
        FindingCode::CursorRunMode,
        FindingCode::KiloAllowAll,
        FindingCode::KiloBashAllow,
        FindingCode::KiloNoRules,
        FindingCode::CopilotNotCovered,
        FindingCode::PiNotCovered,
        FindingCode::GrokNotCovered,
        FindingCode::ConfigOnly,
        FindingCode::AntigravityNotCovered,
    ];

    #[test]
    fn claude_findings_follow_the_named_keys() {
        let f = Fixture::new("claude");
        f.write(
            ".claude/settings.json",
            r#"{"permissions":{"defaultMode":"bypassPermissions","deny":["Read(./.env)"]},"sandbox":{"enabled":true}}"#,
        );
        let p = f.posture(HarnessId::Claude);
        assert!(has(&p, FindingCode::ClaudeBypassDefault));
        assert!(has(&p, FindingCode::ClaudeSandboxOn));
        assert!(has(&p, FindingCode::ClaudeEnvReadDenied));
        assert!(has(&p, FindingCode::ConfigOnly));
        assert_eq!(codes(&p).last(), Some(&FindingCode::ConfigOnly));
        assert_eq!(state(&p, CLAUDE_FILE), SourceState::Read);

        f.write(
            ".claude/settings.json",
            r#"{"permissions":{"defaultMode":"bypassPermissions","disableBypassPermissionsMode":"disable"}}"#,
        );
        let p = f.posture(HarnessId::Claude);
        assert!(has(&p, FindingCode::ClaudeBypassDisabled));
        assert!(!has(&p, FindingCode::ClaudeBypassDefault));
        assert!(has(&p, FindingCode::ClaudeSandboxOff));
        assert!(has(&p, FindingCode::ClaudeEnvReadOpen));
        assert!(!any_risky(&p));

        f.write(".claude/settings.json", "{}");
        let p = f.posture(HarnessId::Claude);
        assert!(has(&p, FindingCode::ClaudeBypassAvailable));
        assert!(!any_risky(&p));
    }

    #[test]
    fn claude_env_deny_needs_a_read_rule_naming_env() {
        let f = Fixture::new("claude-env");
        f.write(
            ".claude/settings.json",
            r#"{"permissions":{"deny":["Bash(rm:*)","Edit(./.env)"]}}"#,
        );
        assert!(has(
            &f.posture(HarnessId::Claude),
            FindingCode::ClaudeEnvReadOpen
        ));
    }

    #[test]
    fn claude_config_dir_skips_the_read_even_with_a_risky_file() {
        let f = Fixture::new("claude-dir");
        f.write(
            ".claude/settings.json",
            r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#,
        );
        let mut inputs = f.inputs();
        inputs.claude_config_dir_set = true;
        let p = compute(HarnessId::Claude, &inputs);
        assert_eq!(state(&p, CLAUDE_FILE), SourceState::NotChecked);
        assert!(has(&p, FindingCode::ClaudeConfigDirSet));
        assert!(!has(&p, FindingCode::ClaudeBypassDefault));
        assert!(!any_risky(&p));
    }

    #[test]
    fn codex_findings_follow_the_named_keys() {
        let f = Fixture::new("codex");
        f.write(
            ".codex/config.toml",
            "sandbox_mode = \"danger-full-access\"\napproval_policy = \"never\"\n[sandbox_workspace_write]\nnetwork_access = true\n",
        );
        let p = f.posture(HarnessId::Codex);
        assert!(has(&p, FindingCode::CodexNoSandbox));
        assert!(has(&p, FindingCode::CodexApprovalsNever));
        assert!(has(&p, FindingCode::CodexNetworkOn));
        assert_eq!(state(&p, "~/.codex/config.toml"), SourceState::Read);

        f.write(
            ".codex/config.toml",
            "sandbox_mode = \"workspace-write\"\napproval_policy = \"on-request\"\n",
        );
        let p = f.posture(HarnessId::Codex);
        assert!(has(&p, FindingCode::CodexSandboxWorkspace));
        assert!(has(&p, FindingCode::CodexApprovalsOnRequest));
        assert!(!any_risky(&p));

        f.write(".codex/config.toml", "sandbox_mode = \"read-only\"\n");
        assert!(has(
            &f.posture(HarnessId::Codex),
            FindingCode::CodexSandboxReadOnly
        ));

        f.write(
            ".codex/config.toml",
            "approval_policy = { granular = { sandbox_approval = true } }\n",
        );
        let p = f.posture(HarnessId::Codex);
        assert!(has(&p, FindingCode::CodexSandboxUnset));
        assert!(!has(&p, FindingCode::CodexApprovalsNever));
        assert!(!has(&p, FindingCode::CodexApprovalsOnRequest));
    }

    #[test]
    fn codex_counts_only_trusted_projects() {
        let f = Fixture::new("codex-trust");
        f.write(
            ".codex/config.toml",
            "[projects.\"/a\"]\ntrust_level = \"trusted\"\n[projects.\"/b\"]\ntrust_level = \"trusted\"\n[projects.\"/c\"]\ntrust_level = \"untrusted\"\n[projects.\"/d\"]\nname = \"x\"\n",
        );
        let p = f.posture(HarnessId::Codex);
        let finding = p
            .findings
            .iter()
            .find(|finding| finding.code == FindingCode::CodexTrustedProjects)
            .expect("trusted finding");
        assert_eq!(finding.count, Some(2));
        assert_eq!(finding.level, PostureLevel::Advice);
    }

    #[test]
    fn codex_home_other_than_default_is_named_by_the_variable() {
        let f = Fixture::new("codex-home");
        let mut inputs = f.inputs();
        inputs.codex_home = f.root.join("elsewhere");
        let p = compute(HarnessId::Codex, &inputs);
        assert_eq!(state(&p, "$CODEX_HOME/config.toml"), SourceState::Missing);
    }

    #[test]
    fn opencode_findings_follow_the_permission_block() {
        let f = Fixture::new("opencode");
        f.write(
            ".config/opencode/opencode.json",
            r#"{"permission":{"*":"ask","bash":{"*":"ask","rm *":"deny","sudo *":"deny"},"read":{"*.env":"deny"}}}"#,
        );
        let p = f.posture(HarnessId::OpenCode);
        let deny = p
            .findings
            .iter()
            .find(|finding| finding.code == FindingCode::OpencodeDenyRules)
            .expect("deny finding");
        assert_eq!(deny.count, Some(3));
        assert!(!any_risky(&p));

        f.write(
            ".config/opencode/opencode.json",
            r#"{"permission":{"bash":"allow"}}"#,
        );
        f.write(
            ".config/opencode/opencode.jsonc",
            "// c\n{\"permission\": \"allow\",}\n",
        );
        let p = f.posture(HarnessId::OpenCode);
        let all = p
            .findings
            .iter()
            .find(|finding| finding.code == FindingCode::OpencodeAllowAll)
            .expect("allow all");
        assert_eq!(all.file, Some("opencode.jsonc"));
        let bash = p
            .findings
            .iter()
            .find(|finding| finding.code == FindingCode::OpencodeBashAllow)
            .expect("bash allow");
        assert_eq!(bash.file, Some("opencode.json"));
        assert!(has(&p, FindingCode::OpencodeDenyRulesMissing));
        assert_eq!(state(&p, "config.json"), SourceState::Missing);

        f.write(
            ".config/opencode/opencode.json",
            r#"{"permission":{"*":"allow"}}"#,
        );
        f.write(".config/opencode/opencode.jsonc", "{}");
        assert!(has(
            &f.posture(HarnessId::OpenCode),
            FindingCode::OpencodeAllowAll
        ));
    }

    #[test]
    fn cursor_findings_follow_sandbox_json() {
        let f = Fixture::new("cursor");
        f.write(
            ".cursor/sandbox.json",
            r#"{"type":"insecure_none","networkPolicy":{"default":"allow"}}"#,
        );
        let p = f.posture(HarnessId::Cursor);
        assert!(has(&p, FindingCode::CursorSandboxOff));
        assert!(has(&p, FindingCode::CursorNetworkOpen));
        assert!(has(&p, FindingCode::CursorRunMode));

        f.write(
            ".cursor/sandbox.json",
            r#"{"type":"workspace_readwrite","networkPolicy":{"default":"deny"}}"#,
        );
        let p = f.posture(HarnessId::Cursor);
        assert!(!any_risky(&p));
        assert!(has(&p, FindingCode::CursorRunMode));
    }

    #[test]
    fn kilo_findings_follow_the_permission_block() {
        let f = Fixture::new("kilo");
        f.write(
            ".config/kilo/kilo.jsonc",
            "{\n// c\n\"permission\": {\"*\": \"allow\", \"bash\": \"allow\"}}\n",
        );
        let p = f.posture(HarnessId::Kilo);
        assert!(has(&p, FindingCode::KiloAllowAll));
        assert!(has(&p, FindingCode::KiloBashAllow));
        assert!(!has(&p, FindingCode::KiloNoRules));

        f.write(".config/kilo/kilo.jsonc", r#"{"mcp":{}}"#);
        let p = f.posture(HarnessId::Kilo);
        assert!(has(&p, FindingCode::KiloNoRules));
        assert!(!any_risky(&p));
    }

    #[test]
    fn kilo_json_is_named_by_its_own_file() {
        let f = Fixture::new("kilo-json");
        f.write(
            ".config/kilo/kilo.json",
            r#"{"permission":{"bash":"allow"}}"#,
        );
        let mut inputs = f.inputs();
        inputs.kilo_file = f.root.join(".config/kilo/kilo.json");
        let p = compute(HarnessId::Kilo, &inputs);
        let bash = p
            .findings
            .iter()
            .find(|finding| finding.code == FindingCode::KiloBashAllow)
            .expect("bash allow");
        assert_eq!(bash.file, Some("kilo.json"));
    }

    #[test]
    fn copilot_pi_and_grok_are_static_and_read_nothing() {
        let f = Fixture::new("static");
        let p = f.posture(HarnessId::Copilot);
        assert!(p.sources.is_empty());
        assert_eq!(codes(&p), vec![FindingCode::CopilotNotCovered]);
        let p = f.posture(HarnessId::Pi);
        assert!(p.sources.is_empty());
        assert_eq!(codes(&p), vec![FindingCode::PiNotCovered]);
        let p = f.posture(HarnessId::Antigravity);
        assert!(p.sources.is_empty());
        assert_eq!(codes(&p), vec![FindingCode::AntigravityNotCovered]);
        let p = f.posture(HarnessId::Grok);
        assert!(p.sources.is_empty());
        assert_eq!(codes(&p), vec![FindingCode::GrokNotCovered]);
    }

    #[test]
    fn a_missing_file_gives_defaults_and_nothing_risky() {
        let f = Fixture::new("fresh");
        for harness in HarnessId::ALL {
            let p = f.posture(*harness);
            assert!(!any_risky(&p), "{harness:?}");
            assert!(p.sources.iter().all(|s| s.state == SourceState::Missing));
        }
    }

    #[test]
    fn levels_come_from_the_code() {
        for code in ALL_CODES {
            let f = PostureFinding {
                code,
                level: code.level(),
                file: None,
                count: None,
            };
            assert_eq!(f.level, code.level());
        }
        assert_eq!(
            FindingCode::ClaudeBypassDefault.level(),
            PostureLevel::Risky
        );
        assert_eq!(FindingCode::ConfigOnly.level(), PostureLevel::NotCovered);
    }

    #[test]
    fn no_text_of_any_file_reaches_the_result() {
        let f = Fixture::new("leak");
        f.write(
            ".claude/settings.json",
            &format!(
                r#"{{"env":{{"K":"{MARKER}"}},"apiKeyHelper":"{MARKER}","permissions":{{"deny":["Read(./{MARKER}/.env)","Bash({MARKER})"]}}}}"#
            ),
        );
        f.write(
            ".codex/config.toml",
            &format!(
                "# {MARKER}\nmodel_provider = \"{MARKER}\"\n[projects.\"/secret-{MARKER}\"]\ntrust_level = \"trusted\"\n"
            ),
        );
        f.write(
            ".config/opencode/opencode.json",
            &format!(
                "// {MARKER}\n{{\"provider\":{{\"x\":{{\"options\":{{\"apiKey\":\"{MARKER}\"}}}}}},\"permission\":{{\"bash\":{{\"{MARKER}\":\"deny\"}}}}}}"
            ),
        );
        f.write(
            ".cursor/sandbox.json",
            &format!("/* {MARKER} */ {{\"type\":\"{MARKER}\",\"networkPolicy\":{{\"default\":\"{MARKER}\"}}}}"),
        );
        f.write(
            ".config/kilo/kilo.jsonc",
            &format!("{{\"provider\":{{\"apiKey\":\"{MARKER}\"}},\"permission\":{{\"{MARKER}\":\"allow\"}}}}"),
        );
        for harness in HarnessId::ALL {
            let p = f.posture(*harness);
            assert!(!wire(&p).contains(MARKER), "{harness:?}");
        }
    }

    #[test]
    fn syntax_errors_are_unreadable_and_say_nothing() {
        let f = Fixture::new("syntax");
        f.write(
            ".claude/settings.json",
            &format!("{{\"a\":\"x\",\n\"b\": \"{MARKER}\",}}"),
        );
        f.write(
            ".codex/config.toml",
            &format!("a = \n{MARKER} = = \"{MARKER}\n"),
        );
        f.write(
            ".config/opencode/opencode.json",
            &format!("{{\"a\": {MARKER} nope}}"),
        );
        f.write(".cursor/sandbox.json", &format!("{{{MARKER}"));
        f.write(".config/kilo/kilo.jsonc", &format!("/* {MARKER}"));
        let claude = f.posture(HarnessId::Claude);
        assert_eq!(state(&claude, CLAUDE_FILE), SourceState::Unreadable);
        let codex = f.posture(HarnessId::Codex);
        assert_eq!(
            state(&codex, "~/.codex/config.toml"),
            SourceState::Unreadable
        );
        let opencode = f.posture(HarnessId::OpenCode);
        assert_eq!(state(&opencode, "opencode.json"), SourceState::Unreadable);
        let cursor = f.posture(HarnessId::Cursor);
        assert_eq!(
            state(&cursor, "~/.cursor/sandbox.json"),
            SourceState::Unreadable
        );
        let kilo = f.posture(HarnessId::Kilo);
        assert_eq!(state(&kilo, "kilo.jsonc"), SourceState::Unreadable);
        for p in [&claude, &codex, &opencode, &cursor, &kilo] {
            assert!(!wire(p).contains(MARKER));
            assert!(!any_risky(p));
        }
        // Nothing but the fixed rows: no finding from the unreadable file.
        assert_eq!(codes(&claude), vec![FindingCode::ConfigOnly]);
        assert_eq!(codes(&codex), vec![FindingCode::ConfigOnly]);
        assert_eq!(codes(&kilo), vec![FindingCode::ConfigOnly]);
    }

    #[test]
    fn the_size_cap_is_one_mebibyte() {
        let f = Fixture::new("cap");
        let pad = |len: usize| format!("{{\"pad\":\"{}\"}}", "a".repeat(len));
        let base = pad(0).len();
        let at_cap = pad(MAX_CONFIG_BYTES as usize - base);
        assert_eq!(at_cap.len() as u64, MAX_CONFIG_BYTES);
        f.write(".claude/settings.json", &at_cap);
        assert_eq!(
            state(&f.posture(HarnessId::Claude), CLAUDE_FILE),
            SourceState::Read
        );
        f.write(
            ".claude/settings.json",
            &pad(MAX_CONFIG_BYTES as usize - base + 1),
        );
        assert_eq!(
            state(&f.posture(HarnessId::Claude), CLAUDE_FILE),
            SourceState::Unreadable
        );
    }

    #[test]
    fn a_directory_or_invalid_utf8_is_unreadable() {
        let f = Fixture::new("shape");
        fs::create_dir_all(f.root.join(".claude/settings.json")).expect("dir in place of file");
        assert_eq!(
            state(&f.posture(HarnessId::Claude), CLAUDE_FILE),
            SourceState::Unreadable
        );
        fs::remove_dir_all(f.root.join(".claude/settings.json")).expect("remove dir");
        fs::write(
            f.root.join(".claude/settings.json"),
            [0x7b, 0xff, 0xfe, 0x7d],
        )
        .expect("write");
        assert_eq!(
            state(&f.posture(HarnessId::Claude), CLAUDE_FILE),
            SourceState::Unreadable
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_followed_and_unreadable_files_are_reported() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new("unix");
        f.write("real/settings.json", r#"{"sandbox":{"enabled":true}}"#);
        fs::create_dir_all(f.root.join(".claude")).expect("claude dir");
        symlink(
            f.root.join("real/settings.json"),
            f.root.join(".claude/settings.json"),
        )
        .expect("symlink");
        let p = f.posture(HarnessId::Claude);
        assert_eq!(state(&p, CLAUDE_FILE), SourceState::Read);
        assert!(has(&p, FindingCode::ClaudeSandboxOn));

        let target = f.root.join(".codex/config.toml");
        f.write(".codex/config.toml", "sandbox_mode = \"read-only\"\n");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o000)).expect("chmod");
        // Root can still open the file; the check is meaningful only for other users.
        if fs::File::open(&target).is_err() {
            assert_eq!(
                state(&f.posture(HarnessId::Codex), "~/.codex/config.toml"),
                SourceState::Unreadable
            );
        }
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).expect("chmod back");
    }

    #[test]
    fn wrong_types_give_no_finding_and_no_panic() {
        let f = Fixture::new("types");
        f.write(
            ".claude/settings.json",
            r#"{"permissions":5,"sandbox":"yes"}"#,
        );
        f.write(".codex/config.toml", "projects = [1, 2]\nsandbox_mode = 5\napproval_policy = 3\nsandbox_workspace_write = \"x\"\n");
        f.write(".config/opencode/opencode.json", r#"{"permission":5}"#);
        f.write(".config/opencode/opencode.jsonc", r#"[1,2]"#);
        f.write(
            ".cursor/sandbox.json",
            r#"{"type":5,"networkPolicy":"allow"}"#,
        );
        f.write(".config/kilo/kilo.jsonc", r#"{"permission":["allow"]}"#);
        for harness in HarnessId::ALL {
            let p = f.posture(*harness);
            assert!(!any_risky(&p), "{harness:?}");
        }
        let p = f.posture(HarnessId::Codex);
        assert!(!has(&p, FindingCode::CodexTrustedProjects));
        assert!(!has(&p, FindingCode::CodexSandboxUnset));
    }

    fn listing(root: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
        let mut entries = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).expect("read dir").flatten() {
                let meta = entry.metadata().expect("metadata");
                entries.push((entry.path(), meta.modified().expect("mtime"), meta.len()));
                if meta.is_dir() {
                    stack.push(entry.path());
                }
            }
        }
        entries.sort();
        entries
    }

    #[test]
    fn the_check_writes_nothing() {
        let f = Fixture::new("readonly");
        f.write(".claude/settings.json", r#"{"sandbox":{"enabled":true}}"#);
        f.write(".codex/config.toml", "sandbox_mode = \"read-only\"\n");
        f.write(".config/opencode/opencode.json", "{}");
        f.write(".cursor/sandbox.json", "{}");
        f.write(".config/kilo/kilo.jsonc", "{}");
        let before = listing(&f.root);
        for harness in HarnessId::ALL {
            let _ = f.posture(*harness);
        }
        assert_eq!(before, listing(&f.root));
    }

    #[test]
    fn every_code_has_copy_in_the_frontend() {
        const ROWS: &str = include_str!("../../../src/lib/securityPostureRows.ts");
        for code in ALL_CODES {
            let name = serde_json::to_value(code).expect("serialize code");
            let name = name.as_str().expect("code is a string");
            assert!(
                ROWS.contains(&format!("  {name}:")),
                "securityPostureRows.ts has no copy for {name}"
            );
        }
    }
}
