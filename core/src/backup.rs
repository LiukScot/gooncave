//! Backups moved by hand: a file in the sync format to download or import. An import merges like a
//! sync, so nothing on this device is deleted.

use crate::{db::Database, sync, Error, Result};
use axum::{
    extract::{multipart::MultipartError, DefaultBodyLimit, Multipart, State},
    http::header,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::Value;

/// A backup file is compressed; this is far above any library's.
const MAX_BACKUP_BYTES: usize = 1 << 30;

pub(crate) fn routes() -> Router<Database> {
    Router::new().route(
        "/backup",
        get(download)
            .post(restore)
            .layer(DefaultBodyLimit::max(MAX_BACKUP_BYTES)),
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
    let worker = db.clone();
    let result = db
        .call(move |c| sync::import_backup(c, &worker.sync, &bytes))
        .await?;
    db.sync.wake.notify_one();
    Ok(Json(result))
}
