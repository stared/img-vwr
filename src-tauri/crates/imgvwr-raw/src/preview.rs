//! The camera's own JPEG, dug out of a raw file.
//!
//! A NEF is a TIFF: IFD0 carries a SubIFDs list, and the camera stores a
//! full-size JPEG rendering in one of them as the classic
//! JPEGInterchangeFormat offset/length pair. This walker reads just enough
//! TIFF to find the largest such JPEG — the fallback picture for the rare
//! file whose raw decode fails outright (pixel-shift brackets defeat the
//! system decoder while their embedded JPEG is perfectly fine).

use std::path::Path;

/// The largest embedded JPEG in a TIFF-shaped raw file, if any.
pub fn embedded_jpeg(path: &Path) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    let le = match data.get(0..4)? {
        [0x49, 0x49, 42, 0] => true,
        [0x4d, 0x4d, 0, 42] => false,
        _ => return None,
    };
    let u16_at = |off: usize| -> Option<u16> {
        let b = data.get(off..off + 2)?;
        Some(if le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |off: usize| -> Option<u32> {
        let b = data.get(off..off + 4)?;
        Some(if le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };

    // Walk IFD0's chain plus every SubIFD it lists; collect every
    // JPEGInterchangeFormat pair and keep the largest.
    let mut queue: Vec<u32> = vec![u32_at(4)?];
    let mut seen = std::collections::HashSet::new();
    let mut best: Option<(u32, u32)> = None;
    while let Some(ifd) = queue.pop() {
        if ifd == 0 || !seen.insert(ifd) || seen.len() > 64 {
            continue;
        }
        let ifd = ifd as usize;
        let Some(count) = u16_at(ifd) else { continue };
        let mut jpeg_off = None;
        let mut jpeg_len = None;
        for i in 0..count as usize {
            let e = ifd + 2 + i * 12;
            let (Some(tag), Some(typ), Some(n), Some(value)) =
                (u16_at(e), u16_at(e + 2), u32_at(e + 4), u32_at(e + 8))
            else {
                continue;
            };
            match tag {
                0x014a => {
                    // SubIFDs: inline when it fits, else an offset array.
                    if n == 1 {
                        queue.push(value);
                    } else if typ == 4 {
                        for k in 0..n.min(16) as usize {
                            if let Some(v) = u32_at(value as usize + k * 4) {
                                queue.push(v);
                            }
                        }
                    }
                }
                0x0201 => jpeg_off = Some(value),
                0x0202 => jpeg_len = Some(value),
                _ => {}
            }
        }
        if let (Some(off), Some(len)) = (jpeg_off, jpeg_len) {
            if best.map(|(_, l)| len > l).unwrap_or(true) {
                best = Some((off, len));
            }
        }
        // The next IFD in the chain (IFD1 is where TIFF thumbnails live).
        if let Some(next) = u32_at(ifd + 2 + count as usize * 12) {
            queue.push(next);
        }
    }

    let (off, len) = best?;
    let bytes = data.get(off as usize..(off as usize).checked_add(len as usize)?)?;
    // Only a real JPEG counts.
    if bytes.get(0..2) != Some(&[0xff, 0xd8]) {
        return None;
    }
    Some(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal little-endian TIFF: IFD0 with a SubIFDs entry pointing at
    /// one sub-IFD that carries a (fake) JPEG at a known offset.
    #[test]
    fn finds_the_jpeg_behind_a_subifd() {
        let mut d = vec![0u8; 256];
        d[0..4].copy_from_slice(&[0x49, 0x49, 42, 0]);
        d[4..8].copy_from_slice(&8u32.to_le_bytes()); // IFD0 at 8
        // IFD0: 1 entry (SubIFDs -> 64), next = 0
        d[8..10].copy_from_slice(&1u16.to_le_bytes());
        let e = 10;
        d[e..e + 2].copy_from_slice(&0x014au16.to_le_bytes());
        d[e + 2..e + 4].copy_from_slice(&4u16.to_le_bytes());
        d[e + 4..e + 8].copy_from_slice(&1u32.to_le_bytes());
        d[e + 8..e + 12].copy_from_slice(&64u32.to_le_bytes());
        // SubIFD at 64: 2 entries (0x0201 offset=128, 0x0202 len=4), next 0
        d[64..66].copy_from_slice(&2u16.to_le_bytes());
        let s = 66;
        d[s..s + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        d[s + 2..s + 4].copy_from_slice(&4u16.to_le_bytes());
        d[s + 4..s + 8].copy_from_slice(&1u32.to_le_bytes());
        d[s + 8..s + 12].copy_from_slice(&128u32.to_le_bytes());
        let s2 = s + 12;
        d[s2..s2 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        d[s2 + 2..s2 + 4].copy_from_slice(&4u16.to_le_bytes());
        d[s2 + 4..s2 + 8].copy_from_slice(&1u32.to_le_bytes());
        d[s2 + 8..s2 + 12].copy_from_slice(&4u32.to_le_bytes());
        d[128..132].copy_from_slice(&[0xff, 0xd8, 0xff, 0xd9]);

        let tmp = std::env::temp_dir().join("imgvwr_preview_test.tif");
        std::fs::write(&tmp, &d).unwrap();
        let got = embedded_jpeg(&tmp).expect("finds jpeg");
        assert_eq!(got, vec![0xff, 0xd8, 0xff, 0xd9]);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn a_non_tiff_yields_nothing() {
        let tmp = std::env::temp_dir().join("imgvwr_preview_test2.bin");
        std::fs::write(&tmp, b"not a tiff at all").unwrap();
        assert!(embedded_jpeg(&tmp).is_none());
        std::fs::remove_file(&tmp).ok();
    }
}
