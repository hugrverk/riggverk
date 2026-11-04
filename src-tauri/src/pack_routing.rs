//! Routing lines a skill pack adds to the managed rules block.
//!
//! A pack may hold `packs/<pack>/routing.md`: plain markdown bullet lines that tell an agent when to
//! use the pack's own skills, the way the bundled base's "Skill routing" section does for the
//! bundled ones. The file is read with the pack (see [`crate::skill_sources`]) and under the same
//! trust: no symlink, a regular file owned by the current user and not writable by group or others
//! (Unix), at most [`MAX_ROUTING_BYTES`] and [`MAX_ROUTING_LINES`].
//!
//! Every non-blank line must be a `- ` bullet whose backticked spans all name an active skill of
//! that same pack (not shadowed by the bundle, not in error, not held), with at least one span.
//! A line that could change how the block parses or reads (a marker or any other `<`, a heading, a
//! code fence, a control character or an invisible character such as a zero-width space, a
//! variation selector, a bidi override or a tag character, more than [`MAX_LINE_CHARS`]
//! characters) is refused. One bad
//! line excludes the whole file, with a fixed-phrase reason that quotes no text of it.
//!
//! Valid lines are rendered under [`SECTION_HEADING`], one `###` group per pack in name order, right
//! after the base's own `## Skill routing` section. The result is the rules source every plan,
//! fingerprint, ownership digest, apply, health check and Library view compares with, so a change
//! of `routing.md` is an ordinary block update with a preview diff, backup and rollback. With no
//! routing the source is the bundled base byte for byte.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::artifact_registry::ArtifactId;
use crate::skill_sources::SourceRoot;

/// File name inside a pack folder.
pub const ROUTING_FILE: &str = "routing.md";
/// Heading of the rendered section in the managed block.
pub const SECTION_HEADING: &str = "## Pack skill routing";
/// The base section the pack section follows.
const ANCHOR_HEADING: &str = "## Skill routing";
/// Largest `routing.md` read.
pub const MAX_ROUTING_BYTES: u64 = 12 * 1024;
/// Most lines a `routing.md` may have, blank ones included.
pub const MAX_ROUTING_LINES: usize = 60;
/// Longest line, in characters.
pub const MAX_LINE_CHARS: usize = 240;

/// What one pack contributes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum PackRouting {
    /// No `routing.md`, an empty one, or a pack that is not read at all.
    #[default]
    None,
    /// The lines rendered into the block, in file order.
    Applied(Vec<String>),
    /// The file was refused as a whole; the reason is a fixed phrase.
    Excluded(String),
}

impl PackRouting {
    pub fn lines(&self) -> &[String] {
        match self {
            PackRouting::Applied(lines) => lines,
            _ => &[],
        }
    }

    pub fn problem(&self) -> Option<&str> {
        match self {
            PackRouting::Excluded(reason) => Some(reason),
            _ => None,
        }
    }
}

fn excluded(reason: impl std::fmt::Display) -> PackRouting {
    PackRouting::Excluded(format!("routing.md is not used: {reason}"))
}

/// Reads and validates `<pack_dir>/routing.md` against the active skills of that pack.
pub(crate) fn read(pack_dir: &Path, own_skills: &BTreeSet<&str>) -> PackRouting {
    let path = pack_dir.join(ROUTING_FILE);
    let meta = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return PackRouting::None,
        Err(_) => return excluded("it cannot be read"),
        Ok(meta) => meta,
    };
    if meta.file_type().is_symlink() {
        return excluded("it is a symlink");
    }
    if !meta.is_file() {
        return excluded("it is not a regular file");
    }
    if let Err(reason) =
        crate::skill_sources::check_trusted_path(&path, pack_dir, &meta, ROUTING_FILE)
    {
        return PackRouting::Excluded(reason);
    }
    if meta.len() > MAX_ROUTING_BYTES {
        return excluded(format_args!("it is larger than {MAX_ROUTING_BYTES} bytes"));
    }
    let Ok(file) = open_checked(&path, &meta) else {
        return excluded("it cannot be read");
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_ROUTING_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return excluded("it cannot be read");
    }
    if bytes.len() as u64 > MAX_ROUTING_BYTES {
        return excluded(format_args!("it is larger than {MAX_ROUTING_BYTES} bytes"));
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return excluded("it is not UTF-8 text");
    };
    match validate(&text, own_skills) {
        Ok(lines) if lines.is_empty() => PackRouting::None,
        Ok(lines) => PackRouting::Applied(lines),
        Err(reason) => excluded(reason),
    }
}

/// The line the app writes into the imported pack's `routing.md` for `name`: ``- {when}: `{name}`.``,
/// checked by the same rules as the reader, so a saved line is never what excludes the file. `when`
/// may name no skill and hold no markup; the reason is a fixed phrase that quotes none of it.
pub(crate) fn routing_line(when: &str, name: &str) -> Result<String, String> {
    if when
        .chars()
        .any(|c| c.is_control() || is_invisible_in_routing(c))
    {
        return Err("invalid routing description".to_string());
    }
    let when = when.trim();
    if when.is_empty() || when.starts_with('#') || when.contains(['`', '<']) || when.contains("~~~")
    {
        return Err("invalid routing description".to_string());
    }
    let line = format!("- {when}: `{name}`.");
    validate(&line, &BTreeSet::from([name]))
        .map_err(|_| "invalid routing description".to_string())?;
    Ok(line)
}

/// The `when` of `line` when it has exactly the form [`routing_line`] writes for `name` (trailing
/// whitespace aside, as the reader trims it); `None` for any other line, which stays as it is.
pub(crate) fn own_when(line: &str, name: &str) -> Option<String> {
    let when = line
        .trim_end()
        .strip_prefix("- ")?
        .strip_suffix(&format!(": `{name}`."))?;
    (!when.is_empty() && !when.contains('`')).then(|| when.to_string())
}

/// The text of `<pack_dir>/routing.md` ("" when there is none), under the same trust checks as
/// [`read`] but without validating its lines, so the app can edit a file that is not used.
pub(crate) fn read_raw(pack_dir: &Path) -> Result<String, String> {
    let path = pack_dir.join(ROUTING_FILE);
    let bad = || "routing.md cannot be read safely".to_string();
    let meta = match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err(bad()),
        Ok(meta) => meta,
    };
    if meta.file_type().is_symlink()
        || !meta.is_file()
        || meta.len() > MAX_ROUTING_BYTES
        || crate::skill_sources::check_trusted_path(&path, pack_dir, &meta, ROUTING_FILE).is_err()
    {
        return Err(bad());
    }
    let mut bytes = Vec::new();
    open_checked(&path, &meta)
        .map_err(|_| bad())?
        .take(MAX_ROUTING_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| bad())?;
    if bytes.len() as u64 > MAX_ROUTING_BYTES {
        return Err(bad());
    }
    String::from_utf8(bytes).map_err(|_| bad())
}

/// Opens the file checked above, and refuses it when what opened is not that file any more (a link
/// or another file swapped in between the check and the open).
fn open_checked(path: &Path, checked: &fs::Metadata) -> std::io::Result<fs::File> {
    let file = fs::File::open(path)?;
    let opened = file.metadata()?;
    #[cfg(unix)]
    let same = {
        use std::os::unix::fs::MetadataExt;
        opened.dev() == checked.dev() && opened.ino() == checked.ino()
    };
    #[cfg(not(unix))]
    let same = {
        let _ = checked;
        true
    };
    if !same || !opened.is_file() {
        return Err(std::io::Error::other("the file changed while it was read"));
    }
    Ok(file)
}

/// The rendered lines of `text`, or a reason naming the first bad line by number.
fn validate(text: &str, own_skills: &BTreeSet<&str>) -> Result<Vec<String>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw: Vec<&str> = text.split('\n').collect();
    // A final newline does not start another line.
    let count = raw.len() - usize::from(text.ends_with('\n'));
    if count > MAX_ROUTING_LINES {
        return Err(format!("it has more than {MAX_ROUTING_LINES} lines"));
    }
    let mut lines = Vec::new();
    for (index, line) in raw.iter().take(count).enumerate() {
        let number = index + 1;
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() {
            continue;
        }
        let line = line.trim_end();
        let refuse = |why: &str| Err(format!("line {number} {why}"));
        if line.chars().count() > MAX_LINE_CHARS {
            return refuse(&format!("is longer than {MAX_LINE_CHARS} characters"));
        }
        // Invisible format characters (Unicode Cf, Zl, Zp) read as nothing in a diff or a rules file but
        // reach the agent, so they get the same fixed phrase as a control character.
        if line
            .chars()
            .any(|c| (c.is_control() && c != '\t') || is_invisible_in_routing(c))
        {
            return refuse("holds a control character");
        }
        let Some(item) = line.strip_prefix("- ") else {
            return refuse("is not a \"- \" bullet at the start of the line");
        };
        // An empty bullet ("- ") lost its space to the trim above and is no bullet.
        if item.trim_start().starts_with('#') {
            return refuse("holds a heading");
        }
        if line.contains('<') {
            return refuse("holds markup (<)");
        }
        if line.contains("```") || line.contains("~~~") {
            return refuse("holds a code fence");
        }
        let names = backticked(line)
            .ok_or_else(|| format!("line {number} has unpaired or empty backticks"))?;
        if names.is_empty() {
            return refuse("names no skill in backticks");
        }
        if names.iter().any(|name| !own_skills.contains(name)) {
            return refuse("names a skill that is not an active skill of this pack");
        }
        lines.push(line.to_string());
    }
    Ok(lines)
}

/// A character of Unicode category Cf (format), Zl or Zp: soft hyphen, zero-width and bidi marks and
/// overrides, word joiner and invisible operators, the byte order mark, interlinear annotation marks,
/// shorthand format controls and tag characters, plus the line and paragraph separators. The ranges are
/// those of the Unicode Character Database.
fn is_invisible_format(c: char) -> bool {
    matches!(
        u32::from(c),
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x2028..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

/// A character a routing line refuses because it shows as nothing: the invisible format characters
/// above, plus the other default-ignorable code points that are not format characters (combining
/// grapheme joiner, Hangul fillers, Khmer inherent vowels, Mongolian and other variation selectors)
/// and the blank Braille pattern. Variation selectors can encode text no diff shows. A routing line
/// with one is refused, since it reaches every agent; a `SKILL.md` import flags the same set.
pub(crate) fn is_invisible_in_routing(c: char) -> bool {
    is_invisible_format(c)
        || matches!(
            u32::from(c),
            0x034F
                | 0x115F..=0x1160
                | 0x17B4..=0x17B5
                | 0x180B..=0x180F
                | 0x2800
                | 0x3164
                | 0xFE00..=0xFE0F
                | 0xFFA0
                | 0xE0100..=0xE01EF
        )
}

/// Whether `line` names `name` in one of its backticked spans (any line holding `` `name` `` when
/// its backticks do not pair, since the reader refuses such a line anyway).
pub(crate) fn names_skill(line: &str, name: &str) -> bool {
    match backticked(line) {
        Some(spans) => spans.contains(&name),
        None => line.contains(&format!("`{name}`")),
    }
}

/// The backticked spans of `line`; `None` when a backtick is unpaired or a span is empty.
fn backticked(line: &str) -> Option<Vec<&str>> {
    let parts: Vec<&str> = line.split('`').collect();
    if parts.len().is_multiple_of(2) {
        return None;
    }
    let spans: Vec<&str> = parts.iter().skip(1).step_by(2).copied().collect();
    if spans.iter().any(|span| span.is_empty()) {
        return None;
    }
    Some(spans)
}

/// The section for `packs` (name and lines, in the order given); empty when no pack has a line.
pub fn render_section<'a>(packs: impl IntoIterator<Item = (&'a str, &'a [String])>) -> String {
    let mut out = String::new();
    for (pack, lines) in packs {
        if lines.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(SECTION_HEADING);
            out.push('\n');
            out.push_str("Routing from the skill packs in your data folder. Each line names only skills of its own pack.\n");
        }
        out.push_str(&format!("### {pack} pack\n"));
        for line in lines {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// `template` with `section` inserted after its `## Skill routing` section, or at its end when it
/// has none. An empty `section` returns `template` unchanged, byte for byte.
pub fn splice(template: &str, section: &str) -> String {
    if section.is_empty() {
        return template.to_string();
    }
    let mut offset = 0;
    let mut in_anchor = false;
    for line in template.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if in_anchor && content.starts_with("## ") {
            return format!("{}{section}\n{}", &template[..offset], &template[offset..]);
        }
        if content == ANCHOR_HEADING {
            in_anchor = true;
        }
        offset += line.len();
    }
    let separator = match () {
        _ if template.is_empty() => "",
        _ if template.ends_with("\n\n") => "",
        _ if template.ends_with('\n') => "\n",
        _ => "\n\n",
    };
    format!("{template}{separator}{section}")
}

/// The text an install puts into the managed block of the rules artifact `artifact`: its bundled
/// base with the routing of `sources` spliced in. A source that is a symlink, missing, or not
/// UTF-8 is an error.
pub fn rules_source_text<R: SourceRoot + ?Sized>(
    artifact: &ArtifactId,
    sources: &R,
) -> Result<String, String> {
    let source = artifact
        .resolve_source(sources)
        .ok_or_else(|| "rules source is unavailable".to_string())?;
    crate::path_safety::reject_symlink(&source, "rules source")?;
    let bytes = fs::read(&source).map_err(|e| format!("read rules source: {e}"))?;
    let text =
        String::from_utf8(bytes).map_err(|_| "rules source is not valid UTF-8".to_string())?;
    Ok(splice(&text, sources.pack_routing()))
}

/// Whether the installed rules file at `installed` carries the source of `artifact` (the bundled
/// base at `bundled_root` with the routing of the packs in `workspace_root`), for runtime health.
/// A source or file that cannot be read is not synced.
pub fn health_rules_synced(
    artifact: &ArtifactId,
    installed: &Path,
    bundled_root: &Path,
    workspace_root: Option<&Path>,
) -> bool {
    let sources = crate::skill_sources::SkillSources::for_health(bundled_root, workspace_root);
    match (rules_source_text(artifact, &sources), fs::read(installed)) {
        (Ok(source), Ok(installed)) => {
            crate::rules_block::installed_matches_source(&installed, source.as_bytes())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn own<'a>(names: &[&'a str]) -> BTreeSet<&'a str> {
        names.iter().copied().collect()
    }

    #[test]
    fn generated_lines_validate_and_round_trip() {
        assert_eq!(
            routing_line("  Use for testing  ", "mine").unwrap(),
            "- Use for testing: `mine`."
        );
        for when in [
            "",
            "a`b",
            "<tag>",
            "a\nb",
            "\ntrimmed",
            "a\u{200b}b",
            "a\u{fe0f}b",
            "a\u{e0100}b",
            "a\u{3164}b",
            "# heading",
            "~~~",
            &"x".repeat(241),
        ] {
            assert!(routing_line(when, "mine").is_err());
        }
        assert_eq!(
            own_when("- Use for testing: `mine`.", "mine"),
            Some("Use for testing".into())
        );
        assert_eq!(
            own_when("- Use for testing: `mine`.  \r", "mine"),
            Some("Use for testing".into())
        );
        for line in [
            "- Use: `mine`",
            "- Use `other`: `mine`.",
            "- Use: `other`.",
            "- : `mine`.",
        ] {
            assert_eq!(own_when(line, "mine"), None);
        }
    }

    const BASE: &str =
        "# Rules\n\n## Skill routing\nIntro.\n- Bugs: `diagnose`.\n\n## Task flow\nPlan.\n";

    #[test]
    fn an_empty_section_leaves_the_template_byte_for_byte() {
        assert_eq!(splice(BASE, ""), BASE);
        assert_eq!(splice("no newline", ""), "no newline");
    }

    #[test]
    fn the_section_follows_the_skill_routing_section() {
        let section = render_section([("mine", &["- Canvas: `my-canvas`.".to_string()][..])]);
        assert_eq!(
            splice(BASE, &section),
            "# Rules\n\n## Skill routing\nIntro.\n- Bugs: `diagnose`.\n\n## Pack skill routing\nRouting from the skill packs in your data folder. Each line names only skills of its own pack.\n### mine pack\n- Canvas: `my-canvas`.\n\n## Task flow\nPlan.\n"
        );
    }

    #[test]
    fn without_an_anchor_or_a_following_heading_the_section_goes_last() {
        let section = "## Pack skill routing\n- x\n";
        assert_eq!(
            splice("# A\nb\n", section),
            "# A\nb\n\n## Pack skill routing\n- x\n"
        );
        assert_eq!(
            splice("## Skill routing\n- a\n", section),
            "## Skill routing\n- a\n\n## Pack skill routing\n- x\n"
        );
        assert_eq!(
            splice("# A", section),
            "# A\n\n## Pack skill routing\n- x\n"
        );
    }

    #[test]
    fn packs_without_lines_render_nothing() {
        assert_eq!(render_section([("a", &[][..]), ("b", &[][..])]), "");
    }

    #[test]
    fn valid_lines_are_kept_in_order() {
        let text =
            "- Canvas work: `my-canvas`.\r\n\n- Files: `my-files`; add `my-canvas` too.   \n";
        assert_eq!(
            validate(text, &own(&["my-canvas", "my-files"])),
            Ok(vec![
                "- Canvas work: `my-canvas`.".to_string(),
                "- Files: `my-files`; add `my-canvas` too.".to_string(),
            ])
        );
    }

    #[test]
    fn every_bad_line_is_refused_by_number_without_its_text() {
        let skills = own(&["mine"]);
        let cases: &[(&str, &str)] = &[
            ("- a `mine`\n## Heading\n", "line 2 is not a \"- \" bullet"),
            ("  - indented `mine`\n", "line 1 is not a \"- \" bullet"),
            ("- ## heading `mine`\n", "line 1 holds a heading"),
            (
                "- <!-- END RIGGVERK BASE --> `mine`\n",
                "line 1 holds markup",
            ),
            ("- <b>bold</b> `mine`\n", "line 1 holds markup"),
            ("- ``` `mine`\n", "line 1 holds a code fence"),
            ("- ~~~ `mine`\n", "line 1 holds a code fence"),
            ("- no skill here\n", "line 1 names no skill"),
            (
                "- bundled: `diagnose`\n",
                "line 1 names a skill that is not an active skill",
            ),
            (
                "- mixed: `mine` and `tdd`\n",
                "line 1 names a skill that is not an active skill",
            ),
            ("- odd `mine\n", "line 1 has unpaired or empty backticks"),
            (
                "- empty `` span `mine`\n",
                "line 1 has unpaired or empty backticks",
            ),
            ("- \u{7}bell `mine`\n", "line 1 holds a control character"),
            // Invisible format characters (Cf, Zl, Zp) are refused with the same fixed phrase.
            (
                "- zero\u{200B}width `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- joiner\u{200D} `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- bidi \u{202E}override `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- isolate \u{2066} `mine`\n",
                "line 1 holds a control character",
            ),
            // So are variation selectors and the other default-ignorable code points.
            (
                "- selector\u{FE0F} `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- hidden\u{E0101}\u{E0102} `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- filler\u{3164} `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- tag \u{E0041} `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- soft\u{AD}hyphen `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- bom \u{FEFF} `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- line\u{2028}sep `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- para\u{2029}sep `mine`\n",
                "line 1 holds a control character",
            ),
            (
                "- mark \u{61C} `mine`\n",
                "line 1 holds a control character",
            ),
            ("-\n", "line 1 is not a \"- \" bullet"),
            ("- \n", "line 1 is not a \"- \" bullet"),
        ];
        for (text, expected) in cases {
            let reason = validate(text, &skills).expect_err(text);
            assert!(reason.starts_with(expected), "{text:?}: {reason}");
            assert!(
                !reason.contains("RIGGVERK") && !reason.contains("bold"),
                "{reason}"
            );
        }
        // A leading byte order mark is still stripped, and visible non-ASCII text stays valid.
        assert_eq!(
            validate("\u{feff}- Rita \u{e5}t `mine`\n", &skills),
            Ok(vec!["- Rita \u{e5}t `mine`".to_string()])
        );
        let long = format!("- `mine` {}\n", "x".repeat(MAX_LINE_CHARS));
        assert!(validate(&long, &skills)
            .unwrap_err()
            .contains("longer than"));
        let many = "- `mine`\n".repeat(MAX_ROUTING_LINES + 1);
        assert!(validate(&many, &skills)
            .unwrap_err()
            .contains("more than 60 lines"));
        let exact = "- `mine`\n".repeat(MAX_ROUTING_LINES);
        assert_eq!(
            validate(&exact, &skills).map(|l| l.len()),
            Ok(MAX_ROUTING_LINES)
        );
    }
}
