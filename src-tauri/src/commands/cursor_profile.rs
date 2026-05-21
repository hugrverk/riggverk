use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::agent_targets;

use super::content::safe_canonical_target;
use super::process::{run_cmd_owned, ActionResult};
use super::status::file_eq;
use super::workspace::{path_arg, workspace_root};

#[derive(Serialize)]
pub struct CursorProfileHealth {
    status: String,
    manifest_status: String,
    user_rules_status: String,
    global_agents_status: String,
    global_agents_count: usize,
    expected_global_agents_count: usize,
    project_target: Option<String>,
    project_agents_status: String,
    project_rules_status: String,
    project_skills_status: String,
    mcp_status: String,
    sandbox_status: String,
    sandbox_profiles_count: usize,
    warnings: Vec<String>,
    next_action: String,
}

fn cursor_root(root: &Path) -> PathBuf {
    root.join("templates/cursor")
}

fn list_files(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some(extension))
        .collect();
    files.sort();
    files
}

fn sync_dir_status(
    source_dir: &Path,
    target_dir: &Path,
    extension: &str,
) -> (String, usize, usize) {
    let sources = list_files(source_dir, extension);
    if sources.is_empty() {
        return ("missing".into(), 0, 0);
    }
    if !target_dir.exists() {
        return ("missing".into(), 0, sources.len());
    }

    let mut installed = 0;
    let mut missing = 0;
    let mut diverged = 0;
    for source in &sources {
        let Some(name) = source.file_name() else {
            diverged += 1;
            continue;
        };
        let target = target_dir.join(name);
        if !target.exists() {
            missing += 1;
        } else if file_eq(source, &target) {
            installed += 1;
        } else {
            diverged += 1;
        }
    }

    let status = if missing == 0 && diverged == 0 {
        "synced"
    } else if installed == 0 && diverged == 0 {
        "missing"
    } else if missing > 0 && diverged == 0 {
        "partial"
    } else {
        "diverged"
    };
    (status.into(), installed, sources.len())
}

fn has_project_marker(target: &Path) -> bool {
    [
        ".git",
        "package.json",
        "Cargo.toml",
        "composer.json",
        "pyproject.toml",
        "AGENTS.md",
        ".opencode",
        ".codex",
        ".cursor",
        "wp-content",
        "wordpress/wp-content",
    ]
    .iter()
    .any(|marker| target.join(marker).exists())
}

fn validate_project_target(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("project action requires an explicit target path".into());
    }
    let canonical = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|_| "project target does not exist".to_string())?;
    if !canonical.is_dir() {
        return Err("project target is not a directory".into());
    }
    let home = agent_targets::home_dir()?;
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let slash_tmp = PathBuf::from("/tmp")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    let broad_paths = [
        PathBuf::from("/"),
        PathBuf::from("/Users"),
        home.clone(),
        home.join("Projects"),
        temp_root,
        slash_tmp,
    ];
    if broad_paths.contains(&canonical) {
        return Err(format!(
            "refusing broad project target: {}",
            canonical.to_string_lossy()
        ));
    }
    if !has_project_marker(&canonical) {
        return Err("project target does not look like a project checkout".into());
    }
    Ok(canonical)
}

fn mcp_has_unsafe_literals(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    let auth_words = [
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
        "authorization",
        "cookie",
    ];
    if content.contains("sk-") || content.contains("Bearer ") || content.contains("Basic ") {
        return true;
    }
    for word in auth_words {
        if lower.contains(word) && !content.contains("${env:") {
            return true;
        }
    }
    false
}

fn mcp_status(root: &Path, project: Option<&Path>, warnings: &mut Vec<String>) -> String {
    let example = cursor_root(root).join("mcp/mcp.example.json");
    if !example.is_file() {
        return "example-missing".into();
    }
    match std::fs::read_to_string(&example) {
        Ok(content) => {
            if serde_json::from_str::<serde_json::Value>(&content).is_err() {
                warnings.push("Cursor MCP example is invalid JSON.".into());
                return "example-invalid".into();
            }
            if mcp_has_unsafe_literals(&content) {
                warnings.push("Cursor MCP example contains suspicious auth-like literals.".into());
                return "example-unsafe".into();
            }
        }
        Err(_) => return "example-unreadable".into(),
    }

    let Some(project) = project else {
        return "example-only".into();
    };
    let project_mcp = project.join(".cursor/mcp.json");
    if !project_mcp.exists() {
        return "project-absent".into();
    }
    match std::fs::read_to_string(project_mcp) {
        Ok(content) => {
            if serde_json::from_str::<serde_json::Value>(&content).is_err() {
                warnings.push("Project .cursor/mcp.json exists but is invalid JSON.".into());
                "project-invalid".into()
            } else if mcp_has_unsafe_literals(&content) {
                warnings.push(
                    "Project .cursor/mcp.json may contain hardcoded auth-like values.".into(),
                );
                "project-unsafe".into()
            } else {
                "project-present".into()
            }
        }
        Err(_) => "project-unreadable".into(),
    }
}

fn sandbox_status(root: &Path, warnings: &mut Vec<String>) -> (String, usize) {
    let dir = cursor_root(root).join("sandbox");
    if !dir.is_dir() {
        return ("missing".into(), 0);
    }
    let mut count = 0;
    for name in ["safe.json", "playwright-safe.json", "playwright-full.json"] {
        let path = dir.join(name);
        if !path.is_file() {
            warnings.push(format!("Cursor sandbox profile missing: {name}"));
            return ("partial".into(), count);
        }
        count += 1;
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => return ("unreadable".into(), count),
        };
        let parsed: serde_json::Value = match serde_json::from_str(&content) {
            Ok(parsed) => parsed,
            Err(_) => return ("invalid".into(), count),
        };
        if mcp_has_unsafe_literals(&content) {
            warnings.push(format!(
                "Cursor sandbox profile contains suspicious auth-like literals: {name}"
            ));
            return ("unsafe".into(), count);
        }
        let commands = parsed
            .get("command_allowlist")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for command in commands {
            let value = command.as_str().unwrap_or("").to_ascii_lowercase();
            if matches!(
                value.as_str(),
                "npx" | "npm" | "node" | "playwright" | "chrome" | "chromium"
            ) {
                warnings.push(format!(
                    "Cursor sandbox profile command-allowlists an MCP support command: {name}"
                ));
                return ("unsafe".into(), count);
            }
        }
    }
    ("templates".into(), count)
}

fn manifest_status(root: &Path, warnings: &mut Vec<String>) -> String {
    let path = cursor_root(root).join("manifest.json");
    if !path.exists() {
        return "missing".into();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return "unreadable".into(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(_) => return "invalid".into(),
    };
    for key in ["agents", "rules", "mcp_examples", "sandbox_profiles"] {
        if !parsed.get(key).is_some_and(|v| v.is_array()) {
            warnings.push(format!("Cursor manifest missing array: {key}"));
            return "partial".into();
        }
    }
    "valid".into()
}

#[tauri::command]
pub fn get_cursor_profile_health(
    project_target: Option<String>,
) -> Result<CursorProfileHealth, String> {
    let root = workspace_root()?;
    let home = agent_targets::home_dir()?;
    let mut warnings = Vec::new();
    let cursor = cursor_root(&root);
    let project = match project_target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => Some(validate_project_target(raw)?),
        None => None,
    };

    let manifest_status = manifest_status(&root, &mut warnings);
    let user_rules_status = if cursor.join("user-rules.md").is_file() {
        "manual"
    } else {
        "template-missing"
    }
    .to_string();
    let (global_agents_status, global_agents_count, expected_global_agents_count) =
        sync_dir_status(&cursor.join("agents"), &home.join(".cursor/agents"), "md");

    let (project_agents_status, project_rules_status, project_skills_status) =
        if let Some(project) = project.as_deref() {
            let (agents_status, _, _) = sync_dir_status(
                &cursor.join("agents"),
                &project.join(".cursor/agents"),
                "md",
            );
            let (rules_status, _, _) =
                sync_dir_status(&cursor.join("rules"), &project.join(".cursor/rules"), "mdc");
            let skills_status = if project.join(".cursor/skills").exists() {
                "present"
            } else {
                "absent"
            };
            (agents_status, rules_status, skills_status.into())
        } else {
            ("unknown".into(), "unknown".into(), "unknown".into())
        };

    let mcp_status = mcp_status(&root, project.as_deref(), &mut warnings);
    let (sandbox_status, sandbox_profiles_count) = sandbox_status(&root, &mut warnings);

    let status = if manifest_status == "missing" || expected_global_agents_count == 0 {
        "missing"
    } else if manifest_status != "valid" || sandbox_status == "partial" {
        "partial"
    } else if global_agents_status == "synced"
        && project.as_ref().is_none_or(|_| {
            project_agents_status == "synced"
                && project_rules_status == "synced"
                && !mcp_status.ends_with("unsafe")
        })
    {
        "synced"
    } else if global_agents_status == "missing" && project.is_none() {
        "missing"
    } else {
        "diverged"
    }
    .to_string();

    let next_action = match status.as_str() {
        "synced" => "Cursor profile is synced for the selected scope.",
        "missing" => "Sync global agents or choose an explicit project target.",
        "partial" => "Fix missing Cursor profile assets before syncing.",
        "diverged" => "Run a dry-run diff, then sync only the intended Cursor scope.",
        _ => "Refresh after checking the workspace templates.",
    }
    .to_string();

    Ok(CursorProfileHealth {
        status,
        manifest_status,
        user_rules_status,
        global_agents_status,
        global_agents_count,
        expected_global_agents_count,
        project_target: project.map(|p| p.to_string_lossy().into_owned()),
        project_agents_status,
        project_rules_status,
        project_skills_status,
        mcp_status,
        sandbox_status,
        sandbox_profiles_count,
        warnings,
        next_action,
    })
}

fn cursor_script_arg(root: &Path) -> Result<String, String> {
    let script = root.join("scripts/install-cursor-workspace.sh");
    let canonical = safe_canonical_target(root, &script)?;
    if !canonical.is_file() {
        return Err("workspace script not found: scripts/install-cursor-workspace.sh".into());
    }
    path_arg(&canonical)
}

#[tauri::command]
pub fn run_cursor_profile_action(
    action: String,
    project_target: Option<String>,
) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let script = cursor_script_arg(&root)?;
    let mut args = vec![script];

    match action.as_str() {
        "cursor_diff_global_agents" => args.extend(["--quiet".into(), "--global-agents".into()]),
        "cursor_sync_global_agents" => {
            args.extend(["--quiet".into(), "--apply".into(), "--global-agents".into()])
        }
        "cursor_show_user_rules" => args.push("--show-user-rules".into()),
        "cursor_copy_user_rules" => args.push("--copy-user-rules".into()),
        "cursor_open_settings" => args.push("--open-cursor-settings".into()),
        "cursor_diff_project" | "cursor_sync_project" => {
            let raw = project_target
                .as_deref()
                .ok_or_else(|| "project action requires an explicit target path".to_string())?;
            let target = validate_project_target(raw)?;
            args.push("--quiet".into());
            if action == "cursor_sync_project" {
                args.push("--apply".into());
            }
            args.push("--project".into());
            args.push("--target".into());
            args.push(path_arg(&target)?);
        }
        "cursor_validate_profile" => {
            let manifest = cursor_root(&root).join("manifest.json");
            if !manifest.is_file() {
                return Ok(ActionResult::new(
                    false,
                    action,
                    String::new(),
                    "Cursor manifest missing.\n".into(),
                    Some(1),
                ));
            }
            let health = get_cursor_profile_health(project_target)?;
            let ok = matches!(health.status.as_str(), "synced" | "diverged" | "missing");
            return Ok(ActionResult::new(
                ok,
                action,
                format!(
                    "manifest: {}\nglobal agents: {}/{} {}\nuser rules: {}\nmcp: {}\nsandbox profiles: {} {}\n",
                    health.manifest_status,
                    health.global_agents_count,
                    health.expected_global_agents_count,
                    health.global_agents_status,
                    health.user_rules_status,
                    health.mcp_status,
                    health.sandbox_profiles_count,
                    health.sandbox_status
                ),
                health.warnings.join("\n"),
                if ok { Some(0) } else { Some(1) },
            ));
        }
        _ => return Err(format!("unknown Cursor action: {action}")),
    }

    let (ok, out, err, code) = run_cmd_owned("bash", &args, &root);
    Ok(ActionResult::new(ok, action, out, err, code))
}

#[cfg(test)]
mod tests {
    use super::validate_project_target;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn project_target_rejects_unmarked_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("cursor-profile-unmarked-{nonce}"));
        fs::create_dir_all(&dir).expect("mkdir");
        let result = validate_project_target(dir.to_str().expect("utf8"));
        assert!(result.is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
