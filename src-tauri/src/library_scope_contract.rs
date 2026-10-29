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

    /// Every command that changes a file or a setting. Library text writes personal docs
    /// (`docs/context/<slug>.md`), personal pack skills, or the text below a rules managed block.
    /// The others are install, conflict, rules-conversion, settings and workspace-reset
    /// actions that never take Library text. `forget_pack` edits `pack-skills.json` only.
    /// `copy_skill_to_pack` and `save_pack_skill` write only inside `<data>/packs/personal/`.
    const WRITE_COMMANDS: [&str; 19] = [
        "save_doc",
        "create_doc",
        "save_rules_refinements",
        "copy_skill_to_pack",
        "save_pack_skill",
        "apply_setup",
        "apply_uninstall",
        "rollback_setup_transaction",
        "apply_rules_conversion",
        "set_rules_user_managed",
        "set_files_kept",
        "set_codex_config_kept",
        "apply_codex_config_defaults",
        "forget_pack",
        "apply_take_bundled",
        "update_settings",
        "update_opencode_model_selection",
        "reset_opencode_model_selection",
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

    /// Commands that existed to edit or open bundled items, or to choose another workspace folder.
    /// They were deleted, not disabled: the webview cannot call them.
    const REMOVED_COMMANDS: [&str; 9] = [
        "save_agent_template",
        "save_agent_source",
        "save_opencode_config_source",
        "open_agent_template",
        "open_agent_source",
        "open_config_template",
        "open_opencode_config_source",
        "open_skill",
        // The app keeps the workspace folder it has: a saved custom folder is honored, a new one
        // cannot be chosen. `reset_active_workspace_path` is the only path setting left.
        "try_set_active_workspace_path",
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
    fn the_only_library_writes_are_personal_docs_pack_skills_and_rules_refinements() {
        let library_writes: BTreeSet<&str> = registered_commands()
            .into_iter()
            .filter(|name| {
                ["save_", "create_", "write_", "copy_"]
                    .iter()
                    .any(|p| name.starts_with(p))
            })
            .collect();
        assert_eq!(
            library_writes,
            set(&[
                "save_doc",
                "create_doc",
                "save_rules_refinements",
                "copy_skill_to_pack",
                "save_pack_skill",
            ])
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
    fn removed_commands_stay_removed() {
        let registered = registered_commands();
        for name in REMOVED_COMMANDS {
            assert!(!registered.contains(name), "{name} must stay deleted");
            assert!(
                !LIB_RS.contains(name),
                "{name} must not be imported or registered"
            );
        }
    }

    #[test]
    fn the_docs_health_command_stays_removed() {
        // The bundle cannot miss a doc, so there is no "docs need update" state to report.
        assert!(!registered_commands().contains("get_docs_health"));
        assert!(!LIB_RS.contains("get_docs_health"));
    }
}

/// Mirror independence: every Library read of a bundled item comes from the app's bundle. The folder the
/// app keeps for its own state may still hold copies of bundle files from an older version, edited or not;
/// no Library read looks at them. Only the personal docs (`docs/context`) come from that folder.
#[cfg(test)]
mod mirror_independence {
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde::Serialize;

    use crate::commands::{
        list_agent_metadata, list_docs, list_skills, read_agent_source, read_agent_template,
        read_config_template, read_doc, read_opencode_config_source, read_skill,
    };
    use crate::test_env::{guard, set_test_user_dirs, source_skill_count};

    const EDITED: &str = "EDITED-COPY-THE-LIBRARY-MUST-NOT-SHOW";
    const AGENT_FILES: [&str; 6] = [
        "architect.md",
        "repo-scout.md",
        "inspector.md",
        "sentinel.md",
        "scribe.md",
        "verifier.md",
    ];

    fn bundle() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace")
    }

    /// What one Library read showed: which read, the path it showed, the text it showed.
    type Shown = (String, String, String);

    /// Everything the Library shows of the bundle, plus the listings that name it.
    struct Reads {
        shown: Vec<Shown>,
        listings: String,
        personal_ids: Vec<String>,
    }

    fn json(value: impl Serialize) -> serde_json::Value {
        serde_json::to_value(value).expect("serializable")
    }

    /// The `path` and `content` fields every Library read of a bundled item returns.
    fn shown(what: &str, item: impl Serialize) -> Shown {
        let item = json(item);
        let field = |name: &str| item[name].as_str().expect("text field").to_string();
        (what.to_string(), field("path"), field("content"))
    }

    fn library_reads() -> Reads {
        let docs = json(list_docs().expect("the docs list needs no workspace copy"));
        let docs = docs.as_array().expect("docs array").clone();
        let (personal, curated): (Vec<_>, Vec<_>) =
            docs.iter().partition(|doc| doc["source"] == "custom");
        let mut shown_by_library = Vec::new();
        for doc in &curated {
            let id = doc["id"].as_str().expect("doc id");
            let read = read_doc(id.to_string()).expect("bundled doc");
            shown_by_library.push(shown(&format!("doc:{id}"), read));
        }
        shown_by_library.push(shown(
            "agent-template",
            read_agent_template().expect("rules template"),
        ));
        shown_by_library.push(shown(
            "config-template",
            read_config_template("opencode_config".into()).expect("config template"),
        ));
        for source in ["base", "policy", "snapshot"] {
            let read = read_opencode_config_source(source.into()).expect("opencode source");
            shown_by_library.push(shown(&format!("opencode-source:{source}"), read));
        }
        let metadata = list_agent_metadata().expect("agent list");
        assert!(
            metadata.warnings.is_empty(),
            "the bundle has no agent metadata problem: {:?}",
            metadata.warnings
        );
        assert!(metadata.agents.iter().all(|agent| agent.exists));
        for filename in AGENT_FILES {
            let agent = read_agent_source(filename.into()).expect("agent source");
            shown_by_library.push(shown(&format!("agent:{filename}"), agent));
        }
        let skills = list_skills().expect("skills list");
        assert_eq!(
            skills.len(),
            source_skill_count(),
            "the Library lists every bundled skill"
        );
        for skill in &skills {
            let read = read_skill(skill.id.clone()).expect("bundled skill");
            shown_by_library.push(shown(&format!("skill:{}", skill.id), read));
        }
        let listings = json((&curated, json(&skills), json(&metadata))).to_string();
        Reads {
            shown: shown_by_library,
            listings,
            personal_ids: personal
                .iter()
                .map(|doc| doc["id"].as_str().expect("doc id").to_string())
                .collect(),
        }
    }

    /// Process environment of one test: a private home and workspace path, restored afterwards.
    struct Folder {
        base: PathBuf,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Folder {
        fn new() -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-library-mirror-{nanos}"));
            fs::create_dir_all(base.join("home")).expect("home");
            set_test_user_dirs(&base.join("home"));
            unsafe {
                std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
            }
            Self {
                base,
                _restore: restore,
                _lock: lock,
            }
        }

        /// Points the app at `data` as its workspace folder.
        fn use_folder(&self, data: &Path) {
            unsafe {
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", data);
            }
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    /// A copy of every bundle file under `dst`, each one edited to the same marker text.
    fn write_edited_copy(src: &Path, dst: &Path) {
        fs::create_dir_all(dst).expect("copy dir");
        for entry in fs::read_dir(src).expect("read bundle").flatten() {
            let path = entry.path();
            let target = dst.join(entry.file_name());
            if path.is_dir() {
                write_edited_copy(&path, &target);
            } else {
                fs::write(&target, EDITED).expect("edited file");
            }
        }
    }

    fn write_personal_doc(data: &Path) {
        fs::create_dir_all(data.join("docs/context")).expect("context dir");
        fs::write(data.join("docs/context/notes.md"), "# Notes\n").expect("personal doc");
    }

    fn assert_is_the_bundle(reads: &Reads) {
        let bundle = bundle();
        assert!(reads.shown.len() > 40, "the Library shows the whole bundle");
        for (what, path, content) in &reads.shown {
            assert!(
                Path::new(path).is_relative(),
                "{what} shows a path inside the bundle, not {path}"
            );
            let bundled = fs::read_to_string(bundle.join(path))
                .unwrap_or_else(|error| panic!("{what}: {path} is not in the bundle: {error}"));
            assert_eq!(content, &bundled, "{what} shows the bundle's {path}");
            assert!(!content.contains(EDITED), "{what} shows an edited copy");
        }
    }

    #[test]
    fn library_reads_of_bundled_items_ignore_the_workspace_copy() {
        let env = Folder::new();

        // No workspace folder at all: the bundled items are all there, and no personal doc.
        env.use_folder(&env.base.join("absent"));
        let alone = library_reads();
        assert_is_the_bundle(&alone);
        assert!(alone.personal_ids.is_empty());
        assert!(read_doc("custom:notes".into()).is_err());

        // A folder with next to nothing of the bundle shows the same bundle.
        let partial = env.base.join("partial");
        fs::create_dir_all(partial.join("skills")).expect("partial folder");
        env.use_folder(&partial);
        let partial_reads = library_reads();
        assert_eq!(partial_reads.shown, alone.shown);
        assert_eq!(partial_reads.listings, alone.listings);

        // A copy of every bundle file, all edited, in a folder that still counts as a workspace: the
        // Library shows the bundle again, and the personal doc beside it.
        let edited = env.base.join("edited");
        write_edited_copy(&bundle(), &edited);
        fs::create_dir_all(edited.join("skills/only-in-the-copy")).expect("extra skill dir");
        fs::write(edited.join("skills/only-in-the-copy/SKILL.md"), EDITED).expect("extra skill");
        write_personal_doc(&edited);
        env.use_folder(&edited);
        let edited_reads = library_reads();
        assert_eq!(edited_reads.shown, alone.shown);
        assert_eq!(edited_reads.listings, alone.listings);
        assert_eq!(edited_reads.personal_ids, vec!["custom:notes".to_string()]);
        let notes = read_doc("custom:notes".into()).expect("personal doc");
        assert_eq!(notes.content, "# Notes\n");
    }
}
