use serde::Serialize;
use std::path::{Path, PathBuf};

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
    id: String,
    title: String,
    path: String,
    section: String,
    content: String,
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
pub fn read_opencode_config() -> Result<DocumentContent, String> {
    let root = workspace_root()?;
    let target = agent_targets::config_sync_targets()
        .into_iter()
        .find(|t| t.id == "opencode_config")
        .ok_or("opencode config target not found")?;
    let path = root.join(target.source_rel);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
    Ok(DocumentContent {
        id: "opencode-config".into(),
        title: "opencode.json".into(),
        section: String::new(),
        path: target.source_rel.to_string(),
        content,
    })
}

#[tauri::command]
pub fn open_opencode_config() -> Result<ActionResult, String> {
    let root = workspace_root()?;
    let target = agent_targets::config_sync_targets()
        .into_iter()
        .find(|t| t.id == "opencode_config")
        .ok_or("opencode config target not found")?;
    let path = root.join(target.source_rel);
    let path_str = path_arg(&path)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &root);
    Ok(ActionResult::new(
        ok,
        "open_opencode_config",
        out,
        err,
        code,
    ))
}
