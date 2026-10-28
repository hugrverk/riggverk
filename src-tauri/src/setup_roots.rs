use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PACKAGED_BUNDLED_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct SetupRoots {
    /// The bundle and the packs of `runtime_root`, read once for the whole operation.
    pub sources: crate::skill_sources::SkillSources,
    pub runtime_root: PathBuf,
    pub home: PathBuf,
    pub backup_root: PathBuf,
}

impl SetupRoots {
    /// The roots of one operation. `sources` are the bundle and packs of `runtime_root`, read by
    /// the caller once for the whole operation.
    pub fn resolve(
        runtime_root: PathBuf,
        home: PathBuf,
        backup_root: PathBuf,
        sources: crate::skill_sources::SkillSources,
    ) -> Result<Self, String> {
        if &*sources == runtime_root.as_path() {
            return Err("bundled and runtime workspace roots must be distinct".to_string());
        }
        Ok(Self {
            sources,
            runtime_root,
            home,
            backup_root,
        })
    }
}

pub fn initialize(root: PathBuf) -> Result<(), String> {
    if !root.is_dir() {
        return Err(format!("bundled workspace is missing: {}", root.display()));
    }
    PACKAGED_BUNDLED_ROOT
        .set(root)
        .map_err(|_| "bundled workspace was already initialized".to_string())
}

pub fn bundled_root() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(root) = test_bundle::get() {
        return Ok(root);
    }
    if let Some(root) = PACKAGED_BUNDLED_ROOT.get() {
        return Ok(root.clone());
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
    if root.is_dir() {
        Ok(root)
    } else {
        Err("bundled workspace is unavailable".to_string())
    }
}

pub fn bundled_root_for(runtime_root: &Path) -> Result<PathBuf, String> {
    let bundled = bundled_root()?;
    let bundled_canonical = bundled.canonicalize().unwrap_or_else(|_| bundled.clone());
    let runtime_canonical = runtime_root
        .canonicalize()
        .unwrap_or_else(|_| runtime_root.to_path_buf());
    if bundled_canonical == runtime_canonical {
        return Err("bundled and runtime workspace roots must be distinct".to_string());
    }
    Ok(bundled)
}

/// Per-thread replacement of the bundle, so a test can ship a different set of skills.
#[cfg(test)]
pub(crate) mod test_bundle {
    use std::cell::RefCell;
    use std::path::PathBuf;

    thread_local! {
        static BUNDLE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    pub(super) fn get() -> Option<PathBuf> {
        BUNDLE.with(|cell| cell.borrow().clone())
    }

    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            BUNDLE.with(|cell| *cell.borrow_mut() = None);
        }
    }

    /// Use `root` as the bundle on this thread until the guard drops.
    pub(crate) fn set(root: PathBuf) -> Guard {
        BUNDLE.with(|cell| *cell.borrow_mut() = Some(root));
        Guard
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_skills_never_select_runtime_as_bundle() {
        let runtime =
            std::env::temp_dir().join(format!("setup-roots-runtime-{}", std::process::id()));
        std::fs::create_dir_all(runtime.join("skills")).expect("runtime skills");
        for index in 0..33 {
            std::fs::create_dir_all(runtime.join("skills").join(format!("skill-{index}")))
                .expect("runtime skill");
        }
        let resolved = bundled_root_for(&runtime).expect("bundled root");
        assert_ne!(resolved, runtime);
        assert_eq!(
            crate::skill_discovery::discover_skill_catalog(&resolved)
                .expect("bundled catalog")
                .len(),
            crate::test_env::source_skill_count()
        );
        let _ = std::fs::remove_dir_all(runtime);
    }
}
