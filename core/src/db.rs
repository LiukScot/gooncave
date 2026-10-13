use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

pub const OWNER_ID: &str = "device-owner";

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
    paths: Arc<LibraryPaths>,
    pub(crate) favorites: Arc<crate::favorites::Job>,
}

/// Where media lives: `root` is the single library folder; `thumbnails` is regenerable cache.
pub struct LibraryPaths {
    pub root: PathBuf,
    pub thumbnails: PathBuf,
}

impl LibraryPaths {
    pub(crate) fn resolve_folder(&self, folder: &Path) -> Result<PathBuf> {
        let resolved = folder.canonicalize()?;
        if resolved != folder || !resolved.starts_with(&self.root) {
            return Err(Error::Invalid("This folder is outside the active library. Open the folder settings to choose an active folder.".into()));
        }
        Ok(resolved)
    }

    pub(crate) fn resolve_file(&self, folder: &Path, path: &Path) -> Result<PathBuf> {
        let folder = self.resolve_folder(folder)?;
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            folder.join(path)
        };
        let requested_parent = path
            .parent()
            .ok_or_else(|| Error::Invalid("Invalid library file path.".into()))?;
        let parent = requested_parent.canonicalize()?;
        if parent != requested_parent
            || !parent.starts_with(&folder)
            || !parent.starts_with(&self.root)
        {
            return Err(Error::Invalid(
                "This file is outside the active library and cannot be opened or deleted.".into(),
            ));
        }
        let path = parent.join(
            path.file_name()
                .ok_or_else(|| Error::Invalid("Invalid library file name.".into()))?,
        );
        if path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(Error::Invalid("This file was replaced by a symbolic link. Refresh the library before opening or deleting it.".into()));
        }
        match path.canonicalize() {
            Ok(resolved) if resolved.starts_with(&folder) && resolved.starts_with(&self.root) => {
                Ok(resolved)
            }
            Ok(_) => Err(Error::Invalid(
                "This file is outside the active library and cannot be opened or deleted.".into(),
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
            Err(error) => Err(error.into()),
        }
    }
}

impl Database {
    /// Opens `library.sqlite` in `data_directory` and creates `library_root` when missing.
    pub fn open(data_directory: &Path, library_root: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_directory)?;
        std::fs::create_dir_all(library_root)?;
        let root = library_root.canonicalize()?;
        let thumbnails = data_directory.join("thumbnails");
        let database_path = data_directory.join("library.sqlite");
        let mut connection = Connection::open(&database_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&database_path, std::fs::Permissions::from_mode(0o600))?;
        }
        connection.busy_timeout(Duration::from_secs(30))?;
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in ["library.sqlite-wal", "library.sqlite-shm"] {
                match std::fs::set_permissions(
                    data_directory.join(name),
                    std::fs::Permissions::from_mode(0o600),
                ) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        migrate(&mut connection, MIGRATIONS)?;
        // Keep the reference schema's foreign keys without exposing accounts or sessions.
        connection.execute(
            "INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at)
             VALUES (?1, ?1, 'disabled', ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(id) DO UPDATE SET library_root = excluded.library_root",
            params![OWNER_ID, root.to_string_lossy()],
        )?;
        connection.execute_batch("CREATE TEMP TABLE active_library_folders (id TEXT PRIMARY KEY);
            CREATE TEMP VIEW library_folders AS SELECT folders.* FROM folders JOIN active_library_folders USING (id);")?;
        {
            let mut statement =
                connection.prepare("SELECT id, path FROM folders WHERE user_id = ?1")?;
            let rows = statement.query_map([OWNER_ID], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            })?;
            for row in rows {
                let (id, path) = row?;
                if path == root || path.parent() == Some(root.as_path()) {
                    connection
                        .execute("INSERT INTO active_library_folders (id) VALUES (?1)", [id])?;
                }
            }
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            paths: Arc::new(LibraryPaths { root, thumbnails }),
            favorites: Arc::new(crate::favorites::Job::default()),
        })
    }

    pub fn library(&self) -> &LibraryPaths {
        &self.paths
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let database = self.connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database
                .lock()
                .map_err(|_| Error::Storage("database lock poisoned".into()))?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| Error::Storage(error.to_string()))?
    }

    pub async fn profile(&self) -> Result<Value> {
        self.call(|connection| {
            Ok(connection.query_row(
                "SELECT id, username, library_root, created_at, updated_at FROM users WHERE id = ?1",
                [OWNER_ID],
                |row| Ok(json!({
                    "id": row.get::<_, String>(0)?, "username": row.get::<_, String>(1)?,
                    "libraryRoot": row.get::<_, String>(2)?, "createdAt": row.get::<_, String>(3)?,
                    "updatedAt": row.get::<_, String>(4)?, "lastLoginAt": null,
                    "capabilities": {"library": true, "boorus": true, "favorites": true, "favoritesAutoSync": false, "subscriptions": false, "processing": false}
                })),
            )?)
        }).await
    }
}

fn migrate(connection: &mut Connection, migrations: &[(&str, &str)]) -> Result<()> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS __drizzle_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE,
            name TEXT, created_at INTEGER NOT NULL
        );",
    )?;
    for (name, sql) in migrations {
        let checksum: String = Sha256::digest(sql.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let previous: Option<String> = transaction
            .query_row(
                "SELECT hash FROM __drizzle_migrations WHERE name = ?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        match previous {
            Some(previous) if previous != checksum => {
                return Err(Error::Storage(format!(
                    "migration checksum mismatch: {name}"
                )))
            }
            Some(_) => continue,
            None => {}
        }
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO __drizzle_migrations (hash, name, created_at) VALUES (?1, ?2, unixepoch() * 1000)",
            params![checksum, name],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn read_setting(connection: &Connection, key: &str, default: &Value) -> Result<Value> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM user_settings WHERE user_id = ?1 AND key = ?2",
            params![OWNER_ID, key],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|error| Error::Storage(format!("invalid setting {key}: {error}"))),
        None => Ok(default.clone()),
    }
}

pub(crate) fn write_setting(connection: &Connection, key: &str, value: &Value) -> Result<()> {
    connection.execute(
        "INSERT INTO user_settings (user_id, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
        params![OWNER_ID, key, value.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_atomic_and_detect_changed_sql() {
        let mut connection = Connection::open_in_memory().unwrap();
        assert!(migrate(
            &mut connection,
            &[
                ("a", "CREATE TABLE example (id INTEGER);"),
                ("b", "invalid SQL;")
            ]
        )
        .is_err());
        assert!(connection.prepare("SELECT * FROM example").is_err());
        migrate(
            &mut connection,
            &[("a", "CREATE TABLE example (id INTEGER);")],
        )
        .unwrap();
        migrate(
            &mut connection,
            &[("a", "CREATE TABLE example (id INTEGER);")],
        )
        .unwrap();
        assert!(migrate(&mut connection, &[("a", "CREATE TABLE example (id TEXT);")]).is_err());
    }
}
