//! The managed keys of OpenCode's `tui.json`.
//!
//! `tui.json` in the OpenCode config folder (`~/.config/opencode`, or
//! `$XDG_CONFIG_HOME/opencode`: `platform_paths::opencode_config_dir`) is the user's file. The app
//! manages only the top-level keys listed under `tui_top_level` in
//! `metadata/opencode-managed-keys.json`: install sets them to the bundled values
//! (`templates/tui.json`), removes a listed key the bundle no longer has, and keeps every other key (`keybinds`, `plugin`, `scroll_speed`, ...) with its value and its place in the
//! file. A missing file is created with the managed keys.
//!
//! The file is read and written as strict JSON with the reader of the light-tier MCP files: a file
//! with comments, a trailing comma, a byte order mark or anything else that is not a JSON object
//! is refused whole, with a fixed reason and no file text, and never rewritten. A write uses
//! two-space indentation and a final newline.

use std::path::Path;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::light_mcp::Refusal;

const MANAGED_KEYS_METADATA: &str =
    include_str!("../../resources/default-workspace/metadata/opencode-managed-keys.json");

/// The top-level keys the app manages in `tui.json`, in metadata order. An error only when the
/// embedded metadata is unusable; nothing is then planned or written for the file.
pub fn managed_keys() -> Result<&'static [String], String> {
    static KEYS: OnceLock<Result<Vec<String>, String>> = OnceLock::new();
    KEYS.get_or_init(|| parse_managed_keys(MANAGED_KEYS_METADATA))
        .as_deref()
        .map_err(Clone::clone)
}

fn parse_managed_keys(raw: &str) -> Result<Vec<String>, String> {
    let invalid = || "metadata tui_top_level must be a list of distinct key names".to_string();
    let metadata: Value =
        serde_json::from_str(raw).map_err(|_| "managed keys metadata is not JSON".to_string())?;
    let list = metadata
        .get("tui_top_level")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(invalid)?;
    let mut keys: Vec<String> = Vec::new();
    for item in list {
        let key = item
            .as_str()
            .filter(|key| !key.is_empty())
            .ok_or_else(invalid)?;
        if keys.iter().any(|known| known == key) {
            return Err(invalid());
        }
        keys.push(key.to_string());
    }
    Ok(keys)
}

/// Reads a `tui.json` (installed, backup or template): `Ok(None)` when there is none.
pub fn read(path: &Path) -> Result<Option<Map<String, Value>>, Refusal> {
    crate::light_mcp::read_object(path)
}

/// The bundled template. An error when it is missing or not a strict JSON object.
pub fn bundled(source: &Path) -> Result<Map<String, Value>, String> {
    match read(source) {
        Ok(Some(template)) => Ok(template),
        Ok(None) => Err("the bundled tui.json is missing".to_string()),
        Err(refusal) => Err(format!(
            "the bundled tui.json is unusable: {}",
            refusal.message()
        )),
    }
}

/// The managed keys `config` holds, in the order of `keys`.
pub fn managed_projection(config: &Map<String, Value>, keys: &[String]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| config.get(key).map(|value| (key.clone(), value.clone())))
        .collect()
}

/// The managed keys on which `installed` differs from `bundled`, in the order of `keys`. A key
/// only one of them holds differs.
pub fn differing_keys(
    installed: &Map<String, Value>,
    bundled: &Map<String, Value>,
    keys: &[String],
) -> Vec<String> {
    keys.iter()
        .filter(|key| installed.get(*key) != bundled.get(*key))
        .cloned()
        .collect()
}

/// `installed` with its managed keys aligned with `managed`: a key `managed` holds is set (in place
/// when the file has it, appended otherwise), a managed key it lacks is removed. Every other key
/// keeps its value and its place. The same operation puts a backup's managed keys back on
/// rollback.
pub fn merge(
    mut installed: Map<String, Value>,
    managed: &Map<String, Value>,
    keys: &[String],
) -> Map<String, Value> {
    for key in keys {
        if !managed.contains_key(key) {
            installed.shift_remove(key);
        }
    }
    for (key, value) in managed {
        if keys.contains(key) {
            installed.insert(key.clone(), value.clone());
        }
    }
    installed
}

/// How an installed `tui.json` stands against the bundled one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assessment {
    /// There is no file.
    Absent,
    /// The managed keys hold the bundled values (other keys do not matter).
    Synced,
    /// The managed keys that differ, by name.
    Differs(Vec<String>),
    /// The file is not one the app edits.
    Refused(Refusal),
}

pub fn assess(dest: &Path, bundled: &Map<String, Value>, keys: &[String]) -> Assessment {
    match read(dest) {
        Err(refusal) => Assessment::Refused(refusal),
        Ok(None) => Assessment::Absent,
        Ok(Some(installed)) => {
            let differing = differing_keys(&installed, bundled, keys);
            if differing.is_empty() {
                Assessment::Synced
            } else {
                Assessment::Differs(differing)
            }
        }
    }
}

/// Why a `tui.json` the app does not edit is left alone, for the review. A fixed phrase.
pub fn refusal_reason(refusal: Refusal) -> String {
    format!(
        "tui.json: {}; the app edits strict JSON only and writes nothing",
        refusal.message()
    )
}

/// The content install writes: the file at `dest` (or an empty one) with the managed keys of the
/// bundled `source`. A file the app does not edit is refused before anything is written.
pub fn render_install(source: &Path, dest: &Path) -> Result<String, String> {
    let keys = managed_keys()?;
    let template = bundled(source)?;
    let installed = read(dest)
        .map_err(|refusal| format!("refusing to change {}", refusal_reason(refusal)))?
        .unwrap_or_default();
    render(merge(installed, &managed_projection(&template, keys), keys))
}

/// The installed file with the managed keys put back as `backup` had them (and the ones it lacked
/// taken out again); everything else stays as it is now. An installed file or a backup that no
/// longer reads as strict JSON is an error: nothing is written.
pub fn render_restored(installed: &Path, backup: &Path) -> Result<String, String> {
    let keys = managed_keys()?;
    let current = read(installed)
        .map_err(|refusal| {
            format!(
                "installed tui.json cannot be restored: {}",
                refusal.message()
            )
        })?
        .ok_or_else(|| "installed tui.json is missing".to_string())?;
    let previous = read(backup)
        .map_err(|refusal| format!("backup of tui.json is unusable: {}", refusal.message()))?
        .ok_or_else(|| "backup of tui.json is missing".to_string())?;
    render(merge(current, &managed_projection(&previous, keys), keys))
}

fn render(config: Map<String, Value>) -> Result<String, String> {
    serde_json::to_string_pretty(&Value::Object(config))
        .map(|text| text + "\n")
        .map_err(|e| format!("serialize tui.json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn bundled_template_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../resources/default-workspace/templates/tui.json")
    }

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
        let dir = std::env::temp_dir().join(format!("aw-tui-{label}-{n}"));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn the_metadata_lists_every_key_of_the_bundled_template() {
        let keys = managed_keys().expect("metadata");
        let template = bundled(&bundled_template_path()).expect("template");
        assert!(!template.is_empty());
        for key in template.keys() {
            assert!(keys.contains(key), "template key {key} is not managed");
        }
    }

    #[test]
    fn unusable_metadata_is_an_error() {
        for raw in [
            "not json",
            "{}",
            r#"{"tui_top_level":[]}"#,
            r#"{"tui_top_level":["theme",""]}"#,
            r#"{"tui_top_level":["theme","theme"]}"#,
            r#"{"tui_top_level":["theme",1]}"#,
        ] {
            assert!(parse_managed_keys(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn a_new_file_is_the_bundled_template_byte_for_byte() {
        let dir = temp("create");
        let rendered =
            render_install(&bundled_template_path(), &dir.join("tui.json")).expect("render");
        assert_eq!(
            rendered,
            fs::read_to_string(bundled_template_path()).expect("template")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_sets_managed_keys_in_place_and_keeps_user_keys_and_their_order() {
        let keys: Vec<String> = ["$schema", "theme", "mouse", "retired"]
            .iter()
            .map(|key| key.to_string())
            .collect();
        let installed = object(
            r#"{"keybinds":{"leader":"ctrl+x"},"theme":"dark","plugin":["p"],"retired":1,"scroll_speed":3}"#,
        );
        let managed = object(r#"{"$schema":"s","theme":"system","mouse":true}"#);
        let merged = merge(installed, &managed, &keys);
        assert_eq!(
            serde_json::to_string(&merged).unwrap(),
            r#"{"keybinds":{"leader":"ctrl+x"},"theme":"system","plugin":["p"],"scroll_speed":3,"$schema":"s","mouse":true}"#
        );
    }

    #[test]
    fn only_managed_keys_decide_whether_the_file_is_synced() {
        let keys = managed_keys().expect("metadata");
        let template = bundled(&bundled_template_path()).expect("template");
        let mut installed = template.clone();
        installed.insert("keybinds".into(), serde_json::json!({"leader": "ctrl+x"}));
        assert!(differing_keys(&installed, &template, keys).is_empty());
        installed.insert("theme".into(), Value::String("dark".into()));
        installed.shift_remove("mouse");
        assert_eq!(
            differing_keys(&installed, &template, keys),
            vec!["theme".to_string(), "mouse".to_string()]
        );
    }

    #[test]
    fn a_file_that_is_not_strict_json_is_refused_without_its_text() {
        let dir = temp("refuse");
        let dest = dir.join("tui.json");
        fs::write(&dest, "{\n  // SECRET-MARKER\n  \"theme\": \"dark\"\n}\n").unwrap();
        let error = render_install(&bundled_template_path(), &dest).expect_err("refused");
        assert!(error.contains("comments"), "{error}");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        let template = bundled(&bundled_template_path()).unwrap();
        assert_eq!(
            assess(&dest, &template, managed_keys().unwrap()),
            Assessment::Refused(Refusal::Comments)
        );
        fs::write(&dest, "[\"SECRET-MARKER\"]").unwrap();
        let error = render_install(&bundled_template_path(), &dest).expect_err("refused");
        assert!(!error.contains("SECRET-MARKER"), "{error}");
        let _ = fs::remove_dir_all(dir);
    }
}
