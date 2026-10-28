//! End to end: a JSONC `opencode.json` through the review and an install. Temp HOME only.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::setup_lifecycle::{OperationKind, SetupPlan, SetupSurfaceId};

/// Stands for a secret in the user's file: it must never reach the review.
const SECRET: &str = "sk-test-PRIVATE-456";

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("riggverk-precedence-contract-{name}-{nonce}"))
}

fn preview() -> SetupPlan {
    crate::commands::preview_setup(vec!["open_code_config".into()]).expect("preview")
}

fn apply(plan: &SetupPlan) -> Result<crate::commands::setup::SetupResult, String> {
    crate::commands::apply_setup(
        vec!["open_code_config".into()],
        true,
        plan.plan_fingerprint.clone(),
        plan.preview_token.clone(),
    )
}

#[test]
fn a_commented_opencode_json_is_reviewed_with_its_reason_and_never_rewritten() {
    let _guard = crate::test_env::guard::lock();
    let _env = crate::test_env::guard::EnvRestore::capture();
    let base = temp_root("commented");
    fs::create_dir_all(&base).expect("create base");
    crate::test_env::set_test_user_dirs(&base);
    unsafe {
        std::env::set_var("RIGGVERK_WORKSPACE_PATH", base.join("workspace"));
        std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
    }
    let home = crate::agent_targets::home_dir().expect("resolved home");
    let config = home.join(".config/opencode/opencode.json");

    let first = apply(&preview()).expect("first install");
    assert!(first.success, "{}", first.message);
    let strict = fs::read_to_string(&config).expect("installed config");
    let mut installed: serde_json::Value = serde_json::from_str(&strict).expect("strict JSON");

    // OpenCode reads both files below; the app compares them but never writes either.
    let commented = format!("// mine: {SECRET}\n{strict}");
    installed["model"] = serde_json::json!("mine/other");
    let changed = format!(
        "// mine: {SECRET}\n{},\n}}\n",
        serde_json::to_string_pretty(&installed)
            .unwrap()
            .trim_end()
            .strip_suffix('}')
            .unwrap()
    );
    for (text, reason) in [
        (&commented, "opencode.json has comments;"),
        (&changed, "opencode.json has comments and trailing commas;"),
    ] {
        fs::write(&config, text).expect("write JSONC config");
        let plan = preview();
        let operation = plan
            .operations
            .iter()
            .find(|op| op.surface == SetupSurfaceId::OpenCodeConfig)
            .expect("config operation");
        assert_eq!(operation.kind, OperationKind::Conflict, "{operation:?}");
        assert!(
            operation.summary.contains(reason) && operation.summary.contains("opencode.jsonc"),
            "{}",
            operation.summary
        );
        let review = serde_json::to_string(&plan).expect("serialize plan");
        assert!(
            !review.contains(SECRET) && !review.contains("mine:"),
            "{review}"
        );

        let _ = apply(&plan);
        assert_eq!(
            &fs::read_to_string(&config).expect("config after apply"),
            text,
            "the app never rewrites a JSONC opencode.json"
        );
    }

    let _ = fs::remove_dir_all(&base);
}
