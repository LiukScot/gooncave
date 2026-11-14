//! The short tap the iPhone gives under a finger, which only the iPhone shell can make.
use std::sync::OnceLock;

use axum::{http::StatusCode, routing::post, Router};

use crate::{db::Database, Error, Result};

pub trait Haptics: Send + Sync {
    /// Gives one medium, short tap. Does not wait for it.
    fn impact(&self);
}

static HAPTICS: OnceLock<Box<dyn Haptics>> = OnceLock::new();

/// Registers the haptics once at startup; later calls are ignored.
pub fn register(haptics: Box<dyn Haptics>) {
    let _ = HAPTICS.set(haptics);
}

pub(crate) fn get() -> Option<&'static dyn Haptics> {
    HAPTICS.get().map(|haptics| haptics.as_ref())
}

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/haptics/impact", post(impact))
}

async fn impact() -> Result<StatusCode> {
    get()
        .ok_or(Error::Unavailable("Haptic feedback needs the iPhone app."))?
        .impact();
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn without_the_iphone_shell_the_route_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let database =
            Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        let response = routes()
            .with_state(database)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/haptics/impact")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
