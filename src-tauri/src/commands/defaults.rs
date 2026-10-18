#[cfg(test)]
use serde::Serialize;
#[cfg(test)]
use std::path::PathBuf;

#[path = "default_workspace_manifest.rs"]
mod manifest;

#[cfg(test)]
#[derive(Serialize)]
pub struct DefaultWorkspaceFile {
    path: String,
    exists: bool,
}

#[cfg(test)]
#[derive(Serialize)]
pub struct DefaultWorkspaceCategory {
    label: String,
    count: usize,
    files: Vec<DefaultWorkspaceFile>,
}

#[cfg(test)]
#[derive(Serialize)]
pub struct DefaultWorkspaceSummary {
    root_label: String,
    description: String,
    categories: Vec<DefaultWorkspaceCategory>,
}

#[cfg(test)]
fn source_tree_default_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
}

/// App-owned operational resources that repair may refresh backup-first.
#[cfg(test)]
pub(crate) fn cursor_bundle_refresh_paths() -> &'static [&'static str] {
    manifest::MANAGED_REFRESH_PATHS
}

pub(crate) fn default_workspace_files() -> Vec<(&'static str, &'static [&'static str])> {
    manifest::categories()
}

#[cfg(test)]
fn build_summary(root: &std::path::Path) -> DefaultWorkspaceSummary {
    let categories = default_workspace_files()
        .into_iter()
        .map(|(label, paths)| {
            let files: Vec<DefaultWorkspaceFile> = paths
                .iter()
                .map(|rel| DefaultWorkspaceFile {
                    path: rel.to_string(),
                    exists: root.join(rel).exists(),
                })
                .collect();
            DefaultWorkspaceCategory {
                label: label.to_string(),
                count: files.iter().filter(|file| file.exists).count(),
                files,
            }
        })
        .collect();

    DefaultWorkspaceSummary {
        root_label: "Bundled Starter".to_string(),
        description: "Bundled defaults installed via Workspace install or repair.".to_string(),
        categories,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_paths() -> Vec<&'static str> {
        default_workspace_files()
            .into_iter()
            .flat_map(|(_, paths)| paths.iter().copied())
            .collect()
    }

    #[test]
    fn source_tree_root_ends_with_default_workspace() {
        let root = source_tree_default_workspace_root();
        assert!(root
            .to_string_lossy()
            .ends_with("resources/default-workspace"));
    }

    #[test]
    fn summary_categories_keep_stable_order() {
        let summary = build_summary(&source_tree_default_workspace_root());
        let labels: Vec<&str> = summary
            .categories
            .iter()
            .map(|category| category.label.as_str())
            .collect();
        assert_eq!(
            labels,
            [
                "Marker",
                "Readme",
                "Docs",
                "Templates",
                "Skill adapters",
                "Agent specs",
                "Agents",
                "Scripts",
                "Skills",
                "Metadata"
            ]
        );
    }

    #[test]
    fn bundled_source_contains_every_manifest_file() {
        let root = source_tree_default_workspace_root();
        let missing: Vec<&str> = all_paths()
            .into_iter()
            .filter(|rel| !root.join(rel).is_file())
            .collect();
        assert!(missing.is_empty(), "missing bundled files: {missing:?}");
    }

    #[test]
    fn every_refresh_path_is_in_copy_manifest() {
        let files = all_paths();
        for rel in cursor_bundle_refresh_paths() {
            assert!(
                files.contains(rel),
                "refresh path absent from manifest: {rel}"
            );
        }
    }

    #[test]
    fn refresh_allowlist_excludes_user_authored_sources() {
        for rel in cursor_bundle_refresh_paths() {
            assert!(rel.starts_with("scripts/") || rel.starts_with("templates/cursor/"));
            assert!(!rel.starts_with("docs/"));
            assert!(!rel.starts_with("skills/"));
            assert!(!rel.starts_with("agents/"));
            assert_ne!(*rel, "templates/global-agent-rules.md");
            assert_ne!(*rel, "templates/opencode.json");
        }
    }

    #[test]
    fn global_rules_template_contains_skill_routing() {
        let path = source_tree_default_workspace_root().join("templates/global-agent-rules.md");
        let content = std::fs::read_to_string(path).expect("read global rules template");
        for required in [
            "## Skill routing",
            "diagnose",
            "implementation-plan",
            "security-review",
            "release-check",
        ] {
            assert!(content.contains(required), "template missing: {required}");
        }
    }
}
