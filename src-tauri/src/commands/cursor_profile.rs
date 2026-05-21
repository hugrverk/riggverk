use serde::Serialize;
use std::path::{Path, PathBuf};

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

fn mcp_status(root: &Path, warnings: &mut Vec<String>) -> String {
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
    "example-only".into()
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
pub fn get_cursor_profile_health() -> Result<CursorProfileHealth, String> {
    let root = workspace_root()?;
    let home = crate::agent_targets::home_dir()?;
    let mut warnings = Vec::new();
    let cursor = cursor_root(&root);

    let manifest_status = manifest_status(&root, &mut warnings);
    let user_rules_status = if cursor.join("user-rules.md").is_file() {
        "manual"
    } else {
        "template-missing"
    }
    .to_string();
    let (global_agents_status, global_agents_count, expected_global_agents_count) =
        sync_dir_status(&cursor.join("agents"), &home.join(".cursor/agents"), "md");

    let mcp_status = mcp_status(&root, &mut warnings);
    let (sandbox_status, sandbox_profiles_count) = sandbox_status(&root, &mut warnings);

    let status = if manifest_status == "missing" || expected_global_agents_count == 0 {
        "missing"
    } else if manifest_status != "valid" || sandbox_status == "partial" {
        "partial"
    } else if global_agents_status == "synced" && !mcp_status.ends_with("unsafe") {
        "synced"
    } else if global_agents_status == "missing" {
        "missing"
    } else {
        "diverged"
    }
    .to_string();

    let next_action = match status.as_str() {
        "synced" => "Cursor global profile is synced.",
        "missing" => "Sync global agents from Workspace.",
        "partial" => "Fix missing Cursor profile assets before syncing.",
        "diverged" => "Run diff global, then sync global agents.",
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
pub fn run_cursor_profile_action(action: String) -> Result<ActionResult, String> {
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
        "cursor_show_playwright_mcp" => args.push("--show-playwright-mcp".into()),
        "cursor_copy_playwright_mcp" => args.push("--copy-playwright-mcp".into()),
        "cursor_show_sandbox_safe" => args.extend(["--show-sandbox-profile".into(), "safe".into()]),
        "cursor_copy_sandbox_safe" => args.extend(["--copy-sandbox-profile".into(), "safe".into()]),
        "cursor_show_sandbox_playwright_safe" => {
            args.extend(["--show-sandbox-profile".into(), "playwright-safe".into()])
        }
        "cursor_copy_sandbox_playwright_safe" => {
            args.extend(["--copy-sandbox-profile".into(), "playwright-safe".into()])
        }
        "cursor_show_sandbox_playwright_full" => {
            args.extend(["--show-sandbox-profile".into(), "playwright-full".into()])
        }
        "cursor_copy_sandbox_playwright_full" => {
            args.extend(["--copy-sandbox-profile".into(), "playwright-full".into()])
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
            let health = get_cursor_profile_health()?;
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
