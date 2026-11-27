use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::opencode_cli::{self, AgentProbe, CliVersion, OpenCodeCliHealth, VersionProbe};
#[cfg(test)]
use super::process::ActionResult;
use super::process::{run_cmd_bounded, BoundedCmdOptions, BoundedCmdResult};
use super::status::file_eq;
use crate::opencode_precedence::{self, ConfigRead, OpenCodeConfigPrecedence};

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
    pub checked_version: Option<String>,
    pub status: String,
    pub template_config_path: String,
    pub installed_config_path: String,
    pub checks: Vec<OpenCodeRuntimeCheck>,
    pub default_agent: Option<String>,
    pub model: Option<String>,
    pub small_model: Option<String>,
    /// The shared installed subagent model, excluding inspector while a critic override is set;
    /// `None` when the roles inherit the main model (or do not agree).
    pub subagent_model: Option<String>,
    /// The installed inspector model; `None` when inspector inherits the main model.
    pub critic_model: Option<String>,
    pub autoupdate: Option<String>,
    pub snapshot: Option<bool>,
    pub bundled_agent_count: usize,
    pub installed_bundled_agent_count: usize,
    pub extra_installed_agent_count: usize,
    pub agent_mismatches: Vec<OpenCodeAgentMismatch>,
    pub warnings: Vec<String>,
    /// The installed CLI; `None` until it has been probed.
    pub cli: Option<OpenCodeCliHealth>,
    /// `opencode.json` against the bundled render: `synced`, `diverged`, `missing`, `invalid` or
    /// `unknown` (nothing to compare against).
    pub config_status: String,
    /// Managed keys that differ: top-level names, `mcp.<server>` and `agent.<name>`.
    pub config_diverged_keys: Vec<String>,
    /// Global `AGENTS.md` against the bundled rules: `synced`, `diverged`, `missing` or `unknown`.
    pub rules_status: String,
    /// The `@playwright/mcp` version pinned in the installed config.
    pub playwright_mcp_version: Option<String>,
    /// What else decides the config OpenCode runs: a JSONC `opencode.json`, sibling files that
    /// set managed keys, config env vars and a system managed config. Names only.
    pub config_precedence: OpenCodeConfigPrecedence,
    // New TUI fields
    pub template_tui_path: String,
    pub installed_tui_path: String,
    pub tui_status: String,
    /// Managed `tui.json` keys that differ from the bundled config, by name; empty when it matches
    /// or cannot be compared (a missing or unusable file).
    pub tui_diverged_keys: Vec<String>,
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

const PLAYWRIGHT_MCP_VERSION_DEFAULT: &str = super::cursor_profile::PLAYWRIGHT_MCP_VERSION;
const PLAYWRIGHT_MCP_CONFIG_PLACEHOLDER: &str = "__PLAYWRIGHT_MCP_CONFIG_PATH__";
const PLAYWRIGHT_BROWSERS_PLACEHOLDER: &str = "__PLAYWRIGHT_BROWSERS_PATH__";

/// Keys the app manages in opencode.json (`metadata/opencode-managed-keys.json`).
const MANAGED_TOP_LEVEL_KEYS: &[&str] = &[
    "$schema",
    "share",
    "autoupdate",
    "snapshot",
    "model",
    "small_model",
    "default_agent",
    "lsp",
    "compaction",
    "watcher",
    "permission",
];

/// MCP servers the app manages under `mcp` (`mcp_servers` in the metadata file).
const MANAGED_MCP_SERVERS: &[&str] = &["playwright"];

/// Built-in agents whose `agent.<name>.permission` block the app manages (`agent_permissions`
/// in the metadata file).
///
/// OpenCode builds `plan` and `explore` as defaults + a read-only restriction + the global
/// `permission`, so the global block re-opens them. The `agent.<name>.permission` block is
/// appended after the global one and restores the restriction. Only that block is managed: the
/// rest of `agent.<name>` (model, prompt, ...) and every other agent name stay user-owned.
const MANAGED_AGENT_PERMISSIONS: &[&str] = &["plan", "explore"];

/// The bundled subagents (`mode: subagent`) whose `agent.<role>.model` the app manages while a
/// subagent model override is set (`subagent_model_roles` in the metadata file).
///
/// The bundled agent files carry no model, so the entry in `opencode.json` is what pins a role
/// to the override. Only the `model` field is managed: every other key of `agent.<role>` stays
/// user-owned, and the entries are removed again when the override is cleared. The primary agent
/// (`architect`) and OpenCode's own agents are not part of this: they use the main model.
const SUBAGENT_MODEL_ROLES: &[&str] =
    &["repo-scout", "inspector", "sentinel", "verifier", "scribe"];
const CRITIC_MODEL_ROLE: &str = "inspector";

fn agent_permission<'a>(
    config: &'a serde_json::Value,
    name: &str,
) -> Option<&'a serde_json::Value> {
    config.get("agent")?.get(name)?.get("permission")
}

fn agent_model<'a>(config: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    config.get("agent")?.get(name)?.get("model")
}

/// The model every subagent role is pinned to in `config`, or `None` when a role has none or the
/// roles disagree. Inspector follows its own model while a critic override is set.
fn shared_subagent_model(config: &serde_json::Value, critic_is_overridden: bool) -> Option<String> {
    let mut models = SUBAGENT_MODEL_ROLES
        .iter()
        .filter(|&&role| !critic_is_overridden || role != CRITIC_MODEL_ROLE)
        .map(|role| agent_model(config, role).and_then(serde_json::Value::as_str));
    let first = models.next()??;
    models
        .all(|model| model == Some(first))
        .then(|| first.to_string())
}

/// Remove a managed agent field, and the agent entry and object it leaves empty.
/// Anything else a user keeps there is untouched.
fn remove_agent_field(
    config: &mut serde_json::Map<String, serde_json::Value>,
    role: &str,
    field: &str,
) {
    let Some(agent) = config
        .get_mut("agent")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let Some(entry) = agent
        .get_mut(role)
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if entry.shift_remove(field).is_none() {
        return;
    }
    if entry.is_empty() {
        agent.shift_remove(role);
    }
    if agent.is_empty() {
        config.shift_remove("agent");
    }
}

/// The `agent.<role>.model` values the app may change in `opencode.json`, by role: the one the
/// model override pins now and the one the managed record says the app wrote. Any other value of
/// a role is the user's own: drift, conflicts and digests ignore it, and an install keeps it.
#[derive(Clone, Debug, Default)]
pub(crate) struct AppRoleModels {
    pinned: BTreeMap<String, String>,
    recorded: BTreeMap<String, String>,
}

impl AppRoleModels {
    /// The override saved for `home` and the record kept in the workspace at `workspace_root`.
    /// No readable record (none yet, or one from an older version) proves nothing.
    pub(crate) fn load(workspace_root: Option<&Path>, home: &Path) -> Self {
        let identity = crate::managed_state::artifact_identity(
            &crate::artifact_registry::ArtifactId::OpenCodeConfig,
        );
        let recorded = workspace_root
            .and_then(crate::managed_state::read_managed_state)
            .and_then(|state| {
                state
                    .artifacts
                    .into_iter()
                    .find(|record| record.identity == identity)
            })
            .map(|record| record.role_models)
            .unwrap_or_default();
        Self {
            pinned: pinned_role_models(home),
            recorded,
        }
    }

    fn owns(&self, role: &str, model: &serde_json::Value) -> bool {
        let Some(model) = model.as_str() else {
            return false;
        };
        self.pinned.get(role).is_some_and(|m| m == model)
            || self.recorded.get(role).is_some_and(|m| m == model)
    }

    /// The roles whose model in `config` is the user's own.
    fn user_roles(&self, config: &serde_json::Value) -> Vec<&'static str> {
        SUBAGENT_MODEL_ROLES
            .iter()
            .copied()
            .filter(|role| agent_model(config, role).is_some_and(|model| !self.owns(role, model)))
            .collect()
    }
}

/// The role models the override saved for `home` pins, as an install writes them.
pub(crate) fn pinned_role_models(home: &Path) -> BTreeMap<String, String> {
    let mut pinned = BTreeMap::new();
    let Some(model_override) = read_stored_opencode_model_override_for_home(home) else {
        return pinned;
    };
    if let Some(model) = model_override.subagent_model {
        for role in SUBAGENT_MODEL_ROLES {
            pinned.insert((*role).to_string(), model.clone());
        }
    }
    if let Some(model) = model_override.critic_model {
        pinned.insert(CRITIC_MODEL_ROLE.to_string(), model);
    }
    pinned
}

/// `config` without the role models that are the user's own: the view of it that drift,
/// conflicts and digests compare.
pub(crate) fn without_user_role_models(
    config: &serde_json::Value,
    app: &AppRoleModels,
) -> serde_json::Value {
    let mut config = config.clone();
    let roles = app.user_roles(&config);
    if let Some(obj) = config.as_object_mut() {
        for role in roles {
            remove_agent_field(obj, role, "model");
        }
    }
    config
}

/// `config` with the model of every role the override does not pin set back to the one the app
/// recorded writing. A file that only differs from the record there was changed by the user on
/// roles that are theirs now, so the record still holds for everything the app manages.
pub(crate) fn with_recorded_role_models(
    config: &serde_json::Value,
    app: &AppRoleModels,
) -> serde_json::Value {
    let mut config = config.clone();
    if let Some(obj) = config.as_object_mut() {
        for (role, model) in &app.recorded {
            if !app.pinned.contains_key(role) {
                set_agent_model(obj, role, serde_json::Value::String(model.clone()));
            }
        }
    }
    config
}

/// The managed projection an install merges into `installed`: `rendered`'s, plus the user's own
/// role models from `installed`, so the merge leaves them as they are. A role the override pins
/// takes the override's model.
pub(crate) fn managed_opencode_install_projection(
    installed: &serde_json::Value,
    rendered: &serde_json::Value,
    app: &AppRoleModels,
) -> serde_json::Value {
    let mut managed = extract_managed_opencode_config(rendered);
    for role in app.user_roles(installed) {
        if agent_model(&managed, role).is_some() {
            continue;
        }
        if let (Some(model), Some(obj)) = (agent_model(installed, role), managed.as_object_mut()) {
            set_agent_model(obj, role, model.clone());
        }
    }
    managed
}

fn set_agent_model(
    config: &mut serde_json::Map<String, serde_json::Value>,
    role: &str,
    model: serde_json::Value,
) {
    let agent = config
        .entry("agent")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let Some(agent) = agent.as_object_mut() else {
        return;
    };
    let entry = agent
        .entry(role.to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if let Some(entry) = entry.as_object_mut() {
        entry.insert("model".to_string(), model);
    }
}

pub(crate) fn extract_managed_opencode_config(config: &serde_json::Value) -> serde_json::Value {
    let mut managed = serde_json::Map::new();
    if let Some(obj) = config.as_object() {
        for key in MANAGED_TOP_LEVEL_KEYS {
            if let Some(value) = obj.get(*key) {
                managed.insert((*key).to_string(), value.clone());
            }
        }
        let mut mcp = serde_json::Map::new();
        for server in MANAGED_MCP_SERVERS {
            if let Some(entry) = obj.get("mcp").and_then(|mcp| mcp.get(*server)) {
                mcp.insert((*server).to_string(), entry.clone());
            }
        }
        if !mcp.is_empty() {
            managed.insert("mcp".to_string(), serde_json::Value::Object(mcp));
        }
        let mut agent = serde_json::Map::new();
        for name in MANAGED_AGENT_PERMISSIONS {
            if let Some(permission) = agent_permission(config, name) {
                let mut entry = serde_json::Map::new();
                entry.insert("permission".to_string(), permission.clone());
                agent.insert((*name).to_string(), serde_json::Value::Object(entry));
            }
        }
        for role in SUBAGENT_MODEL_ROLES {
            if let Some(model) = agent_model(config, role) {
                let entry = agent
                    .entry((*role).to_string())
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
                if let Some(entry) = entry.as_object_mut() {
                    entry.insert("model".to_string(), model.clone());
                }
            }
        }
        if !agent.is_empty() {
            managed.insert("agent".to_string(), serde_json::Value::Object(agent));
        }
    }
    serde_json::Value::Object(managed)
}

/// Names of the managed keys `config` sets: top-level names, `mcp.<server>`,
/// `agent.<plan|explore>.permission` and `agent.<role>.model`. `$schema` is left out: it changes
/// nothing OpenCode runs. Only names, never values.
pub(crate) fn managed_opencode_key_names(config: &serde_json::Value) -> Vec<String> {
    let managed = extract_managed_opencode_config(config);
    let Some(managed) = managed.as_object() else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for (key, value) in managed {
        match key.as_str() {
            "$schema" => {}
            "mcp" | "agent" => {
                for (name, entry) in value.as_object().into_iter().flatten() {
                    if key == "mcp" {
                        names.push(format!("mcp.{name}"));
                    } else {
                        for field in entry.as_object().into_iter().flatten().map(|(f, _)| f) {
                            names.push(format!("agent.{name}.{field}"));
                        }
                    }
                }
            }
            _ => names.push(key.clone()),
        }
    }
    names
}

/// Structural equality that also requires object keys to appear in the same order.
///
/// `serde_json::Value` equality ignores key order, but OpenCode evaluates `permission`
/// rules last-match-wins in key order, so a reordered (e.g. sorted) block is a different policy.
fn ordered_json_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    match (a, b) {
        (serde_json::Value::Object(x), serde_json::Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|((kx, vx), (ky, vy))| kx == ky && ordered_json_eq(vx, vy))
        }
        (serde_json::Value::Array(x), serde_json::Value::Array(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y.iter())
                    .all(|(vx, vy)| ordered_json_eq(vx, vy))
        }
        _ => a == b,
    }
}

/// Names of the managed keys on which `installed` differs from `rendered`: a top-level key,
/// `mcp.<server>`, `agent.<name>` or `agent.<role>.model`, in that order.
///
/// Rule order is policy (last match wins) in the global `permission` block and in the managed
/// agent blocks, so a reordered block counts as different there.
pub(crate) fn differing_managed_opencode_keys(
    installed: &serde_json::Value,
    rendered: &serde_json::Value,
) -> Vec<String> {
    let installed = extract_managed_opencode_config(installed);
    let rendered = extract_managed_opencode_config(rendered);
    let differs = |a: Option<&serde_json::Value>, b: Option<&serde_json::Value>, ordered: bool| {
        match (a, b) {
            (Some(a), Some(b)) if ordered => !ordered_json_eq(a, b),
            (Some(a), Some(b)) => a != b,
            (None, None) => false,
            _ => true,
        }
    };
    let entry = |config: &serde_json::Value,
                 group: &str,
                 name: &str|
     -> Option<serde_json::Value> { config.get(group)?.get(name).cloned() };
    let mut keys = Vec::new();
    for key in MANAGED_TOP_LEVEL_KEYS {
        if matches!(*key, "model" | "small_model") && rendered.get(*key).is_none() {
            continue;
        }
        if differs(
            installed.get(*key),
            rendered.get(*key),
            *key == "permission",
        ) {
            keys.push((*key).to_string());
        }
    }
    for server in MANAGED_MCP_SERVERS {
        let (a, b) = (
            entry(&installed, "mcp", server),
            entry(&rendered, "mcp", server),
        );
        if differs(a.as_ref(), b.as_ref(), false) {
            keys.push(format!("mcp.{server}"));
        }
    }
    for name in MANAGED_AGENT_PERMISSIONS {
        let (a, b) = (
            entry(&installed, "agent", name),
            entry(&rendered, "agent", name),
        );
        if differs(a.as_ref(), b.as_ref(), true) {
            keys.push(format!("agent.{name}"));
        }
    }
    for role in SUBAGENT_MODEL_ROLES {
        if differs(
            agent_model(&installed, role),
            agent_model(&rendered, role),
            false,
        ) {
            keys.push(format!("agent.{role}.model"));
        }
    }
    keys
}

pub(crate) fn managed_opencode_keys_match(
    installed: &serde_json::Value,
    rendered: &serde_json::Value,
) -> bool {
    differing_managed_opencode_keys(installed, rendered).is_empty()
}

/// Serialize a merged config while retaining the original bytes of unchanged model values.
/// Both inputs have already been parsed as strict JSON. Duplicate keys use the last value,
/// matching serde_json's object semantics.
pub(crate) fn serialize_opencode_preserving_models(
    original: &str,
    merged: &serde_json::Value,
) -> Result<String, String> {
    fn spans(text: &str) -> Result<std::collections::HashMap<String, (usize, usize)>, String> {
        let bytes = text.as_bytes();
        let mut i = 0;
        let skip = |i: &mut usize| {
            while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
                *i += 1;
            }
        };
        skip(&mut i);
        if bytes.get(i) != Some(&b'{') {
            return Err("config is not an object".into());
        }
        i += 1;
        let mut found = std::collections::HashMap::new();
        loop {
            skip(&mut i);
            if bytes.get(i) == Some(&b'}') {
                break;
            }
            let mut keys = serde_json::Deserializer::from_str(&text[i..]).into_iter::<String>();
            let key = keys
                .next()
                .ok_or("missing JSON key")?
                .map_err(|_| "invalid JSON key")?;
            i += keys.byte_offset();
            skip(&mut i);
            if bytes.get(i) != Some(&b':') {
                return Err("missing JSON colon".into());
            }
            i += 1;
            skip(&mut i);
            let start = i;
            let mut values =
                serde_json::Deserializer::from_str(&text[i..]).into_iter::<serde_json::Value>();
            values
                .next()
                .ok_or("missing JSON value")?
                .map_err(|_| "invalid JSON value")?;
            i += values.byte_offset();
            if matches!(key.as_str(), "model" | "small_model") {
                found.insert(key, (start, i));
            }
            skip(&mut i);
            match bytes.get(i) {
                Some(b',') => i += 1,
                Some(b'}') => break,
                _ => return Err("invalid JSON object".into()),
            }
        }
        Ok(found)
    }
    let mut rendered =
        serde_json::to_string_pretty(merged).map_err(|_| "serialize opencode config")?;
    let originals = spans(original)?;
    let destinations = spans(&rendered)?;
    let mut replacements = Vec::new();
    for (key, (start, end)) in originals {
        if let Some(&(new_start, new_end)) = destinations.get(&key) {
            let old: serde_json::Value =
                serde_json::from_str(&original[start..end]).map_err(|_| "invalid model value")?;
            if merged.get(&key) == Some(&old) {
                replacements.push((new_start, new_end, &original[start..end]));
            }
        }
    }
    replacements.sort_by_key(|(start, _, _)| std::cmp::Reverse(*start));
    for (start, end, raw) in replacements {
        rendered.replace_range(start..end, raw);
    }
    rendered.push('\n');
    Ok(rendered)
}

/// Align the managed projection with `managed`, removing absent entries and preserving user fields
/// and their order. The same operation restores the backup projection on rollback.
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
        } else if !matches!(*key, "model" | "small_model") {
            target.shift_remove(*key);
        }
    }
    for server in MANAGED_MCP_SERVERS {
        if let Some(managed_server) = managed_obj.get("mcp").and_then(|v| v.get(*server)) {
            let mcp = target
                .entry("mcp")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let Some(mcp_obj) = mcp.as_object_mut() {
                mcp_obj.insert((*server).to_string(), managed_server.clone());
            }
        } else if let Some(mcp) = target
            .get_mut("mcp")
            .and_then(serde_json::Value::as_object_mut)
        {
            if mcp.shift_remove(*server).is_some() && mcp.is_empty() {
                target.shift_remove("mcp");
            }
        }
    }
    for name in MANAGED_AGENT_PERMISSIONS {
        if let Some(permission) = agent_permission(managed, name) {
            let agent = target
                .entry("agent")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            let Some(agent_obj) = agent.as_object_mut() else {
                continue;
            };
            let entry = agent_obj
                .entry((*name).to_string())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let Some(entry_obj) = entry.as_object_mut() {
                entry_obj.insert("permission".to_string(), permission.clone());
            }
        } else {
            remove_agent_field(target, name, "permission");
        }
    }
    // A role without a model in `managed` loses its managed one: that is how a cleared override
    // leaves the installed config.
    for role in SUBAGENT_MODEL_ROLES {
        let Some(model) = agent_model(managed, role) else {
            remove_agent_field(target, role, "model");
            continue;
        };
        let agent = target
            .entry("agent")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        let Some(agent_obj) = agent.as_object_mut() else {
            continue;
        };
        let entry = agent_obj
            .entry((*role).to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let Some(entry_obj) = entry.as_object_mut() {
            entry_obj.insert("model".to_string(), model.clone());
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

/// Default browser cache path.
fn default_playwright_browsers_path(home_dir: &Path) -> Option<std::path::PathBuf> {
    crate::commands::cursor_profile::default_playwright_browsers_path(home_dir)
}

/// Default Playwright MCP config path.
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
    npx_prefix: &str,
    output_dir: &str,
    version: &str,
) -> serde_json::Value {
    let package = format!("@playwright/mcp@{version}");
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, item) in map {
                out.insert(
                    key.clone(),
                    transform_playwright_json(
                        item,
                        config_path,
                        browsers_path,
                        npx_prefix,
                        output_dir,
                        version,
                    ),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| {
                    transform_playwright_json(
                        item,
                        config_path,
                        browsers_path,
                        npx_prefix,
                        output_dir,
                        version,
                    )
                })
                .collect(),
        ),
        serde_json::Value::String(text) => {
            if text == PLAYWRIGHT_MCP_CONFIG_PLACEHOLDER {
                serde_json::Value::String(config_path.to_string())
            } else if text == PLAYWRIGHT_BROWSERS_PLACEHOLDER {
                serde_json::Value::String(browsers_path.to_string())
            } else if text == crate::commands::cursor_profile::PLAYWRIGHT_NPX_PREFIX_PLACEHOLDER {
                serde_json::Value::String(npx_prefix.to_string())
            } else if text == crate::commands::cursor_profile::PLAYWRIGHT_OUTPUT_PLACEHOLDER {
                serde_json::Value::String(output_dir.to_string())
            } else if text.starts_with("@playwright/mcp@") {
                serde_json::Value::String(package)
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

/// Set `agent.<role>.model` of the given roles to `model`, keeping the other keys of the
/// template's `agent` block.
fn pin_agent_models(
    config: &mut serde_json::Map<String, serde_json::Value>,
    roles: &[&str],
    model: &str,
) {
    for role in roles {
        set_agent_model(config, role, serde_json::Value::String(model.to_string()));
    }
}

/// Render bundled `templates/opencode.json` the way an install renders it before sync.
///
/// Applies Playwright placeholder transformations and overlays the app-level model override
/// (`model`, `small_model`, subagent and critic models as `agent.<role>.model` entries, each only if
/// the file holds it) so that the installed config comparison reflects any user model selection.
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
    let npx_prefix = crate::commands::cursor_profile::npx_prefix_path(home_dir)?;
    let output_dir = crate::commands::cursor_profile::playwright_output_path(home_dir)?;
    let mut rendered = transform_playwright_json(
        template_json,
        &config_path,
        &browsers_path,
        &npx_prefix.to_string_lossy(),
        &output_dir.to_string_lossy(),
        &version,
    );

    // Overlay app-level model override if present. Status/render callers pass the
    // resolved user home explicitly, so tests and smoke runs must not read a
    // real app-support override from the process environment by accident.
    // Each value is its own override: one the file does not hold keeps the template's.
    let model_override = read_stored_opencode_model_override_for_home(home_dir);
    if let (Some(model_override), Some(obj)) = (model_override, rendered.as_object_mut()) {
        if let Some(model) = model_override.model {
            obj.insert("model".to_string(), serde_json::Value::String(model));
        }
        if let Some(small_model) = model_override.small_model {
            obj.insert(
                "small_model".to_string(),
                serde_json::Value::String(small_model),
            );
        }
        if let Some(subagent_model) = model_override.subagent_model {
            pin_agent_models(obj, SUBAGENT_MODEL_ROLES, &subagent_model);
        }
        if let Some(critic_model) = model_override.critic_model {
            pin_agent_models(obj, &[CRITIC_MODEL_ROLE], &critic_model);
        }
    }

    Some(rendered)
}

/// Managed keys of the installed config that differ from the rendered bundled template, or
/// `None` when the expected config cannot be rendered. The user's own role models are not.
fn installed_config_diverged_keys(
    template_json: &serde_json::Value,
    installed_json: &serde_json::Value,
    home_dir: &Path,
    workspace_root: Option<&Path>,
) -> Option<Vec<String>> {
    let app = AppRoleModels::load(workspace_root, home_dir);
    render_expected_opencode_config(template_json, home_dir).map(|expected| {
        differing_managed_opencode_keys(&without_user_role_models(installed_json, &app), &expected)
    })
}

/// The config generators are sub-second scripts; anything longer is hung.
const GENERATOR_TIMEOUT: Duration = Duration::from_secs(30);
const GENERATOR_OUTPUT_CAP: usize = 256 * 1024;
/// No `python3` the generator may run: none found, or each one could be replaced by another user.
const GENERATOR_PYTHON_MISSING: &str =
    "no python3 found that only you or root can change; install Python 3 to generate config";

/// Bundled path of the snapshot generator. The app never runs a generator out of the active
/// workspace: that folder is user-chosen and only validated by marker files, so any script it carries
/// is untrusted. The bundled copy runs instead and gets the workspace as a `--root` data argument.
const GENERATOR_SCRIPT_REL: &str = "scripts/generate-opencode-config.py";

/// The generator from the bundled, read-only resource root, or why it is unavailable.
fn bundled_generator_script() -> Result<PathBuf, String> {
    let script = crate::setup_roots::bundled_root()?.join(GENERATOR_SCRIPT_REL);
    if script.is_file() {
        Ok(script)
    } else {
        Err(format!(
            "bundled OpenCode config generator is missing: {}",
            script.display()
        ))
    }
}

/// `python3 -I <script> --root <workspace> <mode>`, run with the script's own folder as working directory
/// so nothing in the workspace is picked up as a working-directory side input. The interpreter is
/// [`crate::executable_resolver::trusted_python3`]: one another user could replace is never run.
fn run_generator(
    script: &Path,
    workspace_root: &Path,
    mode: &str,
    timeout: Duration,
) -> Result<BoundedCmdResult, String> {
    let script_str = super::workspace::path_arg(script)?;
    let root_str = super::workspace::path_arg(workspace_root)?;
    let cwd = script.parent().unwrap_or(script);
    let python = crate::executable_resolver::trusted_python3(
        crate::executable_resolver::tool_dirs(),
        std::env::var_os("PATH"),
    )
    .ok_or_else(|| GENERATOR_PYTHON_MISSING.to_string())?;
    Ok(run_cmd_bounded(
        &super::workspace::path_arg(&python)?,
        &["-I", &script_str, "--root", &root_str, mode],
        cwd,
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: GENERATOR_OUTPUT_CAP,
            stderr_cap: GENERATOR_OUTPUT_CAP,
            ..BoundedCmdOptions::default()
        },
    ))
}

/// Run the bundled generator's --check against the given source root.
/// Returns `Some(status, detail)` if the generator ran, `None` if it is unavailable
/// (bundled script missing or `python3` not spawnable).
fn run_generator_check(source_root: &Path) -> Option<(String, String)> {
    let script = bundled_generator_script().ok()?;
    run_generator_check_with_timeout(&script, source_root, GENERATOR_TIMEOUT)
}

fn run_generator_check_with_timeout(
    script: &Path,
    workspace_root: &Path,
    timeout: Duration,
) -> Option<(String, String)> {
    let out = run_generator(script, workspace_root, "--check", timeout).ok()?;
    if out.timed_out {
        // Do not claim "stale" for a check that never finished.
        return Some((
            "valid".into(),
            format!(
                "not freshness-checked: generator --check timed out after {}s",
                timeout.as_secs()
            ),
        ));
    }
    // No exit status: python3 not found / not spawnable (or killed by a signal),
    // so no freshness check is possible.
    out.exit_code?;
    let passed = out.success;
    // Fixed phrases: the generator's own output is never shown.
    let detail = if passed {
        "snapshot is current".into()
    } else {
        "snapshot is stale (generator check failed)".into()
    };
    Some((
        if passed {
            "current".into()
        } else {
            "stale".into()
        },
        detail,
    ))
}

/// The `@playwright/mcp` version pinned in the `mcp.playwright` command of a config.
fn playwright_mcp_version_of(config: &serde_json::Value) -> Option<String> {
    config
        .get("mcp")?
        .get("playwright")?
        .get("command")?
        .as_array()?
        .iter()
        .find_map(|arg| arg.as_str()?.strip_prefix("@playwright/mcp@"))
        .map(str::to_string)
}

/// Global `AGENTS.md` against the bundled rules. Informational: it does not change the overall
/// status, which the install overview already reports per surface.
fn opencode_rules_status(
    bundled_root: Option<&Path>,
    installed: &Path,
    workspace_root: Option<&Path>,
) -> String {
    let Some(bundle) =
        bundled_root.filter(|bundle| bundle.join("templates/sync/opencode-rules.md").is_file())
    else {
        return "unknown".into();
    };
    match std::fs::read(installed) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "unknown",
        Ok(_)
            if crate::pack_routing::health_rules_synced(
                &crate::artifact_registry::ArtifactId::OpenCodeRules,
                installed,
                bundle,
                workspace_root,
            ) =>
        {
            "synced"
        }
        Ok(_) => "diverged",
    }
    .into()
}

/// Compute OpenCode runtime health against the bundled install sources, with
/// no CLI probe (`apply_resolved_cli` adds those). Of the workspace folder only the record of the
/// role models the app wrote plays a part. `opencode_major` is the installed CLI's major version:
/// OpenCode 2 reads neither `tui.json` nor `config.json`, and anything else (`None` included) is
/// checked as 1.x.
/// This is a pure function suitable for unit testing with temp dirs.
pub fn compute_health(
    home_dir: &Path,
    workspace_root: Option<&Path>,
    opencode_major: Option<u32>,
) -> OpenCodeRuntimeHealth {
    let bundled = crate::setup_roots::bundled_root().ok();
    compute_health_with_bundle(bundled.as_deref(), home_dir, workspace_root, opencode_major)
}

fn compute_health_with_bundle(
    bundled_root: Option<&Path>,
    home_dir: &Path,
    workspace_root: Option<&Path>,
    opencode_major: Option<u32>,
) -> OpenCodeRuntimeHealth {
    // The folder the install writes to: `XDG_CONFIG_HOME` moves it, as it moves OpenCode's.
    let config_dir = crate::platform_paths::opencode_config_dir(home_dir);
    compute_health_in(
        bundled_root,
        home_dir,
        &config_dir,
        workspace_root,
        opencode_major,
    )
}

/// What the runtime health says about `tui.json` on OpenCode 2, which does not read it.
const TUI_NOT_READ: &str = "not read by OpenCode 2 (kept for OpenCode 1.x)";

/// The health of the OpenCode files in `config_dir`, the OpenCode config folder of `home_dir`.
fn compute_health_in(
    bundled_root: Option<&Path>,
    home_dir: &Path,
    config_dir: &Path,
    workspace_root: Option<&Path>,
    opencode_major: Option<u32>,
) -> OpenCodeRuntimeHealth {
    // OpenCode 2 never reads tui.json: its checks are information, not drift.
    let tui_is_read = opencode_major != Some(2);
    let source_path = |rel: &str| bundled_root.map(|root| root.join(rel)).unwrap_or_default();
    let template_config_path = source_path("templates/opencode.json");
    let installed_config_path = config_dir.join("opencode.json");
    let agents_source_dir = source_path("agents");
    let agents_target_dir = config_dir.join("agents");

    // TUI paths
    let template_tui_path = source_path("templates/tui.json");
    let installed_tui_path = config_dir.join("tui.json");

    // Generated snapshot paths
    let generated_snapshot_base_path = source_path("templates/opencode.base.json");
    let generated_snapshot_policy_path = source_path("templates/opencode.policy.json");
    let generated_snapshot_path = source_path("templates/opencode.json");

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
    let mut subagent_model: Option<String> = None;
    let mut critic_model: Option<String> = None;
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

    // Parse the installed config as OpenCode does (JSONC), so a file with comments still gets a
    // real synced/diverged answer. The app does not rewrite such a file; the reason says why.
    let mut config_precedence = OpenCodeConfigPrecedence::default();
    let mut installed_not_strict_reason: Option<String> = None;
    let installed_json: Option<serde_json::Value> = if installed_exists {
        let failure = match opencode_precedence::read_config(&installed_config_path) {
            ConfigRead::Parsed(parsed) => {
                if !parsed.is_strict() {
                    config_precedence.installed_not_strict =
                        opencode_precedence::not_strict_parts(&parsed);
                    installed_not_strict_reason =
                        Some(opencode_precedence::not_strict_reason(&parsed));
                }
                Ok(parsed.value)
            }
            ConfigRead::Invalid => Err(opencode_precedence::INVALID_REASON.to_string()),
            ConfigRead::Unreadable(e) => Err(format!("read error: {}", e)),
            ConfigRead::Missing => Err("not found".to_string()),
        };
        match failure {
            Ok(value) => Some(value),
            Err(detail) => {
                checks.push(OpenCodeRuntimeCheck {
                    id: "installed_config_valid".into(),
                    label: "Installed config is valid JSON".into(),
                    status: "fail".into(),
                    detail,
                });
                has_fail = true;
                None
            }
        }
    } else {
        None
    };

    let mut config_status = if !installed_exists {
        "missing"
    } else if installed_json.is_none() {
        "invalid"
    } else {
        "unknown"
    }
    .to_string();
    let mut config_diverged_keys: Vec<String> = Vec::new();
    let playwright_mcp_version = installed_json.as_ref().and_then(playwright_mcp_version_of);

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
            status: if installed_not_strict_reason.is_some() {
                "warn"
            } else {
                "pass"
            }
            .into(),
            detail: installed_not_strict_reason
                .clone()
                .unwrap_or_else(|| "parsed successfully".into()),
        });
        // Informational: the comparison below still says whether OpenCode runs the team's values.
        if let Some(reason) = &installed_not_strict_reason {
            warnings.push(reason.clone());
        }

        // Extract non-sensitive fields from installed config
        default_agent = extract_string_field(i_json, &["default_agent"]);
        model = extract_string_field(i_json, &["model"]);
        small_model = extract_string_field(i_json, &["small_model"]);
        let critic_is_overridden = read_stored_opencode_model_override_for_home(home_dir)
            .is_some_and(|selection| selection.critic_model.is_some());
        subagent_model = shared_subagent_model(i_json, critic_is_overridden);
        critic_model = extract_string_field(i_json, &["agent", CRITIC_MODEL_ROLE, "model"]);
        autoupdate = extract_string_field(i_json, &["autoupdate"]);
        snapshot = i_json.get("snapshot").and_then(|v| v.as_bool());
        // Check default_agent
        checks.push(OpenCodeRuntimeCheck {
            id: "default_agent".into(),
            label: "Default agent".into(),
            status: "pass".into(),
            detail: default_agent.clone().unwrap_or_else(|| "(not set)".into()),
        });

        // The files cannot say whether a model exists: `apply_cli_probes` checks the set ones
        // against `opencode models`.
        for (id, label, value, unset) in [
            ("model", "Model", &model, "(not set)"),
            ("small_model", "Small model", &small_model, "(not set)"),
            (
                "subagent_model",
                "Subagent model",
                &subagent_model,
                "(inherits model)",
            ),
            (
                "critic_model",
                "Critic model",
                &critic_model,
                "(inherits subagent model or main model)",
            ),
        ] {
            checks.push(OpenCodeRuntimeCheck {
                id: id.into(),
                label: label.into(),
                status: if value.is_some() { "unknown" } else { "pass" }.into(),
                detail: value.clone().unwrap_or_else(|| unset.into()),
            });
        }

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

        // Compare against the same bundled render that install applies.
        let diverged_keys =
            installed_config_diverged_keys(t_json, i_json, home_dir, workspace_root);
        let configs_match_result = diverged_keys.as_ref().map(|keys| keys.is_empty());
        let configs_match = configs_match_result.unwrap_or(false);
        if let Some(keys) = diverged_keys {
            config_status = if keys.is_empty() {
                "synced"
            } else {
                "diverged"
            }
            .to_string();
            config_diverged_keys = keys;
        }
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
                format!(
                    "managed keys differ from bundled workspace ({}). Run diff before sync.",
                    config_diverged_keys.join(", ")
                )
            },
        });
        if !configs_match {
            has_warn = true;
        }
    } else if template_json.is_some() || installed_json.is_some() {
        // One parsed, one didn't — already marked fail above
    }

    // ── TUI config checks ──
    // Only the managed keys of tui.json are compared; the user's other keys never make it drift.
    let template_tui = crate::opencode_tui::managed_keys().and_then(|keys| {
        crate::opencode_tui::bundled(&template_tui_path).map(|template| (keys, template))
    });
    let installed_tui = crate::opencode_tui::read(&installed_tui_path);
    let template_tui_exists = template_tui_path.is_file();
    let installed_tui_exists = installed_tui_path.is_file();
    let template_tui_valid = template_tui.is_ok();

    checks.push(OpenCodeRuntimeCheck {
        id: "template_tui_config_exists".into(),
        label: "Template TUI config exists".into(),
        status: if template_tui_valid {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if template_tui_valid {
            template_tui_path_str.clone()
        } else if template_tui_exists {
            format!("invalid JSON: {}", template_tui_path_str)
        } else {
            format!("not found: {}", template_tui_path_str)
        },
    });
    if !template_tui_valid {
        has_fail = true;
    }

    let installed_tui_detail = match &installed_tui {
        Ok(Some(_)) => installed_tui_path_str.clone(),
        Ok(None) => format!("not found: {}", installed_tui_path_str),
        Err(refusal) => format!(
            "unusable ({}): {}",
            refusal.message(),
            installed_tui_path_str
        ),
    };
    checks.push(OpenCodeRuntimeCheck {
        id: "installed_tui_config_exists".into(),
        label: "Installed TUI config exists".into(),
        status: if !tui_is_read {
            "info".into()
        } else if matches!(installed_tui, Ok(Some(_))) {
            "pass".into()
        } else {
            "fail".into()
        },
        detail: if tui_is_read {
            installed_tui_detail
        } else {
            format!("{TUI_NOT_READ}: {installed_tui_detail}")
        },
    });
    if tui_is_read && !matches!(installed_tui, Ok(Some(_))) {
        has_fail = true;
    }

    let tui_diverged_keys = match (&template_tui, &installed_tui) {
        (Ok((keys, template)), Ok(Some(installed))) => Some(crate::opencode_tui::differing_keys(
            installed, template, keys,
        )),
        _ => None,
    };
    let tui_synced = tui_diverged_keys.as_ref().is_some_and(Vec::is_empty);

    let tui_match_detail: String = if tui_synced {
        "managed keys match bundled workspace (other keys preserved)".into()
    } else if let Some(keys) = &tui_diverged_keys {
        format!(
            "managed keys differ from bundled workspace ({}). Run diff before sync.",
            keys.join(", ")
        )
    } else if template_tui_exists && installed_tui_exists {
        "unable to compare managed TUI keys".into()
    } else if !template_tui_exists {
        "template TUI config not found".into()
    } else {
        "installed TUI config not found".into()
    };
    checks.push(OpenCodeRuntimeCheck {
        id: "tui_configs_match".into(),
        label: "Managed TUI keys match bundled workspace".into(),
        status: if !tui_is_read {
            "info".into()
        } else if tui_synced {
            "pass".into()
        } else if template_tui_exists && installed_tui_exists {
            "warn".into()
        } else {
            "fail".into()
        },
        detail: if tui_is_read {
            tui_match_detail
        } else {
            format!("{TUI_NOT_READ}: {tui_match_detail}")
        },
    });
    if tui_is_read && !tui_synced {
        has_warn = true;
    }

    // Derive tui_status from checks
    let tui_status = if !tui_is_read {
        "not_read".into()
    } else if tui_synced {
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
    let mut generator_unavailable = false;
    let (generated_snapshot_status, mut generated_snapshot_detail) = if base_source_exists
        && base_source_valid
        && policy_source_exists
        && policy_source_valid
        && snapshot_exists
        && snapshot_valid
    {
        // Try running generator --check to verify freshness
        match bundled_root.and_then(run_generator_check) {
            Some((status, detail)) => (status, detail),
            None => {
                generator_unavailable = true;
                (
                    "valid".into(),
                    "source + snapshot valid; not freshness-checked (generator unavailable)".into(),
                )
            }
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

    // The generator is the app's bundled copy; it is missing only when the app bundle is damaged
    // or no python3 it may run can start.
    if base_source_exists
        && policy_source_exists
        && generated_snapshot_status == "valid"
        && generator_unavailable
    {
        warnings.push(
            "OpenCode config generator unavailable: no python3 that only you or root can change, or the bundled generator script is missing."
                .to_string(),
        );
    }

    let rules_status =
        opencode_rules_status(bundled_root, &config_dir.join("AGENTS.md"), workspace_root);

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

    // OpenCode merges `config.json` (1.x only) and `opencode.jsonc` from the same folder with
    // `opencode.json`; one that sets managed keys means OpenCode does not run the team's values.
    let expected = template_json
        .as_ref()
        .and_then(|template| render_expected_opencode_config(template, home_dir));
    let sibling_files =
        opencode_precedence::sibling_configs(config_dir, opencode_major, |config| {
            let mut names = managed_opencode_key_names(config);
            names.retain(|name| {
                !matches!(name.as_str(), "model" | "small_model")
                    || expected
                        .as_ref()
                        .is_some_and(|value| value.get(name).is_some())
            });
            names
        });
    // Native OpenCode 2 keys are applied after the 1.x keys the app manages, whichever major runs.
    let native_v2_files =
        opencode_precedence::native_v2_configs(config_dir, installed_json.as_ref());
    let only_overrides_diverge =
        !has_fail && !has_warn && !(sibling_files.is_empty() && native_v2_files.is_empty());
    for (file, keys) in &native_v2_files {
        let warning = opencode_precedence::native_v2_warning(file, keys);
        checks.push(OpenCodeRuntimeCheck {
            id: format!("native_v2_keys:{file}"),
            label: format!("Native OpenCode 2 keys in {file}"),
            status: "warn".into(),
            detail: warning.clone(),
        });
        warnings.push(warning);
        has_warn = true;
    }
    for sibling in &sibling_files {
        let warning = opencode_precedence::sibling_warning(sibling);
        checks.push(OpenCodeRuntimeCheck {
            id: format!("sibling_config:{}", sibling.file),
            label: format!("{} beside opencode.json", sibling.file),
            status: "warn".into(),
            detail: warning.clone(),
        });
        warnings.push(warning);
        has_warn = true;
    }
    config_precedence.sibling_files = sibling_files;

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
    } else if only_overrides_diverge {
        // An install cannot fix this: the app never writes these files or keys.
        let steps: Vec<String> = native_v2_files
            .iter()
            .map(|(file, _)| format!("move the native OpenCode 2 keys in {file} to their 1.x keys"))
            .chain(config_precedence.sibling_files.iter().map(|sibling| {
                if sibling.invalid {
                    format!("fix {}", sibling.file)
                } else {
                    format!("remove the managed keys from {}", sibling.file)
                }
            }))
            .collect();
        let next = steps.join(" and ");
        let summary = if native_v2_files.is_empty() {
            "Another OpenCode config file beside opencode.json changes the team's values."
        } else if config_precedence.sibling_files.is_empty() {
            "Native OpenCode 2 keys in the OpenCode config change the team's values."
        } else {
            "Native OpenCode 2 keys and another OpenCode config file change the team's values."
        };
        (
            summary.to_string(),
            format!("{}{}.", next[..1].to_uppercase(), &next[1..]),
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
        checked_version: crate::harness_versions::get(crate::agent_targets::HarnessId::OpenCode)
            .checked_version
            .clone(),
        status,
        template_config_path: template_config_path_str,
        installed_config_path: installed_config_path_str,
        checks,
        default_agent,
        model,
        small_model,
        subagent_model,
        critic_model,
        autoupdate,
        snapshot,
        bundled_agent_count,
        installed_bundled_agent_count: installed_bundled_count,
        extra_installed_agent_count,
        agent_mismatches,
        warnings,
        cli: None,
        config_status,
        config_diverged_keys,
        rules_status,
        playwright_mcp_version,
        config_precedence,
        template_tui_path: template_tui_path_str,
        installed_tui_path: installed_tui_path_str,
        tui_status,
        tui_diverged_keys: tui_diverged_keys
            .filter(|_| tui_is_read)
            .unwrap_or_default(),
        generated_snapshot_base_path: generated_snapshot_base_path_str,
        generated_snapshot_policy_path: generated_snapshot_policy_path_str,
        generated_snapshot_path: generated_snapshot_path_str,
        generated_snapshot_status,
        generated_snapshot_detail,
        summary,
        next_action,
    }
}

// `async` keeps the generator --check subprocess off the main thread.
#[tauri::command(async)]
pub fn get_opencode_runtime_health() -> Result<OpenCodeRuntimeHealth, String> {
    use crate::agent_targets;

    let home = agent_targets::home_dir()?;

    // Compared with the bundle; only the record of the role models the app wrote lives there.
    let workspace_root = super::workspace::setup_workspace_target_path().ok();
    // The version first: what OpenCode reads depends on its major.
    let cli = resolve_cli(&opencode_candidates(), ProbeLimits::PRODUCTION);
    let mut health = compute_health(&home, workspace_root.as_deref(), cli.major());
    // The app's own environment: the one it was launched with, not the user's shell's.
    let user = std::env::var("USER").ok().or_else(|| {
        home.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    });
    apply_config_environment(
        &mut health,
        opencode_precedence::config_env_var_names(std::env::vars_os()),
        opencode_precedence::existing_paths(&opencode_precedence::system_managed_candidates(
            user.as_deref(),
        )),
    );
    apply_resolved_cli(&mut health, cli, ProbeLimits::PRODUCTION);
    Ok(health)
}

/// The `opencode` the health probes, and what its `--version` said.
struct ResolvedCli {
    program: Option<PathBuf>,
    /// The first candidate found, when none of them is trusted.
    passed_over: Option<PathBuf>,
    report: opencode_cli::CliReport,
}

impl ResolvedCli {
    fn major(&self) -> Option<u32> {
        self.report.version.as_ref().map(|version| version.major)
    }
}

/// The first trusted of `candidates`, and its version.
fn resolve_cli(candidates: &[PathBuf], limits: ProbeLimits) -> ResolvedCli {
    let program = first_trusted_opencode(candidates);
    let report = opencode_cli::inspect(program.as_deref().and_then(Path::to_str), limits.version);
    let passed_over = program
        .is_none()
        .then(|| candidates.first().cloned())
        .flatten();
    ResolvedCli {
        program,
        passed_over,
        report,
    }
}

/// [`apply_cli_report`] for a resolved CLI. When every candidate found is passed over, the CLI
/// stays missing and its detail says where one was found and why it is not used.
fn apply_resolved_cli(health: &mut OpenCodeRuntimeHealth, cli: ResolvedCli, limits: ProbeLimits) {
    apply_cli_report(health, cli.program.as_deref(), cli.report, limits);
    let Some(found) = cli.passed_over else {
        return;
    };
    let detail = format!(
        "found at {}, but not used: it or a folder above it can be changed by another user; it \
         must belong to you or root and not be writable by others",
        found.display()
    );
    if let Some(cli) = health.cli.as_mut() {
        cli.detail = detail.clone();
    }
    set_check(&mut health.checks, "cli", "OpenCode CLI", "warn", detail);
}

/// Adds what the process environment and the machine add to OpenCode's config: the names of the
/// config variables that are set and the system managed config paths that exist. Informational:
/// the status stays, since the app cannot see what they set (it never reads their values).
pub(crate) fn apply_config_environment(
    health: &mut OpenCodeRuntimeHealth,
    env_vars: Vec<String>,
    system_managed_paths: Vec<String>,
) {
    if !env_vars.is_empty() {
        let warning = opencode_precedence::env_warning(&env_vars);
        health.checks.push(OpenCodeRuntimeCheck {
            id: "config_env".into(),
            label: "OpenCode config variables in the app's environment".into(),
            status: "warn".into(),
            detail: env_vars.join(", "),
        });
        health.warnings.push(warning);
    }
    if env_vars
        .iter()
        .any(|name| name == opencode_precedence::CONFIG_DIR_ENV_VAR)
    {
        let config_dir = Path::new(&health.installed_config_path)
            .parent()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default();
        health
            .warnings
            .push(opencode_precedence::config_dir_env_warning(&config_dir));
    }
    if !system_managed_paths.is_empty() {
        let warning = opencode_precedence::system_managed_warning(&system_managed_paths);
        health.checks.push(OpenCodeRuntimeCheck {
            id: "system_managed_config".into(),
            label: "System managed OpenCode config".into(),
            status: "warn".into(),
            detail: system_managed_paths.join(", "),
        });
        health.warnings.push(warning);
    }
    health.config_precedence.env_vars = env_vars;
    health.config_precedence.system_managed_paths = system_managed_paths;
}

/// How long each CLI probe may take before it counts as unanswered.
#[derive(Clone, Copy)]
pub(crate) struct ProbeLimits {
    version: Duration,
    agent: Duration,
    models: Duration,
}

impl ProbeLimits {
    const PRODUCTION: Self = Self {
        version: opencode_cli::VERSION_TIMEOUT,
        agent: opencode_cli::AGENT_TIMEOUT,
        models: OPENCODE_MODELS_TIMEOUT,
    };
}

/// Why a probe could not run: its checks stay `unknown` and this is their detail.
const UNVERIFIED_NO_CLI: &str = "opencode CLI not found";
const UNVERIFIED_NO_RESPONSE: &str = "opencode CLI did not respond";

fn set_check(
    checks: &mut Vec<OpenCodeRuntimeCheck>,
    id: &str,
    label: &str,
    status: &str,
    detail: String,
) {
    let check = OpenCodeRuntimeCheck {
        id: id.into(),
        label: label.into(),
        status: status.into(),
        detail,
    };
    match checks.iter_mut().find(|existing| existing.id == id) {
        Some(existing) => *existing = check,
        None => checks.push(check),
    }
}

/// [`apply_cli_report`] after its own version probe of `program`. Only the stub-CLI tests call it,
/// and they run on Unix.
#[cfg(all(test, unix))]
pub(crate) fn apply_cli_probes(
    health: &mut OpenCodeRuntimeHealth,
    program: Option<&Path>,
    limits: ProbeLimits,
) {
    let report = opencode_cli::inspect(program.and_then(Path::to_str), limits.version);
    apply_cli_report(health, program, report, limits);
}

/// A default-agent probe as the check sees it: whether the agent resolves, or why that is not
/// known. `command` names what ran.
fn agent_outcome(probe: AgentProbe, command: &str, timeout: Duration) -> Result<bool, String> {
    match probe {
        AgentProbe::Resolves => Ok(true),
        AgentProbe::Unresolved => Ok(false),
        AgentProbe::TimedOut => Err(format!("{command} timed out after {}s", timeout.as_secs())),
        AgentProbe::NotRun => Err(format!("{command} could not run")),
        AgentProbe::Unreadable => Err(format!("{command} gave no agent list that could be read")),
    }
}

/// Add what only the `opencode` CLI can tell to a health computed from files: its version
/// (`report`, from `program`), whether the default agent resolves, and whether the configured
/// models exist.
///
/// Each call is bounded and parse-only (`opencode_cli`), and nothing of the raw output is kept. A
/// CLI that is missing, times out or fails leaves the dependent checks `unknown`: it never fails
/// the health or changes its status. A model that is not listed, a default agent that does not
/// resolve and an unsupported major version are warnings.
fn apply_cli_report(
    health: &mut OpenCodeRuntimeHealth,
    program: Option<&Path>,
    report: opencode_cli::CliReport,
    limits: ProbeLimits,
) {
    let program = program.and_then(Path::to_str);
    health.warnings.extend(report.warning);
    set_check(
        &mut health.checks,
        "cli",
        "OpenCode CLI",
        match report.health.status.as_str() {
            "supported" | "compatible" => "pass",
            "unsupported" => "warn",
            _ => "unknown",
        },
        report.health.detail.clone(),
    );
    health.cli = Some(report.health);

    // Without a CLI that answers there is nothing to ask.
    let unreachable = match (program, report.responsive) {
        (None, _) => Some(UNVERIFIED_NO_CLI),
        (Some(_), false) => Some(UNVERIFIED_NO_RESPONSE),
        (Some(_), true) => None,
    };

    let configured = [
        ("model", health.model.clone()),
        ("small_model", health.small_model.clone()),
        ("subagent_model", health.subagent_model.clone()),
        ("critic_model", health.critic_model.clone()),
    ];
    let wants_models = configured.iter().any(|(_, value)| value.is_some());

    // Both probes only need the version result, so they run side by side: the cost is the slower
    // of the two, not their sum.
    let default_agent = health.default_agent.clone();
    let version = report.version.as_ref();
    let (agent_outcome, models) = std::thread::scope(|scope| {
        let agent_probe = default_agent.as_deref().map(|agent| {
            scope.spawn(move || {
                // Only the majors whose output Riggverk has seen are asked.
                match (program, unreachable, version.map(|version| version.major)) {
                    (_, Some(reason), _) => Err(reason.to_string()),
                    (Some(program), None, Some(1)) => agent_outcome(
                        opencode_cli::probe_agent(program, agent, limits.agent),
                        "opencode debug agent",
                        limits.agent,
                    ),
                    (Some(program), None, Some(2)) => agent_outcome(
                        opencode_cli::probe_agent_v2(program, agent, limits.agent),
                        "opencode debug agents",
                        limits.agent,
                    ),
                    _ => Err("only checked on OpenCode 1.x and 2.x".to_string()),
                }
            })
        });
        let models: Option<Result<Vec<String>, String>> =
            wants_models.then(|| match (program, unreachable) {
                (_, Some(reason)) => Err(reason.to_string()),
                (Some(program), None) => {
                    let listed = run_models_listing(program, program, version, limits.models);
                    match listed {
                        Ok(result) if result.warning.is_none() => Ok(result.models),
                        Ok(_) => Err("opencode models gave no usable list".to_string()),
                        Err(_) => Err("opencode models did not complete".to_string()),
                    }
                }
                (None, None) => Err(UNVERIFIED_NO_CLI.to_string()),
            });
        let agent_outcome = agent_probe.map(|handle| {
            handle
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        });
        (agent_outcome, models)
    });

    if let (Some(agent), Some(outcome)) = (default_agent, agent_outcome) {
        let (status, detail) = match outcome {
            Ok(true) => ("pass", format!("{agent} resolves")),
            Ok(false) => {
                let agents_dir = Path::new(&health.installed_config_path)
                    .with_file_name("agents")
                    .to_string_lossy()
                    .into_owned();
                health.warnings.push(if version.is_some_and(|version| version.major == 2) {
                    format!(
                        "OpenCode 2 does not list default agent {agent} in opencode debug agents; \
                         it leaves out an agent file it cannot read. Check the agent files in \
                         {agents_dir} for a frontmatter error, or run Install/Update."
                    )
                } else {
                    format!(
                        "OpenCode cannot resolve default agent {agent}: opencode debug agent failed. \
                         Check the agent files in {agents_dir} for a frontmatter error, \
                         or run Install/Update."
                    )
                });
                ("fail", format!("{agent} does not resolve"))
            }
            Err(reason) => ("unknown", format!("{agent} (not verified: {reason})")),
        };
        set_check(
            &mut health.checks,
            "default_agent_resolves",
            "Default agent resolves",
            status,
            detail,
        );
    }

    let Some(models) = models else { return };
    let mut warned_models = BTreeSet::new();
    for (id, value) in configured {
        let Some(value) = value else { continue };
        let (label, note) = match id {
            "small_model" => (
                "Small model",
                "; OpenCode does not pick another small model",
            ),
            "subagent_model" => (
                "Subagent model",
                "; the subagent roles are pinned to it, not to the main model",
            ),
            "critic_model" => (
                "Critic model",
                "; inspector is pinned to it, not to the main model",
            ),
            _ => ("Model", ""),
        };
        let (status, detail) = match &models {
            Ok(listed) if listed.contains(&value) => ("pass", value.clone()),
            Ok(_) => {
                // Inspector can use the same pin as the other subagents: report that model once.
                if warned_models.insert(value.clone()) {
                    health.warnings.push(format!(
                        "{id} {value} is not listed by opencode models (provider not signed in, or \
                         the model was removed){note}."
                    ));
                }
                ("warn", format!("{value} is not listed by opencode models"))
            }
            Err(reason) => ("unknown", format!("{value} (not verified: {reason})")),
        };
        set_check(&mut health.checks, id, label, status, detail);
    }
}

/// Run the bundled generator's --write against `source_root`, a temp copy of the bundle's sources
/// made by the test (never the data folder): fixtures use it to make a snapshot that checks as
/// current. The app itself never writes the bundled config sources or snapshot.
#[cfg(test)]
pub(crate) fn run_generator_write(source_root: &Path) -> Result<ActionResult, String> {
    // Never write into the bundle itself.
    match crate::setup_roots::bundled_root_for(source_root).and_then(|_| bundled_generator_script())
    {
        Ok(script) => run_generator_write_with_script(&script, source_root),
        Err(error) => Ok(ActionResult::new(
            false,
            "generate_opencode_config_snapshot",
            String::new(),
            error,
            Some(1),
        )),
    }
}

#[cfg(test)]
fn run_generator_write_with_script(
    script: &Path,
    source_root: &Path,
) -> Result<ActionResult, String> {
    // The generator opens the snapshot for writing: a symlink must not carry the write out of the copy.
    super::content::safe_canonical_target(
        source_root,
        &source_root.join("templates/opencode.json"),
    )?;

    let output = run_generator(script, source_root, "--write", GENERATOR_TIMEOUT)?;
    if output.timed_out {
        return Err(format!(
            "generator timed out after {} seconds",
            GENERATOR_TIMEOUT.as_secs()
        ));
    }
    if output.exit_code.is_none() {
        return Err(
            "python3 is not available on this system or could not be started. Install Python 3 and ensure it is on PATH to generate config."
                .to_string(),
        );
    }

    let success = output.success;
    Ok(ActionResult::new(
        success,
        "generate_opencode_config_snapshot",
        if success {
            "Generated opencode.json snapshot.".to_string()
        } else {
            output.stdout
        },
        output.stderr,
        output.exit_code,
    ))
}

// ── OpenCode executable resolution ──

/// Where `opencode` lives when a GUI launch has no shell `PATH`: Homebrew, and the official
/// installer's `~/.opencode/bin`.
fn opencode_fallback_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/opencode"),
        PathBuf::from("/usr/local/bin/opencode"),
    ];
    if let Some(home) = home {
        candidates.push(home.join(".opencode/bin/opencode"));
    }
    candidates
}

/// Every `opencode` executable found, in resolution order: each `path_env` folder, then the
/// fallback locations of `opencode_fallback_candidates`.
fn opencode_candidates_in(path_env: &str, fallbacks: &[PathBuf]) -> Vec<PathBuf> {
    let on_path = std::env::split_paths(path_env)
        .filter_map(|dir| dir.to_str().map(str::to_owned))
        .filter(|dir| !dir.trim().is_empty())
        .filter_map(|dir| crate::executable_resolver::resolve_executable("opencode", &dir, None));
    let fallbacks = fallbacks.iter().filter_map(|candidate| {
        crate::executable_resolver::resolve_executable(&candidate.to_string_lossy(), "", None)
    });
    on_path.chain(fallbacks).collect()
}

/// The first candidate [`crate::executable_resolver::trusted_executable`] accepts, resolved: the
/// file that runs. A candidate another user could replace is passed over.
fn first_trusted_opencode(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find_map(|candidate| crate::executable_resolver::trusted_executable(candidate))
}

/// Resolve the absolute path to the `opencode` CLI (see [`opencode_candidates_in`] and
/// [`first_trusted_opencode`]). Returns `None` if no usable executable is found.
#[cfg(test)]
fn resolve_opencode_executable_in(path_env: &str, fallbacks: &[PathBuf]) -> Option<PathBuf> {
    first_trusted_opencode(&opencode_candidates_in(path_env, fallbacks))
}

fn opencode_candidates() -> Vec<PathBuf> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    let home = crate::agent_targets::home_dir().ok();
    opencode_candidates_in(&path_env, &opencode_fallback_candidates(home.as_deref()))
}

fn resolve_opencode_executable() -> Option<PathBuf> {
    first_trusted_opencode(&opencode_candidates())
}

// ── OpenCode model selection ──

#[derive(serde::Serialize, Clone, Debug)]
pub struct ListAvailableModelsResult {
    pub models: Vec<String>,
    pub warning: Option<String>,
}

/// `provider/model` where the model part may itself contain slashes (OpenRouter, LM Studio, ...):
/// at least one `/`, no empty `/`-separated segment, no whitespace or control characters.
fn is_well_formed_model_id(id: &str) -> bool {
    id.contains('/')
        && !id.chars().any(|c| c.is_whitespace() || c.is_control())
        && id.split('/').all(|segment| !segment.is_empty())
}

/// Parse `opencode models` stdout into a sorted list of unique `provider/model` strings.
///
/// Extraction rules per line:
/// - Strip leading/trailing whitespace, skip empty lines.
/// - Take the first whitespace-delimited token only.
/// - The token must match `provider/model`: the model part may contain further
///   slashes (`lmstudio/google/gemma-3n-e4b`), but no `/`-separated segment may be empty.
/// - Reject tokens containing quotes, shell metacharacters, or control characters.
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
        is_well_formed_model_id(token)
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

/// Where a model value comes from: the app-level override file, or the template.
const SOURCE_OVERRIDE: &str = "override";
const SOURCE_BUNDLED: &str = "bundled default";

#[derive(serde::Serialize, Clone, Debug)]
pub struct OpenCodeModelSelection {
    pub model: String,
    pub small_model: String,
    /// The model the subagent roles run on; empty while they inherit `model`.
    pub subagent_model: String,
    /// The inspector override; empty while it follows the subagent model or inherits `model`.
    pub critic_model: String,
    /// `override` while the override file holds `model`, else `bundled default`.
    pub model_source: String,
    /// `override` while the override file holds `small_model`, else `bundled default`.
    pub small_model_source: String,
    /// `override` while a subagent model is set, `bundled default` while the roles inherit `model`.
    pub subagent_source: String,
    /// `override` while a critic model is set, else `bundled default` (inherit).
    pub critic_source: String,
}

const DEFAULT_MODEL: &str = "";
const DEFAULT_SMALL_MODEL: &str = "";

/// The values the user chose. A value that is `None` is not an override: `model` and `small_model`
/// follow the bundled default (so a later change of that default still reaches the user), and the
/// subagents inherit `model`.
#[derive(Clone, Debug, Default, PartialEq)]
struct ModelOverride {
    model: Option<String>,
    small_model: Option<String>,
    subagent_model: Option<String>,
    critic_model: Option<String>,
}

impl ModelOverride {
    fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.small_model.is_none()
            && self.subagent_model.is_none()
            && self.critic_model.is_none()
    }

    /// The selection of these values over the bundled `defaults` (`model`, `small_model`).
    fn selection_over(&self, defaults: (String, String)) -> OpenCodeModelSelection {
        let source = |value: &Option<String>| {
            if value.is_some() {
                SOURCE_OVERRIDE
            } else {
                SOURCE_BUNDLED
            }
        };
        OpenCodeModelSelection {
            model: self.model.clone().unwrap_or(defaults.0),
            small_model: self.small_model.clone().unwrap_or(defaults.1),
            subagent_model: self.subagent_model.clone().unwrap_or_default(),
            critic_model: self.critic_model.clone().unwrap_or_default(),
            model_source: source(&self.model).to_string(),
            small_model_source: source(&self.small_model).to_string(),
            subagent_source: source(&self.subagent_model).to_string(),
            critic_source: source(&self.critic_model).to_string(),
        }
    }
}

/// App-level model selection override stored outside workspace templates.
///
/// Every value is optional and absent unless the user chose it, so `schema_version` stays 1: a file
/// from an app version that always wrote `model` and `small_model` reads as two explicit overrides,
/// and a newer file still reads in an older version (which needs both, and ignores it otherwise).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct StoredOpenCodeModelSelection {
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    small_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subagent_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    critic_model: Option<String>,
}

/// Resolve the app-level model override file path.
fn opencode_model_selection_path() -> Result<std::path::PathBuf, String> {
    let env = crate::platform_paths::PlatformEnv::from_process_env();
    let platform = crate::platform_paths::Platform::current();
    crate::platform_paths::app_support_dir(&env, platform)
        .map(|p| p.join("opencode-model-selection.json"))
}

/// Resolve the model override path for a caller-supplied home directory.
///
/// Production command handlers use `opencode_model_selection_path()` so they
/// keep honoring the live platform environment. Render/status helpers receive
/// a home path explicitly; when that path is an isolated test/smoke home, derive
/// app support from it instead of leaking reads from the real user profile.
fn opencode_model_selection_path_for_home(home_dir: &Path) -> Result<std::path::PathBuf, String> {
    let platform = crate::platform_paths::Platform::current();
    let process_env = crate::platform_paths::PlatformEnv::from_process_env();
    let process_home = crate::platform_paths::resolve_user_home(&process_env, platform).ok();
    let env = if process_home.as_deref() == Some(home_dir) {
        process_env
    } else {
        let home = home_dir.to_string_lossy().into_owned();
        crate::platform_paths::PlatformEnv {
            home: Some(home.clone()),
            userprofile: Some(home.clone()),
            appdata: Some(
                home_dir
                    .join("AppData")
                    .join("Roaming")
                    .to_string_lossy()
                    .into_owned(),
            ),
            xdg_config_home: Some(home_dir.join(".config").to_string_lossy().into_owned()),
            ..crate::platform_paths::PlatformEnv::default()
        }
    };
    crate::platform_paths::app_support_dir(&env, platform)
        .map(|p| p.join("opencode-model-selection.json"))
}

/// Read the stored model override.
/// Returns None if the file is missing, invalid or holds no valid value.
fn read_stored_opencode_model_override() -> Option<ModelOverride> {
    let path = match opencode_model_selection_path() {
        Ok(p) => p,
        Err(_) => return None,
    };
    read_stored_opencode_model_override_from_path(&path)
}

fn read_stored_opencode_model_override_for_home(home_dir: &Path) -> Option<ModelOverride> {
    let path = opencode_model_selection_path_for_home(home_dir).ok()?;
    read_stored_opencode_model_override_from_path(&path)
}

/// Read the model override from a specific path (testable).
///
/// A value that is empty or not `provider/model` is dropped on its own: it follows the default
/// instead of discarding the values around it.
fn read_stored_opencode_model_override_from_path(path: &std::path::Path) -> Option<ModelOverride> {
    if !path.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let stored: StoredOpenCodeModelSelection = serde_json::from_str(&content).ok()?;
    if stored.schema_version != 1 {
        return None;
    }
    let valid = |id: Option<String>| id.and_then(|id| validate_model_id(&id).ok());
    let model_override = ModelOverride {
        model: valid(stored.model),
        small_model: valid(stored.small_model),
        subagent_model: valid(stored.subagent_model),
        critic_model: valid(stored.critic_model),
    };
    (!model_override.is_empty()).then_some(model_override)
}

/// `opencode models` may refresh its provider catalog over the network.
const OPENCODE_MODELS_TIMEOUT: Duration = Duration::from_secs(30);
/// A model catalog is a few hundred short lines; cap far above that.
const OPENCODE_MODELS_STDOUT_CAP: usize = 4 * 1024 * 1024;

/// List available OpenCode models by running `opencode models --pure` (`--standalone` on
/// OpenCode 2, which has no `--pure` and would otherwise use a background service).
/// Returns a sorted, deduplicated list of `provider/model` strings.
// `async` keeps the (network-bound) subprocess off the main thread.
#[tauri::command(async)]
pub fn list_available_opencode_models() -> Result<ListAvailableModelsResult, String> {
    list_models_with_executable(resolve_opencode_executable(), OPENCODE_MODELS_TIMEOUT)
}

fn list_models_with_executable(
    opencode_path: Option<std::path::PathBuf>,
    timeout: Duration,
) -> Result<ListAvailableModelsResult, String> {
    let opencode_path = opencode_path.ok_or_else(|| {
        format!(
            "opencode CLI not found on PATH, /opt/homebrew/bin, /usr/local/bin or ~/.opencode/bin; \
             install OpenCode 1.x with {}",
            opencode_cli::INSTALL_COMMANDS
        )
    })?;
    let program = opencode_path
        .to_str()
        .ok_or_else(|| "opencode CLI path is not valid UTF-8".to_string())?;
    let version_timeout = timeout.min(opencode_cli::VERSION_TIMEOUT);
    let version = match opencode_cli::probe_version(program, version_timeout) {
        VersionProbe::Found(version) => Some(version),
        VersionProbe::Unreadable => None,
        VersionProbe::TimedOut => {
            return Err(format!(
                "opencode --version timed out after {} seconds",
                version_timeout.as_secs()
            ));
        }
    };
    run_models_listing(program, program, version.as_ref(), timeout)
}

/// `opencode models` with the arguments of `version`, from a fresh probe folder without project
/// config. `shown` names the executable in error text.
fn run_models_listing(
    program: &str,
    shown: &str,
    version: Option<&CliVersion>,
    timeout: Duration,
) -> Result<ListAvailableModelsResult, String> {
    let cwd = opencode_cli::ProbeDir::create()
        .map_err(|e| format!("could not create a private folder to run opencode models in: {e}"))?;
    let result = run_cmd_bounded(
        program,
        opencode_cli::models_args(version),
        cwd.path(),
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: OPENCODE_MODELS_STDOUT_CAP,
            stderr_cap: 64 * 1024,
            extra_env: opencode_cli::project_config_off(),
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        return Err(format!(
            "opencode models timed out after {} seconds",
            timeout.as_secs()
        ));
    }
    if result.exit_code.is_none() {
        let detail = result.stderr.trim();
        return Err(format!(
            "failed to run opencode models ({}): {}",
            shown,
            if detail.is_empty() {
                "terminated without an exit status"
            } else {
                detail
            }
        ));
    }

    let models = parse_opencode_models_output(&result.stdout);
    let warning = if !result.success {
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

/// Values in the bundled template, or empty when it does not select models.
fn bundled_model_defaults() -> Result<(String, String), String> {
    let fallback = || (DEFAULT_MODEL.to_string(), DEFAULT_SMALL_MODEL.to_string());
    let base_path = crate::setup_roots::bundled_root()?.join("templates/opencode.base.json");
    if !base_path.is_file() {
        return Ok(fallback());
    }

    let content = std::fs::read_to_string(&base_path)
        .map_err(|e| format!("failed to read opencode.base.json: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("invalid JSON: {}", e))?;
    let field = |key: &str, default: &str| {
        json.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(default)
            .to_string()
    };
    Ok((
        field("model", DEFAULT_MODEL),
        field("small_model", DEFAULT_SMALL_MODEL),
    ))
}

/// Read the current main, small, subagent and critic models, each with its source.
/// A value comes from the app-level override file when that holds it, else from the bundled
/// `templates/opencode.base.json`, else empty. Without a role override the subagents inherit `model`.
#[tauri::command]
pub fn read_opencode_model_selection() -> Result<OpenCodeModelSelection, String> {
    let model_override = read_stored_opencode_model_override().unwrap_or_default();
    Ok(model_override.selection_over(bundled_model_defaults()?))
}

/// Validate a model ID in `provider/model` format and return it trimmed.
///
/// The model part may contain further slashes (`lmstudio/google/gemma-3n-e4b`);
/// empty segments and whitespace/control characters are rejected.
fn validate_model_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("model ID must not be empty".to_string());
    }
    if !trimmed.contains('/') {
        return Err(format!(
            "invalid model ID '{}': must be in provider/model format",
            trimmed
        ));
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(
            "invalid model ID: must not contain whitespace or control characters".to_string(),
        );
    }
    if !is_well_formed_model_id(trimmed) {
        return Err(format!(
            "invalid model ID '{}': provider and model name must not be empty",
            trimmed
        ));
    }
    Ok(trimmed.to_string())
}

/// Update the app-level override file from the four values the pane shows.
///
/// Only a value the user changed is stored: a `model` or `small_model` equal to the current bundled
/// default is left out and keeps following it, and a missing or empty `subagent_model` means the
/// roles inherit `model`. An unset critic follows the subagent model or inherits `model`.
/// When nothing is left the file is deleted instead of written empty.
///
/// Does NOT mutate workspace templates/opencode.base.json or templates/opencode.json.
/// The override is stored outside the workspace and applied on the next Install/Update.
#[tauri::command(async)]
pub fn update_opencode_model_selection(
    model: String,
    small_model: String,
    subagent_model: Option<String>,
    critic_model: Option<String>,
) -> Result<String, String> {
    // Writes files an apply may also write: wait for a running mutation instead of interleaving.
    let _mutation = crate::mutation_lock::acquire()?;
    // Validate inputs; persist the trimmed values.
    let model = if model.trim().is_empty() {
        String::new()
    } else {
        validate_model_id(&model)?
    };
    let small_model = if small_model.trim().is_empty() {
        String::new()
    } else {
        validate_model_id(&small_model)?
    };
    let subagent_model = match subagent_model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(id) => Some(validate_model_id(id)?),
    };
    let critic_model = match critic_model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(id) => Some(validate_model_id(id)?),
    };

    let (default_model, default_small_model) = bundled_model_defaults()?;
    let follows_default = model == default_model || small_model == default_small_model;
    let model_override = ModelOverride {
        model: (model != default_model).then(|| model.clone()),
        small_model: (small_model != default_small_model).then(|| small_model.clone()),
        subagent_model: subagent_model.clone(),
        critic_model: critic_model.clone(),
    };

    let override_path = opencode_model_selection_path()?;
    if model_override.is_empty() {
        match std::fs::remove_file(&override_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to remove model override: {error}")),
        }
    } else {
        let stored = StoredOpenCodeModelSelection {
            schema_version: 1,
            model: model_override.model.clone(),
            small_model: model_override.small_model.clone(),
            subagent_model: model_override.subagent_model.clone(),
            critic_model: model_override.critic_model.clone(),
        };
        write_model_override_file(&override_path, &stored)?;
    }

    let subagent_note = match &subagent_model {
        Some(id) => format!(", subagent_model={id}"),
        None => ", subagents inherit the model".to_string(),
    };
    let critic_note = match &critic_model {
        Some(id) => format!(", critic_model={id}"),
        None => ", inspector follows the subagent model or inherits the model".to_string(),
    };
    let default_note = if follows_default {
        " An empty model is not stored; the installed value stays unchanged."
    } else {
        ""
    };
    Ok(format!(
        "Model selection saved. Run Install/Update to apply model={}, small_model={}{}{}.{}",
        model, small_model, subagent_note, critic_note, default_note
    ))
}

/// Atomic write: unique temp file next to the target, fsync, then rename.
fn write_model_override_file(
    override_path: &Path,
    stored: &StoredOpenCodeModelSelection,
) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = override_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create app settings directory: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(stored).map_err(|e| format!("serialization error: {}", e))?;

    static TMP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp_name = format!(
        ".{}.{}-{}.tmp",
        override_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("opencode-model-selection.json"),
        std::process::id(),
        TMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    );
    let tmp_path = override_path.with_file_name(tmp_name);
    let write_result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to write model override: {}", e));
    }
    if let Err(e) = std::fs::rename(&tmp_path, override_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("failed to save model override: {}", e));
    }
    Ok(())
}

/// Delete the app-level override file, so the next Install/Update applies the bundled defaults
/// and removes the app-owned subagent `agent.<role>.model` entries. Removing an absent file succeeds.
///
/// One `remove_file` is the whole reset: there is no state in which only part of the override
/// is gone. Installed `opencode.json` is not touched until the next Install/Update.
#[tauri::command(async)]
pub fn reset_opencode_model_selection() -> Result<String, String> {
    let _mutation = crate::mutation_lock::acquire()?;
    let override_path = opencode_model_selection_path()?;
    match std::fs::remove_file(&override_path) {
        Ok(()) => Ok(
            "Model override removed. Run Install/Update to clear managed role models.".to_string(),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok("No model override to remove.".to_string())
        }
        Err(error) => Err(format!("failed to remove model override: {error}")),
    }
}

#[cfg(test)]
#[path = "opencode_runtime_tests.rs"]
mod tests;
