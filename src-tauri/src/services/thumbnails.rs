use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use imgvwr_core::{thumb_cache_key, CodecError, CodecRegistry, ThumbError, THUMB_MAX_EDGE};
use tauri::AppHandle;
use tauri_specta::Event as _;

use crate::events::{ThumbnailFailed, ThumbnailReady};

/// Owns all mutable thumbnailing state: the folder epoch, the decode pool and
/// the in-flight set. Everything it calls in `imgvwr-core` is pure.
pub struct ThumbnailService {
    epoch: AtomicU64,
    pool: rayon::ThreadPool,
    registry: Arc<CodecRegistry>,
    cache_dir: PathBuf,
    in_flight: Mutex<HashSet<String>>,
}

impl ThumbnailService {
    pub fn new(cache_dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&cache_dir)?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(1).max(1))
            .unwrap_or(2);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("thumb-{i}"))
            .build()
            .expect("failed to build thumbnail thread pool");
        Ok(Self {
            epoch: AtomicU64::new(0),
            pool,
            registry: Arc::new(CodecRegistry::builtin()),
            cache_dir,
            in_flight: Mutex::new(HashSet::new()),
        })
    }

    /// Called on folder change; all jobs holding an older epoch become no-ops.
    pub fn bump_epoch(&self) -> u64 {
        self.epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_stale(&self, epoch: u64) -> bool {
        self.epoch.load(Ordering::SeqCst) != epoch
    }

    pub fn request(self: &Arc<Self>, app: &AppHandle, paths: Vec<String>, epoch: u64) {
        for path in paths {
            if self.is_stale(epoch) {
                return;
            }
            self.request_one(app, path, epoch);
        }
    }

    fn request_one(self: &Arc<Self>, app: &AppHandle, path: String, epoch: u64) {
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                emit_failed(app, &path, &e.to_string(), epoch);
                return;
            }
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let key = thumb_cache_key(&path, mtime_ms, meta.len(), THUMB_MAX_EDGE);
        let cache_file = self.cache_dir.join(format!("{key}.webp"));

        if cache_file.exists() {
            emit_ready(app, &path, &cache_file, epoch);
            return;
        }

        // Dedupe: skip if an identical job is already queued or running.
        if !self.in_flight.lock().unwrap().insert(key.clone()) {
            return;
        }

        let service = Arc::clone(self);
        let app = app.clone();
        self.pool.spawn(move || {
            if !service.is_stale(epoch) {
                service.generate(&app, &path, &cache_file, epoch);
            }
            service.in_flight.lock().unwrap().remove(&key);
        });
    }

    /// Runs on the rayon pool: decode → thumbnail → atomic write → emit.
    fn generate(&self, app: &AppHandle, path: &str, cache_file: &Path, epoch: u64) {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();

        let result = std::fs::read(path).map_err(|e| e.to_string()).and_then(|bytes| {
            match imgvwr_core::make_thumbnail(&ext, &bytes, &self.registry, THUMB_MAX_EDGE) {
                Ok(webp) => write_atomically(cache_file, &webp)
                    .map(|()| cache_file.to_path_buf())
                    .map_err(|e| e.to_string()),
                // No Rust codec (e.g. AVIF): serve the original file and let
                // the webview decode and downscale it natively.
                Err(ThumbError::Codec(CodecError::Unsupported)) => Ok(PathBuf::from(path)),
                Err(e) => Err(e.to_string()),
            }
        });

        if self.is_stale(epoch) {
            return;
        }
        match result {
            Ok(shown_file) => emit_ready(app, path, &shown_file, epoch),
            Err(error) => emit_failed(app, path, &error, epoch),
        }
    }
}

/// Write via temp file + rename so a concurrent reader never sees a half-written thumb.
fn write_atomically(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = target.with_extension("webp.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, target)
}

fn emit_ready(app: &AppHandle, path: &str, cache_file: &Path, epoch: u64) {
    let _ = ThumbnailReady {
        path: path.to_owned(),
        cache_file: cache_file.to_string_lossy().into_owned(),
        epoch,
    }
    .emit(app);
}

fn emit_failed(app: &AppHandle, path: &str, error: &str, epoch: u64) {
    let _ = ThumbnailFailed {
        path: path.to_owned(),
        error: error.to_owned(),
        epoch,
    }
    .emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_bump_invalidates_older_requests() {
        let tmp = tempfile::tempdir().unwrap();
        let service = ThumbnailService::new(tmp.path().to_path_buf()).unwrap();

        let first = service.bump_epoch();
        assert!(!service.is_stale(first));

        let second = service.bump_epoch();
        assert!(second > first);
        assert!(service.is_stale(first));
        assert!(!service.is_stale(second));
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("t.webp");
        write_atomically(&target, b"bytes").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"bytes");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }
}
