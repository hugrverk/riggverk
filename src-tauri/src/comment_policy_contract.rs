//! Contract tests for the comment policy: the `## Code comments` section the user's level adds to
//! the managed rules block (see `comment_policy`).
//!
//! They install into a temp HOME and data folder with the real bundle, through the real preview,
//! apply, diff, conversion, rollback and uninstall commands, and never touch the real profile.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;

    use crate::agent_targets::HarnessId;
    use crate::artifact_registry::ArtifactId;
    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, rollback_setup_transaction,
        SetupResult,
    };
    use crate::commands::{
        apply_rules_conversion, get_comment_policy, preview_rules_conversion, preview_rules_diff,
        set_comment_policy,
    };
    use crate::comment_policy::{CommentPolicy, FOREIGN, SECTION_HEADING, UNUSABLE};
    use crate::light_harness::LightHarnessId;
    use crate::pack_routing::{health_rules_synced, rules_source_text, PackRouting};
    use crate::rules_block::{body_digest, render_new, RulesPlan};
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::plan_artifacts_for_surfaces;
    use crate::skill_sources::{SkillSources, SourceRoot};
    use crate::test_env::{canonical_skill_text, guard, guard::EnvRestore, set_test_user_dirs};

    const LEVELS: [CommentPolicy; 2] = [CommentPolicy::Minimal, CommentPolicy::Off];
    const CURSOR_USER_RULES: &str = "templates/cursor/user-rules.md";

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[cfg(not(unix))]
    fn set_mode(_path: &Path, _mode: u32) {}

    /// Every file below `dir` as `/`-separated relative path and bytes; empty when `dir` is gone.
    fn files_below(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, prefix: &str, out: &mut BTreeMap<String, Vec<u8>>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries {
                let entry = entry.expect("entry");
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = format!("{prefix}{name}");
                if entry.file_type().expect("file type").is_dir() {
                    walk(&entry.path(), &format!("{rel}/"), out);
                } else {
                    out.insert(rel, fs::read(entry.path()).expect("read file"));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, "", &mut out);
        out
    }

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        // Drop order matters: the environment goes before the lock.
        _isolated: EnvRestore,
        _restore: EnvRestore,
        _guard: MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let guard = guard::lock();
            let restore = EnvRestore::capture();
            let isolated = guard::isolate_data_location_env();
            for key in [
                "CODEX_HOME",
                "CODEX_SKILLS_PATH",
                "CURSOR_SKILLS_PATH",
                "OPENCODE_SKILLS_PATH",
                "CLAUDE_SKILLS_PATH",
            ] {
                unsafe { std::env::remove_var(key) };
            }
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-comment-policy-{label}-{nanos}"));
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("runtime")).expect("runtime");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("runtime").canonicalize().expect("runtime");
            unsafe {
                std::env::set_var("RIGGVERK_WORKSPACE_PATH", &ws);
                std::env::set_var("RIGGVERK_BACKUP_DIR", base.join("backups"));
            }
            let home = crate::platform_paths::resolve_user_home(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("resolved home");
            Self {
                base,
                home,
                ws,
                _isolated: isolated,
                _restore: restore,
                _guard: guard,
            }
        }

        fn policy_file(&self) -> PathBuf {
            crate::workspace_layout::state_file(
                &self.ws,
                crate::comment_policy::COMMENT_POLICY_FILE,
            )
        }

        fn choose(&self, level: CommentPolicy) {
            set_comment_policy(level).expect("set comment policy");
        }

        fn sources(&self) -> SkillSources {
            SkillSources::for_workspace(&self.ws).expect("sources")
        }

        fn claude_file(&self) -> PathBuf {
            self.home.join(".claude/CLAUDE.md")
        }

        fn read_claude(&self) -> String {
            fs::read_to_string(self.claude_file()).expect("CLAUDE.md")
        }

        fn plan(&self, surface: SetupSurfaceId) -> crate::setup_transaction::PlannedArtifact {
            plan_artifacts_for_surfaces(&[surface], &self.ws, &self.home)
                .expect("plan")
                .into_iter()
                .next()
                .expect("planned artifact")
        }

        fn apply(&self, surfaces: &[&str]) -> SetupResult {
            let surfaces: Vec<String> = surfaces.iter().map(|s| s.to_string()).collect();
            let plan = preview_setup(surfaces.clone()).expect("preview");
            let result = apply_setup(surfaces, true, plan.plan_fingerprint, plan.preview_token)
                .expect("apply");
            assert!(result.success, "apply: {}", result.message);
            result
        }

        fn synced(&self) -> bool {
            health_rules_synced(
                &ArtifactId::ClaudeRules,
                &self.claude_file(),
                &bundle(),
                Some(&self.ws),
            )
        }

        /// The data folder and the home folder, every file but the app's mutation lock (an empty
        /// file a command creates to wait on a running apply).
        fn snapshot(&self) -> (BTreeMap<String, Vec<u8>>, BTreeMap<String, Vec<u8>>) {
            let mut home = files_below(&self.home);
            home.retain(|path, _| !path.ends_with("/mutation.lock"));
            (files_below(&self.ws), home)
        }

        /// A pack the way a user clones one: owner-writable only.
        fn pack(&self, pack: &str, skills: &[&str], routing: &str) {
            let dir = self.ws.join("packs").join(pack);
            for skill in skills {
                let skill_dir = dir.join("skills").join(skill);
                fs::create_dir_all(&skill_dir).expect("skill dir");
                fs::write(skill_dir.join("SKILL.md"), canonical_skill_text(skill, "x"))
                    .expect("SKILL.md");
                set_mode(&skill_dir, 0o755);
                set_mode(&skill_dir.join("SKILL.md"), 0o644);
            }
            for folder in [self.ws.join("packs"), dir.clone(), dir.join("skills")] {
                set_mode(&folder, 0o755);
            }
            fs::write(dir.join("routing.md"), routing).expect("routing.md");
            set_mode(&dir.join("routing.md"), 0o644);
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn bundle() -> PathBuf {
        crate::setup_roots::bundled_root().expect("bundled root")
    }

    /// Every rules artifact Install writes: the three full harnesses and the light tier's.
    fn rules_artifacts() -> Vec<ArtifactId> {
        let mut artifacts = vec![
            ArtifactId::ClaudeRules,
            ArtifactId::CodexRules,
            ArtifactId::OpenCodeRules,
        ];
        for harness in [
            HarnessId::Copilot,
            HarnessId::Pi,
            HarnessId::Kilo,
            HarnessId::Antigravity,
        ] {
            artifacts.push(ArtifactId::HarnessRules(
                LightHarnessId::new(harness).expect("light harness"),
            ));
        }
        artifacts
    }

    fn bundled_text(artifact: &ArtifactId) -> String {
        let source = artifact.resolve_bundle_source(&bundle()).expect("source");
        fs::read_to_string(source).expect("bundled rules")
    }

    fn bundled_cursor_rules() -> String {
        fs::read_to_string(bundle().join(CURSOR_USER_RULES)).expect("bundled cursor rules")
    }

    fn bundled_template() -> String {
        fs::read_to_string(bundle().join("templates/global-agent-rules.md")).expect("template")
    }

    fn cursor_rules() -> Result<String, String> {
        crate::commands::read_doc(CURSOR_USER_RULES.into()).map(|doc| doc.content)
    }

    fn library_template() -> Result<String, String> {
        crate::commands::read_agent_template().map(|doc| doc.content)
    }

    /// `text` with `level`'s section where it belongs: right after the `## Scope` section, which
    /// every bundled rules text has, and before the heading that follows it.
    fn with_section_after_scope(text: &str, level: CommentPolicy) -> String {
        let scope = text.find("\n## Scope\n").expect("a ## Scope section") + 1;
        let next = text[scope + 1..]
            .find("\n## ")
            .expect("a section after Scope")
            + scope
            + 2;
        format!("{}{}\n{}", &text[..next], level.section(), &text[next..])
    }

    // ── Harness default: nothing changes ──

    #[test]
    fn harness_default_leaves_every_rules_target_byte_for_byte_and_writes_nothing() {
        let env = Env::new("default");
        let check = |label: &str| {
            let sources = env.sources();
            assert_eq!(
                sources.comment_policy(),
                Ok(CommentPolicy::HarnessDefault),
                "{label}"
            );
            for artifact in rules_artifacts() {
                assert_eq!(
                    rules_source_text(&artifact, &sources).expect("source"),
                    bundled_text(&artifact),
                    "{label}: {artifact:?}"
                );
                assert_eq!(
                    crate::setup_fingerprint::artifact_source_digest(
                        &artifact, &sources, &env.home
                    )
                    .expect("digest"),
                    body_digest(&bundled_text(&artifact)),
                    "{label}: {artifact:?}"
                );
            }
            assert_eq!(cursor_rules(), Ok(bundled_cursor_rules()), "{label}");
            assert_eq!(library_template(), Ok(bundled_template()), "{label}");
            let choice = get_comment_policy().expect("get");
            assert_eq!(
                (choice.level, choice.problem),
                (Some(CommentPolicy::HarnessDefault), None),
                "{label}"
            );
        };
        check("no file");

        // Choosing harness default with no file writes nothing at all.
        let before = env.snapshot();
        env.choose(CommentPolicy::HarnessDefault);
        assert_eq!(env.snapshot(), before, "nothing is written");
        assert!(!env.policy_file().exists());

        // An install writes exactly the bundled block, then has nothing to do.
        env.apply(&["claude_rules"]);
        assert_eq!(
            env.read_claude(),
            render_new(&bundled_text(&ArtifactId::ClaudeRules))
        );
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );

        // Choosing a level writes the policy file and nothing else; going back leaves the rules as
        // bundled again.
        let before = env.snapshot();
        env.choose(CommentPolicy::Minimal);
        let after = env.snapshot();
        assert_eq!(after.1, before.1, "nothing in the home folder");
        let changed: Vec<&String> = after
            .0
            .keys()
            .chain(before.0.keys())
            .filter(|path| after.0.get(*path) != before.0.get(*path))
            .collect();
        assert_eq!(changed, vec![".riggverk/comment-policy.json"]);
        env.choose(CommentPolicy::HarnessDefault);
        assert!(env.policy_file().is_file(), "the choice is written out");
        check("harness default written out");
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    // ── A level: one section after Scope everywhere ──

    #[test]
    fn each_level_follows_scope_in_every_rules_target_the_library_and_cursor_user_rules() {
        let env = Env::new("levels");
        for level in LEVELS {
            env.choose(level);
            let sources = env.sources();
            for artifact in rules_artifacts() {
                let text = rules_source_text(&artifact, &sources).expect("source");
                assert_eq!(
                    text,
                    with_section_after_scope(&bundled_text(&artifact), level),
                    "{level:?}: {artifact:?}"
                );
                assert_eq!(text.matches(SECTION_HEADING).count(), 1, "{artifact:?}");
                // The light tier's size limit (Antigravity) still holds the composed block.
                if let ArtifactId::HarnessRules(harness) = &artifact {
                    let rules = harness.rules().expect("light rules");
                    assert!(rules.fits(render_new(&text).len()), "{artifact:?}");
                }
            }
            // The Library's base template and the Cursor User Rules the user copies carry it too.
            assert_eq!(
                cursor_rules(),
                Ok(with_section_after_scope(&bundled_cursor_rules(), level))
            );
            assert_eq!(
                library_template(),
                Ok(with_section_after_scope(&bundled_template(), level))
            );
            assert_eq!(get_comment_policy().expect("get").level, Some(level));
        }

        // Installed as composed, and nothing left to do.
        env.apply(&["claude_rules"]);
        let expected = rules_source_text(&ArtifactId::ClaudeRules, &env.sources()).expect("source");
        assert_eq!(env.read_claude(), render_new(&expected));
        assert!(env.read_claude().contains(CommentPolicy::Off.section()));
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    #[test]
    fn the_section_composes_with_pack_routing_and_disabled_skills() {
        let env = Env::new("compose");
        env.pack(
            "mine",
            &["my-canvas", "my-files"],
            "- Canvas work: `my-canvas`.\n- Saved files: `my-files`.\n",
        );
        crate::disabled_skills::set(&env.ws, &["my-files".to_string()], false).expect("disable");
        let routed: Vec<String> = rules_artifacts()
            .iter()
            .map(|artifact| rules_source_text(artifact, &env.sources()).expect("source"))
            .collect();
        assert!(routed[0].contains("- Canvas work: `my-canvas`."));
        assert!(!routed[0].contains("`my-files`"));

        env.choose(CommentPolicy::Off);
        let sources = env.sources();
        // Pack routing validates as before: the comment policy takes no part in it.
        let mine = sources
            .packs()
            .iter()
            .find(|pack| pack.name == "mine")
            .expect("pack");
        assert_eq!(
            mine.routing,
            PackRouting::Applied(vec![
                "- Canvas work: `my-canvas`.".to_string(),
                "- Saved files: `my-files`.".to_string(),
            ])
        );
        for (artifact, routed) in rules_artifacts().iter().zip(&routed) {
            let text = rules_source_text(artifact, &sources).expect("source");
            assert_eq!(
                text,
                with_section_after_scope(routed, CommentPolicy::Off),
                "{artifact:?}"
            );
        }
        let cursor = cursor_rules().expect("cursor user rules");
        assert!(cursor.contains("- Canvas work: `my-canvas`.") && !cursor.contains("`my-files`"));
        assert!(cursor.contains(CommentPolicy::Off.section()));

        env.apply(&["skills", "claude_rules"]);
        assert!(env.synced());
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    // ── Changes, diff, undo and health ──

    #[test]
    fn changing_the_level_is_a_rules_update_with_a_diff_and_undo_keeps_the_choice() {
        let env = Env::new("update");
        env.apply(&["claude_rules"]);
        // The user's own refinements below END stay through every change.
        let refined = format!("{}\n## Mine\n- keep this\n", env.read_claude());
        fs::write(env.claude_file(), &refined).expect("refine");

        env.choose(CommentPolicy::Minimal);
        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.rules.expect("rules").plan, RulesPlan::UpdateBlock);
        let diff = preview_rules_diff("claude_rules".into(), None).expect("diff");
        assert!(diff.applicable);
        assert_eq!((diff.added, diff.removed), (3, 0), "{}", diff.diff);
        assert!(
            diff.diff.contains(&format!("+{SECTION_HEADING}\n")),
            "{}",
            diff.diff
        );
        let preview = preview_setup(vec!["claude_rules".into()]).expect("preview");
        assert!(preview.has_pending_changes);

        let result = env.apply(&["claude_rules"]);
        let updated = env.read_claude();
        assert_eq!(
            updated,
            with_section_after_scope(&refined, CommentPolicy::Minimal)
        );
        assert!(updated.ends_with("\n## Mine\n- keep this\n"));

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(env.read_claude(), refined, "undo restores the old block");
        assert_eq!(
            crate::comment_policy::load(&env.ws),
            Ok(CommentPolicy::Minimal),
            "undo keeps the choice"
        );
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::Update
        );

        // From one level to the other: the body line changes, the heading stays.
        env.apply(&["claude_rules"]);
        env.choose(CommentPolicy::Off);
        let diff = preview_rules_diff("claude_rules".into(), None).expect("diff");
        assert_eq!((diff.added, diff.removed), (1, 1), "{}", diff.diff);
        env.apply(&["claude_rules"]);
        assert_eq!(
            env.read_claude(),
            with_section_after_scope(&refined, CommentPolicy::Off)
        );

        // Back to harness default: the block is the bundled base again.
        env.choose(CommentPolicy::HarnessDefault);
        env.apply(&["claude_rules"]);
        assert_eq!(env.read_claude(), refined);
    }

    #[test]
    fn health_is_synced_only_once_the_update_carries_the_level() {
        let env = Env::new("health");
        env.apply(&["claude_rules"]);
        assert!(env.synced());
        env.choose(CommentPolicy::Off);
        assert!(!env.synced(), "the installed block lacks the section");
        env.apply(&["claude_rules"]);
        assert!(env.synced());
    }

    #[test]
    fn apply_refuses_a_preview_made_before_a_policy_change() {
        let env = Env::new("stale-preview");
        let plan = preview_setup(vec!["claude_rules".into()]).expect("preview");
        assert!(plan.has_pending_changes);
        env.choose(CommentPolicy::Minimal);
        let error = apply_setup(
            vec!["claude_rules".into()],
            true,
            plan.plan_fingerprint,
            plan.preview_token,
        )
        .unwrap_err();
        assert!(error.contains("fingerprint mismatch"), "{error}");
        assert!(!env.claude_file().exists());
    }

    #[test]
    fn a_block_without_a_managed_record_that_carries_the_level_is_current() {
        let env = Env::new("no-record");
        env.choose(CommentPolicy::Minimal);
        env.apply(&["claude_rules"]);
        fs::remove_file(crate::workspace_layout::state_file(
            &env.ws,
            "managed-state.json",
        ))
        .expect("remove the records");
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    // ── Conversion ──

    /// Applies `installed`, edits the block's `## Evidence` section by hand, then chooses `now`.
    fn edited_block(env: &Env, installed: CommentPolicy, now: CommentPolicy) {
        env.choose(installed);
        env.apply(&["claude_rules"]);
        let edited =
            env.read_claude()
                .replacen("Cite code as file:line.", "Cite code as path:line.", 1);
        assert_ne!(edited, env.read_claude());
        fs::write(env.claude_file(), edited).expect("edit");
        env.choose(now);
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules)
                .rules
                .expect("rules")
                .plan,
            RulesPlan::Conflict(crate::rules_block::RulesConflict::BaseBlockEdited)
        );
    }

    #[test]
    fn conversion_never_moves_the_section_below_the_end_marker() {
        for (installed, now) in [
            // The level the block carries is the one chosen now.
            (CommentPolicy::Minimal, CommentPolicy::Minimal),
            (CommentPolicy::Off, CommentPolicy::Off),
            // The level changed after the install: the app's old text is not the user's.
            (CommentPolicy::Minimal, CommentPolicy::Off),
            (CommentPolicy::Off, CommentPolicy::Minimal),
            // Back to harness default: the base it is compared with has no such section.
            (CommentPolicy::Minimal, CommentPolicy::HarnessDefault),
            // Never had one, now has one.
            (CommentPolicy::HarnessDefault, CommentPolicy::Off),
        ] {
            let env = Env::new("convert");
            edited_block(&env, installed, now);
            let preview = preview_rules_conversion("claude_rules".into()).expect("preview");
            assert!(preview.applicable, "{:?}", preview.reason);
            assert_eq!(
                preview.moved_sections,
                vec!["## Evidence"],
                "{installed:?} -> {now:?}"
            );
            let result = apply_rules_conversion(
                "claude_rules".into(),
                preview.plan_fingerprint,
                preview.preview_token,
            )
            .expect("convert");
            assert!(result.success, "{}", result.message);
            let converted = env.read_claude();
            let parsed = crate::rules_block::parse(&converted)
                .expect("parse")
                .expect("block");
            let source =
                rules_source_text(&ArtifactId::ClaudeRules, &env.sources()).expect("source");
            assert_eq!(parsed.body_digest(), body_digest(&source));
            assert!(
                !parsed.suffix.contains(SECTION_HEADING),
                "{installed:?} -> {now:?}: {}",
                parsed.suffix
            );
            assert!(parsed.suffix.contains("Cite code as path:line."));
            assert_eq!(
                converted.matches(SECTION_HEADING).count(),
                usize::from(now != CommentPolicy::HarnessDefault),
                "{installed:?} -> {now:?}"
            );
        }
    }

    #[test]
    fn a_section_the_user_edited_is_their_text_and_moves() {
        let env = Env::new("convert-edited-section");
        env.choose(CommentPolicy::Minimal);
        env.apply(&["claude_rules"]);
        let edited =
            env.read_claude()
                .replacen("Comment only what", "Comment rarely, only what", 1);
        fs::write(env.claude_file(), edited).expect("edit");
        let preview = preview_rules_conversion("claude_rules".into()).expect("preview");
        assert_eq!(preview.moved_sections, vec![SECTION_HEADING]);
    }

    // ── A file the app cannot use ──

    #[test]
    fn an_unusable_file_fails_closed() {
        let env = Env::new("unusable");
        env.choose(CommentPolicy::Minimal);
        env.apply(&["skills", "claude_rules"]);
        let installed = env.read_claude();
        for (raw, phrase) in [
            ("not json", UNUSABLE),
            (r#"{"schema_version": 1, "level": "loud"}"#, UNUSABLE),
            (r#"{"schema_version": 9, "level": "off"}"#, FOREIGN),
        ] {
            fs::write(env.policy_file(), raw).expect("garbage");
            let sources = env.sources();
            assert_eq!(sources.comment_policy(), Err(phrase));
            for artifact in rules_artifacts() {
                assert_eq!(
                    rules_source_text(&artifact, &sources),
                    Err(phrase.to_string())
                );
            }
            let rules =
                plan_artifacts_for_surfaces(&[SetupSurfaceId::ClaudeRules], &env.ws, &env.home)
                    .expect("rules plan");
            assert!(
                rules
                    .iter()
                    .all(|planned| planned.kind == OperationKind::Unavailable),
                "{raw}"
            );
            let plan = preview_setup(vec!["claude_rules".into()]).expect("preview");
            assert!(!plan.has_pending_changes, "{raw}");
            let rules = plan
                .operations
                .iter()
                .chain(&plan.conflicts)
                .chain(&plan.manual_steps)
                .find(|op| op.surface == SetupSurfaceId::ClaudeRules)
                .expect("rules operation");
            assert_eq!(rules.kind, OperationKind::Unavailable);
            assert!(
                rules.summary.ends_with(&format!(" unavailable: {phrase}")),
                "{}",
                rules.summary
            );
            assert!(!env.synced(), "{raw}: health is not synced");
            // The Library's rules views say why instead of showing a text without the policy.
            assert_eq!(cursor_rules(), Err(phrase.to_string()));
            assert_eq!(library_template(), Err(phrase.to_string()));
            assert!(crate::commands::read_doc("docs/USING_THE_APP.md".into()).is_ok());
            let choice = get_comment_policy().expect("get");
            assert_eq!(
                (choice.level, choice.problem),
                (None, Some(phrase.to_string()))
            );
            for level in [
                CommentPolicy::HarnessDefault,
                CommentPolicy::Minimal,
                CommentPolicy::Off,
            ] {
                assert_eq!(set_comment_policy(level), Err(phrase.to_string()));
            }
            assert_eq!(fs::read_to_string(env.policy_file()).expect("file"), raw);
            // Skills do not read the policy: their surface plans as before.
            assert_eq!(
                env.plan(SetupSurfaceId::Skills).kind,
                OperationKind::NoChange,
                "{raw}"
            );
        }
        assert_eq!(env.read_claude(), installed, "nothing is written");

        // Uninstall is not blocked by the file and never deletes it.
        let plan = preview_uninstall().expect("uninstall preview");
        let removed =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("uninstall");
        assert!(removed.success, "uninstall: {}", removed.message);
        assert!(!env.claude_file().exists());
        assert!(env.policy_file().is_file(), "uninstall keeps the choice");
    }
}
