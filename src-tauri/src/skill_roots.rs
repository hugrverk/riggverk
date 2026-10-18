//! Folders skills are installed into.
//!
//! A skill is installed as a whole directory (`SKILL.md` plus supporting files) below one of
//! these roots. Each root keeps its own surface and its resolution rules, so the folder a
//! harness reads from does not change when skill files become per-file artifacts.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent_skill_targets::{codex_global_skills_dest, codex_legacy_skills_dest};
use crate::setup_lifecycle::SetupSurfaceId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillRoot {
    /// `~/.claude/skills`
    Claude,
    /// `~/.agents/skills`: the previous Codex location, only cleaned up
    Agents,
    /// `$CODEX_HOME/skills` (`CODEX_SKILLS_PATH` when set)
    CodexHome,
    /// `~/.config/opencode/skills`
    OpenCode,
    /// The skills folder of the Cursor profile
    Cursor,
}

impl SkillRoot {
    #[cfg(test)]
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
            SkillRoot::Cursor => "the Cursor profile skills",
        }
    }

    /// The folder every skill of this root lives under.
    pub fn path(self, home: &Path) -> Result<PathBuf, String> {
        match self {
            SkillRoot::Claude => Ok(home.join(".claude/skills")),
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
            SkillRoot::OpenCode => Ok(home.join(".config/opencode/skills")),
            SkillRoot::Cursor => {
                Ok(crate::cursor_profile_paths::resolve_cursor_profile_paths()?.skills)
            }
        }
    }

    /// The surface whose update and cleanup own this root's files.
    pub fn surface(self) -> SetupSurfaceId {
        match self {
            SkillRoot::Claude => SetupSurfaceId::ClaudeSkills,
            SkillRoot::Agents | SkillRoot::CodexHome => SetupSurfaceId::CodexSkills,
            SkillRoot::OpenCode => SetupSurfaceId::OpenCodeSkills,
            SkillRoot::Cursor => SetupSurfaceId::CursorSkills,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn every_root_belongs_to_the_surface_of_its_harness() {
        assert_eq!(SkillRoot::Claude.surface(), SetupSurfaceId::ClaudeSkills);
        assert_eq!(
            SkillRoot::OpenCode.surface(),
            SetupSurfaceId::OpenCodeSkills
        );
        assert_eq!(SkillRoot::Cursor.surface(), SetupSurfaceId::CursorSkills);
        // The old Codex folder is cleaned up by the Codex surface that used to fill it.
        assert_eq!(SkillRoot::Agents.surface(), SetupSurfaceId::CodexSkills);
        assert_eq!(SkillRoot::CodexHome.surface(), SetupSurfaceId::CodexSkills);
    }
}
