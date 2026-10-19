//! JSONC as OpenCode reads its config files: JSON plus `//` and `/* */` comments, trailing commas
//! and a leading byte order mark. Used only to read and compare, never to write: a file that needs
//! any of these is not strict JSON, and the app writes strict JSON only.
//!
//! The comments and commas are blanked out and the rest goes to `serde_json`, so key order and
//! values are exactly what a strict parse of the same file without them gives. A parse failure
//! carries nothing of the text.

use serde_json::Value;

/// A parsed JSONC text and what in it is not strict JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub value: Value,
    pub comments: bool,
    pub trailing_commas: bool,
    pub byte_order_mark: bool,
}

impl Parsed {
    /// The text is strict JSON: `serde_json` alone reads it.
    pub fn is_strict(&self) -> bool {
        !(self.comments || self.trailing_commas || self.byte_order_mark)
    }
}

/// Parses `text` as JSONC; `None` when it is not valid JSONC (an unterminated comment included).
pub fn parse(text: &str) -> Option<Parsed> {
    let (text, byte_order_mark) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (rest, true),
        None => (text, false),
    };
    let (without_comments, comments) = blank_comments(text)?;
    let (json, trailing_commas) = drop_trailing_commas(&without_comments);
    let value = serde_json::from_str(&json).ok()?;
    Some(Parsed {
        value,
        comments,
        trailing_commas,
        byte_order_mark,
    })
}

/// `text` with every comment outside a string replaced by spaces (newlines kept), and whether
/// there was one. `None` for a block comment that is never closed.
fn blank_comments(text: &str) -> Option<(String, bool)> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut found = false;
    let mut in_string = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte);
            match byte {
                b'\\' if index + 1 < bytes.len() => {
                    out.push(bytes[index + 1]);
                    index += 1;
                }
                b'"' => in_string = false,
                _ => {}
            }
            index += 1;
            continue;
        }
        match (byte, bytes.get(index + 1)) {
            (b'"', _) => {
                in_string = true;
                out.push(byte);
                index += 1;
            }
            (b'/', Some(b'/')) => {
                found = true;
                while index < bytes.len() && bytes[index] != b'\n' {
                    out.push(if bytes[index] == b'\r' { b'\r' } else { b' ' });
                    index += 1;
                }
            }
            (b'/', Some(b'*')) => {
                found = true;
                let end = text[index + 2..].find("*/")? + index + 2 + 2;
                out.extend(bytes[index..end].iter().map(|&b| match b {
                    b'\n' | b'\r' => b,
                    _ => b' ',
                }));
                index = end;
            }
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }
    // Only ASCII bytes outside strings were replaced, by ASCII spaces: the text stays UTF-8.
    String::from_utf8(out).ok().map(|text| (text, found))
}

/// `text` (already without comments) with each comma that directly precedes a closing bracket
/// and follows a value removed, and whether there was one. Any other stray comma is left for the
/// JSON parser to reject.
fn drop_trailing_commas(text: &str) -> (String, bool) {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut found = false;
    let mut in_string = false;
    // The last byte outside whitespace that was written, to tell `[1,]` from `[,]`.
    let mut last_significant: Option<u8> = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte);
            match byte {
                b'\\' if index + 1 < bytes.len() => {
                    out.push(bytes[index + 1]);
                    index += 1;
                }
                b'"' => {
                    in_string = false;
                    last_significant = Some(b'"');
                }
                _ => {}
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                out.push(byte);
            }
            b',' => {
                let next = bytes[index + 1..]
                    .iter()
                    .find(|b| !b.is_ascii_whitespace())
                    .copied();
                let after_value = last_significant
                    .is_some_and(|previous| !matches!(previous, b',' | b'[' | b'{' | b':'));
                if matches!(next, Some(b'}' | b']')) && after_value {
                    found = true;
                    out.push(b' ');
                } else {
                    out.push(byte);
                    last_significant = Some(byte);
                }
            }
            _ => {
                out.push(byte);
                if !byte.is_ascii_whitespace() {
                    last_significant = Some(byte);
                }
            }
        }
        index += 1;
    }
    // Only an ASCII comma outside strings was replaced: the text stays UTF-8.
    (String::from_utf8(out).unwrap_or_default(), found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_json_is_read_as_is_and_counts_as_strict() {
        let parsed = parse(r#"{"b": [1, 2], "a": {"x": "y"}}"#).unwrap();
        assert!(parsed.is_strict());
        assert_eq!(parsed.value, json!({"b": [1, 2], "a": {"x": "y"}}));
        let keys: Vec<_> = parsed.value.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["b", "a"], "key order is kept");
    }

    #[test]
    fn line_and_block_comments_are_ignored_and_reported() {
        let text = "// head\n{\n  /* model */ \"model\": \"a/b\", // tail\n  \"n\": 1 /* multi\n line */\n}\n";
        let parsed = parse(text).unwrap();
        assert!(parsed.comments && !parsed.trailing_commas && !parsed.is_strict());
        assert_eq!(parsed.value, json!({"model": "a/b", "n": 1}));
    }

    #[test]
    fn comment_markers_and_commas_inside_strings_are_text() {
        let text = r#"{"url": "https://x.test/a", "glob": "/* not a comment */", "q": "say \"// hi\",]", "c": ",}"}"#;
        let parsed = parse(text).unwrap();
        assert!(parsed.is_strict());
        assert_eq!(parsed.value["url"], "https://x.test/a");
        assert_eq!(parsed.value["glob"], "/* not a comment */");
        assert_eq!(parsed.value["q"], "say \"// hi\",]");
        assert_eq!(parsed.value["c"], ",}");
    }

    #[test]
    fn trailing_commas_in_objects_and_arrays_are_dropped_and_reported() {
        let text = "{\"a\": [1, 2,], \"b\": {\"c\": true, /* x */ },\n}";
        let parsed = parse(text).unwrap();
        assert!(parsed.trailing_commas && parsed.comments);
        assert_eq!(parsed.value, json!({"a": [1, 2], "b": {"c": true}}));

        let only_commas = parse("{\"a\": 1,}").unwrap();
        assert!(only_commas.trailing_commas && !only_commas.comments);
    }

    #[test]
    fn a_leading_byte_order_mark_is_tolerated_and_reported() {
        let parsed = parse("\u{feff}{\"a\": 1}").unwrap();
        assert!(parsed.byte_order_mark && !parsed.is_strict());
        assert_eq!(parsed.value, json!({"a": 1}));
    }

    #[test]
    fn text_that_is_not_jsonc_is_refused() {
        for text in [
            "{\"a\": 1 /* never closed",
            "{\"a\": }",
            "[,]",
            "{,}",
            "[1,,2]",
            "{\"a\": 1",
            "not json",
            "",
        ] {
            assert!(parse(text).is_none(), "{text:?} must not parse");
        }
    }

    #[test]
    fn non_ascii_text_survives_blanking() {
        let parsed = parse("{\"name\": \"räksmörgås ✓\", // kommentar ✓\n}").unwrap();
        assert_eq!(parsed.value["name"], "räksmörgås ✓");
    }
}
