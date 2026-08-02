use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use imgvwr_core::{
    thumb_cache_key, CodecError, CodecRegistry, SceneRegistry, ThumbError, THUMB_MAX_EDGE,
};
use tauri::AppHandle;
use tauri_specta::Event as _;

use crate::events::{ThumbnailFailed, ThumbnailReady};
use crate::services::develop::thumbnail_via_develop;

/// Owns all mutable thumbnailing state: the folder epoch, the decode pool and
/// the in-flight set. Everything it calls in `imgvwr-core` is pure.
pub struct ThumbnailService {
    epoch: AtomicU64,
    pool: rayon::ThreadPool,
    registry: Arc<CodecRegistry>,
    /// Fallback for formats no codec can decode — RAW files go through the
    /// develop pipeline instead, so a folder of NEFs looks like any other.
    scenes: Arc<SceneRegistry>,
    cache_dir: PathBuf,
    /// Work is deduplicated within one collection epoch. The same file may be
    /// requested again by a newer epoch while stale work is winding down.
    in_flight: Mutex<HashSet<(String, u64)>>,
}

impl ThumbnailService {
    pub fn new(cache_dir: PathBuf, scenes: Arc<SceneRegistry>) -> std::io::Result<Self> {
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
            scenes,
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
        let flight_key = (key.clone(), epoch);
        if !self.in_flight.lock().unwrap().insert(flight_key.clone()) {
            return;
        }

        let service = Arc::clone(self);
        let app = app.clone();
        self.pool.spawn(move || {
            if !service.is_stale(epoch) {
                service.generate(&app, &path, &cache_file, epoch);
            }
            service.in_flight.lock().unwrap().remove(&flight_key);
        });
    }

    /// Cached-thumbnail path for one image, generating it on the spot when
    /// the gallery has not needed it yet. Errors when no Rust codec supports
    /// the format (AVIF) — callers needing pixels can't use the fallback.
    pub fn cached_thumb(&self, path: &str) -> Result<PathBuf, String> {
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let key = thumb_cache_key(path, mtime_ms, meta.len(), THUMB_MAX_EDGE);
        let cache_file = self.cache_dir.join(format!("{key}.webp"));
        if cache_file.exists() {
            return Ok(cache_file);
        }
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let webp = self
            .thumbnail_bytes(path, &ext)?
            .ok_or_else(|| format!("no decoder can produce pixels for {path}"))?;
        write_atomically(&cache_file, &webp).map_err(|e| e.to_string())?;
        Ok(cache_file)
    }

    /// Encoded thumbnail bytes for one file, or `None` when no Rust pipeline
    /// can decode it at all and the caller should fall back to serving the
    /// original for the webview to handle (AVIF).
    ///
    /// Two pipelines, tried in cost order: the codec registry, then — for RAW,
    /// which no codec handles — the develop pipeline. RAW thumbnails render at
    /// the camera's own white balance with no edit applied, so the thumbnail
    /// cache stays valid while the user works on the image.
    fn thumbnail_bytes(&self, path: &str, ext: &str) -> Result<Option<Vec<u8>>, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        match imgvwr_core::make_thumbnail(ext, &bytes, &self.registry, THUMB_MAX_EDGE) {
            Ok(webp) => Ok(Some(webp)),
            Err(ThumbError::Codec(CodecError::Unsupported)) => {
                if self.scenes.supports(ext) {
                    // First open of a 24 MP raw file costs a couple of
                    // seconds; it happens once and is cached from then on.
                    thumbnail_via_develop(&self.scenes, Path::new(path), THUMB_MAX_EDGE).map(Some)
                } else {
                    Ok(None)
                }
            }
            Err(e) => Err(e.to_string()),
        }
    }

    /// Pixel statistics for the info panel, from the cached 256 px thumb.
    pub fn image_stats(&self, path: &str) -> Result<imgvwr_core::ImageStats, String> {
        let thumb = self.cached_thumb(path)?;
        let bytes = std::fs::read(&thumb).map_err(|e| e.to_string())?;
        let img = self
            .registry
            .decode("webp", &bytes)
            .map_err(|e| e.to_string())?;
        Ok(imgvwr_core::image_stats(&img))
    }

    /// Runs on the rayon pool: decode → thumbnail → atomic write → emit.
    fn generate(&self, app: &AppHandle, path: &str, cache_file: &Path, epoch: u64) {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();

        let result = self.thumbnail_bytes(path, &ext).and_then(|bytes| match bytes {
            Some(webp) => write_atomically(cache_file, &webp)
                .map(|()| cache_file.to_path_buf())
                .map_err(|e| e.to_string()),
            // No Rust pipeline at all (e.g. AVIF): serve the original file and
            // let the webview decode and downscale it natively.
            None => Ok(PathBuf::from(path)),
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
    // macOS may purge ~/Library/Caches while the app runs; recreate the
    // cache dir rather than fail every write until restart.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let tmp = target.with_extension(format!("webp.{}.{}.tmp", std::process::id(), id));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&tmp);
            Err(error)
        }
    }
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
        let scenes = Arc::new(SceneRegistry::new(vec![Arc::new(
            imgvwr_core::ImageCrateFormat::new(),
        )]));
        let service = ThumbnailService::new(tmp.path().to_path_buf(), scenes).unwrap();

        let first = service.bump_epoch();
        assert!(!service.is_stale(first));

        let second = service.bump_epoch();
        assert!(second > first);
        assert!(service.is_stale(first));
        assert!(!service.is_stale(second));
    }

    #[test]
    fn in_flight_deduplication_is_scoped_to_an_epoch() {
        let mut in_flight = HashSet::new();
        assert!(in_flight.insert(("same-cache-key".to_string(), 1)));
        assert!(!in_flight.insert(("same-cache-key".to_string(), 1)));
        assert!(in_flight.insert(("same-cache-key".to_string(), 2)));
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
