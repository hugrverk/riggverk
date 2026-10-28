//! Per-key "I keep my value" choices for the managed keys of a harness config.
//!
//! Riggverk enforces a few keys of `$CODEX_HOME/config.toml` while the Codex config target is on.
//! A user who set one of them on purpose (`approvals_reviewer = "auto_review"`, say) can keep their
//! value: the choice is recorded here, and the key then counts as matching for as long as the
//! installed value is still the kept one. The other enforced keys keep following the bundle.
//! Nothing in this module writes to `config.toml`; it writes only `config-preferences.json`.
//!
//! The choice names the destination it was made for. `CODEX_HOME` can move the config file, and a
//! choice made for one file must not apply to another (the same rule as `kept_files`): an entry
//! applies only while the artifact still resolves to the recorded destination.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CONFIG_PREFERENCES_REL: &str = ".agent-workspace/config-preferences.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 16 * 1024;
/// Longest kept value read back; a longer one is not a choice this app wrote.
const MAX_VALUE_BYTES: usize = 256;

/// The enforced keys of the Codex config that can be kept, as dotted paths. Mirrors the keys
/// `commands::codex_runtime` enforces (a test there pins the two together).
pub const CODEX_KEEPABLE_PATHS: [&str; 5] = [
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
    "apps._default.approvals_reviewer",
    "apps._default.default_tools_approval_mode",
];

/// The kept keys of the Codex config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexConfigChoice {
    /// Display form (`~/...`) of the destination the choice was made for.
    pub dest: String,
    /// Dotted key path to the value the user keeps.
    pub kept: BTreeMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PreferencesDocument {
    #[serde(default)]
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_config: Option<CodexConfigChoice>,
}

/// What `config-preferences.json` holds.
enum Stored {
    Absent,
    Usable(PreferencesDocument),
    /// Valid JSON of another schema version: written by another version of the app.
    Foreign,
    /// Unreadable, oversized, not a regular file, behind a link, or not the expected JSON.
    Unusable,
}

fn path_of(workspace_root: &Path) -> PathBuf {
    workspace_root.join(CONFIG_PREFERENCES_REL)
}

fn read_stored(workspace_root: &Path) -> Stored {
    let path = path_of(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "config preferences")
        .is_err()
        || crate::path_safety::reject_symlink(&path, "config preferences").is_err()
    {
        return Stored::Unusable;
    }
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Stored::Absent,
        Err(_) => return Stored::Unusable,
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Stored::Unusable;
    }
    let Some(raw) = fs::read_to_string(&path).ok() else {
        return Stored::Unusable;
    };
    // The version is read on its own first: a file of another version may have another shape.
    let Some(version) = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| value.get("schema_version").and_then(|v| v.as_u64()))
    else {
        return Stored::Unusable;
    };
    if version != u64::from(SCHEMA_VERSION) {
        return Stored::Foreign;
    }
    match serde_json::from_str::<PreferencesDocument>(&raw) {
        Ok(document) => Stored::Usable(document),
        Err(_) => Stored::Unusable,
    }
}

/// The choice with every entry that is not a keepable key and string value dropped.
fn sanitized(choice: CodexConfigChoice) -> Option<CodexConfigChoice> {
    let kept: BTreeMap<String, String> = choice
        .kept
        .into_iter()
        .filter(|(key, value)| {
            CODEX_KEEPABLE_PATHS.contains(&key.as_str()) && value.len() <= MAX_VALUE_BYTES
        })
        .collect();
    (!kept.is_empty() && !choice.dest.is_empty()).then_some(CodexConfigChoice {
        dest: choice.dest,
        kept,
    })
}

/// The recorded choice for the Codex config. An unreadable, oversized or foreign file counts as
/// "no choices": the config then keeps reporting its differences, which is the safe default. The
/// caller still checks `dest` against where the config resolves now.
pub fn load_codex_config(workspace_root: &Path) -> Option<CodexConfigChoice> {
    match read_stored(workspace_root) {
        Stored::Usable(document) => document.codex_config.and_then(sanitized),
        Stored::Absent | Stored::Foreign | Stored::Unusable => None,
    }
}

/// Records `choice` (replacing an earlier one), or clears the choice with `None`. Writes only
/// `config-preferences.json`, and nothing when it would not change.
pub fn set_codex_config(
    workspace_root: &Path,
    choice: Option<CodexConfigChoice>,
) -> Result<(), String> {
    if let Some(choice) = &choice {
        if choice.kept.is_empty()
            || choice
                .kept
                .keys()
                .any(|key| !CODEX_KEEPABLE_PATHS.contains(&key.as_str()))
        {
            return Err("only the enforced Codex config keys can be kept".to_string());
        }
    }
    let before = match read_stored(workspace_root) {
        Stored::Usable(document) => document,
        Stored::Absent | Stored::Unusable => PreferencesDocument::default(),
        Stored::Foreign => {
            return Err(
                "config-preferences.json was written by another version of Riggverk; update the app or move the file away"
                    .to_string(),
            )
        }
    };
    if before.codex_config == choice && before.schema_version == SCHEMA_VERSION {
        return Ok(());
    }
    if choice.is_none() && before.codex_config.is_none() {
        return Ok(());
    }
    let document = PreferencesDocument {
        schema_version: SCHEMA_VERSION,
        codex_config: choice,
    };
    let raw = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("serialize config preferences: {error}"))?;
    crate::managed_state::ensure_data_folder(workspace_root)?;
    crate::safe_filesystem::write_regular_file_atomic(
        &path_of(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|error| format!("write config preferences: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-config-prefs-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn choice(pairs: &[(&str, &str)]) -> CodexConfigChoice {
        CodexConfigChoice {
            dest: "~/.codex/config.toml".to_string(),
            kept: pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        }
    }

    fn write_raw(ws: &Path, raw: &str) {
        fs::create_dir_all(ws.join(".agent-workspace")).unwrap();
        fs::write(path_of(ws), raw).unwrap();
    }

    #[test]
    fn a_choice_round_trips_and_clears() {
        let ws = temp("roundtrip");
        assert!(load_codex_config(&ws).is_none());
        let kept = choice(&[("approvals_reviewer", "auto_review")]);
        set_codex_config(&ws, Some(kept.clone())).unwrap();
        assert_eq!(load_codex_config(&ws), Some(kept));

        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(path_of(&ws)).unwrap()).unwrap();
        assert_eq!(raw["schema_version"], 1);
        assert_eq!(raw["codex_config"]["dest"], "~/.codex/config.toml");
        assert_eq!(
            raw["codex_config"]["kept"]["approvals_reviewer"],
            "auto_review"
        );

        set_codex_config(&ws, None).unwrap();
        assert!(load_codex_config(&ws).is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn clearing_with_nothing_recorded_writes_nothing() {
        let ws = temp("clear-empty");
        set_codex_config(&ws, None).unwrap();
        assert!(!path_of(&ws).exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_key_outside_the_enforced_set_is_refused_and_ignored() {
        let ws = temp("foreign-key");
        let error = set_codex_config(&ws, Some(choice(&[("model", "gpt-9")]))).unwrap_err();
        assert!(error.contains("enforced"), "{error}");
        assert!(!path_of(&ws).exists());

        // A file that names other keys (edited by hand) keeps only the enforced ones.
        write_raw(
            &ws,
            r#"{"schema_version":1,"codex_config":{"dest":"~/.codex/config.toml",
               "kept":{"model":"gpt-9","sandbox_mode":"read-only"}}}"#,
        );
        let loaded = load_codex_config(&ws).expect("the enforced key survives");
        assert_eq!(
            loaded.kept.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["sandbox_mode"]
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn malformed_or_non_string_files_are_no_choices() {
        let ws = temp("malformed");
        for raw in [
            "not json",
            r#"{"schema_version":1,"codex_config":{"dest":"~/x","kept":{"sandbox_mode":true}}}"#,
            r#"{"schema_version":1,"codex_config":{"dest":"~/x","kept":["sandbox_mode"]}}"#,
            r#"{"codex_config":{"dest":"~/x","kept":{"sandbox_mode":"read-only"}}}"#,
            "[]",
        ] {
            write_raw(&ws, raw);
            assert!(load_codex_config(&ws).is_none(), "{raw}");
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_foreign_schema_is_no_choice_and_is_never_overwritten() {
        let ws = temp("foreign-schema");
        let raw = r#"{"schema_version":2,"codex_config":{"dest":"~/x","kept":{"sandbox_mode":"read-only"}}}"#;
        write_raw(&ws, raw);
        assert!(load_codex_config(&ws).is_none());
        let error =
            set_codex_config(&ws, Some(choice(&[("sandbox_mode", "read-only")]))).unwrap_err();
        assert!(error.contains("another version"), "{error}");
        assert_eq!(fs::read_to_string(path_of(&ws)).unwrap(), raw);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn an_oversized_file_is_no_choice() {
        let ws = temp("oversized");
        let padding = " ".repeat(MAX_FILE_BYTES as usize);
        write_raw(
            &ws,
            &format!(
                r#"{{"schema_version":1,"codex_config":{{"dest":"~/x","kept":{{"sandbox_mode":"read-only"}}}}{padding}}}"#
            ),
        );
        assert!(load_codex_config(&ws).is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_file_is_no_choice() {
        let ws = temp("symlink");
        let real = ws.join("real.json");
        fs::write(
            &real,
            r#"{"schema_version":1,"codex_config":{"dest":"~/x","kept":{"sandbox_mode":"read-only"}}}"#,
        )
        .unwrap();
        fs::create_dir_all(ws.join(".agent-workspace")).unwrap();
        std::os::unix::fs::symlink(&real, path_of(&ws)).unwrap();
        assert!(load_codex_config(&ws).is_none());
        let _ = fs::remove_dir_all(&ws);
    }
}
