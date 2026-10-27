#[cfg(test)]
use std::path::{Path, PathBuf};

/// Independently count canonical sources and supporting files without production discovery.
#[cfg(test)]
pub fn skill_file_counts(root: &Path) -> (usize, usize) {
    let mut counts = (0, 0);
    for entry in std::fs::read_dir(root).expect("read skills directory") {
        let entry = entry.expect("skill entry");
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = entry.file_type().expect("skill file type");
        if kind.is_dir() {
            let nested = skill_file_counts(&entry.path());
            counts.0 += nested.0;
            counts.1 += nested.1;
        } else if kind.is_file() {
            if name == "SKILL.md" {
                counts.0 += 1;
            } else {
                counts.1 += 1;
            }
        }
    }
    counts
}

#[cfg(test)]
pub fn source_skill_count() -> usize {
    skill_file_counts(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace/skills"),
    )
    .0
}

#[cfg(test)]
pub fn process_home() -> PathBuf {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .expect("user home required for test")
}

/// The copy of the bundle an earlier release kept in the workspace folder `ws`: the marker and
/// every file of the frozen list that the bundle still holds, byte for byte as it has them now.
/// Returns the paths.
#[cfg(test)]
pub fn seed_workspace_copy(ws: &Path) -> Vec<&'static str> {
    let bundle = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
    let paths: Vec<&'static str> = crate::commands::retired_workspace_files::workspace_copy_paths()
        .filter(|rel| !crate::commands::retired_workspace_files::RETIRED_FROM_BUNDLE.contains(rel))
        .collect();
    for rel in &paths {
        let dest = ws.join(rel);
        std::fs::create_dir_all(dest.parent().expect("parent")).expect("copy folder");
        std::fs::copy(bundle.join(rel), &dest).expect("copy a bundle file");
    }
    paths
}

/// Bytes of the canonical SKILL.md that `write_canonical_skill` writes.
#[cfg(test)]
pub fn canonical_skill_text(name: &str, body: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: test skill\ntargets: codex, opencode, claude, cursor\n---\n# {name}\n\n{body}\n"
    )
}

/// Write the canonical SKILL.md of a skill into a fixture workspace: the one file every harness
/// installs. `group` puts it one directory deeper (`skills/<group>/<name>`).
#[cfg(test)]
pub fn write_canonical_skill(ws: &Path, group: Option<&str>, name: &str, body: &str) -> PathBuf {
    let skills = ws.join("skills");
    let dir = match group {
        Some(group) => skills.join(group).join(name),
        None => skills.join(name),
    };
    std::fs::create_dir_all(&dir).expect("create canonical skill dir");
    let path = dir.join("SKILL.md");
    std::fs::write(&path, canonical_skill_text(name, body)).expect("write canonical skill");
    path
}

#[cfg(test)]
pub fn set_test_user_dirs(dir: &Path) {
    let dir_str = dir.to_string_lossy();
    let xdg_config_home = dir.join(".config");
    let xdg_data_home = dir.join(".local").join("share");
    let _ = std::fs::create_dir_all(&xdg_config_home);
    let _ = std::fs::create_dir_all(&xdg_data_home);
    unsafe {
        std::env::set_var("HOME", dir_str.as_ref());
        std::env::set_var(
            "XDG_CONFIG_HOME",
            xdg_config_home.to_string_lossy().as_ref(),
        );
        std::env::set_var("XDG_DATA_HOME", xdg_data_home.to_string_lossy().as_ref());
        #[cfg(windows)]
        {
            std::env::set_var("USERPROFILE", dir_str.as_ref());
            let appdata = dir.join("AppData").join("Roaming");
            let _ = std::fs::create_dir_all(&appdata);
            std::env::set_var("APPDATA", appdata.to_string_lossy().as_ref());
            let local_appdata = dir.join("AppData").join("Local");
            let _ = std::fs::create_dir_all(&local_appdata);
            std::env::set_var("LOCALAPPDATA", local_appdata.to_string_lossy().as_ref());
        }
    }
}

#[cfg(test)]
pub mod guard {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    pub fn lock() -> MutexGuard<'static, ()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub struct EnvRestore {
        home: Option<String>,
        userprofile: Option<String>,
        path: Option<String>,
        pathext: Option<String>,
        appdata: Option<String>,
        local_appdata: Option<String>,
        xdg_config_home: Option<String>,
        xdg_data_home: Option<String>,
        agent_workspace_backup_dir: Option<String>,
        agent_workspace_path: Option<String>,
        cursor_skills_path: Option<String>,
        codex_skills_path: Option<String>,
        codex_home: Option<String>,
        opencode_skills_path: Option<String>,
        claude_skills_path: Option<String>,
    }

    impl EnvRestore {
        pub fn capture() -> Self {
            Self {
                home: std::env::var("HOME").ok(),
                userprofile: std::env::var("USERPROFILE").ok(),
                path: std::env::var("PATH").ok(),
                pathext: std::env::var("PATHEXT").ok(),
                appdata: std::env::var("APPDATA").ok(),
                local_appdata: std::env::var("LOCALAPPDATA").ok(),
                xdg_config_home: std::env::var("XDG_CONFIG_HOME").ok(),
                xdg_data_home: std::env::var("XDG_DATA_HOME").ok(),
                agent_workspace_backup_dir: std::env::var("AGENT_WORKSPACE_BACKUP_DIR").ok(),
                agent_workspace_path: std::env::var("AGENT_WORKSPACE_PATH").ok(),
                cursor_skills_path: std::env::var("CURSOR_SKILLS_PATH").ok(),
                codex_skills_path: std::env::var("CODEX_SKILLS_PATH").ok(),
                codex_home: std::env::var("CODEX_HOME").ok(),
                opencode_skills_path: std::env::var("OPENCODE_SKILLS_PATH").ok(),
                claude_skills_path: std::env::var("CLAUDE_SKILLS_PATH").ok(),
            }
        }
    }

    /// The env lock, with `XDG_CONFIG_HOME` removed until it drops (fields drop in order: the
    /// environment is restored before the lock is released).
    pub struct DefaultXdgConfigHome {
        _restore: EnvRestore,
        _lock: MutexGuard<'static, ()>,
    }

    /// For a test that hands a temp home to code that finds OpenCode's config folder
    /// (`platform_paths::opencode_config_dir`): the folder is then `<home>/.config/opencode`,
    /// whatever `XDG_CONFIG_HOME` the test process was started with, and nothing reaches a real
    /// `$XDG_CONFIG_HOME/opencode`.
    pub fn default_xdg_config_home() -> DefaultXdgConfigHome {
        let lock = lock();
        let restore = EnvRestore::capture();
        unsafe { std::env::remove_var("XDG_CONFIG_HOME") };
        DefaultXdgConfigHome {
            _restore: restore,
            _lock: lock,
        }
    }

    fn set_optional(key: &str, value: Option<&str>) {
        match value {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            set_optional("HOME", self.home.as_deref());
            set_optional("USERPROFILE", self.userprofile.as_deref());
            set_optional("PATH", self.path.as_deref());
            set_optional("PATHEXT", self.pathext.as_deref());
            set_optional("APPDATA", self.appdata.as_deref());
            set_optional("LOCALAPPDATA", self.local_appdata.as_deref());
            set_optional("XDG_CONFIG_HOME", self.xdg_config_home.as_deref());
            set_optional("XDG_DATA_HOME", self.xdg_data_home.as_deref());
            set_optional(
                "AGENT_WORKSPACE_BACKUP_DIR",
                self.agent_workspace_backup_dir.as_deref(),
            );
            set_optional("AGENT_WORKSPACE_PATH", self.agent_workspace_path.as_deref());
            set_optional("CURSOR_SKILLS_PATH", self.cursor_skills_path.as_deref());
            set_optional("CODEX_SKILLS_PATH", self.codex_skills_path.as_deref());
            set_optional("CODEX_HOME", self.codex_home.as_deref());
            set_optional("OPENCODE_SKILLS_PATH", self.opencode_skills_path.as_deref());
            set_optional("CLAUDE_SKILLS_PATH", self.claude_skills_path.as_deref());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Sources that may change the process `PATH`: `extend_path_with_tool_dirs` runs once at startup
    /// before any thread exists, and the light-harness fixtures hold `guard::lock()` for their whole
    /// test and sort far from every test that starts a program by name.
    const MAY_CHANGE_PATH: [&str; 2] = ["executable_resolver.rs", "light_harness_contract.rs"];

    fn rust_sources(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read source dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_sources(&path, found);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                found.push(path);
            }
        }
    }

    /// `PATH` is process-wide and `guard::lock()` only holds back tests that take it. Dozens of tests
    /// start `python3` or `git` by bare name without the lock, so a test that changes `PATH` makes
    /// them fail with "python3 is not available" whenever a spawn lands inside its window. Inject the
    /// search path instead (`resolve_opencode_executable_in`, `BoundedCmdOptions::extra_env`).
    #[test]
    fn tests_do_not_change_the_process_path() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut sources = Vec::new();
        rust_sources(&src_dir, &mut sources);
        let this_file = Path::new(file!()).file_name().expect("file name");
        let needles = ["set_var(\"PATH\"", "remove_var(\"PATH\""];
        let mut offenders = Vec::new();
        for path in sources {
            let name = path.file_name().expect("file name");
            if name == this_file || MAY_CHANGE_PATH.iter().any(|allowed| name == *allowed) {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read source");
            for (index, line) in text.lines().enumerate() {
                if needles.iter().any(|needle| line.contains(needle)) {
                    let relative = path.strip_prefix(&src_dir).unwrap_or(&path);
                    offenders.push(format!("{}:{}", relative.display(), index + 1));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "a test changes the process PATH, which breaks parallel tests that spawn python3 or git: {offenders:?}"
        );
    }
}
