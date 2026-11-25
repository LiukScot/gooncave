//! Whether GitHub has a newer GoonCave than the one running, for the dot on the menu and the row in
//! Settings. Only the published releases count: drafts are not listed by GitHub's API.

use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use std::time::Duration;

use crate::{
    cache::{self, Keep},
    db::Database,
    Error, Result,
};

const LATEST: &str = "https://api.github.com/repos/LiukScot/gooncave/releases/latest";
const RELEASES: &str = "https://github.com/LiukScot/gooncave/releases";
const TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/update", get(update))
}

async fn update(State(db): State<Database>) -> Json<Value> {
    let current = crate::app_log::version();
    // A build made by hand has no version to compare.
    let latest = match parse(current) {
        Some(_) => {
            match cache::remember(&db, "app-update", Keep::Revalidate(cache::DAY), latest).await {
                Ok(answer) => answer["tag_name"].as_str().map(str::to_owned),
                Err(error) => {
                    eprintln!("[developer] Cannot check GitHub for a newer version: {error}");
                    None
                }
            }
        }
        None => None,
    };
    Json(json!({
        "current": current,
        "latest": latest,
        "newer": latest.as_deref().is_some_and(|latest| newer(latest, current)),
        "url": RELEASES,
    }))
}

async fn latest() -> Result<Value> {
    let failed = |error: reqwest::Error| Error::Remote(format!("GitHub did not answer: {error}"));
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("GoonCave")
        .build()
        .map_err(failed)?
        .get(LATEST)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(failed)?
        .json()
        .await
        .map_err(failed)
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim_start_matches('v').split('.').map(str::parse);
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(Ok(major)), Some(Ok(minor)), Some(Ok(patch)), None) => Some((major, minor, patch)),
        _ => None,
    }
}

fn newer(latest: &str, current: &str) -> bool {
    matches!((parse(latest), parse(current)), (Some(latest), Some(current)) if latest > current)
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn only_a_higher_release_tag_is_newer() {
        assert!(newer("v1.10.0", "1.9.3"));
        assert!(newer("v2.0.0", "1.12.4"));
        assert!(!newer("v1.9.3", "1.9.3"));
        assert!(!newer("v1.9.2", "1.9.3"));
        assert!(!newer("v1.9.3", "development"));
        assert!(!newer("nightly", "1.9.3"));
    }
}
