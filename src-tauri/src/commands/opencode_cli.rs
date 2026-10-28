//! The installed `opencode` CLI as the OpenCode runtime health sees it: which version it is and
//! whether the default agent resolves.
//!
//! Every call is bounded by a timeout and an output cap, runs from a neutral working directory
//! and is parse-only: only an exit status and a version token are kept, never the raw output.

use serde::Serialize;
use std::time::Duration;

use super::process::{run_cmd_bounded, BoundedCmdOptions};

/// How to get a supported OpenCode, named wherever the CLI is missing or unsupported. Homebrew
/// core's `opencode` is 2.x, so the tap is named.
pub(super) const INSTALL_COMMANDS: &str =
    "npm i -g opencode-ai or brew install anomalyco/tap/opencode";

/// `opencode --version` prints one short line.
pub(super) const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
/// `opencode debug agent` boots the config and prints the resolved agent (about 150 KB for the
/// architect), which is read and dropped.
pub(super) const AGENT_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_CAP: usize = 4 * 1024;

/// The CLI row of the runtime health.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeCliHealth {
    /// `supported` (1.x), `unsupported` (any other major), `unknown` (found, but no version could
    /// be read) or `missing`.
    pub status: String,
    pub version: Option<String>,
    pub major: Option<u32>,
    pub detail: String,
}

/// A parsed `opencode --version`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CliVersion {
    /// The version token alone, for example `1.19.3` or `2.0.0-beta.4`.
    pub text: String,
    pub major: u32,
}

/// The first `MAJOR.MINOR.PATCH[-pre][+build]` token of `output`, with an optional leading `v` and
/// an optional full stop after it (`GitHub Copilot CLI 1.0.98.`). Anything else in the output is
/// ignored and never kept.
pub(super) fn parse_version(output: &str) -> Option<CliVersion> {
    output.split_whitespace().find_map(|token| {
        let token = token.strip_prefix('v').unwrap_or(token);
        let token = token.strip_suffix('.').unwrap_or(token);
        let (core, suffix) = match token.find(['-', '+']) {
            Some(at) => token.split_at(at),
            None => (token, ""),
        };
        let mut numbers = core.split('.');
        let mut next = || -> Option<u32> {
            let part = numbers.next()?;
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        };
        let (major, _minor, _patch) = (next()?, next()?, next()?);
        let valid_suffix = suffix.len() <= 48
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'));
        if numbers.next().is_some() || !valid_suffix {
            return None;
        }
        Some(CliVersion {
            text: token.to_string(),
            major,
        })
    })
}

/// Arguments of the model listing. OpenCode 2 has no `--pure`, and without `--standalone` it
/// connects to (or starts) a background service. Every other version, including one whose
/// version could not be read, keeps the 1.x arguments.
pub(super) fn models_args(version: Option<&CliVersion>) -> &'static [&'static str] {
    match version {
        Some(version) if version.major == 2 => &["models", "--standalone"],
        _ => &["models", "--pure"],
    }
}

/// A working directory without project config for OpenCode to pick up.
pub(super) fn neutral_cwd() -> std::path::PathBuf {
    std::env::temp_dir()
}

pub(super) enum VersionProbe {
    Found(CliVersion),
    /// Ran, but exited non-zero or printed no version (a local development build, for example).
    Unreadable,
    TimedOut,
}

/// `opencode --version`, from a neutral working directory.
pub(super) fn probe_version(program: &str, timeout: Duration) -> VersionProbe {
    probe_version_with_env(program, timeout, Vec::new())
}

/// `<program> --version` with `extra_env` set on the child, for a CLI that needs more than the
/// app's `PATH` to start (a Node script whose `node` is not on it). Nothing else is run.
pub(super) fn probe_version_with_env(
    program: &str,
    timeout: Duration,
    extra_env: Vec<(String, String)>,
) -> VersionProbe {
    let result = run_cmd_bounded(
        program,
        &["--version"],
        &neutral_cwd(),
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: OUTPUT_CAP,
            stderr_cap: OUTPUT_CAP,
            extra_env,
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        return VersionProbe::TimedOut;
    }
    if !result.success {
        return VersionProbe::Unreadable;
    }
    parse_version(&result.stdout).map_or(VersionProbe::Unreadable, VersionProbe::Found)
}

/// What the version probe found, ready for the health.
pub(super) struct CliReport {
    pub health: OpenCodeCliHealth,
    pub version: Option<CliVersion>,
    /// False when there is no CLI to ask or it timed out: no further probe is worth running.
    pub responsive: bool,
    /// A sentence for the warnings list; only an unsupported version has one.
    pub warning: Option<String>,
}

fn unsupported_message(version: &CliVersion) -> String {
    let detail = if version.major == 2 {
        "OpenCode 2.x does not read tui.json and migrates the config in memory"
    } else {
        "only the 1.x config format is managed"
    };
    format!(
        "OpenCode {} is installed, but Riggverk supports OpenCode 1.x: {detail}. \
         Use 1.x ({INSTALL_COMMANDS}).",
        version.text,
    )
}

/// Probe the CLI at `program` (`None`: not found anywhere).
pub(super) fn inspect(program: Option<&str>, timeout: Duration) -> CliReport {
    let Some(program) = program else {
        return CliReport {
            health: OpenCodeCliHealth {
                status: "missing".into(),
                version: None,
                major: None,
                detail: format!("not found; install OpenCode 1.x with {INSTALL_COMMANDS}"),
            },
            version: None,
            responsive: false,
            warning: None,
        };
    };
    match probe_version(program, timeout) {
        VersionProbe::Found(version) => {
            let supported = version.major == 1;
            let warning = (!supported).then(|| unsupported_message(&version));
            CliReport {
                health: OpenCodeCliHealth {
                    status: if supported {
                        "supported"
                    } else {
                        "unsupported"
                    }
                    .into(),
                    version: Some(version.text.clone()),
                    major: Some(version.major),
                    detail: warning
                        .clone()
                        .unwrap_or_else(|| format!("OpenCode {}", version.text)),
                },
                version: Some(version),
                responsive: true,
                warning,
            }
        }
        VersionProbe::Unreadable => CliReport {
            health: OpenCodeCliHealth {
                status: "unknown".into(),
                version: None,
                major: None,
                detail: "found, but opencode --version gave no version".into(),
            },
            version: None,
            responsive: true,
            warning: None,
        },
        VersionProbe::TimedOut => CliReport {
            health: OpenCodeCliHealth {
                status: "unknown".into(),
                version: None,
                major: None,
                detail: format!(
                    "found, but opencode --version timed out after {}s",
                    timeout.as_secs()
                ),
            },
            version: None,
            responsive: false,
            warning: None,
        },
    }
}

/// OpenCode agent names: a letter or digit first, so a value can never be read as an option.
pub(super) fn is_valid_agent_name(name: &str) -> bool {
    name.len() <= 64
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub(super) enum AgentProbe {
    /// `opencode debug agent <name>` exited 0: the agent parses and resolves.
    Resolves,
    /// It exited non-zero: the agent is missing or its definition is broken.
    Unresolved,
    TimedOut,
    /// It could not be run at all.
    NotRun,
}

/// `opencode debug agent <name> --pure` (1.x), from a neutral working directory. Only the exit
/// status is used; the resolved ruleset it prints is dropped.
pub(super) fn probe_agent(program: &str, name: &str, timeout: Duration) -> AgentProbe {
    if !is_valid_agent_name(name) {
        return AgentProbe::NotRun;
    }
    let result = run_cmd_bounded(
        program,
        &["debug", "agent", name, "--pure"],
        &neutral_cwd(),
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: OUTPUT_CAP,
            stderr_cap: OUTPUT_CAP,
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        AgentProbe::TimedOut
    } else if result.success {
        AgentProbe::Resolves
    } else if result.exit_code.is_some() {
        AgentProbe::Unresolved
    } else {
        AgentProbe::NotRun
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(text: &str) -> Option<(String, u32)> {
        parse_version(text).map(|v| (v.text, v.major))
    }

    #[test]
    fn parses_the_version_token_and_its_major() {
        assert_eq!(version("1.19.3\n"), Some(("1.19.3".into(), 1)));
        assert_eq!(version("2.0.32"), Some(("2.0.32".into(), 2)));
        assert_eq!(version("v1.20.0"), Some(("1.20.0".into(), 1)));
        assert_eq!(
            version("opencode 2.1.0-beta.4+build.7"),
            Some(("2.1.0-beta.4+build.7".into(), 2))
        );
        assert_eq!(version("0.15.31"), Some(("0.15.31".into(), 0)));
    }

    #[test]
    fn a_full_stop_after_the_version_is_not_part_of_it() {
        // `copilot --version` prints two lines and ends the first with a full stop.
        let copilot = "GitHub Copilot CLI 1.0.98.\nRun 'copilot update' to check for updates.\n";
        assert_eq!(version(copilot), Some(("1.0.98".into(), 1)));
        assert_eq!(version("v2.0.1."), Some(("2.0.1".into(), 2)));
        // One full stop, and only after a complete version.
        assert_eq!(version("1.0.98.."), None);
        assert_eq!(version("1.0."), None);
        assert_eq!(version("1.0.98.1"), None);
    }

    #[test]
    fn output_without_a_version_token_is_not_a_version() {
        for output in [
            "",
            "\n",
            "local",
            "dev",
            "1.19",
            "1.x.3",
            "1.2.3.4",
            "Error: not a tty",
            "1.2.3-bad;rm",
        ] {
            assert_eq!(version(output), None, "{output:?}");
        }
    }

    #[test]
    fn only_the_version_token_is_kept_from_noisy_output() {
        let parsed =
            parse_version("update available!\nopencode 1.19.3 (provider tokens: sk-secret)\n")
                .expect("version");
        assert_eq!(parsed.text, "1.19.3");
    }

    #[test]
    fn models_args_follow_the_major() {
        let v = |text: &str| parse_version(text);
        assert_eq!(models_args(v("1.19.3").as_ref()), ["models", "--pure"]);
        assert_eq!(
            models_args(v("2.0.32").as_ref()),
            ["models", "--standalone"]
        );
        // An unreadable version keeps the arguments Riggverk has always used.
        assert_eq!(models_args(None), ["models", "--pure"]);
        assert_eq!(models_args(v("0.15.0").as_ref()), ["models", "--pure"]);
    }

    #[test]
    fn agent_names_cannot_be_read_as_options() {
        for ok in ["architect", "repo-scout", "my_agent.v2", "A1"] {
            assert!(is_valid_agent_name(ok), "{ok}");
        }
        for bad in [
            "",
            "-h",
            "--print-logs",
            ".hidden",
            "a b",
            "a/b",
            "a;b",
            "$(x)",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_agent_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_missing_cli_is_missing_with_an_install_hint() {
        let report = inspect(None, Duration::from_secs(1));
        assert_eq!(report.health.status, "missing");
        assert!(report.health.version.is_none());
        assert!(!report.responsive);
        assert!(report.warning.is_none());
        for name in ["opencode-ai", "anomalyco/tap/opencode"] {
            assert!(
                report.health.detail.contains(name),
                "{}",
                report.health.detail
            );
        }
    }

    #[test]
    fn the_unsupported_message_names_what_changed_and_what_to_install() {
        let two = unsupported_message(&parse_version("2.0.32").expect("version"));
        for needle in [
            "2.0.32",
            "supports OpenCode 1.x",
            "tui.json",
            "in memory",
            "opencode-ai",
            "anomalyco/tap/opencode",
        ] {
            assert!(two.contains(needle), "{two}");
        }
        let zero = unsupported_message(&parse_version("0.15.0").expect("version"));
        assert!(
            zero.contains("0.15.0") && !zero.contains("tui.json"),
            "{zero}"
        );
    }

    // ── Probes against a stub `opencode` ──

    #[cfg(unix)]
    struct Stub {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl Stub {
        fn new(name: &str, body: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("aw-opencode-cli-{name}-{nonce}"));
            std::fs::create_dir_all(&dir).expect("stub dir");
            let path = dir.join("opencode");
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write stub");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod stub");
            Self { dir, path }
        }

        fn program(&self) -> &str {
            self.path.to_str().expect("utf-8 path")
        }
    }

    #[cfg(unix)]
    impl Drop for Stub {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_1x_cli_is_supported_and_reports_its_version() {
        let stub = Stub::new("v1", "echo 1.19.3");
        let report = inspect(Some(stub.program()), Duration::from_secs(10));
        assert_eq!(report.health.status, "supported");
        assert_eq!(report.health.version.as_deref(), Some("1.19.3"));
        assert_eq!(report.health.major, Some(1));
        assert!(report.responsive && report.warning.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_2x_cli_is_unsupported_with_a_precise_warning() {
        let stub = Stub::new("v2", "echo 2.0.32");
        let report = inspect(Some(stub.program()), Duration::from_secs(10));
        assert_eq!(report.health.status, "unsupported");
        assert_eq!(report.health.version.as_deref(), Some("2.0.32"));
        assert_eq!(report.health.major, Some(2));
        let warning = report.warning.expect("2.x warns");
        for needle in ["2.0.32", "supports OpenCode 1.x", "tui.json", "in memory"] {
            assert!(warning.contains(needle), "{warning}");
        }
        assert!(
            report.responsive,
            "an unsupported CLI still answers the other probes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_without_a_readable_version_is_unknown_not_missing() {
        let stub = Stub::new("dev", "echo dev-build");
        let report = inspect(Some(stub.program()), Duration::from_secs(10));
        assert_eq!(report.health.status, "unknown");
        assert!(report.health.version.is_none() && report.warning.is_none());
        assert!(report.responsive);
    }

    #[cfg(unix)]
    #[test]
    fn a_cli_that_hangs_is_unknown_and_bounded() {
        // `exec` so the killed process is the sleeper itself (no orphan holding the pipe).
        let stub = Stub::new("hang", "exec sleep 30");
        let started = std::time::Instant::now();
        let report = inspect(Some(stub.program()), Duration::from_millis(300));
        assert_eq!(report.health.status, "unknown");
        assert!(report.health.detail.contains("timed out"));
        assert!(!report.responsive, "no further probe is worth running");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn raw_output_is_never_kept() {
        let stub = Stub::new(
            "noisy",
            "echo 'token sk-live-not-a-real-secret'\necho 'opencode 1.19.3'",
        );
        let report = inspect(Some(stub.program()), Duration::from_secs(10));
        assert_eq!(report.health.version.as_deref(), Some("1.19.3"));
        let json = serde_json::to_string(&report.health).expect("serialize");
        assert!(!json.contains("sk-live"), "{json}");
    }

    #[cfg(unix)]
    #[test]
    fn probes_run_from_a_neutral_working_directory() {
        let stub = Stub::new("cwd", "pwd -P > \"$(dirname \"$0\")/cwd.txt\"\necho 1.19.3");
        probe_version(stub.program(), Duration::from_secs(10));
        let seen = std::fs::read_to_string(stub.dir.join("cwd.txt")).expect("cwd recorded");
        let neutral = std::fs::canonicalize(neutral_cwd()).expect("neutral cwd");
        assert_eq!(std::path::Path::new(seen.trim()), neutral);
        assert_ne!(
            std::path::Path::new(seen.trim()),
            std::fs::canonicalize(std::env::current_dir().expect("cwd")).expect("canonical cwd")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_agent_probe_reads_only_the_exit_status() {
        let stub = Stub::new(
            "agent",
            "[ \"$1 $2 $3 $4\" = 'debug agent architect --pure' ] && { echo '{\"permission\":[]}'; exit 0; }\nexit 1",
        );
        let timeout = Duration::from_secs(10);
        assert!(matches!(
            probe_agent(stub.program(), "architect", timeout),
            AgentProbe::Resolves
        ));
        assert!(matches!(
            probe_agent(stub.program(), "missing-agent", timeout),
            AgentProbe::Unresolved
        ));
    }

    #[cfg(unix)]
    #[test]
    fn the_agent_probe_is_bounded() {
        let stub = Stub::new("agent-hang", "exec sleep 30");
        let started = std::time::Instant::now();
        let probe = probe_agent(stub.program(), "architect", Duration::from_millis(300));
        assert!(matches!(probe, AgentProbe::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[test]
    fn an_agent_name_that_looks_like_an_option_never_reaches_the_cli() {
        let stub = Stub::new("agent-name", "touch \"$(dirname \"$0\")/ran\"");
        let probe = probe_agent(stub.program(), "--print-logs", Duration::from_secs(10));
        assert!(matches!(probe, AgentProbe::NotRun));
        assert!(!stub.dir.join("ran").exists());
    }
}
