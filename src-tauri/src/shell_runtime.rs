use std::path::Path;

/// Strip Windows extended-length path prefix (`\\?\` or `//?/`).
#[cfg(test)]
pub fn strip_windows_extended_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path)
}

#[cfg(test)]
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
#[cfg(test)]
pub fn path_arg_for_bash(path: &Path) -> Result<String, String> {
    let raw = path
        .to_str()
        .ok_or_else(|| "path is not valid UTF-8".to_string())?;
    Ok(to_bash_path_string(raw))
}

/// Bash-safe path for environment variables passed to bash scripts.
#[cfg(test)]
pub fn env_path_for_bash(path: &Path) -> String {
    path_arg_for_bash(path).unwrap_or_else(|_| to_bash_path_string(&path.to_string_lossy()))
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
        let path =
            Path::new(r"\\?\C:\Users\Example\.config\riggverk\scripts\generate-opencode-config.py");
        assert_eq!(
            path_arg_for_bash(path).expect("bash path"),
            "C:/Users/Example/.config/riggverk/scripts/generate-opencode-config.py"
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
        let path = Path::new(r"C:\Users\me\My Workspace\generate-opencode-config.py");
        let bash_path = path_arg_for_bash(path).expect("bash path");
        assert_eq!(
            bash_path,
            "C:/Users/me/My Workspace/generate-opencode-config.py"
        );
        assert!(bash_path.contains(' '));
        assert!(!bash_path.starts_with(r"\\?\"));
    }

    #[test]
    fn native_process_path_preserves_extended_prefix() {
        let path =
            Path::new(r"\\?\C:\Users\Example\.config\riggverk\scripts\generate-opencode-config.py");
        assert_eq!(
            path_arg_for_native_process(path).expect("native path"),
            r"\\?\C:\Users\Example\.config\riggverk\scripts\generate-opencode-config.py"
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
}
