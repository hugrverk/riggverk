//! Folders skills are installed into, and which of them the enabled harnesses need.
//!
//! A skill is installed as a whole directory (`SKILL.md` plus supporting files) below one of the
//! roots. Which roots get a copy is decided per READ FOLDER, not per harness: [`install_roots`]
//! picks the fewest folders that every enabled harness reads, so one skill is not installed twice
//! for a harness that reads both folders. The roots are re-evaluated on every plan from the
//! enabled harnesses ([`SkillScope::current`]); nothing is written when a harness is toggled.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_skill_targets::{codex_global_skills_dest, codex_home, codex_legacy_skills_dest};
use crate::agent_targets::HarnessId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillRoot {
    /// `~/.claude/skills` (`CLAUDE_SKILLS_PATH` when set)
    Claude,
    /// `~/.agents/skills`: read by Codex, OpenCode and Cursor
    Agents,
    /// `$CODEX_HOME/skills` (`CODEX_SKILLS_PATH` when set). Installed into only when `CODEX_HOME`
    /// is customised; otherwise a folder older versions filled and that is cleaned up.
    CodexHome,
    /// `~/.config/opencode/skills` (`OPENCODE_SKILLS_PATH` when set): older versions only
    OpenCode,
    /// The skills folder of the Cursor profile (`CURSOR_SKILLS_PATH` when set): older versions only
    Cursor,
}

impl SkillRoot {
    /// Every root an artifact can name. Uninstall and adoption of old installs look at all of
    /// them; planning looks at the roots of a [`SkillScope`].
    pub const ALL: [SkillRoot; 5] = [
        SkillRoot::Claude,
        SkillRoot::Agents,
        SkillRoot::CodexHome,
        SkillRoot::OpenCode,
        SkillRoot::Cursor,
    ];

    /// Short name used in backup identifiers and labels.
    pub fn label(self) -> &'static str {
        match self {
            SkillRoot::Claude => "claude",
            SkillRoot::Agents => "agents",
            SkillRoot::CodexHome => "codex-home",
            SkillRoot::OpenCode => "opencode",
            SkillRoot::Cursor => "cursor",
        }
    }

    /// The folder as people know it, for labels: `~/.claude/skills`. A folder that moves with
    /// an environment variable or the Cursor profile is named by that, not by today's value.
    pub fn display(self) -> &'static str {
        match self {
            SkillRoot::Claude => "~/.claude/skills",
            SkillRoot::Agents => "~/.agents/skills",
            SkillRoot::CodexHome => "$CODEX_HOME/skills",
            SkillRoot::OpenCode => "~/.config/opencode/skills",
            SkillRoot::Cursor => "~/.cursor/skills",
        }
    }

    /// The folder every skill of this root lives under.
    pub fn path(self, home: &Path) -> Result<PathBuf, String> {
        match self {
            SkillRoot::Claude => Ok(override_dir("CLAUDE_SKILLS_PATH", home)
                .unwrap_or_else(|| home.join(".claude/skills"))),
            SkillRoot::Agents => Ok(codex_legacy_skills_dest(home)),
            SkillRoot::CodexHome => {
                let skills = codex_global_skills_dest(home);
                if skills.is_absolute() {
                    Ok(skills)
                } else {
                    Err(format!(
                        "Codex skills destination must be an absolute path (check CODEX_HOME and CODEX_SKILLS_PATH): {}",
                        skills.display()
                    ))
                }
            }
            SkillRoot::OpenCode => Ok(override_dir("OPENCODE_SKILLS_PATH", home)
                .unwrap_or_else(|| home.join(".config/opencode/skills"))),
            SkillRoot::Cursor => match override_dir("CURSOR_SKILLS_PATH", home) {
                Some(path) => Ok(path),
                None => Ok(crate::cursor_profile_paths::resolve_cursor_profile_paths()?.skills),
            },
        }
    }
}

/// A skills folder named by an environment variable. Only an absolute path inside the home folder
/// counts: the installer writes below `home` only, and a relative value would resolve against
/// the working directory of the app. Anything else is ignored, so the default folder is used.
fn override_dir(variable: &str, home: &Path) -> Option<PathBuf> {
    let value = std::env::var(variable).ok()?;
    if value.trim().is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    let plain = path
        .components()
        .all(|component| !matches!(component, Component::ParentDir | Component::CurDir));
    (path.is_absolute() && plain && path.starts_with(home) && path != home).then_some(path)
}

/// A folder some harness reads skills from. A superset of [`SkillRoot`]: `DotCodex` is read by
/// Cursor but the app never installs into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadFolder {
    Claude,
    Agents,
    CodexHome,
    /// The literal `~/.codex/skills`, whatever `CODEX_HOME` says
    DotCodex,
    OpenCode,
    Cursor,
}

impl ReadFolder {
    pub const ALL: [ReadFolder; 6] = [
        ReadFolder::Claude,
        ReadFolder::Agents,
        ReadFolder::CodexHome,
        ReadFolder::DotCodex,
        ReadFolder::OpenCode,
        ReadFolder::Cursor,
    ];

    /// The install root that is this folder, when the app can install into it.
    pub fn root(self) -> Option<SkillRoot> {
        match self {
            ReadFolder::Claude => Some(SkillRoot::Claude),
            ReadFolder::Agents => Some(SkillRoot::Agents),
            ReadFolder::CodexHome => Some(SkillRoot::CodexHome),
            ReadFolder::OpenCode => Some(SkillRoot::OpenCode),
            ReadFolder::Cursor => Some(SkillRoot::Cursor),
            ReadFolder::DotCodex => None,
        }
    }
}

/// The folders a harness reads personal (global) skills from. `$CODEX_HOME/skills` is deprecated
/// for Codex but still read (`.system` below it is Codex's own and never touched).
pub fn readers(harness: HarnessId) -> &'static [ReadFolder] {
    match harness {
        HarnessId::Claude => &[ReadFolder::Claude],
        HarnessId::Codex => &[ReadFolder::Agents, ReadFolder::CodexHome],
        HarnessId::OpenCode => &[ReadFolder::Claude, ReadFolder::Agents, ReadFolder::OpenCode],
        HarnessId::Cursor => &[
            ReadFolder::Cursor,
            ReadFolder::Agents,
            ReadFolder::Claude,
            ReadFolder::DotCodex,
        ],
    }
}

/// Whether Codex reads from a customised home: `CODEX_SKILLS_PATH` is set or `CODEX_HOME` is
/// somewhere other than `~/.codex`. A customised home is isolated on purpose, so skills for
/// Codex then live inside it.
pub fn codex_home_is_custom(home: &Path) -> bool {
    let skills_path_set = std::env::var("CODEX_SKILLS_PATH")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    skills_path_set || codex_home(home) != home.join(".codex")
}

/// The roots that get a copy of every skill, from the enabled harnesses. Pure.
///
/// 1. Claude enabled: `~/.claude/skills`.
/// 2. Codex enabled: `$CODEX_HOME/skills` with a customised `CODEX_HOME`, else `~/.agents/skills`.
/// 3. OpenCode or Cursor enabled while neither `~/.claude/skills` nor `~/.agents/skills` is in
///    the set: `~/.claude/skills` when Codex is enabled with a customised home (so Codex never
///    reads an installed copy outside its isolated home), else `~/.agents/skills`.
///
/// Every enabled harness then reads at least one installed root, Codex never reads two, and with
/// a customised `CODEX_HOME` Codex reads no installed copy outside `$CODEX_HOME/skills`.
pub fn install_roots(enabled: &[HarnessId], codex_custom: bool) -> Vec<SkillRoot> {
    let on = |harness| enabled.contains(&harness);
    let mut roots = Vec::new();
    if on(HarnessId::Claude) {
        roots.push(SkillRoot::Claude);
    }
    if on(HarnessId::Codex) {
        roots.push(if codex_custom {
            SkillRoot::CodexHome
        } else {
            SkillRoot::Agents
        });
    }
    if (on(HarnessId::OpenCode) || on(HarnessId::Cursor))
        && !roots.contains(&SkillRoot::Claude)
        && !roots.contains(&SkillRoot::Agents)
    {
        roots.push(if on(HarnessId::Codex) && codex_custom {
            SkillRoot::Claude
        } else {
            SkillRoot::Agents
        });
    }
    roots.sort_by_key(|root| {
        SkillRoot::ALL
            .iter()
            .position(|candidate| candidate == root)
    });
    roots
}

/// The roots skills are wanted in. Everything else is a root older versions (or a harness that
/// is switched off) may have filled and that is cleaned up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillScope {
    roots: Vec<SkillRoot>,
    harnesses: Vec<HarnessId>,
}

impl SkillScope {
    /// Every root: for uninstall, adoption of old installs and the bundle fingerprint, which must
    /// see all copies and not depend on settings.
    pub fn all() -> Self {
        Self {
            roots: SkillRoot::ALL.to_vec(),
            harnesses: HarnessId::ALL.to_vec(),
        }
    }

    pub fn for_harnesses(enabled: &[HarnessId], codex_custom: bool) -> Self {
        Self {
            roots: install_roots(enabled, codex_custom),
            harnesses: enabled.to_vec(),
        }
    }

    /// A scope of exactly these roots, for tests that do not depend on the settings.
    #[cfg(test)]
    pub fn of(roots: &[SkillRoot]) -> Self {
        Self {
            roots: roots.to_vec(),
            harnesses: HarnessId::ALL.to_vec(),
        }
    }

    /// The scope for the harnesses enabled in the settings and the Codex home of this process.
    /// Fails when the settings cannot be read: planning removals from a guessed set of harnesses
    /// could delete copies a harness still needs.
    pub fn current(home: &Path) -> Result<Self, String> {
        let settings = crate::settings::try_load()
            .map_err(|error| format!("cannot tell which harnesses are enabled: {error}"))?;
        let mut scope =
            Self::for_harnesses(&settings.enabled_harness_ids, codex_home_is_custom(home));
        // Two roots that are one folder (an environment variable pointing at another root) are
        // one root: the first keeps the folder.
        let mut seen: Vec<PathBuf> = Vec::new();
        let mut unique = Vec::new();
        for root in scope.roots.drain(..) {
            let path = root.path(home)?;
            if !seen.contains(&path) {
                seen.push(path);
                unique.push(root);
            }
        }
        scope.roots = unique;
        Ok(scope)
    }

    pub fn roots(&self) -> &[SkillRoot] {
        &self.roots
    }

    /// The harnesses the roots were chosen for.
    pub fn harnesses(&self) -> &[HarnessId] {
        &self.harnesses
    }

    pub fn contains(&self, root: SkillRoot) -> bool {
        self.roots.contains(&root)
    }

    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }
}

/// The installed roots of `scope` that `harness` reads. Empty when none is installed for it.
pub fn roots_read_by(harness: HarnessId, scope: &SkillScope) -> Vec<SkillRoot> {
    scope
        .roots()
        .iter()
        .copied()
        .filter(|root| {
            readers(harness)
                .iter()
                .any(|folder| folder.root() == Some(*root))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: HarnessId = HarnessId::Claude;
    const X: HarnessId = HarnessId::Codex;
    const O: HarnessId = HarnessId::OpenCode;
    const U: HarnessId = HarnessId::Cursor;

    /// All 15 non-empty subsets of the four harnesses.
    fn subsets() -> Vec<Vec<HarnessId>> {
        let all = [C, X, O, U];
        (1u8..16)
            .map(|mask| {
                all.iter()
                    .enumerate()
                    .filter(|(index, _)| mask & (1 << index) != 0)
                    .map(|(_, harness)| *harness)
                    .collect()
            })
            .collect()
    }

    fn name(subset: &[HarnessId]) -> String {
        subset
            .iter()
            .map(|harness| harness.as_str())
            .collect::<Vec<_>>()
            .join("+")
    }

    #[test]
    fn roots_serialize_as_stable_snake_case_names() {
        for (root, name) in [
            (SkillRoot::Claude, "claude"),
            (SkillRoot::Agents, "agents"),
            (SkillRoot::CodexHome, "codex_home"),
            (SkillRoot::OpenCode, "open_code"),
            (SkillRoot::Cursor, "cursor"),
        ] {
            assert_eq!(serde_json::to_string(&root).unwrap(), format!("\"{name}\""));
        }
    }

    #[test]
    fn install_roots_follow_the_table_for_the_default_and_a_custom_codex_home() {
        use SkillRoot::{Agents as F2, Claude as F1, CodexHome as F3};
        // (enabled, default CODEX_HOME, custom CODEX_HOME)
        let table: Vec<(Vec<HarnessId>, Vec<SkillRoot>, Vec<SkillRoot>)> = vec![
            (vec![C], vec![F1], vec![F1]),
            (vec![X], vec![F2], vec![F3]),
            (vec![O], vec![F2], vec![F2]),
            (vec![U], vec![F2], vec![F2]),
            (vec![C, X], vec![F1, F2], vec![F1, F3]),
            (vec![C, O], vec![F1], vec![F1]),
            (vec![C, U], vec![F1], vec![F1]),
            (vec![X, O], vec![F2], vec![F3, F1]),
            (vec![X, U], vec![F2], vec![F3, F1]),
            (vec![O, U], vec![F2], vec![F2]),
            (vec![C, X, O], vec![F1, F2], vec![F1, F3]),
            (vec![C, X, U], vec![F1, F2], vec![F1, F3]),
            (vec![C, O, U], vec![F1], vec![F1]),
            (vec![X, O, U], vec![F2], vec![F3, F1]),
            (vec![C, X, O, U], vec![F1, F2], vec![F1, F3]),
        ];
        assert_eq!(table.len(), 15);
        for (enabled, default, custom) in table {
            let sorted = |mut roots: Vec<SkillRoot>| {
                roots.sort_by_key(|root| SkillRoot::ALL.iter().position(|c| c == root));
                roots
            };
            assert_eq!(
                install_roots(&enabled, false),
                sorted(default),
                "default {}",
                name(&enabled)
            );
            assert_eq!(
                install_roots(&enabled, true),
                sorted(custom),
                "custom {}",
                name(&enabled)
            );
        }
    }

    #[test]
    fn nothing_is_installed_when_no_harness_is_enabled() {
        assert!(install_roots(&[], false).is_empty());
        assert!(install_roots(&[], true).is_empty());
    }

    #[test]
    fn every_enabled_harness_reads_an_installed_root_in_every_subset() {
        for custom in [false, true] {
            for subset in subsets() {
                let scope = SkillScope::for_harnesses(&subset, custom);
                for harness in &subset {
                    assert!(
                        !roots_read_by(*harness, &scope).is_empty(),
                        "{} reads no installed root (custom: {custom}): {:?}",
                        harness.as_str(),
                        scope.roots()
                    );
                }
            }
        }
    }

    #[test]
    fn codex_never_reads_two_installed_roots_in_any_subset() {
        for custom in [false, true] {
            for subset in subsets().into_iter().filter(|subset| subset.contains(&X)) {
                let scope = SkillScope::for_harnesses(&subset, custom);
                assert_eq!(
                    roots_read_by(X, &scope).len(),
                    1,
                    "{} (custom: {custom}): {:?}",
                    name(&subset),
                    scope.roots()
                );
            }
        }
    }

    #[test]
    fn a_custom_codex_home_never_reads_an_installed_copy_outside_itself() {
        for subset in subsets().into_iter().filter(|subset| subset.contains(&X)) {
            let scope = SkillScope::for_harnesses(&subset, true);
            assert_eq!(
                roots_read_by(X, &scope),
                vec![SkillRoot::CodexHome],
                "{}: {:?}",
                name(&subset),
                scope.roots()
            );
        }
    }

    #[test]
    fn only_installable_roots_are_ever_chosen_and_never_the_old_harness_folders() {
        for custom in [false, true] {
            for subset in subsets() {
                for root in install_roots(&subset, custom) {
                    assert!(
                        matches!(
                            root,
                            SkillRoot::Claude | SkillRoot::Agents | SkillRoot::CodexHome
                        ),
                        "{root:?} for {}",
                        name(&subset)
                    );
                }
                // The default Codex home is only read through ~/.agents/skills.
                if !custom {
                    assert!(!install_roots(&subset, false).contains(&SkillRoot::CodexHome));
                }
            }
        }
    }

    #[test]
    fn the_reader_table_matches_what_each_harness_reads() {
        assert_eq!(readers(C), &[ReadFolder::Claude]);
        assert_eq!(readers(X), &[ReadFolder::Agents, ReadFolder::CodexHome]);
        assert_eq!(
            readers(O),
            &[ReadFolder::Claude, ReadFolder::Agents, ReadFolder::OpenCode]
        );
        assert_eq!(
            readers(U),
            &[
                ReadFolder::Cursor,
                ReadFolder::Agents,
                ReadFolder::Claude,
                ReadFolder::DotCodex
            ]
        );
        assert_eq!(ReadFolder::DotCodex.root(), None);
    }

    #[test]
    fn the_scope_of_all_roots_does_not_depend_on_settings() {
        assert_eq!(SkillScope::all().roots(), &SkillRoot::ALL);
    }

    #[test]
    fn a_codex_home_is_custom_when_it_moves_or_the_skills_path_is_set() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = std::env::temp_dir().join("aw-custom-codex-home-user");
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::remove_var("CODEX_SKILLS_PATH");
        }
        assert!(!codex_home_is_custom(&home));
        unsafe { std::env::set_var("CODEX_HOME", home.join(".codex")) };
        assert!(
            !codex_home_is_custom(&home),
            "the default location spelled out"
        );
        unsafe { std::env::set_var("CODEX_HOME", home.join("isolated-codex")) };
        assert!(codex_home_is_custom(&home));
        unsafe {
            std::env::remove_var("CODEX_HOME");
            std::env::set_var("CODEX_SKILLS_PATH", home.join("my-skills"));
        }
        assert!(codex_home_is_custom(&home));
        unsafe { std::env::set_var("CODEX_SKILLS_PATH", "   ") };
        assert!(!codex_home_is_custom(&home), "a blank value is no value");
    }

    #[test]
    fn a_skills_folder_override_is_used_only_inside_the_home_folder() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = std::env::temp_dir().join("aw-skill-root-override-home");
        let _ = std::fs::create_dir_all(&home);
        crate::test_env::set_test_user_dirs(&home);
        for variable in [
            "CLAUDE_SKILLS_PATH",
            "OPENCODE_SKILLS_PATH",
            "CURSOR_SKILLS_PATH",
        ] {
            unsafe { std::env::remove_var(variable) };
        }
        let default = |root: SkillRoot| root.path(&home).unwrap();
        assert_eq!(default(SkillRoot::Claude), home.join(".claude/skills"));
        assert_eq!(
            default(SkillRoot::OpenCode),
            home.join(".config/opencode/skills")
        );
        assert_eq!(default(SkillRoot::Cursor), home.join(".cursor/skills"));

        for (variable, root) in [
            ("CLAUDE_SKILLS_PATH", SkillRoot::Claude),
            ("OPENCODE_SKILLS_PATH", SkillRoot::OpenCode),
            ("CURSOR_SKILLS_PATH", SkillRoot::Cursor),
        ] {
            let inside = home.join("elsewhere").join(variable);
            unsafe { std::env::set_var(variable, &inside) };
            assert_eq!(root.path(&home).unwrap(), inside, "{variable}");
            for rejected in [
                "relative/skills".to_string(),
                "/etc/skills".to_string(),
                home.display().to_string(),
                format!("{}/../outside", home.display()),
                "   ".to_string(),
            ] {
                unsafe { std::env::set_var(variable, &rejected) };
                assert_eq!(
                    root.path(&home).unwrap(),
                    default(root),
                    "{variable}={rejected:?} falls back to the default"
                );
            }
            unsafe { std::env::remove_var(variable) };
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
