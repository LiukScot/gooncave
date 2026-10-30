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
    /// Sync's own connection, for reads only: its multi-second reads must not hold the one every
    /// screen waits on.
    sync_connection: Arc<Mutex<Connection>>,
    paths: Arc<LibraryPaths>,
    pub(crate) favorites: Arc<crate::favorites::Job>,
    pub(crate) subscriptions: Arc<tokio::sync::Mutex<()>>,
    pub(crate) sources: Arc<crate::source_jobs::Job>,
    pub(crate) wd14: Arc<crate::wd14::Job>,
    pub(crate) duplicates: Arc<crate::duplicates::Job>,
    pub(crate) site_tags: Arc<crate::site_tags::Job>,
    pub(crate) sync: Arc<crate::sync::Job>,
    pub(crate) originals: Arc<crate::originals::Job>,
    pub(crate) scan: Arc<crate::library::Progress>,
}

/// Where media lives: `root` is the single library folder; `thumbnails` is regenerable cache.
pub struct LibraryPaths {
    pub root: PathBuf,
    pub thumbnails: PathBuf,
    pub(crate) models: PathBuf,
    /// For large temporary files: the system's temp folder can be RAM. Emptied at every start, so
    /// what a crash leaves behind does not stay.
    pub(crate) temp: PathBuf,
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
    /// Uploads the changes the sync folder has not received yet, for at most 15 seconds.
    /// The server calls it on shutdown, and a shell when the last window closes.
    pub async fn upload_before_close(&self) {
        if tokio::time::timeout(crate::sync::CLOSE_TIMEOUT, crate::sync::flush(self))
            .await
            .is_err()
        {
            eprintln!("The last sync upload did not finish before closing.");
        }
    }
    /// Opens `library.sqlite` in `data_directory` and creates `library_root` when missing.
    pub fn open(data_directory: &Path, library_root: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_directory)?;
        std::fs::create_dir_all(library_root)?;
        let root = library_root.canonicalize()?;
        let thumbnails = data_directory.join("thumbnails");
        let temp = data_directory.join("temp");
        match std::fs::remove_dir_all(&temp) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("Cannot empty {}: {error}", temp.display());
            }
            _ => {}
        }
        std::fs::create_dir_all(&temp)?;
        let database_path = data_directory.join("library.sqlite");
        let mut connection = connect(&database_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&database_path, std::fs::Permissions::from_mode(0o600))?;
        }
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
        crate::library_move::follow_container(&mut connection, &root, &thumbnails)?;
        crate::boorus::adopt_foreign_site_keys(&connection)?;
        if let Err(error) = crate::settings::read(&connection, "extra") {
            eprintln!("Cannot read Developer mode; diagnostics stay off: {error}");
        }
        let sync = Arc::new(crate::sync::Job::default());
        let hook = sync.clone();
        connection.update_hook(Some(move |_, _: &str, table: &str, _| hook.written(table)))?;
        crate::sync::track_files(&connection, sync.clone())?;
        // Keep the reference schema's foreign keys without exposing accounts or sessions.
        connection.execute(
            "INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at)
             VALUES (?1, ?1, 'disabled', ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(id) DO UPDATE SET library_root = excluded.library_root",
            params![OWNER_ID, root.to_string_lossy()],
        )?;
        connection.execute_batch(ACTIVE_FOLDERS)?;
        let sync_connection = connect(&database_path)?;
        sync_connection.execute_batch(ACTIVE_FOLDERS)?;
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
            sync_connection: Arc::new(Mutex::new(sync_connection)),
            paths: Arc::new(LibraryPaths {
                root,
                thumbnails,
                models: data_directory.join("models"),
                temp,
            }),
            favorites: Arc::new(crate::favorites::Job::default()),
            subscriptions: Arc::new(tokio::sync::Mutex::new(())),
            sources: Arc::new(crate::source_jobs::Job::default()),
            wd14: Arc::new(crate::wd14::Job::default()),
            duplicates: Arc::new(crate::duplicates::Job::default()),
            site_tags: Arc::new(crate::site_tags::Job::default()),
            sync,
            originals: Arc::default(),
            scan: Arc::default(),
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

    /// Like [`Self::call`] on sync's own connection, which sees the same active folders, inside
    /// one read transaction so every query sees the same moment. `operation` may write only
    /// this connection's temp tables: a write to the library would make the main connection's
    /// read-then-write transactions fail with `SQLITE_BUSY`, which its busy timeout does not
    /// retry.
    pub(crate) async fn sync_read<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let active: Vec<String> = self
            .call(|c| {
                let mut s = c.prepare("SELECT id FROM active_library_folders")?;
                let ids = s
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(ids)
            })
            .await?;
        let database = self.sync_connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database
                .lock()
                .map_err(|_| Error::Storage("database lock poisoned".into()))?;
            // The temporary table lives in this connection's own temp database, not the library.
            let tx = connection.transaction()?;
            tx.execute("DELETE FROM active_library_folders", [])?;
            for id in active {
                tx.execute("INSERT INTO active_library_folders (id) VALUES (?1)", [id])?;
            }
            tx.commit()?;
            let read = connection.transaction()?;
            let result = operation(&read)?;
            read.commit()?;
            Ok(result)
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
                    // The desktop shell opens `/open-folder` links; it is the shell that registers a
                    // browser outside iOS.
                    "capabilities": {"library": true, "boorus": true, "favorites": true, "favoritesAutoSync": true, "subscriptions": true, "sourceMatching":true, "tagging":crate::wd14_model::available(), "processing": false, "duplicates": true, "autoFavorite": true, "tagRefresh": true, "sync": true, "browserSignIn": crate::browser::get().is_some(), "photoLibrary": crate::photos::get().is_some(), "openFolder": !cfg!(target_os = "ios") && crate::browser::get().is_some()}
                })),
            )?)
        }).await
    }
}

const ACTIVE_FOLDERS: &str = "CREATE TEMP TABLE active_library_folders (id TEXT PRIMARY KEY);
    CREATE TEMP VIEW library_folders AS SELECT folders.* FROM folders JOIN active_library_folders USING (id);";

fn connect(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(30))?;
    connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    Ok(connection)
}

/// Brings a database written by any GoonCave version up to this one's schema.
pub(crate) fn migrate_reference(connection: &mut Connection) -> Result<()> {
    migrate(connection, MIGRATIONS)
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

    #[test]
    fn tags_from_far_fluffle_matches_are_removed_unless_a_trusted_match_backs_them() {
        let position = MIGRATIONS
            .iter()
            .position(|(name, _)| name.starts_with("0025_"))
            .unwrap();
        let (before, repair) = MIGRATIONS.split_at(position);
        let mut connection = Connection::open_in_memory().unwrap();
        migrate(&mut connection, before).unwrap();
        connection
            .execute(
                "INSERT INTO folders (id, path, type, created_at, updated_at, status) VALUES ('f', '/', 'LOCAL', '', '', 'ACTIVE')",
                [],
            )
            .unwrap();
        for id in ["far", "close", "backed"] {
            connection
                .execute(
                    "INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, created_at, updated_at)
                     VALUES (?1, 'f', 'LOCAL', ?1, 1, '', '', 'IMAGE', '', '')",
                    [id],
                )
                .unwrap();
        }
        let run = |file: &str, provider: &str, results: &str| {
            connection
                .execute(
                    "INSERT INTO provider_runs (id, file_id, provider, status, cached_hit, results, created_at)
                     VALUES (?1, ?2, ?3, 'COMPLETED', 0, ?4, '')",
                    params![format!("{file}{provider}"), file, provider, results],
                )
                .unwrap();
        };
        let far = r#"[{"sourceUrl":"https://e621.net/posts/9","score":100.0,"distance":0.97}]"#;
        run("far", "FLUFFLE", far);
        run(
            "close",
            "FLUFFLE",
            r#"[{"sourceUrl":"https://e621.net/posts/9","score":100.0,"distance":0.01}]"#,
        );
        run("backed", "FLUFFLE", far);
        run(
            "backed",
            "SAUCENAO",
            r#"[{"sourceUrl":"https://e621.net/posts/9","score":96.0}]"#,
        );
        for id in ["far", "close", "backed"] {
            for (tag, source, url) in [
                ("undertale", "E621", Some("https://e621.net/posts/9")),
                ("text", "WD14", None),
            ] {
                connection
                    .execute(
                        "INSERT INTO file_tags (file_id, tag, category, source, source_url, created_at, updated_at)
                         VALUES (?1, ?2, 'general', ?3, ?4, '', '')",
                        params![id, tag, source, url],
                    )
                    .unwrap();
            }
            connection
                .execute(
                    "INSERT INTO file_post_relations (file_id, source, remote_id, has_children, updated_at) VALUES (?1, 'E621', '9', 0, '')",
                    [id],
                )
                .unwrap();
        }

        migrate(&mut connection, MIGRATIONS).unwrap();
        assert!(!repair.is_empty());

        let tags = |id: &str| -> Vec<String> {
            let mut statement = connection
                .prepare("SELECT tag FROM file_tags WHERE file_id = ?1 ORDER BY tag")
                .unwrap();
            statement
                .query_map([id], |row| row.get(0))
                .unwrap()
                .map(|tag| tag.unwrap())
                .collect()
        };
        let relations = |id: &str| -> i64 {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM file_post_relations WHERE file_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(tags("far"), vec!["text"]);
        assert_eq!(relations("far"), 0);
        assert_eq!(tags("close"), vec!["text", "undertale"]);
        assert_eq!(relations("close"), 1);
        assert_eq!(tags("backed"), vec!["text", "undertale"]);
        assert_eq!(relations("backed"), 1);
    }
}
