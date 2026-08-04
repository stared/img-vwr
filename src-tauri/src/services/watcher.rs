//! Watches the open folder so files that appear on disk appear in the app.
//!
//! A scan is a snapshot. Importing from a card, exporting from another
//! program, or moving a file in Finder all happen *while* the app is showing
//! the folder, and until this existed none of them were visible until the
//! folder was opened again — which threw away the selection and the scroll
//! position along with the staleness.
//!
//! Two decisions shape everything here.
//!
//! **It reports the folder, not the events.** The OS says "something changed
//! at this path"; the app needs "here is what is in the folder now". Those
//! are different questions, and answering the second by accumulating the
//! first means reimplementing the filesystem — badly, since events are
//! coalesced, dropped under load, and arrive out of order. So a change is
//! only ever a trigger to look again, and what goes over the wire is the
//! result of a real scan. Adds, removals, renames and files that changed on
//! disk all fall out of one comparison the frontend already knows how to do.
//!
//! **It waits for the writing to stop.** Copying 300 raw files emits
//! thousands of events, and a file mid-copy is a truncated file: scanning
//! into the middle of an import yields entries whose size is wrong and whose
//! thumbnail fails to decode. So events push a deadline forward and the scan
//! happens in the quiet afterwards — with a ceiling, so a long import still
//! shows progress rather than nothing at all until it finishes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::AppHandle;

/// How long the folder must be quiet before it is worth re-reading.
///
/// Long enough that a burst of writes settles into one scan, short enough
/// that dragging a single file into the folder feels immediate.
const QUIET: Duration = Duration::from_millis(400);

/// Longest a continuous stream of changes may postpone a scan.
///
/// Without this, copying a card for two minutes would keep pushing the
/// deadline and show nothing until it finished. With it, the gallery fills as
/// the import runs, which is also what makes the wait bearable.
const MAX_WAIT: Duration = Duration::from_secs(3);

/// A folder being watched.
///
/// Holds nothing but the two things whose *lifetime* is the watch: dropping
/// this unregisters with the OS and ends the settling thread. Which epoch it
/// belongs to lives in `seen`, where the staleness rule needs it.
struct Watch {
    /// Kept alive: dropping the watcher unregisters it with the OS.
    _watcher: RecommendedWatcher,
    /// Wakes the settling thread; dropping it ends that thread.
    _nudge: Sender<()>,
}

pub struct WatchService {
    /// The current watch, if any. One at a time: the app shows one folder.
    current: Mutex<Option<Watch>>,
    /// Highest epoch ever asked for, so a late request for an older one is
    /// recognisable as stale.
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

    /// Watch `path` for this epoch, replacing whatever was watched before.
    ///
    /// Failure is deliberately not an error the user sees. A folder that
    /// cannot be watched (an exotic filesystem, a permission the OS declines)
    /// still lists and still opens; it is simply as stale as it was before
    /// this file existed.
    pub fn watch(&self, app: &AppHandle, path: PathBuf, recursive: bool, epoch: u64) {
        // Two folder opens in quick succession are two async commands, and
        // nothing guarantees they arrive in the order they were sent. An
        // older epoch turning up last would leave the app watching the folder
        // the user just left, so a stale request is dropped rather than
        // honoured. Epochs only ever increase.
        if !self.accepts(epoch) {
            return;
        }
        self.seen.fetch_max(epoch, Ordering::SeqCst);

        // Replace first, so the old watcher and its thread are gone before
        // the new one starts: two watchers on two folders would both be
        // emitting, and the epoch guard would silently drop one of them.
        self.stop();

        let (tx, rx) = channel::<()>();
        let nudge = tx.clone();
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<_>| {
            // The event itself is not read — see the module comment. Any
            // change means "look again".
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

    /// Stop watching. Called when the scope changes to something with no
    /// folder behind it — a remote source, or nothing.
    pub fn stop(&self) {
        *self.current.lock().unwrap() = None;
    }

    /// Whether a request for this epoch would be honoured or dropped as
    /// stale. Split out from `watch` so the rule can be tested without an
    /// `AppHandle`, which only a running app has.
    pub fn accepts(&self, epoch: u64) -> bool {
        self.seen.load(Ordering::SeqCst) <= epoch
    }
}

/// Wait for the folder to go quiet, then re-read it and report.
///
/// Ends when the channel closes, which happens when the `Watch` is dropped —
/// so replacing or stopping a watch also stops this thread, with no flag to
/// check and no chance of a scan for a folder nobody is looking at.
fn settle(app: &AppHandle, path: &Path, recursive: bool, epoch: u64, rx: &std::sync::mpsc::Receiver<()>) {
    loop {
        // Block until something happens. A folder nobody touches costs
        // nothing at all.
        if rx.recv().is_err() {
            return;
        }
        let first = Instant::now();
        // Drain the burst: keep extending the deadline while writes continue,
        // but never past the ceiling.
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

/// Re-read the folder and send what is in it now.
fn report(app: &AppHandle, path: &Path, recursive: bool, epoch: u64) {
    use tauri_specta::Event as _;
    let Ok(entries) = (if recursive {
        imgvwr_core::scan_dir_recursive(path)
    } else {
        imgvwr_core::scan_dir(path)
    }) else {
        // The folder was renamed or unmounted out from under us. Saying
        // nothing is right: an empty list would clear a gallery the user can
        // still see, and they have not asked to leave it.
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
        // Opening two folders quickly sends two async commands, and nothing
        // orders their arrival. If the first arrived last, the app would end
        // up watching the folder the user had just left.
        let service = WatchService::new();
        assert!(service.accepts(1));
        service.seen.store(2, Ordering::SeqCst);
        assert!(!service.accepts(1), "an older epoch is stale");
        assert!(service.accepts(2), "the current one is still welcome");
        assert!(service.accepts(3), "and so is the next");
    }

    /// The settling rule, tested where it lives rather than through the OS:
    /// a burst collapses into one scan, and a stream that never stops still
    /// gets scanned within the ceiling.
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

    /// The inner loop of `settle`, so the timing rule is testable without a
    /// running app. Returns false when the channel closed.
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
