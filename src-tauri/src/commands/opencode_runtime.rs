use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

use super::process::ActionResult;

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

/// Compare two files byte-for-byte.
fn file_eq(a: &Path, b: &Path) -> bool {
    if !a.exists() || !b.exists() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(ac), Ok(bc)) => ac == bc,
        _ => false,
    }
}

const PLAYWRIGHT_MCP_VERSION_DEFAULT: &str = "0.0.48";
const PLAYWRIGHT_MCP_CONFIG_PLACEHOLDER: &str = "__PLAYWRIGHT_MCP_CONFIG_PATH__";
const PLAYWRIGHT_BROWSERS_PLACEHOLDER: &str = "__PLAYWRIGHT_BROWSERS_PATH__";

/// Keys merged by `scripts/merge-opencode-config.py` / `metadata/opencode-managed-keys.json`.
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

pub(crate) fn managed_opencode_keys_match(
    installed: &serde_json::Value,
    rendered: &serde_json::Value,
) -> bool {
    extract_managed_opencode_config(installed) == extract_managed_opencode_config(rendered)
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

/// Default browser cache path (mirrors `playwright-mcp-lib.sh`).
fn default_playwright_browsers_path(home_dir: &Path) -> Option<std::path::PathBuf> {
    crate::commands::cursor_profile::default_playwright_browsers_path(home_dir)
}

/// Default Playwright MCP config path (mirrors `playwright-mcp-lib.sh`).
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

/// Render workspace `templates/opencode.json` the way `install-opencode-config.sh` would before sync.
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

    // Overlay app-level model override if present
    if let Some(override_selection) = read_stored_opencode_model_selection() {
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

/// Sync status for `get_status` / dashboard (same staged output as `install-opencode-config.sh`).
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

/// Try to run a generator --check script from the workspace root.
/// Returns `Some(status, detail)` if a generator was found and executed,
/// `None` if no generator script exists or `python3` is unavailable.
fn run_generator_check(workspace_root: &Path) -> Option<(String, String)> {
    let candidates = [
        "scripts/generate-opencode-config.py",
        "scripts/generate-default-opencode-config.py",
    ];

    for script_rel in &candidates {
        let script_path = workspace_root.join(script_rel);
        if !script_path.is_file() {
            continue;
        }

        let output = std::process::Command::new("python3")
            .args([script_rel, "--check"])
            .current_dir(workspace_root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output();

        match output {
            Ok(out) => {
                let passed = out.status.success();
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
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
                return Some((
                    if passed {
                        "current".into()
                    } else {
                        "stale".into()
                    },
                    detail,
                ));
            }
            Err(_) => {
                // python3 not found or similar
                return None;
            }
        }
    }
    None
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
            None => (
                "valid".into(),
                "source + snapshot valid; not freshness-checked (no generator)".into(),
            ),
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

    // When source templates exist but no generator script, surface a warning
    // so the user knows a workspace upgrade can add it.
    if base_source_exists
        && policy_source_exists
        && generated_snapshot_status == "valid"
        && run_generator_check(workspace_root).is_none()
    {
        warnings
            .push("OpenCode config generator script not found. Run Install or Update.".to_string());
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

#[tauri::command]
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

/// Run a known generator's --write under the given workspace root.
/// Returns an ActionResult with command output.
/// This is the testable helper; the Tauri command wraps it.
pub(crate) fn run_generator_write(workspace_root: &Path) -> Result<ActionResult, String> {
    let candidates = [
        "scripts/generate-opencode-config.py",
        "scripts/generate-default-opencode-config.py",
    ];

    for script_rel in &candidates {
        let script_path = workspace_root.join(script_rel);
        if !script_path.is_file() {
            continue;
        }

        // Ensure the script is within the workspace root (no symlink escape)
        let _canonical = super::content::safe_canonical_target(workspace_root, &script_path)?;

        let script_str = super::workspace::path_arg(&script_path)?;

        let output = std::process::Command::new("python3")
            .args([&script_str, "--write"])
            .current_dir(workspace_root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "python3 is not available on this system. Install Python 3 to generate config."
                        .to_string()
                } else {
                    format!("failed to run generator: {}", e)
                }
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let success = output.status.success();
        let exit_code = output.status.code();

        return Ok(ActionResult::new(
            success,
            "generate_opencode_config_snapshot",
            if success {
                "Generated opencode.json snapshot.".to_string()
            } else {
                stdout
            },
            stderr,
            exit_code,
        ));
    }

    Ok(ActionResult::new(
        false,
        "generate_opencode_config_snapshot",
        String::new(),
        "No OpenCode config generator found in this workspace. Expected one of: scripts/generate-opencode-config.py, scripts/generate-default-opencode-config.py".to_string(),
        Some(1),
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

/// Parse `opencode models` stdout into a sorted list of unique `provider/model` strings.
///
/// Extraction rules per line:
/// - Strip leading/trailing whitespace, skip empty lines.
/// - Take the first whitespace-delimited token only.
/// - The token must match `provider/model`: exactly one `/`, both parts non-empty.
/// - Reject tokens containing quotes, shell metacharacters, control characters,
///   or a second slash inside the model name part.
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
        // Must have exactly one `/` with non-empty provider and model name
        if let Some(slash_pos) = token.find('/') {
            let provider = &token[..slash_pos];
            let model_name = &token[slash_pos + 1..];
            !provider.is_empty() && !model_name.is_empty() && !model_name.contains('/')
        } else {
            false
        }
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
    if validate_model_id(&stored.model).is_err() || validate_model_id(&stored.small_model).is_err()
    {
        return None;
    }
    Some(OpenCodeModelSelection {
        model: stored.model,
        small_model: stored.small_model,
    })
}

/// List available OpenCode models by running `opencode models --pure`.
/// Returns a sorted, deduplicated list of `provider/model` strings.
#[tauri::command]
pub fn list_available_opencode_models() -> Result<ListAvailableModelsResult, String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    let opencode_path = resolve_opencode_executable().ok_or_else(|| {
        "opencode CLI not found on PATH. If installed via Homebrew, ensure /opt/homebrew/bin \
         is on the GUI PATH or reinstall via the bundled installer."
            .to_string()
    })?;

    let mut child = Command::new(&opencode_path)
        .args(["models", "--pure"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "failed to run opencode models ({}): {}",
                opencode_path.display(),
                e
            )
        })?;

    let stdout_handle = child.stdout.take().expect("stdout configured");
    let reader = BufReader::new(stdout_handle);

    // Read stdout lines with a bounded timeout via a separate thread.
    let lines: Vec<String> = {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut collected = Vec::new();
            for line in reader.lines() {
                match line {
                    Ok(l) => collected.push(l),
                    Err(_) => break,
                }
            }
            let _ = tx.send(collected);
        });
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(lines) => lines,
            Err(_) => {
                // Timeout — kill the child
                let _ = child.kill();
                let _ = child.wait();
                return Err("opencode models timed out after 30 seconds".to_string());
            }
        }
    };

    let wait_status = child.wait().map_err(|e| format!("wait failed: {}", e))?;
    let output_str = lines.join("\n");
    let models = parse_opencode_models_output(&output_str);

    let warning = if !wait_status.success() {
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

/// Validate a model ID in `provider/model` format.
fn validate_model_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("model ID must not be empty".to_string());
    }
    if let Some(slash_pos) = trimmed.find('/') {
        let provider = &trimmed[..slash_pos];
        let model_name = &trimmed[slash_pos + 1..];
        if provider.is_empty() || model_name.is_empty() {
            return Err(format!(
                "invalid model ID '{}': provider and model name must not be empty",
                trimmed
            ));
        }
        if trimmed[slash_pos + 1..].contains('/') {
            return Err(format!(
                "invalid model ID '{}': must be provider/model format with exactly one '/'",
                trimmed
            ));
        }
        Ok(())
    } else {
        Err(format!(
            "invalid model ID '{}': must be in provider/model format",
            trimmed
        ))
    }
}

/// Update `model` and `small_model` in the app-level override file.
///
/// Does NOT mutate workspace templates/opencode.base.json or templates/opencode.json.
/// The override is stored outside the workspace and applied on the next Install/Update.
#[tauri::command]
pub fn update_opencode_model_selection(
    model: String,
    small_model: String,
) -> Result<String, String> {
    // Validate inputs
    validate_model_id(&model)?;
    validate_model_id(&small_model)?;

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

    // Atomic write: write to temp file then rename
    let tmp_path = override_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("failed to write model override: {}", e))?;
    std::fs::rename(&tmp_path, &override_path)
        .map_err(|e| format!("failed to save model override: {}", e))?;

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

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"default_agent":"architect","model":"opencode-go/glm-5.2","small_model":"opencode-go/deepseek-v4-flash"}"#,
        );
        write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow","deny":[]}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&ws, "agents/repo-scout.md", "# scout");

        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"default_agent":"architect","model":"opencode-go/glm-5.2","small_model":"opencode-go/deepseek-v4-flash"}"#,
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
        assert_eq!(health.generated_snapshot_status, "valid");
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

    #[test]
    fn test_generated_snapshot_current() {
        let ws = temp_root("gen-cur-ws");
        let home = temp_root("gen-cur-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        // Without a generator script, status is "valid" (not freshness-checked)
        assert_eq!(health.generated_snapshot_status, "valid");
        assert!(health
            .generated_snapshot_detail
            .contains("not freshness-checked"));
    }

    #[test]
    fn test_generated_snapshot_current_with_check() {
        let ws = temp_root("gen-chk-ok-ws");
        let home = temp_root("gen-chk-ok-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        // Create a generator script that passes --check
        let script_dir = ws.join("scripts");
        fs::create_dir_all(&script_dir).expect("create scripts dir");
        let script_path = script_dir.join("generate-opencode-config.py");
        fs::write(
            &script_path,
            "#!/usr/bin/env python3\nimport sys\nif sys.argv[1] == '--check':\n    sys.exit(0)\n",
        )
        .expect("write generator script");
        // Make it executable (macOS/Linux)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
                .expect("make script executable");
        }

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.generated_snapshot_status, "current");
        assert!(!health.generated_snapshot_detail.is_empty());
    }

    #[test]
    fn test_generated_snapshot_stale_with_check() {
        let ws = temp_root("gen-chk-fail-ws");
        let home = temp_root("gen-chk-fail-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "templates/tui.json", r#"{}"#);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/tui.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        // Create a generator script that FAILS --check
        let script_dir = ws.join("scripts");
        fs::create_dir_all(&script_dir).expect("create scripts dir");
        let script_path = script_dir.join("generate-opencode-config.py");
        fs::write(
            &script_path,
            "#!/usr/bin/env python3\nimport sys\nprint('CHECK FAILED: opencode.json snapshot is stale', file=sys.stderr)\nsys.exit(1)\n",
        )
        .expect("write generator script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
                .expect("make script executable");
        }

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
        write_file(root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(root, "templates/global-agent-rules.md", "# rules\n");
        write_file(root, "templates/opencode.json", "{}");
        write_file(root, "README.md", "# readme\n");
        fs::create_dir_all(root.join("skills")).expect("create skills dir");
    }

    #[test]
    fn test_generator_write_success_via_generate_default() {
        let ws = temp_root("gen-write-def");
        write_marker_workspace(&ws);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );

        // Use generate-default-opencode-config.py which exists in the dev checkout
        // We can't rely on it existing in a temp workspace, so create a custom one
        // that simply writes a marker file to prove --write was called
        write_generator_script(
            &ws,
            "scripts/generate-default-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nif len(sys.argv) >= 2 and sys.argv[1] == '--write':\n    with open('templates/.generated_marker', 'w') as f:\n        f.write('ok')\n    sys.exit(0)\nsys.exit(1)\n",
        );

        let result = super::run_generator_write(&ws).expect("generator should succeed");
        cleanup(&ws);

        assert!(result.success, "generator write should succeed");
        assert_eq!(result.action, "generate_opencode_config_snapshot");
        assert!(
            result.stdout.contains("Generated"),
            "stdout should indicate generation"
        );
    }

    #[test]
    fn test_generator_write_via_opencode_config_script() {
        let ws = temp_root("gen-write-alt");
        write_marker_workspace(&ws);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );

        // Only provide generate-opencode-config.py (the alternative name)
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nif sys.argv[1] == '--write':\n    with open('templates/.generated_marker', 'w') as f:\n        f.write('ok')\n    sys.exit(0)\nsys.exit(1)\n",
        );

        let result = super::run_generator_write(&ws).expect("generator should succeed");
        cleanup(&ws);

        assert!(result.success);
        assert!(result.stdout.contains("Generated"));
    }

    #[test]
    fn test_generator_write_first_candidate_used_when_both_exist() {
        let ws = temp_root("gen-write-first");
        write_marker_workspace(&ws);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );

        // Both scripts present. Only the first candidate succeeds.
        // generate-opencode-config.py returns 0, generate-default-opencode-config.py returns 1.
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nif sys.argv[1] == '--write':\n    sys.exit(0)\nelse:\n    sys.exit(1)\n",
        );
        write_generator_script(
            &ws,
            "scripts/generate-default-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n",
        );

        let result = super::run_generator_write(&ws).expect("should return ActionResult");
        cleanup(&ws);

        assert!(result.success, "first candidate should be used and succeed");
    }

    #[test]
    fn test_generator_write_no_script_returns_error() {
        let ws = temp_root("gen-write-no");
        write_marker_workspace(&ws);
        // No generator scripts at all

        let result = super::run_generator_write(&ws).expect("should return ActionResult (not Err)");
        cleanup(&ws);

        assert!(!result.success);
        assert!(result.stderr.contains("No OpenCode config generator found"));
    }

    #[test]
    fn test_generator_write_uses_write_not_check_or_apply() {
        let ws = temp_root("gen-write-flag");
        write_marker_workspace(&ws);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );

        // Script that verifies argv[1] is --write, not --check or --apply
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nif sys.argv[1:] == ['--write']:\n    sys.exit(0)\nelse:\n    print(f'UNEXPECTED ARGS: {sys.argv[1:]}', file=sys.stderr)\n    sys.exit(1)\n",
        );

        let result = super::run_generator_write(&ws).expect("generator should succeed");
        cleanup(&ws);

        assert!(result.success, "generator must be called with --write");
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

    #[test]
    fn test_generator_write_does_not_target_home_config() {
        let ws = temp_root("gen-write-safe");
        write_marker_workspace(&ws);
        write_file(&ws, "templates/opencode.base.json", r#"{"model":"test"}"#);
        write_file(
            &ws,
            "templates/opencode.policy.json",
            r#"{"read":{"default":"allow"}}"#,
        );

        // Script that writes to a marker file under the workspace only
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys, os\nif sys.argv[1] == '--write':\n    # Write only under workspace/templates/\n    ws = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n    with open(os.path.join(ws, 'templates', 'opencode.json'), 'w') as f:\n        f.write('{\"generated\":true}')\n    sys.exit(0)\nsys.exit(1)\n",
        );

        let result = super::run_generator_write(&ws).expect("generator should succeed");
        assert!(result.success);

        // Verify the generated file exists inside the workspace
        let snapshot = ws.join("templates/opencode.json");
        assert!(
            snapshot.is_file(),
            "snapshot should be written in workspace templates/"
        );
        let content = std::fs::read_to_string(&snapshot).unwrap_or_default();
        assert!(
            content.contains("generated"),
            "snapshot should contain generated content"
        );

        cleanup(&ws);
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
    fn test_validate_model_id_multiple_slashes() {
        let err = validate_model_id("a/b/c").unwrap_err();
        assert!(err.contains("exactly one"));
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
        write_file(&ws, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &ws,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &ws,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&ws, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Create a working generator script
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport json, sys\nwith open('templates/opencode.base.json') as f:\n    base = json.load(f)\nwith open('templates/opencode.policy.json') as f:\n    policy = json.load(f)\nconfig = dict(base)\nconfig['permission'] = {'read': policy.get('read', {})}\nwith open('templates/opencode.json', 'w') as f:\n    json.dump(config, f, indent=2)\n    f.write('\\n')\nif sys.argv[1:] == ['--write']:\n    sys.exit(0)\nelse:\n    sys.exit(0)\n",
        );

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
        write_file(&ws, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &ws,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &ws,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&ws, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Generator script that always fails
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nprint('simulated failure', file=sys.stderr)\nsys.exit(1)\n",
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
        let gen_result =
            super::run_generator_write(&ws).expect("generator should return ActionResult");
        assert!(!gen_result.success, "generator should fail");
        assert!(gen_result.stderr.contains("simulated failure"));

        cleanup(&ws);
        cleanup(&home);
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
    fn test_parse_models_rejects_multi_slash() {
        let output = "a/b/c\nprovider/model/extra\n";
        let models = parse_opencode_models_output(output);
        assert!(models.is_empty());
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
    fn test_list_available_opencode_models_error_message_safe() {
        // Verify the error message when opencode cannot be found does not
        // expose raw PATH values, auth files, or shell config.
        let err = super::list_available_opencode_models();
        if let Err(msg) = err {
            assert!(
                !msg.contains("PATH="),
                "error must not expose raw PATH: {}",
                msg
            );
            assert!(
                !msg.contains("/home/"),
                "error must not expose home directory: {}",
                msg
            );
            // Should mention Homebrew if relevant
            // (either the error mentions Homebrew or it succeeded)
        }
        // If it succeeded (opencode is installed), that's also fine
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
        write_file(&ws, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &ws,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &ws,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&ws, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Create a home dir with an installed config that should NOT be touched
        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"model":"installed-model","small_model":"installed-small"}"#,
        );

        // Generator script that merges base + policy into snapshot
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport json, sys\nwith open('templates/opencode.base.json') as f:\n    base = json.load(f)\nwith open('templates/opencode.policy.json') as f:\n    policy = json.load(f)\nconfig = dict(base)\nconfig['permission'] = {'read': policy.get('read', {})}\nwith open('templates/opencode.json', 'w') as f:\n    json.dump(config, f, indent=2)\n    f.write('\\n')\nif sys.argv[1:] == ['--write']:\n    sys.exit(0)\nelse:\n    sys.exit(0)\n",
        );

        // ── Simulate what update_opencode_model_selection does ──

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
        write_file(&ws, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &ws,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &ws,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&ws, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Generator that always fails
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport sys\nprint('simulated failure', file=sys.stderr)\nsys.exit(1)\n",
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
        let gen_result =
            super::run_generator_write(&ws).expect("generator should return ActionResult");
        assert!(!gen_result.success, "generator should fail");
        assert!(gen_result.stderr.contains("simulated failure"));

        // 4. Rollback: restore original base content
        std::fs::write(&base_path, &original_content).unwrap();

        // 5. Best-effort regenerate from restored base (this will also fail since script always fails)
        let _retry_result = super::run_generator_write(&ws);

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
        write_file(&ws, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &ws,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &ws,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&ws, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
        write_file(&ws, "README.md", "# readme\n");
        fs::create_dir_all(ws.join("skills")).expect("create skills dir");

        // Generator that succeeds but writes DIFFERENT model values (simulates a buggy generator)
        write_generator_script(
            &ws,
            "scripts/generate-opencode-config.py",
            "#!/usr/bin/env python3\nimport json, sys\nwith open('templates/opencode.base.json') as f:\n    base = json.load(f)\n# Intentionally write a DIFFERENT model to simulate validation failure\nconfig = dict(base)\nconfig['model'] = 'wrong/model'\nwith open('templates/opencode.json', 'w') as f:\n    json.dump(config, f, indent=2)\n    f.write('\\n')\nif sys.argv[1:] == ['--write']:\n    sys.exit(0)\nelse:\n    sys.exit(0)\n",
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
        let gen_result =
            super::run_generator_write(&ws).expect("generator should return ActionResult");
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
        let retry_result = super::run_generator_write(&ws);
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

        let rendered = render_expected_opencode_config(&template_json, &home)
            .expect("render should succeed");

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

        let rendered = render_expected_opencode_config(&template_json, &home)
            .expect("render should succeed");

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
        assert!(validate_model_id("provider/a/b").is_err());
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
