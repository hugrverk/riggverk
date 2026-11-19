use serde::Serialize;
use std::path::{Path, PathBuf};

use super::status::file_eq;
use crate::cursor_profile_ops::{legacy_permission_cleanup_status, LegacyPermissionCleanupStatus};
use crate::cursor_profile_paths::{
    cursor_profile_root_display, resolve_cursor_profile_paths, CursorProfilePaths,
};
use crate::skill_health::skill_files_status;
use crate::skill_roots::{
    codex_home_is_custom, install_roots, roots_read_by, SkillRoot, SkillScope,
};
use crate::skill_sources::SkillSources;

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

/// The installed skill roots Cursor reads: the ones the enabled harnesses need that Cursor looks
/// in. When the settings cannot be read, or none of them is one Cursor reads, the root an install
/// for Cursor alone would use.
fn cursor_skill_roots(home: &Path) -> Vec<SkillRoot> {
    use crate::agent_targets::HarnessId;
    let read = SkillScope::current(home)
        .map(|scope| roots_read_by(HarnessId::Cursor, &scope))
        .unwrap_or_default();
    if read.is_empty() {
        install_roots(&[HarnessId::Cursor], codex_home_is_custom(home))
    } else {
        read
    }
}

/// Status, synced skills and expected skills of the bundled skills in `roots`. Skills come from
/// the bundle, so that is what installed files are compared with.
pub(crate) fn skill_roots_status(
    bundled_root: Option<&Path>,
    workspace_root: Option<&Path>,
    home: &Path,
    roots: &[SkillRoot],
) -> (String, usize, usize) {
    match bundled_root.map(|bundle| {
        skill_files_status(
            &SkillSources::for_health(bundle, workspace_root),
            home,
            roots,
        )
    }) {
        Some(Ok(status)) => (status.label().to_string(), status.synced, status.expected),
        _ => ("missing".to_string(), 0, 0),
    }
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

#[cfg(test)]
pub(crate) fn manifest_recommended_skills(root: &Path) -> Vec<String> {
    super::skills::workspace_skill_names(root).unwrap_or_default()
}

/// The `@playwright/mcp` version every entry the app writes pins (OpenCode, Cursor and the light
/// harnesses), and the day npm published it. `scripts/check-bundle-content.py` reads this line:
/// the bundled templates and docs must name the same version, and it warns once the release is
/// more than six months old. Bump the version and the date together.
pub(crate) const PLAYWRIGHT_MCP_VERSION: &str = "0.0.83"; // released 2026-09-28

/// The flags every entry carries after the package, in every harness: the system Google Chrome
/// (`--browser chrome`, so no Playwright Chromium download), a profile kept in memory, and no
/// tools registered by a page (`--no-webmcp`; WebMCP is on by default since 0.0.81). The
/// templates spell them out, rendering substitutes only the version, and the `playwright-pin`
/// group of `scripts/check-bundle-content.py` requires them in each template.
#[cfg(test)]
pub(crate) const PLAYWRIGHT_MCP_BROWSER_FLAGS: [&str; 4] =
    ["--browser", "chrome", "--isolated", "--no-webmcp"];

/// The full command line of every entry in `value` that runs the pinned package: its `command`
/// array, or its `command` followed by its `args`.
#[cfg(test)]
pub(crate) fn playwright_command_lines(value: &serde_json::Value) -> Vec<Vec<String>> {
    let words = |value: Option<&serde_json::Value>| -> Vec<String> {
        match value {
            Some(serde_json::Value::String(word)) => vec![word.clone()],
            Some(serde_json::Value::Array(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            _ => Vec::new(),
        }
    };
    match value {
        serde_json::Value::Object(map) if map.contains_key("command") => {
            let mut line = words(map.get("command"));
            line.extend(words(map.get("args")));
            if line.iter().any(|word| word.starts_with("@playwright/mcp@")) {
                vec![line]
            } else {
                Vec::new()
            }
        }
        serde_json::Value::Object(map) => map.values().flat_map(playwright_command_lines).collect(),
        _ => Vec::new(),
    }
}

/// `value` as the app wrote its Playwright entries before they started npx through `/bin/sh` in
/// the output folder: `npx --prefix <npx prefix> -y <package> <flags...>`, run in whatever folder
/// the harness starts it in.
#[cfg(test)]
pub(crate) fn as_the_npx_prefix_app_wrote_it(value: &serde_json::Value) -> serde_json::Value {
    // `/bin/sh` with `[-c, <script>, <prefix>, <output>, <rest...>]` ->
    // `npx` with `[--prefix, <prefix>, -y, <rest...>]`
    let unwrap = |words: &[serde_json::Value]| -> Option<Vec<serde_json::Value>> {
        match words {
            [c, script, prefix, _output, rest @ ..]
                if c == "-c" && script == PLAYWRIGHT_NPX_SCRIPT =>
            {
                let mut out = vec!["--prefix".into(), prefix.clone(), "-y".into()];
                out.extend_from_slice(rest);
                Some(out)
            }
            _ => None,
        }
    };
    match value {
        serde_json::Value::Object(map) if map.get("command").is_some_and(|c| c == "/bin/sh") => {
            let mut out = map.clone();
            let args = map.get("args").and_then(serde_json::Value::as_array);
            if let Some(args) = args.and_then(|args| unwrap(args)) {
                out.insert("command".into(), "npx".into());
                out.insert("args".into(), serde_json::Value::Array(args));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items)
            if items.first().is_some_and(|first| first == "/bin/sh") =>
        {
            match unwrap(&items[1..]) {
                Some(rest) => {
                    serde_json::Value::Array(std::iter::once("npx".into()).chain(rest).collect())
                }
                None => value.clone(),
            }
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(as_the_npx_prefix_app_wrote_it).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), as_the_npx_prefix_app_wrote_it(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `value` as the previous app wrote its Playwright entries: the 0.0.48 pin and the flags of
/// that time. The OpenCode and Cursor entries had only `--config`; the light entries had
/// `--browser chrome --isolated`. No entry had `--prefix` or the `/bin/sh` start.
#[cfg(test)]
pub(crate) fn as_the_previous_app_wrote_it(value: &serde_json::Value) -> serde_json::Value {
    with_the_old_pin_and_no_prefix(&as_the_npx_prefix_app_wrote_it(value))
}

#[cfg(test)]
fn with_the_old_pin_and_no_prefix(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items)
            if items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|word| word.starts_with("@playwright/mcp@"))
            }) =>
        {
            let has_sidecar = items.iter().any(|item| item == "--config");
            let mut out: Vec<serde_json::Value> = Vec::new();
            let mut words = items.iter();
            while let Some(item) = words.next() {
                match item.as_str() {
                    Some("--prefix") => {
                        words.next();
                    }
                    Some(word) if word.starts_with("@playwright/mcp@") => {
                        out.push("@playwright/mcp@0.0.48".into())
                    }
                    Some("--no-webmcp") => {}
                    Some("--browser" | "chrome" | "--isolated") if has_sidecar => {}
                    _ => out.push(item.clone()),
                }
            }
            serde_json::Value::Array(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(with_the_old_pin_and_no_prefix).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), with_the_old_pin_and_no_prefix(item)))
                .collect(),
        ),
        other => other.clone(),
    }
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

/// Placeholder of the folder every Playwright entry passes to `npx --prefix`.
pub(crate) const PLAYWRIGHT_NPX_PREFIX_PLACEHOLDER: &str = "__PLAYWRIGHT_NPX_PREFIX_PATH__";

/// Name of that folder in the app data dir.
pub(crate) const NPX_PREFIX_DIR_NAME: &str = "npx-prefix";

/// Placeholder of the folder every Playwright entry starts npx in.
pub(crate) const PLAYWRIGHT_OUTPUT_PLACEHOLDER: &str = "__PLAYWRIGHT_OUTPUT_PATH__";

/// Name of that folder in the app data dir.
pub(crate) const PLAYWRIGHT_OUTPUT_DIR_NAME: &str = "playwright-output";

/// How every entry starts the server: `/bin/sh` with the arguments `-c`, this, the npx prefix
/// folder, the output folder, the package and its flags. The shell changes into the output folder and runs
/// `npx --prefix <npx prefix> -y <package> <flags...>`; `/bin/sh` is absolute, so no `PATH`
/// lookup picks the shell.
#[cfg(test)]
pub(crate) const PLAYWRIGHT_NPX_SCRIPT: &str =
    r#"cd -- "$1" && shift && exec npx --prefix "$0" -y "$@""#;

/// The folder every Playwright entry passes to `npx --prefix`: an empty, owner-only folder in the
/// app data dir that the app never writes into. Without it npm takes the nearest folder with a
/// `package.json` or `node_modules` (usually the repository the agent works in) as the project,
/// loads its `.npmrc` (`node-options` can preload code) and prefers its own
/// `node_modules/@playwright/mcp`, so a hostile repository would run code as the server starts.
/// `None` when the app data dir is not an absolute path: a relative prefix would resolve against
/// the agent's working folder again.
pub(crate) fn npx_prefix_path(home: &Path) -> Option<PathBuf> {
    app_data_child(home, NPX_PREFIX_DIR_NAME)
}

/// The folder every Playwright entry starts npx in, next to the npx prefix folder. npm puts the
/// `node_modules/.bin` of the working folder and of each folder above it first on the `PATH` of
/// the package's bin, which it starts through a bare `sh`: started in a repository, an executable
/// `node_modules/.bin/sh` or `node` of that repository would run. From here the walk reaches only
/// the app's and the user's own folders. It is also the server's workspace when the client sends
/// no MCP roots, so its `.playwright-mcp` outputs and the files it saves under a given name land
/// here, never in the npx prefix folder, whose `.npmrc` and `node_modules` npm reads.
pub(crate) fn playwright_output_path(home: &Path) -> Option<PathBuf> {
    app_data_child(home, PLAYWRIGHT_OUTPUT_DIR_NAME)
}

fn app_data_child(home: &Path, name: &str) -> Option<PathBuf> {
    let home = home.to_string_lossy().into_owned();
    let env = crate::platform_paths::PlatformEnv {
        home: Some(home.clone()),
        userprofile: Some(home),
        ..crate::platform_paths::PlatformEnv::from_process_env()
    };
    let dir =
        crate::platform_paths::app_support_dir(&env, crate::platform_paths::Platform::current())
            .ok()?
            .join(name);
    dir.is_absolute().then_some(dir)
}

/// Creates the npx prefix folder and the output folder, owner-only (0700), when an MCP entry is
/// installed. An existing folder is kept as it is, and the app writes nothing into either.
pub(crate) fn ensure_npx_dirs(home: &Path) -> Result<(), String> {
    for dir in [npx_prefix_path(home), playwright_output_path(home)] {
        let dir =
            dir.ok_or_else(|| "cannot resolve the npx folders in the app data dir".to_string())?;
        if let Some(app_data) = dir.parent() {
            crate::safe_filesystem::create_private_leaf_directory(app_data)?;
        }
        crate::safe_filesystem::create_private_leaf_directory(&dir)?;
    }
    Ok(())
}

pub(crate) fn transform_playwright_template_value(
    value: &serde_json::Value,
    config_path: &str,
    browsers_path: &str,
    npx_prefix: &str,
    output_dir: &str,
) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                out.insert(
                    key.clone(),
                    transform_playwright_template_value(
                        child,
                        config_path,
                        browsers_path,
                        npx_prefix,
                        output_dir,
                    ),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| {
                    transform_playwright_template_value(
                        item,
                        config_path,
                        browsers_path,
                        npx_prefix,
                        output_dir,
                    )
                })
                .collect(),
        ),
        serde_json::Value::String(text) => {
            if text == "__PLAYWRIGHT_MCP_CONFIG_PATH__" {
                serde_json::Value::String(config_path.to_string())
            } else if text == "__PLAYWRIGHT_BROWSERS_PATH__" {
                serde_json::Value::String(browsers_path.to_string())
            } else if text == PLAYWRIGHT_NPX_PREFIX_PLACEHOLDER {
                serde_json::Value::String(npx_prefix.to_string())
            } else if text == PLAYWRIGHT_OUTPUT_PLACEHOLDER {
                serde_json::Value::String(output_dir.to_string())
            } else if text.starts_with("@playwright/mcp@") {
                serde_json::Value::String(format!("@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}"))
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
    let Some(npx_prefix) = npx_prefix_path(&paths.user_home) else {
        return "unsupported-platform".into();
    };
    let Some(output_dir) = playwright_output_path(&paths.user_home) else {
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
                &npx_prefix.to_string_lossy(),
                &output_dir.to_string_lossy(),
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

/// Whether the bundled Cursor manifest is one this app installs from. Reported as its own row;
/// it no longer decides the overall status, since the bundle cannot fall behind the app.
fn workspace_resources_status(root: &Path, warnings: &mut Vec<String>) -> String {
    let manifest_path = cursor_root(root).join("manifest.json");
    if !manifest_path.is_file() {
        warnings.push("The bundled Cursor manifest.json is missing.".into());
        return "stale".into();
    }
    let manifest_content = match std::fs::read_to_string(&manifest_path) {
        Ok(content) => content,
        Err(_) => return "unreadable".into(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&manifest_content) {
        Ok(parsed) => parsed,
        Err(_) => {
            warnings.push("The bundled Cursor manifest.json is invalid.".into());
            return "stale".into();
        }
    };
    if parsed
        .get(CURSOR_SETUP_RUNTIME_KEY)
        .and_then(|v| v.as_str())
        != Some(CURSOR_SETUP_RUNTIME_NATIVE)
    {
        warnings
            .push("The bundled Cursor manifest is stale (missing native setup_runtime).".into());
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

/// Installed Cursor files compared with the app's bundle, the source every install copies from;
/// the workspace folder plays no part.
#[tauri::command]
pub fn get_cursor_profile_health() -> Result<CursorProfileHealth, String> {
    let root = crate::setup_roots::bundled_root()?;
    // The data folder only adds the packs' skills to what the install is compared with.
    let workspace_root = super::workspace::setup_workspace_target_path().ok();
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

    let (global_skills_status, global_skills_count, expected_global_skills_count) =
        skill_roots_status(
            Some(&root),
            workspace_root.as_deref(),
            &paths.user_home,
            &cursor_skill_roots(&paths.user_home),
        );

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
    let status = if manifest_status != "valid" {
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
        "synced" => {
            "Cursor setup is synced. Select Auto Review in Cursor Settings > Agents > Run Mode. Riggverk cannot verify the active run mode."
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
        "diverged" => "Review the managed differences, then run Install or Update.".into(),
        _ => "Review the Cursor setup, then run Install or Update.".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
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
        let cursor = root.join("templates/cursor");
        fs::create_dir_all(&cursor).expect("cursor dir");
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
    fn workspace_resources_current_when_manifest_ok() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let mut warnings = Vec::new();
        let status = workspace_resources_status(&root, &mut warnings);
        assert_eq!(status, "current", "warnings: {:?}", warnings);
    }

    #[test]
    fn cursor_skill_status_compares_the_bundled_skill_files_in_the_given_roots() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("cursor-skill-bundle-{nonce}"));
        let home = base.join("home");
        let bundle = base.join("bundle");
        fs::create_dir_all(&home).expect("home");
        crate::test_env::set_test_user_dirs(&home);
        unsafe { std::env::remove_var("CLAUDE_SKILLS_PATH") };
        crate::test_env::write_canonical_skill(&bundle, None, "frontend-design", "body");
        let installed = home.join(".claude/skills/frontend-design");
        fs::create_dir_all(&installed).expect("installed dir");
        let canonical = fs::read_to_string(bundle.join("skills/frontend-design/SKILL.md")).unwrap();
        fs::write(installed.join("SKILL.md"), &canonical).expect("write installed");
        let roots = [SkillRoot::Claude];

        let synced = skill_roots_status(Some(&bundle), None, &home, &roots);
        fs::write(installed.join("SKILL.md"), "an older per-harness copy\n").expect("diverge");
        let diverged = skill_roots_status(Some(&bundle), None, &home, &roots);
        let elsewhere = skill_roots_status(Some(&bundle), None, &home, &[SkillRoot::Agents]);
        let no_bundle = skill_roots_status(None, None, &home, &roots);
        let _ = fs::remove_dir_all(&base);

        assert_eq!(synced, ("synced".to_string(), 1, 1));
        assert_eq!(diverged, ("diverged".to_string(), 0, 1));
        assert_eq!(elsewhere, ("missing".to_string(), 0, 1));
        assert_eq!(no_bundle, ("missing".to_string(), 0, 0));
    }

    fn bundled_json(rel: &str) -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../resources/default-workspace")
            .join(rel);
        serde_json::from_str(&std::fs::read_to_string(path).expect("bundled file"))
            .expect("bundled JSON")
    }

    #[test]
    fn every_rendered_playwright_entry_uses_system_chrome_and_turns_webmcp_off() {
        let home = Path::new("/home/someone");
        let opencode = super::super::opencode_runtime::render_expected_opencode_config(
            &bundled_json("templates/opencode.json"),
            home,
        )
        .expect("rendered OpenCode config");
        let opencode_prefix = npx_prefix_path(home).expect("npx prefix");
        let opencode_output = playwright_output_path(home).expect("output folder");
        let mut rendered = vec![(
            "opencode",
            opencode,
            opencode_prefix.to_string_lossy().into_owned(),
            opencode_output.to_string_lossy().into_owned(),
        )];
        for (name, rel) in [
            ("cursor", "templates/cursor/mcp/playwright.mcp.json"),
            ("copilot", "templates/mcp/copilot.playwright.json"),
            ("pi", "templates/mcp/pi.playwright.json"),
            ("kilo", "templates/mcp/kilo.playwright.json"),
            ("antigravity", "templates/mcp/antigravity.playwright.json"),
            ("grok", "templates/mcp/grok.playwright.json"),
        ] {
            rendered.push((
                name,
                transform_playwright_template_value(
                    &bundled_json(rel),
                    "/cfg.json",
                    "/browsers",
                    "/prefix",
                    "/output",
                ),
                "/prefix".to_string(),
                "/output".to_string(),
            ));
        }
        for (name, entry, prefix, output) in rendered {
            let lists = playwright_command_lines(&entry);
            assert_eq!(lists.len(), 1, "{name}: {entry}");
            let words: Vec<&str> = lists[0].iter().map(String::as_str).collect();
            // The absolute shell starts npx in the app's output folder with the app's empty
            // prefix folder as its project, never in or from the agent's project.
            assert_eq!(
                words[..6],
                [
                    "/bin/sh",
                    "-c",
                    PLAYWRIGHT_NPX_SCRIPT,
                    prefix.as_str(),
                    output.as_str(),
                    format!("@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}").as_str(),
                ],
                "{name}: {words:?}"
            );
            assert!(
                !entry.to_string().contains("__PLAYWRIGHT_"),
                "{name}: {entry}"
            );
            assert!(
                words
                    .windows(PLAYWRIGHT_MCP_BROWSER_FLAGS.len())
                    .any(|window| window == PLAYWRIGHT_MCP_BROWSER_FLAGS),
                "{name}: {words:?}"
            );
            assert!(words.contains(&format!("@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}").as_str()));
            // The system Chrome, never Playwright's own Chromium (that would need a download).
            assert!(!words.contains(&"chromium"), "{name}: {words:?}");
        }
        // The Codex reference snippet is TOML and not rendered; its arguments are the OpenCode ones.
        let codex = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../resources/default-workspace/templates/codex/mcp/playwright.toml"),
        )
        .expect("Codex snippet");
        let flags = PLAYWRIGHT_MCP_BROWSER_FLAGS
            .iter()
            .map(|flag| format!("\"{flag}\""))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(codex.contains(&flags), "{codex}");
        assert!(codex.contains(r#"command = "/bin/sh""#), "{codex}");
        assert!(
            codex.contains(&format!(
                r#"args = ["-c", '{PLAYWRIGHT_NPX_SCRIPT}', "__PLAYWRIGHT_NPX_PREFIX_PATH__", "__PLAYWRIGHT_OUTPUT_PATH__", "@playwright/mcp@{PLAYWRIGHT_MCP_VERSION}", "#
            )),
            "{codex}"
        );
    }

    #[test]
    fn the_npx_folders_are_absolute_folders_in_the_app_data_dir() {
        let home = Path::new("/home/someone");
        for (dir, name) in [
            (npx_prefix_path(home), NPX_PREFIX_DIR_NAME),
            (playwright_output_path(home), PLAYWRIGHT_OUTPUT_DIR_NAME),
        ] {
            let dir = dir.expect("folder");
            assert!(dir.is_absolute(), "{}", dir.display());
            assert!(dir.ends_with(Path::new(crate::platform_paths::APP_DATA_DIR_NAME).join(name)));
            if cfg!(target_os = "macos") {
                assert_eq!(
                    dir,
                    home.join("Library/Application Support/se.hugrverk.riggverk")
                        .join(name)
                );
            }
        }
    }

    /// The script the entries pass to `/bin/sh`, run by the real shell: it starts `npx` in the
    /// output folder with the prefix folder as `--prefix`, and passes the package and its flags
    /// on unchanged, a path with a space included.
    #[cfg(unix)]
    #[test]
    fn the_npx_script_starts_npx_in_the_output_folder_with_the_prefix() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!(
            "aw-npx-script-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bin = base.join("bin");
        let prefix = base.join("app data/npx-prefix");
        let output = base.join("app data/playwright-output");
        for dir in [&bin, &prefix, &output] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // A stand-in `npx` that prints its working folder and its arguments, one per line.
        let npx = bin.join("npx");
        std::fs::write(
            &npx,
            "#!/bin/sh\npwd -P\nfor a in \"$@\"; do echo \"$a\"; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ran = std::process::Command::new("/bin/sh")
            .args(["-c", PLAYWRIGHT_NPX_SCRIPT])
            .arg(&prefix)
            .arg(&output)
            .args(["@playwright/mcp@0.0.83", "--browser", "chrome", "--a b"])
            .current_dir(&base)
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .output()
            .expect("run /bin/sh");
        assert!(ran.status.success(), "{ran:?}");
        let printed = String::from_utf8(ran.stdout).unwrap();
        let lines: Vec<&str> = printed.lines().collect();
        let output_real = output.canonicalize().unwrap();
        let prefix_text = prefix.to_string_lossy();
        assert_eq!(
            lines,
            [
                output_real.to_str().unwrap(),
                "--prefix",
                prefix_text.as_ref(),
                "-y",
                "@playwright/mcp@0.0.83",
                "--browser",
                "chrome",
                "--a b",
            ]
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn the_npx_folders_are_created_owner_only_and_left_empty() {
        use std::os::unix::fs::PermissionsExt;
        let _env = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::isolate_data_location_env();
        let base = std::env::temp_dir().join(format!(
            "aw-npx-prefix-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = base.join("home");
        std::fs::create_dir_all(&home).unwrap();
        crate::test_env::set_test_user_dirs(&home);
        ensure_npx_dirs(&home).expect("create");
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let dirs = [npx_prefix_path(&home), playwright_output_path(&home)].map(Option::unwrap);
        for dir in &dirs {
            assert!(dir.starts_with(&base), "{}", dir.display());
            assert_eq!(mode(dir), 0o700);
            assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0);
        }
        // A second install keeps the folders.
        ensure_npx_dirs(&home).expect("again");
        for dir in &dirs {
            assert_eq!(mode(dir), 0o700);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_older_apps_wrote_the_npx_prefix_only_and_before_that_the_old_pin_and_flags() {
        let script = PLAYWRIGHT_NPX_SCRIPT;
        let entry = serde_json::json!({
            "opencode": {"command": ["/bin/sh", "-c", script, "/p", "/o",
                "@playwright/mcp@0.0.83", "--config", "c.json", "--browser", "chrome",
                "--isolated", "--no-webmcp"]},
            "light": {"command": "/bin/sh", "args": ["-c", script, "/p", "/o",
                "@playwright/mcp@0.0.83", "--browser", "chrome", "--isolated", "--no-webmcp"],
                "env": {}},
            "other": {"command": ["npx", "-y", "other@1.0.0", "--no-webmcp"]},
        });
        assert_eq!(
            as_the_npx_prefix_app_wrote_it(&entry),
            serde_json::json!({
                "opencode": {"command": ["npx", "--prefix", "/p", "-y", "@playwright/mcp@0.0.83",
                    "--config", "c.json", "--browser", "chrome", "--isolated", "--no-webmcp"]},
                "light": {"command": "npx", "args": ["--prefix", "/p", "-y",
                    "@playwright/mcp@0.0.83", "--browser", "chrome", "--isolated",
                    "--no-webmcp"], "env": {}},
                "other": {"command": ["npx", "-y", "other@1.0.0", "--no-webmcp"]},
            })
        );
        assert_eq!(
            as_the_previous_app_wrote_it(&entry),
            serde_json::json!({
                "opencode": {"command": ["npx", "-y", "@playwright/mcp@0.0.48", "--config",
                    "c.json"]},
                "light": {"command": "npx", "args": ["-y", "@playwright/mcp@0.0.48", "--browser",
                    "chrome", "--isolated"], "env": {}},
                "other": {"command": ["npx", "-y", "other@1.0.0", "--no-webmcp"]},
            })
        );
    }

    #[test]
    fn cursor_script_arg_strips_extended_prefix_for_bash() {
        let path = PathBuf::from(
            r"\\?\C:\Users\Example\.config\riggverk\scripts\generate-opencode-config.py",
        );
        assert_eq!(
            path_arg_for_bash(&path).expect("bash script path"),
            "C:/Users/Example/.config/riggverk/scripts/generate-opencode-config.py"
        );
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
}
