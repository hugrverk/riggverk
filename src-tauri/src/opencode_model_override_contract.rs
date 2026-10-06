use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("agent-workspace-model-override-{name}-{nonce}"))
}

fn write_file(root: &Path, rel: &str, content: &str) -> PathBuf {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    fs::write(&path, content).expect("write file");
    path
}

fn with_isolated_home<T>(name: &str, run: impl FnOnce(&Path) -> T) -> T {
    let _guard = crate::test_env::guard::lock();
    let _env = crate::test_env::guard::EnvRestore::capture();
    let home = temp_root(name);
    fs::create_dir_all(&home).expect("create home");
    crate::test_env::set_test_user_dirs(&home);

    let result = run(&home);

    let _ = fs::remove_dir_all(&home);
    result
}

#[test]
fn update_model_selection_writes_override_without_touching_workspace_templates() {
    with_isolated_home("write", |_home| {
        let workspace = temp_root("workspace");
        let base = write_file(
            &workspace,
            "templates/opencode.base.json",
            r#"{"model":"old/model","small_model":"old/small"}"#,
        );
        let snapshot = write_file(
            &workspace,
            "templates/opencode.json",
            r#"{"model":"old/model","small_model":"old/small"}"#,
        );
        let base_before = fs::read_to_string(&base).expect("read base before");
        let snapshot_before = fs::read_to_string(&snapshot).expect("read snapshot before");

        let message = crate::commands::update_opencode_model_selection(
            "new-provider/new-model".to_string(),
            "new-provider/new-small".to_string(),
        )
        .expect("save override");
        assert!(message.contains("Run Install/Update"));

        assert_eq!(
            fs::read_to_string(&base).expect("read base after"),
            base_before,
            "model selection must not mutate opencode.base.json",
        );
        assert_eq!(
            fs::read_to_string(&snapshot).expect("read snapshot after"),
            snapshot_before,
            "model selection must not mutate opencode.json",
        );

        let selection = crate::commands::read_opencode_model_selection().expect("read override");
        assert_eq!(selection.model, "new-provider/new-model");
        assert_eq!(selection.small_model, "new-provider/new-small");

        let _ = fs::remove_dir_all(&workspace);
    });
}

#[test]
fn render_expected_opencode_config_applies_saved_model_override() {
    with_isolated_home("render", |home| {
        crate::commands::update_opencode_model_selection(
            "override-provider/large".to_string(),
            "override-provider/small".to_string(),
        )
        .expect("save override");

        let template = serde_json::json!({
            "model": "template-provider/large",
            "small_model": "template-provider/small",
            "mcp": {
                "playwright": {
                    "environment": {
                        "PLAYWRIGHT_BROWSERS_PATH": "__PLAYWRIGHT_BROWSERS_PATH__"
                    }
                }
            }
        });
        let rendered = crate::commands::render_expected_opencode_config(&template, home)
            .expect("render expected config");

        assert_eq!(
            rendered.get("model").and_then(|v| v.as_str()),
            Some("override-provider/large"),
        );
        assert_eq!(
            rendered.get("small_model").and_then(|v| v.as_str()),
            Some("override-provider/small"),
        );
    });
}

fn stored_override_path() -> PathBuf {
    crate::platform_paths::app_support_dir(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .expect("app support dir")
    .join("opencode-model-selection.json")
}

#[test]
fn update_model_selection_accepts_nested_ids_and_persists_trimmed_values() {
    with_isolated_home("nested", |_home| {
        let message = crate::commands::update_opencode_model_selection(
            "  lmstudio/google/gemma-3n-e4b \n".to_string(),
            " opencode-go/deepseek-v4-flash ".to_string(),
        )
        .expect("nested provider/org/model ids are valid");
        assert!(message.contains("model=lmstudio/google/gemma-3n-e4b,"));

        let selection = crate::commands::read_opencode_model_selection().expect("read override");
        assert_eq!(selection.model, "lmstudio/google/gemma-3n-e4b");
        assert_eq!(selection.small_model, "opencode-go/deepseek-v4-flash");

        let stored: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(stored_override_path()).expect("read stored override"),
        )
        .expect("parse stored override");
        assert_eq!(stored["model"], "lmstudio/google/gemma-3n-e4b");
        assert_eq!(stored["small_model"], "opencode-go/deepseek-v4-flash");

        // Repeated saves use no fixed temp name and leave no temp file behind.
        crate::commands::update_opencode_model_selection("a/b".to_string(), "c/d".to_string())
            .expect("second save");
        let leftovers: Vec<_> = fs::read_dir(stored_override_path().parent().expect("parent"))
            .expect("list app support dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
    });
}

#[test]
fn update_model_selection_rejects_malformed_ids_without_touching_saved_override() {
    with_isolated_home("reject", |_home| {
        crate::commands::update_opencode_model_selection(
            "good/model".to_string(),
            "good/small".to_string(),
        )
        .expect("seed override");
        let path = stored_override_path();
        let before = fs::read(&path).expect("read seeded override");

        for (model, small_model) in [
            ("provider//model", "good/small"),
            ("good/model", "good/small/"),
            ("good/mod el", "good/small"),
            ("good/model", "good/sm\nall"),
            ("justmodel", "good/small"),
            ("", "good/small"),
        ] {
            assert!(
                crate::commands::update_opencode_model_selection(
                    model.to_string(),
                    small_model.to_string(),
                )
                .is_err(),
                "must reject {model:?} / {small_model:?}",
            );
        }
        assert_eq!(fs::read(&path).expect("read override after"), before);
    });
}
