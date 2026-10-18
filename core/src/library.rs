use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
    time::{Duration, SystemTime},
};

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::{
    db::{Database, OWNER_ID},
    media::{self, MediaKind},
    Error, Result,
};

/// How often the library folder is checked for added, changed and removed files.
pub const RESCAN_INTERVAL: Duration = Duration::from_secs(60);

pub(crate) const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// File versions processed in this run, as `(path, size, mtime)`. An unchanged file without a
/// thumbnail is retried after a restart, not on every rescan.
static THUMBNAIL_RETRIED: LazyLock<Mutex<HashSet<(String, i64, String)>>> =
    LazyLock::new(Mutex::default);

/// What the library scan reports while it runs.
#[derive(Default)]
pub(crate) struct Progress {
    pub(crate) running: AtomicBool,
    /// Media files found on disk by the latest walk of each folder, by folder id.
    found: Mutex<HashMap<String, u64>>,
}

impl Progress {
    pub(crate) fn found(&self) -> u64 {
        self.found
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .sum()
    }
}

/// `2026-01-31T12:00:00.123Z`, the reference backend's timestamp format, truncated to milliseconds.
pub(crate) fn iso_millis(time: SystemTime) -> String {
    let time = time::OffsetDateTime::from(time);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    )
}

/// Gives a file this app wrote itself (a fetched original, a downloaded favorite) the
/// modification time of the row that already holds its content. The gallery sorts by that time,
/// so without this the file would jump to the top as new at the moment of the download.
/// Returns the time it now has, when the content was already known.
pub(crate) async fn restore_place(
    database: &Database,
    path: &Path,
    sha256: &str,
) -> Result<Option<String>> {
    let sha256 = sha256.to_owned();
    let place: Option<String> = database
        .call(move |connection| {
            Ok(connection
                .query_row(
                    "SELECT mtime FROM files WHERE sha256 = ?1
                     ORDER BY location_type = 'REMOTE' DESC, created_at LIMIT 1",
                    [sha256],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .await?;
    let Some(place) = place else {
        return Ok(None);
    };
    let time = time::OffsetDateTime::parse(&place, &time::format_description::well_known::Rfc3339)
        .map_err(|error| Error::Storage(format!("Invalid file time {place}: {error}")))?;
    let file = std::fs::File::options().write(true).open(path)?;
    file.set_modified(time.into())?;
    Ok(Some(place))
}

pub(crate) struct Known {
    id: String,
    size: i64,
    mtime: String,
    sha256: String,
    thumb: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

pub(crate) struct Scanned {
    path: String,
    size: i64,
    pub(crate) mtime: String,
    pub(crate) sha256: String,
    phash: Option<String>,
    kind: MediaKind,
    probe: media::Probe,
    thumb: Option<String>,
}

/// Runs a full scan now, again shortly after files change in the library, and every
/// [`RESCAN_INTERVAL`] in case a change notice was missed, until the task is dropped.
pub async fn watch(database: Database) {
    let (changed, mut changes) = tokio::sync::mpsc::unbounded_channel();
    // Dropping the watcher stops the notices, so it lives as long as this task.
    let _watcher = watch_changes(&database.library().root, changed);
    loop {
        let started = tokio::time::Instant::now();
        if let Err(error) = scan(&database).await {
            eprintln!("Library scan failed: {error}");
        }
        tokio::select! {
            _ = tokio::time::sleep(RESCAN_INTERVAL) => {}
            Some(()) = changes.recv() => {
                // A copy arrives in many writes; scan once they settle. While a sync keeps
                // writing downloads, which it indexes itself, scan at most once per gap.
                let settled = tokio::time::Instant::now() + CHANGE_SETTLE;
                tokio::time::sleep_until(settled.max(started + CHANGE_GAP)).await;
                while changes.try_recv().is_ok() {}
            }
        }
    }
}

const CHANGE_SETTLE: Duration = Duration::from_secs(2);
const CHANGE_GAP: Duration = Duration::from_secs(10);

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn watch_changes(
    root: &Path,
    changed: tokio::sync::mpsc::UnboundedSender<()>,
) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher;
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok_and(|event| !event.kind.is_access()) {
            let _ = changed.send(());
        }
    });
    let watched = watcher.and_then(|mut watcher| {
        watcher.watch(root, notify::RecursiveMode::Recursive)?;
        Ok(watcher)
    });
    watched
        .inspect_err(|error| {
            eprintln!(
                "Cannot watch {} for changes, rescanning every {}s: {error}",
                root.display(),
                RESCAN_INTERVAL.as_secs()
            );
        })
        .ok()
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn watch_changes(_root: &Path, _changed: tokio::sync::mpsc::UnboundedSender<()>) -> Option<()> {
    None
}

/// The root folder and each of its direct subfolders, as stored rows `(id, path)`.
async fn sync_folders(database: &Database) -> Result<Vec<(String, PathBuf)>> {
    let root = database.library().root.clone();
    database.library().resolve_folder(&root)?;
    let mut children = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            children.push(entry.path());
        }
    }
    let (folders, orphans) = database
        .call(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute("DELETE FROM active_library_folders", [])?;
            let mut managed = vec![root.clone()];
            managed.extend(children);
            let mut folders = Vec::new();
            for path in &managed {
                let path_text = path.to_string_lossy().into_owned();
                let existing: Option<String> = transaction
                    .query_row(
                        "SELECT id FROM folders WHERE user_id = ?1 AND path = ?2",
                        params![OWNER_ID, path_text],
                        |row| row.get(0),
                    )
                    .optional()?;
                let id = match existing {
                    Some(id) => id,
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        transaction.execute(
                            &format!("INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status) VALUES (?1, ?2, ?3, 'LOCAL', {NOW}, {NOW}, 'IDLE')"),
                            params![id, OWNER_ID, path_text],
                        )?;
                        id
                    }
                };
                transaction.execute("INSERT INTO active_library_folders (id) VALUES (?1)", [&id])?;
                folders.push((id, path.clone()));
            }
            // A subfolder removed or renamed on disk takes its rows with it.
            let stale: Vec<String> = {
                let mut statement =
                    transaction.prepare("SELECT id, path FROM folders WHERE user_id = ?1")?;
                let rows = statement.query_map([OWNER_ID], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                let mut stale = Vec::new();
                for row in rows {
                    let (id, path) = row?;
                    let path = PathBuf::from(path);
                    if path.parent() == Some(root.as_path()) && !managed.contains(&path) {
                        stale.push(id);
                    }
                }
                stale
            };
            let mut orphans = Vec::new();
            for folder in stale {
                let ids: Vec<String> = {
                    let mut statement =
                        transaction.prepare("SELECT id FROM files WHERE folder_id = ?1")?;
                    let ids = statement
                        .query_map([&folder], |row| row.get(0))?
                        .collect::<rusqlite::Result<_>>()?;
                    ids
                };
                orphans.extend(forget_files(&transaction, &ids)?);
                transaction.execute("DELETE FROM folders WHERE id = ?1", [&folder])?;
            }
            transaction.commit()?;
            Ok((folders, orphans))
        })
        .await?;
    remove_thumbnails(&database.library().thumbnails, orphans).await;
    Ok(folders)
}

/// Scans every managed folder: imports new and changed files, drops rows of removed ones.
pub async fn scan(database: &Database) -> Result<()> {
    database.scan.running.store(true, Ordering::Relaxed);
    let result = scan_all(database).await;
    database.scan.running.store(false, Ordering::Relaxed);
    result
}

async fn scan_all(database: &Database) -> Result<()> {
    let root = database.library().root.clone();
    let folders = sync_folders(database).await?;
    database
        .scan
        .found
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|id, _| folders.iter().any(|(folder, _)| folder == id));
    let subfolders: HashSet<PathBuf> = folders
        .iter()
        .map(|(_, path)| path.clone())
        .filter(|path| path != &root)
        .collect();
    let mut changed = false;
    for (folder, path) in folders {
        let result = scan_folder(database, &folder, &path, &subfolders).await;
        // A folder that failed partway may have imported or removed files before the error.
        changed |= !matches!(result, Ok(false));
        let id = folder.clone();
        database
            .call(move |connection| {
                connection.execute(
                    &format!("UPDATE folders SET status = 'IDLE', last_scan_at = {NOW}, updated_at = {NOW} WHERE id = ?1"),
                    [id],
                )?;
                Ok(())
            })
            .await?;
        if let Err(error) = result {
            eprintln!("Scan of {} failed: {error}", path.display());
        }
    }
    if changed {
        crate::duplicate_policy::notify(database, "local-library-changed").await;
    }
    Ok(())
}

fn media_paths(directory: &Path, skip: &HashSet<PathBuf>, found: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        // Symbolic links are skipped: they could lead outside the library folder.
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if !skip.contains(&path) {
                media_paths(&path, skip, found)?;
            }
        } else if file_type.is_file() && media::detect_kind(&path).is_some() {
            found.push(path);
        }
    }
    Ok(())
}

async fn scan_folder(
    database: &Database,
    folder: &str,
    directory: &Path,
    subfolders: &HashSet<PathBuf>,
) -> Result<bool> {
    database.library().resolve_folder(directory)?;
    let id = folder.to_owned();
    let known: HashMap<String, Known> = database
        .call(move |connection| {
            connection.execute(
                &format!("UPDATE folders SET status = 'SCANNING', updated_at = {NOW} WHERE id = ?1"),
                [&id],
            )?;
            let mut statement = connection.prepare(
                "SELECT id, path, size_bytes, mtime, thumb_path, width, height, sha256 FROM files WHERE folder_id = ?1 AND location_type = 'LOCAL'",
            )?;
            let rows = statement.query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    Known {
                        id: row.get(0)?,
                        size: row.get(2)?,
                        mtime: row.get(3)?,
                        thumb: row.get(4)?,
                        width: row.get(5)?,
                        height: row.get(6)?,
                        sha256: row.get(7)?,
                    },
                ))
            })?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        })
        .await?;
    let directory = directory.to_owned();
    let skip = subfolders.clone();
    let paths = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        media_paths(&directory, &skip, &mut found).map(|()| found)
    })
    .await
    .map_err(|error| Error::Storage(error.to_string()))??;
    database
        .scan
        .found
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(folder.to_owned(), paths.len() as u64);
    let mut seen = HashSet::new();
    let mut changed = false;
    for path in paths {
        let path_text = path.to_string_lossy().into_owned();
        seen.insert(path_text.clone());
        match import(database, folder, &path, known.get(&path_text)).await {
            Ok(imported) => changed |= imported,
            Err(error) => eprintln!("Cannot import {}: {error}", path.display()),
        }
    }
    let removed: Vec<String> = known
        .into_iter()
        .filter(|(path, _)| !seen.contains(path))
        .map(|(_, known)| known.id)
        .collect();
    if !removed.is_empty() {
        let orphans = database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                let orphans = forget_files(&transaction, &removed)?;
                transaction.commit()?;
                Ok(orphans)
            })
            .await?;
        remove_thumbnails(&database.library().thumbnails, orphans).await;
        changed = true;
    }
    Ok(changed)
}

/// Whether an unchanged file still needs its thumbnail: none was made, or another rule made it.
fn needs_thumbnail(known: &Known, path: &Path) -> bool {
    match &known.thumb {
        None => true,
        Some(thumb) if media::is_gif(path) => !thumb.ends_with(media::ANIMATED_THUMB_SUFFIX),
        Some(thumb) => {
            media::is_strip(known.width, known.height)
                && !thumb.ends_with(media::CROPPED_THUMB_SUFFIX)
        }
    }
}

/// Imports one file into `folder`. An unchanged file is skipped unless it still needs a
/// thumbnail and was not tried in this run; its stored hash is reused. Returns whether the file
/// is new or its content changed.
pub(crate) async fn import(
    database: &Database,
    folder: &str,
    path: &Path,
    known: Option<&Known>,
) -> Result<bool> {
    let metadata = tokio::fs::metadata(path).await?;
    let size =
        i64::try_from(metadata.len()).map_err(|_| Error::Storage("file too large".into()))?;
    let mtime = iso_millis(metadata.modified()?);
    // Every processing attempt is recorded, so an unchanged file is tried at most once per run.
    let first_attempt = THUMBNAIL_RETRIED
        .lock()
        .map_err(|_| Error::Storage("scan state lock poisoned".into()))?
        .insert((path.to_string_lossy().into_owned(), size, mtime.clone()));
    let mut sha256 = None;
    if let Some(known) = known.filter(|known| known.size == size && known.mtime == mtime) {
        if !first_attempt || !needs_thumbnail(known, path) {
            return Ok(false);
        }
        sha256 = Some(known.sha256.clone());
    }
    let scanned = process(database, path, size, mtime, sha256).await?;
    let changed = known.is_none_or(|known| known.sha256 != scanned.sha256);
    let folder = folder.to_owned();
    let previous = known.and_then(|known| known.thumb.clone());
    let replaced = database
        .call(move |connection| {
            upsert(connection, &folder, &scanned)?;
            Ok(match previous {
                Some(previous) if !thumb_in_use(connection, &previous)? => vec![previous],
                _ => Vec::new(),
            })
        })
        .await?;
    remove_thumbnails(&database.library().thumbnails, replaced).await;
    Ok(changed)
}

pub(crate) async fn process(
    database: &Database,
    path: &Path,
    size: i64,
    mtime: String,
    sha256: Option<String>,
) -> Result<Scanned> {
    let path = database
        .library()
        .resolve_file(&database.library().root, path)?;
    let kind =
        media::detect_kind(&path).ok_or_else(|| Error::Invalid("Unsupported file type".into()))?;
    let sha256 = match sha256 {
        Some(sha256) => sha256,
        None => {
            let hashed = path.to_owned();
            tokio::task::spawn_blocking(move || sha256_of(&hashed))
                .await
                .map_err(|error| Error::Storage(error.to_string()))??
        }
    };
    let probe = media::probe(&path, kind).await.unwrap_or_else(|error| {
        eprintln!("Cannot read size of {}: {error}", path.display());
        media::Probe::default()
    });
    let phash = match kind {
        MediaKind::Image => media::average_hash(&path)
            .await
            .map_err(|error| eprintln!("Cannot hash {}: {error}", path.display()))
            .ok(),
        MediaKind::Video => None,
    };
    let thumb = media::thumbnail(
        &path,
        kind,
        probe,
        &database.library().thumbnails,
        &sha256[..12],
    )
    .await
    .map_err(|error| eprintln!("Cannot make thumbnail of {}: {error}", path.display()))
    .ok()
    .map(|thumb| thumb.to_string_lossy().into_owned());
    Ok(Scanned {
        path: path.to_string_lossy().into_owned(),
        size,
        mtime,
        sha256,
        phash,
        kind,
        probe,
        thumb,
    })
}

fn sha256_of(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Inserts or updates the row for `scanned.path`; returns the file id.
pub(crate) fn upsert(connection: &Connection, folder: &str, scanned: &Scanned) -> Result<String> {
    let existing: Option<String> = connection
        .query_row(
            "SELECT id FROM files WHERE folder_id = ?1 AND path = ?2",
            params![folder, scanned.path],
            |row| row.get(0),
        )
        .optional()?;
    let existing = match existing {
        Some(id) => Some(id),
        None => crate::originals::claim_remote(connection, &scanned.sha256, folder, &scanned.path)?,
    };
    if existing.is_none() {
        // A new copy of a deleted file brings it back: without this, the purge would delete
        // it again and remove its booru favorite.
        connection.execute("DELETE FROM trash WHERE sha256 = ?1", [&scanned.sha256])?;
    }
    let id = existing
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let values = params![
        id,
        folder,
        scanned.path,
        scanned.size,
        scanned.mtime,
        scanned.sha256,
        scanned.phash,
        scanned.kind.as_str(),
        scanned.probe.width,
        scanned.probe.height,
        scanned.probe.duration_ms,
        scanned.thumb
    ];
    if existing.is_some() {
        // Keep the previous hash or thumbnail when this pass could not make one.
        connection.execute(
            &format!(
                "UPDATE files SET size_bytes = ?4, mtime = ?5, sha256 = ?6, phash = COALESCE(?7, phash),
                   media_type = ?8, width = ?9, height = ?10, duration_ms = ?11,
                   thumb_path = COALESCE(?12, thumb_path), updated_at = {NOW}
                 WHERE id = ?1 AND folder_id = ?2 AND path = ?3"
            ),
            values,
        )?;
    } else {
        connection.execute(
            &format!(
                "INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, phash, media_type, width, height, duration_ms, thumb_path, created_at, updated_at)
                 VALUES (?1, ?2, 'LOCAL', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, {NOW}, {NOW})"
            ),
            values,
        )?;
    }
    Ok(id)
}

/// Deletes file rows and their read marks; returns thumbnails no remaining row uses.
pub(crate) fn forget_files(connection: &Connection, ids: &[String]) -> Result<Vec<String>> {
    let mut orphans = Vec::new();
    for id in ids {
        let thumb: Option<String> = connection
            .query_row("SELECT thumb_path FROM files WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .flatten();
        connection.execute("DELETE FROM files WHERE id = ?1", [id])?;
        // read_marks has no foreign key: the same table holds remote posts.
        connection.execute(
            "DELETE FROM read_marks WHERE scope = 'file' AND item_key = ?1",
            [id],
        )?;
        if let Some(thumb) = thumb {
            if !thumb_in_use(connection, &thumb)? {
                orphans.push(thumb);
            }
        }
    }
    Ok(orphans)
}

// Byte-identical copies share one thumbnail, named from the content hash.
fn thumb_in_use(connection: &Connection, thumb: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM files WHERE thumb_path = ?1)",
        [thumb],
        |row| row.get(0),
    )?)
}

/// Removes thumbnails by name from `directory` only: a stored path never reaches other files.
pub(crate) async fn remove_thumbnails(directory: &Path, paths: Vec<String>) {
    for stored in paths {
        let Some(name) = Path::new(&stored).file_name() else {
            continue;
        };
        let path = directory.join(name);
        if let Err(error) = tokio::fs::remove_file(&path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Cannot remove thumbnail {}: {error}", path.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_match_the_reference_format() {
        let time = SystemTime::UNIX_EPOCH + Duration::from_micros(1_700_000_000_123_999);
        assert_eq!(iso_millis(time), "2023-11-14T22:13:20.123Z");
    }
}
