use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

/// `stars` is genuinely absent until rated; `tags` is the full (possibly empty) set.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageLabels {
    pub stars: Option<u8>,
    pub tags: Vec<String>,
}

/// Deliberately never writes anywhere near the images: labeling must be zero-risk to the user's files.
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

    /// Set or clear (None) the star rating of every path, in one transaction.
    pub fn set_stars(
        &self,
        paths: &[String],
        stars: Option<u8>,
    ) -> Result<HashMap<String, ImageLabels>, String> {
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for path in paths {
                match stars {
                    Some(n) => tx
                        .execute(
                            "INSERT INTO stars (path, stars) VALUES (?1, ?2)
                             ON CONFLICT(path) DO UPDATE SET stars = ?2",
                            rusqlite::params![path, n],
                        )
                        .map_err(|e| e.to_string())?,
                    None => tx
                        .execute("DELETE FROM stars WHERE path = ?1", [path])
                        .map_err(|e| e.to_string())?,
                };
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        self.labels_of(paths)
    }

    /// One verdict for the whole selection: all tagged removes from all, otherwise adds to all — never per-file flips.
    pub fn toggle_tag(
        &self,
        paths: &[String],
        tag: &str,
    ) -> Result<HashMap<String, ImageLabels>, String> {
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let mut tagged = 0usize;
            for path in paths {
                let has: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM tags WHERE path = ?1 AND tag = ?2",
                        rusqlite::params![path, tag],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                tagged += has as usize;
            }
            let removing = !paths.is_empty() && tagged == paths.len();
            for path in paths {
                if removing {
                    tx.execute(
                        "DELETE FROM tags WHERE path = ?1 AND tag = ?2",
                        rusqlite::params![path, tag],
                    )
                } else {
                    tx.execute(
                        "INSERT OR IGNORE INTO tags (path, tag) VALUES (?1, ?2)",
                        rusqlite::params![path, tag],
                    )
                }
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        self.labels_of(paths)
    }

    /// Unlike `for_paths`, answers for every path given — else the caller cannot tell "cleared" from "unchanged".
    fn labels_of(&self, paths: &[String]) -> Result<HashMap<String, ImageLabels>, String> {
        let mut map = self.for_paths(paths)?;
        for path in paths {
            map.entry(path.clone()).or_insert_with(empty_labels);
        }
        Ok(map)
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

    fn one(path: &str) -> Vec<String> {
        vec![path.to_string()]
    }

    #[test]
    fn stars_set_update_clear() {
        let (_dir, svc) = service();
        assert_eq!(svc.set_stars(&one("/a.jpg"), Some(3)).unwrap()["/a.jpg"].stars, Some(3));
        assert_eq!(svc.set_stars(&one("/a.jpg"), Some(5)).unwrap()["/a.jpg"].stars, Some(5));
        assert_eq!(svc.set_stars(&one("/a.jpg"), None).unwrap()["/a.jpg"].stars, None);
        // Cleared and never tagged: the image has no labels at all anymore.
        assert!(svc.for_paths(&one("/a.jpg")).unwrap().is_empty());
    }

    #[test]
    fn a_whole_selection_is_rated_at_once() {
        let (_dir, svc) = service();
        let three: Vec<String> = ["/a.jpg", "/b.jpg", "/c.jpg"].iter().map(|p| p.to_string()).collect();
        let rated = svc.set_stars(&three, Some(4)).unwrap();
        assert_eq!(rated.len(), 3);
        assert!(rated.values().all(|l| l.stars == Some(4)));
        // Clearing must answer for every path, or the caller cannot tell "cleared" from "left alone".
        let cleared = svc.set_stars(&three, None).unwrap();
        assert_eq!(cleared.len(), 3);
        assert!(cleared.values().all(|l| l.stars.is_none()));
    }

    #[test]
    fn tags_toggle_on_and_off() {
        let (_dir, svc) = service();
        assert_eq!(svc.toggle_tag(&one("/a.jpg"), "pair").unwrap()["/a.jpg"].tags, vec!["pair"]);
        let both = svc.toggle_tag(&one("/a.jpg"), "family").unwrap();
        assert_eq!(both["/a.jpg"].tags, vec!["family", "pair"]); // sorted
        assert_eq!(svc.toggle_tag(&one("/a.jpg"), "pair").unwrap()["/a.jpg"].tags, vec!["family"]);
    }

    #[test]
    fn a_mixed_selection_gains_the_tag_rather_than_swapping_halves() {
        let (_dir, svc) = service();
        svc.toggle_tag(&one("/a.jpg"), "sea").unwrap();
        let pair: Vec<String> = ["/a.jpg", "/b.jpg"].iter().map(|p| p.to_string()).collect();
        // One of the two has it: tagging the pair means both end up tagged.
        let tagged = svc.toggle_tag(&pair, "sea").unwrap();
        assert!(tagged.values().all(|l| l.tags == vec!["sea"]));
        // Now that they all have it, the same action takes it off both.
        let untagged = svc.toggle_tag(&pair, "sea").unwrap();
        assert!(untagged.values().all(|l| l.tags.is_empty()));
    }

    #[test]
    fn for_paths_returns_only_labeled() {
        let (_dir, svc) = service();
        svc.set_stars(&one("/a.jpg"), Some(4)).unwrap();
        svc.toggle_tag(&one("/b.jpg"), "sea").unwrap();
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
