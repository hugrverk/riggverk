//! "Keep mine" for the enforced keys of `$CODEX_HOME/config.toml`.
//!
//! The bundled template sets the enforced keys; a key the user set differently is an update (or a
//! conflict, once the ownership record no longer matches). The user can keep their value for a key:
//! `config-preferences.json` records it (see [`crate::config_preferences`]), and this module turns
//! that record into the projection every comparison uses: the template's projection with the kept
//! values substituted. A kept key applies only while the installed value still equals the kept
//! value, so a later edit makes the entry inert and the key is enforced again.
//!
//! Nothing here writes `config.toml`; an apply renders from the effective template, so it never
//! writes over a kept value.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::artifact_registry::ArtifactId;
use crate::config_preferences::{self, CodexConfigChoice, CODEX_KEEPABLE_PATHS};

/// One key and a value of it, for the status the frontend reads. Key names and the values of the
/// enforced approval and sandbox keys: nothing secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// What the Codex config surface tells about the enforced keys the user keeps or could keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CodexConfigStatus {
    /// Keys the user keeps, with the kept value: the installed value equals it.
    pub kept: Vec<KeyValue>,
    /// Enforced keys whose installed value differs from what Riggverk would write and is not
    /// kept: `m` can keep them.
    pub differing: Vec<KeyValue>,
}

/// The keys of the choice that apply right now.
pub struct Assessment {
    /// Kept keys whose installed value is the kept one.
    pub active: BTreeMap<String, String>,
    /// The template with `active` substituted: what the installed config is compared with.
    pub effective: toml::Value,
}

fn segments(path: &str) -> impl Iterator<Item = &str> {
    path.split('.')
}

fn value_at<'a>(config: &'a toml::Value, path: &str) -> Option<&'a toml::Value> {
    segments(path).try_fold(config, |current, key| current.get(key))
}

/// The string at the dotted `path`; any other kind of value is not keepable.
pub(crate) fn string_at(config: &toml::Value, path: &str) -> Option<String> {
    value_at(config, path)?.as_str().map(str::to_string)
}

/// Sets the string at `path`, creating the tables on the way. Returns false when a value that is
/// not a table is in the way.
fn set_string(config: &mut toml::Value, path: &str, value: &str) -> bool {
    let mut parts: Vec<&str> = segments(path).collect();
    let Some(last) = parts.pop() else {
        return false;
    };
    let mut current = config;
    for part in parts {
        let Some(table) = current.as_table_mut() else {
            return false;
        };
        current = table
            .entry(part.to_string())
            .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    }
    match current.as_table_mut() {
        Some(table) => {
            table.insert(last.to_string(), toml::Value::String(value.to_string()));
            true
        }
        None => false,
    }
}

/// Removes the value at `path`, leaving the tables on the way.
fn remove_value(config: &mut toml::Value, path: &str) {
    let mut parts: Vec<&str> = segments(path).collect();
    let Some(last) = parts.pop() else {
        return;
    };
    let mut current = config;
    for part in parts {
        let Some(next) = current.get_mut(part) else {
            return;
        };
        current = next;
    }
    if let Some(table) = current.as_table_mut() {
        table.remove(last);
    }
}

/// Where the Codex config resolves now, as a choice records it.
pub fn dest_label(workspace_root: &Path, home: &Path) -> Result<String, String> {
    crate::kept_files::dest_label(&ArtifactId::CodexConfig, home, workspace_root)
}

/// The recorded choice, when it was made for the config at the destination it has now.
fn choice_for_dest(workspace_root: &Path, home: &Path) -> Option<CodexConfigChoice> {
    let choice = config_preferences::load_codex_config(workspace_root)?;
    (dest_label(workspace_root, home).ok()? == choice.dest).then_some(choice)
}

/// The kept keys that apply to `installed`: those whose installed value equals the kept value.
pub fn active_kept(
    workspace_root: &Path,
    home: &Path,
    installed: &toml::Value,
) -> BTreeMap<String, String> {
    choice_for_dest(workspace_root, home)
        .map(|choice| {
            choice
                .kept
                .into_iter()
                .filter(|(key, value)| string_at(installed, key).as_deref() == Some(value))
                .collect()
        })
        .unwrap_or_default()
}

/// `template` with the kept values substituted.
pub fn effective_template(template: &toml::Value, kept: &BTreeMap<String, String>) -> toml::Value {
    let mut effective = template.clone();
    for (key, value) in kept {
        set_string(&mut effective, key, value);
    }
    effective
}

/// The kept keys of `installed` and the template they leave. With no workspace there is no
/// choice, and the template stands.
pub fn assess(
    workspace_root: Option<&Path>,
    home: &Path,
    installed: &toml::Value,
    template: &toml::Value,
) -> Assessment {
    let active = workspace_root
        .map(|root| active_kept(root, home, installed))
        .unwrap_or_default();
    let effective = effective_template(template, &active);
    Assessment { active, effective }
}

/// `installed` with the kept keys put back to the template's values (or removed where the
/// template has none): the config as it stood before the user kept anything. The ownership record
/// of the last apply describes that state.
pub fn with_kept_reset(
    installed: &toml::Value,
    template: &toml::Value,
    kept: &BTreeMap<String, String>,
) -> toml::Value {
    let mut reset = installed.clone();
    for key in kept.keys() {
        match string_at(template, key) {
            Some(value) => {
                set_string(&mut reset, key, &value);
            }
            None => remove_value(&mut reset, key),
        }
    }
    reset
}

/// Enforced keys whose installed value is a string that differs from `expected`, in a fixed order.
/// A key the installed config lacks is not listed: there is nothing of the user's to keep.
pub fn differing_keys(installed: &toml::Value, expected: &toml::Value) -> Vec<KeyValue> {
    CODEX_KEEPABLE_PATHS
        .iter()
        .filter_map(|key| {
            let value = string_at(installed, key)?;
            (string_at(expected, key).as_deref() != Some(value.as_str())).then(|| KeyValue {
                key: (*key).to_string(),
                value,
            })
        })
        .collect()
}

fn read_toml(path: &Path, what: &str) -> Result<toml::Value, String> {
    crate::path_safety::reject_symlink(path, what)?;
    let raw = std::fs::read_to_string(path).map_err(|_| format!("cannot read the {what}"))?;
    raw.parse::<toml::Value>()
        .map_err(|_| format!("the {what} is not valid TOML"))
}

/// The installed config and the bundled template of the Codex config, parsed.
fn read_pair(workspace_root: &Path, home: &Path) -> Result<(toml::Value, toml::Value), String> {
    let artifact = ArtifactId::CodexConfig;
    let dest = artifact.resolve_dest(home, workspace_root)?;
    if !dest.is_file() {
        return Err("the Codex config.toml is not installed; there is nothing to keep".to_string());
    }
    let bundled = crate::setup_roots::bundled_root_for(workspace_root)?;
    let source = artifact
        .resolve_bundle_source(&bundled)
        .ok_or_else(|| "the bundled Codex config is unavailable".to_string())?;
    Ok((
        read_toml(&dest, "installed Codex config.toml")?,
        read_toml(&source, "bundled Codex config")?,
    ))
}

/// What the Codex config surface tells about the keys the user keeps or could keep; `None` when
/// there is neither, or the config cannot be read.
pub fn status(workspace_root: &Path, home: &Path) -> Option<CodexConfigStatus> {
    let (installed, template) = read_pair(workspace_root, home).ok()?;
    let assessment = assess(Some(workspace_root), home, &installed, &template);
    let kept: Vec<KeyValue> = assessment
        .active
        .iter()
        .map(|(key, value)| KeyValue {
            key: key.clone(),
            value: value.clone(),
        })
        .collect();
    let differing = differing_keys(&installed, &assessment.effective);
    (!kept.is_empty() || !differing.is_empty()).then_some(CodexConfigStatus { kept, differing })
}

/// Records every enforced key whose installed value differs from the template, with that value.
/// Refuses when the config cannot be read or nothing differs. Writes only
/// `config-preferences.json`.
pub fn keep(workspace_root: &Path, home: &Path) -> Result<Vec<KeyValue>, String> {
    let (installed, template) = read_pair(workspace_root, home)?;
    let differing = differing_keys(&installed, &template);
    if differing.is_empty() {
        return Err(
            "no enforced key differs from the bundled config; there is nothing to keep".to_string(),
        );
    }
    let choice = CodexConfigChoice {
        dest: dest_label(workspace_root, home)?,
        kept: differing
            .iter()
            .map(|item| (item.key.clone(), item.value.clone()))
            .collect(),
    };
    config_preferences::set_codex_config(workspace_root, Some(choice))?;
    Ok(differing)
}

/// Clears the choice: every enforced key follows the bundle again.
pub fn hand_back(workspace_root: &Path) -> Result<(), String> {
    config_preferences::set_codex_config(workspace_root, None)
}

/// The conflict line for the config: which keys differ and what `m` does. Key names only.
pub fn conflict_reason(workspace_root: &Path, home: &Path) -> Option<String> {
    let status = status(workspace_root, home)?;
    if status.differing.is_empty() {
        return None;
    }
    let keys = status
        .differing
        .iter()
        .map(|item| item.key.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let (verb, noun) = if status.differing.len() == 1 {
        ("differs", "value")
    } else {
        ("differ", "values")
    };
    Some(format!(
        "{keys} {verb} from Riggverk's and changed since Riggverk wrote the file, so nothing is written; m keeps your {noun}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> toml::Value {
        text.parse().expect("test toml")
    }

    const TEMPLATE: &str = r#"
model = "gpt-6.1-sol"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
apps._default.approvals_reviewer = "user"
apps._default.default_tools_approval_mode = "prompt"
"#;

    fn kept(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn the_effective_template_substitutes_only_the_kept_values() {
        let effective = effective_template(
            &parse(TEMPLATE),
            &kept(&[
                ("approvals_reviewer", "auto_review"),
                ("apps._default.approvals_reviewer", "auto_review"),
            ]),
        );
        assert_eq!(
            string_at(&effective, "approvals_reviewer").as_deref(),
            Some("auto_review")
        );
        assert_eq!(
            string_at(&effective, "apps._default.approvals_reviewer").as_deref(),
            Some("auto_review")
        );
        assert_eq!(
            string_at(&effective, "sandbox_mode").as_deref(),
            Some("workspace-write")
        );
        assert_eq!(
            string_at(&effective, "model").as_deref(),
            Some("gpt-6.1-sol")
        );
    }

    #[test]
    fn differing_keys_list_string_values_that_differ_in_a_fixed_order() {
        let installed = parse(
            r#"
approval_policy = "never"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
apps._default.default_tools_approval_mode = "approve"
"#,
        );
        let keys: Vec<(String, String)> = differing_keys(&installed, &parse(TEMPLATE))
            .into_iter()
            .map(|item| (item.key, item.value))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("approval_policy".to_string(), "never".to_string()),
                ("approvals_reviewer".to_string(), "auto_review".to_string()),
                (
                    "apps._default.default_tools_approval_mode".to_string(),
                    "approve".to_string()
                ),
            ]
        );
    }

    #[test]
    fn a_missing_or_non_string_value_is_not_something_to_keep() {
        let installed = parse(
            r#"
approval_policy = { granular = { rules = true } }
"#,
        );
        assert!(differing_keys(&installed, &parse(TEMPLATE)).is_empty());
    }

    #[test]
    fn resetting_kept_keys_restores_the_template_values() {
        let installed = parse(
            r#"
approvals_reviewer = "auto_review"
sandbox_mode = "read-only"
"#,
        );
        let reset = with_kept_reset(
            &installed,
            &parse(TEMPLATE),
            &kept(&[("approvals_reviewer", "auto_review")]),
        );
        assert_eq!(
            string_at(&reset, "approvals_reviewer").as_deref(),
            Some("user")
        );
        assert_eq!(
            string_at(&reset, "sandbox_mode").as_deref(),
            Some("read-only")
        );
    }

    /// A temp home and workspace, with `CODEX_HOME` unset unless a test sets it.
    struct Dirs {
        base: std::path::PathBuf,
        home: std::path::PathBuf,
        ws: std::path::PathBuf,
        _restore: crate::test_env::guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Dirs {
        fn new(label: &str) -> Self {
            let lock = crate::test_env::guard::lock();
            let restore = crate::test_env::guard::EnvRestore::capture();
            unsafe { std::env::remove_var("CODEX_HOME") };
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-codex-keep-unit-{label}-{nanos}"));
            let home = base.join("home");
            let ws = base.join("workspace");
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&ws).unwrap();
            Self {
                base,
                home,
                ws,
                _restore: restore,
                _lock: lock,
            }
        }

        fn keep(&self, pairs: &[(&str, &str)]) {
            config_preferences::set_codex_config(
                &self.ws,
                Some(CodexConfigChoice {
                    dest: dest_label(&self.ws, &self.home).unwrap(),
                    kept: kept(pairs),
                }),
            )
            .unwrap();
        }
    }

    impl Drop for Dirs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn a_kept_key_applies_only_while_the_installed_value_is_the_kept_one() {
        let dirs = Dirs::new("matching");
        dirs.keep(&[("approvals_reviewer", "auto_review")]);

        let same = parse("approvals_reviewer = \"auto_review\"\n");
        assert_eq!(
            active_kept(&dirs.ws, &dirs.home, &same),
            kept(&[("approvals_reviewer", "auto_review")])
        );
        for changed in [
            "approvals_reviewer = \"user\"\n",
            "approvals_reviewer = \"something_else\"\n",
            "sandbox_mode = \"read-only\"\n",
        ] {
            assert!(
                active_kept(&dirs.ws, &dirs.home, &parse(changed)).is_empty(),
                "{changed}"
            );
        }
    }

    #[test]
    fn a_choice_made_for_another_destination_is_inert() {
        let dirs = Dirs::new("dest");
        dirs.keep(&[("approvals_reviewer", "auto_review")]);
        let installed = parse("approvals_reviewer = \"auto_review\"\n");
        assert!(!active_kept(&dirs.ws, &dirs.home, &installed).is_empty());

        // CODEX_HOME moves the config file: the choice was made for another file.
        let elsewhere = dirs.base.join("elsewhere");
        unsafe { std::env::set_var("CODEX_HOME", &elsewhere) };
        assert!(active_kept(&dirs.ws, &dirs.home, &installed).is_empty());
        let assessment = assess(Some(&dirs.ws), &dirs.home, &installed, &parse(TEMPLATE));
        assert_eq!(
            string_at(&assessment.effective, "approvals_reviewer").as_deref(),
            Some("user")
        );
    }

    #[test]
    fn malformed_or_foreign_preferences_keep_nothing() {
        let dirs = Dirs::new("malformed");
        let installed = parse("approvals_reviewer = \"auto_review\"\n");
        std::fs::create_dir_all(dirs.ws.join(crate::workspace_layout::STATE_DIR)).unwrap();
        let path = crate::workspace_layout::state_file(
            &dirs.ws,
            config_preferences::CONFIG_PREFERENCES_FILE,
        );
        let dest = dest_label(&dirs.ws, &dirs.home).unwrap();
        for raw in [
            "not json".to_string(),
            format!(
                r#"{{"schema_version":9,"codex_config":{{"dest":"{dest}","kept":{{"approvals_reviewer":"auto_review"}}}}}}"#
            ),
            format!(
                r#"{{"schema_version":1,"codex_config":{{"dest":"{dest}","kept":{{"approvals_reviewer":42}}}}}}"#
            ),
        ] {
            std::fs::write(&path, &raw).unwrap();
            assert!(
                active_kept(&dirs.ws, &dirs.home, &installed).is_empty(),
                "{raw}"
            );
        }
        // Without a workspace folder there is no choice at all.
        let assessment = assess(None, &dirs.home, &installed, &parse(TEMPLATE));
        assert!(assessment.active.is_empty());
    }

    #[test]
    fn handing_back_clears_every_kept_key() {
        let dirs = Dirs::new("hand-back");
        dirs.keep(&[
            ("approvals_reviewer", "auto_review"),
            ("sandbox_mode", "read-only"),
        ]);
        assert_eq!(
            config_preferences::load_codex_config(&dirs.ws)
                .unwrap()
                .kept
                .len(),
            2
        );
        hand_back(&dirs.ws).unwrap();
        assert!(config_preferences::load_codex_config(&dirs.ws).is_none());
        let installed = parse("approvals_reviewer = \"auto_review\"\n");
        assert!(active_kept(&dirs.ws, &dirs.home, &installed).is_empty());
    }
}
