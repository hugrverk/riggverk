use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

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
        // Clone for the first time
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

    // Cache exists — fetch and update
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

    let resolved_path = resolve_design_md_entry_path(&cache, &slug)?;

    // Security: verify the resolved path stays inside the cache
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

    let (title, description) = parse_design_md_frontmatter(&content, &slug);
    let rel_path = format!("{}/{}/{}", DESIGN_MD_DIR, slug, DESIGN_MD_FILE);

    Ok(DesignMdContent {
        slug,
        title,
        description,
        path: rel_path,
        content,
    })
}

// ── validation ──

fn is_valid_design_md_slug(slug: &str) -> bool {
    if slug.is_empty() {
        return false;
    }
    // Reject slugs containing path traversal or separators
    if slug.contains("..") {
        return false;
    }
    if slug.contains('/') || slug.contains('\\') {
        return false;
    }
    // Reject absolute path patterns
    if slug.starts_with('/') || slug.starts_with('\\') {
        return false;
    }
    // Allow letters, digits, dots, hyphens — common in tool/project slugs
    for c in slug.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => {}
            _ => return false,
        }
    }
    // Reject slugs that are just dots
    if slug.chars().all(|c| c == '.') {
        return false;
    }
    true
}

// ── path resolution ──

fn resolve_design_md_entry_path(cache: &Path, slug: &str) -> Result<PathBuf, String> {
    let rel = format!("{}/{}/{}", DESIGN_MD_DIR, slug, DESIGN_MD_FILE);
    let rel_path = Path::new(&rel);

    // Defensive: ensure the relative path does not contain traversal
    if rel.contains("..") || rel_path.is_absolute() {
        return Err("invalid slug: traversal detected".to_string());
    }

    Ok(cache.join(rel))
}

// ── frontmatter parsing ──

/// Parses minimal YAML frontmatter from DESIGN.md content.
///
/// Expects frontmatter delimited by `---` lines:
///   ---
///   name: Some Name
///   description: Some description
///   ---
///
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
            // "---" followed by nothing or whitespace on the same line
            // Try without newline
            if after_opening.trim().is_empty() {
                // "---" and then nothing useful
                return (slug.to_string(), String::new());
            }
            after_opening
        }
    };

    // Find the closing "---"
    let fm_body = match after_newline.split("\n---").next() {
        Some(body) => body,
        None => return (slug.to_string(), String::new()),
    };

    let mut name = String::new();
    let mut description = String::new();

    for line in fm_body.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() {
            continue;
        }

        if let Some(value) = trimmed_line.strip_prefix("name:") {
            name = value.trim().to_string();
        } else if let Some(value) = trimmed_line.strip_prefix("description:") {
            // The description might span multiple lines (indented continuation).
            // Take the first line value and optionally append continuation lines.
            let first = value.trim().to_string();
            description = first;
            // We don't support multi-line descriptions in this minimal parser
            // to keep it simple. Multi-line would need indent tracking.
        }
    }

    let title = if name.is_empty() {
        slug.to_string()
    } else {
        name
    };

    (title, description)
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
        // Create a fake cache with design-md/ dirs
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
        // No DESIGN.md file
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
        // Compact YAML format (no newline after opening ---) is valid;
        // the parser correctly extracts the name
        assert_eq!(title, "Test");
        assert_eq!(desc, "");
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
        // Sorted by lowercase title
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

    // ── helper for testing read_design_md_entry without command wrapper ──

    fn read_design_md_entry_from_cache(
        cache: &Path,
        slug: &str,
    ) -> Result<DesignMdContent, String> {
        if !is_valid_design_md_slug(slug) {
            return Err(format!("invalid slug: {}", slug));
        }

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

        let content = std::fs::read_to_string(&canonical_resolved)
            .map_err(|e| format!("read error: {}", e))?;

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
}
