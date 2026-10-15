//! Backups moved by hand: a file in the sync format to download or import, and the database of an
//! old GoonCave server to take over. Both merge like a sync, so nothing on this device is deleted.

use crate::{
    db::{migrate_reference, Database, OWNER_ID},
    sync::{self, Device},
    Error, Result,
};
use axum::{
    extract::{multipart::MultipartError, DefaultBodyLimit, Multipart, State},
    http::header,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// A backup file is compressed; this is far above any library's.
const MAX_BACKUP_BYTES: usize = 1 << 30;
/// Tables of the old server that belong to one account.
const ACCOUNT_TABLES: &[&str] = &[
    "folders",
    "user_settings",
    "user_booru_sites",
    "read_marks",
    "favorite_items",
];

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route(
            "/backup",
            get(download)
                .post(restore)
                .layer(DefaultBodyLimit::max(MAX_BACKUP_BYTES)),
        )
        // An old server's database can be several gigabytes; it is streamed to a file.
        .route(
            "/backup/old-database",
            post(take_over).layer(DefaultBodyLimit::disable()),
        )
}

fn bad_upload(error: MultipartError) -> Error {
    eprintln!("Backup upload failed: {error}");
    Error::Invalid("The file did not arrive completely. Choose it again.".into())
}

async fn download(State(db): State<Database>) -> Result<impl IntoResponse> {
    let body = db.call(|c| sync::backup_file(c)).await?;
    let name = format!("gooncave-backup-{}.json.gz", &sync::now()[..10]);
    Ok((
        [
            (header::CONTENT_TYPE, "application/gzip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        body,
    ))
}

async fn restore(State(db): State<Database>, mut multipart: Multipart) -> Result<Json<Value>> {
    let mut bytes = None;
    while let Some(field) = multipart.next_field().await.map_err(bad_upload)? {
        if field.name() == Some("file") {
            bytes = Some(field.bytes().await.map_err(bad_upload)?);
        }
    }
    let bytes = bytes.ok_or_else(|| Error::Invalid("Choose a backup file to import.".into()))?;
    let records = sync::read_backup(&bytes)?;
    let worker = db.clone();
    let result = db
        .call(move |c| sync::take(c, &worker.sync, records))
        .await?;
    db.sync.wake.notify_one();
    Ok(Json(result))
}

async fn take_over(State(db): State<Database>, mut multipart: Multipart) -> Result<Json<Value>> {
    let copy = tempfile::NamedTempFile::new()?;
    let mut username = None;
    let mut received = false;
    {
        let mut out = tokio::fs::File::from_std(copy.reopen()?);
        while let Some(mut field) = multipart.next_field().await.map_err(bad_upload)? {
            match field.name() {
                Some("username") => username = Some(field.text().await.map_err(bad_upload)?),
                Some("file") => {
                    while let Some(chunk) = field.chunk().await.map_err(bad_upload)? {
                        out.write_all(&chunk).await?;
                    }
                    received = true;
                }
                _ => {}
            }
        }
        out.flush().await?;
    }
    let username = username
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| Error::Invalid("Enter your user name on the old GoonCave.".into()))?;
    if !received {
        return Err(Error::Invalid(
            "Choose the database file of the old GoonCave.".into(),
        ));
    }
    let (records, credentials) =
        tokio::task::spawn_blocking(move || read_old(copy.path(), &username))
            .await
            .map_err(|error| Error::Storage(format!("old database reader stopped: {error}")))??;
    let worker = db.clone();
    let result = db
        .call(move |c| {
            let result = sync::take(c, &worker.sync, records)?;
            keep_credentials(c, &credentials)?;
            Ok(result)
        })
        .await?;
    db.sync.wake.notify_one();
    Ok(Json(result))
}

/// Site key, address, engine, user name, API key and session cookie.
type Credentials = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// The shared records and site credentials of one account in an old server's database. Works on
/// a private copy, which it rewrites so the account looks like this device's owner.
fn read_old(path: &Path, username: &str) -> Result<(sync::Records, Vec<Credentials>)> {
    let not_gooncave = || {
        Error::Invalid(
            "This file is not a GoonCave database. On the old server it is storage/data.db, or the file named by DATA_FILE.".into(),
        )
    };
    let mut c = Connection::open(path)?;
    c.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map_err(|_| not_gooncave())?
    .ok_or_else(not_gooncave)?;
    migrate_reference(&mut c).map_err(|error| {
        eprintln!("Cannot bring the old database up to date: {error}");
        Error::Invalid(
            "This database comes from a GoonCave version this app cannot read. Update the old server, then copy its database again.".into(),
        )
    })?;
    let account: String = c
        .query_row(
            "SELECT id FROM users WHERE lower(username) = lower(?1)",
            [username],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            Error::Invalid(format!(
                "The old database has no account named {username}. Check the user name you log in with."
            ))
        })?;
    // Foreign keys stay off: other accounts' rows are dropped without cascading through the copy.
    c.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let tx = c.transaction()?;
    for table in ACCOUNT_TABLES {
        tx.execute(
            &format!("DELETE FROM {table} WHERE user_id IS NOT ?1"),
            [&account],
        )?;
        tx.execute(&format!("UPDATE {table} SET user_id = ?1"), [OWNER_ID])?;
    }
    tx.commit()?;
    c.execute_batch("CREATE TEMP VIEW library_folders AS SELECT * FROM folders;")?;
    let records = sync::export(&c, &Device::load(&c)?)?;
    let mut statement = c.prepare(
        "SELECT coalesce(preset_key, 'url:' || base_url), base_url, engine, username, api_key, session_cookie
         FROM user_booru_sites
         WHERE username IS NOT NULL OR api_key IS NOT NULL OR session_cookie IS NOT NULL",
    )?;
    let credentials = statement
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((records, credentials))
}

/// Gives sites without credentials on this device the ones they had on the old server, only
/// where the site still has the same address and engine.
fn keep_credentials(c: &Connection, credentials: &[Credentials]) -> Result<()> {
    for (site, base, engine, username, api_key, cookie) in credentials {
        c.execute(
            "UPDATE user_booru_sites SET username = ?4, api_key = ?5, session_cookie = ?6
             WHERE user_id = ?7 AND coalesce(preset_key, 'url:' || base_url) = ?1
               AND base_url = ?2 AND engine = ?3
               AND username IS NULL AND api_key IS NULL AND session_cookie IS NULL",
            params![site, base, engine, username, api_key, cookie, OWNER_ID],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::NOW;

    #[tokio::test]
    async fn an_old_server_account_moves_with_its_votes_sites_and_keys() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("data.db");
        let mut c = Connection::open(&old).unwrap();
        migrate_reference(&mut c).unwrap();
        c.execute_batch(&format!("
            INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at) VALUES
              ('u-me', 'Me', 'x', '/srv/me', {NOW}, {NOW}), ('u-other', 'other', 'x', '/srv/other', {NOW}, {NOW});
            INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status) VALUES
              ('d-me', 'u-me', '/srv/me', 'LOCAL', {NOW}, {NOW}, 'READY'),
              ('d-other', 'u-other', '/srv/other', 'LOCAL', {NOW}, {NOW}, 'READY');
            INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, duration_ms, created_at, updated_at) VALUES
              ('f-me', 'd-me', 'LOCAL', 'a.webm', 1, {NOW}, 'cafe', 'video', 1234.6, {NOW}, {NOW}),
              ('f-other', 'd-other', 'LOCAL', 'b.png', 1, {NOW}, 'beef', 'image', NULL, {NOW}, {NOW});
            INSERT INTO file_votes (file_id, score, last_vote_at) VALUES ('f-me', 1, {NOW}), ('f-other', -1, {NOW});
            INSERT INTO user_booru_sites (id, user_id, name, engine, base_url, api_key, is_preset, preset_key, enabled, sort_order, created_at, updated_at) VALUES
              ('s-me', 'u-me', 'e621', 'e621', 'https://e621.net', 'my-key', 1, 'e621', 1, 0, {NOW}, {NOW}),
              ('s-other', 'u-other', 'Other', 'danbooru', 'https://other.example', 'their-key', 0, NULL, 1, 1, {NOW}, {NOW});
        ")).unwrap();
        drop(c);

        let (records, credentials) = read_old(&old, "me").unwrap();
        let keys: Vec<String> = records
            .keys()
            .map(|(kind, key)| format!("{kind} {key}"))
            .collect();
        assert!(keys.contains(&r#"vote ["cafe"]"#.to_owned()), "{keys:?}");
        // Old servers stored some video durations as REAL.
        assert_eq!(
            records[&("file".to_owned(), r#"["cafe"]"#.to_owned())]["durationMs"],
            1235
        );
        assert!(
            !keys
                .iter()
                .any(|k| k.contains("beef") || k.contains("other.example")),
            "{keys:?}"
        );
        assert_eq!(
            credentials,
            [(
                "e621".to_owned(),
                "https://e621.net".to_owned(),
                "e621".to_owned(),
                None,
                Some("my-key".to_owned()),
                None
            )]
        );
        let mut moved = credentials.clone();
        moved[0].1 = "https://elsewhere.example".to_owned();

        let here = tempfile::tempdir().unwrap();
        let db = Database::open(&here.path().join("data"), &here.path().join("library")).unwrap();
        let worker = db.clone();
        db.call(move |c| {
            sync::take(c, &worker.sync, records)?;
            keep_credentials(c, &moved)?;
            let untouched: Option<String> = c.query_row(
                "SELECT api_key FROM user_booru_sites WHERE preset_key = 'e621'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(untouched, None, "a key must not reach another address");
            keep_credentials(c, &credentials)
        })
        .await
        .unwrap();
        let key: Option<String> = db
            .call(|c| {
                Ok(c.query_row(
                    "SELECT api_key FROM user_booru_sites WHERE preset_key = 'e621'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .await
            .unwrap();
        assert_eq!(key.as_deref(), Some("my-key"));
    }

    #[test]
    fn a_file_that_is_not_a_gooncave_database_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, "hello").unwrap();
        let error = read_old(&path, "me").err().unwrap().to_string();
        assert!(error.contains("not a GoonCave database"), "{error}");
    }
}
