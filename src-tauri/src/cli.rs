//! The read-only subcommands of the executable: `status` and `check` print the installation status
//! the Overview shows and exit. They build nothing of the Tauri app (no window, no plugin, no
//! updater) and write nothing: the one step of the app's start that writes, the move of the app
//! data directory, is not run, and a move that is still pending is reported instead.
//!
//! No argument, a flag or a path starts the app as before, since launchers pass arguments of their
//! own. A bare word that is no subcommand is a usage error.

use std::ffi::OsString;
use std::io::{self, Write};

use crate::installation_status::InstallationState;

const USAGE: &str = "Usage: riggverk status [--json]\n       riggverk check\n       riggverk --help | -h | help\n       riggverk --version | -V\n\ncheck exits 0 when current, 1 when changes are needed, and 2 when unavailable or an error occurs.\n";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status { json: bool },
    Check,
    Help,
    Version,
    Invalid,
}

fn parse(args: impl IntoIterator<Item = OsString>) -> Option<Command> {
    let mut args = args.into_iter();
    let first = args.next()?;
    let command = match first.to_str() {
        Some("status") => match (args.next(), args.next()) {
            (None, _) => Command::Status { json: false },
            (Some(arg), None) if arg == "--json" => Command::Status { json: true },
            _ => Command::Invalid,
        },
        Some("check") => Command::Check,
        Some("--help" | "-h" | "help") => Command::Help,
        Some("--version" | "-V") => Command::Version,
        // A bare word is a mistyped subcommand. Answering it with usage keeps a script from
        // opening a window and waiting on it. Flags and paths are a launcher's, so the app starts.
        Some(word) if !word.starts_with('-') && !word.contains(['/', '\\']) => Command::Invalid,
        _ => return None,
    };
    if args.next().is_some() {
        Some(Command::Invalid)
    } else {
        Some(command)
    }
}

/// The exit code of `check`, which scripts rely on: 0 current, 1 something to install, update or
/// decide, 2 the status is unavailable. An error also exits 2 (see [`execute`]).
fn check_code(state: InstallationState) -> i32 {
    match state {
        InstallationState::Current => 0,
        InstallationState::NotInstalled
        | InstallationState::UpdateAvailable
        | InstallationState::Conflict => 1,
        InstallationState::Unavailable => 2,
    }
}

fn state_text(state: InstallationState) -> &'static str {
    match state {
        InstallationState::NotInstalled => "Not installed",
        InstallationState::UpdateAvailable => "Update available",
        InstallationState::Current => "Current",
        InstallationState::Conflict => "Conflict",
        InstallationState::Unavailable => "Unavailable",
    }
}

fn execute(
    command: Command,
    init: impl FnOnce() -> Result<(), String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let result = (|| -> Result<i32, String> {
        match command {
            Command::Help => {
                write!(out, "{USAGE}").map_err(|e| e.to_string())?;
                return Ok(0);
            }
            Command::Version => {
                writeln!(out, "{}", env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
                return Ok(0);
            }
            Command::Invalid => {
                write!(err, "{USAGE}").map_err(|e| e.to_string())?;
                return Ok(2);
            }
            _ => {}
        }
        if crate::app_data_migration::pending(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )? {
            return Err(
                "Open Riggverk once first to move its app data; nothing was checked.".into(),
            );
        }
        init()?;
        let status = crate::commands::get_installation_status(vec![])?;
        match command {
            Command::Status { json: true } => writeln!(
                out,
                "{}",
                serde_json::to_string_pretty(&status).map_err(|e| e.to_string())?
            )
            .map_err(|e| e.to_string())?,
            Command::Status { json: false } => {
                writeln!(out, "{}", status.summary).map_err(|e| e.to_string())?;
                for surface in &status.surfaces {
                    writeln!(
                        out,
                        "{}: {} - {}",
                        surface.label,
                        state_text(surface.state),
                        surface.detail
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Command::Check => writeln!(out, "{}", status.summary).map_err(|e| e.to_string())?,
            _ => unreachable!(),
        }
        Ok(if command == Command::Check {
            check_code(status.state)
        } else {
            0
        })
    })();
    match result {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(err, "riggverk: {error}");
            2
        }
    }
}

fn dispatch(
    args: impl IntoIterator<Item = OsString>,
    init: impl FnOnce() -> Result<(), String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Option<i32> {
    let command = parse(args)?;
    Some(execute(command, init, out, err))
}

/// Runs the subcommand `args` name and returns its exit code, or `None` when they name none and the
/// app should start. The bundled workspace is found with Tauri's own resource lookup, as the app
/// finds it, without building the app.
pub fn run<R: tauri::Runtime>(
    args: impl IntoIterator<Item = OsString>,
    context: &tauri::Context<R>,
) -> Option<i32> {
    dispatch(
        args,
        || {
            let root =
                tauri::utils::platform::resource_dir(context.package_info(), &Default::default())
                    .map_err(|e| format!("resolve bundled workspace: {e}"))?
                    .join("default-workspace");
            crate::setup_roots::initialize(root)
        },
        &mut io::stdout().lock(),
        &mut io::stderr().lock(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, fs, path::Path};

    #[test]
    fn arguments_and_exit_codes() {
        for (args, expected) in [
            (vec!["status"], Some(Command::Status { json: false })),
            (
                vec!["status", "--json"],
                Some(Command::Status { json: true }),
            ),
            (vec!["check"], Some(Command::Check)),
            (vec!["--help"], Some(Command::Help)),
            (vec!["-h"], Some(Command::Help)),
            (vec!["help"], Some(Command::Help)),
            (vec!["--version"], Some(Command::Version)),
            (vec!["-V"], Some(Command::Version)),
            (vec!["status", "--bogus"], Some(Command::Invalid)),
            (vec![], None),
            (vec!["-psn_0_12345"], None),
            (vec!["--some-flag"], None),
            (vec!["/some/file"], None),
            (vec!["statusx"], Some(Command::Invalid)),
            (vec!["status --json"], Some(Command::Invalid)),
        ] {
            assert_eq!(parse(args.into_iter().map(OsString::from)), expected);
        }
        for (state, code) in [
            (InstallationState::Current, 0),
            (InstallationState::NotInstalled, 1),
            (InstallationState::UpdateAvailable, 1),
            (InstallationState::Conflict, 1),
            (InstallationState::Unavailable, 2),
        ] {
            assert_eq!(check_code(state), code);
        }
        assert_eq!(
            execute(
                Command::Invalid,
                || unreachable!(),
                &mut vec![],
                &mut vec![]
            ),
            2
        );
    }

    fn snapshot(root: &Path) -> BTreeMap<std::path::PathBuf, (u64, Vec<u8>)> {
        fn visit(
            path: &Path,
            root: &Path,
            result: &mut BTreeMap<std::path::PathBuf, (u64, Vec<u8>)>,
        ) {
            let metadata = fs::symlink_metadata(path).unwrap();
            let digest = if metadata.is_file() {
                Sha256::digest(fs::read(path).unwrap()).to_vec()
            } else {
                Vec::new()
            };
            result.insert(
                path.strip_prefix(root).unwrap().to_path_buf(),
                (
                    if metadata.is_file() {
                        metadata.len()
                    } else {
                        0
                    },
                    digest,
                ),
            );
            if metadata.is_dir() {
                for entry in fs::read_dir(path).unwrap() {
                    visit(&entry.unwrap().path(), root, result);
                }
            }
        }
        let mut result = BTreeMap::new();
        visit(root, root, &mut result);
        result
    }

    #[test]
    fn status_commands_leave_fresh_and_installed_trees_unchanged() {
        let _lock = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::isolate_data_location_env();
        let root = std::env::temp_dir().join(format!(
            "riggverk-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        crate::test_env::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        crate::test_env::set_test_user_dirs(&home);
        unsafe {
            std::env::set_var("RIGGVERK_WORKSPACE_PATH", root.join("data"));
            std::env::set_var("RIGGVERK_BACKUP_DIR", root.join("backups"));
            for key in [
                "CODEX_HOME",
                "CODEX_SKILLS_PATH",
                "CLAUDE_SKILLS_PATH",
                "CURSOR_SKILLS_PATH",
                "OPENCODE_SKILLS_PATH",
            ] {
                std::env::remove_var(key);
            }
        }
        let run_commands = || {
            let before = snapshot(&root);
            let expected = crate::commands::get_installation_status(vec![]).unwrap();
            for args in [vec!["status"], vec!["status", "--json"], vec!["check"]] {
                let mut out = Vec::new();
                let mut err = Vec::new();
                let json = args.len() == 2;
                let expected_code = if args[0] == "check" {
                    check_code(expected.state)
                } else {
                    0
                };
                let code = dispatch(
                    args.into_iter().map(OsString::from),
                    || Ok(()),
                    &mut out,
                    &mut err,
                );
                assert_eq!(
                    code,
                    Some(expected_code),
                    "{}",
                    String::from_utf8_lossy(&err)
                );
                assert!(err.is_empty());
                if json {
                    let value: serde_json::Value = serde_json::from_slice(&out).unwrap();
                    assert_eq!(
                        value["state"],
                        serde_json::to_value(expected.state).unwrap()
                    );
                }
            }
            assert_eq!(before, snapshot(&root));
        };
        run_commands();
        let legacy = crate::platform_paths::legacy_app_support_dir(
            &crate::platform_paths::PlatformEnv::from_process_env(),
            crate::platform_paths::Platform::current(),
        )
        .unwrap();
        fs::create_dir_all(&legacy).unwrap();
        let before = snapshot(&root);
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(
            dispatch(
                [OsString::from("check")],
                || unreachable!(),
                &mut out,
                &mut err
            ),
            Some(2)
        );
        assert!(out.is_empty());
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("nothing was checked"));
        assert_eq!(before, snapshot(&root));
        fs::remove_dir_all(legacy).unwrap();
        let plan = crate::commands::preview_setup(vec![]).unwrap();
        let mut surfaces: Vec<String> = plan
            .operations
            .iter()
            .filter(|op| op.kind.needs_apply())
            .map(|op| {
                serde_json::to_value(op.surface)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        surfaces.sort();
        surfaces.dedup();
        let result =
            crate::commands::apply_setup(surfaces, true, plan.plan_fingerprint, plan.preview_token)
                .unwrap();
        assert!(result.success, "{}", result.message);
        run_commands();
        fs::remove_dir_all(root).unwrap();
    }
}
