//! What else decides the config OpenCode 1.x runs, beside the `opencode.json` the app manages.
//!
//! OpenCode merges the global `config.json`, `opencode.json` and `opencode.jsonc` (in that order,
//! a later file wins, all read as JSONC), then `OPENCODE_CONFIG`, project files,
//! `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, the system managed config and its macOS
//! managed preferences, and `OPENCODE_PERMISSION` (checked against OpenCode 1.19.3). Runtime health
//! reports what of that it can see, so `synced` means OpenCode runs the team's values:
//!
//! - `opencode.json` is read as JSONC, so a file with comments still gets a real comparison; the
//!   app still writes strict JSON only and leaves such a file alone, and says why.
//! - `config.json` and `opencode.jsonc` in the same folder are read for the names of the managed
//!   keys they set.
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
const SIBLINGS: &[(&str, bool)] = &[("config.json", false), ("opencode.jsonc", true)];

/// Variables that change the config OpenCode runs.
const CONFIG_ENV_VARS: &[&str] = &[
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_PERMISSION",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
];
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

/// The global config files beside `opencode.json` in `config_dir` that set managed keys
/// (`managed_key_names` names them) or cannot be read. A file is opened only when it is a regular
/// file of at most 1 MiB; a bigger or odd one counts as unreadable.
pub fn sibling_configs(
    config_dir: &Path,
    managed_key_names: impl Fn(&serde_json::Value) -> Vec<String>,
) -> Vec<SiblingConfig> {
    SIBLINGS
        .iter()
        .filter_map(|(file, _)| {
            let path = config_dir.join(file);
            let meta = std::fs::metadata(&path).ok()?;
            let parsed = (meta.is_file() && meta.len() <= MAX_SIBLING_BYTES)
                .then(|| std::fs::read_to_string(&path).ok())
                .flatten()
                .and_then(|text| jsonc::parse(&text));
            let sibling = match parsed {
                Some(parsed) => SiblingConfig {
                    file: (*file).to_string(),
                    managed_keys: managed_key_names(&parsed.value),
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
    format!(
        "{} set in Riggverk's environment; they change which config OpenCode loads when it starts with them. Riggverk sees the environment it was launched with, not your shell's",
        names.join(", ")
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
        assert!(sibling_configs(&dir, top_level_names).is_empty());

        std::fs::write(
            dir.join("opencode.jsonc"),
            "{\n  // mine\n  \"provider\": {\"x\": {\"options\": {\"apiKey\": \"sk-test-123\"}}},\n}",
        )
        .unwrap();
        std::fs::write(dir.join("config.json"), "{\"theme\": \"dark\"}").unwrap();
        assert!(
            sibling_configs(&dir, top_level_names).is_empty(),
            "files without managed keys are not reported"
        );

        std::fs::write(
            dir.join("opencode.jsonc"),
            "{\"model\": \"sk-test-123\", /* c */ \"permission\": {},}",
        )
        .unwrap();
        std::fs::write(dir.join("config.json"), "{\"model\": \"x/y\"}").unwrap();
        let found = sibling_configs(&dir, top_level_names);
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
        let invalid = sibling_configs(&dir, top_level_names);
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
            sibling_configs(&dir, top_level_names)
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
        assert!(config_env_var_names(Vec::new()).is_empty());
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
