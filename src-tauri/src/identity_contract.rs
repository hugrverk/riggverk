//! Product identity contract.
//!
//! The product is named Riggverk. Technical identifiers that live in users'
//! files, environments, or data directories keep their historical
//! `agent-workspace` names on purpose, because renaming them would orphan or
//! conflict with data that already exists. This module pins both sides so a
//! later rename cannot move either one by accident.

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use crate::managed_state::MANAGED_STATE_REL;
    use crate::platform_paths::{
        app_support_dir, default_installed_workspace_path, Platform, PlatformEnv,
    };
    use crate::rules_block::{
        assess, body_digest, parse, RulesLayout, RulesPlan, BEGIN_MARKER, BEGIN_PREFIX, END_MARKER,
    };
    use crate::rules_preferences::RULES_PREFERENCES_REL;

    const TAURI_CONF: &str = include_str!("../tauri.conf.json");
    const PACKAGE_JSON: &str = include_str!("../../package.json");
    const INDEX_HTML: &str = include_str!("../../index.html");
    const BUNDLED_MARKER: &str =
        include_str!("../../resources/default-workspace/.agent-workspace/workspace.json");

    const IDENTIFIER: &str = "se.hugrverk.riggverk";
    const APP_DATA_DIR_NAME: &str = "ai.agentworkspace.app";

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("valid JSON")
    }

    #[test]
    fn tauri_config_names_the_app_riggverk() {
        let conf = json(TAURI_CONF);
        assert_eq!(conf["productName"], "Riggverk");
        assert_eq!(conf["identifier"], IDENTIFIER);
        assert_eq!(conf["app"]["windows"][0]["title"], "Riggverk");
    }

    #[test]
    fn crate_and_frontend_are_named_riggverk() {
        assert_eq!(env!("CARGO_PKG_NAME"), "riggverk");
        assert_eq!(env!("CARGO_CRATE_NAME"), "riggverk_lib");
        assert_eq!(json(PACKAGE_JSON)["name"], "riggverk");
        assert!(INDEX_HTML.contains("<title>Riggverk</title>"));
    }

    // The data directory name is deliberately independent of the bundle
    // identifier. If this fails after an identifier or product rename, the
    // rename moved where settings and backups live: that needs its own
    // migration and must not happen as a side effect.
    #[test]
    fn app_data_dir_name_is_independent_of_the_identifier() {
        let envs = [
            (
                Platform::MacOS,
                PlatformEnv {
                    home: Some("/Users/example".into()),
                    ..PlatformEnv::default()
                },
            ),
            (
                Platform::Linux,
                PlatformEnv {
                    home: Some("/home/example".into()),
                    ..PlatformEnv::default()
                },
            ),
            (
                Platform::Linux,
                PlatformEnv {
                    home: Some("/home/example".into()),
                    xdg_config_home: Some("/custom/config".into()),
                    ..PlatformEnv::default()
                },
            ),
            (
                Platform::Windows,
                PlatformEnv {
                    userprofile: Some(r"C:\Users\Example".into()),
                    appdata: Some(r"C:\Users\Example\AppData\Roaming".into()),
                    ..PlatformEnv::default()
                },
            ),
        ];
        for (platform, env) in envs {
            let dir = app_support_dir(&env, platform).expect("app support dir");
            let name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .expect("dir name")
                .to_string();
            assert_eq!(name, APP_DATA_DIR_NAME, "{platform:?}");
            assert_ne!(name, IDENTIFIER, "{platform:?}");
        }
    }

    #[test]
    fn stable_technical_identifiers_keep_their_historical_names() {
        assert_eq!(BEGIN_PREFIX, "<!-- BEGIN AGENT-WORKSPACE BASE");
        assert_eq!(END_MARKER, "<!-- END AGENT-WORKSPACE BASE -->");
        assert!(BEGIN_MARKER.starts_with(BEGIN_PREFIX));
        assert!(BEGIN_MARKER.ends_with("-->"));
        assert_eq!(MANAGED_STATE_REL, ".agent-workspace/managed-state.json");
        assert_eq!(
            RULES_PREFERENCES_REL,
            ".agent-workspace/rules-preferences.json"
        );

        let marker_paths: Vec<&str> = crate::commands::default_workspace_files()
            .into_iter()
            .filter(|(label, _)| *label == "Marker")
            .flat_map(|(_, paths)| paths.iter().copied())
            .collect();
        assert_eq!(marker_paths, [".agent-workspace/workspace.json"]);

        // Unread by the app, but the file is digest-tracked: a change would turn
        // every installed marker into a conflict.
        let marker = json(BUNDLED_MARKER);
        assert_eq!(marker["workspace_type"], "agent-workspace");
        assert_eq!(marker["managed_by"], "agent-workspace-app");

        let home = PlatformEnv {
            home: Some("/Users/example".into()),
            ..PlatformEnv::default()
        };
        assert!(default_installed_workspace_path(&home, Platform::MacOS)
            .expect("default workspace")
            .ends_with(".config/agent-workspace"));
    }

    #[test]
    fn a_begin_line_with_the_old_prose_is_still_this_apps_block() {
        const OLD_BEGIN: &str = "<!-- BEGIN AGENT-WORKSPACE BASE: managed by Agent Workspace; edits inside are replaced on update; add refinements below END -->";
        const BASE: &str = "# Base\n\n- one\n";
        const NEWER_BASE: &str = "# Base\n\n- one\n- two\n";
        assert_ne!(OLD_BEGIN, BEGIN_MARKER);

        let installed = format!("mine\n{OLD_BEGIN}\n{BASE}{END_MARKER}\ntail\n");
        let never = |_: &str| false;

        // Same base body: the old prose is not a reason to rewrite the file.
        let same = assess(Some(installed.as_bytes()), BASE, None, &never);
        assert_eq!(same.layout, RulesLayout::Block);
        assert_eq!(same.plan, RulesPlan::NoChange);
        assert_eq!(same.refinement_lines, 2);

        // A newer base: the block updates, user text stays, and the BEGIN line
        // is rewritten to the current prose.
        let managed = body_digest(BASE);
        let update = assess(
            Some(installed.as_bytes()),
            NEWER_BASE,
            Some(&managed),
            &never,
        );
        assert_eq!(update.plan, RulesPlan::UpdateBlock);
        let file = parse(&installed).expect("parses").expect("has a block");
        assert_eq!(
            file.render_with_body(NEWER_BASE),
            format!("mine\n{BEGIN_MARKER}\n{NEWER_BASE}{END_MARKER}\ntail\n")
        );
    }
}
