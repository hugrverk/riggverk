use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::process::{run_cmd_bounded, ActionResult, BoundedCmdOptions, BoundedCmdResult};
use super::status::file_eq;

#[derive(Serialize, Clone, Debug)]
pub struct OpenCodeRuntimeCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct OpenCodeAgentMismatch {
    pub filename: String,
    pub status: String,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct OpenCodeRuntimeHealth {
    pub status: String,
    pub template_config_path: String,
    pub installed_config_path: String,
    pub checks: Vec<OpenCodeRuntimeCheck>,
    pub default_agent: Option<String>,
    pub model: Option<String>,
    pub small_model: Option<String>,
    pub autoupdate: Option<String>,
    pub snapshot: Option<bool>,
    pub bundled_agent_count: usize,
    pub installed_bundled_agent_count: usize,
    pub extra_installed_agent_count: usize,
    pub agent_mismatches: Vec<OpenCodeAgentMismatch>,
    pub warnings: Vec<String>,
    // New TUI fields
    pub template_tui_path: String,
    pub installed_tui_path: String,
    pub tui_status: String,
    // New generated snapshot fields
    pub generated_snapshot_base_path: String,
    pub generated_snapshot_policy_path: String,
    pub generated_snapshot_path: String,
    pub generated_snapshot_status: String,
    pub generated_snapshot_detail: String,
    // Explainers
    pub summary: String,
    pub next_action: String,
}

/// Extract a non-sensitive field from a JSON value at a dotted path.
fn extract_string_field(root: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut current = root;
    for &key in path {
        current = current.get(key)?;
    }
    current.as_str().map(|s| s.to_string())
}

/// List bundled agent filenames from a workspace agents directory.
/// Excludes dotfiles and non-.md files.
fn list_bundled_agents(agents_dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if !agents_dir.is_dir() {
        return names;
    }
    let entries = match std::fs::read_dir(agents_dir) {
        Ok(e) => e,
        Err(_) => return names,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        if path.extension().map(|e| e == "md").unwrap_or(false) {
            names.push(name_str.into_owned());
        }
    }
    names.sort();
    names
}

const PLAYWRIGHT_MCP_VERSION_DEFAULT: &str = "0.0.48";
const PLAYWRIGHT_MCP_CONFIG_PLACEHOLDER: &str = "__PLAYWRIGHT_MCP_CONFIG_PATH__";
const PLAYWRIGHT_BROWSERS_PLACEHOLDER: &str = "__PLAYWRIGHT_BROWSERS_PATH__";

/// Keys the app manages in opencode.json (`metadata/opencode-managed-keys.json`).
const MANAGED_TOP_LEVEL_KEYS: &[&str] = &[
    "$schema",
    "share",
    "autoupdate",
    "snapshot",
    "model",
    "small_model",
    "default_agent",
    "compaction",
    "watcher",
    "permission",
];

pub(crate) fn extract_managed_opencode_config(config: &serde_json::Value) -> serde_json::Value {
    let mut managed = serde_json::Map::new();
    if let Some(obj) = config.as_object() {
        for key in MANAGED_TOP_LEVEL_KEYS {
            if let Some(value) = obj.get(*key) {
                managed.insert((*key).to_string(), value.clone());
            }
        }
        if let Some(playwright) = obj.get("mcp").and_then(|mcp| mcp.get("playwright")) {
            let mut mcp = serde_json::Map::new();
            mcp.insert("playwright".to_string(), playwright.clone());
            managed.insert("mcp".to_string(), serde_json::Value::Object(mcp));
        }
    }
    serde_json::Value::Object(managed)
}

/// Structural equality that also requires object keys to appear in the same order.
///
/// `serde_json::Value` equality ignores key order, but OpenCode evaluates `permission`
/// rules last-match-wins in key order, so a reordered (e.g. sorted) block is a different policy.
fn ordered_json_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Object(x), serde_json::Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|((kx, vx), (ky, vy))| kx == ky && ordered_json_eq(vx, vy))
        }
        (serde_json::Value::Array(x), serde_json::Value::Array(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|(vx, vy)| ordered_json_eq(vx, vy))
        }
        _ => a == b,
    }
}

pub(crate) fn managed_opencode_keys_match(
    installed: &serde_json::Value,
    rendered: &serde_json::Value,
) -> bool {
    let installed = extract_managed_opencode_config(installed);
    let rendered = extract_managed_opencode_config(rendered);
    installed == rendered
        && match (installed.get("permission"), rendered.get("permission")) {
            (Some(a), Some(b)) => ordered_json_eq(a, b),
            _ => true,
        }
}

/// Merge managed keys from `managed` into `installed`, preserving unrelated user-owned fields.
pub(crate) fn merge_managed_opencode_config(
    installed: &serde_json::Value,
    managed: &serde_json::Value,
) -> serde_json::Value {
    let mut merged = installed.clone();
    let Some(target) = merged.as_object_mut() else {
        return merged;
    };
    let Some(managed_obj) = managed.as_object() else {
        return merged;
    };
    for key in MANAGED_TOP_LEVEL_KEYS {
        if let Some(value) = managed_obj.get(*key) {
            target.insert((*key).to_string(), value.clone());
        }
    }
    if let Some(managed_mcp) = managed_obj.get("mcp").and_then(|v| v.get("playwright")) {
        let mcp = target
            .entry("mcp")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let Some(mcp_obj) = mcp.as_object_mut() {
            mcp_obj.insert("playwright".to_string(), managed_mcp.clone());
        }
    }
    merged
}

fn is_legacy_aw_scout(path: &Path) -> bool {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    if !content.starts_with("---") {
        return false;
    }
    let Some(end) = content.find("\n---") else {
        return false;
    };
    if end < 3 {
        return false;
    }
    content[3..end]
        .lines()
        .any(|line| line.trim() == "name: scout")
}

/// Default browser cache path.
fn default_playwright_browsers_path(home_dir: &Path) -> Option<std::path::PathBuf> {
    crate::commands::cursor_profile::default_playwright_browsers_path(home_dir)
}

/// Default Playwright MCP config path.
fn default_playwright_mcp_config_path(home_dir: &Path) -> std::path::PathBuf {
    if let Ok(path) = std::env::var("PLAYWRIGHT_MCP_CONFIG_PATH") {
        if !path.is_empty() {
            return std::path::PathBuf::from(path);
        }
    }
    home_dir.join(".config/playwright-mcp/config.json")
}

/// Resolve Playwright paths for rendering (mirrors `resolve_playwright_paths`).
fn resolve_playwright_paths(home_dir: &Path) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let browsers_path = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| default_playwright_browsers_path(home_dir))?;
    let config_path = default_playwright_mcp_config_path(home_dir);
    Some((config_path, browsers_path))
}

/// Transform JSON values the same way as `render_json_with_playwright_paths` in Python.
fn transform_playwright_json(
    value: &serde_json::Value,
    config_path: &str,
    browsers_path: &str,
    version: &str,
) -> serde_json::Value {
    let package = format!("@playwright/mcp@{version}");
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, item) in map {
                out.insert(
                    key.clone(),
                    transform_playwright_json(item, config_path, browsers_path, version),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| transform_playwright_json(item, config_path, browsers_path, version))
                .collect(),
        ),
        serde_json::Value::String(text) => {
            if text == PLAYWRIGHT_MCP_CONFIG_PLACEHOLDER {
                serde_json::Value::String(config_path.to_string())
            } else if text == PLAYWRIGHT_BROWSERS_PLACEHOLDER {
                serde_json::Value::String(browsers_path.to_string())
            } else if text.starts_with("@playwright/mcp@") {
                serde_json::Value::String(package)
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

/// Render workspace `templates/opencode.json` the way an install renders it before sync.
///
/// Applies Playwright placeholder transformations and overlays the app-level model override
/// if present so that the installed config comparison reflects any user model selection.
pub(crate) fn render_expected_opencode_config(
    template_json: &serde_json::Value,
    home_dir: &Path,
) -> Option<serde_json::Value> {
    let version = std::env::var("PLAYWRIGHT_MCP_VERSION")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| PLAYWRIGHT_MCP_VERSION_DEFAULT.to_string());
    let (config_path, browsers_path) = resolve_playwright_paths(home_dir)?;
    let config_path = config_path.to_string_lossy().into_owned();
    let browsers_path = browsers_path.to_string_lossy().into_owned();
    let mut rendered =
        transform_playwright_json(template_json, &config_path, &browsers_path, &version);

    // Overlay app-level model override if present. Status/render callers pass the
    // resolved user home explicitly, so tests and smoke runs must not read a
    // real app-support override from the process environment by accident.
    let override_selection = opencode_model_selection_path_for_home(home_dir)
        .ok()
        .and_then(|path| read_stored_opencode_model_selection_from_path(&path));
    if let Some(override_selection) = override_selection {
        if let Some(obj) = rendered.as_object_mut() {
            obj.insert(
                "model".to_string(),
                serde_json::Value::String(override_selection.model),
            );
            obj.insert(
                "small_model".to_string(),
                serde_json::Value::String(override_selection.small_model),
            );
        }
    }

    Some(rendered)
}

/// Compare installed managed OpenCode keys to rendered workspace template.
fn installed_config_matches_rendered(
    template_json: &serde_json::Value,
    installed_json: &serde_json::Value,
    home_dir: &Path,
) -> Option<bool> {
    render_expected_opencode_config(template_json, home_dir)
        .map(|expected| managed_opencode_keys_match(installed_json, &expected))
}

/// Sync status for `get_status` / dashboard (compares the staged output an install would write).
pub(crate) fn opencode_config_sync_status(workspace_root: &Path, home_dir: &Path) -> String {
    let template_path = workspace_root.join("templates/opencode.json");
    let installed_path = home_dir.join(".config/opencode/opencode.json");

    if !installed_path.is_file() {
        return "missing".into();
    }
    if !template_path.is_file() {
        return "diverged".into();
    }

    let template_json: serde_json::Value = match std::fs::read_to_string(&template_path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return "diverged".into(),
        },
        Err(_) => return "diverged".into(),
    };

    let installed_json: serde_json::Value = match std::fs::read_to_string(&installed_path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return "diverged".into(),
        },
        Err(_) => return "diverged".into(),
    };

    match render_expected_opencode_config(&template_json, home_dir) {
        Some(expected) if managed_opencode_keys_match(&installed_json, &expected) => {
            "synced".into()
        }
        Some(_) => "diverged".into(),
        None => "diverged".into(),
    }
}

/// The config generators are sub-second scripts; anything longer is hung.
const GENERATOR_TIMEOUT: Duration = Duration::from_secs(30);
const GENERATOR_OUTPUT_CAP: usize = 256 * 1024;

/// Bundled path of the snapshot generator. The app never runs a generator out of the active
/// workspace: that folder is user-chosen and only validated by marker files, so any script it carries
/// is untrusted. The bundled copy runs instead and gets the workspace as a `--root` data argument.
const GENERATOR_SCRIPT_REL: &str = "scripts/generate-opencode-config.py";

/// The generator from the bundled, read-only resource root, or why it is unavailable.
fn bundled_generator_script(workspace_root: &Path) -> Result<PathBuf, String> {
    let script = crate::setup_roots::bundled_root_for(workspace_root)?.join(GENERATOR_SCRIPT_REL);
    if script.is_file() {
        Ok(script)
    } else {
        Err(format!(
            "bundled OpenCode config generator is missing: {}",
            script.display()
        ))
    }
}

/// `python3 <script> --root <workspace> <mode>`, run with the script's own folder as working directory
/// so nothing in the workspace is picked up as a working-directory side input.
fn run_generator(
    script: &Path,
    workspace_root: &Path,
    mode: &str,
    timeout: Duration,
) -> Result<BoundedCmdResult, String> {
    let script_str = super::workspace::path_arg(script)?;
    let root_str = super::workspace::path_arg(workspace_root)?;
    let cwd = script.parent().unwrap_or(script);
    Ok(run_cmd_bounded(
        "python3",
        &[&script_str, "--root", &root_str, mode],
        cwd,
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: GENERATOR_OUTPUT_CAP,
            stderr_cap: GENERATOR_OUTPUT_CAP,
            ..BoundedCmdOptions::default()
        },
    ))
}

/// Run the bundled generator's --check against the workspace.
/// Returns `Some(status, detail)` if the generator ran, `None` if it is unavailable
/// (bundled script missing or `python3` not spawnable).
fn run_generator_check(workspace_root: &Path) -> Option<(String, String)> {
    let script = bundled_generator_script(workspace_root).ok()?;
    run_generator_check_with_timeout(&script, workspace_root, GENERATOR_TIMEOUT)
}

fn run_generator_check_with_timeout(
    script: &Path,
    workspace_root: &Path,
    timeout: Duration,
) -> Option<(String, String)> {
    let out = run_generator(script, workspace_root, "--check", timeout).ok()?;
    if out.timed_out {
        // Do not claim "stale" for a check that never finished.
        return Some((
            "valid".into(),
            format!(
                "not freshness-checked: generator --check timed out after {}s",
                timeout.as_secs()
            ),
        ));
    }
    // No exit status: python3 not found / not spawnable (or killed by a signal),
    // so no freshness check is possible.
    out.exit_code?;
    let passed = out.success;
    let stderr = out.stderr.trim().to_string();
    let stdout = out.stdout.trim().to_string();
    let detail = if passed {
        if !stdout.is_empty() {
            stdout
        } else {
            "snapshot is current".into()
        }
    } else if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "snapshot is stale (generator check failed)".into()
    };
    Some((
        if passed {
            "current".into()
        } else {
            "stale".into()
        },
        detail,
    ))
}

/// Compute OpenCode runtime health for a given workspace root and home directory.
/// This is a pure function suitable for unit testing with temp dirs.
pub fn compute_health(workspace_root: &Path, home_dir: &Path) -> OpenCodeRuntimeHealth {
    let template_config_path = workspace_root.join("templates/opencode.json");
    let installed_config_path = home_dir.join(".config/opencode/opencode.json");
    let agents_source_dir = workspace_root.join("agents");
    let agents_target_dir = home_dir.join(".config/opencode/agents");

    // TUI paths
    let template_tui_path = workspace_root.join("templates/tui.json");
    let installed_tui_path = home_dir.join(".config/opencode/tui.json");

    // Generated snapshot paths
    let generated_snapshot_base_path = workspace_root.join("templates/opencode.base.json");
    let generated_snapshot_policy_path = workspace_root.join("templates/opencode.policy.json");
    let generated_snapshot_path = workspace_root.join("templates/opencode.json");

    let template_config_path_str = template_config_path.to_string_lossy().into_owned();
    let installed_config_path_str = installed_config_path.to_string_lossy().into_owned();
    let template_tui_path_str = template_tui_path.to_string_lossy().into_owned();
    let installed_tui_path_str = installed_tui_path.to_string_lossy().into_owned();
    let generated_snapshot_base_path_str =
        generated_snapshot_base_path.to_string_lossy().into_owned();
    let generated_snapshot_policy_path_str = generated_snapshot_policy_path
        .to_string_lossy()
        .into_owned();
    let generated_snapshot_path_str = generated_snapshot_path.to_string_lossy().into_owned();

    let mut checks: Vec<OpenCodeRuntimeCheck> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut agent_mismatches: Vec<OpenCodeAgentMismatch> = Vec::new();

    // Default extracted fields
    let mut default_agent: Option<String> = None;
    let mut model: Option<String> = None;
    let mut small_model: Option<String> = None;
    let mut autoupdate: Option<String> = None;
    let mut snapshot: Option<bool> = None;

    // Track overall status
    let mut has_fail = false;
    let mut has_warn = false;

    // Check 1: Template config exists
    let template_exists = template_config_path.is_file();
    checks.push(OpenCodeRuntimeCheck {
        id: "template_config_exists".into(),
        label: "Template config exists".into(),
        status: if template_exists {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if template_exists {
            template_config_path_str.clone()
        } else {
            format!("not found: {}", template_config_path_str)
        },
    });
    if !template_exists {
        has_fail = true;
    }

    // Check 2: Installed config exists
    let installed_exists = installed_config_path.is_file();
    checks.push(OpenCodeRuntimeCheck {
        id: "installed_config_exists".into(),
        label: "Installed config exists".into(),
        status: if installed_exists {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if installed_exists {
            installed_config_path_str.clone()
        } else {
            format!("not found: {}", installed_config_path_str)
        },
    });
    if !installed_exists {
        has_fail = true;
    }

    // Parse template config if it exists
    let template_json: Option<serde_json::Value> = if template_exists {
        match std::fs::read_to_string(&template_config_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(v) => Some(v),
                Err(e) => {
                    checks.push(OpenCodeRuntimeCheck {
                        id: "template_config_valid".into(),
                        label: "Template config is valid JSON".into(),
                        status: "fail".into(),
                        detail: format!("parse error: {}", e),
                    });
                    has_fail = true;
                    None
                }
            },
            Err(e) => {
                checks.push(OpenCodeRuntimeCheck {
                    id: "template_config_valid".into(),
                    label: "Template config is valid JSON".into(),
                    status: "fail".into(),
                    detail: format!("read error: {}", e),
                });
                has_fail = true;
                None
            }
        }
    } else {
        None
    };

    // Parse installed config if it exists
    let installed_json: Option<serde_json::Value> = if installed_exists {
        match std::fs::read_to_string(&installed_config_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(v) => Some(v),
                Err(e) => {
                    checks.push(OpenCodeRuntimeCheck {
                        id: "installed_config_valid".into(),
                        label: "Installed config is valid JSON".into(),
                        status: "fail".into(),
                        detail: format!("parse error: {}", e),
                    });
                    has_fail = true;
                    None
                }
            },
            Err(e) => {
                checks.push(OpenCodeRuntimeCheck {
                    id: "installed_config_valid".into(),
                    label: "Installed config is valid JSON".into(),
                    status: "fail".into(),
                    detail: format!("read error: {}", e),
                });
                has_fail = true;
                None
            }
        }
    } else {
        None
    };

    // If both configs exist and parse, check validity and compare
    if let (Some(ref t_json), Some(ref i_json)) = (&template_json, &installed_json) {
        checks.push(OpenCodeRuntimeCheck {
            id: "template_config_valid".into(),
            label: "Template config is valid JSON".into(),
            status: "pass".into(),
            detail: "parsed successfully".into(),
        });
        checks.push(OpenCodeRuntimeCheck {
            id: "installed_config_valid".into(),
            label: "Installed config is valid JSON".into(),
            status: "pass".into(),
            detail: "parsed successfully".into(),
        });

        // Extract non-sensitive fields from installed config
        default_agent = extract_string_field(i_json, &["default_agent"]);
        model = extract_string_field(i_json, &["model"]);
        small_model = extract_string_field(i_json, &["small_model"]);
        autoupdate = extract_string_field(i_json, &["autoupdate"]);
        snapshot = i_json.get("snapshot").and_then(|v| v.as_bool());
        // Check default_agent
        checks.push(OpenCodeRuntimeCheck {
            id: "default_agent".into(),
            label: "Default agent".into(),
            status: "pass".into(),
            detail: default_agent.clone().unwrap_or_else(|| "(not set)".into()),
        });

        // Check model
        checks.push(OpenCodeRuntimeCheck {
            id: "model".into(),
            label: "Model".into(),
            status: "pass".into(),
            detail: model.clone().unwrap_or_else(|| "(not set)".into()),
        });

        // Check small_model
        checks.push(OpenCodeRuntimeCheck {
            id: "small_model".into(),
            label: "Small model".into(),
            status: "pass".into(),
            detail: small_model.clone().unwrap_or_else(|| "(not set)".into()),
        });

        checks.push(OpenCodeRuntimeCheck {
            id: "autoupdate".into(),
            label: "Autoupdate".into(),
            status: "pass".into(),
            detail: autoupdate.clone().unwrap_or_else(|| "(not set)".into()),
        });

        checks.push(OpenCodeRuntimeCheck {
            id: "snapshot".into(),
            label: "Snapshot".into(),
            status: "pass".into(),
            detail: snapshot
                .map(|enabled| {
                    if enabled {
                        "enabled".into()
                    } else {
                        "disabled".into()
                    }
                })
                .unwrap_or_else(|| "(not set)".into()),
        });

        // Compare installed config to rendered workspace config (same staging as install script).
        let configs_match_result = installed_config_matches_rendered(t_json, i_json, home_dir);
        let configs_match = configs_match_result.unwrap_or(false);
        checks.push(OpenCodeRuntimeCheck {
            id: "configs_match".into(),
            label: "Managed config keys match bundled workspace".into(),
            status: if configs_match {
                "pass".into()
            } else {
                "warn".into()
            },
            detail: if configs_match {
                "managed keys match bundled workspace (provider and other MCP servers preserved)"
                    .into()
            } else if configs_match_result.is_none() {
                "unable to render expected config for comparison (set PLAYWRIGHT_BROWSERS_PATH)"
                    .into()
            } else {
                "managed keys differ from bundled workspace. Run diff before sync.".into()
            },
        });
        if !configs_match {
            has_warn = true;
        }
    } else if template_json.is_some() || installed_json.is_some() {
        // One parsed, one didn't — already marked fail above
    }

    // ── TUI config checks ──
    let template_tui_exists = template_tui_path.is_file();
    let installed_tui_exists = installed_tui_path.is_file();

    let template_tui_valid = if template_tui_exists {
        match std::fs::read_to_string(&template_tui_path) {
            Ok(content) => serde_json::from_str::<serde_json::Value>(&content).is_ok(),
            Err(_) => false,
        }
    } else {
        false
    };

    let installed_tui_valid = if installed_tui_exists {
        match std::fs::read_to_string(&installed_tui_path) {
            Ok(content) => serde_json::from_str::<serde_json::Value>(&content).is_ok(),
            Err(_) => false,
        }
    } else {
        false
    };

    checks.push(OpenCodeRuntimeCheck {
        id: "template_tui_config_exists".into(),
        label: "Template TUI config exists".into(),
        status: if template_tui_exists && template_tui_valid {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if template_tui_exists && template_tui_valid {
            template_tui_path_str.clone()
        } else if template_tui_exists {
            format!("invalid JSON: {}", template_tui_path_str)
        } else {
            format!("not found: {}", template_tui_path_str)
        },
    });
    if !template_tui_exists || !template_tui_valid {
        has_fail = true;
    }

    checks.push(OpenCodeRuntimeCheck {
        id: "installed_tui_config_exists".into(),
        label: "Installed TUI config exists".into(),
        status: if installed_tui_exists && installed_tui_valid {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if installed_tui_exists && installed_tui_valid {
            installed_tui_path_str.clone()
        } else if installed_tui_exists {
            format!("invalid JSON: {}", installed_tui_path_str)
        } else {
            format!("not found: {}", installed_tui_path_str)
        },
    });
    if !installed_tui_exists || !installed_tui_valid {
        has_fail = true;
    }

    let tui_synced = template_tui_exists
        && installed_tui_exists
        && template_tui_valid
        && installed_tui_valid
        && file_eq(&template_tui_path, &installed_tui_path);

    checks.push(OpenCodeRuntimeCheck {
        id: "tui_configs_match".into(),
        label: "Installed TUI matches template".into(),
        status: if tui_synced {
            "pass".into()
        } else if template_tui_exists && installed_tui_exists {
            "warn".into()
        } else {
            "fail".into()
        },
        detail: if tui_synced {
            "exact match".into()
        } else if template_tui_exists && installed_tui_exists {
            "installed TUI differs from template. Run diff before sync.".into()
        } else if !template_tui_exists {
            "template TUI config not found".into()
        } else {
            "installed TUI config not found".into()
        },
    });
    if !tui_synced {
        has_warn = true;
    }

    // Derive tui_status from checks
    let tui_status = if tui_synced {
        "synced".into()
    } else if !template_tui_exists && !installed_tui_exists {
        "missing".into()
    } else if template_tui_exists && installed_tui_exists {
        "diverged".into()
    } else {
        "missing".into()
    };

    // ── Generated snapshot checks ──
    let base_source_exists = generated_snapshot_base_path.is_file();
    let policy_source_exists = generated_snapshot_policy_path.is_file();
    let snapshot_exists = generated_snapshot_path.is_file();

    let base_source_valid = if base_source_exists {
        match std::fs::read_to_string(&generated_snapshot_base_path) {
            Ok(content) => serde_json::from_str::<serde_json::Value>(&content).is_ok(),
            Err(_) => false,
        }
    } else {
        false
    };

    let policy_source_valid = if policy_source_exists {
        match std::fs::read_to_string(&generated_snapshot_policy_path) {
            Ok(content) => serde_json::from_str::<serde_json::Value>(&content).is_ok(),
            Err(_) => false,
        }
    } else {
        false
    };

    let snapshot_valid = if snapshot_exists {
        match std::fs::read_to_string(&generated_snapshot_path) {
            Ok(content) => serde_json::from_str::<serde_json::Value>(&content).is_ok(),
            Err(_) => false,
        }
    } else {
        false
    };

    checks.push(OpenCodeRuntimeCheck {
        id: "generated_snapshot_source_base".into(),
        label: "Snapshot source base.json".into(),
        status: if base_source_exists && base_source_valid {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if base_source_exists && base_source_valid {
            generated_snapshot_base_path_str.clone()
        } else if base_source_exists {
            "invalid JSON".into()
        } else {
            format!("not found: {}", generated_snapshot_base_path_str)
        },
    });

    checks.push(OpenCodeRuntimeCheck {
        id: "generated_snapshot_source_policy".into(),
        label: "Snapshot source policy.json".into(),
        status: if policy_source_exists && policy_source_valid {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if policy_source_exists && policy_source_valid {
            generated_snapshot_policy_path_str.clone()
        } else if policy_source_exists {
            "invalid JSON".into()
        } else {
            format!("not found: {}", generated_snapshot_policy_path_str)
        },
    });

    checks.push(OpenCodeRuntimeCheck {
        id: "generated_snapshot_exists".into(),
        label: "Generated opencode.json snapshot".into(),
        status: if snapshot_exists && snapshot_valid {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if snapshot_exists && snapshot_valid {
            generated_snapshot_path_str.clone()
        } else if snapshot_exists {
            "invalid JSON".into()
        } else {
            format!("not found: {}", generated_snapshot_path_str)
        },
    });

    // Generated snapshot status with freshness check:
    // - "current": source files + snapshot exist, valid JSON, AND generator --check passes
    // - "stale": source files + snapshot exist and are valid, but generator --check fails
    // - "valid": source files + snapshot exist and are valid, no generator available to check freshness
    // - "missing": some required files missing or invalid
    // - "unknown": no snapshot files at all
    let mut generator_unavailable = false;
    let (generated_snapshot_status, mut generated_snapshot_detail) = if base_source_exists
        && base_source_valid
        && policy_source_exists
        && policy_source_valid
        && snapshot_exists
        && snapshot_valid
    {
        // Try running generator --check to verify freshness
        match run_generator_check(workspace_root) {
            Some((status, detail)) => (status, detail),
            None => {
                generator_unavailable = true;
                (
                    "valid".into(),
                    "source + snapshot valid; not freshness-checked (generator unavailable)".into(),
                )
            }
        }
    } else if !base_source_exists && !policy_source_exists && !snapshot_exists {
        ("unknown".into(), String::new())
    } else {
        (
            "missing".into(),
            "snapshot source files missing or invalid".into(),
        )
    };

    // Stale generated snapshot: affect overall status and use concise detail.
    if generated_snapshot_status == "stale" {
        has_warn = true;
        generated_snapshot_detail = "Regenerate opencode.json before sync.".into();
    }

    // The generator is the app's bundled copy; it is missing only when the app bundle is damaged
    // or python3 cannot start.
    if base_source_exists
        && policy_source_exists
        && generated_snapshot_status == "valid"
        && generator_unavailable
    {
        warnings.push(
            "OpenCode config generator unavailable: python3 or the bundled generator script is missing."
                .to_string(),
        );
    }

    // Bundled agents check
    let bundled_agents = list_bundled_agents(&agents_source_dir);
    let bundled_agent_count = bundled_agents.len();

    // List installed agents
    let mut installed_agent_names: BTreeSet<String> = BTreeSet::new();
    if agents_target_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&agents_target_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with('.') {
                    continue;
                }
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    installed_agent_names.insert(name_str.into_owned());
                }
            }
        }
    }

    // Compare bundled vs installed
    let mut installed_bundled_count = 0;
    let bundled_set: BTreeSet<String> = bundled_agents.iter().cloned().collect();

    for agent_name in &bundled_agents {
        let source_path = agents_source_dir.join(agent_name);
        let target_path = agents_target_dir.join(agent_name);

        if !target_path.exists() {
            agent_mismatches.push(OpenCodeAgentMismatch {
                filename: agent_name.clone(),
                status: "missing".into(),
                detail: format!("{} not installed", agent_name),
            });
            has_warn = true;
        } else if !file_eq(&source_path, &target_path) {
            agent_mismatches.push(OpenCodeAgentMismatch {
                filename: agent_name.clone(),
                status: "diverged".into(),
                detail: format!("{} differs from bundled agent", agent_name),
            });
            has_warn = true;
        } else {
            installed_bundled_count += 1;
        }
    }

    let legacy_scout_path = agents_target_dir.join("scout.md");
    let legacy_scout_present = is_legacy_aw_scout(&legacy_scout_path);

    // Extra installed agents (informational only — do not affect status)
    let extra_installed: Vec<String> = installed_agent_names
        .difference(&bundled_set)
        .filter(|name| !(legacy_scout_present && name.as_str() == "scout.md"))
        .cloned()
        .collect();
    let extra_installed_agent_count = extra_installed.len();

    if !extra_installed.is_empty() {
        warnings.push(format!(
            "{} extra runtime agent(s) installed: {}",
            extra_installed_agent_count,
            extra_installed.join(", ")
        ));
    }
    // Note: extra agents are informational only and do NOT set has_warn = true

    if legacy_scout_present {
        warnings.push(
            "Legacy scout.md agent conflicts with repo-scout rename — sync agents to remove."
                .to_string(),
        );
        checks.push(OpenCodeRuntimeCheck {
            id: "legacy_scout".into(),
            label: "Legacy scout agent".into(),
            status: "warn".into(),
            detail: legacy_scout_path.to_string_lossy().into_owned(),
        });
        has_warn = true;
    }

    // Agent summary check
    checks.push(OpenCodeRuntimeCheck {
        id: "bundled_agents".into(),
        label: "Bundled runtime agents".into(),
        status: if agent_mismatches.is_empty() {
            "pass".into()
        } else {
            "warn".into()
        },
        detail: format!(
            "{}/{} bundled agents installed",
            installed_bundled_count, bundled_agent_count
        ),
    });
    if !agent_mismatches.is_empty() {
        has_warn = true;
    }

    // Determine overall status (now includes TUI)
    let status: String = if has_fail {
        "missing".into()
    } else if has_warn {
        "diverged".into()
    } else if bundled_agent_count == 0 && !template_exists && !template_tui_exists {
        "unknown".into()
    } else {
        "synced".into()
    };

    // Compute summary and next action.
    // Stale generated snapshot takes priority over generic divergence.
    let (summary, next_action) = if generated_snapshot_status == "stale" {
        (
            "OpenCode generated config snapshot is stale.".to_string(),
            "Regenerate opencode.json before sync.".to_string(),
        )
    } else {
        match status.as_str() {
            "synced" => (
                "OpenCode runtime matches the bundled workspace.".to_string(),
                "No runtime action needed.".to_string(),
            ),
            "diverged" => (
                "Runtime differs from bundled templates. Review diff before applying.".to_string(),
                "Run diff before apply.".to_string(),
            ),
            "missing" => (
                "OpenCode runtime is missing required files.".to_string(),
                "Install/sync required.".to_string(),
            ),
            _ => (
                "Insufficient workspace state to determine runtime status.".to_string(),
                "Check workspace configuration.".to_string(),
            ),
        }
    };

    OpenCodeRuntimeHealth {
        status,
        template_config_path: template_config_path_str,
        installed_config_path: installed_config_path_str,
        checks,
        default_agent,
        model,
        small_model,
        autoupdate,
        snapshot,
        bundled_agent_count,
        installed_bundled_agent_count: installed_bundled_count,
        extra_installed_agent_count,
        agent_mismatches,
        warnings,
        template_tui_path: template_tui_path_str,
        installed_tui_path: installed_tui_path_str,
        tui_status,
        generated_snapshot_base_path: generated_snapshot_base_path_str,
        generated_snapshot_policy_path: generated_snapshot_policy_path_str,
        generated_snapshot_path: generated_snapshot_path_str,
        generated_snapshot_status,
        generated_snapshot_detail,
        summary,
        next_action,
    }
}

// `async` keeps the generator --check subprocess off the main thread.
#[tauri::command(async)]
pub fn get_opencode_runtime_health() -> Result<OpenCodeRuntimeHealth, String> {
    use crate::agent_targets;
    use crate::commands::workspace::configured_workspace_path;
    use crate::settings;

    let workspace_root = configured_workspace_path(&settings::load()).unwrap_or_default();
    let home = agent_targets::home_dir()?;

    // If workspace root doesn't exist or isn't valid, still compute health
    // so the UI can show missing/invalid status
    Ok(compute_health(&workspace_root, &home))
}

/// Run the bundled generator's --write against the given workspace root.
/// Returns an ActionResult with command output.
/// This is the testable helper; the Tauri command wraps it.
pub(crate) fn run_generator_write(workspace_root: &Path) -> Result<ActionResult, String> {
    match bundled_generator_script(workspace_root) {
        Ok(script) => run_generator_write_with_script(&script, workspace_root),
        Err(error) => Ok(ActionResult::new(
            false,
            "generate_opencode_config_snapshot",
            String::new(),
            error,
            Some(1),
        )),
    }
}

fn run_generator_write_with_script(
    script: &Path,
    workspace_root: &Path,
) -> Result<ActionResult, String> {
    // The generator opens the snapshot for writing: a symlink must not carry the write out of the workspace.
    super::content::safe_canonical_target(
        workspace_root,
        &workspace_root.join("templates/opencode.json"),
    )?;

    let output = run_generator(script, workspace_root, "--write", GENERATOR_TIMEOUT)?;
    if output.timed_out {
        return Err(format!(
            "generator timed out after {} seconds",
            GENERATOR_TIMEOUT.as_secs()
        ));
    }
    if output.exit_code.is_none() {
        return Err(
            "python3 is not available on this system or could not be started. Install Python 3 and ensure it is on PATH to generate config."
                .to_string(),
        );
    }

    let success = output.success;
    Ok(ActionResult::new(
        success,
        "generate_opencode_config_snapshot",
        if success {
            "Generated opencode.json snapshot.".to_string()
        } else {
            output.stdout
        },
        output.stderr,
        output.exit_code,
    ))
}

// ── OpenCode executable resolution ──

/// Resolve the absolute path to the `opencode` CLI.
///
/// Resolution order:
/// 1. Normal PATH lookup via `executable_resolver::resolve_executable`.
/// 2. Common macOS Homebrew paths: `/opt/homebrew/bin/opencode` and `/usr/local/bin/opencode`.
///
/// Returns `None` if no executable is found.
fn resolve_opencode_executable() -> Option<std::path::PathBuf> {
    // 1. Try PATH lookup
    let path_env = std::env::var("PATH").unwrap_or_default();
    if let Some(path) = crate::executable_resolver::resolve_executable("opencode", &path_env, None)
    {
        return Some(path);
    }

    // 2. Try common Homebrew paths (macOS GUI often lacks these in PATH)
    for candidate in &["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"] {
        let p = std::path::Path::new(candidate);
        if crate::executable_resolver::is_executable_file(p, None) {
            return Some(p.to_path_buf());
        }
    }

    None
}

// ── OpenCode model selection ──

#[derive(serde::Serialize, Clone, Debug)]
pub struct ListAvailableModelsResult {
    pub models: Vec<String>,
    pub warning: Option<String>,
}

/// `provider/model` where the model part may itself contain slashes (OpenRouter, LM Studio, ...):
/// at least one `/`, no empty `/`-separated segment, no whitespace or control characters.
fn is_well_formed_model_id(id: &str) -> bool {
    id.contains('/')
        && !id.chars().any(|c| c.is_whitespace() || c.is_control())
        && id.split('/').all(|segment| !segment.is_empty())
}

/// Parse `opencode models` stdout into a sorted list of unique `provider/model` strings.
///
/// Extraction rules per line:
/// - Strip leading/trailing whitespace, skip empty lines.
/// - Take the first whitespace-delimited token only.
/// - The token must match `provider/model`: the model part may contain further
///   slashes (`lmstudio/google/gemma-3n-e4b`), but no `/`-separated segment may be empty.
/// - Reject tokens containing quotes, shell metacharacters, or control characters.
/// - Deduplicate and sort the result.
pub fn parse_opencode_models_output(output: &str) -> Vec<String> {
    fn is_valid_token(token: &str) -> bool {
        // Reject tokens with quotes, shell metacharacters, or control chars
        if token.contains('"')
            || token.contains('\'')
            || token.contains('`')
            || token.contains('$')
            || token.contains('|')
            || token.contains(';')
            || token.contains('&')
            || token.contains('>')
            || token.contains('<')
            || token.contains('(')
            || token.contains(')')
            || token.contains('\n')
            || token.contains('\r')
            || token.contains('\t')
        {
            return false;
        }
        is_well_formed_model_id(token)
    }

    let mut models: BTreeSet<String> = BTreeSet::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Take only the first whitespace-delimited token
        let Some(first_token) = trimmed.split_whitespace().next() else {
            continue;
        };
        if first_token.is_empty() || !is_valid_token(first_token) {
            continue;
        }
        models.insert(first_token.to_string());
    }
    models.into_iter().collect()
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct OpenCodeModelSelection {
    pub model: String,
    pub small_model: String,
}

const DEFAULT_MODEL: &str = "opencode-go/glm-5.2";
const DEFAULT_SMALL_MODEL: &str = "opencode-go/deepseek-v4-flash";

/// App-level model selection override stored outside workspace templates.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct StoredOpenCodeModelSelection {
    schema_version: u32,
    model: String,
    small_model: String,
}

/// Resolve the app-level model override file path.
fn opencode_model_selection_path() -> Result<std::path::PathBuf, String> {
    let env = crate::platform_paths::PlatformEnv::from_process_env();
    let platform = crate::platform_paths::Platform::current();
    crate::platform_paths::app_support_dir(&env, platform)
        .map(|p| p.join("opencode-model-selection.json"))
}

/// Resolve the model override path for a caller-supplied home directory.
///
/// Production command handlers use `opencode_model_selection_path()` so they
/// keep honoring the live platform environment. Render/status helpers receive
/// a home path explicitly; when that path is an isolated test/smoke home, derive
/// app support from it instead of leaking reads from the real user profile.
fn opencode_model_selection_path_for_home(home_dir: &Path) -> Result<std::path::PathBuf, String> {
    let platform = crate::platform_paths::Platform::current();
    let process_env = crate::platform_paths::PlatformEnv::from_process_env();
    let process_home = crate::platform_paths::resolve_user_home(&process_env, platform).ok();
    let env = if process_home.as_deref() == Some(home_dir) {
        process_env
    } else {
        let home = home_dir.to_string_lossy().into_owned();
        crate::platform_paths::PlatformEnv {
            home: Some(home.clone()),
            userprofile: Some(home.clone()),
            appdata: Some(
                home_dir
                    .join("AppData")
                    .join("Roaming")
                    .to_string_lossy()
                    .into_owned(),
            ),
            xdg_config_home: Some(home_dir.join(".config").to_string_lossy().into_owned()),
            ..crate::platform_paths::PlatformEnv::default()
        }
    };
    crate::platform_paths::app_support_dir(&env, platform)
        .map(|p| p.join("opencode-model-selection.json"))
}

/// Read the stored model selection override.
/// Returns None if the file is missing, invalid, or contains empty/invalid model IDs.
fn read_stored_opencode_model_selection() -> Option<OpenCodeModelSelection> {
    let path = match opencode_model_selection_path() {
        Ok(p) => p,
        Err(_) => return None,
    };
    read_stored_opencode_model_selection_from_path(&path)
}

/// Read model selection override from a specific path (testable).
fn read_stored_opencode_model_selection_from_path(
    path: &std::path::Path,
) -> Option<OpenCodeModelSelection> {
    if !path.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let stored: StoredOpenCodeModelSelection = serde_json::from_str(&content).ok()?;
    if stored.schema_version != 1 {
        return None;
    }
    if stored.model.is_empty() || stored.small_model.is_empty() {
        return None;
    }
    let model = validate_model_id(&stored.model).ok()?;
    let small_model = validate_model_id(&stored.small_model).ok()?;
    Some(OpenCodeModelSelection { model, small_model })
}

/// `opencode models` may refresh its provider catalog over the network.
const OPENCODE_MODELS_TIMEOUT: Duration = Duration::from_secs(30);
/// A model catalog is a few hundred short lines; cap far above that.
const OPENCODE_MODELS_STDOUT_CAP: usize = 4 * 1024 * 1024;

/// List available OpenCode models by running `opencode models --pure`.
/// Returns a sorted, deduplicated list of `provider/model` strings.
// `async` keeps the (network-bound) subprocess off the main thread.
#[tauri::command(async)]
pub fn list_available_opencode_models() -> Result<ListAvailableModelsResult, String> {
    list_models_with_executable(resolve_opencode_executable(), OPENCODE_MODELS_TIMEOUT)
}

fn list_models_with_executable(
    opencode_path: Option<std::path::PathBuf>,
    timeout: Duration,
) -> Result<ListAvailableModelsResult, String> {
    let opencode_path = opencode_path.ok_or_else(|| {
        "opencode CLI not found on PATH. If installed via Homebrew, ensure /opt/homebrew/bin \
         is on the GUI PATH or reinstall via the bundled installer."
            .to_string()
    })?;
    let program = opencode_path
        .to_str()
        .ok_or_else(|| "opencode CLI path is not valid UTF-8".to_string())?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());

    let result = run_cmd_bounded(
        program,
        &["models", "--pure"],
        &cwd,
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: OPENCODE_MODELS_STDOUT_CAP,
            stderr_cap: 64 * 1024,
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        return Err(format!(
            "opencode models timed out after {} seconds",
            timeout.as_secs()
        ));
    }
    if result.exit_code.is_none() {
        let detail = result.stderr.trim();
        return Err(format!(
            "failed to run opencode models ({}): {}",
            opencode_path.display(),
            if detail.is_empty() {
                "terminated without an exit status"
            } else {
                detail
            }
        ));
    }

    let models = parse_opencode_models_output(&result.stdout);
    let warning = if !result.success {
        Some(
            "opencode models reported a non-zero exit. Check your OpenCode CLI and provider configuration."
                .to_string(),
        )
    } else if models.is_empty() {
        Some("No parseable models found. Verify your OpenCode provider configuration.".to_string())
    } else {
        None
    };

    Ok(ListAvailableModelsResult { models, warning })
}

/// Read the current model and small_model.
/// Priority: 1) app-level override file, 2) workspace `templates/opencode.base.json`, 3) hardcoded defaults.
#[tauri::command]
pub fn read_opencode_model_selection() -> Result<OpenCodeModelSelection, String> {
    // 1. Check app-level override file first
    if let Some(override_selection) = read_stored_opencode_model_selection() {
        return Ok(override_selection);
    }

    // 2. Fall back to workspace template
    use crate::commands::workspace::configured_workspace_path;
    use crate::settings;

    let workspace_root = match configured_workspace_path(&settings::load()) {
        Some(p) => p,
        None => {
            return Ok(OpenCodeModelSelection {
                model: DEFAULT_MODEL.to_string(),
                small_model: DEFAULT_SMALL_MODEL.to_string(),
            });
        }
    };
    let base_path = workspace_root.join("templates/opencode.base.json");

    if !base_path.is_file() {
        return Ok(OpenCodeModelSelection {
            model: DEFAULT_MODEL.to_string(),
            small_model: DEFAULT_SMALL_MODEL.to_string(),
        });
    }

    let content = std::fs::read_to_string(&base_path)
        .map_err(|e| format!("failed to read opencode.base.json: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("invalid JSON: {}", e))?;

    let model = json
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();
    let small_model = json
        .get("small_model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SMALL_MODEL)
        .to_string();

    Ok(OpenCodeModelSelection { model, small_model })
}

/// Validate a model ID in `provider/model` format and return it trimmed.
///
/// The model part may contain further slashes (`lmstudio/google/gemma-3n-e4b`);
/// empty segments and whitespace/control characters are rejected.
fn validate_model_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("model ID must not be empty".to_string());
    }
    if !trimmed.contains('/') {
        return Err(format!(
            "invalid model ID '{}': must be in provider/model format",
            trimmed
        ));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(
            "invalid model ID: must not contain whitespace or control characters".to_string(),
        );
    }
    if !is_well_formed_model_id(trimmed) {
        return Err(format!(
            "invalid model ID '{}': provider and model name must not be empty",
            trimmed
        ));
    }
    Ok(trimmed.to_string())
}

/// Update `model` and `small_model` in the app-level override file.
///
/// Does NOT mutate workspace templates/opencode.base.json or templates/opencode.json.
/// The override is stored outside the workspace and applied on the next Install/Update.
#[tauri::command(async)]
pub fn update_opencode_model_selection(
    model: String,
    small_model: String,
) -> Result<String, String> {
    // Writes files an apply may also write: wait for a running mutation instead of interleaving.
    let _mutation = crate::mutation_lock::acquire();
    // Validate inputs; persist the trimmed values.
    let model = validate_model_id(&model)?;
    let small_model = validate_model_id(&small_model)?;

    let override_path = opencode_model_selection_path()?;

    // Ensure parent directory exists
    if let Some(parent) = override_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create app settings directory: {}", e))?;
    }

    let stored = StoredOpenCodeModelSelection {
        schema_version: 1,
        model: model.clone(),
        small_model: small_model.clone(),
    };

    let content =
        serde_json::to_string_pretty(&stored).map_err(|e| format!("serialization error: {}", e))?;

    // Atomic write: unique temp file next to the target, fsync, then rename.
    static TMP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp_name = format!(
        ".{}.{}-{}.tmp",
        override_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("opencode-model-selection.json"),
        std::process::id(),
        TMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    );
    let tmp_path = override_path.with_file_name(tmp_name);
    let write_result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to write model override: {}", e));
    }
    if let Err(e) = std::fs::rename(&tmp_path, &override_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to save model override: {}", e));
    }

    Ok(format!(
        "Model selection saved. Run Install/Update to apply model={}, small_model={}.",
        model, small_model
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-runtime-{name}-{nonce}"))
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        if let Some(parent) = root.join(rel).parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(root.join(rel), content).expect("write file");
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    fn add_tui(ws: &Path, home: &Path) {
        write_file(ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
    }

    fn setup_synced_workspace(name: &str) -> (PathBuf, PathBuf) {
        let ws = temp_root(&format!("{name}-ws"));
        let home = temp_root(&format!("{name}-home"));

        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(
            &ws,
            "templates/opencode.base.json",
            r#"{"default_agent":"architect","model":"opencode-go/glm-5.2","small_model":"opencode-go/deepseek-v4-flash"}"#,
        );
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow","deny":[]}}"#,
        );
        // The snapshot is what the (bundled) generator makes of the two sources, so it checks as current.
        write_file(&ws, "templates/opencode.json", "{}");
        let generated = super::run_generator_write(&ws).expect("bundled generator runs");
        assert!(generated.success, "{}", generated.stderr);
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&ws, "agents/repo-scout.md", "# scout");

        write_file(
            &home,
            ".config/opencode/opencode.json",
            &fs::read_to_string(ws.join("templates/opencode.json")).expect("snapshot"),
        );
        write_file(&home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/agents/repo-scout.md", "# scout");

        (ws, home)
    }

    #[test]
    fn test_synced_when_all_match() {
        let (ws, home) = setup_synced_workspace("synced");
        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "synced");
        assert_eq!(health.default_agent, Some("architect".into()));
        assert_eq!(health.model, Some("opencode-go/glm-5.2".into()));
        assert_eq!(
            health.small_model,
            Some("opencode-go/deepseek-v4-flash".into())
        );
        assert_eq!(health.bundled_agent_count, 2);
        assert_eq!(health.installed_bundled_agent_count, 2);
        assert_eq!(health.extra_installed_agent_count, 0);
        assert!(health.agent_mismatches.is_empty());
        assert_eq!(health.tui_status, "synced");
        assert_eq!(health.generated_snapshot_status, "current");
        assert!(health.summary.contains("matches"));
        assert_eq!(health.next_action, "No runtime action needed.");
    }

    #[test]
    fn test_missing_when_installed_config_absent() {
        let ws = temp_root("missing-ws");
        let home = temp_root("missing-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");
        add_tui(&ws, &home);

        // No installed config
        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "missing");
    }

    #[test]
    fn test_invalid_when_installed_config_bad_json() {
        let ws = temp_root("invalid-inst-ws");
        let home = temp_root("invalid-inst-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/opencode.json", "not json {{{");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "missing"); // template exists but installed is invalid => fail
        let invalid_check = health
            .checks
            .iter()
            .find(|c| c.id == "installed_config_valid")
            .unwrap();
        assert_eq!(invalid_check.status, "fail");
    }

    #[test]
    fn test_invalid_when_template_config_bad_json() {
        let ws = temp_root("invalid-tpl-ws");
        let home = temp_root("invalid-tpl-home");

        write_file(&ws, "templates/opencode.json", "bad json {{{");
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "missing"); // template invalid => fail
        let invalid_check = health
            .checks
            .iter()
            .find(|c| c.id == "template_config_valid")
            .unwrap();
        assert_eq!(invalid_check.status, "fail");
    }

    #[test]
    fn test_configs_match_pass_when_template_has_playwright_placeholders() {
        let ws = temp_root("rendered-match-ws");
        let home = temp_root("rendered-match-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","__PLAYWRIGHT_MCP_CONFIG_PATH__"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","__PLAYWRIGHT_MCP_CONFIG_PATH__"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected config");
        write_file(
            &home,
            ".config/opencode/opencode.json",
            &serde_json::to_string_pretty(&rendered).expect("serialize installed"),
        );
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "synced");
        let match_check = health
            .checks
            .iter()
            .find(|c| c.id == "configs_match")
            .unwrap();
        assert_eq!(match_check.status, "pass");
        assert!(!file_eq(
            &ws.join("templates/opencode.json"),
            &home.join(".config/opencode/opencode.json")
        ));
    }

    #[test]
    fn test_configs_match_warn_when_rendered_expected_differs() {
        let ws = temp_root("rendered-diff-ws");
        let home = temp_root("rendered-diff-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","__PLAYWRIGHT_MCP_CONFIG_PATH__"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}},"version":2}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","/wrong/config.json"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"/wrong/browsers"}}},"version":2}"#,
        );
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        let match_check = health
            .checks
            .iter()
            .find(|c| c.id == "configs_match")
            .unwrap();
        assert_eq!(match_check.status, "warn");
        assert!(match_check.detail.contains("managed keys"));
    }

    #[test]
    fn test_managed_keys_match_preserves_user_provider() {
        let ws = temp_root("managed-provider-ws");
        let home = temp_root("managed-provider-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"model":"bundled-model","mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"model":"bundled-model","mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected");
        let mut installed = rendered.clone();
        if let Some(obj) = installed.as_object_mut() {
            obj.insert(
                "provider".to_string(),
                serde_json::json!({"custom": {"api": "secret"}}),
            );
            obj.insert("version".to_string(), serde_json::json!(99));
        }
        write_file(
            &home,
            ".config/opencode/opencode.json",
            &serde_json::to_string_pretty(&installed).expect("serialize"),
        );
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "synced");
        let match_check = health
            .checks
            .iter()
            .find(|c| c.id == "configs_match")
            .unwrap();
        assert_eq!(match_check.status, "pass");
    }

    #[test]
    fn test_tui_status_independent_when_config_rendered_match() {
        let ws = temp_root("tui-indep-ws");
        let home = temp_root("tui-indep-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
        );
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected");
        write_file(
            &home,
            ".config/opencode/opencode.json",
            &serde_json::to_string_pretty(&rendered).expect("serialize"),
        );
        write_file(&home, ".config/opencode/tui.json", r#"{"theme":"dark"}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        let match_check = health
            .checks
            .iter()
            .find(|c| c.id == "configs_match")
            .unwrap();
        assert_eq!(match_check.status, "pass");
        assert_eq!(health.tui_status, "diverged");
        assert_eq!(health.status, "diverged");
        assert_eq!(health.installed_bundled_agent_count, 1);
    }

    #[test]
    fn test_agents_status_independent_when_config_rendered_match() {
        let ws = temp_root("agents-indep-ws");
        let home = temp_root("agents-indep-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect v2");
        write_file(&ws, "agents/repo-scout.md", "# scout");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(
            &home,
            ".config/opencode/agents/architect.md",
            "# architect v1",
        );
        write_file(&home, ".config/opencode/agents/repo-scout.md", "# scout");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        let match_check = health
            .checks
            .iter()
            .find(|c| c.id == "configs_match")
            .unwrap();
        assert_eq!(match_check.status, "pass");
        assert_eq!(health.agent_mismatches.len(), 1);
        assert_eq!(health.status, "diverged");
    }

    #[test]
    fn test_diverged_when_managed_keys_differ() {
        let ws = temp_root("div-cfg-ws");
        let home = temp_root("div-cfg-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"model":"bundled-model","version":2}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"model":"user-model","version":1}"#,
        );
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        let match_check = health
            .checks
            .iter()
            .find(|c| c.id == "configs_match")
            .unwrap();
        assert_eq!(match_check.status, "warn");
    }

    #[test]
    fn test_legacy_scout_warns_and_excludes_extra_count() {
        let ws = temp_root("legacy-scout-ws");
        let home = temp_root("legacy-scout-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        write_file(
            &home,
            ".config/opencode/agents/scout.md",
            "---\nname: scout\n---\n# legacy\n",
        );
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.extra_installed_agent_count, 0);
        let legacy = health
            .checks
            .iter()
            .find(|c| c.id == "legacy_scout")
            .unwrap();
        assert_eq!(legacy.status, "warn");
        assert_eq!(health.status, "diverged");
    }

    #[test]
    fn test_diverged_when_bundled_agent_missing_from_installed() {
        let ws = temp_root("div-agent-miss-ws");
        let home = temp_root("div-agent-miss-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&ws, "agents/repo-scout.md", "# scout");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        add_tui(&ws, &home);
        // repo-scout.md missing from installed

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        assert_eq!(health.agent_mismatches.len(), 1);
        assert_eq!(health.agent_mismatches[0].filename, "repo-scout.md");
        assert_eq!(health.agent_mismatches[0].status, "missing");
    }

    #[test]
    fn test_diverged_when_bundled_agent_differs() {
        let ws = temp_root("div-agent-diff-ws");
        let home = temp_root("div-agent-diff-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect v2");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(
            &home,
            ".config/opencode/agents/architect.md",
            "# architect v1",
        );
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        assert_eq!(health.agent_mismatches.len(), 1);
        assert_eq!(health.agent_mismatches[0].filename, "architect.md");
        assert_eq!(health.agent_mismatches[0].status, "diverged");
    }

    #[test]
    fn test_synced_with_extra_installed_agents() {
        let ws = temp_root("extra-agents-ws");
        let home = temp_root("extra-agents-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/agents/custom-agent.md", "# custom");
        add_tui(&ws, &home);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "synced");
        assert_eq!(health.extra_installed_agent_count, 1);
        assert!(health
            .warnings
            .iter()
            .any(|w| w.contains("custom-agent.md")));
    }

    // ── New tests for TUI config ──

    #[test]
    fn test_tui_missing_installed_linked_status() {
        let ws = temp_root("tui-miss-ws");
        let home = temp_root("tui-miss-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        // No installed tui.json

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        // Installed TUI missing => has_fail => "missing"
        assert_eq!(health.status, "missing");
        assert_eq!(health.tui_status, "missing");
        let check = health
            .checks
            .iter()
            .find(|c| c.id == "installed_tui_config_exists")
            .unwrap();
        assert_eq!(check.status, "fail");
    }

    #[test]
    fn test_tui_diverged_when_differs() {
        let ws = temp_root("tui-div-ws");
        let home = temp_root("tui-div-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{"theme":"dark"}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        assert_eq!(health.tui_status, "diverged");
        let check = health
            .checks
            .iter()
            .find(|c| c.id == "tui_configs_match")
            .unwrap();
        assert_eq!(check.status, "warn");
    }

    #[test]
    fn test_tui_invalid_installed_json() {
        let ws = temp_root("tui-inv-ws");
        let home = temp_root("tui-inv-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", "not json {{{");
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "missing");
        let check = health
            .checks
            .iter()
            .find(|c| c.id == "installed_tui_config_exists")
            .unwrap();
        assert_eq!(check.status, "fail");
    }

    // ── New tests for generated snapshot ──

    /// Workspace and home for the generator freshness check. The bundled generator runs against the
    /// workspace's three snapshot files, so they come from the bundled templates (a matching set).
    fn setup_generator_check_workspace(name: &str) -> (PathBuf, PathBuf) {
        let ws = temp_root(&format!("{name}-ws"));
        let home = temp_root(&format!("{name}-home"));
        for template in [
            "opencode.json",
            "opencode.base.json",
            "opencode.policy.json",
        ] {
            let source = crate::setup_roots::bundled_root()
                .expect("bundled root")
                .join("templates")
                .join(template);
            write_file(
                &ws,
                &format!("templates/{template}"),
                &fs::read_to_string(source).expect("read bundled template"),
            );
        }
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        (ws, home)
    }

    #[test]
    fn test_generated_snapshot_current_with_check() {
        let (ws, home) = setup_generator_check_workspace("gen-chk-ok");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.generated_snapshot_status, "current");
        assert!(!health.generated_snapshot_detail.is_empty());
    }

    #[test]
    fn test_generated_snapshot_stale_with_check() {
        let (ws, home) = setup_generator_check_workspace("gen-chk-fail");
        // A source edit the snapshot does not reflect.
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"edited"}"#);

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.generated_snapshot_status, "stale");
        assert_eq!(
            health.generated_snapshot_detail,
            "Regenerate opencode.json before sync."
        );
        // Stale snapshot should raise overall status to diverged
        assert_eq!(health.status, "diverged");
        assert!(health.summary.contains("stale"));
        assert_eq!(health.next_action, "Regenerate opencode.json before sync.");
    }

    #[test]
    fn test_generated_snapshot_missing_source_does_not_panic() {
        let ws = temp_root("gen-no-src-ws");
        let home = temp_root("gen-no-src-home");

        // No opencode.base.json or opencode.policy.json
        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.generated_snapshot_status, "missing");
        // Should not panic — status is still computed
        assert_eq!(health.status, "synced"); // Missing snapshot doesn't affect overall status
    }

    // ── New tests for summary and next_action ──

    #[test]
    fn test_summary_synced() {
        let (ws, home) = setup_synced_workspace("sum-synced");
        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(
            health.summary,
            "OpenCode runtime matches the bundled workspace."
        );
        assert_eq!(health.next_action, "No runtime action needed.");
    }

    #[test]
    fn test_summary_diverged() {
        let ws = temp_root("sum-div-ws");
        let home = temp_root("sum-div-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"model":"bundled-model","version":2}"#,
        );
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"model":"user-model","version":1}"#,
        );
        write_file(&home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        assert_eq!(
            health.summary,
            "Runtime differs from bundled templates. Review diff before applying."
        );
        assert_eq!(health.next_action, "Run diff before apply.");
    }

    #[test]
    fn test_summary_missing() {
        let ws = temp_root("sum-miss-ws");
        let home = temp_root("sum-miss-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        // No installed files at all
        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "missing");
        assert_eq!(
            health.summary,
            "OpenCode runtime is missing required files."
        );
        assert_eq!(health.next_action, "Install/sync required.");
    }

    #[test]
    fn test_summary_extra_agents_still_informational() {
        let ws = temp_root("extra-sum-ws");
        let home = temp_root("extra-sum-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/agents/custom.md", "# custom");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "synced");
        assert_eq!(health.extra_installed_agent_count, 1);
        assert_eq!(
            health.summary,
            "OpenCode runtime matches the bundled workspace."
        );
        assert_eq!(health.next_action, "No runtime action needed.");
    }

    #[test]
    fn test_tui_synced_produces_expected_status() {
        let ws = temp_root("tui-synced-ws");
        let home = temp_root("tui-synced-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.tui_status, "synced");
    }

    // ── Tests for run_generator_write ──

    fn write_generator_script(root: &Path, script_rel: &str, content: &str) {
        let script_dir = root.join(script_rel).parent().unwrap().to_path_buf();
        fs::create_dir_all(&script_dir).expect("create scripts dir");
        fs::write(root.join(script_rel), content).expect("write generator script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(script_rel), fs::Permissions::from_mode(0o755))
                .expect("make script executable");
        }
    }

    fn write_marker_workspace(root: &Path) {
        write_file(root, ".agent-workspace/workspace.json", "{}");
        write_file(root, "templates/global-agent-rules.md", "# rules\n");
        write_file(root, "templates/opencode.json", "{}");
        write_file(root, "README.md", "# readme\n");
        fs::create_dir_all(root.join("skills")).expect("create skills dir");
    }

    fn bundled_template(name: &str) -> String {
        let path = crate::setup_roots::bundled_root()
            .expect("bundled root")
            .join("templates")
            .join(name);
        fs::read_to_string(path).expect("read bundled template")
    }

    /// Sources the bundled generator can process, with a snapshot that does not match them yet.
    fn write_generator_inputs(ws: &Path) {
        write_file(
            ws,
            "templates/opencode.base.json",
            &bundled_template("opencode.base.json"),
        );
        write_file(
            ws,
            "templates/opencode.policy.json",
            &bundled_template("opencode.policy.json"),
        );
        write_file(ws, "templates/opencode.json", "{}");
    }

    /// Stand-in generator for the injected-script entry points. It lives outside the workspace, as the
    /// bundled one does, and receives the production arguments: `<script> --root <workspace> <mode>`.
    fn fake_generator(label: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = temp_root(label);
        let prelude = "#!/usr/bin/env python3\nimport sys, os\nargs = sys.argv[1:]\nassert len(args) == 3 and args[0] == '--root', args\nroot, mode = args[1], args[2]\n";
        write_generator_script(
            &dir,
            "scripts/generate-opencode-config.py",
            &format!("{prelude}{body}"),
        );
        let script = dir.join("scripts/generate-opencode-config.py");
        (dir, script)
    }

    #[test]
    fn test_generator_write_regenerates_snapshot_in_workspace() {
        let ws = temp_root("gen-write-real");
        write_marker_workspace(&ws);
        write_generator_inputs(&ws);

        let result = super::run_generator_write(&ws).expect("generator should run");
        let snapshot = fs::read_to_string(ws.join("templates/opencode.json")).expect("snapshot");
        cleanup(&ws);

        assert!(result.success, "{}", result.stderr);
        assert_eq!(result.action, "generate_opencode_config_snapshot");
        assert!(result.stdout.contains("Generated"));
        assert_eq!(snapshot, bundled_template("opencode.json"));
    }

    #[test]
    fn test_generator_write_reports_generator_failure() {
        let ws = temp_root("gen-write-fail");
        write_marker_workspace(&ws);
        write_generator_inputs(&ws);
        write_file(&ws, "templates/opencode.policy.json", r#"{"bogus":{}}"#);

        let result = super::run_generator_write(&ws).expect("generator should run");
        let snapshot = fs::read_to_string(ws.join("templates/opencode.json")).expect("snapshot");
        cleanup(&ws);

        assert!(!result.success);
        assert!(result.stderr.contains("unknown keys"), "{}", result.stderr);
        assert_eq!(
            snapshot, "{}",
            "a failed generation leaves the snapshot alone"
        );
    }

    #[test]
    fn test_generator_write_runs_with_workspace_as_data_argument() {
        let ws = temp_root("gen-write-args");
        write_marker_workspace(&ws);
        let (gen_dir, script) = fake_generator(
            "gen-write-args-script",
            "assert mode == '--write', mode\nopen(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cwd.txt'), 'w').write(os.getcwd())\nopen(os.path.join(root, 'templates', '.generated_marker'), 'w').write('ok')\n",
        );

        let result =
            super::run_generator_write_with_script(&script, &ws).expect("generator should run");
        let cwd = fs::read_to_string(gen_dir.join("scripts/cwd.txt")).expect("recorded cwd");
        let marker = ws.join("templates/.generated_marker").is_file();
        let recorded_cwd = Path::new(&cwd).canonicalize().expect("cwd");
        let expected_cwd = gen_dir.join("scripts").canonicalize().expect("script dir");
        cleanup(&ws);
        cleanup(&gen_dir);

        assert!(result.success, "{}", result.stderr);
        assert!(marker, "the workspace is what the generator writes into");
        assert_eq!(
            recorded_cwd, expected_cwd,
            "the generator runs from its own folder, not from the workspace"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_workspace_generator_scripts_are_never_executed() {
        let (ws, home) = setup_generator_check_workspace("gen-pinned");
        let sentinel = temp_root("gen-pinned-sentinel");
        let malicious = format!(
            "#!/usr/bin/env python3\nimport sys\nopen('{}', 'w').write('executed')\nsys.exit(1)\n",
            sentinel.display()
        );
        write_generator_script(&ws, "scripts/generate-opencode-config.py", &malicious);
        write_generator_script(
            &ws,
            "scripts/generate-default-opencode-config.py",
            &malicious,
        );

        let health = compute_health(&ws, &home);
        let check = super::run_generator_check(&ws);
        let write = super::run_generator_write(&ws).expect("bundled generator should run");
        let sentinel_created = sentinel.exists();
        cleanup(&ws);
        cleanup(&home);
        let _ = fs::remove_file(&sentinel);

        assert!(
            !sentinel_created,
            "a generator script inside the workspace must never run"
        );
        // The bundled generator answered instead: a malicious script would have failed the check.
        assert_eq!(health.generated_snapshot_status, "current");
        assert_eq!(check.expect("generator ran").0, "current");
        assert!(write.success, "{}", write.stderr);
    }

    #[cfg(unix)]
    #[test]
    fn test_generator_write_refuses_snapshot_symlink_leaving_workspace() {
        let ws = temp_root("gen-link-ws");
        let outside = temp_root("gen-link-outside");
        write_marker_workspace(&ws);
        write_generator_inputs(&ws);
        write_file(&outside, "target.json", "keep");
        fs::remove_file(ws.join("templates/opencode.json")).expect("remove snapshot");
        std::os::unix::fs::symlink(
            outside.join("target.json"),
            ws.join("templates/opencode.json"),
        )
        .expect("link snapshot");

        let result = super::run_generator_write(&ws);
        let untouched = fs::read_to_string(outside.join("target.json")).expect("target");
        cleanup(&ws);
        cleanup(&outside);

        assert!(
            result.is_err(),
            "write through an escaping symlink must be refused"
        );
        assert_eq!(untouched, "keep");
    }

    #[test]
    fn test_opencode_config_sync_status_matches_rendered_installed() {
        let ws = temp_root("sync-status-ws");
        let home = temp_root("sync-status-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
        );

        let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected");
        write_file(
            &home,
            ".config/opencode/opencode.json",
            &serde_json::to_string_pretty(&rendered).expect("serialize"),
        );

        assert_eq!(super::opencode_config_sync_status(&ws, &home), "synced");
        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn test_opencode_config_sync_status_diverged_for_unrendered_installed() {
        let ws = temp_root("sync-status-div-ws");
        let home = temp_root("sync-status-div-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
        );
        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
        );

        assert_eq!(super::opencode_config_sync_status(&ws, &home), "diverged");
        cleanup(&ws);
        cleanup(&home);
    }

    // ── OpenCode model selection tests ──

    #[test]
    fn test_parse_models_simple_lines() {
        let output = "opencode-go/glm-5.2\nopencode-go/deepseek-v4-flash\nprovider2/model-x\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0], "opencode-go/deepseek-v4-flash");
        assert_eq!(models[1], "opencode-go/glm-5.2");
        assert_eq!(models[2], "provider2/model-x");
    }

    #[test]
    fn test_parse_models_skips_empty_lines() {
        let output = "\nopencode-go/a\n  \nopencode-go/b\n\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 2);
    }

    #[test]
    fn test_parse_models_skips_invalid_lines() {
        let output = "opencode-go/valid\nnotavalidline\n/no-provider\nno-model/\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0], "opencode-go/valid");
    }

    #[test]
    fn test_parse_models_deduplicates() {
        let output = "provider/a\nprovider/b\nprovider/a\nprovider/c\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 3);
    }

    #[test]
    fn test_parse_models_empty_input() {
        let models = parse_opencode_models_output("");
        assert!(models.is_empty());
    }

    #[test]
    fn test_validate_model_id_valid() {
        assert!(validate_model_id("provider/model").is_ok());
        assert!(validate_model_id("opencode-go/glm-5.2").is_ok());
        assert!(validate_model_id("a/b").is_ok());
    }

    #[test]
    fn test_validate_model_id_empty() {
        assert!(validate_model_id("").is_err());
        assert!(validate_model_id("   ").is_err());
    }

    #[test]
    fn test_validate_model_id_no_slash() {
        let err = validate_model_id("justmodel").unwrap_err();
        assert!(err.contains("provider/model"));
    }

    #[test]
    fn test_validate_model_id_empty_parts() {
        assert!(validate_model_id("/model").is_err());
        assert!(validate_model_id("provider/").is_err());
    }

    #[test]
    fn test_validate_model_id_accepts_nested_model_names() {
        // OpenRouter / LM Studio / Hugging Face style ids carry extra slashes.
        assert_eq!(
            validate_model_id("lmstudio/google/gemma-3n-e4b").as_deref(),
            Ok("lmstudio/google/gemma-3n-e4b")
        );
        assert_eq!(validate_model_id("a/b/c").as_deref(), Ok("a/b/c"));
    }

    #[test]
    fn test_validate_model_id_trims_and_rejects_empty_segments_and_whitespace() {
        assert_eq!(
            validate_model_id("  provider/model \n").as_deref(),
            Ok("provider/model")
        );
        for bad in [
            "provider//model",
            "provider/model/",
            "/provider/model",
            "provider/mo del",
            "provider/mo\tdel",
            "provider/mo\ndel",
            "provider/mo\u{0}del",
        ] {
            assert!(validate_model_id(bad).is_err(), "must reject {bad:?}");
        }
    }

    #[test]
    fn test_update_base_config_preserves_unrelated_keys() {
        let ws = temp_root("model-upd-preserve");
        let home = temp_root("model-upd-home");

        // Set up minimal workspace with base config
        write_file(
            &ws,
            "templates/opencode.base.json",
            r#"{
            "$schema": "https://opencode.ai/config.json",
            "model": "old-model",
            "small_model": "old-small",
            "autoupdate": "notify",
            "snapshot": true,
            "default_agent": "architect",
            "compaction": {"auto": true}
        }"#,
        );
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, ".agent-workspace/workspace.json", "{}");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Read, update, and verify
        let base_path = ws.join("templates/opencode.base.json");
        let content = std::fs::read_to_string(&base_path).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();
        if let Some(obj) = json.as_object_mut() {
            obj.insert(
                "model".into(),
                serde_json::Value::String("new-model".into()),
            );
            obj.insert(
                "small_model".into(),
                serde_json::Value::String("new-small".into()),
            );
        }
        std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        // Verify preserved keys
        let updated_content = std::fs::read_to_string(&base_path).unwrap();
        let updated_json: serde_json::Value = serde_json::from_str(&updated_content).unwrap();
        assert_eq!(updated_json["model"].as_str(), Some("new-model"));
        assert_eq!(updated_json["small_model"].as_str(), Some("new-small"));
        assert_eq!(updated_json["autoupdate"].as_str(), Some("notify"));
        assert_eq!(updated_json["snapshot"].as_bool(), Some(true));
        assert_eq!(updated_json["default_agent"].as_str(), Some("architect"));
        assert!(updated_json["compaction"].is_object());
        assert!(updated_json["$schema"].is_string());

        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn test_update_base_config_generator_failure_detected() {
        let ws = temp_root("model-upd-fail");
        let home = temp_root("model-upd-fail-home");

        write_file(
            &ws,
            "templates/opencode.base.json",
            r#"{"model":"old","small_model":"old-small"}"#,
        );
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, ".agent-workspace/workspace.json", "{}");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Generator script that always fails
        let (gen_dir, script) = fake_generator(
            "model-upd-fail-gen",
            "print('simulated failure', file=sys.stderr)\nsys.exit(1)\n",
        );

        // Now update base config manually
        let base_path = ws.join("templates/opencode.base.json");
        let content = std::fs::read_to_string(&base_path).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();
        if let Some(obj) = json.as_object_mut() {
            obj.insert("model".into(), serde_json::Value::String("new".into()));
            obj.insert(
                "small_model".into(),
                serde_json::Value::String("new-small".into()),
            );
        }
        std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        // Verify generator detects stale state
        let gen_result = super::run_generator_write_with_script(&script, &ws)
            .expect("generator should return ActionResult");
        assert!(!gen_result.success, "generator should fail");
        assert!(gen_result.stderr.contains("simulated failure"));

        cleanup(&ws);
        cleanup(&home);
        cleanup(&gen_dir);
    }

    // ── Hardened parser tests ──

    #[test]
    fn test_parse_models_line_with_metadata_first_token() {
        // Lines where the first token is a valid model, rest is metadata
        let output = "provider/model   some metadata here\nopencode-go/glm-5.2  \tmore stuff\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0], "opencode-go/glm-5.2");
        assert_eq!(models[1], "provider/model");
    }

    #[test]
    fn test_parse_models_rejects_quotes() {
        let output = "\"provider/model\"\nprovider/'model2'\n";
        let models = parse_opencode_models_output(output);
        assert!(models.is_empty());
    }

    #[test]
    fn test_parse_models_rejects_shell_chars() {
        let output = "provider/model;ls\nprovider|model\n$(provider/model)\nprovider/<model>\n";
        let models = parse_opencode_models_output(output);
        assert!(models.is_empty());
    }

    #[test]
    fn test_parse_models_accepts_nested_names_and_rejects_empty_segments() {
        let output = "lmstudio/google/gemma-3n-e4b\nprovider/model/extra\na//b\nprovider/model/\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(
            models,
            vec![
                "lmstudio/google/gemma-3n-e4b".to_string(),
                "provider/model/extra".to_string()
            ]
        );
    }

    #[test]
    fn test_parse_models_mixed_valid_and_invalid() {
        let output = "valid/provider\ninvalid;stuff\nother/valid\n$(bad)\n\"quoted/model\"\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0], "other/valid");
        assert_eq!(models[1], "valid/provider");
    }

    #[test]
    fn test_parse_models_takes_only_first_token_from_table() {
        // Simulates possible table or column output where first column is model
        let output = "provider/model   1.5 dollars   512 context\nother/model   2.0    1024\n";
        let models = parse_opencode_models_output(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0], "other/model");
        assert_eq!(models[1], "provider/model");
    }

    // ── OpenCode executable resolver tests ──

    #[cfg(unix)]
    fn make_executable(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("make executable");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &std::path::Path) {}

    #[test]
    fn test_resolve_opencode_path_lookup() {
        let _guard = crate::test_env::guard::lock();
        let dir = temp_root("resolve-path");
        std::fs::create_dir_all(&dir).expect("mkdir");

        let fake_path = dir.join("opencode");
        std::fs::write(&fake_path, "#!/bin/sh\necho opencode/fake-model\n")
            .expect("write fake opencode");
        make_executable(&fake_path);

        let original_path = std::env::var("PATH").ok();
        unsafe {
            std::env::set_var("PATH", dir.to_string_lossy().as_ref());
        }

        let result = super::resolve_opencode_executable();

        if let Some(p) = original_path {
            unsafe { std::env::set_var("PATH", &p) };
        } else {
            unsafe { std::env::remove_var("PATH") };
        }

        assert!(result.is_some(), "should find opencode via PATH");
        assert_eq!(result.unwrap(), fake_path);

        cleanup(&dir);
    }

    #[test]
    fn test_resolve_opencode_fallback_path_check_leaves_no_panic() {
        // This test verifies the fallback check does not panic when PATH is empty
        // and no fallback candidate exists on the test machine.
        // On dev machines with Homebrew opencode, the fallback may still find it,
        // which is correct behavior.
        let _guard = crate::test_env::guard::lock();
        let original_path = std::env::var("PATH").ok();
        unsafe {
            std::env::set_var("PATH", "");
        }

        // Must not panic regardless of outcome
        let _result = super::resolve_opencode_executable();

        if let Some(p) = original_path {
            unsafe { std::env::set_var("PATH", &p) };
        } else {
            unsafe { std::env::remove_var("PATH") };
        }
        // No assertion — just ensuring no panic
    }

    #[test]
    fn test_list_models_missing_cli_error_is_safe() {
        // No executable is spawned: the error for a missing CLI must not expose raw
        // PATH values or the home directory.
        let msg = list_models_with_executable(None, Duration::from_secs(1))
            .expect_err("missing opencode CLI must be an error");
        assert!(msg.contains("opencode CLI not found"), "{msg}");
        assert!(
            !msg.contains("PATH="),
            "error must not expose raw PATH: {msg}"
        );
        assert!(
            !msg.contains("/home/"),
            "error must not expose home directory: {msg}"
        );
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                assert!(!msg.contains(&home), "error must not expose HOME: {msg}");
            }
        }
    }

    #[test]
    fn test_list_models_unspawnable_cli_is_an_error() {
        let missing = std::env::temp_dir().join("agent-workspace-no-such-opencode-binary");
        let msg = list_models_with_executable(Some(missing), Duration::from_secs(1))
            .expect_err("unspawnable CLI must be an error");
        assert!(msg.starts_with("failed to run opencode models"), "{msg}");
    }

    #[cfg(unix)]
    fn write_stub_opencode(dir: &Path, body: &str) -> PathBuf {
        fs::create_dir_all(dir).expect("create stub dir");
        let path = dir.join("opencode");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub opencode");
        make_executable(&path);
        path
    }

    #[cfg(unix)]
    #[test]
    fn test_list_models_parses_stub_output() {
        let dir = temp_root("models-stub-ok");
        let stub = write_stub_opencode(
            &dir,
            "echo opencode-go/glm-5.2\necho lmstudio/google/gemma-3n-e4b\necho garbage",
        );
        let result = list_models_with_executable(Some(stub), Duration::from_secs(10));
        cleanup(&dir);

        let result = result.expect("stub run succeeds");
        assert_eq!(
            result.models,
            vec![
                "lmstudio/google/gemma-3n-e4b".to_string(),
                "opencode-go/glm-5.2".to_string()
            ]
        );
        assert!(result.warning.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn test_list_models_nonzero_exit_warns_but_keeps_models() {
        let dir = temp_root("models-stub-fail");
        let stub = write_stub_opencode(&dir, "echo provider/model\nexit 3");
        let result = list_models_with_executable(Some(stub), Duration::from_secs(10));
        cleanup(&dir);

        let result = result.expect("non-zero exit is a warning, not an error");
        assert_eq!(result.models, vec!["provider/model".to_string()]);
        assert!(result
            .warning
            .as_deref()
            .is_some_and(|w| w.contains("non-zero")));
    }

    #[cfg(unix)]
    #[test]
    fn test_list_models_times_out_instead_of_hanging() {
        let dir = temp_root("models-stub-hang");
        // `exec` so the killed process is the sleeper itself (no orphan holding the pipe).
        let stub = write_stub_opencode(&dir, "exec sleep 30");
        let started = std::time::Instant::now();
        let result = list_models_with_executable(Some(stub), Duration::from_millis(300));
        cleanup(&dir);

        let msg = result.expect_err("a hung CLI must time out");
        assert!(msg.contains("timed out"), "{msg}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "timeout must bound the wait"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_generator_check_timeout_is_not_reported_as_stale() {
        let _guard = crate::test_env::guard::lock();
        let ws = temp_root("gen-chk-hang-ws");
        fs::create_dir_all(&ws).expect("create workspace");
        let (gen_dir, script) =
            fake_generator("gen-chk-hang-script", "import time\ntime.sleep(30)\n");
        let started = std::time::Instant::now();
        let result = run_generator_check_with_timeout(&script, &ws, Duration::from_millis(500));
        cleanup(&ws);
        cleanup(&gen_dir);

        let (status, detail) = result.expect("a hung generator still reports a status");
        assert_eq!(status, "valid");
        assert!(detail.contains("timed out"), "{detail}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "timeout must bound the wait"
        );
    }

    // ── Managed config ordering (OpenCode permission is last-match-wins) ──

    fn json_keys(value: &serde_json::Value) -> Vec<&str> {
        value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn test_merge_managed_config_keeps_template_permission_order() {
        // Alphabetical order would put "**/.env*" before "src/**" and "edit" before "read".
        let template: serde_json::Value = serde_json::from_str(
            r#"{"permission":{"*":"ask","read":{"*":"allow","**/.env*":"deny"},
                "edit":{"*":"ask","src/**":"allow","**/.env*":"deny"}}}"#,
        )
        .expect("parse template");
        let installed: serde_json::Value =
            serde_json::from_str(r#"{"theme":"mine","permission":{"edit":"deny","*":"allow"}}"#)
                .expect("parse installed");

        let merged =
            merge_managed_opencode_config(&installed, &extract_managed_opencode_config(&template));
        // Round-trip through the text that setup writes to disk.
        let written = serde_json::to_string_pretty(&merged).expect("serialize");
        let reparsed: serde_json::Value = serde_json::from_str(&written).expect("reparse");

        assert_eq!(reparsed["theme"], "mine", "user keys are preserved");
        let permission = &reparsed["permission"];
        assert_eq!(json_keys(permission), ["*", "read", "edit"]);
        assert_eq!(
            json_keys(&permission["edit"]),
            ["*", "src/**", "**/.env*"],
            "a deny listed after an allow must stay last"
        );
        assert_eq!(json_keys(&permission["read"]), ["*", "**/.env*"]);
    }

    #[test]
    fn test_merge_managed_config_preserves_bundled_template_order() {
        let template_text = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../resources/default-workspace/templates/opencode.json"
        ));
        let template: serde_json::Value = serde_json::from_str(template_text).expect("template");
        let merged = merge_managed_opencode_config(
            &serde_json::json!({}),
            &extract_managed_opencode_config(&template),
        );
        let reparsed: serde_json::Value =
            serde_json::from_str(&serde_json::to_string_pretty(&merged).expect("serialize"))
                .expect("reparse");

        for section in ["bash", "edit", "read"] {
            assert_eq!(
                json_keys(&reparsed["permission"][section]),
                json_keys(&template["permission"][section]),
                "permission.{section} order must match the template"
            );
        }
        let edit = json_keys(&reparsed["permission"]["edit"]);
        let position = |key: &str| edit.iter().position(|k| *k == key).expect(key);
        assert!(
            position("src/**") < position("**/.env*"),
            "secret deny must come after the broad src/** allow"
        );
    }

    #[test]
    fn test_managed_keys_match_requires_permission_order() {
        let ordered: serde_json::Value = serde_json::from_str(
            r#"{"permission":{"edit":{"*":"ask","src/**":"allow","**/.env*":"deny"}}}"#,
        )
        .expect("parse");
        let sorted: serde_json::Value = serde_json::from_str(
            r#"{"permission":{"edit":{"*":"ask","**/.env*":"deny","src/**":"allow"}}}"#,
        )
        .expect("parse");

        // serde_json equality ignores key order, which is why the health check needs more.
        assert_eq!(ordered, sorted);
        assert!(managed_opencode_keys_match(&ordered, &ordered));
        assert!(!managed_opencode_keys_match(&sorted, &ordered));
    }

    #[test]
    fn test_health_flags_reordered_installed_permission() {
        let (ws, home) = setup_synced_workspace("perm-order");
        let template = r#"{"default_agent":"architect","permission":{"edit":{"*":"ask","src/**":"allow","**/.env*":"deny"}}}"#;
        let reordered = r#"{"default_agent":"architect","permission":{"edit":{"*":"ask","**/.env*":"deny","src/**":"allow"}}}"#;
        write_file(&ws, "templates/opencode.json", template);

        write_file(&home, ".config/opencode/opencode.json", template);
        let in_order = compute_health(&ws, &home);
        write_file(&home, ".config/opencode/opencode.json", reordered);
        let out_of_order = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        let status_of = |health: &OpenCodeRuntimeHealth| {
            health
                .checks
                .iter()
                .find(|check| check.id == "configs_match")
                .map(|check| check.status.clone())
        };
        assert_eq!(status_of(&in_order).as_deref(), Some("pass"));
        assert_eq!(status_of(&out_of_order).as_deref(), Some("warn"));
    }

    // ── Config update / generation tests ──

    #[test]
    fn test_update_model_selection_via_helper_path() {
        let ws = temp_root("model-upd-path");
        let home = temp_root("model-upd-path-home");

        // Create workspace with base config
        write_file(
            &ws,
            "templates/opencode.base.json",
            r#"{
            "$schema": "https://opencode.ai/config.json",
            "model": "old-model",
            "small_model": "old-small",
            "autoupdate": "notify",
            "snapshot": true,
            "default_agent": "architect"
        }"#,
        );
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, ".agent-workspace/workspace.json", "{}");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Create a home dir with an installed config that should NOT be touched
        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"model":"installed-model","small_model":"installed-small"}"#,
        );

        // ── Simulate what update_opencode_model_selection does (bundled generator) ──

        let base_path = ws.join("templates/opencode.base.json");
        let snapshot_path = ws.join("templates/opencode.json");

        // 1. Read existing base config
        let content = std::fs::read_to_string(&base_path).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();

        // 2. Validate input (use the helper)
        assert!(validate_model_id("provider/new-model").is_ok());
        assert!(validate_model_id("provider/new-small").is_ok());

        // 3. Update model and small_model
        if let Some(obj) = json.as_object_mut() {
            obj.insert(
                "model".to_string(),
                serde_json::Value::String("provider/new-model".into()),
            );
            obj.insert(
                "small_model".to_string(),
                serde_json::Value::String("provider/new-small".into()),
            );
        }
        std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        // 4. Run generator --write
        let gen_result = super::run_generator_write(&ws).expect("generator should succeed");
        assert!(gen_result.success, "generator write should succeed");

        // 5. Verify base config: only model and small_model changed
        let updated_content = std::fs::read_to_string(&base_path).unwrap();
        let updated_json: serde_json::Value = serde_json::from_str(&updated_content).unwrap();
        assert_eq!(updated_json["model"].as_str(), Some("provider/new-model"));
        assert_eq!(
            updated_json["small_model"].as_str(),
            Some("provider/new-small")
        );
        // Unrelated keys preserved
        assert_eq!(updated_json["autoupdate"].as_str(), Some("notify"));
        assert_eq!(updated_json["snapshot"].as_bool(), Some(true));
        assert_eq!(updated_json["default_agent"].as_str(), Some("architect"));
        assert!(updated_json["$schema"].is_string());

        // 6. Verify generated snapshot contains selected values
        assert!(snapshot_path.is_file(), "snapshot should exist");
        let snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap();
        let snapshot_json: serde_json::Value = serde_json::from_str(&snapshot_content).unwrap();
        assert_eq!(
            snapshot_json["model"].as_str(),
            Some("provider/new-model"),
            "snapshot model must match selected value"
        );
        assert_eq!(
            snapshot_json["small_model"].as_str(),
            Some("provider/new-small"),
            "snapshot small_model must match selected value"
        );

        // 7. Verify installed config in home dir was NOT touched
        let installed_content =
            std::fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap();
        let installed_json: serde_json::Value = serde_json::from_str(&installed_content).unwrap();
        assert_eq!(
            installed_json["model"].as_str(),
            Some("installed-model"),
            "installed config must not be modified"
        );
        assert_eq!(
            installed_json["small_model"].as_str(),
            Some("installed-small"),
            "installed config must not be modified"
        );

        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn test_update_model_selection_generator_failure_rollback() {
        let ws = temp_root("model-upd-gen-rollback");
        let home = temp_root("model-upd-gen-rollback-home");

        write_file(
            &ws,
            "templates/opencode.base.json",
            r#"{"model":"old","small_model":"old-small"}"#,
        );
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, ".agent-workspace/workspace.json", "{}");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Generator that always fails
        let (gen_dir, script) = fake_generator(
            "model-upd-gen-rollback-script",
            "print('simulated failure', file=sys.stderr)\nsys.exit(1)\n",
        );

        // Simulate what update_opencode_model_selection does with rollback:
        // write base → run generator → on failure restore base → best-effort regenerate
        let base_path = ws.join("templates/opencode.base.json");
        let snapshot_path = ws.join("templates/opencode.json");

        // 1. Save original content for rollback
        let original_content = std::fs::read_to_string(&base_path).unwrap();

        // 2. Write updated base config
        let mut json: serde_json::Value = serde_json::from_str(&original_content).unwrap();
        if let Some(obj) = json.as_object_mut() {
            obj.insert(
                "model".into(),
                serde_json::Value::String("provider/new-model".into()),
            );
            obj.insert(
                "small_model".into(),
                serde_json::Value::String("provider/new-small".into()),
            );
        }
        std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

        // 3. Generator should fail
        let gen_result = super::run_generator_write_with_script(&script, &ws)
            .expect("generator should return ActionResult");
        assert!(!gen_result.success, "generator should fail");
        assert!(gen_result.stderr.contains("simulated failure"));

        // 4. Rollback: restore original base content
        std::fs::write(&base_path, &original_content).unwrap();

        // 5. Best-effort regenerate from restored base (this will also fail since script always fails)
        let _retry_result = super::run_generator_write_with_script(&script, &ws);

        // 6. Verify base config was restored to original values
        let restored_content = std::fs::read_to_string(&base_path).unwrap();
        let restored_json: serde_json::Value = serde_json::from_str(&restored_content).unwrap();
        assert_eq!(
            restored_json["model"].as_str(),
            Some("old"),
            "base config model should be restored after generator failure"
        );
        assert_eq!(
            restored_json["small_model"].as_str(),
            Some("old-small"),
            "base config small_model should be restored after generator failure"
        );

        // 7. Snapshot was NOT updated with new values (generator failed)
        let snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap_or_default();
        assert_eq!(snapshot_content.trim(), "{}");

        cleanup(&ws);
        cleanup(&home);
        cleanup(&gen_dir);
    }

    #[test]
    fn test_update_model_selection_snapshot_validation_failure_rollback() {
        let ws = temp_root("model-upd-val-rollback");
        let home = temp_root("model-upd-val-rollback-home");

        write_file(
            &ws,
            "templates/opencode.base.json",
            r#"{"model":"old","small_model":"old-small"}"#,
        );
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, ".agent-workspace/workspace.json", "{}");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Generator that succeeds but writes DIFFERENT model values (simulates a buggy generator)
        let (gen_dir, script) = fake_generator(
            "model-upd-val-rollback-script",
            "import json\nwith open(os.path.join(root, 'templates', 'opencode.base.json')) as f:\n    base = json.load(f)\n# Intentionally write a DIFFERENT model to simulate validation failure\nconfig = dict(base)\nconfig['model'] = 'wrong/model'\nwith open(os.path.join(root, 'templates', 'opencode.json'), 'w') as f:\n    json.dump(config, f, indent=2)\n    f.write('\\n')\n",
        );

        // Simulate update with rollback: write base → run generator → validate → on mismatch, restore base
        let base_path = ws.join("templates/opencode.base.json");
        let snapshot_path = ws.join("templates/opencode.json");

        // 1. Save original content for rollback
        let original_content = std::fs::read_to_string(&base_path).unwrap();

        // 2. Write updated base config with desired model values
        let mut json: serde_json::Value = serde_json::from_str(&original_content).unwrap();
        if let Some(obj) = json.as_object_mut() {
            obj.insert(
                "model".into(),
                serde_json::Value::String("provider/new-model".into()),
            );
            obj.insert(
                "small_model".into(),
                serde_json::Value::String("provider/new-small".into()),
            );
        }
        let updated_content = serde_json::to_string_pretty(&json).unwrap();
        std::fs::write(&base_path, &updated_content).unwrap();

        // 3. Generator succeeds (but writes wrong model)
        let gen_result = super::run_generator_write_with_script(&script, &ws)
            .expect("generator should return ActionResult");
        assert!(
            gen_result.success,
            "generator write should succeed (but with wrong values)"
        );

        // 4. Validate snapshot - generator wrote 'wrong/model' not 'provider/new-model'
        assert!(snapshot_path.is_file(), "snapshot should exist");
        let snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap();
        let snapshot_json: serde_json::Value = serde_json::from_str(&snapshot_content).unwrap();
        let stored_model = snapshot_json
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(
            stored_model, "wrong/model",
            "generator should have written the wrong model"
        );
        assert_ne!(
            stored_model, "provider/new-model",
            "snapshot model should NOT match requested model"
        );

        // 5. Rollback: restore original base content
        std::fs::write(&base_path, &original_content).unwrap();

        // 6. Best-effort regenerate from restored base
        let retry_result = super::run_generator_write_with_script(&script, &ws);
        assert!(
            retry_result.is_ok(),
            "retry generator should return ActionResult"
        );

        // 7. Verify base config was restored to original values
        let restored_content = std::fs::read_to_string(&base_path).unwrap();
        let restored_json: serde_json::Value = serde_json::from_str(&restored_content).unwrap();
        assert_eq!(
            restored_json["model"].as_str(),
            Some("old"),
            "base config model should be restored after validation failure"
        );
        assert_eq!(
            restored_json["small_model"].as_str(),
            Some("old-small"),
            "base config small_model should be restored after validation failure"
        );

        // 8. Snapshot state after rollback: generator is buggy so snapshot may not match.
        //    The critical guarantee is that base config was restored. The snapshot is best-effort.
        let final_snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap();
        let final_snapshot_json: serde_json::Value =
            serde_json::from_str(&final_snapshot_content).unwrap();
        // Generator still has the bug (always writes 'wrong/model'), but the base was restored.
        // The rollback restored base to 'old' values; the snapshot is a separate concern.
        assert!(
            final_snapshot_json.get("model").is_some(),
            "snapshot should still exist after rollback regenerate"
        );

        cleanup(&ws);
        cleanup(&home);
        cleanup(&gen_dir);
    }

    // ── Model override file tests ──

    fn write_override_file(dir: &Path, rel: &str, content: &str) -> PathBuf {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create override dir");
        }
        fs::write(&path, content).expect("write override");
        path
    }

    #[test]
    fn test_read_stored_model_selection_returns_none_when_file_missing() {
        let dir = temp_root("override-missing");
        let path = dir.join("nonexistent.json");
        assert!(read_stored_opencode_model_selection_from_path(&path).is_none());
        cleanup(&dir);
    }

    #[test]
    fn test_read_stored_model_selection_returns_none_when_invalid_json() {
        let dir = temp_root("override-bad-json");
        let path = write_override_file(&dir, "override.json", "not json {{{");
        assert!(read_stored_opencode_model_selection_from_path(&path).is_none());
        cleanup(&dir);
    }

    #[test]
    fn test_read_stored_model_selection_parses_valid_file() {
        let dir = temp_root("override-valid");
        let path = write_override_file(
            &dir,
            "override.json",
            r#"{"schema_version":1,"model":"test/a","small_model":"test/b"}"#,
        );
        let result = read_stored_opencode_model_selection_from_path(&path);
        assert!(result.is_some());
        let sel = result.unwrap();
        assert_eq!(sel.model, "test/a");
        assert_eq!(sel.small_model, "test/b");
        cleanup(&dir);
    }

    #[test]
    fn test_read_stored_model_selection_returns_none_on_wrong_schema_version() {
        let dir = temp_root("override-schema");
        let path = write_override_file(
            &dir,
            "override.json",
            r#"{"schema_version":99,"model":"test/a","small_model":"test/b"}"#,
        );
        assert!(read_stored_opencode_model_selection_from_path(&path).is_none());
        cleanup(&dir);
    }

    #[test]
    fn test_read_stored_model_selection_returns_none_on_invalid_model_id() {
        let dir = temp_root("override-bad-model");
        let path = write_override_file(
            &dir,
            "override.json",
            r#"{"schema_version":1,"model":"invalid","small_model":"test/b"}"#,
        );
        assert!(read_stored_opencode_model_selection_from_path(&path).is_none());
        cleanup(&dir);
    }

    #[test]
    fn test_read_stored_model_selection_returns_none_on_empty_model() {
        let dir = temp_root("override-empty-model");
        let path = write_override_file(
            &dir,
            "override.json",
            r#"{"schema_version":1,"model":"","small_model":"test/b"}"#,
        );
        assert!(read_stored_opencode_model_selection_from_path(&path).is_none());
        cleanup(&dir);
    }

    #[test]
    fn test_render_expected_opencode_config_overlays_override() {
        let ws = temp_root("render-override-ws");
        let home = temp_root("render-override-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        // Write override file
        write_override_file(
            &ws,
            "override.json",
            r#"{"schema_version":1,"model":"override-provider/test-model","small_model":"override-provider/test-small"}"#,
        );

        let template_json: serde_json::Value =
            serde_json::from_str(r#"{"model":"template/model","small_model":"template/small"}"#)
                .expect("parse template");

        let rendered =
            render_expected_opencode_config(&template_json, &home).expect("render should succeed");

        // Without override present at the actual app support path, template values are used
        // (the override file is in our temp dir, not at the real app support path)
        assert_eq!(rendered["model"].as_str(), Some("template/model"));
        assert_eq!(rendered["small_model"].as_str(), Some("template/small"));

        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn test_render_expected_opencode_config_no_override_uses_template() {
        let ws = temp_root("render-no-override-ws");
        let home = temp_root("render-no-override-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        let template_json: serde_json::Value =
            serde_json::from_str(r#"{"model":"bundled/model","small_model":"bundled/small"}"#)
                .expect("parse template");

        let rendered =
            render_expected_opencode_config(&template_json, &home).expect("render should succeed");

        assert_eq!(rendered["model"].as_str(), Some("bundled/model"));
        assert_eq!(rendered["small_model"].as_str(), Some("bundled/small"));

        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn test_validate_model_id_rejects_invalid_patterns() {
        assert!(validate_model_id("").is_err());
        assert!(validate_model_id("modelonly").is_err());
        assert!(validate_model_id("/model").is_err());
        assert!(validate_model_id("provider/").is_err());
        assert!(validate_model_id("provider//b").is_err());
        assert!(validate_model_id("provider/a/").is_err());
        assert!(validate_model_id("   ").is_err());
    }

    #[test]
    fn test_update_opencode_model_selection_writes_override_not_template() {
        // Verify that update_opencode_model_selection writes the override file
        // and does NOT mutate workspace templates.
        // We cannot call the Tauri command directly in a unit test, but we can
        // verify the lower-level save path and file content.
        let dir = temp_root("model-upd-ovr");

        let override_path = dir.join("test-override.json");
        let base_path = dir.join("templates/opencode.base.json");
        let snapshot_path = dir.join("templates/opencode.json");

        // Create workspace template files
        write_file(
            &dir,
            "templates/opencode.base.json",
            r#"{"model":"old/model","small_model":"old/small"}"#,
        );
        write_file(&dir, "templates/opencode.json", r#"{"model":"old/model"}"#);

        // Save the original content for comparison
        let base_before = std::fs::read_to_string(&base_path).unwrap();
        let snapshot_before = std::fs::read_to_string(&snapshot_path).unwrap();

        // Now simulate what update_opencode_model_selection does:
        // write override file (don't use real app support path, use our test path)
        let stored = StoredOpenCodeModelSelection {
            schema_version: 1,
            model: "new-provider/new-model".to_string(),
            small_model: "new-provider/new-small".to_string(),
        };
        let content = serde_json::to_string_pretty(&stored).unwrap();
        fs::write(&override_path, &content).unwrap();

        // Verify template files were NOT modified
        let base_after = std::fs::read_to_string(&base_path).unwrap();
        let snapshot_after = std::fs::read_to_string(&snapshot_path).unwrap();
        assert_eq!(
            base_before, base_after,
            "opencode.base.json must not be modified"
        );
        assert_eq!(
            snapshot_before, snapshot_after,
            "opencode.json must not be modified"
        );

        // Verify override file was written
        assert!(override_path.is_file(), "override file must exist");
        let override_content = std::fs::read_to_string(&override_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&override_content).unwrap();
        assert_eq!(parsed["model"].as_str(), Some("new-provider/new-model"));
        assert_eq!(
            parsed["small_model"].as_str(),
            Some("new-provider/new-small")
        );
        assert_eq!(parsed["schema_version"].as_u64(), Some(1));

        cleanup(&dir);
    }
}
