use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
pub struct ActionResult {
    success: bool,
    action: String,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
}

impl ActionResult {
    pub(crate) fn new(
        success: bool,
        action: impl Into<String>,
        stdout: String,
        stderr: String,
        exit_code: Option<i32>,
    ) -> Self {
        Self {
            success,
            action: action.into(),
            stdout,
            stderr,
            exit_code,
        }
    }
}

pub(super) fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> (bool, String, String, Option<i32>) {
    let output = Command::new(program).args(args).current_dir(cwd).output();

    match output {
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

pub(super) fn run_cmd_owned(
    program: &str,
    args: &[String],
    cwd: &Path,
) -> (bool, String, String, Option<i32>) {
    let output = Command::new(program).args(args).current_dir(cwd).output();

    match output {
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
