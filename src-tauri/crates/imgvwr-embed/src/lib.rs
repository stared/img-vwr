//! Image/text embedding for "similar to" search. A dual encoder maps images
//! and text phrases into one vector space; similarity is the dot product of
//! L2-normalized embeddings. Models are downloaded on demand from Hugging
//! Face into the app cache — never installed globally.

use std::sync::Mutex;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::siglip;
use serde::Serialize;
use tokenizers::Tokenizer;

#[derive(Debug)]
pub enum EmbedError {
    Download(String),
    Model(String),
    Image(String),
    Text(String),
}

impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmbedError::Download(m) => write!(f, "model download failed: {m}"),
            EmbedError::Model(m) => write!(f, "model failed: {m}"),
            EmbedError::Image(m) => write!(f, "image embedding failed: {m}"),
            EmbedError::Text(m) => write!(f, "text embedding failed: {m}"),
        }
    }
}

impl std::error::Error for EmbedError {}

/// One offered model: identity, where its weights live, and the picker notes.
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// One-line quality note for the picker.
    pub quality: &'static str,
    /// One-line speed note for the picker. Throughput was measured with this
    /// crate's `bench` example on an Apple Silicon GPU (Metal, release build).
    pub speed: &'static str,
    pub download_mb: u32,
    pub dim: u32,
    hf_repo: &'static str,
    image_size: usize,
}

/// The picks — SigLIP 2 only. MobileCLIP S2 was evaluated and dropped:
/// candle's Metal conv2d path makes its FastViT tower take ~78 s per image
/// (vs 14 ms for a ViT), and even on CPU it ran 60× behind SigLIP 2 Base on
/// the GPU — no niche left. ViTs are the fast path in this runtime; their
/// 256 px input matches the thumbnail cache exactly, so indexing never
/// re-decodes originals.
pub static MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "siglip2-base",
        label: "SigLIP 2 Base",
        quality: "strong retrieval, multilingual queries (Google, 2025)",
        speed: "fast — ~70 photos/s measured on an Apple Silicon GPU",
        download_mb: 1535,
        dim: 768,
        hf_repo: "google/siglip2-base-patch16-256",
        image_size: 256,
    },
    ModelSpec {
        id: "siglip2-so400m",
        label: "SigLIP 2 SO400M",
        quality: "best — the shape-optimized encoder behind PaliGemma",
        speed: "slower — bigger model, roughly 4× the base",
        download_mb: 4580,
        dim: 1152,
        hf_repo: "google/siglip2-so400m-patch16-256",
        image_size: 256,
    },
];

pub fn model_spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// Catalog entry as shown in the UI picker.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EmbedModelInfo {
    pub id: String,
    pub label: String,
    pub quality: String,
    pub speed: String,
    pub download_mb: u32,
    pub dim: u32,
    pub downloaded: bool,
    pub active: bool,
}

/// True when every file the model needs is already in the local cache.
pub fn is_downloaded(spec: &ModelSpec, cache_dir: &std::path::Path) -> bool {
    let cache = hf_hub::Cache::new(cache_dir.to_path_buf());
    let repo = cache.model(spec.hf_repo.to_string());
    ["model.safetensors", "tokenizer.json", "config.json"]
        .iter()
        .all(|f| repo.get(f).is_some())
}

pub struct Embedder {
    net: Box<siglip::Model>,
    tokenizer: Tokenizer,
    device: Device,
    image_size: usize,
    /// SigLIP pads text to a fixed length; (length, pad token id).
    text_pad: (usize, u32),
    /// Held for the length of every forward pass — see [`Embedder::busy`].
    gpu: Mutex<()>,
    pub model_id: &'static str,
    pub dim: usize,
}

fn best_device() -> Device {
    // Escape hatch for benchmarking and for machines with broken Metal.
    if std::env::var_os("IMGVWR_EMBED_CPU").is_some() {
        return Device::Cpu;
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(device) = Device::new_metal(0) {
            return device;
        }
    }
    Device::Cpu
}

impl Embedder {
    /// Claim the model for one forward pass.
    ///
    /// A `&self` method that computes on the GPU looks like it can be called
    /// from anywhere, and it cannot: candle's Metal device keeps a mutable
    /// residency set that Metal itself does not guard, so two threads
    /// building tensors on one device corrupt it and the process dies inside
    /// libmalloc with "pointer being freed was not allocated". That is not a
    /// hypothetical — it took the app down while a folder was indexing in the
    /// background and a phrase was ranked in the foreground, which is simply
    /// what using this feature looks like.
    ///
    /// So inference is serialised, here rather than at each call site. A
    /// caller cannot forget a lock it never has to take, and this is the only
    /// place that knows the device is not shareable.
    ///
    /// A plain mutex, not a try-lock: a queued forward pass is a wait, and a
    /// dropped one would be a wrong answer. Poisoning is ignored — a panic in
    /// one pass says nothing about the next, and refusing to embed for the
    /// rest of the session would be a worse failure than the one that caused
    /// it.
    fn busy(&self) -> std::sync::MutexGuard<'_, ()> {
        self.gpu.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Downloads (or reuses) the weights, then loads the model. Slow — run on
    /// a background thread. `cache_dir` is the app-owned model cache.
    pub fn load(spec: &'static ModelSpec, cache_dir: &std::path::Path) -> Result<Self, EmbedError> {
        let api = hf_hub::api::sync::ApiBuilder::new()
            .with_cache_dir(cache_dir.to_path_buf())
            .build()
            .map_err(|e| EmbedError::Download(e.to_string()))?;
        let repo = api.model(spec.hf_repo.to_string());
        let get = |file: &str| repo.get(file).map_err(|e| EmbedError::Download(e.to_string()));

        let weights = get("model.safetensors")?;
        let tokenizer =
            Tokenizer::from_file(get("tokenizer.json")?).map_err(|e| EmbedError::Model(e.to_string()))?;
        let config: siglip::Config = serde_json::from_slice(
            &std::fs::read(get("config.json")?).map_err(|e| EmbedError::Model(e.to_string()))?,
        )
        .map_err(|e| EmbedError::Model(e.to_string()))?;

        let device = best_device();
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(std::slice::from_ref(&weights), DType::F32, &device)
                .map_err(|e| EmbedError::Model(e.to_string()))?
        };
        let net = siglip::Model::new(&config, vb).map_err(|e| EmbedError::Model(e.to_string()))?;

        Ok(Self {
            net: Box::new(net),
            tokenizer,
            device,
            image_size: spec.image_size,
            text_pad: (
                config.text_config.max_position_embeddings,
                config.text_config.pad_token_id,
            ),
            gpu: Mutex::new(()),
            model_id: spec.id,
            dim: spec.dim as usize,
        })
    }

    /// Embed one image file (typically a cached thumbnail — already decoded
    /// once, downscaled and orientation-corrected). Returns an L2-normalized
    /// vector, so similarity is a plain dot product.
    pub fn embed_image_file(&self, path: &std::path::Path) -> Result<Vec<f32>, EmbedError> {
        let img = image::ImageReader::open(path)
            .map_err(|e| EmbedError::Image(e.to_string()))?
            .decode()
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let size = self.image_size;
        let img = img
            .resize_to_fill(size as u32, size as u32, image::imageops::FilterType::Triangle)
            .to_rgb8()
            .into_raw();
        // Everything above is CPU work on this thread's own data. From here
        // the device is touched, so the pass takes its turn.
        let _turn = self.busy();
        let tensor = Tensor::from_vec(img, (size, size, 3), &Device::Cpu)
            .and_then(|t| t.permute((2, 0, 1)))
            .and_then(|t| t.to_dtype(DType::F32))
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        // SigLIP pixel normalization: [0, 255] → [-1, 1].
        let tensor = tensor
            .affine(2. / 255., -1.)
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let batch = tensor
            .unsqueeze(0)
            .and_then(|t| t.to_device(&self.device))
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let features = self
            .net
            .get_image_features(&batch)
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let vec = features
            .flatten_all()
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        Ok(l2_normalize(vec))
    }

    /// Embed a query phrase into the same space; L2-normalized.
    pub fn embed_text(&self, query: &str) -> Result<Vec<f32>, EmbedError> {
        let encoding = self
            .tokenizer
            .encode(query, true)
            .map_err(|e| EmbedError::Text(e.to_string()))?;
        let mut ids = encoding.get_ids().to_vec();
        let (max_len, pad_id) = self.text_pad;
        ids.truncate(max_len);
        ids.resize(max_len, pad_id);
        // Tokenizing is CPU work; building the tensor is not.
        let _turn = self.busy();
        let input = Tensor::new(vec![ids], &self.device).map_err(|e| EmbedError::Text(e.to_string()))?;
        let features = self
            .net
            .get_text_features(&input)
            .map_err(|e| EmbedError::Text(e.to_string()))?;
        let vec = features
            .flatten_all()
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| EmbedError::Text(e.to_string()))?;
        Ok(l2_normalize(vec))
    }
}

/// Normalize to unit length; dot products become cosine similarities.
pub fn l2_normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

/// Similarity of two normalized embeddings.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crash this guards, in miniature.
    ///
    /// candle's Metal device keeps a residency set it mutates on every tensor
    /// allocation, and Metal does not guard it: two threads embedding at once
    /// corrupted it and the process died in libmalloc. A real regression test
    /// would need a loaded model and a GPU, which no test has — so what is
    /// pinned here is the property that made it possible, that `busy` admits
    /// exactly one caller at a time.
    #[test]
    fn inference_admits_one_caller_at_a_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        // The guard, standing in for the Embedder that owns it.
        let gpu = Arc::new(Mutex::new(()));
        let inside = Arc::new(AtomicUsize::new(0));
        let ever_overlapped = Arc::new(AtomicUsize::new(0));

        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (gpu, inside, seen) =
                    (Arc::clone(&gpu), Arc::clone(&inside), Arc::clone(&ever_overlapped));
                std::thread::spawn(move || {
                    for _ in 0..200 {
                        let _turn = gpu.lock().unwrap_or_else(|e| e.into_inner());
                        let n = inside.fetch_add(1, Ordering::SeqCst) + 1;
                        seen.fetch_max(n, Ordering::SeqCst);
                        std::hint::spin_loop();
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(
            ever_overlapped.load(Ordering::SeqCst),
            1,
            "two forward passes were in flight together"
        );
    }

    #[test]
    fn l2_normalize_gives_unit_length() {
        let v = l2_normalize(vec![3.0, 4.0]);
        assert!((dot(&v, &v) - 1.0).abs() < 1e-6);
        assert!((v[0] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn l2_normalize_survives_zero_vector() {
        assert_eq!(l2_normalize(vec![0.0, 0.0]), vec![0.0, 0.0]);
    }

    #[test]
    fn catalog_ids_are_unique_and_resolvable() {
        for spec in MODELS {
            assert!(std::ptr::eq(model_spec(spec.id).unwrap(), spec));
        }
        assert!(model_spec("nope").is_none());
    }
}
