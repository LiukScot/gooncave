//! Moves the library folder to a new place together with the records that name its files.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    db::{Database, OWNER_ID},
    Result,
};

impl Database {
    /// Opens the database with the library at `library_root`. When the library was last opened at
    /// `previous` and `library_root` is still empty, its files and their records move there
    /// first. If a file cannot be copied, nothing is deleted and the library stays at `previous`.
    pub fn open_moving(
        data_directory: &Path,
        library_root: &Path,
        previous: &Path,
    ) -> Result<Self> {
        match move_library(data_directory, library_root, previous) {
            Ok(_) => Self::open(data_directory, library_root),
            Err(error) => {
                eprintln!(
                    "Cannot move the library from {} to {}: {error}. It stays where it is.",
                    previous.display(),
                    library_root.display()
                );
                Self::open(data_directory, previous)
            }
        }
    }
}

/// iOS gives the app a new container at every update and moves its files there (Apple TN2285),
/// so the absolute paths stored under the old one point nowhere. When the last library root is
/// gone and shares its trailing folders with `root`, every stored path that holds those folders
/// moves under `root`, older containers included. Rows that then name the same file merge into
/// the one changed last, and a file's copy on this device replaces its row waiting for sync.
pub(crate) fn follow_container(c: &mut Connection, root: &Path, thumbnails: &Path) -> Result<()> {
    let stored: Option<String> = c
        .query_row(
            "SELECT library_root FROM users WHERE id = ?1",
            [OWNER_ID],
            |r| r.get(0),
        )
        .optional()?;
    let Some(stored) = stored.map(PathBuf::from) else {
        return Ok(());
    };
    if stored == root || stored.exists() {
        return Ok(());
    }
    let shared = stored
        .components()
        .rev()
        .zip(root.components().rev())
        .take_while(|(a, b)| a == b)
        .count();
    if shared == 0 {
        return Ok(());
    }
    let root_text = root.to_string_lossy().into_owned();
    let tail: PathBuf = root
        .components()
        .skip(root.components().count() - shared)
        .collect();
    let marker = format!("/{}", tail.to_string_lossy());
    let head = &root_text[..root_text.len() - marker.len()];
    let moved = |path: &str| -> Option<String> {
        let at = path
            .match_indices(&marker)
            .map(|(i, _)| i)
            .find(|&i| matches!(path.as_bytes().get(i + marker.len()), None | Some(b'/')))?;
        (&path[..at] != head).then(|| format!("{head}{}", &path[at..]))
    };
    let tx = c.transaction()?;
    for (table, column) in [
        ("folders", "path"),
        ("files", "path"),
        ("favorite_items", "file_path"),
    ] {
        let rows: Vec<(i64, String)> = tx
            .prepare(&format!("SELECT rowid, {column} FROM {table}"))?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut update = tx.prepare(&format!(
            "UPDATE {table} SET {column} = ?2 WHERE rowid = ?1"
        ))?;
        for (row, path) in rows {
            if let Some(path) = moved(&path) {
                update.execute(params![row, path])?;
            }
        }
    }
    let thumbs: Vec<String> = tx
        .prepare("SELECT DISTINCT thumb_path FROM files WHERE thumb_path IS NOT NULL")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for thumb in thumbs {
        let Some(name) = Path::new(&thumb).file_name() else {
            continue;
        };
        let current = thumbnails.join(name).to_string_lossy().into_owned();
        if current != thumb {
            tx.execute(
                "UPDATE files SET thumb_path = ?2 WHERE thumb_path = ?1",
                params![thumb, current],
            )?;
        }
    }
    // One folder row per path, then one file row per path: the oldest, which the person tagged
    // first. A row waiting for sync gives way to the copy on this device.
    tx.execute_batch(
        "UPDATE files SET folder_id = (SELECT min(k.id) FROM folders k JOIN folders f ON f.id = files.folder_id WHERE k.path = f.path)
           WHERE EXISTS (SELECT 1 FROM folders f WHERE f.id = files.folder_id);
         DELETE FROM folders WHERE id <> (SELECT min(k.id) FROM folders k WHERE k.path = folders.path);",
    )?;
    let doubles: Vec<(String, String)> = tx
        .prepare(
            "SELECT f.id, f.sha256 FROM files f WHERE EXISTS (SELECT 1 FROM files k WHERE k.path = f.path AND k.id <> f.id
               AND (k.created_at < f.created_at OR (k.created_at = f.created_at AND k.id < f.id)))
             UNION SELECT f.id, f.sha256 FROM files f WHERE f.location_type = 'REMOTE'
               AND EXISTS (SELECT 1 FROM files k WHERE k.sha256 = f.sha256 AND k.location_type = 'LOCAL')",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    tx.execute(
        "UPDATE favorite_items SET file_path = (SELECT min(k.path) FROM files f JOIN files k ON k.sha256 = f.sha256
           WHERE f.path = favorite_items.file_path AND f.location_type = 'REMOTE' AND k.location_type = 'LOCAL')
         WHERE file_path IN (SELECT f.path FROM files f WHERE f.location_type = 'REMOTE'
           AND EXISTS (SELECT 1 FROM files k WHERE k.sha256 = f.sha256 AND k.location_type = 'LOCAL'))",
        [],
    )?;
    // The kept row may lack what only a dropped one had. Applying the file's sync records again
    // gives it back; without this, the next sync would read the gap as deletions.
    let hashes: Vec<&str> = doubles.iter().map(|(_, sha)| sha.as_str()).collect();
    tx.execute(
        "UPDATE sync_records SET applied = 0 WHERE applied = 1
           AND json_extract(record_key, '$[0]') IN (SELECT value FROM json_each(?1))",
        [serde_json::to_string(&hashes).map_err(|e| crate::Error::Storage(e.to_string()))?],
    )?;
    let ids: Vec<String> = doubles.into_iter().map(|(id, _)| id).collect();
    let orphans = crate::library::forget_files(&tx, &ids)?;
    tx.commit()?;
    for stored in orphans {
        let Some(name) = Path::new(&stored).file_name() else {
            continue;
        };
        match std::fs::remove_file(thumbnails.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("Cannot remove thumbnail {stored}: {error}"),
        }
    }
    Ok(())
}

/// Returns whether the library moved.
fn move_library(data_directory: &Path, target: &Path, previous: &Path) -> Result<bool> {
    let database = data_directory.join("library.sqlite");
    if !database.is_file() || !previous.is_dir() {
        return Ok(false);
    }
    let from = previous.canonicalize()?;
    let mut connection = Connection::open(&database)?;
    let stored: Option<String> = match connection
        .query_row(
            "SELECT library_root FROM users WHERE id = ?1",
            [OWNER_ID],
            |r| r.get(0),
        )
        .optional()
    {
        Ok(stored) => stored,
        // A database made before the users table has no library to move.
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.contains("no such table") =>
        {
            None
        }
        Err(error) => return Err(error.into()),
    };
    if stored.as_deref() != Some(&*from.to_string_lossy()) {
        return Ok(false);
    }
    std::fs::create_dir_all(target)?;
    if std::fs::read_dir(target)?.next().is_some() {
        return Ok(false);
    }
    let to = target.canonicalize()?;
    // A rename is instant on the same file system; across mounts (a Flatpak sees its data
    // folder and Pictures as two) every file is copied, then the old ones are deleted.
    std::fs::remove_dir(&to)?;
    let renamed = std::fs::rename(&from, &to).is_ok();
    if !renamed {
        std::fs::create_dir_all(&to)?;
        if let Err(error) = copy_tree(&from, &to) {
            // Leave the target empty, so the next start tries again.
            std::fs::remove_dir_all(&to)?;
            std::fs::create_dir_all(&to)?;
            return Err(error);
        }
    }
    let (old, new) = (from.to_string_lossy(), to.to_string_lossy());
    let tx = connection.transaction()?;
    for (table, column) in [
        ("folders", "path"),
        ("files", "path"),
        ("favorite_items", "file_path"),
    ] {
        tx.execute(
            &format!(
                "UPDATE {table} SET {column} = ?2 || substr({column}, length(?1) + 1)
                 WHERE {column} = ?1 OR substr({column}, 1, length(?1) + 1) = ?1 || '/'"
            ),
            params![old, new],
        )?;
    }
    tx.execute(
        "UPDATE users SET library_root = ?2 WHERE id = ?1",
        params![OWNER_ID, new],
    )?;
    tx.commit()?;
    if !renamed {
        if let Err(error) = std::fs::remove_dir_all(&from) {
            eprintln!(
                "The library moved to {}, but {} could not be deleted: {error}",
                to.display(),
                from.display()
            );
        }
    }
    Ok(true)
}

/// Copies every file under `from` into `to`, checking each copy's size. Symbolic links are
/// skipped, as the library scan skips them.
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let mut pending: Vec<(PathBuf, PathBuf)> = vec![(from.to_owned(), to.to_owned())];
    while let Some((source, target)) = pending.pop() {
        for entry in std::fs::read_dir(&source)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            let destination = target.join(entry.file_name());
            if kind.is_dir() {
                std::fs::create_dir_all(&destination)?;
                pending.push((entry.path(), destination));
            } else if kind.is_file() {
                let copied = std::fs::copy(entry.path(), &destination)?;
                if copied != entry.metadata()?.len() {
                    return Err(crate::Error::Storage(format!(
                        "{} was not copied whole.",
                        entry.path().display()
                    )));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_keeps_every_file_and_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("from"), dir.path().join("to"));
        std::fs::create_dir_all(from.join("a/b")).unwrap();
        std::fs::write(from.join("top.png"), b"top").unwrap();
        std::fs::write(from.join("a/b/deep.png"), b"deep").unwrap();
        std::fs::create_dir_all(&to).unwrap();
        copy_tree(&from, &to).unwrap();
        assert_eq!(std::fs::read(to.join("top.png")).unwrap(), b"top");
        assert_eq!(std::fs::read(to.join("a/b/deep.png")).unwrap(), b"deep");
    }

    #[tokio::test]
    async fn the_library_follows_the_app_to_a_new_container() {
        let dir = tempfile::tempdir().unwrap();
        let container = |name: &str| dir.path().join(name).join("Library/app");
        let (old, new) = (container("A"), container("B"));
        let picture = old.join("library/one.png");
        std::fs::create_dir_all(picture.parent().unwrap()).unwrap();
        crate::sync::tests::picture(&picture, "testsrc=s=64x48");
        {
            let db = Database::open(&old, &old.join("library")).unwrap();
            crate::library::scan(&db).await.unwrap();
            db.call(|c| {
                c.execute_batch(&format!(
                    "INSERT INTO file_tags (file_id, tag, source, category, created_at, updated_at)
                       SELECT id, 'kept', 'manual', 'general', {NOW}, {NOW} FROM files;
                     INSERT INTO favorite_items (user_id, provider, remote_id, file_path, created_at, updated_at)
                       SELECT '{OWNER_ID}', 'e621', '1', path, {NOW}, {NOW} FROM files;
                     -- What builds that did not follow their container left: a newer row for
                     -- the same file, and a row waiting for sync that a favorite points at.
                     INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status)
                       SELECT 'older', user_id, replace(path, '/A/', '/Z/'), type, created_at, created_at, status FROM folders;
                     INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, created_at, updated_at)
                       SELECT 'later-copy', 'older', 'LOCAL', replace(path, '/A/', '/Z/'), size_bytes, mtime, sha256, media_type, '2999-01-01', '2999-01-01' FROM files;
                     INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, created_at, updated_at)
                       SELECT 'waiting', 'older', 'REMOTE', replace(path, '/A/', '/Z/') || '.remote', size_bytes, mtime, sha256, media_type, created_at, created_at FROM files WHERE id <> 'later-copy';
                     INSERT INTO favorite_items (user_id, provider, remote_id, file_path, created_at, updated_at)
                       SELECT '{OWNER_ID}', 'e621', '2', path, {NOW}, {NOW} FROM files WHERE id = 'waiting';
                     INSERT INTO sync_records (kind, record_key, data, changed_at, applied)
                       SELECT 'tag', json_array(sha256, 'only-on-the-later-copy', 'MANUAL'), '{{}}', {NOW}, 1 FROM files WHERE id = 'later-copy';",
                    NOW = crate::library::NOW
                ))?;
                Ok(())
            })
            .await
            .unwrap();
        }
        // The update: iOS moves everything to the new container.
        std::fs::rename(dir.path().join("A"), dir.path().join("B")).unwrap();

        let db = Database::open(&new, &new.join("library")).unwrap();
        crate::library::scan(&db).await.unwrap();
        let rows: Vec<(String, String, i64)> = db
            .call(|c| {
                let mut s = c.prepare(
                    "SELECT f.path, fav.file_path, (SELECT count(*) FROM file_tags t WHERE t.file_id = f.id) FROM files f, favorite_items fav ORDER BY fav.remote_id",
                )?;
                let rows = s
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            })
            .await
            .unwrap();
        let moved = new.join("library/one.png").canonicalize().unwrap();
        let moved = moved.to_string_lossy().into_owned();
        assert_eq!(
            rows,
            vec![(moved.clone(), moved.clone(), 1), (moved.clone(), moved, 1)],
            "one row, with its tag and both favorites"
        );
        let reapplied: i64 = db
            .call(|c| {
                Ok(c.query_row(
                    "SELECT applied FROM sync_records WHERE kind = 'tag'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(
            reapplied, 0,
            "what only the dropped row had comes back from sync"
        );
    }

    #[tokio::test]
    async fn a_library_moves_with_its_records() {
        let dir = tempfile::tempdir().unwrap();
        let (data, old, new) = (
            dir.path().join("data"),
            dir.path().join("Pictures/gooncave"),
            dir.path().join("data/library"),
        );
        std::fs::create_dir_all(old.join("art")).unwrap();
        let picture = old.join("art/one.png");
        crate::sync::tests::picture(&picture, "testsrc=s=64x48");
        {
            let db = Database::open(&data, &old).unwrap();
            crate::library::scan(&db).await.unwrap();
            db.call(|c| {
                c.execute(
                    &format!("INSERT INTO file_tags (file_id, tag, source, category, created_at, updated_at)
                     SELECT id, 'kept', 'manual', 'general', {NOW}, {NOW} FROM files", NOW = crate::library::NOW),
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        }

        let db = Database::open_moving(&data, &new, &old).unwrap();
        assert!(new.join("art/one.png").is_file());
        assert!(!old.exists(), "the old folder is gone");
        crate::library::scan(&db).await.unwrap();
        let (path, tags): (String, i64) = db
            .call(|c| {
                Ok(c.query_row(
                    "SELECT f.path, (SELECT count(*) FROM file_tags t WHERE t.file_id = f.id) FROM files f",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .await
            .unwrap();
        assert!(
            Path::new(&path).starts_with(new.canonicalize().unwrap()),
            "{path}"
        );
        assert_eq!(tags, 1, "the file keeps its tags");

        drop(db);
        let again = Database::open_moving(&data, &new, &old).unwrap();
        assert_eq!(
            again.library().root,
            new.canonicalize().unwrap(),
            "a second start moves nothing"
        );
    }
}
