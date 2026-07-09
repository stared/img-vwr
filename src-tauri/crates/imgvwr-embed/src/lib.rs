//! Image/text embedding for "similar to" search. A dual encoder maps images
//! and text phrases into one vector space; similarity is the dot product of
//! L2-normalized embeddings. Models are downloaded on demand from Hugging
//! Face into the app cache — never installed globally.

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::{mobileclip, siglip};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    MobileClip,
    Siglip,
}

/// One offered model: identity, where its weights live, and the picker notes.
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// One-line quality note for the picker.
    pub quality: &'static str,
    /// One-line speed note for the picker (relative; the panel shows
    /// measured throughput while indexing).
    pub speed: &'static str,
    pub download_mb: u32,
    pub dim: u32,
    hf_repo: &'static str,
    weights_file: &'static str,
    image_size: usize,
    family: Family,
}

/// The picks, fastest first. All are dual encoders whose 256 px input matches
/// the thumbnail cache exactly, so indexing never re-decodes originals.
pub static MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "mobileclip-s2",
        label: "MobileCLIP S2",
        quality: "good — on par with OpenAI's CLIP ViT-B/16 (Apple, 2024)",
        speed: "fastest, smallest download",
        download_mb: 400,
        dim: 512,
        hf_repo: "apple/MobileCLIP-S2-OpenCLIP",
        weights_file: "open_clip_model.safetensors",
        image_size: 256,
        family: Family::MobileClip,
    },
    ModelSpec {
        id: "siglip2-base",
        label: "SigLIP 2 Base",
        quality: "strong retrieval, multilingual queries (Google, 2025)",
        speed: "moderate — a few times slower than S2",
        download_mb: 1535,
        dim: 768,
        hf_repo: "google/siglip2-base-patch16-256",
        weights_file: "model.safetensors",
        image_size: 256,
        family: Family::Siglip,
    },
    ModelSpec {
        id: "siglip2-large",
        label: "SigLIP 2 Large",
        quality: "best of these picks — finest-grained matching",
        speed: "slowest — roughly 3× the base model",
        download_mb: 3560,
        dim: 1024,
        hf_repo: "google/siglip2-large-patch16-256",
        weights_file: "model.safetensors",
        image_size: 256,
        family: Family::Siglip,
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
    let mut files = vec![spec.weights_file, "tokenizer.json"];
    if spec.family == Family::Siglip {
        files.push("config.json");
    }
    files.iter().all(|f| repo.get(f).is_some())
}

enum Net {
    MobileClip(Box<mobileclip::MobileClipModel>),
    Siglip(Box<siglip::Model>),
}

pub struct Embedder {
    net: Net,
    tokenizer: Tokenizer,
    device: Device,
    image_size: usize,
    /// SigLIP pads text to a fixed length; (length, pad token id).
    text_pad: Option<(usize, u32)>,
    pub model_id: &'static str,
    pub dim: usize,
}

fn best_device() -> Device {
    #[cfg(target_os = "macos")]
    {
        if let Ok(device) = Device::new_metal(0) {
            return device;
        }
    }
    Device::Cpu
}

impl Embedder {
    /// Downloads (or reuses) the weights, then loads the model. Slow — run on
    /// a background thread. `cache_dir` is the app-owned model cache.
    pub fn load(spec: &'static ModelSpec, cache_dir: &std::path::Path) -> Result<Self, EmbedError> {
        let api = hf_hub::api::sync::ApiBuilder::new()
            .with_cache_dir(cache_dir.to_path_buf())
            .build()
            .map_err(|e| EmbedError::Download(e.to_string()))?;
        let repo = api.model(spec.hf_repo.to_string());
        let get = |file: &str| repo.get(file).map_err(|e| EmbedError::Download(e.to_string()));

        let weights = get(spec.weights_file)?;
        let tokenizer =
            Tokenizer::from_file(get("tokenizer.json")?).map_err(|e| EmbedError::Model(e.to_string()))?;

        let device = best_device();
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(std::slice::from_ref(&weights), DType::F32, &device)
                .map_err(|e| EmbedError::Model(e.to_string()))?
        };

        let (net, text_pad) = match spec.family {
            Family::MobileClip => {
                let config = mobileclip::MobileClipConfig::s2();
                let net = mobileclip::MobileClipModel::new(vb, &config)
                    .map_err(|e| EmbedError::Model(e.to_string()))?;
                (Net::MobileClip(Box::new(net)), None)
            }
            Family::Siglip => {
                let config: siglip::Config = serde_json::from_slice(
                    &std::fs::read(get("config.json")?).map_err(|e| EmbedError::Model(e.to_string()))?,
                )
                .map_err(|e| EmbedError::Model(e.to_string()))?;
                let pad = (
                    config.text_config.max_position_embeddings,
                    config.text_config.pad_token_id,
                );
                let net =
                    siglip::Model::new(&config, vb).map_err(|e| EmbedError::Model(e.to_string()))?;
                (Net::Siglip(Box::new(net)), Some(pad))
            }
        };

        Ok(Self {
            net,
            tokenizer,
            device,
            image_size: spec.image_size,
            text_pad,
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
        let tensor = Tensor::from_vec(img, (size, size, 3), &Device::Cpu)
            .and_then(|t| t.permute((2, 0, 1)))
            .and_then(|t| t.to_dtype(DType::F32))
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        // Each family's own pixel normalization.
        let tensor = match self.net {
            Net::MobileClip(_) => tensor.affine(1. / 255., 0.),
            Net::Siglip(_) => tensor.affine(2. / 255., -1.),
        }
        .map_err(|e| EmbedError::Image(e.to_string()))?;
        let batch = tensor
            .unsqueeze(0)
            .and_then(|t| t.to_device(&self.device))
            .map_err(|e| EmbedError::Image(e.to_string()))?;
        let features = match &self.net {
            Net::MobileClip(m) => m.get_image_features(&batch),
            Net::Siglip(m) => m.get_image_features(&batch),
        }
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
        if let Some((max_len, pad_id)) = self.text_pad {
            ids.truncate(max_len);
            ids.resize(max_len, pad_id);
        }
        let input = Tensor::new(vec![ids], &self.device).map_err(|e| EmbedError::Text(e.to_string()))?;
        let features = match &self.net {
            Net::MobileClip(m) => m.get_text_features(&input),
            Net::Siglip(m) => m.get_text_features(&input),
        }
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
