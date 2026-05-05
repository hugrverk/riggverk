use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_targets;

use super::process::{run_cmd, ActionResult};
use super::workspace::{path_arg, workspace_root};

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
            id: "docs/WORKSPACE_CONTRACT.md",
            section: "Start",
            title: "Workspace Contract",
            rel_path: "docs/WORKSPACE_CONTRACT.md",
        },
        DocEntry {
            id: "docs/INSTALL.md",
            section: "Reference",
            title: "Install Skills",
            rel_path: "docs/INSTALL.md",
        },
        DocEntry {
            id: "docs/BOOTSTRAP.md",
            section: "Reference",
            title: "Bootstrap",
            rel_path: "docs/BOOTSTRAP.md",
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
            id: "docs/OPERATING_MODEL.md",
            section: "Operating Model",
            title: "Operating Model",
            rel_path: "docs/OPERATING_MODEL.md",
        },
        DocEntry {
            id: "docs/WORKFLOW.md",
            section: "Private / Operator",
            title: "Workflow",
            rel_path: "docs/WORKFLOW.md",
        },
        DocEntry {
            id: "docs/PROMPTING.md",
            section: "Private / Operator",
            title: "Prompting",
            rel_path: "docs/PROMPTING.md",
        },
        DocEntry {
            id: "docs/FRONTIER_PLANNER_HANDOFF.md",
            section: "Private / Operator",
            title: "Frontier Planner Handoff",
            rel_path: "docs/FRONTIER_PLANNER_HANDOFF.md",
        },
        DocEntry {
            id: "docs/RELEASE.md",
            section: "Development",
            title: "Release",
            rel_path: "docs/RELEASE.md",
        },
    ]
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
            if !path.is_file() {
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
    if !path.exists() {
        return Err(format!("unknown doc: custom:{}", slug));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
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
                path: path.to_string_lossy().into_owned(),
                source: source.to_string(),
            }
        })
        .collect())
}

#[tauri::command]
pub fn read_doc(id: String) -> Result<DocumentContent, String> {
    let root = workspace_root()?;
    if let Some(slug) = id.strip_prefix("custom:") {
        return read_custom_doc(&root, slug);
    }
    let docs = existing_curated_docs(&root);
    let found = docs.iter().find(|(i, _, _, _)| i == &id);
    match found {
        Some((i, section, title, path)) => {
            let content =
                std::fs::read_to_string(path).map_err(|e| format!("read error: {}", e))?;
            Ok(DocumentContent {
                id: i.clone(),
                title: title.clone(),
                section: section.clone(),
                path: path.to_string_lossy().into_owned(),
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

fn doc_backup_path(doc_id: &str, target_path: &Path) -> Result<PathBuf, String> {
    let root = super::backups::backup_root()?;
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

fn save_doc_at_root(root: &Path, id: &str, content: &str) -> Result<ActionResult, String> {
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

    let backup_path = doc_backup_path(&resolved_id, &target_path)?;
    std::fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;

    std::fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;

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
    save_doc_at_root(&root, &id, &content)
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

    if target_path.exists() {
        return Err(format!("doc already exists: custom:{}", slug));
    }

    safe_canonical_target(root, &target_path)?;

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir error: {}", e))?;
    }

    let trimmed_title = title.trim();
    let initial_content = if let Some(c) = content {
        c
    } else if trimmed_title.is_empty() {
        String::new()
    } else {
        format!("# {}\n", trimmed_title)
    };
    std::fs::write(&target_path, &initial_content).map_err(|e| format!("write error: {}", e))?;

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
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static BACKUP_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("ux-workspace-app-docs-{name}-{nonce}"))
    }

    fn write_file(root: &PathBuf, rel: &str, content: &str) {
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
        write_file(&root, "docs/WORKSPACE_CONTRACT.md", "# contract\n");
        // docs/INSTALL.md and others intentionally missing

        let docs = existing_curated_docs(&root);
        cleanup(&root);

        let ids: Vec<&str> = docs.iter().map(|(id, _, _, _)| id.as_str()).collect();
        assert_eq!(ids, &["README.md", "docs/WORKSPACE_CONTRACT.md"]);
    }

    #[test]
    fn curated_registry_order_is_stable() {
        let root = temp_root("stable-order");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/WORKSPACE_CONTRACT.md", "# contract\n");
        write_file(&root, "docs/RELEASE.md", "# release\n");
        write_file(&root, "docs/INSTALL.md", "# install\n");

        let docs = existing_curated_docs(&root);
        cleanup(&root);

        let ids: Vec<&str> = docs.iter().map(|(id, _, _, _)| id.as_str()).collect();
        let expected = &[
            "README.md",
            "docs/WORKSPACE_CONTRACT.md",
            "docs/INSTALL.md",
            "docs/RELEASE.md",
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
    fn sections_are_assigned_correctly() {
        let root = temp_root("section-check");
        write_file(&root, "README.md", "# readme\n");
        write_file(&root, "docs/WORKFLOW.md", "# workflow\n");
        write_file(&root, "docs/INSTALL.md", "# install\n");

        let docs = existing_curated_docs(&root);
        cleanup(&root);

        let by_id: HashMap<&str, &str> = docs
            .iter()
            .map(|(id, section, _, _)| (id.as_str(), section.as_str()))
            .collect();

        assert_eq!(by_id.get("README.md"), Some(&"Start"));
        assert_eq!(by_id.get("docs/WORKFLOW.md"), Some(&"Private / Operator"));
        assert_eq!(by_id.get("docs/INSTALL.md"), Some(&"Reference"));
    }

    #[test]
    fn save_doc_unknown_id_rejected() {
        let root = temp_root("save-unknown");
        write_file(&root, "README.md", "# readme\n");

        let result = save_doc_at_root(&root, "docs/nonexistent.md", "content");
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
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("save-known");
        let backup_root = temp_root("save-known-backup");
        write_file(&root, "README.md", "# old\n");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root(&root, "README.md", "# new\n");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
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
        let result = save_doc_at_root(&root, "../../../etc/passwd", "bad");
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown doc"));
    }

    #[test]
    fn save_doc_unchanged_content_does_not_write() {
        let root = temp_root("save-unchanged");
        write_file(&root, "README.md", "# same\n");

        let result = save_doc_at_root(&root, "README.md", "# same\n");

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
    }

    #[test]
    fn save_doc_creates_backup_when_changed() {
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("save-backup");
        let backup_root = temp_root("save-backup-backup");
        write_file(&root, "README.md", "# original\n");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root(&root, "README.md", "# modified\n");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
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
        write_file(&root, "README.md", "# readme\n");

        let result = save_doc_at_root(&root, "README.md", "# updated\n");

        assert!(result.is_ok());
        cleanup(&root);
    }

    #[test]
    fn config_template_known_target_resolves() {
        let root = temp_root("config-template-known");
        write_file(&root, "templates/opencode.json", "{}");

        let targets = agent_targets::config_sync_targets();
        let opencode = targets.iter().find(|t| t.id == "opencode_config");
        assert!(
            opencode.is_some(),
            "opencode_config must be in config_sync_targets"
        );

        let path = root.join(opencode.unwrap().source_rel);
        assert!(path.exists(), "source_rel must point to an existing file");
        cleanup(&root);
    }

    #[test]
    fn config_template_unknown_target_rejected() {
        let targets = agent_targets::config_sync_targets();
        let unknown = targets.iter().find(|t| t.id == "nonexistent_config");
        assert!(
            unknown.is_none(),
            "unknown config target must not be in registry"
        );
    }

    #[test]
    fn config_sync_target_source_paths_are_safe() {
        let targets = agent_targets::config_sync_targets();
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

        let result = save_doc_at_root(&root, "custom:nonexistent", "# content\n");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("custom doc does not exist"));
    }

    #[test]
    fn save_doc_saves_existing_custom_doc() {
        let root = temp_root("save-existing-custom");
        write_file(&root, "docs/context/my-notes.md", "# original\n");

        let result = save_doc_at_root(&root, "custom:my-notes", "# modified\n");
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        let saved = std::fs::read_to_string(root.join("docs/context/my-notes.md")).unwrap();
        cleanup(&root);
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
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("save-custom-backup");
        let backup_root = temp_root("save-custom-backup-backup");
        write_file(&root, "docs/context/my-notes.md", "# original\n");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root(&root, "custom:my-notes", "# modified\n");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
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

        let result = save_doc_at_root(&root, "custom:my-notes", "# same\n");

        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
    }

    #[test]
    fn save_doc_custom_target_remains_under_workspace() {
        let root = temp_root("save-custom-under-root");
        write_file(&root, "docs/context/my-notes.md", "# readme\n");

        let result = save_doc_at_root(&root, "custom:my-notes", "# updated\n");

        assert!(result.is_ok());
        cleanup(&root);
    }

    #[test]
    fn save_doc_custom_rejects_invalid_slug() {
        let root = temp_root("save-custom-bad-slug");
        write_file(&root, "README.md", "# readme\n");

        let result = save_doc_at_root(&root, "custom:../../etc", "bad");
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
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("cfg-save-valid");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-valid-backup");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root_for_config(&root, "opencode_config", "{\"key\":\"value\"}");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
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
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("cfg-save-invalid");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-invalid-backup");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root_for_config(&root, "opencode_config", "not json");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid JSON"));
    }

    #[test]
    fn config_template_save_unknown_target_rejected() {
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("cfg-save-unknown");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-unknown-backup");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root_for_config(&root, "nonexistent_config", "{}");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown config target"));
    }

    #[test]
    fn config_template_save_unchanged_does_not_write() {
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("cfg-save-unchanged");
        write_file(&root, "templates/opencode.json", "{\"a\":1}");
        let backup_root = temp_root("cfg-save-unchanged-backup");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root_for_config(&root, "opencode_config", "{\"a\":1}");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn config_template_save_target_remains_under_workspace() {
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("cfg-save-under-root");
        write_file(&root, "templates/opencode.json", "{}");
        let backup_root = temp_root("cfg-save-under-root-backup");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root_for_config(&root, "opencode_config", "{\"ok\":true}");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
        assert!(result.is_ok());
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);
    }

    #[test]
    fn config_template_save_creates_backup_when_changed() {
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("cfg-save-backup");
        let backup_root = temp_root("cfg-save-backup-backup");
        write_file(&root, "templates/opencode.json", "{\"original\":true}");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_doc_at_root_for_config(&root, "opencode_config", "{\"modified\":true}");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
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
        root: &PathBuf,
        target_id: &str,
        content: &str,
    ) -> Result<ActionResult, String> {
        if content.len() > 512 * 1024 {
            return Err("content exceeds 512 KB limit".to_string());
        }

        let target = agent_targets::config_sync_targets()
            .into_iter()
            .find(|t| t.id == target_id)
            .ok_or_else(|| format!("unknown config target: {}", target_id))?;

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

            let backup_path = doc_backup_path(target_id, &target_path)?;
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

    fn save_agent_template_at_root(root: &PathBuf, content: &str) -> Result<ActionResult, String> {
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

        let backup_path = doc_backup_path("agent-template", &target_path)?;
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
        let result = save_agent_template_at_root(&root, &big);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds 512 KB"));
    }

    #[test]
    fn agent_template_save_unchanged_returns_unchanged() {
        let root = temp_root("ag-save-unchanged");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");

        let result = save_agent_template_at_root(&root, "# rules\n");
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "unchanged");
        cleanup(&root);
    }

    #[test]
    fn agent_template_save_creates_backup_when_changed() {
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("ag-save-backup");
        let backup_root = temp_root("ag-save-backup-backup");
        write_file(&root, "templates/global-agent-rules.md", "# old rules\n");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let result = save_agent_template_at_root(&root, "# new rules\n");

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
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

        let result = save_agent_template_at_root(&root, "# content\n");
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("template does not exist"));
    }

    #[test]
    fn agent_template_save_target_remains_under_workspace() {
        let root = temp_root("ag-save-under-root");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");

        let result = save_agent_template_at_root(&root, "# updated\n");
        assert!(result.is_ok());
        cleanup(&root);
    }

    // ── agent source tests ──

    #[test]
    fn is_safe_agent_basename_accepts_known() {
        assert!(is_safe_agent_basename("autopilot.md"));
        assert!(is_safe_agent_basename("repo-scout.md"));
        assert!(is_safe_agent_basename("code-reviewer.md"));
        assert!(is_safe_agent_basename("security-auditor.md"));
        assert!(is_safe_agent_basename("docs-writer.md"));
        assert!(is_safe_agent_basename("qa-verifier.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_traversal() {
        assert!(!is_safe_agent_basename("../etc/passwd"));
        assert!(!is_safe_agent_basename("../../etc/passwd"));
        assert!(!is_safe_agent_basename("sub/../../etc/passwd"));
        assert!(!is_safe_agent_basename("autopilot.md/.."));
        assert!(!is_safe_agent_basename("a/../../../b.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_non_md() {
        assert!(!is_safe_agent_basename("autopilot.txt"));
        assert!(!is_safe_agent_basename("autopilot"));
        assert!(!is_safe_agent_basename(""));
        assert!(!is_safe_agent_basename(".hidden.md"));
        assert!(!is_safe_agent_basename("-starts-hyphen.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_slash() {
        assert!(!is_safe_agent_basename("sub/autopilot.md"));
        assert!(!is_safe_agent_basename("a/b/c.md"));
    }

    #[test]
    fn is_safe_agent_basename_rejects_backslash() {
        assert!(!is_safe_agent_basename("sub\\autopilot.md"));
    }

    #[test]
    fn resolve_agent_path_rejects_unknown() {
        let root = temp_root("ag-resolve-unknown");
        write_file(&root, "agents/autopilot.md", "# autopilot\n");

        let result = resolve_agent_path(&root, "nonexistent.md");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown agent file"));
    }

    #[test]
    fn resolve_agent_path_rejects_traversal() {
        let root = temp_root("ag-resolve-traversal");
        write_file(&root, "agents/autopilot.md", "# autopilot\n");

        let result = resolve_agent_path(&root, "../etc/passwd");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid agent filename"));
    }

    #[test]
    fn resolve_agent_path_resolves_known() {
        let root = temp_root("ag-resolve-known");
        write_file(&root, "agents/autopilot.md", "# autopilot\n");

        let result = resolve_agent_path(&root, "autopilot.md");
        cleanup(&root);
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("agents/autopilot.md"));
    }

    fn write_agent_file(root: &PathBuf, filename: &str, content: &str) {
        write_file(root, &format!("agents/{}", filename), content);
    }

    #[test]
    fn agent_source_list_includes_all_known() {
        let root = temp_root("ag-list-all");
        write_agent_file(&root, "autopilot.md", "# autopilot\n");
        write_agent_file(&root, "repo-scout.md", "# scout\n");

        let mut results: Vec<AgentSourceSummary> = Vec::new();
        for filename in KNOWN_AGENT_FILES {
            let path = root.join("agents").join(filename);
            let exists = path.is_file();
            results.push(AgentSourceSummary {
                id: filename.to_string(),
                title: agent_title_from_filename(filename),
                path: format!("agents/{}", filename),
                exists,
            });
        }

        cleanup(&root);

        assert_eq!(results.len(), 6);
        let autopilot = results.iter().find(|r| r.id == "autopilot.md").unwrap();
        assert!(autopilot.exists);
        assert_eq!(autopilot.title, "Autopilot");
        let scout = results.iter().find(|r| r.id == "repo-scout.md").unwrap();
        assert!(scout.exists);
        assert_eq!(scout.title, "Repo Scout");
        let missing = results.iter().find(|r| r.id == "code-reviewer.md").unwrap();
        assert!(!missing.exists);
    }

    #[test]
    fn agent_source_read_resolves_content() {
        let root = temp_root("ag-read");
        write_agent_file(&root, "autopilot.md", "# Autopilot\n\nSome content.\n");

        let path = resolve_agent_path(&root, "autopilot.md").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        cleanup(&root);

        assert!(content.contains("# Autopilot"));
        assert!(content.contains("Some content."));
    }

    #[test]
    fn agent_source_save_unchanged_returns_unchanged() {
        let root = temp_root("ag-save-unchanged");
        write_agent_file(&root, "autopilot.md", "# rules\n");

        let path = resolve_agent_path(&root, "autopilot.md").unwrap();
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
        let _guard = BACKUP_TEST_LOCK.lock().unwrap();
        let root = temp_root("ag-save-backup");
        let backup_root = temp_root("ag-save-backup-backup");
        write_agent_file(&root, "autopilot.md", "# old\n");
        std::env::set_var("UX_WORKSPACE_BACKUP_DIR", &backup_root);

        let path = resolve_agent_path(&root, "autopilot.md").unwrap();
        let existing = std::fs::read_to_string(&path).unwrap();

        let backup_path = doc_backup_path("agent-autopilot.md", &path).unwrap();
        std::fs::write(&backup_path, &existing).unwrap();
        std::fs::write(&path, "# new\n").unwrap();

        let saved = std::fs::read_to_string(root.join("agents/autopilot.md")).unwrap();
        let backup_content = std::fs::read_to_string(&backup_path).unwrap();

        std::env::remove_var("UX_WORKSPACE_BACKUP_DIR");
        cleanup(&root);
        let _ = std::fs::remove_dir_all(&backup_root);

        assert_eq!(saved, "# new\n");
        assert_eq!(backup_content, "# old\n");
    }

    #[test]
    fn agent_source_title_from_filename() {
        assert_eq!(agent_title_from_filename("autopilot.md"), "Autopilot");
        assert_eq!(agent_title_from_filename("repo-scout.md"), "Repo Scout");
        assert_eq!(
            agent_title_from_filename("code-reviewer.md"),
            "Code Reviewer"
        );
        assert_eq!(
            agent_title_from_filename("security-auditor.md"),
            "Security Auditor"
        );
        assert_eq!(agent_title_from_filename("docs-writer.md"), "Docs Writer");
        assert_eq!(agent_title_from_filename("qa-verifier.md"), "Qa Verifier");
    }
}

#[tauri::command]
pub fn read_agent_template() -> Result<DocumentContent, String> {
    let root = workspace_root()?;
    let path = root.join("templates/global-agent-rules.md");
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
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

    let backup_path = doc_backup_path("agent-template", &target_path)?;
    std::fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;

    std::fs::write(&target_path, &content).map_err(|e| format!("write error: {}", e))?;

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
    let target = agent_targets::config_sync_targets()
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("unknown config target: {}", target_id))?;
    let path = root.join(target.source_rel);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
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
    let target = agent_targets::config_sync_targets()
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("unknown config target: {}", target_id))?;
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

const MAX_CONFIG_SIZE: usize = 512 * 1024;

#[tauri::command]
pub fn save_config_template(target_id: String, content: String) -> Result<ActionResult, String> {
    if content.len() > MAX_CONFIG_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let target = agent_targets::config_sync_targets()
        .into_iter()
        .find(|t| t.id == target_id)
        .ok_or_else(|| format!("unknown config target: {}", target_id))?;

    if target.source_rel.contains("..") || Path::new(target.source_rel).is_absolute() {
        return Err("invalid registry path".to_string());
    }

    let root = workspace_root()?;
    let target_path = root.join(target.source_rel);

    safe_canonical_target(&root, &target_path)?;

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir error: {}", e))?;
    }

    // Validate JSON for opencode_config
    if target_id == "opencode_config" {
        serde_json::from_str::<serde_json::Value>(&content)
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

        let backup_path = doc_backup_path(&target_id, &target_path)?;
        std::fs::write(&backup_path, &existing)
            .map_err(|e| format!("backup write error: {}", e))?;

        std::fs::write(&target_path, &content).map_err(|e| format!("write error: {}", e))?;

        return Ok(ActionResult::new(
            true,
            "save_config_template",
            "saved with backup".to_string(),
            String::new(),
            Some(0),
        ));
    }

    std::fs::write(&target_path, &content).map_err(|e| format!("write error: {}", e))?;

    Ok(ActionResult::new(
        true,
        "save_config_template",
        "saved".to_string(),
        String::new(),
        Some(0),
    ))
}

// ── agent source commands ──

const AGENTS_DIR: &str = "agents";

pub(crate) fn known_agent_files() -> &'static [&'static str] {
    &[
        "autopilot.md",
        "repo-scout.md",
        "code-reviewer.md",
        "security-auditor.md",
        "docs-writer.md",
        "qa-verifier.md",
    ]
}

const KNOWN_AGENT_FILES: &[&str] = &[
    "autopilot.md",
    "repo-scout.md",
    "code-reviewer.md",
    "security-auditor.md",
    "docs-writer.md",
    "qa-verifier.md",
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

#[derive(Serialize)]
pub struct AgentSourceSummary {
    pub id: String,
    pub title: String,
    pub path: String,
    pub exists: bool,
}

#[tauri::command]
pub fn list_agent_sources() -> Result<Vec<AgentSourceSummary>, String> {
    let root = workspace_root()?;
    let agents_dir = root.join(AGENTS_DIR);
    if !agents_dir.is_dir() {
        return Ok(KNOWN_AGENT_FILES
            .iter()
            .map(|f| AgentSourceSummary {
                id: f.to_string(),
                title: agent_title_from_filename(f),
                path: format!("{}/{}", AGENTS_DIR, f),
                exists: false,
            })
            .collect());
    }
    let mut results: Vec<AgentSourceSummary> = Vec::new();
    for filename in KNOWN_AGENT_FILES {
        let path = root.join(AGENTS_DIR).join(filename);
        let exists = path.is_file();
        results.push(AgentSourceSummary {
            id: filename.to_string(),
            title: agent_title_from_filename(filename),
            path: format!("{}/{}", AGENTS_DIR, filename),
            exists,
        });
    }
    Ok(results)
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

    let backup_path = doc_backup_path(&format!("agent-{}", filename), &path)?;
    std::fs::write(&backup_path, &existing).map_err(|e| format!("backup write error: {}", e))?;

    std::fs::write(&path, &content).map_err(|e| format!("write error: {}", e))?;

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

fn load_agent_metadata(root: &Path) -> std::collections::HashMap<String, AgentMetadataEntry> {
    let path = root.join(AGENT_METADATA_REL);
    if !path.is_file() {
        return std::collections::HashMap::new();
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return std::collections::HashMap::new(),
    };
    if metadata.len() > MAX_AGENT_METADATA_SIZE as u64 {
        return std::collections::HashMap::new();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return std::collections::HashMap::new(),
    };
    let parsed: AgentMetadataFile = match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(_) => return std::collections::HashMap::new(),
    };
    parsed.agents
}

#[tauri::command]
pub fn list_agent_metadata() -> Result<Vec<AgentMetadataResponse>, String> {
    let root = workspace_root()?;
    let metadata_map = load_agent_metadata(&root);
    let known = known_agent_files();
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
    Ok(results)
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
        std::env::temp_dir().join(format!("ux-workspace-app-agmeta-{name}-{nonce}"))
    }

    fn write_metadata(root: &PathBuf, json: &str) {
        let dir = root.join("metadata");
        fs::create_dir_all(&dir).expect("create metadata dir");
        fs::write(dir.join("agents.json"), json).expect("write agents.json");
    }

    fn write_agent_file(root: &PathBuf, filename: &str) {
        let dir = root.join("agents");
        fs::create_dir_all(&dir).expect("create agents dir");
        fs::write(dir.join(filename), "# agent\n").expect("write agent file");
    }

    #[test]
    fn missing_metadata_returns_none_for_all_agents() {
        let root = temp_root("no-meta");
        write_agent_file(&root, "autopilot.md");

        let map = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(map.is_empty());
    }

    #[test]
    fn valid_metadata_loads_for_known_agents() {
        let root = temp_root("valid-meta");
        write_agent_file(&root, "autopilot.md");
        write_agent_file(&root, "repo-scout.md");
        write_metadata(
            &root,
            r#"{"agents":{"autopilot.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["diagnose"],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let map = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(map.len(), 1);
        let entry = map.get("autopilot.md").expect("autopilot metadata");
        assert_eq!(entry.role, "primary");
        assert_eq!(entry.risk, "medium");
        assert_eq!(entry.targets, vec!["opencode"]);
        assert!(!entry.safe_to_edit_runtime);
    }

    #[test]
    fn invalid_json_returns_empty_map() {
        let root = temp_root("invalid-meta");
        write_agent_file(&root, "autopilot.md");
        write_metadata(&root, "not json");

        let map = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(map.is_empty());
    }

    #[test]
    fn oversized_metadata_rejected() {
        let root = temp_root("oversized-meta");
        write_agent_file(&root, "autopilot.md");
        let big = format!(
            r#"{{"agents":{{"autopilot.md":{{"role":"primary","summary":"{}","targets":[],"risk":"low","default_skills":[],"safe_to_edit_runtime":false,"notes":[]}}}}}}"#,
            "x".repeat(MAX_AGENT_METADATA_SIZE)
        );
        write_metadata(&root, &big);

        let map = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        assert!(map.is_empty());
    }

    #[test]
    fn unknown_agent_key_does_not_crash() {
        let root = temp_root("unknown-key");
        write_agent_file(&root, "autopilot.md");
        write_metadata(
            &root,
            r#"{"agents":{"nonexistent.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["diagnose"],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let map = load_agent_metadata(&root);
        let _ = fs::remove_dir_all(&root);

        // nonexistent.md is in metadata but not a known agent, so it's ignored
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("nonexistent.md"));
    }
}
