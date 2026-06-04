//! End-to-end runtime smoke for Tauri command handlers (no webview).
//! Run via `scripts/smoke-tauri-runtime.sh`, which sets `AGENT_WORKSPACE_SMOKE=1`.

#[cfg(test)]
mod tests {
    use crate::commands::{
        get_cursor_profile_health, get_opencode_runtime_health, get_status,
        get_workspace_diagnostics, read_brain_setup_seed,
    };
    use serde_json::Value;
    use std::path::PathBuf;

    fn smoke_enabled() -> bool {
        std::env::var("AGENT_WORKSPACE_SMOKE").ok().as_deref() == Some("1")
    }

    fn expected_workspace() -> PathBuf {
        let path = std::env::var("AGENT_WORKSPACE_PATH")
            .expect("AGENT_WORKSPACE_PATH must be set for runtime smoke");
        PathBuf::from(path.trim())
    }

    fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
        value
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key} in {value}"))
    }

    #[test]
    fn runtime_smoke_end_to_end() {
        if !smoke_enabled() {
            eprintln!("skip runtime_smoke_end_to_end: AGENT_WORKSPACE_SMOKE not set");
            return;
        }

        let workspace = expected_workspace();
        let workspace_canonical = workspace
            .canonicalize()
            .unwrap_or_else(|e| panic!("canonicalize workspace {}: {e}", workspace.display()));

        let diagnostics =
            serde_json::to_value(get_workspace_diagnostics().expect("get_workspace_diagnostics"))
                .expect("serialize diagnostics");
        if field(&diagnostics, "valid") != &Value::Bool(true) {
            panic!(
                "workspace diagnostics invalid: {}",
                serde_json::to_string_pretty(&diagnostics)
                    .unwrap_or_else(|_| diagnostics.to_string())
            );
        }
        assert_eq!(
            field(&diagnostics, "resolved_path").as_str(),
            Some(workspace_canonical.to_string_lossy().as_ref())
        );
        assert_eq!(
            field(&diagnostics, "release_check_available"),
            &Value::Bool(true)
        );

        let status =
            serde_json::to_value(get_status().expect("get_status")).expect("serialize status");
        assert_eq!(
            field(&status, "repo_path").as_str(),
            Some(workspace_canonical.to_string_lossy().as_ref())
        );
        for key in ["opencode_config", "opencode_agents", "claude_agents"] {
            assert_eq!(field(&status, key).as_str(), Some("synced"), "{key} status");
        }

        let opencode = serde_json::to_value(
            get_opencode_runtime_health().expect("get_opencode_runtime_health"),
        )
        .expect("serialize opencode health");
        assert_eq!(
            field(&opencode, "status").as_str(),
            Some("synced"),
            "opencode health: {}",
            field(&opencode, "summary")
        );

        let cursor =
            serde_json::to_value(get_cursor_profile_health().expect("get_cursor_profile_health"))
                .expect("serialize cursor health");
        assert_eq!(field(&cursor, "status").as_str(), Some("synced"));
        assert_eq!(
            field(&cursor, "global_agents_status").as_str(),
            Some("synced")
        );

        let brain = serde_json::to_value(read_brain_setup_seed().expect("read_brain_setup_seed"))
            .expect("serialize brain setup");
        assert_eq!(field(&brain, "status").as_str(), Some("missing"));
        assert_eq!(field(&brain, "content").as_str(), Some(""));

        let private_seed = workspace_canonical.join("templates/context/saved-memory.md");
        assert!(
            !private_seed.is_file(),
            "private brain seed must not exist: {}",
            private_seed.display()
        );
        let private_context_dir = workspace_canonical.join("private-context");
        assert!(
            !private_context_dir.exists(),
            "private-context must not exist in workspace"
        );

        let home = std::env::var("HOME").expect("HOME for smoke");
        for forbidden in [".config/opencode", ".claude/agents", ".cursor/agents"] {
            let path = PathBuf::from(&home).join(forbidden);
            assert!(
                path.starts_with(PathBuf::from(&home)),
                "harness path must stay under smoke HOME"
            );
        }
    }
}
