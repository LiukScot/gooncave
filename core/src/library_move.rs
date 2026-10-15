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
