//! Skill packs in the Library: what the data folder's packs provide, and forgetting a pack.
//!
//! Listing is read-only. Personal copies and edits stay in `packs/personal/` until the next
//! Install. Forgetting writes only `pack-skills.json`; installed copies retire on the next Install.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::content::{
    doc_backup_path, safe_canonical_target, write_doc_backup, DocumentContent, MAX_DOC_SIZE,
};
use super::process::ActionResult;
use super::workspace::{setup_workspace_target_path, workspace_target_for_write};
use crate::skill_sources::{HeldState, PackSkillState, SkillSources, SourceRoot};

#[derive(Debug, Serialize)]
pub struct PackSkillCopy {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) pack: String,
    /// Display path of the personal `SKILL.md` (`~/...`, or `<data>/...` outside home).
    pub(crate) path: String,
}

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

fn valid_personal_skill_name(name: &str) -> bool {
    crate::artifact_registry::SkillName::new(name).is_some()
        && crate::skill_sources::valid_pack_name(name)
}

fn personal_sources(root: &Path) -> Result<SkillSources, String> {
    let sources = SkillSources::for_workspace(root)
        .map_err(|_| "skill sources are unavailable".to_string())?;
    let bundle = sources
        .bundle()
        .canonicalize()
        .map_err(|_| "bundled skills are unavailable".to_string())?;
    if root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .starts_with(bundle)
    {
        return Err("the bundled workspace is read-only".to_string());
    }
    if sources
        .ignored()
        .iter()
        .any(|(name, _)| name == "packs" || name == "personal")
        || sources
            .packs()
            .iter()
            .any(|pack| pack.name == "personal" && pack.refused.is_some())
    {
        return Err(
            "personal pack is refused; check ownership, permissions and symlinks".to_string(),
        );
    }
    Ok(sources)
}

fn create_personal_skill_dirs(root: &Path) -> Result<PathBuf, String> {
    crate::safe_filesystem::create_private_root_directory_all_no_symlinks(root)
        .map_err(|_| "cannot create the data folder safely".to_string())?;
    let packs = crate::skill_sources::packs_dir(root);
    let personal = packs.join("personal");
    let skills = personal.join("skills");
    for dir in [&packs, &personal, &skills] {
        crate::path_safety::reject_symlink_parent_chain(dir, root, "personal pack")
            .map_err(|_| "refusing a symlink in the personal pack path".to_string())?;
        match fs::symlink_metadata(dir) {
            Ok(meta) if meta.is_dir() => {
                crate::skill_sources::check_trusted(&meta, "personal pack")?
            }
            Ok(_) => return Err("personal pack path is not a folder".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                crate::safe_filesystem::create_private_directory_all_no_symlinks(dir, root)
                    .map_err(|_| "cannot create personal pack folders safely".to_string())?;
            }
            Err(_) => return Err("cannot inspect personal pack folders".to_string()),
        }
    }
    Ok(skills)
}

fn require_absent_copy(target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("a personal skill folder with this name already exists".to_string()),
        Err(_) => Err("cannot inspect the personal skill destination".to_string()),
    }
}

/// Replaces only frontmatter keys in the leading block, preserving the rest byte for byte.
fn rename_skill_frontmatter(content: &str, new_name: &str) -> Result<String, String> {
    let mut lines = content.split_inclusive('\n');
    let opening = lines.next().unwrap_or_default();
    if opening.trim_end_matches(['\r', '\n']) != "---" {
        return Err("bundled skill has no leading frontmatter".to_string());
    }
    let newline = if opening.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut renamed = opening.to_string();
    let mut closed = false;
    let mut found_name = false;
    for line in lines {
        if !closed && line.trim_end_matches(['\r', '\n']) == "---" {
            if !found_name {
                renamed.push_str(&format!("name: {new_name}{newline}"));
            }
            closed = true;
        } else if !closed && line.trim_start().starts_with("name:") {
            let indent = &line[..line.len() - line.trim_start().len()];
            renamed.push_str(&format!("{indent}name: {new_name}{newline}"));
            found_name = true;
            continue;
        }
        renamed.push_str(line);
    }
    if !closed {
        return Err("bundled skill frontmatter is not closed".to_string());
    }
    Ok(renamed)
}

fn copy_bundled_tree(source: &Path, temp: &Path, new_name: &str) -> Result<(), String> {
    const MAX_FILES: usize = 64;
    const MAX_BYTES: usize = 1024 * 1024;
    const MAX_ENTRIES: usize = 256;
    let meta = fs::symlink_metadata(source)
        .map_err(|_| "cannot inspect the bundled skill folder".to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("refusing a symlink or non-folder bundled skill".to_string());
    }
    let mut pending = vec![PathBuf::new()];
    let (mut files, mut bytes, mut entries) = (0, 0, 0);
    while let Some(relative_dir) = pending.pop() {
        let dir = source.join(&relative_dir);
        for entry in
            fs::read_dir(&dir).map_err(|_| "cannot read bundled skill folder".to_string())?
        {
            let entry = entry.map_err(|_| "cannot read bundled skill entry".to_string())?;
            entries += 1;
            let relative = relative_dir.join(entry.file_name());
            if entries > MAX_ENTRIES
                || relative.components().count() > crate::skill_discovery::MAX_SUPPORT_DEPTH
            {
                return Err("bundled skill has too many entries or is nested too deep".to_string());
            }
            let kind = entry
                .file_type()
                .map_err(|_| "cannot inspect bundled skill entry".to_string())?;
            let target = temp.join(&relative);
            if kind.is_dir() {
                crate::safe_filesystem::create_private_directory_all_no_symlinks(&target, temp)
                    .map_err(|_| "cannot create personal skill subfolder".to_string())?;
                pending.push(relative);
                continue;
            }
            if !kind.is_file() {
                return Err("refusing a symlink or special file in the bundled skill".to_string());
            }
            files += 1;
            if files > MAX_FILES {
                return Err("bundled skill exceeds the 64 file limit".to_string());
            }
            let mut content = Vec::new();
            fs::File::open(entry.path())
                .map_err(|_| "cannot open bundled skill file".to_string())?
                .take((MAX_BYTES - bytes + 1) as u64)
                .read_to_end(&mut content)
                .map_err(|_| "cannot read bundled skill file".to_string())?;
            if content.len() > MAX_BYTES - bytes {
                return Err("bundled skill exceeds the 1 MiB copy limit".to_string());
            }
            if relative == Path::new("SKILL.md") {
                let text = std::str::from_utf8(&content)
                    .map_err(|_| "bundled SKILL.md is not UTF-8".to_string())?;
                content = rename_skill_frontmatter(text, new_name)?.into_bytes();
            }
            bytes += content.len();
            if bytes > MAX_BYTES {
                return Err("bundled skill exceeds the 1 MiB copy limit".to_string());
            }
            crate::safe_filesystem::write_private_new_regular_file_synced(&target, &content, temp)
                .map_err(|_| "cannot write personal skill file".to_string())?;
        }
    }
    // Keep the copy representable by the installer, including nested supporting file names.
    let support_files = crate::skill_discovery::skill_support_files(temp)
        .map_err(|_| "bundled skill has invalid supporting files".to_string())?;
    if support_files
        .iter()
        .any(|rel| crate::artifact_registry::SkillRelPath::new(rel.as_str()).is_none())
    {
        return Err(
            "bundled skill has supporting paths the installer cannot represent".to_string(),
        );
    }
    Ok(())
}

/// Writes only inside `<data>/packs/personal/`; installation waits for the next Update.
#[tauri::command(async)]
pub fn copy_skill_to_pack(name: String, new_name: String) -> Result<PackSkillCopy, String> {
    if !valid_personal_skill_name(&new_name) {
        return Err(
            "invalid skill name: use 1–64 lowercase letters, digits or hyphens, no leading hyphen"
                .to_string(),
        );
    }
    let _mutation = crate::mutation_lock::acquire();
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let home =
        crate::agent_targets::home_dir().map_err(|_| "home folder is unavailable".to_string())?;
    let sources = personal_sources(&root)?;
    let catalog = sources
        .catalog()
        .map_err(|_| "bundled catalog is unavailable or unsafe".to_string())?;
    let source = catalog
        .iter()
        .find(|entry| entry.pack.is_none() && entry.skill.name == name)
        .ok_or_else(|| "source must be a bundled skill name".to_string())?;
    if catalog
        .iter()
        .any(|entry| entry.pack.is_none() && entry.skill.name == new_name)
    {
        return Err("this name belongs to a bundled skill".to_string());
    }
    if sources
        .packs()
        .iter()
        .any(|pack| pack.skills.iter().any(|skill| skill.name == new_name))
        || sources.held().iter().any(|skill| skill.name == new_name)
    {
        return Err("a pack already has a skill with this name".to_string());
    }
    // A refused or uninspected pack may claim the name too. Do not create an ambiguous copy.
    if sources.packs().iter().any(|pack| pack.refused.is_some())
        || sources
            .ignored()
            .iter()
            .any(|(name, _)| crate::skill_sources::valid_pack_name(name))
    {
        return Err(
            "cannot check skill name collisions while a pack is refused or ignored".to_string(),
        );
    }
    if sources.packs().len() >= crate::skill_sources::MAX_PACKS
        && !sources.packs().iter().any(|pack| pack.name == "personal")
    {
        return Err("cannot add a personal pack: the pack limit is reached".to_string());
    }
    let skills = create_personal_skill_dirs(&root)?;
    let target = skills.join(&new_name);
    require_absent_copy(&target)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock error".to_string())?
        .as_nanos();
    let temp = skills.join(format!(".copy-{}-{nonce}", std::process::id()));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&temp)
        .map_err(|_| "cannot create temporary personal skill folder".to_string())?;
    let result = (|| {
        copy_bundled_tree(&source.skill.source_dir, &temp, &new_name)?;
        safe_canonical_target(&skills, &target)
            .map_err(|_| "unsafe personal skill destination".to_string())?;
        crate::path_safety::reject_symlink_parent_chain(&target, &root, "personal skill")
            .map_err(|_| "refusing a symlink in the personal skill path".to_string())?;
        require_absent_copy(&target)?;
        fs::rename(&temp, &target).map_err(|_| "cannot publish personal skill copy".to_string())
    })();
    if result.is_err() {
        let _ = crate::safe_filesystem::remove_dir_no_symlinks(&temp, &skills);
    }
    result?;
    let skill_md = target.join("SKILL.md");
    let path = if skill_md.starts_with(&home) {
        crate::skill_loads::display_path(&skill_md, &home)
    } else {
        format!("<data>/packs/personal/skills/{new_name}/SKILL.md")
    };
    Ok(PackSkillCopy {
        id: skill_id("personal", &new_name),
        name: new_name,
        pack: "personal".to_string(),
        path,
    })
}

/// Writes only inside `<data>/packs/personal/`, with the previous `SKILL.md` backed up.
#[tauri::command(async)]
pub fn save_pack_skill(id: String, content: String) -> Result<ActionResult, String> {
    let name = id
        .strip_prefix("pack:personal/")
        .filter(|name| valid_personal_skill_name(name))
        .ok_or_else(|| "only personal pack skill ids can be saved".to_string())?;
    if content.len() > MAX_DOC_SIZE {
        return Err("content exceeds 512 KB limit".to_string());
    }
    let _mutation = crate::mutation_lock::acquire();
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let root = workspace_target_for_write()
        .map_err(|_| "data folder is unavailable or unsafe".to_string())?;
    let sources = personal_sources(&root)?;
    let skill = sources
        .packs()
        .iter()
        .filter(|pack| pack.name == "personal" && pack.refused.is_none())
        .flat_map(|pack| &pack.skills)
        .find(|skill| skill.name == name && skill.state == PackSkillState::Active)
        .filter(|_| sources.pack_of(name) == Some("personal"))
        .filter(|_| {
            !sources
                .held()
                .iter()
                .any(|held| held.pack == "personal" && held.name == name)
        })
        .ok_or_else(|| "personal skill does not exist or is not active".to_string())?;
    let target = skill
        .skill_md_path()
        .ok_or_else(|| "personal skill has no SKILL.md".to_string())?;
    let personal = crate::skill_sources::packs_dir(&root).join("personal");
    safe_canonical_target(&personal, target)
        .map_err(|_| "unsafe personal SKILL.md path".to_string())?;
    crate::path_safety::reject_symlink_parent_chain(target, &root, "personal SKILL.md")
        .map_err(|_| "refusing a symlink in the personal SKILL.md path".to_string())?;
    let existing = crate::skill_discovery::read_skill_md_capped(target)
        .map_err(|_| "cannot read personal SKILL.md".to_string())?;
    let message = if existing == content {
        "unchanged"
    } else {
        let backup = doc_backup_path(&id, target, None)
            .map_err(|_| "cannot create the personal skill backup folder".to_string())?;
        write_doc_backup(&backup, &existing)
            .map_err(|_| "cannot back up personal SKILL.md".to_string())?;
        crate::safe_filesystem::write_private_regular_file_atomic(
            target,
            content.as_bytes(),
            &personal,
        )
        .map_err(|_| "cannot write personal SKILL.md safely".to_string())?;
        "saved with backup"
    };
    Ok(ActionResult::new(
        true,
        "save_pack_skill",
        message.to_string(),
        String::new(),
        Some(0),
    ))
}
