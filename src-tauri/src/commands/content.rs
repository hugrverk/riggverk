use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_targets;
use crate::platform_paths::{display_path, Platform};

use super::process::{open_path, ActionResult};
use super::workspace::{path_arg, workspace_root, workspace_root_for_write};

struct DocEntry {
    id: &'static str,
    section: &'static str,
    title: &'static str,
    rel_path: &'static str,
}

fn curated_doc_registry() -> &'static [DocEntry] {
    &[
        DocEntry {
            id: "README.md",
            section: "Start",
            title: "Workspace README",
            rel_path: "README.md",
        },
        DocEntry {
            id: "docs/START_HERE.md",
            section: "Start",
            title: "Start Here",
            rel_path: "docs/START_HERE.md",
        },
        DocEntry {
            id: "docs/CONCEPTS.md",
            section: "Start",
            title: "Concepts",
            rel_path: "docs/CONCEPTS.md",
        },
        DocEntry {
            id: "docs/USING_THE_APP.md",
            section: "Guides",
            title: "Using the App",
            rel_path: "docs/USING_THE_APP.md",
        },
        DocEntry {
            id: "docs/GIT_VERSIONING.md",
            section: "Guides",
            title: "Git Versioning",
            rel_path: "docs/GIT_VERSIONING.md",
        },
        DocEntry {
            id: "docs/WORKFLOWS.md",
            section: "Guides",
            title: "Workflows",
            rel_path: "docs/WORKFLOWS.md",
        },
        DocEntry {
            id: "docs/SECURITY_BASELINE.md",
            section: "Guides",
            title: "Security Baseline",
            rel_path: "docs/SECURITY_BASELINE.md",
        },
        DocEntry {
            id: "docs/SKILLS.md",
            section: "Reference",
            title: "Skills",
            rel_path: "docs/SKILLS.md",
        },
        DocEntry {
            id: "docs/AGENT_RULES.md",
            section: "Reference",
            title: "Agent Rules",
            rel_path: "docs/AGENT_RULES.md",
        },
        DocEntry {
            id: "docs/OPENCODE_CONFIG.md",
            section: "Reference",
            title: "OpenCode Config",
            rel_path: "docs/OPENCODE_CONFIG.md",
        },
        DocEntry {
            id: "docs/CODEX_CONFIG.md",
            section: "Reference",
            title: "Codex Config",
            rel_path: "docs/CODEX_CONFIG.md",
        },
        DocEntry {
            id: "docs/TROUBLESHOOTING.md",
            section: "Reference",
            title: "Troubleshooting",
            rel_path: "docs/TROUBLESHOOTING.md",
        },
        DocEntry {
            id: "templates/cursor/README.md",
            section: "Cursor",
            title: "Cursor Profile Readme",
            rel_path: "templates/cursor/README.md",
        },
        DocEntry {
            id: "templates/cursor/user-rules.md",
            section: "Cursor",
            title: "Cursor User Rules",
            rel_path: "templates/cursor/user-rules.md",
        },
        DocEntry {
            id: "templates/codex/README.md",
            section: "Configs",
            title: "Codex Config Readme",
            rel_path: "templates/codex/README.md",
        },
        DocEntry {
            id: "templates/codex/config.toml",
            section: "Configs",
            title: "Codex Config",
            rel_path: "templates/codex/config.toml",
        },
        DocEntry {
            id: "templates/codex/mcp/README.md",
            section: "Configs",
            title: "Codex MCP Readme",
            rel_path: "templates/codex/mcp/README.md",
        },
    ]
}

/// Relative paths that must never appear in normal Library Docs (implementation/debug assets).
#[cfg(test)]
pub(crate) const FORBIDDEN_LIBRARY_DOC_REL_PATHS: &[&str] = &[
    "templates/cursor/manifest.json",
    "templates/cursor/mcp/mcp.example.json",
    "templates/cursor/mcp/playwright.mcp.json",
    "templates/cursor/rules/core-safety.mdc",
    "templates/cursor/agents/verifier.md",
];

/// The app's bundled workspace, which the Library reads its docs, rules template, skills, agents and
/// config sources from. Canonical so the containment checks below compare like with like (the
/// source-tree bundle is reached through `..`).
pub(super) fn bundled_library_root() -> Result<PathBuf, String> {
    crate::setup_roots::bundled_root()?
        .canonicalize()
        .map_err(|e| format!("bundled workspace is unavailable: {e}"))
}

/// The curated docs present in `bundle_root`, in registry order: id, section, title and the
/// bundle-relative path.
fn existing_curated_docs(bundle_root: &Path) -> Vec<(String, String, String, &'static str)> {
    curated_doc_registry()
        .iter()
        .filter_map(|entry| {
            if bundle_root.join(entry.rel_path).exists() {
                Some((
                    entry.id.to_string(),
                    entry.section.to_string(),
                    entry.title.to_string(),
                    entry.rel_path,
                ))
            } else {
                None
            }
        })
        .collect()
}

pub(crate) const CUSTOM_DOCS_DIR: &str = "docs/context";

/// Folder of the personal docs, the only Library items the app writes. The bundle ships nothing here.
fn personal_docs_dir(root: &Path) -> PathBuf {
    root.join(CUSTOM_DOCS_DIR)
}

/// The slug of a doc the Library may write, or why it may not: bundled docs are read-only here.
fn writable_slug(id: &str) -> Result<&str, String> {
    let Some(slug) = id.strip_prefix("custom:") else {
        return Err(
            if curated_doc_registry().iter().any(|entry| entry.id == id) {
                format!("{id} is bundled with the app and read-only here")
            } else {
                format!("unknown doc: {id}")
            },
        );
    };
    if !is_valid_slug(slug) {
        return Err(format!("invalid custom doc slug: {}", slug));
    }
    Ok(slug)
}

/// Refuses a personal doc path unless it resolves directly inside the workspace's own `docs/context`:
/// a link on the file, on that folder or on a parent could otherwise carry a write into bundled files.
fn require_personal_doc_path(root: &Path, target: &Path) -> Result<(), String> {
    crate::path_safety::reject_symlink_parent_chain(target, root, "personal doc")?;
    let canonical_target = safe_canonical_target(root, target)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize workspace: {}", e))?;
    if canonical_target.parent() != Some(personal_docs_dir(&canonical_root).as_path()) {
        return Err(format!(
            "personal docs must be files directly in {CUSTOM_DOCS_DIR}"
        ));
    }
    Ok(())
}

fn is_valid_slug(slug: &str) -> bool {
    if slug.is_empty() {
        return false;
    }
    let mut chars = slug.chars();
    match chars.next().unwrap() {
        'a'..='z' | '0'..='9' => {}
        _ => return false,
    }
    for c in chars {
        match c {
            'a'..='z' | '0'..='9' | '-' => {}
            _ => return false,
        }
    }
    true
}

fn slug_to_title(slug: &str) -> String {
    let mut result = String::with_capacity(slug.len());
    let mut capitalize = true;
    for c in slug.chars() {
        if c == '-' {
            result.push(' ');
            capitalize = true;
        } else if capitalize {
            result.push(c.to_ascii_uppercase());
            capitalize = false;
        } else {
            result.push(c);
        }
    }
    result
}

fn extract_title_from_content(content: &str) -> Option<String> {
    let first_line = content.lines().next()?;
    let stripped = first_line.strip_prefix("# ")?.trim();
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn doc_title_from_content_or_slug(content: &str, slug: &str) -> String {
    extract_title_from_content(content).unwrap_or_else(|| slug_to_title(slug))
}

fn custom_doc_rel_path(slug: &str) -> String {
    format!("{}/{}.md", CUSTOM_DOCS_DIR, slug)
}

/// How many personal docs the data folder at `root` holds, as the Library lists them.
pub(crate) fn personal_doc_count(root: &Path) -> usize {
    list_custom_docs(root).len()
}

fn list_custom_docs(root: &Path) -> Vec<(String, String, String, PathBuf)> {
    let context_dir = personal_docs_dir(root);
    if crate::path_safety::reject_symlink_parent_chain(&context_dir, root, "personal docs").is_err()
        || !std::fs::symlink_metadata(&context_dir).is_ok_and(|metadata| metadata.is_dir())
    {
        return vec![];
    }
    let mut docs: Vec<(String, String, String, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&context_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|ft| ft.is_file()) {
                continue;
            }
            if path.extension().is_none_or(|e| e != "md") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if !is_valid_slug(stem) {
                continue;
            }
            let id = format!("custom:{}", stem);
            let content = read_doc_text(&path).unwrap_or_default();
            let title = doc_title_from_content_or_slug(&content, stem);
            docs.push((id, "Context".to_string(), title, path));
        }
    }
    docs.sort_by(|a, b| a.2.cmp(&b.2));
    docs
}

fn read_custom_doc(root: &Path, slug: &str) -> Result<DocumentContent, String> {
    if !is_valid_slug(slug) {
        return Err(format!("invalid custom doc slug: {}", slug));
    }
    let rel = custom_doc_rel_path(slug);
    let path = root.join(&rel);
    if std::fs::symlink_metadata(&path).is_err() {
        return Err(format!("unknown doc: custom:{}", slug));
    }
    let content = read_file_under_root(root, &path)?;
    let title = doc_title_from_content_or_slug(&content, slug);
    Ok(DocumentContent {
        id: format!("custom:{}", slug),
        title,
        path: rel,
        section: "Context".to_string(),
        source: "custom".to_string(),
        revision: Some(text_revision(&content)),
        content,
    })
}

#[derive(Serialize)]
pub struct DocSummary {
    id: String,
    title: String,
    path: String,
    section: String,
    source: String,
}

#[derive(Serialize, Debug)]
pub struct DocumentContent {
    pub id: String,
    pub title: String,
    pub path: String,
    pub section: String,
    pub source: String,
    pub content: String,
    /// Digest of `content`, for an item the Library can save (a personal doc or personal pack
    /// skill): the save sends it back and is refused when the file changed on disk since.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

/// The revision of an editable item's text, as [`DocumentContent::revision`] carries it.
pub(super) fn text_revision(text: &str) -> String {
    crate::stable_digest::bytes(text.as_bytes())
}

/// Bundled docs come from the app's bundle and need no workspace; personal docs come from the data
/// folder and are listed only while it is a usable workspace.
#[tauri::command]
pub fn list_docs() -> Result<Vec<DocSummary>, String> {
    let bundle = bundled_library_root()?;
    let data_folder = workspace_root().ok();
    Ok(list_docs_from(&bundle, data_folder.as_deref()))
}

fn list_docs_from(bundle_root: &Path, data_folder: Option<&Path>) -> Vec<DocSummary> {
    let mut docs: Vec<DocSummary> = existing_curated_docs(bundle_root)
        .into_iter()
        .map(|(id, section, title, rel_path)| DocSummary {
            id,
            title,
            section,
            path: rel_path.to_string(),
            source: "curated".to_string(),
        })
        .collect();
    if let Some(root) = data_folder {
        docs.extend(
            list_custom_docs(root)
                .into_iter()
                .map(|(id, section, title, path)| DocSummary {
                    id,
                    title,
                    section,
                    path: display_path(&path, Platform::current()),
                    source: "custom".to_string(),
                }),
        );
    }
    docs
}

#[tauri::command]
pub fn read_doc(id: String) -> Result<DocumentContent, String> {
    match id.strip_prefix("custom:") {
        Some(slug) => read_custom_doc(&workspace_root()?, slug),
        None => {
            let bundle = bundled_library_root()?;
            let doc = read_curated_doc(&bundle, &id)?;
            Ok(if doc.id == CURSOR_USER_RULES_DOC {
                with_pack_routing(doc, &bundle)
            } else {
                doc
            })
        }
    }
}

/// The Cursor User Rules the user copies by hand: they carry the packs' routing like the rules
/// files Install writes.
const CURSOR_USER_RULES_DOC: &str = "templates/cursor/user-rules.md";

/// `doc`, a bundled rules text, with the routing of the data folder's packs spliced in as Install
/// does (see `pack_routing`). Without a usable data folder or packs it is returned as it is.
fn with_pack_routing(mut doc: DocumentContent, bundle_root: &Path) -> DocumentContent {
    if let Ok(data_folder) = workspace_root() {
        let sources =
            crate::skill_sources::SkillSources::new(bundle_root.to_path_buf(), &data_folder);
        doc.content = crate::pack_routing::splice(
            &doc.content,
            crate::skill_sources::SourceRoot::pack_routing(&sources),
        );
    }
    doc
}

/// A bundled doc, read from `bundle_root`. Its `path` is relative to the bundle.
fn read_curated_doc(bundle_root: &Path, id: &str) -> Result<DocumentContent, String> {
    let docs = existing_curated_docs(bundle_root);
    let Some((id, section, title, rel_path)) = docs.into_iter().find(|(i, _, _, _)| i == id) else {
        return Err(format!("unknown doc: {}", id));
    };
    let content = read_file_under_root(bundle_root, &bundle_root.join(rel_path))?;
    Ok(DocumentContent {
        id,
        title,
        section,
        path: rel_path.to_string(),
        source: "curated".into(),
        content,
        revision: None,
    })
}

/// `open_doc` hands a personal doc to the OS. A bundled doc is read-only here, so it is not offered.
#[tauri::command]
pub fn open_doc(id: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let path = personal_doc_open_path(&root, &id)?;
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = open_path(&path_str, &root);
    Ok(ActionResult::new(
        ok,
        format!("open_doc:{}", id),
        out,
        err,
        code,
    ))
}

fn personal_doc_open_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let slug = writable_slug(id)?;
    let path = root.join(custom_doc_rel_path(slug));
    if std::fs::symlink_metadata(&path).is_err() {
        return Err(format!("unknown doc: custom:{}", slug));
    }
    require_personal_doc_path(root, &path)?;
    Ok(path)
}

pub(super) const MAX_DOC_SIZE: usize = 512 * 1024;
/// A save whose expected revision no longer matches the file. Says "changed on disk", which the
/// Library looks for to offer a reload, as for rules files.
pub(super) const DOC_CHANGED_ON_DISK: &str =
    "the file changed on disk since it was opened: reload it";
/// A doc that grew past [`MAX_DOC_SIZE`] outside the app is never loaded whole.
pub(super) const DOC_TOO_LARGE: &str =
    "the doc on disk is larger than 512 KB; open it in your editor instead";

pub(super) fn doc_backup_path(
    doc_id: &str,
    target_path: &Path,
    custom_backup_root: Option<&Path>,
) -> Result<PathBuf, String> {
    let root = match custom_backup_root {
        Some(path) => path.to_path_buf(),
        None => super::backups::backup_root()?,
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock error".to_string())?
        .as_nanos();
    let safe_id = doc_id.replace(['/', '\\', ':'], "_");
    let file_name = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid target file name".to_string())?;
    let backup_dir = root.join("docs").join(format!("{}-{}", safe_id, timestamp));
    crate::safe_filesystem::create_private_root_directory_all_no_symlinks(&backup_dir)
        .map_err(|e| format!("create backup dir error: {}", e))?;
    Ok(backup_dir.join(file_name))
}

/// Writes the pre-save copy of a doc into the directory `doc_backup_path`
/// created. The file is owner-only (0600 on unix).
pub(super) fn write_doc_backup(backup_path: &Path, existing: &str) -> Result<(), String> {
    let backup_dir = backup_path
        .parent()
        .ok_or_else(|| "backup write error: backup path has no parent".to_string())?;
    crate::safe_filesystem::write_private_new_regular_file_synced(
        backup_path,
        existing.as_bytes(),
        backup_dir,
    )
    .map_err(|e| format!("backup write error: {}", e))
}

pub(crate) fn safe_canonical_target(root: &Path, target_path: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize workspace: {}", e))?;

    let canonical_target = if target_path.exists() {
        target_path
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize target: {}", e))?
    } else {
        let mut ancestor = target_path.to_path_buf();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if ancestor.exists() {
                let canon = ancestor
                    .canonicalize()
                    .map_err(|e| format!("cannot canonicalize ancestor: {}", e))?;
                let mut result = canon;
                for comp in tail.iter().rev() {
                    result = result.join(comp);
                }
                if !result.starts_with(&canonical_root) {
                    return Err("target path is outside workspace".to_string());
                }
                return Ok(result);
            }
            tail.push(
                ancestor
                    .file_name()
                    .ok_or("invalid target path")?
                    .to_os_string(),
            );
            ancestor = ancestor
                .parent()
                .ok_or("invalid target path")?
                .to_path_buf();
        }
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err("target path is outside workspace".to_string());
    }
    Ok(canonical_target)
}

/// Reads a file of the bundle or of the data folder after checking containment and that neither
/// the file nor any parent below `root` is a symlink.
fn read_file_under_root(root: &Path, path: &Path) -> Result<String, String> {
    safe_canonical_target(root, path)?;
    crate::path_safety::reject_symlink_parent_chain(path, root, "workspace file")?;
    read_doc_text(path)
}

/// The text of a doc of at most [`MAX_DOC_SIZE`] bytes; never reads more than one byte past it.
fn read_doc_text(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("read error: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_DOC_SIZE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read error: {e}"))?;
    if bytes.len() > MAX_DOC_SIZE {
        return Err(DOC_TOO_LARGE.to_string());
    }
    String::from_utf8(bytes).map_err(|_| "read error: the doc is not valid UTF-8".to_string())
}

/// Atomic, symlink-refusing write of a workspace file (temp file + rename inside `root`).
fn write_workspace_file(root: &Path, path: &Path, content: &str) -> Result<(), String> {
    crate::safe_filesystem::write_regular_file_atomic(path, content.as_bytes(), root)
        .map_err(|e| format!("write error: {e}"))
}

#[cfg(test)]
fn save_doc_at_root(
    root: &Path,
    id: &str,
    content: &str,
    custom_backup_root: Option<&Path>,
) -> Result<ActionResult, String> {
    save_doc_checked(root, id, content, None, custom_backup_root)
}

/// Saves a personal doc. With `expected_revision` (the revision the editor loaded) the save is
/// refused when the file changed on disk since.
fn save_doc_checked(
    root: &Path,
    id: &str,
    content: &str,
    expected_revision: Option<&str>,
    custom_backup_root: Option<&Path>,
) -> Result<ActionResult, String> {
    let slug = writable_slug(id)?;
    if content.len() > MAX_DOC_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let target_path = root.join(custom_doc_rel_path(slug));
    require_personal_doc_path(root, &target_path)?;

    if !target_path.exists() {
        return Err(format!(
            "custom doc does not exist: {}. Use create_doc to create new custom docs.",
            id
        ));
    }

    let existing = read_doc_text(&target_path)?;
    if expected_revision.is_some_and(|expected| expected != text_revision(&existing)) {
        return Err(DOC_CHANGED_ON_DISK.to_string());
    }
    if existing == content {
        return Ok(ActionResult::new(
            true,
            "save_doc",
            "unchanged".to_string(),
            String::new(),
            Some(0),
        ));
    }

    let backup_path = doc_backup_path(id, &target_path, custom_backup_root)?;
    write_doc_backup(&backup_path, &existing)?;

    write_workspace_file(root, &target_path, content)?;

    Ok(ActionResult::new(
        true,
        "save_doc",
        "saved with backup".to_string(),
        String::new(),
        Some(0),
    ))
}

#[tauri::command(async)]
pub fn save_doc(
    id: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<ActionResult, String> {
    // Writes files an apply may also write: wait for a running mutation instead of interleaving.
    let _mutation = crate::mutation_lock::acquire()?;
    let root = workspace_root_for_write()?;
    save_doc_checked(&root, &id, &content, expected_revision.as_deref(), None)
}

fn create_doc_at_root(
    root: &Path,
    title: &str,
    slug: &str,
    content: Option<String>,
) -> Result<DocumentContent, String> {
    if !is_valid_slug(slug) {
        return Err(format!(
            "invalid slug: {}. Use lowercase letters, digits, and hyphens (e.g. my-context-notes).",
            slug
        ));
    }
    let rel = custom_doc_rel_path(slug);
    let target_path = root.join(&rel);

    // `exists()` follows symlinks and is false for a dangling one, which a write would then follow.
    match std::fs::symlink_metadata(&target_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!("refusing symlink doc path: custom:{}", slug));
        }
        Ok(_) => return Err(format!("doc already exists: custom:{}", slug)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("cannot inspect doc path: {}", e)),
    }

    let trimmed_title = title.trim();
    let initial_content = if let Some(c) = content {
        c
    } else if trimmed_title.is_empty() {
        String::new()
    } else {
        format!("# {}\n", trimmed_title)
    };
    if initial_content.len() > MAX_DOC_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }
    // A fresh profile has no data folder yet: the first personal doc creates it, owner-only.
    crate::managed_state::ensure_data_folder(root)?;
    require_personal_doc_path(root, &target_path)?;
    write_workspace_file(root, &target_path, &initial_content)?;

    Ok(DocumentContent {
        id: format!("custom:{}", slug),
        title: trimmed_title.to_string(),
        path: rel,
        section: "Context".to_string(),
        source: "custom".to_string(),
        revision: Some(text_revision(&initial_content)),
        content: initial_content,
    })
}

#[tauri::command(async)]
pub fn create_doc(
    title: String,
    slug: String,
    content: Option<String>,
) -> Result<DocumentContent, String> {
    // Writes files an apply may also write: wait for a running mutation instead of interleaving.
    let _mutation = crate::mutation_lock::acquire()?;
    let root = workspace_root_for_write()?;
    create_doc_at_root(&root, &title, &slug, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("riggverk-docs-{name}-{nonce}"))
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        if let Some(parent) = root.join(rel).parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(root.join(rel), content).expect("write file");
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn curated_registry_skips_missing_optional_docs() {
        let root = temp_root("missing-optional");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/START_HERE.md", "# start\n");
        // docs/CONCEPTS.md and others intentionally missing

        let docs = existing_curated_docs(&root);
        cleanup(&root);

        let ids: Vec<&str> = docs.iter().map(|(id, _, _, _)| id.as_str()).collect();
        assert_eq!(ids, &["README.md", "docs/START_HERE.md"]);
    }

    #[test]
    fn curated_registry_order_is_stable() {
        let root = temp_root("stable-order");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/START_HERE.md", "# start\n");
        write_file(&root, "docs/TROUBLESHOOTING.md", "# troubleshooting\n");
        write_file(&root, "docs/AGENT_RULES.md", "# rules\n");

        let docs = existing_curated_docs(&root);
        cleanup(&root);

        let ids: Vec<&str> = docs.iter().map(|(id, _, _, _)| id.as_str()).collect();
        let expected = &[
            "README.md",
            "docs/START_HERE.md",
            "docs/AGENT_RULES.md",
            "docs/TROUBLESHOOTING.md",
        ];
        assert_eq!(
            ids, expected,
            "registry order must match declaration order, not filesystem order"
        );
    }

    #[test]
    fn unknown_doc_id_is_rejected() {
        let root = temp_root("unknown-id");
        write_file(&root, "README.md", "# readme\n");

        let docs = existing_curated_docs(&root);
        let found = docs
            .iter()
            .find(|(id, _, _, _)| id == "docs/nonexistent.md");
        cleanup(&root);

        assert!(
            found.is_none(),
            "unknown doc id must not be found in curated registry"
        );
    }

    #[test]
    fn curated_registry_excludes_internal_cursor_library_docs() {
        let ids: Vec<&str> = curated_doc_registry().iter().map(|e| e.rel_path).collect();
        for forbidden in FORBIDDEN_LIBRARY_DOC_REL_PATHS {
            assert!(
                !ids.contains(forbidden),
                "curated registry must not expose internal Cursor doc: {}",
                forbidden
            );
        }
        let cursor_docs: Vec<&str> = ids
            .iter()
            .copied()
            .filter(|p| p.starts_with("templates/cursor/"))
            .collect();
        assert_eq!(
            cursor_docs,
            &[
                "templates/cursor/README.md",
                "templates/cursor/user-rules.md"
            ],
            "normal Library Cursor docs must be user-facing only"
        );
    }

    #[test]
    fn sections_are_assigned_correctly() {
        let root = temp_root("section-check");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/START_HERE.md", "# start\n");
        write_file(&root, "docs/GIT_VERSIONING.md", "# git\n");
        write_file(&root, "docs/AGENT_RULES.md", "# rules\n");
        write_file(&root, "templates/cursor/README.md", "# cursor\n");

        let docs = existing_curated_docs(&root);
        cleanup(&root);

        let by_id: HashMap<&str, &str> = docs
            .iter()
            .map(|(id, section, _, _)| (id.as_str(), section.as_str()))
            .collect();

        assert_eq!(by_id.get("README.md"), Some(&"Start"));
        assert_eq!(by_id.get("docs/START_HERE.md"), Some(&"Start"));
        assert_eq!(by_id.get("docs/GIT_VERSIONING.md"), Some(&"Guides"));
        assert_eq!(by_id.get("docs/AGENT_RULES.md"), Some(&"Reference"));
        assert_eq!(by_id.get("templates/cursor/README.md"), Some(&"Cursor"));
    }

    #[test]
    fn save_doc_unknown_id_rejected() {
        let root = temp_root("save-unknown");
        write_file(&root, "README.md", "# readme\n");

        let result = save_doc_at_root(&root, "docs/nonexistent.md", "content", None);
        cleanup(&root);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("unknown doc"),
            "expected unknown doc error, got: {}",
            err
        );
    }

    /// Every bundled doc is read-only here: the save is refused before any backup or write.
    #[test]
    fn save_doc_refuses_every_bundled_doc_and_leaves_it_untouched() {
        let root = temp_root("save-bundled");
        let backup_root = temp_root("save-bundled-backup");
        for entry in curated_doc_registry() {
            write_file(&root, entry.rel_path, "bundled\n");
        }

        let mut outcomes = Vec::new();
        for entry in curated_doc_registry() {
            let result = save_doc_at_root(&root, entry.id, "draft text\n", Some(&backup_root));
            let bytes = fs::read_to_string(root.join(entry.rel_path)).unwrap();
            outcomes.push((entry.id, result, bytes));
        }
        let backup_made = backup_root.exists();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);

        assert_eq!(outcomes.len(), curated_doc_registry().len());
        for (id, result, bytes) in outcomes {
            let err = result.expect_err("a bundled doc must not be saved");
            assert_eq!(
                err,
                format!("{id} is bundled with the app and read-only here")
            );
            assert_eq!(bytes, "bundled\n", "{id} must stay unchanged");
        }
        assert!(!backup_made, "a refused save must not write a backup");
    }

    #[cfg(unix)]
    #[test]
    fn save_doc_backup_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode_of = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let root = temp_root("save-private");
        let backup_root = temp_root("save-private-backup");
        write_file(&root, "docs/context/notes.md", "# old\n");

        save_doc_at_root(&root, "custom:notes", "# new\n", Some(&backup_root)).expect("save");

        let docs = backup_root.join("docs");
        assert_eq!(mode_of(&docs), 0o700);
        let backup_dirs: Vec<_> = fs::read_dir(&docs)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backup_dirs.len(), 1);
        assert_eq!(mode_of(&backup_dirs[0]), 0o700);
        let backup_file = backup_dirs[0].join("notes.md");
        assert_eq!(mode_of(&backup_file), 0o600);
        assert_eq!(fs::read_to_string(&backup_file).unwrap(), "# old\n");
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn save_doc_path_traversal_id_rejected() {
        let root = temp_root("save-traversal");
        write_file(&root, "README.md", "# readme\n");

        // This id is not in registry, so it should be rejected before any path check
        let result = save_doc_at_root(&root, "../../../etc/passwd", "bad", None);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown doc"));
    }

    /// The personal docs folder is never shipped or listed as a bundled doc, so Install, uninstall
    /// and the bundled registry cannot reach what the user writes there.
    #[test]
    fn personal_docs_folder_is_neither_bundled_nor_curated() {
        let prefix = format!("{CUSTOM_DOCS_DIR}/");
        for entry in curated_doc_registry() {
            assert!(!entry.rel_path.starts_with(&prefix), "{}", entry.rel_path);
        }
        for path in crate::commands::retired_workspace_files::workspace_copy_paths() {
            assert!(
                !path.starts_with(&prefix),
                "bundled file in personal docs: {path}"
            );
        }
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../resources/default-workspace")
            .join(CUSTOM_DOCS_DIR);
        assert!(
            !bundled.exists(),
            "the bundle must not ship {CUSTOM_DOCS_DIR}"
        );
    }

    #[test]
    fn config_template_known_target_resolves() {
        let root = temp_root("config-template-known");
        write_file(&root, "templates/opencode.json", "{}");

        let targets = agent_targets::bundled_config_targets();
        let opencode = targets.iter().find(|t| t.id == "opencode_config");
        assert!(
            opencode.is_some(),
            "opencode_config must be in bundled_config_targets"
        );

        let path = root.join(opencode.unwrap().source_rel);
        assert!(path.exists(), "source_rel must point to an existing file");
        cleanup(&root);
    }

    #[test]
    fn config_template_unknown_target_rejected() {
        let targets = agent_targets::bundled_config_targets();
        let unknown = targets.iter().find(|t| t.id == "nonexistent_config");
        assert!(
            unknown.is_none(),
            "unknown config target must not be in the bundled config registry"
        );
    }

    #[test]
    fn cursor_setup_is_not_a_bundled_config_template() {
        let targets = agent_targets::bundled_config_targets();
        assert!(
            targets.iter().all(|t| t.id != "cursor_setup"),
            "cursor_setup must stay out of config template editing"
        );
    }

    #[test]
    fn config_sync_target_source_paths_are_safe() {
        let targets = agent_targets::bundled_config_targets();
        for t in &targets {
            assert!(
                !t.source_rel.starts_with('/'),
                "source_rel must not be absolute: {}",
                t.id
            );
            assert!(
                !t.source_rel.contains(".."),
                "source_rel must not contain parent refs: {}",
                t.id
            );
        }
    }

    // ── custom doc tests ──

    #[test]
    fn slug_validation_accepts_good_slugs() {
        assert!(is_valid_slug("my-notes"));
        assert!(is_valid_slug("context"));
        assert!(is_valid_slug("a"));
        assert!(is_valid_slug("my-context-2"));
        assert!(is_valid_slug("123-data"));
    }

    #[test]
    fn slug_validation_rejects_bad_slugs() {
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("My-Notes"));
        assert!(!is_valid_slug("UPPER"));
        assert!(!is_valid_slug("my notes"));
        assert!(!is_valid_slug("my/notes"));
        assert!(!is_valid_slug("../../etc"));
        assert!(!is_valid_slug("-starts-with-hyphen"));
        assert!(!is_valid_slug("has.dot"));
        assert!(!is_valid_slug("has space"));
        assert!(!is_valid_slug("has_underscore"));
        assert!(!is_valid_slug("has@special"));
    }

    #[test]
    fn save_doc_replaces_atomically_without_temp_leftovers() {
        let root = temp_root("save-atomic");
        let backup_root = temp_root("save-atomic-backup");
        write_file(&root, "docs/context/notes.md", "# old\n");

        save_doc_at_root(&root, "custom:notes", "# new\n", Some(&backup_root)).expect("save");

        let leftovers: Vec<String> = fs::read_dir(root.join("docs/context"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        let saved = fs::read_to_string(root.join("docs/context/notes.md")).unwrap();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        assert!(leftovers.is_empty(), "{leftovers:?}");
        assert_eq!(saved, "# new\n");
    }

    #[cfg(unix)]
    #[test]
    fn save_doc_refuses_symlinked_doc_and_leaves_target_untouched() {
        let root = temp_root("save-symlink");
        let backup_root = temp_root("save-symlink-backup");
        write_file(&root, "docs/real.md", "# real\n");
        fs::create_dir_all(root.join("docs/context")).unwrap();
        std::os::unix::fs::symlink(
            root.join("docs/real.md"),
            root.join("docs/context/notes.md"),
        )
        .unwrap();

        let result = save_doc_at_root(&root, "custom:notes", "# changed\n", Some(&backup_root));

        let real = fs::read_to_string(root.join("docs/real.md")).unwrap();
        let link_still_symlink = fs::symlink_metadata(root.join("docs/context/notes.md"))
            .unwrap()
            .file_type()
            .is_symlink();
        let backup_made = backup_root.exists();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        let err = result.expect_err("symlinked doc must be refused");
        assert!(err.contains("symlink"), "{err}");
        assert_eq!(real, "# real\n");
        assert!(link_still_symlink);
        assert!(!backup_made, "a refused save must not write a backup");
    }

    /// A linked `docs/context` folder would carry a personal doc write into a bundled folder.
    #[cfg(unix)]
    #[test]
    fn save_create_and_open_refuse_a_linked_personal_docs_folder() {
        let root = temp_root("save-linked-folder");
        let backup_root = temp_root("save-linked-folder-backup");
        write_file(&root, "skills/notes.md", "# bundled skill file\n");
        fs::create_dir_all(root.join("docs")).unwrap();
        std::os::unix::fs::symlink(root.join("skills"), root.join("docs/context")).unwrap();

        let saved = save_doc_at_root(&root, "custom:notes", "# changed\n", Some(&backup_root));
        let created = create_doc_at_root(&root, "Fresh", "fresh", None);
        let opened = personal_doc_open_path(&root, "custom:notes");

        let skill = fs::read_to_string(root.join("skills/notes.md")).unwrap();
        let fresh_written = root.join("skills/fresh.md").exists();
        let backup_made = backup_root.exists();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        assert!(
            saved.is_err(),
            "save through a linked folder must be refused"
        );
        assert!(
            created.is_err(),
            "create through a linked folder must be refused"
        );
        assert!(
            opened.is_err(),
            "open through a linked folder must be refused"
        );
        assert_eq!(skill, "# bundled skill file\n");
        assert!(!fresh_written);
        assert!(!backup_made);
    }

    #[test]
    fn open_doc_offers_personal_docs_only() {
        let root = temp_root("open-doc-scope");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/context/notes.md", "# notes\n");

        let bundled = personal_doc_open_path(&root, "README.md");
        let personal = personal_doc_open_path(&root, "custom:notes");
        let missing = personal_doc_open_path(&root, "custom:missing");
        cleanup(&root);

        assert_eq!(
            bundled.expect_err("a bundled doc is not opened"),
            "README.md is bundled with the app and read-only here"
        );
        assert!(personal
            .expect("personal doc")
            .ends_with("docs/context/notes.md"));
        assert!(missing.expect_err("missing doc").contains("unknown doc"));
    }

    #[cfg(unix)]
    #[test]
    fn read_doc_refuses_symlink_to_file_outside_workspace() {
        let root = temp_root("read-doc-outside");
        let outside_dir = temp_root("read-doc-outside-target");
        write_file(&outside_dir, "secret.md", "secret");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outside_dir.join("secret.md"), root.join("README.md")).unwrap();

        let result = read_curated_doc(&root, "README.md");

        cleanup(&root);
        cleanup(&outside_dir);
        let err = result.expect_err("outside symlink must be refused");
        assert!(err.contains("outside workspace"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_doc_refuses_symlink_inside_workspace() {
        let root = temp_root("read-doc-inside");
        write_file(&root, "docs/real.md", "# real\n");
        std::os::unix::fs::symlink(root.join("docs/real.md"), root.join("README.md")).unwrap();

        let result = read_curated_doc(&root, "README.md");

        cleanup(&root);
        let err = result.expect_err("symlinked doc must be refused");
        assert!(err.contains("symlink"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_custom_doc_refuses_symlink() {
        let root = temp_root("read-custom-symlink");
        write_file(&root, "docs/real.md", "# real\n");
        fs::create_dir_all(root.join("docs/context")).unwrap();
        std::os::unix::fs::symlink(
            root.join("docs/real.md"),
            root.join("docs/context/notes.md"),
        )
        .unwrap();

        let result = read_custom_doc(&root, "notes");

        cleanup(&root);
        let err = result.expect_err("symlinked custom doc must be refused");
        assert!(err.contains("symlink"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn list_custom_docs_skips_symlinked_context_directory() {
        let root = temp_root("list-custom-context-symlink");
        let outside = temp_root("list-custom-context-outside");
        write_file(&outside, "a.md", "# Secret\n");
        fs::create_dir_all(root.join("docs")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("docs/context")).unwrap();

        let linked = list_custom_docs(&root);
        fs::remove_file(root.join("docs/context")).unwrap();
        write_file(&root, "docs/context/a.md", "# Secret\n");
        let normal = list_custom_docs(&root);

        cleanup(&root);
        cleanup(&outside);
        assert!(linked.is_empty());
        assert_eq!(normal.len(), 1);
        assert_eq!(normal[0].0, "custom:a");
        assert_eq!(normal[0].2, "Secret");
    }

    #[cfg(unix)]
    #[test]
    fn list_custom_docs_skips_symlinked_docs() {
        let root = temp_root("list-custom-symlink");
        write_file(&root, "docs/context/real.md", "# Real\n");
        std::os::unix::fs::symlink(
            root.join("docs/context/real.md"),
            root.join("docs/context/linked.md"),
        )
        .unwrap();

        let docs = list_custom_docs(&root);

        cleanup(&root);
        let ids: Vec<&str> = docs.iter().map(|(id, _, _, _)| id.as_str()).collect();
        assert_eq!(ids, &["custom:real"]);
    }

    #[cfg(unix)]
    #[test]
    fn read_agent_template_refuses_symlink() {
        let root = temp_root("read-agent-template-symlink");
        write_file(&root, "templates/real.md", "# rules\n");
        std::os::unix::fs::symlink(
            root.join("templates/real.md"),
            root.join("templates/global-agent-rules.md"),
        )
        .unwrap();

        let result = read_agent_template_at_root(&root);

        cleanup(&root);
        let err = result.expect_err("symlinked template must be refused");
        assert!(err.contains("symlink"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_agent_template_refuses_symlink_outside_workspace() {
        let root = temp_root("read-agent-template-outside");
        let outside_dir = temp_root("read-agent-template-outside-target");
        write_file(&outside_dir, "secret.md", "secret");
        fs::create_dir_all(root.join("templates")).unwrap();
        std::os::unix::fs::symlink(
            outside_dir.join("secret.md"),
            root.join("templates/global-agent-rules.md"),
        )
        .unwrap();

        let result = read_agent_template_at_root(&root);

        cleanup(&root);
        cleanup(&outside_dir);
        let err = result.expect_err("outside symlink must be refused");
        assert!(err.contains("outside workspace"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_config_template_refuses_symlink() {
        let root = temp_root("read-config-template-symlink");
        write_file(&root, "templates/real.json", "{}\n");
        std::os::unix::fs::symlink(
            root.join("templates/real.json"),
            root.join("templates/opencode.json"),
        )
        .unwrap();

        let result = read_config_template_at_root(&root, "opencode_config");

        cleanup(&root);
        let err = result.expect_err("symlinked config template must be refused");
        assert!(err.contains("symlink"), "{err}");
    }

    #[test]
    fn read_regular_templates_still_works() {
        let root = temp_root("read-templates-ok");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}\n");

        let agent = read_agent_template_at_root(&root).expect("agent template");
        let config = read_config_template_at_root(&root, "opencode_config").expect("config");

        cleanup(&root);
        assert_eq!(agent.content, "# rules\n");
        assert_eq!(config.content, "{}\n");
    }

    #[test]
    fn bundled_docs_are_listed_and_read_from_the_bundle_with_bundle_relative_paths() {
        let bundle = temp_root("bundle-docs");
        let data = temp_root("bundle-docs-data");
        write_file(&bundle, "README.md", "# bundled readme\n");
        write_file(&bundle, "docs/START_HERE.md", "# bundled start\n");
        // An edited copy in the data folder is never what a bundled doc shows.
        write_file(&data, "README.md", "# edited copy\n");
        write_file(&data, "docs/CONCEPTS.md", "# only in the copy\n");
        write_file(&data, "docs/context/notes.md", "# Notes\n");

        let listed = list_docs_from(&bundle, Some(&data));
        let readme = read_curated_doc(&bundle, "README.md");
        let only_in_copy = read_curated_doc(&bundle, "docs/CONCEPTS.md");
        let personal_id = read_curated_doc(&bundle, "custom:notes");
        let data_path = display_path(&data.join("docs/context/notes.md"), Platform::current());
        cleanup(&bundle);
        cleanup(&data);

        let rows: Vec<(&str, &str, &str)> = listed
            .iter()
            .map(|doc| (doc.id.as_str(), doc.path.as_str(), doc.source.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("README.md", "README.md", "curated"),
                ("docs/START_HERE.md", "docs/START_HERE.md", "curated"),
                ("custom:notes", data_path.as_str(), "custom"),
            ]
        );
        let readme = readme.expect("bundled readme");
        assert_eq!(readme.content, "# bundled readme\n");
        assert_eq!(readme.path, "README.md");
        assert_eq!(readme.source, "curated");
        assert!(only_in_copy
            .expect_err("not bundled")
            .contains("unknown doc"));
        assert!(personal_id
            .expect_err("personal id")
            .contains("unknown doc"));
    }

    #[test]
    fn bundled_docs_are_listed_without_a_data_folder() {
        let bundle = temp_root("bundle-docs-alone");
        write_file(&bundle, "README.md", "# bundled readme\n");

        let listed = list_docs_from(&bundle, None);
        cleanup(&bundle);

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "README.md");
        assert_eq!(listed[0].source, "curated");
    }

    #[test]
    fn config_sources_and_agent_files_are_read_from_the_bundle_root() {
        let bundle = temp_root("bundle-sources");
        write_file(&bundle, "templates/opencode.base.json", "{\"base\":1}\n");
        write_file(&bundle, "agents/architect.md", "# bundled architect\n");
        write_file(
            &bundle,
            "templates/global-agent-rules.md",
            "# bundled rules\n",
        );

        let source = read_opencode_config_source_at_root(&bundle, "base");
        let agent = resolve_agent_path(&bundle, "architect.md").map(fs::read_to_string);
        let template = read_agent_template_at_root(&bundle);
        cleanup(&bundle);

        let source = source.expect("bundled base config");
        assert_eq!(source.content, "{\"base\":1}\n");
        assert_eq!(source.path, "templates/opencode.base.json");
        assert_eq!(
            agent.expect("agent path").expect("agent text"),
            "# bundled architect\n"
        );
        let template = template.expect("bundled rules");
        assert_eq!(template.content, "# bundled rules\n");
        assert_eq!(template.path, "templates/global-agent-rules.md");
    }

    #[cfg(unix)]
    #[test]
    fn create_doc_refuses_dangling_symlink_inside_workspace() {
        let root = temp_root("create-dangling-inside");
        fs::create_dir_all(root.join("docs/context")).unwrap();
        let dangling_target = root.join("elsewhere.md");
        std::os::unix::fs::symlink(&dangling_target, root.join("docs/context/notes.md")).unwrap();

        let result = create_doc_at_root(&root, "Notes", "notes", None);

        let created = dangling_target.exists();
        cleanup(&root);
        let err = result.expect_err("dangling symlink must be refused");
        assert!(err.contains("symlink"), "{err}");
        assert!(!created, "write must not follow the dangling symlink");
    }

    #[cfg(unix)]
    #[test]
    fn create_doc_refuses_dangling_symlink_to_outside_workspace() {
        let root = temp_root("create-dangling-outside");
        let outside_dir = temp_root("create-dangling-outside-target");
        fs::create_dir_all(root.join("docs/context")).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        let outside_target = outside_dir.join("created.md");
        std::os::unix::fs::symlink(&outside_target, root.join("docs/context/notes.md")).unwrap();

        let result = create_doc_at_root(&root, "Notes", "notes", None);

        let created = outside_target.exists();
        cleanup(&root);
        cleanup(&outside_dir);
        let err = result.expect_err("dangling symlink must be refused");
        assert!(err.contains("symlink"), "{err}");
        assert!(!created, "write must not escape the workspace");
    }

    #[test]
    fn create_doc_creates_file_with_h1_title() {
        let root = temp_root("create-doc");
        std::fs::create_dir_all(&root).expect("create root dir");

        let rel = custom_doc_rel_path("my-notes");
        let target_path = root.join(&rel);
        assert!(!target_path.exists());

        let result = create_doc_at_root(&root, "My Context Notes", "my-notes", None);
        assert!(result.is_ok(), "create should succeed: {:?}", result);
        let doc = result.unwrap();
        assert_eq!(doc.id, "custom:my-notes");
        assert_eq!(doc.title, "My Context Notes");
        assert_eq!(doc.content, "# My Context Notes\n");

        let saved = std::fs::read_to_string(&target_path).unwrap();
        cleanup(&root);
        assert_eq!(saved, "# My Context Notes\n");
    }

    #[test]
    fn create_doc_writes_empty_when_no_title() {
        let root = temp_root("create-doc-no-title");
        std::fs::create_dir_all(&root).expect("create root dir");

        let result = create_doc_at_root(&root, "", "my-notes", None);
        assert!(result.is_ok());
        let doc = result.unwrap();
        assert_eq!(doc.title, "");
        assert_eq!(doc.content, "");

        let saved = std::fs::read_to_string(root.join(custom_doc_rel_path("my-notes"))).unwrap();
        cleanup(&root);
        assert_eq!(saved, "");
    }

    #[test]
    fn create_doc_rejects_explicit_content_over_limit_without_writing() {
        let root = temp_root("create-doc-oversize");
        std::fs::create_dir_all(&root).expect("create root dir");
        let target_path = root.join(custom_doc_rel_path("too-large"));
        let oversized = "a".repeat(MAX_DOC_SIZE + 1);

        let result = create_doc_at_root(&root, "Too Large", "too-large", Some(oversized));

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "content exceeds 512 KB limit");
        assert!(
            !target_path.exists(),
            "oversized create_doc must not leave a file behind"
        );
        cleanup(&root);
    }

    #[test]
    fn a_doc_changed_on_disk_since_it_was_read_is_refused() {
        let root = temp_root("doc-revision");
        write_file(&root, "docs/context/notes.md", "# Notes\nfirst\n");
        let backups = root.join("backups");
        let opened = read_custom_doc(&root, "notes").unwrap();
        let revision = opened
            .revision
            .clone()
            .expect("a personal doc has a revision");
        write_file(
            &root,
            "docs/context/notes.md",
            "# Notes\nedited elsewhere\n",
        );

        let refused = save_doc_checked(
            &root,
            "custom:notes",
            "# Notes\nmine\n",
            Some(&revision),
            Some(&backups),
        );
        let after_refusal = fs::read_to_string(root.join("docs/context/notes.md")).unwrap();
        let reread = read_custom_doc(&root, "notes").unwrap().revision.unwrap();
        let saved = save_doc_checked(
            &root,
            "custom:notes",
            "# Notes\nmine\n",
            Some(&reread),
            Some(&backups),
        );
        let after_save = fs::read_to_string(root.join("docs/context/notes.md")).unwrap();
        cleanup(&root);

        assert_eq!(refused.err().as_deref(), Some(DOC_CHANGED_ON_DISK));
        assert_eq!(after_refusal, "# Notes\nedited elsewhere\n");
        assert!(saved.expect("save after reload").success);
        assert_eq!(after_save, "# Notes\nmine\n");
    }

    #[test]
    fn a_doc_grown_past_the_cap_on_disk_is_refused_on_read_and_save() {
        let root = temp_root("doc-grown");
        let huge = "a".repeat(MAX_DOC_SIZE + 1);
        write_file(&root, "docs/context/huge.md", &huge);
        let backups = root.join("backups");

        let read = read_custom_doc(&root, "huge");
        let saved = save_doc_at_root(&root, "custom:huge", "short\n", Some(&backups));
        let on_disk = fs::read_to_string(root.join("docs/context/huge.md")).unwrap();
        let backup_made = backups.exists();
        cleanup(&root);

        assert_eq!(read.err().as_deref(), Some(DOC_TOO_LARGE));
        assert_eq!(saved.err().as_deref(), Some(DOC_TOO_LARGE));
        assert_eq!(on_disk, huge);
        assert!(!backup_made);
    }

    #[test]
    fn create_doc_rejects_existing_file() {
        let root = temp_root("create-existing");
        write_file(&root, "docs/context/existing.md", "# already here\n");

        let result = create_doc_at_root(&root, "Test", "existing", None);
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("doc already exists"));
    }

    #[test]
    fn create_doc_rejects_invalid_slug() {
        let root = temp_root("create-bad-slug");
        std::fs::create_dir_all(&root).expect("create root dir");

        let result = create_doc_at_root(&root, "Test", "../../etc", None);
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid slug"));
    }

    #[test]
    fn save_doc_rejects_missing_custom_doc() {
        let root = temp_root("save-missing-custom");
        std::fs::create_dir_all(&root).expect("create root dir");

        let result = save_doc_at_root(&root, "custom:nonexistent", "# content\n", None);
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("custom doc does not exist"));
    }

    #[test]
    fn save_doc_saves_existing_custom_doc() {
        let root = temp_root("save-existing-custom");
        let backup_root = temp_root("save-existing-custom-backup");
        write_file(&root, "docs/context/my-notes.md", "# original\n");

        let result = save_doc_at_root(&root, "custom:my-notes", "# modified\n", Some(&backup_root));
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        let saved = std::fs::read_to_string(root.join("docs/context/my-notes.md")).unwrap();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        assert_eq!(saved, "# modified\n");
    }

    #[test]
    fn list_docs_includes_custom_docs() {
        let root = temp_root("list-custom");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/context/my-notes.md", "# my notes\n");
        write_file(&root, "docs/context/ref-data.md", "# ref data\n");
        // add a file with invalid slug — should be skipped
        write_file(&root, "docs/context/Invalid.md", "# invalid\n");

        let docs = existing_curated_docs(&root);
        let custom = list_custom_docs(&root);
        cleanup(&root);

        let curated_ids: Vec<&str> = docs.iter().map(|(id, _, _, _)| id.as_str()).collect();
        assert_eq!(curated_ids, &["README.md"]);

        let custom_ids: Vec<&str> = custom.iter().map(|(id, _, _, _)| id.as_str()).collect();
        assert_eq!(custom_ids.len(), 2);
        assert!(custom_ids.contains(&"custom:my-notes"));
        assert!(custom_ids.contains(&"custom:ref-data"));
        assert!(!custom_ids.contains(&"custom:Invalid"));
    }

    #[test]
    fn read_doc_rejects_unknown_custom_id() {
        let root = temp_root("read-unknown-custom");
        write_file(&root, "README.md", "# readme\n");

        let result = read_custom_doc(&root, "nonexistent");
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown doc"));
    }

    #[test]
    fn read_doc_rejects_invalid_custom_slug() {
        let root = temp_root("read-invalid-custom");
        write_file(&root, "README.md", "# readme\n");

        let result = read_custom_doc(&root, "../../etc");
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid custom doc slug"));
    }

    #[test]
    fn save_doc_custom_creates_backup_when_changed() {
        let root = temp_root("save-custom-backup");
        let backup_root = temp_root("save-custom-backup-backup");
        write_file(&root, "docs/context/my-notes.md", "# original\n");

        let result = save_doc_at_root(&root, "custom:my-notes", "# modified\n", Some(&backup_root));

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        let docs_backup_dir = backup_root.join("docs");
        let backup_entries: Vec<_> = std::fs::read_dir(&docs_backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("custom_my-notes-")
            })
            .collect();

        assert!(
            !backup_entries.is_empty(),
            "custom backup should be created"
        );
        let backup_file = backup_entries[0].path().join("my-notes.md");
        let backup_content = std::fs::read_to_string(&backup_file).unwrap();

        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);

        assert_eq!(backup_content, "# original\n");
    }

    #[test]
    fn save_doc_custom_unchanged_does_not_write() {
        let root = temp_root("save-custom-unchanged");
        write_file(&root, "docs/context/my-notes.md", "# same\n");

        let result = save_doc_at_root(&root, "custom:my-notes", "# same\n", None);

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
    }

    #[test]
    fn save_doc_custom_target_remains_under_workspace() {
        let root = temp_root("save-custom-under-root");
        let backup_root = temp_root("save-custom-under-root-backup");
        write_file(&root, "docs/context/my-notes.md", "# readme\n");

        let result = save_doc_at_root(&root, "custom:my-notes", "# updated\n", Some(&backup_root));

        assert!(result.is_ok());
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn save_doc_custom_rejects_invalid_slug() {
        let root = temp_root("save-custom-bad-slug");
        write_file(&root, "README.md", "# readme\n");

        let result = save_doc_at_root(&root, "custom:../../etc", "bad", None);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid custom doc slug"));
    }

    // ── H1 title extraction tests ──

    #[test]
    fn extract_title_from_h1_line() {
        assert_eq!(
            extract_title_from_content("# My Context Notes\n\nSome more text"),
            Some("My Context Notes".to_string())
        );
    }

    #[test]
    fn extract_title_from_h1_with_trailing_whitespace() {
        assert_eq!(
            extract_title_from_content("#   Padded Title  \n"),
            Some("Padded Title".to_string())
        );
    }

    #[test]
    fn extract_title_returns_none_for_empty_h1() {
        assert_eq!(extract_title_from_content("# "), None);
        assert_eq!(extract_title_from_content("#  "), None);
    }

    #[test]
    fn extract_title_returns_none_for_no_h1() {
        assert_eq!(extract_title_from_content("Just some text"), None);
        assert_eq!(extract_title_from_content("## H2 heading\n"), None);
    }

    #[test]
    fn extract_title_returns_none_for_empty_content() {
        assert_eq!(extract_title_from_content(""), None);
    }

    #[test]
    fn list_custom_docs_uses_h1_title() {
        let root = temp_root("list-h1-title");
        write_file(
            &root,
            "docs/context/my-notes.md",
            "# User Chosen Title\n\nSome content\n",
        );
        write_file(&root, "docs/context/ref-data.md", "# Reference Data\n");

        let custom = list_custom_docs(&root);
        cleanup(&root);

        let by_id: HashMap<&str, &str> = custom
            .iter()
            .map(|(id, _, title, _)| (id.as_str(), title.as_str()))
            .collect();
        assert_eq!(by_id.get("custom:my-notes"), Some(&"User Chosen Title"));
        assert_eq!(by_id.get("custom:ref-data"), Some(&"Reference Data"));
    }

    #[test]
    fn list_custom_docs_falls_back_to_slug_title() {
        let root = temp_root("list-fallback");
        write_file(&root, "docs/context/no-h1.md", "Just text, no H1\n");

        let custom = list_custom_docs(&root);
        cleanup(&root);

        let by_id: HashMap<&str, &str> = custom
            .iter()
            .map(|(id, _, title, _)| (id.as_str(), title.as_str()))
            .collect();
        assert_eq!(by_id.get("custom:no-h1"), Some(&"No H1"));
    }

    // ── agent source tests ──

    #[test]
    fn is_safe_agent_basename_accepts_known() {
        assert!(is_safe_agent_basename("architect.md"));
        assert!(is_safe_agent_basename("repo-scout.md"));
        assert!(is_safe_agent_basename("inspector.md"));
        assert!(is_safe_agent_basename("sentinel.md"));
        assert!(is_safe_agent_basename("scribe.md"));
        assert!(is_safe_agent_basename("verifier.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_traversal() {
        assert!(!is_safe_agent_basename("../etc/passwd"));
        assert!(!is_safe_agent_basename("../../etc/passwd"));
        assert!(!is_safe_agent_basename("sub/../../etc/passwd"));
        assert!(!is_safe_agent_basename("architect.md/.."));
        assert!(!is_safe_agent_basename("a/../../../b.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_non_md() {
        assert!(!is_safe_agent_basename("architect.txt"));
        assert!(!is_safe_agent_basename("architect"));
        assert!(!is_safe_agent_basename(""));
        assert!(!is_safe_agent_basename(".hidden.md"));
        assert!(!is_safe_agent_basename("-starts-hyphen.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_slash() {
        assert!(!is_safe_agent_basename("sub/architect.md"));
        assert!(!is_safe_agent_basename("a/b/c.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_backslash() {
        assert!(!is_safe_agent_basename("sub\\architect.md"));
    }

    #[test]
    fn resolve_agent_path_rejects_unknown() {
        let root = temp_root("ag-resolve-unknown");
        write_file(&root, "agents/architect.md", "# architect\n");

        let result = resolve_agent_path(&root, "nonexistent.md");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown agent file"));
    }

    #[test]
    fn resolve_agent_path_rejects_traversal() {
        let root = temp_root("ag-resolve-traversal");
        write_file(&root, "agents/architect.md", "# architect\n");

        let result = resolve_agent_path(&root, "../etc/passwd");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid agent filename"));
    }

    #[test]
    fn resolve_agent_path_resolves_known() {
        let root = temp_root("ag-resolve-known");
        write_file(&root, "agents/architect.md", "# architect\n");

        let result = resolve_agent_path(&root, "architect.md");
        cleanup(&root);
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("agents/architect.md"));
    }

    fn write_agent_file(root: &Path, filename: &str, content: &str) {
        write_file(root, &format!("agents/{}", filename), content);
    }

    #[test]
    fn agent_source_read_resolves_content() {
        let root = temp_root("ag-read");
        write_agent_file(&root, "architect.md", "# Architect\n\nSome content.\n");

        let path = resolve_agent_path(&root, "architect.md").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        cleanup(&root);

        assert!(content.contains("# Architect"));
        assert!(content.contains("Some content."));
    }

    #[test]
    fn agent_source_title_from_filename() {
        assert_eq!(agent_title_from_filename("architect.md"), "Architect");
        assert_eq!(agent_title_from_filename("repo-scout.md"), "Repo Scout");
        assert_eq!(agent_title_from_filename("inspector.md"), "Inspector");
        assert_eq!(agent_title_from_filename("sentinel.md"), "Sentinel");
        assert_eq!(agent_title_from_filename("scribe.md"), "Scribe");
        assert_eq!(agent_title_from_filename("verifier.md"), "Verifier");
    }
}

#[tauri::command]
pub fn read_agent_template() -> Result<DocumentContent, String> {
    let bundle = bundled_library_root()?;
    read_agent_template_at_root(&bundle).map(|doc| with_pack_routing(doc, &bundle))
}

/// The bundled rules base, read from `bundle_root`.
fn read_agent_template_at_root(bundle_root: &Path) -> Result<DocumentContent, String> {
    let path = bundle_root.join("templates/global-agent-rules.md");
    let content = read_file_under_root(bundle_root, &path)?;
    Ok(DocumentContent {
        id: "agent-template".into(),
        title: "Agent Rules".into(),
        section: String::new(),
        path: "templates/global-agent-rules.md".into(),
        source: "curated".into(),
        content,
        revision: None,
    })
}

#[tauri::command]
pub fn read_config_template(target_id: String) -> Result<DocumentContent, String> {
    read_config_template_at_root(&bundled_library_root()?, &target_id)
}

/// The bundled template of a config target, read from `bundle_root` (shown read-only).
fn read_config_template_at_root(
    bundle_root: &Path,
    target_id: &str,
) -> Result<DocumentContent, String> {
    let target = agent_targets::bundled_config_targets()
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("unknown bundled config target: {}", target_id))?;
    let path = bundle_root.join(target.source_rel);
    let content = read_file_under_root(bundle_root, &path)?;
    Ok(DocumentContent {
        id: format!("config-template:{}", target_id),
        title: format!("{}.json", target_id),
        section: String::new(),
        path: target.source_rel.to_string(),
        source: "curated".into(),
        content,
        revision: None,
    })
}

// ── opencode config editor source commands ──

/// Read an opencode config editor source file (base, policy, or snapshot).
/// This is a narrow special case for activeConfigTargetId == "opencode_config".
#[tauri::command]
pub fn read_opencode_config_source(source_type: String) -> Result<DocumentContent, String> {
    read_opencode_config_source_at_root(&bundled_library_root()?, &source_type)
}

fn read_opencode_config_source_at_root(
    bundle_root: &Path,
    source_type: &str,
) -> Result<DocumentContent, String> {
    let source = agent_targets::opencode_config_editor_source_by_id(source_type)
        .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;
    let path = bundle_root.join(source.rel_path);
    let content = read_file_under_root(bundle_root, &path)?;

    Ok(DocumentContent {
        id: format!("opencode_config:{}", source_type),
        title: format!("{} Config", source.label),
        section: String::new(),
        path: source.rel_path.to_string(),
        source: "curated".into(),
        content,
        revision: None,
    })
}

/// Return the list of opencode config editor source metadata objects.
/// Used by the frontend to render the source selector.
#[tauri::command]
pub fn list_opencode_config_editor_sources() -> Vec<agent_targets::ConfigEditorSourceMeta> {
    agent_targets::opencode_config_editor_source_meta_list()
}

// ── agent source commands ──

const AGENTS_DIR: &str = "agents";

const KNOWN_AGENT_FILES: &[&str] = &[
    "architect.md",
    "repo-scout.md",
    "inspector.md",
    "sentinel.md",
    "scribe.md",
    "verifier.md",
];

fn is_safe_agent_basename(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    if name.starts_with('.') || name.starts_with('-') {
        return false;
    }
    if !name.ends_with(".md") {
        return false;
    }
    let stem = &name[..name.len() - 3];
    if stem.is_empty() {
        return false;
    }
    stem.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn resolve_agent_path(root: &Path, filename: &str) -> Result<PathBuf, String> {
    if !is_safe_agent_basename(filename) {
        return Err(format!("invalid agent filename: {}", filename));
    }
    if !KNOWN_AGENT_FILES.contains(&filename) {
        return Err(format!("unknown agent file: {}", filename));
    }
    let rel = format!("{}/{}", AGENTS_DIR, filename);
    let path = root.join(&rel);
    if !path.is_file() {
        return Err(format!("agent file not found: {}", filename));
    }
    safe_canonical_target(root, &path)?;
    Ok(path)
}

fn agent_title_from_filename(filename: &str) -> String {
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let mut title = String::with_capacity(stem.len());
    let mut capitalize = true;
    for c in stem.chars() {
        if c == '-' || c == '_' {
            title.push(' ');
            capitalize = true;
        } else if capitalize {
            title.push(c.to_ascii_uppercase());
            capitalize = false;
        } else {
            title.push(c);
        }
    }
    title
}

#[derive(Serialize)]
pub struct AgentSourceContent {
    pub id: String,
    pub title: String,
    pub path: String,
    pub content: String,
    pub exists: bool,
}

#[tauri::command]
pub fn read_agent_source(filename: String) -> Result<AgentSourceContent, String> {
    let root = bundled_library_root()?;
    let path = resolve_agent_path(&root, &filename)?;
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
    Ok(AgentSourceContent {
        id: filename.clone(),
        title: agent_title_from_filename(&filename),
        path: format!("{}/{}", AGENTS_DIR, filename),
        content,
        exists: true,
    })
}

// ── agent metadata sidecar ──

const AGENT_METADATA_REL: &str = "metadata/agents.json";
const MAX_AGENT_METADATA_SIZE: usize = 128 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct AgentMetadataEntry {
    pub role: String,
    pub summary: String,
    pub targets: Vec<String>,
    pub risk: String,
    pub default_skills: Vec<String>,
    pub safe_to_edit_runtime: bool,
    pub notes: Vec<String>,
}

#[derive(Deserialize)]
struct AgentMetadataFile {
    agents: std::collections::HashMap<String, AgentMetadataEntry>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AgentMetadataResponse {
    pub id: String,
    pub title: String,
    pub path: String,
    pub exists: bool,
    pub metadata: Option<AgentMetadataEntry>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AgentMetadataListResponse {
    pub agents: Vec<AgentMetadataResponse>,
    pub warnings: Vec<String>,
}

/// Load agent metadata sidecar. Returns (map, warnings).
/// Warnings are emitted for:
/// - oversized file (metadata ignored)
/// - invalid JSON (metadata ignored)
/// - unknown agent keys in metadata (no matching agent file)
/// - unreadable file (metadata ignored)
pub(crate) fn load_agent_metadata(
    root: &Path,
) -> (
    std::collections::HashMap<String, AgentMetadataEntry>,
    Vec<String>,
) {
    let mut warnings: Vec<String> = Vec::new();
    let path = root.join(AGENT_METADATA_REL);

    if !path.is_file() {
        return (std::collections::HashMap::new(), warnings);
    }

    let metadata = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            warnings.push(format!("cannot read agent metadata file metadata: {}", e));
            return (std::collections::HashMap::new(), warnings);
        }
    };

    if metadata.len() > MAX_AGENT_METADATA_SIZE as u64 {
        warnings.push(format!(
            "agent metadata file exceeds {} KB limit; metadata ignored",
            MAX_AGENT_METADATA_SIZE / 1024
        ));
        return (std::collections::HashMap::new(), warnings);
    }

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            warnings.push(format!("cannot read agent metadata file: {}", e));
            return (std::collections::HashMap::new(), warnings);
        }
    };

    let parsed: AgentMetadataFile = match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(e) => {
            warnings.push(format!("invalid agent metadata JSON: {}", e));
            return (std::collections::HashMap::new(), warnings);
        }
    };

    // Validate keys against known agent files
    let known = KNOWN_AGENT_FILES;
    for key in parsed.agents.keys() {
        if !known.contains(&key.as_str()) {
            warnings.push(format!(
                "agent metadata references unknown agent key '{}' (not in known agent files)",
                key
            ));
        }
    }

    (parsed.agents, warnings)
}

/// Validate default_skills in agent metadata against the skills found under `root`.
fn validate_agent_default_skills(
    metadata_map: &std::collections::HashMap<String, AgentMetadataEntry>,
    root: &Path,
) -> Vec<String> {
    let mut warnings: Vec<String> = Vec::new();
    let skills = match super::skills::discover_skills(root) {
        Ok(s) => s,
        Err(_) => return warnings,
    };
    let skill_names: std::collections::HashSet<&str> =
        skills.iter().map(|s| s.name.as_str()).collect();

    for (agent_id, entry) in metadata_map.iter() {
        for skill in &entry.default_skills {
            if !skill_names.contains(skill.as_str()) {
                warnings.push(format!(
                    "agent '{}' references unknown default skill '{}'",
                    agent_id, skill
                ));
            }
        }
    }

    warnings
}

#[tauri::command]
pub fn list_agent_metadata() -> Result<AgentMetadataListResponse, String> {
    let root = bundled_library_root()?;
    let (metadata_map, mut warnings) = load_agent_metadata(&root);

    // Validate default_skills against discovered skills
    let skill_warnings = validate_agent_default_skills(&metadata_map, &root);
    warnings.extend(skill_warnings);

    let known = KNOWN_AGENT_FILES;
    let agents_dir = root.join(AGENTS_DIR);

    let mut results: Vec<AgentMetadataResponse> = Vec::new();
    for filename in known {
        let path = format!("{}/{}", AGENTS_DIR, filename);
        let exists = agents_dir.join(filename).is_file();
        let metadata = metadata_map.get(filename.to_owned()).cloned();
        results.push(AgentMetadataResponse {
            id: filename.to_string(),
            title: agent_title_from_filename(filename),
            path,
            exists,
            metadata,
        });
    }
    Ok(AgentMetadataListResponse {
        agents: results,
        warnings,
    })
}

#[cfg(test)]
mod agent_metadata_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("riggverk-agmeta-{name}-{nonce}"))
    }

    fn write_metadata(root: &Path, json: &str) {
        let dir = root.join("metadata");
        fs::create_dir_all(&dir).expect("create metadata dir");
        fs::write(dir.join("agents.json"), json).expect("write agents.json");
    }

    fn write_agent_file(root: &Path, filename: &str) {
        let dir = root.join("agents");
        fs::create_dir_all(&dir).expect("create agents dir");
        fs::write(dir.join(filename), "# agent\n").expect("write agent file");
    }

    fn write_skill(root: &Path, name: &str) {
        let dir = root.join("skills").join(name);
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {}\ndescription: test\n---\n", name),
        )
        .expect("write skill");
    }

    #[test]
    fn missing_metadata_returns_none_for_all_agents() {
        let root = temp_root("no-meta");
        write_agent_file(&root, "architect.md");

        let (map, warnings) = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(map.is_empty());
        assert!(warnings.is_empty(), "no warnings for missing file");
    }

    #[test]
    fn valid_metadata_loads_for_known_agents() {
        let root = temp_root("valid-meta");
        write_agent_file(&root, "architect.md");
        write_agent_file(&root, "repo-scout.md");
        write_metadata(
            &root,
            r#"{"agents":{"architect.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["diagnose"],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let (map, warnings) = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(map.len(), 1);
        assert!(
            warnings.is_empty(),
            "valid metadata should produce no warnings"
        );
        let entry = map.get("architect.md").expect("architect metadata");
        assert_eq!(entry.role, "primary");
        assert_eq!(entry.risk, "medium");
        assert_eq!(entry.targets, vec!["opencode"]);
        assert!(!entry.safe_to_edit_runtime);
    }

    #[test]
    fn invalid_json_returns_empty_map_with_warning() {
        let root = temp_root("invalid-meta");
        write_agent_file(&root, "architect.md");
        write_metadata(&root, "not json");

        let (map, warnings) = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(map.is_empty());
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("invalid agent metadata JSON")),
            "invalid JSON should produce warning, got: {:?}",
            warnings
        );
    }

    #[test]
    fn oversized_metadata_rejected_with_warning() {
        let root = temp_root("oversized-meta");
        write_agent_file(&root, "architect.md");
        let big = format!(
            r#"{{"agents":{{"architect.md":{{"role":"primary","summary":"{}","targets":[],"risk":"low","default_skills":[],"safe_to_edit_runtime":false,"notes":[]}}}}}}"#,
            "x".repeat(MAX_AGENT_METADATA_SIZE)
        );
        write_metadata(&root, &big);

        let (map, warnings) = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(map.is_empty());
        assert!(
            warnings.iter().any(|w| w.contains("exceeds")),
            "oversized metadata should produce warning"
        );
    }

    #[test]
    fn unknown_agent_key_produces_warning() {
        let root = temp_root("unknown-key");
        write_agent_file(&root, "architect.md");
        write_metadata(
            &root,
            r#"{"agents":{"nonexistent.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["diagnose"],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let (map, warnings) = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        // nonexistent.md is in metadata but not a known agent
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("nonexistent.md"));
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("unknown agent key 'nonexistent.md'")),
            "unknown agent key should produce warning, got: {:?}",
            warnings
        );
    }

    #[test]
    fn unknown_default_skill_reference_produces_warning() {
        let root = temp_root("unknown-skill");
        write_agent_file(&root, "architect.md");
        write_skill(&root, "diagnose"); // needed so discover_skills can find something
        write_metadata(
            &root,
            r#"{"agents":{"architect.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["nonexistent-skill"],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let (map, _) = load_agent_metadata(&root);
        let skill_warnings = validate_agent_default_skills(&map, &root);
        let _ = fs::remove_dir_all(&root);

        assert!(
            skill_warnings
                .iter()
                .any(|w| w.contains("unknown default skill")),
            "unknown default skill should produce warning, got: {:?}",
            skill_warnings
        );
    }

    #[test]
    fn fixed_path_only_no_frontend_path_accepted() {
        // load_agent_metadata always uses the hardcoded AGENT_METADATA_REL path.
        // There is no parameter for a custom path — it only takes root: &Path.
        let root = temp_root("fixed-path");
        write_agent_file(&root, "architect.md");
        write_metadata(
            &root,
            r#"{"agents":{"architect.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":[],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let (_map, _) = load_agent_metadata(&root);

        // Write unrelated metadata file at a different path — it should NOT be read
        let alt_dir = root.join("some/other/path");
        fs::create_dir_all(&alt_dir).expect("create alt dir");
        fs::write(
            alt_dir.join("agents.json"),
            r#"{"agents":{"architect.md":{"role":"alt","summary":"alt","targets":[],"risk":"low","default_skills":[],"safe_to_edit_runtime":true,"notes":[]}}}"#,
        )
        .expect("write alt metadata");

        // Re-load — still uses the fixed path, new file should have no effect
        let (map2, _) = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(map2.len(), 1, "only metadata/agents.json is read");
        let entry = map2.get("architect.md").expect("architect metadata");
        assert_eq!(entry.role, "primary", "must use the fixed-path metadata");
    }

    // ── opencode config editor source tests ──

    fn ocs_write_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(&path, content).expect("write file");
    }

    fn ocs_cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn opencode_config_editor_source_unknown_type_rejected() {
        let root = temp_root("ocs-unknown");
        let result = read_opencode_config_source_at_root(&root, "unknown");
        ocs_cleanup(&root);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("unknown opencode config source"));
    }

    #[test]
    fn opencode_config_editor_source_base_reads_file() {
        let root = temp_root("ocs-base-read");
        ocs_write_file(
            &root,
            "templates/opencode.base.json",
            "{\"model\":\"gpt-4\"}",
        );
        let result = read_opencode_config_source_at_root(&root, "base");
        ocs_cleanup(&root);
        assert!(result.is_ok());
        let doc = result.unwrap();
        assert!(doc.content.contains("gpt-4"));
        assert_eq!(doc.id, "opencode_config:base");
        assert_eq!(doc.path, "templates/opencode.base.json");
    }

    #[test]
    fn opencode_config_editor_source_policy_reads_file() {
        let root = temp_root("ocs-policy-read");
        ocs_write_file(&root, "templates/opencode.policy.json", "{\"read\":{}}");
        let result = read_opencode_config_source_at_root(&root, "policy");
        ocs_cleanup(&root);
        assert!(result.is_ok());
        let doc = result.unwrap();
        assert!(doc.content.contains("read"));
        assert_eq!(doc.id, "opencode_config:policy");
        assert_eq!(doc.path, "templates/opencode.policy.json");
    }

    #[test]
    fn opencode_config_editor_source_snapshot_reads_file() {
        let root = temp_root("ocs-snapshot-read");
        ocs_write_file(&root, "templates/opencode.json", "{\"permission\":{}}");
        let result = read_opencode_config_source_at_root(&root, "snapshot");
        ocs_cleanup(&root);
        assert!(result.is_ok());
        let doc = result.unwrap();
        assert!(doc.content.contains("permission"));
        assert_eq!(doc.id, "opencode_config:snapshot");
    }

    #[test]
    fn opencode_config_editor_list_sources_returns_all() {
        let sources = agent_targets::opencode_config_editor_source_meta_list();
        let ids: Vec<&str> = sources.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["base", "policy", "snapshot"]);
    }

    #[test]
    fn opencode_config_runtime_sync_still_uses_opencode_json() {
        // Runtime sync target must still point to generated opencode.json
        let targets = agent_targets::config_targets();
        let opencode = targets.iter().find(|t| t.id == "opencode_config").unwrap();
        assert_eq!(opencode.source_rel, "templates/opencode.json");
        assert_eq!(opencode.target_rel, ".config/opencode/opencode.json");
    }
}
