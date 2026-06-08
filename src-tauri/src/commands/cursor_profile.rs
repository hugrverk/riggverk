use serde::Serialize;
use std::path::{Path, PathBuf};

use super::content::safe_canonical_target;
use super::process::{run_cmd_owned_env, ActionResult};
use super::status::file_eq;
use super::workspace::workspace_root;
use crate::cursor_profile_ops::{
    legacy_permission_cleanup_status, run_global_agents_only, run_global_profile,
    validate_global_profile, LegacyPermissionCleanupStatus,
};
use crate::cursor_profile_paths::{
    cursor_profile_env_pairs, cursor_profile_root_display, resolve_cursor_profile_paths,
    CursorProfilePaths,
};
use crate::shell_runtime::{path_arg_for_bash, resolve_bash};

#[derive(Serialize)]
pub struct CursorProfileHealth {
    status: String,
    profile_root: String,
    profile_root_source: String,
    workspace_resources_status: String,
    manifest_status: String,
    user_rules_status: String,
    global_agents_status: String,
    global_agents_count: usize,
    expected_global_agents_count: usize,
    global_skills_status: String,
    global_skills_count: usize,
    expected_global_skills_count: usize,
    mcp_status: String,
    legacy_permission_cleanup_status: String,
    warnings: Vec<String>,
    next_action: String,
}

pub(crate) fn cursor_root(root: &Path) -> PathBuf {
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

pub(crate) fn sync_dir_status(
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

pub(crate) fn sync_skill_dirs_status(
    source_root: &Path,
    target_root: &Path,
    skill_names: &[String],
) -> (String, usize, usize) {
    if skill_names.is_empty() {
        return ("missing".into(), 0, 0);
    }
    if !target_root.exists() {
        return ("missing".into(), 0, skill_names.len());
    }
    let mut installed = 0;
    let mut missing = 0;
    let mut diverged = 0;
    for name in skill_names {
        let source = source_root.join(name).join("SKILL.md");
        let target = target_root.join(name).join("SKILL.md");
        if !source.is_file() {
            diverged += 1;
            continue;
        }
        if !target.is_file() {
            missing += 1;
        } else if file_eq(&source, &target) {
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
    (status.into(), installed, skill_names.len())
}

const DOC_ONLY_KEYS: &[&str] = &[
    "description",
    "notes",
    "warnings",
    "excluded_capabilities",
    "validation_todo",
];

fn is_env_placeholder(value: &str) -> bool {
    value.starts_with("${env:") && value.ends_with('}')
}

fn leaf_key_is_auth_like(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    [
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
        "authorization",
        "cookie",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

fn value_has_credential_literal(value: &str) -> bool {
    value.contains("sk-")
        || value.contains("Bearer ")
        || value.contains("Basic ")
        || value.contains("ghp_")
        || value.contains("gho_")
        || value.contains("ghu_")
        || value.contains("ghs_")
        || value.contains("ghr_")
        || value.contains("xoxb-")
        || value.contains("xoxp-")
        || value.contains("xoxa-")
        || value.contains("xoxr-")
        || value.contains("xoxs-")
}

fn scan_json_for_unsafe(value: &serde_json::Value, key: Option<&str>) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            for (child_key, child) in map {
                if DOC_ONLY_KEYS.contains(&child_key.as_str()) {
                    continue;
                }
                if scan_json_for_unsafe(child, Some(child_key)) {
                    return true;
                }
            }
            false
        }
        serde_json::Value::Array(items) => items.iter().any(|item| scan_json_for_unsafe(item, key)),
        serde_json::Value::String(text) => {
            if value_has_credential_literal(text) {
                return true;
            }
            if let Some(leaf) = key {
                if leaf_key_is_auth_like(leaf) && !is_env_placeholder(text) {
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

pub(crate) fn json_has_unsafe_literals(content: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) else {
        return false;
    };
    scan_json_for_unsafe(&parsed, None)
}

pub(crate) fn manifest_recommended_skills(root: &Path) -> Vec<String> {
    let path = cursor_root(root).join("manifest.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    parsed
        .get("recommended_pinned_skills")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn default_playwright_mcp_config_path(home: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("PLAYWRIGHT_MCP_CONFIG_PATH") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    home.join(".config/playwright-mcp/config.json")
}

pub(crate) fn resolve_playwright_browsers_path(home: &Path) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    default_playwright_browsers_path(home)
}

pub(crate) fn default_playwright_browsers_path(home: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Caches/ms-playwright"))
    } else if cfg!(target_os = "linux") {
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"));
        Some(cache.join("ms-playwright"))
    } else if cfg!(windows) {
        Some(home.join("AppData/Local/ms-playwright"))
    } else {
        None
    }
}

pub(crate) fn transform_playwright_template_value(
    value: &serde_json::Value,
    config_path: &str,
    browsers_path: &str,
) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                out.insert(
                    key.clone(),
                    transform_playwright_template_value(child, config_path, browsers_path),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| transform_playwright_template_value(item, config_path, browsers_path))
                .collect(),
        ),
        serde_json::Value::String(text) => {
            if text == "__PLAYWRIGHT_MCP_CONFIG_PATH__" {
                serde_json::Value::String(config_path.to_string())
            } else if text == "__PLAYWRIGHT_BROWSERS_PATH__" {
                serde_json::Value::String(browsers_path.to_string())
            } else if text.starts_with("@playwright/mcp@") {
                serde_json::Value::String("@playwright/mcp@0.0.48".into())
            } else {
                serde_json::Value::String(text.clone())
            }
        }
        other => other.clone(),
    }
}

fn global_mcp_status(
    paths: &CursorProfilePaths,
    root: &Path,
    warnings: &mut Vec<String>,
) -> String {
    let template_path = cursor_root(root).join("mcp/playwright.mcp.json");
    if !template_path.is_file() {
        return "template-missing".into();
    }
    let template_content = match std::fs::read_to_string(&template_path) {
        Ok(content) => content,
        Err(_) => return "template-unreadable".into(),
    };
    if json_has_unsafe_literals(&template_content) {
        warnings.push("Playwright MCP template contains suspicious auth-like literals.".into());
        return "template-unsafe".into();
    }
    let Ok(template_parsed) = serde_json::from_str::<serde_json::Value>(&template_content) else {
        return "template-invalid".into();
    };
    let Some(browsers_path) = resolve_playwright_browsers_path(&paths.user_home) else {
        return "unsupported-platform".into();
    };
    let config_path = default_playwright_mcp_config_path(&paths.user_home);
    let expected = template_parsed
        .get("mcpServers")
        .and_then(|v| v.get("playwright"))
        .cloned()
        .map(|value| {
            transform_playwright_template_value(
                &value,
                &config_path.to_string_lossy(),
                &browsers_path.to_string_lossy(),
            )
        });
    let Some(expected) = expected else {
        return "template-invalid".into();
    };

    let target = &paths.mcp_config;
    if !target.is_file() {
        return "missing".into();
    }
    let content = match std::fs::read_to_string(target) {
        Ok(content) => content,
        Err(_) => return "unreadable".into(),
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        warnings.push(format!(
            "{} mcp.json is invalid JSON.",
            paths.profile_root.display()
        ));
        return "invalid".into();
    };
    let actual = parsed
        .get("mcpServers")
        .and_then(|v| v.get("playwright"))
        .cloned();
    if actual == Some(expected) {
        "synced".into()
    } else if actual.is_some() {
        "diverged".into()
    } else {
        "partial".into()
    }
}

const CURSOR_SETUP_RUNTIME_KEY: &str = "setup_runtime";
const CURSOR_SETUP_RUNTIME_NATIVE: &str = "native";

fn workspace_resources_status(root: &Path, warnings: &mut Vec<String>) -> String {
    let script = root.join("scripts/install-cursor-workspace.sh");
    if !script.is_file() {
        warnings.push(
            "Workspace install-cursor-workspace.sh is missing. Use repair workspace on the Cursor page."
                .into(),
        );
        return "missing".into();
    }
    let content = match std::fs::read_to_string(&script) {
        Ok(content) => content,
        Err(_) => {
            warnings.push("Cannot read installed install-cursor-workspace.sh.".into());
            return "unreadable".into();
        }
    };
    if content.contains("cursor-global-profile-lib.sh") {
        warnings.push(
            "Installed workspace Cursor script is stale (references removed cursor-global-profile-lib.sh). Use repair workspace on the Cursor page."
                .into(),
        );
        return "stale".into();
    }

    let manifest_path = cursor_root(root).join("manifest.json");
    if !manifest_path.is_file() {
        warnings.push(
            "Workspace Cursor manifest.json is missing. Use repair workspace on the Cursor page."
                .into(),
        );
        return "stale".into();
    }
    let manifest_content = match std::fs::read_to_string(&manifest_path) {
        Ok(content) => content,
        Err(_) => return "unreadable".into(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&manifest_content) {
        Ok(parsed) => parsed,
        Err(_) => {
            warnings.push("Installed workspace Cursor manifest.json is invalid.".into());
            return "stale".into();
        }
    };
    if parsed
        .get(CURSOR_SETUP_RUNTIME_KEY)
        .and_then(|v| v.as_str())
        != Some(CURSOR_SETUP_RUNTIME_NATIVE)
    {
        warnings.push(
            "Installed workspace Cursor manifest is stale (missing native setup_runtime). Use repair workspace on the Cursor page."
                .into(),
        );
        return "stale".into();
    }

    "current".into()
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
    for key in [
        "agents",
        "rules",
        "mcp_examples",
        "global_profile",
        "setup_runtime",
    ] {
        if key == "global_profile" || key == "setup_runtime" {
            if !parsed.get(key).is_some_and(|v| v.is_string()) {
                warnings.push(format!("Cursor manifest missing string: {key}"));
                return "partial".into();
            }
        } else if !parsed.get(key).is_some_and(|v| v.is_array()) {
            warnings.push(format!("Cursor manifest missing array: {key}"));
            return "partial".into();
        }
    }
    "valid".into()
}

#[tauri::command]
pub fn get_cursor_profile_health() -> Result<CursorProfileHealth, String> {
    let root = workspace_root()?;
    let paths = resolve_cursor_profile_paths()?;
    let profile_root = cursor_profile_root_display(&paths);
    let profile_root_source = "default".to_string();
    let mut warnings = Vec::new();
    let cursor = cursor_root(&root);

    let workspace_resources_status = workspace_resources_status(&root, &mut warnings);
    let manifest_status = manifest_status(&root, &mut warnings);
    let user_rules_status = if cursor.join("user-rules.md").is_file() {
        "manual"
    } else {
        "template-missing"
    }
    .to_string();
    let (global_agents_status, global_agents_count, expected_global_agents_count) =
        sync_dir_status(&cursor.join("agents"), &paths.agents, "md");

    let recommended_skills = manifest_recommended_skills(&root);
    let (global_skills_status, global_skills_count, expected_global_skills_count) =
        sync_skill_dirs_status(&root.join("skills"), &paths.skills, &recommended_skills);

    let mcp_status = global_mcp_status(&paths, &root, &mut warnings);
    let legacy_cleanup_status = legacy_permission_cleanup_status(&paths.permissions)
        .label()
        .to_string();

    let surfaces = [
        global_agents_status.as_str(),
        global_skills_status.as_str(),
        mcp_status.as_str(),
    ];
    let legacy_cleanup_pending = matches!(
        legacy_permission_cleanup_status(&paths.permissions),
        LegacyPermissionCleanupStatus::Planned
            | LegacyPermissionCleanupStatus::BlockedInvalidJson
            | LegacyPermissionCleanupStatus::BlockedInvalidAllowlist
    );
    let status =
        if workspace_resources_status == "stale" || workspace_resources_status == "missing" {
            "stale"
        } else if manifest_status != "valid" {
            "partial"
        } else if surfaces.contains(&"unsafe") {
            "unsafe"
        } else if legacy_cleanup_pending {
            "diverged"
        } else if surfaces.iter().all(|s| *s == "synced") {
            "synced"
        } else if surfaces.iter().all(|s| *s == "missing") {
            "missing"
        } else if surfaces
            .iter()
            .any(|s| *s == "diverged" || *s == "partial" || *s == "invalid")
        {
            "diverged"
        } else {
            "partial"
        }
        .to_string();

    let next_action = match status.as_str() {
        "stale" => {
            "Installed Cursor scripts/templates are behind the app. Repair workspace resources, then apply the global profile."
                .into()
        }
        "synced" => {
            "Cursor setup is synced. Select Auto Review in Cursor Settings > Agents > Run Mode. Agent Workspace cannot verify the active run mode."
                .into()
        }
        "missing" => {
            format!(
                "Run apply setup to sync {} agents, starter skills, and Playwright MCP.",
                profile_root
            )
        }
        "unsafe" => format!(
            "Fix unsafe Cursor setup surfaces before applying setup to {}.",
            profile_root
        ),
        "diverged" => "Run diff global profile, then apply global profile.".into(),
        _ => "Validate the workspace templates, then apply the global profile.".into(),
    };

    Ok(CursorProfileHealth {
        status,
        profile_root,
        profile_root_source,
        workspace_resources_status,
        manifest_status,
        user_rules_status,
        global_agents_status,
        global_agents_count,
        expected_global_agents_count,
        global_skills_status,
        global_skills_count,
        expected_global_skills_count,
        mcp_status,
        legacy_permission_cleanup_status: legacy_cleanup_status,
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
    path_arg_for_bash(&canonical)
}

fn block_when_workspace_resources_stale(
    action: &str,
    health: &CursorProfileHealth,
) -> Option<ActionResult> {
    let needs_current = matches!(
        action,
        "cursor_diff_global_profile"
            | "cursor_apply_global_profile"
            | "cursor_validate_global_profile"
            | "cursor_diff_global_agents"
            | "cursor_sync_global_agents"
    );
    if !needs_current {
        return None;
    }
    if health.workspace_resources_status == "current" {
        return None;
    }
    Some(ActionResult::new(
        false,
        action.to_string(),
        String::new(),
        format!(
            "Workspace Cursor resources are {}. Use repair workspace on the Cursor page before running this action.",
            health.workspace_resources_status
        ),
        Some(1),
    ))
}

fn cursor_profile_command_summary(bash: &str, args: &[String], env: &[(String, String)]) -> String {
    let env_keys: Vec<&str> = env
        .iter()
        .map(|(key, _)| key.as_str())
        .filter(|key| *key != "HOME")
        .collect();
    format!(
        "command: {} {}\nenv keys: {}",
        bash,
        args.iter()
            .map(|arg| {
                if arg.contains(' ') {
                    format!("\"{arg}\"")
                } else {
                    arg.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        env_keys.join(", ")
    )
}

fn native_profile_result(
    action: &str,
    output: crate::cursor_profile_ops::ProfileRunOutput,
) -> ActionResult {
    ActionResult::new(
        output.success,
        action.to_string(),
        output.stdout,
        output.stderr,
        Some(output.exit_code),
    )
}

fn run_global_profile_action_native(
    root: &Path,
    action: &str,
    apply: bool,
) -> Result<ActionResult, String> {
    let paths = resolve_cursor_profile_paths()?;
    Ok(native_profile_result(
        action,
        run_global_profile(root, &paths, apply),
    ))
}

fn validate_global_profile_action_native(
    root: &Path,
    action: &str,
) -> Result<ActionResult, String> {
    let paths = resolve_cursor_profile_paths()?;
    Ok(native_profile_result(
        action,
        validate_global_profile(root, &paths),
    ))
}

fn run_global_agents_action_native(
    root: &Path,
    action: &str,
    apply: bool,
) -> Result<ActionResult, String> {
    let paths = resolve_cursor_profile_paths()?;
    Ok(native_profile_result(
        action,
        run_global_agents_only(root, &paths, apply),
    ))
}

pub(crate) fn run_cursor_workspace_script(
    root: &Path,
    action: &str,
    args_tail: &[&str],
) -> Result<ActionResult, String> {
    let script = cursor_script_arg(root)?;
    let bash = resolve_bash()?;
    let paths = resolve_cursor_profile_paths()?;
    let env = cursor_profile_env_pairs(&paths, &bash, "python3");
    let mut args: Vec<String> = vec![script];
    args.extend(args_tail.iter().map(|arg| (*arg).to_string()));
    let (ok, out, mut err, code) = run_cmd_owned_env(&bash, &args, root, &env);
    if !ok {
        let summary = cursor_profile_command_summary(&bash, &args, &env);
        err = if err.trim().is_empty() {
            summary
        } else {
            format!("{summary}\n{err}")
        };
    }
    Ok(ActionResult::new(ok, action.to_string(), out, err, code))
}

#[tauri::command]
pub fn run_cursor_profile_action(action: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let health = get_cursor_profile_health()?;
    if let Some(blocked) = block_when_workspace_resources_stale(&action, &health) {
        return Ok(blocked);
    }

    match action.as_str() {
        "cursor_diff_global_profile" => {
            return run_global_profile_action_native(&root, &action, false);
        }
        "cursor_apply_global_profile" => {
            return run_global_profile_action_native(&root, &action, true);
        }
        "cursor_validate_global_profile" => {
            return validate_global_profile_action_native(&root, &action);
        }
        "cursor_diff_global_agents" => {
            return run_global_agents_action_native(&root, &action, false);
        }
        "cursor_sync_global_agents" => {
            return run_global_agents_action_native(&root, &action, true);
        }
        "cursor_validate_profile" => {
            let ok = !matches!(health.status.as_str(), "unsafe" | "partial" | "stale")
                && health.manifest_status == "valid"
                && health.workspace_resources_status == "current";
            return Ok(ActionResult::new(
                ok,
                action,
                format!(
                    "manifest: {}\nagents: {}/{} {}\nskills: {}/{} {}\nmcp: {}\nlegacy-permissions: {}\n",
                    health.manifest_status,
                    health.global_agents_count,
                    health.expected_global_agents_count,
                    health.global_agents_status,
                    health.global_skills_count,
                    health.expected_global_skills_count,
                    health.global_skills_status,
                    health.mcp_status,
                    health.legacy_permission_cleanup_status,
                ),
                health.warnings.join("\n"),
                if ok { Some(0) } else { Some(1) },
            ));
        }
        _ => {}
    }

    let args_tail = match action.as_str() {
        "cursor_open_settings" => vec!["--open-cursor-settings"],
        "cursor_copy_user_rules" => vec!["--copy-user-rules"],
        _ => return Err(format!("unknown Cursor action: {action}")),
    };
    run_cursor_workspace_script(&root, &action, &args_tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_profile_paths::cursor_profile_env_pairs;
    use crate::shell_runtime::path_arg_for_bash;

    #[test]
    fn hardcoded_auth_like_values_are_unsafe() {
        let content = r#"{"servers":{"demo":{"api_key":"sk-test12345678901234567890"}}}"#;
        assert!(json_has_unsafe_literals(content));
    }

    #[test]
    fn env_placeholder_auth_values_are_allowed() {
        let content = r#"{"env":{"EXAMPLE_API_KEY":"${env:EXAMPLE_API_KEY}"}}"#;
        assert!(!json_has_unsafe_literals(content));
    }

    #[test]
    fn workspace_resources_stale_when_manifest_lacks_native_runtime() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cursor-stale-ws-{nonce}"));
        let scripts = root.join("scripts");
        let cursor = root.join("templates/cursor");
        fs::create_dir_all(&scripts).expect("scripts dir");
        fs::create_dir_all(&cursor).expect("cursor dir");
        fs::write(
            scripts.join("install-cursor-workspace.sh"),
            "#!/usr/bin/env bash\n# helper script\n",
        )
        .expect("write script");
        fs::write(
            cursor.join("manifest.json"),
            r#"{"setup_runtime":"script"}"#,
        )
        .expect("write manifest");
        let mut warnings = Vec::new();
        let status = workspace_resources_status(&root, &mut warnings);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(status, "stale");
        assert!(warnings.iter().any(|w| w.contains("setup_runtime")));
    }

    #[test]
    fn workspace_resources_current_when_script_and_manifest_ok() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let mut warnings = Vec::new();
        let status = workspace_resources_status(&root, &mut warnings);
        assert_eq!(status, "current", "warnings: {:?}", warnings);
    }

    #[test]
    fn cursor_script_arg_strips_extended_prefix_for_bash() {
        let path = PathBuf::from(
            r"\\?\C:\Users\me\.config\agent-workspace\scripts\install-cursor-workspace.sh",
        );
        assert_eq!(
            path_arg_for_bash(&path).expect("bash script path"),
            "C:/Users/me/.config/agent-workspace/scripts/install-cursor-workspace.sh"
        );
    }

    #[test]
    fn command_summary_lists_cursor_target_env_keys() {
        let paths = crate::cursor_profile_paths::cursor_profile_paths_from_root(
            PathBuf::from(r"C:\Users\Example"),
            PathBuf::from(r"D:\AgentWorkspace\cursor-profile"),
        );
        let env = cursor_profile_env_pairs(&paths, r"C:\Program Files\Git\bin\bash.exe", "python");
        let summary = cursor_profile_command_summary(
            r"C:\Program Files\Git\bin\bash.exe",
            &["script.sh".into(), "--validate-global-profile".into()],
            &env,
        );
        assert!(summary.contains("CURSOR_PROFILE_ROOT"));
        assert!(summary.contains("CURSOR_AGENTS_PATH"));
        assert!(summary.contains("AW_PYTHON"));
        assert!(summary.contains("AW_BASH"));
    }

    #[test]
    fn cursor_profile_paths_match_default_script_contract() {
        let user_home = PathBuf::from("/tmp/aw-cursor-route-home");
        let profile_root = user_home.join(".cursor");
        let paths = crate::cursor_profile_paths::cursor_profile_paths_from_root(
            user_home.clone(),
            profile_root.clone(),
        );
        assert_eq!(paths.agents, profile_root.join("agents"));
        assert_eq!(paths.skills, profile_root.join("skills"));
        assert_eq!(paths.mcp_config, profile_root.join("mcp.json"));
        assert_eq!(paths.permissions, profile_root.join("permissions.json"));
    }

    #[test]
    fn block_apply_when_workspace_resources_stale() {
        let health = CursorProfileHealth {
            status: "stale".into(),
            profile_root: "/tmp/.cursor".into(),
            profile_root_source: "default".into(),
            workspace_resources_status: "stale".into(),
            manifest_status: "partial".into(),
            user_rules_status: "manual".into(),
            global_agents_status: "missing".into(),
            global_agents_count: 0,
            expected_global_agents_count: 5,
            global_skills_status: "missing".into(),
            global_skills_count: 0,
            expected_global_skills_count: 6,
            mcp_status: "missing".into(),
            legacy_permission_cleanup_status: "not-needed".to_string(),
            warnings: vec!["stale workspace".into()],
            next_action: "repair".into(),
        };
        let blocked = block_when_workspace_resources_stale("cursor_apply_global_profile", &health);
        assert!(blocked.is_some());
        let result = blocked.unwrap();
        assert!(!result.success);
        assert!(result.stderr.contains("Cursor page"));
        assert!(!result.stderr.contains("Start"));
    }
}
