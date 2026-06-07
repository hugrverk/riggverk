use std::path::Path;

#[cfg(windows)]
use std::path::PathBuf;

use crate::executable_resolver::resolve_executable;

/// Strip Windows extended-length path prefix (`\\?\` or `//?/`).
pub fn strip_windows_extended_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path)
}

fn to_bash_path_string(raw: &str) -> String {
    strip_windows_extended_prefix(raw).replace('\\', "/")
}

/// Native Windows/Unix path string for `Command::new` and other native process APIs.
pub fn path_arg_for_native_process(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "path is not valid UTF-8".to_string())
}

/// Bash-safe script argument path: strip `\\?\`, use forward slashes.
pub fn path_arg_for_bash(path: &Path) -> Result<String, String> {
    let raw = path
        .to_str()
        .ok_or_else(|| "path is not valid UTF-8".to_string())?;
    Ok(to_bash_path_string(raw))
}

/// Bash-safe path for environment variables passed to bash scripts.
pub fn env_path_for_bash(path: &Path) -> String {
    path_arg_for_bash(path).unwrap_or_else(|_| to_bash_path_string(&path.to_string_lossy()))
}

/// Resolve bash for workspace shell scripts. On Windows, checks Git for Windows install paths.
pub fn resolve_bash() -> Result<String, String> {
    if program_available("bash") {
        return Ok("bash".into());
    }

    #[cfg(windows)]
    {
        for candidate in git_bash_candidates() {
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }

    Err(bash_missing_message())
}

/// Resolve Python for workspace scripts (`python3` preferred, `python` fallback).
pub fn resolve_python() -> Result<String, String> {
    if let Ok(from_env) = std::env::var("AW_PYTHON") {
        if !from_env.trim().is_empty() && program_available(&from_env) {
            return Ok(from_env);
        }
    }

    if program_available("python3") {
        return Ok("python3".into());
    }

    if program_available("python") {
        return Ok("python".into());
    }

    Err(python_missing_message())
}

pub fn format_spawn_error(program: &str, error: &std::io::Error) -> String {
    let kind = error.kind();
    let raw = error.to_string();
    let looks_missing = kind == std::io::ErrorKind::NotFound
        || raw.to_ascii_lowercase().contains("not found")
        || raw.to_ascii_lowercase().contains("no such file");

    if looks_missing {
        if program.contains("bash") || program == "bash" {
            return bash_missing_message();
        }
        if program.contains("python") {
            return python_missing_message();
        }
        return format!(
            "required program not found: {program}. Ensure it is installed and on PATH."
        );
    }

    format!("failed to run {program}: {raw}")
}

fn path_env_value() -> String {
    std::env::var("PATH").unwrap_or_default()
}

fn program_available(program: &str) -> bool {
    let path_env = path_env_value();
    let pathext = if cfg!(windows) {
        std::env::var("PATHEXT").ok()
    } else {
        None
    };
    resolve_executable(program, &path_env, pathext.as_deref()).is_some()
}

#[cfg(windows)]
fn git_bash_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }

    candidates
}

fn bash_missing_message() -> String {
    #[cfg(windows)]
    {
        "bash is required to run Cursor workspace scripts. Install Git for Windows (Git Bash) or add bash.exe to PATH (for example C:\\Program Files\\Git\\bin\\bash.exe).".into()
    }
    #[cfg(not(windows))]
    {
        "bash is required to run Cursor workspace scripts. Install bash and ensure it is on PATH."
            .into()
    }
}

fn python_missing_message() -> String {
    "python3 or python is required for Cursor profile scripts. Install Python 3 and ensure python or python3 is on PATH.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn extended_windows_path_becomes_forward_slash_for_bash() {
        let path = Path::new(
            r"\\?\C:\Users\me\.config\agent-workspace\scripts\install-cursor-workspace.sh",
        );
        assert_eq!(
            path_arg_for_bash(path).expect("bash path"),
            "C:/Users/me/.config/agent-workspace/scripts/install-cursor-workspace.sh"
        );
    }

    #[test]
    fn windows_path_becomes_forward_slash_for_bash() {
        let path = Path::new(r"C:\Users\me\.cursor\mcp.json");
        assert_eq!(
            path_arg_for_bash(path).expect("bash path"),
            "C:/Users/me/.cursor/mcp.json"
        );
    }

    #[test]
    fn path_with_spaces_stays_single_bash_argument_string() {
        let path = Path::new(r"C:\Users\me\My Workspace\install-cursor-workspace.sh");
        let bash_path = path_arg_for_bash(path).expect("bash path");
        assert_eq!(
            bash_path,
            "C:/Users/me/My Workspace/install-cursor-workspace.sh"
        );
        assert!(bash_path.contains(' '));
        assert!(!bash_path.starts_with(r"\\?\"));
    }

    #[test]
    fn native_process_path_preserves_extended_prefix() {
        let path = Path::new(
            r"\\?\C:\Users\me\.config\agent-workspace\scripts\install-cursor-workspace.sh",
        );
        assert_eq!(
            path_arg_for_native_process(path).expect("native path"),
            r"\\?\C:\Users\me\.config\agent-workspace\scripts\install-cursor-workspace.sh"
        );
    }

    #[test]
    fn unix_paths_unchanged_for_bash_except_separator_normalize() {
        let path = Path::new("/home/user/.cursor/mcp.json");
        assert_eq!(
            path_arg_for_bash(path).expect("bash path"),
            "/home/user/.cursor/mcp.json"
        );
    }

    #[test]
    fn bash_missing_message_names_bash_on_windows() {
        let message = bash_missing_message();
        assert!(message.contains("bash"));
        #[cfg(windows)]
        assert!(message.contains("Git"));
    }

    #[test]
    fn python_missing_message_names_python() {
        let message = python_missing_message();
        assert!(message.contains("python"));
    }

    #[test]
    fn format_spawn_error_maps_bash_not_found() {
        let error = std::io::Error::new(std::io::ErrorKind::NotFound, "program not found");
        let message = format_spawn_error("bash", &error);
        assert!(message.contains("bash"));
        assert!(!message.eq("program not found"));
    }

    #[test]
    fn resolve_python_prefers_python3_when_available() {
        if program_available("python3") {
            assert_eq!(resolve_python().expect("python3"), "python3");
        } else if program_available("python") {
            assert_eq!(resolve_python().expect("python"), "python");
        }
    }
}
