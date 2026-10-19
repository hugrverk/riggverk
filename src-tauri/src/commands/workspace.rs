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

/// The app's own state in a data folder: the workspace marker and the ownership records. A saved
/// custom folder is recognised by them. Validity never reads bundled copies, so removing those
/// copies cannot invalidate a folder or drop a saved one from the settings.
pub(crate) const DATA_FOLDER_STATE_FILES: &[&str] = &[
    ".agent-workspace/workspace.json",
    crate::managed_state::MANAGED_STATE_REL,
];

pub(crate) const NO_WORKSPACE_SELECTED: &str = "no workspace selected";

/// Prefix of every unusable-folder error; the UI keeps quiet about reads that fail with it.
const INVALID_WORKSPACE_PATH: &str = "invalid workspace path";

/// Where the data folder path came from; it decides what makes the folder usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataFolderOrigin {
    /// `AGENT_WORKSPACE_PATH` (development and tests): an existing folder.
    Env,
    /// A custom folder saved in the settings: an existing folder holding the app's state.
    Saved,
    /// `~/.config/agent-workspace`: absent on a fresh profile until the first write creates it.
    Default,
}

/// Env override, a usable saved custom folder, or the default path.
fn resolve_data_folder(settings: &settings::AppSettings) -> Option<(PathBuf, DataFolderOrigin)> {
    if let Ok(p) = std::env::var("AGENT_WORKSPACE_PATH") {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            return Some((PathBuf::from(trimmed), DataFolderOrigin::Env));
        }
    }
    if let Some(ref custom) = settings.workspace_path {
        if !is_legacy_default_workspace_path(custom) {
            if let Some(normalized) = normalize_user_workspace_path(custom) {
                if persisted_workspace_path_is_valid(&normalized) {
                    return Some((PathBuf::from(normalized), DataFolderOrigin::Saved));
                }
            }
        }
    }
    default_installed_workspace_path()
        .ok()
        .map(|path| (path, DataFolderOrigin::Default))
}

/// Resolved data folder path: env override, usable saved custom folder, or the default path.
pub(crate) fn configured_workspace_path(settings: &settings::AppSettings) -> Option<PathBuf> {
    resolve_data_folder(settings).map(|(path, _)| path)
}

fn holds_app_state(folder: &Path) -> bool {
    DATA_FOLDER_STATE_FILES
        .iter()
        .any(|rel| folder.join(rel).is_file())
}

/// Why `path` is not a usable data folder, or `None`. It looks at the folder itself and, for a
/// saved custom folder, at its `.agent-workspace/` state: never at bundled copies.
fn data_folder_problem(path: &Path, origin: DataFolderOrigin) -> Option<String> {
    if !path.is_absolute() {
        return Some("not an absolute path".to_string());
    }
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Some("the folder is a symlink".to_string()),
        Ok(meta) if !meta.is_dir() => Some("not a folder".to_string()),
        Ok(_) if origin == DataFolderOrigin::Saved && !holds_app_state(path) => {
            Some("missing .agent-workspace/workspace.json or managed-state.json".to_string())
        }
        Ok(_) => None,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (origin != DataFolderOrigin::Default).then(|| "folder not found".to_string())
        }
        Err(e) => Some(format!("cannot inspect the folder: {e}")),
    }
}

/// The data folder when it is usable. An existing folder resolves as before (parent links
/// included); an absent default folder (a fresh profile) is returned as it is.
fn validate_data_folder(path: PathBuf, origin: DataFolderOrigin) -> Result<PathBuf, String> {
    if let Some(problem) = data_folder_problem(&path, origin) {
        return Err(format!(
            "{INVALID_WORKSPACE_PATH}: not a usable workspace folder ({problem})"
        ));
    }
    Ok(path.canonicalize().unwrap_or(path))
}

/// The usable data folder, which does not exist yet on a fresh profile. Only reads: nothing here
/// creates the folder.
pub(super) fn workspace_root() -> Result<PathBuf, String> {
    let settings = settings::load();
    let (path, origin) =
        resolve_data_folder(&settings).ok_or_else(|| NO_WORKSPACE_SELECTED.to_string())?;
    validate_data_folder(path, origin)
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

/// Returns true when a saved custom path is a real folder holding the app's state.
pub(crate) fn persisted_workspace_path_is_valid(path: &str) -> bool {
    data_folder_problem(Path::new(path), DataFolderOrigin::Saved).is_none()
}

/// Clear a saved custom path that is gone or no longer holds the app's state. Bundled copies
/// play no part: deleting them from the folder never clears it.
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

/// The app's state files in the folder (informational: validity does not need them for the
/// default folder).
fn state_file_markers(folder: &Path) -> Vec<WorkspaceMarkerStatus> {
    DATA_FOLDER_STATE_FILES
        .iter()
        .map(|rel| WorkspaceMarkerStatus {
            kind: "file".to_string(),
            path: rel.to_string(),
            exists: folder.join(rel).is_file(),
        })
        .collect()
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
        bundled_resources_status,
        missing_bundled_count,
        missing_bundled_sample,
    }
}

#[tauri::command]
pub fn get_workspace_diagnostics() -> Result<WorkspaceDiagnostics, String> {
    let settings = settings::load();
    let Some((candidate, origin)) = resolve_data_folder(&settings) else {
        return Ok(workspace_diagnostics_for_unconfigured(&settings));
    };
    let candidate_str = candidate.to_string_lossy().into_owned();

    // `valid` means the data folder is usable: an absent default folder is a fresh profile.
    let (valid, resolved_path, error) = match validate_data_folder(candidate.clone(), origin) {
        Ok(folder) => (true, Some(folder.to_string_lossy().into_owned()), None),
        Err(_) => (false, None, data_folder_problem(&candidate, origin)),
    };
    let markers = state_file_markers(&candidate);

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
    let (bundled_resources_status, missing_bundled_count, missing_bundled_sample) = resolved_path
        .as_deref()
        .map(Path::new)
        .filter(|folder| folder.is_dir())
        .map(bundled_resources_fields)
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

/// Only a folder the app has used (it holds `.agent-workspace/` state) can be chosen; the error
/// names what is missing, in parentheses, for the folder picker.
#[tauri::command]
pub fn try_set_active_workspace_path(path: String) -> Result<settings::AppSettings, String> {
    let normalized = normalize_user_workspace_path_for_save(&path)?
        .ok_or_else(|| "workspace path must be absolute or start with ~/".to_string())?;
    let canonical = validate_data_folder(PathBuf::from(&normalized), DataFolderOrigin::Saved)?;
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

/// Opens the data folder. On a fresh profile it does not exist yet: the first install or
/// personal doc creates it, never this command.
#[tauri::command]
pub fn open_default_workspace_folder() -> Result<ActionResult, String> {
    let path = workspace_root()?;
    if !path.is_dir() {
        return Err(format!(
            "workspace folder not created yet: {} (the first install or personal doc creates it)",
            path.display()
        ));
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

#[cfg(test)]
mod tests {
    use super::{
        configured_workspace_path, default_installed_workspace_path, get_workspace_diagnostics,
        open_default_workspace_folder, persisted_workspace_path_is_valid,
        reset_active_workspace_path, scrub_stale_workspace_path, setup_workspace_target_path,
        try_set_active_workspace_path, workspace_diagnostics_for_unconfigured, workspace_root,
        NO_WORKSPACE_SELECTED,
    };
    use crate::managed_state::{managed_state_path, read_managed_state};
    use crate::settings::{AppSettings, MutationOutcome};
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

    /// A folder the app has used: the workspace marker, nothing else.
    fn setup_used_folder(name: &str) -> PathBuf {
        let root = temp_root(name);
        write_file(&root, ".agent-workspace/workspace.json", "{}");
        root
    }

    fn canonical_string(path: &Path) -> String {
        path.canonicalize()
            .expect("canonical path")
            .to_string_lossy()
            .into_owned()
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    fn entries(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .expect("read folder")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }

    /// Runs `test` with HOME, the settings file and the backups under a temp dir and no
    /// `AGENT_WORKSPACE_PATH`, so nothing touches the real profile.
    fn with_isolated_settings<F: FnOnce(&Path)>(name: &str, test: F) {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_root(name);
        fs::create_dir_all(&home).expect("create temp home");
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::remove_var("AGENT_WORKSPACE_PATH");
            std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", home.join("backups"));
        }
        test(&home);
        cleanup(&home);
    }

    fn save_workspace_path(path: &str) {
        let path = path.to_string();
        crate::settings::mutate_settings(move |current| {
            current.workspace_path = Some(path);
            Ok(MutationOutcome::Changed)
        })
        .expect("save workspace path");
    }

    /// Preview, then apply with the preview's token, as the review does.
    fn install(surfaces: &[&str]) {
        let surfaces: Vec<String> = surfaces.iter().map(|s| s.to_string()).collect();
        let plan = crate::commands::preview_setup(surfaces.clone()).expect("preview");
        let result = crate::commands::apply_setup(
            surfaces,
            true,
            plan.plan_fingerprint.clone(),
            plan.preview_token.clone(),
        )
        .expect("apply");
        assert!(result.success, "apply: {}", result.message);
    }

    #[test]
    fn absent_default_data_folder_is_valid() {
        with_isolated_settings("absent-default-home", |_| {
            let default = default_installed_workspace_path().expect("default path");
            assert!(!default.exists());

            assert_eq!(workspace_root().expect("fresh profile"), default);
            let diagnostics = get_workspace_diagnostics().expect("diagnostics");
            assert!(diagnostics.valid, "{:?}", diagnostics.error);
            assert_eq!(diagnostics.error, None);
            assert_eq!(
                diagnostics.resolved_path.as_deref(),
                Some(default.to_string_lossy().as_ref())
            );
            assert!(
                !default.exists(),
                "reading validity must not create the folder"
            );

            // An empty default folder needs no bundled copies either.
            mkdir(&default, "");
            assert!(get_workspace_diagnostics().expect("diagnostics").valid);

            fs::remove_dir(&default).expect("remove folder");
            fs::write(&default, "x").expect("file in place of the folder");
            let diagnostics = get_workspace_diagnostics().expect("diagnostics");
            assert!(!diagnostics.valid);
            assert_eq!(diagnostics.error.as_deref(), Some("not a folder"));
            let error = workspace_root().expect_err("a file is not a data folder");
            assert!(error.contains("invalid workspace path"), "{error}");
        });
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_data_folder_is_invalid() {
        with_isolated_settings("symlinked-folder-home", |home| {
            let real = home.join("real-folder");
            write_file(&real, ".agent-workspace/managed-state.json", "{}");
            let default = default_installed_workspace_path().expect("default path");
            std::os::unix::fs::symlink(&real, &default).expect("link the default folder");

            let error = workspace_root().expect_err("a linked default folder is unusable");
            assert!(error.contains("invalid workspace path"), "{error}");
            assert!(error.contains("symlink"), "{error}");
            let diagnostics = get_workspace_diagnostics().expect("diagnostics");
            assert!(!diagnostics.valid);
            assert_eq!(
                diagnostics.error.as_deref(),
                Some("the folder is a symlink")
            );

            let link = home.join("linked-custom");
            std::os::unix::fs::symlink(&real, &link).expect("link a custom folder");
            assert!(!persisted_workspace_path_is_valid(&link.to_string_lossy()));
            assert!(persisted_workspace_path_is_valid(&real.to_string_lossy()));

            unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", &link) };
            let error = workspace_root().expect_err("a linked env folder is unusable");
            assert!(error.contains("symlink"), "{error}");
        });
    }

    #[test]
    fn env_data_folder_must_exist_and_needs_no_bundled_copies() {
        with_isolated_settings("env-folder-home", |home| {
            let folder = home.join("env-folder");
            unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", &folder) };
            let error = workspace_root().expect_err("an env folder that does not exist");
            assert!(error.contains("folder not found"), "{error}");

            mkdir(&folder, "");
            assert_eq!(
                workspace_root().expect("an existing env folder"),
                folder.canonicalize().expect("canonical folder")
            );
        });
    }

    #[test]
    fn custom_folder_with_only_managed_state_is_valid_and_kept() {
        with_isolated_settings("state-only-home", |home| {
            let custom = home.join("state-only");
            write_file(&custom, ".agent-workspace/managed-state.json", "{}");
            let saved = canonical_string(&custom);
            save_workspace_path(&saved);

            let response = crate::commands::get_settings().expect("get_settings");
            assert_eq!(
                response.settings.workspace_path.as_deref(),
                Some(saved.as_str())
            );
            let settings = crate::settings::load();
            assert_eq!(settings.workspace_path.as_deref(), Some(saved.as_str()));
            assert_eq!(
                configured_workspace_path(&settings),
                Some(PathBuf::from(&saved))
            );
            assert!(get_workspace_diagnostics().expect("diagnostics").valid);
        });
    }

    #[test]
    fn custom_folder_without_app_state_is_not_used() {
        with_isolated_settings("no-state-home", |home| {
            let custom = home.join("no-state");
            write_file(&custom, "notes.md", "# mine\n");
            let saved = canonical_string(&custom);
            assert!(!persisted_workspace_path_is_valid(&saved));
            save_workspace_path(&saved);

            assert_eq!(
                configured_workspace_path(&crate::settings::load()),
                Some(default_installed_workspace_path().expect("default path"))
            );
            let response = crate::commands::get_settings().expect("get_settings");
            assert_eq!(response.settings.workspace_path, None);
            assert!(
                custom.join("notes.md").is_file(),
                "the folder itself is left alone"
            );
        });
    }

    /// The hazard the data-folder rule removes: a saved custom folder used to be dropped from the
    /// settings, with its ownership records, as soon as a bundled copy in it went missing.
    #[test]
    fn custom_folder_stays_configured_when_bundled_copies_are_deleted() {
        with_isolated_settings("custom-copies-deleted-home", |home| {
            let custom = home.join("my-workspace");
            unsafe { std::env::set_var("AGENT_WORKSPACE_PATH", &custom) };
            install(&["workspace_bundle", "claude_agents"]);
            unsafe { std::env::remove_var("AGENT_WORKSPACE_PATH") };
            let records = read_managed_state(&custom).expect("records after install");
            assert!(records
                .artifacts
                .iter()
                .any(|record| record.identity.starts_with("workspace:file:")));
            assert!(records
                .artifacts
                .iter()
                .any(|record| record.surface.as_deref() == Some("claude_agents")));

            let saved = try_set_active_workspace_path(custom.to_string_lossy().into_owned())
                .expect("choose the custom folder")
                .workspace_path
                .expect("saved custom path");
            assert_eq!(saved, canonical_string(&custom));

            // Every bundled copy goes, the workspace marker included; the records stay.
            let raw = fs::read(managed_state_path(&custom)).expect("read records");
            fs::remove_dir_all(&custom).expect("delete the copies");
            fs::create_dir_all(custom.join(".agent-workspace")).expect("state folder");
            fs::write(managed_state_path(&custom), &raw).expect("restore records");
            assert_eq!(entries(&custom), [".agent-workspace"]);

            let response = crate::commands::get_settings().expect("get_settings");
            assert_eq!(
                response.settings.workspace_path.as_deref(),
                Some(saved.as_str())
            );
            assert_eq!(
                crate::settings::load().workspace_path.as_deref(),
                Some(saved.as_str())
            );
            let saved_path = PathBuf::from(&saved);
            assert_eq!(
                configured_workspace_path(&crate::settings::load()),
                Some(saved_path.clone())
            );
            assert_eq!(setup_workspace_target_path().expect("target"), saved_path);
            assert!(get_workspace_diagnostics().expect("diagnostics").valid);
            assert_eq!(read_managed_state(&saved_path), Some(records));
        });
    }

    #[test]
    fn fresh_profile_installs_a_harness_without_a_workspace_copy() {
        with_isolated_settings("fresh-harness-home", |home| {
            let default = default_installed_workspace_path().expect("default path");
            assert!(!default.exists());

            install(&["claude_agents"]);

            assert!(managed_state_path(&default).is_file());
            assert_eq!(entries(&default), [".agent-workspace"]);
            #[cfg(unix)]
            assert_eq!(mode(&default), 0o700, "the data folder is owner-only");
            let state = read_managed_state(&default).expect("records");
            assert!(state
                .artifacts
                .iter()
                .any(|record| record.surface.as_deref() == Some("claude_agents")));
            assert!(!state
                .artifacts
                .iter()
                .any(|record| record.identity.starts_with("workspace:file:")));
            assert!(home.join(".claude/agents").is_dir());
        });
    }

    #[test]
    fn first_personal_doc_creates_the_data_folder_owner_only() {
        with_isolated_settings("fresh-doc-home", |_| {
            let default = default_installed_workspace_path().expect("default path");
            assert!(!default.exists());

            crate::commands::create_doc("Notes".into(), "notes".into(), None)
                .expect("create a personal doc");

            assert!(default.join("docs/context/notes.md").is_file());
            #[cfg(unix)]
            assert_eq!(mode(&default), 0o700, "the data folder is owner-only");
        });
    }

    #[test]
    fn launch_reads_never_create_the_data_folder() {
        with_isolated_settings("launch-reads-home", |_| {
            let default = default_installed_workspace_path().expect("default path");
            // What the app reads at launch and on a refresh, and a review; the results do not
            // matter here, only that none of them writes the data folder.
            let _ = crate::commands::get_settings();
            let _ = get_workspace_diagnostics();
            let _ = crate::commands::get_status();
            let _ = crate::commands::get_installation_status(Vec::new());
            let _ = crate::commands::list_docs();
            let _ = crate::commands::list_skills();
            let _ = crate::commands::list_rules_files();
            let _ = crate::commands::get_effective_skill_loads();
            let _ = crate::commands::get_claude_runtime_health();
            let _ = crate::commands::get_codex_runtime_health();
            let _ = crate::commands::get_cursor_profile_health();
            let _ = crate::commands::list_backups();
            let _ = crate::commands::preview_setup(vec!["claude_agents".to_string()]);
            assert!(
                fs::symlink_metadata(&default).is_err(),
                "a read created {}",
                default.display()
            );
        });
    }

    #[test]
    fn open_folder_reports_a_data_folder_not_created_yet() {
        with_isolated_settings("open-absent-home", |_| {
            let error = open_default_workspace_folder().expect_err("nothing to open yet");
            assert!(error.contains("not created yet"), "{error}");
        });
    }

    #[test]
    fn workspace_root_prefers_agent_workspace_path_override() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let target = setup_used_folder("root-override");
        std::env::set_var("AGENT_WORKSPACE_PATH", &target);
        let resolved = workspace_root().expect("resolve the env folder");
        assert_eq!(resolved, target.canonicalize().expect("canonical target"));
        cleanup(&target);
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
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
            last_seen_version: None,
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
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
            last_seen_version: None,
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
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
            last_seen_version: None,
        };

        assert!(scrub_stale_workspace_path(&mut settings));
        assert_eq!(settings.workspace_path, None);
    }

    #[test]
    fn scrub_stale_workspace_path_keeps_a_used_folder() {
        let root = setup_used_folder("scrub-valid");
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
            revision: 0,
            target_defaults_version: crate::settings::TARGET_DEFAULTS_VERSION,
            last_seen_version: None,
        };

        assert!(!scrub_stale_workspace_path(&mut settings));
        assert!(settings.workspace_path.is_some());
        assert!(persisted_workspace_path_is_valid(
            settings.workspace_path.as_ref().expect("path")
        ));
        cleanup(&root);
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
    fn try_set_active_workspace_path_names_what_is_missing() {
        let empty = temp_root("activate-empty");
        mkdir(&empty, "");
        let path = empty.to_string_lossy().into_owned();
        let error = try_set_active_workspace_path(path).expect_err("empty folder is invalid");
        cleanup(&empty);

        assert!(error.contains("invalid workspace path"), "{error}");
        assert!(
            error.contains("(missing .agent-workspace/workspace.json or managed-state.json)"),
            "{error}"
        );
    }

    #[test]
    fn try_set_active_workspace_path_persists_a_used_folder_and_reset_clears_it() {
        with_isolated_settings("activate-persist-home", |_| {
            let root = setup_used_folder("activate-persist");
            let saved = try_set_active_workspace_path(root.to_string_lossy().into_owned())
                .expect("a used folder activates");
            let canonical = canonical_string(&root);
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
            write_file(&default, ".agent-workspace/workspace.json", "{}");

            let saved = try_set_active_workspace_path(default.to_string_lossy().into_owned())
                .expect("default workspace activates");
            assert_eq!(saved.workspace_path, None);
        });
    }

    #[test]
    fn workspace_choice_is_refused_while_the_env_override_is_set() {
        with_isolated_settings("activate-env-home", |_| {
            let root = setup_used_folder("activate-env");
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
}
