use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::process::{run_cmd, ActionResult};
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

pub(super) fn setup_workspace_target_path() -> Result<PathBuf, String> {
    let settings = settings::load();
    let path = match configured_workspace_path(&settings) {
        Some(path) => path,
        None => default_installed_workspace_path()?,
    };
    if !path.is_absolute() {
        return Err(format!(
            "setup workspace target must be absolute: {}",
            path.display()
        ));
    }
    crate::path_safety::reject_symlink(&path, "setup workspace target")?;
    Ok(path)
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

/// `AGENT_WORKSPACE_PATH` wins over any saved workspace (see `configured_workspace_path`), so a
/// workspace chosen in the app would silently not take effect while it is set.
fn ensure_no_workspace_env_override() -> Result<(), String> {
    let overridden = std::env::var("AGENT_WORKSPACE_PATH")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if overridden {
        return Err(
            "AGENT_WORKSPACE_PATH is set and overrides the workspace chosen in the app; unset it to switch workspaces"
                .to_string(),
        );
    }
    Ok(())
}

/// Adds what is missing to the generic invalid-workspace error, for the folder picker.
fn explain_invalid_workspace(path: &Path, error: String) -> String {
    let missing = if !path.is_dir() {
        "folder not found".to_string()
    } else if let Some(def) = workspace_marker_defs()
        .iter()
        .find(|def| !def.kind.exists(path, def.rel_path))
    {
        format!("missing {}", def.rel_path)
    } else if !workspace_has_cursor_mdc_rule(path) {
        "missing templates/cursor/rules/*.mdc".to_string()
    } else {
        return error;
    };
    format!("{error} ({missing})")
}

#[tauri::command]
pub fn try_set_active_workspace_path(path: String) -> Result<settings::AppSettings, String> {
    let normalized = normalize_user_workspace_path_for_save(&path)?
        .ok_or_else(|| "workspace path must be absolute or start with ~/".to_string())?;
    let canonical = validate_workspace_root(PathBuf::from(&normalized))
        .map_err(|error| explain_invalid_workspace(Path::new(&normalized), error))?;
    ensure_no_workspace_env_override()?;
    // The default folder is stored as "no custom workspace", so it reads as the default afterwards.
    let is_default = default_installed_workspace_path()
        .ok()
        .and_then(|default| default.canonicalize().ok())
        .is_some_and(|default| default == canonical);
    let canonical_path = canonical.to_string_lossy().into_owned();
    settings::mutate_settings(|current| {
        current.workspace_path = if is_default {
            None
        } else {
            Some(canonical_path)
        };
        Ok(settings::MutationOutcome::Changed)
    })
}

/// Back to the default workspace (`~/.config/agent-workspace`): no custom path saved.
#[tauri::command]
pub fn reset_active_workspace_path() -> Result<settings::AppSettings, String> {
    ensure_no_workspace_env_override()?;
    settings::mutate_settings(|current| {
        if current.workspace_path.is_none() {
            return Ok(settings::MutationOutcome::Unchanged);
        }
        current.workspace_path = None;
        Ok(settings::MutationOutcome::Changed)
    })
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
        configured_workspace_path, default_installed_workspace_path,
        persisted_workspace_path_is_valid, read_brain_setup_seed_under_root,
        repair_workspace_target_path, reset_active_workspace_path, scrub_stale_workspace_path,
        try_set_active_workspace_path, validate_workspace_root,
        workspace_diagnostics_for_unconfigured, BRAIN_SETUP_SEED_REL, NO_WORKSPACE_SELECTED,
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

    #[test]
    fn configured_workspace_path_ignores_legacy_relative_paths() {
        let _guard = crate::test_env::guard::lock();
        let home = crate::test_env::process_home();
        let settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some("workspace/local".into()),
            enabled_target_ids: vec![],
            enabled_harness_ids: crate::agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
        };

        let candidate = configured_workspace_path(&settings).expect("canonical fallback");
        assert_eq!(candidate, home.join(".config/agent-workspace"));
    }

    #[test]
    fn default_settings_use_installed_workspace_candidate() {
        let _guard = crate::test_env::guard::lock();
        let home = crate::test_env::process_home();
        let expected = home.join(".config/agent-workspace");
        let candidate = configured_workspace_path(&AppSettings::default())
            .expect("canonical default should resolve when HOME is set");
        assert_eq!(candidate, expected);
    }

    #[test]
    fn repair_workspace_target_prefers_agent_workspace_path_override() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let target = setup_valid_workspace("repair-target-override");
        let target_str = target.to_string_lossy().into_owned();
        std::env::set_var("AGENT_WORKSPACE_PATH", &target_str);
        let resolved = repair_workspace_target_path().expect("resolve repair target");
        assert_eq!(
            resolved.canonicalize().expect("canonical resolved"),
            target.canonicalize().expect("canonical target")
        );
        cleanup(&target);
    }

    #[test]
    fn legacy_agent_workspace_saved_setting_falls_back_to_canonical_default() {
        let _guard = crate::test_env::guard::lock();
        let home = crate::test_env::process_home();
        let settings = AppSettings {
            appearance: "dark".into(),
            app_font_size: "medium".into(),
            workspace_path: Some("~/Agent Workspace".into()),
            enabled_target_ids: vec![],
            enabled_harness_ids: crate::agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
        };
        let candidate = configured_workspace_path(&settings).expect("candidate");
        assert_eq!(candidate, home.join(".config/agent-workspace"));
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
            workspace_path: Some(
                std::env::temp_dir()
                    .join("agent-workspace-scrub-missing")
                    .to_string_lossy()
                    .into_owned(),
            ),
            enabled_target_ids: vec![],
            enabled_harness_ids: crate::agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
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
            enabled_harness_ids: crate::agent_targets::default_enabled_harness_ids(),
            accent_color: None,
            background_color: None,
            foreground_color: None,
            motion: "full".into(),
            reduce_motion: false,
            landing_view: "start".into(),
            repo_dashboard_entries: Vec::new(),
            active_repo_dashboard_id: None,
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
        };

        assert!(!scrub_stale_workspace_path(&mut settings));
        assert!(settings.workspace_path.is_some());
        assert!(persisted_workspace_path_is_valid(
            settings.workspace_path.as_ref().expect("path")
        ));
        cleanup(&root);
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
    fn try_set_active_workspace_path_rejects_invalid_directory() {
        let path = std::env::temp_dir()
            .join("agent-workspace-not-a-valid-root")
            .to_string_lossy()
            .into_owned();
        let result = try_set_active_workspace_path(path);
        assert!(result.is_err(), "invalid path must not become active");
    }

    /// Runs `test` with HOME and the settings file under a temp dir and no `AGENT_WORKSPACE_PATH`,
    /// so the commands that persist settings never touch the real ones.
    fn with_isolated_settings<F: FnOnce(&Path)>(name: &str, test: F) {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_root(name);
        fs::create_dir_all(&home).expect("create temp home");
        crate::test_env::set_test_user_dirs(&home);
        unsafe { std::env::remove_var("AGENT_WORKSPACE_PATH") };
        test(&home);
        cleanup(&home);
    }

    #[test]
    fn try_set_active_workspace_path_names_what_is_missing() {
        let empty = temp_root("activate-empty");
        mkdir(&empty, "");
        let path = empty.to_string_lossy().into_owned();
        let error = try_set_active_workspace_path(path).expect_err("empty folder is invalid");
        cleanup(&empty);

        assert!(error.contains("invalid workspace path"), "{error}");
        assert!(
            error.contains("missing .agent-workspace/workspace.json"),
            "{error}"
        );
    }

    #[test]
    fn try_set_active_workspace_path_persists_a_valid_workspace_and_reset_clears_it() {
        with_isolated_settings("activate-persist-home", |_| {
            let root = setup_valid_workspace("activate-persist");
            let saved = try_set_active_workspace_path(root.to_string_lossy().into_owned())
                .expect("valid workspace activates");
            let canonical = root
                .canonicalize()
                .expect("canonical root")
                .to_string_lossy()
                .into_owned();
            assert_eq!(saved.workspace_path.as_deref(), Some(canonical.as_str()));
            assert_eq!(
                crate::settings::load().workspace_path.as_deref(),
                Some(canonical.as_str())
            );

            let reset = reset_active_workspace_path().expect("reset");
            assert_eq!(reset.workspace_path, None);
            assert_eq!(crate::settings::load().workspace_path, None);
            cleanup(&root);
        });
    }

    #[test]
    fn choosing_the_default_folder_stores_no_custom_path() {
        with_isolated_settings("activate-default-home", |_| {
            let default = default_installed_workspace_path().expect("default path");
            for rel in [
                ".agent-workspace/workspace.json",
                "scripts/bootstrap.sh",
                "scripts/install-agent-rules.sh",
                "scripts/install-opencode-config.sh",
                "scripts/install-codex-config.sh",
                "scripts/install-cursor-workspace.sh",
                "scripts/install-skills.sh",
                "templates/global-agent-rules.md",
                "templates/opencode.json",
                "templates/codex/config.toml",
                "templates/cursor/rules/workspace.mdc",
                "README.md",
            ] {
                write_file(&default, rel, "x");
            }
            mkdir(&default, "templates/cursor/agents");
            mkdir(&default, "skills");

            let saved = try_set_active_workspace_path(default.to_string_lossy().into_owned())
                .expect("default workspace activates");
            assert_eq!(saved.workspace_path, None);
        });
    }

    #[test]
    fn workspace_choice_is_refused_while_the_env_override_is_set() {
        with_isolated_settings("activate-env-home", |_| {
            let root = setup_valid_workspace("activate-env");
            unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", "/somewhere/else") };

            let chosen = try_set_active_workspace_path(root.to_string_lossy().into_owned());
            let reset = reset_active_workspace_path();
            cleanup(&root);

            for result in [chosen, reset] {
                let error = result.expect_err("the env override must be reported");
                assert!(error.contains("AGENT_WORKSPACE_PATH"), "{error}");
            }
            assert_eq!(crate::settings::load().workspace_path, None);
        });
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
