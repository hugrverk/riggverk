use serde::Serialize;
use std::path::Path;

use super::content::{bundled_library_root, DocumentContent};
use super::workspace::{setup_workspace_target_path, workspace_target_for_write};
use crate::path_safety::reject_symlink;
#[cfg(test)]
use crate::skills_install::discover_workspace_skills;

#[derive(Serialize)]
pub struct SkillSummary {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) path: String,
    pub(crate) group: String,
    pub(crate) category: String,
    pub(crate) risk: String,
    pub(crate) targets: Vec<String>,
    pub(crate) related: Vec<String>,
}

fn skill_summary_from_path(
    root: &Path,
    skill_md: &Path,
    id: String,
    fallback_name: String,
    group: String,
) -> SkillSummary {
    let content = std::fs::read_to_string(skill_md).unwrap_or_default();
    let fields = crate::skill_discovery::skill_fields(&content).unwrap_or_default();
    let field = |key: &str| fields.get(key).cloned().unwrap_or_default();
    let name = field("name");
    let desc = field("description");
    let category = field("category");
    let risk = field("risk");
    let targets = split_list(&field("targets"));
    let related = split_list(&field("related"));
    let rel = skill_md
        .strip_prefix(root)
        .unwrap_or(skill_md)
        .to_string_lossy()
        .replace('\\', "/");

    SkillSummary {
        id,
        name: if name.is_empty() { fallback_name } else { name },
        description: desc,
        path: rel,
        group,
        category,
        risk,
        targets,
        related,
    }
}

fn has_deeper_skill_md(dir: &Path) -> bool {
    crate::skill_discovery::has_deeper_skill_md(dir)
}

pub(crate) fn discover_skills(root: &Path) -> Result<Vec<SkillSummary>, String> {
    let skills_dir = root.join("skills");
    let mut discovered: Vec<SkillSummary> = Vec::new();

    reject_symlink(&skills_dir, "skills root")?;

    let entries =
        std::fs::read_dir(&skills_dir).map_err(|e| format!("cannot read skills dir: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("read error: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("file type error: {}", e))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing symlink skill directory: {}",
                entry.path().display()
            ));
        }
        if !file_type.is_dir() {
            continue;
        }

        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let root_skill_md = entry_path.join("SKILL.md");
        reject_symlink(&root_skill_md, "skill file")?;
        if root_skill_md.is_file() {
            if has_deeper_skill_md(&entry_path) {
                return Err(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    entry_path.display()
                ));
            }
            discovered.push(skill_summary_from_path(
                root,
                &root_skill_md,
                format!("workspace/{}", entry_name),
                entry_name,
                String::new(),
            ));
            continue;
        }

        let sub_entries = std::fs::read_dir(&entry_path)
            .map_err(|e| format!("cannot read skills group dir: {}", e))?;
        for sub in sub_entries {
            let sub = sub.map_err(|e| format!("read error: {}", e))?;
            let sub_type = sub
                .file_type()
                .map_err(|e| format!("file type error: {}", e))?;
            if sub_type.is_symlink() {
                return Err(format!(
                    "refusing symlink skill directory: {}",
                    sub.path().display()
                ));
            }
            if !sub_type.is_dir() {
                continue;
            }
            let sub_path = sub.path();
            let sub_name = sub.file_name().to_string_lossy().into_owned();
            let grouped_skill_md = sub_path.join("SKILL.md");
            reject_symlink(&grouped_skill_md, "skill file")?;
            if grouped_skill_md.is_file() {
                discovered.push(skill_summary_from_path(
                    root,
                    &grouped_skill_md,
                    format!("workspace/{}/{}", entry_name, sub_name),
                    sub_name,
                    entry_name.clone(),
                ));
            } else if has_deeper_skill_md(&sub_path) {
                return Err(format!(
                    "skill nesting deeper than one group level is not supported: {}",
                    sub_path.display()
                ));
            }
        }
    }

    discovered.sort_by(|a, b| match a.group.cmp(&b.group) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });

    let mut names = std::collections::HashSet::new();
    for skill in &discovered {
        if !names.insert(skill.name.clone()) {
            return Err(format!(
                "duplicate skill name in repository: {}",
                skill.name
            ));
        }
    }

    Ok(discovered)
}

/// The skills bundled with the app, read from the bundle (never from a copy in the workspace).
#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillSummary>, String> {
    discover_skills(&bundled_library_root()?)
}

/// The skill copies each enabled harness loads and the problems among them (see `skill_loads`).
///
/// Read-only. It lists the skills folders the enabled harnesses read and opens the `SKILL.md` of
/// their subfolders, nothing else, so it runs off the main thread.
#[tauri::command(async)]
pub fn get_effective_skill_loads() -> Result<crate::skill_loads::EffectiveSkillLoads, String> {
    let settings = crate::settings::try_load()
        .map_err(|error| format!("cannot tell which harnesses are enabled: {error}"))?;
    let workspace_root = setup_workspace_target_path()?;
    let home = crate::agent_targets::home_dir()?;
    let sources = crate::skill_sources::SkillSources::for_workspace(&workspace_root)?;
    let records = crate::managed_state::read_managed_state(&workspace_root)
        .map(|state| state.artifacts)
        .unwrap_or_default();
    let proof = crate::skill_loads::OwnershipProof::new(&sources, &records)?
        .with_kept(crate::kept_files::KeptFiles::load(&workspace_root));
    Ok(crate::skill_loads::effective_skill_loads(
        &home,
        &settings.enabled_harness_ids,
        &crate::skill_loads::FolderPaths::resolve(&home),
        &proof,
    ))
}

/// Most names one `set_skills_enabled` call takes.
const MAX_NAMES_PER_CALL: usize = 200;
/// Largest part of a `SKILL.md` read for the skills it names.
const MAX_NAMED_BY_BYTES: u64 = 256 * 1024;

/// A skill the user disabled.
#[derive(Debug, Serialize)]
pub struct DisabledSkillChoice {
    pub(crate) name: String,
    /// `bundle`, `pack:<pack>`, or `unknown` for a name the catalog no longer holds.
    pub(crate) source: String,
    /// The managed state still holds a copy of it: the next Update removes it.
    pub(crate) installed: bool,
}

/// Which skills are disabled, and which skills name which others, for the Library.
#[derive(Debug, Serialize)]
pub struct SkillChoices {
    pub(crate) disabled: Vec<DisabledSkillChoice>,
    /// Skill name to the skills whose `SKILL.md` names it in backticks, both sorted. Only names
    /// some skill names.
    pub(crate) named_by: std::collections::BTreeMap<String, Vec<String>>,
    /// Why `disabled-skills.json` cannot be used; set, nothing can be enabled or disabled.
    pub(crate) problem: Option<String>,
}

/// The backticked spans of `text`, line by line, so an unpaired backtick spoils one line at most.
fn backticked_spans(text: &str) -> impl Iterator<Item = &str> {
    text.lines().flat_map(|line| {
        let parts: Vec<&str> = line.split('`').collect();
        let paired = parts.len() % 2 == 1;
        parts
            .into_iter()
            .skip(1)
            .step_by(2)
            .filter(move |span| paired && !span.is_empty())
    })
}

/// For each catalog skill, the other catalog skills whose `SKILL.md` names it in a backticked span
/// exactly. Each file is read up to [`MAX_NAMED_BY_BYTES`].
fn named_by<R: crate::skill_sources::SourceRoot + ?Sized>(
    sources: &R,
) -> std::collections::BTreeMap<String, Vec<String>> {
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::Read;
    let catalog = sources.catalog().unwrap_or_default();
    let names: BTreeSet<&str> = catalog
        .iter()
        .map(|entry| entry.skill.name.as_str())
        .collect();
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for entry in &catalog {
        let mut text = String::new();
        let Ok(file) = std::fs::File::open(&entry.skill.skill_md_path) else {
            continue;
        };
        if file
            .take(MAX_NAMED_BY_BYTES)
            .read_to_string(&mut text)
            .is_err()
        {
            continue;
        }
        for span in backticked_spans(&text) {
            if span != entry.skill.name && names.contains(span) {
                out.entry(span.to_string())
                    .or_default()
                    .insert(entry.skill.name.clone());
            }
        }
    }
    out.into_iter()
        .map(|(name, by)| (name, by.into_iter().collect()))
        .collect()
}

fn skill_choices(
    workspace_root: &Path,
    sources: &crate::skill_sources::SkillSources,
) -> SkillChoices {
    use crate::skill_sources::SourceRoot;
    let installed = crate::skill_sources::installed_skill_names(workspace_root);
    let catalog = sources.catalog().unwrap_or_default();
    let (disabled, problem) = match sources.disabled() {
        Ok(names) => (
            names
                .iter()
                .map(|name| DisabledSkillChoice {
                    name: name.clone(),
                    source: match catalog.iter().find(|entry| &entry.skill.name == name) {
                        Some(entry) => match &entry.pack {
                            Some(pack) => format!("pack:{pack}"),
                            None => "bundle".to_string(),
                        },
                        None => "unknown".to_string(),
                    },
                    installed: installed.contains(name),
                })
                .collect(),
            None,
        ),
        Err(problem) => (Vec::new(), Some(problem.to_string())),
    };
    SkillChoices {
        disabled,
        named_by: named_by(sources),
        problem,
    }
}

/// The disabled skills and the skills that name each skill. Read-only.
#[tauri::command(async)]
pub fn list_skill_choices() -> Result<SkillChoices, String> {
    let workspace_root = setup_workspace_target_path()?;
    let sources = crate::skill_sources::SkillSources::for_workspace(&workspace_root)?;
    Ok(skill_choices(&workspace_root, &sources))
}

/// Why `name` cannot be disabled, or `None` when it can: a bundled skill or an active pack skill.
/// A shadowed pack skill's name is the bundled skill's, so it disables the bundled one.
fn disable_refusal(sources: &crate::skill_sources::SkillSources, name: &str) -> Option<String> {
    use crate::skill_sources::SourceRoot;
    let in_catalog = sources
        .catalog()
        .unwrap_or_default()
        .iter()
        .any(|entry| entry.skill.name == name);
    if in_catalog {
        return None;
    }
    if let Some(held) = sources.held().iter().find(|held| held.name == name) {
        return Some(format!(
            "{name} is kept as it is installed ({}); fix or forget its pack first",
            held.reason
        ));
    }
    if let Some(skill) = sources
        .packs()
        .iter()
        .flat_map(|pack| &pack.skills)
        .find(|skill| skill.name == name)
    {
        return Some(format!("{name} is not in use: {}", skill.reason));
    }
    Some(format!("no skill named {name} is bundled or in a pack"))
}

/// Disables (`enabled` false) or enables the skills `names` for every harness. Writes only
/// `disabled-skills.json`; the next Update removes or installs their copies. Disabling takes a
/// bundled skill or an active pack skill; enabling takes any name, so a disabled name that left the
/// catalog can be forgotten.
#[tauri::command(async)]
pub fn set_skills_enabled(names: Vec<String>, enabled: bool) -> Result<(), String> {
    if names.is_empty() {
        return Err("name at least one skill".to_string());
    }
    if names.len() > MAX_NAMES_PER_CALL {
        return Err(format!("at most {MAX_NAMES_PER_CALL} skills at a time"));
    }
    // Changes what an apply plans: wait for a running mutation instead of interleaving with it.
    let _mutation = crate::mutation_lock::acquire()?;
    let _guard = crate::setup_mutation_guard::try_acquire_setup_mutation_guard()?;
    let workspace_root = workspace_target_for_write()?;
    let sources = crate::skill_sources::SkillSources::for_workspace(&workspace_root)?;
    if let Err(problem) = crate::skill_sources::SourceRoot::disabled(&sources) {
        return Err(problem.to_string());
    }
    if !enabled {
        if let Some(refusal) = names
            .iter()
            .find_map(|name| disable_refusal(&sources, name))
        {
            return Err(refusal);
        }
    }
    crate::disabled_skills::set(&workspace_root, &names, enabled)
}

#[tauri::command]
pub fn read_skill(id: String) -> Result<DocumentContent, String> {
    if id.starts_with("pack:") {
        return super::packs::read_pack_skill(id);
    }
    let root = bundled_library_root()?;
    let skills = discover_skills(&root)?;
    let found = skills.iter().find(|s| s.id == id);
    match found {
        Some(s) => {
            let path = root.join(&s.path);
            let content =
                std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
            let area = s.id.split('/').next().unwrap_or("workspace").to_string();
            Ok(DocumentContent {
                id: s.id.clone(),
                title: s.name.clone(),
                section: area,
                path: s.path.clone(),
                source: "curated".into(),
                content,
                revision: None,
            })
        }
        None => Err(format!("unknown skill: {}", id)),
    }
}

fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
pub(crate) fn workspace_skill_names(root: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = discover_workspace_skills(&root.join("skills"))?
        .into_keys()
        .collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::discover_skills;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("riggverk-{name}-{nonce}"))
    }

    #[cfg(unix)]
    #[test]
    fn dangling_skill_file_symlink_is_refused() {
        let root = temp_root("dangling-skill-md");
        let skill_dir = root.join("skills/group/skill");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::os::unix::fs::symlink(root.join("missing.md"), skill_dir.join("SKILL.md"))
            .expect("create dangling symlink");
        let result = discover_skills(&root);
        let _ = fs::remove_dir_all(&root);
        let err = result.err().expect("dangling symlink must not be skipped");
        assert!(err.contains("refusing symlink skill file"), "{err}");
    }

    fn write_skill(root: &Path, rel: &str, name: &str) {
        let path = root.join(rel).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill parent");
        }
        fs::write(
            path,
            format!("---\nname: {}\ndescription: test skill\n---\n", name),
        )
        .expect("write skill");
    }

    fn write_skill_with_metadata(
        root: &Path,
        rel: &str,
        name: &str,
        category: &str,
        risk: &str,
        targets: &str,
        related: &str,
    ) {
        let path = root.join(rel).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill parent");
        }
        fs::write(
            path,
            format!(
                "---\nname: {}\ndescription: test skill\ncategory: {}\nrisk: {}\ntargets: {}\nrelated: {}\n---\n",
                name, category, risk, targets, related
            ),
        )
        .expect("write skill with metadata");
    }

    #[test]
    fn flat_skill_layout_is_listed() {
        let root = temp_root("flat-skills");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "workspace/diagnose");
        assert_eq!(skills[0].name, "diagnose");
        assert_eq!(skills[0].path, "skills/diagnose/SKILL.md");
    }

    #[test]
    fn grouped_skill_layout_is_listed() {
        let root = temp_root("grouped-skills");
        write_skill(&root, "skills/domain/domain-change", "domain-change");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "workspace/domain/domain-change");
        assert_eq!(skills[0].name, "domain-change");
        assert_eq!(skills[0].group, "domain");
        assert_eq!(skills[0].path, "skills/domain/domain-change/SKILL.md");
    }

    #[test]
    fn mixed_root_and_grouped_discovery() {
        let root = temp_root("mixed-skills");
        write_skill(&root, "skills/diagnose", "diagnose");
        write_skill(&root, "skills/domain/domain-change", "domain-change");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "diagnose");
        assert_eq!(skills[0].group, "");
        assert_eq!(skills[1].name, "domain-change");
        assert_eq!(skills[1].group, "domain");
    }

    #[test]
    fn duplicate_frontmatter_name_across_groups_is_rejected() {
        let root = temp_root("dup-groups");
        write_skill(&root, "skills/alpha/shared-skill", "shared-skill");
        write_skill(&root, "skills/beta/shared-skill", "shared-skill");

        match discover_skills(&root) {
            Err(err) => assert!(err.contains("duplicate skill name")),
            Ok(_) => panic!("duplicate names must fail"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deeper_nesting_is_rejected() {
        let root = temp_root("deep-nesting");
        write_skill(&root, "skills/debug/nested/diagnose", "diagnose");

        match discover_skills(&root) {
            Err(err) => assert!(err.contains("deeper than one group level")),
            Ok(_) => panic!("deep nesting must fail"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deterministic_ordering_by_group_and_name() {
        let root = temp_root("ordering");
        write_skill(&root, "skills/zeta/z-skill", "z-skill");
        write_skill(&root, "skills/alpha/a-skill", "a-skill");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["diagnose", "a-skill", "z-skill"]);
    }

    #[test]
    fn grouped_skill_open_and_read_paths_resolve() {
        let root = temp_root("grouped-open");
        write_skill(&root, "skills/domain/domain-change", "domain-change");

        let skills = discover_skills(&root).expect("discover skills");
        let found = skills
            .iter()
            .find(|s| s.id == "workspace/domain/domain-change")
            .expect("grouped skill id exists");
        let path = root.join(&found.path);
        let exists = path.is_file();
        let _ = fs::remove_dir_all(&root);
        assert!(exists);
    }

    #[test]
    fn flat_baseline_starter_skills_are_discoverable() {
        let root = temp_root("baseline-skills");
        write_skill(&root, "skills/diagnose", "diagnose");
        write_skill(&root, "skills/security", "security");
        write_skill(&root, "skills/context-budget", "context-budget");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"diagnose"));
        assert!(names.contains(&"security"));
        assert!(names.contains(&"context-budget"));
    }

    #[test]
    fn duplicate_root_skill_names_are_rejected() {
        let root = temp_root("duplicate-root-skills");
        write_skill(&root, "skills/diagnose-c", "duplicate-skill");
        write_skill(&root, "skills/diagnose-b", "duplicate-skill");

        match discover_skills(&root) {
            Err(err) => assert!(err.contains("duplicate skill name")),
            Ok(_) => panic!("duplicate names must fail"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn flat_skill_id_resolves_to_openable_path() {
        let root = temp_root("flat-open-skill");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let found = skills
            .iter()
            .find(|s| s.id == "workspace/diagnose")
            .expect("flat skill id exists");
        let path = root.join(&found.path);
        let exists = path.is_file();
        let _ = fs::remove_dir_all(&root);

        assert!(exists, "flat skill id must resolve to SKILL.md");
    }

    #[test]
    fn read_skill_known_id_resolves_content() {
        let root = temp_root("read-skill-known");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let found = skills
            .iter()
            .find(|s| s.name == "diagnose")
            .expect("skill exists");

        let path = root.join(&found.path);
        let raw = std::fs::read_to_string(&path).expect("read raw");
        let _ = fs::remove_dir_all(&root);

        assert!(raw.contains("name: diagnose"));
        assert!(raw.contains("description: test skill"));
    }

    #[test]
    fn read_skill_unknown_id_is_rejected_via_registry() {
        let root = temp_root("read-skill-unknown");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let found = skills.iter().find(|s| s.id == "nonexistent/skill");
        assert!(found.is_none(), "unknown id must not resolve");
    }

    #[test]
    fn read_skill_path_traversal_id_is_rejected() {
        let root = temp_root("read-skill-traversal");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let bad_ids = [
            "../../../etc/passwd",
            "skills/../diagnose",
            "../../../../etc/hosts",
        ];
        for bad in &bad_ids {
            let found = skills.iter().find(|s| s.id == *bad);
            assert!(
                found.is_none(),
                "path traversal id '{}' must not resolve",
                bad
            );
        }
    }

    #[test]
    fn minimal_skill_has_empty_metadata_fields() {
        let root = temp_root("minimal-meta");
        write_skill(&root, "skills/diagnose", "diagnose");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].category, "");
        assert_eq!(skills[0].risk, "");
        assert!(skills[0].targets.is_empty());
        assert!(skills[0].related.is_empty());
    }

    #[test]
    fn metadata_fields_parse_correctly() {
        let root = temp_root("meta-fields");
        write_skill_with_metadata(
            &root,
            "skills/frontend",
            "frontend",
            "frontend",
            "medium",
            "codex, opencode, claude, cursor",
            "screenshot, browser-qa, accessibility",
        );

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(skills.len(), 1);
        let s = &skills[0];
        assert_eq!(s.name, "frontend");
        assert_eq!(s.category, "frontend");
        assert_eq!(s.risk, "medium");
        assert_eq!(s.targets, vec!["codex", "opencode", "claude", "cursor"]);
        assert_eq!(s.related, vec!["screenshot", "browser-qa", "accessibility"]);
    }

    #[test]
    fn comma_lists_parse_deterministically() {
        let root = temp_root("meta-lists");
        write_skill_with_metadata(
            &root,
            "skills/security",
            "security",
            "security",
            "high",
            "codex,  opencode , claude,cursor,  ",
            "diagnose,  ,release-check,",
        );

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let s = &skills[0];
        // whitespace trimmed, empty entries removed
        assert_eq!(s.targets, vec!["codex", "opencode", "claude", "cursor"]);
        assert_eq!(s.related, vec!["diagnose", "release-check"]);
    }

    /// The Library shows the same metadata for a skill in the spec layout (`metadata:`) as for one
    /// with the older top-level keys.
    #[test]
    fn spec_metadata_layout_reads_like_top_level_keys() {
        let root = temp_root("meta-spec-layout");
        let path = root.join("skills/frontend/SKILL.md");
        fs::create_dir_all(path.parent().expect("parent")).expect("create skill parent");
        fs::write(
            &path,
            "---\nname: frontend\ndescription: test skill\nlicense: MIT\nmetadata:\n  category: frontend\n  risk: medium\n  targets: codex, opencode, claude, cursor\n  related: screenshot, browser-qa\n---\n",
        )
        .expect("write skill");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let s = &skills[0];
        assert_eq!(s.category, "frontend");
        assert_eq!(s.risk, "medium");
        assert_eq!(s.targets, vec!["codex", "opencode", "claude", "cursor"]);
        assert_eq!(s.related, vec!["screenshot", "browser-qa"]);
    }

    #[test]
    fn empty_metadata_stays_empty() {
        let root = temp_root("empty-meta");
        write_skill_with_metadata(&root, "skills/diagnose", "diagnose", "", "", "", "");

        let skills = discover_skills(&root).expect("discover skills");
        let _ = fs::remove_dir_all(&root);

        let s = &skills[0];
        assert_eq!(s.category, "");
        assert_eq!(s.risk, "");
        assert!(s.targets.is_empty());
        assert!(s.related.is_empty());
    }
}
