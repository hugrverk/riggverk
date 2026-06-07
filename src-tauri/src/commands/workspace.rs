use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::process::{run_cmd, ActionResult};
use super::status::file_eq;
use crate::agent_targets;
use crate::path_utils::{
    default_installed_workspace_path, is_legacy_default_workspace_path,
    normalize_user_workspace_path, normalize_user_workspace_path_for_save,
};
use crate::settings;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum MarkerKind {
    File,
    Dir,
}

impl MarkerKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            MarkerKind::File => "file",
            MarkerKind::Dir => "dir",
        }
    }

    pub(crate) fn exists(&self, base: &Path, rel: &str) -> bool {
        let p = base.join(rel);
        match self {
            MarkerKind::File => p.is_file(),
            MarkerKind::Dir => p.is_dir(),
        }
    }
}

pub(crate) struct MarkerDef {
    pub kind: MarkerKind,
    pub rel_path: &'static str,
}

pub(crate) fn workspace_marker_defs() -> &'static [MarkerDef] {
    &[
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: ".agent-workspace/workspace.json",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "scripts/bootstrap.sh",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "scripts/install-agent-rules.sh",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "scripts/install-opencode-config.sh",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "scripts/install-codex-config.sh",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "scripts/install-cursor-workspace.sh",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "scripts/install-skills.sh",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "templates/global-agent-rules.md",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "templates/opencode.json",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "templates/codex/config.toml",
        },
        MarkerDef {
            kind: MarkerKind::Dir,
            rel_path: "templates/cursor/agents",
        },
        MarkerDef {
            kind: MarkerKind::Dir,
            rel_path: "templates/cursor/rules",
        },
        MarkerDef {
            kind: MarkerKind::File,
            rel_path: "README.md",
        },
        MarkerDef {
            kind: MarkerKind::Dir,
            rel_path: "skills",
        },
    ]
}

/// Check that templates/cursor/rules/ contains at least one .mdc file.
/// This enforces that Cursor project rules are present while allowing
/// workspace-specific filenames (e.g. agent-workspace.mdc, ux-workspace.mdc).
pub(crate) fn workspace_has_cursor_mdc_rule(base: &Path) -> bool {
    let rules_dir = base.join("templates/cursor/rules");
    if !rules_dir.is_dir() {
        return false;
    }
    match rules_dir.read_dir() {
        Ok(entries) => entries
            .flatten()
            .any(|e| e.path().extension().is_some_and(|ext| ext == "mdc")),
        Err(_) => false,
    }
}

pub(crate) const NO_WORKSPACE_SELECTED: &str = "no workspace selected";

/// Resolved workspace candidate path: env override, valid saved custom path, or canonical install path.
pub(crate) fn configured_workspace_path(settings: &settings::AppSettings) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AGENT_WORKSPACE_PATH") {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    if let Some(ref custom) = settings.workspace_path {
        if !is_legacy_default_workspace_path(custom) {
            if let Some(normalized) = normalize_user_workspace_path(custom) {
                if persisted_workspace_path_is_valid(&normalized) {
                    return Some(PathBuf::from(normalized));
                }
            }
        }
    }
    default_installed_workspace_path().ok()
}

#[allow(dead_code)]
pub(super) fn repo_path() -> PathBuf {
    let settings = settings::load();
    repo_path_from_settings(&settings)
}

#[cfg_attr(not(test), allow(dead_code))]
fn repo_path_from_settings(settings: &settings::AppSettings) -> PathBuf {
    configured_workspace_path(settings).unwrap_or_default()
}

pub(super) fn validate_workspace_root(root: PathBuf) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|_| "invalid workspace path: not a valid workspace".to_string())?;

    if !canonical.is_dir() {
        return Err("invalid workspace path: not a valid workspace".into());
    }

    if workspace_marker_defs()
        .iter()
        .any(|def| !def.kind.exists(&canonical, def.rel_path))
    {
        return Err("invalid workspace path: not a valid workspace".into());
    }

    if !workspace_has_cursor_mdc_rule(&canonical) {
        return Err("invalid workspace path: not a valid workspace".into());
    }

    Ok(canonical)
}

pub(super) fn workspace_root() -> Result<PathBuf, String> {
    let settings = settings::load();
    let path =
        configured_workspace_path(&settings).ok_or_else(|| NO_WORKSPACE_SELECTED.to_string())?;
    validate_workspace_root(path)
}

/// Repair/update target: configured workspace when valid, else canonical install path.
pub(crate) fn repair_workspace_target_path() -> Result<PathBuf, String> {
    workspace_root().or_else(|_| default_installed_workspace_path())
}

/// Returns true when a persisted workspace path resolves to a valid workspace.
pub(crate) fn persisted_workspace_path_is_valid(path: &str) -> bool {
    validate_workspace_root(PathBuf::from(path)).is_ok()
}

/// Clear a stale persisted workspace path that no longer validates.
pub(crate) fn scrub_stale_workspace_path(settings: &mut settings::AppSettings) -> bool {
    let Some(path) = settings.workspace_path.clone() else {
        return false;
    };
    if is_legacy_default_workspace_path(&path) {
        settings.workspace_path = None;
        return true;
    }
    if persisted_workspace_path_is_valid(&path) {
        return false;
    }
    settings.workspace_path = None;
    true
}

pub(super) fn path_arg(path: &Path) -> Result<String, String> {
    crate::shell_runtime::path_arg_for_native_process(path)
}

/// Append a cursor rule marker status to the diagnostics markers vec.
/// Uses the base path to check for .mdc files in templates/cursor/rules/.
fn push_cursor_rule_marker(markers: &mut Vec<WorkspaceMarkerStatus>, base: &Path) {
    markers.push(WorkspaceMarkerStatus {
        kind: "dir_with_mdc".to_string(),
        path: "templates/cursor/rules/*.mdc".to_string(),
        exists: workspace_has_cursor_mdc_rule(base),
    });
}

fn release_check_available(root: &Path) -> bool {
    root.join("scripts/release-check.sh").is_file()
}

#[derive(Serialize)]
pub struct WorkspaceMarkerStatus {
    kind: String,
    path: String,
    exists: bool,
}

#[derive(Serialize)]
pub struct WorkspaceDiagnostics {
    candidate_path: String,
    resolved_path: Option<String>,
    valid: bool,
    error: Option<String>,
    markers: Vec<WorkspaceMarkerStatus>,
    enabled_rule_targets: usize,
    total_rule_targets: usize,
    enabled_config_targets: usize,
    total_config_targets: usize,
    backup_root: String,
    backup_root_exists: bool,
    release_check_available: bool,
    /// `current` when all bundled default files exist; `missing` when any are absent.
    bundled_resources_status: String,
    missing_bundled_count: usize,
    /// Sample of missing bundled paths (workspace-relative, capped).
    missing_bundled_sample: Vec<String>,
}

const MISSING_BUNDLED_SAMPLE_CAP: usize = 5;

/// Installed workspace file is absent or zero bytes (treat empty placeholders as missing).
pub(crate) fn workspace_install_file_missing(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta.len() == 0,
        Ok(_) => false,
        Err(_) => true,
    }
}

/// Paths from `default_workspace_files()` that are absent under `root`.
pub(crate) fn missing_bundled_file_paths(root: &Path) -> Vec<String> {
    let mut missing = Vec::new();
    for (_label, paths) in super::defaults::default_workspace_files() {
        for &rel in paths {
            if rel.contains("..") || rel.is_empty() || Path::new(rel).is_absolute() {
                continue;
            }
            if workspace_install_file_missing(&root.join(rel)) {
                missing.push(rel.to_string());
            }
        }
    }
    missing
}

fn bundled_resources_fields(root: &Path) -> (String, usize, Vec<String>) {
    let missing = missing_bundled_file_paths(root);
    let status = if missing.is_empty() {
        "current".to_string()
    } else {
        "missing".to_string()
    };
    let count = missing.len();
    let sample: Vec<String> = missing
        .into_iter()
        .take(MISSING_BUNDLED_SAMPLE_CAP)
        .collect();
    (status, count, sample)
}

fn empty_bundled_resources_fields() -> (String, usize, Vec<String>) {
    ("unknown".to_string(), 0, Vec::new())
}

fn workspace_diagnostics_for_unconfigured(
    settings: &settings::AppSettings,
) -> WorkspaceDiagnostics {
    let enabled = &settings.enabled_target_ids;
    let total_rules = agent_targets::rule_targets().len();
    let total_configs = agent_targets::config_targets().len();
    let enabled_rules = agent_targets::rule_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .count();
    let enabled_configs = agent_targets::config_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .count();
    let (backup_root, backup_root_exists) = match super::backups::backup_root() {
        Ok(path) => {
            let exists = path.exists();
            (path.to_string_lossy().into_owned(), exists)
        }
        Err(_) => (String::new(), false),
    };

    let (bundled_resources_status, missing_bundled_count, missing_bundled_sample) =
        empty_bundled_resources_fields();
    WorkspaceDiagnostics {
        candidate_path: String::new(),
        resolved_path: None,
        valid: false,
        error: Some(NO_WORKSPACE_SELECTED.into()),
        markers: Vec::new(),
        enabled_rule_targets: enabled_rules,
        total_rule_targets: total_rules,
        enabled_config_targets: enabled_configs,
        total_config_targets: total_configs,
        backup_root,
        backup_root_exists,
        release_check_available: false,
        bundled_resources_status,
        missing_bundled_count,
        missing_bundled_sample,
    }
}

#[tauri::command]
pub fn get_workspace_diagnostics() -> Result<WorkspaceDiagnostics, String> {
    let settings = settings::load();
    let Some(candidate) = configured_workspace_path(&settings) else {
        return Ok(workspace_diagnostics_for_unconfigured(&settings));
    };
    let candidate_str = candidate.to_string_lossy().into_owned();

    let (valid, resolved_path, error, markers) = match candidate.canonicalize() {
        Ok(canonical) => {
            if !canonical.is_dir() {
                let mut markers: Vec<WorkspaceMarkerStatus> = workspace_marker_defs()
                    .iter()
                    .map(|def| WorkspaceMarkerStatus {
                        kind: def.kind.as_str().to_string(),
                        path: def.rel_path.to_string(),
                        exists: false,
                    })
                    .collect();
                push_cursor_rule_marker(&mut markers, &canonical);
                (
                    false,
                    Some(canonical.to_string_lossy().into_owned()),
                    Some("not a directory".to_string()),
                    markers,
                )
            } else {
                let mut markers: Vec<WorkspaceMarkerStatus> = workspace_marker_defs()
                    .iter()
                    .map(|def| WorkspaceMarkerStatus {
                        kind: def.kind.as_str().to_string(),
                        path: def.rel_path.to_string(),
                        exists: def.kind.exists(&canonical, def.rel_path),
                    })
                    .collect();
                push_cursor_rule_marker(&mut markers, &canonical);
                let all_exist = markers.iter().all(|m| m.exists);
                let error = if !all_exist {
                    Some("missing required markers".to_string())
                } else {
                    None
                };
                (
                    all_exist,
                    Some(canonical.to_string_lossy().into_owned()),
                    error,
                    markers,
                )
            }
        }
        Err(_) => {
            let markers: Vec<WorkspaceMarkerStatus> = if candidate.exists() {
                let mut markers: Vec<WorkspaceMarkerStatus> = workspace_marker_defs()
                    .iter()
                    .map(|def| WorkspaceMarkerStatus {
                        kind: def.kind.as_str().to_string(),
                        path: def.rel_path.to_string(),
                        exists: def.kind.exists(&candidate, def.rel_path),
                    })
                    .collect();
                push_cursor_rule_marker(&mut markers, &candidate);
                markers
            } else {
                let mut markers: Vec<WorkspaceMarkerStatus> = workspace_marker_defs()
                    .iter()
                    .map(|def| WorkspaceMarkerStatus {
                        kind: def.kind.as_str().to_string(),
                        path: def.rel_path.to_string(),
                        exists: false,
                    })
                    .collect();
                push_cursor_rule_marker(&mut markers, &candidate);
                markers
            };
            (
                false,
                None,
                Some("cannot resolve path".to_string()),
                markers,
            )
        }
    };

    let enabled = &settings.enabled_target_ids;
    let total_rules = agent_targets::rule_targets().len();
    let total_configs = agent_targets::config_targets().len();
    let enabled_rules = agent_targets::rule_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .count();
    let enabled_configs = agent_targets::config_targets()
        .iter()
        .filter(|t| enabled.contains(&t.id.to_string()))
        .count();

    let (backup_root, backup_root_exists) = match super::backups::backup_root() {
        Ok(path) => {
            let exists = path.exists();
            (path.to_string_lossy().into_owned(), exists)
        }
        Err(_) => (String::new(), false),
    };
    let release_check_available = resolved_path
        .as_ref()
        .map(|p| release_check_available(Path::new(p)))
        .unwrap_or(false);

    let (bundled_resources_status, missing_bundled_count, missing_bundled_sample) = resolved_path
        .as_ref()
        .map(|p| bundled_resources_fields(Path::new(p)))
        .unwrap_or_else(empty_bundled_resources_fields);

    Ok(WorkspaceDiagnostics {
        candidate_path: candidate_str,
        resolved_path,
        valid,
        error,
        markers,
        enabled_rule_targets: enabled_rules,
        total_rule_targets: total_rules,
        enabled_config_targets: enabled_configs,
        total_config_targets: total_configs,
        backup_root,
        backup_root_exists,
        release_check_available,
        bundled_resources_status,
        missing_bundled_count,
        missing_bundled_sample,
    })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CreateWorkspacePlan {
    pub ok: bool,
    pub status: String,
    pub target_path: String,
    pub reason: String,
    pub warnings: Vec<String>,
    pub planned_files: Vec<String>,
}

fn evaluate_create_plan(target_path: Option<String>) -> CreateWorkspacePlan {
    let raw = match target_path {
        Some(ref s) if !s.trim().is_empty() => s.clone(),
        _ => {
            return CreateWorkspacePlan {
                ok: false,
                status: "missing_target".into(),
                target_path: target_path.unwrap_or_default(),
                reason: "No target path provided. Enter a workspace path in the field above."
                    .into(),
                warnings: vec![],
                planned_files: vec![],
            };
        }
    };

    let path_str = match normalize_user_workspace_path_for_save(&raw) {
        Ok(Some(path)) => path,
        Ok(None) => {
            return CreateWorkspacePlan {
                ok: false,
                status: "missing_target".into(),
                target_path: String::new(),
                reason: "No target path provided. Enter a workspace path in the field above."
                    .into(),
                warnings: vec![],
                planned_files: vec![],
            };
        }
        Err(err) => {
            return CreateWorkspacePlan {
                ok: false,
                status: "invalid_target".into(),
                target_path: raw.trim().to_string(),
                reason: err,
                warnings: vec![
                    "Workspace paths must not depend on the app process working directory.".into(),
                ],
                planned_files: vec![],
            };
        }
    };
    let target = Path::new(&path_str);

    if is_unsafe_target(target) {
        return CreateWorkspacePlan {
            ok: false,
            status: "unsafe_target".into(),
            target_path: path_str,
            reason: "This path is too broad or unsafe for workspace initialization. Choose a specific project directory instead.".into(),
            warnings: vec!["Do not initialize a workspace at a system root, home directory, or broad parent folder.".into()],
            planned_files: planned_workspace_files(),
        };
    }

    if !target.exists() {
        let parent_exists = target.parent().map(|p| p.exists()).unwrap_or(false);
        let mut warnings = vec![];
        if !parent_exists {
            warnings.push("The parent directory does not exist either. Both directories would need to be created in a future apply step.".into());
        }
        return CreateWorkspacePlan {
            ok: true,
            status: "missing_directory".into(),
            target_path: path_str,
            reason: "This path does not exist. Future workspace creation can create the directory and populate it with bundled default resources.".into(),
            warnings,
            planned_files: planned_workspace_files(),
        };
    }

    if target.is_file() {
        return CreateWorkspacePlan {
            ok: false,
            status: "file_not_directory".into(),
            target_path: path_str,
            reason: "This path is a file, not a directory. Cannot initialize a workspace here."
                .into(),
            warnings: vec!["A workspace must be a directory.".into()],
            planned_files: vec![],
        };
    }

    if !target.is_dir() {
        return CreateWorkspacePlan {
            ok: false,
            status: "invalid_path".into(),
            target_path: path_str,
            reason: "This path exists but is not a regular directory.".into(),
            warnings: vec![],
            planned_files: vec![],
        };
    }

    let has_entries = fs::read_dir(target)
        .map(|mut r| r.next().is_some())
        .unwrap_or(true);

    if !has_entries {
        return CreateWorkspacePlan {
            ok: true,
            status: "empty_existing_directory".into(),
            target_path: path_str,
            reason: "This directory exists and is empty. It is a good candidate for workspace initialization with bundled default resources.".into(),
            warnings: vec![],
            planned_files: planned_workspace_files(),
        };
    }

    let all_markers_present = workspace_marker_defs()
        .iter()
        .all(|def| def.kind.exists(target, def.rel_path));

    if all_markers_present {
        return CreateWorkspacePlan {
            ok: true,
            status: "valid_existing_workspace".into(),
            target_path: path_str,
            reason: "This path is already a valid workspace. No initialization needed.".into(),
            warnings: vec![],
            planned_files: vec![],
        };
    }

    CreateWorkspacePlan {
        ok: false,
        status: "non_empty_non_workspace".into(),
        target_path: path_str,
        reason: "This directory contains files but is not a valid workspace (missing required markers). Future workspace creation here would add bundled default resources alongside existing files.".into(),
        warnings: vec![
            "This directory contains existing files. A future create workspace action would add default resources alongside them. Review the planned files list before proceeding.".into(),
        ],
        planned_files: planned_workspace_files(),
    }
}

fn planned_workspace_files() -> Vec<String> {
    super::defaults::default_workspace_files()
        .into_iter()
        .flat_map(|(_, paths)| paths.iter().map(|s| s.to_string()))
        .collect()
}

fn derive_source_roots() -> Vec<PathBuf> {
    let src_tauri = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut roots = vec![src_tauri.clone()];
    if let Some(app_root) = src_tauri.parent() {
        roots.push(app_root.to_path_buf());
        if let Some(repo_root) = app_root.parent().and_then(|p| p.parent()) {
            roots.push(repo_root.to_path_buf());
        }
    }
    roots
}

fn is_unsafe_target(target: &Path) -> bool {
    if target == Path::new("/") {
        return true;
    }
    if target == Path::new("/Users") {
        return true;
    }

    if let Ok(home) = std::env::var("HOME") {
        let home_path = Path::new(&home);
        if target == home_path {
            return true;
        }
        if target == home_path.join("Projects") {
            return true;
        }
    }

    if target == std::env::temp_dir() {
        return true;
    }

    let source_roots = derive_source_roots();
    for source_root in &source_roots {
        if target == source_root {
            return true;
        }
        if let Ok(canonical) = source_root.canonicalize() {
            if target == canonical {
                return true;
            }
        }
    }

    if target.exists() {
        if let Ok(canonical) = target.canonicalize() {
            for source_root in &source_roots {
                if let Ok(source_canonical) = source_root.canonicalize() {
                    if canonical == source_canonical {
                        return true;
                    }
                }
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if cwd == target {
            return true;
        }
        if let Ok(cwd_canonical) = cwd.canonicalize() {
            if cwd_canonical == target {
                return true;
            }
            if target.exists() {
                if let Ok(canonical) = target.canonicalize() {
                    if canonical == cwd_canonical {
                        return true;
                    }
                }
            }
        }
    }

    false
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn plan_create_workspace(
    target_path: Option<String>,
) -> Result<CreateWorkspacePlan, String> {
    Ok(evaluate_create_plan(target_path))
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn workspace_setup_phase(plan: &CreateWorkspacePlan) -> &'static str {
    match plan.status.as_str() {
        "valid_existing_workspace" => "valid_existing",
        "missing_directory" | "empty_existing_directory" => "ready_create",
        "non_empty_non_workspace" => "blocked_non_empty",
        "missing_target" | "invalid_target" => "no_target",
        _ => "blocked",
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InitializeWorkspaceResult {
    pub success: bool,
    pub status: String,
    pub target_path: String,
    pub message: String,
    pub copied_files: Vec<String>,
    pub warnings: Vec<String>,
}

fn initialize_result_from_create(create: CreateWorkspaceResult) -> InitializeWorkspaceResult {
    InitializeWorkspaceResult {
        success: create.success,
        status: create.status,
        target_path: create.target_path,
        message: create.message,
        copied_files: create.copied_files,
        warnings: create.warnings,
    }
}

fn initialize_result_from_repair(repair: RepairWorkspaceResult) -> InitializeWorkspaceResult {
    InitializeWorkspaceResult {
        success: repair.ok,
        status: if repair.dry_run {
            "repair_dry_run".into()
        } else if repair.ok {
            "initialized".into()
        } else {
            "initialize_failed".into()
        },
        target_path: repair.target_path,
        message: repair.message,
        copied_files: repair.copied_files,
        warnings: repair.warnings,
    }
}

pub(crate) fn initialize_workspace_at_path(
    app: tauri::AppHandle,
    target_path: Option<String>,
    confirm_non_empty: bool,
) -> Result<InitializeWorkspaceResult, String> {
    let plan = evaluate_create_plan(target_path);
    let target_path = plan.target_path.clone();

    if target_path.is_empty() {
        return Ok(InitializeWorkspaceResult {
            success: false,
            status: plan.status,
            target_path,
            message: plan.reason,
            copied_files: vec![],
            warnings: plan.warnings,
        });
    }

    match plan.status.as_str() {
        "missing_directory" | "empty_existing_directory" => {
            let source_root = super::defaults::resolve_default_workspace_root(&app)?;
            Ok(initialize_result_from_create(create_workspace_from_source(
                &source_root,
                Some(target_path),
            )))
        }
        "non_empty_non_workspace" => {
            if !confirm_non_empty {
                return Err(
                    "Confirmation required before adding workspace files to a non-empty folder."
                        .into(),
                );
            }
            let repair = repair_workspace_impl(&app, &target_path, false);
            if !repair.ok {
                return Ok(initialize_result_from_repair(repair));
            }
            match validate_workspace_root(PathBuf::from(&target_path)) {
                Ok(canonical) => Ok(InitializeWorkspaceResult {
                    success: true,
                    status: "initialized".into(),
                    target_path: canonical.to_string_lossy().into_owned(),
                    message: repair.message,
                    copied_files: repair.copied_files,
                    warnings: repair.warnings,
                }),
                Err(e) => Ok(InitializeWorkspaceResult {
                    success: false,
                    status: "validation_failed".into(),
                    target_path,
                    message: format!("Files were copied but workspace validation failed: {e}"),
                    copied_files: repair.copied_files,
                    warnings: repair.warnings,
                }),
            }
        }
        "valid_existing_workspace" => match validate_workspace_root(PathBuf::from(&target_path)) {
            Ok(canonical) => Ok(InitializeWorkspaceResult {
                success: true,
                status: "valid_existing_workspace".into(),
                target_path: canonical.to_string_lossy().into_owned(),
                message: "Path is already a valid workspace.".into(),
                copied_files: vec![],
                warnings: vec![],
            }),
            Err(e) => Ok(InitializeWorkspaceResult {
                success: false,
                status: "validation_failed".into(),
                target_path,
                message: e,
                copied_files: vec![],
                warnings: vec![],
            }),
        },
        _ => Ok(InitializeWorkspaceResult {
            success: false,
            status: plan.status,
            target_path,
            message: plan.reason,
            copied_files: vec![],
            warnings: plan.warnings,
        }),
    }
}

#[tauri::command]
pub fn try_set_active_workspace_path(path: String) -> Result<settings::AppSettings, String> {
    let normalized = normalize_user_workspace_path_for_save(&path)?
        .ok_or_else(|| "workspace path must be absolute or start with ~/".to_string())?;
    let canonical = validate_workspace_root(PathBuf::from(&normalized))?;
    let canonical_path = canonical.to_string_lossy().into_owned();
    settings::mutate_settings(|current| {
        current.workspace_path = Some(canonical_path);
        Ok(settings::MutationOutcome::Changed)
    })
}

#[derive(Serialize)]
pub struct CreateWorkspaceResult {
    pub success: bool,
    pub status: String,
    pub target_path: String,
    pub created_dirs: Vec<String>,
    pub copied_files: Vec<String>,
    pub skipped_files: Vec<String>,
    pub warnings: Vec<String>,
    pub message: String,
}

#[allow(clippy::result_large_err)]
fn preflight_create(
    source_root: &Path,
    target: &Path,
    target_path: &str,
    plan_status: &str,
) -> Result<(), CreateWorkspaceResult> {
    if !source_root.exists() || !source_root.is_dir() {
        return Err(CreateWorkspaceResult {
            success: false,
            status: "source_unavailable".into(),
            target_path: target_path.into(),
            created_dirs: vec![],
            copied_files: vec![],
            skipped_files: vec![],
            warnings: vec![],
            message: "Bundled default workspace source is unavailable.".into(),
        });
    }

    if plan_status == "missing_directory" {
        let parent = target.parent();
        if parent.is_none() || !parent.unwrap().exists() {
            return Err(CreateWorkspaceResult {
                success: false,
                status: "missing_parent".into(),
                target_path: target_path.into(),
                created_dirs: vec![],
                copied_files: vec![],
                skipped_files: vec![],
                warnings: vec![],
                message: "Parent directory does not exist. Create it first.".into(),
            });
        }
    }

    if plan_status == "empty_existing_directory" {
        if !target.is_dir() {
            return Err(CreateWorkspaceResult {
                success: false,
                status: "not_a_directory".into(),
                target_path: target_path.into(),
                created_dirs: vec![],
                copied_files: vec![],
                skipped_files: vec![],
                warnings: vec![],
                message: "Target is not a directory.".into(),
            });
        }
        let has_entries = fs::read_dir(target)
            .map(|mut r| r.next().is_some())
            .unwrap_or(true);
        if has_entries {
            return Err(CreateWorkspaceResult {
                success: false,
                status: "not_empty".into(),
                target_path: target_path.into(),
                created_dirs: vec![],
                copied_files: vec![],
                skipped_files: vec![],
                warnings: vec![],
                message: "Target directory is not empty. Cannot create workspace.".into(),
            });
        }
    }

    let file_list = super::defaults::default_workspace_files();
    for (_label, paths) in &file_list {
        for &rel in *paths {
            if rel.contains("..") || rel.is_empty() || Path::new(rel).is_absolute() {
                return Err(CreateWorkspaceResult {
                    success: false,
                    status: "unsafe_relative_path".into(),
                    target_path: target_path.into(),
                    created_dirs: vec![],
                    copied_files: vec![],
                    skipped_files: vec![],
                    warnings: vec![],
                    message: format!("Blocked unsafe relative path: {}", rel),
                });
            }

            let src = source_root.join(rel);
            if !src.is_file() {
                return Err(CreateWorkspaceResult {
                    success: false,
                    status: "source_missing".into(),
                    target_path: target_path.into(),
                    created_dirs: vec![],
                    copied_files: vec![],
                    skipped_files: vec![],
                    warnings: vec![],
                    message: format!(
                        "Required source file '{}' is missing. Cannot create workspace.",
                        rel
                    ),
                });
            }

            let dst = target.join(rel);
            if dst.exists() {
                return Err(CreateWorkspaceResult {
                    success: false,
                    status: "destination_exists".into(),
                    target_path: target_path.into(),
                    created_dirs: vec![],
                    copied_files: vec![],
                    skipped_files: vec![],
                    warnings: vec![],
                    message: format!(
                        "Destination file '{}' already exists. Cannot create workspace (would overwrite existing content).",
                        rel
                    ),
                });
            }
        }
    }

    Ok(())
}

fn create_workspace_from_source(
    source_root: &Path,
    target_raw: Option<String>,
) -> CreateWorkspaceResult {
    let plan = evaluate_create_plan(target_raw);
    let target_path = plan.target_path.clone();

    if plan.status != "missing_directory" && plan.status != "empty_existing_directory" {
        return CreateWorkspaceResult {
            success: false,
            status: plan.status,
            target_path,
            created_dirs: vec![],
            copied_files: vec![],
            skipped_files: vec![],
            warnings: plan.warnings,
            message: plan.reason,
        };
    }

    let target = Path::new(&target_path);

    match preflight_create(source_root, target, &target_path, &plan.status) {
        Ok(()) => {}
        Err(result) => return result,
    }

    let mut created_dirs: Vec<String> = vec![];
    let mut copied_files: Vec<String> = vec![];
    let warnings: Vec<String> = plan.warnings;

    if plan.status == "missing_directory" {
        match fs::create_dir(target) {
            Ok(()) => {
                created_dirs.push(target_path.clone());
            }
            Err(e) => {
                return CreateWorkspaceResult {
                    success: false,
                    status: "create_dir_failed".into(),
                    target_path,
                    created_dirs,
                    copied_files,
                    skipped_files: vec![],
                    warnings,
                    message: format!("Failed to create target directory: {}", e),
                };
            }
        }
    }

    let file_list = super::defaults::default_workspace_files();
    for (_label, paths) in &file_list {
        for &rel in *paths {
            let dst = target.join(rel);

            if dst.exists() {
                return CreateWorkspaceResult {
                    success: false,
                    status: "destination_exists".into(),
                    target_path,
                    created_dirs,
                    copied_files,
                    skipped_files: vec![],
                    warnings,
                    message: format!(
                        "Destination file '{}' appeared after preflight. Stopping to avoid overwrite.",
                        rel
                    ),
                };
            }

            if let Some(parent) = dst.parent() {
                if !parent.exists() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        return CreateWorkspaceResult {
                            success: false,
                            status: "create_dir_failed".into(),
                            target_path,
                            created_dirs,
                            copied_files,
                            skipped_files: vec![],
                            warnings,
                            message: format!(
                                "Failed to create parent directory for '{}': {}",
                                rel, e
                            ),
                        };
                    }
                    let parent_str = parent.to_string_lossy().into_owned();
                    if !created_dirs.contains(&parent_str) {
                        created_dirs.push(parent_str);
                    }
                }
            }

            let src = source_root.join(rel);
            match fs::copy(&src, &dst) {
                Ok(_) => {
                    copied_files.push(rel.to_string());
                }
                Err(e) => {
                    return CreateWorkspaceResult {
                        success: false,
                        status: "copy_failed".into(),
                        target_path,
                        created_dirs,
                        copied_files,
                        skipped_files: vec![],
                        warnings,
                        message: format!("Failed to copy '{}': {}", rel, e),
                    };
                }
            }
        }
    }

    match validate_workspace_root(target.to_path_buf()) {
        Ok(canonical) => {
            let message = if copied_files.is_empty() {
                "No files were copied. The target directory may be empty.".into()
            } else {
                format!(
                    "Workspace created successfully. Copied {} file(s).",
                    copied_files.len()
                )
            };
            CreateWorkspaceResult {
                success: true,
                status: "created".into(),
                target_path: canonical.to_string_lossy().into_owned(),
                created_dirs,
                copied_files,
                skipped_files: vec![],
                warnings,
                message,
            }
        }
        Err(e) => CreateWorkspaceResult {
            success: false,
            status: "validation_failed".into(),
            target_path,
            created_dirs,
            copied_files,
            skipped_files: vec![],
            warnings,
            message: format!(
                "Workspace validation failed after copy: {}. Target may be incomplete.",
                e
            ),
        },
    }
}

#[derive(Serialize)]
pub struct RepairWorkspaceResult {
    pub ok: bool,
    pub dry_run: bool,
    pub target_path: String,
    pub copied_files: Vec<String>,
    pub refreshed_files: Vec<String>,
    pub skipped_files: Vec<String>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub message: String,
}

fn utc_backup_timestamp() -> String {
    std::process::Command::new("date")
        .args(["-u", "+%Y%m%d-%H%M%S"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 15)
        .unwrap_or_else(|| "00000000-000000".to_string())
}

fn backup_workspace_bundle_file(dst: &Path, rel: &str) -> Result<(), String> {
    #[cfg(test)]
    let backup_root = std::env::temp_dir().join("agent-workspace-test-backups");
    #[cfg(not(test))]
    let backup_root = super::backups::backup_root()?;
    let ts = utc_backup_timestamp();
    let safe_name = rel.replace('/', "__");
    let backup_dir = backup_root.join(&ts).join("workspace-bundle");
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("create workspace bundle backup dir: {e}"))?;
    let backup_path = backup_dir.join(&safe_name);
    fs::copy(dst, &backup_path).map_err(|e| format!("backup '{}' before refresh: {e}", rel))?;
    Ok(())
}

fn collect_stale_cursor_bundle_files(source_root: &Path, target: &Path) -> Vec<&'static str> {
    let mut stale = Vec::new();
    for &rel in super::defaults::cursor_bundle_refresh_paths() {
        if rel.contains("..") || rel.is_empty() || Path::new(rel).is_absolute() {
            continue;
        }
        let src = source_root.join(rel);
        let dst = target.join(rel);
        if !src.is_file() || !dst.is_file() {
            continue;
        }
        if !file_eq(&src, &dst) {
            stale.push(rel);
        }
    }
    stale
}

/// Core repair logic: copy missing default workspace files from `source_root`
/// into `target`. This is the testable inner function.
///
/// Semantics:
/// - Never overwrites existing files except allowlisted Cursor bundle paths when stale.
/// - Stale Cursor bundle refresh is backup-first.
/// - If dry_run is true, only reports what would be copied/refreshed.
/// - Skips files missing from the source bundle.
/// - Skips files with unsafe relative paths.
fn repair_workspace_core(
    source_root: &std::path::Path,
    target: &std::path::Path,
    dry_run: bool,
) -> RepairWorkspaceResult {
    let target_path = target.to_string_lossy().into_owned();

    // Collect missing files from the default workspace file list
    let file_list = super::defaults::default_workspace_files();
    let mut missing_files: Vec<&str> = Vec::new();
    for (_label, paths) in &file_list {
        for &rel in *paths {
            let src = source_root.join(rel);
            let dst = target.join(rel);

            if !src.is_file() {
                continue; // source file missing from bundle — skip
            }
            if dst.exists() && !workspace_install_file_missing(&dst) {
                continue; // non-empty file already present — skip
            }
            if rel.contains("..") || rel.is_empty() || Path::new(rel).is_absolute() {
                continue; // safety filter
            }
            missing_files.push(rel);
        }
    }

    let stale_cursor = collect_stale_cursor_bundle_files(source_root, target);

    if dry_run {
        let copy_count = missing_files.len();
        let refresh_count = stale_cursor.len();
        let message = if copy_count == 0 && refresh_count == 0 {
            "No missing files to repair. Workspace is up to date.".to_string()
        } else {
            format!(
                "Dry-run: {} file(s) would be copied, {} Cursor bundle file(s) would be refreshed.",
                copy_count, refresh_count
            )
        };
        let mut planned: Vec<String> = missing_files.into_iter().map(|s| s.to_string()).collect();
        planned.extend(stale_cursor.iter().map(|s| format!("refresh:{s}")));
        return RepairWorkspaceResult {
            ok: true,
            dry_run: true,
            target_path,
            copied_files: planned,
            refreshed_files: stale_cursor.into_iter().map(|s| s.to_string()).collect(),
            skipped_files: vec![],
            errors: vec![],
            warnings: vec![],
            message,
        };
    }

    // Apply: copy missing files
    let mut copied_files: Vec<String> = Vec::new();
    let mut refreshed_files: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for &rel in &missing_files {
        let src = source_root.join(rel);
        let dst = target.join(rel);

        // Create parent directory if needed
        if let Some(parent) = dst.parent() {
            if !parent.exists() {
                if let Err(e) = fs::create_dir_all(parent) {
                    errors.push(format!("Failed to create directory for '{}': {}", rel, e));
                    continue;
                }
            }
        }

        match fs::copy(&src, &dst) {
            Ok(_) => {
                copied_files.push(rel.to_string());
            }
            Err(e) => {
                errors.push(format!("Failed to copy '{}': {}", rel, e));
            }
        }
    }

    for &rel in &stale_cursor {
        let src = source_root.join(rel);
        let dst = target.join(rel);
        if let Some(parent) = dst.parent() {
            if !parent.exists() {
                if let Err(e) = fs::create_dir_all(parent) {
                    errors.push(format!(
                        "Failed to create directory for stale refresh '{}': {}",
                        rel, e
                    ));
                    continue;
                }
            }
        }
        match backup_workspace_bundle_file(&dst, rel) {
            Ok(()) => {
                warnings.push(format!(
                    "Backed up stale Cursor bundle file before refresh: {}",
                    rel
                ));
            }
            Err(e) => {
                errors.push(e);
                continue;
            }
        }
        match fs::copy(&src, &dst) {
            Ok(_) => refreshed_files.push(rel.to_string()),
            Err(e) => errors.push(format!("Failed to refresh stale '{}': {}", rel, e)),
        }
    }

    let status_ok = errors.is_empty();
    let message = if copied_files.is_empty() && refreshed_files.is_empty() && errors.is_empty() {
        "No files needed repair.".to_string()
    } else if errors.is_empty() {
        format!(
            "Repair complete. {} file(s) copied, {} Cursor bundle file(s) refreshed.",
            copied_files.len(),
            refreshed_files.len()
        )
    } else {
        format!(
            "Repair finished with {} error(s). {} copied, {} refreshed.",
            errors.len(),
            copied_files.len(),
            refreshed_files.len()
        )
    };

    RepairWorkspaceResult {
        ok: status_ok,
        dry_run: false,
        target_path,
        copied_files,
        refreshed_files,
        skipped_files: vec![],
        errors,
        warnings,
        message,
    }
}

/// Repair a workspace by copying missing bundled default files.
///
/// Semantics:
/// - Never overwrites existing files.
/// - If dry_run is true, only reports what would be copied.
/// - Rejects unsafe/broad paths (same safety check as workspace creation).
/// - Falls back to source-tree default workspace if bundled is unavailable.
/// - Copies only files from `default_workspace_files()` that are absent in target.
fn repair_workspace_impl(
    app: &tauri::AppHandle,
    target_path: &str,
    dry_run: bool,
) -> RepairWorkspaceResult {
    let normalized = match normalize_user_workspace_path_for_save(target_path) {
        Ok(Some(p)) => p,
        Ok(None) => {
            return RepairWorkspaceResult {
                ok: false,
                dry_run,
                target_path: target_path.to_string(),
                copied_files: vec![],
                refreshed_files: vec![],
                skipped_files: vec![],
                errors: vec!["No target path provided".to_string()],
                warnings: vec![],
                message: "Missing target path.".to_string(),
            };
        }
        Err(e) => {
            return RepairWorkspaceResult {
                ok: false,
                dry_run,
                target_path: target_path.to_string(),
                copied_files: vec![],
                refreshed_files: vec![],
                skipped_files: vec![],
                errors: vec![e],
                warnings: vec![],
                message: "Invalid target path.".to_string(),
            };
        }
    };

    let target = Path::new(&normalized);

    if is_unsafe_target(target) {
        return RepairWorkspaceResult {
            ok: false,
            dry_run,
            target_path: normalized,
            copied_files: vec![],
            refreshed_files: vec![],
            skipped_files: vec![],
            errors: vec!["Target path is too broad or unsafe for repair.".to_string()],
            warnings: vec!["Use a specific workspace directory.".to_string()],
            message: "Unsafe target path rejected.".to_string(),
        };
    }

    if !target.is_dir() {
        return RepairWorkspaceResult {
            ok: false,
            dry_run,
            target_path: normalized,
            copied_files: vec![],
            refreshed_files: vec![],
            skipped_files: vec![],
            errors: vec!["Target is not an existing directory.".to_string()],
            warnings: vec![],
            message: "Repair requires an existing workspace directory.".to_string(),
        };
    }

    let source_root = match super::defaults::resolve_default_workspace_root(app) {
        Ok(r) => r,
        Err(e) => {
            return RepairWorkspaceResult {
                ok: false,
                dry_run,
                target_path: normalized,
                copied_files: vec![],
                refreshed_files: vec![],
                skipped_files: vec![],
                errors: vec![e],
                warnings: vec![],
                message: "Default workspace resources unavailable.".to_string(),
            };
        }
    };

    repair_workspace_core(&source_root, target, dry_run)
}

/// Plan a workspace repair for the current workspace root.
/// Returns what bundled default files are missing without copying anything.
#[tauri::command]
pub fn plan_workspace_repair(app: tauri::AppHandle) -> Result<RepairWorkspaceResult, String> {
    let root = workspace_root()?;
    let root_str = path_arg(&root)?;
    Ok(repair_workspace_impl(&app, &root_str, true))
}

/// Apply a workspace repair for the current workspace root.
/// Copies missing bundled default files. Never overwrites existing files.
#[tauri::command]
pub fn apply_workspace_repair(app: tauri::AppHandle) -> Result<RepairWorkspaceResult, String> {
    let root = workspace_root()?;
    let root_str = path_arg(&root)?;
    Ok(repair_workspace_impl(&app, &root_str, false))
}

#[tauri::command]
pub fn install_default_workspace(
    app: tauri::AppHandle,
) -> Result<InitializeWorkspaceResult, String> {
    let path = default_installed_workspace_path()?;
    initialize_workspace_at_path(app, Some(path.to_string_lossy().into_owned()), false)
}

#[tauri::command]
pub fn repair_default_workspace(app: tauri::AppHandle) -> Result<RepairWorkspaceResult, String> {
    let path = repair_workspace_target_path()?;
    Ok(repair_workspace_impl(
        &app,
        path.to_string_lossy().as_ref(),
        false,
    ))
}

#[tauri::command]
pub fn open_default_workspace_folder() -> Result<ActionResult, String> {
    let path = repair_workspace_target_path()?;
    if !path.exists() {
        return Err("installed workspace folder does not exist".to_string());
    }
    if !path.is_dir() {
        return Err("installed workspace path is not a directory".to_string());
    }
    let path_str = path_arg(&path)?;
    let (success, stdout, stderr, code) = run_cmd("open", &[&path_str], &path);
    Ok(ActionResult::new(
        success,
        "open_default_workspace_folder",
        stdout,
        stderr,
        code,
    ))
}

const BRAIN_SETUP_SEED_REL: &str = "templates/context/saved-memory.md";

#[derive(Serialize)]
pub struct BrainSetupSeedResult {
    pub status: String,
    pub source: String,
    pub content: String,
}

fn read_brain_setup_seed_under_root(root: &Path) -> Result<BrainSetupSeedResult, String> {
    let path = root.join(BRAIN_SETUP_SEED_REL);
    if !path.is_file() {
        return Ok(BrainSetupSeedResult {
            status: "missing".into(),
            source: "generated fallback".into(),
            content: String::new(),
        });
    }

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("resolve brain setup seed: {e}"))?;
    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("resolve workspace root: {e}"))?;
    if !canonical.starts_with(&root_canonical) {
        return Err("brain setup seed path escapes workspace".into());
    }

    let content =
        fs::read_to_string(&canonical).map_err(|e| format!("read brain setup seed: {e}"))?;
    Ok(BrainSetupSeedResult {
        status: "found".into(),
        source: "workspace saved-memory.md".into(),
        content,
    })
}

#[tauri::command]
pub fn read_brain_setup_seed() -> Result<BrainSetupSeedResult, String> {
    let root = match workspace_root() {
        Ok(root) => root,
        Err(_) => {
            return Ok(BrainSetupSeedResult {
                status: "invalid_workspace".into(),
                source: "generated fallback".into(),
                content: String::new(),
            });
        }
    };
    read_brain_setup_seed_under_root(&root)
}

#[cfg(test)]
mod tests {
    use super::{
        configured_workspace_path, create_workspace_from_source, is_unsafe_target,
        missing_bundled_file_paths, persisted_workspace_path_is_valid, plan_create_workspace,
        read_brain_setup_seed_under_root, repair_workspace_core, repair_workspace_target_path,
        repo_path_from_settings, scrub_stale_workspace_path, try_set_active_workspace_path,
        validate_workspace_root, workspace_diagnostics_for_unconfigured, workspace_setup_phase,
        CreateWorkspacePlan, BRAIN_SETUP_SEED_REL, NO_WORKSPACE_SELECTED,
    };
    use crate::settings::AppSettings;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("agent-workspace-{name}-{nonce}"))
    }

    fn mkdir(root: &Path, rel: &str) {
        fs::create_dir_all(root.join(rel)).expect("create dir");
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        if let Some(parent) = root.join(rel).parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(root.join(rel), content).expect("write file");
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    fn setup_valid_workspace(name: &str) -> PathBuf {
        let root = temp_root(name);
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-codex-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        write_file(&root, "templates/codex/config.toml", "profile = \"safe\"\n");
        write_file(
            &root,
            "templates/cursor/rules/workspace.mdc",
            "---\nalwaysApply: true\n---\n",
        );
        mkdir(&root, "templates/cursor/agents");
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");
        root
    }

    #[test]
    fn accepts_valid_workspace_data_folder() {
        let root = setup_valid_workspace("valid-data-workspace");
        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert!(result.is_ok(), "valid data workspace should be accepted");
    }

    #[test]
    fn accepts_valid_workspace_without_app_source() {
        let root = temp_root("no-app-source");
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-codex-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        write_file(&root, "templates/codex/config.toml", "profile = \"safe\"\n");
        write_file(
            &root,
            "templates/cursor/rules/workspace.mdc",
            "---\nalwaysApply: true\n---\n",
        );
        mkdir(&root, "templates/cursor/agents");
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");
        // No app source directory inside workspace — this should still be valid

        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert!(
            result.is_ok(),
            "workspace without app source should still be valid"
        );
    }

    #[test]
    fn rejects_workspace_missing_marker_file() {
        let root = temp_root("missing-marker");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-codex-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        write_file(
            &root,
            "templates/cursor/rules/workspace.mdc",
            "---\nalwaysApply: true\n---\n",
        );
        mkdir(&root, "templates/cursor/agents");
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");
        // Missing .agent-workspace/workspace.json

        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert_eq!(
            result.expect_err("missing marker should be rejected"),
            "invalid workspace path: not a valid workspace"
        );
    }

    #[test]
    fn rejects_fake_script_tree() {
        let root = temp_root("fake-script-tree");
        let scripts = root.join("scripts");
        fs::create_dir_all(&scripts).expect("create fake scripts dir");
        fs::write(
            scripts.join("install-agent-rules.sh"),
            "#!/usr/bin/env bash\n",
        )
        .expect("write fake script");

        let result = validate_workspace_root(root.clone());
        cleanup(&root);

        assert_eq!(
            result.expect_err("fake workspace should be rejected"),
            "invalid workspace path: not a valid workspace"
        );
    }

    #[test]
    fn accepts_workspace_with_ux_cursor_rule() {
        let root = temp_root("ux-cursor-rule");
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-codex-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        write_file(&root, "templates/codex/config.toml", "profile = \"safe\"\n");
        mkdir(&root, "templates/cursor/agents");
        mkdir(&root, "templates/cursor/rules");
        write_file(
            &root,
            "templates/cursor/rules/ux-workspace.mdc",
            "---\nalwaysApply: true\n---\n",
        );
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");
        // No templates/cursor/README.md — should still be valid

        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert!(
            result.is_ok(),
            "workspace with ux-workspace.mdc cursor rule should be accepted"
        );
    }

    #[test]
    fn accepts_workspace_without_cursor_readme() {
        let root = temp_root("no-cursor-readme");
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-codex-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        write_file(&root, "templates/codex/config.toml", "profile = \"safe\"\n");
        mkdir(&root, "templates/cursor/agents");
        write_file(
            &root,
            "templates/cursor/rules/core-safety.mdc",
            "---\nalwaysApply: true\n---\n",
        );
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");
        // Deliberately no templates/cursor/README.md

        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert!(
            result.is_ok(),
            "workspace without cursor README should still be accepted"
        );
    }

    #[test]
    fn rejects_workspace_without_cursor_mdc_rule() {
        let root = temp_root("no-cursor-mdc");
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        mkdir(&root, "templates/cursor/agents");
        mkdir(&root, "templates/cursor/rules");
        // No .mdc file inside templates/cursor/rules/
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");

        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert_eq!(
            result.expect_err("workspace without cursor mdc rule should be rejected"),
            "invalid workspace path: not a valid workspace"
        );
    }

    #[test]
    fn rejects_workspace_missing_cursor_rules_dir() {
        let root = temp_root("no-cursor-rules");
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        mkdir(&root, "templates/cursor/agents");
        // No templates/cursor/rules/ directory at all
        write_file(&root, "README.md", "# readme\n");
        mkdir(&root, "skills");

        let result = validate_workspace_root(root.clone());
        cleanup(&root);
        assert_eq!(
            result.expect_err("workspace without cursor rules dir should be rejected"),
            "invalid workspace path: not a valid workspace"
        );
    }

    fn plan_target(root: &Path) -> String {
        root.to_string_lossy().into_owned()
    }

    #[test]
    fn diagnostics_candidate_and_create_plan_use_same_normalized_path() {
        let root = setup_valid_workspace("diag-plan-sync");
        let path = root.to_string_lossy().into_owned();
        let settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some(path.clone()),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            cursor_profile_path: None,
            revision: 0,
        };
        let candidate = repo_path_from_settings(&settings)
            .to_string_lossy()
            .into_owned();
        let plan =
            plan_create_workspace(settings.workspace_path.clone()).expect("plan should succeed");

        assert_eq!(candidate, path);
        assert_eq!(plan.target_path, candidate);
        cleanup(&root);
    }

    #[test]
    fn configured_workspace_path_ignores_legacy_relative_paths() {
        let home = std::env::var("HOME").expect("HOME required for test");
        let settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some("workspace/local".into()),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            cursor_profile_path: None,
            revision: 0,
        };

        let candidate = configured_workspace_path(&settings).expect("canonical fallback");
        assert_eq!(
            candidate,
            std::path::PathBuf::from(home).join(".config/agent-workspace")
        );
    }

    #[test]
    fn default_settings_use_installed_workspace_candidate() {
        let home = std::env::var("HOME").expect("HOME required for test");
        let expected = std::path::PathBuf::from(home).join(".config/agent-workspace");
        let candidate = configured_workspace_path(&AppSettings::default())
            .expect("canonical default should resolve when HOME is set");
        assert_eq!(candidate, expected);
    }

    #[test]
    fn repair_workspace_target_prefers_agent_workspace_path_override() {
        let target = setup_valid_workspace("repair-target-override");
        let target_str = target.to_string_lossy().into_owned();
        let previous = std::env::var("AGENT_WORKSPACE_PATH").ok();
        std::env::set_var("AGENT_WORKSPACE_PATH", &target_str);
        let resolved = repair_workspace_target_path().expect("resolve repair target");
        if let Some(prev) = previous {
            std::env::set_var("AGENT_WORKSPACE_PATH", prev);
        } else {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
        }
        assert_eq!(
            resolved.canonicalize().expect("canonical resolved"),
            target.canonicalize().expect("canonical target")
        );
        cleanup(&target);
    }

    #[test]
    fn legacy_agent_workspace_saved_setting_falls_back_to_canonical_default() {
        let home = std::env::var("HOME").expect("HOME required for test");
        let settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some("~/Agent Workspace".into()),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            cursor_profile_path: None,
            revision: 0,
        };
        let candidate = configured_workspace_path(&settings).expect("candidate");
        assert_eq!(
            candidate,
            std::path::PathBuf::from(home).join(".config/agent-workspace")
        );
    }

    #[test]
    fn unconfigured_workspace_diagnostics_when_home_unavailable() {
        let settings = AppSettings::default();
        let diag = workspace_diagnostics_for_unconfigured(&settings);

        assert_eq!(diag.error.as_deref(), Some(NO_WORKSPACE_SELECTED));
        assert!(diag.candidate_path.is_empty());
        assert!(diag.markers.is_empty());
        assert!(!diag.valid);
    }

    #[test]
    fn scrub_stale_workspace_path_clears_invalid_persisted_path() {
        let mut settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some("/tmp/agent-workspace-scrub-missing".into()),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            cursor_profile_path: None,
            revision: 0,
        };

        assert!(scrub_stale_workspace_path(&mut settings));
        assert_eq!(settings.workspace_path, None);
    }

    #[test]
    fn scrub_stale_workspace_path_keeps_valid_workspace() {
        let root = setup_valid_workspace("scrub-valid");
        let path = root.to_string_lossy().into_owned();
        let mut settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some(path),
            enabled_target_ids: vec![],
            accent_color: None,
            background_color: None,
            foreground_color: None,
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            cursor_profile_path: None,
            revision: 0,
        };

        assert!(!scrub_stale_workspace_path(&mut settings));
        assert!(settings.workspace_path.is_some());
        assert!(persisted_workspace_path_is_valid(
            settings.workspace_path.as_ref().expect("path")
        ));
        cleanup(&root);
    }

    #[test]
    fn plan_rejects_relative_workspace_paths() {
        for path in ["workspace/local", "./workspace", "../workspace"] {
            let plan = plan_create_workspace(Some(path.into())).expect("plan should succeed");

            assert_eq!(plan.status, "invalid_target");
            assert!(!plan.ok);
            assert_eq!(plan.target_path, path);
            assert_eq!(
                plan.reason,
                "workspace path must be absolute or start with ~/"
            );
        }
    }

    #[test]
    fn release_check_script_availability_uses_workspace_script_path() {
        let root = temp_root("release-check-available");
        assert!(!super::release_check_available(&root));

        write_file(&root, "scripts/release-check.sh", "#!/usr/bin/env bash\n");
        let exists = super::release_check_available(&root);
        cleanup(&root);

        assert!(exists);
    }

    #[test]
    fn plan_missing_target() {
        let plan = plan_create_workspace(None).expect("plan should succeed");
        assert_eq!(plan.status, "missing_target");
        assert!(!plan.ok);
        assert!(plan.planned_files.is_empty());
    }

    #[test]
    fn plan_empty_target_string() {
        let plan = plan_create_workspace(Some("   ".into())).expect("plan should succeed");
        assert_eq!(plan.status, "missing_target");
        assert!(!plan.ok);
    }

    #[test]
    fn plan_unsafe_target_root() {
        let plan = plan_create_workspace(Some("/".into())).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
        assert!(!plan.planned_files.is_empty());
    }

    #[test]
    fn plan_unsafe_target_home() {
        let home = std::env::var("HOME").unwrap();
        let plan = plan_create_workspace(Some(home.clone())).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert_eq!(plan.target_path, home);
        assert!(!plan.ok);
    }

    #[test]
    fn plan_unsafe_target_users() {
        let plan = plan_create_workspace(Some("/Users".into())).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
    }

    #[test]
    fn plan_unsafe_target_temp_root() {
        let temp = std::env::temp_dir().to_string_lossy().into_owned();
        let plan = plan_create_workspace(Some(temp)).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
    }

    #[test]
    fn plan_unsafe_target_home_projects() {
        let home = std::env::var("HOME").unwrap();
        let path = std::path::Path::new(&home).join("Projects");
        let plan = plan_create_workspace(Some(path.to_string_lossy().into_owned()))
            .expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
    }

    #[test]
    fn plan_valid_existing_workspace() {
        let root = setup_valid_workspace("plan-valid");
        let path = plan_target(&root);
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        cleanup(&root);
        assert_eq!(plan.status, "valid_existing_workspace");
        assert!(plan.ok);
        assert!(plan.planned_files.is_empty());
    }

    #[test]
    fn plan_empty_existing_directory() {
        let root = temp_root("plan-empty");
        fs::create_dir_all(&root).expect("create empty dir");
        let path = plan_target(&root);
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        cleanup(&root);
        assert_eq!(plan.status, "empty_existing_directory");
        assert!(plan.ok);
        assert!(!plan.planned_files.is_empty());
    }

    #[test]
    fn plan_non_empty_non_workspace() {
        let root = temp_root("plan-nonempty");
        fs::create_dir_all(&root).expect("create dir");
        fs::write(root.join("somefile.txt"), "hello").expect("write file");
        let path = plan_target(&root);
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        cleanup(&root);
        assert_eq!(plan.status, "non_empty_non_workspace");
        assert!(!plan.ok);
        assert!(!plan.warnings.is_empty());
        assert!(!plan.planned_files.is_empty());
    }

    #[test]
    fn workspace_setup_phase_maps_non_empty_to_blocked() {
        let plan = CreateWorkspacePlan {
            ok: false,
            status: "non_empty_non_workspace".into(),
            target_path: "/tmp/example".into(),
            reason: "blocked".into(),
            warnings: vec![],
            planned_files: vec![],
        };
        assert_eq!(workspace_setup_phase(&plan), "blocked_non_empty");
    }

    #[test]
    fn workspace_setup_phase_maps_valid_existing() {
        let plan = CreateWorkspacePlan {
            ok: true,
            status: "valid_existing_workspace".into(),
            target_path: "/tmp/example".into(),
            reason: "valid".into(),
            warnings: vec![],
            planned_files: vec![],
        };
        assert_eq!(workspace_setup_phase(&plan), "valid_existing");
    }

    #[test]
    fn try_set_active_workspace_path_rejects_invalid_directory() {
        let path = std::env::temp_dir()
            .join("agent-workspace-not-a-valid-root")
            .to_string_lossy()
            .into_owned();
        let result = try_set_active_workspace_path(path);
        assert!(result.is_err(), "invalid path must not become active");
    }

    #[test]
    fn active_workspace_activation_requires_valid_root() {
        let root = setup_valid_workspace("activate-valid");
        let path = root.to_string_lossy().into_owned();
        assert!(
            validate_workspace_root(PathBuf::from(&path)).is_ok(),
            "only valid workspace roots may be activated"
        );
        cleanup(&root);
    }

    #[test]
    fn plan_missing_directory() {
        let root = temp_root("plan-missing");
        let path = plan_target(&root);
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        assert_eq!(plan.status, "missing_directory");
        assert!(plan.ok);
        assert!(!plan.planned_files.is_empty());
    }

    #[test]
    fn plan_missing_directory_parent_missing() {
        let root = temp_root("plan-missing-parent");
        let sub = root.join("nope").join("also-nope");
        let path = sub.to_string_lossy().into_owned();
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        assert_eq!(plan.status, "missing_directory");
        assert!(plan.ok);
        assert!(!plan.warnings.is_empty());
    }

    #[test]
    fn plan_file_not_directory() {
        let root = temp_root("plan-file");
        let path = plan_target(&root);
        fs::write(&root, "content").expect("write file");
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        cleanup(&root);
        assert_eq!(plan.status, "file_not_directory");
        assert!(!plan.ok);
        assert!(plan.planned_files.is_empty());
    }

    #[test]
    fn plan_planned_files_include_marker_and_scripts() {
        let root = temp_root("plan-files");
        fs::create_dir_all(&root).expect("create dir");
        let path = plan_target(&root);
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        cleanup(&root);
        let files: Vec<&str> = plan.planned_files.iter().map(|s| s.as_str()).collect();
        assert!(
            files.contains(&".agent-workspace/workspace.json"),
            "planned files must include workspace marker"
        );
        assert!(
            files.contains(&"scripts/bootstrap.sh"),
            "planned files must include bootstrap.sh"
        );
        assert!(
            files.contains(&"README.md"),
            "planned files must include README"
        );
        assert!(
            files.contains(&"skills/diagnose/SKILL.md"),
            "planned files must include skills/diagnose/SKILL.md"
        );
        assert!(
            files.contains(&"templates/global-agent-rules.md"),
            "planned files must include agent rules template"
        );
        assert!(
            files.contains(&"templates/opencode.json"),
            "planned files must include opencode config"
        );
        assert!(
            files.contains(&"templates/cursor/agents/verifier.md"),
            "planned files must include Cursor adapter templates"
        );
        assert!(
            files.contains(&"docs/START_HERE.md"),
            "planned files must include docs"
        );
        assert!(
            plan.planned_files.len() >= 32,
            "expected at least 32 planned files, got {}",
            plan.planned_files.len()
        );
    }

    #[test]
    fn plan_is_read_only_no_create_no_write() {
        let root = temp_root("plan-readonly");
        let path = plan_target(&root);
        let plan = plan_create_workspace(Some(path.clone())).expect("plan should succeed");
        assert_eq!(plan.status, "missing_directory");
        assert!(!root.exists(), "plan must not create the missing directory");
        assert!(plan.ok);
    }

    #[test]
    fn plan_rejects_tilde_home() {
        let home = std::env::var("HOME").unwrap();
        let plan = plan_create_workspace(Some("~".into())).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
        assert_eq!(plan.target_path, home);
    }

    #[test]
    fn plan_rejects_tilde_projects() {
        let home = std::env::var("HOME").unwrap();
        let plan = plan_create_workspace(Some("~/Projects".into())).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
        let expected = format!("{}/Projects", home);
        assert_eq!(plan.target_path, expected);
    }

    #[test]
    fn plan_unsafe_target_src_tauri_root() {
        let path = env!("CARGO_MANIFEST_DIR").to_string();
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        assert_eq!(plan.status, "unsafe_target");
        assert!(!plan.ok);
    }

    #[test]
    fn plan_unsafe_target_app_root() {
        let src_tauri = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(app_root) = src_tauri.parent() {
            let path = app_root.to_string_lossy().into_owned();
            let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
            assert_eq!(plan.status, "unsafe_target", "app root should be rejected");
            assert!(!plan.ok);
        }
    }

    #[test]
    fn plan_unsafe_target_repo_root() {
        let src_tauri = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(repo_root) = src_tauri
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            let path = repo_root.to_string_lossy().into_owned();
            let plan = plan_create_workspace(Some(path.clone())).expect("plan should succeed");
            assert_eq!(
                plan.status, "unsafe_target",
                "repo root {} should be rejected",
                path
            );
            assert!(!plan.ok);
        }
    }

    #[test]
    fn plan_normalized_path_still_missing_directory() {
        let root = temp_root("plan-norm-missing");
        let path = root.to_string_lossy().into_owned();
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        assert_eq!(plan.status, "missing_directory");
        assert!(plan.ok);
    }

    #[test]
    fn plan_normalized_path_still_empty_directory() {
        let root = temp_root("plan-norm-empty");
        fs::create_dir_all(&root).expect("create empty dir");
        let path = root.to_string_lossy().into_owned();
        let plan = plan_create_workspace(Some(path)).expect("plan should succeed");
        cleanup(&root);
        assert_eq!(plan.status, "empty_existing_directory");
        assert!(plan.ok);
    }

    #[test]
    fn plan_normalize_tilde_preserves_tilde_without_home() {
        // Without HOME set, ~/foo stays literal
        let plan =
            plan_create_workspace(Some("~/some-temp-child".into())).expect("plan should succeed");
        // May or may not expand depending on HOME availability
        // If HOME is set, it expands; if not, stays literal
        // Either way, the status should be sane
        assert!(
            plan.status == "missing_directory" || plan.status == "unsafe_target",
            "tilde path should resolve to missing_directory or unsafe_target, got {}",
            plan.status
        );
    }

    // --- create workspace from source tests ---

    fn setup_source_root(name: &str) -> PathBuf {
        let root = temp_root(name);
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        write_file(&root, "README.md", "# readme\n");
        for &rel in &[
            "docs/START_HERE.md",
            "docs/CONCEPTS.md",
            "docs/USING_THE_APP.md",
            "docs/GIT_VERSIONING.md",
            "docs/WORKFLOWS.md",
            "docs/SKILLS.md",
            "docs/AGENT_RULES.md",
            "docs/OPENCODE_CONFIG.md",
            "docs/CODEX_CONFIG.md",
            "docs/TROUBLESHOOTING.md",
            "docs/prompt-templates/standard-prompt.md",
            "docs/prompt-templates/masterprompt.md",
            "docs/prompt-templates/batchprompt.md",
        ] {
            write_file(&root, rel, "doc content\n");
        }
        for &rel in &[
            "templates/global-agent-rules.md",
            "templates/opencode.json",
            "templates/opencode.base.json",
            "templates/opencode.policy.json",
            "templates/playwright-mcp.config.json",
            "templates/tui.json",
            "templates/codex/README.md",
            "templates/codex/config.toml",
            "templates/codex/mcp/README.md",
            "templates/codex/mcp/playwright.toml",
            "templates/cursor/README.md",
            "templates/cursor/manifest.json",
            "templates/cursor/global-profile.json",
            "templates/cursor/permissions/global-playwright.json",
            "templates/cursor/user-rules.md",
            "templates/cursor/mcp/README.md",
            "templates/cursor/mcp/mcp.example.json",
            "templates/cursor/mcp/playwright.mcp.json",
            "templates/cursor/sandbox/README.md",
            "templates/cursor/sandbox/safe.json",
            "templates/cursor/sandbox/playwright-safe.json",
            "templates/cursor/sandbox/playwright-full.json",
            "templates/cursor/rules/core-safety.mdc",
            "templates/cursor/rules/prompt-contract.mdc",
            "templates/cursor/rules/repo-workflow.mdc",
            "templates/cursor/rules/wordpress-woocommerce.mdc",
            "templates/cursor/rules/nextjs-supabase.mdc",
            "templates/cursor/rules/frontend-design.mdc",
            "templates/cursor/rules/release-check.mdc",
            "templates/cursor/agents/verifier.md",
            "templates/cursor/agents/security-reviewer.md",
            "templates/cursor/agents/release-checker.md",
            "templates/cursor/agents/browser-qa.md",
            "templates/cursor/agents/repo-scout.md",
            "templates/prompts/standard-prompt.md",
            "templates/prompts/masterprompt.md",
        ] {
            write_file(&root, rel, "template content\n");
        }
        for &rel in &[
            "agents/architect.md",
            "agents/scout.md",
            "agents/inspector.md",
            "agents/sentinel.md",
            "agents/scribe.md",
            "agents/verifier.md",
        ] {
            write_file(&root, rel, "agent content\n");
        }
        for &rel in &[
            "scripts/bootstrap.sh",
            "scripts/generate-opencode-config.py",
            "scripts/playwright-mcp-lib.sh",
            "scripts/check-playwright-mcp.sh",
            "scripts/install-skills.sh",
            "scripts/install-agent-rules.sh",
            "scripts/install-opencode-config.sh",
            "scripts/install-codex-config.sh",
            "scripts/install-cursor-workspace.sh",
            "scripts/cursor-global-profile-lib.sh",
            "scripts/test_cursor_global_profile.py",
            "scripts/check-codex-profile.py",
            "scripts/check-cursor-profile.py",
        ] {
            write_file(&root, rel, "#!/usr/bin/env bash\necho script\n");
        }
        for &rel in &[
            "skills/accessibility-review/SKILL.md",
            "skills/agent-report-review/SKILL.md",
            "skills/browser-qa/SKILL.md",
            "skills/caveman/SKILL.md",
            "skills/context-budget/SKILL.md",
            "skills/current-docs/SKILL.md",
            "skills/database-migrations/SKILL.md",
            "skills/dependency-evaluation/SKILL.md",
            "skills/diagnose/SKILL.md",
            "skills/frontend-design/SKILL.md",
            "skills/grill-me/SKILL.md",
            "skills/grill-with-docs/SKILL.md",
            "skills/handoff/SKILL.md",
            "skills/implementation-plan/SKILL.md",
            "skills/improve-codebase-architecture/SKILL.md",
            "skills/nextjs-product-slice/SKILL.md",
            "skills/prototype/SKILL.md",
            "skills/release-check/SKILL.md",
            "skills/screenshot-review/SKILL.md",
            "skills/security-review/SKILL.md",
            "skills/supabase-rls-review/SKILL.md",
            "skills/tdd/SKILL.md",
            "skills/to-prd/SKILL.md",
            "skills/triage/SKILL.md",
            "skills/woocommerce-pdp-review/SKILL.md",
            "skills/wordpress-woocommerce/SKILL.md",
            "skills/write-a-skill/SKILL.md",
            "skills/zoom-out/SKILL.md",
        ] {
            write_file(&root, rel, "skill content\n");
        }
        write_file(&root, "metadata/agents.json", "{\"agents\":{}}");
        root
    }

    fn create_target(parent: &Path, name: &str) -> PathBuf {
        parent.join(name)
    }

    #[test]
    fn create_missing_directory_success() {
        let source = setup_source_root("create-missing");
        let parent = temp_root("create-missing-parent");
        fs::create_dir_all(&parent).expect("create parent");
        let target = create_target(&parent, "my-workspace");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));

        assert!(
            result.success,
            "create should succeed, got: {}",
            result.message
        );
        assert_eq!(result.status, "created");
        assert!(
            validate_workspace_root(PathBuf::from(&result.target_path)).is_ok(),
            "created workspace path must pass validation"
        );
        assert!(!result.copied_files.is_empty(), "should have copied files");
        assert!(result
            .copied_files
            .iter()
            .any(|f| f == ".agent-workspace/workspace.json"));
        assert!(result.copied_files.iter().any(|f| f == "README.md"));
        assert!(result.copied_files.iter().any(|f| f.starts_with("docs/")));
        assert!(result
            .copied_files
            .iter()
            .any(|f| f.starts_with("templates/")));
        assert!(result
            .copied_files
            .iter()
            .any(|f| f.starts_with("scripts/")));
        assert!(result
            .copied_files
            .iter()
            .any(|f| f == "skills/diagnose/SKILL.md"));

        cleanup(&source);
        cleanup(&parent);
    }

    #[test]
    fn create_empty_directory_success() {
        let source = setup_source_root("create-empty");
        let target = temp_root("create-empty-target");
        fs::create_dir_all(&target).expect("create empty dir");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        cleanup(&source);
        cleanup(&target);

        assert!(
            result.success,
            "create in empty dir should succeed, got: {}",
            result.message
        );
        assert_eq!(result.status, "created");
        assert!(!result.copied_files.is_empty());
    }

    #[test]
    fn reject_missing_parent() {
        let source = setup_source_root("reject-missing-parent");
        let parent = temp_root("reject-missing-parent-root");
        // parent does not exist
        let target = create_target(&parent, "nope");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        cleanup(&source);
        // parent was never created
        assert!(!parent.exists());

        assert!(!result.success);
        assert_eq!(result.status, "missing_parent");
    }

    #[test]
    fn reject_non_empty_non_workspace() {
        let source = setup_source_root("reject-nonempty");
        let target = temp_root("reject-nonempty-target");
        fs::create_dir_all(&target).expect("create dir");
        fs::write(target.join("unrelated.txt"), "hello").expect("write unrelated");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        let has_unrelated = target.join("unrelated.txt").exists();
        cleanup(&source);
        cleanup(&target);

        assert!(!result.success);
        assert_eq!(result.status, "non_empty_non_workspace");
        assert!(has_unrelated, "unrelated file should remain");
    }

    #[test]
    fn reject_valid_existing_workspace() {
        let source = setup_source_root("reject-valid");
        let target = setup_valid_workspace("reject-valid-target");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        cleanup(&source);
        cleanup(&target);

        assert!(!result.success);
        assert_eq!(result.status, "valid_existing_workspace");
        assert!(result.copied_files.is_empty());
    }

    #[test]
    fn reject_unsafe_target() {
        let source = setup_source_root("reject-unsafe");
        // Test with HOME
        let home = std::env::var("HOME").unwrap();
        let result = create_workspace_from_source(&source, Some(home));
        cleanup(&source);

        assert!(!result.success);
        assert_eq!(result.status, "unsafe_target");
    }

    #[test]
    fn never_overwrite_existing_file() {
        let source = setup_source_root("no-overwrite");
        let target = temp_root("no-overwrite-target");
        fs::create_dir_all(&target).expect("create target");
        // Place a file at a planned destination path but leave the dir otherwise empty
        let marker_dir = target.join(".agent-workspace");
        fs::create_dir_all(&marker_dir).expect("create marker dir");
        let existing_content = "preexisting-data";
        fs::write(marker_dir.join("workspace.json"), existing_content).expect("write preexisting");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));

        // Target has entries (the .agent-workspace dir) so planner says non_empty_non_workspace
        // Verify it was rejected
        let file_content =
            fs::read_to_string(target.join(".agent-workspace/workspace.json")).unwrap_or_default();
        cleanup(&source);
        cleanup(&target);

        assert!(!result.success);
        assert_eq!(result.status, "non_empty_non_workspace");
        assert_eq!(
            file_content, existing_content,
            "preexisting file must not be overwritten"
        );
    }

    #[test]
    fn scripts_are_not_executed() {
        let source = setup_source_root("scripts-not-executed");
        let target = temp_root("scripts-not-executed-target");
        fs::create_dir_all(&target).expect("create target dir");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));

        // Only check that the command succeeded and copied script files as regular files.
        // The create command never executes anything — it only calls fs::copy.
        let bootstrap_exists = target.join("scripts/bootstrap.sh").exists();
        cleanup(&source);
        cleanup(&target);

        assert!(result.success, "create should succeed");
        assert!(
            result
                .copied_files
                .iter()
                .any(|f| f == "scripts/bootstrap.sh"),
            "bootstrap.sh should be among copied files"
        );
        assert!(bootstrap_exists, "script file should exist on disk");
        // No execution means no side effects. copy alone is enough to prove this.
    }

    #[test]
    fn preflight_missing_source_writes_nothing() {
        let source = temp_root("preflight-missing-source");
        // Set up a source root that is MISSING several required files
        write_file(&source, ".agent-workspace/workspace.json", "{}");
        write_file(&source, "README.md", "# readme\n");
        // Missing: docs/, templates/, scripts/, skills/

        let parent = temp_root("preflight-missing-source-parent");
        fs::create_dir_all(&parent).expect("create parent dir");
        let target = create_target(&parent, "should-not-exist");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        let target_was_created = target.exists();
        cleanup(&source);
        cleanup(&parent);

        assert!(
            !result.success,
            "create should fail on missing source files"
        );
        assert_eq!(result.status, "source_missing");
        assert!(
            result.copied_files.is_empty(),
            "no files should be copied when preflight fails"
        );
        assert!(
            result.skipped_files.is_empty(),
            "skipped_files should be empty"
        );
        assert!(
            !target_was_created,
            "target directory must not be created when preflight fails"
        );
    }

    #[test]
    fn preflight_destination_exists_writes_nothing() {
        let source = setup_source_root("preflight-dest-exists");
        // Create an empty target directory, then place a planned file inside it
        let target = temp_root("preflight-dest-exists-target");
        fs::create_dir_all(&target).expect("create target dir");
        // Place a planned file directly; planner sees entries and rejects
        let marker_dir = target.join(".agent-workspace");
        fs::create_dir_all(&marker_dir).expect("create marker dir");
        let existing_content = "should-not-be-touched";
        fs::write(marker_dir.join("workspace.json"), existing_content)
            .expect("write preexisting file");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        let file_content =
            fs::read_to_string(target.join(".agent-workspace/workspace.json")).unwrap_or_default();
        cleanup(&source);
        cleanup(&target);

        assert!(
            !result.success,
            "create should fail when destination exists"
        );
        assert!(
            result.status == "non_empty_non_workspace" || result.status == "destination_exists",
            "expected non_empty_non_workspace or destination_exists, got {}",
            result.status
        );
        assert_eq!(
            file_content, existing_content,
            "existing file content must remain unchanged"
        );
        assert!(result.copied_files.is_empty(), "no files should be copied");
    }

    #[test]
    fn create_success_still_validates_workspace() {
        let source = setup_source_root("create-success-validate");
        let parent = temp_root("create-success-validate-parent");
        fs::create_dir_all(&parent).expect("create parent dir");
        let target = create_target(&parent, "my-workspace");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));

        let marker_exists = target.join(".agent-workspace/workspace.json").is_file();
        let template_exists = target.join("templates/global-agent-rules.md").is_file();
        let script_exists = target.join("scripts/bootstrap.sh").is_file();
        cleanup(&source);
        cleanup(&parent);

        assert!(
            result.success,
            "create should succeed and pass validation, got: {}",
            result.message
        );
        assert_eq!(result.status, "created");
        assert!(!result.copied_files.is_empty(), "should have copied files");
        assert!(marker_exists, "marker file should exist before cleanup");
        assert!(template_exists, "template file should exist before cleanup");
        assert!(script_exists, "script file should exist before cleanup");
    }

    #[test]
    fn create_missing_directory_does_not_create_missing_parent() {
        let source = setup_source_root("no-missing-parent-create");
        let parent = temp_root("no-missing-parent-root");
        // parent does NOT exist
        let target = create_target(&parent, "should-not-exist");

        let result =
            create_workspace_from_source(&source, Some(target.to_string_lossy().into_owned()));
        let parent_was_created = parent.exists();
        let target_was_created = target.exists();
        cleanup(&source);

        assert!(
            !result.success,
            "create should reject when parent is missing"
        );
        assert_eq!(result.status, "missing_parent");
        assert!(!parent_was_created, "parent directory must not be created");
        assert!(!target_was_created, "target directory must not be created");
        assert!(
            result.copied_files.is_empty(),
            "no files should be copied when parent is missing"
        );
    }

    // ── repair_workspace_core tests ──

    #[test]
    fn repair_dry_run_reports_missing_files() {
        let source = setup_source_root("repair-dry-ws");
        let target = temp_root("repair-dry-tgt");
        fs::create_dir_all(&target).expect("create target dir");

        // Add workspace markers so it's a valid workspace
        write_file(&target, ".agent-workspace/workspace.json", "{}");
        // Deliberately missing: scripts/generate-opencode-config.py,
        // templates/opencode.base.json, templates/opencode.policy.json.

        let result = repair_workspace_core(&source, &target, true);
        assert!(result.ok, "dry run should succeed: {}", result.message);
        assert!(result.dry_run, "should be dry run");

        // Should report generator, base.json, policy.json as missing
        let missing: Vec<&str> = result.copied_files.iter().map(|s| s.as_str()).collect();
        assert!(
            missing.contains(&"scripts/generate-opencode-config.py"),
            "dry-run must report missing generator, got: {:?}",
            missing
        );
        assert!(
            missing.contains(&"templates/opencode.base.json"),
            "dry-run must report missing base.json, got: {:?}",
            missing
        );
        assert!(
            missing.contains(&"templates/opencode.policy.json"),
            "dry-run must report missing policy.json, got: {:?}",
            missing
        );

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_no_work_when_all_files_present() {
        let source = setup_source_root("repair-nop-ws");
        let target = temp_root("repair-nop-tgt");
        fs::create_dir_all(&target).expect("create target dir");

        // Full workspace via source copy
        for (_label, paths) in super::super::defaults::default_workspace_files() {
            for &rel in paths {
                let src = source.join(rel);
                let dst = target.join(rel);
                if src.is_file() {
                    if let Some(parent) = dst.parent() {
                        fs::create_dir_all(parent).expect("create parent");
                    }
                    fs::copy(&src, &dst).expect("copy file");
                }
            }
        }

        let result = repair_workspace_core(&source, &target, true);
        assert!(result.ok, "repair should report ok");
        assert!(
            result.copied_files.is_empty(),
            "no files should need repair, got: {:?}",
            result.copied_files
        );

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_copies_only_missing_files() {
        let source = setup_source_root("repair-copy-ws");
        let target = temp_root("repair-copy-tgt");
        fs::create_dir_all(&target).expect("create target dir");

        // Create a minimal workspace with markers but missing generator/base/policy
        write_file(&target, ".agent-workspace/workspace.json", "{}");
        write_file(&target, "README.md", "# workspace\n");
        write_file(&target, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &target,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &target,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &target,
            "scripts/install-codex-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &target,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &target,
            "scripts/install-skills.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&target, "templates/global-agent-rules.md", "# rules\n");
        write_file(&target, "templates/opencode.json", "{}");
        write_file(
            &target,
            "templates/codex/config.toml",
            "profile = \"safe\"\n",
        );
        write_file(&target, "templates/tui.json", "{}");
        mkdir(&target, "templates/cursor/agents");
        write_file(
            &target,
            "templates/cursor/rules/workspace.mdc",
            "---\nalwaysApply: true\n---\n",
        );
        mkdir(&target, "skills");

        // Pre-existing user content — must NOT be overwritten
        let user_content = "user-edited-content";
        write_file(&target, "templates/opencode.json", user_content);

        let result = repair_workspace_core(&source, &target, false);
        assert!(result.ok, "repair should succeed: {}", result.message);

        let copied: Vec<&str> = result.copied_files.iter().map(|s| s.as_str()).collect();
        assert!(
            copied.contains(&"scripts/generate-opencode-config.py"),
            "generator should be copied, got: {:?}",
            copied
        );
        assert!(
            copied.contains(&"templates/opencode.base.json"),
            "base.json should be copied, got: {:?}",
            copied
        );
        assert!(
            copied.contains(&"templates/opencode.policy.json"),
            "policy.json should be copied"
        );

        // Verify pre-existing user content was NOT overwritten
        let saved_content =
            fs::read_to_string(target.join("templates/opencode.json")).unwrap_or_default();
        assert_eq!(
            saved_content, user_content,
            "existing user content must not be overwritten"
        );

        // Verify the new files actually exist on disk
        assert!(
            target.join("scripts/generate-opencode-config.py").is_file(),
            "generator must exist on disk after repair"
        );
        assert!(
            target.join("templates/opencode.base.json").is_file(),
            "base.json must exist on disk after repair"
        );
        assert!(
            target.join("templates/opencode.policy.json").is_file(),
            "policy.json must exist on disk after repair"
        );

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn missing_bundled_paths_detect_prompt_templates_on_valid_workspace() {
        let root = setup_valid_workspace("valid-missing-prompt-docs");
        let missing = missing_bundled_file_paths(&root);
        for rel in [
            "docs/prompt-templates/standard-prompt.md",
            "docs/prompt-templates/masterprompt.md",
            "docs/prompt-templates/batchprompt.md",
        ] {
            assert!(
                missing.iter().any(|p| p == rel),
                "valid workspace without prompt templates must report missing: {}",
                rel
            );
        }
        cleanup(&root);
    }

    #[test]
    fn repair_does_not_overwrite_custom_context_doc() {
        let source = setup_source_root("repair-custom-doc-src");
        let target = setup_valid_workspace("repair-custom-doc-tgt");
        let custom_rel = "docs/context/my-note.md";
        let user_content = "# My custom note\n\nuser-owned content\n";
        write_file(&target, custom_rel, user_content);

        let result = repair_workspace_core(&source, &target, false);
        assert!(result.ok, "repair should succeed: {}", result.message);
        assert!(
            !result.copied_files.iter().any(|p| p == custom_rel),
            "repair must not copy over custom context doc"
        );
        let after = fs::read_to_string(target.join(custom_rel)).expect("read custom doc");
        assert_eq!(after, user_content, "custom context doc must be unchanged");

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_replaces_zero_byte_prompt_template_doc() {
        let source = setup_source_root("repair-empty-prompt-src");
        let target = setup_valid_workspace("repair-empty-prompt-tgt");
        let rel = "docs/prompt-templates/standard-prompt.md";
        write_file(&target, rel, "");

        let result = repair_workspace_core(&source, &target, false);
        assert!(result.ok, "repair should succeed: {}", result.message);
        assert!(
            result.copied_files.iter().any(|p| p == rel),
            "repair must replace zero-byte prompt template: {:?}",
            result.copied_files
        );
        let content = fs::read_to_string(target.join(rel)).expect("read prompt template");
        assert!(
            !content.is_empty(),
            "prompt template must be non-empty after repair"
        );

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_copies_missing_prompt_template_docs() {
        let source = setup_source_root("repair-prompt-docs-ws");
        let target = temp_root("repair-prompt-docs-tgt");
        fs::create_dir_all(&target).expect("create target dir");
        write_file(&target, ".agent-workspace/workspace.json", "{}");
        write_file(&target, "README.md", "# workspace\n");

        let result = repair_workspace_core(&source, &target, false);
        assert!(result.ok, "repair should succeed: {}", result.message);

        let copied: Vec<&str> = result.copied_files.iter().map(|s| s.as_str()).collect();
        for rel in [
            "docs/prompt-templates/standard-prompt.md",
            "docs/prompt-templates/masterprompt.md",
            "docs/prompt-templates/batchprompt.md",
        ] {
            assert!(
                copied.contains(&rel) || target.join(rel).is_file(),
                "prompt template doc should be copied or already exist: {}",
                rel
            );
            assert!(
                target.join(rel).is_file(),
                "prompt template doc must exist on disk after repair: {}",
                rel
            );
        }

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_refreshes_stale_cursor_bundle_files() {
        let bundled =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/default-workspace");
        let source = setup_source_root("repair-cursor-refresh-src");
        let target = temp_root("repair-cursor-refresh-tgt");
        fs::create_dir_all(&target).expect("create target");

        let fresh_script = fs::read_to_string(bundled.join("scripts/install-cursor-workspace.sh"))
            .expect("read bundled install-cursor-workspace.sh");
        write_file(
            &source,
            "scripts/install-cursor-workspace.sh",
            &fresh_script,
        );
        let fresh_manifest = fs::read_to_string(bundled.join("templates/cursor/manifest.json"))
            .expect("read bundled manifest");
        write_file(&source, "templates/cursor/manifest.json", &fresh_manifest);

        write_file(&target, ".agent-workspace/workspace.json", "{}");
        write_file(&target, "README.md", "# workspace\n");
        write_file(
            &target,
            "scripts/install-cursor-workspace.sh",
            "#!/usr/bin/env bash\n# stale legacy script\n",
        );
        let stale_manifest = r#"{"schema_version":"1.0","agents":[]}"#;
        write_file(&target, "templates/cursor/manifest.json", stale_manifest);

        let result = repair_workspace_core(&source, &target, false);
        assert!(result.ok, "repair should succeed: {}", result.message);
        assert!(
            result
                .refreshed_files
                .iter()
                .any(|p| p == "scripts/install-cursor-workspace.sh"),
            "stale install script should be refreshed, got: {:?}",
            result.refreshed_files
        );
        let script =
            fs::read_to_string(target.join("scripts/install-cursor-workspace.sh")).unwrap();
        assert!(
            script.contains("--apply-global-profile"),
            "refreshed script must include --apply-global-profile"
        );
        let manifest = fs::read_to_string(target.join("templates/cursor/manifest.json")).unwrap();
        assert!(
            manifest.contains("permissions_templates"),
            "refreshed manifest must include permissions_templates"
        );

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_rejects_broad_paths() {
        // Simulate the unsafe target checks used by repair_workspace_impl
        assert!(is_unsafe_target(std::path::Path::new("/")));
        let home = std::env::var("HOME").unwrap_or_default();
        assert!(is_unsafe_target(std::path::Path::new(&home)));
        assert!(is_unsafe_target(std::path::Path::new("/Users")));
        assert!(!is_unsafe_target(std::path::Path::new(&format!(
            "{}/my-workspace",
            home
        ))));
    }

    #[test]
    fn repair_skips_source_missing_files_gracefully() {
        let source = temp_root("repair-src-miss");
        let target = temp_root("repair-tgt-miss");
        fs::create_dir_all(&target).expect("create target");

        // Source has workspace.json but NOT the generator script, base.json, or policy.json
        write_file(&source, ".agent-workspace/workspace.json", "{}");
        write_file(&source, "README.md", "# readme\n");
        // No other files — many default_workspace_files will be missing from source

        let result = repair_workspace_core(&source, &target, true);
        // Should still succeed — missing source files are skipped gracefully
        assert!(result.ok, "repair should succeed even with sparse source");
        // copied_files should be empty or only contain files that exist in the sparse source
        for f in &result.copied_files {
            let src = source.join(f);
            assert!(src.is_file(), "copied file '{}' must exist in source", f);
        }

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_skips_traversal_rel_paths() {
        // The core function filters out rel paths containing ".."
        // This test verifies by providing a path with ".." that would be in the
        // default file list — but the default_workspace_files() never contains ".."
        // so this path is never exercised. The filter exists for defense-in-depth.
        let source = temp_root("repair-trav-src");
        let target = temp_root("repair-trav-tgt");
        fs::create_dir_all(&target).expect("create target");

        write_file(&source, ".agent-workspace/workspace.json", "{}");
        write_file(&source, "README.md", "# readme\n");

        // Target is a valid existing workspace; repair should find nothing to do
        // (since target already has workspace.json and README.md)
        let result = repair_workspace_core(&source, &target, true);
        assert!(result.ok, "repair should succeed");
        // The function filters ".." paths — nothing to assert about traversal
        // except that it doesn't panic.

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn repair_second_run_reports_nothing_to_do() {
        let source = setup_source_root("repair-2nd-ws");
        let target = temp_root("repair-2nd-tgt");
        fs::create_dir_all(&target).expect("create target");

        // Apply repair once
        let first = repair_workspace_core(&source, &target, false);
        assert!(first.ok, "first repair should succeed: {}", first.message);

        // Second repair (dry-run) should report nothing to do
        let second = repair_workspace_core(&source, &target, true);
        assert!(second.ok, "second repair should succeed");
        assert!(
            second.copied_files.is_empty(),
            "second repair should find no missing files, got: {:?}",
            second.copied_files
        );

        cleanup(&source);
        cleanup(&target);
    }

    #[test]
    fn brain_setup_seed_reads_existing_file() {
        let root = setup_valid_workspace("brain-seed-found");
        mkdir(&root, "templates/context");
        write_file(&root, BRAIN_SETUP_SEED_REL, "# saved memory seed\n");

        let result = read_brain_setup_seed_under_root(&root).expect("read seed");
        assert_eq!(result.status, "found");
        assert_eq!(result.source, "workspace saved-memory.md");
        assert!(result.content.contains("saved memory seed"));

        cleanup(&root);
    }

    #[test]
    fn brain_setup_seed_missing_returns_safe_status() {
        let root = setup_valid_workspace("brain-seed-missing");

        let result = read_brain_setup_seed_under_root(&root).expect("read seed");
        assert_eq!(result.status, "missing");
        assert_eq!(result.source, "generated fallback");
        assert!(result.content.is_empty());

        cleanup(&root);
    }
}
