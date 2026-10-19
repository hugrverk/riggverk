use std::path::PathBuf;

fn source_tree_default_workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_tree_root_ends_with_default_workspace() {
        let root = source_tree_default_workspace_root();
        assert!(root
            .to_string_lossy()
            .ends_with("resources/default-workspace"));
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
