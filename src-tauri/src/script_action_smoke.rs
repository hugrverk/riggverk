#[cfg(test)]
mod tests {
    use crate::commands::run_action;

    fn smoke_enabled() -> bool {
        std::env::var("AGENT_WORKSPACE_SMOKE").ok().as_deref() == Some("1")
    }

    #[test]
    fn harness_diff_actions_return_successful_previews() {
        if !smoke_enabled() {
            eprintln!("skip harness_diff_actions_return_successful_previews");
            return;
        }

        for action in [
            "diff_codex_rules",
            "diff_opencode_rules",
            "diff_opencode_agents",
        ] {
            let result = run_action(action.to_string())
                .unwrap_or_else(|error| panic!("{action} command error: {error}"));
            assert!(
                result.success,
                "{action} failed: exit={:?} stdout={:?} stderr={:?}",
                result.exit_code, result.stdout, result.stderr
            );
            assert_eq!(result.exit_code, Some(0), "{action} exit code");
            assert!(
                !result.stdout.trim().is_empty(),
                "{action} must return useful preview output"
            );
            assert!(
                result.stderr.trim().is_empty(),
                "{action} unexpected stderr: {:?}",
                result.stderr
            );
        }
    }
}
