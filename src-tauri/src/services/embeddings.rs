use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use imgvwr_core::{thumb_cache_key, CodecRegistry, THUMB_MAX_EDGE};

/// Pinned like the face sidecars' key edge, so a display-thumbnail resolution bump does not re-embed every corpus.
const VECTOR_KEY_EDGE: u32 = 256;
use imgvwr_embed::{dot, is_downloaded, model_spec, EmbedModelInfo, Embedder, MODELS};
use tauri::AppHandle;
use tauri_specta::Event as _;

use crate::events::{EmbeddingProgress, EmbeddingStatus};
use crate::services::thumbnails::ThumbnailService;

/// Keyed by (model id, image path or query phrase) so two models' vectors sit side by side.
type VectorCache = Mutex<HashMap<(String, String), Arc<Vec<f32>>>>;

/// A drop guard, not a hand-cleared flag: every way out of the pass — early return, panic — clears it.
struct IndexingPass<'a>(&'a AtomicBool);

impl Drop for IndexingPass<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct EmbeddingService {
    /// Long-running work locks per image, not per run.
    embedder: Mutex<Option<Arc<Embedder>>>,
    vectors: VectorCache,
    /// Cached: a folder re-ranks on every progress batch, and that must not be a forward pass per batch.
    queries: VectorCache,
    /// Loading cannot be cancelled; only the latest request may become active or emit status.
    selection_generation: AtomicU64,
    indexing: AtomicBool,
    /// Hugging Face download cache (app-owned, no global installs).
    models_dir: PathBuf,
    /// Per-image vector files: {thumb_key}-{model_id}.vec (f32 LE).
    vectors_dir: PathBuf,
    /// The same directory the thumbnail service writes; embeddings read its cached thumbs.
    thumbs_dir: PathBuf,
    registry: CodecRegistry,
}

impl EmbeddingService {
    pub fn new(cache_root: PathBuf) -> std::io::Result<Self> {
        let models_dir = cache_root.join("models");
        let vectors_dir = cache_root.join("embeddings");
        let thumbs_dir = cache_root.join("thumbnails");
        std::fs::create_dir_all(&models_dir)?;
        std::fs::create_dir_all(&vectors_dir)?;
        std::fs::create_dir_all(&thumbs_dir)?;
        Ok(Self {
            embedder: Mutex::new(None),
            vectors: Mutex::new(HashMap::new()),
            queries: Mutex::new(HashMap::new()),
            selection_generation: AtomicU64::new(0),
            indexing: AtomicBool::new(false),
            models_dir,
            vectors_dir,
            thumbs_dir,
            registry: CodecRegistry::builtin(),
        })
    }

    pub fn models(&self) -> Vec<EmbedModelInfo> {
        let active = self
            .embedder
            .lock()
            .unwrap()
            .as_ref()
            .map(|e| e.model_id.to_string());
        MODELS
            .iter()
            .map(|spec| EmbedModelInfo {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                quality: spec.quality.to_string(),
                speed: spec.speed.to_string(),
                download_mb: spec.download_mb,
                dim: spec.dim,
                downloaded: is_downloaded(spec, &self.models_dir),
                active: active.as_deref() == Some(spec.id),
            })
            .collect()
    }

    fn begin_selection(&self) -> u64 {
        self.selection_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current_selection(&self, generation: u64) -> bool {
        self.selection_generation.load(Ordering::SeqCst) == generation
    }

    pub fn select(self: &Arc<Self>, app: &AppHandle, model_id: String) {
        let Some(spec) = model_spec(&model_id) else {
            emit_status(app, &model_id, "error", Some("unknown model".into()));
            return;
        };
        let generation = self.begin_selection();
        let service = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            let phase = if is_downloaded(spec, &service.models_dir) {
                "loading"
            } else {
                "downloading"
            };
            if service.is_current_selection(generation) {
                emit_status(&app, spec.id, phase, None);
            }
            match Embedder::load(spec, &service.models_dir) {
                Ok(embedder) => {
                    if !service.is_current_selection(generation) {
                        return;
                    }
                    *service.embedder.lock().unwrap() = Some(Arc::new(embedder));
                    emit_status(&app, spec.id, "ready", None);
                }
                Err(e) => {
                    if service.is_current_selection(generation) {
                        emit_status(&app, spec.id, "error", Some(e.to_string()));
                    }
                }
            }
        });
    }

    pub fn index(
        self: &Arc<Self>,
        app: &AppHandle,
        thumbs: &Arc<ThumbnailService>,
        paths: Vec<String>,
        epoch: u64,
    ) {
        // One pass at a time: a second request is asking for work already being done.
        if self.indexing.swap(true, Ordering::SeqCst) {
            return;
        }
        let service = Arc::clone(self);
        let thumbs = Arc::clone(thumbs);
        let app = app.clone();
        std::thread::spawn(move || {
            let _pass = IndexingPass(&service.indexing);
            let Some(embedder) = service.embedder.lock().unwrap().clone() else {
                return;
            };
            let total = paths.len() as u32;
            let mut done = 0u32;
            for path in paths {
                if thumbs.is_stale(epoch) {
                    return;
                }
                if let Err(e) = service.vector_for(&embedder, &path) {
                    // Unindexable images just sort last; the pass must not fail.
                    eprintln!("embedding failed for {path}: {e}");
                }
                done += 1;
                if done.is_multiple_of(8) || done == total {
                    let _ = EmbeddingProgress { done, total, epoch }.emit(&app);
                }
            }
        });
    }

    /// Unindexed paths are omitted from the result.
    pub fn rank_image(&self, anchor: &str, paths: &[String]) -> Result<Vec<(String, f32)>, String> {
        let embedder = self.active()?;
        let anchor_vec = self
            .vector_for(&embedder, anchor)
            .map_err(|e| e.to_string())?;
        Ok(self.rank(embedder.model_id, &anchor_vec, paths))
    }

    /// The already-known vector for a path (memory or disk), never computing.
    pub fn known_vector_for_path(&self, path: &str) -> Option<Arc<Vec<f32>>> {
        let embedder = self.active().ok()?;
        self.known_vector(&embedder, path)
    }

    /// scores[i][d-1] compares paths[i] with paths[i-d]; reads cached vectors only, never computes one.
    pub fn banded_scores(
        &self,
        paths: &[String],
        band: usize,
    ) -> Result<Vec<Vec<Option<f32>>>, String> {
        let embedder = self.active()?;
        let vectors: Vec<Option<Arc<Vec<f32>>>> = paths
            .iter()
            .map(|p| self.known_vector(&embedder, p))
            .collect();
        Ok((0..paths.len())
            .map(|i| {
                (1..=band.min(i))
                    .map(|d| match (&vectors[i], &vectors[i - d]) {
                        (Some(a), Some(b)) => Some(dot(a, b)),
                        _ => None,
                    })
                    .collect()
            })
            .collect())
    }

    pub fn rank_text(&self, query: &str, paths: &[String]) -> Result<Vec<(String, f32)>, String> {
        let embedder = self.active()?;
        let key = (embedder.model_id.to_string(), query.to_string());
        if let Some(cached) = self.queries.lock().unwrap().get(&key) {
            return Ok(self.rank(embedder.model_id, cached, paths));
        }
        let query_vec = Arc::new(embedder.embed_text(query).map_err(|e| e.to_string())?);
        self.queries
            .lock()
            .unwrap()
            .insert(key, Arc::clone(&query_vec));
        Ok(self.rank(embedder.model_id, &query_vec, paths))
    }

    fn active(&self) -> Result<Arc<Embedder>, String> {
        self.embedder
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no embedding model loaded".to_string())
    }

    fn rank(&self, model_id: &str, anchor: &[f32], paths: &[String]) -> Vec<(String, f32)> {
        let vectors = self.vectors.lock().unwrap();
        paths
            .iter()
            .filter_map(|p| {
                vectors
                    .get(&(model_id.to_string(), p.clone()))
                    .map(|v| (p.clone(), dot(anchor, v)))
            })
            .collect()
    }

    fn vector_file(&self, embedder: &Embedder, path: &str) -> Result<PathBuf, String> {
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let key = thumb_cache_key(path, mtime_ms, meta.len(), VECTOR_KEY_EDGE);
        Ok(self
            .vectors_dir
            .join(format!("{key}-{}.vec", embedder.model_id)))
    }

    /// Session memory or the disk cache — never computes.
    fn known_vector(&self, embedder: &Embedder, path: &str) -> Option<Arc<Vec<f32>>> {
        let memory_key = (embedder.model_id.to_string(), path.to_string());
        if let Some(v) = self.vectors.lock().unwrap().get(&memory_key) {
            return Some(Arc::clone(v));
        }
        let vec_file = self.vector_file(embedder, path).ok()?;
        let vector = Arc::new(read_vector(&vec_file, embedder.dim)?);
        self.vectors
            .lock()
            .unwrap()
            .insert(memory_key, Arc::clone(&vector));
        Some(vector)
    }

    fn vector_for(&self, embedder: &Embedder, path: &str) -> Result<Arc<Vec<f32>>, String> {
        if let Some(v) = self.known_vector(embedder, path) {
            return Ok(v);
        }
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let vec_file = self.vector_file(embedder, path)?;
        // Pixels come from the live display-thumbnail cache at today's size; the vector's identity key does not care.
        let key = thumb_cache_key(path, mtime_ms, meta.len(), THUMB_MAX_EDGE);
        let thumb = self.thumb_file(path, &key)?;
        let vector = embedder
            .embed_image_file(&thumb)
            .map_err(|e| e.to_string())?;
        if let Err(e) = write_vector(&vec_file, &vector) {
            eprintln!("vector cache write failed for {}: {e}", vec_file.display());
        }
        let vector = Arc::new(vector);
        let memory_key = (embedder.model_id.to_string(), path.to_string());
        self.vectors
            .lock()
            .unwrap()
            .insert(memory_key, Arc::clone(&vector));
        Ok(vector)
    }

    /// Formats with no Rust codec (AVIF) fail here and the image simply stays unindexed.
    fn thumb_file(&self, path: &str, key: &str) -> Result<PathBuf, String> {
        let cache_file = self.thumbs_dir.join(format!("{key}.webp"));
        if cache_file.exists() {
            return Ok(cache_file);
        }
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let webp = imgvwr_core::make_thumbnail(&ext, &bytes, &self.registry, THUMB_MAX_EDGE)
            .map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&self.thumbs_dir).map_err(|e| e.to_string())?;
        let tmp = cache_file.with_extension("webp.tmp");
        std::fs::write(&tmp, webp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &cache_file).map_err(|e| e.to_string())?;
        Ok(cache_file)
    }
}

fn read_vector(file: &Path, dim: usize) -> Option<Vec<f32>> {
    let bytes = std::fs::read(file).ok()?;
    if bytes.len() != dim * 4 {
        return None; // stale schema or truncated write — recompute
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

fn write_vector(file: &Path, v: &[f32]) -> std::io::Result<()> {
    // macOS may purge ~/Library/Caches while the app runs — recreate rather than fail every write.
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for x in v {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    let tmp = file.with_extension("vec.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, file)
}

fn emit_status(app: &AppHandle, model_id: &str, phase: &str, error: Option<String>) {
    let _ = EmbeddingStatus {
        model_id: model_id.to_string(),
        phase: phase.to_string(),
        error,
    }
    .emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_for_different_models_stay_isolated() {
        let tmp = tempfile::tempdir().unwrap();
        let service = EmbeddingService::new(tmp.path().to_path_buf()).unwrap();
        let path = "/photo.jpg".to_string();
        service.vectors.lock().unwrap().insert(
            ("model-a".to_string(), path.clone()),
            Arc::new(vec![1.0, 0.0]),
        );
        service.vectors.lock().unwrap().insert(
            ("model-b".to_string(), path.clone()),
            Arc::new(vec![0.0, 1.0]),
        );

        assert_eq!(
            service.rank("model-a", &[1.0, 0.0], &[path.clone()]),
            vec![(path.clone(), 1.0)]
        );
        assert_eq!(
            service.rank("model-b", &[1.0, 0.0], &[path.clone()]),
            vec![(path, 0.0)]
        );
    }

    #[test]
    fn a_second_indexing_request_does_not_start_a_second_pass() {
        let tmp = tempfile::tempdir().unwrap();
        let service = EmbeddingService::new(tmp.path().to_path_buf()).unwrap();

        // What `index` does on the calling thread, before it spawns.
        let claim = || service.indexing.swap(true, Ordering::SeqCst);

        assert!(!claim(), "the first request finds nothing running and proceeds");
        let running = IndexingPass(&service.indexing);
        assert!(claim(), "a second, while it runs, is turned away");

        drop(running);
        assert!(!claim(), "and once the pass ends the next one may start");
    }

    #[test]
    fn the_indexing_flag_clears_however_the_pass_ends() {
        let tmp = tempfile::tempdir().unwrap();
        let service = Arc::new(EmbeddingService::new(tmp.path().to_path_buf()).unwrap());
        service.indexing.store(true, Ordering::SeqCst);

        let inside = Arc::clone(&service);
        let died = std::thread::spawn(move || {
            let _pass = IndexingPass(&inside.indexing);
            panic!("one image blew up");
        })
        .join();

        assert!(died.is_err(), "the pass really did panic");
        assert!(!service.indexing.load(Ordering::SeqCst), "and still cleared the flag");
    }

    #[test]
    fn a_phrase_is_embedded_once_per_model() {
        let tmp = tempfile::tempdir().unwrap();
        let service = EmbeddingService::new(tmp.path().to_path_buf()).unwrap();
        let key = ("siglip2-base".to_string(), "people dancing".to_string());
        service
            .queries
            .lock()
            .unwrap()
            .insert(key.clone(), Arc::new(vec![1.0, 0.0]));

        assert!(service.queries.lock().unwrap().contains_key(&key));
        // Same words, different model: the cache must not answer for the wrong one.
        assert!(!service
            .queries
            .lock()
            .unwrap()
            .contains_key(&("siglip2-so400m".to_string(), "people dancing".to_string())));
    }

    #[test]
    fn only_the_latest_model_selection_is_current() {
        let tmp = tempfile::tempdir().unwrap();
        let service = EmbeddingService::new(tmp.path().to_path_buf()).unwrap();
        let first = service.begin_selection();
        let second = service.begin_selection();

        assert!(!service.is_current_selection(first));
        assert!(service.is_current_selection(second));
    }
}
