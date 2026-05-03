use serde::Serialize;
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

#[derive(Serialize)]
pub struct DocSummary {
    id: String,
    title: String,
    path: String,
    section: String,
}

#[derive(Serialize)]
pub struct DocumentContent {
    pub id: String,
    pub title: String,
    pub path: String,
    pub section: String,
    pub content: String,
}

#[tauri::command]
pub fn list_docs() -> Result<Vec<DocSummary>, String> {
    let root = workspace_root()?;
    let docs = existing_curated_docs(&root);
    Ok(docs
        .into_iter()
        .map(|(id, section, title, path)| DocSummary {
            id,
            title,
            section,
            path: path.to_string_lossy().into_owned(),
        })
        .collect())
}

#[tauri::command]
pub fn read_doc(id: String) -> Result<DocumentContent, String> {
    let root = workspace_root()?;
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
                content,
            })
        }
        None => Err(format!("unknown doc: {}", id)),
    }
}

#[tauri::command]
pub fn open_doc(id: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
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
    let safe_id = doc_id.replace(['/', '\\'], "_");
    let file_name = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid target file name".to_string())?;
    let backup_dir = root.join("docs").join(format!("{}-{}", safe_id, timestamp));
    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("create backup dir error: {}", e))?;
    Ok(backup_dir.join(file_name))
}

fn save_doc_at_root(root: &Path, id: &str, content: &str) -> Result<ActionResult, String> {
    if content.len() > MAX_DOC_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }

    let entry = curated_doc_registry()
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown doc: {}", id))?;

    if entry.rel_path.contains("..") || Path::new(entry.rel_path).is_absolute() {
        return Err("invalid registry path".to_string());
    }

    let target_path = root.join(entry.rel_path);

    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize workspace: {}", e))?;
    let canonical_target = if target_path.exists() {
        target_path
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize target: {}", e))?
    } else {
        let parent = target_path.parent().ok_or("invalid target path")?;
        let file_name = target_path.file_name().ok_or("invalid target path")?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("cannot canonicalize parent: {}", e))?;
        canonical_parent.join(file_name)
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err("target path is outside workspace".to_string());
    }

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir error: {}", e))?;
    }

    if target_path.exists() {
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

        let backup_path = doc_backup_path(id, &target_path)?;
        std::fs::write(&backup_path, &existing)
            .map_err(|e| format!("backup write error: {}", e))?;

        std::fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;

        return Ok(ActionResult::new(
            true,
            "save_doc",
            "saved with backup".to_string(),
            String::new(),
            Some(0),
        ));
    }

    std::fs::write(&target_path, content).map_err(|e| format!("write error: {}", e))?;

    Ok(ActionResult::new(
        true,
        "save_doc",
        "saved".to_string(),
        String::new(),
        Some(0),
    ))
}

#[tauri::command]
pub fn save_doc(id: String, content: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    save_doc_at_root(&root, &id, &content)
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
