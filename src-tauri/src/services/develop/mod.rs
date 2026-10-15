//! Opening a RAW is ~2 s, re-rendering ~20 ms — so the service holds a few scenes open.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use imgvwr_core::thumbs::apply_orientation;
use imgvwr_core::{Region, SceneError, SceneImage, SceneRegistry, WhiteBalance};
use imgvwr_develop::{Crop, DevelopParams, DevelopSettings, Histogram, Overlay};
use rusqlite::Connection;
use serde::Serialize;

use super::export::{self, ExportFormat, ExportJob, ExportPlan, Exported};

const OPEN_SCENES: usize = 3;

/// Bytes, not slots: a slot count let a loupe drag evict the full preview still on screen.
const FRAME_BUDGET: usize = 32 * 1024 * 1024;

/// Kept regardless of the budget, so one enormous frame cannot empty the ring.
const FRAMES_KEPT: usize = 4;

const PREVIEW_QUALITY: u8 = 92;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopState {
    pub width: u32,
    pub height: u32,
    pub as_shot: WhiteBalance,
    pub settings: DevelopSettings,
    pub edited: bool,
    /// True when the webview cannot display this file itself.
    pub needs_render: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FrameSource {
    CameraJpeg,
    RawDevelop,
}

/// Pixels live under `token`, fetched via the `develop:` protocol; the histogram comes inline.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopFrame {
    pub token: u64,
    pub width: u32,
    pub height: u32,
    pub source: FrameSource,
    pub histogram: Histogram,
    /// The covered part of the frame, normalised: unit rect for a full-frame preview, the developed crop for a 1:1 detail.
    pub region_x: f32,
    pub region_y: f32,
    pub region_width: f32,
    pub region_height: f32,
}

struct OpenScene {
    path: String,
    scene: Box<dyn SceneImage>,
    /// Measured once at open so preview, loupe and export agree.
    tuning: Option<imgvwr_develop::LookTuning>,
    /// The camera's own JPEG, decoded lazily on the first render at camera-default settings.
    camera: OnceLock<Option<Box<dyn SceneImage>>>,
}

impl OpenScene {
    fn camera_scene(&self) -> Option<&dyn SceneImage> {
        self.camera
            .get_or_init(|| camera_jpeg_scene(&self.path))
            .as_deref()
    }

    /// At untouched camera-default settings the camera's own JPEG renders instead.
    fn resolved(
        &self,
        settings: &DevelopSettings,
    ) -> (
        &dyn SceneImage,
        DevelopSettings,
        Option<&imgvwr_develop::LookTuning>,
        FrameSource,
    ) {
        if imgvwr_develop::is_camera_default(settings, self.scene.as_shot(), self.scene.rendering()) {
            if let Some(cam) = self.camera_scene() {
                let neutral = imgvwr_develop::opening_settings(cam.as_shot(), cam.rendering());
                return (cam, neutral, None, FrameSource::CameraJpeg);
            }
        }
        (
            self.scene.as_ref(),
            settings.clone(),
            self.tuning.as_ref(),
            FrameSource::RawDevelop,
        )
    }
}

pub struct DevelopService {
    registry: Arc<SceneRegistry>,
    open: Mutex<VecDeque<Arc<OpenScene>>>,
    frames: Mutex<VecDeque<(u64, Vec<u8>)>>,
    next_token: AtomicU64,
    conn: Mutex<Connection>,
}

impl DevelopService {
    pub fn new(registry: Arc<SceneRegistry>, db_file: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_file)?;
        // Edits are app-local, never written next to the user's photos.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS develop (
                 path        TEXT PRIMARY KEY,
                 temperature REAL NOT NULL,
                 tint        REAL NOT NULL,
                 exposure    REAL NOT NULL,
                 contrast    REAL NOT NULL,
                 highlights  REAL NOT NULL,
                 shadows     REAL NOT NULL,
                 whites      REAL NOT NULL,
                 blacks      REAL NOT NULL,
                 vibrance    REAL NOT NULL,
                 saturation  REAL NOT NULL
             ) STRICT;",
        )?;
        // Migration columns: each default leaves an old row rendering exactly as its author left it.
        for column in [
            "rolloff REAL NOT NULL DEFAULT 0",
            "basis TEXT NOT NULL DEFAULT 'flat'",
            "crop_x REAL NOT NULL DEFAULT 0",
            "crop_y REAL NOT NULL DEFAULT 0",
            "crop_w REAL NOT NULL DEFAULT 1",
            "crop_h REAL NOT NULL DEFAULT 1",
            "crop_angle REAL NOT NULL DEFAULT 0",
            // 'flat', not the camera look: old rows emulated the look with sliders, and applying both would double it.
            "look TEXT NOT NULL DEFAULT 'flat'",
        ] {
            if let Err(e) = conn.execute(&format!("ALTER TABLE develop ADD COLUMN {column}"), []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e);
                }
            }
        }
        // Tuning cache keyed by mtime; model_tag ties rows to the fitted constants, so a refit invalidates them all.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS look_tunings (
                 path       TEXT PRIMARY KEY,
                 mtime_ms   INTEGER NOT NULL,
                 model_tag  TEXT NOT NULL,
                 gain       REAL NOT NULL,
                 contrast   REAL NOT NULL,
                 wb_r       REAL NOT NULL,
                 wb_b       REAL NOT NULL,
                 saturation REAL NOT NULL,
                 chroma_nr  REAL NOT NULL,
                 luma_nr    REAL NOT NULL,
                 sharpen    REAL NOT NULL
             ) STRICT;",
        )?;
        if let Err(e) = conn.execute(
            "ALTER TABLE look_tunings ADD COLUMN flat INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
        Ok(Self {
            registry,
            open: Mutex::new(VecDeque::new()),
            frames: Mutex::new(VecDeque::new()),
            next_token: AtomicU64::new(1),
            conn: Mutex::new(conn),
        })
    }

    fn scene_for(&self, path: &str) -> Result<Arc<OpenScene>, SceneError> {
        {
            let mut open = self.open.lock().unwrap();
            if let Some(pos) = open.iter().position(|s| s.path == path) {
                let hit = open.remove(pos).expect("position just found");
                open.push_back(Arc::clone(&hit));
                return Ok(hit);
            }
        }

        // Opening is slow, so it happens outside the lock.
        let scene = self.registry.open(Path::new(path))?;
        let (tuning, flat) = self.tuning_for(path, scene.as_ref());
        // A flat decode is the system decoder failing silently (pixel-shift brackets); the embedded JPEG opens instead.
        let (scene, tuning) = if flat {
            match embedded_fallback(path) {
                Some(fallback) => (fallback, None),
                None => (scene, tuning),
            }
        } else {
            (scene, tuning)
        };
        let entry = Arc::new(OpenScene {
            path: path.to_owned(),
            scene,
            tuning,
            camera: OnceLock::new(),
        });

        let mut open = self.open.lock().unwrap();
        if let Some(pos) = open.iter().position(|s| s.path == path) {
            // Another thread won the race; keep its scene and drop ours.
            return Ok(Arc::clone(&open[pos]));
        }
        open.push_back(Arc::clone(&entry));
        while open.len() > OPEN_SCENES {
            open.pop_front();
        }
        Ok(entry)
    }

    pub fn state(&self, path: &str) -> Result<DevelopState, String> {
        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let (width, height) = entry.scene.native_size();
        let as_shot = entry.scene.as_shot();
        let stored = self.stored_settings(path)?;
        let opening = imgvwr_develop::opening_settings(as_shot, entry.scene.rendering());
        Ok(DevelopState {
            width,
            height,
            as_shot,
            edited: stored.is_some(),
            settings: stored.unwrap_or(opening),
            needs_render: imgvwr_raw::is_raw_extension(&extension_of(path)),
        })
    }

    pub fn auto_exposure(&self, path: &str, settings: &DevelopSettings) -> Result<f32, String> {
        const MEASURE_EDGE: u32 = 400;
        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let linear = entry
            .scene
            .render(imgvwr_core::RenderRequest {
                max_edge: MEASURE_EDGE,
                white_balance: settings.clamped().white_balance,
                region: Region::FULL,
            })
            .map_err(|e| e.to_string())?;
        Ok(imgvwr_develop::auto_exposure(&linear))
    }

    /// Two passes: a downscale hides defocus, so coarse candidates are re-measured at 1:1.
    pub fn focus_point(&self, path: &str, settings: &DevelopSettings) -> Result<[f32; 2], String> {
        const MEASURE_EDGE: u32 = 500;
        const PROBE_EDGE: u32 = 224;
        const CANDIDATES: usize = 5;

        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let settings = settings.clamped();
        let coarse = imgvwr_develop::render_linear(
            entry.scene.as_ref(),
            &settings,
            MEASURE_EDGE,
            Region::FULL,
        )
        .map_err(|e| e.to_string())?;
        let candidates = imgvwr_develop::focus_candidates(&coarse, CANDIDATES);
        let Some(&first) = candidates.first() else {
            return Ok([0.5, 0.5]);
        };

        // The coarse pass already saw near-native pixels; a probe would render the same.
        let displayed = settings.crop.output_size(entry.scene.native_size(), u32::MAX);
        let longest = displayed.0.max(displayed.1);
        if longest <= MEASURE_EDGE * 2 || candidates.len() == 1 {
            return Ok([first.0, first.1]);
        }

        let best = candidates
            .iter()
            .map(|&(x, y)| {
                let span_x = (PROBE_EDGE as f32 / displayed.0.max(1) as f32).min(1.0);
                let span_y = (PROBE_EDGE as f32 / displayed.1.max(1) as f32).min(1.0);
                let region = Region {
                    x: (x - span_x / 2.0).clamp(0.0, 1.0 - span_x),
                    y: (y - span_y / 2.0).clamp(0.0, 1.0 - span_y),
                    width: span_x,
                    height: span_y,
                };
                let detail = imgvwr_develop::render_linear(
                    entry.scene.as_ref(),
                    &settings,
                    PROBE_EDGE,
                    region,
                )
                .map(|patch| imgvwr_develop::resolved_detail(&patch))
                // A failed probe ranks last rather than erroring the whole search.
                .unwrap_or(f32::NEG_INFINITY);
                ((x, y), detail)
            })
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(at, _)| at)
            .unwrap_or(first);
        Ok([best.0, best.1])
    }

    pub fn render(
        &self,
        path: &str,
        settings: &DevelopSettings,
        max_edge: u32,
        overlay: Overlay,
        region: Region,
    ) -> Result<DevelopFrame, String> {
        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let (scene, settings, tuning, source) = entry.resolved(settings);
        let developed =
            imgvwr_develop::render_looked(scene, &settings, max_edge, overlay, region, tuning)
                .map_err(|e| e.to_string())?;

        let jpeg = encode_jpeg(&developed.image, PREVIEW_QUALITY)?;
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);
        {
            let mut frames = self.frames.lock().unwrap();
            frames.push_back((token, jpeg));
            evict_past(&mut frames, FRAME_BUDGET);
        }

        let region = region.clamped();
        Ok(DevelopFrame {
            token,
            width: developed.image.width,
            height: developed.image.height,
            source,
            histogram: developed.histogram,
            region_x: region.x,
            region_y: region.y,
            region_width: region.width,
            region_height: region.height,
        })
    }

    /// Takes the whole settings: the point arrives in cropped-image coordinates and only the crop can map it to the sensor.
    pub fn pick_white_balance(
        &self,
        path: &str,
        x: f32,
        y: f32,
        settings: &DevelopSettings,
    ) -> Result<WhiteBalance, String> {
        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let settings = settings.clamped();
        let native = entry.scene.native_size();
        let aspect = if native.1 == 0 {
            1.0
        } else {
            native.0 as f32 / native.1 as f32
        };
        let (fx, fy) = settings.crop.point_in_original(x, y, aspect);
        entry
            .scene
            .neutral_at(fx, fy, settings.white_balance)
            .map_err(|e| e.to_string())
    }

    /// Cloned rather than removed: the webview may re-request a URL.
    pub fn frame(&self, token: u64) -> Option<Vec<u8>> {
        let frames = self.frames.lock().unwrap();
        frames
            .iter()
            .find(|(t, _)| *t == token)
            .map(|(_, bytes)| bytes.clone())
    }

    /// The only place this app writes pixels, always into a folder the user picked.
    pub fn export(&self, job: &ExportJob, plan: &ExportPlan) -> Result<Exported, String> {
        let folder = Path::new(&plan.folder);
        if !folder.is_dir() {
            return Err(format!("{} is not a folder", plan.folder));
        }
        let source = job.source().to_string();

        match job {
            ExportJob::Copy { path } => {
                let from = Path::new(path);
                let ext = match plan.format {
                    ExportFormat::Png => "png",
                    ExportFormat::Jpeg { .. } => "jpg",
                };
                let destination = export::destination_for(folder, path, ext);
                let copied = export::copy_jpeg(from, plan, &destination)?;
                Ok(Exported {
                    source,
                    path: destination.to_string_lossy().into_owned(),
                    copied,
                })
            }
            ExportJob::Render { path, exif } => {
                let entry = self.scene_for(path).map_err(|e| e.to_string())?;
                let (w, h) = entry.scene.native_size();
                let settings = self.stored_settings(path)?.unwrap_or_else(|| {
                    imgvwr_develop::opening_settings(entry.scene.as_shot(), entry.scene.rendering())
                });
                // Through `resolved`: an untouched raw exports the camera's own pixels, not an imitation.
                let (scene, settings, tuning, _source) = entry.resolved(&settings);
                let developed = imgvwr_develop::render_looked(
                    scene,
                    &settings,
                    plan.size.edge(w.max(h)),
                    Overlay::None,
                    Region::FULL,
                    tuning,
                )
                .map_err(|e| e.to_string())?;

                let img = image::RgbaImage::from_raw(
                    developed.image.width,
                    developed.image.height,
                    developed.image.rgba,
                )
                .ok_or_else(|| "developed buffer size mismatch".to_string())?;

                let destination = export::destination_for(folder, path, plan.format.extension());
                export::write_rendered(img, plan, exif, &destination)?;
                Ok(Exported {
                    source,
                    path: destination.to_string_lossy().into_owned(),
                    copied: false,
                })
            }
        }
    }

    pub fn stored_settings(&self, path: &str) -> Result<Option<DevelopSettings>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT temperature, tint, exposure, contrast, highlights, shadows,
                        whites, blacks, rolloff, vibrance, saturation, basis,
                        crop_x, crop_y, crop_w, crop_h, crop_angle, look
                 FROM develop WHERE path = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map([path], |row| {
                Ok(DevelopSettings {
                    white_balance: WhiteBalance {
                        temperature: row.get::<_, f64>(0)? as f32,
                        tint: row.get::<_, f64>(1)? as f32,
                    },
                    params: DevelopParams {
                        exposure: row.get::<_, f64>(2)? as f32,
                        contrast: row.get::<_, f64>(3)? as f32,
                        highlights: row.get::<_, f64>(4)? as f32,
                        shadows: row.get::<_, f64>(5)? as f32,
                        whites: row.get::<_, f64>(6)? as f32,
                        blacks: row.get::<_, f64>(7)? as f32,
                        rolloff: row.get::<_, f64>(8)? as f32,
                        vibrance: row.get::<_, f64>(9)? as f32,
                        saturation: row.get::<_, f64>(10)? as f32,
                    },
                    crop: imgvwr_develop::Crop {
                        x: row.get::<_, f64>(12)? as f32,
                        y: row.get::<_, f64>(13)? as f32,
                        width: row.get::<_, f64>(14)? as f32,
                        height: row.get::<_, f64>(15)? as f32,
                        angle: row.get::<_, f64>(16)? as f32,
                    },
                    basis: row.get::<_, String>(11)?,
                    look: row.get::<_, String>(17)?,
                })
            })
            .map_err(|e| e.to_string())?;
        match rows.next() {
            // Clamped on the way out: the row may predate the current ranges.
            Some(row) => Ok(Some(row.map_err(|e| e.to_string())?.clamped())),
            None => Ok(None),
        }
    }

    pub fn save_settings(&self, path: &str, settings: &DevelopSettings) -> Result<(), String> {
        let s = settings.clamped();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO develop
                 (path, temperature, tint, exposure, contrast, highlights,
                  shadows, whites, blacks, rolloff, vibrance, saturation, basis,
                  crop_x, crop_y, crop_w, crop_h, crop_angle, look)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT(path) DO UPDATE SET
                 temperature = excluded.temperature, tint = excluded.tint,
                 exposure = excluded.exposure, contrast = excluded.contrast,
                 highlights = excluded.highlights, shadows = excluded.shadows,
                 whites = excluded.whites, blacks = excluded.blacks,
                 rolloff = excluded.rolloff,
                 vibrance = excluded.vibrance, saturation = excluded.saturation,
                 basis = excluded.basis,
                 crop_x = excluded.crop_x, crop_y = excluded.crop_y,
                 crop_w = excluded.crop_w, crop_h = excluded.crop_h,
                 crop_angle = excluded.crop_angle, look = excluded.look",
            rusqlite::params![
                path,
                f64::from(s.white_balance.temperature),
                f64::from(s.white_balance.tint),
                f64::from(s.params.exposure),
                f64::from(s.params.contrast),
                f64::from(s.params.highlights),
                f64::from(s.params.shadows),
                f64::from(s.params.whites),
                f64::from(s.params.blacks),
                f64::from(s.params.rolloff),
                f64::from(s.params.vibrance),
                f64::from(s.params.saturation),
                s.basis.clone(),
                f64::from(s.crop.x),
                f64::from(s.crop.y),
                f64::from(s.crop.width),
                f64::from(s.crop.height),
                f64::from(s.crop.angle),
                s.look.clone(),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_settings(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM develop WHERE path = ?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn edited_paths(&self, paths: &[String]) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        for chunk in paths.chunks(512) {
            let marks = vec!["?"; chunk.len()].join(",");
            let mut stmt = conn
                .prepare(&format!("SELECT path FROM develop WHERE path IN ({marks})"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                out.push(row.map_err(|e| e.to_string())?);
            }
        }
        Ok(out)
    }

    pub fn crops(&self, paths: &[String]) -> Result<HashMap<String, Crop>, String> {
        let conn = self.conn.lock().unwrap();
        let mut out = HashMap::new();
        for chunk in paths.chunks(512) {
            let marks = vec!["?"; chunk.len()].join(",");
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT path, crop_x, crop_y, crop_w, crop_h, crop_angle \
                     FROM develop WHERE path IN ({marks})"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        Crop {
                            x: row.get::<_, f64>(1)? as f32,
                            y: row.get::<_, f64>(2)? as f32,
                            width: row.get::<_, f64>(3)? as f32,
                            height: row.get::<_, f64>(4)? as f32,
                            angle: row.get::<_, f64>(5)? as f32,
                        },
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (path, crop) = row.map_err(|e| e.to_string())?;
                // A whole-frame crop is not a crop.
                if !crop.is_full() {
                    out.insert(path, crop);
                }
            }
        }
        Ok(out)
    }
}

impl DevelopService {
    /// Cached in the DB: the measuring render costs more than the whole open; file mtime and model tag key it.
    fn tuning_for(
        &self,
        path: &str,
        scene: &dyn SceneImage,
    ) -> (Option<imgvwr_develop::LookTuning>, bool) {
        if scene.rendering() != imgvwr_core::Rendering::SceneReferred {
            return (None, false);
        }
        let mtime_ms = std::fs::metadata(path)
            .map(|m| imgvwr_core::mtime_ms(&m) as i64)
            .unwrap_or(0);
        let tag = imgvwr_develop::look::model_tag();

        if let Ok(conn) = self.conn.lock() {
            let cached = conn
                .query_row(
                    "SELECT gain, contrast, wb_r, wb_b, saturation,
                            chroma_nr, luma_nr, sharpen, flat
                     FROM look_tunings
                     WHERE path = ?1 AND mtime_ms = ?2 AND model_tag = ?3",
                    rusqlite::params![path, mtime_ms, tag],
                    |row| {
                        Ok((
                            imgvwr_develop::LookTuning {
                                gain: row.get::<_, f64>(0)? as f32,
                                contrast: row.get::<_, f64>(1)? as f32,
                                wb_r: row.get::<_, f64>(2)? as f32,
                                wb_b: row.get::<_, f64>(3)? as f32,
                                saturation: row.get::<_, f64>(4)? as f32,
                                chroma_nr: row.get::<_, f64>(5)? as f32,
                                luma_nr: row.get::<_, f64>(6)? as f32,
                                sharpen: row.get::<_, f64>(7)? as f32,
                            },
                            row.get::<_, i64>(8)? != 0,
                        ))
                    },
                )
                .ok();
            if let Some((t, flat)) = cached {
                return (Some(t), flat);
            }
        }

        let Some((t, flat)) = measure_tuning_checked(path, scene) else {
            return (None, false);
        };
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO look_tunings
                 (path, mtime_ms, model_tag, gain, contrast, wb_r, wb_b,
                  saturation, chroma_nr, luma_nr, sharpen, flat)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    path,
                    mtime_ms,
                    tag,
                    t.gain as f64,
                    t.contrast as f64,
                    t.wb_r as f64,
                    t.wb_b as f64,
                    t.saturation as f64,
                    t.chroma_nr as f64,
                    t.luma_nr as f64,
                    t.sharpen as f64,
                    flat as i64,
                ],
            );
        }
        (Some(t), flat)
    }
}

/// `flat` = every pixel equal: what the system decoder produces for a file it cannot actually read (pixel-shift brackets).
fn measure_tuning_checked(
    path: &str,
    scene: &dyn SceneImage,
) -> Option<(imgvwr_develop::LookTuning, bool)> {
    const MEASURE_EDGE: u32 = 384;
    if scene.rendering() != imgvwr_core::Rendering::SceneReferred {
        return None;
    }
    let linear = scene
        .render(imgvwr_core::RenderRequest {
            max_edge: MEASURE_EDGE,
            white_balance: scene.as_shot(),
            region: Region::FULL,
        })
        .ok()?;
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for &v in &linear.rgb {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    let flat = !(hi - lo > 1e-4);
    let iso = imgvwr_core::read_meta(Path::new(path))
        .ok()
        .and_then(|m| m.exif)
        .and_then(|e| e.iso);
    let decisions = imgvwr_core::read_camera_decisions(Path::new(path));
    Some((
        imgvwr_develop::LookTuning::measure(&linear, iso, scene.as_shot(), &decisions),
        flat,
    ))
}

fn camera_jpeg_scene(path: &str) -> Option<Box<dyn SceneImage>> {
    sibling_camera_jpeg(path).or_else(|| embedded_fallback(path))
}

/// Same stem is not enough — the EXIF capture time must agree too.
fn sibling_camera_jpeg(path: &str) -> Option<Box<dyn SceneImage>> {
    let raw = Path::new(path);
    if !imgvwr_raw::is_raw_extension(&extension_of(path)) {
        return None;
    }
    let taken = imgvwr_core::read_meta(raw).ok()?.exif?.date_time?;
    for ext in ["JPG", "jpg", "JPEG", "jpeg"] {
        let candidate = raw.with_extension(ext);
        if !candidate.is_file() {
            continue;
        }
        let Some(exif) = imgvwr_core::read_meta(&candidate).ok().and_then(|m| m.exif) else {
            continue;
        };
        if exif.date_time.as_deref() != Some(taken.as_str()) {
            continue;
        }
        let img = image::open(&candidate).ok()?;
        let rgba = apply_orientation(img.to_rgba8(), exif.orientation);
        return Some(imgvwr_core::image_scene::scene_from_rgba(rgba));
    }
    None
}

fn embedded_fallback(path: &str) -> Option<Box<dyn SceneImage>> {
    let bytes = imgvwr_raw::embedded_jpeg(Path::new(path))?;
    let img = image::load_from_memory(&bytes).ok()?;
    let orientation = imgvwr_core::read_meta(Path::new(path))
        .ok()
        .and_then(|m| m.exif)
        .map(|e| e.orientation)
        .unwrap_or(1);
    Some(imgvwr_core::image_scene::scene_from_rgba(apply_orientation(
        img.to_rgba8(),
        orientation,
    )))
}

/// Deliberately neutral: thumbnails show the photograph, not the edit, so the cache stays valid while the user works.
pub fn thumbnail_via_develop(
    registry: &SceneRegistry,
    path: &Path,
    max_edge: u32,
) -> Result<Vec<u8>, String> {
    let scene = registry.open(path).map_err(|e| e.to_string())?;
    let measured = measure_tuning_checked(&path.to_string_lossy(), scene.as_ref());
    let (scene, tuning) = match measured {
        Some((_, true)) => match embedded_fallback(&path.to_string_lossy()) {
            Some(fallback) => (fallback, None),
            None => (scene, measured.map(|(t, _)| t)),
        },
        Some((t, false)) => (scene, Some(t)),
        None => (scene, None),
    };
    let settings = imgvwr_develop::opening_settings(scene.as_shot(), scene.rendering());
    let developed = imgvwr_develop::render_looked(
        scene.as_ref(),
        &settings,
        max_edge,
        Overlay::None,
        Region::FULL,
        tuning.as_ref(),
    )
    .map_err(|e| e.to_string())?;
    let img = &developed.image;
    webp::Encoder::from_rgba(&img.rgba, img.width, img.height)
        .encode_simple(false, imgvwr_core::thumbs::THUMB_WEBP_QUALITY)
        .map(|mem| mem.to_vec())
        .map_err(|e| format!("webp encode failed: {e:?}"))
}

fn evict_past(frames: &mut VecDeque<(u64, Vec<u8>)>, budget: usize) {
    let mut held: usize = frames.iter().map(|(_, bytes)| bytes.len()).sum();
    while held > budget && frames.len() > FRAMES_KEPT {
        match frames.pop_front() {
            Some((_, dropped)) => held -= dropped.len(),
            None => break,
        }
    }
}

fn encode_jpeg(img: &imgvwr_core::DecodedImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = image::RgbaImage::from_raw(img.width, img.height, img.rgba.clone())
        .ok_or_else(|| "developed buffer size mismatch".to_string())?;
    export::encode_jpeg(&image::DynamicImage::ImageRgba8(rgb).into_rgb8(), quality)
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn parse_frame_token(uri_path: &str) -> Option<u64> {
    uri_path
        .rsplit('/')
        .find(|segment| !segment.is_empty())?
        .parse()
        .ok()
}

mod commands;
pub use commands::*;

#[cfg(test)]
mod tests;
