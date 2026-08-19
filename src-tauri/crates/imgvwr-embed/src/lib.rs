//! Dual-encoder image/text embedding; similarity is the dot product of L2-normalized vectors.
//! Models download on demand from Hugging Face into the app cache — never installed globally.

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

pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub quality: &'static str,
    /// Throughput measured with this crate's `bench` example on an Apple Silicon GPU (Metal, release).
    pub speed: &'static str,
    pub download_mb: u32,
    pub dim: u32,
    hf_repo: &'static str,
    image_size: usize,
}

/// SigLIP 2 only: MobileCLIP S2 was dropped — candle's Metal conv2d makes its FastViT tower take ~78 s/image vs 14 ms for a ViT.
/// The 256 px input matches the thumbnail cache exactly, so indexing never re-decodes originals.
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
    /// Serialises every forward pass: candle's Metal device mutates an unguarded residency set, and two threads building tensors on one device die in libmalloc ("pointer being freed was not allocated").
    /// A plain lock, not try-lock — a dropped pass is a wrong answer; poisoning is ignored, since a panic in one pass says nothing about the next.
    fn busy(&self) -> std::sync::MutexGuard<'_, ()> {
        self.gpu.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Downloads (or reuses) the weights, then loads. Slow — run on a background thread.
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

    /// Returns an L2-normalized vector, so similarity is a plain dot product.
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
        // The device is touched from here on; the pass takes its turn.
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

    /// L2-normalized, in the same space as images.
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

pub fn l2_normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Metal-residency crash cannot be regression-tested (needs a loaded model and a GPU);
    /// what is pinned is the property that made it possible — `busy` admits exactly one caller.
    #[test]
    fn inference_admits_one_caller_at_a_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

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

/// ArcFace-family identity vectors ("same face") — a generic image embedding groups by lighting and hair instead.
/// insightface buffalo_l (ResNet-50, WebFace600K) via onnxruntime: on unaligned crops the small MobileFaceNet's same/different-person similarities overlap.
pub struct FaceEmbedder {
    /// onnxruntime sessions want &mut for `run`; the mutex serializes.
    session: Mutex<ort::session::Session>,
    input_name: String,
    output_name: String,
}

pub const FACE_MODEL_REPO: &str = "immich-app/buffalo_l";
pub const FACE_MODEL_FILE: &str = "recognition/model.onnx";
/// Tags cached identity vectors, so switching recognizers never reads another model's space.
pub const FACE_MODEL_ID: &str = "buffalo-l";
const FACE_EDGE: usize = 112;

impl FaceEmbedder {
    /// Blocking; downloads on first use.
    pub fn load(cache_dir: &std::path::Path) -> Result<Self, EmbedError> {
        let api = hf_hub::api::sync::ApiBuilder::new()
            .with_cache_dir(cache_dir.to_path_buf())
            .build()
            .map_err(|e| EmbedError::Download(e.to_string()))?;
        let model_file = api
            .model(FACE_MODEL_REPO.to_string())
            .get(FACE_MODEL_FILE)
            .map_err(|e| EmbedError::Download(e.to_string()))?;
        let session = ort::session::Session::builder()
            .map_err(|e| EmbedError::Model(e.to_string()))?
            .commit_from_file(&model_file)
            .map_err(|e| EmbedError::Model(e.to_string()))?;
        let input_name = session
            .inputs
            .first()
            .map(|i| i.name.clone())
            .ok_or_else(|| EmbedError::Model("face model has no input".into()))?;
        let output_name = session
            .outputs
            .first()
            .map(|o| o.name.clone())
            .ok_or_else(|| EmbedError::Model("face model has no output".into()))?;
        Ok(Self {
            session: Mutex::new(session),
            input_name,
            output_name,
        })
    }

    /// The L2-normalized identity vector of an aligned 112×112 face crop.
    pub fn embed_face_file(&self, path: &std::path::Path) -> Result<Vec<f32>, EmbedError> {
        let img = image::open(path)
            .map_err(|e| EmbedError::Image(e.to_string()))?
            .resize_exact(
                FACE_EDGE as u32,
                FACE_EDGE as u32,
                image::imageops::FilterType::Triangle,
            )
            .to_rgb8();
        // NCHW, RGB, (x − 127.5) / 127.5 — the ArcFace convention.
        let mut data = vec![0f32; 3 * FACE_EDGE * FACE_EDGE];
        for (x, y, pixel) in img.enumerate_pixels() {
            for c in 0..3 {
                data[c * FACE_EDGE * FACE_EDGE + y as usize * FACE_EDGE + x as usize] =
                    (f32::from(pixel[c]) - 127.5) / 127.5;
            }
        }
        let tensor = ort::value::Tensor::from_array(([1usize, 3, FACE_EDGE, FACE_EDGE], data))
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let mut session = self.session.lock().unwrap();
        let outputs = session
            .run(ort::inputs![self.input_name.as_str() => tensor])
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let (_, raw) = outputs[self.output_name.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let n = raw.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
        Ok(raw.iter().map(|v| v / n).collect())
    }
}
