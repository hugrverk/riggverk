//! The review lines of the OpenCode config surface.
//!
//! Install merges the managed keys into the user's existing `opencode.json` and `tui.json`
//! (`metadata/opencode-managed-keys.json`), so a value the user set for one of them is replaced.
//! The review says so before anything is written: one line per managed key the install changes,
//! with what the file holds now and what it becomes, in the order of
//! `differing_managed_opencode_keys` and `opencode_tui::differing_keys`. A file the surface
//! creates, and the Playwright MCP config it updates, keep one line each.
//!
//! No line carries a secret. A scalar (string, number, boolean, null) is shown as JSON, cut to
//! [`MAX_SCALAR_CHARS`]; an object or a list only by its shape: how many entries or items it has
//! and, for an object, up to [`MAX_SHAPE_NAMES`] of its top-level key names. An `mcp.<server>`
//! entry (its command, environment and headers can hold credentials) is never shown at all.
//!
//! Each line has the shape the review parses: the update mark `~` (the key changes inside the one
//! existing file, which is backed up first), the file and key, and a note in parentheses that ends
//! the line and says whether the value is added, replaced or removed.

use std::path::Path;

use serde_json::{Map, Value};

use crate::artifact_registry::ArtifactId;
use crate::setup_lifecycle::OperationKind;

const MAX_SCALAR_CHARS: usize = 48;
const MAX_SHAPE_NAMES: usize = 3;
const MAX_NAME_CHARS: usize = 32;

/// The review lines of one planned artifact of the OpenCode config surface: per managed key for
/// an update of `opencode.json` or `tui.json`, one line for a file it creates or the Playwright
/// MCP config it updates, none otherwise.
pub(crate) fn artifact_lines(
    artifact: &ArtifactId,
    kind: OperationKind,
    dest: &Path,
    source: &Path,
    workspace_root: &Path,
    home: &Path,
) -> Vec<String> {
    match kind {
        OperationKind::Create => vec![format!("+ {} (new file)", display(dest, home))],
        OperationKind::Update => {
            let keys = match artifact {
                ArtifactId::OpenCodeConfig => config_file_lines(dest, source, workspace_root, home),
                ArtifactId::OpenCodeTui => tui_file_lines(dest, source),
                _ => Vec::new(),
            };
            if !keys.is_empty() {
                keys
            } else if *artifact == ArtifactId::OpenCodePlaywrightMcp {
                vec![format!(
                    "~ {} (Riggverk's copy is updated)",
                    display(dest, home)
                )]
            } else {
                vec![format!(
                    "~ {} (managed keys change; your other keys stay)",
                    display(dest, home)
                )]
            }
        }
        _ => Vec::new(),
    }
}

fn config_file_lines(
    dest: &Path,
    source: &Path,
    workspace_root: &Path,
    home: &Path,
) -> Vec<String> {
    let installed = crate::setup_fingerprint::read_user_config(dest, "OpenCode opencode.json")
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let rendered = std::fs::read_to_string(source)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|template| crate::commands::render_expected_opencode_config(&template, home));
    let (Some(installed), Some(rendered)) = (installed, rendered) else {
        return Vec::new();
    };
    let app = crate::commands::AppRoleModels::load(Some(workspace_root), home);
    config_lines(&installed, &rendered, &app)
}

/// One line per managed key on which an install changes `installed`: the keys the plan compares
/// (the user's own role models left out), with the value now and the one the merge writes.
pub(crate) fn config_lines(
    installed: &Value,
    rendered: &Value,
    app: &crate::commands::AppRoleModels,
) -> Vec<String> {
    use crate::commands::{
        differing_managed_opencode_keys, managed_opencode_install_projection,
        merge_managed_opencode_config, without_user_role_models,
    };
    let merged = merge_managed_opencode_config(
        installed,
        &managed_opencode_install_projection(installed, rendered, app),
    );
    differing_managed_opencode_keys(&without_user_role_models(installed, app), rendered)
        .iter()
        .filter_map(|key| {
            let (name, before, after) = match key.split_once('.') {
                Some(("mcp", server)) => (
                    key.clone(),
                    nested(installed, &["mcp", server]),
                    nested(&merged, &["mcp", server]),
                ),
                Some(("agent", rest)) => {
                    let (agent, field) = rest.split_once('.').unwrap_or((rest, "permission"));
                    (
                        format!("agent.{agent}.{field}"),
                        nested(installed, &["agent", agent, field]),
                        nested(&merged, &["agent", agent, field]),
                    )
                }
                _ => (key.clone(), installed.get(key), merged.get(key)),
            };
            key_line("opencode.json", &name, before, after)
        })
        .collect()
}

fn tui_file_lines(dest: &Path, source: &Path) -> Vec<String> {
    let (Ok(keys), Ok(template), Ok(Some(installed))) = (
        crate::opencode_tui::managed_keys(),
        crate::opencode_tui::bundled(source),
        crate::opencode_tui::read(dest),
    ) else {
        return Vec::new();
    };
    tui_lines(&installed, &template, keys)
}

/// One line per managed key of `tui.json` on which an install changes `installed`.
pub(crate) fn tui_lines(
    installed: &Map<String, Value>,
    template: &Map<String, Value>,
    keys: &[String],
) -> Vec<String> {
    let merged = crate::opencode_tui::merge(
        installed.clone(),
        &crate::opencode_tui::managed_projection(template, keys),
        keys,
    );
    crate::opencode_tui::differing_keys(installed, template, keys)
        .iter()
        .filter_map(|key| key_line("tui.json", key, installed.get(key), merged.get(key)))
        .collect()
}

fn nested<'a>(config: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(config, |value, key| value.get(*key))
}

/// The line of one key, or `None` when the install leaves it as it is.
fn key_line(
    file: &str,
    key: &str,
    before: Option<&Value>,
    after: Option<&Value>,
) -> Option<String> {
    let entry = key.starts_with("mcp.");
    let note = match (before, after) {
        (Some(before), Some(after)) if before == after => return None,
        (None, None) => return None,
        (None, Some(_)) if entry => "not set now; Riggverk's entry is added".to_string(),
        (Some(_), Some(_)) if entry => "your entry is replaced by Riggverk's".to_string(),
        (Some(_), None) if entry => "your entry is removed".to_string(),
        (None, Some(after)) => format!("not set now; becomes {}", shown(after, "Riggverk's")),
        (Some(before), Some(after)) => format!(
            "now {}; becomes {}",
            shown(before, "your"),
            shown(after, "Riggverk's")
        ),
        (Some(before), None) => format!("now {}; removed", shown(before, "your")),
    };
    // Every key row updates the one existing file (backed up first); the note says how.
    Some(format!("~ {file} {key} ({note})"))
}

/// A value as the review shows it: a scalar as JSON, an object or a list by its shape only.
fn shown(value: &Value, whose: &str) -> String {
    match value {
        Value::Object(map) if map.is_empty() => format!("{whose} empty settings"),
        Value::Object(map) => {
            let mut names: Vec<String> = map
                .keys()
                .take(MAX_SHAPE_NAMES)
                .map(|name| clipped(name, MAX_NAME_CHARS))
                .collect();
            if map.len() > MAX_SHAPE_NAMES {
                names.push("...".to_string());
            }
            format!(
                "{whose} settings with {} entr{}: {}",
                map.len(),
                if map.len() == 1 { "y" } else { "ies" },
                names.join(", ")
            )
        }
        Value::Array(items) => format!(
            "{whose} list of {} item{}",
            items.len(),
            if items.len() == 1 { "" } else { "s" }
        ),
        Value::String(text) => {
            let cut = clipped(text, MAX_SCALAR_CHARS);
            serde_json::to_string(&cut).unwrap_or_default()
        }
        scalar => clipped(&scalar.to_string(), MAX_SCALAR_CHARS),
    }
}

/// `text` cut to `max` characters, control characters made visible as `?`.
fn clipped(text: &str, max: usize) -> String {
    let mut out: String = text
        .chars()
        .take(max)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect();
    if text.chars().count() > max {
        out.push_str("...");
    }
    out
}

/// `dest` for the review: `~/...` below the home folder, as it is otherwise.
fn display(dest: &Path, home: &Path) -> String {
    match dest.strip_prefix(home) {
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => dest.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_key_line_says_added_replaced_or_removed() {
        let line = |before: Option<Value>, after: Option<Value>| {
            key_line("tui.json", "theme", before.as_ref(), after.as_ref())
        };
        assert_eq!(
            line(None, Some(json!("system"))).as_deref(),
            Some("~ tui.json theme (not set now; becomes \"system\")")
        );
        assert_eq!(
            line(Some(json!(false)), Some(json!(true))).as_deref(),
            Some("~ tui.json theme (now false; becomes true)")
        );
        assert_eq!(
            line(Some(json!(2000)), None).as_deref(),
            Some("~ tui.json theme (now 2000; removed)")
        );
        assert_eq!(line(Some(json!(1)), Some(json!(1))), None);
        assert_eq!(line(None, None), None);
    }

    #[test]
    fn objects_and_lists_show_only_their_shape_and_long_strings_are_cut() {
        let settings = json!({"a": {"env": {"K": "secret-value"}}, "b": 1, "c": [], "d": "x"});
        assert_eq!(
            shown(&settings, "your"),
            "your settings with 4 entries: a, b, c, ..."
        );
        assert_eq!(
            shown(&json!({"only": "secret-value"}), "your"),
            "your settings with 1 entry: only"
        );
        assert_eq!(shown(&json!({}), "your"), "your empty settings");
        assert_eq!(
            shown(&json!(["secret-value", 2]), "Riggverk's"),
            "Riggverk's list of 2 items"
        );
        let long = "x".repeat(MAX_SCALAR_CHARS + 10);
        assert_eq!(
            shown(&json!(long), "your"),
            format!("\"{}...\"", "x".repeat(MAX_SCALAR_CHARS))
        );
        assert_eq!(shown(&json!("a\nb"), "your"), "\"a?b\"");
        assert_eq!(shown(&Value::Null, "your"), "null");
    }

    #[test]
    fn an_mcp_entry_is_never_shown() {
        let secret = json!({"command": ["npx", "--token=sk-live-123"], "environment": {"T": "s"}});
        for (before, after, expected) in [
            (
                Some(&secret),
                Some(&json!({"type": "local"})),
                "~ opencode.json mcp.playwright (your entry is replaced by Riggverk's)",
            ),
            (
                None,
                Some(&secret),
                "~ opencode.json mcp.playwright (not set now; Riggverk's entry is added)",
            ),
            (
                Some(&secret),
                None,
                "~ opencode.json mcp.playwright (your entry is removed)",
            ),
        ] {
            assert_eq!(
                key_line("opencode.json", "mcp.playwright", before, after).as_deref(),
                Some(expected)
            );
        }
    }

    #[test]
    fn tui_lines_follow_the_managed_keys_and_name_a_key_the_merge_removes() {
        let keys: Vec<String> = ["theme", "mouse", "leader_timeout", "gone"]
            .map(String::from)
            .to_vec();
        let installed =
            object(json!({"keybinds": {"x": "y"}, "theme": "gruvbox", "gone": 1, "mouse": true}));
        let template = object(json!({"theme": "system", "mouse": true, "leader_timeout": 2000}));
        assert_eq!(
            tui_lines(&installed, &template, &keys),
            [
                "~ tui.json theme (now \"gruvbox\"; becomes \"system\")",
                "~ tui.json leader_timeout (not set now; becomes 2000)",
                "~ tui.json gone (now 1; removed)",
            ]
        );
    }
}
