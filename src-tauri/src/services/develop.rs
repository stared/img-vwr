//! Host for the develop pipeline: keeps images open between renders, stores
//! edits, and hands encoded previews to the custom URI protocol.
//!
//! The expensive part of developing a RAW file is opening it (~2 s for a
//! 24 MP NEF — parse plus demosaic setup); re-rendering it under new settings
//! is ~20 ms. So the service is built around holding a small number of scenes
//! open, which is what makes slider dragging feel live.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use imgvwr_core::{Region, SceneError, SceneImage, SceneRegistry, WhiteBalance};
use imgvwr_develop::{DevelopParams, DevelopSettings, Histogram, Overlay};
use rusqlite::Connection;
use serde::Serialize;

/// How many opened images to hold. The viewer shows one at a time; a couple
/// more keeps arrow-key navigation between neighbours instant without pinning
/// hundreds of megabytes of decoded sensor data.
const OPEN_SCENES: usize = 3;

/// How much encoded preview to keep addressable by token.
///
/// Budgeted in bytes rather than in slots, because the frames differ in size
/// by two orders of magnitude and a slot count silently means different things
/// to each. Dragging the loupe produces a stream of twenty-kilobyte squares;
/// under a sixteen-slot rule that stream evicted the multi-hundred-kilobyte
/// preview the canvas was *currently showing*, and the photograph went black
/// behind a working loupe. Memory is the thing actually being rationed, so it
/// is the thing to count: a burst of small frames now costs small frames'
/// worth of room.
const FRAME_BUDGET: usize = 32 * 1024 * 1024;

/// Kept regardless of the budget, so one enormous frame cannot leave the ring
/// empty and every neighbour needing to be developed again.
const FRAMES_KEPT: usize = 4;

/// Preview JPEG quality. High enough that the user is judging their photo
/// rather than the codec, low enough to encode in a few milliseconds.
const PREVIEW_QUALITY: u8 = 92;

/// Everything the develop UI needs to show an image before any edit is made.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopState {
    pub width: u32,
    pub height: u32,
    /// The white balance the camera chose — the neutral the sliders start at.
    pub as_shot: WhiteBalance,
    /// Stored edit, or the neutral one if this image has never been touched.
    pub settings: DevelopSettings,
    /// True when the settings came from the database rather than being neutral.
    pub edited: bool,
    /// True when the webview cannot display this file itself, so the viewer
    /// must go through the develop pipeline to show anything at all.
    pub needs_render: bool,
}

/// A rendered preview: the pixels live in the service under `token` and are
/// fetched by the `develop:` protocol; the histogram comes back inline.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DevelopFrame {
    pub token: u64,
    pub width: u32,
    pub height: u32,
    pub histogram: Histogram,
    /// The part of the frame these pixels cover, normalised. A full-frame
    /// preview reports the unit rect; a 1:1 detail render reports the crop it
    /// developed, so the viewer knows where to place it.
    pub region_x: f32,
    pub region_y: f32,
    pub region_width: f32,
    pub region_height: f32,
}

struct OpenScene {
    path: String,
    scene: Box<dyn SceneImage>,
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
        // Same rule as labels: edits are app-local and never written next to
        // the user's photos. Export is the explicit way pixels leave.
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
        // Columns added after the first release, so existing databases need
        // them. Each default is the value that leaves an old row rendering and
        // reading exactly as its author left it: no shoulder, and no preset
        // underneath it.
        for column in [
            "rolloff REAL NOT NULL DEFAULT 0",
            "basis TEXT NOT NULL DEFAULT 'flat'",
            // The whole frame, unturned: what every row written before crop
            // existed was in fact showing.
            "crop_x REAL NOT NULL DEFAULT 0",
            "crop_y REAL NOT NULL DEFAULT 0",
            "crop_w REAL NOT NULL DEFAULT 1",
            "crop_h REAL NOT NULL DEFAULT 1",
            "crop_angle REAL NOT NULL DEFAULT 0",
        ] {
            if let Err(e) = conn.execute(&format!("ALTER TABLE develop ADD COLUMN {column}"), []) {
                // Already there on every run but the first.
                if !e.to_string().contains("duplicate column name") {
                    return Err(e);
                }
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

    /// Open `path`, reusing an already-open scene when we have it.
    fn scene_for(&self, path: &str) -> Result<Arc<OpenScene>, SceneError> {
        {
            let mut open = self.open.lock().unwrap();
            if let Some(pos) = open.iter().position(|s| s.path == path) {
                // Refresh recency so the image being worked on is never the
                // one evicted.
                let hit = open.remove(pos).expect("position just found");
                open.push_back(Arc::clone(&hit));
                return Ok(hit);
            }
        }

        // Opening is slow, so it happens outside the lock: two viewers landing
        // on the same new image would otherwise serialise behind each other.
        let scene = self.registry.open(Path::new(path))?;
        let entry = Arc::new(OpenScene {
            path: path.to_owned(),
            scene,
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
        // An image nobody has edited still has to start somewhere, and for
        // sensor data that is not "flat": the camera would have applied a
        // curve before showing it to anyone, so the pipeline does too. The
        // plugin says which kind of pixels these are; nothing here asks about
        // file formats.
        let opening = imgvwr_develop::opening_settings(as_shot, entry.scene.rendering());
        Ok(DevelopState {
            width,
            height,
            as_shot,
            edited: stored.is_some(),
            settings: stored.unwrap_or(opening),
            // A RAW file has no decoder in the webview; anything the codec
            // registry handles can be shown directly and only needs the
            // develop path once it has actually been edited.
            needs_render: imgvwr_raw::is_raw_extension(&extension_of(path)),
        })
    }

    /// The exposure this frame wants, measured from the light it recorded.
    ///
    /// Rendered small on purpose: brightness is a statistic of the whole
    /// frame, and a few hundred pixels give the same percentiles as twenty
    /// million for a fraction of the time.
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

    /// Where this frame is sharpest, in the coordinates of the cropped image.
    ///
    /// In two passes, because one cannot work. A downscaled frame is where the
    /// candidates are (which parts have detail, light, and a plausible claim
    /// to being the subject) and it is emphatically not where the answer is:
    /// at 500 pixels across, a cable thirty pixels out of focus looks exactly
    /// as resolved as an eyelash, because a downscale softens everything by
    /// about that much anyway. So each candidate is then rendered at its true
    /// size — a small patch, the size of the loupe itself — and the pixels are
    /// asked directly. Defocus at 1:1 is unmistakable.
    ///
    /// The second pass costs a handful of small region renders on an image
    /// that is already open and decoded, against the alternative of pointing
    /// the loupe confidently at blurred foreground.
    pub fn focus_point(&self, path: &str, settings: &DevelopSettings) -> Result<[f32; 2], String> {
        /// Wide enough to nominate regions; see above for why not to trust it.
        const MEASURE_EDGE: u32 = 500;
        /// Native pixels across each probe — the loupe's own order of size, so
        /// what is measured is what the user will be shown.
        const PROBE_EDGE: u32 = 224;
        /// How many places are worth the second look.
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

        // Nothing to look closer at: the coarse pass already saw this image at
        // very nearly its own size, so a probe would render the same pixels.
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
                // A probe that would not render says nothing rather than
                // disqualifying a candidate the coarse pass liked.
                .unwrap_or(f32::NEG_INFINITY);
                ((x, y), detail)
            })
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(at, _)| at)
            .unwrap_or(first);
        Ok([best.0, best.1])
    }

    /// Render one preview frame and keep its encoded bytes addressable.
    pub fn render(
        &self,
        path: &str,
        settings: &DevelopSettings,
        max_edge: u32,
        overlay: Overlay,
        region: Region,
    ) -> Result<DevelopFrame, String> {
        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let developed =
            imgvwr_develop::render(entry.scene.as_ref(), settings, max_edge, overlay, region)
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
            histogram: developed.histogram,
            region_x: region.x,
            region_y: region.y,
            region_width: region.width,
            region_height: region.height,
        })
    }

    /// White balance that renders the point at normalised (x, y) neutral.
    /// Sample a point the user clicked on the picture they can see.
    ///
    /// Takes the whole settings rather than just the balance, because the
    /// point arrives in the cropped image's coordinates and only the crop
    /// knows where that is on the sensor. Passing it straight through would
    /// sample the middle of the frame when the user clicked the middle of a
    /// corner crop.
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

    /// Encoded bytes for a token, for the `develop:` protocol handler. Frames
    /// are cloned rather than removed: the webview may re-request a URL.
    pub fn frame(&self, token: u64) -> Option<Vec<u8>> {
        let frames = self.frames.lock().unwrap();
        frames
            .iter()
            .find(|(t, _)| *t == token)
            .map(|(_, bytes)| bytes.clone())
    }

    /// Develop at full sensor resolution and write the result. The only place
    /// this app writes pixels anywhere, and always to a caller-chosen path.
    pub fn export(
        &self,
        path: &str,
        settings: &DevelopSettings,
        destination: &Path,
    ) -> Result<(), String> {
        let entry = self.scene_for(path).map_err(|e| e.to_string())?;
        let (w, h) = entry.scene.native_size();
        let developed =
            imgvwr_develop::render(
                entry.scene.as_ref(),
                settings,
                w.max(h),
                Overlay::None,
                Region::FULL,
            )
                .map_err(|e| e.to_string())?;

        let img = image::RgbaImage::from_raw(
            developed.image.width,
            developed.image.height,
            developed.image.rgba,
        )
        .ok_or_else(|| "developed buffer size mismatch".to_string())?;

        let ext = destination
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_ascii_lowercase();
        if ext == "png" {
            img.save(destination).map_err(|e| e.to_string())
        } else {
            // JPEG has no alpha channel, and a developed photo has nothing
            // meaningful in one anyway.
            image::DynamicImage::ImageRgba8(img)
                .into_rgb8()
                .save_with_format(destination, image::ImageFormat::Jpeg)
                .map_err(|e| e.to_string())
        }
    }

    pub fn stored_settings(&self, path: &str) -> Result<Option<DevelopSettings>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT temperature, tint, exposure, contrast, highlights, shadows,
                        whites, blacks, rolloff, vibrance, saturation, basis,
                        crop_x, crop_y, crop_w, crop_h, crop_angle
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
                })
            })
            .map_err(|e| e.to_string())?;
        match rows.next() {
            // Clamped on the way out: the row may have been written by an
            // older version with different ranges.
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
                  crop_x, crop_y, crop_w, crop_h, crop_angle)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15, ?16, ?17, ?18)
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
                 crop_angle = excluded.crop_angle",
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
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Forget an image's edit entirely, so it goes back to being untouched
    /// rather than being stored as a neutral edit.
    pub fn clear_settings(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM develop WHERE path = ?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Paths with a stored edit, for badging the gallery.
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
}

/// Render one image straight to WebP thumbnail bytes, for formats the codec
/// registry cannot decode. Used by the thumbnail service so RAW files appear
/// in the gallery like anything else.
///
/// Deliberately neutral: thumbnails show the photograph, not the edit, so the
/// thumbnail cache stays valid while the user works.
pub fn thumbnail_via_develop(
    registry: &SceneRegistry,
    path: &Path,
    max_edge: u32,
) -> Result<Vec<u8>, String> {
    let scene = registry.open(path).map_err(|e| e.to_string())?;
    // The same look the viewer will open it with, so the grid does not
    // disagree with the picture it leads to. Stored edits are deliberately not
    // consulted: a thumbnail is a cheap index entry, and reading the database
    // once per cell would make scrolling a folder a database scan.
    let settings = imgvwr_develop::opening_settings(scene.as_shot(), scene.rendering());
    let developed =
        imgvwr_develop::render(scene.as_ref(), &settings, max_edge, Overlay::None, Region::FULL)
            .map_err(|e| e.to_string())?;
    let img = &developed.image;
    webp::Encoder::from_rgba(&img.rgba, img.width, img.height)
        .encode_simple(false, imgvwr_core::thumbs::THUMB_WEBP_QUALITY)
        .map(|mem| mem.to_vec())
        .map_err(|e| format!("webp encode failed: {e:?}"))
}

/// Drop the oldest frames until what is held fits `budget`, never going below
/// [`FRAMES_KEPT`].
///
/// Oldest-first because a token's usefulness really is its age: the webview
/// fetches a frame once, right after being handed the token, and everything
/// still on screen was handed out recently.
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
    let rgb = image::DynamicImage::ImageRgba8(rgb).into_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut std::io::Cursor::new(&mut out), quality)
        .encode(&rgb, img.width, img.height, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Parse a `develop:` preview URL into its frame token.
///
/// The path carries a monotonic token rather than the settings themselves:
/// every render gets a fresh URL, so the webview's own image cache can never
/// hand back the previous edit, and no settings are re-parsed or re-applied.
pub fn parse_frame_token(uri_path: &str) -> Option<u64> {
    uri_path
        .rsplit('/')
        .find(|segment| !segment.is_empty())?
        .parse()
        .ok()
}


#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, DevelopService) {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(SceneRegistry::new(vec![Arc::new(
            imgvwr_core::ImageCrateFormat::new(),
        )]));
        let svc = DevelopService::new(registry, &dir.path().join("develop.db")).unwrap();
        (dir, svc)
    }

    /// A stand-in for a raw plugin: sensor-like pixels that still want a look
    /// chosen. Lets the "what does an untouched image open as" rule be tested
    /// without a raw file, a platform decoder, or two seconds of demosaicing.
    struct SensorFormat;

    struct SensorScene;

    impl imgvwr_core::SceneFormat for SensorFormat {
        fn id(&self) -> &'static str {
            "test-sensor"
        }

        fn probe(&self, ext: &str, _magic: &[u8]) -> bool {
            ext == "sensor"
        }

        fn open(&self, _path: &Path) -> Result<Box<dyn imgvwr_core::SceneImage>, SceneError> {
            Ok(Box::new(SensorScene))
        }
    }

    impl imgvwr_core::SceneImage for SensorScene {
        fn native_size(&self) -> (u32, u32) {
            (4, 4)
        }

        fn rendering(&self) -> imgvwr_core::Rendering {
            imgvwr_core::Rendering::SceneReferred
        }

        fn as_shot(&self) -> WhiteBalance {
            WhiteBalance {
                temperature: 4800.0,
                tint: 8.0,
            }
        }

        fn render(
            &self,
            _req: imgvwr_core::RenderRequest,
        ) -> Result<imgvwr_core::LinearImage, SceneError> {
            Ok(imgvwr_core::LinearImage {
                width: 2,
                height: 2,
                rgb: vec![0.2; 12],
            })
        }

        fn neutral_at(
            &self,
            _x: f32,
            _y: f32,
            current: WhiteBalance,
        ) -> Result<WhiteBalance, SceneError> {
            Ok(current)
        }
    }

    fn service_with_sensor() -> (tempfile::TempDir, DevelopService) {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(SceneRegistry::new(vec![
            Arc::new(SensorFormat),
            Arc::new(imgvwr_core::ImageCrateFormat::new()),
        ]));
        let svc = DevelopService::new(registry, &dir.path().join("develop.db")).unwrap();
        (dir, svc)
    }

    fn sample(dir: &Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            60,
            40,
            image::Rgb([120, 100, 80]),
        ))
        .save(&path)
        .unwrap();
        path
    }

    #[test]
    fn frame_token_parses_out_of_the_url_the_frontend_builds() {
        // Must stay in step with `developFrameUrl` in src/ipc/index.ts.
        assert_eq!(parse_frame_token("/frame/42"), Some(42));
    }

    #[test]
    fn frame_token_parsing_rejects_junk() {
        assert_eq!(parse_frame_token("/frame/not-a-number"), None);
        assert_eq!(parse_frame_token("/"), None);
        assert_eq!(parse_frame_token(""), None);
        assert_eq!(parse_frame_token("/frame/7/"), Some(7));
    }

    #[test]
    fn sensor_pixels_open_with_a_look_and_a_rendered_file_opens_untouched() {
        let (dir, svc) = service_with_sensor();

        // Nothing is stored for either, so both report their opening state.
        let raw_like = dir.path().join("frame.sensor");
        std::fs::write(&raw_like, b"pretend sensor data").unwrap();
        let opened = svc.state(raw_like.to_str().unwrap()).unwrap();
        assert!(
            !opened.settings.params.is_identity(),
            "a flat decode should open with the default look, not flat"
        );
        assert!(!opened.edited, "opening with a look is not an edit");
        // The look is tone and colour only; the balance stays the camera's.
        assert_eq!(opened.settings.white_balance, opened.as_shot);

        let rendered = sample(dir.path(), "already.png");
        let untouched = svc.state(rendered.to_str().unwrap()).unwrap();
        assert!(
            untouched.settings.params.is_identity(),
            "a finished JPEG already has somebody's look; applying one would double it"
        );
    }

    #[test]
    fn a_stored_edit_beats_the_opening_look() {
        let (dir, svc) = service_with_sensor();
        let raw_like = dir.path().join("frame.sensor");
        std::fs::write(&raw_like, b"pretend sensor data").unwrap();
        let path = raw_like.to_str().unwrap();

        let mine = DevelopSettings {
            white_balance: WhiteBalance { temperature: 5200.0, tint: -3.0 },
            params: DevelopParams { exposure: -0.4, ..Default::default() },
            basis: imgvwr_develop::presets::NONE.to_owned(),
            crop: imgvwr_develop::Crop::FULL,
        };
        svc.save_settings(path, &mine).unwrap();

        let state = svc.state(path).unwrap();
        assert!(state.edited);
        assert_eq!(state.settings, mine, "the default must not overwrite a real edit");
    }

    #[test]
    fn a_crop_changes_what_is_rendered_and_survives_the_database() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "c.png");
        let path = path.to_str().unwrap();

        let whole = svc
            .render(path, &DevelopSettings::neutral(WhiteBalance::D65), 60, Overlay::None, Region::FULL)
            .unwrap();
        assert_eq!((whole.width, whole.height), (60, 40));

        // Half the width, a quarter of the height: the rendered frame is the
        // crop, not the frame with the crop drawn on it.
        let cropped_settings = DevelopSettings {
            crop: imgvwr_develop::Crop { x: 0.25, y: 0.25, width: 0.5, height: 0.25, angle: 0.0 },
            ..DevelopSettings::neutral(WhiteBalance::D65)
        };
        let cropped = svc
            .render(path, &cropped_settings, 60, Overlay::None, Region::FULL)
            .unwrap();
        assert_eq!((cropped.width, cropped.height), (30, 10));

        svc.save_settings(path, &cropped_settings).unwrap();
        let stored = svc.stored_settings(path).unwrap().unwrap();
        assert_eq!(stored.crop, cropped_settings.crop);
    }

    #[test]
    fn a_straightened_crop_still_renders_at_the_size_asked_for() {
        // The failure this guards: a rotated crop needs a patch bigger than
        // itself, and asking the plugin for that patch at max_edge would
        // leave the crop short of it — resolution quietly lost the further
        // the picture is straightened.
        let (dir, svc) = service();
        let path = sample(dir.path(), "s.png");
        let path = path.to_str().unwrap();

        let turned = DevelopSettings {
            crop: imgvwr_develop::Crop { x: 0.2, y: 0.2, width: 0.6, height: 0.6, angle: 8.0 },
            ..DevelopSettings::neutral(WhiteBalance::D65)
        };
        let frame = svc.render(path, &turned, 30, Overlay::None, Region::FULL).unwrap();
        // 0.6 of a 60x40 frame is 36x24, held to a 30px long edge -> 30x20.
        assert_eq!((frame.width, frame.height), (30, 20));
    }

    #[test]
    fn the_roll_off_slider_survives_a_round_trip_through_the_database() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "r.png");
        let path = path.to_str().unwrap();
        let settings = DevelopSettings {
            white_balance: WhiteBalance { temperature: 6000.0, tint: 0.0 },
            params: DevelopParams { rolloff: 83.0, ..Default::default() },
            basis: imgvwr_develop::presets::NONE.to_owned(),
            crop: imgvwr_develop::Crop::FULL,
        };
        svc.save_settings(path, &settings).unwrap();
        assert_eq!(svc.stored_settings(path).unwrap().unwrap().params.rolloff, 83.0);
    }

    #[test]
    fn an_untouched_image_reports_neutral_settings() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "a.png");
        let path = path.to_str().unwrap();

        let state = svc.state(path).unwrap();
        assert_eq!((state.width, state.height), (60, 40));
        assert!(!state.edited);
        assert!(state.settings.params.is_identity());
        assert!(!state.needs_render, "a PNG displays natively");
    }

    #[test]
    fn settings_round_trip_through_the_database() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "b.png");
        let path = path.to_str().unwrap();

        let edit = DevelopSettings {
            white_balance: WhiteBalance {
                temperature: 4200.0,
                tint: -12.0,
            },
            params: DevelopParams {
                exposure: 1.25,
                contrast: 30.0,
                ..Default::default()
            },
            basis: imgvwr_develop::presets::NONE.to_owned(),
            crop: imgvwr_develop::Crop::FULL,
        };
        svc.save_settings(path, &edit).unwrap();

        let state = svc.state(path).unwrap();
        assert!(state.edited);
        assert!((state.settings.params.exposure - 1.25).abs() < 1e-5);
        assert!((state.settings.white_balance.temperature - 4200.0).abs() < 1e-3);

        // Saving again updates in place rather than failing the primary key.
        svc.save_settings(path, &DevelopSettings::neutral(WhiteBalance::D65))
            .unwrap();
        assert!(svc.state(path).unwrap().settings.params.is_identity());

        svc.clear_settings(path).unwrap();
        assert!(!svc.state(path).unwrap().edited);
    }

    #[test]
    fn out_of_range_stored_settings_are_clamped_on_read() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "c.png");
        let path = path.to_str().unwrap();
        svc.save_settings(
            path,
            &DevelopSettings {
                white_balance: WhiteBalance {
                    temperature: 1e9,
                    tint: 0.0,
                },
                params: DevelopParams {
                    exposure: 99.0,
                    ..Default::default()
                },
                basis: imgvwr_develop::presets::NONE.to_owned(),
                crop: imgvwr_develop::Crop::FULL,
            },
        )
        .unwrap();
        let stored = svc.stored_settings(path).unwrap().unwrap();
        assert_eq!(stored.params.exposure, 5.0);
        assert_eq!(stored.white_balance.temperature, 25000.0);
    }

    #[test]
    fn rendering_produces_an_addressable_frame() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "d.png");
        let path = path.to_str().unwrap();

        let frame = svc
            .render(
                path,
                &DevelopSettings::neutral(WhiteBalance::D65),
                30,
                Overlay::None,
                Region::FULL,
            )
            .unwrap();
        assert_eq!((frame.width, frame.height), (30, 20));
        assert_eq!(frame.histogram.luma.len(), 256);

        let bytes = svc.frame(frame.token).expect("frame is addressable");
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "JPEG magic");
        // Fetching does not consume it: the webview may load the URL twice.
        assert!(svc.frame(frame.token).is_some());
    }

    #[test]
    fn every_render_gets_a_fresh_token_so_the_webview_cannot_serve_a_stale_edit() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "e.png");
        let path = path.to_str().unwrap();
        let neutral = DevelopSettings::neutral(WhiteBalance::D65);

        let first = svc.render(path, &neutral, 30, Overlay::None, Region::FULL).unwrap();
        let second = svc.render(path, &neutral, 30, Overlay::None, Region::FULL).unwrap();
        assert_ne!(first.token, second.token);
    }

    #[test]
    fn old_frames_are_evicted_but_recent_ones_survive_a_drag() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "f.png");
        let path = path.to_str().unwrap();

        // Small frames, of which a great many fit in the budget: a drag must
        // not cost the caller the frame it is showing.
        let mut tokens = Vec::new();
        for i in 0..200 {
            tokens.push(render_at(&svc, path, i, 30).token);
        }
        assert!(svc.frame(tokens[0]).is_some(), "a drag's worth all still here");
        assert!(svc.frame(*tokens.last().unwrap()).is_some(), "newest kept");
    }

    #[test]
    fn a_stream_of_small_frames_does_not_evict_the_one_on_screen() {
        // The loupe, dragged. It renders a small square per movement, and the
        // photograph behind it is one large frame that must survive all of
        // them — counting slots rather than bytes is what broke this, and the
        // canvas went black under a working loupe.
        let (dir, svc) = service();
        let path = sample(dir.path(), "f.png");
        let path = path.to_str().unwrap();

        let showing = render_at(&svc, path, 0, 400).token;
        for i in 1..200 {
            render_at(&svc, path, i, 24);
        }
        assert!(svc.frame(showing).is_some(), "the frame on screen survived the drag");
    }

    #[test]
    fn the_budget_bounds_what_is_held_and_the_floor_bounds_the_budget() {
        let mut frames: VecDeque<(u64, Vec<u8>)> =
            (0..20).map(|i| (i, vec![0u8; 100])).collect();
        evict_past(&mut frames, 550);
        let held: usize = frames.iter().map(|(_, b)| b.len()).sum();
        assert!(held <= 550, "held {held}");
        assert_eq!(frames.back().map(|(t, _)| *t), Some(19), "newest kept");

        // One frame larger than the whole budget must not empty the ring: an
        // empty ring means every warmed neighbour developed again from scratch.
        let mut huge: VecDeque<(u64, Vec<u8>)> =
            (0..6).map(|i| (i, vec![0u8; 10_000])).collect();
        evict_past(&mut huge, 1);
        assert_eq!(huge.len(), FRAMES_KEPT);
    }

    /// One render, distinguishable from the last by its exposure.
    fn render_at(svc: &DevelopService, path: &str, nth: usize, max_edge: u32) -> DevelopFrame {
        svc.render(
            path,
            &DevelopSettings {
                white_balance: WhiteBalance::D65,
                params: DevelopParams {
                    exposure: nth as f32 * 0.01,
                    ..Default::default()
                },
                basis: imgvwr_develop::presets::NONE.to_owned(),
                crop: imgvwr_develop::Crop::FULL,
            },
            max_edge,
            Overlay::None,
            Region::FULL,
        )
        .unwrap()
    }

    #[test]
    fn export_writes_at_full_resolution() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "g.png");
        let path = path.to_str().unwrap();
        let dest = dir.path().join("exported.jpg");

        svc.export(
            path,
            &DevelopSettings {
                white_balance: WhiteBalance::D65,
                params: DevelopParams {
                    exposure: 0.5,
                    ..Default::default()
                },
                basis: imgvwr_develop::presets::NONE.to_owned(),
                crop: imgvwr_develop::Crop::FULL,
            },
            &dest,
        )
        .unwrap();

        let written = image::open(&dest).unwrap();
        assert_eq!((written.width(), written.height()), (60, 40));
    }

    #[test]
    fn export_honours_a_png_destination() {
        let (dir, svc) = service();
        let path = sample(dir.path(), "h.png");
        let dest = dir.path().join("exported.png");
        svc.export(
            path.to_str().unwrap(),
            &DevelopSettings::neutral(WhiteBalance::D65),
            &dest,
        )
        .unwrap();
        assert_eq!(
            image::ImageReader::open(&dest).unwrap().format(),
            Some(image::ImageFormat::Png)
        );
    }

    #[test]
    fn edited_paths_reports_only_stored_ones() {
        let (dir, svc) = service();
        let a = sample(dir.path(), "i.png");
        let b = sample(dir.path(), "j.png");
        let (a, b) = (a.to_str().unwrap(), b.to_str().unwrap());

        svc.save_settings(a, &DevelopSettings::neutral(WhiteBalance::D65))
            .unwrap();
        let edited = svc
            .edited_paths(&[a.to_string(), b.to_string()])
            .unwrap();
        assert_eq!(edited, vec![a.to_string()]);
    }

    #[test]
    fn unsupported_files_are_reported_not_opened() {
        let (dir, svc) = service();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(svc.state(path.to_str().unwrap()).is_err());
    }

    #[test]
    fn a_raw_file_is_not_claimed_by_the_plain_image_plugin() {
        // The registry in these tests holds only the image-crate plugin, so a
        // TIFF-container raw file must fall through rather than being claimed
        // and then failing to decode — the bug that made NEF thumbnails fail.
        let (dir, svc) = service();
        let path = dir.path().join("DSC_0008.NEF");
        std::fs::write(&path, [0x49u8, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0]).unwrap();
        let error = svc.state(path.to_str().unwrap()).unwrap_err();
        assert!(
            error.contains("no develop plugin"),
            "expected an unsupported-format error, got: {error}"
        );
    }
}
