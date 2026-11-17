//! What the iPhone app runs when iOS wakes it in the background, and what its continued sync
//! reads. The desktop app does not call it.
use crate::{
    booru_http::Transport,
    db::Database,
    favorites,
    favorites::Mode,
    subscriptions,
    sync::{self, Trigger},
};
use std::time::Duration;

const POLL: Duration = Duration::from_secs(1);

/// One background pass: a short favorites sync and one subscriptions refresh side by side, then
/// one database sync cycle that uploads what they changed. A failed step is logged and the next runs.
/// Dropping the future stops it between steps; call [`cancel_favorites`] to stop the sync too.
pub async fn refresh(db: &Database) {
    // Side by side: a short window spent on favorites alone would leave subscriptions for later.
    let favorites = async {
        if let Err(error) = favorites::sync_automatic(db, Mode::Short).await {
            eprintln!("[developer] The background favorites sync did not start: {error}");
        }
        while favorites_progress(db).is_some() {
            tokio::time::sleep(POLL).await;
        }
    };
    let subscriptions = async {
        if let Err(error) = subscriptions::refresh(db, &Transport::default(), 1, true, None).await {
            eprintln!("[developer] The background subscriptions refresh failed: {error}");
        }
    };
    tokio::join!(favorites, subscriptions);
    if let Err(error) = sync::run(db, Trigger::Full).await {
        eprintln!("[developer] The background database sync failed: {error}");
    }
}

/// Whether tagging or moving originals still has work, which a long background window should
/// let finish.
pub async fn working(db: &Database) -> bool {
    let tagging = db.wd14.progress.lock().await["state"].clone();
    let originals = db
        .originals
        .status
        .lock()
        .unwrap_or_else(|p| p.into_inner())["state"]
        .clone();
    matches!(
        tagging.as_str(),
        Some("starting" | "downloading" | "loading" | "tagging")
    ) || matches!(originals.as_str(), Some("uploading" | "downloading"))
}

/// Uploads the changes the WebDAV folder does not have yet, for when the app leaves the screen.
pub async fn upload(db: &Database) {
    sync::flush(db).await;
}

/// Waits until the person starts a favorites sync.
pub async fn manual_sync_started(db: &Database) {
    db.favorites.started.notified().await;
}

/// `(done, total)` posts of the favorites sync, or `None` when none is running. The total grows
/// while pages are read.
pub fn favorites_progress(db: &Database) -> Option<(u64, u64)> {
    let state = match db.favorites.state() {
        Ok(state) => state,
        Err(error) => {
            eprintln!("[developer] Cannot read the favorites sync state: {error}");
            return None;
        }
    };
    if state["status"] != "running" {
        return None;
    }
    let sum = |field: &str| {
        state["progress"]["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|provider| provider[field].as_u64())
            .sum()
    };
    Some((sum("processed"), sum("total")))
}

/// Stops the running favorites sync; imported files are kept.
pub fn cancel_favorites(db: &Database) {
    if let Err(error) = favorites::cancel_running(db) {
        eprintln!("[developer] Cannot stop the favorites sync: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_pass_with_no_accounts_or_folder_finishes_and_reports_no_sync() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        refresh(&db).await;
        assert_eq!(favorites_progress(&db), None);
    }
}
