//! How much agents comment code: `.riggverk/comment-policy.json` in the data folder.
//!
//! One level for every harness. `harness_default` (also no file) adds nothing to the rules, so each
//! harness keeps its own stance and the rules source stays the bundled base byte for byte.
//! `minimal` and `off` add one `## Code comments` section to the managed block, right after the
//! base's `## Scope` section (see [`crate::pack_routing::compose`]), with the same text in every
//! rules target, the Library's base template and the Cursor User Rules.
//!
//! The file is a user choice outside any transaction, like `disabled-skills.json`: an undo puts the
//! previous block back but the level stays, and uninstall never deletes the file. A file that exists
//! and cannot be used fails closed: the rules plans that read it are unavailable until the user fixes
//! or removes it, and nothing here overwrites it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the state folder (see `workspace_layout::state_file`).
pub const COMMENT_POLICY_FILE: &str = "comment-policy.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 4 * 1024;

/// Why a `comment-policy.json` that is in the way cannot be used.
pub const UNUSABLE: &str = "comment-policy.json cannot be read; fix or remove it";
pub const FOREIGN: &str =
    "comment-policy.json was written by another version of Riggverk; update the app or move the file away";

/// Heading of the section `minimal` and `off` add to the rules block.
#[cfg(test)]
pub const SECTION_HEADING: &str = "## Code comments";

/// The section of `minimal`.
pub const MINIMAL_SECTION: &str = concat!(
    "## Code comments\n",
    "Comment only what the code cannot show: intent, an invariant, a workaround or a contract. ",
    "Never restate the code, narrate the change or address the reviewer. ",
    "Comments the language or tooling requires are always allowed: license headers, directives and pragmas, ",
    "lint suppressions, API docs a public interface requires, `// SAFETY:` on Rust `unsafe`. ",
    "Keep existing comments unless you remove their code; update any your change makes false. ",
    "A repository's own comment rules (its AGENTS.md, CLAUDE.md or linters) win.\n",
);

/// The section of `off`.
pub const OFF_SECTION: &str = concat!(
    "## Code comments\n",
    "Add no comments except those the language or tooling requires: license headers, directives and pragmas, ",
    "lint suppressions, API docs a public interface requires, `// SAFETY:` on Rust `unsafe`. ",
    "Keep existing comments unless you remove their code; update any your change makes false. ",
    "A repository's own comment rules (its AGENTS.md, CLAUDE.md or linters) win.\n",
);

/// How much agents comment code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommentPolicy {
    /// Nothing is added: each harness's own prompt and the repository's rules apply.
    #[default]
    HarnessDefault,
    Minimal,
    Off,
}

impl CommentPolicy {
    /// The section this level adds to the rules block; empty for `HarnessDefault`.
    pub fn section(self) -> &'static str {
        match self {
            CommentPolicy::HarnessDefault => "",
            CommentPolicy::Minimal => MINIMAL_SECTION,
            CommentPolicy::Off => OFF_SECTION,
        }
    }
}

/// Whether `text` (one `##` section, line endings and trailing blank lines aside) is a section a
/// level adds, unchanged: the app's text, never the user's.
pub fn is_app_section(text: &str) -> bool {
    let text = text.replace("\r\n", "\n");
    let text = text.trim_end();
    [MINIMAL_SECTION, OFF_SECTION]
        .iter()
        .any(|section| section.trim_end() == text)
}

/// Both fields are required: a file without the level must not read as harness default, or a plan
/// would take the user's section out of the rules.
#[derive(Debug, Serialize, Deserialize)]
struct PolicyDocument {
    schema_version: u32,
    level: serde_json::Value,
}

/// What `comment-policy.json` holds.
enum Stored {
    Absent,
    Usable(CommentPolicy),
    /// Valid JSON of another schema version: written by another version of the app.
    Foreign,
    /// Unreadable, oversized, not a regular file, behind a link, not JSON or an unknown level.
    Unusable,
}

fn path_of(workspace_root: &Path) -> PathBuf {
    crate::workspace_layout::state_file(workspace_root, COMMENT_POLICY_FILE)
}

fn read_stored(workspace_root: &Path) -> Stored {
    let path = path_of(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "comment policy")
        .is_err()
        || crate::path_safety::reject_symlink(&path, "comment policy").is_err()
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
        .and_then(|raw| serde_json::from_str::<PolicyDocument>(&raw).ok())
    else {
        return Stored::Unusable;
    };
    if document.schema_version != SCHEMA_VERSION {
        return Stored::Foreign;
    }
    match serde_json::from_value::<CommentPolicy>(document.level) {
        Ok(level) => Stored::Usable(level),
        Err(_) => Stored::Unusable,
    }
}

/// The chosen level. No file is harness default; a file that cannot be used is an error with a
/// fixed phrase that quotes nothing of it.
pub fn load(workspace_root: &Path) -> Result<CommentPolicy, String> {
    match read_stored(workspace_root) {
        Stored::Absent => Ok(CommentPolicy::HarnessDefault),
        Stored::Usable(level) => Ok(level),
        Stored::Foreign => Err(FOREIGN.to_string()),
        Stored::Unusable => Err(UNUSABLE.to_string()),
    }
}

/// Chooses `level`. Writes only `comment-policy.json`, and nothing when the level would not change
/// (harness default with no file included). Refuses a file it cannot use, so a choice it cannot
/// read is never overwritten.
pub fn set(workspace_root: &Path, level: CommentPolicy) -> Result<(), String> {
    if load(workspace_root)? == level {
        return Ok(());
    }
    let document = PolicyDocument {
        schema_version: SCHEMA_VERSION,
        level: serde_json::to_value(level)
            .map_err(|error| format!("serialize comment policy: {error}"))?,
    };
    let raw = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("serialize comment policy: {error}"))?;
    crate::managed_state::ensure_data_folder(workspace_root)?;
    crate::safe_filesystem::write_regular_file_atomic(
        &path_of(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|error| format!("write comment policy: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-comment-policy-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_raw(ws: &Path, raw: &str) {
        let path = path_of(ws);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, raw).unwrap();
    }

    #[test]
    fn the_sections_keep_every_clause_and_nothing_that_could_change_how_the_block_reads() {
        for section in [MINIMAL_SECTION, OFF_SECTION] {
            assert!(
                section.starts_with(&format!("{SECTION_HEADING}\n")),
                "{section}"
            );
            assert!(
                section.ends_with(".\n") && section.lines().count() == 2,
                "{section}"
            );
            for clause in [
                // Existing comments stay unless their code goes, and are kept true.
                "Keep existing comments unless you remove their code; update any your change makes false.",
                // What the language or tooling requires is always allowed.
                "license headers, directives and pragmas, lint suppressions, API docs a public interface requires, `// SAFETY:` on Rust `unsafe`.",
                // The repository's own conventions win.
                "A repository's own comment rules (its AGENTS.md, CLAUDE.md or linters) win.",
            ] {
                assert!(section.contains(clause), "{clause}");
            }
            // No Claude Code import, no markup or marker, no fence, no other heading.
            assert!(!section.contains(['@', '<', '>']), "{section}");
            assert!(!section.contains("```") && !section.contains("~~~"));
            assert_eq!(section.matches("## ").count(), 1);
            assert!(section
                .chars()
                .all(|c| c == '\n' || (!c.is_control() && c.is_ascii())));
            assert!(is_app_section(section));
            assert!(is_app_section(&format!(
                "{}\r\n\r\n",
                section.replace('\n', "\r\n")
            )));
        }
        assert!(MINIMAL_SECTION.contains("Comment only what the code cannot show"));
        assert!(OFF_SECTION.contains("Add no comments except"));
        assert_eq!(CommentPolicy::HarnessDefault.section(), "");
        assert!(!is_app_section(
            &MINIMAL_SECTION.replace("intent", "the why")
        ));
        assert!(!is_app_section(""));
    }

    #[test]
    fn absent_file_is_harness_default_and_choosing_it_writes_nothing() {
        let ws = temp("absent");
        assert_eq!(load(&ws), Ok(CommentPolicy::HarnessDefault));
        set(&ws, CommentPolicy::HarnessDefault).unwrap();
        assert!(!path_of(&ws).exists(), "nothing is written");
        assert!(
            !crate::workspace_layout::state_dir(&ws).exists(),
            "not even the state folder"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn set_round_trips_every_level_and_writes_nothing_when_unchanged() {
        let ws = temp("set");
        set(&ws, CommentPolicy::Minimal).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(path_of(&ws)).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({"schema_version": 1, "level": "minimal"})
        );
        assert_eq!(load(&ws), Ok(CommentPolicy::Minimal));
        let modified = fs::metadata(path_of(&ws)).unwrap().modified().unwrap();
        set(&ws, CommentPolicy::Minimal).unwrap();
        assert_eq!(
            fs::metadata(path_of(&ws)).unwrap().modified().unwrap(),
            modified,
            "nothing is written when nothing changes"
        );
        set(&ws, CommentPolicy::Off).unwrap();
        assert_eq!(load(&ws), Ok(CommentPolicy::Off));
        // Back to harness default keeps the file, with the level written out.
        set(&ws, CommentPolicy::HarnessDefault).unwrap();
        assert_eq!(load(&ws), Ok(CommentPolicy::HarnessDefault));
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(path_of(&ws)).unwrap()).unwrap();
        assert_eq!(raw["level"], "harness_default");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn unusable_or_foreign_is_an_error_and_set_refuses_it() {
        let ws = temp("unusable");
        for (raw, phrase) in [
            ("not json", UNUSABLE),
            ("{}", UNUSABLE),
            // A missing field fails closed rather than reading as harness default.
            (r#"{"schema_version": 1}"#, UNUSABLE),
            (r#"{"level": "off"}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": "loud"}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": "Minimal"}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": null}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": ["off"]}"#, UNUSABLE),
            (r#"{"schema_version": 2, "level": "off"}"#, FOREIGN),
            (r#"{"schema_version": 2, "level": "louder"}"#, FOREIGN),
        ] {
            write_raw(&ws, raw);
            assert_eq!(load(&ws), Err(phrase.to_string()), "{raw}");
            for level in [
                CommentPolicy::HarnessDefault,
                CommentPolicy::Minimal,
                CommentPolicy::Off,
            ] {
                assert_eq!(set(&ws, level), Err(phrase.to_string()), "{raw}");
            }
            assert_eq!(
                fs::read_to_string(path_of(&ws)).unwrap(),
                raw,
                "the file is left as it is"
            );
        }

        let padding = "x".repeat(MAX_FILE_BYTES as usize);
        write_raw(
            &ws,
            &serde_json::json!({"schema_version": 1, "level": "off", "pad": padding}).to_string(),
        );
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "oversized");

        fs::remove_file(path_of(&ws)).unwrap();
        fs::create_dir(path_of(&ws)).unwrap();
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "a folder in the way");
        assert!(set(&ws, CommentPolicy::Off).is_err());
        assert!(path_of(&ws).is_dir());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_way_is_unusable_and_is_not_followed() {
        let ws = temp("link");
        let elsewhere = temp("link-target");
        let target = elsewhere.join(COMMENT_POLICY_FILE);
        let raw = r#"{"schema_version": 1, "level": "off"}"#;
        fs::write(&target, raw).unwrap();
        fs::create_dir_all(path_of(&ws).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, path_of(&ws)).unwrap();
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()));
        assert!(set(&ws, CommentPolicy::Minimal).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), raw);
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&elsewhere);
    }
}
