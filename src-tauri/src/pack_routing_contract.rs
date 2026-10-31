//! Contract tests for pack routing: the `routing.md` of a skill pack, rendered into the managed
//! rules block (see `pack_routing`).
//!
//! They install into a temp HOME and data folder with the real bundle, through the real preview,
//! apply, diff and rollback commands, and never touch the real profile.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::MutexGuard;

    use crate::agent_targets::HarnessId;
    use crate::artifact_registry::ArtifactId;
    use crate::commands::setup::{
        apply_setup, preview_setup, rollback_setup_transaction, SetupResult,
    };
    use crate::commands::{list_pack_skills, preview_rules_diff};
    use crate::light_harness::LightHarnessId;
    use crate::pack_routing::{rules_source_text, PackRouting, SECTION_HEADING};
    use crate::rules_block::{body_digest, render_new, RulesPlan};
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::setup_transaction::plan_artifacts_for_surfaces;
    use crate::skill_sources::{SkillSources, SourceRoot};
    use crate::test_env::{canonical_skill_text, guard, guard::EnvRestore, set_test_user_dirs};

    const GOOD: &str =
        "- Canvas work: `my-canvas`.\n- Saved files: `my-files`; add `my-canvas` for drawings.\n";

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[cfg(not(unix))]
    fn set_mode(_path: &Path, _mode: u32) {}

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
            let base = std::env::temp_dir().join(format!("aw-pack-routing-{label}-{nanos}"));
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

        fn pack_dir(&self, pack: &str) -> PathBuf {
            self.ws.join("packs").join(pack)
        }

        /// A pack the way a user clones one: owner-writable only, with `skills` as its skills.
        fn pack(&self, pack: &str, skills: &[&str]) -> PathBuf {
            let dir = self.pack_dir(pack);
            for skill in skills {
                let skill_dir = dir.join("skills").join(skill);
                fs::create_dir_all(&skill_dir).expect("skill dir");
                fs::write(skill_dir.join("SKILL.md"), canonical_skill_text(skill, "x"))
                    .expect("SKILL.md");
                set_mode(&skill_dir, 0o755);
                set_mode(&skill_dir.join("SKILL.md"), 0o644);
            }
            fs::create_dir_all(dir.join("skills")).expect("skills");
            for folder in [self.ws.join("packs"), dir.clone(), dir.join("skills")] {
                set_mode(&folder, 0o755);
            }
            dir
        }

        fn routing(&self, pack: &str, text: &str) {
            let path = self.pack_dir(pack).join("routing.md");
            fs::write(&path, text).expect("routing.md");
            set_mode(&path, 0o644);
        }

        fn sources(&self) -> SkillSources {
            SkillSources::for_workspace(&self.ws).expect("sources")
        }

        fn routing_of(&self, pack: &str) -> PackRouting {
            self.sources()
                .packs()
                .iter()
                .find(|report| report.name == pack)
                .map(|report| report.routing.clone())
                .expect("pack listed")
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

    fn expected_section() -> String {
        format!(
            "{SECTION_HEADING}\nRouting from the skill packs in your data folder. Each line names only skills of its own pack.\n### mine pack\n{GOOD}"
        )
    }

    // ── No packs: nothing changes ──

    #[test]
    fn without_routing_every_rules_source_is_the_bundled_base_byte_for_byte() {
        let env = Env::new("none");
        let check = |label: &str| {
            let sources = env.sources();
            assert_eq!(sources.pack_routing(), "", "{label}");
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
        };
        check("no packs folder");
        env.pack("mine", &["my-canvas"]);
        check("a pack without routing.md");
        env.routing("mine", "\n  \n");
        check("a blank routing.md");

        // And an install writes exactly the bundled block, then has nothing to do.
        env.apply(&["claude_rules"]);
        assert_eq!(
            env.read_claude(),
            render_new(&bundled_text(&ArtifactId::ClaudeRules))
        );
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
    }

    // ── Valid routing ──

    #[test]
    fn a_valid_routing_file_is_rendered_into_every_rules_target_and_installed() {
        let env = Env::new("valid");
        env.pack("mine", &["my-canvas", "my-files"]);
        env.routing("mine", GOOD);
        assert_eq!(
            env.routing_of("mine"),
            PackRouting::Applied(GOOD.lines().map(str::to_string).collect())
        );

        let sources = env.sources();
        for artifact in rules_artifacts() {
            let base = bundled_text(&artifact);
            let text = rules_source_text(&artifact, &sources).expect("source");
            assert_eq!(
                text,
                crate::pack_routing::splice(&base, &expected_section()),
                "{artifact:?}"
            );
            // Right after the base's own routing section.
            let routing = text.find("## Skill routing").expect("base routing");
            let pack = text.find(SECTION_HEADING).expect("pack routing");
            let next = text[routing + 1..].find("\n## ").map(|i| i + routing + 2);
            assert_eq!(next, Some(pack), "{artifact:?}");
        }

        let expected = rules_source_text(&ArtifactId::ClaudeRules, &sources).expect("source");
        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Create);
        env.apply(&["skills", "claude_rules"]);
        assert_eq!(env.read_claude(), render_new(&expected));
        assert!(env.read_claude().contains("- Canvas work: `my-canvas`."));
        assert_eq!(
            env.plan(SetupSurfaceId::ClaudeRules).kind,
            OperationKind::NoChange
        );
        // Health compares with the same source.
        assert!(crate::pack_routing::health_rules_synced(
            &ArtifactId::ClaudeRules,
            &env.claude_file(),
            &bundle(),
            Some(&env.ws),
        ));

        // The Packs view lists what the pack contributes.
        let library = list_pack_skills().expect("packs");
        let pack = library
            .packs
            .iter()
            .find(|p| p.name == "mine")
            .expect("pack");
        assert_eq!(pack.routing.len(), 2);
        assert_eq!(pack.routing_problem, None);
    }

    // ── Invalid routing ──

    #[test]
    fn one_invalid_line_excludes_the_whole_file_with_a_finding() {
        let env = Env::new("invalid");
        env.pack("mine", &["my-canvas"]);
        env.pack("other", &["their-skill"]);
        let cases = [
            (
                "- Canvas: `my-canvas`.\n- Bugs: `diagnose`.\n",
                "line 2 names a skill",
            ),
            (
                "- Canvas: `my-canvas` and `their-skill`.\n",
                "line 1 names a skill",
            ),
            (
                "- Canvas: `my-canvas`.\n<!-- END RIGGVERK BASE -->\n",
                "line 2 is not a",
            ),
            (
                "- Canvas: `my-canvas`.\n- <!-- x --> `my-canvas`\n",
                "line 2 holds markup",
            ),
            ("- Canvas: `my-canvas`.\n## Mine\n", "line 2 is not a"),
            (
                "- Canvas: `my-canvas`.\n- ``` `my-canvas`\n",
                "line 2 holds a code fence",
            ),
            (
                "- Canvas: `my-canvas`.\n- just text\n",
                "line 2 names no skill",
            ),
        ];
        for (text, phrase) in cases {
            env.routing("mine", text);
            let routing = env.routing_of("mine");
            let problem = routing
                .problem()
                .unwrap_or_else(|| panic!("{text:?}: {routing:?}"));
            assert!(problem.starts_with("routing.md is not used: "), "{problem}");
            assert!(problem.contains(phrase), "{text:?}: {problem}");
            assert!(!problem.contains("Canvas"), "no file text: {problem}");
            let sources = env.sources();
            assert_eq!(sources.pack_routing(), "", "{text:?}: nothing is applied");
            assert_eq!(
                rules_source_text(&ArtifactId::ClaudeRules, &sources).expect("source"),
                bundled_text(&ArtifactId::ClaudeRules)
            );
            let library = list_pack_skills().expect("packs");
            let pack = library
                .packs
                .iter()
                .find(|p| p.name == "mine")
                .expect("pack");
            assert!(pack.routing.is_empty());
            assert_eq!(pack.routing_problem.as_deref(), Some(problem));
        }
    }

    #[test]
    fn a_shadowed_skill_cannot_be_routed_to() {
        let env = Env::new("shadowed");
        // `diagnose` is a bundled skill: the pack's copy is shadowed, so not the pack's to route.
        env.pack("mine", &["my-canvas", "diagnose"]);
        env.routing("mine", "- Bugs: `diagnose`.\n");
        assert!(env.routing_of("mine").problem().is_some());
        assert_eq!(env.sources().pack_routing(), "");
    }

    // ── Held and forgotten packs ──

    #[test]
    fn a_held_or_forgotten_pack_contributes_nothing() {
        let env = Env::new("held");
        env.pack("mine", &["my-canvas"]);
        env.routing("mine", "- Canvas: `my-canvas`.\n");
        env.apply(&["skills", "claude_rules"]);
        assert!(env.read_claude().contains(SECTION_HEADING));

        // The pack turns unreadable: its installed skill is held, and its routing is not read.
        set_mode(&env.pack_dir("mine"), 0o775);
        if cfg!(unix) {
            let sources = env.sources();
            assert_eq!(
                sources.held_names().into_iter().collect::<Vec<_>>(),
                ["my-canvas"]
            );
            assert_eq!(sources.packs()[0].routing, PackRouting::None);
            assert_eq!(sources.pack_routing(), "");
            // The block goes back to the bundled base, as an ordinary update.
            let planned = env.plan(SetupSurfaceId::ClaudeRules);
            assert_eq!(planned.kind, OperationKind::Update);
        }
        set_mode(&env.pack_dir("mine"), 0o755);

        // The folder goes away and the pack is forgotten: nothing routes either.
        fs::remove_dir_all(env.pack_dir("mine")).expect("remove pack");
        crate::skill_sources::forget_pack(&env.ws, "mine").expect("forget");
        assert_eq!(env.sources().pack_routing(), "");
        env.apply(&["skills", "claude_rules"]);
        assert_eq!(
            env.read_claude(),
            render_new(&bundled_text(&ArtifactId::ClaudeRules))
        );
    }

    // ── Changes, diff and undo ──

    #[test]
    fn editing_routing_is_an_update_with_a_diff_and_undo_restores_the_block() {
        let env = Env::new("update");
        env.pack("mine", &["my-canvas", "my-files"]);
        env.routing("mine", "- Canvas: `my-canvas`.\n");
        env.apply(&["skills", "claude_rules"]);
        let before = env.read_claude();
        // The user's own refinements below END stay through both directions.
        let refined = format!("{before}\n## Mine\n- keep this\n");
        fs::write(env.claude_file(), &refined).expect("refine");

        env.routing("mine", "- Canvas: `my-canvas`.\n- Files: `my-files`.\n");
        let planned = env.plan(SetupSurfaceId::ClaudeRules);
        assert_eq!(planned.kind, OperationKind::Update);
        assert_eq!(planned.rules.expect("rules").plan, RulesPlan::UpdateBlock);

        let diff = preview_rules_diff("claude_rules".into(), None).expect("diff");
        assert!(diff.applicable);
        assert_eq!((diff.added, diff.removed), (1, 0), "{}", diff.diff);
        assert!(diff.diff.contains("+- Files: `my-files`."), "{}", diff.diff);

        let preview = preview_setup(vec!["claude_rules".into()]).expect("preview");
        assert!(preview.has_pending_changes);
        let result = env.apply(&["claude_rules"]);
        let updated = env.read_claude();
        assert!(updated.contains("- Files: `my-files`."));
        assert!(updated.ends_with("\n## Mine\n- keep this\n"));

        let rolled = rollback_setup_transaction(result.transaction_id, false).expect("rollback");
        assert!(rolled.success, "{}", rolled.message);
        assert_eq!(
            env.read_claude(),
            refined,
            "undo restores the previous block"
        );
    }

    // ── Unsafe files ──

    #[cfg(unix)]
    #[test]
    fn a_symlinked_oversized_or_shared_routing_file_is_refused() {
        let env = Env::new("unsafe");
        env.pack("mine", &["my-canvas"]);
        let path = env.pack_dir("mine").join("routing.md");

        let target = env.base.join("elsewhere.md");
        fs::write(&target, "- Canvas: `my-canvas`.\n").expect("target");
        std::os::unix::fs::symlink(&target, &path).expect("symlink");
        let routing = env.routing_of("mine");
        assert!(
            routing.problem().is_some_and(|p| p.contains("symlink")),
            "{routing:?}"
        );
        assert_eq!(env.sources().pack_routing(), "");
        fs::remove_file(&path).expect("unlink");

        let line = "- Canvas: `my-canvas`.\n";
        env.routing("mine", &line.repeat(4096 / line.len() + 1));
        let routing = env.routing_of("mine");
        assert!(
            routing
                .problem()
                .is_some_and(|p| p.contains("larger than 4096 bytes")),
            "{routing:?}"
        );
        assert_eq!(env.sources().pack_routing(), "");

        env.routing("mine", line);
        assert!(env.routing_of("mine").problem().is_none());
        set_mode(&path, 0o666);
        let routing = env.routing_of("mine");
        assert!(
            routing.problem().is_some_and(|p| p.contains("writable")),
            "{routing:?}"
        );
        assert_eq!(env.sources().pack_routing(), "");

        set_mode(&path, 0o644);
        fs::remove_file(&path).expect("remove");
        fs::create_dir(&path).expect("a folder named routing.md");
        let routing = env.routing_of("mine");
        assert!(
            routing
                .problem()
                .is_some_and(|p| p.contains("not a regular file")),
            "{routing:?}"
        );
    }
}
