//! The keys the app manages in Claude Code's `settings.json`.
//!
//! `~/.claude/settings.json` is the user's file. The app manages two groups of leaf values in it.
//! While the `claude_config` target is on: `attribution.commit` and `attribution.pr`. Install sets
//! both to `""`, which hides Claude Code's `Co-Authored-By` commit trailer and its "Generated with
//! Claude Code" pull request line. While the `claude_skill_overrides` target is on:
//! `skillOverrides.<name>` set to `"name-only"` for the skills in [`ON_REQUEST_SKILLS`], so Claude
//! Code lists them by name and starts them only when asked for. Every other key (`env`, `hooks`,
//! `permissions`, ...) keeps its value and its place in the file. The values are constants of the
//! app; there is no bundled file.
//!
//! The overrides are written and removed per leaf: an Update writes a leaf only where the key is
//! absent, and records it with the digest of the value (`ManagedArtifactRecord::owned_values`).
//! Once the target is off, the next Update removes exactly the recorded leaves that still hold
//! that value, and the `skillOverrides` object itself when the app created it and nothing is left
//! in it. A value the user set, even `"name-only"`, is never written, recorded or removed.
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

/// The skills Claude Code lists by name only while `claude_skill_overrides` is on: the ones that
/// start on request, in the order they are written. Measured with Claude Code 2.1.323: a
/// name-only skill still starts when a request asks for it in plain words.
pub const ON_REQUEST_SKILLS: [&str; 7] = [
    "grill-me",
    "raise-the-bar",
    "retro",
    "orchestrate",
    "adversarial-implementation",
    "adversarial-review",
    "adversarial-test",
];
/// The key holding the overrides, and the value written for each skill.
pub const OVERRIDES: &str = "skillOverrides";
const OVERRIDE_VALUE: &str = "name-only";

/// Why a file whose `skillOverrides` key is not an object is left alone. A fixed phrase.
const OVERRIDES_TYPE_REASON: &str =
    "settings.json: skillOverrides has an unexpected type; the app writes nothing";

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
#[cfg(test)]
pub fn conflict_reason(assessment: &Assessment) -> Option<String> {
    match assessment {
        Assessment::Refused(refusal) => Some(refusal_reason(*refusal)),
        Assessment::UnexpectedType => Some(UNEXPECTED_TYPE_REASON.to_string()),
        Assessment::Absent | Assessment::Missing | Assessment::Hidden | Assessment::UserSet => None,
    }
}

/// The content an install of the attribution values alone writes: the file at `dest` (or an
/// empty one) with the two values added. Only a file that says nothing about attribution is
/// written; any other state is refused.
#[cfg(test)]
pub fn render_install(dest: &Path) -> Result<String, String> {
    let wanted = Wanted {
        attribution: true,
        overrides: false,
    };
    match plan(dest, wanted, false, &Owned::new()) {
        Outcome::Write { content, .. } => Ok(content),
        Outcome::Conflict(reason) => Err(format!("refusing to change {reason}")),
        Outcome::Current { .. } | Outcome::UsersAttribution => Err(
            "refusing to change settings.json: it already says how attribution is shown"
                .to_string(),
        ),
    }
}

/// The installed file with the two values put back as `backup` had them (and the ones it lacked
/// taken out again), and the overrides as [`restore_overrides`] puts them back; everything else
/// stays as it is now. An `attribution` object the apply created goes with them. An installed
/// file or a backup that no longer reads as strict JSON, or whose `attribution` is not an object
/// where it must be, is an error: nothing is written.
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
    // A write of the overrides alone left the attribution values as they were: they stay,
    // whatever the user keeps there (`attribution: false` included).
    if managed_projection(&current) != managed_projection(&previous) {
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
    }
    restore_overrides(&mut current, &previous)?;
    render(current)
}

/// Which groups of values the enabled targets want in the file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Wanted {
    pub attribution: bool,
    pub overrides: bool,
}

/// The leaves the app owns, as its record holds them: JSON path to the digest of the value.
pub type Owned = std::collections::BTreeMap<String, String>;

/// What one write changes, per leaf, for the review, the status and the ownership record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Leaves {
    /// The two attribution values are added.
    pub attribution: bool,
    /// The paths of the overrides added (`skillOverrides.retro`), and of the ones removed.
    pub added: Vec<String>,
    pub removed: Vec<String>,
    /// The write creates the `skillOverrides` object, or takes away the one the app created.
    pub created_object: bool,
    pub dropped_object: bool,
}

impl Leaves {
    fn is_empty(&self) -> bool {
        *self == Leaves::default()
    }

    /// Whether the write adds or removes anything of the overrides.
    pub fn touches_overrides(&self) -> bool {
        !self.added.is_empty()
            || !self.removed.is_empty()
            || self.created_object
            || self.dropped_object
    }
}

/// How the file stands against what the targets want and what the app owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Write `content` over the file whose full digest is `expected_installed_digest`
    /// ([`crate::stable_digest::ABSENT`] when there is none).
    Write {
        leaves: Leaves,
        content: String,
        expected_installed_digest: String,
    },
    /// Nothing to write; `file` is whether there is a file.
    Current { file: bool },
    /// Nothing to write, and the attribution the target wants is the user's own.
    UsersAttribution,
    /// The file is left alone; a fixed phrase, never file text.
    Conflict(String),
}

/// The path of the override of `name`.
pub fn override_path(name: &str) -> String {
    format!("{OVERRIDES}.{name}")
}

fn override_digest() -> String {
    value_digest(&Value::String(OVERRIDE_VALUE.to_string()))
}

fn value_digest(value: &Value) -> String {
    crate::stable_digest::bytes(serde_json::to_string(value).unwrap_or_default().as_bytes())
}

/// The digest an owned path is recorded with: the value written, or an empty object for the
/// `skillOverrides` object the app created.
fn written_digest(path: &str) -> String {
    if path == OVERRIDES {
        value_digest(&Value::Object(Map::new()))
    } else {
        override_digest()
    }
}

/// The paths of `owned` that `config` still holds as the app wrote them: a leaf with the
/// recorded digest, the object while it is an object.
pub fn still_owned(config: &Map<String, Value>, owned: &Owned) -> Owned {
    let overrides = config.get(OVERRIDES);
    owned
        .iter()
        .filter(|(path, digest)| {
            if path.as_str() == OVERRIDES {
                return overrides.is_some_and(Value::is_object);
            }
            path.strip_prefix(&format!("{OVERRIDES}."))
                .and_then(|name| overrides.and_then(|value| value.get(name)))
                .is_some_and(|value| value_digest(value) == **digest)
        })
        .map(|(path, digest)| (path.clone(), digest.clone()))
        .collect()
}

/// `owned` after a write that changed `leaves`.
pub fn owned_after(owned: Option<&Owned>, leaves: &Leaves) -> Owned {
    let mut next = owned.cloned().unwrap_or_default();
    for path in &leaves.removed {
        next.remove(path);
    }
    if leaves.dropped_object {
        next.remove(OVERRIDES);
    }
    for path in &leaves.added {
        next.insert(path.clone(), written_digest(path));
    }
    if leaves.created_object {
        next.insert(OVERRIDES.to_string(), written_digest(OVERRIDES));
    }
    next
}

/// What the app writes into the file at `dest`. `attribution_owned` is whether the record proves
/// the attribution values already in the file are the app's. Each group is looked at only while
/// its target wants it, or, for the overrides, while the app owns one of them: without either the
/// file stands as it did before the overrides existed.
pub fn plan(dest: &Path, wanted: Wanted, attribution_owned: bool, owned: &Owned) -> Outcome {
    let installed = match read(dest) {
        Ok(installed) => installed,
        Err(refusal) => return Outcome::Conflict(refusal_reason(refusal)),
    };
    let file = installed.is_some();
    let mut config = installed.unwrap_or_default();
    let mut leaves = Leaves::default();
    let mut users_attribution = false;
    if wanted.attribution {
        match classify(&config) {
            Assessment::Missing => {
                add_attribution(&mut config);
                leaves.attribution = true;
            }
            Assessment::Hidden if attribution_owned => {}
            Assessment::UnexpectedType => {
                return Outcome::Conflict(UNEXPECTED_TYPE_REASON.to_string());
            }
            _ => users_attribution = true,
        }
    }
    if wanted.overrides || !owned.is_empty() {
        match config.get(OVERRIDES) {
            None | Some(Value::Object(_)) => {}
            Some(_) => return Outcome::Conflict(OVERRIDES_TYPE_REASON.to_string()),
        }
        if wanted.overrides {
            add_overrides(&mut config, &mut leaves);
        } else {
            let owned = still_owned(&config, owned);
            remove_overrides(&mut config, &owned, &mut leaves);
        }
    }
    if leaves.is_empty() {
        return if users_attribution {
            Outcome::UsersAttribution
        } else {
            Outcome::Current { file }
        };
    }
    let expected_installed_digest = if file {
        match crate::stable_digest::file(dest) {
            Ok(digest) => digest,
            Err(_) => return Outcome::Conflict(refusal_reason(Refusal::Unreadable)),
        }
    } else {
        crate::stable_digest::ABSENT.to_string()
    };
    match render(config) {
        Ok(content) => Outcome::Write {
            leaves,
            content,
            expected_installed_digest,
        },
        Err(_) => Outcome::Conflict(refusal_reason(Refusal::Unreadable)),
    }
}

fn add_attribution(config: &mut Map<String, Value>) {
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
}

/// Adds the override of every skill whose key is absent; a key that is there is the user's.
fn add_overrides(config: &mut Map<String, Value>, leaves: &mut Leaves) {
    if !config.contains_key(OVERRIDES) {
        config.insert(OVERRIDES.to_string(), Value::Object(Map::new()));
        leaves.created_object = true;
    }
    let Some(Value::Object(overrides)) = config.get_mut(OVERRIDES) else {
        return;
    };
    for name in ON_REQUEST_SKILLS {
        if !overrides.contains_key(name) {
            overrides.insert(name.to_string(), Value::String(OVERRIDE_VALUE.to_string()));
            leaves.added.push(override_path(name));
        }
    }
    if leaves.created_object && leaves.added.is_empty() {
        config.shift_remove(OVERRIDES);
        leaves.created_object = false;
    }
}

/// Removes the owned leaves (`owned` holds only those still as the app wrote them), and with
/// them the object when the app created it and nothing is left in it. An object the user emptied
/// by hand stays: a write never only drops it.
fn remove_overrides(config: &mut Map<String, Value>, owned: &Owned, leaves: &mut Leaves) {
    let Some(Value::Object(overrides)) = config.get_mut(OVERRIDES) else {
        return;
    };
    for name in ON_REQUEST_SKILLS {
        let path = override_path(name);
        if owned.contains_key(&path) {
            overrides.shift_remove(name);
            leaves.removed.push(path);
        }
    }
    if overrides.is_empty() && owned.contains_key(OVERRIDES) && !leaves.removed.is_empty() {
        config.shift_remove(OVERRIDES);
        leaves.dropped_object = true;
    }
}

/// Whether undoing a write would put an override back or take one out: a leaf that is
/// `"name-only"` on one side and absent on the other. The app writes nothing else there, so any
/// other difference is the user's and stays.
fn override_restore_pending(current: &Map<String, Value>, backup: &Map<String, Value>) -> bool {
    let leaf = |config: &Map<String, Value>, name: &str| {
        config
            .get(OVERRIDES)
            .and_then(Value::as_object)
            .and_then(|overrides| overrides.get(name))
            .cloned()
    };
    let ours = Some(Value::String(OVERRIDE_VALUE.to_string()));
    ON_REQUEST_SKILLS.iter().any(|name| {
        let (now, before) = (leaf(current, name), leaf(backup, name));
        (now.is_none() && before == ours) || (now == ours && before.is_none())
    })
}

/// Whether an undo still has an override to put back or take out of the installed file (see
/// [`restore_overrides`]). A file either side cannot read has none: the attribution digest
/// already tells such a file apart.
pub fn overrides_differ(installed: &Path, backup: &Path) -> bool {
    match (read(installed), read(backup)) {
        (Ok(current), Ok(previous)) => {
            override_restore_pending(&current.unwrap_or_default(), &previous.unwrap_or_default())
        }
        _ => false,
    }
}

/// Puts the overrides back as `backup` had them where the file still holds what the write left:
/// a leaf the write added (`"name-only"` now, absent before) goes, a leaf it removed (absent now,
/// `"name-only"` before) comes back. Any other value is the user's and stays. An object the
/// write created goes when nothing is left in it; one it removed comes back.
fn restore_overrides(
    current: &mut Map<String, Value>,
    previous: &Map<String, Value>,
) -> Result<(), String> {
    if !override_restore_pending(current, previous) {
        return Ok(());
    }
    let ours = Value::String(OVERRIDE_VALUE.to_string());
    let before = previous.get(OVERRIDES).and_then(Value::as_object);
    if !current.contains_key(OVERRIDES) {
        current.insert(OVERRIDES.to_string(), Value::Object(Map::new()));
    }
    let Some(Value::Object(overrides)) = current.get_mut(OVERRIDES) else {
        return Err(
            "installed settings.json cannot be restored: skillOverrides has an unexpected type"
                .to_string(),
        );
    };
    for name in ON_REQUEST_SKILLS {
        let had = before.and_then(|before| before.get(name));
        match (overrides.get(name), had) {
            (Some(now), None) if *now == ours => {
                overrides.shift_remove(name);
            }
            (None, Some(had)) if *had == ours => {
                overrides.insert(name.to_string(), ours.clone());
            }
            _ => {}
        }
    }
    if before.is_none() && overrides.is_empty() {
        current.shift_remove(OVERRIDES);
    }
    Ok(())
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
    fn every_on_request_skill_is_a_bundled_skill() {
        use crate::skill_sources::SourceRoot;
        let bundled = crate::setup_roots::bundled_root().expect("bundle");
        let catalog: Vec<String> = crate::skill_sources::BundleOnly(&bundled)
            .catalog()
            .expect("catalog")
            .into_iter()
            .map(|entry| entry.skill.name)
            .collect();
        for name in ON_REQUEST_SKILLS {
            assert!(catalog.iter().any(|skill| skill == name), "{name}");
        }
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
