use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

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
    pub qwen_context: Option<u64>,
    pub qwen_output: Option<u64>,
    pub bundled_agent_count: usize,
    pub installed_bundled_agent_count: usize,
    pub extra_installed_agent_count: usize,
    pub agent_mismatches: Vec<OpenCodeAgentMismatch>,
    pub warnings: Vec<String>,
}

/// Extract a non-sensitive field from a JSON value at a dotted path.
fn extract_string_field(root: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut current = root;
    for &key in path {
        current = current.get(key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn extract_u64_field(root: &serde_json::Value, path: &[&str]) -> Option<u64> {
    let mut current = root;
    for &key in path {
        current = current.get(key)?;
    }
    current.as_u64()
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

/// Compute OpenCode runtime health for a given workspace root and home directory.
/// This is a pure function suitable for unit testing with temp dirs.
pub fn compute_health(workspace_root: &Path, home_dir: &Path) -> OpenCodeRuntimeHealth {
    let template_config_path = workspace_root.join("templates/opencode.json");
    let installed_config_path = home_dir.join(".config/opencode/opencode.json");
    let agents_source_dir = workspace_root.join("agents");
    let agents_target_dir = home_dir.join(".config/opencode/agents");

    let template_config_path_str = template_config_path.to_string_lossy().into_owned();
    let installed_config_path_str = installed_config_path.to_string_lossy().into_owned();

    let mut checks: Vec<OpenCodeRuntimeCheck> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut agent_mismatches: Vec<OpenCodeAgentMismatch> = Vec::new();

    // Default extracted fields
    let mut default_agent: Option<String> = None;
    let mut model: Option<String> = None;
    let mut small_model: Option<String> = None;
    let mut qwen_context: Option<u64> = None;
    let mut qwen_output: Option<u64> = None;

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
    if let (Some(ref _t_json), Some(ref i_json)) = (&template_json, &installed_json) {
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
        qwen_context = extract_u64_field(
            i_json,
            &[
                "provider",
                "opencode-go",
                "models",
                "qwen3.6-plus",
                "limit",
                "context",
            ],
        );
        qwen_output = extract_u64_field(
            i_json,
            &[
                "provider",
                "opencode-go",
                "models",
                "qwen3.6-plus",
                "limit",
                "output",
            ],
        );

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

        // Check qwen3.6-plus context
        if let Some(ctx) = qwen_context {
            checks.push(OpenCodeRuntimeCheck {
                id: "qwen_context".into(),
                label: "qwen3.6-plus context".into(),
                status: "pass".into(),
                detail: ctx.to_string(),
            });
        } else {
            checks.push(OpenCodeRuntimeCheck {
                id: "qwen_context".into(),
                label: "qwen3.6-plus context".into(),
                status: "warn".into(),
                detail: "not set in installed config".into(),
            });
            // Missing qwen limits are informational warnings, not divergence
        }

        // Check qwen3.6-plus output
        if let Some(out) = qwen_output {
            checks.push(OpenCodeRuntimeCheck {
                id: "qwen_output".into(),
                label: "qwen3.6-plus output".into(),
                status: "pass".into(),
                detail: out.to_string(),
            });
        } else {
            checks.push(OpenCodeRuntimeCheck {
                id: "qwen_output".into(),
                label: "qwen3.6-plus output".into(),
                status: "warn".into(),
                detail: "not set in installed config".into(),
            });
            // Missing qwen limits are informational warnings, not divergence
        }

        // Check config match (byte comparison)
        let configs_match = file_eq(&template_config_path, &installed_config_path);
        checks.push(OpenCodeRuntimeCheck {
            id: "configs_match".into(),
            label: "Installed config matches template".into(),
            status: if configs_match {
                "pass".into()
            } else {
                "warn".into()
            },
            detail: if configs_match {
                "exact match".into()
            } else {
                "installed runtime differs from workspace bundle. Run diff before sync.".into()
            },
        });
        if !configs_match {
            has_warn = true;
        }
    } else if template_json.is_some() || installed_json.is_some() {
        // One parsed, one didn't — already marked fail above
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

    // Extra installed agents (informational only — do not affect status)
    let extra_installed: Vec<String> = installed_agent_names
        .difference(&bundled_set)
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

    // Determine overall status
    let status = if has_fail {
        "missing".into()
    } else if has_warn {
        "diverged".into()
    } else if bundled_agent_count == 0 && !template_exists {
        "unknown".into()
    } else {
        "synced".into()
    };

    OpenCodeRuntimeHealth {
        status,
        template_config_path: template_config_path_str,
        installed_config_path: installed_config_path_str,
        checks,
        default_agent,
        model,
        small_model,
        qwen_context,
        qwen_output,
        bundled_agent_count,
        installed_bundled_agent_count: installed_bundled_count,
        extra_installed_agent_count,
        agent_mismatches,
        warnings,
    }
}

#[tauri::command]
pub fn get_opencode_runtime_health() -> Result<OpenCodeRuntimeHealth, String> {
    use crate::agent_targets;
    use crate::commands::workspace::repo_path;

    let workspace_root = repo_path();
    let home = agent_targets::home_dir()?;

    // If workspace root doesn't exist or isn't valid, still compute health
    // so the UI can show missing/invalid status
    Ok(compute_health(&workspace_root, &home))
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

    fn setup_synced_workspace(name: &str) -> (PathBuf, PathBuf) {
        let ws = temp_root(&format!("{name}-ws"));
        let home = temp_root(&format!("{name}-home"));

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"default_agent":"architect","model":"opencode-go/deepseek-v4-pro","small_model":"opencode-go/deepseek-v4-flash","provider":{"opencode-go":{"models":{"qwen3.6-plus":{"limit":{"context":1000000,"output":65536}}}}}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&ws, "agents/scout.md", "# scout");

        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"default_agent":"architect","model":"opencode-go/deepseek-v4-pro","small_model":"opencode-go/deepseek-v4-flash","provider":{"opencode-go":{"models":{"qwen3.6-plus":{"limit":{"context":1000000,"output":65536}}}}}}"#,
        );
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/agents/scout.md", "# scout");

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
        assert_eq!(health.model, Some("opencode-go/deepseek-v4-pro".into()));
        assert_eq!(
            health.small_model,
            Some("opencode-go/deepseek-v4-flash".into())
        );
        assert_eq!(health.qwen_context, Some(1000000));
        assert_eq!(health.qwen_output, Some(65536));
        assert_eq!(health.bundled_agent_count, 2);
        assert_eq!(health.installed_bundled_agent_count, 2);
        assert_eq!(health.extra_installed_agent_count, 0);
        assert!(health.agent_mismatches.is_empty());
    }

    #[test]
    fn test_missing_when_installed_config_absent() {
        let ws = temp_root("missing-ws");
        let home = temp_root("missing-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

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
    fn test_diverged_when_configs_differ() {
        let ws = temp_root("div-cfg-ws");
        let home = temp_root("div-cfg-home");

        write_file(&ws, "templates/opencode.json", r#"{"version":2}"#);
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&home, ".config/opencode/opencode.json", r#"{"version":1}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

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
    fn test_diverged_when_bundled_agent_missing_from_installed() {
        let ws = temp_root("div-agent-miss-ws");
        let home = temp_root("div-agent-miss-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");
        write_file(&ws, "agents/scout.md", "# scout");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");
        // scout.md missing from installed

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.status, "diverged");
        assert_eq!(health.agent_mismatches.len(), 1);
        assert_eq!(health.agent_mismatches[0].filename, "scout.md");
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

    #[test]
    fn test_qwen_limits_extracted_when_present() {
        let ws = temp_root("qwen-ws");
        let home = temp_root("qwen-home");

        write_file(
            &ws,
            "templates/opencode.json",
            r#"{"provider":{"opencode-go":{"models":{"qwen3.6-plus":{"limit":{"context":1000000,"output":65536}}}}}}"#,
        );
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(
            &home,
            ".config/opencode/opencode.json",
            r#"{"provider":{"opencode-go":{"models":{"qwen3.6-plus":{"limit":{"context":1000000,"output":65536}}}}}}"#,
        );
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.qwen_context, Some(1000000));
        assert_eq!(health.qwen_output, Some(65536));
    }

    #[test]
    fn test_missing_qwen_limits_produce_warn_not_panic() {
        let ws = temp_root("no-qwen-ws");
        let home = temp_root("no-qwen-home");

        write_file(&ws, "templates/opencode.json", r#"{}"#);
        write_file(&ws, "agents/architect.md", "# architect");

        write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
        write_file(&home, ".config/opencode/agents/architect.md", "# architect");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        let ctx_check = health
            .checks
            .iter()
            .find(|c| c.id == "qwen_context")
            .unwrap();
        assert_eq!(ctx_check.status, "warn");
        let out_check = health
            .checks
            .iter()
            .find(|c| c.id == "qwen_output")
            .unwrap();
        assert_eq!(out_check.status, "warn");
        assert_eq!(health.qwen_context, None);
        assert_eq!(health.qwen_output, None);
    }
}
