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
        ("Marker", &[".agent-workspace/workspace.json"]),
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
                "templates/opencode.base.json",
                "templates/opencode.policy.json",
                "templates/tui.json",
                "templates/cursor/README.md",
                "templates/cursor/manifest.json",
                "templates/cursor/user-rules.md",
                "templates/cursor/mcp/README.md",
                "templates/cursor/mcp/mcp.example.json",
                "templates/cursor/rules/core-safety.mdc",
                "templates/cursor/rules/prompt-contract.mdc",
                "templates/cursor/rules/repo-workflow.mdc",
                "templates/cursor/rules/php-cms.mdc",
                "templates/cursor/rules/nextjs-data.mdc",
                "templates/cursor/rules/frontend-design.mdc",
                "templates/cursor/rules/release-check.mdc",
                "templates/cursor/agents/verifier.md",
                "templates/cursor/agents/security-reviewer.md",
                "templates/cursor/agents/release-checker.md",
                "templates/cursor/agents/browser-qa.md",
                "templates/cursor/agents/repo-scout.md",
                "templates/prompts/standard-prompt.md",
                "templates/prompts/masterprompt.md",
            ],
        ),
        (
            "Agents",
            &[
                "agents/architect.md",
                "agents/scout.md",
                "agents/inspector.md",
                "agents/sentinel.md",
                "agents/scribe.md",
                "agents/verifier.md",
            ],
        ),
        (
            "Scripts",
            &[
                "scripts/bootstrap.sh",
                "scripts/generate-opencode-config.py",
                "scripts/install-skills.sh",
                "scripts/install-agent-rules.sh",
                "scripts/install-opencode-config.sh",
                "scripts/install-cursor-workspace.sh",
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
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-defaults-{name}-{nonce}"))
    }

    fn write_file(root: &Path, rel: &str) {
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
                    .find(|f| f.path == ".agent-workspace/workspace.json")
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
            6,
            "scripts category must have 6 known paths"
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
        write_file(&root, ".agent-workspace/workspace.json");
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
            "templates/opencode.base.json",
            "templates/opencode.policy.json",
            "templates/tui.json",
            "templates/cursor/README.md",
            "templates/cursor/manifest.json",
            "templates/cursor/user-rules.md",
            "templates/cursor/mcp/README.md",
            "templates/cursor/mcp/mcp.example.json",
            "templates/cursor/rules/core-safety.mdc",
            "templates/cursor/rules/prompt-contract.mdc",
            "templates/cursor/rules/repo-workflow.mdc",
            "templates/cursor/rules/php-cms.mdc",
            "templates/cursor/rules/nextjs-data.mdc",
            "templates/cursor/rules/frontend-design.mdc",
            "templates/cursor/rules/release-check.mdc",
            "templates/cursor/agents/verifier.md",
            "templates/cursor/agents/security-reviewer.md",
            "templates/cursor/agents/release-checker.md",
            "templates/cursor/agents/browser-qa.md",
            "templates/cursor/agents/repo-scout.md",
            "templates/prompts/standard-prompt.md",
            "templates/prompts/masterprompt.md",
        ] {
            write_file(&root, rel);
        }
        for &rel in &[
            "agents/architect.md",
            "agents/scout.md",
            "agents/inspector.md",
            "agents/sentinel.md",
            "agents/scribe.md",
            "agents/verifier.md",
        ] {
            write_file(&root, rel);
        }
        for &rel in &[
            "scripts/bootstrap.sh",
            "scripts/generate-opencode-config.py",
            "scripts/install-skills.sh",
            "scripts/install-agent-rules.sh",
            "scripts/install-opencode-config.sh",
            "scripts/install-cursor-workspace.sh",
        ] {
            write_file(&root, rel);
        }
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

    #[test]
    fn global_agent_rules_template_contains_skill_routing() {
        let root = source_tree_default_workspace_root();
        let template_path = root.join("templates/global-agent-rules.md");
        let content = std::fs::read_to_string(&template_path)
            .unwrap_or_else(|_| panic!("failed to read {}", template_path.display()));
        assert!(
            content.contains("## Skill routing"),
            "template must contain ## Skill routing section"
        );
        assert!(
            content.contains("diagnose"),
            "template must reference diagnose skill"
        );
        assert!(
            content.contains("implementation-plan"),
            "template must reference implementation-plan skill"
        );
        assert!(
            content.contains("security-review"),
            "template must reference security-review skill"
        );
        assert!(
            content.contains("release-check"),
            "template must reference release-check skill"
        );
    }

    #[test]
    fn default_workspace_files_include_all_cursor_adapter_templates() {
        let files: Vec<&str> = default_workspace_files()
            .into_iter()
            .flat_map(|(_, paths)| paths.iter().copied())
            .collect();
        for rel in [
            "templates/cursor/agents/verifier.md",
            "templates/cursor/agents/security-reviewer.md",
            "templates/cursor/agents/release-checker.md",
            "templates/cursor/agents/browser-qa.md",
            "templates/cursor/agents/repo-scout.md",
            "templates/cursor/manifest.json",
            "templates/cursor/mcp/mcp.example.json",
            "templates/cursor/user-rules.md",
        ] {
            assert!(files.contains(&rel), "missing Cursor adapter: {}", rel);
        }
    }
}
