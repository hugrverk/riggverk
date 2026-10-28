//! Skill packs in the Library: what the data folder's packs provide, and forgetting a pack.
//!
//! Listing is read-only. Forgetting writes only `pack-skills.json`; the app-owned copies of the
//! pack's skills are removed by the next Install, as a backed-up transaction like any retirement.

use serde::Serialize;

use super::content::DocumentContent;
use super::workspace::{setup_workspace_target_path, workspace_target_for_write};
use crate::skill_sources::{HeldState, PackSkillState, SkillSources};

#[derive(Serialize)]
pub struct PackSkillSummary {
    /// `pack:<pack>/<skill>`
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) pack: String,
    /// `active`, `shadowed`, `error` or `missing` (installed, and the pack cannot be read).
    pub(crate) state: String,
    /// Why the skill is not active; empty when it is.
    pub(crate) reason: String,
    /// Path of the `SKILL.md` below the pack folder; empty when there is none to show.
    pub(crate) path: String,
}

#[derive(Serialize)]
pub struct PackSummary {
    pub(crate) name: String,
    /// `ok`, `refused` or `missing` (skills of it are installed, its folder is gone).
    pub(crate) state: String,
    pub(crate) reason: String,
    /// Whether "Forget pack" applies: its installed skills are held and it provides none.
    pub(crate) forgettable: bool,
}

#[derive(Serialize)]
pub struct IgnoredPackEntry {
    pub(crate) name: String,
    pub(crate) reason: String,
}

#[derive(Serialize)]
pub struct PackLibrary {
    /// Why `pack-skills.json` cannot be used; set, installed pack skills are kept as they are.
    pub(crate) record_problem: Option<String>,
    /// The folder packs go in, as `~/...`.
    pub(crate) folder: String,
    pub(crate) packs: Vec<PackSummary>,
    pub(crate) skills: Vec<PackSkillSummary>,
    pub(crate) ignored: Vec<IgnoredPackEntry>,
}

fn skill_id(pack: &str, name: &str) -> String {
    format!("pack:{pack}/{name}")
}

fn library(sources: &SkillSources, folder: String) -> PackLibrary {
    let mut packs = Vec::new();
    let mut skills = Vec::new();
    for pack in sources.packs() {
        let held_here = sources.held().iter().any(|held| held.pack == pack.name);
        let any_active = pack
            .skills
            .iter()
            .any(|skill| skill.state == PackSkillState::Active);
        packs.push(PackSummary {
            name: pack.name.clone(),
            state: if pack.refused.is_some() {
                "refused"
            } else {
                "ok"
            }
            .to_string(),
            reason: pack.refused.clone().unwrap_or_default(),
            forgettable: held_here && !any_active,
        });
        for skill in &pack.skills {
            skills.push(PackSkillSummary {
                id: skill_id(&pack.name, &skill.name),
                name: skill.name.clone(),
                description: skill.description.clone(),
                pack: pack.name.clone(),
                state: match skill.state {
                    PackSkillState::Active => "active",
                    PackSkillState::Shadowed => "shadowed",
                    PackSkillState::Error => "error",
                }
                .to_string(),
                reason: skill.reason.clone(),
                path: skill.relative_path.clone(),
            });
        }
    }
    // Installed skills whose pack is gone, or whose own folder no longer loads.
    for held in sources.held() {
        // Held because the record is unusable: the pack it came from is not known.
        if held.pack.is_empty() {
            skills.push(PackSkillSummary {
                id: skill_id("unknown", &held.name),
                name: held.name.clone(),
                description: String::new(),
                pack: "unknown".to_string(),
                state: "missing".to_string(),
                reason: held.reason.clone(),
                path: String::new(),
            });
            continue;
        }
        if !packs.iter().any(|pack| pack.name == held.pack) {
            packs.push(PackSummary {
                name: held.pack.clone(),
                state: "missing".to_string(),
                reason: "the pack folder is gone".to_string(),
                forgettable: true,
            });
        }
        let already_listed = skills
            .iter()
            .any(|skill| skill.pack == held.pack && skill.name == held.name);
        if !already_listed {
            skills.push(PackSkillSummary {
                id: skill_id(&held.pack, &held.name),
                name: held.name.clone(),
                description: String::new(),
                pack: held.pack.clone(),
                state: "missing".to_string(),
                reason: held.reason.clone(),
                path: String::new(),
            });
        } else if held.state == HeldState::Error {
            // The pack lists it as an error already; say that the installed copy is kept.
            if let Some(skill) = skills
                .iter_mut()
                .find(|skill| skill.pack == held.pack && skill.name == held.name)
            {
                skill.state = "missing".to_string();
            }
        }
    }
    packs.sort_by(|a, b| a.name.cmp(&b.name));
    skills.sort_by(|a, b| (&a.pack, &a.name).cmp(&(&b.pack, &b.name)));
    PackLibrary {
        record_problem: sources.record_problem().map(str::to_string),
        folder,
        packs,
        skills,
        ignored: sources
            .ignored()
            .iter()
            .map(|(name, reason)| IgnoredPackEntry {
                name: name.clone(),
                reason: reason.clone(),
            })
            .collect(),
    }
}

/// The skills the data folder's packs provide, with the packs that cannot be read. Read-only.
#[tauri::command(async)]
pub fn list_pack_skills() -> Result<PackLibrary, String> {
    let workspace_root = setup_workspace_target_path()?;
    let home = crate::agent_targets::home_dir()?;
    let sources = SkillSources::for_workspace(&workspace_root)?;
    let folder =
        crate::skill_loads::display_path(&crate::skill_sources::packs_dir(&workspace_root), &home);
    Ok(library(&sources, folder))
}

/// The `SKILL.md` of a pack skill, by the id [`list_pack_skills`] gave. A skill that is not
/// active has no file to show; its reason is shown instead.
#[tauri::command(async)]
pub fn read_pack_skill(id: String) -> Result<DocumentContent, String> {
    let workspace_root = setup_workspace_target_path()?;
    let sources = SkillSources::for_workspace(&workspace_root)?;
    let notice = |pack: &str, name: &str, reason: &str| DocumentContent {
        id: id.clone(),
        title: name.to_string(),
        section: format!("pack:{pack}"),
        path: String::new(),
        source: "pack".to_string(),
        content: format!("# {name}\n\nNot active: {reason}\n"),
    };
    for pack in sources.packs() {
        for skill in &pack.skills {
            if skill_id(&pack.name, &skill.name) != id {
                continue;
            }
            let Some(path) = skill.skill_md_path() else {
                return Ok(notice(&pack.name, &skill.name, &skill.reason));
            };
            let content = std::fs::read_to_string(path).map_err(|e| format!("read error: {e}"))?;
            return Ok(DocumentContent {
                id,
                title: skill.name.clone(),
                section: format!("pack:{}", pack.name),
                path: skill.relative_path.clone(),
                source: "pack".to_string(),
                content,
            });
        }
    }
    sources
        .held()
        .iter()
        .find(|held| skill_id(&held.pack, &held.name) == id)
        .map(|held| notice(&held.pack, &held.name, &held.reason))
        .ok_or_else(|| format!("unknown pack skill: {id}"))
}

/// Forgets a pack whose folder is gone (or refused): its installed skills stop being held, so the
/// next Install removes the app-owned copies, with a backup. Returns how many skills it covered.
#[tauri::command(async)]
pub fn forget_pack(name: String) -> Result<usize, String> {
    // Writes next to files an apply may also write: wait for a running mutation.
    let _mutation = crate::mutation_lock::acquire();
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let workspace_root = workspace_target_for_write()?;
    crate::skill_sources::forget_pack(&workspace_root, &name)
}
