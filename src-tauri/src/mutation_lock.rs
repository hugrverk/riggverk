//! Process-wide lock that queues the long-running mutating commands.
//!
//! Those commands run off the main thread (`#[tauri::command(async)]`) so the window keeps painting
//! progress events while they work. The main thread no longer serializes them, so each takes this lock
//! first and a second mutation waits for the running one instead of interleaving with it.
//!
//! This is separate from [`crate::setup_mutation_guard`], which is a non-blocking guard held only around
//! the writes of one transaction and rejects a concurrent mutation outright. This lock covers a whole
//! command, validation and fingerprint checks included, and makes the next command wait.
//!
//! A second app instance (`open -n`, a dev build) shares the same files and backups, and would roll
//! back this instance's running transaction as an interrupted one. So the lock also holds an
//! exclusive advisory file lock (`flock`, Unix only) in the app's data folder for as long as it is
//! held; the other instance is refused with [`BUSY_IN_ANOTHER_WINDOW`] instead of waiting.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

static MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Shown when another app instance holds the lock.
pub const BUSY_IN_ANOTHER_WINDOW: &str =
    "Riggverk is busy in another window. Finish there or close it, then try again.";

const LOCK_FILE_NAME: &str = "mutation.lock";

/// Held for the whole mutating command. Fields drop in order: the file lock is released first.
pub struct MutationGuard {
    _instance: Option<instance::InstanceLock>,
    _process: MutexGuard<'static, ()>,
}

/// Blocks until no other mutating command of this process is running, then takes the lock that
/// keeps other app instances out. Held until the returned guard is dropped; bind it to a named
/// variable (`let _mutation = ...?`), not `_`. Refused with [`BUSY_IN_ANOTHER_WINDOW`] while another
/// instance holds it.
///
/// A poisoned lock (a command panicked while holding it) is recovered rather than propagated: the lock
/// protects no data, only ordering. A lock file that cannot be opened is not a reason to refuse: the
/// file lock is advisory and the command still runs.
pub fn acquire() -> Result<MutationGuard, String> {
    let process = lock_ignoring_poison(&MUTATION_LOCK);
    let instance = match lock_path() {
        Some(path) => instance::try_lock(&path)?,
        None => None,
    };
    Ok(MutationGuard {
        _instance: instance,
        _process: process,
    })
}

fn lock_ignoring_poison(lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `<app data folder>/mutation.lock`, the folder settings live in: every instance of one user sees
/// the same file.
fn lock_path() -> Option<PathBuf> {
    let dir = crate::platform_paths::app_support_dir(
        &crate::platform_paths::PlatformEnv::from_process_env(),
        crate::platform_paths::Platform::current(),
    )
    .ok()?;
    // A test never creates a lock file in a real folder: only under a temp HOME.
    #[cfg(test)]
    if !dir.starts_with(std::env::temp_dir()) {
        return None;
    }
    Some(dir.join(LOCK_FILE_NAME))
}

#[cfg(unix)]
mod instance {
    use std::fs::{File, OpenOptions};
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    /// An open lock file with an exclusive `flock` on it; closing the file releases the lock.
    pub struct InstanceLock {
        _file: File,
    }

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;

    /// The exclusive lock on `path`, `Err` with the busy message when another open file holds it,
    /// `Ok(None)` when the file cannot be used.
    pub fn try_lock(path: &Path) -> Result<Option<InstanceLock>, String> {
        // `std` has no `flock` and the crate has no `libc` dependency; `flock` is always linked on
        // Unix, and LOCK_EX/LOCK_NB have these values on macOS and Linux.
        extern "C" {
            fn flock(fd: i32, operation: i32) -> i32;
        }
        if let Some(parent) = path.parent() {
            if std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)
                .is_err()
            {
                return Ok(None);
            }
        }
        if std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.file_type().is_file()) {
            return Ok(None);
        }
        let Ok(file) = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
        else {
            return Ok(None);
        };
        // SAFETY: the descriptor is open for the call and owned by `file`; `flock` has no other
        // preconditions.
        if unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) } == 0 {
            return Ok(Some(InstanceLock { _file: file }));
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
            Err(super::BUSY_IN_ANOTHER_WINDOW.to_string())
        } else {
            Ok(None)
        }
    }
}

#[cfg(not(unix))]
mod instance {
    use std::path::Path;

    pub struct InstanceLock;

    /// No cross-process lock off Unix.
    pub fn try_lock(_path: &Path) -> Result<Option<InstanceLock>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn critical_sections_never_overlap() {
        let _env = crate::test_env::guard::lock();
        let inside = Arc::new(AtomicUsize::new(0));
        let max_inside = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let inside = Arc::clone(&inside);
                let max_inside = Arc::clone(&max_inside);
                thread::spawn(move || {
                    for _ in 0..5 {
                        let _mutation = acquire().expect("no other instance");
                        let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        max_inside.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(2));
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("worker thread");
        }
        assert_eq!(
            max_inside.load(Ordering::SeqCst),
            1,
            "two critical sections ran at the same time"
        );
    }

    #[test]
    fn a_second_acquire_waits_for_the_first_guard() {
        let lock = Arc::new(Mutex::new(()));
        let first = lock_ignoring_poison(&lock);
        let acquired = Arc::new(AtomicUsize::new(0));
        let waiter = {
            let lock = Arc::clone(&lock);
            let acquired = Arc::clone(&acquired);
            thread::spawn(move || {
                let _second = lock_ignoring_poison(&lock);
                acquired.store(1, Ordering::SeqCst);
            })
        };
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            acquired.load(Ordering::SeqCst),
            0,
            "the second acquire must wait while the first guard is held"
        );
        drop(first);
        waiter.join().expect("waiter thread");
        assert_eq!(acquired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_poisoned_lock_is_recovered() {
        let lock = Arc::new(Mutex::new(()));
        let poisoner = {
            let lock = Arc::clone(&lock);
            thread::spawn(move || {
                let _held = lock.lock().expect("lock before poisoning");
                panic!("poison the lock on purpose");
            })
        };
        assert!(poisoner.join().is_err(), "the poisoning thread must panic");
        assert!(lock.is_poisoned(), "the lock must be poisoned");

        drop(lock_ignoring_poison(&lock));
        // A later acquire still works after the recovered guard dropped.
        drop(lock_ignoring_poison(&lock));
    }
    #[cfg(unix)]
    #[test]
    fn another_instance_holding_the_file_lock_is_refused_not_waited_for() {
        let _env = crate::test_env::guard::lock();
        let _restore = crate::test_env::guard::isolate_data_location_env();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("aw-mutation-lock-{nanos}"));
        std::fs::create_dir_all(&home).expect("home");
        crate::test_env::set_test_user_dirs(&home);
        let path = lock_path().expect("a lock path under the temp home");

        let other = instance::try_lock(&path)
            .expect("free")
            .expect("the other instance holds the lock");
        match acquire() {
            Ok(_) => panic!("must be refused while another instance holds the lock"),
            Err(error) => assert_eq!(error, BUSY_IN_ANOTHER_WINDOW),
        }
        drop(other);

        let held = acquire().expect("free again");
        assert!(
            instance::try_lock(&path).is_err(),
            "another instance is refused while this one holds the lock"
        );
        drop(held);
        assert!(instance::try_lock(&path).expect("free").is_some());
        let _ = std::fs::remove_dir_all(&home);
    }
}
