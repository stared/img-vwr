use super::*;

fn service() -> (tempfile::TempDir, DevelopService) {
    let dir = tempfile::tempdir().unwrap();
    let registry = Arc::new(SceneRegistry::new(vec![Arc::new(
        imgvwr_core::ImageCrateFormat::new(),
    )]));
    let svc = DevelopService::new(registry, &dir.path().join("develop.db")).unwrap();
    (dir, svc)
}

/// A raw-plugin stand-in: scene-referred pixels without a raw file, platform decoder, or demosaic.
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

    let raw_like = dir.path().join("frame.sensor");
    std::fs::write(&raw_like, b"pretend sensor data").unwrap();
    let opened = svc.state(raw_like.to_str().unwrap()).unwrap();
    assert_eq!(
        opened.settings.look,
        imgvwr_develop::CAMERA,
        "sensor pixels should open under the camera-jpeg look, not flat"
    );
    assert!(
        opened.settings.params.is_identity(),
        "the look lives in the look, not in pre-moved sliders"
    );
    assert!(!opened.edited, "opening with a look is not an edit");
    // The look is tone and colour only; the balance stays the camera's.
    assert_eq!(opened.settings.white_balance, opened.as_shot);

    let rendered = sample(dir.path(), "already.png");
    let untouched = svc.state(rendered.to_str().unwrap()).unwrap();
    assert_eq!(
        untouched.settings.look,
        imgvwr_develop::presets::NONE,
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
        look: imgvwr_develop::presets::NONE.to_owned(),
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

    // The rendered frame is the crop itself, not the frame with the crop drawn on it.
    let cropped_settings = DevelopSettings {
        crop: imgvwr_develop::Crop { x: 0.25, y: 0.25, width: 0.5, height: 0.25, ..imgvwr_develop::Crop::FULL },
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
    // Guards: a rotated crop needs a patch bigger than itself, or resolution is quietly lost as it straightens.
    let (dir, svc) = service();
    let path = sample(dir.path(), "s.png");
    let path = path.to_str().unwrap();

    let turned = DevelopSettings {
        crop: imgvwr_develop::Crop { x: 0.2, y: 0.2, width: 0.6, height: 0.6, angle: 8.0, ..imgvwr_develop::Crop::FULL },
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
        look: imgvwr_develop::presets::NONE.to_owned(),
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
        look: imgvwr_develop::presets::NONE.to_owned(),
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
            look: imgvwr_develop::presets::NONE.to_owned(),
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

    // Many small frames fit the budget: a drag must not cost the frame being shown.
    let mut tokens = Vec::new();
    for i in 0..200 {
        tokens.push(render_at(&svc, path, i, 30).token);
    }
    assert!(svc.frame(tokens[0]).is_some(), "a drag's worth all still here");
    assert!(svc.frame(*tokens.last().unwrap()).is_some(), "newest kept");
}

#[test]
fn a_stream_of_small_frames_does_not_evict_the_one_on_screen() {
    // Guards: counting slots instead of bytes let a loupe drag evict the on-screen frame.
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

    // One frame larger than the whole budget must not empty the ring.
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
            look: imgvwr_develop::presets::NONE.to_owned(),
            crop: imgvwr_develop::Crop::FULL,
        },
        max_edge,
        Overlay::None,
        Region::FULL,
    )
    .unwrap()
}

fn plan(dir: &Path, format: ExportFormat, size: crate::services::export::ExportSize) -> ExportPlan {
    ExportPlan {
        folder: dir.to_str().unwrap().to_string(),
        format,
        size,
    }
}

#[test]
fn export_writes_at_full_resolution() {
    use crate::services::export::{ExifSource, ExportSize};
    let (dir, svc) = service();
    let path = sample(dir.path(), "g.png");
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();

    let exported = svc
        .export(
            &ExportJob::Render {
                path: path.to_str().unwrap().to_string(),
                exif: ExifSource::None,
            },
            &plan(&out, ExportFormat::Jpeg { quality: 92 }, ExportSize::Full),
        )
        .unwrap();

    assert!(!exported.copied);
    let written = image::open(&exported.path).unwrap();
    assert_eq!((written.width(), written.height()), (60, 40));
}

#[test]
fn export_honours_a_png_plan_and_a_size_limit() {
    use crate::services::export::{ExifSource, ExportSize};
    let (dir, svc) = service();
    let path = sample(dir.path(), "h.png");
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();

    let exported = svc
        .export(
            &ExportJob::Render {
                path: path.to_str().unwrap().to_string(),
                exif: ExifSource::None,
            },
            &plan(&out, ExportFormat::Png, ExportSize::Longest { pixels: 30 }),
        )
        .unwrap();

    assert!(exported.path.ends_with("h.png"));
    let written = image::ImageReader::open(&exported.path).unwrap();
    assert_eq!(written.format(), Some(image::ImageFormat::Png));
    assert_eq!(written.decode().unwrap().width(), 30);
}

#[test]
fn a_copy_job_never_opens_the_pipeline() {
    use crate::services::export::ExportSize;
    let (dir, svc) = service();
    let img = image::RgbImage::from_pixel(24, 16, image::Rgb([10, 20, 30]));
    let source = dir.path().join("DSC_1234.JPG");
    img.save(&source).unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir(&out).unwrap();

    let exported = svc
        .export(
            &ExportJob::Copy {
                path: source.to_str().unwrap().to_string(),
            },
            &plan(&out, ExportFormat::Jpeg { quality: 90 }, ExportSize::Full),
        )
        .unwrap();

    assert!(exported.copied);
    assert_eq!(
        std::fs::read(&exported.path).unwrap(),
        std::fs::read(&source).unwrap()
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
    // A TIFF-container raw must fall through, not be claimed by the image plugin — the bug that broke NEF thumbnails.
    let (dir, svc) = service();
    let path = dir.path().join("DSC_0008.NEF");
    std::fs::write(&path, [0x49u8, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0]).unwrap();
    let error = svc.state(path.to_str().unwrap()).unwrap_err();
    assert!(
        error.contains("no develop plugin"),
        "expected an unsupported-format error, got: {error}"
    );
}
