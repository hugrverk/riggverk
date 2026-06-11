use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

use super::skills::discover_skills;
use super::status::file_eq;
use crate::agent_skill_targets::{codex_global_skills_dest, codex_home, codex_legacy_skills_dest};
use crate::codex_legacy_migration::preview_migration;

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
    pub profile: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox_mode: Option<String>,
    pub checks: Vec<CodexRuntimeCheck>,
    pub warnings: Vec<String>,
    pub summary: String,
    pub next_action: String,
}

const MANAGED_TOP_LEVEL_KEYS: &[&str] = &["profile"];
const MANAGED_PROFILES: &[&str] = &["safe", "workspace-write"];
const MANAGED_PROFILE_FIELDS: &[&str] = &["approval_policy", "sandbox_mode"];

fn list_bundled_codex_agents(agents_dir: &Path) -> Vec<String> {
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
        if path.extension().map(|e| e == "toml").unwrap_or(false) {
            names.push(name_str.into_owned());
        }
    }
    names.sort();
    names
}

fn parse_codex_config(path: &Path) -> Option<toml::Value> {
    let content = std::fs::read_to_string(path).ok()?;
    toml::from_str(&content).ok()
}

pub(crate) fn extract_managed_codex_config(config: &toml::Value) -> toml::Value {
    let mut managed = toml::map::Map::new();
    if let Some(table) = config.as_table() {
        for key in MANAGED_TOP_LEVEL_KEYS {
            if let Some(value) = table.get(*key) {
                managed.insert(key.to_string(), value.clone());
            }
        }
        if let Some(profiles) = table.get("profiles").and_then(|v| v.as_table()) {
            let mut managed_profiles = toml::map::Map::new();
            for profile_name in MANAGED_PROFILES {
                let Some(profile) = profiles.get(*profile_name).and_then(|v| v.as_table()) else {
                    continue;
                };
                let mut managed_profile = toml::map::Map::new();
                for field in MANAGED_PROFILE_FIELDS {
                    if let Some(value) = profile.get(*field) {
                        managed_profile.insert(field.to_string(), value.clone());
                    }
                }
                if !managed_profile.is_empty() {
                    managed_profiles.insert(
                        profile_name.to_string(),
                        toml::Value::Table(managed_profile),
                    );
                }
            }
            if !managed_profiles.is_empty() {
                managed.insert("profiles".to_string(), toml::Value::Table(managed_profiles));
            }
        }
    }
    toml::Value::Table(managed)
}

pub(crate) fn managed_codex_keys_match(installed: &toml::Value, managed: &toml::Value) -> bool {
    extract_managed_codex_config(installed) == extract_managed_codex_config(managed)
}

/// Restore managed Codex config fields from backup into the installed file via the
/// line-preserving Python merge owner. Refuses on malformed TOML or ambiguous structure.
pub(crate) fn rollback_codex_config_managed_projection(
    workspace_root: &Path,
    dest: &Path,
    backup: &Path,
) -> Result<(), String> {
    let script = workspace_root.join("scripts/merge-codex-config.py");
    if !script.is_file() {
        return Err(format!("missing Codex merge script: {}", script.display()));
    }
    let script_str = super::workspace::path_arg(&script)?;
    let dest_str = super::workspace::path_arg(dest)?;
    let backup_str = super::workspace::path_arg(backup)?;
    let (ok, _stdout, stderr, code) = super::process::run_cmd(
        "python3",
        &[&script_str, &dest_str, &backup_str, "--rollback-managed"],
        workspace_root,
    );
    if !ok {
        return Err(format!(
            "codex managed rollback failed (exit {:?}): {}",
            code,
            stderr.trim()
        ));
    }
    Ok(())
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
    let legacy_skills_path = codex_legacy_skills_dest(home_dir);

    let rules_source_path_str = rules_source_path.to_string_lossy().into_owned();
    let rules_installed_path_str = rules_installed_path.to_string_lossy().into_owned();
    let legacy_skills_path_str = legacy_skills_path.to_string_lossy().into_owned();
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
    let skills_status = match discover_skills(workspace_root) {
        Ok(summaries) => {
            for summary in summaries {
                let supported = summary.targets.is_empty()
                    || summary.targets.iter().any(|target| target == "codex");
                if !supported {
                    continue;
                }
                skills_expected_count += 1;
                let source_md = workspace_root.join(&summary.path);
                let target_md = skills_target_root.join(&summary.name).join("SKILL.md");
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
                        has_fail = true;
                    }
                }
            }
            if skills_expected_count == 0 {
                has_fail = true;
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
        label: "Global skills (~/.agents/skills)".into(),
        status: if skills_status == "synced" {
            "pass".into()
        } else if skills_status == "missing" && skills_expected_count == 0 {
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

    let legacy_preview = preview_migration(home_dir).unwrap_or_else(|error| {
        warnings.push(error);
        crate::codex_legacy_migration::CodexLegacyMigrationPreview {
            legacy_root: legacy_skills_path.to_string_lossy().into_owned(),
            target_root: skills_target_root.to_string_lossy().into_owned(),
            migratable_count: 0,
            already_migrated_count: 0,
            conflict_count: 0,
            items: Vec::new(),
        }
    });
    let legacy_skills_migratable_count = legacy_preview.migratable_count;
    let legacy_skills_conflict_count = legacy_preview.conflict_count;
    if legacy_skills_migratable_count > 0 || legacy_skills_conflict_count > 0 {
        has_warn = true;
    }
    checks.push(CodexRuntimeCheck {
        id: "legacy_skills".into(),
        label: "Legacy ~/.codex/skills".into(),
        status: if legacy_skills_conflict_count > 0 || legacy_skills_migratable_count > 0 {
            "warn".into()
        } else {
            "pass".into()
        },
        detail: format!(
            "{} migratable, {} conflicts at {}",
            legacy_skills_migratable_count, legacy_skills_conflict_count, legacy_skills_path_str
        ),
    });

    let bundled_agents = list_bundled_codex_agents(&agents_source_dir);
    let bundled_agent_count = bundled_agents.len();
    let bundled_set: BTreeSet<String> = bundled_agents.iter().cloned().collect();
    let mut installed_bundled_count = 0usize;
    let mut installed_agent_names: BTreeSet<String> = BTreeSet::new();
    if agents_target_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&agents_target_dir) {
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

    let mut profile = None;
    let mut approval_policy = None;
    let mut sandbox_mode = None;
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
        profile = extract_string_field(installed, &["profile"]);
        approval_policy = extract_string_field(installed, &["profiles", "safe", "approval_policy"]);
        sandbox_mode = extract_string_field(installed, &["profiles", "safe", "sandbox_mode"]);
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
            label: "Managed config sections match bundled workspace".into(),
            status: if managed_match {
                "pass".into()
            } else if installed_config.is_some() {
                "warn".into()
            } else {
                "fail".into()
            },
            detail: if managed_match {
                "managed sections match bundled workspace (user model/MCP preserved)".into()
            } else if installed_config.is_some() {
                "managed sections differ from bundled workspace".into()
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
        legacy_skills_path: legacy_skills_path_str,
        legacy_skills_migratable_count,
        legacy_skills_conflict_count,
        agents_status,
        bundled_agent_count,
        installed_bundled_agent_count: installed_bundled_count,
        extra_installed_agent_count,
        agent_mismatches,
        config_status,
        template_config_path: template_config_path_str,
        installed_config_path: installed_config_path_str,
        profile,
        approval_policy,
        sandbox_mode,
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
    use std::fs;
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

    fn add_rules(ws: &Path, home: &Path) {
        write_file(&ws.join("templates/sync/codex-rules.md"), "# rules");
        write_file(&home.join(".codex/AGENTS.md"), "# rules");
    }

    fn add_skill(ws: &Path, home: &Path, name: &str) {
        write_file(
            &ws.join(format!("skills/{name}/SKILL.md")),
            "---\nname: test\n---\n# skill\n",
        );
        write_file(
            &home.join(format!(".agents/skills/{name}/SKILL.md")),
            "---\nname: test\n---\n# skill\n",
        );
    }

    fn add_config(ws: &Path, home: &Path, installed_extra: &str) {
        write_file(
            &ws.join("templates/codex/config.toml"),
            r#"
profile = "safe"

[profiles.safe]
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.workspace-write]
approval_policy = "on-request"
sandbox_mode = "workspace-write"
"#,
        );
        write_file(
            &home.join(".codex/config.toml"),
            &format!(
                r#"
profile = "safe"

[profiles.safe]
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.workspace-write]
approval_policy = "on-request"
sandbox_mode = "workspace-write"
{installed_extra}
"#
            ),
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
    fn test_diverged_when_managed_profile_differs() {
        let ws = temp_root("cfg-div");
        let home = temp_root("cfg-div-home");
        add_rules(&ws, &home);
        write_file(
            &ws.join("templates/codex/config.toml"),
            r#"
profile = "safe"

[profiles.safe]
approval_policy = "on-request"
sandbox_mode = "workspace-write"
"#,
        );
        write_file(
            &home.join(".codex/config.toml"),
            r#"
profile = "safe"

[profiles.safe]
approval_policy = "never"
sandbox_mode = "workspace-write"
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
}
