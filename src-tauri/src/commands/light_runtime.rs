//! Runtime health of the light harnesses (GitHub Copilot, Pi, Kilo Code), read only.
//!
//! What it looks at: the harness CLI's version, whether the managed rules block is in the harness's
//! rules file, whether the managed Playwright entry is in its MCP file (the entry only: the user's
//! other servers are not read into the health), and whether the bundled skills are installed in the
//! folders the harness reads.
//!
//! What it never does: run any CLI subcommand but `--version` (`copilot version` asks the network,
//! `pi --help` writes files into the agent dir, `kilo debug *` prints the resolved config with its
//! secrets; `pi mcp list` spawns the servers; `copilot mcp` and `kilo mcp` are not needed), read an
//! auth, settings or config file of the harness, show any text of the rules or MCP file, or keep
//! any raw output. The version probe is bounded, parse-only and runs from a neutral
//! working directory (`opencode_cli::probe_version_with_env`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::opencode_cli::{probe_version_with_env, VersionProbe, VERSION_TIMEOUT};
use super::workspace::setup_workspace_target_path;
use crate::agent_targets::{self, HarnessId};
use crate::installation_status::{status_for_surfaces, InstallationState};
use crate::light_harness::{self, LightHarness};
use crate::light_mcp::EntryState;
use crate::rules_block::{RulesConflict, RulesLayout};
use crate::settings;
use crate::setup_lifecycle::OperationKind;
use crate::setup_transaction;
use crate::skill_health::skill_files_status;
use crate::skill_roots::{codex_home_is_custom, roots_read_by, unserved, SkillRoot, SkillScope};
use crate::skill_sources::SkillSources;

/// How many version folders below `~/.nvm/versions/node` are looked at.
const MAX_NVM_VERSIONS: usize = 256;

/// The CLI row of the health.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LightCliHealth {
    /// `found` (a version was read), `unknown` (found, but no version could be read in time) or
    /// `missing`.
    pub status: String,
    pub version: Option<String>,
    /// Where the program was found: `path`, or `nvm` when only a Node version folder of nvm has it.
    pub source: Option<String>,
    pub detail: String,
}

/// The skills row of the health.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LightSkillsHealth {
    /// `synced`, `partial`, `missing`, `diverged`, `unserved` (no folder is installed for the
    /// harness, see `skill_roots::unserved`) or `unknown` (the bundled skills cannot be read).
    pub status: String,
    pub synced: usize,
    pub expected: usize,
    /// The installed folders the harness reads, as people know them (`~/.agents/skills`).
    pub roots: Vec<String>,
}

/// The rules row of the health.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LightRulesHealth {
    /// `synced`, `stale` (a base update is waiting), `missing` (no file yet), `diverged` (a
    /// conflict the app leaves alone), `off` (the rules target is switched off in Settings) or
    /// `unknown`.
    pub status: String,
    /// The rules file as people know it (`~/.pi/agent/AGENTS.md`).
    pub path: String,
    /// Non-blank lines of the user's own around the block; kept on every update.
    pub refinement_lines: usize,
    /// The user chose to manage a hand-edited file themselves.
    pub user_managed: bool,
    /// Why the file is left alone, when it is a conflict.
    pub conflict_reason: Option<RulesConflict>,
    /// The status line of the surface (counts and reasons only, never file text).
    pub detail: String,
}

/// The MCP row of the health: the managed Playwright entry in the harness's MCP file.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LightMcpHealth {
    /// `synced`, `missing` (no file or no entry yet), `stale` (an update of the entry waits),
    /// `diverged` (an entry of the user's own under the managed key), `invalid` (a file the app
    /// does not edit: comments, a trailing comma, ...), `off` (the MCP target is switched off in
    /// Settings) or `unknown`.
    pub status: String,
    /// The MCP file as people know it (`~/.copilot/mcp-config.json`).
    pub path: String,
    /// The Playwright version the installed entry pins, when it names one.
    pub playwright_version: Option<String>,
    /// The status line (counts and fixed phrases, never file text).
    pub detail: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LightRuntimeHealth {
    pub harness: HarnessId,
    /// The skills status; when the skills are fine, the rules status, then the MCP status (each
    /// unless its target is off).
    pub status: String,
    pub cli: LightCliHealth,
    pub rules: LightRulesHealth,
    pub mcp: LightMcpHealth,
    pub skills: LightSkillsHealth,
    pub warnings: Vec<String>,
    pub next_action: String,
}

// ── Finding the CLI ──

/// Where the CLI program was found.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CliSource {
    Path,
    /// `~/.nvm/versions/node/<version>/bin`: the Node version folder, which holds `node` too.
    Nvm {
        version_dir: String,
        bin_dir: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FoundCli {
    program: PathBuf,
    source: CliSource,
}

/// `v24.14.0` as numbers; nothing else a Node version folder could be called.
fn parse_node_version_dir(name: &str) -> Option<(u64, u64, u64)> {
    let mut parts = name.strip_prefix('v')?.split('.');
    let mut next = || -> Option<u64> {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

/// The highest Node version folder of nvm whose `bin` holds `program`. A Finder-launched app does
/// not load the shell profile that puts nvm's folder on `PATH`, so the three light CLIs, which npm
/// installs there, would never be found. nvm's alias files are not read: the highest version that
/// has the program wins. Unix only.
fn find_in_nvm(home: &Path, program: &str) -> Option<FoundCli> {
    if !cfg!(unix) {
        return None;
    }
    let versions = home.join(".nvm/versions/node");
    let mut best: Option<((u64, u64, u64), FoundCli)> = None;
    for entry in std::fs::read_dir(versions)
        .ok()?
        .flatten()
        .take(MAX_NVM_VERSIONS)
    {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(version) = parse_node_version_dir(&name) else {
            continue;
        };
        let bin_dir = entry.path().join("bin");
        let candidate = bin_dir.join(program);
        if !crate::executable_resolver::is_executable_file(&candidate, None) {
            continue;
        }
        if best.as_ref().is_none_or(|(highest, _)| version > *highest) {
            best = Some((
                version,
                FoundCli {
                    program: candidate,
                    source: CliSource::Nvm {
                        version_dir: name,
                        bin_dir,
                    },
                },
            ));
        }
    }
    best.map(|(_, found)| found)
}

/// `program` on `path_env`, else (for the light CLIs only) in nvm.
fn find_cli(program: &str, path_env: &str, home: Option<&Path>) -> Option<FoundCli> {
    let pathext = if cfg!(windows) {
        std::env::var("PATHEXT").ok()
    } else {
        None
    };
    crate::executable_resolver::resolve_executable(program, path_env, pathext.as_deref())
        .map(|program| FoundCli {
            program,
            source: CliSource::Path,
        })
        .or_else(|| home.and_then(|home| find_in_nvm(home, program)))
}

/// `PATH` for the probe child: nvm's folder (it holds `node`, which the CLI's `#!/usr/bin/env
/// node` line needs) in front of the app's own `PATH`.
fn path_with_front(dir: &Path, path_env: &str) -> Option<String> {
    let mut dirs = vec![dir.to_path_buf()];
    dirs.extend(std::env::split_paths(path_env));
    std::env::join_paths(dirs)
        .ok()
        .and_then(|joined| joined.into_string().ok())
}

fn missing_cli(program: &str) -> LightCliHealth {
    LightCliHealth {
        status: "missing".into(),
        version: None,
        source: None,
        detail: format!(
            "{program} is not on PATH; Riggverk does not read your shell profile, so start it from a shell where {program} runs"
        ),
    }
}

/// Probe the CLI of `harness`: find it, run `--version`, keep the version token only.
fn inspect_cli(
    harness: &LightHarness,
    path_env: &str,
    home: Option<&Path>,
    timeout: Duration,
) -> LightCliHealth {
    let program = harness.cli_program.as_str();
    let Some(found) = find_cli(program, path_env, home) else {
        return missing_cli(program);
    };
    let (source, extra_env, found_in) = match &found.source {
        CliSource::Path => (Some("path".to_string()), Vec::new(), String::new()),
        CliSource::Nvm {
            version_dir,
            bin_dir,
        } => (
            Some("nvm".to_string()),
            path_with_front(bin_dir, path_env)
                .map(|path| vec![("PATH".to_string(), path)])
                .unwrap_or_default(),
            format!(" (found in nvm {version_dir}, not on PATH)"),
        ),
    };
    let Some(program_path) = found.program.to_str() else {
        return LightCliHealth {
            status: "unknown".into(),
            version: None,
            source,
            detail: format!("found, but its path is not valid text{found_in}"),
        };
    };
    match probe_version_with_env(program_path, timeout, extra_env) {
        VersionProbe::Found(version) => LightCliHealth {
            status: "found".into(),
            detail: format!("{} {}{found_in}", harness.label, version.text),
            version: Some(version.text),
            source,
        },
        VersionProbe::Unreadable => LightCliHealth {
            status: "unknown".into(),
            version: None,
            source,
            detail: format!("found, but {program} --version gave no version{found_in}"),
        },
        VersionProbe::TimedOut => LightCliHealth {
            status: "unknown".into(),
            version: None,
            source,
            detail: format!(
                "found, but {program} --version timed out after {}s{found_in}",
                timeout.as_secs()
            ),
        },
    }
}

// ── Skills ──

fn display_roots(roots: &[SkillRoot]) -> Vec<String> {
    roots
        .iter()
        .map(|root| root.display().to_string())
        .collect()
}

/// What the harness sees of the bundled skills. `enabled` is the set of enabled harnesses (`None`
/// when the settings cannot be read); the harness itself counts as enabled, so the answer is the
/// one an install with it switched on would give.
fn inspect_skills(
    harness: HarnessId,
    bundled_root: Option<&Path>,
    home: &Path,
    enabled: Option<&[HarnessId]>,
    codex_custom: bool,
) -> LightSkillsHealth {
    let mut with: Vec<HarnessId> = enabled.map(<[HarnessId]>::to_vec).unwrap_or_default();
    if !with.contains(&harness) {
        with.push(harness);
    }
    let scope = SkillScope::for_harnesses(&with, codex_custom);
    let roots = roots_read_by(harness, &scope);
    let unserved = unserved(&with, codex_custom).contains(&harness);
    let status = bundled_root
        .map(|bundle| skill_files_status(&SkillSources::for_current(bundle), home, &roots));
    match status {
        Some(Ok(status)) => LightSkillsHealth {
            status: if unserved {
                "unserved".into()
            } else {
                status.label().into()
            },
            synced: status.synced,
            expected: status.expected,
            roots: display_roots(&roots),
        },
        _ => LightSkillsHealth {
            status: if unserved { "unserved" } else { "unknown" }.into(),
            synced: 0,
            expected: 0,
            roots: display_roots(&roots),
        },
    }
}

// ── Rules ──

/// What the harness's rules file looks like: the same planner the harness page and Install use,
/// reduced to a status and the surface's own detail line.
fn inspect_rules(harness: &LightHarness, inputs: &Inputs) -> LightRulesHealth {
    let rules = &harness.rules;
    let path = rules.display_path(inputs.home);
    let health = |status: &str, detail: &str| LightRulesHealth {
        status: status.into(),
        path: path.clone(),
        refinement_lines: 0,
        user_managed: false,
        conflict_reason: None,
        detail: detail.into(),
    };
    if !inputs.rules_on {
        return health("off", "switched off in Settings");
    }
    let Some(workspace_root) = inputs.workspace_root else {
        return health("unknown", "no workspace is set up");
    };
    let Ok(status) = status_for_surfaces(&[rules.surface], workspace_root, inputs.home) else {
        return health("unknown", "the rules file could not be checked");
    };
    let Some(surface) = status.surfaces.into_iter().next() else {
        return health("unknown", "the rules file could not be checked");
    };
    let absent = surface
        .rules
        .as_ref()
        .is_some_and(|file| file.layout == RulesLayout::Absent);
    let verdict = match surface.state {
        InstallationState::NotInstalled => "missing",
        InstallationState::UpdateAvailable if absent => "missing",
        InstallationState::UpdateAvailable => "stale",
        InstallationState::Current => "synced",
        InstallationState::Conflict => "diverged",
        InstallationState::Unavailable => "unknown",
    };
    LightRulesHealth {
        status: verdict.into(),
        path,
        refinement_lines: surface
            .rules
            .as_ref()
            .map_or(0, |file| file.refinement_lines),
        user_managed: surface.rules.as_ref().is_some_and(|file| file.user_managed),
        conflict_reason: surface.rules.as_ref().and_then(|file| file.conflict_reason),
        detail: surface.detail,
    }
}

// ── MCP ──

/// What the harness's MCP file holds of the managed entry: the planner the harness page and
/// Install use, reduced to a status and the surface's own detail line. Nothing of the file but
/// the entry is looked at, and no text of it is kept.
fn inspect_mcp(harness: &LightHarness, inputs: &Inputs) -> LightMcpHealth {
    let mcp = &harness.mcp;
    let path = mcp.display_path(inputs.home);
    let health = |status: &str, detail: &str| LightMcpHealth {
        status: status.into(),
        path: path.clone(),
        playwright_version: None,
        detail: detail.into(),
    };
    if !inputs.mcp_on {
        return health("off", "switched off in Settings");
    }
    let Some(workspace_root) = inputs.workspace_root else {
        return health("unknown", "no workspace is set up");
    };
    let Ok(planned) =
        setup_transaction::plan_artifacts_for_surfaces(&[mcp.surface], workspace_root, inputs.home)
    else {
        return health("unknown", "the MCP file could not be checked");
    };
    let Some(entry) = planned.first() else {
        return health("unknown", "the MCP file could not be checked");
    };
    let key = mcp.entry_key.as_str();
    let (status, detail) = match (entry.kind, entry.mcp) {
        (OperationKind::NoChange, _) => ("synced", "installed and current".to_string()),
        (OperationKind::Create, _) => ("missing", "no file yet".to_string()),
        (OperationKind::Update, Some(EntryState::Differs)) => {
            ("stale", format!("update available for the {key} entry"))
        }
        (OperationKind::Update, _) => (
            "missing",
            format!("the file has no {key} entry; it will be added and your other servers stay"),
        ),
        (OperationKind::Conflict, Some(state @ EntryState::Refused(_))) => {
            ("invalid", state.conflict_reason(key).unwrap_or_default())
        }
        (OperationKind::Conflict, state) => (
            "diverged",
            state
                .and_then(|state| state.conflict_reason(key))
                .unwrap_or_else(|| "the entry is left as is".to_string()),
        ),
        _ => ("unknown", "the MCP file could not be checked".to_string()),
    };
    let version = if matches!(entry.mcp, Some(EntryState::Equal | EntryState::Differs)) {
        crate::light_mcp::read(&mcp.resolve_dest(inputs.home), mcp)
            .ok()
            .flatten()
            .and_then(|document| {
                document
                    .entry(mcp)
                    .and_then(crate::light_mcp::pinned_version)
            })
    } else {
        None
    };
    LightMcpHealth {
        status: status.into(),
        path,
        playwright_version: version,
        detail,
    }
}

/// The folder of a displayed path: `~/.pi/agent` for `~/.pi/agent/AGENTS.md`.
fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(folder, _)| folder)
}

fn names_list(names: &[&str]) -> String {
    names.join(", ")
}

/// Warnings about the rules file. Static notes appear while the rules target is on; the others
/// only when the situation is there.
fn rules_warnings(
    harness: &LightHarness,
    rules: &LightRulesHealth,
    inputs: &Inputs,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if rules.status == "off" {
        return warnings;
    }
    let label = &harness.label;
    let spec = &harness.rules;
    let dest = spec.resolve_dest(inputs.home);
    let folder = folder_of(&rules.path);
    let masking = spec.masking_files(&dest);
    if !masking.is_empty() {
        warnings.push(format!(
            "{names} in {folder} replaces {file}, so {label} never reads the managed block. Remove or rename it.",
            names = names_list(&masking),
            file = spec.file_label,
        ));
    }
    let peers = spec.peer_context_files(&dest);
    if !peers.is_empty() && !std::fs::metadata(&dest).is_ok_and(|meta| meta.is_file()) {
        warnings.push(format!(
            "{label} reads one context file per folder: {folder} has {names} and no {file}. Riggverk does not create {file} (it would hide yours); add the base to {names} by hand or rename it to {file}.",
            names = names_list(&peers),
            file = spec.file_label,
        ));
    }
    if let Some(shadowed) = &spec.shadows {
        warnings.push(format!(
            "{label} loads one global rules file and {path} comes first: while it exists {label} does not read {shadowed}. Move what {label} should keep from there below the managed block.",
            path = rules.path
        ));
    }
    if harness.id == HarnessId::Copilot && inputs.claude_rules_managed {
        warnings.push(
            "VS Code can load both ~/.claude/CLAUDE.md and ~/.copilot/copilot-instructions.md, so the shared base may appear twice there. The Copilot CLI reads only ~/.copilot.".to_string(),
        );
    }
    warnings
}

/// Warnings about the MCP file, while its target is on: what the descriptor notes, and the files
/// that exist and win over the file the entry is written to.
fn mcp_warnings(harness: &LightHarness, mcp: &LightMcpHealth, inputs: &Inputs) -> Vec<String> {
    if mcp.status == "off" {
        return Vec::new();
    }
    let spec = &harness.mcp;
    let mut warnings = spec.notes.clone();
    let shadowing = spec.shadowing_files(inputs.home);
    if !shadowing.is_empty() {
        warnings.push(format!(
            "{files} win over {path} in {label}, so a {key} entry there hides the one Riggverk manages. Riggverk does not read them.",
            files = shadowing.join(", "),
            path = mcp.path,
            label = harness.label,
            key = spec.entry_key,
        ));
    }
    warnings
}

/// The environment variable that moves the harness's own folder, which the app does not follow.
fn relocating_variable(harness: HarnessId) -> Option<&'static str> {
    match harness {
        HarnessId::Copilot => Some("COPILOT_HOME"),
        HarnessId::Pi => Some("PI_CODING_AGENT_DIR"),
        _ => None,
    }
}

/// The overall status: the skills', or the rules' once the skills are fine and the rules target
/// is on, or the MCP's once both are fine and the MCP target is on.
fn overall_status(
    skills: &LightSkillsHealth,
    rules: &LightRulesHealth,
    mcp: &LightMcpHealth,
) -> String {
    if skills.status != "synced" {
        skills.status.clone()
    } else if rules.status != "off" && rules.status != "synced" {
        rules.status.clone()
    } else if mcp.status != "off" && mcp.status != "synced" {
        mcp.status.clone()
    } else {
        "synced".to_string()
    }
}

fn next_action(
    label: &str,
    skills: &LightSkillsHealth,
    rules: &LightRulesHealth,
    mcp: &LightMcpHealth,
) -> String {
    match skills.status.as_str() {
        "synced" => match (rules.status.as_str(), mcp.status.as_str()) {
            ("missing" | "stale", _) => format!("Run Install or Update on the {label} page."),
            ("diverged", _) => format!("Resolve the rules file conflict on the {label} page."),
            ("unknown", _) => format!("Riggverk cannot check the {label} rules file; open the {label} page for details."),
            (_, "missing" | "stale") => format!("Run Install or Update on the {label} page."),
            (_, "diverged" | "invalid") => format!("Resolve the MCP file conflict on the {label} page."),
            (_, "unknown") => format!("Riggverk cannot check the {label} MCP file; open the {label} page for details."),
            _ => "No runtime action needed.".into(),
        },
        "unserved" => format!("Disable Codex or unset CODEX_HOME to install skills for {label}."),
        "unknown" => format!("Riggverk cannot read its bundled skills; reinstall the app ({label} skills not checked)."),
        _ => format!("Run Install or Update on the {label} page."),
    }
}

struct Inputs<'a> {
    home: &'a Path,
    bundled_root: Option<&'a Path>,
    path_env: &'a str,
    enabled: Option<&'a [HarnessId]>,
    codex_custom: bool,
    /// Names of the variables in `relocating_variable` that are set in the app's environment.
    set_variables: &'a [&'a str],
    version_timeout: Duration,
    /// The workspace the rules are planned for; `None` when none can be resolved.
    workspace_root: Option<&'a Path>,
    /// The harness's rules target is switched on in Settings.
    rules_on: bool,
    /// The harness's MCP target is switched on in Settings.
    mcp_on: bool,
    /// Claude is enabled and its rules target is on (Copilot's VS Code note depends on it).
    claude_rules_managed: bool,
}

fn compute_health(harness: &LightHarness, inputs: &Inputs) -> LightRuntimeHealth {
    let skills = inspect_skills(
        harness.id,
        inputs.bundled_root,
        inputs.home,
        inputs.enabled,
        inputs.codex_custom,
    );
    let cli = inspect_cli(
        harness,
        inputs.path_env,
        Some(inputs.home),
        inputs.version_timeout,
    );
    let rules = inspect_rules(harness, inputs);
    let mcp = inspect_mcp(harness, inputs);
    let mut warnings = Vec::new();
    if skills.status == "unserved" {
        warnings.push(format!(
            "No skills are installed for {label}: it reads ~/.agents/skills, and a customised CODEX_HOME keeps Codex out of that folder.",
            label = harness.label
        ));
    }
    if let Some(variable) = relocating_variable(harness.id) {
        if inputs.set_variables.contains(&variable) {
            warnings.push(format!(
                "{variable} is set in Riggverk's environment; Riggverk writes {path} anyway, which {label} reads only without it.",
                path = rules.path,
                label = harness.label
            ));
        }
    }
    warnings.extend(rules_warnings(harness, &rules, inputs));
    warnings.extend(mcp_warnings(harness, &mcp, inputs));
    LightRuntimeHealth {
        harness: harness.id,
        status: overall_status(&skills, &rules, &mcp),
        next_action: next_action(&harness.label, &skills, &rules, &mcp),
        cli,
        rules,
        mcp,
        skills,
        warnings,
    }
}

/// Read-only health of one light harness: its CLI version, its rules file, its MCP entry and its
/// skills.
///
/// Runs `<cli> --version` (bounded, parse-only), classifies the rules file against the managed
/// block, looks for the managed entry in the MCP file and compares installed skill files with the
/// bundle. Nothing of the harness's own folders is read besides the rules file and the folder
/// next to it, the MCP file (its managed entry only; the files that win over it are only looked
/// for) and the skills folders it shares.
#[tauri::command(async)]
pub fn get_light_runtime_health(harness: HarnessId) -> Result<LightRuntimeHealth, String> {
    let descriptor = light_harness::descriptor(harness)
        .ok_or_else(|| format!("{} is not a light harness", harness.as_str()))?;
    let home = agent_targets::home_dir()?;
    let loaded = settings::load();
    let workspace_root = setup_workspace_target_path().ok();
    let bundled = workspace_root
        .as_deref()
        .and_then(|root| crate::setup_roots::bundled_root_for(root).ok());
    let enabled = settings::try_load()
        .ok()
        .map(|loaded| loaded.enabled_harness_ids);
    let target_on = |target: &str| loaded.enabled_target_ids.iter().any(|id| id == target);
    let claude_rules_managed =
        settings::harness_enabled(&loaded, HarnessId::Claude) && target_on("claude_rules");
    let set_variables: Vec<&str> = ["COPILOT_HOME", "PI_CODING_AGENT_DIR"]
        .into_iter()
        .filter(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
        .collect();
    let path_env = std::env::var("PATH").unwrap_or_default();
    Ok(compute_health(
        descriptor,
        &Inputs {
            home: &home,
            bundled_root: bundled.as_deref(),
            path_env: &path_env,
            enabled: enabled.as_deref(),
            codex_custom: codex_home_is_custom(&home),
            set_variables: &set_variables,
            version_timeout: VERSION_TIMEOUT,
            workspace_root: workspace_root.as_deref(),
            rules_on: target_on(&descriptor.rules.target_id),
            mcp_on: target_on(&descriptor.mcp.target_id),
            claude_rules_managed,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::write_canonical_skill;
    use std::fs;

    fn temp(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-light-runtime-{label}-{nonce}"));
        fs::create_dir_all(&dir).expect("temp dir");
        fs::canonicalize(dir).expect("canonical temp dir")
    }

    fn descriptor(id: HarnessId) -> &'static LightHarness {
        light_harness::descriptor(id).expect("light harness")
    }

    #[test]
    fn node_version_folders_parse_as_plain_versions_only() {
        assert_eq!(parse_node_version_dir("v24.14.0"), Some((24, 14, 0)));
        assert_eq!(parse_node_version_dir("v9.0.12"), Some((9, 0, 12)));
        for bad in [
            "",
            "24.14.0",
            "v24.14",
            "v24.14.0.1",
            "v24.14.0-rc.1",
            "vx.1.2",
            "v1..2",
            "default",
        ] {
            assert_eq!(parse_node_version_dir(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_missing_cli_is_missing_with_a_hint() {
        let health = inspect_cli(
            descriptor(HarnessId::Pi),
            "/nonexistent-aw-dir",
            None,
            Duration::from_secs(1),
        );
        assert_eq!(health.status, "missing");
        assert!(health.version.is_none() && health.source.is_none());
        assert!(health.detail.contains("not on PATH"), "{}", health.detail);
        assert!(health.detail.contains("pi"), "{}", health.detail);
    }

    #[cfg(unix)]
    mod stubs {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A directory with executable shell scripts in it.
        pub struct Bin {
            pub dir: PathBuf,
        }

        impl Bin {
            pub fn new(label: &str) -> Self {
                Self { dir: temp(label) }
            }

            pub fn add(&self, name: &str, body: &str) -> PathBuf {
                let path = self.dir.join(name);
                fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub");
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
                path
            }

            pub fn path_env(&self) -> String {
                self.dir.display().to_string()
            }
        }

        impl Drop for Bin {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.dir);
            }
        }
    }

    #[cfg(unix)]
    use stubs::Bin;

    #[cfg(unix)]
    #[test]
    fn copilots_two_line_output_with_a_trailing_dot_gives_a_clean_version() {
        let bin = Bin::new("copilot");
        // Exactly what `copilot --version` printed in the live check.
        bin.add(
            "copilot",
            "echo 'GitHub Copilot CLI 1.0.98.'\necho \"Run 'copilot update' to check for updates.\"",
        );
        let health = inspect_cli(
            descriptor(HarnessId::Copilot),
            &bin.path_env(),
            None,
            Duration::from_secs(10),
        );
        assert_eq!(health.status, "found");
        assert_eq!(health.version.as_deref(), Some("1.0.98"));
        assert_eq!(health.source.as_deref(), Some("path"));
        assert_eq!(health.detail, "Copilot 1.0.98");
    }

    #[cfg(unix)]
    #[test]
    fn pi_and_kilo_print_a_bare_version() {
        for (id, program, output, expected) in [
            (HarnessId::Pi, "pi", "1.3.0", "1.3.0"),
            (HarnessId::Kilo, "kilo", "7.8.12", "7.8.12"),
        ] {
            let bin = Bin::new(program);
            bin.add(program, &format!("echo {output}"));
            let health = inspect_cli(
                descriptor(id),
                &bin.path_env(),
                None,
                Duration::from_secs(10),
            );
            assert_eq!(health.status, "found", "{program}");
            assert_eq!(health.version.as_deref(), Some(expected), "{program}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn only_version_is_ever_passed_to_the_cli_from_a_neutral_directory() {
        let bin = Bin::new("args");
        bin.add(
            "kilo",
            "echo \"$@\" > \"$(dirname \"$0\")/args.txt\"\npwd -P > \"$(dirname \"$0\")/cwd.txt\"\necho 7.8.12",
        );
        inspect_cli(
            descriptor(HarnessId::Kilo),
            &bin.path_env(),
            None,
            Duration::from_secs(10),
        );
        let args = fs::read_to_string(bin.dir.join("args.txt")).expect("args recorded");
        assert_eq!(args.trim(), "--version");
        let cwd = fs::read_to_string(bin.dir.join("cwd.txt")).expect("cwd recorded");
        let neutral = fs::canonicalize(std::env::temp_dir()).expect("neutral cwd");
        assert_eq!(Path::new(cwd.trim()), neutral);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_a_version_is_unknown_and_raw_output_is_dropped() {
        let bin = Bin::new("noisy");
        bin.add(
            "pi",
            "echo 'token sk-live-not-a-real-secret'\necho 'Usage: pi [options]'\nexit 0",
        );
        let health = inspect_cli(
            descriptor(HarnessId::Pi),
            &bin.path_env(),
            None,
            Duration::from_secs(10),
        );
        assert_eq!(health.status, "unknown");
        assert!(health.version.is_none());
        let json = serde_json::to_string(&health).expect("serialize");
        assert!(!json.contains("sk-live"), "{json}");
        assert!(!json.contains("Usage"), "{json}");
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_fails_or_hangs_is_unknown_and_bounded() {
        let bin = Bin::new("failing");
        bin.add("copilot", "echo 'Error: not signed in' >&2\nexit 1");
        let failed = inspect_cli(
            descriptor(HarnessId::Copilot),
            &bin.path_env(),
            None,
            Duration::from_secs(10),
        );
        assert_eq!(failed.status, "unknown");
        assert!(!failed.detail.contains("signed in"), "{}", failed.detail);

        // `exec` so the killed process is the sleeper itself.
        bin.add("copilot", "exec sleep 30");
        let started = std::time::Instant::now();
        let hung = inspect_cli(
            descriptor(HarnessId::Copilot),
            &bin.path_env(),
            None,
            Duration::from_millis(300),
        );
        assert_eq!(hung.status, "unknown");
        assert!(hung.detail.contains("timed out"), "{}", hung.detail);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// A fake nvm tree: each version folder has a `pi` that prints its own folder name and only
    /// works when its own `bin` folder is on `PATH` (as `node` has to be for the real one).
    #[cfg(unix)]
    fn fake_nvm(home: &Path, versions: &[&str]) {
        use std::os::unix::fs::PermissionsExt;
        for version in versions {
            let bin = home.join(".nvm/versions/node").join(version).join("bin");
            fs::create_dir_all(&bin).expect("nvm bin");
            let script = bin.join("pi");
            fs::write(
                &script,
                "#!/bin/sh\ncase \":$PATH:\" in\n  *\":$(dirname \"$0\"):\"*) basename \"$(dirname \"$(dirname \"$0\")\")\" ;;\n  *) echo 'env: node: No such file or directory' >&2; exit 127 ;;\nesac\n",
            )
            .expect("write pi");
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_is_only_in_nvm_is_found_there_and_runs_with_that_folder_on_path() {
        let home = temp("nvm-home");
        fake_nvm(&home, &["v9.11.2", "v24.14.0", "v10.2.1", "v18.20.4"]);
        // A folder that is no version, and one without the program.
        fs::create_dir_all(home.join(".nvm/versions/node/v99.0.0/bin")).unwrap();
        fs::create_dir_all(home.join(".nvm/versions/node/not-a-version/bin")).unwrap();
        let health = inspect_cli(
            descriptor(HarnessId::Pi),
            "/usr/bin:/bin",
            Some(&home),
            Duration::from_secs(10),
        );
        // The highest version by number (24, not 9), found, with that folder on the child's PATH.
        assert_eq!(health.status, "found", "{health:?}");
        assert_eq!(health.version.as_deref(), Some("24.14.0"));
        assert_eq!(health.source.as_deref(), Some("nvm"));
        assert!(health.detail.contains("nvm v24.14.0"), "{}", health.detail);
        assert!(health.detail.contains("not on PATH"), "{}", health.detail);
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn nvm_is_not_used_when_the_cli_is_on_path_or_for_a_missing_home() {
        let home = temp("nvm-home-path");
        fake_nvm(&home, &["v24.14.0"]);
        let bin = Bin::new("nvm-path");
        bin.add("pi", "echo 1.3.0");
        let on_path = inspect_cli(
            descriptor(HarnessId::Pi),
            &bin.path_env(),
            Some(&home),
            Duration::from_secs(10),
        );
        assert_eq!(on_path.version.as_deref(), Some("1.3.0"));
        assert_eq!(on_path.source.as_deref(), Some("path"));

        let nowhere = inspect_cli(
            descriptor(HarnessId::Pi),
            "/usr/bin:/bin",
            Some(&home.join("no-such-home")),
            Duration::from_secs(10),
        );
        assert_eq!(nowhere.status, "missing");
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn nvm_never_supplies_a_program_the_descriptor_does_not_name() {
        let home = temp("nvm-other");
        fake_nvm(&home, &["v24.14.0"]);
        // Kilo is not installed; `pi` is, and must not stand in for it.
        let health = inspect_cli(
            descriptor(HarnessId::Kilo),
            "/usr/bin:/bin",
            Some(&home),
            Duration::from_secs(10),
        );
        assert_eq!(health.status, "missing");
        let _ = fs::remove_dir_all(&home);
    }

    // ── Skills ──

    struct Skills {
        base: PathBuf,
        home: PathBuf,
        bundle: PathBuf,
    }

    impl Skills {
        fn new(label: &str) -> Self {
            let base = temp(label);
            let home = base.join("home");
            let bundle = base.join("bundle");
            fs::create_dir_all(&home).unwrap();
            write_canonical_skill(&bundle, None, "alpha", "body");
            write_canonical_skill(&bundle, None, "beta", "body");
            Self { base, home, bundle }
        }

        fn install(&self, rel_folder: &str, names: &[&str]) {
            for name in names {
                let source = self.bundle.join("skills").join(name).join("SKILL.md");
                let dest = self.home.join(rel_folder).join(name).join("SKILL.md");
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(source, dest).unwrap();
            }
        }

        fn skills(
            &self,
            harness: HarnessId,
            enabled: Option<&[HarnessId]>,
            custom: bool,
        ) -> LightSkillsHealth {
            inspect_skills(harness, Some(&self.bundle), &self.home, enabled, custom)
        }
    }

    impl Drop for Skills {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn skills_are_compared_in_the_folders_the_harness_reads() {
        let fixture = Skills::new("skills");
        let on = [HarnessId::Claude, HarnessId::Pi];

        let missing = fixture.skills(HarnessId::Pi, Some(&on), false);
        assert_eq!(
            (missing.status.as_str(), missing.synced, missing.expected),
            ("missing", 0, 2)
        );
        assert_eq!(missing.roots, ["~/.agents/skills"]);

        fixture.install(".agents/skills", &["alpha"]);
        let partial = fixture.skills(HarnessId::Pi, Some(&on), false);
        assert_eq!(
            (partial.status.as_str(), partial.synced, partial.expected),
            ("partial", 1, 2)
        );

        fixture.install(".agents/skills", &["beta"]);
        assert_eq!(
            fixture.skills(HarnessId::Pi, Some(&on), false).status,
            "synced"
        );

        // Edited since: diverged.
        fs::write(fixture.home.join(".agents/skills/beta/SKILL.md"), "mine\n").unwrap();
        assert_eq!(
            fixture.skills(HarnessId::Pi, Some(&on), false).status,
            "diverged"
        );
    }

    #[test]
    fn a_folder_the_harness_does_not_read_does_not_count() {
        let fixture = Skills::new("skills-not-read");
        // Claude's folder is full. Copilot and Pi read ~/.agents/skills only; Kilo reads both
        // folders the install fills (Claude is enabled and Copilot and Pi need the second one).
        fixture.install(".claude/skills", &["alpha", "beta"]);
        let on = [
            HarnessId::Claude,
            HarnessId::Copilot,
            HarnessId::Pi,
            HarnessId::Kilo,
        ];
        for harness in [HarnessId::Copilot, HarnessId::Pi] {
            let skills = fixture.skills(harness, Some(&on), false);
            assert_eq!(skills.status, "missing", "{harness:?}");
            assert_eq!(skills.roots, ["~/.agents/skills"], "{harness:?}");
        }
        let kilo = fixture.skills(HarnessId::Kilo, Some(&on), false);
        assert_eq!(kilo.roots, ["~/.claude/skills", "~/.agents/skills"]);
        // Every installed folder it reads must hold the skill: one of two is not synced.
        assert_eq!(kilo.status, "diverged");
        fixture.install(".agents/skills", &["alpha", "beta"]);
        assert_eq!(
            fixture.skills(HarnessId::Kilo, Some(&on), false).status,
            "synced"
        );
        assert_eq!(
            fixture.skills(HarnessId::Pi, Some(&on), false).status,
            "synced"
        );
    }

    #[test]
    fn a_custom_codex_home_leaves_copilot_and_pi_unserved_and_kilo_served() {
        let fixture = Skills::new("skills-unserved");
        let on = [
            HarnessId::Codex,
            HarnessId::Copilot,
            HarnessId::Pi,
            HarnessId::Kilo,
        ];
        for harness in [HarnessId::Copilot, HarnessId::Pi] {
            let skills = fixture.skills(harness, Some(&on), true);
            assert_eq!(skills.status, "unserved", "{harness:?}");
            assert!(skills.roots.is_empty());
            assert_eq!(skills.expected, 2);
        }
        let kilo = fixture.skills(HarnessId::Kilo, Some(&on), true);
        assert_eq!(kilo.status, "missing");
        assert_eq!(kilo.roots, ["~/.claude/skills"]);
        // The same set with the default CODEX_HOME serves all three.
        for harness in [HarnessId::Copilot, HarnessId::Pi, HarnessId::Kilo] {
            assert_eq!(
                fixture.skills(harness, Some(&on), false).roots,
                ["~/.agents/skills"],
                "{harness:?}"
            );
        }
    }

    #[test]
    fn a_harness_that_is_not_enabled_is_judged_as_if_it_were_and_unreadable_settings_still_answer()
    {
        let fixture = Skills::new("skills-hypothetical");
        let on = [HarnessId::Claude];
        assert_eq!(
            fixture.skills(HarnessId::Pi, Some(&on), false).roots,
            ["~/.agents/skills"]
        );
        assert_eq!(
            fixture.skills(HarnessId::Pi, None, false).roots,
            ["~/.agents/skills"]
        );
        // The Codex isolation only applies when Codex is enabled.
        assert_eq!(fixture.skills(HarnessId::Pi, None, true).status, "missing");
    }

    #[test]
    fn unreadable_bundled_skills_are_unknown_not_synced() {
        let fixture = Skills::new("skills-unknown");
        let skills = inspect_skills(HarnessId::Kilo, None, &fixture.home, None, false);
        assert_eq!(skills.status, "unknown");
        assert_eq!((skills.synced, skills.expected), (0, 0));
        let unserved = inspect_skills(
            HarnessId::Pi,
            None,
            &fixture.home,
            Some(&[HarnessId::Codex]),
            true,
        );
        assert_eq!(unserved.status, "unserved");
    }

    // ── The whole health ──

    #[cfg(unix)]
    #[test]
    fn health_joins_the_cli_the_skills_and_the_warnings() {
        let fixture = Skills::new("health");
        let bin = Bin::new("health-bin");
        bin.add("pi", "echo 1.3.0");
        fixture.install(".agents/skills", &["alpha", "beta"]);
        let on = [HarnessId::Pi];
        let health = compute_health(
            descriptor(HarnessId::Pi),
            &Inputs {
                home: &fixture.home,
                bundled_root: Some(&fixture.bundle),
                path_env: &bin.path_env(),
                enabled: Some(&on),
                codex_custom: false,
                set_variables: &["PI_CODING_AGENT_DIR"],
                version_timeout: Duration::from_secs(10),
                workspace_root: None,
                rules_on: false,
                mcp_on: false,
                claude_rules_managed: false,
            },
        );
        assert_eq!(health.harness, HarnessId::Pi);
        assert_eq!(health.status, "synced");
        assert_eq!(health.cli.version.as_deref(), Some("1.3.0"));
        assert_eq!(health.skills.roots, ["~/.agents/skills"]);
        assert_eq!(health.warnings.len(), 1, "{:?}", health.warnings);
        assert!(health.warnings[0].contains("PI_CODING_AGENT_DIR"));
        assert!(health.warnings[0].contains("~/.pi/agent/AGENTS.md"));
        assert_eq!(health.rules.status, "off");
        assert_eq!(health.next_action, "No runtime action needed.");

        let json = serde_json::to_value(&health).expect("serialize");
        assert_eq!(json["harness"], "pi");
        assert_eq!(json["skills"]["status"], "synced");
        assert_eq!(json["cli"]["status"], "found");
    }

    #[cfg(unix)]
    #[test]
    fn an_unserved_harness_gets_a_warning_and_a_way_out() {
        let fixture = Skills::new("health-unserved");
        let on = [HarnessId::Codex, HarnessId::Copilot];
        let health = compute_health(
            descriptor(HarnessId::Copilot),
            &Inputs {
                home: &fixture.home,
                bundled_root: Some(&fixture.bundle),
                path_env: "/nonexistent-aw-dir",
                enabled: Some(&on),
                codex_custom: true,
                set_variables: &[],
                version_timeout: Duration::from_secs(1),
                workspace_root: None,
                rules_on: false,
                mcp_on: false,
                claude_rules_managed: false,
            },
        );
        assert_eq!(health.status, "unserved");
        assert_eq!(health.cli.status, "missing");
        assert_eq!(health.warnings.len(), 1);
        for needle in ["Copilot", "~/.agents/skills", "CODEX_HOME"] {
            assert!(health.warnings[0].contains(needle), "{:?}", health.warnings);
        }
        assert!(
            health.next_action.contains("CODEX_HOME"),
            "{}",
            health.next_action
        );
    }

    fn skills_row(status: &str) -> LightSkillsHealth {
        LightSkillsHealth {
            status: status.into(),
            synced: 0,
            expected: 0,
            roots: Vec::new(),
        }
    }

    fn rules_row(status: &str) -> LightRulesHealth {
        LightRulesHealth {
            status: status.into(),
            path: "~/x.md".into(),
            refinement_lines: 0,
            user_managed: false,
            conflict_reason: None,
            detail: String::new(),
        }
    }

    fn mcp_row(status: &str) -> LightMcpHealth {
        LightMcpHealth {
            status: status.into(),
            path: "~/x.json".into(),
            playwright_version: None,
            detail: String::new(),
        }
    }

    #[test]
    fn the_overall_status_follows_the_skills_then_the_rules_then_the_mcp_entry() {
        let status = |skills: &str, rules: &str, mcp: &str| {
            overall_status(&skills_row(skills), &rules_row(rules), &mcp_row(mcp))
        };
        assert_eq!(status("synced", "synced", "synced"), "synced");
        assert_eq!(status("missing", "stale", "invalid"), "missing");
        assert_eq!(status("synced", "stale", "invalid"), "stale");
        assert_eq!(status("synced", "synced", "invalid"), "invalid");
        assert_eq!(status("synced", "off", "diverged"), "diverged");
        // A target that is switched off never counts against the harness.
        assert_eq!(status("synced", "off", "off"), "synced");
        assert_eq!(status("synced", "synced", "off"), "synced");
        assert_eq!(status("partial", "off", "off"), "partial");
    }

    #[test]
    fn the_next_action_names_the_rules_file_or_the_mcp_file() {
        let action = |skills: &str, rules: &str, mcp: &str| {
            next_action("Pi", &skills_row(skills), &rules_row(rules), &mcp_row(mcp))
        };
        assert_eq!(
            action("synced", "synced", "synced"),
            "No runtime action needed."
        );
        assert_eq!(action("synced", "off", "off"), "No runtime action needed.");
        assert_eq!(
            action("synced", "synced", "missing"),
            "Run Install or Update on the Pi page."
        );
        assert_eq!(
            action("synced", "synced", "stale"),
            "Run Install or Update on the Pi page."
        );
        for status in ["diverged", "invalid"] {
            assert_eq!(
                action("synced", "synced", status),
                "Resolve the MCP file conflict on the Pi page."
            );
        }
        assert!(action("synced", "synced", "unknown").contains("MCP file"));
        // The rules file is named first, as before.
        assert!(action("synced", "diverged", "invalid").contains("rules file"));
        assert_eq!(
            action("synced", "missing", "diverged"),
            "Run Install or Update on the Pi page."
        );
        assert!(action("unserved", "synced", "invalid").contains("CODEX_HOME"));
    }

    #[test]
    fn a_pinned_version_is_read_from_the_entry_and_nothing_else() {
        use crate::light_mcp::pinned_version;
        let pinned = |entry: serde_json::Value| pinned_version(&entry);
        assert_eq!(
            pinned(serde_json::json!({"args": ["-y", "@playwright/mcp@0.0.48", "--isolated"]}))
                .as_deref(),
            Some("0.0.48")
        );
        assert_eq!(
            pinned(serde_json::json!({"command": ["npx", "@playwright/mcp@1.2.3-rc.1"]}))
                .as_deref(),
            Some("1.2.3-rc.1")
        );
        for entry in [
            serde_json::json!({"args": ["@playwright/mcp@"]}),
            serde_json::json!({"args": ["@playwright/mcp@1;rm -rf"]}),
            serde_json::json!({"args": ["@playwright/mcp@sk-live token"]}),
            serde_json::json!({"args": [1, 2]}),
            serde_json::json!({"command": "@playwright/mcp@0.0.48"}),
            serde_json::json!({}),
            serde_json::json!("@playwright/mcp@0.0.48"),
        ] {
            assert_eq!(pinned(entry.clone()), None, "{entry}");
        }
    }

    #[test]
    fn central_harnesses_have_no_light_health() {
        for harness in [
            HarnessId::Codex,
            HarnessId::OpenCode,
            HarnessId::Claude,
            HarnessId::Cursor,
        ] {
            let error = get_light_runtime_health(harness).expect_err("not a light harness");
            assert!(error.contains(harness.as_str()), "{error}");
        }
    }
}
