//! The installed `opencode` CLI as the OpenCode runtime health sees it: which version it is and
//! whether the default agent resolves.
//!
//! Every call is bounded by a timeout and an output cap, runs from a fresh owner-only folder with
//! OpenCode's project config turned off and is parse-only: only an exit status, a version token and
//! (on OpenCode 2) whether one agent id is listed are kept, never the raw output.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
/// OpenCode 2's `debug agents` prints every agent with its whole resolved permission ruleset:
/// about 0.3 MB per agent under the team policy (4 MB for the 13 agents of a Riggverk install on
/// 2.3.2). 32 MiB covers some 100 agents; bigger output is cut there and the agent then counts as
/// not verified. It is held only while the ids are read.
const AGENTS_OUTPUT_CAP: usize = 32 * 1024 * 1024;

/// The OpenCode 2 release the 2.x support was checked against.
pub(super) const TESTED_V2_VERSION: &str = "2.3.2";

/// The CLI row of the runtime health.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeCliHealth {
    /// `supported` (1.x), `compatible` (2.x, see [`TESTED_V2_VERSION`]), `unsupported` (any
    /// other major), `unknown` (found, but no version could be read) or `missing`.
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

static PROBE_DIR_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A new, empty folder for one probe to run from, owner-only (0700 on unix) and removed on drop.
/// A folder somebody else made first at the same name (or a link there) is refused, never reused.
pub(super) struct ProbeDir(PathBuf);

impl ProbeDir {
    pub(super) fn create() -> std::io::Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = PROBE_DIR_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = crate::platform_paths::app_support_dir(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .map_err(std::io::Error::other)?;
        crate::safe_filesystem::create_private_leaf_directory(&root)
            .map_err(std::io::Error::other)?;
        let path = root.join(format!(
            "riggverk-probe-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ProbeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Set on every `opencode` probe. OpenCode looks for `opencode.json` and `.opencode/` in the
/// working directory and in every folder above it, so a private working directory alone does not
/// keep out a file planted in a shared parent such as `/tmp`.
pub(super) fn project_config_off() -> Vec<(String, String)> {
    vec![(
        "OPENCODE_DISABLE_PROJECT_CONFIG".to_string(),
        "1".to_string(),
    )]
}

pub(super) enum VersionProbe {
    Found(CliVersion),
    /// Ran, but exited non-zero or printed no version (a local development build, for example).
    Unreadable,
    TimedOut,
}

/// `opencode --version`, from a fresh probe folder without project config.
pub(super) fn probe_version(program: &str, timeout: Duration) -> VersionProbe {
    probe_version_with_env(program, timeout, project_config_off())
}

/// `<program> --version` from a fresh probe folder, with `extra_env` set on the child, for a CLI
/// that needs more than the app's `PATH` to start (a Node script whose `node` is not on it).
/// Nothing else is run.
pub(super) fn probe_version_with_env(
    program: &str,
    timeout: Duration,
    extra_env: Vec<(String, String)>,
) -> VersionProbe {
    let Ok(cwd) = ProbeDir::create() else {
        return VersionProbe::Unreadable;
    };
    let result = run_cmd_bounded(
        program,
        &["--version"],
        cwd.path(),
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
    format!(
        "OpenCode {} is installed, but Riggverk supports OpenCode 1.x and is compatible with \
         OpenCode 2 (tested with {TESTED_V2_VERSION}): only the 1.x config format is managed. \
         Use 1.x ({INSTALL_COMMANDS}).",
        version.text,
    )
}

/// The CLI detail for OpenCode 2: it migrates the 1.x config Riggverk writes when it loads it.
fn compatible_detail(version: &CliVersion) -> String {
    if version.text == TESTED_V2_VERSION {
        format!(
            "OpenCode {} (compatible: OpenCode 2 reads the 1.x config Riggverk writes)",
            version.text
        )
    } else {
        format!(
            "OpenCode {} (compatible: OpenCode 2 reads the 1.x config Riggverk writes; tested with {TESTED_V2_VERSION})",
            version.text
        )
    }
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
            let (status, detail, warning) = match version.major {
                1 => ("supported", format!("OpenCode {}", version.text), None),
                2 => ("compatible", compatible_detail(&version), None),
                _ => {
                    let message = unsupported_message(&version);
                    ("unsupported", message.clone(), Some(message))
                }
            };
            CliReport {
                health: OpenCodeCliHealth {
                    status: status.into(),
                    version: Some(version.text.clone()),
                    major: Some(version.major),
                    detail,
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
    /// 1.x: `opencode debug agent <name>` exited 0, so the agent parses and resolves. 2.x: the
    /// agent is listed by `opencode debug agents`.
    Resolves,
    /// 1.x: it exited non-zero, so the agent is missing or its definition is broken. 2.x: the
    /// listing was read and the agent is not in it.
    Unresolved,
    TimedOut,
    /// It could not be run at all.
    NotRun,
    /// 2.x: it ran, but gave no listing that could be read (a non-zero exit, output that is not
    /// the JSON list or is bigger than the cap).
    Unreadable,
}

/// `opencode debug agent <name> --pure` (1.x), from a fresh probe folder without project config.
/// Only the exit status is used; the resolved ruleset it prints is dropped.
pub(super) fn probe_agent(program: &str, name: &str, timeout: Duration) -> AgentProbe {
    if !is_valid_agent_name(name) {
        return AgentProbe::NotRun;
    }
    let Ok(cwd) = ProbeDir::create() else {
        return AgentProbe::NotRun;
    };
    let result = run_cmd_bounded(
        program,
        &["debug", "agent", name, "--pure"],
        cwd.path(),
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: OUTPUT_CAP,
            stderr_cap: OUTPUT_CAP,
            extra_env: project_config_off(),
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

/// One entry of the OpenCode 2 `debug agents` list. Only `id` is read; serde skips every other
/// field (the prompts and permission rules) without keeping it.
#[derive(Deserialize)]
struct ListedAgent {
    id: Option<String>,
}

/// Whether the `debug agents` output lists an agent whose `id` is `name`: `None` when the output
/// is not that JSON list. The `id` of a Markdown agent is its file name without `.md`, and the
/// built-ins are lowercase (`build`, `plan`), the same names `default_agent` takes. No part of the
/// output, nor the parse error, is kept.
fn lists_agent(output: &str, name: &str) -> Option<bool> {
    let agents: Vec<ListedAgent> = serde_json::from_str(output).ok()?;
    Some(agents.iter().any(|agent| agent.id.as_deref() == Some(name)))
}

/// `opencode debug agents --standalone` (2.x), from a fresh probe folder without project config.
/// OpenCode 2 has no `debug agent <name>`, and an agent file it cannot decode is left out of the
/// list with exit status 0, so only the listed ids say whether the agent resolves.
pub(super) fn probe_agent_v2(program: &str, name: &str, timeout: Duration) -> AgentProbe {
    if !is_valid_agent_name(name) {
        return AgentProbe::NotRun;
    }
    let Ok(cwd) = ProbeDir::create() else {
        return AgentProbe::NotRun;
    };
    let result = run_cmd_bounded(
        program,
        &["debug", "agents", "--standalone"],
        cwd.path(),
        BoundedCmdOptions {
            timeout: Some(timeout),
            stdout_cap: AGENTS_OUTPUT_CAP,
            stderr_cap: OUTPUT_CAP,
            extra_env: project_config_off(),
            ..BoundedCmdOptions::default()
        },
    );
    if result.timed_out {
        return AgentProbe::TimedOut;
    }
    if result.exit_code.is_none() {
        return AgentProbe::NotRun;
    }
    if !result.success || result.stdout.len() >= AGENTS_OUTPUT_CAP {
        return AgentProbe::Unreadable;
    }
    match lists_agent(&result.stdout, name) {
        Some(true) => AgentProbe::Resolves,
        Some(false) => AgentProbe::Unresolved,
        None => AgentProbe::Unreadable,
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
        // What `opencode --version` prints: 1.19.5 the bare version, 2.3.2 with a prefix.
        assert_eq!(version("1.19.5\n"), Some(("1.19.5".into(), 1)));
        assert_eq!(version("opencode v2.3.2\n"), Some(("2.3.2".into(), 2)));
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
    fn the_unsupported_message_names_what_is_supported_and_what_to_install() {
        for text in ["3.0.0", "0.15.0"] {
            let message = unsupported_message(&parse_version(text).expect("version"));
            for needle in [
                text,
                "supports OpenCode 1.x",
                "compatible with OpenCode 2 (tested with 2.3.2)",
                "opencode-ai",
                "anomalyco/tap/opencode",
            ] {
                assert!(message.contains(needle), "{message}");
            }
        }
    }

    #[test]
    fn the_compatible_detail_names_the_tested_version_unless_it_is_that_one() {
        let tested = compatible_detail(&parse_version("opencode v2.3.2").expect("version"));
        assert!(tested.starts_with("OpenCode 2.3.2 (compatible"), "{tested}");
        assert!(!tested.contains("tested with"), "{tested}");
        for text in ["2.4.0", "2.0.32", "2.3.2-beta.1"] {
            let other = compatible_detail(&parse_version(text).expect("version"));
            assert!(
                other.contains(text) && other.contains("tested with 2.3.2"),
                "{other}"
            );
        }
    }

    #[test]
    fn the_agent_listing_is_read_for_ids_only() {
        let listing = r#"[{"id":"architect","name":"architect","mode":"primary","permissions":[{"action":"*","resource":"*","effect":"ask"}],"system":"sk-not-a-secret"},{"id":"build","name":"Build","hidden":false}]"#;
        assert_eq!(lists_agent(listing, "architect"), Some(true));
        assert_eq!(lists_agent(listing, "build"), Some(true));
        // `name` is a display name (`Build`), not what `default_agent` matches.
        assert_eq!(lists_agent(listing, "Build"), Some(false));
        assert_eq!(lists_agent(listing, "repo-scout"), Some(false));
        assert_eq!(lists_agent("[]", "build"), Some(false));
        assert_eq!(lists_agent(r#"[{"name":"build"}]"#, "build"), Some(false));
        for unreadable in ["", "{}", "[1]", r#"[{"id":"build"}"#, "Error: boom"] {
            assert_eq!(lists_agent(unreadable, "build"), None, "{unreadable:?}");
        }
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
    fn a_2x_cli_is_compatible_without_a_warning() {
        let stub = Stub::new("v2", "echo 'opencode v2.3.2'");
        let report = inspect(Some(stub.program()), Duration::from_secs(10));
        assert_eq!(report.health.status, "compatible");
        assert_eq!(report.health.version.as_deref(), Some("2.3.2"));
        assert_eq!(report.health.major, Some(2));
        assert!(report.warning.is_none());
        assert!(report.responsive);
    }

    #[cfg(unix)]
    #[test]
    fn a_3x_cli_is_unsupported_with_a_precise_warning() {
        let stub = Stub::new("v3", "echo 3.0.0");
        let report = inspect(Some(stub.program()), Duration::from_secs(10));
        assert_eq!(report.health.status, "unsupported");
        assert_eq!(report.health.major, Some(3));
        let warning = report.warning.expect("3.x warns");
        for needle in ["3.0.0", "supports OpenCode 1.x"] {
            assert!(warning.contains(needle), "{warning}");
        }
        assert_eq!(report.health.detail, warning);
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
    fn probes_run_from_a_fresh_private_folder_without_project_config() {
        let _guard = crate::test_env::guard::lock();
        let stub = Stub::new(
            "cwd",
            "d=\"$(dirname \"$0\")\"\npwd -P >> \"$d/cwd.txt\"\nls -ld . | cut -c1-10 >> \"$d/mode.txt\"\necho \"$OPENCODE_DISABLE_PROJECT_CONFIG\" >> \"$d/env.txt\"\necho 1.19.3",
        );
        let timeout = Duration::from_secs(10);
        probe_version(stub.program(), timeout);
        probe_agent(stub.program(), "architect", timeout);
        probe_agent_v2(stub.program(), "architect", timeout);
        let read = |name: &str| std::fs::read_to_string(stub.dir.join(name)).expect(name);
        let seen: Vec<PathBuf> = read("cwd.txt").lines().map(PathBuf::from).collect();
        let shared = std::fs::canonicalize(
            crate::platform_paths::app_support_dir(
                &crate::platform_paths::PlatformEnv::from_process_env(),
                crate::platform_paths::Platform::current(),
            )
            .expect("app data dir"),
        )
        .expect("canonical app data dir");
        assert_eq!(seen.len(), 3);
        assert_ne!(seen[0], seen[1], "each probe gets its own folder");
        assert_ne!(seen[1], seen[2], "each probe gets its own folder");
        for cwd in &seen {
            assert_eq!(cwd.parent(), Some(shared.as_path()), "{cwd:?}");
            assert!(!cwd.exists(), "{cwd:?} is removed after the probe");
        }
        assert_eq!(
            read("mode.txt").lines().collect::<Vec<_>>(),
            ["drwx------"; 3]
        );
        assert_eq!(read("env.txt").lines().collect::<Vec<_>>(), ["1"; 3]);
    }

    #[test]
    fn a_probe_folder_is_new_owner_only_and_removed_on_drop() {
        let _guard = crate::test_env::guard::lock();
        let first = ProbeDir::create().expect("first");
        let second = ProbeDir::create().expect("second");
        assert_ne!(first.path(), second.path());
        assert!(std::fs::read_dir(first.path())
            .expect("read")
            .next()
            .is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(first.path())
                .expect("meta")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let path = first.path().to_path_buf();
        std::fs::write(path.join("left-behind"), b"x").expect("write");
        drop(first);
        assert!(!path.exists());
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

    #[cfg(unix)]
    #[test]
    fn the_2x_agent_probe_reads_only_the_listed_ids() {
        let stub = Stub::new(
            "agents-v2",
            "[ \"$*\" = 'debug agents --standalone' ] || exit 64\necho '[{\"id\":\"architect\",\"name\":\"architect\",\"permissions\":[]},{\"id\":\"build\",\"name\":\"Build\"}]'",
        );
        let timeout = Duration::from_secs(10);
        assert!(matches!(
            probe_agent_v2(stub.program(), "architect", timeout),
            AgentProbe::Resolves
        ));
        assert!(matches!(
            probe_agent_v2(stub.program(), "build", timeout),
            AgentProbe::Resolves
        ));
        assert!(matches!(
            probe_agent_v2(stub.program(), "missing-agent", timeout),
            AgentProbe::Unresolved
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_2x_listing_that_cannot_be_read_never_counts_as_unresolved() {
        let timeout = Duration::from_secs(10);
        for (name, body) in [
            ("agents-exit", "echo '[]'; exit 1"),
            ("agents-text", "echo 'Error: config is broken'"),
            ("agents-cut", "printf '[{\"id\":\"build\"'"),
        ] {
            let stub = Stub::new(name, body);
            assert!(
                matches!(
                    probe_agent_v2(stub.program(), "build", timeout),
                    AgentProbe::Unreadable
                ),
                "{name}"
            );
        }
        let hang = Stub::new("agents-hang", "exec sleep 30");
        assert!(matches!(
            probe_agent_v2(hang.program(), "build", Duration::from_millis(300)),
            AgentProbe::TimedOut
        ));
        let named = Stub::new("agents-name", "touch \"$(dirname \"$0\")/ran\"");
        assert!(matches!(
            probe_agent_v2(named.program(), "--print-logs", timeout),
            AgentProbe::NotRun
        ));
        assert!(!named.dir.join("ran").exists());
    }

    /// The version and default-agent probes against a real `opencode`. Not run by default: set
    /// `RIGGVERK_LIVE_OPENCODE` to a program that runs OpenCode in a throwaway home, and
    /// `RIGGVERK_LIVE_AGENT` to the agent its config names, then run with `--ignored`.
    #[test]
    #[ignore = "needs a live opencode in a throwaway home"]
    fn live_default_agent_probe() {
        let program = std::env::var("RIGGVERK_LIVE_OPENCODE").expect("RIGGVERK_LIVE_OPENCODE");
        let agent = std::env::var("RIGGVERK_LIVE_AGENT").expect("RIGGVERK_LIVE_AGENT");
        let report = inspect(Some(&program), VERSION_TIMEOUT);
        let version = report.version.expect("a readable version");
        let probe = |name: &str| match version.major {
            1 => probe_agent(&program, name, AGENT_TIMEOUT),
            2 => probe_agent_v2(&program, name, AGENT_TIMEOUT),
            major => panic!("no agent probe for major {major}"),
        };
        let found = probe(&agent);
        let missing = probe("riggverk-no-such-agent");
        println!(
            "live opencode {} ({}): {agent} -> {}, riggverk-no-such-agent -> {}",
            version.text,
            report.health.status,
            outcome(&found),
            outcome(&missing)
        );
        assert!(matches!(found, AgentProbe::Resolves));
        assert!(matches!(missing, AgentProbe::Unresolved));
    }

    fn outcome(probe: &AgentProbe) -> &'static str {
        match probe {
            AgentProbe::Resolves => "resolves",
            AgentProbe::Unresolved => "unresolved",
            AgentProbe::TimedOut => "timed out",
            AgentProbe::NotRun => "not run",
            AgentProbe::Unreadable => "unreadable",
        }
    }
}
