//! On-disk vector cache shared by embeddings and faces.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// A drop guard, not a hand-cleared flag: every way out of the pass — early return, panic — clears it.
pub struct IndexingPass<'a>(pub &'a AtomicBool);

impl Drop for IndexingPass<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `dim` rejects a stale schema or truncated write; `None` accepts any whole number of floats.
pub fn read_vector(file: &Path, dim: Option<usize>) -> Option<Vec<f32>> {
    let bytes = std::fs::read(file).ok()?;
    let valid = match dim {
        Some(d) => bytes.len() == d * 4,
        None => !bytes.is_empty() && bytes.len() % 4 == 0,
    };
    if !valid {
        return None;
    }
    Some(
        bytes
            .as_chunks::<4>().0.iter()
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

pub fn write_vector(file: &Path, v: &[f32]) -> std::io::Result<()> {
    // macOS may purge ~/Library/Caches while the app runs — recreate rather than fail every write.
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for x in v {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    let tmp = file.with_extension("vec.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, file)
}
