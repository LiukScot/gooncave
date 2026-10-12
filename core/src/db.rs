use std::{
    path::Path,
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
pub struct Database(Arc<Mutex<Connection>>);

impl Database {
    pub fn open(data_directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_directory)?;
        let mut connection = Connection::open(data_directory.join("library.sqlite"))?;
        connection.busy_timeout(Duration::from_secs(30))?;
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        migrate(&mut connection, MIGRATIONS)?;
        // Keep the reference schema's foreign keys without exposing accounts or sessions.
        connection.execute(
            "INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at)
             VALUES (?1, ?1, 'disabled', ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(id) DO NOTHING",
            params![OWNER_ID, data_directory.join("media").to_string_lossy()],
        )?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let database = self.0.clone();
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
                    "capabilities": {"library": false, "boorus": false, "processing": false}
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
