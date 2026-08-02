/// Bump when the thumbnail format/quality changes, or when what a thumbnail
/// *depicts* changes, so old cache entries are ignored.
///
/// 2: raw thumbnails render with the look a raw file now opens with, rather
/// than the flat decode, so every cached one is a picture of the old rule.
pub const CACHE_SCHEMA_VERSION: u32 = 2;

/// Content-addressed thumbnail cache key. Any change to the source file
/// (mtime or size) or to the thumbnail parameters yields a new key, so
/// invalidation is automatic and stale files are simply never read again.
pub fn thumb_cache_key(canonical_path: &str, mtime_ms: u64, size: u64, max_edge: u32) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(canonical_path.as_bytes());
    hasher.update(&mtime_ms.to_le_bytes());
    hasher.update(&size.to_le_bytes());
    hasher.update(&max_edge.to_le_bytes());
    hasher.update(&CACHE_SCHEMA_VERSION.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: (&str, u64, u64, u32) = ("/a/b.png", 1_000, 42, 256);

    fn base() -> String {
        thumb_cache_key(KEY.0, KEY.1, KEY.2, KEY.3)
    }

    #[test]
    fn same_inputs_same_key() {
        assert_eq!(base(), base());
    }

    #[test]
    fn each_input_perturbs_the_key() {
        assert_ne!(base(), thumb_cache_key("/a/c.png", KEY.1, KEY.2, KEY.3));
        assert_ne!(base(), thumb_cache_key(KEY.0, KEY.1 + 1, KEY.2, KEY.3));
        assert_ne!(base(), thumb_cache_key(KEY.0, KEY.1, KEY.2 + 1, KEY.3));
        assert_ne!(base(), thumb_cache_key(KEY.0, KEY.1, KEY.2, 512));
    }

    #[test]
    fn key_is_a_filename_safe_hex_string() {
        let key = base();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
