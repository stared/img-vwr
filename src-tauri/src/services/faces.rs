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

use rusqlite::Connection;
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
    /// The face crop file — the People panel's chip (loose, with context).
    pub crop: String,
    /// The aligned 112×112 crop the identity model reads. Chips are for
    /// people; this one is for the recognizer.
    pub id_crop: String,
    /// Whether the crop is landmark-aligned. Unaligned faces (no landmarks,
    /// or a true profile the template cannot fit) never cluster: a degraded
    /// embedding joins other degraded embeddings, not its own person.
    pub aligned: bool,
}

/// A person the clustering found: their face chips and their photographs.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonCluster {
    /// The filter value and map key. A named person's id IS their name —
    /// names are anchored to identity vectors, so they survive reclustering
    /// and follow the person into other folders; run ordinals do neither.
    pub id: String,
    /// The user's name for this person, if they gave one.
    pub name: Option<String>,
    /// The crop that stands for this person in the panel.
    pub cover: String,
    /// A few more member crops — enough to judge at a glance whether the
    /// cluster really is one person.
    pub chips: Vec<String>,
    /// Photographs where a face of this person was detected, any role.
    pub photos: Vec<String>,
    /// Photographs where they are the sole focus — the only sizable face.
    pub solo: Vec<String>,
    /// Photographs where they share the frame with a few comparable faces.
    pub few: Vec<String>,
    /// Photographs where they are small or behind others — background.
    pub background: Vec<String>,
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
    /// The identity model, loaded (and first downloaded) on first use.
    face_model: Mutex<Option<Arc<imgvwr_embed::FaceEmbedder>>>,
    /// id-crop path → identity vector, for everything embedded this session.
    face_vectors: Mutex<HashMap<String, Arc<Vec<f32>>>>,
    /// Identity vectors on disk: {id-crop stem}.vec (f32 LE).
    face_vectors_dir: PathBuf,
    /// Hugging Face cache, shared with the similarity models.
    models_dir: PathBuf,
    /// Named identities: user data, not a cache — names must survive every
    /// cache wipe. One row per exemplar vector, keyed by name.
    names: Mutex<Connection>,
    /// The clusters of the most recent `people()` run, so a rename can find
    /// the vectors behind the id the frontend is pointing at.
    last_clusters: Mutex<Vec<LastCluster>>,
}

struct LastCluster {
    id: String,
    name: Option<String>,
    vectors: Vec<Arc<Vec<f32>>>,
}

/// A saved name with the exemplar vectors that recognize its person.
struct Identity {
    name: String,
    exemplars: Vec<Vec<f32>>,
}

/// Exemplar vectors saved per name. Enough to cover a person across
/// lighting conditions without the matching cost growing with their photos.
const MAX_EXEMPLARS: usize = 24;

/// Exemplars contributed by one naming action — a spread sample of the
/// cluster being named.
const NAME_SAMPLE: usize = 8;

/// A spread sample of up to `take` vectors — the same "not just the head"
/// sampling the linkage merge uses, since mistakes cluster at the tail.
fn spread<T: Clone>(items: &[T], take: usize) -> Vec<T> {
    let step = (items.len() / take).max(1);
    items.iter().step_by(step).take(take).cloned().collect()
}

struct IndexingPass<'a>(&'a AtomicBool);

impl Drop for IndexingPass<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl FaceService {
    pub fn new(cache_root: PathBuf, names_db: &Path) -> Result<Self, String> {
        let sidecars_dir = cache_root.join("faces");
        let crops_dir = cache_root.join("face-crops");
        let face_vectors_dir = cache_root.join("face-vectors");
        let models_dir = cache_root.join("models");
        for dir in [&sidecars_dir, &crops_dir, &face_vectors_dir, &models_dir] {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let names = Connection::open(names_db).map_err(|e| e.to_string())?;
        names
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS person_exemplars (
                     name   TEXT NOT NULL,
                     vector BLOB NOT NULL
                 ) STRICT;",
            )
            .map_err(|e| e.to_string())?;
        Ok(Self {
            faces: Mutex::new(HashMap::new()),
            indexing: AtomicBool::new(false),
            sidecars_dir,
            crops_dir,
            face_model: Mutex::new(None),
            face_vectors: Mutex::new(HashMap::new()),
            face_vectors_dir,
            models_dir,
            names: Mutex::new(names),
            last_clusters: Mutex::new(Vec::new()),
        })
    }

    /// Every named identity with its exemplar vectors.
    fn identities(&self) -> Result<Vec<Identity>, String> {
        let conn = self.names.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name, vector FROM person_exemplars ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out: Vec<Identity> = Vec::new();
        for row in rows {
            let (name, blob) = row.map_err(|e| e.to_string())?;
            let vector: Vec<f32> = blob
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            match out.last_mut() {
                Some(id) if id.name == name => id.exemplars.push(vector),
                _ => out.push(Identity {
                    name,
                    exemplars: vec![vector],
                }),
            }
        }
        Ok(out)
    }

    /// Replace one identity's exemplars; an empty set deletes the identity.
    fn store_identity(&self, name: &str, exemplars: &[Vec<f32>]) -> Result<(), String> {
        let mut conn = self.names.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM person_exemplars WHERE name = ?", [name])
            .map_err(|e| e.to_string())?;
        for vector in exemplars {
            let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            tx.execute(
                "INSERT INTO person_exemplars (name, vector) VALUES (?, ?)",
                rusqlite::params![name, blob],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Every name ever given, for the rename input's suggestions.
    pub fn known_names(&self) -> Result<Vec<String>, String> {
        let conn = self.names.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT DISTINCT name FROM person_exemplars ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Name (or, with an empty name, un-name) a cluster of the most recent
    /// `people()` run.
    ///
    /// Naming saves a spread sample of the cluster's vectors as the name's
    /// exemplars — giving two fragments the same name therefore merges them
    /// on the next clustering, because both keep matching those exemplars.
    /// Renaming away first withdraws the exemplars this cluster accounts
    /// for, so a wrong merge is undone the same way it was made.
    pub fn rename(&self, cluster_id: &str, name: &str, merge: f32) -> Result<(), String> {
        let mut last = self.last_clusters.lock().unwrap();
        let cluster = last
            .iter_mut()
            .find(|c| c.id == cluster_id)
            .ok_or_else(|| format!("no current cluster {cluster_id}"))?;
        let name = name.trim();
        let new_name = (!name.is_empty()).then(|| name.to_string());
        if cluster.name == new_name {
            return Ok(());
        }
        let sample = spread(&cluster.vectors, NAME_SAMPLE);

        if let Some(old) = cluster.name.take() {
            if Some(&old) != new_name.as_ref() {
                // Withdraw this cluster's contribution: an exemplar leaves
                // when ANY member vouches for it — exemplars are copies of
                // member vectors, so their people are in this cluster. Max,
                // not average: a merged cluster is a mixed bag, and an
                // average against it dilutes every fragment's agreement.
                let members = cluster.vectors.clone();
                let kept: Vec<Vec<f32>> = self
                    .identities()?
                    .into_iter()
                    .find(|id| id.name == old)
                    .map(|id| id.exemplars)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|e| {
                        members
                            .iter()
                            .map(|v| imgvwr_embed::dot(e, v))
                            .fold(f32::MIN, f32::max)
                            < merge
                    })
                    .collect();
                self.store_identity(&old, &kept)?;
            }
        }
        if let Some(new) = &new_name {
            let mut exemplars = self
                .identities()?
                .into_iter()
                .find(|id| &id.name == new)
                .map(|id| id.exemplars)
                .unwrap_or_default();
            exemplars.extend(sample.iter().map(|v| v.as_ref().clone()));
            let exemplars = spread(&exemplars, MAX_EXEMPLARS);
            self.store_identity(new, &exemplars)?;
        }
        cluster.name = new_name;
        Ok(())
    }

    /// The identity model, loading it on first call (a ~13 MB download the
    /// first time ever).
    fn face_model(&self) -> Result<Arc<imgvwr_embed::FaceEmbedder>, String> {
        let mut slot = self.face_model.lock().unwrap();
        if let Some(model) = slot.as_ref() {
            return Ok(Arc::clone(model));
        }
        let model = Arc::new(
            imgvwr_embed::FaceEmbedder::load(&self.models_dir).map_err(|e| e.to_string())?,
        );
        *slot = Some(Arc::clone(&model));
        Ok(model)
    }

    /// The identity vector of one face: session memory → disk → compute.
    fn face_vector(&self, id_crop: &str) -> Result<Arc<Vec<f32>>, String> {
        if let Some(v) = self.face_vectors.lock().unwrap().get(id_crop) {
            return Ok(Arc::clone(v));
        }
        let stem = Path::new(id_crop)
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("odd crop path: {id_crop}"))?;
        let vec_file = self
            .face_vectors_dir
            .join(format!("{stem}-{}.vec", imgvwr_embed::FACE_MODEL_ID));
        let vector = match read_face_vector(&vec_file) {
            Some(v) => v,
            None => {
                let v = self
                    .face_model()?
                    .embed_face_file(Path::new(id_crop))
                    .map_err(|e| e.to_string())?;
                if let Err(e) = write_face_vector(&vec_file, &v) {
                    eprintln!("face vector cache write failed for {stem}: {e}");
                }
                v
            }
        };
        let vector = Arc::new(vector);
        self.face_vectors
            .lock()
            .unwrap()
            .insert(id_crop.to_string(), Arc::clone(&vector));
        Ok(vector)
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

        let detections = platform::detect_faces(&scaled)?;

        let (w, h) = (scaled.width() as f32, scaled.height() as f32);
        let mut faces = Vec::new();
        for (i, d) in detections.iter().enumerate() {
            let b = &d.rect;
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
            // The recognizer's crop: landmark-ALIGNED to the ArcFace
            // template when the landmarks allow it. Alignment is what makes
            // the embedding measure the face rather than the hat, the tilt
            // of a lying-down head, or the colour of the stage light around
            // it. Faces the template cannot fit (true profiles) keep an
            // unaligned crop and are marked so — shown, counted, never
            // clustered.
            let id_file = self.crops_dir.join(format!("{key}-{i}-al.jpg"));
            let landmarks_px = d.landmarks.map(|pts| pts.map(|[x, y]| [x * w, y * h]));
            let aligned = match landmarks_px.and_then(|pts| align_transform(&pts)) {
                Some(transform) => {
                    warp_aligned(&scaled, &transform)
                        .save_with_format(&id_file, image::ImageFormat::Jpeg)
                        .map_err(|e| e.to_string())?;
                    true
                }
                None => {
                    let id_margin_x = b.width * 0.12;
                    let id_margin_y = b.height * 0.12;
                    let ix0 = ((b.x - id_margin_x) * w).max(0.0) as u32;
                    let iy0 = ((b.y - id_margin_y) * h).max(0.0) as u32;
                    let ix1 = (((b.x + b.width + id_margin_x) * w) as u32).min(scaled.width());
                    let iy1 = (((b.y + b.height + id_margin_y) * h) as u32).min(scaled.height());
                    scaled
                        .crop_imm(ix0, iy0, (ix1 - ix0).max(1), (iy1 - iy0).max(1))
                        .resize_exact(112, 112, image::imageops::FilterType::Triangle)
                        .to_rgb8()
                        .save_with_format(&id_file, image::ImageFormat::Jpeg)
                        .map_err(|e| e.to_string())?;
                    false
                }
            };
            faces.push(Face {
                x: b.x,
                y: b.y,
                width: b.width,
                height: b.height,
                crop: crop_file.display().to_string(),
                id_crop: id_file.display().to_string(),
                aligned,
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
        merge: f32,
        propagate: f32,
    ) -> Result<Vec<PersonCluster>, String> {
        struct Cluster {
            centroid: Vec<f32>,
            members: u32,
            faces: Vec<(String, String, Role)>, // (photo, crop, role)
            /// The member vectors, kept for average-linkage merging.
            vectors: Vec<Arc<Vec<f32>>>,
            best: (f32, String), // closest crop to centroid = cover
            /// The stored identity this cluster matched, if any.
            name: Option<String>,
        }

        /// Average pairwise similarity between two clusters, sampled.
        ///
        /// NOT centroid-vs-centroid: every face shares a large "generic
        /// face" component, so as clusters grow their centroids converge on
        /// it and different people begin to agree. Averages of individual
        /// pair similarities keep the identity signal undiluted.
        fn linkage(a: &Cluster, b: &Cluster) -> f32 {
            let sample = |c: &Cluster| -> Vec<Arc<Vec<f32>>> {
                let step = (c.vectors.len() / 12).max(1);
                c.vectors.iter().step_by(step).take(12).cloned().collect()
            };
            let (sa, sb) = (sample(a), sample(b));
            let mut sum = 0f32;
            for va in &sa {
                for vb in &sb {
                    sum += imgvwr_embed::dot(va, vb);
                }
            }
            sum / (sa.len() * sb.len()) as f32
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
                if !face.aligned {
                    continue;
                }
                let Ok(vector) = self.face_vector(&face.id_crop) else {
                    continue;
                };
                let role = role_of(face, &faces);
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
                        c.faces.push((path.clone(), face.crop.clone(), role));
                        c.vectors.push(Arc::clone(&vector));
                        if sim > c.best.0 {
                            c.best = (sim, face.crop.clone());
                        }
                    }
                    None => clusters.push(Cluster {
                        centroid: vector.to_vec(),
                        members: 1,
                        faces: vec![(path.clone(), face.crop.clone(), role)],
                        vectors: vec![Arc::clone(&vector)],
                        best: (1.0, face.crop.clone()),
                        name: None,
                    }),
                }
            }
        }

        // The greedy pass fragments: the same person under stage light and
        // in daylight starts two clusters, because single faces are noisy.
        // Fragments of one person keep agreeing pair-by-pair, so merge on
        // the average pairwise similarity — see `linkage` for why not
        // centroids.
        loop {
            let mut merged_any = false;
            let mut i = 0;
            while i < clusters.len() {
                let mut j = i + 1;
                while j < clusters.len() {
                    if linkage(&clusters[i], &clusters[j]) >= merge {
                        let absorbed = clusters.remove(j);
                        let host = &mut clusters[i];
                        for (acc, v) in host.centroid.iter_mut().zip(absorbed.centroid.iter()) {
                            *acc += v;
                        }
                        host.members += absorbed.members;
                        host.faces.extend(absorbed.faces);
                        host.vectors.extend(absorbed.vectors);
                        if absorbed.best.0 > host.best.0 {
                            host.best = absorbed.best;
                        }
                        merged_any = true;
                    } else {
                        j += 1;
                    }
                }
                i += 1;
            }
            if !merged_any {
                break;
            }
        }

        // Named identities: exemplar vectors saved when the user named a
        // cluster. Each cluster takes the name it agrees with best, by the
        // same average-linkage measure the merge uses — so a name given
        // once keeps finding its person across reclusters and folders.
        let identities = self.identities()?;
        for c in clusters.iter_mut() {
            let sample = spread(&c.vectors, 12);
            // Best-scoring name wins when identities compete for a cluster;
            // one name may claim several clusters — those merge below.
            let mut best: Option<(f32, &String)> = None;
            for identity in &identities {
                // The best-agreeing exemplar decides, NOT the average over
                // all of them: an identity's exemplars deliberately span
                // fragments the user merged by hand — fragments whose
                // cross-similarity sits BELOW the merge bar (that is why
                // they needed the hand) — so averaging across the set
                // dilutes every fragment's own agreement under the bar.
                let score = identity
                    .exemplars
                    .iter()
                    .map(|e| {
                        sample.iter().map(|v| imgvwr_embed::dot(e, v)).sum::<f32>()
                            / sample.len() as f32
                    })
                    .fold(f32::MIN, f32::max);
                if score >= merge && best.is_none_or(|(s, _)| score > s) {
                    best = Some((score, &identity.name));
                }
            }
            c.name = best.map(|(_, name)| name.clone());
        }

        // Two clusters wearing one name are one person the user has
        // vouched for — union them regardless of what the vectors say.
        let mut i = 0;
        while i < clusters.len() {
            let mut j = i + 1;
            while j < clusters.len() {
                if clusters[i].name.is_some() && clusters[i].name == clusters[j].name {
                    let absorbed = clusters.remove(j);
                    let host = &mut clusters[i];
                    for (acc, v) in host.centroid.iter_mut().zip(absorbed.centroid.iter()) {
                        *acc += v;
                    }
                    host.members += absorbed.members;
                    host.faces.extend(absorbed.faces);
                    host.vectors.extend(absorbed.vectors);
                    if absorbed.best.0 > host.best.0 {
                        host.best = absorbed.best;
                    }
                } else {
                    j += 1;
                }
            }
            i += 1;
        }

        // Subjects first: a person mostly in backgrounds sorts after one the
        // camera was actually pointed at, whatever the raw face count says.
        clusters.sort_by_key(|c| {
            std::cmp::Reverse(
                c.faces
                    .iter()
                    .map(|(_, _, role)| match role {
                        Role::Solo | Role::Few => 4u32,
                        Role::Background => 1u32,
                    })
                    .sum::<u32>(),
            )
        });
        let mut out = Vec::new();
        for (i, c) in clusters.iter().enumerate() {
            // Per photo, the BEST role this person has in it.
            let mut photos: Vec<String> = Vec::new();
            let mut role_by_photo: HashMap<String, Role> = HashMap::new();
            for (photo, _, role) in &c.faces {
                if !photos.contains(photo) {
                    photos.push(photo.clone());
                }
                let slot = role_by_photo.entry(photo.clone()).or_insert(*role);
                if (*role as u8) < (*slot as u8) {
                    *slot = *role;
                }
            }
            let of_role = |wanted: Role| -> Vec<String> {
                photos
                    .iter()
                    .filter(|p| role_by_photo.get(*p) == Some(&wanted))
                    .cloned()
                    .collect()
            };
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
                .map(|(_, crop, _)| crop.clone())
                .collect();
            out.push(PersonCluster {
                // The name where there is one; otherwise a bare number (the
                // filter chip already says "person:").
                id: c.name.clone().unwrap_or_else(|| format!("{}", i + 1)),
                name: c.name.clone(),
                cover: c.best.1.clone(),
                chips,
                solo: of_role(Role::Solo),
                few: of_role(Role::Few),
                background: of_role(Role::Background),
                photos,
                implied,
            });
        }
        *self.last_clusters.lock().unwrap() = out
            .iter()
            .zip(clusters.iter())
            .map(|(person, c)| LastCluster {
                id: person.id.clone(),
                name: c.name.clone(),
                vectors: c.vectors.clone(),
            })
            .collect();
        Ok(out)
    }
}

/// How present a face is in its photograph. Ordered: a smaller
/// discriminant is a stronger presence, so `min` picks the best role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Solo = 0,
    Few = 1,
    Background = 2,
}

/// A face too small relative to the frame reads as background whoever
/// else is there.
const BACKGROUND_HEIGHT: f32 = 0.10;

/// Classify a face against every face in its photograph.
///
/// Background: small in the frame, or half the size of the biggest face —
/// someone behind the actual subject. Among the remaining comparable
/// faces: alone means the sole focus, company means one of a few.
pub fn role_of(face: &Face, all: &[Face]) -> Role {
    let max_h = all.iter().map(|f| f.height).fold(0.0f32, f32::max);
    if face.height < BACKGROUND_HEIGHT || face.height < 0.5 * max_h {
        return Role::Background;
    }
    let comparable = all.iter().filter(|f| f.height >= 0.5 * max_h).count();
    if comparable <= 1 {
        Role::Solo
    } else {
        Role::Few
    }
}

fn read_face_vector(file: &Path) -> Option<Vec<f32>> {
    let bytes = std::fs::read(file).ok()?;
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

fn write_face_vector(file: &Path, v: &[f32]) -> std::io::Result<()> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for x in v {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    let tmp = file.with_extension("vec.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, file)
}

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6)
}

/// The sidecar's identity salt. Historically the thumbnail edge; pinned so
/// a display-thumbnail resolution bump cannot orphan every detected face —
/// and with them the names the user has hung on people.
const SIDECAR_KEY_EDGE: u32 = 256;

/// The face sidecar's identity key: the file's path, mtime and size, plus
/// the pinned salt above. Detection decodes the original file, so no
/// thumbnail size belongs in this identity.
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
        SIDECAR_KEY_EDGE,
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

/// One detection: the box, and — when Vision found them — the five
/// alignment landmarks (left eye, right eye, nose, mouth corners),
/// normalized to the image, origin top-left.
pub struct DetectedFace {
    pub rect: FaceBox,
    pub landmarks: Option<[[f32; 2]; 5]>,
}

/// Where the five landmarks sit in an aligned 112×112 crop — insightface's
/// canonical ArcFace template. Alignment means solving for the similarity
/// transform that carries the detected points here.
const FACE_TEMPLATE: [[f32; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

/// A 2D similarity transform y = A·x + t with A = [[a, -b], [b, a]].
struct Similarity2D {
    a: f32,
    b: f32,
    tx: f32,
    ty: f32,
}

/// Alignment residual (mean landmark error, template px) above which the
/// fit is fiction — a true profile squeezed onto a frontal template.
const MAX_ALIGN_RESIDUAL: f32 = 8.0;

/// Least-squares similarity transform from detected landmarks (image px)
/// onto the template, or None when the fit is too poor to trust.
fn align_transform(points: &[[f32; 2]; 5]) -> Option<Similarity2D> {
    let mean = |pts: &[[f32; 2]; 5]| {
        let (mut mx, mut my) = (0f32, 0f32);
        for p in pts {
            mx += p[0];
            my += p[1];
        }
        [mx / 5.0, my / 5.0]
    };
    let (ms, md) = (mean(points), mean(&FACE_TEMPLATE));
    let (mut sxx, mut num_a, mut num_b) = (0f32, 0f32, 0f32);
    for (s, d) in points.iter().zip(FACE_TEMPLATE.iter()) {
        let (xs, ys) = (s[0] - ms[0], s[1] - ms[1]);
        let (xd, yd) = (d[0] - md[0], d[1] - md[1]);
        sxx += xs * xs + ys * ys;
        num_a += xs * xd + ys * yd;
        num_b += xs * yd - ys * xd;
    }
    if sxx < 1e-6 {
        return None;
    }
    let (a, b) = (num_a / sxx, num_b / sxx);
    let tx = md[0] - (a * ms[0] - b * ms[1]);
    let ty = md[1] - (b * ms[0] + a * ms[1]);
    let t = Similarity2D { a, b, tx, ty };
    // Judge the fit where it will be used: in template pixels.
    let mut residual = 0f32;
    for (s, d) in points.iter().zip(FACE_TEMPLATE.iter()) {
        let px = t.a * s[0] - t.b * s[1] + t.tx;
        let py = t.b * s[0] + t.a * s[1] + t.ty;
        residual += ((px - d[0]).powi(2) + (py - d[1]).powi(2)).sqrt();
    }
    if residual / 5.0 > MAX_ALIGN_RESIDUAL {
        return None;
    }
    Some(t)
}

/// The aligned 112×112 crop: each output pixel looked up through the
/// INVERSE transform, bilinearly. Plain nested loops — 12k pixels.
fn warp_aligned(img: &image::DynamicImage, t: &Similarity2D) -> image::RgbImage {
    let src = img.to_rgb8();
    let (w, h) = (src.width() as i64, src.height() as i64);
    // Inverse of y = A·x + t for a similarity: x = Aᵀ·(y − t) / |A|².
    let det = t.a * t.a + t.b * t.b;
    let (ia, ib) = (t.a / det, -t.b / det);
    let mut out = image::RgbImage::new(112, 112);
    for v in 0..112u32 {
        for u in 0..112u32 {
            let (dx, dy) = (u as f32 - t.tx, v as f32 - t.ty);
            let sx = ia * dx - ib * dy;
            let sy = ib * dx + ia * dy;
            let (x0, y0) = (sx.floor() as i64, sy.floor() as i64);
            let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
            let sample = |x: i64, y: i64| -> [f32; 3] {
                let (cx, cy) = (x.clamp(0, w - 1) as u32, y.clamp(0, h - 1) as u32);
                let p = src.get_pixel(cx, cy);
                [f32::from(p[0]), f32::from(p[1]), f32::from(p[2])]
            };
            let (p00, p10, p01, p11) =
                (sample(x0, y0), sample(x0 + 1, y0), sample(x0, y0 + 1), sample(x0 + 1, y0 + 1));
            let mut px = [0u8; 3];
            for c in 0..3 {
                let top = p00[c] * (1.0 - fx) + p10[c] * fx;
                let bottom = p01[c] * (1.0 - fx) + p11[c] * fx;
                px[c] = (top * (1.0 - fy) + bottom * fy).round().clamp(0.0, 255.0) as u8;
            }
            out.put_pixel(u, v, image::Rgb(px));
        }
    }
    out
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::AnyThread as _;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNDetectFaceLandmarksRequest, VNFaceLandmarkRegion2D, VNImageRequestHandler, VNRequest,
    };

    use super::{DetectedFace, FaceBox};

    /// Vision face detection WITH landmarks on an already-oriented bitmap.
    ///
    /// The bitmap goes in as encoded JPEG bytes: Vision decodes them itself,
    /// and feeding it the oriented pixels sidesteps the whole
    /// orientation-mapping question — boxes and landmarks come back in the
    /// same geometry the crops are cut from.
    pub fn detect_faces(img: &image::DynamicImage) -> Result<Vec<DetectedFace>, String> {
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
            let request = VNDetectFaceLandmarksRequest::new();
            // Up the class hierarchy: …FaceLandmarksRequest → VNImageBasedRequest → VNRequest.
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
                    let rect = FaceBox {
                        x: b.origin.x as f32,
                        // Vision's origin is bottom-left; ours is top-left.
                        y: 1.0 - (b.origin.y + b.size.height) as f32,
                        width: b.size.width as f32,
                        height: b.size.height as f32,
                    };
                    // Region points are normalized to the face box, origin
                    // bottom-left; map into top-left image coordinates.
                    let to_image = |p: [f32; 2]| -> [f32; 2] {
                        [
                            b.origin.x as f32 + p[0] * b.size.width as f32,
                            1.0 - (b.origin.y as f32 + p[1] * b.size.height as f32),
                        ]
                    };
                    let landmarks = obs.landmarks().and_then(|lm| {
                        let centroid = |r: Option<Retained<VNFaceLandmarkRegion2D>>| {
                            let r = r?;
                            let n = r.pointCount();
                            if n == 0 {
                                return None;
                            }
                            let pts = r.normalizedPoints();
                            let mut acc = [0f32; 2];
                            for k in 0..n {
                                let p = *pts.add(k);
                                acc[0] += p.x as f32;
                                acc[1] += p.y as f32;
                            }
                            Some([acc[0] / n as f32, acc[1] / n as f32])
                        };
                        let corner = |r: Option<Retained<VNFaceLandmarkRegion2D>>,
                                      left: bool| {
                            let r = r?;
                            let n = r.pointCount();
                            if n == 0 {
                                return None;
                            }
                            let pts = r.normalizedPoints();
                            let mut best: Option<[f32; 2]> = None;
                            for k in 0..n {
                                let p = *pts.add(k);
                                let candidate = [p.x as f32, p.y as f32];
                                let better = match best {
                                    None => true,
                                    Some(cur) => {
                                        if left {
                                            candidate[0] < cur[0]
                                        } else {
                                            candidate[0] > cur[0]
                                        }
                                    }
                                };
                                if better {
                                    best = Some(candidate);
                                }
                            }
                            best
                        };
                        let left_eye = centroid(lm.leftEye())?;
                        let right_eye = centroid(lm.rightEye())?;
                        let nose = centroid(lm.nose())?;
                        let mouth_left = corner(lm.outerLips(), true)?;
                        let mouth_right = corner(lm.outerLips(), false)?;
                        Some([
                            to_image(left_eye),
                            to_image(right_eye),
                            to_image(nose),
                            to_image(mouth_left),
                            to_image(mouth_right),
                        ])
                    });
                    DetectedFace { rect, landmarks }
                })
                .collect())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {

    pub fn detect_faces(_img: &image::DynamicImage) -> Result<Vec<super::DetectedFace>, String> {
        Err("face detection is not implemented for this platform yet".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tempdir must outlive the service — dropping it deletes the db.
    fn service() -> (tempfile::TempDir, FaceService) {
        let dir = tempfile::tempdir().unwrap();
        let svc = FaceService::new(dir.path().join("cache"), &dir.path().join("faces.db")).unwrap();
        (dir, svc)
    }

    /// A unit vector along one axis — orthogonal axes are distinct people.
    fn axis(i: usize) -> Arc<Vec<f32>> {
        let mut v = vec![0.0f32; 4];
        v[i] = 1.0;
        Arc::new(v)
    }

    fn install_clusters(svc: &FaceService, clusters: &[(&str, usize)]) {
        *svc.last_clusters.lock().unwrap() = clusters
            .iter()
            .map(|(id, ax)| LastCluster {
                id: id.to_string(),
                name: None,
                vectors: vec![axis(*ax); 4],
            })
            .collect();
    }

    #[test]
    fn a_name_sticks_to_vectors_and_leaves_with_them() {
        let (_dir, svc) = service();
        install_clusters(&svc, &[("1", 0), ("2", 1)]);

        // Naming saves exemplars; both fragments named alike share them.
        svc.rename("1", "Ania", 0.38).unwrap();
        assert_eq!(svc.known_names().unwrap(), vec!["Ania"]);
        svc.rename("2", "Ania", 0.38).unwrap();
        let ania = &svc.identities().unwrap()[0];
        assert!(ania.exemplars.iter().any(|e| e[0] > 0.9));
        assert!(ania.exemplars.iter().any(|e| e[1] > 0.9));

        // Renaming one fragment away withdraws only ITS exemplars.
        svc.rename("2", "Kasia", 0.38).unwrap();
        let ids = svc.identities().unwrap();
        let ania = ids.iter().find(|i| i.name == "Ania").unwrap();
        assert!(ania.exemplars.iter().all(|e| e[0] > 0.9));
        let kasia = ids.iter().find(|i| i.name == "Kasia").unwrap();
        assert!(kasia.exemplars.iter().all(|e| e[1] > 0.9));

        // Clearing the last cluster of a name deletes the identity.
        svc.rename("1", "", 0.38).unwrap();
        svc.rename("2", "  ", 0.38).unwrap();
        assert_eq!(svc.known_names().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn renaming_an_unknown_cluster_is_an_error_not_a_panic() {
        let (_dir, svc) = service();
        assert!(svc.rename("7", "Ania", 0.38).is_err());
    }
}
