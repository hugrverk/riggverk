use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::status::file_eq;
use crate::agent_skill_targets::{codex_global_skills_dest, codex_home};
use crate::artifact_registry::ArtifactId;

#[derive(Serialize, Clone, Debug)]
pub struct CodexRuntimeCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct CodexAgentMismatch {
    pub filename: String,
    pub status: String,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct CodexRuntimeHealth {
    pub status: String,
    pub rules_status: String,
    pub rules_source_path: String,
    pub rules_installed_path: String,
    pub skills_status: String,
    pub skills_synced_count: usize,
    pub skills_expected_count: usize,
    pub skills_missing_count: usize,
    pub skills_diverged_count: usize,
    pub legacy_skills_path: String,
    pub legacy_skills_migratable_count: usize,
    pub legacy_skills_conflict_count: usize,
    pub agents_status: String,
    pub bundled_agent_count: usize,
    pub installed_bundled_agent_count: usize,
    pub extra_installed_agent_count: usize,
    pub agent_mismatches: Vec<CodexAgentMismatch>,
    pub config_status: String,
    pub template_config_path: String,
    pub installed_config_path: String,
    pub model: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub sandbox_mode: Option<String>,
    pub app_default_approvals_reviewer: Option<String>,
    pub app_default_tools_approval_mode: Option<String>,
    pub checks: Vec<CodexRuntimeCheck>,
    pub warnings: Vec<String>,
    pub summary: String,
    pub next_action: String,
}

const MANAGED_TOP_LEVEL_KEYS: &[&str] = &[
    "model",
    "model_reasoning_effort",
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
];
const MANAGED_APP_DEFAULT_KEYS: &[&str] = &["approvals_reviewer", "default_tools_approval_mode"];
// Pre-0.134 profile scheme this app used to write. Codex now rejects the
// top-level `profile` selector and ignores `[profiles.*]` tables, so
// app-shipped remnants count as divergence and are removed on update.
const LEGACY_TOP_LEVEL_PROFILE_VALUES: &[&str] = &["safe", "workspace-write"];
const LEGACY_PROFILES: &[&str] = &["safe", "workspace-write"];
const LEGACY_PROFILE_FIELDS: &[&str] = &["approval_policy", "sandbox_mode"];

fn list_bundled_codex_agents(agents_dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if !agents_dir.is_dir() {
        return names;
    }
    let entries = match fs::read_dir(agents_dir) {
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
        if path.extension().map(|e| e == "toml").unwrap_or(false) {
            names.push(name_str.into_owned());
        }
    }
    names.sort();
    names
}

fn parse_codex_config(path: &Path) -> Option<toml::Value> {
    let content = fs::read_to_string(path).ok()?;
    toml::from_str(&content).ok()
}

fn is_app_shaped_legacy_profile(profile: &toml::map::Map<String, toml::Value>) -> bool {
    !profile.is_empty()
        && profile
            .keys()
            .all(|key| LEGACY_PROFILE_FIELDS.contains(&key.as_str()))
}

pub(crate) fn extract_managed_codex_config(config: &toml::Value) -> toml::Value {
    let mut managed = toml::map::Map::new();
    if let Some(table) = config.as_table() {
        for key in MANAGED_TOP_LEVEL_KEYS {
            if let Some(value) = table.get(*key) {
                managed.insert(key.to_string(), value.clone());
            }
        }

        if let Some(app_default) = table
            .get("apps")
            .and_then(|apps| apps.as_table())
            .and_then(|apps| apps.get("_default"))
            .and_then(|default| default.as_table())
        {
            let mut default_managed = toml::map::Map::new();
            for key in MANAGED_APP_DEFAULT_KEYS {
                if let Some(value) = app_default.get(*key) {
                    default_managed.insert(key.to_string(), value.clone());
                }
            }
            if !default_managed.is_empty() {
                let mut apps = toml::map::Map::new();
                apps.insert("_default".into(), toml::Value::Table(default_managed));
                managed.insert("apps".into(), toml::Value::Table(apps));
            }
        }

        // Legacy markers: the template carries none, so any app-shipped
        // remnant makes the config read as diverged until cleaned up.
        if let Some(selector) = table.get("profile").and_then(|v| v.as_str()) {
            if LEGACY_TOP_LEVEL_PROFILE_VALUES.contains(&selector) {
                managed.insert("profile".to_string(), toml::Value::String(selector.into()));
            }
        }
        if let Some(profiles) = table.get("profiles").and_then(|v| v.as_table()) {
            let mut markers = toml::map::Map::new();
            for profile_name in LEGACY_PROFILES {
                if let Some(profile) = profiles.get(*profile_name).and_then(|v| v.as_table()) {
                    if is_app_shaped_legacy_profile(profile) {
                        markers.insert(
                            profile_name.to_string(),
                            toml::Value::Table(profile.clone()),
                        );
                    }
                }
            }
            if !markers.is_empty() {
                managed.insert("profiles".to_string(), toml::Value::Table(markers));
            }
        }
    }
    toml::Value::Table(managed)
}

pub(crate) fn managed_codex_keys_match(installed: &toml::Value, managed: &toml::Value) -> bool {
    extract_managed_codex_config(installed) == extract_managed_codex_config(managed)
}

fn unique_render_temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "agent-workspace-codex-render-{}-{nanos}",
        std::process::id()
    ))
}

fn cleanup_temp_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

/// Render Codex managed config fields from `managed_source` into `dest` via the
/// line-preserving Python owners. Refuses on malformed TOML or ambiguous structure.
pub(crate) fn render_codex_config_managed_projection(
    workspace_root: &Path,
    dest: &Path,
    managed_source: &Path,
) -> Result<String, String> {
    let legacy_script = workspace_root.join("scripts/merge-codex-config.py");
    if !legacy_script.is_file() {
        return Err(format!(
            "missing Codex merge script: {}",
            legacy_script.display()
        ));
    }
    let routing_script = workspace_root.join("scripts/ensure-codex-routing-defaults.py");
    if !routing_script.is_file() {
        return Err(format!(
            "missing Codex routing defaults script: {}",
            routing_script.display()
        ));
    }

    let legacy_script_str = super::workspace::path_arg(&legacy_script)?;
    let dest_str = super::workspace::path_arg(dest)?;
    let managed_source_str = super::workspace::path_arg(managed_source)?;
    let (ok, legacy_stdout, legacy_stderr, legacy_code) = super::process::run_cmd(
        "python3",
        &[
            &legacy_script_str,
            &dest_str,
            &managed_source_str,
            "--render-rollback-managed",
        ],
        workspace_root,
    );
    if !ok {
        return Err(format!(
            "codex legacy managed render failed (exit {:?}): {}",
            legacy_code,
            legacy_stderr.trim()
        ));
    }
    legacy_stdout
        .parse::<toml::Value>()
        .map_err(|e| format!("codex legacy managed render produced invalid TOML: {e}"))?;

    let temp_dir = unique_render_temp_dir();
    let result = (|| -> Result<String, String> {
        fs::create_dir_all(&temp_dir).map_err(|e| format!("create codex render temp dir: {e}"))?;
        let temp_config = temp_dir.join("config.toml");
        let temp_backup = temp_dir.join("backup");
        fs::write(&temp_config, legacy_stdout.as_bytes())
            .map_err(|e| format!("write codex render temp config: {e}"))?;

        let routing_script_str = super::workspace::path_arg(&routing_script)?;
        let temp_config_str = super::workspace::path_arg(&temp_config)?;
        let temp_backup_str = super::workspace::path_arg(&temp_backup)?;
        let (routing_ok, _routing_stdout, routing_stderr, routing_code) = super::process::run_cmd(
            "python3",
            &[
                &routing_script_str,
                &temp_config_str,
                &managed_source_str,
                "--apply",
                "--backup-dir",
                &temp_backup_str,
            ],
            workspace_root,
        );
        if !routing_ok {
            return Err(format!(
                "codex routing defaults render failed (exit {:?}): {}",
                routing_code,
                routing_stderr.trim()
            ));
        }

        let rendered = fs::read_to_string(&temp_config)
            .map_err(|e| format!("read codex rendered temp config: {e}"))?;
        rendered
            .parse::<toml::Value>()
            .map_err(|e| format!("codex rendered config invalid TOML: {e}"))?;
        Ok(rendered)
    })();
    cleanup_temp_dir(&temp_dir);
    result
}

fn extract_string_field(table: &toml::Value, path: &[&str]) -> Option<String> {
    let mut current = table;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn skill_state(source_md: &Path, target_md: &Path) -> &'static str {
    if !source_md.is_file() {
        return "invalid";
    }
    if !target_md.is_file() {
        return "missing";
    }
    if file_eq(source_md, target_md) {
        "synced"
    } else {
        "diverged"
    }
}

pub fn compute_health(workspace_root: &Path, home_dir: &Path) -> CodexRuntimeHealth {
    let rules_source_path = workspace_root.join("templates/sync/codex-rules.md");
    let codex_dir = codex_home(home_dir);
    let rules_installed_path = codex_dir.join("AGENTS.md");
    let agents_source_dir = workspace_root.join("templates/codex/agents");
    let agents_target_dir = codex_dir.join("agents");
    let template_config_path = workspace_root.join("templates/codex/config.toml");
    let installed_config_path = codex_dir.join("config.toml");
    let skills_target_root = codex_global_skills_dest(home_dir);

    let rules_source_path_str = rules_source_path.to_string_lossy().into_owned();
    let rules_installed_path_str = rules_installed_path.to_string_lossy().into_owned();
    let template_config_path_str = template_config_path.to_string_lossy().into_owned();
    let installed_config_path_str = installed_config_path.to_string_lossy().into_owned();

    let mut checks: Vec<CodexRuntimeCheck> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut agent_mismatches: Vec<CodexAgentMismatch> = Vec::new();
    let mut has_fail = false;
    let mut has_warn = false;

    let rules_status: String = if !rules_source_path.is_file() {
        has_fail = true;
        "missing".into()
    } else if !rules_installed_path.is_file() {
        has_warn = true;
        "missing".into()
    } else if file_eq(&rules_source_path, &rules_installed_path) {
        "synced".into()
    } else {
        has_warn = true;
        "diverged".into()
    };
    checks.push(CodexRuntimeCheck {
        id: "rules".into(),
        label: "Global AGENTS.md".into(),
        status: match rules_status.as_str() {
            "synced" => "pass",
            "missing" => "fail",
            _ => "warn",
        }
        .into(),
        detail: rules_installed_path_str.clone(),
    });

    let mut skills_synced_count = 0usize;
    let mut skills_missing_count = 0usize;
    let mut skills_diverged_count = 0usize;
    let mut skills_expected_count = 0usize;
    let mut skills_source_invalid = false;
    let skills_status =
        match crate::artifact_registry::discover_skill_names_for_harness(workspace_root, "codex") {
            Ok(skill_names) => {
                for skill_name in skill_names {
                    skills_expected_count += 1;
                    let source_md =
                        ArtifactId::CodexSkill(skill_name.clone()).resolve_source(workspace_root);
                    let target_md = skills_target_root
                        .join(skill_name.as_str())
                        .join("SKILL.md");
                    let Some(source_md) = source_md else {
                        skills_source_invalid = true;
                        has_fail = true;
                        warnings.push(format!(
                            "missing Codex skill adapter source for {}",
                            skill_name.as_str()
                        ));
                        continue;
                    };
                    match skill_state(&source_md, &target_md) {
                        "synced" => skills_synced_count += 1,
                        "missing" => {
                            skills_missing_count += 1;
                            has_warn = true;
                        }
                        "diverged" => {
                            skills_diverged_count += 1;
                            has_warn = true;
                        }
                        _ => {
                            skills_source_invalid = true;
                            has_fail = true;
                            warnings.push(format!(
                                "missing Codex skill adapter source for {}",
                                skill_name.as_str()
                            ));
                        }
                    }
                }
                if skills_expected_count == 0 {
                    has_fail = true;
                    "missing".into()
                } else if skills_source_invalid {
                    "missing".into()
                } else if skills_missing_count == 0 && skills_diverged_count == 0 {
                    "synced".into()
                } else if skills_synced_count == 0 && skills_diverged_count == 0 {
                    "missing".into()
                } else {
                    "diverged".into()
                }
            }
            Err(detail) => {
                has_fail = true;
                warnings.push(detail);
                "missing".into()
            }
        };
    checks.push(CodexRuntimeCheck {
        id: "skills".into(),
        label: "Global skills ($CODEX_HOME/skills)".into(),
        status: if skills_status == "synced" {
            "pass".into()
        } else if skills_status == "missing"
            && (skills_expected_count == 0 || skills_source_invalid)
        {
            "fail".into()
        } else {
            "warn".into()
        },
        detail: format!(
            "{}/{} synced at {}",
            skills_synced_count,
            skills_expected_count,
            skills_target_root.to_string_lossy()
        ),
    });

    let bundled_agents = list_bundled_codex_agents(&agents_source_dir);
    let bundled_agent_count = bundled_agents.len();
    let bundled_set: BTreeSet<String> = bundled_agents.iter().cloned().collect();
    let mut installed_bundled_count = 0usize;
    let mut installed_agent_names: BTreeSet<String> = BTreeSet::new();
    if agents_target_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&agents_target_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || path.extension().map(|e| e == "toml") != Some(true) {
                    continue;
                }
                installed_agent_names.insert(name);
            }
        }
    }

    for agent_name in &bundled_agents {
        let source_path = agents_source_dir.join(agent_name);
        let target_path = agents_target_dir.join(agent_name);
        if !target_path.exists() {
            agent_mismatches.push(CodexAgentMismatch {
                filename: agent_name.clone(),
                status: "missing".into(),
                detail: format!("{agent_name} not installed"),
            });
            has_warn = true;
        } else if !file_eq(&source_path, &target_path) {
            agent_mismatches.push(CodexAgentMismatch {
                filename: agent_name.clone(),
                status: "diverged".into(),
                detail: format!("{agent_name} differs from bundled agent"),
            });
            has_warn = true;
        } else {
            installed_bundled_count += 1;
        }
    }

    let extra_installed: Vec<String> = installed_agent_names
        .difference(&bundled_set)
        .cloned()
        .collect();
    let extra_installed_agent_count = extra_installed.len();
    if !extra_installed.is_empty() {
        warnings.push(format!(
            "{} extra Codex agent(s) installed: {}",
            extra_installed_agent_count,
            extra_installed.join(", ")
        ));
    }

    let agents_status = if bundled_agent_count == 0 {
        has_fail = true;
        "missing".into()
    } else if agent_mismatches.is_empty() {
        "synced".into()
    } else {
        "diverged".into()
    };
    checks.push(CodexRuntimeCheck {
        id: "agents".into(),
        label: "Native Codex agents".into(),
        status: if agents_status == "synced" {
            "pass".into()
        } else if bundled_agent_count == 0 {
            "fail".into()
        } else {
            "warn".into()
        },
        detail: format!(
            "{}/{} bundled agents installed",
            installed_bundled_count, bundled_agent_count
        ),
    });

    let mut model = None;
    let mut model_reasoning_effort = None;
    let mut approval_policy = None;
    let mut approvals_reviewer = None;
    let mut sandbox_mode = None;
    let mut app_default_approvals_reviewer = None;
    let mut app_default_tools_approval_mode = None;
    let template_config = parse_codex_config(&template_config_path);
    let installed_config = parse_codex_config(&installed_config_path);
    let config_status = if !template_config_path.is_file() {
        has_fail = true;
        "missing".into()
    } else if template_config.is_none() {
        has_fail = true;
        "invalid".into()
    } else if !installed_config_path.is_file() {
        has_warn = true;
        "missing".into()
    } else if installed_config.is_none() {
        has_fail = true;
        "invalid".into()
    } else if managed_codex_keys_match(
        installed_config.as_ref().expect("installed config"),
        template_config.as_ref().expect("template config"),
    ) {
        "synced".into()
    } else {
        has_warn = true;
        "diverged".into()
    };

    if let Some(installed) = &installed_config {
        model = extract_string_field(installed, &["model"]);
        model_reasoning_effort = extract_string_field(installed, &["model_reasoning_effort"]);
        approval_policy = extract_string_field(installed, &["approval_policy"]);
        approvals_reviewer = extract_string_field(installed, &["approvals_reviewer"]);
        sandbox_mode = extract_string_field(installed, &["sandbox_mode"]);
        app_default_approvals_reviewer =
            extract_string_field(installed, &["apps", "_default", "approvals_reviewer"]);
        app_default_tools_approval_mode = extract_string_field(
            installed,
            &["apps", "_default", "default_tools_approval_mode"],
        );
        checks.push(CodexRuntimeCheck {
            id: "installed_config_valid".into(),
            label: "Installed config is valid TOML".into(),
            status: "pass".into(),
            detail: "parsed successfully".into(),
        });
    } else if installed_config_path.is_file() {
        checks.push(CodexRuntimeCheck {
            id: "installed_config_valid".into(),
            label: "Installed config is valid TOML".into(),
            status: "fail".into(),
            detail: "parse error".into(),
        });
        has_fail = true;
    }

    if let Some(template) = &template_config {
        checks.push(CodexRuntimeCheck {
            id: "template_config_valid".into(),
            label: "Template config is valid TOML".into(),
            status: "pass".into(),
            detail: "parsed successfully".into(),
        });
        let managed_match = installed_config
            .as_ref()
            .map(|installed| managed_codex_keys_match(installed, template))
            .unwrap_or(false);
        checks.push(CodexRuntimeCheck {
            id: "managed_config_match".into(),
            label: "Managed config routing defaults match bundled workspace".into(),
            status: if managed_match {
                "pass".into()
            } else if installed_config.is_some() {
                "warn".into()
            } else {
                "fail".into()
            },
            detail: if managed_match {
                "managed routing defaults match bundled workspace (personality/MCP preserved)"
                    .into()
            } else if installed_config.is_some() {
                "managed routing defaults differ from bundled workspace".into()
            } else {
                "installed config missing".into()
            },
        });
    } else if template_config_path.is_file() {
        checks.push(CodexRuntimeCheck {
            id: "template_config_valid".into(),
            label: "Template config is valid TOML".into(),
            status: "fail".into(),
            detail: "parse error".into(),
        });
    }

    let status: String = if has_fail {
        "missing".into()
    } else if has_warn {
        "diverged".into()
    } else {
        "synced".into()
    };

    let (summary, next_action) = match status.as_str() {
        "synced" => (
            "Codex runtime matches the bundled workspace.".to_string(),
            "No runtime action needed.".to_string(),
        ),
        "diverged" => (
            "Codex runtime differs from bundled templates. Review diff before applying."
                .to_string(),
            "Run diff or sync for diverged surfaces.".to_string(),
        ),
        _ => (
            "Codex runtime is missing required files.".to_string(),
            "Install or sync required surfaces.".to_string(),
        ),
    };

    CodexRuntimeHealth {
        status,
        rules_status,
        rules_source_path: rules_source_path_str,
        rules_installed_path: rules_installed_path_str,
        skills_status,
        skills_synced_count,
        skills_expected_count,
        skills_missing_count,
        skills_diverged_count,
        legacy_skills_path: String::new(),
        legacy_skills_migratable_count: 0,
        legacy_skills_conflict_count: 0,
        agents_status,
        bundled_agent_count,
        installed_bundled_agent_count: installed_bundled_count,
        extra_installed_agent_count,
        agent_mismatches,
        config_status,
        template_config_path: template_config_path_str,
        installed_config_path: installed_config_path_str,
        model,
        model_reasoning_effort,
        approval_policy,
        approvals_reviewer,
        sandbox_mode,
        app_default_approvals_reviewer,
        app_default_tools_approval_mode,
        checks,
        warnings,
        summary,
        next_action,
    }
}

#[tauri::command]
pub fn get_codex_runtime_health() -> Result<CodexRuntimeHealth, String> {
    let workspace_root = super::workspace::workspace_root()?;
    let home_dir = crate::cursor_profile_paths::resolve_user_home()?;
    Ok(compute_health(&workspace_root, &home_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("aw-codex-runtime-{label}-{nonce}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, content).expect("write file");
    }

    fn managed_codex_config() -> &'static str {
        r#"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"#
    }

    fn add_rules(ws: &Path, home: &Path) {
        write_file(&ws.join("templates/sync/codex-rules.md"), "# rules");
        write_file(&home.join(".codex/AGENTS.md"), "# rules");
    }

    fn add_skill(ws: &Path, home: &Path, name: &str) {
        write_file(
            &ws.join(format!("skills/{name}/SKILL.md")),
            &format!(
                "---\nname: {name}\ndescription: test skill\ntargets: codex, opencode, claude, cursor\n---\n# canonical\n"
            ),
        );
        write_file(
            &ws.join(format!("templates/skills/codex/{name}/SKILL.md")),
            &format!(
                "---\nname: {name}\ndescription: test skill\ntargets: codex\n---\n# codex adapter\n"
            ),
        );
        write_file(
            &home.join(format!(".codex/skills/{name}/SKILL.md")),
            &format!(
                "---\nname: {name}\ndescription: test skill\ntargets: codex\n---\n# codex adapter\n"
            ),
        );
    }

    fn add_config(ws: &Path, home: &Path, installed_extra: &str) {
        write_file(
            &ws.join("templates/codex/config.toml"),
            managed_codex_config(),
        );
        write_file(
            &home.join(".codex/config.toml"),
            &format!("{}\n{}", managed_codex_config(), installed_extra),
        );
    }

    fn add_agent(ws: &Path, home: &Path, name: &str, body: &str) {
        write_file(&ws.join(format!("templates/codex/agents/{name}")), body);
        write_file(&home.join(format!(".codex/agents/{name}")), body);
    }

    #[test]
    fn test_managed_config_match_preserves_unknown_sections() {
        let ws = temp_root("cfg-preserve");
        let home = temp_root("cfg-preserve-home");
        add_rules(&ws, &home);
        add_config(
            &ws,
            &home,
            r#"
[mcp_servers.custom]
command = "echo"
"#,
        );
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        let managed = health
            .checks
            .iter()
            .find(|c| c.id == "managed_config_match")
            .expect("managed check");
        assert_eq!(managed.status, "pass");
        assert_eq!(health.config_status, "synced");
    }

    #[test]
    fn test_diverged_when_managed_field_differs() {
        let ws = temp_root("cfg-div");
        let home = temp_root("cfg-div-home");
        add_rules(&ws, &home);
        write_file(
            &ws.join("templates/codex/config.toml"),
            managed_codex_config(),
        );
        write_file(
            &home.join(".codex/config.toml"),
            r#"
model = "gpt-5.4"
model_reasoning_effort = "high"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"#,
        );
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.config_status, "diverged");
        assert_eq!(health.status, "diverged");
    }

    #[test]
    fn test_diverged_when_app_default_approval_differs() {
        let installed = toml::from_str::<toml::Value>(
            "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"high\"\napproval_policy = \"on-request\"\napprovals_reviewer = \"user\"\nsandbox_mode = \"workspace-write\"\napps._default.approvals_reviewer = \"auto_review\"\napps._default.default_tools_approval_mode = \"prompt\"\n",
        )
        .expect("installed");
        let template = toml::from_str::<toml::Value>(managed_codex_config()).expect("template");
        assert!(!managed_codex_keys_match(&installed, &template));
    }

    #[test]
    fn test_diverged_when_legacy_profile_scheme_remains() {
        let ws = temp_root("cfg-legacy");
        let home = temp_root("cfg-legacy-home");
        add_rules(&ws, &home);
        write_file(
            &ws.join("templates/codex/config.toml"),
            managed_codex_config(),
        );
        // Managed fields match, but the fatal pre-0.134 selector and an
        // app-shipped profile table remain — must read as diverged so the
        // update offers the cleanup.
        write_file(
            &home.join(".codex/config.toml"),
            &format!(
                r#"{}
profile = "safe"

[profiles.safe]
approval_policy = "on-request"
sandbox_mode = "workspace-write"
"#,
                managed_codex_config()
            ),
        );
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.config_status, "diverged");

        // A user-customized profile table alone is preserved and not flagged.
        let installed = toml::from_str::<toml::Value>(&format!(
            "{}\n[profiles.custom]\nmy_key = true\n",
            managed_codex_config()
        ))
        .expect("installed");
        let template = toml::from_str::<toml::Value>(managed_codex_config()).expect("template");
        assert!(managed_codex_keys_match(&installed, &template));
    }

    #[test]
    fn test_codex_skills_synced_against_generated_adapter() {
        let ws = temp_root("skill-adapter");
        let home = temp_root("skill-adapter-home");
        add_rules(&ws, &home);
        add_config(&ws, &home, "");
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.skills_status, "synced");
        assert_eq!(health.skills_synced_count, 1);
        assert_eq!(health.skills_expected_count, 1);
    }

    #[test]
    fn test_codex_skills_diverge_when_installed_content_is_canonical_only() {
        let ws = temp_root("skill-canonical-installed");
        let home = temp_root("skill-canonical-installed-home");
        add_rules(&ws, &home);
        add_config(&ws, &home, "");
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");
        write_file(
            &home.join(".codex/skills/diagnose/SKILL.md"),
            "---\nname: diagnose\ndescription: test skill\ntargets: codex, opencode, claude, cursor\n---\n# canonical\n",
        );

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.skills_status, "diverged");
        assert_eq!(health.skills_synced_count, 0);
        assert_eq!(health.skills_diverged_count, 1);
    }

    #[test]
    fn test_codex_skills_missing_when_generated_adapter_source_missing() {
        let ws = temp_root("skill-adapter-missing");
        let home = temp_root("skill-adapter-missing-home");
        add_rules(&ws, &home);
        add_config(&ws, &home, "");
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        write_file(
            &ws.join("skills/diagnose/SKILL.md"),
            "---\nname: diagnose\ndescription: test skill\ntargets: codex, opencode, claude, cursor\n---\n# canonical\n",
        );
        write_file(
            &home.join(".codex/skills/diagnose/SKILL.md"),
            "---\nname: diagnose\ndescription: test skill\ntargets: codex, opencode, claude, cursor\n---\n# canonical\n",
        );

        let health = compute_health(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.skills_status, "missing");
        assert_eq!(health.status, "missing");
        assert!(health
            .warnings
            .iter()
            .any(|w| w.contains("missing Codex skill adapter source")));
    }
}
