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
//! writes over a kept value. The one way a differing value is replaced is the explicit "use
//! Riggverk's defaults" reset: [`plan_defaults`] plans it, and the regular setup transaction
//! (backup, manifest, post-write check, rollback) writes exactly the planned content.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::artifact_registry::ArtifactId;
use crate::config_preferences::{self, CodexConfigChoice, CODEX_KEEPABLE_PATHS};
use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
use crate::setup_transaction::{self, PlannedArtifact, PreviousState, RulesRewrite};

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
    /// What Riggverk writes for each key in `kept` and `differing`: the bundled config's value,
    /// not the kept or installed one. A key the bundled config does not set is left out.
    pub expected: Vec<KeyValue>,
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
    let expected = kept
        .iter()
        .chain(&differing)
        .filter_map(|item| {
            Some(KeyValue {
                key: item.key.clone(),
                value: string_at(&template, &item.key)?,
            })
        })
        .collect();
    (!kept.is_empty() || !differing.is_empty()).then_some(CodexConfigStatus {
        kept,
        differing,
        expected,
    })
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

// ── Use Riggverk's defaults ──

/// Largest `config.toml` the defaults reset reads and rewrites.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
/// Longest value shown in a preview; the reset itself never cuts a value.
const MAX_SHOWN_VALUE_CHARS: usize = 120;

const NOTHING_TO_RESET: &str =
    "no enforced key differs from the bundled config; there is nothing to reset";
const CANNOT_EDIT_SAFELY: &str =
    "Riggverk cannot edit this config.toml safely (its structure is ambiguous); change the keys by hand";

/// One enforced key the reset sets to Riggverk's value. Key names and the values of the enforced
/// approval and sandbox keys: nothing secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DefaultKey {
    pub key: String,
    /// The installed value that is replaced (cut when very long).
    pub yours: String,
    /// The bundled config's value that is written.
    pub riggverk: String,
}

/// A reviewed reset: the keys, and the transaction operation that writes exactly the previewed
/// content.
pub struct DefaultsPlan {
    pub keys: Vec<DefaultKey>,
    pub operation: PlannedArtifact,
}

fn shown(value: &str) -> String {
    if value.chars().count() <= MAX_SHOWN_VALUE_CHARS {
        return value.to_string();
    }
    let cut: String = value.chars().take(MAX_SHOWN_VALUE_CHARS).collect();
    format!("{cut}...")
}

/// Removes the tables that are empty, on the way up; true when `value` itself is an empty table.
fn prune_empty_tables(value: &mut toml::Value) -> bool {
    let Some(table) = value.as_table_mut() else {
        return false;
    };
    let empty: Vec<String> = table
        .iter_mut()
        .filter_map(|(key, child)| prune_empty_tables(child).then(|| key.clone()))
        .collect();
    for key in empty {
        table.remove(&key);
    }
    table.is_empty()
}

/// The legacy profile tables the regular update removes when they still have the shape the app
/// wrote.
const LEGACY_PROFILE_PATHS: [&str; 2] = ["profiles.safe", "profiles.workspace-write"];

/// The config without any key the render may touch, and without empty tables: what must come out
/// of the render exactly as it went in.
fn user_part(config: &toml::Value) -> toml::Value {
    let mut rest = config.clone();
    for path in CODEX_KEEPABLE_PATHS
        .iter()
        .chain(crate::commands::CREATE_ONLY_TOP_LEVEL_KEYS)
        .chain(&["profile"])
        .chain(&LEGACY_PROFILE_PATHS)
    {
        remove_value(&mut rest, path);
    }
    prune_empty_tables(&mut rest);
    rest
}

/// Checks the rendered file before it is offered, key by key, so that it differs from the
/// installed file only where the preview says so:
/// - a key being reset holds Riggverk's value;
/// - a key the user still keeps holds the kept value;
/// - any other enforced or create-only key that is set is unchanged, whatever kind of value it
///   is; when it is absent it may only be added with the bundled value;
/// - `profile` and the two legacy `profiles` tables may only be removed, and only when they are
///   the app-shipped remnants the regular update removes;
/// - everything else is unchanged.
fn check_rendered(
    installed: &toml::Value,
    rendered: &toml::Value,
    template: &toml::Value,
    keys: &[DefaultKey],
    kept: &BTreeMap<String, String>,
) -> Result<(), String> {
    let refused = || Err(CANNOT_EDIT_SAFELY.to_string());
    let string = |value: &str| toml::Value::String(value.to_string());
    for path in CODEX_KEEPABLE_PATHS
        .iter()
        .chain(crate::commands::CREATE_ONLY_TOP_LEVEL_KEYS)
    {
        let (before, after) = (value_at(installed, path), value_at(rendered, path));
        let allowed = if let Some(item) = keys.iter().find(|item| item.key == *path) {
            after == Some(&string(&item.riggverk))
        } else if let Some(value) = kept.get(*path) {
            after == Some(&string(value))
        } else if before.is_some() {
            after == before
        } else {
            after.is_none() || after == value_at(template, path)
        };
        if !allowed {
            return refused();
        }
    }
    let (before, after) = (
        value_at(installed, "profile"),
        value_at(rendered, "profile"),
    );
    let removable = matches!(
        before,
        Some(toml::Value::String(selector))
            if crate::commands::LEGACY_TOP_LEVEL_PROFILE_VALUES.contains(&selector.as_str())
    );
    if after != before && !(removable && after.is_none()) {
        return refused();
    }
    for path in LEGACY_PROFILE_PATHS {
        let (before, after) = (value_at(installed, path), value_at(rendered, path));
        let removable = matches!(
            before,
            Some(toml::Value::Table(profile)) if crate::commands::is_app_shaped_legacy_profile(profile)
        );
        if after != before && !(removable && after.is_none()) {
            return refused();
        }
    }
    if user_part(installed) != user_part(rendered) {
        return refused();
    }
    Ok(())
}

/// Reads the Codex `config.toml` for a reset: a regular file with no link at the path, at most
/// [`MAX_CONFIG_BYTES`]. The path is checked, opened, and checked again, and the file that was
/// opened must be the one the path names after the open (same device and inode on unix), so a link
/// swapped in between is never read. The read itself is bounded, whatever the file grows to.
pub(crate) fn read_config_bounded(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    const NOT_REGULAR: &str = "the Codex config.toml is not a regular file";
    const UNREADABLE: &str = "cannot read the installed Codex config.toml";
    let before = std::fs::symlink_metadata(path).map_err(|_| UNREADABLE.to_string())?;
    if !before.is_file() {
        return Err(NOT_REGULAR.to_string());
    }
    let file = std::fs::File::open(path).map_err(|_| UNREADABLE.to_string())?;
    let opened = file.metadata().map_err(|_| UNREADABLE.to_string())?;
    let after = std::fs::symlink_metadata(path).map_err(|_| UNREADABLE.to_string())?;
    if !opened.is_file() || !after.is_file() {
        return Err(NOT_REGULAR.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != after.dev() || opened.ino() != after.ino() {
            return Err(
                "the Codex config.toml changed while it was being read; try again".to_string(),
            );
        }
    }
    let mut content = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|_| UNREADABLE.to_string())?;
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("the Codex config.toml is too large to reset here".to_string());
    }
    Ok(content)
}

/// Plans the reset of every differing enforced key to Riggverk's value. Read-only.
///
/// The file is rendered by the same merge scripts an update uses (so comments, other keys and the
/// create-only keys survive), then checked. The operation carries the exact content and the
/// digest of the file it was computed from; the transaction writes nothing else, and nothing over
/// a file that changed since. Keys the user keeps are rendered from their kept value, as in an
/// update. Refuses when nothing differs, or when the config is unreadable, not valid TOML, a link
/// or too large.
pub fn plan_defaults(workspace_root: &Path, home: &Path) -> Result<DefaultsPlan, String> {
    let artifact = ArtifactId::CodexConfig;
    let (source, dest) =
        setup_transaction::validate_artifact_source_dest(&artifact, workspace_root, home)?;
    if std::fs::symlink_metadata(&dest).is_err() {
        return Err(
            "the Codex config.toml is not installed; there is nothing to reset".to_string(),
        );
    }
    let installed_bytes = read_config_bounded(&dest)?;
    let installed_text = String::from_utf8(installed_bytes.clone())
        .map_err(|_| "the installed Codex config.toml is not valid TOML".to_string())?;
    let installed: toml::Value = installed_text
        .parse()
        .map_err(|_| "the installed Codex config.toml is not valid TOML".to_string())?;
    let template = read_toml(&source, "bundled Codex config")?;

    let assessment = assess(Some(workspace_root), home, &installed, &template);
    let keys: Vec<DefaultKey> = differing_keys(&installed, &assessment.effective)
        .into_iter()
        .filter_map(|item| {
            let riggverk = string_at(&template, &item.key)?;
            Some(DefaultKey {
                key: item.key,
                yours: shown(&item.value),
                riggverk,
            })
        })
        .collect();
    if keys.is_empty() {
        return Err(NOTHING_TO_RESET.to_string());
    }

    let rendered = crate::commands::render_codex_config_for_apply(
        &crate::setup_roots::bundled_root_for(workspace_root)?,
        workspace_root,
        home,
        &dest,
        &source,
    )
    .map_err(|error| {
        if error == crate::commands::CODEX_PYTHON_REQUIRED {
            error
        } else {
            CANNOT_EDIT_SAFELY.to_string()
        }
    })?;
    let rendered_toml: toml::Value = rendered
        .parse()
        .map_err(|_| CANNOT_EDIT_SAFELY.to_string())?;
    check_rendered(
        &installed,
        &rendered_toml,
        &template,
        &keys,
        &assessment.active,
    )?;
    if rendered == installed_text {
        return Err(NOTHING_TO_RESET.to_string());
    }
    // The merge scripts read the file themselves: it must still be the bytes planned from.
    let digest = crate::stable_digest::bytes(&installed_bytes);
    let unchanged = read_config_bounded(&dest)
        .map(|now| crate::stable_digest::bytes(&now) == digest)
        .unwrap_or(false);
    if !unchanged {
        return Err("the Codex config.toml changed while it was being read; try again".to_string());
    }

    let operation = PlannedArtifact {
        artifact,
        surface: SetupSurfaceId::CodexConfig,
        kind: OperationKind::Update,
        previous_state: PreviousState::MergeableConfigFile,
        rollback_action: setup_transaction::rollback_action_for(
            OperationKind::Update,
            PreviousState::MergeableConfigFile,
        ),
        rules: None,
        // The exact content to write and the file it replaces; see `apply_single_artifact`.
        rules_rewrite: Some(RulesRewrite {
            content: rendered,
            expected_installed_digest: digest,
        }),
        mcp: None,
        file: None,
        overwrite: None,
    };
    Ok(DefaultsPlan { keys, operation })
}

/// The preview text of a reset: one removed and one added line per key. Built from the key names
/// and the enforced values only, never from other text of the file.
pub fn defaults_diff(keys: &[DefaultKey]) -> String {
    let quoted = |value: &str| serde_json::to_string(value).unwrap_or_default();
    keys.iter()
        .flat_map(|item| {
            [
                format!("- {} = {}", item.key, quoted(&item.yours)),
                format!("+ {} = {}", item.key, quoted(&item.riggverk)),
            ]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Names this kind of request in its fingerprint, so a fingerprint of a reset can never equal one
/// of another kind of request, whatever the other parts are made of.
const DEFAULTS_FINGERPRINT_TAG: &str = "codex-config-defaults";

/// Fingerprint of a reset: a tag naming the request, the regular plan fingerprint, the digest of
/// the file it replaces and the digest of the exact content that replaces it. An edit of the
/// config after the preview changes it.
pub fn defaults_fingerprint(
    workspace_root: &Path,
    home: &Path,
    plan: &DefaultsPlan,
) -> Result<String, String> {
    let rewrite = plan
        .operation
        .rules_rewrite
        .as_ref()
        .ok_or_else(|| "reset without content".to_string())?;
    let base = setup_transaction::compute_plan_fingerprint(
        workspace_root,
        &[plan.operation.surface],
        std::slice::from_ref(&plan.operation),
        home,
    )?;
    setup_transaction::stable_fingerprint(&[
        DEFAULTS_FINGERPRINT_TAG.to_string(),
        base,
        rewrite.expected_installed_digest.clone(),
        crate::stable_digest::bytes(rewrite.content.as_bytes()),
    ])
}

/// Drops the kept entries of the keys a reset set to Riggverk's value: the choice is over, and a
/// later edit back to the old value must be a new difference, not silently covered. An entry made
/// for another destination is left alone.
pub fn clear_kept(workspace_root: &Path, home: &Path, keys: &[DefaultKey]) -> Result<(), String> {
    let Some(mut choice) = choice_for_dest(workspace_root, home) else {
        return Ok(());
    };
    let before = choice.kept.len();
    choice
        .kept
        .retain(|key, _| !keys.iter().any(|item| &item.key == key));
    if choice.kept.len() == before {
        return Ok(());
    }
    let rest = (!choice.kept.is_empty()).then_some(choice);
    config_preferences::set_codex_config(workspace_root, rest)
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

    fn reset_key(key: &str, yours: &str, riggverk: &str) -> DefaultKey {
        DefaultKey {
            key: key.to_string(),
            yours: yours.to_string(),
            riggverk: riggverk.to_string(),
        }
    }

    /// `check_rendered` for a reset of `approvals_reviewer` from "auto_review", with the given
    /// installed and rendered files (each added to the base text below).
    fn checked(installed_extra: &str, rendered_extra: &str, rendered_reviewer: &str) -> bool {
        let base = |reviewer: &str, extra: &str| {
            parse(&format!("approvals_reviewer = \"{reviewer}\"\n{extra}\n"))
        };
        check_rendered(
            &base("auto_review", installed_extra),
            &base(rendered_reviewer, rendered_extra),
            &parse(TEMPLATE),
            &[reset_key("approvals_reviewer", "auto_review", "user")],
            &BTreeMap::new(),
        )
        .is_ok()
    }

    #[test]
    fn the_rendered_file_may_differ_from_the_installed_one_only_where_the_preview_says() {
        // The reset itself.
        assert!(checked("", "", "user"));
        assert!(
            !checked("", "", "auto_review"),
            "the key must hold Riggverk's value"
        );
        assert!(!checked("", "", "something_else"));

        // A value of another kind in an enforced key is never rewritten by the render.
        let granular = "approval_policy = { granular = { sandbox_approval = true } }";
        assert!(checked(granular, granular, "user"));
        assert!(!checked(
            granular,
            "approval_policy = \"on-request\"",
            "user"
        ));
        // An enforced key that is set stays as it is, even when it is a string that differs.
        assert!(!checked(
            "sandbox_mode = \"read-only\"",
            "sandbox_mode = \"workspace-write\"",
            "user"
        ));
        // An absent enforced or create-only key may only be added with the bundled value.
        assert!(checked("", "sandbox_mode = \"workspace-write\"", "user"));
        assert!(!checked(
            "",
            "sandbox_mode = \"danger-full-access\"",
            "user"
        ));
        assert!(checked("", "model = \"gpt-6.1-sol\"", "user"));
        assert!(!checked("", "model = \"something-else\"", "user"));

        // A model the user set is never touched.
        assert!(checked("model = \"mine\"", "model = \"mine\"", "user"));
        assert!(!checked(
            "model = \"mine\"",
            "model = \"gpt-6.1-sol\"",
            "user"
        ));
        assert!(!checked("model = \"mine\"", "", "user"));
        assert!(!checked(
            "model_reasoning_effort = \"low\"",
            "model_reasoning_effort = \"xhigh\"",
            "user"
        ));

        // `profile` goes only when it is an app-shipped selector.
        assert!(checked("profile = \"safe\"", "", "user"));
        assert!(checked("profile = \"workspace-write\"", "", "user"));
        assert!(!checked("profile = \"work\"", "", "user"));
        assert!(checked("profile = \"work\"", "profile = \"work\"", "user"));
        assert!(!checked("profile = \"safe\"", "profile = \"work\"", "user"));

        // The legacy tables go only in the shape the app wrote them.
        let shipped = "[profiles.safe]\napproval_policy = \"never\"";
        assert!(checked(shipped, "", "user"));
        let custom = "[profiles.safe]\nmodel = \"mine\"\napproval_policy = \"never\"";
        assert!(!checked(custom, "", "user"));
        assert!(checked(custom, custom, "user"));
        assert!(!checked("[profiles.work]\nmodel = \"mine\"", "", "user"));

        // Nothing else changes.
        assert!(!checked(
            "personality = \"pragmatic\"",
            "personality = \"friendly\"",
            "user"
        ));
        assert!(!checked(
            "[mcp_servers.demo]\ncommand = \"demo\"",
            "",
            "user"
        ));
    }

    #[test]
    fn a_kept_key_must_keep_its_kept_value_in_the_rendered_file() {
        let installed = parse("approvals_reviewer = \"user\"\nsandbox_mode = \"read-only\"\n");
        let kept = kept(&[("sandbox_mode", "read-only")]);
        let keys = [reset_key("approvals_reviewer", "user", "user")];
        let same = parse("approvals_reviewer = \"user\"\nsandbox_mode = \"read-only\"\n");
        let reset = parse("approvals_reviewer = \"user\"\nsandbox_mode = \"workspace-write\"\n");
        let template = parse(TEMPLATE);
        assert!(check_rendered(&installed, &same, &template, &keys, &kept).is_ok());
        assert!(check_rendered(&installed, &reset, &template, &keys, &kept).is_err());
    }

    #[test]
    fn the_config_is_read_only_as_a_bounded_regular_file_without_links() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let base = std::env::temp_dir().join(format!("aw-codex-bounded-read-{nanos}"));
        std::fs::create_dir_all(&base).unwrap();

        let file = base.join("config.toml");
        std::fs::write(&file, "approvals_reviewer = \"user\"\n").unwrap();
        assert_eq!(
            read_config_bounded(&file).unwrap(),
            b"approvals_reviewer = \"user\"\n"
        );

        // The limit is exact: the limit itself reads, one byte more is refused.
        std::fs::write(&file, vec![b'#'; MAX_CONFIG_BYTES as usize]).unwrap();
        assert_eq!(
            read_config_bounded(&file).unwrap().len() as u64,
            MAX_CONFIG_BYTES
        );
        std::fs::write(&file, vec![b'#'; MAX_CONFIG_BYTES as usize + 1]).unwrap();
        assert!(read_config_bounded(&file)
            .unwrap_err()
            .contains("too large"));

        assert!(read_config_bounded(&base)
            .unwrap_err()
            .contains("regular file"));
        assert!(read_config_bounded(&base.join("missing.toml")).is_err());
        #[cfg(unix)]
        {
            let real = base.join("real.toml");
            std::fs::write(&real, "model = \"x\"\n").unwrap();
            let link = base.join("link.toml");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(read_config_bounded(&link)
                .unwrap_err()
                .contains("regular file"));
        }
        let _ = std::fs::remove_dir_all(&base);
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
