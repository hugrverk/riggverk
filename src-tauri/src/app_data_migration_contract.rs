//! Contract for the one-time move of the app data directory.
//!
//! Every case runs against temp dirs. Most use an explicit `PlatformEnv`, so
//! they never touch the process environment; the cases that need the real
//! readers (`settings::load`, the OpenCode model override, the backup list)
//! run under an isolated `HOME`. Nothing here may read or write the real
//! per-user app data directories.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::agent_targets::HarnessId;
use crate::app_data_migration::{migrate, take_startup_warning, Outcome, MIGRATION_MARKER_FILE};
use crate::platform_paths::{app_support_dir, legacy_app_support_dir, Platform, PlatformEnv};
use crate::settings::AppSettings;

const OLD_NAME: &str = "ai.agentworkspace.app";
const NEW_NAME: &str = "se.hugrverk.riggverk";
const BASE_TIME: u64 = 1_600_000_000;
const TXN_IN_FLIGHT: &str = "1700000000000000001";
const TXN_DONE: &str = "1700000000000000002";
const WORKSPACE_KEY: &str = "/home/example/.config/agent-workspace";

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "riggverk-data-migration-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Drops a startup warning a failing test left behind, so it cannot leak into
/// another test's settings snapshot.
struct ClearStartupWarning;

impl Drop for ClearStartupWarning {
    fn drop(&mut self) {
        let _ = take_startup_warning();
    }
}

fn mac_env(home: &Path) -> PlatformEnv {
    PlatformEnv {
        home: Some(home.to_string_lossy().into_owned()),
        ..PlatformEnv::default()
    }
}

fn old_and_new(home: &Path) -> (PathBuf, PathBuf) {
    let env = mac_env(home);
    (
        legacy_app_support_dir(&env, Platform::MacOS).expect("legacy dir"),
        app_support_dir(&env, Platform::MacOS).expect("current dir"),
    )
}

fn real_rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

fn run(home: &Path) -> Result<Outcome, String> {
    migrate(&mac_env(home), Platform::MacOS, &real_rename)
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, bytes).expect("write file");
}

fn set_mtime(path: &Path, unix_secs: u64) {
    // On unix a read-only handle is enough, and works for directories too.
    #[cfg(unix)]
    let file = fs::File::open(path).expect("open for mtime");
    // Windows cannot open a directory this way; directory mtimes are not pinned there.
    #[cfg(not(unix))]
    let file = match fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => file,
        Err(_) if path.is_dir() => return,
        Err(error) => panic!("open {} for mtime: {error}", path.display()),
    };
    file.set_modified(UNIX_EPOCH + Duration::from_secs(unix_secs))
        .expect("set mtime");
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set mode");
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

#[derive(Debug, PartialEq, Eq)]
struct Node {
    is_dir: bool,
    bytes: Vec<u8>,
    #[cfg(unix)]
    mode: u32,
    modified: SystemTime,
}

/// Every entry below `root` (not `root` itself) with bytes, mode and mtime.
fn snapshot(root: &Path) -> BTreeMap<String, Node> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Node>) {
        for entry in fs::read_dir(dir).expect("read dir") {
            let path = entry.expect("dir entry").path();
            let metadata = fs::symlink_metadata(&path).expect("metadata");
            let rel = path
                .strip_prefix(root)
                .expect("below root")
                .to_string_lossy()
                .replace('\\', "/");
            out.insert(
                rel,
                Node {
                    is_dir: metadata.is_dir(),
                    bytes: if metadata.is_file() {
                        fs::read(&path).expect("read file")
                    } else {
                        Vec::new()
                    },
                    #[cfg(unix)]
                    mode: mode_of(&path),
                    modified: metadata.modified().expect("mtime"),
                },
            );
            if metadata.is_dir() {
                walk(root, &path, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn without_marker(mut tree: BTreeMap<String, Node>) -> BTreeMap<String, Node> {
    tree.remove(MIGRATION_MARKER_FILE);
    tree
}

fn manifest(status: &str) -> String {
    format!(
        "{{\"workspace_key\":\"{WORKSPACE_KEY}\",\"transaction_status\":\"{status}\",\"operations\":[]}}\n"
    )
}

/// The run directories of the backup fixture, newest first, with the id the
/// backup list gives each and the mtime that decides the order.
const RUNS: [(&str, &str, u64); 5] = [
    (
        "setup/1700000000000000001",
        "setup:1700000000000000001",
        5000,
    ),
    (
        "setup/1700000000000000002",
        "setup:1700000000000000002",
        4000,
    ),
    ("docs/doc-1700000000", "docs:doc-1700000000", 3000),
    ("20231231-235959", "20231231-235959", 2000),
    ("20240102-030405", "20240102-030405", 1000),
];

/// Backup tree: an in-flight setup transaction, a finished one, a Library save
/// and two legacy-script runs. The mtimes make the list order differ from the
/// alphabetical order, so a move that reset them would show.
fn seed_backups(old: &Path) {
    let backups = old.join("backups");
    write(
        &backups.join(format!("setup/{TXN_IN_FLIGHT}/manifest.json")),
        manifest("applying").as_bytes(),
    );
    write(
        &backups.join(format!(
            "setup/{TXN_IN_FLIGHT}/artifacts/codex-rules/AGENTS.md"
        )),
        b"# codex rules before the interrupted apply\n",
    );
    write(
        &backups.join(format!("setup/{TXN_DONE}/manifest.json")),
        manifest("completed").as_bytes(),
    );
    write(
        &backups.join(format!("setup/{TXN_DONE}/artifacts/claude-rules/CLAUDE.md")),
        b"# claude rules\n",
    );
    write(
        &backups.join("docs/doc-1700000000/README.md"),
        b"# a saved library doc\n",
    );
    write(
        &backups.join("20240102-030405/codex-rules/AGENTS.md"),
        b"# older legacy run\n",
    );
    write(
        &backups.join("20231231-235959/claude-rules/CLAUDE.md"),
        b"# newest legacy run\n",
    );
}

/// Owner-only modes (settings.json deliberately 0640, so a reset to a default
/// mode is visible) and distinct, fixed mtimes for every entry.
fn pin_metadata(old: &Path) {
    let tree = snapshot(old);
    #[cfg(unix)]
    {
        set_mode(old, 0o700);
        for (rel, node) in &tree {
            set_mode(&old.join(rel), if node.is_dir { 0o700 } else { 0o600 });
        }
        set_mode(&old.join("settings.json"), 0o640);
    }
    for (index, rel) in tree.keys().enumerate() {
        set_mtime(&old.join(rel), BASE_TIME + 10 * index as u64);
    }
    for (rel, _, offset) in RUNS {
        set_mtime(&old.join("backups").join(rel), BASE_TIME + offset);
    }
}

#[cfg(unix)]
fn expected_run_ids() -> Vec<&'static str> {
    RUNS.iter().map(|(_, id, _)| *id).collect()
}

/// `(id, file count, path relative to the backup root)` per listed run.
fn backup_list(root: &Path) -> Vec<(String, u64, String)> {
    let runs = crate::commands::backups::list_backups_from_root(root).expect("list backups");
    serde_json::to_value(&runs)
        .expect("serialize runs")
        .as_array()
        .expect("array")
        .iter()
        .map(|run| {
            let path = PathBuf::from(run["path"].as_str().expect("path"));
            let rel = path
                .strip_prefix(root)
                .expect("run below the backup root")
                .to_string_lossy()
                .replace('\\', "/");
            (
                run["id"].as_str().expect("id").to_string(),
                run["file_count"].as_u64().expect("file_count"),
                rel,
            )
        })
        .collect()
}

/// A small legacy directory for the cases that do not need the real readers.
fn seed_simple(old: &Path) {
    write(&old.join("settings.json"), b"{\"appearance\":\"light\"}\n");
    write(&old.join("backups/setup/1/manifest.json"), b"{}\n");
}

fn with_isolated_home<T>(name: &str, run: impl FnOnce(&Path) -> T) -> T {
    let _guard = crate::test_env::guard::lock();
    let _env = crate::test_env::guard::EnvRestore::capture();
    let _warning = ClearStartupWarning;
    let home = TempDir::new(name);
    crate::test_env::set_test_user_dirs(home.path());
    unsafe {
        std::env::remove_var("AGENT_WORKSPACE_BACKUP_DIR");
        std::env::remove_var("AGENT_WORKSPACE_PATH");
    }
    run(home.path())
}

#[test]
fn moves_settings_override_and_backups_exactly() {
    with_isolated_home("moves", |_home| {
        let env = PlatformEnv::from_process_env();
        let platform = Platform::current();
        let old = legacy_app_support_dir(&env, platform).expect("legacy dir");
        let new = app_support_dir(&env, platform).expect("current dir");
        assert!(!old.exists() && !new.exists());

        // Non-default settings and an OpenCode model override, written by the
        // production writers into the current location, then moved to the
        // legacy name to stand in for a directory an earlier build left.
        let custom = AppSettings {
            appearance: "light".into(),
            enabled_harness_ids: vec![HarnessId::Codex, HarnessId::Claude],
            ..AppSettings::default()
        };
        let saved = crate::settings::save_with_revision_check(custom, None).expect("save settings");
        assert_eq!(
            saved.enabled_harness_ids,
            [HarnessId::Codex, HarnessId::Claude]
        );
        crate::commands::update_opencode_model_selection(
            "override-provider/large".to_string(),
            "override-provider/small".to_string(),
            None,
            None,
        )
        .expect("save override");
        fs::rename(&new, &old).expect("stage legacy dir");
        write(&old.join("settings.json.tmp"), b"{ leftover");
        write(&old.join("settings.json.corrupt.123.bak"), b"{ not json");
        seed_backups(&old);
        pin_metadata(&old);

        // Before the move the current location is empty, so the readers fall back.
        assert_ne!(crate::settings::load(), saved);
        assert_ne!(
            crate::commands::read_opencode_model_selection()
                .expect("read defaults")
                .model,
            "override-provider/large"
        );

        let before = snapshot(&old);
        #[cfg(unix)]
        let root_mode = mode_of(&old);
        let backups_before = backup_list(&old.join("backups"));
        #[cfg(unix)]
        assert_eq!(
            backups_before
                .iter()
                .map(|run| run.0.as_str())
                .collect::<Vec<_>>(),
            expected_run_ids()
        );

        assert_eq!(migrate(&env, platform, &real_rename), Ok(Outcome::Moved));

        assert!(!old.exists(), "the legacy directory must be gone");
        let after = snapshot(&new);
        assert_eq!(
            without_marker(after),
            before,
            "bytes, modes and mtimes of every entry"
        );
        #[cfg(unix)]
        assert_eq!(mode_of(&new), root_mode);

        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(new.join(MIGRATION_MARKER_FILE)).expect("marker moved along"),
        )
        .expect("marker is json");
        assert_eq!(marker["from"], old.to_string_lossy().as_ref());
        assert_eq!(marker["to"], new.to_string_lossy().as_ref());
        assert_eq!(marker["app_version"], env!("CARGO_PKG_VERSION"));
        assert!(marker["unix_time"].as_u64().is_some());
        #[cfg(unix)]
        assert_eq!(mode_of(&new.join(MIGRATION_MARKER_FILE)), 0o600);

        // The real readers now find everything at the new location.
        assert_eq!(crate::settings::load(), saved);
        let selection = crate::commands::read_opencode_model_selection().expect("read override");
        assert_eq!(selection.model, "override-provider/large");
        assert_eq!(selection.small_model, "override-provider/small");

        // Backup list: same runs, same order, same files.
        let backups_after = backup_list(&new.join("backups"));
        assert_eq!(backups_after, backups_before);
        let via_command: Vec<String> = crate::commands::list_backups()
            .expect("list backups")
            .iter()
            .map(|run| {
                serde_json::to_value(run).expect("serialize")["id"]
                    .as_str()
                    .expect("id")
                    .to_string()
            })
            .collect();
        assert_eq!(
            via_command,
            backups_after
                .iter()
                .map(|run| run.0.clone())
                .collect::<Vec<_>>()
        );

        // The interrupted transaction is still found, with the status that
        // makes the next apply roll it back.
        let raw = fs::read_to_string(
            new.join("backups/setup")
                .join(TXN_IN_FLIGHT)
                .join("manifest.json"),
        )
        .expect("in-flight manifest");
        let header = crate::setup_transaction::read_manifest_header(&raw).expect("header");
        assert_eq!(
            header.status,
            crate::setup_transaction::TransactionStatus::Applying
        );
        assert_eq!(header.workspace_key.as_deref(), Some(WORKSPACE_KEY));

        // A second run changes nothing.
        let settled = snapshot(&new);
        assert_eq!(migrate(&env, platform, &real_rename), Ok(Outcome::NoLegacy));
        assert_eq!(snapshot(&new), settled);
    });
}

#[test]
fn a_second_run_is_a_no_op() {
    let home = TempDir::new("second-run");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);

    assert_eq!(run(home.path()), Ok(Outcome::Moved));
    let settled = snapshot(&new);

    assert_eq!(run(home.path()), Ok(Outcome::NoLegacy));
    assert_eq!(snapshot(&new), settled);
    assert!(!old.exists());
}

#[test]
fn when_both_exist_the_current_one_wins_and_nothing_is_merged() {
    let home = TempDir::new("both-exist");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    write(&new.join("settings.json"), b"{\"appearance\":\"dark\"}\n");
    let (old_before, new_before) = (snapshot(&old), snapshot(&new));

    assert_eq!(run(home.path()), Ok(Outcome::AlreadyCurrent));

    assert_eq!(snapshot(&old), old_before);
    assert_eq!(snapshot(&new), new_before);
    assert!(!old.join(MIGRATION_MARKER_FILE).exists());
    assert!(!new.join("backups").exists(), "no merge of the old backups");
}

#[test]
fn an_empty_current_dir_is_replaced() {
    let home = TempDir::new("empty-target");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    fs::create_dir_all(&new).expect("pre-created empty dir");
    let before = snapshot(&old);

    assert_eq!(run(home.path()), Ok(Outcome::ReplacedEmptyTarget));

    assert!(!old.exists());
    assert_eq!(without_marker(snapshot(&new)), before);
}

#[test]
fn a_non_empty_current_dir_without_a_marker_is_left_alone() {
    let home = TempDir::new("occupied-target");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    write(&new.join("opencode-model-selection.json"), b"{}\n");
    let (old_before, new_before) = (snapshot(&old), snapshot(&new));
    assert!(!new.join(MIGRATION_MARKER_FILE).exists());

    assert_eq!(run(home.path()), Ok(Outcome::AlreadyCurrent));

    assert_eq!(snapshot(&old), old_before);
    assert_eq!(snapshot(&new), new_before);
}

#[cfg(unix)]
#[test]
fn a_symlinked_legacy_dir_is_not_followed_or_moved() {
    let home = TempDir::new("symlink");
    let (old, new) = old_and_new(home.path());
    let elsewhere = home.path().join("elsewhere");
    seed_simple(&elsewhere);
    let target_before = snapshot(&elsewhere);
    fs::create_dir_all(old.parent().expect("parent")).expect("create parent");
    std::os::unix::fs::symlink(&elsewhere, &old).expect("symlink legacy dir");

    assert_eq!(run(home.path()), Ok(Outcome::SkippedSymlink));

    assert!(fs::symlink_metadata(&old)
        .expect("link still there")
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_link(&old).expect("read link"), elsewhere);
    assert_eq!(snapshot(&elsewhere), target_before, "target untouched");
    assert!(!elsewhere.join(MIGRATION_MARKER_FILE).exists());
    assert!(!new.exists(), "nothing created at the new path");
}

#[test]
fn a_legacy_path_that_is_a_file_is_skipped() {
    let home = TempDir::new("legacy-file");
    let (old, new) = old_and_new(home.path());
    write(&old, b"not a directory");

    assert_eq!(run(home.path()), Ok(Outcome::SkippedSymlink));

    assert_eq!(fs::read(&old).expect("file untouched"), b"not a directory");
    assert!(!new.exists());
}

#[test]
fn nothing_is_created_when_there_is_nothing_to_move() {
    let home = TempDir::new("nothing");
    let before = snapshot(home.path());

    assert_eq!(run(home.path()), Ok(Outcome::NoLegacy));

    assert_eq!(snapshot(home.path()), before);
    assert!(before.is_empty(), "the temp home started empty");
}

#[test]
fn an_unresolvable_environment_is_skipped_without_error() {
    let outcome = migrate(&PlatformEnv::default(), Platform::MacOS, &real_rename);
    assert!(matches!(outcome, Ok(Outcome::Unresolved(_))), "{outcome:?}");
    let outcome = migrate(&PlatformEnv::default(), Platform::Windows, &real_rename);
    assert!(matches!(outcome, Ok(Outcome::Unresolved(_))), "{outcome:?}");
}

#[test]
fn a_failed_rename_is_fatal_and_leaves_the_legacy_dir_intact() {
    let home = TempDir::new("rename-fails");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    seed_backups(&old);
    pin_metadata(&old);
    let before = snapshot(&old);
    let calls = Cell::new(0);
    let failing = |from: &Path, to: &Path| -> io::Result<()> {
        calls.set(calls.get() + 1);
        assert_eq!((from, to), (old.as_path(), new.as_path()));
        Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
    };

    let error = migrate(&mac_env(home.path()), Platform::MacOS, &failing)
        .expect_err("a failed rename must stop startup");

    assert_eq!(calls.get(), 1);
    assert!(error.contains(&old.display().to_string()), "{error}");
    assert!(error.contains(&new.display().to_string()), "{error}");
    assert!(error.contains("injected"), "{error}");
    assert_eq!(snapshot(&old), before, "legacy dir intact, marker removed");
    assert!(!new.exists(), "no new dir");

    // The next launch retries and succeeds.
    assert_eq!(run(home.path()), Ok(Outcome::Moved));
    assert_eq!(without_marker(snapshot(&new)), before);
}

#[test]
fn a_failed_rename_after_replacing_an_empty_dir_leaves_no_new_dir() {
    let home = TempDir::new("rename-fails-empty");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    fs::create_dir_all(&new).expect("pre-created empty dir");
    let before = snapshot(&old);
    let failing = |_: &Path, _: &Path| -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"))
    };

    let error = migrate(&mac_env(home.path()), Platform::MacOS, &failing).expect_err("fatal");

    assert!(error.contains(&old.display().to_string()), "{error}");
    assert!(error.contains(&new.display().to_string()), "{error}");
    assert_eq!(snapshot(&old), before);
    assert!(!new.exists(), "only the empty directory was ever removed");
}

#[test]
fn a_marker_that_cannot_be_written_stops_before_the_move() {
    let home = TempDir::new("marker-fails");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    // A directory where the marker file goes: it cannot be replaced or created.
    fs::create_dir_all(old.join(MIGRATION_MARKER_FILE)).expect("block the marker");
    let before = snapshot(&old);
    let calls = Cell::new(0);
    let counting = |from: &Path, to: &Path| -> io::Result<()> {
        calls.set(calls.get() + 1);
        fs::rename(from, to)
    };

    let error = migrate(&mac_env(home.path()), Platform::MacOS, &counting)
        .expect_err("marker failure is fatal");

    assert_eq!(calls.get(), 0, "no rename after a marker failure");
    assert!(error.contains(&old.display().to_string()), "{error}");
    assert!(error.contains(&new.display().to_string()), "{error}");
    assert_eq!(snapshot(&old), before);
    assert!(!new.exists());
}

#[test]
fn a_stale_marker_from_an_undone_move_is_replaced() {
    let home = TempDir::new("stale-marker");
    let (old, new) = old_and_new(home.path());
    seed_simple(&old);
    // What `mv <new> <old>` (the documented undo) leaves behind.
    write(&old.join(MIGRATION_MARKER_FILE), b"{\"from\":\"stale\"}\n");

    assert_eq!(run(home.path()), Ok(Outcome::Moved));

    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(new.join(MIGRATION_MARKER_FILE)).expect("marker"))
            .expect("json");
    assert_eq!(marker["from"], old.to_string_lossy().as_ref());
    assert_eq!(marker["to"], new.to_string_lossy().as_ref());
}

#[test]
fn old_and_new_paths_per_platform() {
    let tmp = TempDir::new("platforms");
    let root = tmp.path();
    let s = |p: &Path| p.to_string_lossy().into_owned();

    let linux_xdg = root.join("xdg");
    let windows_roaming = root.join("AppData").join("Roaming");
    let cases: [(&str, Platform, PlatformEnv, PathBuf); 4] = [
        (
            "macOS",
            Platform::MacOS,
            PlatformEnv {
                home: Some(s(root)),
                ..PlatformEnv::default()
            },
            root.join("Library/Application Support"),
        ),
        (
            "Linux without XDG_CONFIG_HOME",
            Platform::Linux,
            PlatformEnv {
                home: Some(s(root)),
                ..PlatformEnv::default()
            },
            root.join(".config"),
        ),
        (
            "Linux with XDG_CONFIG_HOME",
            Platform::Linux,
            PlatformEnv {
                home: Some(s(root)),
                xdg_config_home: Some(s(&linux_xdg)),
                ..PlatformEnv::default()
            },
            linux_xdg.clone(),
        ),
        (
            "Windows",
            Platform::Windows,
            PlatformEnv {
                userprofile: Some(s(root)),
                appdata: Some(s(&windows_roaming)),
                ..PlatformEnv::default()
            },
            windows_roaming.clone(),
        ),
    ];

    for (label, platform, env, parent) in cases {
        let old = legacy_app_support_dir(&env, platform).expect("legacy");
        let new = app_support_dir(&env, platform).expect("current");
        assert_eq!(old, parent.join(OLD_NAME), "{label}");
        assert_eq!(new, parent.join(NEW_NAME), "{label}");

        // The move works with each layout, including a parent that is
        // an XDG or APPDATA override.
        seed_simple(&old);
        let before = snapshot(&old);
        let outcome = migrate(&env, platform, &real_rename);
        assert_eq!(outcome, Ok(Outcome::Moved), "{label}");
        assert!(!old.exists(), "{label}");
        assert_eq!(without_marker(snapshot(&new)), before, "{label}");
        assert_eq!(
            migrate(&env, platform, &real_rename),
            Ok(Outcome::NoLegacy),
            "{label}"
        );
        fs::remove_dir_all(&new).expect("reset between platforms");
    }

    // Missing inputs: Windows needs APPDATA; the others need a home.
    let no_appdata = PlatformEnv {
        userprofile: Some(s(root)),
        ..PlatformEnv::default()
    };
    assert!(legacy_app_support_dir(&no_appdata, Platform::Windows).is_err());
    assert!(legacy_app_support_dir(&PlatformEnv::default(), Platform::Linux).is_err());
}

#[cfg(unix)]
#[test]
fn startup_reports_a_skipped_legacy_dir_once_through_the_settings_warning() {
    with_isolated_home("startup-warning", |_home| {
        let env = PlatformEnv::from_process_env();
        let platform = Platform::current();
        let old = legacy_app_support_dir(&env, platform).expect("legacy dir");
        let new = app_support_dir(&env, platform).expect("current dir");
        let elsewhere = old.parent().expect("parent").join("elsewhere-target");
        fs::create_dir_all(&elsewhere).expect("link target");
        std::os::unix::fs::symlink(&elsewhere, &old).expect("symlink legacy dir");

        crate::app_data_migration::run_at_startup().expect("startup");

        assert!(!new.exists());
        let first = crate::settings::get_settings_snapshot().expect("first snapshot");
        let warning = first.load_warning.expect("warning on the first load");
        assert!(warning.contains(&old.display().to_string()), "{warning}");
        assert!(warning.contains(&new.display().to_string()), "{warning}");
        let second = crate::settings::get_settings_snapshot().expect("second snapshot");
        assert!(second.load_warning.is_none(), "the warning is one-time");
    });
}

#[test]
fn startup_without_legacy_data_sets_no_warning() {
    with_isolated_home("startup-quiet", |_home| {
        crate::app_data_migration::run_at_startup().expect("startup");
        assert!(take_startup_warning().is_none());
        let env = PlatformEnv::from_process_env();
        let new = app_support_dir(&env, Platform::current()).expect("current dir");
        assert!(!new.exists(), "a fresh install creates nothing at startup");
    });
}
