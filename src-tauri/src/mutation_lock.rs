//! Process-wide lock that queues the long-running mutating commands.
//!
//! Those commands run off the main thread (`#[tauri::command(async)]`) so the window keeps painting
//! progress events while they work. The main thread no longer serializes them, so each takes this lock
//! first and a second mutation waits for the running one instead of interleaving with it.
//!
//! This is separate from [`crate::setup_mutation_guard`], which is a non-blocking guard held only around
//! the writes of one transaction and rejects a concurrent mutation outright. This lock covers a whole
//! command, validation and fingerprint checks included, and makes the next command wait.

use std::sync::{Mutex, MutexGuard, PoisonError};

static MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Blocks until no other mutating command is running. Held until the returned guard is dropped; bind it
/// to a named variable (`let _mutation = ...`), not `_`.
///
/// A poisoned lock (a command panicked while holding it) is recovered rather than propagated: the lock
/// protects no data, only ordering.
pub fn acquire() -> MutexGuard<'static, ()> {
    lock_ignoring_poison(&MUTATION_LOCK)
}

fn lock_ignoring_poison(lock: &Mutex<()>) -> MutexGuard<'_, ()> {
    lock.lock().unwrap_or_else(PoisonError::into_inner)
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
        let inside = Arc::new(AtomicUsize::new(0));
        let max_inside = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let inside = Arc::clone(&inside);
                let max_inside = Arc::clone(&max_inside);
                thread::spawn(move || {
                    for _ in 0..5 {
                        let _mutation = acquire();
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
}
