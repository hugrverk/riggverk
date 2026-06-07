#[cfg(test)]
use std::path::{Path, PathBuf};

#[cfg(test)]
pub fn process_home() -> PathBuf {
    crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .expect("user home required for test")
}

#[cfg(test)]
pub fn set_test_user_dirs(dir: &Path) {
    let dir_str = dir.to_string_lossy();
    unsafe {
        std::env::set_var("HOME", dir_str.as_ref());
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
        cursor_skills_path: Option<String>,
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
                cursor_skills_path: std::env::var("CURSOR_SKILLS_PATH").ok(),
            }
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
            set_optional("CURSOR_SKILLS_PATH", self.cursor_skills_path.as_deref());
        }
    }
}
