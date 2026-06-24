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

fn restore_env(key: &str, value: Option<String>) {
    unsafe {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
}

fn with_isolated_home<T>(name: &str, run: impl FnOnce(&Path) -> T) -> T {
    let _guard = crate::test_env::guard::lock();
    let home = temp_root(name);
    fs::create_dir_all(&home).expect("create home");

    let old_home = std::env::var("HOME").ok();
    let old_xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let old_appdata = std::env::var("APPDATA").ok();
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("APPDATA");
    }

    let result = run(&home);

    restore_env("HOME", old_home);
    restore_env("XDG_CONFIG_HOME", old_xdg);
    restore_env("APPDATA", old_appdata);
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
