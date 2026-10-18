//! End-to-end runtime smoke for Tauri command handlers (no webview).
//! Run via `scripts/smoke-tauri-runtime.sh`, which prepares a temp HOME and workspace,
//! sets `AGENT_WORKSPACE_SMOKE=1` and runs the ignored test explicitly.

#[cfg(test)]
mod tests {
    use crate::commands::{
        apply_setup, get_cursor_profile_health, get_opencode_runtime_health, get_status,
        get_workspace_diagnostics, preview_setup,
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

    /// Preview and apply surfaces through the production setup lifecycle.
    fn apply_surfaces(ids: &[&str]) {
        let surfaces: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        let plan = preview_setup(surfaces.clone()).expect("preview setup");
        let apply = apply_setup(
            surfaces,
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply setup");
        assert!(
            apply.success,
            "smoke apply failed for {ids:?}: {} failed={:?}",
            apply.message, apply.failed
        );
    }

    fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
        value
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key} in {value}"))
    }

    #[test]
    #[ignore = "driven by scripts/smoke-tauri-runtime.sh (temp HOME, prepared workspace, AGENT_WORKSPACE_SMOKE=1)"]
    fn runtime_smoke_end_to_end() {
        assert!(
            smoke_enabled(),
            "run this test through scripts/smoke-tauri-runtime.sh (AGENT_WORKSPACE_SMOKE=1)"
        );

        // The smoke applies setup artifacts under HOME: refuse anything but the
        // temp HOME the smoke script created.
        let home = PathBuf::from(std::env::var("HOME").expect("HOME for smoke"))
            .canonicalize()
            .expect("canonicalize HOME");
        let smoke_home =
            PathBuf::from(std::env::var("SMOKE_HOME").expect("SMOKE_HOME must name the temp HOME"))
                .canonicalize()
                .expect("canonicalize SMOKE_HOME");
        assert_eq!(
            home, smoke_home,
            "HOME must be the smoke script's temp HOME"
        );
        let temp_root = std::env::temp_dir()
            .canonicalize()
            .expect("canonicalize temp dir");
        assert!(
            home.starts_with(&temp_root),
            "smoke HOME {} must live under the temp dir {}",
            home.display(),
            temp_root.display()
        );

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

        apply_surfaces(&["open_code_config", "open_code_agents", "claude_agents"]);

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

        apply_surfaces(&["cursor_agents", "skills", "cursor_mcp"]);

        let cursor =
            serde_json::to_value(get_cursor_profile_health().expect("get_cursor_profile_health"))
                .expect("serialize cursor health");
        if field(&cursor, "status").as_str() != Some("synced") {
            panic!(
                "cursor health not synced: {}",
                serde_json::to_string_pretty(&cursor).unwrap_or_else(|_| cursor.to_string())
            );
        }
        assert_eq!(
            field(&cursor, "global_agents_status").as_str(),
            Some("synced")
        );

        let private_context_dir = workspace_canonical.join("private-context");
        assert!(
            !private_context_dir.exists(),
            "private-context must not exist in workspace"
        );

        // The setup above must have written its harness files under the temp HOME.
        for harness_dir in [
            ".config/opencode/agents",
            ".claude/agents",
            ".cursor/agents",
        ] {
            let path = home.join(harness_dir);
            assert!(
                path.is_dir(),
                "expected harness directory under smoke HOME: {}",
                path.display()
            );
        }
    }
}
