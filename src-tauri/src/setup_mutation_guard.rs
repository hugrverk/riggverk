//! Process-wide guard for filesystem-mutating installation operations.
//!
//! Read-only preview, health, diff, discovery, and planning commands must not
//! acquire this guard.

use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};

static SETUP_MUTATION_GUARD: OnceLock<Mutex<()>> = OnceLock::new();

fn guard_mutex() -> &'static Mutex<()> {
    SETUP_MUTATION_GUARD.get_or_init(|| Mutex::new(()))
}

/// RAII guard released when dropped. Acquire with [`try_acquire_setup_mutation_guard`].
pub struct SetupMutationGuard {
    _inner: MutexGuard<'static, ()>,
}

/// Try to acquire the setup mutation guard without blocking.
///
/// Returns a structured error when another mutation is already in progress.
pub fn try_acquire_setup_mutation_guard() -> Result<SetupMutationGuard, String> {
    match guard_mutex().try_lock() {
        Ok(inner) => Ok(SetupMutationGuard { _inner: inner }),
        Err(TryLockError::WouldBlock) => Err("setup operation already in progress".to_string()),
        Err(TryLockError::Poisoned(poisoned)) => Ok(SetupMutationGuard {
            _inner: poisoned.into_inner(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::thread;

    static GUARD_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn only_one_mutation_guard_at_a_time() {
        let _serial = GUARD_TEST_LOCK.lock().expect("guard test lock");
        let first = try_acquire_setup_mutation_guard().expect("first acquire");
        match try_acquire_setup_mutation_guard() {
            Ok(_) => panic!("second acquire must fail"),
            Err(second) => assert!(
                second.contains("already in progress"),
                "unexpected error: {second}"
            ),
        }
        drop(first);
        assert!(try_acquire_setup_mutation_guard().is_ok());
    }

    #[test]
    fn guard_released_after_panic_safe_drop() {
        let _serial = GUARD_TEST_LOCK.lock().expect("guard test lock");
        {
            let _g = try_acquire_setup_mutation_guard().expect("acquire");
        }
        assert!(try_acquire_setup_mutation_guard().is_ok());
    }

    #[test]
    fn concurrent_second_thread_gets_rejected() {
        let _serial = GUARD_TEST_LOCK.lock().expect("guard test lock");
        let first = try_acquire_setup_mutation_guard().expect("main acquire");
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_clone = Arc::clone(&done);
        let handle = thread::spawn(move || match try_acquire_setup_mutation_guard() {
            Ok(_) => panic!("second acquire must fail"),
            Err(err) => {
                assert!(err.contains("already in progress"), "unexpected: {err}");
                done_clone.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
        handle.join().expect("thread join");
        assert!(done.load(std::sync::atomic::Ordering::SeqCst));
        drop(first);
    }
}
