use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::process::{run_cmd, ActionResult};
use super::workspace::path_arg;

// ── constants ──

const REPO_URL: &str = "https://github.com/VoltAgent/awesome-design-md.git";
const BRANCH: &str = "main";
const DESIGN_MD_DIR: &str = "design-md";
const DESIGN_MD_FILE: &str = "DESIGN.md";

// ── serializable response types ──

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdCatalogStatus {
    pub exists: bool,
    pub repo_url: String,
    pub branch: String,
    pub cache_path: String,
    pub current_commit: Option<String>,
    pub entry_count: usize,
    pub last_error: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdEntry {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub path: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdContent {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdSyncResult {
    pub success: bool,
    pub action: String,
    pub cache_path: String,
    pub current_commit: Option<String>,
    pub entry_count: usize,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdInstallPlan {
    pub ok: bool,
    pub slug: String,
    pub title: String,
    pub target_dir: String,
    pub target_file: String,
    pub existing: bool,
    pub existing_size: Option<u64>,
    pub backup_path: Option<String>,
    pub action: String,
    pub reason: String,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdInstallResult {
    pub success: bool,
    pub slug: String,
    pub target_file: String,
    pub backup_path: Option<String>,
    pub action: String,
    pub message: String,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct DesignMdInstallStatus {
    pub target_dir: String,
    pub target_file: String,
    pub exists: bool,
    pub matches_selected: bool,
    pub status: String,
    pub reason: String,
    pub size: Option<u64>,
    pub warnings: Vec<String>,
}

// ── cache path ──

fn design_md_cache_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    if home.is_empty() {
        return Err("HOME is empty".to_string());
    }
    Ok(PathBuf::from(&home).join(
        "Library/Application Support/ai.agentworkspace.app/design-catalogs/awesome-design-md",
    ))
}

// ── git helpers ──

fn run_git(args: &[&str], cwd: Option<&Path>) -> (bool, String, String, Option<i32>) {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    match cmd.output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            let success = out.status.success();
            let code = out.status.code();
            (success, stdout, stderr, code)
        }
        Err(e) => (false, String::new(), e.to_string(), None),
    }
}

fn git_current_commit(repo_path: &Path) -> Option<String> {
    let (ok, stdout, _stderr, _code) = run_git(&["rev-parse", "HEAD"], Some(repo_path));
    if ok {
        let trimmed = stdout.trim().to_string();
        if trimmed.len() >= 7 {
            Some(trimmed)
        } else {
            None
        }
    } else {
        None
    }
}

// ── cache validation ──

/// Validates that an existing cache directory is a git repo with the expected origin URL.
fn validate_cache_repo(cache: &Path, expected_url: &str) -> Result<bool, String> {
    let git_dir = cache.join(".git");
    if !git_dir.exists() {
        return Ok(false);
    }
    let (ok, stdout, _stderr, _code) = run_git(&["remote", "get-url", "origin"], Some(cache));
    if !ok {
        return Ok(false);
    }
    let origin_url = stdout.trim();
    let normalized_expected = normalize_git_url(expected_url);
    let normalized_origin = normalize_git_url(origin_url);
    if normalized_origin != normalized_expected {
        return Ok(false);
    }
    Ok(true)
}

fn normalize_git_url(url: &str) -> String {
    let mut s = url.trim().to_string();

    // Strip protocol and auth prefixes
    if let Some(stripped) = s.strip_prefix("https://") {
        s = stripped.to_string();
    } else if let Some(stripped) = s.strip_prefix("http://") {
        s = stripped.to_string();
    } else if let Some(stripped) = s.strip_prefix("ssh://") {
        s = stripped.to_string();
        // ssh:// may have user@host; strip user@ portion if present
        if let Some(at_pos) = s.find('@') {
            s = s[at_pos + 1..].to_string();
        }
    } else if let Some(stripped) = s.strip_prefix("git@") {
        s = stripped.to_string();
    }

    // Normalize the colon separator in scp-like syntax (git@github.com:org/repo)
    // Replace the first ':' after a non-slash segment with '/'
    if let Some(colon_pos) = s.find(':') {
        let before_colon = &s[..colon_pos];
        if !before_colon.contains("://") && !before_colon.contains('/') {
            s.replace_range(colon_pos..=colon_pos, "/");
        }
    }

    // Strip trailing slash before .git to handle `repo.git/`
    if s.ends_with('/') {
        s.pop();
    }

    // Strip trailing .git
    if s.ends_with(".git") {
        s = s[..s.len() - 4].to_string();
    }

    // Strip trailing slash again (after .git removal)
    if s.ends_with('/') {
        s.pop();
    }

    s.to_lowercase()
}

// ── Tauri commands ──

#[tauri::command]
pub fn get_design_md_catalog_status() -> Result<DesignMdCatalogStatus, String> {
    let cache = design_md_cache_root()?;
    let exists = cache.exists();
    let current_commit = if exists {
        git_current_commit(&cache)
    } else {
        None
    };

    let entry_count = if exists {
        match list_design_md_entries_impl(&cache) {
            Ok(entries) => entries.len(),
            Err(_) => 0,
        }
    } else {
        0
    };

    Ok(DesignMdCatalogStatus {
        exists,
        repo_url: REPO_URL.to_string(),
        branch: BRANCH.to_string(),
        cache_path: cache.to_string_lossy().into_owned(),
        current_commit,
        entry_count,
        last_error: None,
    })
}

#[tauri::command]
pub fn sync_design_md_catalog() -> Result<DesignMdSyncResult, String> {
    let cache = design_md_cache_root()?;
    let cache_str = cache.to_string_lossy().into_owned();

    if !cache.exists() {
        if let Some(parent) = cache.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create cache parent: {}", e))?;
        }

        let (ok, stdout, stderr, _code) = run_git(
            &[
                "clone",
                "--depth",
                "1",
                "--single-branch",
                "--branch",
                BRANCH,
                "--no-tags",
                REPO_URL,
                &cache_str,
            ],
            None,
        );

        if !ok {
            return Ok(DesignMdSyncResult {
                success: false,
                action: "clone".to_string(),
                cache_path: cache_str,
                current_commit: None,
                entry_count: 0,
                stdout,
                stderr,
            });
        }

        let commit = git_current_commit(&cache);
        let entry_count = list_design_md_entries_impl(&cache)
            .map(|e| e.len())
            .unwrap_or(0);

        return Ok(DesignMdSyncResult {
            success: true,
            action: "clone".to_string(),
            cache_path: cache_str,
            current_commit: commit,
            entry_count,
            stdout,
            stderr,
        });
    }

    // Cache exists — validate it before fetch/reset
    if !validate_cache_repo(&cache, REPO_URL)? {
        return Ok(DesignMdSyncResult {
            success: false,
            action: "validate".to_string(),
            cache_path: cache_str,
            current_commit: None,
            entry_count: 0,
            stdout: String::new(),
            stderr: "Cache path exists but is not the expected repository. Remove it manually if needed.".to_string(),
        });
    }

    let (fetch_ok, fetch_stdout, fetch_stderr, _fetch_code) =
        run_git(&["fetch", "--depth", "1", "origin", BRANCH], Some(&cache));

    let mut combined_stdout = fetch_stdout;
    let mut combined_stderr = fetch_stderr;

    if !fetch_ok {
        return Ok(DesignMdSyncResult {
            success: false,
            action: "fetch".to_string(),
            cache_path: cache_str,
            current_commit: None,
            entry_count: 0,
            stdout: combined_stdout,
            stderr: combined_stderr,
        });
    }

    let (reset_ok, reset_stdout, reset_stderr, _reset_code) = run_git(
        &["reset", "--hard", &format!("origin/{}", BRANCH)],
        Some(&cache),
    );

    combined_stdout.push_str(&reset_stdout);
    combined_stderr.push_str(&reset_stderr);

    let commit = git_current_commit(&cache);
    let entry_count = list_design_md_entries_impl(&cache)
        .map(|e| e.len())
        .unwrap_or(0);

    Ok(DesignMdSyncResult {
        success: reset_ok,
        action: "fetch+reset".to_string(),
        cache_path: cache_str,
        current_commit: commit,
        entry_count,
        stdout: combined_stdout,
        stderr: combined_stderr,
    })
}

#[tauri::command]
pub fn list_design_md_entries() -> Result<Vec<DesignMdEntry>, String> {
    let cache = design_md_cache_root()?;
    if !cache.exists() {
        return Err("Design MD catalog is not cached. Sync it first.".to_string());
    }
    list_design_md_entries_impl(&cache)
}

fn list_design_md_entries_impl(cache: &Path) -> Result<Vec<DesignMdEntry>, String> {
    let design_md_dir = cache.join(DESIGN_MD_DIR);
    if !design_md_dir.is_dir() {
        return Err("design-md directory not found in cache".to_string());
    }

    let mut entries: Vec<DesignMdEntry> = Vec::new();

    let dir_entries = std::fs::read_dir(&design_md_dir)
        .map_err(|e| format!("cannot read design-md dir: {}", e))?;

    for dir_entry in dir_entries.flatten() {
        let path = dir_entry.path();
        if !path.is_dir() {
            continue;
        }

        let slug = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) if !s.is_empty() && !s.starts_with('.') => s.to_string(),
            _ => continue,
        };

        if !is_valid_design_md_slug(&slug) {
            continue;
        }

        let design_md_path = path.join(DESIGN_MD_FILE);
        if !design_md_path.is_file() {
            continue;
        }

        let content = match std::fs::read_to_string(&design_md_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (title, description) = parse_design_md_frontmatter(&content, &slug);

        let rel_path = format!("{}/{}/{}", DESIGN_MD_DIR, slug, DESIGN_MD_FILE);
        entries.push(DesignMdEntry {
            slug,
            title,
            description,
            path: rel_path,
        });
    }

    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub fn read_design_md_entry(slug: String) -> Result<DesignMdContent, String> {
    if !is_valid_design_md_slug(&slug) {
        return Err(format!("invalid slug: {}", slug));
    }

    let cache = design_md_cache_root()?;
    if !cache.exists() {
        return Err("Design MD catalog is not cached. Sync it first.".to_string());
    }

    read_design_md_entry_impl(&cache, &slug)
}

fn read_design_md_entry_impl(cache: &Path, slug: &str) -> Result<DesignMdContent, String> {
    let resolved_path = resolve_design_md_entry_path(cache, slug)?;

    let canonical_cache = cache
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize cache: {}", e))?;
    let canonical_resolved = resolved_path
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize resolved path: {}", e))?;

    if !canonical_resolved.starts_with(&canonical_cache) {
        return Err("resolved path is outside cache".to_string());
    }

    let content =
        std::fs::read_to_string(&canonical_resolved).map_err(|e| format!("read error: {}", e))?;

    let (title, description) = parse_design_md_frontmatter(&content, slug);
    let rel_path = format!("{}/{}/{}", DESIGN_MD_DIR, slug, DESIGN_MD_FILE);

    Ok(DesignMdContent {
        slug: slug.to_string(),
        title,
        description,
        path: rel_path,
        content,
    })
}

// ── install helpers ──

/// System-sensitive directory prefixes that should be rejected as install targets.
const UNSAFE_DIR_PREFIXES: &[&str] = &[
    "/System",
    "/Library",
    "/bin",
    "/usr",
    "/etc",
    "/sbin",
    "/opt",
    "/private/etc",
    "/dev",
    "/Volumes",
];

fn is_target_dir_safe(target_dir: &str) -> Result<(), String> {
    if target_dir.is_empty() {
        return Err("target_dir is empty".to_string());
    }

    let path = Path::new(target_dir);
    if !path.is_absolute() {
        return Err("target_dir must be an absolute path".to_string());
    }

    if !path.exists() {
        return Err(format!("target_dir does not exist: {}", target_dir));
    }

    if !path.is_dir() {
        return Err(format!("target_dir is not a directory: {}", target_dir));
    }

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve target_dir: {}", e))?;

    if canonical.parent().is_none() {
        return Err("cannot install to root directory".to_string());
    }

    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            let home_path = Path::new(&home);
            if let Ok(canonical_home) = home_path.canonicalize() {
                if canonical == canonical_home {
                    return Err("cannot install to HOME directory".to_string());
                }
            }
        }
    }

    let canonical_str = canonical.to_string_lossy();
    for prefix in UNSAFE_DIR_PREFIXES {
        if canonical_str.starts_with(prefix) {
            return Err(format!(
                "cannot install to system directory: {}",
                target_dir
            ));
        }
    }

    Ok(())
}

fn create_backup_path(target_file: &Path) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dt = chrono_lite(ts);
    let base_suffix = format!("backup-{}", dt);
    let base_dir = target_file.parent().unwrap_or(Path::new("."));
    let stem = target_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("DESIGN");
    let ext = target_file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("md");

    // Build: DESIGN.md.backup-YYYYMMDD-HHMMSS
    let mut candidate = base_dir.join(format!("{}.{}.{}", stem, ext, base_suffix));
    let mut n: u32 = 1;
    while candidate.exists() {
        candidate = base_dir.join(format!("{}.{}.{}-{}", stem, ext, base_suffix, n));
        n += 1;
        if n > 99 {
            // Give up after 99 attempts; extremely unlikely
            let fallback_ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            candidate = base_dir.join(format!("{}.{}.{}-{}", stem, ext, base_suffix, fallback_ts));
            break;
        }
    }
    candidate
}

fn chrono_lite(ts: u64) -> String {
    let secs_in_day: u64 = 86400;
    let days = ts / secs_in_day;
    let rem = ts % secs_in_day;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let seconds = rem % 60;

    let mut y = 1970u64;
    let mut d = days;
    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0usize;
    while m < 12 && d >= month_days[m] {
        d -= month_days[m];
        m += 1;
    }
    let month = m + 1;
    let day = d + 1;

    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        y, month, day, hours, minutes, seconds
    )
}

fn is_leap_year(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// ── install commands ──

#[tauri::command]
pub fn plan_install_design_md(
    slug: String,
    target_dir: String,
) -> Result<DesignMdInstallPlan, String> {
    let cache = design_md_cache_root()?;
    plan_install_design_md_impl(&cache, &slug, &target_dir)
}

fn plan_install_design_md_impl(
    cache: &Path,
    slug: &str,
    target_dir: &str,
) -> Result<DesignMdInstallPlan, String> {
    if !is_valid_design_md_slug(slug) {
        return Err(format!("invalid slug: {}", slug));
    }

    if let Err(e) = is_target_dir_safe(target_dir) {
        return Ok(DesignMdInstallPlan {
            ok: false,
            slug: slug.to_string(),
            title: slug.to_string(),
            target_dir: target_dir.to_string(),
            target_file: format!("{}/{}", target_dir, DESIGN_MD_FILE),
            existing: false,
            existing_size: None,
            backup_path: None,
            action: "blocked".to_string(),
            reason: e,
            warnings: vec![],
        });
    }

    if !cache.exists() {
        return Err("Design MD catalog is not cached. Sync it first.".to_string());
    }

    let source_path = resolve_design_md_entry_path(cache, slug)?;

    let content = match std::fs::read_to_string(&source_path) {
        Ok(c) => c,
        Err(e) => {
            return Ok(DesignMdInstallPlan {
                ok: false,
                slug: slug.to_string(),
                title: slug.to_string(),
                target_dir: target_dir.to_string(),
                target_file: format!("{}/{}", target_dir, DESIGN_MD_FILE),
                existing: false,
                existing_size: None,
                backup_path: None,
                action: "blocked".to_string(),
                reason: format!("cannot read source DESIGN.md: {}", e),
                warnings: vec![],
            });
        }
    };

    let (title, _desc) = parse_design_md_frontmatter(&content, slug);
    let target_file_path = Path::new(target_dir).join(DESIGN_MD_FILE);
    let target_file_str = target_file_path.to_string_lossy().into_owned();

    let mut warnings: Vec<String> = Vec::new();

    if target_file_path.exists() {
        let existing_size = match std::fs::metadata(&target_file_path) {
            Ok(m) => Some(m.len()),
            Err(_) => None,
        };
        let backup_path = create_backup_path(&target_file_path);
        let backup_str = backup_path.to_string_lossy().into_owned();

        if backup_path.exists() {
            warnings.push("backup target already exists (may be overwritten)".to_string());
        }

        Ok(DesignMdInstallPlan {
            ok: true,
            slug: slug.to_string(),
            title,
            target_dir: target_dir.to_string(),
            target_file: target_file_str,
            existing: true,
            existing_size,
            backup_path: Some(backup_str),
            action: "replace_with_backup".to_string(),
            reason: "DESIGN.md already exists; will replace after backup".to_string(),
            warnings,
        })
    } else {
        Ok(DesignMdInstallPlan {
            ok: true,
            slug: slug.to_string(),
            title,
            target_dir: target_dir.to_string(),
            target_file: target_file_str,
            existing: false,
            existing_size: None,
            backup_path: None,
            action: "create".to_string(),
            reason: "DESIGN.md does not exist; will create new file".to_string(),
            warnings,
        })
    }
}

#[tauri::command]
pub fn install_design_md(
    slug: String,
    target_dir: String,
) -> Result<DesignMdInstallResult, String> {
    let cache = design_md_cache_root()?;
    install_design_md_impl(&cache, &slug, &target_dir)
}

fn install_design_md_impl(
    cache: &Path,
    slug: &str,
    target_dir: &str,
) -> Result<DesignMdInstallResult, String> {
    if !is_valid_design_md_slug(slug) {
        return Err(format!("invalid slug: {}", slug));
    }

    if let Err(e) = is_target_dir_safe(target_dir) {
        return Err(format!("unsafe target directory: {}", e));
    }

    if !cache.exists() {
        return Err("Design MD catalog is not cached. Sync it first.".to_string());
    }

    let source_path = resolve_design_md_entry_path(cache, slug)?;

    let canonical_cache = cache
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize cache: {}", e))?;
    let canonical_source = source_path
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize source path: {}", e))?;

    if !canonical_source.starts_with(&canonical_cache) {
        return Err("source path is outside cache".to_string());
    }

    let content = std::fs::read_to_string(&canonical_source)
        .map_err(|e| format!("cannot read source DESIGN.md: {}", e))?;

    let target_file_path = Path::new(target_dir).join(DESIGN_MD_FILE);
    let target_file_str = target_file_path.to_string_lossy().into_owned();

    let mut warnings: Vec<String> = Vec::new();
    let mut backup_path: Option<String> = None;
    let action: String;

    if target_file_path.exists() {
        let bp = create_backup_path(&target_file_path);
        if let Err(e) = std::fs::copy(&target_file_path, &bp) {
            return Err(format!("failed to create backup: {}", e));
        }
        backup_path = Some(bp.to_string_lossy().into_owned());
        action = "replace_with_backup".to_string();
        warnings.push(format!(
            "existing DESIGN.md backed up to {}",
            backup_path.as_ref().unwrap()
        ));
    } else {
        action = "create".to_string();
    }

    if let Err(e) = std::fs::write(&target_file_path, &content) {
        if backup_path.is_some() {
            warnings.push(format!(
                "backup created but install failed: {} (backup at {})",
                e,
                backup_path.as_ref().unwrap()
            ));
        }
        return Err(format!("failed to write DESIGN.md: {}", e));
    }

    let msg = match action.as_str() {
        "create" => "DESIGN.md installed".to_string(),
        "replace_with_backup" => "DESIGN.md replaced after backup".to_string(),
        other => format!("DESIGN.md installed ({})", other),
    };
    Ok(DesignMdInstallResult {
        success: true,
        slug: slug.to_string(),
        target_file: target_file_str,
        backup_path,
        action,
        message: msg,
        warnings,
    })
}

// ── install status command ──

#[tauri::command]
pub fn get_design_md_install_status(
    slug: String,
    target_dir: String,
) -> Result<DesignMdInstallStatus, String> {
    let cache = design_md_cache_root()?;
    get_design_md_install_status_impl(&cache, &slug, &target_dir)
}

fn get_design_md_install_status_impl(
    cache: &Path,
    slug: &str,
    target_dir: &str,
) -> Result<DesignMdInstallStatus, String> {
    if target_dir.is_empty() {
        let target_file = format!("{}/{}", target_dir, DESIGN_MD_FILE);
        return Ok(DesignMdInstallStatus {
            target_dir: target_dir.to_string(),
            target_file,
            exists: false,
            matches_selected: false,
            status: "no_target".to_string(),
            reason: "no project selected".to_string(),
            size: None,
            warnings: vec![],
        });
    }

    // Validate target_dir
    if let Err(e) = is_target_dir_safe(target_dir) {
        let target_file = format!("{}/{}", target_dir, DESIGN_MD_FILE);
        return Ok(DesignMdInstallStatus {
            target_dir: target_dir.to_string(),
            target_file,
            exists: false,
            matches_selected: false,
            status: "blocked".to_string(),
            reason: e,
            size: None,
            warnings: vec![],
        });
    }

    // Validate slug and load source content from cache
    if !is_valid_design_md_slug(slug) {
        return Err(format!("invalid slug: {}", slug));
    }

    if !cache.exists() {
        let target_file = Path::new(target_dir)
            .join(DESIGN_MD_FILE)
            .to_string_lossy()
            .into_owned();
        return Ok(DesignMdInstallStatus {
            target_dir: target_dir.to_string(),
            target_file,
            exists: false,
            matches_selected: false,
            status: "blocked".to_string(),
            reason: "Design MD catalog is not cached. Sync it first.".to_string(),
            size: None,
            warnings: vec![],
        });
    }

    let source_path = resolve_design_md_entry_path(cache, slug)?;
    let source_content = std::fs::read_to_string(&source_path).map_err(|e| {
        format!("cannot read source DESIGN.md for {}: {}", slug, e)
    })?;

    let target_file_path = Path::new(target_dir).join(DESIGN_MD_FILE);
    let target_file_str = target_file_path.to_string_lossy().into_owned();

    if !target_file_path.exists() {
        return Ok(DesignMdInstallStatus {
            target_dir: target_dir.to_string(),
            target_file: target_file_str,
            exists: false,
            matches_selected: false,
            status: "missing".to_string(),
            reason: "DESIGN.md not installed in target folder".to_string(),
            size: None,
            warnings: vec![],
        });
    }

    // Target DESIGN.md exists — compare content (safe binary compare)
    let target_content = std::fs::read_to_string(&target_file_path)
        .map_err(|e| format!("cannot read target DESIGN.md: {}", e))?;
    let target_size = target_content.len() as u64;
    let matches = source_content == target_content;

    if matches {
        Ok(DesignMdInstallStatus {
            target_dir: target_dir.to_string(),
            target_file: target_file_str,
            exists: true,
            matches_selected: true,
            status: "installed".to_string(),
            reason: "DESIGN.md matches selected entry".to_string(),
            size: Some(target_size),
            warnings: vec![],
        })
    } else {
        Ok(DesignMdInstallStatus {
            target_dir: target_dir.to_string(),
            target_file: target_file_str,
            exists: true,
            matches_selected: false,
            status: "different".to_string(),
            reason: "a different DESIGN.md exists in target folder".to_string(),
            size: Some(target_size),
            warnings: vec![],
        })
    }
}

// ── open commands ──

#[tauri::command]
pub fn open_design_md_target_folder(target_dir: String) -> Result<ActionResult, String> {
    if let Err(e) = is_target_dir_safe(&target_dir) {
        return Err(format!("unsafe target directory: {}", e));
    }

    let path = Path::new(&target_dir);
    // Re-validate after canonicalization for safety
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve target_dir: {}", e))?;

    // Verify the canonical path passes safety again (defense in depth)
    if let Err(e) = is_target_dir_safe(canonical.to_string_lossy().as_ref()) {
        return Err(format!("unsafe target directory: {}", e));
    }

    let path_str = path_arg(&canonical)?;
    let (ok, out, err, code) = run_cmd("open", &[&path_str], &canonical);
    Ok(ActionResult::new(
        ok,
        format!("open_design_md_target_folder"),
        out,
        err,
        code,
    ))
}

#[tauri::command]
pub fn open_installed_design_md(target_dir: String) -> Result<ActionResult, String> {
    if let Err(e) = is_target_dir_safe(&target_dir) {
        return Err(format!("unsafe target directory: {}", e));
    }

    let path = Path::new(&target_dir);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve target_dir: {}", e))?;

    if let Err(e) = is_target_dir_safe(canonical.to_string_lossy().as_ref()) {
        return Err(format!("unsafe target directory: {}", e));
    }

    let target_file = canonical.join(DESIGN_MD_FILE);
    if !target_file.exists() {
        return Err("DESIGN.md not found in target folder".to_string());
    }
    if !target_file.is_file() {
        return Err("DESIGN.md path is not a file".to_string());
    }

    let file_str = path_arg(&target_file)?;
    let (ok, out, err, code) = run_cmd("open", &[&file_str], &canonical);
    Ok(ActionResult::new(
        ok,
        format!("open_installed_design_md"),
        out,
        err,
        code,
    ))
}

// ── validation ──

fn is_valid_design_md_slug(slug: &str) -> bool {
    if slug.is_empty() {
        return false;
    }
    if slug.contains("..") {
        return false;
    }
    if slug.contains('/') || slug.contains('\\') {
        return false;
    }
    if slug.starts_with('/') || slug.starts_with('\\') {
        return false;
    }
    for c in slug.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => {}
            _ => return false,
        }
    }
    if slug.chars().all(|c| c == '.') {
        return false;
    }
    true
}

// ── path resolution ──

fn resolve_design_md_entry_path(cache: &Path, slug: &str) -> Result<PathBuf, String> {
    let rel = format!("{}/{}/{}", DESIGN_MD_DIR, slug, DESIGN_MD_FILE);
    let rel_path = Path::new(&rel);

    if rel.contains("..") || rel_path.is_absolute() {
        return Err("invalid slug: traversal detected".to_string());
    }

    Ok(cache.join(rel))
}

// ── frontmatter parsing ──

/// Parses minimal YAML frontmatter from DESIGN.md content.
///
/// Expects frontmatter delimited by `---` lines.
///
/// Supports YAML block scalars (`description: |`), quoted values, and plain values.
/// Returns (title, description). Falls back to slug for title if name is missing.
fn parse_design_md_frontmatter(content: &str, slug: &str) -> (String, String) {
    let trimmed = content.trim_start();
    let after_opening = match trimmed.strip_prefix("---") {
        Some(rest) => rest,
        None => return (slug.to_string(), String::new()),
    };

    let after_newline = match after_opening.strip_prefix('\n') {
        Some(rest) => rest,
        None => {
            if after_opening.trim().is_empty() {
                return (slug.to_string(), String::new());
            }
            after_opening
        }
    };

    let fm_body = match after_newline.split("\n---").next() {
        Some(body) => body,
        None => return (slug.to_string(), String::new()),
    };

    let mut name = String::new();
    let mut description = String::new();
    let mut in_block_scalar: Option<String> = None;
    let mut block_scalar_lines: Vec<String> = Vec::new();

    for line in fm_body.lines() {
        let trimmed_line = line.trim();

        if let Some(ref field_name) = in_block_scalar {
            if trimmed_line.is_empty() {
                if field_name == "description" {
                    description = collapse_description_lines(&block_scalar_lines);
                }
                in_block_scalar = None;
                block_scalar_lines.clear();
                continue;
            }
            if !line.starts_with(' ') && !line.starts_with('\t') && trimmed_line.contains(':') {
                if is_frontmatter_key(trimmed_line) {
                    if field_name == "description" {
                        description = collapse_description_lines(&block_scalar_lines);
                    }
                    in_block_scalar = None;
                    block_scalar_lines.clear();
                    // fall through to process this new key
                } else {
                    if field_name == "description" {
                        description = collapse_description_lines(&block_scalar_lines);
                    }
                    in_block_scalar = None;
                    block_scalar_lines.clear();
                    continue;
                }
            } else {
                let content_str = line.trim();
                block_scalar_lines.push(content_str.to_string());
                continue;
            }
        }

        if trimmed_line.is_empty() {
            continue;
        }

        if let Some(value) = trimmed_line.strip_prefix("name:") {
            name = value.trim().to_string();
            continue;
        }

        if let Some(value) = trimmed_line.strip_prefix("description:") {
            let remaining = value.trim();
            if remaining == "|" || remaining == "|-" || remaining == ">" || remaining == ">-" {
                in_block_scalar = Some("description".to_string());
                block_scalar_lines.clear();
                continue;
            }
            let desc_value = strip_yaml_quotes(remaining);
            if !desc_value.is_empty() {
                description = truncate_description(&desc_value);
            }
            continue;
        }
    }

    if let Some(ref field_name) = in_block_scalar {
        if field_name == "description" && !block_scalar_lines.is_empty() {
            description = collapse_description_lines(&block_scalar_lines);
        }
    }

    let title = if name.is_empty() {
        slug.to_string()
    } else {
        name
    };

    (title, description)
}

fn is_frontmatter_key(line: &str) -> bool {
    let trimmed = line.trim();
    if let Some(colon_pos) = trimmed.find(':') {
        let key = &trimmed[..colon_pos];
        key.chars().all(|c| c.is_alphanumeric() || c == '_')
    } else {
        false
    }
}

fn strip_yaml_quotes(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() >= 2 {
        let chars: Vec<char> = trimmed.chars().collect();
        let first = chars[0];
        let last = chars[chars.len() - 1];
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return chars[1..chars.len() - 1].iter().collect();
        }
    }
    trimmed.to_string()
}

const MAX_DESC_LEN: usize = 220;

fn collapse_description_lines(lines: &[String]) -> String {
    let joined = lines.join(" ");
    truncate_description(&joined)
}

fn truncate_description(raw: &str) -> String {
    let cleaned = raw.trim();
    if cleaned.len() <= MAX_DESC_LEN {
        return cleaned.to_string();
    }

    // Truncate by chars, not bytes, to stay UTF-8 safe
    let ellipsis = "…";
    let ellipsis_len = ellipsis.len();
    let char_limit = if MAX_DESC_LEN > ellipsis_len {
        MAX_DESC_LEN - ellipsis_len
    } else {
        MAX_DESC_LEN
    };

    // Find a safe char boundary at or below the byte limit
    let mut byte_end = char_limit;
    if byte_end > cleaned.len() {
        byte_end = cleaned.len();
    }
    // Walk back to a char boundary if we landed in the middle of a multi-byte char
    while byte_end > 0 && !cleaned.is_char_boundary(byte_end) {
        byte_end -= 1;
    }

    // Try to break at whitespace before the limit
    let snippet = &cleaned[..byte_end];
    let last_space = snippet.rfind(' ');
    if let Some(pos) = last_space {
        if pos > 0 {
            byte_end = pos;
        }
    }

    // Re-validate char boundary after whitespace adjustment
    while byte_end > 0 && !cleaned.is_char_boundary(byte_end) {
        byte_end -= 1;
    }
    if byte_end == 0 {
        byte_end = char_limit;
        while byte_end > 0 && !cleaned.is_char_boundary(byte_end) {
            byte_end -= 1;
        }
    }

    format!("{}{}", &cleaned[..byte_end], ellipsis)
}

// ── tests ──

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
        std::env::temp_dir().join(format!("agent-workspace-design-md-{name}-{nonce}"))
    }

    fn setup_cache_with_entries(name: &str) -> PathBuf {
        let root = temp_root(name);
        for (slug, content) in &[
            ("opencode.ai", "---\nname: OpenCode.ai\ndescription: AI coding agent configuration\n---\n\n# OpenCode.ai\n"),
            ("supabase", "---\nname: Supabase\ndescription: Backend platform\n---\n\n# Supabase\n"),
            ("linear.app", "---\nname: Linear\ndescription: Project management tool\n---\n\n# Linear\n"),
        ] {
            let dir = root.join(DESIGN_MD_DIR).join(slug);
            fs::create_dir_all(&dir).expect("create slug dir");
            fs::write(dir.join(DESIGN_MD_FILE), content).expect("write DESIGN.md");
        }
        root
    }

    fn setup_cache_without_design_md_file(name: &str) -> PathBuf {
        let root = temp_root(name);
        let dir = root.join(DESIGN_MD_DIR).join("empty-slug");
        fs::create_dir_all(&dir).expect("create slug dir");
        root
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    // ── slug validation tests ──

    #[test]
    fn slug_validation_accepts_normal_slugs() {
        assert!(is_valid_design_md_slug("opencode.ai"));
        assert!(is_valid_design_md_slug("supabase"));
        assert!(is_valid_design_md_slug("linear.app"));
        assert!(is_valid_design_md_slug("my-tool"));
        assert!(is_valid_design_md_slug("My_Tool"));
        assert!(is_valid_design_md_slug("a"));
        assert!(is_valid_design_md_slug("A1-b.c_3"));
    }

    #[test]
    fn slug_validation_rejects_unsafe_slugs() {
        assert!(!is_valid_design_md_slug(""));
        assert!(!is_valid_design_md_slug(".."));
        assert!(!is_valid_design_md_slug("../etc/passwd"));
        assert!(!is_valid_design_md_slug("foo/bar"));
        assert!(!is_valid_design_md_slug("foo\\bar"));
        assert!(!is_valid_design_md_slug("/etc"));
        assert!(!is_valid_design_md_slug("\\windows"));
        assert!(!is_valid_design_md_slug("..."));
        assert!(!is_valid_design_md_slug("foo bar"));
        assert!(!is_valid_design_md_slug("foo\nbar"));
        assert!(!is_valid_design_md_slug("."));
        assert!(!is_valid_design_md_slug("..hidden"));
        assert!(!is_valid_design_md_slug("bar@special"));
    }

    // ── frontmatter parsing tests ──

    #[test]
    fn frontmatter_extracts_name_and_description() {
        let content =
            "---\nname: OpenCode.ai\ndescription: AI coding agent config\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "opencode.ai");
        assert_eq!(title, "OpenCode.ai");
        assert_eq!(desc, "AI coding agent config");
    }

    #[test]
    fn frontmatter_falls_back_when_name_missing() {
        let content = "---\ndescription: Some description\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "my-tool");
        assert_eq!(title, "my-tool");
        assert_eq!(desc, "Some description");
    }

    #[test]
    fn frontmatter_falls_back_when_description_missing() {
        let content = "---\nname: My Tool\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "my-tool");
        assert_eq!(title, "My Tool");
        assert_eq!(desc, "");
    }

    #[test]
    fn frontmatter_falls_back_when_both_missing() {
        let content = "---\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "my-tool");
        assert_eq!(title, "my-tool");
        assert_eq!(desc, "");
    }

    #[test]
    fn frontmatter_handles_missing_frontmatter() {
        let content = "# No frontmatter\n\nJust content.\n";
        let (title, desc) = parse_design_md_frontmatter(content, "my-tool");
        assert_eq!(title, "my-tool");
        assert_eq!(desc, "");
    }

    #[test]
    fn frontmatter_handles_empty_content() {
        let (title, desc) = parse_design_md_frontmatter("", "empty");
        assert_eq!(title, "empty");
        assert_eq!(desc, "");
    }

    #[test]
    fn frontmatter_handles_carriage_return_newlines() {
        let content = "---\r\nname: Windows Tool\r\ndescription: Tool description\r\n---\r\n\r\n# Content\r\n";
        let (title, desc) = parse_design_md_frontmatter(content, "windows-tool");
        assert_eq!(title, "Windows Tool");
        assert_eq!(desc, "Tool description");
    }

    #[test]
    fn frontmatter_handles_extra_spaces() {
        let content =
            "---\n  name:   Padded   \n  description:   Padded desc   \n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "padded");
        assert_eq!(title, "Padded");
        assert_eq!(desc, "Padded desc");
    }

    #[test]
    fn frontmatter_with_no_newline_after_opening() {
        let content = "---name: Test\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "test");
        assert_eq!(title, "Test");
        assert_eq!(desc, "");
    }

    #[test]
    fn frontmatter_handles_block_scalar_description() {
        let content = "---\nname: OpenCode\ndescription: |\n  AI coding agent\n  configuration tool\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "opencode");
        assert_eq!(title, "OpenCode");
        assert_eq!(desc, "AI coding agent configuration tool");
    }

    #[test]
    fn frontmatter_handles_block_scalar_with_folded_style() {
        let content = "---\nname: Tool\ndescription: >\n  AI coding\n  agent\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "tool");
        assert_eq!(title, "Tool");
        assert_eq!(desc, "AI coding agent");
    }

    #[test]
    fn frontmatter_handles_quoted_description() {
        let content =
            "---\nname: My Tool\ndescription: \"A fancy description\"\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "my-tool");
        assert_eq!(title, "My Tool");
        assert_eq!(desc, "A fancy description");
    }

    #[test]
    fn frontmatter_handles_single_quoted_description() {
        let content = "---\nname: Tool\ndescription: 'simple description'\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "tool");
        assert_eq!(title, "Tool");
        assert_eq!(desc, "simple description");
    }

    #[test]
    fn frontmatter_truncates_long_description() {
        let long = "a ".repeat(200);
        let content = format!("---\nname: Tool\ndescription: {}\n---\n\n# Content\n", long);
        let (_title, desc) = parse_design_md_frontmatter(&content, "tool");
        assert!(desc.len() <= 220);
    }

    #[test]
    fn frontmatter_block_scalar_until_next_key() {
        let content = "---\nname: Tool\ndescription: |\n  line one\n  line two\nother_key: value\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "tool");
        assert_eq!(title, "Tool");
        assert_eq!(desc, "line one line two");
    }

    #[test]
    fn frontmatter_block_scalar_until_empty_line() {
        let content = "---\nname: Tool\ndescription: |\n  line one\n  line two\n\nother_key: value\n---\n\n# Content\n";
        let (title, desc) = parse_design_md_frontmatter(content, "tool");
        assert_eq!(title, "Tool");
        assert_eq!(desc, "line one line two");
    }

    // ── entry discovery tests ──

    #[test]
    fn list_entries_discovers_design_md_files() {
        let root = setup_cache_with_entries("list-entries");
        let entries = list_design_md_entries_impl(&root).expect("list should succeed");
        cleanup(&root);

        assert_eq!(entries.len(), 3);
        let slugs: Vec<&str> = entries.iter().map(|e| e.slug.as_str()).collect();
        assert!(slugs.contains(&"opencode.ai"));
        assert!(slugs.contains(&"supabase"));
        assert!(slugs.contains(&"linear.app"));
    }

    #[test]
    fn list_entries_ignores_dirs_without_design_md() {
        let root = setup_cache_without_design_md_file("no-design-md");
        let entries = list_design_md_entries_impl(&root).expect("list should succeed");
        cleanup(&root);

        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn list_entries_is_sorted() {
        let root = setup_cache_with_entries("sorted-entries");
        let entries = list_design_md_entries_impl(&root).expect("list should succeed");
        cleanup(&root);

        let titles: Vec<&str> = entries.iter().map(|e| e.title.as_str()).collect();
        assert!(titles
            .windows(2)
            .all(|w| w[0].to_lowercase() <= w[1].to_lowercase()));
    }

    // ── path resolution tests ──

    #[test]
    fn resolve_path_stays_inside_cache() {
        let root = setup_cache_with_entries("path-resolution");
        let resolved = resolve_design_md_entry_path(&root, "opencode.ai").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let canonical_resolved = resolved.canonicalize().unwrap();
        assert!(canonical_resolved.starts_with(&canonical_root));
        cleanup(&root);
    }

    #[test]
    fn resolve_path_rejects_traversal_slug() {
        let root = setup_cache_with_entries("path-traversal");
        let result = resolve_design_md_entry_path(&root, "../etc/passwd");
        cleanup(&root);
        assert!(result.is_err());
    }

    #[test]
    fn read_entry_rejects_invalid_slug() {
        let result = read_design_md_entry("../etc/passwd".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid slug"));
    }

    #[test]
    fn read_entry_rejects_empty_slug() {
        let result = read_design_md_entry("".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_entry_rejects_dot_slug() {
        let result = read_design_md_entry(".".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_entry_rejects_double_dot_slug() {
        let result = read_design_md_entry("..".to_string());
        assert!(result.is_err());
    }

    // ── entry reading tests ──

    #[test]
    fn read_entry_returns_content() {
        let root = setup_cache_with_entries("read-entry");
        let content =
            read_design_md_entry_from_cache(&root, "opencode.ai").expect("read should succeed");
        cleanup(&root);

        assert_eq!(content.slug, "opencode.ai");
        assert_eq!(content.title, "OpenCode.ai");
        assert_eq!(content.description, "AI coding agent configuration");
        assert!(content.path.ends_with("design-md/opencode.ai/DESIGN.md"));
        assert!(content.content.contains("# OpenCode.ai"));
    }

    // ── cache validation tests ──

    #[test]
    fn normalize_git_url_strips_prefixes() {
        assert_eq!(
            normalize_git_url("https://github.com/VoltAgent/awesome-design-md.git"),
            "github.com/voltagent/awesome-design-md"
        );
        assert_eq!(
            normalize_git_url("git@github.com:VoltAgent/awesome-design-md.git"),
            "github.com/voltagent/awesome-design-md"
        );
        assert_eq!(
            normalize_git_url("https://github.com/VoltAgent/awesome-design-md"),
            "github.com/voltagent/awesome-design-md"
        );
    }

    #[test]
    fn chrono_lite_produces_valid_format() {
        let result = chrono_lite(0);
        assert_eq!(result.len(), 15);
        assert_eq!(&result[8..9], "-");
    }

    // ── install plan tests ──

    #[test]
    fn install_plan_create_when_no_design_md_exists() {
        let root = setup_cache_with_entries("install-plan-create");
        let plan =
            plan_install_design_md_impl(&root, "opencode.ai", root.to_string_lossy().as_ref())
                .expect("plan should succeed");
        cleanup(&root);
        assert!(plan.ok);
        assert_eq!(plan.action, "create");
        assert!(!plan.existing);
        assert!(plan.existing_size.is_none());
        assert!(plan.backup_path.is_none());
    }

    #[test]
    fn install_plan_replace_with_backup_when_design_md_exists() {
        let root = setup_cache_with_entries("install-plan-replace");
        let existing = root.join(DESIGN_MD_FILE);
        std::fs::write(&existing, "# Old content\n").expect("write existing");
        let plan =
            plan_install_design_md_impl(&root, "opencode.ai", root.to_string_lossy().as_ref())
                .expect("plan should succeed");
        cleanup(&root);
        assert!(plan.ok);
        assert_eq!(plan.action, "replace_with_backup");
        assert!(plan.existing);
        assert!(plan.existing_size.is_some());
        assert!(plan.backup_path.is_some());
    }

    #[test]
    fn install_plan_rejects_invalid_slug() {
        let root = temp_root("plan-invalid-slug");
        std::fs::create_dir_all(&root).expect("create test dir");
        let result = plan_install_design_md_impl(&root, "../etc", "/tmp");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid slug"));
    }

    #[test]
    fn install_plan_rejects_empty_target_dir() {
        let root = temp_root("plan-empty-target");
        std::fs::create_dir_all(&root).expect("create test dir");
        let result = plan_install_design_md_impl(&root, "opencode.ai", "");
        cleanup(&root);
        if let Ok(plan) = result {
            assert!(!plan.ok);
            assert_eq!(plan.action, "blocked");
        }
    }

    #[test]
    fn install_plan_rejects_nonexistent_target_dir() {
        let root = setup_cache_with_entries("plan-noexist");
        let plan = plan_install_design_md_impl(
            &root,
            "opencode.ai",
            "/nonexistent/path/that/does/not/exist",
        )
        .expect("plan should handle nonexistent target");
        cleanup(&root);
        assert!(!plan.ok);
        assert_eq!(plan.action, "blocked");
    }

    #[test]
    fn install_plan_returns_blocked_for_root() {
        let root = temp_root("plan-root");
        std::fs::create_dir_all(&root).expect("create test dir");
        let plan = plan_install_design_md_impl(&root, "opencode.ai", "/")
            .expect("plan should handle root");
        cleanup(&root);
        assert!(!plan.ok);
        assert_eq!(plan.action, "blocked");
    }

    // ── install execution tests ──

    #[test]
    fn install_creates_design_md() {
        let cache_root = setup_cache_with_entries("install-create");
        let target_dir = temp_root("install-create-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");

        let result = install_design_md_impl(
            &cache_root,
            "opencode.ai",
            target_dir.to_string_lossy().as_ref(),
        )
        .expect("install should succeed");

        assert!(result.success);
        assert_eq!(result.action, "create");
        assert!(result.backup_path.is_none());

        let target_file = Path::new(&result.target_file);
        assert!(target_file.exists());

        cleanup(&cache_root);
        cleanup(&target_dir);
    }

    #[test]
    fn install_backs_up_existing_before_replace() {
        let cache_root = setup_cache_with_entries("install-replace");
        let target_dir = temp_root("install-replace-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");
        let existing = target_dir.join(DESIGN_MD_FILE);
        std::fs::write(&existing, "# Old content\n").expect("write existing");

        let result = install_design_md_impl(
            &cache_root,
            "opencode.ai",
            target_dir.to_string_lossy().as_ref(),
        )
        .expect("install should succeed");

        assert!(result.success);
        assert_eq!(result.action, "replace_with_backup");
        assert!(result.backup_path.is_some());

        if let Some(ref bp) = result.backup_path {
            let backup_path = Path::new(bp);
            assert!(backup_path.exists(), "backup file should exist at {}", bp);
        }

        cleanup(&cache_root);
        cleanup(&target_dir);
    }

    #[test]
    fn install_rejects_invalid_slug() {
        let target_dir = temp_root("install-bad-slug-target");
        std::fs::create_dir_all(&target_dir).expect("create dir");
        let result =
            install_design_md_impl(&target_dir, "../etc", target_dir.to_string_lossy().as_ref());
        cleanup(&target_dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid slug"));
    }

    #[test]
    fn install_rejects_root_target() {
        let root = temp_root("install-root-target");
        std::fs::create_dir_all(&root).expect("create dir");
        let result = install_design_md_impl(&root, "opencode.ai", "/");
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsafe target"));
    }

    #[test]
    fn install_rejects_home_target() {
        let root = temp_root("install-home-target");
        std::fs::create_dir_all(&root).expect("create dir");
        let home = std::env::var("HOME").unwrap_or_else(|_| "/nonexistent".to_string());
        if home.is_empty() || home == "/" {
            cleanup(&root);
            return;
        }
        let result = install_design_md_impl(&root, "opencode.ai", &home);
        cleanup(&root);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unsafe target"));
    }

    #[test]
    fn install_rejects_system_dir() {
        let cache_root = temp_root("install-system-cache");
        std::fs::create_dir_all(&cache_root).expect("create dir");
        for dir in &["/System", "/bin", "/usr", "/etc"] {
            let result = install_design_md_impl(&cache_root, "opencode.ai", dir);
            assert!(result.is_err(), "should reject {}", dir);
            let err = result.unwrap_err();
            assert!(
                err.contains("unsafe target") || err.contains("does not exist"),
                "expected unsafe or nonexistent error for {}, got: {}",
                dir,
                err
            );
        }
        cleanup(&cache_root);
    }

    // ── install message tests ──

    #[test]
    fn install_message_create_is_readable() {
        let cache_root = setup_cache_with_entries("msg-create");
        let target_dir = temp_root("msg-create-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");
        let result = install_design_md_impl(
            &cache_root,
            "opencode.ai",
            target_dir.to_string_lossy().as_ref(),
        )
        .expect("install should succeed");
        cleanup(&cache_root);
        cleanup(&target_dir);
        assert_eq!(result.action, "create");
        assert!(
            result.message.contains("installed"),
            "expected 'installed' in message, got: {}",
            result.message
        );
        assert!(
            !result.message.contains("created"),
            "message should not contain raw action name"
        );
    }

    #[test]
    fn install_message_replace_is_readable() {
        let cache_root = setup_cache_with_entries("msg-replace");
        let target_dir = temp_root("msg-replace-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");
        let existing = target_dir.join(DESIGN_MD_FILE);
        std::fs::write(&existing, "# Old\n").expect("write existing");
        let result = install_design_md_impl(
            &cache_root,
            "opencode.ai",
            target_dir.to_string_lossy().as_ref(),
        )
        .expect("install should succeed");
        cleanup(&cache_root);
        cleanup(&target_dir);
        assert_eq!(result.action, "replace_with_backup");
        assert!(
            result.message.contains("replaced"),
            "expected 'replaced' in message, got: {}",
            result.message
        );
        assert!(
            result.message.contains("backup"),
            "expected 'backup' in message, got: {}",
            result.message
        );
    }

    // ── backup collision tests ──

    #[test]
    fn backup_path_avoids_collision_when_exists() {
        // Create a fake existing backup to trigger collision avoidance
        let target_dir = temp_root("backup-collision");
        let target_file = target_dir.join(DESIGN_MD_FILE);

        // Create a fake backup file that would match the timestamp
        let bp1 = create_backup_path(&target_file);
        std::fs::create_dir_all(&target_dir).expect("create dir");
        std::fs::write(&bp1, "fake backup").expect("write fake backup");
        assert!(bp1.exists());

        // Create another backup — should get a different path
        let bp2 = create_backup_path(&target_file);
        assert_ne!(bp1, bp2, "backup paths should differ when first exists");

        cleanup(&target_dir);
    }

    // ── UTF-8 truncation tests ──

    #[test]
    fn truncation_utf8_safe_with_multibyte() {
        // Swedish letters with a and ring (å = 2 bytes)
        let swedish = "å".repeat(300); // 600 bytes, 300 chars
        let result = truncate_description(&swedish);
        assert!(result.len() <= 220);
        // Should not panic regardless of where the byte boundary falls
        assert!(!result.is_empty());
    }

    #[test]
    fn truncation_utf8_safe_with_em_dash() {
        // Em dash (—) is 3 bytes in UTF-8 — embed it in a long string to force truncation
        let prefix = "a".repeat(250);
        let dash = "—";
        let input = format!("{} {} rest", prefix, dash);
        let result = truncate_description(&input);
        assert!(result.len() <= 220);
        // The result should end with ellipsis or be the short string
        if result.len() < input.len() {
            assert!(
                result.ends_with('…'),
                "truncated result should end with ellipsis, got: {:?}",
                result
            );
        }
    }

    #[test]
    fn truncation_short_string_unchanged() {
        let short = "Hello world";
        let result = truncate_description(short);
        assert_eq!(result, short);
    }

    // ── URL normalization tests ──

    #[test]
    fn url_normalization_accepts_https() {
        assert_eq!(
            normalize_git_url("https://github.com/VoltAgent/awesome-design-md.git"),
            "github.com/voltagent/awesome-design-md"
        );
    }

    #[test]
    fn url_normalization_accepts_https_no_dot_git() {
        assert_eq!(
            normalize_git_url("https://github.com/VoltAgent/awesome-design-md"),
            "github.com/voltagent/awesome-design-md"
        );
    }

    #[test]
    fn url_normalization_accepts_git_at() {
        assert_eq!(
            normalize_git_url("git@github.com:VoltAgent/awesome-design-md.git"),
            "github.com/voltagent/awesome-design-md"
        );
    }

    #[test]
    fn url_normalization_accepts_ssh() {
        assert_eq!(
            normalize_git_url("ssh://git@github.com/VoltAgent/awesome-design-md.git"),
            "github.com/voltagent/awesome-design-md"
        );
    }

    #[test]
    fn url_normalization_rejects_unrelated() {
        let other = normalize_git_url("https://github.com/other/repo.git");
        let expected = normalize_git_url(REPO_URL);
        assert_ne!(other, expected, "unrelated repo should not match");
    }

    #[test]
    fn url_normalization_handles_trailing_slash() {
        assert_eq!(
            normalize_git_url("https://github.com/VoltAgent/awesome-design-md/"),
            "github.com/voltagent/awesome-design-md"
        );
        assert_eq!(
            normalize_git_url("https://github.com/VoltAgent/awesome-design-md.git/"),
            "github.com/voltagent/awesome-design-md"
        );
    }

    // ── install status tests ──

    #[test]
    fn install_status_no_target_for_empty_dir() {
        let result = get_design_md_install_status("opencode.ai".to_string(), "".to_string())
            .expect("should succeed");
        assert_eq!(result.status, "no_target");
        assert!(!result.exists);
        assert!(!result.matches_selected);
    }

    #[test]
    fn install_status_missing_when_no_design_md() {
        let cache_root = setup_cache_with_entries("status-missing");
        let target_dir = temp_root("status-missing-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");
        let result = get_design_md_install_status(
            "opencode.ai".to_string(),
            target_dir.to_string_lossy().into_owned(),
        )
        .expect("should succeed");
        cleanup(&cache_root);
        cleanup(&target_dir);
        assert_eq!(result.status, "missing");
        assert!(!result.exists);
        assert!(!result.matches_selected);
    }

    #[test]
    fn install_status_installed_when_content_matches() {
        let cache_root = setup_cache_with_entries("status-installed");
        let target_dir = temp_root("status-installed-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");
        let source_path = cache_root.join(DESIGN_MD_DIR).join("opencode.ai").join(DESIGN_MD_FILE);
        let source_content = std::fs::read_to_string(&source_path).expect("read source");
        let target_file = target_dir.join(DESIGN_MD_FILE);
        std::fs::write(&target_file, &source_content).expect("write target");
        let result = get_design_md_install_status_impl(
            &cache_root,
            "opencode.ai",
            target_dir.to_string_lossy().as_ref(),
        ).expect("should succeed");
        cleanup(&cache_root);
        cleanup(&target_dir);
        assert_eq!(result.status, "installed");
        assert!(result.exists);
        assert!(result.matches_selected);
        assert!(result.size.is_some());
    }

    #[test]
    fn install_status_different_when_content_differs() {
        let cache_root = setup_cache_with_entries("status-different");
        let target_dir = temp_root("status-different-target");
        std::fs::create_dir_all(&target_dir).expect("create target dir");
        let target_file = target_dir.join(DESIGN_MD_FILE);
        std::fs::write(&target_file, "# Different content\n").expect("write target");
        let result = get_design_md_install_status(
            "opencode.ai".to_string(),
            target_dir.to_string_lossy().into_owned(),
        )
        .expect("should succeed");
        cleanup(&cache_root);
        cleanup(&target_dir);
        assert_eq!(result.status, "different");
        assert!(result.exists);
        assert!(!result.matches_selected);
    }

    #[test]
    fn install_status_blocked_for_unsafe_target() {
        let result = get_design_md_install_status("opencode.ai".to_string(), "/System".to_string())
            .expect("should handle blocked");
        assert_eq!(result.status, "blocked");
    }

    // ── open command tests ──

    #[test]
    fn open_installed_design_md_rejects_missing_file() {
        let target_dir = temp_root("open-missing-target");
        std::fs::create_dir_all(&target_dir).expect("create temp dir");
        let result = open_installed_design_md(target_dir.to_string_lossy().into_owned());
        cleanup(&target_dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn open_commands_reject_unsafe_target() {
        let result = open_design_md_target_folder("/".to_string());
        assert!(result.is_err());
        let result2 = open_installed_design_md("/System".to_string());
        assert!(result2.is_err());
    }

    // ── helper for testing read_design_md_entry without command wrapper ──

    fn read_design_md_entry_from_cache(
        cache: &Path,
        slug: &str,
    ) -> Result<DesignMdContent, String> {
        if !is_valid_design_md_slug(slug) {
            return Err(format!("invalid slug: {}", slug));
        }
        read_design_md_entry_impl(cache, slug)
    }
}
