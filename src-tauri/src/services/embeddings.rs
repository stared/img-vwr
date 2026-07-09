use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use imgvwr_core::{thumb_cache_key, CodecRegistry, THUMB_MAX_EDGE};
use imgvwr_embed::{dot, is_downloaded, model_spec, Embedder, EmbedModelInfo, MODELS};
use tauri::AppHandle;
use tauri_specta::Event as _;

use crate::events::{EmbeddingProgress, EmbeddingStatus};
use crate::services::thumbnails::ThumbnailService;

/// Owns the loaded embedding model and the per-image vectors. The model is
/// picked by the user in the Similarity panel; vectors are cached on disk
/// keyed by the thumbnail cache key + model id, so re-indexing a folder is
/// instant after the first pass.
pub struct EmbeddingService {
    /// The active model; long-running work locks per image, not per run.
    embedder: Mutex<Option<Arc<Embedder>>>,
    /// path → normalized vector for everything indexed this session.
    vectors: Mutex<HashMap<String, Arc<Vec<f32>>>>,
    /// Hugging Face download cache (app-owned, no global installs).
    models_dir: PathBuf,
    /// Per-image vector files: {thumb_key}-{model_id}.vec (f32 LE).
    vectors_dir: PathBuf,
    /// Same directory the thumbnail service writes; embeddings read the
    /// cached 256 px thumbs instead of re-decoding originals.
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

    /// Download (if needed) and load a model on a background thread,
    /// reporting phases as events. Replaces the active model on success.
    pub fn select(self: &Arc<Self>, app: &AppHandle, model_id: String) {
        let Some(spec) = model_spec(&model_id) else {
            emit_status(app, &model_id, "error", Some("unknown model".into()));
            return;
        };
        let service = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            let phase = if is_downloaded(spec, &service.models_dir) {
                "loading"
            } else {
                "downloading"
            };
            emit_status(&app, spec.id, phase, None);
            match Embedder::load(spec, &service.models_dir) {
                Ok(embedder) => {
                    *service.embedder.lock().unwrap() = Some(Arc::new(embedder));
                    // Vectors from another model must never mix into ranking.
                    service.vectors.lock().unwrap().clear();
                    emit_status(&app, spec.id, "ready", None);
                }
                Err(e) => emit_status(&app, spec.id, "error", Some(e.to_string())),
            }
        });
    }

    /// Index a collection: one vector per image, disk-cached, progress
    /// events streamed. Epoch-guarded by the scope generation so switching
    /// folders stops the pass.
    pub fn index(
        self: &Arc<Self>,
        app: &AppHandle,
        thumbs: &Arc<ThumbnailService>,
        paths: Vec<String>,
        epoch: u64,
    ) {
        let service = Arc::clone(self);
        let thumbs = Arc::clone(thumbs);
        let app = app.clone();
        std::thread::spawn(move || {
            let Some(embedder) = service.embedder.lock().unwrap().clone() else {
                return;
            };
            let total = paths.len() as u32;
            let mut done = 0u32;
            for path in paths {
                if thumbs.is_stale(epoch) {
                    return;
                }
                let _ = service.vector_for(&embedder, &path);
                done += 1;
                if done.is_multiple_of(8) || done == total {
                    let _ = EmbeddingProgress { done, total, epoch }.emit(&app);
                }
            }
        });
    }

    /// Rank `paths` by similarity to an anchor image. Unindexed images are
    /// omitted (the sort puts them last).
    pub fn rank_image(&self, anchor: &str, paths: &[String]) -> Result<Vec<(String, f32)>, String> {
        let embedder = self.active()?;
        let anchor_vec = self.vector_for(&embedder, anchor).map_err(|e| e.to_string())?;
        Ok(self.rank(&anchor_vec, paths))
    }

    /// Rank `paths` by similarity to a text phrase.
    pub fn rank_text(&self, query: &str, paths: &[String]) -> Result<Vec<(String, f32)>, String> {
        let embedder = self.active()?;
        let query_vec = embedder.embed_text(query).map_err(|e| e.to_string())?;
        Ok(self.rank(&query_vec, paths))
    }

    fn active(&self) -> Result<Arc<Embedder>, String> {
        self.embedder
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no embedding model loaded".to_string())
    }

    fn rank(&self, anchor: &[f32], paths: &[String]) -> Vec<(String, f32)> {
        let vectors = self.vectors.lock().unwrap();
        paths
            .iter()
            .filter_map(|p| vectors.get(p).map(|v| (p.clone(), dot(anchor, v))))
            .collect()
    }

    /// The vector for one image: session memory → disk cache → compute from
    /// the cached thumbnail (generating that thumbnail if it doesn't exist).
    fn vector_for(&self, embedder: &Embedder, path: &str) -> Result<Arc<Vec<f32>>, String> {
        if let Some(v) = self.vectors.lock().unwrap().get(path) {
            return Ok(Arc::clone(v));
        }
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let key = thumb_cache_key(path, mtime_ms, meta.len(), THUMB_MAX_EDGE);
        let vec_file = self.vectors_dir.join(format!("{key}-{}.vec", embedder.model_id));

        let vector = match read_vector(&vec_file, embedder.dim) {
            Some(v) => v,
            None => {
                let thumb = self.thumb_file(path, &key)?;
                let v = embedder.embed_image_file(&thumb).map_err(|e| e.to_string())?;
                let _ = write_vector(&vec_file, &v);
                v
            }
        };
        let vector = Arc::new(vector);
        self.vectors
            .lock()
            .unwrap()
            .insert(path.to_string(), Arc::clone(&vector));
        Ok(vector)
    }

    /// The cached 256 px thumbnail for an image, generating it on the spot
    /// when the gallery hasn't needed it yet. AVIF (no Rust codec) fails
    /// here and the image simply stays unindexed.
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
