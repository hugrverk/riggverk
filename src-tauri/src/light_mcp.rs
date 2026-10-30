//! The managed Playwright entry in the MCP file of a light harness (Copilot, Pi, Kilo, Antigravity).
//!
//! The app owns one key of each file, `<root_key>.<entry_key>` (`mcpServers.playwright`,
//! `mcp.playwright`); everything else belongs to the user. The file is read and written as strict
//! JSON: a file the app cannot read that way is refused whole, with a plain reason and no write.
//! There is no JSONC parser and no comment-preserving writer, so a file with comments, a trailing
//! comma or a byte order mark is left alone even where the harness itself accepts it.
//!
//! A refusal never carries file text: the reasons are fixed phrases, and the content of the user's
//! other servers (which may hold tokens in `env` or `headers`) is neither scanned nor shown. Only
//! the bundled entry template is scanned for credentials.
//!
//! A write replaces the file with the user's keys in their order, the entry inserted or replaced,
//! two-space indentation and a final newline. Layout is not preserved, duplicate keys collapse to
//! the last one and numbers follow serde's formatting; the values are kept.

use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::light_harness::LightMcp;

/// The biggest MCP file the app reads. Real ones are a few lines.
pub const MAX_MCP_FILE_BYTES: u64 = 1024 * 1024;
/// The biggest entry template the app reads.
const MAX_TEMPLATE_BYTES: u64 = 64 * 1024;
/// Placeholders the app fills in; one left in the entry would be written literally.
const PLACEHOLDER_PREFIX: &str = "__PLAYWRIGHT_";

/// Why an MCP file is left alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotRegularFile,
    Unreadable,
    TooLarge,
    NotUtf8,
    ByteOrderMark,
    Comments,
    TrailingComma,
    NotJson,
    RootNotObject,
    KeyNotObject,
}

impl Refusal {
    /// A fixed phrase: it never contains text of the file.
    pub fn message(self) -> &'static str {
        match self {
            Refusal::NotRegularFile => "the file is not a regular file",
            Refusal::Unreadable => "the file cannot be read",
            Refusal::TooLarge => "the file is larger than 1 MiB",
            Refusal::NotUtf8 => "the file is not UTF-8 text",
            Refusal::ByteOrderMark => "the file starts with a byte order mark",
            Refusal::Comments => "the file has comments",
            Refusal::TrailingComma => "the file has a trailing comma",
            Refusal::NotJson => "the file is not valid JSON",
            Refusal::RootNotObject => "the top level of the file is not an object",
            Refusal::KeyNotObject => "the servers key of the file is not an object",
        }
    }
}

/// How the managed entry stands in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryState {
    /// There is no file.
    Absent,
    /// The file has no entry of the app's.
    EntryMissing,
    /// The file holds the managed entry as bundled.
    Equal,
    /// The file holds another entry under the managed key.
    Differs,
    /// The file is not one the app edits.
    Refused(Refusal),
}

impl EntryState {
    /// Why the entry is not written, for the states that leave a file alone; `None` otherwise.
    pub fn conflict_reason(self, entry_key: &str) -> Option<String> {
        match self {
            EntryState::Refused(refusal) => Some(format!(
                "{}; the app edits strict JSON only and writes nothing",
                refusal.message()
            )),
            EntryState::Differs => Some(format!(
                "an entry named {entry_key} already exists and differs from the managed one; rename or remove it to let the app manage the entry"
            )),
            EntryState::Absent | EntryState::EntryMissing | EntryState::Equal => None,
        }
    }
}

/// A parsed MCP file: its top-level object.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    root: Map<String, Value>,
}

impl Document {
    /// The entry the file holds under the managed key, if any.
    pub fn entry(&self, spec: &LightMcp) -> Option<&Value> {
        self.root
            .get(&spec.root_key)
            .and_then(Value::as_object)
            .and_then(|servers| servers.get(&spec.entry_key))
    }
}

/// Reads the MCP file at `path`: `Ok(None)` when there is none, a [`Refusal`] when there is one
/// the app does not edit. An empty (or whitespace-only) file counts as `{}`: it holds nothing of
/// the user's.
pub fn read(path: &Path, spec: &LightMcp) -> Result<Option<Document>, Refusal> {
    let Some(bytes) = read_bytes(path)? else {
        return Ok(None);
    };
    parse(&bytes, spec).map(Some)
}

/// Reads the strict JSON object at `path` under the same rules as an MCP file: `Ok(None)` when
/// there is no file, a [`Refusal`] for one the app does not edit, `{}` for an empty file. OpenCode's
/// `tui.json` is read this way too.
pub fn read_object(path: &Path) -> Result<Option<Map<String, Value>>, Refusal> {
    let Some(bytes) = read_bytes(path)? else {
        return Ok(None);
    };
    parse_object(&bytes).map(Some)
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, Refusal> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Refusal::Unreadable),
    };
    if !meta.is_file() {
        return Err(Refusal::NotRegularFile);
    }
    if meta.len() > MAX_MCP_FILE_BYTES {
        return Err(Refusal::TooLarge);
    }
    fs::read(path).map(Some).map_err(|_| Refusal::Unreadable)
}

fn parse(bytes: &[u8], spec: &LightMcp) -> Result<Document, Refusal> {
    let root = parse_object(bytes)?;
    if root
        .get(&spec.root_key)
        .is_some_and(|servers| !servers.is_object())
    {
        return Err(Refusal::KeyNotObject);
    }
    Ok(Document { root })
}

fn parse_object(bytes: &[u8]) -> Result<Map<String, Value>, Refusal> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(Refusal::ByteOrderMark);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Refusal::NotUtf8)?;
    if text
        .trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
        .is_empty()
    {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| classify_syntax_error(text))?;
    let Value::Object(root) = value else {
        return Err(Refusal::RootNotObject);
    };
    Ok(root)
}

/// Names what is wrong with text that is not strict JSON, only to say so plainly: comments first,
/// then a comma before a closing bracket, else just "not valid JSON".
fn classify_syntax_error(text: &str) -> Refusal {
    let bytes = text.as_bytes();
    let (mut in_string, mut after_comma, mut trailing) = (false, false, false);
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            match byte {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
        } else {
            match byte {
                b'"' => {
                    in_string = true;
                    after_comma = false;
                }
                b'/' if matches!(bytes.get(index + 1), Some(b'/' | b'*')) => {
                    return Refusal::Comments;
                }
                b',' => after_comma = true,
                b'}' | b']' => {
                    trailing |= after_comma;
                    after_comma = false;
                }
                b' ' | b'\t' | b'\n' | b'\r' => {}
                _ => after_comma = false,
            }
        }
        index += 1;
    }
    if trailing {
        Refusal::TrailingComma
    } else {
        Refusal::NotJson
    }
}

/// How the entry stands in the file at `path`, compared with the `expected` entry.
pub fn assess(spec: &LightMcp, path: &Path, expected: &Value) -> EntryState {
    match read(path, spec) {
        Err(refusal) => EntryState::Refused(refusal),
        Ok(None) => EntryState::Absent,
        Ok(Some(document)) => match document.entry(spec) {
            None => EntryState::EntryMissing,
            Some(entry) if entry == expected => EntryState::Equal,
            Some(_) => EntryState::Differs,
        },
    }
}

/// The Playwright version an entry pins (`@playwright/mcp@x.y.z` in `args` or `command`), for the
/// health. Only a version made of letters, digits, dots and dashes is returned.
pub fn pinned_version(entry: &Value) -> Option<String> {
    ["args", "command"]
        .iter()
        .filter_map(|key| entry.get(key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|argument| argument.strip_prefix("@playwright/mcp@"))
        .filter(|version| {
            !version.is_empty()
                && version.len() <= 32
                && version
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        })
        .map(str::to_string)
}

/// The entry the app writes: the bundled template with the Playwright browser folder filled in.
/// The template is scanned for credentials (it is the one text of the app's own that is written
/// into a file the user keeps secrets in) and must be an object.
pub fn expected_entry(spec: &LightMcp, bundled_root: &Path, home: &Path) -> Result<Value, String> {
    let path = bundled_root.join(&spec.template_rel);
    let meta = fs::symlink_metadata(&path).map_err(|e| format!("MCP entry template: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_TEMPLATE_BYTES {
        return Err("MCP entry template is not a small regular file".to_string());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read MCP entry template: {e}"))?;
    if crate::commands::cursor_profile::json_has_unsafe_literals(&text) {
        return Err("MCP entry template contains auth-like literals".to_string());
    }
    let template: Value =
        serde_json::from_str(&text).map_err(|e| format!("MCP entry template invalid JSON: {e}"))?;
    if !template.is_object() {
        return Err("MCP entry template must be an object".to_string());
    }
    let browsers = crate::commands::cursor_profile::resolve_playwright_browsers_path(home)
        .ok_or_else(|| "cannot resolve PLAYWRIGHT_BROWSERS_PATH".to_string())?;
    // The entry has no sidecar flag: the browser is chosen with inline flags.
    let entry = crate::commands::cursor_profile::transform_playwright_template_value(
        &template,
        "",
        &browsers.to_string_lossy(),
    );
    if entry.to_string().contains(PLACEHOLDER_PREFIX) {
        return Err("MCP entry template has a placeholder the app does not fill".to_string());
    }
    Ok(entry)
}

/// The file content with `entry` inserted or replaced under the managed key. `document` is the
/// file as read (`None` for a file to create).
pub fn render(spec: &LightMcp, document: Option<Document>, entry: Value) -> Result<String, String> {
    let mut root = document.map(|document| document.root).unwrap_or_default();
    let servers = root
        .entry(spec.root_key.clone())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(servers) = servers else {
        // `read` refuses such a file.
        return Err(Refusal::KeyNotObject.message().to_string());
    };
    servers.insert(spec.entry_key.clone(), entry);
    serde_json::to_string_pretty(&Value::Object(root))
        .map(|text| text + "\n")
        .map_err(|e| format!("serialize MCP file: {e}"))
}

/// The installed file with the managed entry put back as `backup` had it, or taken out again when
/// `backup` had none (the apply added it). Everything else in the installed file stays. An
/// installed file that no longer reads as strict JSON is an error: it is not touched.
pub fn render_restored(spec: &LightMcp, installed: &Path, backup: &Path) -> Result<String, String> {
    let current = read(installed, spec)
        .map_err(|refusal| {
            format!(
                "installed MCP file cannot be restored: {}",
                refusal.message()
            )
        })?
        .ok_or_else(|| "installed MCP file is missing".to_string())?;
    let previous = read(backup, spec)
        .map_err(|refusal| format!("backup of the MCP file is unusable: {}", refusal.message()))?
        .ok_or_else(|| "backup of the MCP file is missing".to_string())?;
    match previous.entry(spec).cloned() {
        Some(entry) => render(spec, Some(current), entry),
        None => {
            let mut root = current.root;
            if let Some(Value::Object(servers)) = root.get_mut(&spec.root_key) {
                servers.shift_remove(&spec.entry_key);
                // A servers key the apply created goes with its only entry.
                if servers.is_empty() && !previous.root.contains_key(&spec.root_key) {
                    root.shift_remove(&spec.root_key);
                }
            }
            serde_json::to_string_pretty(&Value::Object(root))
                .map(|text| text + "\n")
                .map_err(|e| format!("serialize MCP file: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_targets::HarnessId;

    fn spec(harness: HarnessId) -> &'static LightMcp {
        &crate::light_harness::descriptor(harness)
            .expect("light harness")
            .mcp
    }

    fn doc(harness: HarnessId, text: &str) -> Result<Document, Refusal> {
        parse(text.as_bytes(), spec(harness))
    }

    #[test]
    fn strict_json_objects_are_read_and_the_rest_is_refused_with_a_plain_reason() {
        let copilot = HarnessId::Copilot;
        assert!(doc(copilot, "{}").is_ok());
        assert!(
            doc(copilot, "  \n\t ").is_ok(),
            "an empty file holds nothing"
        );
        assert!(doc(copilot, r#"{"mcpServers":{}}"#).is_ok());
        assert!(doc(copilot, r#"{"theme":"dark","mcpServers":{"a":{}}}"#).is_ok());
        for (text, refusal) in [
            ("// c\n{}", Refusal::Comments),
            ("{/* c */}", Refusal::Comments),
            (
                r#"{"a": 1 // c
}"#,
                Refusal::Comments,
            ),
            (r#"{"a": 1,}"#, Refusal::TrailingComma),
            (r#"{"a": [1,]}"#, Refusal::TrailingComma),
            (r#"{"a": 1"#, Refusal::NotJson),
            ("not json", Refusal::NotJson),
            ("[]", Refusal::RootNotObject),
            ("null", Refusal::RootNotObject),
            ("1", Refusal::RootNotObject),
            (r#"{"mcpServers":[]}"#, Refusal::KeyNotObject),
            (r#"{"mcpServers":null}"#, Refusal::KeyNotObject),
            (r#"{"mcpServers":"x"}"#, Refusal::KeyNotObject),
        ] {
            assert_eq!(doc(copilot, text).unwrap_err(), refusal, "{text}");
        }
        // `//` and a comma before a bracket inside a string are text, not syntax.
        assert!(doc(copilot, r#"{"url":"http://x/a,]","b":"/* x */"}"#).is_ok());
        assert_eq!(
            parse(b"\xEF\xBB\xBF{}", spec(copilot)).unwrap_err(),
            Refusal::ByteOrderMark
        );
        assert_eq!(
            parse(b"{\"a\":\"\xFF\"}", spec(copilot)).unwrap_err(),
            Refusal::NotUtf8
        );
    }

    #[test]
    fn the_servers_key_is_the_one_the_descriptor_names() {
        assert!(doc(HarnessId::Kilo, r#"{"mcpServers":[]}"#).is_ok());
        assert_eq!(
            doc(HarnessId::Kilo, r#"{"mcp":[]}"#).unwrap_err(),
            Refusal::KeyNotObject
        );
    }

    #[test]
    fn a_refusal_names_no_file_text() {
        let secret = "sk-live-not-a-real-secret";
        for text in [
            format!("// {secret}\n{{}}"),
            format!(r#"{{"token":"{secret}",}}"#),
            format!(r#"{{"token":"{secret}""#),
            format!(r#"["{secret}"]"#),
        ] {
            let refusal = doc(HarnessId::Pi, &text).unwrap_err();
            assert!(!refusal.message().contains(secret), "{text}");
            let reason = EntryState::Refused(refusal)
                .conflict_reason("playwright")
                .unwrap();
            assert!(
                !reason.contains(secret) && !reason.contains("token"),
                "{reason}"
            );
        }
    }

    #[test]
    fn rendering_inserts_only_the_entry_and_keeps_the_users_keys_in_order() {
        let pi = spec(HarnessId::Pi);
        let existing = doc(
            HarnessId::Pi,
            r#"{"zeta":1,"mcpServers":{"b":{"env":{"TOKEN":"abc"}},"playwright":{"old":true},"a":{}},"alpha":[1,2]}"#,
        )
        .unwrap();
        let entry = serde_json::json!({"command": "npx"});
        let rendered = render(pi, Some(existing), entry.clone()).unwrap();
        let parsed: Value = serde_json::from_str(&rendered).unwrap();
        let keys: Vec<&String> = parsed.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["zeta", "mcpServers", "alpha"]);
        let servers: Vec<&String> = parsed["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(
            servers,
            ["b", "playwright", "a"],
            "the entry keeps its place"
        );
        assert_eq!(parsed["mcpServers"]["playwright"], entry);
        assert_eq!(parsed["mcpServers"]["b"]["env"]["TOKEN"], "abc");
        assert!(rendered.ends_with("}\n") && rendered.contains("\n  \"zeta\": 1,"));

        let created = render(pi, None, entry.clone()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&created).unwrap(),
            serde_json::json!({"mcpServers": {"playwright": entry}})
        );
    }

    #[test]
    fn a_restore_puts_the_entry_back_or_takes_the_added_one_out() {
        let dir = std::env::temp_dir().join(format!(
            "aw-light-mcp-restore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let kilo = spec(HarnessId::Kilo);
        let installed = dir.join("installed.json");
        let backup = dir.join("backup.json");

        // The apply added the entry to a file with other servers; a later edit stays.
        fs::write(&backup, r#"{"mcp":{"mine":{"a":1}}}"#).unwrap();
        fs::write(
            &installed,
            r#"{"mcp":{"mine":{"a":1},"playwright":{"new":1}},"later":true}"#,
        )
        .unwrap();
        let restored: Value =
            serde_json::from_str(&render_restored(kilo, &installed, &backup).unwrap()).unwrap();
        assert_eq!(
            restored,
            serde_json::json!({"mcp":{"mine":{"a":1}},"later":true})
        );

        // The apply created the servers key: it goes with the entry.
        fs::write(&backup, r#"{"theme":"dark"}"#).unwrap();
        fs::write(
            &installed,
            r#"{"theme":"dark","mcp":{"playwright":{"new":1}}}"#,
        )
        .unwrap();
        let restored: Value =
            serde_json::from_str(&render_restored(kilo, &installed, &backup).unwrap()).unwrap();
        assert_eq!(restored, serde_json::json!({"theme":"dark"}));

        // The apply replaced an entry: the old one returns.
        fs::write(&backup, r#"{"mcp":{"playwright":{"old":1}}}"#).unwrap();
        fs::write(&installed, r#"{"mcp":{"playwright":{"new":1}}}"#).unwrap();
        let restored: Value =
            serde_json::from_str(&render_restored(kilo, &installed, &backup).unwrap()).unwrap();
        assert_eq!(
            restored,
            serde_json::json!({"mcp":{"playwright":{"old":1}}})
        );

        // An installed file that no longer reads is not touched.
        fs::write(&installed, "// edited by hand\n{}").unwrap();
        let error = render_restored(kilo, &installed, &backup).unwrap_err();
        assert!(
            error.contains("comments") && !error.contains("edited"),
            "{error}"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
