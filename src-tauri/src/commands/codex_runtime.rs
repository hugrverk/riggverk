use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::status::file_eq;
use crate::agent_skill_targets::codex_home;
use crate::skill_health::{old_skill_copies, skill_files_status};
use crate::skill_roots::{codex_home_is_custom, SkillRoot};

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
    /// Enforced keys the user keeps (names only): they count as matching while the installed value
    /// is the kept one.
    pub config_kept: Vec<String>,
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

/// Top-level keys the app keeps aligned with the bundled template on every update.
const ENFORCED_TOP_LEVEL_KEYS: &[&str] = &["approval_policy", "approvals_reviewer", "sandbox_mode"];
/// Written from the template only while `config.toml` has no value for the key.
/// Afterwards they are user-owned: never overwritten and never counted as drift.
const CREATE_ONLY_TOP_LEVEL_KEYS: &[&str] = &["model", "model_reasoning_effort"];
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
        for key in ENFORCED_TOP_LEVEL_KEYS {
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

/// True when `installed` needs no update from `managed` (the bundled template).
/// Create-only keys count as drift only while the template sets them and
/// `installed` has no value; any user value matches.
pub(crate) fn managed_codex_keys_match(installed: &toml::Value, managed: &toml::Value) -> bool {
    extract_managed_codex_config(installed) == extract_managed_codex_config(managed)
        && CREATE_ONLY_TOP_LEVEL_KEYS
            .iter()
            .all(|key| managed.get(*key).is_none() || installed.get(*key).is_some())
}

fn unique_render_temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "riggverk-codex-render-{}-{nanos}",
        std::process::id()
    ))
}

fn cleanup_temp_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

/// Render Codex managed config fields from `managed_source` into `dest` via the
/// line-preserving Python owners. Refuses on malformed TOML or ambiguous structure.
///
/// `bundled_root` is the app's bundled, read-only resource root (`setup_roots::bundled_root_for`):
/// the scripts run from there and never from the active workspace, which is user-chosen and untrusted.
/// The workspace-owned files reach the scripts only as path arguments.
pub(crate) fn render_codex_config_managed_projection(
    bundled_root: &Path,
    dest: &Path,
    managed_source: &Path,
) -> Result<String, String> {
    let legacy_script = bundled_root.join("scripts/merge-codex-config.py");
    if !legacy_script.is_file() {
        return Err(format!(
            "missing Codex merge script: {}",
            legacy_script.display()
        ));
    }
    let routing_script = bundled_root.join("scripts/ensure-codex-routing-defaults.py");
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
        bundled_root,
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
            bundled_root,
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

/// [`render_codex_config_managed_projection`] for an apply into `dest`: the keys the user keeps
/// (see [`crate::codex_config_keep`]) are rendered from their kept value, so the update never
/// writes over them. Without kept keys it is the plain render from `source`.
pub(crate) fn render_codex_config_for_apply(
    bundled_root: &Path,
    workspace_root: &Path,
    home: &Path,
    dest: &Path,
    source: &Path,
) -> Result<String, String> {
    let (Some(installed), Some(template)) = (parse_codex_config(dest), parse_codex_config(source))
    else {
        return render_codex_config_managed_projection(bundled_root, dest, source);
    };
    let assessment =
        crate::codex_config_keep::assess(Some(workspace_root), home, &installed, &template);
    if assessment.active.is_empty() {
        return render_codex_config_managed_projection(bundled_root, dest, source);
    }
    let text = toml::to_string(&assessment.effective)
        .map_err(|e| format!("serialize the codex config with your kept keys: {e}"))?;
    let temp_dir = unique_render_temp_dir();
    let result = (|| -> Result<String, String> {
        fs::create_dir_all(&temp_dir).map_err(|e| format!("create codex render temp dir: {e}"))?;
        let effective_source = temp_dir.join("config.toml");
        fs::write(&effective_source, text.as_bytes())
            .map_err(|e| format!("write codex render source: {e}"))?;
        render_codex_config_managed_projection(bundled_root, dest, &effective_source)
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

/// The folder skills are installed into for Codex: `~/.agents/skills`, or `$CODEX_HOME/skills`
/// when `CODEX_HOME` is customised. The other of the two is a folder older versions filled.
fn codex_skill_roots(home_dir: &Path) -> (SkillRoot, SkillRoot) {
    if codex_home_is_custom(home_dir) {
        (SkillRoot::CodexHome, SkillRoot::Agents)
    } else {
        (SkillRoot::Agents, SkillRoot::CodexHome)
    }
}

/// Health against the app's bundle; the workspace folder's copies play no part. `workspace_root`
/// is only where the user's kept config keys are recorded: without it nothing is kept.
pub fn compute_health(home_dir: &Path, workspace_root: Option<&Path>) -> CodexRuntimeHealth {
    let bundled = crate::setup_roots::bundled_root().ok();
    compute_health_with_bundle(bundled.as_deref(), workspace_root, home_dir)
}

/// All managed files are compared with the bundled sources that install applies.
fn compute_health_with_bundle(
    bundled_root: Option<&Path>,
    workspace_root: Option<&Path>,
    home_dir: &Path,
) -> CodexRuntimeHealth {
    let source_path = |rel: &str| bundled_root.map(|root| root.join(rel)).unwrap_or_default();
    let rules_source_path = source_path("templates/sync/codex-rules.md");
    let codex_dir = codex_home(home_dir);
    let rules_installed_path = codex_dir.join("AGENTS.md");
    let agents_source_dir = source_path("templates/codex/agents");
    let agents_target_dir = codex_dir.join("agents");
    let template_config_path = source_path("templates/codex/config.toml");
    let installed_config_path = codex_dir.join("config.toml");

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
    } else if std::fs::read(&rules_source_path)
        .ok()
        .zip(std::fs::read(&rules_installed_path).ok())
        .is_some_and(|(source, installed)| {
            crate::rules_block::installed_matches_source(&installed, &source)
        })
    {
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

    // Codex reads AGENTS.override.md instead of AGENTS.md when it has content,
    // which silently drops the Riggverk base block.
    let override_path = codex_dir.join("AGENTS.override.md");
    if std::fs::read(&override_path)
        .is_ok_and(|content| content.iter().any(|byte| !byte.is_ascii_whitespace()))
    {
        has_warn = true;
        let detail = format!(
            "{} exists and replaces AGENTS.md; the Riggverk base block is not loaded until it is removed or emptied",
            override_path.display()
        );
        checks.push(CodexRuntimeCheck {
            id: "rules_override".into(),
            label: "AGENTS.override.md replaces AGENTS.md".into(),
            status: "warn".into(),
            detail: detail.clone(),
        });
        warnings.push(detail);
    }

    let (skills_root, old_skills_root) = codex_skill_roots(home_dir);
    let skills_target_root = skills_root.path(home_dir).unwrap_or_default();
    let mut skills_synced_count = 0usize;
    let mut skills_missing_count = 0usize;
    let mut skills_diverged_count = 0usize;
    let mut skills_expected_count = 0usize;
    let mut skills_source_invalid = false;
    let skills_status = match bundled_root
        .ok_or_else(|| "the bundled skills are not available".to_string())
        .and_then(|bundle| skill_files_status(bundle, home_dir, &[skills_root]))
    {
        Ok(status) => {
            skills_expected_count = status.expected;
            skills_synced_count = status.synced;
            skills_missing_count = status.missing;
            skills_diverged_count = status.diverged;
            if status.missing > 0 || status.diverged > 0 {
                has_warn = true;
            }
            if status.expected == 0 {
                has_fail = true;
            }
            match status.label() {
                "synced" => "synced".to_string(),
                "missing" => "missing".to_string(),
                _ => "diverged".to_string(),
            }
        }
        Err(detail) => {
            skills_source_invalid = true;
            has_fail = true;
            warnings.push(detail);
            "missing".into()
        }
    };
    checks.push(CodexRuntimeCheck {
        id: "skills".into(),
        label: format!("Global skills ({})", skills_root.display()),
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

    // Copies in the folder older versions installed into: Codex reads that folder too, so a copy
    // there is a second one of the skill until the next update moves it.
    let old_skills_path = old_skills_root
        .path(home_dir)
        .ok()
        .filter(|path| *path != skills_target_root);
    let old_copies = old_skills_path
        .as_ref()
        .zip(bundled_root)
        .and_then(|(_, bundle)| old_skill_copies(bundle, home_dir, old_skills_root).ok())
        .unwrap_or_default();
    if let Some(path) = old_skills_path.as_ref().filter(|_| old_copies.owned > 0) {
        has_warn = true;
        warnings.push(format!(
            "{} skill(s) are still installed in {}; the next update moves them to {}",
            old_copies.owned,
            path.display(),
            skills_target_root.display()
        ));
    }
    if let Some(path) = old_skills_path.as_ref().filter(|_| old_copies.edited > 0) {
        has_warn = true;
        warnings.push(format!(
            "{} edited skill(s) in {} are kept; Codex lists them twice until you move or delete them",
            old_copies.edited,
            path.display()
        ));
    }

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
    // The template with the keys the user keeps substituted: what the installed config is held to.
    let effective_template =
        template_config
            .as_ref()
            .zip(installed_config.as_ref())
            .map(|(template, installed)| {
                crate::codex_config_keep::assess(workspace_root, home_dir, installed, template)
            });
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
        &effective_template
            .as_ref()
            .expect("template config")
            .effective,
    ) {
        "synced".into()
    } else {
        has_warn = true;
        "diverged".into()
    };
    let config_kept: Vec<String> = effective_template
        .as_ref()
        .map(|assessment| assessment.active.keys().cloned().collect())
        .unwrap_or_default();

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

    if template_config.is_some() {
        checks.push(CodexRuntimeCheck {
            id: "template_config_valid".into(),
            label: "Template config is valid TOML".into(),
            status: "pass".into(),
            detail: "parsed successfully".into(),
        });
        let managed_match = installed_config
            .as_ref()
            .zip(effective_template.as_ref())
            .map(|(installed, assessment)| {
                managed_codex_keys_match(installed, &assessment.effective)
            })
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
                if config_kept.is_empty() {
                    "managed routing defaults match bundled workspace (personality/MCP preserved)"
                        .into()
                } else {
                    format!(
                        "managed routing defaults match bundled workspace, except {} you keep (personality/MCP preserved)",
                        config_kept.join(", ")
                    )
                }
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
        legacy_skills_path: old_skills_path
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        legacy_skills_migratable_count: old_copies.owned,
        legacy_skills_conflict_count: old_copies.edited,
        agents_status,
        bundled_agent_count,
        installed_bundled_agent_count: installed_bundled_count,
        extra_installed_agent_count,
        agent_mismatches,
        config_status,
        config_kept,
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
    let home_dir = crate::cursor_profile_paths::resolve_user_home()?;
    // Only the record of the keys the user keeps lives there; no workspace folder, no choices.
    let workspace_root = super::workspace::setup_workspace_target_path().ok();
    Ok(compute_health(&home_dir, workspace_root.as_deref()))
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
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
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

    #[test]
    fn rules_in_a_managed_block_with_user_text_are_synced() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe { std::env::remove_var("CODEX_HOME") };
        let ws = temp_root("rules-block");
        let home = temp_root("rules-block-home");
        write_file(&ws.join("templates/sync/codex-rules.md"), "# rules\n");
        write_file(
            &home.join(".codex/AGENTS.md"),
            &format!(
                "mine\n{}after\n",
                crate::rules_block::render_new("# rules\n")
            ),
        );
        let health = health_of(&ws, &home);
        assert_eq!(health.rules_status, "synced");

        write_file(
            &home.join(".codex/AGENTS.md"),
            &crate::rules_block::render_new("# older rules\n"),
        );
        assert_eq!(health_of(&ws, &home).rules_status, "diverged");
        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn a_non_empty_agents_override_is_reported_because_it_replaces_agents_md() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe { std::env::remove_var("CODEX_HOME") };
        let ws = temp_root("override");
        let home = temp_root("override-home");
        add_rules(&ws, &home);

        let clean = health_of(&ws, &home);
        assert!(clean
            .checks
            .iter()
            .all(|check| check.id != "rules_override"));

        write_file(&home.join(".codex/AGENTS.override.md"), "\n  \n");
        let blank = health_of(&ws, &home);
        assert!(blank
            .checks
            .iter()
            .all(|check| check.id != "rules_override"));

        write_file(&home.join(".codex/AGENTS.override.md"), "# my override\n");
        let health = health_of(&ws, &home);
        let check = health
            .checks
            .iter()
            .find(|check| check.id == "rules_override")
            .expect("override check");
        assert_eq!(check.status, "warn");
        assert!(
            check.detail.contains("replaces AGENTS.md"),
            "{}",
            check.detail
        );
        assert!(health
            .warnings
            .iter()
            .any(|warning| warning.contains("AGENTS.override.md")));
        assert_ne!(health.status, "synced");
        cleanup(&ws);
        cleanup(&home);
    }

    /// Health with the fixture workspace standing in for the bundled install sources.
    fn health_of(ws: &Path, home: &Path) -> CodexRuntimeHealth {
        compute_health_with_bundle(Some(ws), None, home)
    }

    #[test]
    fn health_uses_bundled_config_rules_and_agents_after_workspace_edits() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let bundle = bundled_workspace_root();
        let home = temp_root("codex-baseline-home");
        let ws = temp_root("codex-runtime-baseline");
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
            std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
        }
        let health = || get_codex_runtime_health().expect("codex health");
        for (source, dest) in [
            ("templates/sync/codex-rules.md", ".codex/AGENTS.md"),
            ("templates/codex/config.toml", ".codex/config.toml"),
        ] {
            write_file(
                &home.join(dest),
                &fs::read_to_string(bundle.join(source)).unwrap(),
            );
        }
        for name in list_bundled_codex_agents(&bundle.join("templates/codex/agents")) {
            write_file(
                &home.join(".codex/agents").join(&name),
                &fs::read_to_string(bundle.join("templates/codex/agents").join(name)).unwrap(),
            );
        }
        // No workspace folder at all: health needs only the bundle.
        cleanup(&ws);
        assert_eq!(health().config_status, "synced");
        write_file(&ws.join("templates/sync/codex-rules.md"), "workspace rules");
        write_file(
            &ws.join("templates/codex/config.toml"),
            "approval_policy = \"never\"\n",
        );
        write_file(
            &ws.join("templates/codex/agents/repo_scout.toml"),
            "name = \"workspace\"\n",
        );

        let edited = health();
        assert_eq!(edited.config_status, "synced");
        assert_eq!(edited.rules_status, "synced");
        assert_eq!(edited.agents_status, "synced");
        write_file(
            &home.join(".codex/config.toml"),
            "approval_policy = \"never\"\n",
        );
        assert_eq!(health().config_status, "diverged");
        cleanup(&ws);
        cleanup(&home);
    }

    /// Installs a skill the way an update does: into the folder Codex reads, `~/.agents/skills`.
    fn add_skill(ws: &Path, home: &Path, name: &str) {
        let canonical = crate::test_env::write_canonical_skill(ws, None, name, "canonical");
        write_file(
            &home.join(format!(".agents/skills/{name}/SKILL.md")),
            &fs::read_to_string(canonical).expect("read canonical skill"),
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
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
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

        let health = health_of(&ws, &home);
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
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
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
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "danger-full-access"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"#,
        );
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = health_of(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.config_status, "diverged");
        assert_eq!(health.status, "diverged");
    }

    #[test]
    fn test_diverged_when_app_default_approval_differs() {
        let installed = toml::from_str::<toml::Value>(
            "model = \"gpt-6.1-sol\"\nmodel_reasoning_effort = \"xhigh\"\napproval_policy = \"on-request\"\napprovals_reviewer = \"user\"\nsandbox_mode = \"workspace-write\"\napps._default.approvals_reviewer = \"auto_review\"\napps._default.default_tools_approval_mode = \"prompt\"\n",
        )
        .expect("installed");
        let template = toml::from_str::<toml::Value>(managed_codex_config()).expect("template");
        assert!(!managed_codex_keys_match(&installed, &template));
    }

    fn without_model_keys(config: &str) -> String {
        config
            .lines()
            .filter(|line| !line.starts_with("model"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn test_user_model_and_effort_are_preserved_and_not_drift() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let ws = temp_root("cfg-user-model");
        let home = temp_root("cfg-user-model-home");
        add_rules(&ws, &home);
        write_file(
            &ws.join("templates/codex/config.toml"),
            managed_codex_config(),
        );
        write_file(
            &home.join(".codex/config.toml"),
            &managed_codex_config()
                .replace("gpt-6.1-sol", "gpt-5.4")
                .replace("xhigh", "low"),
        );
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = health_of(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.config_status, "synced");
        assert_eq!(health.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(health.model_reasoning_effort.as_deref(), Some("low"));
    }

    #[test]
    fn test_absent_model_or_effort_reads_as_drift() {
        let template = toml::from_str::<toml::Value>(managed_codex_config()).expect("template");
        let no_model = toml::from_str::<toml::Value>(&without_model_keys(managed_codex_config()))
            .expect("installed");
        assert!(!managed_codex_keys_match(&no_model, &template));

        let only_model = toml::from_str::<toml::Value>(&format!(
            "model = \"gpt-5.4\"\n{}",
            without_model_keys(managed_codex_config())
        ))
        .expect("installed");
        assert!(
            !managed_codex_keys_match(&only_model, &template),
            "an absent reasoning effort is still seeded from the template"
        );
    }

    #[test]
    fn test_template_without_model_keys_never_reports_them_as_drift() {
        let template = toml::from_str::<toml::Value>(&without_model_keys(managed_codex_config()))
            .expect("template");
        let installed = toml::from_str::<toml::Value>(&without_model_keys(managed_codex_config()))
            .expect("installed");
        assert!(managed_codex_keys_match(&installed, &template));
    }

    #[test]
    fn test_create_only_keys_are_not_part_of_the_managed_projection() {
        let config = toml::from_str::<toml::Value>(managed_codex_config()).expect("config");
        let projection = extract_managed_codex_config(&config);
        let table = projection.as_table().expect("projection table");
        assert!(!table.contains_key("model"));
        assert!(!table.contains_key("model_reasoning_effort"));
        assert_eq!(
            table.get("approval_policy").and_then(|v| v.as_str()),
            Some("on-request")
        );
    }

    fn bundled_workspace_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    #[test]
    fn test_render_projection_keeps_user_model_and_updates_enforced_keys() {
        let dir = temp_root("render-user-model");
        let dest = dir.join("config.toml");
        write_file(
            &dest,
            "model = \"gpt-5.4\"\nmodel_reasoning_effort = \"low\"\napproval_policy = \"never\"\napprovals_reviewer = \"user\"\nsandbox_mode = \"workspace-write\"\napps._default.approvals_reviewer = \"user\"\napps._default.default_tools_approval_mode = \"prompt\"\n",
        );
        let source = dir.join("template.toml");
        write_file(&source, managed_codex_config());

        let rendered =
            render_codex_config_managed_projection(&bundled_workspace_root(), &dest, &source);
        cleanup(&dir);
        let rendered = rendered.expect("render");

        let parsed = rendered.parse::<toml::Value>().expect("valid toml");
        assert_eq!(parsed["model"].as_str(), Some("gpt-5.4"));
        assert_eq!(parsed["model_reasoning_effort"].as_str(), Some("low"));
        assert_eq!(parsed["approval_policy"].as_str(), Some("on-request"));
    }

    #[test]
    fn test_keepable_paths_are_exactly_the_enforced_keys() {
        let mut enforced: Vec<String> = ENFORCED_TOP_LEVEL_KEYS
            .iter()
            .map(|key| key.to_string())
            .chain(
                MANAGED_APP_DEFAULT_KEYS
                    .iter()
                    .map(|key| format!("apps._default.{key}")),
            )
            .collect();
        let mut keepable: Vec<String> = crate::config_preferences::CODEX_KEEPABLE_PATHS
            .iter()
            .map(|path| path.to_string())
            .collect();
        enforced.sort();
        keepable.sort();
        assert_eq!(keepable, enforced);
    }

    /// A temp home and workspace folder for the kept keys, `CODEX_HOME` unset.
    fn kept_env(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let bundle = temp_root(&format!("{label}-bundle"));
        let runtime = temp_root(&format!("{label}-runtime"));
        let home = temp_root(&format!("{label}-home"));
        add_rules(&bundle, &home);
        write_file(
            &bundle.join("templates/codex/config.toml"),
            managed_codex_config(),
        );
        add_agent(&bundle, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&bundle, &home, "diagnose");
        (bundle, runtime, home)
    }

    fn keep_in(runtime: &Path, home: &Path, pairs: &[(&str, &str)]) {
        crate::config_preferences::set_codex_config(
            runtime,
            Some(crate::config_preferences::CodexConfigChoice {
                dest: crate::codex_config_keep::dest_label(runtime, home).expect("dest"),
                kept: pairs
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
            }),
        )
        .expect("record the kept keys");
    }

    const REVIEWER_AUTO_REVIEW: &str = r#"
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"#;

    #[test]
    fn test_a_kept_key_reads_as_synced_and_the_other_keys_stay_enforced() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let (bundle, runtime, home) = kept_env("kept-health");
        write_file(&home.join(".codex/config.toml"), REVIEWER_AUTO_REVIEW);

        let health_with =
            |runtime: Option<&Path>| compute_health_with_bundle(Some(&bundle), runtime, &home);
        assert_eq!(health_with(Some(&runtime)).config_status, "diverged");

        keep_in(&runtime, &home, &[("approvals_reviewer", "auto_review")]);
        let kept = health_with(Some(&runtime));
        assert_eq!(kept.config_status, "synced");
        assert_eq!(kept.config_kept, vec!["approvals_reviewer".to_string()]);
        let check = kept
            .checks
            .iter()
            .find(|c| c.id == "managed_config_match")
            .expect("managed check");
        assert_eq!(check.status, "pass");
        assert!(
            check.detail.contains("approvals_reviewer"),
            "{}",
            check.detail
        );
        // Without the workspace folder nothing is kept.
        assert_eq!(health_with(None).config_status, "diverged");

        // Another enforced key that differs still diverges.
        write_file(
            &home.join(".codex/config.toml"),
            &REVIEWER_AUTO_REVIEW.replace("workspace-write", "danger-full-access"),
        );
        assert_eq!(health_with(Some(&runtime)).config_status, "diverged");

        // The kept value changed again: the entry is inert.
        write_file(
            &home.join(".codex/config.toml"),
            &REVIEWER_AUTO_REVIEW.replace("auto_review", "never"),
        );
        let changed = health_with(Some(&runtime));
        assert_eq!(changed.config_status, "diverged");
        assert!(changed.config_kept.is_empty());

        for dir in [&bundle, &runtime, &home] {
            cleanup(dir);
        }
    }

    #[test]
    fn test_render_for_apply_updates_other_keys_and_never_writes_over_a_kept_one() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe { std::env::remove_var("CODEX_HOME") };
        let (bundle, runtime, home) = kept_env("kept-render");
        let dest = home.join(".codex/config.toml");
        let source = bundle.join("templates/codex/config.toml");
        write_file(
            &dest,
            &format!(
                "{}\n# my own note\n[mcp_servers.demo]\ncommand = \"demo\"\n",
                REVIEWER_AUTO_REVIEW.replace("workspace-write", "read-only")
            ),
        );

        // Not kept: the template's reviewer comes back.
        let plain = render_codex_config_for_apply(
            &bundled_workspace_root(),
            &runtime,
            &home,
            &dest,
            &source,
        )
        .expect("render");
        let plain = plain.parse::<toml::Value>().expect("toml");
        assert_eq!(plain["approvals_reviewer"].as_str(), Some("user"));
        assert_eq!(plain["sandbox_mode"].as_str(), Some("workspace-write"));

        keep_in(&runtime, &home, &[("approvals_reviewer", "auto_review")]);
        let rendered = render_codex_config_for_apply(
            &bundled_workspace_root(),
            &runtime,
            &home,
            &dest,
            &source,
        )
        .expect("render");
        let parsed = rendered.parse::<toml::Value>().expect("toml");
        assert_eq!(parsed["approvals_reviewer"].as_str(), Some("auto_review"));
        assert_eq!(parsed["sandbox_mode"].as_str(), Some("workspace-write"));
        assert_eq!(
            parsed["apps"]["_default"]["approvals_reviewer"].as_str(),
            Some("user")
        );
        assert!(rendered.contains("# my own note"), "{rendered}");
        assert_eq!(
            parsed["mcp_servers"]["demo"]["command"].as_str(),
            Some("demo")
        );

        for dir in [&bundle, &runtime, &home] {
            cleanup(dir);
        }
    }

    #[test]
    fn test_render_projection_seeds_absent_model_and_effort() {
        let dir = temp_root("render-absent-model");
        let dest = dir.join("config.toml");
        write_file(
            &dest,
            "approval_policy = \"never\"\n\n[mcp_servers.custom]\ncommand = \"echo\"\n",
        );
        let source = dir.join("template.toml");
        write_file(&source, managed_codex_config());

        let rendered =
            render_codex_config_managed_projection(&bundled_workspace_root(), &dest, &source);
        cleanup(&dir);
        let rendered = rendered.expect("render");

        let parsed = rendered.parse::<toml::Value>().expect("valid toml");
        assert_eq!(parsed["model"].as_str(), Some("gpt-6.1-sol"));
        assert_eq!(parsed["model_reasoning_effort"].as_str(), Some("xhigh"));
        assert_eq!(parsed["approval_policy"].as_str(), Some("on-request"));
        assert_eq!(
            parsed["mcp_servers"]["custom"]["command"].as_str(),
            Some("echo")
        );
    }

    #[test]
    fn test_diverged_when_legacy_profile_scheme_remains() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
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

        let health = health_of(&ws, &home);
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
    fn test_codex_skills_synced_against_the_canonical_skill() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let ws = temp_root("skill-canonical");
        let home = temp_root("skill-canonical-home");
        add_rules(&ws, &home);
        add_config(&ws, &home, "");
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");

        let health = health_of(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.skills_status, "synced");
        assert_eq!(health.skills_synced_count, 1);
        assert_eq!(health.skills_expected_count, 1);
    }

    #[test]
    fn test_codex_skills_diverge_when_installed_content_differs_from_the_canonical_skill() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let ws = temp_root("skill-diverged");
        let home = temp_root("skill-diverged-home");
        add_rules(&ws, &home);
        add_config(&ws, &home, "");
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");
        write_file(
            &home.join(".agents/skills/diagnose/SKILL.md"),
            "---\nname: diagnose\ndescription: test skill\ntargets: codex\n---\n# an older per-harness copy\n",
        );

        let health = health_of(&ws, &home);
        cleanup(&ws);
        cleanup(&home);

        assert_eq!(health.skills_status, "diverged");
        assert_eq!(health.skills_synced_count, 0);
        assert_eq!(health.skills_diverged_count, 1);
    }

    fn healthy_codex_fixture(label: &str) -> (PathBuf, PathBuf) {
        let ws = temp_root(label);
        let home = temp_root(&format!("{label}-home"));
        add_rules(&ws, &home);
        add_config(&ws, &home, "");
        add_agent(&ws, &home, "repo_scout.toml", "name = \"repo_scout\"\n");
        add_skill(&ws, &home, "diagnose");
        add_skill(&ws, &home, "tdd");
        (ws, home)
    }

    #[test]
    fn codex_skills_are_checked_in_agents_skills_and_old_codex_home_copies_are_reported() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let (ws, home) = healthy_codex_fixture("skill-old-copies");

        let clean = health_of(&ws, &home);
        assert_eq!(clean.skills_status, "synced");
        assert_eq!(clean.status, "synced", "{:?}", clean.warnings);
        let check = clean
            .checks
            .iter()
            .find(|check| check.id == "skills")
            .unwrap();
        assert_eq!(check.label, "Global skills (~/.agents/skills)");
        assert!(check.detail.contains(".agents/skills"), "{}", check.detail);
        assert_eq!(clean.legacy_skills_migratable_count, 0);

        // An older version's copies: one still what the app shipped, one edited.
        let canonical = fs::read_to_string(ws.join("skills/diagnose/SKILL.md")).unwrap();
        write_file(&home.join(".codex/skills/diagnose/SKILL.md"), &canonical);
        write_file(&home.join(".codex/skills/tdd/SKILL.md"), "my own tdd\n");
        write_file(
            &home.join(".codex/skills/.system/imagegen/SKILL.md"),
            "codex\n",
        );
        let with_old = health_of(&ws, &home);
        assert_eq!(
            with_old.skills_status, "synced",
            "the old folder is not the one checked"
        );
        assert_eq!(
            with_old.legacy_skills_path,
            home.join(".codex/skills").to_string_lossy()
        );
        assert_eq!(with_old.legacy_skills_migratable_count, 1);
        assert_eq!(with_old.legacy_skills_conflict_count, 1);
        assert_eq!(with_old.status, "diverged");
        assert!(with_old
            .warnings
            .iter()
            .any(|warning| warning.contains("moves them") && warning.contains(".agents/skills")));
        assert!(with_old
            .warnings
            .iter()
            .any(|warning| warning.contains("lists them twice")));
        cleanup(&ws);
        cleanup(&home);
    }

    #[test]
    fn a_custom_codex_home_keeps_its_skills_inside_it_and_reports_agents_skills_as_old() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let ws = temp_root("skill-custom-home");
        let home = temp_root("skill-custom-home-home");
        let isolated = home.join("isolated-codex");
        unsafe {
            std::env::set_var("CODEX_HOME", &isolated);
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        write_file(&ws.join("templates/sync/codex-rules.md"), "# rules");
        write_file(&isolated.join("AGENTS.md"), "# rules");
        let canonical = crate::test_env::write_canonical_skill(&ws, None, "diagnose", "canonical");
        let text = fs::read_to_string(canonical).unwrap();
        write_file(&isolated.join("skills/diagnose/SKILL.md"), &text);

        let health = health_of(&ws, &home);
        assert_eq!(health.skills_status, "synced");
        let check = health
            .checks
            .iter()
            .find(|check| check.id == "skills")
            .unwrap();
        assert_eq!(check.label, "Global skills ($CODEX_HOME/skills)");
        assert!(check.detail.contains("isolated-codex"), "{}", check.detail);
        assert_eq!(
            health.legacy_skills_path,
            home.join(".agents/skills").to_string_lossy()
        );

        // Without a readable bundle nothing is reported as installed.
        let unreadable = compute_health_with_bundle(None, None, &home);
        assert_eq!(unreadable.skills_status, "missing");
        assert_eq!(unreadable.skills_expected_count, 0);
        cleanup(&ws);
        cleanup(&home);
    }
}
