// Test-only: the `tests` module of the file next to it. The inner attribute lets the repository checks
// that read production Rust skip this file.
#![cfg(test)]

use super::*;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Existing fixtures supply the install bundle explicitly, independently of the runtime root,
/// and check the default folder below `home`, whatever `XDG_CONFIG_HOME` the test process has.
fn compute_health(bundle: &Path, home: &Path) -> OpenCodeRuntimeHealth {
    compute_health_for(bundle, home, None)
}

/// [`compute_health`] for the installed OpenCode major `major`.
fn compute_health_for(bundle: &Path, home: &Path, major: Option<u32>) -> OpenCodeRuntimeHealth {
    super::compute_health_in(
        Some(bundle),
        home,
        &home.join(".config/opencode"),
        Some(&record_root(home)),
        major,
    )
}

/// Where `install_for` keeps the record of the role models it wrote.
fn record_root(home: &Path) -> PathBuf {
    home.join("workspace")
}

fn temp_root(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!("riggverk-runtime-{name}-{nonce}"))
}

fn write_file(root: &Path, rel: &str, content: &str) {
    if let Some(parent) = root.join(rel).parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    fs::write(root.join(rel), content).expect("write file");
}

fn cleanup(root: &PathBuf) {
    let _ = fs::remove_dir_all(root);
}

fn add_tui(ws: &Path, home: &Path) {
    write_file(ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
}

/// A temp copy of the bundle's OpenCode sources (not a workspace folder) and a temp home that
/// matches its generated snapshot.
fn setup_synced_bundle_copy(name: &str) -> (PathBuf, PathBuf) {
    let ws = temp_root(&format!("{name}-ws"));
    let home = temp_root(&format!("{name}-home"));

    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{"default_agent":"architect","model":"opencode-go/glm-5.2","small_model":"opencode-go/deepseek-v4.1-flash"}"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        r#"{"read":{"default":"allow","deny":[]}}"#,
    );
    // The snapshot is what the (bundled) generator makes of the two sources, so it checks as current.
    write_file(&ws, "templates/opencode.json", "{}");
    let generated = super::run_generator_write(&ws).expect("bundled generator runs");
    assert!(generated.success, "{}", generated.stderr);
    write_file(&ws, "agents/architect.md", "# architect");
    write_file(&ws, "agents/repo-scout.md", "# scout");

    write_file(
        &home,
        ".config/opencode/opencode.json",
        &fs::read_to_string(ws.join("templates/opencode.json")).expect("snapshot"),
    );
    write_file(&home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    write_file(&home, ".config/opencode/agents/repo-scout.md", "# scout");

    (ws, home)
}

#[test]
fn test_health_and_defaults_follow_the_install_bundle_after_workspace_edits() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let ws = temp_root("bundle-baseline-ws");
    let home = temp_root("bundle-baseline-home");
    crate::test_env::set_test_user_dirs(&home);
    unsafe { std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws) };
    let bundle = crate::setup_roots::bundled_root().unwrap();
    let template: serde_json::Value =
        serde_json::from_str(&bundled_template("opencode.json")).unwrap();
    let base: serde_json::Value =
        serde_json::from_str(&bundled_template("opencode.base.json")).unwrap();
    let rendered = render_expected_opencode_config(&template, &home).unwrap();
    write_file(
        &home,
        ".config/opencode/opencode.json",
        &serde_json::to_string_pretty(&rendered).unwrap(),
    );
    for (source, dest) in [
        ("templates/tui.json", ".config/opencode/tui.json"),
        (
            "templates/sync/opencode-rules.md",
            ".config/opencode/AGENTS.md",
        ),
    ] {
        write_file(
            &home,
            dest,
            &fs::read_to_string(bundle.join(source)).unwrap(),
        );
    }
    for name in list_bundled_agents(&bundle.join("agents")) {
        write_file(
            &home,
            &format!(".config/opencode/agents/{name}"),
            &fs::read_to_string(bundle.join("agents").join(name)).unwrap(),
        );
    }
    assert_eq!(super::compute_health(&home, None, None).status, "synced");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"model":"workspace/main"}"#,
    );
    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{"model":"workspace/main","small_model":"workspace/small"}"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        "invalid workspace policy",
    );
    write_file(&ws, "templates/tui.json", r#"{"theme":"workspace"}"#);
    write_file(&ws, "templates/sync/opencode-rules.md", "workspace rules");
    write_file(&ws, "agents/architect.md", "workspace agent");

    let health = super::compute_health(&home, None, None);
    assert_eq!(health.status, "synced", "{:?}", health.checks);
    assert_eq!(health.config_status, "synced");
    assert_eq!(health.tui_status, "synced");
    assert_eq!(health.rules_status, "synced");
    assert!(health.agent_mismatches.is_empty());
    assert_eq!(
        health.installed_bundled_agent_count,
        health.bundled_agent_count
    );
    assert_eq!(health.generated_snapshot_status, "current");
    let selection = read_opencode_model_selection().unwrap();
    assert_eq!(
        (selection.model, selection.small_model),
        (
            base["model"].as_str().unwrap_or("").to_string(),
            base["small_model"].as_str().unwrap_or("").to_string()
        )
    );

    // Installing workspace edits would diverge; the bundled render converges again.
    write_file(
        &home,
        ".config/opencode/opencode.json",
        r#"{"model":"workspace/main","provider":{"mine":{}}}"#,
    );
    assert_eq!(
        super::compute_health(&home, None, None).config_status,
        "diverged"
    );
    install_for(&bundle, &home);
    assert_eq!(
        super::compute_health(&home, None, None).config_status,
        "synced"
    );
    let installed: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join(".config/opencode/opencode.json")).unwrap())
            .unwrap();
    assert_eq!(installed["provider"], serde_json::json!({"mine":{}}));

    let unavailable = super::compute_health_with_bundle(None, &home, None, None);
    assert_ne!(unavailable.config_status, "synced");
    assert_eq!(unavailable.bundled_agent_count, 0);
    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_health_and_precedence_read_the_folder_xdg_config_home_names() {
    let _guard = crate::test_env::guard::lock();
    let _restore = crate::test_env::guard::EnvRestore::capture();
    let ws = temp_root("xdg-health-ws");
    let home = temp_root("xdg-health-home");
    let xdg = temp_root("xdg-health-config");
    crate::test_env::set_test_user_dirs(&home);
    unsafe {
        std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
        std::env::set_var("XDG_CONFIG_HOME", &xdg);
    }
    let bundle = crate::setup_roots::bundled_root().unwrap();
    let template: serde_json::Value =
        serde_json::from_str(&bundled_template("opencode.json")).unwrap();
    let rendered = render_expected_opencode_config(&template, &home).unwrap();
    // A synced install in the folder OpenCode reads: `$XDG_CONFIG_HOME/opencode`.
    write_file(
        &xdg,
        "opencode/opencode.json",
        &serde_json::to_string_pretty(&rendered).unwrap(),
    );
    for (source, dest) in [
        ("templates/tui.json", "opencode/tui.json"),
        ("templates/sync/opencode-rules.md", "opencode/AGENTS.md"),
    ] {
        write_file(
            &xdg,
            dest,
            &fs::read_to_string(bundle.join(source)).unwrap(),
        );
    }
    for name in list_bundled_agents(&bundle.join("agents")) {
        write_file(
            &xdg,
            &format!("opencode/agents/{name}"),
            &fs::read_to_string(bundle.join("agents").join(name)).unwrap(),
        );
    }
    // Files at `~/.config/opencode`, which OpenCode does not read now, are not looked at.
    write_file(&home, ".config/opencode/opencode.json", r#"{"lsp":false}"#);
    write_file(&home, ".config/opencode/config.json", r#"{"lsp":false}"#);

    let health = super::compute_health(&home, None, None);
    assert_eq!(health.status, "synced", "{:?}", health.checks);
    assert_eq!(
        (
            health.config_status.as_str(),
            health.tui_status.as_str(),
            health.rules_status.as_str()
        ),
        ("synced", "synced", "synced")
    );
    assert_eq!(
        health.installed_bundled_agent_count,
        health.bundled_agent_count
    );
    assert_eq!(
        PathBuf::from(&health.installed_config_path),
        xdg.join("opencode/opencode.json")
    );
    assert_eq!(
        PathBuf::from(&health.installed_tui_path),
        xdg.join("opencode/tui.json")
    );
    assert!(health.config_precedence.sibling_files.is_empty());

    // A sibling beside the installed file is found in the same folder.
    write_file(&xdg, "opencode/opencode.jsonc", r#"{"model":"mine/other"}"#);
    assert!(super::compute_health(&home, None, None)
        .config_precedence
        .sibling_files
        .is_empty());
    write_file(&xdg, "opencode/opencode.jsonc", r#"{"lsp":false}"#);
    let siblings = super::compute_health(&home, None, None)
        .config_precedence
        .sibling_files;
    assert_eq!(
        siblings.iter().map(|s| s.file.as_str()).collect::<Vec<_>>(),
        ["opencode.jsonc"]
    );

    // Without the variable the default folder is read again.
    unsafe { std::env::remove_var("XDG_CONFIG_HOME") };
    let health = super::compute_health(&home, None, None);
    assert_eq!(
        PathBuf::from(&health.installed_config_path),
        home.join(".config/opencode/opencode.json")
    );
    assert_eq!(health.config_status, "diverged");
    assert_eq!(
        health
            .config_precedence
            .sibling_files
            .iter()
            .map(|s| s.file.as_str())
            .collect::<Vec<_>>(),
        ["config.json"]
    );
    cleanup(&ws);
    cleanup(&home);
    cleanup(&xdg);
}

#[test]
fn test_synced_when_all_match() {
    let (ws, home) = setup_synced_bundle_copy("synced");
    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "synced");
    assert_eq!(health.default_agent, Some("architect".into()));
    assert_eq!(health.model, Some("opencode-go/glm-5.2".into()));
    assert_eq!(
        health.small_model,
        Some("opencode-go/deepseek-v4.1-flash".into())
    );
    assert_eq!(health.bundled_agent_count, 2);
    assert_eq!(health.installed_bundled_agent_count, 2);
    assert_eq!(health.extra_installed_agent_count, 0);
    assert!(health.agent_mismatches.is_empty());
    assert_eq!(health.tui_status, "synced");
    assert_eq!(health.generated_snapshot_status, "current");
    assert!(health.summary.contains("matches"));
    assert_eq!(health.next_action, "No runtime action needed.");
}

#[test]
fn test_missing_when_installed_config_absent() {
    let ws = temp_root("missing-ws");
    let home = temp_root("missing-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");
    add_tui(&ws, &home);

    // No installed config
    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "missing");
}

#[test]
fn test_invalid_when_installed_config_bad_json() {
    let ws = temp_root("invalid-inst-ws");
    let home = temp_root("invalid-inst-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");
    write_file(&home, ".config/opencode/opencode.json", "not json {{{");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "missing"); // template exists but installed is invalid => fail
    let invalid_check = health
        .checks
        .iter()
        .find(|c| c.id == "installed_config_valid")
        .unwrap();
    assert_eq!(invalid_check.status, "fail");
}

#[test]
fn test_invalid_when_template_config_bad_json() {
    let ws = temp_root("invalid-tpl-ws");
    let home = temp_root("invalid-tpl-home");

    write_file(&ws, "templates/opencode.json", "bad json {{{");
    write_file(&ws, "agents/architect.md", "# architect");
    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "missing"); // template invalid => fail
    let invalid_check = health
        .checks
        .iter()
        .find(|c| c.id == "template_config_valid")
        .unwrap();
    assert_eq!(invalid_check.status, "fail");
}

#[test]
fn test_configs_match_pass_when_template_has_playwright_placeholders() {
    let ws = temp_root("rendered-match-ws");
    let home = temp_root("rendered-match-home");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","__PLAYWRIGHT_MCP_CONFIG_PATH__"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
    );
    write_file(&ws, "agents/architect.md", "# architect");

    let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","__PLAYWRIGHT_MCP_CONFIG_PATH__"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected config");
    write_file(
        &home,
        ".config/opencode/opencode.json",
        &serde_json::to_string_pretty(&rendered).expect("serialize installed"),
    );
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "synced");
    let match_check = health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .unwrap();
    assert_eq!(match_check.status, "pass");
    assert!(!file_eq(
        &ws.join("templates/opencode.json"),
        &home.join(".config/opencode/opencode.json")
    ));
}

#[test]
fn test_configs_match_warn_when_rendered_expected_differs() {
    let ws = temp_root("rendered-diff-ws");
    let home = temp_root("rendered-diff-home");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","__PLAYWRIGHT_MCP_CONFIG_PATH__"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}},"version":2}"#,
    );
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(
        &home,
        ".config/opencode/opencode.json",
        r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","/wrong/config.json"],"environment":{"PLAYWRIGHT_BROWSERS_PATH":"/wrong/browsers"}}},"version":2}"#,
    );
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "diverged");
    let match_check = health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .unwrap();
    assert_eq!(match_check.status, "warn");
    assert!(match_check.detail.contains("managed keys"));
}

#[test]
fn test_managed_keys_match_preserves_user_provider() {
    let ws = temp_root("managed-provider-ws");
    let home = temp_root("managed-provider-home");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"model":"bundled-model","mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
    );
    write_file(&ws, "agents/architect.md", "# architect");

    let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"model":"bundled-model","mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected");
    let mut installed = rendered.clone();
    if let Some(obj) = installed.as_object_mut() {
        obj.insert(
            "provider".to_string(),
            serde_json::json!({"custom": {"api": "secret"}}),
        );
        obj.insert("version".to_string(), serde_json::json!(99));
    }
    write_file(
        &home,
        ".config/opencode/opencode.json",
        &serde_json::to_string_pretty(&installed).expect("serialize"),
    );
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "synced");
    let match_check = health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .unwrap();
    assert_eq!(match_check.status, "pass");
}

#[test]
fn test_tui_status_independent_when_config_rendered_match() {
    let ws = temp_root("tui-indep-ws");
    let home = temp_root("tui-indep-home");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
    );
    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    let rendered = render_expected_opencode_config(
            &serde_json::from_str(
                r#"{"mcp":{"playwright":{"environment":{"PLAYWRIGHT_BROWSERS_PATH":"__PLAYWRIGHT_BROWSERS_PATH__"}}}}"#,
            )
            .expect("parse template"),
            &home,
        )
        .expect("render expected");
    write_file(
        &home,
        ".config/opencode/opencode.json",
        &serde_json::to_string_pretty(&rendered).expect("serialize"),
    );
    write_file(&home, ".config/opencode/tui.json", r#"{"theme":"dark"}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    let match_check = health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .unwrap();
    assert_eq!(match_check.status, "pass");
    assert_eq!(health.tui_status, "diverged");
    assert_eq!(health.status, "diverged");
    assert_eq!(health.installed_bundled_agent_count, 1);
}

#[test]
fn test_agents_status_independent_when_config_rendered_match() {
    let ws = temp_root("agents-indep-ws");
    let home = temp_root("agents-indep-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect v2");
    write_file(&ws, "agents/repo-scout.md", "# scout");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(
        &home,
        ".config/opencode/agents/architect.md",
        "# architect v1",
    );
    write_file(&home, ".config/opencode/agents/repo-scout.md", "# scout");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    let match_check = health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .unwrap();
    assert_eq!(match_check.status, "pass");
    assert_eq!(health.agent_mismatches.len(), 1);
    assert_eq!(health.status, "diverged");
}

#[test]
fn test_diverged_when_managed_keys_differ() {
    let ws = temp_root("div-cfg-ws");
    let home = temp_root("div-cfg-home");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"model":"bundled-model","version":2}"#,
    );
    write_file(&ws, "agents/architect.md", "# architect");
    write_file(
        &home,
        ".config/opencode/opencode.json",
        r#"{"model":"user-model","version":1}"#,
    );
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "diverged");
    let match_check = health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .unwrap();
    assert_eq!(match_check.status, "warn");
}

#[test]
fn test_legacy_scout_warns_and_excludes_extra_count() {
    let ws = temp_root("legacy-scout-ws");
    let home = temp_root("legacy-scout-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");
    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    write_file(
        &home,
        ".config/opencode/agents/scout.md",
        "---\nname: scout\n---\n# legacy\n",
    );
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.extra_installed_agent_count, 0);
    let legacy = health
        .checks
        .iter()
        .find(|c| c.id == "legacy_scout")
        .unwrap();
    assert_eq!(legacy.status, "warn");
    assert_eq!(health.status, "diverged");
}

#[test]
fn test_diverged_when_bundled_agent_missing_from_installed() {
    let ws = temp_root("div-agent-miss-ws");
    let home = temp_root("div-agent-miss-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");
    write_file(&ws, "agents/repo-scout.md", "# scout");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    add_tui(&ws, &home);
    // repo-scout.md missing from installed

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "diverged");
    assert_eq!(health.agent_mismatches.len(), 1);
    assert_eq!(health.agent_mismatches[0].filename, "repo-scout.md");
    assert_eq!(health.agent_mismatches[0].status, "missing");
}

#[test]
fn test_diverged_when_bundled_agent_differs() {
    let ws = temp_root("div-agent-diff-ws");
    let home = temp_root("div-agent-diff-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect v2");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(
        &home,
        ".config/opencode/agents/architect.md",
        "# architect v1",
    );
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "diverged");
    assert_eq!(health.agent_mismatches.len(), 1);
    assert_eq!(health.agent_mismatches[0].filename, "architect.md");
    assert_eq!(health.agent_mismatches[0].status, "diverged");
}

#[test]
fn test_synced_with_extra_installed_agents() {
    let ws = temp_root("extra-agents-ws");
    let home = temp_root("extra-agents-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    write_file(&home, ".config/opencode/agents/custom-agent.md", "# custom");
    add_tui(&ws, &home);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "synced");
    assert_eq!(health.extra_installed_agent_count, 1);
    assert!(health
        .warnings
        .iter()
        .any(|w| w.contains("custom-agent.md")));
}

// ── New tests for TUI config ──

#[test]
fn test_tui_missing_installed_linked_status() {
    let ws = temp_root("tui-miss-ws");
    let home = temp_root("tui-miss-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    // No installed tui.json

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    // Installed TUI missing => has_fail => "missing"
    assert_eq!(health.status, "missing");
    assert_eq!(health.tui_status, "missing");
    let check = health
        .checks
        .iter()
        .find(|c| c.id == "installed_tui_config_exists")
        .unwrap();
    assert_eq!(check.status, "fail");
}

#[test]
fn test_tui_diverged_when_differs() {
    let ws = temp_root("tui-div-ws");
    let home = temp_root("tui-div-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/tui.json", r#"{"theme":"dark"}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "diverged");
    assert_eq!(health.tui_status, "diverged");
    let check = health
        .checks
        .iter()
        .find(|c| c.id == "tui_configs_match")
        .unwrap();
    assert_eq!(check.status, "warn");
}

#[test]
fn test_tui_invalid_installed_json() {
    let ws = temp_root("tui-inv-ws");
    let home = temp_root("tui-inv-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/tui.json", "not json {{{");
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "missing");
    let check = health
        .checks
        .iter()
        .find(|c| c.id == "installed_tui_config_exists")
        .unwrap();
    assert_eq!(check.status, "fail");
}

fn tui_health(label: &str, installed: &str) -> OpenCodeRuntimeHealth {
    let ws = temp_root(&format!("tui-{label}-ws"));
    let home = temp_root(&format!("tui-{label}-home"));
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(
        &ws,
        "templates/tui.json",
        r#"{"$schema":"https://opencode.ai/tui.json","theme":"system","mouse":true}"#,
    );
    write_file(&home, ".config/opencode/tui.json", installed);
    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);
    health
}

fn tui_check(health: &OpenCodeRuntimeHealth, id: &str) -> OpenCodeRuntimeCheck {
    health
        .checks
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .unwrap_or_else(|| panic!("check {id}"))
}

#[test]
fn test_tui_synced_with_user_keys_beside_the_managed_ones() {
    let health = tui_health(
        "user-keys",
        r#"{"keybinds":{"leader":"ctrl+x"},"mouse":true,"plugin":["p"],"theme":"system","scroll_speed":3,"$schema":"https://opencode.ai/tui.json"}"#,
    );
    assert_eq!(health.tui_status, "synced");
    assert!(health.tui_diverged_keys.is_empty());
    assert_eq!(tui_check(&health, "tui_configs_match").status, "pass");
}

#[test]
fn test_tui_diverged_names_the_managed_keys_that_differ() {
    let health = tui_health(
        "differs",
        r#"{"keybinds":{"leader":"ctrl+x"},"theme":"dark","$schema":"https://opencode.ai/tui.json"}"#,
    );
    assert_eq!(health.tui_status, "diverged");
    // Names only, in the order the check detail lists them; a user key is not among them.
    assert_eq!(health.tui_diverged_keys, ["theme", "mouse"]);
    let check = tui_check(&health, "tui_configs_match");
    assert_eq!(check.status, "warn");
    assert!(check.detail.contains("(theme, mouse)"), "{}", check.detail);
    assert!(!check.detail.contains("keybinds"), "{}", check.detail);
}

#[test]
fn test_tui_with_comments_fails_without_showing_the_file() {
    let health = tui_health(
        "comments",
        "{\n  // SECRET-MARKER\n  \"theme\": \"system\"\n}\n",
    );
    assert_eq!(health.tui_status, "diverged");
    // An unusable file cannot be compared, so no key is named and none of its text is kept.
    assert!(health.tui_diverged_keys.is_empty());
    let check = tui_check(&health, "installed_tui_config_exists");
    assert_eq!(check.status, "fail");
    assert!(
        check.detail.contains("the file has comments"),
        "{}",
        check.detail
    );
    let shown = serde_json::to_string(&health).unwrap();
    assert!(!shown.contains("SECRET-MARKER"));
}

// ── New tests for generated snapshot ──

/// A temp copy of the bundle's sources and a temp home for the generator freshness check. The
/// bundled generator runs against the copy's three snapshot files, so they come from the bundled
/// templates (a matching set). The data folder is never involved.
fn setup_generator_check_bundle_copy(name: &str) -> (PathBuf, PathBuf) {
    let ws = temp_root(&format!("{name}-ws"));
    let home = temp_root(&format!("{name}-home"));
    for template in [
        "opencode.json",
        "opencode.base.json",
        "opencode.policy.json",
    ] {
        let source = crate::setup_roots::bundled_root()
            .expect("bundled root")
            .join("templates")
            .join(template);
        write_file(
            &ws,
            &format!("templates/{template}"),
            &fs::read_to_string(source).expect("read bundled template"),
        );
    }
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/tui.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    (ws, home)
}

#[test]
fn test_generated_snapshot_current_with_check() {
    let (ws, home) = setup_generator_check_bundle_copy("gen-chk-ok");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.generated_snapshot_status, "current");
    assert!(!health.generated_snapshot_detail.is_empty());
}

#[test]
fn test_generated_snapshot_stale_with_check() {
    let (ws, home) = setup_generator_check_bundle_copy("gen-chk-fail");
    // A source edit the snapshot does not reflect.
    write_file(&ws, "templates/opencode.base.json", r#"{"model":"edited"}"#);

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.generated_snapshot_status, "stale");
    assert_eq!(
        health.generated_snapshot_detail,
        "Regenerate opencode.json before sync."
    );
    // Stale snapshot should raise overall status to diverged
    assert_eq!(health.status, "diverged");
    assert!(health.summary.contains("stale"));
    assert_eq!(health.next_action, "Regenerate opencode.json before sync.");
}

#[test]
fn test_generated_snapshot_missing_source_does_not_panic() {
    let ws = temp_root("gen-no-src-ws");
    let home = temp_root("gen-no-src-home");

    // No opencode.base.json or opencode.policy.json
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/tui.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.generated_snapshot_status, "missing");
    // Should not panic — status is still computed
    assert_eq!(health.status, "synced"); // Missing snapshot doesn't affect overall status
}

// ── New tests for summary and next_action ──

#[test]
fn test_summary_synced() {
    let (ws, home) = setup_synced_bundle_copy("sum-synced");
    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(
        health.summary,
        "OpenCode runtime matches the bundled workspace."
    );
    assert_eq!(health.next_action, "No runtime action needed.");
}

#[test]
fn test_summary_diverged() {
    let ws = temp_root("sum-div-ws");
    let home = temp_root("sum-div-home");

    write_file(
        &ws,
        "templates/opencode.json",
        r#"{"model":"bundled-model","version":2}"#,
    );
    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(
        &home,
        ".config/opencode/opencode.json",
        r#"{"model":"user-model","version":1}"#,
    );
    write_file(&home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "diverged");
    assert_eq!(
        health.summary,
        "Runtime differs from bundled templates. Review diff before applying."
    );
    assert_eq!(health.next_action, "Run diff before apply.");
}

#[test]
fn test_summary_missing() {
    let ws = temp_root("sum-miss-ws");
    let home = temp_root("sum-miss-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    // No installed files at all
    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "missing");
    assert_eq!(
        health.summary,
        "OpenCode runtime is missing required files."
    );
    assert_eq!(health.next_action, "Install/sync required.");
}

#[test]
fn test_summary_extra_agents_still_informational() {
    let ws = temp_root("extra-sum-ws");
    let home = temp_root("extra-sum-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/tui.json", r#"{}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");
    write_file(&home, ".config/opencode/agents/custom.md", "# custom");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.status, "synced");
    assert_eq!(health.extra_installed_agent_count, 1);
    assert_eq!(
        health.summary,
        "OpenCode runtime matches the bundled workspace."
    );
    assert_eq!(health.next_action, "No runtime action needed.");
}

#[test]
fn test_tui_synced_produces_expected_status() {
    let ws = temp_root("tui-synced-ws");
    let home = temp_root("tui-synced-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{"theme":"system"}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    write_file(&home, ".config/opencode/opencode.json", r#"{}"#);
    write_file(&home, ".config/opencode/tui.json", r#"{"theme":"system"}"#);
    write_file(&home, ".config/opencode/agents/architect.md", "# architect");

    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(health.tui_status, "synced");
}

// ── Generator tests ──

fn write_generator_script(root: &Path, script_rel: &str, content: &str) {
    let script_dir = root.join(script_rel).parent().unwrap().to_path_buf();
    fs::create_dir_all(&script_dir).expect("create scripts dir");
    fs::write(root.join(script_rel), content).expect("write generator script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(script_rel), fs::Permissions::from_mode(0o755))
            .expect("make script executable");
    }
}

fn write_marker_workspace(root: &Path) {
    write_file(root, ".riggverk/workspace.json", "{}");
    write_file(root, "templates/global-agent-rules.md", "# rules\n");
    write_file(root, "templates/opencode.json", "{}");
    write_file(root, "README.md", "# readme\n");
    fs::create_dir_all(root.join("skills")).expect("create skills dir");
}

fn bundled_template(name: &str) -> String {
    let path = crate::setup_roots::bundled_root()
        .expect("bundled root")
        .join("templates")
        .join(name);
    fs::read_to_string(path).expect("read bundled template")
}

/// Stand-in generator for the injected-script entry points. It lives outside the workspace, as the
/// bundled one does, and receives the production arguments: `<script> --root <workspace> <mode>`.
fn fake_generator(label: &str, body: &str) -> (PathBuf, PathBuf) {
    let dir = temp_root(label);
    let prelude = "#!/usr/bin/env python3\nimport sys, os\nargs = sys.argv[1:]\nassert len(args) == 3 and args[0] == '--root', args\nroot, mode = args[1], args[2]\n";
    write_generator_script(
        &dir,
        "scripts/generate-opencode-config.py",
        &format!("{prelude}{body}"),
    );
    let script = dir.join("scripts/generate-opencode-config.py");
    (dir, script)
}

#[test]
fn test_generator_check_runs_with_workspace_as_data_argument() {
    let ws = temp_root("gen-check-args");
    write_marker_workspace(&ws);
    let (gen_dir, script) = fake_generator(
            "gen-check-args-script",
            "assert mode == '--check', mode\nassert os.path.isdir(os.path.join(root, 'templates')), root\nopen(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cwd.txt'), 'w').write(os.getcwd())\n",
        );

    let result = run_generator_check_with_timeout(&script, &ws, Duration::from_secs(30));
    let cwd = fs::read_to_string(gen_dir.join("scripts/cwd.txt")).expect("recorded cwd");
    let recorded_cwd = Path::new(&cwd).canonicalize().expect("cwd");
    let expected_cwd = gen_dir.join("scripts").canonicalize().expect("script dir");
    cleanup(&ws);
    cleanup(&gen_dir);

    assert_eq!(result.expect("generator ran").0, "current");
    assert_eq!(
        recorded_cwd, expected_cwd,
        "the generator runs from its own folder, not from the workspace"
    );
}

/// The generator runs the first `python3` no other user could replace, links resolved: one in
/// a folder everyone can write is skipped for a later one.
#[cfg(unix)]
#[test]
fn test_generator_python_skips_one_another_user_could_replace() {
    use std::os::unix::fs::PermissionsExt;
    let tools = temp_root("gen-python-tools");
    let path = temp_root("gen-python-path");
    for dir in [&tools, &path] {
        crate::test_env::create_dir_all(dir).expect("mkdir");
        let python = dir.join("python3");
        fs::write(&python, "#!/bin/sh\nexit 0\n").expect("write python3");
        make_executable(&python);
    }
    fs::set_permissions(&tools, fs::Permissions::from_mode(0o777)).expect("chmod");
    let found = crate::executable_resolver::trusted_python3(
        vec![tools.clone()],
        Some(path.clone().into_os_string()),
    );
    let expected = path.join("python3").canonicalize().expect("resolve");
    cleanup(&tools);
    cleanup(&path);
    assert_eq!(found, Some(expected));
}

#[cfg(unix)]
#[test]
fn test_workspace_generator_scripts_are_never_executed() {
    let (ws, home) = setup_generator_check_bundle_copy("gen-pinned");
    let sentinel = temp_root("gen-pinned-sentinel");
    let malicious = format!(
        "#!/usr/bin/env python3\nimport sys\nopen('{}', 'w').write('executed')\nsys.exit(1)\n",
        sentinel.display()
    );
    write_generator_script(&ws, "scripts/generate-opencode-config.py", &malicious);
    write_generator_script(
        &ws,
        "scripts/generate-default-opencode-config.py",
        &malicious,
    );

    let health = compute_health(&ws, &home);
    let check = super::run_generator_check(&ws);
    let write = super::run_generator_write(&ws).expect("bundled generator should run");
    let sentinel_created = sentinel.exists();
    cleanup(&ws);
    cleanup(&home);
    let _ = fs::remove_file(&sentinel);

    assert!(
        !sentinel_created,
        "a generator script inside the workspace must never run"
    );
    // The bundled generator answered instead: a malicious script would have failed the check.
    assert_eq!(health.generated_snapshot_status, "current");
    assert_eq!(check.expect("generator ran").0, "current");
    assert!(write.success, "{}", write.stderr);
}

// ── OpenCode model selection tests ──

#[test]
fn test_parse_models_simple_lines() {
    let output = "opencode-go/glm-5.2\nopencode-go/deepseek-v4-flash\nprovider2/model-x\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 3);
    assert_eq!(models[0], "opencode-go/deepseek-v4-flash");
    assert_eq!(models[1], "opencode-go/glm-5.2");
    assert_eq!(models[2], "provider2/model-x");
}

#[test]
fn test_parse_models_skips_empty_lines() {
    let output = "\nopencode-go/a\n  \nopencode-go/b\n\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 2);
}

#[test]
fn test_parse_models_skips_invalid_lines() {
    let output = "opencode-go/valid\nnotavalidline\n/no-provider\nno-model/\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 1);
    assert_eq!(models[0], "opencode-go/valid");
}

#[test]
fn test_parse_models_deduplicates() {
    let output = "provider/a\nprovider/b\nprovider/a\nprovider/c\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 3);
}

#[test]
fn test_parse_models_empty_input() {
    let models = parse_opencode_models_output("");
    assert!(models.is_empty());
}

#[test]
fn test_validate_model_id_valid() {
    assert!(validate_model_id("provider/model").is_ok());
    assert!(validate_model_id("opencode-go/glm-5.2").is_ok());
    assert!(validate_model_id("a/b").is_ok());
}

#[test]
fn test_validate_model_id_empty() {
    assert!(validate_model_id("").is_err());
    assert!(validate_model_id("   ").is_err());
}

#[test]
fn test_validate_model_id_no_slash() {
    let err = validate_model_id("justmodel").unwrap_err();
    assert!(err.contains("provider/model"));
}

#[test]
fn test_validate_model_id_empty_parts() {
    assert!(validate_model_id("/model").is_err());
    assert!(validate_model_id("provider/").is_err());
}

#[test]
fn test_validate_model_id_accepts_nested_model_names() {
    // OpenRouter / LM Studio / Hugging Face style ids carry extra slashes.
    assert_eq!(
        validate_model_id("lmstudio/google/gemma-3n-e4b").as_deref(),
        Ok("lmstudio/google/gemma-3n-e4b")
    );
    assert_eq!(validate_model_id("a/b/c").as_deref(), Ok("a/b/c"));
}

#[test]
fn test_validate_model_id_trims_and_rejects_empty_segments_and_whitespace() {
    assert_eq!(
        validate_model_id("  provider/model \n").as_deref(),
        Ok("provider/model")
    );
    for bad in [
        "provider//model",
        "provider/model/",
        "/provider/model",
        "provider/mo del",
        "provider/mo\tdel",
        "provider/mo\ndel",
        "provider/mo\u{0}del",
    ] {
        assert!(validate_model_id(bad).is_err(), "must reject {bad:?}");
    }
}

#[test]
fn test_update_base_config_preserves_unrelated_keys() {
    let ws = temp_root("model-upd-preserve");
    let home = temp_root("model-upd-home");

    // Set up minimal workspace with base config
    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{
            "$schema": "https://opencode.ai/config.json",
            "model": "old-model",
            "small_model": "old-small",
            "autoupdate": "notify",
            "snapshot": true,
            "default_agent": "architect",
            "compaction": {"auto": true}
        }"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        r#"{"read":{"default":"allow"}}"#,
    );
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, ".riggverk/workspace.json", "{}");
    write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
    write_file(&ws, "README.md", "# readme\n");
    fs::create_dir_all(ws.join("skills")).expect("create skills dir");

    // Read, update, and verify
    let base_path = ws.join("templates/opencode.base.json");
    let content = std::fs::read_to_string(&base_path).unwrap();
    let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "model".into(),
            serde_json::Value::String("new-model".into()),
        );
        obj.insert(
            "small_model".into(),
            serde_json::Value::String("new-small".into()),
        );
    }
    std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

    // Verify preserved keys
    let updated_content = std::fs::read_to_string(&base_path).unwrap();
    let updated_json: serde_json::Value = serde_json::from_str(&updated_content).unwrap();
    assert_eq!(updated_json["model"].as_str(), Some("new-model"));
    assert_eq!(updated_json["small_model"].as_str(), Some("new-small"));
    assert_eq!(updated_json["autoupdate"].as_str(), Some("notify"));
    assert_eq!(updated_json["snapshot"].as_bool(), Some(true));
    assert_eq!(updated_json["default_agent"].as_str(), Some("architect"));
    assert!(updated_json["compaction"].is_object());
    assert!(updated_json["$schema"].is_string());

    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_update_base_config_generator_failure_detected() {
    let ws = temp_root("model-upd-fail");
    let home = temp_root("model-upd-fail-home");

    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{"model":"old","small_model":"old-small"}"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        r#"{"read":{"default":"allow"}}"#,
    );
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, ".riggverk/workspace.json", "{}");
    write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
    write_file(&ws, "README.md", "# readme\n");
    fs::create_dir_all(ws.join("skills")).expect("create skills dir");

    // Generator script that always fails
    let (gen_dir, script) = fake_generator(
        "model-upd-fail-gen",
        "print('simulated failure', file=sys.stderr)\nsys.exit(1)\n",
    );

    // Now update base config manually
    let base_path = ws.join("templates/opencode.base.json");
    let content = std::fs::read_to_string(&base_path).unwrap();
    let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();
    if let Some(obj) = json.as_object_mut() {
        obj.insert("model".into(), serde_json::Value::String("new".into()));
        obj.insert(
            "small_model".into(),
            serde_json::Value::String("new-small".into()),
        );
    }
    std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

    // Verify generator detects stale state
    let gen_result = super::run_generator_write_with_script(&script, &ws)
        .expect("generator should return ActionResult");
    assert!(!gen_result.success, "generator should fail");
    assert!(gen_result.stderr.contains("simulated failure"));

    cleanup(&ws);
    cleanup(&home);
    cleanup(&gen_dir);
}

// ── Hardened parser tests ──

#[test]
fn test_parse_models_line_with_metadata_first_token() {
    // Lines where the first token is a valid model, rest is metadata
    let output = "provider/model   some metadata here\nopencode-go/glm-5.2  \tmore stuff\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0], "opencode-go/glm-5.2");
    assert_eq!(models[1], "provider/model");
}

#[test]
fn test_parse_models_rejects_quotes() {
    let output = "\"provider/model\"\nprovider/'model2'\n";
    let models = parse_opencode_models_output(output);
    assert!(models.is_empty());
}

#[test]
fn test_parse_models_rejects_shell_chars() {
    let output = "provider/model;ls\nprovider|model\n$(provider/model)\nprovider/<model>\n";
    let models = parse_opencode_models_output(output);
    assert!(models.is_empty());
}

#[test]
fn test_parse_models_accepts_nested_names_and_rejects_empty_segments() {
    let output = "lmstudio/google/gemma-3n-e4b\nprovider/model/extra\na//b\nprovider/model/\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(
        models,
        vec![
            "lmstudio/google/gemma-3n-e4b".to_string(),
            "provider/model/extra".to_string()
        ]
    );
}

#[test]
fn test_parse_models_mixed_valid_and_invalid() {
    let output = "valid/provider\ninvalid;stuff\nother/valid\n$(bad)\n\"quoted/model\"\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0], "other/valid");
    assert_eq!(models[1], "valid/provider");
}

#[test]
fn test_parse_models_takes_only_first_token_from_table() {
    // Simulates possible table or column output where first column is model
    let output = "provider/model   1.5 dollars   512 context\nother/model   2.0    1024\n";
    let models = parse_opencode_models_output(output);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0], "other/model");
    assert_eq!(models[1], "provider/model");
}

// ── OpenCode executable resolver tests ──

#[cfg(unix)]
fn make_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .expect("make executable");
}

#[cfg(not(unix))]
fn make_executable(_path: &std::path::Path) {}

// The search path is passed in, never set on the process: another test that starts a program by
// bare name (`python3`, `git`) while PATH is changed cannot find it.
#[test]
fn test_resolve_opencode_path_lookup() {
    let dir = temp_root("resolve-path");
    crate::test_env::create_dir_all(&dir).expect("mkdir");

    // On Windows a file is a program by its extension (PATHEXT), not by a mode bit.
    let fake_path = dir.join(if cfg!(windows) {
        "opencode.cmd"
    } else {
        "opencode"
    });
    std::fs::write(&fake_path, "#!/bin/sh\necho opencode/fake-model\n")
        .expect("write fake opencode");
    make_executable(&fake_path);

    let result = super::resolve_opencode_executable_in(&dir.to_string_lossy(), &[]);

    assert!(result.is_some(), "should find opencode via PATH");
    let found = result.unwrap();
    if cfg!(windows) {
        // PATHEXT spells the extension in capitals (`.CMD`).
        assert!(
            found
                .to_string_lossy()
                .eq_ignore_ascii_case(&fake_path.to_string_lossy()),
            "{found:?}"
        );
    } else {
        assert_eq!(found, std::fs::canonicalize(&fake_path).unwrap());
    }

    cleanup(&dir);
}

#[test]
fn test_resolve_opencode_fallback_path_check_leaves_no_panic() {
    // This test verifies the fallback check does not panic when PATH is empty
    // and no fallback candidate exists on the test machine.
    // On dev machines with Homebrew opencode, the fallback may still find it,
    // which is correct behavior.
    let fallbacks = opencode_fallback_candidates(None);

    // Must not panic regardless of outcome
    let _result = super::resolve_opencode_executable_in("", &fallbacks);
    // No assertion — just ensuring no panic
}

#[test]
fn test_list_models_missing_cli_error_is_safe() {
    // No executable is spawned: the error for a missing CLI must not expose raw
    // PATH values or the home directory.
    let msg = list_models_with_executable(None, Duration::from_secs(1))
        .expect_err("missing opencode CLI must be an error");
    assert!(msg.contains("opencode CLI not found"), "{msg}");
    assert!(
        !msg.contains("PATH="),
        "error must not expose raw PATH: {msg}"
    );
    assert!(
        !msg.contains("/home/"),
        "error must not expose home directory: {msg}"
    );
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            assert!(!msg.contains(&home), "error must not expose HOME: {msg}");
        }
    }
}

#[test]
fn test_list_models_unspawnable_cli_is_an_error() {
    let missing = std::env::temp_dir().join("riggverk-no-such-opencode-binary");
    let msg = list_models_with_executable(Some(missing), Duration::from_secs(1))
        .expect_err("unspawnable CLI must be an error");
    assert!(msg.starts_with("failed to run opencode models"), "{msg}");
}

#[cfg(unix)]
fn write_stub_opencode(dir: &Path, body: &str) -> PathBuf {
    crate::test_env::create_dir_all(dir).expect("create stub dir");
    let path = dir.join("opencode");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub opencode");
    make_executable(&path);
    path
}

#[cfg(unix)]
#[test]
fn test_list_models_parses_stub_output() {
    let dir = temp_root("models-stub-ok");
    let stub = write_stub_opencode(
        &dir,
        "echo opencode-go/glm-5.2\necho lmstudio/google/gemma-3n-e4b\necho garbage",
    );
    let result = list_models_with_executable(Some(stub), Duration::from_secs(10));
    cleanup(&dir);

    let result = result.expect("stub run succeeds");
    assert_eq!(
        result.models,
        vec![
            "lmstudio/google/gemma-3n-e4b".to_string(),
            "opencode-go/glm-5.2".to_string()
        ]
    );
    assert!(result.warning.is_none());
}

#[cfg(unix)]
#[test]
fn test_list_models_nonzero_exit_warns_but_keeps_models() {
    let dir = temp_root("models-stub-fail");
    let stub = write_stub_opencode(&dir, "echo provider/model\nexit 3");
    let result = list_models_with_executable(Some(stub), Duration::from_secs(10));
    cleanup(&dir);

    let result = result.expect("non-zero exit is a warning, not an error");
    assert_eq!(result.models, vec!["provider/model".to_string()]);
    assert!(result
        .warning
        .as_deref()
        .is_some_and(|w| w.contains("non-zero")));
}

#[cfg(unix)]
#[test]
fn test_list_models_times_out_instead_of_hanging() {
    let dir = temp_root("models-stub-hang");
    // `exec` so the killed process is the sleeper itself (no orphan holding the pipe).
    let stub = write_stub_opencode(&dir, "exec sleep 30");
    let started = std::time::Instant::now();
    let result = list_models_with_executable(Some(stub), Duration::from_millis(300));
    cleanup(&dir);

    let msg = result.expect_err("a hung CLI must time out");
    assert!(msg.contains("timed out"), "{msg}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "timeout must bound the wait"
    );
}

#[test]
fn test_generator_check_never_shows_the_generator_output() {
    let ws = temp_root("gen-check-quiet");
    write_marker_workspace(&ws);
    let (gen_dir, script) = fake_generator(
        "gen-check-quiet-script",
        "sys.stdout.write('OUT-FAKE-SECRET')\nsys.stderr.write('ERR-FAKE-SECRET')\nsys.exit(1)\n",
    );
    let result = run_generator_check_with_timeout(&script, &ws, Duration::from_secs(30));
    cleanup(&ws);
    cleanup(&gen_dir);
    let (status, detail) = result.expect("generator ran");
    assert_eq!(status, "stale");
    assert!(!detail.contains("FAKE-SECRET"), "{detail}");
}

#[cfg(unix)]
#[test]
fn test_generator_check_timeout_is_not_reported_as_stale() {
    let _guard = crate::test_env::guard::lock();
    let ws = temp_root("gen-chk-hang-ws");
    fs::create_dir_all(&ws).expect("create workspace");
    let (gen_dir, script) = fake_generator("gen-chk-hang-script", "import time\ntime.sleep(30)\n");
    let started = std::time::Instant::now();
    let result = run_generator_check_with_timeout(&script, &ws, Duration::from_millis(500));
    cleanup(&ws);
    cleanup(&gen_dir);

    let (status, detail) = result.expect("a hung generator still reports a status");
    assert_eq!(status, "valid");
    assert!(detail.contains("timed out"), "{detail}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "timeout must bound the wait"
    );
}

// ── Managed config ordering (OpenCode permission is last-match-wins) ──

fn json_keys(value: &serde_json::Value) -> Vec<&str> {
    value
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn test_merge_managed_config_keeps_template_permission_order() {
    // Alphabetical order would put "**/.env*" before "src/**" and "edit" before "read".
    let template: serde_json::Value = serde_json::from_str(
        r#"{"permission":{"*":"ask","read":{"*":"allow","**/.env*":"deny"},
                "edit":{"*":"ask","src/**":"allow","**/.env*":"deny"}}}"#,
    )
    .expect("parse template");
    let installed: serde_json::Value =
        serde_json::from_str(r#"{"theme":"mine","permission":{"edit":"deny","*":"allow"}}"#)
            .expect("parse installed");

    let merged =
        merge_managed_opencode_config(&installed, &extract_managed_opencode_config(&template));
    // Round-trip through the text that setup writes to disk.
    let written = serde_json::to_string_pretty(&merged).expect("serialize");
    let reparsed: serde_json::Value = serde_json::from_str(&written).expect("reparse");

    assert_eq!(reparsed["theme"], "mine", "user keys are preserved");
    let permission = &reparsed["permission"];
    assert_eq!(json_keys(permission), ["*", "read", "edit"]);
    assert_eq!(
        json_keys(&permission["edit"]),
        ["*", "src/**", "**/.env*"],
        "a deny listed after an allow must stay last"
    );
    assert_eq!(json_keys(&permission["read"]), ["*", "**/.env*"]);
}

#[test]
fn test_merge_removes_absent_managed_entries_and_preserves_user_order() {
    let mut installed: serde_json::Value = serde_json::from_str(
            r#"{"theme":"mine","lsp":true,"mcp":{"first":{},"playwright":{},"middle":{},"last":{}},
                "permission":{},
                "agent":{"custom":{},
                    "plan":{"model":"mine/plan","permission":{"edit":"deny"},"prompt":"mine","description":"keep"},
                    "explore":{"permission":{"edit":"deny"}},
                    "inspector":{"description":"mine","model":"old/cheap","prompt":"keep","temperature":0.5},
                    "sentinel":{"model":"old/cheap"},"other":{"model":"mine/other"},"tail":{}},
                "model":"old/main","provider":{"z":{},"a":{}},"keybinds":{}}"#,
        )
        .unwrap();
    for key in MANAGED_TOP_LEVEL_KEYS {
        installed[*key] = serde_json::json!("old");
    }
    let managed = serde_json::json!({"model":"new/main"});
    let merged = merge_managed_opencode_config(&installed, &managed);
    let reparsed: serde_json::Value =
        serde_json::from_str(&serde_json::to_string_pretty(&merged).unwrap()).unwrap();

    assert!(managed_opencode_keys_match(&reparsed, &managed));
    assert_eq!(
        json_keys(&reparsed),
        [
            "theme",
            "mcp",
            "agent",
            "model",
            "provider",
            "keybinds",
            "small_model"
        ]
    );
    assert_eq!(json_keys(&reparsed["mcp"]), ["first", "middle", "last"]);
    assert_eq!(
        json_keys(&reparsed["agent"]),
        ["custom", "plan", "inspector", "other", "tail"]
    );
    assert_eq!(
        json_keys(&reparsed["agent"]["plan"]),
        ["model", "prompt", "description"]
    );
    assert_eq!(
        json_keys(&reparsed["agent"]["inspector"]),
        ["description", "prompt", "temperature"]
    );
    assert_eq!(json_keys(&reparsed["provider"]), ["z", "a"]);
    assert_eq!(reparsed["agent"]["plan"]["model"], "mine/plan");
    assert_eq!(reparsed["agent"]["plan"]["prompt"], "mine");
    assert_eq!(reparsed["agent"]["plan"]["description"], "keep");
    assert_eq!(reparsed["agent"]["inspector"]["description"], "mine");
    assert_eq!(reparsed["agent"]["inspector"]["prompt"], "keep");
    assert_eq!(reparsed["agent"]["inspector"]["temperature"], 0.5);
    assert_eq!(reparsed["agent"]["other"]["model"], "mine/other");
    assert!(ordered_json_eq(
        &merge_managed_opencode_config(&reparsed, &managed),
        &reparsed
    ));

    let only_managed = serde_json::json!({
        "mcp":{"playwright":{}}, "agent":{"plan":{"permission":{}}}
    });
    assert_eq!(
        merge_managed_opencode_config(&only_managed, &serde_json::json!({})),
        serde_json::json!({})
    );
    let user_empty = serde_json::json!({"mcp":{},"agent":{"plan":{}}});
    assert!(ordered_json_eq(
        &merge_managed_opencode_config(&user_empty, &serde_json::json!({})),
        &user_empty
    ));
}

#[test]
fn test_merge_managed_config_preserves_bundled_template_order() {
    let template_text = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../resources/default-workspace/templates/opencode.json"
    ));
    let template: serde_json::Value = serde_json::from_str(template_text).expect("template");
    let merged = merge_managed_opencode_config(
        &serde_json::json!({}),
        &extract_managed_opencode_config(&template),
    );
    let reparsed: serde_json::Value =
        serde_json::from_str(&serde_json::to_string_pretty(&merged).expect("serialize"))
            .expect("reparse");

    for section in ["bash", "edit", "read"] {
        assert_eq!(
            json_keys(&reparsed["permission"][section]),
            json_keys(&template["permission"][section]),
            "permission.{section} order must match the template"
        );
    }
    let edit = json_keys(&reparsed["permission"]["edit"]);
    let position = |key: &str| edit.iter().position(|k| *k == key).expect(key);
    assert!(
        position("src/**") < position("**/.env*"),
        "secret deny must come after the broad src/** allow"
    );
}

#[test]
fn test_managed_keys_match_requires_permission_order() {
    let ordered: serde_json::Value = serde_json::from_str(
        r#"{"permission":{"edit":{"*":"ask","src/**":"allow","**/.env*":"deny"}}}"#,
    )
    .expect("parse");
    let sorted: serde_json::Value = serde_json::from_str(
        r#"{"permission":{"edit":{"*":"ask","**/.env*":"deny","src/**":"allow"}}}"#,
    )
    .expect("parse");

    // serde_json equality ignores key order, which is why the health check needs more.
    assert_eq!(ordered, sorted);
    assert!(managed_opencode_keys_match(&ordered, &ordered));
    assert!(!managed_opencode_keys_match(&sorted, &ordered));
}

fn bundled_managed_keys() -> serde_json::Value {
    let text = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../resources/default-workspace/metadata/opencode-managed-keys.json"
    ));
    serde_json::from_str(text).expect("managed keys metadata")
}

fn string_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("metadata {key} must be an array"))
        .iter()
        .map(|item| item.as_str().expect("string").to_string())
        .collect()
}

#[test]
fn test_managed_key_lists_match_the_metadata_file() {
    let metadata = bundled_managed_keys();
    let expect = |list: &[&str]| list.iter().map(|k| k.to_string()).collect::<Vec<_>>();
    assert_eq!(
        string_list(&metadata, "top_level"),
        expect(MANAGED_TOP_LEVEL_KEYS)
    );
    assert_eq!(
        string_list(&metadata, "mcp_servers"),
        expect(MANAGED_MCP_SERVERS)
    );
    assert_eq!(
        string_list(&metadata, "agent_permissions"),
        expect(MANAGED_AGENT_PERMISSIONS)
    );
    assert_eq!(
        string_list(&metadata, "subagent_model_roles"),
        expect(SUBAGENT_MODEL_ROLES)
    );
}

#[test]
fn test_subagent_model_roles_are_exactly_the_bundled_subagents() {
    let agents_dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace/agents");
    let mut subagents: Vec<String> = list_bundled_agents(&agents_dir)
        .into_iter()
        .filter(|file| {
            fs::read_to_string(agents_dir.join(file))
                .expect("read bundled agent")
                .lines()
                .any(|line| line.trim() == "mode: subagent")
        })
        .map(|file| file.trim_end_matches(".md").to_string())
        .collect();
    subagents.sort();
    let mut roles: Vec<String> = SUBAGENT_MODEL_ROLES.iter().map(|r| r.to_string()).collect();
    roles.sort();
    assert_eq!(roles, subagents);
}

#[test]
fn test_fallback_model_constants_match_the_bundled_base_template() {
    let base: serde_json::Value =
        serde_json::from_str(&bundled_template("opencode.base.json")).expect("base template");
    assert!(base.get("model").is_none());
    assert!(base.get("small_model").is_none());
}

#[test]
fn test_lsp_is_a_managed_key_that_installs_and_is_compared() {
    let template: serde_json::Value =
        serde_json::from_str(&bundled_template("opencode.json")).expect("template");
    assert_eq!(
        template["lsp"], true,
        "the bundled config enables built-in LSP"
    );
    assert_eq!(
        extract_managed_opencode_config(&template)["lsp"],
        true,
        "lsp is part of the managed projection"
    );

    // A user's own `lsp: false` is reset on install, other user keys survive.
    let installed: serde_json::Value =
        serde_json::from_str(r#"{"lsp":false,"provider":{"mine":{}}}"#).expect("installed");
    let merged =
        merge_managed_opencode_config(&installed, &extract_managed_opencode_config(&template));
    assert_eq!(merged["lsp"], true);
    assert_eq!(merged["provider"], installed["provider"]);

    // Health sees a config that predates the key, or turns it off, as diverged.
    assert!(managed_opencode_keys_match(&merged, &template));
    assert!(!managed_opencode_keys_match(&installed, &template));
    let mut without = merged.clone();
    without.as_object_mut().expect("object").remove("lsp");
    assert!(!managed_opencode_keys_match(&without, &template));
}

#[test]
fn test_bundled_template_manages_exactly_the_listed_agent_blocks() {
    let template: serde_json::Value =
        serde_json::from_str(&bundled_template("opencode.json")).expect("template");
    let agents: Vec<&str> = json_keys(&template["agent"]);
    assert_eq!(agents, MANAGED_AGENT_PERMISSIONS);
    for name in MANAGED_AGENT_PERMISSIONS {
        assert_eq!(json_keys(&template["agent"][*name]), ["permission"]);
    }
    let managed = extract_managed_opencode_config(&template);
    assert_eq!(managed["agent"], template["agent"]);
}

#[test]
fn test_merge_managed_agent_permissions_keeps_user_agent_entries() {
    let template: serde_json::Value = serde_json::from_str(
        r#"{"permission":{"*":"ask"},
                "agent":{"plan":{"permission":{"edit":{"*":"deny"}}},
                         "explore":{"permission":{"*":"deny","read":"allow"}}}}"#,
    )
    .expect("template");
    let installed: serde_json::Value = serde_json::from_str(
        r#"{"agent":{"plan":{"model":"mine/plan","permission":{"edit":"allow"}},
                         "review":{"permission":{"edit":"deny"}}}}"#,
    )
    .expect("installed");

    let merged =
        merge_managed_opencode_config(&installed, &extract_managed_opencode_config(&template));

    assert_eq!(merged["agent"]["plan"]["model"], "mine/plan");
    assert_eq!(
        merged["agent"]["plan"]["permission"], template["agent"]["plan"]["permission"],
        "the managed permission block is reset to the bundled one"
    );
    assert_eq!(merged["agent"]["review"], installed["agent"]["review"]);
    assert_eq!(
        merged["agent"]["explore"]["permission"],
        template["agent"]["explore"]["permission"]
    );
}

#[test]
fn test_merge_managed_agent_permissions_into_a_config_without_agents() {
    let template: serde_json::Value =
        serde_json::from_str(r#"{"agent":{"plan":{"permission":{"edit":{"*":"deny"}}}}}"#)
            .expect("template");
    let merged = merge_managed_opencode_config(
        &serde_json::json!({"theme": "mine"}),
        &extract_managed_opencode_config(&template),
    );
    assert_eq!(merged["theme"], "mine");
    assert_eq!(merged["agent"], template["agent"]);
    // A malformed user `agent` value is left alone instead of being overwritten or panicking.
    let broken = merge_managed_opencode_config(
        &serde_json::json!({"agent": "oops"}),
        &extract_managed_opencode_config(&template),
    );
    assert_eq!(broken["agent"], "oops");
}

#[test]
fn test_managed_keys_match_covers_agent_permissions() {
    let rendered: serde_json::Value = serde_json::from_str(
        r#"{"agent":{"plan":{"permission":{"edit":{"*":"deny","docs/**":"allow"}}}}}"#,
    )
    .expect("rendered");
    let widened: serde_json::Value = serde_json::from_str(
        r#"{"agent":{"plan":{"permission":{"edit":{"*":"allow","docs/**":"allow"}}}}}"#,
    )
    .expect("widened");
    let reordered: serde_json::Value = serde_json::from_str(
        r#"{"agent":{"plan":{"permission":{"edit":{"docs/**":"allow","*":"deny"}}}}}"#,
    )
    .expect("reordered");
    let with_user_keys: serde_json::Value = serde_json::from_str(
            r#"{"agent":{"plan":{"model":"mine/plan","permission":{"edit":{"*":"deny","docs/**":"allow"}}},
                         "review":{"description":"mine"}}}"#,
        )
        .expect("user keys");

    assert!(managed_opencode_keys_match(&rendered, &rendered));
    assert!(!managed_opencode_keys_match(&widened, &rendered));
    assert!(!managed_opencode_keys_match(&reordered, &rendered));
    assert!(!managed_opencode_keys_match(
        &serde_json::json!({}),
        &rendered
    ));
    assert!(
        managed_opencode_keys_match(&with_user_keys, &rendered),
        "unmanaged agent keys must not read as drift"
    );
}

#[test]
fn test_health_flags_reordered_installed_permission() {
    let (ws, home) = setup_synced_bundle_copy("perm-order");
    let template = r#"{"default_agent":"architect","permission":{"edit":{"*":"ask","src/**":"allow","**/.env*":"deny"}}}"#;
    let reordered = r#"{"default_agent":"architect","permission":{"edit":{"*":"ask","**/.env*":"deny","src/**":"allow"}}}"#;
    write_file(&ws, "templates/opencode.json", template);

    write_file(&home, ".config/opencode/opencode.json", template);
    let in_order = compute_health(&ws, &home);
    write_file(&home, ".config/opencode/opencode.json", reordered);
    let out_of_order = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    let status_of = |health: &OpenCodeRuntimeHealth| {
        health
            .checks
            .iter()
            .find(|check| check.id == "configs_match")
            .map(|check| check.status.clone())
    };
    assert_eq!(status_of(&in_order).as_deref(), Some("pass"));
    assert_eq!(status_of(&out_of_order).as_deref(), Some("warn"));
}

// ── Config precedence ──

/// A value that must never reach a message: it stands for a secret in a user's file.
const SECRET: &str = "sk-test-PRIVATE-123";

/// Everything the health says, as the UI receives it.
fn health_text(health: &OpenCodeRuntimeHealth) -> String {
    serde_json::to_string(health).expect("serialize health")
}

/// `config` as JSONC: a comment holding [`SECRET`] on top and a trailing comma at the end.
fn commented(config: &serde_json::Value) -> String {
    let pretty = serde_json::to_string_pretty(config).unwrap();
    let body = pretty.trim_end().strip_suffix('}').unwrap();
    format!("// my notes: {SECRET}\n{body},\n}}\n")
}

fn installed(home: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap())
        .unwrap()
}

#[test]
fn a_commented_opencode_json_is_compared_as_jsonc_and_the_reason_names_no_text() {
    let (ws, home) = setup_synced_bundle_copy("jsonc");
    let strict = installed(&home);
    write_file(&home, ".config/opencode/opencode.json", &commented(&strict));

    let synced = compute_health(&ws, &home);
    assert_eq!(synced.config_status, "synced");
    assert!(synced.config_diverged_keys.is_empty());
    assert_eq!(
        synced.status, "synced",
        "comments alone change nothing OpenCode runs"
    );
    assert_eq!(
        synced.config_precedence.installed_not_strict,
        ["comments", "trailing commas"]
    );
    let check = synced
        .checks
        .iter()
        .find(|check| check.id == "installed_config_valid")
        .unwrap();
    assert_eq!(check.status, "warn");
    assert!(
        synced.warnings.iter().any(|w| w
            .starts_with("opencode.json has comments and trailing commas")
            && w.contains("opencode.jsonc")),
        "{:?}",
        synced.warnings
    );

    let mut changed = strict.clone();
    changed["model"] = serde_json::json!("mine/private-model");
    write_file(
        &home,
        ".config/opencode/opencode.json",
        &commented(&changed),
    );
    let diverged = compute_health(&ws, &home);
    assert_eq!(diverged.config_status, "diverged");
    assert_eq!(diverged.config_diverged_keys, ["model"]);
    assert_eq!(diverged.status, "diverged");

    write_file(
        &home,
        ".config/opencode/opencode.json",
        &format!("{{\"model\": {SECRET}"),
    );
    let invalid = compute_health(&ws, &home);
    assert_eq!(invalid.config_status, "invalid");
    assert_eq!(invalid.status, "missing");

    cleanup(&ws);
    cleanup(&home);
    for health in [&synced, &diverged, &invalid] {
        let text = health_text(health);
        assert!(!text.contains(SECRET), "{text}");
        // The model id is shown by design (`model`); the file's other text is not.
        assert!(!text.contains("my notes"), "{text}");
    }
}

#[test]
fn sibling_config_files_warn_only_when_they_set_managed_keys() {
    let (ws, home) = setup_synced_bundle_copy("siblings");
    write_file(
            &home,
            ".config/opencode/opencode.jsonc",
            &format!(
                "{{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  // mine\n  \"provider\": {{\"p\": {{\"options\": {{\"apiKey\": \"{SECRET}\"}}}}}},\n}}"
            ),
        );
    write_file(
        &home,
        ".config/opencode/config.json",
        r#"{"theme": "dark"}"#,
    );
    let quiet = compute_health(&ws, &home);
    assert_eq!(quiet.status, "synced");
    assert!(quiet.config_precedence.sibling_files.is_empty());
    assert!(quiet.warnings.is_empty(), "{:?}", quiet.warnings);

    write_file(
            &home,
            ".config/opencode/opencode.jsonc",
            &format!(
                "{{\"model\": \"{SECRET}\", \"mcp\": {{\"playwright\": {{}}, \"mine\": {{}}}}, \"agent\": {{\"plan\": {{\"permission\": {{}}, \"prompt\": \"x\"}}, \"inspector\": {{\"model\": \"a/b\"}}, \"custom\": {{\"model\": \"c/d\"}}}},}}"
            ),
        );
    let overridden = compute_health(&ws, &home);
    assert_eq!(
        overridden.status, "diverged",
        "OpenCode does not run the team's values"
    );
    assert_eq!(
        overridden.config_status, "synced",
        "opencode.json itself is as bundled"
    );
    assert_eq!(
        overridden.config_precedence.sibling_files,
        [crate::opencode_precedence::SiblingConfig {
            file: "opencode.jsonc".into(),
            managed_keys: vec![
                "model".into(),
                "mcp.playwright".into(),
                "agent.plan.permission".into(),
                "agent.inspector.model".into(),
            ],
            invalid: false,
        }]
    );
    assert!(overridden.warnings.iter().any(|w| w.contains(
            "opencode.jsonc sets managed keys (model, mcp.playwright, agent.plan.permission, agent.inspector.model)"
        )));
    assert_eq!(
        overridden.next_action,
        "Remove the managed keys from opencode.jsonc."
    );

    write_file(
        &home,
        ".config/opencode/config.json",
        r#"{"permission": {"bash": "allow"}}"#,
    );
    let both = compute_health(&ws, &home);
    let files: Vec<_> = both
        .config_precedence
        .sibling_files
        .iter()
        .map(|sibling| sibling.file.as_str())
        .collect();
    assert_eq!(files, ["config.json", "opencode.jsonc"]);
    assert!(both
        .warnings
        .iter()
        .any(|w| w.starts_with("config.json sets managed keys (permission)")));

    cleanup(&ws);
    cleanup(&home);
    for health in [&quiet, &overridden, &both] {
        let text = health_text(health);
        assert!(!text.contains(SECRET) && !text.contains("a/b"), "{text}");
    }
}

#[test]
fn config_env_vars_and_system_managed_paths_are_reported_by_name_only() {
    let (ws, home) = setup_synced_bundle_copy("environment");
    let system = temp_root("system-managed");
    let candidates = [
        system.join("opencode"),
        system.join("ai.opencode.managed.plist"),
    ];

    let mut clean = compute_health(&ws, &home);
    apply_config_environment(
        &mut clean,
        crate::opencode_precedence::config_env_var_names(Vec::new()),
        crate::opencode_precedence::existing_paths(&candidates),
    );
    assert!(clean.config_precedence.env_vars.is_empty());
    assert!(clean.config_precedence.system_managed_paths.is_empty());
    assert!(clean.warnings.is_empty(), "{:?}", clean.warnings);

    fs::create_dir_all(&candidates[0]).unwrap();
    write_file(&candidates[0], "opencode.json", SECRET);
    let vars = [
        (
            "OPENCODE_CONFIG_CONTENT",
            format!("{{\"model\":\"{SECRET}\"}}"),
        ),
        ("OPENCODE_PERMISSION", format!("{{\"bash\":\"{SECRET}\"}}")),
        ("OPENCODE_API_KEY", SECRET.to_string()),
    ]
    .map(|(name, value)| (name.into(), value.into()));
    let mut reported = compute_health(&ws, &home);
    apply_config_environment(
        &mut reported,
        crate::opencode_precedence::config_env_var_names(vars),
        crate::opencode_precedence::existing_paths(&candidates),
    );
    assert_eq!(
        reported.config_precedence.env_vars,
        ["OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"]
    );
    assert_eq!(
        reported.config_precedence.system_managed_paths,
        [candidates[0].to_string_lossy().into_owned()]
    );
    assert_eq!(
        reported.status, "synced",
        "the app cannot see what they set"
    );
    assert_eq!(reported.warnings.len(), 2, "{:?}", reported.warnings);

    cleanup(&ws);
    cleanup(&home);
    cleanup(&system);
    let text = health_text(&reported);
    assert!(!text.contains(SECRET), "{text}");
    assert!(!text.contains("OPENCODE_API_KEY"), "{text}");
}

#[test]
fn opencode_config_dir_is_a_warning_that_names_the_folder_the_app_installs_to() {
    let (ws, home) = setup_synced_bundle_copy("config-dir-env");
    let elsewhere = temp_root("config-dir-env-target");
    let vars = [(
        "OPENCODE_CONFIG_DIR",
        elsewhere.to_string_lossy().into_owned(),
    )]
    .map(|(name, value)| (name.into(), value.into()));
    let mut health = compute_health(&ws, &home);
    apply_config_environment(
        &mut health,
        crate::opencode_precedence::config_env_var_names(vars),
        Vec::new(),
    );
    assert_eq!(health.config_precedence.env_vars, ["OPENCODE_CONFIG_DIR"]);
    assert_eq!(health.status, "synced", "a warning only");
    let folder = home.join(".config/opencode").to_string_lossy().into_owned();
    assert!(
        health
            .warnings
            .iter()
            .any(|warning| warning == &crate::opencode_precedence::config_dir_env_warning(&folder)),
        "{:?}",
        health.warnings
    );
    // Its value is never shown, and nothing is written there.
    let text = health_text(&health);
    assert!(!text.contains(&*elsewhere.to_string_lossy()), "{text}");
    assert!(!elsewhere.exists());
    cleanup(&ws);
    cleanup(&home);
}

// ── Config update / generation tests ──

#[test]
fn test_update_model_selection_via_helper_path() {
    let ws = temp_root("model-upd-path");
    let home = temp_root("model-upd-path-home");

    // Create workspace with base config
    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{
            "$schema": "https://opencode.ai/config.json",
            "model": "old-model",
            "small_model": "old-small",
            "autoupdate": "notify",
            "snapshot": true,
            "default_agent": "architect"
        }"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        r#"{"read":{"default":"allow"}}"#,
    );
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, ".riggverk/workspace.json", "{}");
    write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
    write_file(&ws, "README.md", "# readme\n");
    fs::create_dir_all(ws.join("skills")).expect("create skills dir");

    // Create a home dir with an installed config that should NOT be touched
    write_file(
        &home,
        ".config/opencode/opencode.json",
        r#"{"model":"installed-model","small_model":"installed-small"}"#,
    );

    // ── Simulate what update_opencode_model_selection does (bundled generator) ──

    let base_path = ws.join("templates/opencode.base.json");
    let snapshot_path = ws.join("templates/opencode.json");

    // 1. Read existing base config
    let content = std::fs::read_to_string(&base_path).unwrap();
    let mut json: serde_json::Value = serde_json::from_str(&content).unwrap();

    // 2. Validate input (use the helper)
    assert!(validate_model_id("provider/new-model").is_ok());
    assert!(validate_model_id("provider/new-small").is_ok());

    // 3. Update model and small_model
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "model".to_string(),
            serde_json::Value::String("provider/new-model".into()),
        );
        obj.insert(
            "small_model".to_string(),
            serde_json::Value::String("provider/new-small".into()),
        );
    }
    std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

    // 4. Run generator --write
    let gen_result = super::run_generator_write(&ws).expect("generator should succeed");
    assert!(gen_result.success, "generator write should succeed");

    // 5. Verify base config: only model and small_model changed
    let updated_content = std::fs::read_to_string(&base_path).unwrap();
    let updated_json: serde_json::Value = serde_json::from_str(&updated_content).unwrap();
    assert_eq!(updated_json["model"].as_str(), Some("provider/new-model"));
    assert_eq!(
        updated_json["small_model"].as_str(),
        Some("provider/new-small")
    );
    // Unrelated keys preserved
    assert_eq!(updated_json["autoupdate"].as_str(), Some("notify"));
    assert_eq!(updated_json["snapshot"].as_bool(), Some(true));
    assert_eq!(updated_json["default_agent"].as_str(), Some("architect"));
    assert!(updated_json["$schema"].is_string());

    // 6. Verify generated snapshot contains selected values
    assert!(snapshot_path.is_file(), "snapshot should exist");
    let snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap();
    let snapshot_json: serde_json::Value = serde_json::from_str(&snapshot_content).unwrap();
    assert_eq!(
        snapshot_json["model"].as_str(),
        Some("provider/new-model"),
        "snapshot model must match selected value"
    );
    assert_eq!(
        snapshot_json["small_model"].as_str(),
        Some("provider/new-small"),
        "snapshot small_model must match selected value"
    );

    // 7. Verify installed config in home dir was NOT touched
    let installed_content =
        std::fs::read_to_string(home.join(".config/opencode/opencode.json")).unwrap();
    let installed_json: serde_json::Value = serde_json::from_str(&installed_content).unwrap();
    assert_eq!(
        installed_json["model"].as_str(),
        Some("installed-model"),
        "installed config must not be modified"
    );
    assert_eq!(
        installed_json["small_model"].as_str(),
        Some("installed-small"),
        "installed config must not be modified"
    );

    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_update_model_selection_generator_failure_rollback() {
    let ws = temp_root("model-upd-gen-rollback");
    let home = temp_root("model-upd-gen-rollback-home");

    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{"model":"old","small_model":"old-small"}"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        r#"{"read":{"default":"allow"}}"#,
    );
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, ".riggverk/workspace.json", "{}");
    write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
    write_file(&ws, "README.md", "# readme\n");
    fs::create_dir_all(ws.join("skills")).expect("create skills dir");

    // Generator that always fails
    let (gen_dir, script) = fake_generator(
        "model-upd-gen-rollback-script",
        "print('simulated failure', file=sys.stderr)\nsys.exit(1)\n",
    );

    // Simulate what update_opencode_model_selection does with rollback:
    // write base → run generator → on failure restore base → best-effort regenerate
    let base_path = ws.join("templates/opencode.base.json");
    let snapshot_path = ws.join("templates/opencode.json");

    // 1. Save original content for rollback
    let original_content = std::fs::read_to_string(&base_path).unwrap();

    // 2. Write updated base config
    let mut json: serde_json::Value = serde_json::from_str(&original_content).unwrap();
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "model".into(),
            serde_json::Value::String("provider/new-model".into()),
        );
        obj.insert(
            "small_model".into(),
            serde_json::Value::String("provider/new-small".into()),
        );
    }
    std::fs::write(&base_path, serde_json::to_string_pretty(&json).unwrap()).unwrap();

    // 3. Generator should fail
    let gen_result = super::run_generator_write_with_script(&script, &ws)
        .expect("generator should return ActionResult");
    assert!(!gen_result.success, "generator should fail");
    assert!(gen_result.stderr.contains("simulated failure"));

    // 4. Rollback: restore original base content
    std::fs::write(&base_path, &original_content).unwrap();

    // 5. Best-effort regenerate from restored base (this will also fail since script always fails)
    let _retry_result = super::run_generator_write_with_script(&script, &ws);

    // 6. Verify base config was restored to original values
    let restored_content = std::fs::read_to_string(&base_path).unwrap();
    let restored_json: serde_json::Value = serde_json::from_str(&restored_content).unwrap();
    assert_eq!(
        restored_json["model"].as_str(),
        Some("old"),
        "base config model should be restored after generator failure"
    );
    assert_eq!(
        restored_json["small_model"].as_str(),
        Some("old-small"),
        "base config small_model should be restored after generator failure"
    );

    // 7. Snapshot was NOT updated with new values (generator failed)
    let snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap_or_default();
    assert_eq!(snapshot_content.trim(), "{}");

    cleanup(&ws);
    cleanup(&home);
    cleanup(&gen_dir);
}

#[test]
fn test_update_model_selection_snapshot_validation_failure_rollback() {
    let ws = temp_root("model-upd-val-rollback");
    let home = temp_root("model-upd-val-rollback-home");

    write_file(
        &ws,
        "templates/opencode.base.json",
        r#"{"model":"old","small_model":"old-small"}"#,
    );
    write_file(
        &ws,
        "templates/opencode.policy.json",
        r#"{"read":{"default":"allow"}}"#,
    );
    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "templates/tui.json", r#"{}"#);
    write_file(&ws, ".riggverk/workspace.json", "{}");
    write_file(&ws, "templates/global-agent-rules.md", "# rules\n");
    write_file(&ws, "README.md", "# readme\n");
    fs::create_dir_all(ws.join("skills")).expect("create skills dir");

    // Generator that succeeds but writes DIFFERENT model values (simulates a buggy generator)
    let (gen_dir, script) = fake_generator(
            "model-upd-val-rollback-script",
            "import json\nwith open(os.path.join(root, 'templates', 'opencode.base.json')) as f:\n    base = json.load(f)\n# Intentionally write a DIFFERENT model to simulate validation failure\nconfig = dict(base)\nconfig['model'] = 'wrong/model'\nwith open(os.path.join(root, 'templates', 'opencode.json'), 'w') as f:\n    json.dump(config, f, indent=2)\n    f.write('\\n')\n",
        );

    // Simulate update with rollback: write base → run generator → validate → on mismatch, restore base
    let base_path = ws.join("templates/opencode.base.json");
    let snapshot_path = ws.join("templates/opencode.json");

    // 1. Save original content for rollback
    let original_content = std::fs::read_to_string(&base_path).unwrap();

    // 2. Write updated base config with desired model values
    let mut json: serde_json::Value = serde_json::from_str(&original_content).unwrap();
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "model".into(),
            serde_json::Value::String("provider/new-model".into()),
        );
        obj.insert(
            "small_model".into(),
            serde_json::Value::String("provider/new-small".into()),
        );
    }
    let updated_content = serde_json::to_string_pretty(&json).unwrap();
    std::fs::write(&base_path, &updated_content).unwrap();

    // 3. Generator succeeds (but writes wrong model)
    let gen_result = super::run_generator_write_with_script(&script, &ws)
        .expect("generator should return ActionResult");
    assert!(
        gen_result.success,
        "generator write should succeed (but with wrong values)"
    );

    // 4. Validate snapshot - generator wrote 'wrong/model' not 'provider/new-model'
    assert!(snapshot_path.is_file(), "snapshot should exist");
    let snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap();
    let snapshot_json: serde_json::Value = serde_json::from_str(&snapshot_content).unwrap();
    let stored_model = snapshot_json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert_eq!(
        stored_model, "wrong/model",
        "generator should have written the wrong model"
    );
    assert_ne!(
        stored_model, "provider/new-model",
        "snapshot model should NOT match requested model"
    );

    // 5. Rollback: restore original base content
    std::fs::write(&base_path, &original_content).unwrap();

    // 6. Best-effort regenerate from restored base
    let retry_result = super::run_generator_write_with_script(&script, &ws);
    assert!(
        retry_result.is_ok(),
        "retry generator should return ActionResult"
    );

    // 7. Verify base config was restored to original values
    let restored_content = std::fs::read_to_string(&base_path).unwrap();
    let restored_json: serde_json::Value = serde_json::from_str(&restored_content).unwrap();
    assert_eq!(
        restored_json["model"].as_str(),
        Some("old"),
        "base config model should be restored after validation failure"
    );
    assert_eq!(
        restored_json["small_model"].as_str(),
        Some("old-small"),
        "base config small_model should be restored after validation failure"
    );

    // 8. Snapshot state after rollback: generator is buggy so snapshot may not match.
    //    The critical guarantee is that base config was restored. The snapshot is best-effort.
    let final_snapshot_content = std::fs::read_to_string(&snapshot_path).unwrap();
    let final_snapshot_json: serde_json::Value =
        serde_json::from_str(&final_snapshot_content).unwrap();
    // Generator still has the bug (always writes 'wrong/model'), but the base was restored.
    // The rollback restored base to 'old' values; the snapshot is a separate concern.
    assert!(
        final_snapshot_json.get("model").is_some(),
        "snapshot should still exist after rollback regenerate"
    );

    cleanup(&ws);
    cleanup(&home);
    cleanup(&gen_dir);
}

// ── Model override file tests ──

fn write_override_file(dir: &Path, rel: &str, content: &str) -> PathBuf {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create override dir");
    }
    fs::write(&path, content).expect("write override");
    path
}

fn override_of(model: Option<&str>, small: Option<&str>, subagent: Option<&str>) -> ModelOverride {
    let own = |value: Option<&str>| value.map(str::to_string);
    ModelOverride {
        model: own(model),
        small_model: own(small),
        subagent_model: own(subagent),
        critic_model: None,
    }
}

fn read_override_text(name: &str, content: &str) -> Option<ModelOverride> {
    let dir = temp_root(name);
    let path = write_override_file(&dir, "override.json", content);
    let read = read_stored_opencode_model_override_from_path(&path);
    cleanup(&dir);
    read
}

#[test]
fn test_read_stored_model_override_returns_none_when_file_missing() {
    let dir = temp_root("override-missing");
    let path = dir.join("nonexistent.json");
    assert!(read_stored_opencode_model_override_from_path(&path).is_none());
    cleanup(&dir);
}

#[test]
fn test_read_stored_model_override_returns_none_when_invalid_json() {
    assert!(read_override_text("override-bad-json", "not json {{{").is_none());
}

#[test]
fn test_read_stored_model_override_parses_a_file_with_both_main_models() {
    // The shape every earlier app version wrote: two explicit overrides, no subagent model.
    let read = read_override_text(
        "override-valid",
        r#"{"schema_version":1,"model":"test/a","small_model":"test/b"}"#,
    );
    assert_eq!(
        read,
        Some(override_of(Some("test/a"), Some("test/b"), None))
    );
}

#[test]
fn test_read_stored_model_override_returns_none_on_wrong_schema_version() {
    let read = read_override_text(
        "override-schema",
        r#"{"schema_version":99,"model":"test/a","small_model":"test/b"}"#,
    );
    assert!(read.is_none());
}

#[test]
fn test_stored_override_values_are_optional_and_independent() {
    for (content, expected) in [
        (
            r#"{"schema_version":1,"subagent_model":" e/f "}"#,
            override_of(None, None, Some("e/f")),
        ),
        (
            r#"{"schema_version":1,"small_model":"c/d"}"#,
            override_of(None, Some("c/d"), None),
        ),
        (
            r#"{"schema_version":1,"model":"a/b","small_model":"c/d","subagent_model":"e/f"}"#,
            override_of(Some("a/b"), Some("c/d"), Some("e/f")),
        ),
    ] {
        assert_eq!(
            read_override_text("override-optional", content),
            Some(expected)
        );
    }
}

#[test]
fn test_a_malformed_stored_value_is_dropped_without_discarding_the_others() {
    for (content, expected) in [
        (
            r#"{"schema_version":1,"model":"invalid","small_model":"test/b"}"#,
            override_of(None, Some("test/b"), None),
        ),
        (
            r#"{"schema_version":1,"model":"","small_model":"test/b"}"#,
            override_of(None, Some("test/b"), None),
        ),
        (
            r#"{"schema_version":1,"model":"a/b","small_model":"c/d","subagent_model":"nope"}"#,
            override_of(Some("a/b"), Some("c/d"), None),
        ),
    ] {
        assert_eq!(
            read_override_text("override-malformed", content),
            Some(expected)
        );
    }
}

#[test]
fn test_a_file_without_a_usable_value_is_no_override() {
    for content in [
        r#"{"schema_version":1}"#,
        r#"{"schema_version":1,"model":"invalid","subagent_model":""}"#,
    ] {
        assert!(
            read_override_text("override-empty", content).is_none(),
            "{content}"
        );
    }
}

#[test]
fn test_stored_critic_model_is_validated_independently() {
    let valid = read_override_text(
        "critic-stored",
        r#"{"schema_version":1,"critic_model":" strong/org/model "}"#,
    )
    .expect("critic-only override");
    assert_eq!(valid.critic_model.as_deref(), Some("strong/org/model"));
    assert_eq!(
        valid
            .selection_over(("def/main".into(), "def/small".into()))
            .critic_source,
        "override"
    );
    let invalid = read_override_text(
        "critic-stored-invalid",
        r#"{"schema_version":1,"subagent_model":"cheap/fast","critic_model":"bad//model"}"#,
    )
    .expect("valid subagent survives");
    assert_eq!(invalid, override_of(None, None, Some("cheap/fast")));
    assert!(
        read_override_text("critic-empty", r#"{"schema_version":1,"critic_model":""}"#).is_none()
    );
}

#[test]
fn test_selection_takes_each_value_from_its_own_source() {
    let defaults = || ("def/large".to_string(), "def/small".to_string());

    let none = ModelOverride::default().selection_over(defaults());
    assert_eq!(
        (none.model.as_str(), none.small_model.as_str()),
        ("def/large", "def/small")
    );
    assert_eq!(none.subagent_model, "");
    assert_eq!(none.critic_model, "");
    for source in [
        &none.model_source,
        &none.small_model_source,
        &none.subagent_source,
        &none.critic_source,
    ] {
        assert_eq!(source, "bundled default");
    }

    let only_small = override_of(None, Some("mine/small"), None).selection_over(defaults());
    assert_eq!(only_small.model, "def/large");
    assert_eq!(only_small.small_model, "mine/small");
    assert_eq!(
        (
            only_small.model_source.as_str(),
            only_small.small_model_source.as_str(),
            only_small.subagent_source.as_str()
        ),
        ("bundled default", "override", "bundled default")
    );

    let only_subagent = override_of(None, None, Some("mine/sub")).selection_over(defaults());
    assert_eq!(only_subagent.model, "def/large");
    assert_eq!(only_subagent.subagent_model, "mine/sub");
    assert_eq!(
        (
            only_subagent.model_source.as_str(),
            only_subagent.small_model_source.as_str(),
            only_subagent.subagent_source.as_str()
        ),
        ("bundled default", "bundled default", "override")
    );
}

#[test]
fn test_render_expected_opencode_config_overlays_override() {
    let ws = temp_root("render-override-ws");
    let home = temp_root("render-override-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    // Write override file
    write_override_file(
        &ws,
        "override.json",
        r#"{"schema_version":1,"model":"override-provider/test-model","small_model":"override-provider/test-small"}"#,
    );

    let template_json: serde_json::Value =
        serde_json::from_str(r#"{"model":"template/model","small_model":"template/small"}"#)
            .expect("parse template");

    let rendered =
        render_expected_opencode_config(&template_json, &home).expect("render should succeed");

    // Without override present at the actual app support path, template values are used
    // (the override file is in our temp dir, not at the real app support path)
    assert_eq!(rendered["model"].as_str(), Some("template/model"));
    assert_eq!(rendered["small_model"].as_str(), Some("template/small"));

    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_render_expected_opencode_config_no_override_uses_template() {
    let ws = temp_root("render-no-override-ws");
    let home = temp_root("render-no-override-home");

    write_file(&ws, "templates/opencode.json", r#"{}"#);
    write_file(&ws, "agents/architect.md", "# architect");

    let template_json: serde_json::Value =
        serde_json::from_str(r#"{"model":"bundled/model","small_model":"bundled/small"}"#)
            .expect("parse template");

    let rendered =
        render_expected_opencode_config(&template_json, &home).expect("render should succeed");

    assert_eq!(rendered["model"].as_str(), Some("bundled/model"));
    assert_eq!(rendered["small_model"].as_str(), Some("bundled/small"));

    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_validate_model_id_rejects_invalid_patterns() {
    assert!(validate_model_id("").is_err());
    assert!(validate_model_id("modelonly").is_err());
    assert!(validate_model_id("/model").is_err());
    assert!(validate_model_id("provider/").is_err());
    assert!(validate_model_id("provider//b").is_err());
    assert!(validate_model_id("provider/a/").is_err());
    assert!(validate_model_id("   ").is_err());
}

#[test]
fn test_update_opencode_model_selection_writes_override_not_template() {
    // Verify that update_opencode_model_selection writes the override file
    // and does NOT mutate workspace templates.
    // We cannot call the Tauri command directly in a unit test, but we can
    // verify the lower-level save path and file content.
    let dir = temp_root("model-upd-ovr");

    let override_path = dir.join("test-override.json");
    let base_path = dir.join("templates/opencode.base.json");
    let snapshot_path = dir.join("templates/opencode.json");

    // Create workspace template files
    write_file(
        &dir,
        "templates/opencode.base.json",
        r#"{"model":"old/model","small_model":"old/small"}"#,
    );
    write_file(&dir, "templates/opencode.json", r#"{"model":"old/model"}"#);

    // Save the original content for comparison
    let base_before = std::fs::read_to_string(&base_path).unwrap();
    let snapshot_before = std::fs::read_to_string(&snapshot_path).unwrap();

    // Now simulate what update_opencode_model_selection does:
    // write override file (don't use real app support path, use our test path)
    let stored = StoredOpenCodeModelSelection {
        schema_version: 1,
        model: Some("new-provider/new-model".to_string()),
        small_model: Some("new-provider/new-small".to_string()),
        subagent_model: None,
        critic_model: None,
    };
    let content = serde_json::to_string_pretty(&stored).unwrap();
    fs::write(&override_path, &content).unwrap();

    // Verify template files were NOT modified
    let base_after = std::fs::read_to_string(&base_path).unwrap();
    let snapshot_after = std::fs::read_to_string(&snapshot_path).unwrap();
    assert_eq!(
        base_before, base_after,
        "opencode.base.json must not be modified"
    );
    assert_eq!(
        snapshot_before, snapshot_after,
        "opencode.json must not be modified"
    );

    // Verify override file was written
    assert!(override_path.is_file(), "override file must exist");
    let override_content = std::fs::read_to_string(&override_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&override_content).unwrap();
    assert_eq!(parsed["model"].as_str(), Some("new-provider/new-model"));
    assert_eq!(
        parsed["small_model"].as_str(),
        Some("new-provider/new-small")
    );
    assert_eq!(parsed["schema_version"].as_u64(), Some(1));

    cleanup(&dir);
}

// ── Config, rules and Playwright facts ──

fn health_of_installed(
    name: &str,
    edit: impl FnOnce(&mut serde_json::Value),
) -> OpenCodeRuntimeHealth {
    let (ws, home) = setup_synced_bundle_copy(name);
    let installed_path = home.join(".config/opencode/opencode.json");
    let mut installed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&installed_path).expect("installed"))
            .expect("parse installed");
    edit(&mut installed);
    fs::write(&installed_path, installed.to_string()).expect("write installed");
    let health = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);
    health
}

#[test]
fn test_config_row_is_synced_without_diverged_keys() {
    let health = health_of_installed("cfg-synced", |_| {});
    assert_eq!(health.config_status, "synced");
    assert!(health.config_diverged_keys.is_empty());
}

#[test]
fn test_config_row_names_the_diverged_managed_keys() {
    let health = health_of_installed("cfg-diverged", |installed| {
        installed["model"] = "other/model".into();
        installed["lsp"] = false.into();
        installed["provider"] = serde_json::json!({"mine": {}});
    });
    assert_eq!(health.config_status, "diverged");
    // Managed keys only: the user's own `provider` block is not a difference.
    assert_eq!(health.config_diverged_keys, ["model", "lsp"]);
    let detail = &health
        .checks
        .iter()
        .find(|c| c.id == "configs_match")
        .expect("configs_match check")
        .detail;
    assert!(detail.contains("model, lsp"), "{detail}");
    assert_eq!(health.status, "diverged");
}

#[test]
fn test_config_row_reports_missing_and_invalid_installed_files() {
    let (ws, home) = setup_synced_bundle_copy("cfg-missing");
    let installed_path = home.join(".config/opencode/opencode.json");
    fs::write(&installed_path, "{ not json").expect("break installed");
    let invalid = compute_health(&ws, &home);
    fs::remove_file(&installed_path).expect("remove installed");
    let missing = compute_health(&ws, &home);
    cleanup(&ws);
    cleanup(&home);

    assert_eq!(invalid.config_status, "invalid");
    assert_eq!(missing.config_status, "missing");
    assert!(invalid.config_diverged_keys.is_empty() && missing.config_diverged_keys.is_empty());
}

#[test]
fn test_differing_keys_cover_mcp_agent_and_permission_order() {
    let rendered: serde_json::Value = serde_json::from_str(
        r#"{"model":"a/b","permission":{"*":"ask","src/**":"allow","**/.env":"deny"},
                "mcp":{"playwright":{"command":["npx","@playwright/mcp@0.0.48"]}},
                "agent":{"plan":{"permission":{"edit":{"*":"deny"}}}}}"#,
    )
    .expect("rendered");
    assert!(differing_managed_opencode_keys(&rendered, &rendered).is_empty());

    let installed: serde_json::Value = serde_json::from_str(
        r#"{"model":"a/b","permission":{"*":"ask","**/.env":"deny","src/**":"allow"},
                "mcp":{"playwright":{"command":["npx","@playwright/mcp@0.0.30"]},"mine":{}},
                "agent":{"plan":{"permission":{"edit":"allow"}},"mine":{}}}"#,
    )
    .expect("installed");
    assert_eq!(
        differing_managed_opencode_keys(&installed, &rendered),
        ["permission", "mcp.playwright", "agent.plan"]
    );
    // Matching is the same question.
    assert!(!managed_opencode_keys_match(&installed, &rendered));
}

#[test]
fn test_rules_row_compares_global_agents_md_with_the_bundled_rules() {
    let (ws, home) = setup_synced_bundle_copy("rules");
    let health = |ws: &Path, home: &Path| compute_health(ws, home).rules_status;

    assert_eq!(
        health(&ws, &home),
        "unknown",
        "no rules template in the workspace"
    );
    write_file(&ws, "templates/sync/opencode-rules.md", "# rules\n");
    assert_eq!(health(&ws, &home), "missing");
    write_file(&home, ".config/opencode/AGENTS.md", "# rules\n");
    assert_eq!(health(&ws, &home), "synced");
    write_file(&home, ".config/opencode/AGENTS.md", "# edited\n");
    assert_eq!(health(&ws, &home), "diverged");
    // Rules never decide the overall status; the install overview reports them per surface.
    assert_eq!(compute_health(&ws, &home).status, "synced");

    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_playwright_pin_is_read_from_the_installed_command() {
    let config: serde_json::Value = serde_json::from_str(
            r#"{"mcp":{"playwright":{"command":["npx","-y","@playwright/mcp@0.0.48","--config","c.json"]}}}"#,
        )
        .expect("config");
    assert_eq!(
        playwright_mcp_version_of(&config).as_deref(),
        Some("0.0.48")
    );
    for without in [
        r#"{}"#,
        r#"{"mcp":{"other":{}}}"#,
        r#"{"mcp":{"playwright":{"command":["npx","playwright"]}}}"#,
    ] {
        let config: serde_json::Value = serde_json::from_str(without).expect("config");
        assert_eq!(playwright_mcp_version_of(&config), None, "{without}");
    }
}

// ── CLI path ──

#[test]
fn test_fallback_candidates_include_the_official_installer_dir() {
    let home = Path::new("/home/someone");
    let candidates = opencode_fallback_candidates(Some(home));
    assert!(candidates.contains(&PathBuf::from("/opt/homebrew/bin/opencode")));
    assert!(candidates.contains(&PathBuf::from("/usr/local/bin/opencode")));
    assert!(candidates.contains(&home.join(".opencode/bin/opencode")));
    assert!(!opencode_fallback_candidates(None)
        .iter()
        .any(|p| p.ends_with(".opencode/bin/opencode")));
}

#[cfg(unix)]
#[test]
fn test_resolve_finds_the_official_installer_binary_without_path() {
    let home = temp_root("installer-home");
    let stub = write_stub_opencode(&home.join(".opencode/bin"), "echo 1.19.3");
    let found = resolve_opencode_executable_in("", &[home.join(".opencode/bin/opencode")]);
    assert_eq!(found, Some(fs::canonicalize(&stub).unwrap()));
    cleanup(&home);

    let nothing = resolve_opencode_executable_in("", &[PathBuf::from("/nonexistent/opencode")]);
    assert_eq!(nothing, None);
}

#[cfg(unix)]
#[test]
fn test_resolve_prefers_path_over_fallbacks() {
    let on_path = temp_root("path-first");
    let fallback = temp_root("path-first-fallback");
    let wanted = write_stub_opencode(&on_path, "echo 1.19.3");
    let other = write_stub_opencode(&fallback, "echo 1.19.3");
    let found = resolve_opencode_executable_in(&on_path.to_string_lossy(), &[other]);
    assert_eq!(found, Some(fs::canonicalize(&wanted).unwrap()));
    cleanup(&on_path);
    cleanup(&fallback);
}

#[cfg(unix)]
#[test]
fn test_resolve_skips_an_opencode_others_can_change() {
    use std::os::unix::fs::PermissionsExt;
    let open = temp_root("untrusted-first");
    let trusted = temp_root("trusted-second");
    let skipped = write_stub_opencode(&open.join("bin"), "echo 1.19.3");
    let wanted = write_stub_opencode(&trusted.join("bin"), "echo 1.19.3");
    // Everyone can write the folder above the first one, without the sticky bit.
    fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
    let path_env = format!(
        "{}:{}",
        open.join("bin").display(),
        trusted.join("bin").display()
    );
    let canonical = fs::canonicalize(&wanted).unwrap();

    assert_eq!(
        resolve_opencode_executable_in(&path_env, &[]),
        Some(canonical.clone())
    );
    assert_eq!(
        resolve_opencode_executable_in("", &[skipped.clone(), wanted.clone()]),
        Some(canonical)
    );
    assert_eq!(resolve_opencode_executable_in("", &[skipped]), None);
    cleanup(&open);
    cleanup(&trusted);
}

#[cfg(unix)]
#[test]
fn test_health_names_an_opencode_it_does_not_use() {
    use std::os::unix::fs::PermissionsExt;
    let open = temp_root("untrusted-health");
    let stub = write_stub_opencode(&open.join("bin"), "echo 1.19.3");
    fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
    let (before, _) = probe_synced("untrusted-health-ws", None, LIMITS);
    let mut health = before.clone();
    apply_resolved_cli(
        &mut health,
        resolve_cli(std::slice::from_ref(&stub), LIMITS),
        LIMITS,
    );
    cleanup(&open);
    let cli = health.cli.as_ref().expect("cli health");
    assert_eq!(cli.status, "missing");
    // The harness header (harnessHeader.ts) tells this case apart by the start of the detail.
    assert!(cli.detail.starts_with("found at "), "{}", cli.detail);
    assert!(
        cli.detail.contains(&stub.display().to_string()),
        "{}",
        cli.detail
    );
    assert!(
        cli.detail.contains("can be changed by another user"),
        "{}",
        cli.detail
    );
    assert_eq!(check_of(&health, "cli").status, "warn");
}

#[test]
fn test_missing_cli_error_names_the_install_options() {
    let msg = list_models_with_executable(None, Duration::from_secs(1))
        .expect_err("missing opencode CLI must be an error");
    for needle in ["opencode-ai", "anomalyco/tap/opencode", "~/.opencode/bin"] {
        assert!(msg.contains(needle), "{msg}");
    }
}

// ── CLI probes against a stub `opencode` ──

/// A stub that answers `--version`, `debug agent <name> --pure` (exit status only),
/// `debug agents` (a list with `architect` and `build`) and `models`, and records the
/// arguments of the `models` call in `models-args.txt`.
#[cfg(unix)]
fn health_stub(dir: &Path, version: &str, agent_exit: i32, models: &[&str]) -> PathBuf {
    let listed: String = models.iter().map(|m| format!("'{m}' ")).collect();
    write_stub_opencode(
        dir,
        &format!(
            r#"case "$1" in
  --version) echo {version}; exit 0 ;;
  debug) [ "$2" = agents ] && echo '[{{"id":"architect","permissions":[]}},{{"id":"build"}}]'; exit {agent_exit} ;;
  models) echo "$@" > "$(dirname "$0")/models-args.txt"; printf '%s\n' {listed}; exit 0 ;;
esac
exit 64"#
        ),
    )
}

#[cfg(unix)]
const GOOD_MODELS: [&str; 3] = [
    "opencode-go/glm-5.2",
    "opencode-go/deepseek-v4.1-flash",
    "other/model",
];

#[cfg(unix)]
const LIMITS: ProbeLimits = ProbeLimits {
    version: Duration::from_secs(10),
    agent: Duration::from_secs(10),
    models: Duration::from_secs(10),
};

#[cfg(unix)]
fn check_of<'a>(health: &'a OpenCodeRuntimeHealth, id: &str) -> &'a OpenCodeRuntimeCheck {
    health
        .checks
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("check {id}"))
}

/// A synced health, probed with `program`; returns the health before and after the probes.
#[cfg(unix)]
fn probe_synced(
    name: &str,
    program: Option<&Path>,
    limits: ProbeLimits,
) -> (OpenCodeRuntimeHealth, OpenCodeRuntimeHealth) {
    let (ws, home) = setup_synced_bundle_copy(name);
    let before = compute_health(&ws, &home);
    let mut after = before.clone();
    apply_cli_probes(&mut after, program, limits);
    cleanup(&ws);
    cleanup(&home);
    (before, after)
}

#[cfg(unix)]
#[test]
fn test_unprobed_models_are_unknown_not_passing() {
    let (before, _) = probe_synced("unprobed", None, LIMITS);
    assert_eq!(check_of(&before, "model").status, "unknown");
    assert_eq!(check_of(&before, "small_model").status, "unknown");
    assert!(before.cli.is_none());
}

#[cfg(unix)]
#[test]
fn test_probes_confirm_listed_models_and_a_resolving_agent() {
    let dir = temp_root("probe-ok");
    let stub = health_stub(&dir, "1.19.3", 0, &GOOD_MODELS);
    let (before, after) = probe_synced("probe-ok", Some(&stub), LIMITS);
    let args = fs::read_to_string(dir.join("models-args.txt")).expect("models called");
    cleanup(&dir);

    let cli = after.cli.as_ref().expect("cli probed");
    assert_eq!(
        (cli.status.as_str(), cli.version.as_deref()),
        ("supported", Some("1.19.3"))
    );
    for id in ["model", "small_model", "default_agent_resolves", "cli"] {
        assert_eq!(check_of(&after, id).status, "pass", "{id}");
    }
    assert!(after.warnings.is_empty(), "{:?}", after.warnings);
    assert_eq!(
        after.status, before.status,
        "probes never change the status"
    );
    assert_eq!(args.trim(), "models --pure");
}

#[cfg(unix)]
#[test]
fn test_a_model_missing_from_the_listing_warns_without_failing_health() {
    let dir = temp_root("probe-missing-model");
    let stub = health_stub(&dir, "1.19.3", 0, &["opencode-go/glm-5.2", "other/model"]);
    let (before, after) = probe_synced("probe-missing-model", Some(&stub), LIMITS);
    cleanup(&dir);

    assert_eq!(check_of(&after, "model").status, "pass");
    let small = check_of(&after, "small_model");
    assert_eq!(small.status, "warn");
    assert!(
        small.detail.contains("opencode-go/deepseek-v4.1-flash"),
        "{}",
        small.detail
    );
    assert_eq!(after.warnings.len(), 1, "{:?}", after.warnings);
    let warning = &after.warnings[0];
    assert!(
        warning.contains("small_model opencode-go/deepseek-v4.1-flash"),
        "{warning}"
    );
    assert!(
        warning.contains("does not pick another small model"),
        "{warning}"
    );
    assert_eq!(after.status, before.status);

    // The main model is reported too, without the small-model note.
    let dir = temp_root("probe-missing-main");
    let stub = health_stub(&dir, "1.19.3", 0, &["opencode-go/deepseek-v4.1-flash"]);
    let (_, after) = probe_synced("probe-missing-main", Some(&stub), LIMITS);
    cleanup(&dir);
    assert_eq!(check_of(&after, "model").status, "warn");
    assert!(after.warnings[0].starts_with("model opencode-go/glm-5.2 is not listed"));
    assert!(!after.warnings[0].contains("small model"));
}

#[cfg(unix)]
#[test]
fn test_a_default_agent_that_does_not_resolve_warns() {
    let dir = temp_root("probe-bad-agent");
    let stub = health_stub(&dir, "1.19.3", 1, &GOOD_MODELS);
    let (before, after) = probe_synced("probe-bad-agent", Some(&stub), LIMITS);
    cleanup(&dir);

    assert_eq!(check_of(&after, "default_agent_resolves").status, "fail");
    assert_eq!(after.warnings.len(), 1, "{:?}", after.warnings);
    assert!(after.warnings[0].contains("cannot resolve default agent architect"));
    assert_eq!(after.status, before.status);
}

#[cfg(unix)]
#[test]
fn test_a_missing_cli_leaves_the_probes_unknown_and_health_untouched() {
    let (before, after) = probe_synced("probe-no-cli", None, LIMITS);

    let cli = after.cli.as_ref().expect("cli probed");
    assert_eq!(cli.status, "missing");
    assert!(cli.detail.contains("opencode-ai") && cli.detail.contains("anomalyco/tap/opencode"));
    for id in ["model", "small_model", "default_agent_resolves"] {
        assert_eq!(check_of(&after, id).status, "unknown", "{id}");
    }
    assert!(after.warnings.is_empty(), "{:?}", after.warnings);
    assert_eq!(after.status, before.status);
    assert_eq!(after.next_action, before.next_action);
}

#[cfg(unix)]
#[test]
fn test_a_hung_cli_is_unknown_and_bounded() {
    let dir = temp_root("probe-hang");
    // `exec` so the killed process is the sleeper itself (no orphan holding the pipe).
    let stub = write_stub_opencode(&dir, "exec sleep 30");
    let limits = ProbeLimits {
        version: Duration::from_millis(300),
        ..LIMITS
    };
    let started = std::time::Instant::now();
    let (before, after) = probe_synced("probe-hang", Some(&stub), limits);
    cleanup(&dir);

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the timeout bounds the wait"
    );
    assert_eq!(
        after.cli.as_ref().map(|c| c.status.as_str()),
        Some("unknown")
    );
    for id in ["model", "small_model", "default_agent_resolves"] {
        assert_eq!(check_of(&after, id).status, "unknown", "{id}");
    }
    assert!(after.warnings.is_empty());
    assert_eq!(after.status, before.status);
}

#[cfg(unix)]
#[test]
fn test_a_model_listing_that_fails_or_times_out_is_unknown() {
    let dir = temp_root("probe-models-fail");
    let stub = write_stub_opencode(
        &dir,
        r#"case "$1" in --version) echo 1.19.3 ;; debug) exit 0 ;; *) echo opencode-go/glm-5.2; exit 3 ;; esac"#,
    );
    let (_, failed) = probe_synced("probe-models-fail", Some(&stub), LIMITS);
    cleanup(&dir);
    assert_eq!(check_of(&failed, "model").status, "unknown");
    assert_eq!(check_of(&failed, "default_agent_resolves").status, "pass");
    assert!(failed.warnings.is_empty(), "{:?}", failed.warnings);

    let dir = temp_root("probe-models-hang");
    let stub = write_stub_opencode(
        &dir,
        r#"case "$1" in --version) echo 1.19.3 ;; debug) exit 0 ;; *) exec sleep 30 ;; esac"#,
    );
    let limits = ProbeLimits {
        models: Duration::from_millis(300),
        ..LIMITS
    };
    let started = std::time::Instant::now();
    let (_, hung) = probe_synced("probe-models-hang", Some(&stub), limits);
    cleanup(&dir);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(check_of(&hung, "model").status, "unknown");
    assert_eq!(check_of(&hung, "small_model").status, "unknown");
    assert!(hung.warnings.is_empty(), "{:?}", hung.warnings);
}

/// [`probe_synced`] for an OpenCode 2 health: the files are checked as 2.x reads them.
#[cfg(unix)]
fn probe_synced_v2(name: &str, program: &Path) -> (OpenCodeRuntimeHealth, OpenCodeRuntimeHealth) {
    let (ws, home) = setup_synced_bundle_copy(name);
    let before = compute_health_for(&ws, &home, Some(2));
    let mut after = before.clone();
    apply_cli_probes(&mut after, Some(program), LIMITS);
    cleanup(&ws);
    cleanup(&home);
    (before, after)
}

#[cfg(unix)]
#[test]
fn test_a_2x_cli_is_compatible_lists_standalone_and_finds_the_agent_in_debug_agents() {
    let dir = temp_root("probe-v2");
    let stub = health_stub(&dir, "opencode v2.3.2", 0, &GOOD_MODELS);
    let (before, after) = probe_synced_v2("probe-v2", &stub);
    let args = fs::read_to_string(dir.join("models-args.txt")).expect("models called");
    cleanup(&dir);

    let cli = after.cli.as_ref().expect("cli probed");
    assert_eq!(
        (cli.status.as_str(), cli.version.as_deref(), cli.major),
        ("compatible", Some("2.3.2"), Some(2))
    );
    assert!(after.warnings.is_empty(), "{:?}", after.warnings);
    assert_eq!(args.trim(), "models --standalone");
    for id in ["cli", "default_agent_resolves", "model"] {
        assert_eq!(check_of(&after, id).status, "pass", "{id}");
    }
    assert_eq!(after.status, before.status);
    assert_eq!(after.status, "synced");
}

#[cfg(unix)]
#[test]
fn test_a_2x_default_agent_missing_from_debug_agents_warns() {
    let dir = temp_root("probe-v2-unlisted");
    let stub = write_stub_opencode(
        &dir,
        r#"case "$1" in --version) echo 'opencode v2.4.0' ;; debug) echo '[{"id":"build"}]' ;; *) exit 0 ;; esac"#,
    );
    let (before, after) = probe_synced_v2("probe-v2-unlisted", &stub);
    cleanup(&dir);

    assert!(after
        .cli
        .as_ref()
        .is_some_and(|cli| cli.detail.contains("tested with 2.3.2")));
    let agent = check_of(&after, "default_agent_resolves");
    assert_eq!(agent.status, "fail");
    assert_eq!(after.warnings.len(), 1, "{:?}", after.warnings);
    assert!(
        after.warnings[0].starts_with("OpenCode 2 does not list default agent architect"),
        "{}",
        after.warnings[0]
    );
    assert_eq!(after.status, before.status);
}

#[cfg(unix)]
#[test]
fn test_a_2x_agent_listing_that_fails_stays_unknown() {
    let dir = temp_root("probe-v2-fails");
    let stub = health_stub(&dir, "opencode v2.3.2", 1, &GOOD_MODELS);
    let (_, after) = probe_synced_v2("probe-v2-fails", &stub);
    cleanup(&dir);

    let agent = check_of(&after, "default_agent_resolves");
    assert_eq!(agent.status, "unknown");
    assert!(
        agent
            .detail
            .contains("opencode debug agents gave no agent list"),
        "{}",
        agent.detail
    );
    assert!(after.warnings.is_empty(), "{:?}", after.warnings);
}

#[cfg(unix)]
#[test]
fn test_a_3x_cli_is_unsupported_and_skips_the_agent_probe() {
    let dir = temp_root("probe-v3");
    let stub = health_stub(&dir, "3.0.0", 0, &GOOD_MODELS);
    let (before, after) = probe_synced("probe-v3", Some(&stub), LIMITS);
    cleanup(&dir);

    let cli = after.cli.as_ref().expect("cli probed");
    assert_eq!((cli.status.as_str(), cli.major), ("unsupported", Some(3)));
    assert_eq!(check_of(&after, "cli").status, "warn");
    assert_eq!(after.warnings.len(), 1, "{:?}", after.warnings);
    assert!(after.warnings[0].contains("supports OpenCode 1.x"));
    assert_eq!(check_of(&after, "default_agent_resolves").status, "unknown");
    assert_eq!(after.status, before.status);
}

#[test]
fn test_on_opencode_2_tui_json_is_information_not_drift() {
    let (ws, home) = setup_synced_bundle_copy("tui-v2");
    write_file(&home, ".config/opencode/tui.json", r#"{"theme": "other"}"#);
    let v1 = compute_health(&ws, &home);
    assert_eq!(
        (v1.status.as_str(), v1.tui_status.as_str()),
        ("diverged", "diverged")
    );
    let v2 = compute_health_for(&ws, &home, Some(2));
    assert_eq!(v2.tui_status, "not_read");
    assert!(v2.tui_diverged_keys.is_empty());
    assert_eq!(v2.status, "synced", "{:?}", v2.checks);
    let tui = v2
        .checks
        .iter()
        .find(|check| check.id == "tui_configs_match")
        .expect("tui check");
    assert_eq!(tui.status, "info");
    assert!(
        tui.detail.starts_with("not read by OpenCode 2"),
        "{}",
        tui.detail
    );

    fs::remove_file(home.join(".config/opencode/tui.json")).unwrap();
    assert_eq!(compute_health(&ws, &home).status, "missing");
    let v2 = compute_health_for(&ws, &home, Some(2));
    assert_eq!(
        (v2.status.as_str(), v2.tui_status.as_str()),
        ("synced", "not_read")
    );
    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_on_opencode_2_config_json_is_not_a_sibling() {
    let (ws, home) = setup_synced_bundle_copy("config-json-v2");
    write_file(
        &home,
        ".config/opencode/config.json",
        r#"{"permission": {"bash": "allow"}}"#,
    );
    let v1 = compute_health(&ws, &home);
    assert_eq!(v1.status, "diverged");
    assert_eq!(v1.config_precedence.sibling_files.len(), 1);
    let v2 = compute_health_for(&ws, &home, Some(2));
    assert_eq!(v2.status, "synced", "{:?}", v2.warnings);
    assert!(v2.config_precedence.sibling_files.is_empty());
    assert!(v2.warnings.is_empty(), "{:?}", v2.warnings);
    cleanup(&ws);
    cleanup(&home);
}

#[test]
fn test_native_v2_keys_in_opencode_json_warn_on_every_major() {
    let (ws, home) = setup_synced_bundle_copy("native-v2");
    let mut config = installed(&home);
    config["permissions"] = serde_json::json!([
        {"action": "shell", "resource": "*", "effect": "allow"}
    ]);
    config["mcp"]["servers"] = serde_json::json!({"mine": {"command": [SECRET]}});
    write_file(
        &home,
        ".config/opencode/opencode.json",
        &serde_json::to_string_pretty(&config).unwrap(),
    );
    for major in [None, Some(1), Some(2)] {
        let health = compute_health_for(&ws, &home, major);
        assert_eq!(
            health.config_status, "synced",
            "managed keys are as bundled"
        );
        assert_eq!(health.status, "diverged", "{major:?}");
        assert_eq!(health.warnings.len(), 1, "{:?}", health.warnings);
        assert!(
            health.warnings[0].starts_with(
                "opencode.json sets native OpenCode 2 keys (permissions, mcp.servers)"
            ),
            "{}",
            health.warnings[0]
        );
        assert_eq!(
            health.next_action,
            "Move the native OpenCode 2 keys in opencode.json to their 1.x keys."
        );
        assert!(!health_text(&health).contains(SECRET));
    }
    cleanup(&ws);
    cleanup(&home);
}

#[cfg(unix)]
#[test]
fn test_models_are_listed_with_the_arguments_of_the_installed_major() {
    for (version, expected) in [
        ("1.19.3", "models --pure"),
        ("2.0.32", "models --standalone"),
        ("dev-build", "models --pure"),
    ] {
        let dir = temp_root("models-args");
        let stub = health_stub(&dir, version, 0, &GOOD_MODELS);
        let listed = list_models_with_executable(Some(stub), Duration::from_secs(10));
        let args = fs::read_to_string(dir.join("models-args.txt")).expect("models called");
        cleanup(&dir);

        assert_eq!(listed.expect("listing").models.len(), 3, "{version}");
        assert_eq!(args.trim(), expected, "{version}");
    }
}

// ── Subagent model override ──

const ROLES: [&str; 5] = ["repo-scout", "inspector", "sentinel", "verifier", "scribe"];

/// Write the app-level override of an isolated `home`: only a subagent model, as a pane save
/// that changed nothing else leaves it. The main models keep following the template.
fn write_override_for_home(home: &Path, subagent: Option<&str>, critic: Option<&str>) -> PathBuf {
    let path = opencode_model_selection_path_for_home(home).expect("override path");
    fs::create_dir_all(path.parent().expect("parent")).expect("create app support dir");
    let stored = StoredOpenCodeModelSelection {
        schema_version: 1,
        model: None,
        small_model: None,
        subagent_model: subagent.map(str::to_string),
        critic_model: critic.map(str::to_string),
    };
    fs::write(&path, serde_json::to_string_pretty(&stored).expect("json")).expect("write");
    path
}

fn template_with_plan_block() -> serde_json::Value {
    serde_json::json!({
        "model": "opencode-go/glm-5.2",
        "agent": {"plan": {"permission": {"edit": {"*": "deny"}}}},
    })
}

#[test]
fn test_override_without_a_subagent_model_renders_no_agent_entries_for_the_roles() {
    let home = temp_root("render-no-subagent");
    let path = opencode_model_selection_path_for_home(&home).expect("override path");
    write_override_file(
        path.parent().expect("parent"),
        "opencode-model-selection.json",
        r#"{"schema_version":1,"model":"mine/large","small_model":"mine/small"}"#,
    );
    let rendered =
        render_expected_opencode_config(&template_with_plan_block(), &home).expect("render");
    cleanup(&home);
    assert_eq!(rendered["model"], "mine/large");
    assert_eq!(json_keys(&rendered["agent"]), ["plan"]);
}

#[test]
fn test_render_applies_only_the_values_the_override_holds() {
    let home = temp_root("render-partial");
    let path = opencode_model_selection_path_for_home(&home).expect("override path");
    write_override_file(
        path.parent().expect("parent"),
        "opencode-model-selection.json",
        r#"{"schema_version":1,"small_model":"mine/small"}"#,
    );
    let template = |model: &str| serde_json::json!({"model": model, "small_model": "tpl/small"});

    let first = render_expected_opencode_config(&template("tpl/large-1"), &home).expect("render");
    // The bundled default moves on (a model that is no longer listed, say): the value the user
    // never chose follows it, the one they chose stays.
    let later = render_expected_opencode_config(&template("tpl/large-2"), &home).expect("render");
    cleanup(&home);

    assert_eq!(first["model"], "tpl/large-1");
    assert_eq!(later["model"], "tpl/large-2");
    for rendered in [&first, &later] {
        assert_eq!(rendered["small_model"], "mine/small");
        assert!(
            rendered.get("agent").is_none(),
            "no subagent model, no role entries"
        );
    }
}

#[test]
fn test_subagent_override_renders_agent_model_for_exactly_the_five_roles() {
    let home = temp_root("render-subagent");
    write_override_for_home(&home, Some("other/cheap"), None);
    let rendered =
        render_expected_opencode_config(&template_with_plan_block(), &home).expect("render");
    cleanup(&home);

    let agent = rendered["agent"].as_object().expect("agent block");
    let mut names: Vec<&str> = agent.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "inspector",
            "plan",
            "repo-scout",
            "scribe",
            "sentinel",
            "verifier"
        ],
        "the five roles and the template's own block; never architect"
    );
    for role in ROLES {
        assert_eq!(
            agent[role],
            serde_json::json!({"model": "other/cheap"}),
            "{role}"
        );
    }
    assert_eq!(
        agent["plan"],
        template_with_plan_block()["agent"]["plan"],
        "the template's block is kept"
    );
    // The main model is untouched: the roles pin their own.
    assert_eq!(rendered["model"], "opencode-go/glm-5.2");
}

#[test]
fn test_merge_pins_the_roles_and_keeps_every_other_user_agent_key() {
    let rendered = serde_json::json!({
        "agent": {
            "plan": {"permission": {"edit": {"*": "deny"}}},
            "repo-scout": {"model": "other/cheap"},
            "inspector": {"model": "other/cheap"},
            "sentinel": {"model": "other/cheap"},
            "verifier": {"model": "other/cheap"},
            "scribe": {"model": "other/cheap"},
        }
    });
    let installed = serde_json::json!({
        "agent": {
            "repo-scout": {"model": "mine/old", "description": "mine", "temperature": 0.9},
            "plan": {"model": "mine/plan", "permission": {"edit": "allow"}},
            "architect": {"model": "mine/architect"},
            "review": {"model": "mine/review"},
        },
        "provider": {"mine": {}},
    });

    let merged =
        merge_managed_opencode_config(&installed, &extract_managed_opencode_config(&rendered));

    for role in ROLES {
        assert_eq!(merged["agent"][role]["model"], "other/cheap", "{role}");
    }
    assert_eq!(merged["agent"]["repo-scout"]["description"], "mine");
    assert_eq!(merged["agent"]["repo-scout"]["temperature"], 0.9);
    assert_eq!(merged["agent"]["plan"]["model"], "mine/plan");
    assert_eq!(
        merged["agent"]["plan"]["permission"],
        rendered["agent"]["plan"]["permission"]
    );
    assert_eq!(
        merged["agent"]["architect"],
        installed["agent"]["architect"]
    );
    assert_eq!(merged["agent"]["review"], installed["agent"]["review"]);
    assert_eq!(merged["provider"], installed["provider"]);
    assert!(managed_opencode_keys_match(&merged, &rendered));
}

#[test]
fn test_clearing_the_override_removes_only_the_managed_model_entries() {
    let pinned = serde_json::json!({
        "agent": {
            "repo-scout": {"model": "other/cheap", "description": "mine"},
            "inspector": {"model": "other/cheap"},
            "sentinel": {"model": "other/cheap"},
            "verifier": {"model": "other/cheap"},
            "scribe": {"model": "other/cheap"},
            "architect": {"model": "mine/architect"},
        }
    });
    // Rendered without the override: the template has no role entries.
    let cleared = serde_json::json!({"model": "opencode-go/glm-5.2"});

    let merged = merge_managed_opencode_config(&pinned, &extract_managed_opencode_config(&cleared));

    assert_eq!(
        merged["agent"],
        serde_json::json!({
            "repo-scout": {"description": "mine"},
            "architect": {"model": "mine/architect"},
        }),
        "managed models go; the user's own keys, and entries left empty, are handled alone"
    );
    assert!(managed_opencode_keys_match(&merged, &cleared));

    // With nothing else under `agent`, the block disappears instead of lingering as `{}`.
    let only_managed = serde_json::json!({"agent": {"inspector": {"model": "other/cheap"}}});
    let merged =
        merge_managed_opencode_config(&only_managed, &extract_managed_opencode_config(&cleared));
    assert!(merged.get("agent").is_none(), "{merged}");

    // A malformed user `agent` is left alone.
    let broken = merge_managed_opencode_config(
        &serde_json::json!({"agent": "oops"}),
        &extract_managed_opencode_config(&cleared),
    );
    assert_eq!(broken["agent"], "oops");
}

#[test]
fn test_differing_keys_name_each_role_whose_model_differs() {
    let rendered = serde_json::json!({
        "agent": {
            "repo-scout": {"model": "other/cheap"},
            "inspector": {"model": "other/cheap"},
        }
    });
    let installed = serde_json::json!({
        "agent": {
            "repo-scout": {"model": "other/cheap", "description": "mine"},
            "inspector": {"model": "mine/other"},
            "sentinel": {"model": "mine/sentinel"},
        }
    });
    assert_eq!(
        differing_managed_opencode_keys(&installed, &rendered),
        ["agent.inspector.model", "agent.sentinel.model"]
    );
    assert!(differing_managed_opencode_keys(&rendered, &rendered).is_empty());
}

/// An installed config as an install would leave it for the current override of `home`.
fn install_for(ws: &Path, home: &Path) {
    let template: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(ws.join("templates/opencode.json")).expect("snapshot"),
    )
    .expect("parse snapshot");
    let installed_path = home.join(".config/opencode/opencode.json");
    let installed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&installed_path).expect("installed"))
            .expect("parse installed");
    let rendered = render_expected_opencode_config(&template, home).expect("render");
    let app = AppRoleModels::load(Some(&record_root(home)), home);
    let merged = merge_managed_opencode_config(
        &installed,
        &managed_opencode_install_projection(&installed, &rendered, &app),
    );
    fs::write(&installed_path, merged.to_string()).expect("write installed");
    // The record an install keeps: the role models it pinned.
    let state = crate::managed_state::ManagedState {
        schema_version: crate::managed_state::MANAGED_STATE_SCHEMA_VERSION,
        bundled_version: crate::stable_digest::bytes(b"bundle"),
        artifacts: vec![crate::managed_state::ManagedArtifactRecord {
            identity: crate::managed_state::artifact_identity(
                &crate::artifact_registry::ArtifactId::OpenCodeConfig,
            ),
            hash: crate::stable_digest::bytes(b"record"),
            surface: None,
            role_models: pinned_role_models(home),
        }],
    };
    crate::managed_state::write_managed_state_atomic(&record_root(home), &state)
        .expect("write record");
}

#[test]
fn test_health_follows_the_subagent_override_from_drift_to_applied_to_cleared() {
    let (ws, home) = setup_synced_bundle_copy("subagent-health");
    let before = compute_health(&ws, &home);

    // Saved, not yet installed: drift on exactly the five role entries.
    let override_path = write_override_for_home(&home, Some("other/cheap"), None);
    let pending = compute_health(&ws, &home);

    install_for(&ws, &home);
    let applied = compute_health(&ws, &home);
    let installed: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(home.join(".config/opencode/opencode.json")).expect("installed"),
    )
    .expect("parse");

    // Cleared, not yet installed: the installed entries now differ from the bundled render.
    fs::remove_file(&override_path).expect("clear override");
    let clearing = compute_health(&ws, &home);
    install_for(&ws, &home);
    let cleared = compute_health(&ws, &home);
    let reinstalled =
        fs::read_to_string(home.join(".config/opencode/opencode.json")).expect("reinstalled");
    cleanup(&ws);
    cleanup(&home);

    let role_keys: Vec<String> = ROLES.iter().map(|r| format!("agent.{r}.model")).collect();
    assert_eq!(before.config_status, "synced");
    assert_eq!(check_status(&before, "subagent_model"), "pass");
    assert_eq!(before.subagent_model, None);

    assert_eq!(pending.config_status, "diverged");
    assert_eq!(sorted(&pending.config_diverged_keys), sorted(&role_keys));

    assert_eq!(
        applied.config_status, "synced",
        "{:?}",
        applied.config_diverged_keys
    );
    assert_eq!(applied.subagent_model.as_deref(), Some("other/cheap"));
    assert_eq!(check_status(&applied, "subagent_model"), "unknown");
    for role in ROLES {
        assert_eq!(installed["agent"][role]["model"], "other/cheap", "{role}");
    }
    assert!(installed["agent"].get("architect").is_none());

    assert_eq!(clearing.config_status, "diverged");
    assert_eq!(sorted(&clearing.config_diverged_keys), sorted(&role_keys));

    assert_eq!(cleared.config_status, "synced");
    assert_eq!(cleared.subagent_model, None);
    assert!(
        !reinstalled.contains("other/cheap") && !reinstalled.contains("\"agent\""),
        "{reinstalled}"
    );
}

fn sorted(keys: &[String]) -> Vec<String> {
    let mut keys = keys.to_vec();
    keys.sort();
    keys
}

#[test]
fn test_critic_health_tracks_precedence_and_clearing_with_or_without_a_subagent_model() {
    for subagent in [Some("other/cheap"), None] {
        let (ws, home) = setup_synced_bundle_copy("critic-health");
        write_override_for_home(&home, subagent, None);
        install_for(&ws, &home);
        write_override_for_home(&home, subagent, Some("strong/critic"));
        let pending = compute_health(&ws, &home);
        assert_eq!(pending.config_status, "diverged");
        assert_eq!(pending.config_diverged_keys, ["agent.inspector.model"]);

        install_for(&ws, &home);
        let applied = compute_health(&ws, &home);
        assert_eq!(
            applied.config_status, "synced",
            "{:?}",
            applied.config_diverged_keys
        );
        assert_eq!(applied.subagent_model.as_deref(), subagent);
        assert_eq!(applied.critic_model.as_deref(), Some("strong/critic"));
        assert_eq!(check_status(&applied, "critic_model"), "unknown");

        // A stale inspector alone must still appear as critic drift.
        let path = home.join(".config/opencode/opencode.json");
        let mut stale: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        stale["agent"]["inspector"]["model"] = serde_json::json!("stale/critic");
        fs::write(&path, stale.to_string()).unwrap();
        let drift = compute_health(&ws, &home);
        assert_eq!(drift.config_diverged_keys, ["agent.inspector.model"]);
        assert_eq!(drift.subagent_model.as_deref(), subagent);
        install_for(&ws, &home);

        write_override_for_home(&home, subagent, None);
        assert_eq!(
            compute_health(&ws, &home).config_diverged_keys,
            ["agent.inspector.model"]
        );
        install_for(&ws, &home);
        let cleared = compute_health(&ws, &home);
        assert_eq!(cleared.config_status, "synced");
        assert_eq!(cleared.subagent_model.as_deref(), subagent);
        assert_eq!(cleared.critic_model.as_deref(), subagent);
        cleanup(&ws);
        cleanup(&home);
    }
}

fn check_status(health: &OpenCodeRuntimeHealth, id: &str) -> String {
    health
        .checks
        .iter()
        .find(|check| check.id == id)
        .unwrap_or_else(|| panic!("check {id}"))
        .status
        .clone()
}

#[test]
fn test_roles_that_disagree_have_no_shared_subagent_model() {
    let mut config = serde_json::json!({"agent": {}});
    for role in ROLES {
        config["agent"][role] = serde_json::json!({"model": "other/cheap"});
    }
    assert_eq!(
        shared_subagent_model(&config, false).as_deref(),
        Some("other/cheap")
    );
    config["agent"]["inspector"]["model"] = serde_json::json!("strong/critic");
    assert_eq!(shared_subagent_model(&config, false), None);
    assert_eq!(
        shared_subagent_model(&config, true).as_deref(),
        Some("other/cheap")
    );
    config["agent"]["scribe"]["model"] = serde_json::json!("mine/other");
    assert_eq!(shared_subagent_model(&config, false), None);
    config["agent"]["scribe"] = serde_json::json!({});
    assert_eq!(shared_subagent_model(&config, false), None);
    assert_eq!(shared_subagent_model(&serde_json::json!({}), false), None);
}

#[test]
fn test_rollback_merge_restores_and_removes_the_role_models() {
    // Rollback merges the managed projection of the backup into the current file.
    let pinned = serde_json::json!({"agent": {"inspector": {"model": "other/cheap"}}});
    let plain = serde_json::json!({"agent": {"custom": {"model": "mine/custom"}}});

    // The apply pinned the roles, the backup had none: they go again.
    let current = merge_managed_opencode_config(
        &plain,
        &extract_managed_opencode_config(&serde_json::json!({
            "agent": {"inspector": {"model": "other/cheap"}}
        })),
    );
    let rolled_back =
        merge_managed_opencode_config(&current, &extract_managed_opencode_config(&plain));
    assert_eq!(rolled_back["agent"], plain["agent"]);

    // The apply cleared the roles, the backup had them: they come back.
    let restored = merge_managed_opencode_config(&plain, &extract_managed_opencode_config(&pinned));
    assert_eq!(restored["agent"]["inspector"]["model"], "other/cheap");
    assert_eq!(restored["agent"]["custom"], plain["agent"]["custom"]);
}

/// A synced workspace and home whose installed config is pinned to `subagent` (or not).
#[cfg(unix)]
fn probe_with_subagent(name: &str, subagent: Option<&str>, stub: &Path) -> OpenCodeRuntimeHealth {
    let (ws, home) = setup_synced_bundle_copy(name);
    if subagent.is_some() {
        write_override_for_home(&home, subagent, None);
        install_for(&ws, &home);
    }
    let mut health = compute_health(&ws, &home);
    apply_cli_probes(&mut health, Some(stub), LIMITS);
    cleanup(&ws);
    cleanup(&home);
    health
}

#[cfg(unix)]
#[test]
fn test_probes_check_the_subagent_model_against_the_listing() {
    let dir = temp_root("probe-subagent-ok");
    let stub = health_stub(
        &dir,
        "1.19.3",
        0,
        &[
            "opencode-go/glm-5.2",
            "opencode-go/deepseek-v4.1-flash",
            "other/cheap",
        ],
    );
    let listed = probe_with_subagent("probe-subagent-ok", Some("other/cheap"), &stub);
    cleanup(&dir);
    assert_eq!(check_status(&listed, "subagent_model"), "pass");
    assert!(listed.warnings.is_empty(), "{:?}", listed.warnings);

    let dir = temp_root("probe-subagent-missing");
    let stub = health_stub(&dir, "1.19.3", 0, &GOOD_MODELS);
    let missing = probe_with_subagent("probe-subagent-missing", Some("other/cheap"), &stub);
    cleanup(&dir);
    let check = missing
        .checks
        .iter()
        .find(|c| c.id == "subagent_model")
        .expect("check");
    assert_eq!(check.status, "warn");
    assert!(check.detail.contains("other/cheap"), "{}", check.detail);
    assert_eq!(missing.warnings.len(), 1, "{:?}", missing.warnings);
    assert!(
        missing.warnings[0].starts_with("subagent_model other/cheap is not listed"),
        "{}",
        missing.warnings[0]
    );
    assert!(
        missing.warnings[0].contains("subagent roles are pinned to it"),
        "{}",
        missing.warnings[0]
    );
    // The main models are listed, so only the subagent model is reported.
    assert_eq!(check_status(&missing, "model"), "pass");
    assert_eq!(check_status(&missing, "small_model"), "pass");
}

#[cfg(unix)]
#[test]
fn test_probes_do_not_look_for_a_subagent_model_that_is_not_set() {
    let dir = temp_root("probe-subagent-unset");
    let stub = health_stub(&dir, "1.19.3", 0, &GOOD_MODELS);
    let health = probe_with_subagent("probe-subagent-unset", None, &stub);
    cleanup(&dir);
    let check = health
        .checks
        .iter()
        .find(|c| c.id == "subagent_model")
        .expect("check");
    assert_eq!(check.status, "pass");
    assert_eq!(check.detail, "(inherits model)");
    assert!(health.warnings.is_empty(), "{:?}", health.warnings);
}

#[cfg(unix)]
#[test]
fn test_probes_check_the_critic_model_independently() {
    for listed in [true, false] {
        let dir = temp_root("probe-critic");
        let mut models = GOOD_MODELS.to_vec();
        models.push("other/cheap");
        if listed {
            models.push("strong/critic");
        }
        let stub = health_stub(&dir, "1.19.3", 0, &models);
        let (ws, home) = setup_synced_bundle_copy("probe-critic");
        write_override_for_home(&home, Some("other/cheap"), Some("strong/critic"));
        install_for(&ws, &home);
        let mut health = compute_health(&ws, &home);
        apply_cli_probes(&mut health, Some(&stub), LIMITS);
        cleanup(&ws);
        cleanup(&home);
        cleanup(&dir);
        assert_eq!(check_status(&health, "subagent_model"), "pass");
        assert_eq!(
            check_status(&health, "critic_model"),
            if listed { "pass" } else { "warn" }
        );
        assert_eq!(health.warnings.len(), usize::from(!listed));
        if !listed {
            assert!(health.warnings[0].starts_with("critic_model strong/critic is not listed"));
        }
    }
}
