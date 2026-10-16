//! Every device shows the whole library, whether or not a file's original is on it. A file this
//! device knows only from sync has a `REMOTE` row in the `Synced` folder; fetching its original
//! makes the row `LOCAL`. Deleted files wait in the trash, shared by every device, before each
//! device deletes them for good.

use crate::{
    booru_favorites,
    booru_http::Transport,
    boorus,
    db::{read_setting, write_setting, Database, OWNER_ID},
    favorite_library,
    library::{self, NOW},
    media, sync,
    webdav::Folder,
    Error, Result,
};
use axum::{
    extract::{Path as UrlPath, Query, State},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// The library subfolder that holds originals fetched from sync.
pub(crate) const SYNCED_DIR: &str = "Synced";
/// How long a deleted file can be restored.
pub(crate) const TRASH_DAYS: i64 = 14;

/// SQL for the time a file trashed now is deleted for good: `trashed_at` at or before it.
pub(crate) fn purge_before() -> String {
    format!("strftime('%Y-%m-%dT%H:%M:%fZ','now','-{TRASH_DAYS} days')")
}

pub(crate) fn library_root(c: &Connection) -> Result<PathBuf> {
    Ok(PathBuf::from(c.query_row(
        "SELECT library_root FROM users WHERE id = ?1",
        [OWNER_ID],
        |r| r.get::<_, String>(0),
    )?))
}

/// The `Synced` folder's row, made with the folder on first use.
pub(crate) fn synced_folder(c: &Connection) -> Result<(String, PathBuf)> {
    let directory = library_root(c)?.join(SYNCED_DIR);
    std::fs::create_dir_all(&directory)?;
    let path = directory.to_string_lossy().into_owned();
    let existing: Option<String> = c
        .query_row(
            "SELECT id FROM folders WHERE user_id = ?1 AND path = ?2",
            params![OWNER_ID, path],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            c.execute(
                &format!("INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status) VALUES (?1, ?2, ?3, 'LOCAL', {NOW}, {NOW}, 'IDLE')"),
                params![id, OWNER_ID, path],
            )?;
            id
        }
    };
    c.execute(
        "INSERT OR IGNORE INTO active_library_folders (id) VALUES (?1)",
        [&id],
    )?;
    Ok((id, directory))
}

/// Whether the file left the trash for good, so no device may show it again.
pub(crate) fn purged(c: &Connection, sha: &str) -> Result<bool> {
    Ok(c.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM trash WHERE sha256 = ?1 AND trashed_at <= {})",
            purge_before()
        ),
        [sha],
        |r| r.get(0),
    )?)
}

/// Adds a row for a file this device knows only from its synced metadata. Returns `false` for
/// a file deleted for good.
pub(crate) fn add_remote(c: &Connection, sha: &str, data: &Value) -> Result<bool> {
    let invalid = || crate::Error::Remote(format!("The file sync record {sha} is invalid."));
    let media_type = data["mediaType"].as_str().ok_or_else(invalid)?;
    let size = data["sizeBytes"].as_i64().ok_or_else(invalid)?;
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    if purged(c, sha)? {
        return Ok(false);
    }
    let (folder, directory) = synced_folder(c)?;
    c.execute(
        &format!(
            "INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, phash, media_type, width, height, duration_ms, thumb_path, created_at, updated_at)
             VALUES (?1, ?2, 'REMOTE', ?3, ?4, {NOW}, ?5, ?6, ?7, ?8, ?9, ?10, NULL, {NOW}, {NOW})"
        ),
        params![
            uuid::Uuid::new_v4().to_string(),
            folder,
            directory.join(sha).to_string_lossy(),
            size,
            sha,
            data["phash"].as_str(),
            media_type,
            data["width"].as_i64(),
            data["height"].as_i64(),
            data["durationMs"].as_i64(),
        ],
    )?;
    Ok(true)
}

/// Gives a `REMOTE` row of the same content to a file found on disk, so its tags, votes and
/// favorites stay with it. Returns the row's id.
pub(crate) fn claim_remote(
    c: &Connection,
    sha: &str,
    folder: &str,
    path: &str,
) -> Result<Option<String>> {
    let found: Option<(String, String)> = c
        .query_row(
            "SELECT id, path FROM files WHERE sha256 = ?1 AND location_type = 'REMOTE' ORDER BY created_at LIMIT 1",
            [sha],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((id, old)) = found else {
        return Ok(None);
    };
    c.execute(
        &format!("UPDATE files SET folder_id = ?2, path = ?3, location_type = 'LOCAL', updated_at = {NOW} WHERE id = ?1"),
        params![id, folder, path],
    )?;
    c.execute(
        "UPDATE favorite_items SET file_path = ?2 WHERE user_id = ?3 AND file_path = ?1",
        params![old, path, OWNER_ID],
    )?;
    Ok(Some(id))
}

// ---- Transfers ---------------------------------------------------------------------------

const MEDIA: &str = "GoonCave/media/";
const THUMBS: &str = "GoonCave/thumbnails/";
const SETTINGS_KEY: &str = "originals";
const TRASH_KEY: &str = "trash.enabled";
/// How often the worker looks for originals to move when nothing wakes it.
const PERIOD: Duration = Duration::from_secs(60);
/// How long a listing of the sync folder is trusted before it is read again.
const LISTING_AGE: Duration = Duration::from_secs(60);
/// A thumbnail larger than this in the sync folder is not one GoonCave wrote.
const MAX_THUMBNAIL_BYTES: u64 = 20 << 20;

/// A phone has less space: by default it keeps only the originals you open or keep by hand.
const DEFAULT_KEEP_ALL: bool = !cfg!(any(target_os = "ios", target_os = "android"));
/// An original opened this recently stays on a device that does not keep every original, so it
/// does not disappear while you look at it.
const OPEN_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

struct Settings {
    upload: bool,
    keep_all: bool,
}

fn settings(c: &Connection) -> Result<Settings> {
    let saved = read_setting(c, SETTINGS_KEY, &Value::Null)?;
    Ok(Settings {
        upload: saved["upload"].as_bool().unwrap_or(false),
        keep_all: saved["keepAll"].as_bool().unwrap_or(DEFAULT_KEEP_ALL),
    })
}

/// SQL that is true for a row of `files f` this device keeps whatever the setting.
const KEPT: &str = "f.sha256 IN (SELECT sha256 FROM kept_files)";

/// What the sync folder holds, by SHA-256: the name of each original and thumbnail.
#[derive(Default)]
struct Listing {
    media: HashMap<String, String>,
    thumbs: HashMap<String, String>,
}

fn by_hash(names: Vec<String>) -> HashMap<String, String> {
    names
        .into_iter()
        .filter_map(|name| {
            let sha = name.get(..64)?;
            sha.bytes()
                .all(|b| b.is_ascii_hexdigit())
                .then(|| (sha.to_owned(), name.clone()))
        })
        .collect()
}

#[derive(Default)]
pub(crate) struct Job {
    listing: Mutex<Option<(Instant, Arc<Listing>)>>,
    /// One fetch per file at a time: opening a file while the worker downloads it waits.
    fetching: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Files whose original could not be fetched since the app started; not retried in the
    /// background until a restart.
    failed: Mutex<HashSet<String>>,
    /// What the worker is doing; `Null` until its first pass reports.
    status: Mutex<Value>,
    /// When each file, by id, was last opened since the app started.
    opened: Mutex<HashMap<String, Instant>>,
    pub(crate) wake: tokio::sync::Notify,
}

impl Job {
    pub(crate) fn opened(&self, id: &str) {
        self.opened
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned(), Instant::now());
    }

    /// Lets a file the person opened leave this device at the next clean-up.
    fn release(&self, id: &str) {
        self.opened
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }

    fn set_status(&self, value: Value) {
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = value;
    }
}

async fn listing(db: &Database, folder: &Folder, fresh: bool) -> Result<Arc<Listing>> {
    if !fresh {
        if let Some((at, listing)) = &*db
            .originals
            .listing
            .lock()
            .unwrap_or_else(|p| p.into_inner())
        {
            if at.elapsed() < LISTING_AGE {
                return Ok(listing.clone());
            }
        }
    }
    let listing = Arc::new(Listing {
        media: by_hash(folder.list(MEDIA).await?),
        thumbs: by_hash(folder.list(THUMBS).await?),
    });
    *db.originals
        .listing
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), listing.clone()));
    Ok(listing)
}

fn forget_listing(db: &Database) {
    *db.originals
        .listing
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
}

/// Local thumbnails are named from the first 12 hex digits of the hash; the folder uses the
/// whole hash, so a listing finds them. Returns the rule's suffix (`.jpg`, `-crop.jpg`, ...).
fn thumbnail_suffix(name: &str, prefix: usize) -> Option<&str> {
    let suffix = name.get(prefix..)?;
    [
        ".jpg",
        media::CROPPED_THUMB_SUFFIX,
        media::ANIMATED_THUMB_SUFFIX,
    ]
    .contains(&suffix)
    .then_some(suffix)
}

fn extension(path: &str) -> Option<String> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    media::detect_kind(Path::new(&format!("file.{extension}"))).map(|_| extension)
}

/// Uploads every original and thumbnail of this device that the folder lacks.
async fn upload(db: &Database, folder: &Folder, listing: &Listing) -> Result<()> {
    let rows: Vec<(String, String, String, Option<String>)> = db
        .call(|c| {
            let mut s = c.prepare(
                "SELECT f.sha256, f.path, folders.path, f.thumb_path FROM files f
                 JOIN library_folders folders ON folders.id = f.folder_id
                 WHERE f.location_type = 'LOCAL' AND f.sha256 NOT IN (SELECT sha256 FROM trash) GROUP BY f.sha256",
            )?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    let missing: Vec<_> = rows
        .into_iter()
        .filter(|(sha, _, _, thumb)| {
            !listing.media.contains_key(sha)
                || (thumb.is_some() && !listing.thumbs.contains_key(sha))
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    folder.create_folder(MEDIA).await?;
    folder.create_folder(THUMBS).await?;
    let total = missing.len();
    for (done, (sha, path, root, thumb)) in missing.into_iter().enumerate() {
        db.originals
            .set_status(json!({"state": "uploading", "done": done, "total": total, "error": null}));
        if !listing.media.contains_key(&sha) {
            let Some(extension) = extension(&path) else {
                continue;
            };
            let local = db
                .library()
                .resolve_file(Path::new(&root), Path::new(&path))?;
            folder
                .put_file(&format!("{MEDIA}{sha}.{extension}"), &local)
                .await?;
        }
        if let Some(name) = thumb
            .as_deref()
            .and_then(|thumb| Path::new(thumb).file_name())
            .and_then(|name| name.to_str())
            .filter(|_| !listing.thumbs.contains_key(&sha))
        {
            let local = db.library().thumbnails.join(name);
            if let Some(suffix) = thumbnail_suffix(name, 12) {
                if tokio::fs::try_exists(&local).await? {
                    folder
                        .put_file(&format!("{THUMBS}{sha}{suffix}"), &local)
                        .await?;
                }
            }
        }
    }
    forget_listing(db);
    Ok(())
}

/// Gives files missing on this device the thumbnail another device stored in the folder.
async fn fetch_thumbnails(db: &Database, folder: &Folder, listing: &Listing) -> Result<()> {
    let wanted: Vec<String> = db
        .call(|c| {
            let mut s = c.prepare(
                "SELECT DISTINCT sha256 FROM files WHERE location_type = 'REMOTE' AND thumb_path IS NULL",
            )?;
            let rows = s
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    let directory = db.library().thumbnails.clone();
    tokio::fs::create_dir_all(&directory).await?;
    for sha in wanted {
        let Some(name) = listing.thumbs.get(&sha) else {
            continue;
        };
        let Some(suffix) = thumbnail_suffix(name, 64) else {
            continue;
        };
        let target = directory.join(format!("{}{suffix}", &sha[..12]));
        if !tokio::fs::try_exists(&target).await? {
            let part = tempfile::Builder::new()
                .prefix(".thumbnail-")
                .tempfile_in(&directory)?;
            if folder
                .download(&format!("{THUMBS}{name}"), part.path(), MAX_THUMBNAIL_BYTES)
                .await?
                .is_none()
            {
                continue;
            }
            part.persist(&target).map_err(|e| Error::Io(e.error))?;
        }
        let stored = target.to_string_lossy().into_owned();
        db.call(move |c| {
            c.execute(
                &format!("UPDATE files SET thumb_path = ?1, updated_at = {NOW} WHERE sha256 = ?2 AND location_type = 'REMOTE'"),
                params![stored, sha],
            )?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// Records of files that were waiting before every device showed the whole library come back
/// once the folder stores their original: then the file still exists somewhere.
async fn recall_set_aside(db: &Database, listing: &Listing) -> Result<()> {
    let stored: HashSet<String> = listing.media.keys().map(|sha| sync::key(&[sha])).collect();
    let recalled = db
        .call(move |c| {
            let tx = c.transaction()?;
            let aside: Vec<String> = tx
                .prepare("SELECT record_key FROM sync_records WHERE kind = 'file' AND applied = 2")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut recalled = 0;
            for key in aside.into_iter().filter(|key| stored.contains(key)) {
                recalled += tx.execute(
                    "UPDATE sync_records SET applied = 0 WHERE kind = 'file' AND record_key = ?1",
                    [key],
                )?;
            }
            tx.commit()?;
            Ok(recalled)
        })
        .await?;
    if recalled > 0 {
        db.sync.wake.notify_one();
    }
    Ok(())
}

/// Brings the original of a file missing on this device: from the sync folder, otherwise from
/// one of its booru favorites. Returns once the file's row is `LOCAL`.
pub(crate) async fn fetch(db: &Database, id: &str) -> Result<()> {
    let lookup = id.to_owned();
    let row = move |c: &mut Connection| -> Result<Option<(String, i64, String, String)>> {
        Ok(c.query_row(
            "SELECT sha256, size_bytes, location_type, path FROM files WHERE id = ?1",
            [&lookup],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?)
    };
    let Some((sha, ..)) = db.call(row.clone()).await? else {
        return Err(Error::Invalid("File not found.".into()));
    };
    let lock = db
        .originals
        .fetching
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(sha.clone())
        .or_default()
        .clone();
    let fetching = lock.lock().await;
    let result = fetch_locked(db, row).await;
    drop(fetching);
    let mut map = db
        .originals
        .fetching
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // The map and this call hold the only references: nobody else waits on this file.
    if Arc::strong_count(&lock) == 2 {
        map.remove(&sha);
    }
    result
}

async fn fetch_locked(
    db: &Database,
    row: impl Fn(&mut Connection) -> Result<Option<(String, i64, String, String)>>
        + Clone
        + Send
        + 'static,
) -> Result<()> {
    let Some((sha, size, location, path)) = db.call(row.clone()).await? else {
        return Err(Error::Invalid("File not found.".into()));
    };
    if location == "LOCAL" {
        return Ok(());
    }
    let mut folder_error = None;
    if let Some(folder) = sync::connected_folder(db).await? {
        match from_folder(db, &folder, &sha, size).await {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => folder_error = Some(error),
        }
    }
    let favorites: Vec<(String, String)> = db
        .call(move |c| {
            let mut s = c.prepare(
                "SELECT provider, remote_id FROM favorite_items WHERE user_id = ?1 AND file_path = ?2",
            )?;
            let rows = s
                .query_map(params![OWNER_ID, path], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    if !favorites.is_empty() {
        let sites = boorus::sites(db).await?;
        for (provider, remote_id) in favorites {
            let Some(site) = sites
                .iter()
                .find(|s| booru_favorites::provider(s) == provider)
            else {
                continue;
            };
            let imported = {
                let _writes = db.favorites.writes.lock().await;
                favorite_library::import(db, &Transport::default(), site, &remote_id, None).await
            };
            match imported {
                Ok(_) => {
                    if db
                        .call(row.clone())
                        .await?
                        .is_none_or(|(.., location, _)| location == "LOCAL")
                    {
                        return Ok(());
                    }
                }
                Err(error) => eprintln!("Cannot fetch {sha} from {provider}: {error}"),
            }
        }
    }
    Err(folder_error.unwrap_or_else(|| {
        Error::Remote("This file is not on this device, and neither the sync folder nor a booru favorite has its original. Open GoonCave on a device that has it and turn on Sync pictures and videos in Backup & sync.".into())
    }))
}

/// Downloads the original from the folder into `Synced` and imports it. Returns `false` when
/// the folder does not hold it.
async fn from_folder(db: &Database, folder: &Folder, sha: &str, size: i64) -> Result<bool> {
    let mut listing = listing(db, folder, false).await?;
    if !listing.media.contains_key(sha) {
        listing = self::listing(db, folder, true).await?;
    }
    let Some(name) = listing.media.get(sha).cloned() else {
        return Ok(false);
    };
    let Some(extension) = extension(&name) else {
        return Ok(false);
    };
    let (folder_id, directory) = db.call(|c| synced_folder(c)).await?;
    let target = directory.join(format!("{sha}.{extension}"));
    let part = tempfile::Builder::new()
        .prefix(".original-")
        .tempfile_in(&directory)?;
    let limit = u64::try_from(size).unwrap_or(0);
    let got = folder
        .download(&format!("{MEDIA}{name}"), part.path(), limit)
        .await?;
    if got.as_deref() != Some(sha) {
        return Err(Error::Remote(
            "The copy of this file in the WebDAV folder is damaged. Open GoonCave on the device that has it to upload it again.".into(),
        ));
    }
    part.persist(&target).map_err(|e| Error::Io(e.error))?;
    library::import(db, &folder_id, &target, None).await?;
    Ok(true)
}

/// Fetches in the background every original this device keeps and lacks.
async fn download(db: &Database, keep_all: bool) -> Result<()> {
    let keeps = if keep_all { "1" } else { KEPT };
    let ids: Vec<(String, String)> = db
        .call(move |c| {
            let mut s = c.prepare(&format!(
                "SELECT f.id, f.sha256 FROM files f JOIN library_folders lf ON lf.id = f.folder_id
                 WHERE f.location_type = 'REMOTE' AND f.sha256 NOT IN (SELECT sha256 FROM trash) AND {keeps}
                 ORDER BY f.created_at, f.id"
            ))?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    let ids: Vec<_> = {
        let failed = db
            .originals
            .failed
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        ids.into_iter()
            .filter(|(_, sha)| !failed.contains(sha))
            .collect()
    };
    let total = ids.len();
    for (done, (id, sha)) in ids.into_iter().enumerate() {
        db.originals.set_status(
            json!({"state": "downloading", "done": done, "total": total, "error": null}),
        );
        if let Err(error) = fetch(db, &id).await {
            eprintln!("Cannot fetch the original of {sha}: {error}");
            db.originals
                .failed
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(sha);
        }
    }
    Ok(())
}

// ---- Trash -------------------------------------------------------------------------------

/// Forgets file rows whose originals were removed from disk on purpose. When no copy of the
/// content is left on this device, the file is recorded as already deleted for good: its row and
/// thumbnail are gone, so a trash entry could not restore the original, and the record stops
/// another device's records from bringing it back. Returns thumbnails no row uses any more.
pub(crate) fn forget_deleted(c: &mut Connection, ids: &[String]) -> Result<Vec<String>> {
    let tx = c.transaction()?;
    let mut hashes = Vec::new();
    for id in ids {
        if let Some(sha) = tx
            .query_row("SELECT sha256 FROM files WHERE id = ?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
        {
            hashes.push(sha);
        }
    }
    let orphans = library::forget_files(&tx, ids)?;
    for sha in hashes {
        tx.execute(
            &format!(
                "INSERT INTO trash (sha256, trashed_at) SELECT ?1, {}
                WHERE NOT EXISTS(SELECT 1 FROM files WHERE sha256 = ?1)
                ON CONFLICT(sha256) DO UPDATE SET trashed_at = excluded.trashed_at",
                purge_before()
            ),
            [sha],
        )?;
    }
    tx.commit()?;
    Ok(orphans)
}

/// Moves a file to the trash, or deletes it for good at once when the trash is off.
pub(crate) async fn delete(db: &Database, id: &str) -> Result<bool> {
    let lookup = id.to_owned();
    let found = db
        .call(move |c| {
            let sha: Option<String> = c
                .query_row(
                    "SELECT f.sha256 FROM files f JOIN library_folders lf ON lf.id = f.folder_id WHERE f.id = ?1",
                    [lookup],
                    |r| r.get(0),
                )
                .optional()?;
            let trash = read_setting(c, TRASH_KEY, &json!(true))?.as_bool() != Some(false);
            Ok(sha.map(|sha| (sha, trash)))
        })
        .await?;
    let Some((sha, trash)) = found else {
        return Ok(false);
    };
    if !trash {
        let folder = match sync::connected_folder(db).await {
            Ok(folder) => folder,
            Err(error) => {
                eprintln!("Cannot reach the sync folder to delete {sha}: {error}");
                None
            }
        };
        purge_one(db, folder.as_ref(), &sha).await?;
    }
    // A file deleted for good keeps an expired entry, so other devices delete it too.
    let at = if trash {
        NOW.to_owned()
    } else {
        purge_before()
    };
    db.call(move |c| {
        c.execute(
            &format!(
                "INSERT INTO trash (sha256, trashed_at) VALUES (?1, {at})
                ON CONFLICT(sha256) DO UPDATE SET trashed_at = excluded.trashed_at"
            ),
            [sha],
        )?;
        Ok(())
    })
    .await?;
    Ok(true)
}

/// Deletes for good every file whose time in the trash is over.
async fn purge(db: &Database, folder: Option<&Folder>) -> Result<()> {
    let expired: Vec<String> = db
        .call(|c| {
            let mut s = c.prepare(&format!(
                "SELECT sha256 FROM trash WHERE trashed_at <= {} AND sha256 IN (SELECT sha256 FROM files)",
                purge_before()
            ))?;
            let rows = s
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    // One file that cannot be purged, such as a booru that refuses the unfavorite, must not
    // hold back the others or the rest of the worker's pass.
    for sha in expired {
        if let Err(error) = purge_one(db, folder, &sha).await {
            eprintln!("Cannot delete {sha} for good yet: {error}");
        }
    }
    Ok(())
}

/// Deletes from the sync folder the originals and thumbnails of files deleted for good. A device
/// that was offline when it purged a file leaves its copy behind; this removes it.
async fn purge_folder(db: &Database, folder: &Folder, listing: &Listing) -> Result<()> {
    let expired: HashSet<String> = db
        .call(|c| {
            let mut s = c.prepare(&format!(
                "SELECT sha256 FROM trash WHERE trashed_at <= {} AND sha256 NOT IN (SELECT sha256 FROM files)",
                purge_before()
            ))?;
            let rows = s
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    let mut removed = false;
    for (sha, name) in &listing.media {
        if expired.contains(sha) {
            folder.delete(&format!("{MEDIA}{name}")).await?;
            removed = true;
        }
    }
    for (sha, name) in &listing.thumbs {
        if expired.contains(sha) {
            folder.delete(&format!("{THUMBS}{name}")).await?;
            removed = true;
        }
    }
    if removed {
        forget_listing(db);
    }
    Ok(())
}

/// Removes the file from its booru favorites, then deletes every copy on this device and the
/// folder's original. A favorite that cannot be removed keeps the file for the next try.
async fn purge_one(db: &Database, folder: Option<&Folder>, sha: &str) -> Result<()> {
    let lookup = sha.to_owned();
    let copies: Vec<(String, String, String, String)> = db
        .call(move |c| {
            let mut s = c.prepare(
                "SELECT f.id, f.path, folders.path, f.location_type FROM files f
                 JOIN folders ON folders.id = f.folder_id WHERE f.sha256 = ?1",
            )?;
            let rows = s
                .query_map([lookup], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    {
        let _writes = db.favorites.writes.lock().await;
        for (_, path, _, _) in &copies {
            favorite_library::reverse_before_delete(db, Path::new(path)).await?;
        }
    }
    for (_, path, root, location) in &copies {
        if location != "LOCAL" {
            continue;
        }
        let path = db
            .library()
            .resolve_file(Path::new(root), Path::new(path))?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!("Cannot delete {}: {error}", path.display());
                return Err(Error::Storage("GoonCave could not delete the file from disk. Check that the library folder is writable, then try again.".into()));
            }
        }
    }
    let ids: Vec<String> = copies.into_iter().map(|(id, ..)| id).collect();
    let kept = sha.to_owned();
    let orphans = db
        .call(move |c| {
            let tx = c.transaction()?;
            let orphans = library::forget_files(&tx, &ids)?;
            tx.execute("DELETE FROM kept_files WHERE sha256 = ?1", [kept])?;
            tx.commit()?;
            Ok(orphans)
        })
        .await?;
    library::remove_thumbnails(&db.library().thumbnails, orphans).await;
    // The folder copy goes now when the folder answers; otherwise the next pass of any device
    // removes it (see `purge_folder`).
    if let Some(folder) = folder {
        let removed = async {
            let listing = listing(db, folder, false).await?;
            if let Some(name) = listing.media.get(sha) {
                folder.delete(&format!("{MEDIA}{name}")).await?;
            }
            if let Some(name) = listing.thumbs.get(sha) {
                folder.delete(&format!("{THUMBS}{name}")).await?;
            }
            forget_listing(db);
            Result::Ok(())
        }
        .await;
        if let Err(error) = removed {
            eprintln!("Cannot delete {sha} from the sync folder yet: {error}");
        }
    }
    crate::duplicate_policy::notify(db, "local-library-changed").await;
    Ok(())
}

// ---- Worker ------------------------------------------------------------------------------

async fn pass(db: &Database) -> Result<()> {
    let folder = sync::connected_folder(db).await?;
    purge(db, folder.as_ref()).await?;
    let settings = db.call(|c| settings(c)).await?;
    let mut known = Arc::new(Listing::default());
    if let Some(folder) = &folder {
        let listing = listing(db, folder, true).await?;
        purge_folder(db, folder, &listing).await?;
        recall_set_aside(db, &listing).await?;
        if settings.upload {
            upload(db, folder, &listing).await?;
        }
        fetch_thumbnails(db, folder, &listing).await?;
        known = listing;
    }
    // A running scan may be finding the originals of remote rows right now, for example after the
    // library moved: downloading or freeing them meanwhile would fetch copies the disk already has.
    if db.scan.running.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(());
    }
    if !settings.keep_all {
        free_space(db, &known).await?;
    }
    download(db, settings.keep_all).await
}

/// Moves originals between this device and the sync folder and empties the trash. Runs until
/// dropped.
pub(crate) async fn watch(db: Database) {
    loop {
        let result = pass(&db).await;
        db.originals.set_status(match &result {
            Ok(()) => json!({"state": "idle", "error": null}),
            Err(error) => {
                eprintln!("Moving originals failed: {error}");
                json!({"state": "error", "error": error.to_string()})
            }
        });
        tokio::select! {
            _ = db.originals.wake.notified() => {}
            _ = tokio::time::sleep(PERIOD) => {}
        }
    }
}

// ---- Routes ------------------------------------------------------------------------------

pub(crate) fn routes() -> Router<Database> {
    Router::new()
        .route("/originals", get(get_settings).put(put_settings))
        .route("/originals/preview", get(preview))
        .route("/files/{id}/keep", get(get_keep).put(put_keep))
        .route("/trash", get(trash))
        .route("/trash/settings", get(get_trash).put(put_trash))
        .route("/trash/empty", post(empty))
        .route("/trash/{sha}/restore", post(restore))
}

async fn get_settings(State(db): State<Database>) -> Result<Json<Value>> {
    let connected = db
        .call(|c| Ok(read_setting(c, "sync.webdav", &Value::Null)?.is_object()))
        .await?;
    let (settings, local_bytes) = db
        .call(|c| {
            let bytes: i64 = c.query_row(
                "SELECT coalesce(sum(size), 0) FROM (SELECT max(f.size_bytes) AS size FROM files f
                 JOIN library_folders lf ON lf.id = f.folder_id WHERE f.location_type = 'LOCAL' GROUP BY f.sha256)",
                [],
                |r| r.get(0),
            )?;
            Ok((settings(c)?, bytes))
        })
        .await?;
    let status = db
        .originals
        .status
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let status = if status.is_null() { json!({}) } else { status };
    Ok(Json(json!({
        "upload": settings.upload,
        "keepAll": settings.keep_all,
        "defaultKeepAll": DEFAULT_KEEP_ALL,
        "folderConnected": connected,
        "localBytes": local_bytes,
        "status": status,
    })))
}

async fn put_settings(State(db): State<Database>, body: axum::body::Bytes) -> Result<Json<Value>> {
    let invalid = || Error::Invalid("Send upload and keepAll as true or false.".into());
    let body: Value = serde_json::from_slice(&body).map_err(|_| invalid())?;
    let upload = match body.get("upload") {
        None => None,
        Some(value) => Some(value.as_bool().ok_or_else(invalid)?),
    };
    let keep_all = match body.get("keepAll") {
        None => None,
        Some(value) => Some(value.as_bool().ok_or_else(invalid)?),
    };
    db.call(move |c| {
        let current = settings(c)?;
        write_setting(
            c,
            SETTINGS_KEY,
            &json!({
                "upload": upload.unwrap_or(current.upload),
                "keepAll": keep_all.unwrap_or(current.keep_all),
            }),
        )
    })
    .await?;
    db.originals
        .failed
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
    db.originals.wake.notify_one();
    get_settings(State(db)).await
}

/// What `keepAll` would download, and at most what it would free on this device.
async fn preview(
    State(db): State<Database>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let keeps = match query.get("keepAll").map(String::as_str) {
        Some("true") => "1",
        Some("false") => KEPT,
        _ => return Err(Error::Invalid("keepAll must be true or false.".into())),
    };
    let (download, free) = db
        .call(move |c| {
            let count = |location: &str, kept: bool| -> Result<(i64, i64)> {
                let condition = if kept { keeps.to_owned() } else { format!("NOT ({keeps})") };
                Ok(c.query_row(
                    &format!("SELECT count(*), coalesce(sum(size), 0) FROM (SELECT max(f.size_bytes) AS size FROM files f
                     JOIN library_folders lf ON lf.id = f.folder_id
                     WHERE f.location_type = ?1 AND f.sha256 NOT IN (SELECT sha256 FROM trash) AND {condition} GROUP BY f.sha256)"),
                    [location],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            };
            Ok((count("REMOTE", true)?, count("LOCAL", false)?))
        })
        .await?;
    Ok(Json(json!({
        "download": {"files": download.0, "bytes": download.1},
        "free": {"files": free.0, "bytes": free.1},
    })))
}

/// Deletes from this device the originals that have a copy elsewhere: in the sync folder, or
/// on a booru for a booru favorite. Files kept by hand and files opened lately stay. The files
/// stay in the library as missing on this device.
async fn free_space(db: &Database, listing: &Listing) -> Result<()> {
    let rows: Vec<(String, String, String, String, bool)> = db
        .call(move |c| {
            let mut s = c.prepare(&format!(
                "SELECT f.id, f.sha256, f.path, lf.path,
                   EXISTS(SELECT 1 FROM favorite_items fav WHERE fav.user_id = lf.user_id AND fav.file_path = f.path)
                 FROM files f JOIN library_folders lf ON lf.id = f.folder_id
                 WHERE f.location_type = 'LOCAL' AND NOT ({KEPT})
                   AND NOT EXISTS(SELECT 1 FROM files r WHERE r.sha256 = f.sha256 AND r.location_type = 'REMOTE')"
            ))?;
            let rows = s
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
        .await?;
    let recent: HashSet<String> = {
        let mut opened = db
            .originals
            .opened
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        opened.retain(|_, at| at.elapsed() < OPEN_GRACE);
        opened.keys().cloned().collect()
    };
    // Two copies of the same content on this device: one stays, so no two rows share a remote path.
    let mut freed = HashSet::new();
    for (id, sha, path, root, favorite) in rows {
        let copied = favorite || listing.media.contains_key(&sha);
        if !copied || recent.contains(&id) || !freed.insert(sha.clone()) {
            continue;
        }
        let local = db
            .library()
            .resolve_file(Path::new(&root), Path::new(&path))?;
        match tokio::fs::remove_file(&local).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        db.call(move |c| {
            let tx = c.transaction()?;
            let (folder, directory) = synced_folder(&tx)?;
            let remote = directory.join(&sha).to_string_lossy().into_owned();
            tx.execute(
                &format!("UPDATE files SET folder_id = ?2, path = ?3, location_type = 'REMOTE', updated_at = {NOW} WHERE id = ?1"),
                params![id, folder, remote],
            )?;
            tx.execute(
                "UPDATE favorite_items SET file_path = ?2 WHERE user_id = ?3 AND file_path = ?1",
                params![path, remote, OWNER_ID],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

async fn get_keep(
    State(db): State<Database>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Value>> {
    let kept = db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM kept_files k JOIN files f ON f.sha256 = k.sha256 WHERE f.id = ?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )?)
        })
        .await?;
    Ok(Json(json!({"kept": kept})))
}

/// Keeps a file on this device whatever the setting, downloading it when it is missing, or lets
/// the setting decide again.
async fn put_keep(
    State(db): State<Database>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let keep = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|body| body["kept"].as_bool())
        .ok_or_else(|| Error::Invalid("Send kept as true or false.".into()))?;
    let lookup = id.clone();
    let found = db
        .call(move |c| {
            let Some(sha) = c
                .query_row("SELECT sha256 FROM files WHERE id = ?1", [&lookup], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
            else {
                return Ok(false);
            };
            if keep {
                c.execute(
                    "INSERT OR IGNORE INTO kept_files (sha256) VALUES (?1)",
                    [sha],
                )?;
            } else {
                c.execute("DELETE FROM kept_files WHERE sha256 = ?1", [sha])?;
            }
            Ok(true)
        })
        .await?;
    if !found {
        return Err(Error::Invalid("File not found.".into()));
    }
    if keep {
        fetch(&db, &id).await?;
    } else {
        // Keeping it downloaded it, which counts as opening it: without this it would stay a day.
        db.originals.release(&id);
        db.originals.wake.notify_one();
    }
    get_keep(State(db), axum::extract::Path(id)).await
}

async fn trash(State(db): State<Database>) -> Result<Json<Value>> {
    db.call(|c| {
        let mut s = c.prepare(&format!(
            "SELECT f.*, NULL AS vote_score, NULL AS next_vote_at, '[]' AS favorite_providers,
               t.trashed_at, strftime('%Y-%m-%dT%H:%M:%fZ', t.trashed_at, '+{TRASH_DAYS} days') AS purge_at
             FROM trash t JOIN files f ON f.id = (SELECT id FROM files WHERE sha256 = t.sha256 ORDER BY location_type, created_at LIMIT 1)
             ORDER BY t.trashed_at DESC"
        ))?;
        let files = s
            .query_map([], |r| {
                let mut file = crate::files::file_json(r)?;
                file["trashedAt"] = json!(r.get::<_, String>("trashed_at")?);
                file["purgeAt"] = json!(r.get::<_, String>("purge_at")?);
                Ok(file)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Json(json!({"files": files, "days": TRASH_DAYS})))
    })
    .await
}

async fn get_trash(State(db): State<Database>) -> Result<Json<Value>> {
    let enabled = db
        .call(|c| read_setting(c, TRASH_KEY, &json!(true)))
        .await?
        .as_bool()
        != Some(false);
    Ok(Json(json!({"enabled": enabled, "days": TRASH_DAYS})))
}

async fn put_trash(State(db): State<Database>, body: axum::body::Bytes) -> Result<Json<Value>> {
    let body: Value = serde_json::from_slice(&body)
        .map_err(|_| Error::Invalid("Send enabled as true or false.".into()))?;
    let enabled = body["enabled"]
        .as_bool()
        .ok_or_else(|| Error::Invalid("Send enabled as true or false.".into()))?;
    db.call(move |c| write_setting(c, TRASH_KEY, &json!(enabled)))
        .await?;
    get_trash(State(db)).await
}

async fn restore(State(db): State<Database>, UrlPath(sha): UrlPath<String>) -> Result<Json<Value>> {
    let restored = db
        .call(move |c| {
            Ok(c.execute(
                &format!(
                    "DELETE FROM trash WHERE sha256 = ?1 AND trashed_at > {}",
                    purge_before()
                ),
                [sha],
            )?)
        })
        .await?;
    if restored == 0 {
        return Err(Error::Invalid(
            "This file is no longer in the trash: it was deleted for good.".into(),
        ));
    }
    Ok(Json(json!({"status": "restored"})))
}

async fn empty(State(db): State<Database>) -> Result<Json<Value>> {
    let at = purge_before();
    db.call(move |c| {
        c.execute(
            &format!("UPDATE trash SET trashed_at = {at} WHERE trashed_at > {at}"),
            [],
        )?;
        Ok(())
    })
    .await?;
    let folder = sync::connected_folder(&db).await?;
    purge(&db, folder.as_ref()).await?;
    Ok(Json(json!({"status": "emptied"})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{
        tests::{fixtures, serve, Device},
        Trigger,
    };

    async fn choose(device: &Device, value: Value) {
        device
            .db
            .call(move |c| write_setting(c, SETTINGS_KEY, &value))
            .await
            .unwrap();
    }

    async fn count(device: &Device, query: &str) -> String {
        device.value(query).await.unwrap_or_default()
    }

    #[tokio::test]
    async fn a_file_from_another_device_shows_then_opens_from_the_sync_folder() {
        let (url, dav) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("one.png", &files.first)]).await;
        choose(&a, json!({"upload": true, "keepAll": true})).await;
        a.sync(Trigger::Full).await;
        pass(&a.db).await.unwrap();
        let sha = a.value("SELECT sha256 FROM files").await.unwrap();
        let stored = dav.files();
        assert_eq!(
            stored[&format!("/dav/GoonCave/media/{sha}.png")].0,
            std::fs::read(&files.first).unwrap()
        );
        assert!(
            stored
                .keys()
                .any(|path| path.starts_with(&format!("/dav/GoonCave/thumbnails/{sha}"))),
            "{:?}",
            stored.keys()
        );

        let b = Device::open(&url, &[]).await;
        choose(&b, json!({"keepAll": false})).await;
        b.sync(Trigger::Full).await;
        pass(&b.db).await.unwrap();
        assert_eq!(
            b.value("SELECT location_type FROM files").await.as_deref(),
            Some("REMOTE"),
            "Keep nothing downloads nothing in the background"
        );
        let thumb = b.value("SELECT thumb_path FROM files").await.unwrap();
        assert!(
            Path::new(&thumb).is_file(),
            "the thumbnail comes from the folder"
        );

        let id = b.value("SELECT id FROM files").await.unwrap();
        fetch(&b.db, &id).await.unwrap();
        let path = b
            .value("SELECT path FROM files WHERE location_type = 'LOCAL'")
            .await
            .unwrap();
        assert!(path.ends_with(&format!("{SYNCED_DIR}/{sha}.png")), "{path}");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            std::fs::read(&files.first).unwrap()
        );
        assert_eq!(
            count(&b, "SELECT CAST(count(*) AS TEXT) FROM files").await,
            "1"
        );
    }

    #[tokio::test]
    async fn nothing_downloads_while_a_scan_may_still_find_the_originals() {
        let (url, _dav) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("one.png", &files.first)]).await;
        choose(&a, json!({"upload": true})).await;
        a.sync(Trigger::Full).await;
        pass(&a.db).await.unwrap();

        let b = Device::open(&url, &[]).await;
        b.sync(Trigger::Full).await;
        b.db.scan
            .running
            .store(true, std::sync::atomic::Ordering::Relaxed);
        pass(&b.db).await.unwrap();
        assert_eq!(
            b.value("SELECT location_type FROM files").await.as_deref(),
            Some("REMOTE")
        );

        b.db.scan
            .running
            .store(false, std::sync::atomic::Ordering::Relaxed);
        pass(&b.db).await.unwrap();
        assert_eq!(
            b.value("SELECT location_type FROM files").await.as_deref(),
            Some("LOCAL")
        );
    }

    #[tokio::test]
    async fn keep_everything_downloads_in_the_background_and_refuses_a_damaged_copy() {
        let (url, dav) = serve().await;
        let files = fixtures();
        let a = Device::open(
            &url,
            &[("one.png", &files.first), ("two.png", &files.second)],
        )
        .await;
        choose(&a, json!({"upload": true})).await;
        a.sync(Trigger::Full).await;
        pass(&a.db).await.unwrap();
        let damaged = a
            .value("SELECT sha256 FROM files WHERE path LIKE '%two.png'")
            .await
            .unwrap();
        dav.0
            .lock()
            .unwrap()
            .get_mut(&format!("/dav/GoonCave/media/{damaged}.png"))
            .unwrap()
            .0
            .truncate(10);

        let b = Device::open(&url, &[]).await;
        b.sync(Trigger::Full).await;
        pass(&b.db).await.unwrap();
        assert_eq!(
            b.value(&format!(
                "SELECT location_type FROM files WHERE sha256 = '{damaged}'"
            ))
            .await
            .as_deref(),
            Some("REMOTE"),
            "a damaged copy is not imported"
        );
        assert_eq!(
            b.value(&format!(
                "SELECT location_type FROM files WHERE sha256 <> '{damaged}'"
            ))
            .await
            .as_deref(),
            Some("LOCAL")
        );
        let id = b
            .value(&format!("SELECT id FROM files WHERE sha256 = '{damaged}'"))
            .await
            .unwrap();
        let error = fetch(&b.db, &id).await.unwrap_err().to_string();
        assert!(error.contains("damaged"), "{error}");
    }

    #[tokio::test]
    async fn a_deleted_file_waits_in_the_trash_on_every_device_then_goes_for_good() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("one.png", &files.first)]).await;
        let b = Device::open(&url, &[("copy.png", &files.first)]).await;
        a.sync(Trigger::Full).await;
        b.sync(Trigger::Full).await;
        let visible = "SELECT CAST(count(*) AS TEXT) FROM files WHERE sha256 NOT IN (SELECT sha256 FROM trash)";

        let id = a.value("SELECT id FROM files").await.unwrap();
        assert!(delete(&a.db, &id).await.unwrap());
        a.sync(Trigger::Change).await;
        b.sync(Trigger::Full).await;
        assert_eq!(
            count(&b, visible).await,
            "0",
            "the trash hides it everywhere"
        );
        let copy = b.db.library().root.join("copy.png");
        assert!(copy.is_file(), "the trash keeps the originals");

        let sha = a.value("SELECT sha256 FROM files").await.unwrap();
        b.sql(&format!("DELETE FROM trash WHERE sha256 = '{sha}'"))
            .await;
        b.sync(Trigger::Change).await;
        a.sync(Trigger::Full).await;
        assert_eq!(
            count(&a, visible).await,
            "1",
            "a restore reaches every device"
        );

        assert!(delete(&a.db, &id).await.unwrap());
        a.sql("UPDATE trash SET trashed_at = '2000-01-01T00:00:00.000Z'")
            .await;
        a.sync(Trigger::Change).await;
        pass(&a.db).await.unwrap();
        assert!(!a.db.library().root.join("one.png").exists());
        b.sync(Trigger::Full).await;
        pass(&b.db).await.unwrap();
        assert!(!copy.exists(), "every device deletes its copy");
        b.sync(Trigger::Full).await;
        assert_eq!(
            count(&b, "SELECT CAST(count(*) AS TEXT) FROM files").await,
            "0",
            "a file deleted for good does not come back from records"
        );
        assert!(
            restore(State(a.db.clone()), UrlPath(sha.clone()))
                .await
                .is_err(),
            "a file deleted for good cannot be restored"
        );

        std::fs::copy(&files.first, &copy).unwrap();
        crate::library::scan(&b.db).await.unwrap();
        pass(&b.db).await.unwrap();
        assert!(
            copy.is_file(),
            "a new copy of a deleted file is not deleted again"
        );
        assert_eq!(count(&b, visible).await, "1", "and it shows in the gallery");
    }

    #[tokio::test]
    async fn keeping_nothing_frees_booru_favorites_but_keeps_files_without_a_copy() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(
            &url,
            &[("liked.png", &files.first), ("mine.png", &files.second)],
        )
        .await;
        a.sql(&format!(
            "INSERT INTO favorite_items (user_id, provider, remote_id, file_path, created_at, updated_at)
             SELECT '{OWNER_ID}', 'e621', '1', path, {NOW}, {NOW} FROM files WHERE path LIKE '%liked.png'"
        ))
        .await;
        choose(&a, json!({"keepAll": false})).await;
        pass(&a.db).await.unwrap();
        assert!(
            !a.db.library().root.join("liked.png").exists(),
            "the booru keeps a copy"
        );
        assert!(
            a.db.library().root.join("mine.png").exists(),
            "no copy anywhere else"
        );
        assert_eq!(
            a.value("SELECT location_type FROM files f JOIN favorite_items fav ON fav.file_path = f.path").await.as_deref(),
            Some("REMOTE"),
            "the favorite follows the file"
        );
    }

    #[tokio::test]
    async fn the_settings_load_before_the_first_pass_reports_a_status() {
        let (url, _) = serve().await;
        let a = Device::open(&url, &[]).await;
        let Json(settings) = get_settings(State(a.db.clone())).await.unwrap();
        assert!(settings["status"].is_object(), "{settings}");
    }

    #[tokio::test]
    async fn a_file_no_longer_kept_leaves_at_the_next_clean_up_even_when_opened() {
        let (url, _) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("liked.png", &files.first)]).await;
        a.sql(&format!(
            "INSERT INTO favorite_items (user_id, provider, remote_id, file_path, created_at, updated_at)
             SELECT '{OWNER_ID}', 'e621', '1', path, {NOW}, {NOW} FROM files"
        ))
        .await;
        choose(&a, json!({"keepAll": false})).await;
        let id = a.value("SELECT id FROM files").await.unwrap();
        a.db.originals.opened(&id);
        let unkeep = put_keep(
            State(a.db.clone()),
            axum::extract::Path(id),
            axum::body::Bytes::from_static(br#"{"kept":false}"#),
        );
        assert!(unkeep.await.is_ok());
        pass(&a.db).await.unwrap();
        assert_eq!(
            a.value("SELECT location_type FROM files").await.as_deref(),
            Some("REMOTE")
        );
    }

    #[tokio::test]
    async fn a_device_that_keeps_nothing_frees_what_the_folder_holds_and_set_aside_records_return()
    {
        let (url, dav) = serve().await;
        let files = fixtures();
        let a = Device::open(&url, &[("one.png", &files.first)]).await;
        a.sync(Trigger::Full).await;
        let b = Device::open(&url, &[]).await;
        b.sync(Trigger::Full).await;
        b.sql("DELETE FROM files; UPDATE sync_records SET applied = 2 WHERE kind = 'file'")
            .await;
        b.sync(Trigger::Full).await;
        assert_eq!(
            count(&b, "SELECT CAST(count(*) AS TEXT) FROM files").await,
            "0"
        );

        choose(&a, json!({"upload": true})).await;
        pass(&a.db).await.unwrap();
        assert!(dav.files().keys().any(|path| path.contains("/media/")));
        choose(&b, json!({"keepAll": false})).await;
        pass(&b.db).await.unwrap();
        b.sync(Trigger::Full).await;
        assert_eq!(
            b.value("SELECT location_type FROM files").await.as_deref(),
            Some("REMOTE"),
            "the folder's original brings the file back"
        );

        choose(&a, json!({"upload": true, "keepAll": false})).await;
        let opened = a.value("SELECT id FROM files").await.unwrap();
        a.db.originals.opened(&opened);
        pass(&a.db).await.unwrap();
        assert!(
            a.db.library().root.join("one.png").exists(),
            "a file just opened stays"
        );
        a.db.originals.opened.lock().unwrap().clear();
        a.sql("INSERT INTO kept_files (sha256) SELECT sha256 FROM files")
            .await;
        pass(&a.db).await.unwrap();
        assert!(
            a.db.library().root.join("one.png").exists(),
            "a file kept by hand stays"
        );
        a.sql("DELETE FROM kept_files").await;
        pass(&a.db).await.unwrap();
        assert!(
            !a.db.library().root.join("one.png").exists(),
            "the folder has it, so it leaves the device"
        );
        assert_eq!(
            a.value("SELECT location_type FROM files").await.as_deref(),
            Some("REMOTE")
        );
    }
}
