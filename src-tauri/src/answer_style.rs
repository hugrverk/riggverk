//! How agents word their answers: `.riggverk/answer-style.json` in the data folder.
//!
//! One level for every harness. `harness_default` (also no file) adds nothing to the rules, so each
//! harness keeps its own stance and the rules source stays the bundled base byte for byte. `plain`
//! adds one `## Answer style` section to the managed block, right after the base's
//! `## Communication` section (see [`crate::pack_routing::compose`]), with the same text in every
//! rules target, the Library's base template and the Cursor User Rules.
//!
//! The file is a user choice outside any transaction, like `comment-policy.json`: an undo puts the
//! previous block back but the level stays, and uninstall never deletes the file. A file that exists
//! and cannot be used fails closed: the rules plans that read it are unavailable until the user fixes
//! or removes it, and nothing here overwrites it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the state folder (see `workspace_layout::state_file`).
pub const ANSWER_STYLE_FILE: &str = "answer-style.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 4 * 1024;

/// Why an `answer-style.json` that is in the way cannot be used.
pub const UNUSABLE: &str = "answer-style.json cannot be read; fix or remove it";
pub const FOREIGN: &str =
    "answer-style.json was written by another version of Riggverk; update the app or move the file away";

/// Heading of the section `plain` adds to the rules block.
#[cfg(test)]
pub const SECTION_HEADING: &str = "## Answer style";

/// The section of `plain`.
pub const PLAIN_SECTION: &str = concat!(
    "## Answer style\n",
    "Write answers in plain technical language, in the user's language. Lead with the answer. ",
    "Aim for sentences of about 20 words or fewer, with one idea each. Use active voice in ",
    "every sentence and list item: make the one who acts the subject (\"I removed the file\", ",
    "\"the test skips Windows\"), not the thing acted on (\"the file was removed\", \"Windows ",
    "is skipped\"). Say \"I\" for your own actions. Use the passive only when the actor is ",
    "unknown. Use one term for one thing. Write prose in full sentences. Write a procedure as ",
    "numbered steps, one action per step. Put a warning or a condition in its own sentence ",
    "before the step it affects. Keep lists, tables and code blocks where the content is ",
    "parallel or meant to be copied; a list item may be a fragment. Keep every fact, number, ",
    "path and caveat: cut words, not content. About one sentence in five may break the length ",
    "and one-idea rules when a reason or a trade-off reads better as one longer sentence; the ",
    "active-voice rule has no such allowance. Leave code, commands, identifiers, quoted output ",
    "and required report headings unchanged.\n",
);

/// How agents word their answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerStyle {
    /// Nothing is added: each harness's own prompt and the repository's rules apply.
    #[default]
    HarnessDefault,
    Plain,
}

impl AnswerStyle {
    /// The section this level adds to the rules block; empty for `HarnessDefault`.
    pub fn section(self) -> &'static str {
        match self {
            AnswerStyle::HarnessDefault => "",
            AnswerStyle::Plain => PLAIN_SECTION,
        }
    }
}

/// Whether `text` (one `##` section, line endings and trailing blank lines aside) is the section a
/// level adds, unchanged: the app's text, never the user's.
pub fn is_app_section(text: &str) -> bool {
    let text = text.replace("\r\n", "\n");
    PLAIN_SECTION.trim_end() == text.trim_end()
}

/// Both fields are required: a file without the level must not read as harness default, or a plan
/// would take the user's section out of the rules.
#[derive(Debug, Serialize, Deserialize)]
struct StyleDocument {
    schema_version: u32,
    level: serde_json::Value,
}

/// What `answer-style.json` holds.
enum Stored {
    Absent,
    Usable(AnswerStyle),
    /// Valid JSON of another schema version: written by another version of the app.
    Foreign,
    /// Unreadable, oversized, not a regular file, behind a link, not JSON or an unknown level.
    Unusable,
}

fn path_of(workspace_root: &Path) -> PathBuf {
    crate::workspace_layout::state_file(workspace_root, ANSWER_STYLE_FILE)
}

fn read_stored(workspace_root: &Path) -> Stored {
    let path = path_of(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "answer style")
        .is_err()
        || crate::path_safety::reject_symlink(&path, "answer style").is_err()
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
        .and_then(|raw| serde_json::from_str::<StyleDocument>(&raw).ok())
    else {
        return Stored::Unusable;
    };
    if document.schema_version != SCHEMA_VERSION {
        return Stored::Foreign;
    }
    match serde_json::from_value::<AnswerStyle>(document.level) {
        Ok(level) => Stored::Usable(level),
        Err(_) => Stored::Unusable,
    }
}

/// The chosen level. No file is harness default; a file that cannot be used is an error with a
/// fixed phrase that quotes nothing of it.
pub fn load(workspace_root: &Path) -> Result<AnswerStyle, String> {
    match read_stored(workspace_root) {
        Stored::Absent => Ok(AnswerStyle::HarnessDefault),
        Stored::Usable(level) => Ok(level),
        Stored::Foreign => Err(FOREIGN.to_string()),
        Stored::Unusable => Err(UNUSABLE.to_string()),
    }
}

/// Chooses `level`. Writes only `answer-style.json`, and nothing when the level would not change
/// (harness default with no file included). Refuses a file it cannot use, so a choice it cannot
/// read is never overwritten.
pub fn set(workspace_root: &Path, level: AnswerStyle) -> Result<(), String> {
    if load(workspace_root)? == level {
        return Ok(());
    }
    let document = StyleDocument {
        schema_version: SCHEMA_VERSION,
        level: serde_json::to_value(level)
            .map_err(|error| format!("serialize answer style: {error}"))?,
    };
    let raw = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("serialize answer style: {error}"))?;
    crate::managed_state::ensure_data_folder(workspace_root)?;
    crate::safe_filesystem::write_regular_file_atomic(
        &path_of(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|error| format!("write answer style: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aw-answer-style-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_raw(ws: &Path, raw: &str) {
        let path = path_of(ws);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, raw).unwrap();
    }

    #[test]
    fn the_section_keeps_every_clause_and_nothing_that_could_change_how_the_block_reads() {
        let section = PLAIN_SECTION;
        assert!(
            section.starts_with(&format!("{SECTION_HEADING}\n")),
            "{section}"
        );
        assert!(
            section.ends_with(".\n") && section.lines().count() == 2,
            "{section}"
        );
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
        assert_eq!(AnswerStyle::Plain.section(), PLAIN_SECTION);
        assert_eq!(AnswerStyle::HarnessDefault.section(), "");
        assert!(!is_app_section(
            &PLAIN_SECTION.replacen('\n', "\nMine. ", 1)
        ));
        assert!(!is_app_section(""));
        // The comment policy's sections are not this setting's.
        assert!(!is_app_section(crate::comment_policy::MINIMAL_SECTION));
        assert!(!crate::comment_policy::is_app_section(PLAIN_SECTION));
    }

    #[test]
    fn absent_file_is_harness_default_and_choosing_it_writes_nothing() {
        let ws = temp("absent");
        assert_eq!(load(&ws), Ok(AnswerStyle::HarnessDefault));
        set(&ws, AnswerStyle::HarnessDefault).unwrap();
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
        set(&ws, AnswerStyle::Plain).unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(path_of(&ws)).unwrap()).unwrap();
        assert_eq!(
            raw,
            serde_json::json!({"schema_version": 1, "level": "plain"})
        );
        assert_eq!(load(&ws), Ok(AnswerStyle::Plain));
        let modified = fs::metadata(path_of(&ws)).unwrap().modified().unwrap();
        set(&ws, AnswerStyle::Plain).unwrap();
        assert_eq!(
            fs::metadata(path_of(&ws)).unwrap().modified().unwrap(),
            modified,
            "nothing is written when nothing changes"
        );
        // Back to harness default keeps the file, with the level written out.
        set(&ws, AnswerStyle::HarnessDefault).unwrap();
        assert_eq!(load(&ws), Ok(AnswerStyle::HarnessDefault));
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
            (r#"{"level": "plain"}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": "loud"}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": "Plain"}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": null}"#, UNUSABLE),
            (r#"{"schema_version": 1, "level": ["plain"]}"#, UNUSABLE),
            (r#"{"schema_version": 2, "level": "plain"}"#, FOREIGN),
            (r#"{"schema_version": 2, "level": "plainer"}"#, FOREIGN),
        ] {
            write_raw(&ws, raw);
            assert_eq!(load(&ws), Err(phrase.to_string()), "{raw}");
            for level in [AnswerStyle::HarnessDefault, AnswerStyle::Plain] {
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
            &serde_json::json!({"schema_version": 1, "level": "plain", "pad": padding}).to_string(),
        );
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "oversized");

        fs::remove_file(path_of(&ws)).unwrap();
        fs::create_dir(path_of(&ws)).unwrap();
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()), "a folder in the way");
        assert!(set(&ws, AnswerStyle::Plain).is_err());
        assert!(path_of(&ws).is_dir());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_the_way_is_unusable_and_is_not_followed() {
        let ws = temp("link");
        let elsewhere = temp("link-target");
        let target = elsewhere.join(ANSWER_STYLE_FILE);
        let raw = r#"{"schema_version": 1, "level": "plain"}"#;
        fs::write(&target, raw).unwrap();
        fs::create_dir_all(path_of(&ws).parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, path_of(&ws)).unwrap();
        assert_eq!(load(&ws), Err(UNUSABLE.to_string()));
        assert!(set(&ws, AnswerStyle::Plain).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), raw);
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&elsewhere);
    }
}
