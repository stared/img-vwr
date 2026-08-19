use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::services::embeddings::EmbeddingService;

/// Coordinates are normalized to the EXIF-oriented image, origin top-left.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// The loose crop with context — the People panel's chip.
    pub crop: String,
    /// The aligned 112×112 crop the identity model reads.
    pub id_crop: String,
    /// Unaligned faces (no landmarks, or a true profile) never cluster: a degraded embedding joins other degraded embeddings.
    pub aligned: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonCluster {
    /// A named person's id IS their name (it survives reclustering); unnamed clusters get run ordinals.
    pub id: String,
    pub name: Option<String>,
    pub cover: String,
    pub chips: Vec<String>,
    pub photos: Vec<String>,
    pub solo: Vec<String>,
    pub few: Vec<String>,
    pub background: Vec<String>,
    /// Faceless photos near-identical to a member — the person turned away between shots.
    pub implied: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Sidecar {
    faces: Vec<Face>,
}

const DETECT_EDGE: u32 = 1600;

const CROP_MARGIN: f32 = 0.35;

const CROP_EDGE: u32 = 256;

/// Below this share of the longest edge a face embeds as noise and clusters with nothing.
const MIN_FACE_SHARE: f32 = 0.03;

pub struct FaceService {
    faces: Mutex<HashMap<String, Arc<Vec<Face>>>>,
    indexing: AtomicBool,
    /// Sidecars: {thumb_key}.json under the cache root.
    sidecars_dir: PathBuf,
    /// Face crops: {thumb_key}-{i}.jpg under the cache root.
    crops_dir: PathBuf,
    face_model: Mutex<Option<Arc<imgvwr_embed::FaceEmbedder>>>,
    face_vectors: Mutex<HashMap<String, Arc<Vec<f32>>>>,
    /// Identity vectors on disk: {id-crop stem}.vec (f32 LE).
    face_vectors_dir: PathBuf,
    /// Hugging Face cache, shared with the similarity models.
    models_dir: PathBuf,
    /// User data, not a cache: names must survive every cache wipe.
    names: Mutex<Connection>,
    /// The most recent `people()` run, so a rename can find the vectors behind a cluster id.
    last_clusters: Mutex<Vec<LastCluster>>,
}

struct LastCluster {
    id: String,
    name: Option<String>,
    vectors: Vec<Arc<Vec<f32>>>,
}

struct Identity {
    name: String,
    exemplars: Vec<Vec<f32>>,
}

const MAX_EXEMPLARS: usize = 24;

const NAME_SAMPLE: usize = 8;

/// A spread sample rather than the head: mistakes cluster at the tail.
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

    /// Naming saves exemplar vectors (so two fragments named alike merge next clustering); renaming away withdraws this cluster's exemplars.
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
                // Max over members, not average: a merged cluster is a mixed bag and an average dilutes each fragment's agreement.
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

    /// Runs on the calling thread; the command wraps it in a background task.
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

    /// Never detects: an unindexed photo is simply not clustered yet.
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

    /// One oriented bitmap serves both the detector and the crops, so their coordinates always agree.
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
            // Landmark-aligned to the ArcFace template; faces it cannot fit (true profiles) keep an unaligned crop, marked so.
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

    /// Greedy centroid clustering, order-dependent by design: cached vectors make a rerun milliseconds.
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
            /// Kept for average-linkage merging.
            vectors: Vec<Arc<Vec<f32>>>,
            best: (f32, String), // closest crop to centroid = cover
            name: Option<String>,
        }

        /// Average pairwise similarity, NOT centroid-vs-centroid: growing centroids converge on the generic-face component.
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

        // The greedy pass fragments one person (stage light vs daylight); merge fragments on average pairwise similarity.
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

        // Each cluster takes the stored name it agrees with best, so a name keeps finding its person across reclusters.
        let identities = self.identities()?;
        for c in clusters.iter_mut() {
            let sample = spread(&c.vectors, 12);
            // Best-scoring name wins; one name may claim several clusters — those merge below.
            let mut best: Option<(f32, &String)> = None;
            for identity in &identities {
                // The best-agreeing exemplar decides, NOT the average: exemplars deliberately span fragments below the merge bar.
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

        // Two clusters wearing one name union regardless of what the vectors say.
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

        // Subjects sort before background-only people, whatever the raw face count says.
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
            // A faceless photo near-identical to a member belongs to the same moment, so the same person is in it.
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
            // Spread, not the first few: mistakes cluster at the tail.
            let step = (c.faces.len() / 8).max(1);
            let chips: Vec<String> = c
                .faces
                .iter()
                .step_by(step)
                .take(8)
                .map(|(_, crop, _)| crop.clone())
                .collect();
            out.push(PersonCluster {
                // Unnamed clusters get a bare number; the filter chip already says "person:".
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

/// Ordered: a smaller discriminant is a stronger presence, so `min` picks the best role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Solo = 0,
    Few = 1,
    Background = 2,
}

const BACKGROUND_HEIGHT: f32 = 0.10;

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

/// Pinned so a display-thumbnail resolution bump cannot orphan every detected face and the names hung on people.
const SIDECAR_KEY_EDGE: u32 = 256;

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

/// Normalized to the oriented bitmap, origin top-left.
pub struct FaceBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Landmarks, when found: left eye, right eye, nose, mouth corners — normalized to the image, origin top-left.
pub struct DetectedFace {
    pub rect: FaceBox,
    pub landmarks: Option<[[f32; 2]; 5]>,
}

/// insightface's canonical ArcFace template: where the five landmarks land in an aligned 112×112 crop.
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

/// Mean landmark error (template px) above which the fit is a true profile squeezed onto a frontal template.
const MAX_ALIGN_RESIDUAL: f32 = 8.0;

/// Least-squares fit of detected landmarks (image px) onto the template; None when too poor to trust.
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

    /// Vision gets the already-oriented pixels (as JPEG bytes), so boxes and landmarks come back in the crops' own geometry.
    pub fn detect_faces(img: &image::DynamicImage) -> Result<Vec<DetectedFace>, String> {
        let mut jpeg = Vec::new();
        img.to_rgb8()
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg),
                image::ImageFormat::Jpeg,
            )
            .map_err(|e| e.to_string())?;

        // SAFETY: message sends on objects we own; the handler runs synchronously on this thread.
        unsafe {
            let data = NSData::with_bytes(&jpeg);
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                &NSDictionary::new(),
            );
            let request = VNDetectFaceLandmarksRequest::new();
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
                    // Region points are normalized to the face box, origin bottom-left; map to top-left image coordinates.
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
