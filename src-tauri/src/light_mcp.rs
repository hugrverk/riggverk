//! The managed Playwright entry in the MCP file of a light harness (GitHub Copilot, Pi, Kilo,
//! Antigravity, Grok Build).
//!
//! The app owns one key of each file, `<root_key>.<entry_key>` (`mcpServers.playwright`,
//! `mcp.playwright`, `mcp_servers.playwright`); everything else belongs to the user.
//!
//! A JSON file is read and written as strict JSON: a file the app cannot read that way is refused
//! whole, with a plain reason and no write. There is no JSONC parser and no comment-preserving
//! writer, so a file with comments, a trailing comma or a byte order mark is left alone even where
//! the harness itself accepts it. A write replaces the file with the user's keys in their order,
//! the entry inserted or replaced, two-space indentation and a final newline. Layout is not
//! preserved, duplicate keys collapse to the last one and numbers follow serde's formatting; the
//! values are kept.
//!
//! A TOML file (Grok Build's `config.toml`, which may hold `api_key`) is edited in place with
//! `toml_edit`: only the `[<root_key>.<entry_key>]` table changes, and every other byte (comments,
//! blank lines, key order, quoting) stays as it was. A file `toml_edit` cannot print back exactly
//! as read (beyond a missing final newline), or one that lays out the servers or the entry as an
//! inline table or with dotted keys, is refused whole like a JSON file the app cannot read.
//!
//! A refusal never carries file text: the reasons are fixed phrases, and the content of the user's
//! other servers (which may hold tokens in `env` or `headers`) is neither scanned nor shown. Only
//! the bundled entry template is scanned for credentials.

use std::fs;
use std::path::Path;

use serde_json::{Map, Value};

use crate::light_harness::{LightMcp, McpFormat};

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
    NotToml,
    KeyNotTable,
    /// TOML the app cannot edit without changing bytes outside the managed table.
    TomlLayout,
}

impl Refusal {
    /// A fixed phrase: it never contains text of the file.
    pub fn message(self) -> &'static str {
        match self {
            Refusal::NotToml => "the file is not valid TOML",
            Refusal::KeyNotTable => "the servers key of the file is not a table",
            Refusal::TomlLayout => {
                "the file uses a TOML layout the app cannot edit without changing other lines (inline or dotted servers, or line endings it would rewrite)"
            }
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
    pub fn conflict_reason(self, entry_key: &str, format: McpFormat) -> Option<String> {
        let edits = match format {
            McpFormat::Json => "strict JSON",
            McpFormat::Toml => "plain TOML tables",
        };
        match self {
            EntryState::Refused(refusal) => Some(format!(
                "{}; the app edits {edits} only and writes nothing",
                refusal.message()
            )),
            EntryState::Differs => Some(format!(
                "an entry named {entry_key} already exists and differs from the managed one; rename or remove it to let the app manage the entry"
            )),
            EntryState::Absent | EntryState::EntryMissing | EntryState::Equal => None,
        }
    }
}

/// A parsed MCP file.
#[derive(Debug, Clone)]
pub struct Document {
    inner: Inner,
}

#[derive(Debug, Clone)]
enum Inner {
    /// The top-level object of a JSON file.
    Json(Map<String, Value>),
    /// A TOML file as `toml_edit` read it, and the managed entry as JSON (to compare with the
    /// template).
    Toml {
        doc: toml_edit::DocumentMut,
        entry: Option<Value>,
    },
}

impl Document {
    /// The entry the file holds under the managed key, if any.
    pub fn entry(&self, spec: &LightMcp) -> Option<&Value> {
        match &self.inner {
            Inner::Json(root) => root
                .get(&spec.root_key)
                .and_then(Value::as_object)
                .and_then(|servers| servers.get(&spec.entry_key)),
            Inner::Toml { entry, .. } => entry.as_ref(),
        }
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
    if spec.format == McpFormat::Toml {
        return toml_file::parse(bytes, spec);
    }
    let root = parse_object(bytes)?;
    if root
        .get(&spec.root_key)
        .is_some_and(|servers| !servers.is_object())
    {
        return Err(Refusal::KeyNotObject);
    }
    Ok(Document {
        inner: Inner::Json(root),
    })
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
    if spec.format == McpFormat::Toml {
        return toml_file::render(spec, document, &entry);
    }
    let mut root = match document.map(|document| document.inner) {
        None => Map::new(),
        Some(Inner::Json(root)) => root,
        Some(Inner::Toml { .. }) => return Err("the MCP file was read in another format".into()),
    };
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
    let (mut root, previous_root) = match (current.inner, previous.inner) {
        (Inner::Json(root), Inner::Json(previous_root)) => (root, previous_root),
        (Inner::Toml { doc, .. }, Inner::Toml { doc: backup, .. }) => {
            return Ok(toml_file::restore(spec, doc, &backup));
        }
        _ => return Err("the MCP file and its backup differ in format".to_string()),
    };
    match previous_root
        .get(&spec.root_key)
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(&spec.entry_key))
        .cloned()
    {
        Some(entry) => render(
            spec,
            Some(Document {
                inner: Inner::Json(root),
            }),
            entry,
        ),
        None => {
            if let Some(Value::Object(servers)) = root.get_mut(&spec.root_key) {
                servers.shift_remove(&spec.entry_key);
                // A servers key the apply created goes with its only entry.
                if servers.is_empty() && !previous_root.contains_key(&spec.root_key) {
                    root.shift_remove(&spec.root_key);
                }
            }
            serde_json::to_string_pretty(&Value::Object(root))
                .map(|text| text + "\n")
                .map_err(|e| format!("serialize MCP file: {e}"))
        }
    }
}

/// A TOML MCP file (Grok Build's `config.toml`), edited in place.
mod toml_file {
    use serde_json::{Map, Number, Value};
    use toml_edit::{Array, DocumentMut, InlineTable, Item, Table};

    use super::{Document, Inner, Refusal};
    use crate::light_harness::LightMcp;

    /// Reads a TOML MCP file. Refused: text that is not TOML, text `toml_edit` does not print
    /// back byte for byte (a missing final newline is the one difference let through: the next
    /// write adds it), a servers key that is not a table, and servers or an entry laid out as an
    /// inline table, with dotted keys or as an array of tables, which the app would have to
    /// rewrite around the entry.
    pub(super) fn parse(bytes: &[u8], spec: &LightMcp) -> Result<Document, Refusal> {
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Err(Refusal::ByteOrderMark);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| Refusal::NotUtf8)?;
        let doc: DocumentMut = text.parse().map_err(|_| Refusal::NotToml)?;
        let printed = doc.to_string();
        let same =
            printed == text || (!text.ends_with('\n') && printed.strip_suffix('\n') == Some(text));
        if !same {
            return Err(Refusal::TomlLayout);
        }
        let entry = match doc.get(&spec.root_key) {
            None => None,
            Some(Item::Table(servers)) if !servers.is_dotted() => {
                match servers.get(&spec.entry_key) {
                    None => None,
                    Some(Item::Table(table)) if !table.is_dotted() => Some(table_to_json(table)),
                    Some(Item::Value(value)) if value.as_inline_table().is_none() => {
                        Some(value_to_json(value))
                    }
                    Some(_) => return Err(Refusal::TomlLayout),
                }
            }
            Some(Item::Table(_) | Item::Value(toml_edit::Value::InlineTable(_))) => {
                return Err(Refusal::TomlLayout)
            }
            Some(_) => return Err(Refusal::KeyNotTable),
        };
        Ok(Document {
            inner: Inner::Toml { doc, entry },
        })
    }

    fn table_to_json(table: &Table) -> Value {
        let mut object = Map::new();
        for (key, item) in table.iter() {
            let value = match item {
                Item::None => continue,
                Item::Value(value) => value_to_json(value),
                Item::Table(table) => table_to_json(table),
                Item::ArrayOfTables(tables) => {
                    Value::Array(tables.iter().map(table_to_json).collect())
                }
            };
            object.insert(key.to_string(), value);
        }
        Value::Object(object)
    }

    fn value_to_json(value: &toml_edit::Value) -> Value {
        match value {
            toml_edit::Value::String(text) => Value::String(text.value().clone()),
            toml_edit::Value::Integer(number) => Value::from(*number.value()),
            toml_edit::Value::Float(number) => {
                Number::from_f64(*number.value()).map_or(Value::Null, Value::Number)
            }
            toml_edit::Value::Boolean(flag) => Value::Bool(*flag.value()),
            toml_edit::Value::Datetime(when) => Value::String(when.value().to_string()),
            toml_edit::Value::Array(items) => {
                Value::Array(items.iter().map(value_to_json).collect())
            }
            toml_edit::Value::InlineTable(table) => Value::Object(
                table
                    .iter()
                    .map(|(key, value)| (key.to_string(), value_to_json(value)))
                    .collect(),
            ),
        }
    }

    fn json_to_value(value: &Value) -> Result<toml_edit::Value, String> {
        Ok(match value {
            Value::Null => {
                return Err("MCP entry template has a null, which TOML cannot hold".into())
            }
            Value::Bool(flag) => (*flag).into(),
            Value::Number(number) => match (number.as_i64(), number.as_f64()) {
                (Some(integer), _) => integer.into(),
                (None, Some(float)) => float.into(),
                _ => return Err("MCP entry template has a number TOML cannot hold".into()),
            },
            Value::String(text) => text.as_str().into(),
            Value::Array(items) => {
                let mut array = Array::new();
                for item in items {
                    array.push(json_to_value(item)?);
                }
                toml_edit::Value::Array(array)
            }
            Value::Object(object) => {
                let mut table = InlineTable::new();
                for (key, item) in object {
                    table.insert(key, json_to_value(item)?);
                }
                toml_edit::Value::InlineTable(table)
            }
        })
    }

    /// The entry as a standard table: one `key = value` line per field, nested objects inline.
    fn entry_table(entry: &Value) -> Result<Table, String> {
        let Value::Object(object) = entry else {
            return Err("MCP entry template must be an object".into());
        };
        let mut table = Table::new();
        for (key, value) in object {
            table.insert(key, Item::Value(json_to_value(value)?));
        }
        Ok(table)
    }

    /// The servers table of `doc`, created (implicit: no header line of its own) when missing.
    fn servers_mut<'d>(doc: &'d mut DocumentMut, spec: &LightMcp) -> Option<&'d mut Table> {
        let root = doc.as_table_mut();
        if root.get(&spec.root_key).is_none() {
            let mut servers = Table::new();
            servers.set_implicit(true);
            root.insert(&spec.root_key, Item::Table(servers));
        }
        root.get_mut(&spec.root_key).and_then(Item::as_table_mut)
    }

    /// The file with `entry` as the managed table. A table that is already there keeps its place
    /// and the comment lines above its header; nothing else of the file changes.
    pub(super) fn render(
        spec: &LightMcp,
        document: Option<Document>,
        entry: &Value,
    ) -> Result<String, String> {
        let mut doc = match document.map(|document| document.inner) {
            None => DocumentMut::new(),
            Some(Inner::Toml { doc, .. }) => doc,
            Some(Inner::Json(_)) => return Err("the MCP file was read in another format".into()),
        };
        let mut table = entry_table(entry)?;
        let servers = servers_mut(&mut doc, spec)
            .ok_or_else(|| Refusal::KeyNotTable.message().to_string())?;
        if let Some(Item::Table(old)) = servers.get(&spec.entry_key) {
            table.set_position(old.position());
            *table.decor_mut() = old.decor().clone();
        }
        servers.insert(&spec.entry_key, Item::Table(table));
        Ok(doc.to_string())
    }

    /// `doc` with the managed table put back as `backup` had it (its own lines, as written), or
    /// taken out again when `backup` had none, with a servers table the apply created.
    pub(super) fn restore(spec: &LightMcp, mut doc: DocumentMut, backup: &DocumentMut) -> String {
        let previous = backup
            .get(&spec.root_key)
            .and_then(Item::as_table)
            .and_then(|servers| servers.get(&spec.entry_key))
            .cloned();
        match previous {
            Some(mut item) => {
                if let Some(servers) = servers_mut(&mut doc, spec) {
                    if let (Some(Item::Table(current)), Item::Table(table)) =
                        (servers.get(&spec.entry_key), &mut item)
                    {
                        table.set_position(current.position());
                    }
                    servers.insert(&spec.entry_key, item);
                }
            }
            None => {
                let had_servers = backup.contains_key(&spec.root_key);
                let root = doc.as_table_mut();
                if let Some(Item::Table(servers)) = root.get_mut(&spec.root_key) {
                    servers.remove(&spec.entry_key);
                    if servers.is_empty() && !had_servers {
                        root.remove(&spec.root_key);
                    }
                }
            }
        }
        doc.to_string()
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
                .conflict_reason("playwright", McpFormat::Json)
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

    // ── TOML (Grok Build's config.toml) ──

    const SECRET: &str = "sk-live-not-a-real-secret";

    /// A config of the user's: a key with a secret, comments of every kind, odd spacing and
    /// quoting, another server, and a table after the servers.
    fn grok_user_file() -> String {
        format!(
            "# Grok Build settings\napi_key = \"{SECRET}\"   # my key\n\n[models]\ndefault   =  'grok-4'\n\n# servers I use\n[mcp_servers.my-private-server]\ncommand = \"npx\"\nargs = [ \"-y\",  \"private\" ]\nenv = {{ TOKEN = \"{SECRET}\" }}\n\n[telemetry]\nevents_api_key = '{SECRET}'\n# trailing comment\n"
        )
    }

    fn grok() -> &'static LightMcp {
        spec(HarnessId::Grok)
    }

    fn entry() -> Value {
        serde_json::json!({
            "command": "npx",
            "args": ["-y", "@playwright/mcp@0.0.83"],
            "env": {"PLAYWRIGHT_BROWSERS_PATH": "/browsers"},
        })
    }

    /// The text of `[mcp_servers.playwright]` in `text`: from the blank line before its header to
    /// the line ending of its last line (the blank line after it belongs to the next table).
    fn managed_block(text: &str) -> &str {
        let start = text
            .find("\n[mcp_servers.playwright]")
            .expect("managed header");
        let after = start + 1;
        let end = text[after..]
            .find("\n[")
            .map_or(text.len(), |offset| after + offset);
        &text[start..end]
    }

    #[test]
    fn a_toml_entry_is_added_as_one_table_and_every_other_byte_stays() {
        let before = grok_user_file();
        let document = doc(HarnessId::Grok, &before).unwrap();
        assert_eq!(document.entry(grok()), None);
        let after = render(grok(), Some(document), entry()).unwrap();
        let block = managed_block(&after);
        assert_eq!(
            block,
            "\n[mcp_servers.playwright]\ncommand = \"npx\"\nargs = [\"-y\", \"@playwright/mcp@0.0.83\"]\nenv = { PLAYWRIGHT_BROWSERS_PATH = \"/browsers\" }\n"
        );
        assert_eq!(
            after.replacen(block, "", 1),
            before,
            "only the table is new"
        );
        // The entry sits with the other servers, before the next table.
        assert!(after.find(block).unwrap() < after.find("[telemetry]").unwrap());
        let reread = doc(HarnessId::Grok, &after).unwrap();
        assert_eq!(reread.entry(grok()), Some(&entry()));
        assert_eq!(
            assess_text(&after),
            EntryState::Equal,
            "the written entry reads back as current"
        );
    }

    fn assess_text(text: &str) -> EntryState {
        match doc(HarnessId::Grok, text) {
            Err(refusal) => EntryState::Refused(refusal),
            Ok(document) => match document.entry(grok()) {
                None => EntryState::EntryMissing,
                Some(found) if *found == entry() => EntryState::Equal,
                Some(_) => EntryState::Differs,
            },
        }
    }

    #[test]
    fn a_new_or_empty_toml_file_gets_only_the_table() {
        let created = render(grok(), None, entry()).unwrap();
        assert!(created.starts_with("[mcp_servers.playwright]\ncommand = \"npx\"\n"));
        assert_eq!(assess_text(&created), EntryState::Equal);
        assert_eq!(
            render(grok(), Some(doc(HarnessId::Grok, "").unwrap()), entry()).unwrap(),
            created
        );
        // Root keys only, and no final newline: the one byte the write adds is that newline.
        let after = render(
            grok(),
            Some(doc(HarnessId::Grok, "a = 1").unwrap()),
            entry(),
        )
        .unwrap();
        assert!(
            after.starts_with("a = 1\n\n[mcp_servers.playwright]\n"),
            "{after}"
        );
    }

    #[test]
    fn a_toml_entry_that_exists_is_replaced_in_place_with_the_comment_above_it() {
        let before = "x = 1\n\n# managed by Riggverk\n[mcp_servers.playwright]\ncommand = \"old\"\n\n[mcp_servers.other]\ncommand = \"o\"\n";
        assert_eq!(assess_text(before), EntryState::Differs);
        let after = render(grok(), Some(doc(HarnessId::Grok, before).unwrap()), entry()).unwrap();
        assert!(
            after.starts_with(
                "x = 1\n\n# managed by Riggverk\n[mcp_servers.playwright]\ncommand = \"npx\"\n"
            ),
            "{after}"
        );
        assert!(
            after.ends_with("\n[mcp_servers.other]\ncommand = \"o\"\n"),
            "{after}"
        );
        // An entry with its env as a sub-table reads like the inline one.
        let split = "[mcp_servers.playwright]\ncommand = \"npx\"\nargs = [\"-y\", \"@playwright/mcp@0.0.83\"]\n\n[mcp_servers.playwright.env]\nPLAYWRIGHT_BROWSERS_PATH = \"/browsers\"\n";
        assert_eq!(assess_text(split), EntryState::Equal);
        let rewritten =
            render(grok(), Some(doc(HarnessId::Grok, split).unwrap()), entry()).unwrap();
        assert!(
            !rewritten.contains("[mcp_servers.playwright.env]"),
            "{rewritten}"
        );
        assert_eq!(assess_text(&rewritten), EntryState::Equal);
    }

    #[test]
    fn toml_the_app_cannot_edit_in_place_is_refused_with_a_plain_reason() {
        for (text, refusal) in [
            ("a = ", Refusal::NotToml),
            ("[a]\n[a]\n", Refusal::NotToml),
            ("mcp_servers = 1\n", Refusal::KeyNotTable),
            ("[[mcp_servers]]\nx = 1\n", Refusal::KeyNotTable),
            (
                "mcp_servers = { a = { command = \"x\" } }\n",
                Refusal::TomlLayout,
            ),
            ("mcp_servers.a.command = \"x\"\n", Refusal::TomlLayout),
            (
                "[mcp_servers]\nplaywright = { command = \"x\" }\n",
                Refusal::TomlLayout,
            ),
            (
                "[mcp_servers]\nplaywright.command = \"x\"\n",
                Refusal::TomlLayout,
            ),
            (
                "[[mcp_servers.playwright]]\ncommand = \"x\"\n",
                Refusal::TomlLayout,
            ),
            // `toml_edit` writes `\n` after each line: a CRLF file would change everywhere.
            ("a = 1\r\n[b]\r\nc = 2\r\n", Refusal::TomlLayout),
        ] {
            assert_eq!(doc(HarnessId::Grok, text).unwrap_err(), refusal, "{text}");
        }
        assert_eq!(
            parse(b"\xEF\xBB\xBFa = 1\n", grok()).unwrap_err(),
            Refusal::ByteOrderMark
        );
        assert_eq!(
            parse(b"a = \"\xFF\"\n", grok()).unwrap_err(),
            Refusal::NotUtf8
        );
        // A plain value under the managed key is an entry of the user's, not a layout problem.
        assert_eq!(
            assess_text("[mcp_servers]\nplaywright = \"x\"\n"),
            EntryState::Differs
        );
        // Other servers may use any layout the app does not touch.
        assert!(doc(
            HarnessId::Grok,
            "[mcp_servers]\nother = { command = \"x\" }\n"
        )
        .is_ok());
    }

    #[test]
    fn a_toml_refusal_names_no_file_text() {
        for text in [
            format!("api_key = \"{SECRET}\"\nbroken = "),
            format!("api_key = \"{SECRET}\"\nmcp_servers = \"{SECRET}\"\n"),
            format!("[mcp_servers]\nplaywright = {{ command = \"{SECRET}\" }}\n"),
        ] {
            let refusal = doc(HarnessId::Grok, &text).unwrap_err();
            let reason = EntryState::Refused(refusal)
                .conflict_reason("playwright", McpFormat::Toml)
                .unwrap();
            assert!(
                !reason.contains(SECRET) && !reason.contains("api_key"),
                "{reason}"
            );
            assert!(reason.contains("plain TOML tables"), "{reason}");
        }
    }

    #[test]
    fn a_toml_restore_takes_the_added_table_out_or_puts_the_old_one_back_as_written() {
        let dir = std::env::temp_dir().join(format!(
            "aw-light-mcp-toml-restore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let installed = dir.join("config.toml");
        let backup = dir.join("backup.toml");

        // The apply added the entry; the user changed a key afterwards, which stays.
        let before = grok_user_file();
        fs::write(&backup, &before).unwrap();
        let applied = render(
            grok(),
            Some(doc(HarnessId::Grok, &before).unwrap()),
            entry(),
        )
        .unwrap();
        let edited = applied.replace("'grok-4'", "'grok-5'");
        fs::write(&installed, &edited).unwrap();
        assert_eq!(
            render_restored(grok(), &installed, &backup).unwrap(),
            before.replace("'grok-4'", "'grok-5'")
        );

        // The apply created the servers table: it goes with the entry, and a key the user added
        // since stays.
        fs::write(&backup, "a = 1\n").unwrap();
        fs::write(
            &installed,
            render(
                grok(),
                Some(doc(HarnessId::Grok, "a = 1\nb = 2\n").unwrap()),
                entry(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            render_restored(grok(), &installed, &backup).unwrap(),
            "a = 1\nb = 2\n"
        );

        // The apply replaced an entry: the old one returns with its own lines and comments.
        let old = "# mine\n[mcp_servers.playwright]\ncommand = \"old\"   # pinned\n";
        fs::write(&backup, old).unwrap();
        fs::write(
            &installed,
            render(grok(), Some(doc(HarnessId::Grok, old).unwrap()), entry()).unwrap(),
        )
        .unwrap();
        assert_eq!(render_restored(grok(), &installed, &backup).unwrap(), old);

        // An installed file that no longer reads is not touched, and the error names no text.
        fs::write(&installed, format!("api_key = \"{SECRET}\"\nbroken = ")).unwrap();
        let error = render_restored(grok(), &installed, &backup).unwrap_err();
        assert!(
            error.contains("not valid TOML") && !error.contains(SECRET),
            "{error}"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
