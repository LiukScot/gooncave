use std::{
    path::Path as FsPath,
    sync::{atomic::Ordering, Arc},
};

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use rusqlite::{params, params_from_iter, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::{io::AsyncWriteExt, sync::Semaphore, task::JoinSet};

use crate::{
    db::{Database, OWNER_ID},
    library::{self, NOW},
    media, Error, Result,
};

const MAX_PAGE: i64 = 1000;
const MAX_READ_KEYS: usize = 500;
const MAX_READ_KEY_LENGTH: usize = 256;
// Same ceiling as the reference backend's multipart file limit.
const MAX_UPLOAD_BYTES: usize = 500 * 1024 * 1024;
const RAW_PHOTO_EXTENSIONS: &[&str] = &["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/files", get(list))
        .route("/files/{id}", delete(remove))
        .route("/files/{id}/vote", post(vote))
        .route("/files/{id}/relations", get(relations))
        .route("/files/{id}/pools", get(pools))
        .route("/files/{id}/source-text", get(source_text))
        .route("/library/progress", get(progress))
        .route("/folders", get(folders).post(add_folder))
        .route("/folders/{id}", delete(remove_folder))
        .route(
            "/folders/{id}/uploads",
            post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route("/thumbnails/{name}", get(thumbnail))
        .route("/read-marks", post(mark_read).delete(clear_read))
}

pub(crate) fn not_found(what: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": format!("{what} not found")})),
    )
        .into_response()
}

fn file_json(row: &Row) -> rusqlite::Result<Value> {
    let thumb: Option<String> = row.get("thumb_path")?;
    let thumb_url = thumb.as_deref().and_then(|thumb| {
        FsPath::new(thumb)
            .file_name()
            .map(|name| format!("/thumbnails/{}", name.to_string_lossy()))
    });
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "folderId": row.get::<_, String>("folder_id")?,
        "locationType": "LOCAL",
        "path": row.get::<_, String>("path")?,
        "sizeBytes": row.get::<_, i64>("size_bytes")?,
        "mtime": row.get::<_, String>("mtime")?,
        "sha256": row.get::<_, String>("sha256")?,
        "phash": row.get::<_, Option<String>>("phash")?,
        "mediaType": row.get::<_, String>("media_type")?,
        "width": row.get::<_, Option<i64>>("width")?,
        "height": row.get::<_, Option<i64>>("height")?,
        "durationMs": row.get::<_, Option<i64>>("duration_ms")?,
        "thumbPath": thumb,
        "thumbUrl": thumb_url,
        "voteScore": row.get::<_, Option<i64>>("vote_score")?.unwrap_or(0),
        "nextVoteAt": row.get::<_, Option<String>>("next_vote_at")?,
        "providers": {},
        "favoriteProviders": serde_json::from_str::<Value>(&row.get::<_, String>("favorite_providers")?).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0,rusqlite::types::Type::Text,Box::new(e)))?,
        "hasRelations": false,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

/// Seeded shuffle weights, ported from the reference backend so a seed gives the same order there and here.
fn seed_weights(seed: &str) -> [i64; 7] {
    const MODULUS: u32 = 2_147_483_647;
    let mut hash: u32 = 0x811c_9dc5;
    for unit in seed.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let mut weights = [0; 7];
    for weight in &mut weights {
        hash ^= 0x9e37_79b9;
        hash = hash.wrapping_mul(0x0100_0193);
        *weight = i64::from(hash % (MODULUS - 1) + 1);
    }
    weights
}

async fn list(
    State(database): State<Database>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    database.call(move |connection| {
    let number = |name: &str| -> Result<Option<i64>> {
        query
            .get(name)
            .map(|value| {
                value
                    .parse::<i64>()
                    .map_err(|_| Error::Invalid(format!("{name} must be a whole number.")))
            })
            .transpose()
    };
    let limit = number("limit")?;
    if limit.is_some_and(|limit| !(1..=MAX_PAGE).contains(&limit)) {
        return Err(Error::Invalid(format!(
            "limit must be from 1 through {MAX_PAGE}."
        )));
    }
    let offset = number("offset")?;
    if offset.is_some_and(|offset| offset < 0) {
        return Err(Error::Invalid("offset cannot be negative.".into()));
    }
    let mut conditions =
        vec!["f.folder_id IN (SELECT id FROM library_folders WHERE user_id = ?)".to_owned()];
    let mut values: Vec<rusqlite::types::Value> = vec![OWNER_ID.to_owned().into()];
    if let Some(folder) = query.get("folderId") {
        conditions.push("f.folder_id = ?".into());
        values.push(folder.clone().into());
    }
    match query.get("mediaType").map(String::as_str) {
        None => {}
        Some(kind @ ("IMAGE" | "VIDEO")) => {
            conditions.push("f.media_type = ?".into());
            values.push(kind.to_owned().into());
        }
        Some(_) => return Err(Error::Invalid("mediaType must be IMAGE or VIDEO.".into())),
    }
    let tags = crate::search::filter(connection,query.get("tags").map(String::as_str).unwrap_or(""))?;
    conditions.extend(tags.conditions);
    values.extend(tags.values);
    let mut all_values = tags.join_values;
    all_values.extend(values);
    let values = all_values;
    let joins = tags.joins;
    let filter = format!("WHERE {}", conditions.join(" AND "));
    let mut order_values: Vec<rusqlite::types::Value> = Vec::new();
    let order = match query.get("sort").map(String::as_str) {
        None => "f.created_at DESC, f.id DESC",
        Some("mtime_desc") => "f.mtime DESC, f.id DESC",
        Some("mtime_asc") => "f.mtime ASC, f.id ASC",
        // Ties break on who reached the score first; never-voted files keep newest-first order.
        Some("rated") => "COALESCE(v.score, 0) DESC, CASE WHEN v.last_vote_at IS NULL THEN 1 ELSE 0 END ASC, v.last_vote_at ASC, f.mtime DESC, f.id DESC",
        Some("random") => match query.get("seed").map(|seed| seed.trim()).filter(|seed| !seed.is_empty()) {
            Some(seed) => {
                order_values.extend(seed_weights(seed).map(rusqlite::types::Value::from));
                "((ifnull(unicode(substr(f.id, 1, 1)), 0) * ? + ifnull(unicode(substr(f.id, 2, 1)), 0) * ?
                   + ifnull(unicode(substr(f.id, 3, 1)), 0) * ? + ifnull(unicode(substr(f.id, 4, 1)), 0) * ?
                   + ifnull(unicode(substr(f.id, -1, 1)), 0) * ? + ifnull(unicode(substr(f.id, -2, 1)), 0) * ?
                   + ?) % 2147483647) ASC, f.id ASC"
            }
            None => "RANDOM()",
        },
        Some(_) => {
            return Err(Error::Invalid(
                "sort must be mtime_desc, mtime_asc, random or rated.".into(),
            ))
        }
    };
    let page_sql = format!(
        "SELECT f.*, v.score AS vote_score,
           (SELECT json_group_array(provider) FROM favorite_items fav WHERE fav.user_id=(SELECT user_id FROM library_folders WHERE id=f.folder_id) AND fav.file_path=f.path) AS favorite_providers,
           strftime('%Y-%m-%dT%H:%M:%fZ', v.last_vote_at, '+1 day') AS next_vote_at
         FROM files f {joins} LEFT JOIN file_votes v ON v.file_id = f.id
         {filter} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    let mut page_values = values.clone();
    page_values.extend(order_values);
    page_values.push(limit.unwrap_or(-1).into());
    page_values.push(offset.unwrap_or(0).into());
            let total: i64 = connection.query_row(
                &format!("SELECT count(*) FROM files f {joins} {filter}"),
                params_from_iter(values),
                |row| row.get(0),
            )?;
            let mut statement = connection.prepare(&page_sql)?;
            let mut files = statement
                .query_map(params_from_iter(page_values), file_json)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            crate::source_store::attach_runs(connection,&mut files)?;
            Ok(Json(json!({"files": files, "total": total})))
        })
        .await
}

pub(crate) fn file_exists(connection: &rusqlite::Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM files JOIN library_folders AS folders ON folders.id = files.folder_id WHERE files.id = ?1 AND folders.user_id = ?2)",
        params![id, OWNER_ID],
        |row| row.get(0),
    )?)
}

async fn vote(
    State(database): State<Database>,
    Path(id): Path<String>,
    payload: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Response> {
    let delta = payload
        .ok()
        .and_then(|Json(body)| body.get("value").and_then(Value::as_i64))
        .filter(|value| *value == 1 || *value == -1)
        .ok_or_else(|| Error::Invalid("Send {\"value\": 1} or {\"value\": -1}.".into()))?;
    database
        .call(move |connection| {
            if !file_exists(connection, &id)? {
                return Ok(not_found("File"));
            }
            let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let current: Option<(i64, bool, String)> = transaction
                .query_row(
                    "SELECT score, last_vote_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),
                       strftime('%Y-%m-%dT%H:%M:%fZ', last_vote_at, '+1 day') FROM file_votes WHERE file_id = ?1",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let score = current.as_ref().map_or(0, |current| current.0);
            let next = current.as_ref().map(|current| current.2.clone());
            // A downvote at zero is never valid; the 24-hour cooldown is only about timing.
            let refusal = if delta == -1 && score == 0 {
                Some("This file is already at zero and cannot go lower.")
            } else if current.as_ref().is_some_and(|current| current.1) {
                Some("This file was already voted in the last 24 hours.")
            } else {
                None
            };
            if let Some(message) = refusal {
                return Ok((
                    StatusCode::CONFLICT,
                    Json(json!({"error": message, "voteScore": score, "nextVoteAt": next})),
                )
                    .into_response());
            }
            let next: String = transaction.query_row(
                &format!(
                    "INSERT INTO file_votes (file_id, score, last_vote_at) VALUES (?1, ?2, {NOW})
                     ON CONFLICT(file_id) DO UPDATE SET score = excluded.score, last_vote_at = excluded.last_vote_at
                     RETURNING strftime('%Y-%m-%dT%H:%M:%fZ', last_vote_at, '+1 day')"
                ),
                params![id, score + delta],
                |row| row.get(0),
            )?;
            transaction.commit()?;
            Ok(Json(json!({"status": "ok", "voteScore": score + delta, "nextVoteAt": next})).into_response())
        })
        .await
}

async fn remove(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let lookup = id.clone();
    let record: Option<(String, String)> = database
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT files.path, folders.path FROM files JOIN library_folders AS folders ON folders.id = files.folder_id
                     WHERE files.id = ?1 AND folders.user_id = ?2 AND folders.type = 'LOCAL'",
                    params![lookup, OWNER_ID],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })
        .await?;
    let Some((path, folder)) = record else {
        return Ok(not_found("File"));
    };
    let path = database
        .library()
        .resolve_file(FsPath::new(&folder), FsPath::new(&path))?;
    let _favorites_guard = database.favorites.writes.lock().await;
    crate::favorite_library::reverse_before_delete(&database, &path).await?;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!("Cannot delete {}: {error}", path.display());
            return Ok((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "GoonCave could not delete the file from disk. Check that the library folder is writable, then try again."})),
            )
                .into_response());
        }
    }
    let orphans = database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            let orphans = library::forget_files(&transaction, &[id])?;
            transaction.commit()?;
            Ok(orphans)
        })
        .await?;
    library::remove_thumbnails(&database.library().thumbnails, orphans).await;
    crate::duplicate_policy::notify(&database, "local-library-changed").await;
    Ok(Json(json!({"status": "deleted"})).into_response())
}

/// An empty panel while nothing in the core writes `table`; a populated table is reported, not hidden.
async fn empty_panel(
    database: Database,
    id: String,
    table: &'static str,
    value: Value,
) -> Result<Response> {
    database
        .call(move |connection| {
            if !file_exists(connection, &id)? {
                return Ok(not_found("File"));
            }
            let count: i64 = connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))?;
            if count != 0 {
                return Err(Error::Unavailable("This library feature is not available in this development build. Your saved data has not been changed."));
            }
            Ok(Json(value).into_response())
        })
        .await
}

async fn relations(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    empty_panel(database, id, "file_post_relations", json!({"posts": []})).await
}
async fn pools(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    empty_panel(database, id, "file_post_relations", json!({"pools": []})).await
}
async fn source_text(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    database
        .call(move |c| {
            if !file_exists(c, &id)? {
                return Ok(not_found("File"));
            }
            Ok(Json(json!({"sources":[]})).into_response())
        })
        .await
}
async fn folders(State(database): State<Database>) -> Result<Json<Value>> {
    database
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, user_id, path, type, created_at, updated_at, last_scan_at, status FROM library_folders
                 WHERE user_id = ?1 ORDER BY path",
            )?;
            let folders = statement
                .query_map([OWNER_ID], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?, "userId": row.get::<_, String>(1)?,
                        "path": row.get::<_, String>(2)?, "type": row.get::<_, String>(3)?,
                        "createdAt": row.get::<_, String>(4)?, "updatedAt": row.get::<_, String>(5)?,
                        "lastScanAt": row.get::<_, Option<String>>(6)?, "status": row.get::<_, String>(7)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Json(json!({"folders": folders})))
        })
        .await
}

/// How far the library scan is, and how many synced or imported records still wait for a file.
async fn progress(State(database): State<Database>) -> Result<Json<Value>> {
    let scanning = database.scan.running.load(Ordering::Relaxed);
    let found = database.scan.found();
    database
        .call(move |connection| {
            let files: i64 = connection.query_row(
                "SELECT count(*) FROM files JOIN library_folders ON library_folders.id = files.folder_id",
                [],
                |row| row.get(0),
            )?;
            let waiting: i64 = connection.query_row(
                "SELECT count(*) FROM sync_records WHERE applied = 0",
                [],
                |row| row.get(0),
            )?;
            Ok(Json(json!({"scanning": scanning, "files": files, "found": found, "waiting": waiting})))
        })
        .await
}

async fn add_folder(State(database): State<Database>) -> Error {
    Error::Invalid(format!(
        "GoonCave keeps your library in {}. Create a subfolder there to add a folder.",
        database.library().root.display()
    ))
}

async fn remove_folder(State(database): State<Database>) -> Error {
    Error::Invalid(format!(
        "Folders follow the subfolders of {}. Move or delete the subfolder there to remove it.",
        database.library().root.display()
    ))
}

fn upload_name(name: Option<&str>) -> Option<String> {
    let name = FsPath::new(name?.trim()).file_name()?.to_str()?;
    (name != "." && name != "..").then(|| name.to_owned())
}

async fn upload(
    State(database): State<Database>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Result<Response> {
    let lookup = id.clone();
    let folder: Option<String> = database
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT path FROM library_folders WHERE id = ?1 AND user_id = ?2 AND type = 'LOCAL'",
                    params![lookup, OWNER_ID],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await?;
    let Some(folder) = folder else {
        return Ok(not_found("Folder"));
    };
    let folder = database.library().resolve_folder(FsPath::new(&folder))?;
    let mut uploaded = Vec::new();
    let mut rejected = Vec::new();
    // Each file costs a few FFmpeg runs; a batch would otherwise wait for them one after another.
    let processing = Arc::new(Semaphore::new(
        std::thread::available_parallelism().map_or(2, |count| count.get().min(4)),
    ));
    let mut imports = JoinSet::new();
    let read: Result<()> = async {
        while let Some(mut field) = multipart
            .next_field()
            .await
            .map_err(|error| Error::Invalid(format!("Upload interrupted: {error}")))?
        {
            let Some(original) = field.file_name().map(str::to_owned) else {
                continue;
            };
            let reject = |name: &str, reason: &str| json!({"name": name, "reason": reason});
            let Some(name) = upload_name(Some(&original)) else {
                rejected.push(reject(original.trim(), "Invalid file name"));
                continue;
            };
            let target = folder.join(&name);
            let Some(kind) = media::detect_kind(&target) else {
                let raw = target
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        RAW_PHOTO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                    });
                rejected.push(reject(
                &name,
                if raw {
                    "RAW photos are not supported. Export the photo as JPEG and upload it again."
                } else {
                    "Unsupported file type"
                },
            ));
                continue;
            };
            let mut file = match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .await
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    rejected.push(reject(
                        &name,
                        "A file with this name already exists in the folder",
                    ));
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            let written: Result<()> = async {
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|error| Error::Invalid(format!("Upload interrupted: {error}")))?
                {
                    file.write_all(&chunk).await?;
                }
                file.flush().await?;
                Ok(())
            }
            .await;
            drop(file);
            if let Err(error) = written {
                let _ = tokio::fs::remove_file(&target).await;
                return Err(error);
            }
            let permit = processing
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Error::Storage("upload queue closed".into()))?;
            let (database, folder_id, index) = (database.clone(), id.clone(), imports.len());
            imports.spawn(async move {
                let _permit = permit;
                (
                    index,
                    import_upload(&database, &folder_id, &target, kind)
                        .await
                        .map_err(|reason| (name.clone(), reason))
                        .map(|file_id| json!({"name": name, "fileId": file_id})),
                )
            });
        }
        Ok(())
    }
    .await;
    let mut imported = imports.join_all().await;
    // Fields read before a failure still finish, so a refused file never stays on disk.
    read?;
    imported.sort_by_key(|(index, _)| *index);
    for (_, result) in imported {
        match result {
            Ok(file) => uploaded.push(file),
            Err((name, reason)) => rejected.push(json!({"name": name, "reason": reason})),
        }
    }
    if uploaded.is_empty() && rejected.is_empty() {
        return Err(Error::Invalid("No files were provided".into()));
    }
    if !uploaded.is_empty() {
        crate::duplicate_policy::notify(&database, "local-library-changed").await;
    }
    Ok(Json(json!({"uploaded": uploaded, "rejected": rejected})).into_response())
}

/// Checks and indexes one written upload; on failure removes it and returns the reason to show.
async fn import_upload(
    database: &Database,
    folder_id: &str,
    target: &FsPath,
    kind: media::MediaKind,
) -> std::result::Result<String, &'static str> {
    // The extension is only a label: a script renamed to .jpg is refused.
    let reason = if media::content_matches(target, kind).await {
        let indexed: Result<String> = async {
            let metadata = tokio::fs::metadata(target).await?;
            let size = i64::try_from(metadata.len())
                .map_err(|_| Error::Storage("file too large".into()))?;
            let scanned = library::process(
                database,
                target,
                size,
                library::iso_millis(metadata.modified()?),
                None,
            )
            .await?;
            let folder_id = folder_id.to_owned();
            database
                .call(move |connection| library::upsert(connection, &folder_id, &scanned))
                .await
        }
        .await;
        match indexed {
            Ok(file_id) => return Ok(file_id),
            Err(error) => {
                eprintln!("Cannot import upload {}: {error}", target.display());
                "GoonCave could not read this file"
            }
        }
    } else {
        "File content does not match its extension"
    };
    if let Err(error) = tokio::fs::remove_file(target).await {
        eprintln!(
            "Cannot remove rejected upload {}: {error}",
            target.display()
        );
    }
    Err(reason)
}

async fn thumbnail(State(database): State<Database>, Path(name): Path<String>) -> Result<Response> {
    // Thumbnail names are hash prefixes plus a suffix; anything else could leave the directory.
    if name.starts_with('.')
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '.'
        })
    {
        return Ok(not_found("Thumbnail"));
    }
    let path = database.library().thumbnails.join(&name);
    let stored = path.to_string_lossy().into_owned();
    let active = database.call(move |connection| {
        Ok(connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM files JOIN library_folders ON files.folder_id = library_folders.id WHERE files.thumb_path = ?1)",
            [stored], |row| row.get::<_, bool>(0),
        )?)
    }).await?;
    if !active {
        return Ok(not_found("Thumbnail"));
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = if name.ends_with(".webp") {
                "image/webp"
            } else {
                "image/jpeg"
            };
            // The name holds the file hash and the thumbnail rule, so the bytes never change.
            Ok((
                [
                    (header::CONTENT_TYPE, mime),
                    (
                        header::CACHE_CONTROL,
                        "private, max-age=31536000, immutable",
                    ),
                ],
                bytes,
            )
                .into_response())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(not_found("Thumbnail")),
        Err(error) => Err(error.into()),
    }
}

fn read_scope(value: Option<&Value>) -> Result<&'static str> {
    match value.and_then(Value::as_str) {
        Some("file") => Ok("file"),
        Some("post") => Ok("post"),
        _ => Err(Error::Invalid("scope must be file or post.".into())),
    }
}

async fn mark_read(
    State(database): State<Database>,
    payload: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let Json(body) =
        payload.map_err(|_| Error::Invalid("Send a JSON body with scope and keys.".into()))?;
    let scope = read_scope(body.get("scope"))?;
    let keys: Vec<String> = body
        .get("keys")
        .and_then(Value::as_array)
        .filter(|keys| (1..=MAX_READ_KEYS).contains(&keys.len()))
        .and_then(|keys| {
            keys.iter()
                .map(|key| key.as_str().filter(|key| (1..=MAX_READ_KEY_LENGTH).contains(&key.len())).map(str::to_owned))
                .collect()
        })
        .ok_or_else(|| Error::Invalid(format!("keys must hold 1 through {MAX_READ_KEYS} strings of 1 through {MAX_READ_KEY_LENGTH} characters.")))?;
    database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            let mut unique = keys;
            unique.sort();
            unique.dedup();
            for key in &unique {
                transaction.execute(
                    &format!("INSERT INTO read_marks (scope, item_key, user_id, read_at) VALUES (?1, ?2, ?3, {NOW})
                     ON CONFLICT(scope, item_key, user_id) DO UPDATE SET read_at = excluded.read_at"),
                    params![scope, key, OWNER_ID],
                )?;
            }
            transaction.commit()?;
            Ok(Json(json!({"marked": unique.len()})))
        })
        .await
}

async fn clear_read(
    State(database): State<Database>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let scope = read_scope(
        query
            .get("scope")
            .map(|scope| Value::from(scope.as_str()))
            .as_ref(),
    )?;
    database
        .call(move |connection| {
            let cleared = connection.execute(
                "DELETE FROM read_marks WHERE scope = ?1 AND user_id = ?2",
                params![scope, OWNER_ID],
            )?;
            Ok(Json(json!({"cleared": cleared})))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_weights_match_the_reference_backend() {
        // Output of seedToOrderParams in backend/src/db/repos/files/shared.ts.
        assert_eq!(
            seed_weights("abc"),
            [791922743, 962823198, 248203565, 1375763090, 815402499, 907246436, 145783305]
        );
        assert_eq!(
            seed_weights("é1"),
            [1415252771, 1136159234, 3934891, 1560683460, 1085369873, 68637976, 1285968583]
        );
    }

    #[test]
    fn upload_names_cannot_leave_the_folder() {
        assert_eq!(
            upload_name(Some("../../etc/passwd.jpg")).as_deref(),
            Some("passwd.jpg")
        );
        assert_eq!(upload_name(Some("..")), None);
        assert_eq!(upload_name(Some("  ")), None);
    }
}
