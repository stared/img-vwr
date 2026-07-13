use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

/// User labels for one image. `stars` is genuinely absent until rated;
/// `tags` is the (possibly empty) full set. This is the wire type — the
/// frontend keeps a `path → ImageLabels` map mirroring the database.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageLabels {
    pub stars: Option<u8>,
    pub tags: Vec<String>,
}

/// App-local label store — one SQLite database in the app data dir, keyed
/// by absolute path. Deliberately never writes anywhere near the images:
/// labeling must be zero-risk to the user's files. (XMP export can come
/// later as a command over this same data.)
pub struct LabelService {
    conn: Mutex<Connection>,
}

impl LabelService {
    pub fn new(db_file: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_file)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS stars (
                 path  TEXT PRIMARY KEY,
                 stars INTEGER NOT NULL
             ) STRICT;
             CREATE TABLE IF NOT EXISTS tags (
                 path TEXT NOT NULL,
                 tag  TEXT NOT NULL,
                 PRIMARY KEY (path, tag)
             ) STRICT;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Labels for every path that has any; unlabeled paths are simply absent.
    pub fn for_paths(&self, paths: &[String]) -> Result<HashMap<String, ImageLabels>, String> {
        let conn = self.conn.lock().unwrap();
        let mut out: HashMap<String, ImageLabels> = HashMap::new();
        // Chunk to stay far below SQLite's bound-parameter limit.
        for chunk in paths.chunks(512) {
            let marks = vec!["?"; chunk.len()].join(",");
            let mut stmt = conn
                .prepare(&format!("SELECT path, stars FROM stars WHERE path IN ({marks})"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u8>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (path, stars) = row.map_err(|e| e.to_string())?;
                out.entry(path).or_insert_with(empty_labels).stars = Some(stars);
            }
            let mut stmt = conn
                .prepare(&format!("SELECT path, tag FROM tags WHERE path IN ({marks})"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (path, tag) = row.map_err(|e| e.to_string())?;
                out.entry(path).or_insert_with(empty_labels).tags.push(tag);
            }
        }
        for labels in out.values_mut() {
            labels.tags.sort();
        }
        Ok(out)
    }

    /// Set or clear (None) an image's star rating; returns the full labels.
    pub fn set_stars(&self, path: &str, stars: Option<u8>) -> Result<ImageLabels, String> {
        {
            let conn = self.conn.lock().unwrap();
            match stars {
                Some(n) => conn
                    .execute(
                        "INSERT INTO stars (path, stars) VALUES (?1, ?2)
                         ON CONFLICT(path) DO UPDATE SET stars = ?2",
                        rusqlite::params![path, n],
                    )
                    .map_err(|e| e.to_string())?,
                None => conn
                    .execute("DELETE FROM stars WHERE path = ?1", [path])
                    .map_err(|e| e.to_string())?,
            };
        }
        self.labels_for(path)
    }

    /// Add the tag if absent, remove it if present; returns the full labels.
    pub fn toggle_tag(&self, path: &str, tag: &str) -> Result<ImageLabels, String> {
        {
            let conn = self.conn.lock().unwrap();
            let removed = conn
                .execute(
                    "DELETE FROM tags WHERE path = ?1 AND tag = ?2",
                    rusqlite::params![path, tag],
                )
                .map_err(|e| e.to_string())?;
            if removed == 0 {
                conn.execute(
                    "INSERT INTO tags (path, tag) VALUES (?1, ?2)",
                    rusqlite::params![path, tag],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        self.labels_for(path)
    }

    fn labels_for(&self, path: &str) -> Result<ImageLabels, String> {
        let map = self.for_paths(&[path.to_string()])?;
        Ok(map.into_values().next().unwrap_or_else(empty_labels))
    }
}

fn empty_labels() -> ImageLabels {
    ImageLabels {
        stars: None,
        tags: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tempdir must outlive the service — dropping it deletes the db.
    fn service() -> (tempfile::TempDir, LabelService) {
        let dir = tempfile::tempdir().unwrap();
        let svc = LabelService::new(&dir.path().join("labels.db")).unwrap();
        (dir, svc)
    }

    #[test]
    fn stars_set_update_clear() {
        let (_dir, svc) = service();
        assert_eq!(svc.set_stars("/a.jpg", Some(3)).unwrap().stars, Some(3));
        assert_eq!(svc.set_stars("/a.jpg", Some(5)).unwrap().stars, Some(5));
        assert_eq!(svc.set_stars("/a.jpg", None).unwrap().stars, None);
        // Cleared and never tagged: the image has no labels at all anymore.
        assert!(svc.for_paths(&["/a.jpg".into()]).unwrap().is_empty());
    }

    #[test]
    fn tags_toggle_on_and_off() {
        let (_dir, svc) = service();
        assert_eq!(svc.toggle_tag("/a.jpg", "pair").unwrap().tags, vec!["pair"]);
        let both = svc.toggle_tag("/a.jpg", "family").unwrap();
        assert_eq!(both.tags, vec!["family", "pair"]); // sorted
        assert_eq!(svc.toggle_tag("/a.jpg", "pair").unwrap().tags, vec!["family"]);
    }

    #[test]
    fn for_paths_returns_only_labeled() {
        let (_dir, svc) = service();
        svc.set_stars("/a.jpg", Some(4)).unwrap();
        svc.toggle_tag("/b.jpg", "sea").unwrap();
        let map = svc
            .for_paths(&["/a.jpg".into(), "/b.jpg".into(), "/c.jpg".into()])
            .unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map["/a.jpg"].stars, Some(4));
        assert_eq!(map["/a.jpg"].tags, Vec::<String>::new());
        assert_eq!(map["/b.jpg"].stars, None);
        assert_eq!(map["/b.jpg"].tags, vec!["sea"]);
    }
}
