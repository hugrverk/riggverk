use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use crate::shell_runtime::format_spawn_error;

/// Timeout applied by `run_cmd` to short helper spawns (`open`, `git`, scripts).
pub(super) const DEFAULT_RUN_CMD_TIMEOUT: Duration = Duration::from_secs(120);
/// Time a timed-out process tree gets to exit after SIGTERM before SIGKILL.
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(1);
/// Time output readers get to reach EOF once the child exited or was killed.
const DEFAULT_DRAIN_GRACE: Duration = Duration::from_secs(2);
const MAX_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[cfg(unix)]
const GIT_NULL_HOOKS_PATH: &str = "/dev/null";
#[cfg(not(unix))]
const GIT_NULL_HOOKS_PATH: &str = "NUL";

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
    /// How long output readers may keep waiting for EOF once the child is gone.
    /// A background process that inherited the pipes must not stall the caller.
    pub drain_grace: Duration,
}

impl Default for BoundedCmdOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            stdout_cap: 16 * 1024 * 1024,
            stderr_cap: 512 * 1024,
            extra_env: Vec::new(),
            drain_grace: DEFAULT_DRAIN_GRACE,
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
}

#[derive(Default)]
struct ReadOutput {
    buf: Vec<u8>,
    error: Option<String>,
}

fn lock_output(output: &Mutex<ReadOutput>) -> MutexGuard<'_, ReadOutput> {
    output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_capped_into(mut reader: impl Read, cap: usize, sink: &Mutex<ReadOutput>) {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                let mut out = lock_output(sink);
                let remaining = cap.saturating_sub(out.buf.len());
                if read <= remaining {
                    out.buf.extend_from_slice(&chunk[..read]);
                } else {
                    out.buf.extend_from_slice(&chunk[..remaining]);
                    drop(out);
                    while matches!(reader.read(&mut chunk), Ok(n) if n > 0) {}
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                lock_output(sink).error = Some(error.to_string());
                return;
            }
        }
    }
}

struct OutputReader {
    output: Arc<Mutex<ReadOutput>>,
    done: mpsc::Receiver<()>,
}

impl OutputReader {
    fn spawn(reader: Option<impl Read + Send + 'static>, cap: usize) -> Self {
        let output = Arc::new(Mutex::new(ReadOutput::default()));
        let (done_tx, done) = mpsc::channel();
        if let Some(reader) = reader {
            let sink = Arc::clone(&output);
            thread::spawn(move || {
                read_capped_into(reader, cap, &sink);
                let _ = done_tx.send(());
            });
        }
        Self { output, done }
    }

    /// Returns what was read so far. If the stream is still open at `deadline` the
    /// reader thread is left to finish on its own.
    fn finish(self, deadline: Instant) -> ReadOutput {
        let remaining = deadline.saturating_duration_since(Instant::now());
        // A timeout here means a surviving background process still holds the pipe.
        let _ = self.done.recv_timeout(remaining);
        std::mem::take(&mut *lock_output(&self.output))
    }
}

#[cfg(unix)]
fn signal_process_group(pgid: i32, signal: i32) {
    extern "C" {
        fn killpg(pgrp: i32, sig: i32) -> i32;
    }
    // SAFETY: killpg takes two plain integers and has no memory-safety preconditions.
    // An already-gone group only yields ESRCH, which is ignored.
    unsafe {
        killpg(pgid, signal);
    }
}

/// Stops the child and everything it spawned (the child leads its own process group on unix).
fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        const SIGTERM: i32 = 15;
        const SIGKILL: i32 = 9;
        let pgid = child.id() as i32;
        // SIGTERM first so git and similar tools can remove their lock files.
        signal_process_group(pgid, SIGTERM);
        let deadline = Instant::now() + TERMINATE_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        signal_process_group(pgid, SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn wait_for_exit(child: &mut Child, timeout: Option<Duration>) -> (Option<ExitStatus>, bool) {
    let Some(timeout) = timeout else {
        return (child.wait().ok(), false);
    };
    let started = Instant::now();
    let mut interval = Duration::from_millis(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (Some(status), false),
            Ok(None) if started.elapsed() >= timeout => {
                terminate_process_tree(child);
                return (None, true);
            }
            Ok(None) => {
                thread::sleep(interval);
                interval = (interval * 2).min(MAX_POLL_INTERVAL);
            }
            Err(_) => {
                terminate_process_tree(child);
                return (None, false);
            }
        }
    }
}

fn push_note(text: &mut String, note: &str) {
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(note);
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group so a timeout can stop grandchildren that hold the pipes.
        command.process_group(0);
    }
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
            };
        }
    };

    let stdout_reader = OutputReader::spawn(child.stdout.take(), options.stdout_cap);
    let stderr_reader = OutputReader::spawn(child.stderr.take(), options.stderr_cap);

    let (status, timed_out) = wait_for_exit(&mut child, options.timeout);

    let drain_deadline = Instant::now() + options.drain_grace;
    let stdout = stdout_reader.finish(drain_deadline);
    let stderr = stderr_reader.finish(drain_deadline);

    let mut stderr_text = String::from_utf8_lossy(&stderr.buf).into_owned();
    let mut read_failed = false;
    for (stream, error) in [("stdout", &stdout.error), ("stderr", &stderr.error)] {
        if let Some(error) = error {
            read_failed = true;
            push_note(
                &mut stderr_text,
                &format!("failed to read {program} {stream}: {error}"),
            );
        }
    }

    BoundedCmdResult {
        success: !timed_out && !read_failed && status.as_ref().is_some_and(|s| s.success()),
        stdout: String::from_utf8_lossy(&stdout.buf).into_owned(),
        stderr: stderr_text,
        exit_code: status.and_then(|s| s.code()),
        timed_out,
    }
}

/// `git` for repositories the user trusts, with a few repo-config execution paths turned off:
/// no fsmonitor or hooks from repo config, no credential prompts, and no optional locks
/// (`git status` must not take `index.lock` while the user works in the same repository).
///
/// This is not a sandbox for untrusted repositories. Still honored from repo config:
/// filter drivers (`filter.<name>.clean`/`process`, run by `git status` for modified
/// files), credential helpers, URL rewrites, and any other key not listed above. Transport
/// hardening (upload-pack, ssh command, protocols) is applied by the fetch caller. See
/// `docs/SECURITY_MODEL.md`.
pub(super) fn run_git_bounded(
    args: &[&str],
    cwd: &Path,
    mut options: BoundedCmdOptions,
) -> BoundedCmdResult {
    let hooks_path = format!("core.hooksPath={GIT_NULL_HOOKS_PATH}");
    let mut full_args: Vec<&str> = vec!["-c", "core.fsmonitor=false", "-c", &hooks_path];
    full_args.extend_from_slice(args);
    for (key, value) in [("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0")] {
        if !options
            .extra_env
            .iter()
            .any(|(existing, _)| existing == key)
        {
            options.extra_env.push((key.to_string(), value.to_string()));
        }
    }
    run_cmd_bounded("git", &full_args, cwd, options)
}

pub(super) fn run_cmd_with_timeout(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> (bool, String, String, Option<i32>) {
    let result = run_cmd_bounded(
        program,
        args,
        cwd,
        BoundedCmdOptions {
            timeout: Some(timeout),
            ..BoundedCmdOptions::default()
        },
    );
    let mut stderr = result.stderr;
    if result.timed_out {
        push_note(
            &mut stderr,
            &format!("command timed out after {}s", timeout.as_secs()),
        );
    }
    (result.success, result.stdout, stderr, result.exit_code)
}

pub(super) fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> (bool, String, String, Option<i32>) {
    run_cmd_with_timeout(program, args, cwd, DEFAULT_RUN_CMD_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell_runtime::format_spawn_error;

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
        assert_eq!(result.stdout.len(), 128);
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
        let result = run_cmd_bounded(
            "python3",
            &["-c", "import sys; sys.stderr.write('warn')"],
            Path::new("."),
            BoundedCmdOptions::default(),
        );
        assert!(result.success);
        assert_eq!(result.stderr, "warn");
        assert!(result.stdout.is_empty());
    }

    struct FailingReader {
        first: Option<Vec<u8>>,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            match self.first.take() {
                Some(bytes) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                None => Err(std::io::Error::other("boom")),
            }
        }
    }

    #[test]
    fn read_capped_reports_read_errors_instead_of_eof() {
        let sink = Mutex::new(ReadOutput::default());
        read_capped_into(
            FailingReader {
                first: Some(b"partial".to_vec()),
            },
            1024,
            &sink,
        );
        let out = lock_output(&sink);
        assert_eq!(out.buf, b"partial");
        assert_eq!(out.error.as_deref(), Some("boom"));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_grandchild_holding_the_pipe() {
        let started = Instant::now();
        let result = run_cmd_bounded(
            "sh",
            &["-c", "sleep 30 & sleep 30"],
            Path::new("."),
            BoundedCmdOptions {
                timeout: Some(Duration::from_secs(1)),
                ..BoundedCmdOptions::default()
            },
        );
        let elapsed = started.elapsed();
        assert!(result.timed_out);
        assert!(!result.success);
        assert!(
            elapsed < Duration::from_millis(2500),
            "timeout took {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn exited_child_with_lingering_background_process_does_not_stall() {
        let started = Instant::now();
        let result = run_cmd_bounded(
            "sh",
            &["-c", "echo hi; sleep 3 &"],
            Path::new("."),
            BoundedCmdOptions {
                timeout: Some(Duration::from_secs(10)),
                drain_grace: Duration::from_millis(200),
                ..BoundedCmdOptions::default()
            },
        );
        let elapsed = started.elapsed();
        assert!(result.success);
        assert_eq!(result.stdout, "hi\n");
        assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
    }

    #[cfg(unix)]
    #[test]
    fn child_stdin_is_null() {
        let result = run_cmd_bounded(
            "sh",
            &["-c", "cat"],
            Path::new("."),
            BoundedCmdOptions {
                timeout: Some(Duration::from_secs(5)),
                ..BoundedCmdOptions::default()
            },
        );
        assert!(result.success, "{result:?}");
        assert!(result.stdout.is_empty());
    }

    #[test]
    fn run_cmd_reports_timeout_in_stderr() {
        let (ok, _, stderr, _) = run_cmd_with_timeout(
            "python3",
            &["-c", "import time; time.sleep(5)"],
            Path::new("."),
            Duration::from_millis(200),
        );
        assert!(!ok);
        assert!(stderr.contains("timed out"), "{stderr}");
    }

    #[test]
    fn run_git_bounded_overrides_repo_hooks_and_fsmonitor() {
        let result = run_git_bounded(
            &["config", "--get-regexp", "^core\\.(hookspath|fsmonitor)$"],
            Path::new("."),
            BoundedCmdOptions {
                timeout: Some(Duration::from_secs(10)),
                ..BoundedCmdOptions::default()
            },
        );
        assert!(result.success, "{result:?}");
        assert!(result
            .stdout
            .contains(&format!("core.hookspath {GIT_NULL_HOOKS_PATH}")));
        assert!(result.stdout.contains("core.fsmonitor false"));
    }
}
