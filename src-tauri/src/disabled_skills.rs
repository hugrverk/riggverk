//! Skills the user turned off: `.riggverk/disabled-skills.json` in the data folder.
//!
//! A disabled skill stays in the catalog (the Library lists it, pack routing still validates
//! against it), but no install creates or updates its files: its app-owned copies become stale
//! records and the next Install removes them with a backup. The list applies to every harness.
//!
//! The file is a user choice outside any transaction, like `kept-files.json` and a forgotten pack:
//! an undo puts copies back but the skill stays disabled, and uninstall never deletes the file.
//! A file that exists and cannot be used fails closed: the skills and rules plans that read it are
//! unavailable until the user fixes or removes it, and nothing here overwrites it.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::artifact_registry::SkillName;

/// File name inside the state folder (see `workspace_layout::state_file`).
pub const DISABLED_SKILLS_FILE: &str = "disabled-skills.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 64 * 1024;
/// Most skills one workspace can disable; a bigger file is unusable.
pub const MAX_ENTRIES: usize = 1024;

/// Why a `disabled-skills.json` that is in the way cannot be used.
pub const UNUSABLE: &str = "disabled-skills.json cannot be read; fix or remove it";
pub const FOREIGN: &str =
    "disabled-skills.json was written by another version of Riggverk; update the app or move the file away";

/// Both fields are required: a file without the list must not read as "nothing disabled", or a
/// plan would install the skills it was meant to keep off.
#[derive(Debug, Serialize, Deserialize)]
struct DisabledDocument {
    schema_version: u32,
    disabled: Vec<String>,
}

/// What `disabled-skills.json` holds.
enum Stored {
    Absent,
    Usable(BTreeSet<String>),
    /// Valid JSON of another schema version: written by another version of the app.
    Foreign,
    /// Unreadable, oversized, not a regular file, behind a link, not JSON, too many entries or a
    /// name that is no skill name.
    Unusable,
}

fn path_of(workspace_root: &Path) -> PathBuf {
    crate::workspace_layout::state_file(workspace_root, DISABLED_SKILLS_FILE)
}

fn read_stored(workspace_root: &Path) -> Stored {
    let path = path_of(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "disabled skills")
        .is_err()
        || crate::path_safety::reject_symlink(&path, "disabled skills").is_err()
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
    let Some(document) = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DisabledDocument>(&raw).ok())
    else {
        return Stored::Unusable;
    };
    if document.schema_version != SCHEMA_VERSION {
        return Stored::Foreign;
    }
    if document.disabled.len() > MAX_ENTRIES
        || document
            .disabled
            .iter()
            .any(|name| SkillName::new(name.as_str()).is_none())
    {
        return Stored::Unusable;
    }
    Stored::Usable(document.disabled.into_iter().collect())
}

/// The disabled skill names. No file is none disabled; a file that cannot be used is an error with
/// a fixed phrase that quotes nothing of it.
pub fn load(workspace_root: &Path) -> Result<BTreeSet<String>, String> {
    match read_stored(workspace_root) {
        Stored::Absent => Ok(BTreeSet::new()),
        Stored::Usable(names) => Ok(names),
        Stored::Foreign => Err(FOREIGN.to_string()),
        Stored::Unusable => Err(UNUSABLE.to_string()),
    }
}

/// Enables (`enabled` true) or disables the skills `names`. Writes only `disabled-skills.json`,
/// sorted and unique, and nothing when it would not change. Refuses a file it cannot use, so a
/// choice it cannot read is never overwritten. Which names may be disabled is the caller's to
/// decide; this checks only that each is a skill name.
pub fn set(workspace_root: &Path, names: &[String], enabled: bool) -> Result<(), String> {
    if let Some(name) = names
        .iter()
        .find(|name| SkillName::new(name.as_str()).is_none())
    {
        return Err(format!("not a skill name: {name:?}"));
    }
    let before = load(workspace_root)?;
    let mut after = before.clone();
    for name in names {
        if enabled {
            after.remove(name);
        } else {
            after.insert(name.clone());
        }
    }
    if after == before {
        return Ok(());
    }
    if after.len() > MAX_ENTRIES {
        return Err(format!("at most {MAX_ENTRIES} skills can be disabled"));
    }
    let document = DisabledDocument {
        schema_version: SCHEMA_VERSION,
        disabled: after.into_iter().collect(),
    };
    let raw = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("serialize disabled skills: {error}"))?;
    crate::managed_state::ensure_data_folder(workspace_root)?;
    crate::safe_filesystem::write_regular_file_atomic(
        &path_of(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|error| format!("write disabled skills: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-disabled-skills-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    fn write_raw(ws: &Path, raw: &str) {
        let path = path_of(ws);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, raw).unwrap();
    }

    #[test]
    fn absent_file_is_empty() {
        let ws = temp("absent");
        assert_eq!(load(&ws), Ok(BTreeSet::new()));
        set(&ws, &names(&["tdd"]), true).unwrap();
        assert!(
            !path_of(&ws).exists(),
            "enabling what is not disabled writes nothing"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unusable_or_foreign_is_an_error_and_set_refuses_it() {
        let ws = temp("unusable");
        for (raw, phrase) in [
            ("not json", UNUSABLE),
            (r#"{"schema_version": 1, "disabled": "tdd"}"#, UNUSABLE),
            // A missing field fails closed rather than reading as nothing disabled.
            (r#"{"schema_version": 1}"#, UNUSABLE),
            (r#"{"disabled": []}"#, UNUSABLE),
            ("{}", UNUSABLE),
            (r#"{"schema_version": 7, "disabled": ["tdd"]}"#, FOREIGN),
        ] {
            write_raw(&ws, raw);
            assert_eq!(load(&ws), Err(phrase.to_string()), "{raw}");
            for enabled in [true, false] {
                assert_eq!(
                    set(&ws, &names(&["tdd"]), enabled),
                    Err(phrase.to_string()),
                    "{raw}"
                );
            }
            assert_eq!(
                fs::read_to_string(path_of(&ws)).unwrap(),
                raw,
                "the file is left as it is"
            );
        }

        fs::remove_file(path_of(&ws)).unwrap();
        fs::create_dir(path_of(&ws)).unwrap();
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "a folder in the way");
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_way_is_unusable_and_is_not_followed() {
        let ws = temp("link");
        let elsewhere = temp("link-target");
        let target = elsewhere.join("disabled-skills.json");
        let raw = r#"{"schema_version": 1, "disabled": ["tdd"]}"#;
        fs::write(&target, raw).unwrap();
        fs::create_dir_all(path_of(&ws).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, path_of(&ws)).unwrap();
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()));
        assert!(set(&ws, &names(&["diagnose"]), false).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), raw);
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn invalid_names_or_too_many_make_it_unusable() {
        let ws = temp("invalid");
        for bad in ["../tdd", "", "Tdd", "a/b"] {
            write_raw(
                &ws,
                &serde_json::json!({"schema_version": 1, "disabled": ["tdd", bad]}).to_string(),
            );
            assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "{bad:?}");
        }
        let many: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("skill-{i}")).collect();
        write_raw(
            &ws,
            &serde_json::json!({"schema_version": 1, "disabled": many}).to_string(),
        );
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "too many");

        let padding = "x".repeat(MAX_FILE_BYTES as usize);
        write_raw(
            &ws,
            &serde_json::json!({"schema_version": 1, "disabled": ["tdd"], "pad": padding})
                .to_string(),
        );
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "oversized");

        fs::remove_file(path_of(&ws)).unwrap();
        let error = set(&ws, &names(&["../escape"]), false).unwrap_err();
        assert!(error.contains("not a skill name"), "{error}");
        assert!(!path_of(&ws).exists());
        let all: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("skill-{i}")).collect();
        let error = set(&ws, &all, false).unwrap_err();
        assert!(error.contains("at most"), "{error}");
        assert!(!path_of(&ws).exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn set_writes_sorted_unique_and_nothing_when_unchanged() {
        let ws = temp("set");
        set(&ws, &names(&["tdd", "diagnose", "tdd"]), false).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(path_of(&ws)).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({"schema_version": 1, "disabled": ["diagnose", "tdd"]})
        );
        let first = fs::read(path_of(&ws)).unwrap();
        let modified = fs::metadata(path_of(&ws)).unwrap().modified().unwrap();

        set(&ws, &names(&["diagnose"]), false).unwrap();
        set(&ws, &names(&["not-disabled"]), true).unwrap();
        assert_eq!(fs::read(path_of(&ws)).unwrap(), first);
        assert_eq!(
            fs::metadata(path_of(&ws)).unwrap().modified().unwrap(),
            modified,
            "nothing is written when nothing changes"
        );

        set(&ws, &names(&["tdd"]), true).unwrap();
        assert_eq!(load(&ws), Ok(BTreeSet::from(["diagnose".to_string()])));
        set(&ws, &names(&["diagnose"]), true).unwrap();
        assert_eq!(load(&ws), Ok(BTreeSet::new()));
        let _ = fs::remove_dir_all(&ws);
    }
}
