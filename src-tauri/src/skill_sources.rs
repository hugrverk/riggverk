//! Where the skills of an install come from: the bundle and the user's skill packs.
//!
//! A pack is a folder of the user's own skills, `<workspace>/packs/<pack>/skills/<skill>/SKILL.md`
//! (one optional group level, as in the bundle). Packs add to the catalog, plus optional routing
//! lines for their own skills (`routing.md`, see [`crate::pack_routing`]) that the rules source
//! splices into the managed block; rules, agents and configs are otherwise read from the bundle. A skill is still identified by its root, name
//! and relative path, so ownership, backups and rollback work as for a bundled skill; only the
//! place its source is read from differs.
//!
//! - **Bundle wins.** A pack skill whose name the bundle ships is *shadowed*: listed, never
//!   installed. Two pack skills of one name are both an *error* (that skill only; the plan goes on).
//! - **Limits** are the bundle's (no symlinks, 64 files and 2 MiB per skill, four levels). On Unix
//!   a pack is refused as a whole when its folder, `skills/` or anything below `skills/` is group-
//!   or world-writable or not owned by the current user, and no pack is read when `packs/` itself
//!   is.
//! - **A missing pack is not a retirement.** After every successful transaction the installed pack
//!   skills are recorded in `.riggverk/pack-skills.json` (pack to skill names). A recorded name the
//!   catalog lacks is *held*: planned neither for update nor for removal until the user forgets the
//!   pack. A skill gone from a pack that is present was removed on purpose and is retired as usual.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::pack_routing::PackRouting;
use crate::skill_discovery::DiscoveredSkill;

/// Folder of the packs inside the data folder. Never `skills/`: that path belongs to the cleanup
/// of the copies of the bundle that older releases kept in the data folder.
pub const PACKS_DIR: &str = "packs";
/// File name inside the state folder (see `workspace_layout::state_file`).
pub const PACK_SKILLS_FILE: &str = "pack-skills.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 512 * 1024;
pub(crate) const MAX_PACKS: usize = 64;
/// Entries one pack's `skills` tree may hold before it is read as hostile.
const MAX_TREE_ENTRIES: usize = 20_000;
const MAX_TREE_DEPTH: usize = 12;

/// The folder packs live in.
pub fn packs_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(PACKS_DIR)
}

/// `[a-z0-9][a-z0-9-]{0,63}`.
pub fn valid_pack_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// ── Catalog ──

/// One skill of the merged catalog and the pack it comes from (`None`: the bundle).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogSkill {
    pub skill: DiscoveredSkill,
    pub pack: Option<String>,
}

/// What skill sources are read from. Production code passes a [`SkillSources`]; the plain paths
/// (the bundle alone) exist for tests only, so a production call site cannot silently ignore packs.
pub trait SourceRoot {
    /// The bundle: rules, agents, templates and configs are read from here only.
    fn bundle(&self) -> &Path;
    /// The merged catalog (bundle, then active pack skills).
    fn catalog(&self) -> Result<Vec<CatalogSkill>, String>;
    /// `SKILL.md` of the skill called `name`; the root-level bundle location when nothing holds it,
    /// which callers then find missing.
    fn skill_md(&self, name: &str) -> PathBuf;
    /// Directory of the skill called `name`, with the same fallback.
    fn skill_dir(&self, name: &str) -> PathBuf;
    /// The rendered routing section the packs add to the rules block (see
    /// [`crate::pack_routing`]); empty without packs, which leaves every rules source as bundled.
    fn pack_routing(&self) -> &str {
        ""
    }
}

/// The bundle alone. For code that reads an artifact which is no skill (rules, agents, configs,
/// templates); a skill read through it would miss the packs.
#[derive(Debug, Clone, Copy)]
pub struct BundleOnly<'a>(pub &'a Path);

impl SourceRoot for BundleOnly<'_> {
    fn bundle(&self) -> &Path {
        self.0
    }
    fn catalog(&self) -> Result<Vec<CatalogSkill>, String> {
        crate::skill_discovery::discover_skill_catalog(self.0)
            .map(|skills| {
                skills
                    .into_iter()
                    .map(|skill| CatalogSkill { skill, pack: None })
                    .collect()
            })
            .map_err(|error| error.message().to_string())
    }
    fn skill_md(&self, name: &str) -> PathBuf {
        crate::skill_discovery::canonical_skill_md(self.0, name)
    }
    fn skill_dir(&self, name: &str) -> PathBuf {
        crate::skill_discovery::canonical_skill_dir(self.0, name)
    }
}

/// Plain paths are the bundle alone, in tests.
#[cfg(test)]
impl SourceRoot for Path {
    fn bundle(&self) -> &Path {
        self
    }
    fn catalog(&self) -> Result<Vec<CatalogSkill>, String> {
        BundleOnly(self).catalog()
    }
    fn skill_md(&self, name: &str) -> PathBuf {
        BundleOnly(self).skill_md(name)
    }
    fn skill_dir(&self, name: &str) -> PathBuf {
        BundleOnly(self).skill_dir(name)
    }
}

#[cfg(test)]
impl SourceRoot for PathBuf {
    fn bundle(&self) -> &Path {
        self.as_path()
    }
    fn catalog(&self) -> Result<Vec<CatalogSkill>, String> {
        BundleOnly(self.as_path()).catalog()
    }
    fn skill_md(&self, name: &str) -> PathBuf {
        BundleOnly(self.as_path()).skill_md(name)
    }
    fn skill_dir(&self, name: &str) -> PathBuf {
        BundleOnly(self.as_path()).skill_dir(name)
    }
}

/// State of one pack skill in the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackSkillState {
    /// In the catalog.
    Active,
    /// The bundle ships a skill of this name and wins.
    Shadowed,
    /// Not in the catalog: invalid, or its name is also another pack skill's.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackSkillReport {
    pub name: String,
    /// Name of the skill's directory, which may differ from `name`.
    pub folder: String,
    pub description: String,
    pub state: PackSkillState,
    /// Why the skill is not active; empty when it is.
    pub reason: String,
    /// `/`-separated path of the `SKILL.md` below the pack folder; empty for a skill that did not
    /// parse.
    pub relative_path: String,
    /// What the installer reads; `None` for a skill that did not parse.
    discovered: Option<DiscoveredSkill>,
}

impl PackSkillReport {
    /// The `SKILL.md`, for a skill that parsed.
    pub fn skill_md_path(&self) -> Option<&Path> {
        self.discovered
            .as_ref()
            .map(|skill| skill.skill_md_path.as_path())
    }
}

/// One folder below `packs/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackReport {
    pub name: String,
    /// Set when the whole pack is refused: none of its skills is read.
    pub refused: Option<String>,
    pub skills: Vec<PackSkillReport>,
    /// Its `routing.md`; [`PackRouting::None`] for a refused pack, which is not read.
    pub routing: PackRouting,
}

/// A recorded pack skill the catalog lacks. It is kept as it is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldSkill {
    pub pack: String,
    pub name: String,
    /// `Missing`: the pack folder is gone or refused. `Error`: the skill is in the pack and broken.
    pub state: HeldState,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeldState {
    Missing,
    Error,
}

/// The bundle and the packs of one data folder, read once.
#[derive(Debug, Clone)]
pub struct SkillSources {
    bundled: PathBuf,
    workspace_root: PathBuf,
    catalog: Result<Vec<CatalogSkill>, String>,
    by_name: HashMap<String, usize>,
    packs: Vec<PackReport>,
    /// Problems with entries of `packs/` that are no pack (a bad name, a link).
    ignored: Vec<(String, String)>,
    held: Vec<HeldSkill>,
    /// Why `pack-skills.json` cannot be used, when it exists and cannot.
    record_problem: Option<String>,
    /// The routing section of the packs, rendered once (see [`crate::pack_routing`]).
    routing_section: String,
}

impl SourceRoot for SkillSources {
    fn bundle(&self) -> &Path {
        &self.bundled
    }
    fn catalog(&self) -> Result<Vec<CatalogSkill>, String> {
        self.catalog.clone()
    }
    fn skill_md(&self, name: &str) -> PathBuf {
        self.find(name)
            .map(|skill| skill.skill.skill_md_path.clone())
            .unwrap_or_else(|| self.bundled.join("skills").join(name).join("SKILL.md"))
    }
    fn skill_dir(&self, name: &str) -> PathBuf {
        self.find(name)
            .map(|skill| skill.skill.source_dir.clone())
            .unwrap_or_else(|| self.bundled.join("skills").join(name))
    }
    fn pack_routing(&self) -> &str {
        &self.routing_section
    }
}

fn index_by_name(catalog: &Result<Vec<CatalogSkill>, String>) -> HashMap<String, usize> {
    catalog
        .as_ref()
        .map(|skills| {
            skills
                .iter()
                .enumerate()
                .map(|(index, skill)| (skill.skill.name.clone(), index))
                .collect()
        })
        .unwrap_or_default()
}

/// Dereferences to the bundle, so code that reads rules, agents and configs takes it as a path.
impl std::ops::Deref for SkillSources {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.bundled
    }
}

impl SkillSources {
    /// The sources of the data folder `workspace_root`.
    pub fn for_workspace(workspace_root: &Path) -> Result<Self, String> {
        let bundled = crate::setup_roots::bundled_root_for(workspace_root)?;
        Ok(Self::new(bundled, workspace_root))
    }

    /// The bundle alone, no packs: for a caller that has no data folder to look in.
    pub fn bundle_only(bundled: PathBuf) -> Self {
        let catalog = BundleOnly(&bundled).catalog();
        let by_name = index_by_name(&catalog);
        Self {
            workspace_root: bundled.clone(),
            bundled,
            catalog,
            by_name,
            packs: Vec::new(),
            ignored: Vec::new(),
            held: Vec::new(),
            record_problem: None,
            routing_section: String::new(),
        }
    }

    /// The sources for a health check: the bundle and, when the caller resolved a data folder, its
    /// packs. The folder is always passed in; nothing here reads settings or the environment.
    pub fn for_health(bundled: &Path, workspace_root: Option<&Path>) -> Self {
        match workspace_root {
            Some(workspace_root) => Self::new(bundled.to_path_buf(), workspace_root),
            None => Self::bundle_only(bundled.to_path_buf()),
        }
    }

    /// The bundle at `bundled` and the packs in `workspace_root`.
    pub fn new(bundled: PathBuf, workspace_root: &Path) -> Self {
        #[cfg(test)]
        reads::count();
        let bundle_catalog = crate::skill_discovery::discover_skill_catalog(&bundled);
        let bundle_names: HashSet<String> = bundle_catalog
            .as_ref()
            .map(|skills| skills.iter().map(|skill| skill.name.clone()).collect())
            .unwrap_or_default();
        let (packs, ignored) = scan_packs(workspace_root, &bundle_names);
        let mut catalog = bundle_catalog
            .map(|skills| {
                skills
                    .into_iter()
                    .map(|skill| CatalogSkill { skill, pack: None })
                    .collect::<Vec<_>>()
            })
            .map_err(|error| error.message().to_string());
        if let Ok(skills) = catalog.as_mut() {
            for pack in &packs {
                for skill in &pack.skills {
                    if skill.state != PackSkillState::Active {
                        continue;
                    }
                    if let Some(discovered) = &skill.discovered {
                        skills.push(CatalogSkill {
                            skill: discovered.clone(),
                            pack: Some(pack.name.clone()),
                        });
                    }
                }
            }
        }
        let by_name = index_by_name(&catalog);
        let (held, record_problem) = compute_held(workspace_root, &packs, &catalog);
        // A bundle that does not load plans nothing, so its packs route nothing either.
        let routing_section = if catalog.is_ok() {
            crate::pack_routing::render_section(
                packs
                    .iter()
                    .map(|pack| (pack.name.as_str(), pack.routing.lines())),
            )
        } else {
            String::new()
        };
        Self {
            bundled,
            workspace_root: workspace_root.to_path_buf(),
            catalog,
            by_name,
            packs,
            ignored,
            held,
            record_problem,
            routing_section,
        }
    }

    /// The folder a source file must stay inside: its pack folder, or the bundle.
    pub fn source_root_of(&self, source: &Path) -> PathBuf {
        let packs = packs_dir(&self.workspace_root);
        self.packs
            .iter()
            .map(|pack| packs.join(&pack.name))
            .find(|dir| source.starts_with(dir))
            .unwrap_or_else(|| self.bundled.clone())
    }

    fn find(&self, name: &str) -> Option<&CatalogSkill> {
        let index = *self.by_name.get(name)?;
        self.catalog.as_ref().ok()?.get(index)
    }

    pub fn packs(&self) -> &[PackReport] {
        &self.packs
    }

    /// Entries of `packs/` that were not read, with the reason.
    pub fn ignored(&self) -> &[(String, String)] {
        &self.ignored
    }

    /// Why `pack-skills.json` cannot be used. While it cannot, every installed skill the catalog
    /// lacks is held (see [`HeldSkill`]), since the app cannot tell which pack it came from.
    pub fn record_problem(&self) -> Option<&str> {
        self.record_problem.as_deref()
    }

    pub fn held(&self) -> &[HeldSkill] {
        &self.held
    }

    /// Names of the held skills: not to be planned for removal.
    pub fn held_names(&self) -> HashSet<&str> {
        self.held.iter().map(|held| held.name.as_str()).collect()
    }

    /// The pack the catalog takes the skill `name` from; `None` for a bundled skill.
    pub fn pack_of(&self, name: &str) -> Option<&str> {
        self.find(name)?.pack.as_deref()
    }

    /// Pack skills the catalog holds, by name.
    fn active_pack_skills(&self) -> BTreeMap<&str, &str> {
        self.catalog
            .as_ref()
            .map(|skills| {
                skills
                    .iter()
                    .filter_map(|skill| {
                        skill
                            .pack
                            .as_deref()
                            .map(|pack| (skill.skill.name.as_str(), pack))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Counts, per thread, how often the catalog was read, so a test can hold a plan, an apply or a
/// diff to one read.
#[cfg(test)]
pub(crate) mod reads {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn count() {
        COUNT.with(|count| count.set(count.get() + 1));
    }

    /// Reads of the catalog on this thread so far.
    pub(crate) fn total() -> usize {
        COUNT.with(Cell::get)
    }
}

/// Makes, per thread, every write of `pack-skills.json` fail, so a test can tell what an apply does
/// when the record cannot be saved (a full disk, an unwritable state folder).
#[cfg(test)]
pub(crate) mod failing_writes {
    use std::cell::Cell;

    thread_local! {
        static ON: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn set(on: bool) {
        ON.with(|cell| cell.set(on));
    }

    pub(super) fn on() -> bool {
        ON.with(Cell::get)
    }
}

// ── Reading packs ──

/// A skill found in a pack before name conflicts are decided.
struct Candidate {
    /// Directory name.
    label: String,
    /// The `name` the skill declares, when it could be read, valid or not.
    declared_name: Option<String>,
    outcome: Result<DiscoveredSkill, String>,
}

fn scan_packs(
    workspace_root: &Path,
    bundle_names: &HashSet<String>,
) -> (Vec<PackReport>, Vec<(String, String)>) {
    let dir = packs_dir(workspace_root);
    let mut ignored = Vec::new();
    match fs::symlink_metadata(&dir) {
        Err(_) => return (Vec::new(), ignored),
        Ok(meta) if meta.file_type().is_symlink() => {
            ignored.push((
                PACKS_DIR.to_string(),
                "refusing a symlinked packs folder".to_string(),
            ));
            return (Vec::new(), ignored);
        }
        Ok(meta) if !meta.is_dir() => return (Vec::new(), ignored),
        Ok(meta) => {
            if let Err(reason) = check_trusted(&meta, "the packs folder") {
                ignored.push((PACKS_DIR.to_string(), reason));
                return (Vec::new(), ignored);
            }
        }
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        ignored.push((
            PACKS_DIR.to_string(),
            "cannot read the packs folder".to_string(),
        ));
        return (Vec::new(), ignored);
    };
    let mut names: Vec<(String, fs::FileType)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            Some((name, entry.file_type().ok()?))
        })
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));

    let mut pending: Vec<(String, Result<Vec<Candidate>, String>)> = Vec::new();
    for (name, kind) in names {
        if kind.is_symlink() {
            ignored.push((name, "refusing a symlinked pack".to_string()));
            continue;
        }
        if !kind.is_dir() {
            continue;
        }
        if !valid_pack_name(&name) {
            ignored.push((
                name,
                "not a pack name (lowercase letters, digits and hyphens, at most 64)".to_string(),
            ));
            continue;
        }
        if pending.len() >= MAX_PACKS {
            ignored.push((name, format!("more than {MAX_PACKS} packs")));
            continue;
        }
        let outcome = scan_pack(&dir.join(&name));
        pending.push((name, outcome));
    }

    // Bundle wins; among the rest, a name two pack skills share is an error for both.
    let mut claims: HashMap<String, Vec<String>> = HashMap::new();
    for (pack, outcome) in &pending {
        if let Ok(candidates) = outcome {
            for candidate in candidates {
                if let Ok(skill) = &candidate.outcome {
                    if !bundle_names.contains(&skill.name) {
                        claims
                            .entry(skill.name.clone())
                            .or_default()
                            .push(pack.clone());
                    }
                }
            }
        }
    }

    let mut reports = Vec::new();
    for (pack, outcome) in pending {
        match outcome {
            Err(reason) => reports.push(PackReport {
                name: pack,
                refused: Some(reason),
                skills: Vec::new(),
                routing: PackRouting::None,
            }),
            Ok(candidates) => {
                let mut skills = Vec::new();
                for candidate in candidates {
                    skills.push(report_candidate(&pack, candidate, bundle_names, &claims));
                }
                skills.sort_by(|a, b| a.name.cmp(&b.name));
                // Only the pack's own active skills may be routed to: a held skill is not in the
                // catalog, so it is not active either.
                let own: BTreeSet<&str> = skills
                    .iter()
                    .filter(|skill| skill.state == PackSkillState::Active)
                    .map(|skill| skill.name.as_str())
                    .collect();
                let routing = crate::pack_routing::read(&dir.join(&pack), &own);
                reports.push(PackReport {
                    name: pack,
                    refused: None,
                    skills,
                    routing,
                });
            }
        }
    }
    (reports, ignored)
}

fn report_candidate(
    pack: &str,
    candidate: Candidate,
    bundle_names: &HashSet<String>,
    claims: &HashMap<String, Vec<String>>,
) -> PackSkillReport {
    let skill = match candidate.outcome {
        Err(reason) => {
            return PackSkillReport {
                // The name the skill declares, so a recorded skill is found even when it broke.
                name: candidate
                    .declared_name
                    .unwrap_or_else(|| candidate.label.clone()),
                folder: candidate.label,
                description: String::new(),
                state: PackSkillState::Error,
                reason,
                relative_path: String::new(),
                discovered: None,
            };
        }
        Ok(skill) => skill,
    };
    let (state, reason) = if bundle_names.contains(&skill.name) {
        (
            PackSkillState::Shadowed,
            "the bundle ships a skill with this name; the bundle's version is used".to_string(),
        )
    } else {
        let owners = claims.get(&skill.name).map(Vec::as_slice).unwrap_or(&[]);
        if owners.len() > 1 {
            let mut others: Vec<String> = Vec::new();
            for owner in owners {
                let label = if owner == pack {
                    // Two skills of one pack with one name.
                    format!("{owner} (a second skill)")
                } else {
                    owner.clone()
                };
                if !others.contains(&label) {
                    others.push(label);
                }
            }
            (
                PackSkillState::Error,
                format!(
                    "another pack skill has this name too (packs: {}); none of them is used",
                    others.join(", ")
                ),
            )
        } else {
            (PackSkillState::Active, String::new())
        }
    };
    PackSkillReport {
        name: skill.name.clone(),
        folder: candidate.label,
        description: skill.description.clone(),
        state,
        reason,
        relative_path: skill.relative_path.clone(),
        discovered: Some(skill),
    }
}

/// The effective user id of this process. `std` has no accessor and the crate has no `libc`
/// dependency, so this declares the one C function it needs; `geteuid` is always linked on Unix.
#[cfg(unix)]
fn effective_uid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: `geteuid` takes no arguments, has no preconditions and cannot fail.
    unsafe { geteuid() }
}

/// Why a pack entry cannot be trusted (Unix): writable by its group or by everyone, or owned by
/// someone else than the current user. Always `Ok` elsewhere. `what` names the entry in the reason.
pub(crate) fn check_trusted(meta: &fs::Metadata, what: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.permissions().mode() & 0o022 != 0 {
            return Err(format!(
                "refusing {what}: it is writable by its group or by everyone; run chmod go-w on it"
            ));
        }
        if meta.uid() != effective_uid() {
            return Err(format!(
                "refusing {what}: it is not owned by the current user; run chown on it"
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (meta, what);
        Ok(())
    }
}

/// Reads one pack folder. `Err` is the reason the whole pack is refused.
fn scan_pack(pack_dir: &Path) -> Result<Vec<Candidate>, String> {
    let meta = fs::symlink_metadata(pack_dir).map_err(|e| format!("cannot read the pack: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("refusing a symlinked pack".to_string());
    }
    check_trusted(&meta, "a pack folder")?;
    let skills_dir = pack_dir.join("skills");
    // Only a skills folder that is not there at all means "no skills". One that cannot be looked
    // at, or is no folder, must not read as an empty pack: that would retire everything installed.
    match fs::symlink_metadata(&skills_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read the skills folder: {error}")),
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("refusing a symlinked skills folder".to_string())
        }
        Ok(meta) if !meta.is_dir() => return Err("skills is not a folder".to_string()),
        Ok(meta) => check_trusted(&meta, "the skills folder")?,
    }
    let mut seen = 0usize;
    reject_links_below(&skills_dir, 0, &mut seen)?;

    let mut candidates = Vec::new();
    let mut entries = sorted_dirs(&skills_dir)?;
    entries.retain(|(name, _)| !name.starts_with('.'));
    for (entry_name, entry_path) in entries {
        let root_skill_md = entry_path.join("SKILL.md");
        if root_skill_md.is_file() {
            candidates.push(candidate(
                pack_dir,
                &entry_path,
                &root_skill_md,
                &entry_name,
                "",
                true,
            ));
            continue;
        }
        let Ok(subs) = sorted_dirs(&entry_path) else {
            candidates.push(Candidate {
                label: entry_name,
                declared_name: None,
                outcome: Err("cannot read the group folder".to_string()),
            });
            continue;
        };
        for (sub_name, sub_path) in subs {
            if sub_name.starts_with('.') {
                continue;
            }
            let grouped = sub_path.join("SKILL.md");
            if grouped.is_file() {
                candidates.push(candidate(
                    pack_dir,
                    &sub_path,
                    &grouped,
                    &sub_name,
                    &entry_name,
                    false,
                ));
            } else if crate::skill_discovery::has_deeper_skill_md(&sub_path) {
                candidates.push(Candidate {
                    label: sub_name,
                    declared_name: None,
                    outcome: Err(
                        "skill nesting deeper than one group level is not supported".to_string()
                    ),
                });
            }
        }
    }
    Ok(candidates)
}

/// The sub-directories of `dir` (links are rejected before this runs), sorted by name.
fn sorted_dirs(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("read error in {}: {e}", dir.display()))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("file type error for {}: {e}", entry.path().display()))?;
        if !kind.is_dir() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| format!("non-UTF-8 file name in {}", dir.display()))?;
        out.push((name, entry.path()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Refuses the pack on a symlink or any other link-like entry below `dir`, on an entry that is
/// writable by its group or by everyone or not owned by the current user (Unix), and on a tree too
/// big to read. Dot entries (`.git`) are never read, so they are not walked.
fn reject_links_below(dir: &Path, depth: usize, seen: &mut usize) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH {
        return Err("pack skills nested too deep".to_string());
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read error in {}: {e}", dir.display()))?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        *seen += 1;
        if *seen > MAX_TREE_ENTRIES {
            return Err("pack skills hold too many files".to_string());
        }
        let kind = entry
            .file_type()
            .map_err(|e| format!("file type error for {}: {e}", entry.path().display()))?;
        if kind.is_symlink() {
            return Err(format!(
                "refusing a symlink in the pack: {}",
                entry.path().display()
            ));
        }
        let meta = entry
            .metadata()
            .map_err(|e| format!("cannot read {}: {e}", entry.path().display()))?;
        check_trusted(&meta, &entry.path().display().to_string())?;
        if kind.is_dir() {
            reject_links_below(&entry.path(), depth + 1, seen)?;
        }
    }
    Ok(())
}

fn candidate(
    pack_dir: &Path,
    skill_dir: &Path,
    skill_md: &Path,
    fallback_name: &str,
    group: &str,
    check_nesting: bool,
) -> Candidate {
    let mut declared_name = None;
    let outcome = (|| {
        if check_nesting && crate::skill_discovery::has_deeper_skill_md(skill_dir) {
            return Err("skill nesting deeper than one group level is not supported".to_string());
        }
        let metadata = crate::skill_discovery::read_skill_metadata(skill_md, fallback_name);
        declared_name = metadata
            .as_ref()
            .map(|(name, _, _)| name.clone())
            .ok()
            .or_else(|| crate::skill_discovery::declared_skill_name(skill_md));
        let (name, description, targets) = metadata?;
        if crate::artifact_registry::SkillName::new(name.as_str()).is_none() {
            return Err(format!("invalid skill name: {name:?}"));
        }
        let skill = DiscoveredSkill {
            name,
            description,
            targets,
            group: group.to_string(),
            source_dir: skill_dir.to_path_buf(),
            skill_md_path: skill_md.to_path_buf(),
            relative_path: skill_md
                .strip_prefix(pack_dir)
                .unwrap_or(skill_md)
                .to_string_lossy()
                .replace('\\', "/"),
        };
        crate::skill_discovery::validate_skill_targets(std::slice::from_ref(&skill))?;
        for rel in crate::skill_discovery::skill_support_files(skill_dir)? {
            if crate::artifact_registry::SkillRelPath::new(rel.as_str()).is_none() {
                return Err(format!(
                    "a supporting file the installer cannot represent: {rel}"
                ));
            }
        }
        Ok(skill)
    })();
    // A skill that failed before its metadata was read still has a declared name worth keeping.
    let declared_name =
        declared_name.or_else(|| crate::skill_discovery::declared_skill_name(skill_md));
    Candidate {
        label: fallback_name.to_string(),
        declared_name,
        outcome,
    }
}

// ── Held skills ──

fn compute_held(
    workspace_root: &Path,
    packs: &[PackReport],
    catalog: &Result<Vec<CatalogSkill>, String>,
) -> (Vec<HeldSkill>, Option<String>) {
    let Ok(catalog) = catalog else {
        // A bundle that does not load is reported elsewhere; nothing is planned from it either.
        return (Vec::new(), None);
    };
    let Recorded {
        packs: recorded,
        forgotten,
        problem,
    } = read_recorded(workspace_root);
    let in_catalog: HashSet<&str> = catalog.iter().map(|s| s.skill.name.as_str()).collect();
    if let Some(problem) = problem {
        // Fail closed: without the record, any installed skill the catalog lacks may be a pack
        // skill. Only the skills the app itself retired are left to the normal retirement.
        let retired = |name: &str| {
            crate::managed_bootstrap::REMOVED_SKILL_NAMES.contains(&name)
                || name == crate::managed_bootstrap::LEGACY_SCOUT_AGENT
        };
        let mut names: Vec<String> = installed_skill_names(workspace_root)
            .into_iter()
            .filter(|name| !in_catalog.contains(name.as_str()) && !retired(name))
            .collect();
        names.sort();
        let held = names
            .into_iter()
            .map(|name| HeldSkill {
                pack: String::new(),
                name,
                state: HeldState::Missing,
                reason: problem.clone(),
            })
            .collect();
        return (held, Some(problem));
    }
    if recorded.is_empty() {
        return (Vec::new(), None);
    }
    let installed = installed_skill_names(workspace_root);
    let mut held = Vec::new();
    for (pack, names) in recorded {
        // A forgotten pack's skills are retired like any other: nothing is held for it.
        if forgotten.contains(&pack) {
            continue;
        }
        for name in names {
            // Only what the app installed can be held; a name never installed, or since removed
            // (uninstall, rollback), has nothing to protect.
            if in_catalog.contains(name.as_str()) || !installed.contains(&name) {
                continue;
            }
            let report = packs.iter().find(|report| report.name == pack);
            let (state, reason) = match report {
                None => (HeldState::Missing, "pack missing".to_string()),
                Some(report) => match &report.refused {
                    Some(reason) => (HeldState::Missing, format!("pack refused: {reason}")),
                    // A present pack with no skill in it at all, while a skill of it is installed:
                    // an emptied or unreadable checkout is told apart from a removal by the user
                    // forgetting the pack.
                    None if report.skills.is_empty() => (
                        HeldState::Missing,
                        "the pack holds no skills now".to_string(),
                    ),
                    None => match report
                        .skills
                        .iter()
                        .find(|skill| skill.name == name || skill.folder == name)
                    {
                        Some(skill) => (HeldState::Error, skill.reason.clone()),
                        None => match report
                            .skills
                            .iter()
                            .find(|skill| skill.state == PackSkillState::Error)
                        {
                            // Present and loaded, and the skill is not in it: removed on purpose,
                            // unless a skill of the pack is broken in a way that hides its name.
                            None => continue,
                            Some(broken) => (
                                HeldState::Error,
                                format!(
                                    "a skill of this pack cannot be read, and may be this one ({}: {})",
                                    broken.folder, broken.reason
                                ),
                            ),
                        },
                    },
                },
            };
            held.push(HeldSkill {
                pack: pack.clone(),
                name,
                state,
                reason,
            });
        }
    }
    (held, None)
}

// ── pack-skills.json ──

type Packs = BTreeMap<String, BTreeSet<String>>;

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecordDocument {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    packs: Packs,
    /// Packs the user forgot: their entries stay until an apply has retired their skills, so a
    /// rolled-back apply puts the file back as it was after the choice.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    forgotten: BTreeSet<String>,
}

enum Stored {
    Absent,
    Usable(Record),
    /// Valid JSON of another schema version.
    Foreign,
    Unusable,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Record {
    packs: Packs,
    forgotten: BTreeSet<String>,
}

/// What `pack-skills.json` holds. A file that exists and cannot be used is a `problem`, never an
/// empty record.
struct Recorded {
    packs: Packs,
    forgotten: BTreeSet<String>,
    problem: Option<String>,
}

fn record_path(workspace_root: &Path) -> PathBuf {
    crate::workspace_layout::state_file(workspace_root, PACK_SKILLS_FILE)
}

fn read_stored(workspace_root: &Path) -> Stored {
    let path = record_path(workspace_root);
    if crate::path_safety::reject_symlink_parent_chain(&path, workspace_root, "pack skills")
        .is_err()
        || crate::path_safety::reject_symlink(&path, "pack skills").is_err()
    {
        return Stored::Unusable;
    }
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Stored::Absent,
        Err(_) => return Stored::Unusable,
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Stored::Unusable;
    }
    let Some(document) = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RecordDocument>(&raw).ok())
    else {
        return Stored::Unusable;
    };
    if document.schema_version != SCHEMA_VERSION {
        return Stored::Foreign;
    }
    Stored::Usable(Record {
        packs: document.packs,
        forgotten: document.forgotten,
    })
}

const FOREIGN_RECORD: &str = "pack-skills.json was written by another version of Riggverk, so installed pack skills are kept as they are; update the app or move the file away";
const UNUSABLE_RECORD: &str = "pack-skills.json cannot be read, so installed pack skills are kept as they are; fix or remove the file";

fn read_recorded(workspace_root: &Path) -> Recorded {
    let (record, problem) = match read_stored(workspace_root) {
        Stored::Usable(record) => (record, None),
        Stored::Absent => (Record::default(), None),
        Stored::Foreign => (Record::default(), Some(FOREIGN_RECORD.to_string())),
        Stored::Unusable => (Record::default(), Some(UNUSABLE_RECORD.to_string())),
    };
    Recorded {
        packs: record.packs,
        forgotten: record.forgotten,
        problem,
    }
}

fn write_record(workspace_root: &Path, after: Record) -> Result<(), String> {
    let before = match read_stored(workspace_root) {
        Stored::Usable(record) => record,
        Stored::Absent | Stored::Unusable => Record::default(),
        Stored::Foreign => return Err(FOREIGN_RECORD.to_string()),
    };
    if before == after {
        return Ok(());
    }
    #[cfg(test)]
    if failing_writes::on() {
        return Err("write pack skills: failure injected by a test".to_string());
    }
    let document = RecordDocument {
        schema_version: SCHEMA_VERSION,
        packs: after.packs,
        forgotten: after.forgotten,
    };
    let raw = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("serialize pack skills: {error}"))?;
    crate::managed_state::ensure_data_folder(workspace_root)?;
    crate::safe_filesystem::write_regular_file_atomic(
        &record_path(workspace_root),
        &raw,
        workspace_root,
    )
    .map_err(|error| format!("write pack skills: {error}"))
}

/// Names of the skills the managed state holds a file of.
fn installed_skill_names(workspace_root: &Path) -> HashSet<String> {
    crate::managed_state::read_managed_state(workspace_root)
        .map(|state| {
            state
                .artifacts
                .iter()
                .filter_map(|record| {
                    crate::managed_bootstrap::artifact_from_identity(&record.identity)
                        .ok()?
                        .as_skill_file()
                })
                .map(|file| file.skill.as_str().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `name` was removed on purpose from `pack`: the pack is present and read, holds skills,
/// none of them is `name` and none is broken in a way that could hide it.
fn retired_from_present_pack(packs: &[PackReport], pack: &str, name: &str) -> bool {
    let Some(report) = packs.iter().find(|report| report.name == pack) else {
        return false;
    };
    report.refused.is_none()
        && !report.skills.is_empty()
        && !report
            .skills
            .iter()
            .any(|skill| skill.name == name || skill.folder == name)
        && !report
            .skills
            .iter()
            .any(|skill| skill.state == PackSkillState::Error)
}

/// Records the installed pack skills after a successful transaction. The record is merged, not
/// rebuilt: an entry stays unless its skill was retired from a pack that is present, or its pack
/// was forgotten. The file is outside the transaction's rollback of files, so an entry that a
/// later rollback of an uninstall needs must not have been dropped meanwhile.
pub fn record_after_transaction(
    workspace_root: &Path,
    sources: &SkillSources,
) -> Result<(), String> {
    // A file that cannot be used is left alone (a rewrite would lose what it said) and is reported
    // where the skills it should cover are listed, not on every apply.
    if sources.record_problem().is_some() {
        return Ok(());
    }
    let mut record = match read_stored(workspace_root) {
        Stored::Usable(record) => record,
        _ => Record::default(),
    };
    for pack in std::mem::take(&mut record.forgotten) {
        record.packs.remove(&pack);
    }
    for (pack, names) in record.packs.iter_mut() {
        names.retain(|name| !retired_from_present_pack(sources.packs(), pack, name));
    }
    let installed = installed_skill_names(workspace_root);
    for (name, pack) in sources.active_pack_skills() {
        if installed.contains(name) {
            record
                .packs
                .entry(pack.to_string())
                .or_default()
                .insert(name.to_string());
        }
    }
    record.packs.retain(|_, names| !names.is_empty());
    write_record(workspace_root, record)
}

/// Forgets a pack: its recorded skills stop being held, so the next Install retires their
/// app-owned copies with a backup. Refused while the pack still provides skills. The entry itself
/// is dropped by that Install (see [`record_after_transaction`]).
pub fn forget_pack(workspace_root: &Path, pack: &str) -> Result<usize, String> {
    if !valid_pack_name(pack) {
        return Err(format!("not a pack name: {pack:?}"));
    }
    let sources = SkillSources::for_workspace(workspace_root)?;
    if sources.active_pack_skills().values().any(|p| *p == pack) {
        return Err(format!(
            "pack {pack} is present and provides skills; remove its folder first"
        ));
    }
    let recorded = read_recorded(workspace_root);
    if let Some(problem) = recorded.problem {
        return Err(problem);
    }
    let Some(names) = recorded.packs.get(pack) else {
        return Err(format!("no installed skills are recorded for pack {pack}"));
    };
    if recorded.forgotten.contains(pack) {
        return Err(format!("pack {pack} is already forgotten"));
    }
    let count = names.len();
    let mut forgotten = recorded.forgotten;
    forgotten.insert(pack.to_string());
    write_record(
        workspace_root,
        Record {
            packs: recorded.packs,
            forgotten,
        },
    )?;
    Ok(count)
}

// ── pack-skills.json and rollback ──

const RECORD_BACKUP: &str = "pack-skills.previous.json";
const RECORD_ABSENT: &str = "pack-skills.previous.absent";

/// Saves `pack-skills.json` into a transaction's backup folder, as it is before the apply (or a
/// marker that there was none), so a rollback of the transaction puts it back.
pub fn snapshot_record(workspace_root: &Path, backup_dir: &Path) -> Result<(), String> {
    let path = record_path(workspace_root);
    let (name, raw) = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (RECORD_ABSENT, Vec::new()),
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES => (
            RECORD_BACKUP,
            fs::read(&path).map_err(|e| format!("read pack skills: {e}"))?,
        ),
        // A link, a folder, an oversized file: not ours to restore.
        _ => return Ok(()),
    };
    crate::safe_filesystem::write_regular_file_atomic(&backup_dir.join(name), &raw, backup_dir)
        .map_err(|e| format!("back up pack skills: {e}"))
}

/// Puts `pack-skills.json` back as [`snapshot_record`] saved it. A transaction without a snapshot
/// (made by an earlier version) restores nothing.
///
/// A pack forgotten since (outside any transaction) stays forgotten when the snapshot still
/// records it: an undo of an earlier install must not take that choice back. A pack the snapshot
/// does not record has nothing left to forget.
pub fn restore_record(workspace_root: &Path, backup_dir: &Path) -> Result<(), String> {
    let path = record_path(workspace_root);
    let saved = backup_dir.join(RECORD_BACKUP);
    if crate::path_safety::reject_symlink(&saved, "pack skills backup").is_err() {
        return Err("refusing a symlinked pack skills backup".to_string());
    }
    if saved.is_file() {
        let mut raw = fs::read(&saved).map_err(|e| format!("read pack skills backup: {e}"))?;
        if let (Stored::Usable(live), Ok(mut document)) = (
            read_stored(workspace_root),
            serde_json::from_slice::<RecordDocument>(&raw),
        ) {
            let later: Vec<String> = live
                .forgotten
                .into_iter()
                .filter(|pack| {
                    document.packs.contains_key(pack) && !document.forgotten.contains(pack)
                })
                .collect();
            if document.schema_version == SCHEMA_VERSION && !later.is_empty() {
                document.forgotten.extend(later);
                raw = serde_json::to_vec_pretty(&document)
                    .map_err(|error| format!("serialize pack skills: {error}"))?;
            }
        }
        crate::managed_state::ensure_data_folder(workspace_root)?;
        return crate::safe_filesystem::write_regular_file_atomic(&path, &raw, workspace_root)
            .map_err(|e| format!("restore pack skills: {e}"));
    }
    if backup_dir.join(RECORD_ABSENT).is_file() && path.is_file() {
        crate::safe_filesystem::remove_regular_file_no_symlinks(&path, workspace_root)
            .map_err(|e| format!("remove pack skills: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_names_follow_the_contract() {
        for ok in ["a", "0", "hugrverk", "my-pack-2", &"a".repeat(64)] {
            assert!(valid_pack_name(ok), "{ok}");
        }
        for bad in ["", "-a", "A", "a_b", "a.b", ".git", "a b", &"a".repeat(65)] {
            assert!(!valid_pack_name(bad), "{bad}");
        }
    }
}
