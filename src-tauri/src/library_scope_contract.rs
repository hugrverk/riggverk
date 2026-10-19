//! Library scope contract: the Library edits only the user's own text.
//!
//! Bundled items (docs, rules template, skills, agents, config sources) are read-only in the app; the
//! maintainer changes them in the bundle and ships an update. This module pins the command surface the
//! webview can call, so a new write or open command cannot slip in without editing an allowlist here.
//! The behaviour behind the Library writes is pinned next to the code: every bundled doc id is refused
//! by `save_doc` and the personal docs folder is never bundled (`commands/content.rs`), and
//! `save_rules_refinements` changes only the text after the END line of an enabled harness's rules
//! file (`commands/rules_refinements.rs`).

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    const LIB_RS: &str = include_str!("lib.rs");

    /// Prefixes of commands that only read. Every other command is in one of the lists below.
    const READ_PREFIXES: [&str; 4] = ["get_", "list_", "read_", "preview_"];

    /// Every command that changes a file or a setting. Only `save_doc`, `create_doc` and
    /// `save_rules_refinements` take Library text: the first two write personal docs
    /// (`docs/context/<slug>.md`) only, the last only the text below the managed block of a rules
    /// file. The others are install, conflict, rules-conversion, settings and workspace-choice
    /// actions that never take Library text.
    const WRITE_COMMANDS: [&str; 15] = [
        "save_doc",
        "create_doc",
        "save_rules_refinements",
        "apply_setup",
        "apply_uninstall",
        "rollback_setup_transaction",
        "apply_rules_conversion",
        "set_rules_user_managed",
        "set_files_kept",
        "apply_take_bundled",
        "update_settings",
        "update_opencode_model_selection",
        "reset_opencode_model_selection",
        "try_set_active_workspace_path",
        "reset_active_workspace_path",
    ];

    /// Commands that hand a path to the OS. `open_doc` opens personal docs only, `open_rules_file` the
    /// rules file of an enabled harness; the others open folders.
    const OPEN_COMMANDS: [&str; 4] = [
        "open_doc",
        "open_rules_file",
        "open_backups_folder",
        "open_default_workspace_folder",
    ];

    /// Commands that existed to edit or open bundled items. They were deleted, not disabled.
    const REMOVED_COMMANDS: [&str; 8] = [
        "save_agent_template",
        "save_agent_source",
        "save_opencode_config_source",
        "open_agent_template",
        "open_agent_source",
        "open_config_template",
        "open_opencode_config_source",
        "open_skill",
    ];

    /// The command names registered with `tauri::generate_handler!` in `lib.rs`.
    fn registered_commands() -> BTreeSet<&'static str> {
        let start = LIB_RS
            .find("generate_handler![")
            .expect("lib.rs registers its commands with generate_handler!")
            + "generate_handler![".len();
        let end = start + LIB_RS[start..].find(']').expect("handler list ends");
        let names: BTreeSet<&str> = LIB_RS[start..end]
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        assert!(names.len() > 20, "handler list parsed: {names:?}");
        names
    }

    fn set(names: &[&'static str]) -> BTreeSet<&'static str> {
        names.iter().copied().collect()
    }

    #[test]
    fn every_command_that_is_not_a_read_is_allowlisted() {
        let unlisted: BTreeSet<&str> = registered_commands()
            .into_iter()
            .filter(|name| !READ_PREFIXES.iter().any(|prefix| name.starts_with(prefix)))
            .collect();
        let allowlisted: BTreeSet<&str> = set(&WRITE_COMMANDS)
            .union(&set(&OPEN_COMMANDS))
            .copied()
            .collect();
        assert_eq!(
            unlisted, allowlisted,
            "a new command that is not a get_/list_/read_/preview_ read must be added to an allowlist \
             (and must not let the Library write a bundled item)"
        );
    }

    #[test]
    fn the_only_library_writes_are_personal_doc_and_rules_refinement_writes() {
        let library_writes: BTreeSet<&str> = registered_commands()
            .into_iter()
            .filter(|name| {
                ["save_", "create_", "write_"]
                    .iter()
                    .any(|p| name.starts_with(p))
            })
            .collect();
        assert_eq!(
            library_writes,
            set(&["save_doc", "create_doc", "save_rules_refinements"])
        );
    }

    #[test]
    fn open_commands_are_exactly_the_allowlist() {
        let opens: BTreeSet<&str> = registered_commands()
            .into_iter()
            .filter(|name| name.starts_with("open_"))
            .collect();
        assert_eq!(opens, set(&OPEN_COMMANDS));
    }

    #[test]
    fn removed_bundled_item_commands_stay_removed() {
        let registered = registered_commands();
        for name in REMOVED_COMMANDS {
            assert!(!registered.contains(name), "{name} must stay deleted");
            assert!(
                !LIB_RS.contains(name),
                "{name} must not be imported or registered"
            );
        }
    }
}
