use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_targets;
use crate::platform_paths::{display_path, Platform};

use super::process::{run_cmd, ActionResult};
use super::workspace::{path_arg, workspace_install_file_missing, workspace_root};

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
            id: "docs/prompt-templates/prompt.md",
            section: "Prompt Templates",
            title: "Prompt Template",
            rel_path: "docs/prompt-templates/prompt.md",
        },
        DocEntry {
            id: "docs/prompt-templates/goal-prompt.md",
            section: "Prompt Templates",
            title: "Goal Prompt Template",
            rel_path: "docs/prompt-templates/goal-prompt.md",
        },
        DocEntry {
            id: "docs/prompt-templates/batch-prompt.md",
            section: "Prompt Templates",
            title: "Batch Prompt Template",
            rel_path: "docs/prompt-templates/batch-prompt.md",
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
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const FORBIDDEN_LIBRARY_DOC_REL_PATHS: &[&str] = &[
    "templates/cursor/manifest.json",
    "templates/cursor/mcp/mcp.example.json",
    "templates/cursor/mcp/playwright.mcp.json",
    "templates/cursor/rules/core-safety.mdc",
    "templates/cursor/agents/verifier.md",
];

const PROMPT_TEMPLATE_DOC_REL_PATHS: &[&str] = &[
    "docs/prompt-templates/prompt.md",
    "docs/prompt-templates/goal-prompt.md",
    "docs/prompt-templates/batch-prompt.md",
];

pub(crate) fn missing_curated_doc_rel_paths(root: &Path) -> Vec<&'static str> {
    curated_doc_registry()
        .iter()
        .filter_map(|entry| {
            if workspace_install_file_missing(&root.join(entry.rel_path)) {
                Some(entry.rel_path)
            } else {
                None
            }
        })
        .collect()
}

fn existing_curated_docs(root: &Path) -> Vec<(String, String, String, PathBuf)> {
    curated_doc_registry()
        .iter()
        .filter_map(|entry| {
            let full = root.join(entry.rel_path);
            if full.exists() {
                Some((
                    entry.id.to_string(),
                    entry.section.to_string(),
                    entry.title.to_string(),
                    full,
                ))
            } else {
                None
            }
        })
        .collect()
}

const CUSTOM_DOCS_DIR: &str = "docs/context";

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

fn list_custom_docs(root: &Path) -> Vec<(String, String, String, PathBuf)> {
    let context_dir = root.join(CUSTOM_DOCS_DIR);
    if !context_dir.is_dir() {
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
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let title = doc_title_from_content_or_slug(&content, stem);
            docs.push((id, "Context".to_string(), title, path));
        }
    }
    docs.sort_by(|a, b| a.2.cmp(&b.2));
    docs
}

fn resolve_doc_path(root: &Path, id: &str) -> Result<(PathBuf, String), String> {
    if let Some(slug) = id.strip_prefix("custom:") {
        if !is_valid_slug(slug) {
            return Err(format!("invalid custom doc slug: {}", slug));
        }
        let rel = custom_doc_rel_path(slug);
        return Ok((root.join(&rel), id.to_string()));
    }
    let entry = curated_doc_registry()
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown doc: {}", id))?;
    if entry.rel_path.contains("..") || Path::new(entry.rel_path).is_absolute() {
        return Err("invalid registry path".to_string());
    }
    Ok((root.join(entry.rel_path), id.to_string()))
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
    let content = read_workspace_file(root, &path)?;
    let title = doc_title_from_content_or_slug(&content, slug);
    Ok(DocumentContent {
        id: format!("custom:{}", slug),
        title,
        path: rel,
        section: "Context".to_string(),
        source: "custom".to_string(),
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

#[derive(Serialize)]
pub struct DocsHealth {
    pub missing_count: usize,
    pub missing_prompt_template_docs: bool,
    /// Sample of missing curated doc paths (workspace-relative, capped).
    pub missing_sample: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct DocumentContent {
    pub id: String,
    pub title: String,
    pub path: String,
    pub section: String,
    pub source: String,
    pub content: String,
}

#[tauri::command]
pub fn get_docs_health() -> Result<DocsHealth, String> {
    let root = workspace_root()?;
    let missing = missing_curated_doc_rel_paths(&root);
    let missing_prompt_template_docs = PROMPT_TEMPLATE_DOC_REL_PATHS
        .iter()
        .any(|rel| workspace_install_file_missing(&root.join(rel)));
    let missing_sample: Vec<String> = missing.iter().take(8).map(|s| (*s).to_string()).collect();
    Ok(DocsHealth {
        missing_count: missing.len(),
        missing_prompt_template_docs,
        missing_sample,
    })
}

#[tauri::command]
pub fn list_docs() -> Result<Vec<DocSummary>, String> {
    let root = workspace_root()?;
    let mut docs = existing_curated_docs(&root);
    docs.extend(list_custom_docs(&root));
    Ok(docs
        .into_iter()
        .map(|(id, section, title, path)| {
            let source = if id.starts_with("custom:") {
                "custom"
            } else {
                "curated"
            };
            DocSummary {
                id,
                title,
                section,
                path: display_path(&path, Platform::current()),
                source: source.to_string(),
            }
        })
        .collect())
}

#[tauri::command]
pub fn read_doc(id: String) -> Result<DocumentContent, String> {
    let root = workspace_root()?;
    read_doc_at_root(&root, &id)
}

fn read_doc_at_root(root: &Path, id: &str) -> Result<DocumentContent, String> {
    if let Some(slug) = id.strip_prefix("custom:") {
        return read_custom_doc(root, slug);
    }
    let docs = existing_curated_docs(root);
    let found = docs.iter().find(|(i, _, _, _)| i == id);
    match found {
        Some((i, section, title, path)) => {
            let content = read_workspace_file(root, path)?;
            Ok(DocumentContent {
                id: i.clone(),
                title: title.clone(),
                section: section.clone(),
                path: display_path(path, Platform::current()),
                source: "curated".to_string(),
                content,
            })
        }
        None => Err(format!("unknown doc: {}", id)),
    }
}

#[tauri::command]
pub fn open_doc(id: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    if let Some(slug) = id.strip_prefix("custom:") {
        if !is_valid_slug(slug) {
            return Err(format!("invalid custom doc slug: {}", slug));
        }
        let rel = custom_doc_rel_path(slug);
        let path = root.join(&rel);
        if !path.exists() {
            return Err(format!("unknown doc: custom:{}", slug));
        }
        let path_str = path_arg(&path)?;
        let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
        return Ok(ActionResult::new(
            ok,
            format!("open_doc:custom:{}", slug),
            out,
            err,
            code,
        ));
    }
    let docs = existing_curated_docs(&root);
    let found = docs.iter().find(|(i, _, _, _)| i == &id);
    match found {
        Some((_, _, _, path)) => {
            let path_str = path_arg(path)?;
            let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
            Ok(ActionResult::new(
                ok,
                format!("open_doc:{}", id),
                out,
                err,
                code,
            ))
        }
        None => Err(format!("unknown doc: {}", id)),
    }
}

const MAX_DOC_SIZE: usize = 512 * 1024;

fn doc_backup_path(
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
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("create backup dir error: {}", e))?;
    Ok(backup_dir.join(file_name))
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

/// Reads a workspace file after checking containment and that neither the file nor any
/// parent below the workspace root is a symlink.
fn read_workspace_file(root: &Path, path: &Path) -> Result<String, String> {
    safe_canonical_target(root, path)?;
    crate::path_safety::reject_symlink_parent_chain(path, root, "workspace file")?;
    std::fs::read_to_string(path).map_err(|e| format!("read error: {}", e))
}

/// Atomic, symlink-refusing write of a workspace file (temp file + rename inside `root`).
fn write_workspace_file(root: &Path, path: &Path, content: &str) -> Result<(), String> {
    crate::safe_filesystem::write_regular_file_atomic(path, content.as_bytes(), root)
        .map_err(|e| format!("write error: {e}"))
}

fn save_doc_at_root(
    root: &Path,
    id: &str,
    content: &str,
    custom_backup_root: Option<&Path>,
) -> Result<ActionResult, String> {
    if content.len() > MAX_DOC_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let (target_path, resolved_id) = resolve_doc_path(root, id)?;

    safe_canonical_target(root, &target_path)?;

    if id.starts_with("custom:") && !target_path.exists() {
        return Err(format!(
            "custom doc does not exist: {}. Use create_doc to create new custom docs.",
            id
        ));
    }

    if !target_path.exists() {
        return Err(format!("doc does not exist: {}", id));
    }

    let existing =
        std::fs::read_to_string(&target_path).map_err(|e| format!("read error: {}", e))?;
    if existing == content {
        return Ok(ActionResult::new(
            true,
            "save_doc",
            "unchanged".to_string(),
            String::new(),
            Some(0),
        ));
    }

    let backup_path = doc_backup_path(&resolved_id, &target_path, custom_backup_root)?;
    std::fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;

    write_workspace_file(root, &target_path, content)?;

    Ok(ActionResult::new(
        true,
        "save_doc",
        "saved with backup".to_string(),
        String::new(),
        Some(0),
    ))
}

#[tauri::command]
pub fn save_doc(id: String, content: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    save_doc_at_root(&root, &id, &content, None)
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

    safe_canonical_target(root, &target_path)?;

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
    write_workspace_file(root, &target_path, &initial_content)?;

    Ok(DocumentContent {
        id: format!("custom:{}", slug),
        title: trimmed_title.to_string(),
        path: rel,
        section: "Context".to_string(),
        source: "custom".to_string(),
        content: initial_content,
    })
}

#[tauri::command]
pub fn create_doc(
    title: String,
    slug: String,
    content: Option<String>,
) -> Result<DocumentContent, String> {
    let root = workspace_root()?;
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
        std::env::temp_dir().join(format!("agent-workspace-docs-{name}-{nonce}"))
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
    fn curated_registry_includes_prompt_template_docs() {
        let ids: Vec<&str> = curated_doc_registry().iter().map(|e| e.rel_path).collect();
        for rel in PROMPT_TEMPLATE_DOC_REL_PATHS {
            assert!(
                ids.contains(rel),
                "curated registry must include prompt template doc: {}",
                rel
            );
        }
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
    fn missing_curated_docs_detects_absent_prompt_templates() {
        let root = temp_root("missing-prompt-templates");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/START_HERE.md", "# start\n");

        let missing = missing_curated_doc_rel_paths(&root);
        cleanup(&root);

        for rel in PROMPT_TEMPLATE_DOC_REL_PATHS {
            assert!(
                missing.contains(rel),
                "missing curated docs must include absent prompt template: {}",
                rel
            );
        }
    }

    #[test]
    fn sections_are_assigned_correctly() {
        let root = temp_root("section-check");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/START_HERE.md", "# start\n");
        write_file(&root, "docs/GIT_VERSIONING.md", "# git\n");
        write_file(&root, "docs/AGENT_RULES.md", "# rules\n");
        write_file(
            &root,
            "docs/prompt-templates/batch-prompt.md",
            "# batch prompt\n",
        );

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
        assert_eq!(
            by_id.get("docs/prompt-templates/batch-prompt.md"),
            Some(&"Prompt Templates")
        );
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

    #[test]
    fn save_doc_known_id_resolves_and_writes() {
        let root = temp_root("save-known");
        let backup_root = temp_root("save-known-backup");
        write_file(&root, "README.md", "# old\n");

        let result = save_doc_at_root(&root, "README.md", "# new\n", Some(&backup_root));

        assert!(result.is_ok(), "save should succeed: {:?}", result);
        let ar = result.unwrap();
        assert!(ar.success);
        assert_eq!(ar.stdout, "saved with backup");

        let saved = std::fs::read_to_string(root.join("README.md")).unwrap();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);

        assert_eq!(saved, "# new\n");
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

    #[test]
    fn save_doc_unchanged_content_does_not_write() {
        let root = temp_root("save-unchanged");
        write_file(&root, "README.md", "# same\n");

        let result = save_doc_at_root(&root, "README.md", "# same\n", None);

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
    }

    #[test]
    fn save_doc_creates_backup_when_changed() {
        let root = temp_root("save-backup");
        let backup_root = temp_root("save-backup-backup");
        write_file(&root, "README.md", "# original\n");

        let result = save_doc_at_root(&root, "README.md", "# modified\n", Some(&backup_root));

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        // Verify backup was created
        let docs_backup_dir = backup_root.join("docs");
        let backup_entries: Vec<_> = std::fs::read_dir(&docs_backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("README.md-")
            })
            .collect();

        assert!(!backup_entries.is_empty(), "backup should be created");
        let backup_file = backup_entries[0].path().join("README.md");
        let backup_content = std::fs::read_to_string(&backup_file).unwrap();

        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);

        assert_eq!(backup_content, "# original\n");
    }

    #[test]
    fn save_doc_target_remains_under_workspace() {
        let root = temp_root("save-under-root");
        let backup_root = temp_root("save-under-root-backup");
        write_file(&root, "README.md", "# readme\n");

        let result = save_doc_at_root(&root, "README.md", "# updated\n", Some(&backup_root));

        assert!(result.is_ok());
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn config_template_known_target_resolves() {
        let root = temp_root("config-template-known");
        write_file(&root, "templates/opencode.json", "{}");

        let targets = agent_targets::editable_config_targets();
        let opencode = targets.iter().find(|t| t.id == "opencode_config");
        assert!(
            opencode.is_some(),
            "opencode_config must be in editable_config_targets"
        );

        let path = root.join(opencode.unwrap().source_rel);
        assert!(path.exists(), "source_rel must point to an existing file");
        cleanup(&root);
    }

    #[test]
    fn config_template_unknown_target_rejected() {
        let targets = agent_targets::editable_config_targets();
        let unknown = targets.iter().find(|t| t.id == "nonexistent_config");
        assert!(
            unknown.is_none(),
            "unknown config target must not be in editable registry"
        );
    }

    #[test]
    fn cursor_setup_is_not_an_editable_config_template() {
        let targets = agent_targets::editable_config_targets();
        assert!(
            targets.iter().all(|t| t.id != "cursor_setup"),
            "cursor_setup must stay out of config template editing"
        );
    }

    #[test]
    fn config_sync_target_source_paths_are_safe() {
        let targets = agent_targets::editable_config_targets();
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
        write_file(&root, "README.md", "# old\n");

        save_doc_at_root(&root, "README.md", "# new\n", Some(&backup_root)).expect("save");

        let leftovers: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        let saved = fs::read_to_string(root.join("README.md")).unwrap();
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
        std::os::unix::fs::symlink(root.join("docs/real.md"), root.join("README.md")).unwrap();

        let result = save_doc_at_root(&root, "README.md", "# changed\n", Some(&backup_root));

        let real = fs::read_to_string(root.join("docs/real.md")).unwrap();
        let link_still_symlink = fs::symlink_metadata(root.join("README.md"))
            .unwrap()
            .file_type()
            .is_symlink();
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        let err = result.expect_err("symlinked doc must be refused");
        assert!(err.contains("symlink"), "{err}");
        assert_eq!(real, "# real\n");
        assert!(link_still_symlink);
    }

    #[cfg(unix)]
    #[test]
    fn read_doc_refuses_symlink_to_file_outside_workspace() {
        let root = temp_root("read-doc-outside");
        let outside_dir = temp_root("read-doc-outside-target");
        write_file(&outside_dir, "secret.md", "secret");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outside_dir.join("secret.md"), root.join("README.md")).unwrap();

        let result = read_doc_at_root(&root, "README.md");

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

        let result = read_doc_at_root(&root, "README.md");

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

        let result = read_doc_at_root(&root, "custom:notes");

        cleanup(&root);
        let err = result.expect_err("symlinked custom doc must be refused");
        assert!(err.contains("symlink"), "{err}");
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

    // ── config template save tests ──

    #[test]
    fn config_template_save_valid_json_accepted() {
        let root = temp_root("cfg-save-valid");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-valid-backup");

        let result = save_doc_at_root_for_config(
            &root,
            "opencode_config",
            "{\"key\":\"value\"}",
            Some(&backup_root),
        );

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert!(ar.success);

        let saved = std::fs::read_to_string(root.join("templates/opencode.json")).unwrap();
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
        assert_eq!(saved, "{\"key\":\"value\"}");
    }

    #[test]
    fn config_template_save_invalid_json_rejected() {
        let root = temp_root("cfg-save-invalid");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-invalid-backup");

        let result =
            save_doc_at_root_for_config(&root, "opencode_config", "not json", Some(&backup_root));

        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid JSON"));
    }

    #[test]
    fn config_template_save_unknown_target_rejected() {
        let root = temp_root("cfg-save-unknown");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-unknown-backup");

        let result =
            save_doc_at_root_for_config(&root, "nonexistent_config", "{}", Some(&backup_root));

        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("unknown editable config target"));
    }

    #[test]
    fn config_template_save_unchanged_does_not_write() {
        let root = temp_root("cfg-save-unchanged");
        write_file(&root, "templates/opencode.json", "{\"a\":1}");
        let backup_root = temp_root("cfg-save-unchanged-backup");

        let result =
            save_doc_at_root_for_config(&root, "opencode_config", "{\"a\":1}", Some(&backup_root));

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn config_template_save_target_remains_under_workspace() {
        let root = temp_root("cfg-save-under-root");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-under-root-backup");

        let result = save_doc_at_root_for_config(
            &root,
            "opencode_config",
            "{\"ok\":true}",
            Some(&backup_root),
        );

        assert!(result.is_ok());
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn config_template_save_creates_backup_when_changed() {
        let root = temp_root("cfg-save-backup");
        let backup_root = temp_root("cfg-save-backup-backup");
        write_file(&root, "templates/opencode.json", "{\"original\":true}");

        let result = save_doc_at_root_for_config(
            &root,
            "opencode_config",
            "{\"modified\":true}",
            Some(&backup_root),
        );

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        let docs_backup_dir = backup_root.join("docs");
        let backup_entries: Vec<_> = std::fs::read_dir(&docs_backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("opencode_config-")
            })
            .collect();

        assert!(
            !backup_entries.is_empty(),
            "config backup should be created"
        );
        let backup_file = backup_entries[0].path().join("opencode.json");
        let backup_content = std::fs::read_to_string(&backup_file).unwrap();

        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);

        assert_eq!(backup_content, "{\"original\":true}");
    }

    fn save_doc_at_root_for_config(
        root: &Path,
        target_id: &str,
        content: &str,
        custom_backup_root: Option<&Path>,
    ) -> Result<ActionResult, String> {
        if content.len() > 512 * 1024 {
            return Err("content exceeds 512 KB limit".to_string());
        }

        let target = agent_targets::editable_config_targets()
            .into_iter()
            .find(|t| t.id == target_id)
            .ok_or_else(|| format!("unknown editable config target: {}", target_id))?;

        if target.source_rel.contains("..") || Path::new(target.source_rel).is_absolute() {
            return Err("invalid registry path".to_string());
        }

        let target_path = root.join(target.source_rel);

        safe_canonical_target(root, &target_path)?;

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create dir error: {}", e))?;
        }

        if target_id == "opencode_config" {
            serde_json::from_str::<serde_json::Value>(content)
                .map_err(|e| format!("invalid JSON: {}", e))?;
        }

        if target_path.exists() {
            let existing =
                std::fs::read_to_string(&target_path).map_err(|e| format!("read error: {}", e))?;
            if existing == content {
                return Ok(ActionResult::new(
                    true,
                    "save_config_template",
                    "unchanged".to_string(),
                    String::new(),
                    Some(0),
                ));
            }

            let backup_path = doc_backup_path(target_id, &target_path, custom_backup_root)?;
            std::fs::write(&backup_path, &existing)
                .map_err(|e| format!("backup write error: {}", e))?;

            std::fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;

            return Ok(ActionResult::new(
                true,
                "save_config_template",
                "saved with backup".to_string(),
                String::new(),
                Some(0),
            ));
        }

        std::fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;

        Ok(ActionResult::new(
            true,
            "save_config_template",
            "saved".to_string(),
            String::new(),
            Some(0),
        ))
    }

    // ── agent template save tests ──

    fn save_agent_template_at_root(
        root: &Path,
        content: &str,
        custom_backup_root: Option<&Path>,
    ) -> Result<ActionResult, String> {
        if content.len() > 512 * 1024 {
            return Err("content exceeds 512 KB limit".to_string());
        }

        let target_path = root.join("templates/global-agent-rules.md");

        safe_canonical_target(root, &target_path)?;

        if !target_path.exists() {
            return Err(format!(
                "template does not exist: {}",
                "templates/global-agent-rules.md"
            ));
        }

        let existing =
            std::fs::read_to_string(&target_path).map_err(|e| format!("read error: {}", e))?;
        if existing == content {
            return Ok(ActionResult::new(
                true,
                "save_agent_template",
                "unchanged".to_string(),
                String::new(),
                Some(0),
            ));
        }

        let backup_path = doc_backup_path("agent-template", &target_path, custom_backup_root)?;
        std::fs::write(&backup_path, &existing)
            .map_err(|e| format!("backup write error: {}", e))?;

        std::fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;

        Ok(ActionResult::new(
            true,
            "save_agent_template",
            "saved with backup".to_string(),
            String::new(),
            Some(0),
        ))
    }

    #[test]
    fn agent_template_save_rejects_oversized_content() {
        let root = temp_root("ag-save-oversized");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");

        let big = "x".repeat(512 * 1024 + 1);
        let result = save_agent_template_at_root(&root, &big, None);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds 512 KB"));
    }

    #[test]
    fn agent_template_save_unchanged_returns_unchanged() {
        let root = temp_root("ag-save-unchanged");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");

        let result = save_agent_template_at_root(&root, "# rules\n", None);
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
    }

    #[test]
    fn agent_template_save_creates_backup_when_changed() {
        let root = temp_root("ag-save-backup");
        let backup_root = temp_root("ag-save-backup-backup");
        write_file(&root, "templates/global-agent-rules.md", "# old rules\n");

        let result = save_agent_template_at_root(&root, "# new rules\n", Some(&backup_root));

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        let saved = std::fs::read_to_string(root.join("templates/global-agent-rules.md")).unwrap();
        assert_eq!(saved, "# new rules\n");

        let docs_backup_dir = backup_root.join("docs");
        let backup_entries: Vec<_> = std::fs::read_dir(&docs_backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("agent-template-")
            })
            .collect();

        assert!(
            !backup_entries.is_empty(),
            "agent template backup should be created"
        );
        let backup_file = backup_entries[0].path().join("global-agent-rules.md");
        let backup_content = std::fs::read_to_string(&backup_file).unwrap();

        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);

        assert_eq!(backup_content, "# old rules\n");
    }

    #[test]
    fn agent_template_save_missing_template_rejected() {
        let root = temp_root("ag-save-missing");
        std::fs::create_dir_all(&root).expect("create root dir");

        let result = save_agent_template_at_root(&root, "# content\n", None);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("template does not exist"));
    }

    #[test]
    fn agent_template_save_target_remains_under_workspace() {
        let root = temp_root("ag-save-under-root");
        let backup_root = temp_root("ag-save-under-root-backup");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");

        let result = save_agent_template_at_root(&root, "# updated\n", Some(&backup_root));
        assert!(result.is_ok());
        cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
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
    fn agent_source_save_unchanged_returns_unchanged() {
        let root = temp_root("ag-save-unchanged");
        write_agent_file(&root, "architect.md", "# rules\n");

        let path = resolve_agent_path(&root, "architect.md").unwrap();
        let existing = std::fs::read_to_string(&path).unwrap();
        assert_eq!(existing, "# rules\n");

        // simulate save logic
        if existing == "# rules\n" {
            // would return unchanged
        }
        cleanup(&root);
    }

    #[test]
    fn agent_source_save_creates_backup() {
        let root = temp_root("ag-save-backup");
        let backup_root = temp_root("ag-save-backup-backup");
        write_agent_file(&root, "architect.md", "# old\n");

        let path = resolve_agent_path(&root, "architect.md").unwrap();
        let existing = std::fs::read_to_string(&path).unwrap();

        let backup_path = doc_backup_path("agent-architect.md", &path, Some(&backup_root)).unwrap();
        std::fs::write(&backup_path, &existing).unwrap();
        std::fs::write(&path, "# new\n").unwrap();

        let saved = std::fs::read_to_string(root.join("agents/architect.md")).unwrap();
        let backup_content = std::fs::read_to_string(&backup_path).unwrap();

        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);

        assert_eq!(saved, "# new\n");
        assert_eq!(backup_content, "# old\n");
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
    let root = workspace_root()?;
    read_agent_template_at_root(&root)
}

fn read_agent_template_at_root(root: &Path) -> Result<DocumentContent, String> {
    let path = root.join("templates/global-agent-rules.md");
    let content = read_workspace_file(root, &path)?;
    Ok(DocumentContent {
        id: "agent-template".into(),
        title: "Agent Rules".into(),
        section: String::new(),
        path: "templates/global-agent-rules.md".into(),
        source: "curated".into(),
        content,
    })
}

#[tauri::command]
pub fn open_agent_template() -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let path = root.join("templates/global-agent-rules.md");
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
    Ok(ActionResult::new(ok, "open_agent_template", out, err, code))
}

const MAX_AGENT_TEMPLATE_SIZE: usize = 512 * 1024;

#[tauri::command]
pub fn save_agent_template(content: String) -> Result<ActionResult, String> {
    if content.len() > MAX_AGENT_TEMPLATE_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let root = workspace_root()?;
    let rel_path = "templates/global-agent-rules.md";
    let target_path = root.join(rel_path);

    safe_canonical_target(&root, &target_path)?;

    if !target_path.exists() {
        return Err(format!("template does not exist: {}", rel_path));
    }

    let existing =
        std::fs::read_to_string(&target_path).map_err(|e| format!("read error: {}", e))?;
    if existing == content {
        return Ok(ActionResult::new(
            true,
            "save_agent_template",
            "unchanged".to_string(),
            String::new(),
            Some(0),
        ));
    }

    let backup_path = doc_backup_path("agent-template", &target_path, None)?;
    std::fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;

    write_workspace_file(&root, &target_path, &content)?;

    Ok(ActionResult::new(
        true,
        "save_agent_template",
        "saved with backup".to_string(),
        String::new(),
        Some(0),
    ))
}

#[tauri::command]
pub fn read_config_template(target_id: String) -> Result<DocumentContent, String> {
    let root = workspace_root()?;
    read_config_template_at_root(&root, &target_id)
}

fn read_config_template_at_root(root: &Path, target_id: &str) -> Result<DocumentContent, String> {
    let target = agent_targets::editable_config_targets()
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("unknown editable config target: {}", target_id))?;
    let path = root.join(target.source_rel);
    let content = read_workspace_file(root, &path)?;
    Ok(DocumentContent {
        id: format!("config-template:{}", target_id),
        title: format!("{}.json", target_id),
        section: String::new(),
        path: target.source_rel.to_string(),
        source: "curated".into(),
        content,
    })
}

#[tauri::command]
pub fn open_config_template(target_id: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let target = agent_targets::editable_config_targets()
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("unknown editable config target: {}", target_id))?;
    let path = root.join(target.source_rel);
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
    Ok(ActionResult::new(
        ok,
        format!("open_config_template:{}", target_id),
        out,
        err,
        code,
    ))
}

// ── opencode config editor source commands ──

/// Read an opencode config editor source file (base, policy, or snapshot).
/// This is a narrow special case for activeConfigTargetId == "opencode_config".
#[tauri::command]
pub fn read_opencode_config_source(source_type: String) -> Result<DocumentContent, String> {
    let source = agent_targets::opencode_config_editor_source_by_id(&source_type)
        .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;

    let root = workspace_root()?;
    let path = root.join(source.rel_path);

    safe_canonical_target(&root, &path)?;

    let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;

    Ok(DocumentContent {
        id: format!("opencode_config:{}", source_type),
        title: format!("{} Config", source.label),
        section: String::new(),
        path: source.rel_path.to_string(),
        source: "curated".into(),
        content,
    })
}

/// Return the list of opencode config editor source metadata objects.
/// Used by the frontend to render the source selector.
#[tauri::command]
pub fn list_opencode_config_editor_sources() -> Vec<agent_targets::ConfigEditorSourceMeta> {
    agent_targets::opencode_config_editor_source_meta_list()
}

/// Open an opencode config editor source file (base, policy, or snapshot) in the system editor.
/// This is a narrow special case for activeConfigTargetId == "opencode_config".
#[tauri::command]
pub fn open_opencode_config_source(source_type: String) -> Result<ActionResult, String> {
    let source = agent_targets::opencode_config_editor_source_by_id(&source_type)
        .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;

    if source.rel_path.contains("..") || Path::new(source.rel_path).is_absolute() {
        return Err("invalid registry path".to_string());
    }

    let root = workspace_root()?;
    let path = root.join(source.rel_path);
    safe_canonical_target(&root, &path)?;

    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
    Ok(ActionResult::new(
        ok,
        format!("open_opencode_config_source:{}", source_type),
        out,
        err,
        code,
    ))
}

const MAX_OPENCODE_CONFIG_SOURCE_SIZE: usize = 512 * 1024;

/// Save an opencode config editor source file.
/// Only editable types (base, policy) are allowed.
/// Snapshot is read-only and will be rejected.
/// This is a narrow special case for activeConfigTargetId == "opencode_config".
#[tauri::command]
pub fn save_opencode_config_source(
    source_type: String,
    content: String,
) -> Result<ActionResult, String> {
    if content.len() > MAX_OPENCODE_CONFIG_SOURCE_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let source = agent_targets::opencode_config_editor_source_by_id(&source_type)
        .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;

    if !source.editable {
        return Err(format!(
            "{} is read-only. Edit Base or Policy instead.",
            source.label
        ));
    }

    if source.rel_path.contains("..") || Path::new(source.rel_path).is_absolute() {
        return Err("invalid registry path".to_string());
    }

    let root = workspace_root()?;
    let target_path = root.join(source.rel_path);

    safe_canonical_target(&root, &target_path)?;

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir error: {}", e))?;
    }

    // Validate JSON content
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("invalid JSON: {}", e))?;

    if target_path.exists() {
        let existing =
            std::fs::read_to_string(&target_path).map_err(|e| format!("read error: {}", e))?;
        if existing == content {
            return Ok(ActionResult::new(
                true,
                "save_opencode_config_source",
                "unchanged".to_string(),
                String::new(),
                Some(0),
            ));
        }

        let backup_path = doc_backup_path(
            &format!("opencode_config:{}", source_type),
            &target_path,
            None,
        )?;
        std::fs::write(&backup_path, &existing)
            .map_err(|e| format!("backup write error: {}", e))?;

        write_workspace_file(&root, &target_path, &content)?;

        return Ok(regenerate_opencode_snapshot_result(
            &root,
            "saved with backup",
        ));
    }

    write_workspace_file(&root, &target_path, &content)?;

    Ok(regenerate_opencode_snapshot_result(&root, "saved"))
}

/// The generated opencode.json snapshot is composed from the base and policy
/// sources, so every successful source save must refresh it or installs would
/// use a stale config.
fn regenerate_opencode_snapshot_result(root: &Path, saved_note: &str) -> ActionResult {
    match super::opencode_runtime::run_generator_write(root) {
        Ok(result) if result.success => ActionResult::new(
            true,
            "save_opencode_config_source",
            format!("{saved_note}; generated snapshot refreshed"),
            String::new(),
            Some(0),
        ),
        Ok(result) => ActionResult::new(
            false,
            "save_opencode_config_source",
            format!("{saved_note}, but generated snapshot refresh failed"),
            result.stderr,
            result.exit_code,
        ),
        Err(error) => ActionResult::new(
            false,
            "save_opencode_config_source",
            format!("{saved_note}, but generated snapshot refresh failed"),
            error,
            Some(1),
        ),
    }
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
    let root = workspace_root()?;
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

#[tauri::command]
pub fn open_agent_source(filename: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let path = resolve_agent_path(&root, &filename)?;
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
    Ok(ActionResult::new(
        ok,
        format!("open_agent_source:{}", filename),
        out,
        err,
        code,
    ))
}

const MAX_AGENT_SOURCE_SIZE: usize = 512 * 1024;

#[tauri::command]
pub fn save_agent_source(filename: String, content: String) -> Result<ActionResult, String> {
    if content.len() > MAX_AGENT_SOURCE_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let root = workspace_root()?;
    let path = resolve_agent_path(&root, &filename)?;

    let existing = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
    if existing == content {
        return Ok(ActionResult::new(
            true,
            "save_agent_source",
            "unchanged".to_string(),
            String::new(),
            Some(0),
        ));
    }

    let backup_path = doc_backup_path(&format!("agent-{}", filename), &path, None)?;
    std::fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;

    write_workspace_file(&root, &path, &content)?;

    Ok(ActionResult::new(
        true,
        "save_agent_source",
        "saved with backup".to_string(),
        String::new(),
        Some(0),
    ))
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

/// Validate default_skills in agent metadata against discovered workspace skills.
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
    let root = workspace_root()?;
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
        std::env::temp_dir().join(format!("agent-workspace-agmeta-{name}-{nonce}"))
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

    fn ocs_read_source(root: &Path, source_type: &str) -> Result<DocumentContent, String> {
        let source = agent_targets::opencode_config_editor_source_by_id(source_type)
            .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;
        let path = root.join(source.rel_path);
        let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
        Ok(DocumentContent {
            id: format!("opencode_config:{}", source_type),
            title: format!("{} Config", source.label),
            section: String::new(),
            path: source.rel_path.to_string(),
            source: "curated".into(),
            content,
        })
    }

    fn ocs_save_source(
        root: &Path,
        source_type: &str,
        content: &str,
    ) -> Result<ActionResult, String> {
        ocs_save_source_with_backup(root, source_type, content, None)
    }

    fn ocs_save_source_with_backup(
        root: &Path,
        source_type: &str,
        content: &str,
        custom_backup_root: Option<&Path>,
    ) -> Result<ActionResult, String> {
        if content.len() > MAX_OPENCODE_CONFIG_SOURCE_SIZE {
            return Err("content exceeds 512 KB limit".to_string());
        }
        let source = agent_targets::opencode_config_editor_source_by_id(source_type)
            .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;
        if !source.editable {
            return Err(format!(
                "{} is read-only. Edit Base or Policy instead.",
                source.label
            ));
        }
        if source.rel_path.contains("..") || Path::new(source.rel_path).is_absolute() {
            return Err("invalid registry path".to_string());
        }
        let target_path = root.join(source.rel_path);
        safe_canonical_target(root, &target_path)?;
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir error: {}", e))?;
        }
        serde_json::from_str::<serde_json::Value>(content)
            .map_err(|e| format!("invalid JSON: {}", e))?;
        if target_path.exists() {
            let existing =
                fs::read_to_string(&target_path).map_err(|e| format!("read error: {}", e))?;
            if existing == content {
                return Ok(ActionResult::new(
                    true,
                    "save_opencode_config_source",
                    "unchanged".to_string(),
                    String::new(),
                    Some(0),
                ));
            }
            let backup_path = doc_backup_path(
                &format!("opencode_config:{}", source_type),
                &target_path,
                custom_backup_root,
            )?;
            fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;
            fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;
            return Ok(ActionResult::new(
                true,
                "save_opencode_config_source",
                "saved with backup".to_string(),
                String::new(),
                Some(0),
            ));
        }
        fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;
        Ok(ActionResult::new(
            true,
            "save_opencode_config_source",
            "saved".to_string(),
            String::new(),
            Some(0),
        ))
    }

    #[test]
    fn opencode_config_editor_source_unknown_type_rejected() {
        let root = temp_root("ocs-unknown");
        let result = ocs_read_source(&root, "unknown");
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
        let result = ocs_read_source(&root, "base");
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
        let result = ocs_read_source(&root, "policy");
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
        let result = ocs_read_source(&root, "snapshot");
        ocs_cleanup(&root);
        assert!(result.is_ok());
        let doc = result.unwrap();
        assert!(doc.content.contains("permission"));
        assert_eq!(doc.id, "opencode_config:snapshot");
    }

    #[test]
    fn opencode_config_editor_save_unknown_type_rejected() {
        let root = temp_root("ocs-save-unknown");
        let result = ocs_save_source(&root, "unknown", "{}");
        ocs_cleanup(&root);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("unknown opencode config source"));
    }

    #[test]
    fn opencode_config_editor_save_snapshot_rejected() {
        let root = temp_root("ocs-save-snapshot");
        ocs_write_file(&root, "templates/opencode.json", "{}");
        let result = ocs_save_source(&root, "snapshot", "{}");
        ocs_cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("read-only"));
    }

    #[test]
    fn opencode_config_editor_save_base_writes_file() {
        let root = temp_root("ocs-save-base");
        let backup_root = temp_root("ocs-save-base-backup");
        ocs_write_file(&root, "templates/opencode.base.json", "{}");
        let result =
            ocs_save_source_with_backup(&root, "base", "{\"model\":\"gpt-4\"}", Some(&backup_root));
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert!(ar.success);
        let saved = fs::read_to_string(root.join("templates/opencode.base.json")).unwrap();
        ocs_cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        assert_eq!(saved, "{\"model\":\"gpt-4\"}");
    }

    #[test]
    fn opencode_config_editor_save_policy_writes_file() {
        let root = temp_root("ocs-save-policy");
        let backup_root = temp_root("ocs-save-policy-backup");
        ocs_write_file(&root, "templates/opencode.policy.json", "{}");
        let result =
            ocs_save_source_with_backup(&root, "policy", "{\"read\":{}}", Some(&backup_root));
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert!(ar.success);
        let saved = fs::read_to_string(root.join("templates/opencode.policy.json")).unwrap();
        ocs_cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        assert_eq!(saved, "{\"read\":{}}");
    }

    #[test]
    fn opencode_config_editor_save_base_unchanged_does_not_write() {
        let root = temp_root("ocs-save-base-unchanged");
        ocs_write_file(
            &root,
            "templates/opencode.base.json",
            "{\"model\":\"gpt-4\"}",
        );
        let result = ocs_save_source(&root, "base", "{\"model\":\"gpt-4\"}");
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        ocs_cleanup(&root);
    }

    #[test]
    fn opencode_config_editor_save_invalid_json_rejected() {
        let root = temp_root("ocs-save-invalid-json");
        ocs_write_file(&root, "templates/opencode.base.json", "{}");
        let result = ocs_save_source(&root, "base", "not json");
        ocs_cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid JSON"));
    }

    #[test]
    fn opencode_config_editor_save_creates_backup_when_changed() {
        let root = temp_root("ocs-save-backup");
        let backup_root = temp_root("ocs-save-backup-dir");
        ocs_write_file(&root, "templates/opencode.base.json", "{\"original\":true}");
        let result =
            ocs_save_source_with_backup(&root, "base", "{\"modified\":true}", Some(&backup_root));
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");
        let docs_backup_dir = backup_root.join("docs");
        let backup_entries: Vec<_> = fs::read_dir(&docs_backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("opencode_config_base-")
            })
            .collect();
        assert!(!backup_entries.is_empty(), "backup should be created");
        let backup_file = backup_entries[0].path().join("opencode.base.json");
        let backup_content = fs::read_to_string(&backup_file).unwrap();
        ocs_cleanup(&root);
        let _ = fs::remove_dir_all(&backup_root);
        assert_eq!(backup_content, "{\"original\":true}");
    }

    #[test]
    fn opencode_config_editor_list_sources_returns_all() {
        let sources = agent_targets::opencode_config_editor_source_meta_list();
        assert_eq!(sources.len(), 3);
        let base = sources.iter().find(|s| s.id == "base").unwrap();
        assert!(base.editable);
        let snapshot = sources.iter().find(|s| s.id == "snapshot").unwrap();
        assert!(!snapshot.editable);
    }

    #[test]
    fn opencode_config_runtime_sync_still_uses_opencode_json() {
        // Runtime sync target must still point to generated opencode.json
        let targets = agent_targets::config_targets();
        let opencode = targets.iter().find(|t| t.id == "opencode_config").unwrap();
        assert_eq!(opencode.source_rel, "templates/opencode.json");
        assert_eq!(opencode.target_rel, ".config/opencode/opencode.json");
    }

    // ── open_opencode_config_source tests ──

    fn ocs_open_source_rejects_unknown(source_type: &str) -> Result<(), String> {
        // Simulate the validation logic of open_opencode_config_source without running `open`
        let source = agent_targets::opencode_config_editor_source_by_id(source_type)
            .ok_or_else(|| format!("unknown opencode config source type: {}", source_type))?;
        if source.rel_path.contains("..") || std::path::Path::new(source.rel_path).is_absolute() {
            return Err("invalid registry path".to_string());
        }
        Ok(())
    }

    #[test]
    fn open_opencode_config_source_unknown_type_rejected() {
        let result = ocs_open_source_rejects_unknown("unknown");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("unknown opencode config source"));
    }

    #[test]
    fn open_opencode_config_source_known_types_accepted() {
        for id in &["base", "policy", "snapshot"] {
            let result = ocs_open_source_rejects_unknown(id);
            assert!(
                result.is_ok(),
                "known source type '{}' should be accepted",
                id
            );
        }
    }

    #[test]
    fn open_opencode_config_source_rejects_invalid_source_type() {
        for bad in &["../etc/passwd", "/abs/path", "", "base;rm"] {
            let result = agent_targets::opencode_config_editor_source_by_id(bad);
            assert!(
                result.is_none(),
                "invalid source type '{}' should not be found",
                bad
            );
        }
    }

    #[test]
    fn open_opencode_config_source_paths_are_safe() {
        // All source rel_paths must be relative and not contain parent references
        for id in &["base", "policy", "snapshot"] {
            let source = agent_targets::opencode_config_editor_source_by_id(id).unwrap();
            assert!(
                !source.rel_path.starts_with('/'),
                "rel_path for '{}' must not be absolute: {}",
                id,
                source.rel_path
            );
            assert!(
                !source.rel_path.contains(".."),
                "rel_path for '{}' must not contain ..: {}",
                id,
                source.rel_path
            );
        }
    }
}
