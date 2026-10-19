//! End-to-end contract for OpenCode's config folder and `XDG_CONFIG_HOME`.
//!
//! OpenCode reads `$XDG_CONFIG_HOME/opencode` when the variable is set, else `~/.config/opencode`,
//! on every OS. Install, review and uninstall use that folder, and a later change of the variable
//! never touches what the app wrote to the old one. Drives the real preview, apply and uninstall
//! paths against a temp HOME, a temp `XDG_CONFIG_HOME` and a temp workspace; never the real
//! profile.

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::commands::setup::{
        apply_setup, apply_uninstall, preview_setup, preview_uninstall, SetupResult,
    };
    use crate::setup_lifecycle::{OperationKind, SetupSurfaceId};
    use crate::skill_roots::SkillRoot;
    use crate::test_env::{guard, set_test_user_dirs};

    const SURFACES: [&str; 3] = ["open_code_config", "open_code_agents", "open_code_rules"];
    const SURFACE_IDS: [SetupSurfaceId; 3] = [
        SetupSurfaceId::OpenCodeConfig,
        SetupSurfaceId::OpenCodeAgents,
        SetupSurfaceId::OpenCodeRules,
    ];
    const TARGET_IDS: [&str; 3] = ["opencode_config", "opencode_agents", "opencode_rules"];

    struct Env {
        base: PathBuf,
        home: PathBuf,
        ws: PathBuf,
        playwright_config: Option<String>,
        _restore: guard::EnvRestore,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl Env {
        fn new(label: &str) -> Self {
            let lock = guard::lock();
            let restore = guard::EnvRestore::capture();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let base = std::env::temp_dir().join(format!("aw-oc-xdg-{label}-{nanos}"));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(base.join("home")).expect("home");
            fs::create_dir_all(base.join("workspace")).expect("workspace");
            set_test_user_dirs(&base.join("home"));
            let ws = base.join("workspace").canonicalize().expect("workspace");
            // The Playwright sidecar goes into the temp HOME, never to a path set for the real one.
            let playwright_config = std::env::var("PLAYWRIGHT_MCP_CONFIG_PATH").ok();
            unsafe {
                std::env::set_var("AGENT_WORKSPACE_PATH", &ws);
                std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", base.join("backups"));
                std::env::remove_var("CODEX_HOME");
                std::env::remove_var("OPENCODE_SKILLS_PATH");
                std::env::remove_var("PLAYWRIGHT_MCP_CONFIG_PATH");
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
                playwright_config,
                _restore: restore,
                _lock: lock,
            }
        }

        /// Sets `XDG_CONFIG_HOME` to a new folder below the temp base (outside HOME), or removes
        /// it.
        fn use_xdg(&self, name: Option<&str>) -> Option<PathBuf> {
            match name {
                Some(name) => {
                    let dir = self.base.join(name);
                    fs::create_dir_all(&dir).expect("xdg config home");
                    unsafe { std::env::set_var("XDG_CONFIG_HOME", &dir) };
                    Some(dir)
                }
                None => {
                    unsafe { std::env::remove_var("XDG_CONFIG_HOME") };
                    None
                }
            }
        }

        fn planned(&self) -> Vec<crate::setup_transaction::PlannedArtifact> {
            crate::setup_transaction::plan_artifacts_for_surfaces(
                &SURFACE_IDS,
                &self.ws,
                &self.home,
            )
            .expect("plan")
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            if let Some(path) = &self.playwright_config {
                unsafe { std::env::set_var("PLAYWRIGHT_MCP_CONFIG_PATH", path) };
            }
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn surfaces() -> Vec<String> {
        SURFACES.iter().map(|s| s.to_string()).collect()
    }

    fn apply() -> SetupResult {
        let plan = preview_setup(surfaces()).expect("preview");
        let result = apply_setup(surfaces(), false, plan.plan_fingerprint, plan.preview_token)
            .expect("apply");
        assert!(result.success, "apply: {}", result.message);
        result
    }

    fn uninstall() -> SetupResult {
        let plan = preview_uninstall().expect("uninstall preview");
        let result =
            apply_uninstall(plan.plan_fingerprint, plan.preview_token).expect("apply uninstall");
        assert!(result.success, "uninstall: {}", result.message);
        result
    }

    fn bundled_agents() -> Vec<String> {
        let dir = crate::setup_roots::bundled_root()
            .expect("bundle")
            .join("agents");
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("bundled agents")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".md") && !name.starts_with('.'))
            .collect();
        names.sort();
        assert!(!names.is_empty(), "the bundle has agents");
        names
    }

    /// Every file below `dir` with its bytes.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(current) = pending.pop() {
            for entry in fs::read_dir(&current).expect("read dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    files.insert(path.clone(), fs::read(&path).expect("read file"));
                }
            }
        }
        files
    }

    fn assert_installed_in(folder: &Path) {
        for rel in ["opencode.json", "tui.json", "AGENTS.md"] {
            assert!(folder.join(rel).is_file(), "{}", folder.join(rel).display());
        }
        for name in bundled_agents() {
            let agent = folder.join("agents").join(&name);
            assert!(agent.is_file(), "{}", agent.display());
        }
    }

    fn target_paths() -> Vec<String> {
        let targets = crate::commands::get_agent_targets().expect("targets");
        TARGET_IDS
            .iter()
            .map(|id| {
                targets
                    .iter()
                    .find(|target| target.id == *id)
                    .map(|target| target.target_rel.clone())
                    .expect("OpenCode target")
            })
            .collect()
    }

    #[test]
    fn install_review_and_uninstall_use_the_folder_xdg_config_home_names() {
        let env = Env::new("install");
        let xdg = env.use_xdg(Some("xdg-config")).unwrap();
        let folder = xdg.join("opencode");

        apply();
        assert_installed_in(&folder);
        assert!(
            !env.home.join(".config/opencode").exists(),
            "nothing goes to ~/.config/opencode"
        );
        // The review reads the same folder: a second one has nothing to do.
        assert!(
            env.planned()
                .iter()
                .all(|planned| planned.kind == OperationKind::NoChange),
            "{:?}",
            env.planned()
                .iter()
                .map(|planned| (&planned.artifact, planned.kind))
                .collect::<Vec<_>>()
        );
        // Labels name the folder by the variable that moves it.
        assert_eq!(
            target_paths(),
            [
                "$XDG_CONFIG_HOME/opencode/opencode.json",
                "$XDG_CONFIG_HOME/opencode/agents",
                "$XDG_CONFIG_HOME/opencode/AGENTS.md",
            ]
        );
        assert_eq!(
            SkillRoot::OpenCode.display(),
            "$XDG_CONFIG_HOME/opencode/skills"
        );
        assert_eq!(
            SkillRoot::OpenCode.path(&env.home).unwrap(),
            folder.join("skills")
        );

        // Uninstall finds the app's files there and removes them.
        let preview = preview_uninstall().expect("uninstall preview");
        let agent = folder.join("agents").join(&bundled_agents()[0]);
        assert!(
            preview
                .removable
                .iter()
                .any(|item| Path::new(&item.path) == agent),
            "{:?}",
            preview
                .removable
                .iter()
                .map(|item| &item.path)
                .collect::<Vec<_>>()
        );
        uninstall();
        assert!(!agent.exists());
        assert!(!env.home.join(".config/opencode").exists());
    }

    #[test]
    fn without_xdg_config_home_the_files_go_to_dot_config_opencode() {
        let env = Env::new("default");
        env.use_xdg(None);
        apply();
        assert_installed_in(&env.home.join(".config/opencode"));
        assert_eq!(
            target_paths(),
            [
                ".config/opencode/opencode.json",
                ".config/opencode/agents",
                ".config/opencode/AGENTS.md",
            ]
        );
        assert_eq!(SkillRoot::OpenCode.display(), "~/.config/opencode/skills");
    }

    #[test]
    fn switching_xdg_config_home_leaves_the_old_folder_untouched() {
        let env = Env::new("switch");
        let first = env.use_xdg(Some("xdg-first")).unwrap();
        apply();
        // The user adds their own text below the managed block at the first place.
        let rules = first.join("opencode/AGENTS.md");
        let mut text = fs::read_to_string(&rules).expect("rules");
        text.push_str("\nmy own rule\n");
        fs::write(&rules, text).expect("edit rules");
        let before = snapshot(&first);
        assert!(before.len() > 3, "{:?}", before.keys());

        // A second place that already holds the user's own agent under a bundled name.
        let second = env.use_xdg(Some("xdg-second")).unwrap();
        let own = second.join("opencode/agents").join(&bundled_agents()[0]);
        fs::create_dir_all(own.parent().unwrap()).unwrap();
        fs::write(&own, "my own agent\n").unwrap();

        // Every planned operation is at the new place; the records of the first install make
        // nothing there an update or a removal.
        for planned in env.planned() {
            let dest = planned
                .artifact
                .resolve_dest(&env.home, &env.ws)
                .expect("dest");
            assert!(
                !dest.starts_with(&first),
                "{:?} -> {}",
                planned.artifact,
                dest.display()
            );
            assert!(
                !matches!(planned.kind, OperationKind::Remove),
                "{:?} is removed",
                planned.artifact
            );
        }
        apply();
        assert_installed_in(&second.join("opencode"));
        assert_eq!(fs::read_to_string(&own).unwrap(), "my own agent\n");
        assert_eq!(snapshot(&first), before, "the old place is untouched");

        // An uninstall while the second place is in effect leaves the first one alone too.
        uninstall();
        assert_eq!(snapshot(&first), before, "the old place is untouched");
        assert_eq!(fs::read_to_string(&own).unwrap(), "my own agent\n");

        // Back to the default: nothing at either place changes, the install goes to
        // ~/.config/opencode.
        let second_after = snapshot(&second);
        env.use_xdg(None);
        apply();
        assert_installed_in(&env.home.join(".config/opencode"));
        assert_eq!(snapshot(&first), before);
        assert_eq!(snapshot(&second), second_after);
    }
}
