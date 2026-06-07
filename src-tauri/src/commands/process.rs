use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::shell_runtime::format_spawn_error;

#[derive(Serialize, Debug)]
pub struct ActionResult {
    pub(crate) success: bool,
    pub(crate) action: String,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: Option<i32>,
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

#[derive(Debug, Clone)]
pub(super) struct BoundedCmdOptions {
    pub timeout: Option<Duration>,
    pub stdout_cap: usize,
    pub stderr_cap: usize,
    pub extra_env: Vec<(String, String)>,
}

impl Default for BoundedCmdOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            stdout_cap: 16 * 1024 * 1024,
            stderr_cap: 512 * 1024,
            extra_env: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct BoundedCmdResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

fn read_capped(mut reader: impl Read, cap: usize) -> (String, bool) {
    let mut buf = Vec::with_capacity(cap.min(8192));
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut chunk).unwrap_or(0);
        if read == 0 {
            break;
        }
        let remaining = cap.saturating_sub(buf.len());
        if read <= remaining {
            buf.extend_from_slice(&chunk[..read]);
        } else {
            buf.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            while reader.read(&mut chunk).unwrap_or(0) > 0 {}
            break;
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), truncated)
}

pub(super) fn run_cmd_bounded(
    program: &str,
    args: &[&str],
    cwd: &Path,
    options: BoundedCmdOptions,
) -> BoundedCmdResult {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &options.extra_env {
        command.env(key, value);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return BoundedCmdResult {
                success: false,
                stdout: String::new(),
                stderr: format_spawn_error(program, &error),
                exit_code: None,
                timed_out: false,
                stdout_truncated: false,
                stderr_truncated: false,
            };
        }
    };

    let stdout_cap = options.stdout_cap;
    let stderr_cap = options.stderr_cap;
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || {
        stdout_handle
            .map(|out| read_capped(out, stdout_cap))
            .unwrap_or_default()
    });
    let stderr_thread = std::thread::spawn(move || {
        stderr_handle
            .map(|err| read_capped(err, stderr_cap))
            .unwrap_or_default()
    });

    let (status, timed_out) = if let Some(timeout) = options.timeout {
        let started = Instant::now();
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if started.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        timed_out = true;
                        break None;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break None,
            }
        };
        (status, timed_out)
    } else {
        (child.wait().ok(), false)
    };
    let (stdout, stdout_truncated) = stdout_thread.join().unwrap_or_default();
    let (stderr, stderr_truncated) = stderr_thread.join().unwrap_or_default();

    BoundedCmdResult {
        success: !timed_out && status.as_ref().is_some_and(|s| s.success()),
        stdout,
        stderr,
        exit_code: status.and_then(|s| s.code()),
        timed_out,
        stdout_truncated,
        stderr_truncated,
    }
}

pub(super) fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> (bool, String, String, Option<i32>) {
    let result = run_cmd_bounded(program, args, cwd, BoundedCmdOptions::default());
    (
        result.success,
        result.stdout,
        result.stderr,
        result.exit_code,
    )
}

#[allow(dead_code)]
pub(super) fn run_cmd_owned(
    program: &str,
    args: &[String],
    cwd: &Path,
) -> (bool, String, String, Option<i32>) {
    run_cmd_owned_env(program, args, cwd, &[])
}

pub(super) fn run_cmd_owned_env(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
) -> (bool, String, String, Option<i32>) {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_cmd_bounded(
        program,
        &arg_refs,
        cwd,
        BoundedCmdOptions {
            extra_env: env.to_vec(),
            ..BoundedCmdOptions::default()
        },
    );
    (
        result.success,
        result.stdout,
        result.stderr,
        result.exit_code,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_runtime::format_spawn_error;
    use std::process::{Command as StdCommand, Stdio as StdStdio};

    #[test]
    fn format_spawn_error_for_missing_bash_is_actionable() {
        let error = std::io::Error::new(std::io::ErrorKind::NotFound, "program not found");
        let message = format_spawn_error("bash", &error);
        assert!(message.contains("bash"));
        assert!(!message.eq("program not found"));
    }

    #[test]
    fn bounded_cmd_truncates_stdout() {
        let result = run_cmd_bounded(
            "python3",
            &["-c", "print('x' * 2000)"],
            Path::new("."),
            BoundedCmdOptions {
                stdout_cap: 128,
                stderr_cap: 128,
                ..BoundedCmdOptions::default()
            },
        );
        assert!(result.success);
        assert!(result.stdout_truncated);
        assert!(result.stdout.len() <= 128);
    }

    #[test]
    fn bounded_cmd_times_out() {
        let result = run_cmd_bounded(
            "python3",
            &["-c", "import time; time.sleep(5)"],
            Path::new("."),
            BoundedCmdOptions {
                timeout: Some(Duration::from_millis(200)),
                stdout_cap: 1024,
                stderr_cap: 1024,
                ..BoundedCmdOptions::default()
            },
        );
        assert!(result.timed_out);
        assert!(!result.success);
    }

    #[test]
    fn bounded_cmd_reads_stderr_separately() {
        let mut child = StdCommand::new("python3")
            .args(["-c", "import sys; sys.stderr.write('warn')"])
            .stdout(StdStdio::piped())
            .stderr(StdStdio::piped())
            .spawn()
            .expect("spawn");
        let stderr = child.stderr.take().expect("stderr");
        let (text, truncated) = read_capped(stderr, 64);
        let _ = child.wait();
        assert_eq!(text, "warn");
        assert!(!truncated);
    }
}
