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
    /// `~/.agents/skills`: read by Codex, OpenCode, Cursor, Kilo, Copilot and Pi
    Agents,
    /// `$CODEX_HOME/skills` (`CODEX_SKILLS_PATH` when set). Installed into only when `CODEX_HOME`
    /// is customised; otherwise a folder older versions filled and that is cleaned up.
    CodexHome,
    /// `skills` in the OpenCode config folder (`~/.config/opencode`, or
    /// `$XDG_CONFIG_HOME/opencode`; `OPENCODE_SKILLS_PATH` when set): older versions only
    OpenCode,
    /// The skills folder of the Cursor profile (`CURSOR_SKILLS_PATH` when set): older versions only
    Cursor,
    /// `~/.gemini/config/skills`: read by the Antigravity App and IDE only. Installed into only
    /// while Antigravity is enabled (the one light harness with folders of its own, see
    /// [`install_roots`]).
    AntigravityApp,
    /// `~/.gemini/antigravity-cli/skills`: read by the Antigravity CLI (`agy`) only, under the
    /// same rule.
    AntigravityCli,
}

impl SkillRoot {
    /// Every root an artifact can name. Uninstall and adoption of old installs look at all of
    /// them; planning looks at the roots of a [`SkillScope`].
    pub const ALL: [SkillRoot; 7] = [
        SkillRoot::Claude,
        SkillRoot::Agents,
        SkillRoot::CodexHome,
        SkillRoot::OpenCode,
        SkillRoot::Cursor,
        SkillRoot::AntigravityApp,
        SkillRoot::AntigravityCli,
    ];

    /// Short name used in backup identifiers and labels.
    pub fn label(self) -> &'static str {
        match self {
            SkillRoot::Claude => "claude",
            SkillRoot::Agents => "agents",
            SkillRoot::CodexHome => "codex-home",
            SkillRoot::OpenCode => "opencode",
            SkillRoot::Cursor => "cursor",
            SkillRoot::AntigravityApp => "antigravity-app",
            SkillRoot::AntigravityCli => "antigravity-cli",
        }
    }

    /// The folder as people know it, for labels: `~/.claude/skills`. A folder that moves with
    /// an environment variable or the Cursor profile is named by that, not by today's value.
    pub fn display(self) -> &'static str {
        match self {
            SkillRoot::Claude => "~/.claude/skills",
            SkillRoot::Agents => "~/.agents/skills",
            SkillRoot::CodexHome => "$CODEX_HOME/skills",
            SkillRoot::OpenCode => {
                let moved = crate::platform_paths::resolve_user_home(
                    &crate::platform_paths::PlatformEnv::from_process_env(),
                    crate::platform_paths::Platform::current(),
                )
                .is_ok_and(|home| crate::platform_paths::opencode_config_moved(&home));
                if moved {
                    "$XDG_CONFIG_HOME/opencode/skills"
                } else {
                    "~/.config/opencode/skills"
                }
            }
            SkillRoot::Cursor => "~/.cursor/skills",
            SkillRoot::AntigravityApp => "~/.gemini/config/skills",
            SkillRoot::AntigravityCli => "~/.gemini/antigravity-cli/skills",
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
            SkillRoot::OpenCode => Ok(override_dir("OPENCODE_SKILLS_PATH", home).unwrap_or_else(
                || crate::platform_paths::opencode_config_dir(home).join("skills"),
            )),
            SkillRoot::Cursor => match override_dir("CURSOR_SKILLS_PATH", home) {
                Some(path) => Ok(path),
                None => Ok(crate::cursor_profile_paths::resolve_cursor_profile_paths()?.skills),
            },
            // Fixed below the home folder: no environment variable moves them (none is
            // documented), so the app writes nowhere but the two folders Antigravity reads.
            SkillRoot::AntigravityApp => Ok(home.join(".gemini/config/skills")),
            SkillRoot::AntigravityCli => Ok(home.join(".gemini/antigravity-cli/skills")),
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
/// Cursor, and Copilot, Pi and Kilo each have a folder of their own (`Copilot`, `PiAgent`,
/// `Kilo`); the app never installs into any of them. Antigravity's two folders are install roots.
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
    /// `~/.copilot/skills`: private to Copilot CLI (`COPILOT_HOME` moves the real one)
    Copilot,
    /// `~/.pi/agent/skills`: private to Pi (`PI_CODING_AGENT_DIR` moves the real one)
    PiAgent,
    /// `~/.kilo/skills`: private to Kilo
    Kilo,
    /// `~/.gemini/config/skills`: the Antigravity App and IDE (an install root)
    AntigravityApp,
    /// `~/.gemini/antigravity-cli/skills`: the Antigravity CLI (an install root)
    AntigravityCli,
    /// `~/.grok/skills`: private to Grok Build (`GROK_HOME` moves the real one)
    Grok,
}

impl ReadFolder {
    pub const ALL: [ReadFolder; 12] = [
        ReadFolder::Claude,
        ReadFolder::Agents,
        ReadFolder::CodexHome,
        ReadFolder::DotCodex,
        ReadFolder::OpenCode,
        ReadFolder::Cursor,
        ReadFolder::Copilot,
        ReadFolder::PiAgent,
        ReadFolder::Kilo,
        ReadFolder::AntigravityApp,
        ReadFolder::AntigravityCli,
        ReadFolder::Grok,
    ];

    /// The install root that is this folder, when the app can install into it.
    pub fn root(self) -> Option<SkillRoot> {
        match self {
            ReadFolder::Claude => Some(SkillRoot::Claude),
            ReadFolder::Agents => Some(SkillRoot::Agents),
            ReadFolder::CodexHome => Some(SkillRoot::CodexHome),
            ReadFolder::OpenCode => Some(SkillRoot::OpenCode),
            ReadFolder::Cursor => Some(SkillRoot::Cursor),
            ReadFolder::AntigravityApp => Some(SkillRoot::AntigravityApp),
            ReadFolder::AntigravityCli => Some(SkillRoot::AntigravityCli),
            ReadFolder::DotCodex
            | ReadFolder::Copilot
            | ReadFolder::PiAgent
            | ReadFolder::Kilo
            | ReadFolder::Grok => None,
        }
    }

    /// Where a folder the app never installs into is, below `home`. These locations are fixed:
    /// the environment variables that move the real folders are not followed.
    pub fn fixed_path(self, home: &Path) -> Option<PathBuf> {
        match self {
            ReadFolder::DotCodex => Some(home.join(".codex/skills")),
            ReadFolder::Copilot => Some(home.join(".copilot/skills")),
            ReadFolder::PiAgent => Some(home.join(".pi/agent/skills")),
            ReadFolder::Kilo => Some(home.join(".kilo/skills")),
            ReadFolder::Grok => Some(home.join(".grok/skills")),
            _ => None,
        }
    }
}

/// The folders a harness reads personal (global) skills from. `$CODEX_HOME/skills` is deprecated
/// for Codex but still read (`.system` below it is Codex's own and never touched).
///
/// For Copilot, Pi, Kilo and Grok the order is their precedence for one skill name, highest first:
/// the first folder holding a name wins and hides the others (checked against Copilot CLI 1.0.98,
/// Pi 1.3.0 and Kilo 7.8.12). Grok Build's user guide (`08-skills`) documents a dedupe by name
/// with a priority; its order here, own folder first, is not checked against a Grok build. The
/// other harnesses' order carries no such meaning.
///
/// - Copilot CLI reads `~/.agents/skills` and its own `~/.copilot/skills`, not `~/.claude/skills`.
/// - Pi reads `~/.agents/skills` and `<agent dir>/skills`, not `~/.claude/skills`.
/// - Kilo reads `~/.claude/skills` and `~/.agents/skills` by default, and `~/.kilo/skills`.
/// - Antigravity reads neither shared folder: the App and IDE read `~/.gemini/config/skills`, the
///   CLI `~/.gemini/antigravity-cli/skills`. Each surface reads one folder, so the order carries
///   no precedence.
/// - Grok Build reads `~/.grok/skills`, `~/.agents/skills` and (Claude compatibility, on by
///   default) `~/.claude/skills`.
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
        HarnessId::Copilot => &[ReadFolder::Copilot, ReadFolder::Agents],
        HarnessId::Pi => &[ReadFolder::PiAgent, ReadFolder::Agents],
        HarnessId::Kilo => &[ReadFolder::Kilo, ReadFolder::Agents, ReadFolder::Claude],
        HarnessId::Antigravity => &[ReadFolder::AntigravityApp, ReadFolder::AntigravityCli],
        HarnessId::Grok => &[ReadFolder::Grok, ReadFolder::Agents, ReadFolder::Claude],
    }
}

/// Whether `harness` keeps one copy of a skill name found in several of its folders, chosen by
/// the folder order of [`readers`] (first wins), instead of loading them all or picking one at
/// random.
pub fn resolves_duplicates_by_folder_order(harness: HarnessId) -> bool {
    matches!(
        harness,
        HarnessId::Copilot | HarnessId::Pi | HarnessId::Kilo | HarnessId::Grok
    )
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
/// 3. OpenCode, Cursor, Kilo or Grok enabled while neither `~/.claude/skills` nor `~/.agents/skills` is
///    in the set: `~/.claude/skills` when Codex is enabled with a customised home (so Codex never
///    reads an installed copy outside its isolated home), else `~/.agents/skills`.
/// 4. Copilot or Pi enabled, which read `~/.agents/skills` and no other shared folder:
///    `~/.agents/skills`, unless Codex is enabled with a customised home. Isolation wins there:
///    the harness is then [`unserved`].
/// 5. Antigravity enabled, which reads no shared folder: its two own folders,
///    `~/.gemini/config/skills` (App and IDE) and `~/.gemini/antigravity-cli/skills` (CLI). No
///    other harness reads them, so they never change what another harness loads. This is the one
///    exception to "the light tier adds no install folder" (`docs/WORKSPACE_CONTRACT.md`).
///
/// Every enabled harness then reads at least one installed root, except an [`unserved`] one; Codex
/// never reads two, and with a customised `CODEX_HOME` Codex reads no installed copy outside
/// `$CODEX_HOME/skills`.
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
    if (on(HarnessId::OpenCode)
        || on(HarnessId::Cursor)
        || on(HarnessId::Kilo)
        || on(HarnessId::Grok))
        && !roots.contains(&SkillRoot::Claude)
        && !roots.contains(&SkillRoot::Agents)
    {
        roots.push(if on(HarnessId::Codex) && codex_custom {
            SkillRoot::Claude
        } else {
            SkillRoot::Agents
        });
    }
    if (on(HarnessId::Copilot) || on(HarnessId::Pi))
        && !roots.contains(&SkillRoot::Agents)
        && !(on(HarnessId::Codex) && codex_custom)
    {
        roots.push(SkillRoot::Agents);
    }
    if on(HarnessId::Antigravity) {
        roots.push(SkillRoot::AntigravityApp);
        roots.push(SkillRoot::AntigravityCli);
    }
    roots.sort_by_key(|root| {
        SkillRoot::ALL
            .iter()
            .position(|candidate| candidate == root)
    });
    roots
}

/// The enabled harnesses that read no root [`install_roots`] picks, in [`HarnessId::ALL`] order.
/// Only Copilot and Pi can be among them, and only while Codex is enabled with a customised home:
/// that isolation is kept, so no shared folder is installed for them.
pub fn unserved(enabled: &[HarnessId], codex_custom: bool) -> Vec<HarnessId> {
    let scope = SkillScope::for_harnesses(enabled, codex_custom);
    HarnessId::ALL
        .iter()
        .copied()
        .filter(|harness| enabled.contains(harness) && roots_read_by(*harness, &scope).is_empty())
        .collect()
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
    /// Copilot, Pi and Kilo.
    const P: HarnessId = HarnessId::Copilot;
    const I: HarnessId = HarnessId::Pi;
    const K: HarnessId = HarnessId::Kilo;
    /// Antigravity, the one light harness with install folders of its own.
    const A: HarnessId = HarnessId::Antigravity;
    const ANTIGRAVITY_ROOTS: [SkillRoot; 2] =
        [SkillRoot::AntigravityApp, SkillRoot::AntigravityCli];
    const G: HarnessId = HarnessId::Grok;

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
            (SkillRoot::AntigravityApp, "antigravity_app"),
            (SkillRoot::AntigravityCli, "antigravity_cli"),
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
    fn the_light_harnesses_read_what_their_clis_were_seen_to_read() {
        // Copilot CLI 1.0.98: ~/.agents/skills and ~/.copilot/skills; ~/.claude/skills is not read.
        assert_eq!(readers(P), &[ReadFolder::Copilot, ReadFolder::Agents]);
        // Pi 1.3.0: ~/.agents/skills and <agent dir>/skills; ~/.claude/skills is not read.
        assert_eq!(readers(I), &[ReadFolder::PiAgent, ReadFolder::Agents]);
        // Kilo 7.8.12 reads ~/.claude/skills and ~/.agents/skills by default (no toggle needed).
        assert_eq!(
            readers(K),
            &[ReadFolder::Kilo, ReadFolder::Agents, ReadFolder::Claude]
        );
        // Antigravity reads neither shared folder: the App and IDE read ~/.gemini/config/skills,
        // the CLI ~/.gemini/antigravity-cli/skills; both are install roots.
        assert_eq!(
            readers(A),
            &[ReadFolder::AntigravityApp, ReadFolder::AntigravityCli]
        );
        assert_eq!(
            ReadFolder::AntigravityApp.root(),
            Some(SkillRoot::AntigravityApp)
        );
        assert_eq!(
            ReadFolder::AntigravityCli.root(),
            Some(SkillRoot::AntigravityCli)
        );
        // Grok Build (user guide, skills page): ~/.grok/skills, ~/.agents/skills and, with its
        // Claude compatibility (on by default), ~/.claude/skills.
        assert_eq!(
            readers(G),
            &[ReadFolder::Grok, ReadFolder::Agents, ReadFolder::Claude]
        );
        for harness in [P, I, K, G] {
            assert!(resolves_duplicates_by_folder_order(harness));
        }
        for harness in [C, X, O, U, A] {
            assert!(!resolves_duplicates_by_folder_order(harness));
        }
    }

    #[test]
    fn folders_the_app_never_installs_into_have_a_fixed_place_below_home() {
        let home = Path::new("/home/someone");
        for folder in ReadFolder::ALL {
            assert_eq!(
                folder.fixed_path(home).is_some(),
                folder.root().is_none(),
                "{folder:?}"
            );
        }
        let fixed = |folder: ReadFolder| folder.fixed_path(home).unwrap();
        assert_eq!(fixed(ReadFolder::DotCodex), home.join(".codex/skills"));
        assert_eq!(fixed(ReadFolder::Copilot), home.join(".copilot/skills"));
        assert_eq!(fixed(ReadFolder::PiAgent), home.join(".pi/agent/skills"));
        assert_eq!(fixed(ReadFolder::Kilo), home.join(".kilo/skills"));
        assert_eq!(fixed(ReadFolder::Grok), home.join(".grok/skills"));
        for (folder, name) in [
            (ReadFolder::Copilot, "copilot"),
            (ReadFolder::PiAgent, "pi_agent"),
            (ReadFolder::Kilo, "kilo"),
            (ReadFolder::Grok, "grok"),
        ] {
            assert_eq!(
                serde_json::to_string(&folder).unwrap(),
                format!("\"{name}\"")
            );
        }
    }

    #[test]
    fn the_light_tier_adds_install_roots_for_antigravity_only() {
        // Worst-case transactions are bounded by the roots. Copilot, Pi and Kilo share the
        // existing ones; Antigravity reads no shared folder, so it adds its two own and nothing
        // else (the owner-approved exception in docs/WORKSPACE_CONTRACT.md).
        assert_eq!(SkillRoot::ALL.len(), 7);
        assert_eq!(
            SkillRoot::ALL
                .iter()
                .filter(|root| ReadFolder::ALL
                    .iter()
                    .any(|folder| folder.root() == Some(**root)))
                .count(),
            7
        );
        for harness in HarnessId::ALL {
            let own: Vec<SkillRoot> = readers(*harness)
                .iter()
                .filter_map(|folder| folder.root())
                .filter(|root| ANTIGRAVITY_ROOTS.contains(root))
                .collect();
            if *harness == A {
                assert_eq!(own, ANTIGRAVITY_ROOTS);
            } else {
                assert!(own.is_empty(), "{harness:?} reads an Antigravity folder");
            }
        }
        let home = Path::new("/home/someone");
        assert_eq!(
            SkillRoot::AntigravityApp.path(home).unwrap(),
            home.join(".gemini/config/skills")
        );
        assert_eq!(
            SkillRoot::AntigravityCli.path(home).unwrap(),
            home.join(".gemini/antigravity-cli/skills")
        );
        assert_eq!(
            SkillRoot::AntigravityApp.display(),
            "~/.gemini/config/skills"
        );
        assert_eq!(
            SkillRoot::AntigravityCli.display(),
            "~/.gemini/antigravity-cli/skills"
        );
    }

    #[test]
    fn install_roots_for_the_light_tier_follow_the_table() {
        use SkillRoot::{
            Agents as F2, AntigravityApp as G1, AntigravityCli as G2, Claude as F1, CodexHome as F3,
        };
        // (enabled, default CODEX_HOME, custom CODEX_HOME, unserved with a custom CODEX_HOME)
        #[allow(clippy::type_complexity)]
        let table: Vec<(
            Vec<HarnessId>,
            Vec<SkillRoot>,
            Vec<SkillRoot>,
            Vec<HarnessId>,
        )> = vec![
            (vec![P], vec![F2], vec![F2], vec![]),
            (vec![I], vec![F2], vec![F2], vec![]),
            (vec![K], vec![F2], vec![F2], vec![]),
            (vec![C, I], vec![F1, F2], vec![F1, F2], vec![]),
            (vec![C, P], vec![F1, F2], vec![F1, F2], vec![]),
            (vec![C, K], vec![F1], vec![F1], vec![]),
            (vec![P, I, K], vec![F2], vec![F2], vec![]),
            (vec![G], vec![F2], vec![F2], vec![]),
            (vec![C, G], vec![F1], vec![F1], vec![]),
            (vec![X, G], vec![F2], vec![F3, F1], vec![]),
            (vec![X, P, G], vec![F2], vec![F3, F1], vec![P]),
            (vec![X, I], vec![F2], vec![F3], vec![I]),
            (vec![X, P], vec![F2], vec![F3], vec![P]),
            (vec![X, K], vec![F2], vec![F3, F1], vec![]),
            (vec![C, X, P], vec![F1, F2], vec![F1, F3], vec![P]),
            (vec![X, O, I], vec![F2], vec![F3, F1], vec![I]),
            (vec![X, P, I, K], vec![F2], vec![F3, F1], vec![P, I]),
            (
                vec![C, X, O, U, P, I, K, G],
                vec![F1, F2],
                vec![F1, F3],
                vec![P, I],
            ),
            (vec![A], vec![G1, G2], vec![G1, G2], vec![]),
            (vec![C, A], vec![F1, G1, G2], vec![F1, G1, G2], vec![]),
            (vec![X, A], vec![F2, G1, G2], vec![F3, G1, G2], vec![]),
            (vec![P, A], vec![F2, G1, G2], vec![F2, G1, G2], vec![]),
            (vec![X, P, A], vec![F2, G1, G2], vec![F3, G1, G2], vec![P]),
            (
                vec![C, X, O, U, P, I, K, A],
                vec![F1, F2, G1, G2],
                vec![F1, F3, G1, G2],
                vec![P, I],
            ),
        ];
        let sorted = |mut roots: Vec<SkillRoot>| {
            roots.sort_by_key(|root| SkillRoot::ALL.iter().position(|c| c == root));
            roots
        };
        for (enabled, default, custom, unserved_custom) in table {
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
            assert!(unserved(&enabled, false).is_empty(), "{}", name(&enabled));
            assert_eq!(
                unserved(&enabled, true),
                unserved_custom,
                "custom {}",
                name(&enabled)
            );
        }
    }

    /// All non-empty subsets of the harnesses.
    fn all_subsets() -> Vec<Vec<HarnessId>> {
        let all = HarnessId::ALL;
        (1usize..(1 << all.len()))
            .map(|mask| {
                all.iter()
                    .enumerate()
                    .filter(|(index, _)| mask & (1 << index) != 0)
                    .map(|(_, harness)| *harness)
                    .collect()
            })
            .collect()
    }

    #[test]
    fn the_invariants_hold_over_every_subset_of_the_harnesses() {
        let subsets = all_subsets();
        assert_eq!(subsets.len(), (1 << HarnessId::ALL.len()) - 1);
        for custom in [false, true] {
            for subset in &subsets {
                let label = format!("{} (custom: {custom})", name(subset));
                let scope = SkillScope::for_harnesses(subset, custom);
                let roots = scope.roots();
                let on = |harness: HarnessId| subset.contains(&harness);
                let read = |harness| roots_read_by(harness, &scope);

                // I1: every enabled harness reads an installed root, except exactly the unserved
                // ones, and only Copilot and Pi can be unserved, only behind an isolated Codex.
                let without_root: Vec<HarnessId> = subset
                    .iter()
                    .copied()
                    .filter(|harness| read(*harness).is_empty())
                    .collect();
                assert_eq!(without_root, unserved(subset, custom), "I1 {label}");
                for harness in &without_root {
                    assert!(
                        matches!(harness, HarnessId::Copilot | HarnessId::Pi),
                        "I1 {label}"
                    );
                    assert!(custom && on(X), "I1 {label}");
                }

                // I2 and I3: Codex reads one installed root, and in a customised home only that.
                if on(X) {
                    assert_eq!(read(X).len(), 1, "I2 {label}");
                    if custom {
                        assert_eq!(read(X), vec![SkillRoot::CodexHome], "I3 {label}");
                    }
                }

                // I4: nothing is installed that no enabled harness needs. Besides the roots
                // rules 1 and 2 give for Claude and Codex, every root is the only one some
                // harness reads.
                for root in roots {
                    let mandated = (ANTIGRAVITY_ROOTS.contains(root) && on(A))
                        || (*root == SkillRoot::Claude && on(C))
                        || (on(X)
                            && *root
                                == if custom {
                                    SkillRoot::CodexHome
                                } else {
                                    SkillRoot::Agents
                                });
                    let needed = subset.iter().any(|harness| read(*harness) == vec![*root]);
                    assert!(mandated || needed, "I4 {label}: {root:?} in {roots:?}");
                }

                // I5: how many installed copies a harness can see. Antigravity sees two, one per
                // surface: the App reads one folder and the CLI the other.
                for harness in subset {
                    let most = match harness {
                        HarnessId::OpenCode
                        | HarnessId::Cursor
                        | HarnessId::Kilo
                        | HarnessId::Antigravity
                        | HarnessId::Grok => 2,
                        _ => 1,
                    };
                    assert!(read(*harness).len() <= most, "I5 {label}: {harness:?}");
                }
                if on(A) {
                    assert_eq!(read(A), ANTIGRAVITY_ROOTS, "I5 {label}");
                }

                // I6: only the roots that existed before the light tier are ever chosen, plus
                // Antigravity's two, exactly while it is enabled.
                assert!(
                    roots.iter().all(|root| matches!(
                        root,
                        SkillRoot::Claude | SkillRoot::Agents | SkillRoot::CodexHome
                    ) || (on(A) && ANTIGRAVITY_ROOTS.contains(root))),
                    "I6 {label}"
                );
                for root in ANTIGRAVITY_ROOTS {
                    assert_eq!(roots.contains(&root), on(A), "I6 {label}: {root:?}");
                }

                // I7: Antigravity changes nothing for the other harnesses: the roots of the
                // subset without it are the roots with it, minus its own two.
                let others: Vec<HarnessId> = subset
                    .iter()
                    .copied()
                    .filter(|harness| *harness != A)
                    .collect();
                let without: Vec<SkillRoot> = roots
                    .iter()
                    .copied()
                    .filter(|root| !ANTIGRAVITY_ROOTS.contains(root))
                    .collect();
                assert_eq!(install_roots(&others, custom), without, "I7 {label}");
            }
        }
    }

    #[test]
    fn enabling_a_light_harness_never_takes_an_install_root_away() {
        // Copilot, Pi, Kilo and Grok add at most one root, the one the light harness itself
        // needs; Antigravity adds exactly its own two.
        for custom in [false, true] {
            for subset in all_subsets() {
                let before = install_roots(&subset, custom);
                for light in [P, I, K, A, G] {
                    if subset.contains(&light) {
                        continue;
                    }
                    let mut with = subset.clone();
                    with.push(light);
                    let after = install_roots(&with, custom);
                    for root in &before {
                        assert!(
                            after.contains(root),
                            "{} + {light:?} (custom: {custom})",
                            name(&subset)
                        );
                    }
                    if light == A {
                        assert_eq!(after.len(), before.len() + 2);
                        assert!(ANTIGRAVITY_ROOTS.iter().all(|root| after.contains(root)));
                    } else {
                        assert!(after.len() <= before.len() + 1);
                    }
                }
            }
        }
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
