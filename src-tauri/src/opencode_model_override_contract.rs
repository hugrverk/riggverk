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
            None,
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
            None,
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
            None,
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
        crate::commands::update_opencode_model_selection(
            "a/b".to_string(),
            "c/d".to_string(),
            None,
        )
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
            None,
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
                    None,
                )
                .is_err(),
                "must reject {model:?} / {small_model:?}",
            );
        }
        assert_eq!(fs::read(&path).expect("read override after"), before);
    });
}

const ROLES: [&str; 5] = ["repo-scout", "inspector", "sentinel", "verifier", "scribe"];

fn read_stored_override() -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(stored_override_path()).expect("read stored override"))
        .expect("parse stored override")
}

#[test]
fn subagent_model_is_stored_with_the_override_and_cleared_by_saving_without_it() {
    with_isolated_home("subagent-store", |_home| {
        let message = crate::commands::update_opencode_model_selection(
            "main/large".to_string(),
            "main/small".to_string(),
            Some("  cheap/fast ".to_string()),
        )
        .expect("save override with a subagent model");
        assert!(message.contains("subagent_model=cheap/fast"), "{message}");

        let selection = crate::commands::read_opencode_model_selection().expect("read override");
        assert_eq!(selection.subagent_model, "cheap/fast");
        assert_eq!(
            (
                selection.source.as_str(),
                selection.subagent_source.as_str()
            ),
            ("override", "override")
        );
        assert_eq!(read_stored_override()["subagent_model"], "cheap/fast");

        // An empty value means "inherit the main model": the key is not stored at all.
        for unset in [None, Some("   ".to_string())] {
            crate::commands::update_opencode_model_selection(
                "main/large".to_string(),
                "main/small".to_string(),
                unset,
            )
            .expect("save override without a subagent model");
            let selection =
                crate::commands::read_opencode_model_selection().expect("read override");
            assert_eq!(selection.subagent_model, "");
            assert_eq!(selection.source, "override");
            assert_eq!(selection.subagent_source, "bundled default");
            assert!(read_stored_override().get("subagent_model").is_none());
        }
    });
}

#[test]
fn a_malformed_subagent_model_is_rejected_without_touching_the_saved_override() {
    with_isolated_home("subagent-reject", |_home| {
        crate::commands::update_opencode_model_selection(
            "good/model".to_string(),
            "good/small".to_string(),
            Some("good/subagent".to_string()),
        )
        .expect("seed override");
        let before = fs::read(stored_override_path()).expect("read seeded override");

        for bad in ["nope", "bad//model", "bad/mod el", "bad/model/"] {
            assert!(
                crate::commands::update_opencode_model_selection(
                    "good/model".to_string(),
                    "good/small".to_string(),
                    Some(bad.to_string()),
                )
                .is_err(),
                "must reject {bad:?}",
            );
        }
        assert_eq!(
            fs::read(stored_override_path()).expect("read after"),
            before
        );
    });
}

#[test]
fn install_merge_pins_exactly_the_five_roles_keeps_user_agent_keys_and_clearing_removes_them() {
    with_isolated_home("subagent-install", |home| {
        let template = serde_json::json!({
            "model": "template/large",
            "small_model": "template/small",
            "agent": {"plan": {"permission": {"edit": {"*": "deny"}}}},
        });
        let installed = serde_json::json!({
            "agent": {
                "repo-scout": {"description": "my scout", "model": "mine/old"},
                "architect": {"model": "mine/architect"},
                "custom": {"model": "mine/custom"},
            },
            "provider": {"mine": {}},
        });
        let install = |installed: &serde_json::Value| {
            let rendered = crate::commands::render_expected_opencode_config(&template, home)
                .expect("render expected config");
            crate::commands::merge_managed_opencode_config(
                installed,
                &crate::commands::extract_managed_opencode_config(&rendered),
            )
        };

        crate::commands::update_opencode_model_selection(
            "main/large".to_string(),
            "main/small".to_string(),
            Some("cheap/fast".to_string()),
        )
        .expect("save override");
        let pinned = install(&installed);
        for role in ROLES {
            assert_eq!(pinned["agent"][role]["model"], "cheap/fast", "{role}");
        }
        let mut agents: Vec<&str> = pinned["agent"]
            .as_object()
            .expect("agent block")
            .keys()
            .map(String::as_str)
            .collect();
        agents.sort_unstable();
        assert_eq!(
            agents,
            [
                "architect",
                "custom",
                "inspector",
                "plan",
                "repo-scout",
                "scribe",
                "sentinel",
                "verifier"
            ]
        );
        assert_eq!(pinned["agent"]["repo-scout"]["description"], "my scout");
        assert_eq!(
            pinned["agent"]["architect"],
            installed["agent"]["architect"]
        );
        assert_eq!(pinned["agent"]["custom"], installed["agent"]["custom"]);
        assert_eq!(pinned["provider"], installed["provider"]);
        assert_eq!(pinned["model"], "main/large");

        // Reset, then install again: the managed entries go, the user's keys stay.
        crate::commands::reset_opencode_model_selection().expect("reset override");
        let cleared = install(&pinned);
        assert_eq!(cleared["model"], "template/large");
        assert_eq!(
            cleared["agent"]["repo-scout"],
            serde_json::json!({"description": "my scout"})
        );
        assert_eq!(
            cleared["agent"]["architect"],
            installed["agent"]["architect"]
        );
        assert_eq!(cleared["agent"]["custom"], installed["agent"]["custom"]);
        for role in ["inspector", "sentinel", "verifier", "scribe"] {
            assert!(cleared["agent"].get(role).is_none(), "{role}");
        }
        assert_eq!(cleared["agent"]["plan"], template["agent"]["plan"]);
    });
}

#[test]
fn reset_deletes_the_override_and_returns_to_the_bundled_default() {
    with_isolated_home("reset", |_home| {
        crate::commands::update_opencode_model_selection(
            "main/large".to_string(),
            "main/small".to_string(),
            Some("cheap/fast".to_string()),
        )
        .expect("save override");
        assert!(stored_override_path().is_file());

        let message = crate::commands::reset_opencode_model_selection().expect("reset");
        assert!(message.contains("removed"), "{message}");
        assert!(!stored_override_path().exists(), "the file is gone");
        let leftovers: Vec<_> = fs::read_dir(stored_override_path().parent().expect("parent"))
            .expect("list app support dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("opencode-model-selection"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        let selection = crate::commands::read_opencode_model_selection().expect("read");
        assert_ne!(selection.model, "main/large");
        assert_eq!(selection.subagent_model, "");
        assert_eq!(
            (
                selection.source.as_str(),
                selection.subagent_source.as_str()
            ),
            ("bundled default", "bundled default")
        );

        // Resetting what is not there is not an error.
        assert!(crate::commands::reset_opencode_model_selection().is_ok());
    });
}

#[test]
fn reset_removes_an_override_file_that_no_longer_parses() {
    with_isolated_home("reset-corrupt", |_home| {
        let path = stored_override_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("create app support dir");
        fs::write(&path, "{not json").expect("write corrupt override");
        let selection = crate::commands::read_opencode_model_selection().expect("read");
        assert_eq!(selection.source, "bundled default");

        crate::commands::reset_opencode_model_selection().expect("reset");
        assert!(!path.exists());
    });
}

#[test]
fn a_real_install_pins_the_roles_and_the_next_one_removes_them_after_a_reset() {
    with_isolated_home("apply", |home| {
        unsafe {
            std::env::set_var("AGENT_WORKSPACE_PATH", home.join("workspace"));
            std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", home.join("backups"));
        }
        let home = crate::agent_targets::home_dir().expect("resolved home");
        let config_path = home.join(".config/opencode/opencode.json");
        fs::create_dir_all(config_path.parent().expect("parent")).expect("config dir");
        let user_agent_keys = serde_json::json!({
            "repo-scout": {"description": "my scout"},
            "custom": {"model": "mine/custom"},
        });
        fs::write(
            &config_path,
            serde_json::json!({"agent": user_agent_keys, "provider": {"mine": {}}}).to_string(),
        )
        .expect("seed installed config");

        let install = || {
            let plan =
                crate::commands::preview_setup(vec!["open_code_config".into()]).expect("preview");
            let result = crate::commands::apply_setup(
                vec!["open_code_config".into()],
                true,
                plan.plan_fingerprint.clone(),
                plan.preview_token.clone(),
            )
            .expect("apply");
            assert!(result.success, "{}", result.message);
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&config_path).expect("read installed config"),
            )
            .expect("parse installed config")
        };

        crate::commands::update_opencode_model_selection(
            "main/large".to_string(),
            "main/small".to_string(),
            Some("cheap/fast".to_string()),
        )
        .expect("save override");
        let pinned = install();
        assert_eq!(pinned["model"], "main/large");
        for role in ROLES {
            assert_eq!(pinned["agent"][role]["model"], "cheap/fast", "{role}");
        }
        assert!(pinned["agent"].get("architect").is_none());
        assert_eq!(pinned["agent"]["repo-scout"]["description"], "my scout");
        assert_eq!(pinned["agent"]["custom"], user_agent_keys["custom"]);
        assert_eq!(pinned["provider"], serde_json::json!({"mine": {}}));

        crate::commands::reset_opencode_model_selection().expect("reset");
        let cleared = install();
        assert_ne!(cleared["model"], "main/large");
        assert!(!cleared.to_string().contains("cheap/fast"), "{cleared}");
        assert_eq!(
            cleared["agent"]["repo-scout"],
            serde_json::json!({"description": "my scout"})
        );
        assert_eq!(cleared["agent"]["custom"], user_agent_keys["custom"]);
        for role in ["inspector", "sentinel", "verifier", "scribe"] {
            assert!(cleared["agent"].get(role).is_none(), "{role}");
        }
        assert_eq!(cleared["provider"], serde_json::json!({"mine": {}}));
    });
}
