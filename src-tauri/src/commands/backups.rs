use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use super::process::{open_path, ActionResult};
use super::workspace::path_arg;

const ALLOWED_TARGET_IDS: &[&str] = &[
    "codex-rules",
    "opencode-rules",
    "claude-rules",
    "opencode-config",
    "opencode-agents",
    "codex-agents",
    "claude-agents",
    "codex-config",
    "cursor-agents",
    "cursor-rules",
    "cursor-mcp",
    "cursor-permissions",
    "playwright-mcp",
    "codex",
    "opencode",
    "claude",
];

/// Skill backups written by the retired `install-skills.sh` CLI: `<run>/<agent>-skills/<skill>/SKILL.md`.
/// One level deeper than the other targets, and the backup does not record whether it came
/// from a global or a project install, so no current file is compared.
const SKILL_TARGET_IDS: &[&str] = &[
    "codex-skills",
    "opencode-skills",
    "claude-skills",
    "cursor-skills",
];

/// Targets whose current location is a directory holding one file per backup file.
/// `opencode-config` and `codex-config` hold several config files (`opencode.json`,
/// `tui.json`, `config.toml`) under one id.
const DIRECTORY_TARGET_IDS: &[&str] = &[
    "opencode-agents",
    "codex-agents",
    "claude-agents",
    "cursor-agents",
    "cursor-rules",
    "opencode-config",
    "codex-config",
];

const BACKUP_FILE_LIMIT: usize = 50;
const BACKUP_RUN_LIMIT: usize = 20;
const MAX_COMPARE_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB
const MAX_BACKUP_TREE_DEPTH: usize = 8;
const SETUP_RUNS_DIR: &str = "setup";
const DOCS_RUNS_DIR: &str = "docs";

#[derive(serde::Serialize)]
pub struct BackupRunSummary {
    id: String,
    timestamp: String,
    path: String,
    targets: Vec<String>,
    file_count: usize,
}

#[derive(serde::Serialize)]
pub struct BackupFileSummary {
    target_id: String,
    filename: String,
    backup_path: String,
    backup_size: u64,
    current_path: String,
    current_exists: bool,
    current_status: String,
}

#[derive(serde::Serialize)]
pub struct BackupRunDetails {
    id: String,
    timestamp: String,
    path: String,
    files: Vec<BackupFileSummary>,
}

pub(crate) fn backup_root() -> Result<PathBuf, String> {
    let default_root = crate::platform_paths::backup_root_path(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )?;
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )?;

    let root = if let Some((variable, env_override)) = crate::env_overrides::backup_dir_override() {
        let trimmed = env_override.trim().to_string();
        if trimmed.is_empty() {
            return Err(format!("{variable} is set but empty"));
        }
        PathBuf::from(&trimmed)
    } else {
        default_root
    };

    let platform = crate::platform_paths::Platform::current();
    crate::platform_paths::reject_broad_write_root(&root, &home, platform, "backup")?;

    if root.exists() {
        let canonical = root
            .canonicalize()
            .map_err(|e| format!("cannot resolve backup root: {}", e))?;
        let canonical_str = canonical.to_string_lossy();

        let deny = ["/", "/Users", "/home", "/tmp"];
        for d in &deny {
            let d_path = PathBuf::from(d);
            if let Ok(d_canon) = d_path.canonicalize() {
                let dc = d_canon.to_string_lossy();
                if canonical_str == dc.as_ref() || canonical_str == format!("{}/", dc) {
                    return Err(format!(
                        "refusing broad backup directory: {}",
                        canonical_str
                    ));
                }
            }
        }

        if let Ok(home_canon) = PathBuf::from(&home).canonicalize() {
            let hc = home_canon.to_string_lossy();
            if canonical_str == hc.as_ref() || canonical_str == format!("{}/", hc) {
                return Err(format!(
                    "refusing broad backup directory: {}",
                    canonical_str
                ));
            }
        }
    }

    Ok(root)
}

fn prepare_backup_root_for_open() -> Result<PathBuf, String> {
    let root = backup_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create backup directory: {}", e))?;
    if !root.is_dir() {
        return Err("backup path is not a directory".to_string());
    }
    Ok(root)
}

fn is_timestamp_dir(name: &str) -> bool {
    if name.len() != 15 {
        return false;
    }
    let bytes = name.as_bytes();
    for b in bytes.iter().take(8) {
        if !b.is_ascii_digit() {
            return false;
        }
    }
    if bytes[8] != b'-' {
        return false;
    }
    for b in bytes.iter().skip(9).take(6) {
        if !b.is_ascii_digit() {
            return false;
        }
    }
    true
}

/// The three backup layouts under the backup root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunKind {
    /// `<root>/YYYYMMDD-HHMMSS/<target id>/<file>` written by the legacy scripts.
    Legacy,
    /// `<root>/setup/<transaction id>/artifacts/<artifact id>` written by managed installs.
    Setup,
    /// `<root>/docs/<doc id>-<nanos>/<file>` written by Library saves.
    Docs,
}

impl RunKind {
    fn id_prefix(self) -> &'static str {
        match self {
            RunKind::Legacy => "",
            RunKind::Setup => "setup:",
            RunKind::Docs => "docs:",
        }
    }

    fn run_dir(self, root: &Path, name: &str) -> PathBuf {
        match self {
            RunKind::Legacy => root.join(name),
            RunKind::Setup => root.join(SETUP_RUNS_DIR).join(name),
            RunKind::Docs => root.join(DOCS_RUNS_DIR).join(name),
        }
    }

    /// Directory holding the backed-up files of a run. A symlinked `artifacts`
    /// directory is not followed; the returned path is then one that does not exist.
    fn files_dir(self, run_dir: &Path) -> PathBuf {
        match self {
            RunKind::Setup => {
                let artifacts = run_dir.join("artifacts");
                let real_dir = std::fs::symlink_metadata(&artifacts)
                    .map(|m| m.is_dir())
                    .unwrap_or(false);
                if real_dir {
                    artifacts
                } else {
                    run_dir.join("artifacts-unavailable")
                }
            }
            RunKind::Legacy | RunKind::Docs => run_dir.to_path_buf(),
        }
    }
}

fn is_managed_run_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
}

/// Split a run id into its layout and directory name. Ids of managed runs carry
/// a `setup:` or `docs:` prefix; anything that could leave the layout is refused.
fn parse_run_id(run_id: &str) -> Option<(RunKind, &str)> {
    if let Some(name) = run_id.strip_prefix(RunKind::Setup.id_prefix()) {
        return is_managed_run_name(name).then_some((RunKind::Setup, name));
    }
    if let Some(name) = run_id.strip_prefix(RunKind::Docs.id_prefix()) {
        return is_managed_run_name(name).then_some((RunKind::Docs, name));
    }
    is_timestamp_dir(run_id).then_some((RunKind::Legacy, run_id))
}

fn resolve_current_target(target_id: &str) -> Result<PathBuf, String> {
    let home = crate::platform_paths::resolve_user_home(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )?;
    // OpenCode's files are in its config folder, which moves with XDG_CONFIG_HOME.
    let opencode_dir = crate::platform_paths::opencode_config_dir(&home);
    match target_id {
        "opencode-rules" | "opencode" => return Ok(opencode_dir.join("AGENTS.md")),
        "opencode-config" => return Ok(opencode_dir),
        "opencode-agents" => return Ok(opencode_dir.join("agents")),
        _ => {}
    }
    let rel = match target_id {
        "codex-rules" => ".codex/AGENTS.md",
        "claude-rules" => ".claude/CLAUDE.md",
        "claude-agents" => ".claude/agents",
        "codex-agents" => ".codex/agents",
        "codex-config" => ".codex",
        "cursor-agents" => ".cursor/agents",
        "cursor-rules" => ".cursor/rules",
        "cursor-mcp" => ".cursor/mcp.json",
        "cursor-permissions" => ".cursor/permissions.json",
        "playwright-mcp" => ".config/playwright-mcp/config.json",
        // Legacy backwards-compatible IDs (read-only)
        "codex" => ".codex/AGENTS.md",
        "claude" => ".claude/CLAUDE.md",
        _ => return Err(format!("unknown backup target id: {}", target_id)),
    };
    Ok(home.join(rel))
}

fn compare_files_match(a: &Path, b: &Path) -> Result<bool, String> {
    let fa = std::fs::File::open(a).map_err(|e| format!("cannot open for compare: {}", e))?;
    let fb = std::fs::File::open(b).map_err(|e| format!("cannot open for compare: {}", e))?;
    let mut ra = BufReader::with_capacity(8192, fa);
    let mut rb = BufReader::with_capacity(8192, fb);
    let mut buf_a = [0u8; 8192];
    let mut buf_b = [0u8; 8192];
    loop {
        let na = ra
            .read(&mut buf_a)
            .map_err(|e| format!("read error: {}", e))?;
        let nb = rb
            .read(&mut buf_b)
            .map_err(|e| format!("read error: {}", e))?;
        if na != nb || buf_a[..na] != buf_b[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

/// One backed-up regular file below a run's files directory.
struct BackupEntry {
    /// Path relative to the files directory, `/`-separated.
    relative: String,
    path: PathBuf,
    size: u64,
}

/// Regular files below `dir`, skipping symlinks and dotfiles. Bounded by depth and `limit`.
fn collect_backup_entries(
    dir: &Path,
    prefix: &str,
    depth: usize,
    limit: usize,
    out: &mut Vec<BackupEntry>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(|entry| entry.ok()).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if out.len() >= limit {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if file_type.is_symlink() || name.starts_with('.') {
            continue;
        }
        if file_type.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(BackupEntry {
                relative: format!("{prefix}{name}"),
                path: entry.path(),
                size,
            });
        } else if file_type.is_dir() && depth < MAX_BACKUP_TREE_DEPTH {
            collect_backup_entries(
                &entry.path(),
                &format!("{prefix}{name}/"),
                depth + 1,
                limit,
                out,
            );
        }
    }
}

fn legacy_run_summary(run_path: &Path, name: &str) -> Option<BackupRunSummary> {
    let mut targets: Vec<String> = Vec::new();
    let mut file_count: usize = 0;

    for target_id in ALLOWED_TARGET_IDS {
        let target_dir = run_path.join(target_id);
        let is_real_dir = std::fs::symlink_metadata(&target_dir)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_real_dir {
            targets.push(target_id.to_string());
            if let Ok(target_entries) = std::fs::read_dir(&target_dir) {
                file_count += target_entries
                    .filter_map(|te| te.ok())
                    .filter(|te| te.file_type().map(|ft| ft.is_file()).unwrap_or(false))
                    .count();
            }
        }
    }

    for target_id in SKILL_TARGET_IDS {
        let target_dir = run_path.join(target_id);
        let is_real_dir = std::fs::symlink_metadata(&target_dir)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if !is_real_dir {
            continue;
        }
        let mut entries = Vec::new();
        collect_backup_entries(&target_dir, "", 0, usize::MAX, &mut entries);
        if !entries.is_empty() {
            targets.push(target_id.to_string());
            file_count += entries.len();
        }
    }

    (file_count > 0).then(|| BackupRunSummary {
        id: name.to_string(),
        timestamp: name.to_string(),
        path: run_path.to_string_lossy().into_owned(),
        targets,
        file_count,
    })
}

fn managed_run_summary(kind: RunKind, run_path: &Path, name: &str) -> Option<BackupRunSummary> {
    let mut entries = Vec::new();
    collect_backup_entries(&kind.files_dir(run_path), "", 0, usize::MAX, &mut entries);
    if entries.is_empty() {
        return None;
    }
    let mut targets: Vec<String> = match kind {
        RunKind::Setup => entries
            .iter()
            .map(|entry| first_component(&entry.relative).to_string())
            .collect(),
        RunKind::Docs | RunKind::Legacy => vec![DOCS_RUNS_DIR.to_string()],
    };
    targets.dedup();
    Some(BackupRunSummary {
        id: format!("{}{name}", kind.id_prefix()),
        timestamp: name.to_string(),
        path: run_path.to_string_lossy().into_owned(),
        targets,
        file_count: entries.len(),
    })
}

pub(super) fn setup_backup_file_count(run_path: &Path) -> usize {
    let mut entries = Vec::new();
    collect_backup_entries(
        &RunKind::Setup.files_dir(run_path),
        "",
        0,
        usize::MAX,
        &mut entries,
    );
    entries.len()
}

/// Files of a managed run. The artifact a file belongs to is not mapped back to
/// its current location, so the comparison status is `unknown`.
fn managed_run_files(kind: RunKind, run_path: &Path) -> Vec<BackupFileSummary> {
    let mut entries = Vec::new();
    collect_backup_entries(
        &kind.files_dir(run_path),
        "",
        0,
        BACKUP_FILE_LIMIT,
        &mut entries,
    );
    entries
        .into_iter()
        .map(|entry| {
            let (target_id, filename) = match (kind, entry.relative.split_once('/')) {
                (RunKind::Setup, Some((target, rest))) => (target.to_string(), rest.to_string()),
                (RunKind::Setup, None) => (entry.relative.clone(), entry.relative.clone()),
                _ => (DOCS_RUNS_DIR.to_string(), entry.relative.clone()),
            };
            BackupFileSummary {
                target_id,
                filename,
                backup_path: entry.path.to_string_lossy().into_owned(),
                backup_size: entry.size,
                current_path: String::new(),
                current_exists: false,
                current_status: "unknown".to_string(),
            }
        })
        .collect()
}

fn first_component(relative: &str) -> &str {
    relative.split('/').next().unwrap_or(relative)
}

/// Real (non-symlink) directories directly below `dir`, newest first.
fn child_run_dirs(dir: &Path) -> Vec<(std::time::SystemTime, String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let metadata = std::fs::symlink_metadata(entry.path()).ok()?;
            if !metadata.is_dir() {
                return None;
            }
            let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
            Some((
                modified,
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ))
        })
        .collect()
}

pub(crate) fn list_backups_from_root(root: &Path) -> Result<Vec<BackupRunSummary>, String> {
    if !root.exists() || !root.is_dir() {
        return Ok(Vec::new());
    }
    // Make sure the root itself is readable so a permission problem is reported.
    std::fs::read_dir(root).map_err(|e| format!("cannot read backup directory: {}", e))?;

    let mut candidates: Vec<(std::time::SystemTime, RunKind, String, PathBuf)> = Vec::new();
    for (modified, name, path) in child_run_dirs(root) {
        if is_timestamp_dir(&name) {
            candidates.push((modified, RunKind::Legacy, name, path));
        }
    }
    for (kind, dir_name) in [
        (RunKind::Setup, SETUP_RUNS_DIR),
        (RunKind::Docs, DOCS_RUNS_DIR),
    ] {
        let layout_dir = root.join(dir_name);
        let is_real_dir = std::fs::symlink_metadata(&layout_dir)
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if !is_real_dir {
            continue;
        }
        for (modified, name, path) in child_run_dirs(&layout_dir) {
            if is_managed_run_name(&name) {
                candidates.push((modified, kind, name, path));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.2.cmp(&a.2)));

    let mut runs: Vec<BackupRunSummary> = Vec::new();
    for (_, kind, name, path) in candidates {
        let summary = match kind {
            RunKind::Legacy => legacy_run_summary(&path, &name),
            RunKind::Setup | RunKind::Docs => managed_run_summary(kind, &path, &name),
        };
        runs.extend(summary);
        if runs.len() >= BACKUP_RUN_LIMIT {
            break;
        }
    }
    Ok(runs)
}

#[tauri::command]
pub fn list_backups() -> Result<Vec<BackupRunSummary>, String> {
    list_backups_from_root(&backup_root()?)
}

#[tauri::command]
pub fn open_backups_folder() -> Result<ActionResult, String> {
    let root = prepare_backup_root_for_open()?;
    let path_str = path_arg(&root)?;
    let (success, stdout, stderr, code) = open_path(&path_str, &root);

    Ok(ActionResult::new(
        success,
        "open_backups_folder",
        stdout,
        stderr,
        code,
    ))
}

fn get_backup_details_from_root(root: &Path, run_id: &str) -> Result<BackupRunDetails, String> {
    let Some((kind, run_name)) = parse_run_id(run_id) else {
        return Err("invalid run id: must be YYYYMMDD-HHMMSS, setup:<id> or docs:<id>".to_string());
    };

    if !root.exists() || !root.is_dir() {
        return Err("backup directory does not exist".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve backup root: {}", e))?;

    let run_path = kind.run_dir(&canonical_root, run_name);
    if !run_path.exists() || !run_path.is_dir() {
        return Err(format!("backup run not found: {}", run_id));
    }

    let canonical_run = run_path
        .canonicalize()
        .map_err(|e| format!("cannot resolve run path: {}", e))?;

    if canonical_run != canonical_root && !canonical_run.starts_with(&canonical_root) {
        return Err("run directory is outside backup root".to_string());
    }

    let mut files: Vec<BackupFileSummary> = Vec::new();

    // Only the legacy layout maps to script target ids; managed runs are listed below.
    let legacy_target_ids: &[&str] = if kind == RunKind::Legacy {
        ALLOWED_TARGET_IDS
    } else {
        &[]
    };
    for target_id in legacy_target_ids {
        let target_dir = canonical_run.join(target_id);
        let meta = match std::fs::symlink_metadata(&target_dir) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }

        let entries = match std::fs::read_dir(&target_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if !ft.is_file() || ft.is_symlink() {
                continue;
            }
            let backup_path = entry.path();
            let backup_meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let backup_size = backup_meta.len();
            let filename = entry.file_name().to_string_lossy().into_owned();
            if filename.starts_with('.') {
                continue;
            }

            let (current_path, current_exists, current_status) =
                match resolve_current_target(target_id) {
                    Ok(cp) => {
                        // For directory targets (the agents directories), resolve each
                        // backup file to its matching runtime file by joining
                        // the filename onto the target directory path.
                        let cp_file = if DIRECTORY_TARGET_IDS.contains(target_id) {
                            cp.join(&filename)
                        } else {
                            cp
                        };
                        let exists = cp_file.exists() && cp_file.is_file();
                        let status = if !exists {
                            "missing".to_string()
                        } else {
                            let current_meta = std::fs::metadata(&cp_file);
                            match current_meta {
                                Ok(cm) => {
                                    let cs = cm.len();
                                    if cs != backup_size {
                                        "differs".to_string()
                                    } else if cs > MAX_COMPARE_SIZE {
                                        "unknown".to_string()
                                    } else {
                                        match compare_files_match(&backup_path, &cp_file) {
                                            Ok(true) => "matches".to_string(),
                                            Ok(false) => "differs".to_string(),
                                            Err(_) => "unknown".to_string(),
                                        }
                                    }
                                }
                                Err(_) => "unknown".to_string(),
                            }
                        };
                        (cp_file.to_string_lossy().into_owned(), exists, status)
                    }
                    Err(_) => (String::new(), false, "unknown".to_string()),
                };

            files.push(BackupFileSummary {
                target_id: target_id.to_string(),
                filename,
                backup_path: backup_path.to_string_lossy().into_owned(),
                backup_size,
                current_path,
                current_exists,
                current_status,
            });

            if files.len() >= BACKUP_FILE_LIMIT {
                break;
            }
        }
        if files.len() >= BACKUP_FILE_LIMIT {
            break;
        }
    }

    if kind == RunKind::Legacy {
        for target_id in SKILL_TARGET_IDS {
            let target_dir = canonical_run.join(target_id);
            let is_real_dir = std::fs::symlink_metadata(&target_dir)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if !is_real_dir || files.len() >= BACKUP_FILE_LIMIT {
                continue;
            }
            let mut entries = Vec::new();
            collect_backup_entries(
                &target_dir,
                "",
                0,
                BACKUP_FILE_LIMIT - files.len(),
                &mut entries,
            );
            files.extend(entries.into_iter().map(|entry| BackupFileSummary {
                target_id: target_id.to_string(),
                filename: entry.relative,
                backup_path: entry.path.to_string_lossy().into_owned(),
                backup_size: entry.size,
                current_path: String::new(),
                current_exists: false,
                current_status: "unknown".to_string(),
            }));
        }
    } else {
        files = managed_run_files(kind, &canonical_run);
    }

    files.sort_by(|a, b| {
        a.target_id
            .cmp(&b.target_id)
            .then_with(|| a.filename.cmp(&b.filename))
    });

    Ok(BackupRunDetails {
        id: run_id.to_string(),
        timestamp: run_name.to_string(),
        path: canonical_run.to_string_lossy().into_owned(),
        files,
    })
}

#[tauri::command]
pub fn get_backup_details(run_id: String) -> Result<BackupRunDetails, String> {
    let root = backup_root()?;
    get_backup_details_from_root(&root, &run_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("riggverk-backups-{name}-{nonce}"))
    }

    #[test]
    fn timestamp_exact_15_chars() {
        assert!(is_timestamp_dir("20260501-143000"));
    }

    #[test]
    fn timestamp_short_rejected() {
        assert!(!is_timestamp_dir("20260501-14300"));
        assert!(!is_timestamp_dir("20260501"));
        assert!(!is_timestamp_dir(""));
    }

    #[test]
    fn timestamp_long_rejected() {
        assert!(!is_timestamp_dir("20260501-1430000"));
        assert!(!is_timestamp_dir("20260501-143000-extra"));
    }

    #[test]
    fn timestamp_wrong_format_rejected() {
        assert!(!is_timestamp_dir("2026-01-01-143000"));
        assert!(!is_timestamp_dir("abcdefgh-ijklmn"));
        assert!(!is_timestamp_dir("not-a-timestamp"));
        assert!(!is_timestamp_dir(".DS_Store"));
        assert!(!is_timestamp_dir("20260501_143000"));
        assert!(!is_timestamp_dir("20260501143000"));
    }

    #[test]
    fn timestamp_digit_checks() {
        assert!(!is_timestamp_dir("abcdefgh-143000"));
        assert!(!is_timestamp_dir("20260501-abcdef"));
        assert!(!is_timestamp_dir("20260501-14300a"));
        assert!(!is_timestamp_dir("2026050a-143000"));
    }

    #[test]
    fn timestamp_valid_range() {
        assert!(is_timestamp_dir("20240101-000000"));
        assert!(is_timestamp_dir("20991231-235959"));
    }

    #[test]
    fn run_id_slash_rejected() {
        assert!(!is_timestamp_dir("20260501/143000"));
        assert!(!is_timestamp_dir("20260501\\143000"));
    }

    #[test]
    fn run_id_dot_segment_rejected() {
        assert!(!is_timestamp_dir("..2026050114300"));
        assert!(!is_timestamp_dir("20260501-1430.."));
        assert!(!is_timestamp_dir("20260501..143000"));
    }

    #[test]
    fn resolve_current_target_known_ids() {
        let _env = crate::test_env::guard::default_xdg_config_home();
        let home = crate::test_env::process_home();
        for tid in ALLOWED_TARGET_IDS {
            let result = resolve_current_target(tid);
            assert!(result.is_ok(), "resolve_current_target failed for {}", tid);
            let path = result.unwrap();
            assert!(
                path.starts_with(&home),
                "path {} not under user home",
                path.display()
            );
        }
    }

    #[test]
    fn resolve_current_target_unknown_id() {
        assert!(resolve_current_target("unknown-target").is_err());
        assert!(resolve_current_target("").is_err());
    }

    #[test]
    fn compare_files_match_same_content() {
        let root = temp_root("same-content");
        fs::create_dir_all(&root).expect("create temp dir");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        let content = b"hello world\n";
        fs::write(&a, content).expect("write a");
        fs::write(&b, content).expect("write b");
        assert!(compare_files_match(&a, &b).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn compare_files_match_differs() {
        let root = temp_root("differs");
        fs::create_dir_all(&root).expect("create temp dir");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        fs::write(&a, b"hello\n").expect("write a");
        fs::write(&b, b"world\n").expect("write b");
        assert!(!compare_files_match(&a, &b).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prepare_backup_root_for_open_creates_missing_root() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let root = temp_root("open-create-root");
        let backup_root = root.join("backups");
        std::env::set_var(
            "RIGGVERK_BACKUP_DIR",
            backup_root.to_string_lossy().as_ref(),
        );

        let result = prepare_backup_root_for_open();

        assert!(result.is_ok(), "backup root should be created: {result:?}");
        assert!(backup_root.is_dir(), "backup root should exist");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_agents_backup_file_maps_to_correct_current_path() {
        let _guard = crate::test_env::guard::lock();
        let root = temp_root("agents-path-test");
        fs::create_dir_all(&root).expect("create backup root");
        let run_dir = root.join("20260501-143000");
        fs::create_dir_all(&run_dir).expect("create run dir");

        let agents_dir = run_dir.join("opencode-agents");
        fs::create_dir_all(&agents_dir).expect("create opencode-agents dir");
        fs::write(agents_dir.join("architect.md"), b"architect content")
            .expect("write architect.md");

        let result = get_backup_details_from_root(&root, "20260501-143000");
        assert!(result.is_ok());
        let details = result.unwrap();

        let architect = details
            .files
            .iter()
            .find(|f| f.filename == "architect.md" && f.target_id == "opencode-agents");
        assert!(
            architect.is_some(),
            "architect.md should be found in opencode-agents target"
        );

        let summary = architect.unwrap();
        let expected_current = resolve_current_target("opencode-agents")
            .expect("resolve opencode-agents target")
            .join("architect.md")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            summary.current_path, expected_current,
            "current_path should map backup file to runtime agents path"
        );
        // current_exists may be false in CI, but the path shape is what matters

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skill_backups_from_install_skills_are_listed_and_detailed() {
        let root = temp_root("skill-backups");
        let run_dir = root.join("20260501-143000");
        // Layout written by the retired install-skills.sh CLI: <ts>/<agent>-skills/<name>/SKILL.md.
        for (agent, skill) in [
            ("opencode", "diagnose"),
            ("opencode", "tdd"),
            ("codex", "diagnose"),
        ] {
            let dir = run_dir.join(format!("{agent}-skills")).join(skill);
            fs::create_dir_all(&dir).expect("create skill backup dir");
            fs::write(dir.join("SKILL.md"), b"old skill").expect("write skill backup");
        }
        // Hidden and symlinked entries stay invisible, like in the other layouts.
        fs::write(run_dir.join("opencode-skills/.DS_Store"), b"x").expect("write dotfile");

        let runs = list_backups_from_root(&root).expect("list backups");
        assert_eq!(runs.len(), 1, "a run holding only skill backups is listed");
        assert_eq!(runs[0].file_count, 3);
        assert!(runs[0].targets.contains(&"opencode-skills".to_string()));
        assert!(runs[0].targets.contains(&"codex-skills".to_string()));

        let details = get_backup_details_from_root(&root, "20260501-143000").expect("details");
        let mut files: Vec<(String, String)> = details
            .files
            .iter()
            .map(|f| (f.target_id.clone(), f.filename.clone()))
            .collect();
        files.sort();
        assert_eq!(
            files,
            vec![
                ("codex-skills".to_string(), "diagnose/SKILL.md".to_string()),
                (
                    "opencode-skills".to_string(),
                    "diagnose/SKILL.md".to_string()
                ),
                ("opencode-skills".to_string(), "tdd/SKILL.md".to_string()),
            ]
        );
        // The backup does not record the install scope, so no current file is claimed.
        assert!(details
            .files
            .iter()
            .all(|f| f.current_status == "unknown" && f.current_path.is_empty()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn get_backup_details_rejects_invalid_run_id() {
        let dummy_root = std::env::temp_dir();
        assert!(get_backup_details_from_root(&dummy_root, "bad-id").is_err());
        assert!(get_backup_details_from_root(&dummy_root, "20260501/143000").is_err());
        assert!(get_backup_details_from_root(&dummy_root, "20260501\\143000").is_err());
        assert!(get_backup_details_from_root(&dummy_root, "20260501..143000").is_err());
    }

    #[test]
    fn get_backup_details_ignores_unknown_target_dirs() {
        let root = temp_root("unknown-target-dir");
        fs::create_dir_all(&root).expect("create backup root");
        let run_dir = root.join("20260501-143000");
        fs::create_dir_all(&run_dir).expect("create run dir");

        let unknown_dir = run_dir.join("not-a-target");
        fs::create_dir_all(&unknown_dir).expect("create unknown dir");
        fs::write(unknown_dir.join("extra.md"), b"ignored").expect("write file");

        let codex_dir = run_dir.join("codex-rules");
        fs::create_dir_all(&codex_dir).expect("create codex-rules dir");
        fs::write(codex_dir.join("AGENTS.md"), b"test rules").expect("write file");

        let result = get_backup_details_from_root(&root, "20260501-143000");

        assert!(result.is_ok());
        let details = result.unwrap();
        assert_eq!(details.id, "20260501-143000");
        let file_targets: Vec<&str> = details.files.iter().map(|f| f.target_id.as_str()).collect();
        assert!(file_targets.contains(&"codex-rules"));
        assert!(!file_targets.contains(&"not-a-target"));

        let _ = fs::remove_dir_all(&root);
    }

    fn write_backup_file(path: &Path, content: &[u8]) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, content).expect("write backup file");
    }

    fn run_ids(runs: &[BackupRunSummary]) -> Vec<String> {
        let mut ids: Vec<String> = runs.iter().map(|run| run.id.clone()).collect();
        ids.sort();
        ids
    }

    #[test]
    fn list_backups_without_a_backup_directory_is_empty() {
        let root = temp_root("list-missing");
        assert!(list_backups_from_root(&root).expect("list").is_empty());
    }

    #[test]
    fn list_backups_counts_managed_setup_transactions() {
        let root = temp_root("list-setup");
        let txn = root.join("setup/1790000000000000000");
        write_backup_file(&txn.join("artifacts/codex-config"), b"model");
        write_backup_file(&txn.join("artifacts/workspace-file-docs__a.md"), b"doc");
        write_backup_file(
            &txn.join("artifacts/claude-skill-diagnose/SKILL.md"),
            b"skill",
        );
        write_backup_file(&txn.join("manifest.json"), b"{}");
        write_backup_file(&txn.join("managed-state.previous.json"), b"{}");
        // A fresh-install transaction backs nothing up and is not a backup run.
        write_backup_file(&root.join("setup/1790000000000000001/manifest.json"), b"{}");

        let runs = list_backups_from_root(&root).expect("list");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            run_ids(&runs),
            vec!["setup:1790000000000000000".to_string()]
        );
        let run = &runs[0];
        assert_eq!(run.timestamp, "1790000000000000000");
        assert_eq!(run.file_count, 3, "artifacts only, not manifests");
        assert_eq!(
            run.targets,
            vec![
                "claude-skill-diagnose".to_string(),
                "codex-config".to_string(),
                "workspace-file-docs__a.md".to_string(),
            ]
        );
    }

    #[test]
    fn list_backups_counts_library_save_backups() {
        let root = temp_root("list-docs");
        write_backup_file(
            &root.join("docs/custom_my-notes-1790000000000000000/notes.md"),
            b"old",
        );

        let runs = list_backups_from_root(&root).expect("list");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            run_ids(&runs),
            vec!["docs:custom_my-notes-1790000000000000000".to_string()]
        );
        assert_eq!(runs[0].targets, vec!["docs".to_string()]);
        assert_eq!(runs[0].file_count, 1);
    }

    #[test]
    fn list_backups_keeps_legacy_runs_next_to_managed_layouts() {
        let root = temp_root("list-mixed");
        write_backup_file(
            &root.join("20260501-143000/codex-rules/AGENTS.md"),
            b"rules",
        );
        write_backup_file(
            &root.join("setup/1790000000000000000/artifacts/codex-rules"),
            b"r",
        );
        write_backup_file(
            &root.join("docs/README.md-1790000000000000001/README.md"),
            b"d",
        );
        // Not backup runs: stray files and unknown directories.
        write_backup_file(&root.join("setup/.hidden/artifacts/x"), b"x");
        write_backup_file(&root.join("notes/artifacts/x"), b"x");
        write_backup_file(&root.join("stray.txt"), b"x");

        let runs = list_backups_from_root(&root).expect("list");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            run_ids(&runs),
            vec![
                "20260501-143000".to_string(),
                "docs:README.md-1790000000000000001".to_string(),
                "setup:1790000000000000000".to_string(),
            ]
        );
    }

    #[test]
    fn list_backups_caps_the_number_of_runs() {
        let root = temp_root("list-cap");
        for n in 0..(BACKUP_RUN_LIMIT + 5) {
            write_backup_file(
                &root.join(format!("setup/17900000000000000{n:02}/artifacts/a")),
                b"a",
            );
        }

        let runs = list_backups_from_root(&root).expect("list");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(runs.len(), BACKUP_RUN_LIMIT);
    }

    #[cfg(unix)]
    #[test]
    fn list_backups_does_not_follow_symlinked_layout_directories() {
        let root = temp_root("list-symlinks");
        let outside = temp_root("list-symlinks-outside");
        write_backup_file(&outside.join("1790000000000000000/artifacts/a"), b"a");
        fs::create_dir_all(&root).expect("create root");
        std::os::unix::fs::symlink(&outside, root.join("setup")).expect("symlink layout dir");
        // A symlinked run directory and a symlinked artifacts directory are skipped too.
        write_backup_file(&outside.join("run/artifacts/a"), b"a");
        fs::create_dir_all(root.join("docs")).expect("create docs");
        std::os::unix::fs::symlink(outside.join("run"), root.join("docs/linked-run"))
            .expect("symlink run");

        let runs = list_backups_from_root(&root).expect("list");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);

        assert!(runs.is_empty(), "{:?}", run_ids(&runs));
    }

    #[test]
    fn backup_details_for_a_setup_run_list_artifact_files() {
        let root = temp_root("details-setup");
        let txn = root.join("setup/1790000000000000000");
        write_backup_file(&txn.join("artifacts/codex-config"), b"model");
        write_backup_file(
            &txn.join("artifacts/claude-skill-diagnose/SKILL.md"),
            b"skill",
        );
        write_backup_file(&txn.join("manifest.json"), b"{}");

        let details =
            get_backup_details_from_root(&root, "setup:1790000000000000000").expect("details");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(details.id, "setup:1790000000000000000");
        let files: Vec<(&str, &str, &str)> = details
            .files
            .iter()
            .map(|f| {
                (
                    f.target_id.as_str(),
                    f.filename.as_str(),
                    f.current_status.as_str(),
                )
            })
            .collect();
        assert_eq!(
            files,
            vec![
                ("claude-skill-diagnose", "SKILL.md", "unknown"),
                ("codex-config", "codex-config", "unknown"),
            ]
        );
        assert_eq!(details.files[1].backup_size, 5);
    }

    #[test]
    fn backup_details_for_a_docs_run_list_the_saved_file() {
        let root = temp_root("details-docs");
        write_backup_file(
            &root.join("docs/README.md-1790000000000000000/README.md"),
            b"old",
        );

        let details = get_backup_details_from_root(&root, "docs:README.md-1790000000000000000")
            .expect("details");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].target_id, "docs");
        assert_eq!(details.files[0].filename, "README.md");
    }

    #[test]
    fn backup_details_reject_ids_that_leave_the_layout() {
        let root = temp_root("details-traversal");
        fs::create_dir_all(root.join("setup")).expect("create setup");
        fs::create_dir_all(root.join("outside")).expect("create outside");
        for id in [
            "setup:../outside",
            "setup:..",
            "setup:a/b",
            "setup:a\\b",
            "setup:.hidden",
            "setup:",
            "docs:../outside",
            "docs:",
            "setup:x:y",
            "other:123",
        ] {
            let err = get_backup_details_from_root(&root, id)
                .err()
                .unwrap_or_else(|| panic!("{id} must be rejected"));
            assert!(err.contains("invalid run id"), "{id}: {err}");
        }
        let err = get_backup_details_from_root(&root, "setup:404")
            .err()
            .expect("unknown run must be an error");
        assert!(err.contains("backup run not found"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn backup_details_do_not_follow_a_symlinked_artifacts_directory() {
        let root = temp_root("details-symlinked-artifacts");
        let outside = temp_root("details-symlinked-artifacts-outside");
        write_backup_file(&outside.join("secret"), b"secret");
        fs::create_dir_all(root.join("setup/1790000000000000000")).expect("create run");
        std::os::unix::fs::symlink(&outside, root.join("setup/1790000000000000000/artifacts"))
            .expect("symlink artifacts");

        let details =
            get_backup_details_from_root(&root, "setup:1790000000000000000").expect("details");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);

        assert!(details.files.is_empty());
    }

    #[test]
    fn script_written_backup_targets_are_listed_with_their_current_files() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_root("script-targets-home");
        fs::create_dir_all(&home).expect("create home");
        crate::test_env::set_test_user_dirs(&home);

        let root = temp_root("script-targets");
        let run = root.join("20260501-143000");
        // Every backup id the install scripts and Cursor profile code write.
        let cases = [
            ("codex-config", "config.toml", ".codex/config.toml"),
            (
                "opencode-config",
                "opencode.json",
                ".config/opencode/opencode.json",
            ),
            ("opencode-config", "tui.json", ".config/opencode/tui.json"),
            ("cursor-agents", "scout.md", ".cursor/agents/scout.md"),
            ("cursor-rules", "krets.mdc", ".cursor/rules/krets.mdc"),
            ("cursor-mcp", "mcp.json", ".cursor/mcp.json"),
            (
                "cursor-permissions",
                "permissions.json",
                ".cursor/permissions.json",
            ),
            (
                "playwright-mcp",
                "config.json",
                ".config/playwright-mcp/config.json",
            ),
        ];
        for (target, name, current) in cases {
            write_backup_file(&run.join(target).join(name), b"backed up");
            write_backup_file(&home.join(current), b"backed up");
        }

        let runs = list_backups_from_root(&root).expect("list");
        let details = get_backup_details_from_root(&root, "20260501-143000").expect("details");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);

        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].file_count, cases.len());
        assert_eq!(details.files.len(), cases.len());
        for (target, name, current) in cases {
            let file = details
                .files
                .iter()
                .find(|f| f.target_id == target && f.filename == name)
                .unwrap_or_else(|| panic!("{target}/{name} missing from details"));
            assert_eq!(file.current_status, "matches", "{target}/{name}");
            assert!(
                PathBuf::from(&file.current_path).ends_with(current),
                "{target}/{name}: {}",
                file.current_path
            );
        }
    }

    #[test]
    fn directory_targets_resolve_each_backup_file_to_its_current_file() {
        let _guard = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::EnvRestore::capture();
        let home = temp_root("dir-targets-home");
        fs::create_dir_all(&home).expect("create home");
        crate::test_env::set_test_user_dirs(&home);

        let root = temp_root("dir-targets");
        let run = root.join("20260501-143000");
        for (target, agent_dir, name) in [
            ("opencode-agents", ".config/opencode/agents", "architect.md"),
            ("codex-agents", ".codex/agents", "repo_scout.toml"),
            ("claude-agents", ".claude/agents", "inspector.md"),
        ] {
            write_backup_file(&run.join(target).join(name), b"backed up");
            write_backup_file(&home.join(agent_dir).join(name), b"backed up");
        }
        // One directory target whose current file has changed, one that is gone.
        write_backup_file(&run.join("claude-agents/changed.md"), b"before");
        write_backup_file(&home.join(".claude/agents/changed.md"), b"after!");
        write_backup_file(&run.join("codex-agents/gone.toml"), b"before");

        let details = get_backup_details_from_root(&root, "20260501-143000").expect("details");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&home);

        let find = |target: &str, name: &str| {
            details
                .files
                .iter()
                .find(|f| f.target_id == target && f.filename == name)
                .unwrap_or_else(|| panic!("{target}/{name} missing from details"))
        };
        for (target, agent_dir, name) in [
            ("opencode-agents", ".config/opencode/agents", "architect.md"),
            ("codex-agents", ".codex/agents", "repo_scout.toml"),
            ("claude-agents", ".claude/agents", "inspector.md"),
        ] {
            let file = find(target, name);
            assert_eq!(file.current_status, "matches", "{target}/{name}");
            assert!(file.current_exists, "{target}/{name}");
            assert!(
                PathBuf::from(&file.current_path).ends_with(Path::new(agent_dir).join(name)),
                "{target}: {}",
                file.current_path
            );
        }
        assert_eq!(
            find("claude-agents", "changed.md").current_status,
            "differs"
        );
        let gone = find("codex-agents", "gone.toml");
        assert_eq!(gone.current_status, "missing");
        assert!(
            PathBuf::from(&gone.current_path).ends_with(".codex/agents/gone.toml"),
            "a missing file still reports the file it would live at: {}",
            gone.current_path
        );
    }
}
