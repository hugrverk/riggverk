use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use super::process::{run_cmd, ActionResult};
use super::workspace::path_arg;

const ALLOWED_TARGET_IDS: &[&str] = &[
    "codex-rules",
    "opencode-rules",
    "claude-rules",
    "opencode-config",
    "opencode-agents",
    "claude-agents",
    "codex",
    "opencode",
    "claude",
];

const BACKUP_FILE_LIMIT: usize = 50;
const MAX_COMPARE_SIZE: u64 = 2 * 1024 * 1024; // 2 MiB

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

    let root = if let Ok(env_override) = std::env::var("AGENT_WORKSPACE_BACKUP_DIR") {
        let trimmed = env_override.trim().to_string();
        if trimmed.is_empty() {
            return Err("AGENT_WORKSPACE_BACKUP_DIR is set but empty".to_string());
        }
        PathBuf::from(&trimmed)
    } else {
        default_root
    };

    let root_str = root.to_string_lossy();
    if root_str.trim().is_empty() {
        return Err("backup directory is empty".to_string());
    }

    let home_str = home.to_string_lossy();
    if root_str == "/" || root_str == home_str.as_ref() || root_str == format!("{}/", home_str) {
        return Err(format!("refusing broad backup directory: {}", root_str));
    }

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

fn resolve_current_target(target_id: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    if home.is_empty() {
        return Err("HOME is empty".to_string());
    }
    let rel = match target_id {
        "codex-rules" => ".codex/AGENTS.md",
        "opencode-rules" => ".config/opencode/AGENTS.md",
        "claude-rules" => ".claude/CLAUDE.md",
        "opencode-config" => ".config/opencode/opencode.json",
        "opencode-agents" => ".config/opencode/agents",
        "claude-agents" => ".claude/agents",
        // Legacy backwards-compatible IDs (read-only)
        "codex" => ".codex/AGENTS.md",
        "opencode" => ".config/opencode/AGENTS.md",
        "claude" => ".claude/CLAUDE.md",
        _ => return Err(format!("unknown backup target id: {}", target_id)),
    };
    Ok(PathBuf::from(&home).join(rel))
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

#[tauri::command]
pub fn list_backups() -> Result<Vec<BackupRunSummary>, String> {
    let root = backup_root()?;

    if !root.exists() || !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut runs: Vec<BackupRunSummary> = Vec::new();

    let entries =
        std::fs::read_dir(&root).map_err(|e| format!("cannot read backup directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read backup entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot stat backup entry: {}", e))?;

        if !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if !is_timestamp_dir(&name_str) {
            continue;
        }

        let run_path = entry.path();
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

        if file_count == 0 {
            continue;
        }

        let ts = name_str.into_owned();
        runs.push(BackupRunSummary {
            id: ts.clone(),
            timestamp: ts,
            path: run_path.to_string_lossy().into_owned(),
            targets,
            file_count,
        });
    }

    runs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    runs.truncate(20);

    Ok(runs)
}

#[tauri::command]
pub fn open_backups_folder() -> Result<ActionResult, String> {
    let root = prepare_backup_root_for_open()?;
    let path_str = path_arg(&root)?;
    let (success, stdout, stderr, code) = run_cmd("open", &[&path_str], &root);

    Ok(ActionResult::new(
        success,
        "open_backups_folder",
        stdout,
        stderr,
        code,
    ))
}

fn get_backup_details_from_root(root: &Path, run_id: &str) -> Result<BackupRunDetails, String> {
    if !is_timestamp_dir(run_id) {
        return Err("invalid run id: must be YYYYMMDD-HHMMSS".to_string());
    }
    if run_id.contains('/') || run_id.contains('\\') || run_id.contains("..") {
        return Err("invalid run id".to_string());
    }

    if !root.exists() || !root.is_dir() {
        return Err("backup directory does not exist".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("cannot resolve backup root: {}", e))?;

    let run_path = canonical_root.join(run_id);
    if !run_path.exists() || !run_path.is_dir() {
        return Err(format!("backup run not found: {}", run_id));
    }

    let canonical_run = run_path
        .canonicalize()
        .map_err(|e| format!("cannot resolve run path: {}", e))?;

    let root_str = canonical_root.to_string_lossy().into_owned();
    let run_str = canonical_run.to_string_lossy().into_owned();
    let root_prefix = format!("{}/", root_str);
    if run_str != root_str && !run_str.starts_with(&root_prefix) {
        return Err("run directory is outside backup root".to_string());
    }

    let mut files: Vec<BackupFileSummary> = Vec::new();

    for target_id in ALLOWED_TARGET_IDS {
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
                        // For directory targets (opencode-agents), resolve each
                        // backup file to its matching runtime file by joining
                        // the filename onto the target directory path.
                        let cp_file = if *target_id == "opencode-agents" {
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

    files.sort_by(|a, b| {
        a.target_id
            .cmp(&b.target_id)
            .then_with(|| a.filename.cmp(&b.filename))
    });

    Ok(BackupRunDetails {
        id: run_id.to_string(),
        timestamp: run_id.to_string(),
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
        std::env::temp_dir().join(format!("agent-workspace-backups-{name}-{nonce}"))
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
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        for tid in ALLOWED_TARGET_IDS {
            let result = resolve_current_target(tid);
            assert!(result.is_ok(), "resolve_current_target failed for {}", tid);
            let path = result.unwrap();
            assert!(
                path.starts_with(&home),
                "path {} not under HOME",
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
        let root = temp_root("open-create-root");
        let backup_root = root.join("backups");
        let previous = std::env::var("AGENT_WORKSPACE_BACKUP_DIR").ok();
        std::env::set_var(
            "AGENT_WORKSPACE_BACKUP_DIR",
            backup_root.to_string_lossy().as_ref(),
        );

        let result = prepare_backup_root_for_open();

        match previous {
            Some(value) => std::env::set_var("AGENT_WORKSPACE_BACKUP_DIR", value),
            None => std::env::remove_var("AGENT_WORKSPACE_BACKUP_DIR"),
        }

        assert!(result.is_ok(), "backup root should be created: {result:?}");
        assert!(backup_root.is_dir(), "backup root should exist");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_agents_backup_file_maps_to_correct_current_path() {
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
        // Verify the current_path joins the agents directory with the filename
        assert!(
            summary
                .current_path
                .ends_with(".config/opencode/agents/architect.md"),
            "current_path should end with .config/opencode/agents/architect.md, got: {}",
            summary.current_path
        );
        // current_exists may be false in CI, but the path shape is what matters

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
}
