//! Managed base block inside a user-owned rules file.
//!
//! `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.config/opencode/AGENTS.md`
//! hold the Agent Workspace base between two marker lines. Agent Workspace owns
//! only the bytes between the markers; everything before BEGIN and after END is
//! the user's refinement layer and is preserved byte for byte.
//!
//! Marker lines count only at column 0 outside fenced code blocks. A file holds
//! either no markers (legacy whole-file layout) or exactly one BEGIN followed by
//! exactly one END; anything else is malformed and refused with a typed reason.
//! A leading UTF-8 BOM, CRLF line endings, and a missing trailing newline all
//! survive a parse and re-render.
//!
//! Digests of a block body normalize CRLF to LF and ensure one trailing newline,
//! so an editor that rewrites line endings does not look like an edit of the
//! base. Shipped base files are LF with a trailing newline, so the digest of a
//! shipped file equals the digest of its block body.

use serde::Serialize;

use crate::stable_digest;

pub const BEGIN_MARKER: &str = "<!-- BEGIN AGENT-WORKSPACE BASE: managed by Agent Workspace; edits inside are replaced on update; add refinements below END -->";
pub const END_MARKER: &str = "<!-- END AGENT-WORKSPACE BASE -->";

/// A BEGIN line is recognized by its stable prefix and closing `-->`, so the
/// explanatory prose inside the comment can change without orphaning old files.
const BEGIN_PREFIX: &str = "<!-- BEGIN AGENT-WORKSPACE BASE";
const BOM: &str = "\u{feff}";

/// Why a rules file cannot be split into prefix, block, and suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MalformedReason {
    NotUtf8,
    DuplicateBegin,
    DuplicateEnd,
    MissingEnd,
    MissingBegin,
    EndBeforeBegin,
}

impl MalformedReason {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotUtf8 => "file is not valid UTF-8",
            Self::DuplicateBegin => "more than one BEGIN AGENT-WORKSPACE BASE marker",
            Self::DuplicateEnd => "more than one END AGENT-WORKSPACE BASE marker",
            Self::MissingEnd => "BEGIN marker has no matching END marker",
            Self::MissingBegin => "END marker has no matching BEGIN marker",
            Self::EndBeforeBegin => "END marker appears before the BEGIN marker",
        }
    }
}

/// A rules file split around its managed block. Concatenating the parts in
/// field order reproduces the parsed text exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RulesFile<'a> {
    /// `"\u{feff}"` when the file starts with a BOM, else empty.
    pub bom: &'a str,
    /// User text before the BEGIN line.
    pub prefix: &'a str,
    /// The BEGIN line including its line ending.
    pub begin: &'a str,
    /// Block body: every line between BEGIN and END, line endings included.
    pub body: &'a str,
    /// The END line including its line ending, when it has one.
    pub end: &'a str,
    /// User text after the END line.
    pub suffix: &'a str,
}

impl RulesFile<'_> {
    /// Digest of the block body (see the module note on normalization).
    pub fn body_digest(&self) -> String {
        body_digest(self.body)
    }

    /// Non-blank lines of user text around the block.
    pub fn refinement_lines(&self) -> usize {
        non_blank_lines(self.prefix) + non_blank_lines(self.suffix)
    }

    /// True when nothing but whitespace surrounds the block.
    pub fn user_region_is_blank(&self) -> bool {
        self.prefix.trim().is_empty() && self.suffix.trim().is_empty()
    }

    /// The file with its block body replaced by `source`. BOM, prefix, END
    /// line, and suffix are kept byte for byte; the BEGIN line is rewritten to
    /// the current marker text and the body takes the file's line ending.
    pub fn render_with_body(&self, source: &str) -> String {
        let eol = if self.begin.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let mut out = String::with_capacity(self.prefix.len() + source.len() + 256);
        out.push_str(self.bom);
        out.push_str(self.prefix);
        out.push_str(BEGIN_MARKER);
        out.push_str(eol);
        out.push_str(&with_eol(&canonical_body(source), eol));
        out.push_str(self.end);
        out.push_str(self.suffix);
        out
    }

    /// The text of the file, used to prove a parse is lossless.
    #[cfg(test)]
    fn to_text(&self) -> String {
        [
            self.bom,
            self.prefix,
            self.begin,
            self.body,
            self.end,
            self.suffix,
        ]
        .concat()
    }
}

/// A new rules file holding only the managed block.
pub fn render_new(source: &str) -> String {
    format!("{BEGIN_MARKER}\n{}{END_MARKER}\n", canonical_body(source))
}

/// Parse rules-file bytes. `Ok(None)` means the file has no markers.
pub fn parse_bytes(bytes: &[u8]) -> Result<Option<RulesFile<'_>>, MalformedReason> {
    let text = std::str::from_utf8(bytes).map_err(|_| MalformedReason::NotUtf8)?;
    parse(text)
}

/// Parse rules-file text. `Ok(None)` means the file has no markers.
pub fn parse(text: &str) -> Result<Option<RulesFile<'_>>, MalformedReason> {
    let start = if text.starts_with(BOM) { BOM.len() } else { 0 };
    let mut fence: Option<Fence> = None;
    // (start of line, end of line including its line ending)
    let mut begins: Vec<(usize, usize)> = Vec::new();
    let mut ends: Vec<(usize, usize)> = Vec::new();
    let mut position = start;
    while position < text.len() {
        let rest = &text[position..];
        let (length, content) = match rest.find('\n') {
            Some(index) => (index + 1, &rest[..index]),
            None => (rest.len(), rest),
        };
        let content = content.strip_suffix('\r').unwrap_or(content);
        match &fence {
            Some(open) => {
                if open.closed_by(content) {
                    fence = None;
                }
            }
            None => {
                if let Some(open) = Fence::opened_by(content) {
                    fence = Some(open);
                } else if is_begin_line(content) {
                    begins.push((position, position + length));
                } else if is_end_line(content) {
                    ends.push((position, position + length));
                }
            }
        }
        position += length;
    }

    match (begins.as_slice(), ends.as_slice()) {
        ([], []) => Ok(None),
        ([_, _, ..], _) => Err(MalformedReason::DuplicateBegin),
        (_, [_, _, ..]) => Err(MalformedReason::DuplicateEnd),
        ([_], []) => Err(MalformedReason::MissingEnd),
        ([], [_]) => Err(MalformedReason::MissingBegin),
        ([(begin_start, begin_end)], [(end_start, end_end)]) => {
            if end_start < begin_end {
                return Err(MalformedReason::EndBeforeBegin);
            }
            Ok(Some(RulesFile {
                bom: &text[..start],
                prefix: &text[start..*begin_start],
                begin: &text[*begin_start..*begin_end],
                body: &text[*begin_end..*end_start],
                end: &text[*end_start..*end_end],
                suffix: &text[*end_end..],
            }))
        }
    }
}

/// Digest of a block body or source body: CRLF normalized to LF and one
/// trailing newline ensured.
pub fn body_digest(body: &str) -> String {
    stable_digest::bytes(canonical_body(body).as_bytes())
}

/// Digest of a source file's body, as installed into a block.
pub fn source_digest(source: &[u8]) -> Result<String, String> {
    std::str::from_utf8(source)
        .map(body_digest)
        .map_err(|_| "rules source is not valid UTF-8".to_string())
}

/// The managed digest of an installed rules file: its block body when it has
/// one, otherwise (legacy or unparsable) the digest of the whole file.
pub fn installed_managed_digest(bytes: &[u8]) -> String {
    match parse_bytes(bytes) {
        Ok(Some(file)) => file.body_digest(),
        _ => stable_digest::bytes(bytes),
    }
}

/// Whether the installed file already carries `source` as its base: the block
/// body matches, or a legacy file without markers equals the source exactly.
pub fn installed_matches_source(installed: &[u8], source: &[u8]) -> bool {
    let Ok(source_text) = std::str::from_utf8(source) else {
        return false;
    };
    match parse_bytes(installed) {
        Ok(Some(file)) => file.body_digest() == body_digest(source_text),
        Ok(None) => installed == source,
        Err(_) => false,
    }
}

fn canonical_body(body: &str) -> String {
    let mut canonical = body.replace("\r\n", "\n");
    if !canonical.is_empty() && !canonical.ends_with('\n') {
        canonical.push('\n');
    }
    canonical
}

fn with_eol(lf_text: &str, eol: &str) -> String {
    if eol == "\n" {
        lf_text.to_string()
    } else {
        lf_text.replace('\n', eol)
    }
}

fn non_blank_lines(text: &str) -> usize {
    text.lines().filter(|line| !line.trim().is_empty()).count()
}

fn is_begin_line(line: &str) -> bool {
    line.starts_with(BEGIN_PREFIX) && line.trim_end().ends_with("-->")
}

fn is_end_line(line: &str) -> bool {
    line.trim_end() == END_MARKER
}

/// An open fenced code block (CommonMark: up to three spaces of indent, then
/// three or more backticks or tildes).
struct Fence {
    marker: u8,
    length: usize,
}

impl Fence {
    fn opened_by(line: &str) -> Option<Self> {
        let rest = strip_fence_indent(line)?;
        let marker = *rest.as_bytes().first()?;
        if marker != b'`' && marker != b'~' {
            return None;
        }
        let length = rest.bytes().take_while(|byte| *byte == marker).count();
        if length < 3 {
            return None;
        }
        // A backtick fence's info string cannot contain a backtick.
        if marker == b'`' && rest[length..].contains('`') {
            return None;
        }
        Some(Self { marker, length })
    }

    fn closed_by(&self, line: &str) -> bool {
        let Some(rest) = strip_fence_indent(line) else {
            return false;
        };
        let run = rest.bytes().take_while(|byte| *byte == self.marker).count();
        run >= self.length && rest[run..].trim().is_empty()
    }
}

fn strip_fence_indent(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3).then_some(trimmed)
}

// ── Classification ──

/// Why a rules file is left alone instead of updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RulesConflict {
    /// The managed block differs from every base Agent Workspace shipped.
    BaseBlockEdited,
    /// A pre-block file whose content is not a base Agent Workspace shipped.
    LegacyDiverged,
    /// Marker lines are duplicated, unpaired, or out of order.
    MalformedMarkers,
}

impl RulesConflict {
    pub fn message(self) -> &'static str {
        match self {
            Self::BaseBlockEdited => "the managed base block was edited",
            Self::LegacyDiverged => "the file differs from every base Agent Workspace shipped",
            Self::MalformedMarkers => "the base block markers are malformed",
        }
    }
}

/// The file layout of an installed rules file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RulesLayout {
    Absent,
    Block,
    Legacy,
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RulesPlan {
    /// No file: write a new file holding the block.
    Create,
    /// The block already carries the current base.
    NoChange,
    /// Replace the block body; prefix and suffix stay.
    UpdateBlock,
    /// A pristine pre-block file: replace it with a file holding the block.
    WrapLegacy,
    Conflict(RulesConflict),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RulesAssessment {
    pub plan: RulesPlan,
    pub layout: RulesLayout,
    pub malformed: Option<MalformedReason>,
    /// Non-blank user lines around the block (0 without a block).
    pub refinement_lines: usize,
}

/// Classify an installed rules file against the bundled source.
///
/// `managed` is the digest recorded after the last apply (a block body digest,
/// or a whole-file digest for a record made before blocks existed).
/// `is_shipped` says whether a digest belongs to a base the app shipped.
pub fn assess(
    installed: Option<&[u8]>,
    source: &str,
    managed: Option<&str>,
    is_shipped: &dyn Fn(&str) -> bool,
) -> RulesAssessment {
    let assessment = |plan, layout, malformed, refinement_lines| RulesAssessment {
        plan,
        layout,
        malformed,
        refinement_lines,
    };
    let Some(bytes) = installed else {
        return assessment(RulesPlan::Create, RulesLayout::Absent, None, 0);
    };
    match parse_bytes(bytes) {
        Err(reason) => assessment(
            RulesPlan::Conflict(RulesConflict::MalformedMarkers),
            RulesLayout::Malformed,
            Some(reason),
            0,
        ),
        Ok(Some(file)) => {
            let digest = file.body_digest();
            let lines = file.refinement_lines();
            let proven = digest == body_digest(source)
                || managed == Some(digest.as_str())
                || is_shipped(&digest);
            let plan = if digest == body_digest(source) {
                RulesPlan::NoChange
            } else if proven {
                RulesPlan::UpdateBlock
            } else {
                RulesPlan::Conflict(RulesConflict::BaseBlockEdited)
            };
            assessment(plan, RulesLayout::Block, None, lines)
        }
        Ok(None) => {
            let full = stable_digest::bytes(bytes);
            let pristine = bytes.iter().all(u8::is_ascii_whitespace)
                || managed == Some(full.as_str())
                || full == stable_digest::bytes(source.as_bytes())
                || is_shipped(&full);
            let plan = if pristine {
                RulesPlan::WrapLegacy
            } else {
                RulesPlan::Conflict(RulesConflict::LegacyDiverged)
            };
            assessment(plan, RulesLayout::Legacy, None, 0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = "# Base\n\n- one\n- two\n";

    fn block(body: &str) -> String {
        format!("{BEGIN_MARKER}\n{body}{END_MARKER}\n")
    }

    fn never(_: &str) -> bool {
        false
    }

    #[test]
    fn parse_without_markers_is_none() {
        assert_eq!(parse("# my rules\n").unwrap(), None);
        assert_eq!(parse("").unwrap(), None);
    }

    #[test]
    fn parse_splits_prefix_block_and_suffix() {
        let text = format!("before\n{}after\n", block("base\n"));
        let file = parse(&text).unwrap().unwrap();
        assert_eq!(file.prefix, "before\n");
        assert_eq!(file.body, "base\n");
        assert_eq!(file.suffix, "after\n");
        assert_eq!(file.to_text(), text);
        assert_eq!(file.refinement_lines(), 2);
    }

    #[test]
    fn round_trip_is_byte_exact_for_every_line_ending_shape() {
        let lf = format!("mine\n\n{}\nrefined\n", block("base\n"));
        let crlf = lf.replace('\n', "\r\n");
        let bom = format!("\u{feff}{lf}");
        let bom_crlf = format!("\u{feff}{crlf}");
        let no_trailing_newline = format!("{BEGIN_MARKER}\nbase\n{END_MARKER}");
        let trailing_text_no_newline = format!("{}tail", block("base\n"));
        let empty_body = format!("{BEGIN_MARKER}\n{END_MARKER}\n");
        for text in [
            lf,
            crlf,
            bom,
            bom_crlf,
            no_trailing_newline,
            trailing_text_no_newline,
            empty_body,
        ] {
            let file = parse(&text).unwrap().expect("block");
            assert_eq!(file.to_text(), text, "{text:?}");
            // Re-rendering the same body keeps everything but the BEGIN prose.
            let rerendered = file.render_with_body(file.body);
            assert_eq!(rerendered, text, "{text:?}");
        }
    }

    #[test]
    fn render_with_body_keeps_prefix_suffix_bom_and_crlf() {
        let text = format!("\u{feff}top\r\n{BEGIN_MARKER}\r\nold\r\n{END_MARKER}\r\nbottom");
        let file = parse(&text).unwrap().unwrap();
        let updated = file.render_with_body("new line\nsecond\n");
        assert_eq!(
            updated,
            format!(
                "\u{feff}top\r\n{BEGIN_MARKER}\r\nnew line\r\nsecond\r\n{END_MARKER}\r\nbottom"
            )
        );
        let reparsed = parse(&updated).unwrap().unwrap();
        assert_eq!(reparsed.prefix, "top\r\n");
        assert_eq!(reparsed.suffix, "bottom");
    }

    #[test]
    fn render_with_body_rewrites_an_old_begin_line() {
        let text = format!("<!-- BEGIN AGENT-WORKSPACE BASE: older prose -->\nold\n{END_MARKER}\n");
        let file = parse(&text).unwrap().unwrap();
        assert_eq!(file.render_with_body("new\n"), block("new\n"));
    }

    #[test]
    fn render_new_is_a_parsable_block() {
        let text = render_new("no newline at end");
        let file = parse(&text).unwrap().unwrap();
        assert_eq!(file.body, "no newline at end\n");
        assert!(file.user_region_is_blank());
        assert_eq!(file.refinement_lines(), 0);
        assert!(text.ends_with(&format!("{END_MARKER}\n")));
    }

    #[test]
    fn duplicate_begin_is_refused() {
        let text = format!("{}{}", block("a\n"), block("b\n"));
        assert_eq!(parse(&text), Err(MalformedReason::DuplicateBegin));
        let text = format!("{BEGIN_MARKER}\n{BEGIN_MARKER}\nx\n{END_MARKER}\n");
        assert_eq!(parse(&text), Err(MalformedReason::DuplicateBegin));
    }

    #[test]
    fn duplicate_end_is_refused() {
        let text = format!("{BEGIN_MARKER}\nx\n{END_MARKER}\n{END_MARKER}\n");
        assert_eq!(parse(&text), Err(MalformedReason::DuplicateEnd));
    }

    #[test]
    fn missing_end_is_refused() {
        let text = format!("{BEGIN_MARKER}\nbody without end\n");
        assert_eq!(parse(&text), Err(MalformedReason::MissingEnd));
    }

    #[test]
    fn missing_begin_is_refused() {
        let text = format!("body\n{END_MARKER}\n");
        assert_eq!(parse(&text), Err(MalformedReason::MissingBegin));
    }

    #[test]
    fn end_before_begin_is_refused() {
        let text = format!("{END_MARKER}\nx\n{BEGIN_MARKER}\n");
        assert_eq!(parse(&text), Err(MalformedReason::EndBeforeBegin));
    }

    #[test]
    fn non_utf8_is_refused() {
        assert_eq!(
            parse_bytes(&[0x23, 0xff, 0xfe]),
            Err(MalformedReason::NotUtf8)
        );
    }

    #[test]
    fn markers_inside_fenced_code_are_ignored() {
        for fence in ["```", "~~~", "````"] {
            let text = format!("docs\n{fence}\n{BEGIN_MARKER}\n{END_MARKER}\n{fence}\nmore\n");
            assert_eq!(parse(&text).unwrap(), None, "{fence}");
        }
        // A real block next to fenced examples of the markers still parses.
        let text = format!(
            "{}\n```md\n{BEGIN_MARKER}\n```\n",
            block("base\n").trim_end()
        );
        let file = parse(&text).unwrap().unwrap();
        assert_eq!(file.body, "base\n");
    }

    #[test]
    fn an_unclosed_fence_hides_markers_after_it() {
        let text = format!("```\n{}", block("base\n"));
        assert_eq!(parse(&text).unwrap(), None);
    }

    #[test]
    fn markers_off_column_zero_are_ignored() {
        let text = format!(" {BEGIN_MARKER}\n\t{END_MARKER}\ntext {END_MARKER}\n");
        assert_eq!(parse(&text).unwrap(), None);
    }

    #[test]
    fn marker_with_trailing_whitespace_still_counts() {
        let text = format!("{BEGIN_MARKER}  \nbody\n{END_MARKER}\t\n");
        let file = parse(&text).unwrap().unwrap();
        assert_eq!(file.body, "body\n");
    }

    #[test]
    fn body_digest_ignores_line_ending_style_and_final_newline() {
        let lf = body_digest("a\nb\n");
        assert_eq!(lf, body_digest("a\r\nb\r\n"));
        assert_eq!(lf, body_digest("a\nb"));
        assert_ne!(lf, body_digest("a\nc\n"));
        // A shipped file (LF, trailing newline) digests like its block body.
        assert_eq!(lf, stable_digest::bytes(b"a\nb\n"));
    }

    #[test]
    fn installed_managed_digest_uses_the_block_or_the_whole_file() {
        let wrapped = format!("mine\n{}", block(SOURCE));
        assert_eq!(
            installed_managed_digest(wrapped.as_bytes()),
            body_digest(SOURCE)
        );
        assert_eq!(
            installed_managed_digest(SOURCE.as_bytes()),
            stable_digest::bytes(SOURCE.as_bytes())
        );
        let malformed = format!("{BEGIN_MARKER}\nno end\n");
        assert_eq!(
            installed_managed_digest(malformed.as_bytes()),
            stable_digest::bytes(malformed.as_bytes())
        );
    }

    #[test]
    fn installed_matches_source_for_block_and_exact_legacy_files() {
        let wrapped = format!("mine\n{}more\n", block(SOURCE));
        assert!(installed_matches_source(
            wrapped.as_bytes(),
            SOURCE.as_bytes()
        ));
        assert!(installed_matches_source(
            SOURCE.as_bytes(),
            SOURCE.as_bytes()
        ));
        assert!(!installed_matches_source(b"# other\n", SOURCE.as_bytes()));
        let edited = format!("mine\n{}", block("# Base\n\n- changed\n"));
        assert!(!installed_matches_source(
            edited.as_bytes(),
            SOURCE.as_bytes()
        ));
    }

    #[test]
    fn assess_absent_creates() {
        let result = assess(None, SOURCE, None, &never);
        assert_eq!(result.plan, RulesPlan::Create);
        assert_eq!(result.layout, RulesLayout::Absent);
    }

    #[test]
    fn assess_block_equal_to_source_is_no_change() {
        let file = format!("mine\n{}tail\n", block(SOURCE));
        let result = assess(Some(file.as_bytes()), SOURCE, None, &never);
        assert_eq!(result.plan, RulesPlan::NoChange);
        assert_eq!(result.layout, RulesLayout::Block);
        assert_eq!(result.refinement_lines, 2);
    }

    #[test]
    fn assess_block_matching_the_record_updates_and_keeps_refinements() {
        let old = "# Old base\n";
        let file = format!("mine\n{}tail\n", block(old));
        let managed = body_digest(old);
        let result = assess(Some(file.as_bytes()), SOURCE, Some(&managed), &never);
        assert_eq!(result.plan, RulesPlan::UpdateBlock);
        assert_eq!(result.refinement_lines, 2);
    }

    #[test]
    fn assess_block_matching_a_shipped_base_updates_without_a_record() {
        let old = "# Old base\n";
        let shipped = body_digest(old);
        let file = block(old);
        let result = assess(Some(file.as_bytes()), SOURCE, None, &|d| d == shipped);
        assert_eq!(result.plan, RulesPlan::UpdateBlock);
    }

    #[test]
    fn assess_edited_block_is_a_conflict() {
        let file = block("# Old base\n- my edit\n");
        let managed = body_digest("# Old base\n");
        let result = assess(Some(file.as_bytes()), SOURCE, Some(&managed), &never);
        assert_eq!(
            result.plan,
            RulesPlan::Conflict(RulesConflict::BaseBlockEdited)
        );
    }

    #[test]
    fn assess_block_with_crlf_conversion_is_not_an_edit() {
        let crlf = block(SOURCE).replace('\n', "\r\n");
        let result = assess(Some(crlf.as_bytes()), SOURCE, None, &never);
        assert_eq!(result.plan, RulesPlan::NoChange);
    }

    #[test]
    fn assess_pristine_legacy_files_are_wrapped() {
        let managed = stable_digest::bytes(b"# Old whole file\n");
        // equals the managed record
        let result = assess(Some(b"# Old whole file\n"), SOURCE, Some(&managed), &never);
        assert_eq!(result.plan, RulesPlan::WrapLegacy);
        // equals the current source
        let result = assess(Some(SOURCE.as_bytes()), SOURCE, None, &never);
        assert_eq!(result.plan, RulesPlan::WrapLegacy);
        // equals a shipped base
        let shipped = stable_digest::bytes(b"# Shipped\n");
        let result = assess(Some(b"# Shipped\n"), SOURCE, None, &|d| d == shipped);
        assert_eq!(result.plan, RulesPlan::WrapLegacy);
        // blank files hold nothing to lose
        let result = assess(Some(b"\n  \n"), SOURCE, None, &never);
        assert_eq!(result.plan, RulesPlan::WrapLegacy);
    }

    #[test]
    fn assess_diverged_legacy_file_is_a_conflict() {
        let managed = stable_digest::bytes(b"# Old whole file\n");
        let result = assess(
            Some(b"# Old whole file\n- edited\n"),
            SOURCE,
            Some(&managed),
            &never,
        );
        assert_eq!(
            result.plan,
            RulesPlan::Conflict(RulesConflict::LegacyDiverged)
        );
        assert_eq!(result.layout, RulesLayout::Legacy);
    }

    #[test]
    fn assess_malformed_markers_are_a_conflict_with_a_reason() {
        let file = format!("{BEGIN_MARKER}\nno end\n");
        let result = assess(Some(file.as_bytes()), SOURCE, None, &never);
        assert_eq!(
            result.plan,
            RulesPlan::Conflict(RulesConflict::MalformedMarkers)
        );
        assert_eq!(result.layout, RulesLayout::Malformed);
        assert_eq!(result.malformed, Some(MalformedReason::MissingEnd));
    }
}
