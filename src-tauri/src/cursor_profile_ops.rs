use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::backups::backup_root;
use crate::commands::cursor_profile::{
    cursor_root, default_playwright_browsers_path, default_playwright_mcp_config_path,
    json_has_unsafe_literals, manifest_recommended_skills, mcp_allowlist_unsafe, sync_dir_status,
    sync_skill_dirs_status, terminal_allowlist_unsafe, transform_playwright_template_value,
};
use crate::cursor_profile_paths::{normalized_path_key, CursorProfilePaths};
use crate::skills_install::{
    discover_workspace_skills, install_skills_native, InstallSkillsRequest,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn utc_backup_timestamp() -> String {
    #[cfg(windows)]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')",
            ])
            .output()
        {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    let trimmed = text.trim().to_string();
                    if trimmed.len() == 15 {
                        return trimmed;
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("date").args(["-u", "+%Y%m%d-%H%M%S"]).output() {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    let trimmed = text.trim().to_string();
                    if trimmed.len() == 15 {
                        return trimmed;
                    }
                }
            }
        }
    }
    "00000000-000000".to_string()
}

fn backup_file_before_write(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let root = backup_root()?;
    let ts = utc_backup_timestamp();
    let backup_dir = root.join(&ts).join(label);
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("create backup dir {}: {e}", backup_dir.display()))?;
    let dest = backup_dir.join(
        path.file_name()
            .ok_or_else(|| format!("backup path has no filename: {}", path.display()))?,
    );
    fs::copy(path, &dest).map_err(|e| format!("backup {}: {e}", path.display()))?;
    Ok(())
}

fn ensure_global_write_target(
    paths: &CursorProfilePaths,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err(format!("empty {label} path"));
    }

    let norm_path = normalized_path_key(path);
    let norm_root = normalized_path_key(&paths.profile_root);
    let norm_home = normalized_path_key(&paths.user_home);

    if norm_path == "/"
        || norm_path == "/users"
        || norm_path == norm_root
        || norm_path == format!("{norm_root}/")
        || norm_path == norm_home
        || norm_path == format!("{norm_home}/")
    {
        return Err(format!("refusing broad {label} path: {}", path.display()));
    }

    let expected = match label {
        "mcp" => normalized_path_key(&paths.mcp_config),
        "permissions" => normalized_path_key(&paths.permissions),
        "agents" => normalized_path_key(&paths.agents),
        "skills" => normalized_path_key(&paths.skills),
        _ => return Err(format!("unknown global write label: {label}")),
    };

    if norm_path != expected {
        return Err(format!(
            "refusing non-allowlisted {label} path: {} (expected under {})",
            path.display(),
            paths.profile_root.display()
        ));
    }
    Ok(())
}

fn permissions_template_path(workspace_root: &Path) -> PathBuf {
    cursor_root(workspace_root).join("permissions/global-playwright.json")
}

fn mcp_template_path(workspace_root: &Path) -> PathBuf {
    cursor_root(workspace_root).join("mcp/playwright.mcp.json")
}

fn diff_permissions_status(template_path: &Path, target_path: &Path) -> String {
    let Ok(template_content) = fs::read_to_string(template_path) else {
        return "missing".into();
    };
    let Ok(template) = serde_json::from_str::<serde_json::Value>(&template_content) else {
        return "diverged".into();
    };
    let required: Vec<String> = template
        .get("mcpAllowlist")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    if !target_path.is_file() {
        return "missing".into();
    }
    let Ok(target_content) = fs::read_to_string(target_path) else {
        return "unreadable".into();
    };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&target_content) else {
        return "invalid".into();
    };
    let Some(existing) = data.get("mcpAllowlist").and_then(|v| v.as_array()) else {
        return "diverged".into();
    };
    let existing_set: std::collections::HashSet<String> = existing
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    if required.iter().all(|item| existing_set.contains(item)) {
        "synced".into()
    } else {
        "diverged".into()
    }
}

fn permissions_value_unsafe(value: &serde_json::Value) -> bool {
    if let Ok(serialized) = serde_json::to_string(value) {
        if json_has_unsafe_literals(&serialized) {
            return true;
        }
    } else {
        return true;
    }
    if let Some(terminal) = value.get("terminalAllowlist") {
        if terminal_allowlist_unsafe(terminal) {
            return true;
        }
    }
    if let Some(mcp) = value.get("mcpAllowlist") {
        if mcp_allowlist_unsafe(mcp) {
            return true;
        }
    }
    false
}

fn read_permissions_target(target_path: &Path) -> Result<serde_json::Value, String> {
    if !target_path.is_file() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    let content =
        fs::read_to_string(target_path).map_err(|e| format!("read permissions target: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("permissions target invalid JSON: {e}"))
}

fn prepare_permissions_merge(template_path: &Path, target_path: &Path) -> Result<String, String> {
    let template_content =
        fs::read_to_string(template_path).map_err(|e| format!("read permissions template: {e}"))?;
    let template: serde_json::Value = serde_json::from_str(&template_content)
        .map_err(|e| format!("permissions template invalid JSON: {e}"))?;
    let managed: Vec<String> = template
        .get("mcpAllowlist")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if managed.is_empty() {
        return Err("permissions template missing mcpAllowlist entries".into());
    }

    let mut data = read_permissions_target(target_path)?;

    let merged = match data.get("mcpAllowlist").and_then(|v| v.as_array()) {
        None => managed,
        Some(existing) => {
            let mut out: Vec<String> = existing
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect();
            for entry in managed {
                if !out.contains(&entry) {
                    out.push(entry);
                }
            }
            out
        }
    };

    let object = data
        .as_object_mut()
        .ok_or_else(|| "permissions data must be an object".to_string())?;
    object.insert(
        "mcpAllowlist".into(),
        serde_json::Value::Array(merged.into_iter().map(serde_json::Value::String).collect()),
    );

    if permissions_value_unsafe(&data) {
        return Err("permissions JSON failed safety check".into());
    }

    serde_json::to_string_pretty(&data)
        .map(|s| s + "\n")
        .map_err(|e| format!("serialize permissions: {e}"))
}

fn permissions_file_unsafe(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return true;
    };
    if json_has_unsafe_literals(&content) {
        return true;
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return true;
    };
    permissions_value_unsafe(&parsed)
}

fn resolve_playwright_paths(home: &Path) -> Option<(PathBuf, PathBuf)> {
    let browsers = default_playwright_browsers_path(home)?;
    let config = default_playwright_mcp_config_path(home);
    Some((config, browsers))
}

fn mcp_diff_status(workspace_root: &Path, paths: &CursorProfilePaths) -> String {
    let template_path = mcp_template_path(workspace_root);
    if !template_path.is_file() {
        return "template-missing".into();
    }
    let Ok(template_content) = fs::read_to_string(&template_path) else {
        return "template-unreadable".into();
    };
    let Ok(template_parsed) = serde_json::from_str::<serde_json::Value>(&template_content) else {
        return "template-invalid".into();
    };
    let Some((config_path, browsers_path)) = resolve_playwright_paths(&paths.user_home) else {
        return "unsupported".into();
    };
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
    if !paths.mcp_config.is_file() {
        return "missing".into();
    }
    let Ok(content) = fs::read_to_string(&paths.mcp_config) else {
        return "unreadable".into();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
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

fn read_mcp_target(target_path: &Path) -> Result<serde_json::Value, String> {
    if !target_path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(target_path).map_err(|e| format!("read MCP target: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("MCP target invalid JSON: {e}"))
}

fn prepare_mcp_merge(
    template_path: &Path,
    target_path: &Path,
    config_path: &Path,
    browsers_path: &Path,
) -> Result<String, String> {
    let template_content =
        fs::read_to_string(template_path).map_err(|e| format!("read MCP template: {e}"))?;
    let template: serde_json::Value = serde_json::from_str(&template_content)
        .map_err(|e| format!("MCP template invalid JSON: {e}"))?;
    let playwright_entry = template
        .get("mcpServers")
        .and_then(|v| v.get("playwright"))
        .cloned()
        .ok_or_else(|| "MCP template missing playwright server".to_string())?;
    let transformed = transform_playwright_template_value(
        &playwright_entry,
        &config_path.to_string_lossy(),
        &browsers_path.to_string_lossy(),
    );

    let mut data = read_mcp_target(target_path)?;
    let object = data
        .as_object_mut()
        .ok_or_else(|| "MCP data must be an object".to_string())?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if let Some(server_map) = servers.as_object_mut() {
        server_map.insert("playwright".into(), transformed);
    } else {
        return Err("mcpServers must be an object".into());
    }

    if json_has_unsafe_literals(&serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string()))
    {
        return Err("merged MCP JSON contains unsafe literals".into());
    }

    serde_json::to_string_pretty(&data)
        .map(|s| s + "\n")
        .map_err(|e| format!("serialize MCP: {e}"))
}

#[derive(Debug, Clone)]
struct GlobalProfilePlan {
    permissions_serialized: String,
    mcp_serialized: String,
}

fn install_agents(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
    apply: bool,
    label: &str,
    stdout: &mut String,
) -> Result<(), String> {
    ensure_global_write_target(paths, &paths.agents, "agents")?;
    let source_dir = cursor_root(workspace_root).join("agents");
    if !source_dir.is_dir() {
        return Err(format!(
            "Cursor agents source not found: {}",
            source_dir.display()
        ));
    }

    let mut count = 0usize;
    for entry in fs::read_dir(&source_dir).map_err(|e| format!("read agents source: {e}"))? {
        let entry = entry.map_err(|e| format!("read agent entry: {e}"))?;
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        if source.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = source.file_name() else {
            continue;
        };
        let dest = paths.agents.join(name);
        count += 1;
        if apply {
            fs::create_dir_all(&paths.agents).map_err(|e| format!("create agents dir: {e}"))?;
            backup_file_before_write(&dest, "cursor-agents")?;
            fs::copy(&source, &dest)
                .map_err(|e| format!("copy agent {}: {e}", source.display()))?;
        }
    }

    let verb = if apply { "written" } else { "planned" };
    stdout.push_str(&format!("{label:<18} {verb} {count}\n"));
    Ok(())
}

fn install_global_skills(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
    apply: bool,
    stdout: &mut String,
) -> Result<(), String> {
    ensure_global_write_target(paths, &paths.skills, "skills")?;
    let skills = manifest_recommended_skills(workspace_root);
    if skills.is_empty() {
        return Err("no recommended skills in manifest".into());
    }

    if apply {
        let mut overrides = std::collections::HashMap::new();
        overrides.insert("cursor".into(), paths.skills.clone());
        let result = install_skills_native(
            workspace_root,
            &InstallSkillsRequest {
                agents: vec!["cursor".into()],
                skills,
                dry_run: false,
                agent_dest_overrides: Some(overrides),
            },
        );
        if !result.success {
            return Err(if result.stderr.is_empty() {
                result.stdout
            } else {
                result.stderr
            });
        }
        let skill_count = manifest_recommended_skills(workspace_root).len();
        stdout.push_str(&format!("global-skills       written {skill_count}\n"));
    } else {
        let (status, _, _) = sync_skill_dirs_status(
            &workspace_root.join("skills"),
            &paths.skills,
            &manifest_recommended_skills(workspace_root),
        );
        stdout.push_str(&format!(
            "global-skills       planned {} ({status})\n",
            manifest_recommended_skills(workspace_root).len()
        ));
    }
    Ok(())
}

fn apply_global_mcp(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
    apply: bool,
    plan: Option<&GlobalProfilePlan>,
    stdout: &mut String,
) -> Result<(), String> {
    ensure_global_write_target(paths, &paths.mcp_config, "mcp")?;
    if apply {
        let serialized = plan
            .ok_or_else(|| "internal error: missing MCP plan".to_string())?
            .mcp_serialized
            .clone();
        if let Some(parent) = paths.mcp_config.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create MCP parent: {e}"))?;
        }
        backup_file_before_write(&paths.mcp_config, "cursor-mcp")?;
        fs::write(&paths.mcp_config, serialized).map_err(|e| format!("write MCP: {e}"))?;
        stdout.push_str("global-mcp          written 1\n");
    } else {
        let status = mcp_diff_status(workspace_root, paths);
        stdout.push_str(&format!("global-mcp          planned {status}\n"));
    }
    Ok(())
}

fn preflight_global_profile(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
) -> Result<GlobalProfilePlan, String> {
    for (path, label) in [
        (&paths.agents, "agents"),
        (&paths.skills, "skills"),
        (&paths.mcp_config, "mcp"),
        (&paths.permissions, "permissions"),
    ] {
        ensure_global_write_target(paths, path, label)?;
    }

    let agents_source = cursor_root(workspace_root).join("agents");
    if !agents_source.is_dir() {
        return Err(format!(
            "Cursor agents source not found: {}",
            agents_source.display()
        ));
    }

    let recommended = manifest_recommended_skills(workspace_root);
    if recommended.is_empty() {
        return Err("no recommended skills in manifest".into());
    }

    let discovered = discover_workspace_skills(&workspace_root.join("skills"))?;
    for skill in &recommended {
        if !discovered.contains_key(skill) {
            return Err(format!("unknown skill: {skill}"));
        }
    }

    let permissions_template = permissions_template_path(workspace_root);
    let permissions_content = fs::read_to_string(&permissions_template)
        .map_err(|e| format!("read permissions template: {e}"))?;
    serde_json::from_str::<serde_json::Value>(&permissions_content)
        .map_err(|e| format!("permissions template invalid JSON: {e}"))?;
    if json_has_unsafe_literals(&permissions_content) {
        return Err("permissions template contains unsafe literals".into());
    }

    if paths.permissions.is_file() {
        let existing = read_permissions_target(&paths.permissions)?;
        if permissions_value_unsafe(&existing) {
            return Err("existing permissions JSON failed safety check".into());
        }
    }

    let mcp_template = mcp_template_path(workspace_root);
    let mcp_content =
        fs::read_to_string(&mcp_template).map_err(|e| format!("read MCP template: {e}"))?;
    let mcp_parsed: serde_json::Value = serde_json::from_str(&mcp_content)
        .map_err(|e| format!("MCP template invalid JSON: {e}"))?;
    if json_has_unsafe_literals(&mcp_content) {
        return Err("Playwright MCP template contains unsafe literals".into());
    }
    if mcp_parsed
        .get("mcpServers")
        .and_then(|v| v.get("playwright"))
        .is_none()
    {
        return Err("MCP template missing playwright server".into());
    }

    if paths.mcp_config.is_file() {
        read_mcp_target(&paths.mcp_config)?;
    }

    let (config_path, browsers_path) = resolve_playwright_paths(&paths.user_home)
        .ok_or_else(|| "could not resolve Playwright MCP paths for this platform".to_string())?;

    let permissions_serialized =
        prepare_permissions_merge(&permissions_template, &paths.permissions)?;
    let mcp_serialized = prepare_mcp_merge(
        &mcp_template,
        &paths.mcp_config,
        &config_path,
        &browsers_path,
    )?;

    backup_root()?;

    Ok(GlobalProfilePlan {
        permissions_serialized,
        mcp_serialized,
    })
}

fn stage_failure(stage: &str, err: String, stdout: String) -> ProfileRunOutput {
    ProfileRunOutput {
        success: false,
        stdout,
        stderr: format!("{stage}: {err}\n"),
        exit_code: 1,
    }
}

fn apply_global_permissions(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
    apply: bool,
    plan: Option<&GlobalProfilePlan>,
    stdout: &mut String,
) -> Result<(), String> {
    ensure_global_write_target(paths, &paths.permissions, "permissions")?;
    let template_path = permissions_template_path(workspace_root);
    if apply {
        let serialized = plan
            .ok_or_else(|| "internal error: missing permissions plan".to_string())?
            .permissions_serialized
            .clone();
        if let Some(parent) = paths.permissions.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create permissions parent: {e}"))?;
        }
        backup_file_before_write(&paths.permissions, "cursor-permissions")?;
        fs::write(&paths.permissions, serialized).map_err(|e| format!("write permissions: {e}"))?;
        stdout.push_str("global-permissions  written 1\n");
    } else {
        let status = diff_permissions_status(&template_path, &paths.permissions);
        stdout.push_str(&format!("global-permissions  planned {status}\n"));
    }
    Ok(())
}

pub fn run_global_profile(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
    apply: bool,
) -> ProfileRunOutput {
    let mut stdout = String::new();

    let plan = if apply {
        match preflight_global_profile(workspace_root, paths) {
            Ok(plan) => Some(plan),
            Err(err) => return stage_failure("preflight", err, stdout),
        }
    } else {
        None
    };

    if let Err(err) = install_agents(workspace_root, paths, apply, "global-agents", &mut stdout) {
        return stage_failure("global-agents", err, stdout);
    }
    if let Err(err) = install_global_skills(workspace_root, paths, apply, &mut stdout) {
        return stage_failure("global-skills", err, stdout);
    }
    if let Err(err) = apply_global_mcp(workspace_root, paths, apply, plan.as_ref(), &mut stdout) {
        return stage_failure("global-mcp", err, stdout);
    }
    if let Err(err) =
        apply_global_permissions(workspace_root, paths, apply, plan.as_ref(), &mut stdout)
    {
        return stage_failure("global-permissions", err, stdout);
    }

    ProfileRunOutput {
        success: true,
        stdout,
        stderr: String::new(),
        exit_code: 0,
    }
}

pub fn validate_global_profile(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
) -> ProfileRunOutput {
    let (agents_status, _, _) = sync_dir_status(
        &cursor_root(workspace_root).join("agents"),
        &paths.agents,
        "md",
    );
    let recommended = manifest_recommended_skills(workspace_root);
    let (skills_status, _, _) =
        sync_skill_dirs_status(&workspace_root.join("skills"), &paths.skills, &recommended);
    let mcp_status = mcp_diff_status(workspace_root, paths);
    let perms_status = diff_permissions_status(
        &permissions_template_path(workspace_root),
        &paths.permissions,
    );
    let shell_unsafe = paths.permissions.is_file() && permissions_file_unsafe(&paths.permissions);

    let stdout = format!(
        "agents {agents_status}\nskills {skills_status}\nmcp {mcp_status}\npermissions {perms_status}\n"
    );

    let success = agents_status == "synced"
        && skills_status == "synced"
        && mcp_status == "synced"
        && perms_status == "synced"
        && !shell_unsafe;

    ProfileRunOutput {
        success,
        stdout,
        stderr: if shell_unsafe {
            "unsafe permissions detected".into()
        } else {
            String::new()
        },
        exit_code: if success { 0 } else { 1 },
    }
}

pub fn run_global_agents_only(
    workspace_root: &Path,
    paths: &CursorProfilePaths,
    apply: bool,
) -> ProfileRunOutput {
    let mut stdout = String::new();
    match install_agents(workspace_root, paths, apply, "global-agents", &mut stdout) {
        Ok(()) => ProfileRunOutput {
            success: true,
            stdout,
            stderr: String::new(),
            exit_code: 0,
        },
        Err(err) => ProfileRunOutput {
            success: false,
            stdout,
            stderr: err,
            exit_code: 1,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor_profile_paths::cursor_profile_paths_from_root;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("aw-cursor-ops-{name}-{nonce}"));
        fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn test_paths(profile_root: &Path) -> CursorProfilePaths {
        cursor_profile_paths_from_root(
            profile_root.parent().unwrap_or(profile_root).to_path_buf(),
            profile_root.to_path_buf(),
        )
    }

    #[test]
    fn merge_permissions_preserves_unrelated_user_servers() {
        let root = temp_root("perms-merge");
        let template = root.join("template.json");
        let target = root.join("permissions.json");
        fs::write(
            &template,
            r#"{"mcpAllowlist":["playwright:*"],"notes":"managed"}"#,
        )
        .expect("template");
        fs::write(&target, r#"{"mcpAllowlist":["custom:*"],"other":"keep"}"#).expect("target");

        let serialized = prepare_permissions_merge(&template, &target).expect("merge");
        fs::write(&target, serialized).expect("write");
        let merged: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&target).expect("read")).expect("json");
        let allow = merged
            .get("mcpAllowlist")
            .and_then(|v| v.as_array())
            .expect("allowlist");
        let entries: Vec<&str> = allow.iter().filter_map(|v| v.as_str()).collect();
        assert!(entries.contains(&"custom:*"));
        assert!(entries.contains(&"playwright:*"));
        assert_eq!(merged.get("other").and_then(|v| v.as_str()), Some("keep"));
        assert!(merged.get("terminalAllowlist").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_mcp_preserves_unrelated_servers() {
        let root = temp_root("mcp-merge");
        let template = root.join("playwright.mcp.json");
        let target = root.join("mcp.json");
        fs::write(
            &template,
            include_str!(
                "../../resources/default-workspace/templates/cursor/mcp/playwright.mcp.json"
            ),
        )
        .expect("template");
        fs::write(&target, r#"{"mcpServers":{"custom":{"command":"node"}}}"#).expect("target");

        let serialized = prepare_mcp_merge(
            &template,
            &target,
            &PathBuf::from(r"C:\Users\Example\.config\playwright-mcp\config.json"),
            &PathBuf::from(r"C:\Users\Example\AppData\Local\ms-playwright"),
        )
        .expect("merge");
        fs::write(&target, serialized).expect("write");

        let merged: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&target).expect("read")).expect("json");
        assert!(merged["mcpServers"]["custom"].is_object());
        assert!(merged["mcpServers"]["playwright"].is_object());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_writes_only_under_profile_root() {
        let workspace = temp_root("workspace");
        let profile = temp_root("profile");
        fs::create_dir_all(workspace.join("templates/cursor/agents")).expect("agents src");
        fs::write(
            workspace.join("templates/cursor/agents/reviewer.md"),
            "# reviewer",
        )
        .expect("agent");
        fs::write(
            workspace.join("templates/cursor/manifest.json"),
            r#"{"recommended_pinned_skills":["diagnose"]}"#,
        )
        .expect("manifest");
        fs::create_dir_all(workspace.join("skills/diagnose")).expect("skill");
        fs::write(
            workspace.join("skills/diagnose/SKILL.md"),
            "---\nname: diagnose\ndescription: d\n---\n",
        )
        .expect("skill md");
        let perms_template = workspace.join("templates/cursor/permissions/global-playwright.json");
        fs::create_dir_all(perms_template.parent().expect("perms parent")).expect("perms dir");
        fs::write(&perms_template, r#"{"mcpAllowlist":["playwright:*"]}"#).expect("perms template");
        let mcp_template = workspace.join("templates/cursor/mcp/playwright.mcp.json");
        fs::create_dir_all(mcp_template.parent().expect("mcp parent")).expect("mcp dir");
        fs::write(
            &mcp_template,
            include_str!(
                "../../resources/default-workspace/templates/cursor/mcp/playwright.mcp.json"
            ),
        )
        .expect("mcp template");

        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = profile.parent().unwrap().to_path_buf();
        unsafe {
            std::env::set_var("HOME", home.to_string_lossy().as_ref());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                profile.join("backups").to_string_lossy().as_ref(),
            );
            std::env::set_var(
                "CURSOR_SKILLS_PATH",
                profile.join("skills").to_string_lossy().as_ref(),
            );
        }

        fs::write(
            profile.join("permissions.json"),
            r#"{"mcpAllowlist":["custom:*"]}"#,
        )
        .expect("existing permissions");

        let paths = test_paths(&profile);
        let result = run_global_profile(&workspace, &paths, true);
        assert!(
            result.success,
            "stderr={} stdout={}",
            result.stderr, result.stdout
        );
        assert!(
            profile
                .join("backups")
                .read_dir()
                .map(|mut d| d.next().is_some())
                .unwrap_or(false),
            "expected backup before permissions overwrite"
        );
        assert!(profile.join("agents/reviewer.md").is_file());
        assert!(profile.join("skills/diagnose/SKILL.md").is_file());
        assert!(profile.join("mcp.json").is_file());
        assert!(profile.join("permissions.json").is_file());

        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    fn write_minimal_profile_workspace(workspace: &Path) {
        fs::create_dir_all(workspace.join("templates/cursor/agents")).expect("agents src");
        fs::write(
            workspace.join("templates/cursor/agents/reviewer.md"),
            "# reviewer",
        )
        .expect("agent");
        fs::write(
            workspace.join("templates/cursor/manifest.json"),
            r#"{"recommended_pinned_skills":["diagnose"]}"#,
        )
        .expect("manifest");
        fs::create_dir_all(workspace.join("skills/diagnose")).expect("skill");
        fs::write(
            workspace.join("skills/diagnose/SKILL.md"),
            "---\nname: diagnose\ndescription: d\n---\n",
        )
        .expect("skill md");
        let perms_template = workspace.join("templates/cursor/permissions/global-playwright.json");
        fs::create_dir_all(perms_template.parent().expect("perms parent")).expect("perms dir");
        fs::write(&perms_template, r#"{"mcpAllowlist":["playwright:*"]}"#).expect("perms template");
        let mcp_template = workspace.join("templates/cursor/mcp/playwright.mcp.json");
        fs::create_dir_all(mcp_template.parent().expect("mcp parent")).expect("mcp dir");
        fs::write(
            &mcp_template,
            include_str!(
                "../../resources/default-workspace/templates/cursor/mcp/playwright.mcp.json"
            ),
        )
        .expect("mcp template");
    }

    #[test]
    fn preflight_rejects_missing_skill_before_writes() {
        let workspace = temp_root("preflight-missing-skill");
        let profile = temp_root("preflight-missing-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(
            workspace.join("templates/cursor/manifest.json"),
            r#"{"recommended_pinned_skills":["missing-skill"]}"#,
        )
        .expect("manifest");
        fs::write(
            profile.join("mcp.json"),
            r#"{"mcpServers":{"custom":{"command":"node"}}}"#,
        )
        .expect("mcp");
        fs::write(
            profile.join("permissions.json"),
            r#"{"mcpAllowlist":["custom:*"]}"#,
        )
        .expect("permissions");

        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                profile.join("backups").to_string_lossy().as_ref(),
            );
            std::env::set_var(
                "CURSOR_SKILLS_PATH",
                profile.join("skills").to_string_lossy().as_ref(),
            );
        }

        let paths = test_paths(&profile);
        let mcp_before = fs::read_to_string(profile.join("mcp.json")).expect("mcp before");
        let perms_before =
            fs::read_to_string(profile.join("permissions.json")).expect("perms before");
        let result = run_global_profile(&workspace, &paths, true);
        assert!(!result.success);
        assert!(result.stderr.contains("preflight"));
        assert!(result.stderr.contains("missing-skill"));
        assert!(!profile.join("agents").exists());
        assert_eq!(
            fs::read_to_string(profile.join("mcp.json")).expect("mcp after"),
            mcp_before
        );
        assert_eq!(
            fs::read_to_string(profile.join("permissions.json")).expect("perms after"),
            perms_before
        );
        assert!(!profile.join("backups").exists());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn execution_failure_stops_before_later_stages() {
        let workspace = temp_root("exec-stop");
        let profile = temp_root("exec-stop-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(profile.join("agents"), "block agents directory").expect("block agents");
        fs::write(
            profile.join("mcp.json"),
            r#"{"mcpServers":{"custom":{"command":"node"}}}"#,
        )
        .expect("mcp");
        fs::write(
            profile.join("permissions.json"),
            r#"{"mcpAllowlist":["custom:*"]}"#,
        )
        .expect("permissions");

        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                profile.join("backups").to_string_lossy().as_ref(),
            );
            std::env::set_var(
                "CURSOR_SKILLS_PATH",
                profile.join("skills").to_string_lossy().as_ref(),
            );
        }

        let paths = test_paths(&profile);
        let mcp_before = fs::read_to_string(profile.join("mcp.json")).expect("mcp before");
        let perms_before =
            fs::read_to_string(profile.join("permissions.json")).expect("perms before");
        let result = run_global_profile(&workspace, &paths, true);
        assert!(!result.success);
        assert!(result.stderr.contains("global-agents"));
        assert!(!result.stderr.contains("global-mcp"));
        assert!(!result.stderr.contains("global-permissions"));
        assert_eq!(
            fs::read_to_string(profile.join("mcp.json")).expect("mcp after"),
            mcp_before
        );
        assert_eq!(
            fs::read_to_string(profile.join("permissions.json")).expect("perms after"),
            perms_before
        );
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn ensure_global_write_target_rejects_outside_profile_root() {
        let profile = temp_root("profile-guard");
        let paths = test_paths(&profile);
        let outside = profile.parent().unwrap().join("outside.json");
        let err = ensure_global_write_target(&paths, &outside, "mcp").expect_err("outside");
        assert!(err.contains("non-allowlisted"));
        let _ = fs::remove_dir_all(&profile);
    }

    fn profile_apply_env(
        profile: &Path,
    ) -> (
        std::sync::MutexGuard<'static, ()>,
        crate::test_env::guard::EnvRestore,
    ) {
        let guard = crate::test_env::guard::lock();
        let restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                profile.join("backups").to_string_lossy().as_ref(),
            );
            std::env::remove_var("CURSOR_SKILLS_PATH");
        }
        (guard, restore)
    }

    #[test]
    fn preflight_rejects_invalid_existing_mcp_json() {
        let workspace = temp_root("preflight-bad-mcp");
        let profile = temp_root("preflight-bad-mcp-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(profile.join("mcp.json"), "{not json").expect("bad mcp");
        fs::write(
            profile.join("permissions.json"),
            r#"{"mcpAllowlist":["custom:*"]}"#,
        )
        .expect("permissions");

        let (_guard, _restore) = profile_apply_env(&profile);
        let paths = test_paths(&profile);
        let mcp_before = fs::read_to_string(profile.join("mcp.json")).expect("mcp before");
        let result = run_global_profile(&workspace, &paths, true);
        assert!(!result.success);
        assert!(result.stderr.contains("preflight"));
        assert!(result.stderr.contains("MCP target invalid JSON"));
        assert!(!profile.join("agents").exists());
        assert!(!profile.join("skills").exists());
        assert_eq!(
            fs::read_to_string(profile.join("mcp.json")).expect("mcp after"),
            mcp_before
        );
        assert!(!profile.join("backups").exists());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn preflight_rejects_invalid_existing_permissions_json() {
        let workspace = temp_root("preflight-bad-perms");
        let profile = temp_root("preflight-bad-perms-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(
            profile.join("mcp.json"),
            r#"{"mcpServers":{"custom":{"command":"node"}}}"#,
        )
        .expect("mcp");
        fs::write(profile.join("permissions.json"), "{bad").expect("bad perms");

        let (_guard, _restore) = profile_apply_env(&profile);
        let paths = test_paths(&profile);
        let perms_before =
            fs::read_to_string(profile.join("permissions.json")).expect("perms before");
        let result = run_global_profile(&workspace, &paths, true);
        assert!(!result.success);
        assert!(result.stderr.contains("preflight"));
        assert!(result.stderr.contains("permissions target invalid JSON"));
        assert!(!profile.join("agents").exists());
        assert!(!profile.join("skills").exists());
        assert_eq!(
            fs::read_to_string(profile.join("permissions.json")).expect("perms after"),
            perms_before
        );
        assert!(!profile.join("backups").exists());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn preflight_rejects_unsafe_existing_permissions() {
        let workspace = temp_root("preflight-unsafe-perms");
        let profile = temp_root("preflight-unsafe-perms-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(
            profile.join("mcp.json"),
            r#"{"mcpServers":{"custom":{"command":"node"}}}"#,
        )
        .expect("mcp");
        fs::write(
            profile.join("permissions.json"),
            r#"{"mcpAllowlist":["*:*"]}"#,
        )
        .expect("unsafe perms");

        let (_guard, _restore) = profile_apply_env(&profile);
        let paths = test_paths(&profile);
        let perms_before =
            fs::read_to_string(profile.join("permissions.json")).expect("perms before");
        let result = run_global_profile(&workspace, &paths, true);
        assert!(!result.success);
        assert!(result.stderr.contains("preflight"));
        assert!(result
            .stderr
            .contains("existing permissions JSON failed safety check"));
        assert!(!profile.join("skills").exists());
        assert_eq!(
            fs::read_to_string(profile.join("permissions.json")).expect("perms after"),
            perms_before
        );
        assert!(!profile.join("backups").exists());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn preflight_rejects_unsafe_merged_permissions_terminal_allowlist() {
        let workspace = temp_root("preflight-unsafe-merge");
        let profile = temp_root("preflight-unsafe-merge-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(
            profile.join("mcp.json"),
            r#"{"mcpServers":{"custom":{"command":"node"}}}"#,
        )
        .expect("mcp");
        fs::write(
            profile.join("permissions.json"),
            r#"{"terminalAllowlist":["npx foo"],"mcpAllowlist":["custom:*"]}"#,
        )
        .expect("unsafe terminal");

        let (_guard, _restore) = profile_apply_env(&profile);
        let paths = test_paths(&profile);
        let result = run_global_profile(&workspace, &paths, true);
        assert!(!result.success);
        assert!(result.stderr.contains("preflight"));
        assert!(result
            .stderr
            .contains("existing permissions JSON failed safety check"));
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
    }

    #[test]
    fn profile_skills_use_resolved_paths_skills_not_env_override() {
        let workspace = temp_root("profile-skills-root");
        let profile = temp_root("profile-skills-root-profile");
        write_minimal_profile_workspace(&workspace);
        fs::write(
            profile.join("mcp.json"),
            r#"{"mcpServers":{"custom":{"command":"node"}}}"#,
        )
        .expect("mcp");
        fs::write(
            profile.join("permissions.json"),
            r#"{"mcpAllowlist":["custom:*"]}"#,
        )
        .expect("permissions");

        let wrong_skills = temp_root("wrong-skills-redirect");
        fs::create_dir_all(&wrong_skills).expect("wrong skills");

        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        unsafe {
            std::env::set_var("HOME", profile.parent().unwrap());
            std::env::set_var(
                "AGENT_WORKSPACE_BACKUP_DIR",
                profile.join("backups").to_string_lossy().as_ref(),
            );
            std::env::set_var("CURSOR_SKILLS_PATH", &wrong_skills);
        }

        let paths = test_paths(&profile);
        let result = run_global_profile(&workspace, &paths, true);
        assert!(
            result.success,
            "stderr={} stdout={}",
            result.stderr, result.stdout
        );
        assert!(profile.join("skills/diagnose/SKILL.md").is_file());
        assert!(!wrong_skills.join("diagnose").exists());
        assert!(profile.join("agents/reviewer.md").is_file());
        assert!(profile.join("mcp.json").is_file());
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&profile);
        let _ = fs::remove_dir_all(&wrong_skills);
    }
}
