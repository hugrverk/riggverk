//! What else decides the config OpenCode runs, beside the `opencode.json` the app manages.
//!
//! OpenCode 1.x merges the global `config.json`, `opencode.json` and `opencode.jsonc` (in that
//! order, a later file wins, all read as JSONC), then `OPENCODE_CONFIG`, project files,
//! `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, the system managed config and its macOS
//! managed preferences, and `OPENCODE_PERMISSION` (checked against OpenCode 1.19.3). OpenCode 2
//! (checked against 2.3.2) no longer reads `config.json` or `OPENCODE_PERMISSION`, and also reads
//! its own native keys (`permissions`, `agents`, `mcp.servers`, ...) beside the 1.x ones, applying
//! them after the 1.x keys. Runtime health reports what of that it can see, so `synced` means
//! OpenCode runs the team's values:
//!
//! - `opencode.json` is read as JSONC, so a file with comments still gets a real comparison; the
//!   app still writes strict JSON only and leaves such a file alone, and says why.
//! - `config.json` (1.x only) and `opencode.jsonc` in the same folder are read for the names of the
//!   managed keys they set.
//! - `opencode.json` and `opencode.jsonc` are read for the names of the native OpenCode 2 keys they
//!   set.
//! - Of the environment only the names of the config variables that are set are kept.
//! - Of the system managed config only whether its paths exist; nothing there is opened.
//!
//! Every message is a fixed phrase plus file names, key names and variable names. Values are
//! never kept, shown or logged: these files can hold provider keys.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::jsonc;

/// The biggest config file beside `opencode.json` that is read. Real ones are a few kilobytes.
const MAX_SIBLING_BYTES: u64 = 1024 * 1024;

/// Global files OpenCode merges with `opencode.json`, and whether it reads them after it.
const SIBLINGS: &[(&str, bool)] = &[(V1_ONLY_SIBLING, false), ("opencode.jsonc", true)];

/// The sibling only OpenCode 1.x reads: OpenCode 2 ignores it.
pub const V1_ONLY_SIBLING: &str = "config.json";

/// Variables that change the config OpenCode runs.
const CONFIG_ENV_VARS: &[&str] = &[
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    V1_ONLY_ENV_VAR,
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    // OpenCode 2's name for `OPENCODE_DISABLE_PROJECT_CONFIG`.
    "OPENCODE_CONFIG_PROJECT_DISABLE",
];
/// The variable only OpenCode 1.x reads.
const V1_ONLY_ENV_VAR: &str = "OPENCODE_PERMISSION";
/// `OPENCODE_DISABLE_CLAUDE_CODE` and its `_PROMPT` and `_SKILLS` variants.
const CONFIG_ENV_PREFIX: &str = "OPENCODE_DISABLE_CLAUDE_CODE";

/// A global config file beside `opencode.json` that sets managed keys or cannot be read.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SiblingConfig {
    /// The file name: `config.json` or `opencode.jsonc`.
    pub file: String,
    /// The managed keys it sets, by name: `model`, `mcp.playwright`, `agent.plan.permission`,
    /// `agent.<role>.model`.
    pub managed_keys: Vec<String>,
    /// The file is not valid JSONC (or cannot be read), so which keys it sets is unknown.
    pub invalid: bool,
}

/// What, besides the installed `opencode.json`, decides the config OpenCode runs. Names only.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenCodeConfigPrecedence {
    /// What makes the installed `opencode.json` JSONC instead of strict JSON (`comments`,
    /// `trailing commas`, `byte order mark`). It is compared but never rewritten.
    pub installed_not_strict: Vec<String>,
    /// Global config files beside it that set managed keys or cannot be read.
    pub sibling_files: Vec<SiblingConfig>,
    /// The config variables set in the app's own environment, the one it was launched with.
    pub env_vars: Vec<String>,
    /// System managed config paths that exist.
    pub system_managed_paths: Vec<String>,
}

/// What a config file holds, as far as health needs it.
pub enum ConfigRead {
    Missing,
    /// The file exists but cannot be read as text (`read error` detail, no file text).
    Unreadable(std::io::Error),
    /// Not valid JSON or JSONC.
    Invalid,
    Parsed(jsonc::Parsed),
}

/// Reads `path` as OpenCode does: JSONC.
pub fn read_config(path: &Path) -> ConfigRead {
    match std::fs::read_to_string(path) {
        Ok(text) => jsonc::parse(&text).map_or(ConfigRead::Invalid, ConfigRead::Parsed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ConfigRead::Missing,
        Err(error) => ConfigRead::Unreadable(error),
    }
}

/// What makes `parsed` not strict JSON, by name, in the order the reason lists them.
pub fn not_strict_parts(parsed: &jsonc::Parsed) -> Vec<String> {
    [
        (parsed.comments, "comments"),
        (parsed.trailing_commas, "trailing commas"),
        (parsed.byte_order_mark, "byte order mark"),
    ]
    .into_iter()
    .filter(|(present, _)| *present)
    .map(|(_, name)| name.to_string())
    .collect()
}

/// Why the app does not rewrite an `opencode.json` that is JSONC but not strict JSON, and what to
/// do about it. Fixed phrases only.
pub fn not_strict_reason(parsed: &jsonc::Parsed) -> String {
    let has = match not_strict_parts(parsed).as_slice() {
        [one] => format!("{}{one}", if one == "byte order mark" { "a " } else { "" }),
        [first, second] => format!("{first} and {second}"),
        parts => parts.join(", "),
    };
    let todo = if parsed.comments {
        "move your own settings and their comments to opencode.jsonc (OpenCode reads it after opencode.json) and keep opencode.json strict JSON"
    } else if parsed.trailing_commas && parsed.byte_order_mark {
        "remove the trailing commas and save it without the byte order mark"
    } else if parsed.trailing_commas {
        "remove the trailing commas"
    } else {
        "save it without the byte order mark"
    };
    format!("opencode.json has {has}; the app writes strict JSON only and leaves this file as is: {todo}")
}

/// Why the app does not touch an `opencode.json` that is neither JSON nor JSONC.
pub const INVALID_REASON: &str =
    "opencode.json is not valid JSON or JSONC; OpenCode cannot load it and the app leaves it as is: fix or remove it";

/// Why the review leaves the installed `opencode.json` alone, when that is because of its text:
/// `None` for strict JSON, a missing file or one that cannot be read.
pub fn conflict_reason(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
        return None;
    }
    Some(match jsonc::parse(&text) {
        Some(parsed) => not_strict_reason(&parsed),
        None => INVALID_REASON.to_string(),
    })
}

/// A config file beside `opencode.json`: `None` when it does not exist, `Some(None)` when it
/// cannot be used. It is opened only when it is a regular file of at most 1 MiB; a bigger or odd
/// one counts as unusable.
fn read_sibling(path: &Path) -> Option<Option<serde_json::Value>> {
    let meta = std::fs::metadata(path).ok()?;
    Some(
        (meta.is_file() && meta.len() <= MAX_SIBLING_BYTES)
            .then(|| std::fs::read_to_string(path).ok())
            .flatten()
            .and_then(|text| jsonc::parse(&text))
            .map(|parsed| parsed.value),
    )
}

/// The global config files beside `opencode.json` in `config_dir` that the installed OpenCode
/// major reads (`None`: 1.x) and that set managed keys (`managed_key_names` names them) or cannot
/// be read.
pub fn sibling_configs(
    config_dir: &Path,
    opencode_major: Option<u32>,
    managed_key_names: impl Fn(&serde_json::Value) -> Vec<String>,
) -> Vec<SiblingConfig> {
    SIBLINGS
        .iter()
        .filter(|(file, _)| opencode_major != Some(2) || *file != V1_ONLY_SIBLING)
        .filter_map(|(file, _)| {
            let sibling = match read_sibling(&config_dir.join(file))? {
                Some(value) => SiblingConfig {
                    file: (*file).to_string(),
                    managed_keys: managed_key_names(&value),
                    invalid: false,
                },
                None => SiblingConfig {
                    file: (*file).to_string(),
                    managed_keys: Vec::new(),
                    invalid: true,
                },
            };
            (sibling.invalid || !sibling.managed_keys.is_empty()).then_some(sibling)
        })
        .collect()
}

/// The warning for a sibling file: what it does to the team's values and what to do.
pub fn sibling_warning(sibling: &SiblingConfig) -> String {
    let file = &sibling.file;
    if sibling.invalid {
        return format!(
            "{file} is not valid JSONC (or cannot be read): OpenCode reports an error for it, and the app cannot tell which keys it sets"
        );
    }
    let keys = sibling.managed_keys.join(", ");
    let read_after = SIBLINGS.iter().any(|(name, after)| name == file && *after);
    if read_after {
        format!(
            "{file} sets managed keys ({keys}); OpenCode reads it after opencode.json, so its values win over the team's: remove these keys from {file}"
        )
    } else {
        format!(
            "{file} sets managed keys ({keys}); OpenCode merges opencode.json over it, so a value opencode.json leaves out, and the permission rules, MCP servers and agent blocks it adds, still apply: remove these keys from {file}"
        )
    }
}

/// Top-level keys of OpenCode 2's own config format, beside `mcp.servers`.
const NATIVE_V2_KEYS: &[&str] = &[
    "permissions",
    "agents",
    "update",
    "snapshots",
    "plugins",
    "providers",
];

/// The native OpenCode 2 keys `config` sets, by name. OpenCode 2 applies them after the 1.x keys
/// the app manages (a later permission rule, agent, provider or MCP server of the same name wins;
/// plugins are added), so they can change the team's values.
pub fn native_v2_keys(config: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = NATIVE_V2_KEYS
        .iter()
        .filter(|key| config.get(**key).is_some())
        .map(|key| (*key).to_string())
        .collect();
    if config
        .get("mcp")
        .and_then(|mcp| mcp.get("servers"))
        .is_some()
    {
        keys.push("mcp.servers".into());
    }
    keys
}

/// The files OpenCode reads in `config_dir` that set native OpenCode 2 keys, with those keys:
/// `opencode.json` (already parsed as `installed`) and `opencode.jsonc`.
pub fn native_v2_configs(
    config_dir: &Path,
    installed: Option<&serde_json::Value>,
) -> Vec<(String, Vec<String>)> {
    let jsonc = read_sibling(&config_dir.join("opencode.jsonc")).flatten();
    [
        ("opencode.json", installed),
        ("opencode.jsonc", jsonc.as_ref()),
    ]
    .into_iter()
    .filter_map(|(file, value)| {
        let keys = native_v2_keys(value?);
        (!keys.is_empty()).then(|| (file.to_string(), keys))
    })
    .collect()
}

/// The warning for native OpenCode 2 keys in `file`. OpenCode 1.19.5 refuses to load a file with
/// `permissions`; it loads one with the other keys.
pub fn native_v2_warning(file: &str, keys: &[String]) -> String {
    let v1 = if keys.iter().any(|key| key == "permissions") {
        ", and OpenCode 1.x refuses to load a file with permissions"
    } else {
        ""
    };
    format!(
        "{file} sets native OpenCode 2 keys ({}); OpenCode 2 applies them after the 1.x keys Riggverk manages, so they win over the team's values{v1}: move these settings to their 1.x keys or remove them",
        keys.join(", ")
    )
}

/// The names of the config variables set (and not empty) in `vars`, sorted. Values are only
/// checked for being empty.
pub fn config_env_var_names(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<String> {
    let mut names: Vec<String> = vars
        .into_iter()
        .filter(|(_, value)| !value.is_empty())
        .filter_map(|(name, _)| name.into_string().ok())
        .filter(|name| {
            CONFIG_ENV_VARS.contains(&name.as_str()) || name.starts_with(CONFIG_ENV_PREFIX)
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The warning for the config variables set in the app's environment.
pub fn env_warning(names: &[String]) -> String {
    let v1_only = if names.iter().any(|name| name == V1_ONLY_ENV_VAR) {
        format!(" ({V1_ONLY_ENV_VAR} is read by OpenCode 1.x only)")
    } else {
        String::new()
    };
    format!(
        "{} set in Riggverk's environment; they change which config OpenCode loads when it starts with them{v1_only}. Riggverk sees the environment it was launched with, not your shell's",
        names.join(", ")
    )
}

/// The variable that points OpenCode at one more config folder.
pub const CONFIG_DIR_ENV_VAR: &str = "OPENCODE_CONFIG_DIR";

/// The warning for `OPENCODE_CONFIG_DIR`, beside [`env_warning`]: OpenCode reads that folder too,
/// and the app installs only to `config_dir`, its global config folder. The variable's value is
/// never shown.
pub fn config_dir_env_warning(config_dir: &str) -> String {
    format!(
        "{CONFIG_DIR_ENV_VAR} points OpenCode at one more config folder, read after {config_dir} and the project config, so its opencode.json and agents win over the team's. Riggverk installs only to {config_dir} and never writes to the {CONFIG_DIR_ENV_VAR} folder"
    )
}

/// Where OpenCode looks for a system managed config on this platform: the system config folder
/// and, on macOS, the managed preferences of `user` and of the machine.
pub fn system_managed_candidates(user: Option<&str>) -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        let mut paths = vec![PathBuf::from("/Library/Application Support/opencode")];
        if let Some(user) =
            user.filter(|user| !matches!(*user, "" | "." | "..") && !user.contains('/'))
        {
            paths.push(
                Path::new("/Library/Managed Preferences")
                    .join(user)
                    .join("ai.opencode.managed.plist"),
            );
        }
        paths.push(PathBuf::from(
            "/Library/Managed Preferences/ai.opencode.managed.plist",
        ));
        paths
    } else if cfg!(windows) {
        let program_data = std::env::var_os("ProgramData")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"));
        vec![program_data.join("opencode")]
    } else {
        vec![PathBuf::from("/etc/opencode")]
    }
}

/// The paths of `candidates` that exist. Only their metadata is looked at.
pub fn existing_paths(candidates: &[PathBuf]) -> Vec<String> {
    candidates
        .iter()
        .filter(|path| std::fs::symlink_metadata(path).is_ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// The warning for an existing system managed config.
pub fn system_managed_warning(paths: &[String]) -> String {
    format!(
        "A system managed OpenCode config exists ({}); it overrides your config files, the team's values included. Riggverk does not open it",
        paths.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("riggverk-precedence-{label}-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn top_level_names(value: &serde_json::Value) -> Vec<String> {
        ["model", "permission"]
            .into_iter()
            .filter(|key| value.get(key).is_some())
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_commented_opencode_json_gets_a_reason_without_its_text() {
        let dir = temp("reason");
        let path = dir.join("opencode.json");
        std::fs::write(&path, "{\"model\": \"a/b\"}").unwrap();
        assert_eq!(
            conflict_reason(&path),
            None,
            "strict JSON has no text reason"
        );

        std::fs::write(
            &path,
            "{\n  // SECRET-NOTE sk-test-123\n  \"model\": \"a/b\"\n}",
        )
        .unwrap();
        let reason = conflict_reason(&path).unwrap();
        assert!(
            reason.starts_with("opencode.json has comments;"),
            "{reason}"
        );
        assert!(reason.contains("opencode.jsonc"), "{reason}");
        assert!(
            !reason.contains("SECRET") && !reason.contains("a/b"),
            "{reason}"
        );

        std::fs::write(&path, "{\"model\": \"a/b\",}").unwrap();
        let reason = conflict_reason(&path).unwrap();
        assert!(
            reason.contains("has trailing commas")
                && reason.ends_with("remove the trailing commas")
        );

        std::fs::write(&path, "\u{feff}{\"model\": \"a/b\"}").unwrap();
        assert!(conflict_reason(&path)
            .unwrap()
            .contains("has a byte order mark"));

        std::fs::write(&path, "{\"model\": sk-test-123}").unwrap();
        assert_eq!(conflict_reason(&path).as_deref(), Some(INVALID_REASON));

        assert_eq!(conflict_reason(&dir.join("absent.json")), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn siblings_are_reported_only_when_they_set_managed_keys_or_cannot_be_read() {
        let dir = temp("siblings");
        assert!(sibling_configs(&dir, None, top_level_names).is_empty());

        std::fs::write(
            dir.join("opencode.jsonc"),
            "{\n  // mine\n  \"provider\": {\"x\": {\"options\": {\"apiKey\": \"sk-test-123\"}}},\n}",
        )
        .unwrap();
        std::fs::write(dir.join("config.json"), "{\"theme\": \"dark\"}").unwrap();
        assert!(
            sibling_configs(&dir, None, top_level_names).is_empty(),
            "files without managed keys are not reported"
        );

        std::fs::write(
            dir.join("opencode.jsonc"),
            "{\"model\": \"sk-test-123\", /* c */ \"permission\": {},}",
        )
        .unwrap();
        std::fs::write(dir.join("config.json"), "{\"model\": \"x/y\"}").unwrap();
        let found = sibling_configs(&dir, None, top_level_names);
        assert_eq!(
            found,
            vec![
                SiblingConfig {
                    file: "config.json".into(),
                    managed_keys: vec!["model".into()],
                    invalid: false,
                },
                SiblingConfig {
                    file: "opencode.jsonc".into(),
                    managed_keys: vec!["model".into(), "permission".into()],
                    invalid: false,
                },
            ]
        );
        assert_eq!(
            sibling_configs(&dir, Some(2), top_level_names),
            found[1..],
            "OpenCode 2 does not read config.json"
        );
        let jsonc = sibling_warning(&found[1]);
        assert!(jsonc.contains("(model, permission)") && jsonc.contains("win over the team's"));
        let config = sibling_warning(&found[0]);
        assert!(config.contains("merges opencode.json over it"));
        for warning in [&jsonc, &config] {
            assert!(
                !warning.contains("sk-test") && !warning.contains("x/y"),
                "{warning}"
            );
        }

        std::fs::write(dir.join("opencode.jsonc"), "{\"model\": sk-test-123").unwrap();
        let invalid = sibling_configs(&dir, None, top_level_names);
        assert!(invalid
            .iter()
            .any(|s| s.file == "opencode.jsonc" && s.invalid));
        let warning = sibling_warning(invalid.iter().find(|s| s.invalid).unwrap());
        assert!(
            warning.starts_with("opencode.jsonc is not valid JSONC")
                && !warning.contains("sk-test")
        );

        std::fs::remove_file(dir.join("opencode.jsonc")).unwrap();
        std::fs::create_dir(dir.join("opencode.jsonc")).unwrap();
        assert!(
            sibling_configs(&dir, None, top_level_names)
                .iter()
                .any(|s| s.file == "opencode.jsonc" && s.invalid),
            "a folder in place of the file counts as unreadable"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_names_of_set_config_variables_are_kept() {
        let vars = [
            ("OPENCODE_CONFIG", "/tmp/sk-test-123.json"),
            ("OPENCODE_CONFIG_CONTENT", "{\"model\":\"sk-test-123\"}"),
            ("OPENCODE_PERMISSION", ""),
            ("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "1"),
            ("OPENCODE_DISABLE_PROJECT_CONFIG", "true"),
            ("OPENCODE_CONFIG_PROJECT_DISABLE", "1"),
            ("OPENCODE_SERVER_PASSWORD", "sk-test-123"),
            ("OPENCODE_CONFIG", "/tmp/again.json"),
            ("HOME", "/Users/me"),
        ]
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        let names = config_env_var_names(vars);
        assert_eq!(
            names,
            [
                "OPENCODE_CONFIG",
                "OPENCODE_CONFIG_CONTENT",
                "OPENCODE_CONFIG_PROJECT_DISABLE",
                "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
                "OPENCODE_DISABLE_PROJECT_CONFIG",
            ]
        );
        let warning = env_warning(&names);
        assert!(
            !warning.contains("sk-test") && !warning.contains("/tmp"),
            "{warning}"
        );
        assert!(warning.contains("not your shell's"));
        assert!(!warning.contains("1.x only"), "{warning}");
        assert!(config_env_var_names(Vec::new()).is_empty());

        let with_permission = config_env_var_names(
            [("OPENCODE_PERMISSION", "{\"bash\":\"sk-test-123\"}")]
                .map(|(name, value)| (OsString::from(name), OsString::from(value))),
        );
        assert_eq!(with_permission, ["OPENCODE_PERMISSION"]);
        let warning = env_warning(&with_permission);
        assert!(
            warning.contains("(OPENCODE_PERMISSION is read by OpenCode 1.x only)"),
            "{warning}"
        );
        assert!(!warning.contains("sk-test"), "{warning}");
    }

    #[test]
    fn native_v2_keys_are_found_by_name_in_the_files_opencode_reads() {
        let none = serde_json::json!({
            "permission": {"bash": "ask"},
            "agent": {"plan": {}},
            "mcp": {"playwright": {}},
            "autoupdate": false,
            "snapshot": true,
            "plugin": [],
            "provider": {},
        });
        assert!(native_v2_keys(&none).is_empty());
        let all = serde_json::json!({
            "permissions": [],
            "agents": {},
            "update": "auto",
            "snapshots": true,
            "plugins": [],
            "providers": {},
            "mcp": {"servers": {}},
        });
        assert_eq!(
            native_v2_keys(&all),
            [
                "permissions",
                "agents",
                "update",
                "snapshots",
                "plugins",
                "providers",
                "mcp.servers"
            ]
        );

        let dir = temp("native");
        let installed =
            serde_json::json!({"model": "a/b", "agents": {"x": {"prompt": "sk-test-123"}}});
        assert_eq!(
            native_v2_configs(&dir, Some(&installed)),
            [("opencode.json".to_string(), vec!["agents".to_string()])]
        );
        std::fs::write(
            dir.join("opencode.jsonc"),
            "{\n  // mine\n  \"permissions\": [{\"action\": \"shell\", \"resource\": \"*\", \"effect\": \"allow\"}],\n}",
        )
        .unwrap();
        // OpenCode 2 ignores config.json, so a native key there changes nothing.
        std::fs::write(dir.join("config.json"), "{\"permissions\": []}").unwrap();
        let found = native_v2_configs(&dir, None);
        assert_eq!(
            found,
            [(
                "opencode.jsonc".to_string(),
                vec!["permissions".to_string()]
            )]
        );
        let refused = native_v2_warning(&found[0].0, &found[0].1);
        assert!(
            refused.starts_with("opencode.jsonc sets native OpenCode 2 keys (permissions)")
                && refused.contains("win over the team's values")
                && refused.contains("OpenCode 1.x refuses to load a file with permissions"),
            "{refused}"
        );
        let ignored = native_v2_warning("opencode.json", &["agents".to_string()]);
        assert!(
            ignored.ends_with(
                "win over the team's values: move these settings to their 1.x keys or remove them"
            ),
            "{ignored}"
        );
        for warning in [&refused, &ignored] {
            assert!(!warning.contains("sk-test") && !warning.contains("shell"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn system_managed_paths_are_reported_by_existence_only() {
        let dir = temp("system");
        let folder = dir.join("opencode");
        let plist = dir.join("ai.opencode.managed.plist");
        let candidates = vec![folder.clone(), plist.clone()];
        assert!(existing_paths(&candidates).is_empty());

        std::fs::create_dir(&folder).unwrap();
        // Unreadable content proves nothing is opened.
        std::fs::write(folder.join("opencode.json"), "sk-test-123").unwrap();
        assert_eq!(
            existing_paths(&candidates),
            vec![folder.to_string_lossy().into_owned()]
        );
        std::fs::write(&plist, "not a plist").unwrap();
        let found = existing_paths(&candidates);
        assert_eq!(found.len(), 2);
        let warning = system_managed_warning(&found);
        assert!(warning.contains("does not open it") && !warning.contains("sk-test"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_platform_candidates_are_the_ones_opencode_reads() {
        let candidates = system_managed_candidates(Some("me"));
        if cfg!(target_os = "macos") {
            assert_eq!(
                candidates,
                [
                    PathBuf::from("/Library/Application Support/opencode"),
                    PathBuf::from("/Library/Managed Preferences/me/ai.opencode.managed.plist"),
                    PathBuf::from("/Library/Managed Preferences/ai.opencode.managed.plist"),
                ]
            );
            assert_eq!(system_managed_candidates(Some("../x")).len(), 2);
        } else if !cfg!(windows) {
            assert_eq!(candidates, [PathBuf::from("/etc/opencode")]);
        }
    }
}
