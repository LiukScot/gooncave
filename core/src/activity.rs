use crate::{db::Database, wd14_store, Result};
use std::sync::atomic::Ordering;

/// One plain sentence per background job that is working now, for a status menu outside the window.
pub async fn activity(db: &Database) -> Result<Vec<String>> {
    let mut lines = Vec::new();
    if db.scan.running.load(Ordering::Relaxed) {
        lines.push("Scanning the library".to_owned());
    }
    let favorites = db.favorites.state()?;
    if favorites["status"] == "running" {
        lines.push(
            favorites["message"]
                .as_str()
                .unwrap_or("Syncing favorites")
                .to_owned(),
        );
    }
    let tagging = db.wd14.progress.lock().await["state"].clone();
    match tagging.as_str() {
        Some("starting" | "downloading" | "loading") => {
            lines.push("Preparing automatic tagging".to_owned())
        }
        Some("tagging") => {
            let (total, completed) = db.call(|c| wd14_store::counts(c)).await?;
            lines.push(format!("Tagging files: {completed} of {total}"));
        }
        _ => {}
    }
    if db.sync.snapshot()["state"] == "syncing" {
        lines.push("Syncing with your folder".to_owned());
    }
    Ok(lines)
}
