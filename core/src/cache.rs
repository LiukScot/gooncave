//! What the core keeps of what it loaded from the sites: post answers and media, one file each in
//! `<data>/cache`, within the size chosen in Settings → Extra. When the cache grows past it, the
//! entries used least recently go first. Nothing here is the only copy of anything: an entry
//! that is gone is loaded from the site again.

use crate::{
    db::{read_setting, Database},
    Result,
};
use axum::{extract::State, Json, Router};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, future::Future, path::PathBuf, sync::Mutex};

pub(crate) const HOUR: i64 = 60 * 60;
pub(crate) const DAY: i64 = 24 * HOUR;
/// The sizes Settings → Extra offers, in GB; 0 keeps everything.
pub(crate) const LIMITS_GB: [u64; 5] = [1, 3, 5, 10, 0];
pub(crate) const DEFAULT_LIMIT_GB: u64 = 3;
const GB: u64 = 1024 * 1024 * 1024;
/// A full cache frees down to this share of the limit, so it does not clean at every write.
const KEEP_AFTER_EVICTION: f64 = 0.9;
/// Use times closer than this are not written again: the order only needs to tell old from new.
const TOUCH_AFTER: i64 = HOUR;
static EVICTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Keys a background refresh is already asking the site for.
static REFRESHING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// How long a saved answer stands for the site's.
pub(crate) enum Keep {
    /// The site is asked again once the copy is older than this many seconds. The copy answers
    /// only when the site cannot be reached.
    Fresh(i64),
    /// The site is always asked. The copy answers only when it cannot be reached.
    Fallback,
    /// The copy answers at once whatever its age. Once older than this many seconds, the site is
    /// asked again in the background and the new answer is used the next time.
    Revalidate(i64),
}

pub(crate) struct Entry {
    pub bytes: Vec<u8>,
    pub mime: String,
    fetched_at: i64,
}

pub(crate) fn routes() -> Router<Database> {
    Router::new().route("/cache", axum::routing::get(usage))
}

async fn usage(State(db): State<Database>) -> Result<Json<Value>> {
    let bytes = db.call(|c| used(c)).await?;
    Ok(Json(json!({ "bytes": bytes })))
}

fn used(c: &rusqlite::Connection) -> Result<u64> {
    Ok(
        c.query_row("SELECT bytes FROM cache_usage WHERE id = 1", [], |r| {
            r.get::<_, i64>(0)
        })?
        .max(0) as u64,
    )
}

fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// The entry's id and file name: keys can be long URLs.
fn id(key: &str) -> String {
    Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn path(db: &Database, id: &str) -> PathBuf {
    db.library().cache.join(id)
}

/// The saved copy of `key`, if any.
pub(crate) async fn get(db: &Database, key: &str) -> Result<Option<Entry>> {
    let id = id(key);
    let found = {
        let id = id.clone();
        db.call(move |c| {
            let row: Option<(String, i64, i64)> = c
                .query_row(
                    "SELECT mime, fetched_at, used_at FROM cache_entries WHERE id = ?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((_, _, used_at)) = &row {
                if now() - used_at > TOUCH_AFTER {
                    c.execute(
                        "UPDATE cache_entries SET used_at = ?2 WHERE id = ?1",
                        rusqlite::params![id, now()],
                    )?;
                }
            }
            Ok(row)
        })
        .await?
    };
    let Some((mime, fetched_at, _)) = found else {
        return Ok(None);
    };
    match tokio::fs::read(path(db, &id)).await {
        Ok(bytes) => Ok(Some(Entry {
            bytes,
            mime,
            fetched_at,
        })),
        // Eviction or a crash removed the file before its row.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            db.call(move |c| {
                c.execute("DELETE FROM cache_entries WHERE id = ?1", [&id])?;
                Ok(())
            })
            .await?;
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// Saves `bytes` as the copy of `key`, then frees space if the cache is over its limit.
pub(crate) async fn put(
    db: &Database,
    key: &str,
    kind: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<()> {
    let id = id(key);
    // Written aside first: a crash leaves a row without a file, which `get` forgets, rather than
    // a file without a row, which nothing would ever remove.
    let staged = tempfile::NamedTempFile::new_in(&db.library().temp)?;
    tokio::fs::write(staged.path(), bytes).await?;
    let (kind, mime, size) = (kind.to_owned(), mime.to_owned(), bytes.len() as i64);
    let row = id.clone();
    db.call(move |c| {
        c.execute(
            "INSERT INTO cache_entries (id, kind, mime, bytes, fetched_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, mime = excluded.mime,
               bytes = excluded.bytes, fetched_at = excluded.fetched_at, used_at = excluded.used_at",
            rusqlite::params![row, kind, mime, size, now()],
        )?;
        Ok(())
    })
    .await?;
    staged.persist(path(db, &id)).map_err(|error| error.error)?;
    evict(db).await
}

/// Removes the entries used least recently until the cache fits its limit.
pub(crate) async fn evict(db: &Database) -> Result<()> {
    // One eviction at a time: two would pick the same entries. A later one waits rather than
    // returning, because it may have been asked for by a lower limit the running one never read.
    let _running = EVICTING.lock().await;
    let doomed = db
        .call(|c| {
            let limit = read_setting(c, "extra.cacheLimitGb", &json!(DEFAULT_LIMIT_GB))?
                .as_u64()
                .unwrap_or(DEFAULT_LIMIT_GB);
            let used = used(c)?;
            if limit == 0 || used <= limit * GB {
                return Ok(Vec::new());
            }
            let mut excess = used - (limit as f64 * GB as f64 * KEEP_AFTER_EVICTION) as u64;
            let mut doomed = Vec::new();
            let mut oldest = c.prepare("SELECT id, bytes FROM cache_entries ORDER BY used_at")?;
            let mut rows = oldest.query([])?;
            while let Some(row) = rows.next()? {
                if excess == 0 {
                    break;
                }
                let bytes = row.get::<_, i64>(1)?.max(0) as u64;
                excess = excess.saturating_sub(bytes);
                doomed.push(row.get::<_, String>(0)?);
            }
            Ok(doomed)
        })
        .await?;
    if doomed.is_empty() {
        return Ok(());
    }
    // Files go before rows, for the reason `put` stages its file.
    for id in &doomed {
        match tokio::fs::remove_file(path(db, id)).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                eprintln!("[developer] Cannot remove a cache file: {error}");
            }
            _ => {}
        }
    }
    let count = doomed.len();
    db.call(move |c| {
        let tx = c.transaction()?;
        for id in &doomed {
            tx.execute("DELETE FROM cache_entries WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    })
    .await?;
    eprintln!(
        "[developer] The cache was over its limit: removed {count} entries used least recently"
    );
    Ok(())
}

/// Removes the saved copy of `key`.
async fn forget(db: &Database, key: &str) -> Result<()> {
    let id = id(key);
    match tokio::fs::remove_file(path(db, &id)).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    db.call(move |c| {
        c.execute("DELETE FROM cache_entries WHERE id = ?1", [&id])?;
        Ok(())
    })
    .await
}

/// Removes files of the cache folder that no entry names. A `get` that finds a row before `put`
/// has moved its file in forgets the row, and the file then arrives unlisted.
pub(crate) async fn sweep(db: &Database) -> Result<()> {
    let listed: BTreeSet<String> = db
        .call(|c| {
            let mut ids = c.prepare("SELECT id FROM cache_entries")?;
            let ids = ids
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(ids)
        })
        .await?;
    let mut entries = tokio::fs::read_dir(&db.library().cache).await?;
    let mut removed = 0;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Only names `id` makes: the folder is the cache's alone, but a stray file is not ours.
        let ours = name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit());
        if ours && !listed.contains(&name) {
            tokio::fs::remove_file(entry.path()).await?;
            removed += 1;
        }
    }
    if removed > 0 {
        eprintln!("[developer] Removed {removed} cache files that no entry listed");
    }
    Ok(())
}

/// Takes `key` for one background refresh; dropping the claim frees it.
struct Refreshing(String);
impl Refreshing {
    fn claim(key: &str) -> Option<Self> {
        REFRESHING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_owned())
            .then(|| Self(key.to_owned()))
    }
}
impl Drop for Refreshing {
    fn drop(&mut self) {
        REFRESHING
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

/// The site's answer for `key`, or the saved copy as `keep` allows. `fetch` asks the site.
pub(crate) async fn remember<F, Fut>(
    db: &Database,
    key: &str,
    keep: Keep,
    fetch: F,
) -> Result<Value>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    let saved = match get(db, key).await? {
        Some(entry) => match serde_json::from_slice::<Value>(&entry.bytes) {
            Ok(value) => Some((value, now() - entry.fetched_at)),
            Err(error) => {
                eprintln!("[developer] A cached site answer is damaged and is read again: {error}");
                None
            }
        },
        None => None,
    };
    match (keep, saved) {
        (Keep::Revalidate(max), Some((value, age))) => {
            if let Some(claim) = (age > max).then(|| Refreshing::claim(key)).flatten() {
                let (db, key) = (db.clone(), key.to_owned());
                tokio::spawn(async move {
                    let _claim = claim;
                    match fetch().await {
                        Ok(fresh) => {
                            if let Err(error) = save(&db, &key, &fresh).await {
                                eprintln!(
                                    "[developer] Cannot save a refreshed site answer: {error}"
                                );
                            }
                        }
                        // The site removed it: the copy must not keep showing it.
                        Err(error) if crate::booru_http::is_not_found(&error) => {
                            if let Err(error) = forget(&db, &key).await {
                                eprintln!("[developer] Cannot forget a removed post's saved answer: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("[developer] Cannot refresh a cached site answer: {error}")
                        }
                    }
                });
            }
            Ok(value)
        }
        (Keep::Fresh(max), Some((value, age))) if age <= max => Ok(value),
        (_, saved) => match fetch().await {
            Ok(fresh) => {
                // The answer is good even when it cannot be kept.
                if let Err(error) = save(db, key, &fresh).await {
                    eprintln!("[developer] Cannot save a site answer: {error}");
                }
                Ok(fresh)
            }
            // A post the site removed is gone; any other failure may pass.
            Err(error) if crate::booru_http::is_not_found(&error) => {
                if saved.is_some() {
                    if let Err(error) = forget(db, key).await {
                        eprintln!(
                            "[developer] Cannot forget a removed post's saved answer: {error}"
                        );
                    }
                }
                Err(error)
            }
            Err(error) => match saved {
                Some((value, _)) => {
                    eprintln!("[developer] A site could not be reached; its saved answer is shown: {error}");
                    Ok(value)
                }
                None => Err(error),
            },
        },
    }
}

async fn save(db: &Database, key: &str, value: &Value) -> Result<()> {
    let kind = key.split(':').next().unwrap_or("answer");
    put(
        db,
        key,
        kind,
        "application/json",
        value.to_string().as_bytes(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::write_setting;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn open() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("data"), &dir.path().join("library")).unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn a_cache_folder_the_system_emptied_reads_as_nothing_kept() {
        let dir = tempfile::tempdir().unwrap();
        let caches = dir.path().join("Caches");
        let db = Database::open_with_cache(
            &dir.path().join("data"),
            &dir.path().join("library"),
            &caches,
        )
        .unwrap();
        put(&db, "post:1", "post", "application/json", b"{}")
            .await
            .unwrap();
        let file = caches.join(id("post:1"));
        assert!(file.is_file());
        std::fs::remove_file(file).unwrap();
        assert!(get(&db, "post:1").await.unwrap().is_none());
        let used: i64 = db
            .call(|c| Ok(c.query_row("SELECT bytes FROM cache_usage", [], |r| r.get(0))?))
            .await
            .unwrap();
        assert_eq!(used, 0);
    }

    async fn age(db: &Database, key: &str, seconds: i64) {
        let id = id(key);
        db.call(move |c| {
            c.execute(
                "UPDATE cache_entries SET fetched_at = fetched_at - ?2, used_at = used_at - ?2 WHERE id = ?1",
                rusqlite::params![id, seconds],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    }

    fn answer(
        value: Value,
        calls: &Arc<AtomicUsize>,
    ) -> impl FnOnce() -> std::future::Ready<Result<Value>> {
        let calls = calls.clone();
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(value))
        }
    }

    fn offline() -> std::future::Ready<Result<Value>> {
        std::future::ready(Err(crate::booru_http::remote(crate::booru_http::OFFLINE)))
    }

    #[tokio::test]
    async fn a_fresh_copy_answers_without_asking_the_site() {
        let (_dir, db) = open();
        let calls = Arc::new(AtomicUsize::new(0));
        let first = remember(&db, "feed:a", Keep::Fresh(300), answer(json!(1), &calls))
            .await
            .unwrap();
        let second = remember(&db, "feed:a", Keep::Fresh(300), answer(json!(2), &calls))
            .await
            .unwrap();
        assert_eq!((first, second), (json!(1), json!(1)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        age(&db, "feed:a", 301).await;
        let third = remember(&db, "feed:a", Keep::Fresh(300), answer(json!(3), &calls))
            .await
            .unwrap();
        assert_eq!(third, json!(3));
    }

    #[tokio::test]
    async fn the_saved_copy_answers_when_the_site_cannot_be_reached() {
        let (_dir, db) = open();
        let calls = Arc::new(AtomicUsize::new(0));
        remember(
            &db,
            "search:a",
            Keep::Fallback,
            answer(json!("kept"), &calls),
        )
        .await
        .unwrap();
        age(&db, "search:a", 1).await;
        let shown = remember(&db, "search:a", Keep::Fallback, offline)
            .await
            .unwrap();
        assert_eq!(shown, json!("kept"));
        assert!(remember(&db, "search:b", Keep::Fallback, offline)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_stale_copy_answers_at_once_and_is_refreshed_for_next_time() {
        let (_dir, db) = open();
        let calls = Arc::new(AtomicUsize::new(0));
        remember(
            &db,
            "text:a",
            Keep::Revalidate(DAY),
            answer(json!("old"), &calls),
        )
        .await
        .unwrap();
        age(&db, "text:a", DAY + 1).await;
        let shown = remember(
            &db,
            "text:a",
            Keep::Revalidate(DAY),
            answer(json!("new"), &calls),
        )
        .await
        .unwrap();
        assert_eq!(shown, json!("old"));
        for _ in 0..100 {
            if get(&db, "text:a")
                .await
                .unwrap()
                .is_some_and(|e| e.bytes == b"\"new\"")
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the background refresh did not save the new answer");
    }

    #[tokio::test]
    async fn a_post_the_site_removed_stops_answering_from_the_cache() {
        let (_dir, db) = open();
        let calls = Arc::new(AtomicUsize::new(0));
        remember(
            &db,
            "text:a",
            Keep::Revalidate(DAY),
            answer(json!("old"), &calls),
        )
        .await
        .unwrap();
        age(&db, "text:a", DAY + 1).await;
        let removed =
            || std::future::ready(Err(crate::booru_http::remote(crate::booru_http::NOT_FOUND)));
        let shown = remember(&db, "text:a", Keep::Revalidate(DAY), removed)
            .await
            .unwrap();
        assert_eq!(shown, json!("old"));
        for _ in 0..100 {
            if get(&db, "text:a").await.unwrap().is_none() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("the copy of a removed post was kept");
    }

    #[tokio::test]
    async fn the_sweep_removes_only_cache_files_no_entry_lists() {
        let (_dir, db) = open();
        put(&db, "post:1", "post", "application/json", b"{}")
            .await
            .unwrap();
        let folder = db.library().cache.clone();
        let unlisted = folder.join(id("post:2"));
        std::fs::write(&unlisted, b"{}").unwrap();
        let stray = folder.join("notes.txt");
        std::fs::write(&stray, b"not the cache's").unwrap();
        sweep(&db).await.unwrap();
        assert!(!unlisted.exists());
        assert!(stray.exists());
        assert!(get(&db, "post:1").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn over_the_limit_the_entries_used_least_recently_go_first() {
        let (_dir, db) = open();
        db.call(|c| write_setting(c, "extra.cacheLimitGb", &json!(1)))
            .await
            .unwrap();
        // Rows claim their size, so the test needs no gigabytes on disk.
        put(&db, "media:old", "media", "image/jpeg", b"o")
            .await
            .unwrap();
        put(&db, "media:used", "media", "image/jpeg", b"u")
            .await
            .unwrap();
        age(&db, "media:old", 3 * DAY).await;
        age(&db, "media:used", 3 * DAY).await;
        assert!(get(&db, "media:used").await.unwrap().is_some());
        let half = (GB / 2) as i64;
        db.call(move |c| {
            c.execute("UPDATE cache_entries SET bytes = ?1", [half])?;
            Ok(())
        })
        .await
        .unwrap();
        put(&db, "media:new", "media", "image/jpeg", b"n")
            .await
            .unwrap();
        assert!(get(&db, "media:old").await.unwrap().is_none());
        assert!(!path(&db, &id("media:old")).exists());
        assert!(get(&db, "media:used").await.unwrap().is_some());
        assert!(get(&db, "media:new").await.unwrap().is_some());
        assert!(db.call(|c| used(c)).await.unwrap() <= GB);
    }

    #[tokio::test]
    async fn an_unlimited_cache_keeps_everything() {
        let (_dir, db) = open();
        db.call(|c| write_setting(c, "extra.cacheLimitGb", &json!(0)))
            .await
            .unwrap();
        put(&db, "media:a", "media", "image/jpeg", b"a")
            .await
            .unwrap();
        db.call(|c| {
            c.execute("UPDATE cache_entries SET bytes = ?1", [(20 * GB) as i64])?;
            Ok(())
        })
        .await
        .unwrap();
        put(&db, "media:b", "media", "image/jpeg", b"b")
            .await
            .unwrap();
        assert!(get(&db, "media:a").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn a_row_whose_file_is_gone_is_forgotten() {
        let (_dir, db) = open();
        put(&db, "media:a", "media", "image/png", b"a")
            .await
            .unwrap();
        std::fs::remove_file(path(&db, &id("media:a"))).unwrap();
        assert!(get(&db, "media:a").await.unwrap().is_none());
        assert_eq!(db.call(|c| used(c)).await.unwrap(), 0);
    }
}
