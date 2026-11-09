//! App updates through tauri-plugin-updater, off until the release config turns them on.
//!
//! Updates are on only when `plugins.updater` in tauri.conf.json names a public key and an HTTPS endpoint and
//! binds the signature to the version (`requireSignedVersion`); see docs/RELEASE.md, "Turning on updates". Until
//! then the plugin is not registered, the menu has no "Check for Updates…" item, the UI shows nothing, and these
//! commands make no network request.
//!
//! Everything runs here, never in the webview: the webview gets no updater permission (the plugin's own commands
//! are not in any capability) and the CSP is unchanged. A check keeps the update it found; the install takes the
//! version the user reviewed and installs only that update, so what is installed is what was shown. Nothing is
//! downloaded or installed without the user pressing "Download and restart", and the app never installs an older
//! version (`allowDowngrades` stays off).

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Progress of a download and install, for the review overlay.
pub const UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
/// Sent by the "Check for Updates…" menu item; the UI runs a check the user asked for.
pub const UPDATE_MENU_EVENT: &str = "app-update-check-requested";

/// How long a check may take before it is given up (offline, a slow network).
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the check or the download may wait for the next bytes (connecting, the response, each read) before it is
/// given up as stalled. It restarts with every read, so a slow download that keeps arriving is never cut off.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A daily check runs when the last successful one is at least this old.
pub const DAILY_INTERVAL_SECS: u64 = 24 * 60 * 60;
/// At most about ten progress events per second; the last chunk and phase changes are always sent.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

pub const MOVE_TO_APPLICATIONS: &str =
    "Move Riggverk to Applications first, then open it from there. It is running from a disk image or a quarantined download, where it cannot be replaced.";
pub const NOT_INSTALLED: &str = "Updates apply to an installed Riggverk.app only.";
pub const APPLY_RUNNING: &str =
    "Riggverk is applying changes. Wait until they are finished, then download the new version.";
pub const STALE_REVIEW: &str =
    "The version on offer is not the one you reviewed. Check for updates again.";
pub const SIGNATURE_MISMATCH: &str =
    "The download did not match Riggverk's signature. Nothing was changed.";
const CHECK_FAILED: &str =
    "Could not check for a new version. Check your connection and try again.";
const DOWNLOAD_FAILED: &str = "The download failed. Nothing was changed.";

/// Whether the release config turns updates on, read once from the app's config. A config that names a key and an
/// endpoint but weakens the checks (no `requireSignedVersion`, downgrades, a `dangerous*` switch, plain HTTP) is a
/// mistake, and counts as off rather than as a weaker updater.
pub fn configured(config: &tauri::Config) -> bool {
    config_problem(config.plugins.0.get("updater")).is_none()
}

/// Why `plugins.updater` does not turn updates on; `None` when it does. The block is read as the plugin reads it,
/// so an option set under its kebab-case alias (`allow-downgrades`) counts as well.
pub fn config_problem(updater: Option<&Value>) -> Option<&'static str> {
    let Some(updater) = updater else {
        return Some("no plugins.updater");
    };
    let Ok(config) = serde_json::from_value::<tauri_plugin_updater::Config>(updater.clone()) else {
        return Some("plugins.updater is not a valid updater config");
    };
    if config.pubkey.trim().is_empty() {
        return Some("plugins.updater has no pubkey");
    }
    if config.endpoints.is_empty() {
        return Some("plugins.updater has no endpoints");
    }
    if !config.endpoints.iter().all(|url| url.scheme() == "https") {
        return Some("every plugins.updater endpoint must be https");
    }
    if !config.require_signed_version {
        return Some("plugins.updater must set requireSignedVersion to true");
    }
    if config.allow_downgrades {
        return Some("plugins.updater must not allow downgrades");
    }
    if config.dangerous_insecure_transport_protocol
        || config.dangerous_accept_invalid_certs
        || config.dangerous_accept_invalid_hostnames
    {
        return Some("plugins.updater must not turn on a dangerous* option");
    }
    None
}

/// What a check found. `available` keeps what the review overlay shows.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum UpdateCheck {
    /// Updates are off, or an automatic check was not due or not allowed: nothing was requested.
    Skipped,
    UpToDate {
        current_version: String,
    },
    Available {
        version: String,
        current_version: String,
        /// Release notes as Markdown source; unsigned, so the review renders them without raw HTML.
        notes: Option<String>,
        /// RFC 3339 publication date, when the manifest has one.
        date: Option<String>,
        /// The app bundle the update replaces, `~/...` when under the home folder.
        app_path: Option<String>,
        /// Why this copy cannot be replaced (run from a disk image, translocated); the review says so.
        blocked: Option<String>,
    },
}

/// What the UI needs before any check: whether to show anything at all.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AppUpdateInfo {
    pub configured: bool,
    pub current_version: String,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Download,
    Install,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// The update the last check found, kept for the install of exactly that version.
#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
    installing: Mutex<bool>,
}

/// Registers the plugin and the state when updates are on; a build without the config gets neither.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Whether an automatic check is allowed and due: the user chose "daily" and the last successful check is at
/// least a day old (or in the future, after a clock change).
pub fn automatic_check_due(update_check: &str, last_update_check: Option<u64>, now: u64) -> bool {
    update_check == "daily"
        && last_update_check.is_none_or(|last| last > now || now - last >= DAILY_INTERVAL_SECS)
}

/// The `.app` bundle that holds `exe` (`…/Riggverk.app/Contents/MacOS/riggverk`), if it is one.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// Why the app at `bundle` cannot be replaced in place: App Translocation (a quarantined download opened where it
/// lies runs from a randomized read-only mount) or a read-only volume (the disk image itself).
pub fn install_blocker(bundle: &Path) -> Option<&'static str> {
    let translocated = bundle
        .components()
        .any(|part| matches!(part, Component::Normal(name) if name == "AppTranslocation"));
    if translocated || read_only_volume(bundle) {
        return Some(MOVE_TO_APPLICATIONS);
    }
    None
}

#[cfg(unix)]
fn read_only_volume(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c_path` is a valid NUL-terminated string and `stat` is a writable statvfs the call fills in.
    let result = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if result != 0 {
        return false;
    }
    // SAFETY: statvfs returned 0, so it initialized `stat`.
    let stat = unsafe { stat.assume_init() };
    stat.f_flag & libc::ST_RDONLY != 0
}

#[cfg(not(unix))]
fn read_only_volume(_path: &Path) -> bool {
    false
}

/// Where this app runs from and whether it can be replaced there: `Err` when it is not an installed bundle.
fn current_bundle() -> Result<(PathBuf, Option<&'static str>), &'static str> {
    let exe = std::env::current_exe().map_err(|_| NOT_INSTALLED)?;
    let bundle = bundle_of(&exe).ok_or(NOT_INSTALLED)?;
    let blocker = install_blocker(&bundle);
    Ok((bundle, blocker))
}

fn shown_path(path: &Path) -> String {
    let home = crate::platform_paths::PlatformEnv::from_process_env().home;
    match home
        .as_deref()
        .and_then(|home| path.strip_prefix(home).ok())
    {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// An updater error as the user reads it. The plugin's messages are technical; a signature problem is named.
fn user_error(error: &tauri_plugin_updater::Error, fallback: &str) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::MissingSignedVersion
        | Error::SignedVersionMismatch { .. } => SIGNATURE_MISMATCH.to_string(),
        Error::TempDirNotOnSameMountPoint => MOVE_TO_APPLICATIONS.to_string(),
        _ => fallback.to_string(),
    }
}

#[tauri::command]
pub fn get_app_update_info<R: Runtime>(app: AppHandle<R>) -> AppUpdateInfo {
    AppUpdateInfo {
        configured: configured(app.config()),
        current_version: app.package_info().version.to_string(),
    }
}

/// Looks for a new version. `automatic` is the daily check at startup: it runs only when the saved settings say
/// "daily" and a day has passed, and is skipped (no request) otherwise. A manual check (the menu item, the
/// Settings button) always asks.
#[tauri::command]
pub async fn check_app_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdateState>,
    automatic: bool,
) -> Result<UpdateCheck, String> {
    if !configured(app.config()) {
        return Ok(UpdateCheck::Skipped);
    }
    if automatic {
        let settings = crate::settings::load();
        if !automatic_check_due(
            &settings.update_check,
            settings.last_update_check,
            now_secs(),
        ) {
            return Ok(UpdateCheck::Skipped);
        }
    }
    // The update keeps this client setup for its download, but not the check's total timeout.
    // `https_only` also covers redirects and the manifest's download URL, which the plugin only
    // warns about.
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.read_timeout(STALL_TIMEOUT).https_only(true))
        .build()
        .map_err(|error| user_error(&error, CHECK_FAILED))?;
    let found = updater
        .check()
        .await
        .map_err(|error| user_error(&error, CHECK_FAILED))?;
    let current_version = app.package_info().version.to_string();
    let Some(update) = found else {
        *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
        return Ok(UpdateCheck::UpToDate { current_version });
    };
    let (app_path, blocked) = match current_bundle() {
        Ok((bundle, blocker)) => (Some(shown_path(&bundle)), blocker.map(str::to_string)),
        Err(reason) => (None, Some(reason.to_string())),
    };
    let found = UpdateCheck::Available {
        version: update.version.clone(),
        current_version,
        notes: update.body.clone(),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(Value::as_str)
            .map(str::to_string),
        app_path,
        blocked,
    };
    *state.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(update);
    Ok(found)
}

/// Clears the flag that keeps a second install out, whatever way the install ends.
struct Installing<'a>(&'a Mutex<bool>);

impl Drop for Installing<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

/// Downloads the update the last check found, if it is `version` (the one the user reviewed), verifies its
/// signature, replaces the app bundle and restarts. Refused while an apply runs; nothing is changed on any error.
#[tauri::command]
pub async fn install_app_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdateState>,
    version: String,
) -> Result<(), String> {
    if !configured(app.config()) {
        return Err("Updates are not turned on in this build.".to_string());
    }
    if let (_, Some(blocker)) = current_bundle()? {
        return Err(blocker.to_string());
    }
    let update = state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .filter(|update| update.version == version)
        .ok_or(STALE_REVIEW)?;
    {
        let mut installing = state.installing.lock().unwrap_or_else(|e| e.into_inner());
        if *installing {
            return Err("The new version is already being installed.".to_string());
        }
        *installing = true;
    }
    let _installing = Installing(&state.installing);
    // Fail before the download when an apply runs; the install below takes the lock for real.
    drop(crate::mutation_lock::try_acquire(APPLY_RUNNING)?);

    let mut downloaded = 0u64;
    let mut last_emit: Option<Instant> = None;
    let emitter = app.clone();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let finished = total.is_some_and(|total| downloaded >= total);
                if finished || last_emit.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
                    last_emit = Some(Instant::now());
                    let _ = emitter.emit(
                        UPDATE_PROGRESS_EVENT,
                        UpdateProgress {
                            phase: UpdatePhase::Download,
                            downloaded,
                            total,
                        },
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|error| user_error(&error, DOWNLOAD_FAILED))?;
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        UpdateProgress {
            phase: UpdatePhase::Install,
            downloaded,
            total: Some(downloaded),
        },
    );
    // No apply may start while the bundle is swapped, and none may be running.
    let mutation = crate::mutation_lock::try_acquire(APPLY_RUNNING)?;
    update.install(&bytes).map_err(|error| {
        user_error(
            &error,
            "The new version could not be installed. Nothing was changed.",
        )
    })?;
    // The restart is only requested here; keep the lock until the process exits, so no apply starts and is cut off.
    std::mem::forget(mutation);
    app.request_restart();
    Ok(())
}

/// Lets the "Check for Updates…" menu item reach the UI.
pub fn request_check_from_menu<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::window_placement::MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(UPDATE_MENU_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn on() -> Value {
        json!({
            "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=",
            "endpoints": ["https://github.com/hugrverk/riggverk/releases/latest/download/latest.json"],
            "requireSignedVersion": true
        })
    }

    #[test]
    fn updates_are_off_without_a_complete_and_strict_config() {
        assert_eq!(config_problem(None), Some("no plugins.updater"));
        assert_eq!(config_problem(Some(&on())), None);
        let with = |key: &str, value: Value| {
            let mut config = on();
            config[key] = value;
            config_problem(Some(&config))
        };
        assert!(with("pubkey", json!("  ")).is_some());
        assert!(with("endpoints", json!([])).is_some());
        assert!(with("endpoints", json!(["http://example.invalid/latest.json"])).is_some());
        assert!(with("requireSignedVersion", json!(false)).is_some());
        assert!(with("allowDowngrades", json!(true)).is_some());
        assert!(with("dangerousAcceptInvalidCerts", json!(true)).is_some());
        assert!(with("allow-downgrades", json!(true)).is_some());
        assert!(with("dangerous-accept-invalid-certs", json!(true)).is_some());
        let mut unbound = on();
        unbound
            .as_object_mut()
            .expect("object")
            .remove("requireSignedVersion");
        assert!(config_problem(Some(&unbound)).is_some());
    }

    #[test]
    fn the_shipped_config_keeps_updates_off_or_strict() {
        let conf: Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid JSON");
        let updater = conf.pointer("/plugins/updater");
        if let Some(updater) = updater {
            assert_eq!(
                config_problem(Some(updater)),
                None,
                "a plugins.updater block must turn updates on fully"
            );
        }
        // The webview never gets the plugin's commands.
        let capability = include_str!("../capabilities/default.json");
        assert!(!capability.contains("updater"));
    }

    #[test]
    fn only_a_daily_choice_with_a_day_passed_checks_on_its_own() {
        let now = 10 * DAILY_INTERVAL_SECS;
        assert!(automatic_check_due("daily", None, now));
        assert!(automatic_check_due(
            "daily",
            Some(now - DAILY_INTERVAL_SECS),
            now
        ));
        assert!(!automatic_check_due("daily", Some(now - 60), now));
        assert!(
            automatic_check_due("daily", Some(now + 3600), now),
            "a clock set back does not stop checks"
        );
        for choice in ["ask", "manual", ""] {
            assert!(!automatic_check_due(choice, None, now), "{choice}");
        }
    }

    #[test]
    fn the_bundle_is_found_above_the_executable() {
        let exe = Path::new("/Applications/Riggverk.app/Contents/MacOS/riggverk");
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from("/Applications/Riggverk.app"))
        );
        assert_eq!(
            bundle_of(Path::new("/repo/src-tauri/target/debug/riggverk")),
            None
        );
    }

    #[test]
    fn a_translocated_or_read_only_app_must_be_moved_first() {
        let translocated = Path::new(
            "/private/var/folders/xy/T/AppTranslocation/0A1B2C3D-0000-0000-0000-000000000000/d/Riggverk.app",
        );
        assert_eq!(install_blocker(translocated), Some(MOVE_TO_APPLICATIONS));
        let writable = std::env::temp_dir();
        assert_eq!(install_blocker(&writable), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_read_only_volume_is_detected() {
        // The system volume is mounted read-only on every supported macOS.
        assert!(read_only_volume(Path::new("/System/Library")));
        assert!(!read_only_volume(&std::env::temp_dir()));
    }
}
