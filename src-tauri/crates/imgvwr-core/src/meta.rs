use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExifSubset {
    pub orientation: u32,
    pub date_time: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    /// The exposure, as a photographer states it. Kept as numbers rather than
    /// as the camera's own strings so they can be compared, filtered and
    /// sorted — formatting for display is the frontend's business, and "1/200"
    /// is a rendering of 0.005, not a fact about the photograph.
    pub exposure_time: Option<f64>,
    pub f_number: Option<f64>,
    pub iso: Option<u32>,
    /// Millimetres, as marked on the lens.
    pub focal_length: Option<f64>,
    /// Decimal degrees; positive = north/east.
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    /// None when no Rust decoder knows the format (e.g. AVIF) — the webview
    /// can still measure the image it renders natively.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: String,
    pub file_size: u64,
    pub modified_ms: u64,
    pub exif: Option<ExifSubset>,
}

/// Header-only metadata read: image dimensions without a full decode, plus a
/// small EXIF subset. Never fails on undecodable pixels — fields degrade to None.
pub fn read_meta(path: &Path) -> std::io::Result<ImageMeta> {
    let fs_meta = std::fs::metadata(path)?;
    let modified_ms = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let dims = image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok());

    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    Ok(ImageMeta {
        width: dims.map(|(w, _)| w),
        height: dims.map(|(_, h)| h),
        format,
        file_size: fs_meta.len(),
        modified_ms,
        exif: read_exif(path),
    })
}

/// Per-shot rendering decisions the camera wrote into the file.
///
/// Nikon embeds an XMP packet near the start of every NEF with its Auto
/// Picture Control choices translated into Adobe terms (`crd:Contrast2012`
/// and friends vary shot by shot), and the standard EXIF exposure fields
/// say how the meter treated the scene. Together they are direct inputs to
/// the camera-look tuning predictor — the camera telling us what it did,
/// rather than us guessing from pixels.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CameraDecisions {
    pub contrast: Option<f64>,
    pub saturation: Option<f64>,
    pub clarity: Option<f64>,
    pub texture: Option<f64>,
    pub sharpness: Option<f64>,
    pub luminance_smoothing: Option<f64>,
    pub exposure_compensation: Option<f64>,
    pub gain_control: Option<f64>,
    pub exposure_program: Option<f64>,
    /// log2(N²/t · 100/ISO) — the metered scene brightness.
    pub light_value: Option<f64>,
}

/// The camera's per-shot decisions, from the XMP packet and EXIF.
///
/// The XMP packet sits in the first kilobytes of the file as plain XML, so
/// a byte scan of the head is enough — no TIFF walking, no maker-note
/// decryption. Fields degrade to None when absent.
pub fn read_camera_decisions(path: &Path) -> CameraDecisions {
    let head = read_head(path, 256 * 1024).unwrap_or_default();
    let xmp = |name: &str| xmp_number(&head, name);

    let mut d = CameraDecisions {
        contrast: xmp("Contrast2012"),
        saturation: xmp("Saturation"),
        clarity: xmp("Clarity2012"),
        texture: xmp("Texture"),
        sharpness: xmp("Sharpness"),
        luminance_smoothing: xmp("LuminanceSmoothing"),
        ..Default::default()
    };

    if let Some(file) = File::open(path).ok() {
        if let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) {
            let signed = |tag: exif::Tag| {
                exif.get_field(tag, exif::In::PRIMARY).and_then(|f| match &f.value {
                    exif::Value::SRational(p) => p.first().map(|r| r.to_f64()),
                    exif::Value::Rational(p) => p.first().map(|r| r.to_f64()),
                    _ => None,
                })
            };
            let uint = |tag: exif::Tag| {
                exif.get_field(tag, exif::In::PRIMARY)
                    .and_then(|f| f.value.get_uint(0))
                    .map(f64::from)
            };
            d.exposure_compensation = signed(exif::Tag::ExposureBiasValue);
            d.gain_control = uint(exif::Tag::GainControl);
            d.exposure_program = uint(exif::Tag::ExposureProgram);
            let t = signed(exif::Tag::ExposureTime).filter(|v| *v > 0.0);
            let n = signed(exif::Tag::FNumber).filter(|v| *v > 0.0);
            let iso = exif
                .get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
                .map(f64::from)
                .filter(|v| *v > 0.0);
            if let (Some(t), Some(n), Some(iso)) = (t, n, iso) {
                d.light_value = Some((n * n / t * 100.0 / iso).log2());
            }
        }
    }
    d
}

fn read_head(path: &Path, len: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = vec![0u8; len];
    let mut file = File::open(path)?;
    let n = file.read(&mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

/// `<crd:Name>value</crd:Name>` from the XMP bytes, if present and numeric.
fn xmp_number(head: &[u8], name: &str) -> Option<f64> {
    let open = format!("<crd:{name}>");
    let close = format!("</crd:{name}>");
    let start = head
        .windows(open.len())
        .position(|w| w == open.as_bytes())?
        + open.len();
    let rest = &head[start..];
    let end = rest.windows(close.len()).position(|w| w == close.as_bytes())?;
    std::str::from_utf8(&rest[..end]).ok()?.trim().parse().ok()
}

fn read_exif(path: &Path) -> Option<ExifSubset> {
    let file = File::open(path).ok()?;
    let data = exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()?;

    let field_string = |tag: exif::Tag| {
        data.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string().trim_matches('"').to_owned())
    };

    let rational = |tag: exif::Tag| {
        data.get_field(tag, exif::In::PRIMARY)
            .and_then(|f| match &f.value {
                exif::Value::Rational(parts) => parts.first().map(|r| r.to_f64()),
                exif::Value::SRational(parts) => parts.first().map(|r| r.to_f64()),
                _ => None,
            })
            .filter(|v| v.is_finite() && *v > 0.0)
    };

    Some(ExifSubset {
        orientation: data
            .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
            .unwrap_or(1),
        date_time: field_string(exif::Tag::DateTimeOriginal).or_else(|| field_string(exif::Tag::DateTime)),
        camera: field_string(exif::Tag::Model),
        lens: field_string(exif::Tag::LensModel).and_then(|s| clean_lens(&s)),
        exposure_time: rational(exif::Tag::ExposureTime),
        f_number: rational(exif::Tag::FNumber),
        // The modern tag, falling back to the one film-era cameras wrote.
        iso: data
            .get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY)
            .or_else(|| data.get_field(exif::Tag::ISOSpeed, exif::In::PRIMARY))
            .and_then(|f| f.value.get_uint(0)),
        focal_length: rational(exif::Tag::FocalLength),
        gps_lat: gps_coord(&data, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, 90.0),
        gps_lon: gps_coord(&data, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, 180.0),
    })
}

/// The lens name, without the padding the camera wrote after it.
///
/// Nikon writes LensModel as a fixed-width array, so `display_value` renders
/// `"NIKKOR Z 50mm f/1.8 S", "", "", ""` — forty-odd empty strings after the
/// name. Printed verbatim that fills a panel with quotes and commas.
fn clean_lens(raw: &str) -> Option<String> {
    let name = raw
        .split(',')
        .map(|part| part.trim().trim_matches('"').trim())
        .find(|part| !part.is_empty())?;
    Some(name.to_owned())
}

/// One GPS coordinate as decimal degrees, negative for S/W. None when the
/// tags are missing or the value is malformed (zero denominators, out of range).
fn gps_coord(data: &exif::Exif, value_tag: exif::Tag, ref_tag: exif::Tag, max: f64) -> Option<f64> {
    let field = data.get_field(value_tag, exif::In::PRIMARY)?;
    let dms = match &field.value {
        exif::Value::Rational(parts) => parts.as_slice(),
        _ => return None,
    };
    let reference = data
        .get_field(ref_tag, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();
    dms_to_degrees(dms, &reference, max)
}

fn dms_to_degrees(dms: &[exif::Rational], reference: &str, max: f64) -> Option<f64> {
    let part = |i: usize| dms.get(i).map(|r| r.to_f64()).unwrap_or(0.0);
    if dms.is_empty() {
        return None;
    }
    let degrees = part(0) + part(1) / 60.0 + part(2) / 3600.0;
    if !degrees.is_finite() || degrees > max {
        return None;
    }
    let sign = if reference.contains('S') || reference.contains('W') {
        -1.0
    } else {
        1.0
    };
    Some(sign * degrees)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dimensions_without_full_decode() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("img.png");
        image::DynamicImage::new_rgb8(320, 200).save(&path).unwrap();

        let meta = read_meta(&path).unwrap();
        assert_eq!((meta.width, meta.height), (Some(320), Some(200)));
        assert_eq!(meta.format, "png");
        assert!(meta.file_size > 0);
    }

    #[test]
    fn a_padded_lens_name_loses_its_padding() {
        // Nikon writes LensModel as a fixed-width array, so the display value
        // is the name followed by forty-odd empty strings.
        let padded = r#""NIKKOR Z 50mm f/1.8 S", "", "", "", """#;
        assert_eq!(clean_lens(padded).as_deref(), Some("NIKKOR Z 50mm f/1.8 S"));
        assert_eq!(clean_lens(r#""50mm""#).as_deref(), Some("50mm"));
        assert_eq!(clean_lens(r#""", """#), None, "nothing but padding is no lens");
        assert_eq!(clean_lens(""), None);
    }

    #[test]
    fn dms_conversion_signs_and_validation() {
        let r = |num: u32, denom: u32| exif::Rational { num, denom };
        let krakow = [r(50, 1), r(3, 1), r(4140, 100)];
        let lat = dms_to_degrees(&krakow, "N", 90.0).unwrap();
        assert!((lat - 50.0615).abs() < 1e-4);
        assert!(dms_to_degrees(&krakow, "S", 90.0).unwrap() < 0.0);
        // Zero denominator → infinite degrees → rejected, as is out-of-range.
        assert_eq!(dms_to_degrees(&[r(1, 0)], "N", 90.0), None);
        assert_eq!(dms_to_degrees(&[r(91, 1)], "N", 90.0), None);
        assert_eq!(dms_to_degrees(&[], "N", 90.0), None);
    }

    #[test]
    fn xmp_numbers_come_out_of_the_packet_bytes() {
        let head = br#"<rdf:Description xmlns:crd="..."><crd:Contrast2012>-6</crd:Contrast2012><crd:Saturation>2</crd:Saturation><crd:Clarity2012>5</crd:Clarity2012><crd:CameraProfile>Camera Standard</crd:CameraProfile></rdf:Description>"#;
        assert_eq!(xmp_number(head, "Contrast2012"), Some(-6.0));
        assert_eq!(xmp_number(head, "Saturation"), Some(2.0));
        assert_eq!(xmp_number(head, "Clarity2012"), Some(5.0));
        assert_eq!(xmp_number(head, "Texture"), None, "absent field is None");
        assert_eq!(xmp_number(head, "CameraProfile"), None, "non-numeric is None");
    }

    #[test]
    fn camera_decisions_degrade_to_none_on_non_camera_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("img.png");
        image::DynamicImage::new_rgb8(4, 4).save(&path).unwrap();
        assert_eq!(read_camera_decisions(&path), CameraDecisions::default());
    }

    #[test]
    fn degrades_gracefully_on_undecodable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("img.avif");
        std::fs::write(&path, b"pretend avif").unwrap();

        let meta = read_meta(&path).unwrap();
        assert_eq!(meta.width, None);
        assert_eq!(meta.format, "avif");
        assert!(meta.exif.is_none());
    }
}
