use std::{path::PathBuf, sync::Arc};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use tokio::{
    net::{TcpListener, TcpSocket},
    sync::oneshot,
};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::{
    db::{Database, OWNER_ID},
    settings, Error, Result,
};

const LOCAL_HTTP_BACKLOG: u32 = 1024;

pub type AssetLoader = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

pub enum Frontend {
    Embedded(AssetLoader),
    Directory(PathBuf),
}

pub struct Server {
    pub origin: String,
    pub router: Router,
    pub listener: TcpListener,
    database: Database,
}

impl Server {
    pub async fn bind(database: Database, port: u16, frontend: Frontend) -> Result<Self> {
        let listener = if port == 0 {
            database.call(|connection| {
                let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let saved: Option<String> = transaction.query_row(
                    "SELECT value FROM meta WHERE key = 'core.http_port'", [], |row| row.get(0),
                ).optional()?;
                let port = match saved {
                    Some(value) => value.parse::<u16>().ok().filter(|port| *port != 0)
                        .ok_or_else(|| Error::Storage("Invalid saved local HTTP port.".into()))?,
                    None => 0,
                };
                let socket = TcpSocket::new_v4()?;
                #[cfg(unix)]
                socket.set_reuseaddr(true)?;
                socket.bind((std::net::Ipv4Addr::LOCALHOST, port).into()).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AddrInUse {
                        Error::Storage("GoonCave's saved local port is in use. Close another running copy of GoonCave or the application using that port, then open GoonCave again.".into())
                    } else { Error::Io(error) }
                })?;
                let listener = socket.listen(LOCAL_HTTP_BACKLOG)?;
                transaction.execute(
                    "INSERT INTO meta (key, value) VALUES ('core.http_port', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [listener.local_addr()?.port().to_string()],
                )?;
                transaction.commit()?;
                Ok(listener)
            }).await?
        } else {
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?
        };
        let authority = listener.local_addr()?.to_string();
        let origin = format!("http://{authority}");
        let frontend = Arc::new(frontend);
        let frontend = any(move |request: Request| {
            let frontend = frontend.clone();
            async move {
                let path = request.uri().path();
                if !is_frontend_path(path)
                    || !matches!(
                        *request.method(),
                        axum::http::Method::GET | axum::http::Method::HEAD
                    )
                {
                    return unavailable().await.into_response();
                }
                match frontend.as_ref() {
                    Frontend::Embedded(assets) => match assets(path) {
                        Some((bytes, mime)) => {
                            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
                        }
                        None => StatusCode::NOT_FOUND.into_response(),
                    },
                    Frontend::Directory(directory) => {
                        if path == "/" || path == "/app" || path.starts_with("/app/") {
                            ServeFile::new(directory.join("index.html"))
                                .oneshot(request)
                                .await
                                .unwrap_or_else(|never| match never {})
                                .into_response()
                        } else {
                            ServeDir::new(directory)
                                .oneshot(request)
                                .await
                                .unwrap_or_else(|never| match never {})
                                .into_response()
                        }
                    }
                }
            }
        });
        let router = routes(database.clone())
            .fallback(frontend)
            .layer(middleware::from_fn(move |request, next| {
                local_request(request, next, authority.clone())
            }));
        Ok(Self {
            origin,
            router,
            listener,
            database,
        })
    }

    /// Serves requests, scans the library and refreshes tag vocabulary until `shutdown` fires.
    pub async fn serve(self, shutdown: oneshot::Receiver<()>) -> std::io::Result<()> {
        let importer = tokio::spawn(crate::tag_import::watch(self.database.clone()));
        let favorites = tokio::spawn(crate::favorites::watch(self.database.clone()));
        let subscriptions = tokio::spawn(crate::subscriptions::watch(self.database.clone()));
        let sources = tokio::spawn(crate::source_jobs::watch(self.database.clone()));
        let tagging = tokio::spawn(crate::wd14::watch(self.database.clone()));
        let duplicates = tokio::spawn(crate::duplicate_policy::watch(self.database.clone()));
        let syncing = tokio::spawn(crate::sync::watch(self.database.clone()));
        let originals = tokio::spawn(crate::originals::watch(self.database.clone()));
        let closing = self.database.clone();
        let scanner = tokio::spawn(crate::library::watch(self.database));
        let result = axum::serve(self.listener, self.router)
            .with_graceful_shutdown(async {
                let _ = shutdown.await;
            })
            .await;
        // Each database write is its own transaction, so stopping between them loses nothing.
        scanner.abort();
        importer.abort();
        favorites.abort();
        subscriptions.abort();
        sources.abort();
        let _ = sources.await;
        tagging.abort();
        let _ = tagging.await;
        // A policy run stopped between actions is marked interrupted and resumed on the next start.
        duplicates.abort();
        let _ = duplicates.await;
        originals.abort();
        let _ = originals.await;
        syncing.abort();
        let _ = syncing.await;
        closing.upload_before_close().await;
        let _ = subscriptions.await;
        let _ = favorites.await;
        let _ = importer.await;
        result
    }
}

fn is_frontend_path(path: &str) -> bool {
    path == "/"
        || path == "/app"
        || path.starts_with("/app/")
        || path.starts_with("/assets/")
        || path.starts_with("/site-logos/")
        || path == "/favicon.ico"
        || path == "/favicon.png"
        || path == "/apple-touch-icon.png"
        || path == "/manifest.webmanifest"
}

fn routes(database: Database) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/device", get(profile))
        .route(
            "/settings/{section}",
            get(read_settings).put(update_settings),
        )
        .route("/files/{id}/content", get(content))
        .merge(crate::source_routes::routes())
        .merge(crate::wd14::routes())
        .merge(crate::duplicates::routes())
        .merge(crate::duplicate_policy::routes())
        .merge(crate::sync::routes())
        .merge(crate::originals::routes())
        .merge(crate::photos::routes())
        .merge(crate::backup::routes())
        .merge(crate::boorus::routes())
        .merge(crate::explore::routes())
        .merge(crate::tags::routes())
        .merge(crate::tag_import::routes())
        .merge(crate::files::routes())
        .merge(crate::read_history::routes())
        .merge(crate::favorites::routes())
        .merge(crate::subscriptions::routes())
        // Upload routes raise this with their own, inner limit.
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(database)
}

async fn local_request(request: Request, next: Next, authority: String) -> Response {
    let headers = request.headers();
    let origin = format!("http://{authority}");
    let host_valid = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        == Some(authority.as_str());
    let origin_valid = headers
        .get(header::ORIGIN)
        .is_none_or(|value| value.to_str().ok() == Some(origin.as_str()));
    let site_valid = headers
        .get("sec-fetch-site")
        .is_none_or(|value| value == "same-origin" || value == "none");
    if !host_valid || !origin_valid || !site_valid {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Open GoonCave on this device to use its library."})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Handlers that serve cacheable files set their own policy.
    response
        .headers_mut()
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self'"));
    response
}

async fn profile(State(database): State<Database>) -> Result<Json<Value>> {
    Ok(Json(json!({"user": database.profile().await?})))
}

async fn read_settings(
    State(database): State<Database>,
    Path(section): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(
        database
            .call(move |connection| settings::read(connection, &section))
            .await?,
    ))
}

async fn update_settings(
    State(database): State<Database>,
    Path(section): Path<String>,
    payload: std::result::Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>> {
    let Json(patch) = payload.map_err(|_| {
        Error::Invalid("Send valid JSON settings with Content-Type application/json.".into())
    })?;
    Ok(Json(
        database
            .call(move |connection| settings::update(connection, &section, patch))
            .await?,
    ))
}

pub async fn unavailable() -> Error {
    Error::Unavailable("This feature is not available in this development build. You can use Appearance, Extra, Shortcuts and Blacklist settings.")
}

async fn content(
    State(database): State<Database>,
    Path(id): Path<String>,
    mut request: Request,
) -> Result<Response> {
    let lookup = id.clone();
    let remote: bool = database
        .call(move |c| {
            Ok(c.query_row(
                "SELECT location_type = 'REMOTE' FROM files WHERE id = ?1",
                [lookup],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
        })
        .await?;
    database.originals.opened(&id);
    if remote {
        if let Err(error) = crate::originals::fetch(&database, &id).await {
            return Ok((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": error.to_string()})),
            )
                .into_response());
        }
        database.originals.downloaded_by_opening(&id);
    }
    let library = database.clone();
    let resolved = database
        .call(move |connection| {
            let record: Option<(String, String, String)> = connection.query_row(
            "SELECT files.path, folders.path, files.sha256 FROM files JOIN library_folders AS folders ON files.folder_id = folders.id
             WHERE files.id = ?1 AND folders.user_id = ?2 AND folders.type = 'LOCAL'",
            params![id, OWNER_ID], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
            let Some((path, root, hash)) = record else {
                return Ok(None);
            };
            let path = library.library().resolve_file(std::path::Path::new(&root), std::path::Path::new(&path))?;
            let metadata = std::fs::metadata(&path)?;
            let modified = metadata.modified()?;
            let elapsed = modified.duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| Error::Storage(format!("invalid media modification time: {error}")))?;
            let etag = HeaderValue::from_str(&format!("\"{hash}-{}-{}\"", metadata.len(), elapsed.as_millis()))
                .map_err(|error| Error::Storage(format!("invalid media validator: {error}")))?;
            let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(elapsed.as_secs());
            Ok(Some((path, etag, modified)))
        })
        .await?;
    let Some((path, etag, modified)) = resolved else {
        return Ok((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "File not found."})),
        )
            .into_response());
    };
    if request
        .headers()
        .get(header::IF_RANGE)
        .is_some_and(|validator| {
            validator != etag
                && validator
                    .to_str()
                    .ok()
                    .and_then(|value| httpdate::parse_http_date(value).ok())
                    .is_none_or(|date| date < modified)
        })
    {
        request.headers_mut().remove(header::RANGE);
    }
    let not_modified = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|value| {
                let value = value.trim().strip_prefix("W/").unwrap_or(value.trim());
                value == "*" || value == etag.to_str().expect("validated header")
            })
        });
    let download = request
        .uri()
        .query()
        .is_some_and(|query| query.split('&').any(|pair| pair == "download=1"));
    let disposition = download.then(|| attachment(&path));
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        ServeFile::new(path)
            .oneshot(request)
            .await
            .unwrap_or_else(|never| match never {})
            .map(Body::new)
    };
    if let Some(disposition) = disposition {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, disposition);
    }
    response.headers_mut().insert(header::ETAG, etag);
    // The ETag lets the web view revalidate with a cheap 304 instead of rereading the file.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache"),
    );
    response.headers_mut().insert(
        header::LAST_MODIFIED,
        HeaderValue::from_str(&httpdate::fmt_http_date(modified)).expect("formatted HTTP date"),
    );
    Ok(response)
}

/// `attachment` with an ASCII fallback name and the exact UTF-8 name, as browsers expect.
fn attachment(path: &std::path::Path) -> HeaderValue {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".into());
    let ascii: String = name
        .chars()
        .map(|character| match character {
            '"' | '\\' => '_',
            ' '..='~' => character,
            _ => '_',
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => char::from(byte).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect();
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}"
    ))
    .expect("visible ASCII header")
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        if let Error::Refused { code, message } = &self {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": message, "code": code})),
            )
                .into_response();
        }
        let (status, message) = match &self {
            Error::Invalid(message) => (StatusCode::BAD_REQUEST, message.as_str()),
            Error::Unavailable(message) => (StatusCode::NOT_IMPLEMENTED, *message),
            Error::Remote(message) => (StatusCode::BAD_GATEWAY, message.as_str()),
            _ => {
                eprintln!("Core storage operation failed: {self}");
                (StatusCode::INTERNAL_SERVER_ERROR, "GoonCave could not read or save data. Check free disk space and folder permissions, then try again.")
            }
        };
        (status, Json(json!({"error": message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_refusal_tells_the_client_it_may_retry() {
        let response = Error::Refused {
            code: "BOORU_CAPTCHA",
            message: "wait".into(),
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({"error": "wait", "code": "BOORU_CAPTCHA"})
        );
    }
    #[test]
    fn download_names_keep_unicode_and_cannot_break_the_header() {
        assert_eq!(
            attachment(std::path::Path::new("dir/é \"x\".png")),
            "attachment; filename=\"_ _x_.png\"; filename*=UTF-8''%C3%A9%20%22x%22.png"
        );
    }
}
