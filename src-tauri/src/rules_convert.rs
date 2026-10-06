//! Moving a hand-edited rules file onto the managed base block.
//!
//! A rules file the user edited by hand (a pre-block file that no longer
//! matches any shipped base, or a block whose body was edited) cannot be
//! updated in place. Converting it puts the current base in a fresh block and
//! keeps what the user changed: every `##` section that differs from the base
//! the file started from, or that the base never had, moves below the END
//! marker verbatim. Sections that match the base are replaced by the base's own.
//!
//! The base a file started from is found among the bundled rules history
//! (`metadata/rules-history`), picking the shipped base with the fewest
//! differing lines.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::artifact_registry::ArtifactId;
use crate::rules_block::{self, Fence};
use crate::rules_diff;
use crate::stable_digest;

const HISTORY_DIR: &str = "metadata/rules-history";
const MAX_HISTORY_FILES: usize = 64;
const MAX_BASE_BYTES: u64 = 256 * 1024;
/// Largest rules file converted; bigger files are refused instead of rewritten.
pub const MAX_CONVERTIBLE_BYTES: usize = 256 * 1024;

/// A rules base the app shipped, read from the bundled history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownBase {
    /// `sha256:` digest of the exact file bytes.
    pub digest: String,
    pub text: String,
}

/// Directory name of a rules artifact's history, or `None` for other artifacts.
pub fn history_harness(artifact: &ArtifactId) -> Option<&'static str> {
    match artifact {
        ArtifactId::ClaudeRules => Some("claude"),
        ArtifactId::CodexRules => Some("codex"),
        ArtifactId::OpenCodeRules => Some("opencode"),
        _ => None,
    }
}

/// Every shipped base for the artifact's harness that the bundle carries.
/// Files whose content does not hash to their name, symlinks, and oversized
/// files are skipped.
pub fn known_bases(bundled_root: &Path, artifact: &ArtifactId) -> Vec<KnownBase> {
    let Some(harness) = history_harness(artifact) else {
        return Vec::new();
    };
    let dir = bundled_root.join(HISTORY_DIR).join(harness);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut bases = Vec::new();
    for entry in entries.flatten().take(MAX_HISTORY_FILES) {
        let path = entry.path();
        let Some(stem) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".md"))
        else {
            continue;
        };
        let is_regular = entry
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_BASE_BYTES);
        let is_link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
        if !is_regular || is_link {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let digest = stable_digest::bytes(&bytes);
        if digest.strip_prefix("sha256:") != Some(stem) {
            continue;
        }
        if let Ok(text) = String::from_utf8(bytes) {
            bases.push(KnownBase { digest, text });
        }
    }
    bases.sort_by(|a, b| a.digest.cmp(&b.digest));
    bases
}

/// The shipped base nearest to some text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosestBase {
    pub digest: String,
    pub text: String,
    /// Lines that differ between the base and the text (removed plus added).
    pub changed_lines: usize,
}

/// The shipped base (the current `source` included) with the fewest differing
/// lines. The current source wins ties.
pub fn closest_base(source: &str, bases: &[KnownBase], text: &str) -> ClosestBase {
    let text_lf = to_lf(text);
    let mut best = ClosestBase {
        digest: stable_digest::bytes(source.as_bytes()),
        text: source.to_string(),
        changed_lines: rules_diff::changed_line_count(&to_lf(source), &text_lf),
    };
    for base in bases {
        let changed = rules_diff::changed_line_count(&to_lf(&base.text), &text_lf);
        if changed < best.changed_lines {
            best = ClosestBase {
                digest: base.digest.clone(),
                text: base.text.clone(),
                changed_lines: changed,
            };
        }
    }
    best
}

fn to_lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// One `##` section of a Markdown file, or the text before the first one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// The `## ...` line without its line ending; `None` for the preamble.
    pub heading: Option<String>,
    /// The section as written, from its heading to the next heading.
    pub text: String,
}

impl Section {
    fn key(&self) -> &str {
        self.heading.as_deref().unwrap_or("")
    }

    fn normalized(&self) -> String {
        to_lf(&self.text).trim_end().to_string()
    }

    fn label(&self) -> String {
        self.heading
            .clone()
            .unwrap_or_else(|| "(text before the first section)".to_string())
    }
}

/// Split Markdown at `## ` headings outside fenced code blocks.
pub fn split_sections(text: &str) -> Vec<Section> {
    let mut heading_starts: Vec<usize> = Vec::new();
    let mut fence: Option<Fence> = None;
    let mut position = 0;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        match &fence {
            Some(open) => {
                if open.closed_by(content) {
                    fence = None;
                }
            }
            None => {
                if let Some(open) = Fence::opened_by(content) {
                    fence = Some(open);
                } else if content.starts_with("## ") {
                    heading_starts.push(position);
                }
            }
        }
        position += line.len();
    }
    let mut bounds: Vec<usize> = Vec::new();
    if heading_starts.first() != Some(&0) {
        bounds.push(0);
    }
    bounds.extend(heading_starts);
    bounds
        .iter()
        .enumerate()
        .map(|(index, start)| {
            let end = bounds.get(index + 1).copied().unwrap_or(text.len());
            let slice = &text[*start..end];
            let heading = slice
                .starts_with("## ")
                .then(|| slice.lines().next().unwrap_or("").trim_end().to_string());
            Section {
                heading,
                text: slice.to_string(),
            }
        })
        .collect()
}

/// What differs between a user's text and the base it started from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionChanges {
    /// User sections that differ from the base's or that the base lacks.
    pub changed: Vec<Section>,
    /// Headings of base sections the user's text does not have.
    pub removed: Vec<String>,
}

pub fn section_changes(base: &str, user: &str) -> SectionChanges {
    let base_sections = split_sections(base);
    let mut changed = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let user_sections = split_sections(user);
    for section in &user_sections {
        seen.push(section.key());
        let Some(original) = base_sections.iter().find(|b| b.key() == section.key()) else {
            if !section.normalized().is_empty() {
                changed.push(section.clone());
            }
            continue;
        };
        if original.normalized() != section.normalized() && !section.normalized().is_empty() {
            changed.push(section.clone());
        }
    }
    let removed = base_sections
        .iter()
        .filter(|b| b.heading.is_some() && !seen.contains(&b.key()))
        .map(Section::label)
        .collect();
    SectionChanges { changed, removed }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversionOrigin {
    /// A pre-block file that no longer matches any shipped base.
    LegacyFile,
    /// A managed block whose body was edited.
    EditedBlock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Converted {
    /// The complete file after conversion.
    pub result: String,
    pub origin: ConversionOrigin,
    /// Headings (or a label for the preamble) moved below the END marker.
    pub moved_sections: Vec<String>,
    /// Base sections the user's text lacked; they return with the new base.
    pub removed_sections: Vec<String>,
    /// Digest of the shipped base the user's text was compared against.
    pub compared_base: String,
    pub compared_base_changed_lines: usize,
}

/// Build the converted file: the current `source` as the managed block, with
/// the user's changed sections kept below it. `file_label` names the file in
/// the comment that introduces them.
pub fn convert(
    installed: &[u8],
    source: &str,
    bases: &[KnownBase],
    file_label: &str,
) -> Result<Converted, String> {
    if installed.len() > MAX_CONVERTIBLE_BYTES {
        return Err("rules file is too large to convert".to_string());
    }
    let text =
        std::str::from_utf8(installed).map_err(|_| "rules file is not valid UTF-8".to_string())?;
    let parsed = rules_block::parse(text)
        .map_err(|reason| format!("base block markers are malformed: {}", reason.message()))?;
    let crlf = text.contains("\r\n");

    let (user_text, origin) = match &parsed {
        Some(file) => (to_lf(file.body), ConversionOrigin::EditedBlock),
        None => (
            to_lf(text.strip_prefix('\u{feff}').unwrap_or(text)),
            ConversionOrigin::LegacyFile,
        ),
    };
    let closest = closest_base(source, bases, &user_text);
    let changes = section_changes(&to_lf(&closest.text), &user_text);
    let moved = moved_text(&changes.changed, file_label);
    let moved_for_file = if crlf {
        moved.replace('\n', "\r\n")
    } else {
        moved
    };
    let result = match &parsed {
        Some(file) => file.render_converted(source, &moved_for_file),
        None => {
            let mut out = String::new();
            if text.starts_with('\u{feff}') {
                out.push('\u{feff}');
            }
            let block = rules_block::render_new(source);
            let block = if crlf {
                block.replace('\n', "\r\n")
            } else {
                block
            };
            out.push_str(&block);
            out.push_str(&moved_for_file);
            out
        }
    };
    Ok(Converted {
        result,
        origin,
        moved_sections: changes.changed.iter().map(Section::label).collect(),
        removed_sections: changes.removed,
        compared_base: closest.digest,
        compared_base_changed_lines: closest.changed_lines,
    })
}

/// The text placed below the END marker: an explanatory comment, then each
/// kept section separated by a blank line. Empty when nothing is kept.
fn moved_text(changed: &[Section], file_label: &str) -> String {
    if changed.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "\n<!-- Refined from your previous {file_label}: sections you changed or added are kept below, verbatim. They come after the base block, so they override it where they conflict. Review and trim them. -->\n\n"
    );
    let sections: Vec<String> = changed
        .iter()
        .map(|section| format!("{}\n", to_lf(&section.text).trim_end_matches('\n')))
        .collect();
    out.push_str(&sections.join("\n"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules_block::{BEGIN_MARKER, END_MARKER};

    const BASE_OLD: &str = "# Rules\n\n## Priority\nBe careful.\n\n## Git\nNo force push.\n\n## Delegation\nUse model one.\n";
    const BASE_NEW: &str = "# Rules\n\n## Priority\nBe careful. Refinements win.\n\n## Git\nNo force push.\n\n## Delegation\nUse the configured model.\n\n## Final report\nChanged, Verified.\n";

    fn old_base() -> KnownBase {
        KnownBase {
            digest: stable_digest::bytes(BASE_OLD.as_bytes()),
            text: BASE_OLD.to_string(),
        }
    }

    #[test]
    fn split_sections_keeps_the_preamble_and_every_heading() {
        let sections = split_sections(BASE_OLD);
        let headings: Vec<_> = sections.iter().map(|s| s.heading.clone()).collect();
        assert_eq!(
            headings,
            vec![
                None,
                Some("## Priority".to_string()),
                Some("## Git".to_string()),
                Some("## Delegation".to_string()),
            ]
        );
        assert_eq!(sections[0].text, "# Rules\n\n");
        assert_eq!(
            sections.iter().map(|s| s.text.as_str()).collect::<String>(),
            BASE_OLD
        );
    }

    #[test]
    fn split_sections_ignores_headings_in_fenced_code_and_deeper_levels() {
        let text = "# T\n\n## One\n```md\n## not a heading\n```\n### sub\n## Two\n";
        let headings: Vec<_> = split_sections(text)
            .into_iter()
            .filter_map(|s| s.heading)
            .collect();
        assert_eq!(headings, vec!["## One", "## Two"]);
    }

    #[test]
    fn split_sections_starting_with_a_heading_has_no_preamble() {
        let sections = split_sections("## A\nx\n## B\ny\n");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].heading.as_deref(), Some("## A"));
    }

    #[test]
    fn changed_and_added_sections_are_found_and_unchanged_ones_are_not() {
        let user = BASE_OLD.replace("Use model one.", "Use model two.") + "\n## Mine\nExtra.\n";
        let changes = section_changes(BASE_OLD, &user);
        let labels: Vec<_> = changes.changed.iter().map(Section::label).collect();
        assert_eq!(labels, vec!["## Delegation", "## Mine"]);
        assert!(changes.removed.is_empty());
    }

    #[test]
    fn deleted_base_sections_are_reported() {
        let user = "# Rules\n\n## Priority\nBe careful.\n";
        let changes = section_changes(BASE_OLD, user);
        assert!(changes.changed.is_empty());
        assert_eq!(changes.removed, vec!["## Git", "## Delegation"]);
    }

    #[test]
    fn line_ending_and_trailing_blank_line_differences_are_not_changes() {
        let user = BASE_OLD.replace('\n', "\r\n") + "\r\n\r\n";
        assert!(section_changes(BASE_OLD, &user).changed.is_empty());
    }

    #[test]
    fn closest_base_picks_the_base_the_text_started_from() {
        let refined = BASE_OLD.replace("model one", "model two");
        let closest = closest_base(BASE_NEW, &[old_base()], &refined);
        assert_eq!(closest.digest, old_base().digest);
        assert_eq!(closest.changed_lines, 2);
        // With no history the current source is the only candidate.
        let only = closest_base(BASE_NEW, &[], &refined);
        assert_eq!(only.digest, stable_digest::bytes(BASE_NEW.as_bytes()));
    }

    #[test]
    fn edits_diff_of_a_crlf_file_matches_the_changed_line_count() {
        let refined = BASE_OLD
            .replace("model one", "model two")
            .replace('\n', "\r\n");
        let closest = closest_base(BASE_NEW, &[old_base()], &refined);
        assert_eq!(closest.digest, old_base().digest);
        let diff = rules_diff::unified_diff("base", "installed", &closest.text, &refined);
        assert_eq!((diff.removed, diff.added), (1, 1), "{}", diff.text);
        assert_eq!(diff.removed + diff.added, closest.changed_lines);
    }

    #[test]
    fn converting_a_refined_legacy_file_moves_only_the_changed_section() {
        let refined = BASE_OLD.replace("Use model one.", "Use model two.");
        let converted = convert(refined.as_bytes(), BASE_NEW, &[old_base()], "CLAUDE.md").unwrap();
        assert_eq!(converted.origin, ConversionOrigin::LegacyFile);
        assert_eq!(converted.moved_sections, vec!["## Delegation"]);
        assert!(converted.removed_sections.is_empty());
        assert_eq!(converted.compared_base, old_base().digest);
        let expected = format!(
            "{BEGIN_MARKER}\n{BASE_NEW}{END_MARKER}\n\n<!-- Refined from your previous CLAUDE.md: sections you changed or added are kept below, verbatim. They come after the base block, so they override it where they conflict. Review and trim them. -->\n\n## Delegation\nUse model two.\n"
        );
        assert_eq!(converted.result, expected);
        // The result is a clean block file: the next plan sees the current base.
        let parsed = rules_block::parse(&converted.result).unwrap().unwrap();
        assert_eq!(parsed.body_digest(), rules_block::body_digest(BASE_NEW));
        assert_eq!(parsed.refinement_lines(), 3);
    }

    #[test]
    fn converting_a_file_that_matches_no_base_keeps_all_its_content() {
        let mine = "# My own rules\n\n## Style\nTabs.\n";
        let converted = convert(mine.as_bytes(), BASE_NEW, &[old_base()], "AGENTS.md").unwrap();
        assert_eq!(
            converted.moved_sections,
            vec!["(text before the first section)", "## Style"]
        );
        assert!(converted.result.contains("# My own rules"));
        assert!(converted.result.contains("## Style\nTabs.\n"));
        assert!(converted.result.starts_with(BEGIN_MARKER));
    }

    #[test]
    fn converting_an_unchanged_but_section_deleted_file_adds_no_refinements() {
        let trimmed = "# Rules\n\n## Priority\nBe careful.\n";
        let converted = convert(trimmed.as_bytes(), BASE_NEW, &[old_base()], "CLAUDE.md").unwrap();
        assert!(converted.moved_sections.is_empty());
        assert_eq!(converted.removed_sections, vec!["## Git", "## Delegation"]);
        assert_eq!(converted.result, rules_block::render_new(BASE_NEW));
    }

    #[test]
    fn converting_an_edited_block_keeps_prefix_suffix_and_moves_the_edit() {
        let edited_body = BASE_OLD.replace("No force push.", "Force push is fine.");
        let file =
            format!("my notes\n{BEGIN_MARKER}\n{edited_body}{END_MARKER}\n\n## Mine\nkept\n");
        let converted = convert(file.as_bytes(), BASE_NEW, &[old_base()], "CLAUDE.md").unwrap();
        assert_eq!(converted.origin, ConversionOrigin::EditedBlock);
        assert_eq!(converted.moved_sections, vec!["## Git"]);
        let expected = format!(
            "my notes\n{BEGIN_MARKER}\n{BASE_NEW}{END_MARKER}\n\n<!-- Refined from your previous CLAUDE.md: sections you changed or added are kept below, verbatim. They come after the base block, so they override it where they conflict. Review and trim them. -->\n\n## Git\nForce push is fine.\n\n## Mine\nkept\n"
        );
        // The moved section sits between the new block and the old suffix.
        assert_eq!(converted.result, expected);
        let parsed = rules_block::parse(&converted.result).unwrap().unwrap();
        assert_eq!(parsed.prefix, "my notes\n");
        assert_eq!(parsed.body_digest(), rules_block::body_digest(BASE_NEW));
    }

    #[test]
    fn conversion_keeps_crlf_and_bom() {
        let refined = BASE_OLD
            .replace("Use model one.", "Use model two.")
            .replace('\n', "\r\n");
        let file = format!("\u{feff}{refined}");
        let converted = convert(file.as_bytes(), BASE_NEW, &[old_base()], "CLAUDE.md").unwrap();
        assert!(converted.result.starts_with('\u{feff}'));
        assert!(!converted.result.replace("\r\n", "").contains('\n'));
        assert!(converted
            .result
            .contains("## Delegation\r\nUse model two.\r\n"));
    }

    #[test]
    fn conversion_refuses_malformed_markers_binary_and_huge_files() {
        let malformed = format!("{BEGIN_MARKER}\nno end\n");
        assert!(convert(malformed.as_bytes(), BASE_NEW, &[], "x").is_err());
        assert!(convert(&[0xff, 0xfe], BASE_NEW, &[], "x").is_err());
        let huge = vec![b'a'; MAX_CONVERTIBLE_BYTES + 1];
        assert!(convert(&huge, BASE_NEW, &[], "x").is_err());
    }

    #[test]
    fn known_bases_come_from_the_bundled_history_and_hash_to_their_names() {
        let bundled = crate::setup_roots::bundled_root().unwrap();
        for artifact in [
            ArtifactId::ClaudeRules,
            ArtifactId::CodexRules,
            ArtifactId::OpenCodeRules,
        ] {
            let bases = known_bases(&bundled, &artifact);
            assert!(!bases.is_empty(), "{artifact:?} has no bundled history");
            for base in &bases {
                assert_eq!(base.digest, stable_digest::bytes(base.text.as_bytes()));
            }
        }
        assert!(known_bases(&bundled, &ArtifactId::CodexConfig).is_empty());
    }

    #[test]
    fn a_tampered_history_file_is_ignored() {
        let root = std::env::temp_dir().join(format!(
            "aw-history-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join(HISTORY_DIR).join("claude");
        fs::create_dir_all(&dir).unwrap();
        let good = stable_digest::bytes(b"good\n");
        fs::write(
            dir.join(format!("{}.md", good.strip_prefix("sha256:").unwrap())),
            "good\n",
        )
        .unwrap();
        fs::write(dir.join(format!("{}.md", "0".repeat(64))), "forged\n").unwrap();
        fs::write(dir.join("notes.md"), "x").unwrap();
        let bases = known_bases(&root, &ArtifactId::ClaudeRules);
        assert_eq!(bases.len(), 1);
        assert_eq!(bases[0].digest, good);
        let _ = fs::remove_dir_all(&root);
    }
}
