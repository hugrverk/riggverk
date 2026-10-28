//! The attribution keys of Claude Code's `settings.json`.
//!
//! `~/.claude/settings.json` is the user's file. The app manages two leaf values in it, and only
//! while the `claude_config` target is on: `attribution.commit` and `attribution.pr`. Install sets
//! both to `""`, which hides Claude Code's `Co-Authored-By` commit trailer and its "Generated with
//! Claude Code" pull request line. Every other key (`env`, `hooks`, `permissions`, ...) keeps its
//! value and its place in the file. The values are constants of the app; there is no bundled file.
//!
//! The app writes only where the user has not said anything about attribution: a file without
//! both keys. A file that already has one of them, custom text, `attribution: false` or the older
//! `includeCoAuthoredBy` setting is the user's own choice and stays as it is. Both keys set to `""`
//! is the app's own value only while an ownership record says the app wrote it
//! (`setup_transaction`); without the record it is the user's own too.
//!
//! The file is read and written as strict JSON with the reader of the light-tier MCP files: a file
//! with comments, a trailing comma, a byte order mark or anything else that is not a JSON object
//! is refused whole, with a fixed reason and no file text, and never rewritten. A write uses
//! two-space indentation and a final newline.

use std::path::Path;

use serde_json::{Map, Value};

use crate::light_mcp::Refusal;

/// The key holding the two managed values.
const ATTRIBUTION: &str = "attribution";
/// The managed leaf keys, in the order they are written.
const MANAGED_KEYS: [&str; 2] = ["commit", "pr"];
/// The setting older Claude Code versions read before `attribution`. Never written.
const LEGACY_KEY: &str = "includeCoAuthoredBy";

/// Why nothing is written while `CLAUDE_CONFIG_DIR` is set.
pub const CONFIG_DIR_REASON: &str =
    "CLAUDE_CONFIG_DIR is set; Riggverk only edits ~/.claude/settings.json";

/// Why a file whose `attribution` key has a type nobody writes is left alone. A fixed phrase.
const UNEXPECTED_TYPE_REASON: &str =
    "settings.json: attribution has an unexpected type; the app writes nothing";

/// Whether an environment value moves Claude Code's config folder away from `~/.claude`.
pub fn config_dir_override_for(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

/// [`config_dir_override_for`] with `CLAUDE_CONFIG_DIR` from the app's own environment. Claude
/// Code then reads that folder, so `~/.claude/settings.json` would change nothing it sees.
pub fn config_dir_override() -> bool {
    #[cfg(test)]
    {
        test_override::get()
    }
    #[cfg(not(test))]
    {
        config_dir_override_for(std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref())
    }
}

/// Per-thread replacement of the environment variable, so a test never changes the process
/// environment: it reads as unset unless a test sets it here.
#[cfg(test)]
pub(crate) mod test_override {
    use std::cell::Cell;

    thread_local! {
        static SET: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn get() -> bool {
        SET.with(Cell::get)
    }

    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            SET.with(|cell| cell.set(false));
        }
    }

    /// `CLAUDE_CONFIG_DIR` reads as set on this thread until the guard drops.
    pub(crate) fn set() -> Guard {
        SET.with(|cell| cell.set(true));
        Guard
    }
}

/// The managed values written by install, as the projection of a file that holds them.
pub fn managed_values() -> Map<String, Value> {
    MANAGED_KEYS
        .iter()
        .map(|key| ((*key).to_string(), Value::String(String::new())))
        .collect()
}

/// Reads a `settings.json` (installed or backup): `Ok(None)` when there is none.
pub fn read(path: &Path) -> Result<Option<Map<String, Value>>, Refusal> {
    crate::light_mcp::read_object(path)
}

/// What `config` holds of the managed values: the leaf values it has under `attribution`, or
/// the whole `attribution` value when that is not an object. Nothing else of the file.
pub fn managed_projection(config: &Map<String, Value>) -> Map<String, Value> {
    match config.get(ATTRIBUTION) {
        None => Map::new(),
        Some(Value::Object(attribution)) => MANAGED_KEYS
            .iter()
            .filter_map(|key| {
                attribution
                    .get(*key)
                    .map(|value| ((*key).to_string(), value.clone()))
            })
            .collect(),
        Some(other) => {
            let mut projection = Map::new();
            projection.insert(ATTRIBUTION.to_string(), other.clone());
            projection
        }
    }
}

/// How a `settings.json` stands against the managed values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assessment {
    /// There is no file.
    Absent,
    /// The file says nothing about attribution: install adds the two values.
    Missing,
    /// Both values are `""`. Whether the app wrote them is for the ownership record to say.
    Hidden,
    /// The user set attribution themselves (one key, custom text, `attribution: false`,
    /// `includeCoAuthoredBy`): left as it is.
    UserSet,
    /// `attribution` has a type nobody writes.
    UnexpectedType,
    /// The file is not one the app edits.
    Refused(Refusal),
}

/// How the contents of a readable file stand.
pub fn classify(config: &Map<String, Value>) -> Assessment {
    match config.get(ATTRIBUTION) {
        Some(Value::Object(attribution)) => {
            let set: Vec<Option<&Value>> = MANAGED_KEYS
                .iter()
                .map(|key| attribution.get(*key))
                .collect();
            if set
                .iter()
                .all(|value| *value == Some(&Value::String(String::new())))
            {
                Assessment::Hidden
            } else if set.iter().any(Option::is_some) || config.contains_key(LEGACY_KEY) {
                Assessment::UserSet
            } else {
                Assessment::Missing
            }
        }
        // `false` is how some setups switch attribution off: the user's own choice.
        Some(Value::Bool(false)) => Assessment::UserSet,
        Some(_) => Assessment::UnexpectedType,
        None if config.contains_key(LEGACY_KEY) => Assessment::UserSet,
        None => Assessment::Missing,
    }
}

pub fn assess(dest: &Path) -> Assessment {
    match read(dest) {
        Err(refusal) => Assessment::Refused(refusal),
        Ok(None) => Assessment::Absent,
        Ok(Some(config)) => classify(&config),
    }
}

/// Why a `settings.json` the app does not edit is left alone, for the review. A fixed phrase.
pub fn refusal_reason(refusal: Refusal) -> String {
    format!(
        "settings.json: {}; the app edits strict JSON only and writes nothing",
        refusal.message()
    )
}

/// Why the file is left alone when its state is the reason; `None` for the states that are not
/// conflicts.
pub fn conflict_reason(assessment: &Assessment) -> Option<String> {
    match assessment {
        Assessment::Refused(refusal) => Some(refusal_reason(*refusal)),
        Assessment::UnexpectedType => Some(UNEXPECTED_TYPE_REASON.to_string()),
        Assessment::Absent | Assessment::Missing | Assessment::Hidden | Assessment::UserSet => None,
    }
}

/// The content install writes: the file at `dest` (or an empty one) with the two values added.
/// Only a file that says nothing about attribution is written; any other state is refused before
/// anything is written, whatever the plan said.
pub fn render_install(dest: &Path) -> Result<String, String> {
    let mut config = read(dest)
        .map_err(|refusal| format!("refusing to change {}", refusal_reason(refusal)))?
        .unwrap_or_default();
    match classify(&config) {
        Assessment::Missing => {}
        Assessment::UnexpectedType => {
            return Err(format!("refusing to change {UNEXPECTED_TYPE_REASON}"));
        }
        _ => {
            return Err(
                "refusing to change settings.json: it already says how attribution is shown"
                    .to_string(),
            );
        }
    }
    let managed = managed_values();
    match config.get_mut(ATTRIBUTION) {
        Some(Value::Object(attribution)) => {
            for (key, value) in managed {
                attribution.insert(key, value);
            }
        }
        _ => {
            config.insert(ATTRIBUTION.to_string(), Value::Object(managed));
        }
    }
    render(config)
}

/// The installed file with the two values put back as `backup` had them (and the ones it lacked
/// taken out again); everything else stays as it is now. An `attribution` object the apply
/// created goes with them. An installed file or a backup that no longer reads as strict JSON, or
/// whose `attribution` is not an object where it must be, is an error: nothing is written.
pub fn render_restored(installed: &Path, backup: &Path) -> Result<String, String> {
    let mut current = read(installed)
        .map_err(|refusal| {
            format!(
                "installed settings.json cannot be restored: {}",
                refusal.message()
            )
        })?
        .ok_or_else(|| "installed settings.json is missing".to_string())?;
    let previous = read(backup)
        .map_err(|refusal| format!("backup of settings.json is unusable: {}", refusal.message()))?
        .ok_or_else(|| "backup of settings.json is missing".to_string())?;
    let backup_attribution = match previous.get(ATTRIBUTION) {
        None => None,
        Some(Value::Object(attribution)) => Some(attribution),
        // `attribution: false` is the user's and was never planned for a write.
        Some(_) => return Err("backup of settings.json is unusable: attribution".to_string()),
    };
    match current.get_mut(ATTRIBUTION) {
        // The user removed it since: the managed values are gone, nothing is added back.
        None => {}
        Some(Value::Object(attribution)) => {
            for key in MANAGED_KEYS {
                match backup_attribution.and_then(|backed_up| backed_up.get(key)) {
                    Some(value) => {
                        attribution.insert(key.to_string(), value.clone());
                    }
                    None => {
                        attribution.shift_remove(key);
                    }
                }
            }
            if backup_attribution.is_none() && attribution.is_empty() {
                current.shift_remove(ATTRIBUTION);
            }
        }
        Some(_) => {
            return Err(
                "installed settings.json cannot be restored: attribution has an unexpected type"
                    .to_string(),
            );
        }
    }
    render(current)
}

fn render(config: Map<String, Value>) -> Result<String, String> {
    serde_json::to_string_pretty(&Value::Object(config))
        .map(|text| text + "\n")
        .map_err(|e| format!("serialize settings.json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn object(text: &str) -> Map<String, Value> {
        match serde_json::from_str(text).expect("json") {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    fn temp(label: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-claude-settings-{label}-{n}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A settings file with the keys a user really keeps there, in an order worth keeping.
    const USER_FILE: &str = r#"{
  "env": {"FOO": "1"},
  "permissions": {"allow": ["Bash(ls)"]},
  "hooks": {"PreToolUse": []},
  "model": "opus"
}
"#;

    #[test]
    fn the_managed_values_are_two_empty_strings() {
        assert_eq!(
            serde_json::to_string(&managed_values()).unwrap(),
            r#"{"commit":"","pr":""}"#
        );
    }

    #[test]
    fn config_dir_override_needs_a_non_blank_value() {
        assert!(!config_dir_override_for(None));
        assert!(!config_dir_override_for(Some("")));
        assert!(!config_dir_override_for(Some("  ")));
        assert!(config_dir_override_for(Some("/somewhere")));
        assert!(!config_dir_override());
        let _set = test_override::set();
        assert!(config_dir_override());
    }

    #[test]
    fn classify_tells_the_users_own_choices_from_an_empty_slate() {
        let case = |text: &str| classify(&object(text));
        assert_eq!(case("{}"), Assessment::Missing);
        assert_eq!(case(r#"{"env":{}}"#), Assessment::Missing);
        assert_eq!(case(r#"{"attribution":{}}"#), Assessment::Missing);
        assert_eq!(
            case(r#"{"attribution":{"sessionUrl":true}}"#),
            Assessment::Missing
        );
        assert_eq!(
            case(r#"{"attribution":{"commit":"","pr":""}}"#),
            Assessment::Hidden
        );
        for user_set in [
            r#"{"attribution":{"commit":"","pr":"custom"}}"#,
            r#"{"attribution":{"commit":"Reviewed by me"}}"#,
            r#"{"attribution":{"pr":""}}"#,
            r#"{"attribution":{"commit":null,"pr":""}}"#,
            r#"{"attribution":false}"#,
            r#"{"includeCoAuthoredBy":false}"#,
            r#"{"includeCoAuthoredBy":true,"attribution":{}}"#,
        ] {
            assert_eq!(case(user_set), Assessment::UserSet, "{user_set}");
        }
        for unexpected in [
            r#"{"attribution":true}"#,
            r#"{"attribution":"none"}"#,
            r#"{"attribution":null}"#,
            r#"{"attribution":[]}"#,
            r#"{"attribution":1}"#,
        ] {
            assert_eq!(case(unexpected), Assessment::UnexpectedType, "{unexpected}");
        }
    }

    #[test]
    fn the_projection_holds_the_two_values_and_nothing_else() {
        let projection = |text: &str| serde_json::to_string(&managed_projection(&object(text)));
        assert_eq!(projection(r#"{"env":{"A":"B"}}"#).unwrap(), "{}");
        assert_eq!(
            projection(r#"{"model":"x","attribution":{"pr":"p","sessionUrl":true,"commit":"c"}}"#)
                .unwrap(),
            r#"{"commit":"c","pr":"p"}"#
        );
        assert_eq!(
            projection(r#"{"attribution":false}"#).unwrap(),
            r#"{"attribution":false}"#
        );
    }

    #[test]
    fn a_new_file_holds_the_two_values_only() {
        let dir = temp("create");
        let rendered = render_install(&dir.join("settings.json")).expect("render");
        assert_eq!(
            rendered,
            "{\n  \"attribution\": {\n    \"commit\": \"\",\n    \"pr\": \"\"\n  }\n}\n"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn install_keeps_every_other_key_and_its_place() {
        let dir = temp("keep");
        let dest = dir.join("settings.json");
        fs::write(&dest, USER_FILE).unwrap();
        let rendered = render_install(&dest).expect("render");
        let config = object(&rendered);
        assert_eq!(
            config.keys().map(String::as_str).collect::<Vec<_>>(),
            ["env", "permissions", "hooks", "model", "attribution"]
        );
        let before = object(USER_FILE);
        for (key, value) in &before {
            assert_eq!(config.get(key), Some(value), "{key}");
        }
        assert_eq!(
            config.get("attribution"),
            Some(&Value::Object(managed_values()))
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn install_adds_the_values_to_an_attribution_object_and_keeps_its_other_keys() {
        let dir = temp("object");
        let dest = dir.join("settings.json");
        fs::write(&dest, r#"{"attribution":{"sessionUrl":true},"model":"x"}"#).unwrap();
        let rendered = render_install(&dest).expect("render");
        assert_eq!(
            serde_json::to_string(&object(&rendered)).unwrap(),
            r#"{"attribution":{"sessionUrl":true,"commit":"","pr":""},"model":"x"}"#
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn install_refuses_a_file_that_already_says_how_attribution_is_shown() {
        let dir = temp("user-set");
        let dest = dir.join("settings.json");
        for text in [
            r#"{"attribution":{"commit":"SECRET-MARKER","pr":""}}"#,
            r#"{"attribution":{"commit":"","pr":""}}"#,
            r#"{"attribution":false}"#,
            r#"{"includeCoAuthoredBy":false}"#,
            r#"{"attribution":"SECRET-MARKER"}"#,
        ] {
            fs::write(&dest, text).unwrap();
            let error = render_install(&dest).expect_err(text);
            assert!(!error.contains("SECRET-MARKER"), "{error}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_is_not_strict_json_is_refused_without_its_text() {
        let dir = temp("refuse");
        let dest = dir.join("settings.json");
        fs::write(&dest, "{\n  // SECRET-MARKER\n  \"model\": \"x\"\n}\n").unwrap();
        let error = render_install(&dest).expect_err("refused");
        assert!(error.contains("comments"), "{error}");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        assert_eq!(assess(&dest), Assessment::Refused(Refusal::Comments));
        assert_eq!(
            conflict_reason(&assess(&dest)).as_deref(),
            Some("settings.json: the file has comments; the app edits strict JSON only and writes nothing")
        );
        fs::write(&dest, "[\"SECRET-MARKER\"]").unwrap();
        let error = render_install(&dest).expect_err("refused");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        fs::write(&dest, "{\"model\":\"SECRET-MARKER\",}").unwrap();
        let error = render_install(&dest).expect_err("refused");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        fs::write(&dest, b"\xEF\xBB\xBF{}").unwrap();
        assert_eq!(assess(&dest), Assessment::Refused(Refusal::ByteOrderMark));
        fs::write(&dest, b"{\"a\":\"\xFF\"}").unwrap();
        assert_eq!(assess(&dest), Assessment::Refused(Refusal::NotUtf8));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unexpected_attribution_type_is_a_fixed_phrase_without_the_value() {
        let dir = temp("type");
        let dest = dir.join("settings.json");
        fs::write(&dest, r#"{"attribution":"SECRET-MARKER"}"#).unwrap();
        let assessment = assess(&dest);
        assert_eq!(assessment, Assessment::UnexpectedType);
        let reason = conflict_reason(&assessment).expect("reason");
        assert!(!reason.contains("SECRET-MARKER"), "{reason}");
        assert!(reason.contains("unexpected type"), "{reason}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_puts_the_file_back_when_apply_created_the_attribution_object() {
        let dir = temp("restore-created");
        let dest = dir.join("settings.json");
        let backup = dir.join("backup.json");
        fs::write(&backup, USER_FILE).unwrap();
        fs::write(&dest, render_install(&backup).unwrap()).unwrap();
        let restored = render_restored(&dest, &backup).expect("restored");
        assert_eq!(object(&restored), object(USER_FILE));
        assert_eq!(
            object(&restored).keys().collect::<Vec<_>>(),
            object(USER_FILE).keys().collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_keeps_the_attribution_object_the_backup_had_and_its_other_keys() {
        let dir = temp("restore-object");
        let dest = dir.join("settings.json");
        let backup = dir.join("backup.json");
        fs::write(
            &backup,
            r#"{"attribution":{"sessionUrl":true},"model":"x"}"#,
        )
        .unwrap();
        fs::write(&dest, render_install(&backup).unwrap()).unwrap();
        let restored = render_restored(&dest, &backup).expect("restored");
        assert_eq!(
            serde_json::to_string(&object(&restored)).unwrap(),
            r#"{"attribution":{"sessionUrl":true},"model":"x"}"#
        );
        // An empty object the user had stays an empty object.
        fs::write(&backup, r#"{"attribution":{}}"#).unwrap();
        fs::write(&dest, render_install(&backup).unwrap()).unwrap();
        let restored = render_restored(&dest, &backup).expect("restored");
        assert_eq!(
            serde_json::to_string(&object(&restored)).unwrap(),
            r#"{"attribution":{}}"#
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_keeps_what_the_user_changed_after_the_apply() {
        let dir = temp("restore-later");
        let dest = dir.join("settings.json");
        let backup = dir.join("backup.json");
        fs::write(&backup, USER_FILE).unwrap();
        let mut later = object(&render_install(&backup).unwrap());
        later.insert("model".into(), Value::String("sonnet".into()));
        if let Some(Value::Object(attribution)) = later.get_mut("attribution") {
            attribution.insert("sessionUrl".into(), Value::Bool(true));
        }
        fs::write(
            &dest,
            serde_json::to_string_pretty(&Value::Object(later)).unwrap(),
        )
        .unwrap();
        let restored = object(&render_restored(&dest, &backup).expect("restored"));
        assert_eq!(restored.get("model"), Some(&Value::String("sonnet".into())));
        assert_eq!(
            restored.get("attribution"),
            Some(&serde_json::json!({"sessionUrl": true})),
            "the key the user added stays, the managed values go"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_refuses_what_it_cannot_read_without_leaking_it() {
        let dir = temp("restore-refuse");
        let dest = dir.join("settings.json");
        let backup = dir.join("backup.json");
        fs::write(&backup, USER_FILE).unwrap();
        fs::write(&dest, "{\n  // SECRET-MARKER\n}\n").unwrap();
        let error = render_restored(&dest, &backup).expect_err("refused");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        fs::write(&dest, r#"{"attribution":"SECRET-MARKER"}"#).unwrap();
        let error = render_restored(&dest, &backup).expect_err("refused");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        fs::write(&dest, "{}").unwrap();
        fs::write(&backup, "[\"SECRET-MARKER\"]").unwrap();
        let error = render_restored(&dest, &backup).expect_err("refused");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        let _ = fs::remove_dir_all(dir);
    }
}
