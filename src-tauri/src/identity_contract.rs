//! Product identity contract.
//!
//! The product is named Riggverk, and so are the technical identifiers that live in users' files
//! and environments: the data folder, the state folder inside it, the rules markers, the
//! environment variables and the macOS icon. The names from before the rename survive only as
//! `LEGACY_*` constants, so that installs made under them are still found and carried over (see
//! `workspace_layout`, `rules_block` and `env_overrides`; `legacy_layout_contract` proves the
//! upgrade). The app data directory is named like the bundle identifier and moved there once by
//! `app_data_migration`; the old name is pinned only so that migration keeps finding it. This
//! module pins all of it so a later rename cannot move any of it by accident.

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use crate::env_overrides::{LEGACY_BACKUP_DIR_ENV, LEGACY_WORKSPACE_PATH_ENV};
    use crate::kept_files::KEPT_FILES_FILE;
    use crate::managed_state::{LEGACY_MANAGED_STATE_REL, MANAGED_STATE_REL};
    use crate::platform_paths::{
        app_support_dir, default_installed_workspace_path, legacy_app_support_dir,
        legacy_default_installed_workspace_path, Platform, PlatformEnv, APP_DATA_DIR_NAME,
        DEFAULT_WORKSPACE_DIR_NAME, LEGACY_APP_DATA_DIR_NAME, LEGACY_WORKSPACE_DIR_NAME,
    };
    use crate::rules_block::{
        assess, body_digest, parse, RulesLayout, RulesPlan, BEGIN_MARKER, BEGIN_PREFIX, END_MARKER,
        LEGACY_BEGIN_PREFIX, LEGACY_END_MARKER,
    };
    use crate::rules_preferences::RULES_PREFERENCES_FILE;
    use crate::workspace_layout::{LEGACY_STATE_DIR, STATE_DIR};

    const TAURI_CONF: &str = include_str!("../tauri.conf.json");
    const PACKAGE_JSON: &str = include_str!("../../package.json");
    const INDEX_HTML: &str = include_str!("../../index.html");
    const LEGACY_BUNDLED_MARKER: &str =
        include_str!("../../resources/default-workspace/.agent-workspace/workspace.json");
    const LEGACY_MARKER_TYPE: &str = "agent-workspace";
    const LEGACY_MARKER_OWNER: &str = "agent-workspace-app";

    const IDENTIFIER: &str = "se.hugrverk.riggverk";

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

    fn platform_envs() -> [(Platform, PlatformEnv); 4] {
        [
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
        ]
    }

    fn last_component(path: &std::path::Path) -> String {
        path.file_name()
            .and_then(|name| name.to_str())
            .expect("dir name")
            .to_string()
    }

    // The data directory is named like the bundle identifier (the Tauri
    // `appConfigDir` convention) but through a constant, never read from the
    // config at runtime. If this fails after an identifier change, the change
    // would move where settings and backups live: that needs its own
    // migration (see `app_data_migration`) and must not happen as a side effect.
    #[test]
    fn app_data_dir_is_named_like_the_identifier() {
        assert_eq!(APP_DATA_DIR_NAME, IDENTIFIER);
        assert_eq!(json(TAURI_CONF)["identifier"], APP_DATA_DIR_NAME);
        for (platform, env) in platform_envs() {
            let dir = app_support_dir(&env, platform).expect("app support dir");
            assert_eq!(last_component(&dir), IDENTIFIER, "{platform:?}");
        }
    }

    // The previous data directory name. Only `app_data_migration` reads it, to
    // move an existing directory; changing it would strand that data.
    #[test]
    fn legacy_app_data_dir_name_stays_pinned() {
        assert_eq!(LEGACY_APP_DATA_DIR_NAME, "ai.agentworkspace.app");
        for (platform, env) in platform_envs() {
            let legacy = legacy_app_support_dir(&env, platform).expect("legacy dir");
            let current = app_support_dir(&env, platform).expect("current dir");
            assert_eq!(
                last_component(&legacy),
                "ai.agentworkspace.app",
                "{platform:?}"
            );
            assert_eq!(legacy.parent(), current.parent(), "{platform:?}");
            assert_ne!(legacy, current, "{platform:?}");
        }
    }

    #[test]
    fn technical_identifiers_are_named_riggverk() {
        assert_eq!(BEGIN_PREFIX, "<!-- BEGIN RIGGVERK BASE");
        assert_eq!(END_MARKER, "<!-- END RIGGVERK BASE -->");
        assert!(BEGIN_MARKER.starts_with(BEGIN_PREFIX));
        assert!(BEGIN_MARKER.ends_with("-->"));
        assert_eq!(STATE_DIR, ".riggverk");
        assert_eq!(MANAGED_STATE_REL, ".riggverk/managed-state.json");
        assert_eq!(RULES_PREFERENCES_FILE, "rules-preferences.json");
        assert_eq!(KEPT_FILES_FILE, "kept-files.json");
        assert_eq!(
            crate::config_preferences::CONFIG_PREFERENCES_FILE,
            "config-preferences.json"
        );

        use crate::env_overrides::{BACKUP_DIR_ENV, WORKSPACE_PATH_ENV};
        assert_eq!(WORKSPACE_PATH_ENV, "RIGGVERK_WORKSPACE_PATH");
        assert_eq!(BACKUP_DIR_ENV, "RIGGVERK_BACKUP_DIR");

        assert_eq!(DEFAULT_WORKSPACE_DIR_NAME, "riggverk");
        let home = PlatformEnv {
            home: Some("/Users/example".into()),
            ..PlatformEnv::default()
        };
        assert!(default_installed_workspace_path(&home, Platform::MacOS)
            .expect("default workspace")
            .ends_with(".config/riggverk"));
    }

    // The earlier names are read, never written. Each is pinned: changing one would strand an
    // install made under it.
    #[test]
    fn the_earlier_identifiers_stay_pinned_for_reading() {
        assert_eq!(LEGACY_BEGIN_PREFIX, "<!-- BEGIN AGENT-WORKSPACE BASE");
        assert_eq!(LEGACY_END_MARKER, "<!-- END AGENT-WORKSPACE BASE -->");
        assert_eq!(LEGACY_STATE_DIR, ".agent-workspace");
        assert_eq!(
            LEGACY_MANAGED_STATE_REL,
            ".agent-workspace/managed-state.json"
        );
        assert_eq!(LEGACY_WORKSPACE_DIR_NAME, "agent-workspace");
        assert_eq!(LEGACY_WORKSPACE_PATH_ENV, "AGENT_WORKSPACE_PATH");
        assert_eq!(LEGACY_BACKUP_DIR_ENV, "AGENT_WORKSPACE_BACKUP_DIR");

        use crate::commands::retired_workspace_files::{
            workspace_copy_paths, LEGACY_MARKER_REL, RETIRED_WORKSPACE_FILES,
        };
        assert_eq!(LEGACY_MARKER_REL, ".agent-workspace/workspace.json");
        assert_eq!(workspace_copy_paths().next(), Some(LEGACY_MARKER_REL));
        assert!(RETIRED_WORKSPACE_FILES
            .iter()
            .all(|rel| !rel.starts_with(LEGACY_STATE_DIR)));

        // Unread by the app, but the file is digest-tracked: a change would turn every installed
        // marker into a conflict. The app does not install it any more and ships no new one.
        let marker = json(LEGACY_BUNDLED_MARKER);
        assert_eq!(marker["workspace_type"], LEGACY_MARKER_TYPE);
        assert_eq!(marker["managed_by"], LEGACY_MARKER_OWNER);

        let home = PlatformEnv {
            home: Some("/Users/example".into()),
            ..PlatformEnv::default()
        };
        assert!(
            legacy_default_installed_workspace_path(&home, Platform::MacOS)
                .expect("earlier default workspace")
                .ends_with(".config/agent-workspace")
        );
    }

    #[test]
    fn a_begin_line_with_the_old_prose_is_still_this_apps_block() {
        const LEGACY_OLD_PROSE_BEGIN: &str = "<!-- BEGIN AGENT-WORKSPACE BASE: managed by Agent Workspace; edits inside are replaced on update; add refinements below END -->";
        const BASE: &str = "# Base\n\n- one\n";
        const NEWER_BASE: &str = "# Base\n\n- one\n- two\n";
        assert_ne!(LEGACY_OLD_PROSE_BEGIN, BEGIN_MARKER);

        let installed =
            format!("mine\n{LEGACY_OLD_PROSE_BEGIN}\n{BASE}{LEGACY_END_MARKER}\ntail\n");
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
