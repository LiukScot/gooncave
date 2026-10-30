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

pub(crate) fn file_json(row: &Row) -> rusqlite::Result<Value> {
    let thumb: Option<String> = row.get("thumb_path")?;
    let thumb_url = thumb.as_deref().and_then(|thumb| {
        FsPath::new(thumb)
            .file_name()
            .map(|name| format!("/thumbnails/{}", name.to_string_lossy()))
    });
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "folderId": row.get::<_, String>("folder_id")?,
        "locationType": row.get::<_, String>("location_type")?,
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

/// Seeded shuffle weights: a given seed always gives the same order.
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
    let mut conditions = vec![
        "f.folder_id IN (SELECT id FROM library_folders WHERE user_id = ?)".to_owned(),
        "f.sha256 NOT IN (SELECT sha256 FROM trash)".to_owned(),
    ];
    let mut values: Vec<rusqlite::types::Value> = vec![OWNER_ID.to_owned().into()];
    if let Some(file) = query.get("fileId") {
        conditions.push("f.id = ?".into());
        values.push(file.clone().into());
    }
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

/// Moves the file to the trash on every device, or deletes it for good when the trash is off.
async fn remove(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    if !crate::originals::delete(&database, &id).await? {
        return Ok(not_found("File"));
    }
    Ok(Json(json!({"status": "deleted"})).into_response())
}

/// The parent/child group of the first post this file was saved from that has one.
async fn relations(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let sites = crate::boorus::sites(&database).await?;
    related_posts(
        &database,
        id,
        &sites,
        &crate::booru_http::Transport::default(),
    )
    .await
}

/// The booru posts a file was saved from, or `None` when the file does not exist.
async fn saved_posts(database: &Database, id: String) -> Result<Option<Vec<(String, String)>>> {
    database
        .call(move |connection| {
            if !file_exists(connection, &id)? {
                return Ok(None);
            }
            let mut statement = connection.prepare(
                "SELECT fav.provider, fav.remote_id FROM favorite_items fav
                 JOIN files f ON f.path = fav.file_path WHERE f.id = ?1
                 ORDER BY fav.created_at, fav.remote_id",
            )?;
            let rows = statement
                .query_map([&id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some(rows))
        })
        .await
}

async fn related_posts(
    database: &Database,
    id: String,
    sites: &[crate::boorus::Site],
    transport: &crate::booru_http::Transport,
) -> Result<Response> {
    let saved = saved_posts(database, id).await?;
    let Some(saved) = saved else {
        return Ok(not_found("File"));
    };
    // One booru being down must not hide a group another favorite can still show.
    let mut failure = None;
    for (provider, remote_id) in saved {
        let Some(site) = sites
            .iter()
            .find(|site| crate::booru_favorites::provider(site) == provider)
        else {
            continue;
        };
        // A site without groups would only cost a request, which on a browser-read site waits in a queue.
        if !crate::explore::has_groups(site) {
            continue;
        }
        match group_of(database, transport, site, &remote_id).await {
            Ok(posts) if posts.is_empty() => {}
            Ok(posts) => return Ok(Json(json!({"posts": posts})).into_response()),
            Err(error) => failure = failure.or(Some(error)),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(Json(json!({"posts": []})).into_response()),
    }
}

async fn group_of(
    database: &Database,
    transport: &crate::booru_http::Transport,
    site: &crate::boorus::Site,
    remote_id: &str,
) -> Result<Vec<Value>> {
    let Some(post) = crate::booru_engines::single(transport, site, remote_id).await? else {
        return Ok(Vec::new());
    };
    let parent = post["parentId"].as_str().map(str::to_owned);
    let children = post["hasChildren"].as_bool().unwrap_or(false);
    crate::explore::group(database, transport, site, remote_id, parent, children).await
}
/// The pools of the first post this file was saved from that is in one.
async fn pools(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let sites = crate::boorus::sites(&database).await?;
    file_pools(
        &database,
        id,
        &sites,
        &crate::booru_http::Transport::default(),
    )
    .await
}

async fn file_pools(
    database: &Database,
    id: String,
    sites: &[crate::boorus::Site],
    transport: &crate::booru_http::Transport,
) -> Result<Response> {
    let Some(saved) = saved_posts(database, id).await? else {
        return Ok(not_found("File"));
    };
    // One booru being down must not hide a pool another favorite can still show.
    let mut failure = None;
    for (provider, remote_id) in saved {
        let Some(site) = sites
            .iter()
            .find(|site| crate::booru_favorites::provider(site) == provider)
        else {
            continue;
        };
        match crate::explore::post_pool_navigators(transport, site, &remote_id, None).await {
            Ok(pools) if pools.is_empty() => {}
            Ok(pools) => return Ok(Json(json!({"pools": pools})).into_response()),
            Err(error) => failure = failure.or(Some(error)),
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(Json(json!({"pools": []})).into_response()),
    }
}
async fn source_text(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let sites = crate::boorus::sites(&database).await?;
    file_source_text(
        &database,
        id,
        &sites,
        &crate::booru_http::Transport::default(),
    )
    .await
}

async fn file_source_text(
    database: &Database,
    id: String,
    sites: &[crate::boorus::Site],
    transport: &crate::booru_http::Transport,
) -> Result<Response> {
    let Some(saved) = saved_posts(database, id).await? else {
        return Ok(not_found("File"));
    };
    let mut sources = Vec::new();
    // One booru being down must not hide the text another favorite can still show.
    let mut failure = None;
    for (provider, remote_id) in saved {
        // Opening a file must not contact a site the person turned off.
        let Some(site) = sites
            .iter()
            .find(|site| site.enabled && crate::booru_favorites::provider(site) == provider)
        else {
            continue;
        };
        match crate::explore::post_text_of(transport, site, &remote_id).await {
            Ok(text) => {
                let filled = |key: &str| !matches!(text[key].as_str(), None | Some(""));
                if filled("title") || filled("description") {
                    sources.push(json!({
                        "siteName": site.name,
                        "sourceUrl": crate::booru_engines::post_url(site, &remote_id)?,
                        "title": text["title"],
                        "description": text["description"],
                    }));
                }
            }
            // A post removed from the site has no text; the file is still here.
            Err(error) if crate::booru_http::is_not_found(&error) => {}
            Err(error) => {
                eprintln!(
                    "Cannot read the text of post {remote_id} on {}: {error}",
                    site.name
                );
                failure = failure.or(Some(error));
            }
        }
    }
    match failure {
        Some(error) if sources.is_empty() => Err(error),
        _ => Ok(Json(json!({ "sources": sources })).into_response()),
    }
}
async fn folders(State(database): State<Database>) -> Result<Json<Value>> {
    database
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, user_id, path, type, created_at, updated_at, last_scan_at FROM library_folders
                 WHERE user_id = ?1 ORDER BY path",
            )?;
            let folders = statement
                .query_map([OWNER_ID], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?, "userId": row.get::<_, String>(1)?,
                        "path": row.get::<_, String>(2)?, "type": row.get::<_, String>(3)?,
                        "createdAt": row.get::<_, String>(4)?, "updatedAt": row.get::<_, String>(5)?,
                        "lastScanAt": row.get::<_, Option<String>>(6)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Json(json!({"folders": folders})))
        })
        .await
}

/// Records that wait to apply: the total, then those of files this device has not received, and
/// of sites it does not have (a record whose file is here). Records of files deleted here are kept
/// in case the file comes back, and do not count.
pub(crate) const WAITING_BY_CAUSE: &str = "
    WITH waiting AS (
        SELECT kind, CASE
            WHEN kind = 'favorite' THEN json_extract(data, '$.sha256')
            WHEN kind IN ('file', 'suppression', 'vote', 'source', 'read_file', 'tag', 'relation')
                THEN substr(record_key, 3, 64)
        END AS sha
        FROM sync_records WHERE applied = 0
    ), placed AS (
        SELECT kind, sha,
            sha IN (SELECT sha256 FROM trash) AS deleted,
            EXISTS (SELECT 1 FROM files WHERE sha256 = waiting.sha) AS here
        FROM waiting
    )
    SELECT coalesce(sum(NOT coalesce(deleted, 0)), 0),
        coalesce(sum(sha IS NOT NULL AND NOT deleted AND NOT here), 0),
        coalesce(sum(NOT coalesce(deleted, 0)
            AND (kind = 'read_post' OR (kind IN ('tag', 'relation', 'favorite') AND here))), 0)
    FROM placed";

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
            let (waiting, missing, sites): (i64, i64, i64) = connection.query_row(
                WAITING_BY_CAUSE,
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            Ok(Json(json!({"scanning": scanning, "files": files, "found": found, "waiting": waiting,
                "waitingFor": {"missingFiles": missing, "missingSites": sites,
                    "other": waiting - missing - sites}})))
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
            let kind = match upload_kind(&target) {
                Ok(kind) => kind,
                Err(reason) => {
                    rejected.push(reject(&name, reason));
                    continue;
                }
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

/// The media kind of a file to add, or why it is refused.
fn upload_kind(target: &FsPath) -> std::result::Result<media::MediaKind, &'static str> {
    media::detect_kind(target).ok_or_else(|| {
        let raw = target
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                RAW_PHOTO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
            });
        if raw {
            "RAW photos are not supported. Export the photo as JPEG and upload it again."
        } else {
            "Unsupported file type"
        }
    })
}

/// Copies files from this device into the library root, with the checks of an upload. Returns
/// `{uploaded: [{name, fileId}], rejected: [{name, reason}]}` like the upload route.
pub async fn import_paths(database: &Database, paths: Vec<std::path::PathBuf>) -> Result<Value> {
    let root = database.library().root.clone();
    let lookup = root.to_string_lossy().into_owned();
    let folder_id: Option<String> = database
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT id FROM library_folders WHERE path = ?1 AND user_id = ?2 AND type = 'LOCAL'",
                    params![lookup, OWNER_ID],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await?;
    // The first scan creates the folder rows a moment after the app starts.
    let folder_id = folder_id.ok_or(Error::Unavailable(
        "The library is still being prepared. Try again in a moment.",
    ))?;
    let mut uploaded = Vec::new();
    let mut rejected = Vec::new();
    for source in paths {
        let original = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let Some(name) = upload_name(original.as_deref()) else {
            rejected
                .push(json!({"name": source.display().to_string(), "reason": "Invalid file name"}));
            continue;
        };
        let target = root.join(&name);
        let kind = match upload_kind(&target) {
            Ok(kind) => kind,
            Err(reason) => {
                rejected.push(json!({"name": name, "reason": reason}));
                continue;
            }
        };
        // A folder, or a device file that never ends, is not something to copy.
        if !tokio::fs::metadata(&source)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            rejected.push(json!({"name": name, "reason": "Only files can be added, not folders"}));
            continue;
        }
        let copied: std::io::Result<()> = async {
            let mut from = tokio::fs::File::open(&source).await?;
            let mut to = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .await?;
            let copied = tokio::io::copy(&mut from, &mut to)
                .await
                .and(to.flush().await);
            if copied.is_err() {
                drop(to);
                let _ = tokio::fs::remove_file(&target).await;
            }
            copied
        }
        .await;
        match copied {
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                rejected.push(json!({"name": name, "reason": "A file with this name already exists in the folder"}));
            }
            Err(error) => {
                eprintln!("Cannot copy {} into the library: {error}", source.display());
                rejected.push(json!({"name": name, "reason": "GoonCave could not read this file"}));
            }
            Ok(()) => match import_upload(database, &folder_id, &target, kind).await {
                Ok(file_id) => uploaded.push(json!({"name": name, "fileId": file_id})),
                Err(reason) => rejected.push(json!({"name": name, "reason": reason})),
            },
        }
    }
    if !uploaded.is_empty() {
        crate::duplicate_policy::notify(database, "local-library-changed").await;
    }
    Ok(json!({"uploaded": uploaded, "rejected": rejected}))
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
                .call(move |connection| {
                    let tx = connection.transaction()?;
                    let id = library::upsert(&tx, &folder_id, &scanned)?;
                    tx.commit()?;
                    Ok(id)
                })
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
    // Explore sends the posts it marked, so History can show them again.
    let posts = match body.get("posts") {
        None | Some(Value::Null) => None,
        Some(Value::Object(posts)) if scope == "post" => Some(posts.clone()),
        Some(_) => {
            return Err(Error::Invalid(
                "posts must map post keys to the posts.".into(),
            ))
        }
    };
    let media_key = match posts {
        Some(_) => Some(crate::explore::media_key(&database).await?),
        None => None,
    };
    database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            let mut unique = keys;
            unique.sort();
            unique.dedup();
            let mut unusable = 0;
            for key in &unique {
                let post = posts.as_ref().and_then(|posts| posts.get(key)).and_then(|post| {
                    let (site, remote) = key.split_once(':')?;
                    let kept = crate::read_history::snapshot(media_key.as_deref()?, site, remote, post);
                    if kept.is_none() {
                        unusable += 1;
                    }
                    kept
                });
                transaction.execute(
                    &format!("INSERT INTO read_marks (scope, item_key, user_id, read_at, post) VALUES (?1, ?2, ?3, {NOW}, ?4)
                     ON CONFLICT(scope, item_key, user_id) DO UPDATE SET read_at = excluded.read_at,
                       post = COALESCE(excluded.post, read_marks.post)"),
                    params![scope, key, OWNER_ID, post],
                )?;
            }
            if unusable > 0 {
                eprintln!("Read marks: kept {unusable} post(s) out of History; their copy was not a post of that key.");
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
    fn seed_weights_are_stable() {
        // Pinned values: changing them reorders every saved shuffle seed.
        assert_eq!(
            seed_weights("abc"),
            [791922743, 962823198, 248203565, 1375763090, 815402499, 907246436, 145783305]
        );
        assert_eq!(
            seed_weights("é1"),
            [1415252771, 1136159234, 3934891, 1560683460, 1085369873, 68637976, 1285968583]
        );
    }

    #[tokio::test]
    async fn waiting_records_are_counted_by_what_they_wait_for() {
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let here = "a".repeat(64);
        let gone = "b".repeat(64);
        let away = "c".repeat(64);
        let binned = "d".repeat(64);
        let counts = database
            .call(move |c| {
                c.execute_batch(&format!("
                    INSERT INTO folders (id, user_id, path, type, status, created_at, updated_at)
                      VALUES ('d', '{OWNER_ID}', '/library', 'LOCAL', 'ACTIVE', {NOW}, {NOW});
                    INSERT INTO files (id, folder_id, path, size_bytes, mtime, sha256, media_type, location_type, created_at, updated_at)
                      VALUES ('f', 'd', '/library/a.png', 1, {NOW}, '{here}', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                        ('g', 'd', '/library/d.png', 1, {NOW}, '{binned}', 'IMAGE', 'LOCAL', {NOW}, {NOW});
                    INSERT INTO trash (sha256, trashed_at) VALUES ('{gone}', {NOW}), ('{binned}', {NOW});
                    INSERT INTO sync_records (kind, record_key, data, changed_at, applied) VALUES
                      ('tag', '[\"{gone}\",\"wolf\",\"E621\"]', '{{}}', {NOW}, 0),
                      ('tag', '[\"{binned}\",\"wolf\",\"url:https://e6ai.net\"]', '{{}}', {NOW}, 0),
                      ('vote', '[\"{gone}\"]', '{{}}', {NOW}, 0),
                      ('tag', '[\"{away}\",\"wolf\",\"E621\"]', '{{}}', {NOW}, 0),
                      ('favorite', '[\"url:https://e6ai.net\",\"1\"]', '{{\"sha256\":\"{away}\"}}', {NOW}, 0),
                      ('tag', '[\"{here}\",\"wolf\",\"url:https://e6ai.net\"]', '{{}}', {NOW}, 0),
                      ('read_post', '[\"url:https://e6ai.net\",\"1\"]', '{{}}', {NOW}, 0),
                      ('setting', '[\"newer.setting\"]', '{{}}', {NOW}, 0),
                      ('tag', '[\"{here}\",\"fur\",\"E621\"]', '{{}}', {NOW}, 1);
                "))?;
                Ok(c.query_row(WAITING_BY_CAUSE, [], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })?)
            })
            .await
            .unwrap();
        assert_eq!(
            counts,
            (5, 2, 2),
            "total without deleted files, missing files, missing sites"
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

    #[tokio::test]
    async fn dropped_folders_and_unsupported_files_are_refused_without_copying() {
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(outside.join("album.png")).unwrap();
        std::fs::write(outside.join("notes.txt"), "hi").unwrap();
        let paths = vec![outside.join("album.png"), outside.join("notes.txt")];
        assert!(
            import_paths(&database, paths.clone()).await.is_err(),
            "no folder rows before the first scan"
        );
        library::scan(&database).await.unwrap();
        let result = import_paths(&database, paths).await.unwrap();
        assert_eq!(result["uploaded"], json!([]));
        let reasons: Vec<_> = result["rejected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["reason"].as_str().unwrap())
            .collect();
        assert_eq!(
            reasons,
            [
                "Only files can be added, not folders",
                "Unsupported file type"
            ]
        );
        assert!(!database.library().root.join("album.png").exists());
        assert!(!database.library().root.join("notes.txt").exists());
    }

    #[tokio::test]
    async fn a_file_saved_from_a_post_with_a_parent_lists_the_whole_group() {
        use axum::{extract::Request, response::IntoResponse, routing::any, Router};
        let post = |id: u32, parent: Option<u32>, children: bool| {
            json!({"id": id, "file": {"url": format!("https://cdn.example.com/{id}.jpg"), "width": 10, "height": 10, "ext": "jpg"},
                   "preview": {"url": format!("https://cdn.example.com/{id}.jpg")}, "score": {"total": 1}, "tags": {"general": ["x"]},
                   "relationships": {"parent_id": parent, "has_children": children}})
        };
        let app = Router::new().fallback(any(move |request: Request| async move {
            let query = request.uri().query().unwrap_or("").to_owned();
            let posts = if query.contains("parent%3A100") || query.contains("parent:100") {
                vec![
                    post(100, None, true),
                    post(101, Some(100), false),
                    post(102, Some(100), false),
                ]
            } else if query.contains("id%3A101") || query.contains("id:101") {
                vec![post(101, Some(100), false)]
            } else {
                vec![]
            };
            axum::Json(json!({"posts": posts})).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        database
            .call(|c| {
                c.execute_batch(&format!("
                    INSERT INTO folders (id, user_id, path, type, status, created_at, updated_at)
                      VALUES ('d', '{OWNER_ID}', '/library', 'LOCAL', 'ACTIVE', {NOW}, {NOW});
                    INSERT INTO active_library_folders (id) VALUES ('d');
                    INSERT INTO files (id, folder_id, path, size_bytes, mtime, sha256, media_type, location_type, created_at, updated_at)
                      VALUES ('f', 'd', '/library/a.jpg', 1, {NOW}, 'sha', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('lonely', 'd', '/library/b.jpg', 1, {NOW}, 'sha2', 'IMAGE', 'LOCAL', {NOW}, {NOW});
                    INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, created_at, updated_at)
                      VALUES ('{OWNER_ID}', 'e621-test', '101', '/library/a.jpg', 'https://e621.net/posts/101', {NOW}, {NOW});"))?;
                Ok(())
            })
            .await
            .unwrap();
        let sites = vec![crate::boorus::Site {
            id: "e621-test".into(),
            name: "e621".into(),
            engine: "e621".into(),
            base,
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        }];
        let transport = crate::booru_http::Transport {
            allow_loopback: true,
        };
        let ask = |id: &'static str| {
            let (database, sites, transport) = (database.clone(), sites.clone(), transport.clone());
            async move {
                let response = related_posts(&database, id.into(), &sites, &transport)
                    .await
                    .unwrap();
                let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                ((), serde_json::from_slice::<Value>(&bytes).unwrap())
            }
        };
        let (_, body) = ask("f").await;
        let ids: Vec<_> = body["posts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["remoteId"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            ["100", "101", "102"],
            "the parent comes first, then its children"
        );
        assert_eq!(body["posts"][1]["isCurrent"], true);
        assert_eq!(body["posts"][0]["isParent"], true);
        let (_, body) = ask("lonely").await;
        assert_eq!(
            body["posts"],
            json!([]),
            "a file saved from no post has no group"
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_file_saved_from_a_post_in_a_pool_lists_the_pool_and_its_neighbours() {
        use axum::{extract::Request, response::IntoResponse, routing::any, Router};
        let app = Router::new().fallback(any(move |request: Request| async move {
            if request.uri().path() == "/pools/3.json" {
                return axum::Json(json!({"id": 3, "name": "My_comic", "post_ids": [100, 101, 102]})).into_response();
            }
            let query = request.uri().query().unwrap_or("");
            let posts = if query.contains("id%3A101") || query.contains("id:101") {
                vec![json!({"id": 101, "file": {"url": "https://cdn.example.com/101.jpg", "width": 10, "height": 10, "ext": "jpg"},
                    "preview": {"url": "https://cdn.example.com/101.jpg"}, "score": {"total": 1}, "tags": {"general": ["x"]},
                    "pools": [3], "relationships": {"parent_id": null, "has_children": false}})]
            } else {
                vec![]
            };
            axum::Json(json!({"posts": posts})).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        database
            .call(|c| {
                c.execute_batch(&format!("
                    INSERT INTO folders (id, user_id, path, type, status, created_at, updated_at)
                      VALUES ('d', '{OWNER_ID}', '/library', 'LOCAL', 'ACTIVE', {NOW}, {NOW});
                    INSERT INTO active_library_folders (id) VALUES ('d');
                    INSERT INTO files (id, folder_id, path, size_bytes, mtime, sha256, media_type, location_type, created_at, updated_at)
                      VALUES ('f', 'd', '/library/a.jpg', 1, {NOW}, 'sha', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('lonely', 'd', '/library/b.jpg', 1, {NOW}, 'sha2', 'IMAGE', 'LOCAL', {NOW}, {NOW});
                    INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, created_at, updated_at)
                      VALUES ('{OWNER_ID}', 'e621-test', '101', '/library/a.jpg', 'https://e621.net/posts/101', {NOW}, {NOW});"))?;
                Ok(())
            })
            .await
            .unwrap();
        let sites = vec![crate::boorus::Site {
            id: "e621-test".into(),
            name: "e621".into(),
            engine: "e621".into(),
            base,
            username: None,
            key: None,
            cookie: None,
            enabled: true,
            public: Value::Null,
        }];
        let transport = crate::booru_http::Transport {
            allow_loopback: true,
        };
        let ask = |id: &'static str| {
            let (database, sites, transport) = (database.clone(), sites.clone(), transport.clone());
            async move {
                let response = file_pools(&database, id.into(), &sites, &transport)
                    .await
                    .unwrap();
                let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                serde_json::from_slice::<Value>(&bytes).unwrap()
            }
        };
        let body = ask("f").await;
        let pool = &body["pools"][0];
        assert_eq!(pool["name"], "My comic");
        assert_eq!(pool["position"], 2);
        assert_eq!(pool["postCount"], 3);
        assert_eq!(pool["prevId"], "100");
        assert_eq!(pool["nextId"], "102");
        assert_eq!(
            ask("lonely").await["pools"],
            json!([]),
            "a file saved from no post is in no pool"
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_file_shows_the_text_of_the_posts_it_was_saved_from() {
        use axum::{
            extract::Request, http::StatusCode, response::IntoResponse, routing::any, Router,
        };
        let app = Router::new().fallback(any(|request: Request| async move {
            match request.uri().path() {
                "/posts/101.json" => {
                    axum::Json(json!({"post": {"description": "[b]Fake text[/b]"}})).into_response()
                }
                "/posts/102.json" => {
                    axum::Json(json!({"post": {"description": ""}})).into_response()
                }
                "/posts/103.json" => StatusCode::NOT_FOUND.into_response(),
                "/secret.json" => axum::Json(json!({"post": {"description": "Not for this file"}}))
                    .into_response(),
                _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        database
            .call(|c| {
                c.execute_batch(&format!("
                    INSERT INTO folders (id, user_id, path, type, status, created_at, updated_at)
                      VALUES ('d', '{OWNER_ID}', '/library', 'LOCAL', 'ACTIVE', {NOW}, {NOW});
                    INSERT INTO active_library_folders (id) VALUES ('d');
                    INSERT INTO files (id, folder_id, path, size_bytes, mtime, sha256, media_type, location_type, created_at, updated_at)
                      VALUES ('text', 'd', '/library/a.jpg', 1, {NOW}, 'sha1', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('blank', 'd', '/library/b.jpg', 1, {NOW}, 'sha2', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('down', 'd', '/library/c.jpg', 1, {NOW}, 'sha3', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('off', 'd', '/library/d.jpg', 1, {NOW}, 'sha4', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('lonely', 'd', '/library/e.jpg', 1, {NOW}, 'sha5', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('gone', 'd', '/library/f.jpg', 1, {NOW}, 'sha6', 'IMAGE', 'LOCAL', {NOW}, {NOW}),
                             ('forged', 'd', '/library/g.jpg', 1, {NOW}, 'sha7', 'IMAGE', 'LOCAL', {NOW}, {NOW});
                    INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, created_at, updated_at) VALUES
                      ('{OWNER_ID}', 'on', '999', '/library/a.jpg', 'x', {NOW}, {NOW}),
                      ('{OWNER_ID}', 'on', '101', '/library/a.jpg', 'x', {NOW}, {NOW}),
                      ('{OWNER_ID}', 'on', '102', '/library/b.jpg', 'x', {NOW}, {NOW}),
                      ('{OWNER_ID}', 'on', '998', '/library/c.jpg', 'x', {NOW}, {NOW}),
                      ('{OWNER_ID}', 'disabled', '101', '/library/d.jpg', 'x', {NOW}, {NOW}),
                      ('{OWNER_ID}', 'on', '103', '/library/f.jpg', 'x', {NOW}, {NOW}),
                      ('{OWNER_ID}', 'on', '../secret', '/library/g.jpg', 'x', {NOW}, {NOW});"))?;
                Ok(())
            })
            .await
            .unwrap();
        let site = |id: &str, enabled| crate::boorus::Site {
            id: id.into(),
            name: "Booru".into(),
            engine: "e621".into(),
            base: base.clone(),
            username: None,
            key: None,
            cookie: None,
            enabled,
            public: Value::Null,
        };
        let sites = vec![site("on", true), site("disabled", false)];
        let transport = crate::booru_http::Transport {
            allow_loopback: true,
        };
        let ask = |id: &'static str| {
            let (database, sites, transport) = (database.clone(), sites.clone(), transport.clone());
            async move { file_source_text(&database, id.into(), &sites, &transport).await }
        };
        let body = |response: Response| async move {
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            serde_json::from_slice::<Value>(&bytes).unwrap()
        };
        assert_eq!(
            body(ask("text").await.unwrap()).await["sources"],
            json!([{
                "siteName": "Booru",
                "sourceUrl": format!("{base}/posts/101"),
                "title": null,
                "description": "**Fake text**"
            }]),
            "a booru that fails does not hide the text another post has"
        );
        for id in ["blank", "off", "lonely", "gone"] {
            assert_eq!(
                body(ask(id).await.unwrap()).await["sources"],
                json!([]),
                "{id} has no text to show"
            );
        }
        assert!(ask("down").await.is_err(), "no answer is not an empty text");
        assert!(
            ask("forged").await.is_err(),
            "an id from the sync folder must not choose the address"
        );
        assert_eq!(
            ask("missing").await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        server.abort();
    }
}
