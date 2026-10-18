//! Health of installed skill files, for the Claude, Codex and Cursor runtime checks.
//!
//! Skills are installed from the bundled catalog, not from the runtime workspace copy, so the
//! installed files are compared with the bundle: the same files, in the same folders, that an
//! install writes. One function answers for every harness; each passes the roots it reads.

use std::path::Path;

use crate::artifact_registry::{catalog_skill_files, ArtifactId, SkillFiles};
use crate::commands::file_eq;
use crate::skill_roots::SkillRoot;

/// How many skills of the bundle are installed correctly in the roots asked about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SkillFilesStatus {
    /// Skills in the bundle.
    pub expected: usize,
    /// Every file of the skill is installed and equals the bundle, in every root.
    pub synced: usize,
    /// No file of the skill is installed in any root.
    pub missing: usize,
    /// Installed, but a file is missing or differs in some root.
    pub diverged: usize,
}

impl SkillFilesStatus {
    /// Skills with at least one installed file.
    pub fn installed(&self) -> usize {
        self.expected - self.missing
    }

    pub fn is_synced(&self) -> bool {
        self.expected > 0 && self.synced == self.expected
    }

    /// `synced`, `missing`, `partial` (some skills missing, none different) or `diverged`.
    pub fn label(&self) -> &'static str {
        if self.expected == 0 {
            "missing"
        } else if self.missing == 0 && self.diverged == 0 {
            "synced"
        } else if self.synced == 0 && self.diverged == 0 {
            "missing"
        } else if self.diverged == 0 {
            "partial"
        } else {
            "diverged"
        }
    }
}

/// Compares every skill of the bundle with its installed files in each of `roots`. With no root
/// there is nothing installed to compare: every skill is missing.
pub fn skill_files_status(
    bundled_root: &Path,
    home: &Path,
    roots: &[SkillRoot],
) -> Result<SkillFilesStatus, String> {
    let skills = catalog_skill_files(bundled_root)?;
    let mut status = SkillFilesStatus {
        expected: skills.len(),
        ..Default::default()
    };
    for skill in &skills {
        let (mut present, mut equal, mut total) = (0usize, 0usize, 0usize);
        for root in roots {
            for rel in &skill.files {
                let artifact = ArtifactId::skill_file(*root, skill.name.clone(), rel.clone());
                let (Ok(dest), Some(source)) = (
                    artifact.resolve_dest(home, bundled_root),
                    artifact.resolve_source(bundled_root),
                ) else {
                    continue;
                };
                total += 1;
                if dest.is_file() {
                    present += 1;
                    if file_eq(&dest, &source) {
                        equal += 1;
                    }
                }
            }
        }
        if present == 0 {
            status.missing += 1;
        } else if equal == total {
            status.synced += 1;
        } else {
            status.diverged += 1;
        }
    }
    Ok(status)
}

/// Copies of bundled skills in a root the app no longer installs into (an older version's folder).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OldSkillCopies {
    /// Skills whose `SKILL.md` is a version the app shipped: the next install removes them.
    pub owned: usize,
    /// Skills whose `SKILL.md` was edited: kept, and reported.
    pub edited: usize,
}

/// Looks at the `SKILL.md` of every bundled skill in `root`.
pub fn old_skill_copies(
    bundled_root: &Path,
    home: &Path,
    root: SkillRoot,
) -> Result<OldSkillCopies, String> {
    let skills: Vec<SkillFiles> = catalog_skill_files(bundled_root)?;
    let mut copies = OldSkillCopies::default();
    for skill in skills {
        let artifact = ArtifactId::skill_md(root, skill.name);
        let Ok(dest) = artifact.resolve_dest(home, bundled_root) else {
            continue;
        };
        if !dest.is_file() {
            continue;
        }
        let owned = artifact
            .resolve_source(bundled_root)
            .is_some_and(|source| file_eq(&dest, &source))
            || crate::stable_digest::file(&dest).is_ok_and(|digest| {
                crate::shipped_digests::is_shipped_version(&artifact, bundled_root, &digest)
            });
        if owned {
            copies.owned += 1;
        } else {
            copies.edited += 1;
        }
    }
    Ok(copies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("aw-skill-health-{label}-{nanos}"))
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// A bundle with two skills, one of them with a supporting file.
    fn bundle(label: &str) -> PathBuf {
        let bundle = temp(label);
        crate::test_env::write_canonical_skill(&bundle, None, "alpha", "body");
        crate::test_env::write_canonical_skill(&bundle, None, "beta", "body");
        write(&bundle.join("skills/beta/notes.md"), "notes");
        bundle
    }

    fn install(bundle: &Path, home: &Path, root: SkillRoot, skill: &str, rel: &str) {
        let source = bundle.join("skills").join(skill).join(rel);
        write(
            &root.path(home).unwrap().join(skill).join(rel),
            &fs::read_to_string(source).unwrap(),
        );
    }

    #[test]
    fn counts_synced_missing_and_diverged_skills_against_the_bundle() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp("counts-home");
        crate::test_env::set_test_user_dirs(&home);
        let bundle = bundle("counts");
        let roots = [SkillRoot::Claude];

        let none = skill_files_status(&bundle, &home, &roots).unwrap();
        assert_eq!(
            none,
            SkillFilesStatus {
                expected: 2,
                synced: 0,
                missing: 2,
                diverged: 0
            }
        );
        assert_eq!(none.label(), "missing");
        assert!(!none.is_synced());

        install(&bundle, &home, SkillRoot::Claude, "alpha", "SKILL.md");
        let partial = skill_files_status(&bundle, &home, &roots).unwrap();
        assert_eq!(
            (partial.synced, partial.missing, partial.diverged),
            (1, 1, 0)
        );
        assert_eq!(partial.label(), "partial");
        assert_eq!(partial.installed(), 1);

        // beta's SKILL.md without its supporting file is not a complete skill.
        install(&bundle, &home, SkillRoot::Claude, "beta", "SKILL.md");
        let incomplete = skill_files_status(&bundle, &home, &roots).unwrap();
        assert_eq!((incomplete.synced, incomplete.diverged), (1, 1));
        assert_eq!(incomplete.label(), "diverged");

        install(&bundle, &home, SkillRoot::Claude, "beta", "notes.md");
        let all = skill_files_status(&bundle, &home, &roots).unwrap();
        assert!(all.is_synced());
        assert_eq!(all.label(), "synced");

        write(
            &SkillRoot::Claude
                .path(&home)
                .unwrap()
                .join("alpha/SKILL.md"),
            "an older per-harness copy",
        );
        let edited = skill_files_status(&bundle, &home, &roots).unwrap();
        assert_eq!((edited.synced, edited.diverged), (1, 1));
        assert!(!edited.is_synced());

        // A skill that is in some other root does not count for these roots.
        let elsewhere = skill_files_status(&bundle, &home, &[SkillRoot::Agents]).unwrap();
        assert_eq!(elsewhere.missing, 2);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&bundle);
    }

    #[test]
    fn a_skill_read_from_two_roots_is_synced_only_when_both_copies_are() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp("two-roots-home");
        crate::test_env::set_test_user_dirs(&home);
        let bundle = bundle("two-roots");
        let roots = [SkillRoot::Claude, SkillRoot::Agents];
        for skill in ["alpha", "beta"] {
            install(&bundle, &home, SkillRoot::Claude, skill, "SKILL.md");
        }
        install(&bundle, &home, SkillRoot::Claude, "beta", "notes.md");
        for (skill, rel) in [("alpha", "SKILL.md"), ("beta", "SKILL.md")] {
            install(&bundle, &home, SkillRoot::Agents, skill, rel);
        }
        let status = skill_files_status(&bundle, &home, &roots).unwrap();
        assert_eq!(
            (status.synced, status.diverged),
            (1, 1),
            "beta lacks notes.md in ~/.agents"
        );
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&bundle);
    }

    #[test]
    fn old_copies_are_owned_when_current_or_a_shipped_version_and_edited_otherwise() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp("old-copies-home");
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        let bundle = bundle("old-copies");
        install(&bundle, &home, SkillRoot::CodexHome, "alpha", "SKILL.md");
        write(
            &SkillRoot::CodexHome
                .path(&home)
                .unwrap()
                .join("beta/SKILL.md"),
            "my own beta",
        );
        // Codex's own skills below the folder are never looked at.
        write(
            &SkillRoot::CodexHome
                .path(&home)
                .unwrap()
                .join(".system/alpha/SKILL.md"),
            "codex",
        );
        let copies = old_skill_copies(&bundle, &home, SkillRoot::CodexHome).unwrap();
        assert_eq!(
            copies,
            OldSkillCopies {
                owned: 1,
                edited: 1
            }
        );
        assert_eq!(
            old_skill_copies(&bundle, &home, SkillRoot::Agents).unwrap(),
            OldSkillCopies::default()
        );
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&bundle);
    }
}
