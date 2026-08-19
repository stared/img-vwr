//! An OS event is only a trigger to look again: the wire carries a real re-scan, taken after the writes go quiet.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::AppHandle;

const QUIET: Duration = Duration::from_millis(400);

/// Ceiling on postponement: a long import must fill the gallery as it runs, not at the end.
const MAX_WAIT: Duration = Duration::from_secs(3);

/// Dropping this unregisters with the OS and ends the settling thread.
struct Watch {
    _watcher: RecommendedWatcher,
    _nudge: Sender<()>,
}

pub struct WatchService {
    current: Mutex<Option<Watch>>,
    /// Highest epoch ever asked for; a late request for an older one is stale.
    seen: AtomicU64,
}

impl Default for WatchService {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchService {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
            seen: AtomicU64::new(0),
        }
    }

    /// Failure is deliberately silent: an unwatchable folder still lists and opens, it just stays stale.
    pub fn watch(&self, app: &AppHandle, path: PathBuf, recursive: bool, epoch: u64) {
        // Async commands arrive in no particular order; a stale epoch is dropped, never honoured.
        if !self.accepts(epoch) {
            return;
        }
        self.seen.fetch_max(epoch, Ordering::SeqCst);

        // Replace first: two live watchers would both emit, and the epoch guard would silently drop one.
        self.stop();

        let (tx, rx) = channel::<()>();
        let nudge = tx.clone();
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<_>| {
            // The event itself is not read; any change just means "look again".
            if res.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(watcher) => watcher,
            Err(_) => return,
        };
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        if watcher.watch(&path, mode).is_err() {
            return;
        }

        let app = app.clone();
        std::thread::spawn(move || settle(&app, &path, recursive, epoch, &rx));

        *self.current.lock().unwrap() = Some(Watch {
            _watcher: watcher,
            _nudge: nudge,
        });
    }

    pub fn stop(&self) {
        *self.current.lock().unwrap() = None;
    }

    /// Split out from `watch` so the rule is testable without an `AppHandle`.
    pub fn accepts(&self, epoch: u64) -> bool {
        self.seen.load(Ordering::SeqCst) <= epoch
    }
}

/// Ends when the channel closes — dropping the `Watch` is what stops this thread.
fn settle(app: &AppHandle, path: &Path, recursive: bool, epoch: u64, rx: &std::sync::mpsc::Receiver<()>) {
    loop {
        if rx.recv().is_err() {
            return;
        }
        let first = Instant::now();
        // Extend the deadline while writes continue, never past the ceiling.
        loop {
            let remaining = MAX_WAIT.saturating_sub(first.elapsed());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(QUIET.min(remaining)) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        report(app, path, recursive, epoch);
    }
}

fn report(app: &AppHandle, path: &Path, recursive: bool, epoch: u64) {
    use tauri_specta::Event as _;
    let Ok(entries) = (if recursive {
        imgvwr_core::scan_dir_recursive(path)
    } else {
        imgvwr_core::scan_dir(path)
    }) else {
        // Renamed or unmounted under us: say nothing — an empty list would clear a gallery the user can still see.
        return;
    };
    let _ = crate::events::FolderChanged { entries, epoch }.emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_watched_to_begin_with() {
        assert!(WatchService::new().current.lock().unwrap().is_none());
    }

    #[test]
    fn stopping_forgets_the_folder() {
        let service = WatchService::new();
        service.stop();
        assert!(service.current.lock().unwrap().is_none());
    }

    #[test]
    fn a_late_request_for_an_older_collection_is_dropped() {
        let service = WatchService::new();
        assert!(service.accepts(1));
        service.seen.store(2, Ordering::SeqCst);
        assert!(!service.accepts(1), "an older epoch is stale");
        assert!(service.accepts(2), "the current one is still welcome");
        assert!(service.accepts(3), "and so is the next");
    }

    #[test]
    fn a_burst_of_changes_settles_into_one_look() {
        let (tx, rx) = channel::<()>();
        // 50 events in a row, as a card copy would produce.
        for _ in 0..50 {
            tx.send(()).unwrap();
        }
        let start = Instant::now();
        let quiet = drain_for_test(&rx);
        assert!(quiet, "the burst ended and the folder went quiet");
        // It waited for silence rather than scanning 50 times.
        assert!(start.elapsed() >= QUIET, "waited {:?}", start.elapsed());
        assert!(start.elapsed() < MAX_WAIT, "did not sit out the ceiling");
    }

    #[test]
    fn a_dropped_watch_ends_the_thread_rather_than_scanning() {
        let (tx, rx) = channel::<()>();
        tx.send(()).unwrap();
        drop(tx);
        // Disconnected, not merely quiet: the caller must return, not report.
        assert!(!drain_for_test(&rx), "a closed channel is not a quiet folder");
    }

    /// The inner loop of `settle`, testable without a running app; false = the channel closed.
    fn drain_for_test(rx: &std::sync::mpsc::Receiver<()>) -> bool {
        if rx.recv().is_err() {
            return false;
        }
        let first = Instant::now();
        loop {
            let remaining = MAX_WAIT.saturating_sub(first.elapsed());
            if remaining.is_zero() {
                return true;
            }
            match rx.recv_timeout(QUIET.min(remaining)) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => return true,
                Err(RecvTimeoutError::Disconnected) => return false,
            }
        }
    }
}
