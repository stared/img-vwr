//! Faces: who is in the photographs.
//!
//! Three stages, each cheap to redo because the one before it is cached:
//! detection (the platform's Vision framework, run once per photo and kept
//! as a sidecar next to the thumbnail cache), face crops (small JPEGs that
//! double as the People panel's chips), and clustering (embedding vectors
//! of the crops, grouped greedily — recomputed freely, since vectors come
//! from the embedding service's own cache).
//!
//! Identity is also propagated to photographs where no face is visible: a
//! frame nearly identical to one where a person IS visible (they turned
//! away between shots) shows the same person. That reuses the whole-photo
//! vectors the Similarity panel already indexes, and only ever adds
//! near-certain matches.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::services::embeddings::EmbeddingService;

/// One detected face in a photograph. Coordinates are normalized to the
/// displayed (EXIF-oriented) image, origin top-left.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// The face crop file — the People panel's chip, and what gets embedded.
    pub crop: String,
}

/// A person the clustering found: their face chips and their photographs.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonCluster {
    pub id: String,
    /// The crop that stands for this person in the panel.
    pub cover: String,
    /// A few more member crops — enough to judge at a glance whether the
    /// cluster really is one person.
    pub chips: Vec<String>,
    /// Photographs where a face of this person was detected.
    pub photos: Vec<String>,
    /// Photographs with no visible face, but near-identical to a member —
    /// the person turned away between two shots of the same moment.
    pub implied: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Sidecar {
    faces: Vec<Face>,
}

/// Longest edge of the oriented bitmap faces are detected on. Enough for a
/// face across a dance floor; small enough to decode hundreds of photos.
const DETECT_EDGE: u32 = 1600;

/// Margin added around a detected face box before cropping, as a share of
/// the box — chin, hair and some context make both better chips and better
/// embeddings than a tight face rectangle.
const CROP_MARGIN: f32 = 0.35;

const CROP_EDGE: u32 = 256;

/// Faces smaller than this share of the image's longest edge are ignored:
/// below it a face is a handful of pixels that embeds as noise and clusters
/// with nothing.
const MIN_FACE_SHARE: f32 = 0.03;

pub struct FaceService {
    /// photo path → its detected faces, for everything seen this session.
    faces: Mutex<HashMap<String, Arc<Vec<Face>>>>,
    /// One detection pass at a time, like the embedding indexer.
    indexing: AtomicBool,
    /// Sidecars: {thumb_key}.json under the cache root.
    sidecars_dir: PathBuf,
    /// Face crops: {thumb_key}-{i}.jpg under the cache root.
    crops_dir: PathBuf,
}

struct IndexingPass<'a>(&'a AtomicBool);

impl Drop for IndexingPass<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl FaceService {
    pub fn new(cache_root: PathBuf) -> std::io::Result<Self> {
        let sidecars_dir = cache_root.join("faces");
        let crops_dir = cache_root.join("face-crops");
        std::fs::create_dir_all(&sidecars_dir)?;
        std::fs::create_dir_all(&crops_dir)?;
        Ok(Self {
            faces: Mutex::new(HashMap::new()),
            indexing: AtomicBool::new(false),
            sidecars_dir,
            crops_dir,
        })
    }

    /// Detect faces in every path not already known (memory → sidecar →
    /// detect), reporting progress through `on_progress`. Runs on the
    /// calling thread — the command wraps it in a background task.
    pub fn index(&self, paths: &[String], mut on_progress: impl FnMut(u32, u32)) {
        if self.indexing.swap(true, Ordering::SeqCst) {
            return;
        }
        let _pass = IndexingPass(&self.indexing);
        let total = paths.len() as u32;
        for (i, path) in paths.iter().enumerate() {
            if let Err(e) = self.faces_of(path) {
                eprintln!("face detection failed for {path}: {e}");
                self.faces
                    .lock()
                    .unwrap()
                    .insert(path.clone(), Arc::new(Vec::new()));
            }
            let done = i as u32 + 1;
            if done.is_multiple_of(4) || done == total {
                on_progress(done, total);
            }
        }
    }

    /// Already-known faces of one photo: session memory → sidecar. Never
    /// detects — clustering reads whole collections through this, and a
    /// photo nobody indexed is simply not clustered yet.
    fn cached_faces_of(&self, path: &str) -> Option<Arc<Vec<Face>>> {
        if let Some(known) = self.faces.lock().unwrap().get(path) {
            return Some(Arc::clone(known));
        }
        let key = cache_key_of(path).ok()?;
        let sidecar = self.sidecars_dir.join(format!("{key}.json"));
        let stored = serde_json::from_slice::<Sidecar>(&std::fs::read(&sidecar).ok()?).ok()?;
        let faces = Arc::new(stored.faces);
        self.faces
            .lock()
            .unwrap()
            .insert(path.to_string(), Arc::clone(&faces));
        Some(faces)
    }

    /// The faces of one photo: session memory → sidecar → detection.
    fn faces_of(&self, path: &str) -> Result<Arc<Vec<Face>>, String> {
        if let Some(known) = self.cached_faces_of(path) {
            return Ok(known);
        }
        let key = cache_key_of(path)?;
        let sidecar = self.sidecars_dir.join(format!("{key}.json"));
        let detected = self.detect_and_crop(path, &key)?;
        let json = serde_json::to_vec(&Sidecar {
            faces: detected.clone(),
        })
        .map_err(|e| e.to_string())?;
        let tmp = sidecar.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &sidecar).map_err(|e| e.to_string())?;
        let faces = Arc::new(detected);
        self.faces
            .lock()
            .unwrap()
            .insert(path.to_string(), Arc::clone(&faces));
        Ok(faces)
    }

    /// Decode, orient, detect, crop, save. The oriented bitmap serves both
    /// the detector and the crops, so their coordinates always agree.
    fn detect_and_crop(&self, path: &str, key: &str) -> Result<Vec<Face>, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let decoded = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        let orientation = imgvwr_core::read_meta(Path::new(path))
            .ok()
            .and_then(|m| m.exif.map(|e| e.orientation))
            .unwrap_or(1);
        let oriented = apply_orientation(decoded, orientation);
        let scaled = oriented.resize(DETECT_EDGE, DETECT_EDGE, image::imageops::FilterType::Triangle);

        let boxes = platform::detect_faces(&scaled)?;

        let (w, h) = (scaled.width() as f32, scaled.height() as f32);
        let mut faces = Vec::new();
        for (i, b) in boxes.iter().enumerate() {
            if b.width.max(b.height * (h / w.max(1.0))) < MIN_FACE_SHARE {
                continue;
            }
            let margin_x = b.width * CROP_MARGIN;
            let margin_y = b.height * CROP_MARGIN;
            let x0 = ((b.x - margin_x) * w).max(0.0) as u32;
            let y0 = ((b.y - margin_y) * h).max(0.0) as u32;
            let x1 = (((b.x + b.width + margin_x) * w) as u32).min(scaled.width());
            let y1 = (((b.y + b.height + margin_y) * h) as u32).min(scaled.height());
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            let crop = scaled.crop_imm(x0, y0, x1 - x0, y1 - y0).resize(
                CROP_EDGE,
                CROP_EDGE,
                image::imageops::FilterType::Triangle,
            );
            let crop_file = self.crops_dir.join(format!("{key}-{i}.jpg"));
            crop.to_rgb8()
                .save_with_format(&crop_file, image::ImageFormat::Jpeg)
                .map_err(|e| e.to_string())?;
            faces.push(Face {
                x: b.x,
                y: b.y,
                width: b.width,
                height: b.height,
                crop: crop_file.display().to_string(),
            });
        }
        Ok(faces)
    }

    /// Group every known face of `paths` into people.
    ///
    /// Greedy centroid clustering over the crops' embedding vectors: a face
    /// joins the best-matching cluster above `threshold`, else starts its
    /// own. Order-dependent and unapologetic about it — with cached vectors
    /// the whole thing reruns in milliseconds, so tuning the threshold is a
    /// slider, not a batch job.
    pub fn people(
        &self,
        embeddings: &EmbeddingService,
        paths: &[String],
        threshold: f32,
        propagate: f32,
    ) -> Result<Vec<PersonCluster>, String> {
        struct Cluster {
            centroid: Vec<f32>,
            members: u32,
            faces: Vec<(String, String)>, // (photo, crop)
            best: (f32, String),          // closest crop to centroid = cover
        }
        let mut clusters: Vec<Cluster> = Vec::new();
        let mut faceless: Vec<String> = Vec::new();

        for path in paths {
            let Some(faces) = self.cached_faces_of(path) else {
                continue; // not indexed: neither clustered nor faceless
            };
            if faces.is_empty() {
                faceless.push(path.clone());
                continue;
            }
            for face in faces.iter() {
                let Ok(vector) = embeddings.vector_for_path(&face.crop) else {
                    continue;
                };
                let mut best: Option<(usize, f32)> = None;
                for (ci, c) in clusters.iter().enumerate() {
                    let sim = imgvwr_embed::dot(&c.centroid, &vector) / norm(&c.centroid);
                    if sim >= threshold && best.is_none_or(|(_, s)| sim > s) {
                        best = Some((ci, sim));
                    }
                }
                match best {
                    Some((ci, sim)) => {
                        let c = &mut clusters[ci];
                        for (acc, v) in c.centroid.iter_mut().zip(vector.iter()) {
                            *acc += v;
                        }
                        c.members += 1;
                        c.faces.push((path.clone(), face.crop.clone()));
                        if sim > c.best.0 {
                            c.best = (sim, face.crop.clone());
                        }
                    }
                    None => clusters.push(Cluster {
                        centroid: vector.to_vec(),
                        members: 1,
                        faces: vec![(path.clone(), face.crop.clone())],
                        best: (1.0, face.crop.clone()),
                    }),
                }
            }
        }

        clusters.sort_by_key(|c| std::cmp::Reverse(c.faces.len()));
        let mut out = Vec::new();
        for (i, c) in clusters.iter().enumerate() {
            let mut photos: Vec<String> = Vec::new();
            for (photo, _) in &c.faces {
                if !photos.contains(photo) {
                    photos.push(photo.clone());
                }
            }
            // The turned-away shots: a faceless photo near-identical to a
            // member belongs to the same moment, so the same person is in it.
            let mut implied = Vec::new();
            'candidates: for candidate in &faceless {
                let Some(cv) = embeddings.known_vector_for_path(candidate) else {
                    continue;
                };
                for photo in &photos {
                    if let Some(pv) = embeddings.known_vector_for_path(photo) {
                        if imgvwr_embed::dot(&cv, &pv) >= propagate {
                            implied.push(candidate.clone());
                            continue 'candidates;
                        }
                    }
                }
            }
            // Spread the sample chips across the cluster rather than taking
            // the first few — the mistakes cluster at the tail.
            let step = (c.faces.len() / 8).max(1);
            let chips: Vec<String> = c
                .faces
                .iter()
                .step_by(step)
                .take(8)
                .map(|(_, crop)| crop.clone())
                .collect();
            out.push(PersonCluster {
                // Bare number: the filter chip already says "person:".
                id: format!("{}", i + 1),
                cover: c.best.1.clone(),
                chips,
                photos,
                implied,
            });
        }
        Ok(out)
    }
}

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6)
}

/// The same identity key the thumbnail and vector caches use.
fn cache_key_of(path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(imgvwr_core::thumb_cache_key(
        path,
        mtime_ms,
        meta.len(),
        imgvwr_core::THUMB_MAX_EDGE,
    ))
}

/// EXIF orientation 1–8 → the upright bitmap.
fn apply_orientation(img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// A face box normalized to the oriented bitmap, origin top-left.
pub struct FaceBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::AnyThread as _;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{VNDetectFaceRectanglesRequest, VNImageRequestHandler, VNRequest};

    use super::FaceBox;

    /// Vision face rectangles on an already-oriented bitmap.
    ///
    /// The bitmap goes in as encoded JPEG bytes: Vision decodes them itself,
    /// and feeding it the oriented pixels sidesteps the whole
    /// orientation-mapping question — boxes come back in the same geometry
    /// the crops are cut from.
    pub fn detect_faces(img: &image::DynamicImage) -> Result<Vec<FaceBox>, String> {
        let mut jpeg = Vec::new();
        img.to_rgb8()
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .map_err(|e| e.to_string())?;

        // SAFETY: plain Objective-C message sends on objects we own; the
        // request handler runs synchronously on this thread.
        unsafe {
            let data = NSData::with_bytes(&jpeg);
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                &NSDictionary::new(),
            );
            let request = VNDetectFaceRectanglesRequest::new();
            // Up the class hierarchy: …FaceRectanglesRequest → VNImageBasedRequest → VNRequest.
            let as_request: Retained<VNRequest> =
                Retained::into_super(Retained::into_super(request.clone()));
            let requests = NSArray::from_retained_slice(&[as_request]);
            handler
                .performRequests_error(&requests)
                .map_err(|e| e.to_string())?;
            let Some(results) = request.results() else {
                return Ok(Vec::new());
            };
            Ok(results
                .iter()
                .map(|obs| {
                    let b = obs.boundingBox();
                    FaceBox {
                        x: b.origin.x as f32,
                        // Vision's origin is bottom-left; ours is top-left.
                        y: 1.0 - (b.origin.y + b.size.height) as f32,
                        width: b.size.width as f32,
                        height: b.size.height as f32,
                    }
                })
                .collect())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::FaceBox;

    pub fn detect_faces(_img: &image::DynamicImage) -> Result<Vec<FaceBox>, String> {
        Err("face detection is not implemented for this platform yet".to_string())
    }
}
