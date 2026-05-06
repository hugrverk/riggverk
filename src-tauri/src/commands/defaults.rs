use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize)]
pub struct DefaultWorkspaceFile {
    path: String,
    exists: bool,
}

#[derive(Serialize)]
pub struct DefaultWorkspaceCategory {
    label: String,
    count: usize,
    files: Vec<DefaultWorkspaceFile>,
}

#[derive(Serialize)]
pub struct DefaultWorkspaceSummary {
    root_label: String,
    description: String,
    categories: Vec<DefaultWorkspaceCategory>,
}

fn source_tree_default_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
}

fn bundled_default_workspace_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .map(|d| d.join("default-workspace"))
        .ok()
}

pub(crate) fn resolve_default_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(bundled) = bundled_default_workspace_root(app) {
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    let source = source_tree_default_workspace_root();
    if source.exists() {
        return Ok(source);
    }

    Err(
        "bundled default workspace resources unavailable (neither bundled nor source tree found)"
            .to_string(),
    )
}

pub(crate) fn default_workspace_files() -> Vec<(&'static str, &'static [&'static str])> {
    vec![
        ("Marker", &[".ux-workspace/workspace.json"]),
        ("Readme", &["README.md"]),
        (
            "Docs",
            &[
                "docs/START_HERE.md",
                "docs/CONCEPTS.md",
                "docs/USING_THE_APP.md",
                "docs/GIT_VERSIONING.md",
                "docs/WORKFLOWS.md",
                "docs/SKILLS.md",
                "docs/AGENT_RULES.md",
                "docs/OPENCODE_CONFIG.md",
                "docs/TROUBLESHOOTING.md",
            ],
        ),
        (
            "Templates",
            &[
                "templates/global-agent-rules.md",
                "templates/opencode.json",
                "templates/prompts/standard-prompt.md",
                "templates/prompts/masterprompt.md",
            ],
        ),
        (
            "Agents",
            &[
                "agents/autopilot.md",
                "agents/repo-scout.md",
                "agents/code-reviewer.md",
                "agents/security-auditor.md",
                "agents/docs-writer.md",
                "agents/qa-verifier.md",
            ],
        ),
        (
            "Scripts",
            &[
                "scripts/bootstrap.sh",
                "scripts/install-skills.sh",
                "scripts/install-agent-rules.sh",
                "scripts/install-opencode-config.sh",
            ],
        ),
        (
            "Skills",
            &[
                "skills/accessibility-review/SKILL.md",
                "skills/agent-report-review/SKILL.md",
                "skills/browser-qa/SKILL.md",
                "skills/caveman/SKILL.md",
                "skills/context-budget/SKILL.md",
                "skills/current-docs/SKILL.md",
                "skills/database-migrations/SKILL.md",
                "skills/dependency-evaluation/SKILL.md",
                "skills/diagnose/SKILL.md",
                "skills/frontend-design/SKILL.md",
                "skills/grill-me/SKILL.md",
                "skills/grill-with-docs/SKILL.md",
                "skills/implementation-plan/SKILL.md",
                "skills/improve-codebase-architecture/SKILL.md",
                "skills/release-check/SKILL.md",
                "skills/screenshot-review/SKILL.md",
                "skills/security-review/SKILL.md",
                "skills/tdd/SKILL.md",
                "skills/to-prd/SKILL.md",
                "skills/triage/SKILL.md",
                "skills/write-a-skill/SKILL.md",
                "skills/zoom-out/SKILL.md",
            ],
        ),
        ("Routing", &["routing/profiles.json"]),
        ("Metadata", &["metadata/agents.json"]),
    ]
}

fn build_summary(root: &std::path::Path) -> DefaultWorkspaceSummary {
    let categories: Vec<DefaultWorkspaceCategory> = default_workspace_files()
        .into_iter()
        .map(|(label, paths)| {
            let files: Vec<DefaultWorkspaceFile> = paths
                .iter()
                .map(|rel| DefaultWorkspaceFile {
                    path: rel.to_string(),
                    exists: root.join(rel).exists(),
                })
                .collect();
            let count = files.iter().filter(|f| f.exists).count();
            DefaultWorkspaceCategory {
                label: label.to_string(),
                count,
                files,
            }
        })
        .collect();
    DefaultWorkspaceSummary {
        root_label: "Bundled Starter".to_string(),
        description: "Read-only bundled starter resources. They are not copied automatically; Settings can create a new workspace from them after a safe dry-run. Import/upgrade flows are future work.".to_string(),
        categories,
    }
}

#[tauri::command]
pub fn get_default_workspace_summary(
    app: tauri::AppHandle,
) -> Result<DefaultWorkspaceSummary, String> {
    let root = resolve_default_workspace_root(&app)?;
    Ok(build_summary(&root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-defaults-{name}-{nonce}"))
    }

    fn write_file(root: &PathBuf, rel: &str) {
        if let Some(parent) = root.join(rel).parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(root.join(rel), "").expect("write file");
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_tree_root_ends_with_default_workspace() {
        let root = source_tree_default_workspace_root();
        let root_str = root.to_string_lossy();
        assert!(
            root_str.ends_with("resources/default-workspace"),
            "source tree root must point to resources/default-workspace, got: {}",
            root_str
        );
    }

    #[test]
    fn summary_categories_match_expected_order() {
        let summary = build_summary(&source_tree_default_workspace_root());
        let labels: Vec<&str> = summary
            .categories
            .iter()
            .map(|c| c.label.as_str())
            .collect();
        assert_eq!(
            labels,
            &[
                "Marker",
                "Readme",
                "Docs",
                "Templates",
                "Agents",
                "Scripts",
                "Skills",
                "Routing",
                "Metadata",
            ],
            "category order must be stable"
        );
    }

    #[test]
    fn summary_contains_known_paths() {
        let summary = build_summary(&source_tree_default_workspace_root());
        let keys: Vec<&str> = summary
            .categories
            .iter()
            .filter_map(|c| {
                c.files
                    .iter()
                    .find(|f| f.path == ".ux-workspace/workspace.json")
                    .map(|_| c.label.as_str())
            })
            .collect();
        assert!(
            keys.contains(&"Marker"),
            "marker category must contain workspace.json"
        );
    }

    #[test]
    fn scripts_not_executed() {
        let root = temp_root("no-exec");
        write_file(&root, "scripts/bootstrap.sh");
        write_file(&root, "README.md");

        let summary = build_summary(&root);
        cleanup(&root);

        let scripts = summary
            .categories
            .iter()
            .find(|c| c.label == "Scripts")
            .expect("scripts category must exist");
        assert_eq!(
            scripts.files.len(),
            4,
            "scripts category must have 4 known paths"
        );
    }

    #[test]
    fn skills_category_has_multiple_paths() {
        let root = temp_root("skills-multiple");
        for &rel in &[
            "skills/diagnose/SKILL.md",
            "skills/tdd/SKILL.md",
            "skills/zoom-out/SKILL.md",
        ] {
            write_file(&root, rel);
        }
        write_file(&root, "README.md");

        let summary = build_summary(&root);
        cleanup(&root);

        let skills = summary
            .categories
            .iter()
            .find(|c| c.label == "Skills")
            .expect("skills category must exist");
        assert!(
            skills.files.len() > 3,
            "skills category must have more than 3 known paths, got {}",
            skills.files.len()
        );
    }

    #[test]
    fn skills_category_includes_baseline_skill() {
        let root = temp_root("skills-baseline");
        write_file(&root, "skills/diagnose/SKILL.md");
        write_file(&root, "README.md");

        let summary = build_summary(&root);
        cleanup(&root);

        let skills = summary
            .categories
            .iter()
            .find(|c| c.label == "Skills")
            .expect("skills category must exist");
        assert!(
            skills
                .files
                .iter()
                .any(|f| f.path == "skills/diagnose/SKILL.md"),
            "skills category must include skills/diagnose/SKILL.md"
        );
    }

    #[test]
    fn missing_files_get_exists_false() {
        let root = temp_root("missing-files");
        write_file(&root, "README.md");

        let summary = build_summary(&root);
        cleanup(&root);

        let docs = summary
            .categories
            .iter()
            .find(|c| c.label == "Docs")
            .expect("docs category must exist");
        let missing_count = docs.files.iter().filter(|f| !f.exists).count();
        assert!(
            missing_count > 0,
            "at least some docs files should be reported as missing"
        );
        assert_eq!(docs.count, docs.files.iter().filter(|f| f.exists).count());
    }

    #[test]
    fn all_files_present_when_root_is_valid() {
        let root = temp_root("full-bundle");
        write_file(&root, ".ux-workspace/workspace.json");
        write_file(&root, "README.md");
        for &rel in &[
            "docs/START_HERE.md",
            "docs/CONCEPTS.md",
            "docs/USING_THE_APP.md",
            "docs/GIT_VERSIONING.md",
            "docs/WORKFLOWS.md",
            "docs/SKILLS.md",
            "docs/AGENT_RULES.md",
            "docs/OPENCODE_CONFIG.md",
            "docs/TROUBLESHOOTING.md",
        ] {
            write_file(&root, rel);
        }
        for &rel in &[
            "templates/global-agent-rules.md",
            "templates/opencode.json",
            "templates/prompts/standard-prompt.md",
            "templates/prompts/masterprompt.md",
        ] {
            write_file(&root, rel);
        }
        for &rel in &[
            "agents/autopilot.md",
            "agents/repo-scout.md",
            "agents/code-reviewer.md",
            "agents/security-auditor.md",
            "agents/docs-writer.md",
            "agents/qa-verifier.md",
        ] {
            write_file(&root, rel);
        }
        for &rel in &[
            "scripts/bootstrap.sh",
            "scripts/install-skills.sh",
            "scripts/install-agent-rules.sh",
            "scripts/install-opencode-config.sh",
        ] {
            write_file(&root, rel);
        }
        write_file(&root, "routing/profiles.json");
        write_file(&root, "metadata/agents.json");
        for &rel in &[
            "skills/accessibility-review/SKILL.md",
            "skills/agent-report-review/SKILL.md",
            "skills/browser-qa/SKILL.md",
            "skills/caveman/SKILL.md",
            "skills/context-budget/SKILL.md",
            "skills/current-docs/SKILL.md",
            "skills/database-migrations/SKILL.md",
            "skills/dependency-evaluation/SKILL.md",
            "skills/diagnose/SKILL.md",
            "skills/frontend-design/SKILL.md",
            "skills/grill-me/SKILL.md",
            "skills/grill-with-docs/SKILL.md",
            "skills/implementation-plan/SKILL.md",
            "skills/improve-codebase-architecture/SKILL.md",
            "skills/release-check/SKILL.md",
            "skills/screenshot-review/SKILL.md",
            "skills/security-review/SKILL.md",
            "skills/tdd/SKILL.md",
            "skills/to-prd/SKILL.md",
            "skills/triage/SKILL.md",
            "skills/write-a-skill/SKILL.md",
            "skills/zoom-out/SKILL.md",
        ] {
            write_file(&root, rel);
        }

        let summary = build_summary(&root);
        cleanup(&root);

        for cat in &summary.categories {
            assert!(
                cat.files.iter().all(|f| f.exists),
                "all files in {} should exist",
                cat.label
            );
            assert_eq!(
                cat.count,
                cat.files.len(),
                "count ({}) should equal files.len() ({}) for {}",
                cat.count,
                cat.files.len(),
                cat.label
            );
        }
    }
}
