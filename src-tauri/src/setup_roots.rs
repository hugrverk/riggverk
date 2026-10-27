use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PACKAGED_BUNDLED_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct SetupRoots {
    pub bundled_root: PathBuf,
    pub runtime_root: PathBuf,
    pub home: PathBuf,
    pub backup_root: PathBuf,
}

impl SetupRoots {
    pub fn resolve(
        runtime_root: PathBuf,
        home: PathBuf,
        backup_root: PathBuf,
    ) -> Result<Self, String> {
        let bundled_root = bundled_root()?;
        if bundled_root == runtime_root {
            return Err("bundled and runtime workspace roots must be distinct".to_string());
        }
        Ok(Self {
            bundled_root,
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
            26
        );
        let _ = std::fs::remove_dir_all(runtime);
    }
}
