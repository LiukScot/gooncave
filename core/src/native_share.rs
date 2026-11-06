//! The system share sheet, which only the iPhone shell can show. The web page's own share
//! (`navigator.share`) opens it as a small panel pinned to the button that was touched; the
//! shell shows it the way the system's own apps do.
use std::{path::PathBuf, sync::OnceLock};

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{db::Database, photos::Pending, Error, Result};

/// What goes into the share sheet.
#[derive(Debug, PartialEq, Eq)]
pub enum ShareItem {
    /// A file of the library, by its path on this device.
    File(PathBuf),
    /// A web address.
    Link(String),
}

pub trait ShareSheet: Send + Sync {
    /// Shows the share sheet with `item`. True when the person sent it somewhere, false when
    /// they closed the sheet.
    fn share(&self, item: ShareItem) -> Pending<bool>;
}

static SHEET: OnceLock<Box<dyn ShareSheet>> = OnceLock::new();

/// Registers the share sheet once at startup; later calls are ignored.
pub fn register(sheet: Box<dyn ShareSheet>) {
    let _ = SHEET.set(sheet);
}

pub(crate) fn get() -> Option<&'static dyn ShareSheet> {
    SHEET.get().map(|sheet| sheet.as_ref())
}

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/share/files/{id}", post(share_file))
        .route("/share/link", post(share_link))
}

fn sheet() -> Result<&'static dyn ShareSheet> {
    get().ok_or(Error::Unavailable(
        "The system share sheet needs the iPhone app.",
    ))
}

/// Shares a library file, downloading its original first when only a copy elsewhere has it.
/// Answers `{"shared": bool}`.
async fn share_file(State(database): State<Database>, Path(id): Path<String>) -> Result<Response> {
    let sheet = sheet()?;
    let lookup = id.clone();
    let remote: bool = database
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT location_type = 'REMOTE' FROM files WHERE id = ?1",
                    [lookup],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(false))
        })
        .await?;
    if remote {
        crate::originals::fetch(&database, &id).await?;
    }
    let library = database.clone();
    let found = database
        .call(move |connection| crate::http::local_file(&library, connection, &id))
        .await?;
    let Some((path, _, _)) = found else {
        return Ok(crate::files::not_found("File"));
    };
    let shared = sheet
        .share(ShareItem::File(path))
        .await
        .map_err(Error::Remote)?;
    Ok(Json(json!({ "shared": shared })).into_response())
}

#[derive(Deserialize)]
struct LinkBody {
    url: String,
}

/// Shares a web address. Answers `{"shared": bool}`.
async fn share_link(Json(body): Json<LinkBody>) -> Result<Json<Value>> {
    let sheet = sheet()?;
    let shared = sheet
        .share(ShareItem::Link(web_address(&body.url)?))
        .await
        .map_err(Error::Remote)?;
    Ok(Json(json!({ "shared": shared })))
}

/// Only http and https addresses reach the share sheet.
fn web_address(url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| Error::Invalid("This is not a web address.".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Error::Invalid("Only web addresses can be shared.".into()));
    }
    Ok(parsed.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;

    use super::*;

    /// Stands in for the iPhone's sheet: remembers what it was given and says it was sent.
    struct Recorder(Mutex<Vec<ShareItem>>);

    impl ShareSheet for &'static Recorder {
        fn share(&self, item: ShareItem) -> Pending<bool> {
            self.0.lock().unwrap().push(item);
            Box::pin(async { Ok(true) })
        }
    }

    async fn post(database: &Database, path: &str, body: Value) -> (u16, Value) {
        let response = routes()
            .with_state(database.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn the_sheet_gets_web_addresses_and_library_files_it_can_find() {
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let recorder: &'static Recorder = Box::leak(Box::new(Recorder(Mutex::new(Vec::new()))));
        register(Box::new(recorder));

        let (status, answer) = post(
            &database,
            "/share/link",
            json!({"url": "https://example.invalid/posts/1"}),
        )
        .await;
        assert_eq!((status, answer), (200, json!({"shared": true})));
        let (status, _) = post(
            &database,
            "/share/link",
            json!({"url": "javascript:alert(1)"}),
        )
        .await;
        assert_eq!(status, 400);
        let (status, _) = post(&database, "/share/files/missing", json!({})).await;
        assert_eq!(status, 404);
        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![ShareItem::Link("https://example.invalid/posts/1".into())]
        );
    }

    #[test]
    fn only_web_addresses_are_shared() {
        assert_eq!(
            web_address(" https://e621.net/posts/1 ").unwrap(),
            "https://e621.net/posts/1"
        );
        assert!(web_address("javascript:alert(1)").is_err());
        assert!(web_address("file:///etc/passwd").is_err());
        assert!(web_address("not a link").is_err());
    }
}
